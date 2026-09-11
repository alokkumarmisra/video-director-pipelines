import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteScenario,
  getDashboard,
  getScenario,
  saveScenario,
} from "../api";
import type { DashboardProject, DashboardResponse } from "../types";
import CreateProjectDialog from "./CreateProjectDialog";
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
  const dataRef = useRef<DashboardResponse | null>(null);
  dataRef.current = data;
  useEffect(() => {
    if (active) load(dataRef.current?.projects.length ? true : false);
  }, [active, load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      load(true);
    }, 15000);
    return () => clearInterval(t);
  }, [active, load]);

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
      if (!window.confirm(`Delete project "${name}"?\nIts generated outputs will be removed too. This cannot be undone.`))
        return;
      try {
        await deleteScenario(name);
        onProjectsChanged();
        await load();
      } catch (e) {
        window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [load, onProjectsChanged]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = (data?.projects ?? []).filter(
      (p) =>
        (filter === "all" || p.status === filter) &&
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
                onOpen={onOpen}
                onDuplicate={handleDuplicate}
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
    </div>
  );
}
