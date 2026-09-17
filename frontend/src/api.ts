import type { Scenario, ScenarioInfo, Run, ComfyStatus, AuthUser, OutputsInfo, AssetKind, ProjectAsset, ProjectReference, DashboardResponse, HealthResponse } from "./types";

// Never treat an HTTP error body as data: a 500 {error: ...} object once
// resolved into array state and crashed the gallery (assets.filter is not a
// function). Reject like every other helper in this file; callers already
// handle rejections (they fall back to disk listings / empty states).
const get = async <T,>(url: string) => {
  const r = await fetch(url);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error || `request failed (HTTP ${r.status})`);
  return d as T;
};

// ---------------------------------------------------------------- auth
export type { AuthUser } from "./types";

export const me = async (): Promise<AuthUser> => {
  const r = await fetch("/api/me");
  if (!r.ok) throw new Error("unauthorized");
  return r.json() as Promise<AuthUser>;
};
export const login = (username: string, password: string) =>
  fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).then((r) => (r.ok ? r.json() as Promise<AuthUser> : r.json().then((d) => Promise.reject(new Error(d.error || "login failed")))));
export const logout = () => fetch("/api/logout", { method: "POST" }).then((r) => r.json());

export const listScenarios = () =>
  fetch("/api/scenarios").then(async (r) => {
    const d = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(d))
      throw new Error(d?.error || `project list failed (HTTP ${r.status})`);
    return d as ScenarioInfo[];
  });

// 06-Sep-2025
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDate = (ms: number) => {
  const d = new Date(Number(ms));
  return `${String(d.getDate()).padStart(2, "0")}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
};
// 06-Sep-2026 14:04 (local time)
export const fmtDateTime = (ms: number) => {
  const d = new Date(Number(ms));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const getScenario = (name: string) =>
  fetch(`/api/scenario/${encodeURIComponent(name)}`).then(async (r) => {
    // The backend always replies JSON — but never treat an HTTP error as
    // data: callers used to read `.config` off a 401/404/503 body and render
    // an empty workspace with no error shown.
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || typeof d !== "object" || !("config" in d))
      throw new Error(d?.error || `load failed (HTTP ${r.status})`);
    return d as { name: string; config: Scenario };
  });

// Saved versions of a scenario (every explicit Save = a new version in the DB).
// The server attaches a delta summary per version: v1 lists all scenes (full
// snapshot), v2+ lists only what changed vs the previous version, e.g.
// { refChanged: false, beats: [3] } — so the UI never shows v2 as if all
// scenes were regenerated.
export interface ScenarioVersionInfo {
  version: number;
  created_at: string;
  changes?: { refChanged: boolean; beats: number[] } | null;
}
export const listVersions = (name: string) =>
  get<ScenarioVersionInfo[]>(`/api/scenario/${name}/versions`);
export const getVersion = (name: string, version: number) =>
  get<{ name: string; version: number; config: Scenario; created_at: string }>(
    `/api/scenario/${name}/versions/${version}`);
// Delete one saved version (prompt config). Deleting the latest rolls the
// current config back to the previous version; outputs are untouched.
export const deleteVersion = (name: string, version: number) =>
  fetch(`/api/scenario/${name}/versions/${version}`, { method: "DELETE" }).then((r) =>
    r.ok
      ? r.json() as Promise<{ ok: boolean; deleted: number; latest: number | null }>
      : r.json().then((d) => Promise.reject(new Error(d.error || "delete version failed")))
  );
export const saveScenario = (name: string, config: Scenario) =>
  fetch(`/api/scenario/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  }).then(async (r) => {
    // Never treat an HTTP error as success — callers (Create/Edit dialogs)
    // must show the failure instead of closing as if the data was saved.
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error || `save failed (HTTP ${r.status})`);
    return d as { ok: boolean; version: number | null; project_id: number | null; unchanged?: boolean; updated?: boolean };
  });
export const deleteScenario = (name: string) =>
  fetch(`/api/scenario/${name}`, { method: "DELETE" }).then((r) =>
    r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))
  );

// Rename a project (prompts JSON + outputs dirs + every name-keyed DB row +
// favorites move with it). Blocked server-side while a run is active.
export const renameScenario = (name: string, newName: string) =>
  fetch(`/api/scenario/${name}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newName }),
  }).then((r) =>
    r.ok
      ? r.json() as Promise<{ ok: boolean; name: string }>
      : r.json().then((d) => Promise.reject(new Error(d.error || "rename failed")))
  );

// Predefined video-type presets (system-owned presets/*.md) + per-project
// rule customizations (Scenario.presetRules, stored with the project). The
// server resolves ids to files; the client only ever sends/stores ids plus
// an optional custom rules string that replaces the preset file for that
// project only.
export interface PresetInfo {
  id: string;
  name: string;
  category: string;
  description: string;
}
export interface PresetDetail extends PresetInfo {
  content: string;
}
export const DEFAULT_PRESET_ID = "cinematic";
export const listPresets = () => get<PresetInfo[]>("/api/presets");
// Shared in-flight cache — every Video Type dropdown on screen reuses one
// request instead of each firing its own.
let presetsCache: Promise<PresetInfo[]> | null = null;
export const getPresetsCached = () => {
  if (!presetsCache) {
    presetsCache = listPresets().catch((e) => {
      presetsCache = null;
      throw e;
    });
  }
  return presetsCache;
};
export const getPreset = (id: string) =>
  get<PresetDetail>(`/api/presets/${encodeURIComponent(id)}`);
// Clamp any stored/selected value to a known id (unknown -> default).
export const presetOrDefault = (id: string | undefined | null, list: PresetInfo[]): string =>
  (id && list.some((p) => p.id === id) ? id : DEFAULT_PRESET_ID);

export const setFavorite = (name: string, on: boolean) =>
  fetch("/api/favorites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, on }),
  }).then((r) => r.json() as Promise<{ ok: boolean; names: string[] }>);

// UI theme persisted server-side in data/theme.json (source of truth —
// survives reloads, restarts and browser changes; localStorage is only a
// cache). Shape: { mode: "dark" | "light", color: "" | "#rrggbb" }.
export interface ThemeFile {
  mode: "dark" | "light";
  color: string;
}
export const getTheme = () => get<ThemeFile>("/api/theme");
export const saveTheme = (t: ThemeFile) =>
  fetch("/api/theme", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(t),
  }).then((r) => r.json() as Promise<ThemeFile>);

export type Engine = "ltx" | "wan";

  // Landscape = the main (YouTube-style 16:9) cut; vertical = the 9:16
  // Instagram Reel cut (fresh vertical images + clips in a separate folder).
  export type VideoFormat = "landscape" | "vertical";
  // Catalog cut label stored per project_assets row (video_type): YOUTUBE =
  // landscape main cut, INSTAGRAM = vertical Reel cut.
  export type VideoType = "YOUTUBE" | "INSTAGRAM";

export interface RegenSpec {
  kind: "ref" | "keyframe" | "clip";
  index?: number;
}

// One run request: full run (neither set), stitch-only, or a single-asset
// regen. Queued client-side and drained serially (the server — and the
// ComfyUI queue behind it — accepts only one active run). `format` selects
// the landscape cut (default) or the vertical Instagram Reel cut.
export interface RunRequest {
  stitch?: boolean;
  regen?: RegenSpec | null;
  count?: number;
  engine?: Engine;
  format?: VideoFormat;
}

export const startRun = (scenario: string, opts: { stitch?: boolean; engine?: Engine; format?: VideoFormat; regen?: RegenSpec | null; count?: number } = {}) =>
  fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenario,
      stitch: !!opts.stitch,
      engine: opts.engine || "ltx",
      format: opts.format || "landscape",
      regen: opts.regen || null,
      count: opts.count ?? 1,
    }),
  }).then((r) => r.json() as Promise<{ id: string; folder?: string; error?: string }>);

// Output dir for a storage folder + engine + format. Takes the IMMUTABLE
// folder (project.folder_name), never the display name — pass folder names
// here so renames can't orphan media. Vertical Reel cuts live in
// outputs/<folder>[_wan]_vertical/ so they never touch the main cut.
export const outScenario = (folder: string, engine: Engine, format: VideoFormat = "landscape") =>
  `${folder}${engine === "wan" ? "_wan" : ""}${format === "vertical" ? "_vertical" : ""}`;

// Client-side copy of the server's storage slug (single source of truth is
// lib/variant.mjs — keep byte-identical). Fallback only: the server is
// authoritative and returns the real folder_name everywhere it matters.
export const slugFolder = (s: string) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100) || "project";

// Storage folder for a project reference that may carry folder_name
// (dashboard projects, scenario list entries) — falls back to the slug.
export const folderOf = (p: { name: string; folder_name?: string | null } | null | undefined, fallbackName = "") =>
  p?.folder_name || (p ? slugFolder(p.name) : slugFolder(fallbackName));

// True when an output dir holds the vertical (9:16) cut.
export const isVerticalOut = (dir: string) => String(dir || "").endsWith("_vertical");

export const listRuns = () => get<Run[]>("/api/runs");
export const killRun = (id: string) => fetch(`/api/runs/${id}`, { method: "DELETE" }).then((r) => r.json());
export const comfyStatus = () => get<ComfyStatus>("/api/comfy");
export const listOutputs = (scenario: string) =>
  get<OutputsInfo>(`/api/outputs?scenario=${scenario}`);

// Home dashboard + combined service health (real data, no mocks).
export const getDashboard = () =>
  fetch("/api/dashboard").then((r) =>
    r.ok
      ? r.json() as Promise<DashboardResponse>
      : r.json().then((d) => Promise.reject(new Error(d.error || `HTTP ${r.status}`)))
  );
export const getHealth = () => get<HealthResponse>("/api/health");

// "10 minutes ago" / "3 hours ago" / "2 days ago", falling back to fmtDate.
export const fmtRelative = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(Number(ms))) return "—";
  const diff = Date.now() - Number(ms);
  if (diff < 0) return fmtDate(Number(ms));
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  return fmtDate(Number(ms));
};

// Pick which version of an asset is "main" (used for stitching / clip generation).
export const selectMain = (scenario: string, kind: AssetKind, index: number | null, file: string) =>
  fetch("/api/outputs/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario, kind, index, file }),
  }).then((r) => (r.ok ? r.json() as Promise<OutputsInfo> : r.json().then((d) => Promise.reject(new Error(d.error || "select failed")))));

// Upload an image (data URL) as the scenario's reference — stored as the next
// ref version and selected as main (the pipeline then skips Flux ref generation).
export const uploadRef = (scenario: string, data: string) =>
  fetch("/api/upload/ref", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario, data }),
  }).then((r) => (r.ok ? r.json() as Promise<OutputsInfo> : r.json().then((d) => Promise.reject(new Error(d.error || "upload failed")))));

// Upload an image (data URL) as beat N's keyframe — stored as the next
// keyframe version and selected as main (clip generation then runs i2v
// from the uploaded image).
export const uploadKeyframe = (scenario: string, index: number, data: string) =>
  fetch("/api/upload/keyframe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario, index, data }),
  }).then((r) => (r.ok ? r.json() as Promise<OutputsInfo> : r.json().then((d) => Promise.reject(new Error(d.error || "upload failed")))));

// Re-stitch the final cut from the currently selected main versions.
export const stitchOnly = (scenario: string, engine: Engine = "ltx", format: VideoFormat = "landscape") =>
  fetch("/api/outputs/stitch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario, engine, format }),
  }).then((r) => r.json() as Promise<{ id: string; folder?: string }>);

// Short cut for Instagram Reels/Shorts: trim the output dir's latest final
// cut down to the first `seconds` (30/60/90). Resolves to the trimmed file
// (plus both durations); when the final is already shorter, it resolves to
// the final itself with cut=false (nothing written).
export const cutReel = (dir: string, seconds: 30 | 60 | 90) =>
  fetch("/api/reel-cut", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir, seconds }),
  }).then(
    (r) =>
      r.ok
        ? r.json() as Promise<{ file: string; duration: number; cut: boolean; from: string; fromDuration: number | null }>
        : r.json().then((d) => Promise.reject(new Error(d.error || "cut failed")))
  );

// Ask the local LLM to extend a scenario with the next `count` beats in the story.
export const craftBeat = (config: Scenario, count = 1) =>
  fetch("/api/craft-beat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, count }),
  }).then(
    (r) =>
      r.ok
        ? r.json() as Promise<{ beats?: { title: string; image: string; motion: string }[]; beat?: { title: string; image: string; motion: string } }>
        : r.json().then((d) => Promise.reject(new Error(d.error || "craft beat failed")))
  );

// Ask the local LLM for publishing metadata (title / description /
// hashtags) for a scenario. Stateless — the server persists nothing; the
// caller caches the result per project.
export interface VideoMeta {
  title: string;
  description: string;
  hashtags: string[];
}
export const craftVideoMeta = (config: Scenario) =>
  fetch("/api/video-meta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  }).then((r) =>
    r.ok
      ? r.json() as Promise<VideoMeta>
      : r.json().then((d) => Promise.reject(new Error(d.error || "video metadata failed")))
  );

// Ask the local LLM for a single Master Prompt from a Description + the
// chosen Video Type (presetId / presetRules). Stateless — the Create New
// Project dialog fills its Master Prompt box.
export const craftMasterPrompt = (
  description: string,
  opts: { presetId?: string; presetRules?: string } = {}
) =>
  fetch("/api/master-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description,
      ...(opts.presetId ? { presetId: opts.presetId } : {}),
      ...(opts.presetRules?.trim() ? { presetRules: opts.presetRules } : {}),
    }),
  }).then(async (r) => {
    // The backend always replies JSON — but guard against a stale server or
    // proxy HTML page so the dialog shows the real cause, not a parse error.
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error || `master prompt failed (HTTP ${r.status})`);
    if (!d?.masterPrompt) throw new Error("LM Studio returned an empty master prompt.");
    return d as { masterPrompt: string };
  });

export interface AssetEvent {
  kind: "image" | "video";
  file: string;
  stage: "reference" | "keyframe" | "clip" | "final";
  index?: number;
  /** True for pre-refresh backlog replayed once on SSE connect (reattaching
      after a refresh). Restores counts/gallery; carries no timing — the real
      completion time is unknown, so the client must not stamp it "now". */
  replay?: boolean;
}

// SSE tail of a run's log. Returns a close function.
export function tailRun(
  id: string,
  onChunk: (line: string) => void,
  onDone: (status: string) => void,
  onAsset?: (a: AssetEvent) => void
) {
  const es = new EventSource(`/api/runs/${id}/logs`);
  es.onmessage = (e) => onChunk(JSON.parse(e.data).line);
  if (onAsset) es.addEventListener("asset", (e) => onAsset(JSON.parse(e.data) as AssetEvent));
  es.addEventListener("close", (e) => { onDone(JSON.parse(e.data).status); es.close(); });
  es.onerror = () => {
    // Dead stream (e.g. backend restarted mid-run → unknown id): never retry
    // forever on "running" — surface it as an error instead.
    if (es.readyState === EventSource.CLOSED) {
      try { onChunk("\n[log stream lost — backend restarted?]\n"); onDone("error"); }
      finally { es.close(); }
    }
  };
  return () => es.close();
}

export const outputUrl = (scenario: string, file: string) => `/outputs/${scenario}/${file}`;

// Resource library (the Resource page): user-uploaded images/videos, each
// with an AI-generated prompt. "Use in project" wires one into the exact
// Project workflow — a new project (caption as Master Prompt + pixels as the
// pinned reference visual) or an existing project's reference.
export interface ResourceEntry {
  id: string;
  file: string;
  kind: "image" | "video";
  thumb: string | null;
  prompt: string | null;
  captionError: string | null;
  novision?: boolean;
  created_at: string;
}
export const resourceUrl = (file: string) => `/resources/${file}`;
export const listResources = () => get<ResourceEntry[]>("/api/resources");
export const uploadResource = (data: string) =>
  fetch("/api/resources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  }).then(async (r) => {
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error || `upload failed (HTTP ${r.status})`);
    return d as ResourceEntry;
  });
// (Re)generate the AI prompt by having the local vision model read the
// image (or the video's middle frame). Rejects with `vision: false` on the
// error when no vision model is loaded, so the UI can point at Qwen3-VL.
export const captionResource = (id: string) =>
  fetch(`/api/resources/${id}/caption`, { method: "POST" }).then(async (r) => {
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error(d?.error || `caption failed (HTTP ${r.status})`) as Error & { vision?: boolean };
      if (d?.vision === false) e.vision = false;
      throw e;
    }
    return d as ResourceEntry;
  });
export const saveResourcePrompt = (id: string, prompt: string) =>
  fetch(`/api/resources/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  }).then(async (r) => {
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error || `save failed (HTTP ${r.status})`);
    return d as ResourceEntry;
  });
export const deleteResource = (id: string) =>
  fetch(`/api/resources/${id}`, { method: "DELETE" }).then(async (r) => {
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error || `delete failed (HTTP ${r.status})`);
    return d as { ok: boolean; deleted: string };
  });
export const useResource = (
  id: string,
  opts: { mode: "new"; name: string } | { mode: "ref"; project: string }
) =>
  fetch(`/api/resources/${id}/use`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  }).then(async (r) => {
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error || `use failed (HTTP ${r.status})`);
    return d as { ok: boolean; mode: string; name?: string; project?: string; file?: string };
  });
// Save the WHOLE library as one project: one beat per resource (oldest
// first), each AI prompt as its scene image prompt, first prompt as Master
// Prompt, first pixels as the pinned reference — through the same project
// save path as every other project (scenarios row + prompts JSON + projects
// row + one KEYFRAME/VIDEO project_assets row per scene). Media lands under
// the pipeline filename pattern so Keyframes → clips, Story Board and
// Rendered Clip resolve by name.
export const buildProjectFromResources = (name: string) =>
  fetch("/api/resources/build-project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(async (r) => {
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error || `save failed (HTTP ${r.status})`);
    return d as {
      ok: boolean; name: string; folder: string; scenes: number;
      version: number | null; project_id: number | null; warnings: string[];
    };
  });

// Reference visuals for a project (project_references — one row per
// generation/upload, is_main = UI-selected main). Optional dir narrows to
// one output dir; without it every cut is returned.
export const listReferences = (name: string, dir?: string) =>
  get<ProjectReference[]>(
    `/api/project/${name}/references${dir ? `?dir=${dir}` : ""}`
  );
// Narrow project_assets rows for a project (one row per asset:
// KEYFRAME/VIDEO per beat, FINAL per stitch — references live in
// project_references, see listReferences). Version defaults to latest.
// Versions are DELTA-based (v2 may store only the changed beat), so this
// returns the EFFECTIVE state by default — the latest applicable row per
// (beat, asset type) with version <= requested — and the UI keeps showing
// all scenes. Pass mode "exact" for the raw delta rows stored at a version.
export const listProjectAssets = (name: string, version?: number, mode?: "effective" | "exact", videoType?: VideoType) => {
  const params = new URLSearchParams();
  if (version != null) params.set("version", String(version));
  if (mode === "exact") params.set("mode", "exact");
  if (videoType) params.set("video_type", videoType);
  const q = params.toString();
  return get<ProjectAsset[]>(`/api/project/${name}/assets${q ? `?${q}` : ""}`);
};
