import { useEffect, useMemo, useState } from "react";
import {
  craftBeat,
  listOutputs,
  listProjectAssets,
  listVersions,
  outputUrl,
  outScenario,
  saveScenario,
  type Engine,
  type RunRequest,
  type ScenarioVersionInfo,
} from "../api";
import type {
  AssetKind,
  Beat,
  MainsInfo,
  OutputsInfo,
  ProjectAsset,
  Scenario,
  VersionsInfo,
} from "../types";
import type { GenerationProgress } from "./GenerationProgressBar";
import Lightbox, { type PreviewItem } from "./Lightbox";
import SmoothImage from "./SmoothImage";
import { SceneBadge } from "./OutputGallery";
import {
  IconCheck,
  IconChevronDown,
  IconClapper,
  IconFilm,
  IconImage,
  IconPanel,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconX,
  Spinner,
} from "./Icons";

// ---------------------------------------------------------------------------
// Shot type heuristic — derived from the real beat prompts, never hard-coded
// per project. Buckets match the compact badge set in the spec.
// ---------------------------------------------------------------------------
export type ShotType = "Cinematic" | "Lip-sync" | "Establishing" | "Close-up" | "Transition";

function classifyBeat(b: Beat): ShotType {
  const t = `${b.title} ${b.image} ${b.motion}`.toLowerCase();
  if (/lip[\s-]?sync|lipsync|dialogue|speaking|talking|audio[\s-]?sync|mouth.*(sync|move)|sync.*(mouth|audio|voice)/.test(t))
    return "Lip-sync";
  if (/establish|wide shot|\bws\b|aerial panorama/.test(t)) return "Establishing";
  if (/close[\s-]?up|\bcu\b|\becu\b|face portrait|over[-\s]?shoulder/.test(t)) return "Close-up";
  if (/transition|\bcut\b|\bfade\b|\bdissolve\b|\bwipe\b|\bmorph\b/.test(t)) return "Transition";
  return "Cinematic";
}

type ShotStatus = "generated" | "generating" | "failed" | "pending";

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

interface ShotRow {
  /** 1-based scene (= beat) number. */
  n: number;
  /** "N.1" — SceneNumber.ShotNumber (one shot per beat in this pipeline). */
  shot: string;
  beat: Beat;
  type: ShotType;
  imageFile: string | null;
  clipFile: string | null;
  imageStatus: ShotStatus;
  videoStatus: ShotStatus;
  imageError: string | null;
  videoError: string | null;
}

interface Props {
  /** Base scenario name ("" when nothing selected / unsaved draft). */
  name: string;
  engine: Engine;
  /** Saved (or draft) scenario config — prompts + duration come from here. */
  config: Scenario | null;
  refreshKey: number;
  /** Output dir of the currently running generation (null when idle). */
  generatingScenario: string | null;
  regenTarget: { kind: AssetKind; index?: number } | null;
  /** Live run progress (RunPanel) — persistent bar + current-shot readout. */
  progress: GenerationProgress;
  /** ComfyUI queue depth (running + pending) for the queue readout. */
  comfyQueue: number;
  onRegen: (kind: AssetKind, index: number | null) => void;
  onStitch?: () => void;
  /** True while any run is active (disables regen triggers — queue is serial). */
  runBusy?: boolean;
  /** Run requests waiting behind the active run (App drains them serially).
      Buttons for queued targets read "Queued" and stay enabled; only the
      actively generating button is disabled. */
  runQueue?: RunRequest[];
  /** Draft mode: beats edit the unsaved draft locally (no server calls, no regen). */
  isDraft?: boolean;
  /** Draft mode: receives the updated config after each local beat edit. */
  onDraftChange?: (cfg: Scenario) => void;
  /** Saved mode: receives the updated config after each persisted beat edit. */
  onChanged?: (cfg: Scenario) => void;
}

/** Max scene tabs shown; the trailing All tab reveals every scene. */
const MAX_SCENE_TABS = 6;

const emptyOutputs: OutputsInfo = {
  files: [],
  versions: { ref: [], beats: {} },
  mains: { ref: null, beats: {} },
};

// Central production-control screen: SHOT → PROMPT → IMAGE → VIDEO at a glance.
// Reads only real pipeline state (scenario config, /api/outputs version mains,
// /api/project/:name/assets statuses, live run progress). No mocks.
export default function ShotList({
  name,
  engine,
  config,
  refreshKey,
  generatingScenario,
  regenTarget,
  progress,
  comfyQueue,
  onRegen,
  onStitch,
  runBusy,
  runQueue = [],
  isDraft,
  onDraftChange,
  onChanged,
}: Props) {
  const [outputs, setOutputs] = useState<OutputsInfo>(emptyOutputs);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [versions, setVersions] = useState<ScenarioVersionInfo[]>([]);
  const [filter, setFilter] = useState<number | "all">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [loadError, setLoadError] = useState("");
  // Hide/show toggle (same as the Projects panel — persisted). Collapsing
  // only hides the body JSX; polling and live progress keep running.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-shots") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-shots", c ? "open" : "closed");
      return !c;
    });

  // Inline beat editing — the same fields the Scenario Editor beat blocks
  // used to carry (title, keyframe image, motion & camera). `editing` is the
  // 1-based shot being edited, or "new" for the appended-shot form.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draftBeat, setDraftBeat] = useState<Beat>({ title: "", image: "", motion: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState("");
  const [genCount, setGenCount] = useState(1);
  // Beat mutations stay disabled mid-run for saved scenarios (queue is
  // serial); drafts have no runs, so they stay editable.
  const mutBusy = saving || genBusy || (!isDraft && !!runBusy);

  const outDir = name ? outScenario(name, engine) : "";
  const seq = useMemo(() => (config && Array.isArray(config.sequence) ? config.sequence : []), [config]);
  const clipDur = Number.isFinite(Number(config?.duration)) ? Number(config?.duration) : 0;

  // Clamp the scene filter when the scenario changes / beats shrink.
  useEffect(() => {
    setFilter("all");
    setExpanded(new Set());
  }, [name, engine]);
  useEffect(() => {
    if (filter !== "all" && (filter < 1 || filter > seq.length)) setFilter("all");
  }, [filter, seq.length]);

  // Drafts have no server state yet (nothing saved to list) — beats edit
  // the draft locally until Save Scenario.
  useEffect(() => {
    if (!name || isDraft) {
      setOutputs(emptyOutputs);
      setAssets([]);
      setVersions([]);
      setLoadError("");
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const [o, a, v] = await Promise.all([
          listOutputs(outDir),
          listProjectAssets(name).catch(() => [] as ProjectAsset[]),
          listVersions(name).catch(() => [] as ScenarioVersionInfo[]),
        ]);
        if (cancelled) return;
        setOutputs(o);
        setAssets(a);
        setVersions(v);
        setLoadError("");
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    // Keep statuses live while a run is active (same 15s cadence as the
    // dashboard poll); a single fetch otherwise.
    if (generatingScenario) {
      const t = setInterval(() => void load(), 15000);
      return () => {
        cancelled = true;
        clearInterval(t);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [name, outDir, refreshKey, generatingScenario, isDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  const versionsInfo: VersionsInfo = outputs.versions ?? { ref: [], beats: {} };
  const mainsInfo: MainsInfo = outputs.mains ?? { ref: null, beats: {} };

  // Exact asset row for (beat, type) from the effective project state.
  const assetFor = (beat: number, type: "KEYFRAME" | "VIDEO"): ProjectAsset | null => {
    const rows = assets.filter((r) => r.beat_index === beat && r.asset_type === type);
    if (!rows.length) return null;
    // Effective query already resolves one row per key; prefer the latest version.
    return rows.reduce((a, b) => (b.version > a.version ? b : a));
  };

  // generatingScenario arrives as the base scenario name; Wan renders into
  // the suffixed outDir, so both forms match (ltx needs no suffix).
  const generatingHere = !!generatingScenario && !!outDir &&
    (generatingScenario === outDir || generatingScenario === name);

  // Per-button run state: only the actively generating target is disabled —
  // everything else stays clickable and queues behind the running job.
  const targetRunning = (kind: "keyframe" | "clip", n: number) =>
    !!runBusy && generatingHere && !!regenTarget &&
    regenTarget.kind === kind && (regenTarget.index ?? n) === n;
  const targetQueued = (kind: "keyframe" | "clip", n: number) =>
    runQueue.some((q) => !q.stitch && q.regen?.kind === kind && (q.regen?.index ?? n) === n);

  // First asset in pipeline order without a file — where a full run is headed.
  const nextMissing = useMemo((): { kind: "keyframe" | "clip"; index: number } | null => {
    for (let i = 1; i <= seq.length; i++) {
      if (!mainsInfo.beats[String(i)]?.keyframe) return { kind: "keyframe", index: i };
    }
    for (let i = 1; i <= seq.length; i++) {
      if (!mainsInfo.beats[String(i)]?.clip) return { kind: "clip", index: i };
    }
    return null;
  }, [mainsInfo, seq.length]);

  const rows: ShotRow[] = useMemo(
    () =>
      seq.map((beat, i) => {
        const n = i + 1;
        const imageFile = mainsInfo.beats[String(n)]?.keyframe ?? null;
        const clipFile = mainsInfo.beats[String(n)]?.clip ?? null;
        const kfRow = assetFor(n, "KEYFRAME");
        const vidRow = assetFor(n, "VIDEO");

        const isTarget = (kind: "keyframe" | "clip") => {
          if (!generatingHere) return false;
          if (regenTarget) {
            return regenTarget.kind === kind && (regenTarget.index ?? n) === n;
          }
          return nextMissing?.kind === kind && nextMissing.index === n;
        };

        let imageStatus: ShotStatus = imageFile ? "generated" : "pending";
        let videoStatus: ShotStatus = clipFile ? "generated" : "pending";
        if (kfRow?.status === "FAILED") imageStatus = "failed";
        else if (kfRow?.status === "PROCESSING" || isTarget("keyframe")) {
          imageStatus = imageFile && kfRow?.status !== "PROCESSING" && !isTarget("keyframe") ? imageStatus : "generating";
          if (!imageFile || isTarget("keyframe")) imageStatus = "generating";
        }
        if (vidRow?.status === "FAILED") videoStatus = "failed";
        else if (vidRow?.status === "PROCESSING" || isTarget("clip")) {
          videoStatus = "generating";
        }
        // A finished file always wins over a stale PROCESSING flag.
        if (imageFile && !isTarget("keyframe") && kfRow?.status !== "PROCESSING") imageStatus = "generated";
        if (clipFile && !isTarget("clip") && vidRow?.status !== "PROCESSING") videoStatus = "generated";
        if (!imageFile && isTarget("keyframe")) imageStatus = "generating";
        if (!clipFile && isTarget("clip")) videoStatus = "generating";

        return {
          n,
          shot: `${n}.1`,
          beat,
          type: classifyBeat(beat),
          imageFile,
          clipFile,
          imageStatus,
          videoStatus,
          imageError: kfRow?.error_message ?? null,
          videoError: vidRow?.error_message ?? null,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seq, mainsInfo, assets, generatingHere, regenTarget, nextMissing]
  );

  // ---- header / summary numbers (all derived, never hard-coded) ----
  const totalShots = rows.length;
  const shotsDone = rows.filter((r) => r.imageFile && r.clipFile).length;
  const cinematicCount = rows.filter((r) => r.type !== "Lip-sync").length;
  const lipsyncCount = rows.filter((r) => r.type === "Lip-sync").length;
  const totalDur = clipDur > 0 ? totalShots * clipDur : 0;

  const refDone = !!mainsInfo.ref;
  const kfDone = rows.filter((r) => r.imageFile).length;
  const clipDone = rows.filter((r) => r.clipFile).length;
  const totalTasks = 1 + 2 * totalShots;
  const doneTasks = (refDone ? 1 : 0) + kfDone + clipDone;
  const pct = totalTasks > 0 ? Math.min(100, Math.round((doneTasks / totalTasks) * 100)) : 0;

  const latestVersion = versions.length ? Math.max(...versions.map((v) => v.version)) : null;
  const pad = (v: number) => String(v).padStart(2, "0");
  const ofLabel = totalShots > 0 ? `${pad(shotsDone)} OF ${pad(totalShots)}` : "—";

  // ---- live run readout for THIS project ----
  const liveHere =
    progress.status === "running" && progress.scenario && (progress.scenario === name || progress.scenario === outDir);
  const currentShot: number | null = (() => {
    if (!liveHere) return null;
    if (regenTarget?.index != null && regenTarget.kind !== "ref") return regenTarget.index;
    if (progress.scene != null) return progress.scene;
    return nextMissing?.index ?? null;
  })();

  const visible = filter === "all" ? rows : rows.filter((r) => r.n === filter);

  const toggleExpand = (n: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  // Selecting a scene tab reveals that scene's full prompts. All reveals
  // the full data for every scene. Details toggles rows individually.
  const selectScene = (n: number) => {
    setFilter(n);
    setExpanded((prev) => new Set(prev).add(n));
  };
  const selectAll = () => {
    setFilter("all");
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const r of rows) next.add(r.n);
      return next;
    });
  };

  // Persist a beat list: drafts update locally (Save Scenario persists
  // them later), saved scenarios store a new version via the API.
  const persistSequence = async (nextSeq: Beat[]): Promise<void> => {
    if (!config) return;
    const next: Scenario = { ...config, sequence: nextSeq };
    if (isDraft) {
      onDraftChange?.(next);
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      await saveScenario(name, next);
      onChanged?.(next);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (n: number) => {
    const b = seq[n - 1];
    if (!b) return;
    setDraftBeat({ ...b });
    setSaveError("");
    setEditing(n);
    setExpanded((prev) => new Set(prev).add(n));
  };
  const cancelEdit = () => {
    setEditing(null);
    setSaveError("");
  };
  const updateShot = async () => {
    if (editing === null || !config) return;
    const title =
      draftBeat.title.trim() ||
      (editing === "new" ? `beat${seq.length + 1}` : (seq[editing - 1]?.title ?? `beat${editing}`));
    const next: Beat = { ...draftBeat, title };
    const nextSeq =
      editing === "new" ? [...seq, next] : seq.map((b, i) => (i === editing - 1 ? next : b));
    try {
      await persistSequence(nextSeq);
    } catch {
      return; // saveError already set — keep the form open
    }
    if (editing === "new") {
      const n = seq.length + 1;
      setFilter("all");
      setExpanded((prev) => new Set(prev).add(n));
    }
    setEditing(null);
  };
  const deleteShot = async (n: number) => {
    const b = seq[n - 1];
    if (!b) return;
    if (
      !window.confirm(
        `Delete shot ${n}.1 (${b.title || "untitled"})? Its prompts are removed from the scenario (generated files are kept).`
      )
    )
      return;
    try {
      await persistSequence(seq.filter((_, i) => i !== n - 1));
    } catch {
      return;
    }
    setEditing(null);
  };
  const addShot = () => {
    setDraftBeat({ title: `beat${seq.length + 1}`, image: "", motion: "" });
    setSaveError("");
    setEditing("new");
    setFilter("all");
  };

  // LLM proposes the next N beats from the scenario JSON, each continuing
  // from the previous one, and appends them — review them with Edit.
  const generateBeats = async () => {
    if (!config || genBusy) return;
    setGenBusy(true);
    setGenError("");
    try {
      const res = await craftBeat(config, genCount);
      const beats = res.beats ?? (res.beat ? [res.beat] : []); // beat = old server shape
      const used = new Set(seq.map((b) => b.title));
      const next = beats.map((b, k) => {
        let title = slug(b.title) || `beat${seq.length + k + 1}`;
        if (used.has(title)) title = `${title}_next`;
        used.add(title);
        return { ...b, title };
      });
      await persistSequence([...seq, ...next]);
      setFilter("all");
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenBusy(false);
    }
  };

  // Inline edit form — same attributes as the old editor beat blocks.
  const renderEditForm = (isNew: boolean, n: number | null) => (
    <>
      <label>Shot title</label>
      <input
        value={draftBeat.title}
        placeholder="title (file-safe)"
        disabled={saving}
        onChange={(e) => setDraftBeat({ ...draftBeat, title: e.target.value })}
      />
      <p className="beat-meta">{slug(draftBeat.title) || "untitled"}</p>
      <label>Keyframe image — Flux</label>
      <textarea
        rows={2}
        value={draftBeat.image}
        disabled={saving}
        onChange={(e) => setDraftBeat({ ...draftBeat, image: e.target.value })}
      />
      <label>Motion &amp; camera — i2v</label>
      <textarea
        rows={2}
        value={draftBeat.motion}
        disabled={saving}
        onChange={(e) => setDraftBeat({ ...draftBeat, motion: e.target.value })}
      />
      {saveError && <p className="hint err-text">{saveError}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="primary"
          onClick={() => void updateShot()}
          disabled={saving || mutBusy}
          title={
            isDraft
              ? "Apply to the unsaved draft (Save Scenario persists it)"
              : "Save prompts as a new scenario version"
          }
        >
          {saving ? <Spinner size={13} /> : <IconCheck size={13} />}
          {saving ? "Updating…" : isNew ? "Add shot" : "Update shot"}
        </button>
        <button className="ghost" onClick={cancelEdit} disabled={saving}>
          <IconX size={13} />
          Cancel
        </button>
        <span className="spacer" />
        {!isNew && n != null && (
          <button
            className="ghost"
            onClick={() => void deleteShot(n)}
            disabled={saving || mutBusy}
            title={`Delete shot ${n}.1 (prompts only — generated files are kept)`}
          >
            <IconTrash size={13} />
            Delete shot
          </button>
        )}
      </div>
    </>
  );

  if (!name) {
    return (
      <section className="card shotlist" aria-label="Shot list">
        <div className="shotlist-head">
          <div>
            <div className="shotlist-kicker">Shot List</div>
            <h2 className="shotlist-title">Shot List</h2>
            <p className="shotlist-sub">— every scene, every beat</p>
          </div>
        </div>
        <div className="empty">
          <span className="empty-icon">
            <IconClapper size={20} />
          </span>
          <span className="empty-title">No project selected</span>
          <span className="empty-sub">Open a project to see its shot-by-shot production status.</span>
        </div>
      </section>
    );
  }

  return (
    <section className={`card shotlist${collapsed ? " collapsed" : ""}`} aria-label={`Shot list for ${name}`}>
      {preview && <Lightbox item={preview} onClose={() => setPreview(null)} />}

      {/* Header */}
      <div className="shotlist-head">
        <div className="shotlist-head-left">
          <span className="head-icon hi-shots" aria-hidden="true"><IconPlay size={16} /></span>
          <div>
            <div className="shotlist-kicker">Shot List</div>
            <h2 className="shotlist-title">Shot List</h2>
            <p className="shotlist-sub">— every scene, every beat</p>
          </div>
        </div>
        <div className="shotlist-head-right">
          <span className="shotlist-of" title={`${shotsDone} of ${totalShots} shots fully generated (image + video)`}>
            {ofLabel}
          </span>
          {latestVersion != null && (
            <span className="pill" title={`Scenario version v${latestVersion}`}>
              v{latestVersion}
            </span>
          )}
          {isDraft && <span className="pill warn">draft · unsaved</span>}
          <button
            className="icon-btn"
            onClick={toggleCollapsed}
            title={collapsed ? "Show shot list" : "Hide shot list"}
            aria-label={collapsed ? "Show shot list" : "Hide shot list"}
            aria-expanded={!collapsed}
          >
            <IconPanel size={15} />
          </button>
        </div>
      </div>

      {!collapsed && (
      <>
      {/* Overall generation progress (real coverage, persistent at the top) */}
      <div className="shotlist-progress" role="status" aria-label={`Overall generation ${pct} percent`}>
        <div className="shotlist-progress-top">
          <span className="shotlist-progress-label">Overall generation</span>
          <span className="shotlist-progress-pct">{pct}%</span>
        </div>
        <div className="progress-bar" aria-hidden="true">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="shotlist-progress-meta">
          <span>
            {doneTasks} / {totalTasks} tasks · {kfDone} images · {clipDone} videos
          </span>
          <span>
            {shotsDone} / {totalShots} shots completed
          </span>
        </div>
      </div>

      {/* Current processing status (live run only — never faked) */}
      {liveHere && (
        <div className="shotlist-live" role="status" aria-live="polite">
          <div className="shotlist-live-top">
            <span className="shotlist-live-title">
              <Spinner size={12} />
              {currentShot != null ? (
                <>Generating Scene {currentShot} / Shot {currentShot}.1</>
              ) : regenTarget?.kind === "ref" ? (
                <>Generating reference…</>
              ) : (
                <>Generating…</>
              )}
            </span>
            <span className="shotlist-live-pct">{Math.round(progress.pct)}%</span>
          </div>
          <div className="progress-bar" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, progress.pct))}%` }} />
          </div>
          <div className="shotlist-progress-meta">
            <span>
              {progress.scene != null && progress.totalScenes != null
                ? `Scene ${progress.scene} of ${progress.totalScenes}`
                : progress.total > 0
                  ? `${progress.completed} of ${progress.total} tasks`
                  : "Starting…"}
            </span>
            {comfyQueue > 0 && <span>Queue: {comfyQueue} waiting</span>}
          </div>
        </div>
      )}

      {/* Compact summary (real counts) */}
      <div className="shotlist-stats" aria-label="Project summary">
        <div className="shotlist-stat" title={`${totalShots} shots in this project`}>
          <span className="shotlist-stat-value">{totalShots}</span>
          <span className="shotlist-stat-label">Shots</span>
        </div>
        <div className="shotlist-stat" title={`${cinematicCount} cinematic shots`}>
          <span className="shotlist-stat-value">{cinematicCount}</span>
          <span className="shotlist-stat-label">Cinematic</span>
        </div>
        <div className="shotlist-stat" title={`${lipsyncCount} lip-sync shots`}>
          <span className="shotlist-stat-value">{lipsyncCount}</span>
          <span className="shotlist-stat-label">Lip-sync</span>
        </div>
        <div className="shotlist-stat" title={`Total runtime at ${clipDur}s per clip`}>
          <span className="shotlist-stat-value">{clipDur > 0 ? totalDur.toFixed(1) : "—"}</span>
          <span className="shotlist-stat-label">{clipDur > 0 ? "s total" : "duration"}</span>
        </div>
      </div>

      {/* Scene filter tabs: first 6 scenes + All (All shows every scene) */}
      {totalShots > 0 && (
        <div className="shotlist-scenes" role="tablist" aria-label="Filter by scene">
          {rows.slice(0, MAX_SCENE_TABS).map((r) => {
            const done = !!(r.imageFile && r.clipFile);
            return (
              <button
                key={r.n}
                role="tab"
                aria-selected={filter === r.n}
                className={`shotlist-scene${filter === r.n ? " on" : ""}`}
                onClick={() => (filter === r.n ? selectAll() : selectScene(r.n))}
                title={`Scene ${r.n} — shot ${r.shot}${done ? " (complete)" : ""}`}
              >
                <span className={`dot${done ? " ok" : ""}`} aria-hidden="true" />
                Scene {r.n}
              </button>
            );
          })}
          <button
            role="tab"
            aria-selected={filter === "all"}
            className={`shotlist-scene${filter === "all" ? " on" : ""}`}
            onClick={selectAll}
            title={`Show all ${totalShots} scenes`}
          >
            All
          </button>
        </div>
      )}

      {loadError && <p className="hint err-text">{loadError}</p>}

      {/* Shot rows */}
      {totalShots === 0 ? (
        <div className="empty">
          <span className="empty-icon">
            <IconFilm size={20} />
          </span>
          <span className="empty-title">No beats yet</span>
          <span className="empty-sub">Add your first shot with Add shot below — it appears here.</span>
        </div>
      ) : (
        <div className="shotlist-list" role="table" aria-label="Shots">
          <div className="shotlist-row shotlist-row-head" role="row" aria-hidden="true">
            <span>Shot</span>
            <span>Description</span>
            <span>Type</span>
            <span className="num">Duration</span>
            <span>Status</span>
            <span className="num">Action</span>
          </div>
          <div className="shotlist-rows">
            {visible.map((r) => {
              const open = expanded.has(r.n);
              // Local beat-mutation states only — an active run no longer
              // locks every button (it queues instead).
              const localBusy = saving || genBusy;
              const imgRunning = targetRunning("keyframe", r.n);
              const imgQueued = !imgRunning && targetQueued("keyframe", r.n);
              const clipRunning = targetRunning("clip", r.n);
              const clipQueued = !clipRunning && targetQueued("clip", r.n);
              return (
                <div className="shotlist-row-wrap" key={r.n} role="rowgroup">
                  <div className="shotlist-row" role="row">
                    <span className="shotlist-shot" role="cell" title={`Scene ${r.n}, shot 1`}>
                      {r.shot}
                    </span>
                    <span className="shotlist-desc" role="cell">
                      <span className="shotlist-thumbs">
                        {r.imageFile ? (
                          <span
                            className="shotlist-thumb"
                            role="button"
                            tabIndex={0}
                            title={`Preview image ${r.shot}`}
                            onClick={() =>
                              setPreview({ src: outputUrl(outDir, r.imageFile!), kind: "image", alt: `shot ${r.shot} image` })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && r.imageFile)
                                setPreview({ src: outputUrl(outDir, r.imageFile), kind: "image", alt: `shot ${r.shot} image` });
                            }}
                          >
                            <SmoothImage src={outputUrl(outDir, r.imageFile)} alt="" />
                            <span className="shotlist-thumb-tag">{r.shot}</span>
                          </span>
                        ) : (
                          <span className="shotlist-thumb shotlist-thumb-empty" title="No image yet">
                            <IconImage size={14} />
                          </span>
                        )}
                        {r.clipFile ? (
                          <span
                            className="shotlist-thumb"
                            role="button"
                            tabIndex={0}
                            title={`Preview video ${r.shot}`}
                            onClick={() =>
                              setPreview({ src: outputUrl(outDir, r.clipFile!), kind: "video", alt: `shot ${r.shot} video` })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && r.clipFile)
                                setPreview({ src: outputUrl(outDir, r.clipFile), kind: "video", alt: `shot ${r.shot} video` });
                            }}
                          >
                            <video src={outputUrl(outDir, r.clipFile)} preload="metadata" muted playsInline />
                            <span className="shotlist-thumb-play" aria-hidden="true">
                              <IconPlay size={10} />
                            </span>
                            <span className="shotlist-thumb-tag">{r.shot}</span>
                          </span>
                        ) : (
                          <span className="shotlist-thumb shotlist-thumb-empty" title="No video yet">
                            <IconFilm size={14} />
                          </span>
                        )}
                      </span>
                      <span className="shotlist-desc-text" title={r.beat.image || r.beat.title}>
                        {r.beat.image || r.beat.title || <span className="muted">No prompt yet</span>}
                      </span>
                      <button
                        className="shotlist-details"
                        onClick={() => toggleExpand(r.n)}
                        aria-expanded={open}
                        title={open ? "Hide full prompts" : "Show full prompts"}
                      >
                        Details / Edit
                        <IconChevronDown size={12} />
                      </button>
                    </span>
                    <span role="cell">
                      <span className={`shotlist-type${r.type === "Lip-sync" ? " lip" : ""}`} title={`Shot type: ${r.type}`}>
                        {r.type}
                      </span>
                    </span>
                    <span className="shotlist-dur num" role="cell" title={`${clipDur}s per clip (project setting)`}>
                      {clipDur > 0 ? `${clipDur.toFixed(1)} s` : "—"}
                    </span>
                    <span className="shotlist-status" role="cell">
                      <StatusLine label="Image" status={r.imageStatus} title={r.imageError ?? undefined} />
                      <StatusLine label="Video" status={r.videoStatus} title={r.videoError ?? undefined} />
                    </span>
                    <span className="shotlist-actions num" role="cell">
                      <button
                        className="ghost shotlist-btn"
                        disabled={mutBusy}
                        title={mutBusy ? "A run is already in progress" : `Edit prompts for shot ${r.shot}`}
                        onClick={() => (editing === r.n ? cancelEdit() : startEdit(r.n))}
                      >
                        {editing === r.n ? "Close" : "Edit"}
                      </button>
                      {!isDraft &&
                        (!r.imageFile ? (
                          <button
                            className="ghost shotlist-btn"
                            disabled={localBusy}
                            title={imgQueued ? "Queued — starts when the current run finishes" : `Generate image for shot ${r.shot}`}
                            onClick={() => onRegen("keyframe", r.n)}
                          >
                            <IconImage size={11} />
                            {imgQueued ? "Queued" : "Gen image"}
                          </button>
                        ) : (
                          <button
                            className="ghost shotlist-btn"
                            disabled={localBusy || imgRunning}
                            title={imgRunning ? `Regenerating image for shot ${r.shot}…` : imgQueued ? "Queued — starts when the current run finishes" : `Regenerate image for shot ${r.shot} (keeps versions)`}
                            onClick={() => onRegen("keyframe", r.n)}
                          >
                            {imgRunning ? <Spinner size={11} /> : <IconRefresh size={11} />}
                            {imgRunning ? "Working…" : imgQueued ? "Queued" : "Regen img"}
                          </button>
                        ))}
                      {!isDraft &&
                        (!r.clipFile ? (
                          <button
                            className="ghost shotlist-btn"
                            disabled={localBusy || !r.imageFile}
                            title={
                              !r.imageFile
                                ? "Generate the image first — video runs from the keyframe"
                                : clipQueued
                                  ? "Queued — starts when the current run finishes"
                                  : `Generate video for shot ${r.shot}`
                            }
                            onClick={() => onRegen("clip", r.n)}
                          >
                            <IconPlay size={11} />
                            {clipQueued ? "Queued" : "Gen video"}
                          </button>
                        ) : (
                          <button
                            className="ghost shotlist-btn"
                            disabled={localBusy || clipRunning}
                            title={clipRunning ? `Regenerating video for shot ${r.shot}…` : clipQueued ? "Queued — starts when the current run finishes" : `Regenerate video for shot ${r.shot} (keeps versions)`}
                            onClick={() => onRegen("clip", r.n)}
                          >
                            {clipRunning ? <Spinner size={11} /> : <IconRefresh size={11} />}
                            {clipRunning ? "Working…" : clipQueued ? "Queued" : "Regen vid"}
                          </button>
                        ))}
                    </span>
                  </div>
                  {open && (
                    <div className="shotlist-detail">
                      {editing === r.n ? (
                        <>
                          <div className="shotlist-detail-title">
                            Scene {r.n} · editing {r.beat.title || `beat${r.n}`}
                          </div>
                          {renderEditForm(false, r.n)}
                        </>
                      ) : (
                        <>
                          <div className="shotlist-detail-title" title="Beat title">
                            Scene {r.n} · {r.beat.title || `beat${r.n}`}
                          </div>
                          <div className="shotlist-detail-grid">
                            <div>
                              <div className="shotlist-detail-label">Keyframe prompt — Flux</div>
                              <p>{r.beat.image || <span className="muted">—</span>}</p>
                            </div>
                            <div>
                              <div className="shotlist-detail-label">Motion &amp; camera — i2v</div>
                              <p>{r.beat.motion || <span className="muted">—</span>}</p>
                            </div>
                          </div>
                          <div className="shotlist-detail-meta">
                            <span className="muted">
                              {r.imageFile ? `img: ${r.imageFile}` : "img: —"}
                              {" · "}
                              {r.clipFile ? `vid: ${r.clipFile}` : "vid: —"}
                            </span>
                            {(r.imageError || r.videoError) && (
                              <span className="err-text">{r.imageError ?? r.videoError}</span>
                            )}
                            <span className="spacer" />
                            <button
                              className="ghost shotlist-btn"
                              disabled={mutBusy}
                              title={mutBusy ? "A run is already in progress" : `Edit prompts for shot ${r.shot}`}
                              onClick={() => startEdit(r.n)}
                            >
                              Edit shot
                            </button>
                        {r.imageFile && (
                          <button
                            className="ghost shotlist-btn"
                            onClick={() =>
                              setPreview({ src: outputUrl(outDir, r.imageFile!), kind: "image", alt: `shot ${r.shot} image` })
                            }
                          >
                            View image
                          </button>
                        )}
                        {r.clipFile && (
                          <button
                            className="ghost shotlist-btn"
                            onClick={() =>
                              setPreview({ src: outputUrl(outDir, r.clipFile!), kind: "video", alt: `shot ${r.shot} video` })
                            }
                          >
                            Play video
                          </button>
                        )}
                      </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Beat tools: add + LLM-generate (moved here from the editor) */}
      <div className="row" style={{ marginTop: 4 }}>
        <button
          className="ghost"
          onClick={addShot}
          disabled={mutBusy}
          title={mutBusy ? "A run is already in progress" : "Append a shot — fill in its prompts, then Add shot"}
        >
          <IconPlus size={13} />
          Add shot
        </button>
        <button
          className="ghost"
          onClick={() => void generateBeats()}
          disabled={mutBusy}
          title="LLM proposes the next beat(s) from the scenario + existing shots"
        >
          {genBusy ? <Spinner size={13} /> : <IconSparkles size={13} />}
          {genBusy ? "Generating…" : "Generate beat"}
        </button>
        <label className="gen-count wide" title="How many next beats to generate (1 or more)">
          ×
          <input
            type="number"
            min={1}
            value={genCount}
            disabled={mutBusy}
            onChange={(e) => setGenCount(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
      </div>
      {genError && <p className="hint err-text">{genError}</p>}
      <p className="hint">
        {isDraft
          ? "Shot edits apply to the unsaved draft — press Save Scenario to persist them."
          : "Shot edits save immediately as a new scenario version."}{" "}
        Generate beat asks the LLM for the next story beat(s) from the scenario JSON.
      </p>

      {/* Appended-shot form */}
      {editing === "new" && (
        <div className="shotlist-detail">
          <div className="shotlist-detail-title">New shot · Scene {seq.length + 1}</div>
          {renderEditForm(true, null)}
        </div>
      )}

      {/* Footer: stitch shortcut reuses the existing final-cut run */}
      {!isDraft && totalShots > 0 && onStitch && (
        <div className="shotlist-foot">
          <span className="muted">
            {clipDone}/{totalShots} clips · {refDone ? "ref ready" : "ref pending"}
          </span>
          <span className="spacer" />
          <button className="ghost" disabled={!!runBusy || clipDone === 0} onClick={onStitch} title="Concatenate the main clip versions into the final cut">
            Stitch final
          </button>
        </div>
      )}

      {/* Hidden scene-badge host: keeps the established overlay component in the
          bundle for thumbnail numbering consistency (visual tag is inline). */}
      <span style={{ display: "none" }} aria-hidden="true">
        <SceneBadge scene={1} total={1} />
        <IconCheck size={1} />
      </span>
      </>
      )}
    </section>
  );
}

function StatusLine({ label, status, title }: { label: "Image" | "Video"; status: ShotStatus; title?: string }) {
  if (status === "generated")
    return (
      <span className="shotlist-st shotlist-st-ok" title={title ?? `${label} generated`}>
        <span className="shotlist-st-tag">{label}</span>
        <span className="shotlist-st-val">✓ Generated</span>
      </span>
    );
  if (status === "generating")
    return (
      <span className="shotlist-st shotlist-st-run" title={title ?? `${label} generating…`}>
        <span className="shotlist-st-tag">{label}</span>
        <span className="shotlist-st-val">
          <span className="dot pulse" aria-hidden="true" /> Generating
        </span>
      </span>
    );
  if (status === "failed")
    return (
      <span className="shotlist-st shotlist-st-err" title={title ?? `${label} failed`}>
        <span className="shotlist-st-tag">{label}</span>
        <span className="shotlist-st-val">⚠ Failed</span>
      </span>
    );
  return (
    <span className="shotlist-st" title={title ?? `${label} pending`}>
      <span className="shotlist-st-tag">{label}</span>
      <span className="shotlist-st-val muted">○ Pending</span>
    </span>
  );
}
