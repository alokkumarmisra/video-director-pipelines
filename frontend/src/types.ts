export interface Beat {
  title: string;
  image: string;
  motion: string;
}

export interface Scenario {
  description?: string;
  character?: string;
  referencePrompt: string;
  duration: number;
  sequence: Beat[];
  // Predefined video-type preset id (presets/presets.json). Resolved to
  // presets/*.md rules at craft/generation time — only the id is stored,
  // never the .md content. Absent = default preset (cinematic).
  presetId?: string;
  // Per-project customization of the video-type rules. When non-empty, this
  // text REPLACES the preset's .md content for this project only (craft +
  // beat extension). Empty/absent = use the preset default. The system-owned
  // presets/*.md files are never modified.
  presetRules?: string;
}

export interface ScenarioInfo {
  name: string;
  isSequence: boolean;
  mtimeMs: number;
  favorite?: boolean;
  /** Integer id from the projects table (null in SQLite mode / unknown). */
  project_id?: number | null;
}

export interface Run {
  id: string;
  scenario: string;
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
}

export interface OutputsInfo {
  files: string[];
  versions: VersionsInfo;
  mains: MainsInfo;
}

export type AssetKind = "ref" | "keyframe" | "clip";

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
