// Devotional Studio API client. Same conventions as api.ts: thin fetch
// wrappers that reject on !ok (never resolve error bodies as data).
export type DevotionalKind = "character" | "location" | "prop" | "style";
export type DevotionalStatus = "draft" | "generating" | "review" | "approved" | "archived";

export interface DevotionalAsset {
  id: string;
  kind: DevotionalKind;
  parent_id: string | null;
  name: string;
  aliases: string[];
  category: string;
  description: string;
  identity: Record<string, unknown>;
  style_id: string | null;
  negative_prompt: string;
  // Saved generation-prompt override (Flux still + LTX clip). Blank means
  // auto — the server falls back to the canonical description + traits.
  prompt: string;
  status: DevotionalStatus;
  version: number;
  locked: boolean;
  continuity: string;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  // List-view generated-media previews (latest existing still + clip).
  // Null when nothing generated yet — cards render a placeholder instead.
  preview_image?: string | null;
  preview_image_kind?: string | null;
  preview_video?: string | null;
  file_count?: number;
  // Every existing still/clip (newest-first) for the Keyframes→clips-style
  // Image & video section (v1/v2 version chips + per-kind regen).
  image_versions?: DevotionalMediaVersion[];
  video_versions?: DevotionalMediaVersion[];
}

export interface DevotionalMediaVersion {
  id: number;
  url: string;
  file_kind: string;
}

export interface DevotionalFile {
  id: number;
  asset_id: string;
  file_path: string;
  file_kind: string;
  source: "generated" | "upload";
  prompt: string | null;
  workflow: string | null;
  model: string | null;
  url: string;
  exists: boolean;
  created_at?: string;
}

export interface DevotionalDetail extends DevotionalAsset {
  files: DevotionalFile[];
  versions: { asset_id: string; version: number; note: string; created_at: string }[];
  children: { id: string; name: string; status: DevotionalStatus }[];
  missing: string[];
}

export interface DevotionalStats {
  counts: Record<DevotionalKind, number>;
  approved: number;
  drafts: number;
  files: number;
  jobs: Record<string, number>;
  failedJobs: number;
  projectsUsing: number;
  recent: DevotionalAsset[];
}

const req = async <T,>(url: string, opts?: RequestInit): Promise<T> => {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error || `request failed (HTTP ${r.status})`);
  return d as T;
};

const params = (o: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const getDevotionalStats = () => req<DevotionalStats>("/api/devotional/stats");

export interface DevotionalList {
  total: number;
  page: number;
  pageSize: number;
  assets: DevotionalAsset[];
}
export const listDevotionalAssets = (o: {
  kind?: string; status?: string; category?: string; search?: string;
  sort?: string; page?: number; pageSize?: number;
} = {}) => req<DevotionalList>(`/api/devotional/assets${params(o)}`);

export const getDevotionalAsset = (id: string) =>
  req<DevotionalDetail>(`/api/devotional/assets/${encodeURIComponent(id)}`);

export const createDevotionalAsset = (body: Record<string, unknown>) =>
  req<DevotionalAsset>("/api/devotional/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const updateDevotionalAsset = (id: string, body: Record<string, unknown>) =>
  req<DevotionalAsset>(`/api/devotional/assets/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const setDevotionalStatus = (id: string, status: DevotionalStatus) =>
  req<DevotionalAsset>(`/api/devotional/assets/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });

export const lockDevotionalAsset = (id: string, lock: boolean) =>
  req<DevotionalAsset>(`/api/devotional/assets/${encodeURIComponent(id)}/${lock ? "lock" : "unlock"}`, {
    method: "POST",
  });

export const newDevotionalVersion = (id: string, note?: string) =>
  req<DevotionalAsset>(`/api/devotional/assets/${encodeURIComponent(id)}/version`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: note || "" }),
  });

export const restoreDevotionalVersion = (id: string, version: number) =>
  req<DevotionalAsset>(`/api/devotional/assets/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });

export const archiveDevotionalAsset = (id: string, hard = false) =>
  req<unknown>(`/api/devotional/assets/${encodeURIComponent(id)}${hard ? "?hard=1" : ""}`, {
    method: "DELETE",
  });

export const uploadDevotionalFile = (id: string, data: string, fileKind = "master") =>
  req<DevotionalFile>(`/api/devotional/assets/${encodeURIComponent(id)}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, fileKind }),
  });

export const generateDevotionalReference = (id: string, body: { prompt?: string; fileKind?: string }) =>
  req<{ ok: boolean; job: string; status: string }>(
    `/api/devotional/assets/${encodeURIComponent(id)}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

// One-click still + showcase clip: queues a Flux still (only when the asset
// has no reference image yet) plus an LTX clip behind it. image is
// "queued" | "reused".
export const generateDevotionalMedia = (id: string, body: { prompt?: string; fileKind?: string; duration?: number }) =>
  req<{ ok: boolean; job: string; status: string; jobs: string[]; image: string }>(
    `/api/devotional/assets/${encodeURIComponent(id)}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, both: true }),
    });

// Clip-only regen: queues just the LTX showcase clip (no still, no status
// change) — the video regen button in the Image & video section.
export const generateDevotionalClip = (id: string, body: { prompt?: string; duration?: number }) =>
  req<{ ok: boolean; job: string; status: string; jobs: string[]; image: string }>(
    `/api/devotional/assets/${encodeURIComponent(id)}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, only: "video" }),
    });

export const deleteDevotionalFile = (fileId: number) =>
  req<{ ok: boolean }>(`/api/devotional/files/${fileId}`, { method: "DELETE" });

export interface DevotionalJob {
  id: string;
  asset_id: string;
  kind: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  prompt: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
export const listDevotionalJobs = (status?: string, limit = 30, ids?: string[]) => {
  const p = params({ status: status || "", limit });
  const q = ids?.length ? `${p ? `${p}&` : "?"}ids=${ids.map(encodeURIComponent).join(",")}` : p;
  return req<DevotionalJob[]>(`/api/devotional/jobs${q}`);
};

export const cancelDevotionalJob = (jobId: string) =>
  req<{ ok: boolean }>(`/api/devotional/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });

export const seedDevotionalLibrary = () =>
  req<{ ok: boolean; created: string[]; skipped: string[] }>("/api/devotional/seed", { method: "POST" });

export interface DevotionalResolve {
  characters: DevotionalAsset[];
  location: DevotionalAsset | null;
  props: DevotionalAsset[];
  style: DevotionalAsset | null;
  missing: { role: string; id: string }[];
}
export const resolveDevotionalScene = (scene: Record<string, unknown>) =>
  req<DevotionalResolve>("/api/devotional/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene }),
  });

export interface DevotionalPrompt {
  positive: string;
  negative: string;
  assets: {
    characters: { id: string; version: number }[];
    location: { id: string; version: number } | null;
    props: { id: string; version: number }[];
    style: { id: string; version: number } | null;
  };
}
export const previewDevotionalPrompt = (scene: Record<string, unknown>) =>
  req<DevotionalPrompt>("/api/devotional/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene }),
  });

export const saveDevotionalSceneLinks = (board_id: string, scene_number: number, links: { asset_id: string; role: string }[]) =>
  req<{ ok: boolean; saved: unknown[] }>("/api/devotional/scene-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board_id, scene_number, links }),
  });

export const getDevotionalBoardLinks = (boardId: string) =>
  req<{ board_id: string; scene_number: number; asset_id: string; asset_version: number; role: string }[]>(
    `/api/devotional/boards/${encodeURIComponent(boardId)}/links`);

export const getDevotionalUsage = (id: string) =>
  req<{ asset_id: string; scenes: { board_id: string; scene_number: number; asset_version: number; role: string }[]; projects: { name: string; asset_version: number; scenes: number[] }[] }>(
    `/api/devotional/assets/${encodeURIComponent(id)}/usage`);

export const recordDevotionalUsage = (project: string, assets: { asset_id: string; scenes?: number[] }[]) =>
  req<{ ok: boolean; saved: number }>("/api/devotional/project-usage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, assets }),
  });

export const getDevotionalHealth = () =>
  req<{ db: { up: boolean }; comfy: { up: boolean; error: string | null }; storage: { up: boolean; root: string; error?: string } }>(
    "/api/devotional/health");

export const exportDevotional = () =>
  req<{ exported_at: string; assets: DevotionalAsset[]; files: unknown[]; links: unknown[] }>("/api/devotional/export");

export const importDevotional = (assets: unknown[], overwrite = false) =>
  req<{ ok: boolean; created: string[]; updated: string[]; skipped: string[] }>("/api/devotional/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assets, overwrite }),
  });
