// Song presets for the Create Song tab (sung via the selected audio model —
// ACE-Step 1.5 XL Turbo or MiniMax Music 3).
// Each preset maps one user-facing mode to the full set of generation values
// that the workflow exposes via TextEncodeAceStepAudio1.5 + KSampler:
//   tags (style), bpm, keyscale, timesignature, language, steps,
//   cfgScale, temperature, topP (+ topK/minP fixed at 0).
// The UI shows only the mode + vocal dropdowns and lyrics; everything else is
// applied internally. Duration is dynamic — estimated from the lyrics
// (heuristic here, AI-refined via POST /api/song-estimate when the LLM is up).
//
// Time Sig / Seed / Steps are NOT user inputs: every mode here is 4/4, the
// seed stays fixed for reproducible takes, and steps are tuned per mode (the
// turbo model only needs 8-12). The Vocal dropdown picks the singer/narrator
// voice — song modes sing it, narration modes speak it.

export type VocalId = "female" | "male" | "duet";

export const VOCAL_OPTIONS: { id: VocalId; name: string }[] = [
  { id: "female", name: "Female" },
  { id: "male", name: "Male" },
  { id: "duet", name: "Both (Duet)" },
];

// Audio models for sung takes (Create Song tab dropdown). Workflows live in
// workflows/Audio/; the queueable graphs are built in code in lib/comfy.mjs
// (buildAceSongGraph / buildMinimaxSongGraph) — the JSONs are the never-queued
// UI reference. Narration presets ignore this (Edge-TTS voices).
export type AudioModelId = "ace-step" | "minimax";

export const AUDIO_MODELS: { id: AudioModelId; name: string; hint: string }[] = [
  {
    id: "ace-step",
    name: "ACE-Step 1.5 XL Turbo",
    hint: "Fast sung takes. Uses style + BPM/key/language, up to ~16 min.",
  },
  {
    id: "minimax",
    name: "MiniMax Music 3",
    hint: "Structured full songs up to 6 min. Uses style + lyrics + duration — BPM/key are ignored.",
  },
];

export const isAudioModelId = (v: unknown): v is AudioModelId =>
  v === "ace-step" || v === "minimax";

export const audioModelById = (id: string): { id: AudioModelId; name: string; hint: string } =>
  AUDIO_MODELS.find((m) => m.id === id) ?? AUDIO_MODELS[0];

export interface SongPreset {
  id: string;
  name: string;
  /** One-line hint shown under the dropdown. */
  hint: string;
  /** Style/instruments only — no voice description (voice comes from `vocals`). */
  tagsBase: string;
  /** Singer/narrator descriptor per vocal choice. True for narration modes. */
  vocals: Record<VocalId, string>;
  defaultVocal: VocalId;
  /** True = the voice narrates/speaks; false = the voice sings. */
  narration: boolean;
  bpm: number;
  keyscale: string;
  timesignature: string;
  language: string;
  steps: number;
  cfgScale: number;
  temperature: number;
  topP: number;
  /** Sung/spoken words per minute used by the duration estimator. */
  wpm: number;
  /** Extra head/tail seconds (intro + outro) added by the estimator. */
  paddingSec: number;
}

export const SONG_PRESETS: SongPreset[] = [
  {
    id: "kids-song",
    name: "Kids Song",
    hint: "Cheerful sing-along for toddlers — bright melody, xylophone & claps.",
    tagsBase:
      "Cheerful Hindi kids song, playful 3D cartoon feeling, bright happy melody, xylophone, ukulele, glockenspiel, soft piano, hand claps, light percussion, bells, simple repetitive catchy chorus, clear pronunciation, joyful wholesome family-friendly production, no scary sounds, no heavy bass",
    vocals: {
      female: "cute female lead vocal singing with playful children's chorus responses",
      male: "warm male lead vocal singing with playful children's chorus responses",
      duet: "male-female duet vocals singing with playful children's chorus responses",
    },
    defaultVocal: "female",
    narration: false,
    bpm: 112,
    keyscale: "C major",
    timesignature: "4",
    language: "hi",
    steps: 10,
    cfgScale: 2.5,
    temperature: 0.85,
    topP: 0.9,
    wpm: 100,
    paddingSec: 12,
  },
  {
    id: "songs-for-kids",
    name: "Songs for Kids (Learning / Rhyme)",
    hint: "Educational rhyme — counting, ABC, good habits. Call-and-response, slow clear diction.",
    tagsBase:
      "Hindi-English preschool educational children's song, bright playful classroom atmosphere, catchy kindergarten learning song, happy child-friendly melody, cute xylophone, marimba, glockenspiel, ukulele, soft piano, gentle hand claps, playful bells, light percussion, clear slow pronunciation, call-and-response moments, simple repetitive melody, interactive learning feeling, clean modern kids YouTube music production, wholesome and positive",
    vocals: {
      female: "warm friendly female vocal singing for children",
      male: "warm friendly male vocal singing for children",
      duet: "male-female duet vocals singing for children",
    },
    defaultVocal: "female",
    narration: false,
    bpm: 105,
    keyscale: "C major",
    timesignature: "4",
    language: "hi",
    steps: 10,
    cfgScale: 2.5,
    temperature: 0.8,
    topP: 0.9,
    wpm: 110,
    paddingSec: 10,
  },
  {
    id: "kids-story-narration",
    name: "Kids Story Narration",
    hint: "Bedtime storytelling — spoken aloud by the AI narrator (clean speech, not sung).",
    tagsBase:
      "Gentle Hindi story narration with soft background music, slow clear expressive speech-like delivery with light melodic phrasing, soft piano and strings bed, minimal percussion, calm bedtime story atmosphere, clear pronunciation for children, no drums, no loud chorus",
    vocals: {
      female: "warm friendly female narrator voice telling a story",
      male: "warm friendly male narrator voice telling a story",
      duet: "male-female dual narration telling a story with alternating voices",
    },
    defaultVocal: "female",
    narration: true,
    bpm: 88,
    keyscale: "G major",
    timesignature: "4",
    language: "hi",
    steps: 8,
    cfgScale: 2,
    temperature: 0.7,
    topP: 0.9,
    wpm: 135,
    paddingSec: 6,
  },
  {
    id: "devotional-song",
    name: "Devotional Song (Bhajan)",
    hint: "Traditional bhajan — harmonium, tabla, tanpura, temple atmosphere.",
    tagsBase:
      "Traditional Hindi devotional bhajan, harmonium, tabla, tanpura drone, manjira, soft strings, temple bells ambience, slow devotional pulse, large emotional final chorus, clean spiritual production, sacred peaceful mood",
    vocals: {
      female: "reverent heartfelt female vocal singing a bhajan",
      male: "reverent heartfelt male vocal singing a bhajan",
      duet: "reverent heartfelt male-female duet singing a bhajan",
    },
    defaultVocal: "duet",
    narration: false,
    bpm: 84,
    keyscale: "D major",
    timesignature: "4",
    language: "hi",
    steps: 12,
    cfgScale: 3,
    temperature: 0.8,
    topP: 0.9,
    wpm: 90,
    paddingSec: 14,
  },
  {
    id: "devotional-narration",
    name: "Devotional Narration Only",
    hint: "Majestic katha / stotra narration — spoken by the AI narrator, voice only (clean speech, not sung).",
    tagsBase:
      "Powerful Hindi devotional narration, slow majestic pace, clear Sanskrit-Hindi pronunciation, wide cinematic temple reverb, harmonium tanpura drone, soft tabla, orchestral strings swell in the chorus, sacred powerful mood, no pop drums",
    vocals: {
      female: "deep resonant female voice narrating with commanding sacred presence",
      male: "deep resonant male voice narrating with commanding sacred presence",
      duet: "male-female dual narration with commanding sacred presence and alternating voices",
    },
    defaultVocal: "male",
    narration: true,
    bpm: 72,
    keyscale: "E minor",
    timesignature: "4",
    language: "hi",
    steps: 12,
    cfgScale: 3,
    temperature: 0.75,
    topP: 0.9,
    wpm: 120,
    paddingSec: 10,
  },
  {
    id: "devotional-narration-music",
    name: "Devotional Narration with Music",
    hint: "Spoken katha / stotra over a powerful devotional music bed (voice mixed above harmonium + tabla).",
    tagsBase:
      "Powerful Hindi devotional narration, slow majestic pace, clear Sanskrit-Hindi pronunciation, wide cinematic temple reverb, harmonium tanpura drone, soft tabla, orchestral strings swell in the chorus, sacred powerful mood, no pop drums",
    vocals: {
      female: "deep resonant female voice narrating with commanding sacred presence",
      male: "deep resonant male voice narrating with commanding sacred presence",
      duet: "male-female dual narration with commanding sacred presence and alternating voices",
    },
    defaultVocal: "male",
    narration: true,
    bpm: 72,
    keyscale: "E minor",
    timesignature: "4",
    language: "hi",
    steps: 12,
    cfgScale: 3,
    temperature: 0.75,
    topP: 0.9,
    wpm: 120,
    paddingSec: 10,
  },
];

export const songPresetById = (id: string | null | undefined): SongPreset =>
  SONG_PRESETS.find((p) => p.id === id) ?? SONG_PRESETS[0];

export const isVocalId = (v: unknown): v is VocalId =>
  v === "female" || v === "male" || v === "duet";

/** Full style tags for a preset + vocal (voice first — ACE-Step weighs early tokens most). */
export function buildPresetTags(preset: SongPreset, vocal: VocalId): string {
  return `${preset.vocals[vocal]}, ${preset.tagsBase}`;
}

// Every voice phrase this UI (or its predecessor revision) ever baked into
// tags — stripped before a newly picked vocal is prepended, so switching
// Female -> Male never leaves two conflicting voice instructions behind.
// User hand-edits to the style portion are preserved.
const KNOWN_VOCAL_PHRASES = [
  ...SONG_PRESETS.flatMap((p) => Object.values(p.vocals)),
  // Legacy phrases from the pre-vocal revision (old saved projects).
  "cute female lead vocal with playful children's chorus responses",
  "warm friendly female vocals",
  "warm friendly female storyteller voice, slow clear expressive speech-like delivery with light melodic phrasing",
  "warm friendly female storyteller voice",
  "reverent heartfelt male-female duet",
  "deep resonant male voice with commanding sacred presence",
];

export function stripVocalPhrases(tags: string): string {
  let out = ` ${String(tags || "")} `;
  for (const phrase of KNOWN_VOCAL_PHRASES) {
    if (!phrase) continue;
    out = out.split(phrase).join(" ");
  }
  return out
    .replace(/[,\s]+,[,\s]+/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "");
}

/** Tags with the picked vocal applied (voice instruction first). */
export function applyVocalToTags(tags: string, presetId: string, vocal: VocalId): string {
  const base = stripVocalPhrases(tags);
  const voice = songPresetById(presetId).vocals[vocal];
  return base ? `${voice}, ${base}` : voice;
}

// Heuristic duration estimator (client + server fallback share this shape):
// words sung at wpm + per-line breathing + per-section arrangement + padding,
// clamped to the ACE-Step practical range and rounded to 5s.
export function estimateSongDurationLocal(lyrics: string, presetId?: string): number {
  const p = songPresetById(presetId);
  const text = String(lyrics || "");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).length;
  const sections = (text.match(/(मुखड़ा|अंतरा|कोरस|ब्रिज|pre-chorus|chorus|verse|antara|bridge|shloka|doha|मुखडा)/gi) || []).length;
  if (!words) return 120;
  const raw = p.paddingSec + (words * 60) / p.wpm + lines * 0.8 + sections * 4;
  const clamped = Math.min(300, Math.max(30, raw));
  return Math.round(clamped / 5) * 5;
}
