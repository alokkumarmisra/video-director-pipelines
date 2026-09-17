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
} from "./comfy.mjs";
import {
  loadState, nextVersion, resolveMain, setMain, versionsOf,
  nextFinalVersion, getKeyframeRefFrom, setKeyframeRefFrom, isPinnedState,
} from "./sequence_state.mjs";
import { fileSlug } from "./variant.mjs";

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
 * reference main? Resume predicate for Stop -> Generate: an existing
 * keyframe is kept (skipped) unless we POSITIVELY know the reference main
 * changed since it was built (recorded refFrom differs). Unknown provenance
 * (refFrom null — pre-tracking state, or a state.json lost to a kill before
 * atomic writes existed) must NEVER force a regen: treating "don't know" as
 * stale is what made every post-Stop Generate redo all scenes from scene 1
 * (and, via kfRegen, every clip too). A genuine ref switch still heals, and
 * any single scene can always be redone explicitly via --regen.
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
}) {
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

  // force=true (regen) always writes a fresh version; force=false (full run)
  // skips the asset when any version already exists on disk (resume).
  // A freshly generated version always becomes the selected main (regen v4
  // with v1/v2/v3 on disk selects v4); skips keep the current selection.
  const genRef = async (force = false) => {
    let newFile = null;
    if (!force && versionsOf(outDir, prefix, "ref", 0, ".png").length) {
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
    // A skip keeps the current selection AND its pin (a user-picked v3 must
    // not silently become auto-latest v4 on the next reload); only a freshly
    // generated version takes main as auto (a regen overrides the pin).
    const refState = loadState(outDir);
    const mainFile = newFile ?? path.basename(resolveMain(outDir, prefix, "ref", 0, ".png", null, refState));
    setMain(outDir, prefix, "ref", 0, null, mainFile, { pinned: newFile ? false : isPinnedState(refState, "ref", 0) });
    asset("image", mainFile, "reference");
  };

  const genKeyframe = async (i, force = false) => {
    const n = i + 1;
    // Every keyframe must anchor on the reference selected as "main" (own
    // dir first, sibling engine/format dir as fallback). Switching the main
    // ref after keyframes exist makes them stale — a full run regenerates
    // them instead of skipping, so no image is ever left on an old ref.
    // Resume rule (see keyframeUpToDate): only a RECORDED mismatch forces a
    // regen — unknown provenance keeps the file, so a post-Stop Generate
    // continues from the last stopped scene instead of redoing scene 1.
    const ref = resolveRefForRun(outDir, prefix);
    const refMain = ref.file;
    let stale = false;
    if (!force && versionsOf(outDir, prefix, "seq", n, ".png", seq[i].title).length) {
      if (!keyframeUpToDate(outDir, prefix, n, seq[i].title, refMain)) {
        const builtFrom = getKeyframeRefFrom(outDir, n);
        stale = true;
        console.log(`${tag} keyframe ${n}/${N} (${seq[i].title}) — ref main is now ${refMain ?? "none"} (was ${builtFrom ?? "none"}), regenerating...`);
      } else {
        console.log(`${tag} keyframe ${n}/${N} (${seq[i].title}) — already generated, skipping`);
      }
    }
    let generated = stale || force;
    let newFile = null;
    if (!force && !stale && versionsOf(outDir, prefix, "seq", n, ".png", seq[i].title).length) {
      // skip — already on the current main ref
    } else {
      const v = nextVersion(outDir, prefix, "seq", n, ".png", seq[i].title);
      const dest = path.join(outDir, v === 1 ? `${prefix}_seq${n}_${fileSlug(seq[i].title)}.png` : `${prefix}_seq${n}_${fileSlug(seq[i].title)}_v${v}.png`);
      if (!stale && !force && fs.existsSync(dest)) {
        console.log(`${tag} keyframe ${n}/${N} — v${v} exists, skipping`);
      } else {
        // Anchor every scene image on the main reference visual: upload
        // the selected main ref version and run Flux img2img from it, so the
        // reference pixels actually condition the keyframe. Falls back to pure
        // text-to-image only when no reference exists in any dir yet.
        let refInput = null;
        if (refMain) {
          refInput = await uploadToInput(ref.fullPath, `${prefix}_ref${n}`);
        } else {
          console.log(`${tag} keyframe ${n}/${N} — no reference yet, text-to-image only`);
        }
        console.log(`${tag} keyframe ${n}/${N} (${seq[i].title}, v${v})${refInput ? ` from ${refMain}${ref.fromDir ? ` (${ref.fromDir})` : ""}` : ""}...`);
        // Character consistency: pin the sampler seed per beat+version
        // (deterministic — same inputs reproduce, a regen takes a fresh take)
        // instead of pure random, so faces drift less between scenes.
        // Overridden post-build (both Flux graphs sample at 75:73), so the
        // buildKeyframe(prompt, i, refImage) shape stays untouched.
        const kfGraph = buildKeyframe(seq[i].image, i, refInput);
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
    let newFile = null;
    if (!force && versionsOf(outDir, prefix, "clip", n, ".mp4", seq[i].title).length) {
      console.log(`${tag} clip ${n}/${N} (${seq[i].title}) — already generated, skipping`);
    } else {
      const v = nextVersion(outDir, prefix, "clip", n, ".mp4", seq[i].title);
      const dest = path.join(outDir, v === 1 ? `${prefix}_clip${n}_${fileSlug(seq[i].title)}.mp4` : `${prefix}_clip${n}_${fileSlug(seq[i].title)}_v${v}.mp4`);
      if (fs.existsSync(dest)) {
        console.log(`${tag} clip ${n}/${N} — v${v} exists, skipping`);
      } else {
        // A clip is always generated from the keyframe currently selected as main.
        const kfFile = resolveMain(outDir, prefix, "seq", n, ".png", seq[i].title, loadState(outDir));
        if (!kfFile) throw new Error(`no keyframe for beat ${n} — generate it first`);
        console.log(`${tag} i2v clip ${n}/${N} (${seq[i].title}, v${v}) from ${kfFile}...`);
        const inputName = await uploadToInput(path.join(outDir, kfFile), `${prefix}_kf${n}`);
        const entry = await run(buildClip(seq[i].motion, inputName, i), `clip${n}`);
        await download(firstVideoUrl(entry, videoNode), dest);
        newFile = path.basename(dest);
      }
    }
    // A freshly generated version becomes the selected main (so the next
    // stitch uses it); skips keep the current selection and its pin.
    const clipState = loadState(outDir);
    const mainFile = newFile ?? path.basename(resolveMain(outDir, prefix, "clip", n, ".mp4", seq[i].title, clipState));
    setMain(outDir, prefix, "clip", n, seq[i].title, mainFile, { pinned: newFile ? false : isPinnedState(clipState, "clip", n) });
    asset("video", mainFile, "clip", n);
  };

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
      picks.push(`file '${file}'`);
    }
    // No scenes (or nothing stitchable) — never feed an empty list to
    // ffmpeg (it exits non-zero and fails the whole run, e.g. a reference
    // batch on a project with no beats yet).
    if (!picks.length) {
      console.log(`${tag} final cut skipped — no scenes to stitch yet`);
      return false;
    }
    const list = path.join(outDir, "concat_list.txt");
    fs.writeFileSync(list, picks.join("\n") + "\n");
    const finalPath = nextFinalPath();
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", finalPath], { stdio: "inherit" });
    console.log(`${tag} final cut (${picks.length} clips) -> ${finalPath}`);
    return path.basename(finalPath);
  };

  // --regen: generate a single asset (or its downstream chain) and re-stitch.
  if (regen) {
    const { kind, index } = regen;
    if (kind === "ref") await genRef(true);
    else {
      if (index < 1 || index > N) throw new Error(`beat ${index} out of range (1..${N})`);
      if (kind === "keyframe") await genKeyframe(index - 1, true);
      else if (kind === "clip") await genClip(index - 1, true);
      else throw new Error(`unknown regen kind: ${kind}`);
    }
    const finalFile = stitch(false);
    if (finalFile) asset("video", finalFile, "final");
    console.log(`${tag} DONE`);
    return;
  }

  // Full run (resumable: assets that already have a version on disk are
  // skipped, so a re-run only generates what is missing, then stitches).
  // A keyframe rebuilt from a new main ref forces its clip to rebuild too,
  // otherwise the final cut would keep video generated from the old face.
  await genRef();
  // Resume marker (log/Terminal only — the skips below do the actual work):
  // after Stop -> Generate the run visibly continues from the first scene
  // still missing a keyframe or clip version instead of looking like a
  // scene-1 restart. The ref is settled by now, so the same up-to-date rule
  // as genKeyframe applies (unknown provenance counts as complete).
  {
    const refMainNow = resolveRefForRun(outDir, prefix).file;
    const sceneDone = (i) =>
      keyframeUpToDate(outDir, prefix, i + 1, seq[i].title, refMainNow) &&
      versionsOf(outDir, prefix, "clip", i + 1, ".mp4", seq[i].title).length > 0;
    const firstMissing = seq.findIndex((_, i) => !sceneDone(i));
    if (firstMissing > 0) {
      console.log(`[resume] ${JSON.stringify({ from: firstMissing + 1, total: N })}`);
    }
  }
  const kfRegen = new Set();
  for (let i = 0; i < N; i++) {
    if (await genKeyframe(i)) kfRegen.add(i + 1);
  }
  for (let i = 0; i < N; i++) {
    if (kfRegen.has(i + 1)) {
      console.log(`${tag} clip ${i + 1}/${N} (${seq[i].title}) — keyframe changed, regenerating...`);
      await genClip(i, true);
    } else {
      await genClip(i);
    }
  }
  const finalFile = stitch();
  if (finalFile) asset("video", finalFile, "final");
  console.log(`${tag} DONE`);
}

/** Re-stitch the final cut from the currently selected main versions. */
export function stitchSequence({ scenario, outDir, prefix, tag, cfg }) {
  const seq = cfg.sequence;
  const st = loadState(outDir);
  const list = path.join(outDir, "concat_list.txt");
  const picks = [];
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    const file = resolveMain(outDir, prefix, "clip", i + 1, ".mp4", s.title, st);
    if (!file) throw new Error(`no clip for beat ${i + 1} (${s.title}) — generate it before stitching`);
    picks.push(`file '${file}'`);
  }
  // Never feed an empty list to ffmpeg (exits non-zero) — a sceneless
  // project simply has no final cut yet.
  if (!picks.length) {
    console.log(`${tag} final cut skipped — no scenes to stitch yet`);
    return null;
  }
  fs.writeFileSync(list, picks.join("\n") + "\n");
  const v = nextFinalVersion(outDir, prefix);
  const finalPath = path.join(outDir, v === 1 ? `${prefix}_final.mp4` : `${prefix}_final_v${v}.mp4`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", finalPath], { stdio: "inherit" });
  console.log(`[asset] ${JSON.stringify({ kind: "video", file: path.basename(finalPath), stage: "final" })}`);
  console.log(`${tag} final cut (${picks.length} clips) -> ${finalPath}`);
}
