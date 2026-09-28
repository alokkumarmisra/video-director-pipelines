// AI Story Director lib: JSON reliability, scene math, style lock,
// normalization and the board -> scenario handoff (all pure, no network).
// Run: node --test tests/director.test.mjs (from the repo root)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCENE_BATCH,
  MAX_SCENES,
  MIN_SHOT_SECONDS,
  linesForTimeWindow,
  planProgress,
  verifyPlanComplete,
  sceneCountFor,
  styleLockFor,
  styleKeyFor,
  MOTION_FIDELITY_LOCK,
  motionKeyFor,
  stripJson,
  normalizeBlueprint,
  normalizeScene,
  normalizeShot,
  normalizeShots,
  splitSceneTimeline,
  beatsForSceneRange,
  sameLine,
  identityContext,
  buildBiblePrompt,
  buildScenesPrompt,
  boardToScenario,
  stripContinuityText,
  buildRegenPrompt,
  parseLyricLines,
  estimateLyricTiming,
  normalizeLyricLine,
  normalizeReferenceSource,
  validateLyricPlan,
  extractPartialScenes,
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
  it("chain toggle switches the batch brief between connected and independent", () => {
    const bp = normalizeBlueprint({
      characters: [{ name: "Minku", visual_identity_prompt: "grey mouse" }],
      locations: [], objects: [], beats: [{ n: 1, title: "Wake", summary: "wakes" }],
    });
    const base = {
      title: "Minku", story: "Wake up.", language: "Hindi", genre: "Kids",
      visualStyle: "Anime", targetSeconds: 10, sceneSeconds: 5,
    };
    const off = buildScenesPrompt({
      input: { ...base, chainContinuity: false }, blueprint: bp, beats: bp.beats,
      prevScene: null, startNumber: 1, count: 2, styleLock: "LOCK", totalScenes: 2,
    });
    assert.ok(off.includes("INDEPENDENT SCENES"), "OFF brief orders fresh shots");
    assert.ok(off.includes('"continuity_from_previous_scene": ""'), "OFF schema empties handoff fields");
    assert.ok(off.includes("(fresh independent framing"), "OFF image schema stages fresh framing");
    const on = buildScenesPrompt({
      input: { ...base, chainContinuity: true }, blueprint: bp, beats: bp.beats,
      prevScene: null, startNumber: 1, count: 2, styleLock: "LOCK", totalScenes: 2,
    });
    assert.ok(on.includes("CONNECTED SCENES"), "ON brief orders continuations");
    assert.ok(on.includes("+ continuity_from_previous_scene (same framing"), "ON image schema carries continuity");
  });
  it("song boards gate lyric continuity decisions on the chain toggle", () => {
    const bp = normalizeBlueprint({
      characters: [], locations: [], objects: [],
      beats: [{ n: 1, title: "B", summary: "s" }],
    });
    const timing = estimateLyricTiming(parseLyricLines("wake up\nrun far"), 20);
    const base = {
      title: "S", story: "wake up\nrun far", language: "Hindi", genre: "Devotional",
      visualStyle: "Indian Mythological", targetSeconds: 20, sceneSeconds: 5,
      song: { file: "s.mp3", fileName: "s.mp3", durationSeconds: 20, hasLyrics: true },
    };
    const off = buildScenesPrompt({
      input: { ...base, chainContinuity: false }, blueprint: bp, beats: bp.beats,
      prevScene: null, startNumber: 1, count: 2, styleLock: "LOCK", totalScenes: 2,
      lyricTiming: timing,
    });
    assert.ok(off.includes("ALWAYS \"continuity_required\": false"), "OFF lyric shots pin continuity off");
    assert.ok(off.includes('"reference_source": "NONE"'), "OFF lyric schema pins NONE");
    assert.ok(!off.includes("PREVIOUS_VIDEO_LAST_FRAME"), "OFF lyric offers no previous-shot sources");
    const on = buildScenesPrompt({
      input: { ...base, chainContinuity: true }, blueprint: bp, beats: bp.beats,
      prevScene: null, startNumber: 1, count: 2, styleLock: "LOCK", totalScenes: 2,
      lyricTiming: timing,
    });
    assert.ok(on.includes("PREVIOUS_VIDEO_LAST_FRAME"), "ON lyric keeps reference-source choice");
  });
  it("neighbor scene context is gated on the chain toggle", () => {
    const bp = normalizeBlueprint({
      characters: [], locations: [], objects: [],
      beats: [{ n: 1, title: "B", summary: "s" }],
    });
    const prev = { scene_number: 1, title: "Prev", action: "waves" };
    const scene = { scene_number: 2, title: "Cur", duration_seconds: 3 };
    const base = {
      title: "T", story: "x", language: "Hindi", genre: "Kids",
      visualStyle: "Anime", targetSeconds: 10, sceneSeconds: 5,
    };
    const offBatch = buildScenesPrompt({
      input: { ...base, chainContinuity: false }, blueprint: bp, beats: bp.beats,
      prevScene: prev, startNumber: 2, count: 2, styleLock: "LOCK", totalScenes: 2,
    });
    assert.ok(!offBatch.includes("PREVIOUS SCENE"), "OFF batches omit the continue-from-it block");
    const onBatch = buildScenesPrompt({
      input: { ...base, chainContinuity: true }, blueprint: bp, beats: bp.beats,
      prevScene: prev, startNumber: 2, count: 2, styleLock: "LOCK", totalScenes: 2,
    });
    assert.ok(onBatch.includes("PREVIOUS SCENE (end state"), "ON batches keep the anchor");
    const offRegen = buildRegenPrompt({
      input: { ...base, chainContinuity: false }, blueprint: bp, scene,
      prevScene: prev, nextScene: null, styleLock: "LOCK",
    });
    assert.ok(offRegen.includes("story context only"), "OFF regen frames neighbors as context");
    assert.ok(!offRegen.includes("continue from its end state"), "OFF regen orders no continuation");
    const onRegen = buildRegenPrompt({
      input: { ...base, chainContinuity: true }, blueprint: bp, scene,
      prevScene: prev, nextScene: null, styleLock: "LOCK",
    });
    assert.ok(onRegen.includes("continue from its end state"), "ON regen keeps the anchor");
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
    // Motion keeps the action and carries the fidelity lock (motion-only clips).
    assert.ok(cfg.sequence[0].motion.includes("mouse stretches"));
    assert.ok(cfg.sequence[0].motion.includes("animate natural motion only"));
    assert.equal((cfg.sequence[0].motion.match(/animate natural motion only/gi) || []).length, 1);
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
    // Motion carries the fidelity lock so the clip only animates the keyframe.
    assert.ok(cfg.sequence[0].motion.includes("Whiskers"));
    assert.ok(cfg.sequence[0].motion.includes("animate natural motion only"));
  });
  it("Connected OFF approves independent shots (no handoff text in prompts)", () => {
    const board = {
      input: { title: "M", visualStyle: "Anime", sceneSeconds: 5, chainContinuity: false },
      blueprint: {
        characters: [{ character_id: "minku", name: "Minku", visual_identity_prompt: "small grey mouse" }],
        locations: [{ location_id: "forest", name: "Forest", visual_identity_prompt: "dense forest" }],
      },
      scenes: [{
        title: "Chase", characters: ["minku"], location: "forest",
        continuity_from_previous_scene: "same forest clearing, Minku mid-run from the last frame",
        transition_to_next_scene: "Minku exits toward the river",
        image_prompt: "Minku runs through the forest, continuing from previous shot: same forest clearing, anime",
        video_prompt: "camera tracks as he runs, seamless continuation from the previous shot's last frame, smooth motion",
      }],
    };
    const cfg = boardToScenario(board);
    assert.ok(!("chainContinuity" in cfg), "OFF boards carry no chain flag into generation");
    assert.ok(!cfg.sequence[0].image.includes("continuing from previous shot"), "image handoff stripped");
    assert.ok(!cfg.sequence[0].motion.toLowerCase().includes("seamless continuation"), "motion handoff stripped");
    assert.ok(cfg.sequence[0].image.includes("small grey mouse"), "character context kept");
    // Connected ON keeps the handoff so the story flows.
    const on = boardToScenario({
      ...board,
      input: { ...board.input, chainContinuity: true },
    });
    assert.equal(on.chainContinuity, true);
    assert.ok(on.sequence[0].image.includes("continuing from previous shot"), "ON boards keep continuity text");
  });
  it("stripContinuityText removes handoff clauses and keeps the scene", () => {
    // No-period clause eats to the end (style/quality are re-appended
    // downstream after grounding); the scene action itself always survives.
    assert.equal(
      stripContinuityText("Minku runs, continuing from previous shot: same clearing, anime"),
      "Minku runs");
    assert.ok(!stripContinuityText("camera tracks, seamless continuation from the previous shot's last frame, smooth motion").toLowerCase().includes("seamless continuation"));
    // Full chain sentence (commas inside) must vanish entirely, not fragment.
    assert.equal(
      stripContinuityText("camera tracks as he runs, seamless continuation from the previous shot's last frame \u2014 hold the exact same character, face, clothing, colors, lighting and background from the input image, no cut, no scene jump, smooth continuous motion forward"),
      "camera tracks as he runs");
    // Multi-comma handoff clause: no fragment may survive to stage a continuation.
    assert.equal(
      stripContinuityText("Minku runs through the forest, continuing from previous shot: same clearing, Minku mid-run from the last frame, anime"),
      "Minku runs through the forest");
    // Conservative mode (stored-board scrub): short clauses go, but trailing
    // style/context tokens survive; approve-time stripping finishes the job.
    assert.equal(
      stripContinuityText("Minku runs, continuing from previous shot: same clearing, anime", { aggressive: false }),
      "Minku runs, anime");
    assert.equal(stripContinuityText("a calm lake, anime"), "a calm lake, anime");
  });
  it("motion-only fidelity: empty motion becomes the lock, locked motion is not doubled", () => {
    const mk = (video_prompt) => boardToScenario({
      input: { title: "M", visualStyle: "Anime", sceneSeconds: 5 },
      blueprint: { characters: [], locations: [] },
      scenes: [{ title: "S", image_prompt: "x", video_prompt }],
    }).sequence[0].motion;
    assert.equal(mk(""), MOTION_FIDELITY_LOCK);
    const once = mk("waves hand");
    assert.ok(once.includes("waves hand"));
    assert.equal((once.match(/animate natural motion only/gi) || []).length, 1);
    const twice = mk("waves hand, animate natural motion only");
    assert.equal((twice.match(/animate natural motion only/gi) || []).length, 1);
  });
});

describe("lyric semantic mode (one line -> many shots)", () => {
  const LYRICS = "[Verse 1]\nदे बीरा रघुनाथ पठाए, लंका जारि सिया सुधि लाए\n\nChorus:\nजाके बल से गिरिवर कांपे";
  it("parseLyricLines drops headers/blanks and numbers singable lines", () => {
    const lines = parseLyricLines(LYRICS);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].lyric_line_id, 1);
    assert.ok(lines[0].lyric_text.includes("रघुनाथ"));
    assert.equal(lines[1].lyric_line_id, 2);
    assert.deepEqual(parseLyricLines(""), []);
  });
  it("estimateLyricTiming splits the song proportional to word count", () => {
    const timed = estimateLyricTiming(parseLyricLines(LYRICS), 20);
    assert.equal(timed.length, 2);
    assert.equal(timed[0].song_start_time, 0);
    assert.equal(timed[1].song_end_time, 20);
    assert.ok(timed[0].song_end_time > 10); // denser line gets the bigger window
    assert.equal(timed[0].song_end_time, timed[1].song_start_time);
  });
  it("normalizeReferenceSource accepts the enum, defaults to NONE", () => {
    assert.equal(normalizeReferenceSource("previous_video_last_frame"), "PREVIOUS_VIDEO_LAST_FRAME");
    assert.equal(normalizeReferenceSource("character_reference"), "CHARACTER_REFERENCE");
    assert.equal(normalizeReferenceSource("bogus"), "NONE");
    assert.equal(normalizeReferenceSource(""), "NONE");
  });
  it("normalizeScene keeps lyric/shot/continuity fields, old scenes stay null", () => {
    const old = normalizeScene({ title: "Wake" }, 1, 5);
    assert.equal(old.lyric_line_id, null);
    assert.equal(old.shot_id, null);
    assert.equal(old.continuity_required, false);
    assert.equal(old.reference_source, "NONE");
    const shot = normalizeScene({
      title: "Mission", lyric_line_id: 12, lyric_text: "दे बीरा",
      lyric_segment: "दे बीरा", semantic_meaning: "Rama gives the mission",
      visual_event: "Rama hands the ring", shot_id: "12-A", parent_line_id: 12,
      shot_number: 1, song_start_time: 0, song_end_time: 3.5,
      continuity_required: true, reference_source: "character_reference",
      continuity_refs: ["11-C"],
    }, 5, 3);
    assert.equal(shot.scene_number, 5);
    assert.equal(shot.lyric_line_id, 12);
    assert.equal(shot.parent_line_id, 12);
    assert.equal(shot.shot_id, "12-A");
    assert.equal(shot.song_end_time, 3.5);
    assert.equal(shot.continuity_required, true);
    assert.equal(shot.reference_source, "CHARACTER_REFERENCE");
    assert.deepEqual(shot.continuity_refs, ["11-C"]);
  });
  it("normalizeBlueprint carries lyric_lines (empty on story boards)", () => {
    assert.deepEqual(normalizeBlueprint({}).lyric_lines, []);
    const b = normalizeBlueprint({
      lyric_lines: [{ lyric_line_id: 1, lyric_text: "x", visual_complexity: "high", planned_shots: 9 }],
    });
    assert.equal(b.lyric_lines[0].visual_complexity, "high");
    assert.equal(b.lyric_lines[0].planned_shots, 5); // clamped to the 1..5 range
    assert.equal(normalizeLyricLine(null, 0).lyric_line_id, 1);
  });
  it("scene prompt gains the lyric block for songs, stays clean for stories", () => {
    const bp = normalizeBlueprint({
      characters: [{ name: "Hanuman", visual_identity_prompt: "vanara warrior" }],
      locations: [], objects: [], beats: [{ n: 1, title: "Mission", summary: "Rama sends Hanuman" }],
    });
    const songInput = {
      title: "H", story: LYRICS, language: "Hindi", genre: "Devotional",
      visualStyle: "Indian Mythological", targetSeconds: 20, sceneSeconds: 5,
      song: { file: "s.mp3", fileName: "s.mp3", durationSeconds: 20, hasLyrics: true },
    };
    const p = buildScenesPrompt({
      input: songInput, blueprint: bp, beats: bp.beats, prevScene: null,
      startNumber: 1, count: 2, styleLock: "LOCK", totalScenes: 2,
      lyricLines: [], lyricTiming: estimateLyricTiming(parseLyricLines(LYRICS), 20),
    });
    assert.ok(p.includes("LYRIC-SEMANTIC SHOT SPLITTING"));
    assert.ok(p.includes("12-A") || p.includes("shot_id"));
    assert.ok(p.includes("रघुनाथ"));
    // Slim lyric keys only — no redundant echoes (server joins/derives them).
    for (const k of ["lyric_line_id", "lyric_segment", "semantic_meaning", "shot_id", "reference_source"]) {
      assert.ok(p.includes(k), `song schema keeps ${k}`);
    }
    for (const k of ["lyric_text", "parent_line_id", "visual_event", "continuity_refs"]) {
      assert.ok(!p.includes(k), `song schema drops echo ${k}`);
    }
    const storyInput = { ...songInput, song: undefined };
    const q = buildScenesPrompt({
      input: storyInput, blueprint: bp, beats: bp.beats, prevScene: null,
      startNumber: 1, count: 1, styleLock: "LOCK", totalScenes: 1,
    });
    assert.ok(!q.includes("LYRIC-SEMANTIC SHOT SPLITTING"));
    // Story scenes keep no top-level lyric linkage (lean batches — this was
    // the 12k-token 500), but multi-shot scenes work for stories too, so the
    // shots sub-schema rides along in every board.
    for (const k of ["lyric_line_id", "lyric_text", "song_start_time", "reference_source", "continuity_required", "parent_line_id"]) {
      assert.ok(!q.includes(k), `story scene schema has no ${k}`);
    }
    assert.ok(q.includes("MULTI-SHOT SCENES"), "story prompt plans timed shots");
    assert.ok(q.includes(`"shots"`), "story schema carries shots");
  });
  it("validateLyricPlan accepts a coherent multi-shot plan, flags gaps", () => {
    const lines = parseLyricLines(LYRICS);
    const mk = (n, lineId, shotId, dur, extra = {}) => normalizeScene({
      title: `S${n}`, lyric_line_id: lineId, parent_line_id: lineId, shot_id: shotId,
      lyric_segment: `seg ${shotId}`, action: `action ${shotId}`,
      image_prompt: `hanuman ${shotId} still`,
      video_prompt: `camera slowly tracks as hanuman moves ${shotId}`,
      duration_seconds: dur, song_start_time: 0, song_end_time: dur, ...extra,
    }, n, 5);
    const good = [mk(1, 1, "1-A", 7), mk(2, 1, "1-B", 6), mk(3, 2, "2-A", 7)];
    assert.deepEqual(validateLyricPlan(good, lines, 20), []);
    const gap = [mk(1, 1, "1-A", 7)];
    const issues = validateLyricPlan(gap, lines, 20);
    assert.ok(issues.some((m) => m.includes("lyric line 2")), issues.join(" | "));
    const badCont = [mk(1, 1, "1-A", 10, { continuity_required: true, reference_source: "NONE" }),
      mk(2, 2, "2-A", 10)];
    assert.ok(validateLyricPlan(badCont, lines, 20).some((m) => m.includes("continuity_required")));
  });
  it("boardToScenario passes lyric metadata through without touching prompts", () => {    const cfg = boardToScenario({
      input: { title: "H", visualStyle: "Anime", sceneSeconds: 5 },
      blueprint: { characters: [], locations: [] },
      scenes: [normalizeScene({
        title: "Burn", image_prompt: "lanka burning, anime", video_prompt: "flames rise, camera pulls back",
        lyric_line_id: 8, parent_line_id: 8, shot_id: "8-A", lyric_segment: "लंका जारि",
      }, 1, 5)],
    });
    assert.equal(cfg.sequence[0].shot_id, "8-A");
    assert.equal(cfg.sequence[0].parent_line_id, 8);
    assert.equal(cfg.sequence[0].lyric_segment, "लंका जारि");
    assert.ok(cfg.sequence[0].image.includes("lanka burning"));
    // Story scene without lyric fields stays byte-clean (no new keys).
    const plain = boardToScenario({
      input: { title: "M", visualStyle: "Anime", sceneSeconds: 5 },
      blueprint: { characters: [], locations: [] },
      scenes: [{ title: "S", image_prompt: "x, anime", video_prompt: "waves" }],
    });
    assert.ok(!("shot_id" in plain.sequence[0]));
  });
});

describe("multi-shot scenes (timed shots tiling the scene)", () => {
  it("splitSceneTimeline sizes shots by pronounceable length, tiling exactly", () => {
    // User's example shape: one 3s scene, denser middle segment longest.
    const tl = splitSceneTimeline(["Ram", "lifts the heavy burning bow with both hands", "fire"], 3);
    assert.equal(tl.length, 3);
    assert.equal(tl[0].start_time, 0);
    assert.ok(tl[1].duration_seconds > tl[0].duration_seconds, "denser segment runs longer");
    assert.ok(tl[1].duration_seconds > tl[2].duration_seconds);
    assert.equal(tl[2].end_time, 3);
    // Cumulative, gapless, exact sum.
    tl.forEach((t, i) => {
      if (i > 0) assert.equal(t.start_time, tl[i - 1].end_time);
      assert.ok(t.duration_seconds >= MIN_SHOT_SECONDS);
    });
    const sum = tl.reduce((a, t) => a + t.duration_seconds, 0);
    assert.equal(Math.round(sum * 10) / 10, 3);
    // Degenerate input never throws.
    assert.deepEqual(splitSceneTimeline([], 3), []);
    assert.deepEqual(splitSceneTimeline(["a"], 0), []);
    const single = splitSceneTimeline(["only one"], 5);
    assert.equal(single.length, 1);
    assert.deepEqual([single[0].start_time, single[0].end_time], [0, 5]);
  });
  it("normalizeShot defaults ids, numbering and camera", () => {
    const sh = normalizeShot({ lyric_segment: "lifts the bow", action: "lifts" }, 7, 1);
    assert.equal(sh.shot_id, "7-B");
    assert.equal(sh.shot_number, 2);
    assert.equal(sh.camera.shot_type, "Medium Shot");
    assert.deepEqual(sh.characters, []);
    assert.deepEqual(sh.dialogue, []);
  });
  it("normalizeScene repairs shot timings to tile the scene exactly", () => {
    // Garbage/missing AI durations -> redistributed by pronounceable length.
    const s = normalizeScene({
      title: "Lift", duration_seconds: 5,
      shots: [
        { lyric_segment: "Ram", action: "stands" },
        { lyric_segment: "lifts the heavy burning bow with both hands", action: "lifts the bow" },
        { lyric_segment: "fire", action: "flames rise" },
      ],
    }, 1, 3);
    assert.equal(s.shots.length, 3);
    assert.equal(s.shots[0].shot_id, "1-A");
    assert.equal(s.duration_seconds, 5);
    assert.equal(s.shots[0].start_time, 0);
    assert.equal(s.shots[2].end_time, 5);
    assert.ok(s.shots[1].duration_seconds > s.shots[0].duration_seconds);
    // Trusted AI timings: lengths kept, boundaries re-derived cumulatively.
    const t = normalizeScene({
      title: "Lift", duration_seconds: 3,
      shots: [
        { lyric_segment: "Ram arrives", duration_seconds: 1.4 },
        { lyric_segment: "lifts the bow", duration_seconds: 1.1 },
        { lyric_segment: "fire rises", duration_seconds: 0.5 },
      ],
    }, 2, 3);
    assert.deepEqual(t.shots.map((x) => x.duration_seconds), [1.4, 1.1, 0.5]);
    assert.deepEqual(t.shots.map((x) => x.start_time), [0, 1.4, 2.5]);
    assert.equal(t.shots[2].end_time, 3);
    assert.equal(t.duration_seconds, 3);
    // Legacy scenes are untouched: no shots key content, integer duration.
    const legacy = normalizeScene({ title: "Wake" }, 3, 5);
    assert.deepEqual(legacy.shots, []);
    assert.equal(legacy.duration_seconds, 5);
  });
  it("boardToScenario flattens shots to one beat each; legacy beats stay byte-identical", () => {
    const board = {
      input: { title: "H", visualStyle: "Anime", sceneSeconds: 5 },
      blueprint: {
        characters: [{ character_id: "ram", name: "Ram", visual_identity_prompt: "blue-skinned prince" }],
        locations: [{ location_id: "forest", name: "Forest", visual_identity_prompt: "dense forest" }],
      },
      scenes: [normalizeScene({
        title: "Lift the bow", duration_seconds: 3, location: "forest",
        lyric_line_id: 4, parent_line_id: 4, song_start_time: 10,
        shots: [
          {
            lyric_segment: "Ram arrives", characters: ["ram"], location: "forest",
            action: "walks in", image_prompt: "ram walks, anime", video_prompt: "camera pans as he walks",
            dialogue: [{ speaker: "ram", line: "I am here" }], duration_seconds: 1.4,
          },
          {
            lyric_segment: "lifts the bow", characters: ["ram"],
            action: "lifts", image_prompt: "ram lifts bow, anime", video_prompt: "he lifts as camera holds",
            duration_seconds: 1.6,
          },
        ],
      }, 1, 5)],
    };
    const cfg = boardToScenario(board);
    assert.equal(cfg.sequence.length, 2);
    assert.equal(cfg.sequence[0].title, "lift_the_bow_a");
    assert.equal(cfg.sequence[1].title, "lift_the_bow_b");
    assert.equal(cfg.sequence[0].duration, 1.4);
    assert.equal(cfg.sequence[1].duration, 1.6);
    assert.equal(cfg.sequence[0].scene_number, 1);
    assert.equal(cfg.sequence[0].shot_id, "1-A");
    assert.equal(cfg.sequence[0].start_time, 0);
    assert.equal(cfg.sequence[0].end_time, 1.4);
    assert.equal(cfg.sequence[1].start_time, 1.4);
    // Song-absolute timing = scene window + shot offset.
    assert.equal(cfg.sequence[0].song_start_time, 10);
    assert.equal(cfg.sequence[1].song_start_time, 11.4);
    assert.equal(cfg.sequence[1].song_end_time, 13);
    // First shot inherits scene dialogue only when it has none of its own;
    // the second shot keeps the scene cast for grounding.
    assert.equal(cfg.sequence[0].dialogue[0].line, "I am here");
    assert.ok(cfg.sequence[1].image.includes("blue-skinned prince"));
    // Legacy scene: one beat, no scene/shot linkage keys at all.
    const plain = boardToScenario({
      input: { title: "M", visualStyle: "Anime", sceneSeconds: 5 },
      blueprint: { characters: [], locations: [] },
      scenes: [{ title: "S", image_prompt: "x, anime", video_prompt: "waves" }],
    });
    assert.equal(plain.sequence.length, 1);
    for (const k of ["scene_number", "shot_id", "shot_number", "start_time", "end_time", "shots"]) {
      assert.ok(!(k in plain.sequence[0]), `legacy beat has no ${k}`);
    }
  });
  it("validateLyricPlan flags shot/duration drift and duplicate shot ids", () => {
    const base = { title: "S", image_prompt: "x still", video_prompt: "camera drifts as x moves" };
    const okScene = normalizeScene({
      ...base, lyric_line_id: 1, parent_line_id: 1, shot_id: "1-A",
      lyric_segment: "seg", action: "action",
      shots: [
        { lyric_segment: "Ram arrives", action: "walks", duration_seconds: 1.4 },
        { lyric_segment: "lifts the bow", action: "lifts", duration_seconds: 1.6 },
      ],
    }, 1, 3);
    assert.ok(okScene.shots.length === 2);
    // Force a drift the normalizer would otherwise repair.
    const drifted = { ...okScene, duration_seconds: 9 };
    const issues = validateLyricPlan([drifted], [{ lyric_line_id: 1, lyric_text: "x" }], null);
    assert.ok(issues.some((m) => m.includes("sum to")), issues.join(" | "));
    const dup = normalizeScene({ ...base, shots: [{ shot_id: "1-A" }, { shot_id: "1-A" }] }, 2, 3);
    assert.ok(validateLyricPlan([dup], [], null).some((m) => m.includes("duplicate shot_id")));
  });
});

describe("dynamic planning (AI decides scenes, shots, durations)", () => {
  const timed = [
    { lyric_line_id: 1, lyric_text: "wake up", song_start_time: 0, song_end_time: 2 },
    { lyric_line_id: 2, lyric_text: "run far", song_start_time: 2, song_end_time: 5 },
    { lyric_line_id: 3, lyric_text: "sleep now", song_start_time: 5, song_end_time: 9 },
  ];
  it("linesForTimeWindow slices the batch window, straddlers included", () => {
    assert.deepEqual(linesForTimeWindow(timed, 0, 2).map((l) => l.lyric_line_id), [1]);
    // Line 2 straddles the start boundary — still included, never skipped.
    assert.deepEqual(linesForTimeWindow(timed, 4.5, 6).map((l) => l.lyric_line_id), [2, 3]);
    assert.deepEqual(linesForTimeWindow(timed, 9, 12), []);
    assert.deepEqual(linesForTimeWindow([], 0, 5), []);
    assert.deepEqual(linesForTimeWindow(timed, 5, 5), []);
  });
  it("planProgress sums planned seconds and reports completion", () => {
    const p = planProgress([{ duration_seconds: 3 }, { duration_seconds: 2.5 }], 20);
    assert.equal(p.plannedSeconds, 5.5);
    assert.equal(p.remaining, 14.5);
    assert.equal(p.done, false);
    assert.equal(planProgress([{ duration_seconds: 20 }], 20).done, true);
    assert.equal(planProgress([{ duration_seconds: 21 }], 20).done, true);
    assert.equal(planProgress([], 20).done, false);
    assert.equal(planProgress([], null).done, false);
  });
  it("normalizeScene keeps the source-line coverage", () => {
    const s = normalizeScene({ title: "Wake", line_from: 2, line_to: 3 }, 1, 5);
    assert.equal(s.line_from, 2);
    assert.equal(s.line_to, 3);
    const old = normalizeScene({ title: "Wake" }, 1, 5);
    assert.equal(old.line_from, null);
    assert.equal(old.line_to, null);
  });
  it("verifyPlanComplete rejects premature complete flags (trust-but-verify)", () => {
    // Regression: a 100-scene/300s plan shrank to 7 scenes at 33s because a
    // mid-story complete=true was trusted blindly.
    const partial = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
      duration_seconds: n === 5 || n === 7 ? 9 : 3, line_from: 1, line_to: 20,
    }));
    assert.equal(
      verifyPlanComplete(partial, { targetSeconds: 300, totalLines: 20, flag: true }),
      false, "33s/300s must not complete even covering the last line");
    // Genuinely finished: last line covered + timeline within tolerance.
    const full = [{ duration_seconds: 298, line_from: 18, line_to: 20 }];
    assert.equal(
      verifyPlanComplete(full, { targetSeconds: 300, totalLines: 20, flag: true }),
      true);
    // Flag without end coverage never completes…
    assert.equal(
      verifyPlanComplete([{ duration_seconds: 299, line_from: 1, line_to: 10 }],
        { targetSeconds: 300, totalLines: 20, flag: true }),
      false);
    // …but pure timeline completion (no flag) still works.
    assert.equal(
      verifyPlanComplete([{ duration_seconds: 300 }], { targetSeconds: 300, flag: false }),
      true);
    assert.equal(verifyPlanComplete([], { targetSeconds: 300, flag: true }), false);
  });
  it("validateLyricPlan flags re-covered source lines", () => {
    const base = { title: "S", image_prompt: "x still", video_prompt: "camera drifts as x moves" };
    const stall = [
      normalizeScene({ ...base, line_from: 1, line_to: 2 }, 1, 3),
      normalizeScene({ ...base, line_from: 1, line_to: 2 }, 2, 3),
    ];
    assert.ok(validateLyricPlan(stall, [], null).some((m) => m.includes("re-covers lines")));
    const advancing = [
      normalizeScene({ ...base, line_from: 1, line_to: 2 }, 1, 3),
      normalizeScene({ ...base, line_from: 3, line_to: 5 }, 2, 3),
    ];
    assert.ok(!validateLyricPlan(advancing, [], null).some((m) => m.includes("re-covers")));
  });
  it("scene prompt plans line by line with AI-decided counts and durations", () => {
    const bp = normalizeBlueprint({
      characters: [], locations: [], objects: [],
      beats: [{ n: 1, title: "Wake", summary: "wakes" }, { n: 2, title: "Run", summary: "runs" }],
    });
    const input = {
      title: "M", story: "Wake up.\nRun far.", language: "Hindi", genre: "Kids",
      visualStyle: "Anime", targetSeconds: 20, sceneSeconds: 5,
    };
    const p = buildScenesPrompt({
      input, blueprint: bp, beats: bp.beats, prevScene: null,
      startNumber: 1, count: 4, styleLock: "LOCK", totalScenes: 4,
      lineRange: [
        { line_id: 1, text: "Wake up.", song_start_time: 0, song_end_time: 8 },
        { line_id: 2, text: "Run far.", song_start_time: 8, song_end_time: 20 },
      ],
      budgetSeconds: 20, plannedSeconds: 0, targetSeconds: 20, totalLines: 2,
    });
    // Dynamic brief: no fixed count, no fixed per-scene duration.
    assert.ok(!p.includes("Write exactly 4"), "count is a cap, not an order");
    assert.ok(!p.includes("SCENE DURATION: 5 seconds each"), "no fixed duration");
    assert.ok(p.includes("YOU decide"), "AI decides counts/durations");
    assert.ok(p.includes("TIME BUDGET"), "batch carries a time budget");
    // Hard batch scope: owned lines out of the total + complete-only-if-last.
    assert.ok(p.includes("SCOPE: lines 1–2 of 2 total"), "scope states bounds");
    assert.ok(p.includes("NEVER plan beyond line 2"), "scope forbids overrun");
    assert.ok(p.includes("ONLY if line 2 (the LAST line)"), "complete gated on last line");
    // Line-by-line analysis with numbered lines + coverage contract.
    assert.ok(p.includes("LINE BY LINE"), "line-by-line analysis");
    assert.ok(p.includes("Line 1: Wake up."), "batch lines are numbered");
    assert.ok(p.includes("line_from"), "scenes state coverage");
    // Completion handshake for the server loop.
    assert.ok(p.includes('"complete"'), "complete flag in schema");
    assert.ok(p.includes("complete=true"), "completion rule stated");
  });
});

describe("extractPartialScenes (truncated batch salvage)", () => {
  const full = `{ "scenes": [
    { "scene_number": 1, "title": "A", "action": "waves", "image_prompt": "x", "video_prompt": "camera pans as he waves" },
    { "scene_number": 2, "title": "B", "action": "runs", "image_prompt": "y", "video_prompt": "camera tracks as he runs" }
  ] }`;
  it("returns every scene from a complete response", () => {
    const out = extractPartialScenes(full);
    assert.equal(out.length, 2);
    assert.equal(out[1].title, "B");
  });
  it("keeps finished scenes when the tail is cut mid-object", () => {
    const cut = full.slice(0, full.indexOf(`"title": "B"`)) + `"title": "B", "act`;
    const out = extractPartialScenes(cut);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "A");
  });
  it("keeps finished scenes when braces inside strings confuse naive scans", () => {
    const tricky = `{ "scenes": [{ "scene_number": 1, "title": "}{ not json {", "action": "ok" }, { "scene_number": 2, "title": "half`;
    const out = extractPartialScenes(tricky);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "}{ not json {");
  });
  it("returns [] for garbage, empty scenes, or a cut before any object", () => {
    assert.deepEqual(extractPartialScenes("no json here"), []);
    assert.deepEqual(extractPartialScenes(""), []);
    assert.deepEqual(extractPartialScenes(`{ "scenes": [ { "scene_number": 1, `), []);
    assert.deepEqual(extractPartialScenes(`{ "scenes": [] } trailing prose`), []);
  });
});
