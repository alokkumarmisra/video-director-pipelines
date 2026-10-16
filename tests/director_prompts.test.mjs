import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildImagePromptFor,
  buildVideoPromptFor,
  buildShotPrompts,
  validateImagePrompt,
  validateVideoPrompt,
} from "../lib/director.mjs";

const board = () => ({
  input: { visualStyle: "3D Preschool Animation" },
  blueprint: {
    characters: [{ character_id: "rabbit", name: "Rabbit", visual_identity_prompt: "small white rabbit, big eyes" }],
    locations: [{ location_id: "meadow", name: "Meadow", visual_identity_prompt: "wide sunny meadow" }],
    objects: [{ object_id: "carrot", name: "Carrot", visual_identity_prompt: "bright orange carrot" }],
  },
  scenes: [{
    scene_number: 1,
    characters: ["rabbit"], location: "meadow", continuity_refs: ["carrot"],
    camera: { shot_type: "Wide Shot", angle: "Eye Level", movement: "Static" },
    lighting: "warm morning sun",
    characters_detailed: [{ character_id: "rabbit", starting_state: "crouched", action: "hop forward", expression: "joyful smile", gaze_target: "carrot", ending_state: "standing" }],
    image_prompt: "Rabbit at dawn",
    video_prompt: "hop forward",
  }],
});

describe("image and video prompt generation (Phase 5)", () => {
  it("assembles identity + framing + lighting into the image prompt", () => {
    const p = buildImagePromptFor(board().scenes[0], board());
    assert.ok(p.includes("small white rabbit"));
    assert.ok(p.includes("meadow") || p.includes("Meadow"));
    assert.ok(/8k uhd/i.test(p));
    assert.equal(validateImagePrompt(p).length, 0);
  });
  it("keeps video prompts motion-only with the fidelity lock", () => {
    const p = buildVideoPromptFor(board().scenes[0], board());
    assert.ok(p.includes("hop forward"));
    assert.ok(p.includes("animate natural motion only"));
    assert.equal(validateVideoPrompt(p).length, 0);
  });
  it("previews every shot without touching ComfyUI", () => {
    const shots = buildShotPrompts(board());
    assert.equal(shots.length, 1);
    assert.ok(shots[0].image_prompt.length > 40);
  });
  it("grounds identities regardless of id case", () => {
    const b = board();
    b.blueprint.characters[0].character_id = "Rabbit";
    b.blueprint.locations[0].location_id = "Meadow";
    const p = buildImagePromptFor({ ...b.scenes[0], characters: ["rabbit"], location: "meadow" }, b);
    assert.ok(p.includes("small white rabbit"));
    assert.ok(/meadow/i.test(p));
  });
});
