// AI Story Director — pure helpers (prompt building, schema, JSON
// reliability, board -> scenario mapping). No network, no fs: fully
// unit-testable. The LLM calls live in frontend/server.mjs and reuse the
// exact llama-server convention as the craft endpoints
// (model "local", chat_template_kwargs { enable_thinking: false }).
//
// Pipeline: story input -> bible call (analysis + characters + locations +
// objects + beats) -> scene-batch calls (strict per-scene schema) ->
// approve (boardToScenario -> existing saveScenario -> existing workspace
// generation). Image/video/merge/progress/resume are 100% the existing
// character-sequence pipeline; the director only authors the scenario.

export const SCENE_BATCH = 12;
// Safety ceiling only (prevents runaway 1000+ scene boards from a 3600s
// custom target at 1s/scene). The plan itself is purely story + time driven:
// sceneCount = round(targetSeconds / sceneSeconds), never clamped to a small
// fixed number.
export const MAX_SCENES = 300;

// Target duration / scene duration -> scene count. Deterministic (the AI
// distributes beats across exactly N scenes rather than inventing a count).
// Purely story + time driven: round(target / scene), with only the MAX_SCENES
// safety ceiling above.
export function sceneCountFor(targetSeconds, sceneSeconds) {
  const t = Number(targetSeconds);
  const s = Number(sceneSeconds);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(s) || s <= 0) return 0;
  return Math.min(MAX_SCENES, Math.max(1, Math.round(t / s)));
}

const STYLE_LOCKS = {
  "3D Preschool Animation":
    "Colorful 3D preschool animation, cute rounded characters, big expressive eyes, warm lighting, clean simple backgrounds, soft cinematic rendering",
  "3D Cinematic":
    "High-end 3D cinematic animation, detailed characters, dramatic lighting, rich textures, film-quality rendering",
  Realistic:
    "Ultra photorealistic highly detailed 8k uhd cinematic film still, natural skin texture, detailed expressive eyes, sharp focus, intricate details, realistic lighting and shadows, volumetric lighting, rich colors, shallow depth of field, no cartoon, no painting, no illustration, no blur",
  Anime:
    "Vibrant anime style, clean cel shading, expressive large eyes, dynamic composition, detailed backgrounds",
  Cartoon:
    "Classic 2D cartoon style, bold outlines, bright flat colors, playful squash-and-stretch feel",
  "Indian Mythological":
    "Ultra photorealistic Indian mythological cinematic film still, highly detailed 8k uhd, divine glowing palette, lifelike faces with natural skin texture and detailed expressive eyes, ornate traditional costumes and jewelry with intricate fabric detail, volumetric temple lighting, sharp focus, epic realistic backgrounds, no cartoon, no painting, no illustration, no blur",
  Fantasy:
    "Epic fantasy illustration style, magical glowing accents, lush detailed environments, cinematic atmosphere",
};

// Universal image-quality lock: every keyframe renders 8k + highly clear +
// undistorted, whatever the visual style (cartoon stays cartoon-styled, but
// sharp and well-formed). Enforced server-side in boardToScenario so a
// forgetful model cannot drop it.
export const QUALITY_IMAGE_LOCK =
  "ultra-detailed 8k uhd, highly clear, sharp focus, intricate details, professional cinematic lighting, no distortion, no distorted faces, no deformed faces, no extra limbs, no missing limbs, no blurry, no low quality, no watermark";

/** Append the quality lock unless the prompt already carries it. */
export function withQualityLock(prompt) {
  const t = String(prompt || "").trim();
  if (!t) return QUALITY_IMAGE_LOCK;
  return /8k uhd|ultra-detailed 8k|highly clear/i.test(t) && /no distortion|no distorted/i.test(t)
    ? t
    : `${t}, ${QUALITY_IMAGE_LOCK}`;
}

// Strip connected-movie handoff language from a prompt (used when Connected
// is OFF so approved scenarios carry independent shots): removes
// "continuing from previous shot: ..." clauses and "seamless continuation
// from the previous shot's last frame ..." sentences, then tidies punctuation.
// Aggressive mode (default) also eats a multi-comma clause to the first
// period/end — safe at approve time, where context/style/quality are
// re-grounded right after. Conservative mode (server-side stored-board scrub)
// skips that pass so trailing style/context tokens in the saved prompt survive;
// approve-time stripping still neutralizes any paraphrased remainder.
export function stripContinuityText(prompt, { aggressive = true } = {}) {
  let t = String(prompt || "");
  // Long "continuing from previous shot: <clause>" first (clauses often hold
  // commas): consume to the first period or the end of the string. Exact
  // known-value removal happens before this in boardToScenario/the server
  // scrub; this generic pass is for paraphrased leftovers.
  if (aggressive) {
    t = t.replace(/,?\s*continuing from previous shot\s*:.*?(?=\.|$)/gi, "");
  }
  // Short-clause remainder (no commas): up to the next comma/period/end.
  t = t.replace(/,?\s*continuing from previous shot\s*:[^,.]*(?=[,.]|$)/gi, "");
  // Full chain sentence ("... last frame — hold the exact same character,
  // ..., no cut, no scene jump, smooth continuous motion forward"): commas
  // inside must not terminate the match, so consume up to the first period
  // or the end of the string.
  t = t.replace(/,?\s*seamless continuation from the previous shot's last frame\s*[—–-]\s*hold the exact same character[^.]*(\.|$)/gi, (m) =>
    /^\s*,/.test(m) ? "," : "");
  // Short/paraphrased variants without the em-dash sentence.
  t = t.replace(/,?\s*seamless continuation from the previous shot[^,.]*[,.]?/gi, (m) =>
    /^\s*,/.test(m) ? "," : "");
  return t.replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",").replace(/\s+,/g, ",")
    .replace(/,\s*\./g, ".").trim().replace(/^[,.]+\s*/, "").replace(/\s*,+\s*$/, "");
}

// Motion fidelity lock appended server-side to every video (i2v) prompt so
// the clip only ANIMATES its own scene keyframe: the character, face,
// clothing, colors, lighting and background must stay exactly as the input
// image — at 8k clarity, never distorted/morphed/redesigned.
export const MOTION_FIDELITY_LOCK =
  "Keep the exact character, face, clothing, colors, lighting and background from the input image — do not redesign, restyle or change anything; animate natural motion only, highly clear 8k uhd quality, smooth natural motion, stable character and background, no distortion, no distorted faces, no deformed faces, no morphing, no flicker, no extra limbs, no blurry, no low quality";

// Short probe used to detect whether a motion prompt already carries the lock.
export function motionKeyFor() {
  return "animate natural motion only";
}

// Global style lock text appended server-side to every image prompt so no
// scene can drift off-style even if the model forgets it.
export function styleLockFor(visualStyle, customText) {
  if (visualStyle === "Custom") {
    const t = String(customText || "").trim();
    return t || "Consistent cinematic animation style, high detail";
  }
  return STYLE_LOCKS[visualStyle] || STYLE_LOCKS["3D Preschool Animation"];
}

// Short style key used to detect whether a prompt already carries the lock.
export function styleKeyFor(visualStyle, customText) {
  if (visualStyle === "Custom") return String(customText || "").trim().slice(0, 40) || "consistent style";
  return String(visualStyle || "").toLowerCase();
}

export const DIRECTOR_SYSTEM = `You are the AI Director of Sanskriti AI Studio, a professional film director.
Your job is to transform a user's story into a coherent visual movie.
You are not merely a prompt writer. Think like a filmmaker: understand the
complete story first, then convert important story events into visually
meaningful scenes. Do not blindly split paragraphs into scenes.
Maintain strict CHARACTER CONSISTENCY, location consistency, object
consistency, visual style consistency and chronological continuity.
CHARACTER CONSISTENCY RULE: every scene's image_prompt MUST contain the
exact visual_identity_prompt verbatim for each character on screen —
copy-paste, never paraphrase, never shorten, never restyle.
CONTEXT RULE: every image_prompt is self-contained scene context — verbatim
character/location/object identities + the scene's action, expression,
body language, camera, lighting and environment. Never write a generic
prompt that could belong to any scene.
SAME-SCENE LINKAGE RULE: each scene's video_prompt animates THAT scene's
own keyframe image only — describe MOTION ONLY (what moves and how), never
looks, face, clothing, colors or style, so the clip keeps the keyframe's
character exactly instead of generating a different character.
QUALITY RULES (mandatory, every prompt): images are ultra-detailed 8k uhd,
highly clear, sharp focus — never distorted, deformed, blurry, low-quality
or watermarked (no distorted faces, no extra/missing limbs). Videos are
highly clear 8k uhd quality with smooth natural motion and a stable
character/background — never distorted, morphed, flickering or redesigned.
Never change an established character's face, body, species, clothing or
colors unless the story explicitly requires it. Never invent major plot
events that contradict the story; minor visual details for cinematic
presentation are allowed. Turn abstract emotions into visible actions
(happy -> smiling, jumping, clapping; sad -> lowered head, teary eyes;
surprised -> widened eyes, open mouth; angry -> tightened fists;
scared -> stepping backward, trembling; excited -> energetic movement).
Video prompts describe MOTION ONLY (what moves and how) — never looks,
face, clothing, colors or style, so clips animate the locked keyframe
without redesigning the character.
 LYRIC SEMANTIC MODE (song boards): one lyric line is NEVER automatically one
 scene. Deeply analyze every meaningful word/phrase of each line (subject,
 action, object, location, emotion, cause/effect, symbolism) and split the
 line into as many visual shots as its semantic complexity needs (1 for a
 simple line, up to ~5 for a line with several distinct actions/events) —
 never one shot per word, never a generic summary of the whole line. Every
 shot maps to a meaningful lyric segment and carries its lyric linkage
 (lyric_line_id, lyric_segment, semantic_meaning, visual_event, shot_id like
  "12-A", parent_line_id) plus a continuity decision (continuity_required +
  reference_source: NONE | CHARACTER_REFERENCE | LOCATION_REFERENCE |
  PREVIOUS_IMAGE | PREVIOUS_VIDEO_LAST_FRAME | MULTIPLE_REFERENCES). Prefer
  the previous shot's end state when the same character/location/action
  continues; set continuity_required false for fresh establishing shots.
  (When the batch brief orders INDEPENDENT SCENES, every shot uses
  continuity_required false + reference_source NONE instead.)
 Devotional lyrics get respectful Indian-mythological symbolism, never flat
 literal or modern readings.
 MULTI-SHOT SCENES (songs AND stories): when one lyric line or story sentence
 covers several distinct persons, objects or locations, NEVER cram them all
 into a single image. Split the scene into timed shots (2-5) INSIDE the same
 scene — one shot per entity or moment — each with its own segment text,
 cast, location, prompts and dialogue. Size every shot by pronounceable
 length (words in its segment + spoken lines: ~2.5 words/sec, Devanagari
 ~2.2 words/sec, +0.35s pause between lines) so the shot durations sum
 EXACTLY to the scene's duration_seconds, with cumulative boundaries from 0
 (shot 1: 0-1.4s, shot 2: 1.4-2.5s, ...). Single-entity scenes use exactly 1
 shot.
 DYNAMIC SCENE PLANNING: analyze the source LINE BY LINE, in order — you
 decide how many scenes the batch needs, where each scene starts/ends
 (line_from/line_to, covering every line, skipping none), each scene's own
 duration_seconds from content weight, and its shots. Never pad to a fixed
 scene count and never copy example durations — every duration comes from
 pronounceable length + action complexity.
Do not expose internal reasoning. Return ONLY valid JSON matching the
requested schema. No markdown fences, no commentary outside the JSON.`;

// Strip markdown fences / prose and return the first top-level JSON
// object (or array when allowArray). Throws with a useful message.
export function stripJson(text, { allowArray = false } = {}) {
  const t = String(text || "").trim();
  if (!t) throw new Error("LLM returned an empty response");
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1].trim() : t;
  const start = allowArray ? body.search(/[{[]/) : body.indexOf("{");
  if (start < 0) throw new Error("LLM returned no JSON object");
  const slice = body.slice(start);
  // Balanced scan from the first opener so trailing prose never corrupts
  // the parse (a greedy regex would swallow it and fail).
  const open = slice[0];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && slice[0] === open && c === close) {
        const candidate = slice.slice(0, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (e) {
          throw new Error(`LLM JSON parse failed: ${e.message}`);
        }
      }
    }
  }
  throw new Error("LLM JSON is truncated or unbalanced");
}

// Salvage complete scene objects from a batch response whose tail was cut
// off (model hit max_tokens / context mid-array). Scans the "scenes" array
// and JSON-parses each balanced {...} object; the trailing partial object
// is skipped, everything before it is kept. Returns [] when nothing usable
// exists. Pure — lets the server bind finished scenes instead of 500ing.
export function extractPartialScenes(text) {
  const t = String(text || "");
  const m = t.search(/"scenes"\s*:/);
  if (m < 0) return [];
  const arrStart = t.indexOf("[", m);
  if (arrStart < 0) return [];
  const out = [];
  let i = arrStart + 1;
  while (i < t.length) {
    while (i < t.length && /[\s,]/.test(t[i])) i++;
    if (i >= t.length || t[i] === "]") break;
    if (t[i] !== "{") { i++; continue; }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < t.length; j++) {
      const c = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break; // truncated object — stop, keep what we have
    try {
      const obj = JSON.parse(t.slice(i, j + 1));
      if (obj && typeof obj === "object") out.push(obj);
    } catch { /* skip one corrupt object, continue with the next */ }
    i = j + 1;
  }
  return out;
}

const str = (v, fb = "") => (v == null ? fb : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
// Bible-id-safe string: only string/number primitives survive — model output
// like objects/arrays in id slots would otherwise stringify to garbage refs
// ("[object Object]" characters seen on real boards) that match no bible
// entry and silently break identity grounding downstream.
const idStr = (v) => (typeof v === "string" || typeof v === "number" ? str(v).trim() : "");

// Pre-defined CHARACTER CONSISTENCY rules shipped by default for every
// character. The UI popup lets the user toggle/edit/reset these per
// character at any time (stored as character.consistency_rules).
export const DEFAULT_CHARACTER_CONSISTENCY_RULES = [
  "Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene.",
  "Keep the exact same body, species traits and proportions in every scene.",
  "Keep the exact same clothing, colors and accessories unless the story explicitly changes them.",
  "Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it.",
  "Keep the same art style and rendering for this character across all scenes.",
  "Stage speaking scenes front-facing so the face stays clearly visible.",
];

// Effective rules for one character: stored custom rules win, otherwise the
// pre-defined defaults (so old boards without the field get defaults too).
export function characterConsistencyRules(c) {
  const o = c && typeof c === "object" ? c : {};
  if (Array.isArray(o.consistency_rules)) {
    return o.consistency_rules.map((x) => str(x)).filter(Boolean);
  }
  return [...DEFAULT_CHARACTER_CONSISTENCY_RULES];
}

// Normalize one bible character (missing keys become empty, never crash).
// Ids derive from the name when absent so references stay stable/readable.
const slugId = (v, fb) => str(v, fb).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || fb;
export function normalizeCharacter(c, i) {
  const o = c && typeof c === "object" ? c : {};
  const app = o.appearance && typeof o.appearance === "object" ? o.appearance : {};
  const clo = o.clothing && typeof o.clothing === "object" ? o.clothing : {};
  return {
    character_id: slugId(o.character_id || o.name, `character_${i + 1}`),
    name: str(o.name, `Character ${i + 1}`),
    role: str(o.role, "supporting"),
    species: str(o.species),
    age: str(o.age),
    appearance: Object.fromEntries(Object.entries(app).map(([k, v]) => [k, str(v)])),
    clothing: Object.fromEntries(Object.entries(clo).map(([k, v]) => [k, str(v)])),
    personality: arr(o.personality).map((x) => str(x)).filter(Boolean),
    visual_identity_prompt: str(o.visual_identity_prompt),
    consistency_rules: characterConsistencyRules(o),
  };
}

export function normalizeLocation(l, i) {
  const o = l && typeof l === "object" ? l : {};
  return {
    location_id: slugId(o.location_id || o.name, `location_${i + 1}`),
    name: str(o.name, `Location ${i + 1}`),
    description: str(o.description),
    visual_identity_prompt: str(o.visual_identity_prompt),
    time_of_day: str(o.time_of_day),
    lighting: str(o.lighting),
    color_palette: str(o.color_palette),
  };
}

export function normalizeObject(ob, i) {
  const o = ob && typeof ob === "object" ? ob : {};
  return {
    object_id: slugId(o.object_id || o.name, `object_${i + 1}`),
    name: str(o.name, `Object ${i + 1}`),
    description: str(o.description),
    visual_identity_prompt: str(o.visual_identity_prompt),
  };
}

// Normalize the bible-call payload into a strict blueprint.
export function normalizeBlueprint(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const a = o.analysis && typeof o.analysis === "object" ? o.analysis : {};
  return {
    logline: str(o.logline),
    analysis: {
      plot: str(a.plot),
      beginning: str(a.beginning),
      middle: str(a.middle),
      climax: str(a.climax),
      ending: str(a.ending),
      main_character: str(a.main_character),
      supporting_characters: arr(a.supporting_characters).map((x) => str(x)).filter(Boolean),
      antagonist: a.antagonist == null ? null : str(a.antagonist),
      objects: arr(a.objects).map((x) => str(x)).filter(Boolean),
      locations: arr(a.locations).map((x) => str(x)).filter(Boolean),
      events: arr(a.events).map((x) => str(x)).filter(Boolean),
      relationships: str(a.relationships),
      emotional_progression: str(a.emotional_progression),
      timeline: str(a.timeline),
      visual_moments: arr(a.visual_moments).map((x) => str(x)).filter(Boolean),
    },
    characters: arr(o.characters).map(normalizeCharacter),
    locations: arr(o.locations).map(normalizeLocation),
    objects: arr(o.objects).map(normalizeObject),
    // Song-mode lyric decomposition (bible call): one entry per lyric line
    // with its semantic analysis + planned shot count. Empty on story boards.
    lyric_lines: arr(o.lyric_lines).map(normalizeLyricLine),
    beats: arr(o.beats).map((b, i) => {
      const x = b && typeof b === "object" ? b : {};
      // Place/props anchor per beat (bible + beats-refresh asks for them):
      // scene batches stage each beat in the right location with the right
      // visible objects. Absent on old boards — batches fall back to the
      // full location/object lists exactly as before.
      const beatObjs = arr(x.objects).map((y) => idStr(y)).filter(Boolean).slice(0, 6);
      const out = { n: Number(x.n) || i + 1, title: str(x.title, `Beat ${i + 1}`), summary: str(x.summary) };
      if (idStr(x.location)) out.location = idStr(x.location);
      if (beatObjs.length) out.objects = beatObjs;
      return out;
    }),
  };
}

// Which beats does a scene range cover? Proportional mapping so every batch
// plans only its own share of the story: scene i (1-based) of N total maps
// to beat floor((i-1) * B / N). A batch covering scenes [start, start+count)
// gets beats [floor((start-1)*B/N), ceil((start+count-1)*B/N)) — at least one.
// Without this every batch saw ALL beats and re-planned the opening, which is
// what produced the same dialogue line copied across dozens of scenes.
export function beatsForSceneRange(beats, startNumber, count, totalScenes) {
  const list = arr(beats);
  if (!list.length) return [];
  const n = Math.max(1, Number(totalScenes) || list.length);
  const start = Math.max(1, Number(startNumber) || 1);
  const c = Math.max(1, Number(count) || 1);
  const from = Math.min(list.length - 1, Math.floor(((start - 1) * list.length) / n));
  const to = Math.min(list.length, Math.max(from + 1, Math.ceil(((start + c - 1) * list.length) / n)));
  return list.slice(Math.max(0, from), to);
}

// True when two dialogue lines are the same text (case/space/punctuation
// insensitive) — used to drop LLM repeats, never to merge distinct lines.
export function sameLine(a, b) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  return !!x && x === y;
}

// Valid reference sources for the continuity decision (§7–8 of the lyric
// plan). NONE = fresh shot (e.g. an establishing aerial after a close-up).
export const REFERENCE_SOURCES = [
  "NONE",
  "CHARACTER_REFERENCE",
  "LOCATION_REFERENCE",
  "PREVIOUS_IMAGE",
  "PREVIOUS_VIDEO_LAST_FRAME",
  "MULTIPLE_REFERENCES",
];

export function normalizeReferenceSource(v) {
  const t = String(v || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return REFERENCE_SOURCES.includes(t) ? t : "NONE";
}

// Split pasted lyrics into numbered singable lines. Section headers
// ("[Verse 1]", "Chorus:", "(Bridge)" ...) and blank lines are dropped —
// only actual lyric text gets an id. Pure + deterministic.
export function parseLyricLines(story) {
  const out = [];
  for (const raw of String(story || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[.*\]$/.test(line)) continue; // [Verse 1], [Chorus], ...
    if (/^\(.*\)$/.test(line) && line.length < 40) continue; // (Bridge) ...
    if (/^(verse|chorus|bridge|intro|outro|pre[-\s]?chorus|hook|refrain)\s*[:\d.\s-]*$/i.test(line)) continue;
    out.push({ lyric_line_id: out.length + 1, lyric_text: line });
  }
  return out;
}

// Lines whose estimated window overlaps [fromSec, toSec) — the source slice
// one planning batch must cover line by line. Pure. Windows come from
// estimateLyricTiming (songs) or the same word-proportional estimate over
// story lines; boundaries touch (>= from, < to, plus any line straddling
// the start so no line is ever skipped between batches).
export function linesForTimeWindow(timedLines, fromSec, toSec) {
  const list = arr(timedLines);
  const from = Number(fromSec);
  const to = Number(toSec);
  if (!list.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  return list.filter((l) => {
    const s = Number(l.song_start_time);
    const e = Number(l.song_end_time);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return false;
    return e > from && s < to;
  });
}

// Verify an AI-declared plan completion (trust-but-verify: small models emit
// complete=true mid-story, which once shrank a 100-scene plan to 7 scenes at
// 33s of a 300s target). Complete only when the last source line is covered
// (max line_to / lyric linkage across scenes >= total lines) AND the planned
// seconds reach the target (within tolerance). Without the flag, completion
// is purely timeline-driven. Pure — unit-tested, used by the server loop.
export function verifyPlanComplete(scenes, { targetSeconds = null, totalLines = 0, flag = false } = {}) {
  const list = arr(scenes);
  if (!list.length) return false;
  const target = Number(targetSeconds);
  const hasTarget = Number.isFinite(target) && target > 0;
  const prog = planProgress(list, hasTarget ? target : null);
  if (!flag) return prog.done;
  const maxCover = list.reduce((a, s) => {
    const cands = [Number(s.line_to), Number(s.lyric_line_id), Number(s.parent_line_id)]
      .filter((v) => Number.isFinite(v) && v > 0);
    return cands.length ? Math.max(a, ...cands) : a;
  }, 0);
  const total = Number(totalLines);
  const coversEnd = !(total > 0) || maxCover >= total;
  const timeOk = !hasTarget || (target - prog.plannedSeconds) <= Math.max(2, target * 0.02);
  return coversEnd && timeOk;
}

// Planning progress in seconds: how much story time the planned scenes
// cover vs the target. Pure — the server loop uses it to stop when the
// timeline is covered (AI decides scene counts/durations dynamically).
export function planProgress(scenes, targetSeconds) {
  const list = arr(scenes);
  const target = Number(targetSeconds);
  const plannedSeconds = Math.round(list.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0) * 10) / 10;
  const remaining = Number.isFinite(target) && target > 0 ? Math.round((target - plannedSeconds) * 10) / 10 : null;
  return {
    plannedSeconds,
    remaining,
    done: remaining != null ? remaining <= 0 : false,
  };
}

// Distribute the song duration across lyric lines proportional to word
// count (denser lines take longer to sing). Returns the same lines with
// song_start_time / song_end_time (seconds, 1 decimal). Pure fallback for
// when no word/line timestamps exist — the LLM refines per-shot timing.
export function estimateLyricTiming(lines, totalSeconds) {
  const list = arr(lines).map((l) => (l && typeof l === "object" ? { ...l } : { lyric_text: str(l) }));
  const total = Number(totalSeconds);
  if (!list.length || !Number.isFinite(total) || total <= 0) return list;
  const weights = list.map((l) => Math.max(1, String(l.lyric_text || "").split(/\s+/).filter(Boolean).length));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0;
  return list.map((l, i) => {
    const dur = i === list.length - 1
      ? Math.round((total - cursor) * 10) / 10
      : Math.round(((weights[i] / sum) * total) * 10) / 10;
    const start = Math.round(cursor * 10) / 10;
    cursor += dur;
    return { ...l, song_start_time: start, song_end_time: Math.round(cursor * 10) / 10 };
  });
}

// Normalize one lyric-line entry of the blueprint (bible call, song mode).
export function normalizeLyricLine(l, i) {
  const o = l && typeof l === "object" ? l : {};
  const id = Number(o.lyric_line_id) || i + 1;
  return {
    lyric_line_id: id,
    lyric_text: str(o.lyric_text || o.text),
    semantic_analysis: str(o.semantic_analysis || o.meaning),
    visual_complexity: /^(low|medium|high)$/i.test(str(o.visual_complexity)) ? str(o.visual_complexity).toLowerCase() : "medium",
    planned_shots: Math.min(5, Math.max(1, Math.round(Number(o.planned_shots) || 1))),
  };
}

// Final validation checklist (§21) as a pure function: returns an array of
// human-readable issue strings (empty = plan looks coherent). Non-blocking
// by design — the server logs these as warnings, never rejects a plan.
export function validateLyricPlan(scenes, lyricLines, totalSeconds) {
  const issues = [];
  const list = arr(scenes);
  const lines = arr(lyricLines);
  if (!list.length) return ["no scenes planned"];
  // 1–3. Every lyric line analyzed and visually represented.
  if (lines.length) {
    const covered = new Set();
    for (const s of list) {
      const id = Number(s.lyric_line_id ?? s.parent_line_id);
      if (Number.isFinite(id) && id > 0) covered.add(id);
    }
    for (const l of lines) {
      if (!covered.has(Number(l.lyric_line_id))) {
        issues.push(`lyric line ${l.lyric_line_id} has no visual shot: "${str(l.lyric_text).slice(0, 60)}"`);
      }
    }
  }
  // 4. Shot timing fits the song timeline.
  if (Number.isFinite(Number(totalSeconds)) && Number(totalSeconds) > 0) {
    const sum = list.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0);
    if (Math.abs(sum - Number(totalSeconds)) > Math.max(5, Number(totalSeconds) * 0.15)) {
      issues.push(`shot durations sum to ~${Math.round(sum)}s but the song is ~${Math.round(Number(totalSeconds))}s`);
    }
  }
  // 8–9. Continuity references point at real earlier shots.
  const shotIds = new Set(list.map((s) => str(s.shot_id)).filter(Boolean));
  for (const s of list) {
    const rs = normalizeReferenceSource(s.reference_source);
    if (s.continuity_required && rs === "NONE") {
      issues.push(`scene ${s.scene_number}: continuity_required but reference_source is NONE`);
    }
    for (const ref of arr(s.continuity_refs)) {
      if (ref && !shotIds.has(str(ref))) issues.push(`scene ${s.scene_number}: continuity_ref "${ref}" matches no shot_id`);
    }
  }
  // 9–10. Image and video prompts differ; video prompts carry motion.
  const MOTION_RE = /mov|pan|tilt|dolly|track|orbit|crane|zoom|walk|run|fly|dance|turn|nod|gestur|wav|blink|smile|flow|drift|rise|fall|sway|orbit|glid|camera|slow/i;
  for (const s of list) {
    if (str(s.image_prompt) && str(s.image_prompt) === str(s.video_prompt)) {
      issues.push(`scene ${s.scene_number}: image_prompt and video_prompt are identical`);
    }
    if (str(s.video_prompt) && !MOTION_RE.test(str(s.video_prompt))) {
      issues.push(`scene ${s.scene_number}: video_prompt describes no motion`);
    }
  }
  // 11. No exact-duplicate shots.
  const seenAct = new Set();
  for (const s of list) {
    const key = `${str(s.lyric_segment)}||${str(s.action)}`.toLowerCase();
    if (key.length > 6) {
      if (seenAct.has(key)) issues.push(`scene ${s.scene_number}: duplicates an earlier shot's segment+action`);
      else seenAct.add(key);
    }
  }
  // 12. Multi-shot scenes tile their duration; shot ids stay unique.
  const seenShotIds = new Set(list.map((s) => str(s.shot_id)).filter(Boolean));
  for (const s of list) {
    const shots = arr(s.shots);
    for (const sh of shots) {
      const id = str(sh.shot_id);
      if (id) {
        if (seenShotIds.has(id)) issues.push(`scene ${s.scene_number}: duplicate shot_id "${id}"`);
        else seenShotIds.add(id);
      }
    }
    if (shots.length > 1) {
      const sum = shots.reduce((a, x) => a + (Number(x.duration_seconds) || 0), 0);
      if (Math.abs(sum - (Number(s.duration_seconds) || 0)) > 0.2) {
        issues.push(`scene ${s.scene_number}: shots sum to ~${Math.round(sum * 10) / 10}s but the scene is ${s.duration_seconds}s`);
      }
    }
  }
  // 13. Consecutive scenes should advance the source lines, not re-cover
  // the same range (a batch re-planning the opening instead of continuing).
  const covered = [];
  for (const s of list) {
    const a = Number(s.line_from);
    const b = Number(s.line_to);
    if (Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0) covered.push([s.scene_number, a, b]);
  }
  for (let i = 1; i < covered.length; i++) {
    if (covered[i][1] <= covered[i - 1][1]) {
      issues.push(`scene ${covered[i][0]}: re-covers lines ${covered[i][1]}–${covered[i][2]} already covered at scene ${covered[i - 1][0]} (plan stalls instead of advancing)`);
    }
  }
  return issues;
}

// Story QA (§21) as a shared pure validator: the Story page and the
// server approve gate use the same checklist, so the client never passes a
// board the server would reject. Returns { errors, warnings } — errors block
// Approve, warnings are advisory. Never throws (garbage input yields errors).
export function validateStoryBoard(board) {
  const errors = [];
  const warnings = [];
  const b = board && typeof board === "object" ? board : {};
  const chars = arr(b.blueprint && b.blueprint.characters);
  const scenes = arr(b.scenes);
  if (!b.blueprint) errors.push("No story analysis yet — press Analyze Story first.");
  if (!chars.length) errors.push("No characters in the registry — regenerate the analysis.");
  if (!scenes.length) errors.push("No scenes planned yet — press Generate Scenes.");
  if (!errors.length) {
    // Registry: stable ids + continuity canon (visual_identity_prompt).
    const ids = new Set();
    const names = new Map();
    chars.forEach((c, i) => {
      const o = c && typeof c === "object" ? c : {};
      const id = slugId(o.character_id || o.name, `character_${i + 1}`);
      const nm = str(o.name).trim().toLowerCase();
      if (id) ids.add(id);
      if (nm && !names.has(nm)) names.set(nm, id);
      if (!str(o.visual_identity_prompt).trim()) {
        warnings.push(`Character "${str(o.name, id)}" has no visual identity — appearance may drift between scenes.`);
      }
    });
    const normKey = (v) => str(v).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const known = (v) => {
      const k = normKey(v);
      return !k || ids.has(k) || names.has(str(v).trim().toLowerCase());
    };
    // Scene order: numbers unique and strictly increasing in plan order.
    const seenNums = new Set();
    let prevNum = 0;
    scenes.forEach((s, si) => {
      const label = `Scene ${s && s.scene_number ? s.scene_number : si + 1}`;
      const n = Number(s && s.scene_number);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push(`${label} has no valid scene_number.`);
      } else {
        if (seenNums.has(n)) errors.push(`${label} reuses scene_number ${n} — plan order is ambiguous.`);
        seenNums.add(n);
        if (n <= prevNum) errors.push(`${label} is out of order (scene_number ${n} after ${prevNum}).`);
        prevNum = Math.max(prevNum, n);
      }
      for (const cid of arr(s && s.characters)) {
        if (!known(cid)) errors.push(`${label} references unknown character "${idStr(cid)}" (not in the registry).`);
      }
      for (const sh of arr(s && s.shots)) {
        for (const cid of arr(sh && sh.characters)) {
          if (!known(cid)) errors.push(`${label} shot ${str(sh.shot_id)} references unknown character "${idStr(cid)}".`);
        }
      }
    });
    // Dialogue: ownership (exactly one valid speaker), text, emotion,
    // expression; the same line under two speakers = multi-owner accident.
    const lineOwners = new Map();
    const normLine = (t) => str(t).toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
    const checkDialogue = (dlg, where) => {
      arr(dlg).forEach((d, di) => {
        const at = `${where} dialogue ${di + 1}`;
        const o = d && typeof d === "object" ? d : {};
        const line = str(o.line).trim();
        const speaker = str(o.speaker).trim();
        if (!line) { errors.push(`${at} has no text.`); return; }
        if (!speaker) { errors.push(`${at} ("${line.slice(0, 40)}…") has no speaker.`); return; }
        if (!known(speaker)) {
          errors.push(`${at} speaker "${speaker}" is not a registered character.`);
          return;
        }
        if (!str(o.emotion).trim()) errors.push(`${at} (${speaker}) is missing emotion.`);
        if (!str(o.expression).trim()) errors.push(`${at} (${speaker}) is missing expression.`);
        const nl = normLine(line);
        if (nl) {
          const key = normKey(speaker);
          if (lineOwners.has(nl) && lineOwners.get(nl) !== `${where}::${key}` && lineOwners.get(nl).split("::")[1] !== key) {
            const [first] = lineOwners.get(nl).split("::");
            errors.push(`${at} repeats the line from ${first} under a different speaker — dialogue belongs to exactly one character.`);
          } else if (!lineOwners.has(nl)) {
            lineOwners.set(nl, `${where}::${key}`);
          } else if (lineOwners.get(nl).split("::")[0] === where) {
            warnings.push(`${at} repeats a line from the same scene — possible AI duplication.`);
          }
        }
      });
    };
    scenes.forEach((s, si) => {
      const label = `Scene ${s.scene_number || si + 1}`;
      checkDialogue(s.dialogue, label);
      arr(s.shots).forEach((sh) => {
        if (arr(sh.dialogue).length) checkDialogue(sh.dialogue, `${label} shot ${str(sh.shot_id)}`);
      });
    });
  }
  return { errors, warnings };
}

// Safe automatic repairs for validateStoryBoard errors: fills missing
// emotion/expression with neutral defaults, drops unknown character refs
// (mirroring canonicalizeSceneRefs) and empty dialogue lines, renumbers
// scenes 1..N in plan order. Returns { board, fixed } (fixed = notes shown
// to the user). Pure — the caller persists via PUT when fixed.length > 0.
export function autoFixStoryBoard(board) {
  const fixed = [];
  const b = board && typeof board === "object" ? board : {};
  const chars = arr(b.blueprint && b.blueprint.characters);
  const ids = new Set(chars.map((c, i) => {
    const o = c && typeof c === "object" ? c : {};
    return slugId(o.character_id || o.name, `character_${i + 1}`);
  }));
  const names = new Set(chars.map((c) => str(c && c.name).trim().toLowerCase()).filter(Boolean));
  const normKey = (v) => str(v).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const known = (v) => {
    const k = normKey(v);
    return k && (ids.has(k) || names.has(str(v).trim().toLowerCase()));
  };
  const fixDlg = (dlg, where) => {
    let changed = false;
    const out = arr(dlg).map((d) => {
      const o = d && typeof d === "object" ? { ...d } : {};
      if (!str(o.line).trim()) { changed = true; return null; }
      if (!str(o.emotion).trim()) { o.emotion = "neutral"; changed = true; fixed.push(`${where}: filled missing emotion with "neutral".`); }
      if (!str(o.expression).trim()) { o.expression = "calm, natural expression"; changed = true; fixed.push(`${where}: filled missing expression with a calm default.`); }
      if (o.speaker && !known(o.speaker)) { changed = true; fixed.push(`${where}: dropped dialogue by unknown speaker "${str(o.speaker)}".`); return null; }
      return o;
    }).filter(Boolean);
    return { out, changed };
  };
  const scenes = arr(b.scenes).map((s, si) => {
    const o = s && typeof s === "object" ? { ...s } : {};
    const label = `Scene ${o.scene_number || si + 1}`;
    const keptChars = arr(o.characters).filter((c) => known(c));
    if (keptChars.length !== arr(o.characters).length) {
      fixed.push(`${label}: dropped unknown character refs.`);
    }
    o.characters = keptChars;
    const r = fixDlg(o.dialogue, label);
    if (r.changed) o.dialogue = r.out;
    if (Array.isArray(o.shots)) {
      o.shots = o.shots.map((sh) => {
        const so = sh && typeof sh === "object" ? { ...sh } : {};
        so.characters = arr(so.characters).filter((c) => known(c));
        const sr = fixDlg(so.dialogue, `${label} shot ${str(so.shot_id)}`);
        if (sr.changed) so.dialogue = sr.out;
        return so;
      });
    }
    if (Number(o.scene_number) !== si + 1) {
      fixed.push(`${label}: renumbered to scene ${si + 1}.`);
      o.scene_number = si + 1;
    }
    return o;
  });
  return { board: { ...b, scenes }, fixed: [...new Set(fixed)] };
}

const CAMERA_DEFAULT = { shot_type: "Medium Shot", angle: "Eye Level", movement: "Static" };

// Normalize one scene: defaults for missing keys, enforced numbering and
// duration clamp. Style lock is appended by boardToScenario (single place).
// dialogue = [{ speaker (character_id), line (speakable text),
//   expression (facial expression while speaking, e.g. "wide happy smile"),
//   emotion (delivery feeling, e.g. "joyful"), pitch (voice pitch hint:
//   "low"|"medium"|"high") }] — voiced per character (Edge-TTS, rate/pitch
// shaped by expression/emotion in lib/tts.mjs) and lip-synced
// (Easy-Wav2lip) downstream; the clip length for the beat always grows to
// fit the spoken audio (estimateDialogueDuration pre-plan, exact wav after).
export function normalizeDialogue(d) {
  return arr(d).map((x) => {
    const o = x && typeof x === "object" ? x : {};
    const out = { speaker: slugId(idStr(o.speaker), ""), line: str(o.line) };
    const expr = str(o.expression).trim();
    const emo = str(o.emotion).trim();
    const pitch = str(o.pitch).trim().toLowerCase();
    if (expr) out.expression = expr.slice(0, 120);
    if (emo) out.emotion = emo.slice(0, 80);
    if (["low", "medium", "high"].includes(pitch)) out.pitch = pitch;
    return out;
  }).filter((x) => x.line.trim());
}
// Floor for one timed shot inside a multi-shot scene (seconds). Shots are
// sized by pronounceable length, never shorter than this.
export const MIN_SHOT_SECONDS = 0.5;

// Split a scene's total seconds across pronounceable segments (the shot
// timeline). Pure: word-count proportional (denser segments take longer —
// the same rule as estimateLyricTiming), each shot >= MIN_SHOT_SECONDS,
// 1-decimal timings that sum EXACTLY to the total (the last shot absorbs
// rounding). Missing/blank segments share evenly. Never throws — degenerate
// input yields even splits.
export function splitSceneTimeline(segments, totalSeconds) {
  const segs = arr(segments).map((x) =>
    str(x && typeof x === "object" ? (x.lyric_segment ?? x.segment ?? x.text ?? x.line ?? "") : x));
  const total = Number(totalSeconds);
  const k = segs.length;
  if (!k || !Number.isFinite(total) || total <= 0) return [];
  const weights = segs.map((t) => Math.max(1, t.split(/\s+/).filter(Boolean).length));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  // Reserve the floor per shot first so tiny segments never vanish; split
  // only the remainder proportionally.
  const floor = Math.min(MIN_SHOT_SECONDS, total / k);
  const rest = Math.max(0, total - floor * k);
  let cursor = 0;
  return segs.map((t, i) => {
    let dur;
    if (i === k - 1) {
      dur = Math.round((total - cursor) * 10) / 10;
    } else {
      dur = Math.max(0.1, Math.round((floor + (weights[i] / sum) * rest) * 10) / 10);
    }
    const start = Math.round(cursor * 10) / 10;
    cursor = Math.round((cursor + dur) * 10) / 10;
    return { duration_seconds: dur, start_time: start, end_time: cursor };
  });
}

// Normalize one timed sub-shot (same prompt fields as a scene — a shot
// flattens to exactly one generation beat at approve time). Ids default to
// "<scene>-<letter>" (e.g. "7-A"); timings are repaired by normalizeShots,
// so a missing/garbage duration here never breaks the scene timeline.
export function normalizeShot(sh, sceneNumber, shotIdx) {
  const o = sh && typeof sh === "object" ? sh : {};
  const cam = o.camera && typeof o.camera === "object" ? o.camera : {};
  const letter = String.fromCharCode(65 + Math.max(0, shotIdx));
  const dur = Number(o.duration_seconds);
  const t0 = Number(o.start_time);
  const t1 = Number(o.end_time);
  const parentLine = Number(o.parent_line_id ?? o.lyric_line_id);
  return {
    shot_id: str(o.shot_id) || `${sceneNumber}-${letter}`,
    shot_number: Math.max(1, Math.round(Number(o.shot_number) || 0) || shotIdx + 1),
    lyric_segment: str(o.lyric_segment || o.segment),
    semantic_meaning: str(o.semantic_meaning || o.meaning),
    visual_event: str(o.visual_event),
    characters: arr(o.characters).map((x) => idStr(x)).filter(Boolean),
    location: str(o.location),
    time_of_day: str(o.time_of_day),
    action: str(o.action),
    emotion: str(o.emotion),
    expression: str(o.expression),
    body_language: str(o.body_language),
    camera: {
      shot_type: str(cam.shot_type, CAMERA_DEFAULT.shot_type),
      angle: str(cam.angle, CAMERA_DEFAULT.angle),
      movement: str(cam.movement, CAMERA_DEFAULT.movement),
    },
    lighting: str(o.lighting),
    environment: str(o.environment),
    continuity_from_previous_scene: str(o.continuity_from_previous_scene),
    transition_to_next_scene: str(o.transition_to_next_scene),
    dialogue: normalizeDialogue(o.dialogue),
    image_prompt: str(o.image_prompt),
    video_prompt: str(o.video_prompt),
    duration_seconds: Number.isFinite(dur) && dur > 0 ? Math.min(30, dur) : NaN,
    start_time: Number.isFinite(t0) && t0 >= 0 ? Math.round(t0 * 10) / 10 : null,
    end_time: Number.isFinite(t1) && t1 > 0 ? Math.round(t1 * 10) / 10 : null,
    lyric_line_id: Number.isFinite(parentLine) && parentLine > 0 ? parentLine : null,
    parent_line_id: Number.isFinite(parentLine) && parentLine > 0 ? parentLine : null,
    lyric_text: str(o.lyric_text),
    song_start_time: null,
    song_end_time: null,
    continuity_required: o.continuity_required === true,
    reference_source: normalizeReferenceSource(o.reference_source),
    continuity_refs: arr(o.continuity_refs).map((x) => idStr(x)).filter(Boolean).slice(0, 4),
  };
}

// Bible-id grounding for one normalized scene (+ its shots): resolve every
// characters/location entry against the bible (exact id OR display name,
// case-insensitive) and canonicalize to the id, so downstream grounding
// (boardToScenario's charById/locById lookups) actually hits. Repairs:
// - location naming an OBJECT (seen on real boards: "apple_tree" as the
//   scene location) moves to continuity_refs (so it still grounds the frame)
//   and the location is cleared to unknown rather than kept as a miss;
// - unknown character refs (hallucinated names, "children") are dropped —
//   keeping them would stage ungroundable faces no pipeline step can anchor;
// - unresolvable free-text locations are KEPT as-is (status quo) and
//   reported, since dropping them would genericize the background.
// Returns { scene, repairs } (repairs = human-readable notes, [] when clean).
// Pure — the server aggregates repairs into board.warn.
export function canonicalizeSceneRefs(s, blueprint) {
  const repairs = [];
  const b = blueprint && typeof blueprint === "object" ? blueprint : {};
  const byIdName = (list, idKey) => {
    const m = new Map();
    for (const e of arr(list)) {
      if (!e || typeof e !== "object") continue;
      const id = idStr(e[idKey]);
      const name = str(e.name).trim().toLowerCase();
      if (id) {
        m.set(id.toLowerCase(), id);
        if (name && !m.has(name)) m.set(name, id);
      } else if (name && !m.has(name)) {
        m.set(name, str(e.name).trim());
      }
    }
    return m;
  };
  const chars = byIdName(b.characters, "character_id");
  const locs = byIdName(b.locations, "location_id");
  const objs = byIdName(b.objects, "object_id");
  const fixCast = (list, where) => {
    const out = [];
    for (const c of arr(list)) {
      const key = idStr(c).toLowerCase();
      if (!key) continue; // artifact already filtered by normalize, belt-and-braces
      if (chars.has(key)) {
        out.push(chars.get(key));
      } else {
        repairs.push(`${where}: dropped unknown character "${idStr(c)}" (not in the bible)`);
      }
    }
    return out;
  };
  const fixLocation = (loc, where, refs) => {
    const key = str(loc).trim().toLowerCase();
    if (!key) return "";
    if (locs.has(key)) return locs.get(key);
    if (objs.has(key)) {
      const oid = objs.get(key);
      if (!refs.includes(oid) && refs.length < 4) refs.push(oid);
      repairs.push(`${where}: "${str(loc).trim()}" is an object, not a location — moved to visible objects`);
      return "";
    }
    repairs.push(`${where}: unknown location "${str(loc).trim()}" kept as text (no bible match)`);
    return str(loc);
  };
  s.characters = fixCast(s.characters, `scene ${s.scene_number}`);
  if (!Array.isArray(s.continuity_refs)) s.continuity_refs = [];
  s.location = fixLocation(s.location, `scene ${s.scene_number}`, s.continuity_refs);
  for (const sh of arr(s.shots)) {
    if (!sh || typeof sh !== "object") continue;
    const tag = `shot ${sh.shot_id || `${s.scene_number}-?`}`;
    sh.characters = fixCast(sh.characters, tag);
    if (!Array.isArray(sh.continuity_refs)) sh.continuity_refs = [];
    sh.location = fixLocation(sh.location, tag, sh.continuity_refs);
  }
  return { scene: s, repairs };
}

// Drop exact-duplicate scenes (same normalized title + action — the "same
// scene generated twice" defect), keeping the first occurrence. Pure — the
// server applies it to each landed batch against the already-planned scenes
// and reports the count in board.warn instead of storing wasted scenes.
export function dedupeScenes(existing, incoming) {
  const keyOf = (s) => `${str(s.title).toLowerCase().replace(/\s+/g, " ").trim()}||${str(s.action).toLowerCase().replace(/\s+/g, " ").trim()}`;
  const seen = new Set(arr(existing).map(keyOf));
  const kept = [];
  let dropped = 0;
  for (const s of arr(incoming)) {
    const k = keyOf(s);
    if (k.length > 3 && seen.has(k)) {
      dropped++;
      continue;
    }
    seen.add(k);
    kept.push(s);
  }
  return { kept, dropped };
}

// Normalize a scene's shots so they tile duration_seconds EXACTLY (no gaps,
// no overlaps). When every AI timing is present and sums within tolerance,
// the lengths are trusted and only boundaries are re-derived cumulatively;
// otherwise durations are redistributed by pronounceable length via
// splitSceneTimeline. Empty/missing shots array -> [] (legacy single-image
// scenes normalize exactly as before).
export function normalizeShots(rawShots, sceneNumber, sceneTotal) {
  const list = arr(rawShots);
  if (!list.length) return [];
  const total = Number.isFinite(Number(sceneTotal)) && Number(sceneTotal) > 0 ? Number(sceneTotal) : 3;
  const shots = list.slice(0, 8).map((sh, i) => normalizeShot(sh, sceneNumber, i));
  const valid = shots.every((x) => Number.isFinite(x.duration_seconds) && x.duration_seconds > 0);
  const sum = shots.reduce((a, x) => a + (Number.isFinite(x.duration_seconds) ? x.duration_seconds : 0), 0);
  const repair = !valid || Math.abs(sum - total) > Math.max(0.15, total * 0.05);
  const timeline = repair
    ? splitSceneTimeline(shots.map((x) => x.lyric_segment || x.visual_event || x.action), total)
    : null;
  let cursor = 0;
  shots.forEach((x, i) => {
    const d = timeline
      ? timeline[i].duration_seconds
      : Math.max(0.1, Math.round(x.duration_seconds * 10) / 10);
    x.duration_seconds = d;
    x.start_time = Math.round(cursor * 10) / 10;
    cursor = Math.round((cursor + d) * 10) / 10;
    x.end_time = cursor;
  });
  // Absorb float dust into the last shot so the strip sums exactly.
  const dust = Math.round((total - cursor) * 10) / 10;
  if (shots.length && dust !== 0) {
    const last = shots[shots.length - 1];
    last.duration_seconds = Math.max(0.1, Math.round((last.duration_seconds + dust) * 10) / 10);
    last.end_time = Math.round((last.start_time + last.duration_seconds) * 10) / 10;
  }
  return shots;
}

export function normalizeScene(s, n, sceneSeconds) {
  const o = s && typeof s === "object" ? s : {};
  const cam = o.camera && typeof o.camera === "object" ? o.camera : {};
  const dur = Number(o.duration_seconds);
  // Lyric linkage: parent_line_id / lyric_line_id group the shots of one
  // lyric line (shot_id "12-A", shot_number 1..K). All optional — story
  // boards and old scenes normalize exactly as before.
  const parentLine = Number(o.parent_line_id ?? o.lyric_line_id);
  const shotNum = Math.max(1, Math.round(Number(o.shot_number) || 0) || 1);
  const t0 = Number(o.song_start_time);
  const t1 = Number(o.song_end_time);
  // Source-line coverage (line-by-line planning): which numbered story/lyric
  // lines this scene covers. Optional — old scenes normalize to null.
  const lf = Number(o.line_from);
  const lt = Number(o.line_to);
  // Timed sub-shots (multi-shot scenes). The scene total is authoritative:
  // shots always tile it exactly (see normalizeShots).
  const baseDur = Number.isFinite(dur) ? Math.min(30, Math.max(1, Math.round(dur))) : sceneSeconds;
  const shots = normalizeShots(o.shots, n, baseDur);
  const totalDur = shots.length
    ? Math.round(shots.reduce((a, x) => a + x.duration_seconds, 0) * 10) / 10
    : baseDur;
  return {
    scene_number: n,
    title: str(o.title, `Scene ${n}`),
    story_beat: str(o.story_beat),
    duration_seconds: totalDur,
    characters: arr(o.characters).map((x) => idStr(x)).filter(Boolean),
    location: str(o.location),
    time_of_day: str(o.time_of_day),
    action: str(o.action),
    emotion: str(o.emotion),
    expression: str(o.expression),
    body_language: str(o.body_language),
    camera: {
      shot_type: str(cam.shot_type, CAMERA_DEFAULT.shot_type),
      angle: str(cam.angle, CAMERA_DEFAULT.angle),
      movement: str(cam.movement, CAMERA_DEFAULT.movement),
    },
    lighting: str(o.lighting),
    environment: str(o.environment),
    continuity_from_previous_scene: str(o.continuity_from_previous_scene),
    transition_to_next_scene: str(o.transition_to_next_scene),
    dialogue: normalizeDialogue(o.dialogue),
    image_prompt: str(o.image_prompt),
    video_prompt: str(o.video_prompt),
    // Lyric-semantic shot fields (song boards; "" / defaults on story boards).
    lyric_line_id: Number.isFinite(parentLine) && parentLine > 0 ? parentLine : null,
    parent_line_id: Number.isFinite(parentLine) && parentLine > 0 ? parentLine : null,
    lyric_text: str(o.lyric_text),
    lyric_segment: str(o.lyric_segment),
    semantic_meaning: str(o.semantic_meaning || o.meaning),
    visual_event: str(o.visual_event),
    shot_id: str(o.shot_id) || null,
    shot_number: shotNum,
    song_start_time: Number.isFinite(t0) && t0 >= 0 ? Math.round(t0 * 10) / 10 : null,
    song_end_time: Number.isFinite(t1) && t1 > 0 ? Math.round(t1 * 10) / 10 : null,
    continuity_required: o.continuity_required === true,
    reference_source: normalizeReferenceSource(o.reference_source),
    continuity_refs: arr(o.continuity_refs).map((x) => idStr(x)).filter(Boolean).slice(0, 4),
    // Source-line coverage (line-by-line planning). Null on old scenes.
    line_from: Number.isFinite(lf) && lf > 0 ? Math.round(lf) : null,
    line_to: Number.isFinite(lt) && lt > 0 ? Math.round(lt) : null,
    // Timed sub-shots that tile duration_seconds exactly (see normalizeShots).
    // [] = legacy single-image scene (normalizes + approves exactly as before).
    shots,
  };
}

// Compact identity strings: the only per-call context scenes need (§26 —
// never resend the whole story or full bible per batch).
export function identityContext(blueprint) {
  const b = blueprint || {};
  const chars = arr(b.characters).map((c) =>
    `- ${c.name} (${c.character_id}): ${c.visual_identity_prompt || describeFallback(c)}`).join("\n");
  const locs = arr(b.locations).map((l) =>
    `- ${l.name} (${l.location_id}): ${l.visual_identity_prompt || l.description}`).join("\n");
  const objs = arr(b.objects).map((o) =>
    `- ${o.name} (${o.object_id}): ${o.visual_identity_prompt || o.description}`).join("\n");
  return { chars, locs, objs };
}

function describeFallback(c) {
  const app = Object.entries(c.appearance || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
  const clo = Object.entries(c.clothing || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
  return [c.species, app, clo].filter(Boolean).join("; ");
}

// Per-character consistency rules context: the popup-editable rules that
// travel with the scene-batch + regen prompts so user edits actually steer
// the AI. Falls back to the pre-defined defaults for old boards.
export function consistencyRulesContext(blueprint) {
  return arr(blueprint && blueprint.characters)
    .map((c) => {
      const rules = characterConsistencyRules(c).filter(Boolean);
      if (!rules.length) return null;
      return `${c.name} (${c.character_id}):\n${rules.map((r) => `- ${r}`).join("\n")}`;
    })
    .filter(Boolean)
    .join("\n");
}

// Bible-call user message (analysis + bibles + beats, compact by design).
// Song mode: when input.song is present ({ durationSeconds, fileName }),
// the "story" is song lyrics — the prompt asks for a music-video reading
// (verse/chorus structure -> visual arcs, lip-sync-free staging since no
// dialogue audio is generated, scenes paced to the exact song length).
export function buildBiblePrompt(input) {
  const song = input.song && typeof input.song === "object" ? input.song : null;
  const songHeader = song ? [
    `SOURCE: SONG (music video — the final cut will play over the uploaded song audio)`,
    `SONG FILE: ${song.fileName || "(uploaded audio)"} · DURATION: ~${Math.round(Number(song.durationSeconds) || input.targetSeconds)} seconds`,
    song.hasLyrics === false
      ? `LYRICS: not provided — infer mood/structure from the title and invent a matching visual story (chorus = recurring visual motif, verses = story progression).`
      : null,
  ] : [];
  const lines = [
    `STORY TITLE: ${input.title}`,
    `LANGUAGE: ${input.language}`,
    `GENRE: ${input.genre}${input.genreCustom ? ` (${input.genreCustom})` : ""}`,
    `VISUAL STYLE: ${input.visualStyle}${input.visualStyle === "Custom" ? ` (${input.styleCustom})` : ""}`,
    `TARGET DURATION: ~${input.targetSeconds} seconds`,
    ...songHeader,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    ``,
    `STORY:`,
    input.story,
    ``,
    `TASK 1/2 — STORY BLUEPRINT. Analyze this story like a film director and return JSON:`,
    ...(song && song.hasLyrics !== false && parseLyricLines(input.story).length
      ? [`LYRIC MODE: the STORY above is song lyrics. Add a "lyric_lines" array with one entry per lyric line:`,
        `{ "lyric_lines": [{ "lyric_line_id": 1, "lyric_text": "the exact line", "semantic_analysis": "subject, characters, actions, objects, location, emotion, cause/effect, symbolism — every meaningful word/phrase decoded, never a generic summary", "visual_complexity": "low|medium|high", "planned_shots": 1-5 }], ... }`,
        `Rule: 1 shot for a simple line, 2 for a moderately complex line, 3-5 for a line with several distinct actions/events (e.g. a line with mission-giving AND travel AND burning = multiple shots). Never one shot per word. Beats below must follow the lyric order so every line gets visual coverage.`]
      : []),
    `{ "logline": "...", "analysis": { "plot": "...", "beginning": "...", "middle": "...", "climax": "...", "ending": "...", "main_character": "...", "supporting_characters": ["..."], "antagonist": "... or null", "objects": ["..."], "locations": ["..."], "events": ["..."], "relationships": "...", "emotional_progression": "...", "timeline": "...", "visual_moments": ["..."] },`,
    `  "characters": [{ "character_id": "snake_case", "name": "...", "role": "main_character|supporting|antagonist", "species": "...", "age": "...", "appearance": { "body": "...", "fur": "...", "eyes": "...", "ears": "..." }, "clothing": { "top": "...", "bottom": "..." }, "personality": ["..."], "visual_identity_prompt": "STATIC portrait only: species + body + face + eyes + colors + clothing, comma-separated, no action, no pose, no scene, no emotion — written so it can be pasted into every image_prompt verbatim" }],`,
    `  "locations": [{ "location_id": "snake_case", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt", "time_of_day": "...", "lighting": "...", "color_palette": "..." }],`,
    `  "objects": [{ "object_id": "snake_case", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt" }],`,
    `  "beats": [{ "n": 1, "title": "...", "summary": "one line", "location": "<location_id where this beat happens>", "objects": ["<object_ids visible in this beat>"] }] }`,
    `Cover every important story event with beats (characters, not paragraphs, decide). Every beat names its location_id and visible object_ids so later scene batches stage each beat in the right place with the right props — spread beats across ALL locations/objects above, never park every beat in one place. Write every visual_identity_prompt so it can be pasted into an image prompt verbatim. Respond with JSON ONLY.`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// Scene-batch user message. Beats slice + identity strings + the previous
// scene (continuity anchor) keep each call small and chronologically locked.
// Only the beats proportional to THIS scene range are sent — earlier batches
// sent the whole beat list every time, so late batches re-planned the opening
// and copied scene-1 dialogue across dozens of scenes.
export function buildScenesPrompt({ input, blueprint, beats, prevScene, startNumber, count, styleLock, totalScenes = null, priorDialogue = [], lyricLines = [], lyricTiming = [], lineRange = [], budgetSeconds = null, plannedSeconds = 0, targetSeconds = null, totalLines = null }) {
  const { chars, locs, objs } = identityContext(blueprint);
  const all = arr(beats);
  const total = Math.max(1, Number(totalScenes) || (Number(startNumber) || 1) + (Number(count) || 1) - 1);
  const ranged = beatsForSceneRange(all, startNumber, count, total);
  const covering = ranged.length ? ranged : all;
  const beatLines = covering.map((b) => {
    const place = str(b.location);
    const props = arr(b.objects).map((x) => str(x)).filter(Boolean).join(", ");
    const where = place || props ? ` [${place ? `📍 ${place}` : ""}${place && props ? " | " : ""}${props ? `🧺 ${props}` : ""}]` : "";
    return `Beat ${b.n}: ${b.title} — ${b.summary}${where}`;
  }).join("\n") || "(no beats — continue the story chronologically)";
  // Voice hints derived from THIS story's bible — never a hardcoded example
  // cast (a past "Rabbit Chiku / Lion Shera" example leaked those names and
  // voices into unrelated stories).
  const cast = arr(blueprint && blueprint.characters).map((c) => {
    const traits = [...arr(c.personality), str(c.role)].filter(Boolean).join(", ");
    return `${c.name} (${c.character_id})${traits ? ` — ${traits}` : ""}`;
  }).join("; ");
  // Valid id lists: the ONLY legal values for scene/shot characters/location
  // slots (exact ids — free text, display names and translations silently
  // break grounding downstream, so they are forbidden, not tolerated).
  const validCharIds = arr(blueprint && blueprint.characters).map((c) => str(c.character_id)).filter(Boolean);
  const validLocIds = arr(blueprint && blueprint.locations).map((l) => str(l.location_id)).filter(Boolean);
  const validObjIds = arr(blueprint && blueprint.objects).map((o) => str(o.object_id)).filter(Boolean);
  const validIdsLine = (label, ids) => `${label}: ${ids.length ? ids.join(", ") : "(none)"}`;
  // Dialogue opt-out: input.includeDialogue === false means a silent film —
  // the model must emit "dialogue": [] on every scene (no voice, no lip-sync,
  // clips stay at their planned length). Default (true/undefined) = voiced.
  const wantDialogue = input.includeDialogue !== false;
  // Connected movie: input.chainContinuity === true means every scene visually
  // continues the previous shot's end state (same characters/location, matched
  // framing) via TEXT continuity carried in the prompts. Generation pixels
  // always stay per-scene (every keyframe anchors on the reference, every
  // clip animates its own keyframe) — chainContinuity never chains pixels.
  // When false/undefined, every scene is an independent fresh shot.
  const wantChain = input.chainContinuity === true;
  const used = arr(priorDialogue).map((x) => str(typeof x === "string" ? x : x.line)).filter(Boolean).slice(-40);
  const rulesCtx = consistencyRulesContext(blueprint);
  // Lyric-semantic mode: only for song boards with real lyric lines. Gives
  // the model the timed line list so shots map to lyric segments and their
  // durations sum to the song timeline.
  const timed = arr(lyricTiming).length ? arr(lyricTiming) : arr(lyricLines);
  // Lyric mode ONLY for song boards with real lyric lines — story boards
  // keep the lean pre-lyric prompt so batches stay small enough to parse.
  const lyricMode = timed.length > 0 && input.song && typeof input.song === "object" && input.song.hasLyrics !== false;
  // Line-by-line source slice for THIS batch (numbered story/lyric lines with
  // estimated song windows). The server slices the full line list to the
  // batch's time window; when absent we fall back to the full timed list
  // (songs) or nothing (stories) so old callers keep working.
  const lineSlice = arr(lineRange).length ? arr(lineRange) : timed;
  const lineNoOf = (l, i) => Number(l.lyric_line_id) || Number(l.line_id) || i + 1;
  const lineTextOf = (l) => str(l.lyric_text ?? l.text ?? l.line);
  const lineWinOf = (l) => (l.song_start_time != null && l.song_end_time != null
    ? ` [${l.song_start_time}s–${l.song_end_time}s]` : "");
  // Time budget for this batch (seconds of story it must cover). Falls back
  // to count × sceneSeconds so old callers without pacing info keep working.
  const perScene = Math.max(1, Number(input.sceneSeconds) || 3);
  const budget = Number.isFinite(Number(budgetSeconds)) && Number(budgetSeconds) > 0
    ? Math.round(Number(budgetSeconds) * 10) / 10
    : Math.round(count * perScene * 10) / 10;
  const planned = Math.max(0, Math.round(Number(plannedSeconds) * 10) / 10 || 0);
  const target = Number.isFinite(Number(targetSeconds)) && Number(targetSeconds) > 0
    ? Math.round(Number(targetSeconds)) : null;
  // Hard batch scope: which lines this batch owns out of how many total.
  // Stated explicitly because models otherwise plan past their window and
  // declare the story complete mid-way (complete=true is verified
  // server-side by coverage + timeline — see verifyPlanComplete).
  const totalN = Number.isFinite(Number(totalLines)) && Number(totalLines) > 0 ? Math.round(Number(totalLines)) : null;
  const firstN = lineSlice.length ? lineNoOf(lineSlice[0], 0) : null;
  const lastN = lineSlice.length ? lineNoOf(lineSlice[lineSlice.length - 1], lineSlice.length - 1) : null;
  const scopeLine = lineSlice.length && firstN != null && lastN != null
    ? (totalN != null
      ? `SCOPE: lines ${firstN}–${lastN} of ${totalN} total. Cover ONLY these lines — NEVER plan beyond line ${lastN}. Set "complete": true ONLY if line ${totalN} (the LAST line) is covered AND the story truly ends here; otherwise "complete": false.`
      : `SCOPE: lines ${firstN}–${lastN}. Cover ONLY these lines — NEVER plan beyond line ${lastN}. Set "complete": false (the story continues after this batch).`)
    : null;
  // Slim per-shot lyric keys: the server derives parent_line_id (=
  // lyric_line_id) and joins lyric_text from the timed line list, and the
  // action field already carries the visible event — so the model emits no
  // redundant echoes. Every dropped echo saves ~25-50 tokens × scenes.
  const lyricBlock = lyricMode
    ? [
      `LYRIC-SEMANTIC SHOT SPLITTING (this board is a SONG — obey strictly):`,
      `- One lyric line may become 1 shot (simple) or up to 5 shots (several distinct actions/events). Decide from meaning, never 1 line = 1 scene by default, never 1 shot per word.`,
      `- For each shot output ONLY these lyric keys (nothing else): "lyric_line_id" (number), "lyric_segment" (the exact words this shot visualizes), "semantic_meaning" (what the segment really means), "shot_id" ("<line>-<letter>", e.g. "12-A"), "shot_number" (1..K within the line), "song_start_time" + "song_end_time" (seconds within the song; sibling shots split their line's window).`,
      wantChain
        ? `- Continuity decision per shot: "continuity_required" true/false + "reference_source" (one of: NONE, CHARACTER_REFERENCE, LOCATION_REFERENCE, PREVIOUS_IMAGE, PREVIOUS_VIDEO_LAST_FRAME, MULTIPLE_REFERENCES). Use the previous shot's end state when the same character/location/action continues (standing -> leap -> flight); use NONE for fresh establishing shots. Vary shot types (Establishing, Wide, Medium, Close-Up, Extreme Close-Up, Tracking, Aerial, Reveal) — never the same angle for every shot.`
        : `- Continuity decision per shot (Connected OFF — independent shots): ALWAYS "continuity_required": false + "reference_source": "NONE". Never reference the previous shot's end state. Vary shot types (Establishing, Wide, Medium, Close-Up, Extreme Close-Up, Tracking, Aerial, Reveal) — never the same angle for every shot.`,
      `- IMAGE prompt = full composition (identities + action + camera + lighting + emotion + style). VIDEO prompt = MOTION ONLY (starting position, movement, camera move, ending position) — complementary, never a copy. Devotional lines get respectful Indian-mythological symbolism (divine power protecting devotees, never flat literal/modern imagery).`,
      `TIMED LYRIC LINES (analyze line by line, in order — every scene states line_from/line_to covering these, skipping none):`,
      ...(scopeLine ? [scopeLine] : []),
      ...lineSlice.map((l, i) => {
        const cx = l.visual_complexity ? ` (${l.visual_complexity}, ~${l.planned_shots ?? 1} shots)` : "";
        return `Line ${lineNoOf(l, i)}${lineWinOf(l)}${cx}: ${lineTextOf(l)}`;
      }),
    ]
    : [];
  // Story boards: the same numbered line list (no song windows) so the AI
  // analyzes the story line by line instead of re-planning from thin beats.
  const storyBlock = !lyricMode && ranged.length
    ? [
      `STORY LINES FOR THIS BATCH (analyze line by line, in order — every scene states line_from/line_to covering these, skipping none):`,
      ...(scopeLine ? [scopeLine] : []),
      ...lineSlice.map((l, i) => `Line ${lineNoOf(l, i)}: ${lineTextOf(l)}`),
    ]
    : [];
  // The lyric tail joins the scene schema in lyric mode only — story boards
  // get the exact historical schema so their batches stay parseable.
  const lyricTail = lyricMode
    ? `, "lyric_line_id": 0, "lyric_segment": "exact words visualized", "semantic_meaning": "...", "shot_id": "12-A", "shot_number": 1, "song_start_time": 0, "song_end_time": 0, "continuity_required": false, "reference_source": ${wantChain ? `"NONE|CHARACTER_REFERENCE|LOCATION_REFERENCE|PREVIOUS_IMAGE|PREVIOUS_VIDEO_LAST_FRAME|MULTIPLE_REFERENCES"` : `"NONE"`}`
    : ``;
  // Multi-shot scenes (songs AND stories): one scene holds timed shots that
  // tile its duration. The schema tail is identical for every board — story
  // sentences split on clauses/entities exactly like lyric lines split on
  // segments.
  const shotTail = `, "shots": [ { "shot_id": "${startNumber}-A", "shot_number": 1, "lyric_segment": "exact words/clause this shot visualizes", "semantic_meaning": "what the segment really means", "characters": ["<character_id from CAST — exact id only>"], "location": "<location_id from LOCATIONS — exact id only>", "action": "ONE visible action on screen", "emotion": "...", "expression": "...", "body_language": "...", "camera": { "shot_type": "...", "angle": "...", "movement": "..." }, "lighting": "...", "environment": "...", "dialogue": [{ "speaker": "character_id", "line": "...", "expression": "...", "emotion": "...", "pitch": "low|medium|high" }], "image_prompt": "self-contained image prompt for THIS shot only", "video_prompt": "MOTION ONLY for this shot", "duration_seconds": 1.4 } ]`;
  // Location/object rotation + anti-repeat: the observed failure mode is 90%
  // of scenes parked in one location with free-text places while bible
  // objects never appear, plus verbatim repeat scenes within a batch.
  const rotationBlock = [
    `LOCATION & OBJECT ROTATION (mandatory — every bible entry must be seen on screen):`,
    `- "location" takes ONLY an id from VALID LOCATIONS below (exact spelling — never a display name, translation, description or invented place). "characters" takes ONLY ids from VALID CHARACTERS. Inventing a character, place or name not in these lists is FORBIDDEN — stage the lines with the listed cast instead.`,
    `- Set each scene's location from THESE lines/beats (where the action happens), using EVERY listed location across the batch — never park the whole batch in one place. Repeat the previous scene's location ONLY when the current lines explicitly stay in the same place.`,
    `- Feature EVERY listed object visibly in at least one scene/shot of the plan (as the focus of its shot, staged with its verbatim identity); a scene lists only objects actually visible in frame. An object id NEVER goes in a "location" slot.`,
    `- ANTI-REPEAT: no two scenes in this batch may share the same (location + action) — every scene is a NEW moment that advances line_from/line_to forward past the previous scene. Vary camera shot_type across consecutive scenes instead of repeating one setup.`,
    validIdsLine(`VALID CHARACTERS`, validCharIds),
    validIdsLine(`VALID LOCATIONS`, validLocIds),
    validIdsLine(`VALID OBJECTS`, validObjIds),
  ];
  const shotBlock = [
    `MULTI-SHOT SCENES (mandatory — songs and stories alike):`,
    `- When ONE line/sentence covers 2+ distinct persons, objects or locations, NEVER cram them into one image. Split the scene into 2-5 SHOTS inside the SAME scene ("shots" array) — one shot per entity or moment, each with its own segment, cast, location, camera, prompts and dialogue.`,
    `- Size every shot by PRONOUNCEABLE LENGTH: words in its segment + spoken lines at ~2.5 words/sec (Devanagari ~2.2 words/sec), +0.35s pause between dialogue lines. Shot durations MUST sum EXACTLY to the scene's duration_seconds, with cumulative boundaries from 0 (shot 1: 0-1.4s, shot 2: 1.4-2.5s, shot 3: 2.5-3s for a 3s scene).`,
    `- shot_id "<scene>-<letter>" (e.g. "${startNumber}-A", "${startNumber}-B"). Each shot's image_prompt carries ONLY that shot's entity (verbatim identity paste + global style); video_prompt is MOTION ONLY for that shot. Single-entity scenes use exactly 1 shot covering 0 to the full scene duration.`,
  ];
  // Dynamic planning brief: the AI decides scene count, boundaries and
  // durations within this batch's time budget (target-driven, never padded
  // to a fixed count). sceneSeconds survives only as a scale hint.
  const budgetLine = target != null
    ? `TIME BUDGET: this batch covers ~${budget}s of story (${planned}s of ~${target}s planned so far). YOU decide how many scenes (1..${count}), where each starts/ends, each scene's own duration_seconds from content weight, and its shots — the batch's scene durations MUST sum to ~${budget}s.`
    : `TIME BUDGET: this batch covers ~${budget}s of story. YOU decide how many scenes (1..${count}), where each starts/ends, each scene's own duration_seconds from content weight, and its shots — the batch's scene durations MUST sum to ~${budget}s.`;
  return [
    `TASK 2/2 — SCENE PLAN (batch from scene ${startNumber}, UP TO ${count} scenes — YOU decide the count). Analyze the source lines below LINE BY LINE, in order; continue the story forward, never restart it.`,
    `STORY TITLE: ${input.title} | GENRE: ${input.genre} | STYLE: ${input.visualStyle}`,
    budgetLine,
    `TYPICAL SCENE: ~${perScene}s (scale hint ONLY — DO NOT copy example durations; every duration_seconds comes from pronounceable length + action weight).`,
    wantDialogue
      ? `DIALOGUE (voice + lip-sync): each scene carries 0-2 short speakable lines in ${input.language} as "dialogue": [{ "speaker": "<character_id>", "line": "...", "expression": "facial expression while speaking", "emotion": "delivery feeling", "pitch": "low|medium|high" }]. ` +
        `The speaker MUST be a character who is on screen in that scene${cast ? ` (cast: ${cast})` : ""}; keep each voice in character. ` +
        `Fill "expression" from the STORY whenever the story gives one (crying, smiling, shouting, whispering, scared trembling...) — otherwise infer it from the line's feeling; "emotion" is the delivery (joyful, sad, angry, scared, excited, calm) and "pitch" follows it (high = excited/happy/young, low = angry/sad/older, medium = calm/neutral). ` +
        `Long lines get longer clips automatically (the system measures the voice audio and grows the clip, so never shorten a story line to fit — write what the story needs), but keep each line under ~25 words so one scene stays one moment. ` +
        `CRITICAL: every scene's dialogue must be NEW story-advancing speech — NEVER copy or paraphrase a line from an earlier scene, and NEVER repeat the same line in two scenes. ` +
        `Action-only scenes (chases, reactions, montages) should use empty dialogue [] instead of filler speech. ` +
        `When a character speaks, stage them FRONT-FACING and clearly visible (Close-Up or Medium Close-Up, Eye Level, Static) — ` +
        `the lip-sync pass needs the speaker's face in frame for every frame.`
      : `DIALOGUE DISABLED (silent film — user opted out): emit "dialogue": [] on EVERY scene, no exceptions. No spoken lines, no speaker, no voice — the video plays silent over visuals/music only. Stage scenes for pure visual storytelling.`,
    wantDialogue && used.length ? `LINES ALREADY USED (do not repeat any of these verbatim or in paraphrase):\n${used.map((l) => `- ${l}`).join("\n")}` : null,
    wantChain
      ? `CONNECTED SCENES (visual continuity — mandatory): every scene STARTS from the previous scene's end state — same character(s) in the same clothing, matched framing. Describe continuity_from_previous_scene concretely (e.g. "same forest clearing, Minku mid-run from the last frame, camera holds the Medium Shot") and transition_to_next_scene as the handoff. Keep time_of_day/lighting identical across consecutive scenes unless the story explicitly changes time. LOCATION FOLLOWS THE STORY, not the previous scene: change location (with a fresh establishing framing for the jump) whenever the current lines/beats move somewhere new — never drag the previous location into a scene whose lines happen elsewhere. Only scenes whose lines explicitly stay put may reuse the previous location.`
      : `INDEPENDENT SCENES (user turned Connected OFF — mandatory): every scene is a FRESH independent shot — new framing chosen for THIS scene's own action, never a continuation of the previous shot. Set "continuity_from_previous_scene": "" and "transition_to_next_scene": "" on EVERY scene, always. Never write "continuing from previous shot", "same framing as the previous shot" or any handoff language anywhere. Vary shot types and angles across scenes instead of holding one setup.`,
    input.song && typeof input.song === "object"
      ? `MUSIC-VIDEO PACING: scenes must total ~${Math.round(Number(input.song.durationSeconds) || input.targetSeconds)}s to match the song; favor performance/movement shots that cut on the beat, no lip-sync close-ups held longer than one scene.`
      : null,
    ...lyricBlock,
    ...storyBlock,
    ...shotBlock,
    ...rotationBlock,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    ``,
    `CHARACTER CONSISTENCY (TEXT LOCK — mandatory): for every character listed in a scene's "characters", paste that character's exact visual_identity_prompt into "image_prompt" VERBATIM (copy-paste, word for word). Never paraphrase, shorten, or restyle it. Never change face, body, species, clothing or colors. Action/pose/camera go AROUND the pasted identity, never inside it.`,
    chars || "(none)",
    rulesCtx ? `\nPER-CHARACTER CONSISTENCY RULES (obey for the named character):\n${rulesCtx}` : null,
    ``,
    `LOCATIONS (paste the exact visual_identity_prompt for the scene location the same way):`,
    locs || "(none)",
    ``,
    `OBJECTS (paste the exact visual_identity_prompt for every object visible in the scene the same way):`,
    objs || "(none)",
    ``,
    `GLOBAL STYLE (append to every image_prompt verbatim): ${styleLock}`,
    ``,
    `STORY BEATS TO COVER IN THIS BATCH (only these — in order):`,
    beatLines,
    prevScene && wantChain ? `\nPREVIOUS SCENE (end state — continue from it, do not repeat it):\n${JSON.stringify(prevScene)}` : ``,
    ``,
    `Return JSON: { "scenes": [ { "scene_number": ${startNumber}, "title": "...", "story_beat": "Beat N: ...", "line_from": 1, "line_to": 2, "duration_seconds": ${input.sceneSeconds}, "characters": ["<character_id from VALID CHARACTERS — exact id only>"], "location": "<location_id from VALID LOCATIONS — exact id only>", "time_of_day": "...", "action": "visible physical behavior, not feelings", "emotion": "...", "expression": "...", "body_language": "...", "camera": { "shot_type": "one of: Extreme Wide Shot, Wide Shot, Establishing Shot, Medium Shot, Medium Close-Up, Close-Up, Extreme Close-Up, Over-the-Shoulder, Two Shot", "angle": "one of: Low Angle, High Angle, Eye Level, Top Down", "movement": "one of: Static, Pan, Tilt, Dolly In, Dolly Out, Tracking Shot, Orbit, Crane" }, "lighting": "...", "environment": "...", ${wantChain ? `"continuity_from_previous_scene": "...", "transition_to_next_scene": "...",` : `"continuity_from_previous_scene": "", "transition_to_next_scene": "",`} ${wantDialogue ? `"dialogue": [{ "speaker": "character_id", "line": "speakable line in ${input.language}", "expression": "face while speaking", "emotion": "delivery feeling", "pitch": "low|medium|high" }]` : `"dialogue": []`}, "image_prompt": "self-contained CONTEXT image prompt: verbatim character/location/object identities + action + expression/body_language${wantChain ? " + continuity_from_previous_scene (same framing as the previous shot's end state)" : " (fresh independent framing — never continue the previous shot)"} + ${styleLock} + ultra-detailed 8k uhd, highly clear, sharp focus, no distortion, no deformed faces, no extra/missing limbs, no blurry, no low quality, no watermark", "video_prompt": "MOTION ONLY for THIS scene's own keyframe: what moves and how (limbs, face, cloth, water, camera) + highly clear 8k uhd quality, smooth natural motion, no distortion, no morphing, no flicker — never describe looks, face, clothing, colors or style; the video model must animate the input image's character exactly, never redesign it"${lyricTail}${shotTail} } ], "complete": false } — complete=true ONLY when the LAST source line is covered and the story ends.`,
    `Plan UP TO ${count} scenes numbered from ${startNumber} (fewer is fine — cover the batch lines with YOUR scene boundaries/durations, nothing more). Every scene states line_from/line_to, its own duration_seconds, and "shots" tiling it exactly (single-entity scenes: 1 shot, 0 to full duration). Keep camera movement simple unless the story needs it. Every image_prompt MUST carry the verbatim identities + the global style. Respond with JSON ONLY.`,
  ].filter((l) => l !== null).join("\n");
}

// Add-one-bible-entry message (Add Character / Add Location / Add Object).
// The model re-reads the master input (title + story/lyrics + genre/style +
// instructions + song) plus the ALREADY generated bible, then invents exactly
// ONE new entry that the story still needs and appends it server-side —
// nothing existing is rewritten. `hint` is an optional user nudge
// ("a wise old turtle", "night market", ...) that the model must honor.
export function buildAddEntryPrompt({ input, blueprint, kind, hint }) {
  const k = String(kind || "").toLowerCase();
  const label = k === "location" ? "LOCATION" : k === "object" ? "OBJECT" : "CHARACTER";
  const b = blueprint && typeof blueprint === "object" ? blueprint : {};
  const existing = arr(
    k === "location" ? b.locations : k === "object" ? b.objects : b.characters,
  ).map((x) => `- ${x.name || x.character_id || x.location_id || x.object_id}`).join("\n") || "(none yet)";
  const song = input && typeof input.song === "object" ? input.song : null;
  const shape =
    k === "location"
      ? `{ "location": { "location_id": "snake_case", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt", "time_of_day": "...", "lighting": "...", "color_palette": "..." } }`
      : k === "object"
        ? `{ "object": { "object_id": "snake_case", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt" } }`
        : `{ "character": { "character_id": "snake_case", "name": "...", "role": "main_character|supporting|antagonist", "species": "...", "age": "...", "appearance": { "body": "...", "fur": "...", "eyes": "...", "ears": "..." }, "clothing": { "top": "...", "bottom": "..." }, "personality": ["..."], "visual_identity_prompt": "STATIC portrait only: species + body + face + eyes + colors + clothing, comma-separated, no action, no pose, no scene, no emotion — written so it can be pasted into every image_prompt verbatim" } }`;
  return [
    `ADD ONE ${label} to this storyboard's bible. Read the full story/lyrics + master settings below and the already-generated bible — invent exactly ONE new ${k} the story still needs (a mentioned-but-missing cast member, an unlisted place the action needs, or a key prop). Never duplicate or rename an existing entry; the new name/ids must be unique.`,
    `STORY TITLE: ${input.title} | LANGUAGE: ${input.language} | GENRE: ${input.genre}${input.genreCustom ? ` (${input.genreCustom})` : ""} | VISUAL STYLE: ${input.visualStyle}${input.visualStyle === "Custom" ? ` (${input.styleCustom})` : ""}`,
    song ? `SOURCE: SONG "${song.fileName || ""}" (~${Math.round(Number(song.durationSeconds) || input.targetSeconds)}s)${song.hasLyrics === false ? " — no lyrics, infer from the title" : ""}` : null,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    hint ? `USER REQUEST: ${String(hint).slice(0, 300)} — honor this when inventing the new ${k}.` : null,
    ``,
    `STORY/LYRICS:`,
    input.story,
    ``,
    `EXISTING ${label}S (do not repeat any of these):`,
    existing,
    `EXISTING CAST: ${arr(b.characters).map((c) => c.name).filter(Boolean).join(", ") || "(none)"}`,
    `EXISTING LOCATIONS: ${arr(b.locations).map((l) => l.name).filter(Boolean).join(", ") || "(none)"}`,
    `EXISTING OBJECTS: ${arr(b.objects).map((o) => o.name).filter(Boolean).join(", ") || "(none)"}`,
    ``,
    `Write the visual_identity_prompt so it can be pasted into an image prompt verbatim (same ${input.visualStyle} style as the bible). Return JSON ONLY in exactly this shape: ${shape}`,
  ].filter((l) => l !== null).join("\n");
}

// Beats-refresh message (runs right after Add Character / Location /
// Object). The model re-reads the story/lyrics + the UPDATED bible
// (including the just-added entry) and returns the FULL corrected beats
// list — existing beats stay stable (same order/titles where still
// accurate), with new or updated beats only where the new entry
// participates in the story. Keeps scene-batch context
// (beatsForSceneRange) truthful after bible appends: without this, beats
// never mention the added location/object and later batches plan scenes
// that ignore it.
export function buildBeatsRefreshPrompt({ input, blueprint, kind, newEntry }) {
  const k = String(kind || "").toLowerCase();
  const label = k === "location" ? "LOCATION" : k === "object" ? "OBJECT" : "CHARACTER";
  const b = blueprint && typeof blueprint === "object" ? blueprint : {};
  const song = input && typeof input.song === "object" ? input.song : null;
  const beats = arr(b.beats);
  return [
    `REFRESH THE STORY BEATS for this storyboard's bible. A new ${label} was just added — return the FULL updated beats list as JSON: { "beats": [{ "n": 1, "title": "...", "summary": "one line", "location": "<location_id where this beat happens>", "objects": ["<object_ids visible in this beat>"] }] }.`,
    `RULES: keep every existing beat (same n, order and title) unless the new ${k} genuinely changes it; add a new beat or extend a summary ONLY where the new ${k} appears, acts, or matters to the story. Every beat names its location_id and visible object_ids (keep existing ones where still accurate). Renumber n sequentially from 1. Cover every important story event (characters, not paragraphs, decide) — never drop a beat that does not involve the new ${k}. One-line summaries, no prose outside the JSON.`,
    `STORY TITLE: ${input.title} | LANGUAGE: ${input.language} | GENRE: ${input.genre}${input.genreCustom ? ` (${input.genreCustom})` : ""}`,
    song ? `SOURCE: SONG "${song.fileName || ""}" (~${Math.round(Number(song.durationSeconds) || input.targetSeconds)}s)${song.hasLyrics === false ? " — no lyrics, infer from the title" : ""}` : null,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    ``,
    `STORY/LYRICS:`,
    input.story,
    ``,
    `NEW ${label} (fold its role into the beats):`,
    JSON.stringify(newEntry),
    ``,
    `FULL BIBLE — CAST: ${arr(b.characters).map((c) => c.name).filter(Boolean).join(", ") || "(none)"} | LOCATIONS: ${arr(b.locations).map((l) => l.name).filter(Boolean).join(", ") || "(none)"} | OBJECTS: ${arr(b.objects).map((o) => o.name).filter(Boolean).join(", ") || "(none)"}`,
    ``,
    `EXISTING BEATS (keep stable unless the new ${k} changes them):`,
    beats.length ? JSON.stringify(beats) : "(none yet — create the full list)",
    ``,
    `Return JSON ONLY: { "beats": [{ "n": 1, "title": "...", "summary": "...", "location": "<location_id>", "objects": ["<object_id>"] }] }`,
  ].filter((l) => l !== null).join("\n");
}

// Rewrite-one-bible-entry message (per-card regenerate icon). The model
// re-reads the master input (title + story/lyrics + genre/style +
// instructions + song) plus the full bible, then rewrites ONLY the selected
// entry — richer, more story-true description + identity prompt. The id
// (character_id / location_id / object_id) MUST be kept verbatim so scene
// references never break; only the descriptive fields are refreshed.
export function buildRegenEntryPrompt({ input, blueprint, kind, entry }) {
  const k = String(kind || "").toLowerCase();
  const label = k === "location" ? "LOCATION" : k === "object" ? "OBJECT" : "CHARACTER";
  const b = blueprint && typeof blueprint === "object" ? blueprint : {};
  const song = input && typeof input.song === "object" ? input.song : null;
  const idKey = k === "location" ? "location_id" : k === "object" ? "object_id" : "character_id";
  const idVal = entry && typeof entry === "object" ? entry[idKey] : "";
  const shape =
    k === "location"
      ? `{ "location": { "location_id": "${idVal}", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt", "time_of_day": "...", "lighting": "...", "color_palette": "..." } }`
      : k === "object"
        ? `{ "object": { "object_id": "${idVal}", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt" } }`
        : `{ "character": { "character_id": "${idVal}", "name": "...", "role": "main_character|supporting|antagonist", "species": "...", "age": "...", "appearance": { "body": "...", "fur": "...", "eyes": "...", "ears": "..." }, "clothing": { "top": "...", "bottom": "..." }, "personality": ["..."], "visual_identity_prompt": "STATIC portrait only: species + body + face + eyes + colors + clothing, comma-separated, no action, no pose, no scene, no emotion — written so it can be pasted into every image_prompt verbatim" } }`;
  return [
    `REGENERATE ONE ${label} in this storyboard's bible. Read the full story/lyrics + master settings + bible below, then rewrite ONLY the selected ${k} — keep its role in the story but make the description and visual_identity_prompt richer, more specific and more story-true (same ${input.visualStyle} style).`,
    `CRITICAL: keep "${idKey}": "${idVal}" EXACTLY (scene references use it — never rename the id). Keep the name unless the story demands otherwise.`,
    `STORY TITLE: ${input.title} | LANGUAGE: ${input.language} | GENRE: ${input.genre}${input.genreCustom ? ` (${input.genreCustom})` : ""} | VISUAL STYLE: ${input.visualStyle}${input.visualStyle === "Custom" ? ` (${input.styleCustom})` : ""}`,
    song ? `SOURCE: SONG "${song.fileName || ""}" (~${Math.round(Number(song.durationSeconds) || input.targetSeconds)}s)${song.hasLyrics === false ? " — no lyrics, infer from the title" : ""}` : null,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    ``,
    `STORY/LYRICS:`,
    input.story,
    ``,
    `FULL BIBLE CONTEXT — CAST: ${arr(b.characters).map((c) => c.name).filter(Boolean).join(", ") || "(none)"} | LOCATIONS: ${arr(b.locations).map((l) => l.name).filter(Boolean).join(", ") || "(none)"} | OBJECTS: ${arr(b.objects).map((o) => o.name).filter(Boolean).join(", ") || "(none)"}`,
    ``,
    `SELECTED ${label} (rewrite this):`,
    JSON.stringify(entry),
    ``,
    `Write the visual_identity_prompt so it can be pasted into an image prompt verbatim. Return JSON ONLY in exactly this shape: ${shape}`,
  ].filter((l) => l !== null).join("\n");
}

// Single-scene regeneration message (target beat + neighbors for continuity).
export function buildRegenPrompt({ input, blueprint, scene, prevScene, nextScene, styleLock }) {
  const { chars, locs, objs } = identityContext(blueprint);
  const rulesCtx = consistencyRulesContext(blueprint);
  return [
    `REGENERATE ONE SCENE (scene ${scene.scene_number}, "${scene.title}"). Keep its place in the story; invent a fresh staging for the same beat.`,
    `Regenerate ONLY this scene — keep its lyric linkage (lyric_line_id, lyric_segment, shot_id, parent_line_id, song timing) and its place between the neighbors; never renumber sibling scenes. Keep the scene's "shots" array (shot_ids, per-shot timings); when re-staging into several shots, their durations MUST tile the scene's duration_seconds exactly with cumulative boundaries from 0.${input.chainContinuity === true ? " If the new ending composition changes, update continuity_refs/continuity_from_previous_scene thinking so the next shot still flows." : " Write no continuity_refs/continuity_from_previous_scene handoff thinking — this board stages independent shots."}`,
    `CHARACTER CONSISTENCY (TEXT LOCK — mandatory): paste the exact visual_identity_prompt verbatim for every character/location/object in the scene — copy-paste, never paraphrase or restyle.`,
    input.includeDialogue === false
      ? `DIALOGUE DISABLED on this board (silent film): keep "dialogue": [] — do not invent spoken lines.`
      : null,
    input.chainContinuity === true
      ? `CONNECTED SCENES on this board: the new staging must START from the previous scene's end state (same clothing/location/lighting/framing) and hand off cleanly to the next scene.`
      : `INDEPENDENT SCENES on this board (Connected OFF): stage this scene as a FRESH independent shot — never continue the previous scene's framing or hand off to the next. Set "continuity_from_previous_scene": "" and "transition_to_next_scene": "" and write no handoff language anywhere.`,
    `STYLE: ${input.visualStyle} — GLOBAL STYLE (append to image_prompt verbatim): ${styleLock}`,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    ``,
    `CHARACTER IDENTITIES (verbatim paste into image_prompt):\n${chars || "(none)"}`,
    rulesCtx ? `PER-CHARACTER CONSISTENCY RULES (obey for the named character):\n${rulesCtx}` : null,
    `LOCATIONS (verbatim paste into image_prompt):\n${locs || "(none)"}`,
    `OBJECTS (verbatim paste into image_prompt):\n${objs || "(none)"}`,
    prevScene && input.chainContinuity === true ? `\nPREVIOUS SCENE (continue from its end state):\n${JSON.stringify(prevScene)}` : ``,
    prevScene && input.chainContinuity !== true ? `\nPREVIOUS SCENE (story context only — do NOT continue its framing, composition or action):\n${JSON.stringify(prevScene)}` : ``,
    nextScene && input.chainContinuity === true ? `\nNEXT SCENE (must still flow into it):\n${JSON.stringify(nextScene)}` : ``,
    nextScene && input.chainContinuity !== true ? `\nNEXT SCENE (story context only — the new staging must stand alone, not hand off into it):\n${JSON.stringify(nextScene)}` : ``,
    ``,
    `CURRENT SCENE (rewrite this):\n${JSON.stringify(scene)}`,
    ``,
    `Return JSON: { "scene": { ...same scene schema as the scene plan..., "scene_number": ${scene.scene_number}, "duration_seconds": ${scene.duration_seconds} } }. Respond with JSON ONLY.`,
  ].filter((l) => l !== null).join("\n");
}

// Board -> existing scenario config (the approve handoff). Beats become
// pipeline beats (title/image/motion); the reference prompt anchors the key
// visual on the main character + primary location + style lock. Style lock
// AND every appearing character's visual identity are enforced server-side
// (appended when missing) so a forgetful model cannot drop grounding —
// text identity is what keeps non-anchored cast members consistent, since
// the image pipeline anchors pixels only on the single main reference.
export function boardToScenario(board) {
  const input = board.input || {};
  const bp = board.blueprint || {};
  const scenes = Array.isArray(board.scenes) ? board.scenes : [];
  const lock = styleLockFor(input.visualStyle, input.styleCustom);
  const key = styleKeyFor(input.visualStyle, input.styleCustom);
  const chars = arr(bp.characters);
  const charById = new Map(chars.map((c) => [c.character_id, c]));
  // "Minku (minku)" artifacts from identity strings carry no signal for the
  // image model — strip parentheticals that match a known bible id.
  const ids = [...charById.keys(),
    ...arr(bp.locations).map((l) => l.location_id),
    ...arr(bp.objects).map((o) => o.object_id)].filter(Boolean);
  const stripIds = (t) => {
    let out = String(t || "");
    for (const id of ids) {
      out = out.split(` (${id})`).join("").split(`(${id})`).join("");
    }
    return out.replace(/\s{2,}/g, " ").trim();
  };
  const identityOf = (c) => str(c.visual_identity_prompt) ||
    [c.name, Object.values(c.appearance || {}).join(", "), Object.values(c.clothing || {}).join(", ")]
      .filter(Boolean).join(", ");
  // Lyric-shot metadata passthrough: only non-empty values ride along so
  // story boards and old scenes produce byte-identical scenario configs.
  const lyricMeta = (s) => {
    const m = {};
    const o = s && typeof s === "object" ? s : {};
    for (const k of ["lyric_line_id", "parent_line_id", "lyric_text", "lyric_segment",
      "semantic_meaning", "visual_event", "shot_id", "shot_number",
      "song_start_time", "song_end_time", "continuity_required",
      "reference_source", "continuity_refs"]) {
      const v = o[k];
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
      m[k] = v;
    }
    return m;
  };
  // Motion must never re-describe the character (appearance words in an i2v
  // prompt invite the video model to redesign the face/outfit). Strip id
  // artifacts and enforce the fidelity lock so the clip only adds motion to
  // the keyframe that already carries the locked identity. Speaking beats
  // gain a frontal speaking-motion suffix (from the dialogue expression when
  // the model forgot one) so the face stays visible for lip-sync.
  const motionKey = motionKeyFor().toLowerCase();
  const withMotionLock = (s) => {
    let t = stripIds(String(s.video_prompt || "").trim());
    // Connected OFF = independent shots: drop any stored handoff language so
    // the clip prompt can't stage a continuation of the previous shot.
    if (!wantChain) t = stripContinuityText(t);
    const dlg = wantDialogue ? normalizeDialogue(s.dialogue) : [];
    if (dlg.length && !/speaking|talking|lip-?sync|mouth moving/i.test(t)) {
      const expr = dlg.map((d) => d.expression).find(Boolean) || str(s.expression).trim();
      t = t ? `${t}, ${expr ? `${expr} while speaking` : "speaking"}, mouth moving, clear face visible for lip-sync`
        : "speaking, mouth moving, clear face visible for lip-sync";
    }
    // Same-scene linkage + quality: motion animates this scene's own
    // keyframe at 8k clarity with no distortion/morphing (never a redesign).
    if (!t) return MOTION_FIDELITY_LOCK;
    const hasFidelity = t.toLowerCase().includes(motionKey);
    const hasQuality = /8k uhd quality|no distortion|no morphing/i.test(t);
    if (hasFidelity && hasQuality) return t;
    if (hasFidelity) {
      return /8k uhd quality/i.test(t) ? t : `${t}, highly clear 8k uhd quality, smooth natural motion, stable character and background, no distortion, no morphing, no flicker, no blurry, no low quality`;
    }
    return `${t}, ${MOTION_FIDELITY_LOCK}`;
  };
  const withCastAndLock = (s) => {
    let t = stripIds(s.image_prompt);
    // Connected OFF = independent shots: strip handoff language FIRST, before
    // context grounding re-appends identities/style/quality (the aggressive
    // generic strip may eat trailing tokens, which are all re-added below).
    if (!wantChain) {
      const cont = str(s.continuity_from_previous_scene).trim();
      if (cont) t = t.split(`continuing from previous shot: ${cont}`).join("");
      t = stripContinuityText(t);
    }
    const locById = new Map(arr(bp.locations).map((l) => [l.location_id, l]));
    const objById = new Map(arr(bp.objects).map((o) => [o.object_id, o]));
    for (const cid of arr(s.characters)) {
      const c = charById.get(cid);
      if (!c) continue;
      const ident = identityOf(c);
      // A bare name is not grounding — append the full identity unless its
      // head is already present. Anchor on the name when nothing richer
      // exists.
      const probe = (ident || c.name || "").slice(0, 24).toLowerCase();
      if (probe && !t.toLowerCase().includes(probe)) {
        t = t ? `${t}, ${ident || c.name}` : String(ident || c.name);
      }
    }
    // Location + object grounding: the model often drops these even though
    // the schema asked for verbatim paste — enforce server-side like the
    // cast, so backgrounds/props stop drifting between scenes.
    const loc = locById.get(s.location);
    const locIdent = loc ? (str(loc.visual_identity_prompt) || str(loc.description)) : "";
    if (locIdent) {
      const probe = locIdent.slice(0, 24).toLowerCase();
      if (probe && !t.toLowerCase().includes(probe)) t = t ? `${t}, ${locIdent}` : locIdent;
    }
    for (const ref of arr(s.continuity_refs)) {
      const o = objById.get(ref);
      const oi = o ? str(o.visual_identity_prompt) : "";
      if (oi && !t.toLowerCase().includes(oi.slice(0, 24).toLowerCase())) t = t ? `${t}, ${oi}` : oi;
    }
    // Render the story expression in the keyframe: the image model never sees
    // the dialogue lines, so the scene/expression fields must travel in the
    // pixels (smiling, crying, shouting...). Appended only when missing so a
    // careful model is never double-described.
    const exprBits = [str(s.expression).trim(), str(s.emotion).trim(), str(s.body_language).trim()]
      .filter(Boolean).join(", ");
    if (exprBits && !t.toLowerCase().includes(exprBits.slice(0, 20).toLowerCase())) {
      t = t ? `${t}, ${exprBits}` : exprBits;
    }
    // Per-line dialogue expressions missing from the scene-level fields still
    // reach the frame (first one wins — one scene stays one moment).
    if (!exprBits) {
      const lineExpr = normalizeDialogue(s.dialogue).map((d) => d.expression).find(Boolean);
      if (lineExpr && !t.toLowerCase().includes(lineExpr.slice(0, 20).toLowerCase())) {
        t = t ? `${t}, ${lineExpr}` : lineExpr;
      }
    }
    // Continuity handoff (Connected ON only): the image model never sees
    // the continuity_from_previous_scene field, so append it (same clearing,
    // same framing, character mid-action from the last frame) unless the
    // prompt already carries it. When Connected is OFF the field is ignored
    // (handoff language was already stripped above, before grounding).
    if (wantChain) {
      const cont = str(s.continuity_from_previous_scene).trim();
      if (cont && !t.toLowerCase().includes(cont.slice(0, 24).toLowerCase())) {
        t = t ? `${t}, continuing from previous shot: ${cont}` : cont;
      }
    }
    // Context + style + quality: the image prompt always carries the full
    // scene context above, the global style lock, AND the 8k/no-distortion
    // quality lock (idempotent — never doubled).
    if (!t) return withQualityLock(lock);
    let out = t.toLowerCase().includes(key.toLowerCase()) ? t : `${t}, ${lock}`;
    return withQualityLock(out);
  };
  const wantDialogue = input.includeDialogue !== false;
  const wantChain = input.chainContinuity === true;
  const main = chars.find((c) => /main/i.test(c.role || "")) || chars[0] || null;
  const locs = arr(bp.locations);
  const refParts = [
    main ? (main.visual_identity_prompt || main.name) : null,
    locs[0] ? (locs[0].visual_identity_prompt || locs[0].description) : null,
    lock,
  ].filter(Boolean);
  return {
    description: str(input.title) + (bp.logline ? ` — ${bp.logline}` : ""),
    duration: Number(input.sceneSeconds) || 3,
    referencePrompt: withQualityLock(stripIds(refParts.join(", "))),
    // Silent-film boards carry no dialogue into the pipeline (even if an old
    // scene still has lines, they are dropped here so Generate stays silent).
    // Connected boards keep TEXT continuity only (chainContinuity wording);
    // pixels stay strictly per-scene: every keyframe anchors on the
    // reference, every clip animates its own keyframe.
    ...(wantChain ? { chainContinuity: true } : {}),
    ...(input.song && typeof input.song === "object" && input.song.file
      ? {
        song: {
          file: str(input.song.file),
          fileName: str(input.song.fileName || "song.mp3"),
          durationSeconds: Math.round(Number(input.song.durationSeconds) || 0) || null,
        },
      }
      : {}),
    // Multi-shot scenes flatten to one generation beat PER SHOT (each shot
    // is its own keyframe image + video clip at its own timed duration, so
    // one scene covering several entities renders as several connected
    // clips). Scenes without shots map 1:1 exactly as before — their beat
    // shape is byte-identical to the pre-shots output.
    sequence: scenes.flatMap((s, i) => {
      const sceneSlug = str(s.title, `scene${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `scene${i + 1}`;
      const sceneDialogue = wantDialogue ? normalizeDialogue(s.dialogue) : [];
      const shots = Array.isArray(s.shots) && s.shots.length ? s.shots : null;
      if (!shots) {
        return [{
          title: sceneSlug,
          image: withCastAndLock(s),
          motion: withMotionLock(s),
          // Per-scene clip length (dialogue beats grow to fit the voice at
          // generation time — see beatTargetDuration/estimateDialogueDuration in
          // lib/tts.mjs). Emotion/expression ride along so TTS rate/pitch and the
          // lip-sync staging stay story-true without re-reading the board.
          duration: Number(s.duration_seconds) || Number(input.sceneSeconds) || 3,
          emotion: str(s.emotion),
          expression: str(s.expression),
          body_language: str(s.body_language),
          dialogue: sceneDialogue,
          // Scene location id (informational for the workspace UI/timeline;
          // every clip starts from its own keyframe regardless of location).
          location: str(s.location),
          // Lyric-shot metadata for the workspace UI (grouping, timeline,
          // continuity). The generation pipeline reads title/image/motion/
          // duration/dialogue unchanged — these keys are informational only.
          ...lyricMeta(s),
        }];
      }
      return shots.map((sh, k) => {
        const o = sh && typeof sh === "object" ? sh : {};
        const letter = String.fromCharCode(97 + Math.max(0, k)); // a, b, c...
        // Shot wins; the scene fills whatever the shot leaves blank. An
        // empty shot cast inherits the scene cast so grounding never drops
        // to nothing. Scene-level dialogue rides on the FIRST shot only —
        // later shots speak their own lines.
        const chars = arr(o.characters).length ? o.characters : s.characters;
        const dlg = wantDialogue
          ? (arr(o.dialogue).length ? normalizeDialogue(o.dialogue) : (k === 0 ? sceneDialogue : []))
          : [];
        const merged = {
          ...s, ...o,
          characters: chars,
          location: str(o.location) || str(s.location),
          dialogue: dlg,
        };
        // Song-absolute timing for the shot: the scene's song window plus
        // the shot's scene-relative offset (drives the song-synced UI and
        // any future per-shot mux alignment).
        const meta = { ...lyricMeta(s), ...lyricMeta(o) };
        const sceneSongStart = Number(s.song_start_time);
        const relStart = Number(o.start_time);
        const relEnd = Number(o.end_time);
        if (Number.isFinite(sceneSongStart) && Number.isFinite(relStart)) {
          meta.song_start_time = Math.round((sceneSongStart + relStart) * 10) / 10;
        }
        if (Number.isFinite(sceneSongStart) && Number.isFinite(relEnd)) {
          meta.song_end_time = Math.round((sceneSongStart + relEnd) * 10) / 10;
        }
        return {
          title: `${sceneSlug}_${letter}`,
          image: withCastAndLock(merged),
          motion: withMotionLock(merged),
          duration: Number(o.duration_seconds) || Number(s.duration_seconds) || Number(input.sceneSeconds) || 3,
          emotion: str(merged.emotion),
          expression: str(merged.expression),
          body_language: str(merged.body_language),
          dialogue: dlg,
          location: str(merged.location),
          // Scene/shot linkage for the workspace UI (grouping, timeline).
          scene_number: s.scene_number,
          shot_id: str(o.shot_id) || `${s.scene_number}-${String.fromCharCode(65 + Math.max(0, k))}`,
          shot_number: Number(o.shot_number) || k + 1,
          start_time: Number.isFinite(relStart) ? relStart : null,
          end_time: Number.isFinite(relEnd) ? relEnd : null,
          ...meta,
        };
      });
    }),
    // Voice casting per character_id (empty = auto-cast in lib/tts.mjs).
    // Edit voices here to recast, e.g. { "chiku": "hi-IN-SwaraNeural" }.
    tts: { defaultVoice: "", voices: {} },
  };
}
