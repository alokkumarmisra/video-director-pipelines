// Learning-board keyframe verifier: checks that ABC/counting keyframes show
// the planned hero letters and numerals BEFORE clips generate.
//
// Run: node scripts/verify_learning.mjs <scenario> [--focus alphabet|counting|auto] [--beats 1,3]
//
// <scenario> resolves prompts/<scenario>.json (beat titles + dialogue = the
// teach signal) and outputs/<scenario>/ (main keyframe per beat via
// resolveMain, latest version wins). Each keyframe is OCRed with Tesseract
// and compared against expectations from extractLearningExpectations.
//
// Needs the free Tesseract OCR engine on PATH (https://tesseract-ocr.github.io/
// tessdoc/Installation.html — Windows: `winget install UB-Mannheim.TesseractOCR`).
// Without it the script exits 2 with install instructions instead of failing
// silently. Exit 0 = all checked beats pass, 1 = a letter/numeral is missing.
//
// Emits one [asset] JSON line per beat for the server's log parser, like
// every other script in this repo.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  extractLearningExpectations,
  verifyOcrText,
} from "../lib/director.mjs";
import { loadState, resolveMain } from "../lib/sequence_state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const opt = (k, fb = null) => {
  const i = args.indexOf(k);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
const valuedFlags = new Set(["--focus", "--beats", "--lang"]);
let scenario = null;
for (let i = 0; i < args.length; i++) {
  if (valuedFlags.has(args[i])) { i++; continue; }
  if (!args[i].startsWith("--") && !scenario) scenario = args[i];
}
const focusOpt = (opt("--focus", "auto") || "auto").toLowerCase();
const beatsOpt = opt("--beats", "");
const langOpt = opt("--lang", "eng+hin");

if (!scenario) { console.error("usage: node scripts/verify_learning.mjs <scenario> [--focus alphabet|counting|auto] [--beats 1,3]"); process.exit(2); }
if (!["alphabet", "counting", "auto"].includes(focusOpt)) { console.error("--focus must be alphabet|counting|auto"); process.exit(2); }
if (scenario === "." || scenario === ".." || path.basename(scenario) !== scenario || /[\\/:]/.test(scenario)) {
  console.error("scenario must be a plain project name (no path separators)"); process.exit(2);
}

const cfgPath = path.join(ROOT, "prompts", `${scenario}.json`);
const outDir = path.join(ROOT, "outputs", scenario);
if (!fs.existsSync(cfgPath)) { console.error(`no scenario config: ${cfgPath}`); process.exit(2); }
if (!fs.existsSync(outDir)) { console.error(`no outputs dir (generate keyframes first): ${outDir}`); process.exit(2); }

const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const beats = Array.isArray(cfg.sequence) ? cfg.sequence : [];
if (!beats.length) { console.error(`scenario ${scenario} has no sequence beats`); process.exit(2); }
const only = new Set(
  beatsOpt ? beatsOpt.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0) : [],
);
const state = loadState(outDir);
const prefix = scenario;

function ocrImage(abs) {
  const langs = langOpt === "eng" ? ["eng"] : [langOpt, "eng"];
  let lastErr = null;
  for (const lang of langs) {
    for (const psm of ["8", "6"]) {
      try {
        const out = execFileSync("tesseract", [abs, "stdout", "--psm", psm, "-l", lang],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        if (out && out.trim()) return out;
      } catch (e) {
        lastErr = e;
        if (e && (e.code === "ENOENT" || /not recognized|not found/i.test(String(e.message || "")))) throw e;
      }
    }
  }
  throw lastErr || new Error("tesseract returned no text");
}

let checked = 0;
let failed = 0;
beats.forEach((b, i) => {
  const n = i + 1;
  if (only.size && !only.has(n)) return;
  const title = String((b && b.title) || `beat${n}`);
  const texts = [title, b && b.lyric_text, b && b.lyric_segment, b && b.semantic_meaning,
    b && b.visual_event, ...((b && Array.isArray(b.dialogue) ? b.dialogue : []).map((d) => d && d.line))];
  const focuses = focusOpt === "auto" ? ["alphabet", "counting"] : [focusOpt];
  const expected = { letters: [], counts: [] };
  for (const f of focuses) {
    const e = extractLearningExpectations(texts, f);
    for (const L of e.letters) if (!expected.letters.includes(L)) expected.letters.push(L);
    for (const c of e.counts) if (!expected.counts.includes(c)) expected.counts.push(c);
  }
  expected.letters.sort();
  expected.counts.sort((a, c) => a - c);
  const file = resolveMain(outDir, prefix, "seq", n, ".png", title, state);
  if (!expected.letters.length && !expected.counts.length) {
    if (focusOpt !== "auto") {
      failed++;
      checked++;
      console.log(`[asset] ${JSON.stringify({ type: "learning-verify", beat: n, ok: false, reason: "no expected teaching text found" })}`);
      console.log(`Beat ${n}: FAIL no expected letter/count extracted — add the teaching target to the beat title/lyrics/dialogue`);
      return;
    }
    console.log(`[asset] ${JSON.stringify({ type: "learning-verify", beat: n, skipped: true, reason: "no teaching content" })}`);
    console.log(`Beat ${n}: SKIP (no letter/count in plan)`);
    return;
  }
  if (!file) {
    if (focusOpt !== "auto") {
      failed++;
      checked++;
      console.log(`[asset] ${JSON.stringify({ type: "learning-verify", beat: n, ok: false, reason: "no keyframe" })}`);
      console.log(`Beat ${n}: FAIL (expected teaching target has no keyframe)`);
      return;
    }
    console.log(`[asset] ${JSON.stringify({ type: "learning-verify", beat: n, skipped: true, reason: "no keyframe" })}`);
    console.log(`Beat ${n}: SKIP (no keyframe on disk yet)`);
    return;
  }
  let ocr;
  try {
    ocr = ocrImage(path.join(outDir, file));
  } catch (e) {
    if (e && (e.code === "ENOENT" || /not recognized|not found/i.test(String(e.message || "")))) {
      console.error("tesseract not found on PATH — install Tesseract OCR 5+ and re-run:\n  Windows: winget install UB-Mannheim.TesseractOCR\n  macOS:   brew install tesseract tesseract-lang\n  Linux:   sudo apt install tesseract-ocr tesseract-ocr-hin");
      process.exit(2);
    }
    throw e;
  }
  const res = verifyOcrText(expected, ocr);
  checked++;
  const detail = [
    ...expected.letters.map((L) => `letter ${L}`),
    ...expected.counts.map((c) => `count ${c}`),
  ].join(", ");
  if (res.ok) {
    console.log(`[asset] ${JSON.stringify({ type: "learning-verify", beat: n, file, ocrTextPresent: true, objectCountVerified: false })}`);
    console.log(`Beat ${n} (${file}): OCR TEXT FOUND ${detail}; visually confirm letter shape, prominence, and actual object count (OCR cannot verify those).`);
  } else {
    failed++;
    const missing = [
      ...res.missingLetters.map((L) => `letter ${L}`),
      ...res.missingCounts.map((c) => `numeral ${c}`),
    ].join(", ");
    console.log(`[asset] ${JSON.stringify({ type: "learning-verify", beat: n, file, ok: false, missingLetters: res.missingLetters, missingCounts: res.missingCounts })}`);
    console.log(`Beat ${n} (${file}): FAIL missing ${missing} (planned: ${detail}) — regenerate the keyframe`);
  }
});

console.log(checked ? `verified ${checked} beat(s), ${failed} failing` : "nothing to verify (no teaching beats with keyframes)");
process.exit(failed ? 1 : 0);
