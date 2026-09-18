// AI Story Director lib: JSON reliability, scene math, style lock,
// normalization and the board -> scenario handoff (all pure, no network).
// Run: node --test tests/director.test.mjs (from the repo root)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCENE_BATCH,
  MAX_SCENES,
  sceneCountFor,
  styleLockFor,
  styleKeyFor,
  stripJson,
  normalizeBlueprint,
  normalizeScene,
  beatsForSceneRange,
  sameLine,
  identityContext,
  buildBiblePrompt,
  buildScenesPrompt,
  boardToScenario,
} from "../lib/director.mjs";

describe("sceneCountFor", () => {
  it("derives scene count from target / scene duration (story + time driven)", () => {
    assert.equal(sceneCountFor(190, 3), 63);
    assert.equal(sceneCountFor(60, 3), 20);
    assert.equal(sceneCountFor(30, 5), 6);
    assert.equal(sceneCountFor(600, 3), 200);
    assert.equal(sceneCountFor(3600, 1), MAX_SCENES); // safety ceiling only
    assert.equal(sceneCountFor(0, 3), 0);
    assert.equal(sceneCountFor(60, 0), 0);
  });
  it("batch size is sane", () => {
    assert.ok(SCENE_BATCH >= 4 && SCENE_BATCH <= 16);
  });
});

describe("style lock", () => {
  it("maps every visual style to a lock paragraph", () => {
    for (const s of ["3D Preschool Animation", "3D Cinematic", "Realistic", "Anime", "Cartoon", "Indian Mythological", "Fantasy"]) {
      assert.ok(styleLockFor(s, "").length > 20, s);
    }
  });
  it("custom style uses the user's text", () => {
    assert.equal(styleLockFor("Custom", "  neon noir  "), "neon noir");
  });
});

describe("stripJson", () => {
  it("parses plain JSON", () => {
    assert.deepEqual(stripJson('{"a":1}'), { a: 1 });
  });
  it("strips markdown fences", () => {
    assert.deepEqual(stripJson('Here you go:\n```json\n{"a": [1,2]}\n```\nDone'), { a: [1, 2] });
  });
  it("ignores trailing prose after the object", () => {
    assert.deepEqual(stripJson('{"a":1} Hope this helps!'), { a: 1 });
  });
  it("keeps braces inside strings intact", () => {
    assert.deepEqual(stripJson('{"a":"}{ not json {"}'), { a: "}{ not json {" });
  });
  it("throws usefully on garbage", () => {
    assert.throws(() => stripJson("no json here at all!!!"), /no JSON object/);
    assert.throws(() => stripJson(""), /empty/);
  });
});

describe("normalizeBlueprint", () => {
  it("fills defaults and normalizes ids", () => {
    const b = normalizeBlueprint({
      logline: "x",
      characters: [{ name: "Minku" }],
      locations: [{}],
      objects: null,
      beats: [{ title: "Wake" }],
    });
    assert.equal(b.characters[0].character_id, "minku");
    assert.equal(b.characters[0].personality.length, 0);
    assert.equal(b.locations[0].location_id, "location_1");
    assert.deepEqual(b.objects, []);
    assert.equal(b.beats[0].n, 1);
    assert.equal(b.analysis.antagonist, null);
  });
});

describe("normalizeScene", () => {
  it("enforces numbering, duration clamp and camera defaults", () => {
    const s = normalizeScene({ title: "Wake" }, 3, 5);
    assert.equal(s.scene_number, 3);
    assert.equal(s.duration_seconds, 5);
    assert.equal(s.camera.shot_type, "Medium Shot");
    assert.deepEqual(s.characters, []);
    const long = normalizeScene({ duration_seconds: 99 }, 1, 5);
    assert.equal(long.duration_seconds, 30);
  });
});

describe("prompts", () => {
  const input = {
    title: "Minku", story: "A mouse.", language: "Hindi", genre: "Kids",
    visualStyle: "3D Preschool Animation", targetSeconds: 60, sceneSeconds: 5,
    instructions: "Keep it fun.",
  };
  it("bible prompt carries story + task + JSON shape", () => {
    const p = buildBiblePrompt(input);
    assert.ok(p.includes("A mouse."));
    assert.ok(p.includes("visual_identity_prompt"));
    assert.ok(p.includes("Keep it fun."));
  });
  it("scene prompt carries identities + style lock, not the whole story", () => {
    const bp = normalizeBlueprint({
      characters: [{ name: "Minku", visual_identity_prompt: "grey mouse" }],
      locations: [], objects: [], beats: [{ n: 1, title: "Wake", summary: "wakes" }],
    });
    const p = buildScenesPrompt({
      input, blueprint: bp, beats: bp.beats, prevScene: null,
      startNumber: 1, count: 2, styleLock: "LOCK", totalScenes: 2,
    });
    assert.ok(p.includes("grey mouse"));
    assert.ok(p.includes("LOCK"));
    assert.ok(!p.includes("A mouse."));
  });
  it("each batch covers only its own beats (no scene-1 repeat)", () => {
    const beats = [1, 2, 3, 4].map((n) => ({ n, title: `B${n}`, summary: `s${n}` }));
    // 48 scenes over 4 beats: opening batch gets beat 1, late batch gets beat 4.
    assert.deepEqual(beatsForSceneRange(beats, 1, 12, 48).map((b) => b.n), [1]);
    assert.deepEqual(beatsForSceneRange(beats, 37, 12, 48).map((b) => b.n), [4]);
    // Small plan: everything fits in one batch.
    assert.deepEqual(beatsForSceneRange(beats, 1, 4, 4).map((b) => b.n), [1, 2, 3, 4]);
  });
  it("sameLine spots verbatim repeats", () => {
    assert.ok(sameLine("I will eat any animal!", "i will eat   any animal"));
    assert.ok(!sameLine("Hello there", "Goodbye there"));
  });
  it("scene prompt never leaks a hardcoded example cast", () => {
    const bp = normalizeBlueprint({
      characters: [{ name: "Zara", character_id: "zara", visual_identity_prompt: "blue fox" }],
      locations: [], objects: [], beats: [{ n: 1, title: "Wake", summary: "wakes" }],
    });
    const p = buildScenesPrompt({
      input, blueprint: bp, beats: bp.beats, prevScene: null,
      startNumber: 1, count: 1, styleLock: "LOCK", totalScenes: 1,
    });
    assert.ok(!p.includes("Chiku"));
    assert.ok(!p.includes("Shera"));
    assert.ok(p.includes("Zara (zara)"));
  });
  it("identityContext compacts bibles", () => {
    const bp = normalizeBlueprint({ characters: [{ name: "M", visual_identity_prompt: "id" }] });
    const ctx = identityContext(bp);
    assert.ok(ctx.chars.includes("id"));
    assert.equal(ctx.locs, "");
  });
});

describe("boardToScenario", () => {
  const board = {
    input: { title: "Minku", visualStyle: "Anime", sceneSeconds: 5 },
    blueprint: {
      logline: "A mouse adventure.",
      characters: [{ name: "Minku", role: "main_character", visual_identity_prompt: "grey mouse" }],
      locations: [{ description: "forest" }],
    },
    scenes: [
      { title: "Wake Up", image_prompt: "mouse waking", video_prompt: "mouse stretches" },
      { title: "Run", image_prompt: "mouse running, anime", video_prompt: "" },
    ],
  };
  it("maps scenes to pipeline beats with style lock", () => {
    const cfg = boardToScenario(board);
    assert.equal(cfg.duration, 5);
    assert.equal(cfg.sequence.length, 2);
    assert.equal(cfg.sequence[0].title, "wake_up");
    assert.ok(cfg.sequence[0].image.includes("mouse waking"));
    assert.ok(cfg.sequence[0].image.toLowerCase().includes("anime"));
    // Already-locked prompts are not doubled.
    assert.equal((cfg.sequence[1].image.match(/anime/gi) || []).length, 1);
    assert.equal(cfg.sequence[0].motion, "mouse stretches");
  });
  it("anchors the reference on the main character + lock", () => {
    const cfg = boardToScenario(board);
    assert.ok(cfg.referencePrompt.includes("grey mouse"));
    assert.ok(cfg.referencePrompt.toLowerCase().includes("anime"));
  });
  it("enforces missing cast identities and strips (id) artifacts", () => {
    const b = {
      input: { title: "M", visualStyle: "Anime", sceneSeconds: 5 },
      blueprint: {
        characters: [
          { character_id: "minku", name: "Minku", visual_identity_prompt: "small grey mouse, yellow shirt" },
          { character_id: "cat", name: "Whiskers", visual_identity_prompt: "orange tabby cat, green eyes" },
        ],
        locations: [],
      },
      scenes: [{
        title: "Chase", characters: ["minku", "cat"],
        image_prompt: "Minku (minku) runs from Whiskers (cat) through the forest, anime",
        video_prompt: "Whiskers (cat) chases",
      }],
    };
    const cfg = boardToScenario(b);
    // (id) artifacts stripped, missing cat identity appended, lock kept once.
    assert.ok(!cfg.sequence[0].image.includes("(minku)"));
    assert.ok(!cfg.sequence[0].image.includes("(cat)"));
    assert.ok(cfg.sequence[0].image.includes("orange tabby cat"));
    assert.ok(cfg.sequence[0].image.includes("small grey mouse"));
    assert.ok(!cfg.sequence[0].motion.includes("(cat)"));
  });
});
