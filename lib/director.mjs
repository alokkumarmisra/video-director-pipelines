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
    "Photorealistic cinematic film still, natural skin texture, realistic lighting and shadows, shallow depth of field",
  Anime:
    "Vibrant anime style, clean cel shading, expressive large eyes, dynamic composition, detailed backgrounds",
  Cartoon:
    "Classic 2D cartoon style, bold outlines, bright flat colors, playful squash-and-stretch feel",
  "Indian Mythological":
    "Rich Indian mythological art style, divine glowing palette, ornate traditional costumes and jewelry, epic painterly backgrounds",
  Fantasy:
    "Epic fantasy illustration style, magical glowing accents, lush detailed environments, cinematic atmosphere",
};

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
Maintain strict character consistency, location consistency, object
consistency, visual style consistency and chronological continuity.
Never change an established character's face, body, species, clothing or
colors unless the story explicitly requires it. Never invent major plot
events that contradict the story; minor visual details for cinematic
presentation are allowed. Turn abstract emotions into visible actions
(happy -> smiling, jumping, clapping; sad -> lowered head, teary eyes;
surprised -> widened eyes, open mouth; angry -> tightened fists;
scared -> stepping backward, trembling; excited -> energetic movement).
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

const str = (v, fb = "") => (v == null ? fb : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);

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
    beats: arr(o.beats).map((b, i) => {
      const x = b && typeof b === "object" ? b : {};
      return { n: Number(x.n) || i + 1, title: str(x.title, `Beat ${i + 1}`), summary: str(x.summary) };
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

const CAMERA_DEFAULT = { shot_type: "Medium Shot", angle: "Eye Level", movement: "Static" };

// Normalize one scene: defaults for missing keys, enforced numbering and
// duration clamp. Style lock is appended by boardToScenario (single place).
// dialogue = [{ speaker (character_id), line (speakable text) }] — voiced
// per character (Edge-TTS) and lip-synced (Easy-Wav2lip) downstream; the
// clip length for the beat always grows to fit the spoken audio.
export function normalizeDialogue(d) {
  return arr(d).map((x) => {
    const o = x && typeof x === "object" ? x : {};
    return { speaker: slugId(o.speaker, ""), line: str(o.line) };
  }).filter((x) => x.line.trim());
}
export function normalizeScene(s, n, sceneSeconds) {
  const o = s && typeof s === "object" ? s : {};
  const cam = o.camera && typeof o.camera === "object" ? o.camera : {};
  const dur = Number(o.duration_seconds);
  return {
    scene_number: n,
    title: str(o.title, `Scene ${n}`),
    story_beat: str(o.story_beat),
    duration_seconds: Number.isFinite(dur) ? Math.min(30, Math.max(1, Math.round(dur))) : sceneSeconds,
    characters: arr(o.characters).map((x) => str(x)).filter(Boolean),
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
    `{ "logline": "...", "analysis": { "plot": "...", "beginning": "...", "middle": "...", "climax": "...", "ending": "...", "main_character": "...", "supporting_characters": ["..."], "antagonist": "... or null", "objects": ["..."], "locations": ["..."], "events": ["..."], "relationships": "...", "emotional_progression": "...", "timeline": "...", "visual_moments": ["..."] },`,
    `  "characters": [{ "character_id": "snake_case", "name": "...", "role": "main_character|supporting|antagonist", "species": "...", "age": "...", "appearance": { "body": "...", "fur": "...", "eyes": "...", "ears": "..." }, "clothing": { "top": "...", "bottom": "..." }, "personality": ["..."], "visual_identity_prompt": "one self-contained portrait prompt that locks this exact look" }],`,
    `  "locations": [{ "location_id": "snake_case", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt", "time_of_day": "...", "lighting": "...", "color_palette": "..." }],`,
    `  "objects": [{ "object_id": "snake_case", "name": "...", "description": "...", "visual_identity_prompt": "one self-contained look prompt" }],`,
    `  "beats": [{ "n": 1, "title": "...", "summary": "one line" }] }`,
    `Cover every important story event with beats (characters, not paragraphs, decide). Write every visual_identity_prompt so it can be pasted into an image prompt verbatim. Respond with JSON ONLY.`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// Scene-batch user message. Beats slice + identity strings + the previous
// scene (continuity anchor) keep each call small and chronologically locked.
// Only the beats proportional to THIS scene range are sent — earlier batches
// sent the whole beat list every time, so late batches re-planned the opening
// and copied scene-1 dialogue across dozens of scenes.
export function buildScenesPrompt({ input, blueprint, beats, prevScene, startNumber, count, styleLock, totalScenes = null, priorDialogue = [] }) {
  const { chars, locs, objs } = identityContext(blueprint);
  const all = arr(beats);
  const total = Math.max(1, Number(totalScenes) || (Number(startNumber) || 1) + (Number(count) || 1) - 1);
  const ranged = beatsForSceneRange(all, startNumber, count, total);
  const covering = ranged.length ? ranged : all;
  const beatLines = covering.map((b) => `Beat ${b.n}: ${b.title} — ${b.summary}`).join("\n") || "(no beats — continue the story chronologically)";
  // Voice hints derived from THIS story's bible — never a hardcoded example
  // cast (a past "Rabbit Chiku / Lion Shera" example leaked those names and
  // voices into unrelated stories).
  const cast = arr(blueprint && blueprint.characters).map((c) => {
    const traits = [...arr(c.personality), str(c.role)].filter(Boolean).join(", ");
    return `${c.name} (${c.character_id})${traits ? ` — ${traits}` : ""}`;
  }).join("; ");
  const used = arr(priorDialogue).map((x) => str(typeof x === "string" ? x : x.line)).filter(Boolean).slice(-40);
  return [
    `TASK 2/2 — SCENE PLAN (scenes ${startNumber}..${startNumber + count - 1} of ${total} total). Plan ONLY these ${count} scenes — continue the story forward, never restart it.`,
    `STORY TITLE: ${input.title} | GENRE: ${input.genre} | STYLE: ${input.visualStyle}`,
    `SCENE DURATION: ${input.sceneSeconds} seconds each.`,
    `DIALOGUE (voice + lip-sync): each scene carries 0-2 short speakable lines in ${input.language} as "dialogue": [{ "speaker": "<character_id>", "line": "..." }]. ` +
      `The speaker MUST be a character who is on screen in that scene${cast ? ` (cast: ${cast})` : ""}; keep each voice in character. ` +
      `Keep each line under ~15 words so it fits the scene; the clip is lengthened to fit the voice automatically. ` +
      `CRITICAL: every scene's dialogue must be NEW story-advancing speech — NEVER copy or paraphrase a line from an earlier scene, and NEVER repeat the same line in two scenes. ` +
      `Action-only scenes (chases, reactions, montages) should use empty dialogue [] instead of filler speech. ` +
      `When a character speaks, stage them FRONT-FACING and clearly visible (Close-Up or Medium Close-Up, Eye Level, Static) — ` +
      `the lip-sync pass needs the speaker's face in frame for every frame.`,
    used.length ? `LINES ALREADY USED (do not repeat any of these verbatim or in paraphrase):\n${used.map((l) => `- ${l}`).join("\n")}` : null,
    input.song && typeof input.song === "object"
      ? `MUSIC-VIDEO PACING: scenes must total ~${Math.round(Number(input.song.durationSeconds) || input.targetSeconds)}s to match the song; favor performance/movement shots that cut on the beat, no lip-sync close-ups held longer than one scene.`
      : null,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    ``,
    `CHARACTER IDENTITIES (paste the exact visual_identity_prompt into every image_prompt where the character appears; never alter looks):`,
    chars || "(none)",
    ``,
    `LOCATIONS:`,
    locs || "(none)",
    ``,
    `OBJECTS:`,
    objs || "(none)",
    ``,
    `GLOBAL STYLE (append to every image_prompt verbatim): ${styleLock}`,
    ``,
    `STORY BEATS TO COVER IN THIS BATCH (only these — in order):`,
    beatLines,
    prevScene ? `\nPREVIOUS SCENE (end state — continue from it, do not repeat it):\n${JSON.stringify(prevScene)}` : ``,
    ``,
    `Return JSON: { "scenes": [ { "scene_number": ${startNumber}, "title": "...", "story_beat": "Beat N: ...", "duration_seconds": ${input.sceneSeconds}, "characters": ["character_id"...], "location": "location_id or name", "time_of_day": "...", "action": "visible physical behavior, not feelings", "emotion": "...", "expression": "...", "body_language": "...", "camera": { "shot_type": "one of: Extreme Wide Shot, Wide Shot, Establishing Shot, Medium Shot, Medium Close-Up, Close-Up, Extreme Close-Up, Over-the-Shoulder, Two Shot", "angle": "one of: Low Angle, High Angle, Eye Level, Top Down", "movement": "one of: Static, Pan, Tilt, Dolly In, Dolly Out, Tracking Shot, Orbit, Crane" }, "lighting": "...", "environment": "...", "continuity_from_previous_scene": "...", "transition_to_next_scene": "...", "dialogue": [{ "speaker": "character_id", "line": "speakable line in ${input.language}" }], "image_prompt": "self-contained image prompt incl. identities + style", "video_prompt": "motion only: character/object/environment/camera movement, expression changes" } ] }`,
    `Write exactly ${count} scenes numbered ${startNumber}..${startNumber + count - 1}. Keep camera movement simple unless the story needs it. Respond with JSON ONLY.`,
  ].filter((l) => l !== null).join("\n");
}

// Single-scene regeneration message (target beat + neighbors for continuity).
export function buildRegenPrompt({ input, blueprint, scene, prevScene, nextScene, styleLock }) {
  const { chars, locs, objs } = identityContext(blueprint);
  return [
    `REGENERATE ONE SCENE (scene ${scene.scene_number}, "${scene.title}"). Keep its place in the story; invent a fresh staging for the same beat.`,
    `STYLE: ${input.visualStyle} — GLOBAL STYLE (append to image_prompt verbatim): ${styleLock}`,
    input.instructions ? `DIRECTOR INSTRUCTIONS: ${input.instructions}` : null,
    ``,
    `CHARACTER IDENTITIES:\n${chars || "(none)"}`,
    `LOCATIONS:\n${locs || "(none)"}`,
    `OBJECTS:\n${objs || "(none)"}`,
    prevScene ? `\nPREVIOUS SCENE (continue from its end state):\n${JSON.stringify(prevScene)}` : ``,
    nextScene ? `\nNEXT SCENE (must still flow into it):\n${JSON.stringify(nextScene)}` : ``,
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
  const withCastAndLock = (s) => {
    let t = stripIds(s.image_prompt);
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
    if (!t) return lock;
    return t.toLowerCase().includes(key.toLowerCase()) ? t : `${t}, ${lock}`;
  };
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
    referencePrompt: stripIds(refParts.join(", ")),
    ...(input.song && typeof input.song === "object" && input.song.file
      ? {
        song: {
          file: str(input.song.file),
          fileName: str(input.song.fileName || "song.mp3"),
          durationSeconds: Math.round(Number(input.song.durationSeconds) || 0) || null,
        },
      }
      : {}),
    sequence: scenes.map((s, i) => ({
      title: str(s.title, `scene${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `scene${i + 1}`,
      image: withCastAndLock(s),
      motion: stripIds(String(s.video_prompt || "").trim()),
      // Per-scene clip length (dialogue beats grow to fit the voice at
      // generation time — see beatTargetDuration in lib/tts.mjs).
      duration: Number(s.duration_seconds) || Number(input.sceneSeconds) || 3,
      dialogue: normalizeDialogue(s.dialogue),
    })),
    // Voice casting per character_id (empty = auto-cast in lib/tts.mjs).
    // Edit voices here to recast, e.g. { "chiku": "hi-IN-SwaraNeural" }.
    tts: { defaultVoice: "", voices: {} },
  };
}
