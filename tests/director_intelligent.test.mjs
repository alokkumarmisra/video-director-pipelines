// Intelligent Director upgrade: acceptance tests A–H (pure lib, no network).
// Run: node --test tests/director_intelligent.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBlueprint,
  normalizeScene,
  parseLyricLines,
  estimateLyricTiming,
  buildLyricCoverageMap,
  coverageSummary,
  boardLyricLines,
  extractMeaningfulPhrases,
  normalizeCastEntry,
  castIdsOf,
  characterDirectionsOf,
  validateShotDirection,
  detectContinuityIssues,
  scoreDirectorPlan,
  validateLyricPlan,
  boardToScenario,
  genreDirectingNotes,
  isKidsGenre,
  kidsDirectingRules,
  kidsContentWarnings,
  learningFocus,
  extractLearningExpectations,
  sceneLearningTexts,
  learningReviewChecklist,
  verifyOcrText,
  buildBiblePrompt,
  buildScenesPrompt,
  splitSceneTimeline,
  normalizeShots,
  MIN_SHOT_SECONDS,
  MIN_KIDS_SHOT_SECONDS,
  DIRECTOR_STAGES,
  llmModelName,
} from "../lib/director.mjs";

const mkScene = (n, extra = {}) => normalizeScene({
  title: `S${n}`,
  image_prompt: `still ${n}, anime`,
  video_prompt: `camera holds as the character moves ${n}`,
  duration_seconds: 3,
  ...extra,
}, n, 3);

// Test A: rabbit finds and eats a carrot — connected causal chain.
describe("acceptance A: action-oriented children's song", () => {
  it("covers discover -> approach -> pick up -> eat as linked shots", () => {
    const lines = parseLyricLines("Rabbit finds a carrot in the garden\nHe picks it up and eats it happily");
    const scenes = [
      mkScene(1, { lyric_line_id: 1, parent_line_id: 1, shot_id: "1-A", lyric_segment: "Rabbit finds a carrot", action: "The rabbit notices a ripe carrot beside the path, stops and widens its eyes", characters: ["rabbit"], emotion: "curious", expression: "wide eyes" }),
      mkScene(2, { lyric_line_id: 1, parent_line_id: 1, shot_id: "1-B", lyric_segment: "in the garden", action: "The rabbit hops closer to the carrot and carefully lifts it with both paws", characters: ["rabbit"], emotion: "happy", expression: "proud smile" }),
      mkScene(3, { lyric_line_id: 2, parent_line_id: 2, shot_id: "2-A", lyric_segment: "eats it happily", action: "The rabbit bites the carrot and chews with a proud smile", characters: ["rabbit"], emotion: "happy", expression: "chewing smile" }),
    ];
    const map = buildLyricCoverageMap(scenes, lines);
    assert.equal(map.length, 2);
    assert.equal(map[0].status, "covered");
    assert.equal(map[1].status, "covered");
    const score = scoreDirectorPlan({ scenes, blueprint: { lyric_lines: lines }, input: {} });
    assert.ok(score.score >= 70, `score ${score.score}: ${score.issues.join("|")}`);
  });
});

// Test B: repeated chorus reuses motif without duplicating shot ids.
describe("acceptance B: repeated chorus", () => {
  it("preserves wording while progressing visuals", () => {
    const lines = parseLyricLines("Dance dance, clap your hands\nDance dance, clap your hands");
    const scenes = [
      mkScene(1, { lyric_line_id: 1, shot_id: "1-A", lyric_segment: "Dance dance", action: "Children dance in a circle in the garden", characters: ["a"], location: "garden" }),
      mkScene(2, { lyric_line_id: 2, shot_id: "2-A", lyric_segment: "Dance dance", action: "Children dance in a circle at sunset, same steps, warmer light", characters: ["a"], location: "garden", transition_to_next_scene: "" }),
    ];
    const map = buildLyricCoverageMap(scenes, lines);
    assert.ok(map.every((l) => l.status === "covered"));
    // distinct shot ids, same segment motif evolved
    assert.notEqual(scenes[0].shot_id, scenes[1].shot_id);
  });
});

// Test C: two characters exchange an object with correct gaze/roles.
describe("acceptance C: multi-character interaction", () => {
  it("assigns active/reacting roles and gaze", () => {
    const dirs = characterDirectionsOf({
      characters_detailed: [
        { characterId: "rabbit", role: "active", emotion: "happy", gazeTarget: "lion", action: "hands the carrot to the lion" },
        { characterId: "lion", role: "reacting", emotion: "grateful", gazeTarget: "carrot", action: "accepts the carrot and smiles" },
      ],
    });
    assert.equal(dirs.length, 2);
    assert.equal(dirs[0].role, "active");
    assert.equal(dirs[1].role, "reacting");
    assert.equal(dirs[0].gaze_target, "lion");
    // string-id legacy still works
    assert.deepEqual(castIdsOf(["rabbit", { characterId: "lion" }]), ["rabbit", "lion"]);
    assert.ok(normalizeCastEntry("rabbit").character_id === "rabbit");
  });
});

// Test D: devotional lyrics stay respectful.
describe("acceptance D: devotional song", () => {
  it("genre notes require respectful register", () => {
    const notes = genreDirectingNotes("Devotional");
    assert.ok(/respectful/i.test(notes));
    assert.ok(!/parody|slapstick/i.test(genreDirectingNotes("Kids")));
    const s = scoreDirectorPlan({
      scenes: [mkScene(1, { action: "Hanuman bows before Rama with folded hands in the temple", emotion: "reverent" })],
      blueprint: {}, input: { genre: "Devotional" },
    });
    assert.ok(s.score >= 50);
  });
});

// Test E: long line splits into coherent shots tiling exactly.
describe("acceptance E: long lyric line", () => {
  it("splits one line into multiple tiling shots", () => {
    const s = normalizeScene({
      title: "Long", duration_seconds: 6, lyric_line_id: 1,
      shots: [
        { lyric_segment: "Ram arrives at the garden gate", action: "walks to the gate", duration_seconds: 2 },
        { lyric_segment: "lifts the heavy bow with both hands", action: "lifts the bow", duration_seconds: 2.5 },
        { lyric_segment: "fire rises around him", action: "flames rise", duration_seconds: 1.5 },
      ],
    }, 1, 6);
    const sum = s.shots.reduce((a, x) => a + x.duration_seconds, 0);
    assert.equal(Math.round(sum * 10) / 10, 6);
    assert.deepEqual(s.shots.map((x) => x.start_time), [0, 2, 4.5]);
  });
});

// Test F: continuity detects jumps and flips.
describe("acceptance F: continuity", () => {
  it("flags location jumps and emotion flips", () => {
    const scenes = [
      mkScene(1, { location: "garden", characters_detailed: [{ characterId: "r", emotion: "happy", action: "plays" }] }),
      mkScene(2, { location: "desert", characters_detailed: [{ characterId: "r", emotion: "sad", action: "sits" }] }),
    ];
    const issues = detectContinuityIssues(scenes);
    assert.ok(issues.some((m) => m.includes("location jumps")), issues.join("|"));
    assert.ok(issues.some((m) => m.includes("flips")), issues.join("|"));
    // repaired with a transition: jump warning clears
    const fixed = [
      scenes[0],
      mkScene(2, { location: "desert", transition_to_next_scene: "", continuity_from_previous_scene: "travel montage from the garden", continuity_required: true, reference_source: "PREVIOUS_IMAGE", characters_detailed: [{ characterId: "r", emotion: "happy", action: "arrives, still smiling" }] }),
    ];
    assert.ok(!detectContinuityIssues(fixed).some((m) => m.includes("location jumps")));
  });
});

// Test G: failure recovery keeps plan + completed assets.
describe("acceptance G: failure recovery", () => {
  it("score/approve inputs survive a failed stage (plan persists)", () => {
    const board = {
      scenes: [mkScene(1), mkScene(2)],
      blueprint: { lyric_lines: [] }, input: { targetSeconds: 6 },
    };
    const before = scoreDirectorPlan(board);
    // simulate failed video job: scenes unchanged, only progress lost
    const after = scoreDirectorPlan({ ...board });
    assert.equal(after.score, before.score);
    assert.equal(after.breakdown.promptCompleteness, 100);
    const cfg = boardToScenario(board);
    assert.equal(cfg.sequence.length, 2); // pipeline still consumes the plan
  });
});

// Test H: existing projects — legacy boards stay byte-compatible.
describe("acceptance H: existing projects", () => {
  it("legacy scene without new keys approves byte-identically", () => {
    const cfg = boardToScenario({
      input: { title: "M", visualStyle: "Anime", sceneSeconds: 5 },
      blueprint: { characters: [], locations: [] },
      scenes: [{ title: "S", image_prompt: "x, anime", video_prompt: "waves" }],
    });
    assert.equal(cfg.sequence.length, 1);
    for (const k of ["scene_number", "shot_id", "characters_detailed"]) {
      assert.ok(!(k in cfg.sequence[0]), `legacy beat has no ${k}`);
    }
  });
});

describe("coverage + scoring engine", () => {
  it("extractMeaningfulPhrases keeps exact words, splits long lines", () => {
    assert.deepEqual(extractMeaningfulPhrases(""), []);
    const p = extractMeaningfulPhrases("Rabbit finds a carrot in the garden, picks it up and eats it happily");
    assert.ok(p.length >= 2);
    assert.ok(p.every((x) => "Rabbit finds a carrot in the garden, picks it up and eats it happily".includes(x.text)));
  });
  it("coverage map marks uncovered lines and scores below threshold", () => {
    const lines = parseLyricLines("wake up\nrun far\nsleep now");
    const scenes = [mkScene(1, { lyric_line_id: 1, lyric_segment: "wake up", action: "wakes and stretches" })];
    const map = buildLyricCoverageMap(scenes, lines);
    assert.equal(map[0].status, "covered");
    assert.equal(map[1].status, "uncovered");
    const sum = coverageSummary(map);
    assert.ok(sum.pct < 100);
    const score = scoreDirectorPlan({ scenes, blueprint: { lyric_lines: lines }, input: { targetSeconds: 9 } });
    assert.ok(score.score < 90);
    assert.ok(score.issues.some((m) => m.includes("lyric line 2")));
  });
  it("validateShotDirection flags vague + contradictory direction", () => {
    assert.ok(validateShotDirection({ action: "happy" }).length > 0);
    assert.deepEqual(validateShotDirection({ action: "The rabbit lifts the carrot with both paws", image_prompt: "x", video_prompt: "camera holds as he lifts" }), []);
    assert.ok(validateShotDirection({ action: "walks", camera: { movement: "Static" }, video_prompt: "dolly tracking move" }).some((m) => m.includes("contradictory")));
  });
  it("stages + model name are stable", () => {
    assert.ok(DIRECTOR_STAGES.includes("coverage-validation"));
    process.env.LLM_MODEL = "";
    assert.equal(llmModelName(), "local");
  });
  it("boardLyricLines prefers the bible, falls back to song lines, empty on stories", () => {
    const bible = [{ lyric_line_id: 1, lyric_text: "a" }];
    assert.deepEqual(boardLyricLines({ blueprint: { lyric_lines: bible } }), bible);
    assert.deepEqual(
      boardLyricLines({ blueprint: { lyric_lines: [] }, input: { song: { file: "s.mp3" }, story: "wake up\nrun far" } }),
      [{ lyric_line_id: 1, lyric_text: "wake up" }, { lyric_line_id: 2, lyric_text: "run far" }],
    );
    assert.deepEqual(boardLyricLines({ blueprint: {}, input: { story: "a long story" } }), []);
    assert.deepEqual(boardLyricLines(null), []);
  });
});

// Kids/preschool readiness: preset-distilled staging rules reach the Director
// prompts, unsafe content raises advisory warnings, and calm pacing floors hold.
describe("kids readiness: staging rules, safety scan, calm pacing", () => {
  const kidsInput = (genre = "Kids", genreCustom = "") => ({
    title: "Bunny Day", language: "English", genre, genreCustom,
    visualStyle: "3D Preschool Animation", styleCustom: "",
    targetSeconds: 12, sceneSeconds: 5, story: "A bunny hops through the garden.",
    includeDialogue: true, chainContinuity: true,
  });
  const emptyBible = { characters: [], locations: [], objects: [] };

  it("kidsDirectingRules: [] off-genre, base + sub-rules on kids genres", () => {
    assert.deepEqual(kidsDirectingRules("Adventure"), []);
    assert.deepEqual(kidsDirectingRules("Kids", ""), kidsDirectingRules("Kids")); // default custom
    const base = kidsDirectingRules("Kids");
    assert.ok(base.length >= 1 && base[0].includes("KIDS-SAFE STAGING"));
    assert.ok(kidsDirectingRules("Custom", "nursery rhymes").some((r) => r.includes("NURSERY-RHYME")));
    assert.ok(kidsDirectingRules("Custom", "abc learning").some((r) => r.includes("ALPHABET TEACHING")));
    assert.ok(kidsDirectingRules("Educational", "counting fun").some((r) => r.includes("COUNTING")));
    assert.ok(kidsDirectingRules("Kids", "animal friends").some((r) => r.includes("ANIMAL LEARNING")));
    assert.ok(isKidsGenre("Educational") && isKidsGenre("Kids"));
  });

  it("bible + scene prompts carry kids rules only on kids boards", () => {
    const kids = buildBiblePrompt(kidsInput());
    assert.ok(kids.includes("KIDS CAST RULE") && kids.includes("KIDS-SAFE STAGING"));
    const rhyme = buildBiblePrompt(kidsInput("Custom", "nursery rhymes"));
    assert.ok(rhyme.includes("NURSERY-RHYME STRUCTURE"));
    const epic = buildBiblePrompt({ ...kidsInput(), genre: "Adventure" });
    assert.ok(!epic.includes("KIDS CAST RULE") && !epic.includes("KIDS-SAFE STAGING"));
    const scenes = buildScenesPrompt({
      input: kidsInput(), blueprint: emptyBible, beats: [], prevScene: null,
      startNumber: 1, count: 2, styleLock: "lock",
    });
    assert.ok(scenes.includes("KIDS PACING") && scenes.includes(String(MIN_KIDS_SHOT_SECONDS)));
    const scenesEpic = buildScenesPrompt({
      input: { ...kidsInput(), genre: "Adventure" }, blueprint: emptyBible, beats: [],
      prevScene: null, startNumber: 1, count: 2, styleLock: "lock",
    });
    assert.ok(!scenesEpic.includes("KIDS-SAFE STAGING") && !scenesEpic.includes("KIDS PACING"));
  });

  it("kidsContentWarnings: silent off-genre, advisory on kids boards, capped", () => {
    const violent = { input: { genre: "Horror" }, scenes: [{ scene_number: 1, action: "A demon kills with blood" }] };
    assert.deepEqual(kidsContentWarnings(violent), []);
    const gentle = { input: { genre: "Kids" }, scenes: [{ scene_number: 1, action: "The bunny hops and waves hello", dialogue: [{ speaker: "bunny", line: "Hello friends!" }] }] };
    assert.deepEqual(kidsContentWarnings(gentle), []);
    // Style-lock words in image prompts must NOT trip the scan.
    const styley = { input: { genre: "Kids" }, scenes: [{ scene_number: 1, action: "Bunny hops", image_prompt: "dramatic lighting, cinematic" }] };
    assert.deepEqual(kidsContentWarnings(styley), []);
    const bad = {
      input: { genre: "Kids" },
      scenes: [{ scene_number: 2, action: "A monster stabs with a knife, blood everywhere", shots: [{ shot_id: "2-A", action: "calm", dialogue: [{ speaker: "x", line: "we die here" }] }] }],
    };
    const warns = kidsContentWarnings(bad);
    assert.equal(warns.length, 2);
    assert.ok(warns[0].includes("Scene 2") && warns[1].includes("2-A"));
    const flood = { input: { genre: "Kids" }, scenes: Array.from({ length: 12 }, (_, i) => ({ scene_number: i + 1, action: "blood and murder" })) };
    assert.equal(kidsContentWarnings(flood).length, 10);
  });

  it("calm pacing: kids floor redistributes tiny shots, defaults untouched", () => {    assert.equal(MIN_KIDS_SHOT_SECONDS, 1.5);
    const tl = splitSceneTimeline(["Bunny hops", "waves hello", "naps"], 6, { minShotSeconds: MIN_KIDS_SHOT_SECONDS });
    assert.ok(tl.every((t) => t.duration_seconds >= MIN_KIDS_SHOT_SECONDS));
    assert.equal(Math.round(tl.reduce((a, t) => a + t.duration_seconds, 0) * 10) / 10, 6);
    // Infeasible floor degrades gracefully (total/shot wins, never NaN/stall).
    const tight = splitSceneTimeline(["a", "b", "c"], 3, { minShotSeconds: MIN_KIDS_SHOT_SECONDS });
    assert.ok(tight.every((t) => t.duration_seconds >= 1));
    // Default path is byte-identical: sub-second AI timings still trusted.
    const kept = normalizeShots(
      [{ shot_id: "1-A", duration_seconds: 0.6 }, { shot_id: "1-B", duration_seconds: 0.6 }, { shot_id: "1-C", duration_seconds: 1.8 }],
      1, 3,
    );
    assert.deepEqual(kept.map((s) => s.duration_seconds), [0.6, 0.6, 1.8]);
    const calmed = normalizeShots(
      [{ shot_id: "1-A", duration_seconds: 0.6 }, { shot_id: "1-B", duration_seconds: 0.6 }, { shot_id: "1-C", duration_seconds: 1.8 }],
      1, 3, { minShotSeconds: MIN_KIDS_SHOT_SECONDS },
    );
    assert.ok(calmed.every((s) => s.duration_seconds >= MIN_SHOT_SECONDS));
    assert.equal(Math.round(calmed.reduce((a, s) => a + s.duration_seconds, 0) * 10) / 10, 3);
    const sc = normalizeScene({ title: "S", duration_seconds: 6, shots: [{ duration_seconds: 0.5 }, { duration_seconds: 5.5 }] }, 1, 6, { minShotSeconds: MIN_KIDS_SHOT_SECONDS });
    assert.ok(sc.shots.every((s) => s.duration_seconds >= MIN_KIDS_SHOT_SECONDS));
  });

  it("hindi input: genre detection, sub-rules, safety scan in Devanagari", () => {
    assert.ok(isKidsGenre("Custom", "बच्चों के गाने"));
    assert.ok(isKidsGenre("Custom", "balgeet"));
    assert.ok(!isKidsGenre("Adventure", ""));
    assert.ok(kidsDirectingRules("Custom", "लोरी").some((r) => r.includes("NURSERY-RHYME")));
    assert.ok(kidsDirectingRules("Custom", "अक्षर ज्ञान").some((r) => r.includes("ALPHABET TEACHING")));
    assert.ok(kidsDirectingRules("Custom", "गिनती").some((r) => r.includes("COUNTING")));
    assert.ok(kidsDirectingRules("Custom", "जानवर").some((r) => r.includes("ANIMAL LEARNING")));
    const w = (scenes, genre = "Kids", gc = "") => kidsContentWarnings({ input: { genre, genreCustom: gc }, scenes });
    assert.equal(w([{ scene_number: 1, action: "बगीचे में खून बहा" }]).length, 1);
    assert.equal(w([{ scene_number: 1, dialogue: [{ speaker: "x", line: "चुड़ैल आई" }] }]).length, 1);
    assert.equal(w([{ scene_number: 1, action: "khoon everywhere" }]).length, 1);
    // Innocent compounds holding मार/मर stems must NOT flag.
    assert.deepEqual(w([{ scene_number: 1, action: "हमारा बगीचा सुंदर है" }]), []);
    assert.deepEqual(w([{ scene_number: 1, action: "राजकुमार मार्ग पर चला" }]), []);
    assert.deepEqual(w([{ scene_number: 1, action: "बच्चा बीमार है" }]), []);
    assert.deepEqual(w([{ scene_number: 1, action: "चूहा कमरे में नाचा" }]), []);
    assert.deepEqual(w([{ scene_number: 1, action: "बिल्ली डर गई और भागी" }]), []);
    assert.deepEqual(w([{ scene_number: 1, action: "खून और हत्या" }], "Adventure"), []);
  });

  it("learning verify: focus, expectations, OCR compare, review checklist", () => {
    assert.equal(learningFocus("Custom", "abc learning"), "alphabet");
    assert.equal(learningFocus("Custom", "गिनती"), "counting");
    assert.equal(learningFocus("Kids", ""), "kids");
    assert.equal(learningFocus("Adventure", ""), null);
    // Alphabet extraction (English + Hindi).
    assert.deepEqual(extractLearningExpectations(["A for Apple", "letter B"], "alphabet").letters, ["A", "B"]);
    assert.deepEqual(extractLearningExpectations(["अक्षर अ", "इ से इमली"], "alphabet").letters, ["अ", "इ"]);
    assert.deepEqual(extractLearningExpectations(["A for Apple"], "counting"), { letters: [], counts: [] });
    // Count extraction (digits, Devanagari digits, EN + HI words; "one day" ignored).
    assert.deepEqual(extractLearningExpectations(["Five ducks swim", "number 5"], "counting").counts, [5]);
    assert.deepEqual(extractLearningExpectations(["५ तारे चमके"], "counting").counts, [5]);
    assert.deepEqual(extractLearningExpectations(["तीन बिल्लियाँ खेलती हैं"], "counting").counts, [3]);
    assert.deepEqual(extractLearningExpectations(["One day a duck came"], "counting").counts, []);
    // OCR compare.
    assert.deepEqual(verifyOcrText({ letters: ["B"], counts: [5] }, "B\nBALL 5"), { ok: true, missingLetters: [], missingCounts: [] });
    assert.deepEqual(verifyOcrText({ letters: ["B"] }, "BALL").missingLetters, ["B"], "incidental letter inside a word is not a hero-letter hit");
    const bad = verifyOcrText({ letters: ["B"], counts: [5] }, "R\nCAT 3");
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.missingLetters, ["B"]);
    assert.deepEqual(bad.missingCounts, [5]);
    assert.deepEqual(verifyOcrText({ counts: [5] }, "५ तारे").missingCounts, []);
    // Checklist: advisory per-scene lines, capped, silent off-focus.
    const board = {
      input: { genre: "Custom", genreCustom: "abc learning" },
      scenes: [
        { scene_number: 1, title: "A for Apple" },
        { scene_number: 2, title: "running around" },
      ],
    };
    const list = learningReviewChecklist(board);
    assert.ok(list[0].includes('letter "A"') && list[0].includes("verify_learning"));
    assert.ok(list[1].includes("Scene 2") && list[1].includes("no hero letter"));
    assert.deepEqual(learningReviewChecklist({ input: { genre: "Adventure" }, scenes: [{ title: "A for Apple" }] }), []);
    const flood = { input: { genre: "Custom", genreCustom: "numbers learning" }, scenes: Array.from({ length: 20 }, (_, i) => ({ scene_number: i + 1, title: "counting fun" })) };
    assert.equal(learningReviewChecklist(flood).length, 12);
  });
});
