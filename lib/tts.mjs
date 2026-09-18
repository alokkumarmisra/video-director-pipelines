// Character dialogue TTS via Edge-TTS (free, local CLI, no API key).
// Hindi voices: hi-IN-SwaraNeural (female — default for small characters
// like Chiku the rabbit), hi-IN-MadhurNeural (male — e.g. Shera the lion).
// English fallback: en-IN-NeerjaNeural / en-IN-PrabhatNeural.
//
// Config shape (scenario JSON, optional):
//   { "tts": { "defaultVoice": "hi-IN-SwaraNeural",
//              "voices": { "chiku": "hi-IN-SwaraNeural", "sheraj": "hi-IN-MadhurNeural" } },
//     "sequence": [ { "title", "image", "motion", "duration?",
//                     "dialogue": [ { "speaker": "chiku", "line": "..." } ] } ] }
//
// One beat -> one wav (lines concatenated with a short pause), cached on
// disk (resumable: existing wav is kept). Emits [asset] JSON lines so the
// frontend run log surfaces voice generation like every other asset.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileSlug } from "./variant.mjs";

export const HINDI_FEMALE = "hi-IN-SwaraNeural";
export const HINDI_MALE = "hi-IN-MadhurNeural";
export const DEFAULT_VOICE = HINDI_FEMALE;

// Default voice casting by character id when the scenario has no explicit
// tts.voices map: the rabbit Chiku reads young/female, the lion deep/male.
// Unknown ids fall back to the default voice (never crash on new casts).
const CAST_DEFAULTS = [
  [/chiku|rabbit|bunny|minku|mouse|bird|girl|princess|mother|rani|sita/i, HINDI_FEMALE],
  [/sher| lion|raja|king|father|hanuman|ram |elephant|hathi/i, HINDI_MALE],
];

export function voiceFor(speaker, ttsCfg) {
  const tts = ttsCfg && typeof ttsCfg === "object" ? ttsCfg : {};
  const voices = voicesOf(tts);
  const key = String(speaker || "").toLowerCase();
  if (voices[key]) return voices[key];
  for (const [re, voice] of CAST_DEFAULTS) {
    if (re.test(key)) return voice;
  }
  return tts.defaultVoice || DEFAULT_VOICE;
}

function voicesOf(tts) {
  const out = {};
  const v = tts && typeof tts.voices === "object" ? tts.voices : {};
  for (const [k, val] of Object.entries(v)) out[String(k).toLowerCase()] = String(val);
  return out;
}

/** ffprobe duration in seconds (0 when unreadable). */
export function audioDuration(file) {
  try {
    const out = execFileSync("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" }).trim();
    const d = Number(out);
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch { return 0; }
}

function runEdgeTts(voice, text, mp3Path) {
  const r = spawnSync("edge-tts",
    ["--voice", voice, "--text", text, "--write-media", mp3Path],
    { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(mp3Path)) {
    throw new Error(`edge-tts failed for voice ${voice}: ${(r.stderr || r.error?.message || "").slice(0, 300)}`);
  }
}

function toWav(mp3Path, wavPath) {
  // Wav2Lip-friendly: 16kHz mono PCM.
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", mp3Path,
    "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", wavPath],
    { stdio: "inherit" });
}

/** dialogue wav filename for beat n (shared by runners + lip-sync). */
export function dialogueWavFile(prefix, n, title) {
  return `${prefix}_dlg${n}_${fileSlug(title)}.wav`;
}

/**
 * Clip length for a beat: the configured duration, grown to fit the spoken
 * dialogue (+0.5s breathing room) when its wav already exists. This is what
 * makes the video length depend on the dialogue length.
 */
export function beatTargetDuration({ outDir, prefix, n, beat, fallback = 3 }) {
  const d = Number(beat?.duration);
  const base = Number.isFinite(d) && d > 0 ? d : fallback;
  try {
    const wav = path.join(outDir, dialogueWavFile(prefix, n, beat?.title));
    if (fs.existsSync(wav)) {
      const ad = audioDuration(wav);
      if (ad > 0) return Math.max(base, Math.ceil((ad + 0.5) * 10) / 10);
    }
  } catch { /* fall back to configured */ }
  return base;
}

/**
 * Synthesize one beat's dialogue to `<prefix>_dlg<n>_<slug>.wav`.
 * Resumable: an existing wav is kept (delete it to re-voice).
 * @returns {{ file: string|null, duration: number }} (null when no dialogue)
 */
export function genBeatAudio({ outDir, prefix, n, title, dialogue, ttsCfg, tag = "[tts]" }) {
  const lines = Array.isArray(dialogue) ? dialogue.filter((d) => d && String(d.line || "").trim()) : [];
  if (!lines.length) return { file: null, duration: 0 };
  const slug = fileSlug(title);
  const wavBase = dialogueWavFile(prefix, n, title);
  const wavPath = path.join(outDir, wavBase);
  if (fs.existsSync(wavPath)) {
    const d = audioDuration(wavPath);
    console.log(`${tag} beat ${n} dialogue audio — exists, skipping (${d.toFixed(1)}s)`);
    console.log(`[asset] ${JSON.stringify({ kind: "audio", file: wavBase, stage: "dialogue", index: n })}`);
    return { file: wavBase, duration: d };
  }
  console.log(`${tag} beat ${n} dialogue (${lines.length} line${lines.length === 1 ? "" : "s"})...`);
  const tmpParts = [];
  try {
    lines.forEach((d, i) => {
      const voice = voiceFor(d.speaker, ttsCfg);
      const part = path.join(outDir, `${prefix}_dlg${n}_${slug}_p${i}.mp3`);
      console.log(`${tag}   ${d.speaker || "voice"} (${voice}): ${String(d.line).slice(0, 80)}`);
      runEdgeTts(voice, String(d.line), part);
      tmpParts.push(part);
    });
    // Stitch parts with a 0.35s pause between speakers (silence file).
    const silence = path.join(outDir, `${prefix}_dlg${n}_${slug}_sil.mp3`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi",
      "-i", "anullsrc=r=24000:cl=mono", "-t", "0.35", "-acodec", "libmp3lame", silence]);
    const list = path.join(outDir, `${prefix}_dlg${n}_${slug}_list.txt`);
    const entries = [];
    tmpParts.forEach((p, i) => {
      entries.push(`file '${path.basename(p)}'`);
      if (i < tmpParts.length - 1) entries.push(`file '${path.basename(silence)}'`);
    });
    fs.writeFileSync(list, entries.join("\n") + "\n");
    const mixed = path.join(outDir, `${prefix}_dlg${n}_${slug}_mix.mp3`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
      "-i", list, "-c", "copy", mixed]);
    toWav(mixed, wavPath);
    for (const f of [...tmpParts, silence, list, mixed]) {
      try { fs.unlinkSync(f); } catch { /* best-effort */ }
    }
  } catch (e) {
    for (const f of tmpParts) { try { fs.unlinkSync(f); } catch { /* keep going */ } }
    throw e;
  }
  const d = audioDuration(wavPath);
  console.log(`${tag} beat ${n} dialogue audio -> ${wavBase} (${d.toFixed(1)}s)`);
  console.log(`[asset] ${JSON.stringify({ kind: "audio", file: wavBase, stage: "dialogue", index: n })}`);
  return { file: wavBase, duration: d };
}
