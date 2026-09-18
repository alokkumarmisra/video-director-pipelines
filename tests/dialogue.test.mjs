// Dialogue (voice + lip-sync) pipeline: Director dialogue schema,
// board -> scenario handoff, TTS voice casting and duration fitting.
// Pure unit tests (no network, no GPU, no edge-tts binary).
// Run: node --test tests/dialogue.test.mjs (from the repo root)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeScene,
  normalizeDialogue,
  buildScenesPrompt,
  boardToScenario,
} from "../lib/director.mjs";
import {
  voiceFor,
  dialogueWavFile,
  HINDI_FEMALE,
  HINDI_MALE,
} from "../lib/tts.mjs";

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
