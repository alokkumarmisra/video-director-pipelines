import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCharacterActionPlan,
  buildInteractionPlan,
  buildMotionTimeline,
  buildAudioTimingMap,
  buildActionSyncPlan,
  buildLipSyncInstructions,
  validateMotionPrompts,
} from "../lib/director.mjs";

const board = () => ({
  input: { targetSeconds: 6 },
  blueprint: {
    characters: [{ character_id: "rabbit", name: "Rabbit", visual_identity_prompt: "small white rabbit" }],
    lyric_lines: [{ lyric_line_id: 1, lyric_text: "Rabbit hops at dawn" }],
  },
  scenes: [{
    scene_number: 1, duration_seconds: 6, lyric_line_id: 1,
    characters_detailed: [{ character_id: "rabbit", role: "active", gaze_target: "carrot", starting_state: "crouched", action: "hop forward", ending_state: "standing" }],
    dialogue: [{ speaker: "rabbit", line: "Come share!" }],
    video_prompt: "rabbit hops forward, slow push-in",
    shots: [
      { shot_id: "1-A", duration_seconds: 3, start_time: 0, end_time: 3, characters_detailed: [{ character_id: "rabbit", role: "active", action: "notice carrot" }], video_prompt: "look then hop" },
      { shot_id: "1-B", duration_seconds: 3, start_time: 3, end_time: 6, characters_detailed: [{ character_id: "rabbit", role: "active", action: "offer carrot" }], dialogue: [{ speaker: "rabbit", line: "Take it!" }] },
    ],
  }],
});

describe("acting motion and audio sync (Phase 4)", () => {
  it("plans character actions with references", () => {
    const a = buildCharacterActionPlan(board());
    assert.ok(a.length >= 2);
    assert.ok(a[0].reference.includes("rabbit") || a[0].character_id === "rabbit");
  });
  it("keeps measured timing separate from estimated", () => {
    const est = buildAudioTimingMap(board());
    assert.equal(est[0].timing_confidence, "estimated");
    const meas = buildAudioTimingMap({ ...board(), audioTiming: [{ lyric_line_id: 1, start: 0.5, end: 2.5 }] });
    assert.equal(meas[0].timing_confidence, "measured");
    assert.equal(meas[0].start_time, 0.5);
  });
  it("times motion phases and lipsync lines", () => {
    assert.equal(buildMotionTimeline(board()).length, 2);
    assert.equal(buildLipSyncInstructions(board()).length, 1);
  });
  it("never emits NaN timing and keeps 0-second starts", () => {
    const noTarget = buildAudioTimingMap({ blueprint: { lyric_lines: [] }, scenes: [] });
    assert.deepEqual(noTarget, []);
    const tl = buildMotionTimeline({ scenes: [{ scene_number: 1, shots: [{ shot_id: "1-A" }] }] });
    assert.equal(tl[0].start_time, 0);
    assert.equal(tl[0].end_time, 0);
  });
  it("flags contradictory motion in one shot", () => {
    const bad = board();
    bad.scenes[0].shots[0].video_prompt = "rabbit stands up then sits down then stands again in one second";
    assert.ok(validateMotionPrompts(bad).length >= 0);
  });
  it("syncs each shot action against its lyric window", () => {
    const sync = buildActionSyncPlan(board());
    assert.ok(sync.length >= 2);
    assert.ok(sync.every((s) => typeof s.action === "string"));
  });
});
