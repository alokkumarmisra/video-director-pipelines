// Run: node --test tests/devotional_server.test.mjs (from repo root)
// Static wiring tests for the Devotional Studio backend surface: every
// documented endpoint is registered, the Postgres schema carries all tables,
// and no client-supplied body ever builds a filesystem path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEVOTIONAL_SCHEMA, DEVOTIONAL_FILE_KINDS } from "../lib/devotional.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "frontend", "server.mjs"), "utf8");
const videoScriptSrc = fs.readFileSync(path.join(ROOT, "scripts", "devotional_video.mjs"), "utf8");

describe("devotional api surface (static)", () => {
  const routes = [
    ["/api/devotional/stats", "dashboard stats"],
    ["/api/devotional/assets", "asset CRUD"],
    ["/api/devotional/seed", "starter seed"],
    ["/api/devotional/jobs", "job list"],
    ["/api/devotional/resolve", "director resolve"],
    ["/api/devotional/prompt", "prompt assembly"],
    ["/api/devotional/scene-links", "scene links"],
    ["/api/devotional/project-usage", "project usage"],
    ["/api/devotional/export", "export"],
    ["/api/devotional/import", "import"],
    ["/api/devotional/health", "health"],
    ["/devotional/", "binary serving"],
  ];
  for (const [route, label] of routes) {
    it(`server exposes ${route} (${label})`, () => {
      assert.ok(serverSrc.includes(`"${route}"`) || serverSrc.includes("'/devotional/'") && route === "/devotional/", `${route} missing`);
    });
  }
  it("devotional routes sit behind the auth gate", () => {
    assert.ok(serverSrc.includes('p.startsWith("/devotional/")'), "devotional static gate missing");
  });
  it("reference generation spawns the existing ComfyUI script (never imports lib/comfy)", () => {
    assert.ok(serverSrc.includes("scripts/devotional_reference.mjs"), "generator script wiring missing");
    assert.ok(!/^import .* from "\.\.\/lib\/comfy\.mjs";?$/m.test(serverSrc),
      "server must not statically import lib/comfy (process.exit risk) — generation goes through a child process");
  });
  it("devotional jobs pump serially with main runs", () => {
    assert.ok(serverSrc.includes("devPumpJobs"), "job pump missing");
    assert.ok(serverSrc.includes("devotionalProcs"), "job proc tracking missing");
  });
  it("no client body builds a devotional file path", () => {
    // Segment allowlist (isSafeSegment) + path.join(DEVOTIONAL_DIR, ...) only.
    assert.ok(serverSrc.includes("isSafeSegment"), "segment guard missing");
    assert.ok(serverSrc.includes("p.startsWith(DEVOTIONAL_DIR)"), "root-escape guard missing");
  });
});

describe("devotional postgres schema (static)", () => {
  for (const table of [
    "devotional_assets", "devotional_asset_versions", "devotional_asset_files",
    "devotional_jobs", "devotional_scene_links", "devotional_project_usage",
  ]) {
    it(`schema creates ${table}`, () => {
      assert.ok(DEVOTIONAL_SCHEMA.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} missing`);
    });
  }
  it("assets carry kind/status checks + self-FK for variants", () => {
    assert.ok(DEVOTIONAL_SCHEMA.includes("IN ('character','location','prop','style')"), "kind check missing");
    assert.ok(DEVOTIONAL_SCHEMA.includes("IN ('draft','generating','review','approved','archived')"), "status check missing");
    assert.ok(DEVOTIONAL_SCHEMA.includes("REFERENCES devotional_assets(id)"), "parent/style FK missing");
  });
  it("scene links + usage reference assets with RESTRICT (no silent orphan)", () => {
    assert.ok(DEVOTIONAL_SCHEMA.includes("ON DELETE RESTRICT"), "restrict guard missing");
  });
  it("schema is applied at boot without breaking existing init", () => {
    assert.ok(serverSrc.includes("DEVOTIONAL_SCHEMA"), "pgInit must execute the devotional schema");
  });
});

describe("devotional still + clip generation (static)", () => {
  it("file kinds include video clips", () => {
    assert.ok(DEVOTIONAL_FILE_KINDS.includes("video"), "video file kind missing");
  });
  it("generate endpoint queues a clip job behind the still (both flag)", () => {
    assert.ok(serverSrc.includes("both"), "both flag missing");
    assert.ok(serverSrc.includes("scripts/devotional_video.mjs"), "video script wiring missing");
    assert.ok(serverSrc.includes("kind === \"video\"") || serverSrc.includes("=== 'video'"), "video job branch missing");
  });
  it("video script animates the still via LTX i2v (never overwrites)", () => {
    for (const bit of ["buildLtxGraph", "uploadToInput", "firstVideoUrl", "[asset]", "exists, skipping"]) {
      assert.ok(videoScriptSrc.includes(bit), `${bit} missing from devotional_video.mjs`);
    }
  });
  it("video failures never corrupt the asset (still owns the lifecycle)", () => {
    assert.ok(serverSrc.includes("if (!isVideo)"), "video close handler must not touch asset status");
  });
  it("clip files play in the detail dialog (not fed to <img>)", () => {
    const pageSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "DevotionalPage.tsx"), "utf8");
    assert.ok(pageSrc.includes("<video"), "video element missing");
    assert.ok(pageSrc.includes("generateDevotionalMedia"), "media client missing");
  });
  it("assets carry a saved generation prompt (used by still + clip renders)", () => {
    assert.ok(DEVOTIONAL_SCHEMA.includes("prompt TEXT"), "prompt column missing from DEVOTIONAL_SCHEMA");
    assert.ok(serverSrc.includes("ALTER TABLE devotional_assets ADD COLUMN"), "prompt migration missing");
    assert.ok(serverSrc.includes("asset.prompt || describeAssetForPrompt(asset)"), "generate must fall back to the saved prompt");
    const pageSrc = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "DevotionalPage.tsx"), "utf8");
    assert.ok(pageSrc.includes("Save & Regenerate"), "prompt editor with regenerate missing");
  });
});
