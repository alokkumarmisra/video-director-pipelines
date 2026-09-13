import type { Scenario, ScenarioInfo, Run, ComfyStatus, AuthUser, OutputsInfo, AssetKind, ProjectAsset, DashboardResponse, HealthResponse } from "./types";

const get = async <T,>(url: string) => (await fetch(url)).json() as Promise<T>;

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

export const listScenarios = () => get<ScenarioInfo[]>("/api/scenarios");

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
export const getScenario = (name: string) => get<{ name: string; config: Scenario }>(`/api/scenario/${name}`);

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
  }).then((r) => r.json() as Promise<{ ok: boolean; version: number | null; project_id: number | null; unchanged?: boolean }>);
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

export interface RegenSpec {
  kind: "ref" | "keyframe" | "clip";
  index?: number;
}

// One run request: full run (neither set), stitch-only, or a single-asset
// regen. Queued client-side and drained serially (the server — and the
// ComfyUI queue behind it — accepts only one active run).
export interface RunRequest {
  stitch?: boolean;
  regen?: RegenSpec | null;
  count?: number;
  engine?: Engine;
}

export const startRun = (scenario: string, opts: { stitch?: boolean; engine?: Engine; regen?: RegenSpec | null; count?: number } = {}) =>
  fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenario,
      stitch: !!opts.stitch,
      engine: opts.engine || "ltx",
      regen: opts.regen || null,
      count: opts.count ?? 1,
    }),
  }).then((r) => r.json() as Promise<{ id: string; error?: string }>);

// Output dir for a scenario+engine (Wan runs write to outputs/<scenario>_wan/).
export const outScenario = (scenario: string, engine: Engine) =>
  engine === "wan" ? `${scenario}_wan` : scenario;

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
export const stitchOnly = (scenario: string, engine: Engine = "ltx") =>
  fetch("/api/outputs/stitch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario, engine }),
  }).then((r) => r.json() as Promise<{ id: string }>);

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

export interface AssetEvent {
  kind: "image" | "video";
  file: string;
  stage: "reference" | "keyframe" | "clip" | "final";
  index?: number;
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

// Narrow project_assets rows for a project (one row per asset:
// REFERENCE beat 0, KEYFRAME/VIDEO per beat). Version defaults to latest.
// Versions are DELTA-based (v2 may store only the changed beat), so this
// returns the EFFECTIVE state by default — the latest applicable row per
// (beat, asset type) with version <= requested — and the UI keeps showing
// all scenes. Pass mode "exact" for the raw delta rows stored at a version.
export const listProjectAssets = (name: string, version?: number, mode?: "effective" | "exact") =>
  get<ProjectAsset[]>(
    `/api/project/${name}/assets${version != null ? `?version=${version}` : ""}${mode === "exact" ? (version != null ? "&mode=exact" : "?mode=exact") : ""}`
  );
