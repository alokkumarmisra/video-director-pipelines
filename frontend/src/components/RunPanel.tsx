import { useEffect, useMemo, useRef, useState } from "react";
import { startRun, killRun, tailRun, outScenario, getScenario, type AssetEvent, type Engine, type RegenSpec } from "../api";
import OutputGallery from "./OutputGallery";
import GenerationProgressBar, { type GenerationProgress } from "./GenerationProgressBar";
import { IconPlay, IconScissors, IconStop, IconTerminal, Spinner } from "./Icons";

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
  pendingRun: { nonce: number; stitch?: boolean; regen?: RegenSpec | null; count?: number } | null;
  // Live progress reports (real assets/timing — App renders the sticky global bar).
  onProgress?: (p: GenerationProgress) => void;
}

// Start / stitch / stop a run + live log tail (SSE) + live asset gallery.
// Progress + ETA are derived from the real asset stream (see `progress`
// below) — never fake timers.
export default function RunPanel({ scenario, engine, onEngine, onDone, onStatus, pendingRun, onProgress }: Props) {
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  // Scenario this panel's run is generating (captured at start, so it stays
  // correct even if the user switches scenarios mid-run). runRegen is the
  // trigger of the active run (null = full run) — reported via onStatus so
  // App never has to guess from a stale pendingRun.
  const [runScenario, setRunScenario] = useState<string | null>(null);
  const [runRegen, setRunRegen] = useState<RegenSpec | null>(null);
  // Which local button started the POST (null = triggered externally via
  // pendingRun, or idle). Shows the spinner on the clicked button during
  // the startRun round-trip, before status flips to "running".
  const [starting, setStarting] = useState<"run" | "stitch" | null>(null);
  const [stopping, setStopping] = useState(false);

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

  useEffect(() => () => closeTail.current(), []);
  useEffect(() => {
    boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [log]);

  // Tick the clock while running so elapsed/ETA stay live between assets.
  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [status]);

  const begin = async (stitch: boolean, regen: RegenSpec | null = null, count = 1, which: "run" | "stitch" | "external" = "external") => {
    if (!scenario) return;
    if (which !== "external") setStarting(which);
    try {
      const res = await startRun(scenario, { stitch, regen, engine, count });
      if (!res.id) throw new Error(res.error || "run rejected by server");
      const { id } = res;
      setRunId(id);
      setRunScenario(scenario);
      setRunRegen(regen);
      setRunMeta({ stitch, regen, count: regen?.kind === "ref" ? Math.min(8, Math.max(1, Number(count) || 1)) : 1 });
      setTotalBeats(null);
      setStartedAt(Date.now());
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
          setAssetTimes((prev) => [...prev, { time: t, stage: a.stage }]);
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
    if (pendingRun) begin(!!pendingRun.stitch, pendingRun.regen || null, pendingRun.count ?? 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRun?.nonce]);

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
    if (status === "running" && startedAt != null && completed > 0 && total > completed) {
      const times = assetTimes;
      const durs: { d: number; image: boolean }[] = [];
      let prev = startedAt;
      for (const t of times) {
        durs.push({ d: Math.max(0, t.time - prev), image: t.stage !== "clip" && t.stage !== "final" });
        prev = t.time;
      }
      const img = durs.filter((x) => x.image).map((x) => x.d);
      const vid = durs.filter((x) => !x.image).map((x) => x.d);
      const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
      const overall = durs.length ? avg(durs.map((x) => x.d)) : elapsedMs / completed;
      const avgImg = img.length ? avg(img) : overall;
      const avgVid = vid.length ? avg(vid) : overall;
      const remImg = Math.max(0, imagesTotal - imagesDone);
      const remVid = Math.max(0, videosTotal - videosDone);
      if (imagesTotal + videosTotal > 0 && (remImg + remVid) > 0 && (img.length || vid.length)) {
        etaMs = Math.round(remImg * avgImg + remVid * avgVid);
      } else {
        const remaining = total - completed;
        etaMs = Math.round((elapsedMs / completed) * remaining);
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
    <section className="card">
      <div className="card-head">
        <h2>
          <span className="head-icon"><IconTerminal size={15} /></span>
          Run
        </h2>
        <span className="spacer" />
        <span className="seg" title="i2v engine">
          <button className={engine === "ltx" ? "on" : ""} onClick={() => onEngine("ltx")}>
            LTX 2.5
          </button>
          <button className={engine === "wan" ? "on" : ""} onClick={() => onEngine("wan")}>
            Wan 2.1
          </button>
        </span>
        {statusPill}
      </div>

      {(status === "running" || status === "done" || status === "error") && (progress.total > 0 || status !== "running") && (
        <GenerationProgressBar progress={progress} />
      )}

      <div className="row">
        <button className="primary" onClick={() => begin(false, null, 1, "run")} disabled={status === "running" || starting !== null || !scenario}>
          {starting === "run" ? <Spinner size={12} /> : <IconPlay size={12} />}
          {starting === "run" ? "Starting…" : "Generate"}
        </button>
        <button onClick={() => begin(true, null, 1, "stitch")} disabled={status === "running" || starting !== null || !scenario}>
          {starting === "stitch" ? <Spinner size={12} /> : <IconScissors size={12} />}
          {starting === "stitch" ? "Starting…" : "Stitch only"}
        </button>
        <button
          className="danger"
          disabled={status !== "running" || !runId || stopping}
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
      {!scenario && (
        <p className="hint">Select or save a scenario first, then start a run.</p>
      )}

      <pre ref={boxRef} className="log">
        {log || <span className="log-empty">— log will stream here once a run starts —</span>}
      </pre>

      {assets.length > 0 && (
        <OutputGallery scenario={outScenario(scenario, engine)} refreshKey={0} assets={assets} bare totalScenes={totalBeats} />
      )}
    </section>
  );
}
