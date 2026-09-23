// Reface (face-swap studio) helpers — pure logic + job-dir IO.
// Heavy lifting (detection, clustering pixels, swapping) lives in
// scripts/reface.py (insightface, local CPU); this module stays
// dependency-free so the Node backend and node --test can use it.
//
// Job layout: reface/<id>/{
//   meta.json, source.<ext>, source_thumb.jpg,
//   reference.<ext>, faces.json, embeddings.npz (python-only),
//   thumbs/face<N>.jpg, progress.json, result.mp4, job.log
// }
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** New job id: rf_<base36 time>_<6 hex> (matches res_* style ids). */
export function newRefaceId() {
  return `rf_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
}

export const REFACE_ID_RE = /^rf_[a-z0-9]+_[a-f0-9]{6}$/;

/** Cosine similarity of two equal-length embedding arrays. */
export function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (!(na > 0) || !(nb > 0)) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Greedy identity clustering over face detections.
 * items: [{ embedding: number[] }] — order = detection order (stable ids).
 * A detection joins the cluster whose centroid has the highest cosine
 * similarity, when that similarity >= threshold; otherwise it opens a new
 * cluster. Returns [{ members: [itemIndex...], centroid: number[] }].
 */
export function clusterEmbeddings(items, threshold = 0.45) {
  const clusters = [];
  const t = Number.isFinite(threshold) ? threshold : 0.45;
  (items || []).forEach((item, idx) => {
    const emb = Array.isArray(item?.embedding) ? item.embedding : [];
    let best = -1, bestSim = -Infinity;
    clusters.forEach((c, ci) => {
      const s = cosineSim(emb, c.centroid);
      if (s > bestSim) { bestSim = s; best = ci; }
    });
    if (best >= 0 && bestSim >= t) {
      const c = clusters[best];
      c.members.push(idx);
      // Incremental centroid mean.
      const n = c.members.length;
      c.centroid = c.centroid.map((v, i) => v + (emb[i] - v) / n);
    } else {
      clusters.push({ members: [idx], centroid: [...emb] });
    }
  });
  return clusters;
}

/** Job dir for an id under a reface root (no traversal — id charset only). */
export function refaceJobDir(root, id) {
  if (!REFACE_ID_RE.test(String(id || ""))) throw new Error("bad reface id");
  return path.join(root, String(id));
}

export function readRefaceMeta(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    return m && typeof m === "object" ? m : null;
  } catch { return null; }
}

export function writeRefaceMeta(dir, meta) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

/** Small list-view of a job dir (null when not a job). */
export function refaceSummary(dir) {
  const meta = readRefaceMeta(dir);
  if (!meta || meta.id !== path.basename(dir)) return null;
  let faces = [];
  try {
    const f = JSON.parse(fs.readFileSync(path.join(dir, "faces.json"), "utf8"));
    if (Array.isArray(f)) faces = f;
  } catch { /* not analyzed yet */ }
  return {
    id: meta.id,
    created_at: meta.created_at ?? null,
    filename: meta.filename ?? null,
    duration: meta.duration ?? null,
    status: meta.status ?? "uploaded",
    faces: faces.length,
    hasReference: !!meta.reference,
    hasResult: !!meta.result,
    error: meta.error ?? null,
  };
}

/** Full detail payload for GET /api/reface/:id (faces + progress inline). */
export function refaceDetail(dir) {
  const meta = readRefaceMeta(dir);
  if (!meta) return null;
  let faces = [];
  try {
    const f = JSON.parse(fs.readFileSync(path.join(dir, "faces.json"), "utf8"));
    if (Array.isArray(f)) faces = f;
  } catch { /* not analyzed yet */ }
  let progress = null;
  try {
    progress = JSON.parse(fs.readFileSync(path.join(dir, "progress.json"), "utf8"));
  } catch { /* no progress yet */ }
  return { ...meta, faces, progress };
}
