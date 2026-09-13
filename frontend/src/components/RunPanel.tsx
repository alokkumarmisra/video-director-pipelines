import { useEffect, useMemo, useRef, useState } from "react";
import { startRun, killRun, tailRun, outScenario, getScenario, type AssetEvent, type Engine, type RegenSpec } from "../api";
import OutputGallery from "./OutputGallery";
import GenerationProgressBar, { MIN_TASK_MS, formatElapsed, formatStarted, loadPace, recordPaceDuration, type GenerationProgress } from "./GenerationProgressBar";
import RenderMonitor from "./RenderMonitor";
import { IconPanel, IconPlay, IconScissors, IconStop, IconClapper, Spinner } from "./Icons";

export type RunStatus = "idle" | "running" | "done" | "error";

interface Props {
  scenario: string;
  engine: Engine;
  onEngine: (e: Engine) => void;
  onDone: () => void;
  // Status reports the regen spec of the run that is actually active
  // (null for full runs) — so the gallery/editor can spin exactly the
  // button that triggered it instead of every busy-looking button.
  onStatus?: (s: RunStatus, scenario: string, regen: RegenSpec | null) => void;
  // External run trigger (Stitch final / Regenerate from the output gallery /
  // Generate Reference from the scenario editor; count batches ref regens).
  // Queued requests carry the engine they were asked for (it may have been
  // switched since they were queued).
  pendingRun: { nonce: number; stitch?: boolean; regen?: RegenSpec | null; count?: number; engine?: Engine } | null;
  // Reattach target: a run that was already active on the server when this
  // page loaded (e.g. after a refresh). RunPanel reopens its SSE tail — the
  // server replays the full log + asset events — so progress, the header bar
  // and every generating button pick up the live run instead of idling.
  attachRun?: { id: string; scenario: string; stitch?: boolean; regen?: RegenSpec | null; count?: number; startedAt?: number } | null;
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
export default function RunPanel({ scenario, engine, onEngine, onDone, onStatus, pendingRun, attachRun, serverRun, onProgress, comfyQueue = 0 }: Props) {
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  // Scenario this panel's run is generating (captured at start, so it stays
  // correct even if the user switches scenarios mid-run). runRegen is the
  // trigger of the active run (null = full run) — reported via onStatus so
  // App never has to guess from a stale pendingRun.
  const [runScenario, setRunScenario] = useState<string | null>(null);
  const [runRegen, setRunRegen] = useState<RegenSpec | null>(null);
  // Engine the active run was started with (captured at start — the header
  // engine switch must not rewrite the monitor's badge/URLs mid-run).
  const [runEngine, setRunEngine] = useState<Engine | null>(null);
  // Which local button started the POST (null = triggered externally via
  // pendingRun, or idle). Shows the spinner on the clicked button during
  // the startRun round-trip, before status flips to "running".
  const [starting, setStarting] = useState<"run" | "stitch" | null>(null);
  const [stopping, setStopping] = useState(false);
  // Stopping a FOREIGN server run (the banner below) — separate from stopping
  // this panel's own run. Resets once the server stops reporting it.
  const [stoppingServer, setStoppingServer] = useState(false);
  useEffect(() => { if (!serverRun) setStoppingServer(false); }, [serverRun]);

  useEffect(() => { onStatus?.(status, runScenario ?? scenario, status === "running" ? runRegen : null); }, [status, onStatus, runScenario, runRegen, scenario]);
  useEffect(() => { if (status !== "running") setStopping(false); }, [status]);
  const [log, setLog] = useState("");
  const [assets, setAssets] = useState<AssetEvent[]>([]);
  const closeTail = useRef<() => void>(() => {});
  const boxRef = useRef<HTMLPreElement>(null);
  // Real progress inputs: total beats from the scenario config, run shape,
  // start/end timestamps, and per-asset completion times for the ETA.
  const [totalBeats, setTotalBeats] = useState<number | null>(null);
  const [runMeta, setRunMeta] = useState<{ stitch: boolean; regen: RegenSpec | null; count: number }>({ stitch: false, regen: null, count: 1 });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [assetTimes, setAssetTimes] = useState<{ time: number; stage: AssetEvent["stage"] }[]>([]);
  const [cancelled, setCancelled] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Hide/show toggle (same as the Projects panel — persisted). Collapsing
  // only hides the body JSX; the component stays mounted so a running
  // generation keeps its live log, progress and SSE tail.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-run") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-run", c ? "open" : "closed");
      return !c;
    });
  // Pace bookkeeping (refs, not state — written from the SSE callback):
  // last completion time + already-seen files, so each landed asset records
  // exactly one duration sample even if the server re-emits an event.
  const lastAssetAt = useRef<number>(0);
  const seenFiles = useRef<Set<string>>(new Set());

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

  const begin = async (stitch: boolean, regen: RegenSpec | null = null, count = 1, which: "run" | "stitch" | "external" = "external", runEngine: Engine = engine) => {
    if (!scenario) return;
    if (which !== "external") setStarting(which);
    try {
      const res = await startRun(scenario, { stitch, regen, engine: runEngine, count });
      if (!res.id) throw new Error(res.error || "run rejected by server");
      const { id } = res;
      setRunId(id);
      setRunScenario(scenario);
      setRunRegen(regen);
      setRunEngine(runEngine);
      setRunMeta({ stitch, regen, count: regen?.kind === "ref" ? Math.min(8, Math.max(1, Number(count) || 1)) : 1 });
      // Keep the previous total until the fresh config lands — clearing it
      // here is what briefly hid every thumbnail slot right after Generate.
      setStartedAt(Date.now());
      lastAssetAt.current = Date.now();
      seenFiles.current = new Set();
      setEndedAt(null);
      setAssetTimes([]);
      setCancelled(false);
      setNow(Date.now());
      // Real total comes from the saved scenario config (sequence length).
      getScenario(scenario)
        .then((r) => setTotalBeats(Array.isArray(r.config.sequence) ? r.config.sequence.length : null))
        .catch(() => setTotalBeats(null));
      setStatus("running");
      setLog("");
      setAssets([]);
      closeTail.current();
      closeTail.current = tailRun(
        id,
        (line) => setLog((l) => l + line),
        (s) => { setEndedAt(Date.now()); setNow(Date.now()); setStatus(s === "done" ? "done" : "error"); onDone(); },
        (a) => {
          const t = Date.now();
          // First sighting only: record one pace sample (completion interval
          // attributed to the asset that just finished) and keep assetTimes
          // duplicate-free so ETA averages never double-count.
          if (!seenFiles.current.has(a.file)) {
            seenFiles.current.add(a.file);
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
          setNow(t);
          setAssets((prev) => prev.some((x) => x.file === a.file) ? prev : [...prev, a]);
        }
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
    if (pendingRun) begin(!!pendingRun.stitch, pendingRun.regen || null, pendingRun.count ?? 1, "external", pendingRun.engine ?? engine);
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
    setRunRegen(regen);
    setRunEngine(engine);
    setRunMeta({ stitch: !!meta.stitch, regen, count: regen?.kind === "ref" ? Math.min(8, Math.max(1, Number(meta.count) || 1)) : 1 });
    // Same as begin(): keep the previous total so thumbnail slots stay
    // mounted while the reattached run's config loads.
    setStartedAt(meta.startedAt ?? Date.now());
    lastAssetAt.current = meta.startedAt ?? Date.now();
    seenFiles.current = new Set();
    setEndedAt(null);
    setAssetTimes([]);
    setCancelled(false);
    setNow(Date.now());
    getScenario(meta.scenario)
      .then((r) => setTotalBeats(Array.isArray(r.config.sequence) ? r.config.sequence.length : null))
      .catch(() => setTotalBeats(null));
    setStatus("running");
    setLog("");
    setAssets([]);
    closeTail.current();
    closeTail.current = tailRun(
      meta.id,
      (line) => setLog((l) => l + line),
      (s) => { setEndedAt(Date.now()); setNow(Date.now()); setStatus(s === "done" ? "done" : "error"); onDone(); },
      (a) => {
        const t = Date.now();
        if (!seenFiles.current.has(a.file)) {
          seenFiles.current.add(a.file);
          const image = a.stage === "reference" || a.stage === "keyframe";
          if (image || a.stage === "clip") {
            recordPaceDuration(image, t - lastAssetAt.current);
          }
          lastAssetAt.current = t;
          setAssetTimes((prev) => [...prev, { time: t, stage: a.stage }]);
        }
        setNow(t);
        setAssets((prev) => prev.some((x) => x.file === a.file) ? prev : [...prev, a]);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachRun?.id]);

  // Real progress from the live asset stream + scenario totals.
  // Pipeline order is sequential: reference → N keyframes → N clips → stitch.
  // Full run total = 1 + 2N tasks; regen/stitch runs total = their own task(s).
  const progress: GenerationProgress = useMemo(() => {
    const N = totalBeats;
    const { stitch, regen, count } = runMeta;
    const refDone = assets.some((a) => a.stage === "reference") ? 1 : 0;
    const kfIdx = new Set(assets.filter((a) => a.stage === "keyframe").map((a) => a.index ?? -1));
    const clipIdx = new Set(assets.filter((a) => a.stage === "clip").map((a) => a.index ?? -1));
    kfIdx.delete(-1);
    clipIdx.delete(-1);
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
      let prev = startedAt;
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
      const remImg = Math.max(0, imagesTotal - imagesDone);
      const remVid = Math.max(0, videosTotal - videosDone);
      // Pipeline is sequential with at most one asset in flight; images
      // render before clips, so in-flight time belongs to images while any
      // image is still pending, otherwise to videos.
      const sinceLast = Math.max(0, now - prev);
      if (imagesTotal + videosTotal > 0 && (remImg + remVid) > 0 && usable(avgImg) && usable(avgVid)) {
        const imgActive = remImg > 0;
        imagesEtaMs = Math.max(0, Math.round(remImg * avgImg - (imgActive ? sinceLast : 0)));
        videosEtaMs = Math.max(0, Math.round(remVid * avgVid - (imgActive ? 0 : sinceLast)));
        etaMs = imagesEtaMs + videosEtaMs;
      } else if (completed > 0) {
        const avgAll = elapsedMs / completed;
        etaMs = Math.max(0, Math.round(avgAll * total - elapsedMs));
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
    };
  }, [assets, assetTimes, totalBeats, runMeta, status, startedAt, endedAt, now, cancelled, runScenario, scenario]);

  useEffect(() => { onProgress?.(progress); }, [progress, onProgress]);

  const statusPill = {
    idle: <span className="pill">idle</span>,
    running: (
      <span className="pill running">
        <Spinner size={11} />
        running{runScenario && runScenario !== scenario ? ` · ${runScenario}` : ""}
      </span>
    ),
    done: <span className="pill done">done</span>,
    error: <span className="pill error">error</span>,
  }[status];

  return (
    <section className={`card${collapsed ? " collapsed" : ""}`} aria-label="Rendered Clip">
      <div className="card-head">
        <h2>
          <span className="head-icon hi-output"><IconClapper size={15} /></span>
          Rendered Clip
        </h2>
        <div className="run-head-actions" role="group" aria-label="Run controls">
          <button className="primary run-head-btn" onClick={() => begin(false, null, 1, "run")} disabled={status === "running" || starting !== null || !scenario} title={!scenario ? "Select or save a scenario first" : "Start a full generation"}>
            {starting === "run" ? <Spinner size={12} /> : <IconPlay size={12} />}
            {starting === "run" ? "Starting…" : "Generate"}
          </button>
          <button className="run-head-btn" onClick={() => begin(true, null, 1, "stitch")} disabled={status === "running" || starting !== null || !scenario} title={!scenario ? "Select or save a scenario first" : "Re-stitch final from selected mains only"}>
            {starting === "stitch" ? <Spinner size={12} /> : <IconScissors size={12} />}
            {starting === "stitch" ? "Starting…" : "Stitch only"}
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
        <span className="seg" title="i2v engine">
          <button className={engine === "ltx" ? "on" : ""} onClick={() => onEngine("ltx")}>
            LTX 2.5
          </button>
          <button className={engine === "wan" ? "on" : ""} onClick={() => onEngine("wan")}>
            Wan 2.1
          </button>
        </span>
        {statusPill}
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

      {!collapsed && (
      <>
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
                window.alert(`Stop failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}
          >
            {stoppingServer ? <Spinner size={12} /> : <IconStop size={12} />}
            {stoppingServer ? "Stopping…" : "Stop server run"}
          </button>
        </div>
      )}
      {(status === "running" || status === "done" || status === "error") && (progress.total > 0 || status !== "running") && (
        <GenerationProgressBar progress={progress} />
      )}

      {/* Broadcast-style program monitor (viewport + stats + frame grids):
          same live progress/assets/log as above, new presentation only. */}
      {(scenario || runScenario) && (
        <RenderMonitor
          scenario={runScenario ?? scenario}
          outDir={outScenario(runScenario ?? scenario, runEngine ?? engine)}
          engine={runEngine ?? engine}
          status={status}
          progress={progress}
          assets={assets}
          log={log}
          totalBeats={totalBeats}
          runMeta={runMeta}
          startedAt={startedAt}
          now={now}
          comfyQueue={comfyQueue}
        />
      )}

      {!scenario && (
        <p className="hint">Select or save a scenario first, then start a run.</p>
      )}

      <pre ref={boxRef} className="log">
        {log || <span className="log-empty">— log will stream here once a run starts —</span>}
      </pre>

      {assets.length > 0 && (
        <OutputGallery scenario={outScenario(scenario, engine)} refreshKey={0} assets={assets} bare totalScenes={totalBeats} />
      )}
      </>
      )}
    </section>
  );
}
