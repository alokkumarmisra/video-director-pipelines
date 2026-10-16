// Devotional Studio video generator: one short LTX i2v showcase clip per
// invocation, animated from an existing reference still.
// Run: node scripts/devotional_video.mjs --image <ref.png> --out <file.mp4>
//      --prompt "..." [--duration 3]
// Resumable: an existing --out file is kept and reported (never overwritten).
// Emits one [asset] JSON line for the server's log parser, like every other
// generator script in this repo.
import fs from "node:fs";
import path from "node:path";
import { buildLtxGraph, run, uploadToInput, firstVideoUrl, download } from "../lib/comfy.mjs";

const args = process.argv.slice(2);
const opt = (k, fb = null) => {
  const i = args.indexOf(k);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
const image = opt("--image", "");
const out = opt("--out", "");
const prompt = opt("--prompt", "");
const duration = Math.max(2, Math.min(8, Number(opt("--duration", 3)) || 3));

if (!image || !fs.existsSync(image)) { console.error("missing --image (must be an existing reference still)"); process.exit(2); }
if (!out) { console.error("missing --out"); process.exit(2); }
if (!prompt.trim()) { console.error("missing --prompt"); process.exit(2); }
if (fs.existsSync(out)) {
  console.log(`[asset] ${JSON.stringify({ kind: "video", file: path.basename(out), stage: "devotional", skipped: true })}`);
  console.log(`exists, skipping: ${out}`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

// LTX animates the still itself — the motion text only adds gentle movement
// (slow push-in / subtle life), never a redesign of the canonical identity.
const motion = `gentle showcase motion, slow subtle push-in, subject holds canonical identity. ${prompt.trim()}`;
const inputName = await uploadToInput(image, "devotional_vid");
const graph = buildLtxGraph({ prompt: motion, image: inputName, duration, prefix: "out/devotional_vid" });
const entry = await run(graph, "devotional-video");
const url = firstVideoUrl(entry);
if (!url) throw new Error("LTX returned no video (SaveVideo node 75 empty)");
await download(url, out);
console.log(`[asset] ${JSON.stringify({ kind: "video", file: path.basename(out), stage: "devotional" })}`);
console.log(`saved: ${out}`);
