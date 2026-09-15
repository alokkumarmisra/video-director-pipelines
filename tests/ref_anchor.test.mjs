// Reference-anchor tests: the generated reference visual must actually
// condition every scene (keyframe) image via Flux img2img.
// Run: node --test tests/   (from the repo root; zero deps, Node >= 18)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// lib/comfy.mjs exits without COMFY_BASE — dummy value is enough: the
// builder tests never touch the network.
process.env.COMFY_BASE ??= "http://localhost:1";
const comfy = await import("../lib/comfy.mjs");
const { buildFluxGraph, buildFluxImg2ImgGraph } = comfy;

describe("buildFluxImg2ImgGraph", () => {
  it("anchors the sampler on the VAE-encoded reference image", () => {
    const g = buildFluxImg2ImgGraph({ prompt: "a knight", image: "ref_123.png" });
    assert.deepEqual(g["75:64"].inputs.latent_image, ["ref:vaeenc", 0]);
    assert.equal(g["ref:load"].class_type, "LoadImage");
    assert.equal(g["ref:load"].inputs.image, "ref_123.png");
    assert.equal(g["ref:scale"].class_type, "ImageScale");
    assert.deepEqual(g["ref:scale"].inputs.image, ["ref:load", 0]);
    assert.equal(g["ref:vaeenc"].class_type, "VAEEncode");
    assert.deepEqual(g["ref:vaeenc"].inputs.pixels, ["ref:scale", 0]);
    // Same VAE the decoder uses (no extra models needed).
    assert.deepEqual(g["ref:vaeenc"].inputs.vae, ["75:72", 0]);
    assert.ok(!("75:66" in g), "EmptyFlux2LatentImage must be removed");
  });

  it("rescales the reference to the target size and keeps prompt/seed/prefix", () => {
    const g = buildFluxImg2ImgGraph({
      prompt: "a knight at dawn", image: "r.png", width: 960, height: 512,
      prefix: "scn/seq1", steps: 4,
    });
    assert.equal(g["ref:scale"].inputs.width, 960);
    assert.equal(g["ref:scale"].inputs.height, 512);
    assert.equal(g["75:74"].inputs.text, "a knight at dawn");
    assert.equal(g["75:62"].inputs.steps, 4);
    assert.ok(Number.isFinite(g["75:73"].inputs.noise_seed));
    assert.equal(g["9"].inputs.filename_prefix, "scn/seq1");
  });

  it("save=false drops the SaveImage node like buildFluxGraph", () => {
    const g = buildFluxImg2ImgGraph({ prompt: "x", image: "r.png", save: false });
    assert.ok(!("9" in g));
  });

  it("never mutates the base workflow (pure t2i still uses empty latent)", () => {
    buildFluxImg2ImgGraph({ prompt: "anchored", image: "r.png" });
    const t2i = buildFluxGraph({ prompt: "plain" });
    assert.deepEqual(t2i["75:64"].inputs.latent_image, ["75:66", 0]);
    assert.ok("75:66" in t2i);
    assert.equal(t2i["75:74"].inputs.text, "plain");
  });
});

describe("sequence wiring", () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

  it("genKeyframe uploads the ref main and passes it to buildKeyframe", () => {
    const src = read("lib/sequence.mjs");
    assert.match(src, /resolveRefForRun\(outDir, prefix\)/);
    assert.match(src, /uploadToInput\(ref\.fullPath/);
    assert.match(src, /buildKeyframe\(seq\[i\]\.image, i, refInput\)/);
  });

  it("switching the main ref regenerates stale keyframes + clips", () => {
    const src = read("lib/sequence.mjs");
    assert.match(src, /getKeyframeRefFrom/);
    assert.match(src, /setKeyframeRefFrom/);
    assert.match(src, /ref main is now/);
  });

  it("a freshly generated version becomes main (regen v4 beats picked v1/v2/v3)", () => {
    const src = read("lib/sequence.mjs");
    // Each generator records the just-written file and prefers it over the
    // previously selected main; skips (no new file) keep the old selection.
    const hits = src.match(/newFile \?\? path\.basename\(resolveMain\(/g) || [];
    assert.equal(hits.length, 3, "genRef + genKeyframe + genClip must select the fresh file");
    assert.match(src, /newFile = path\.basename\(dest\)/);
  });

  it("both runners build img2img keyframes when a ref input exists", () => {
    for (const f of ["scripts/character_sequence.mjs", "scripts/character_sequence_wan.mjs"]) {
      const src = read(f);
      assert.match(src, /buildFluxImg2ImgGraph/, `${f} must use the anchor builder`);
      assert.match(src, /\(prompt, i, refImage\)/, `${f} must accept the ref input`);
    }
  });
});
