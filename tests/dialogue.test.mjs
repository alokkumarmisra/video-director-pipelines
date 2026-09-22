// Dialogue (voice + lip-sync) pipeline: Director dialogue schema,
// board -> scenario handoff, TTS voice casting and duration fitting.
// Pure unit tests (no network, no GPU, no edge-tts binary).
// Run: node --test tests/dialogue.test.mjs (from the repo root)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeScene,
  normalizeDialogue,
  buildScenesPrompt,
  boardToScenario,
} from "../lib/director.mjs";
import {
  voiceFor,
  dialogueWavFile,
  estimateDialogueDuration,
  prosodyFor,
  beatTargetDuration,
  HINDI_FEMALE,
  HINDI_MALE,
} from "../lib/tts.mjs";
import {
  planDialogueTiming,
  dialogueTotal,
  needsSegmentation,
  getTtsProvider,
  getLipSyncProvider,
  musetalkWorkflowReady,
  beatDialogueStatus,
  STAGE,
} from "../lib/dialogue_pipeline.mjs";

describe("normalizeDialogue", () => {
  it("keeps speaker + line, drops empty lines", () => {
    assert.deepEqual(
      normalizeDialogue([
        { speaker: "Chiku", line: "नमस्ते!" },
        { speaker: "shera", line: "  " },
        { line: "no speaker" },
        null,
      ]),
      [
        { speaker: "chiku", line: "नमस्ते!" },
        { speaker: "", line: "no speaker" },
      ]);
  });
  it("keeps per-line expression/emotion/pitch when the story gives them", () => {
    assert.deepEqual(
      normalizeDialogue([{ speaker: "Chiku", line: "Hi!", expression: "wide smile", emotion: "joyful", pitch: "HIGH" }]),
      [{ speaker: "chiku", line: "Hi!", expression: "wide smile", emotion: "joyful", pitch: "high" }]);
  });
  it("drops invalid pitch values instead of passing them to TTS", () => {
    assert.deepEqual(
      normalizeDialogue([{ speaker: "a", line: "Hi", pitch: "falsetto" }]),
      [{ speaker: "a", line: "Hi" }]);
  });
  it("tolerates non-arrays", () => {
    assert.deepEqual(normalizeDialogue(undefined), []);
    assert.deepEqual(normalizeDialogue("x"), []);
  });
});

describe("normalizeScene dialogue", () => {
  it("defaults to [] when absent", () => {
    assert.deepEqual(normalizeScene({}, 1, 3).dialogue, []);
  });
  it("normalizes dialogue entries", () => {
    const s = normalizeScene({ dialogue: [{ speaker: "SHERAJ", line: "Hi" }] }, 2, 4);
    assert.deepEqual(s.dialogue, [{ speaker: "sheraj", line: "Hi" }]);
  });
});

describe("buildScenesPrompt dialogue", () => {
  const input = { title: "T", genre: "Kids", visualStyle: "3D Cinematic", sceneSeconds: 4, language: "Hindi" };
  const bp = { characters: [], locations: [], objects: [] };
  it("asks for speakable dialogue + frontal staging", () => {
    const p = buildScenesPrompt({ input, blueprint: bp, beats: [], prevScene: null, startNumber: 1, count: 2, styleLock: "lock" });
    assert.match(p, /dialogue/);
    assert.match(p, /FRONT-FACING/);
    assert.match(p, /Hindi/);
  });
});

describe("boardToScenario dialogue handoff", () => {
  const board = {
    input: { title: "Rabbit and Lion", sceneSeconds: 4, visualStyle: "3D Cinematic", styleCustom: "" },
    blueprint: { characters: [], locations: [], objects: [] },
    scenes: [{
      title: "Talk", duration_seconds: 5, characters: [],
      image_prompt: "a rabbit", video_prompt: "talks",
      dialogue: [{ speaker: "chiku", line: "नमस्ते!" }],
    }],
  };
  it("carries dialogue + per-scene duration + tts block", () => {
    const cfg = boardToScenario(board);
    assert.deepEqual(cfg.sequence[0].dialogue, [{ speaker: "chiku", line: "नमस्ते!" }]);
    assert.equal(cfg.sequence[0].duration, 5);
    assert.ok(cfg.tts && typeof cfg.tts.voices === "object");
  });
});

describe("voiceFor casting", () => {
  it("auto-casts rabbit young/female, lion deep/male", () => {
    assert.equal(voiceFor("chiku", {}), HINDI_FEMALE);
    assert.equal(voiceFor("sheraj", {}), HINDI_MALE);
  });
  it("explicit scenario voices win", () => {
    assert.equal(voiceFor("chiku", { voices: { chiku: "en-IN-NeerjaNeural" } }), "en-IN-NeerjaNeural");
  });
  it("unknown speakers fall back to default", () => {
    assert.equal(voiceFor("narrator", {}), HINDI_FEMALE);
    assert.equal(voiceFor("narrator", { defaultVoice: HINDI_MALE }), HINDI_MALE);
  });
});

describe("dialogueWavFile", () => {
  it("is stable for runners + lip-sync", () => {
    assert.equal(dialogueWavFile("rabbit_and_lion", 9, "Talk Time"), "rabbit_and_lion_dlg9_talk_time.wav");
  });
});

describe("estimateDialogueDuration", () => {
  it("keeps short lines on the base floor", () => {
    assert.equal(estimateDialogueDuration([{ speaker: "a", line: "Hi!" }], { base: 3 }), 3);
  });
  it("grows lengthy dialogue well past the base", () => {
    const long = [{ speaker: "a", line: "Once upon a time in a deep dark forest, the little rabbit gathered all his courage and spoke slowly to the mighty lion about the coming storm" }];
    assert.ok(estimateDialogueDuration(long, { base: 3 }) > 8);
  });
  it("sad/low delivery estimates longer than happy/high for the same words", () => {
    const text = "I will go to the river bank tomorrow morning";
    const sad = estimateDialogueDuration([{ speaker: "a", line: text, emotion: "sad", pitch: "low" }], {});
    const happy = estimateDialogueDuration([{ speaker: "a", line: text, emotion: "joyful", pitch: "high" }], {});
    assert.ok(sad > happy);
  });
  it("returns the base when there is no dialogue", () => {
    assert.equal(estimateDialogueDuration([], { base: 4 }), 4);
  });
});

describe("prosodyFor", () => {
  it("slows and deepens sad lines", () => {
    assert.deepEqual(prosodyFor({ line: "x", emotion: "sad" }, ""), { rate: "-15%", pitch: "-8%" });
  });
  it("brightens happy/high lines", () => {
    const p = prosodyFor({ line: "x", expression: "big happy smile", pitch: "high" }, "");
    assert.equal(p.pitch, "+10%");
  });
  it("is neutral for plain lines", () => {
    assert.deepEqual(prosodyFor({ line: "Hello." }, ""), { rate: null, pitch: null });
  });
});

describe("beatTargetDuration dialogue estimate", () => {
  it("sizes the clip from text+delivery when no wav exists yet", () => {
    const long = "Once upon a time in a deep dark forest, the little rabbit gathered all his courage and spoke slowly to the mighty lion about the coming storm";
    const dur = beatTargetDuration({
      outDir: "/nonexistent_dir_xyz", prefix: "p", n: 1,
      beat: { title: "t", duration: 3, dialogue: [{ speaker: "a", line: long }] }, fallback: 3,
    });
    assert.ok(dur > 8);
  });
});

describe("planDialogueTiming", () => {
  const lines = [
    { speaker: "rabbit", line: "शेर जी, आप यहाँ क्यों आए हैं?" },
    { speaker: "lion", line: "मैं तुम्हारी मदद करने आया हूँ।" },
  ];
  it("derives sequential non-overlapping windows from actual durations", () => {
    const t = planDialogueTiming(lines, [2.3, 2.7]);
    assert.equal(t.length, 2);
    assert.equal(t[0].start, 0);
    assert.equal(t[0].end, 2.3);
    assert.ok(t[1].start >= t[0].end); // pause gap, never overlap
    assert.equal(t[1].end, Math.round((t[1].start + 2.7) * 100) / 100);
    assert.equal(dialogueTotal(t), t[1].end);
  });
  it("grows the total instead of cutting long dialogue", () => {
    const t = planDialogueTiming(lines, [10, 10]);
    assert.ok(dialogueTotal(t) > 5); // scene estimate was 5s — timing wins
  });
  it("tolerates missing durations as zero-length", () => {
    const t = planDialogueTiming(lines, []);
    assert.deepEqual([t[0].start, t[0].end], [0, 0]);
  });
});

describe("needsSegmentation", () => {
  it("is false for single-speaker beats", () => {
    assert.equal(needsSegmentation([{ speaker: "rabbit", line: "Hi" }]), false);
  });
  it("is true for multi-speaker beats", () => {
    assert.equal(needsSegmentation([
      { speaker: "rabbit", line: "A?" },
      { speaker: "lion", line: "B." },
    ]), true);
  });
  it("ignores empty lines", () => {
    assert.equal(needsSegmentation([
      { speaker: "rabbit", line: "Hi" },
      { speaker: "lion", line: "   " },
    ]), false);
  });
});

describe("provider selection", () => {
  it("defaults to edge-tts + wav2lip", () => {
    assert.equal(getTtsProvider().id, "edge-tts");
    assert.equal(getLipSyncProvider().id, "wav2lip");
  });
  it("rejects unknown providers instead of silently falling back", () => {
    assert.throws(() => getTtsProvider("nope"), /unknown TTS_PROVIDER/);
    assert.throws(() => getLipSyncProvider("nope"), /unknown LIPSYNC_PROVIDER/);
  });
  it("resolves the musetalk-comfy provider entry", () => {
    assert.equal(getLipSyncProvider("musetalk-comfy").id, "musetalk-comfy");
  });
});

describe("musetalkWorkflowReady", () => {
  it("is false for missing files, templates, and token-less workflows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "museready-"));
    try {
      assert.equal(musetalkWorkflowReady(path.join(dir, "nope.json")), false);
      const tpl = path.join(dir, "tpl.json");
      fs.writeFileSync(tpl, JSON.stringify({ template: true, requires_tokens: ["{{VIDEO}}", "{{AUDIO}}"] }));
      assert.equal(musetalkWorkflowReady(tpl), false);
      const bare = path.join(dir, "bare.json");
      fs.writeFileSync(bare, JSON.stringify({ nodes: [] }));
      assert.equal(musetalkWorkflowReady(bare), false);
      const real = path.join(dir, "real.json");
      fs.writeFileSync(real, JSON.stringify({ video: "{{VIDEO}}", audio: "{{AUDIO}}" }));
      assert.equal(musetalkWorkflowReady(real), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("beatDialogueStatus", () => {
  it("reports PENDING stages for a fresh dir", () => {
    const st = beatDialogueStatus({
      outDir: "/nonexistent_dir_xyz", prefix: "p", n: 1, title: "t",
      dialogue: [{ speaker: "rabbit", line: "Hi" }],
    });
    assert.equal(st.hasDialogue, true);
    assert.deepEqual(st.speakers, ["rabbit"]);
    assert.equal(st.segmented, false);
    assert.equal(st.voice, STAGE.PENDING);
    assert.equal(st.video, STAGE.PENDING);
    assert.equal(st.lipsync, STAGE.PENDING);
  });
  it("flags multi-speaker beats as segmented", () => {
    const st = beatDialogueStatus({
      outDir: "/nonexistent_dir_xyz", prefix: "p", n: 1, title: "t",
      dialogue: [
        { speaker: "rabbit", line: "A?" },
        { speaker: "lion", line: "B." },
      ],
    });
    assert.equal(st.segmented, true);
    assert.deepEqual(st.speakers, ["rabbit", "lion"]);
  });
});
