// DIALOGUE LIP-SYNC: voice each beat's dialogue (Edge-TTS, per-character
// Hindi voices) then lip-sync the beat's clip to it (local Easy-Wav2Lip).
//
// The clip length always fits the dialogue: fresh clips are generated AT the
// voice length (character_sequence.mjs reads the wav via beatTargetDuration),
// and here any shorter existing clip is looped (stream-copy, codec unchanged)
// up to the audio length before Wav2Lip. The synced take becomes a new clip
// version + clip main, then the final cut is re-stitched (voices included —
/// Wav2Lip muxes the dialogue audio into its output).
//
// Scenario JSON shape (see boardToScenario in lib/director.mjs):
//   { "tts": { "defaultVoice": "...", "voices": { "<character>": "<voice>" } },
//     "sequence": [ { "title", "image", "motion", "duration?",
//                     "dialogue": [ { "speaker", "line" } ] } ] }
//
// Usage:
//   node scripts/dialogue_lipsync.mjs [scenario]            # all dialogue beats
//   node scripts/dialogue_lipsync.mjs [scenario] --beats 9,11
//   node scripts/dialogue_lipsync.mjs [scenario] --vertical # 9:16 Reel cut
//   node scripts/dialogue_lipsync.mjs [scenario] --wan      # Wan engine cut
//   node scripts/dialogue_lipsync.mjs [scenario] --skip-tts     # wavs exist, only lip-sync
//   node scripts/dialogue_lipsync.mjs [scenario] --skip-lipsync # only generate voice audio
//   node scripts/dialogue_lipsync.mjs [scenario] --no-stitch    # voice+sync clips
//     but do NOT rebuild the final cut (check each clip first, merge later
//     with Stitch). Per-scene runs from the Story Board use this so one scene
//     can be reviewed before merging.
//   (combines with --config-name <displayName> like the other runners)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { outDirName, prefixForDir, normalizeFormat, VERTICAL } from "../lib/variant.mjs";
import { loadState, resolveMain } from "../lib/sequence_state.mjs";
import { stitchSequence } from "../lib/sequence.mjs";
import { genBeatAudio } from "../lib/tts.mjs";
import { lipSyncBeat } from "../lib/lipsync.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith("--")) || "anime_sequence";
const cfgNameIdx = args.indexOf("--config-name");
const cfgName = cfgNameIdx >= 0 && args[cfgNameIdx + 1] ? args[cfgNameIdx + 1] : scenario;
const format = normalizeFormat(args.includes("--vertical") ? VERTICAL : "landscape");
const engine = args.includes("--wan") ? "wan" : "ltx";
const skipTts = args.includes("--skip-tts");
const skipLip = args.includes("--skip-lipsync");
const noStitch = args.includes("--no-stitch");
const beatsIdx = args.indexOf("--beats");
const onlyBeats = beatsIdx >= 0 && args[beatsIdx + 1]
  ? new Set(args[beatsIdx + 1].split(",").map((x) => Number(x)).filter((x) => x > 0))
  : null;

const cfgPath = path.join(here, `../prompts/${cfgName}.json`);
if (!fs.existsSync(cfgPath)) {
  console.error(`[dialogue] no prompts/${cfgName}.json`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const outDir = path.resolve(here, `../outputs/${outDirName(scenario, engine, format)}`);
const prefix = prefixForDir(outDirName(scenario, engine, format));
if (!fs.existsSync(outDir)) {
  console.error(`[dialogue] no ${outDir} — generate the project first`);
  process.exit(1);
}
const tag = `[dialogue:${scenario}]`;
const seq = Array.isArray(cfg.sequence) ? cfg.sequence : [];
const ttsCfg = cfg.tts && typeof cfg.tts === "object" ? cfg.tts : {};

const dlgBeats = seq.map((b, i) => ({ b, n: i + 1 }))
  .filter(({ b, n }) => Array.isArray(b.dialogue) && b.dialogue.some((d) => d && String(d.line || "").trim()))
  .filter(({ n }) => !onlyBeats || onlyBeats.has(n));

if (!dlgBeats.length) {
  console.log(`${tag} no dialogue beats${onlyBeats ? " in --beats filter" : ""} (add "dialogue": [{ "speaker", "line" }] to beats)`);
  process.exit(0);
}
console.log(`${tag} ${dlgBeats.length} dialogue beat${dlgBeats.length === 1 ? "" : "s"}: ${dlgBeats.map(({ n }) => n).join(", ")}`);

let synced = 0;
for (const { b, n } of dlgBeats) {
  let wav = null;
  if (skipTts) {
    const { dialogueWavFile, audioDuration } = await import("../lib/tts.mjs");
    const f = dialogueWavFile(prefix, n, b.title);
    if (!fs.existsSync(path.join(outDir, f))) {
      console.log(`${tag} beat ${n} — no dialogue wav (remove --skip-tts to generate), skipping`);
      continue;
    }
    wav = { file: f, duration: audioDuration(path.join(outDir, f)) };
  } else {
    wav = genBeatAudio({ outDir, prefix, n, title: b.title, dialogue: b.dialogue, ttsCfg, tag });
  }
  if (!wav.file) continue;
  if (skipLip) continue;
  const st = loadState(outDir);
  const clipFile = resolveMain(outDir, prefix, "clip", n, ".mp4", b.title, st);
  if (!clipFile || !fs.existsSync(path.join(outDir, clipFile))) {
    console.log(`${tag} beat ${n} (${b.title}) — no clip yet, generate clips first, skipping lip-sync (voice kept)`);
    continue;
  }
  lipSyncBeat({ outDir, prefix, n, title: b.title, clipFile, wavFile: wav.file, tag });
  synced++;
}

// Re-stitch so the final cut uses the lip-synced mains (with voices) —
// unless --no-stitch (review single scenes first, merge later via Stitch).
if (synced > 0 && !skipLip && !noStitch) {
  try {
    // stitchSequence emits the [asset] final line itself (with the real file).
    stitchSequence({ scenario, outDir, prefix, tag, cfg });
  } catch (e) {
    console.error(`${tag} re-stitch failed: ${e.message}`);
    process.exit(1);
  }
}
console.log(`${tag} DONE (voiced: ${dlgBeats.length}, lip-synced: ${synced})`);
