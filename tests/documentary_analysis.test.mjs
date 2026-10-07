// Documentary source-analysis tests: the RAW POEM -> understanding pipeline
// (TASK 0/3) that feeds the bible + shot planners as read-only context.
// Documentary-only: builders without context stay byte-identical, and no
// non-documentary file references the analysis helpers.
// Run: node --test tests/documentary_analysis.test.mjs (repo root; zero deps)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOC_ANALYSIS_STAGES,
  DOC_HISTORY_CAP,
  buildDocAnalysisPrompt,
  normalizeDocAnalysis,
  normalizeDocStageApprovals,
  snapshotDocStages,
  heuristicAnalyze,
  docAnalysisContext,
  buildDocBiblePrompt,
  buildDocShotsPrompt,
  normalizeDocShot,
} from "../lib/documentary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("pipeline covers all 15 requested stages in order", () => {
  assert.deepEqual(DOC_ANALYSIS_STAGES, [
    "raw", "understanding", "characters", "dialogue", "narration", "emotion",
    "location", "action", "visual", "scene", "shot", "continuity",
    "image", "video", "timeline",
  ]);
});

test("analysis prompt asks for every detection stage", () => {
  const p = buildDocAnalysisPrompt({ title: "Shiva", topic: "Tandava", language: "Hindi" });
  for (const k of ["understanding", "characters_detected", "dialogues", "narrations", "emotions", "locations_times", "actions", "visual_meanings"]) {
    assert.ok(p.includes(k), `prompt asks for ${k}`);
  }
});

test("normalize fills stable defaults for garbage input", () => {
  const a = normalizeDocAnalysis(null);
  assert.equal(a.source, "heuristic");
  assert.deepEqual(a.understanding, { summary: "", themes: [], narrative_arc: [] });
  for (const k of ["characters_detected", "dialogues", "narrations", "emotions", "locations_times", "actions", "visual_meanings"]) {
    assert.deepEqual(a[k], [], k);
  }
  // Unknown source labels fall back to heuristic, never pass through.
  assert.equal(normalizeDocAnalysis({ source: "gpt-9" }).source, "heuristic");
});

test("heuristic detects dialogue, emotion, time, action, symbols", () => {
  const a = heuristicAnalyze({
    title: "Shiva",
    topic: "Lord Shiva Tandava at dusk",
    sourceMaterial: "Shiva: Behold my dance!\nThe damaru sounds as he dances in bliss.",
    characters: "Shiva, Parvati",
    locations: "Kailash",
    events: "Tandava",
  });
  assert.equal(a.source, "heuristic");
  assert.ok(a.understanding.summary.length > 10);
  assert.ok(a.characters_detected.some((c) => c.name === "Shiva"));
  assert.ok(a.dialogues.some((d) => d.speaker === "Shiva" && /dance/i.test(d.line)), "speaker: line dialogue");
  assert.ok(a.emotions.length > 0, "emotion keywords");
  assert.ok(a.locations_times.some((l) => l.time_of_day === "dusk"), "dusk cue");
  assert.ok(a.actions.length > 0, "action verbs");
  assert.ok(a.visual_meanings.some((v) => /drum/i.test(v.subject)), "damaru symbol");
  assert.ok(a.narrations.length > 0, "paragraph narration");
});

test("heuristic never invents: empty source, empty sections", () => {
  const a = heuristicAnalyze({ title: "x", topic: "a quiet tale" });
  assert.deepEqual(a.dialogues, []);
  assert.deepEqual(a.actions, []);
  assert.deepEqual(a.visual_meanings, []);
});

test("context renders compact lines, empty when nothing analyzed", () => {
  assert.equal(docAnalysisContext(null), "");
  assert.equal(docAnalysisContext(normalizeDocAnalysis(null)), "");
  const a = heuristicAnalyze({ title: "Shiva", topic: "Tandava at dusk", sourceMaterial: "Shiva: Behold!\nHe dances.", characters: "Shiva", locations: "Kailash" });
  const ctx = docAnalysisContext(a);
  assert.ok(ctx.includes("UNDERSTANDING:") && ctx.includes("DETECTED DIALOGUES"), ctx);
});

test("bible + shots prompts byte-identical without context", () => {
  const brief = { title: "t", topic: "x", language: "Hindi", targetSeconds: 300, targetMinutes: 5, aspectRatio: "16:9", audience: "a", tone: "t", visualStyle: "v", narrationStyle: "n", musicStyle: "m", sourceType: "mixed" };
  assert.equal(buildDocBiblePrompt(brief), buildDocBiblePrompt(brief, ""));
  const chapter = { chapter_number: 1, title: "c", target_duration_seconds: 60, sequences: [] };
  const base = { brief: { visualStyle: "v", tone: "t", narrationVoice: "x" }, board: { characters: [], locations: [] }, chapter };
  assert.equal(buildDocShotsPrompt(base), buildDocShotsPrompt({ ...base, analysisCtx: "" }));
  // …and carry the analysis when present.
  const ctx = docAnalysisContext(heuristicAnalyze({ title: "Shiva", topic: "Tandava", sourceMaterial: "Shiva dances.", characters: "Shiva" }));
  assert.ok(buildDocBiblePrompt(brief, ctx).includes("SOURCE ANALYSIS"));
  assert.ok(buildDocShotsPrompt({ ...base, analysisCtx: ctx }).includes("SOURCE ANALYSIS"));
});

test("shots carry additive analysis passthrough fields", () => {
  const s = normalizeDocShot({ title: "t", dialogue_lines: ["Shiva: Behold"], emotion: "ecstasy", time_of_day: "dusk", actions: ["dance"], visual_meaning: "cycle" }, 1, 1, 1, 1);
  assert.deepEqual(s.dialogue_lines, ["Shiva: Behold"]);
  assert.equal(s.emotion, "ecstasy");
  assert.equal(s.time_of_day, "dusk");
  // Old boards / heuristic shots default to empties.
  const old = normalizeDocShot({ title: "t" }, 1, 1, 1, 1);
  assert.deepEqual(old.dialogue_lines, []);
  assert.equal(old.emotion, "");
  assert.equal(old.time_of_day, "");
});

test("analysis lives in Documentary files only", () => {
  const server = read("frontend/server.mjs");
  assert.ok(server.includes("buildDocAnalysisPrompt"), "plan route analyzes");
  assert.ok(server.includes("board.analysis = analysis"), "board persists analysis");
  for (const f of ["lib/director.mjs", "lib/sequence.mjs", "frontend/src/components/DirectorPage.tsx", "frontend/src/components/ShotList.tsx", "frontend/src/App.tsx"]) {
    const src = read(f);
    assert.ok(!src.includes("heuristicAnalyze") && !src.includes("docAnalysisContext"), `${f} untouched`);
  }
  const page = read("frontend/src/components/DocumentaryPage.tsx");
  assert.ok(page.includes("Create Document"), "Create Document first tab + panel head");
  assert.ok(page.includes("STAGE_ORDER"), "15 stage tabs follow left-to-right");
  assert.ok(page.includes("pipeStages"), "status checklist drives the tabs");
  // Old per-section tabs are gone (their content lives in the stage tabs).
  for (const old of ['tab === "plan"', 'tab === "shots"', 'tab === "locations"', 'tab === "audio"', 'tab === "final"', 'tab === "analysis"', "Director Plan"]) {
    assert.ok(!page.includes(old), `old tab removed: ${old}`);
  }
});

test("stage approvals normalize to known stages only", () => {
  const a = normalizeDocStageApprovals({
    raw: true,
    shot: { approved: true, at: "2026-01-01T00:00:00Z", auto: true },
    image: { approved: false },
    bogus: { approved: true },
  });
  assert.equal(a.raw.approved, true);
  assert.equal(a.raw.auto, false);
  assert.equal(a.shot.auto, true);
  assert.equal(a.shot.at, "2026-01-01T00:00:00Z");
  assert.equal(a.image.approved, false, "explicit unapproved verdict kept");
  assert.ok(!("bogus" in a), "unknown stages dropped");
  assert.deepEqual(normalizeDocStageApprovals(null), {});
});

test("stage snapshots cover all 15 stages from board data", () => {
  const board = {
    brief: { topic: "Shiva", sourceMaterial: "Shiva dances at dusk" },
    analysis: heuristicAnalyze({ title: "Shiva", topic: "Shiva dances at dusk", characters: "Shiva", locations: "Kailash" }),
    characters: [{ consistency_rules: ["keep face"] }],
    locations: [{ name: "Kailash" }],
    chapters: [{ sequences: [{ shots: [{ narration_lines: ["a"], flux_prompt: "img", ltx_prompt: "mot" }] }] }],
  };
  const snap = snapshotDocStages(board, 300);
  assert.equal(snap.length, 15);
  assert.deepEqual(snap.map((s) => s.key), DOC_ANALYSIS_STAGES);
  const byKey = Object.fromEntries(snap.map((s) => [s.key, s]));
  assert.ok(byKey.raw.done && byKey.understanding.done && byKey.shot.done);
  assert.ok(byKey.image.done && byKey.video.done && byKey.timeline.done);
  assert.equal(DOC_HISTORY_CAP, 10);
});

test("plan snapshots past runs and resets approvals; PUT accepts verdicts", () => {
  const server = read("frontend/server.mjs");
  assert.ok(server.includes("prevStages"), "previous execution snapshotted");
  assert.ok(server.includes("board.stage_history"), "history persisted");
  assert.ok(server.includes("DOC_HISTORY_CAP"), "history capped");
  assert.ok(server.includes("board.stage_approvals = {}"), "approvals reset on Plan");
  assert.ok(server.includes("normalizeDocStageApprovals(patch.stageApprovals)"), "PUT stores verdicts");
});

test("stage tabs run left-to-right with 20s idle auto-approve", () => {
  const page = read("frontend/src/components/DocumentaryPage.tsx");
  assert.ok(page.includes("STAGE_ORDER"), "stage order drives tabs");
  for (const k of DOC_ANALYSIS_STAGES) {
    assert.ok(page.includes(`"${k}"`), `tab for stage ${k}`);
  }
  assert.ok(page.includes("DocStagePanel"), "per-stage panel renders data + past runs");
  assert.ok(page.includes("stage_history"), "past executions shown");
  assert.ok(page.includes("APPROVE_IDLE_MS = 20000"), "20s idle window");
  assert.ok(page.includes("useQuietMs(APPROVE_IDLE_MS)"), "quiet clock drives countdown");
  assert.ok(page.includes("auto-approving in"), "countdown visible while armed");
  assert.ok(page.includes("stageApprovals"), "verdicts persist via docUpdate");
  const hook = read("frontend/src/components/useIdleFollow.ts");
  assert.ok(hook.includes("useQuietMs"), "quiet-ms hook exported");
});
