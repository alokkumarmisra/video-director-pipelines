// SONG GENERATION: lyrics -> full song.
// Generic: any prompts/<scenario>.json carrying an `audio` block:
//   { "audio": { "tags": "<style>", "lyrics": "...", "duration": 120,
//                "bpm": 95, "language": "en", "keyscale": "E minor",
//                "seed": 0, "steps": 8, "songPreset": "kids-song",
//                "songVocal": "female" } }
//
// Two engines (see lib/songtext.mjs):
//   - Song presets render SUNG via the selected audio model (ComfyUI):
//     ACE-Step 1.5 XL Turbo (workflows/Audio/audio_ace_step1_5_xl_turbo.json)
//     or MiniMax Music 3 (workflows/Audio/audio_minimax_music_3.json).
//     Lyrics are auto-sanitized (markdown/emoji/"..." stripped) and given
//     [verse]/[chorus] structure tags — raw pasted text without this comes
//     back as mumble/noise.
//   - Narration presets (kids-story-narration, devotional-narration) render
//     SPOKEN via Edge-TTS (same Hindi voices as the dialogue pipeline); the
//     Vocal dropdown picks the narrator (duet alternates voices per paragraph).
//
// The model is chosen in the Create Song tab (audio.songModel, "ace-step" |
// "minimax"); --song-model <id> overrides it from the CLI.
//
// Outputs (versioned, never overwritten):
//   outputs/<folder>/<prefix>_song.mp3      (v1)
//   outputs/<folder>/<prefix>_song_vN.mp3    (v2+)
// Emits one `[asset] {...}` line per finished song so the frontend RunPanel
// and the projects catalog pick it up live.
//
// Usage:
//   node scripts/generate_song.mjs [folder] [--config-name <displayName>] [--song-model ace-step|minimax]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { buildAceSongGraph, buildMinimaxSongGraph, normalizeSongModel, run, download, firstAudioUrl } from "../lib/comfy.mjs";
import { audioDuration } from "../lib/tts.mjs";
import {
  isNarrationPreset, isMusicBedNarration, DEVOTIONAL_MUSIC_BED_TAGS,
  structureLyrics, speechParagraphs, songVocalToTtsVoice,
} from "../lib/songtext.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--")) || "my_song";
const cfgNameIdx = args.indexOf("--config-name");
const cfgName = cfgNameIdx >= 0 && args[cfgNameIdx + 1] ? args[cfgNameIdx + 1] : folder;
const modelIdx = args.indexOf("--song-model");
const modelFlag = modelIdx >= 0 && args[modelIdx + 1] ? args[modelIdx + 1] : null;

const cfgPath = path.join(here, `../prompts/${cfgName}.json`);
if (!fs.existsSync(cfgPath)) {
  console.error(`[song] no prompts/${cfgName}.json — save the song project from the Create Song tab first.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const audio = cfg.audio && typeof cfg.audio === "object" ? cfg.audio : null;
if (!audio || !String(audio.lyrics || "").trim()) {
  console.error(`[song] prompts/${cfgName}.json has no audio.lyrics — nothing to sing.`);
  process.exit(1);
}

const outDir = path.resolve(here, `../outputs/${folder}`);
fs.mkdirSync(outDir, { recursive: true });
const prefix = String(folder);
// Audio model for sung takes (and only those — narration is Edge-TTS):
// saved choice wins, --song-model overrides it from the CLI.
const songModel = normalizeSongModel(modelFlag ?? audio.songModel);
const isMinimax = songModel === "minimax";

// Versioned song filenames: <prefix>_song.mp3 (v1), <prefix>_song_vN.mp3.
function songVersions() {
  if (!fs.existsSync(outDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith(".mp3")) continue;
    const stem = f.slice(0, -".mp3".length);
    if (stem === `${prefix}_song`) out.push({ file: f, v: 1 });
    else {
      const m = stem.match(new RegExp(`^${prefix}_song_v(\\d+)$`));
      if (m) out.push({ file: f, v: Number(m[1]) });
    }
  }
  return out.sort((a, b) => a.v - b.v);
}

const v = songVersions().length ? songVersions()[songVersions().length - 1].v + 1 : 1;
const dest = path.join(outDir, v === 1 ? `${prefix}_song.mp3` : `${prefix}_song_v${v}.mp3`);
const tag = `[song:${folder}]`;

function finishOk() {
  const file = path.basename(dest);
  console.log(`${tag} saved ${file}`);
  console.log(`[asset] ${JSON.stringify({ kind: "audio", file, stage: "song", index: v })}`);
}

function fail(msg) {
  console.error(`${tag} failed: ${msg}`);
  process.exit(1);
}

// --- Narration presets: spoken via Edge-TTS (clean speech, never sung) ---
// "Devotional Narration with Music" additionally lays the voice over a
// powerful ACE-Step instrumental bed (voice full volume, bed ducked).
if (isNarrationPreset(audio.songPreset)) {
  const vocal = audio.songVocal === "male" ? "male" : audio.songVocal === "duet" ? "duet" : "female";
  const lang = String(audio.language || "hi");
  const withMusic = isMusicBedNarration(audio.songPreset);
  const paras = speechParagraphs(String(audio.lyrics || ""));
  if (!paras.length) fail("no speakable text after cleanup — check the lyrics.");
  console.log(`${tag} narrating v${v} (${paras.length} paragraphs, ${vocal} voice, ${lang}) via Edge-TTS...`);
  // Voice-only track lands here; the music-bed variant mixes it into `dest`.
  const voiceMp3 = withMusic ? path.join(outDir, `${prefix}_song_v${v}_voice.mp3`) : dest;
  const parts = [];
  try {
    paras.forEach((p, i) => {
      const voice = songVocalToTtsVoice(vocal, lang, i);
      const part = path.join(outDir, `${prefix}_song_v${v}_p${i}.mp3`);
      console.log(`${tag}   para ${i + 1}/${paras.length} (${voice}): ${p.slice(0, 80)}`);
      const r = spawnSync("edge-tts",
        ["--voice", voice, "--text", p, "--write-media", part],
        { encoding: "utf8" });
      if (r.status !== 0 || !fs.existsSync(part)) {
        throw new Error(`edge-tts failed (para ${i + 1}, ${voice}): ${(r.stderr || r.error?.message || "no output — is edge-tts installed and online?").slice(0, 200)}`);
      }
      parts.push(part);
    });
    // Join paragraphs with a short pause, then encode the voice track.
    const silence = path.join(outDir, `${prefix}_song_v${v}_sil.mp3`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi",
      "-i", "anullsrc=r=24000:cl=mono", "-t", "0.4", "-acodec", "libmp3lame", silence]);
    const list = path.join(outDir, `${prefix}_song_v${v}_list.txt`);
    const entries = [];
    parts.forEach((p, i) => {
      entries.push(`file '${path.basename(p)}'`);
      if (i < parts.length - 1) entries.push(`file '${path.basename(silence)}'`);
    });
    fs.writeFileSync(list, entries.join("\n") + "\n");
    const mixed = path.join(outDir, `${prefix}_song_v${v}_mix.mp3`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
      "-i", list, "-c", "copy", mixed]);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", mixed,
      "-acodec", "libmp3lame", "-q:a", "2", voiceMp3]);
    for (const f of [...parts, silence, list, mixed]) {
      try { fs.unlinkSync(f); } catch { /* best-effort */ }
    }
    if (withMusic) {
      // Instrumental bed sized to the narration, then voice-over mix. The bed
      // always renders on ACE-Step (proven instrumental template) regardless
      // of the selected sung-take model — the voice is the star here.
      const voiceDur = audioDuration(voiceMp3);
      if (!(voiceDur > 0)) throw new Error("voice track unreadable — cannot size the music bed.");
      const bedDur = Math.min(300, Math.max(15, Math.ceil(voiceDur) + 5));
      console.log(`${tag} music bed (${bedDur}s devotional instrumental via ACE-Step)...`);
      const bedGraph = buildAceSongGraph({
        tags: DEVOTIONAL_MUSIC_BED_TAGS,
        lyrics: "[Instrumental]",
        duration: bedDur,
        bpm: Number.isFinite(Number(audio.bpm)) ? Number(audio.bpm) : 72,
        seed: Number.isFinite(Number(audio.seed)) ? Number(audio.seed) : 0,
        steps: 8,
        timesignature: "4",
        language: lang,
        keyscale: String(audio.keyscale || "E minor"),
        prefix: `${folder}/songbed`,
      });
      const bedEntry = await run(bedGraph, `${tag} ace-step-bed`);
      const bedMp3 = path.join(outDir, `${prefix}_song_v${v}_bed.mp3`);
      await download(firstAudioUrl(bedEntry), bedMp3);
      execFileSync("ffmpeg", ["-y", "-v", "error",
        "-i", voiceMp3, "-i", bedMp3,
        "-filter_complex", "[1:a]volume=0.22[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0",
        "-acodec", "libmp3lame", "-q:a", "2", dest]);
      for (const f of [voiceMp3, bedMp3]) {
        try { fs.unlinkSync(f); } catch { /* best-effort */ }
      }
    }
  } catch (e) {
    for (const f of parts) { try { fs.unlinkSync(f); } catch { /* keep going */ } }
    fail(e.message);
  }
  finishOk();
  process.exit(0);
}

// --- Song presets: sung via the selected audio model (ComfyUI) ---
// Raw pasted lyrics carry markdown/emoji/fillers that tokenize into garbage,
// so they are sanitized + structured first (lib/songtext.mjs).
const lyrics = structureLyrics(String(audio.lyrics || ""));
if (!lyrics.trim()) fail("no singable lyrics after cleanup — check the lyrics.");

const duration = Number.isFinite(Number(audio.duration)) ? Number(audio.duration) : 120;
const bpm = Number.isFinite(Number(audio.bpm)) ? Number(audio.bpm) : 95;
const seed = Number.isFinite(Number(audio.seed)) ? Number(audio.seed) : 0;
const steps = Number.isFinite(Number(audio.steps)) ? Number(audio.steps) : (isMinimax ? 30 : 8);

console.log(`${tag} generating v${v} (${duration}s @ ${bpm}bpm, seed ${seed}) via ${isMinimax ? "MiniMax Music 3" : "ACE-Step 1.5 XL Turbo"}...`);
const graph = isMinimax
  ? buildMinimaxSongGraph({
      caption: String(audio.tags || ""),
      lyrics,
      duration,
      seed,
      steps,
      cfg: 1.7,
      cfgScale: Number.isFinite(Number(audio.cfgScale)) ? Number(audio.cfgScale) : 1.7,
      topK: Number.isFinite(Number(audio.topK)) && Number(audio.topK) > 0 ? Number(audio.topK) : 50,
      prefix: `${folder}/song`,
    })
  : buildAceSongGraph({
      tags: String(audio.tags || ""),
      lyrics,
      duration,
      bpm,
      seed,
      steps,
      timesignature: String(audio.timesignature || "4"),
      language: String(audio.language || "en"),
      keyscale: String(audio.keyscale || "E minor"),
      cfgScale: Number.isFinite(Number(audio.cfgScale)) ? Number(audio.cfgScale) : 2,
      temperature: Number.isFinite(Number(audio.temperature)) ? Number(audio.temperature) : 0.85,
      topP: Number.isFinite(Number(audio.topP)) ? Number(audio.topP) : 0.9,
      topK: Number.isFinite(Number(audio.topK)) ? Number(audio.topK) : 0,
      minP: Number.isFinite(Number(audio.minP)) ? Number(audio.minP) : 0,
      prefix: `${folder}/song`,
    });

try {
  const entry = await run(graph, `${tag} ${isMinimax ? "minimax" : "ace-step"}`);
  await download(firstAudioUrl(entry), dest);
  finishOk();
} catch (e) {
  fail(e.message);
}
