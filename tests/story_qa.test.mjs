// Story QA gate (M2): shared validator + auto-fix in lib/director.mjs.
// Run: node --test tests/story_qa.test.mjs (from the repo root)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateStoryBoard, autoFixStoryBoard } from "../lib/director.mjs";

const board = (over = {}) => ({
  input: { title: "t", targetSeconds: 60 },
  blueprint: {
    characters: [
      { character_id: "ram", name: "Ram", visual_identity_prompt: "brave man" },
      { character_id: "sita", name: "Sita", visual_identity_prompt: "kind woman" },
    ],
  },
  scenes: [
    {
      scene_number: 1, title: "Forest", characters: ["ram", "sita"], location: "forest",
      dialogue: [
        { speaker: "ram", line: "Sita, do not worry.", emotion: "reassuring", expression: "gentle concern" },
        { speaker: "sita", line: "I know, Ram.", emotion: "calm", expression: "soft smile" },
      ],
      shots: [],
    },
  ],
  sceneCount: 1,
  ...over,
});

describe("validateStoryBoard", () => {
  it("passes a clean board", () => {
    const r = validateStoryBoard(board());
    assert.equal(r.errors.length, 0);
  });
  it("blocks unknown speakers and unknown character refs", () => {
    const b = board();
    b.scenes[0].dialogue.push({ speaker: "shyam", line: "Boo.", emotion: "fearful", expression: "wide eyes" });
    b.scenes[0].characters.push("shyam");
    const r = validateStoryBoard(b);
    assert.ok(r.errors.some((e) => e.includes('"shyam"') && e.includes("not a registered character")));
    assert.ok(r.errors.some((e) => e.includes("unknown character")));
  });
  it("blocks missing emotion/expression and multi-owner lines", () => {
    const b = board();
    b.scenes[0].dialogue = [
      { speaker: "ram", line: "Come here.", emotion: "", expression: "" },
      { speaker: "sita", line: "Come here.", emotion: "calm", expression: "soft smile" },
    ];
    const r = validateStoryBoard(b);
    assert.ok(r.errors.some((e) => e.includes("missing emotion")));
    assert.ok(r.errors.some((e) => e.includes("missing expression")));
    assert.ok(r.errors.some((e) => e.includes("exactly one character")));
  });
  it("blocks out-of-order / duplicate scene numbers", () => {
    const b = board();
    b.scenes.push({ ...b.scenes[0], scene_number: 1, title: "Dup" });
    const r = validateStoryBoard(b);
    assert.ok(r.errors.some((e) => e.includes("reuses scene_number") || e.includes("out of order")));
  });
  it("warns on missing visual identity (continuity risk), not an error", () => {
    const b = board();
    delete b.blueprint.characters[0].visual_identity_prompt;
    const r = validateStoryBoard(b);
    assert.equal(r.errors.length, 0);
    assert.ok(r.warnings.some((w) => w.includes("no visual identity")));
  });
});

describe("autoFixStoryBoard", () => {
  it("fills defaults, drops unknown refs, renumbers", () => {
    const b = board();
    b.scenes[0].dialogue = [{ speaker: "ram", line: "Hi.", emotion: "", expression: "" }];
    b.scenes[0].characters.push("ghost");
    b.scenes[0].scene_number = 7;
    const { board: nb, fixed } = autoFixStoryBoard(b);
    assert.ok(fixed.length > 0);
    assert.equal(nb.scenes[0].scene_number, 1);
    assert.deepEqual(nb.scenes[0].characters, ["ram", "sita"]);
    assert.equal(nb.scenes[0].dialogue[0].emotion, "neutral");
    assert.ok(validateStoryBoard(nb).errors.length === 0);
  });
});
