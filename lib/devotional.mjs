// Devotional Studio — pure helpers (no fs/network). Shared by server.mjs,
// Director integration, and tests. Run: node --test tests/devotional.test.mjs
//
// Design mirrors lib/director.mjs: pure normalize/validate/prompt builders,
// durable stable IDs (CHAR_/LOC_/PROP_/STYLE_ prefixes), parent-child links
// for character variants and location sub-locations.

export const DEVOTIONAL_KINDS = ["character", "location", "prop", "style"];
export const DEVOTIONAL_STATUSES = ["draft", "generating", "review", "approved", "archived"];
export const DEVOTIONAL_FILE_KINDS = [
  "master", "face", "fullbody", "three-quarter", "side", "back",
  "expression", "pose", "costume", "detail", "wide", "medium",
  "angle", "landmark", "lighting", "weather", "interior", "exterior",
  "front", "generated", "video", "other",
];

const ID_PREFIX = { character: "CHAR", location: "LOC", prop: "PROP", style: "STYLE" };

// Stable asset IDs: <PREFIX>_<SANITIZED>_<NN> e.g. CHAR_KRISHNA_01.
// Sanitized = uppercase alnum runs joined with "_", max 24 chars.
export function sanitizeIdPart(s, max = 24) {
  const clean = String(s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (clean || "ASSET").slice(0, max);
}

export function makeAssetId(kind, name, n = 1) {
  const prefix = ID_PREFIX[kind] || "ASSET";
  const nn = String(Math.max(1, Math.floor(Number(n) || 1))).padStart(2, "0");
  return `${prefix}_${sanitizeIdPart(name)}_${nn}`;
}

// Filesystem-safe folder segment (mirrors fileSlug in lib/variant.mjs).
export function safeFolder(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "asset";
}

// Reject path traversal / absolute / separator-carrying segments.
export function isSafeSegment(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 120 &&
    !s.includes("..") && !s.includes("/") && !s.includes("\\") && !s.startsWith(".");
}

export function normalizeKind(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return DEVOTIONAL_KINDS.includes(s) ? s : null;
}

export function normalizeStatus(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return DEVOTIONAL_STATUSES.includes(s) ? s : null;
}

// Allowed status transitions (identity lock = approved rows need explicit
// unlock before edits; enforced server-side, described here for UI + tests).
// generating is a transient job state — jobs write it, humans don't set it.
export const STATUS_TRANSITIONS = {
  draft: ["review", "archived"],
  generating: ["review", "draft"],
  review: ["approved", "draft", "archived"],
  approved: ["archived", "review"],
  archived: ["draft"],
};

export function canTransition(from, to) {
  const list = STATUS_TRANSITIONS[String(from ?? "").toLowerCase()];
  return Array.isArray(list) && list.includes(String(to ?? "").toLowerCase());
}

export function normalizeAliases(v) {
  if (Array.isArray(v)) return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20);
  if (typeof v === "string") return normalizeAliases(v.split(","));
  return [];
}

// Canonical asset shape. `identity` carries kind-specific free-form metadata
// (facial features, architecture, materials, palette, ...) — always an object,
// never trusted for paths/IDs.
export function normalizeAsset(input = {}) {
  const kind = normalizeKind(input.kind);
  const status = normalizeStatus(input.status) || "draft";
  return {
    id: typeof input.id === "string" ? input.id.trim().toUpperCase().slice(0, 64) : null,
    kind,
    parent_id: typeof input.parent_id === "string" && input.parent_id.trim()
      ? input.parent_id.trim().toUpperCase().slice(0, 64) : null,
    name: String(input.name ?? "").trim().slice(0, 120),
    aliases: normalizeAliases(input.aliases),
    category: String(input.category ?? "").trim().slice(0, 80),
    description: String(input.description ?? "").trim().slice(0, 4000),
    identity: input.identity && typeof input.identity === "object" && !Array.isArray(input.identity)
      ? input.identity : {},
    style_id: typeof input.style_id === "string" && input.style_id.trim()
      ? input.style_id.trim().toUpperCase().slice(0, 64) : null,
    negative_prompt: String(input.negative_prompt ?? "").trim().slice(0, 2000),
    // Saved generation prompt override (Flux still + LTX clip). Blank means
    // "auto" — the generate route falls back to describeAssetForPrompt().
    prompt: String(input.prompt ?? "").trim().slice(0, 2000),
    status,
    version: Math.max(1, Math.floor(Number(input.version) || 1)),
    locked: !!input.locked,
    continuity: String(input.continuity ?? "").trim().slice(0, 2000),
  };
}

// Create/update payload validation. Returns { ok, errors[], asset }.
// Edits to approved+locked assets are rejected unless `unlock: true` passes
// with an explicit `confirmed` flag (server checks permissions separately).
export function validateAssetPayload(body = {}, { isUpdate = false } = {}) {
  const errors = [];
  const a = normalizeAsset(body);
  if (!isUpdate || body.kind !== undefined) {
    if (!a.kind) errors.push("kind must be one of: " + DEVOTIONAL_KINDS.join(", "));
  }
  if (!isUpdate || body.name !== undefined) {
    if (!a.name) errors.push("name is required");
  }
  if (a.id !== null && !/^[A-Z0-9_]{3,64}$/.test(a.id)) errors.push("id must match ^[A-Z0-9_]{3,64}$");
  if (a.parent_id !== null && !/^[A-Z0-9_]{3,64}$/.test(a.parent_id)) errors.push("parent_id must match ^[A-Z0-9_]{3,64}$");
  if (body.status !== undefined && !normalizeStatus(body.status)) {
    errors.push("status must be one of: " + DEVOTIONAL_STATUSES.join(", "));
  }
  return { ok: errors.length === 0, errors, asset: a };
}

// ---------------------------------------------------------------------------
// Prompt assembly (Director integration). Identity and scene action stay
// separate: the canonical description defines what the subject IS, the scene
// block defines what it DOES. Returns { positive, negative }.
// ---------------------------------------------------------------------------
export function describeAssetForPrompt(a) {
  const bits = [];
  if (a?.name) bits.push(a.name);
  if (a?.description) bits.push(a.description);
  const id = a?.identity && typeof a.identity === "object" ? a.identity : {};
  for (const k of ["features", "costume", "ornaments", "complexion", "age", "silhouette",
    "architecture", "landscape", "materials", "colors", "lighting", "atmosphere",
    "shape", "material", "finish", "palette", "rendering", "camera"]) {
    if (typeof id[k] === "string" && id[k].trim()) bits.push(`${k}: ${id[k].trim()}`);
  }
  if (a?.continuity) bits.push(`continuity: ${a.continuity}`);
  return bits.filter(Boolean).join(". ");
}

// Compose the final image prompt from canonical assets + scene specifics.
// Spec order: A character, B variant/costume, C location+rules, D props,
// E action/expression, F camera, G lighting/style, H workflow note, I negative.
export function buildDevotionalScenePrompt({ characters = [], variant = null, location = null, props = [], style = null, scene = {} } = {}) {
  const sec = [];
  const charBits = characters.map(describeAssetForPrompt).filter(Boolean);
  if (charBits.length) sec.push(`CHARACTERS: ${charBits.join(" | ")}`);
  if (variant) {
    const v = describeAssetForPrompt(variant);
    if (v) sec.push(`VARIANT: ${v}`);
  }
  if (location) {
    const l = describeAssetForPrompt(location);
    if (l) sec.push(`LOCATION: ${l}`);
  }
  const propBits = props.map(describeAssetForPrompt).filter(Boolean);
  if (propBits.length) sec.push(`PROPS: ${propBits.join(" | ")}`);
  const action = [scene.action, scene.expression, scene.emotion, scene.body_language].filter(Boolean).join(", ");
  if (action) sec.push(`SCENE ACTION: ${action}`);
  const cam = scene.camera && typeof scene.camera === "object"
    ? [scene.camera.shot_type, scene.camera.angle, scene.camera.movement].filter(Boolean).join(", ")
    : String(scene.camera || "");
  if (cam) sec.push(`CAMERA: ${cam}`);
  const look = [scene.lighting, scene.environment, style ? describeAssetForPrompt(style) : ""].filter(Boolean).join(". ");
  if (look) sec.push(`LOOK: ${look}`);
  const positive = sec.join("\n");
  const negBits = [
    ...characters.map((c) => c?.negative_prompt).filter(Boolean),
    style?.negative_prompt || "",
  ].filter(Boolean);
  const negative = [...new Set(negBits.join(", ").split(",").map((s) => s.trim()).filter(Boolean))].join(", ");
  return { positive, negative };
}

// Resolve a scene's devotional references from a library map.
// Prefers exact approved IDs; never invents entries — unresolved names are
// reported for the review/selection step instead of silent substitution.
export function resolveSceneAssets(scene = {}, libraryById = {}) {
  const get = (id) => {
    if (!id) return null;
    const a = libraryById[String(id).toUpperCase()];
    return a && a.status === "approved" ? a : null;
  };
  const charIds = Array.isArray(scene.devotional_characters) ? scene.devotional_characters : [];
  const propIds = Array.isArray(scene.devotional_props) ? scene.devotional_props : [];
  const characters = [];
  const missing = [];
  for (const id of charIds) {
    const a = get(id);
    if (a) characters.push(a);
    else missing.push({ role: "character", id: String(id) });
  }
  const location = get(scene.devotional_location);
  if (scene.devotional_location && !location) {
    missing.push({ role: "location", id: String(scene.devotional_location) });
  }
  const props = [];
  for (const id of propIds) {
    const a = get(id);
    if (a) props.push(a);
    else missing.push({ role: "prop", id: String(id) });
  }
  const style = get(scene.devotional_style);
  if (scene.devotional_style && !style) {
    missing.push({ role: "style", id: String(scene.devotional_style) });
  }
  return { characters, location, props, style, missing };
}

// Seed suggestions (configurable library entries, never hardcoded logic).
// Used by the UI empty-state + "seed starter library" action only.
export const SEED_SUGGESTIONS = {
  character: [
    { name: "Lord Krishna", category: "Deity", description: "Blue-complexioned cowherd prince of Vrindavan, flute player." },
    { name: "Lord Rama", category: "Deity", description: "Prince of Ayodhya, bow bearer, embodiment of dharma." },
    { name: "Lord Shiva", category: "Deity", description: "Ascetic meditator of Mount Kailash, trident and damaru bearer." },
    { name: "Lord Hanuman", category: "Deity", description: "Devoted vanara warrior, gada bearer." },
    { name: "Goddess Sita", category: "Deity", description: "Princess of Mithila, embodiment of grace and devotion." },
    { name: "Goddess Parvati", category: "Deity", description: "Divine mother, consort of Shiva." },
    { name: "Goddess Durga", category: "Deity", description: "Warrior goddess, slayer of Mahishasura." },
    { name: "Lord Ganesha", category: "Deity", description: "Elephant-headed remover of obstacles." },
    { name: "Lord Vishnu", category: "Deity", description: "Preserver of the universe, conch and discus bearer." },
    { name: "Goddess Lakshmi", category: "Deity", description: "Goddess of wealth and fortune, lotus-seated." },
  ],
  location: [
    { name: "Ayodhya", category: "City", description: "Ancient solar-dynasty capital on the Sarayu river." },
    { name: "Vrindavan", category: "Sacred land", description: "Pastoral land of Krishna's childhood, groves and riverbanks." },
    { name: "Gokul", category: "Village", description: "Cowherd village of Krishna's early childhood." },
    { name: "Mathura", category: "City", description: "Birthplace of Krishna on the Yamuna." },
    { name: "Dwarka", category: "City", description: "Coastal capital of Krishna's later reign." },
    { name: "Mount Kailash", category: "Mountain", description: "Snow abode of Shiva, sacred peak." },
  ],
  prop: [
    { name: "Krishna's Flute", category: "Musical instrument", description: "Bamboo bansuri, dark wood with ornamental bands." },
    { name: "Shiva's Trident", category: "Weapon", description: "Trishul with damaru attached, sacred ash markings." },
    { name: "Rama's Bow", category: "Weapon", description: "Kodanda bow with quiver of arrows." },
    { name: "Hanuman's Gada", category: "Weapon", description: "Ornate golden mace." },
    { name: "Divine Crown", category: "Crown", description: "Golden mukut with gemstones and peacock motifs." },
    { name: "Sacred Lamp", category: "Ritual object", description: "Brass diya with ghee flame." },
  ],
  style: [
    { name: "Cinematic 3D Devotional", category: "3D", description: "Warm cinematic 3D render, volumetric light, rich fabrics." },
    { name: "Photorealistic Mythological Cinema", category: "Photoreal", description: "Epic film still, natural skin, practical sets." },
    { name: "Traditional Indian Painting", category: "Painting", description: "Miniature-painting palette, flat perspective, ornate borders." },
    { name: "Children's Animation", category: "Animation", description: "Soft rounded shapes, bright friendly palette." },
  ],
};

export const DEVOTIONAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS devotional_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('character','location','prop','style')),
  parent_id TEXT REFERENCES devotional_assets(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  identity JSONB NOT NULL DEFAULT '{}',
  style_id TEXT REFERENCES devotional_assets(id) ON DELETE SET NULL,
  negative_prompt TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','generating','review','approved','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  continuity TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_devotional_kind_status ON devotional_assets(kind, status);
CREATE INDEX IF NOT EXISTS idx_devotional_parent ON devotional_assets(parent_id);
CREATE INDEX IF NOT EXISTS idx_devotional_name_trgm ON devotional_assets USING GIN (to_tsvector('english', name || ' ' || description));
CREATE TABLE IF NOT EXISTS devotional_asset_versions (
  id BIGSERIAL PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES devotional_assets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_id, version)
);
CREATE TABLE IF NOT EXISTS devotional_asset_files (
  id BIGSERIAL PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES devotional_assets(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_kind TEXT NOT NULL DEFAULT 'master',
  source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('generated','upload')),
  prompt TEXT,
  workflow TEXT,
  model TEXT,
  seed BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_devotional_files_asset ON devotional_asset_files(asset_id);
CREATE TABLE IF NOT EXISTS devotional_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT REFERENCES devotional_assets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'reference',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  prompt TEXT,
  workflow TEXT,
  model TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS devotional_scene_links (
  id BIGSERIAL PRIMARY KEY,
  board_id TEXT NOT NULL,
  scene_number INTEGER NOT NULL,
  asset_id TEXT NOT NULL REFERENCES devotional_assets(id) ON DELETE RESTRICT,
  asset_version INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL CHECK (role IN ('character','location','prop','style')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (board_id, scene_number, asset_id, role)
);
CREATE INDEX IF NOT EXISTS idx_devotional_links_board ON devotional_scene_links(board_id);
CREATE INDEX IF NOT EXISTS idx_devotional_links_asset ON devotional_scene_links(asset_id);
CREATE TABLE IF NOT EXISTS devotional_project_usage (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES devotional_assets(id) ON DELETE RESTRICT,
  asset_version INTEGER NOT NULL DEFAULT 1,
  scenes INTEGER[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, asset_id)
);
`;

// ---------------------------------------------------------------------------
// Phase 2 — World & Asset Intelligence (pure). Works on Director bible +
// scenes AND the devotional library shape: every decision traces back to the
// Story Plan, approved references are reused, duplicates are flagged instead
// of silently recreated. Never throws.
// ---------------------------------------------------------------------------

const normKey = (v) =>
  String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, "_").replace(/^_+|_+$/g, "");

function idOf(o, fb = "") {
  const x = o && typeof o === "object" ? o : {};
  const raw = x.character_id ?? x.location_id ?? x.object_id ?? x.asset_id ?? x.id ?? x.name ?? fb;
  return normKey(raw) || fb;
}

// Character-to-asset / scene-to-location reference map for one board.
// Returns { characters[], locations[], props[], styles[] } where each entry
// carries { id, name, scenes[], shots[] }. Shots flatten from scene.shots.
export function buildAssetReferenceMap(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const scenes = Array.isArray(b.scenes) ? b.scenes : [];
  const bp = b.blueprint && typeof b.blueprint === "object" ? b.blueprint : {};
  const nameOf = (list, key) => {
    const m = new Map();
    for (const e of Array.isArray(list) ? list : []) {
      const o = e && typeof e === "object" ? e : {};
      const id = idOf(o);
      if (id && !m.has(id)) m.set(id, String(o.name || id));
    }
    return m;
  };
  const charNames = nameOf(bp.characters);
  const locNames = nameOf(bp.locations);
  const objNames = nameOf(bp.objects);
  const touch = (map, id, name, sceneNum, shotId) => {
    if (!id) return;
    let e = map.get(id);
    if (!e) { e = { id, name: name || id, scenes: [], shots: [] }; map.set(id, e); }
    if (Number.isFinite(Number(sceneNum)) && !e.scenes.includes(Number(sceneNum))) e.scenes.push(Number(sceneNum));
    if (shotId && !e.shots.includes(shotId)) e.shots.push(shotId);
  };
  const chars = new Map();
  const locs = new Map();
  const props = new Map();
  const styles = new Map();
  for (const s of scenes) {
    const o = s && typeof s === "object" ? s : {};
    const sn = Number(o.scene_number);
    const rows = [o, ...(Array.isArray(o.shots) ? o.shots : [])];
    for (const r of rows) {
      const x = r && typeof r === "object" ? r : {};
      const shotId = typeof x.shot_id === "string" && x.shot_id ? x.shot_id : null;
      for (const c of Array.isArray(x.characters) ? x.characters : []) {
        const id = typeof c === "string" || typeof c === "number" ? normKey(c) : idOf(c);
        touch(chars, id, charNames.get(id) || String((c && c.name) || id), sn, shotId);
      }
      if (x.location) touch(locs, normKey(x.location), locNames.get(normKey(x.location)) || String(x.location), sn, shotId);
      for (const p of Array.isArray(x.continuity_refs) ? x.continuity_refs : []) touch(props, normKey(p), objNames.get(normKey(p)) || String(p), sn, shotId);
      for (const p of Array.isArray(x.objects) ? x.objects : []) touch(props, normKey(p), objNames.get(normKey(p)) || String(p), sn, shotId);
      const st = x.devotional_style || x.style_id || (b.input && (b.input.visualStyle || b.input.style));
      if (typeof st === "string" && st.trim()) touch(styles, normKey(st), st.trim().slice(0, 80), sn, shotId);
    }
    // Devotional scene-links shape (explicit asset pins per scene).
    for (const c of Array.isArray(o.devotional_characters) ? o.devotional_characters : []) touch(chars, normKey(c), charNames.get(normKey(c)) || String(c), sn, null);
    if (o.devotional_location) touch(locs, normKey(o.devotional_location), String(o.devotional_location), sn, null);
    for (const p of Array.isArray(o.devotional_props) ? o.devotional_props : []) touch(props, normKey(p), String(p), sn, null);
  }
  const sort = (m) => [...m.values()].map((e) => ({ ...e, scenes: e.scenes.sort((a, x) => a - x), shots: [...e.shots].sort() }));
  return { characters: sort(chars), locations: sort(locs), props: sort(props), styles: sort(styles) };
}

// Flag near-duplicate bible/library entries that should reuse one approved
// asset instead of creating a second (same normalized name, different id).
// Input: array of { id-ish, name }. Returns [{ name, ids[] }].
export function findDuplicateAssets(entries = []) {
  const byName = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const o = e && typeof e === "object" ? e : {};
    const name = normKey(o.name);
    const id = idOf(o, "");
    if (!name || !id) continue;
    if (!byName.has(name)) byName.set(name, { name: String(o.name), ids: [] });
    const g = byName.get(name);
    if (!g.ids.includes(id)) g.ids.push(id);
  }
  return [...byName.values()].filter((g) => g.ids.length > 1);
}

// Visual Style Guide derived from the board (style lock + palette/lighting
// seen across locations + cast size). Read-only summary the art department
// renders; the generate path keeps enforcing locks server-side.
export function buildVisualStyleGuide(board = {}) {
  const b = board && typeof board === "object" ? board : {};
  const bp = b.blueprint && typeof b.blueprint === "object" ? b.blueprint : {};
  const chars = Array.isArray(bp.characters) ? bp.characters : [];
  const locs = Array.isArray(bp.locations) ? bp.locations : [];
  const palettes = [...new Set(locs.map((l) => String((l && l.color_palette) || "").trim()).filter(Boolean))].slice(0, 6);
  const lighting = [...new Set(locs.map((l) => String((l && l.lighting) || "").trim()).filter(Boolean))].slice(0, 6);
  const style = (b.input && (b.input.visualStyle || b.input.style)) || "";
  return {
    style: String(style || "3D Preschool Animation"),
    characters: chars.length,
    locations: locs.length,
    palettes,
    lighting,
    layout: "foreground: character action; middle ground: interaction target; background: location identity, never redressed mid-scene",
  };
}

// Asset continuity check: unknown bible ids staged, costume/appearance drift
// for the same character across scenes without a noted change, locations with
// no visual identity, props staged then dropped. Returns issue strings.
export function validateAssetContinuity(board = {}) {
  const issues = [];
  const b = board && typeof board === "object" ? board : {};
  const bp = b.blueprint && typeof b.blueprint === "object" ? b.blueprint : {};
  const scenes = Array.isArray(b.scenes) ? b.scenes : [];
  const known = new Set([
    ...((Array.isArray(bp.characters) ? bp.characters : []).map((c) => idOf(c))),
    ...((Array.isArray(bp.locations) ? bp.locations : []).map((l) => idOf(l))),
    ...((Array.isArray(bp.objects) ? bp.objects : []).map((o) => idOf(o))),
  ]);
  const locIdentity = new Map((Array.isArray(bp.locations) ? bp.locations : []).map((l) => [idOf(l), String((l && l.visual_identity_prompt) || "").trim()]));
  const seenCostume = new Map();
  scenes.forEach((s, i) => {
    const o = s && typeof s === "object" ? s : {};
    const label = `scene ${o.scene_number || i + 1}`;
    for (const c of Array.isArray(o.characters) ? o.characters : []) {
      const id = typeof c === "string" || typeof c === "number" ? normKey(c) : idOf(c);
      if (id && !known.has(id) && !locIdentity.has(id)) issues.push(`${label}: unknown character "${String(id).slice(0, 40)}" not in the bible registry`);
      const cloth = c && typeof c === "object" ? String(c.clothing || (c.appearance && c.appearance.costume) || "") : "";
      if (id && cloth) {
        const prev = seenCostume.get(id);
        if (prev && prev !== cloth) issues.push(`${label}: ${id} costume changes with no noted change ("${prev.slice(0, 30)}" → "${cloth.slice(0, 30)}")`);
        else if (!prev) seenCostume.set(id, cloth);
      }
    }
    if (o.location) {
      const lid = normKey(o.location);
      if (locIdentity.has(lid) && !locIdentity.get(lid)) issues.push(`${label}: location "${String(o.location).slice(0, 40)}" has no visual identity — appearance may drift`);
    }
  });
  return [...new Set(issues)];
};
