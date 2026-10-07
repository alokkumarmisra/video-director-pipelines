// Shared character-sequence pipeline (version-aware).
// Both scripts/character_sequence.mjs (LTX) and character_sequence_wan.mjs (Wan)
// are thin wrappers around runSequence() — they only differ in the clip builder.
//
// Versioning: regenerating an asset writes a new _vN file and never overwrites
// old versions. state.json (see lib/sequence_state.mjs) records which version
// is "main" per asset; stitch() always concatenates the selected mains.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  run, download, uploadToInput, firstImageUrl, firstVideoUrl, hashSeed,
  withQualityMotion,
} from "./comfy.mjs";
import {
  loadState, nextVersion, resolveMain, setMain, versionsOf,
  nextFinalVersion, getKeyframeRefFrom, setKeyframeRefFrom, isPinnedState,
} from "./sequence_state.mjs";
import { normalizeClipToSpec, probeClipSpec } from "./lipsync.mjs";
import { fileSlug } from "./variant.mjs";
import { genBeatAudio, dialogueWavFile, audioDuration } from "./tts.mjs";

function dialogueLinesOf(beat) {
  const d = beat && Array.isArray(beat.dialogue) ? beat.dialogue : [];
  return d.filter((x) => x && String(x.line || "").trim());
}

// ---------------------------------------------------------------- consistency
// Reference<->video mismatch fix: reference images are pure t2i from
// cfg.referencePrompt/cfg.character, while keyframes used to send ONLY
// beat.image and clips ONLY beat.motion. When the LLM (or a hand edit)
// drops the character block from a beat, Flux img2img + LTX/Wan i2v freely
// redesign the face/outfit — the video no longer matches the reference.
//
// Enforced here (generation time, all projects) so no authoring path can
// drop grounding: every keyframe carries the character + reference identity,
// every clip carries the fidelity lock (animate the keyframe, never redesign).

/**
 * Clip fidelity lock: the i2v model must only animate THIS scene's own
 * keyframe image — never redesign, restyle, morph or distort it — at 8k
 * clarity. The clip's frame 0 must match the scene's keyframe image.
 */
export const CLIP_FIDELITY_SUFFIX =
  "Keep the exact character, face, clothing, colors, lighting and background from the input image — do not redesign, restyle or change anything; animate natural motion only, highly clear 8k uhd quality, smooth natural motion, no distortion, no distorted faces, no deformed faces, no morphing, no flicker, no extra limbs, no blurry, no low quality";

const includesHead = (haystack, needle) => {
  const h = String(haystack || "").toLowerCase();
  const probe = String(needle || "").trim().slice(0, 24).toLowerCase();
  return !probe || h.includes(probe);
};

/**
 * Keyframe prompt with context grounding: beat image (which already carries
 * the scene's character + location + object identities and style lock from
 * boardToScenario) + missing cfg.character / cfg.referencePrompt appended
 * (probe-matched, never doubled). Verbatim otherwise — no quality tokens
 * are appended (opt back in via withQualityImage where wanted).
 */
export function keyframePromptFor(beatImage, cfg) {
  let t = String(beatImage || "").trim();
  const character = String((cfg && cfg.character) || "").trim();
  const ref = String((cfg && cfg.referencePrompt) || "").trim();
  if (character && !includesHead(t, character)) {
    t = t ? `${t}, ${character}` : character;
  }
  if (ref && !includesHead(t, ref)) {
    t = t ? `${t}, ${ref}` : ref;
  }
  return t;
}

/**
 * Motion prompt with the fidelity + quality lock appended unless already
 * present. The motion animates THIS scene's own keyframe only.
 */
export function motionPromptFor(motion) {
  const t = String(motion || "").trim();
  if (!t) return CLIP_FIDELITY_SUFFIX;
  const hasFidelity = t.toLowerCase().includes("animate natural motion only");
  const hasQuality = /8k uhd quality|no distortion|no morphing/i.test(t);
  if (hasFidelity && hasQuality) return t;
  if (hasFidelity) return withQualityMotion(t);
  return `${t}, ${CLIP_FIDELITY_SUFFIX}`;
}

/**
 * Text-continuity wording for connected movies/documentaries (devotional
 * Shiv/Ram/Krishna cuts): prompt suffix on beats N>1 so the i2v model holds
 * the same face/clothing/lighting and animates forward instead of cutting.
 * Pixels always stay per-scene (every clip animates its own keyframe) — this
 * suffix is wording only, never a cross-scene frame input.
 */
export const CHAIN_MOTION_SUFFIX =
  "seamless continuation from the previous shot's last frame — hold the exact same character, face, clothing, colors, lighting and background from the input image, no cut, no scene jump, smooth continuous motion forward";

function probeDuration(file) {
  try {
    const out = execFileSync("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" }).trim();
    const dur = Number(out);
    return Number.isFinite(dur) && dur > 0 ? dur : 0;
  } catch { return 0; }
}

/** Dub fallback: mux the dialogue voice onto the clip (looped to fit) when
 *  true lip-sync is unavailable — the beat still speaks with the right voice
 *  and length. Stored as a new clip version + clip main, same convention.
 *  Normalized to the pre-sync clip's concat spec (AAC 48kHz stereo — the TTS
 *  wav is 16kHz mono) so the `-c copy` final-cut stitch stays safe. */
function muxVoiceOntoClip({ outDir, prefix, n, title, clipFile, wavFile, tag }) {
  const clipPath = path.join(outDir, clipFile);
  const wavPath = path.join(outDir, wavFile);
  const audioDur = probeDuration(wavPath);
  if (!audioDur) throw new Error(`dialogue dub: unreadable audio ${wavFile}`);
  const target = Math.ceil((audioDur + 0.25) * 10) / 10;
  const spec = probeClipSpec(clipPath);
  const vf = (spec && spec.width && spec.height)
    ? ["-vf", `scale=${spec.width}:${spec.height},fps=${spec.fps || 24}`] : [];
  const work = path.join(outDir, `dub_tmp_${n}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    const cover = path.join(work, "cover.mp4");
    const clipDur = probeDuration(clipPath);
    let src = clipPath;
    if (clipDur < target) {
      const reps = Math.max(2, Math.ceil(target / Math.max(clipDur, 0.1)) + 1);
      const list = `${cover}.list.txt`;
      fs.writeFileSync(list,
        Array(reps).fill(`file '${clipPath.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
        "-i", list, "-t", String(target), "-c", "copy", cover]);
      try { fs.unlinkSync(list); } catch { /* keep going */ }
      src = cover;
    }
    const v = nextVersion(outDir, prefix, "clip", n, ".mp4", title);
    const dest = path.join(outDir, v === 1
      ? `${prefix}_clip${n}_${fileSlug(title)}.mp4`
      : `${prefix}_clip${n}_${fileSlug(title)}_v${v}.mp4`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-i", wavPath,
      "-map", "0:v", "-map", "1:a", ...vf, "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", dest]);
    const mainFile = path.basename(dest);
    setMain(outDir, prefix, "clip", n, title, mainFile, { pinned: false });
    console.log(`${tag} beat ${n} dialogue dubbed (voice muxed) -> ${mainFile}`);
    console.log(`[asset] ${JSON.stringify({ kind: "video", file: mainFile, stage: "clip", index: n, dubbed: true })}`);
    return mainFile;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Strip engine/format suffixes to get the base project name. */
function baseProjectOf(prefix) {
  let s = String(prefix || "");
  if (s.endsWith("_vertical")) s = s.slice(0, -"_vertical".length);
  if (s.endsWith("_wan")) s = s.slice(0, -"_wan".length);
  return s;
}

/**
 * Resolve the reference image every keyframe must anchor on: the version
 * selected as "main" in this output dir, falling back to the main ref of a
 * sibling dir (same project, other engine/format) so an upload once covers
 * ltx/wan/vertical runs. Returns { file, fullPath, fromDir? } with
 * file=null when no reference exists anywhere yet.
 */
export function resolveRefForRun(outDir, prefix) {
  // Explicit deselect (gallery main toggled off): no reference input at all —
  // not even a sibling cut's. Reference pixels only condition generation
  // again after an explicit pick / upload / fresh generation.
  try {
    if (loadState(outDir).refOff) return { file: null, fullPath: null };
  } catch { /* fall through to normal resolution */ }
  const own = resolveMain(outDir, prefix, "ref", 0, ".png", null, loadState(outDir));
  if (own && fs.existsSync(path.join(outDir, own))) {
    return { file: own, fullPath: path.join(outDir, own) };
  }
  try {
    const parent = path.dirname(outDir);
    const base = baseProjectOf(prefix);
    for (const suffix of ["", "_wan", "_vertical", "_wan_vertical"]) {
      const dirName = `${base}${suffix}`;
      if (dirName === prefix) continue;
      const dir = path.join(parent, dirName);
      if (!fs.existsSync(dir)) continue;
      const f = resolveMain(dir, dirName, "ref", 0, ".png", null, loadState(dir));
      if (f && fs.existsSync(path.join(dir, f))) {
        return { file: f, fullPath: path.join(dir, f), fromDir: dirName };
      }
    }
  } catch { /* no fallback — pure text-to-image */ }
  return { file: null, fullPath: null };
}

/**
 * Is beat n's keyframe already done AND still valid under the current
 * reference main? Explicit staleness probe (used for the
 * already-generated-but-old-reference hint + explicit --regen flows): an
 * existing keyframe counts as up-to-date unless we POSITIVELY know the
 * reference main changed since it was built (recorded refFrom differs).
 * Unknown provenance (refFrom null) counts as up-to-date. Full Generate runs
 * do NOT auto-heal on this predicate — they are missing-only (any version on
 * disk is skipped); rebuild stale scenes explicitly via --regen.
 */
export function keyframeUpToDate(outDir, prefix, index, title, refMain) {
  if (!versionsOf(outDir, prefix, "seq", index, ".png", title).length) return false;
  const builtFrom = getKeyframeRefFrom(outDir, index);
  return builtFrom == null || builtFrom === refMain;
}

/**
 * Run (or resume) the full character sequence.
 * @param {object} o
 *   scenario, outDir, prefix, tag, cfg,
 *   buildRef(prompt)            -> Flux graph for the reference image
 *   buildKeyframe(prompt, i, refImage?) -> Flux graph for beat i (1-based;
 *     refImage = ComfyUI input-folder filename of the reference visual,
 *     null = no reference yet, fall back to pure text-to-image)
 *   buildClip(motion, image, i) -> i2v graph for beat i
 *   videoNode                   -> SaveVideo node id (LTX "75", Wan "56")
 *   regen?: { kind: "ref"|"keyframe"|"clip", index: number }  -> generate only this asset
 */
export async function runSequence({
  scenario, outDir, prefix, tag, cfg,
  buildRef, buildKeyframe, buildClip, videoNode, regen,
  noDialogue = false,
  chain = false,
  imageMode: imageModeOpt,
}) {
  // --chain (or cfg.chainContinuity): chained beats carry "seamless
  // continuation" TEXT wording in their motion prompts. Pixels always stay
  // per-scene (every clip animates its own keyframe). Explicit flag wins;
  // scenario config opts in devotional boards automatically
  // (see lib/documentary.mjs boardToScenario).
  chain = !!(chain || cfg.chain === true || cfg.chainContinuity === true);
  if (chain) {
    console.log(`${tag} continuity: CHAINED wording — clips carry seamless-continuation text but still animate their own keyframes`);
  }
  const seq = cfg.sequence;
  const N = seq.length;
  const finalBase = `${prefix}_final.mp4`;
  // Every stitch writes a NEW final-cut version (v1 = <prefix>_final.mp4,
  // vN = <prefix>_final_vN.mp4) and never overwrites previous stitches.
  const nextFinalPath = () => {
    const v = nextFinalVersion(outDir, prefix);
    return path.join(outDir, v === 1 ? finalBase : `${prefix}_final_v${v}.mp4`);
  };

  const asset = (kind, file, stage, index) =>
    console.log(`[asset] ${JSON.stringify({ kind, file, stage, index })}`);

  // Reference lock: resolved ONCE per full run (after genRef, so a freshly
  // generated ref is included) and shared by every keyframe in that run. A
  // mid-run main switch therefore can no longer split one run across two
  // anchors (half the beats on ref A, half on ref B) — it applies to the
  // next run instead, which heals stale beats via keyframeUpToDate.
  // Single-asset --regen calls resolve fresh (explicit user action).
  let runRef = null;

  // imageMode: "flux" = pure text-to-image (no reference), "flux_text_image" = reference-based
  const imageMode = imageModeOpt ?? cfg.imageMode ?? "flux_text_image";

  // force=true (regen) always writes a fresh version; force=false (full run)
  // skips the asset when any version already exists on disk (resume).
  // A freshly generated version always becomes the selected main (regen v4
  // with v1/v2/v3 on disk selects v4); skips keep the current selection.
  const genRef = async (force = false) => {
    let newFile = null;
    if (imageMode === "flux" && !force) {
      console.log(`${tag} reference — imageMode is "flux", skipping reference generation (pure text-to-image)`);
    } else if (!force && versionsOf(outDir, prefix, "ref", 0, ".png").length) {
      console.log(`${tag} reference — already generated, skipping`);
    } else {
      const v = nextVersion(outDir, prefix, "ref", 0, ".png");
      const dest = path.join(outDir, v === 1 ? `${prefix}_ref.png` : `${prefix}_ref_v${v}.png`);
      if (fs.existsSync(dest)) {
        console.log(`${tag} reference — v${v} exists, skipping`);
      } else {
        console.log(`${tag} reference image (v${v})...`);
        const refGraph = buildRef(cfg.referencePrompt);
        if (refGraph["75:73"] && refGraph["75:73"].inputs) {
          refGraph["75:73"].inputs.noise_seed = hashSeed(`${prefix}:ref:v${v}`);
        }
        const entry = await run(refGraph);
        await download(firstImageUrl(entry), dest);
        newFile = path.basename(dest);
      }
    }
    // A freshly generated version NEVER selects itself: reference input is
    // explicit-only (checkbox / click / upload), so the new file just lists
    // in the gallery and the previous pick (or none) stays in effect.
    // A skip keeps the current pick untouched.
    const refState = loadState(outDir);
    if (newFile) {
      asset("image", newFile, "reference");
      return;
    }
    const resolved = resolveMain(outDir, prefix, "ref", 0, ".png", null, refState);
    if (resolved == null) {
      console.log(refState.refOff
        ? `${tag} reference — deselected, skipping (keyframes run text-only)`
        : `${tag} reference — no version selected, skipping (keyframes run text-only)`);
      return;
    }
    const mainFile = path.basename(resolved);
    setMain(outDir, prefix, "ref", 0, null, mainFile, { pinned: isPinnedState(refState, "ref", 0) });
    asset("image", mainFile, "reference");
  };

  const genKeyframe = async (i, force = false) => {
    const n = i + 1;
    // Anchor rule (same-scene linkage): EVERY keyframe anchors on the run's
    // reference main (runRef). The reference pixels + the beat's full scene
    // context (character/location/object identities in beat.image) condition
    // the Flux img2img call, so the keyframe is the context rendered through
    // the reference identity — never a fresh redesign. Consecutive-scene
    // continuity is carried by TEXT (continuity_from_previous_scene inside
    // beat.image), not by chaining pixels from the previous keyframe, so a
    // keyframe always matches its own scene's reference.
    // Resume rule (pure missing-only): a full Generate NEVER regenerates an
    // asset that already has a version on disk — it only fills what is
    // missing, then stitches. A recorded ref-main switch does NOT force a
    // regen here (that is what made every post-Generate-Reference Generate
    // redo all scenes + clips); it is surfaced as a hint below and heals
    // explicitly via --regen keyframe N (which also rebuilds its clip).
    // Unknown provenance (refFrom null) trivially keeps the file.
    const ref = runRef ?? resolveRefForRun(outDir, prefix);
    const refMain = ref.file;
    const anchorFile = refMain;
    const anchorPath = ref.fullPath;
    const anchorLabel = refMain == null ? "none (text-to-image)"
      : `${refMain}${ref.fromDir ? ` (${ref.fromDir})` : ""}`;
    if (!keyframeUpToDate(outDir, prefix, n, seq[i].title, refMain)) {
        const builtFrom = getKeyframeRefFrom(outDir, n);
        console.log(`${tag} keyframe ${n}/${N} (${seq[i].title}) — already generated, skipping (built from ${builtFrom ?? "none"}, ref main is now ${refMain ?? "none"} — --regen keyframe ${n} to rebuild from the new reference)`);
      } else {
        console.log(`${tag} keyframe ${n}/${N} (${seq[i].title}) — already generated, skipping`);
      }
    let generated = force;
    let newFile = null;
    if (!force && versionsOf(outDir, prefix, "seq", n, ".png", seq[i].title).length) {
      // skip — any version on disk counts as done (pure resume)
    } else {
      const v = nextVersion(outDir, prefix, "seq", n, ".png", seq[i].title);
      const dest = path.join(outDir, v === 1 ? `${prefix}_seq${n}_${fileSlug(seq[i].title)}.png` : `${prefix}_seq${n}_${fileSlug(seq[i].title)}_v${v}.png`);
      if (!force && fs.existsSync(dest)) {
        console.log(`${tag} keyframe ${n}/${N} — v${v} exists, skipping`);
      } else {
        // Anchor on the picked reference: upload it and run Flux img2img from
        // it so its pixels actually condition the keyframe. Falls back to
        // pure text-to-image whenever no reference is picked (reference input
        // is explicit-only — Generate/checkbox/click/upload).
        let refInput = null;
        if (anchorFile && anchorPath && fs.existsSync(anchorPath)) {
          refInput = await uploadToInput(anchorPath, `${prefix}_kfAnchor${n}`);
        } else {
          console.log(`${tag} keyframe ${n}/${N} — no reference yet, text-to-image only`);
        }
        console.log(`${tag} keyframe ${n}/${N} (${seq[i].title}, v${v}) from ${anchorLabel}...`);
        // Character consistency: pin the sampler seed per beat+version
        // (deterministic — same inputs reproduce, a regen takes a fresh take)
        // instead of pure random, so faces drift less between scenes.
        // Overridden post-build (both Flux graphs sample at 75:73), so the
        // buildKeyframe(prompt, i, refImage) shape stays untouched.
        // Text lock: always re-ground the beat prompt on cfg.character /
        // cfg.referencePrompt (keyframePromptFor only appends what's missing,
        // verbatim otherwise) so the keyframe can't drift off the authored
        // reference identity — in every image mode, including pure-t2i flux.
        const kfPrompt = keyframePromptFor(seq[i].image, cfg);
        const kfGraph = buildKeyframe(kfPrompt, i, refInput);
        if (kfGraph["75:73"] && kfGraph["75:73"].inputs) {
          kfGraph["75:73"].inputs.noise_seed = hashSeed(`${prefix}:kf${n}:v${v}`);
        }
        const entry = await run(kfGraph);
        await download(firstImageUrl(entry), dest);
        generated = true;
        newFile = path.basename(dest);
      }
      // Remember which ref main this version was built from (null = no ref).
      setKeyframeRefFrom(outDir, n, refMain);
    }
    // A freshly generated version becomes the selected main (regen v4 with
    // v1/v2/v3 on disk selects v4); skips keep the current selection and its
    // pin (see genRef — a skip must never silently unpin a user's pick).
    const kfState = loadState(outDir);
    const mainFile = newFile ?? path.basename(resolveMain(outDir, prefix, "seq", n, ".png", seq[i].title, kfState));
    setMain(outDir, prefix, "seq", n, seq[i].title, mainFile, { pinned: newFile ? false : isPinnedState(kfState, "seq", n) });
    asset("image", mainFile, "keyframe", n);
    return generated;
  };

  const genClip = async (i, force = false) => {
    const n = i + 1;
    const beat = seq[i];
    const lines = noDialogue ? [] : dialogueLinesOf(beat);
    const ttsCfg = cfg.tts && typeof cfg.tts === "object" ? cfg.tts : {};
    // DIALOGUE-FIRST (Generate includes voice + lip-sync): synthesize the
    // voice BEFORE the clip request so the ComfyUI duration is sized from the
    // REAL audio length (long lines -> long clips, short lines stay short).
    // Resumable like every other asset (existing wav is kept). Best-effort:
    // a missing edge-tts binary warns and the beat stays silent instead of
    // failing the whole run.
    let wavBase = null;
    if (lines.length) {
      try {
        const r = genBeatAudio({ outDir, prefix, n, title: beat.title, dialogue: lines, ttsCfg, tag, beat });
        wavBase = r.file;
      } catch (e) {
        console.log(`${tag} beat ${n} dialogue voice skipped: ${String(e.message || e).slice(0, 200)}`);
        wavBase = null;
      }
    }
    let newFile = null;
    if (!force && versionsOf(outDir, prefix, "clip", n, ".mp4", beat.title).length) {
      console.log(`${tag} clip ${n}/${N} (${beat.title}) — already generated, skipping`);
    } else {
      const v = nextVersion(outDir, prefix, "clip", n, ".mp4", beat.title);
      const dest = path.join(outDir, v === 1 ? `${prefix}_clip${n}_${fileSlug(beat.title)}.mp4` : `${prefix}_clip${n}_${fileSlug(beat.title)}_v${v}.mp4`);
      if (fs.existsSync(dest)) {
        console.log(`${tag} clip ${n}/${N} — v${v} exists, skipping`);
      } else {
        // Same-scene linkage (mandatory): a clip is ALWAYS generated from
        // its OWN keyframe main image. Starting beat N from beat N-1's last
        // frame made the video show the wrong scene/face/location versus the
        // displayed keyframe image — that pixel chaining is removed. Chain
        // mode now contributes TEXT continuity only (CHAIN_MOTION_SUFFIX
        // wording), while pixels stay strictly per-scene: frame 0 of clip N
        // == keyframe N.
        // Fidelity lock first: the clip must animate its keyframe, never
        // redesign the character — a motion-only beat without the lock lets
        // the i2v model drift off the reference look.
        let motion = motionPromptFor(beat.motion);
        if (chain && n > 1 && !/seamless continuation/i.test(String(motion || ""))) {
          motion = `${String(motion || "").trim()}${String(motion || "").trim() ? ", " : ""}${CHAIN_MOTION_SUFFIX}`;
        }
        const kfFile = resolveMain(outDir, prefix, "seq", n, ".png", beat.title, loadState(outDir));
        if (!kfFile) throw new Error(`no keyframe for beat ${n} — generate it first`);
        const startLabel = kfFile;
        console.log(`${tag} i2v clip ${n}/${N} (${beat.title}, v${v}) from own keyframe ${startLabel}...`);
        const inputName = await uploadToInput(path.join(outDir, kfFile), `${prefix}_kf${n}`);
        // buildClip reads beatTargetDuration live, so the wav synthesized
        // above already grew this request to the dialogue length.
        const entry = await run(buildClip(motion, inputName, i), `clip${n}`);
        await download(firstVideoUrl(entry, videoNode), dest);
        newFile = path.basename(dest);
      }
    }
    // A freshly generated version becomes the selected main (so the next
    // stitch uses it); skips keep the current selection and its pin.
    const clipState = loadState(outDir);
    let mainFile = newFile ?? path.basename(resolveMain(outDir, prefix, "clip", n, ".mp4", beat.title, clipState));
    setMain(outDir, prefix, "clip", n, beat.title, mainFile, { pinned: newFile ? false : isPinnedState(clipState, "clip", n) });
    asset("video", mainFile, "clip", n);
    // DIALOGUE-SECOND: lip-sync the clip to its voice so Generate lands
    // talking videos directly (no separate pass needed). A synced take is a
    // new clip version + clip main. Best-effort with honest fallback:
    // Easy-Wav2Lip when installed (true lip-sync, frontal close-ups pass its
    // face check), else the voice muxed over the clip (dubbed — speaks with
    // the right voice/length, no mouth movement). Skipped when the main is
    // already newer than the wav (resume: already synced).
    if (lines.length && wavBase) {
      let synced = false;
      try {
        const wavT = fs.statSync(path.join(outDir, wavBase)).mtimeMs;
        const clipT = fs.statSync(path.join(outDir, mainFile)).mtimeMs;
        synced = clipT + 1 >= wavT && !newFile;
      } catch { synced = false; }
      if (!synced) {
        try {
          const { lipSyncBeat } = await import("./lipsync.mjs");
          mainFile = lipSyncBeat({ outDir, prefix, n, title: beat.title, clipFile: mainFile, wavFile: wavBase, tag });
        } catch (e) {
          console.log(`${tag} beat ${n} lip-sync unavailable (${String(e.message || e).slice(0, 160)}) — dubbing voice instead`);
          try {
            mainFile = muxVoiceOntoClip({ outDir, prefix, n, title: beat.title, clipFile: mainFile, wavFile: wavBase, tag });
          } catch (e2) {
            console.log(`${tag} beat ${n} dialogue dub failed: ${String(e2.message || e2).slice(0, 200)} — keeping silent clip`);
          }
        }
      }
    }
  };

  // --regen: generate a single asset (or its downstream chain) and re-stitch.
  const stitch = (requireAll = true) => {
    const st = loadState(outDir);
    const picks = [];
    for (let i = 0; i < seq.length; i++) {
      const file = resolveMain(outDir, prefix, "clip", i + 1, ".mp4", seq[i].title, st);
      if (!file) {
        if (requireAll) throw new Error(`no clip for beat ${i + 1} (${seq[i].title}) — generate it before stitching`);
        console.log(`${tag} final cut skipped — beat ${i + 1} (${seq[i].title}) has no clip yet`);
        return false;
      }
      picks.push(file);
    }
    // No scenes (or nothing stitchable) — never feed an empty list to
    // ffmpeg (it exits non-zero and fails the whole run, e.g. a reference
    // batch on a project with no beats yet).
    if (!picks.length) {
      console.log(`${tag} final cut skipped — no scenes to stitch yet`);
      return false;
    }
    const finalPath = nextFinalPath();
    const finalFile = stitchFiles({ outDir, picks, finalPath, tag });
    console.log(`${tag} final cut (${picks.length} clips) -> ${finalPath}`);
    return finalFile;
  };
  if (regen) {
    const { kind, index } = regen;
    if (kind === "ref") await genRef(true);
    else {
      if (index < 1 || index > N) throw new Error(`beat ${index} out of range (1..${N})`);
      if (kind === "keyframe") {
        await genKeyframe(index - 1, true);
      } else if (kind === "clip") await genClip(index - 1, true);
      else throw new Error(`unknown regen kind: ${kind}`);
    }
    const finalFile = stitch(false);
    if (finalFile) asset("video", finalFile, "final");
    console.log(`${tag} DONE`);
    return;
  }

  // Full run (resumable, missing-only: assets that already have a version on
  // disk are skipped, so a re-run only generates what is missing, then
  // stitches). A newly built keyframe forces its own clip to build too
  // (same scene only), otherwise the final cut would keep video generated
  // from an older keyframe version. An existing keyframe built from an older
  // ref main is KEPT (hint logged in genKeyframe) — rebuild it explicitly
  // via --regen keyframe N when the new reference look is wanted.
  await genRef();
  // Lock the anchor for this run (see runRef above): every NEW keyframe below
  // resolves to the same reference image, even if the user flips the main
  // mid-run.
  runRef = resolveRefForRun(outDir, prefix);
  console.log(`${tag} reference lock: every keyframe anchors on ${runRef.file ?? "none (text-to-image)"}${runRef.fromDir ? ` (from ${runRef.fromDir})` : ""}; every clip animates its own keyframe${chain ? " (chain wording only, pixels stay per-scene)" : ""}`);
  // Resume marker (log/Terminal only — the skips below do the actual work):
  // after Stop -> Generate the run visibly continues from the first scene
  // still missing a keyframe or clip version instead of looking like a
  // scene-1 restart. Pure disk check: any version on disk counts as done.
  {
    const sceneDone = (i) =>
      versionsOf(outDir, prefix, "seq", i + 1, ".png", seq[i].title).length > 0 &&
      versionsOf(outDir, prefix, "clip", i + 1, ".mp4", seq[i].title).length > 0;
    const firstMissing = seq.findIndex((_, i) => !sceneDone(i));
    if (firstMissing > 0) {
      console.log(`[resume] ${JSON.stringify({ from: firstMissing + 1, total: N })}`);
    }
  }
  const kfRegen = new Set();
  for (let i = 0; i < N; i++) {
    // Per-scene pixels: keyframes never chain, so a regen affects only its
    // own beat (no downstream cascade).
    if (await genKeyframe(i)) kfRegen.add(i + 1);
  }
  // Per-scene pixels: a clip starts from its OWN keyframe, so a keyframe
  // change forces only its own clip — never later beats.
  const clipChanged = async (i, force, reason) => {
    if (reason) console.log(reason);
    const before = versionsOf(outDir, prefix, "clip", i + 1, ".mp4", seq[i].title).length;
    await genClip(i, force);
    const after = versionsOf(outDir, prefix, "clip", i + 1, ".mp4", seq[i].title).length;
    return force || after > before;
  };
  for (let i = 0; i < N; i++) {
    if (kfRegen.has(i + 1)) {
      await clipChanged(i, true,
        `${tag} clip ${i + 1}/${N} (${seq[i].title}) — keyframe changed, regenerating...`);
    } else {
      await genClip(i);
    }
  }
  const finalFile = stitch();
  if (finalFile) asset("video", finalFile, "final");
  console.log(`${tag} DONE`);
}

/**
 * Concat-safe final-cut stitch.
 *
 * The fast path is the historical `ffmpeg concat -c copy` (lossless, instant)
 * — valid only when every picked clip shares codec/resolution/fps/pix_fmt AND
 * audio layout. Lip-synced takes used to break that invariant (Wav2Lip muxes
 * the raw 16kHz mono TTS wav; takes now self-normalize on creation, but
 * legacy takes and mixed engine/format projects can still mismatch), which
 * showed up as a final cut that freezes/corrupts exactly at the mismatched
 * beat while the single-clip download plays fine.
 *
 * When the picks are uniform the behavior is byte-for-byte the old path.
 * Otherwise only the mismatched picks are re-encoded into a temp dir to the
 * first clip's video spec (+ AAC 48kHz stereo when ANY pick carries audio,
 * silent-filled for picks without it, so voices are never stripped), then the
 * same `-c copy` concat runs over the uniform list.
 */
export function stitchFiles({ outDir, picks, finalPath, tag }) {
  const abs = picks.map((f) => path.join(outDir, f));
  const specs = abs.map((f) => probeClipSpec(f));
  const base = specs[0];
  const same = (s) => !!(s && base &&
    s.width === base.width && s.height === base.height &&
    Math.abs(s.fps - base.fps) < 0.02 &&
    s.pixFmt === base.pixFmt && s.vcodec === base.vcodec &&
    s.hasAudio === base.hasAudio && s.sampleRate === base.sampleRate &&
    s.channels === base.channels && s.acodec === base.acodec);
  let listFiles = abs;
  let tmpDir = null;
  if (!base || !specs.every(same)) {
    const wantAudio = specs.some((s) => s && s.hasAudio);
    const refW = (base && base.width) || 960;
    const refH = (base && base.height) || 512;
    const refFps = (base && base.fps) || 24;
    console.log(`${tag} clips differ in codec/audio params — normalizing mismatched takes to ${refW}x${refH}@${refFps}${wantAudio ? " + AAC 48kHz stereo" : ""} before stitch...`);
    tmpDir = path.join(outDir, "stitch_norm_tmp");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const vf = `scale=${refW}:${refH},fps=${refFps}`;
    listFiles = abs.map((f, i) => {
      if (specs[i] && same(specs[i])) return f;
      const tmp = path.join(tmpDir, `norm${i}.mp4`);
      const s = specs[i];
      if (s && !s.hasAudio && !wantAudio) {
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", f,
          "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", tmp]);
      } else if (!s || !s.hasAudio) {
        // Silent pick in a voiced project — inject silent stereo so the
        // concat layout stays identical (voices elsewhere are preserved).
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", f,
          "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
          "-map", "0:v", "-map", "1:a", "-vf", vf,
          "-c:v", "libx264", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", tmp]);
      } else {
        normalizeClipToSpec(f, tmp, { width: refW, height: refH, fps: refFps });
        if (!wantAudio) {
          const stripped = tmp + ".v.mp4";
          execFileSync("ffmpeg", ["-y", "-v", "error", "-i", tmp,
            "-c:v", "copy", "-an", stripped]);
          fs.renameSync(stripped, tmp);
        }
      }
      return tmp;
    });
  }
  try {
    const list = path.join(outDir, "concat_list.txt");
    fs.writeFileSync(list,
      listFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
      "-i", list, "-c", "copy", finalPath], { stdio: "inherit" });
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return path.basename(finalPath);
}

/** Re-stitch the final cut from the currently selected main versions. */
export function stitchSequence({ scenario, outDir, prefix, tag, cfg }) {
  const seq = cfg.sequence;
  const st = loadState(outDir);
  const picks = [];
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    const file = resolveMain(outDir, prefix, "clip", i + 1, ".mp4", s.title, st);
    if (!file) throw new Error(`no clip for beat ${i + 1} (${s.title}) — generate it before stitching`);
    picks.push(file);
  }
  // Never feed an empty list to ffmpeg (exits non-zero) — a sceneless
  // project simply has no final cut yet.
  if (!picks.length) {
    console.log(`${tag} final cut skipped — no scenes to stitch yet`);
    return null;
  }
  const v = nextFinalVersion(outDir, prefix);
  const finalPath = path.join(outDir, v === 1 ? `${prefix}_final.mp4` : `${prefix}_final_v${v}.mp4`);
  stitchFiles({ outDir, picks, finalPath, tag });
  console.log(`[asset] ${JSON.stringify({ kind: "video", file: path.basename(finalPath), stage: "final" })}`);
  console.log(`${tag} final cut (${picks.length} clips) -> ${finalPath}`);
}
