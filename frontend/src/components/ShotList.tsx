import { useEffect, useMemo, useState } from "react";
import {
  listOutputs,
  listProjectAssets,
  listVersions,
  outputUrl,
  outScenario,
  type Engine,
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
import { SceneBadge } from "./OutputGallery";
import {
  IconCheck,
  IconChevronDown,
  IconClapper,
  IconFilm,
  IconImage,
  IconPlay,
  IconRefresh,
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
}: Props) {
  const [outputs, setOutputs] = useState<OutputsInfo>(emptyOutputs);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [versions, setVersions] = useState<ScenarioVersionInfo[]>([]);
  const [filter, setFilter] = useState<number | "all">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [loadError, setLoadError] = useState("");

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

  useEffect(() => {
    if (!name) {
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
  }, [name, outDir, refreshKey, generatingScenario]); // eslint-disable-line react-hooks/exhaustive-deps

  const versionsInfo: VersionsInfo = outputs.versions ?? { ref: [], beats: {} };
  const mainsInfo: MainsInfo = outputs.mains ?? { ref: null, beats: {} };

  // Exact asset row for (beat, type) from the effective project state.
  const assetFor = (beat: number, type: "KEYFRAME" | "VIDEO"): ProjectAsset | null => {
    const rows = assets.filter((r) => r.beat_index === beat && r.asset_type === type);
    if (!rows.length) return null;
    // Effective query already resolves one row per key; prefer the latest version.
    return rows.reduce((a, b) => (b.version > a.version ? b : a));
  };

  const generatingHere = !!generatingScenario && !!outDir && generatingScenario === outDir;

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

  // Selecting a scene tab reveals that scene's full Scenario Editor data
  // (Keyframe image — Flux + Motion & camera — i2v prompts). All reveals the
  // full data for every scene. Details / Edit still toggles rows individually.
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

  // Jump to the matching beat block in the Scenario Editor (same workspace
  // column) so prompt edits happen where they always have.
  const editInEditor = (n: number) => {
    const beats = document.querySelectorAll(".beat");
    const el = beats[n - 1];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const input = el.querySelector("input, textarea") as HTMLElement | null;
      input?.focus({ preventScroll: true });
    }
  };

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
    <section className="card shotlist" aria-label={`Shot list for ${name}`}>
      {preview && <Lightbox item={preview} onClose={() => setPreview(null)} />}

      {/* Header */}
      <div className="shotlist-head">
        <div className="shotlist-head-left">
          <div className="shotlist-kicker">Shot List</div>
          <h2 className="shotlist-title">Shot List</h2>
          <p className="shotlist-sub">— every scene, every beat</p>
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
          <button className="ghost shotlist-edit" onClick={() => editInEditor(filter === "all" ? 1 : filter)}>
            Edit
          </button>
        </div>
      </div>

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
          <span className="empty-sub">Add beats in the Scenario Editor, then save — they appear here as shots.</span>
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
              const busy = !!runBusy;
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
                            <img src={outputUrl(outDir, r.imageFile)} alt="" loading="lazy" />
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
                      {!r.imageFile ? (
                        <button
                          className="ghost shotlist-btn"
                          disabled={busy}
                          title={busy ? "A run is already in progress" : `Generate image for shot ${r.shot}`}
                          onClick={() => onRegen("keyframe", r.n)}
                        >
                          <IconImage size={11} />
                          Gen image
                        </button>
                      ) : (
                        <button
                          className="ghost shotlist-btn"
                          disabled={busy}
                          title={busy ? "A run is already in progress" : `Regenerate image for shot ${r.shot} (keeps versions)`}
                          onClick={() => onRegen("keyframe", r.n)}
                        >
                          <IconRefresh size={11} />
                          {r.imageStatus === "generating" ? "Working…" : "Regen img"}
                        </button>
                      )}
                      {!r.clipFile ? (
                        <button
                          className="ghost shotlist-btn"
                          disabled={busy || !r.imageFile}
                          title={
                            busy
                              ? "A run is already in progress"
                              : !r.imageFile
                                ? "Generate the image first — video runs from the keyframe"
                                : `Generate video for shot ${r.shot}`
                          }
                          onClick={() => onRegen("clip", r.n)}
                        >
                          <IconPlay size={11} />
                          Gen video
                        </button>
                      ) : (
                        <button
                          className="ghost shotlist-btn"
                          disabled={busy}
                          title={busy ? "A run is already in progress" : `Regenerate video for shot ${r.shot} (keeps versions)`}
                          onClick={() => onRegen("clip", r.n)}
                        >
                          <IconRefresh size={11} />
                          {r.videoStatus === "generating" ? "Working…" : "Regen vid"}
                        </button>
                      )}
                    </span>
                  </div>
                  {open && (
                    <div className="shotlist-detail">
                      <div className="shotlist-detail-title" title="Beat title as saved in the Scenario Editor">
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
                        <button className="ghost shotlist-btn" onClick={() => editInEditor(r.n)}>
                          Edit in Scenario Editor
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
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer: stitch shortcut reuses the existing final-cut run */}
      {totalShots > 0 && onStitch && (
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
