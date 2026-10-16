import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBlueprint,
  buildStoryPlan,
  normalizeStoryPlan,
  chiefApproveStage,
  stageStatus,
  uncoveredPhrases,
} from "../lib/director.mjs";

const bible = () =>
  normalizeBlueprint({
    logline: "Rabbit shares.",
    analysis: { beginning: "Hoard.", middle: "Hunger.", climax: "Share.", ending: "Feast." },
    characters: [{ character_id: "rabbit", name: "Rabbit" }],
    beats: [{ n: 1, title: "Hoard", summary: "Hoard." }],
    lyric_lines: [{ lyric_line_id: 1, lyric_text: "Rabbit hops at dawn" }],
  });

describe("chief director checkpoints (Phase 1)", () => {
  it("wires production task dependencies in order", () => {
    const plan = buildStoryPlan({ input: {}, blueprint: bible() });
    const byId = new Map(plan.productionTasks.map((t) => [t.id, t]));
    assert.deepEqual(byId.get("lyric-semantics").dependsOn, ["analyze-story"]);
    assert.deepEqual(byId.get("assemble-final").dependsOn, ["generate-clips"]);
  });

  it("blocks out-of-order approval unless forced", () => {
    const board = { blueprint: bible(), scenes: [], sceneCount: 2 };
    const blocked = chiefApproveStage(board, "shot-direction");
    assert.ok(blocked.error);
    const forced = chiefApproveStage(board, "shot-direction", { force: true });
    assert.equal(forced.error, null);
    assert.ok(forced.plan.approvals["shot-direction"]);
    assert.equal(forced.plan.revisions, 1);
  });

  it("reports uncovered phrases with estimated timing", () => {
    const board = {
      input: { targetSeconds: 6 },
      blueprint: bible(),
      scenes: [],
      sceneCount: 1,
    };
    const missing = uncoveredPhrases(board);
    assert.ok(missing.length > 0);
    assert.equal(missing[0].timing_confidence, "estimated");
  });

  it("keeps legacy plans valid with department fields defaulted", () => {
    const p = normalizeStoryPlan({ logline: "x" });
    assert.equal(p.visualGuide, "");
    assert.equal(p.editPlan, "");
  });

  it("lets story boards (no song) past lyric-semantics once the bible exists", () => {
    const storyBoard = {
      input: { targetSeconds: 6 },
      blueprint: normalizeBlueprint({
        characters: [{ character_id: "ram", name: "Ram" }],
        beats: [{ n: 1, title: "Exile", summary: "Ram leaves." }],
      }),
      sceneCount: 1,
      scenes: [{ scene_number: 1, duration_seconds: 6, image_prompt: "ram at dawn", video_prompt: "walk, slow push-in" }],
    };
    const st = stageStatus(storyBoard);
    assert.equal(st[1].status, "done");
    assert.equal(st[2].status, "done");
  });
});
