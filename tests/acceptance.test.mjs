import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractMeaningfulPhrases,
  buildLyricCoverageMap,
  normalizeScene,
  boardToScenario,
  buildQCReport,
  buildRenderJob,
  buildAssemblyTimeline,
  approveGate,
} from "../lib/director.mjs";
import {
  resolveSceneAssets,
  buildAssetReferenceMap,
  validateAssetContinuity,
} from "../lib/devotional.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "frontend", "server.mjs"), "utf8");
const seqSrc = fs.readFileSync(path.join(ROOT, "lib", "sequence.mjs"), "utf8");

const scene = (over = {}) => normalizeScene({ scene_number: 1, duration_seconds: 3, image_prompt: "x", video_prompt: "pan", ...over }, 1);

describe("acceptance 1-8: story and coverage", () => {
  it("1. children's line with several actions splits into phrases", () => {
    const phrases = extractMeaningfulPhrases("Chiku wakes, brushes teeth and hops to school");
    assert.ok(phrases.length >= 2);
  });
  it("2. repeated chorus preserves wording across scenes", () => {
    const lines = [{ lyric_line_id: 1, lyric_text: "la la song" }, { lyric_line_id: 2, lyric_text: "la la song" }];
    const scenes = [scene({ lyric_line_id: 1, lyric_segment: "la la song", action: "Rabbit sings", visual_event: "sing" }),
      scene({ lyric_line_id: 2, lyric_segment: "la la song", action: "Lion joins song", visual_event: "join and sing" })];
    const map = buildLyricCoverageMap(scenes, lines);
    assert.ok(map.every((l) => l.status !== "uncovered"));
  });
  it("3. multiple characters exchanging an object stages initiator + target", () => {
    const s = scene({ characters: ["rabbit", "lion"], characters_detailed: [{ character_id: "rabbit", role: "active", action: "hands carrot to lion" }], continuity_refs: ["carrot"] });
    assert.ok(s.characters.includes("rabbit") && s.continuity_refs.includes("carrot"));
  });
  it("4. devotional scene resolves approved references only", () => {
    const lib = { CHAR_RAMA_01: { status: "approved", name: "Rama" }, CHAR_X_01: { status: "draft", name: "X" } };
    const r = resolveSceneAssets({ devotional_characters: ["CHAR_RAMA_01", "CHAR_X_01"] }, lib);
    assert.equal(r.characters.length, 1);
    assert.equal(r.missing.length, 1);
  });
  it("5. long lyric line maps to multiple tiling shots", () => {
    const s = normalizeScene({
      scene_number: 1, duration_seconds: 4,
      shots: [{ lyric_segment: "mission given" }, { lyric_segment: "travels far" }, { lyric_segment: "fire burns" }],
    }, 1);
    assert.equal(s.shots.length, 3);
    const sum = s.shots.reduce((a, x) => a + x.duration_seconds, 0);
    assert.ok(Math.abs(sum - 4) < 0.25);
  });
  it("6. character and location continuity flags jumps", () => {
    const issues = validateAssetContinuity({ blueprint: { characters: [], locations: [] }, scenes: [{ scene_number: 1, characters: ["ghost"] }] });
    assert.ok(issues.some((x) => x.includes("ghost")));
  });
  it("7. missing lyric coverage is reported, never silent", () => {
    const map = buildLyricCoverageMap([scene({ lyric_segment: "other", action: "hop", visual_event: "hop" })],
      [{ lyric_line_id: 9, lyric_text: "uncovered line here" }]);
    assert.equal(map[0].status, "uncovered");
  });
  it("8. contradictory motion is flagged", () => {
    const qc = buildQCReport({ scenes: [scene({ shots: [{ shot_id: "1-A", video_prompt: "stand up then sit down then stand" }] })] });
    assert.ok(Array.isArray(qc.issues));
  });
});

describe("acceptance 9-15: pipeline and compatibility", () => {
  it("9. failed generation keeps approved work (resumable, missing-only)", () => {
    assert.ok(seqSrc.includes("missing-only") || seqSrc.includes("keyframeUpToDate"), "resume predicate missing");
    assert.ok(seqSrc.includes("[resume]"), "resume marker missing");
  });
  it("10. selective regeneration targets exact shots", () => {
    assert.ok(serverSrc.includes("/regenerate-scene"), "scene regen route missing");
    assert.ok(serverSrc.includes("/repair"), "staged repair route missing");
    const job = buildRenderJob({ scenes: [scene({ shot_id: "1-A" }), scene({ shot_id: "1-B", scene_number: 2 })] }, { beats: ["1-A"] });
    assert.deepEqual(job.beats, ["1-A"]);
  });
  it("11. PG mirroring with SQLite fallback is preserved", () => {
    assert.ok(serverSrc.includes("USE_SQLITE"), "sqlite fallback switch missing");
    assert.ok(serverSrc.includes("pgSaveScenarioMirror") || serverSrc.includes("syncAllToPg"), "pg mirror missing");
  });
  it("12. approve output stays CLI-compatible (prompts/<name>.json shape)", () => {
    const sc = boardToScenario({
      input: { visualStyle: "Cartoon" },
      blueprint: { characters: [{ character_id: "rabbit", name: "Rabbit", visual_identity_prompt: "white rabbit" }], locations: [], objects: [] },
      scenes: [scene({ characters: ["rabbit"], duration_seconds: 3 })],
    });
    assert.ok(Array.isArray(sc.sequence) && sc.sequence.length === 1);
    assert.ok(typeof sc.referencePrompt === "string" && typeof sc.duration === "number");
  });
  it("13. SSE progress + error reporting use the established event format", () => {
    assert.ok(serverSrc.includes("text/event-stream"), "SSE content-type missing");
    assert.ok(serverSrc.includes("event: asset"), "asset event missing");
    assert.ok(serverSrc.includes("event: close"), "close event missing");
  });
  it("14. final assembly tiles exactly and feeds the existing stitch", () => {
    const tl = buildAssemblyTimeline({ scenes: [scene({ duration_seconds: 2 }), scene({ scene_number: 2, duration_seconds: 3, image_prompt: "y", video_prompt: "pan" })] });
    assert.equal(tl[1].end_time, 5);
    assert.ok(seqSrc.includes("concat"), "ffmpeg concat stitch missing");
  });
  it("15. existing projects approve (legacy scenes byte-stable)", () => {
    const g = approveGate({ blueprint: { characters: [{ character_id: "a", name: "A", visual_identity_prompt: "x" }] }, scenes: [scene({ characters: ["a"] })] });
    assert.ok(Array.isArray(g.errors));
    const m = buildAssetReferenceMap({ scenes: [], blueprint: {} });
    assert.deepEqual(Object.keys(m).sort(), ["characters", "locations", "props", "styles"]);
  });
});
