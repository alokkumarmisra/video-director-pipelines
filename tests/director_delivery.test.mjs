import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEditPlan,
  buildAssemblyTimeline,
  buildRenderJob,
  buildQCReport,
} from "../lib/director.mjs";

const board = () => ({
  input: { targetSeconds: 5 },
  blueprint: {
    characters: [{ character_id: "rabbit", name: "Rabbit" }],
    lyric_lines: [{ lyric_line_id: 1, lyric_text: "Rabbit hops" }],
  },
  sceneCount: 2,
  scenes: [
    { scene_number: 1, duration_seconds: 3, lyric_line_id: 1, lyric_segment: "Rabbit hops", action: "Rabbit hops", image_prompt: "rabbit", video_prompt: "hop, slow push-in", characters: ["rabbit"], transition_to_next_scene: "cut" },
    { scene_number: 2, duration_seconds: 2, image_prompt: "rabbit shares", video_prompt: "offer, static", characters: ["rabbit"] },
  ],
});

describe("editing assembly and QC (Phase 7)", () => {
  it("orders the edit plan and tiles the timeline exactly", () => {
    const plan = buildEditPlan(board());
    assert.equal(plan.length, 2);
    const tl = buildAssemblyTimeline(board());
    assert.equal(tl[0].start_time, 0);
    assert.equal(tl[1].end_time, 5);
  });
  it("specs a resumable selective render job", () => {
    const job = buildRenderJob(board(), { format: "INSTAGRAM", beats: ["1-A"] });
    assert.equal(job.format, "INSTAGRAM");
    assert.equal(job.resumable, true);
  });
  it("gates QC on errors and names regen targets", () => {
    const qc = buildQCReport(board());
    assert.equal(typeof qc.pass, "boolean");
    assert.ok(Array.isArray(qc.regenTargets));
  });
});
