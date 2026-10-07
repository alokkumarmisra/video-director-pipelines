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
// Planned shot window: 3–15s (3–5s quick beats / dialogue exchanges,
// 6–15s default). The normalizer still tolerates up to the hard max so
// legacy boards with long shots keep working.
export const DOC_SHOT_MIN_SECONDS = 3;
export const DOC_SHOT_MAX_SECONDS = 15;
export const DOC_SHOT_HARD_MAX_SECONDS = 60;
// Dialogue-driven timing: every shot duration derives from its spoken lines
// (each line at ~2.17 words/sec) plus this gap between consecutive lines.
// It MATCHES the synthesis seam: TTS stitches lines with 0.35s of silence
// (lib/tts.mjs) and planDialogueTiming windows them at SEGMENT_PAUSE=0.35
// (lib/dialogue_pipeline.mjs) — so plan totals, subtitles and the actual
// final cut stay in sync instead of drifting 0.15s per gap over the film.
// Plans, scenes and shots all bottom out at dialogue length + gaps —
// generation (TTS/lip-sync) absorbs the same layout downstream.
export const DOC_LINE_GAP_SECONDS = 0.35;

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
  "ultra photorealistic, highly detailed 8k uhd cinematic film still, sharp focus, intricate details, natural skin texture, detailed expressive eyes, lifelike divine glow, volumetric lighting, rich colors, professional devotional cinematography, no cartoon, no painting, no illustration, no distortion, no distorted faces, no deformed faces, no extra limbs, no missing limbs, no blur, no low quality, no watermark";

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
// Planned shots are 3–15s (avg ~12s for long docs: 20min->~100, 25min->~125,
// 30min->~150); quicker 3–5s beats when dialogue/exchanges need it.
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

// Topic autopopulation (Documentary-only): the topic is never typed — it is
// derived from the pasted story/poem (first meaningful line, cleaned of
// markdown/list markers, capped at 120 chars). Falls back to the title;
// validateDocBrief keeps title as the final fallback.
export function heuristicTopicText(sourceMaterial, title) {
  const first = str(sourceMaterial).split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
  const clean = first.replace(/^[#*>•\-–—\d.)\s]+/, "").trim().slice(0, 120);
  return clean || str(title).trim().slice(0, 120);
}

// Duration auto-analysis (Documentary-only): the target duration is never
// typed — it is estimated from the raw source text (words drive narration at
// ~2.17 wps + a per-line pause + base pad), clamped to 1–60 min and rounded
// to 5s. Empty source falls back to the 25-minute default.
export function heuristicEstimateDuration(input) {
  const b = input && typeof input === "object" ? input : {};
  const raw = [b.sourceMaterial || b.story, b.topic, b.title].filter((x) => str(x).trim()).join("\n");
  const words = raw.split(/\s+/).filter(Boolean).length;
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean).length;
  if (!words) return DEFAULT_DOC_BRIEF.targetMinutes * 60;
  const secs = 60 + words * 0.9 + Math.max(0, lines - 1) * 2;
  return Math.round(Math.min(3600, Math.max(60, secs)) / 5) * 5;
}

// ---- Brief auto-detection (Documentary-only) ----
// The brief form only asks for title / topic / source material (+ duration /
// instructions). Everything else (tone, audience, visual style, narration,
// music, source type, language, characters, events, locations) is detected
// automatically — LLM on demand ("Auto-detect" button), heuristic instantly
// at create time for fields left on Auto. Manual typing always wins.

export const DOC_BRIEF_AUTO_FIELDS = [
  "language", "tone", "audience", "visualStyle", "narrationStyle",
  "narrationVoice", "musicStyle", "sourceType", "characters", "events", "locations",
];

const DOC_VOICES = ["hi-IN-MadhurNeural", "hi-IN-SwaraNeural"];
const DOC_LANGUAGES = ["Hindi", "English", "Hinglish"];

export function buildDocBriefDetectPrompt({ title, topic, sourceMaterial }) {
  const raw = [title, topic, sourceMaterial].filter((x) => str(x).trim()).join("\n\n") || "(no material)";
  return [
    `TASK: infer a documentary brief from the title/topic/source below. Return JSON ONLY, no markdown fences:`,
    `{ "language": "Hindi|English|Hinglish", "tone": "...", "audience": "...", "visualStyle": "...", "narrationStyle": "...",`,
    `"narrationVoice": "hi-IN-MadhurNeural|hi-IN-SwaraNeural", "musicStyle": "...", "sourceType": "traditional|scriptural|historical|user_provided|creative|mixed",`,
    `"targetSeconds": 300, "topic": "one-line topic derived from the material", "characters": "comma-separated names", "events": "semicolon-separated key events", "locations": "comma-separated places" }`,
  `Rules: detect from the text (Hindi/Devanagari -> Hindi; devotional figures -> devotional tone/audience/visuals/music; scripture/verse cues -> scriptural; history/king/empire cues -> historical); targetSeconds ~= narration length of the material at ~130 words/min (60-3600); characters/events/locations only when named or clearly implied, else "".`,
    ``,
    `TITLE: ${str(title).slice(0, 160)}`,
    `TOPIC: ${str(topic).slice(0, 500)}`,
    `SOURCE MATERIAL:`,
    String(sourceMaterial || "").slice(0, 6000),
    `_raw: ${str(raw).length}`,
  ].join("\n");
}

export function normalizeDocDetectedBrief(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const clean = (x, n) => str(x).trim().slice(0, n);
  const lang = clean(o.language, 20);
  const voice = clean(o.narrationVoice, 40);
  const st = clean(o.sourceType, 20).toLowerCase();
  const secs = Math.round(Number(o.targetSeconds) || 0);
  return {
    topic: clean(o.topic, 500),
    language: DOC_LANGUAGES.find((l) => l.toLowerCase() === lang.toLowerCase()) || "",
    targetSeconds: secs >= 60 && secs <= 3600 ? Math.round(secs / 5) * 5 : 0,
    tone: clean(o.tone, 120),
    audience: clean(o.audience, 120),
    visualStyle: clean(o.visualStyle, 200),
    narrationStyle: clean(o.narrationStyle, 120),
    narrationVoice: DOC_VOICES.includes(voice) ? voice : "",
    musicStyle: clean(o.musicStyle, 160),
    sourceType: DOC_SOURCE_TYPES.includes(st) ? st : "",
    characters: clean(o.characters, 2000),
    events: clean(o.events, 2000),
    locations: clean(o.locations, 2000),
  };
}

const DOC_DEITY_GAZETTEER = [
  ["shiv", "Shiva"], ["shiva", "Shiva"], ["mahadev", "Mahadev"], ["shankar", "Shankar"], ["bholenath", "Bholenath"],
  ["parvati", "Parvati"], ["gauri", "Gauri"], ["durga", "Durga"], ["kali", "Kali"], ["lakshmi", "Lakshmi"],
  ["saraswati", "Saraswati"], ["vishnu", "Vishnu"], ["krishna", "Krishna"], ["radha", "Radha"],
  ["ram", "Ram"], ["sita", "Sita"], ["hanuman", "Hanuman"], ["ganesh", "Ganesh"], ["ganpati", "Ganpati"],
  ["brahma", "Brahma"], ["nandi", "Nandi"], ["narada", "Narada"], ["narad", "Narad"],
  ["arjun", "Arjun"], ["yudhishthir", "Yudhishthir"], ["bhishma", "Bhishma"], ["draupadi", "Draupadi"],
  ["ravan", "Ravan"], ["kansa", "Kansa"], ["prahlad", "Prahlad"], ["dhruv", "Dhruv"], ["meera", "Meera"],
  // Devanagari aliases (same identities — the source is usually Hindi).
  ["शिव", "Shiva"], ["महादेव", "Mahadev"], ["शंकर", "Shankar"], ["भोलेनाथ", "Bholenath"],
  ["पार्वती", "Parvati"], ["गौरी", "Gauri"], ["दुर्गा", "Durga"], ["काली", "Kali"], ["लक्ष्मी", "Lakshmi"],
  ["सरस्वती", "Saraswati"], ["विष्णु", "Vishnu"], ["कृष्ण", "Krishna"], ["राधा", "Radha"],
  ["राम", "Ram"], ["सीता", "Sita"], ["हनुमान", "Hanuman"], ["गणेश", "Ganesh"], ["गणपति", "Ganpati"],
  ["ब्रह्मा", "Brahma"], ["नंदी", "Nandi"], ["नारद", "Narad"],
  ["अर्जुन", "Arjun"], ["युधिष्ठिर", "Yudhishthir"], ["भीष्म", "Bhishma"], ["द्रौपदी", "Draupadi"],
  ["रावण", "Ravan"], ["कंस", "Kansa"], ["प्रह्लाद", "Prahlad"], ["ध्रुव", "Dhruv"], ["मीरा", "Meera"],
];
const DOC_PLACE_GAZETTEER = [
  ["kailash", "Mount Kailash"], ["himalaya", "Himalayas"], ["himalayas", "Himalayas"], ["himachal", "Himalayas"],
  ["ayodhya", "Ayodhya"], ["mathura", "Mathura"], ["kashi", "Kashi"], ["varanasi", "Varanasi"], ["banaras", "Varanasi"],
  ["ganga", "River Ganga"], ["yamuna", "River Yamuna"], ["sarayu", "River Sarayu"],
  ["temple", "temple"], ["mandir", "temple"], ["cave", "cave"], ["gufa", "cave"],
  ["forest", "forest"], ["van", "forest"], ["jungle", "forest"], ["ocean", "ocean"], ["samudra", "ocean"], ["sagar", "ocean"],
  ["kurukshetra", "Kurukshetra"], ["dwarka", "Dwarka"], ["chitrakoot", "Chitrakoot"], ["prayag", "Prayag"],
  ["rishikesh", "Rishikesh"], ["haridwar", "Haridwar"], ["kedarnath", "Kedarnath"], ["somnath", "Somnath"],
  // Devanagari aliases.
  ["कैलाश", "Mount Kailash"], ["हिमालय", "Himalayas"], ["हिमाचल", "Himalayas"],
  ["अयोध्या", "Ayodhya"], ["मथुरा", "Mathura"], ["काशी", "Kashi"], ["वाराणसी", "Varanasi"], ["बनारस", "Varanasi"],
  ["गंगा", "River Ganga"], ["यमुना", "River Yamuna"], ["सरयू", "River Sarayu"],
  ["मंदिर", "temple"], ["गुफा", "cave"],
  ["जंगल", "forest"], ["सागर", "ocean"], ["समुद्र", "ocean"],
  ["कुरुक्षेत्र", "Kurukshetra"], ["द्वारका", "Dwarka"], ["चित्रकूट", "Chitrakoot"], ["प्रयाग", "Prayag"],
  ["ऋषिकेश", "Rishikesh"], ["हरिद्वार", "Haridwar"], ["केदारनाथ", "Kedarnath"], ["सोमनाथ", "Somnath"],
];
const DOC_HISTORICAL_CUES = ["history", "historical", "century", "king", "queen", "emperor", "empire", "kingdom", "war", "battle", "dynasty", "ancient india", "इतिहास", "राजा", "साम्राज्य", "युद्ध"];
const DOC_SCRIPTURAL_CUES = ["veda", "vedic", "puran", "puranic", "upanishad", "shastra", "shastra", "scripture", "verse", "shloka", "sloka", "mantra", "stotra", "वेद", "पुराण", "शास्त्र", "श्लोक", "मंत्र"];
const DOC_KIDS_CUES = ["kids", "children", "cartoon", "fun", "toddler", "बच्चों", "बाल"];
const DOC_NATURE_CUES = ["nature", "wildlife", "forest life", "river journey", "mountain", "animals", "birds", "प्रकृति", "वन्य"];
const DOC_HINGLISH_CUES = ["hai", "hain", "kya", "kaise", "kyun", "bahut", "hamara", "tumhara", "bhakti", "katha", "leela"];
const DOC_COMMON_CAPITALIZED = new Set(["The", "And", "With", "From", "Lord", "Shri", "Sri", "Story", "Part", "Chapter", "Episode", "Documentary", "Hindi", "English", "India", "Bharat"]);
// Capitalized speech/action words that are never character names.
const DOC_NON_NAME_WORDS = new Set(["behold", "said", "says", "say", "told", "tell", "asked", "ask", "cried", "cry", "laughed", "laugh", "sang", "sing", "danced", "spoke", "speak", "replied", "reply", "answered", "answer", "called", "call"]);
// Common Hindi function words that are never character names (Devanagari scan).
const DOC_HINDI_STOPWORDS = new Set(["और", "में", "से", "को", "ने", "पर", "है", "हैं", "था", "थी", "थे", "यह", "वह", "ये", "वे", "जो", "तो", "भी", "का", "की", "के", "तक", "साथ", "लिए", "अपने", "अपनी", "अपना", "हमारा", "हमारी", "हमारे", "तुम्हारा", "तुम्हारी", "तुम्हारे", "मेरा", "मेरी", "मेरे", "तेरा", "तेरी", "तेरे", "आप", "आपका", "आपकी", "आपके", "आपको", "आपने", "उसने", "उसकी", "उसका", "इसने", "इसकी", "इसका", "जब", "तब", "फिर", "बहुत", "सब", "कुछ", "कोई", "क्या", "कैसे", "क्यों", "जहाँ", "वहाँ", "यहाँ", "लेकिन", "किंतु", "परंतु", "अतः", "इसलिए", "कथा", "कहानी", "अध्याय", "भाग", "दिव्य", "परम", "घर", "श्रीमान", "महोदय"]);

// Shared name extractor: deity gazetteer + capitalized Latin phrases +
// Devanagari name phrases (2+ letter words, stopwords skipped). Returns up
// to `cap` names with brief-list order preserved (caller merges sources).
// Devanagari verb auxiliaries/particles that never occur in names (checked
// per token — kills "छा गया", "डमरू बजा" style fragments). Kept separate
// from DOC_ACTION_VERBS (which drives event detection, where broad matching
// is wanted) so action recall stays high.
const DOC_DEVANAGARI_NON_NAMES = new Set(["गया", "गयी", "गये", "गए", "जाता", "जाती", "जाते",
  "बजा", "बजाया", "बजाते", "हुआ", "हुई", "हुए", "होता", "होती", "होते", "हो",
  "किया", "किए", "की", "लिया", "दिया", "रहा", "रही", "रहे",
  "वाला", "वाली", "वाले", "करता", "करती", "करते", "करे", "है", "हैं"]);
// Trailing speech verbs stripped from speaker labels ("पार्वती बोलीं" -> "पार्वती").
const DOC_SPEECH_VERBS_TAIL = new Set(["बोले", "बोलीं", "बोली", "बोला", "कहा", "कही", "कहे", "पूछा", "पूछी", "पूछे", "said", "says", "say", "told", "tell", "asked", "ask", "cried", "cry", "replied", "reply", "answered", "answer", "spoke", "speak"]);

/** Normalize a raw speaker label: honorifics off, "X ने …" -> X, speech verbs off. */
export function cleanDocSpeaker(raw) {
  const s0 = str(raw).replace(/^(श्री|श्रीमती|भगवान|देवी|lord|shri|sri)\s+/i, "").trim();
  const s = s0.split(/\s+ने\s+/)[0].trim();
  const words = s.split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const tail = words[words.length - 1].replace(/[।.,!?;:]+$/g, "");
    if (DOC_SPEECH_VERBS_TAIL.has(tail) || DOC_SPEECH_VERBS_TAIL.has(tail.toLowerCase())) words.pop();
    else break;
  }
  return words.join(" ").trim();
}
export function extractDocNames(text, cap = 8) {
  const t = str(text);
  const lower = ` ${t.toLowerCase()} `;
  const found = [];
  for (const [kw, name] of DOC_DEITY_GAZETTEER) {
    if (lower.includes(kw) && !found.includes(name)) found.push(name);
  }
  const placeWords = new Set(DOC_PLACE_GAZETTEER.flatMap(([, name]) => name.toLowerCase().split(/[\s-]+/)));
  const verbWords = new Set(DOC_ACTION_VERBS.map((v) => str(v).toLowerCase()).filter(Boolean));
  for (const m of t.match(/[A-Z][a-z]+(?:[^\S\n]+[A-Z][a-z]+){0,2}/g) || []) {
    const name = m.trim();
    const words = name.split(/[^\S\n]+/);
    const low = words.map((w) => w.toLowerCase());
    if (name.length > 2 && !words.some((w) => DOC_COMMON_CAPITALIZED.has(w)) &&
        !low.some((w) => placeWords.has(w) || verbWords.has(w) || DOC_NON_NAME_WORDS.has(w)) &&
        !found.includes(name) && found.length < cap) {
      found.push(name);
    }
  }
  // Devanagari names: gazetteer hits are in `found` already. Any other phrase
  // counts as a name only when it SPEAKS (colon-prefix / reported-speech
  // subject on some line) or REPEATS (>=2 mentions) — single-occurrence
  // sentence fragments ("तुम सुंदर हो") are never names. Never invents.
  const devSpeakers = new Set();
  for (const line of t.split("\n")) {
    const cm = line.match(/^\s*([^:]{1,60}?)\s*:\s*.{3,400}$/);
    if (cm) {
      const subj = cleanDocSpeaker(cm[1]);
      if (subj) devSpeakers.add(subj);
    }
    const rm = line.match(/^\s*(.{2,60}?)\s+ने\s+(?:[^:।!?]{1,80}?\s+)?(?:कहा|कही|बोले|बोली|पूछा|पूछी|उत्तर\s*दिया)\b/);
    if (rm) {
      const subj = cleanDocSpeaker(rm[1]);
      if (subj && !DOC_HINDI_STOPWORDS.has(subj)) devSpeakers.add(subj);
    }
  }
  // Repeat gate counts UNIQUE lines only: topic/events often restate a source
  // sentence, and one sentence pasted in two fields is not two mentions.
  const uniqLower = ` ${[...new Set(t.split("\n"))].join("\n").toLowerCase()} `;
  const devCountOf = (needle) => uniqLower.split(needle.toLowerCase()).length - 1;
  // Gazetteer tokens in ANY script (e.g. कैलाश -> Mount Kailash): a phrase
  // containing one is covered by its canonical entry — never a new name.
  const gazetteerTokens = new Set(
    [...DOC_DEITY_GAZETTEER, ...DOC_PLACE_GAZETTEER]
      .flatMap(([kw]) => str(kw).toLowerCase().split(/[\s-]+/)).filter(Boolean));
  for (const m of t.match(/[\u0900-\u097F]{2,}(?:[^\S\n]+[\u0900-\u097F]{2,}){0,2}/g) || []) {
    const name = m.trim().replace(/[।.,!?;:]+$/g, "");
    if (name.length < 3 || found.includes(name) || found.length >= cap) continue;
    const words = name.split(/[^\S\n]+/);
    const low = words.map((w) => w.toLowerCase());
    if (words.some((w) => DOC_HINDI_STOPWORDS.has(w))) continue;
    if (low.some((w) => placeWords.has(w) || verbWords.has(w))) continue;
    if (words.some((w) => DOC_DEVANAGARI_NON_NAMES.has(w))) continue;
    // Covered by a canonical gazetteer identity in any script (e.g.
    // "महादेव" -> Mahadev, "कैलाश हमारा घर" holds कैलाश -> Mount Kailash):
    // never duplicate it as a new name.
    if (low.some((w) => gazetteerTokens.has(w))) continue;
    // Exact speaker hit, speaker-substring hit (colon "X ने Y से कहा" form),
    // or repeated mention — otherwise a fragment, skip it.
    const speaks = devSpeakers.has(name) || [...devSpeakers].some((sp) => sp.includes(name) || name.includes(sp));
    if (!speaks && devCountOf(name) < 2) continue;
    found.push(name);
  }
  return found.slice(0, cap);
}

// Quoted-speech dialogue scan: "…" "…" '…' "..." — speaker is a known name
// on the same line OUTSIDE the quotes (never the quoted text itself), else "".
export function extractDocQuotedDialogues(raw, knownNames = [], cap = 40) {
  const out = [];
  const names = arr(knownNames).map((x) => str(x).trim()).filter(Boolean);
  for (const line of str(raw).split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (out.length >= cap) break;
    // Skip lines already in "Speaker: line" form (handled separately).
    if (/^[^:]{1,40}:\s*.{3,400}$/.test(line)) continue;
    for (const m of line.match(/["“”'‘’]([^"“”'‘’]{3,400})["“”'‘’]/g) || []) {
      const spoken = m.slice(1, -1).trim();
      if (spoken.length < 3 || out.length >= cap) continue;
      const outside = line.replace(/["“”'‘’][^"“”'‘’]{3,400}["“”'‘’]/g, " ").toLowerCase();
      const hit = names.find((n) => n && outside.includes(n.toLowerCase()));
      out.push({ speaker: hit || "", line: spoken, context: "" });
    }
  }
  return out;
}

export function heuristicDetectBrief(input) {
  const b = input && typeof input === "object" ? input : {};
  const title = str(b.title);
  const topic = str(b.topic || b.title);
  const source = str(b.sourceMaterial || b.story || "");
  const text = `${title}\n${topic}\n${source}`;
  const lower = ` ${text.toLowerCase()} `;
  const has = (cues) => cues.some((k) => lower.includes(k.toLowerCase()));
  const devotional = /devotion|devotional|bhakti|shiv|shiva|mahadev|vishnu|krishna|ram\b|hanuman|durga|lakshmi|parvati|ganesh|mytholog|leela|katha|bhajan|mandir|temple|divine|kailash|tandav|samudra/.test(lower);
  const historical = has(DOC_HISTORICAL_CUES);
  const scriptural = has(DOC_SCRIPTURAL_CUES);
  const kids = has(DOC_KIDS_CUES);
  // Language: Devanagari share decides Hindi; Hindi words in Latin -> Hinglish.
  const devCount = (text.match(/[\u0900-\u097F]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  const latinWords = lower.split(/[^a-z]+/).filter(Boolean);
  const hinglishHits = DOC_HINGLISH_CUES.filter((w) => latinWords.includes(w)).length;
  const language = devCount > Math.max(3, latinCount * 0.15) ? "Hindi" : hinglishHits >= 2 ? "Hinglish" : latinCount > 0 ? "English" : DEFAULT_DOC_BRIEF.language;
  const tone = devotional
    ? "Spiritual + cinematic + informative"
    : historical ? "Epic + informative + cinematic" : kids ? "Playful + simple + warm" : "Cinematic + informative";
  const audience = devotional
    ? "Family devotional audience"
    : kids ? "Kids family audience" : historical ? "History-loving family audience" : "General family audience";
  const visualStyle = devotional
    ? DEFAULT_DOC_BRIEF.visualStyle
    : historical ? "Cinematic historical documentary, photorealistic ancient India, 16:9"
    : DOC_NATURE_CUES.some((k) => lower.includes(k)) ? "Cinematic nature documentary, photorealistic wilderness India, 16:9"
    : kids ? "Colorful 3D cartoon documentary for kids, 16:9"
    : "Cinematic documentary, photorealistic India, 16:9";
  const narrationStyle = language === "Hindi" ? "Hindi documentary narration"
    : language === "Hinglish" ? "Hinglish documentary narration" : "English documentary narration";
  const musicStyle = devotional
    ? DEFAULT_DOC_BRIEF.musicStyle
    : historical ? "Epic orchestral with Indian classical textures" : kids ? "Cheerful kids background music" : "Soft cinematic ambient";
  const sourceType = scriptural ? "scriptural" : historical ? "historical" : source.trim().length >= 200 ? "user_provided" : "mixed";
  // Characters: deity gazetteer + capitalized Latin + Devanagari names
  // (shared extractor — skips common openers, verbs, places, Hindi stopwords).
  const found = extractDocNames(text, 8);
  // Locations: place gazetteer + "Mount|River|Lake X" patterns.
  const places = [];
  for (const [kw, name] of DOC_PLACE_GAZETTEER) {
    if (lower.includes(kw) && !places.includes(name)) places.push(name);
  }
  for (const m of text.match(/(?:Mount|River|Lake|Cave|Temple)\s+[A-Z][a-z]+/g) || []) {
    if (!places.includes(m) && places.length < 8) places.push(m);
  }
  // Events: sentences carrying action verbs, trimmed short.
  const events = [];
  for (const s of text.split(/[।.!?\n]+/).map((x) => x.trim()).filter((x) => x.length > 10)) {
    if (events.length >= 6) break;
    if (DOC_ACTION_VERBS.some((v) => v && s.toLowerCase().includes(v.toLowerCase()))) {
      const short = s.slice(0, 90);
      if (!events.includes(short)) events.push(short);
    }
  }
  return {
    topic: str(b.topic).trim() || heuristicTopicText(source, title),
    language, tone, audience, visualStyle, narrationStyle,
    narrationVoice: DEFAULT_DOC_BRIEF.narrationVoice,
    musicStyle, sourceType,
    targetSeconds: heuristicEstimateDuration({ title, topic, sourceMaterial: source }),
    characters: found.slice(0, 8).join(", "),
    events: events.join("; "),
    locations: places.slice(0, 8).join(", "),
  };
}

// Fill only the empty auto-fields of a raw brief body (manual typing wins).
// Used at create time so blank/Auto fields arrive detected; validateDocBrief
// stays the final fallback for anything still empty.
export function fillDocBriefAuto(body) {
  const b = body && typeof body === "object" ? { ...body } : {};
  const detected = heuristicDetectBrief(b);
  for (const k of DOC_BRIEF_AUTO_FIELDS) {
    if (!str(b[k]).trim() && str(detected[k]).trim()) b[k] = detected[k];
  }
  return b;
}

// ---- Micro time management (production-grade intra-shot timing) ----
// A shot carries ordered spoken lines: narration_lines (narrator voice) first,
// then dialogue_lines ("Speaker: line", one voice per speaker). The shot
// duration DERIVES from the dialogue: sum of per-line estimates at ~2.17
// words/sec plus a 0.35s gap between consecutive lines (same seam the TTS
// stitching and lip-sync windowing use). Per-line start/end offsets tile the
// multi-dialogue shots have deterministic timing for TTS, subtitles and
// lip-sync. Sequences sum their shots, chapters sum their sequences — the
// whole plan bottoms out at dialogue length + gaps.

/** Parse one dialogue_lines entry into { speaker, line }. Bare lines -> narrator. */
export function parseDocDialogueLine(entry) {
  const t = str(entry).trim();
  if (!t) return { speaker: "narrator", line: "" };
  const m = t.match(/^\s*([^:()]{1,40})(?:\s*\([^)]{1,40}\))?\s*:\s*(.{1,500})$/);
  if (m) {
    const speaker = m[1].trim() || "narrator";
    return { speaker, line: m[2].trim() };
  }
  return { speaker: "narrator", line: t };
}

/** Ordered spoken lines of a shot: narration first, then parsed dialogue. */
export function shotSpokenLines(shot) {
  const s = shot && typeof shot === "object" ? shot : {};
  const out = [];
  for (const line of arr(s.narration_lines ?? s.narration).map((x) => str(x)).filter(Boolean)) {
    out.push({ kind: "narration", speaker: "narrator", text: line });
  }
  for (const entry of arr(s.dialogue_lines).map((x) => str(x)).filter(Boolean).slice(0, 8)) {
    const p = parseDocDialogueLine(entry);
    if (p.line) out.push({ kind: "dialogue", speaker: p.speaker || "narrator", text: p.line });
  }
  return out;
}

/** Dialogue-driven shot length: sum of per-line estimates + gap per gap. */
export function shotSpokenSeconds(shot) {
  const lines = shotSpokenLines(shot);
  let total = 0;
  for (const l of lines) total += estimateNarrationSeconds(l.text);
  if (lines.length > 1) total += DOC_LINE_GAP_SECONDS * (lines.length - 1);
  return Math.round(total * 10) / 10;
}

/** Per-line timing tiling the shot duration exactly, gaps included
 * (line end + gap = next line start; last line ends at duration). Extra
 * slack above the dialogue floor spreads word-proportionally. */
export function shotLineTiming(shot) {
  const dur = Math.max(1, Number(shot && shot.duration_seconds) || 10);
  const lines = shotSpokenLines(shot);
  if (!lines.length) return [];
  const n = lines.length;
  let gap = n > 1 ? DOC_LINE_GAP_SECONDS : 0;
  // Degenerate case (duration shorter than the gaps alone): shrink gaps to fit.
  if (n > 1 && dur <= gap * (n - 1)) gap = Math.max(0, Math.floor(((dur * 0.2) / (n - 1)) * 10) / 10);
  const avail = Math.max(0.5 * n, dur - gap * (n - 1));
  const weights = lines.map((l) => Math.max(0.8, estimateNarrationSeconds(l.text)));
  const wTotal = weights.reduce((a, w) => a + w, 0) || 1;
  let cursor = 0;
  return lines.map((l, i) => {
    const last = i === n - 1;
    const speech = last
      ? Math.round((dur - cursor) * 10) / 10
      : Math.max(0.5, Math.round((avail * weights[i] / wTotal) * 10) / 10);
    const start = Math.round(cursor * 10) / 10;
    const end = last ? Math.round(dur * 10) / 10 : Math.round((start + speech) * 10) / 10;
    cursor = end + (last ? 0 : gap);
    if (last) cursor = dur;
    return {
      kind: l.kind, speaker: l.speaker, text: l.text,
      start: start, end: end, seconds: last ? Math.round((end - start) * 10) / 10 : speech,
    };
  });
}

/** Split a sequence narration into per-shot spoken lines (contiguous word
 * chunks). Each shot voices only its own chunk — so shot durations derive
 * from their own dialogue and the plan total matches the narration instead
 * of multiplying it by the shot count. */
export function splitNarrationForShots(narration, nShots) {
  const n = Math.max(1, Math.round(Number(nShots)) || 1);
  const words = str(narration).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return Array.from({ length: n }, () => "");
  const per = Math.ceil(words.length / n);
  const out = [];
  for (let i = 0; i < n; i++) out.push(words.slice(i * per, (i + 1) * per).join(" "));
  return out;
}

/** Resolve a dialogue speaker label to a bible character_id ("narrator" passthrough). */
export function resolveDocSpeakerId(characters, speaker) {
  const label = str(speaker).trim().toLowerCase();
  if (!label || label === "narrator" || /^(narrator|voiceover|voice over|narrat|kathavachak|kathavachak|narrator voice|सूत्रधार|कथावाचक|वाचक)$/.test(label)) return "narrator";
  const chars = arr(characters);
  for (const c of chars) {
    if (!c || typeof c !== "object") continue;
    if (str(c.character_id).trim().toLowerCase() === label) return c.character_id;
    if (str(c.name).trim().toLowerCase() === label) return c.character_id;
  }
  // Cross-script match: Devanagari/Latin aliases share one canonical name
  // (महादेव -> Mahadev), so Hindi dialogue links to the Latin bible entry.
  const cleaned = cleanDocSpeaker(speaker).toLowerCase() || label;
  for (const [kw, canonical] of DOC_DEITY_GAZETTEER) {
    if (cleaned !== kw.toLowerCase() && !cleaned.split(/\s+/).includes(kw.toLowerCase())) continue;
    const canon = canonical.toLowerCase();
    for (const c of chars) {
      if (!c || typeof c !== "object") continue;
      if (str(c.character_id).trim().toLowerCase() === canon) return c.character_id;
      if (str(c.name).trim().toLowerCase() === canon) return c.character_id;
    }
    return canonical;
  }
  return str(speaker).trim() || "narrator";
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
  const narrationLines = arr(o.narration_lines ?? o.narration).map((x) => str(x)).filter(Boolean);
  const dialogueLines = arr(o.dialogue_lines).map((x) => str(x)).filter(Boolean).slice(0, 8);
  // Planned window 3–15s; hard max keeps legacy long shots working. The
  // duration DERIVES from the dialogue: floor = sum of per-line estimates +
  // gap per gap (shotSpokenSeconds). A shorter plan is extended to fit (1
  // decimal); a longer plan keeps its lingering visuals.
  let fitted = Number.isFinite(dur)
    ? Math.min(DOC_SHOT_HARD_MAX_SECONDS, Math.max(DOC_SHOT_MIN_SECONDS, Math.round(dur * 10) / 10))
    : fallbackSeconds;
  const spoken = shotSpokenSeconds({ narration_lines: narrationLines, dialogue_lines: dialogueLines });
  if (spoken > fitted) fitted = Math.min(DOC_SHOT_HARD_MAX_SECONDS, spoken);
  return {
    shot_id: str(o.shot_id) || `${seqTag}-SH${String(n).padStart(2, "0")}`,
    global_index: Number.isInteger(o.global_index) ? o.global_index : globalIndex,
    chapter: Number(o.chapter) || chapter,
    sequence: Number(o.sequence) || seq,
    title: str(o.title, `Shot ${globalIndex}`),
    duration_seconds: fitted,
    narration_lines: narrationLines,
    // Micro-timing fields: dialogue / emotion / time / action / visual meaning
    // per shot. Populated by the LLM shot planner, editable via PUT, and read
    // by approve (voices), subtitles (cues) and timeline (per-line offsets).
    dialogue_lines: dialogueLines,
    emotion: str(o.emotion).slice(0, 120),
    time_of_day: str(o.time_of_day).slice(0, 40),
    actions: arr(o.actions).map((x) => str(x)).filter(Boolean).slice(0, 8),
    visual_meaning: str(o.visual_meaning).slice(0, 500),
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
      for (const s of arr(q.shots)) total += shotSpokenSeconds(s);
    }
  }
  return Math.round(total * 10) / 10;
}

// ---- LLM prompts (reuse the shared llama-server convention; see server.mjs) ----
export const DOCUMENTARY_DIRECTOR_SYSTEM = `You are the DOCUMENTARY DIRECTOR of Sanskriti AI Studio: director + screenwriter + visual director + continuity director + editor.
You plan long-form Hindi devotional documentaries (20-30 minutes) as structured JSON ONLY (no markdown fences, no commentary).
Rules: narration FIRST (Hindi, respectful devotional tone), then shot timing derived from narration duration (shots 6-15s, dynamic count, never a fixed number). Chapters 6-9 for full length (fewer for short tests). Each chapter has sequences; each sequence has shots. Every shot carries narration_lines + flux_prompt + ltx_prompt + camera + motion + audio flags. Character Bible BEFORE images: locked visual identities reused verbatim, never randomly redesigned. Location Bible inherited by shots. Vary shot grammar intentionally (wide/medium/close-up/extreme close-up/OTS/low/high/tracking/push-in/pull-out/pan/tilt/static) chosen by narration, never random. Pace visuals by story phase (INTRODUCTION slow, BUILDUP/EXPLANATION steady, EMOTIONAL calm, CLIMAX strong, REFLECTION/CONCLUSION peaceful). Avoid modern objects in ancient scenes, costume drift, repeated compositions, filler dialogue. Respect source_type: never present creative invention as scriptural fact.`;

export function buildDocBiblePrompt(brief, analysisCtx = "") {
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
    `"characters": [{ "character_id": "snake_case", "name": "...", "role": "main|supporting", "voice": "hi-IN-MadhurNeural|hi-IN-SwaraNeural", "visual_identity": { "face": "...", "body": "...", "skin": "...", "hair": "...", "eyes": "...", "clothing": "...", "ornaments": "...", "weapons": "..." }, "consistency_rules": ["..."] }],`,
    `"locations": [{ "location_id": "snake_case", "name": "...", "description": "...", "lighting": "...", "architecture": "...", "environment": "...", "time_period": "...", "visual_rules": ["..."] }],`,
    `"music_beds": [{ "bed_id": "snake_case", "mood": "opening|mystical|tension|revelation|emotional|climax|peaceful", "duration_seconds": 120, "description": "..." }] }`,
    `Plan ${chaptersForDuration(b.targetSeconds)} chapters covering the topic in order (intro, origin, personality, stories, symbolism, devotees, meaning, conclusion — adapt when the topic demands it). Narration must be ${b.language} and sized so chapter durations sum to ~${b.targetSeconds}s.`,
    `VOICES: narrator speaks narration in ${b.narrationVoice || "the narration voice"}; give every SPEAKING character their own "voice" (alternate hi-IN-MadhurNeural / hi-IN-SwaraNeural by gender/age, never the same voice for two speakers in one scene). Non-speaking figures may leave voice empty.`,
    str(analysisCtx).trim() ? `SOURCE ANALYSIS (ground every bible entry + beat in this — detected characters, dialogues, emotions, places/times, actions, symbols):\n${str(analysisCtx).trim().slice(0, 3000)}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function buildDocShotsPrompt({ brief, board, chapter, startGlobal = 0, analysisCtx = "" }) {
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
    `TASK 2/3 — SHOT PLAN for Chapter ${c.chapter_number} "${c.title}" (${c.target_duration_seconds}s). Break every sequence into shots of 3-15s (3-5s for quick beats and dialogue exchanges, 6-15s default; never a fixed count; total chapter ~${c.target_duration_seconds}s). DIALOGUE-DRIVEN DURATIONS: each duration_seconds = sum over its narration_lines + dialogue_lines of (words / 2.17) + ${DOC_LINE_GAP_SECONDS}s gap per gap between consecutive lines, rounded to 1 decimal (e.g. lines of 5 + 9 words -> ${(5 / 2.17).toFixed(1)} + ${(9 / 2.17).toFixed(1)} + ${DOC_LINE_GAP_SECONDS} = ${(5 / 2.17 + 9 / 2.17 + DOC_LINE_GAP_SECONDS).toFixed(1)}s). The duration must cover ALL its lines — never undersize a dialogue-heavy shot.`,
    `GLOBAL STYLE (append verbatim to every flux_prompt): ${brief.visualStyle}, ${brief.tone}${devotional ? `, ${DEVOTIONAL_REALISM_LOCK}` : ""}`,
    `CHARACTER BIBLE (paste exact identity into flux_prompt verbatim):\n${chars || "(none)"}`,
    `LOCATION BIBLE:\n${locs || "(none)"}`,
    `NARRATION VOICE: ${brief.narrationVoice}. Narration is primary AND dialogue is first-class: every spoken line in the source/analysis must appear as a "Speaker: line" entry in dialogue_lines (multiple characters per shot allowed, in spoken order, same speaker label everywhere); narration_lines stay narrator-only. Stage multi-character shots as frontal Two Shots / OTS so faces stay clear for lip-sync.`,
    `MICRO-TIMING (mandatory per shot): order lines as spoken (narration first, then dialogue in exchange order); set emotion (the beat's dominant feeling), time_of_day (dawn|morning|day|dusk|night only when stated or clearly implied), actions (who does what, actor: verb [+ object]), visual_meaning (objects/symbols carrying story significance). Every shot with 2+ spoken lines SHOULD carry dialogue_lines + emotion.`,
    devotional
      ? `PHOTOREALISM (mandatory): every flux_prompt MUST read as an ultra-detailed 8k cinematic film still — photorealistic skin with natural texture, detailed expressive eyes, intricate costume/jewelry fabric detail, volumetric divine lighting, sharp focus. NEVER cartoon, painting, illustration, 3d-render or blurry. End every flux_prompt with: ${DEVOTIONAL_REALISM_LOCK}`
      : null,
    ``,
    `SEQUENCES TO COVER (in order, global shot index continues from ${startGlobal}):`,
    seqs,
    ``,
    `Return JSON ONLY: { "chapter_number": ${c.chapter_number}, "sequences": [{ "seq": 1, "shots": [{ "title": "...", "duration_seconds": 9, "narration_lines": ["..."], "dialogue_lines": ["Speaker: line"], "emotion": "ecstasy", "time_of_day": "dusk", "actions": ["Shiva performs Tandava"], "visual_meaning": "damaru = cosmic sound of creation", "visual_type": "establishing|character|detail|environmental|symbolic", "characters": ["character_id"], "location": "location_id", "flux_prompt": "global style + character bible + location bible + shot description + camera + lighting + composition${devotional ? " + photorealism lock" : ""}", "ltx_prompt": "motion only: what moves and how", "camera": { "shot_type": "Wide Shot|Medium Shot|Close-Up|Extreme Close-Up|Over-the-Shoulder|Establishing Shot|Two Shot", "angle": "Low Angle|High Angle|Eye Level|Top Down", "movement": "Static|Pan|Tilt|Dolly In|Dolly Out|Tracking Shot|Orbit|Crane|slow cinematic push-in" }, "motion": "...", "lighting": "...", "pacing": "...", "audio": { "music": true, "sfx": false, "sfx_kind": "" } }] }] }`,
    `Vary shot grammar by narration; no repetitive compositions; no modern objects in ancient scenes. Multi-character exchanges get 3-5s shots per line-pair with dialogue_lines in order — never merge two speakers into one narration line. Respond with JSON ONLY.`,
    str(analysisCtx).trim() ? `SOURCE ANALYSIS (stage every shot from this: match narration/emotion per beat, place detected dialogues as dialogue_lines, set time_of_day + actions + visual meaning per shot):\n${str(analysisCtx).trim().slice(0, 3000)}` : null,
  ].filter((l) => l !== null).join("\n");
}

// ---- Source analysis (the RAW POEM -> understanding pipeline) ----
// Documentary-only: a single analysis pass over the raw source text
// (brief.sourceMaterial + topic + events) that produces explicit artifacts
// for story understanding, character/dialogue/narration detection, emotion
// & mood, location/time, actions and visual meaning. The bible + shot
// planners consume it as read-only context (analysisCtx) — prompts, boards
// and downstream stages are unchanged when no analysis is present.

export const DOC_ANALYSIS_STAGES = [
  "raw", // RAW POEM / source input (brief intake)
  "understanding", // Story Understanding
  "characters", // Character Detection
  "dialogue", // Dialogue Detection
  "narration", // Narration Detection
  "emotion", // Emotion & Mood Analysis
  "location", // Location / Time Detection
  "action", // Action Detection
  "visual", // Visual Meaning Extraction
  "scene", // Scene Planning (chapters/sequences)
  "shot", // Shot Planning (shots)
  "continuity", // Character Continuity
  "image", // Image Prompts (flux)
  "video", // Video Prompts (ltx/motion)
  "timeline", // Final Timeline
];

export function buildDocAnalysisPrompt(brief) {
  const b = brief || {};
  const raw = [b.sourceMaterial, b.topic, b.events].filter((x) => str(x).trim()).join("\n\n") || str(b.title);
  return [
    `TASK 0/3 — SOURCE ANALYSIS. Read the raw source text below (a poem, katha, story or topic notes for a ${str(b.language) || "Hindi"} devotional documentary "${str(b.title)}") and extract structured understanding. Return JSON ONLY, no markdown fences:`,
    `{ "understanding": { "summary": "2-4 sentences: what the story is about", "themes": ["..."], "narrative_arc": ["introduction", "..."] },`,
    `"characters_detected": [{ "name": "...", "role": "main|supporting", "mentions": 3 }],`,
    `"dialogues": [{ "speaker": "...", "line": "...", "context": "..." }],`,
    `"narrations": [{ "voice": "narrator", "text": "...", "purpose": "..." }],`,
    `"emotions": [{ "scope": "overall|character name", "emotion": "...", "mood": "...", "intensity": "low|medium|high" }],`,
    `"locations_times": [{ "location": "...", "time_of_day": "dawn|morning|day|dusk|night|unspecified", "time_period": "ancient|mythological|present|unspecified", "environment": "..." }],`,
    `"actions": [{ "actor": "...", "action": "...", "object": "...", "context": "..." }],`,
    `"visual_meanings": [{ "subject": "...", "literal": "what is seen", "symbolic_meaning": "what it signifies" }] }`,
    `Rules: detect (never invent) — every entry must trace to the source text; "dialogues" only for actual spoken lines ("Name: line" or quoted speech), otherwise []; time_of_day only when the text states or clearly implies it; visual_meanings for objects/symbols carrying story significance (weapons, animals, rivers, marks, gestures). Empty sections are [].`,
    ``,
    `RAW SOURCE TEXT:`,
    String(raw).slice(0, 6000),
  ].join("\n");
}

export function normalizeDocAnalysis(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const u = o.understanding && typeof o.understanding === "object" ? o.understanding : {};
  const clean = (x) => str(x).trim();
  return {
    source: o.source === "llm" ? "llm" : "heuristic",
    understanding: {
      summary: clean(u.summary).slice(0, 2000),
      themes: arr(u.themes).map(clean).filter(Boolean).slice(0, 12),
      narrative_arc: arr(u.narrative_arc).map(clean).filter(Boolean).slice(0, 12),
    },
    characters_detected: arr(o.characters_detected).map((c) => {
      const cc = c && typeof c === "object" ? c : {};
      return { name: clean(cc.name).slice(0, 120), role: clean(cc.role, "supporting").slice(0, 40), mentions: Math.max(0, Number(cc.mentions) || 0) };
    }).filter((c) => c.name).slice(0, 24),
    dialogues: arr(o.dialogues).map((d) => {
      const dd = d && typeof d === "object" ? d : {};
      return { speaker: clean(dd.speaker).slice(0, 80), line: clean(dd.line).slice(0, 500), context: clean(dd.context).slice(0, 200) };
    }).filter((d) => d.line).slice(0, 40),
    narrations: arr(o.narrations).map((n) => {
      const nn = n && typeof n === "object" ? n : {};
      return { voice: clean(nn.voice, "narrator").slice(0, 80), text: clean(nn.text).slice(0, 1000), purpose: clean(nn.purpose).slice(0, 200) };
    }).filter((n) => n.text).slice(0, 40),
    emotions: arr(o.emotions).map((e) => {
      const ee = e && typeof e === "object" ? e : {};
      return { scope: clean(ee.scope, "overall").slice(0, 80), emotion: clean(ee.emotion).slice(0, 80), mood: clean(ee.mood).slice(0, 120), intensity: /^(low|high)$/i.test(clean(ee.intensity)) ? clean(ee.intensity).toLowerCase() : "medium" };
    }).filter((e) => e.emotion).slice(0, 24),
    locations_times: arr(o.locations_times).map((l) => {
      const ll = l && typeof l === "object" ? l : {};
      return { location: clean(ll.location).slice(0, 120), time_of_day: clean(ll.time_of_day, "unspecified").slice(0, 40), time_period: clean(ll.time_period, "unspecified").slice(0, 40), environment: clean(ll.environment).slice(0, 200) };
    }).filter((l) => l.location).slice(0, 24),
    actions: arr(o.actions).map((a) => {
      const aa = a && typeof a === "object" ? a : {};
      return { actor: clean(aa.actor).slice(0, 80), action: clean(aa.action).slice(0, 120), object: clean(aa.object).slice(0, 120), context: clean(aa.context).slice(0, 200) };
    }).filter((a) => a.action).slice(0, 40),
    visual_meanings: arr(o.visual_meanings).map((v) => {
      const vv = v && typeof v === "object" ? v : {};
      return { subject: clean(vv.subject).slice(0, 120), literal: clean(vv.literal).slice(0, 300), symbolic_meaning: clean(vv.symbolic_meaning).slice(0, 300) };
    }).filter((v) => v.subject).slice(0, 24),
  };
}

// Deterministic offline fallback: pattern/keyword extraction over the raw
// source text (Hindi + English). Never invents — empty sections stay [].
const DOC_EMOTION_KEYWORDS = [
  ["आनंद", "joy", "blissful"], ["joy", "joy", "blissful"], ["bliss", "joy", "blissful"], ["खुशी", "joy", "blissful"], ["happy", "joy", "blissful"], ["happiness", "joy", "blissful"], ["उल्लास", "exultation", "triumphant"], ["exultation", "exultation", "triumphant"],
  ["दुःख", "sorrow", "mournful"], ["sorrow", "sorrow", "mournful"], ["sad", "sorrow", "mournful"], ["शोक", "grief", "mournful"], ["grief", "grief", "mournful"], ["विषाद", "despair", "heavy"], ["despair", "despair", "heavy"], ["विरह", "longing", "aching"], ["longing", "longing", "aching"],
  ["क्रोध", "anger", "fierce"], ["anger", "anger", "fierce"], ["wrath", "anger", "fierce"], ["गुस्सा", "anger", "fierce"],
  ["शांति", "peace", "serene"], ["peace", "peace", "serene"], ["peaceful", "peace", "serene"], ["calm", "peace", "serene"],
  ["भक्ति", "devotion", "reverent"], ["devotion", "devotion", "reverent"], ["devotee", "devotion", "reverent"], ["श्रद्धा", "devotion", "reverent"],
  ["भय", "fear", "tense"], ["fear", "fear", "tense"], ["डर", "fear", "tense"], ["afraid", "fear", "tense"],
  ["प्रेम", "love", "tender"], ["love", "love", "tender"], ["प्यार", "love", "tender"],
  ["करुणा", "compassion", "tender"], ["compassion", "compassion", "tender"], ["mercy", "compassion", "tender"], ["दया", "compassion", "tender"],
  ["आश्चर्य", "wonder", "awe-filled"], ["wonder", "wonder", "awe-filled"], ["miracle", "wonder", "awe-filled"], ["चमत्कार", "wonder", "awe-filled"],
  ["तांडव", "ecstasy", "cosmic"], ["ecstasy", "ecstasy", "cosmic"], ["dance", "ecstasy", "cosmic"], ["नृत्य", "ecstasy", "cosmic"],
  ["उत्साह", "enthusiasm", "uplifting"], ["enthusiasm", "enthusiasm", "uplifting"], ["आशा", "hope", "uplifting"], ["hope", "hope", "uplifting"],
  ["गर्व", "pride", "majestic"], ["pride", "pride", "majestic"], ["साहस", "courage", "bold"], ["courage", "courage", "bold"], ["brave", "courage", "bold"],
  ["त्याग", "sacrifice", "solemn"], ["sacrifice", "sacrifice", "solemn"], ["पश्चाताप", "repentance", "solemn"], ["repentance", "repentance", "solemn"], ["forgive", "forgiveness", "solemn"], ["क्षमा", "forgiveness", "solemn"],
  ["ईर्ष्या", "jealousy", "tense"], ["jealousy", "jealousy", "tense"],
];
const DOC_TIME_KEYWORDS = [
  ["भोर", "dawn"], ["dawn", "dawn"], ["sunrise", "dawn"], ["प्रभात", "morning"], ["morning", "morning"], ["सुबह", "morning"],
  ["दिन", "day"], ["day", "day"], ["afternoon", "day"], ["दोपहर", "day"],
  ["संध्या", "dusk"], ["dusk", "dusk"], ["evening", "dusk"], ["sunset", "dusk"], ["शाम", "dusk"],
  ["रात्रि", "night"], ["night", "night"], ["रात", "night"], ["moonlit", "night"],
];
const DOC_ACTION_VERBS = [
  "dances", "dance", "battles", "battle", "fights", "fight", "meditates", "meditate", "blesses", "bless",
  "chants", "chant", "walks", "walk", "appears", "appear", "destroys", "destroy", "creates", "create",
  "protects", "protect", "plays", "play", "sings", "sing", "bows", "bow", "offers", "offer", " Tandava".trim(),
  " Tandav".trim(), "runs", "run", "cries", "cry", "laughs", "laugh", "speaks", "speak", "replies", "reply",
  "asks", "ask", "tells", "tell", "kills", "kill", "saves", "save", "lifts", "lift", "drinks", "drink",
  "eats", "eat", "sleeps", "sleep", "wakes", "wake", "burns", "burn", "builds", "build", "breaks", "break",
  "flies", "fly", "swims", "swim", "rides", "ride", "hides", "hide", "seeks", "seek", "finds", "find",
  "loses", "lose", "wins", "win", "crowns", "crown", "curses", "curse", "forgives", "forgive",
  "नृत्य", "ध्यान", "आशीर्वाद", "युद्ध", "प्रकट", "विनाश", "सृष्टि", "रक्षा", "पूजा", "आरती",
  "रोया", "रोना", "हँसे", "हँसना", "बोला", "बोली", "बोले", "कहा", "कही", "पूछा", "पूछी", "उत्तर",
  "मारा", "बचाया", "उठाया", "पिया", "खाया", "सोया", "जागा", "जलाया", "बनाया", "तोड़ा", "उड़ा",
  "तैरा", "छिपा", "खोजा", "पाया", "खोया", "जीता", "श्राप", "क्षमा",
];
const DOC_SYMBOL_MEANINGS = [
  ["त्रिशूल", "trident", "destruction of evil and the three gunas"], ["trishul", "trident", "destruction of evil and the three gunas"],
  ["डमरू", "hourglass drum", "the cosmic sound of creation"], ["damaru", "hourglass drum", "the cosmic sound of creation"],
  ["सर्प", "serpent", "mastery over fear and death"], ["serpent", "serpent", "mastery over fear and death"], ["नाग", "serpent", "mastery over fear and death"],
  ["चंद्रमा", "crescent moon", "the cycle of time"], ["moon", "crescent moon", "the cycle of time"],
  ["गंगा", "river Ganga", "purification and grace flowing to devotees"], ["ganga", "river Ganga", "purification and grace flowing to devotees"],
  ["तीसरा नेत्र", "third eye", "all-seeing wisdom"], ["third eye", "third eye", "all-seeing wisdom"],
  ["भस्म", "sacred ash", "transcendence of the material"], ["ash", "sacred ash", "transcendence of the material"],
  ["नंदी", "Nandi the bull", "devotion and dharma"], ["nandi", "Nandi the bull", "devotion and dharma"],
  ["तांडव", "Tandava dance", "the cosmic cycle of creation and dissolution"], ["tandava", "Tandava dance", "the cosmic cycle of creation and dissolution"],
  ["शिवलिंग", "Shivling", "the formless divine made worshippable"], ["shivling", "Shivling", "the formless divine made worshippable"],
  ["कमल", "lotus", "purity rising above the muddy world"], ["lotus", "lotus", "purity rising above the muddy world"],
  ["अग्नि", "fire", "purification and transformation"], ["fire", "fire", "purification and transformation"],
  ["जल", "water", "life and cleansing flow"], ["water", "water", "life and cleansing flow"],
  ["नदी", "river", "the ceaseless flow of grace"], ["river", "river", "the ceaseless flow of grace"],
  ["पर्वत", "mountain", "steadfastness and the eternal"], ["mountain", "mountain", "steadfastness and the eternal"],
  ["सूर्य", "sun", "knowledge dispelling darkness"], ["sun", "sun", "knowledge dispelling darkness"],
  ["चंद्र", "moon", "calm and the waxing of devotion"], ["चाँद", "moon", "calm and the waxing of devotion"],
  ["नेत्र", "eyes", "all-seeing awareness"], ["eyes", "eyes", "all-seeing awareness"],
  ["मुकुट", "crown", "sovereign authority"], ["crown", "crown", "sovereign authority"],
  ["धनुष", "bow", "focused resolve"], ["bow", "bow", "focused resolve"],
  ["तलवार", "sword", "justice cutting through evil"], ["sword", "sword", "justice cutting through evil"],
  ["शंख", "conch", "the victorious call to dharma"], ["conch", "conch", "the victorious call to dharma"], ["shankh", "conch", "the victorious call to dharma"],
  ["चक्र", "discus", "divine protection in motion"], ["discus", "discus", "divine protection in motion"], ["chakra", "discus", "divine protection in motion"],
  ["मोर", "peacock", "beauty and immortality"], ["peacock", "peacock", "beauty and immortality"],
  ["सिंह", "lion", "courage and righteous power"], ["lion", "lion", "courage and righteous power"],
  ["हाथी", "elephant", "wisdom and royal strength"], ["elephant", "elephant", "wisdom and royal strength"],
  ["वृक्ष", "tree", "sheltering life"], ["tree", "tree", "sheltering life"], ["बीज", "seed", "unfolding potential"], ["seed", "seed", "unfolding potential"],
  ["दीपक", "lamp", "knowledge over darkness"], ["lamp", "lamp", "knowledge over darkness"], ["दीया", "lamp", "knowledge over darkness"],
  ["घंटी", "bell", "an auspicious beginning"], ["bell", "bell", "an auspicious beginning"], ["घंटा", "bell", "an auspicious beginning"],
];

export function heuristicAnalyze(brief) {
  const b = brief || {};
  const raw = [b.sourceMaterial, b.topic, b.events].filter((x) => str(x).trim()).join("\n");
  const lower = ` ${raw.toLowerCase()} `;
  const countOf = (needle) => {
    if (!needle) return 0;
    const n = needle.toLowerCase().trim();
    if (!n) return 0;
    return lower.split(n).length - 1;
  };
  // Story understanding: first two sentences (or topic fallback).
  const sentences = raw.split(/[।.!?\n]+/).map((s) => s.trim()).filter((s) => s.length > 3);
  const summary = sentences.slice(0, 2).join(" ").slice(0, 600) ||
    `A devotional documentary on ${str(b.topic || b.title).slice(0, 200)}.`;
  const themes = str(b.events).split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  // Character detection: brief list first, then names extracted from the raw
  // text (gazetteer + Latin + Devanagari), with mention counts in the text.
  const briefNames = str(b.characters).split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const rawNames = extractDocNames(raw, 12);
  const charNames = [...briefNames];
  for (const n of rawNames) {
    if (charNames.length >= 12) break;
    if (!charNames.some((x) => x.toLowerCase() === n.toLowerCase())) charNames.push(n);
  }
  const characters_detected = charNames.map((name, i) => ({
    name, role: i === 0 ? "main" : "supporting", mentions: countOf(name),
  }));
  // Dialogue detection: "Name: line" (Latin + Devanagari speakers), Hindi
  // reported speech ("X ने कहा/बोले…", "…", quoted lines), then quoted speech.
  const dialogues = [];
  const seenDlg = new Set();
  const pushDlg = (speaker, line) => {
    const l = str(line).trim().slice(0, 500);
    if (l.length < 3 || dialogues.length >= 40) return;
    const key = `${str(speaker).trim().toLowerCase()}|${l.toLowerCase()}`;
    if (seenDlg.has(key)) return;
    seenDlg.add(key);
    dialogues.push({ speaker: str(speaker).trim(), line: l, context: "" });
  };
  for (const line of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^([^:]{1,40}):\s*(.{3,400})$/);
    if (m && !/^(https?|note|title|topic)$/i.test(m[1].trim())) {
      // "X ने Y से कहा: ..." -> speaker X; trailing verbs off ("पार्वती बोलीं" -> पार्वती).
      const speaker = cleanDocSpeaker(m[1]) || m[1].trim();
      pushDlg(speaker, m[2].trim());
      continue;
    }
    // Hindi reported speech: "<Speaker> ने/ने … कहा/कही/बोले/बोली/पूछा …: rest"
    // or quoted fragments on the same line.
    const rep = line.match(/^(.{2,60}?)\s+ने\s+(?:[^:।!?]{1,80}?\s+)?(?:कहा|कही|बोले|बोली|पूछा|पूछी|उत्तर\s*दिया)\s*[:—–-]?\s*(.{3,400})$/);
    if (rep && !/^(https?|note|title|topic)$/i.test(rep[1].trim())) {
      pushDlg(cleanDocSpeaker(rep[1]) || rep[1].trim(), rep[2].trim());
    }
  }
  for (const d of extractDocQuotedDialogues(raw, charNames)) pushDlg(d.speaker, d.line);
  // Narration detection: raw paragraphs (blank-line separated) are narration.
  const narrations = raw.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 10).slice(0, 12)
    .map((text) => ({ voice: "narrator", text: text.slice(0, 1000), purpose: "" }));
  // Emotion & mood: keyword scan (Hindi + English).
  const emotions = [];
  for (const [kw, emotion, mood] of DOC_EMOTION_KEYWORDS) {
    const hits = countOf(kw);
    if (hits > 0 && emotions.length < 24 && !emotions.some((e) => e.emotion === emotion)) {
      emotions.push({ scope: "overall", emotion, mood, intensity: hits > 2 ? "high" : "medium" });
    }
  }
  if (!emotions.length) emotions.push({ scope: "overall", emotion: "reverent", mood: "devotional calm", intensity: "medium" });
  // Location / time detection: brief locations merged with place-gazetteer
  // hits in the raw text + time-of-day cues.
  const briefLocs = str(b.locations).split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const locNames = [...briefLocs];
  for (const [kw, name] of DOC_PLACE_GAZETTEER) {
    if (locNames.length >= 12) break;
    if (lower.includes(kw.toLowerCase()) &&
        !locNames.some((x) => x.toLowerCase() === name.toLowerCase())) locNames.push(name);
  }
  const timeHits = [];
  for (const [kw, tod] of DOC_TIME_KEYWORDS) {
    if (countOf(kw) > 0 && !timeHits.includes(tod)) timeHits.push(tod);
  }
  const locations_times = locNames.map((location) => ({
    location,
    time_of_day: timeHits[0] || "unspecified",
    time_period: /shiv|shiva|mahadev|vishnu|krishna|ram\b|mytholog|leela|puran|ancient|प्राचीन|पौराणिक/i.test(`${b.topic} ${b.title} ${location}`) ? "mythological" : "unspecified",
    environment: "",
  }));
  // Action detection: sentences carrying action verbs.
  const actions = [];
  for (const s of sentences) {
    if (actions.length >= 20) break;
    const hit = DOC_ACTION_VERBS.find((v) => v && s.toLowerCase().includes(v.toLowerCase()));
    if (hit) actions.push({ actor: "", action: hit.trim(), object: "", context: s.slice(0, 160) });
  }
  // Visual meaning extraction: symbol keyword scan.
  const visual_meanings = [];
  for (const [kw, subject, symbolic_meaning] of DOC_SYMBOL_MEANINGS) {
    if (countOf(kw) > 0 && visual_meanings.length < 24 && !visual_meanings.some((v) => v.subject === subject)) {
      visual_meanings.push({ subject, literal: kw, symbolic_meaning });
    }
  }
  return normalizeDocAnalysis({
    source: "heuristic",
    understanding: {
      summary,
      themes,
      narrative_arc: ["introduction", "origin", "stories", "symbolism", "devotion", "conclusion"],
    },
    characters_detected,
    dialogues,
    narrations,
    emotions,
    locations_times,
    actions,
    visual_meanings,
  });
}

// ---- Per-stage approvals + execution history (Documentary-only) ----
// Each of the 15 pipeline stages can be Approved from its own tab. Approval
// arms a 20s idle countdown in the UI (auto-approve only when the system
// stays idle); the board stores the verdicts below. History snapshots let
// every stage tab show past executions next to the current one.

export function normalizeDocStageApprovals(input) {
  const o = input && typeof input === "object" ? input : {};
  const out = {};
  for (const key of DOC_ANALYSIS_STAGES) {
    const v = o[key];
    if (v && typeof v === "object") {
      const approved = v.approved === true;
      out[key] = {
        approved,
        at: approved ? str(v.at || new Date().toISOString()).slice(0, 40) : null,
        auto: approved ? v.auto === true : false,
      };
    } else if (v === true) {
      out[key] = { approved: true, at: new Date().toISOString(), auto: false };
    }
  }
  return out;
}

const docClock = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

// Compact per-stage snapshot of a board for execution history: the same
// 15 stages the UI checklist derives, as plain { key, done, detail } data.
// timelineTotalSeconds (from the timeline endpoint) feeds the timeline stage;
// null = derive from narration when unavailable.
export function snapshotDocStages(board, timelineTotalSeconds = null) {
  const b = board && typeof board === "object" ? board : {};
  const brief = b.brief && typeof b.brief === "object" ? b.brief : {};
  const a = b.analysis && typeof b.analysis === "object" ? b.analysis : null;
  const chapters = arr(b.chapters);
  const shots = chapters.flatMap((c) => arr(c.sequences).flatMap((q) => arr(q.shots)));
  const narrationSec = boardNarrationSeconds(b);
  const has = (v) => arr(v).length > 0;
  const timed = arr(a && a.locations_times).filter((l) => l && str(l.time_of_day) && str(l.time_of_day) !== "unspecified").length;
  return [
    { key: "raw", done: !!(str(brief.sourceMaterial).trim() || str(brief.topic).trim()), detail: str(brief.sourceMaterial).trim() ? `${str(brief.sourceMaterial).trim().split(/\s+/).length} words of source material` : "topic brief" },
    { key: "understanding", done: !!(a && a.understanding && str(a.understanding.summary).trim()), detail: a && has(a.understanding && a.understanding.themes) ? `themes: ${a.understanding.themes.slice(0, 4).join(", ")}` : "runs with Plan" },
    { key: "characters", done: arr(b.characters).length > 0, detail: `${arr(b.characters).length} in bible${a ? ` · ${arr(a.characters_detected).length} detected` : ""}` },
    { key: "dialogue", done: (a ? arr(a.dialogues).length : 0) > 0 || shots.some((s) => arr(s.dialogue_lines).length > 0), detail: `${a ? arr(a.dialogues).length : 0} detected · ${shots.filter((s) => arr(s.dialogue_lines).length > 0).length} shots carry dialogue` },
    { key: "narration", done: (a ? arr(a.narrations).length : 0) > 0 || shots.some((s) => arr(s.narration_lines).length > 0), detail: `${docClock(narrationSec)} narration` },
    { key: "emotion", done: (a ? arr(a.emotions).length : 0) > 0, detail: a && has(a.emotions) ? a.emotions.slice(0, 3).map((e) => `${str(e.emotion)} (${str(e.mood)})`).join(", ") : "runs with Plan" },
    { key: "location", done: arr(b.locations).length > 0 || (a ? arr(a.locations_times).length : 0) > 0, detail: `${arr(b.locations).length} places · ${timed} timed` },
    { key: "action", done: (a ? arr(a.actions).length : 0) > 0, detail: `${a ? arr(a.actions).length : 0} actions` },
    { key: "visual", done: (a ? arr(a.visual_meanings).length : 0) > 0, detail: `${a ? arr(a.visual_meanings).length : 0} symbols` },
    { key: "scene", done: chapters.some((c) => arr(c.sequences).length > 0), detail: `${chapters.length} chapters` },
    { key: "shot", done: shots.length > 0, detail: `${shots.length} shots` },
    { key: "continuity", done: arr(b.characters).some((c) => arr(c && c.consistency_rules).length > 0), detail: "locked identities, verbatim reuse" },
    { key: "image", done: shots.some((s) => str(s.flux_prompt).trim()), detail: `${shots.filter((s) => str(s.flux_prompt).trim()).length}/${shots.length} flux prompts` },
    { key: "video", done: shots.some((s) => str(s.ltx_prompt || s.motion).trim()), detail: `${shots.filter((s) => str(s.ltx_prompt || s.motion).trim()).length}/${shots.length} motion prompts` },
    { key: "timeline", done: Number(timelineTotalSeconds) > 0 || narrationSec > 0, detail: Number(timelineTotalSeconds) > 0 ? docClock(timelineTotalSeconds) : (narrationSec > 0 ? `${docClock(narrationSec)} (narration)` : "plan first") },
  ];
}

// Cap for per-board stage-history runs (each entry is one past Plan).
export const DOC_HISTORY_CAP = 10;

// Compact read-only context rendered from an analysis for the bible + shot
// planners. Empty analysis -> "" (builders stay byte-identical).
// planners. Empty analysis -> "" (builders stay byte-identical).
export function docAnalysisContext(analysis) {
  const a = analysis && typeof analysis === "object" ? analysis : null;
  if (!a) return "";
  const lines = [];
  const sum = str(a.understanding && a.understanding.summary).trim();
  if (sum) lines.push(`UNDERSTANDING: ${sum.slice(0, 600)}`);
  const themes = arr(a.understanding && a.understanding.themes).map((x) => str(x).trim()).filter(Boolean);
  if (themes.length) lines.push(`THEMES: ${themes.slice(0, 8).join(" | ").slice(0, 400)}`);
  const chars = arr(a.characters_detected).map((c) => str(c && c.name).trim()).filter(Boolean);
  if (chars.length) lines.push(`DETECTED CHARACTERS: ${chars.slice(0, 12).join(", ").slice(0, 400)}`);
  const dlg = arr(a.dialogues).filter((d) => d && str(d.line).trim());
  if (dlg.length) lines.push(`DETECTED DIALOGUES (${dlg.length}): ${dlg.slice(0, 4).map((d) => `${str(d.speaker) || "voice"}: ${str(d.line).slice(0, 90)}`).join(" ‖ ").slice(0, 500)}`);
  const emo = arr(a.emotions).filter((e) => e && str(e.emotion).trim());
  if (emo.length) lines.push(`EMOTIONS/MOODS: ${emo.slice(0, 8).map((e) => `${str(e.emotion)} (${str(e.mood)})`).join(", ").slice(0, 400)}`);
  const loc = arr(a.locations_times).filter((l) => l && str(l.location).trim());
  if (loc.length) lines.push(`PLACES/TIMES: ${loc.slice(0, 8).map((l) => `${str(l.location)}${str(l.time_of_day) && str(l.time_of_day) !== "unspecified" ? ` @ ${str(l.time_of_day)}` : ""}`).join(", ").slice(0, 400)}`);
  const act = arr(a.actions).filter((x) => x && str(x.action).trim());
  if (act.length) lines.push(`ACTIONS: ${act.slice(0, 10).map((x) => str(x.action)).join(", ").slice(0, 400)}`);
  const sym = arr(a.visual_meanings).filter((v) => v && str(v.subject).trim());
  if (sym.length) lines.push(`SYMBOLS: ${sym.slice(0, 8).map((v) => `${str(v.subject)} = ${str(v.symbolic_meaning).slice(0, 80)}`).join("; ").slice(0, 500)}`);
  return lines.join("\n");
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
      // Shots: 3–15s each (3–5s quick beats/dialogue exchanges, ~12s avg),
      // count driven by sequence duration. Each shot voices only its own
      // narration chunk (splitNarrationForShots) so its duration derives
      // from its own lines and the plan total matches the narration.
      const nShots = Math.min(12, Math.max(2, Math.round(qDur / 12)));
      const chunks = splitNarrationForShots(narration, nShots);
      const shotDur = Math.max(DOC_SHOT_MIN_SECONDS, Math.min(DOC_SHOT_MAX_SECONDS, Math.round(qDur / nShots)));
      const shots = [];
      for (let hi = 0; hi < nShots; hi++) {
        const shotType = HEURISTIC_SHOT_TYPES[(hi + si + ci) % HEURISTIC_SHOT_TYPES.length];
        const move = HEURISTIC_MOVES[(hi + ci) % HEURISTIC_MOVES.length];
        const line = chunks[hi] || "";
        const narrationLines = line ? [line] : [];
        const flux = withDevotionalRealism([
          b.visualStyle,
          mainChar.identity_prompt,
          `location: ${mainLoc.description || mainLoc.name}`,
          `shot: ${shotType}, ${move}, ${pacing.toLowerCase()} moment of ${topic}`,
          `lighting: ${mainLoc.lighting || "soft divine light"}`,
          `rules: no modern objects, consistent face, consistent costume, ${b.tone}`,
        ].filter(Boolean).join(", "));
        const ltx = `gentle ${move.toLowerCase()} motion, clouds drifting, lamp flames flickering, subtle divine glow pulsing; keep the exact character, face, clothing, colors, lighting and background from the input image — animate natural motion only, highly clear 8k uhd quality, smooth natural motion, no distortion, no morphing, no flicker, no blurry, no low quality`;
        shots.push(normalizeDocShot({
          title: `${HEURISTIC_CHAPTER_TITLES[ci % HEURISTIC_CHAPTER_TITLES.length]} — shot ${hi + 1}`,
          duration_seconds: shotDur,
          narration_lines: narrationLines,
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
// Flattens chapters/sequences/shots into pipeline beats. narration_lines map
// to the narrator voice and dialogue_lines ("Speaker: line") map to one
// voice per speaker via the existing dialogue/TTS path (single-speaker
// narration beats keep the whole-beat path; multi-speaker beats get
// automatic per-line segmentation downstream). Each beat also carries the
// word-proportional per-line timing tiling its duration exactly.
export function boardToScenario(board) {
  const brief = board.brief || {};
  const lock = str(brief.visualStyle || DEFAULT_DOC_BRIEF.visualStyle);
  const devotional = isDevotionalBrief(brief);
  const chars = arr(board.characters);
  const charById = new Map(chars.map((c) => [c.character_id, c]));
  const defaultVoice = str(brief.narrationVoice) || "hi-IN-MadhurNeural";
  const alternateVoice = defaultVoice === "hi-IN-SwaraNeural" ? "hi-IN-MadhurNeural" : "hi-IN-SwaraNeural";
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
          "Keep the exact character, face, clothing, colors, lighting and background from the input image — animate natural motion only, highly clear 8k uhd quality, smooth natural motion, no distortion, no morphing, no flicker, no blurry, no low quality";
        if (!/animate natural motion only/i.test(motion)) {
          motion = `${motion}, Keep the exact character, face, clothing, colors, lighting and background from the input image — animate natural motion only, highly clear 8k uhd quality, smooth natural motion, no distortion, no morphing, no flicker, no blurry, no low quality`;
        } else if (!/8k uhd quality|no distortion|no morphing/i.test(motion)) {
          motion = `${motion}, highly clear 8k uhd quality, smooth natural motion, no distortion, no morphing, no flicker, no blurry, no low quality`;
        }
        // Narration lines voice the narrator; dialogue_lines voice their
        // resolved speaker (bible character_id when matched, else the raw
        // label) in spoken order, each with micro-timing tiling the beat.
        const fitted = { ...s, duration_seconds: Number(s.duration_seconds) || 10 };
        const timing = shotLineTiming(fitted);
        const dialogue = timing.map((t) => ({
          speaker: t.speaker === "narrator" ? "narrator" : resolveDocSpeakerId(chars, t.speaker),
          line: t.text,
        })).filter((d) => d.line);
        beats.push({
          title: `c${String(s.chapter).padStart(2, "0")}_s${String(s.sequence).padStart(2, "0")}_${slug}`.slice(0, 80),
          image,
          motion,
          duration: Number(s.duration_seconds) || 10,
          dialogue,
          timing,
          ...(s.emotion ? { emotion: s.emotion } : {}),
          ...(s.time_of_day ? { time_of_day: s.time_of_day } : {}),
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
  // Every resolved dialogue speaker gets a deterministic voice: bible voice
  // when set, otherwise the alternate of the narrator voice (so speakers
  // never collapse onto the narrator). Unknown labels ride along too.
  for (const b of beats) {
    for (const d of b.dialogue) {
      const key = str(d.speaker);
      if (!key || key === "narrator" || voices[key]) continue;
      const ch = charById.get(key);
      voices[key] = (ch && ch.voice) || alternateVoice;
    }
  }
  return {
    description: `${str(brief.title)} — ${str(brief.topic)}`.slice(0, 500),
    duration: 10,
    referencePrompt,
    sequence: beats,
    tts: { defaultVoice, voices },
    // Flux quality: devotional boards render at higher steps for fine
    // skin/fabric/jewelry detail (honored by character_sequence*.mjs).
    ...(devotional ? { fluxSteps: DEVOTIONAL_FLUX_STEPS, quality: "devotional-ultra-realistic" } : {}),
    // Connected movie: devotional docs (Shiv/Ram/Krishna) keep TEXT
    // continuity via cfg.chainContinuity wording; pixels stay strictly
    // per-scene (every keyframe anchors on the reference, every clip
    // animates its own keyframe) so video never drifts off its scene image.
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
        const dur = Number(s.duration_seconds) || 0;
        // Word-proportional per-line cues (narration + "Speaker: line"
        // dialogue) tiling the shot exactly — the same micro-timing the
        // approve handoff voices. Shots with no spoken lines advance time.
        const timing = shotLineTiming({ ...s, duration_seconds: dur || 10 });
        if (!timing.length) { t += dur; continue; }
        for (const tl of timing) {
          const text = tl.kind === "dialogue" && tl.speaker && tl.speaker !== "narrator"
            ? `${tl.speaker}: ${tl.text}`
            : tl.text;
          cues.push({ start: t + tl.start, end: t + tl.end, text });
        }
        t += dur;
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
