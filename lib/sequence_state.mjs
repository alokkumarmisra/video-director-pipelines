// Versioned asset management for character-sequence outputs.
//
// Every generated asset keeps all its versions on disk:
//   v1 (first generation)  -> <prefix>_ref.png / <prefix>_seq1_<title>.png / <prefix>_clip1_<title>.mp4
//   vN (regenerations)     -> same base name + "_vN" before the extension
//
// The "main" version of each asset (the one stitched into the final cut, and
// the keyframe a clip is generated from) is stored in <outDir>/state.json:
//   { "ref": "<file>", "beats": { "1": { "keyframe": "<file>", "clip": "<file>" } } }
// A main is either user-PINNED (manual pick / upload — survives reloads and
// keeps winning until a regen) or AUTO (pipeline selection — always resolves
// to the latest version on disk, so reloads and regens select the newest).
// Pins live in state.json alongside the mains:
//   { ..., "pinned": { "ref": true, "beats": { "1": { "keyframe": false } } } }
// Entries without a pin record count as AUTO (this also heals pre-pin states
// whose stale picks would otherwise shadow newer versions forever).
//
// Used by scripts/character_sequence{,_wan}.mjs and frontend/server.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileSlug } from "./variant.mjs";

export const stateFile = (outDir) => path.join(outDir, "state.json");

/**
 * Crash-safe file write (tmp + rename). Stop (SIGTERM) can land at any
 * moment — a direct writeFileSync to the final path would leave a truncated
 * file behind. For downloads that means a partial asset versionsOf() counts
 * as finished (resume skips a corrupt file forever); for state.json it means
 * loadState() loses every refFrom record and the next full run treats all
 * keyframes as stale and regenerates from scene 1. The tmp name carries the
 * pid so concurrent runs never share it; stale tmps from killed runs are
 * swept (they never match the version filename patterns anyway).
 */
export function atomicWriteFileSync(dest, data) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dest);
  try {
    for (const f of fs.readdirSync(path.dirname(dest))) {
      if (f.startsWith(`${path.basename(dest)}.part-`) && f !== path.basename(tmp)) {
        try { fs.unlinkSync(path.join(path.dirname(dest), f)); } catch { /* ignore */ }
      }
    }
  } catch { /* best effort */ }
}

export function loadState(outDir) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(outDir), "utf8"));
    return { ref: null, beats: {}, ...s };
  } catch {
    return { ref: null, beats: {} };
  }
}

export function saveState(outDir, state) {
  fs.mkdirSync(outDir, { recursive: true });
  atomicWriteFileSync(stateFile(outDir), JSON.stringify(state, null, 2));
}

// kind: "ref" | "seq" | "clip"
// Beat titles are slugified (no spaces) so every filename and DB path is
// space-free. versionMap/resolveMain callers keep passing the RAW title —
// versionsOf() below matches both the slug and the legacy raw base, so
// assets generated before slugification stay visible and resumable.
export function baseName(prefix, kind, index, title) {
  return kind === "ref" ? `${prefix}_ref` : `${prefix}_${kind}${index}_${fileSlug(title)}`;
}

const VERSION_RE = /_v(\d+)$/;

/**
 * All versions of one asset, sorted by version (v1 first).
 * Returns [{ file, v }].
 */
export function versionsOf(outDir, prefix, kind, index, ext, title) {
  const dir = outDir;
  if (!fs.existsSync(dir)) return [];
  const base = baseName(prefix, kind, index, title);
  // Legacy base (raw title, may contain spaces) — matches assets generated
  // before title slugification so they stay visible/resumable after upgrade.
  const rawBase = (kind === "ref" || title == null) ? null
    : (kind === "ref" ? `${prefix}_ref` : `${prefix}_${kind}${index}_${title}`);
  const bases = rawBase && rawBase !== base ? [base, rawBase] : [base];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(ext)) continue;
    const stem = f.slice(0, -ext.length);
    for (const b of bases) {
      if (stem === b) { out.push({ file: f, v: 1 }); break; }
      const m = stem.match(new RegExp(`^${escapeRe(b)}_v(\\d+)$`));
      if (m) { out.push({ file: f, v: Number(m[1]) }); break; }
    }
  }
  return out.sort((a, b) => a.v - b.v || (a.file < b.file ? -1 : 1));
}

/**
 * Resolve the file to use as "main" for an asset:
 * pinned state selection (if it still exists) -> latest version -> null.
 * AUTO (unpinned) mains always resolve to the newest version on disk, so a
 * reload or a regen selects the latest even when an older pick is recorded.
 */
export function resolveMain(outDir, prefix, kind, index, ext, title, state) {
  const versions = versionsOf(outDir, prefix, kind, index, ext, title);
  if (!versions.length) return null;
  if (isPinnedState(state, kind, index)) {
    const sel = kind === "ref" ? state.ref : state.beats?.[String(index)]?.[kind === "seq" ? "keyframe" : "clip"];
    const pick = versions.find((x) => x.file === sel);
    if (pick) return pick.file;
  }
  return versions[versions.length - 1].file;
}

/**
 * Set the main version for an asset (must be an existing file).
 * opts.pinned=true marks a deliberate user choice (manual pick / upload)
 * that keeps winning on reloads; the pipeline default (false) records an
 * AUTO main that always resolves to the latest version.
 */
export function setMain(outDir, prefix, kind, index, title, file, opts = {}) {
  const pinned = !!opts.pinned;
  const state = loadState(outDir);
  if (kind === "ref") {
    state.ref = file;
    state.pinned = { ...(state.pinned || {}), ref: pinned };
  } else {
    const key = kind === "seq" || kind === "keyframe" ? "keyframe" : "clip";
    state.beats[String(index)] = { ...(state.beats[String(index)] || {}), [key]: file };
    const beats = state.pinned?.beats || {};
    state.pinned = {
      ...(state.pinned || {}),
      beats: { ...beats, [String(index)]: { ...(beats[String(index)] || {}), [key]: pinned } },
    };
  }
  saveState(outDir, state);
  return state;
}

/** True when the recorded main is a user pin (manual pick / upload). */
export function isPinnedState(state, kind, index) {
  if (kind === "ref") return !!(state.pinned && state.pinned.ref);
  const key = kind === "seq" || kind === "keyframe" ? "keyframe" : "clip";
  return !!(state.pinned && state.pinned.beats && state.pinned.beats[String(index)] && state.pinned.beats[String(index)][key]);
}

/**
 * Which reference file a keyframe beat was built from (the main ref at
 * generation time, see lib/sequence.mjs). Null = pure text-to-image (no ref
 * existed yet). Used to detect stale keyframes after the ref main is
 * switched — the next full run regenerates them from the new main instead
 * of skipping them as "already generated".
 */
export function getKeyframeRefFrom(outDir, index) {
  const state = loadState(outDir);
  return state.beats?.[String(index)]?.refFrom ?? null;
}

/** Record which reference file beat `index` was built from. */
export function setKeyframeRefFrom(outDir, index, refFile) {
  const state = loadState(outDir);
  state.beats[String(index)] = { ...(state.beats[String(index)] || {}), refFrom: refFile ?? null };
  saveState(outDir, state);
  return state;
}

/** Next free version number for a new file (1 if none exist yet). */
export function nextVersion(outDir, prefix, kind, index, ext, title) {
  const versions = versionsOf(outDir, prefix, kind, index, ext, title);
  return versions.length ? versions[versions.length - 1].v + 1 : 1;
}

/**
 * Full version map for one scenario output dir (served by the frontend).
 * Returns { ref: [v], beats: { "1": { keyframe: [v], clip: [v] } }, mains: {...} }.
 * Pin flags (refPinned / keyframePinned / clipPinned) tell the gallery whether
 * the main is a user pin or the auto latest, so the UI can say which.
 */
export function versionMap(outDir, prefix, seq) {
  const state = loadState(outDir);
  const refVersions = versionsOf(outDir, prefix, "ref", 0, ".png");
  const beats = {};
  seq.forEach((s, i) => {
    const n = i + 1;
    const kf = versionsOf(outDir, prefix, "seq", n, ".png", s.title);
    const clip = versionsOf(outDir, prefix, "clip", n, ".mp4", s.title);
    beats[String(n)] = {
      keyframe: kf,
      clip,
      keyframeMain: resolveMain(outDir, prefix, "seq", n, ".png", s.title, state),
      clipMain: resolveMain(outDir, prefix, "clip", n, ".mp4", s.title, state),
      keyframePinned: isPinnedState(state, "seq", n),
      clipPinned: isPinnedState(state, "clip", n),
    };
  });
  return {
    ref: refVersions,
    refMain: resolveMain(outDir, prefix, "ref", 0, ".png", null, state),
    refPinned: isPinnedState(state, "ref", 0),
    beats,
    final: finalVersionsOf(outDir, prefix),
    finalMain: resolveFinal(outDir, prefix),
  };
}

/**
 * All versions of the stitched final cut, sorted by version (v1 first).
 * v1 is `<prefix>_final.mp4`, vN is `<prefix>_final_vN.mp4`.
 * Every stitch writes a NEW version and never overwrites old ones.
 * Returns [{ file, v }].
 */
export function finalVersionsOf(outDir, prefix) {
  if (!fs.existsSync(outDir)) return [];
  const base = `${prefix}_final`;
  const ext = ".mp4";
  const out = [];
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith(ext)) continue;
    if (f === base + ext) {
      out.push({ file: f, v: 1 });
      continue;
    }
    const m = f.slice(0, -ext.length).match(new RegExp(`^${escapeRe(base)}_v(\\d+)$`));
    if (m) out.push({ file: f, v: Number(m[1]) });
  }
  return out.sort((a, b) => a.v - b.v);
}

/** Next free version number for the final cut (1 if none exists yet). */
export function nextFinalVersion(outDir, prefix) {
  const versions = finalVersionsOf(outDir, prefix);
  return versions.length ? versions[versions.length - 1].v + 1 : 1;
}

/** Latest final-cut file (the one the gallery plays), or null. */
export function resolveFinal(outDir, prefix) {
  const versions = finalVersionsOf(outDir, prefix);
  return versions.length ? versions[versions.length - 1].file : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
