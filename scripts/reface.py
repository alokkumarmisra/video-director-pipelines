#!/usr/bin/env python3
"""Reface worker — find faces in a video, cluster identities, swap one face.

Job layout (created by the Node backend): reface/<id>/ with meta.json +
source.<ext>. This script adds faces.json, embeddings.npz, thumbs/faceN.jpg
(analyze) and result.mp4 (swap). Progress goes to progress.json so the UI can
poll; human-readable lines go to stdout (captured in job.log).

Usage:
  python scripts/reface.py analyze <jobDir> [--sample-fps 1]
  python scripts/reface.py swap <jobDir> --face <faceId>

Models (local CPU via onnxruntime):
  - buffalo_l FaceAnalysis pack (auto-downloaded to ~/.insightface on first
    use, ~300MB) for detection + recognition embeddings.
  - inswapper_128.onnx for the actual swap. Not redistributable, so it is
    fetched once from INSWAPPER_URL (default: HuggingFace mirror) into
    INSWAPPER_MODEL (default: ~/.insightface/models/inswapper_128.onnx).

Env overrides:
  REFACE_PYTHON_* — none (this IS the python side).
  INSIGHTFACE_HOME — model root (default ~/.insightface).
  INSWAPPER_MODEL / INSWAPPER_URL — swapper model path / download URL.
  REFACE_PROVIDERS — comma list, default "CPUExecutionProvider".
  REFACE_SIM_THRESHOLD — cluster join threshold (default 0.45).
  REFACE_MATCH_THRESHOLD — per-frame target match threshold (default 0.40).
  REFACE_MIN_FACE — min face box area as a fraction of frame (default 0.002;
    filters dust detections, keeps background people out of the panel only
    when they never clear it — the panel shows every surviving cluster).
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

import cv2
import numpy as np

HOME = os.path.expanduser("~")
INSIGHTFACE_HOME = os.environ.get("INSIGHTFACE_HOME", os.path.join(HOME, ".insightface"))
DEFAULT_INSWAPPER = os.path.join(INSIGHTFACE_HOME, "models", "inswapper_128.onnx")
INSWAPPER_MODEL = os.environ.get("INSWAPPER_MODEL", DEFAULT_INSWAPPER)
INSWAPPER_URL = os.environ.get(
    "INSWAPPER_URL",
    "https://huggingface.co/ezioruan/inswapper_128.onnx/resolve/main/inswapper_128.onnx",
)
PROVIDERS = [p.strip() for p in os.environ.get("REFACE_PROVIDERS", "CPUExecutionProvider").split(",") if p.strip()]
SIM_THRESHOLD = float(os.environ.get("REFACE_SIM_THRESHOLD", "0.45"))
MATCH_THRESHOLD = float(os.environ.get("REFACE_MATCH_THRESHOLD", "0.40"))
MIN_FACE_FRAC = float(os.environ.get("REFACE_MIN_FACE", "0.002"))


def log(msg):
    print(msg, flush=True)


def write_progress(job_dir, payload):
    tmp = os.path.join(job_dir, "progress.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, os.path.join(job_dir, "progress.json"))


def run(cmd, timeout=None):
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, check=False)


def probe(path):
    """(duration_sec, fps, width, height, has_audio) via ffprobe."""
    r = run(["ffprobe", "-v", "error", "-show_entries",
             "format=duration:stream=width,height,avg_frame_rate,codec_type",
             "-of", "json", path], timeout=60)
    if r.returncode != 0:
        raise RuntimeError("ffprobe failed: " + r.stderr.decode("utf8", "replace")[:300])
    info = json.loads(r.stdout.decode("utf8"))
    duration = None
    try:
        duration = float(info.get("format", {}).get("duration") or 0) or None
    except (TypeError, ValueError):
        duration = None
    fps, w, h, has_audio = 24.0, 0, 0, False
    for s in info.get("streams", []):
        if s.get("codec_type") == "video" and not w:
            w = int(s.get("width") or 0)
            h = int(s.get("height") or 0)
            fr = str(s.get("avg_frame_rate") or "24/1")
            try:
                if "/" in fr:
                    n, d = fr.split("/", 1)
                    fps = float(n) / float(d) if float(d) else 24.0
                else:
                    fps = float(fr) or 24.0
            except (TypeError, ValueError):
                fps = 24.0
        if s.get("codec_type") == "audio":
            has_audio = True
    return duration, fps, w, h, has_audio


def find_source(job_dir):
    for name in sorted(os.listdir(job_dir)):
        if name.startswith("source.") and os.path.isfile(os.path.join(job_dir, name)):
            return os.path.join(job_dir, name)
    raise RuntimeError("source video missing — re-upload it")


def get_analyzer():
    from insightface.app import FaceAnalysis
    log("[reface] loading buffalo_l (downloads once on first run) ...")
    app = FaceAnalysis(name="buffalo_l", root=INSIGHTFACE_HOME, providers=PROVIDERS)
    app.prepare(ctx_id=0, det_size=(640, 640))
    return app


def ensure_inswapper():
    if os.path.exists(INSWAPPER_MODEL):
        return INSWAPPER_MODEL
    os.makedirs(os.path.dirname(INSWAPPER_MODEL), exist_ok=True)
    tmp = INSWAPPER_MODEL + ".download"
    log("[reface] downloading inswapper_128 model (~500MB, once) ...")
    try:
        req = urllib.request.Request(INSWAPPER_URL, headers={"User-Agent": "reface/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            got = 0
            while True:
                chunk = resp.read(4 * 1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                got += len(chunk)
                if total:
                    log(f"[reface] model {got / 1e6:.0f}/{total / 1e6:.0f} MB")
        os.replace(tmp, INSWAPPER_MODEL)
    except Exception as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise RuntimeError(
            "inswapper model missing and download failed "
            f"({e}). Set INSWAPPER_MODEL to a local inswapper_128.onnx "
            "or INSWAPPER_URL to a reachable mirror, then retry."
        )
    log("[reface] model saved: " + INSWAPPER_MODEL)
    return INSWAPPER_MODEL


def cos(a, b):
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na <= 0 or nb <= 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def cmd_analyze(job_dir, sample_fps):
    source = find_source(job_dir)
    duration, _, _, _, _ = probe(source)
    total = max(1, int(math.ceil((duration or 60) * sample_fps)))
    write_progress(job_dir, {"stage": "analyzing", "pct": 1, "detail": "extracting frames"})

    tmp = tempfile.mkdtemp(prefix="reface_frames_")
    try:
        r = run(["ffmpeg", "-y", "-v", "error", "-i", source,
                 "-vf", f"fps={sample_fps}", os.path.join(tmp, "f_%05d.png")], timeout=600)
        if r.returncode != 0:
            raise RuntimeError("frame extract failed: " + r.stderr.decode("utf8", "replace")[:300])
        frames = sorted(f for f in os.listdir(tmp) if f.endswith(".png"))
        if not frames:
            raise RuntimeError("no frames extracted from source video")

        app = get_analyzer()
        # detections: {embedding, bbox, area, frame, time, crop_path}
        dets = []
        for i, name in enumerate(frames):
            full = os.path.join(tmp, name)
            img = cv2.imread(full)
            if img is None:
                continue
            t = (i / sample_fps)
            h, w = img.shape[:2]
            try:
                faces = app.get(img)
            except Exception as e:
                log(f"[reface] detection skipped on frame {i}: {e}")
                continue
            for f in faces:
                x1, y1, x2, y2 = [int(v) for v in f.bbox]
                area = max(0, x2 - x1) * max(0, y2 - y1)
                if area < MIN_FACE_FRAC * w * h:
                    continue
                dets.append({
                    "embedding": np.asarray(f.normed_embedding, dtype=np.float64),
                    "bbox": (x1, y1, x2, y2), "area": area,
                    "frame": i, "time": round(t, 2),
                    "pixels": img[max(0, y1):y2, max(0, x1):x2].copy(),
                })
            if (i + 1) % 10 == 0 or i + 1 == len(frames):
                write_progress(job_dir, {"stage": "analyzing",
                                         "pct": round(5 + 55 * (i + 1) / len(frames)),
                                         "detail": f"detecting faces ({i + 1}/{len(frames)} frames)"})
        log(f"[reface] {len(dets)} face detections across {len(frames)} sampled frames")

        # Greedy identity clustering (same rule as lib/reface.mjs).
        clusters = []  # {members:[detIdx], centroid}
        for di, d in enumerate(dets):
            best, best_sim = -1, -1.0
            for ci, c in enumerate(clusters):
                s = cos(d["embedding"], c["centroid"])
                if s > best_sim:
                    best, best_sim = ci, s
            if best >= 0 and best_sim >= SIM_THRESHOLD:
                c = clusters[best]
                c["members"].append(di)
                n = len(c["members"])
                c["centroid"] = c["centroid"] + (d["embedding"] - c["centroid"]) / n
            else:
                clusters.append({"members": [di], "centroid": d["embedding"].copy()})

        thumbs = os.path.join(job_dir, "thumbs")
        shutil.rmtree(thumbs, ignore_errors=True)
        os.makedirs(thumbs, exist_ok=True)
        faces = []
        embs = {}
        for ci, c in enumerate(clusters):
            fid = f"face{ci + 1}"
            # Representative = largest crop (clearest look at the identity).
            rep = max(c["members"], key=lambda di: dets[di]["area"])
            crop = dets[rep]["pixels"]
            if crop is None or crop.size == 0:
                continue
            ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
            if not ok:
                continue
            with open(os.path.join(thumbs, fid + ".jpg"), "wb") as f:
                f.write(buf.tobytes())
            times = sorted(dets[di]["time"] for di in c["members"])
            faces.append({"id": fid, "thumb": f"thumbs/{fid}.jpg",
                          "count": len(c["members"]), "firstSeen": times[0]})
            embs[fid] = c["centroid"].astype(np.float32)
            write_progress(job_dir, {"stage": "analyzing",
                                     "pct": round(60 + 35 * (ci + 1) / max(1, len(clusters))),
                                     "detail": f"clustering identity {ci + 1}/{len(clusters)}"})

        with open(os.path.join(job_dir, "faces.json"), "w", encoding="utf-8") as f:
            json.dump(faces, f, indent=2)
        np.savez_compressed(os.path.join(job_dir, "embeddings.npz"), **embs)
        write_progress(job_dir, {"stage": "analyzed", "pct": 100,
                                 "detail": f"{len(faces)} face(s) found"})
        log(f"[reface] analyze done: {len(faces)} identities -> faces.json")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_swap(job_dir, face_id):
    with open(os.path.join(job_dir, "faces.json"), encoding="utf-8") as f:
        faces = json.load(f)
    if not any(x.get("id") == face_id for x in faces):
        raise RuntimeError(f"unknown face {face_id} — analyze first, then pick a face from the panel")
    store = np.load(os.path.join(job_dir, "embeddings.npz"))
    if face_id not in store:
        raise RuntimeError("embeddings missing for {face_id} — re-run analyze".format(face_id=face_id))
    target = np.asarray(store[face_id], dtype=np.float64)

    ref = None
    for name in sorted(os.listdir(job_dir)):
        if name.startswith("reference.") and os.path.isfile(os.path.join(job_dir, name)):
            ref = os.path.join(job_dir, name)
            break
    if not ref:
        raise RuntimeError("reference image missing — upload a reference face first")

    source = find_source(job_dir)
    duration, fps, _, _, has_audio = probe(source)
    fps = fps or 24.0

    app = get_analyzer()
    ref_img = cv2.imread(ref)
    if ref_img is None:
        raise RuntimeError("could not read the reference image")
    ref_faces = app.get(ref_img)
    if not ref_faces:
        raise RuntimeError("no face found in the reference image — use a clear front-facing photo")
    src_face = max(ref_faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    log("[reface] reference face locked (largest face in reference image)")

    from insightface.model_zoo import get_model
    model_path = ensure_inswapper()
    log("[reface] loading inswapper ...")
    swapper = get_model(model_path, providers=PROVIDERS)

    write_progress(job_dir, {"stage": "swapping", "pct": 2, "detail": "extracting frames"})
    tmp = tempfile.mkdtemp(prefix="reface_swap_")
    try:
        r = run(["ffmpeg", "-y", "-v", "error", "-i", source,
                 os.path.join(tmp, "in_%06d.png")], timeout=900)
        if r.returncode != 0:
            raise RuntimeError("frame extract failed: " + r.stderr.decode("utf8", "replace")[:300])
        frames = sorted(f for f in os.listdir(tmp) if f.startswith("in_") and f.endswith(".png"))
        total = len(frames)
        if not total:
            raise RuntimeError("no frames extracted from source video")
        log(f"[reface] swapping {face_id} across {total} frames ...")

        swapped_total = 0
        for i, name in enumerate(frames):
            full = os.path.join(tmp, name)
            img = cv2.imread(full)
            if img is not None:
                try:
                    for f in app.get(img):
                        if cos(np.asarray(f.normed_embedding, dtype=np.float64), target) >= MATCH_THRESHOLD:
                            img = swapper.get(img, f, src_face, paste_back=True)
                            swapped_total += 1
                except Exception as e:
                    log(f"[reface] frame {i} kept original ({e})")
                cv2.imwrite(os.path.join(tmp, f"out_{i:06d}.png"), img)
            if (i + 1) % 25 == 0 or i + 1 == total:
                write_progress(job_dir, {"stage": "swapping",
                                         "pct": round(5 + 85 * (i + 1) / total),
                                         "detail": f"swapping frame {i + 1}/{total}",
                                         "frame": i + 1, "total": total})
        log(f"[reface] swapped {swapped_total} face instances")

        result = os.path.join(job_dir, "result.mp4")
        tmp_result = os.path.join(tmp, "result.mp4")
        mux = ["ffmpeg", "-y", "-v", "error", "-framerate", f"{fps:.3f}",
               "-i", os.path.join(tmp, "out_%06d.png")]
        if has_audio:
            mux += ["-i", source, "-map", "0:v", "-map", "1:a?", "-c:a", "aac",
                    "-shortest"]
        mux += ["-c:v", "libx264", "-pix_fmt", "yuv420p", tmp_result]
        write_progress(job_dir, {"stage": "swapping", "pct": 96, "detail": "encoding result video"})
        r = run(mux, timeout=1800)
        if r.returncode != 0:
            raise RuntimeError("encode failed: " + r.stderr.decode("utf8", "replace")[:300])
        os.replace(tmp_result, result)
        write_progress(job_dir, {"stage": "done", "pct": 100,
                                 "detail": "result.mp4 ready", "result": "result.mp4"})
        log("[reface] swap done -> result.mp4")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv):
    ap = argparse.ArgumentParser(description="Reface worker: analyze faces / swap a face in a video")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("analyze", help="detect + cluster faces in the job source video")
    a.add_argument("jobDir")
    a.add_argument("--sample-fps", type=float, default=1.0)
    s = sub.add_parser("swap", help="replace one clustered face with the reference face")
    s.add_argument("jobDir")
    s.add_argument("--face", required=True)
    args = ap.parse_args(argv)

    job_dir = os.path.abspath(args.jobDir)
    if not os.path.isdir(job_dir):
        print(f"no such job dir: {job_dir}", file=sys.stderr)
        return 2
    try:
        if args.cmd == "analyze":
            cmd_analyze(job_dir, max(0.25, min(4.0, args.sample_fps)))
        else:
            cmd_swap(job_dir, args.face)
    except Exception as e:
        try:
            write_progress(job_dir, {"stage": "error", "pct": 0, "detail": str(e)[:300]})
        except OSError:
            pass
        print(f"[reface] FAILED: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
