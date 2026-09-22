// Easy-Wav2Lip bridge — lip-syncs a generated clip to its dialogue audio.
//
// The user's local install (D:\AI\Alok\Easy-Wav2Lip-8.3, venv python 3.10,
// CUDA) is driven headless through its CLI:
//
//   <venv>\Scripts\python.exe run.py -video_file <mp4> -vocal_file <wav>
//
// run.py reads config.ini from its own folder (padding/mask size stay
// exactly as the user set them in the GUI — we only override the input
// paths, batch_process and the output suffix, then restore the file).
// Three output-hygiene keys are FORCED per run regardless of the GUI:
// quality -> Improved (kept when Enhanced) so only the mouth region blends
// (Fast pastes the whole face box as a visible square), debug_mask -> False
// (no mask overlay baked into the pixels), preview_settings -> False.
// The face-tracking cache (last_detected_face.pkl / last_file.txt) is
// DELETED per run: inference.py otherwise reuses the first run's face boxes
// for every later input (our staged temp path never changes), pasting a
// stale box — wrong character, wrong place — onto regenerated clips.
//
// Duration rule (the user's core ask): the video must fit the dialogue.
// Wav2Lip trims a LONGER video down to the audio automatically, but a
// SHORTER video is looped first with ffmpeg (stream-copy concat, so codec /
// resolution / fps never change and the final `-c copy` stitch stays safe).
//
// The synced result is stored as a NEW version of the beat's CLIP
// (`<prefix>_clip<n>_<slug>[_vN].mp4`) and selected as the clip main —
// stitching, the gallery and the DB keep working unchanged, and the
// pre-sync take stays selectable.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileSlug } from "./variant.mjs";
import { loadState, nextVersion, setMain, resolveMain } from "./sequence_state.mjs";

const DEFAULT_EASY_DIR = process.env.EASY_WAV2LIP_DIR ||
  "D:\\AI\\Alok\\Easy-Wav2Lip-8.3\\Easy-Wav2Lip-8.3";
const DEFAULT_VENV_PYTHON = process.env.EASY_WAV2LIP_PYTHON ||
  "D:\\AI\\Alok\\Easy-Wav2Lip-8.3\\Easy-Wav2Lip-venv\\Scripts\\python.exe";

export function easyPaths() {
  const easyDir = process.env.EASY_WAV2LIP_DIR || DEFAULT_EASY_DIR;
  const venvPython = process.env.EASY_WAV2LIP_PYTHON || DEFAULT_VENV_PYTHON;
  if (!fs.existsSync(path.join(easyDir, "run.py"))) {
    throw new Error(`Easy-Wav2Lip not found at ${easyDir} (set EASY_WAV2LIP_DIR)`);
  }
  if (!fs.existsSync(venvPython)) {
    throw new Error(`Easy-Wav2Lip python not found at ${venvPython} (set EASY_WAV2LIP_PYTHON)`);
  }
  return { easyDir, venvPython };
}

function probeDuration(file) {
  try {
    const out = execFileSync("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" }).trim();
    const d = Number(out);
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch { return 0; }
}

/** Probe video/audio stream params (concat-compat check + normalize target). */
export function probeClipSpec(file) {
  try {
    const out = execFileSync("ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", file],
      { encoding: "utf8" });
    const j = JSON.parse(out);
    const v = (j.streams || []).find((s) => s.codec_type === "video") || {};
    const a = (j.streams || []).find((s) => s.codec_type === "audio") || null;
    let fps = 24;
    const fr = String(v.avg_frame_rate || v.r_frame_rate || "24/1");
    const m = fr.match(/^([\d.]+)\/([\d.]+)$/);
    if (m && Number(m[2])) fps = Number(m[1]) / Number(m[2]);
    else if (Number(fr)) fps = Number(fr);
    return {
      width: Number(v.width) || 0, height: Number(v.height) || 0,
      fps: Number.isFinite(fps) && fps > 0 ? fps : 24,
      pixFmt: v.pix_fmt || "", vcodec: v.codec_name || "",
      hasAudio: !!a, sampleRate: a ? Number(a.sample_rate) || 0 : 0,
      channels: a ? Number(a.channels) || 0 : 0, acodec: a ? (a.codec_name || "") : "",
    };
  } catch { return null; }
}

/**
 * Normalize a freshly synced/dubbed take to the project's concat spec
 * (the pre-sync clip's width/height/fps + AAC 48kHz stereo).
 *
 * Why: Easy-Wav2Lip's final ffmpeg mux (`-c:v libx264` with no pix_fmt/fps
 * and the raw 16kHz mono TTS wav passed through as-is) emits takes whose
 * audio (and sometimes video) params differ from the sibling LTX/Wan clips.
 * The final cut is stitched with `ffmpeg concat -c copy`, which requires
 * IDENTICAL codec/resolution/fps/audio params across segments — a mismatched
 * take plays fine on its own (download works) but corrupts the stitched
 * final cut exactly at its boundary. Normalizing every new take keeps the
 * `-c copy` stitch safe.
 *
 * Fast path: takes that already match are copied verbatim (no quality loss);
 * only mismatched takes are re-encoded.
 */
export function normalizeClipToSpec(srcPath, destPath, spec) {
  const s = probeClipSpec(srcPath);
  const vOK = !!(s && spec && spec.width && s.width === spec.width &&
    s.height === spec.height && Math.abs(s.fps - spec.fps) < 0.02 &&
    s.pixFmt === "yuv420p" && s.vcodec === "h264");
  const aOK = !!(s && s.hasAudio && s.sampleRate === 48000 &&
    s.channels === 2 && s.acodec === "aac");
  if (vOK && aOK) {
    if (srcPath !== destPath) fs.copyFileSync(srcPath, destPath);
    return destPath;
  }
  if (vOK) {
    // Video already matches — re-encode audio only (voice wav is 16kHz mono).
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", srcPath,
      "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", destPath]);
    return destPath;
  }
  const vf = (spec && spec.width && spec.height)
    ? `scale=${spec.width}:${spec.height},fps=${spec.fps || 24}`
    : "fps=24";
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", srcPath,
    "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", destPath]);
  return destPath;
}

// Minimum face size (fraction of frame area) for lip-sync. Faces smaller
// than this are background extras, not a speakable close-up — syncing them
// pastes a blurry upscaled 96x96 prediction square onto the scene.
export const MIN_FACE_FRACTION = Number(process.env.DIALOGUE_MIN_FACE_FRACTION ?? 0.02);
// Minimum IoU between the dominant face boxes of consecutive sampled frames.
// Wav2Lip syncs exactly one box per frame (the top detection, carried forward
// when a frame has none) — jumping boxes mean jumping pasted squares.
export const FACE_STABILITY_IOU = Number(process.env.DIALOGUE_FACE_IOU ?? 0.35);

function boxIoU(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const aa = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const bb = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  return inter / Math.max(1, aa + bb - inter);
}

// Wav2Lip's RetinaFace detector only fires on clear (near-frontal) faces —
// cartoon side-profiles fail. Pre-check sampled frames in seconds instead of
// discovering it after a minutes-long inference run.
//
// A bare "any face anywhere" check is NOT enough: on wide group shots the
// detector fires on different tiny background characters per frame (or on no
// frame at all), and Wav2Lip then pastes a blurry mismatched face square
// onto the scene. So this requires a STABLE, DOMINANT face instead:
// every sampled frame must show a face, the largest box must cover at least
// MIN_FACE_FRACTION of the frame, and consecutive largest boxes must overlap
// (FACE_STABILITY_IOU) — i.e. one clear speaker, not jumping extras.
// Anything else returns false and the caller dubs (voice muxed, characters
// untouched) instead of lip-syncing.
export function facesDetected(clipPath, easyDir, venvPython) {
  const { easyDir: ed, venvPython: vp } = easyDir && venvPython
    ? { easyDir, venvPython } : easyPaths();
  const dur = probeDuration(clipPath);
  const end = Number.isFinite(dur) && dur > 0 ? dur : 3;
  const times = [0.5, 1.5, 2.5, 3.5, 4.5].filter((t) => t < Math.max(end - 0.15, 0.25));
  if (!times.length) times.push(Math.max(0.2, end / 2));
  const frames = [];
  for (let i = 0; i < times.length; i++) {
    const f = path.join(path.dirname(clipPath), `.facecheck_${i}.png`);
    try {
      execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(times[i]),
        "-i", clipPath, "-frames:v", "1", f]);
      frames.push(f);
    } catch { /* unusable sample — skip it */ }
  }
  const cleanup = () => {
    for (const f of frames) { try { fs.unlinkSync(f); } catch { /* keep going */ } }
  };
  if (frames.length < 2) { cleanup(); return false; }
  const py = [
    "import sys, json; sys.path.insert(0, '.')",
    "import cv2",
    "from batch_face import RetinaFace",
    `det = RetinaFace(gpu_id=0, model_path='checkpoints/mobilenet.pth', network='mobilenet')`,
    `imgs = ${JSON.stringify(frames.map((f) => f.replace(/\\/g, "/")))}`,
    "out = []",
    "for f in imgs:",
    "    try:",
    "        img = cv2.imread(f)",
    "        h, w = img.shape[:2]",
    "        boxes = [[int(v) for v in d[0]] for d in (det(img) or [])]",
    "        out.append({'w': w, 'h': h, 'boxes': boxes})",
    "    except Exception as e:",
    "        out.append({'w': 0, 'h': 0, 'boxes': [], 'error': str(e)[:80]})",
    "print('BOXES:' + json.dumps(out))",
  ].join("\n");
  try {
    const r = spawnSync(vp, ["-c", py], { cwd: ed, encoding: "utf8", timeout: 180000 });
    const m = String(r.stdout || "").match(/BOXES:(.*)/);
    if (!m) return false;
    const info = JSON.parse(m[1]);
    const minFrac = Number.isFinite(MIN_FACE_FRACTION) && MIN_FACE_FRACTION > 0 ? MIN_FACE_FRACTION : 0.02;
    const minIoU = Number.isFinite(FACE_STABILITY_IOU) && FACE_STABILITY_IOU >= 0 ? FACE_STABILITY_IOU : 0.35;
    // Every sampled frame must show a face (a missing face mid-clip means
    // Wav2Lip would freeze-carry a stale box onto those frames).
    const withFace = info.filter((fr) => Array.isArray(fr.boxes) && fr.boxes.length > 0);
    if (withFace.length < Math.ceil(info.length * 0.8)) {
      console.log(`[lipsync] face check: only ${withFace.length}/${info.length} sampled frames show a face — dubbing instead of lip-sync`);
      return false;
    }
    const largest = withFace.map((fr) => {
      const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
      const box = fr.boxes.slice().sort((x, y) => area(y) - area(x))[0];
      return { box, frac: area(box) / Math.max(1, (fr.w || 0) * (fr.h || 0)) };
    });
    // The dominant face must be big enough to sync (not a background extra).
    if (largest.some((l) => l.frac < minFrac)) {
      const min = Math.min(...largest.map((l) => l.frac));
      console.log(`[lipsync] face check: largest face covers only ${(min * 100).toFixed(1)}% of frame (< ${(minFrac * 100).toFixed(1)}%) — dubbing instead of lip-sync`);
      return false;
    }
    // ...and stable across frames (same speaker, same place).
    for (let i = 1; i < largest.length; i++) {
      if (boxIoU(largest[i - 1].box, largest[i].box) < minIoU) {
        console.log(`[lipsync] face check: face jumps between characters/positions (IoU ${boxIoU(largest[i - 1].box, largest[i].box).toFixed(2)} < ${minIoU}) — dubbing instead of lip-sync`);
        return false;
      }
    }
    return true;
  } catch { return false; }
  finally { cleanup(); }
}

/** Mux dialogue audio onto a clip (looped to fit) — the dubbed fallback
 *  when no face is detectable for true lip-sync. Stored as a new clip
 *  version + clip main, same as the synced path. */
function dubBeat({ outDir, prefix, n, title, clipFile, wavFile, tag }) {
  const clipPath = path.join(outDir, clipFile);
  const wavPath = path.join(outDir, wavFile);
  const audioDur = probeDuration(wavPath);
  const target = audioDur + 0.25;
  const work = path.join(outDir, `lip_tmp_${n}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const cover = path.join(work, "cover.mp4");
  loopToCover(clipPath, target, cover);
  // loopToCover returns clipPath untouched when it already covers the target
  // (no cover file written) — don't probe a file that was never created
  // (ffprobe prints a noisy "No such file" to the console otherwise).
  const src = (fs.existsSync(cover) && probeDuration(cover) >= target) ? cover : clipPath;
  const v = nextVersion(outDir, prefix, "clip", n, ".mp4", title);
  const dest = path.join(outDir, v === 1
    ? `${prefix}_clip${n}_${fileSlug(title)}.mp4`
    : `${prefix}_clip${n}_${fileSlug(title)}_v${v}.mp4`);
  // Re-encode (audio must be muxed in; video kept visually identical) and
  // normalize to the pre-sync clip's concat spec (AAC 48kHz stereo — the TTS
  // wav is 16kHz mono, which would corrupt the `-c copy` final-cut stitch at
  // this beat's boundary while playing fine standalone).
  const spec = probeClipSpec(clipPath);
  const tmpDub = dest + ".dub_tmp.mp4";
  const vf = (spec && spec.width && spec.height)
    ? ["-vf", `scale=${spec.width}:${spec.height},fps=${spec.fps || 24}`] : [];
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-i", wavPath,
    "-map", "0:v", "-map", "1:a", ...vf, "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", tmpDub]);
  fs.renameSync(tmpDub, dest);
  fs.rmSync(work, { recursive: true, force: true });
  const mainFile = path.basename(dest);
  setMain(outDir, prefix, "clip", n, title, mainFile, { pinned: false });
  console.log(`${tag} beat ${n} dubbed (voice muxed, no lip-sync) -> ${mainFile}`);
  console.log(`[asset] ${JSON.stringify({ kind: "video", file: mainFile, stage: "clip", index: n, dubbed: true })}`);
  return mainFile;
}

/** Loop a clip (stream-copy) until it covers `target` seconds. */
function loopToCover(clipPath, target, destPath) {
  const dur = probeDuration(clipPath);
  if (dur >= target) return clipPath; // Wav2Lip trims the excess itself
  const reps = Math.max(2, Math.ceil(target / Math.max(dur, 0.1)) + 1);
  const list = destPath + ".list.txt";
  fs.writeFileSync(list,
    Array(reps).fill(`file '${clipPath.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
    "-i", list, "-t", String(target), "-c", "copy", destPath]);
  try { fs.unlinkSync(list); } catch { /* keep going */ }
  return destPath;
}

// Easy-Wav2Lip caches face detection across runs: inference.py reuses
// last_detected_face.pkl whenever last_file.txt matches the temp input path
// (run.py only invalidates when the path changes or
// use_previous_tracking_data=False). Our bridge always stages the input as
// the SAME temp path (<outDir>/lip_tmp_N/lipwork.mp4 -> <easyDir>/temp/…),
// so without clearing, every run pastes the FIRST run's face boxes — wrong
// position/size/content on any new pixels (a giant mismatched "square face"
// on regenerated or different-framing clips). Force fresh detection per run.
// These are pure tracking caches (regenerated by inference.py); safe to drop.
function clearFaceCache(easyDir) {
  for (const f of ["last_detected_face.pkl", "last_file.txt"]) {
    try {
      const p = path.join(easyDir, f);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        console.log(`[lipsync] cleared Easy-Wav2Lip face cache: ${f} (fresh detection on this input)`);
      }
    } catch { /* keep going */ }
  }
}

function patchConfig(easyDir, videoFile, vocalFile, suffix) {
  const iniPath = path.join(easyDir, "config.ini");
  const backup = fs.readFileSync(iniPath, "utf8");
  const forced = { quality: null, debug: false, preview: false };
  const lines = backup.split("\n").map((ln) => {
    if (/^\s*video_file\s*=/.test(ln)) return `video_file = ${videoFile}`;
    if (/^\s*vocal_file\s*=/.test(ln)) return `vocal_file = ${vocalFile}`;
    if (/^\s*batch_process\s*=/.test(ln)) return `batch_process = False`;
    if (/^\s*output_suffix\s*=/.test(ln)) return `output_suffix = ${suffix}`;
    if (/^\s*include_settings_in_suffix\s*=/.test(ln)) return `include_settings_in_suffix = False`;
    if (/^\s*preview_settings\s*=/.test(ln)) { forced.preview = true; return `preview_settings = False`; }
    // Mouth-only blend, never the square face-box: quality "Fast" pastes the
    // whole 96x96 Wav2Lip face box as a visible square (f[y1:y2,x1:x2] = p);
    // "Improved" (and "Enhanced") blend only the mouth region via create_mask.
    // Force it per-run — the GUI setting must not leak squares into the
    // final cut or the downloaded take.
    if (/^\s*quality\s*=/.test(ln)) {
      const cur = (ln.split("=").slice(1).join("=").trim() || "").toLowerCase();
      const next = cur === "enhanced" ? "Enhanced" : "Improved";
      if (cur !== next.toLowerCase()) forced.quality = next;
      return `quality = ${next}`;
    }
    // debug_mask renders the mask as a grayscale overlay — never in output.
    if (/^\s*debug_mask\s*=/.test(ln)) {
      if (!/^\s*debug_mask\s*=\s*false/i.test(ln)) forced.debug = true;
      return `debug_mask = False`;
    }
    return ln;
  });
  fs.writeFileSync(iniPath, lines.join("\n"));
  const bits = [
    forced.quality ? `quality->${forced.quality}` : null,
    forced.debug ? "debug_mask->False" : null,
    forced.preview ? "preview_settings->False" : null,
  ].filter(Boolean).join(", ");
  if (bits) console.log(`[lipsync] Easy-Wav2Lip forced for clean output: ${bits} (mouth-only blend, no mask overlay)`);
  return () => { try { fs.writeFileSync(iniPath, backup); } catch { /* keep going */ } };
}

/**
 * Lip-sync one beat's clip to its dialogue wav.
 * @returns the new clip version filename (also set as clip main).
 */
export function lipSyncBeat({
  outDir, prefix, n, title, clipFile, wavFile,
  easyDir, venvPython, suffix = "_lipsynced", tag = "[lipsync]",
}) {
  const { easyDir: ed, venvPython: vp } = easyDir && venvPython
    ? { easyDir, venvPython } : easyPaths();
  const clipPath = path.join(outDir, clipFile);
  const wavPath = path.join(outDir, wavFile);
  if (!fs.existsSync(clipPath)) throw new Error(`lip-sync: clip missing: ${clipFile}`);
  if (!fs.existsSync(wavPath)) throw new Error(`lip-sync: dialogue audio missing: ${wavFile}`);

  const audioDur = probeDuration(wavPath);
  if (!audioDur) throw new Error(`lip-sync: could not probe audio length: ${wavFile}`);
  const target = audioDur + 0.25; // small tail so the last phoneme isn't cut

  // No detectable face (side-profile / wide cartoon shot)? Skip the
  // minutes-long Wav2Lip run and mux the voice instead — the beat still
  // speaks with the right voice and length, just without mouth movement.
  // Dialogue scenes authored as frontal close-ups (the Director default)
  // DO pass this check and get true lip-sync below.
  if (!facesDetected(clipPath, ed, vp)) {
    console.log(`${tag} beat ${n} (${title}): no clear face in clip — dubbing voice instead of lip-sync`);
    return dubBeat({ outDir, prefix, n, title, clipFile, wavFile, tag });
  }

  const work = path.join(outDir, `lip_tmp_${n}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  // Same basename (sans ext) for video+audio -> deterministic output name.
  const srcMp4 = path.join(work, "lipwork.mp4");
  const looped = loopToCover(clipPath, target, path.join(work, "looped.mp4"));
  fs.copyFileSync(looped, srcMp4);
  fs.copyFileSync(wavPath, path.join(work, "lipwork.wav"));

  console.log(`${tag} beat ${n} (${title}): clip+${audioDur.toFixed(1)}s dialogue -> Wav2Lip...`);
  clearFaceCache(ed);
  const restore = patchConfig(ed, srcMp4, path.join(work, "lipwork.wav"), suffix);
  try {
    const r = spawnSync(vp, ["run.py"], { cwd: ed, encoding: "utf8", timeout: 30 * 60 * 1000 });
    const tail = ((r.stdout || "") + "\n" + (r.stderr || "")).slice(-1500);
    const expected = path.join(work, `lipwork${suffix}.mp4`);
    if (r.status !== 0 || !fs.existsSync(expected)) {
      // Face lost mid-clip or another inference failure — dub instead of
      // failing the run. The voice and timing are still correct.
      console.log(`${tag} beat ${n}: Wav2Lip failed (${(tail.match(/Face not detected|Error[^\n]*/g) || ["unknown error"]).slice(-2).join(" | ").slice(0, 200)}) — dubbing voice instead`);
      restore();
      fs.rmSync(work, { recursive: true, force: true });
      return dubBeat({ outDir, prefix, n, title, clipFile, wavFile, tag });
    }
    // Mint as a new clip version + select as main (same convention as regens).
    // The Wav2Lip mux is normalized to the pre-sync clip's concat spec first
    // (see normalizeClipToSpec) so the `-c copy` final-cut stitch stays safe.
    const spec = probeClipSpec(clipPath);
    const v = nextVersion(outDir, prefix, "clip", n, ".mp4", title);
    const dest = path.join(outDir, v === 1
      ? `${prefix}_clip${n}_${fileSlug(title)}.mp4`
      : `${prefix}_clip${n}_${fileSlug(title)}_v${v}.mp4`);
    normalizeClipToSpec(expected, dest, spec);
    const mainFile = path.basename(dest);
    setMain(outDir, prefix, "clip", n, title, mainFile, { pinned: false });
    // Sanity: the main must resolve to what we just wrote.
    const resolved = path.basename(resolveMain(outDir, prefix, "clip", n, ".mp4", title, loadState(outDir)));
    console.log(`${tag} beat ${n} lip-synced -> ${mainFile} (main: ${resolved})`);
    console.log(`[asset] ${JSON.stringify({ kind: "video", file: mainFile, stage: "clip", index: n, lipsynced: true })}`);
    return mainFile;
  } finally {
    restore();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
