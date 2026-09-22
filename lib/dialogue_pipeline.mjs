// Character dialogue pipeline — timing model, provider abstractions,
// multi-speaker segmentation and per-stage status.
//
// This module sits ON TOP of the existing pieces without replacing them:
//   lib/tts.mjs      — Edge-TTS voice synthesis (default TTS provider)
//   lib/lipsync.mjs  — Easy-Wav2Lip beat lip-sync (default lip-sync provider)
//   lib/sequence.mjs — clip generation + versioned mains + stitching
//   lib/director.mjs — dialogue schema (normalizeDialogue) + board handoff
//
// What it ADDS (the gaps those modules leave):
//   1. Per-line timing: each dialogue line gets a real start/end derived from
//      its own synthesized audio length (never blind trust of estimates).
//   2. Multi-speaker segmentation: a beat with 2+ speakers is split into one
//      window per line, each window lip-synced to its own speaker's audio,
//      then re-merged — Rabbit's mouth never moves to Lion's voice.
//   3. Provider abstractions: TTS_PROVIDER / LIPSYNC_PROVIDER env selects the
//      implementation; "musetalk-comfy" drives a configurable ComfyUI
//      MuseTalk workflow when one is installed (otherwise a clear DEPENDENCY
//      error, never a fake success).
//   4. Disk-derived per-stage status (voice / video / lip-sync / final) so
//      the API/UI can show every stage independently.
//
// Pure helpers (planDialogueTiming, needsSegmentation, beatDialogueStatus)
// have no fs/process deps and are unit-tested in tests/dialogue.test.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { fileSlug } from "./variant.mjs";
import { loadState, nextVersion, resolveMain, setMain } from "./sequence_state.mjs";
import { audioDuration, dialogueWavFile, voiceFor, prosodyFor } from "./tts.mjs";
import { lipSyncBeat, normalizeClipToSpec, probeClipSpec } from "./lipsync.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- config
// All paths/settings are env-configurable; nothing machine-specific is
// hardcoded (defaults mirror the existing local setup).
export const SEGMENT_PAUSE = Number(process.env.DIALOGUE_SEGMENT_PAUSE ?? 0.35);
export const LIP_SYNC_TAIL = 0.25; // breathing room so the last phoneme isn't cut
export const ttsProviderName = () =>
  String(process.env.TTS_PROVIDER || "edge-tts").toLowerCase();
export const lipSyncProviderName = () =>
  String(process.env.LIPSYNC_PROVIDER || "wav2lip").toLowerCase();
export const musetalkWorkflowPath = () =>
  process.env.MUSETALK_WORKFLOW ||
  path.resolve(here, "../workflows/musetalk_lipsync.json");

// True when a real (non-template) MuseTalk workflow is configured: the file
// exists, is not the shipped placeholder template, and carries the
// {{VIDEO}} / {{AUDIO}} input tokens the ComfyUI driver injects into.
// The Video LipSync section uses this (never bare existsSync) so the
// MuseTalk option stays disabled until the setup is actually done.
export function musetalkWorkflowReady(wfPath = musetalkWorkflowPath()) {
  try {
    if (!fs.existsSync(wfPath)) return false;
    const raw = fs.readFileSync(wfPath, "utf8");
    if (/\"template\"\s*:\s*true/.test(raw)) return false;
    return raw.includes("{{VIDEO}}") && raw.includes("{{AUDIO}}");
  } catch { return false; }
}

// Per-stage states (subset of the pipeline vocabulary relevant to dialogue;
// the video stages reuse the existing run/clip states).
export const STAGE = Object.freeze({
  PENDING: "PENDING",
  GENERATING_AUDIO: "GENERATING_AUDIO",
  GENERATING_VIDEO: "GENERATING_VIDEO",
  LIP_SYNCING: "LIP_SYNCING",
  MERGING: "MERGING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
});

// ---------------------------------------------------------------- timing
// planDialogueTiming: sequential per-line windows from ACTUAL per-line audio
// durations. Never overlaps, never trusts estimates, never silently cuts:
// when the lines outgrow the scene, the total grows (callers loop-extend the
// clip to `total + LIP_SYNC_TAIL`).
export function planDialogueTiming(lines, durations, { pause = SEGMENT_PAUSE } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const gap = Number.isFinite(Number(pause)) && Number(pause) >= 0 ? Number(pause) : 0;
  const timing = [];
  let t = 0;
  list.forEach((d, i) => {
    const dur = Number(durations?.[i]);
    const lineDur = Number.isFinite(dur) && dur > 0 ? dur : 0;
    const start = Math.round(t * 100) / 100;
    const end = Math.round((t + lineDur) * 100) / 100;
    timing.push({
      speaker: String(d?.speaker ?? ""),
      line: String(d?.line ?? ""),
      start,
      end,
      duration: Math.round(lineDur * 100) / 100,
    });
    t = end + (i < list.length - 1 ? gap : 0);
  });
  return timing;
}

export function dialogueTotal(timing) {
  const list = Array.isArray(timing) ? timing : [];
  return list.length ? list[list.length - 1].end : 0;
}

// True when a beat needs segment-based lip-sync: 2+ distinct speakers with
// speakable lines. Single-speaker beats keep the existing whole-beat path.
export function needsSegmentation(dialogue) {
  const speakers = new Set(
    (Array.isArray(dialogue) ? dialogue : [])
      .filter((d) => d && String(d.line || "").trim())
      .map((d) => String(d.speaker || "").toLowerCase()));
  return speakers.size > 1;
}

// ---------------------------------------------------------------- TTS providers
// ITtsProvider: synthesize one speakable line -> wav file.
// "edge-tts" shells the local edge-tts CLI (Hindi voices via voiceFor +
// expression-shaped rate/pitch via prosodyFor — same as lib/tts.mjs).
// Additional providers register here; unknown names throw instead of
// silently falling back.
function synthEdgeTts({ voice, text, wavPath, rate, pitch }) {
  const mp3Path = wavPath.replace(/\.wav$/i, ".mp3");
  const args = ["--voice", voice, "--text", text, "--write-media", mp3Path];
  if (rate) args.push("--rate", rate);
  if (pitch) args.push("--pitch", pitch);
  const r = spawnSync("edge-tts", args, { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(mp3Path)) {
    throw new Error(`edge-tts failed for voice ${voice}: ${(r.stderr || r.error?.message || "").slice(0, 300)}`);
  }
  if (r.status !== 0 || !fs.existsSync(mp3Path)) {
    throw new Error(`edge-tts failed for voice ${voice}: ${(r.stderr || r.error?.message || "").slice(0, 300)}`);
  }
  try {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", mp3Path,
      "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", wavPath]);
  } finally {
    try { fs.unlinkSync(mp3Path); } catch { /* best-effort */ }
  }
  return wavPath;
}

const TTS_PROVIDERS = {
  "edge-tts": { id: "edge-tts", synthesizeLine: synthEdgeTts },
};

export function getTtsProvider(name = ttsProviderName()) {
  const p = TTS_PROVIDERS[String(name || "").toLowerCase()];
  if (!p) throw new Error(`unknown TTS_PROVIDER "${name}" (available: ${Object.keys(TTS_PROVIDERS).join(", ")})`);
  return p;
}

/** Per-line wav filename (stable, shared by TTS + segmentation). */
export function lineWavFile(prefix, n, title, i) {
  return `${prefix}_dlg${n}_${fileSlug(title)}_seg${i}.wav`;
}

/**
 * Synthesize each dialogue line to its own cached wav (per-line expression
 * shapes the voice rate/pitch, same prosody as the whole-beat TTS path).
 * Resumable: an existing wav is kept (delete it to re-voice that line only).
 * @returns {{ files: (string|null)[], durations: number[] }}
 */
export function genLineAudios({ outDir, prefix, n, title, dialogue, ttsCfg, tag = "[tts]" }) {
  const lines = Array.isArray(dialogue) ? dialogue.filter((d) => d && String(d.line || "").trim()) : [];
  const provider = getTtsProvider();
  const files = [];
  const durations = [];
  lines.forEach((d, i) => {
    const wavBase = lineWavFile(prefix, n, title, i);
    const wavPath = path.join(outDir, wavBase);
    if (fs.existsSync(wavPath)) {
      files.push(wavBase);
      durations.push(audioDuration(wavPath));
      return;
    }
    const voice = voiceFor(d.speaker, ttsCfg);
    const prosody = prosodyFor(d, "");
    const bits = [prosody.rate ? `rate ${prosody.rate}` : null, prosody.pitch ? `pitch ${prosody.pitch}` : null]
      .filter(Boolean).join(" ");
    console.log(`${tag} beat ${n} line ${i + 1} ${d.speaker || "voice"} (${provider.id}/${voice}${bits ? `, ${bits}` : ""}): ${String(d.line).slice(0, 80)}`);
    provider.synthesizeLine({ voice, text: String(d.line), wavPath, ...prosody });
    files.push(wavBase);
    durations.push(audioDuration(wavPath));
    console.log(`[asset] ${JSON.stringify({ kind: "audio", file: wavBase, stage: "dialogue-line", index: n, line: i })}`);
  });
  return { files, durations };
}

// ---------------------------------------------------------------- ffmpeg helpers
function probeDuration(file) {
  try {
    const out = execFileSync("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" }).trim();
    const d = Number(out);
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch { return 0; }
}

/** Loop a clip (stream-copy) until it covers `target` seconds. */
export function loopClipToDuration(clipPath, target, destPath) {
  const dur = probeDuration(clipPath);
  if (dur >= target) return clipPath;
  const reps = Math.max(2, Math.ceil(target / Math.max(dur, 0.1)) + 1);
  const list = `${destPath}.list.txt`;
  fs.writeFileSync(list,
    Array(reps).fill(`file '${clipPath.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
    "-i", list, "-t", String(target), "-c", "copy", destPath]);
  try { fs.unlinkSync(list); } catch { /* keep going */ }
  return destPath;
}

/** Cut one [start, end) window (re-encode: frame-accurate for lip-sync).
 *  Audio is normalized to AAC 48kHz stereo so every window (and the merged
 *  take) matches the project's concat spec — the `-c copy` final-cut stitch
 *  requires identical audio params across segments. */
export function cutWindow(srcPath, start, end, destPath) {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(start), "-i", srcPath,
    "-t", String(Math.max(0.1, end - start)),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", destPath]);
  return destPath;
}

/** Concat same-codec segments (lossless stream-copy, stitch-safe). */
export function concatSegments(files, destPath) {
  const list = `${destPath}.list.txt`;
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
    "-i", list, "-c", "copy", destPath]);
  try { fs.unlinkSync(list); } catch { /* keep going */ }
  return destPath;
}

// ---------------------------------------------------------------- lip-sync providers
// ILipSyncProvider: sync one (video, audio) pair -> output video.
// "wav2lip" delegates to the existing Easy-Wav2Lip bridge (lib/lipsync.mjs,
// with its no-face dub fallback). "musetalk-comfy" drives a user-installed
// ComfyUI MuseTalk workflow (token-injected, configurable path).
async function lipSyncViaWav2lip({ outDir, prefix, n, title, clipFile, wavFile, tag }) {
  return lipSyncBeat({ outDir, prefix, n, title, clipFile, wavFile, tag });
}

async function lipSyncViaMuseTalkComfy({ clipPath, wavPath, outPath, tag = "[musetalk]" }) {
  const wfPath = musetalkWorkflowPath();
  if (!fs.existsSync(wfPath) || /\"template\"\s*:\s*true/.test(fs.readFileSync(wfPath, "utf8"))) {
    throw new Error(
      `DEPENDENCY: MuseTalk ComfyUI workflow not configured.\n` +
      `SETUP: export your MuseTalk API-format workflow from ComfyUI (with ComfyUI-MuseTalk\n` +
      `nodes + models installed on the ComfyUI host), replace the placeholder template at\n` +
      `${wfPath} with it (or override with MUSETALK_WORKFLOW=/path/to/workflow.json).\n` +
      `The workflow JSON must contain {{VIDEO}} and {{AUDIO}} input tokens — the driver\n` +
      `uploads this beat's silent clip + dialogue wav and injects their filenames there.\n` +
       `Until then, run the LipSync section with the Easy-Wav2Lip engine.`);
  }
  const { run, download, firstVideoUrl, BASE } = await import("./comfy.mjs");
  const raw = fs.readFileSync(wfPath, "utf8");
  if (!raw.includes("{{VIDEO}}") || !raw.includes("{{AUDIO}}")) {
    throw new Error(`MuseTalk workflow ${wfPath} must contain {{VIDEO}} and {{AUDIO}} input tokens`);
  }
  // Upload both inputs into ComfyUI's input folder (generic file upload —
  // the workflow consumes them by filename via the injected tokens).
  const uploadFile = async (file) => {
    const fd = new FormData();
    fd.append("image", new Blob([fs.readFileSync(file)]), path.basename(file));
    fd.append("overwrite", "true");
    const r = await fetch(`${BASE}/upload/image`, { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error("UPLOAD ERROR: " + JSON.stringify(d));
    return d.name || path.basename(file);
  };
  const videoName = await uploadFile(clipPath);
  const audioName = await uploadFile(wavPath);
  const graph = JSON.parse(raw.split("{{VIDEO}}").join(videoName).split("{{AUDIO}}").join(audioName));
  console.log(`${tag} submitting MuseTalk workflow (${path.basename(wfPath)})...`);
  const entry = await run(graph, "musetalk");
  await download(firstVideoUrl(entry), outPath);
  return outPath;
}

const LIPSYNC_PROVIDERS = {
  wav2lip: { id: "wav2lip", syncBeat: lipSyncViaWav2lip },
  "musetalk-comfy": { id: "musetalk-comfy", syncFile: lipSyncViaMuseTalkComfy },
};

export function getLipSyncProvider(name = lipSyncProviderName()) {
  const p = LIPSYNC_PROVIDERS[String(name || "").toLowerCase()];
  if (!p) throw new Error(`unknown LIPSYNC_PROVIDER "${name}" (available: ${Object.keys(LIPSYNC_PROVIDERS).join(", ")})`);
  return p;
}

// ---------------------------------------------------------------- segmentation
/**
 * Multi-speaker lip-sync for one beat:
 *   loop-extended clip -> one window per dialogue line (from ACTUAL line
 *   audio lengths) -> per-window lip-sync with that speaker's own audio ->
 *   concat -> new clip version + clip main (same convention as regens).
 *
 * Each window is synced in an isolated work dir via the standard lipSyncBeat
 * (own state.json), so face-checks, dub fallbacks and version minting behave
 * exactly like the whole-beat path — per speaker instead of per beat.
 * @returns {{ file, timing }} the new clip main + the applied timing plan.
 */
export async function lipSyncBeatSegmented({
  outDir, prefix, n, title, clipFile, dialogue, ttsCfg, tag = "[dialogue]",
}) {
  const lines = Array.isArray(dialogue) ? dialogue.filter((d) => d && String(d.line || "").trim()) : [];
  if (!lines.length) throw new Error(`beat ${n}: no dialogue lines to segment`);
  const clipPath = path.join(outDir, clipFile);
  if (!fs.existsSync(clipPath)) throw new Error(`lip-sync: clip missing: ${clipFile}`);

  // 1. Per-line voice (cached) + timing from ACTUAL durations.
  const { files, durations } = genLineAudios({ outDir, prefix, n, title, dialogue: lines, ttsCfg, tag });
  const timing = planDialogueTiming(lines, durations);
  const total = dialogueTotal(timing);
  if (!total) throw new Error(`beat ${n}: dialogue audio has zero duration`);
  const target = total + LIP_SYNC_TAIL;

  // 2. Loop-extend the clip to the dialogue length, then cut one window/line.
  const work = path.join(outDir, `seg_tmp_${n}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    const cover = loopClipToDuration(clipPath, target, path.join(work, "cover.mp4"));
    const syncedWindows = [];
    for (let i = 0; i < lines.length; i++) {
      const seg = timing[i];
      const winClip = path.join(work, `win${i}.mp4`);
      cutWindow(cover === clipPath ? clipPath : cover, seg.start, Math.min(seg.end + (i === lines.length - 1 ? LIP_SYNC_TAIL : 0), target), winClip);
      const winWav = path.join(work, `win${i}.wav`);
      fs.copyFileSync(path.join(outDir, files[i]), winWav);
      // Stage the window as a pseudo-beat so the standard bridge applies.
      const segPrefix = `seg${n}`;
      const segTitle = `s${i}`;
      const stagedClip = `${segPrefix}_clip${i + 1}_${segTitle}.mp4`;
      const stagedWav = `${segPrefix}_dlg${i + 1}_${segTitle}.wav`;
      fs.copyFileSync(winClip, path.join(work, stagedClip));
      fs.copyFileSync(winWav, path.join(work, stagedWav));
      const main = lipSyncBeat({
        outDir: work, prefix: segPrefix, n: i + 1, title: segTitle,
        clipFile: stagedClip, wavFile: stagedWav, tag,
      });
      syncedWindows.push(path.join(work, main));
      console.log(`${tag} beat ${n} segment ${i + 1}/${lines.length} (${seg.speaker || "voice"} ${seg.start.toFixed(1)}-${seg.end.toFixed(1)}s) -> ${main}`);
    }
    // 3. Merge windows -> new clip version + clip main in the real outDir.
    // The merged take is normalized to the pre-sync clip's concat spec so the
    // `-c copy` final-cut stitch stays safe (per-window takes carry the raw
    // 16kHz mono line audio through Wav2Lip's mux otherwise).
    const spec = probeClipSpec(clipPath);
    const v = nextVersion(outDir, prefix, "clip", n, ".mp4", title);
    const dest = path.join(outDir, v === 1
      ? `${prefix}_clip${n}_${fileSlug(title)}.mp4`
      : `${prefix}_clip${n}_${fileSlug(title)}_v${v}.mp4`);
    const mergedTmp = path.join(work, "merged.mp4");
    concatSegments(syncedWindows, mergedTmp);
    normalizeClipToSpec(mergedTmp, dest, spec);
    const mainFile = path.basename(dest);
    setMain(outDir, prefix, "clip", n, title, mainFile, { pinned: false });
    console.log(`${tag} beat ${n} segmented lip-sync (${lines.length} speakers) -> ${mainFile}`);
    console.log(`[asset] ${JSON.stringify({ kind: "video", file: mainFile, stage: "clip", index: n, lipsynced: true, segmented: true })}`);
    return { file: mainFile, timing };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Route one beat through the configured lip-sync provider:
 *   wav2lip        — whole-beat lipSyncBeat (single speaker) or
 *                    lipSyncBeatSegmented (multi-speaker, automatic).
 *   musetalk-comfy — whole-beat MuseTalk via the ComfyUI workflow, or the
 *                    same per-line windows when the beat has 2+ speakers.
 * Single-speaker behavior is byte-for-byte the pre-existing path (backward
 * compatible); only multi-speaker beats take the new segmented path.
 * @returns {{ file, timing, segmented }}
 */
export async function lipSyncBeatForProvider({
  outDir, prefix, n, title, clipFile, dialogue, ttsCfg, wavFile = null,
  providerName = lipSyncProviderName(), tag = "[dialogue]",
}) {
  const provider = getLipSyncProvider(providerName);
  const segmented = needsSegmentation(dialogue);
  if (provider.id === "wav2lip") {
    if (segmented) {
      const r = await lipSyncBeatSegmented({ outDir, prefix, n, title, clipFile, dialogue, ttsCfg, tag });
      return { ...r, segmented: true };
    }
    if (!wavFile) throw new Error(`beat ${n}: no dialogue wav (generate voice first)`);
    const file = await provider.syncBeat({ outDir, prefix, n, title, clipFile, wavFile, tag });
    return { file, timing: [], segmented: false };
  }
  // musetalk-comfy file path.
  const lines = (Array.isArray(dialogue) ? dialogue : []).filter((d) => d && String(d.line || "").trim());
  const { files, durations } = genLineAudios({ outDir, prefix, n, title, dialogue: lines, ttsCfg, tag });
  const timing = planDialogueTiming(lines, durations);
  const total = dialogueTotal(timing);
  if (!total) throw new Error(`beat ${n}: dialogue audio has zero duration`);
  const target = total + LIP_SYNC_TAIL;
  const clipPath = path.join(outDir, clipFile);
  const work = path.join(outDir, `mus_tmp_${n}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    const cover = loopClipToDuration(clipPath, target, path.join(work, "cover.mp4"));
    const src = cover === clipPath ? clipPath : cover;
    const outs = [];
    const windows = segmented
      ? timing.map((seg, i) => ({ start: seg.start, end: Math.min(seg.end + (i === lines.length - 1 ? LIP_SYNC_TAIL : 0), target), wav: files[i] }))
      : [{ start: 0, end: target, wav: files.length === 1 ? files[0] : null }];
    // Single-speaker musetalk beats reuse the mixed beat wav when present.
    if (!segmented) {
      const mixed = dialogueWavFile(prefix, n, title);
      windows[0].wav = fs.existsSync(path.join(outDir, mixed)) ? mixed : files[0];
    }
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      if (!w.wav) throw new Error(`beat ${n}: missing line audio for segment ${i + 1}`);
      const winClip = path.join(work, `win${i}.mp4`);
      cutWindow(src, w.start, w.end, winClip);
      const out = path.join(work, `synced${i}.mp4`);
      await provider.syncFile({ clipPath: winClip, wavPath: path.join(outDir, w.wav), outPath: out, tag });
      outs.push(out);
    }
    const v = nextVersion(outDir, prefix, "clip", n, ".mp4", title);
    const dest = path.join(outDir, v === 1
      ? `${prefix}_clip${n}_${fileSlug(title)}.mp4`
      : `${prefix}_clip${n}_${fileSlug(title)}_v${v}.mp4`);
    const mergedTmp = path.join(work, "merged.mp4");
    concatSegments(outs, mergedTmp);
    // Normalize to the pre-sync clip's concat spec (ComfyUI decks vary) so
    // the `-c copy` final-cut stitch stays safe.
    normalizeClipToSpec(mergedTmp, dest, probeClipSpec(clipPath));
    const mainFile = path.basename(dest);
    setMain(outDir, prefix, "clip", n, title, mainFile, { pinned: false });
    console.log(`${tag} beat ${n} musetalk lip-sync${segmented ? ` (${lines.length} segments)` : ""} -> ${mainFile}`);
    console.log(`[asset] ${JSON.stringify({ kind: "video", file: mainFile, stage: "clip", index: n, lipsynced: true, provider: "musetalk-comfy", segmented })}`);
    return { file: mainFile, timing, segmented };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- status
// Disk-derived per-stage status for one beat (no DB required — works from
// outputs/ alone, which is also the offline fallback when Postgres is down).
// FAILED is reported by the run record (server), never inferred here.
export function beatDialogueStatus({ outDir, prefix, n, title, dialogue }) {
  const lines = Array.isArray(dialogue) ? dialogue.filter((d) => d && String(d.line || "").trim()) : [];
  const hasDialogue = lines.length > 0;
  const speakers = [...new Set(lines.map((d) => String(d.speaker || "")))].filter(Boolean);
  let state = null;
  try { state = loadState(outDir); } catch { state = null; }
  let clipMain = null;
  try { clipMain = state ? resolveMain(outDir, prefix, "clip", n, ".mp4", title, state) : null; } catch { clipMain = null; }
  const wavBase = hasDialogue ? dialogueWavFile(prefix, n, title) : null;
  const voiceDone = !!(wavBase && fs.existsSync(path.join(outDir, wavBase)));
  const videoDone = !!(clipMain && fs.existsSync(path.join(outDir, clipMain)));
  // A lip-synced take exists when the clip main is newer than (or alongside)
  // a voice wav for the beat — approximated honestly: voice exists AND the
  // clip main's mtime is at/after the wav's mtime.
  let lipsyncDone = false;
  try {
    if (hasDialogue && voiceDone && videoDone) {
      const wavT = fs.statSync(path.join(outDir, wavBase)).mtimeMs;
      const clipT = fs.statSync(path.join(outDir, clipMain)).mtimeMs;
      lipsyncDone = clipT + 1 >= wavT;
    }
  } catch { lipsyncDone = false; }
  let finalDone = false;
  try {
    const files = fs.readdirSync(outDir).filter((f) => /_final(?:_v\d+)?\.mp4$/.test(f));
    finalDone = files.length > 0;
  } catch { finalDone = false; }
  const stage = (done) => (done ? STAGE.COMPLETED : STAGE.PENDING);
  return {
    beat: n,
    title: title ?? null,
    hasDialogue,
    speakers,
    segmented: needsSegmentation(dialogue),
    voice: hasDialogue ? stage(voiceDone) : STAGE.PENDING,
    video: stage(videoDone),
    lipsync: hasDialogue ? stage(lipsyncDone) : STAGE.PENDING,
    final: stage(finalDone),
  };
}
