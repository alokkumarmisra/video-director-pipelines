// Stop -> Generate resume tests: a restarted full run must continue from the
// last stopped scene, never redo completed scenes from scene 1.
// Run: node --test tests/resume.test.mjs (from the repo root; zero deps)
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// lib/comfy.mjs exits without COMFY_BASE — dummy is enough, nothing here
// touches the network (same trick as ref_anchor.test.mjs).
process.env.COMFY_BASE ??= "http://localhost:1";
const { keyframeUpToDate } = await import("../lib/sequence.mjs");
const {
  loadState,
  saveState,
  setMain,
  setKeyframeRefFrom,
  getKeyframeRefFrom,
  versionsOf,
} = await import("../lib/sequence_state.mjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PREFIX = "proj";
const title = (n) => `beat${n}`; // fileSlug("beat1") === "beat1"
const kfFile = (n, v = 1) =>
  v === 1 ? `${PREFIX}_seq${n}_${title(n)}.png` : `${PREFIX}_seq${n}_${title(n)}_v${v}.png`;
const clipFile = (n, v = 1) =>
  v === 1 ? `${PREFIX}_clip${n}_${title(n)}.mp4` : `${PREFIX}_clip${n}_${title(n)}_v${v}.mp4`;
const REF = `${PREFIX}_ref.png`;

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A stopped run's on-disk state: ref + scenes 1..2 fully done (refFrom
// recorded, as a real generation leaves it), scene 3 keyframe done but its
// clip killed mid-generation (no file), scene 4 untouched.
function stoppedMidRun({ refFrom = REF } = {}) {
  fs.writeFileSync(path.join(dir, REF), "fake-png");
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(dir, kfFile(n)), "fake-png");
    setKeyframeRefFrom(dir, n, refFrom);
  }
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(dir, clipFile(n)), "fake-mp4");
  }
  setMain(dir, PREFIX, "ref", 0, null, REF, {});
}

describe("Stop -> Generate resume predicate", () => {
  it("missing keyframe is not up to date (the stopped scene regenerates)", () => {
    stoppedMidRun();
    assert.equal(keyframeUpToDate(dir, PREFIX, 4, title(4), REF), false);
  });

  it("completed scenes stay up to date (skipped, not regenerated)", () => {
    stoppedMidRun();
    assert.equal(keyframeUpToDate(dir, PREFIX, 1, title(1), REF), true);
    assert.equal(keyframeUpToDate(dir, PREFIX, 2, title(2), REF), true);
  });

  it("unknown provenance keeps the file (never redo from scene 1)", () => {
    // state.json lost (kill before atomic writes, legacy state, manual
    // delete): refFrom unrecorded. Old code read null !== refMain as stale
    // and regenerated EVERYTHING from scene 1. Resume must keep the file.
    stoppedMidRun();
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ ref: REF, beats: {} }));
    assert.equal(getKeyframeRefFrom(dir, 1), null);
    assert.equal(keyframeUpToDate(dir, PREFIX, 1, title(1), REF), true);
    assert.equal(keyframeUpToDate(dir, PREFIX, 2, title(2), REF), true);
  });

  it("a RECORDED ref switch still heals (genuine staleness regenerates)", () => {
    stoppedMidRun({ refFrom: "proj_ref_old.png" });
    assert.equal(keyframeUpToDate(dir, PREFIX, 1, title(1), REF), false);
  });

  it("truncated state.json reads as empty (kill mid-write is survivable)", () => {
    stoppedMidRun();
    fs.writeFileSync(path.join(dir, "state.json"), '{"ref": "proj_ref');
    assert.deepEqual(loadState(dir), { ref: null, beats: {} });
    // ...and with unknown provenance the completed scenes are still kept.
    assert.equal(keyframeUpToDate(dir, PREFIX, 1, title(1), REF), true);
  });

  it("saveState leaves valid JSON and no tmp leftovers", () => {
    saveState(dir, { ref: REF, beats: { 1: { keyframe: kfFile(1) } } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).ref, REF);
    assert.deepEqual(loadState(dir).ref, REF);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".part-"));
    assert.deepEqual(leftovers, []);
  });
});

describe("resume wiring (static)", () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

  it("downloads are atomic (no partial file can pose as a done version)", () => {
    const src = read("lib/comfy.mjs");
    assert.match(src, /atomicWriteFileSync\(dest/);
  });

  it("stale keyframes require a RECORDED ref mismatch", () => {
    const src = read("lib/sequence.mjs");
    // keyframeUpToDate keeps the file on unknown provenance (builtFrom ==
    // null) and only forces a regen on a recorded mismatch — the De Morgan
    // form below. genKeyframe must route through it.
    assert.match(src, /builtFrom == null \|\| builtFrom === refMain/);
    assert.match(src, /keyframeUpToDate\(outDir, prefix, n, seq\[i\]\.title, refMain\)/);
  });

  it("full runs log an explicit [resume] continue-from marker", () => {
    const src = read("lib/sequence.mjs");
    assert.match(src, /\[resume\]/);
  });
});
