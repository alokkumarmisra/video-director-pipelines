import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIRECTOR_STAGES,
  normalizeStoryPlan,
  buildStoryPlan,
  stageStatus,
  approveGate,
  normalizeBlueprint,
} from "../lib/director.mjs";

const bible = () =>
  normalizeBlueprint({
    logline: "A rabbit learns to share.",
    analysis: {
      beginning: "Rabbit hoards carrots.",
      middle: "Lion cub goes hungry.",
      climax: "Rabbit shares the harvest.",
      ending: "Feast together.",
      emotional_progression: "selfishness to generosity",
    },
    characters: [{ character_id: "rabbit", name: "Rabbit", role: "hero" }],
    locations: [{ location_id: "meadow", name: "Meadow" }],
    objects: [],
    beats: [{ n: 1, title: "Hoard", summary: "Rabbit hoards." }],
    lyric_lines: [{ lyric_line_id: 1, lyric_text: "Rabbit hops at dawn" }],
  });

describe("story plan", () => {
  it("builds an authoritative plan from the bible", () => {
    const plan = buildStoryPlan({ input: {}, blueprint: bible() });
    assert.equal(plan.logline, "A rabbit learns to share.");
    assert.equal(plan.structure.climax, "Rabbit shares the harvest.");
    assert.equal(plan.characterRoster.length, 1);
    assert.equal(plan.characterRoster[0].character_id, "rabbit");
    assert.equal(plan.productionTasks.length, 10);
    assert.equal(plan.revisions, 0);
  });

  it("normalizes defensively and never throws", () => {
    for (const raw of [null, undefined, 42, "x", [], { approvals: { bogus: "yes" } }]) {
      const p = normalizeStoryPlan(raw);
      assert.equal(p.version, 1);
      assert.deepEqual(p.approvals, {});
    }
    const p = normalizeStoryPlan({
      approvals: { "story-analysis": "2026-01-01", bogus: 1 },
      productionTasks: [{ id: "analyze-story", status: "weird" }],
    });
    assert.equal(p.approvals["story-analysis"], "2026-01-01");
    assert.equal(p.productionTasks[0].status, "pending");
    assert.equal(p.productionTasks[0].stage, "story-analysis");
  });

  it("records uncertainties when the bible is thin", () => {
    const plan = buildStoryPlan({ input: {}, blueprint: normalizeBlueprint({}) });
    assert.ok(plan.uncertainties.length > 0);
  });
});

describe("stage pipeline", () => {
  it("gates stages on artefacts in dependency order", () => {
    const empty = stageStatus({ scenes: [], sceneCount: 4 });
    assert.equal(empty[0].status, "ready");
    assert.ok(empty.slice(1).every((s) => s.status === "blocked"));

    const analyzed = stageStatus({ blueprint: bible(), scenes: [], sceneCount: 4, sceneSeconds: 3 });
    assert.equal(analyzed[0].status, "done");
    assert.equal(analyzed[1].status, "done"); // lyric_lines present
    assert.equal(analyzed[2].status, "ready");
    assert.equal(analyzed[3].status, "blocked");
  });

  it("marks shot-direction done only with full prompts", () => {
    const board = {
      blueprint: bible(),
      sceneCount: 1,
      scenes: [{ scene_number: 1, image_prompt: "rabbit", video_prompt: "hop, slow push-in" }],
    };
    const st = stageStatus(board);
    assert.equal(st[2].status, "done");
    assert.equal(st[3].status, "done");
  });

  it("reflects chief-director approvals", () => {
    const board = {
      blueprint: bible(),
      sceneCount: 1,
      scenes: [{ scene_number: 1, image_prompt: "x", video_prompt: "y slow pan" }],
      storyPlan: { approvals: { "coverage-validation": "2026-10-16" } },
    };
    const st = stageStatus(board);
    assert.equal(st[4].status, "approved");
    assert.equal(st[4].approvedAt, "2026-10-16");
  });
});

describe("approve gate", () => {
  it("blocks on structural errors, warns on quality", () => {
    const bad = approveGate({ scenes: [] });
    assert.ok(bad.errors.length > 0);
    const good = approveGate({
      input: { targetSeconds: 3 },
      blueprint: bible(),
      sceneCount: 1,
      scenes: [
        {
          scene_number: 1,
          duration_seconds: 3,
          characters: ["rabbit"],
          image_prompt: "rabbit at dawn",
          video_prompt: "rabbit hops, slow push-in",
          lyric_line_id: 1,
          lyric_segment: "Rabbit hops at dawn",
          action: "Rabbit hops across the meadow",
        },
      ],
    });
    assert.deepEqual(good.errors, []);
    assert.equal(typeof good.score, "number");
  });

  it("enforces an optional score floor", () => {
    const gated = approveGate({ scenes: [] }, { minScore: 80 });
    assert.ok(gated.errors.some((e) => e.includes("below the approval floor")));
  });
});

describe("story plan server wiring (static)", () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const server = fs.readFileSync(path.join(root, "frontend", "server.mjs"), "utf8");
  it("exposes GET /api/director/boards/:id/plan", () => {
    assert.ok(server.includes("/api\\/director\\/boards\\/[^/]+\\/plan$"), "plan route registered");
  });
  it("builds the Story Plan at analyze time", () => {
    assert.ok(server.includes("storyPlan: buildStoryPlan({ input, blueprint })"), "analyze persists storyPlan");
  });
  it("approves through the single approveGate", () => {
    assert.ok(server.includes("approveGate(board)"), "approve uses approveGate");
  });
});
