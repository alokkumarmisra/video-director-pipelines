import { useCallback, useEffect, useRef, useState } from "react";
import { listScenarios, getScenario, getDashboard, saveScenario, deleteScenario, renameScenario, setFavorite, comfyStatus, getHealth, outScenario, me, logout, fmtDateTime, listRuns, getTheme, saveTheme, type Engine, type AuthUser, type RegenSpec, type RunRequest } from "./api";
import type { Scenario, ScenarioInfo, ComfyStatus, AssetKind, DashboardProject, HealthResponse, Run } from "./types";
import ScenarioEditor from "./components/ScenarioEditor";
import GenerateReference from "./components/GenerateReference";
import ShotList from "./components/ShotList";
import RunPanel from "./components/RunPanel";
import GenerationProgressBar, { emptyProgress, loadPace, formatDuration, type GenerationProgress } from "./components/GenerationProgressBar";
import OutputGallery from "./components/OutputGallery";
import CraftPanel from "./components/CraftPanel";
import HomePage from "./components/HomePage";
import Login from "./components/Login";
import { IconCheck, IconChevronDown, IconClapper, IconFolder, IconLogOut, IconMoon, IconPanel, IconStar, IconSun, IconTrash, Spinner } from "./components/Icons";

export type Theme = "dark" | "light";

const THEME_COLOR_KEY = "ss-theme-color";
const DEFAULT_ACCENT = "#10b981";

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return hex;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

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
  // Custom accent color (theme): any picked color is saved and reapplied as
  // the app accent (--accent / --accent-2 / soft + line + glows). Empty =
  // default emerald. localStorage is an instant cache; data/theme.json on the
  // server is the source of truth (loaded on boot, written on every change).
  const [themeColor, setThemeColor] = useState<string>(() =>
    localStorage.getItem(THEME_COLOR_KEY) ?? ""
  );
  // True once the file-backed theme has been loaded — gates the write-back
  // below so the initial mount never overwrites the file with cached values.
  const [themeReady, setThemeReady] = useState(false);

  // Load the saved file theme once (public GET — works before login too).
  useEffect(() => {
    getTheme()
      .then((t) => {
        if (t.mode === "light" || t.mode === "dark") setTheme(t.mode);
        if (typeof t.color === "string") setThemeColor(t.color);
      })
      .catch(() => {})
      .finally(() => setThemeReady(true));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ss-theme", theme);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (!themeColor) {
      for (const k of ["--accent", "--accent-2", "--accent-soft", "--accent-line", "--glow-1", "--glow-2", "--glow-3"])
        root.style.removeProperty(k);
      localStorage.removeItem(THEME_COLOR_KEY);
    } else {
      localStorage.setItem(THEME_COLOR_KEY, themeColor);
      root.style.setProperty("--accent", themeColor);
      root.style.setProperty("--accent-2", themeColor);
      root.style.setProperty("--accent-soft", hexToRgba(themeColor, 0.10));
      root.style.setProperty("--accent-line", hexToRgba(themeColor, 0.35));
      root.style.setProperty("--glow-1", hexToRgba(themeColor, 0.14));
      root.style.setProperty("--glow-2", hexToRgba(themeColor, 0.08));
      root.style.setProperty("--glow-3", hexToRgba(themeColor, 0.05));
    }
    // Persist every change to data/theme.json (fire-and-forget; the file is
    // re-read on every load / restart until changed again). Skipped until the
    // initial file load has landed. May 401 before login — the next change
    // after login retries the write.
    if (themeReady) saveTheme({ mode: theme, color: themeColor }).catch(() => {});
  }, [theme, themeColor, themeReady]);

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
      themeColor={themeColor}
      onThemeColor={setThemeColor}
    />
  );
}

function Studio({ user, onLogout, theme, onToggleTheme, themeColor, onThemeColor }: {
  user: string;
  onLogout: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  themeColor: string;
  onThemeColor: (c: string) => void;
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
  // Unsaved brief-field edits from the AI Craft + Generate Reference cards,
  // keyed by Scenario field (absent key = no edit). Merged into the save
  // payload by the Scenario Editor; cleared on save / project switch /
  // version switch. `null` drops a key.
  const [overrides, setOverrides] = useState<Partial<Scenario>>({});
  const patchOverrides = (p: {
    description?: string | null;
    duration?: number | null;
    referencePrompt?: string | null;
  }) => setOverrides((o) => {
    const next = { ...o };
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || v === null) delete next[k as keyof Scenario];
      else (next as Record<string, unknown>)[k] = v;
    }
    return next;
  });
  // Staged project rename from AI Craft (null = unchanged) — applied on the
  // next explicit Save via the rename API.
  const [nameOv, setNameOv] = useState<string | null>(null);
  // Bumps whenever overrides are cleared externally (save / switch / version
  // change) so AI Craft refills its boxes from the saved snapshot.
  const [craftEpoch, setCraftEpoch] = useState(0);
  const dropEdits = useCallback(() => {
    setOverrides({});
    setNameOv(null);
    setCraftEpoch((e) => e + 1);
  }, []);
  const [pendingRun, setPendingRun] = useState<{ nonce: number; stitch?: boolean; regen?: RegenSpec | null; count?: number; engine?: Engine } | null>(null);
  // Reattach target for RunPanel: a run that was already active on the server
  // when this page loaded (refresh mid-generation). Restored here — not in
  // RunPanel — so the header bar, sidebar spinners and every generating
  // button flip to generating immediately, before the SSE tail replays.
  const [attachRun, setAttachRun] = useState<{ id: string; scenario: string; stitch?: boolean; regen?: RegenSpec | null; count?: number; startedAt?: number } | null>(null);
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

  // Progress Status popup in the top menu bar — the Images / Videos /
  // Overall bars live inside this toggleable window, not inline in the bar.
  const [progressOpen, setProgressOpen] = useState(false);
  useEffect(() => {
    if (!progressOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProgressOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [progressOpen]);

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

  // The run the SERVER reports as active (full shape from GET /api/runs) —
  // independent of this tab's local run state. Powers the "server busy"
  // banner in the Run window and lets any tab attach to a run started
  // elsewhere, so opening the generating project shows full live status
  // (exact regen target, working Stop) instead of a coarse fallback.
  const [serverRun, setServerRun] = useState<Run | null>(null);

  // Dashboard + active-run sync, extracted so project opens (Continue) and
  // run start/finish can trigger it immediately instead of waiting out the
  // poll interval. A failed poll keeps the previous live state — it must
  // never wipe a Generating header back to Ready on a transient error.
  const refreshRemote = useCallback(async () => {
    try {
      const [d, rs] = await Promise.all([
        getDashboard(),
        listRuns().catch(() => [] as Run[]),
      ]);
      setDashMap(new Map((d.projects || []).map((p) => [p.name, p])));
      // Identity-preserving update — a fresh object every poll must not
      // retrigger the interval effect (serverRun.id is a dep there).
      const active = [...rs].reverse().find((r) => r.status === "running") ?? null;
      setServerRun((prev) => {
        if (!active) return prev === null ? prev : null;
        return prev && prev.id === active.id && prev.scenario === active.scenario &&
          prev.startedAt === active.startedAt && (prev.status ?? "running") === active.status
          ? prev
          : active;
      });
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
      // Transient failure (backend hiccup, proxy blip): keep the previous
      // live state. Wiping to null here is what flashed a Generating header
      // back to Ready for no reason.
    }
  }, []);

  // Refresh recovery: if a run is still active on the server (started before
  // this page loaded — refresh, or a run from another tab), restore the run
  // state immediately so the header progress bar and all generating buttons
  // reflect reality, and hand RunPanel the reattach target so it reopens the
  // live SSE tail. The server is serial (one active run max); the latest
  // running record wins. Runs predating the shape fields reattach as a full
  // run — progress still rebuilds from the replayed asset stream.
  useEffect(() => {
    let cancelled = false;
    listRuns()
      .then((rs) => {
        if (cancelled) return;
        const active = [...rs].reverse().find((r) => r.status === "running");
        if (!active) return;
        const regen = active.regen ?? null;
        setRunActive(true);
        setRunScenario(active.scenario);
        setRegenTarget(regen ? { kind: regen.kind, index: regen.index } : null);
        setAttachRun({
          id: active.id,
          scenario: active.scenario,
          stitch: !!active.stitch,
          regen: regen ? { kind: regen.kind, index: regen.index } : null,
          count: active.count ?? 1,
          startedAt: active.startedAt,
        });
        if (active.engine === "wan" || active.engine === "ltx") setEngine(active.engine);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll remote state: 5s while anything is active locally or server-side
  // (live header, fast busy-banner clearing), 15s otherwise. Re-running on
  // runActive/serverRun.id also syncs immediately on run start/finish
  // instead of waiting out the interval.
  useEffect(() => {
    refreshRemote();
    const t = setInterval(refreshRemote, runActive || serverRun ? 5000 : 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runActive, serverRun?.id, refreshRemote]);

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
  // Right-column panels (AI Craft + Scenario Editor) collapse like the
  // Projects panel, but dock to the RIGHT side. State lives here so the
  // workspace grid can shrink the right column and let the middle expand.
  // Same storage keys the panels used before ("closed" = hidden).
  const [craftOpen, setCraftOpen] = useState<boolean>(() => localStorage.getItem("ss-sec-craft") !== "closed");
  const toggleCraft = () =>
    setCraftOpen((o) => {
      localStorage.setItem("ss-sec-craft", o ? "closed" : "open");
      return !o;
    });
  const [editorOpen, setEditorOpen] = useState<boolean>(() => localStorage.getItem("ss-sec-editor") !== "closed");
  const toggleEditor = () =>
    setEditorOpen((o) => {
      localStorage.setItem("ss-sec-editor", o ? "closed" : "open");
      return !o;
    });
  const rightCollapsed = !craftOpen && !editorOpen;

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
    // Staged rename: move the whole project first (history travels with it),
    // then save the new content as the next version under the new name.
    const newName = !draft && nameOv && nameOv.trim() !== target ? nameOv.trim() : null;
    if (newName) {
      if (runActive && runScenario === target)
        throw new Error("Stop the active run before renaming.");
      await renameScenario(target, newName);
      await saveScenario(newName, c);
      dropEdits();
      await refreshScenarios();
      const r = await getScenario(newName);
      setCfg(r.config);
      setShownName(newName);
      setName(newName);
      refresh();
      return;
    }
    await saveScenario(target, c);
    // The save already folded the card overrides in — drop them so the cards
    // fall back to the freshly saved config.
    dropEdits();
    if (draft) {
      await refreshScenarios();
      setName(target);
      setShownName(target);
      setCfg(c);
      setDraft(null);
    }
  };

  // Craft renders below as an unsaved draft.
  // The project row is already saved in the DB at craft time (with its
  // project_id); explicit "Save scenario" persists everything as v1 with
  // project_assets rows linked by that same project_id.
  const handleCrafted = (n: string, c: Scenario, project_id?: number | null) => {
    const full: Scenario = { ...c };
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
    // The fresh draft is a new baseline: drop pending card edits (the draft
    // already carries the brief just crafted) and refill from it.
    dropEdits();
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
  // Unsaved card edits belong to the project on screen — drop them on
  // switch so the next project's saved values show (nothing is lost: the
  // editor only enables Save while its own content is on screen).
  useEffect(() => {
    dropEdits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentName]);

  // Opening a project (Continue) syncs remote state immediately — the
  // workspace header shows server truth within ~a second even when the last
  // background poll is stale.
  useEffect(() => {
    if (view === "workspace") refreshRemote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, contentName]);

  // Attach to whatever the server reports as running — not just once at page
  // load. A run started after this tab loaded (another tab, a phone, the CLI
  // era) still gives this tab full live status: exact regen target, working
  // Stop, live log. Skipped while a local run owns the panel; a stale target
  // clears once the server no longer reports it (so a later run can attach).
  useEffect(() => {
    if (runActive || !serverRun) return;
    setAttachRun((prev) => {
      if (prev?.id === serverRun.id) return prev;
      const regen = serverRun.regen ?? null;
      return {
        id: serverRun.id,
        scenario: serverRun.scenario,
        stitch: !!serverRun.stitch,
        regen: regen ? { kind: regen.kind, index: regen.index } : null,
        count: serverRun.count ?? 1,
        startedAt: serverRun.startedAt,
      };
    });
  }, [runActive, serverRun]);
  useEffect(() => {
    if (runActive || !attachRun) return;
    if (!serverRun || serverRun.id !== attachRun.id) setAttachRun(null);
  }, [runActive, attachRun, serverRun]);

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
        {/* Global generation status — a toggleable "Progress Status" window
            centered in the main menu bar (Sanskriti AI · Home · Projects).
            The Images / Videos / Overall bars live inside the popup, not
            inline in the bar; toggling shows the current progress. */}
        <div className="topbar-center">
          <button
            className={`topnav-btn progress-toggle ${progressOpen ? "on" : ""}${topProgress.status === "running" ? " is-running" : ""}`}
            onClick={() => setProgressOpen((o) => !o)}
            aria-expanded={progressOpen}
            aria-haspopup="dialog"
            title={topProgress.status === "running"
              ? `Generating ${topProgress.scenario || "scenes"} — ${Math.round(topProgress.pct)}% — Remaining ${formatDuration(topProgress.etaMs)} — click to ${progressOpen ? "hide" : "show"} progress`
              : `Progress Status — click to ${progressOpen ? "hide" : "show"} progress`}
          >
            <span
              className={`dot progress-toggle-dot status-${topProgress.status}${topProgress.status === "running" ? " pulse" : ""}`}
              aria-hidden="true"
            />
            <span>Progress Status</span>
            {topProgress.status === "running" && (
              <>
                <span className="progress-toggle-pct">{Math.round(topProgress.pct)}%</span>
                {topProgress.total > 0 && (
                  <span
                    className="progress-toggle-files"
                    title={`${topProgress.completed} of ${topProgress.total} files processed, ${Math.max(0, topProgress.total - topProgress.completed)} remaining`}
                  >
                    {topProgress.completed}/{topProgress.total} files · {Math.max(0, topProgress.total - topProgress.completed)} left
                  </span>
                )}
                <span
                  className="progress-toggle-eta"
                  title={`Remaining ${formatDuration(topProgress.etaMs)}`}
                >
                  ⏳ {formatDuration(topProgress.etaMs)}
                </span>
              </>
            )}
            <span className={`progress-toggle-caret${progressOpen ? " open" : ""}`} aria-hidden="true"><IconChevronDown size={12} /></span>
            {topProgress.status !== "idle" && (
              <span className="progress-toggle-track" aria-hidden="true">
                <span
                  className={`progress-toggle-fill status-${topProgress.status}${topProgress.status === "running" ? " sweep" : ""}`}
                  style={{ width: `${Math.min(100, Math.max(0, topProgress.pct))}%` }}
                />
              </span>
            )}
          </button>
          {progressOpen && (
            <>
              <div
                className="progress-window-overlay"
                onClick={() => setProgressOpen(false)}
                aria-hidden="true"
              />
              <div
                className="progress-window"
                role="dialog"
                aria-modal="false"
                aria-label="Progress Status"
              >
                <div className="progress-window-head">
                  <span className="progress-window-title">Progress Status</span>
                  <span className="spacer" />
                  <button
                    className="icon-btn progress-window-close"
                    onClick={() => setProgressOpen(false)}
                    title="Close progress status"
                    aria-label="Close progress status"
                  >
                    ✕
                  </button>
                </div>
                <div className="progress-window-body">
                  <GenerationProgressBar progress={topProgress} compact />
                </div>
              </div>
            </>
          )}
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
          <label
            className="theme-color"
            title={themeColor ? `Theme color ${themeColor} — pick to change, double-click to reset` : "Pick a theme color"}
            onDoubleClick={(e) => {
              e.preventDefault();
              onThemeColor("");
            }}
          >
            <span
              className="theme-color-swatch"
              aria-hidden="true"
              style={{ background: themeColor || DEFAULT_ACCENT }}
            />
            <input
              type="color"
              value={themeColor || DEFAULT_ACCENT}
              onChange={(e) => onThemeColor(e.target.value)}
              aria-label="Pick a theme color"
            />
            {themeColor && (
              <button
                className="theme-color-reset"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onThemeColor("");
                }}
                title="Reset to default theme color"
                aria-label="Reset to default theme color"
                type="button"
              >
                ✕
              </button>
            )}
          </label>
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
      <div className={`shell ${sidebarOpen ? "" : "no-sidebar"}${rightCollapsed ? " no-right" : ""}`}>
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
          {/* Rendered Clip (run) window on top, Generate Reference just below
              it, then the Shot List, then keyframes → clips. Each card
              hides/shows on its own toggle. */}
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
            attachRun={attachRun}
            serverRun={serverRun}
            onProgress={setGenProgress}
            comfyQueue={comfyQueue}
          />
          <GenerateReference
            referencePrompt={overrides.referencePrompt ?? (draft ? draft.config : cfg)?.referencePrompt ?? ""}
            onReferencePromptChange={(v) => patchOverrides({ referencePrompt: v })}
            onGenerateRef={(count) =>
              !draft && requestRun({ regen: { kind: "ref" }, count })}
            refBusy={runActive}
            refGenerating={refGenerating}
            isDraft={!!draft}
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
          <OutputGallery
            scenario={contentName ? outScenario(contentName, engine) : ""}
            refreshKey={refreshKey}
            section="beats"
            generatingScenario={runActive ? runScenario : null}
            regenTarget={runActive ? regenTarget : null}
            runQueue={runQueue}
            onRegen={handleRegen}
            onUploaded={refresh}
            totalScenes={editor && Array.isArray(editor.config.sequence) ? editor.config.sequence.length : null}
          />
          </>
          )}
        </div>

        {/* AI Craft + Scenario Editor in the right column. Either panel can
            collapse to a slim rail docked at the RIGHT edge (mirroring the
            Projects rail on the left); when both are hidden the right column
            shrinks to rail width and the middle section expands. */}
        <div className={`col right-col${rightCollapsed ? " rails-only" : ""}`} style={view !== "workspace" ? { display: "none" } : undefined}>
          <CraftPanel
            open={craftOpen}
            onToggle={toggleCraft}
            onCrafted={handleCrafted}
            craftTarget={!draft && name ? name : null}
            source={contentName ? {
              name: contentName,
              description: (draft ? draft.config : cfg)?.description ?? "",
              duration: (draft ? draft.config : cfg)?.duration ?? null,
              masterPrompt: (draft ? draft.config : cfg)?.referencePrompt ?? "",
            } : {
              name: "",
              description: "",
              duration: null,
              masterPrompt: "",
            }}
            isDraft={!!draft}
            syncEpoch={craftEpoch}
            onPatch={patchOverrides}
            onNameChange={setNameOv}
          />
          {(!editorOpen || switching) && !editor ? (
            !editorOpen ? null : (
            <section className="card ws-loading" aria-label="Loading scenario editor">
              <Spinner size={16} /> Loading {name}…
            </section>
            )
          ) : editor ? (
            // No key={editor.name}: remounting the whole editor on every
            // project click is what flushed inputs/scroll. It resyncs from
            // the new name/config props on its own.
            <ScenarioEditor
              open={editorOpen}
              onToggle={toggleEditor}
              name={editor.name}
              config={editor.config}
              isDraft={!!draft}
              onSave={handleSave}
              overrides={overrides}
              onOverridesClear={dropEdits}
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
