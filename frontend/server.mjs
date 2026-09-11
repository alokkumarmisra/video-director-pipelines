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
  planDelta,
  resolveEffective,
  EFFECTIVE_ASSETS_SQL,
  EXACT_VERSION_SQL,
} from "../lib/project_versioning.mjs";

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
    db.prepare(`INSERT INTO scenarios (name, config, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`)
      .run(name, JSON.stringify(cfg), Date.now());
    return;
  }
  await pgPool.query(
    `INSERT INTO scenarios (name, config, updated_at_ms) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at_ms = EXCLUDED.updated_at_ms`,
    [name, JSON.stringify(cfg), Date.now()]);
};
const dbDeleteScenario = async (name) => {
  if (USE_SQLITE) { db.prepare("DELETE FROM scenarios WHERE name = ?").run(name); return; }
  await pgPool.query("DELETE FROM scenarios WHERE name = $1", [name]);
};

// ---------------------------------------------------------------- pg catalog
// Every generated image/video is indexed in Postgres `video_generator`
// (binaries stay in outputs/ — the DB is the catalog). The gallery file list
// is served from here, so logging in reads your generations from the DB.
// If Postgres is down the server keeps working from disk (pgUp === false).
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
CREATE TABLE IF NOT EXISTS assets (
  id BIGSERIAL PRIMARY KEY,
  scenario TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reference','keyframe','clip','final','other')),
  file TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  beat_index INT,
  beat_title TEXT,
  version INT,
  engine TEXT NOT NULL DEFAULT 'ltx' CHECK (engine IN ('ltx','wan')),
  mtime TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scenario, file)
);
CREATE INDEX IF NOT EXISTS assets_scenario_idx ON assets (scenario);
CREATE INDEX IF NOT EXISTS assets_kind_idx ON assets (kind);
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
  description TEXT,
  topic TEXT,
  requirements TEXT,
  duration INT,
  beats INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_assets (
  id BIGSERIAL NOT NULL,
  project_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  scene_id INTEGER,
  beat_index INTEGER NOT NULL DEFAULT 0,
  beat_title TEXT,
  asset_type TEXT NOT NULL,
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
  CONSTRAINT project_assets_status_check CHECK (
    status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED')),
  CONSTRAINT project_assets_version_check CHECK (version > 0),
  CONSTRAINT project_assets_beat_index_check CHECK (beat_index >= 0),
  CONSTRAINT project_assets_attempts_check CHECK (
    attempts >= 0 AND max_retries >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_assets_project_version_type_beat_key
  ON public.project_assets(project_id, version, asset_type, beat_index);
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
FOR EACH ROW EXECUTE FUNCTION public.update_project_assets_updated_at();`;
// NOTE: project_assets uses the narrow canonical DDL above (one row per
// asset: REFERENCE / KEYFRAME / VIDEO (+ IMAGE for ad-hoc stills), with a
// single status/prompt/file_path per row; scene_id is the INTEGER scene
// number (0 = reference, N = beat N). A TEXT scene_id from the previous
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
// filename -> { kind, beat_index, beat_title, version }
function classifyAsset(file) {
  let m = file.match(/_seq(\d+)_(.+)\.png$/);
  if (m) return splitBeat("keyframe", Number(m[1]), m[2]);
  m = file.match(/_clip(\d+)_(.+)\.mp4$/);
  if (m) return splitBeat("clip", Number(m[1]), m[2]);
  m = file.match(/_ref(?:_v(\d+))?\.png$/);
  if (m) return { kind: "reference", beat_index: null, beat_title: null, version: m[1] ? Number(m[1]) : 1 };
  m = file.match(/_final(?:_v(\d+))?\.mp4$/);
  if (m) return { kind: "final", beat_index: null, beat_title: null, version: m[1] ? Number(m[1]) : 1 };
  return { kind: "other", beat_index: null, beat_title: null, version: null };
  function splitBeat(kind, idx, rest) {
    let version = 1;
    const vm = rest.match(/^(.*)_v(\d+)$/);
    if (vm) { rest = vm[1]; version = Number(vm[2]); }
    return { kind, beat_index: idx, beat_title: rest, version };
  }
}
function assetRow(folder, file) {
  const full = path.join(OUTPUTS, folder, file);
  let st;
  try { st = fs.statSync(full); } catch { return null; }
  if (!st.isFile()) return null;
  const c = classifyAsset(file);
  return {
    scenario: folder, kind: c.kind, file, rel_path: `outputs/${folder}/${file}`,
    bytes: st.size, beat_index: c.beat_index, beat_title: c.beat_title, version: c.version,
    engine: folder.endsWith("_wan") ? "wan" : "ltx", mtimeISO: st.mtime.toISOString(),
  };
}
const ASSET_COLUMNS = `(scenario, kind, file, rel_path, bytes, beat_index, beat_title, version, engine, mtime)`;
const ASSET_CONFLICT = `ON CONFLICT (scenario, file) DO UPDATE SET bytes = EXCLUDED.bytes, beat_index = EXCLUDED.beat_index,
  beat_title = EXCLUDED.beat_title, version = EXCLUDED.version, engine = EXCLUDED.engine, mtime = EXCLUDED.mtime`;
const ASSET_UPSERT = `INSERT INTO assets ${ASSET_COLUMNS}
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
${ASSET_CONFLICT}`;
const rowParams = (r) => [r.scenario, r.kind, r.file, r.rel_path, r.bytes, r.beat_index, r.beat_title, r.version, r.engine, r.mtimeISO];
async function pgInsertAssetRows(rows) {
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const vals = batch.map((_, bi) => {
      const o = bi * 10;
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}::timestamptz)`;
    }).join(", ");
    const params = batch.flatMap(rowParams);
    await pgPool.query(`INSERT INTO assets ${ASSET_COLUMNS} VALUES ${vals} ${ASSET_CONFLICT}`, params);
  }
}
// Index one fresh file (called on every finished generation + ref upload).
async function pgUpsertAsset(folder, file) {
  if (!pgUp) return;
  const row = assetRow(folder, file);
  if (!row) return;
  await pgPool.query(ASSET_UPSERT, rowParams(row));
}
// Reconcile a whole output dir (called when a run exits).
async function pgSyncFolder(folder) {
  if (!pgUp) return;
  const dir = path.join(OUTPUTS, folder);
  if (!fs.existsSync(dir)) return;
  const rows = fs.readdirSync(dir)
    .filter((f) => /\.(png|mp4)$/i.test(f))
    .map((f) => assetRow(folder, f))
    .filter(Boolean);
  await pgInsertAssetRows(rows);
}
// Full backfill on boot (files created while the server was down).
async function syncAllToPg() {
  const rows = [];
  // outputs/ may have been wiped — a missing dir means zero assets, not a crash.
  if (fs.existsSync(OUTPUTS)) {
    for (const folder of fs.readdirSync(OUTPUTS)) {
      const dir = path.join(OUTPUTS, folder);
      let files = [];
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        files = fs.readdirSync(dir);
      } catch { continue; } // folder removed mid-scan — skip it
      for (const file of files) {
        if (!/\.(png|mp4)$/i.test(file)) continue;
        const r = assetRow(folder, file);
        if (r) rows.push(r);
      }
    }
  }
  await pgInsertAssetRows(rows);
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
      await pgSaveProject(name, cfg, Number(version), mainsFor(name, cfg), name);
    } catch (e) { console.warn(`[pg] project backfill failed for ${name}:`, e.message); }
  }
  console.log(`[pg] catalog synced (${rows.length} assets)`);
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
  await pgPool.query("DELETE FROM assets WHERE scenario = $1 OR scenario = $2", [name, `${name}_wan`]);
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
async function pgEnsureProject(name, cfg) {
  const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
  const proj = await pgPool.query(
    `INSERT INTO projects (name, description, topic, requirements, duration, beats, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, topic = EXCLUDED.topic,
       requirements = EXCLUDED.requirements, duration = EXCLUDED.duration, beats = EXCLUDED.beats,
       updated_at = now()
     RETURNING project_id`,
    [name, cfg.description ?? null, cfg.topic ?? null, cfg.requirements ?? null,
     Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null, seq.length]);
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
//   asset_type='REFERENCE', beat_index=0 -> Flux reference visual
//   asset_type='KEYFRAME',  beat_index=N -> beat N Flux keyframe (b.image)
//   asset_type='VIDEO',     beat_index=N -> beat N i2v clip (b.motion)
//   asset_type='FINAL',     beat_index=V -> stitch V of the final cut
//     (v1 = <prefix>_final.mp4, vN = <prefix>_final_vN.mp4; one NEW row per
//     stitch, scene_id 0, workflow 'ffmpeg-concat')
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
const engineForFolder = (folder) => (String(folder || "").endsWith("_wan") ? "wan" : "ltx");
// Project info row + that version's asset rows (prompts + current main files).
// SNAPSHOT path — used ONLY for version 1 and for backfilling projects that
// have no project_assets rows yet. For v2+ use pgSaveVersionDelta() below,
// which inserts ONLY the changed scenes (delta-based versioning).
// Narrow schema: ONE ROW PER ASSET —
//   asset_type='REFERENCE', beat_index=0        -> Flux reference visual
//   asset_type='KEYFRAME',  beat_index=N        -> beat N Flux keyframe (b.image)
//   asset_type='VIDEO',     beat_index=N        -> beat N i2v clip (b.motion)
// ('IMAGE' stays valid for ad-hoc single stills; this pipeline writes
// KEYFRAME for beat images.) Each row carries its own prompt/status/
// file_path/model/workflow/attempts/metadata/timing. Size/dims live inside
// metadata (no width/height columns in the narrow DDL).
// Existing COMPLETED rows are never downgraded back to PENDING.
async function pgSaveProject(name, cfg, version, mains, outputFolder = null) {
  const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
  const projectId = await pgEnsureProject(name, cfg);
  const folder = outputFolder ?? name;
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
      project_id, version, scene_id, beat_index, beat_title,
      asset_type, status, prompt, negative_prompt, file_path,
      model, workflow, attempts, max_retries, metadata, started_at, completed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 3, $14::jsonb,
      $15::timestamptz, $16::timestamptz
    )
    ON CONFLICT (project_id, version, asset_type, beat_index) DO UPDATE SET
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
  // Reference visual.
  {
    const refFile = mains.ref ?? null;
    const rf = diskFacts(folder, refFile);
    await pgPool.query(UPSERT, [projectId, version, sceneId(0), 0, null,
      "REFERENCE", done(refFile), cfg.referencePrompt ?? null, negative,
      relPath(refFile), REF_MODEL, REF_WORKFLOW, refFile ? 1 : 0,
      refFile ? JSON.stringify({ engine, file: refFile, version, ...rf }) : null,
      refFile ? nowISO : null, refFile ? nowISO : null]);
  }
  for (let i = 0; i < seq.length; i++) {
    const b = seq[i] || {};
    const n = i + 1;
    const bm = (mains.beats && mains.beats[String(n)]) || {};
    const kf = bm.keyframeMain ?? null;
    const cl = bm.clipMain ?? null;
    const kfFacts = diskFacts(folder, kf);
    const clFacts = diskFacts(folder, cl);
    await pgPool.query(UPSERT, [projectId, version, sceneId(n), n, b.title ?? null,
      "KEYFRAME", done(kf), b.image ?? null, negative,
      relPath(kf), IMG_MODEL, IMG_WORKFLOW, kf ? 1 : 0,
      kf ? JSON.stringify({ engine, file: kf, beat: n, ...kfFacts }) : null,
      kf ? nowISO : null, kf ? nowISO : null]);
    await pgPool.query(UPSERT, [projectId, version, sceneId(n), n, b.title ?? null,
      "VIDEO", done(cl), b.motion ?? null, negative,
      relPath(cl), videoModel, videoWorkflow, cl ? 1 : 0,
      cl ? JSON.stringify({ engine, file: cl, beat: n, fps: videoFps, duration: videoDur, ...clFacts }) : null,
      cl ? nowISO : null, cl ? nowISO : null]);
  }
  // Stitched final cut (one row per stitch; beat_index = stitch version).
  if (mains.final) {
    const finalV = mains.finalV ?? finalCutVersion(mains.final) ?? 1;
    const ff = diskFacts(folder, mains.final);
    await pgPool.query(UPSERT, [projectId, version, 0, finalV, null,
      "FINAL", "COMPLETED", null, negative,
      relPath(mains.final), null, "ffmpeg-concat", 1,
      JSON.stringify({ engine, file: mains.final, final_version: finalV, ...ff }),
      nowISO, nowISO]);
  }
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
    const proj = await client.query(
      `INSERT INTO projects (name, description, topic, requirements, duration, beats, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, topic = EXCLUDED.topic,
         requirements = EXCLUDED.requirements, duration = EXCLUDED.duration, beats = EXCLUDED.beats,
         updated_at = now()
       RETURNING project_id`,
      [name, cfg.description ?? null, cfg.topic ?? null, cfg.requirements ?? null,
        Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null, seq.length]);
    const projectId = proj.rows[0]?.project_id;
    if (projectId == null) throw new Error(`pgSaveVersionDelta: no project_id for ${name}`);
    const previousVersion = Number(version) - 1;
    const plan = planDelta(prevCfg, cfg);
    const negative = cfg.negative ?? null;
    const INSERT = `INSERT INTO project_assets (
        project_id, version, scene_id, beat_index, beat_title,
        asset_type, status, prompt, negative_prompt, file_path,
        model, workflow, attempts, max_retries, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, NULL, $9, $10, 0, 3, $11::jsonb
      )
      ON CONFLICT (project_id, version, asset_type, beat_index) DO UPDATE SET
        scene_id = EXCLUDED.scene_id, beat_title = EXCLUDED.beat_title,
        prompt = EXCLUDED.prompt, negative_prompt = EXCLUDED.negative_prompt,
        model = EXCLUDED.model, workflow = EXCLUDED.workflow,
        metadata = COALESCE(EXCLUDED.metadata, project_assets.metadata)`;
    const insertedIds = [];
    const changedScenes = [];
    const changedAssetTypes = [];
    if (Number(version) === 1) {
      // v1 = full snapshot: every scene gets its row (with current main
      // files, as pgSaveProject does). Delegate row-by-row on this client.
      const mains = mainsFor(name, cfg);
      const folder = name;
      const engine = engineForFolder(folder);
      const full = async (sceneId, beat, title, type, prompt, model, workflow, file, meta) => {
        const r = await client.query(
          `${INSERT} RETURNING id`,
          [projectId, version, sceneId, beat, title ?? null, type, prompt ?? null,
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
      await full(0, 0, null, "REFERENCE", cfg.referencePrompt ?? null, REF_MODEL, REF_WORKFLOW,
        mains.ref ?? null, diskFacts(folder, mains.ref ?? null));
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
    } else {
      // v2+ = delta only: insert PENDING rows for changed scenes, nothing else.
      const folder = name;
      const engine = engineForFolder(folder);
      if (plan.ref) {
        const r = await client.query(
          `${INSERT} RETURNING id`,
          [projectId, version, 0, 0, null, "REFERENCE", cfg.referencePrompt ?? null,
            negative, REF_MODEL, REF_WORKFLOW, JSON.stringify({ engine })]);
        insertedIds.push(r.rows[0].id);
        changedScenes.push(0);
        changedAssetTypes.push("REFERENCE");
      }
      for (const [beatStr, types] of Object.entries(plan.beats)) {
        const n = Number(beatStr);
        const b = seq[n - 1] || {};
        for (const type of types) {
          const prompt = type === "KEYFRAME" ? (b.image ?? null) : (b.motion ?? null);
          const model = type === "KEYFRAME" ? IMG_MODEL : (engine === "wan" ? WAN_MODEL : LTX_MODEL);
          const workflow = type === "KEYFRAME" ? IMG_WORKFLOW : (engine === "wan" ? WAN_WORKFLOW : LTX_WORKFLOW);
          const r = await client.query(
            `${INSERT} RETURNING id`,
            [projectId, version, n, n, b.title ?? null, type, prompt,
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
// Mark ONE asset row COMPLETED the moment its file finishes generating
// (called per [asset] event, so rows flip one by one).
// RETRY SAFE: a failed generation retried via --regen only re-runs the
// single asset and UPDATEs its existing row here — it never inserts a new
// project version (versions are created only by pgSaveVersionDelta on an
// actual prompt/scene change). Status/progress/error updates likewise stay
// on the same row.
// asset: { file, stage: 'reference'|'keyframe'|'clip'|'final', index? }
// Stage -> (asset_type, beat_index): reference -> (REFERENCE, 0),
// keyframe -> (KEYFRAME, N), clip -> (VIDEO, N), final -> (FINAL, V) where V
// is the 1-based stitch version — every stitch INSERTs a new FINAL row.
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
    const outputFolder = opts.outputFolder || (engine === "wan" ? `${projectName}_wan` : projectName);
    const facts = diskFacts(outputFolder, asset.file);
    const filePath = `outputs/${outputFolder}/${asset.file}`;
    let target = null;
    if (asset.stage === "reference") {
      target = { type: "REFERENCE", beat: 0, model: REF_MODEL, workflow: REF_WORKFLOW,
        meta: { engine, file: asset.file, ...facts } };
    } else if (asset.stage === "keyframe") {
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
    const upd = await pgPool.query(
      `UPDATE project_assets SET file_path = $1, status = 'COMPLETED', error_message = NULL,
         attempts = attempts + 1,
         model = COALESCE(model, $5), workflow = COALESCE(workflow, $6),
         metadata = COALESCE(metadata, $7::jsonb),
         started_at = COALESCE(started_at, now()), completed_at = now()
       WHERE project_id = $2 AND version = $3 AND asset_type = $4 AND beat_index = $8`,
      [filePath, projectId, version, target.type, target.model, target.workflow,
       JSON.stringify(target.meta), target.beat]);
    if (upd.rowCount === 0) {
      await pgPool.query(
        `INSERT INTO project_assets (
           project_id, version, scene_id, beat_index, asset_type, status,
           file_path, model, workflow, attempts, metadata, started_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, 'COMPLETED', $6, $7, $8, 1, $9::jsonb, now(), now())
         ON CONFLICT (project_id, version, asset_type, beat_index) DO UPDATE SET
           file_path = EXCLUDED.file_path, status = 'COMPLETED', error_message = NULL,
           attempts = project_assets.attempts + 1, completed_at = now()`,
        [projectId, version, sceneId, target.beat, target.type, filePath,
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
    const mains = mainsFor(outputFolder, cfg);
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    const existing = await pgPool.query(
      "SELECT asset_type, beat_index FROM project_assets WHERE project_id = $1 AND version = $2",
      [pid, Number(version)]);
    const has = new Set(existing.rows.map((r) => `${r.asset_type}:${r.beat_index}`));
    const relPath = (file) => (file ? `outputs/${outputFolder}/${file}` : null);
    const touch = async (type, beat, file) => {
      if (!file || !has.has(`${type}:${beat}`)) return; // delta: no backfill
      await pgPool.query(
        `UPDATE project_assets SET file_path = COALESCE(file_path, $1),
           status = CASE WHEN file_path IS NOT NULL OR $1 IS NOT NULL THEN 'COMPLETED' ELSE status END,
           completed_at = CASE WHEN file_path IS NOT NULL OR $1 IS NOT NULL THEN COALESCE(completed_at, now()) ELSE completed_at END
         WHERE project_id = $2 AND version = $3 AND asset_type = $4 AND beat_index = $5`,
        [relPath(file), pid, Number(version), type, beat]);
    };
    await touch("REFERENCE", 0, mains.ref ?? null);
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
// File list for the gallery — served from the DB (null = PG down, use disk).
async function pgAssetFiles(folder) {
  if (!pgUp) return null;
  try {
    const r = await pgPool.query("SELECT file FROM assets WHERE scenario = $1 ORDER BY file", [folder]);
    return r.rows.map((x) => x.file);
  } catch { return null; }
}
async function pgInit() {
  if (!(await pgProbe())) return;
  try {
    await pgPool.query(PG_SCHEMA);
    await pgPool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_id SERIAL UNIQUE`);
    // --- narrow project_assets schema: ensure every column/index exists ---
    // Fresh installs get the exact DDL from PG_SCHEMA above; a pre-existing
    // table (created from the same DDL by hand) gains any missing narrow
    // columns here. The old WIDE table (kind/reference_*/image_*/video_*)
    // is NOT migrated — drop it once (DROP TABLE public.project_assets;)
    // and let boot recreate it.
    const NARROW_COLS = [
      `project_id INTEGER NOT NULL`,
      `version INTEGER NOT NULL DEFAULT 1`,
      `scene_id INTEGER`,
      `beat_index INTEGER NOT NULL DEFAULT 0`,
      `beat_title TEXT`,
      `asset_type TEXT NOT NULL`,
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
    try {
      await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS project_assets_project_version_type_beat_key
        ON public.project_assets(project_id, version, asset_type, beat_index)`);
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
    await syncAllToPg();
  } catch (e) { console.warn("[pg] init failed:", e.message); }
}
pgInit();

const DIST = path.join(__dirname, "dist");
const PORT = Number(process.env.PORT || 8790);
const LLM_BASE = (process.env.LLM_BASE || "https://furian-1.tailb2c0b0.ts.net").replace(/\/+$/, "");

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
const isSafe = (name) => !name.includes("..") && !name.includes("/") && !name.includes("\\");
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
// One run = one spawned `node scripts/character_sequence{,_wan}.mjs <scenario>`
// (repeated `opts.count` times for batch reference generation).
// engine: "ltx" (default) or "wan" — picks the i2v backend script.
// opts.stitch   -> --stitch (re-stitch final from selected mains only)
// opts.regen    -> --regen <ref|keyframe|clip> [beat] (regenerate one asset, keeps old versions)
// opts.count    -> repeat a `ref` regen this many times (each pass writes a new
//                  _vN version to pick from); anything else always runs once.
const runs = new Map(); // id -> { scenario, status, log, startedAt, proc, subs:Set<res> }

function startRun(scenario, opts = {}) {
  const { stitch = false, regen = null, engine = "ltx" } = opts;
  const count = regen?.kind === "ref" ? Math.min(8, Math.max(1, Number(opts.count) || 1)) : 1;
  if ([...runs.values()].some((r) => r.status === "running"))
    throw new Error("another run is still active (ComfyUI queue is serial)");
  const script = engine === "wan" ? "scripts/character_sequence_wan.mjs" : "scripts/character_sequence.mjs";
  const argv = [script, scenario];
  if (stitch) argv.push("--stitch");
  if (regen) {
    argv.push("--regen", regen.kind, ...(regen.index ? [String(regen.index)] : []));
  }
  const id = Date.now().toString(36);
  const run = { id, scenario, engine, status: "running", log: "", assets: [], startedAt: Date.now(), proc: null, subs: new Set(), cancelled: false, total: count, pass: 0 };
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
        // Save every finished generation to the Postgres catalog (assets
        // table + flip that one project_assets row to COMPLETED).
        const dirName = run.engine === "wan" ? `${run.scenario}_wan` : run.scenario;
        pgUpsertAsset(dirName, asset.file)
          .then(() => pgMarkAssetComplete(run.scenario, asset, { engine: run.engine, outputFolder: dirName }))
          .catch((e) => console.warn("[pg] catalog failed:", e.message));
      }
    }
  };
  const finish = (status) => {
    run.status = status;
    push(`\n[${status}]\n`);
    for (const s of run.subs) { s.write("event: close\ndata: " + JSON.stringify({ status: run.status }) + "\n\n"); s.end(); }
    run.subs.clear();
    // Reconcile the run's output dir with the DB (catches final.mp4 + anything missed).
    const dirName = run.engine === "wan" ? `${run.scenario}_wan` : run.scenario;
    pgSyncFolder(dirName)
      .then(() => pgRefreshProjectFiles(run.scenario, dirName))
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
const folderProject = (folder) => (String(folder).endsWith("_wan") ? String(folder).slice(0, -4) : String(folder));
const newCoverage = () => ({ ref: false, kf: new Set(), clips: new Set(), final: false, thumb: null });

// Disk coverage for one project dir (PG-down fallback + thumbnail existence).
// Prefers the ltx dir, then the _wan dir; thumbnail = highest-beat keyframe
// main, else the reference main.
function diskCoverageFor(name, cfg) {
  const seq = Array.isArray(cfg?.sequence) ? cfg.sequence : [];
  const cov = newCoverage();
  for (const dir of [name, `${name}_wan`]) {
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
  // 1) Scenario list (PG canonical; prompts/*.json fallback when PG is down).
  let rows;
  try {
    rows = (await dbListScenarios()).map((r) => ({
      name: r.name, configText: String(r.config), updated_at: Number(r.updated_at),
    }));
  } catch (e) {
    console.warn("[dashboard] scenario store unreachable, falling back to prompts/*.json");
    rows = [];
    try {
      fs.mkdirSync(PROMPTS, { recursive: true });
      for (const f of fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json"))) {
        const full = path.join(PROMPTS, f);
        try {
          rows.push({ name: f.replace(/\.json$/, ""), configText: fs.readFileSync(full, "utf8"), updated_at: Math.round(fs.statSync(full).mtimeMs) });
        } catch { /* skip unreadable prompt files */ }
      }
    } catch { /* no prompts dir — empty list */ }
  }
  const cfgs = new Map();
  for (const r of rows) {
    try { cfgs.set(r.name, JSON.parse(r.configText)); }
    catch { cfgs.set(r.name, null); }
  }
  const names = rows.map((r) => r.name);
  const folders = [...new Set(names.flatMap((n) => [n, `${n}_wan`]))];

  // 2) Coverage from the PG assets catalog (one GROUP BY), else disk scan.
  const covs = new Map(); // name -> coverage
  const get = (n) => {
    let c = covs.get(n);
    if (!c) { c = newCoverage(); covs.set(n, c); }
    return c;
  };
  let thumbs = new Map();
  if (pgUp && names.length) {
    try {
      const cov = await pgPool.query(
        `SELECT scenario, kind, beat_index FROM assets
          WHERE scenario = ANY($1) AND kind IN ('reference','keyframe','clip','final')`,
        [folders]);
      for (const row of cov.rows) {
        const c = get(folderProject(row.scenario));
        if (row.kind === "reference") c.ref = true;
        else if (row.kind === "keyframe" && row.beat_index != null) c.kf.add(Number(row.beat_index));
        else if (row.kind === "clip" && row.beat_index != null) c.clips.add(Number(row.beat_index));
        else if (row.kind === "final") c.final = true;
      }
      const th = await pgPool.query(
        `SELECT DISTINCT ON (scenario) scenario, file FROM assets
          WHERE scenario = ANY($1) AND kind IN ('reference','keyframe')
          ORDER BY scenario, mtime DESC`,
        [folders]);
      thumbs = new Map(th.rows.map((r) => [r.scenario, r.file]));
    } catch (e) {
      console.warn("[dashboard] asset aggregate failed, using disk scan:", e.message);
    }
  }
  if (!pgUp) {
    for (const n of names) covs.set(n, diskCoverageFor(n, cfgs.get(n)));
  } else {
    // PG was up: fill projects that have no catalog rows from disk (CLI runs
    // / backfill gaps must never report zero progress), and resolve thumbs.
    for (const n of names) {
      const c = get(n);
      if (!c.ref && !c.kf.size && !c.clips.size && !c.final) {
        const d = diskCoverageFor(n, cfgs.get(n));
        if (d.ref || d.kf.size || d.clips.size || d.final) covs.set(n, d);
      }
    }
  }

  // 3) Project created dates (one query; nulls when unavailable).
  let created = new Map();
  if (pgUp && names.length) {
    try {
      const r = await pgPool.query("SELECT name, created_at FROM projects WHERE name = ANY($1)", [names]);
      created = new Map(r.rows.map((x) => [x.name, x.created_at ? new Date(x.created_at).getTime() : null]));
    } catch (e) { console.warn("[dashboard] projects lookup failed:", e.message); }
  }

  // 4) Currently generating (in-memory runs — ComfyUI queue is serial).
  const runningByScenario = new Map();
  for (const r of runs.values()) {
    if (r.status === "running" && !runningByScenario.has(r.scenario)) {
      runningByScenario.set(r.scenario, r);
      // A _wan run is stored under the base scenario name; also match the
      // suffixed folder name so both dashboard keys resolve.
      runningByScenario.set(`${r.scenario}_wan`, r);
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
    let thumbFile = thumbs.get(r.name) ?? thumbs.get(`${r.name}_wan`) ?? c.thumb?.file ?? null;
    let thumbDir = thumbs.has(r.name) ? r.name : (thumbs.has(`${r.name}_wan`) ? `${r.name}_wan` : (c.thumb?.dir ?? r.name));
    if (thumbFile && !fs.existsSync(path.join(OUTPUTS, thumbDir, thumbFile))) {
      thumbFile = c.thumb && fs.existsSync(path.join(OUTPUTS, c.thumb.dir, c.thumb.file)) ? c.thumb.file : null;
      if (thumbFile) thumbDir = c.thumb.dir;
    }
    return {
      name: r.name,
      description: typeof cfg?.description === "string" ? cfg.description : "",
      status,
      generating: generating.has(r.name) || generating.has(`${r.name}_wan`),
      startedAt: runningByScenario.get(r.name)?.startedAt
        ?? runningByScenario.get(`${r.name}_wan`)?.startedAt ?? null,
      progress,
      sceneCount: beats,
      imageCount: c.kf.size,
      videoCount: c.clips.size,
      refDone: c.ref,
      hasFinal: c.final,
      thumbnailUrl: thumbFile ? `/outputs/${thumbDir}/${thumbFile}` : null,
      createdAt: created.get(r.name) ?? null,
      updatedAt: Number.isFinite(r.updated_at) ? r.updated_at : null,
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
 * character-sequence scenario JSON from a high-level topic + requirements.
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
async function craftScenario({ topic, requirements = "", name }) {
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
  const user = reference
    ? `Reference example (match its style and level of detail, NOT its subject):\n${JSON.stringify(reference, null, 2)}\n\nNew scenario to craft:\nTopic: ${topic}\nRequirements: ${requirements || "(none)"}`
    : `New scenario to craft:\nTopic: ${topic}\nRequirements: ${requirements || "(none)"}`;
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
  cfg.sequence = cfg.sequence.map((b, i) => ({
    title: slug(b.title) || `beat${i + 1}`,
    image: String(b.image || ""),
    motion: String(b.motion || ""),
  }));
  const scenarioName = slug(name || topic);
  return { name: scenarioName, config: cfg };
}

/**
 * Ask the local LLM to extend a scenario with the NEXT beat in the story.
 * Context = the scenario JSON itself (description / character / referencePrompt
 * + existing beats), so the new beat continues chronologically from the last
 * existing beat and keeps the same character and visual style.
 */
async function craftNextBeat(cfg) {
  const existing = (cfg.sequence || []).map((b, i) => ({
    n: i + 1,
    title: b.title,
    image: b.image,
    motion: b.motion,
  }));
  const system = [
    "You extend a ComfyUI video-generation scenario with exactly ONE next beat.",
    "The story must continue chronologically from the last existing beat — pick the natural next moment in the arc.",
    "Rules: title = short snake_case_file_safe and unique among existing titles;",
    "image = static keyframe prompt for Flux t2i (reuse the character block VERBATIM, keep the same visual style, new moment/pose/setting detail);",
    "motion = 1-2 sentences of motion + camera direction for LTX image-to-video (no cuts, no new characters).",
    "Output ONLY a JSON object { title, image, motion } — no prose, no markdown fences.",
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
  return { title, image: String(b.image), motion: String(b.motion) };
}

/** Generate `count` consecutive beats; each call continues from the previous one. */
async function craftNextBeats(cfg, count) {
  const beats = [];
  const cur = { ...cfg, sequence: [...(cfg.sequence || [])] };
  for (let i = 0; i < count; i++) {
    const b = await craftNextBeat(cur);
    beats.push(b);
    cur.sequence.push(b);
  }
  return beats;
}

// ---------------------------------------------------------------- static files
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".wav": "audio/wav", ".ico": "image/x-icon" };
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
// Output dir name -> scenario config name (Wan runs use outputs/<scenario>_wan/).
const cfgNameFor = (dirName) => (dirName.endsWith("_wan") ? dirName.slice(0, -4) : dirName);
const prefixFor = (dirName) => (dirName.endsWith("_wan") ? `${cfgNameFor(dirName)}_wan` : dirName);

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
  // File list = Postgres catalog first (stable order), unioned with whatever
  // is actually on disk. An empty-but-reachable catalog (CLI runs, PG-down
  // gaps, missed backfills) must never hide rendered files — everything on
  // disk always renders. Rows are intersected with disk so deleted files
  // never render broken media.
  const listed = await pgAssetFiles(name);
  const files = [...new Set([...(listed || []), ...onDisk])]
    .filter((f) => fs.existsSync(path.join(dir, f)));
  const versions = { ref: [], beats: {}, final: [] };
  const mains = { ref: null, beats: {}, final: null };
  // Config for version mapping: prompts JSON first, store copy as fallback
  // (a scenario can live in the store while its JSON is missing/renamed).
  let cfg = null;
  const cfgPath = path.join(PROMPTS, cfgNameFor(name) + ".json");
  try {
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch { cfg = null; }
  if (!cfg) {
    try {
      const raw = await dbGetScenario(cfgNameFor(name));
      if (raw) cfg = JSON.parse(raw);
    } catch { cfg = null; }
  }
  if (files.length && cfg?.referencePrompt && Array.isArray(cfg?.sequence) && cfg.sequence.length) {
    const vm = versionMap(dir, prefixFor(name), cfg.sequence);
    mains.ref = vm.refMain;
    for (const [n, b] of Object.entries(vm.beats)) {
      versions.beats[n] = { keyframe: b.keyframe, clip: b.clip };
      mains.beats[n] = { keyframe: b.keyframeMain, clip: b.clipMain };
    }
    versions.ref = vm.ref;
    versions.final = vm.final ?? [];
    mains.final = vm.finalMain ?? null;
  }
  return { files, versions, mains };
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

    // Everything below (API + generated outputs) requires a session.
    if ((p.startsWith("/api/") || p.startsWith("/outputs/")) && !authedUser(req))
      return json(res, 401, { error: "unauthorized" });

    if (p === "/api/scenarios" && req.method === "GET") {
      const favs = readFavs();
      let rows;
      try { rows = await dbListScenarios(); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      return json(res, 200, rows.map((r) => {
        const c = JSON.parse(r.config);
        return {
          name: r.name,
          isSequence: !!(c.sequence && c.referencePrompt),
          // node-pg returns BIGINT as string — coerce so the UI gets a real
          // epoch-ms number (a string renders as NaN-undefined-NaN).
          mtimeMs: Number(r.updated_at),
          favorite: favs.includes(r.name),
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
    if (p.startsWith("/api/scenario/") && req.method === "GET" && p.split("/")[4] === "versions") {
      const parts = p.split("/");
      const name = parts[3];
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
      const name = p.split("/")[3];
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      let raw;
      try { raw = await dbGetScenario(name); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (raw === null) return json(res, 404, { error: "no such scenario" });
      return json(res, 200, { name, config: JSON.parse(raw) });
    }
    if (p.startsWith("/api/scenario/") && req.method === "PUT" && p.split("/").length === 4) {
      const name = p.split("/")[3];
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      const cfg = await readJson(req);
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
      // Explicit save = new version of the same project in the database.
      // Delta versioning: the version row + ONLY the changed scene rows are
      // inserted in one transaction (see pgSaveVersionDelta). Unchanged
      // scenes keep resolving to their previous rows via the effective
      // query on GET /api/project/:name/assets.
      let version = null;
      let project_id = null;
      if (pgUp) {
        try {
          let prevCfg = null;
          try { prevCfg = prevRaw != null ? JSON.parse(prevRaw) : null; }
          catch { prevCfg = null; }
          const saved = await pgSaveVersionDelta(name, prevCfg, cfg);
          version = saved.version;
          project_id = saved.projectId;
        }
        catch (e) { console.warn("[pg] version save failed:", e.message); }
      }
      return json(res, 200, { ok: true, version, project_id });
    }
    // Delete ONE saved version (prompt config), not the scenario. Deleting the
    // latest rolls the current config back to the new latest so "Latest" never
    // points at a deleted version. Generated outputs are untouched.
    // NOTE: must sit before the whole-scenario DELETE (same prefix).
    if (p.startsWith("/api/scenario/") && req.method === "DELETE" && p.split("/")[4] === "versions") {
      const parts = p.split("/");
      const name = parts[3];
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
      const name = p.split("/")[3];
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      let raw;
      try { raw = await dbGetScenario(name); }
      catch (e) { return json(res, 503, { error: "database unavailable" }); }
      if (raw === null) return json(res, 404, { error: "no such scenario" });
      await dbDeleteScenario(name);
      const f = path.join(PROMPTS, name + ".json");
      if (fs.existsSync(f)) fs.unlinkSync(f);
      const outDir = path.join(OUTPUTS, name);
      if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
      pgDeleteScenarioMirror(name).catch((e) => console.warn("[pg] scenario unmirror failed:", e.message));
      return json(res, 200, { ok: true });
    }
    if (p === "/api/runs" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.scenario !== "string" || !isSafe(body.scenario))
        return json(res, 400, { error: "bad scenario" });
      const run = startRun(body.scenario, {
        stitch: !!body.stitch,
        engine: body.engine || "ltx",
        regen: body.regen || null,
        count: body.count,
      });
      return json(res, 200, { id: run.id });
    }
    if (p === "/api/runs" && req.method === "GET")
      return json(res, 200, [...runs.values()].map(({ proc, subs, ...r }) => r).reverse());
    if (p.startsWith("/api/runs/") && req.method === "GET") {
      const run = runs.get(p.split("/")[3]);
      if (!run) return json(res, 404, { error: "no run" });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`data: ${JSON.stringify({ line: run.log })}\n\n`);
      for (const a of run.assets) res.write(`event: asset\ndata: ${JSON.stringify(a)}\n\n`);
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
      return json(res, 200, await outputsPayload(name));
    }
    if (p === "/api/outputs/select" && req.method === "POST") {
      const body = await readJson(req);
      const { scenario, kind, index, file } = body;
      if (!isSafe(scenario) || typeof file !== "string") return json(res, 400, { error: "bad body" });
      const dir = path.join(OUTPUTS, scenario);
      if (!fs.existsSync(dir)) return json(res, 404, { error: "no outputs" });
      setMain(dir, prefixFor(scenario), kind, kind === "ref" ? 0 : index, null, file);
      return json(res, 200, await outputsPayload(scenario));
    }
    if (p === "/api/upload/ref" && req.method === "POST") {
      // Upload an image as the scenario's reference (browse / drag-drop / clipboard).
      // Stored as the next ref version in outputs/<scenario>/ and selected as main,
      // so the pipeline skips Flux ref generation and uses the uploaded image.
      const body = await readJson(req);
      const scenario = String(body.scenario || "");
      if (!isSafe(scenario)) return json(res, 400, { error: "bad scenario" });
      if (typeof body.data !== "string") return json(res, 400, { error: "data (base64) required" });
      const m = body.data.match(/^data:image\/\w+;base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "expected a data:image base64 payload" });
      const buf = Buffer.from(m[1], "base64");
      if (!buf.length) return json(res, 400, { error: "empty image" });
      const outDir = path.join(OUTPUTS, scenario);
      fs.mkdirSync(outDir, { recursive: true });
      const prefix = prefixFor(scenario);
      const v = nextVersion(outDir, prefix, "ref", 0, ".png");
      const file = v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`;
      fs.writeFileSync(path.join(outDir, file), buf);
      setMain(outDir, prefix, "ref", 0, null, file);
      pgUpsertAsset(scenario, file)
        .then(() => pgRefreshProjectFiles(cfgNameFor(scenario), scenario))
        .catch((e) => console.warn("[pg] catalog failed:", e.message));
      return json(res, 200, await outputsPayload(scenario));
    }
    if (p === "/api/upload/keyframe" && req.method === "POST") {
      // Upload an image as beat N's keyframe. Stored as the next keyframe
      // version in outputs/<scenario>/ and selected as main, so a later
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
      const outDir = path.join(OUTPUTS, scenario);
      if (!fs.existsSync(outDir)) return json(res, 404, { error: "no outputs" });
      // Beat title feeds the versioned filename — resolve it from the
      // prompts JSON first, stored scenario copy as fallback.
      let title = null;
      const cfgPath = path.join(PROMPTS, cfgNameFor(scenario) + ".json");
      try {
        if (fs.existsSync(cfgPath)) {
          const seq = JSON.parse(fs.readFileSync(cfgPath, "utf8")).sequence;
          title = Array.isArray(seq) ? seq[n - 1]?.title ?? null : null;
        }
      } catch { title = null; }
      if (title == null) {
        try {
          const raw = await dbGetScenario(cfgNameFor(scenario));
          const seq = raw ? JSON.parse(raw).sequence : null;
          title = Array.isArray(seq) ? seq[n - 1]?.title ?? null : null;
        } catch { title = null; }
      }
      if (title == null) return json(res, 400, { error: `no beat ${n}` });
      const prefix = prefixFor(scenario);
      const v = nextVersion(outDir, prefix, "seq", n, ".png", title);
      const file = v === 1 ? `${prefix}_seq${n}_${title}.png` : `${prefix}_seq${n}_${title}_v${v}.png`;
      fs.writeFileSync(path.join(outDir, file), buf);
      setMain(outDir, prefix, "seq", n, title, file);
      pgUpsertAsset(scenario, file)
        .then(() => pgMarkAssetComplete(cfgNameFor(scenario),
          { file, stage: "keyframe", index: n },
          { engine: engineForFolder(scenario), outputFolder: scenario }))
        .then(() => pgRefreshProjectFiles(cfgNameFor(scenario), scenario))
        .catch((e) => console.warn("[pg] catalog failed:", e.message));
      return json(res, 200, await outputsPayload(scenario));
    }
    if (p === "/api/outputs/stitch" && req.method === "POST") {
      const body = await readJson(req);
      if (!isSafe(body.scenario)) return json(res, 400, { error: "bad scenario" });
      const run = startRun(body.scenario, { stitch: true, engine: body.engine || "ltx" });
      return json(res, 200, { id: run.id });
    }
    if (p === "/api/craft" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.topic) return json(res, 400, { error: "topic required" });
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
          const cfg = {
            ...crafted.config,
            ...(body.topic ? { topic: String(body.topic) } : {}),
            ...(body.requirements ? { requirements: String(body.requirements) } : {}),
          };
          project_id = await pgEnsureProject(target, cfg);
        } catch (e) { console.warn("[pg] craft project save failed:", e.message); }
      }
      return json(res, 200, { ...crafted, project_id });
    }
    if (p === "/api/craft-beat" && req.method === "POST") {
      const body = await readJson(req);
      const cfg = body.config;
      if (!cfg || !Array.isArray(cfg.sequence)) return json(res, 400, { error: "config with sequence required" });
      const count = Math.max(1, Number(body.count) || 1);
      return json(res, 200, { beats: await craftNextBeats(cfg, count) });
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
      let version = Number(u.searchParams.get("version"));
      if (!Number.isInteger(version)) {
        const r = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
        version = Number(r.rows[0]?.v);
      }
      if (!Number.isInteger(version)) return json(res, 200, []);
      const mode = String(u.searchParams.get("mode") || "").toLowerCase();
      const exact = mode === "exact" || mode === "delta" || mode === "raw" ||
        u.searchParams.get("exact") === "1";
      const r = await pgPool.query(exact ? EXACT_VERSION_SQL : EFFECTIVE_ASSETS_SQL, [pid, version]);
      return json(res, 200, r.rows);
    }
    if (p === "/api/db" && req.method === "GET") {
      if (!(await pgProbe())) return json(res, 200, { up: false });
      const [a, s, pj, pa] = await Promise.all([
        pgPool.query("SELECT count(*)::int AS n FROM assets"),
        pgPool.query("SELECT count(*)::int AS n FROM scenarios"),
        pgPool.query("SELECT count(*)::int AS n FROM projects").catch(() => ({ rows: [{ n: null }] })),
        pgPool.query("SELECT count(*)::int AS n FROM project_assets").catch(() => ({ rows: [{ n: null }] })),
      ]);
      return json(res, 200, { up: true, assets: a.rows[0].n, scenarios: s.rows[0].n, projects: pj.rows[0].n, project_assets_linked: pa.rows[0].n });
    }
    if (p.startsWith("/outputs/")) {
      const [, , scenario, file] = p.split("/");
      return serveOutput(res, decodeURIComponent(scenario), decodeURIComponent(file));
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
