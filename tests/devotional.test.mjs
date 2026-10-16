// Run: node --test tests/devotional.test.mjs (from repo root)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  makeAssetId, sanitizeIdPart, safeFolder, isSafeSegment,
  normalizeKind, normalizeStatus, canTransition, normalizeAliases,
  normalizeAsset, validateAssetPayload, describeAssetForPrompt,
  buildDevotionalScenePrompt, resolveSceneAssets, SEED_SUGGESTIONS,
} from "../lib/devotional.mjs";

describe("devotional ids + validation", () => {
  it("makes stable prefixed ids", () => {
    assert.equal(makeAssetId("character", "Lord Krishna", 1), "CHAR_LORD_KRISHNA_01");
    assert.equal(makeAssetId("location", "Vrindavan", 2), "LOC_VRINDAVAN_02");
    assert.equal(makeAssetId("prop", "Flute!", 1), "PROP_FLUTE_01");
  });
  it("sanitizes folder names without traversal", () => {
    assert.equal(safeFolder("Lord Krishna"), "lord_krishna");
    assert.ok(!safeFolder("../../etc").includes(".."));
  });
  it("rejects path traversal segments", () => {
    assert.equal(isSafeSegment("../x"), false);
    assert.equal(isSafeSegment("a/b"), false);
    assert.equal(isSafeSegment("krishna_01"), true);
  });
  it("validates create payloads", () => {
    const bad = validateAssetPayload({ kind: "god", name: "" });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length >= 2);
    const good = validateAssetPayload({ kind: "character", name: "Krishna", description: "x" });
    assert.equal(good.ok, true);
    assert.equal(good.asset.status, "draft");
  });
  it("enforces the approval lifecycle", () => {
    assert.equal(canTransition("draft", "review"), true);
    assert.equal(canTransition("review", "approved"), true);
    assert.equal(canTransition("draft", "approved"), false);
    assert.equal(canTransition("approved", "draft"), false);
    assert.equal(canTransition("approved", "review"), true);
    assert.equal(canTransition("archived", "draft"), true);
  });
  it("normalizes aliases", () => {
    assert.deepEqual(normalizeAliases("Kanha, Murli, Kanha"), ["Kanha", "Murli"]);
  });
  it("keeps a saved generation prompt override (blank = auto)", () => {
    assert.equal(normalizeAsset({ kind: "character", name: "Krishna" }).prompt, "");
    assert.equal(
      normalizeAsset({ kind: "character", name: "Krishna", prompt: "  portrait of Krishna  " }).prompt,
      "portrait of Krishna");
    assert.equal(validateAssetPayload({ kind: "character", name: "K", prompt: "p" }).asset.prompt, "p");
  });
});

describe("devotional prompt assembly", () => {
  const krishna = normalizeAsset({
    kind: "character", name: "Lord Krishna",
    description: "Blue-complexioned cowherd prince",
    identity: { costume: "yellow dhoti, peacock crown" },
  });
  const vrindavan = normalizeAsset({
    kind: "location", name: "Vrindavan",
    description: "Pastoral groves on the Yamuna",
  });
  const flute = normalizeAsset({
    kind: "prop", name: "Flute", description: "Bamboo bansuri",
  });
  it("keeps identity and scene action separate", () => {
    const { positive } = buildDevotionalScenePrompt({
      characters: [krishna], location: vrindavan, props: [flute],
      scene: { action: "sitting under a tree playing the flute", camera: { shot_type: "Close-Up" } },
    });
    assert.ok(positive.includes("CHARACTERS:"));
    assert.ok(positive.includes("Blue-complexioned"));
    assert.ok(positive.includes("SCENE ACTION: sitting under a tree"));
    // Identity text does not absorb the scene action.
    const charLine = positive.split("\n").find((l) => l.startsWith("CHARACTERS:"));
    assert.ok(!charLine.includes("sitting under a tree"));
  });
  it("resolves only approved assets and reports missing", () => {
    const lib = {
      CHAR_KRISHNA_01: { ...krishna, id: "CHAR_KRISHNA_01", status: "approved" },
      LOC_OTHER_01: { ...vrindavan, id: "LOC_OTHER_01", status: "draft" },
    };
    const r = resolveSceneAssets({
      devotional_characters: ["CHAR_KRISHNA_01", "CHAR_RAMA_01"],
      devotional_location: "LOC_OTHER_01",
    }, lib);
    assert.equal(r.characters.length, 1);
    assert.equal(r.location, null);
    assert.equal(r.missing.length, 2); // unapproved location + unknown char
  });
  it("seed suggestions are configurable entries", () => {
    assert.ok(SEED_SUGGESTIONS.character.length >= 10);
    assert.ok(SEED_SUGGESTIONS.location.some((l) => l.name === "Vrindavan"));
  });
  it("describeAsset includes continuity rules", () => {
    const d = describeAssetForPrompt({ name: "X", description: "y", continuity: "same crown always" });
    assert.ok(d.includes("same crown always"));
  });
});
