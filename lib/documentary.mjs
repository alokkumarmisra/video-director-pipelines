// Documentary Mode — pure helpers (brief validation, planning prompts,
// heuristic fallback planner, board -> scenario mapping, timeline, subtitles,
// export manifest, dependency invalidation). No network, no fs: fully
// unit-testable.
//
// Architecture: Documentary Mode is an ORCHESTRATION layer only. Planning
// authors a board (brief -> chapters -> sequences -> shots + narration +
// bibles); APPROVE hands a standard scenario config to the EXISTING
// saveScenario/workspace pipeline, so Flux/LTX/Wan/TTS/ACE-Step/lip-sync,
// SSE, versioning, resume and FFmpeg assembly are 100% reused.

export const DOC_STATUSES = [
  "brief",
  "planning",
  "narration",
  "bible",
  "shots-partial",
  "ready",
  "approved",
  "generating",
  "assembling",
  "completed",
];

export const DOC_SHOT_STAGES = [
  "WAITING",
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "LIPSYNC",
  "READY",
  "FAILED",
  "SKIPPED",
];

export const DOC_SOURCE_TYPES = [
  "traditional",
  "scriptural",
  "historical",
  "user_provided",
  "creative",
  "mixed",
];

// Max shots safety ceiling only (mirrors MAX_SCENES in lib/director.mjs).
export const MAX_SHOTS = 300;
// Shot batch size for LLM scene-batch calls (mirrors SCENE_BATCH).
export const SHOT_BATCH = 12;

export const DEFAULT_DOC_BRIEF = {
  language: "Hindi",
  targetMinutes: 25,
  aspectRatio: "16:9",
  visualStyle: "Cinematic devotional documentary, photorealistic mythological India, 16:9",
  narrationStyle: "Hindi documentary narration",
  narrationVoice: "hi-IN-MadhurNeural",
  tone: "Spiritual + cinematic + informative",
  audience: "Family devotional audience",
  musicStyle: "Devotional ambient, temple bells, soft drone",
  sourceType: "mixed",
};

// Photorealism lock for devotional imagery. Flux renders what the text asks
// for — a lone "photorealistic" is not enough; without explicit detail +
// anti-cartoon tokens the keyframes drift soft/painterly. Enforced
// server-side in boardToScenario (and baked into heuristic prompts) so every
// devotional image carries it even when the LLM forgets it.
export const DEVOTIONAL_REALISM_LOCK =
  "ultra photorealistic, highly detailed 8k uhd cinematic film still, sharp focus, intricate details, natural skin texture, detailed expressive eyes, lifelike divine glow, volumetric lighting, rich colors, professional devotional cinematography, no cartoon, no painting, no illustration, no blur, no watermark";

// Devotional Flux quality: 4-step drafts look soft; 14 steps resolve
// skin/fabric/ornament detail. Stored on the scenario as fluxSteps and
// honored by scripts/character_sequence*.mjs (falls back to 4 for
// non-devotional projects so kids/cartoon stays fast).
export const DEVOTIONAL_FLUX_STEPS = 14;

// True when the board is devotional/mythological (title/topic/tone/style
// scan — Hindi + English cues). Non-devotional docs skip the lock so e.g. a
// historical doc doesn't get a "divine glow".
export function isDevotionalBrief(brief) {
  const t = [brief && brief.title, brief && brief.topic, brief && brief.tone,
    brief && brief.visualStyle, brief && brief.audience]
    .filter(Boolean).join(" ").toLowerCase();
  return /devotion|devotional|bhakti|shiv|shiva|mahadev|vishnu|krishna|ram\b|hanuman|durga|lakshmi|parvati|ganesh|mytholog|leela|katha|bhajan|mandir|temple|divine|kailash|tandav|samudra/.test(t);
}

/** Append the realism lock unless the prompt already carries it. */
export function withDevotionalRealism(prompt) {
  const t = String(prompt || "").trim();
  if (!t) return DEVOTIONAL_REALISM_LOCK;
  return /ultra photorealistic|8k uhd|photorealistic/i.test(t) &&
    /sharp focus|intricate details/i.test(t)
    ? t
    : /ultra photorealistic|8k uhd/i.test(t)
      ? t
      : `${t}, ${DEVOTIONAL_REALISM_LOCK}`;
}

// Hindi narration rate: ~130 words/min (~2.17 wps) + 0.4s pause per line.
export function estimateNarrationSeconds(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  const words = t.split(/\s+/).filter(Boolean).length;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean).length;
  return Math.max(1, Math.round((words / 2.17 + Math.max(0, lines - 1) * 0.4) * 10) / 10);
}

export function estimateWordsForSeconds(seconds) {
  return Math.max(1, Math.round(Number(seconds) * 2.17));
}

// Dynamic shot count from narration duration (primary timing source).
// Default shot 6–15s (avg ~12s for long docs: 20min->~100, 25min->~125,
// 30min->~150); longer/shorter when the plan needs it.
export function shotsForDuration(totalSeconds, avgShotSeconds = 12) {
  const t = Number(totalSeconds);
  const avg = Math.min(15, Math.max(6, Number(avgShotSeconds) || 10));
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.min(MAX_SHOTS, Math.max(1, Math.round(t / avg)));
}

// Chapter count scales with duration: 20–30 min -> 6–9; short tests fewer.
export function chaptersForDuration(totalSeconds) {
  const t = Number(totalSeconds);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (t <= 180) return 2;
  if (t <= 360) return 3;
  if (t <= 600) return 4;
  if (t <= 900) return 5;
  if (t <= 1200) return 6;
  if (t <= 1500) return 7;
  if (t <= 1800) return 8;
  return 9;
}

const str = (v, fb = "") => (v == null ? fb : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const slugId = (v, fb) =>
  str(v, fb).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || fb;

// ---- Brief validation (defaults per spec §5) ----
export function validateDocBrief(body) {
  const b = body && typeof body === "object" ? body : {};
  const title = str(b.title).trim().slice(0, 160);
  const topic = str(b.topic || b.title).trim().slice(0, 500);
  if (!title) throw new Error("documentary title is required");
  if (str(b.sourceMaterial).trim().length < 0) throw new Error("unreachable");
  const language = str(b.language).trim() || DEFAULT_DOC_BRIEF.language;
  // Duration: 20/25/30 + custom (5-min test uses custom 5).
  let targetMinutes = Number(b.targetMinutes ?? b.durationMinutes ?? 25);
  if (b.targetSeconds != null && b.targetMinutes == null && b.durationMinutes == null) {
    targetMinutes = Number(b.targetSeconds) / 60;
  }
  if (!Number.isFinite(targetMinutes)) targetMinutes = 25;
  targetMinutes = Math.min(60, Math.max(1, Math.round(targetMinutes * 10) / 10));
  const targetSeconds = Math.round(targetMinutes * 60);
  const sourceType = DOC_SOURCE_TYPES.includes(str(b.sourceType).trim())
    ? str(b.sourceType).trim()
    : DEFAULT_DOC_BRIEF.sourceType;
  return {
    title,
    topic: topic || title,
    language,
    targetMinutes,
    targetSeconds,
    aspectRatio: str(b.aspectRatio).trim() || DEFAULT_DOC_BRIEF.aspectRatio,
    audience: str(b.audience).trim() || DEFAULT_DOC_BRIEF.audience,
    tone: str(b.tone).trim() || DEFAULT_DOC_BRIEF.tone,
    visualStyle: str(b.visualStyle).trim() || DEFAULT_DOC_BRIEF.visualStyle,
    narrationStyle: str(b.narrationStyle).trim() || DEFAULT_DOC_BRIEF.narrationStyle,
    narrationVoice: str(b.narrationVoice).trim() || DEFAULT_DOC_BRIEF.narrationVoice,
    musicStyle: str(b.musicStyle).trim() || DEFAULT_DOC_BRIEF.musicStyle,
    sourceMaterial: str(b.sourceMaterial || b.story || "").trim().slice(0, 20000),
    sourceType,
    characters: str(b.characters).trim().slice(0, 5000),
    events: str(b.events).trim().slice(0, 5000),
    locations: str(b.locations).trim().slice(0, 5000),
    instructions: str(b.instructions).trim().slice(0, 5000),
  };
}

// ---- Normalizers ----
export function normalizeDocCharacter(c, i) {
  const o = c && typeof c === "object" ? c : {};
  const vi = o.visual_identity && typeof o.visual_identity === "object" ? o.visual_identity : {};
  const pick = (k) => str(o[k] ?? vi[k]);
  return {
    character_id: slugId(o.character_id || o.name, `character_${i + 1}`),
    name: str(o.name, `Character ${i + 1}`),
    role: str(o.role, "supporting"),
    visual_identity: {
      face: str(vi.face || o.face),
      body: str(vi.body || o.body),
      skin: str(vi.skin || o.skin),
      hair: str(vi.hair || o.hair),
      eyes: str(vi.eyes || o.eyes),
      clothing: str(vi.clothing || o.clothing),
      ornaments: str(vi.ornaments || o.ornaments),
      weapons: str(vi.weapons || o.weapons),
    },
    identity_prompt:
      str(o.identity_prompt || o.visual_identity_prompt) ||
      [pick("name"), pick("face"), pick("body"), pick("skin"), pick("hair"), pick("eyes"), pick("clothing"), pick("ornaments"), pick("weapons")]
        .filter(Boolean)
        .join(", "),
    consistency_rules: arr(o.consistency_rules).map((x) => str(x)).filter(Boolean).length
      ? arr(o.consistency_rules).map((x) => str(x)).filter(Boolean)
      : [
          "Do not change face",
          "Do not change body proportions",
          "Do not change hairstyle",
          "Do not change costume without story justification",
        ],
    voice: str(o.voice),
    approved: o.approved === true,
  };
}

export function normalizeDocLocation(l, i) {
  const o = l && typeof l === "object" ? l : {};
  return {
    location_id: slugId(o.location_id || o.name, `location_${i + 1}`),
    name: str(o.name, `Location ${i + 1}`),
    description: str(o.description),
    lighting: str(o.lighting),
    architecture: str(o.architecture),
    environment: str(o.environment),
    time_period: str(o.time_period),
    visual_rules: arr(o.visual_rules).map((x) => str(x)).filter(Boolean),
    identity_prompt: str(o.identity_prompt || o.visual_identity_prompt) || str(o.description),
    approved: o.approved === true,
  };
}

export function normalizeDocShot(s, chapter, seq, n, globalIndex, fallbackSeconds = 10) {
  const o = s && typeof s === "object" ? s : {};
  const dur = Number(o.duration_seconds);
  const cam = o.camera && typeof o.camera === "object" ? o.camera : {};
  const audio = o.audio && typeof o.audio === "object" ? o.audio : {};
  const seqTag = `C${String(chapter).padStart(2, "0")}-S${String(seq).padStart(2, "0")}`;
  return {
    shot_id: str(o.shot_id) || `${seqTag}-SH${String(n).padStart(2, "0")}`,
    global_index: Number.isInteger(o.global_index) ? o.global_index : globalIndex,
    chapter: Number(o.chapter) || chapter,
    sequence: Number(o.sequence) || seq,
    title: str(o.title, `Shot ${globalIndex}`),
    duration_seconds: Number.isFinite(dur) ? Math.min(60, Math.max(2, Math.round(dur))) : fallbackSeconds,
    narration_lines: arr(o.narration_lines ?? o.narration).map((x) => str(x)).filter(Boolean),
    visual_type: str(o.visual_type, "establishing"),
    characters: arr(o.characters).map((x) => str(x)).filter(Boolean),
    location: str(o.location),
    flux_prompt: str(o.flux_prompt || o.image_prompt),
    ltx_prompt: str(o.ltx_prompt || o.video_prompt || o.motion),
    camera: {
      shot_type: str(cam.shot_type, "Wide Shot"),
      angle: str(cam.angle, "Eye Level"),
      movement: str(cam.movement, "slow cinematic push-in"),
    },
    motion: str(o.motion || o.ltx_prompt || o.video_prompt),
    lighting: str(o.lighting),
    audio: {
      music: audio.music !== false,
      sfx: audio.sfx === true,
      sfx_kind: str(audio.sfx_kind || audio.sfxKind),
    },
    pacing: str(o.pacing, "EXPLANATION"),
    status: DOC_SHOT_STAGES.includes(str(o.status)) ? str(o.status) : "WAITING",
    approved: o.approved === true,
    version: Number.isInteger(o.version) && o.version > 0 ? o.version : 1,
  };
}

export function normalizeDocSequence(q, chapter, seq, startGlobal) {
  const o = q && typeof q === "object" ? q : {};
  const shots = arr(o.shots);
  let g = startGlobal;
  const normShots = shots.map((s, i) => {
    const n = normalizeDocShot(s, chapter, seq, i + 1, g + 1);
    g += 1;
    return n;
  });
  const dur = Number(o.duration_seconds);
  return {
    sequence_id: str(o.sequence_id) || `C${String(chapter).padStart(2, "0")}-S${String(seq).padStart(2, "0")}`,
    chapter,
    seq,
    title: str(o.title, `Sequence ${chapter}.${seq}`),
    purpose: str(o.purpose),
    narration: str(o.narration),
    duration_seconds:
      Number.isFinite(dur) && dur > 0
        ? Math.round(dur)
        : normShots.reduce((a, s) => a + s.duration_seconds, 0) || 30,
    visual_goal: str(o.visual_goal),
    pacing: str(o.pacing, "EXPLANATION"),
    shots: normShots,
  };
}

export function normalizeDocChapter(c, n) {
  const o = c && typeof c === "object" ? c : {};
  const seqs = arr(o.sequences);
  // Global index runs across the whole board; computed by caller via offset.
  const normSeqs = seqs.map((q, i) => normalizeDocSequence(q, n, i + 1, 0));
  // Re-number globals sequentially within chapter (caller re-offsets across chapters).
  let g = Number(o.__globalOffset) || 0;
  for (const q of normSeqs) for (const s of q.shots) { g += 1; s.global_index = g; }
  const dur = Number(o.target_duration_seconds ?? o.duration_seconds);
  return {
    chapter_number: Number(o.chapter_number) || n,
    title: str(o.title, `Chapter ${n}`),
    purpose: str(o.purpose),
    target_duration_seconds:
      Number.isFinite(dur) && dur > 0
        ? Math.round(dur)
        : normSeqs.reduce((a, q) => a + q.duration_seconds, 0) || 120,
    sequences: normSeqs,
  };
}

// Re-offset global shot indexes across a chapter list (1..N).
export function reindexBoardShots(chapters) {
  let g = 0;
  for (const c of chapters) {
    for (const q of c.sequences) {
      for (const s of q.shots) { g += 1; s.global_index = g; }
    }
  }
  return g;
}

export function countBoardShots(board) {
  let n = 0;
  for (const c of arr(board && board.chapters)) for (const q of arr(c.sequences)) n += arr(q.shots).length;
  return n;
}

export function boardNarrationSeconds(board) {
  let total = 0;
  for (const c of arr(board && board.chapters)) {
    for (const q of arr(c.sequences)) {
      if (q.narration) total += estimateNarrationSeconds(q.narration);
      for (const s of arr(q.shots)) {
        for (const line of arr(s.narration_lines)) total += estimateNarrationSeconds(line);
      }
    }
  }
  return Math.round(total * 10) / 10;
}

// ---- LLM prompts (reuse the shared llama-server convention; see server.mjs) ----
export const DOCUMENTARY_DIRECTOR_SYSTEM = `You are the DOCUMENTARY DIRECTOR of Sanskriti AI Studio: director + screenwriter + visual director + continuity director + editor.
You plan long-form Hindi devotional documentaries (20-30 minutes) as structured JSON ONLY (no markdown fences, no commentary).
Rules: narration FIRST (Hindi, respectful devotional tone), then shot timing derived from narration duration (shots 6-15s, dynamic count, never a fixed number). Chapters 6-9 for full length (fewer for short tests). Each chapter has sequences; each sequence has shots. Every shot carries narration_lines + flux_prompt + ltx_prompt + camera + motion + audio flags. Character Bible BEFORE images: locked visual identities reused verbatim, never randomly redesigned. Location Bible inherited by shots. Vary shot grammar intentionally (wide/medium/close-up/extreme close-up/OTS/low/high/tracking/push-in/pull-out/pan/tilt/static) chosen by narration, never random. Pace visuals by story phase (INTRODUCTION slow, BUILDUP/EXPLANATION steady, EMOTIONAL calm, CLIMAX strong, REFLECTION/CONCLUSION peaceful). Avoid modern objects in ancient scenes, costume drift, repeated compositions, filler dialogue. Respect source_type: never present creative invention as scriptural fact.`;

export function buildDocBiblePrompt(brief) {
  const b = brief;
  return [
    `DOCUMENTARY BRIEF: "${b.title}" — topic: ${b.topic}`,
    `LANGUAGE: ${b.language} | TARGET: ~${b.targetSeconds}s (${b.targetMinutes} min) | ASPECT: ${b.aspectRatio}`,
    `AUDIENCE: ${b.audience} | TONE: ${b.tone}`,
    `VISUAL STYLE: ${b.visualStyle} | NARRATION STYLE: ${b.narrationStyle} | MUSIC STYLE: ${b.musicStyle}`,
    `SOURCE TYPE: ${b.sourceType}${b.sourceMaterial ? `\nSOURCE MATERIAL:\n${b.sourceMaterial}` : ""}`,
    b.characters ? `CHARACTERS:\n${b.characters}` : null,
    b.events ? `IMPORTANT EVENTS:\n${b.events}` : null,
    b.locations ? `IMPORTANT LOCATIONS:\n${b.locations}` : null,
    b.instructions ? `SPECIAL INSTRUCTIONS: ${b.instructions}` : null,
    ``,
    `TASK 1/3 — DOCUMENTARY BLUEPRINT. Return JSON ONLY:`,
    `{ "logline": "...", "chapters": [{ "chapter_number": 1, "title": "...", "purpose": "...", "target_duration_seconds": 180, "sequences": [{ "seq": 1, "title": "...", "purpose": "...", "narration": "Hindi narration paragraph(s) for this sequence", "duration_seconds": 45, "visual_goal": "...", "pacing": "INTRODUCTION|BUILDUP|EXPLANATION|EMOTIONAL_MOMENT|CLIMAX|REFLECTION|CONCLUSION" }] }],`,
    `"characters": [{ "character_id": "snake_case", "name": "...", "role": "...", "visual_identity": { "face": "...", "body": "...", "skin": "...", "hair": "...", "eyes": "...", "clothing": "...", "ornaments": "...", "weapons": "..." }, "consistency_rules": ["..."] }],`,
    `"locations": [{ "location_id": "snake_case", "name": "...", "description": "...", "lighting": "...", "architecture": "...", "environment": "...", "time_period": "...", "visual_rules": ["..."] }],`,
    `"music_beds": [{ "bed_id": "snake_case", "mood": "opening|mystical|tension|revelation|emotional|climax|peaceful", "duration_seconds": 120, "description": "..." }] }`,
    `Plan ${chaptersForDuration(b.targetSeconds)} chapters covering the topic in order (intro, origin, personality, stories, symbolism, devotees, meaning, conclusion — adapt when the topic demands it). Narration must be ${b.language} and sized so chapter durations sum to ~${b.targetSeconds}s.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function buildDocShotsPrompt({ brief, board, chapter, startGlobal = 0 }) {
  const c = chapter;
  const chars = arr(board.characters)
    .map((x) => `- ${x.name} (${x.character_id}): ${x.identity_prompt || ""}`)
    .join("\n");
  const locs = arr(board.locations)
    .map((x) => `- ${x.name} (${x.location_id}): ${x.description || x.identity_prompt || ""}`)
    .join("\n");
  const seqs = arr(c.sequences)
    .map((q) => `Sequence ${q.sequence_id || q.seq}: ${q.title} — ${q.purpose || ""}\nNarration: ${q.narration || "(none)"}\nVisual goal: ${q.visual_goal || ""} (${q.duration_seconds || "?"}s, pacing ${q.pacing || "EXPLANATION"})`)
    .join("\n\n");
  const devotional = isDevotionalBrief(brief);
  return [
    `TASK 2/3 — SHOT PLAN for Chapter ${c.chapter_number} "${c.title}" (${c.target_duration_seconds}s). Break every sequence into shots of 6-15s driven by narration timing (total chapter ~${c.target_duration_seconds}s).`,
    `GLOBAL STYLE (append verbatim to every flux_prompt): ${brief.visualStyle}, ${brief.tone}${devotional ? `, ${DEVOTIONAL_REALISM_LOCK}` : ""}`,
    `CHARACTER BIBLE (paste exact identity into flux_prompt verbatim):\n${chars || "(none)"}`,
    `LOCATION BIBLE:\n${locs || "(none)"}`,
    `NARRATION VOICE: ${brief.narrationVoice}. Dialogue is optional; narration is primary. When dialogue is needed, keep the same voice per speaker throughout.`,
    devotional
      ? `PHOTOREALISM (mandatory): every flux_prompt MUST read as an ultra-detailed 8k cinematic film still — photorealistic skin with natural texture, detailed expressive eyes, intricate costume/jewelry fabric detail, volumetric divine lighting, sharp focus. NEVER cartoon, painting, illustration, 3d-render or blurry. End every flux_prompt with: ${DEVOTIONAL_REALISM_LOCK}`
      : null,
    ``,
    `SEQUENCES TO COVER (in order, global shot index continues from ${startGlobal}):`,
    seqs,
    ``,
    `Return JSON ONLY: { "chapter_number": ${c.chapter_number}, "sequences": [{ "seq": 1, "shots": [{ "title": "...", "duration_seconds": 9, "narration_lines": ["..."], "visual_type": "establishing|character|detail|environmental|symbolic", "characters": ["character_id"], "location": "location_id", "flux_prompt": "global style + character bible + location bible + shot description + camera + lighting + composition${devotional ? " + photorealism lock" : ""}", "ltx_prompt": "motion only: what moves and how", "camera": { "shot_type": "Wide Shot|Medium Shot|Close-Up|Extreme Close-Up|Over-the-Shoulder|Establishing Shot|Two Shot", "angle": "Low Angle|High Angle|Eye Level|Top Down", "movement": "Static|Pan|Tilt|Dolly In|Dolly Out|Tracking Shot|Orbit|Crane|slow cinematic push-in" }, "motion": "...", "lighting": "...", "pacing": "...", "audio": { "music": true, "sfx": false, "sfx_kind": "" } }] }] }`,
    `Vary shot grammar by narration; no repetitive compositions; no modern objects in ancient scenes. Respond with JSON ONLY.`,
  ].filter((l) => l !== null).join("\n");
}

// ---- Heuristic offline planner (no LLM): deterministic, duration-driven ----
// Used when the LLM is offline AND for the 5-minute acceptance test path.
// Produces a valid board: chapters -> sequences -> shots with Hindi narration
// placeholders, flux/ltx prompts assembled from bibles + style lock.
const HEURISTIC_CHAPTER_TITLES = [
  "परिचय — दिव्य स्वरूप की झलक",
  "उत्पत्ति और पृष्ठभूमि",
  "दिव्य व्यक्तित्व और स्वरूप",
  "प्रमुख कथाएँ और लीलाएँ",
  "शक्ति, प्रतीक और अर्थ",
  "भक्तों से संबंध",
  "आध्यात्मिक संदेश",
  "उपसंहार — शांति और आशीर्वाद",
  "महिमा और समापन",
];

const HEURISTIC_SEQ_PURPOSES = ["स्थापना", "विस्तार", "भावनात्मक गहराई", "चरम क्षण"];

const HEURISTIC_SHOT_TYPES = ["Wide Shot", "Medium Shot", "Close-Up", "Establishing Shot", "Two Shot"];

const HEURISTIC_MOVES = ["slow cinematic push-in", "Static", "Pan", "Tilt", "Dolly Out", "Tracking Shot"];

const HEURISTIC_PACING = ["INTRODUCTION", "BUILDUP", "EXPLANATION", "EMOTIONAL_MOMENT", "CLIMAX", "REFLECTION", "CONCLUSION"];

export function heuristicPlan(brief) {
  const b = brief;
  const total = b.targetSeconds;
  const nChapters = chaptersForDuration(total);
  const perChapter = Math.floor(total / nChapters);
  const topic = b.topic || b.title;
  const charNames = b.characters
    ? b.characters.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6)
    : [];
  const locNames = b.locations
    ? b.locations.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6)
    : [];
  const characters = charNames.length
    ? charNames.map((name, i) => normalizeDocCharacter({
        character_id: slugId(name, `character_${i + 1}`),
        name,
        role: i === 0 ? "main" : "supporting",
        visual_identity: {
          face: `serene divine face of ${name}`,
          body: "majestic divine form",
          skin: "radiant fair skin with subtle divine glow",
          hair: "long dark matted hair adorned with crescent moon",
          eyes: "deep compassionate eyes",
          clothing: "tiger skin garment, sacred ash markings, rudraksha beads",
          ornaments: "serpent garland, trishul, damaru",
          weapons: i === 0 ? "trishul (trident), damaru" : "",
        },
      }, i))
    : [normalizeDocCharacter({
        character_id: "shiva",
        name: "Lord Shiva",
        role: "main",
        visual_identity: {
          face: "serene meditative face with third eye",
          body: "majestic ascetic divine form",
          skin: "ash-smeared radiant skin with blue throat",
          hair: "long matted locks with crescent moon and flowing Ganga",
          eyes: "deep compassionate half-closed eyes",
          clothing: "tiger skin, sacred ash tripundra, rudraksha mala",
          ornaments: "vasuki serpent garland, crescent moon",
          weapons: "trishul (trident), damaru",
        },
      }, 0)];
  const locations = locNames.length
    ? locNames.map((name, i) => normalizeDocLocation({
        location_id: slugId(name, `location_${i + 1}`),
        name,
        description: `sacred ${name}, Himalayan divine realm at dawn`,
        lighting: "soft golden divine light with gentle mist",
        architecture: "ancient stone temple, carved pillars, oil lamps",
        environment: "snow peaks, clouds, river, forest",
        time_period: "timeless mythological age",
        visual_rules: ["no modern objects", "no electric lights", "no concrete buildings"],
      }, i))
    : [
        normalizeDocLocation({ location_id: "mount_kailash", name: "Mount Kailash", description: "sacred snow peak of Mount Kailash at dawn, clouds circling the summit", lighting: "soft golden divine light", architecture: "natural rock shrine, ancient stone altar", environment: "snow peaks, drifting clouds, silence", time_period: "timeless mythological age", visual_rules: ["no modern objects"] }, 0),
        normalizeDocLocation({ location_id: "kailash_cave", name: "Kailash Cave", description: "serene meditation cave with oil lamps", lighting: "warm lamp glow against cool stone", architecture: "rock-cut cave shrine", environment: "still air, flower petals, incense smoke", time_period: "timeless mythological age", visual_rules: ["no modern objects"] }, 1),
      ];
  const mainChar = characters[0];
  const mainLoc = locations[0];
  const chapters = [];
  let remaining = total;
  for (let ci = 0; ci < nChapters; ci++) {
    const isLast = ci === nChapters - 1;
    const cDur = isLast ? remaining : Math.round(perChapter);
    remaining -= cDur;
    const nSeq = Math.min(4, Math.max(2, Math.round(cDur / 60)));
    const seqDur = Math.floor(cDur / nSeq);
    const sequences = [];
    let seqRem = cDur;
    for (let si = 0; si < nSeq; si++) {
      const last = si === nSeq - 1;
      const qDur = last ? seqRem : seqDur;
      seqRem -= qDur;
      const pacing = HEURISTIC_PACING[Math.min(HEURISTIC_PACING.length - 1, ci)] || "EXPLANATION";
      const purpose = HEURISTIC_SEQ_PURPOSES[si % HEURISTIC_SEQ_PURPOSES.length];
      const narration =
        `${topic} — ${HEURISTIC_CHAPTER_TITLES[ci % HEURISTIC_CHAPTER_TITLES.length]}। ` +
        `यह ${purpose} खंड है, जिसमें दिव्य स्वरूप, लीला और आध्यात्मिक अर्थ को शांत, भक्तिमय वाणी में प्रस्तुत किया गया है।`;
      // Shots: 6–15s each, avg ~12s, count driven by sequence duration.
      const nShots = Math.min(12, Math.max(2, Math.round(qDur / 12)));
      const shotDur = Math.max(6, Math.min(15, Math.round(qDur / nShots)));
      const shots = [];
      for (let hi = 0; hi < nShots; hi++) {
        const shotType = HEURISTIC_SHOT_TYPES[(hi + si + ci) % HEURISTIC_SHOT_TYPES.length];
        const move = HEURISTIC_MOVES[(hi + ci) % HEURISTIC_MOVES.length];
        const line = `${narration} (भाग ${hi + 1})`;
        const flux = withDevotionalRealism([
          b.visualStyle,
          mainChar.identity_prompt,
          `location: ${mainLoc.description || mainLoc.name}`,
          `shot: ${shotType}, ${move}, ${pacing.toLowerCase()} moment of ${topic}`,
          `lighting: ${mainLoc.lighting || "soft divine light"}`,
          `rules: no modern objects, consistent face, consistent costume, ${b.tone}`,
        ].filter(Boolean).join(", "));
        const ltx = `gentle ${move.toLowerCase()} motion, clouds drifting, lamp flames flickering, subtle divine glow pulsing; keep the exact character, face, clothing, colors, lighting and background from the input image — animate natural motion only`;
        shots.push(normalizeDocShot({
          title: `${HEURISTIC_CHAPTER_TITLES[ci % HEURISTIC_CHAPTER_TITLES.length]} — shot ${hi + 1}`,
          duration_seconds: shotDur,
          narration_lines: [line],
          visual_type: hi === 0 ? "establishing" : "character",
          characters: [mainChar.character_id],
          location: mainLoc.location_id,
          flux_prompt: flux,
          ltx_prompt: ltx,
          camera: { shot_type: shotType, angle: hi % 3 === 0 ? "Low Angle" : "Eye Level", movement: move },
          motion: ltx,
          lighting: mainLoc.lighting,
          pacing,
          audio: { music: true, sfx: hi % 4 === 3, sfx_kind: hi % 4 === 3 ? "temple bells" : "" },
        }, ci + 1, si + 1, hi + 1, 0, shotDur));
      }
      sequences.push({
        sequence_id: `C${String(ci + 1).padStart(2, "0")}-S${String(si + 1).padStart(2, "0")}`,
        chapter: ci + 1,
        seq: si + 1,
        title: `${HEURISTIC_CHAPTER_TITLES[ci % HEURISTIC_CHAPTER_TITLES.length]} — ${purpose}`,
        purpose,
        narration,
        duration_seconds: shots.reduce((a, s) => a + s.duration_seconds, 0) || qDur,
        visual_goal: `cinematic ${purpose} progression of ${topic}`,
        pacing,
        shots,
      });
    }
    chapters.push({
      chapter_number: ci + 1,
      title: HEURISTIC_CHAPTER_TITLES[ci % HEURISTIC_CHAPTER_TITLES.length],
      purpose: `Documentary chapter ${ci + 1} of ${topic}`,
      target_duration_seconds: sequences.reduce((a, q) => a + q.duration_seconds, 0) || cDur,
      sequences,
    });
  }
  reindexBoardShots(chapters);
  const musicBeds = [
    { bed_id: "opening_theme", mood: "opening", duration_seconds: Math.min(300, Math.round(total * 0.15)), description: "opening devotional theme, temple bells over soft drone" },
    { bed_id: "mystical_ambience", mood: "mystical", duration_seconds: Math.min(300, Math.round(total * 0.25)), description: "mystical ambience for origin and symbolism chapters" },
    { bed_id: "climax", mood: "climax", duration_seconds: Math.min(300, Math.round(total * 0.15)), description: "powerful divine climax bed" },
    { bed_id: "peaceful_ending", mood: "peaceful", duration_seconds: Math.min(300, Math.round(total * 0.15)), description: "peaceful ending bed under the concluding narration" },
  ];
  return { chapters, characters, locations, musicBeds };
}

// ---- Board -> existing scenario config (approve handoff) ----
// Flattens chapters/sequences/shots into pipeline beats; narration_lines map
// to per-beat Hindi voice via the existing dialogue/TTS path (single-speaker
// narration beats keep the whole-beat path; beats with speaker tags keep
// multi-speaker segmentation downstream).
export function boardToScenario(board) {
  const brief = board.brief || {};
  const lock = str(brief.visualStyle || DEFAULT_DOC_BRIEF.visualStyle);
  const devotional = isDevotionalBrief(brief);
  const chars = arr(board.characters);
  const charById = new Map(chars.map((c) => [c.character_id, c]));
  const main = chars[0] || null;
  const locs = arr(board.locations);
  const beats = [];
  for (const c of arr(board.chapters)) {
    for (const q of arr(c.sequences)) {
      for (const s of arr(q.shots)) {
        const slug = str(s.title || `shot_${s.global_index}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || `shot_${s.global_index}`;
        let image = str(s.flux_prompt);
        // Enforce continuity server-side: character identity + location + lock.
        for (const cid of arr(s.characters)) {
          const ch = charById.get(cid);
          if (!ch) continue;
          const ident = ch.identity_prompt || ch.name;
          const probe = String(ident).slice(0, 24).toLowerCase();
          if (probe && !image.toLowerCase().includes(probe)) image = image ? `${image}, ${ident}` : String(ident);
        }
        if (!image.toLowerCase().includes(lock.slice(0, 24).toLowerCase())) image = image ? `${image}, ${lock}` : lock;
        // Devotional realism: every image must carry the 8k photorealism
        // lock (repairs old boards + forgetful LLM batches on re-approve).
        if (devotional) image = withDevotionalRealism(image);
        let motion = str(s.ltx_prompt || s.motion) ||
          "Keep the exact character, face, clothing, colors, lighting and background from the input image — animate natural motion only";
        if (!/animate natural motion only/i.test(motion)) {
          motion = `${motion}, Keep the exact character, face, clothing, colors, lighting and background from the input image — animate natural motion only`;
        }
        // Narration lines become dialogue lines on a dedicated narrator
        // speaker so the existing TTS/segmentation path voices them.
        const dialogue = arr(s.narration_lines).map((line) => ({ speaker: "narrator", line: str(line) })).filter((d) => d.line);
        beats.push({
          title: `c${String(s.chapter).padStart(2, "0")}_s${String(s.sequence).padStart(2, "0")}_${slug}`.slice(0, 80),
          image,
          motion,
          duration: Number(s.duration_seconds) || 10,
          dialogue,
        });
      }
    }
  }
  let referencePrompt = [
    main ? main.identity_prompt || main.name : null,
    locs[0] ? locs[0].description || locs[0].identity_prompt || locs[0].name : null,
    lock,
  ].filter(Boolean).join(", ");
  if (devotional) referencePrompt = withDevotionalRealism(referencePrompt);
  const voices = {};
  for (const ch of chars) {
    if (ch.voice) voices[ch.character_id] = ch.voice;
  }
  return {
    description: `${str(brief.title)} — ${str(brief.topic)}`.slice(0, 500),
    duration: 10,
    referencePrompt,
    sequence: beats,
    tts: { defaultVoice: str(brief.narrationVoice) || "hi-IN-MadhurNeural", voices },
    // Flux quality: devotional boards render at higher steps for fine
    // skin/fabric/jewelry detail (honored by character_sequence*.mjs).
    ...(devotional ? { fluxSteps: DEVOTIONAL_FLUX_STEPS, quality: "devotional-ultra-realistic" } : {}),
    // Connected movie: devotional docs (Shiv/Ram/Krishna) chain every clip
    // after beat 1 from the previous clip's last frame (honored by
    // runSequence via cfg.chainContinuity, overridable per-run with --chain).
    // Non-devotional docs keep independent keyframe starts (hard cuts).
    ...(devotional ? { chainContinuity: true } : {}),
  };
}

// ---- Timeline ----
export function buildTimeline(board) {
  const chapters = arr(board.chapters).map((c) => {
    const sequences = arr(c.sequences).map((q) => {
      const shots = arr(q.shots).map((s) => ({
        shot_id: s.shot_id,
        global_index: s.global_index,
        title: s.title,
        duration_seconds: s.duration_seconds,
        status: s.status || "WAITING",
        approved: !!s.approved,
      }));
      return {
        sequence_id: q.sequence_id,
        title: q.title,
        duration_seconds: shots.reduce((a, s) => a + s.duration_seconds, 0),
        shots,
      };
    });
    return {
      chapter_number: c.chapter_number,
      title: c.title,
      duration_seconds: sequences.reduce((a, q) => a + q.duration_seconds, 0),
      sequences,
    };
  });
  const total = chapters.reduce((a, c) => a + c.duration_seconds, 0);
  let cursor = 0;
  for (const c of chapters) { c.start_seconds = cursor; cursor += c.duration_seconds; c.end_seconds = cursor; }
  return {
    title: (board.brief && board.brief.title) || board.id || "documentary",
    total_seconds: total,
    target_seconds: (board.brief && board.brief.targetSeconds) || total,
    chapters,
  };
}

// ---- Subtitles (SRT) from narration timing ----
function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(x, 3)}`;
}

export function subtitlesFromBoard(board) {
  const cues = [];
  let t = 0;
  for (const c of arr(board.chapters)) {
    for (const q of arr(c.sequences)) {
      for (const s of arr(q.shots)) {
        const lines = arr(s.narration_lines);
        if (!lines.length) { t += Number(s.duration_seconds) || 0; continue; }
        const per = (Number(s.duration_seconds) || 10) / lines.length;
        lines.forEach((line, i) => {
          cues.push({ start: t + i * per, end: t + (i + 1) * per, text: str(line) });
        });
        t += Number(s.duration_seconds) || 0;
      }
    }
  }
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`).join("\n\n") + (cues.length ? "\n" : "");
}

// ---- Export manifest (uses existing storage conventions) ----
export function buildExportManifest(board, folder) {
  const f = str(folder || (board && board.scenarioName) || "documentary");
  const prefix = f.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "documentary";
  const tl = buildTimeline(board);
  return {
    documentary_final: `${prefix}_final.mp4`,
    chapters: tl.chapters.map((c) => `chapter_${String(c.chapter_number).padStart(2, "0")}.mp4`),
    narration_audio: "narration.wav",
    music_dir: "music/",
    subtitles: "subtitles.srt",
    metadata: "documentary.json",
    total_seconds: tl.total_seconds,
  };
}

// ---- Dependency invalidation (pure) ----
// narrationChanged -> shot timing/audio stale; characterRefChanged(id) ->
// affected images+videos stale. Returns invalidated shot_ids.
export function invalidatedByNarration(board, chapterNo = null) {
  const out = [];
  for (const c of arr(board.chapters)) {
    if (chapterNo != null && c.chapter_number !== chapterNo) continue;
    for (const q of arr(c.sequences)) for (const s of arr(q.shots)) out.push(s.shot_id);
  }
  return out;
}

export function invalidatedByCharacter(board, characterId) {
  const out = [];
  for (const c of arr(board.chapters)) {
    for (const q of arr(c.sequences)) {
      for (const s of arr(q.shots)) {
        if (arr(s.characters).includes(characterId)) out.push(s.shot_id);
      }
    }
  }
  return out;
}

export function boardStats(board) {
  const shots = [];
  for (const c of arr(board.chapters)) for (const q of arr(c.sequences)) for (const s of arr(q.shots)) shots.push(s);
  const byStatus = {};
  for (const s of shots) { const k = s.status || "WAITING"; byStatus[k] = (byStatus[k] || 0) + 1; }
  return {
    chapters: arr(board.chapters).length,
    sequences: arr(board.chapters).reduce((a, c) => a + arr(c.sequences).length, 0),
    shots: shots.length,
    approved: shots.filter((s) => s.approved).length,
    byStatus,
    narrationSeconds: boardNarrationSeconds(board),
  };
}
