// Vertical (Instagram Reel 9:16) variant helpers.
// Single source of truth for the landscape <-> vertical mapping, shared by
// scripts/character_sequence{,_wan}.mjs and frontend/server.mjs so output
// dirs, filename prefixes and generation sizes never drift apart.
//
// Layout (format is orthogonal to the i2v engine):
//   ltx  landscape -> outputs/<scenario>/               prefix <scenario>
//   ltx  vertical   -> outputs/<scenario>_vertical/      prefix <scenario>_vertical
//   wan  landscape -> outputs/<scenario>_wan/           prefix <scenario>_wan
//   wan  vertical   -> outputs/<scenario>_wan_vertical/ prefix <scenario>_wan_vertical
//
// A vertical run regenerates every asset (ref + keyframes + clips) at 9:16 —
// it never crops or reuses the landscape pixels. The main (landscape) video
// is untouched.
export const LANDSCAPE = "landscape";
export const VERTICAL = "vertical";

// Flux t2i canvas for vertical stills (360x640, exact 9:16 — 50% of
// 720x1280: phone viewing needs no more, and smaller stills queue faster).
export const VERTICAL_FLUX_WIDTH = 360;
export const VERTICAL_FLUX_HEIGHT = 640;

// LTX ResolutionSelector aspect for vertical clips (same enum value the base
// workflow ships with; buildLtxGraph defaults to 16:9 landscape).
export const VERTICAL_LTX_RATIO = "9:16 (Portrait Widescreen)";
// Quarter area (0.125MP vs the 0.5MP landscape default) = half the linear
// dimensions, keeping the 9:16 ratio above. Stays above the selector's
// 0.1MP floor so the node graph is unchanged — only the megapixels differ.
export const VERTICAL_LTX_MEGAPIXELS = 0.125;

// Wan 2.1 i2v canvas for vertical clips (min 16, step 16; ~9:16 — 50% of
// 480x832).
export const VERTICAL_WAN_WIDTH = 240;
export const VERTICAL_WAN_HEIGHT = 416;

// Framing hint appended to ref/keyframe prompts on vertical runs so Flux
// composes for a tall frame instead of centering landscape content.
export const VERTICAL_PROMPT_SUFFIX =
  ", vertical 9:16 portrait composition, subject large and centered, full height framing, optimized for phone viewing";

// Motion hint appended to i2v prompts on vertical runs.
export const VERTICAL_MOTION_SUFFIX = ", vertical 9:16 framing, subject kept centered";

export const normalizeFormat = (f) => (f === VERTICAL ? VERTICAL : LANDSCAPE);
export const isVerticalFormat = (f) => normalizeFormat(f) === VERTICAL;

/** Output dir name for a scenario + engine + format. */
export function outDirName(scenario, engine = "ltx", format = LANDSCAPE) {
  const base = String(scenario || "");
  const eng = engine === "wan" ? "_wan" : "";
  const fmt = normalizeFormat(format) === VERTICAL ? "_vertical" : "";
  return `${base}${eng}${fmt}`;
}

/** Scenario config name for an output dir (strips _wan / _vertical suffixes). */
export function cfgNameForDir(dirName) {
  let s = String(dirName || "");
  if (s.endsWith("_vertical")) s = s.slice(0, -"_vertical".length);
  if (s.endsWith("_wan")) s = s.slice(0, -"_wan".length);
  return s;
}

/** Filename prefix for an output dir (== the dir name). */
export function prefixForDir(dirName) {
  return String(dirName || "");
}

export const isVerticalDir = (dirName) => String(dirName || "").endsWith("_vertical");
export const engineForDir = (dirName) => {
  const s = String(dirName || "");
  const noFmt = s.endsWith("_vertical") ? s.slice(0, -"_vertical".length) : s;
  return noFmt.endsWith("_wan") ? "wan" : "ltx";
};
/** Base project name for an output dir (strips engine + format suffixes). */
export const projectForDir = (dirName) => cfgNameForDir(dirName);

/** All output dirs belonging to one scenario (engines x formats). */
export function allDirsFor(scenario) {
  const base = String(scenario || "");
  return [base, `${base}_wan`, `${base}_vertical`, `${base}_wan_vertical`];
}

export const verticalImagePrompt = (prompt) =>
  `${String(prompt || "").trim()}${VERTICAL_PROMPT_SUFFIX}`;

export const verticalMotionPrompt = (motion) =>
  `${String(motion || "").trim()}${VERTICAL_MOTION_SUFFIX}`;
