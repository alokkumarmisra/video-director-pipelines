// DIALOGUE LIP-SYNC (Video LipSync section): the full talking-scene workflow
// in one pass, per beat:
//   Character Image (keyframe main) -> LTX-2.5 / Wan i2v -> Silent Video
//   (3-5s, dialogue-fitted) -> Hindi TTS dialogue.wav -> lip-sync engine
//   (Easy-Wav2Lip local, or MuseTalk on ComfyUI) -> Talking Video (new clip
//   version + clip main) -> re-stitch -> Final Scene (final cut).
//
// Legs that already exist are reused, not re-implemented: beats that already
// have a clip keep it (loop-extended stream-copy to the audio length when
// shorter); beats with NO clip get a fresh silent clip generated from their
// keyframe main via lib/comfy.mjs (same builders the sequence runners use).
// The synced take becomes a new clip version + clip main, then the final cut
// is re-stitched (voices included — the sync output muxes dialogue audio).
//
// Multi-speaker beats are segmented AUTOMATICALLY (see
// lib/dialogue_pipeline.mjs): one clip window per dialogue line from the
// line's actual audio length, each window synced to its own speaker's voice,
// then merged into a new clip version. Engine via --lipsync (or
// LIPSYNC_PROVIDER env): wav2lip default, musetalk-comfy = MUSETALK_WORKFLOW
// JSON with {{VIDEO}}/{{AUDIO}} tokens on ComfyUI.
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
//   node scripts/dialogue_lipsync.mjs [scenario] --lipsync musetalk-comfy
//     # lip-sync engine for this run (wav2lip | musetalk-comfy; default from
//     # LIPSYNC_PROVIDER env, default wav2lip). The LipSync section UI sends this.
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
import {
  outDirName, prefixForDir, normalizeFormat, VERTICAL,
  VERTICAL_LTX_RATIO, VERTICAL_LTX_MEGAPIXELS,
  VERTICAL_WAN_WIDTH, VERTICAL_WAN_HEIGHT,
  verticalMotionPrompt, fileSlug,
} from "../lib/variant.mjs";
import { loadState, resolveMain, nextVersion, setMain } from "../lib/sequence_state.mjs";
import { stitchSequence } from "../lib/sequence.mjs";
import { genBeatAudio, beatTargetDuration } from "../lib/tts.mjs";
import {
  run, download, uploadToInput, firstVideoUrl, buildLtxGraph, buildWanGraph,
} from "../lib/comfy.mjs";
import { lipSyncBeatForProvider, lipSyncProviderName } from "../lib/dialogue_pipeline.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith("--")) || "anime_sequence";
const cfgNameIdx = args.indexOf("--config-name");
const cfgName = cfgNameIdx >= 0 && args[cfgNameIdx + 1] ? args[cfgNameIdx + 1] : scenario;
const format = normalizeFormat(args.includes("--vertical") ? VERTICAL : "landscape");
const vertical = format === VERTICAL;
const engine = args.includes("--wan") ? "wan" : "ltx";
const videoNode = engine === "wan" ? "56" : "75";
const skipTts = args.includes("--skip-tts");
const skipLip = args.includes("--skip-lipsync");
const noStitch = args.includes("--no-stitch");
// --lipsync <wav2lip|musetalk-comfy>: engine for THIS run (the LipSync
// section UI sends it); overrides LIPSYNC_PROVIDER env for this process.
const lipsyncIdx = args.indexOf("--lipsync");
const lipsyncFlag = lipsyncIdx >= 0 && args[lipsyncIdx + 1] ? String(args[lipsyncIdx + 1]).toLowerCase() : "";
if (lipsyncFlag) {
  if (lipsyncFlag !== "wav2lip" && lipsyncFlag !== "musetalk-comfy") {
    console.error(`[dialogue] unknown --lipsync "${lipsyncFlag}" (wav2lip | musetalk-comfy)`);
    process.exit(1);
  }
  process.env.LIPSYNC_PROVIDER = lipsyncFlag;
}
const providerName = lipSyncProviderName();
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
console.log(`${tag} ${dlgBeats.length} dialogue beat${dlgBeats.length === 1 ? "" : "s"}: ${dlgBeats.map(({ n }) => n).join(", ")} (lip-sync: ${providerName})`);

/** duration (s) -> Wan frame count (4n+1 at fixed 16fps). 3s -> 49, 4s -> 65. */
const wanFrames = (duration) => Math.floor((duration * 16) / 4) * 4 + 1;

// SILENT-CLIP LEG (Character Image -> i2v -> Silent Video): when a dialogue
// beat has no clip yet, generate one from its keyframe main — the same
// builders the sequence runners use — sized to the dialogue (3–5s; longer
// voice is covered by loop-extension at lip-sync time, same as existing
// clips). Recorded as clip v1 + clip main so the rest of the pipeline
// (lip-sync, gallery, stitch) works unchanged. Returns the clip main
// filename, or null when there is no keyframe to build from either.
async function genSilentClip({ b, n, wavDuration }) {
  const st = loadState(outDir);
  const kfFile = resolveMain(outDir, prefix, "seq", n, ".png", b.title, st);
  if (!kfFile || !fs.existsSync(path.join(outDir, kfFile))) {
    return null;
  }
  // Dialogue-fitted silent length: short lines stay short (3s floor), lengthy
  // dialogue grows the request (up to 12s) from the voice length so the
  // lip-sync loop-extension stays small. Longer voices still work — the
  // loop-extension at sync time covers the rest losslessly.
  const target = Math.min(12, Math.max(3, Math.ceil((Number(wavDuration) || 3) + 0.5)));
  let motion = vertical ? verticalMotionPrompt(b.motion || "") : String(b.motion || "");
  if (!/speaking|frontal|close-up/i.test(motion)) {
    motion += ", frontal close-up, character looking at camera while speaking, clear face visible for lip-sync";
  }
  console.log(`${tag} beat ${n} (${b.title}) — no clip yet, generating ${target}s silent ${engine} clip from ${kfFile}...`);
  const inputName = await uploadToInput(path.join(outDir, kfFile), `${prefix}_kf${n}`);
  const graph = engine === "wan"
    ? buildWanGraph({
      prompt: motion,
      image: inputName,
      width: vertical ? VERTICAL_WAN_WIDTH : (cfg.width ?? 512),
      height: vertical ? VERTICAL_WAN_HEIGHT : (cfg.height ?? 512),
      length: wanFrames(beatTargetDuration({ outDir, prefix, n, beat: b, fallback: target })),
      steps: cfg.steps ?? 8,
      negative: cfg.negative,
      prefix: `${scenario}/wan_clip${n}_${b.title}`,
    })
    : buildLtxGraph({
      prompt: motion,
      image: inputName,
      duration: beatTargetDuration({ outDir, prefix, n, beat: b, fallback: target }),
      ratio: vertical ? VERTICAL_LTX_RATIO : "16:9 (Widescreen)",
      megapixels: vertical ? VERTICAL_LTX_MEGAPIXELS : 0.5,
      prefix: `${scenario}/clip${n}_${b.title}`,
    });
  const entry = await run(graph, `clip${n}`);
  const v = nextVersion(outDir, prefix, "clip", n, ".mp4", b.title);
  const dest = path.join(outDir, v === 1
    ? `${prefix}_clip${n}_${fileSlug(b.title)}.mp4`
    : `${prefix}_clip${n}_${fileSlug(b.title)}_v${v}.mp4`);
  await download(firstVideoUrl(entry, videoNode), dest);
  const mainFile = path.basename(dest);
  setMain(outDir, prefix, "clip", n, b.title, mainFile, { pinned: false });
  console.log(`${tag} beat ${n} silent clip -> ${mainFile}`);
  console.log(`[asset] ${JSON.stringify({ kind: "video", file: mainFile, stage: "clip", index: n, silent: true })}`);
  return mainFile;
}

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
    wav = genBeatAudio({ outDir, prefix, n, title: b.title, dialogue: b.dialogue, ttsCfg, tag, beat: b });
  }
  if (!wav.file) continue;
  if (skipLip) continue;
  const st = loadState(outDir);
  let clipFile = resolveMain(outDir, prefix, "clip", n, ".mp4", b.title, st);
  if (!clipFile || !fs.existsSync(path.join(outDir, clipFile))) {
    clipFile = await genSilentClip({ b, n, wavDuration: wav.duration });
    if (!clipFile) {
      console.log(`${tag} beat ${n} (${b.title}) — no clip and no keyframe yet, generate the project first, skipping lip-sync (voice kept)`);
      continue;
    }
  }
  // Every beat — single- or multi-speaker — goes through the selected
  // lip-sync provider (wav2lip segments multi-speaker beats automatically;
  // musetalk-comfy submits to the ComfyUI workflow).
  await lipSyncBeatForProvider({
    outDir, prefix, n, title: b.title, clipFile,
    dialogue: b.dialogue, ttsCfg, wavFile: wav.file, providerName, tag,
  });
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
