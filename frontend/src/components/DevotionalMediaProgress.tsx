import { useEffect, useRef, useState } from "react";
import { cancelDevotionalJob, listDevotionalJobs, type DevotionalJob } from "../devotionalApi";
import { formatDuration, formatLiveElapsed, loadPace, recordPaceDuration } from "./GenerationProgressBar";
import { IconX, Spinner } from "./Icons";

// One one-click media session: the job ids queued by POST .../generate
// ({ both: true } → still + clip, still-only → still alone, { only:
// "video" } → clip alone). kinds parallels jobIds so labels are right from
// the first paint (before the first status poll resolves the server kind).
export interface MediaSession {
  assetId: string;
  assetName: string;
  jobIds: string[];
  kinds?: ("reference" | "video")[];
  startedAt: number;
}

type JobStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
const TERMINAL: JobStatus[] = ["COMPLETED", "FAILED"];

interface Unit {
  jobId: string;
  label: string;
  image: boolean;
  status: JobStatus;
  error: string | null;
}

const statusOf = (j: DevotionalJob | undefined): JobStatus => {
  const s = String(j?.status || "PENDING").toUpperCase();
  return (TERMINAL as string[]).includes(s) ? (s as JobStatus) : s === "PROCESSING" ? "PROCESSING" : "PENDING";
};

// Live tracker for one media session. Polls ONLY its own job ids (server
// ?ids= filter — never the 30-row window) every 2s while anything is active,
// plus a 1s ticker so elapsed + the in-flight % estimate tick in real time.
//
// Percentage semantics mirror the app's RunPanel exactly: the Overall bar
// counts REAL completions only (0/50/100 for still+clip); the in-flight unit
// shows an estimated 0–99% (elapsed vs historical pace, 100 reserved for
// landed); with no pace yet the unit shows an indeterminate sweep + live
// elapsed instead of a fake number. Completed unit durations feed the shared
// pace store so the next session estimates from second one.
export function useDevotionalMediaProgress(session: MediaSession | null) {
  const [rows, setRows] = useState<Map<string, DevotionalJob>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  // jobId -> first-seen PROCESSING timestamp (client-observed, so pace
  // samples measure generation only — never queue wait).
  const procSeen = useRef(new Map<string, number>());

  const jobIds = session?.jobIds ?? [];
  const idsKey = jobIds.join(",");

  useEffect(() => {
    procSeen.current.clear();
    setRows(new Map());
    if (!session || jobIds.length === 0) return;
    let dead = false;
    const poll = async () => {
      try {
        const list = await listDevotionalJobs(undefined, 30, jobIds);
        if (dead) return;
        const t = Date.now();
        setRows((prev) => {
          const next = new Map(prev);
          for (const j of list) {
            const was = next.get(j.id);
            const wasSt = statusOf(was);
            const isSt = statusOf(j);
            if (isSt === "PROCESSING" && wasSt !== "PROCESSING" && !procSeen.current.has(j.id)) {
              procSeen.current.set(j.id, t);
            }
            if (isSt === "COMPLETED" && wasSt !== "COMPLETED") {
              // Observed transition → honest pace sample (never fabricated
              // from queue wait; sub-threshold junk filtered inside).
              const start = procSeen.current.get(j.id);
              if (start != null) recordPaceDuration(j.kind !== "video", t - start);
              procSeen.current.delete(j.id);
            }
            if (isSt === "FAILED") procSeen.current.delete(j.id);
            next.set(j.id, j);
          }
          return next;
        });
      } catch { /* transient — next tick retries */ }
    };
    void poll();
    const t = setInterval(() => {
      void poll();
      setNow(Date.now());
    }, 2000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { dead = true; clearInterval(t); clearInterval(tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const units: Unit[] = jobIds.map((id, i) => {
    const j = rows.get(id);
    // Server kind wins once polled; the queued kinds hint covers the first
    // paint (and lone-clip sessions, which must never read "Still").
    const hint = session?.kinds?.[i];
    const kind = j?.kind ?? hint ?? (id === jobIds[jobIds.length - 1] && jobIds.length > 1 ? "video" : "reference");
    const isVideo = kind === "video";
    return {
      jobId: id,
      label: isVideo ? "Clip" : "Still",
      image: !isVideo,
      status: statusOf(j),
      error: j?.error_message ?? null,
    };
  });
  const done = units.filter((u) => u.status === "COMPLETED").length;
  const failed = units.find((u) => u.status === "FAILED") ?? null;
  const active = units.find((u) => !TERMINAL.includes(u.status)) ?? null;
  const allDone = units.length > 0 && done === units.length;
  const pct = units.length ? Math.round((done / units.length) * 100) : 0;

  // In-flight estimate (RunPanel formula): elapsed vs expected, capped 99.
  let activePct: number | null = null;
  let activeElapsed: number | null = null;
  let activeExpected: number | null = null;
  if (active) {
    const procStart = procSeen.current.get(active.jobId);
    const elapsed = Math.max(0, now - (procStart ?? session!.startedAt));
    activeElapsed = elapsed;
    if (active.status === "PROCESSING") {
      const pace = loadPace();
      const expected = active.image ? pace.img : pace.vid;
      if (expected != null && Number.isFinite(expected) && expected > 0) {
        activeExpected = Math.round(expected);
        activePct = Math.min(99, Math.max(elapsed > 1500 ? 1 : 0, Math.floor((elapsed / expected) * 100)));
      }
    }
  }
  // Remaining: active remainder + full expectation per queued unit (pace
  // only — dashes until one pace exists, never a fake zero).
  let remaining: number | null = null;
  if (active) {
    const pace = loadPace();
    const exp = (image: boolean) => (image ? pace.img : pace.vid);
    let sum = 0;
    let known = false;
    for (const u of units) {
      if (u.status === "COMPLETED" || u.status === "FAILED") continue;
      const e = exp(u.image);
      if (e == null || !Number.isFinite(e) || e <= 0) continue;
      known = true;
      sum += u.jobId === active.jobId && activeElapsed != null ? Math.max(0, e - activeElapsed) : e;
    }
    remaining = known ? Math.round(sum) : null;
  }

  const elapsedTotal = session ? Math.max(0, now - session.startedAt) : 0;
  return { units, done, total: units.length, pct, active, activePct, activeElapsed, activeExpected, remaining, elapsedTotal, failed, allDone, now };
}

// Inline progress card: Still (cyan) + Clip (blue) + Overall (accent) bars in
// the app's own .gen-compact-table language, with sweep animation, spinner,
// mono % and elapsed/remaining. onDone fires once when every unit lands;
// onDismiss drops a failed session.
export default function DevotionalMediaProgress({ session, onDone, onDismiss }: {
  session: MediaSession;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const p = useDevotionalMediaProgress(session);
  const doneFired = useRef(false);

  useEffect(() => {
    if (p.allDone && !doneFired.current) {
      doneFired.current = true;
      // Let the 100% state paint one beat before the parent reloads +
      // unmounts this card.
      const t = setTimeout(onDone, 1500);
      return () => clearTimeout(t);
    }
  }, [p.allDone, onDone]);

  const cancel = async (jobId: string) => {
    try { await cancelDevotionalJob(jobId); } catch { /* poll shows the truth */ }
  };

  const unitCount = (u: (typeof p.units)[number]) =>
    u.status === "COMPLETED" ? "100%" : u.status === "FAILED" ? "failed"
    : u.jobId === p.active?.jobId && p.activePct != null ? `${p.activePct}%`
    : u.status === "PROCESSING" ? "…" : "queued";
  const unitWidth = (u: (typeof p.units)[number]) =>
    u.status === "COMPLETED" ? 100 : u.jobId === p.active?.jobId && p.activePct != null ? p.activePct
    : u.status === "PROCESSING" ? 100 : 0;

  return (
    <div className="dev-media-progress" aria-live="polite">
      <div className="gen-compact-row1">
        <span className="gen-compact-title">
          {p.allDone ? (
            <>✓ {p.total === 1 ? p.units[0]?.label : "Still + clip"} ready</>
          ) : p.failed && !p.active ? (
            <>Generation failed</>
          ) : (
            <><Spinner size={11} /> Generating {p.total === 1 ? (p.units[0]?.label ?? "media").toLowerCase() : "still + clip"} — {session.assetName}</>
          )}
        </span>
        <span className="gen-compact-pct">{p.allDone ? "100%" : `${p.pct}%`}</span>
      </div>
      <div className="gen-compact-table">
        {p.units.map((u) => (
          <div className="gen-compact-trow" key={u.jobId}>
            <span className="gen-compact-label">{u.label}</span>
            <span className={`progress-bar gen-compact-bar${u.status === "FAILED" ? " is-failed" : ""}`}>
              <span
                className={`progress-fill ${u.image ? "fill-images" : "fill-videos"}${u.status === "FAILED" ? " failed" : ""}${u.status === "PENDING" || u.status === "PROCESSING" ? " sweep" : ""}`}
                style={{ width: `${unitWidth(u)}%` }}
              />
            </span>
            <span className="gen-compact-count">{unitCount(u)}</span>
          </div>
        ))}
        {p.total > 1 && (
          <div className="gen-compact-trow">
            <span className="gen-compact-label">Overall</span>
            <span className="progress-bar gen-compact-bar">
              <span
                className={`progress-fill fill-overall${p.failed && !p.active ? " failed" : ""}${!p.allDone && !(p.failed && !p.active) ? " sweep" : ""}`}
                style={{ width: `${p.allDone ? 100 : p.pct}%` }}
              />
            </span>
            <span className="gen-compact-count">{p.done}/{p.total}</span>
          </div>
        )}
      </div>
      <div className="dev-media-meta">
        <span className="muted">
          {p.active && p.activeElapsed != null
            ? `${p.active.label} ${p.active.status === "PENDING" ? "queued" : "generating"} · ⏱ ${formatLiveElapsed(p.activeElapsed) ?? "0s"}`
            : p.allDone ? "✓ complete" : `⏱ ${formatLiveElapsed(p.elapsedTotal) ?? "0s"}`}
          {p.active && p.activeExpected != null && p.activePct != null && (
            <> · ~{formatLiveElapsed(Math.max(0, p.activeExpected - (p.activeElapsed ?? 0))) ?? ""} left</>
          )}
        </span>
        <span className="spacer" />
        {!p.allDone && !(p.failed && !p.active) && (
          <span className="muted">Remaining {formatDuration(p.remaining)}</span>
        )}
        {p.active && (
          <button className="btn sm ghost" onClick={() => void cancel(p.active!.jobId)} title="Cancel the running job">
            <IconX size={11} /> Cancel
          </button>
        )}
        {p.failed && !p.active && (
          <button className="btn sm ghost" onClick={onDismiss} title="Dismiss this failed generation">
            <IconX size={11} /> Dismiss
          </button>
        )}
      </div>
      {p.failed && (
        <div className="hint dev-media-error" title={p.failed.error ?? ""}>
          {p.failed.label} failed{p.failed.error ? `: ${p.failed.error.slice(0, 220)}` : ""} — fix ComfyUI and press Generate to retry, or track it in Reference Studio.
        </div>
      )}
    </div>
  );
}
