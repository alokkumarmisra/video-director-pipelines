import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildShotList,
  buildCameraMotionPlan,
  buildLightingPlan,
  buildBlockingPlan,
  buildTransitionPlan,
  validateCinematography,
} from "../lib/director.mjs";

const board = () => ({
  scenes: [
    {
      scene_number: 1, duration_seconds: 3,
      lyric_line_id: 1, lyric_segment: "Rabbit hops",
      dramatic_purpose: "Establish playful morning",
      camera: { shot_type: "Wide Shot", angle: "Eye Level", movement: "Static" },
      location: "meadow", time_of_day: "morning", lighting: "warm sun",
      characters_detailed: [{ character_id: "rabbit", gaze_target: "carrot", starting_state: "crouched", action: "hop forward", ending_state: "standing" }],
      shots: [
        { shot_id: "1-A", duration_seconds: 1.5, dramatic_purpose: "Hop in", camera: { shot_type: "Wide Shot", angle: "Eye Level", movement: "Static" }, characters_detailed: [{ character_id: "rabbit", action: "hop" }] },
        { shot_id: "1-B", duration_seconds: 1.5, dramatic_purpose: "Land close", camera: { shot_type: "Close-up", angle: "Eye Level", movement: "Slow push-in" }, characters_detailed: [{ character_id: "rabbit", action: "land" }] },
      ],
    },
    { scene_number: 2, duration_seconds: 2, dramatic_purpose: "Share", camera: { shot_type: "Medium Shot", angle: "Eye Level", movement: "Static" }, transition_to_next_scene: "" },
  ],
});

describe("cinematography and shot planning (Phase 3)", () => {
  it("flattens multi-shot scenes to one beat each", () => {
    assert.equal(buildShotList(board()).length, 3);
  });
  it("infers camera speed from movement", () => {
    const cam = buildCameraMotionPlan(board());
    assert.equal(cam.find((c) => c.shot_id === "1-B").speed, "slow");
  });
  it("plans lighting, blocking and transitions", () => {
    assert.equal(buildLightingPlan(board())[0].time_of_day, "morning");
    assert.equal(buildBlockingPlan(board())[0].cast[0].character_id, "rabbit");
    assert.equal(buildTransitionPlan(board()).length, 2);
  });
  it("flags missing purpose and monotonous coverage", () => {
    const mono = { scenes: [1, 2, 3, 4].map((n) => ({ scene_number: n, camera: { shot_type: "Wide Shot", movement: "Static" } })) };
    assert.ok(validateCinematography(mono).some((x) => x.includes("vary")));
  });
});
