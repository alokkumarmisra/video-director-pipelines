import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAssetReferenceMap,
  findDuplicateAssets,
  buildVisualStyleGuide,
  validateAssetContinuity,
} from "../lib/devotional.mjs";

const board = () => ({
  input: { visualStyle: "3D Preschool Animation" },
  blueprint: {
    characters: [
      { character_id: "rabbit", name: "Rabbit" },
      { character_id: "lion", name: "Lion" },
    ],
    locations: [{ location_id: "meadow", name: "Meadow", color_palette: "warm greens", lighting: "morning sun", visual_identity_prompt: "wide meadow" }],
    objects: [{ object_id: "carrot", name: "Carrot" }],
  },
  scenes: [
    { scene_number: 1, characters: ["rabbit"], location: "meadow", continuity_refs: ["carrot"], image_prompt: "x", video_prompt: "hop" },
    { scene_number: 2, characters: ["rabbit", "lion"], location: "meadow", image_prompt: "x", video_prompt: "share" },
  ],
});

describe("world and asset intelligence (Phase 2)", () => {
  it("maps characters/locations/props to scenes", () => {
    const m = buildAssetReferenceMap(board());
    assert.deepEqual(m.characters.find((c) => c.id === "rabbit").scenes, [1, 2]);
    assert.deepEqual(m.locations.find((l) => l.id === "meadow").scenes, [1, 2]);
    assert.deepEqual(m.props.find((p) => p.id === "carrot").scenes, [1]);
  });

  it("flags duplicate assets instead of recreating", () => {
    const dupes = findDuplicateAssets([
      { character_id: "rabbit_1", name: "Rabbit" },
      { character_id: "rabbit_2", name: "rabbit" },
    ]);
    assert.equal(dupes.length, 1);
    assert.deepEqual(dupes[0].ids.sort(), ["rabbit_1", "rabbit_2"]);
  });

  it("builds a visual style guide from the board", () => {
    const g = buildVisualStyleGuide(board());
    assert.equal(g.style, "3D Preschool Animation");
    assert.equal(g.characters, 2);
    assert.ok(g.palettes.includes("warm greens"));
  });

  it("flags unknown cast and costume drift", () => {
    const bad = board();
    bad.scenes[1].characters.push("ghost");
    const issues = validateAssetContinuity(bad);
    assert.ok(issues.some((x) => x.includes("ghost")));
  });
});
