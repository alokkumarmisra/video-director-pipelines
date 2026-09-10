import { useCallback, useEffect, useState } from "react";
import { listScenarios, getScenario, getDashboard, saveScenario, deleteScenario, setFavorite, comfyStatus, outScenario, me, logout, fmtDate, type Engine, type AuthUser, type RegenSpec } from "./api";
import type { Scenario, ScenarioInfo, ComfyStatus, AssetKind, DashboardProject } from "./types";
import ScenarioEditor from "./components/ScenarioEditor";
import ShotList from "./components/ShotList";
import RunPanel from "./components/RunPanel";
import GenerationProgressBar, { emptyProgress, type GenerationProgress } from "./components/GenerationProgressBar";
import OutputGallery from "./components/OutputGallery";
import CraftPanel from "./components/CraftPanel";
import HomePage from "./components/HomePage";
import Login from "./components/Login";
import { IconClapper, IconFolder, IconLogOut, IconMoon, IconPanel, IconStar, IconSun, IconTrash, Spinner } from "./components/Icons";

export type Theme = "dark" | "light";

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
  const [draft, setDraft] = useState<{ name: string; config: Scenario; project_id?: number | null } | null>(null);
  const [engine, setEngine] = useState<Engine>("ltx");
  const [comfy, setComfy] = useState<ComfyStatus | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [runActive, setRunActive] = useState(false);
  const [runScenario, setRunScenario] = useState<string | null>(null);
  const [regenTarget, setRegenTarget] = useState<{ kind: AssetKind; index?: number } | null>(null);
  const [pendingRun, setPendingRun] = useState<{ nonce: number; stitch?: boolean; regen?: RegenSpec | null; count?: number } | null>(null);
  const [genProgress, setGenProgress] = useState<GenerationProgress>(emptyProgress);
  // Server-side fallback: a run started in another tab (or before a page
  // refresh) leaves this tab's RunPanel idle while the backend — and the
  // Home → Recent Projects card — still report generating. Poll the same
  // dashboard payload so the menu bar shows the same thing.
  const [remoteGen, setRemoteGen] = useState<GenerationProgress | null>(null);
  // Ticking clock so the menu bar's Elapsed/Remaining stay live between the
  // 15s dashboard polls (same 5s cadence as RunPanel's local ticker).
  const [now, setNow] = useState(() => Date.now());
  // Per-project asset coverage for the Projects sidebar (images/videos/assets
  // in small type on the right of each row). Same dashboard payload as the
  // topbar progress — no extra endpoint.
  const [dashMap, setDashMap] = useState<Map<string, DashboardProject>>(new Map());
  useEffect(() => {
    if (!remoteGen || genProgress.status === "running") return;
    const t = setInterval(() => setNow(Date.now()), 5000);
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
        // Linear fallback ETA from overall % (no per-asset timings available
        // remotely): elapsed * remaining-fraction / done-fraction.
        const etaMs =
          elapsedMs > 0 && g.progress > 0 && g.progress < 100
            ? Math.round((elapsedMs / g.progress) * (100 - g.progress))
            : null;
        setRemoteGen({
          ...emptyProgress,
          status: "running",
          pct: g.progress,
          scene: null,
          totalScenes: g.sceneCount || null,
          imagesDone: (g.refDone ? 1 : 0) + g.imageCount,
          imagesTotal: 1 + g.sceneCount,
          videosDone: g.videoCount,
          videosTotal: g.sceneCount,
          etaMs,
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
        const etaMs =
          elapsedMs > 0 && remoteGen.pct > 0 && remoteGen.pct < 100
            ? Math.round((elapsedMs / remoteGen.pct) * (100 - remoteGen.pct))
            : null;
        return { ...remoteGen, elapsedMs, etaMs };
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

  const handleRegen = (kind: AssetKind, index: number | null) =>
    !runActive && setPendingRun({ nonce: Date.now(), regen: { kind, index: index ?? undefined } });

  // Home -> workspace navigation. The workspace itself is unchanged —
  // opening a project just selects it and switches the view.
  const openProject = useCallback((n: string) => {
    setDraft(null);
    setName(n);
    setView("workspace");
  }, []);

  const handleDelete = async (s: string) => {
    if (!window.confirm(`Delete scenario "${s}"?\nIts generated outputs will be removed too.`)) return;
    try {
      await deleteScenario(s);
      if (draft && draft.name === s) setDraft(null);
      if (name === s) {
        setName("");
        setView("home");
      }
      await refreshScenarios();
      refresh();
    } catch (e) {
      window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const refreshScenarios = useCallback(async () => {
    const all = await listScenarios();
    const seq = all.filter((s) => s.isSequence);
    setScenarios(seq);
    // Best-effort asset counts for the sidebar (never blocks the list).
    getDashboard()
      .then((d) => setDashMap(new Map((d.projects || []).map((p) => [p.name, p]))))
      .catch(() => {});
    return seq;
  }, []);

  const handleFavorite = async (s: ScenarioInfo) => {
    const on = !s.favorite;
    // Optimistic toggle; the server re-sorts (favorites pinned on top).
    setScenarios((prev) =>
      prev
        .map((x) => (x.name === s.name ? { ...x, favorite: on } : x))
        .sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || b.mtimeMs - a.mtimeMs)
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
      return;
    }
    let cancelled = false;
    setCfg(null);
    getScenario(name)
      .then((r) => {
        if (!cancelled) setCfg(r.config);
      })
      .catch(() => {
        if (!cancelled) setCfg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  useEffect(() => {
    comfyStatus().then(setComfy);
    const t = setInterval(() => comfyStatus().then(setComfy), 15000);
    return () => clearInterval(t);
  }, []);

  const handleSave = async (c: Scenario) => {
    const target = draft ? draft.name : name;
    await saveScenario(target, c);
    if (draft) {
      await refreshScenarios();
      setName(target);
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
    const inPlace = !draft && !!name && n === name;
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

  const editor = draft
    ? { name: draft.name, config: draft.config }
    : cfg ? { name, config: cfg } : null;

  const comfyQueue = comfy?.queue
    ? (comfy.queue.queue_running?.length ?? 0) + (comfy.queue.queue_pending?.length ?? 0)
    : 0;

  // True only while a reference-only regen run for the shown scenario is
  // active — the Generate Reference button spins on exactly this, not on
  // every unrelated run (full Generate, stitch, beat regen, …).
  const refGenerating =
    runActive && regenTarget?.kind === "ref" && !!name && !draft && runScenario === name;

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
          <span className={`pill ${comfy?.up ? "ok" : "err"}`} title={comfy?.error ?? ""}>
            <span className={`dot ${comfy?.up ? "pulse" : ""}`} />
            {comfy?.up
              ? `ComfyUI online${comfyQueue > 0 ? ` · ${comfyQueue} queued` : ""}`
              : "ComfyUI offline"}
          </span>
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
          workspace. */}
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
              const assets = d ? (d.refDone ? 1 : 0) + d.imageCount + d.videoCount : null;
              return (
              <div className={`scenario-row${selected ? " selected" : ""}`} key={s.name}>
                <button
                  className={`scenario-item ${selected ? "on" : ""}`}
                  onClick={() => openProject(s.name)}
                  title={s.name}
                  aria-current={selected ? "page" : undefined}
                >
                  <span className="scenario-avatar" aria-hidden="true">
                    {s.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="scenario-main">
                    <span className="scenario-name">{s.name}</span>
                    <span className="scenario-date">{fmtDate(s.mtimeMs)}</span>
                  </span>
                  <span className="scenario-stats" title={
                    d
                      ? `${assets} assets · ${d.imageCount} images · ${d.videoCount} videos · ${d.sceneCount} scenes`
                      : "Asset counts unavailable"
                  }>
                    {d ? (
                      <>
                        <span className="stat-line"><b>{assets}</b> assets</span>
                        <span className="stat-line dim">{d.imageCount} img · {d.videoCount} vid</span>
                      </>
                    ) : (
                      <span className="stat-line dim">—</span>
                    )}
                  </span>
                </button>
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
                  onClick={() => handleDelete(s.name)}
                >
                  <IconTrash size={13} />
                </button>
              </div>
              );
            })}
          </div>
        </aside>
        )}

        <div className="col" style={view !== "workspace" ? { display: "none" } : undefined}>
          <CraftPanel
            onCrafted={handleCrafted}
            craftTarget={!draft && name ? name : null}
            scenarios={scenarios}
            selected={draft ? "" : name}
            onSelect={(n) => openProject(n)}
            contextKey={draft ? `draft:${draft.name}` : (name ? `saved:${name}` : "new")}
            contextTopic={(draft ? draft.config : cfg)?.topic ?? ""}
            contextReqs={(draft ? draft.config : cfg)?.requirements ?? ""}
          />
          {editor ? (
            <ScenarioEditor
              key={editor.name}
              name={editor.name}
              config={editor.config}
              isDraft={!!draft}
              onSave={handleSave}
              refBusy={runActive}
              refGenerating={refGenerating}
              onGenerateRef={(count) =>
                !runActive && !draft && setPendingRun({ nonce: Date.now(), regen: { kind: "ref" }, count })}
              referenceSlot={!draft && name ? (
                <OutputGallery
                  scenario={outScenario(name, engine)}
                  refreshKey={refreshKey}
                  section="reference"
                  generatingScenario={runActive ? runScenario : null}
                  regenTarget={runActive ? regenTarget : null}
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
                  Pick a scenario from the list, or craft a new one above.
                </span>
              </div>
            </section>
          )}
          {!draft && name && editor && (
            <ShotList
              name={name}
              engine={engine}
              config={editor?.config ?? null}
              refreshKey={refreshKey}
              generatingScenario={runActive ? runScenario : null}
              regenTarget={runActive ? regenTarget : null}
              progress={topProgress}
              comfyQueue={comfyQueue}
              onRegen={handleRegen}
              onStitch={() => !runActive && setPendingRun({ nonce: Date.now(), stitch: true })}
              runBusy={runActive}
            />
          )}
          <RunPanel
            scenario={draft ? "" : name}
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
        </div>

        <div className="col" style={view !== "workspace" ? { display: "none" } : undefined}>
          <OutputGallery
            scenario={outScenario(draft ? draft.name : name, engine)}
            refreshKey={refreshKey}
            section="rest"
            generatingScenario={runActive ? runScenario : null}
            regenTarget={runActive ? regenTarget : null}
            onStitch={() => !runActive && setPendingRun({ nonce: Date.now(), stitch: true })}
            onRegen={handleRegen}
            onUploaded={refresh}
            onEngineSwitch={() => setEngine(engine === "wan" ? "ltx" : "wan")}
          />
        </div>
      </div>
    </div>
  );
}
