// Main pinning: auto mains always resolve to the latest version (reloads and
// regens select the newest); only user-pinned mains (manual pick / upload)
// stick to an older version.
// Run: node --test tests/   (from the repo root; zero deps, Node >= 18)
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadState, setMain, resolveMain, isPinnedState, versionMap,
} from "../lib/sequence_state.mjs";

const prefix = "proj";
const title = "s1";
const seq = [{ title }];
let outDir;

const kf = (v) => (v === 1 ? `${prefix}_seq1_${title}.png` : `${prefix}_seq1_${title}_v${v}.png`);

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-"));
  for (const v of [1, 2, 3, 4]) fs.writeFileSync(path.join(outDir, kf(v)), "x");
});

describe("main pins", () => {
  it("reload with a legacy (unpinned) old pick resolves the latest", () => {
    // Pre-pin state.json shape: explicit old pick, no pin record.
    fs.writeFileSync(
      path.join(outDir, "state.json"),
      JSON.stringify({ ref: null, beats: { 1: { keyframe: kf(1) } } })
    );
    const main = resolveMain(outDir, prefix, "seq", 1, ".png", title, loadState(outDir));
    assert.equal(main, kf(4));
  });

  it("a user-pinned pick survives reloads even with newer versions", () => {
    setMain(outDir, prefix, "seq", 1, title, kf(2), { pinned: true });
    const st = loadState(outDir);
    assert.equal(isPinnedState(st, "seq", 1), true);
    // Simulate a fresh process load (reload).
    assert.equal(resolveMain(outDir, prefix, "seq", 1, ".png", title, loadState(outDir)), kf(2));
  });

  it("pipeline selection is auto: regen v4 becomes main on reload", () => {
    setMain(outDir, prefix, "seq", 1, title, kf(4)); // what genKeyframe does with newFile
    const st = loadState(outDir);
    assert.equal(isPinnedState(st, "seq", 1), false);
    assert.equal(resolveMain(outDir, prefix, "seq", 1, ".png", title, loadState(outDir)), kf(4));
  });

  it("a pinned pick of a deleted file falls back to the latest", () => {
    setMain(outDir, prefix, "seq", 1, title, kf(2), { pinned: true });
    fs.rmSync(path.join(outDir, kf(2)));
    assert.equal(resolveMain(outDir, prefix, "seq", 1, ".png", title, loadState(outDir)), kf(4));
  });

  it("versionMap reports which mains are pinned", () => {
    setMain(outDir, prefix, "seq", 1, title, kf(2), { pinned: true });
    const vm = versionMap(outDir, prefix, seq);
    assert.equal(vm.beats["1"].keyframeMain, kf(2));
    assert.equal(vm.beats["1"].keyframePinned, true);
    assert.equal(vm.beats["1"].clipPinned, false);
    assert.equal(vm.refPinned, false);
  });

  it("ref pins behave the same as beats", () => {
    for (const f of [`${prefix}_ref.png`, `${prefix}_ref_v2.png`]) {
      fs.writeFileSync(path.join(outDir, f), "x");
    }
    // Legacy pick of v1 + v2 on disk -> reload selects v2 (latest).
    fs.writeFileSync(
      path.join(outDir, "state.json"),
      JSON.stringify({ ref: `${prefix}_ref.png`, beats: {} })
    );
    assert.equal(resolveMain(outDir, prefix, "ref", 0, ".png", null, loadState(outDir)), `${prefix}_ref_v2.png`);
    // Pinned v1 sticks.
    setMain(outDir, prefix, "ref", 0, null, `${prefix}_ref.png`, { pinned: true });
    assert.equal(resolveMain(outDir, prefix, "ref", 0, ".png", null, loadState(outDir)), `${prefix}_ref.png`);
  });
});
