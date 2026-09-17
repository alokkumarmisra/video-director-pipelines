// Delta-based project versioning helpers (shared by server.mjs + tests).
//
// Model:
//   Version  = logical project revision (scenario_versions.version, mirrored
//              onto project_assets.version).
//   Asset row = ONLY the asset/change generated at that revision.
//   video_type = which cut the row belongs to: 'YOUTUBE' (landscape main cut)
//              or 'INSTAGRAM' (vertical 9:16 Reel cut). Both cuts keep a full
//              per-scene row set; the UNIQUE key carries video_type so the two
//              cuts never collide.
// A new version never duplicates unchanged rows; readers resolve the
// "effective state" at version V as the latest row per (beat_index,
// asset_type, video_type) with version <= V (PostgreSQL DISTINCT ON, see
// EFFECTIVE_ASSETS_SQL below).
//
// Scene numbering: 0 = reference visual, N = beat N (1-based). This matches
// server.mjs (scene_id === beat_index) and the UNIQUE
// (project_id, version, asset_type, beat_index, video_type) constraint,
// which already supports deltas (one row per changed asset per version).

/** Normalize a scenario config for comparison (missing sequence -> []). */
export function normCfg(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  return {
    referencePrompt: c.referencePrompt ?? null,
    sequence: Array.isArray(c.sequence) ? c.sequence : [],
  };
}

const str = (v) => (v == null ? "" : String(v));

/**
 * Diff two scenario configs.
 * Returns { refChanged: boolean, beats: number[] } where beats lists the
 * 1-based beat numbers whose content changed (title/image/motion), plus any
 * newly added beats. Removed beats produce no rows (nothing to insert).
 */
export function diffScenarios(prevCfg, nextCfg) {
  const p = normCfg(prevCfg);
  const n = normCfg(nextCfg);
  const refChanged = str(p.referencePrompt) !== str(n.referencePrompt);
  const beats = [];
  const max = Math.max(p.sequence.length, n.sequence.length);
  for (let i = 0; i < n.sequence.length; i++) {
    const a = p.sequence[i] || {};
    const b = n.sequence[i] || {};
    if (
      str(a.title) !== str(b.title) ||
      str(a.image) !== str(b.image) ||
      str(a.motion) !== str(b.motion)
    ) {
      beats.push(i + 1);
    }
  }
  // Beats beyond next.sequence.length were removed -> no delta rows.
  void max;
  return { refChanged, beats };
}

/**
 * Per-asset-type granularity for one changed beat: which asset rows does a
 * beat-level change require?
 *   image/title change -> KEYFRAME row
 *   motion/title change -> VIDEO row
 * (title feeds beat_title on both rows; file names embed it.)
 */
export function beatAssetTypes(prevBeat = {}, nextBeat = {}) {
  const types = new Set();
  if (str(prevBeat.image) !== str(nextBeat.image)) types.add("KEYFRAME");
  if (str(prevBeat.motion) !== str(nextBeat.motion)) types.add("VIDEO");
  if (str(prevBeat.title) !== str(nextBeat.title)) {
    types.add("KEYFRAME");
    types.add("VIDEO");
  }
  // Added beat (no previous) -> both rows.
  if (!prevBeat || Object.keys(prevBeat).length === 0) {
    types.add("KEYFRAME");
    types.add("VIDEO");
  }
  return [...types];
}

/**
 * Full per-type change plan for a save.
 * Returns { ref: boolean, beats: Record<number, string[]> } e.g.
 * { ref: false, beats: { 3: ["KEYFRAME"] } } for an image-only regen of beat 3.
 */
export function planDelta(prevCfg, nextCfg) {
  const p = normCfg(prevCfg);
  const n = normCfg(nextCfg);
  const ref = str(p.referencePrompt) !== str(n.referencePrompt);
  const beats = {};
  for (let i = 0; i < n.sequence.length; i++) {
    const types = beatAssetTypes(p.sequence[i] || {}, n.sequence[i] || {});
    if (types.length) beats[i + 1] = types;
  }
  return { ref, beats };
}

/** Next version: max existing version + 1 (0 rows -> 1). */
export function nextVersionNumber(existingVersions) {
  const max = (existingVersions || []).reduce(
    (m, v) => (Number.isFinite(Number(v)) ? Math.max(m, Number(v)) : m),
    0
  );
  return max + 1;
}

/**
 * Effective-state resolution over an in-memory row list (mirrors
 * EFFECTIVE_ASSETS_SQL): for the requested version, latest row per
 * (beat_index, asset_type, video_type) with version <= requested. Rows
 * without video_type read as 'YOUTUBE' (pre-column fixtures stay valid).
 */
export function resolveEffective(rows, version) {
  const best = new Map(); // `${beat_index}:${asset_type}:${video_type}` -> row
  for (const r of rows || []) {
    if (Number(r.version) > Number(version)) continue;
    const k = `${r.beat_index}:${r.asset_type}:${r.video_type ?? "YOUTUBE"}`;
    const cur = best.get(k);
    if (
      !cur ||
      Number(r.version) > Number(cur.version) ||
      (Number(r.version) === Number(cur.version) && Number(r.id) > Number(cur.id))
    ) {
      best.set(k, r);
    }
  }
  return [...best.values()].sort(
    (a, b) => a.beat_index - b.beat_index || (a.asset_type < b.asset_type ? -1 : 1)
  );
}

/** Next project version from project_assets rows (spec §3). */
export const NEXT_VERSION_SQL = `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM project_assets WHERE project_id = $1`;

/**
 * Effective assets at a version for one cut: latest applicable row per
 * (beat_index, asset_type) with version <= $2 and video_type = $3
 * ('YOUTUBE' landscape main cut, 'INSTAGRAM' vertical Reel cut). DISTINCT ON
 * requires the leading ORDER BY columns to match the DISTINCT ON list.
 */
export const EFFECTIVE_ASSETS_SQL = `SELECT DISTINCT ON (beat_index, asset_type)
       id, project_id, version, scene_id, beat_index, beat_title,
       asset_type, status, prompt, negative_prompt, file_path,
       model, workflow, seed, attempts, max_retries, error_message,
       metadata, started_at, completed_at, created_at, updated_at,
       video_type
  FROM project_assets
 WHERE project_id = $1
   AND version <= $2
   AND video_type = $3
 ORDER BY beat_index, asset_type, version DESC, id DESC`;

/** Exact rows stored at one version for one cut (delta contents / history). */
export const EXACT_VERSION_SQL = `SELECT id, project_id, version, scene_id, beat_index, beat_title,
       asset_type, status, prompt, negative_prompt, file_path,
       model, workflow, seed, attempts, max_retries, error_message,
       metadata, started_at, completed_at, created_at, updated_at,
       video_type
  FROM project_assets WHERE project_id = $1 AND version = $2 AND video_type = $3
 ORDER BY beat_index, CASE asset_type
   WHEN 'REFERENCE' THEN 0 WHEN 'IMAGE' THEN 1 WHEN 'KEYFRAME' THEN 2
   WHEN 'VIDEO' THEN 3 ELSE 4 END`;
