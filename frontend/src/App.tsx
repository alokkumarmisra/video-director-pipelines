import { useCallback, useEffect, useRef, useState } from "react";
import { listScenarios, getScenario, getDashboard, saveScenario, deleteScenario, setFavorite, comfyStatus, getHealth, outScenario, me, logout, fmtDateTime, type Engine, type AuthUser, type RegenSpec, type RunRequest } from "./api";
import type { Scenario, ScenarioInfo, ComfyStatus, AssetKind, DashboardProject, HealthResponse } from "./types";
import ScenarioEditor from "./components/ScenarioEditor";
import ShotList from "./components/ShotList";
import RunPanel from "./components/RunPanel";
import GenerationProgressBar, { emptyProgress, loadPace, type GenerationProgress } from "./components/GenerationProgressBar";
import OutputGallery from "./components/OutputGallery";
import CraftPanel from "./components/CraftPanel";
import HomePage from "./components/HomePage";
import Login from "./components/Login";
import { IconCheck, IconClapper, IconFolder, IconLogOut, IconMoon, IconPanel, IconStar, IconSun, IconTrash, Spinner } from "./components/Icons";

export type Theme = "dark" | "light";

// Queue dedupe: same stitch flag, same regen target (ref count matters —
// batch sizes differ; keyframe/clip always run once).
function sameRequest(a: RunRequest, b: RunRequest): boolean {
  return (
    !!a.stitch === !!b.stitch &&
    (a.regen?.kind ?? null) === (b.regen?.kind ?? null) &&
    (a.regen?.index ?? null) === (b.regen?.index ?? null) &&
    (a.regen?.kind === "ref" ? (a.count ?? 1) : 0) === (b.regen?.kind === "ref" ? (b.count ?? 1) : 0)
  );
}
const AVATAR_TONES = 8;
// Deterministic per-project avatar tone: hash the name into one of 8
// `.scenario-avatar.av-N` palettes so each project keeps its own color.
function avatarTone(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % AVATAR_TONES;
}

export default function App() {
  const [auth, setAuth] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("ss-theme") === "light" ? "light" : "dark"
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ss-theme", theme);
  }, [theme]);

  useEffect(() => {
    me()
      .then((r) => setAuth(r))
      .catch(() => setAuth(null))
      .finally(() => setChecking(false));
  }, []);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const handleLogout = () => {
    logout().catch(() => {});
    setAuth(null);
  };

  if (checking) {
    return (
      <div className="login-screen">
        <div className="login-bg" aria-hidden="true" />
        <div className="login-checking"><Spinner size={18} /></div>
      </div>
    );
  }

  if (!auth) return <Login onAuthed={setAuth} />;

  return (
    <Studio
      user={auth.user}
      onLogout={handleLogout}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
}

function Studio({ user, onLogout, theme, onToggleTheme }: {
  user: string;
  onLogout: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [view, setView] = useState<"home" | "workspace">("home");
  const [name, setName] = useState("");
  const [cfg, setCfg] = useState<Scenario | null>(null);
  const [cfgLoading, setCfgLoading] = useState(false);
  // Last fully loaded project (name + config updated together). The sidebar
  // highlights `name` immediately, but all workspace content renders from
  // `shown` — so clicking another project never blanks/flashes the page: the
  // old project stays mounted until the new config has arrived.
  const [shownName, setShownName] = useState("");
  // True while the newly selected project's config is loading. The old
  // content stays mounted (dimmed) until it lands — no blank flash.
  const [draft, setDraft] = useState<{ name: string; config: Scenario; project_id?: number | null } | null>(null);
  const [engine, setEngine] = useState<Engine>("ltx");
  const [comfy, setComfy] = useState<ComfyStatus | null>(null);
  // Combined DB/LLM/ComfyUI health for the topbar status pills (same
  // /api/health payload the Home hero used to show — now always visible).
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [runActive, setRunActive] = useState(false);
  const [runScenario, setRunScenario] = useState<string | null>(null);
  const [regenTarget, setRegenTarget] = useState<{ kind: AssetKind; index?: number } | null>(null);
  const [pendingRun, setPendingRun] = useState<{ nonce: number; stitch?: boolean; regen?: RegenSpec | null; count?: number; engine?: Engine } | null>(null);
  // Serial run queue: Regen clicks that land while a run is active wait here
  // (the server rejects concurrent runs) and fire one-by-one as each run
  // ends. Only the actively targeted button is disabled — the rest stay
  // clickable so shots can be queued up.
  const [runQueue, setRunQueue] = useState<RunRequest[]>([]);
  const [genProgress, setGenProgress] = useState<GenerationProgress>(emptyProgress);
  // Server-side fallback: a run started in another tab (or before a page
  // refresh) leaves this tab's RunPanel idle while the backend — and the
  // Home → Recent Projects card — still report generating. Poll the same
  // dashboard payload so the menu bar shows the same thing.
  const [remoteGen, setRemoteGen] = useState<GenerationProgress | null>(null);
  // Ticking clock so the menu bar's Elapsed/Remaining stay live between the
  // 15s dashboard polls (1s cadence = a real-time countdown).
  const [now, setNow] = useState(() => Date.now());
  // Per-project asset coverage for the Projects sidebar (images/videos/assets
  // in small type on the right of each row). Same dashboard payload as the
  // topbar progress — no extra endpoint.
  const [dashMap, setDashMap] = useState<Map<string, DashboardProject>>(new Map());

  // Live countdown from a linear pace estimate: estimated total duration
  // minus elapsed time. The old formula (elapsed/done*remaining) froze
  // between polls — and even grew while % was stale; subtracting elapsed
  // makes Remaining tick down every second instead.
  const liveEta = (elapsedMs: number, done: number, total: number): number | null => {
    if (!(elapsedMs > 0) || !(done > 0) || !(total > done)) return null;
    return Math.max(0, Math.round((elapsedMs / done) * total - elapsedMs));
  };
  // Split a total remaining estimate across the Images / Videos rows in
  // proportion to each row's unfinished work (no per-asset timings exist
  // remotely), so both row countdowns tick down live and sum to the total.
  const splitEta = (totalRem: number | null, remA: number, remB: number): [number | null, number | null] => {
    if (totalRem == null || remA + remB <= 0) return [null, null];
    return [
      Math.max(0, Math.round((totalRem * remA) / (remA + remB))),
      Math.max(0, Math.round((totalRem * remB) / (remA + remB))),
    ];
  };
  // Remote Time Remaining for a generating project: live linear pace from
  // real asset counts while assets are landing; historical pace (previous
  // runs) seeds the countdown before the first asset lands so it still
  // ticks in real time instead of sitting at zero.
  const remoteEta = (
    elapsedMs: number,
    imgDone: number, imgTotal: number,
    vidDone: number, vidTotal: number,
  ): { etaMs: number | null; imagesEtaMs: number | null; videosEtaMs: number | null } => {
    const remI = Math.max(0, imgTotal - imgDone);
    const remV = Math.max(0, vidTotal - vidDone);
    let eta = liveEta(elapsedMs, imgDone + vidDone, imgTotal + vidTotal);
    if (eta == null && elapsedMs > 0 && remI + remV > 0) {
      const pace = loadPace();
      if (pace.img != null || pace.vid != null) {
        const est = remI * (pace.img ?? 0) + remV * (pace.vid ?? 0);
        if (est > 0) eta = Math.max(0, Math.round(est - elapsedMs));
      }
    }
    const [imagesEtaMs, videosEtaMs] = splitEta(eta, remI, remV);
    return { etaMs: eta, imagesEtaMs, videosEtaMs };
  };
  useEffect(() => {
    if (!remoteGen || genProgress.status === "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [remoteGen, genProgress.status]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const d = await getDashboard();
        if (cancelled) return;
        setDashMap(new Map((d.projects || []).map((p) => [p.name, p])));
        const g = (d.projects || []).find((p) => p.generating);
        if (!g) {
          setRemoteGen(null);
          return;
        }
        const startedAt = g.startedAt ?? null;
        const at = Date.now();
        const elapsedMs = startedAt != null ? Math.max(0, at - startedAt) : 0;
        // Linear fallback ETA from real asset counts (no per-asset timings
        // available remotely) — estimated total minus elapsed, split across
        // the Images / Videos rows.
        const imagesDone = (g.refDone ? 1 : 0) + g.imageCount;
        const imagesTotal = 1 + g.sceneCount;
        const videosDone = g.videoCount;
        const videosTotal = g.sceneCount;
        const { etaMs, imagesEtaMs, videosEtaMs } = remoteEta(
          elapsedMs, imagesDone, imagesTotal, videosDone, videosTotal);
        setRemoteGen({
          ...emptyProgress,
          status: "running",
          pct: g.progress,
          scene: null,
          totalScenes: g.sceneCount || null,
          imagesDone,
          imagesTotal,
          videosDone,
          videosTotal,
          etaMs,
          imagesEtaMs,
          videosEtaMs,
          elapsedMs,
          startedAt,
          scenario: g.name,
        });
      } catch {
        if (!cancelled) setRemoteGen(null);
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Live local run wins; otherwise mirror whatever the server reports as
  // generating (same source as the Home card); otherwise keep local
  // done/error/idle state.
  // Remote fallback is re-derived every tick so Elapsed/Remaining count up
  // live from the server-reported start time between dashboard polls.
  const liveRemoteGen = remoteGen && genProgress.status !== "running"
    ? (() => {
        if (remoteGen.startedAt == null) return remoteGen;
        const elapsedMs = Math.max(0, now - remoteGen.startedAt);
        const { etaMs, imagesEtaMs, videosEtaMs } = remoteEta(
          elapsedMs,
          remoteGen.imagesDone, remoteGen.imagesTotal,
          remoteGen.videosDone, remoteGen.videosTotal);
        return { ...remoteGen, elapsedMs, etaMs, imagesEtaMs, videosEtaMs };
      })()
    : remoteGen;
  const topProgress =
    genProgress.status === "running" ? genProgress : (liveRemoteGen ?? genProgress);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => localStorage.getItem("ss-sidebar") !== "closed");
  const toggleSidebar = () =>
    setSidebarOpen((o) => {
      localStorage.setItem("ss-sidebar", o ? "closed" : "open");
      return !o;
    });

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Fire now when idle; queue behind the active run otherwise (identical
  // requests already queued are ignored). The engine is captured per request
  // so a queued regen still runs under the engine it was asked for.
  const requestRun = (spec: RunRequest) => {
    const item: RunRequest = {
      stitch: !!spec.stitch,
      regen: spec.regen ?? null,
      count: spec.count ?? 1,
      engine: spec.engine ?? engine,
    };
    if (runActive) {
      setRunQueue((q) => (q.some((x) => sameRequest(x, item)) ? q : [...q, item]));
    } else {
      setPendingRun({ nonce: Date.now(), ...item });
    }
  };

  // Drain the queue serially: each run end fires the next request (StrictMode
  // safe — the shift happens in the effect body, not a state updater).
  const runActivePrev = useRef(false);
  useEffect(() => {
    if (runActivePrev.current && !runActive && runQueue.length > 0) {
      const [next, ...rest] = runQueue;
      setRunQueue(rest);
      setPendingRun({ nonce: Date.now(), ...next });
    }
    runActivePrev.current = runActive;
  }, [runActive, runQueue]);

  const handleRegen = (kind: AssetKind, index: number | null) =>
    requestRun({ regen: { kind, index: index ?? undefined } });

  // Home -> workspace navigation. The workspace itself is unchanged —
  // opening a project just selects it and switches the view.
  const openProject = useCallback((n: string) => {
    setDraft(null);
    setName(n);
    setView("workspace");
  }, []);

  // Delete confirmation popup for the Project bar (Yes/No — no native
  // window.confirm). `confirmDelete` is the pending project name, if any.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const requestDelete = (s: string) => {
    if (!deleting) setConfirmDelete(s);
  };

  const doDelete = async () => {
    const s = confirmDelete;
    if (!s || deleting) return;
    setDeleting(true);
    try {
      await deleteScenario(s);
      if (draft && draft.name === s) setDraft(null);
      if (name === s) {
        setName("");
        setShownName("");
        setCfg(null);
        setView("home");
      } else if (shownName === s) {
        setShownName("");
        setCfg(null);
      }
      await refreshScenarios();
      refresh();
    } catch (e) {
      window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  // Escape dismisses the delete popup.
  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmDelete(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete]);
  // Project bar order: integer project_id descending (newest project first);
  // rows without an id (SQLite mode) sink below, ordered by latest edit.
  const byProjectIdDesc = (a: ScenarioInfo, b: ScenarioInfo) =>
    (b.project_id ?? -1) - (a.project_id ?? -1) || b.mtimeMs - a.mtimeMs;
  const refreshScenarios = useCallback(async () => {
    const all = await listScenarios();
    const seq = all.filter((s) => s.isSequence).sort(byProjectIdDesc);
    setScenarios(seq);
    // Best-effort asset counts for the sidebar (never blocks the list).
    getDashboard()
      .then((d) => setDashMap(new Map((d.projects || []).map((p) => [p.name, p]))))
      .catch(() => {});
    return seq;
  }, []);

  const handleFavorite = async (s: ScenarioInfo) => {
    const on = !s.favorite;
    // Optimistic toggle; the star flips in place — row order always stays
    // project_id descending.
    setScenarios((prev) =>
      prev
        .map((x) => (x.name === s.name ? { ...x, favorite: on } : x))
        .sort(byProjectIdDesc)
    );
    try {
      await setFavorite(s.name, on);
    } catch (e) {
      window.alert(`Favorite update failed: ${e instanceof Error ? e.message : String(e)}`);
      refreshScenarios();
    }
  };

  useEffect(() => {
    refreshScenarios().catch(() => {});
  }, [refreshScenarios]);

  useEffect(() => {
    if (!name) {
      setCfg(null);
      setShownName("");
      setCfgLoading(false);
      return;
    }
    let cancelled = false;
    // Keep the previous project's content mounted while the new config
    // loads (blanking it here is what made the page flick on every click).
    // `shownName`/`cfg` only flip together once the fetch lands.
    setCfgLoading(true);
    const req = name;
    getScenario(req)
      .then((r) => {
        if (!cancelled) {
          setCfg(r.config);
          setShownName(req);
          setCfgLoading(false);
        }
      })
      .catch(() => {
        // Keep the old project mounted on failure — never blank the page.
        if (!cancelled) setCfgLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  useEffect(() => {
    comfyStatus().then(setComfy).catch(() => {});
    getHealth().then(setHealth).catch(() => setHealth(null));
    const t = setInterval(() => {
      comfyStatus().then(setComfy).catch(() => {});
      getHealth().then(setHealth).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, []);

  const handleSave = async (c: Scenario) => {
    const target = draft ? draft.name : (shownName || name);
    await saveScenario(target, c);
    if (draft) {
      await refreshScenarios();
      setName(target);
      setShownName(target);
      setCfg(c);
      setDraft(null);
    }
  };

  // Craft renders below as an unsaved draft (topic + requirements included).
  // The project row is already saved in the DB at craft time (with its
  // project_id); explicit "Save scenario" persists everything as v1 with
  // project_assets rows linked by that same project_id.
  const handleCrafted = (n: string, c: Scenario, meta: { topic: string; requirements: string }, project_id?: number | null) => {
    const full: Scenario = {
      ...c,
      ...(meta.topic ? { topic: meta.topic } : {}),
      ...(meta.requirements ? { requirements: meta.requirements } : {}),
    };
    // Targeted craft (craftTarget = the open saved scenario): keep the SAME
    // name so explicit Save stores a new *version* of that project (delta
    // rows for changed scenes only) instead of minting a new project.
    const shownForCraft = draft ? draft.name : (shownName || name);
    const inPlace = !draft && !!shownForCraft && n === shownForCraft;
    let target = n;
    if (!inPlace) {
      for (let i = 2; scenarios.some((s) => s.name === target); i++) target = `${n}_${i}`;
    }
    // Server already saved the project under `n` (unique there); if the
    // sidebar needed a _2 suffix, the Save below creates that project row —
    // either way project_assets always carry the right project_id.
    setDraft({ name: target, config: full, project_id: target === n ? project_id ?? null : null });
    setView("workspace");
  };

  // Workspace content renders from the last fully loaded project (`shown`),
  // never from the just-clicked `name` — name/config flip together when the
  // fetch lands, so the page never shows a half-switched state.
  const editor = draft
    ? { name: draft.name, config: draft.config }
    : cfg && shownName ? { name: shownName, config: cfg } : null;
  // True while the requested project differs from what's on screen (its
  // config is still flying in). Sidebar shows a spinner; content stays put.
  const switching = !draft && (!!cfgLoading || (!!name && name !== shownName));
  // Project whose content is actually on screen right now.
  const contentName = draft ? draft.name : shownName;

  const comfyQueue = comfy?.queue
    ? (comfy.queue.queue_running?.length ?? 0) + (comfy.queue.queue_pending?.length ?? 0)
    : 0;

  // True only while a reference-only regen run for the shown scenario is
  // active — the Generate Reference button spins on exactly this, not on
  // every unrelated run (full Generate, stitch, beat regen, …).
  const refGenerating =
    runActive && regenTarget?.kind === "ref" && !!contentName && !draft && runScenario === contentName;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <IconClapper size={17} />
          </span>
          <span className="brand-name">Sanskriti AI</span>
          <span className="brand-sub">AI Video Generator</span>
        </div>
        <nav className="topnav" aria-label="Primary">
          <button
            className={`topnav-btn ${view === "home" ? "on" : ""}`}
            onClick={() => setView("home")}
            aria-current={view === "home" ? "page" : undefined}
          >
            Home
          </button>
          <button
            className={`topnav-btn ${view === "workspace" ? "on" : ""}`}
            onClick={() => draft || name ? setView("workspace") : setView("home")}
            aria-current={view === "workspace" ? "page" : undefined}
            title={draft ? `Workspace: ${draft.name} (unsaved)` : name ? `Workspace: ${name}` : "Open a project from Home first"}
          >
            Projects
          </button>
        </nav>
        {/* Global generation status — permanently centered in the main menu
            bar (Sanskriti AI · Home · Projects), visible on every page.
            Shows live progress while generating, idle state otherwise. */}
        <div className="topbar-center">
          <GenerationProgressBar progress={topProgress} compact />
        </div>
        <div className="topbar-right">
          <div className="topbar-health" role="status" aria-label="Service status">
            <span className={`pill ${health ? (health.db.up ? "ok" : "err") : ""}`} title="PostgreSQL database">
              <span className={`dot ${health?.db.up ? "pulse" : ""}`} />
              {health ? (health.db.up ? "PostgreSQL connected" : "PostgreSQL offline") : "PostgreSQL checking"}
            </span>
            <span className={`pill ${health ? (health.llm.up ? "ok" : "err") : ""}`} title={health?.llm.error ?? "LM Studio (LLM)"}>
              <span className={`dot ${health?.llm.up ? "pulse" : ""}`} />
              {health ? (health.llm.up ? "LM Studio connected" : "LM Studio offline") : "LM Studio checking"}
            </span>
            <span className={`pill ${comfy?.up ? "ok" : "err"}`} title={comfy?.error ?? ""}>
              <span className={`dot ${comfy?.up ? "pulse" : ""}`} />
              {comfy?.up
                ? `ComfyUI online${comfyQueue > 0 ? ` · ${comfyQueue} queued` : ""}`
                : "ComfyUI offline"}
            </span>
          </div>
          <button
            className="icon-btn theme-toggle"
            onClick={onToggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />}
          </button>
          <div className="user-chip" title={`Signed in as ${user}`}>
            <span className="user-avatar">{user.slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{user}</span>
            <button className="icon-btn" onClick={onLogout} title="Sign out" aria-label="Sign out">
              <IconLogOut size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* Both views stay mounted — the inactive one is hidden, not unmounted —
          so a running generation keeps its live log, progress bar and SSE tail
          (and Craft keeps its spinner) when flipping between Home and the
          workspace. Workspace content renders from the last loaded project,
          so switching projects never unmounts/remounts the page. */}
      <div className={`shell ${sidebarOpen ? "" : "no-sidebar"}`}>
        {!sidebarOpen && view === "workspace" && (
          <button
            className="sidebar-show"
            onClick={toggleSidebar}
            title="Show projects panel"
            aria-label="Show projects panel"
          >
            <IconPanel size={15} />
            <span className="sidebar-show-label">Projects</span>
          </button>
        )}
        <div className="home-wrap" style={view !== "home" ? { display: "none" } : undefined}>
          <HomePage
            active={view === "home"}
            onOpen={openProject}
            onProjectsChanged={() => {
              refreshScenarios();
              refresh();
            }}
          />
        </div>
        {sidebarOpen && (
        <aside className="sidebar" style={view !== "workspace" ? { display: "none" } : undefined}>
          <div className="sidebar-head">
            <span>Projects</span>
            <span className="muted sidebar-count">
              {scenarios.length}
            </span>
            <span className="spacer" />
            <button
              className="icon-btn sidebar-collapse"
              onClick={toggleSidebar}
              title="Hide projects panel"
              aria-label="Hide projects panel"
            >
              <IconPanel size={15} />
            </button>
          </div>
          <div className="sidebar-list">
            {scenarios.length === 0 && (
              <div className="sidebar-empty">
                No scenarios yet — craft one with the LLM.
              </div>
            )}
            {scenarios.map((s) => {
              const d = dashMap.get(s.name);
              const selected = !draft && name === s.name;
              const loadingThis = switching && name === s.name;
              const assets = d ? (d.refDone ? 1 : 0) + d.imageCount + d.videoCount : null;
              // Fully rendered = every scene's video clip exists (and at
              // least one scene). Live runs show a spinner instead of a tick.
              const scenes = d?.sceneCount ?? 0;
              const vids = d?.videoCount ?? 0;
              const running = !!d?.generating;
              const complete = !!d && !running && scenes > 0 && vids >= scenes;
              const tickTitle = running
                ? "Generating…"
                : !d
                  ? "Render status unavailable"
                  : complete
                    ? `Fully rendered — all ${scenes} video${scenes === 1 ? "" : "s"} done`
                    : scenes > 0
                      ? `${vids}/${scenes} videos rendered`
                      : "No scenes yet";
              return (
              <div className={`scenario-row${selected ? " selected" : ""}${loadingThis ? " loading" : ""}`} key={s.name}>
                <button
                  className={`scenario-item ${selected ? "on" : ""}`}
                  onClick={() => openProject(s.name)}
                  title={s.project_id != null ? `#${s.project_id} · ${s.name}` : s.name}
                  aria-current={selected ? "page" : undefined}
                >
                  <span className={`scenario-avatar av-${avatarTone(s.name)}`} aria-hidden="true">
                    {loadingThis ? <Spinner size={13} /> : s.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="scenario-main">
                    <span className="scenario-name">
                      {s.project_id != null && (
                        <span className="scenario-id" title={`Project #${s.project_id}`}>#{s.project_id}</span>
                      )}
                      <span className="scenario-name-text">{s.name}</span>
                    </span>
                    <span className="scenario-date" title={fmtDateTime(s.mtimeMs)}>{fmtDateTime(s.mtimeMs)}</span>
                  </span>
                  <span className="scenario-stats" title={
                    d
                      ? `${assets} assets · ${d.imageCount} images · ${d.videoCount} videos · ${d.sceneCount} scenes`
                      : "Asset counts unavailable"
                  }>
                    {d ? (
                      <>
                        <span className="stat-line">Assets: <b>{assets}</b></span>
                        <span className="stat-line dim">Images: <b>{d.imageCount}</b></span>
                        <span className="stat-line dim">Videos: <b>{d.videoCount}</b></span>
                      </>
                    ) : (
                      <span className="stat-line dim">—</span>
                    )}
                  </span>
                  {running ? (
                    <span className="scenario-tick running" title={tickTitle} aria-label={tickTitle}>
                      <Spinner size={11} />
                    </span>
                  ) : d ? (
                    complete ? (
                      <span className="scenario-tick done" title={tickTitle} aria-label={tickTitle}>
                        <IconCheck size={12} />
                      </span>
                    ) : (
                      <span className="scenario-tick pending" title={tickTitle} aria-label={tickTitle} aria-hidden="true">
                        <span className="tick-dot" />
                      </span>
                    )
                  ) : null}
                </button>
                {/* Vertical action stack, last in the row: favorite on top,
                    delete just below. Always visible (never hover-only). */}
                <div className="scenario-actions">
                  <button
                    className={`icon-btn scenario-fav ${s.favorite ? "on" : ""}`}
                    title={s.favorite ? `Unfavorite ${s.name}` : `Favorite ${s.name}`}
                    aria-label={s.favorite ? `Unfavorite ${s.name}` : `Favorite ${s.name}`}
                    onClick={() => handleFavorite(s)}
                  >
                    <IconStar size={13} filled={!!s.favorite} />
                  </button>
                  <button
                    className="icon-btn scenario-del"
                    title={`Delete ${s.name}`}
                    aria-label={`Delete scenario ${s.name}`}
                    onClick={() => requestDelete(s.name)}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        </aside>
        )}

        <div className="col" style={view !== "workspace" ? { display: "none" } : undefined}>
          {/* First open (nothing loaded yet): stable loading skeleton with the
              same card layout, so the editor mounting later doesn't reflow. */}
          {switching && !editor ? (
            <>
              <section className="card ws-loading" aria-label="Loading project">
                <Spinner size={16} /> Loading {name}…
              </section>
              <section className="card ws-loading" aria-label="Loading run panel">
                <Spinner size={16} /> Loading {name}…
              </section>
            </>
          ) : (
          <>
          {/* Output Box on top, generation (Run window) directly below it. */}
          <OutputGallery
            scenario={contentName ? outScenario(contentName, engine) : ""}
            refreshKey={refreshKey}
            section="rest"
            generatingScenario={runActive ? runScenario : null}
            regenTarget={runActive ? regenTarget : null}
            runQueue={runQueue}
            onStitch={() => requestRun({ stitch: true })}
            onRegen={handleRegen}
            onUploaded={refresh}
            onEngineSwitch={() => setEngine(engine === "wan" ? "ltx" : "wan")}
          />
          <RunPanel
            scenario={draft ? "" : contentName}
            engine={engine}
            onEngine={setEngine}
            onDone={refresh}
            onStatus={(s, sc, regen) => {
              setRunActive(s === "running");
              setRunScenario(s === "running" ? sc : null);
              // The regen target comes from the run that actually started
              // (reported by RunPanel) — never from a stale pendingRun, so a
              // full Generate run is never mislabelled as a ref/beat regen.
              setRegenTarget(s === "running" ? regen : null);
            }}
            pendingRun={pendingRun}
            onProgress={setGenProgress}
          />
          {/* Scenario Editor lives in the right column, just below AI Craft. */}
          {editor && (
            <ShotList
              name={editor.name}
              engine={engine}
              config={editor.config}
              isDraft={!!draft}
              onDraftChange={(next) => setDraft((d) => (d ? { ...d, config: next } : d))}
              onChanged={(next) => {
                setCfg(next);
                refreshScenarios().catch(() => {});
                refresh();
              }}
              refreshKey={refreshKey}
              generatingScenario={runActive ? runScenario : null}
              regenTarget={runActive ? regenTarget : null}
              progress={topProgress}
              comfyQueue={comfyQueue}
              onRegen={handleRegen}
              onStitch={() => requestRun({ stitch: true })}
              runBusy={runActive}
              runQueue={runQueue}
            />
          )}
          </>
          )}
        </div>

        {/* AI Craft + Scenario Editor in the right column. */}
        <div className="col" style={view !== "workspace" ? { display: "none" } : undefined}>
          <CraftPanel
            onCrafted={handleCrafted}
            craftTarget={!draft && name ? name : null}
            scenarios={scenarios}
            selected={draft ? "" : name}
            onSelect={(n) => openProject(n)}
            contextKey={draft ? `draft:${draft.name}` : (contentName ? `saved:${contentName}` : "new")}
            contextTopic={(draft ? draft.config : cfg)?.topic ?? ""}
            contextReqs={(draft ? draft.config : cfg)?.requirements ?? ""}
          />
          {switching && !editor ? (
            <section className="card ws-loading" aria-label="Loading scenario editor">
              <Spinner size={16} /> Loading {name}…
            </section>
          ) : editor ? (
            // No key={editor.name}: remounting the whole editor on every
            // project click is what flushed inputs/scroll. It resyncs from
            // the new name/config props on its own.
            <ScenarioEditor
              name={editor.name}
              config={editor.config}
              isDraft={!!draft}
              onSave={handleSave}
              refBusy={runActive}
              refGenerating={refGenerating}
              onGenerateRef={(count) =>
                !draft && requestRun({ regen: { kind: "ref" }, count })}
              referenceSlot={!draft && contentName ? (
                <OutputGallery
                  scenario={outScenario(contentName, engine)}
                  refreshKey={refreshKey}
                  section="reference"
                  generatingScenario={runActive ? runScenario : null}
                  regenTarget={runActive ? regenTarget : null}
                  runQueue={runQueue}
                  onRegen={handleRegen}
                  onUploaded={refresh}
                />
              ) : null}
            />
          ) : (
            <section className="card">
              <div className="empty">
                <span className="empty-icon">
                  <IconFolder size={20} />
                </span>
                <span className="empty-title">No scenario selected</span>
                <span className="empty-sub">
                  Pick a scenario from the list, or craft a new one with the AI Craft panel above.
                </span>
              </div>
            </section>
          )}
        </div>
      </div>

      {/* Delete confirmation popup for the Project bar. */}
      {confirmDelete && (
        <div
          className="confirm-overlay"
          role="alertdialog"
          aria-modal="true"
          aria-label={`Delete project ${confirmDelete}`}
          onClick={() => !deleting && setConfirmDelete(null)}
        >
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-title">Delete project?</h3>
            <p className="confirm-text">
              Delete <b>{confirmDelete}</b>?
            </p>
            <p className="confirm-sub">
              Its generated outputs will be removed too. This cannot be undone.
            </p>
            <div className="confirm-actions">
              <button
                className="ghost"
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                autoFocus
              >
                No
              </button>
              <button
                className="danger"
                onClick={() => void doDelete()}
                disabled={deleting}
              >
                {deleting ? <Spinner size={12} /> : <IconTrash size={12} />}
                {deleting ? "Deleting…" : "Yes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
