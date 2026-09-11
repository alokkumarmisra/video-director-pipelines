export interface GenerationProgress {
  status: "idle" | "running" | "done" | "error";
  /** User cancelled the run (subset of error) — progress is kept, not reset. */
  cancelled: boolean;
  /** 0-100, derived from real completed/total generation tasks. */
  pct: number;
  completed: number;
  total: number;
  /** 1-based current scene (beat) number, null when unknown (e.g. ref-only). */
  scene: number | null;
  /** Total scenes (beats) in the scenario — the "/N" in "Scene N / total". */
  totalScenes: number | null;
  imagesDone: number;
  imagesTotal: number;
  videosDone: number;
  videosTotal: number;
  /** Milliseconds remaining estimate, null while unknown (nothing completed yet). */
  etaMs: number | null;
  /** Per-category remaining estimates (live countdowns for the Images /
      Videos rows in the header). Null when unknown or not applicable. */
  imagesEtaMs: number | null;
  videosEtaMs: number | null;
  /** ms since generation started (for "elapsed" display / debugging). */
  elapsedMs: number;
  /** ms epoch when the run started (null when unknown, e.g. old payloads). */
  startedAt: number | null;
  /** Scenario (output dir) being generated. */
  scenario: string;
}

export const emptyProgress: GenerationProgress = {
  status: "idle",
  cancelled: false,
  pct: 0,
  completed: 0,
  total: 0,
  scene: null,
  totalScenes: null,
  imagesDone: 0,
  imagesTotal: 0,
  videosDone: 0,
  videosTotal: 0,
  etaMs: null,
  imagesEtaMs: null,
  videosEtaMs: null,
  elapsedMs: 0,
  startedAt: null,
  scenario: "",
};

// Clock time the run started at: "14:32" (with seconds when < 1 min precision
// matters less — HH:MM is enough for the slim top bar; title tooltip carries
// the full date-time via formatStartedLong).
export function formatStarted(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatStartedLong(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${d.toLocaleString("en", { month: "short" })}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Time Remaining as a fixed-width digital countdown: "Time Remaining 01h:01m:01s".
// Zero-padded so the text never shifts width as it ticks. Unknown ETA
// (no pace measured yet) shows dashes, never a fake frozen zero.
export function formatRemaining(ms: number | null): string {
  return `Time Remaining ${formatDuration(ms)}`;
}

// Bare digital duration value without the label: "01h:01m:01s" (dashes when
// unknown) — for tight inline placement next to the image/video counts in
// the menu header (e.g. "3/7 00h:04m:12s").
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "--h:--m:--s";
  const total = Math.max(0, Math.round(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${p(h)}h:${p(m)}m:${p(s)}s`;
}

// Compact duration for time-elapsed display: 45s, 5m 20s, 2h 5m.
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

// ---- Historical per-task pace (localStorage) ----
// Running-mean image/video task durations measured from previous runs on
// this machine, so the Time Remaining countdown can tick from the very
// first second — before the current run has completed anything to measure.
// Real measured data only (never fabricated); live in-run measurements
// always take precedence and correct it as assets land.
const PACE_KEY = "ss-pace-v1";
const PACE_CAP = 50; // recent runs weigh more; the mean stays adaptive
// A real generation never finishes faster than this (resume-skips and the
// ffmpeg stitch land in milliseconds). Anything quicker is not a pace
// sample — counting it would collapse the averages toward zero and freeze
// Time Remaining at 00:00:00 for the rest of the run.
export const MIN_TASK_MS = 2000;

export function loadPace(): { img: number | null; vid: number | null } {
  const none = { img: null, vid: null };
  try {
    const raw = localStorage.getItem(PACE_KEY);
    if (!raw) return none;
    const d = JSON.parse(raw) as {
      img?: { n: number; mean: number } | null;
      vid?: { n: number; mean: number } | null;
    };
    const pick = (s?: { n: number; mean: number } | null) =>
      s && s.n > 0 && Number.isFinite(s.mean) && s.mean >= MIN_TASK_MS ? s.mean : null;
    return { img: pick(d?.img), vid: pick(d?.vid) };
  } catch {
    return none;
  }
}

export function recordPaceDuration(image: boolean, ms: number): void {
  // Sub-threshold intervals are resume-skips, not generations — recording
  // them would poison the pace toward zero (and freeze future countdowns).
  if (!Number.isFinite(ms) || ms < MIN_TASK_MS) return;
  try {
    const raw = localStorage.getItem(PACE_KEY);
    const d = (raw ? JSON.parse(raw) : {}) as {
      img?: { n: number; mean: number };
      vid?: { n: number; mean: number };
    };
    const slot = image ? "img" : "vid";
    const prev = d[slot] ?? { n: 0, mean: 0 };
    const n = Math.min((prev.n || 0) + 1, PACE_CAP);
    const mean = (prev.mean || 0) + (ms - (prev.mean || 0)) / n;
    localStorage.setItem(PACE_KEY, JSON.stringify({ ...d, [slot]: { n, mean } }));
  } catch {
    // Storage unavailable (private mode etc.) — pace just stays unknown.
  }
}

interface Props {
  progress: GenerationProgress;
  /** Slim single-row variant for the top menu bar. */
  compact?: boolean;
}

/**
 * Global generation progress bar. Purely presentational — all numbers come
 * from the real run state (RunPanel), never fake timers.
 */
export default function GenerationProgressBar({ progress, compact }: Props) {
  const { status, cancelled, pct, scene, totalScenes, etaMs } = progress;
  const done = status === "done";
  const failed = status === "error" && !cancelled;

  let title = "Generating Scenes…";
  if (done) title = "Generation complete";
  else if (cancelled) title = "Generation cancelled";
  else if (failed) title = "Generation failed";

  let sub: string;
  if (done) sub = "100% • Generation complete";
  else if (cancelled) sub = `${Math.round(pct)}% completed • Cancelled`;
  else if (failed) sub = `${Math.round(pct)}% • 1 generation failed`;
  else if (scene != null && totalScenes != null) sub = `Scene ${scene} of ${totalScenes}`;
  else if (progress.total > 0) sub = `${progress.completed} of ${progress.total} tasks`;
  else sub = "Starting…";

  if (compact) {
    if (status === "idle") {
      return (
        <div
          className="gen-progress gen-compact gen-idle"
          role="status"
          aria-label="No active generation"
          title="No active generation — start one with Generate"
        >
          <span className="gen-compact-title muted">Ready</span>
          <span className="gen-compact-sub muted">No active generation</span>
        </div>
      );
    }
    // Same info as the Home → Recent Projects card (generating state plus
    // image/video asset counts) plus the ETA — all from the live run state.
    const running = status === "running";
    const scenePart =
      scene != null && totalScenes != null
        ? `Scene ${scene} of ${totalScenes}`
        : progress.total > 0
          ? `${progress.completed} of ${progress.total} tasks`
          : "";
    const compactTitle =
      running && progress.scenario ? `Generating ${progress.scenario}…` : title;
    // Start clock time ("Started 14:32") — from the real run start timestamp.
    const started =
      progress.startedAt != null ? `Started ${formatStarted(progress.startedAt)}` : "";
    // Time elapsed since generation started (live while running, frozen at
    // the final total once done).
    const elapsed =
      progress.elapsedMs > 0 ? `Elapsed ${formatElapsed(progress.elapsedMs)}` : "";
    // Time Remaining — always shown while running in the menu header
    // (dashes until a real pace exists: historical pace first, then live
    // in-run measurements as assets land).
    const remaining = running && !done ? formatRemaining(etaMs) : "";
    const startedLong = formatStartedLong(progress.startedAt);
    // Tabular 3-bar layout for the main-menu bar (same topbar-center slot):
    //   Line 1 — "Generating <project>…" + overall pct
    //   Table  — Images (green) / Videos (blue) / Overall (red) status bars,
    //            each row's count carries its live time value inline
    //            ("3/7 00h:04m:12s") — no "Time Remaining" label, no extra
    //            lines. Nothing else.
    const showImages = progress.imagesTotal > 0;
    const showVideos = progress.videosTotal > 0;
    const imgPct = showImages ? (progress.imagesDone / progress.imagesTotal) * 100 : 0;
    const vidPct = showVideos ? (progress.videosDone / progress.videosTotal) * 100 : 0;
    const overallCount =
      progress.total > 0
        ? `${progress.completed}/${progress.total}`
        : `${Math.round(pct)}%`;
    let leftLine: string;
    let rightText: string;
    if (done) {
      leftLine = [scenePart, started, elapsed].filter(Boolean).join(" • ");
      rightText = "Completed";
    } else if (cancelled) {
      leftLine = [started, elapsed].filter(Boolean).join(" • ");
      rightText = "Cancelled";
    } else if (failed) {
      leftLine = "1 generation failed";
      rightText = "";
    } else {
      leftLine =
        [scenePart, started, elapsed].filter(Boolean).join(" • ") || "Starting…";
      rightText = remaining;
    }
    const flat = [leftLine, rightText].filter(Boolean).join(" • ");
    // State classes replace the red overall fill on failure/cancel so the
    // terminal state stays distinguishable; Images/Videos always keep
    // their green/blue identity.
    const overallFillClass = failed
      ? "progress-fill failed"
      : cancelled
        ? "progress-fill cancelled"
        : `progress-fill fill-overall${running && !done ? " sweep" : ""}`;
    return (
      <div
        className="gen-progress gen-compact gen-stacked"
        role="status"
        aria-live="polite"
        aria-label={`${compactTitle} ${Math.round(pct)} percent, ${flat}`}
        title={startedLong ? `${compactTitle} — started ${startedLong} — ${flat}` : `${compactTitle} — ${flat}`}
      >
        <div className="gen-compact-row1">
          <span className="gen-compact-title">{compactTitle}</span>
          <span className="gen-compact-pct">{Math.round(pct)}%</span>
        </div>
        <div className="gen-compact-table" role="presentation">
          {showImages && (
            <div className="gen-compact-trow trow-detail">
              <div className="gen-compact-trow-main">
                <span className="gen-compact-label">images</span>
                <div className="progress-bar gen-compact-bar" aria-hidden="true">
                  <div
                    className={`progress-fill fill-images${running ? " sweep" : ""}`}
                    style={{ width: `${Math.min(100, Math.max(0, imgPct))}%` }}
                  />
                </div>
                <span className="gen-compact-count">{progress.imagesDone}/{progress.imagesTotal}{running ? ` ${formatDuration(progress.imagesEtaMs)}` : ""}</span>
              </div>
            </div>
          )}
          {showVideos && (
            <div className="gen-compact-trow trow-detail">
              <div className="gen-compact-trow-main">
                <span className="gen-compact-label">videos</span>
                <div className="progress-bar gen-compact-bar" aria-hidden="true">
                  <div
                    className={`progress-fill fill-videos${running ? " sweep" : ""}`}
                    style={{ width: `${Math.min(100, Math.max(0, vidPct))}%` }}
                  />
                </div>
                <span className="gen-compact-count">{progress.videosDone}/{progress.videosTotal}{running ? ` ${formatDuration(progress.videosEtaMs)}` : ""}</span>
              </div>
            </div>
          )}
          <div className="gen-compact-trow">
            <div className="gen-compact-trow-main">
              <span className="gen-compact-label">overall</span>
              <div className="progress-bar gen-compact-bar" aria-hidden="true">
                <div
                  className={overallFillClass}
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                />
              </div>
              <span className="gen-compact-count">{overallCount}{running ? ` ${formatDuration(etaMs)}` : ""}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="gen-progress"
      role="status"
      aria-live="polite"
      aria-label={`Generation progress ${Math.round(pct)} percent`}
    >
      <div className="gen-progress-top">
        <span className="gen-progress-title">{title}</span>
        <span className="gen-progress-pct">{Math.round(pct)}%</span>
      </div>
      <div className="progress-bar gen-progress-bar">
        <div
          className={`progress-fill${failed ? " failed" : ""}${cancelled ? " cancelled" : ""}${status === "running" ? " sweep" : ""}`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="progress-meta gen-progress-meta">
        <span>{sub}</span>
        {progress.startedAt != null && (
          <span className="muted">Started {formatStartedLong(progress.startedAt)}</span>
        )}
        {done && <span className="muted">Completed</span>}
      </div>
      {!done && status === "running" && (
        <span className="gen-progress-remaining">{formatRemaining(etaMs)}</span>
      )}
      {(progress.imagesTotal > 0 || progress.videosTotal > 0) && (
        <>
          {progress.imagesTotal > 0 && (
            <div className="progress-meta gen-progress-meta">
              <span className="muted">
                Images: {progress.imagesDone} / {progress.imagesTotal}
              </span>
              {status === "running" && (
                <span className="muted">{formatRemaining(progress.imagesEtaMs)}</span>
              )}
            </div>
          )}
          {progress.videosTotal > 0 && (
            <div className="progress-meta gen-progress-meta">
              <span className="muted">
                Videos: {progress.videosDone} / {progress.videosTotal}
              </span>
              {status === "running" && (
                <span className="muted">{formatRemaining(progress.videosEtaMs)}</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
