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
  loadState, setMain, clearRefMain, isRefOff, resolveMain, isPinnedState, versionMap,
} from "../lib/sequence_state.mjs";

// lib/sequence.mjs pulls lib/comfy.mjs, which exits without COMFY_BASE —
// dummy value is enough: these tests never touch the network.
process.env.COMFY_BASE ??= "http://localhost:1";

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
    // Legacy pick of v1 + v2 on disk -> reload selects v2 (latest) for beats.
    // Ref is explicit-only: no auto-latest, so state resolves to pinned v1.
    fs.writeFileSync(
      path.join(outDir, "state.json"),
      JSON.stringify({ ref: `${prefix}_ref.png`, beats: {} })
    );
    assert.equal(resolveMain(outDir, prefix, "ref", 0, ".png", null, loadState(outDir)), `${prefix}_ref.png`);
    // Pinned v1 sticks.
    setMain(outDir, prefix, "ref", 0, null, `${prefix}_ref.png`, { pinned: true });
    assert.equal(resolveMain(outDir, prefix, "ref", 0, ".png", null, loadState(outDir)), `${prefix}_ref.png`);
  });

  it("a skip-only full run keeps the pinned ref main (no silent unpin to latest)", async () => {
    // Reported bug: user pins ref v3 with v4 on disk; the next full run
    // skipped the reference but cleared the pin, so the gallery flipped to
    // v4 (auto-latest) on reload. Skips must preserve the pin.
    process.env.COMFY_BASE ??= "http://localhost:1";
    const { runSequence } = await import("../lib/sequence.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-run-"));
    const ref = (v) => (v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`);
    for (const v of [1, 2, 3, 4]) fs.writeFileSync(path.join(dir, ref(v)), "x");
    // User picks v3 as main (what the UI select-as-main does).
    setMain(dir, prefix, "ref", 0, null, ref(3), { pinned: true });
    // Empty sequence: genRef takes the skip path (no network), stitch is a
    // no-op with no scenes (no ffmpeg) — only state handling is exercised.
    const builders = {
      buildRef: () => { throw new Error("must not generate on skip"); },
      buildKeyframe: () => { throw new Error("must not generate on skip"); },
      buildClip: () => { throw new Error("must not generate on skip"); },
    };
    await runSequence({
      scenario: prefix, outDir: dir, prefix, tag: "[test]", cfg: { sequence: [] },
      videoNode: "75", ...builders,
    });
    const st = loadState(dir);
    assert.equal(isPinnedState(st, "ref", 0), true);
    assert.equal(st.ref, ref(3));
    assert.equal(resolveMain(dir, prefix, "ref", 0, ".png", null, st), ref(3));
  });

  it("deselecting the ref serves no reference input (toggle off)", () => {
    for (const f of [`${prefix}_ref.png`, `${prefix}_ref_v2.png`]) {
      fs.writeFileSync(path.join(outDir, f), "x");
    }
    setMain(outDir, prefix, "ref", 0, null, `${prefix}_ref_v2.png`, { pinned: true });
    clearRefMain(outDir);
    const st = loadState(outDir);
    assert.equal(isRefOff(st), true);
    // Versions stay on disk and listed, but nothing resolves as main.
    assert.equal(resolveMain(outDir, prefix, "ref", 0, ".png", null, st), null);
    const vm = versionMap(outDir, prefix, seq);
    assert.equal(vm.refMain, null);
    assert.equal(vm.refOff, true);
    assert.equal(vm.ref.length, 2);
  });

  it("picking a ref after deselect re-enables reference input", () => {
    for (const f of [`${prefix}_ref.png`, `${prefix}_ref_v2.png`]) {
      fs.writeFileSync(path.join(outDir, f), "x");
    }
    clearRefMain(outDir);
    assert.equal(isRefOff(loadState(outDir)), true);
    // What the UI select-as-main does on the next click.
    setMain(outDir, prefix, "ref", 0, null, `${prefix}_ref.png`, { pinned: true });
    const st = loadState(outDir);
    assert.equal(isRefOff(st), false);
    assert.equal(resolveMain(outDir, prefix, "ref", 0, ".png", null, st), `${prefix}_ref.png`);
  });

  it("a skip-only full run keeps the deselected ref off (no silent re-enable)", async () => {
    const { runSequence } = await import("../lib/sequence.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-run-off-"));
    const ref = (v) => (v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`);
    for (const v of [1, 2]) fs.writeFileSync(path.join(dir, ref(v)), "x");
    clearRefMain(dir);
    const builders = {
      buildRef: () => { throw new Error("must not generate on skip"); },
      buildKeyframe: () => { throw new Error("must not generate on skip"); },
      buildClip: () => { throw new Error("must not generate on skip"); },
    };
    await runSequence({
      scenario: prefix, outDir: dir, prefix, tag: "[test]", cfg: { sequence: [] },
      videoNode: "75", ...builders,
    });
    const st = loadState(dir);
    assert.equal(isRefOff(st), true);
    assert.equal(resolveMain(dir, prefix, "ref", 0, ".png", null, st), null);
  });

  it("resolveRefForRun skips sibling fallbacks when ref is off", async () => {
    const { resolveRefForRun } = await import("../lib/sequence.mjs");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ref-off-"));
    const own = path.join(parent, "proj");
    const sib = path.join(parent, "proj_wan");
    fs.mkdirSync(own, { recursive: true });
    fs.mkdirSync(sib, { recursive: true });
    fs.writeFileSync(path.join(sib, "proj_wan_ref.png"), "x");
    // No own ref and nothing deselected -> sibling cut's ref serves as input.
    assert.equal(resolveRefForRun(own, "proj").file, "proj_wan_ref.png");
    // Deselected in the own dir -> no input at all, siblings included.
    clearRefMain(own);
    assert.equal(resolveRefForRun(own, "proj").file, null);
  });
});
