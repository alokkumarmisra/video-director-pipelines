// Easy-Wav2Lip bridge — lip-syncs a generated clip to its dialogue audio.
//
// The user's local install (D:\AI\Alok\Easy-Wav2Lip-8.3, venv python 3.10,
// CUDA) is driven headless through its CLI:
//
//   <venv>\Scripts\python.exe run.py -video_file <mp4> -vocal_file <wav>
//
// run.py reads config.ini from its own folder (quality/padding/mask stay
// exactly as the user set them in the GUI — we only override the input
// paths, batch_process and the output suffix, then restore the file).
//
// Duration rule (the user's core ask): the video must fit the dialogue.
// Wav2Lip trims a LONGER video down to the audio automatically, but a
// SHORTER video is looped first with ffmpeg (stream-copy concat, so codec /
// resolution / fps never change and the final `-c copy` stitch stays safe).
//
// The synced result is stored as a NEW version of the beat's CLIP
// (`<prefix>_clip<n>_<slug>[_vN].mp4`) and selected as the clip main —
// stitching, the gallery and the DB keep working unchanged, and the
// pre-sync take stays selectable.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileSlug } from "./variant.mjs";
import { loadState, nextVersion, setMain, resolveMain } from "./sequence_state.mjs";

const DEFAULT_EASY_DIR = process.env.EASY_WAV2LIP_DIR ||
  "D:\\AI\\Alok\\Easy-Wav2Lip-8.3\\Easy-Wav2Lip-8.3";
const DEFAULT_VENV_PYTHON = process.env.EASY_WAV2LIP_PYTHON ||
  "D:\\AI\\Alok\\Easy-Wav2Lip-8.3\\Easy-Wav2Lip-venv\\Scripts\\python.exe";

export function easyPaths() {
  const easyDir = process.env.EASY_WAV2LIP_DIR || DEFAULT_EASY_DIR;
  const venvPython = process.env.EASY_WAV2LIP_PYTHON || DEFAULT_VENV_PYTHON;
  if (!fs.existsSync(path.join(easyDir, "run.py"))) {
    throw new Error(`Easy-Wav2Lip not found at ${easyDir} (set EASY_WAV2LIP_DIR)`);
  }
  if (!fs.existsSync(venvPython)) {
    throw new Error(`Easy-Wav2Lip python not found at ${venvPython} (set EASY_WAV2LIP_PYTHON)`);
  }
  return { easyDir, venvPython };
}

function probeDuration(file) {
  try {
    const out = execFileSync("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" }).trim();
    const d = Number(out);
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch { return 0; }
}

// Wav2Lip's RetinaFace detector only fires on clear (near-frontal) faces —
// cartoon side-profiles fail. Pre-check 3 sampled frames in seconds instead
// of discovering it after a minutes-long inference run. Returns true when at
// least one frame has a face.
export function facesDetected(clipPath, easyDir, venvPython) {
  const { easyDir: ed, venvPython: vp } = easyDir && venvPython
    ? { easyDir, venvPython } : easyPaths();
  const frames = [0.5, 1.5, 2.5].map((s, i) => {
    const f = path.join(path.dirname(clipPath), `.facecheck_${i}.png`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(s),
      "-i", clipPath, "-frames:v", "1", f]);
    return f;
  });
  const py = [
    "import sys; sys.path.insert(0, '.')",
    "import cv2",
    "from batch_face import RetinaFace",
    `det = RetinaFace(gpu_id=0, model_path='checkpoints/mobilenet.pth', network='mobilenet')`,
    `imgs = ${JSON.stringify(frames.map((f) => f.replace(/\\/g, "/")))}`,
    "n = 0",
    "for f in imgs:",
    "    try: n += len(det(cv2.imread(f)))",
    "    except Exception: pass",
    "print('FACES:' + str(n))",
  ].join("\n");
  try {
    const r = spawnSync(vp, ["-c", py], { cwd: ed, encoding: "utf8", timeout: 180000 });
    const m = String(r.stdout || "").match(/FACES:(\d+)/);
    return m ? Number(m[1]) > 0 : false;
  } catch { return false; }
  finally {
    for (const f of frames) { try { fs.unlinkSync(f); } catch { /* keep going */ } }
  }
}

/** Mux dialogue audio onto a clip (looped to fit) — the dubbed fallback
 *  when no face is detectable for true lip-sync. Stored as a new clip
 *  version + clip main, same as the synced path. */
function dubBeat({ outDir, prefix, n, title, clipFile, wavFile, tag }) {
  const clipPath = path.join(outDir, clipFile);
  const wavPath = path.join(outDir, wavFile);
  const audioDur = probeDuration(wavPath);
  const target = audioDur + 0.25;
  const work = path.join(outDir, `lip_tmp_${n}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const cover = path.join(work, "cover.mp4");
  loopToCover(clipPath, target, cover);
  const src = probeDuration(cover) >= target ? cover : clipPath;
  const v = nextVersion(outDir, prefix, "clip", n, ".mp4", title);
  const dest = path.join(outDir, v === 1
    ? `${prefix}_clip${n}_${fileSlug(title)}.mp4`
    : `${prefix}_clip${n}_${fileSlug(title)}_v${v}.mp4`);
  // Re-encode (audio must be muxed in; video kept visually identical).
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-i", wavPath,
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", dest]);
  fs.rmSync(work, { recursive: true, force: true });
  const mainFile = path.basename(dest);
  setMain(outDir, prefix, "clip", n, title, mainFile, { pinned: false });
  console.log(`${tag} beat ${n} dubbed (voice muxed, no lip-sync) -> ${mainFile}`);
  console.log(`[asset] ${JSON.stringify({ kind: "video", file: mainFile, stage: "clip", index: n, dubbed: true })}`);
  return mainFile;
}

/** Loop a clip (stream-copy) until it covers `target` seconds. */
function loopToCover(clipPath, target, destPath) {
  const dur = probeDuration(clipPath);
  if (dur >= target) return clipPath; // Wav2Lip trims the excess itself
  const reps = Math.max(2, Math.ceil(target / Math.max(dur, 0.1)) + 1);
  const list = destPath + ".list.txt";
  fs.writeFileSync(list,
    Array(reps).fill(`file '${clipPath.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
    "-i", list, "-t", String(target), "-c", "copy", destPath]);
  try { fs.unlinkSync(list); } catch { /* keep going */ }
  return destPath;
}

function patchConfig(easyDir, videoFile, vocalFile, suffix) {
  const iniPath = path.join(easyDir, "config.ini");
  const backup = fs.readFileSync(iniPath, "utf8");
  const lines = backup.split("\n").map((ln) => {
    if (/^\s*video_file\s*=/.test(ln)) return `video_file = ${videoFile}`;
    if (/^\s*vocal_file\s*=/.test(ln)) return `vocal_file = ${vocalFile}`;
    if (/^\s*batch_process\s*=/.test(ln)) return `batch_process = False`;
    if (/^\s*output_suffix\s*=/.test(ln)) return `output_suffix = ${suffix}`;
    if (/^\s*include_settings_in_suffix\s*=/.test(ln)) return `include_settings_in_suffix = False`;
    if (/^\s*preview_settings\s*=/.test(ln)) return `preview_settings = False`;
    return ln;
  });
  fs.writeFileSync(iniPath, lines.join("\n"));
  return () => { try { fs.writeFileSync(iniPath, backup); } catch { /* keep going */ } };
}

/**
 * Lip-sync one beat's clip to its dialogue wav.
 * @returns the new clip version filename (also set as clip main).
 */
export function lipSyncBeat({
  outDir, prefix, n, title, clipFile, wavFile,
  easyDir, venvPython, suffix = "_lipsynced", tag = "[lipsync]",
}) {
  const { easyDir: ed, venvPython: vp } = easyDir && venvPython
    ? { easyDir, venvPython } : easyPaths();
  const clipPath = path.join(outDir, clipFile);
  const wavPath = path.join(outDir, wavFile);
  if (!fs.existsSync(clipPath)) throw new Error(`lip-sync: clip missing: ${clipFile}`);
  if (!fs.existsSync(wavPath)) throw new Error(`lip-sync: dialogue audio missing: ${wavFile}`);

  const audioDur = probeDuration(wavPath);
  if (!audioDur) throw new Error(`lip-sync: could not probe audio length: ${wavFile}`);
  const target = audioDur + 0.25; // small tail so the last phoneme isn't cut

  // No detectable face (side-profile / wide cartoon shot)? Skip the
  // minutes-long Wav2Lip run and mux the voice instead — the beat still
  // speaks with the right voice and length, just without mouth movement.
  // Dialogue scenes authored as frontal close-ups (the Director default)
  // DO pass this check and get true lip-sync below.
  if (!facesDetected(clipPath, ed, vp)) {
    console.log(`${tag} beat ${n} (${title}): no clear face in clip — dubbing voice instead of lip-sync`);
    return dubBeat({ outDir, prefix, n, title, clipFile, wavFile, tag });
  }

  const work = path.join(outDir, `lip_tmp_${n}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  // Same basename (sans ext) for video+audio -> deterministic output name.
  const srcMp4 = path.join(work, "lipwork.mp4");
  const looped = loopToCover(clipPath, target, path.join(work, "looped.mp4"));
  fs.copyFileSync(looped, srcMp4);
  fs.copyFileSync(wavPath, path.join(work, "lipwork.wav"));

  console.log(`${tag} beat ${n} (${title}): clip+${audioDur.toFixed(1)}s dialogue -> Wav2Lip...`);
  const restore = patchConfig(ed, srcMp4, path.join(work, "lipwork.wav"), suffix);
  try {
    const r = spawnSync(vp, ["run.py"], { cwd: ed, encoding: "utf8", timeout: 30 * 60 * 1000 });
    const tail = ((r.stdout || "") + "\n" + (r.stderr || "")).slice(-1500);
    const expected = path.join(work, `lipwork${suffix}.mp4`);
    if (r.status !== 0 || !fs.existsSync(expected)) {
      // Face lost mid-clip or another inference failure — dub instead of
      // failing the run. The voice and timing are still correct.
      console.log(`${tag} beat ${n}: Wav2Lip failed (${(tail.match(/Face not detected|Error[^\n]*/g) || ["unknown error"]).slice(-2).join(" | ").slice(0, 200)}) — dubbing voice instead`);
      restore();
      fs.rmSync(work, { recursive: true, force: true });
      return dubBeat({ outDir, prefix, n, title, clipFile, wavFile, tag });
    }
    // Mint as a new clip version + select as main (same convention as regens).
    const v = nextVersion(outDir, prefix, "clip", n, ".mp4", title);
    const dest = path.join(outDir, v === 1
      ? `${prefix}_clip${n}_${fileSlug(title)}.mp4`
      : `${prefix}_clip${n}_${fileSlug(title)}_v${v}.mp4`);
    fs.copyFileSync(expected, dest);
    const mainFile = path.basename(dest);
    setMain(outDir, prefix, "clip", n, title, mainFile, { pinned: false });
    // Sanity: the main must resolve to what we just wrote.
    const resolved = path.basename(resolveMain(outDir, prefix, "clip", n, ".mp4", title, loadState(outDir)));
    console.log(`${tag} beat ${n} lip-synced -> ${mainFile} (main: ${resolved})`);
    console.log(`[asset] ${JSON.stringify({ kind: "video", file: mainFile, stage: "clip", index: n, lipsynced: true })}`);
    return mainFile;
  } finally {
    restore();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
