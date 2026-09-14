// CHARACTER SEQUENCE: 1 reference visual -> N keyframe story beats (same subject,
// each keyframe Flux img2img-anchored on the reference image)
// -> each keyframe uploaded + fed to LTX i2v -> stitched final.
// Generic: any prompts/<scenario>.json with the anime_sequence shape.
//
// Prompt JSON shape:
//   { "duration": 3, "referencePrompt": "...",
//     "sequence": [ { "title", "image", "motion" }, ... ] }
//
// Versioning: regenerating an asset writes a new _vN file (previous versions
// are kept). The stitched final always uses the version selected as "main"
// (outputs/<scenario>/state.json; default = latest).
//
// Usage:
//   node scripts/character_sequence.mjs [scenario]           # default: anime_sequence
//   node scripts/character_sequence.mjs [scenario] --stitch  # only re-stitch (from selected mains)
//   node scripts/character_sequence.mjs [scenario] --regen ref
//   node scripts/character_sequence.mjs [scenario] --regen keyframe <beat>
//   node scripts/character_sequence.mjs [scenario] --regen clip <beat>
//   node scripts/character_sequence.mjs [scenario] --vertical  # 9:16 Instagram Reel cut
//     (combines with --stitch / --regen; writes outputs/<scenario>_vertical/)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFluxGraph, buildFluxImg2ImgGraph, buildLtxGraph,
} from "../lib/comfy.mjs";
import {
  VERTICAL, VERTICAL_FLUX_WIDTH, VERTICAL_FLUX_HEIGHT, VERTICAL_LTX_RATIO, VERTICAL_LTX_MEGAPIXELS,
  normalizeFormat, outDirName, prefixForDir, verticalImagePrompt, verticalMotionPrompt,
} from "../lib/variant.mjs";
import { runSequence, stitchSequence } from "../lib/sequence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith("--")) || "anime_sequence";
// --vertical: regenerate every asset at 9:16 into outputs/<scenario>_vertical/
// (Instagram Reel cut). Never touches the landscape outputs.
const format = normalizeFormat(args.includes("--vertical") ? VERTICAL : "landscape");
const vertical = format === VERTICAL;
const regenIdx = args.indexOf("--regen");
const regen = regenIdx >= 0
  ? { kind: args[regenIdx + 1], index: Number(args[regenIdx + 2]) || 0 }
  : null;

const cfgPath = path.join(here, `../prompts/${scenario}.json`);
if (!fs.existsSync(cfgPath)) {
  console.error(`[char] no prompts/${scenario}.json — available:`);
  console.error("  " + fs.readdirSync(path.join(here, "../prompts")).filter((f) => f.endsWith(".json")).join("\n  "));
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const outDir = path.resolve(here, `../outputs/${outDirName(scenario, "ltx", format)}`);
const prefix = prefixForDir(outDirName(scenario, "ltx", format));
fs.mkdirSync(outDir, { recursive: true });

const fluxSize = vertical ? { width: VERTICAL_FLUX_WIDTH, height: VERTICAL_FLUX_HEIGHT } : {};
const frame = (prompt) => (vertical ? verticalImagePrompt(prompt) : prompt);
const move = (motion) => (vertical ? verticalMotionPrompt(motion) : motion);

const opts = {
  scenario,
  outDir,
  prefix,
  tag: `[char:${scenario}${vertical ? "/vertical" : ""}]`,
  cfg,
  buildRef: (prompt) => buildFluxGraph({ prompt: frame(prompt), ...fluxSize, prefix: `${scenario}/ref` }),
  buildKeyframe: (prompt, i, refImage) => refImage
    ? buildFluxImg2ImgGraph({ prompt: frame(prompt), image: refImage, ...fluxSize, prefix: `${scenario}/seq${i + 1}` })
    : buildFluxGraph({ prompt: frame(prompt), ...fluxSize, prefix: `${scenario}/seq${i + 1}` }),
  buildClip: (motion, image, i) => buildLtxGraph({
    prompt: move(motion),
    image,
    duration: cfg.duration ?? 3,
    ratio: vertical ? VERTICAL_LTX_RATIO : "16:9 (Widescreen)",
    megapixels: vertical ? VERTICAL_LTX_MEGAPIXELS : 0.5,
    prefix: `${scenario}/clip${i + 1}_${cfg.sequence[i].title}`,
  }),
  videoNode: "75",
};

if (process.argv.includes("--stitch")) {
  try { stitchSequence(opts); }
  catch (e) { console.error(`[char] ${e.message}`); process.exit(1); }
  process.exit(0);
}

try {
  await runSequence({ ...opts, regen });
} catch (e) {
  console.error(`[char] ${e.message}`);
  process.exit(1);
}
