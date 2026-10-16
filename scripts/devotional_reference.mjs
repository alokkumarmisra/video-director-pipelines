// Devotional Studio reference generator: one Flux t2i still per invocation.
// Run: node scripts/devotional_reference.mjs --prompt "..." --out <file.png>
//      [--width 1024 --height 1024 --steps 4]
// Resumable: an existing --out file is kept and reported (never overwritten).
// Emits one [asset] JSON line for the server's log parser, like every other
// generator script in this repo.
import fs from "node:fs";
import path from "node:path";
import { buildFluxGraph, run, firstImageUrl, download } from "../lib/comfy.mjs";

const args = process.argv.slice(2);
const opt = (k, fb = null) => {
  const i = args.indexOf(k);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
const prompt = opt("--prompt", "");
const out = opt("--out", "");
const width = Math.max(256, Math.min(2048, Number(opt("--width", 1024)) || 1024));
const height = Math.max(256, Math.min(2048, Number(opt("--height", 1024)) || 1024));
const steps = Math.max(1, Math.min(20, Number(opt("--steps", 4)) || 4));

if (!prompt.trim()) { console.error("missing --prompt"); process.exit(2); }
if (!out) { console.error("missing --out"); process.exit(2); }
if (fs.existsSync(out)) {
  console.log(`[asset] ${JSON.stringify({ kind: "image", file: path.basename(out), stage: "devotional", skipped: true })}`);
  console.log(`exists, skipping: ${out}`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

const graph = buildFluxGraph({ prompt: prompt.trim(), width, height, prefix: "out/devotional", steps });
const entry = await run(graph, "devotional-reference");
const url = firstImageUrl(entry);
if (!url) throw new Error("Flux returned no image (SaveImage node 9 empty)");
await download(url, out);
console.log(`[asset] ${JSON.stringify({ kind: "image", file: path.basename(out), stage: "devotional" })}`);
console.log(`saved: ${out}`);
