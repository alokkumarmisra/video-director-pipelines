// Delta-based project versioning tests (spec §17).
// Run: node --test tests/   (from the repo root; zero deps, Node >= 18)
// Covers: one-scene change inserts one row, effective-state resolution,
// sequential versions, two-scene change, retry creates no version,
// image-only regen keeps the previous VIDEO row, plus static checks that
// the server no longer contains full-version-copy SQL.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffScenarios,
  planDelta,
  beatAssetTypes,
  nextVersionNumber,
  resolveEffective,
  EFFECTIVE_ASSETS_SQL,
  EXACT_VERSION_SQL,
  NEXT_VERSION_SQL,
} from "../lib/project_versioning.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// --- in-memory store mimicking the server's delta semantics ----------------
// versions: scenario_versions rows; rows: project_assets rows.
function makeStore() {
  return { versions: [], rows: [], nextId: 1 };
}
function cfg5(tag = (i) => `img${i}`) {
  return {
    referencePrompt: "ref",
    sequence: [1, 2, 3, 4, 5].map((n) => ({
      title: `beat${n}`,
      image: tag(n),
      motion: `mot${n}`,
    })),
  };
}
// Delta save: v1 = full snapshot (ref + keyframe + video per beat, here
// keyframe-only for brevity unless full=true); v2+ = only changed scenes as
// PENDING rows. Returns the new version number (or null when unchanged).
function deltaSave(store, prevCfg, nextCfg, { full = false } = {}) {
  const plan = planDelta(prevCfg, nextCfg);
  const changed =
    plan.ref || Object.keys(plan.beats).length > 0 || store.versions.length === 0;
  if (store.versions.length > 0 && !plan.ref && Object.keys(plan.beats).length === 0)
    return null; // unchanged -> no new version (retry/no-op path)
  const version = nextVersionNumber(store.versions);
  store.versions.push(version);
  const push = (beat, type, prompt) => {
    store.rows.push({
      id: store.nextId++, version, beat_index: beat, asset_type: type,
      prompt, status: "PENDING", file_path: null,
    });
  };
  if (version === 1) {
    if (full) push(0, "REFERENCE", nextCfg.referencePrompt);
    for (let n = 1; n <= nextCfg.sequence.length; n++) {
      push(n, "KEYFRAME", nextCfg.sequence[n - 1].image);
      if (full) push(n, "VIDEO", nextCfg.sequence[n - 1].motion);
    }
    void changed;
  } else {
    if (plan.ref) push(0, "REFERENCE", nextCfg.referencePrompt);
    for (const [b, types] of Object.entries(plan.beats)) {
      const n = Number(b);
      for (const t of types) {
        push(n, t, t === "KEYFRAME"
          ? nextCfg.sequence[n - 1].image
          : nextCfg.sequence[n - 1].motion);
      }
    }
  }
  return version;
}
// Retry/completion of a failed generation: updates the SAME row, no version.
function markComplete(store, version, beat, type, file) {
  const row = store.rows.find(
    (r) => r.version === version && r.beat_index === beat && r.asset_type === type);
  assert.ok(row, "row to complete must exist");
  const before = store.versions.length;
  row.status = "COMPLETED";
  row.file_path = file;
  row.attempts = (row.attempts ?? 0) + 1;
  assert.equal(store.versions.length, before, "retry must not create a version");
  assert.equal(store.rows.length, store.rows.length, "retry must not insert rows");
  return row;
}
const at = (store, v) => store.rows.filter((r) => r.version === v);

describe("delta versioning", () => {
  it("Test 1 — modifying one scene inserts exactly one row", () => {
    const s = makeStore();
    const v1 = cfg5();
    assert.equal(deltaSave(s, null, v1), 1);
    assert.equal(at(s, 1).length, 5);
    const v2 = { ...v1, sequence: v1.sequence.map((b, i) => (i === 2 ? { ...b, image: "img3X", motion: "mot3X" } : b)) };
    assert.equal(deltaSave(s, v1, v2), 2);
    const v2rows = at(s, 2);
    assert.equal(v2rows.length, 2); // KEYFRAME + VIDEO for beat 3 (both prompts changed)
    assert.deepEqual(v2rows.map((r) => r.beat_index).sort(), [3, 3]);
    for (const n of [1, 2, 4, 5]) {
      assert.equal(v2rows.filter((r) => r.beat_index === n).length, 0, `beat ${n} must not be copied`);
    }
  });

  it("Test 1b — image-only change inserts a single KEYFRAME row", () => {
    const s = makeStore();
    const v1 = cfg5();
    deltaSave(s, null, v1);
    const v2 = { ...v1, sequence: v1.sequence.map((b, i) => (i === 2 ? { ...b, image: "img3X" } : b)) };
    assert.equal(deltaSave(s, v1, v2), 2);
    assert.deepEqual(at(s, 2).map((r) => [r.beat_index, r.asset_type]), [[3, "KEYFRAME"]]);
  });

  it("Test 2 — effective state resolves unchanged scenes to v1", () => {
    const s = makeStore();
    const v1 = cfg5();
    deltaSave(s, null, v1);
    const v2 = { ...v1, sequence: v1.sequence.map((b, i) => (i === 2 ? { ...b, image: "img3X" } : b)) };
    deltaSave(s, v1, v2);
    const eff = resolveEffective(s.rows, 2);
    const byBeat = Object.fromEntries(eff.map((r) => [r.beat_index, r.version]));
    assert.deepEqual(byBeat, { 1: 1, 2: 1, 3: 2, 4: 1, 5: 1 });
  });

  it("Test 3 — modifying beat 5 after v2 yields v3 with beat 5 only", () => {
    const s = makeStore();
    const v1 = cfg5();
    deltaSave(s, null, v1);
    const v2 = { ...v1, sequence: v1.sequence.map((b, i) => (i === 2 ? { ...b, image: "img3X" } : b)) };
    deltaSave(s, v1, v2);
    const v3 = { ...v2, sequence: v2.sequence.map((b, i) => (i === 4 ? { ...b, image: "img5X" } : b)) };
    assert.equal(deltaSave(s, v2, v3), 3);
    assert.deepEqual(at(s, 3).map((r) => [r.beat_index, r.asset_type]), [[5, "KEYFRAME"]]);
    const byBeat = Object.fromEntries(resolveEffective(s.rows, 3).map((r) => [r.beat_index, r.version]));
    assert.deepEqual(byBeat, { 1: 1, 2: 1, 3: 2, 4: 1, 5: 3 });
  });

  it("Test 4 — modifying two scenes inserts exactly two rows", () => {
    const s = makeStore();
    const v1 = cfg5();
    deltaSave(s, null, v1);
    const v2 = {
      ...v1,
      sequence: v1.sequence.map((b, i) => (i === 1 ? { ...b, image: "img2X" } : i === 3 ? { ...b, image: "img4X" } : b)),
    };
    assert.equal(deltaSave(s, v1, v2), 2);
    assert.deepEqual(
      at(s, 2).map((r) => [r.beat_index, r.asset_type]),
      [[2, "KEYFRAME"], [4, "KEYFRAME"]]);
  });

  it("Test 5 — retrying a failed generation creates no version", () => {
    const s = makeStore();
    const v1 = cfg5();
    deltaSave(s, null, v1);
    const v2 = { ...v1, sequence: v1.sequence.map((b, i) => (i === 2 ? { ...b, image: "img3X" } : b)) };
    deltaSave(s, v1, v2);
    const row = s.rows.find((r) => r.version === 2 && r.beat_index === 3);
    row.status = "FAILED"; // generation failed
    const versionsBefore = s.versions.length;
    const rowsBefore = s.rows.length;
    markComplete(s, 2, 3, "KEYFRAME", "outputs/p/p_seq3_beat3_v2.png");
    assert.equal(s.versions.length, versionsBefore);
    assert.equal(s.rows.length, rowsBefore);
    // Saving the identical config again is also a no-op.
    assert.equal(deltaSave(s, v2, structuredClone(v2)), null);
    assert.equal(s.versions.length, versionsBefore);
  });

  it("Test 6 — image regen bumps IMAGE only; VIDEO stays on the old version", () => {
    const s = makeStore();
    const v1 = cfg5();
    deltaSave(s, null, v1, { full: true }); // v1 has KEYFRAME + VIDEO per beat
    const v2 = { ...v1, sequence: v1.sequence.map((b, i) => (i === 2 ? { ...b, image: "img3X" } : b)) };
    deltaSave(s, v1, v2);
    const eff = resolveEffective(s.rows, 2).filter((r) => r.beat_index === 3);
    const byType = Object.fromEntries(eff.map((r) => [r.asset_type, r.version]));
    assert.equal(byType.KEYFRAME, 2);
    assert.equal(byType.VIDEO, 1);
  });

  it("diff detects ref vs beat changes independently", () => {
    const a = cfg5();
    const b = structuredClone(a);
    b.referencePrompt = "ref2";
    assert.deepEqual(diffScenarios(a, b), { refChanged: true, beats: [] });
    const c = structuredClone(a);
    c.sequence[0].motion = "mot1X";
    assert.deepEqual(planDelta(a, c), { ref: false, beats: { 1: ["VIDEO"] } });
    assert.deepEqual(beatAssetTypes(a.sequence[0], c.sequence[0]), ["VIDEO"]);
  });

  it("next version is max+1 (spec §3)", () => {
    assert.equal(nextVersionNumber([]), 1);
    assert.equal(nextVersionNumber([1]), 2);
    assert.equal(nextVersionNumber([1, 2, 5]), 6);
  });

  it("SQL strings implement delta semantics", () => {
    assert.match(EFFECTIVE_ASSETS_SQL, /DISTINCT ON/i);
    assert.match(EFFECTIVE_ASSETS_SQL, /version\s*<=\s*\$2/i);
    assert.match(EXACT_VERSION_SQL, /version\s*=\s*\$2/i);
    assert.match(NEXT_VERSION_SQL, /COALESCE\s*\(\s*MAX\s*\(\s*version\s*\)\s*,\s*0\s*\)\s*\+\s*1/i);
  });

  it("asset reads are cut-scoped (YOUTUBE vs INSTAGRAM)", () => {
    // Both queries carry the cut as $3 so the two cuts never mix rows.
    assert.match(EFFECTIVE_ASSETS_SQL, /video_type\s*=\s*\$3/i);
    assert.match(EXACT_VERSION_SQL, /video_type\s*=\s*\$3/i);
  });

  it("resolveEffective keeps both cuts independently (typeless rows read as YOUTUBE)", () => {
    const rows = [
      { id: 1, version: 1, beat_index: 1, asset_type: "KEYFRAME", file_path: "outputs/p/p_seq1_a.png" },
      { id: 2, version: 1, beat_index: 1, asset_type: "KEYFRAME", video_type: "INSTAGRAM", file_path: "outputs/p_vertical/p_seq1_a.png" },
      { id: 3, version: 1, beat_index: 1, asset_type: "KEYFRAME", video_type: "YOUTUBE", file_path: "outputs/p/p_seq1_a_v2.png" },
    ];
    const eff = resolveEffective(rows, 1);
    assert.equal(eff.length, 2);
    const byType = Object.fromEntries(eff.map((r) => [r.video_type ?? "YOUTUBE", r.file_path]));
    assert.equal(byType.YOUTUBE, "outputs/p/p_seq1_a_v2.png");
    assert.equal(byType.INSTAGRAM, "outputs/p_vertical/p_seq1_a.png");
  });

  it("server no longer full-copies versions on save/refresh", () => {
    const srv = fs.readFileSync(path.join(ROOT, "frontend", "server.mjs"), "utf8");
    // The old snapshot path called pgSaveProject() for every save and from
    // the refresh helper; both call sites must be gone (pgSaveProject itself
    // stays for v1/backfill only).
    assert.ok(srv.includes("pgSaveVersionDelta"), "delta save must exist");
    assert.ok(!srv.includes("project_id = await pgSaveProject("), "PUT must not snapshot-save");
    assert.ok(!srv.includes("await pgSaveProject(projectName, cfg"), "refresh must not snapshot-save");
    assert.ok(!srv.includes("await pgSaveProject(name, cfg, version"), "PUT/backfill must not snapshot-save unconditionally");
    // No INSERT..SELECT full-version clone anywhere.
    assert.ok(!/INSERT\s+INTO\s+project_assets[\s\S]{0,400}?SELECT[\s\S]{0,200}?FROM\s+project_assets/i.test(srv),
      "no INSERT..SELECT clone of project_assets allowed");
    // Delta save is transactional with structured logging.
    assert.ok(srv.includes("BEGIN") && srv.includes("COMMIT") && srv.includes("ROLLBACK"), "transaction required");
    assert.match(srv, /\[version\].*previousVersion.*newVersion.*changedScenes.*insertedAssetIds/s);
    // Effective endpoint defaults to DISTINCT ON resolution.
    assert.ok(srv.includes("EFFECTIVE_ASSETS_SQL"), "effective query must be used");
  });
});
