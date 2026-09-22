// Lyrics / narration text prep for song generation (scripts/generate_song.mjs).
//
// Two engines behind the Create Song tab:
//   - Song presets (kids-song, songs-for-kids, devotional-song) render SUNG via
//     ACE-Step 1.5 XL Turbo on ComfyUI. ACE-Step needs lyrics with [verse] /
//     [chorus] / [bridge] structure tags; markdown (**bold**), emojis and "..."
//     fillers tokenize into garbage and come back as mumbled / noisy vocals.
//   - Narration presets (kids-story-narration, devotional-narration) render
//     SPOKEN via Edge-TTS (the same Hindi voices as the dialogue pipeline).
//     A singing model can only sing prose — speech is what makes narration clean.
//
// Nothing here touches the network; generate_song.mjs does the synthesis.
import { HINDI_FEMALE, HINDI_MALE } from "./tts.mjs";

export const NARRATION_PRESETS = new Set([
  "kids-story-narration", "devotional-narration", "devotional-narration-music",
]);
export const isNarrationPreset = (id) => NARRATION_PRESETS.has(String(id || ""));

// Narration presets that lay the voice over a generated music bed
// (voice at full volume, instrumental bed ducked underneath).
export const MUSIC_BED_PRESETS = new Set(["devotional-narration-music"]);
export const isMusicBedNarration = (id) => MUSIC_BED_PRESETS.has(String(id || ""));

// Instrumental bed for the devotional narration mix (no vocals — the TTS
// voice carries the narration; lyrics "[Instrumental]" tells ACE-Step to
// render music only).
export const DEVOTIONAL_MUSIC_BED_TAGS =
  "Powerful devotional instrumental music, harmonium, tabla, tanpura drone, manjira, " +
  "orchestral strings swell, temple bells ambience, slow majestic pulse, sacred powerful " +
  "mood, cinematic reverb, no vocals, no speech";

const EN_FEMALE = "en-IN-NeerjaNeural";
const EN_MALE = "en-IN-PrabhatNeural";

/** Edge-TTS voice for a song vocal choice (+ paragraph index for duets). */
export function songVocalToTtsVoice(vocal, language, index = 0) {
  const v = vocal === "duet"
    ? (index % 2 === 0 ? "female" : "male")
    : vocal === "male" ? "male" : "female";
  const lang = String(language || "hi").toLowerCase();
  if (lang.startsWith("en")) return v === "male" ? EN_MALE : EN_FEMALE;
  return v === "male" ? HINDI_MALE : HINDI_FEMALE;
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu;

function stripMarkdown(s) {
  return String(s || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`{1,3}(.*?)`{1,3}/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "");
}

function normalizePunct(s) {
  return s
    .replace(/[“”«»„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/…/g, "...")
    .replace(/[—–]/g, "-");
}

// Standalone "..." filler lines sing as mumble — drop them; collapse runs.
function collapseEllipses(s) {
  return s.split("\n").map((line) => {
    if (/^(\.\s*){2,}$/.test(line.trim())) return "";
    return line.replace(/\.{4,}/g, "...");
  }).join("\n");
}

function dropJunkLines(s, keepBrackets) {
  const re = keepBrackets ? /[\p{L}\p{N}\[\]]/u : /[\p{L}\p{N}]/u;
  return s.split("\n").filter((line) => re.test(line)).join("\n");
}

function tidy(s) {
  return s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/^[ \n]+|[ \n]+$/g, "");
}

function capLines(s, maxChars, engine) {
  if (s.length <= maxChars) return s;
  const lines = s.split("\n");
  let out = "";
  for (const line of lines) {
    if ((out + "\n" + line).length > maxChars) break;
    out += (out ? "\n" : "") + line;
  }
  console.log(`[song] text over ${maxChars} chars — truncated to fit ${engine} (shorten the text for the full version).`);
  return out;
}

function baseClean(text, keepBrackets) {
  const noEmoji = String(text || "").replace(EMOJI_RE, "");
  const noMd = stripMarkdown(noEmoji);
  const punct = normalizePunct(noMd);
  const noEll = collapseEllipses(punct);
  return tidy(dropJunkLines(noEll, keepBrackets));
}

/**
 * Clean lyrics for ACE-Step singing: markdown/emoji/filler stripped, capped
 * at 3500 chars (lyrics over the model's lyric window get truncated anyway,
 * and the leftover duration fills with mumble).
 */
export function sanitizeLyrics(text) {
  return capLines(baseClean(text, true), 3500, "ACE-Step");
}

const HAS_TAGS_RE = /\[\s*(verse|chorus|bridge|hook|intro|outro|pre-?chorus|inst(rumental)?|song)\b[^\]]*\]/i;

/**
 * Lyrics with [verse]/[chorus]/[outro] structure tags, which ACE-Step requires
 * to place vocals. Text that already carries tags is left alone (just cleaned);
 * plain paragraphs are grouped into ≤8-line stanzas and tagged verse/chorus.
 */
export function structureLyrics(text) {
  const clean = sanitizeLyrics(text);
  if (HAS_TAGS_RE.test(clean) || !clean) return clean;
  const paras = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!paras.length) return clean;
  const chunks = [];
  for (let i = 0; i < paras.length; i += 8) chunks.push(paras.slice(i, i + 8));
  if (chunks.length === 1) return `[verse]\n${chunks[0].join("\n")}`;
  return chunks.map((c, i) => {
    const tag = i === 0 ? "verse"
      : i === chunks.length - 1 && chunks.length > 2 ? "outro"
      : i % 2 === 1 ? "chorus" : "verse";
    return `[${tag}]\n${c.join("\n")}`;
  }).join("\n\n");
}

/**
 * Plain speakable text for Edge-TTS narration: everything non-spoken removed
 * (markdown, emojis, [tags] — the voice must never read "[verse]" aloud).
 */
export function lyricsForSpeech(text) {
  const s = baseClean(text, false).replace(/\[[^\]\n]{0,40}\]/g, "");
  return capLines(tidy(s), 5000, "Edge-TTS");
}

/** Speech text split into one paragraph per TTS call. */
export function speechParagraphs(text) {
  return lyricsForSpeech(text).split("\n").map((l) => l.trim()).filter(Boolean);
}
