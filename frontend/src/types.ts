export interface Beat {
  title: string;
  image: string;
  motion: string;
  // Per-beat clip length (dialogue beats grow to fit their voice audio —
  // see beatTargetDuration in lib/tts.mjs). Absent = scenario.duration.
  duration?: number;
  // Spoken lines for this beat (voiced per character via Edge-TTS Hindi,
  // lip-synced via Easy-Wav2Lip). Absent/empty = silent beat.
  dialogue?: { speaker: string; line: string }[];
}

export interface Scenario {
  description?: string;
  character?: string;
  referencePrompt: string;
  duration: number;
  sequence: Beat[];
  // Immutable storage folder (projects.folder_name), stamped by the server
  // on creation. Display names may contain spaces — this never does, and it
  // is never updated on edits/renames.
  folder_name?: string | null;
  // Predefined video-type preset id (presets/presets.json). Resolved to
  // presets/*.md rules at craft/generation time — only the id is stored,
  // never the .md content. Absent = default preset (cinematic).
  presetId?: string;
  // Per-project customization of the video-type rules. When non-empty, this
  // text REPLACES the preset's .md content for this project only (craft +
  // beat extension). Empty/absent = use the preset default. The system-owned
  // presets/*.md files are never modified.
  presetRules?: string;
  // Music-video mode (AI Story Director song upload): the approved board's
  // uploaded song. The file lives server-side in director/ and is muxed over
  // the final cut via POST /api/director/boards/:id/mux-song.
  song?: {
    file: string;
    fileName?: string;
    durationSeconds?: number | null;
  };
  // Voice casting per character id (Edge-TTS voice names). Empty/absent =
  // auto-cast in lib/tts.mjs (e.g. rabbit -> hi-IN-SwaraNeural female,
  // lion -> hi-IN-MadhurNeural male). Edit to recast a character.
  tts?: {
    defaultVoice?: string;
    voices?: Record<string, string>;
  };
}

export interface ScenarioInfo {
  name: string;
  isSequence: boolean;
  mtimeMs: number;
  favorite?: boolean;
  /** Integer id from the projects table (null in SQLite mode / unknown). */
  project_id?: number | null;
  /** Immutable folder name derived from project name on creation (snake_case, <=100 chars). */
  folder_name?: string | null;
}

export interface Run {
  id: string;
  scenario: string;
  /** Immutable storage folder the run writes to (outputs/<folder>/…). */
  folder?: string;
  status: "running" | "done" | "error";
  log: string;
  startedAt: number;
  /** Engine the run was started with (present on runs started after Re-Design-V2). */
  engine?: string;
  /** Cut the run generates: "landscape" (main video) or "vertical" (9:16
      Instagram Reel — fresh vertical images + clips in a separate folder). */
  format?: string;
  /** Run shape (present on runs started after Re-Design-V2) — lets a fresh
      page reattach to an active run after a refresh and rebuild progress +
      button state from the real SSE stream. Absent = full ltx run, count 1. */
  stitch?: boolean;
  regen?: { kind: "ref" | "keyframe" | "clip"; index?: number } | null;
  count?: number;
}

export interface AuthUser {
  user: string;
}

export interface ComfyStatus {
  up: boolean;
  error?: string;
  queue?: { queue_running?: unknown[]; queue_pending?: unknown[] };
  stats?: Record<string, unknown>;
}

// One version of a versioned asset (v1 = original file, vN = _vN suffix).
export interface AssetVersion {
  file: string;
  v: number;
}

export interface BeatVersions {
  keyframe: AssetVersion[];
  clip: AssetVersion[];
}

export interface VersionsInfo {
  ref: AssetVersion[];
  beats: Record<string, BeatVersions>;
  // Stitched final cuts: v1 = <prefix>_final.mp4, vN = <prefix>_final_vN.mp4.
  // Optional so old payloads still type-check; the gallery falls back to
  // scanning the file list.
  final?: AssetVersion[];
}

export interface MainsInfo {
  ref: string | null;
  beats: Record<string, { keyframe: string | null; clip: string | null }>;
  // Latest final-cut file (the one the gallery plays). Optional for compat.
  final?: string | null;
  // Whether each main is a user pin (manual pick / upload — survives reload)
  // or the auto latest (selected on regen and reload). Absent = auto.
  pinned?: {
    ref: boolean;
    beats: Record<string, { keyframe: boolean; clip: boolean }>;
  } | null;
}

export interface OutputsInfo {
  files: string[];
  versions: VersionsInfo;
  mains: MainsInfo;
  /** Reference rows from project_references (one per generation/upload):
      master prompt + source per file. Absent = disk listing (draft/PG-down). */
  refMeta?: Record<string, { prompt?: string | null; source?: string | null }>;
}

export type AssetKind = "ref" | "keyframe" | "clip";

// One row of public.project_references (one row per reference generation or
// upload — a project accumulates many master prompts / reference images).
// is_main marks the record selected as main on the UI (one per output dir).
export interface ProjectReference {
  id: number;
  project_id: number;
    output_dir: string;
    video_type?: string | null;
  version: number | null;
  prompt: string | null;
  negative_prompt: string | null;
  file_path: string | null;
  model: string | null;
  workflow: string | null;
  seed: number | null;
  attempts: number;
  source: "generated" | "upload";
  is_main: boolean;
  pinned: boolean;
  metadata: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// One row of the narrow public.project_assets table (one row per asset).
export type ProjectAssetType = "REFERENCE" | "IMAGE" | "KEYFRAME" | "VIDEO" | "FINAL";
export type ProjectAssetStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "SKIPPED";

  export interface ProjectAsset {
    id: number;
    project_id: number;
    version: number;
    scene_id: number | null;
    beat_index: number;
    beat_title: string | null;
    asset_type: ProjectAssetType;
    video_type?: string | null;
    status: ProjectAssetStatus;
  prompt: string | null;
  negative_prompt: string | null;
  file_path: string | null;
  model: string | null;
  workflow: string | null;
  seed: number | null;
  attempts: number;
  max_retries: number;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Home dashboard (GET /api/dashboard). Status is derived from real asset
// coverage — the project has no status column of its own:
//   draft = nothing generated yet, in_progress = assets exist,
//   completed = a final cut exists. `generating` overlays a live run.
export type DashboardStatus = "draft" | "in_progress" | "completed";

export interface DashboardProject {
  name: string;
  /** Integer id from the projects table (null when unavailable). */
  project_id: number | null;
  /** Immutable storage folder (null when unknown — fall back to the slug). */
  folder_name: string | null;
  description: string;
  status: DashboardStatus;
  generating: boolean;
  progress: number;
  sceneCount: number;
  imageCount: number;
  videoCount: number;
  refDone: boolean;
  hasFinal: boolean;
  /** ms epoch when the active run started (null when not generating). */
  startedAt: number | null;
  thumbnailUrl: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface DashboardStatistics {
  total: number;
  active: number;
  inProgress: number;
  completed: number;
}

export interface DashboardResponse {
  statistics: DashboardStatistics;
  projects: DashboardProject[];
}

// Combined service health (GET /api/health). Each service is probed
// independently — one being offline never blocks the others.
export interface HealthResponse {
  db: { up: boolean };
  comfy: { up: boolean; queueRunning: number | null; queuePending: number | null; error?: string };
  llm: { up: boolean; error?: string };
}
