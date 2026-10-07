// Import an external storyboard/project JSON (e.g. a hand-written brief with
// `scenes[]` carrying camera_angle / visual_assets / character_actions /
// on_screen_text / audio_cues) into the canonical Scenario config used by the
// character-sequence pipeline + the Postgres catalog.
//
// The Scenario `config` column (scenarios / scenario_versions) is JSONB, so
// every storyboard field is preserved verbatim on the beat (camera_angle,
// visual_assets, character_actions, on_screen_text, audio_cues, timestamp,
// start_time/end_time, scene_number, ...) plus top-level extras
// (target_audience, channel, format, project_title, ...unknown keys).
// No DB migration is needed for new JSON keys: the projects row keeps the
// derived scalars (description/duration/beats) and project_assets keeps one
// KEYFRAME/VIDEO row per beat (prompt = image/motion, shot columns +
// metadata JSONB carry the camera info) via the normal save path.
//
// If the input already looks like a Scenario ({ sequence, referencePrompt })
// it is passed through with light normalization (extras preserved).
export const IMPORT_SOURCE = "json-import";

const slugTitle = (s, fallback) => {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  return t || fallback;
};

// "02:10" / "1:05:30" / "0:00" -> seconds. Number -> seconds. Null when unreadable.
export function parseClock(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v < 0 ? null : Math.round(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":").map((p) => p.trim());
  if (!parts.length || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  let total = 0;
  for (const n of nums) total = total * 60 + n;
  return Math.round(total);
}

// Very small heuristic split of a free-form camera line ("Wide Establishing
// Shot transitioning into a Dynamic Pan & Zoom toward center") into the
// structured { shot_type, angle, movement } shape the Director boards use.
// The raw string is always kept as camera_angle — this is additive only.
export function parseCameraAngle(raw) {
  const s = String(raw ?? "");
  const l = s.toLowerCase();
  const has = (...words) => words.some((w) => l.includes(w));
  let shot_type = "";
  if (has("ultra-wide", "panoramic", "establishing", "wide")) shot_type = "wide";
  else if (has("close-up", "closeup", "close up", "macro")) shot_type = "close-up";
  else if (has("medium close-up")) shot_type = "medium close-up";
  else if (has("medium")) shot_type = "medium";
  else if (has("aerial", "drone", "bird")) shot_type = "aerial";
  let angle = "";
  if (has("low-angle", "low angle", "tilting upward", "tilt up")) angle = "low-angle";
  else if (has("high-to-low", "high angle", "top-down", "overhead", "pulling back")) angle = "high-angle";
  else if (has("eye-level", "eye level", "straight-on", "straight on")) angle = "eye-level";
  let movement = "";
  const moves = [];
  if (has("pan")) moves.push("pan");
  if (has("zoom")) moves.push("zoom");
  if (has("tilt")) moves.push("tilt");
  if (has("dolly")) moves.push("dolly");
  if (has("tracking", "follow shot", "follow")) moves.push("tracking");
  if (has("pulling back", "pull back", "pullback")) moves.push("pull-back");
  if (has("static", "locked")) moves.push("static");
  if (moves.length) movement = moves.join("+");
  else if (has("dynamic", "shifting into", "transitioning")) movement = "dynamic";
  return { shot_type, angle, movement };
}

const STYLE_SUFFIX = "3D animated kids style, vibrant colors, soft lighting, high detail";

function imagePromptFor(scene) {
  const assets = Array.isArray(scene.visual_assets)
    ? scene.visual_assets.map((a) => String(a).trim()).filter(Boolean)
    : [];
  const action = String(scene.character_actions ?? "").trim();
  const bits = [];
  if (assets.length) bits.push(assets.join(", "));
  if (action) bits.push(action);
  if (!bits.length) bits.push(String(scene.name ?? scene.title ?? "scene"));
  return `${bits.join(". ")}. ${STYLE_SUFFIX}`;
}

function motionPromptFor(scene, cameraAngle) {
  const bits = [];
  const action = String(scene.character_actions ?? "").trim();
  if (action) bits.push(action);
  if (cameraAngle) bits.push(`Camera: ${cameraAngle}`);
  const audio = String(scene.audio_cues ?? "").trim();
  if (audio) bits.push(`Mood/audio: ${audio}`);
  return bits.join(" ") || "gentle natural motion, stable camera";
}

function sceneDuration(scene, fallback = 15) {
  const ts = scene.timestamp ?? scene.time ?? null;
  if (ts && typeof ts === "object") {
    const a = parseClock(ts.start ?? ts.from);
    const b = parseClock(ts.end ?? ts.to);
    if (a != null && b != null && b > a) return { duration: b - a, start: a, end: b };
  }
  const d = Number(scene.duration ?? scene.duration_seconds);
  if (Number.isFinite(d) && d > 0) return { duration: Math.round(d), start: null, end: null };
  return { duration: fallback, start: null, end: null };
}

// Already a pipeline Scenario? Normalize lightly, keep every extra key.
function isScenarioShape(raw) {
  return raw && typeof raw === "object" && Array.isArray(raw.sequence);
}

function normalizeScenarioPassthrough(raw, warnings) {
  const seq = raw.sequence.map((b, i) => {
    if (!b || typeof b !== "object") {
      warnings.push(`sequence[${i}] is not an object — replaced with an empty beat`);
      return { title: `scene_${i + 1}`, image: "", motion: "" };
    }
    const beat = { ...b };
    beat.title = slugTitle(beat.title, `scene_${i + 1}`);
    if (typeof beat.image !== "string") beat.image = String(beat.image ?? "");
    if (typeof beat.motion !== "string") beat.motion = String(beat.motion ?? "");
    return beat;
  });
  const duration = Number(raw.duration);
  const config = {
    ...raw,
    sequence: seq,
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : seq.length * 5 || 5,
    importMeta: {
      ...(raw.importMeta && typeof raw.importMeta === "object" ? raw.importMeta : {}),
      source: IMPORT_SOURCE,
      importedAt: new Date().toISOString(),
    },
  };
  if (typeof config.referencePrompt !== "string" || !config.referencePrompt.trim()) {
    config.referencePrompt = seq[0]?.image || "3D animated kids style, vibrant colors";
    warnings.push("referencePrompt was empty — seeded from the first scene");
  }
  const name = slugTitle(raw.project_title ?? raw.title ?? raw.name, "Imported Project");
  return { name, config, warnings };
}

export function storyboardToScenario(raw) {
  const warnings = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("import JSON must be an object with a scenes[] array");
  }
  if (isScenarioShape(raw)) return normalizeScenarioPassthrough(raw, warnings);

  const scenesRaw = Array.isArray(raw.scenes) ? raw.scenes
    : Array.isArray(raw.sequence) ? raw.sequence
    : Array.isArray(raw.beats) ? raw.beats : null;
  if (!scenesRaw || scenesRaw.length === 0) {
    throw new Error("import JSON has no scenes[] array (expected scenes[].scene_number/name/timestamp/...)");
  }

  const scenes = [...scenesRaw]
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s && typeof s === "object")
    .sort((a, b) => (Number(a.s.scene_number) || a.i + 1) - (Number(b.s.scene_number) || b.i + 1))
    .map(({ s }) => s);
  if (scenes.length !== scenesRaw.length) warnings.push("some scenes entries were not objects and were skipped");

  // Total duration: explicit total_duration/duration wins, else span of the
  // last timestamp, else sum of scene durations.
  let total = parseClock(raw.total_duration ?? raw.duration ?? raw.target_duration);
  let cursor = 0;
  const beats = scenes.map((scene, i) => {
    const n = Number(scene.scene_number) || i + 1;
    const title = slugTitle(scene.name ?? scene.title, `scene_${n}`);
    const cameraAngle = scene.camera_angle ?? scene.camera ?? "";
    const { duration, start, end } = sceneDuration(scene);
    const absStart = start ?? cursor;
    const absEnd = (start != null && end != null) ? end : absStart + duration;
    cursor = Math.max(cursor, absEnd);
    const beat = {
      title,
      image: imagePromptFor(scene),
      motion: motionPromptFor(scene, String(cameraAngle || "").trim()),
      duration,
      scene_number: n,
      start_time: absStart,
      end_time: absEnd,
      // Verbatim storyboard fields — the generation pipeline reads
      // title/image/motion/duration; everything below travels in the JSONB
      // config + project_assets metadata for the UI/timeline.
      ...(scene.name != null ? { scene_name: String(scene.name) } : {}),
      ...(cameraAngle ? { camera_angle: String(cameraAngle) } : {}),
      ...(cameraAngle ? { camera: parseCameraAngle(cameraAngle) } : {}),
      ...(scene.timestamp && typeof scene.timestamp === "object" ? { timestamp: scene.timestamp } : {}),
      ...(Array.isArray(scene.visual_assets) ? { visual_assets: scene.visual_assets.map(String) } : {}),
      ...(scene.character_actions != null ? { character_actions: String(scene.character_actions) } : {}),
      ...(scene.on_screen_text !== undefined ? { on_screen_text: scene.on_screen_text == null ? null : String(scene.on_screen_text) } : {}),
      ...(scene.audio_cues != null ? { audio_cues: String(scene.audio_cues) } : {}),
    };
    // Any other per-scene keys (e.g. narrator, lyrics, sfx) ride along
    // untouched so nothing from the file is lost. (name/title/scene_number
    // already have canonical slots above — skip them to avoid duplicates.)
    const SCENE_KNOWN = new Set(["name", "title", "scene_number", "duration", "duration_seconds"]);
    for (const [k, v] of Object.entries(scene)) {
      if (!(k in beat) && !SCENE_KNOWN.has(k)) beat[k] = v;
    }
    return beat;
  });
  if (total == null || !(total > 0)) {
    total = cursor > 0 ? cursor : beats.reduce((a, b) => a + (Number(b.duration) || 0), 0);
    if (!(total > 0)) total = beats.length * 15;
  }

  const projectTitle = slugTitle(raw.project_title ?? raw.title ?? raw.name, "Imported Project");
  const audience = raw.target_audience ? String(raw.target_audience) : "";
  const channel = raw.channel ? String(raw.channel) : "";
  const format = raw.format ? String(raw.format) : "";
  const descBits = [format, audience ? `for ${audience}` : "", channel ? `(${channel})` : ""].filter(Boolean).join(" ");
  const description = `${projectTitle}${descBits ? ` — ${descBits}` : ""}`;

  const first = scenes[0] ?? {};
  const firstAssets = Array.isArray(first.visual_assets) ? first.visual_assets.join(", ") : "";
  const referencePrompt = slugTitle(
    raw.referencePrompt
      ?? [firstAssets, first.character_actions].filter(Boolean).join(". ")
      ?? `${projectTitle} main character`,
    `${projectTitle} main character`) + `. ${STYLE_SUFFIX}`;

  // Top-level: known storyboard fields get canonical slots; EVERY other key
  // (current + future extras) is copied verbatim so the DB keeps it.
  const KNOWN = new Set([
    "scenes", "sequence", "beats", "project_title", "title", "name",
    "total_duration", "duration", "target_duration", "description",
    "referencePrompt", "reference_prompt", "importMeta",
  ]);
  const config = {
    description: String(raw.description ?? description),
    referencePrompt,
    duration: total,
    sequence: beats,
    ...(audience ? { target_audience: audience } : {}),
    ...(channel ? { channel } : {}),
    ...(format ? { format } : {}),
    ...(raw.project_title ? { project_title: String(raw.project_title) } : {}),
    ...(raw.total_duration != null ? { total_duration: String(raw.total_duration) } : {}),
    importMeta: {
      ...(raw.importMeta && typeof raw.importMeta === "object" ? raw.importMeta : {}),
      source: IMPORT_SOURCE,
      importedAt: new Date().toISOString(),
      sceneCount: beats.length,
    },
  };
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN.has(k) && !(k in config)) config[k] = v;
  }
  return { name: projectTitle, config, warnings };
}
