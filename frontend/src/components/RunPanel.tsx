import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { startRun, killRun, tailRun, outScenario, getScenario, type AssetEvent, type Engine, type RegenSpec, type VideoFormat, type VideoType } from "../api";
import OutputGallery from "./OutputGallery";
import { useDialog } from "./Dialog";
import { MIN_TASK_MS, formatElapsed, formatStarted, loadPace, recordPaceDuration, type GenerationProgress } from "./GenerationProgressBar";
import RenderMonitor, { type RmPin } from "./RenderMonitor";
import { IconPanel, IconPlay, IconScissors, IconStop, IconClapper, Spinner } from "./Icons";
import Collapse from "./Collapse";

export type RunStatus = "idle" | "running" | "done" | "error";

// One collapsible zone inside the Rendered Clip card (Program / Render /
// Terminal), each with its own persisted hide/show toggle. Bodies stay
// mounted and animate via Collapse (Terminal log keeps streaming +
// autoscrolling while hidden).
function RunPart({ storageKey, title, label, children }: {
  storageKey: string;
  title: string;
  label: string;
  children: ReactNode;
}) {
  const [hidden, setHidden] = useState(() => localStorage.getItem(storageKey) === "closed");
  const toggle = () =>
    setHidden((h) => {
      localStorage.setItem(storageKey, h ? "open" : "closed");
      return !h;
    });
  return (
    <section className="rm-part" aria-label={label}>
      <div className="rm-part-head">
        <span className="rm-part-title">{title}</span>
        <span className="spacer" />
        <button
          className="icon-btn"
          onClick={toggle}
          title={hidden ? `Show ${label}` : `Hide ${label}`}
          aria-label={hidden ? `Show ${label}` : `Hide ${label}`}
          aria-expanded={!hidden}
        >
          <IconPanel size={15} />
        </button>
      </div>
      <Collapse open={!hidden}>
        <div className="rm-part-body">{children}</div>
      </Collapse>
    </section>
  );
}

interface Props {
  scenario: string;
  /** Immutable storage folder for the viewed project (outputs/<folder>/). */
  folder?: string;
  engine: Engine;
  onEngine: (e: Engine) => void;
  /** Which cut this section shows and generates: YOUTUBE (landscape main
      cut) or INSTAGRAM (9:16 Reel cut). A live run always owns the panel;
      the selection applies to the idle view and the next header run. */
  videoType?: VideoType;
  onVideoType?: (v: VideoType) => void;
  onDone: () => void;
  // Status reports the regen spec + format of the run that is actually active
  // (null regen for full runs, "landscape" default format) — so the gallery /
  // editor can spin exactly the button that triggered it instead of every
  // busy-looking button.
  onStatus?: (s: RunStatus, scenario: string, regen: RegenSpec | null, format: VideoFormat) => void;
  // External run trigger (Stitch final / Regenerate from the output gallery /
  // Generate Reference from the scenario editor; count batches ref regens).
  // Queued requests carry the engine + format they were asked for (they may
  // have been switched since they were queued).
  pendingRun: { nonce: number; stitch?: boolean; regen?: RegenSpec | null; count?: number; engine?: Engine; format?: VideoFormat; mode?: "dialogue"; beats?: string; noStitch?: boolean } | null;
  // Reattach target: a run that was already active on the server when this
  // page loaded (e.g. after a refresh). RunPanel reopens its SSE tail — the
  // server replays the full log + asset events — so progress, the header bar
  // and every generating button pick up the live run instead of idling.
  attachRun?: { id: string; scenario: string; folder?: string; stitch?: boolean; regen?: RegenSpec | null; count?: number; mode?: "dialogue"; beats?: string | null; startedAt?: number; format?: VideoFormat } | null;
  // Run the server reports as active (from GET /api/runs, polled by App) —
  // independent of this panel's own run. While set and this panel is idle,
  // the backend rejects new runs, so the panel names the blocker and offers
  // to stop it instead of failing silently into the log.
  serverRun?: { id: string; scenario: string; startedAt: number } | null;
  // Live progress reports (real assets/timing — App renders the sticky global bar).
  onProgress?: (p: GenerationProgress) => void;
  /** ComfyUI queue depth (running + pending) for the monitor's QUEUE readout. */
  comfyQueue?: number;
}

// Start / stitch / stop a run + live log tail (SSE) + live asset gallery.
// Progress + ETA are derived from the real asset stream (see `progress`
// below) — never fake timers.
export default function RunPanel({ scenario, folder, engine, onEngine, videoType = "YOUTUBE", onVideoType, onDone, onStatus, pendingRun, attachRun, serverRun, onProgress, comfyQueue = 0 }: Props) {
  // Displayed cut: the live run owns the panel while running; when idle the
  // YOUTUBE/INSTAGRAM dropdown picks which cut's outputs show (and what the
  // header Generate/Stitch buttons produce next).
  const idleFormat: VideoFormat = videoType === "INSTAGRAM" ? "vertical" : "landscape";
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  // Scenario this panel's run is generating (captured at start, so it stays
  // correct even if the user switches scenarios mid-run). runRegen is the
  // trigger of the active run (null = full run) — reported via onStatus so
  // App never has to guess from a stale pendingRun.
  const [runScenario, setRunScenario] = useState<string | null>(null);
  // Storage folder of the active run (from the start response / server
  // record) — output dirs resolve from this, never the display name.
  const [runFolder, setRunFolder] = useState<string | null>(null);
  const [runRegen, setRunRegen] = useState<RegenSpec | null>(null);
  // Engine the active run was started with (captured at start — the header
  // engine switch must not rewrite the monitor's badge/URLs mid-run).
  const [runEngine, setRunEngine] = useState<Engine | null>(null);
  // Cut the active run generates ("landscape" = main video, "vertical" =
  // 9:16 Instagram Reel). Captured at start like the engine — the Reel card
  // owns its own trigger, so there is no format toggle here.
  const [runFormat, setRunFormat] = useState<VideoFormat>("landscape");
  // Which local button started the POST (null = triggered externally via
  // pendingRun, or idle). Shows the spinner on the clicked button during
  // the startRun round-trip, before status flips to "running".
  const [starting, setStarting] = useState<"run" | "stitch" | "dialogue" | null>(null);
  const [stopping, setStopping] = useState(false);
  // Stopping a FOREIGN server run (the banner below) — separate from stopping
  // this panel's own run. Resets once the server stops reporting it.
  const [stoppingServer, setStoppingServer] = useState(false);
  useEffect(() => { if (!serverRun) setStoppingServer(false); }, [serverRun]);

  // Idle view follows the selected project — never the previous run's
  // captured scenario/folder/engine. A live run owns the panel regardless.
  const idle = status !== "running";
  const displayScenario = idle ? scenario : (runScenario ?? scenario);
  const displayFolder = idle ? (folder ?? scenario) : (runFolder ?? folder ?? runScenario ?? scenario);
  const displayEngine = idle ? engine : (runEngine ?? engine);
  const displayFormat: VideoFormat = idle ? idleFormat : runFormat;
  const displayOutDir = displayFolder ? outScenario(displayFolder, displayEngine, displayFormat) : "";

  // Project switch while idle: drop the previous project's run state
  // (scenario/folder/assets/log/totals) so the Rendered Clip card reloads
  // for the newly selected project instead of keeping the old clip on
  // screen. A live run owns the panel — switching mid-run keeps the tail
  // until it finishes (see the run-end effect below).
  const viewedKey = `${scenario}|${folder ?? ""}`;
  const prevViewedKey = useRef(viewedKey);
  useEffect(() => {
    if (prevViewedKey.current === viewedKey) return;
    prevViewedKey.current = viewedKey;
    if (status === "running") return;
    setRunScenario(null);
    setRunFolder(null);
    setRunRegen(null);
    setRunEngine(null);
    setRunMeta({ stitch: false, regen: null, count: 1 });
    setAssets([]);
    setLog("");
    setAssetTimes([]);
    setStartedAt(null);
    setEndedAt(null);
    setCancelled(false);
    setPin(null);
    setTotalBeats(null);
    setDlgBeats(null);
    setStatus("idle");
    if (scenario) {
      getScenario(scenario)
        .then((r) => {
          const seq = Array.isArray(r.config.sequence) ? r.config.sequence : [];
          setTotalBeats(seq.length || null);
          setDlgBeats(seq.filter((b) => Array.isArray(b.dialogue) && b.dialogue.some((d) => d && String(d.line || "").trim())).length || null);
        })
        .catch(() => { setTotalBeats(null); setDlgBeats(null); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewedKey]);

  // A run that finishes while another project is on screen must not leave
  // its assets/log/progress behind — fall back to the viewed project's
  // idle state instead of showing the other project's results here.
  useEffect(() => {
    if (status === "running") return;
    if (!runScenario || runScenario === scenario) return;
    setRunScenario(null);
    setRunFolder(null);
    setRunRegen(null);
    setRunEngine(null);
    setRunMeta({ stitch: false, regen: null, count: 1 });
    setAssets([]);
    setLog("");
    setAssetTimes([]);
    setStartedAt(null);
    setEndedAt(null);
    setCancelled(false);
    setPin(null);
    setTotalBeats(null);
    setDlgBeats(null);
    setStatus("idle");
    if (scenario) {
      getScenario(scenario)
        .then((r) => {
          const seq = Array.isArray(r.config.sequence) ? r.config.sequence : [];
          setTotalBeats(seq.length || null);
          setDlgBeats(seq.filter((b) => Array.isArray(b.dialogue) && b.dialogue.some((d) => d && String(d.line || "").trim())).length || null);
        })
        .catch(() => { setTotalBeats(null); setDlgBeats(null); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, runScenario, scenario]);

  useEffect(() => { onStatus?.(status, runScenario ?? scenario, status === "running" ? runRegen : null, runFormat); }, [status, onStatus, runScenario, runRegen, runFormat, scenario]);
  useEffect(() => { if (status !== "running") setStopping(false); }, [status]);
  const [log, setLog] = useState("");
  const [assets, setAssets] = useState<AssetEvent[]>([]);
  const closeTail = useRef<() => void>(() => {});
  const boxRef = useRef<HTMLPreElement>(null);
  // Real progress inputs: total beats from the scenario config, run shape,
  // start/end timestamps, and per-asset completion times for the ETA.
  const [totalBeats, setTotalBeats] = useState<number | null>(null);
  const [dlgBeats, setDlgBeats] = useState<number | null>(null);
  const [runMeta, setRunMeta] = useState<{ stitch: boolean; regen: RegenSpec | null; count: number; mode?: "dialogue" }>({ stitch: false, regen: null, count: 1 });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Anchor of the per-asset interval chain (see the ETA memo below). Fresh
  // runs anchor at start; reattached runs anchor at reattach time — the real
  // completion times of pre-refresh assets are unknown, so measuring from
  // run start would fabricate one huge first interval and corrupt the ETA.
  const [timeAnchor, setTimeAnchor] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [assetTimes, setAssetTimes] = useState<{ time: number; stage: AssetEvent["stage"] }[]>([]);
  const [cancelled, setCancelled] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Shared PROGRAM pin across the split Program/Render monitor instances —
  // Render chips drive the Program viewport like before the split.
  const [pin, setPin] = useState<RmPin | null>(null);
  // Hide/show toggle (same as the Projects panel — persisted). Collapsing
  // only hides the body JSX; the component stays mounted so a running
  // generation keeps its live log, progress and SSE tail.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-run") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-run", c ? "open" : "closed");
      return !c;
    });
  const dialog = useDialog();
  // Pace bookkeeping (refs, not state — written from the SSE callback):
  // last completion time + already-seen files, so each landed asset records
  // exactly one duration sample even if the server re-emits an event.
  const lastAssetAt = useRef<number>(0);
  const seenFiles = useRef<Set<string>>(new Set());

  // Shared SSE asset handler for fresh + reattached tails. Replayed backlog
  // events (replay: true — the server dumps pre-refresh assets once on SSE
  // connect) restore counts/gallery but carry no timing: stamping them "now"
  // would fabricate one huge interval (reattach − run start), corrupting the
  // Time Remaining ETA and poisoning the persisted pace for future runs.
  const handleAssetEvent = (a: AssetEvent) => {
    const t = Date.now();
    // First sighting only: record one pace sample (completion interval
    // attributed to the asset that just finished) and keep assetTimes
    // duplicate-free so ETA averages never double-count.
    if (!seenFiles.current.has(a.file)) {
      seenFiles.current.add(a.file);
      if (!a.replay) {
        // Only real generations seed the pace: reference/keyframe images
        // and i2v clips. The fast ffmpeg stitch ("final") and any
        // resume-skip are filtered by duration inside recordPaceDuration.
        const image = a.stage === "reference" || a.stage === "keyframe";
        if (image || a.stage === "clip") {
          recordPaceDuration(image, t - lastAssetAt.current);
        }
        lastAssetAt.current = t;
        setAssetTimes((prev) => [...prev, { time: t, stage: a.stage }]);
      }
    }
    setNow(t);
    setAssets((prev) => prev.some((x) => x.file === a.file) ? prev : [...prev, a]);
  };

  useEffect(() => () => closeTail.current(), []);
  useEffect(() => {
    boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [log]);

  // Tick the clock every second while running so elapsed + all Remaining
  // countdowns tick live in real time between asset completions — and while
  // a foreign server run blocks this panel, so its elapsed stays live too.
  useEffect(() => {
    if (status !== "running" && !serverRun) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status, serverRun]);

  const begin = async (stitch: boolean, regen: RegenSpec | null = null, count = 1, which: "run" | "stitch" | "dialogue" | "external" = "external", runEngine: Engine = engine, runFormat: VideoFormat = "landscape", mode?: "dialogue", beats?: string, noStitch?: boolean) => {
    if (!scenario) return;
    if (which !== "external") setStarting(which);
    try {
      const res = await startRun(scenario, { stitch, regen, engine: runEngine, format: runFormat, count, mode, beats, noStitch });
      if (!res.id) throw new Error(res.error || "run rejected by server");
      const { id } = res;
      setRunId(id);
      setRunScenario(scenario);
      setRunFolder(res.folder ?? folder ?? scenario);
      setRunRegen(regen);
      setRunEngine(runEngine);
      setRunFormat(runFormat);
      setRunMeta({ stitch, regen, count: regen?.kind === "ref" ? Math.min(8, Math.max(1, Number(count) || 1)) : 1, ...(mode ? { mode } : {}) });
      // Keep the previous total until the fresh config lands — clearing it
      // here is what briefly hid every thumbnail slot right after Generate.
      setStartedAt(Date.now());
      setTimeAnchor(Date.now());
      lastAssetAt.current = Date.now();
      seenFiles.current = new Set();
      setEndedAt(null);
      setAssetTimes([]);
      setCancelled(false);
      setNow(Date.now());
      // Real total comes from the saved scenario config (sequence length +
      // dialogue-beat count for voice runs).
      getScenario(scenario)
        .then((r) => {
          const seq = Array.isArray(r.config.sequence) ? r.config.sequence : [];
          setTotalBeats(seq.length || null);
          setDlgBeats(seq.filter((b) => Array.isArray(b.dialogue) && b.dialogue.some((d) => d && String(d.line || "").trim())).length || null);
        })
        .catch(() => { setTotalBeats(null); setDlgBeats(null); });
      setStatus("running");
      setLog("");
      setAssets([]);
      closeTail.current();
      closeTail.current = tailRun(
        id,
        (line) => setLog((l) => l + line),
        (s) => { setEndedAt(Date.now()); setNow(Date.now()); setStatus(s === "done" ? "done" : "error"); onDone(); },
        handleAssetEvent
      );
    } catch (e) {
      setEndedAt(Date.now());
      setStatus("error");
      setLog(`run failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
    } finally {
      setStarting(null);
    }
  };

  // Runs triggered from the output gallery (stitch / regenerate) or the
  // scenario editor (batch reference generation).
  useEffect(() => {
    if (pendingRun) begin(!!pendingRun.stitch, pendingRun.regen || null, pendingRun.count ?? 1, "external", pendingRun.engine ?? engine, pendingRun.format ?? "landscape", pendingRun.mode, pendingRun.beats, pendingRun.noStitch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRun?.nonce]);

  // Reattach to a run that outlived the page (refresh while generating).
  // Same live tail as a locally started run — replayed log + asset events
  // rebuild progress from the real stream — but the run shape comes from the
  // server record, never from a guess. Runs once per run id (StrictMode
  // safe); never steals a locally started run.
  const attachedId = useRef<string | null>(null);
  useEffect(() => { if (!attachRun) attachedId.current = null; }, [attachRun]);
  useEffect(() => {
    if (!attachRun || attachedId.current === attachRun.id) return;
    // Never steal a live run (local or already attached); a finished
    // previous run (done/error, different id) may re-attach freely.
    if (status === "running" || (runId && runId === attachRun.id)) return;
    attachedId.current = attachRun.id;
    const meta = attachRun;
    const regen = meta.regen ?? null;
    setRunId(meta.id);
    // The run's own scenario, not the currently viewed one — the user may
    // have refreshed while looking at a different project.
    setRunScenario(meta.scenario);
    setRunFolder(meta.folder ?? folder ?? meta.scenario);
    setRunRegen(regen);
    setRunEngine(engine);
    setRunFormat(meta.format ?? "landscape");
    setRunMeta({ stitch: !!meta.stitch, regen, count: regen?.kind === "ref" ? Math.min(8, Math.max(1, Number(meta.count) || 1)) : 1, ...(meta.mode === "dialogue" ? { mode: meta.mode as "dialogue" } : {}) });
    // Same as begin(): keep the previous total so thumbnail slots stay
    // mounted while the reattached run's config loads. Timing anchors at the
    // reattach moment (pre-refresh completion times are unknown — the replay
    // backlog carries no timing, see handleAssetEvent).
    setStartedAt(meta.startedAt ?? Date.now());
    setTimeAnchor(Date.now());
    lastAssetAt.current = Date.now();
    seenFiles.current = new Set();
    setEndedAt(null);
    setAssetTimes([]);
    setCancelled(false);
    setNow(Date.now());
    getScenario(meta.scenario)
      .then((r) => {
        const seq = Array.isArray(r.config.sequence) ? r.config.sequence : [];
        setTotalBeats(seq.length || null);
        setDlgBeats(seq.filter((b) => Array.isArray(b.dialogue) && b.dialogue.some((d) => d && String(d.line || "").trim())).length || null);
      })
      .catch(() => { setTotalBeats(null); setDlgBeats(null); });
    setStatus("running");
    setLog("");
    setAssets([]);
    closeTail.current();
    closeTail.current = tailRun(
      meta.id,
      (line) => setLog((l) => l + line),
      (s) => { setEndedAt(Date.now()); setNow(Date.now()); setStatus(s === "done" ? "done" : "error"); onDone(); },
      handleAssetEvent
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachRun?.id]);

  // Real progress from the live asset stream + scenario totals.
  // Pipeline order is sequential: reference → N keyframes → N clips → stitch.
  // Full run total = 1 + 2N tasks; regen/stitch runs total = their own task(s).
  const progress: GenerationProgress = useMemo(() => {
    const N = totalBeats;
    const { stitch, regen, count, mode } = runMeta;
    const refDone = assets.some((a) => a.stage === "reference") ? 1 : 0;
    const kfIdx = new Set(assets.filter((a) => a.stage === "keyframe").map((a) => a.index ?? -1));
    const clipIdx = new Set(assets.filter((a) => a.stage === "clip").map((a) => a.index ?? -1));
    kfIdx.delete(-1);
    clipIdx.delete(-1);
    const dlgIdx = new Set(assets.filter((a) => a.stage === "dialogue").map((a) => a.index ?? -1));
    dlgIdx.delete(-1);
    const hasFinal = assets.some((a) => a.stage === "final");
    const start = startedAt ?? now;
    const end = status === "running" ? now : (endedAt ?? now);
    const elapsedMs = Math.max(0, end - start);

    let total = 0;
    let completed = 0;
    let imagesDone = 0;
    let imagesTotal = 0;
    let videosDone = 0;
    let videosTotal = 0;
    let scene: number | null = null;
    let etaMs: number | null = null;

    if (stitch) {
      total = 1;
      completed = hasFinal ? 1 : 0;
      videosDone = completed;
      videosTotal = 1;
    } else if (regen?.kind === "ref") {
      total = Math.max(1, count);
      completed = Math.min(total, assets.filter((a) => a.stage === "reference").length);
      imagesDone = completed;
      imagesTotal = total;
    } else if (regen && (regen.kind === "keyframe" || regen.kind === "clip")) {
      total = 1;
      completed = assets.length > 0 ? 1 : 0;
      scene = regen.index ?? null;
      if (regen.kind === "keyframe") { imagesDone = completed; imagesTotal = 1; }
      else { videosDone = completed; videosTotal = 1; }
    } else if (mode === "dialogue" && dlgBeats != null) {
      // Voice + lip-sync run: D voice tracks + D synced clips + re-stitch.
      total = 2 * dlgBeats + 1;
      videosTotal = dlgBeats + 1;
      videosDone = clipIdx.size + (hasFinal ? 1 : 0);
      completed = dlgIdx.size + videosDone;
      const seen = Math.max(0, ...[...dlgIdx, ...clipIdx]);
      scene = dlgBeats === 0 ? null : Math.min(dlgBeats, Math.max(1, seen || 1));
    } else if (N != null) {
      // Full run: 1 reference + N keyframes (images) + N clips (videos).
      total = 1 + 2 * N;
      imagesTotal = 1 + N;
      videosTotal = N;
      imagesDone = refDone + kfIdx.size;
      videosDone = clipIdx.size;
      completed = imagesDone + videosDone;
      const seen = Math.max(0, ...[...kfIdx, ...clipIdx]);
      scene = N === 0 ? null : Math.min(N, Math.max(1, seen || 1));
      if (regen?.index != null) scene = regen.index;
    } else {
      // Totals still loading — report what has actually landed.
      completed = assets.length;
      total = 0;
      imagesDone = refDone + kfIdx.size;
      videosDone = clipIdx.size;
    }

    let pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
    if (hasFinal) pct = 100;

    // ETA from real per-asset durations: each completion interval is
    // attributed to the asset that just finished, so image and video averages
    // stay separate (clips usually take much longer than keyframes).
    // Live countdown: the static remaining-work estimate minus the time
    // already spent on the asset currently in flight, so every Time Remaining
    // ticks down each second instead of freezing between completions.
    // Before anything has completed, the historical pace (previous runs on
    // this machine) seeds the estimate so the countdown moves from second
    // one; live measurements take over as assets land.
    let imagesEtaMs: number | null = null;
    let videosEtaMs: number | null = null;
    // In-flight asset estimate: elapsed vs expected duration (same pace
    // sources as the ETA above). Estimated — ComfyUI only signals completion.
    let activeKind: "image" | "video" | null = null;
    let activeScene: number | null = null;
    let activePct: number | null = null;
    let activeElapsedMs: number | null = null;
    let activeExpectedMs: number | null = null;
    if (status === "running" && startedAt != null && total > completed) {
      const times = assetTimes;
      // Completion intervals attributed to the asset that just finished.
      // "gen" buckets real generations only: clips are video, reference +
      // keyframes are images, the ffmpeg stitch ("final") is neither.
      // The prev-chain advances through every event (so in-flight time stays
      // exact), but sub-threshold resume-skips are dropped from the averages
      // below — otherwise a re-run's instant skips collapse the pace toward
      // zero and Time Remaining freezes at 00h:00m:00s for the whole run.
      const durs: { d: number; gen: "image" | "video" | null }[] = [];
      // Anchored at run start for fresh runs, at reattach time for reattached
      // runs (pre-refresh completions carry no timestamps — measuring from
      // run start would fabricate one huge first interval and blow up the
      // ETA after every refresh).
      let prev = timeAnchor ?? startedAt;
      for (const t of times) {
        const gen =
          t.stage === "clip" ? "video"
          : t.stage === "reference" || t.stage === "keyframe" ? "image"
          : null;
        durs.push({ d: Math.max(0, t.time - prev), gen });
        prev = t.time;
      }
      const real = durs.filter((x) => x.gen != null && x.d >= MIN_TASK_MS);
      const img = real.filter((x) => x.gen === "image").map((x) => x.d);
      const vid = real.filter((x) => x.gen === "video").map((x) => x.d);
      const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
      const overall = real.length ? avg(real.map((x) => x.d)) : NaN;
      const pace = loadPace();
      const avgImg = img.length ? avg(img) : (pace.img ?? overall);
      const avgVid = vid.length ? avg(vid) : (pace.vid ?? overall);
      const usable = (v: number) => Number.isFinite(v) && v >= 0;
      const usablePos = (v: number) => Number.isFinite(v) && v > 0;
      const remImg = Math.max(0, imagesTotal - imagesDone);
      const remVid = Math.max(0, videosTotal - videosDone);
      // Pipeline is sequential with at most one asset in flight; images
      // render before clips, so in-flight time belongs to images while any
      // image is still pending, otherwise to videos.
      const sinceLast = Math.max(0, now - prev);
      // Which single asset is in flight (first missing in pipeline order),
      // so the keyframe/clip tiles can show an estimated % on exactly that
      // tile. Regen runs target one asset; full runs head for the first
      // missing reference → keyframe → clip. Determined independently of
      // pace so the tile always knows it is in flight (elapsed ticks even
      // when no pace exists yet for a % estimate).
      if (!stitch) {
        if (regen?.kind === "keyframe") { activeKind = "image"; activeScene = regen.index ?? null; }
        else if (regen?.kind === "clip") { activeKind = "video"; activeScene = regen.index ?? null; }
        else if (regen?.kind === "ref") { activeKind = "image"; activeScene = 0; }
        else if (N != null) {
          if (!refDone) { activeKind = "image"; activeScene = 0; }
          else {
            let kfMissing: number | null = null;
            for (let i = 1; i <= N; i++) {
              if (!kfIdx.has(i)) { kfMissing = i; break; }
            }
            if (kfMissing != null) { activeKind = "image"; activeScene = kfMissing; }
            else {
              for (let i = 1; i <= N; i++) {
                if (!clipIdx.has(i)) { activeKind = "video"; activeScene = i; break; }
              }
            }
          }
        }
      }
      // ETA per category needs only its OWN average (a single-asset regen
      // must not wait for the other category's pace that may never exist).
      // Fallback chain per category: live average → historical pace →
      // overall average across both kinds.
      const expImg = usablePos(avgImg) ? avgImg : usablePos(overall) ? overall : NaN;
      const expVid = usablePos(avgVid) ? avgVid : usablePos(overall) ? overall : NaN;
      if (imagesTotal + videosTotal > 0 && (remImg + remVid) > 0 && (usable(expImg) || usable(expVid))) {
        const imgActive = remImg > 0;
        if (usable(expImg) && remImg >= 0) {
          imagesEtaMs = Math.max(0, Math.round(remImg * (expImg as number) - (imgActive ? sinceLast : 0)));
        }
        if (usable(expVid) && remVid >= 0) {
          videosEtaMs = Math.max(0, Math.round(remVid * (expVid as number) - (imgActive ? 0 : sinceLast)));
        }
        if (imagesEtaMs != null || videosEtaMs != null) {
          etaMs = (imagesEtaMs ?? 0) + (videosEtaMs ?? 0);
        }
      } else if (completed > 0) {
        const avgAll = elapsedMs / completed;
        etaMs = Math.max(0, Math.round(avgAll * total - elapsedMs));
      }
      // In-flight % estimate: elapsed vs the active category's expected
      // duration (with the same fallback chain). Capped at 99 — 100 is
      // reserved for "landed". Without any pace the tile still gets the
      // live elapsed time (activeElapsedMs) so it can tick seconds.
      if (activeKind) {
        const expected = activeKind === "image" ? expImg : expVid;
        activeElapsedMs = sinceLast;
        if (usablePos(expected as number)) {
          activeExpectedMs = Math.round(expected as number);
          activePct = Math.min(99, Math.max(sinceLast > 1500 ? 1 : 0,
            Math.floor((sinceLast / (expected as number)) * 100)));
        } else {
          activeExpectedMs = null;
          activePct = null;
        }
      }
    }

    return {
      status: status === "idle" ? "idle" : status === "running" ? "running" : status === "done" ? "done" : "error",
      cancelled: status === "error" && cancelled,
      pct,
      completed,
      total,
      scene,
      totalScenes: N,
      imagesDone,
      imagesTotal,
      videosDone,
      videosTotal,
      etaMs,
      imagesEtaMs,
      videosEtaMs,
      elapsedMs,
      startedAt,
      scenario: runScenario ?? scenario,
      activeKind,
      activeScene,
      activePct,
      activeElapsedMs,
      activeExpectedMs,
    };
  }, [assets, assetTimes, totalBeats, dlgBeats, runMeta, status, startedAt, timeAnchor, endedAt, now, cancelled, runScenario, scenario]);

  useEffect(() => { onProgress?.(progress); }, [progress, onProgress]);

  const statusPill = {
    idle: <span className="pill">idle</span>,
    running: (
      <span className="pill running">
        <Spinner size={11} />
        running{runFormat === "vertical" ? " · 9:16 reel" : ""}{runScenario && runScenario !== scenario ? ` · ${runScenario}` : ""}
      </span>
    ),
    done: <span className="pill done">done</span>,
    error: <span className="pill error">error</span>,
  }[status];

  return (
    <section className={`card${collapsed ? " collapsed" : ""}`} aria-label="Rendered Clip">
      <div className="card-head run-head">
        <div className="run-head-top">
          <h2>
            <span className="head-icon hi-output"><IconClapper size={15} /></span>
            Rendered Clip
          </h2>
          {statusPill}
          <span className="spacer" />
          <button
            className="icon-btn"
            onClick={toggleCollapsed}
            title={collapsed ? "Show rendered clip" : "Hide rendered clip"}
            aria-label={collapsed ? "Show rendered clip" : "Hide rendered clip"}
            aria-expanded={!collapsed}
          >
            <IconPanel size={15} />
          </button>
        </div>
        <div className="run-head-controls">
        <div className="run-head-actions" role="group" aria-label="Run controls">
          <button className="primary run-head-btn" onClick={() => begin(false, null, 1, "run", engine, idleFormat)} disabled={status === "running" || starting !== null || !scenario} title={!scenario ? "Select or save a scenario first" : videoType === "INSTAGRAM" ? "Start a full vertical (9:16 Reel) generation" : "Start a full generation"}>
            {starting === "run" ? <Spinner size={12} /> : <IconPlay size={12} />}
            {starting === "run" ? "Starting…" : "Generate"}
          </button>
          <button className="run-head-btn" onClick={() => begin(true, null, 1, "stitch", engine, idleFormat)} disabled={status === "running" || starting !== null || !scenario} title={!scenario ? "Select or save a scenario first" : videoType === "INSTAGRAM" ? "Re-stitch the Reel final from selected mains only" : "Re-stitch final from selected mains only"}>
            {starting === "stitch" ? <Spinner size={12} /> : <IconScissors size={12} />}
            {starting === "stitch" ? "Starting…" : "Stitch only"}
          </button>
          <button className="run-head-btn" onClick={() => begin(false, null, 1, "dialogue", engine, idleFormat, "dialogue")} disabled={status === "running" || starting !== null || !scenario || !dlgBeats} title={!scenario ? "Select or save a scenario first" : !dlgBeats ? "No dialogue lines in this project — add speaker: line dialogue in the Director or editor first" : `Voice ${dlgBeats} dialogue beat${dlgBeats === 1 ? "" : "s"} (per-character Hindi TTS) + lip-sync each clip with Easy-Wav2Lip, then re-stitch`}>
            {starting === "dialogue" ? <Spinner size={12} /> : <span aria-hidden="true">🎙</span>}
            {starting === "dialogue" ? "Starting…" : `Dialogue${dlgBeats ? ` (${dlgBeats})` : ""}`}
          </button>
          <button
            className="danger run-head-btn"
            disabled={status !== "running" || !runId || stopping}
            title="Stop the active run"
            onClick={async () => {
              if (!runId || stopping) return;
              setStopping(true);
              setCancelled(true);
              try {
                await killRun(runId);
              } catch {
                setStopping(false);
              }
            }}
          >
            {stopping ? <Spinner size={12} /> : <IconStop size={12} />}
            {stopping ? "Stopping…" : "Stop"}
          </button>
        </div>
        <span className="ctl-group" title="i2v engine — which video model renders clips">
          <span className="vt-label">Model</span>
          <span className="seg" title="i2v engine">
            <button className={engine === "ltx" ? "on" : ""} onClick={() => onEngine("ltx")}>
              LTX 2.5
            </button>
            <button className={engine === "wan" ? "on" : ""} onClick={() => onEngine("wan")}>
              Wan 2.1
            </button>
          </span>
        </span>
        <label className="vt-select" title="Switch the video for this project — YouTube (landscape main cut) or Instagram (9:16 Reel cut). Applies to the idle view below and the next Generate/Stitch; a live run always shows itself.">
          <span className="vt-label">Video</span>
          <select
            value={videoType}
            onChange={(e) => onVideoType?.(e.target.value as VideoType)}
            aria-label="Switch video: YouTube or Instagram"
          >
            <option value="YOUTUBE">YouTube</option>
            <option value="INSTAGRAM">Instagram</option>
          </select>
        </label>
        </div>
      </div>

      <Collapse open={!collapsed}>
      {/* Another run owns the (serial) backend — name the blocker and offer
          to stop it. Hidden while this panel's own run is active (its Stop
          button covers that case). */}
      {status !== "running" && serverRun && (
        <div className="server-busy" role="status">
          <span className="pill warn">
            <span className="dot pulse" />
            server busy
          </span>
          <span className="server-busy-text">
            <b>{serverRun.scenario}</b> generating since {formatStarted(serverRun.startedAt)} ({formatElapsed(now - serverRun.startedAt)}).
            New runs are rejected until it finishes.
          </span>
          <button
            className="danger"
            disabled={stoppingServer}
            title={`Stop the active ${serverRun.scenario} run on the server`}
            onClick={async () => {
              if (!serverRun || stoppingServer) return;
              setStoppingServer(true);
              try {
                await killRun(serverRun.id);
              } catch (e) {
                setStoppingServer(false);
                await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Stop failed", tone: "error" });
              }
            }}
          >
            {stoppingServer ? <Spinner size={12} /> : <IconStop size={12} />}
            {stoppingServer ? "Stopping…" : "Stop server run"}
          </button>
        </div>
      )}
      {/* Rendered Clip body, split in three collapsible parts — Program
          (viewport + stats), Render (frame grids + generated media) and
          Terminal (run log). Reference lives in Generate Reference. */}
      {(scenario || runScenario) ? (
        <>
          <RunPart storageKey="ss-sec-run-program" title="Program" label="Program monitor">
            <RenderMonitor
              scenario={displayScenario}
              outDir={displayOutDir}
              engine={displayEngine}
              status={status}
              progress={progress}
              assets={assets}
              log={log}
              totalBeats={totalBeats}
              runMeta={runMeta}
              startedAt={startedAt}
              now={now}
              comfyQueue={comfyQueue}
              showFrames={false}
              pin={pin}
              onPin={setPin}
            />
          </RunPart>
          <RunPart storageKey="ss-sec-run-render" title="Render" label="Render status and outputs">
            <RenderMonitor
              scenario={displayScenario}
              outDir={displayOutDir}
              engine={displayEngine}
              status={status}
              progress={progress}
              assets={assets}
              log={log}
              totalBeats={totalBeats}
              runMeta={runMeta}
              startedAt={startedAt}
              now={now}
              comfyQueue={comfyQueue}
              showScreen={false}
              pin={pin}
              onPin={setPin}
            />
            {/* Run history belongs to the cut that produced it: while running
                the panel follows the run, but an idle panel on the other cut
                hides it (the monitors above already show that cut from disk). */}
            {assets.length > 0 && (status === "running" || runFormat === idleFormat) && (
              <OutputGallery scenario={outScenario(runFolder ?? folder ?? runScenario ?? scenario, runEngine ?? engine, runFormat)} refreshKey={0} assets={assets} bare totalScenes={totalBeats} progress={progress} />
            )}
          </RunPart>
        </>
      ) : (
        <p className="hint">Select or save a scenario first, then start a run.</p>
      )}

      <RunPart storageKey="ss-sec-run-terminal" title="Terminal" label="Run log terminal">
        <pre ref={boxRef} className="log">
          {log || <span className="log-empty">— log will stream here once a run starts —</span>}
        </pre>
      </RunPart>

      </Collapse>
    </section>
  );
}
