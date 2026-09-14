import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteScenario,
  getDashboard,
  getScenario,
  listOutputs,
  outputUrl,
  saveScenario,
  startRun,
} from "../api";
import type { DashboardProject, DashboardResponse, OutputsInfo } from "../types";
import CreateProjectDialog from "./CreateProjectDialog";
import EditProjectDialog from "./EditProjectDialog";
import ProjectCard from "./ProjectCard";
import { IconAlert, IconClapper, IconPlus, IconRefresh, IconSearch, Spinner } from "./Icons";

type LoadState = "loading" | "success" | "empty" | "error";
type Filter = "all" | DashboardProject["status"];
type Sort = "updated" | "created" | "name-asc" | "name-desc";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "in_progress", label: "In Progress" },
  { id: "completed", label: "Completed" },
];

const SORTS: { id: Sort; label: string }[] = [
  { id: "updated", label: "Recently Updated" },
  { id: "created", label: "Recently Created" },
  { id: "name-asc", label: "Name A–Z" },
  { id: "name-desc", label: "Name Z–A" },
];

function uniqueName(base: string, taken: Set<string>) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base}_${i}`;
    if (!taken.has(n)) return n;
  }
}

function SkeletonGrid() {
  return (
    <div className="proj-grid" aria-label="Loading projects">
      {Array.from({ length: 6 }, (_, i) => (
        <div className="card proj-card skeleton" key={i} aria-hidden="true">
          <div className="sk-media" />
          <div className="sk-line sk-title" />
          <div className="sk-line" />
          <div className="sk-line sk-short" />
        </div>
      ))}
    </div>
  );
}

export default function HomePage({
  active,
  onOpen,
  onProjectsChanged,
}: {
  // False while the workspace is shown (Home stays mounted but hidden, so a
  // running generation keeps working). Dashboard reloads on every return.
  active: boolean;
  onOpen: (name: string) => void;
  onProjectsChanged: () => void;
}) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("updated");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editName, setEditName] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState("loading");
    try {
      const d = await getDashboard();
      setData(d);
      setState(d.projects.length ? "success" : "empty");
    } catch {
      // A background refresh must never wipe already-shown data.
      if (!quiet) {
        setData(null);
        setState("error");
      }
    }
  }, []);

  // Reload on every return to Home; live-update while visible (a generation
  // started in the workspace keeps running and flips cards to Generating).
  // Stale-while-revalidate: returning with cached cards refreshes quietly in
  // the background instead of flashing the full skeleton grid.
  // Poll cadence adapts: 5s while any project is generating (live % ticks and
  // the card flips off Generating promptly at finish), 15s otherwise.
  const dataRef = useRef<DashboardResponse | null>(null);
  dataRef.current = data;
  const anyGenerating = (data?.projects ?? []).some((p) => p.generating);
  useEffect(() => {
    if (active) load(dataRef.current?.projects.length ? true : false);
  }, [active, load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      load(true);
    }, anyGenerating ? 5000 : 15000);
    return () => clearInterval(t);
  }, [active, anyGenerating, load]);

  const handleDuplicate = useCallback(
    async (name: string) => {
      if (!data) return;
      try {
        const src = await getScenario(name);
        const target = uniqueName(`${name}_copy`, new Set(data.projects.map((p) => p.name)));
        await saveScenario(target, src.config);
        onProjectsChanged();
        await load();
      } catch (e) {
        window.alert(`Duplicate failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [data, load, onProjectsChanged]
  );

  const handleDelete = useCallback(
    async (name: string) => {
      const proj = data?.projects.find((p) => p.name === name);
      if (proj?.generating) {
        window.alert(`"${name}" is still generating — stop the run before deleting.`);
        return;
      }
      if (!window.confirm(`Delete project "${name}"?\nIts generated outputs will be removed too. This cannot be undone.`))
        return;
      if (busyAction) return;
      setBusyAction(`delete:${name}`);
      try {
        await deleteScenario(name);
        onProjectsChanged();
        await load(true);
      } catch (e) {
        window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, data, load, onProjectsChanged]
  );

  // Start a full generation run for the project (reference + keyframes +
  // clips + final stitch) and open the workspace so progress is visible.
  // The server (and the ComfyUI queue behind it) accepts only one active
  // run — a second click while anything generates reports the error.
  const handleMakeClip = useCallback(
    async (name: string) => {
      if (busyAction) return;
      const proj = data?.projects.find((p) => p.name === name);
      if (proj?.generating) {
        // Already running — just open the workspace so progress is visible.
        onOpen(name);
        return;
      }
      setBusyAction(`clip:${name}`);
      try {
        const d = await startRun(name, { engine: "ltx" });
        if (d.error) throw new Error(d.error);
        if (!d.id) throw new Error("server did not start a run");
        onProjectsChanged();
        await load(true);
        onOpen(name);
      } catch (e) {
        window.alert(`Make a clip failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, data, load, onOpen, onProjectsChanged]
  );

  // Download the project's best finished file: the stitched final cut when
  // present, else any clip, else a still image. Checks both the ltx dir and
  // the _wan dir (Wan runs write to outputs/<name>_wan/).
  const handleDownload = useCallback(async (name: string) => {
    if (busyAction) return;
    setBusyAction(`download:${name}`);
    try {
      const pick = (info: OutputsInfo | null): string | null => {
        if (!info) return null;
        if (info.mains?.final) return info.mains.final;
        const finals = (info.versions?.final ?? []).map((v) => v.file);
        if (finals.length) return finals[finals.length - 1];
        const finalFiles = info.files.filter((f) => /\.mp4$/i.test(f) && /_final/i.test(f));
        if (finalFiles.length) return finalFiles[finalFiles.length - 1];
        const anyVideo = info.files.filter((f) => /\.mp4$/i.test(f));
        if (anyVideo.length) return anyVideo[anyVideo.length - 1];
        return info.files.filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))[0] ?? null;
      };
      const ltx = await listOutputs(name).catch(() => null);
      let dir = name;
      let file = pick(ltx);
      if (!file) {
        const wan = await listOutputs(`${name}_wan`).catch(() => null);
        const wanFile = pick(wan);
        if (wanFile) {
          dir = `${name}_wan`;
          file = wanFile;
        }
      }
      if (!file) {
        window.alert(`Nothing to download yet for "${name}" — use Make a clip first.`);
        return;
      }
      // Fetch as a blob (same-origin, carries the session cookie) so the
      // file actually saves instead of navigating, and auth failures
      // surface as an error instead of a downloaded login page.
      const resp = await fetch(outputUrl(dir, file));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = file;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (e) {
      window.alert(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = (data?.projects ?? []).filter(
      (p) =>
        // A live run counts as In Progress for filtering even before its
        // first asset lands (coverage status would still say Draft).
        (filter === "all" || p.status === filter || (filter === "in_progress" && p.generating)) &&
        (!q || p.name.toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q))
    );
    list = [...list].sort((a, b) => {
      if (sort === "name-asc") return a.name.localeCompare(b.name);
      if (sort === "name-desc") return b.name.localeCompare(a.name);
      if (sort === "created") return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
    return list;
  }, [data, query, filter, sort]);

  const stats = data?.statistics ?? { total: 0, active: 0, inProgress: 0, completed: 0 };

  return (
    <div className="home">
      <section className="card hero">
        <div className="hero-text">
          <h1>Create your next AI video</h1>
          <p>Turn your songs, lyrics and creative ideas into cinematic AI video scenes.</p>
        </div>
        <div className="hero-side">
          <button className="primary hero-cta" onClick={() => setDialogOpen(true)}>
            <IconPlus size={14} /> Create New Project
          </button>
        </div>
      </section>

      <section className="stat-row" aria-label="Project statistics">
        {(
          [
            ["Total Projects", stats.total],
            ["Active", stats.active],
            ["In Progress", stats.inProgress],
            ["Completed", stats.completed],
          ] as const
        ).map(([label, value]) => (
          <div className="card stat" key={label}>
            <span className="stat-value">{state === "loading" ? "—" : value}</span>
            <span className="stat-label">{label}</span>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="toolbar">
          <h2>Recent Projects</h2>
          <div className="toolbar-controls">
            <div className="search-wrap">
              <IconSearch size={14} />
              <input
                type="search"
                aria-label="Search projects"
                placeholder="Search projects…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select aria-label="Filter by status" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              {FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <select aria-label="Sort projects" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {state === "loading" && <SkeletonGrid />}
        {state === "error" && (
          <div className="empty">
            <span className="empty-icon">
              <IconAlert size={20} />
            </span>
            <span className="empty-title">Unable to load projects</span>
            <span className="empty-sub">Check the database connection and try again.</span>
            <button className="ghost" onClick={() => load()}>
              <IconRefresh size={13} /> Retry
            </button>
          </div>
        )}
        {state === "empty" && (
          <div className="empty">
            <span className="empty-icon">
              <IconClapper size={20} />
            </span>
            <span className="empty-title">No projects yet</span>
            <span className="empty-sub">
              Create your first AI video project and turn your ideas into scenes.
            </span>
            <button className="primary" onClick={() => setDialogOpen(true)}>
              <IconPlus size={14} /> Create New Project
            </button>
          </div>
        )}
        {state === "success" && visible.length === 0 && (
          <div className="empty">
            <span className="empty-title">No projects match</span>
            <span className="empty-sub">Try a different search, filter or sort.</span>
          </div>
        )}
        {state === "success" && visible.length > 0 && (
          <div className="proj-grid">
            {visible.map((p) => (
              <ProjectCard
                key={p.name}
                project={p}
                busyAction={busyAction}
                onOpen={onOpen}
                onEdit={(n) => {
                  if (busyAction) return;
                  setEditName(n);
                }}
                onDuplicate={handleDuplicate}
                onMakeClip={handleMakeClip}
                onDownload={handleDownload}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
        {state === "loading" && (
          <div className="home-loading-note">
            <Spinner size={13} /> Loading projects…
          </div>
        )}
      </section>

      <CreateProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(n) => {
          onProjectsChanged();
          load();
          onOpen(n);
        }}
      />
      <EditProjectDialog
        name={editName}
        onClose={() => setEditName(null)}
        onSaved={() => {
          setEditName(null);
          onProjectsChanged();
          load();
        }}
      />
    </div>
  );
}
