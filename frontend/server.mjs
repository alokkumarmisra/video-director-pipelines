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
// ---------------------------------------------------------------- scenarios db
// Scenarios live in SQLite (data/scenarios.sqlite). On save we ALSO export the
// JSON to prompts/<name>.json so the CLI runners (director.mjs, ...), which
// read prompts/<scenario>.json, keep working unchanged.
const DATA_DIR = path.join(ROOT, "data");
const DB = path.join(DATA_DIR, "scenarios.sqlite");
{
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE IF NOT EXISTS scenarios (
    name TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // One-time migration: import any prompts/*.json not yet in the DB.
  // The dir may have been wiped — ensure it exists instead of crashing boot.
  fs.mkdirSync(PROMPTS, { recursive: true });
  const insert = db.prepare("INSERT OR IGNORE INTO scenarios (name, config, updated_at) VALUES (?, ?, ?)");
  for (const f of fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".json"))) {
    const name = f.replace(/\.json$/, "");
    if (!db.prepare("SELECT 1 FROM scenarios WHERE name = ?").get(name)) {
      insert.run(name, fs.readFileSync(path.join(PROMPTS, f), "utf8"), fs.statSync(path.join(PROMPTS, f)).mtimeMs);
    }
  }
  db.close();
}
const db = new DatabaseSync(DB);
const dbListScenarios = () =>
  db.prepare("SELECT name, config, updated_at FROM scenarios ORDER BY updated_at DESC").all();
const dbGetScenario = (name) => db.prepare("SELECT config FROM scenarios WHERE name = ?").get(name)?.config ?? null;
const dbSaveScenario = (name, cfg) =>
  db.prepare(`INSERT INTO scenarios (name, config, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`)
    .run(name, JSON.stringify(cfg), Date.now());
const dbDeleteScenario = (name) => db.prepare("DELETE FROM scenarios WHERE name = ?").run(name);

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
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  version INT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reference','keyframe','clip')),
  beat_index INT NOT NULL DEFAULT 0,
  beat_title TEXT,
  image_prompt TEXT,
  motion TEXT,
  file TEXT,
  image_generated TEXT NOT NULL DEFAULT 'PENDING' CHECK (image_generated IN ('PENDING','COMPLETED')),
  video_generated TEXT NOT NULL DEFAULT 'PENDING' CHECK (video_generated IN ('PENDING','COMPLETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project, version, kind, beat_index)
);
CREATE INDEX IF NOT EXISTS project_assets_project_idx ON project_assets (project);`;
async function pgProbe() {
  try { await pgPool.query("SELECT 1"); pgUp = true; }
  catch (e) { pgUp = false; console.warn(`[pg] unreachable: ${e.message} — gallery falls back to disk`); }
  return pgUp;
}
// filename -> { kind, beat_index, beat_title, version }
function classifyAsset(file) {
  let m = file.match(/_seq(\d+)_(.+)\.png$/);
  if (m) return splitBeat("keyframe", Number(m[1]), m[2]);
  m = file.match(/_clip(\d+)_(.+)\.mp4$/);
  if (m) return splitBeat("clip", Number(m[1]), m[2]);
  m = file.match(/_ref(?:_v(\d+))?\.png$/);
  if (m) return { kind: "reference", beat_index: null, beat_title: null, version: m[1] ? Number(m[1]) : 1 };
  if (/_final\.mp4$/.test(file)) return { kind: "final", beat_index: null, beat_title: null, version: null };
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
  for (const r of db.prepare("SELECT name, config, updated_at FROM scenarios").all()) {
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
  // Backfill projects + their latest version's asset rows.
  const latest = await pgPool.query(
    "SELECT name, max(version) AS version FROM scenario_versions GROUP BY name");
  for (const { name, version } of latest.rows) {
    const raw = dbGetScenario(name);
    if (raw === null) continue;
    try {
      const cfg = JSON.parse(raw);
      await pgSaveProject(name, cfg, Number(version), mainsFor(name, cfg));
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
  await pgPool.query("DELETE FROM projects WHERE name = $1", [name]); // cascades to project_assets
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
  const out = { ref: null, beats: {} };
  try {
    const dir = path.join(OUTPUTS, dirName);
    if (!fs.existsSync(dir)) return out;
    const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
    const vm = versionMap(dir, prefixFor(dirName), seq);
    out.ref = vm.refMain ?? null;
    out.beats = vm.beats ?? {};
  } catch { /* unversionable dir — mains stay null */ }
  return out;
}
// Project info row + that version's asset rows (prompts + current main files).
// image_generated flips to COMPLETED on reference/keyframe rows once their
// image file exists; video_generated flips on clip rows once the video file
// exists. Existing COMPLETED flags are never downgraded back to PENDING.
async function pgSaveProject(name, cfg, version, mains) {
  const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
  await pgPool.query(
    `INSERT INTO projects (name, description, topic, requirements, duration, beats, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, topic = EXCLUDED.topic,
       requirements = EXCLUDED.requirements, duration = EXCLUDED.duration, beats = EXCLUDED.beats,
       updated_at = now()`,
    [name, cfg.description ?? null, cfg.topic ?? null, cfg.requirements ?? null,
     Number.isFinite(Number(cfg.duration)) ? Number(cfg.duration) : null, seq.length]);
  const done = (file) => (file ? "COMPLETED" : "PENDING");
  const refFile = mains.ref ?? null;
  const rows = [[name, version, "reference", 0, null, cfg.referencePrompt ?? null, null, refFile, done(refFile), "PENDING"]];
  seq.forEach((b, i) => {
    const n = i + 1;
    const bm = (mains.beats && mains.beats[String(n)]) || {};
    const kf = bm.keyframeMain ?? null;
    const cl = bm.clipMain ?? null;
    rows.push([name, version, "keyframe", n, b.title ?? null, b.image ?? null, b.motion ?? null, kf, done(kf), "PENDING"]);
    rows.push([name, version, "clip", n, b.title ?? null, null, b.motion ?? null, cl, "PENDING", done(cl)]);
  });
  for (const r of rows) {
    await pgPool.query(
      `INSERT INTO project_assets (project, version, kind, beat_index, beat_title, image_prompt, motion, file, image_generated, video_generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (project, version, kind, beat_index) DO UPDATE SET beat_title = EXCLUDED.beat_title,
         image_prompt = EXCLUDED.image_prompt, motion = EXCLUDED.motion, file = EXCLUDED.file,
         image_generated = CASE WHEN EXCLUDED.file IS NOT NULL AND EXCLUDED.kind IN ('reference', 'keyframe') THEN 'COMPLETED' ELSE project_assets.image_generated END,
         video_generated = CASE WHEN EXCLUDED.file IS NOT NULL AND EXCLUDED.kind = 'clip' THEN 'COMPLETED' ELSE project_assets.video_generated END`,
      r);
  }
}
// Mark ONE asset row COMPLETED the moment its image/video finishes
// generating (called per [asset] event, so rows flip one by one).
// asset: { file, stage: 'reference'|'keyframe'|'clip'|'final', index? }
async function pgMarkAssetComplete(projectName, asset) {
  if (!pgUp) return;
  try {
    const v = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [projectName]);
    const version = v.rows[0]?.v;
    if (!version) return; // never saved — rows are created on the next Save
    if (asset.stage === "reference") {
      await pgPool.query(
        "UPDATE project_assets SET file = $1, image_generated = 'COMPLETED' WHERE project = $2 AND version = $3 AND kind = 'reference' AND beat_index = 0",
        [asset.file, projectName, version]);
    } else if (asset.stage === "keyframe") {
      await pgPool.query(
        "UPDATE project_assets SET file = $1, image_generated = 'COMPLETED' WHERE project = $2 AND version = $3 AND kind = 'keyframe' AND beat_index = $4",
        [asset.file, projectName, version, asset.index ?? 0]);
    } else if (asset.stage === "clip") {
      await pgPool.query(
        "UPDATE project_assets SET file = $1, video_generated = 'COMPLETED' WHERE project = $2 AND version = $3 AND kind = 'clip' AND beat_index = $4",
        [asset.file, projectName, version, asset.index ?? 0]);
    }
    // 'final' has no project_assets row (only reference/keyframe/clip kinds).
  } catch (e) { console.warn("[pg] mark complete failed:", e.message); }
}
// Refresh the current version's project_assets file names from the output
// dir's main versions (called after every generation + on run exit, so the
// table always lists the actual image/video files on disk).
async function pgRefreshProjectFiles(projectName, outputFolder) {
  if (!pgUp) return;
  try {
    const raw = dbGetScenario(projectName);
    if (raw === null) return;
    const cfg = JSON.parse(raw);
    const v = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [projectName]);
    const version = v.rows[0]?.v;
    if (!version) return; // never saved — files are recorded on the next Save
    await pgSaveProject(projectName, cfg, Number(version), mainsFor(outputFolder, cfg));
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
    // Migrate pre-existing project_assets tables (CREATE TABLE IF NOT
    // EXISTS leaves old tables untouched) + backfill COMPLETED for files
    // that were generated before these columns existed.
    await pgPool.query(`ALTER TABLE project_assets ADD COLUMN IF NOT EXISTS image_generated TEXT NOT NULL DEFAULT 'PENDING' CHECK (image_generated IN ('PENDING','COMPLETED'))`);
    await pgPool.query(`ALTER TABLE project_assets ADD COLUMN IF NOT EXISTS video_generated TEXT NOT NULL DEFAULT 'PENDING' CHECK (video_generated IN ('PENDING','COMPLETED'))`);
    await pgPool.query(`UPDATE project_assets SET image_generated = 'COMPLETED' WHERE file IS NOT NULL AND kind IN ('reference','keyframe') AND image_generated = 'PENDING'`);
    await pgPool.query(`UPDATE project_assets SET video_generated = 'COMPLETED' WHERE file IS NOT NULL AND kind = 'clip' AND video_generated = 'PENDING'`);
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
  res.writeHead(code, { "Content-Type": "application/json" });
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
          .then(() => pgMarkAssetComplete(run.scenario, asset))
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
 * prompts/*.json or any scenario already in SQLite. May be null on a fresh
 * install — craftScenario() then relies on the system schema/rules alone.
 */
function loadCraftReference() {
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
  // 3) Any scenario already saved in SQLite.
  try {
    const rows = db.prepare("SELECT config FROM scenarios LIMIT 1").get();
    if (rows?.config) {
      const cfg = JSON.parse(rows.config);
      if (cfg?.referencePrompt && Array.isArray(cfg?.sequence) && cfg.sequence.length) return cfg;
    }
  } catch { /* fall through */ }
  // Nothing on disk or in DB — no reference (fresh install). The caller
  // falls back to the system schema/rules alone.
  return null;
}
async function craftScenario({ topic, requirements = "", name }) {
  const reference = loadCraftReference();
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
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
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
  // File list comes from the Postgres catalog (what login fetches);
  // disk is the fallback when the DB is down. Rows are intersected with
  // files actually on disk so deleted files never render broken media.
  let files = await pgAssetFiles(name);
  if (!files) {
    files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort()
      : [];
  } else {
    files = files.filter((f) => fs.existsSync(path.join(dir, f)));
  }
  const versions = { ref: [], beats: {} };
  const mains = { ref: null, beats: {} };
  const cfgPath = path.join(PROMPTS, cfgNameFor(name) + ".json");
  if (files.length && fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg.referencePrompt && Array.isArray(cfg.sequence) && cfg.sequence.length) {
      const vm = versionMap(dir, prefixFor(name), cfg.sequence);
      mains.ref = vm.refMain;
      for (const [n, b] of Object.entries(vm.beats)) {
        versions.beats[n] = { keyframe: b.keyframe, clip: b.clip };
        mains.beats[n] = { keyframe: b.keyframeMain, clip: b.clipMain };
      }
      versions.ref = vm.ref;
    }
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
      return json(res, 200, dbListScenarios().map((r) => {
        const c = JSON.parse(r.config);
        return {
          name: r.name,
          isSequence: !!(c.sequence && c.referencePrompt),
          mtimeMs: r.updated_at,
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
      const r = await pgPool.query("SELECT version, created_at FROM scenario_versions WHERE name = $1 ORDER BY version DESC", [name]);
      return json(res, 200, r.rows);
    }
    // length === 4 guard: sub-paths like /versions/1 must never fall through
    // to a whole-scenario route (an old client hitting a new path wiped a
    // scenario that way once).
    if (p.startsWith("/api/scenario/") && req.method === "GET" && p.split("/").length === 4) {
      const name = p.split("/")[3];
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      const raw = dbGetScenario(name);
      if (raw === null) return json(res, 404, { error: "no such scenario" });
      return json(res, 200, { name, config: JSON.parse(raw) });
    }
    if (p.startsWith("/api/scenario/") && req.method === "PUT" && p.split("/").length === 4) {
      const name = p.split("/")[3];
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      const cfg = await readJson(req);
      // No-change save = no-op: an identical config must not stack a duplicate version.
      const prevRaw = dbGetScenario(name);
      let same = false;
      try { same = prevRaw !== null && canonical(prevRaw) === canonical(cfg); }
      catch { same = false; }
      if (same) {
        let version = null;
        if (pgUp) {
          try {
            const r = await pgPool.query("SELECT max(version) AS v FROM scenario_versions WHERE name = $1", [name]);
            version = r.rows[0]?.v ?? null;
          } catch (e) { console.warn("[pg] version lookup failed:", e.message); }
        }
        return json(res, 200, { ok: true, version, unchanged: true });
      }
      dbSaveScenario(name, cfg);
      // Keep the JSON export for the CLI runners.
      fs.writeFileSync(path.join(PROMPTS, name + ".json"), JSON.stringify(cfg, null, 2));
      pgSaveScenarioMirror(name, cfg).catch((e) => console.warn("[pg] scenario mirror failed:", e.message));
      // Explicit save = new version of the same project in the database.
      let version = null;
      if (pgUp) {
        try {
          version = await pgSaveVersion(name, cfg);
          await pgSaveProject(name, cfg, version, mainsFor(name, cfg));
        }
        catch (e) { console.warn("[pg] version save failed:", e.message); }
      }
      return json(res, 200, { ok: true, version });
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
      await pgPool.query("DELETE FROM project_assets WHERE project = $1 AND version = $2", [name, v]);
      let latest = max === v ? null : max;
      if (max === v) {
        const nxt = await pgPool.query("SELECT version, config FROM scenario_versions WHERE name = $1 ORDER BY version DESC LIMIT 1", [name]);
        if (nxt.rows.length) {
          const cfg = nxt.rows[0].config;
          latest = nxt.rows[0].version;
          dbSaveScenario(name, cfg);
          fs.writeFileSync(path.join(PROMPTS, name + ".json"), JSON.stringify(cfg, null, 2));
          pgSaveScenarioMirror(name, cfg).catch((e) => console.warn("[pg] scenario mirror failed:", e.message));
        }
      }
      return json(res, 200, { ok: true, deleted: v, latest });
    }
    if (p.startsWith("/api/scenario/") && req.method === "DELETE" && p.split("/").length === 4) {
      const name = p.split("/")[3];
      if (!isSafe(name)) return json(res, 400, { error: "bad name" });
      if (dbGetScenario(name) === null) return json(res, 404, { error: "no such scenario" });
      dbDeleteScenario(name);
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
    if (p === "/api/outputs/stitch" && req.method === "POST") {
      const body = await readJson(req);
      if (!isSafe(body.scenario)) return json(res, 400, { error: "bad scenario" });
      const run = startRun(body.scenario, { stitch: true, engine: body.engine || "ltx" });
      return json(res, 200, { id: run.id });
    }
    if (p === "/api/craft" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.topic) return json(res, 400, { error: "topic required" });
      return json(res, 200, await craftScenario(body));
    }
    if (p === "/api/craft-beat" && req.method === "POST") {
      const body = await readJson(req);
      const cfg = body.config;
      if (!cfg || !Array.isArray(cfg.sequence)) return json(res, 400, { error: "config with sequence required" });
      const count = Math.min(8, Math.max(1, Number(body.count) || 1));
      return json(res, 200, { beats: await craftNextBeats(cfg, count) });
    }
    if (p === "/api/comfy" && req.method === "GET") return json(res, 200, await comfyStatus());
    if (p === "/api/db" && req.method === "GET") {
      if (!(await pgProbe())) return json(res, 200, { up: false });
      const [a, s] = await Promise.all([
        pgPool.query("SELECT count(*)::int AS n FROM assets"),
        pgPool.query("SELECT count(*)::int AS n FROM scenarios"),
      ]);
      return json(res, 200, { up: true, assets: a.rows[0].n, scenarios: s.rows[0].n });
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
