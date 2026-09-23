import { useCallback, useEffect, useRef, useState } from "react";
import {
  refaceAnalyze, refaceDelete, refaceFile, refaceJob, refaceJobs,
  refaceReference, refaceSwap, refaceUpload,
  type RefaceJob, type RefaceSummary,
} from "../api";
import { useDialog } from "./Dialog";
import { IconCheck, IconFilm, IconRefresh, IconTrash, IconUpload, IconUser, Spinner } from "./Icons";

const fmtClock = (s: number | null | undefined) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};
const fmtMB = (b: number | null | undefined) =>
  b == null ? "—" : `${(b / 1048576).toFixed(1)} MB`;

const WORKING = new Set(["analyzing", "swapping"]);

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("could not read image file"));
    r.readAsDataURL(file);
  });
}

export default function RefacePage({ onOpenProject }: {
  onOpenProject?: (name: string) => void;
}) {
  void onOpenProject;
  const dialog = useDialog();
  const [jobs, setJobs] = useState<RefaceSummary[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<RefaceJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadFrac, setUploadFrac] = useState<number | null>(null);
  const [targetFace, setTargetFace] = useState<string | null>(null);
  const videoRef = useRef<HTMLInputElement | null>(null);
  const refRef = useRef<HTMLInputElement | null>(null);

  const refreshList = useCallback(async () => {
    try { setJobs(await refaceJobs()); } catch { /* keep old list */ }
  }, []);

  const loadJob = useCallback(async (id: string) => {
    const j = await refaceJob(id);
    setJob(j);
    setTargetFace((cur) => cur ?? j.targetFace ?? null);
  }, []);

  const openJob = useCallback(async (id: string) => {
    setJobId(id);
    setTargetFace(null);
    try { await loadJob(id); }
    catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Open failed", tone: "error" }); }
  }, [dialog, loadJob]);

  // The open job survives a page refresh: the id persists in localStorage,
  // and on load we reattach to it (or to whatever job is still working when
  // there is no stored id). A stored id pointing at a deleted job is dropped
  // silently — the user just lands on an empty studio.
  useEffect(() => {
    let stop = false;
    (async () => {
      let rows: RefaceSummary[] = [];
      try {
        rows = await refaceJobs();
        if (stop) return;
        setJobs(rows);
      } catch { return; }
      let stored: string | null = null;
      try { stored = localStorage.getItem("ss-reface-job"); } catch { stored = null; }
      if (stored && rows.some((r) => r.id === stored)) {
        setJobId(stored);
        setTargetFace(null);
        try { if (!stop) await loadJob(stored); }
        catch { /* job vanished mid-load — stays selected, list shows the truth */ }
        return;
      }
      const running = rows.find((r) => WORKING.has(r.status));
      if (running && !stop) {
        setJobId(running.id);
        setTargetFace(null);
        try { await loadJob(running.id); } catch { /* same as above */ }
        return;
      }
      if (stored) {
        try { localStorage.removeItem("ss-reface-job"); } catch { /* ignore */ }
      }
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      if (jobId) localStorage.setItem("ss-reface-job", jobId);
      else localStorage.removeItem("ss-reface-job");
    } catch { /* private mode — session-only */ }
  }, [jobId]);

  // Poll the open job while a worker runs (analyze / swap take minutes on
  // CPU — the progress bar + face panel fill in live). Stops on terminal
  // states; the list refreshes alongside so counts stay honest.
  useEffect(() => {
    if (!jobId) return;
    if (!job || !WORKING.has(job.status)) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const j = await refaceJob(jobId);
        if (stop) return;
        setJob(j);
        setTargetFace((cur) => cur ?? j.targetFace ?? null);
        refreshList().catch(() => {});
      } catch { /* transient — next tick retries */ }
    }, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [jobId, job?.status, refreshList]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); await refreshList().catch(() => {}); }
    catch (e) {
      await dialog.alert(e instanceof Error ? e.message : String(e), { title: `${label} failed`, tone: "error" });
    } finally { setBusy(null); }
  };

  const handleVideoFile = (f: File | undefined) => {
    if (!f) return;
    if (!/^video\//.test(f.type || "") && !/\.(mp4|webm|mov|mkv)$/i.test(f.name)) {
      dialog.alert("Pick a video file (mp4 / webm / mov / mkv).", { title: "Not a video", tone: "error" });
      return;
    }
    setUploadFrac(0);
    setBusy("Uploading");
    refaceUpload(f, setUploadFrac)
      .then(async (j) => {
        await refreshList().catch(() => {});
        setJobId(j.id);
        setTargetFace(null);
        setJob(j);
      })
      .catch((e) => { dialog.alert(e instanceof Error ? e.message : String(e), { title: "Upload failed", tone: "error" }); })
      .finally(() => { setBusy(null); setUploadFrac(null); });
  };

  const handleRefFile = (f: File | undefined) => {
    if (!f || !jobId) return;
    run("Uploading", async () => {
      const url = await fileToDataUrl(f);
      const j = await refaceReference(jobId, url);
      setJob(j);
    });
  };

  const working = !!job && WORKING.has(job.status);
  const progress = job?.progress ?? null;
  const faces = job?.faces ?? [];

  return (
    <div className="cmp">
      <div className="card cmp-hero">
        <div className="card-head">
          <h2>
            <span className="head-icon hi-reface" aria-hidden="true"><IconUser size={16} /></span>
            Reface
          </h2>
          {job && (
            <span className="muted">
              {job.filename || job.id} · {fmtClock(job.duration)} · {job.width}×{job.height} · {job.status}
            </span>
          )}
          <span className="spacer" />
          <select
            aria-label="Open saved reface job"
            value={jobId ?? ""}
            onChange={(e) => e.target.value && openJob(e.target.value)}
          >
            <option value="">Open saved… ({jobs.length})</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {(j.filename || j.id).slice(0, 40)} · {j.status} · {j.faces} faces{j.hasResult ? " · done" : ""}
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={() => refreshList()} title="Refresh list"><IconRefresh size={14} /></button>
          {jobId && (
            <button
              className="btn sm danger"
              disabled={busy != null}
              title="Delete this reface job and its files"
              onClick={() => run("Deleting", async () => {
                await refaceDelete(jobId);
                setJobId(null); setJob(null); setTargetFace(null);
              })}
            >
              <IconTrash size={14} />
            </button>
          )}
        </div>
        <p className="card-desc">
          Upload a video — AI finds every face and shows each person in a panel.
          Upload one reference face, pick which person to replace, and the video
          is re-rendered with the new face (original audio kept).
        </p>
        {job?.error && <p className="pill err" style={{ margin: "4px 0" }}>{job.error}</p>}
      </div>

      {/* Step 1 — source video */}
      <div className="card">
        <div className="card-head"><h3>1 · Source video</h3></div>
        <input
          ref={videoRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.mkv"
          style={{ display: "none" }}
          onChange={(e) => { handleVideoFile(e.target.files?.[0]); e.target.value = ""; }}
        />
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={busy != null} onClick={() => videoRef.current?.click()}>
            {busy === "Uploading" ? <Spinner size={14} /> : <IconUpload size={14} />}
            {job ? "Upload a different video" : "Upload video"}
          </button>
          {uploadFrac != null && (
            <span className="pill">uploading {Math.round(uploadFrac * 100)}%</span>
          )}
          {job?.source && (
            <span className="pill muted">{fmtMB(job.bytes)} · {job.fps ? `${Number(job.fps).toFixed(1)} fps` : ""}{job.hasAudio ? " · audio" : ""}</span>
          )}
        </div>
        {uploadFrac != null && (
          <div className="progress-toggle-track" style={{ marginTop: 8 }} aria-hidden="true">
            <span className="progress-toggle-fill status-running sweep" style={{ width: `${Math.round(uploadFrac * 100)}%` }} />
          </div>
        )}
        {job?.source && (
          <video
            key={job.source}
            src={refaceFile(job.id, job.source)}
            controls
            preload="metadata"
            style={{ width: "100%", maxHeight: 320, marginTop: 10, borderRadius: 8, background: "#000" }}
          />
        )}
      </div>

      {/* Step 2 — faces panel */}
      <div className="card">
        <div className="card-head">
          <h3>2 · Faces in this video</h3>
          <span className="spacer" />
          <button
            className="btn"
            disabled={!job || busy != null || working}
            onClick={() => jobId && run("Analyzing", async () => {
              await refaceAnalyze(jobId);
              const j = await refaceJob(jobId);
              setJob(j);
            })}
            title={job ? "Detect + cluster every face identity" : "Upload a video first"}
          >
            {job?.status === "analyzing" ? <Spinner size={14} /> : <IconUser size={14} />}
            {faces.length ? "Re-analyze faces" : "Find faces"}
          </button>
        </div>
        {!job && <p className="muted">Upload a video first — detected people appear here.</p>}
        {job && job.status !== "analyzing" && !faces.length && (
          <p className="muted">
            {job.status === "analyzed"
              ? "No faces found — try a clip with clearer, front-facing people."
              : "Click “Find faces” — AI scans the clip and groups each person."}
          </p>
        )}
        {!!faces.length && job && (
          <div
            className="row"
            style={{ gap: 10, flexWrap: "wrap", marginTop: 6 }}
            role="radiogroup"
            aria-label="Face to replace"
          >
            {faces.map((f) => {
              const on = targetFace === f.id;
              return (
                <button
                  key={f.id}
                  role="radio"
                  aria-checked={on}
                  title={`${f.id} — ${f.count} sightings, first at ${fmtClock(f.firstSeen)} — click to replace this person`}
                  onClick={() => setTargetFace(f.id)}
                  className={`btn sm${on ? " primary" : ""}`}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: 6 }}
                >
                  <img
                    src={refaceFile(job.id, f.thumb)}
                    alt={f.id}
                    width={56}
                    height={56}
                    style={{ borderRadius: 8, objectFit: "cover", background: "#000" }}
                  />
                  <span style={{ textAlign: "left", lineHeight: 1.4 }}>
                    <strong>{f.id}</strong>
                    <br />
                    <span className="muted">{f.count} sightings · {fmtClock(f.firstSeen)}</span>
                  </span>
                  {on && <IconCheck size={14} />}
                </button>
              );
            })}
          </div>
        )}
        {!!faces.length && (
          <p className="muted" style={{ marginTop: 8 }}>
            Click the person to replace{targetFace ? ` — selected: ${targetFace}` : " — then add your reference face below."}
          </p>
        )}
        {working && progress && (
          <div style={{ marginTop: 10 }}>
            <p className="muted" style={{ margin: "0 0 6px" }}>
              {job?.status === "swapping"
                ? `Replacing ${job?.targetFace ?? "face"} — ${progress.detail ?? "swapping…"}`
                : (progress.detail ?? "analyzing…")}
              {" · "}{progress.pct}%
              {job?.status === "swapping" && progress.total
                ? ` · frame ${progress.frame ?? 0}/${progress.total}` : ""}
            </p>
            <div className="progress-toggle-track" aria-hidden="true">
              <span
                className="progress-toggle-fill status-running sweep"
                style={{ width: `${Math.min(100, Math.max(0, progress.pct))}%` }}
              />
            </div>
            {job?.status === "swapping" && (
              <p className="muted" style={{ margin: "6px 0 0" }}>
                Running on this machine&apos;s CPU — a minutes-long video takes minutes.
                You can leave this page open; the job keeps running.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Step 3 — reference face */}
      <div className="card">
        <div className="card-head"><h3>3 · New reference face</h3></div>
        <input
          ref={refRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          onChange={(e) => { handleRefFile(e.target.files?.[0]); e.target.value = ""; }}
        />
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" disabled={!job || busy != null} onClick={() => refRef.current?.click()}>
            {busy === "Uploading" ? <Spinner size={14} /> : <IconUpload size={14} />}
            {job?.reference ? "Replace reference image" : "Upload reference image"}
          </button>
          <span className="muted">One clear, front-facing photo works best.</span>
        </div>
        {job?.reference && (
          <img
            src={refaceFile(job.id, job.reference)}
            alt="Reference face"
            style={{ marginTop: 10, maxWidth: 220, maxHeight: 220, borderRadius: 8, objectFit: "cover" }}
          />
        )}
      </div>

      {/* Step 4 — swap */}
      <div className="card">
        <div className="card-head"><h3>4 · Replace + result</h3></div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn primary"
            disabled={!job || !targetFace || !job.reference || busy != null || working}
            title={
              !job ? "Upload a video first"
              : !targetFace ? "Pick a face from the panel first"
              : !job.reference ? "Upload a reference face image first"
              : `Replace ${targetFace} with your reference face`
            }
            onClick={() => jobId && targetFace && run("Starting", async () => {
              await refaceSwap(jobId, targetFace);
              const j = await refaceJob(jobId);
              setJob(j);
            })}
          >
            {job?.status === "swapping" ? <Spinner size={14} /> : <IconFilm size={14} />}
            {job?.result ? "Swap again" : "Replace face"}
          </button>
          {job?.status === "done" && <span className="pill ok">done</span>}
        </div>
        {job?.result && (
          <div style={{ marginTop: 10 }}>
            <video
              key={job.result}
              src={refaceFile(job.id, job.result)}
              controls
              preload="metadata"
              style={{ width: "100%", maxHeight: 360, borderRadius: 8, background: "#000" }}
            />
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <a className="btn sm" href={refaceFile(job.id, job.result)} download>
                Download result
              </a>
              {job.targetFace && <span className="pill muted">replaced {job.targetFace}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
