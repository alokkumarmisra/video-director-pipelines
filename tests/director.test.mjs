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
  canonicalizeSceneRefs,
  dedupeScenes,
  isKidsGenre,
  LIMBLESS_SPECIES_RE,
  anatomyLockFor,
  withAnatomyLock,
  validateBibleAnatomy,
  validateKidsScenePhysics,
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
    assert.ok(offBatch.includes("PREVIOUS SCENE (what just happened"), "OFF batches keep the story bridge");
    assert.ok(!offBatch.includes("PREVIOUS SCENE (end state"), "OFF batches still omit the end-state anchor");
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
  it("batch prompts bridge previous and next beats", () => {
    const bp = normalizeBlueprint({
      characters: [], locations: [], objects: [],
      beats: [
        { n: 1, title: "B1", summary: "s1" },
        { n: 2, title: "B2", summary: "s2" },
        { n: 3, title: "B3", summary: "s3" },
        { n: 4, title: "B4", summary: "s4" },
      ],
    });
    const prev = { scene_number: 1, title: "Prev", action: "waves", characters: ["c1"] };
    const base = {
      title: "T", story: "x", language: "Hindi", genre: "Kids",
      visualStyle: "Anime", targetSeconds: 20, sceneSeconds: 5,
    };
    const first = buildScenesPrompt({
      input: { ...base, chainContinuity: false }, blueprint: bp, beats: bp.beats,
      prevScene: null, startNumber: 1, count: 1, styleLock: "LOCK", totalScenes: 4,
    });
    assert.ok(!first.includes("PREVIOUS SCENE (what just happened"), "first batch has no previous scene");
    assert.ok(first.includes("COMING NEXT"), "first batch previews upcoming beats");
    assert.ok(!first.includes("Beat 1: B1 — s1\n- Beat") || first.includes("Beat 2: B2"), "preview covers beats after the batch range");
    const mid = buildScenesPrompt({
      input: { ...base, chainContinuity: false }, blueprint: bp, beats: bp.beats,
      prevScene: prev, startNumber: 2, count: 1, styleLock: "LOCK", totalScenes: 4,
    });
    assert.ok(mid.includes('PREVIOUS SCENE (what just happened') && mid.includes('"Prev"'), "mid batch summarizes the previous scene");
    assert.ok(mid.includes("COMING NEXT") && mid.includes("do NOT plan scenes for these"), "mid batch stages toward upcoming beats");
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

describe("bible-id grounding (locations/objects actually used)", () => {
  const blueprint = () => normalizeBlueprint({
    characters: [{ character_id: "bandar", name: "Bandar" }],
    locations: [
      { location_id: "jungle", name: "Jungle" },
      { location_id: "park", name: "Park" },
    ],
    objects: [{ object_id: "apple_tree", name: "Apple Tree" }],
    beats: [
      { n: 1, title: "Intro", summary: "meet Bandar", location: "jungle", objects: ["apple_tree"] },
      { n: 2, title: "Play", summary: "park games" },
    ],
  });
  const input = {
    title: "T", language: "English", genre: "Kids", visualStyle: "Cartoon",
    targetSeconds: 60, sceneSeconds: 3, aspectRatio: "16:9", chainContinuity: true,
  };

  it("normalizeScene/normalizeShot drop non-primitive id entries (no [object Object])", () => {
    const s = normalizeScene({ title: "A", characters: ["bandar", { x: 1 }, 7], location: "jungle", shots: [{ characters: [{ y: 2 }] }] }, 1, 3);
    assert.deepEqual(s.characters, ["bandar", "7"]);
    assert.deepEqual(s.shots[0].characters, []);
  });

  it("canonicalizeSceneRefs resolves display names to ids (case-insensitive)", () => {
    const s = normalizeScene({ title: "A", characters: ["Bandar"], location: "PARK" }, 1, 3);
    const { scene, repairs } = canonicalizeSceneRefs(s, blueprint());
    assert.equal(scene.location, "park");
    assert.deepEqual(scene.characters, ["bandar"]);
    assert.deepEqual(repairs, []);
  });

  it("canonicalizeSceneRefs moves objects parked in location into visible refs", () => {
    const s = normalizeScene({ title: "A", characters: ["bandar"], location: "apple_tree" }, 1, 3);
    const { scene, repairs, notes } = canonicalizeSceneRefs(s, blueprint());
    assert.equal(scene.location, "");
    assert.ok(scene.continuity_refs.includes("apple_tree"), "object still grounds the frame");
    assert.deepEqual(repairs, [], "lossless move raises no warning");
    assert.ok(notes.some((n) => n.includes("moved to visible objects")), "move is logged server-side");
  });

  it("canonicalizeSceneRefs moves bible objects parked in cast into visible refs", () => {
    const s = normalizeScene({ title: "A", characters: ["bandar", "apple_tree", "ghost_xyz"], location: "jungle" }, 1, 3);
    const { scene, repairs, notes } = canonicalizeSceneRefs(s, blueprint());
    assert.deepEqual(scene.characters, ["bandar"], "object leaves the cast");
    assert.ok(scene.continuity_refs.includes("apple_tree"), "object stays visible");
    assert.ok(notes.some((n) => n.includes('"apple_tree"') && n.includes("object, not a character")), "move is logged, not warned");
    assert.ok(!repairs.some((r) => r.includes("apple_tree")), "bible object is never reported as unknown");
    assert.ok(repairs.some((r) => r.includes("ghost_xyz")), "truly unknown cast still warns");
  });

  it("canonicalizeSceneRefs drops hallucinated cast, keeps unresolvable places as text", () => {
    const s = normalizeScene({ title: "A", characters: ["bandar", "children", "elephant (hathi)"], location: "Somewhere Magical" }, 1, 3);
    const { scene, repairs } = canonicalizeSceneRefs(s, blueprint());
    assert.deepEqual(scene.characters, ["bandar"]);
    assert.equal(scene.location, "Somewhere Magical");
    assert.ok(repairs.some((r) => r.includes("children")), "dropped cast is reported");
    assert.ok(repairs.some((r) => r.includes("Somewhere Magical")), "kept place is reported");
  });

  it("dedupeScenes drops exact title+action repeats, keeping the first", () => {
    const a = { title: "Chase", action: "Monkey runs" };
    const b = { title: "  chase ", action: "MONKEY  runs" };
    const c = { title: "Rest", action: "Monkey sleeps" };
    const { kept, dropped } = dedupeScenes([a], [b, c]);
    assert.equal(dropped, 1);
    assert.deepEqual(kept, [c]);
  });

  it("normalizeBlueprint keeps beat place/props; batches render them", () => {
    const bp = blueprint();
    assert.equal(bp.beats[0].location, "jungle");
    assert.deepEqual(bp.beats[0].objects, ["apple_tree"]);
    assert.ok(!("location" in bp.beats[1]), "beats without place stay lean");
    const p = buildScenesPrompt({
      input, blueprint: bp, beats: bp.beats, startNumber: 1, count: 12,
      styleLock: "style", totalScenes: 20,
    });
    assert.ok(p.includes("VALID LOCATIONS: jungle, park"), "exact id list is in the prompt");
    assert.ok(p.includes("VALID OBJECTS: apple_tree"), "objects listed");
    assert.ok(p.includes("LOCATION & OBJECT ROTATION"), "rotation mandate present");
    assert.ok(p.includes("exact id only"), "free-text places forbidden");
    assert.ok(p.includes("Beat 1: Intro — meet Bandar [📍 jungle | 🧺 apple_tree]"), "beats carry place/props");
    assert.ok(p.includes("LOCATION FOLLOWS THE STORY"), "connected mode no longer pins one place");
  });

  it("bible prompt asks beats for place + props", () => {
    const p = buildBiblePrompt({ ...input, story: "A monkey plays." });
    assert.ok(p.includes('"location": "<location_id where this beat happens>"'), "beat place in schema");
    assert.ok(p.includes("spread beats across ALL locations/objects"), "spread rule present");
  });
});

describe("kids songs (saanpu-style rhymes)", () => {
  it("parseLyricLines drops markdown-bold headers and strips emojis", () => {
    const lines = parseLyricLines("**[Intro – प्यारी सी धुन]**\n\nआया आया, कौन है आया?\n**[Verse 1]**\nनन्हा साँप हमारा,\n## Chorus\nलाला गाओ!\nसाँपू राजा, बाय-बाय! 🎵\n🎵\n");
    assert.deepEqual(lines.map((l) => l.lyric_text), [
      "आया आया, कौन है आया?",
      "नन्हा साँप हमारा,",
      "लाला गाओ!",
      "साँपू राजा, बाय-बाय!",
    ]);
    assert.deepEqual(lines.map((l) => l.lyric_line_id), [1, 2, 3, 4]);
  });
  it("validateLyricPlan allows a repeated chorus (refrain), still flags stalls", () => {
    const base = { title: "S", image_prompt: "x still", video_prompt: "camera drifts as x moves" };
    const lyricLines = [
      { lyric_line_id: 1, lyric_text: "verse one" },
      { lyric_line_id: 2, lyric_text: "verse two" },
      { lyric_line_id: 3, lyric_text: "chorus ho" },
      { lyric_line_id: 4, lyric_text: "chorus hey" },
      { lyric_line_id: 5, lyric_text: "verse three" },
    ];
    // verse(1-2) chorus(3-4) verse(5) then the chorus repeats: the planner
    // links the repeat to the FIRST chorus ids (identical words) — a refrain,
    // not a stall.
    const refrain = [
      normalizeScene({ ...base, line_from: 1, line_to: 2 }, 1, 3),
      normalizeScene({ ...base, line_from: 3, line_to: 4 }, 2, 3),
      normalizeScene({ ...base, line_from: 5, line_to: 5 }, 3, 3),
      normalizeScene({ ...base, line_from: 3, line_to: 4 }, 4, 3),
    ];
    assert.ok(!validateLyricPlan(refrain, lyricLines, null).some((m) => m.includes("re-covers lines")), "repeated chorus is not a stall");
    // Same shape but the backward jump lands on DIFFERENT words: genuine stall.
    const jump = [
      normalizeScene({ ...base, line_from: 1, line_to: 2 }, 1, 3),
      normalizeScene({ ...base, line_from: 5, line_to: 5 }, 2, 3),
      normalizeScene({ ...base, line_from: 3, line_to: 3 }, 3, 3),
    ];
    const otherWords = [
      { lyric_line_id: 1, lyric_text: "alpha" },
      { lyric_line_id: 2, lyric_text: "beta" },
      { lyric_line_id: 3, lyric_text: "gamma" },
      { lyric_line_id: 5, lyric_text: "delta" },
    ];
    assert.ok(validateLyricPlan(jump, otherWords, null).some((m) => m.includes("re-covers lines")), "backward jump still flags");
    // Exact repeat of the immediately previous range still flags (true stall).
    const stall = [
      normalizeScene({ ...base, line_from: 1, line_to: 2 }, 1, 3),
      normalizeScene({ ...base, line_from: 1, line_to: 2 }, 2, 3),
    ];
    assert.ok(validateLyricPlan(stall, lyricLines.slice(0, 2), null).some((m) => m.includes("re-covers lines")), "adjacent repeat still flags");
  });
  it("bible prompt registers every singer for kids genres only", () => {
    const kids = buildBiblePrompt({
      title: "S", story: "lyrics", language: "Hindi", genre: "Kids",
      visualStyle: "Cartoon", targetSeconds: 60, sceneSeconds: 5,
    });
    assert.ok(kids.includes("KIDS CAST RULE"), "kids bible asks for the full animal cast");
    const custom = buildBiblePrompt({
      title: "S", story: "lyrics", language: "Hindi", genre: "Custom", genreCustom: "nursery rhymes",
      visualStyle: "Cartoon", targetSeconds: 60, sceneSeconds: 5,
    });
    assert.ok(custom.includes("KIDS CAST RULE"), "custom nursery genre counts as kids");
    const epic = buildBiblePrompt({
      title: "S", story: "story", language: "Hindi", genre: "Fantasy",
      visualStyle: "Anime", targetSeconds: 60, sceneSeconds: 5,
    });
    assert.ok(!epic.includes("KIDS CAST RULE"), "other genres stay byte-identical in spirit");
    assert.ok(isKidsGenre("Kids") && isKidsGenre("Educational") && isKidsGenre("Custom", "preschool learning"));
    assert.ok(!isKidsGenre("Fantasy") && !isKidsGenre("Horror") && !isKidsGenre(""));
  });
});

describe("anatomy integrity (snake stays limbless, no extra parts)", () => {
  const snake = {
    character_id: "sapoo", name: "Sapoo", species: "snake",
    appearance: { body: "limbless serpentine body", ears: "none" },
    visual_identity_prompt: "green snake",
  };
  it("anatomyLockFor states explicit exclusions for limbless/earless cast, null otherwise", () => {
    assert.ok(LIMBLESS_SPECIES_RE.test("snake"));
    const lock = anatomyLockFor(snake);
    assert.ok(lock.includes("no legs"));
    assert.ok(lock.includes("no arms"));
    assert.ok(lock.includes("no ears"));
    assert.ok(lock.includes("no wings"));
    assert.equal(anatomyLockFor({ character_id: "m", name: "Minku", visual_identity_prompt: "grey mouse" }), null);
  });
  it("withAnatomyLock is idempotent and passes other boards through untouched", () => {
    const lock = anatomyLockFor(snake);
    assert.equal(withAnatomyLock(`slithers, ${lock}`, [snake]), `slithers, ${lock}`);
    assert.equal(withAnatomyLock("mouse waking", [{ visual_identity_prompt: "grey mouse" }]), "mouse waking");
  });
  it("boardToScenario enforces the lock on snake scenes + reference, keeps legacy boards clean", () => {
    const cfg = boardToScenario({
      input: { title: "S", visualStyle: "Anime", sceneSeconds: 5 },
      blueprint: { characters: [snake], locations: [] },
      scenes: [{ title: "S", characters: ["sapoo"], image_prompt: "sapoo slithers", video_prompt: "slithers" }],
    });
    assert.ok(cfg.sequence[0].image.includes("no legs"), "scene image carries the exclusion");
    assert.ok(cfg.sequence[0].image.includes("no ears"), "scene image excludes ears");
    assert.ok(cfg.referencePrompt.includes("no legs"), "reference carries the exclusion");
    const legacy = boardToScenario({
      input: { title: "Minku", visualStyle: "Anime", sceneSeconds: 5 },
      blueprint: {
        logline: "A mouse adventure.",
        characters: [{ name: "Minku", role: "main_character", visual_identity_prompt: "grey mouse" }],
        locations: [{ description: "forest" }],
      },
      scenes: [{ title: "Wake Up", image_prompt: "mouse waking", video_prompt: "mouse stretches" }],
    });
    assert.ok(!legacy.sequence[0].image.includes("limbless"), "legacy boards gain no snake wording");
    assert.ok(!legacy.referencePrompt.includes("limbless"));
  });
  it("bible + scene prompts order anatomy-safe staging without limb-suggesting words", () => {
    const bible = buildBiblePrompt({
      title: "S", story: "a snake", language: "Hindi", genre: "Kids",
      visualStyle: "Cartoon", targetSeconds: 60, sceneSeconds: 5,
    });
    assert.ok(bible.includes("ANATOMY INTEGRITY RULE"), "bible records the species body plan");
    const bp = normalizeBlueprint({
      characters: [{ name: "Sapoo", character_id: "sapoo", species: "snake", visual_identity_prompt: "green snake" }],
      locations: [], objects: [], beats: [{ n: 1, title: "B", summary: "s" }],
    });
    const p = buildScenesPrompt({
      input: {
        title: "S", story: "x", language: "Hindi", genre: "Kids",
        visualStyle: "Anime", targetSeconds: 10, sceneSeconds: 5,
      },
      blueprint: bp, beats: bp.beats, prevScene: null,
      startNumber: 1, count: 1, styleLock: "LOCK", totalScenes: 1,
    });
    assert.ok(p.includes("ANATOMY-SAFE STAGING"), "scene brief stages only possible actions");
    assert.ok(!p.includes("(limbs,"), "video schema no longer suggests limbs to the model");
  });
  it("bible rule is conditional: snake template forbidden for legged species", () => {
    const bible = buildBiblePrompt({
      title: "D", story: "a dog", language: "Hindi", genre: "Kids",
      visualStyle: "Cartoon", targetSeconds: 60, sceneSeconds: 5,
    });
    assert.ok(bible.includes("ANATOMY INTEGRITY RULE"));
    assert.ok(bible.includes("For EVERY OTHER species"), "legged species get their own branch");
    assert.ok(bible.includes("NEVER write"), "limbless wording explicitly forbidden for legged cast");
  });
  it("anatomyLockFor refuses poisoned legged species, keeps real snakes locked", () => {
    const poisonedDog = {
      character_id: "doggi", name: "Doggi",
      species: "domestic dog, one continuous elongated limbless serpentine body, no legs, no arms",
      appearance: { ears: "none" },
      visual_identity_prompt: "limbless serpentine snake body, fur brown",
    };
    assert.equal(anatomyLockFor(poisonedDog), null, "poisoned dog gets no snake lock");
    assert.equal(anatomyLockFor({ character_id: "d", name: "Doggi", species: "dog", visual_identity_prompt: "brown four-legged dog" }), null);
  });
  it("validateBibleAnatomy flags latched bibles, silent on clean ones", () => {
    const poisoned = { characters: [{ name: "Doggi", species: "domestic dog, limbless serpentine body, no legs", visual_identity_prompt: "snake body" }] };
    const warns = validateBibleAnatomy(poisoned);
    assert.equal(warns.length, 1);
    assert.ok(warns[0].includes("Doggi") && warns[0].includes("limbless"));
    assert.deepEqual(validateBibleAnatomy({ characters: [{ name: "Doggi", species: "dog", visual_identity_prompt: "brown four-legged dog" }] }), []);
    assert.deepEqual(validateBibleAnatomy({ characters: [{ name: "Sapoo", species: "snake", visual_identity_prompt: "limbless serpentine snake" }] }), []);
    assert.deepEqual(validateBibleAnatomy({}), []);
  });
  it("validateBibleAnatomy enforces skin covering: scales/feathers/skin/fur", () => {
    const one = (name, species, identity) =>
      validateBibleAnatomy({ characters: [{ name, species, visual_identity_prompt: identity }] });
    assert.equal(one("S", "snake", "green snake with fur").length, 1, "snake with fur flags");
    assert.equal(one("L", "lizard", "furry lizard").length, 1, "lizard with fur flags");
    assert.equal(one("E", "elephant", "grey elephant with fur").length, 1, "elephant with fur flags");
    assert.equal(one("B", "buffalo", "black buffalo, fur").length, 1, "buffalo with fur flags");
    assert.equal(one("P", "parrot", "red fur parrot").length, 1, "bird with fur flags");
    assert.equal(one("Sh", "lion", "lion, bare skin, no fur").length, 1, "fur-less lion flags");
    assert.deepEqual(one("S", "snake", "limbless serpentine snake, green scales"), []);
    assert.deepEqual(one("S", "snake", "green scales, no fur or feathers"), [], "negative covering text stays clean");
    assert.deepEqual(one("Sh", "lion", "golden fur lion, four legs"), []);
    assert.deepEqual(one("E", "elephant", "grey bare skin, four legs"), []);
  });
  it("Hindi species are recognized by anatomy and covering checks", () => {
    assert.ok(validateBibleAnatomy({ characters: [{ name: "कुत्ता", species: "कुत्ता, limbless serpentine body", visual_identity_prompt: "snake body" }] }).length);
    assert.ok(validateBibleAnatomy({ characters: [{ name: "छिपकली", species: "छिपकली", visual_identity_prompt: "furry lizard" }] }).length);
    assert.ok(validateBibleAnatomy({ characters: [{ name: "हाथी", species: "हाथी", visual_identity_prompt: "grey fur" }] }).length);
    assert.ok(validateBibleAnatomy({ characters: [{ name: "Doggy", species: "", visual_identity_prompt: "limbless serpentine body" }] }).length,
      "species-name fallback catches missing species fields");
    assert.equal(anatomyLockFor({ name: "Doggy", species: "", visual_identity_prompt: "limbless serpentine body" }), null,
      "missing species must not cement snake anatomy from identity text");
  });
  it("scene-level kids validator catches impossible actions and coverings", () => {
    const board = {
      input: { genre: "Kids" },
      blueprint: { characters: [
        { character_id: "dog", name: "Dog", species: "dog" },
        { character_id: "snake", name: "Snake", species: "snake" },
        { character_id: "elephant", name: "Elephant", species: "elephant" },
      ] },
      scenes: [
        { scene_number: 1, characters: ["dog"], action: "The dog slithers across the floor", image_prompt: "limbless serpentine dog" },
        { scene_number: 2, characters: ["snake"], action: "The snake walks on four legs", image_prompt: "furry snake" },
        { scene_number: 3, characters: ["elephant"], action: "The elephant waves", image_prompt: "elephant covered in fur" },
      ],
    };
    const errors = validateKidsScenePhysics(board);
    assert.ok(errors.some((x) => x.includes("Dog") && /snake-like/i.test(x)));
    assert.ok(errors.some((x) => x.includes("Snake") && /limbless/i.test(x)));
    assert.ok(errors.some((x) => x.includes("Snake") && /scales/i.test(x)));
    assert.ok(errors.some((x) => x.includes("Elephant") && /bare skin/i.test(x)));
    assert.deepEqual(validateKidsScenePhysics({ input: { genre: "Adventure" }, scenes: board.scenes }), []);
  });
  it("kids scene duration floor is enforced and shot floor remains feasible", () => {
    const short = normalizeScene({ duration_seconds: 1, shots: [{ duration_seconds: 0.2 }, { duration_seconds: 0.8 }] }, 1, 5,
      { minShotSeconds: 1.5, minSceneSeconds: 4 });
    assert.equal(short.duration_seconds, 4);
    assert.ok(short.shots.every((x) => x.duration_seconds >= 1.5));
    const many = normalizeScene({ duration_seconds: 4, shots: Array.from({ length: 5 }, (_, i) => ({ shot_id: `1-${i}`, duration_seconds: 0.8 })) }, 1, 5,
      { minShotSeconds: 1.5, minSceneSeconds: 4 });
    assert.equal(many.duration_seconds, 7.5, "lengthens scene so every shot can meet the minimum");
    assert.ok(many.shots.every((x) => x.duration_seconds >= 1.5));
  });
});
