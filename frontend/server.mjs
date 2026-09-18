// Backend for the character-sequence frontend. Zero deps, Node >= 18.
// Serves the built React app (dist/) + a small JSON API that drives
// scripts/character_sequence.mjs. Run: node server.mjs  (PORT env, default 8790)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { versionMap, setMain, nextVersion } from "../lib/sequence_state.mjs";
import {
  normalizeFormat, outDirName, cfgNameForDir, prefixForDir, engineForDir,
  allDirsFor, folderSlug, fileSlug,
} from "../lib/variant.mjs";
import {
  planDelta,
  latestVersionOf,
  resolveEffective,
  EFFECTIVE_ASSETS_SQL,
  EXACT_VERSION_SQL,
} from "../lib/project_versioning.mjs";
import {
  GetAvailablePresets,
  GetPresetById,
  GetPresetContent,
  resolvePresetId,
} from "../lib/presets.mjs";
import { applyMasterToBeats } from "../lib/master_prompt.mjs";
import {
  SCENE_BATCH,
  sceneCountFor,
  styleLockFor,
  DIRECTOR_SYSTEM,
  stripJson,
  normalizeBlueprint,
  normalizeDialogue,
  normalizeScene,
  sameLine,
  buildBiblePrompt,
  buildScenesPrompt,
  buildRegenPrompt,
  boardToScenario,
} from "../lib/director.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Same tiny .env loader as lib/comfy.mjs (real env vars always win).
{
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
  }
}
const PROMPTS = path.join(ROOT, "prompts");
const OUTPUTS = path.join(ROOT, "outputs");
const FAVS = path.join(ROOT, "favorites.json");
const readFavs = () => {
  try { return JSON.parse(fs.readFileSync(FAVS, "utf8")).names; }
  catch { return []; }
};
// UI theme persisted in a file (data/theme.json) so the chosen mode + accent
// color survive reloads, restarts and browsers — localStorage is only a cache.
// Shape: { mode: "dark" | "light", color: "" | "#rrggbb" }.
const THEME_FILE = path.join(ROOT, "data", "theme.json");
const readThemeFile = () => {
  try {
    const t = JSON.parse(fs.readFileSync(THEME_FILE, "utf8"));
    const mode = t.mode === "light" ? "light" : "dark";
    const color = typeof t.color === "string" && /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : "";
    return { mode, color };
  } catch { return { mode: "dark", color: "" }; }
};
const writeThemeFile = (t) => {
  fs.mkdirSync(path.dirname(THEME_FILE), { recursive: true });
  fs.writeFileSync(THEME_FILE, JSON.stringify(t, null, 2));
};
// ---------------------------------------------------------------- scenarios store
// Scenario configs live in Postgres (scenarios table) by default — SQLite is
// NOT used unless explicitly enabled. Set USE_SQLITE=true in the root .env to
// use the legacy SQLite store instead (data/scenarios.sqlite, canonical for
// the UI, mirrored to Postgres). Requires a server restart to take effect.
// On save we ALSO export the JSON to prompts/<name>.json so the CLI runners
// (director.mjs, ...), which read prompts/<scenario>.json, keep working
// unchanged — in either mode.
const USE_SQLITE = ["1", "true", "yes", "on"].includes(String(process.env.USE_SQLITE || "").trim().toLowerCase());
const DATA_DIR = path.join(ROOT, "data");
const DB = path.join(DATA_DIR, "scenarios.sqlite");
let db = null;
if (USE_SQLITE) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  {
    const init = new DatabaseSync(DB);
    init.exec(`CREATE TABLE IF NOT EXISTS scenarios (
      name TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // One-time migration: import any prompts/*.json not yet in the DB.
    // The dir may have been wiped — ensure it exists instead of crashing boot.
    fs.mkdirSync(PROMPTS, { recursive: true });
    const insert = init.prepare("INSERT OR IGNORE INTO scenarios (name, config, updated_at) VALUES (?, ?, ?)");
    for (const f of fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json"))) {
      const name = f.replace(/\.json$/, "");
      if (!init.prepare("SELECT 1 FROM scenarios WHERE name = ?").get(name)) {
        insert.run(name, fs.readFileSync(path.join(PROMPTS, f), "utf8"), fs.statSync(path.join(PROMPTS, f)).mtimeMs);
      }
    }
    init.close();
  }
  db = new DatabaseSync(DB);
  console.log("[db] scenario store: sqlite (data/scenarios.sqlite)");
} else {
  console.log("[db] scenario store: postgres (sqlite disabled — set USE_SQLITE=true to use it)");
}
// Async in both modes so callers don't care which store is active. PG rows
// are shaped like the old SQLite ones: { name, config (JSON text), updated_at (ms) }.
const dbListScenarios = async () => {
  if (USE_SQLITE) return db.prepare("SELECT name, config, updated_at FROM scenarios ORDER BY updated_at DESC").all();
  if (!pgUp) throw new Error("database unavailable");
  const r = await pgPool.query(
    "SELECT name, config::text AS config, updated_at_ms AS updated_at FROM scenarios ORDER BY updated_at_ms DESC");
  return r.rows;
};
const dbGetScenario = async (name) => {
  if (USE_SQLITE) return db.prepare("SELECT config FROM scenarios WHERE name = ?").get(name)?.config ?? null;
  if (!pgUp) return null;
  const r = await pgPool.query("SELECT config::text AS config FROM scenarios WHERE name = $1", [name]);
  return r.rows[0]?.config ?? null;
};
const dbSaveScenario = async (name, cfg) => {
  if (USE_SQLITE) {
    // folder_name rides inside the config JSON (SQLite has no projects
    // table); the PUT route stamps the immutable value before calling here.
    if (cfg && typeof cfg === "object" && !cfg.folder_name) {
      cfg = { ...cfg, folder_name: folderName(name) };
    }
    db.prepare(`INSERT INTO scenarios (name, config, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`)
      .run(name, JSON.stringify(cfg), Date.now());
    return;
  }
  // PostgreSQL: folder claiming happens in the PUT route (unique + frozen);
  // here we only persist the scenario row. The projects.folder_name backfill
  // below covers rows that predate the folder column.
  await pgPool.query(
    `INSERT INTO scenarios (name, config, updated_at_ms) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at_ms = EXCLUDED.updated_at_ms`,
    [name, JSON.stringify(cfg), Date.now()]);
  if (pgUp && cfg && typeof cfg === "object" && cfg.folder_name) {
    await pgPool.query(
      `UPDATE projects SET folder_name = $2 WHERE name = $1 AND (folder_name IS NULL OR folder_name = '')`,
      [name, cfg.folder_name]
    );
  }
};
const dbDeleteScenario = async (name) => {
  if (USE_SQLITE) { db.prepare("DELETE FROM scenarios WHERE name = ?").run(name); return; }
  await pgPool.query("DELETE FROM scenarios WHERE name = $1", [name]);
};
// Escape LIKE wildcards in user-chosen names (spaces, %, _ … are all legal).
const pgLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
// Display-name rename across the name-keyed catalog rows. Storage
// (outputs dirs, filenames, assets/project_assets paths, folder_name) is
// IMMUTABLE and intentionally untouched here — that is what keeps images,
// thumbnails and videos resolving after a project is renamed or edited.
async function pgRenameRows(oldName, newName) {
  const now = Date.now();
  await pgPool.query("UPDATE scenarios SET name = $2, updated_at_ms = $3 WHERE name = $1", [oldName, newName, now]);
  await pgPool.query("UPDATE scenario_versions SET name = $2 WHERE name = $1", [oldName, newName]);
  await pgPool.query("UPDATE projects SET name = $2, updated_at = now() WHERE name = $1", [oldName, newName]);
}
async function dbRenameScenario(oldName, newName) {
  if (USE_SQLITE) {
    // SQLite mode only has the scenarios table (versions/catalog are PG-only).
    db.prepare("UPDATE scenarios SET name = ?, updated_at = ? WHERE name = ?").run(newName, Date.now(), oldName);
    return;
  }
  if (!pgUp) throw new Error("database unavailable");
  await pgRenameRows(oldName, newName);
}
async function pgRenameScenarioMirror(oldName, newName) {
  if (!pgUp) return;
  await pgRenameRows(oldName, newName);
}
// Swap a leading filename prefix ("<old>_" -> "<new>_"); anything else
// (state.json, foreign files) passes through untouched.
const swapPrefix = (file, oldPrefix, newPrefix) =>
  (typeof file === "string" && file.startsWith(oldPrefix)) ? newPrefix + file.slice(oldPrefix.length) : file;
// Move outputs/<oldBase>[engines x formats] to outputs/<newBase>, swapping
// the embedded leading filename prefix and state.json mains (generated files
// are namespaced "<base>_" / "<base>_wan_" / ...). Variants whose target dir
// already exists are MERGED file-by-file (collisions keep the target file);
// missing source variants are skipped. Returns moved [oldDir, newDir] pairs.
// Shared by legacy storage migration (display-name dirs -> folder dirs).
// (Prompts JSON is keyed by display name and is NOT moved here.)
function moveOutputDirs(oldBase, newBase) {
  const moved = [];
  for (const suffix of ["", "_wan", "_vertical", "_wan_vertical"]) {
    const oldDir = path.join(OUTPUTS, oldBase + suffix);
    if (!fs.existsSync(oldDir)) continue;
    const newDir = path.join(OUTPUTS, newBase + suffix);
    const from = oldBase + suffix + "_";
    const to = newBase + suffix + "_";
    if (fs.existsSync(newDir)) {
      // Merge: relocate non-colliding files, then drop the empty shell.
      for (const f of fs.readdirSync(oldDir)) {
        const swapped = swapPrefix(f, from, to);
        if (swapped !== f && fs.existsSync(path.join(newDir, swapped))) continue; // keep target
        const dest = swapped !== f ? path.join(newDir, swapped) : path.join(newDir, f);
        try { fs.renameSync(path.join(oldDir, f), dest); } catch { /* keep going */ }
      }
      // Fold the old state.json mains into the surviving one when it lacks them.
      mergeStateMains(newDir, oldDir, from, to);
      try {
        if (!fs.readdirSync(oldDir).filter((f) => f !== "state.json").length) {
          if (fs.existsSync(path.join(oldDir, "state.json"))) {
            try { fs.unlinkSync(path.join(oldDir, "state.json")); } catch { /* keep */ }
          }
          fs.rmdirSync(oldDir);
        }
      } catch { /* leftover shell stays — harmless */ }
      moved.push([oldBase + suffix, newBase + suffix]);
      continue;
    }
    for (const f of fs.readdirSync(oldDir)) {
      const swapped = swapPrefix(f, from, to);
      if (swapped !== f) fs.renameSync(path.join(oldDir, f), path.join(oldDir, swapped));
    }
    // state.json mains reference filenames — swap the same prefix. A corrupt
    // file is left alone (versionMap falls back to latest-on-disk).
    rewriteStatePrefixes(oldDir, from, to);
    fs.renameSync(oldDir, newDir);
    moved.push([oldBase + suffix, newBase + suffix]);
  }
  return moved;
}
// Rewrite state.json mains with a filename mapping (old file -> new file).
// Used by storage migration after slug renames; unknown values pass through.
function rewriteStateFiles(dir, renameMap) {
  const sf = path.join(dir, "state.json");
  if (!fs.existsSync(sf)) return;
  try {
    const st = JSON.parse(fs.readFileSync(sf, "utf8"));
    if (!st || typeof st !== "object") return;
    const swap = (v) => (typeof v === "string" && renameMap.has(v) ? renameMap.get(v) : v);
    if (st.ref) st.ref = swap(st.ref);
    if (st.final) st.final = swap(st.final);
    if (st.beats && typeof st.beats === "object") {
      for (const k of Object.keys(st.beats)) {
        const b = st.beats[k];
        if (b && typeof b === "object") {
          if (b.keyframe) b.keyframe = swap(b.keyframe);
          if (b.clip) b.clip = swap(b.clip);
        }
      }
    }
    fs.writeFileSync(sf, JSON.stringify(st, null, 2));
  } catch { /* keep old mains */ }
}
function rewriteStatePrefixes(dir, from, to) {
  const sf = path.join(dir, "state.json");
  if (!fs.existsSync(sf)) return;
  try {
    const st = JSON.parse(fs.readFileSync(sf, "utf8"));
    if (st && typeof st === "object") {
      if (st.ref) st.ref = swapPrefix(st.ref, from, to);
      if (st.final) st.final = swapPrefix(st.final, from, to);
      if (st.beats && typeof st.beats === "object") {
        for (const k of Object.keys(st.beats)) {
          const b = st.beats[k];
          if (b && typeof b === "object") {
            if (b.keyframe) b.keyframe = swapPrefix(b.keyframe, from, to);
            if (b.clip) b.clip = swapPrefix(b.clip, from, to);
          }
        }
      }
      fs.writeFileSync(sf, JSON.stringify(st, null, 2));
    }
  } catch { /* keep old mains */ }
}
// Fold an absorbed state.json's mains into the surviving dir's state when the
// survivor has no main recorded for that asset (pins from the surviving file
// always win — they are the newer deliberate choice).
function mergeStateMains(surviveDir, absorbedDir, from, to) {
  const a = path.join(absorbedDir, "state.json");
  const s = path.join(surviveDir, "state.json");
  if (!fs.existsSync(a)) return;
  try {
    const oldSt = JSON.parse(fs.readFileSync(a, "utf8"));
    let newSt = {};
    try { if (fs.existsSync(s)) newSt = JSON.parse(fs.readFileSync(s, "utf8")) || {}; } catch { newSt = {}; }
    const pick = (v) => (typeof v === "string" ? swapPrefix(v, from, to) : v);
    if (!newSt.ref && oldSt && oldSt.ref) newSt.ref = pick(oldSt.ref);
    if (!newSt.final && oldSt && oldSt.final) newSt.final = pick(oldSt.final);
    const beats = (oldSt && oldSt.beats && typeof oldSt.beats === "object") ? oldSt.beats : {};
    newSt.beats = { ...(newSt.beats || {}) };
    for (const k of Object.keys(beats)) {
      const b = beats[k] || {};
      const cur = newSt.beats[k] || {};
      newSt.beats[k] = {
        ...cur,
        ...(!cur.keyframe && b.keyframe ? { keyframe: pick(b.keyframe) } : {}),
        ...(!cur.clip && b.clip ? { clip: pick(b.clip) } : {}),
      };
    }
    fs.writeFileSync(s, JSON.stringify(newSt, null, 2));
  } catch { /* survivor keeps its state */ }
}
// Legacy rename entry point (prompts JSON only — outputs dirs are immutable
// storage now and move exclusively via moveOutputDirs during migration).
function renameScenarioFiles(oldName, newName) {
  const pj = path.join(PROMPTS, oldName + ".json");
  if (fs.existsSync(pj)) fs.renameSync(pj, path.join(PROMPTS, newName + ".json"));
}
// Slugify legacy filenames inside one output dir using the CURRENT config
// beat titles: "<prefix>_{seq,clip}<n>_<raw title>[(_vN)].<ext>" ->
// "<prefix>_{seq,clip}<n>_<slug title>[(_vN)].<ext>". Returns the old->new
// filename map (for state.json + DB path rewrites). Collisions are skipped.
function slugifyDirFilenames(dir, prefix, seq) {
  const renamed = new Map();
  if (!fs.existsSync(dir) || !Array.isArray(seq)) return renamed;
  const kinds = [["seq", ".png"], ["clip", ".mp4"]];
  seq.forEach((s, i) => {
    const n = i + 1;
    const raw = String(s?.title ?? "");
    const slug = fileSlug(raw);
    if (!raw || raw === slug) return;
    for (const [kind, ext] of kinds) {
      const rawBase = `${prefix}_${kind}${n}_${raw}`;
      const slugBase = `${prefix}_${kind}${n}_${slug}`;
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) =>
          f === rawBase + ext || (f.startsWith(rawBase + "_v") && f.endsWith(ext)));
      } catch { files = []; }
      for (const f of files) {
        const rest = f.slice(rawBase.length, -ext.length); // "" | "_vN"
        if (rest && !/^_v\d+$/.test(rest)) continue;
        const dest = slugBase + rest + ext;
        if (fs.existsSync(path.join(dir, dest))) continue; // never clobber
        try {
          fs.renameSync(path.join(dir, f), path.join(dir, dest));
          renamed.set(f, dest);
        } catch { /* keep going */ }
      }
    }
  });
  return renamed;
}
// One-time legacy migration for a project: claim its immutable folder,
// relocate display-name output dirs to folder dirs (prefix swap), slugify
// legacy spaced filenames, and rewrite state.json + DB paths from the exact
// rename map. Safe no-op when already canonical. Returns the folder.
async function migrateProjectStorage(displayName) {
  const stored = pgUp ? await getFolderNameFromRow(displayName) : null;
  // Stable folder claim WITHOUT a project row: reuse the slug dir when it
  // is absent or already holds this scenario's own files (prefix match) — so
  // every run for the same unsaved scenario lands in the SAME folder. Only a
  // genuinely foreign collision (dir exists with other files) mints a fresh
  // _N folder. (Previously every row-less run minted +1 merely because the
  // previous run's dir existed, scattering one project's assets across
  // minku_story_2_2, _3, … and emptying its gallery forever.)
  let folder = stored;
  if (!folder) {
    const base = folderName(displayName);
    let ours = false;
    try {
      const dir = path.join(OUTPUTS, base);
      if (!fs.existsSync(dir)) ours = true; // fresh — claim base
      else {
        const prefix = prefixForDir(base);
        ours = fs.readdirSync(dir).some((f) =>
          f === "state.json" || f === "concat_list.txt" || f.startsWith(`${prefix}_`));
      }
    } catch { ours = false; }
    folder = ours ? base : (pgUp ? await ensureUniqueFolder(displayName, displayName) : base);
  }
  if (pgUp && !stored) {
    try {
      await pgPool.query(
        "UPDATE projects SET folder_name = $2 WHERE name = $1 AND (folder_name IS NULL OR folder_name = '')",
        [displayName, folder]);
    } catch { /* row may not exist yet — claimed on next save */ }
  }
  // Slug pass over canonical dirs (fixes spaced beat-title filenames even
  // when the folder already matches the name).
  const renameMap = new Map(); // "dir/file" -> new file
  try {
    const raw = await dbGetScenario(displayName);
    const cfg = raw ? JSON.parse(raw) : null;
    const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
    for (const suffix of ["", "_wan", "_vertical", "_wan_vertical"]) {
      const dir = path.join(OUTPUTS, folder + suffix);
      if (!fs.existsSync(dir)) continue;
      const prefix = prefixForDir(folder + suffix);
      for (const [oldF, newF] of slugifyDirFilenames(dir, prefix, seq)) {
        renameMap.set(`${folder + suffix}/${oldF}`, `${folder + suffix}/${newF}`);
      }
    }
  } catch { /* config unreadable — skip slug pass */ }
  // Relocate legacy display-name dirs (different base only).
  let moved = [];
  if (folder !== displayName) {
    try { moved = moveOutputDirs(displayName, folder); }
    catch (e) { console.warn(`[migrate] dir move failed for ${displayName}:`, e.message); moved = []; }
    // Slug pass over freshly moved dirs (old prefix, raw titles).
    try {
      const raw = await dbGetScenario(displayName);
      const cfg = raw ? JSON.parse(raw) : null;
      const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
      for (const [, newBase] of moved) {
        const dir = path.join(OUTPUTS, newBase);
        const prefix = prefixForDir(newBase);
        for (const [oldF, newF] of slugifyDirFilenames(dir, prefix, seq)) {
          renameMap.set(`${newBase}/${oldF}`, `${newBase}/${newF}`);
        }
      }
    } catch { /* skip */ }
  }
  // Rewrite state.json mains from the exact rename map.
  if (renameMap.size) {
    const byDir = new Map();
    for (const [from, to] of renameMap) {
      const slash = from.indexOf("/");
      const dir = from.slice(0, slash), oldF = from.slice(slash + 1), newF = to.slice(to.indexOf("/") + 1);
      if (!byDir.has(dir)) byDir.set(dir, new Map());
      byDir.get(dir).set(oldF, newF);
    }
    for (const [dir, map] of byDir) rewriteStateFiles(path.join(OUTPUTS, dir), map);
  }
  if (pgUp && (moved.length || renameMap.size)) {
    // project_assets: exact-match path rewrites + frozen folder stamp.
    try {
      const pid = await pgProjectId(displayName);
      if (pid != null) {
        await pgPool.query("UPDATE project_assets SET folder_name = $2 WHERE project_id = $1", [pid, folder]);
        for (const [from, to] of renameMap) {
          const oldP = `outputs/${from}`, newP = `outputs/${to}`;
          await pgPool.query(
            "UPDATE project_assets SET file_path = $3 WHERE project_id = $1 AND file_path = $2",
            [pid, oldP, newP]);
          const oldF = from.slice(from.indexOf("/") + 1), newF = to.slice(to.indexOf("/") + 1);
          await pgPool.query(
            `UPDATE project_assets SET metadata = jsonb_set(metadata, '{file}', to_jsonb($3::text))
             WHERE project_id = $1 AND metadata->>'file' = $2`,
            [pid, oldF, newF]);
        }
        for (const suffix of ["", "_wan", "_vertical", "_wan_vertical"]) {
          try { await pgRefreshProjectFiles(displayName, folder + suffix); } catch { /* no dir */ }
        }
      }
    } catch (e) { console.warn(`[migrate] project_assets fixup failed for ${displayName}:`, e.message); }
    // project_references: moved dirs change output_dir; renames change
    // file_path + metadata.file (exact matches from the rename map).
    try {
      const pid = await pgProjectId(displayName);
      if (pid != null) {
        for (const [oldBase, newBase] of moved) {
          await pgPool.query(
            "UPDATE project_references SET output_dir = $3 WHERE project_id = $1 AND output_dir = $2",
            [pid, oldBase, newBase]);
        }
        for (const [from, to] of renameMap) {
          const oldP = `outputs/${from}`, newP = `outputs/${to}`;
          await pgPool.query(
            "UPDATE project_references SET file_path = $3 WHERE project_id = $1 AND file_path = $2",
            [pid, oldP, newP]);
          const oldF = from.slice(from.indexOf("/") + 1), newF = to.slice(to.indexOf("/") + 1);
          await pgPool.query(
            `UPDATE project_references SET metadata = jsonb_set(metadata, '{file}', to_jsonb($3::text))
             WHERE project_id = $1 AND metadata->>'file' = $2`,
            [pid, oldF, newF]);
        }
      }
    } catch (e) { console.warn(`[migrate] references fixup failed for ${displayName}:`, e.message); }
  }
  return folder;
}

// ---------------------------------------------------------------- pg catalog
// Every finished generation is tracked in Postgres `video_generator`
// (binaries stay in outputs/ — the DB is the catalog):
//   project_assets     — keyframe / clip / final rows per version
//   project_references — reference visuals, one row per generation/upload
// The gallery file list and dashboard coverage are derived from disk
// (outputs/ dirs are the source of truth for files). If Postgres is down
// the server keeps working from disk (pgUp === false).
const pgPool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || "video_generator",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "",
  connectionTimeoutMillis: 3000,
});
let pgUp = false;
const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS scenarios (
  name TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenario_versions (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  version INT NOT NULL,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);
CREATE INDEX IF NOT EXISTS scenario_versions_name_idx ON scenario_versions (name);
CREATE TABLE IF NOT EXISTS projects (
  project_id SERIAL UNIQUE,
  name TEXT PRIMARY KEY,
  folder_name TEXT,
  description TEXT,
  duration INT,
  beats INT NOT NULL DEFAULT 0,
  master_prompt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_assets (
  id BIGSERIAL NOT NULL,
  project_id INTEGER NOT NULL,
  folder_name TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  scene_id INTEGER,
  beat_index INTEGER NOT NULL DEFAULT 0,
  beat_title TEXT,
  asset_type TEXT NOT NULL,
  video_type TEXT NOT NULL DEFAULT 'YOUTUBE',
  status TEXT NOT NULL DEFAULT 'PENDING',
  prompt TEXT,
  negative_prompt TEXT,
  file_path TEXT,
  model TEXT,
  workflow TEXT,
  seed BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  error_message TEXT,
  metadata JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_assets_pkey PRIMARY KEY (id),
  CONSTRAINT project_assets_project_fkey FOREIGN KEY (project_id)
    REFERENCES public.projects(project_id) ON DELETE CASCADE,
  CONSTRAINT project_assets_asset_type_check CHECK (
    asset_type IN ('REFERENCE', 'IMAGE', 'KEYFRAME', 'VIDEO', 'FINAL')),
  CONSTRAINT project_assets_video_type_check CHECK (
    video_type IN ('YOUTUBE', 'INSTAGRAM')),
  CONSTRAINT project_assets_status_check CHECK (
    status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED')),
  CONSTRAINT project_assets_version_check CHECK (version > 0),
  CONSTRAINT project_assets_beat_index_check CHECK (beat_index >= 0),
  CONSTRAINT project_assets_attempts_check CHECK (
    attempts >= 0 AND max_retries >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_assets_project_version_type_beat_key
  ON public.project_assets(project_id, version, asset_type, beat_index, video_type);
CREATE INDEX IF NOT EXISTS idx_project_assets_project_id ON public.project_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_assets_scene_id ON public.project_assets(scene_id);
CREATE INDEX IF NOT EXISTS idx_project_assets_project_version_beat ON public.project_assets(project_id, version, beat_index);
CREATE INDEX IF NOT EXISTS idx_project_assets_asset_type ON public.project_assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_project_assets_status ON public.project_assets(project_id, status);
CREATE INDEX IF NOT EXISTS idx_project_assets_metadata ON public.project_assets USING GIN (metadata);
CREATE OR REPLACE FUNCTION public.update_project_assets_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_project_assets_updated_at ON public.project_assets;
CREATE TRIGGER trg_project_assets_updated_at BEFORE UPDATE ON public.project_assets
FOR EACH ROW EXECUTE FUNCTION public.update_project_assets_updated_at();
-- Reference visuals live in their own table (a project has MANY master
-- prompts / reference images over time — one row per generation or upload).
-- project_assets no longer stores asset_type='REFERENCE' rows. is_main marks
-- the record selected as main on the UI (one per project + output dir);
-- pinned marks a deliberate user pick (manual select / upload) that keeps
-- winning over later auto generations.
CREATE TABLE IF NOT EXISTS project_references (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES public.projects(project_id) ON DELETE CASCADE,
  output_dir TEXT NOT NULL,
  version INTEGER,
  prompt TEXT,
  negative_prompt TEXT,
  file_path TEXT,
  model TEXT,
  workflow TEXT,
  seed BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'generated' CHECK (source IN ('generated', 'upload')),
  video_type TEXT NOT NULL DEFAULT 'YOUTUBE',
  is_main BOOLEAN NOT NULL DEFAULT FALSE,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS project_references_one_main
  ON public.project_references(project_id, output_dir) WHERE is_main;
ALTER TABLE project_references DROP CONSTRAINT IF EXISTS project_references_video_type_check;
ALTER TABLE project_references ADD CONSTRAINT project_references_video_type_check
  CHECK (video_type IN ('YOUTUBE', 'INSTAGRAM'));
CREATE INDEX IF NOT EXISTS idx_project_references_project ON public.project_references(project_id);`;
// NOTE: project_assets uses the narrow canonical DDL above (one row per
// asset: KEYFRAME / VIDEO / FINAL (+ IMAGE for ad-hoc stills), with a
// single status/prompt/file_path per row; scene_id is the INTEGER scene
// number (N = beat N). Reference visuals are NOT stored here anymore — they
// live in project_references (one row per generation/upload, is_main marks
// the UI-selected main). A TEXT scene_id from the previous
// revision is auto-migrated in pgInit(); the old wide table still needs a
// one-time DROP TABLE public.project_assets; to be recreated.
async function pgProbe() {
  try { await pgPool.query("SELECT 1"); pgUp = true; }
  catch (e) { pgUp = false; console.warn(`[pg] unreachable: ${e.message} — gallery falls back to disk`); }
  return pgUp;
}
// Final-cut filename -> 1-based stitch version:
//   <prefix>_final.mp4 -> 1, <prefix>_final_vN.mp4 -> N, anything else -> null.
// A FINAL project_assets row is stored per stitch with beat_index = this
// version, so every Stitch click inserts a NEW row (the UNIQUE key is
// (project_id, version, asset_type, beat_index)).
function finalCutVersion(file) {
  const m = String(file || "").match(/_final(?:_v(\d+))?\.mp4$/);
  return m ? (m[1] ? Number(m[1]) : 1) : null;
}
// Full backfill on boot (scenarios / versions / projects for files created
// while the server was down). File lists always come from disk.
async function syncAllToPg() {
  if (!USE_SQLITE) {
    // Fresh Postgres: import any prompts/*.json once (mirrors the legacy
    // SQLite boot import) so existing CLI scenarios show up in the UI.
    try {
      const c = await pgPool.query("SELECT count(*)::int AS n FROM scenarios");
      if (c.rows[0].n === 0 && fs.existsSync(PROMPTS)) {
        for (const f of fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json"))) {
          try {
            const cfgText = fs.readFileSync(path.join(PROMPTS, f), "utf8");
            JSON.parse(cfgText); // skip invalid JSON
            await pgPool.query(
              `INSERT INTO scenarios (name, config, updated_at_ms) VALUES ($1, $2::jsonb, $3)
               ON CONFLICT (name) DO NOTHING`,
              [f.replace(/\.json$/, ""), cfgText, Math.round(fs.statSync(path.join(PROMPTS, f)).mtimeMs)]);
          } catch { /* skip unreadable prompt files */ }
        }
      }
    } catch (e) { console.warn("[pg] prompts import failed:", e.message); }
  }
  for (const r of await dbListScenarios()) {
    await pgPool.query(
      `INSERT INTO scenarios (name, config, updated_at_ms) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at_ms = EXCLUDED.updated_at_ms`,
      [r.name, String(r.config), Math.round(Number(r.updated_at))]);
  }
  // Seed v1 for projects saved before versioning existed.
  await pgPool.query(
    `INSERT INTO scenario_versions (name, version, config)
     SELECT name, 1, config FROM scenarios s
     WHERE NOT EXISTS (SELECT 1 FROM scenario_versions v WHERE v.name = s.name)`);
  // Backfill projects + their latest version's asset rows. Delta-safe: only
  // snapshot when the project has NO asset rows at all (fresh/legacy
  // project); never backfill into an existing version, or unchanged scenes
  // would be duplicated into the latest delta version.
  const latest = await pgPool.query(
    "SELECT name, max(version) AS version FROM scenario_versions GROUP BY name");
  for (const { name, version } of latest.rows) {
    const raw = await dbGetScenario(name);
    if (raw === null) continue;
    try {
      const pid = await pgProjectId(name);
      if (pid != null) {
        const has = await pgPool.query(
          "SELECT 1 FROM project_assets WHERE project_id = $1 LIMIT 1", [pid]);
        if (has.rowCount) continue;
      }
      const cfg = JSON.parse(raw);
      // Backfill against the canonical folder (migrates legacy raw dirs
      // first so mains resolve from real files, not empty dirs).
      const folder = await migrateProjectStorage(name);
      await pgSaveProject(name, cfg, Number(version), mainsFor(folder, cfg), folder);
      // Reference mains (all four dirs) into project_references — skipped
      // when the project already has reference rows.
      await pgBackfillReferences(name, folder, cfg);
    } catch (e) { console.warn(`[pg] project backfill failed for ${name}:`, e.message); }
  }
  console.log(`[pg] projects backfilled`);
}
async function pgSaveScenarioMirror(name, cfg) {
  if (!pgUp) return;
  await pgPool.query(
    `INSERT INTO scenarios (name, config, updated_at_ms) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at_ms = EXCLUDED.updated_at_ms`,
    [name, JSON.stringify(cfg), Date.now()]);
}
async function pgDeleteScenarioMirror(name) {
  if (!pgUp) return;
  await pgPool.query("DELETE FROM scenarios WHERE name = $1", [name]);
  await pgPool.query("DELETE FROM scenario_versions WHERE name = $1", [name]);
  // Delete the project by its integer project_id (cascades to project_assets).
  const idRow = await pgPool.query("SELECT project_id FROM projects WHERE name = $1", [name]);
  const pid = idRow.rows[0]?.project_id;
  if (pid != null) await pgPool.query("DELETE FROM projects WHERE project_id = $1", [pid]); // cascades to project_assets
  else await pgPool.query("DELETE FROM projects WHERE name = $1", [name]); // pre-migration fallback
}
// Resolve a project's integer project_id from its name (all project_assets
// CRUD keys off project_id, never the name).
async function pgProjectId(name) {
  const r = await pgPool.query("SELECT project_id FROM projects WHERE name = $1", [name]);
  return r.rows[0]?.project_id ?? null;
}
// Upsert one row in projects and return its project_id. This is what "Craft
// scenario saves to projects" means: the project exists from the moment it
// is crafted, before any version/asset rows. Save Scenario later reuses the
// same project_id for its project_assets rows (see pgSaveProject).
// folder_name is set ONCE on INSERT and never updated on subsequent saves.
async function pgEnsureProject(name, cfg) {
  const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
  // folder_name is minted ONCE (unique) and then frozen — re-saves and
  // renames never change it, so output dirs and DB paths stay stable.
  let fn = await getFolderNameFromRow(name);
  if (!fn) fn = await ensureUniqueFolder(name, name);
  const proj = await pgPool.query(
    `INSERT INTO projects (name, folder_name, description, duration, beats, master_prompt, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (name) DO UPDATE SET
        folder_name = COALESCE(NULLIF(projects.folder_name, ''), EXCLUDED.folder_name),
       description = EXCLUDED.description, duration = EXCLUDED.duration, beats = EXCLUDED.beats,
       master_prompt = COALESCE(EXCLUDED.master_prompt, projects.master_prompt),
       updated_at = now()
     RETURNING project_id`,
    [name, fn, cfg.description ?? null,
     Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null, seq.length,
     cfg.referencePrompt ?? null]);
  const projectId = proj.rows[0]?.project_id;
  if (projectId == null) throw new Error(`pgEnsureProject: no project_id for ${name}`);
  return projectId;
}
// Explicit Save = new version of the same project (v1, v2, …). Never overwrites.
async function pgSaveVersion(name, cfg) {
  const r = await pgPool.query(
    `INSERT INTO scenario_versions (name, version, config)
     VALUES ($1, COALESCE((SELECT max(version) FROM scenario_versions WHERE name = $1), 0) + 1, $2::jsonb)
     RETURNING version`,
    [name, JSON.stringify(cfg)]);
  return r.rows[0].version;
}
// Current main files for a project (nulls when nothing generated yet).
function mainsFor(dirName, cfg) {
  const out = { ref: null, beats: {}, final: null, finalV: null };
  try {
    const dir = path.join(OUTPUTS, dirName);
    if (!fs.existsSync(dir)) return out;
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    const vm = versionMap(dir, prefixFor(dirName), seq);
    out.ref = vm.refMain ?? null;
    out.beats = vm.beats ?? {};
    out.final = vm.finalMain ?? null;
    out.finalV = (vm.final || []).find((x) => x.file === out.final)?.v ?? null;
  } catch { /* unversionable dir — mains stay null */ }
  return out;
}
// ---------------------------------------------------------------- project_assets mapping
// Canonical table: public.project_assets (narrow DDL — one row per asset).
//   asset_type='KEYFRAME',  beat_index=N -> beat N Flux keyframe (b.image)
//   asset_type='VIDEO',     beat_index=N -> beat N i2v clip (b.motion)
//   asset_type='FINAL',     beat_index=V -> stitch V of the final cut
//     (v1 = <prefix>_final.mp4, vN = <prefix>_final_vN.mp4; one NEW row per
//     stitch, scene_id 0, workflow 'ffmpeg-concat')
// Reference visuals are NOT rows here — they live in project_references
// (one row per generation/upload, is_main = UI-selected main).
// ('IMAGE' is valid for ad-hoc stills; this pipeline writes KEYFRAME.)
// Each row has its own prompt/status/file_path/model/workflow/attempts/
// metadata/started_at/completed_at. Size/dims live inside metadata JSONB.
const REF_MODEL = "flux-2-klein-9b-fp8";
const IMG_MODEL = "flux-2-klein-9b-fp8";
const LTX_MODEL = "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot";
const WAN_MODEL = "wan2.1-i2v-14b-480p-Q4_K_M.gguf";
const REF_WORKFLOW = "flux-t2i";
const IMG_WORKFLOW = "flux-t2i";
const LTX_WORKFLOW = "ltx2_5_i2v";
const WAN_WORKFLOW = "image_to_video_wan";
const mimeFor = (file) => {
  const e = path.extname(String(file || "")).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  if (e === ".mp4") return "video/mp4";
  if (e === ".wav") return "audio/wav";
  return null;
};
// Best-effort PNG dimensions (IHDR) — null when unreadable/non-PNG.
function pngDims(fullPath) {
  try {
    const fd = fs.openSync(fullPath, "r");
    const buf = Buffer.alloc(26);
    const n = fs.readSync(fd, buf, 0, 26, 0);
    fs.closeSync(fd);
    if (n < 26) return null;
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch { return null; }
}
// Disk facts for one output file (nulls when the file is missing — the row
// still records prompts/status, file columns stay NULL).
function diskFacts(outputFolder, file) {
  if (!file) return { bytes: null, mime: null, w: null, h: null };
  try {
    const full = path.join(OUTPUTS, outputFolder, file);
    const st = fs.statSync(full);
    if (!st.isFile()) return { bytes: null, mime: null, w: null, h: null };
    const dims = file.toLowerCase().endsWith(".png") ? pngDims(full) : null;
    return { bytes: st.size, mime: mimeFor(file), w: dims?.w ?? null, h: dims?.h ?? null };
  } catch { return { bytes: null, mime: null, w: null, h: null }; }
}
const engineForFolder = (folder) => engineForDir(folder);
// Project info row + that version's asset rows (prompts + current main files).
// SNAPSHOT path — used ONLY for version 1 and for backfilling projects that
// have no project_assets rows yet. For v2+ use pgSaveVersionDelta() below,
// which inserts ONLY the changed scenes (delta-based versioning).
// Narrow schema: ONE ROW PER ASSET —
//   asset_type='KEYFRAME',  beat_index=N        -> beat N Flux keyframe (b.image)
//   asset_type='VIDEO',     beat_index=N        -> beat N i2v clip (b.motion)
// ('IMAGE' stays valid for ad-hoc single stills; this pipeline writes
// KEYFRAME for beat images. Reference visuals live in project_references.)
// Each row carries its own prompt/status/
// file_path/model/workflow/attempts/metadata/timing. Size/dims live inside
// metadata (no width/height columns in the narrow DDL).
// Existing COMPLETED rows are never downgraded back to PENDING.
// Seed INSTAGRAM (vertical Reel cut) rows from an existing vertical output
// dir: one COMPLETED row per beat that already has a main file on disk, plus
// the vertical FINAL when stitched. Landscape saves stay YOUTUBE-only;
// vertical generations fill rows via pgMarkAssetComplete. `query` is a
// (text, params) function (pool or transaction client).
async function pgSeedInstagramRows(query, projectId, folder, engine, cfg, version) {
  try {
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    if (!seq.length) return 0;
    const vdir = outDirName(folder, engine, "vertical");
    if (!fs.existsSync(path.join(OUTPUTS, vdir))) return 0;
    const vm = versionMap(path.join(OUTPUTS, vdir), prefixForDir(vdir), seq);
    const UPSERT_IG = `INSERT INTO project_assets (
      project_id, folder_name, version, scene_id, beat_index, beat_title,
      asset_type, video_type, status, prompt, negative_prompt, file_path,
      model, workflow, attempts, max_retries, metadata, started_at, completed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, 'INSTAGRAM', $8, $9, $10, $11, $12, $13, $14, 3, $15::jsonb,
      $16::timestamptz, $17::timestamptz
    )
    ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO UPDATE SET
      folder_name = EXCLUDED.folder_name,
      scene_id = EXCLUDED.scene_id, beat_title = EXCLUDED.beat_title,
      prompt = EXCLUDED.prompt, negative_prompt = EXCLUDED.negative_prompt,
      file_path = COALESCE(EXCLUDED.file_path, project_assets.file_path),
      model = EXCLUDED.model, workflow = EXCLUDED.workflow,
      attempts = GREATEST(project_assets.attempts, EXCLUDED.attempts),
      metadata = COALESCE(EXCLUDED.metadata, project_assets.metadata),
      status = CASE WHEN EXCLUDED.file_path IS NOT NULL THEN 'COMPLETED' ELSE project_assets.status END,
      started_at = CASE WHEN EXCLUDED.file_path IS NOT NULL AND project_assets.started_at IS NULL THEN now() ELSE project_assets.started_at END,
      completed_at = CASE WHEN EXCLUDED.file_path IS NOT NULL THEN now() ELSE project_assets.completed_at END`;
    const nowISO = new Date().toISOString();
    const negative = cfg.negative ?? null;
    const videoModel = engine === "wan" ? WAN_MODEL : LTX_MODEL;
    const videoWorkflow = engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW;
    const relPath = (file) => (file ? `outputs/${vdir}/${file}` : null);
    let seeded = 0;
    for (let i = 0; i < seq.length; i++) {
      const b = seq[i] || {};
      const n = i + 1;
      const bv = (vm.beats && vm.beats[String(n)]) || {};
      const kf = bv.keyframeMain ?? null;
      const cl = bv.clipMain ?? null;
      if (kf) {
        await query(UPSERT_IG, [projectId, folder, version, n, n, b.title ?? null, "KEYFRAME",
          "COMPLETED", b.image ?? null, negative, relPath(kf), IMG_MODEL, IMG_WORKFLOW, 1,
          JSON.stringify({ engine, format: "vertical", video_type: "INSTAGRAM", file: kf, beat: n, ...diskFacts(vdir, kf) }), nowISO, nowISO]);
        seeded++;
      }
      if (cl) {
        await query(UPSERT_IG, [projectId, folder, version, n, n, b.title ?? null, "VIDEO",
          "COMPLETED", b.motion ?? null, negative, relPath(cl), videoModel, videoWorkflow, 1,
          JSON.stringify({ engine, format: "vertical", video_type: "INSTAGRAM", file: cl, beat: n, ...diskFacts(vdir, cl) }), nowISO, nowISO]);
        seeded++;
      }
    }
    const finals = [...(vm.final ?? [])].sort((a, b) => a.v - b.v);
    const fin = finals.length ? finals[finals.length - 1].file : null;
    if (fin) {
      const finalV = finalCutVersion(fin) ?? 1;
      await query(UPSERT_IG, [projectId, folder, version, 0, finalV, null, "FINAL",
        "COMPLETED", null, negative, relPath(fin), null, "ffmpeg-concat", 1,
        JSON.stringify({ engine, format: "vertical", video_type: "INSTAGRAM", file: fin, final_version: finalV, ...diskFacts(vdir, fin) }), nowISO, nowISO]);
      seeded++;
    }
    return seeded;
  } catch (e) {
    console.warn("[pg] instagram seed failed:", e.message);
    return 0;
  }
}
async function pgSaveProject(name, cfg, version, mains, outputFolder = null) {
  // Fail fast with a clear message instead of a cryptic
  // project_assets_version_check violation deep in the loop below.
  if (latestVersionOf(version) == null)
    throw new Error(`pgSaveProject: refusing phantom version ${JSON.stringify(version)} for ${name} (must be >= 1)`);
  // Asset rows carry the STORED immutable folder (a rename must not rewrite
  // history paths). outputFolder defaults to it when the caller passes none.
  const folderSlug = (await getFolderNameFromRow(name)) || folderName(name);
  const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
  const projectId = await pgEnsureProject(name, cfg);
  const folder = outputFolder ?? folderSlug;
  const engine = engineForFolder(folder);
  const videoModel = engine === "wan" ? WAN_MODEL : LTX_MODEL;
  const videoWorkflow = engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW;
  const videoFps = engine === "wan" ? 16 : 24;
  const videoDur = Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null;
  const negative = cfg.negative ?? null;
  const done = (file) => (file ? "COMPLETED" : "PENDING");
  // scene_id is the integer scene number from the AI breakdown: 0 for the
  // reference visual, N for beat N (its KEYFRAME + VIDEO rows share it).
  const sceneId = (beat) => beat;
  const relPath = (file) => (file ? `outputs/${folder}/${file}` : null);
  const UPSERT = `INSERT INTO project_assets (
    project_id, folder_name, version, scene_id, beat_index, beat_title,
    asset_type, video_type, status, prompt, negative_prompt, file_path,
    model, workflow, attempts, max_retries, metadata, started_at, completed_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, 'YOUTUBE', $8, $9, $10, $11, $12, $13, $14, 3, $15::jsonb,
    $16::timestamptz, $17::timestamptz
  )
  ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO UPDATE SET
    folder_name = EXCLUDED.folder_name,
    scene_id = EXCLUDED.scene_id, beat_title = EXCLUDED.beat_title,
    prompt = EXCLUDED.prompt, negative_prompt = EXCLUDED.negative_prompt,
    file_path = COALESCE(EXCLUDED.file_path, project_assets.file_path),
    model = EXCLUDED.model, workflow = EXCLUDED.workflow,
    attempts = GREATEST(project_assets.attempts, EXCLUDED.attempts),
    metadata = COALESCE(EXCLUDED.metadata, project_assets.metadata),
    status = CASE WHEN EXCLUDED.file_path IS NOT NULL THEN 'COMPLETED' ELSE project_assets.status END,
    started_at = CASE WHEN EXCLUDED.file_path IS NOT NULL AND project_assets.started_at IS NULL THEN now() ELSE project_assets.started_at END,
    completed_at = CASE WHEN EXCLUDED.file_path IS NOT NULL THEN now() ELSE project_assets.completed_at END`;
  const nowISO = new Date().toISOString();
  // No REFERENCE row here — reference visuals live in project_references
  // (one row per generation/upload, recorded on completion).
  for (let i = 0; i < seq.length; i++) {
    const b = seq[i] || {};
    const n = i + 1;
    const bm = (mains.beats && mains.beats[String(n)]) || {};
    const kf = bm.keyframeMain ?? null;
    const cl = bm.clipMain ?? null;
    const kfFacts = diskFacts(folder, kf);
    const clFacts = diskFacts(folder, cl);
    await pgPool.query(UPSERT, [projectId, folderSlug, version, sceneId(n), n, b.title ?? null,
      "KEYFRAME", done(kf), b.image ?? null, negative,
      relPath(kf), IMG_MODEL, IMG_WORKFLOW, kf ? 1 : 0,
      kf ? JSON.stringify({ engine, video_type: "YOUTUBE", file: kf, beat: n, ...kfFacts }) : null,
      kf ? nowISO : null, kf ? nowISO : null]);
    const img = cfg.image; // optional still from AI Craft
    if (img) {
      await pgPool.query(UPSERT, [projectId, folderSlug, version, sceneId(n), n, null,
        "IMAGE", done(img), cfg.imagePrompt ?? null, null, relPath(img),
        IMG_MODEL, IMG_WORKFLOW, img ? 1 : 0,
        img ? JSON.stringify({ engine, file: img }) : null,
        nowISO, nowISO]);
    }
    await pgPool.query(UPSERT, [projectId, folderSlug, version, sceneId(n), n, b.title ?? null,
      "VIDEO", done(cl), b.motion ?? null, negative,
      relPath(cl), videoModel, videoWorkflow, cl ? 1 : 0,
      cl ? JSON.stringify({ engine, video_type: "YOUTUBE", file: cl, beat: n, fps: videoFps, duration: videoDur, ...clFacts }) : null,
      cl ? nowISO : null, cl ? nowISO : null]);
  }
  // Stitched final cut (one row per stitch; beat_index = stitch version).
  if (mains.final) {
    const finalV = mains.finalV ?? finalCutVersion(mains.final) ?? 1;
    const ff = diskFacts(folder, mains.final);
    await pgPool.query(UPSERT, [projectId, folderSlug, version, 0, finalV, null,
      "FINAL", "COMPLETED", null, negative,
      relPath(mains.final), null, "ffmpeg-concat", 1,
      JSON.stringify({ engine, video_type: "YOUTUBE", file: mains.final, final_version: finalV, ...ff }),
      nowISO, nowISO]);
  }
  // Mirror any already-rendered vertical cut into INSTAGRAM rows (same beats).
  await pgSeedInstagramRows((t, p) => pgPool.query(t, p), projectId, folder, engine, cfg, version);
  return projectId;
}
// ---------------------------------------------------------------- delta versioning
// Delta-based save: version = logical revision, asset row = only the
// change generated at that revision. Unchanged scenes keep resolving to
// their previous rows via EFFECTIVE_ASSETS_SQL (latest row per
// (beat_index, asset_type) with version <= requested).
//
// Runs in ONE transaction: insert scenario_versions row, then insert ONLY
// PENDING rows for changed scenes (file_path NULL — generation fills them
// later via pgMarkAssetComplete, which never bumps the version). New delta
// rows never copy old file_paths, and unchanged beats get zero rows.
// Retries/status/progress updates never call this — only an actual
// prompt/scene change does.
async function pgSaveVersionDelta(name, prevCfg, cfg) {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const vRow = await client.query(
      `INSERT INTO scenario_versions (name, version, config)
       VALUES ($1, COALESCE((SELECT max(version) FROM scenario_versions WHERE name = $1), 0) + 1, $2::jsonb)
       RETURNING version`,
      [name, JSON.stringify(cfg)]);
    const version = vRow.rows[0].version;
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    // Immutable storage folder for every row/version written below — the
    // stored one when the project exists, else a freshly minted unique one.
    // Never recomputed from the (possibly renamed) display name per row.
    let folder;
    try {
      const fRow = await client.query("SELECT folder_name FROM projects WHERE name = $1", [name]);
      folder = fRow.rows[0]?.folder_name || null;
    } catch { folder = null; }
    folder ||= await ensureUniqueFolder(name, name);
    const proj = await client.query(
      `INSERT INTO projects (name, folder_name, description, duration, beats, master_prompt, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description,
         duration = EXCLUDED.duration, beats = EXCLUDED.beats,
         master_prompt = COALESCE(EXCLUDED.master_prompt, projects.master_prompt),
         updated_at = now()
       RETURNING project_id`,
      [name, folder, cfg.description ?? null,
        Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null, seq.length,
        cfg.referencePrompt ?? null]);
    const projectId = proj.rows[0]?.project_id;
    if (projectId == null) throw new Error(`pgSaveVersionDelta: no project_id for ${name}`);
    const previousVersion = Number(version) - 1;
    const plan = planDelta(prevCfg, cfg);
    const negative = cfg.negative ?? null;
    const INSERT = `INSERT INTO project_assets (
      project_id, folder_name, version, scene_id, beat_index, beat_title,
      asset_type, video_type, status, prompt, negative_prompt, file_path,
      model, workflow, attempts, max_retries, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, 'YOUTUBE', 'PENDING', $8, $9, NULL, $10, $11, 0, 3, $12::jsonb
    )
    ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO UPDATE SET
      folder_name = EXCLUDED.folder_name,
      scene_id = EXCLUDED.scene_id, beat_title = EXCLUDED.beat_title,
      prompt = EXCLUDED.prompt, negative_prompt = EXCLUDED.negative_prompt,
      model = EXCLUDED.model, workflow = EXCLUDED.workflow,
      metadata = COALESCE(EXCLUDED.metadata, project_assets.metadata)`;
    const insertedIds = [];
    const changedScenes = [];
    const changedAssetTypes = [];
    if (Number(version) === 1) {
      // v1 = full snapshot: every scene gets its row (with current main
      // files, as pgSaveProject does). Reference visuals are NOT snapshotted
      // here — they live in project_references (one row per generation).
      // `folder` is the transaction-resolved immutable storage folder above.
      const mains = mainsFor(folder, cfg);
      const engine = engineForFolder(folder);
    const full = async (sceneId, beat, title, type, prompt, model, workflow, file, meta) => {
      const r = await client.query(
        `${INSERT} RETURNING id`,
        [projectId, folder, version, sceneId, beat, title ?? null, type, prompt ?? null,
          negative, model, workflow,
          file ? JSON.stringify({ engine, file, version, ...meta }) : null]);
      insertedIds.push(r.rows[0].id);
        changedScenes.push(sceneId);
        changedAssetTypes.push(type);
        if (file) {
          const nowISO = new Date().toISOString();
          await client.query(
            `UPDATE project_assets SET file_path = $1, status = 'COMPLETED',
               attempts = 1, started_at = $2::timestamptz, completed_at = $2::timestamptz
             WHERE id = $3`,
            [`outputs/${folder}/${file}`, nowISO, r.rows[0].id]);
        }
      };
      for (let i = 0; i < seq.length; i++) {
        const b = seq[i] || {};
        const n = i + 1;
        const bm = (mains.beats && mains.beats[String(n)]) || {};
        const kf = bm.keyframeMain ?? null;
        const cl = bm.clipMain ?? null;
        await full(n, n, b.title ?? null, "KEYFRAME", b.image ?? null, IMG_MODEL, IMG_WORKFLOW,
          kf, { ...diskFacts(folder, kf), beat: n });
        await full(n, n, b.title ?? null, "VIDEO", b.motion ?? null,
          engine === "wan" ? WAN_MODEL : LTX_MODEL,
          engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW,
          cl, { ...diskFacts(folder, cl), beat: n });
      }
      // Stitched final cut (one row per stitch; beat_index = stitch version).
      if (mains.final) {
        const finalV = mains.finalV ?? finalCutVersion(mains.final) ?? 1;
        await full(0, finalV, null, "FINAL", null, null, "ffmpeg-concat",
          mains.final, { ...diskFacts(folder, mains.final), final_version: finalV });
      }
      // Mirror any already-rendered vertical cut into INSTAGRAM rows.
      await pgSeedInstagramRows((t, p) => client.query(t, p), projectId, folder, engine, cfg, version);
    } else {
      // v2+ = delta only: insert PENDING rows for changed scenes, nothing else.
      // Reference prompt changes do NOT create rows here — the next generated
      // or uploaded reference is recorded in project_references instead.
      // `folder` is the transaction-resolved immutable storage folder above.
      const engine = engineForFolder(folder);
      for (const [beatStr, types] of Object.entries(plan.beats)) {
        const n = Number(beatStr);
        const b = seq[n - 1] || {};
        for (const type of types) {
          const prompt = type === "KEYFRAME" ? (b.image ?? null) : (b.motion ?? null);
          const model = type === "KEYFRAME" ? IMG_MODEL : (engine === "wan" ? WAN_MODEL : LTX_MODEL);
          const workflow = type === "KEYFRAME" ? IMG_WORKFLOW : (engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW);
    const r = await client.query(
      `${INSERT} RETURNING id`,
      [projectId, folder, version, n, n, b.title ?? null, type, prompt,
        negative, model, workflow, JSON.stringify({ engine, beat: n })]);
          insertedIds.push(r.rows[0].id);
          changedScenes.push(n);
          changedAssetTypes.push(type);
        }
      }
    }
    await client.query("COMMIT");
    console.log(`[version] ${JSON.stringify({
      project: name, projectId, previousVersion, newVersion: version,
      changedScenes, changedAssetTypes, insertedAssetIds: insertedIds,
    })}`);
    return { version, projectId, changedScenes, changedAssetTypes, insertedIds };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  } finally {
    client.release();
  }
}
// ---------------------------------------------------------------- in-place save
// Save Scenario updates the CURRENT project in place: the scenarios row, the
// prompts JSON, the projects row and the LATEST scenario_versions config are
// overwritten, and only the changed scenes' project_assets rows AT THAT SAME
// version are upserted (prompt columns refreshed, file linkage reset to
// PENDING so the next run regenerates them). No new version row and no new
// project row are ever created here — v1 (full snapshot via
// pgSaveVersionDelta) is the only version-creating save. History readers
// (EFFECTIVE_ASSETS_SQL, per-scene pills) keep working: they simply resolve
// against a version count that no longer grows on save.
async function pgSaveVersionInPlace(name, latestVersion, prevCfg, cfg) {
  // Total guard: latestVersion must be a real existing version (>= 1). A
  // phantom 0/NaN (e.g. max(version) over zero rows — Number(null) is 0)
  // would violate project_assets_version_check on the first asset INSERT.
  // Fall back to the delta path, which mints the correct next version
  // (COALESCE(max, 0) + 1 = 1 when empty). Checked before BEGIN so no
  // transaction is opened for the delegated save.
  if (latestVersionOf(latestVersion) == null) {
    const saved = await pgSaveVersionDelta(name, prevCfg, cfg);
    return { ...saved, updated: true };
  }
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const version = Number(latestVersion);
    // Overwrite the latest prompt config (never a new row).
    await client.query(
      "UPDATE scenario_versions SET config = $2::jsonb WHERE name = $1 AND version = $3",
      [name, JSON.stringify(cfg), version]);
    // Immutable storage folder (same rule as the delta path).
    let folder;
    try {
      const fRow = await client.query("SELECT folder_name FROM projects WHERE name = $1", [name]);
      folder = fRow.rows[0]?.folder_name || null;
    } catch { folder = null; }
    folder ||= await ensureUniqueFolder(name, name);
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    const proj = await client.query(
      `INSERT INTO projects (name, folder_name, description, duration, beats, master_prompt, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description,
         duration = EXCLUDED.duration, beats = EXCLUDED.beats,
         master_prompt = COALESCE(EXCLUDED.master_prompt, projects.master_prompt),
         updated_at = now()
       RETURNING project_id`,
      [name, folder, cfg.description ?? null,
        Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null, seq.length,
        cfg.referencePrompt ?? null]);
    const projectId = proj.rows[0]?.project_id;
    if (projectId == null) throw new Error(`pgSaveVersionInPlace: no project_id for ${name}`);
    // Refresh ONLY changed scenes at the same version (delta plan, same
    // per-type granularity as the old versioned path). Unchanged scenes are
    // untouched; removed beats produce no rows; added beats are inserted.
    // Reference prompt changes create no rows (project_references owns them).
    const plan = planDelta(prevCfg, cfg);
    const engine = engineForFolder(folder);
    const negative = cfg.negative ?? null;
    const UPSERT = `INSERT INTO project_assets (
      project_id, folder_name, version, scene_id, beat_index, beat_title,
      asset_type, video_type, status, prompt, negative_prompt, file_path,
      model, workflow, attempts, max_retries, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, 'YOUTUBE', 'PENDING', $8, $9, NULL, $10, $11, 0, 3, $12::jsonb
    )
    ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO UPDATE SET
      folder_name = EXCLUDED.folder_name,
      scene_id = EXCLUDED.scene_id, beat_title = EXCLUDED.beat_title,
      prompt = EXCLUDED.prompt, negative_prompt = EXCLUDED.negative_prompt,
      model = EXCLUDED.model, workflow = EXCLUDED.workflow,
      status = 'PENDING', file_path = NULL, error_message = NULL,
      started_at = NULL, completed_at = NULL,
      metadata = EXCLUDED.metadata`;
    const changedScenes = [];
    const changedAssetTypes = [];
    for (const [beatStr, types] of Object.entries(plan.beats)) {
      const n = Number(beatStr);
      const b = seq[n - 1] || {};
      for (const type of types) {
        const prompt = type === "KEYFRAME" ? (b.image ?? null) : (b.motion ?? null);
        const model = type === "KEYFRAME" ? IMG_MODEL : (engine === "wan" ? WAN_MODEL : LTX_MODEL);
        const workflow = type === "KEYFRAME" ? IMG_WORKFLOW : (engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW);
        await client.query(UPSERT,
          [projectId, folder, version, n, n, b.title ?? null, type, prompt,
            negative, model, workflow, JSON.stringify({ engine, beat: n })]);
        changedScenes.push(n);
        changedAssetTypes.push(type);
      }
    }
    await client.query("COMMIT");
    console.log(`[save] ${JSON.stringify({
      project: name, projectId, version, updated: true,
      changedScenes, changedAssetTypes,
    })}`);
    return { version, projectId, changedScenes, changedAssetTypes, updated: true };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  } finally {
    client.release();
  }
}
// ---------------------------------------------------------------- project_references
// Reference visuals (master-prompt images) live here — one row per
// generation or upload, since a project accumulates MANY master prompts and
// reference images over time. project_assets carries no REFERENCE rows.
// is_main marks the record selected as main on the UI (one per project +
// output dir, enforced by a partial unique index); pinned marks a deliberate
// user pick (manual select / upload) that keeps winning over later auto
// generations (mirrors the state.json pin semantics the pipeline reads).
// Parse "V2" out of "<prefix>_ref_v2.png" (v1 = no suffix), else 1.
const refVersionOf = (file) => {
  const m = String(file || "").match(/_v(\d+)\.png$/i);
  return m ? Number(m[1]) : 1;
};
// Reference rows for one project dir, oldest first: [{ id, file, v, prompt,
// source, is_main, pinned, model, created_at }].
async function pgReferenceList(projectId, dir) {
  const r = await pgPool.query(
    `SELECT id, prompt, file_path, metadata, source, video_type, is_main, pinned, model,
            version, created_at
     FROM project_references WHERE project_id = $1 AND output_dir = $2
     ORDER BY created_at ASC, id ASC`,
    [projectId, dir]);
  return r.rows.map((x) => ({
    id: Number(x.id),
    file: x.metadata?.file ?? String(x.file_path || "").split("/").pop() ?? null,
    v: refVersionOf(x.metadata?.file ?? x.file_path),
    prompt: x.prompt ?? null,
    source: x.source,
    video_type: x.video_type ?? null,
    is_main: !!x.is_main,
    pinned: !!x.pinned,
    model: x.model ?? null,
    version: x.version ?? null,
    created_at: x.created_at ? new Date(x.created_at).toISOString() : null,
  })).filter((x) => x.file);
}
// Record a finished reference generation (or upload) as a NEW row and make
// it the dir's main — unless a pinned pick already holds main (pins survive
// auto generations). Uploads/selects pass pinned=true and always take main.
async function pgAddReference({ projectId, dir, file, prompt, engine, source = "generated" }) {
  const filePath = `outputs/${dir}/${file}`;
  const facts = diskFacts(dir, file);
  const nowISO = new Date().toISOString();
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const ver = await client.query(
      "SELECT max(version) AS v FROM scenario_versions WHERE name = (SELECT name FROM projects WHERE project_id = $1)",
      [projectId]);
    const version = ver.rows[0]?.v ?? null;
    const pin = await client.query(
      `SELECT id FROM project_references
       WHERE project_id = $1 AND output_dir = $2 AND pinned LIMIT 1`,
      [projectId, dir]);
    const takeMain = source !== "generated" || pin.rowCount === 0;
    if (takeMain) {
      await client.query(
        `UPDATE project_references SET is_main = FALSE, pinned = CASE WHEN $3 THEN FALSE ELSE pinned END
         WHERE project_id = $1 AND output_dir = $2`,
        [projectId, dir, source !== "generated"]);
    }
    const ins = await client.query(
      `INSERT INTO project_references (
         project_id, output_dir, version, prompt, file_path,
         model, workflow, attempts, source, video_type, is_main, pinned, metadata,
         started_at, completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, $12::jsonb, $13::timestamptz, $13::timestamptz)
       RETURNING id`,
      [projectId, dir, version, prompt ?? null, filePath, REF_MODEL, REF_WORKFLOW,
        source, /_vertical$/.test(dir) ? "INSTAGRAM" : "YOUTUBE", takeMain, source !== "generated",
        JSON.stringify({ engine, file, ...facts }), nowISO]);
    await client.query("COMMIT");
    return ins.rows[0].id;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  } finally {
    client.release();
  }
}
// UI "set as main" for a reference file: flip is_main (+pinned, it's a
// deliberate pick) onto its row, clearing the dir scope. Unknown files
// (legacy, recorded nowhere) are inserted first so the pick sticks.
async function pgSetReferenceMain({ projectId, dir, file, prompt, engine }) {
  const filePath = `outputs/${dir}/${file}`;
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const hit = await client.query(
      `SELECT id FROM project_references
       WHERE project_id = $1 AND output_dir = $2
         AND (file_path = $3 OR metadata->>'file' = $4) LIMIT 1`,
      [projectId, dir, filePath, file]);
    await client.query(
      "UPDATE project_references SET is_main = FALSE, pinned = FALSE WHERE project_id = $1 AND output_dir = $2",
      [projectId, dir]);
    if (hit.rowCount) {
      await client.query(
        "UPDATE project_references SET is_main = TRUE, pinned = TRUE, updated_at = now() WHERE id = $1",
        [hit.rows[0].id]);
    } else {
      const facts = diskFacts(dir, file);
      const nowISO = new Date().toISOString();
      const ver = await client.query(
        "SELECT max(version) AS v FROM scenario_versions WHERE name = (SELECT name FROM projects WHERE project_id = $1)",
        [projectId]);
      await client.query(
        `INSERT INTO project_references (
           project_id, output_dir, version, prompt, file_path,
           model, workflow, attempts, source, video_type, is_main, pinned, metadata,
           started_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'generated', $8, TRUE, TRUE, $9::jsonb, $10::timestamptz, $10::timestamptz)`,
        [projectId, dir, ver.rows[0]?.v ?? null, prompt ?? null, filePath,
          REF_MODEL, REF_WORKFLOW, /_vertical$/.test(dir) ? "INSTAGRAM" : "YOUTUBE",
          JSON.stringify({ engine, file, ...facts }), nowISO]);
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  } finally {
    client.release();
  }
}
// Backfill the references table from on-disk ref mains (one row per dir).
// Skips projects that already have rows — never duplicates.
async function pgBackfillReferences(name, folder, cfg) {
  if (!pgUp) return;
  try {
    const pid = await pgProjectId(name);
    if (pid == null) return;
    const has = await pgPool.query(
      "SELECT 1 FROM project_references WHERE project_id = $1 LIMIT 1", [pid]);
    if (has.rowCount) return;
    const v = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
    const version = v.rows[0]?.v ?? null;
    for (const suffix of ["", "_wan", "_vertical", "_wan_vertical"]) {
      const dir = folder + suffix;
      const full = path.join(OUTPUTS, dir);
      if (!fs.existsSync(full)) continue;
      try {
        const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
        const vm = versionMap(full, prefixForDir(dir), seq);
        if (!vm.refMain) continue;
        const filePath = `outputs/${dir}/${vm.refMain}`;
        const dup = await pgPool.query(
          "SELECT 1 FROM project_references WHERE project_id = $1 AND file_path = $2 LIMIT 1",
          [pid, filePath]);
        if (dup.rowCount) continue;
        const facts = diskFacts(dir, vm.refMain);
        const nowISO = new Date().toISOString();
        await pgPool.query(
          `INSERT INTO project_references (
             project_id, output_dir, version, prompt, file_path,
             model, workflow, attempts, source, video_type, is_main, pinned, metadata,
             started_at, completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'generated', $8, TRUE, $9, $10::jsonb, $11::timestamptz, $11::timestamptz)`,
          [pid, dir, version, cfg?.referencePrompt ?? null, filePath,
            REF_MODEL, REF_WORKFLOW, /_vertical$/.test(dir) ? "INSTAGRAM" : "YOUTUBE", !!vm.refPinned,
            JSON.stringify({ engine: engineForDir(dir), file: vm.refMain, ...facts }), nowISO]);
      } catch (e) { console.warn(`[pg] reference backfill failed for ${dir}:`, e.message); }
    }
  } catch (e) { console.warn("[pg] reference backfill failed:", e.message); }
}
// Mark ONE asset row COMPLETED the moment its file finishes generating
// (called per [asset] event, so rows flip one by one).
// RETRY SAFE: a failed generation retried via --regen only re-runs the
// single asset and UPDATEs its existing row here — it never inserts a new
// project version (versions are created only by pgSaveVersionDelta on an
// actual prompt/scene change). Status/progress/error updates likewise stay
// on the same row.
// asset: { file, stage: 'reference'|'keyframe'|'clip'|'final', index? }
// Stage -> (asset_type, beat_index): keyframe -> (KEYFRAME, N),
// clip -> (VIDEO, N), final -> (FINAL, V) where V is the 1-based stitch
// version — every stitch INSERTs a new FINAL row. Reference visuals skip
// project_assets entirely (they live in project_references, one row per
// generation — see the reference branch below).
// UPDATE first; when the row does not exist yet (e.g. never saved), INSERT
// it as COMPLETED.
async function pgMarkAssetComplete(projectName, asset, opts = {}) {
  if (!pgUp) return;
  try {
    const projectId = await pgProjectId(projectName);
    if (projectId == null) return; // project row not saved yet
    const v = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [projectName]);
    const version = v.rows[0]?.v;
    if (!version) return; // never saved — rows are created on the next Save
    const engine = opts.engine || "ltx";
    const format = normalizeFormat(opts.format);
    // Folder-based storage (immutable); callers pass the run's outputFolder
    // explicitly — this fallback only serves direct callers.
    const outputFolder = opts.outputFolder || outDirName(await folderFor(projectName), engine, format);
    // Reference completion -> project_references (never project_assets).
    // Each generation is a NEW row carrying its own master prompt; it takes
    // main unless a pinned pick already holds it. Vertical cuts record into
    // their own dir scope so the landscape main stays canonical.
    if (asset.stage === "reference") {
      let prompt = null;
      try {
        const raw = await dbGetScenario(projectName);
        prompt = raw ? JSON.parse(raw).referencePrompt ?? null : null;
      } catch { prompt = null; }
      await pgAddReference({
        projectId, dir: outputFolder, file: asset.file, prompt, engine, source: "generated",
      });
      return;
    }
    const facts = diskFacts(outputFolder, asset.file);
    const filePath = `outputs/${outputFolder}/${asset.file}`;
    let target = null;
    if (asset.stage === "keyframe") {
      const beat = asset.index ?? 0;
      target = { type: "KEYFRAME", beat, model: IMG_MODEL, workflow: IMG_WORKFLOW,
        meta: { engine, file: asset.file, beat, ...facts } };
    } else if (asset.stage === "clip") {
      const beat = asset.index ?? 0;
      target = { type: "VIDEO", beat, model: engine === "wan" ? WAN_MODEL : LTX_MODEL,
        workflow: engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW,
        meta: { engine, file: asset.file, beat, ...facts } };
    } else if (asset.stage === "final") {
      // Stitched final cut: one NEW row per stitch (beat_index = 1-based
      // stitch version parsed from the filename), same COMPLETED/file_path/
      // attempts/metadata mechanics as every other asset.
      const finalV = finalCutVersion(asset.file) ?? 1;
      target = { type: "FINAL", beat: finalV, scene: 0, model: null, workflow: "ffmpeg-concat",
        meta: { engine, file: asset.file, final_version: finalV, ...facts } };
    } else {
      return;
    }
    const sceneId = target.scene ?? target.beat;
    // Cut dimension: landscape runs record YOUTUBE rows, vertical (Instagram
    // Reel) runs record INSTAGRAM rows — both cuts keep a full per-scene set
    // under the wider unique key (project, version, type, beat, video_type).
    // file_path already points at the run's own output dir (outputFolder).
    const videoType = format === "vertical" ? "INSTAGRAM" : "YOUTUBE";
    target.meta.video_type = videoType;
    const upd = await pgPool.query(
      `UPDATE project_assets SET file_path = $1, status = 'COMPLETED', error_message = NULL,
         attempts = attempts + 1,
         model = COALESCE(model, $5), workflow = COALESCE(workflow, $6),
         metadata = COALESCE(metadata, $7::jsonb),
         started_at = COALESCE(started_at, now()), completed_at = now()
       WHERE project_id = $2 AND version = $3 AND asset_type = $4 AND beat_index = $8 AND video_type = $9`,
      [filePath, projectId, version, target.type, target.model, target.workflow,
       JSON.stringify(target.meta), target.beat, videoType]);
    if (upd.rowCount === 0) {
      await pgPool.query(
        `INSERT INTO project_assets (
           project_id, version, scene_id, beat_index, asset_type, video_type, status,
           file_path, model, workflow, attempts, metadata, started_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', $7, $8, $9, 1, $10::jsonb, now(), now())
         ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO UPDATE SET
           file_path = EXCLUDED.file_path, status = 'COMPLETED', error_message = NULL,
           attempts = project_assets.attempts + 1, completed_at = now()`,
        [projectId, version, sceneId, target.beat, target.type, videoType, filePath,
         target.model, target.workflow, JSON.stringify(target.meta)]);
    }
  } catch (e) { console.warn("[pg] mark complete failed:", e.message); }
}
// Refresh the current version's project_assets file names from the output
// dir's main versions (called after every generation + on run exit, so the
// table always lists the actual image/video files on disk).
// Delta-safe: UPDATE ONLY rows that already exist in the current version.
// Never inserts missing rows — otherwise a refresh would backfill unchanged
// scenes into the new version and destroy delta versioning. Single-asset
// completion (pgMarkAssetComplete) is what fills a row's file_path.
async function pgRefreshProjectFiles(projectName, outputFolder) {
  if (!pgUp) return;
  try {
    const raw = await dbGetScenario(projectName);
    if (raw === null) return;
    const cfg = JSON.parse(raw);
    const v = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [projectName]);
    const version = v.rows[0]?.v;
    if (!version) return; // never saved — files are recorded on the next Save
    const pid = await pgProjectId(projectName);
    if (pid == null) return;
    // Refresh only the cut being refreshed: a vertical dir touches INSTAGRAM
    // rows, anything else the YOUTUBE rows — never cross-write the other cut.
    const videoType = /_vertical$/.test(outputFolder || "") ? "INSTAGRAM" : "YOUTUBE";
    const mains = mainsFor(outputFolder, cfg);
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    const existing = await pgPool.query(
      "SELECT asset_type, beat_index FROM project_assets WHERE project_id = $1 AND version = $2 AND video_type = $3",
      [pid, Number(version), videoType]);
    const has = new Set(existing.rows.map((r) => `${r.asset_type}:${r.beat_index}`));
    const relPath = (file) => (file ? `outputs/${outputFolder}/${file}` : null);
    const touch = async (type, beat, file) => {
      if (!file || !has.has(`${type}:${beat}`)) return; // delta: no backfill
      await pgPool.query(
        `UPDATE project_assets SET file_path = COALESCE(file_path, $1),
           status = CASE WHEN file_path IS NOT NULL OR $1 IS NOT NULL THEN 'COMPLETED' ELSE status END,
           completed_at = CASE WHEN file_path IS NOT NULL OR $1 IS NOT NULL THEN COALESCE(completed_at, now()) ELSE completed_at END
         WHERE project_id = $2 AND version = $3 AND asset_type = $4 AND beat_index = $5 AND video_type = $6`,
        [relPath(file), pid, Number(version), type, beat, videoType]);
    };
    // Reference mains are NOT refreshed here — project_references is the
    // record (appended on generation/upload, flipped on UI select).
    for (let i = 0; i < seq.length; i++) {
      const n = i + 1;
      const bm = (mains.beats && mains.beats[String(n)]) || {};
      await touch("KEYFRAME", n, bm.keyframeMain ?? null);
      await touch("VIDEO", n, bm.clipMain ?? null);
    }
    // Latest stitched final cut (update-only, like everything else here —
    // the row itself is created by pgMarkAssetComplete on each stitch).
    if (mains.final) {
      await touch("FINAL", mains.finalV ?? finalCutVersion(mains.final) ?? 1, mains.final);
    }
  } catch (e) { console.warn("[pg] project files refresh failed:", e.message); }
}
// Storage slug for a project display name (single source of truth lives in
// lib/variant.mjs — server, scripts and lib share the exact same rule).
// Immutable after project creation — never updated on edits/renames, so
// output dirs, filenames and DB paths stay stable and media keeps resolving.
const folderName = folderSlug;

// Get existing folder_name from the database row for a given project.
const getFolderNameFromRow = async (name) => {
  if (!pgUp) return null;
  const r = await pgPool.query("SELECT folder_name FROM projects WHERE name = $1", [name]);
  return r.rows[0]?.folder_name ?? null;
};

  // Storage folder for a project display name: the stored immutable
  // folder_name when the project row exists, else the slug of the name
  // (legacy rows / PG-down fallback). Never contains spaces.

const folderFor = async (name) =>
  (await getFolderNameFromRow(name)) || folderName(name);

// Storage folder guaranteed unique across projects AND existing output dirs
// ("my_video", "my_video_2", ...). excludeName skips the caller's own row
// (edits must keep their folder, never mint a new one).
async function ensureUniqueFolder(base, excludeName = null) {
  let candidate = folderName(base);
  for (let i = 2; ; i++) {
    let taken = false;
    if (pgUp) {
      try {
        const r = await pgPool.query(
          "SELECT 1 FROM projects WHERE folder_name = $1 AND name <> $2 LIMIT 1",
          [candidate, excludeName]);
        taken = r.rowCount > 0;
      } catch { /* treat as free — insert path re-checks */ }
    }
    if (!taken && allDirsFor(candidate).some((d) => fs.existsSync(path.join(OUTPUTS, d)))) {
      // A stray output dir (deleted project, CLI run) already owns it.
      // Own dirs of the caller's previous folder don't count — but the
      // caller passes a NEW base here, so any hit means taken.
      taken = true;
    }
    if (!taken) return candidate;
    candidate = `${folderName(base).slice(0, 97)}_${i}`;
  }
}

// Split an output dir into its storage-folder base + engine/format suffix.
const splitDirSuffix = (dir) => {
  let base = String(dir || ""), suffix = "";
  if (base.endsWith("_vertical")) { base = base.slice(0, -"_vertical".length); suffix = "_vertical"; }
  if (base.endsWith("_wan")) { base = base.slice(0, -"_wan".length); suffix = "_wan" + suffix; }
  return { base, suffix };
};

// Translate any output dir (folder- OR legacy display-name-based) to its
// canonical storage dir. Falls back to the input when the folder is unknown
// or the canonical dir doesn't exist yet but the given one does (legacy).
async function storageDirFor(dir) {
  const { base, suffix } = splitDirSuffix(dir);
  if (!base) return dir;
  let folder = null;
  if (pgUp) {
    try {
      // Base may already BE the folder, or a display name with a stored folder.
      const hit = await pgPool.query(
        "SELECT folder_name FROM projects WHERE folder_name = $1 OR name = $1 LIMIT 1", [base]);
      folder = hit.rows[0]?.folder_name ?? null;
    } catch { folder = null; }
  }
  folder ||= folderName(base);
  const canonical = folder + suffix;
  if (canonical === dir) return dir;
  if (fs.existsSync(path.join(OUTPUTS, canonical))) return canonical;
  if (fs.existsSync(path.join(OUTPUTS, dir))) return dir; // legacy dir still on disk
  return canonical; // canonical going forward (migration creates it on demand)
}

// Display name that owns a storage folder base (reverse of folderFor).
// Falls back to the base itself for legacy/unknown folders.
async function displayNameForFolder(folderBase) {
  if (pgUp) {
    try {
      const r = await pgPool.query("SELECT name FROM projects WHERE folder_name = $1 LIMIT 1", [folderBase]);
      if (r.rows[0]?.name) return r.rows[0].name;
    } catch { /* fall through */ }
  }
  return folderBase;
}

async function pgInit() {
  if (!(await pgProbe())) return;
  try {
    await pgPool.query(PG_SCHEMA);
    // Legacy `assets` catalog is retired (project_assets + project_references
    // + disk are canonical) — drop it on existing installs.
    await pgPool.query(`DROP TABLE IF EXISTS public.assets`);
    await pgPool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_id SERIAL UNIQUE`);
    await pgPool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS folder_name TEXT`);
    await pgPool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS master_prompt TEXT`);
    // Backfill folder_name for existing projects that don't have one.
    await pgPool.query(
      `UPDATE projects SET folder_name = substr(regexp_replace(regexp_replace(lower(name), '[^a-z0-9]+', '_', 'g'), '^_+|_+$', ''), 1, 100) WHERE folder_name IS NULL OR folder_name = ''`);
    // References moved to project_references: drop legacy REFERENCE rows
    // (superseded by the per-dir mains backfilled into the new table below).
    try {
      const del = await pgPool.query("DELETE FROM project_assets WHERE asset_type = 'REFERENCE'");
      if (del.rowCount) console.log(`[pg] removed ${del.rowCount} legacy REFERENCE project_assets rows`);
    } catch (e) { console.warn("[pg] reference rows cleanup failed:", e.message); }
    // --- narrow project_assets schema: ensure every column/index exists ---
    // Fresh installs get the exact DDL from PG_SCHEMA above; a pre-existing
    // table (created from the same DDL by hand) gains any missing narrow
    // columns here. The old WIDE table (kind/reference_*/image_*/video_*)
    // is NOT migrated — drop it once (DROP TABLE public.project_assets;)
    // and let boot recreate it.
    const NARROW_COLS = [
      `project_id INTEGER NOT NULL`,
      `folder_name TEXT`,
      `version INTEGER NOT NULL DEFAULT 1`,
      `scene_id INTEGER`,
      `beat_index INTEGER NOT NULL DEFAULT 0`,
      `beat_title TEXT`,
      `asset_type TEXT NOT NULL`,
      `video_type TEXT NOT NULL DEFAULT 'YOUTUBE'`,
      `status TEXT NOT NULL DEFAULT 'PENDING'`,
      `prompt TEXT`,
      `negative_prompt TEXT`,
      `file_path TEXT`,
      `model TEXT`,
      `workflow TEXT`,
      `seed BIGINT`,
      `attempts INTEGER NOT NULL DEFAULT 0`,
      `max_retries INTEGER NOT NULL DEFAULT 3`,
      `error_message TEXT`,
      `metadata JSONB`,
      `started_at TIMESTAMPTZ`,
      `completed_at TIMESTAMPTZ`,
      `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    ];
    for (const def of NARROW_COLS) {
      const col = def.split(" ")[0];
      try { await pgPool.query(`ALTER TABLE project_assets ADD COLUMN IF NOT EXISTS ${col} ${def.slice(col.length + 1)}`); }
      catch (e) { console.warn(`[pg] add column ${col} failed:`, e.message); }
    }
    // Migrate a TEXT-typed scene_id (previous revision) to INTEGER. Old
    // string values ("<name>:v<version>:ref|beatN:<type>") carry no numeric
    // meaning, so fall back to beat_index (= the scene number); pure-numeric
    // strings cast straight through.
    try {
      const t = await pgPool.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'project_assets' AND column_name = 'scene_id'`);
      if ((t.rows[0]?.data_type || "").toLowerCase() !== "integer") {
        await pgPool.query(
          `UPDATE project_assets SET scene_id = beat_index::text
            WHERE scene_id IS NULL OR scene_id !~ '^[0-9]+$'`);
        await pgPool.query(
          `ALTER TABLE project_assets ALTER COLUMN scene_id TYPE INTEGER USING scene_id::integer`);
      }
    } catch (e) { console.warn("[pg] scene_id type migration failed:", e.message); }
    // Widen the asset_type CHECK to admit 'FINAL' (stitched final-cut rows).
    // Drops any pre-existing asset_type CHECK (whatever its constraint name)
    // and re-adds the canonical one — fresh installs already get it from
    // PG_SCHEMA above.
    try {
      const cons = await pgPool.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'public.project_assets'::regclass AND contype = 'c'`);
      for (const r of cons.rows) {
        const defR = await pgPool.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'public.project_assets'::regclass AND conname = $1`, [r.conname]);
        if (/asset_type/i.test(defR.rows[0]?.def || "")) {
          await pgPool.query(`ALTER TABLE project_assets DROP CONSTRAINT "${String(r.conname).replace(/"/g, '""')}"`);
        }
      }
      await pgPool.query(`ALTER TABLE project_assets DROP CONSTRAINT IF EXISTS project_assets_asset_type_check`);
      await pgPool.query(`ALTER TABLE project_assets ADD CONSTRAINT project_assets_asset_type_check
        CHECK (asset_type IN ('REFERENCE', 'IMAGE', 'KEYFRAME', 'VIDEO', 'FINAL'))`);
    } catch (e) { console.warn("[pg] asset_type check migration failed:", e.message); }
    // video_type cut dimension: fresh installs get the 5-column UNIQUE key
    // from PG_SCHEMA above; pre-existing installs carry the 4-column index
    // under the same name — drop it first so the recreate below actually
    // takes effect (otherwise INSTAGRAM rows would collide with YOUTUBE rows).
    // ADD COLUMN DEFAULT 'YOUTUBE' already stamped every existing row, so the
    // wider key stays duplicate-free.
    try {
      await pgPool.query(`ALTER TABLE project_assets DROP CONSTRAINT IF EXISTS project_assets_video_type_check`);
      await pgPool.query(`ALTER TABLE project_assets ADD CONSTRAINT project_assets_video_type_check
        CHECK (video_type IN ('YOUTUBE', 'INSTAGRAM'))`);
    } catch (e) { console.warn("[pg] video_type check migration failed:", e.message); }
    try {
      await pgPool.query(`DROP INDEX IF EXISTS project_assets_project_version_type_beat_key`);
      await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS project_assets_project_version_type_beat_key
        ON public.project_assets(project_id, version, asset_type, beat_index, video_type)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_project_id ON public.project_assets(project_id)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_scene_id ON public.project_assets(scene_id)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_project_version_beat ON public.project_assets(project_id, version, beat_index)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_asset_type ON public.project_assets(asset_type)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_status ON public.project_assets(project_id, status)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_project_assets_metadata ON public.project_assets USING GIN (metadata)`);
    } catch (e) { console.warn("[pg] project_assets index ensure failed:", e.message); }
    try {
      await pgPool.query(
        `UPDATE projects SET project_id = nextval(pg_get_serial_sequence('projects', 'project_id'))
         WHERE project_id IS NULL`);
    } catch (e) { console.warn("[pg] projects id backfill failed:", e.message); }
    // Retired brief fields: Song/Topic + Lyrics/Requirements no longer exist
    // in the UI or the Scenario model. Drop the columns and strip the keys
    // from every stored config so no stale data lingers.
    try {
      await pgPool.query(`ALTER TABLE projects DROP COLUMN IF EXISTS topic`);
      await pgPool.query(`ALTER TABLE projects DROP COLUMN IF EXISTS requirements`);
    } catch (e) { console.warn("[pg] projects topic/requirements drop failed:", e.message); }
    try {
      await pgPool.query(`UPDATE scenarios SET config = (config - 'topic' - 'requirements') WHERE config ?| ARRAY['topic','requirements']`);
      await pgPool.query(`UPDATE scenario_versions SET config = (config - 'topic' - 'requirements') WHERE config ?| ARRAY['topic','requirements']`);
    } catch (e) { console.warn("[pg] scenario topic/requirements strip failed:", e.message); }
    // Materialize INSTAGRAM rows for vertical files previously recorded only
    // inside landscape-row metadata (format='vertical' + vertical_file): one
    // INSTAGRAM row per (project, version, type, beat) so both cuts keep all
    // scenes. Idempotent (unique key + DO NOTHING).
    try {
      const vr = await pgPool.query(
        `SELECT project_id, folder_name, version, scene_id, beat_index, beat_title,
                asset_type, status, prompt, negative_prompt, model, workflow,
                attempts, error_message, metadata, started_at, completed_at,
                metadata->>'engine' AS eng, metadata->>'vertical_file' AS vfile
           FROM project_assets
          WHERE metadata->>'format' = 'vertical' AND metadata->>'vertical_file' IS NOT NULL`);
      let seeded = 0;
      for (const r of vr.rows) {
        if (!r.folder_name || !r.vfile) continue;
        const vdir = outDirName(r.folder_name, r.eng || "ltx", "vertical");
        const meta = { ...(r.metadata || {}), video_type: "INSTAGRAM" };
        const ins = await pgPool.query(
          `INSERT INTO project_assets (
             project_id, folder_name, version, scene_id, beat_index, beat_title,
             asset_type, video_type, status, prompt, negative_prompt, file_path,
             model, workflow, attempts, max_retries, error_message, metadata,
             started_at, completed_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,'INSTAGRAM',$8,$9,$10,$11,$12,$13,$14,3,$15,$16::jsonb,$17,$18
           )
           ON CONFLICT (project_id, version, asset_type, beat_index, video_type) DO NOTHING`,
          [r.project_id, r.folder_name, r.version, r.scene_id, r.beat_index, r.beat_title,
           r.asset_type, r.status, r.prompt, r.negative_prompt,
           `outputs/${vdir}/${r.vfile}`, r.model, r.workflow, r.attempts ?? 0,
           r.error_message, JSON.stringify(meta), r.started_at, r.completed_at]);
        if (ins.rowCount) seeded++;
      }
      if (seeded) console.log(`[pg] seeded ${seeded} INSTAGRAM asset rows from vertical metadata`);
    } catch (e) { console.warn("[pg] instagram backfill failed:", e.message); }
    // video_type on project_references (cut dimension for the reference
    // catalog, derived from the output dir — vertical dirs are INSTAGRAM).
    // No data loss: plain ADD COLUMN + UPDATE, never DROP TABLE.
    try {
      await pgPool.query(`ALTER TABLE project_references ADD COLUMN IF NOT EXISTS video_type TEXT NOT NULL DEFAULT 'YOUTUBE'`);
      await pgPool.query(`ALTER TABLE project_references DROP CONSTRAINT IF EXISTS project_references_video_type_check`);
      await pgPool.query(`ALTER TABLE project_references ADD CONSTRAINT project_references_video_type_check
        CHECK (video_type IN ('YOUTUBE', 'INSTAGRAM'))`);
      await pgPool.query(
        `UPDATE project_references SET video_type = CASE WHEN output_dir LIKE '%_vertical' THEN 'INSTAGRAM' ELSE 'YOUTUBE' END`);
    } catch (e) { console.warn("[pg] references video_type migration failed:", e.message); }
    await syncAllToPg();
  } catch (e) { console.warn("[pg] init failed:", e.message); }
}
pgInit();

const DIST = path.join(__dirname, "dist");
const PORT = Number(process.env.PORT || 8790);
const LLM_BASE = (process.env.LLM_BASE || "https://furian-1.tailb2c0b0.ts.net").replace(/\/+$/, "");

// ---------------------------------------------------------------- resources
// User-uploaded images/videos library (the Resource page). Files live in
// resources/ (gitignored); resources/meta.json is the sidecar index so the
// library works with or without Postgres. Each entry carries an AI prompt:
// auto-captioned on upload when a vision model is loaded in the local LLM
// backend, otherwise generated on demand via POST /api/resources/:id/caption.
// "Use in project" wires an entry into the exact Project workflow: a new
// project is created with the caption as Master Prompt and the image (or the
// video's middle frame) installed as the pinned reference visual — from
// there AI Craft + Generate behave like any other project.
const RESOURCES = path.join(ROOT, "resources");
const RES_META = path.join(RESOURCES, "meta.json");
// AI Story Director boards (file-persisted JSON, one per story — resumable,
// debuggable, works with or without Postgres like prompts/*.json).
const DIRECTOR = path.join(ROOT, "director");
const resReadMeta = () => {
  try {
    const m = JSON.parse(fs.readFileSync(RES_META, "utf8"));
    return Array.isArray(m) ? m : [];
  } catch { return []; }
};
const resWriteMeta = (rows) => {
  fs.mkdirSync(RESOURCES, { recursive: true });
  fs.writeFileSync(RES_META, JSON.stringify(rows, null, 2));
};
const resMimeExt = (mime) => ({
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
}[String(mime || "").toLowerCase()] ?? null);
const newResId = () => `res_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
// Shell out to ffmpeg/ffprobe (same binaries the stitch path relies on).
const runCmd = (cmd, args, timeoutMs = 60000) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { windowsHide: true });
  let out = "", err = "";
  const t = setTimeout(() => { try { p.kill(); } catch { /* already dead */ } rej(new Error(`${cmd} timed out`)); }, timeoutMs);
  p.stdout.on("data", (c) => (out += c));
  p.stderr.on("data", (c) => (err += c));
  p.on("error", (e) => { clearTimeout(t); rej(e); });
  p.on("close", (code) => { clearTimeout(t); code === 0 ? res(out || err) : rej(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`)); });
});
async function videoDurationSec(full) {
  try {
    const out = await runCmd("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", full], 30000);
    const n = Number(String(out).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}
// Middle frame of a video as a JPEG (grid thumbnail + vision-caption source
// + reference visual when a video seeds a project).
async function extractMiddleFrame(videoFull, jpgFull) {
  const dur = await videoDurationSec(videoFull);
  const ss = dur != null ? String(Math.max(0, dur / 2)) : "1";
  await runCmd("ffmpeg", ["-y", "-ss", ss, "-i", videoFull, "-frames:v", "1", jpgFull], 60000);
}
// The local LLM backend serves only the loaded model (LM Studio /
// llama-server, OpenAI-compatible). Force vision with LLM_VISION=1.
const LLM_VISION_FORCE = ["1", "true", "yes", "on"].includes(String(process.env.LLM_VISION || "").trim().toLowerCase());
let llmModelCache = { at: 0, id: null };
async function llmModelId() {
  if (Date.now() - llmModelCache.at < 30000 && llmModelCache.id) return llmModelCache.id;
  const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
  if (!base) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${base}/v1/models`, { signal: ctl.signal });
    clearTimeout(t);
    const d = await r.json().catch(() => null);
    const id = d?.data?.[0]?.id ?? null;
    if (id) llmModelCache = { at: Date.now(), id: String(id) };
    return id;
  } catch { return llmModelCache.id; }
}
const looksVision = (id) => /vl|vision|llava|moondream|pixtral|gemma[-_ ]?3|qwenvl/i.test(String(id || ""));
// Describe an image (data URL) as an image-generation prompt via the local
// vision model. Throws a human-readable error when no vision model is loaded.
async function captionImageWithVision(dataUrl) {
  const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_BASE not set — captioning unavailable.");
  const novision = new Error("vision-unavailable");
  if (!LLM_VISION_FORCE) {
    const id = await llmModelId();
    if (!looksVision(id)) {
      novision.detail =
        `The loaded LLM ("${id || "unknown"}") cannot read images. ` +
        `In LM Studio load a vision model (Qwen3-VL-4B/8B is already downloaded), ` +
        `then Generate prompt again.`;
      throw novision;
    }
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 180000);
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local",
        messages: [
          {
            role: "system",
            content: "You describe a reference photo for an AI image generator. Output ONLY one detailed static-scene prompt: subject identity and appearance, clothing, pose, setting, lighting, colors, medium and quality tags. No quotes, no preamble, no trailing commentary.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image as an image-generation prompt." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.4,
        max_tokens: 500,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const text = String(d.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new Error("The vision model returned an empty caption.");
    return text;
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("Caption timed out (180s) — the vision model may still be loading; try again.");
    throw e;
  } finally { clearTimeout(t); }
}
// Data URL the vision model reads for a resource entry (original image, or
// the video's extracted middle frame).
function resCaptionSource(entry) {
  const full = path.join(RESOURCES, entry.file);
  if (entry.kind === "image") {
    if (!fs.existsSync(full)) throw new Error("resource file missing — re-upload it.");
    const buf = fs.readFileSync(full);
    if (buf.length > 25 * 1024 * 1024) throw new Error("image over 25MB — downscale it and re-upload to caption.");
    return `data:${mimeFor(entry.file) || "image/png"};base64,${buf.toString("base64")}`;
  }
  const thumbFull = path.join(RESOURCES, entry.thumb || "");
  if (!entry.thumb || !fs.existsSync(thumbFull)) throw new Error("video thumbnail missing — re-upload the video.");
  return `data:image/jpeg;base64,${fs.readFileSync(thumbFull).toString("base64")}`;
}
async function captionResource(entry) {
  const prompt = await captionImageWithVision(resCaptionSource(entry));
  return { ...entry, prompt, captionError: null };
}
function serveResource(res, file) {
  const p = path.join(RESOURCES, file);
  if (!isSafe(file) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(p).pipe(res);
}

// ---------------------------------------------------------------- auth
// Single-user login. Credentials come from env (video_test/.env or real env);
// defaults are admin / admin — override for anything non-local.
const AUTH_USER = process.env.LOGIN_USER || "admin";
const AUTH_PASS = process.env.LOGIN_PASS || "admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const COOKIE_NAME = "ss_session";

const sessions = new Map(); // token -> { user, exp }
function pruneSessions() {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp <= now) sessions.delete(t);
}
function cookieValue(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(v.join("="));
  }
  return null;
}
function authedUser(req) {
  const token = cookieValue(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.exp <= Date.now()) { sessions.delete(token); return null; }
  return s.user;
}
function sessionCookie(token, maxAgeSec) {
  const attrs = [`${COOKIE_NAME}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/"];
  if (maxAgeSec != null) attrs.push(`Max-Age=${maxAgeSec}`);
  else attrs.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  return attrs.join("; ");
}

// ---------------------------------------------------------------- helpers
const isSafe = (name) => typeof name === "string" && name.length > 0 && !name.includes("..") && !name.includes("/") && !name.includes("\\");
// Path segments arrive percent-encoded (spaces stay %20 in u.pathname), so
// decode before any DB/FS use — plain-text project names must work
// end-to-end. Runs AFTER isSafe-relevant checks happen on the decoded value.
// Malformed sequences decode to "" (rejected by isSafe).
const pathName = (seg) => {
  try { return decodeURIComponent(seg || ""); }
  catch { return ""; }
};
const json = (res, code, data) => {
  // Never let the browser cache API JSON (a cached empty gallery list from
  // before a fix/backfill would otherwise keep rendering "No outputs yet").
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};
const readJson = (req) => new Promise((res, rej) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { try { res(JSON.parse(b)); } catch { rej(new Error("bad json")); } });
});

// ---------------------------------------------------------------- runs
// One run = one spawned `node scripts/character_sequence{,_wan}.mjs <folder>`
// (repeated `opts.count` times for batch reference generation).
// Storage runs on the IMMUTABLE folder (outputs/<folder>/…): `scenario` is
// the display name (prompts/<scenario>.json via --config-name), `folder`
// (opts.storageFolder, resolved by the route via migrateProjectStorage) is
// what the script writes to — so renames never orphan generations.
// engine: "ltx" (default) or "wan" — picks the i2v backend script.
// format: "landscape" (default) or "vertical" — the vertical (9:16 Instagram
//   Reel) cut regenerates every asset into outputs/<folder>[_wan]_vertical/.
// opts.stitch   -> --stitch (re-stitch final from selected mains only)
// opts.regen    -> --regen <ref|keyframe|clip> [beat] (regenerate one asset, keeps old versions)
// opts.count    -> repeat a `ref` regen this many times (each pass writes a new
//                  _vN version to pick from); anything else always runs once.
const runs = new Map(); // id -> { scenario, folder, status, log, startedAt, proc, subs:Set<res> }

function startRun(scenario, opts = {}) {
  const { stitch = false, regen = null, engine = "ltx" } = opts;
  // Accept both { format: "vertical" } and the legacy { vertical: true }.
  const format = normalizeFormat(opts.format ?? (opts.vertical ? "vertical" : "landscape"));
  const count = regen?.kind === "ref" ? Math.min(8, Math.max(1, Number(opts.count) || 1)) : 1;
  if ([...runs.values()].some((r) => r.status === "running"))
    throw new Error("another run is still active (ComfyUI queue is serial)");
  // Storage identity: immutable folder for dirs/prefixes, display name only
  // for the prompts JSON. Callers resolve the folder; the slug fallback keeps
  // direct/CLI-style calls working when the DB is unreachable.
  const folder = opts.storageFolder || folderName(scenario);
  const configName = opts.configName || scenario;
  // Dialogue mode: voice + lip-sync beats via scripts/dialogue_lipsync.mjs
  // (local Edge-TTS + Easy-Wav2Lip, no ComfyUI queue needed but still serial
  // with other runs since it rewrites clip mains + re-stitches the final).
  const mode = opts.mode === "dialogue" ? "dialogue" : "generate";
  const script = mode === "dialogue"
    ? "scripts/dialogue_lipsync.mjs"
    : engine === "wan" ? "scripts/character_sequence_wan.mjs" : "scripts/character_sequence.mjs";
  const argv = [script, folder];
  if (configName !== folder) argv.push("--config-name", configName);
  if (mode === "dialogue") {
    if (opts.beats) argv.push("--beats", String(opts.beats));
    if (opts.skipTts) argv.push("--skip-tts");
    if (opts.skipLipsync) argv.push("--skip-lipsync");
    // Per-scene check flow: voice+sync the clip but leave the final cut
    // alone (merge later with Stitch).
    if (opts.noStitch) argv.push("--no-stitch");
    if (engine === "wan") argv.push("--wan");
  } else {
    if (stitch) argv.push("--stitch");
    if (regen) {
      argv.push("--regen", regen.kind, ...(regen.index ? [String(regen.index)] : []));
    }
  }
  if (format === "vertical") argv.push("--vertical");
  const id = Date.now().toString(36);
  // Run shape (stitch/regen/count/format) is stored on the record — not just
  // the argv — so a fresh page can reattach after a refresh: GET /api/runs
  // reveals the active run and the SSE log endpoint replays its log + asset
  // events, letting the client rebuild progress and button state from the
  // real stream instead of guessing.
  const run = { id, scenario, folder, engine, format, stitch, regen, count, mode, beats: opts.beats || null, status: "running", log: "", assets: [], startedAt: Date.now(), proc: null, subs: new Set(), cancelled: false, total: count, pass: 0 };
  runs.set(id, run);
  let lineBuf = "";
  const push = (chunk) => {
    run.log += chunk;
    for (const s of run.subs) s.write(`data: ${JSON.stringify({ line: chunk })}\n\n`);
    // Detect structured `[asset] {...}` lines (script emits one per finished file).
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      const m = line.match(/^\[asset\] (\{.*\})\s*$/);
      if (m) {
        const asset = JSON.parse(m[1]);
        run.assets.push(asset);
        for (const s of run.subs) s.write(`event: asset\ndata: ${JSON.stringify(asset)}\n\n`);
        // Record every finished generation (project_references for reference
        // visuals, project_assets row -> COMPLETED for keyframes/clips/finals).
        // Dirs are folder-based (immutable storage); the project link stays
        // the display name.
        const dirName = outDirName(run.folder, run.engine, run.format);
        pgMarkAssetComplete(run.scenario, asset, { engine: run.engine, format: run.format, outputFolder: dirName })
          .catch((e) => console.warn("[pg] catalog failed:", e.message));
      }
    }
  };
  const finish = (status) => {
    run.status = status;
    push(`\n[${status}]\n`);
    for (const s of run.subs) { s.write("event: close\ndata: " + JSON.stringify({ status: run.status }) + "\n\n"); s.end(); }
    run.subs.clear();
    // Refresh the current version's project_assets file names from the
    // run's output dir (catches final.mp4 + anything missed).
    const dirName = outDirName(run.folder, run.engine, run.format);
    pgRefreshProjectFiles(run.scenario, dirName)
      .catch((e) => console.warn("[pg] sync failed:", e.message));
  };
  const launch = () => {
    run.pass += 1;
    if (run.total > 1) push(`\n[reference ${run.pass}/${run.total}]\n`);
    const proc = spawn("node", argv, {
      cwd: ROOT, env: process.env,
    });
    run.proc = proc;
    proc.stdout.on("data", (d) => push(d.toString()));
    proc.stderr.on("data", (d) => push(d.toString()));
    proc.on("close", (code) => {
      push(`\n[exit ${code}]\n`);
      if (code !== 0) return finish("error");
      if (run.pass < run.total && !run.cancelled) return launch();
      finish(run.cancelled ? "error" : "done");
    });
  };
  launch();
  return run;
}

// ---------------------------------------------------------------- comfy status
async function comfyStatus() {
  const base = (process.env.COMFY_BASE || "").replace(/\/+$/, "");
  if (!base) return { up: false, error: "COMFY_BASE not set" };
  try {
    const [stats, queue] = await Promise.all([
      fetch(`${base}/system_stats`).then((r) => r.json()),
      fetch(`${base}/queue`).then((r) => r.json()),
    ]);
    return { up: true, stats, queue };
  } catch (e) {
    return { up: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------- LLM status
async function llmStatus() {
  const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
  if (!base) return { up: false, error: "LLM_BASE not set" };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    let r;
    try { r = await fetch(`${base}/v1/models`, { signal: ctl.signal }); }
    finally { clearTimeout(t); }
    if (!r.ok) return { up: false, error: `HTTP ${r.status}` };
    return { up: true };
  } catch (e) {
    return { up: false, error: String(e?.message || e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------- dashboard
// Home-page payload: project list + real per-project progress, aggregated
// with a fixed number of queries (no N+1):
//   scenarios (1) + asset coverage GROUP BY (1) + latest image DISTINCT ON (1)
//   + project created dates (1).
// When Postgres is down the scenario list falls back to prompts/*.json and
// coverage falls back to a disk scan, so the Home page still renders — AI
// services being offline never blocks project data either (health is a
// separate endpoint). Error details stay server-side (logs), the client only
// gets "dashboard unavailable".
const newCoverage = () => ({ ref: false, kf: new Set(), clips: new Set(), final: false, thumb: null });

// Disk coverage for a project's dirs (folder dirs first, legacy display-name
// dirs after). Prefers the landscape ltx dir, then _wan, then vertical cuts;
// thumbnail = highest-beat keyframe main, else the reference main.
function diskCoverageFor(dirs, cfg) {
  const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
  const cov = newCoverage();
  for (const dir of dirs) {
    const full = path.join(OUTPUTS, dir);
    if (!fs.existsSync(full)) continue;
    let vm = null;
    try { vm = versionMap(full, prefixFor(dir), seq); } catch { vm = null; }
    if (!vm) continue;
    if (vm.refMain) {
      cov.ref = true;
      cov.thumb ||= { dir, file: vm.refMain };
    }
    for (const [n, b] of Object.entries(vm.beats || {})) {
      if (b.keyframeMain) {
        cov.kf.add(Number(n));
        cov.thumb = { dir, file: b.keyframeMain }; // beats iterate ascending — last wins = highest beat
      }
      if (b.clipMain) cov.clips.add(Number(n));
    }
    if (vm.finalMain) cov.final = true;
    if (cov.thumb && cov.thumb.dir === dir && cov.kf.size) break; // ltx dir already has keyframes
  }
  return cov;
}

async function dashboardPayload() {
  // 1) Project list — the projects TABLE is canonical for Recent Projects
  // (name, folder_name, description, dates, project_id all come from it).
  // FULL OUTER JOIN keeps scenarios that have no project row yet (legacy /
  // pre-save drafts) so no project ever vanishes from Home; prompts/*.json
  // is the last-resort fallback when PG is down.
  let rows;
  if (pgUp) {
    try {
      const r = await pgPool.query(
        `SELECT COALESCE(p.name, s.name) AS name,
                p.project_id, p.folder_name, p.description AS pdesc,
                p.created_at, p.updated_at AS pupdated,
                s.config::text AS config, s.updated_at_ms
         FROM projects p FULL OUTER JOIN scenarios s ON s.name = p.name
         ORDER BY COALESCE(s.updated_at_ms, (extract(epoch from p.updated_at) * 1000)::bigint) DESC NULLS LAST`);
      rows = r.rows.map((x) => ({
        name: x.name,
        project_id: x.project_id != null ? Number(x.project_id) : null,
        folder_name: x.folder_name ?? null,
        pdesc: x.pdesc ?? null,
        created_at: x.created_at ? new Date(x.created_at).getTime() : null,
        pupdated: x.pupdated ? new Date(x.pupdated).getTime() : null,
        configText: x.config != null ? String(x.config) : null,
        updated_at: x.updated_at_ms != null ? Number(x.updated_at_ms) : null,
      }));
    } catch (e) { console.warn("[dashboard] projects query failed:", e.message); rows = null; }
  } else { rows = null; }
  if (!rows) {
    try {
      rows = (await dbListScenarios()).map((r) => ({
        name: r.name, project_id: null, folder_name: null, pdesc: null,
        created_at: null, pupdated: null,
        configText: String(r.config), updated_at: Number(r.updated_at),
      }));
    } catch (e) {
      console.warn("[dashboard] scenario store unreachable, falling back to prompts/*.json");
      rows = [];
      try {
        fs.mkdirSync(PROMPTS, { recursive: true });
        for (const f of fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json"))) {
          const full = path.join(PROMPTS, f);
          try {
            rows.push({
              name: f.replace(/\.json$/, ""), project_id: null, folder_name: null,
              pdesc: null, created_at: null, pupdated: null,
              configText: fs.readFileSync(full, "utf8"), updated_at: Math.round(fs.statSync(full).mtimeMs),
            });
          } catch { /* skip unreadable prompt files */ }
        }
      } catch { /* no prompts dir — empty list */ }
    }
  }
  const cfgs = new Map();
  for (const r of rows) {
    // Config for scene counts/thumbs: scenario row first, prompts JSON copy
    // as fallback (a project row can exist before its first Save).
    let text = r.configText;
    if (text == null) {
      try { text = fs.readFileSync(path.join(PROMPTS, r.name + ".json"), "utf8"); }
      catch { text = null; }
    }
    try { cfgs.set(r.name, text != null ? JSON.parse(text) : null); }
    catch { cfgs.set(r.name, null); }
  }
  const names = rows.map((r) => r.name);
  // Immutable storage folder per project (stored folder_name, else the slug).
  // Coverage, thumbs, running-state and the payload all key off it. Legacy
  // display-name dirs are unioned in for reads so assets generated before
  // folder-immutability keep rendering.
  const fnames = new Map(rows.map((r) => [r.name, r.folder_name ?? null]));
  const folderOf = (n) => fnames.get(n) || folderName(n);
  const dirsOf = (n) => {
    const f = folderOf(n);
    const dirs = allDirsFor(f);
    if (f !== n) for (const d of allDirsFor(n)) if (!dirs.includes(d)) dirs.push(d);
    return dirs;
  };
  // Heal legacy storage on view (one-time move to folder dirs; no-op after).
  for (const n of names) {
    try { await migrateProjectStorage(n); } catch { /* never break the dashboard */ }
  }
  // 2) Coverage from disk (outputs/ dirs are the source of truth for files).
  const covs = new Map(); // name -> coverage
  for (const n of names) covs.set(n, diskCoverageFor(dirsOf(n), cfgs.get(n)));
  const thumbs = new Map();

  // 3) Identity/dates already resolved per row in section 1 (projects
  // table first) — no extra query. Row maps for the payload below.
  const created = new Map(rows.map((r) => [r.name, r.created_at ?? null]));
  const pids = new Map(rows.map((r) => [r.name, r.project_id ?? null]));
  const pdescs = new Map(rows.map((r) => [r.name, r.pdesc ?? null]));
  const pupdates = new Map(rows.map((r) => [r.name, r.pupdated ?? null]));

  // 4) Currently generating (in-memory runs — ComfyUI queue is serial).
  const runningByScenario = new Map();
  for (const r of runs.values()) {
    if (r.status === "running" && !runningByScenario.has(r.scenario)) {
      runningByScenario.set(r.scenario, r);
      // Runs write to folder dirs but are keyed by display name — match both
      // (plus every engine/format variant) so all dashboard keys resolve.
      for (const base of new Set([r.scenario, r.folder])) {
        if (!base) continue;
        for (const dir of allDirsFor(base)) runningByScenario.set(dir, r);
      }
    }
  }
  const generating = new Set(runningByScenario.keys());

  const projects = rows.map((r) => {
    const cfg = cfgs.get(r.name);
    const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
    const beats = seq.length;
    const c = covs.get(r.name) || newCoverage();
    const total = 1 + 2 * beats; // reference + keyframe + clip per beat
    const done = (c.ref ? 1 : 0) + c.kf.size + c.clips.size;
    const progress = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const status = c.final ? "completed" : (done > 0 ? "in_progress" : "draft");
    // Thumbnail: PG catalog pick, else disk pick; must exist on disk.
    // Landscape dirs win over the vertical cuts (main video is canonical).
    // Dirs are folder-based (immutable storage) with legacy name dirs after.
    const thumbDirs = dirsOf(r.name);
    let thumbFile = c.thumb?.file ?? null;
    let thumbDir = c.thumb?.dir ?? thumbDirs[0];
    for (const dir of thumbDirs) {
      if (thumbs.has(dir)) { thumbFile = thumbs.get(dir); thumbDir = dir; break; }
    }
    if (thumbFile && !fs.existsSync(path.join(OUTPUTS, thumbDir, thumbFile))) {
      thumbFile = c.thumb && fs.existsSync(path.join(OUTPUTS, c.thumb.dir, c.thumb.file)) ? c.thumb.file : null;
      if (thumbFile) thumbDir = c.thumb.dir;
    }
    return {
      name: r.name,
      project_id: pids.get(r.name) ?? null,
      folder_name: folderOf(r.name),
      // Description from the projects TABLE first (the stored project data),
      // scenario config as fallback.
      description: pdescs.get(r.name) ?? (typeof cfg?.description === "string" ? cfg.description : ""),
      status,
      generating: thumbDirs.some((dir) => generating.has(dir)),
      startedAt: thumbDirs.map((dir) => runningByScenario.get(dir)?.startedAt).find((t) => t != null) ?? null,
      progress,
      sceneCount: beats,
      imageCount: c.kf.size,
      videoCount: c.clips.size,
      refDone: c.ref,
      hasFinal: c.final,
      thumbnailUrl: thumbFile ? `/outputs/${thumbDir}/${thumbFile}` : null,
      createdAt: created.get(r.name) ?? null,
      // Freshness: scenario save first, project-row update as fallback.
      updatedAt: Number.isFinite(r.updated_at) ? r.updated_at : (pupdates.get(r.name) ?? null),
    };
  }).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const statistics = {
    total: projects.length,
    active: projects.filter((p) => p.generating).length,
    inProgress: projects.filter((p) => p.status === "in_progress").length,
    completed: projects.filter((p) => p.status === "completed").length,
  };
  return { statistics, projects };
}

// ---------------------------------------------------------------- LLM craft
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "scenario";

// Canonical JSON stringify (sorted keys) for comparing configs regardless of key order.
const canonical = (v) => {
  const obj = typeof v === "string" ? JSON.parse(v) : v;
  const sort = (x) =>
    Array.isArray(x) ? x.map(sort)
    : (x && typeof x === "object"
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]))
      : x);
  return JSON.stringify(sort(obj));
};

/**
 * Ask the local LLM (llama-server, OpenAI-compatible) to craft a
 * character-sequence scenario JSON from a description + master prompt.
 * Format reference is resolved without any file dependency: an existing
 * prompts/*.json or any scenario already in the store (SQLite or Postgres).
 * May be null on a fresh install — craftScenario() then relies on the system
 * schema/rules alone.
 */
async function loadCraftReference() {
  // 1) Preferred: prompts/anime_sequence.json (legacy location).
  try {
    const f = path.join(PROMPTS, "anime_sequence.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { /* fall through */ }
  // 2) Any other prompts/*.json still on disk.
  try {
    if (fs.existsSync(PROMPTS)) {
      const any = fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json")).sort();
      if (any.length) return JSON.parse(fs.readFileSync(path.join(PROMPTS, any[0]), "utf8"));
    }
  } catch { /* fall through */ }
  // 3) Any scenario already saved in the store.
  try {
    if (USE_SQLITE) {
      const row = db.prepare("SELECT config FROM scenarios LIMIT 1").get();
      if (row?.config) {
        const cfg = JSON.parse(row.config);
        if (cfg?.referencePrompt && Array.isArray(cfg?.sequence) && cfg.sequence.length) return cfg;
      }
    } else if (pgUp) {
      const r = await pgPool.query("SELECT config FROM scenarios LIMIT 1");
      const cfg = r.rows[0]?.config;
      if (cfg?.referencePrompt && Array.isArray(cfg?.sequence) && cfg.sequence.length) return cfg;
    }
  } catch { /* fall through */ }
  // Nothing on disk or in the store — no reference (fresh install). The caller
  // falls back to the system schema/rules alone.
  return null;
}
/**
 * Load a stored project's brief for the "View Prompt" popup / craft calls:
 * database first (canonical store), prompts/*.json fallback (CLI export).
 * Returns { config, from } with from = "database" | "json", or null.
 */
async function loadStoredBrief(name) {
  if (!isSafe(name)) return null;
  try {
    const raw = await dbGetScenario(name);
    if (raw) return { config: JSON.parse(raw), from: "database" };
  } catch { /* fall through to the JSON export */ }
  try {
    const f = path.join(PROMPTS, name + ".json");
    if (fs.existsSync(f)) return { config: JSON.parse(fs.readFileSync(f, "utf8")), from: "json" };
  } catch { /* no stored brief */ }
  return null;
}
/**
 * Resolve the craft brief (Description + Master prompt + video-type rules +
 * reference example) into the EXACT LLM messages a craft would send. Shared
 * by craftScenario() and the POST /api/craft-preview endpoint, so the
 * "View Prompt" popup shows byte-for-byte what the LLM receives.
 */
async function buildCraftPreview({ description = "", masterPrompt = "", topic = "", requirements = "", presetId, presetRules, rulesDisabled, target }) {
  // Legacy callers sent { topic, requirements }; current UI sends
  // { description, masterPrompt }. Accept both — topic/requirements are NOT
  // persisted anywhere, they only seed the LLM prompt. presetId selects a
  // predefined video-type preset (system-owned presets/*.md rules); unknown
  // or missing ids fall back to the default (cinematic) — existing saved
  // projects without one keep working unchanged. presetRules is an optional
  // per-project override: when non-empty it REPLACES the preset's .md
  // content for this project only (the .md files are never modified).
  // rulesDisabled (AI Craft "Disable rules") skips the video-type rules
  // entirely: the LLM prompt carries only Description + Master prompt, and
  // the crafted config stores no preset.
  // target (open project): empty request fields fall back to the STORED
  // project brief — database first, prompts/*.json fallback. Typed box
  // edits always win; the popup therefore shows persisted data, not just
  // whatever happens to be in the boxes.
  let stored = null;
  let storedFrom = null;
  if (typeof target === "string" && target) {
    const hit = await loadStoredBrief(target);
    if (hit && hit.config && typeof hit.config === "object") {
      stored = hit.config;
      storedFrom = hit.from;
    }
  }
  const pick = (val, fallback) => {
    const s = String(val ?? "").trim();
    return s ? s : String(fallback ?? "").trim();
  };
  const idea = pick(description || topic, stored && (stored.description || stored.topic));
  const details = pick(masterPrompt || requirements, stored && stored.referencePrompt);
  if (!idea) throw new Error("description required");
  const noRules = !!rulesDisabled;
  const preset = noRules ? null : resolvePresetId(pick(presetId, stored && stored.presetId) || undefined);
  // Missing preset file = fail loudly, never silently craft off-brief —
  // unless the caller supplied custom rules, which stand on their own.
  // (Rule-free crafts skip preset resolution altogether.)
  const customRules = noRules ? "" : pick(presetRules, stored && stored.presetRules);
  let presetMeta;
  let presetContent;
  if (noRules) {
    presetMeta = null;
    presetContent = "";
  } else if (customRules) {
    presetMeta = GetPresetById(preset) ?? { id: preset, name: preset };
    presetContent = customRules;
  } else {
    ({ meta: presetMeta, content: presetContent } = GetPresetContent(preset));
  }
  const reference = await loadCraftReference();
  const system = [
    "You write ComfyUI video-generation scenario configs. Output ONLY a JSON object, no prose, no markdown fences.",
    "Schema: { description: string, character: string, referencePrompt: string, duration: number,",
    '  sequence: [ { title: snake_case_file_safe, image: string, motion: string } ] }',
    "Rules: character = one consistent subject description reused verbatim in referencePrompt and every image prompt.",
    "referencePrompt = cinematic key-visual of the character (static).",
    "sequence = 4 story beats in chronological order; each image = static keyframe prompt for Flux t2i (include the character block);",
    "each motion = 1-2 sentences of motion + camera direction for LTX image-to-video (no cuts, no new characters).",
    "duration = seconds per clip (2-5). Titles must be unique, short, snake_case.",
  ].join(" ");
  // LM Studio user prompt = Description first, then Master prompt, then the
  // preset rules appended last — concatenated in that order so the model
  // reads the user's brief before the video-type rules. Rule-free crafts
  // (rulesDisabled) send only the brief — no rules block at all.
  const briefParts = [
    `Description: ${idea}`,
    `Master prompt / visual direction: ${details || "(none)"}`,
    ...(presetContent ? [`Video-type rules (preset "${presetMeta.name}") — follow these for the referencePrompt and every image + motion prompt:\n${presetContent}`] : []),
  ];
  const user = reference
    ? `Reference example (match its style and level of detail, NOT its subject):\n${JSON.stringify(reference, null, 2)}\n\nNew scenario to craft:\n${briefParts.join("\n\n")}`
    : `New scenario to craft:\n${briefParts.join("\n\n")}`;
  return { idea, details, noRules, preset, customRules, presetMeta, presetContent, system, user, briefFrom: storedFrom };
}
async function craftScenario({ description = "", masterPrompt = "", topic = "", requirements = "", name, presetId, presetRules, rulesDisabled, userPrompt, target }) {
  // userPrompt (from the "View Prompt" popup) replaces the auto-built user
  // message verbatim — the brief is still resolved for validation + preset
  // persistence, but the LLM receives exactly what was previewed/edited.
  const brief = await buildCraftPreview({ description, masterPrompt, topic, requirements, presetId, presetRules, rulesDisabled, target });
  const { idea, details, noRules, preset, customRules, system } = brief;
  const user = String(userPrompt ?? "").trim() ? String(userPrompt).trim() : brief.user;
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.7,
      max_tokens: 8000,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  let text = d.choices?.[0]?.message?.content || "";
  text = text.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM returned no JSON object");
  const cfg = JSON.parse(m[0]);
  if (!cfg.referencePrompt || !Array.isArray(cfg.sequence) || !cfg.sequence.length)
    throw new Error("crafted config missing referencePrompt/sequence");
  cfg.duration = Number(cfg.duration) || 3;
  if (!cfg.description && idea) cfg.description = idea;
  if (details && !cfg.referencePrompt) cfg.referencePrompt = details;
  // Never persist legacy brief fields even if the LLM echoes them back.
  delete cfg.topic;
  delete cfg.requirements;
  // The preset travels with the project (id only — resolved to presets/*.md
  // at generation time, unless the project carries its own presetRules
  // override), so Save persists it via the normal config path. Rule-free
  // crafts store no preset at all.
  if (noRules) {
    delete cfg.presetId;
    delete cfg.presetRules;
  } else {
    cfg.presetId = preset;
    if (customRules) cfg.presetRules = customRules;
    else delete cfg.presetRules;
  }
  cfg.sequence = cfg.sequence.map((b, i) => {
    const out = {
      title: slug(b.title) || `beat${i + 1}`,
      image: String(b.image || ""),
      motion: String(b.motion || ""),
    };
    // Preserve per-scene dialogue + clip length when the LLM returns them
    // (director-approved projects always carry them; dropping them here is
    // what used to blank-or-duplicate dialogue in the Scenario Editor).
    const dur = Number(b.duration);
    if (Number.isFinite(dur) && dur > 0) out.duration = Math.min(30, Math.max(1, Math.round(dur)));
    if (Array.isArray(b.dialogue)) {
      const dlg = b.dialogue
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ speaker: String(x.speaker || "").trim(), line: String(x.line || "").trim() }))
        .filter((x) => x.line);
      if (dlg.length) out.dialogue = dlg;
    }
    return out;
  });
  // Master Prompt fan-out: whatever was written in Master Prompt is appended
  // to every crafted scene's keyframe image prompt (blank = untouched, so
  // only the AI prompt is sent for generation; motion is never touched).
  cfg.sequence = applyMasterToBeats(cfg.sequence, details);
  const scenarioName = slug(name || idea);
  return { name: scenarioName, config: cfg };
}

/**
 * Ask the local LLM to extend a scenario with the NEXT beat in the story.
 * Context = the scenario JSON itself (description / character / referencePrompt
 * + existing beats), so the new beat continues chronologically from the last
 * existing beat and keeps the same character and visual style.
 */
async function craftNextBeat(cfg, presetContent = "") {
  const existing = (cfg.sequence || []).map((b, i) => ({
    n: i + 1,
    title: b.title,
    image: b.image,
    motion: b.motion,
    ...(Number.isFinite(Number(b.duration)) && Number(b.duration) > 0 ? { duration: Number(b.duration) } : {}),
    ...(Array.isArray(b.dialogue) && b.dialogue.length ? { dialogue: b.dialogue } : {}),
  }));
  const system = [
    "You extend a ComfyUI video-generation scenario with exactly ONE next beat.",
    "The story must continue chronologically from the last existing beat — pick the natural next moment in the arc.",
    "Rules: title = short snake_case_file_safe and unique among existing titles;",
    "image = static keyframe prompt for Flux t2i (reuse the character block VERBATIM, keep the same visual style, new moment/pose/setting detail);",
    "motion = 1-2 sentences of motion + camera direction for LTX image-to-video (no cuts, no new characters).",
    "dialogue = 0-2 NEW speakable lines for THIS beat only as [{ speaker, line }] (speaker = on-screen character, each line under ~15 words) — NEVER copy a line from the existing beats; action-only beats use [].",
    "duration = clip length in seconds for this beat (1-30, usually the project default).",
    "Output ONLY a JSON object { title, image, motion, dialogue, duration } — no prose, no markdown fences.",
    // Same priority as craftScenario: the project's preset keeps the visual
    // language; the new beat only supplies the next story moment.
    ...(presetContent ? [`Visual language: the new beat MUST follow these preset rules:\n${presetContent}`] : []),
  ].join(" ");
  const user = `Scenario context:
${JSON.stringify({
    description: cfg.description || "",
    character: cfg.character || "",
    referencePrompt: cfg.referencePrompt || "",
    existingBeats: existing,
  }, null, 2)}

Write the next beat (beat ${existing.length + 1}).`;
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.7,
      max_tokens: 2000,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  let text = d.choices?.[0]?.message?.content || "";
  text = text.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM returned no JSON object");
  const b = JSON.parse(m[0]);
  if (!b.image || !b.motion) throw new Error("crafted beat missing image/motion");
  let title = slug(b.title) || `beat${existing.length + 1}`;
  const taken = new Set(existing.map((x) => x.title));
  if (taken.has(title)) title = `${title}_next`;
  const out = { title, image: String(b.image), motion: String(b.motion) };
  const dur = Number(b.duration);
  if (Number.isFinite(dur) && dur > 0) out.duration = Math.min(30, Math.max(1, Math.round(dur)));
  if (Array.isArray(b.dialogue)) {
    const dlg = b.dialogue
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ speaker: String(x.speaker || "").trim(), line: String(x.line || "").trim() }))
      .filter((x) => x.line);
    // Never carry a copied line forward: drop any line that already appears
    // in an earlier beat (the "same text in every scene" defect).
    const seen = new Set(
      (cfg.sequence || []).flatMap((eb) => (Array.isArray(eb.dialogue) ? eb.dialogue : []))
        .map((x) => String(x && x.line || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim())
        .filter(Boolean)
    );
    const fresh = dlg.filter((x) => {
      const k = x.line.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
      if (k && seen.has(k)) return false;
      if (k) seen.add(k);
      return true;
    });
    if (fresh.length) out.dialogue = fresh;
  }
  return out;
}

/** Generate `count` consecutive beats; each call continues from the previous one. */
async function craftNextBeats(cfg, count) {
  // Preset continuity: beats inherit the project's visual language
  // (cfg.presetId, defaulting to cinematic for older saved projects).
  // A per-project cfg.presetRules override wins over the preset file.
  const customRules = String(cfg?.presetRules ?? "").trim();
  let presetContent;
  if (customRules) {
    presetContent = customRules;
  } else {
    const preset = resolvePresetId(cfg.presetId);
    ({ content: presetContent } = GetPresetContent(preset));
  }
  const beats = [];
  const cur = { ...cfg, sequence: [...(cfg.sequence || [])] };
  for (let i = 0; i < count; i++) {
    const b = await craftNextBeat(cur, presetContent);
    beats.push(b);
    cur.sequence.push(b);
  }
  // Master Prompt fan-out: the stored master (referencePrompt) is appended
  // to every new beat's keyframe image prompt (blank = untouched, AI prompt
  // only; motion is never touched).
  return applyMasterToBeats(beats, cfg.referencePrompt);
}

/**
 * Ask the local LLM for publishing metadata (title, description, hashtags)
 * for a finished scenario. Context = the scenario JSON itself (description /
 * character / referencePrompt + beat titles + prompts), so the copy matches
 * the actual story and visuals. Output is NOT persisted anywhere — the UI
 * keeps it per project in localStorage.
 */
async function craftVideoMeta(cfg) {
  if (!cfg || !Array.isArray(cfg.sequence) || !cfg.sequence.length)
    throw new Error("config with sequence required");
  const beats = (cfg.sequence || []).map((b, i) => ({
    n: i + 1,
    title: b.title,
    image: b.image,
    motion: b.motion,
  }));
  const system = [
    "You write publishing copy for a short AI-generated video (YouTube / Instagram).",
    "Output ONLY a JSON object { title, description, hashtags } — no prose, no markdown fences.",
    "Rules: title = one catchy, click-worthy YouTube-style line under 100 characters: plain Title Case words separated by single spaces (no quotes, no hashtags, no underscores, no snake_case, no hyphens joining words);",
    "description = 2-4 engaging sentences about THIS video's story and visuals, then one blank line, then a 'Watch' line naming the project;",
    "hashtags = 8-12 relevant tags WITHOUT the # prefix, lowercase, no spaces (use camelCase or underscores), ordered most-specific first.",
  ].join(" ");
  const user = `Video project context:
${JSON.stringify({
    project: cfg.description || "",
    character: cfg.character || "",
    referenceVisual: cfg.referencePrompt || "",
    beats,
  }, null, 2)}

Write the publishing metadata.`;
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.7,
      max_tokens: 1500,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  let text = d.choices?.[0]?.message?.content || "";
  text = text.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM returned no JSON object");
  const meta = JSON.parse(m[0]);
  if (!meta.title || !meta.description) throw new Error("crafted metadata missing title/description");
  // Normalize hashtags: accept an array or a whitespace/comma-separated
  // string; strip stray #/punctuation, force the # prefix at serve time.
  const rawTags = Array.isArray(meta.hashtags)
    ? meta.hashtags
    : String(meta.hashtags || "").split(/[\s,]+/);
  const tags = [];
  for (const t of rawTags) {
    const clean = String(t || "").replace(/^#+/, "").replace(/[^\w]/g, "").slice(0, 40);
    if (clean && !tags.includes(clean) && tags.length < 15) tags.push(clean);
  }
  return {
    title: toYouTubeTitle(meta.title).slice(0, 140),
    description: String(meta.description).trim().slice(0, 2000),
    hashtags: tags,
  };
}

/**
 * Ask the local LLM for a single Master Prompt (cinematic key-visual of the
 * main character) from a Description + the chosen Video Type (presetId /
 * presetRules). Stateless — nothing persisted; the Create New Project dialog
 * fills its Master Prompt box with the result.
 */
async function craftMasterPrompt({ description = "", presetId, presetRules } = {}) {
  const idea = String(description ?? "").trim();
  if (!idea) throw new Error("description required");
  // Video-type rules shape the master prompt's visual language. Per-project
  // custom rules win over the preset file; a missing/unreadable preset file
  // falls back to no-rules instead of failing the whole call.
  const customRules = String(presetRules ?? "").trim();
  let presetMeta = null;
  let presetContent = "";
  if (customRules) {
    const preset = resolvePresetId(presetId);
    presetMeta = GetPresetById(preset) ?? { id: preset, name: preset };
    presetContent = customRules;
  } else {
    try {
      const preset = resolvePresetId(presetId);
      const got = GetPresetContent(preset);
      presetMeta = got.meta;
      presetContent = got.content;
    } catch (e) {
      console.warn("[master-prompt] preset unavailable, continuing without rules:", e.message);
    }
  }
  const system = [
    "You write a single cinematic key-visual prompt for AI image generation (Flux text-to-image).",
    "Output ONLY the prompt text — 2-4 dense sentences, no JSON, no quotes, no markdown, no preamble.",
    "Rules: describe ONE consistent main character (age, look, outfit) + art style + lighting + mood + setting detail,",
    "keep it reusable as a prefix for every scene's keyframe prompt. No camera motion, no cuts, no story beats.",
  ].join(" ");
  const user = [
    `Video description:\n${idea}`,
    `Video type: ${presetMeta ? presetMeta.name : "general"}`,
    ...(presetContent
      ? [`Video-type rules — the Master Prompt MUST follow this visual language:\n${presetContent}`]
      : []),
    "Write the Master Prompt (cinematic key-visual of the main character).",
  ].join("\n\n");
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.7,
      max_tokens: 500,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  let text = String(d.choices?.[0]?.message?.content || "").trim();
  // Strip fences/quotes if the model adds them despite the instructions.
  text = text.replace(/^\s*```(?:\w+)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  text = text.replace(/^["“”']+|["“”']+$/g, "").trim();
  // Collapse to a single prompt: first JSON string value, or first paragraph.
  if (/^\s*\{/.test(text)) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const o = JSON.parse(m[0]);
        const cand = o.masterPrompt || o.referencePrompt || o.prompt || o.text;
        if (cand) text = String(cand).trim();
      } catch { /* keep raw text */ }
    }
  }
  text = text.split(/\n\s*\n/)[0].trim().replace(/\s+/g, " ");
  if (!text) throw new Error("LLM returned an empty master prompt");
  return { masterPrompt: text.slice(0, 2000) };
}

// ---------------------------------------------------------------------------
function toYouTubeTitle(s) {
  let t = String(s || "").replace(/^["“”']+|["“”']+$/g, "").trim();
  t = t.replace(/#\S+/g, " "); // never keep hashtags inside the title
  t = t.replace(/[_]+/g, " ").replace(/[-–—]+/g, " ").replace(/\s+/g, " ").trim();
  t = t.split(" ").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return t;
}

// ---------------------------------------------------------------- static files
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".wav": "audio/wav", ".ico": "image/x-icon" };
function serveStatic(req, res, urlPath) {
  let file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  const headers = { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" };
  if (path.basename(file) === "index.html") headers["Cache-Control"] = "no-store"; // never serve a stale UI
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}
function serveOutput(res, scenario, file) {
  const p = path.join(OUTPUTS, scenario, file);
  if (!isSafe(scenario) || !isSafe(file) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(p).pipe(res);
}

// ---------------------------------------------------------------- outputs (versions + mains)
// Output dir name -> scenario config name (Wan runs use outputs/<scenario>_wan;
// vertical Instagram Reel cuts use outputs/<scenario>[_wan]_vertical/).
const cfgNameFor = (dirName) => cfgNameForDir(dirName);
const prefixFor = (dirName) => prefixForDir(dirName);

/**
 * List output files + versioned assets for a scenario output dir.
 * versions: { ref: [{file,v}], beats: { n: { keyframe: [...], clip: [...] } } }
 * mains:    { ref: file|null,    beats: { n: { keyframe: file|null, clip: file|null } } }
 */
async function outputsPayload(name) {
  const dir = path.join(OUTPUTS, name);
  const onDisk = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort()
    : [];
  // File list comes from disk (outputs/ dirs are the source of truth).
  // Deleted files simply vanish from the listing — never broken media.
  const files = [...onDisk]
    .filter((f) => fs.existsSync(path.join(dir, f)));
  const versions = { ref: [], beats: {}, final: [] };
  const mains = { ref: null, beats: {}, final: null, pinned: { ref: false, beats: {} } };
  // Config for version mapping: prompts JSON first, store copy as fallback
  // (a scenario can live in the store while its JSON is missing/renamed).
  // Dirs are folder-based; the config is keyed by DISPLAY name, resolved
  // from the owning project row (legacy dirs fall back to suffix-stripping).
  let cfg = null;
  const { base: folderBase } = splitDirSuffix(name);
  const cfgName = (pgUp ? await displayNameForFolder(folderBase) : null) || cfgNameFor(name);
  const cfgPath = path.join(PROMPTS, cfgName + ".json");
  try {
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch { cfg = null; }
  if (!cfg) {
    try {
      const raw = await dbGetScenario(cfgName);
      if (raw) cfg = JSON.parse(raw);
    } catch { cfg = null; }
  }
  if (files.length && cfg?.referencePrompt && Array.isArray(cfg?.sequence)) {
    const vm = versionMap(dir, prefixFor(name), cfg.sequence);
    mains.ref = vm.refMain;
    mains.pinned.ref = !!vm.refPinned;
    for (const [n, b] of Object.entries(vm.beats)) {
      versions.beats[n] = { keyframe: b.keyframe, clip: b.clip };
      mains.beats[n] = { keyframe: b.keyframeMain, clip: b.clipMain };
      mains.pinned.beats[n] = { keyframe: !!b.keyframePinned, clip: !!b.clipPinned };
    }
    versions.ref = vm.ref;
    versions.final = vm.final ?? [];
    mains.final = vm.finalMain ?? null;
  }
  // Reference section is served from project_references (one row per
  // generation/upload, is_main = UI-selected main), unioned with the
  // on-disk versions so files without a row yet (CLI runs, backfill gaps)
  // still render. DB order/metadata win; missing files are filtered so
  // deleted renders never show. Disk stays the fallback (drafts, PG down,
  // never-recorded legacy files).
  let refMeta = {};
  if (pgUp) {
    try {
      const pid = await pgProjectId(cfgName);
      if (pid != null) {
        const refs = (await pgReferenceList(pid, name)).filter((r) =>
          fs.existsSync(path.join(dir, r.file)));
        if (refs.length) {
          const byFile = new Map(versions.ref.map((v) => [v.file, v.v]));
          for (const r of refs) byFile.set(r.file, r.v);
          versions.ref = [...byFile.entries()]
            .map(([file, v]) => ({ file, v }))
            .sort((a, b) => a.v - b.v || (a.file < b.file ? -1 : 1));
          const main = refs.find((r) => r.is_main) ?? refs[refs.length - 1];
          mains.ref = main.file;
          mains.pinned.ref = !!main.pinned;
          refMeta = Object.fromEntries(refs.map((r) => [r.file, {
            prompt: r.prompt, source: r.source, pinned: r.pinned,
          }]));
        }
      }
    } catch (e) { console.warn("[outputs] reference overlay failed:", e.message); }
  }
  return { files, versions, mains, refMeta };
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  try {
    if (p === "/api/login" && req.method === "POST") {
      const body = await readJson(req);
      const ok = String(body.username || "") === AUTH_USER && String(body.password || "") === AUTH_PASS;
      if (!ok) return json(res, 401, { error: "invalid credentials" });
      pruneSessions();
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { user: AUTH_USER, exp: Date.now() + SESSION_TTL_MS });
      res.setHeader("Set-Cookie", sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
      return json(res, 200, { user: AUTH_USER });
    }
    if (p === "/api/logout" && req.method === "POST") {
      const token = cookieValue(req);
      if (token) sessions.delete(token);
      res.setHeader("Set-Cookie", sessionCookie("", 0));
      return json(res, 200, { ok: true });
    }
    if (p === "/api/me" && req.method === "GET") {
      const user = authedUser(req);
      return user ? json(res, 200, { user }) : json(res, 401, { error: "unauthorized" });
    }
    // Public read so the login screen + first paint already use the saved
    // theme (writes stay behind auth below).
    if (p === "/api/theme" && req.method === "GET") {
      return json(res, 200, readThemeFile());
    }

    // Everything below (API + generated outputs) requires a session.
    if ((p.startsWith("/api/") || p.startsWith("/outputs/") || p.startsWith("/resources/")) && !authedUser(req))
      return json(res, 401, { error: "unauthorized" });

    if (p === "/api/scenarios" && req.method === "GET") {
      const favs = readFavs();
      let rows;
      try { rows = await dbListScenarios(); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      // Integer project ids + immutable storage folders for the sidebar
      // (desc sort + #id chip + output-dir resolution). Both live on the
      // projects table; the scenarios store itself has neither column.
      // Null in SQLite mode / pre-migration rows (callers fall back to slug).
      let pidMap = new Map();
      let folderMap = new Map();
      if (pgUp) {
        try {
          const pr = await pgPool.query("SELECT name, project_id, folder_name FROM projects");
          pidMap = new Map(pr.rows.map((x) => [x.name, Number(x.project_id)]));
          folderMap = new Map(pr.rows.map((x) => [x.name, x.folder_name ?? null]));
        } catch { /* ids/folders stay null — sidebar falls back to mtime order/slug */ }
      }
      return json(res, 200, rows.map((r) => {
        const c = JSON.parse(r.config);
        return {
          name: r.name,
          // A character-sequence project = has a sequence array. The Master
          // Prompt is optional (blank = AI prompt only), so it must not
          // gate listing — otherwise master-less projects vanish.
          isSequence: Array.isArray(c.sequence),
          // node-pg returns BIGINT as string — coerce so the UI gets a real
          // epoch-ms number (a string renders as NaN-undefined-NaN).
          mtimeMs: Number(r.updated_at),
          favorite: favs.includes(r.name),
          project_id: pidMap.has(r.name) ? pidMap.get(r.name) : null,
          folder_name: folderMap.get(r.name) ?? null,
        };
      }).sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || b.mtimeMs - a.mtimeMs)); // favorites first, then latest edited
    }
    if (p === "/api/favorites" && req.method === "POST") {
      const { name, on } = await readJson(req);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      let favs = readFavs();
      favs = on ? (favs.includes(name) ? favs : [...favs, name]) : favs.filter((n) => n !== name);
      fs.writeFileSync(FAVS, JSON.stringify({ names: favs }, null, 2));
      return json(res, 200, { ok: true, names: favs });
    }
    if (p === "/api/theme" && (req.method === "PUT" || req.method === "POST")) {
      let body;
      try { body = await readJson(req); }
      catch { return json(res, 400, { error: "bad json" }); }
      const mode = body.mode === "light" ? "light" : "dark";
      const color = typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : "";
      const t = { mode, color };
      writeThemeFile(t);
      return json(res, 200, t);
    }
    if (p.startsWith("/api/scenario/") && req.method === "GET" && p.split("/")[4] === "versions") {
      const parts = p.split("/");
      const name = pathName(parts[3]);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      if (!pgUp) return json(res, 503, { error: "database unavailable" });
      if (parts.length >= 6 && parts[5]) {
        const v = Number(parts[5]);
        if (!Number.isInteger(v)) return json(res, 400, { error: "bad version" });
        const r = await pgPool.query("SELECT config, created_at FROM scenario_versions WHERE name = $1 AND version = $2", [name, v]);
        if (!r.rows.length) return json(res, 404, { error: "no such version" });
        return json(res, 200, { name, version: v, config: r.rows[0].config, created_at: r.rows[0].created_at });
      }
      const r = await pgPool.query("SELECT version, config, created_at FROM scenario_versions WHERE name = $1 ORDER BY version DESC", [name]);
      // Attach a per-version change summary so the UI can show "v2: beat 3
      // changed" instead of implying all scenes were regenerated. v1 lists
      // every scene (full snapshot); v2+ lists only the diff vs the previous
      // version. Purely additive — old clients ignore the extra field.
      const asc = [...r.rows].reverse();
      const withChanges = asc.map((row, i) => {
        let changes = null;
        try {
          if (i === 0) {
            const n = Array.isArray(row.config?.sequence) ? row.config.sequence.length : 0;
            changes = {
              refChanged: true,
              beats: Array.from({ length: n }, (_, k) => k + 1),
            };
          } else {
            const plan = planDelta(asc[i - 1].config, row.config);
            changes = {
              refChanged: plan.ref,
              beats: Object.keys(plan.beats).map(Number).sort((a, b) => a - b),
            };
          }
        } catch { changes = null; }
        return { version: row.version, created_at: row.created_at, changes };
      });
      return json(res, 200, withChanges.reverse());
    }
    // length === 4 guard: sub-paths like /versions/1 must never fall through
    // to a whole-scenario route (an old client hitting a new path wiped a
    // scenario that way once).
    if (p.startsWith("/api/scenario/") && req.method === "GET" && p.split("/").length === 4) {
      const name = pathName(p.split("/")[3]);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      let raw;
      try { raw = await dbGetScenario(name); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (raw === null) return json(res, 404, { error: "no such scenario" });
      return json(res, 200, { name, config: JSON.parse(raw) });
    }
    if (p.startsWith("/api/scenario/") && req.method === "PUT" && p.split("/").length === 4) {
      const name = pathName(p.split("/")[3]);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      const cfg = await readJson(req);
      // folder_name is minted ONCE (unique) and frozen: creation stamps it
      // from the project name, edits/renames never change it — output dirs,
      // filenames and DB paths stay stable so media keeps resolving.
      const storedFolder = pgUp ? await getFolderNameFromRow(name) : null;
      let folder = storedFolder;
      if (!folder && pgUp) {
        folder = await ensureUniqueFolder(name, name);
        try {
          await pgPool.query(
            "UPDATE projects SET folder_name = $2 WHERE name = $1 AND (folder_name IS NULL OR folder_name = '')",
            [name, folder]);
        } catch { /* row may not exist yet — claimed on version save */ }
      }
      if (typeof cfg === "object" && cfg) {
        // A fresh claim always wins — never inherit another project's folder
        // from a duplicated/copied config. A stored folder is never
        // overwritten, only backfilled when the config lacks it.
        if (!storedFolder || !cfg.folder_name) cfg.folder_name = folder || folderName(name);
      }
      // Retired fields — never persist even if an old client/draft sends them.
      if (cfg && typeof cfg === "object") { delete cfg.topic; delete cfg.requirements; }
      // No-change save = no-op: an identical config must not stack a duplicate version.
      let prevRaw;
      try { prevRaw = await dbGetScenario(name); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      let same = false;
      try { same = prevRaw !== null && canonical(prevRaw) === canonical(cfg); }
      catch { same = false; }
      if (same) {
        let version = null;
        let project_id = null;
        if (pgUp) {
          try {
            const r = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
            version = r.rows[0]?.v ?? null;
            // No-change save still guarantees the project row exists.
            project_id = await pgEnsureProject(name, cfg);
          } catch (e) { console.warn("[pg] version lookup failed:", e.message); }
        }
        return json(res, 200, { ok: true, version, project_id, unchanged: true });
      }
      if (USE_SQLITE) {
        await dbSaveScenario(name, cfg);
        // Keep the JSON export for the CLI runners.
        fs.writeFileSync(path.join(PROMPTS, name + ".json"), JSON.stringify(cfg, null, 2));
        pgSaveScenarioMirror(name, cfg).catch((e) => console.warn("[pg] scenario mirror failed:", e.message));
      } else {
        // Postgres is the canonical store: persist first, fail loudly when down.
        if (!pgUp) return json(res, 503, { error: "database unavailable" });
        await dbSaveScenario(name, cfg);
        // Keep the JSON export for the CLI runners.
        fs.writeFileSync(path.join(PROMPTS, name + ".json"), JSON.stringify(cfg, null, 2));
      }
      // Explicit save updates the CURRENT project in place — never a new
      // project row and never a new version row. The scenarios row, the
      // prompts JSON, the projects row and the LATEST scenario_versions
      // config are overwritten; only changed scenes' project_assets rows at
      // that same version are refreshed (see pgSaveVersionInPlace).
      // First save of a project still mints v1 (full snapshot via
      // pgSaveVersionDelta) so per-scene pills and the gallery have a base.
      let version = null;
      let project_id = null;
      if (pgUp) {
        try {
          let prevCfg = null;
          try { prevCfg = prevRaw != null ? JSON.parse(prevRaw) : null; }
          catch { prevCfg = null; }
          const latestRow = await pgPool.query(
            "SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
          // max() is NULL with zero version rows (all versions deleted, or a
          // project row created without versions) — latestVersionOf maps that
          // to null so the first save mints v1 via the delta path. A bare
          // Number(null) is 0 and used to route into pgSaveVersionInPlace at
          // v0, violating project_assets_version_check (version > 0).
          const latest = latestVersionOf(latestRow.rows[0]?.v);
          if (latest == null) {
            const saved = await pgSaveVersionDelta(name, prevCfg, cfg);
            version = saved.version;
            project_id = saved.projectId;
          } else {
            const saved = await pgSaveVersionInPlace(name, latest, prevCfg, cfg);
            version = saved.version;
            project_id = saved.projectId;
          }
        }
        catch (e) { console.warn("[pg] version save failed:", e.message); }
      }
      return json(res, 200, { ok: true, version, project_id, updated: true });
    }
    // Rename a project (POST /api/scenario/:name/rename { newName }).
    // DISPLAY NAME ONLY: scenarios, scenario_versions, projects.name,
    // prompts JSON and favorites move. Storage (outputs dirs, filenames,
    // assets/project_assets paths, folder_name) is IMMUTABLE by design —
    // nothing moves on disk, so images, thumbnails and videos keep
    // resolving on Home and the Project page after a rename. Blocked while
    // a run for the project is active (run records key off the name).
    if (p.startsWith("/api/scenario/") && req.method === "POST" && p.split("/").length === 5 && p.split("/")[4] === "rename") {
      const oldName = pathName(p.split("/")[3]);
      let body;
      try { body = await readJson(req); }
      catch { return json(res, 400, { error: "bad json" }); }
      const newName = String(body.newName || "").trim();
      if (!isSafe(oldName) || !isSafe(newName)) return json(res, 400, { error: "bad name" });
      if (oldName === newName) return json(res, 200, { ok: true, name: newName });
      let oldRaw;
      try { oldRaw = await dbGetScenario(oldName); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (oldRaw === null) return json(res, 404, { error: "no such scenario" });
      let newRaw;
      try { newRaw = await dbGetScenario(newName); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (newRaw !== null) return json(res, 409, { error: "a project with that name already exists" });
      if ([...runs.values()].some((r) => r.status === "running" && r.scenario === oldName))
        return json(res, 409, { error: "stop the active run before renaming" });
      try {
        await dbRenameScenario(oldName, newName);
        renameScenarioFiles(oldName, newName);
        const favs = readFavs();
        if (favs.includes(oldName))
          fs.writeFileSync(FAVS, JSON.stringify({ names: favs.map((n) => (n === oldName ? newName : n)) }, null, 2));
        if (USE_SQLITE) pgRenameScenarioMirror(oldName, newName).catch((e) => console.warn("[pg] rename mirror failed:", e.message));
      } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
      return json(res, 200, { ok: true, name: newName });
    }
    // Delete ONE saved version (prompt config), not the scenario. Deleting the
    // latest rolls the current config back to the new latest so "Latest" never
    // points at a deleted version. Generated outputs are untouched.
    // NOTE: must sit before the whole-scenario DELETE (same prefix).
    if (p.startsWith("/api/scenario/") && req.method === "DELETE" && p.split("/")[4] === "versions") {
      const parts = p.split("/");
      const name = pathName(parts[3]);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      const v = Number(parts[5]);
      if (!Number.isInteger(v)) return json(res, 400, { error: "bad version" });
      if (!pgUp) return json(res, 503, { error: "database unavailable" });
      const cur = await pgPool.query("SELECT max(version) AS max FROM scenario_versions WHERE name = $1", [name]);
      const max = cur.rows[0]?.max ?? null;
      const del = await pgPool.query("DELETE FROM scenario_versions WHERE name = $1 AND version = $2 RETURNING version", [name, v]);
      if (!del.rowCount) return json(res, 404, { error: "no such version" });
      const pid = await pgProjectId(name);
      if (pid != null) await pgPool.query("DELETE FROM project_assets WHERE project_id = $1 AND version = $2", [pid, v]);
      // No project row (pre-save craft deleted?) — nothing to delete.
      let latest = max === v ? null : max;
      if (max === v) {
        const nxt = await pgPool.query("SELECT version, config FROM scenario_versions WHERE name = $1 ORDER BY version DESC LIMIT 1", [name]);
        if (nxt.rows.length) {
          const cfg = nxt.rows[0].config;
          latest = nxt.rows[0].version;
          await dbSaveScenario(name, cfg);
          fs.writeFileSync(path.join(PROMPTS, name + ".json"), JSON.stringify(cfg, null, 2));
          if (USE_SQLITE) pgSaveScenarioMirror(name, cfg).catch((e) => console.warn("[pg] scenario mirror failed:", e.message));
        }
      }
      return json(res, 200, { ok: true, deleted: v, latest });
    }
    if (p.startsWith("/api/scenario/") && req.method === "DELETE" && p.split("/").length === 4) {
      const name = pathName(p.split("/")[3]);
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      if ([...runs.values()].some((r) => r.status === "running" && r.scenario === name))
        return json(res, 409, { error: "stop the active run before deleting" });
      let raw;
      try { raw = await dbGetScenario(name); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (raw === null) return json(res, 404, { error: "no such scenario" });
      await dbDeleteScenario(name);
      const f = path.join(PROMPTS, name + ".json");
      if (fs.existsSync(f)) fs.unlinkSync(f);
      // Storage is folder-based (immutable) — remove folder dirs plus any
      // legacy display-name dirs left from before folder-immutability.
      const delFolder = (pgUp ? await getFolderNameFromRow(name) : null) || folderName(name);
      const delDirs = new Set([...allDirsFor(delFolder), ...allDirsFor(name)]);
      for (const dir of delDirs) {
        const full = path.join(OUTPUTS, dir);
        if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
      }
      try {
        await pgDeleteScenarioMirror(name);
      } catch (e) { console.warn("[pg] scenario unmirror failed:", e.message); }
      return json(res, 200, { ok: true });
    }
    if (p === "/api/runs" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.scenario !== "string" || !isSafe(body.scenario))
        return json(res, 400, { error: "bad scenario" });
      try {
        // Resolve (and heal) immutable storage before spawning: the script
        // writes to outputs/<folder>/ while reading prompts/<scenario>.json.
        const folder = await migrateProjectStorage(body.scenario);
        const run = startRun(body.scenario, {
          stitch: !!body.stitch,
          engine: body.engine || "ltx",
          format: body.format ?? (body.vertical ? "vertical" : undefined),
          regen: body.regen || null,
          count: body.count,
          mode: body.mode === "dialogue" ? "dialogue" : undefined,
          beats: typeof body.beats === "string" ? body.beats : undefined,
          skipTts: !!body.skipTts,
          skipLipsync: !!body.skipLipsync,
          noStitch: !!body.noStitch,
          storageFolder: folder,
          configName: body.scenario,
        });
        return json(res, 200, { id: run.id, folder });
      } catch (e) {
        return json(res, 409, { error: String(e.message || e) });
      }
    }
    if (p === "/api/runs" && req.method === "GET")
      return json(res, 200, [...runs.values()].map(({ proc, subs, ...r }) => r).reverse());
    if (p.startsWith("/api/runs/") && req.method === "GET") {
      const run = runs.get(p.split("/")[3]);
      if (!run) return json(res, 404, { error: "no run" });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`data: ${JSON.stringify({ line: run.log })}\n\n`);
      // Backlog replay for clients (re)attaching mid-run: flagged replay so
      // the client restores counts/gallery without stamping them "now" —
      // their real completion times are unknown, and fake timestamps corrupt
      // the Time Remaining ETA + the persisted pace after every refresh.
      for (const a of run.assets) res.write(`event: asset\ndata: ${JSON.stringify({ ...a, replay: true })}\n\n`);
      run.subs.add(res);
      req.on("close", () => run.subs.delete(res));
      return;
    }
    if (p.startsWith("/api/runs/") && req.method === "DELETE") {
      const run = runs.get(p.split("/")[3]);
      if (run && run.status === "running") {
        run.cancelled = true; // stop a batch loop after the current pass
        run.proc?.kill("SIGTERM");
      }
      return json(res, 200, { ok: true });
    }
    if (p === "/api/outputs" && req.method === "GET") {
      const name = u.searchParams.get("scenario");
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      // Dirs are folder-based storage; legacy display-name dirs translate,
      // and viewing heals legacy storage so old media reappears.
      const dir = await storageDirFor(name);
      if (dir !== name) {
        try {
          const { base } = splitDirSuffix(name);
          await migrateProjectStorage((pgUp ? await displayNameForFolder(base) : null) || base);
        } catch { /* read anyway */ }
      }
      return json(res, 200, await outputsPayload(dir));
    }
    if (p === "/api/outputs/select" && req.method === "POST") {
      const body = await readJson(req);
      const { scenario, kind, index, file } = body;
      if (!isSafe(scenario) || typeof file !== "string") return json(res, 400, { error: "bad body" });
      const storDir = await storageDirFor(scenario);
      const dir = path.join(OUTPUTS, storDir);
      if (!fs.existsSync(dir)) return json(res, 404, { error: "no outputs" });
      // A manual pick pins the main: it keeps winning on reloads until a
      // regen records a fresh auto main.
      setMain(dir, prefixFor(storDir), kind, kind === "ref" ? 0 : index, null, file, { pinned: true });
      // Reference picks also flip the project_references main (+pin), which
      // is what the Reference section displays.
      if (kind === "ref" && pgUp) {
        try {
          const { base } = splitDirSuffix(scenario);
          const owner = (await displayNameForFolder(base)) || cfgNameFor(scenario);
          const pid = await pgProjectId(owner);
          if (pid != null) await pgSetReferenceMain({ projectId: pid, dir: storDir, file, engine: engineForDir(storDir) });
        } catch (e) { console.warn("[pg] reference main flip failed:", e.message); }
      }
      return json(res, 200, await outputsPayload(storDir));
    }
    if (p === "/api/upload/ref" && req.method === "POST") {
      // Upload an image as the scenario's reference (browse / drag-drop / clipboard).
      // Stored as the next ref version in outputs/<folder>/ and selected as main,
      // so the pipeline skips Flux ref generation and uses the uploaded image.
      const body = await readJson(req);
      const scenario = String(body.scenario || "");
      if (!isSafe(scenario)) return json(res, 400, { error: "bad scenario" });
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:image\/\w+;base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:image base64 payload" });
      const buf = Buffer.from(m[1], "base64");
      if (!buf.length) return json(res, 400, { error: "empty image" });
      const storDir = await storageDirFor(scenario);
      const outDir = path.join(OUTPUTS, storDir);
      fs.mkdirSync(outDir, { recursive: true });
      const prefix = prefixFor(storDir);
      const v = nextVersion(outDir, prefix, "ref", 0, ".png");
      const file = v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`;
      fs.writeFileSync(path.join(outDir, file), buf);
      // An upload is a deliberate choice — pin it as main.
      setMain(outDir, prefix, "ref", 0, null, file, { pinned: true });
      const { base: refBase } = splitDirSuffix(scenario);
      const refOwner = (pgUp ? await displayNameForFolder(refBase) : null) || cfgNameFor(scenario);
      pgRefreshProjectFiles(refOwner, storDir)
        .catch((e) => console.warn("[pg] catalog failed:", e.message));
      // Uploaded references are recorded (pinned main) in project_references.
      if (pgUp) {
        pgProjectId(refOwner).then(async (pid) => {
          if (pid == null) return;
          let prompt = null;
          try {
            const raw = await dbGetScenario(refOwner);
            prompt = raw ? JSON.parse(raw).referencePrompt ?? null : null;
          } catch { prompt = null; }
          await pgAddReference({
            projectId: pid, dir: storDir, file, prompt,
            engine: engineForDir(storDir), source: "upload",
          });
        }).catch((e) => console.warn("[pg] reference record failed:", e.message));
      }
      return json(res, 200, await outputsPayload(storDir));
    }
    // Resource library (the Resource page): upload images/videos, AI-caption
    // them with the local vision model, and wire them into the Project
    // workflow (new project or an existing project's reference).
    if (p === "/api/resources" && req.method === "GET") {
      return json(res, 200, resReadMeta().slice().reverse());
    }
    if (p === "/api/resources" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:((?:image|video)\/[\w.+-]+);base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:image/* or data:video/* base64 payload" });
      const ext = resMimeExt(m[1]);
      if (!ext) return json(res, 400, { error: `unsupported media type ${m[1]}` });
      const buf = Buffer.from(m[2], "base64");
      if (!buf.length) return json(res, 400, { error: "empty file" });
      const id = newResId();
      const file = id + ext;
      const kind = m[1].startsWith("video/") ? "video" : "image";
      fs.mkdirSync(RESOURCES, { recursive: true });
      fs.writeFileSync(path.join(RESOURCES, file), buf);
      const entry = {
        id, file, kind, thumb: null, prompt: null,
        captionError: null, novision: false, created_at: new Date().toISOString(),
      };
      if (kind === "video") {
        entry.thumb = `${id}_thumb.jpg`;
        try {
          await extractMiddleFrame(path.join(RESOURCES, file), path.join(RESOURCES, entry.thumb));
        } catch (e) {
          entry.thumb = null;
          entry.captionError = `thumbnail failed: ${e.message}`;
        }
      }
      if (!entry.captionError) {
        // Auto-caption on upload (best effort — the file is kept either way).
        try {
          Object.assign(entry, await captionResource(entry));
        } catch (e) {
          entry.prompt = null;
          entry.captionError = e.detail || String(e.message || e);
          entry.novision = e.message === "vision-unavailable";
        }
      }
      const rows = resReadMeta();
      rows.push(entry);
      resWriteMeta(rows);
      return json(res, 200, entry);
    }
    if (p.startsWith("/api/resources/") && req.method === "POST" && p.endsWith("/caption")) {
      const id = pathName(p.split("/")[3]);
      const rows = resReadMeta();
      const entry = rows.find((r) => r.id === id);
      if (!entry) return json(res, 404, { error: "no such resource" });
      try {
        const next = await captionResource(entry);
        resWriteMeta(rows.map((r) => (r.id === id ? { ...next, novision: false } : r)));
        return json(res, 200, { ...next, novision: false });
      } catch (e) {
        if (e.message === "vision-unavailable") return json(res, 409, { error: e.detail, vision: false });
        return json(res, 502, { error: String(e.message || e) });
      }
    }
    if (p.startsWith("/api/resources/") && req.method === "PUT" && p.split("/").length === 4) {
      const id = pathName(p.split("/")[3]);
      const body = await readJson(req);
      if (typeof body.prompt !== "string") return json(res, 400, { error: "prompt required" });
      const rows = resReadMeta();
      if (!rows.some((r) => r.id === id)) return json(res, 404, { error: "no such resource" });
      const next = rows.map((r) => (r.id === id
        ? { ...r, prompt: body.prompt.trim() || null, captionError: null }
        : r));
      resWriteMeta(next);
      return json(res, 200, next.find((r) => r.id === id));
    }
    if (p.startsWith("/api/resources/") && req.method === "DELETE" && p.split("/").length === 4) {
      const id = pathName(p.split("/")[3]);
      const rows = resReadMeta();
      const entry = rows.find((r) => r.id === id);
      if (!entry) return json(res, 404, { error: "no such resource" });
      for (const f of [entry.file, entry.thumb]) {
        if (!f) continue;
        try { fs.unlinkSync(path.join(RESOURCES, f)); } catch { /* already gone */ }
      }
      resWriteMeta(rows.filter((r) => r.id !== id));
      return json(res, 200, { ok: true, deleted: id });
    }
    if (p.startsWith("/api/resources/") && req.method === "POST" && p.endsWith("/use")) {
      const id = pathName(p.split("/")[3]);
      const entry = resReadMeta().find((r) => r.id === id);
      if (!entry) return json(res, 404, { error: "no such resource" });
      const body = await readJson(req);
      // Source pixels: the image itself, or the video's middle frame.
      const srcFile = entry.kind === "image" ? entry.file : entry.thumb;
      if (!srcFile || !fs.existsSync(path.join(RESOURCES, srcFile)))
        return json(res, 400, { error: "source image missing — re-upload the resource" });
      const srcBuf = fs.readFileSync(path.join(RESOURCES, srcFile));
      const refPrompt = entry.prompt ?? "";
      if (body.mode === "ref") {
        // Pinned reference of an EXISTING project (same mechanics as
        // POST /api/upload/ref, sourced from the library).
        const project = String(body.project || "");
        if (!isSafe(project)) return json(res, 400, { error: "project required" });
        let raw;
        try { raw = await dbGetScenario(project); }
        catch { return json(res, 503, { error: "database unavailable" }); }
        if (raw === null) return json(res, 404, { error: "no such project" });
        const storDir = await storageDirFor(project);
        const outDir = path.join(OUTPUTS, storDir);
        fs.mkdirSync(outDir, { recursive: true });
        const prefix = prefixFor(storDir);
        const v = nextVersion(outDir, prefix, "ref", 0, ".png");
        const file = v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`;
        fs.writeFileSync(path.join(outDir, file), srcBuf);
        // An upload is a deliberate choice — pin it as main.
        setMain(outDir, prefix, "ref", 0, null, file, { pinned: true });
        const { base: refBase } = splitDirSuffix(project);
        const refOwner = (pgUp ? await displayNameForFolder(refBase) : null) || cfgNameFor(project);
        pgRefreshProjectFiles(refOwner, storDir)
          .catch((e) => console.warn("[pg] catalog failed:", e.message));
        if (pgUp) {
          pgProjectId(refOwner).then(async (pid) => {
            if (pid == null) return;
            await pgAddReference({
              projectId: pid, dir: storDir, file, prompt: refPrompt || null,
              engine: engineForDir(storDir), source: "upload",
            });
          }).catch((e) => console.warn("[pg] reference record failed:", e.message));
        }
        return json(res, 200, { ok: true, mode: "ref", project, file });
      }
      // New project FROM this resource: the caption becomes the Master
      // Prompt and the pixels become the pinned reference visual — then the
      // exact Project workflow takes over (AI Craft beats, Generate).
      const newName = String(body.name || body.project || "").trim();
      if (!isSafe(newName)) return json(res, 400, { error: "project name required" });
      let taken = false;
      try { taken = (await dbGetScenario(newName)) !== null; }
      catch { return json(res, 503, { error: "database unavailable" }); }
      if (taken) return json(res, 409, { error: "a project with that name already exists" });
      if (pgUp) {
        try {
          const r = await pgPool.query("SELECT 1 FROM projects WHERE name = $1", [newName]);
          if (r.rowCount > 0) return json(res, 409, { error: "a project with that name already exists" });
        } catch { /* row check best-effort — the scenario check above governs */ }
      }
      const cfg = { description: "", referencePrompt: refPrompt, duration: 3, sequence: [] };
      if (pgUp) {
        try {
          await pgEnsureProject(newName, cfg);
          const claimed = await getFolderNameFromRow(newName);
          if (claimed) cfg.folder_name = claimed;
        } catch (e) { console.warn("[pg] resource project ensure failed:", e.message); }
      }
      if (!cfg.folder_name) cfg.folder_name = folderName(newName);
      await dbSaveScenario(newName, cfg);
      fs.writeFileSync(path.join(PROMPTS, newName + ".json"), JSON.stringify(cfg, null, 2));
      let project_id = null;
      if (pgUp) {
        try {
          const saved = await pgSaveVersionDelta(newName, null, cfg);
          project_id = saved.projectId;
        } catch (e) { console.warn("[pg] resource project save failed:", e.message); }
      }
      const folder = cfg.folder_name;
      const outDir = path.join(OUTPUTS, folder);
      fs.mkdirSync(outDir, { recursive: true });
      const prefix = prefixFor(folder);
      const file = `${prefix}_ref.png`;
      fs.writeFileSync(path.join(outDir, file), srcBuf);
      setMain(outDir, prefix, "ref", 0, null, file, { pinned: true });
      if (pgUp) {
        try {
          const pid = project_id ?? await pgProjectId(newName);
          if (pid != null) {
            await pgAddReference({
              projectId: pid, dir: folder, file, prompt: refPrompt || null,
              engine: engineForDir(folder), source: "upload",
            });
          }
        } catch (e) { console.warn("[pg] resource reference record failed:", e.message); }
      }
      return json(res, 200, { ok: true, mode: "new", name: newName });
    }
    if (p === "/api/resources/build-project" && req.method === "POST") {
      // Save the WHOLE Resource Library as one project: one beat per
      // resource (oldest upload first), each resource's AI prompt as its
      // scene image prompt, the first prompt as Master Prompt — through the
      // SAME project save path as every other project (scenarios row +
      // prompts JSON + projects row + one KEYFRAME/VIDEO project_assets row
      // per scene). Media is installed under the pipeline's own filename
      // pattern (<prefix>_seqN_<slug>.png / <prefix>_clipN_<slug>.mp4 /
      // <prefix>_ref.png) so Keyframes → clips, Story Board and Rendered
      // Clip resolve them by name with no frontend/path changes.
      let body;
      try { body = await readJson(req); }
      catch { return json(res, 400, { error: "bad json" }); }
      const name = String(body.name || "").trim();
      if (!isSafe(name)) return json(res, 400, { error: "project name required" });
      let taken = false;
      try { taken = (await dbGetScenario(name)) !== null; }
      catch { return json(res, 503, { error: "database unavailable" }); }
      if (taken) return json(res, 409, { error: "a project with that name already exists" });
      if (pgUp) {
        try {
          const r = await pgPool.query("SELECT 1 FROM projects WHERE name = $1", [name]);
          if (r.rowCount > 0) return json(res, 409, { error: "a project with that name already exists" });
        } catch { /* the scenario check above governs */ }
      }
      const entries = resReadMeta()
        .filter((r) => r && r.file && fs.existsSync(path.join(RESOURCES, r.file)))
        .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
      if (!entries.length)
        return json(res, 400, { error: "no resources yet — upload images/videos first" });
      if (!pgUp && !USE_SQLITE) return json(res, 503, { error: "database unavailable" });
      const beats = entries.map((e, i) => ({
        title: `Scene ${i + 1}`,
        image: String(e.prompt ?? "").trim(),
        motion: "",
      }));
      const cfg = {
        description: `Built from Resource Library (${entries.length} item${entries.length === 1 ? "" : "s"})`,
        referencePrompt: String(entries[0].prompt ?? "").trim(),
        duration: 3,
        presetId: "cinematic",
        sequence: beats,
      };
      // Claim the immutable storage folder FIRST (pgEnsureProject mints it
      // into the projects row; sqlite falls back to the slug) so media and
      // every DB path below agree on one folder.
      let folder;
      if (pgUp) {
        await pgEnsureProject(name, cfg);
        folder = await getFolderNameFromRow(name);
      } else {
        folder = folderName(name);
      }
      cfg.folder_name = folder;
      if (USE_SQLITE) {
        await dbSaveScenario(name, cfg);
        fs.writeFileSync(path.join(PROMPTS, name + ".json"), JSON.stringify(cfg, null, 2));
        pgSaveScenarioMirror(name, cfg).catch((e) => console.warn("[pg] scenario mirror failed:", e.message));
      } else {
        await dbSaveScenario(name, cfg);
        fs.writeFileSync(path.join(PROMPTS, name + ".json"), JSON.stringify(cfg, null, 2));
      }
      // Install every resource's pixels under the pipeline filename pattern.
      // Images convert to real PNG via ffmpeg (the keyframe scanner only
      // matches .png); videos install as the beat clip (.mp4, remuxed or
      // transcoded when the upload isn't mp4) with their middle frame as the
      // beat keyframe. Byte-copy fallbacks keep a viewable file even when
      // ffmpeg is unavailable.
      const outDir = path.join(OUTPUTS, folder);
      fs.mkdirSync(outDir, { recursive: true });
      const prefix = prefixFor(folder);
      const warnings = [];
      const toPng = async (srcFull, dstFull, what) => {
        if (srcFull.toLowerCase().endsWith(".png")) {
          fs.copyFileSync(srcFull, dstFull);
          return;
        }
        try {
          await runCmd("ffmpeg", ["-y", "-i", srcFull, dstFull], 60000);
        } catch (e) {
          fs.copyFileSync(srcFull, dstFull);
          warnings.push(`${what}: PNG convert failed (${e.message}) — kept original bytes.`);
        }
      };
      const toMp4 = async (srcFull, dstFull, what) => {
        if (srcFull.toLowerCase().endsWith(".mp4")) {
          fs.copyFileSync(srcFull, dstFull);
          return;
        }
        try {
          await runCmd("ffmpeg", ["-y", "-i", srcFull, "-c", "copy", dstFull], 120000);
        } catch {
          try {
            await runCmd("ffmpeg", ["-y", "-i", srcFull,
              "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", dstFull], 300000);
          } catch (e) {
            fs.copyFileSync(srcFull, dstFull);
            warnings.push(`${what}: MP4 convert failed (${e.message}) — kept original bytes.`);
          }
        }
      };
      const installedKf = {};
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const n = i + 1;
        const slug = fileSlug(beats[i].title);
        try {
          if (e.kind === "image") {
            const kf = `${prefix}_seq${n}_${slug}.png`;
            await toPng(path.join(RESOURCES, e.file), path.join(outDir, kf), `Scene ${n}`);
            setMain(outDir, prefix, "seq", n, beats[i].title, kf, { pinned: true });
            installedKf[n] = kf;
          } else {
            const cl = `${prefix}_clip${n}_${slug}.mp4`;
            await toMp4(path.join(RESOURCES, e.file), path.join(outDir, cl), `Scene ${n}`);
            setMain(outDir, prefix, "clip", n, beats[i].title, cl, { pinned: true });
            let thumb = e.thumb && fs.existsSync(path.join(RESOURCES, e.thumb)) ? e.thumb : null;
            if (!thumb) {
              try {
                const fresh = `${e.id}_thumb.jpg`;
                await extractMiddleFrame(path.join(RESOURCES, e.file), path.join(RESOURCES, fresh));
                if (fs.existsSync(path.join(RESOURCES, fresh))) {
                  thumb = fresh;
                  resWriteMeta(resReadMeta().map((r) => (r.id === e.id ? { ...r, thumb } : r)));
                }
              } catch { thumb = null; }
            }
            if (thumb) {
              const kf = `${prefix}_seq${n}_${slug}.png`;
              await toPng(path.join(RESOURCES, thumb), path.join(outDir, kf), `Scene ${n}`);
              setMain(outDir, prefix, "seq", n, beats[i].title, kf, { pinned: true });
              installedKf[n] = kf;
            } else {
              warnings.push(`Scene ${n}: no keyframe still (video thumbnail unavailable) — clip only.`);
            }
          }
        } catch (err) {
          warnings.push(`Scene ${n}: media install failed — ${err.message}`);
        }
      }
      // Pinned reference = Scene 1's keyframe pixels (same source the
      // per-card "Start project" flow installs, without re-converting).
      let refInstalled = null;
      if (installedKf[1]) {
        try {
          const refFile = `${prefix}_ref.png`;
          fs.copyFileSync(path.join(outDir, installedKf[1]), path.join(outDir, refFile));
          setMain(outDir, prefix, "ref", 0, null, refFile, { pinned: true });
          refInstalled = refFile;
        } catch (err) {
          warnings.push(`Reference install failed — ${err.message}`);
        }
      } else {
        warnings.push("Reference skipped — Scene 1 has no keyframe image.");
      }
      // Projects row already exists (pgEnsureProject above); the v1 full
      // snapshot adds one KEYFRAME + one VIDEO project_assets row per scene
      // (COMPLETED with file paths, since mains are on disk) and refreshes
      // the projects row. The reference gets its project_references row.
      let version = null;
      let project_id = null;
      if (pgUp) {
        try {
          const saved = await pgSaveVersionDelta(name, null, cfg);
          version = saved.version;
          project_id = saved.projectId;
        } catch (e) {
          warnings.push(`version snapshot failed: ${e.message}`);
          console.warn("[pg] build-project version save failed:", e.message);
        }
        if (project_id == null) {
          try { project_id = await pgProjectId(name); }
          catch { project_id = null; }
        }
        if (refInstalled && project_id != null) {
          try {
            await pgAddReference({
              projectId: project_id, dir: folder, file: refInstalled,
              prompt: cfg.referencePrompt || null,
              engine: engineForDir(folder), source: "upload",
            });
          } catch (e) {
            warnings.push(`reference record skipped: ${e.message}`);
            console.warn("[pg] build-project reference record failed:", e.message);
          }
        }
      }
      return json(res, 200, {
        ok: true, name, folder, scenes: entries.length,
        version, project_id, warnings,
      });
    }
    if (p === "/api/upload/keyframe" && req.method === "POST") {
      // Upload an image as beat N's keyframe. Stored as the next keyframe
      // version in outputs/<folder>/ and selected as main, so a later
      // clip (re)generation runs i2v from the uploaded image instead of the
      // Flux keyframe. Same versioning mechanics as every other asset.
      const body = await readJson(req);
      const scenario = String(body.scenario || "");
      const n = Number(body.index);
      if (!isSafe(scenario)) return json(res, 400, { error: "bad scenario" });
      if (!Number.isInteger(n) || n < 1) return json(res, 400, { error: "index (1-based beat) required" });
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:image\/\w+;base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:image base64 payload" });
      const buf = Buffer.from(m[1], "base64");
      if (!buf.length) return json(res, 400, { error: "empty image" });
      const storDir = await storageDirFor(scenario);
      const outDir = path.join(OUTPUTS, storDir);
      if (!fs.existsSync(outDir)) return json(res, 404, { error: "no outputs" });
      // Beat title feeds the versioned filename — resolve it from the
      // prompts JSON first, stored scenario copy as fallback. The title is
      // slugified into the filename (space-free); the raw title stays in
      // state.json lookups + DB beat_title.
      const { base: kfBase } = splitDirSuffix(scenario);
      const kfOwner = (pgUp ? await displayNameForFolder(kfBase) : null) || cfgNameFor(scenario);
      let title = null;
      const cfgPath = path.join(PROMPTS, kfOwner + ".json");
      try {
        if (fs.existsSync(cfgPath)) {
          const seq = JSON.parse(fs.readFileSync(cfgPath, "utf8")).sequence;
          title = Array.isArray(seq) ? seq[n - 1]?.title ?? null : null;
        }
      } catch { title = null; }
      if (title == null) {
        try {
          const raw = await dbGetScenario(kfOwner);
          const seq = raw ? JSON.parse(raw).sequence : null;
          title = Array.isArray(seq) ? seq[n - 1]?.title ?? null : null;
        } catch { title = null; }
      }
      if (title == null) return json(res, 400, { error: `no beat ${n}` });
      const prefix = prefixFor(storDir);
      const slugTitle = fileSlug(title);
      const v = nextVersion(outDir, prefix, "seq", n, ".png", title);
      const file = v === 1 ? `${prefix}_seq${n}_${slugTitle}.png` : `${prefix}_seq${n}_${slugTitle}_v${v}.png`;
      fs.writeFileSync(path.join(outDir, file), buf);
      // An upload is a deliberate choice — pin it as main.
      setMain(outDir, prefix, "seq", n, title, file, { pinned: true });
      pgMarkAssetComplete(kfOwner,
        { file, stage: "keyframe", index: n },
        { engine: engineForFolder(storDir), outputFolder: storDir })
        .then(() => pgRefreshProjectFiles(kfOwner, storDir))
        .catch((e) => console.warn("[pg] catalog failed:", e.message));
      return json(res, 200, await outputsPayload(storDir));
    }
    // ------------------------------------------------- AI Story Director
    // Story-to-Video workflow on top of the existing pipeline: the director
    // authors a storyboard (analysis -> bibles -> beats -> scenes) via the
    // local LLM; APPROVE hands a standard scenario config to the EXISTING
    // save/generation pipeline (client calls saveScenario, then opens the
    // workspace). No separate image/video implementation exists here.
    // Shared LLM call reusing the craft-endpoint convention (model "local",
    // thinking disabled). Parse failures save the raw response for debugging
    // and throw a useful error — nothing is silently discarded.
    async function llmChatJson({ system, user, maxTokens = 8000, temperature = 0.7, timeoutMs = 300000, rawTag = null }) {
      const base = (process.env.LLM_BASE || "").replace(/\/+$/, "");
      if (!base) throw new Error("LLM_BASE not set — the director needs the local LLM (LM Studio / llama-server).");
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          signal: ctl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "local",
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            temperature,
            max_tokens: maxTokens,
            chat_template_kwargs: { enable_thinking: false },
          }),
        });
        if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const d = await r.json();
        const text = String(d.choices?.[0]?.message?.content ?? "");
        try {
          return stripJson(text);
        } catch (e) {
          if (rawTag) {
            try {
              fs.mkdirSync(DIRECTOR, { recursive: true });
              fs.writeFileSync(path.join(DIRECTOR, rawTag), text);
            } catch { /* raw save is best-effort */ }
          }
          throw new Error(`${e.message}${rawTag ? ` (raw response saved to director/${rawTag})` : ""}`);
        }
      } catch (e) {
        if (e?.name === "AbortError") throw new Error("LLM timed out — the model may still be loading; the story is kept, try again.");
        throw e;
      } finally { clearTimeout(t); }
    }
    const directorBoardFile = (id) => path.join(DIRECTOR, `${id}.json`);
    const readDirectorBoard = (id) => {
      if (!isSafe(id)) throw new Error("bad board id");
      const f = directorBoardFile(id);
      if (!fs.existsSync(f)) throw new Error("board not found");
      return JSON.parse(fs.readFileSync(f, "utf8"));
    };
    const writeDirectorBoard = (board) => {
      fs.mkdirSync(DIRECTOR, { recursive: true });
      board.updatedAt = new Date().toISOString();
      fs.writeFileSync(directorBoardFile(board.id), JSON.stringify(board, null, 2));
      return board;
    };
    const directorBoardMeta = (b) => ({
      id: b.id,
      title: b.input?.title ?? b.id,
      status: b.status,
      scenes: Array.isArray(b.scenes) ? b.scenes.length : 0,
      sceneCount: b.sceneCount ?? 0,
      scenarioName: b.scenarioName ?? null,
      updatedAt: b.updatedAt ?? null,
    });
    const DIRECTOR_GENRES = ["Kids", "Devotional", "Adventure", "Fantasy", "Horror", "Comedy", "Educational", "Custom"];
    const DIRECTOR_STYLES = ["3D Preschool Animation", "3D Cinematic", "Realistic", "Anime", "Cartoon", "Indian Mythological", "Fantasy", "Custom"];
    const DIRECTOR_LANGS = ["Hindi", "English", "Hinglish"];
    const DIRECTOR_ASPECTS = ["16:9", "9:16", "1:1"];
    const DIRECTOR_AUDIO_EXTS = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4" };
    function directorValidateInput(body) {
      const b = body && typeof body === "object" ? body : {};
      const title = String(b.title || "").trim();
      let story = String(b.story || "").trim();
      if (!title) throw new Error("story title is required");
      // Optional song attachment (uploaded via POST /api/director/song-upload):
      // { file, fileName, durationSeconds, hasLyrics }. The song duration
      // drives the timeline (music-video mode); lyrics ride in `story`.
      let song = null;
      if (b.song && typeof b.song === "object") {
        const sf = String(b.song.file || "");
        if (!isSafe(sf) || !/\.(mp3|wav|m4a)$/i.test(sf) || !fs.existsSync(path.join(DIRECTOR, sf)))
          throw new Error("song file missing — re-upload the mp3");
        const dur = Math.round(Number(b.song.durationSeconds) || 0);
        song = {
          file: sf,
          fileName: String(b.song.fileName || "song.mp3").slice(0, 120),
          durationSeconds: dur > 0 ? dur : null,
          hasLyrics: b.song.hasLyrics !== false,
        };
      }
      if (song && !song.hasLyrics && story.length < 3)
        story = `[Instrumental song "${title}" — no lyrics provided; direct a matching visual story]`;
      if (story.length < 20) throw new Error(song
        ? "paste the song lyrics (20+ characters), or leave them empty for an instrumental visual story"
        : "story is too short — paste the full story");
      const language = DIRECTOR_LANGS.includes(b.language) ? b.language : "English";
      const genre = DIRECTOR_GENRES.includes(b.genre) ? b.genre : "Kids";
      const visualStyle = DIRECTOR_STYLES.includes(b.visualStyle) ? b.visualStyle : "3D Preschool Animation";
      const aspectRatio = DIRECTOR_ASPECTS.includes(b.aspectRatio) ? b.aspectRatio : "16:9";
      // Song mode: the timeline IS the song length (rounded, clamped).
      const wantedTarget = song?.durationSeconds
        ? Math.max(15, Math.min(3600, song.durationSeconds))
        : Math.max(15, Math.min(3600, Math.floor(Number(b.targetSeconds)) || 60));
      const targetSeconds = wantedTarget;
      const sceneSeconds = Math.max(1, Math.min(30, Math.floor(Number(b.sceneSeconds)) || 3));
      const sceneCount = sceneCountFor(targetSeconds, sceneSeconds);
      if (!sceneCount) throw new Error("could not derive a scene count from the durations");
      return {
        title,
        story,
        language,
        genre,
        genreCustom: genre === "Custom" ? String(b.genreCustom || "").trim() : "",
        visualStyle,
        styleCustom: visualStyle === "Custom" ? String(b.styleCustom || "").trim() : "",
        targetSeconds,
        sceneSeconds,
        aspectRatio,
        instructions: String(b.instructions || "").trim(),
        ...(song ? { song } : {}),
      };
    }
    // Song upload for the Director's music-video mode: base64 audio -> file
    // in director/ + ffprobe duration (drives the storyboard timeline).
    // No transcription here (the local LLM is text-only) — lyrics come from
    // the pasted text field, or the board runs instrumental from the title.
    if (p === "/api/director/song-upload" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:(audio\/[\w.+-]+);base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:audio/* base64 payload (mp3 or wav)" });
      const mime = m[1].toLowerCase();
      const ext = mime.includes("wav") ? ".wav" : mime.includes("mp4") || mime.includes("m4a") ? ".m4a"
        : mime.includes("mpeg") || mime.includes("mp3") ? ".mp3" : null;
      if (!ext) return json(res, 400, { error: `unsupported audio type ${mime} — upload mp3 or wav` });
      const buf = Buffer.from(m[2], "base64");
      if (!buf.length) return json(res, 400, { error: "empty file" });
      if (buf.length > 30 * 1024 * 1024) return json(res, 400, { error: "song over 30MB — trim it and re-upload" });
      const file = `song_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}${ext}`;
      fs.mkdirSync(DIRECTOR, { recursive: true });
      fs.writeFileSync(path.join(DIRECTOR, file), buf);
      const durationSeconds = await videoDurationSec(path.join(DIRECTOR, file));
      if (durationSeconds == null) {
        try { fs.unlinkSync(path.join(DIRECTOR, file)); } catch { /* already gone */ }
        return json(res, 400, { error: "could not read audio duration — is it a valid mp3/wav?" });
      }
      const originalName = String(body.fileName || "song").slice(0, 120) || "song";
      return json(res, 200, {
        file, fileName: originalName, durationSeconds: Math.round(durationSeconds),
        sizeBytes: buf.length,
      });
    }
    // Serve uploaded director audio (preview player + mux source).
    if (p.startsWith("/api/director/audio/") && req.method === "GET") {
      const file = decodeURIComponent(p.split("/")[4] || "");
      if (!isSafe(file) || !/\.(mp3|wav|m4a)$/i.test(file))
        return json(res, 400, { error: "bad audio file" });
      const full = path.join(DIRECTOR, file);
      if (!fs.existsSync(full)) return json(res, 404, { error: "audio not found" });
      const ctype = DIRECTOR_AUDIO_EXTS[path.extname(full).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": ctype, "Cache-Control": "no-store" });
      fs.createReadStream(full).pipe(res);
      return;
    }
    // Lay the board's uploaded song over an output dir's latest final cut:
    // <prefix>_with_song.mp4 (video stream-copied, song as the audio track,
    // -shortest so the file ends with whichever is shorter). Overwrites the
    // same file on repeat muxes — no version sprawl.
    if (p.match(/^\/api\/director\/boards\/[^/]+\/mux-song$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const songFile = board?.input?.song?.file;
      if (!songFile) throw new Error("this board has no uploaded song");
      const songFull = path.join(DIRECTOR, songFile);
      if (!fs.existsSync(songFull)) throw new Error("song file missing — re-upload the mp3");
      const body = await readJson(req).catch(() => ({}));
      if (!isSafe(body.dir)) return json(res, 400, { error: "bad dir" });
      const full = path.join(OUTPUTS, body.dir);
      let st = null;
      try { st = fs.statSync(full); } catch { st = null; }
      if (!st || !st.isDirectory()) return json(res, 404, { error: "unknown outputs dir" });
      const prefix = prefixForDir(body.dir);
      const vm = versionMap(full, prefix, []);
      const finals = [...(vm.final ?? [])].sort((a, b) => a.v - b.v);
      const from = finals.length ? finals[finals.length - 1].file : vm.finalMain;
      if (!from) return json(res, 400, { error: "no final cut yet — generate and stitch the video first" });
      const out = `${prefix}_with_song.mp4`;
      await runCmd("ffmpeg", ["-y", "-v", "error",
        "-i", path.join(full, from), "-i", songFull,
        "-c:v", "copy", "-map", "0:v:0", "-map", "1:a:0", "-shortest",
        path.join(full, out)], 120000);
      const songDur = await videoDurationSec(songFull);
      const finalDur = await videoDurationSec(path.join(full, from));
      return json(res, 200, { file: out, from, songDuration: songDur, finalDuration: finalDur });
    }
    if (p === "/api/director/boards" && req.method === "GET") {
      fs.mkdirSync(DIRECTOR, { recursive: true });
      const boards = fs.readdirSync(DIRECTOR).filter((f) => f.endsWith(".json") && !f.startsWith("_raw"));
      const list = [];
      for (const f of boards) {
        try { list.push(directorBoardMeta(JSON.parse(fs.readFileSync(path.join(DIRECTOR, f), "utf8")))); }
        catch { /* skip corrupt board files */ }
      }
      list.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return json(res, 200, list);
    }
    if (p === "/api/director/analyze" && req.method === "POST") {
      const input = directorValidateInput(await readJson(req));
      const raw = await llmChatJson({
        system: DIRECTOR_SYSTEM,
        user: buildBiblePrompt(input),
        maxTokens: 8000,
        temperature: 0.7,
        timeoutMs: 300000,
        rawTag: `_raw_${slug(input.title)}_bible.log`,
      });
      const blueprint = normalizeBlueprint(raw);
      if (!blueprint.characters.length && !blueprint.beats.length)
        throw new Error("director returned an empty blueprint — try again");
      const id = slug(input.title) || `story_${Date.now().toString(36)}`;
      const board = writeDirectorBoard({
        id,
        input,
        status: "analyzed",
        blueprint,
        scenes: [],
        sceneCount: sceneCountFor(input.targetSeconds, input.sceneSeconds),
        styleLock: styleLockFor(input.visualStyle, input.styleCustom),
        scenarioName: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return json(res, 200, board);
    }
    {
      // Board-scoped routes: GET/PUT/DELETE /api/director/boards/:id (board id
      // never contains slashes — isSafe enforced on read).
      const mBoard = p.match(/^\/api\/director\/boards\/([^/]+)$/);
      if (mBoard) {
        const id = decodeURIComponent(mBoard[1]);
        if (req.method === "GET") return json(res, 200, readDirectorBoard(id));
        if (req.method === "DELETE") {
          readDirectorBoard(id); // throws when missing
          fs.rmSync(directorBoardFile(id));
          return json(res, 200, { ok: true });
        }
        if (req.method === "PUT") {
          const board = readDirectorBoard(id);
          const patch = await readJson(req);
          // Rename the board (the approve target follows the board title, so
          // the created project is named exactly what the user entered).
          if (patch.input && typeof patch.input === "object") {
            const nt = String(patch.input.title || "").trim().slice(0, 120);
            if (nt) board.input.title = nt;
          }
          // Full-array merges for bible/scene edits from the storyboard UI.
          // Deleted scenes renumber the plan and shrink its total.
          if (patch.blueprint && typeof patch.blueprint === "object") {
            const nb = normalizeBlueprint({ ...board.blueprint, ...patch.blueprint });
            board.blueprint = nb;
          }
          for (const k of ["characters", "locations", "objects"]) {
            if (Array.isArray(patch[k])) {
              const norm = k === "characters" ? board.blueprint.characters.map((c, i) => ({ ...c, ...(patch[k][i] || {}) }))
                : board.blueprint[k].map((x, i) => ({ ...x, ...(patch[k][i] || {}) }));
              board.blueprint[k] = norm;
            }
          }
          if (Array.isArray(patch.scenes)) {
            board.scenes = patch.scenes.map((s, i) => normalizeScene(s, i + 1, board.input.sceneSeconds));
            board.sceneCount = board.scenes.length;
          }
          board.status = board.scenes.length ? "ready" : (board.blueprint ? "analyzed" : board.status);
          board.error = null;
          return json(res, 200, writeDirectorBoard(board));
        }
      }
    }
    if (p.match(/^\/api\/director\/boards\/[^/]+\/scenes$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      if (!board.blueprint) throw new Error("analyze the story first");
      const body = await readJson(req).catch(() => ({}));
      const done = board.scenes.length;
      const remaining = board.sceneCount - done;
      if (remaining <= 0) return json(res, 200, board);
      const n = Math.min(Math.max(1, Math.floor(Number(body.count)) || SCENE_BATCH), SCENE_BATCH, remaining);
      const beats = (board.blueprint.beats || []).slice();
      const prevScene = done > 0 ? board.scenes[done - 1] : null;
      // Prior spoken lines so the prompt can forbid verbatim repeats (late
      // batches used to re-plan the opening and copy scene-1 dialogue).
      const priorDialogue = [];
      for (const s of board.scenes) {
        for (const d of (s.dialogue || [])) {
          if (d && d.line) priorDialogue.push(String(d.line));
        }
      }
      const raw = await llmChatJson({
        system: DIRECTOR_SYSTEM,
        user: buildScenesPrompt({
          input: board.input, blueprint: board.blueprint, beats, prevScene,
          startNumber: done + 1, count: n, styleLock: board.styleLock,
          totalScenes: board.sceneCount, priorDialogue,
        }),
        maxTokens: 16000,
        temperature: 0.5,
        timeoutMs: 600000,
        rawTag: `_raw_${id}_scenes_${done + 1}.log`,
      });
      const got = Array.isArray(raw.scenes) ? raw.scenes : (Array.isArray(raw) ? raw : []);
      if (!got.length) throw new Error("director returned no scenes — try again");
      // Dedupe guard: the LLM sometimes repeats an earlier line verbatim
      // across batches. A repeated line carries no story value and is exactly
      // the "scene 1 copied to scene 45" report — drop the repeat so every
      // stored scene keeps only its own actual dialogue (action-only scenes
      // keep empty dialogue instead of filler).
      const seen = new Set(priorDialogue.map((l) => String(l || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim()).filter(Boolean));
      for (let i = 0; i < got.length && board.scenes.length < board.sceneCount; i++) {
        const normed = normalizeScene(got[i], board.scenes.length + 1, board.input.sceneSeconds);
        if (Array.isArray(normed.dialogue) && normed.dialogue.length) {
          const fresh = [];
          for (const d of normed.dialogue) {
            const key = String(d.line || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
            let dup = key && seen.has(key);
            if (!dup && key) {
              for (const s of board.scenes) {
                for (const pd of (s.dialogue || [])) {
                  if (pd && pd.line && sameLine(pd.line, d.line)) { dup = true; break; }
                }
                if (dup) break;
              }
            }
            if (dup) continue;
            fresh.push(d);
            if (key) seen.add(key);
          }
          normed.dialogue = normalizeDialogue(fresh);
        }
        board.scenes.push(normed);
      }
      board.status = board.scenes.length >= board.sceneCount ? "ready" : "scenes-partial";
      board.error = null;
      return json(res, 200, writeDirectorBoard(board));
    }
    if (p.match(/^\/api\/director\/boards\/[^/]+\/regenerate-scene$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      const body = await readJson(req);
      const index = Math.floor(Number(body.index));
      if (!Number.isInteger(index) || index < 0 || index >= board.scenes.length)
        throw new Error("bad scene index");
      const scene = board.scenes[index];
      const raw = await llmChatJson({
        system: DIRECTOR_SYSTEM,
        user: buildRegenPrompt({
          input: board.input, blueprint: board.blueprint, scene,
          prevScene: index > 0 ? board.scenes[index - 1] : null,
          nextScene: index < board.scenes.length - 1 ? board.scenes[index + 1] : null,
          styleLock: board.styleLock,
        }),
        maxTokens: 4000,
        temperature: 0.6,
        timeoutMs: 300000,
        rawTag: `_raw_${id}_regen_${scene.scene_number}.log`,
      });
      const fresh = raw.scene && typeof raw.scene === "object" ? raw.scene : raw;
      board.scenes[index] = normalizeScene(fresh, scene.scene_number, scene.duration_seconds);
      board.error = null;
      return json(res, 200, writeDirectorBoard(board));
    }
    if (p.match(/^\/api\/director\/boards\/[^/]+\/approve$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[4] || "");
      const board = readDirectorBoard(id);
      if (!board.scenes.length) throw new Error("nothing to approve — generate scenes first");
      const config = boardToScenario(board);
      // Project name = the story title verbatim (spaces allowed, like other
      // display names) — never silently slugified or taken from a stale
      // board. Same _2 suffix rule on collision.
      let target = String(board.input.title || "").trim().slice(0, 120) || id;
      try {
        const taken = new Set((await dbListScenarios()).map((r) => r.name));
        if (taken.has(target)) {
          for (let i = 2; ; i++) {
            if (!taken.has(`${target}_${i}`)) { target = `${target}_${i}`; break; }
          }
        }
      } catch { /* name check is best-effort; save enforces uniqueness */ }
      board.status = "approved";
      board.scenarioName = target;
      board.error = null;
      writeDirectorBoard(board);
      // The CLIENT persists via the existing saveScenario (PUT
      // /api/scenario/:name) — identical semantics to the Scenario Editor
      // Save — then opens the workspace for standard generation.
      return json(res, 200, { name: target, config });
    }
    if (p === "/api/outputs/stitch" && req.method === "POST") {
      const body = await readJson(req);
      if (!isSafe(body.scenario)) return json(res, 400, { error: "bad scenario" });
      const folder = await migrateProjectStorage(body.scenario);
      const run = startRun(body.scenario, {
        stitch: true,
        engine: body.engine || "ltx",
        format: body.format ?? (body.vertical ? "vertical" : undefined),
        storageFolder: folder,
        configName: body.scenario,
      });
      return json(res, 200, { id: run.id, folder });
    }
    // Short cut for Instagram Reels/Shorts: trim the dir's latest final cut
    // down to the first N seconds. Writes
    // outputs/<dir>/<prefix>_reel_<N>s.mp4 via stream copy (fast, lossless)
    // so the Reel panel can play the exact short; re-cutting the same length
    // overwrites the same file (no version sprawl). When the final is already
    // shorter than N seconds, no file is written — the final itself is the cut.
    if (p === "/api/reel-cut" && req.method === "POST") {
      const body = await readJson(req);
      if (!isSafe(body.dir)) return json(res, 400, { error: "bad dir" });
      const seconds = Math.floor(Number(body.seconds));
      if (![30, 60, 90].includes(seconds)) return json(res, 400, { error: "seconds must be 30, 60 or 90" });
      const full = path.join(OUTPUTS, body.dir);
      let st = null;
      try { st = fs.statSync(full); } catch { st = null; }
      if (!st || !st.isDirectory()) return json(res, 404, { error: "unknown outputs dir" });
      const prefix = prefixForDir(body.dir);
      const vm = versionMap(full, prefix, []);
      const finals = [...(vm.final ?? [])].sort((a, b) => a.v - b.v);
      const latest = finals.length ? finals[finals.length - 1].file : null;
      if (!latest) return json(res, 400, { error: "no final cut yet — create the video first" });
      const srcFull = path.join(full, latest);
      const dur = await videoDurationSec(srcFull);
      if (dur != null && dur <= seconds) {
        return json(res, 200, { file: latest, duration: dur, cut: false, from: latest, fromDuration: dur });
      }
      const outFile = `${prefix}_reel_${seconds}s.mp4`;
      const dstFull = path.join(full, outFile);
      try {
        await runCmd("ffmpeg", ["-y", "-i", srcFull, "-t", String(seconds),
          "-c", "copy", "-movflags", "+faststart", dstFull], 120000);
      } catch (e) {
        return json(res, 500, { error: `cut failed: ${e.message || e}` });
      }
      const outDur = await videoDurationSec(dstFull);
      return json(res, 200, { file: outFile, duration: outDur ?? seconds, cut: true, from: latest, fromDuration: dur });
    }
    // Preview of the exact LLM messages a craft would send (AI Craft
    // "View Prompt" popup). No LLM call, nothing persisted — the UI lets the
    // user review/edit the user message, then POSTs it back as `userPrompt`.
    if (p === "/api/craft-preview" && req.method === "POST") {
      const body = await readJson(req);
      // description may be omitted when target names a stored project — the
      // brief then falls back to the database / prompts JSON copy.
      if (!body.description && !body.topic && !body.target)
        return json(res, 400, { error: "description required" });
      try {
        const brief = await buildCraftPreview(body);
        return json(res, 200, {
          system: brief.system,
          user: brief.user,
          presetName: brief.presetMeta ? brief.presetMeta.name : null,
          rulesApplied: !brief.noRules,
          // Where the brief was read from: "database" | "json" | "request".
          source: brief.briefFrom || "request",
          project: typeof body.target === "string" && body.target ? body.target : null,
        });
      } catch (e) {
        return json(res, 400, { error: String(e.message || "preview failed") });
      }
    }
    if (p === "/api/craft" && req.method === "POST") {
      const body = await readJson(req);
      // Current UI sends { description, masterPrompt }; accept legacy
      // { topic, requirements } too — both are LLM-only inputs, never stored.
      // description may be omitted when target names a stored project (the
      // brief falls back to the database / prompts JSON copy, same as preview).
      if (!body.description && !body.topic && !body.target)
        return json(res, 400, { error: "description required" });
      const crafted = await craftScenario(body);
      // Craft persists the project immediately (before any Save): the row
      // exists in projects from the click on, and Save Scenario later reuses
      // this same project_id for its project_assets rows.
      let project_id = null;
      // Targeted craft: the UI asked to re-craft the OPEN project (body.target
      // names an existing scenario). Keep that SAME name — the next Save then
      // stores a new version of the project (delta rows for changed scenes
      // only) instead of minting a new project. The project row already
      // exists, so nothing is inserted here.
      const target = typeof body.target === "string" && isSafe(body.target) ? body.target : null;
      let targeted = false;
      if (target && pgUp) {
        try {
          if ((await dbGetScenario(target)) !== null) {
            crafted.name = target;
            targeted = true;
            project_id = await pgProjectId(target);
          }
        } catch (e) { console.warn("[pg] craft target lookup failed:", e.message); }
      }
      if (pgUp && !targeted) {
        try {
          // Unique name: never clobber an existing scenario/project (the
          // editor would show it as a _2 draft otherwise, orphaning this row).
          let target = crafted.name;
          for (let i = 2; ; i++) {
            const takenSqlite = (await dbGetScenario(target)) !== null;
            let takenPg = false;
            try {
              const r = await pgPool.query("SELECT 1 FROM projects WHERE name = $1", [target]);
              takenPg = r.rowCount > 0;
            } catch { takenPg = false; }
            if (!takenSqlite && !takenPg) break;
            target = `${crafted.name}_${i}`;
          }
          crafted.name = target;
          const cfg = { ...crafted.config };
          // Drop any legacy brief fields that may have ridden along.
          delete cfg.topic;
          delete cfg.requirements;
          project_id = await pgEnsureProject(target, cfg);
          // Stamp the minted immutable folder into the crafted config so the
          // draft Save (PUT) keeps the same storage identity.
          try {
            const claimed = await getFolderNameFromRow(target);
            if (claimed) {
              cfg.folder_name = claimed;
              crafted.config = { ...crafted.config, folder_name: claimed };
            }
          } catch { /* row keeps it; PUT re-resolves */ }
        } catch (e) { console.warn("[pg] craft project save failed:", e.message); }
      }
      return json(res, 200, { ...crafted, project_id });
    }
    if (p === "/api/craft-beat" && req.method === "POST") {
      const body = await readJson(req);
      const cfg = body.config;
      if (!cfg || !Array.isArray(cfg.sequence)) return json(res, 400, { error: "config with sequence required" });
      // Explicit preset override wins; otherwise the saved config's presetId
      // applies (craftNextBeats sanitizes both via resolvePresetId).
      // A presetRules string overrides the preset file for this call only;
      // an empty string clears the project override back to the preset file.
      if (typeof body.presetId === "string") cfg.presetId = body.presetId;
      if (typeof body.presetRules === "string") {
        if (body.presetRules.trim()) cfg.presetRules = body.presetRules.trim();
        else delete cfg.presetRules;
      }
      const count = Math.max(1, Number(body.count) || 1);
      return json(res, 200, { beats: await craftNextBeats(cfg, count) });
    }
    // Append the Master Prompt to every scene's keyframe image prompt
    // (same rules as craft-time fan-out: blank = no-op, never double-appends,
    // motion never touched).
    // Stateless — the caller (AI Craft "Apply to All Scene") persists the
    // returned sequence via the normal draft/save path.
    if (p === "/api/apply-master" && req.method === "POST") {
      const body = await readJson(req);
      const cfg = body.config;
      if (!cfg || !Array.isArray(cfg.sequence)) return json(res, 400, { error: "config with sequence required" });
      return json(res, 200, { sequence: applyMasterToBeats(cfg.sequence, body.master ?? "") });
    }
    // Publishing metadata (title / description / hashtags) for a scenario,
    // drafted by the local LLM from the scenario JSON. Stateless — nothing
    // is persisted; the UI caches it per project in localStorage.
    if (p === "/api/video-meta" && req.method === "POST") {
      const body = await readJson(req);
      const cfg = body.config;
      if (!cfg || !Array.isArray(cfg.sequence)) return json(res, 400, { error: "config with sequence required" });
      return json(res, 200, await craftVideoMeta(cfg));
    }
    // Single Master Prompt from Description + Video Type (Create New Project
    // "Get by AI" button). Stateless — the dialog fills its Master Prompt box
    // with the result; nothing is persisted.
    if (p === "/api/master-prompt" && req.method === "POST") {
      const body = await readJson(req);
      const description = String(body.description ?? body.topic ?? "").trim();
      if (!description) return json(res, 400, { error: "description required" });
      try {
        return json(res, 200, await craftMasterPrompt({
          description,
          presetId: body.presetId,
          presetRules: body.presetRules,
        }));
      } catch (e) {
        console.error("[master-prompt] failed:", e.message);
        return json(res, 502, { error: String(e.message || "master prompt failed") });
      }
    }
    // Predefined video-type presets (system-owned presets/*.md defaults).
    // List carries metadata only; content is fetched per id when needed
    // (craft prompt injection, View/edit-rules panel). Per-project edits are
    // stored on the project as `presetRules` and never touch presets/*.md.
    if (p === "/api/presets" && req.method === "GET") {
      try {
        return json(res, 200, GetAvailablePresets());
      } catch (e) {
        console.error("[presets] list failed:", e.message);
        return json(res, 500, { error: "presets unavailable" });
      }
    }
    if (p.startsWith("/api/presets/") && req.method === "GET" && p.split("/").length === 4) {
      const id = pathName(p.split("/")[3]);
      try {
        const { meta, content } = GetPresetContent(id);
        return json(res, 200, {
          id: meta.id, name: meta.name, category: meta.category,
          description: meta.description, content,
        });
      } catch (e) {
        // Unknown id OR missing file: 400 with a clear message, never a
        // stack trace — and never an arbitrary filesystem read (ids are
        // registry-validated inside GetPresetContent).
        return json(res, 400, { error: String(e.message || "Invalid preset selected.") });
      }
    }
    if (p === "/api/comfy" && req.method === "GET") return json(res, 200, await comfyStatus());
    // Combined health for the Home page (one round trip). Each service is
    // probed independently — an offline LLM/ComfyUI never blocks project data.
    if (p === "/api/health" && req.method === "GET") {
      const [dbUp, comfy, llm] = await Promise.all([
        pgProbe().catch(() => false),
        comfyStatus().catch(() => ({ up: false, error: "status check failed" })),
        llmStatus().catch(() => ({ up: false, error: "status check failed" })),
      ]);
      const q = (comfy && comfy.queue) || {};
      return json(res, 200, {
        db: { up: !!dbUp },
        comfy: {
          up: !!comfy.up,
          queueRunning: Array.isArray(q.queue_running) ? q.queue_running.length : null,
          queuePending: Array.isArray(q.queue_pending) ? q.queue_pending.length : null,
          error: comfy.error,
        },
        llm: { up: !!llm.up, error: llm.error },
      });
    }
    // Aggregated Home-page dashboard (statistics + per-project progress).
    if (p === "/api/dashboard" && req.method === "GET") {
      try {
        return json(res, 200, await dashboardPayload());
      } catch (e) {
        console.warn("[dashboard] failed:", e.message);
        return json(res, 500, { error: "dashboard unavailable" });
      }
    }
    // Narrow project_assets rows for a project (one row per asset).
    // GET /api/project/:name/assets[?version=N][&mode=exact] — version
    // defaults to latest. Default mode is EFFECTIVE: because versions are
    // delta-based (v2 may hold only beat 3), the response resolves the
    // latest applicable row per (beat_index, asset_type) with
    // version <= requested, so callers always see the full project state
    // (beat 1 -> v1, beat 3 -> v2, ...). mode=exact returns only the raw
    // delta rows stored at that version (for version history).
    if (p.startsWith("/api/project/") && p.endsWith("/assets") && req.method === "GET") {
      const segs = p.split("/");
      const name = decodeURIComponent(segs[3] || "");
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      if (!pgUp) return json(res, 503, { error: "database unavailable" });
      const pid = await pgProjectId(name);
      if (pid == null) return json(res, 200, []);
      // Missing ?version= means latest. The DB fallback is NULL with zero
      // version rows — latestVersionOf maps that (and any other phantom like
      // Number(null) === 0) to null so the endpoint returns [] instead of
      // querying a version that can never exist.
      const versionParam = u.searchParams.get("version");
      let version = versionParam == null || versionParam === "" ? NaN : Number(versionParam);
      if (!Number.isInteger(version)) {
        const r = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
        version = latestVersionOf(r.rows[0]?.v) ?? NaN;
      }
      if (!Number.isInteger(version)) return json(res, 200, []);
      const mode = String(u.searchParams.get("mode") || "").toLowerCase();
      const exact = mode === "exact" || mode === "delta" || mode === "raw" ||
        u.searchParams.get("exact") === "1";
      // Cut-scoped history: YOUTUBE (landscape main cut) by default, INSTAGRAM
      // (vertical Reel cut) on request — the two cuts keep independent rows.
      const vtParam = String(u.searchParams.get("video_type") || "").toUpperCase();
      const videoType = vtParam === "INSTAGRAM" ? "INSTAGRAM" : "YOUTUBE";
      const r = await pgPool.query(exact ? EXACT_VERSION_SQL : EFFECTIVE_ASSETS_SQL, [pid, version, videoType]);
      return json(res, 200, r.rows);
    }
    // Reference visuals for a project (one row per generation/upload).
    // GET /api/project/:name/references[?dir=<outputDir>] — is_main marks the
    // record selected as main on the UI. This is what the Reference section
    // of the gallery displays.
    if (p.startsWith("/api/project/") && p.endsWith("/references") && req.method === "GET") {
      const segs = p.split("/");
      const name = decodeURIComponent(segs[3] || "");
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      if (!pgUp) return json(res, 503, { error: "database unavailable" });
      const pid = await pgProjectId(name);
      if (pid == null) return json(res, 200, []);
      const dir = u.searchParams.get("dir");
      const r = dir && isSafe(dir)
        ? await pgPool.query(
          `SELECT id, project_id, output_dir, version, prompt, negative_prompt, file_path,
                  model, workflow, seed, attempts, source, video_type, is_main, pinned, metadata,
                  started_at, completed_at, created_at, updated_at
           FROM project_references WHERE project_id = $1 AND output_dir = $2
           ORDER BY created_at ASC, id ASC`,
          [pid, dir])
        : await pgPool.query(
          `SELECT id, project_id, output_dir, version, prompt, negative_prompt, file_path,
                  model, workflow, seed, attempts, source, video_type, is_main, pinned, metadata,
                  started_at, completed_at, created_at, updated_at
           FROM project_references WHERE project_id = $1
           ORDER BY output_dir ASC, created_at ASC, id ASC`,
          [pid]);
      return json(res, 200, r.rows);
    }
    if (p === "/api/db" && req.method === "GET") {
      if (!(await pgProbe())) return json(res, 200, { up: false });
      const [s, pj, pa, pr] = await Promise.all([
        pgPool.query("SELECT count(*)::int AS n FROM scenarios"),
        pgPool.query("SELECT count(*)::int AS n FROM projects").catch(() => ({ rows: [{ n: null }] })),
        pgPool.query("SELECT count(*)::int AS n FROM project_assets").catch(() => ({ rows: [{ n: null }] })),
        pgPool.query("SELECT count(*)::int AS n FROM project_references").catch(() => ({ rows: [{ n: null }] })),
      ]);
      return json(res, 200, { up: true, scenarios: s.rows[0].n, projects: pj.rows[0].n, project_assets_linked: pa.rows[0].n, references: pr.rows[0].n });
    }
    if (p.startsWith("/outputs/")) {
      const [, , scenario, file] = p.split("/");
      return serveOutput(res, decodeURIComponent(scenario), decodeURIComponent(file));
    }
    if (p.startsWith("/resources/")) {
      const [, , file] = p.split("/");
      return serveResource(res, decodeURIComponent(file));
    }
    if (p.startsWith("/api/")) return json(res, 404, { error: "unknown route" });
    serveStatic(req, res, p === "/" ? "/index.html" : p);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    console.error(`port ${PORT} is already in use — a server is already running (run only one 'npm run serve' at a time).`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, () => console.log(`frontend server on http://localhost:${PORT}`));
