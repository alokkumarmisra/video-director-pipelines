// Shared ComfyUI client + workflow graph builders.
// All scripts in ../scripts import from here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync } from "./sequence_state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- env
// Minimal .env loader (no deps): reads the project root .env, never overrides
// variables already set in the environment.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let [, key, val] = m;
    val = val.replace(/^["'](.*)["']$/, "$1");
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.resolve(__dirname, "../.env"));

export const BASE = (process.env.COMFY_BASE || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("COMFY_BASE is not set. Copy .env.example to .env and set COMFY_BASE there.");
  process.exit(1);
}

// Base workflow JSONs live in <root>/workflows (override with WORKFLOWS_DIR)
const WF_DIR = process.env.WORKFLOWS_DIR || path.resolve(__dirname, "../workflows");
const fluxBase = JSON.parse(fs.readFileSync(path.join(WF_DIR, "flux-t2i.json"), "utf8"));
const ltxBase = JSON.parse(fs.readFileSync(path.join(WF_DIR, "ltx2_5_i2v.json"), "utf8"));
const wanBase = JSON.parse(fs.readFileSync(path.join(WF_DIR, "image_to_video_wan.json"), "utf8"));

// ---------------------------------------------------------------- HTTP core

// Maximum timeout for ALL ComfyUI requests: 30 min.
export const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

// The reverse-proxy tunnel intermittently returns HTML error pages — retry until JSON.
export async function fetchJson(url, opts, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: opts?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        console.log(`  (proxy returned ${r.status}, retrying...)`);
        await sleep(5000 * (i + 1));
        continue;
      }
      const d = await r.json();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ` + JSON.stringify(d));
      return d;
    } catch (e) {
      if (e.message.startsWith("HTTP")) throw e;
      console.log(`  (fetch failed: ${e.message}, retrying...)`);
      await sleep(5000 * (i + 1));
    }
  }
  throw new Error(`fetchJson gave up: ${url}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randSeed = () => Math.floor(Math.random() * 1e15);
// Deterministic seed from a label (FNV-1a, uint32): same inputs always give
// the same seed (reproducible generations), different labels differ. Used for
// keyframe seeds so faces vary less run-to-run; the asset version is part of
// the label so a regen still takes a fresh take.
export const hashSeed = (label) => {
  let h = 0x811c9dc5;
  for (const s of String(label ?? "")) {
    h ^= s.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** Queue a graph, return { number, prompt_id }. */
export async function queue(prompt) {
  return fetchJson(`${BASE}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

/** Poll /history/<id> until the item completes. Returns the history entry. */
export async function wait(promptId, label = "", timeoutMs = REQUEST_TIMEOUT_MS) {
  const t0 = Date.now();
  while (true) {
    const h = await fetchJson(`${BASE}/history/${promptId}`);
    const e = h[promptId];
    if (e) {
      if (e.status?.messages?.some((m) => m[0] === "execution_error"))
        throw new Error(`EXEC ERROR ${label}: ` + JSON.stringify(e.status));
      if (label) console.log(`  ${label} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return e;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timeout waiting for ${label}`);
    await sleep(5000);
  }
}

/** Run a graph end-to-end: queue + wait. */
export async function run(prompt, label = "") {
  const { prompt_id } = await queue(prompt);
  console.log(`  queued ${label || ""} (${prompt_id})`);
  return wait(prompt_id, label);
}

/** Download a /view asset (retries on proxy HTML). */
export async function download(url, dest) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const ct = r.headers.get("content-type") || "";
    if (r.ok && !ct.includes("html")) {
      const buf = Buffer.from(await r.arrayBuffer());
      // Atomic: a Stop (SIGTERM) mid-download must never leave a partial
      // file at the final path — resume would count it as a finished version
      // and skip a corrupt asset forever.
      atomicWriteFileSync(dest, buf);
      return dest;
    }
    console.log(`  (download got ${r.status}/${ct}, retrying...)`);
    await sleep(5000 * (i + 1));
  }
  throw new Error(`download failed: ${url}`);
}

/** Upload a local file into ComfyUI's input folder. Returns the input filename. */
export async function uploadToInput(file, namePrefix = "upload") {
  const buf = fs.readFileSync(file);
  const uniqueFilename = `${namePrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
  const fd = new FormData();
  fd.append("image", new Blob([buf]), uniqueFilename);
  fd.append("overwrite", "false");
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(`${BASE}/upload/image`, { method: "POST", body: fd, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const d = await r.json();
        if (!r.ok) throw new Error("UPLOAD ERROR: " + JSON.stringify(d));
        return d.name || uniqueFilename;
      }
      console.log(`  (upload got ${r.status}/${ct}, retrying...)`);
    } catch (e) {
      if (e.message.startsWith("UPLOAD ERROR")) throw e;
      console.log(`  (upload failed: ${e.message}, retrying...)`);
    }
    await sleep(5000 * (i + 1));
  }
  throw new Error("upload gave up");
}

/** First image URL from a SaveImage node output in a history entry. */
export function firstImageUrl(entry, nodeId = "9") {
  const o = entry.outputs?.[nodeId] || {};
  const imgs = o.images || [];
  if (!imgs.length) throw new Error("no image output");
  const v = imgs[0];
  return viewUrl(v);
}

/** First video URL from a SaveVideo node output in a history entry. */
export function firstVideoUrl(entry, nodeId = "75") {
  const o = entry.outputs?.[nodeId] || {};
  const vids = o.videos || o.images || [];
  if (!vids.length) throw new Error("no video output");
  return viewUrl(vids[0]);
}

/** First audio URL from a SaveAudioAdvanced node output in a history entry. */
export function firstAudioUrl(entry, nodeId = "save") {
  const o = entry.outputs?.[nodeId] || {};
  const aud = o.audio || o.files || o.images || [];
  if (!aud.length) throw new Error("no audio output");
  return viewUrl(aud[0]);
}

/**
 * ACE-Step 1.5 XL Turbo lyrics-to-song graph (API format).
 * Mirrors workflows/Audio/audio_ace_step1_5_xl_turbo.json (UI format — never queued
 * directly; this builder is the queueable equivalent):
 *   UNETLoader (acestep_v1.5_xl_turbo_bf16) -> ModelSamplingAuraFlow (shift)
 *   DualCLIPLoader (qwen 0.6b + 4b, type ace) -> TextEncodeAceStepAudio1.5
 *     (tags/style + lyrics + bpm/duration/key/language) -> KSampler (+ zeroed
 *     negative) -> VAEDecodeAudio -> SaveAudioAdvanced (mp3).
 * @param {object} o { tags, lyrics, duration=120, bpm=95, seed=0, steps=8,
 *   cfg=1, sampler="euler", scheduler="simple", shift=3, timesignature="4",
 *   language="en", keyscale="E minor", cfgScale=2, temperature=0.85,
 *   topP=0.9, topK=0, minP=0, generateAudioCodes=true, prefix }
 */
export function buildAceSongGraph({
  tags, lyrics, duration = 120, bpm = 95, seed = 0, steps = 8, cfg = 1,
  sampler = "euler", scheduler = "simple", shift = 3, timesignature = "4",
  language = "en", keyscale = "E minor", cfgScale = 2, temperature = 0.85,
  topP = 0.9, topK = 0, minP = 0, generateAudioCodes = true,
  prefix = "out/song",
}) {
  const s = seed ?? randSeed();
  return {
    unet: {
      class_type: "UNETLoader",
      inputs: { unet_name: "acestep_v1.5_xl_turbo_bf16.safetensors", weight_dtype: "default" },
    },
    vae: {
      class_type: "VAELoader",
      inputs: { vae_name: "ace_1.5_vae.safetensors" },
    },
    clip: {
      class_type: "DualCLIPLoader",
      inputs: {
        clip_name1: "qwen_0.6b_ace15.safetensors",
        clip_name2: "qwen_4b_ace15.safetensors",
        type: "ace",
        device: "default",
      },
    },
    encode: {
      class_type: "TextEncodeAceStepAudio1.5",
      inputs: {
        clip: ["clip", 0],
        tags: tags || "",
        lyrics: lyrics || "",
        seed: s,
        bpm, duration,
        timesignature, language, keyscale,
        generate_audio_codes: !!generateAudioCodes,
        cfg_scale: cfgScale,
        temperature, top_p: topP, top_k: topK, min_p: minP,
      },
    },
    latent: {
      class_type: "EmptyAceStep1.5LatentAudio",
      inputs: { seconds: duration, batch_size: 1 },
    },
    neg: {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["encode", 0] },
    },
    model_shift: {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: ["unet", 0], shift },
    },
    sampler: {
      class_type: "KSampler",
      inputs: {
        model: ["model_shift", 0],
        positive: ["encode", 0],
        negative: ["neg", 0],
        latent_image: ["latent", 0],
        seed: s,
        steps, cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1,
      },
    },
    decode: {
      class_type: "VAEDecodeAudio",
      inputs: { samples: ["sampler", 0], vae: ["vae", 0] },
    },
    save: {
      class_type: "SaveAudioAdvanced",
      // NOTE: the mp3 sub-widget serializes under the dotted key
      // "format.quality" (probed against /prompt validation) — plain
      // "quality" is rejected as missing.
      inputs: { audio: ["decode", 0], filename_prefix: prefix, format: "mp3", "format.quality": "V0" },
    },
  };
}

function viewUrl(v) {
  return `${BASE}/view?filename=${encodeURIComponent(v.filename)}&subfolder=${encodeURIComponent(v.subfolder || "")}&type=${v.type || "output"}`;
}

/**
 * Audio song-model ids (Create Song tab dropdown). "ace-step" = ACE-Step 1.5
 * XL Turbo, "minimax" = MiniMax Music 3. Unknown values normalize to ace-step.
 */
export const SONG_MODEL_IDS = ["ace-step", "minimax"];
export function normalizeSongModel(v) {
  return v === "minimax" ? "minimax" : "ace-step";
}

/**
 * MiniMax Music 3 lyrics-to-song graph (API format).
 * Mirrors workflows/Audio/audio_minimax_music_3.json (UI format — never queued
 * directly; this builder is the queueable equivalent):
 *   UNETLoader (minimax_music3_dit_fp16) + CLIPLoader (minimax text encoder,
 *   type minimax) + VAELoader (minimax_music3_dav) -> MiniMaxMusic3TextEncode
 *     (caption/style + lyrics + seed + max_duration) -> KSampler (+ zeroed
 *     negative, EmptyMiniMaxMusic3LatentAudio) -> VAEDecodeAudio (or the tiled
 *     variant via ComfySwitchNode) -> SaveAudioAdvanced (mp3).
 * @param {object} o { caption, lyrics, duration=120, seed=0, steps=30, cfg=1.7,
 *   sampler="euler", scheduler="simple", cfgScale=1.7, topK=50, tiled=false,
 *   prefix }
 */
export function buildMinimaxSongGraph({
  caption, lyrics, duration = 120, seed = 0, steps = 30, cfg = 1.7,
  sampler = "euler", scheduler = "simple", cfgScale = 1.7, topK = 50,
  tiled = false, prefix = "out/song",
}) {
  const s = seed ?? randSeed();
  const dur = Math.min(360, Math.max(1, Number(duration) || 120));
  return {
    unet: {
      class_type: "UNETLoader",
      inputs: { unet_name: "minimax_music3_dit_fp16.safetensors", weight_dtype: "default" },
    },
    vae: {
      class_type: "VAELoader",
      inputs: { vae_name: "minimax_music3_dav.safetensors" },
    },
    clip: {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
        type: "minimax",
        device: "default",
      },
    },
    encode: {
      class_type: "MiniMaxMusic3TextEncode",
      inputs: {
        clip: ["clip", 0],
        caption: caption || "",
        lyrics: lyrics || "",
        seed: s,
        max_duration: dur,
        cfg_scale: cfgScale,
        top_k: topK,
      },
    },
    latent: {
      class_type: "EmptyMiniMaxMusic3LatentAudio",
      inputs: { seconds: dur, batch_size: 1 },
    },
    neg: {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["encode", 0] },
    },
    sampler: {
      class_type: "KSampler",
      inputs: {
        model: ["unet", 0],
        positive: ["encode", 0],
        negative: ["neg", 0],
        latent_image: ["latent", 0],
        seed: s,
        steps, cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1,
      },
    },
    decode: {
      class_type: "VAEDecodeAudio",
      inputs: { samples: ["sampler", 0], vae: ["vae", 0] },
    },
    decode_tiled: {
      class_type: "VAEDecodeAudioTiled",
      inputs: { samples: ["sampler", 0], vae: ["vae", 0], tile_size: 1536, overlap: 64 },
    },
    pick: {
      class_type: "ComfySwitchNode",
      inputs: { on_false: ["decode", 0], on_true: ["decode_tiled", 0], switch: !!tiled },
    },
    save: {
      class_type: "SaveAudioAdvanced",
      // NOTE: the mp3 sub-widget serializes under the dotted key
      // "format.quality" (probed against /prompt validation) — plain
      // "quality" is rejected as missing.
      inputs: { audio: ["pick", 0], filename_prefix: prefix, format: "mp3", "format.quality": "V0" },
    },
  };
}

// ---------------------------------------------------------------- Graph builders

/**
 * Universal quality lock for EVERY generated image (all styles, all boards).
 * Guarantees context-grounded prompts still render sharp: 8k, highly clear,
 * never distorted/deformed/blurry. Enforced inside the Flux builders below
 * (idempotent — never doubled) so no authoring path can drop it.
 */
export const QUALITY_IMAGE_SUFFIX =
  "ultra-detailed 8k uhd, highly clear, sharp focus, intricate details, professional cinematic lighting, no distortion, no distorted faces, no deformed faces, no extra limbs, no missing limbs, no blurry, no low quality, no watermark";

/** Append the quality lock unless the prompt already carries it. */
export function withQualityImage(prompt) {
  const t = String(prompt || "").trim();
  if (!t) return QUALITY_IMAGE_SUFFIX;
  return /8k uhd|ultra-detailed 8k|highly clear/i.test(t) && /no distortion|no distorted/i.test(t)
    ? t
    : `${t}, ${QUALITY_IMAGE_SUFFIX}`;
}

/**
 * Universal quality lock for EVERY generated video (i2v motion prompts).
 * The clip must animate its own keyframe at high clarity with stable
 * geometry — never distort, morph, flicker or redesign the character.
 */
export const QUALITY_MOTION_SUFFIX =
  "highly clear 8k uhd quality, smooth natural motion, stable character and background, no distortion, no distorted faces, no deformed faces, no morphing, no flicker, no extra limbs, no blurry, no low quality";

/** Append the motion quality lock unless already present. */
export function withQualityMotion(motion) {
  const t = String(motion || "").trim();
  if (!t) return QUALITY_MOTION_SUFFIX;
  return /8k uhd quality|highly clear 8k/i.test(t) && /no distortion|no morphing/i.test(t)
    ? t
    : `${t}, ${QUALITY_MOTION_SUFFIX}`;
}

/**
 * Photorealism suffix for devotional / mythological image prompts. Flux-2
 * Klein renders what the text asks for — without these tokens it drifts
 * soft/painterly. Appended server-side (see lib/documentary.mjs) so every
 * devotional keyframe carries it even when the LLM forgets it.
 */
export const PHOTO_REALISM_SUFFIX =
  "ultra photorealistic, highly detailed 8k uhd cinematic film still, sharp focus, intricate details, natural skin texture, detailed expressive eyes, lifelike divine glow, volumetric lighting, rich colors, professional devotional cinematography, no cartoon, no painting, no illustration, no distortion, no distorted faces, no deformed faces, no extra limbs, no blur, no watermark";

/** Append the photorealism suffix unless the prompt already carries it. */
export function withPhotoRealism(prompt) {
  const t = String(prompt || "").trim();
  if (!t) return PHOTO_REALISM_SUFFIX;
  return /ultra photorealistic|8k uhd|photorealistic/i.test(t)
    ? t
    : `${t}, ${PHOTO_REALISM_SUFFIX}`;
}

/**
 * Flux 2 Klein text-to-image graph.
 * @param {object} o { prompt, width=1280, height=768, prefix, save=true, steps=4 }
 *   save=false drops the SaveImage node (used when bridging in-process).
 *   steps — Flux2Scheduler steps (default 4, fast draft; base workflow ships
 *   20). Devotional realism passes 14-16 via cfg.fluxSteps (see
 *   scripts/character_sequence*.mjs) — higher steps = finer skin/fabric/
 *   ornament detail at ~2-3x time cost.
 */
export function buildFluxGraph({ prompt, width = 1280, height = 768, prefix = "out/flux", save = true, steps = 4 }) {
  const g = structuredClone(fluxBase);
  g["75:68"].inputs.value = width;
  g["75:69"].inputs.value = height;
  g["75:62"].inputs.steps = steps;
  g["75:73"].inputs.noise_seed = randSeed();
  // Context images must always render 8k + undistorted (see QUALITY_IMAGE_SUFFIX).
  g["75:74"].inputs.text = withQualityImage(prompt);
  if (save) g["9"].inputs.filename_prefix = prefix;
  else delete g["9"];
  return g;
}

/**
 * Flux 2 Klein image-to-image graph anchored on an existing image
 * (the generated reference visual). Same base workflow as buildFluxGraph,
 * but the sampler starts from the VAE-encoded + rescaled reference instead
 * of an empty latent, so the reference pixels actually condition every
 * scene image. No extra models needed (flux2-vae + LoadImage/VaeEncode
 * both ship with the install).
 * @param {object} o { prompt, image (ComfyUI input-folder filename),
 *                     width=1280, height=768, prefix, save=true, steps=4 }
 */
export function buildFluxImg2ImgGraph({ prompt, image, width = 1280, height = 768, prefix = "out/flux", save = true, steps = 4 }) {
  const g = structuredClone(fluxBase);
  g["75:68"].inputs.value = width;
  g["75:69"].inputs.value = height;
  g["75:62"].inputs.steps = steps;
  g["75:73"].inputs.noise_seed = randSeed();
  // Same quality enforcement as pure t2i — anchored keyframes stay 8k + undistorted.
  g["75:74"].inputs.text = withQualityImage(prompt);
  // Reference anchor: LoadImage -> rescale to the target size -> VAE encode
  // with the same VAE the decoder uses, then feed the sampler.
  g["ref:load"] = { class_type: "LoadImage", inputs: { image } };
  g["ref:scale"] = {
    class_type: "ImageScale",
    inputs: { image: ["ref:load", 0], upscale_method: "bilinear", width, height, crop: "center" },
  };
  g["ref:vaeenc"] = {
    class_type: "VAEEncode",
    inputs: { pixels: ["ref:scale", 0], vae: ["75:72", 0] },
  };
  g["75:64"].inputs.latent_image = ["ref:vaeenc", 0];
  delete g["75:66"]; // EmptyFlux2LatentImage (replaced by the encoded reference)
  if (save) g["9"].inputs.filename_prefix = prefix;
  else delete g["9"];
  return g;
}

/**
 * LTX-2.5 image-to-video graph (loads the first frame from ComfyUI's input folder).
 * @param {object} o { prompt, image (input-folder filename), duration=3, fps=24,
 *                     ratio="16:9 (Widescreen)", megapixels=0.5, prefix,
 *                     negative (optional override) }
 *
 * Negative-prompt rule: the base workflow ships
 * "pc game, console game, video game, cartoon, childish, ugly" — correct for
 * photoreal/devotional cuts, but it actively fights cartoon/kids projects
 * (Haathi v4: cute 3D preschool elephant) by telling LTX *not* to make
 * cartoons, so clips drift off their keyframes (wrong character count, lost
 * props, restyled faces — even frame 0 mismatches). When no explicit
 * negative is passed, cartoon-looking prompts auto-select a cartoon-safe
 * negative instead; explicit negatives always win.
 */
export const LTX_DEFAULT_NEGATIVE = "pc game, console game, video game, cartoon, childish, ugly, blurry, low quality, distorted, distorted faces, deformed, deformed faces, extra limbs, missing limbs, morphing, flicker, watermark";
export const LTX_CARTOON_SAFE_NEGATIVE =
  "ugly, blurry, low quality, distorted, distorted faces, deformed, deformed faces, watermark, scary, horror, photorealistic gore, extra limbs, missing limbs, morphing, flicker";
/** Ensure a custom negative still bans distortion (explicit overrides keep their text). */
export function withQualityNegative(negative, fallback) {
  const t = String(negative ?? fallback ?? "").trim();
  if (!t) return String(fallback ?? "");
  return /distort/i.test(t) ? t : `${t}, distorted, deformed, blurry, low quality`;
}
export function isCartoonPrompt(prompt) {
  return /cartoon|3d anim|preschool|anime|cute|kids|pixar|disney|nursery rhyme/i.test(String(prompt || ""));
}
export function buildLtxGraph({ prompt, image, duration = 3, fps = 24, ratio = "16:9 (Widescreen)", megapixels = 0.5, prefix = "out/ltx", t2v = false, size = null, negative }) {
  const g = structuredClone(ltxBase);
  g["395"].inputs.image = image; // LoadImage always runs; for t2v pass any small placeholder
  if (t2v) g["398:363"].inputs.value = true; // bypass both LTXVImgToVideoInplace -> text-to-video
  // The clip animates THIS scene's keyframe image — the motion text only adds
  // movement + the 8k/no-distortion quality lock, never a redesign.
  g["398:376"].inputs.value = withQualityMotion(prompt);
  g["398:373"].inputs.text = withQualityNegative(negative, isCartoonPrompt(prompt) ? LTX_CARTOON_SAFE_NEGATIVE : LTX_DEFAULT_NEGATIVE);
  if (size) {
    // Exact WxH: override the PrimitiveInt width/height nodes with literals,
    // bypassing ResolutionSelector (lets us go below its 0.1MP floor, e.g. 64x64).
    g["398:372"].inputs.value = size[0];
    g["398:360"].inputs.value = size[1];
  } else {
    g["403"].inputs.aspect_ratio = ratio;
    g["403"].inputs.megapixels = megapixels;
  }
  g["398:362"].inputs.value = duration;
  g["398:361"].inputs.value = fps;
  g["398:339"].inputs.noise_seed = randSeed();
  g["398:338"].inputs.noise_seed = randSeed();
  g["75"].inputs.filename_prefix = prefix;
  return g;
}

/**
 * Wan 2.1 i2v graph (image-to-video, video-only — no generated audio).
 * Base workflow: workflows/image_to_video_wan.json (wan2.1-i2v-14b GGUF + AccVid LoRA,
 * umt5_xxl CLIP, wan_2.1_vae, CLIPVision first-frame conditioning).
 * @param {object} o { prompt, image (input-folder filename), width=512, height=512,
 *                     length=33 (frames), steps=8, prefix, negative }
 */
export function buildWanGraph({ prompt, image, width = 512, height = 512, length = 33, steps = 8, prefix = "out/wan", negative }) {
  const g = structuredClone(wanBase);
  g["52"].inputs.image = image;
  g["6"].inputs.text = withQualityMotion(prompt);
  g["7"].inputs.text = withQualityNegative(negative, g["7"].inputs.text);
  g["50"].inputs.width = width;
  g["50"].inputs.height = height;
  g["50"].inputs.length = length;
  g["3"].inputs.steps = steps;
  g["3"].inputs.seed = randSeed();
  g["56"].inputs.filename_prefix = prefix;
  return g;
}

/**
 * Single merged pipeline: Flux t2i -> (pixel bridge) -> LTX i2v -> SaveVideo.
 * No image touches disk: Flux VAEDecode feeds LTX's ResizeImageMaskNode directly.
 * @param {object} o { fluxPrompt, ltxPrompt, duration=3, fps=24, ratio, megapixels=0.5, prefix, fluxSteps=4 }
 */
export function buildMergedGraph({ fluxPrompt, ltxPrompt, duration = 3, fps = 24, ratio = "16:9 (Widescreen)", megapixels = 0.5, prefix = "out/merged", fluxSteps = 4 }) {
  const g = structuredClone({ ...ltxBase, ...fluxBase });
  // Bridge: Flux VAEDecode (75:65, IMAGE) -> LTX ResizeImageMaskNode (was LoadImage 395)
  g["398:351"].inputs.input = ["75:65", 0];
  delete g["395"]; // LoadImage
  delete g["9"];   // Flux SaveImage
  // Flux side
  g["75:68"].inputs.value = 1280;
  g["75:69"].inputs.value = 768;
  g["75:62"].inputs.steps = fluxSteps;
  g["75:73"].inputs.noise_seed = randSeed();
  g["75:74"].inputs.text = withQualityImage(fluxPrompt);
  // LTX side (animates the Flux frame of THIS scene — same-scene linkage)
  g["398:376"].inputs.value = withQualityMotion(ltxPrompt);
  g["403"].inputs.aspect_ratio = ratio;
  g["403"].inputs.megapixels = megapixels;
  g["398:362"].inputs.value = duration;
  g["398:361"].inputs.value = fps;
  g["398:339"].inputs.noise_seed = randSeed();
  g["398:338"].inputs.noise_seed = randSeed();
  g["75"].inputs.filename_prefix = prefix;
  return g;
}
