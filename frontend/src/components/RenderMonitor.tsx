import { useEffect, useState } from "react";
import { listOutputs, outputUrl, type AssetEvent, type Engine, type RegenSpec } from "../api";
import type { GenerationProgress } from "./GenerationProgressBar";
import type { RunStatus } from "./RunPanel";
import SmoothImage from "./SmoothImage";
import { Spinner } from "./Icons";

interface Props {
  /** Base scenario name for labels (run's own scenario, not the viewed one). */
  scenario: string;
  /** Output dir for media URLs (engine-suffixed when Wan). */
  outDir: string;
  engine: Engine;
  status: RunStatus;
  progress: GenerationProgress;
  assets: AssetEvent[];
  log: string;
  totalBeats: number | null;
  runMeta: { stitch: boolean; regen: RegenSpec | null; count: number };
  startedAt: number | null;
  now: number;
  comfyQueue: number;
  /** Render the PROGRAM screen block (viewport + progress + stats). Default true. */
  showScreen?: boolean;
  /** Render the frame-status grids block. Default true. */
  showFrames?: boolean;
  /** Controlled pin (shared across split instances so chips drive the viewport). */
  pin?: RmPin | null;
  onPin?: (p: RmPin | null) => void;
}

/** Pinned preview slot: clicking a REF / keyframe / clip / CUT number loads
    that render into the PROGRAM viewport. */
export interface RmPin { kind: "ref" | "kf" | "clip" | "cut"; n: number | null }

// mm:ss short digital timer (00:09) — the monitor's compact counterpart to
// the full HHh:MMm:SSs durations used elsewhere.
function fmtShort(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "--:--";
  const total = Math.max(0, Math.round(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

type Stage = "image" | "video" | "cut";

// Broadcast-style program monitor (see reference screenshot): PROGRAM live
// viewport + pass/step/speed/ETA/total/queue stats + REF / keyframe / clip /
// CUT frame grids + console. Purely presentational — every number comes from
// the real run state (RunPanel progress + asset stream + log), never timers.
export default function RenderMonitor({
  scenario, outDir, engine, status, progress,
  assets, log, totalBeats, runMeta, startedAt, now, comfyQueue,
  showScreen, showFrames, pin, onPin,
}: Props) {
  const [consoleOpen, setConsoleOpen] = useState(false);
  const running = status === "running";

  // Pinned preview: clicking a REF / keyframe / clip / CUT number loads that
  // render into the PROGRAM viewport. Index-based, so a regen landing on the
  // pinned slot updates what's shown. Clicking the pinned chip again (or
  // switching projects) returns to the automatic latest-for-stage feed.
  // Controlled via pin/onPin when the monitor is split across parts (so the
  // Render chips still drive the Program viewport); internal otherwise.
  const [innerSel, setInnerSel] = useState<RmPin | null>(null);
  const sel = onPin ? (pin ?? null) : innerSel;
  const toggleSel = (kind: "ref" | "kf" | "clip" | "cut", n: number | null, file: string | null) => {
    if (!file) return;
    const next = sel && sel.kind === kind && sel.n === n ? null : { kind, n };
    if (onPin) onPin(next);
    else setInnerSel(next);
  };

  // On-disk fallback: the live `assets` stream only covers the current run,
  // so an idle panel (or a fresh page load) would show "No preview" even
  // when previous renders exist. Seed from the output dir listing — mains
  // preferred, latest version otherwise — and let live events overlay it.
  const [diskRef, setDiskRef] = useState<string | null>(null);
  const [diskKf, setDiskKf] = useState<Map<number, string>>(new Map());
  const [diskClip, setDiskClip] = useState<Map<number, string>>(new Map());
  const [diskFinal, setDiskFinal] = useState<string | null>(null);
  const [diskBeats, setDiskBeats] = useState<number[]>([]);
  const [loadedFor, setLoadedFor] = useState(outDir);
  useEffect(() => {
    if (!outDir) {
      setDiskRef(null);
      setDiskKf(new Map());
      setDiskClip(new Map());
      setDiskFinal(null);
      setDiskBeats([]);
      setLoadedFor("");
      return;
    }
    // Keep the previous dir's media on screen until the new listing lands.
    let cancelled = false;
    const target = outDir;
    listOutputs(target).then((r) => {
      if (cancelled) return;
      const v = r.versions;
      const m = r.mains;
      const ref = m.ref || v.ref[v.ref.length - 1]?.file || null;
      const kf = new Map<number, string>();
      const clip = new Map<number, string>();
      const beats = Object.keys(v.beats).map(Number).sort((a, b) => a - b);
      for (const n of beats) {
        const bv = v.beats[String(n)];
        const k = m.beats[String(n)]?.keyframe || bv.keyframe[bv.keyframe.length - 1]?.file || null;
        if (k) kf.set(n, k);
        const c = m.beats[String(n)]?.clip || bv.clip[bv.clip.length - 1]?.file || null;
        if (c) clip.set(n, c);
      }
      const finals: { file: string; v: number }[] =
        (v.final && v.final.length > 0)
          ? [...v.final].sort((a, b) => a.v - b.v)
          : (r.files || [])
              .filter((f) => /_final(_v\d+)?\.mp4$/.test(f))
              .map((f) => {
                const mm = f.match(/_final_v(\d+)\.mp4$/);
                return { file: f, v: mm ? Number(mm[1]) : 1 };
              })
              .sort((a, b) => a.v - b.v);
      const final = m.final || finals[finals.length - 1]?.file || null;
      setDiskRef(ref);
      setDiskKf(kf);
      setDiskClip(clip);
      setDiskFinal(final);
      setDiskBeats(beats);
      setLoadedFor(target);
    }).catch(() => { /* keep stale listing on transient failure */ });
    return () => { cancelled = true; };
  }, [outDir, status === "running" ? null : status]);
  // While the new dir loads, keep showing the previous dir's media.
  const steady = loadedFor === outDir;
  const viewDir = steady ? outDir : (loadedFor || outDir);
  // A pinned chip belongs to its own project — drop it on switch.
  useEffect(() => { if (onPin) onPin(null); else setInnerSel(null); }, [outDir, onPin]);

  const liveRef = assets.find((a) => a.stage === "reference")?.file ?? null;
  const refFile = liveRef ?? (steady ? diskRef : null);
  const kfByIndex = new Map<number, string>(steady ? diskKf : new Map());
  const clipByIndex = new Map<number, string>(steady ? diskClip : new Map());
  for (const a of assets) {
    if (a.stage === "keyframe" && a.index != null) kfByIndex.set(a.index, a.file);
    if (a.stage === "clip" && a.index != null) clipByIndex.set(a.index, a.file);
  }
  const liveFinal = assets.find((a) => a.stage === "final")?.file ?? null;
  const finalFile = liveFinal ?? (steady ? diskFinal : null);
  const hasFinal = !!finalFile;
  const seenMax = Math.max(0, ...[...kfByIndex.keys()], ...[...clipByIndex.keys()],
    ...(steady ? diskBeats : []));
  const N = totalBeats != null && totalBeats > 0 ? totalBeats : seenMax > 0 ? seenMax : 0;
  const nums: number[] = N > 0 ? Array.from({ length: N }, (_, i) => i + 1) : [];

  // Asset currently in flight (pipeline order), unless a regen/stitch run
  // targets one asset explicitly.
  const target: string | null = (() => {
    if (!running) return null;
    const r = runMeta.regen;
    if (r) {
      if (r.kind === "ref") return "ref";
      if (r.kind === "keyframe") return `kf:${r.index}`;
      if (r.kind === "clip") return `clip:${r.index}`;
      return null;
    }
    if (runMeta.stitch) return "cut";
    if (!refFile) return "ref";
    for (const n of nums) if (!kfByIndex.has(n)) return `kf:${n}`;
    for (const n of nums) if (!clipByIndex.has(n)) return `clip:${n}`;
    // Everything versioned exists — the tail of the run is the stitch.
    if (N > 0) return "cut";
    return null;
  })();

  const currentScene: number | null = (() => {
    const m = target?.match(/^(kf|clip):(\d+)$/);
    if (m) return Number(m[2]);
    if (progress.scene != null) return progress.scene;
    return null;
  })();

  // Pipeline stage for the PASS readout + viewport badge. Full runs are two
  // passes (1 = images: ref + keyframes, 2 = clips); regen/stitch runs are a
  // single pass of their own kind. Idle shows whatever the last render was
  // (video when clips exist, cut when only a final exists) so the badge
  // matches the fallback preview below.
  const stage: Stage = !running
    ? hasFinal && clipByIndex.size === 0 && kfByIndex.size === 0 ? "cut"
      : clipByIndex.size > 0 ? "video"
      : "image"
    : runMeta.stitch || target === "cut"
      ? "cut"
      : runMeta.regen?.kind === "clip" || (!runMeta.regen && target?.startsWith("clip:"))
        ? "video"
        : "image";
  // File behind the pinned chip (null when the slot has nothing rendered
  // yet — pinning is a no-op there, see toggleSel).
  const selFile: string | null =
    !sel ? null
    : sel.kind === "ref" ? refFile
    : sel.kind === "kf" && sel.n != null ? kfByIndex.get(sel.n) ?? null
    : sel.kind === "clip" && sel.n != null ? clipByIndex.get(sel.n) ?? null
    : sel.kind === "cut" ? finalFile
    : null;
  const selKind: "image" | "video" =
    sel?.kind === "clip" || sel?.kind === "cut" ? "video" : "image";
  // Viewport badge follows what's actually on screen (a pinned keyframe
  // shows IMAGE even mid video-pass); the stats rows below keep the real
  // run stage.
  const viewStage: Stage = selFile
    ? sel?.kind === "cut" ? "cut" : selKind === "video" ? "video" : "image"
    : stage;
  // Full-run pass derived from real image coverage (images render before clips).
  const fullPass: 1 | 2 = progress.imagesTotal > 0 && progress.imagesDone >= progress.imagesTotal ? 2 : 1;
  const passLabel = runMeta.stitch ? "1/1" : runMeta.regen ? "1/1" : `${fullPass}/2`;
  const stepLabel = runMeta.stitch
    ? `${hasFinal ? 1 : 0}/1`
    : runMeta.regen?.kind === "ref"
      ? `${progress.imagesDone}/${Math.max(1, progress.imagesTotal)}`
      : runMeta.regen?.kind === "keyframe"
        ? `${progress.imagesDone}/1`
        : runMeta.regen?.kind === "clip"
          ? `${progress.videosDone}/1`
          : fullPass === 1
            ? `${progress.imagesDone}/${progress.imagesTotal}`
            : `${progress.videosDone}/${progress.videosTotal}`;
  const passEtaMs = runMeta.stitch
    ? progress.etaMs
    : stage === "image" ? progress.imagesEtaMs : progress.videosEtaMs;
  // Seconds per iteration from real elapsed/completed (screenshot's "s/it").
  const speedLabel = progress.elapsedMs > 0 && progress.completed > 0
    ? `${(progress.elapsedMs / progress.completed / 1000).toFixed(1)} s/it`
    : "—";

  const stageBadge = runMeta.stitch || viewStage === "cut"
    ? "CUT · FFMPEG"
    : viewStage === "image"
      ? "IMAGE · FLUX 2 KLEIN"
      : engine === "wan" ? "VIDEO · WAN 2.1" : "VIDEO · LTX 2.5";
  // Truthful workflow/node label for the overlay's second line (the node map
  // lives in AGENTS.md — no sampler telemetry exists remotely).
  const workflowLabel = runMeta.stitch || viewStage === "cut"
    ? "ffmpeg-concat"
    : viewStage === "image"
      ? "flux-t2i · SamplerCustomAdvanced"
      : engine === "wan" ? "image_to_video_wan · KSampler" : "ltx2_5_i2v · SamplerCustomAdvanced";

  // PROGRAM feed: the richest finished file for the current stage. While a
  // run is active the in-flight frame has no file yet, so the previous
  // finished file for that stage stays on screen (image stage → last
  // keyframe, video/cut stage → last clip) with the Rendering overlay naming
  // the frame in flight. Idle shows the last render overall (final cut
  // first, then latest clip, keyframe, reference).
  const latestKf = (() => {
    let best: { n: number; file: string } | null = null;
    for (const [n, file] of kfByIndex) if (!best || n > best.n) best = { n, file };
    return best;
  })();
  const latestClip = (() => {
    let best: { n: number; file: string } | null = null;
    for (const [n, file] of clipByIndex) if (!best || n > best.n) best = { n, file };
    return best;
  })();
  const autoPreview: { kind: "image" | "video"; file: string; n: number | null } | null =
    !running
      ? finalFile ? { kind: "video", file: finalFile, n: null }
        : latestClip ? { kind: "video", file: latestClip.file, n: latestClip.n }
        : latestKf ? { kind: "image", file: latestKf.file, n: latestKf.n }
        : refFile ? { kind: "image", file: refFile, n: null }
        : null
      : stage === "video" || stage === "cut"
        ? latestClip ? { kind: "video", file: latestClip.file, n: latestClip.n }
          : latestKf ? { kind: "image", file: latestKf.file, n: latestKf.n }
          : refFile ? { kind: "image", file: refFile, n: null }
          : null
        : latestKf ? { kind: "image", file: latestKf.file, n: latestKf.n }
          : refFile ? { kind: "image", file: refFile, n: null }
          : null;
  const preview: { kind: "image" | "video"; file: string; n: number | null } | null =
    selFile
      ? { kind: selKind, file: selFile, n: sel?.n ?? null }
      : autoPreview;

  const targetLabel = target === "ref"
    ? "Reference"
    : target === "cut"
      ? "Final cut"
      : currentScene != null
        ? `${stage === "video" ? "Clip" : "Keyframe"} ${currentScene}/${N || "–"}`
        : null;
  const targetFile = target === "ref"
    ? refFile
    : target === "cut"
      ? finalFile
      : currentScene != null
        ? (stage === "video" ? clipByIndex.get(currentScene) : kfByIndex.get(currentScene)) ?? null
        : null;

  const elapsedMs = startedAt != null ? Math.max(0, (running ? now : progress.elapsedMs > 0 ? startedAt + progress.elapsedMs : now) - startedAt) : progress.elapsedMs;
  const logLines = log ? log.split("\n").length : 0;

  // A scene's keyframe number stays highlighted while its clip renders too
  // (same frame, video phase) — not just during the image phase.
  const kfActive = (n: number) =>
    target === `kf:${n}` || (running && currentScene === n && target === `clip:${n}`);
  // Idle counts come from disk (the run stream is empty then); live counts win.
  const idleImages = (refFile ? 1 : 0) + kfByIndex.size;
  const idleVideos = clipByIndex.size;

  const chipClass = (done: boolean, active: boolean, extra = "") =>
    `rm-chip${done ? " is-done" : ""}${active ? " is-active" : ""}${extra ? ` ${extra}` : ""}`;

  return (
    <div className="rm" aria-label="Render monitor">
      {/* PROGRAM viewport */}
      {showScreen !== false && (
      <div className="rm-screen">
        <div className="rm-topbar">
          <span className="rm-program">
            <span className="rm-monitor-icon" aria-hidden="true">▣</span>
            PROGRAM
          </span>
          <span className={`rm-live${running ? " on" : ""}`} title={running ? "Generating — live" : "Idle"}>
            <span className={`dot${running ? " pulse" : ""}`} aria-hidden="true" />
            {running ? "LIVE" : "IDLE"}
          </span>
          <span className={`rm-stage rm-stage-${viewStage}${engine === "wan" && viewStage === "video" ? " is-wan" : ""}`} title={workflowLabel}>
            {stageBadge}
          </span>
          <span className="spacer" />
          <span className="rm-timer" title={startedAt != null ? `Started ${new Date(startedAt).toLocaleString()}` : "Not started"}>
            {fmtShort(running || startedAt != null ? elapsedMs : null)}
          </span>
        </div>

        <div className="rm-viewport">
          {preview ? (
            preview.kind === "video" ? (
              <video key={`${viewDir}/${preview.file}`} className="rm-media" controls preload="metadata" muted playsInline src={outputUrl(viewDir, preview.file)} />
            ) : (
              <SmoothImage frameClassName="rm-media-img" src={outputUrl(viewDir, preview.file)} alt={preview.file} />
            )
          ) : (
            <div className="rm-rendering">
              <div className="rm-rendering-title">{running ? "Rendering…" : "No renders yet"}</div>
              <div className="rm-rendering-sub">
                {running
                  ? "Waiting for the first preview frame"
                  : "No previous image or video found — start a run to generate the reference, keyframes, and clips."}
              </div>
            </div>
          )}
          {running && preview && (
            <div className="rm-rendering-pill" role="status">
              <Spinner size={11} /> Rendering{targetLabel ? ` · ${targetLabel}` : ""}…
            </div>
          )}
        </div>

        <div className="rm-progress" aria-hidden="true">
          <div className="rm-progress-track">
            <div
              className={`rm-progress-fill${running ? " sweep" : ""}`}
              style={{ width: `${Math.min(100, Math.max(0, progress.pct))}%` }}
            />
          </div>
        </div>
        <div className="rm-stats" role="status" aria-label={`Render stats: pass ${passLabel}, step ${stepLabel}, total ${Math.round(progress.pct)} percent`}>
          <span className="rm-stat"><span className="rm-stat-label">PASS</span><span className="rm-stat-value">{passLabel}</span></span>
          <span className="rm-stat"><span className="rm-stat-label">STEP</span><span className="rm-stat-value">{stepLabel}</span></span>
          <span className="rm-stat"><span className="rm-stat-label">SPEED</span><span className="rm-stat-value">{speedLabel}</span></span>
          <span className="rm-stat"><span className="rm-stat-label">PASS ETA</span><span className="rm-stat-value">{fmtShort(passEtaMs)}</span></span>
          <span className="rm-stat"><span className="rm-stat-label">TOTAL</span><span className="rm-stat-value is-total">{Math.round(progress.pct)}%</span></span>
          <span className="spacer" />
          <span className="rm-stat"><span className="rm-stat-label">QUEUE</span><span className="rm-stat-value">{comfyQueue}</span></span>
        </div>
      </div>
      )}

      {/* Frame grids */}
      {showFrames !== false && (
      <div className="rm-frames">
        <div className="rm-frames-head">
          <span className="rm-frames-title"><span aria-hidden="true">⟩_</span> Render</span>
          <span className="spacer" />
          <span className="seg rm-engine" title="i2v engine for this run" aria-label="Engine">
            <button type="button" className={engine === "ltx" ? "on" : ""} disabled title="LTX 2.5 engine">LTX 2.5</button>
            <button type="button" className={engine === "wan" ? "on" : ""} disabled title="Wan 2.1 engine">Wan 2.1</button>
          </span>
          {running && (
            <span className="rm-rendering-badge" title={`Generating since ${startedAt != null ? new Date(startedAt).toLocaleTimeString() : "—"}`}>
              <span className="dot pulse" aria-hidden="true" /> rendering · {fmtShort(elapsedMs)}
            </span>
          )}
        </div>

        {running && targetLabel && (
          <div className="rm-current" role="status">
            <span aria-hidden="true">▸</span> {targetLabel}
            {targetFile ? ` · ${targetFile.replace(/\.(png|mp4)$/, "")}` : " · generating…"}
          </div>
        )}

        <div className="rm-grid rm-grid-split" aria-label="Frame status">
          <div className="rm-col rm-col-wide">
            <div className="rm-above" aria-label="Reference">
              <span className="rm-col-label">REF</span>
              <span className="rm-chips">
                <button
                  type="button"
                  className={`${chipClass(!!refFile, target === "ref")}${sel?.kind === "ref" && selFile ? " is-selected" : ""}`}
                  title={refFile ? `${refFile} — click to show in PROGRAM` : (target === "ref" ? "Reference generating…" : "Reference pending")}
                  disabled={!refFile}
                  onClick={() => toggleSel("ref", null, refFile)}
                >
                  {target === "ref" && !refFile ? <Spinner size={10} /> : null}REF
                </button>
              </span>
            </div>
            <div className="rm-col-label">KEYFRAMES · IMAGE</div>
            <div className="rm-chips rm-chips-tabular">
              {nums.length === 0 && <span className="rm-empty-note">—</span>}
              {nums.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`${chipClass(kfByIndex.has(n), kfActive(n))}${sel?.kind === "kf" && sel.n === n && selFile ? " is-selected" : ""}`}
                  title={kfByIndex.get(n) ? `${kfByIndex.get(n)} — click to show in PROGRAM` : (kfActive(n) ? `Keyframe ${n} generating…` : `Keyframe ${n} pending`)}
                  aria-current={kfActive(n) ? "true" : undefined}
                  disabled={!kfByIndex.has(n)}
                  onClick={() => toggleSel("kf", n, kfByIndex.get(n) ?? null)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="rm-col rm-col-wide">
            <div className="rm-above rm-above-right" aria-label="Final">
              <span className="rm-col-label">FINAL</span>
              <span className="rm-chips">
                <button
                  type="button"
                  className={`${chipClass(hasFinal, target === "cut")}${sel?.kind === "cut" && selFile ? " is-selected" : ""}`}
                  title={finalFile ? `${finalFile} — click to show in PROGRAM` : target === "cut" ? "Stitching…" : "Final cut pending"}
                  disabled={!finalFile}
                  onClick={() => toggleSel("cut", null, finalFile)}
                >
                  CUT
                </button>
              </span>
            </div>
            <div className="rm-col-label">CLIPS · VIDEO</div>
            <div className="rm-chips rm-chips-tabular">
              {nums.length === 0 && <span className="rm-empty-note">—</span>}
              {nums.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`${chipClass(clipByIndex.has(n), target === `clip:${n}`)}${sel?.kind === "clip" && sel.n === n && selFile ? " is-selected" : ""}`}
                  title={clipByIndex.get(n) ? `${clipByIndex.get(n)} — click to show in PROGRAM` : (target === `clip:${n}` ? `Clip ${n} generating…` : `Clip ${n} pending`)}
                  disabled={!clipByIndex.has(n)}
                  onClick={() => toggleSel("clip", n, clipByIndex.get(n) ?? null)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="rm-counts muted" title={running ? "Real asset counts from this run's stream" : "On-disk renders for this project"}>
          {running
            ? <>{progress.imagesDone}/{Math.max(progress.imagesTotal, N > 0 ? 1 + N : 0)} images · {progress.videosDone}/{Math.max(progress.videosTotal, N)} videos{N > 0 ? ` · ${nums.length} frames` : ""}</>
            : <>{idleImages}/{Math.max(N > 0 ? 1 + N : 0, idleImages)} images · {idleVideos}/{Math.max(N, idleVideos)} videos{N > 0 ? ` · ${nums.length} frames` : ""}</>}
        </div>

        <button
          type="button"
          className="rm-console-toggle"
          onClick={() => setConsoleOpen((o) => !o)}
          aria-expanded={consoleOpen}
          title={consoleOpen ? "Hide run log" : "Show run log"}
        >
          <span className={`rm-console-caret${consoleOpen ? " open" : ""}`} aria-hidden="true">›</span>
          Console <span className="muted">{logLines} lines</span>
        </button>
        {consoleOpen && (
          <pre className="log rm-console">{log || "— log will stream here once a run starts —"}</pre>
        )}
      </div>
      )}
    </div>
  );
}
