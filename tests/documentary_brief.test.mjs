// Documentary brief auto-detection tests: the form asks only for title /
// topic / source — tone, audience, visuals, narration, music, source type,
// language, characters, events, locations detect automatically (LLM on
// demand, heuristic instantly at create). Manual typing always wins.
// Run: node --test tests/documentary_brief.test.mjs (repo root; zero deps)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOC_BRIEF_AUTO_FIELDS,
  buildDocBriefDetectPrompt,
  normalizeDocDetectedBrief,
  heuristicDetectBrief,
  heuristicEstimateDuration,
  heuristicTopicText,
  fillDocBriefAuto,
  validateDocBrief,
} from "../lib/documentary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("auto fields cover tone/audience/visuals/narration/music/source/language/cast", () => {
  assert.deepEqual(DOC_BRIEF_AUTO_FIELDS, [
    "language", "tone", "audience", "visualStyle", "narrationStyle",
    "narrationVoice", "musicStyle", "sourceType", "characters", "events", "locations",
  ]);
});

test("detect prompt asks for every auto field as JSON", () => {
  const p = buildDocBriefDetectPrompt({ title: "Shiva", topic: "Tandava", sourceMaterial: "Shiva dances." });
  for (const k of [...DOC_BRIEF_AUTO_FIELDS, "narrationVoice"]) {
    assert.ok(p.includes(k), `prompt asks for ${k}`);
  }
  assert.ok(/JSON ONLY/.test(p));
});

test("normalize allowlists language, voice and source type", () => {
  const d = normalizeDocDetectedBrief({
    language: "Klingon", narrationVoice: "en-US-X", sourceType: "tabloid",
    tone: "  Epic  ", characters: "Shiva",
  });
  assert.equal(d.language, "");
  assert.equal(d.narrationVoice, "");
  assert.equal(d.sourceType, "");
  assert.equal(d.tone, "Epic");
  assert.equal(normalizeDocDetectedBrief({ language: "hindi", narrationVoice: "hi-IN-SwaraNeural", sourceType: "SCRIPTURAL" }).language, "Hindi");
});

test("heuristic detects a Hindi devotional poem brief", () => {
  const d = heuristicDetectBrief({
    title: "महादेव",
    topic: "Lord Shiva Tandava on Kailash at dusk",
    sourceMaterial: "Shiva: Behold my dance!\nThe damaru sounds. भक्ति में लीन भक्त।",
  });
  assert.equal(d.language, "Hindi");
  assert.match(d.tone, /Spiritual/);
  assert.match(d.audience, /devotional/);
  assert.match(d.visualStyle, /devotional/);
  assert.match(d.musicStyle, /temple bells/);
  assert.match(d.narrationStyle, /Hindi/);
  assert.ok(d.characters.includes("Shiva"), d.characters);
  assert.ok(d.locations.includes("Kailash"), d.locations);
  assert.ok(d.events.length > 0);
});

test("heuristic detects an English historical brief", () => {
  const d = heuristicDetectBrief({ title: "Kings of Rajasthan", topic: "History of Rajput kings, their empire and wars" });
  assert.equal(d.language, "English");
  assert.match(d.tone, /Epic/);
  assert.equal(d.sourceType, "historical");
  assert.match(d.visualStyle, /historical/);
});

test("heuristic detects scriptural source type from verse cues", () => {
  const d = heuristicDetectBrief({ title: "x", topic: "Verses from the Shiva Purana and Vedic shlokas" });
  assert.equal(d.sourceType, "scriptural");
});

test("fill keeps manual values and fills only blanks", () => {
  const out = fillDocBriefAuto({ title: "x", tone: "My tone", audience: "  " });
  assert.equal(out.tone, "My tone");
  assert.ok(out.audience.length > 0, "blank audience detected");
  assert.ok(out.visualStyle.length > 0);
  // ...and the filled body still validates with defaults as final fallback.
  const v = validateDocBrief(out);
  assert.equal(v.tone, "My tone");
  assert.ok(v.title === "x");
});

test("server detects on demand and auto-fills at create (doc-only)", () => {
  const server = read("frontend/server.mjs");
  assert.ok(server.includes("/api/documentary/detect-brief"), "detect route");
  assert.ok(server.includes("buildDocBriefDetectPrompt"), "LLM detect prompt");
  assert.ok(server.includes("fillDocBriefAuto(await readJson(req))") || server.includes("fillDocBriefAuto(rawBody)"), "create auto-fills");
  assert.ok(server.includes("heuristicEstimateDuration(rawBody)"), "create analyzes duration when missing");
  assert.ok(server.includes("heuristicTopicText("), "create autopopulates topic when missing");
});

test("topic autopopulates from the pasted text", () => {
  assert.equal(heuristicTopicText("# Tandav\nShiva dances.", "Title"), "Tandav");
  assert.equal(heuristicTopicText("  \n  ", "Fallback Title"), "Fallback Title");
  assert.ok(heuristicTopicText("x".repeat(200), "T").length <= 120);
  // heuristicDetectBrief keeps an explicit topic, derives a missing one.
  assert.equal(heuristicDetectBrief({ title: "T", topic: "Given", sourceMaterial: "blah" }).topic, "Given");
  assert.equal(heuristicDetectBrief({ title: "T", sourceMaterial: "# Tandav\nblah" }).topic, "Tandav");
  assert.equal(normalizeDocDetectedBrief({ topic: "  Tandav  " }).topic, "Tandav");
});

test("duration analyzes from the source text, 25min fallback when empty", () => {
  assert.equal(heuristicEstimateDuration({}), 1500);
  const poem = heuristicEstimateDuration({ title: "Shiv", topic: "Tandav", sourceMaterial: "Shiva dances. ".repeat(25) });
  assert.ok(poem >= 60 && poem < 300, `50-word poem -> ${poem}s`);
  const epic = heuristicEstimateDuration({ sourceMaterial: "word ".repeat(1500) });
  assert.ok(epic > 1200 && epic <= 1500, `1500 words -> ${epic}s`);
  assert.equal(heuristicEstimateDuration({ sourceMaterial: "word ".repeat(100000) }), 3600);
});

test("detected brief carries an analyzed duration", () => {
  assert.ok(buildDocBriefDetectPrompt({ title: "t" }).includes("targetSeconds"));
  assert.equal(normalizeDocDetectedBrief({ targetSeconds: 347 }).targetSeconds, 345);
  assert.equal(normalizeDocDetectedBrief({ targetSeconds: 5 }).targetSeconds, 0);
  assert.ok(heuristicDetectBrief({ title: "Shiva doc" }).targetSeconds >= 60);
});

test("brief form shows no auto-detect inputs - detection is fully automatic", () => {
  const page = read("frontend/src/components/DocumentaryPage.tsx");
  // No editable inputs for detected fields (tone/audience/visuals/narration/
  // music/source/language/cast) - and no topic, duration or aspect either:
  // the form is title + tall source box + instructions.
  for (const needle of ["setTone(", "setAudience(", "setVisualStyle(", "setNarrationStyle(",
    "setNarrationVoice(", "setMusicStyle(", "setSourceType(", "setCharacters(",
    "setEvents(", "setLocations(", "setLanguage(", "setTopic(", "setTargetMinutes(",
    "DURATIONS", "5-min test", "Target duration", "Duration (auto-analyzed)",
    "Aspect ratio", "autoDuration", "Auto-detect brief", "autoPill(",
    "handleDetect", "Clear auto", "Auto-detect</option>", 'placeholder="Auto-detect"']) {
    assert.ok(!page.includes(needle), `brief form has no ${needle}`);
  }
  // Tall source box; Raw Poem tab removed from the row (source lives here).
  assert.ok(page.includes("rows={10}"), "tall source box");
  assert.ok(page.includes('k !== "raw"'), "Raw Poem tab removed");
  // Detected values surface read-only on the open board instead.
  assert.ok(page.includes('aria-label="Detected brief"'), "read-only detected summary");
  // Create sends blanks; the server fills them (previous test covers it).
  assert.ok(page.includes('language: ""'), "create leaves detection to the server");
});
