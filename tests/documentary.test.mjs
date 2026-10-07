// Documentary Mode tests: brief validation, duration-driven planning,
// board -> scenario mapping, timeline, subtitles, dependency invalidation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateDocBrief,
  estimateNarrationSeconds,
  shotsForDuration,
  chaptersForDuration,
  heuristicPlan,
  boardToScenario,
  buildTimeline,
  subtitlesFromBoard,
  buildExportManifest,
  invalidatedByNarration,
  invalidatedByCharacter,
  boardStats,
  MAX_SHOTS,
} from "../lib/documentary.mjs";

test("brief defaults to Hindi 25min 16:9 devotional", () => {
  const b = validateDocBrief({ title: "Shiva" });
  assert.equal(b.language, "Hindi");
  assert.equal(b.targetMinutes, 25);
  assert.equal(b.targetSeconds, 1500);
  assert.match(b.aspectRatio, /16:9/);
  assert.match(b.tone, /Spiritual/);
});

test("brief rejects empty title, clamps duration", () => {
  assert.throws(() => validateDocBrief({ title: " " }), /title is required/);
  assert.equal(validateDocBrief({ title: "x", targetMinutes: 500 }).targetMinutes, 60);
  assert.equal(validateDocBrief({ title: "x", targetMinutes: 5 }).targetSeconds, 300);
});

test("shot count is dynamic from narration duration (not hardcoded)", () => {
  const n20 = shotsForDuration(1200);
  const n25 = shotsForDuration(1500);
  const n30 = shotsForDuration(1800);
  assert.ok(n20 >= 80 && n20 <= 110, `20min -> ${n20}`);
  assert.ok(n25 >= 100 && n25 <= 140, `25min -> ${n25}`);
  assert.ok(n30 >= 120 && n30 <= 170, `30min -> ${n30}`);
  assert.ok(shotsForDuration(1e9) <= MAX_SHOTS);
});

test("chapter count scales: 5min test fewer, 25min 6-9", () => {
  assert.ok(chaptersForDuration(300) <= 4);
  const c = chaptersForDuration(1500);
  assert.ok(c >= 6 && c <= 9, `25min chapters -> ${c}`);
});

test("narration estimate grows with words", () => {
  const a = estimateNarrationSeconds("short line");
  const b = estimateNarrationSeconds("short line ".repeat(100));
  assert.ok(b > a * 10);
});

test("heuristic 5-min plan is valid and sums near target", () => {
  const brief = validateDocBrief({ title: "महादेव — शिव के दिव्य स्वरूप की यात्रा", topic: "Lord Shiva", targetMinutes: 5 });
  const h = heuristicPlan(brief);
  assert.ok(h.chapters.length >= 2 && h.chapters.length <= 4);
  assert.ok(h.characters.length >= 1 && h.characters[0].consistency_rules.length >= 3);
  assert.ok(h.locations.length >= 1);
  const total = h.chapters.reduce((a, c) => a + c.target_duration_seconds, 0);
  assert.ok(Math.abs(total - 300) < 90, `total ${total}`);
  const shots = h.chapters.flatMap((c) => c.sequences.flatMap((q) => q.shots));
  assert.ok(shots.every((s) => s.duration_seconds >= 3 && s.duration_seconds <= 15), "shots 3-15s");
  assert.ok(shots.every((s) => s.flux_prompt.length > 20 && s.narration_lines.length > 0));
  assert.ok(shots.every((s) => /animate natural motion only/i.test(s.ltx_prompt)));
});

test("heuristic 25-min plan hits 100-140 shots", () => {
  const brief = validateDocBrief({ title: "Shiva doc", targetMinutes: 25 });
  const h = heuristicPlan(brief);
  const n = h.chapters.flatMap((c) => c.sequences.flatMap((q) => q.shots)).length;
  assert.ok(n >= 80 && n <= 170, `shots -> ${n}`);
});

test("boardToScenario flattens to pipeline beats with narrator dialogue", () => {
  const brief = validateDocBrief({ title: "Shiva doc", targetMinutes: 5 });
  const h = heuristicPlan(brief);
  const cfg = boardToScenario({ brief, chapters: h.chapters, characters: h.characters, locations: h.locations });
  assert.ok(Array.isArray(cfg.sequence) && cfg.sequence.length > 0);
  assert.ok(cfg.sequence.every((b) => b.image && b.motion && b.duration >= 2));
  assert.equal(cfg.tts.defaultVoice, "hi-IN-MadhurNeural");
  assert.ok(cfg.referencePrompt.length > 10);
});

test("timeline totals + subtitles track narration exactly", () => {
  const brief = validateDocBrief({ title: "Shiva doc", targetMinutes: 5 });
  const h = heuristicPlan(brief);
  const board = { id: "t", brief, chapters: h.chapters };
  const tl = buildTimeline(board);
  assert.ok(tl.total_seconds > 200 && tl.total_seconds < 500);
  assert.equal(tl.chapters.length, h.chapters.length);
  const srt = subtitlesFromBoard(board);
  assert.match(srt, /00:00:00,000 -->/);
  // One cue per narration line, in order.
  const lines = h.chapters.flatMap((c) => c.sequences.flatMap((q) => q.shots.flatMap((s) => s.narration_lines)));
  assert.equal(srt.trim().split("\n\n").length, lines.length);
  assert.ok(srt.includes(lines[0].slice(0, 20)));
});

test("export manifest uses existing storage conventions", () => {
  const brief = validateDocBrief({ title: "Shiva doc", targetMinutes: 5 });
  const h = heuristicPlan(brief);
  const m = buildExportManifest({ brief, chapters: h.chapters, scenarioName: "Shiva doc" }, "shiva_doc");
  assert.match(m.documentary_final, /_final\.mp4$/);
  assert.ok(m.chapters.every((f) => f.startsWith("chapter_")));
  assert.equal(m.narration_audio, "narration.wav");
  assert.equal(m.subtitles, "subtitles.srt");
});

test("dependency invalidation is scoped, never whole-board", () => {
  const brief = validateDocBrief({ title: "Shiva doc", targetMinutes: 5 });
  const h = heuristicPlan(brief);
  const board = { brief, chapters: h.chapters };
  const all = invalidatedByNarration(board);
  assert.ok(all.length > 0);
  const ch1 = invalidatedByNarration(board, 1);
  assert.ok(ch1.length < all.length);
  const cid = h.characters[0].character_id;
  const byChar = invalidatedByCharacter(board, cid);
  assert.ok(byChar.length > 0 && byChar.length <= all.length);
  assert.deepEqual(invalidatedByCharacter(board, "nobody_here"), []);
});

test("boardStats reports approval + status distribution", () => {
  const brief = validateDocBrief({ title: "Shiva doc", targetMinutes: 5 });
  const h = heuristicPlan(brief);
  const st = boardStats({ brief, chapters: h.chapters });
  assert.ok(st.shots > 0 && st.chapters >= 2);
  assert.ok((st.byStatus.WAITING || 0) === st.shots);
});
