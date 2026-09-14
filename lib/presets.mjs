// Predefined AI Video Preset service (PresetService).
// Zero deps, Node >= 18. Single source of truth for the preset catalog:
//   presets/presets.json  -> [{ id, name, category, description, filePath }]
//   presets/<category>/*.md   -> system-owned prompt rule files (shared defaults;
//                                per-project edits live on the project as
//                                `presetRules`, never in these files)
//
// Responsibilities:
//   GetAvailablePresets()  list metadata (no file content)
//   GetPresetById(id)      metadata for one registered id (null when unknown)
//   GetPresetContent(id)   { meta, content } — ONLY for registered ids
//   resolvePresetId(input) valid id or the default ("cinematic")
//   buildPrompt({...})     combine preset + master + scene with fixed priority
//
// Security: callers can ONLY pass a preset id. File paths always come from
// the registry, are normalized, and must stay inside the presets/ dir — a
// hostile "../../x" id can never escape because it never matches a
// registered id in the first place.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root (override via PRESETS_ROOT for tests pointing at a fixture tree
// that mirrors the real layout: <root>/presets/presets.json + .md files).
const REPO_ROOT = process.env.PRESETS_ROOT
  ? path.resolve(process.env.PRESETS_ROOT)
  : path.resolve(__dirname, "..");
// Registry filePath values are repo-root-relative ("presets/kids/kids.md")
// and always resolve inside the presets tree below — never from client input.
const PRESETS_DIR = path.join(REPO_ROOT, "presets");
const REGISTRY_FILE = path.join(PRESETS_DIR, "presets.json");

export const DEFAULT_PRESET_ID = "cinematic";

// Strict id shape: lowercase slug. Anything else is rejected before any
// registry/file lookup happens.
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isValidPresetId = (id) =>
  typeof id === "string" && ID_RE.test(id);

let cache = null;
const loadRegistry = () => {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  if (!Array.isArray(raw)) throw new Error("preset registry is not an array");
  const seen = new Set();
  for (const p of raw) {
    if (!p || !isValidPresetId(p.id)) throw new Error(`bad preset id in registry: ${JSON.stringify(p?.id)}`);
    if (seen.has(p.id)) throw new Error(`duplicate preset id in registry: ${p.id}`);
    seen.add(p.id);
    if (typeof p.filePath !== "string" || !p.filePath) throw new Error(`preset ${p.id} missing filePath`);
  }
  cache = raw;
  return cache;
};
// Test hook: drop the in-memory registry so PRESETS_DIR fixtures reload.
export const _resetPresetCache = () => { cache = null; };

// Public metadata (no file content, no absolute paths).
export function GetAvailablePresets() {
  return loadRegistry().map(({ id, name, category, description }) => ({
    id, name, category, description,
  }));
}

export function GetPresetById(id) {
  if (!isValidPresetId(id)) return null;
  const hit = loadRegistry().find((p) => p.id === id);
  return hit ? { ...hit } : null;
}

// Resolve any user input to a usable id: valid + registered wins,
// everything else (missing, malformed, unknown) falls back to default.
export function resolvePresetId(input) {
  if (isValidPresetId(input) && loadRegistry().some((p) => p.id === input)) return input;
  return DEFAULT_PRESET_ID;
}

// Read the .md rules for a REGISTERED id. Throws — never returns arbitrary
// files:
//   Error("Invalid preset selected.")            unknown/malformed id
//   Error("Preset "<id>" is unavailable ...")    registry entry but file missing
export function GetPresetContent(id) {
  const meta = GetPresetById(id);
  if (!meta) throw new Error("Invalid preset selected.");
  // Belt and braces: even though filePath comes from our own registry,
  // normalize + contain it so a tampered registry can't escape presets/.
  const full = path.normalize(path.join(REPO_ROOT, meta.filePath));
  if (full !== PRESETS_DIR && !full.startsWith(PRESETS_DIR + path.sep))
    throw new Error(`Invalid preset selected.`);
  let content;
  try {
    content = fs.readFileSync(full, "utf8");
  } catch {
    console.error(`[presets] missing file for preset "${id}" (expected ${full})`);
    throw new Error(`Preset "${meta.name}" is unavailable (rules file missing).`);
  }
  if (!content.trim()) {
    console.error(`[presets] empty file for preset "${id}" (${full})`);
    throw new Error(`Preset "${meta.name}" is unavailable (rules file empty).`);
  }
  return { meta, content };
}

// Prompt assembly with the fixed priority:
//   System / Safety Rules -> Selected Preset -> Project Master Prompt -> Scene Prompt
// The preset establishes the visual language; the scene prompt carries the
// actual content. Empty layers are skipped (never "undefined").
export function buildPrompt({ presetContent = "", masterPrompt = "", scenePrompt = "" } = {}) {
  const layers = [];
  const preset = String(presetContent || "").trim();
  const master = String(masterPrompt || "").trim();
  const scene = String(scenePrompt || "").trim();
  if (preset) layers.push(`Visual style rules (follow for every shot):\n${preset}`);
  if (master) layers.push(`Project master direction:\n${master}`);
  if (scene) layers.push(`Scene content:\n${scene}`);
  return layers.join("\n\n");
}
