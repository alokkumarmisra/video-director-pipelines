import { useCallback, useEffect, useRef, useState } from "react";
import {
  folderOf, getScenario, getDialogueStatus, listOutputs, listRuns, listScenarios, outScenario, outputUrl,
  saveSceneDialogue, startRun, tailRun,
} from "../api";
import type { DialogueLine, Engine, VideoFormat, DialogueStatus } from "../api";
import type { OutputsInfo, Scenario, ScenarioInfo } from "../types";
import { IconPanel, Spinner } from "./Icons";
import Collapse from "./Collapse";

// Null-safe: a malformed beat (null entry, non-list dialogue) is treated as
// silent instead of throwing mid-render (which used to blank the whole app).
const hasDialogue = (b: { dialogue?: { speaker: string; line: string }[] | null } | null | undefined) =>
  !!b && Array.isArray(b.dialogue) && b.dialogue.some((d) => d && String(d.line || "").trim());

// Dialogue text format for the scene editor popup — one line per dialogue
// line as `speaker: line`, with an optional per-line expression as
// `speaker (expression): line` (same convention as the Story Board and
// Director scene editors; drives TTS prosody + clip length + lip-sync).
const dlgToText = (d: { speaker: string; line: string; expression?: string }[] | null | undefined): string =>
  (Array.isArray(d) ? d : []).map((x) => {
    const sp = String(x.speaker || "").trim();
    const ln = String(x.line || "").trim();
    const ex = String(x.expression || "").trim();
    const head = sp && ex ? `${sp} (${ex})` : sp;
    return head ? `${head}: ${ln}` : ln;
  }).filter(Boolean).join("\n");
const textToDlg = (t: string): DialogueLine[] =>
  t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const c = l.indexOf(":");
    if (c <= 0) return { speaker: "", line: l };
    const head = l.slice(0, c).trim();
    const line = l.slice(c + 1).trim();
    const m = head.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    return m
      ? { speaker: m[1].trim(), expression: m[2].trim(), line }
      : { speaker: head, line };
  }).filter((d) => d.line);

// Per-stage pipeline status for one dialogue beat (GET
// /api/project/:name/dialogue): Voice / Video / LipSync / Final each show
// COMPLETED (✓) or PENDING (…), plus a SEG badge when the beat has 2+
// speakers and takes the automatic segmented lip-sync path.
function StagePills({ status }: { status: import("../api").DialogueBeatStatus | null | undefined }) {
  if (!status) return null;
  const dot = (s: string) => (s === "COMPLETED" ? "✓" : "…");
  return (
    <p className="muted" style={{ margin: "4px 0 0", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <span className="pill" title={`Voice/TTS: ${status.voice}`}>🎙 {dot(status.voice)}</span>
      <span className="pill" title={`LTX clip video: ${status.video}`}>🎬 {dot(status.video)}</span>
      <span className="pill" title={`Lip-sync: ${status.lipsync}`}>👄 {dot(status.lipsync)}</span>
      <span className="pill" title={`Final cut: ${status.final}`}>🎞 {dot(status.final)}</span>
      {status.segmented && <span className="pill" title="Multi-speaker: each line synced to its own voice, then merged">SEG</span>}
      {status.total != null && <span title="Spoken dialogue length">⏱ {status.total.toFixed(1)}s</span>}
    </p>
  );
}

// Video LipSync — standalone studio for the dialogue voice + lip-sync pass
// (scripts/dialogue_lipsync.mjs via POST /api/runs { mode: "dialogue" }):
// pick a VIDEO project, review its dialogue beats, voice each line with
// per-character Edge-TTS Hindi voices and lip-sync the beat's clip with
// Easy-Wav2Lip. Needs generated clips first (run the normal pipeline, then
// come here). Stays mounted while hidden so in-flight work survives view
// switches (same pattern as CreateSongPage / DirectorPage).
export default function VideoLipSyncPage({ onOpenProject, onProjectsChanged }: {
  onOpenProject?: (name: string) => void;
  onProjectsChanged?: () => void;
}) {
  const [projects, setProjects] = useState<ScenarioInfo[]>([]);
  const [name, setName] = useState("");
  const [cfg, setCfg] = useState<Scenario | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [engine, setEngine] = useState<Engine>("ltx");
  const [format, setFormat] = useState<VideoFormat>("landscape");
  const [lipsync, setLipsync] = useState("wav2lip");
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [skipTts, setSkipTts] = useState(false);
  const [noStitch, setNoStitch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<OutputsInfo | null>(null);
  const [outputsLoading, setOutputsLoading] = useState(false);
  const [dlgStatus, setDlgStatus] = useState<DialogueStatus | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runLog, setRunLog] = useState("");
  const tailClose = useRef<(() => void) | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  // Scene dialogue editor popup (opened by clicking a beat number): shows
  // the scene number + its dialogue lines for editing, saved via
  // PUT /api/project/:name/scene/:n/dialogue (new scenario version; stale
  // voice files are deleted server-side so the beat honestly returns to
  // PENDING until re-voiced + re-synced).
  const [editingBeat, setEditingBeat] = useState<number | null>(null);
  const [dlgText, setDlgText] = useState("");
  const [dlgDuration, setDlgDuration] = useState("");
  const [savingDlg, setSavingDlg] = useState(false);
  const [dlgError, setDlgError] = useState<string | null>(null);
  const [formCollapsed, setFormCollapsed] = useState(() => localStorage.getItem("ss-sec-lipform") === "closed");
  const toggleFormCollapsed = () =>
    setFormCollapsed((c) => {
      localStorage.setItem("ss-sec-lipform", c ? "open" : "closed");
      return !c;
    });
  const [clipsCollapsed, setClipsCollapsed] = useState(() => localStorage.getItem("ss-sec-lipclips") === "closed");
  const toggleClipsCollapsed = () =>
    setClipsCollapsed((c) => {
      localStorage.setItem("ss-sec-lipclips", c ? "open" : "closed");
      return !c;
    });

  const stopTail = () => {
    tailClose.current?.();
    tailClose.current = null;
  };
  useEffect(() => stopTail, []);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [runLog]);

  const outDir = (project: string, eng: Engine, fmt: VideoFormat) => {
    const p = projects.find((x) => x.name === project);
    return outScenario(folderOf(p ?? { name: project }), eng, fmt);
  };

  const refreshOutputs = useCallback(async (project: string, eng: Engine, fmt: VideoFormat) => {
    if (!project.trim()) {
      setOutputs(null);
      return;
    }
    setOutputsLoading(true);
    try {
      setOutputs(await listOutputs(outDir(project, eng, fmt)));
    } catch {
      setOutputs(null);
    } finally {
      setOutputsLoading(false);
    }
  }, [projects]);

  const refreshDialogue = useCallback(async (project: string, eng: Engine, fmt: VideoFormat) => {
    if (!project.trim()) {
      setDlgStatus(null);
      return;
    }
    try {
      setDlgStatus(await getDialogueStatus(project.trim(), eng, fmt));
    } catch {
      setDlgStatus(null);
    }
  }, []);
  const refreshProjects = useCallback(async () => {
    try {
      const ss = await listScenarios();
      setProjects(ss.filter((s) => s.project_type !== "AUDIO"));
    } catch {
      setProjects([]);
    }
  }, []);
  useEffect(() => { void refreshProjects(); }, [refreshProjects]);

  const loadProject = useCallback(async (n: string) => {
    const t = n.trim();
    if (!t) {
      setError("Pick a project first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await getScenario(t);
      setCfg(r.config);
      const seq = Array.isArray(r.config.sequence) ? r.config.sequence : [];
      const dlg = seq.map((_, i) => i + 1).filter((i) => hasDialogue(seq[i - 1]));
      setChecked(new Set(dlg));
      await refreshOutputs(t, engine, format);
      await refreshDialogue(t, engine, format);
    } catch (e) {
      setCfg(null);
      setError(e instanceof Error ? e.message : "Load failed.");
    } finally {
      setLoading(false);
    }
  }, [engine, format, refreshOutputs, refreshDialogue]);

  // Re-run the outputs listing when engine/format change (each cut has its
  // own output dir with its own lip-synced takes).
  useEffect(() => {
    if (!name.trim() || runId != null) return;
    void refreshOutputs(name.trim(), engine, format);
    void refreshDialogue(name.trim(), engine, format);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, format]);
  // Reattach to a dialogue run started before this page loaded so progress
  // + log keep working across refreshes and view switches.
  useEffect(() => {
    const n = name.trim();
    if (!n || runId) return;
    listRuns()
      .then((rs) => {
        const active = [...rs].reverse().find((r) => r.status === "running" && r.scenario === n && r.mode === "dialogue");
        if (active) attachTail(active.id, n);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const attachTail = (id: string, project: string) => {
    stopTail();
    setRunId(id);
    setRunLog("");
    tailClose.current = tailRun(
      id,
      (line) => setRunLog((prev) => (prev + line).slice(-12000)),
      () => {
        setRunId(null);
        stopTail();
        void refreshOutputs(project, engine, format);
        void refreshDialogue(project, engine, format);
        onProjectsChanged?.();
      },
    );
  };

  const seq = cfg && Array.isArray(cfg.sequence) ? cfg.sequence : [];
  const dlgBeats = seq.map((b, i) => ({ b, n: i + 1 })).filter(({ b }) => hasDialogue(b));
  const generating = runId != null;

  const toggleBeat = (n: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const openDialogueEditor = (n: number) => {
    if (generating || busy) return;
    const b = seq[n - 1];
    if (!b) return;
    setDlgText(dlgToText(Array.isArray(b.dialogue) ? b.dialogue : []));
    setDlgDuration(b.duration != null ? String(b.duration) : "");
    setDlgError(null);
    setEditingBeat(n);
  };

  const saveDialogue = async () => {
    const t = name.trim();
    if (editingBeat == null || savingDlg || !t) return;
    const n = editingBeat;
    const parsed = textToDlg(dlgText);
    if (parsed.length > 8) {
      setDlgError("At most 8 dialogue lines per scene.");
      return;
    }
    for (const d of parsed) {
      if (!d.speaker.trim()) {
        setDlgError(`Every line needs a speaker ("speaker: line") — got: ${d.line.slice(0, 40)}`);
        return;
      }
      if (d.line.length > 500) {
        setDlgError(`Line over 500 chars: ${d.line.slice(0, 40)}…`);
        return;
      }
    }
    let duration: number | undefined;
    if (dlgDuration.trim() !== "") {
      const v = Number(dlgDuration);
      if (!Number.isFinite(v) || v < 1 || v > 30) {
        setDlgError("Clip length must be 1–30 seconds (or empty to keep it).");
        return;
      }
      duration = Math.round(v);
    }
    setSavingDlg(true);
    setDlgError(null);
    try {
      const r = await saveSceneDialogue(t, n, parsed, duration);
      const nextDialogue = Array.isArray(r.dialogue) ? r.dialogue : parsed;
      setCfg((prev) => prev && Array.isArray(prev.sequence)
        ? {
          ...prev,
          sequence: prev.sequence.map((b, i) => i + 1 === n
            ? { ...b, dialogue: nextDialogue, ...(duration != null ? { duration } : {}) }
            : b),
        }
        : prev);
      if (nextDialogue.length === 0) {
        setChecked((prev) => {
          const next = new Set(prev);
          next.delete(n);
          return next;
        });
      }
      setEditingBeat(null);
      await refreshOutputs(t, engine, format);
      await refreshDialogue(t, engine, format);
    } catch (e) {
      setDlgError(e instanceof Error ? e.message : "Dialogue save failed.");
    } finally {
      setSavingDlg(false);
    }
  };

  // Lock background scroll + Esc to close while the editor popup is open.
  useEffect(() => {
    if (editingBeat == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditingBeat(null);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [editingBeat]);

  const handleRun = async () => {
    if (generating) return;
    const t = name.trim();
    if (!t) {
      setError("Pick a project first.");
      return;
    }
    if (dlgBeats.length === 0) {
      setError("This project has no dialogue lines — add speaker: line dialogue to its beats first.");
      return;
    }
    if (checked.size === 0) {
      setError("Tick at least one dialogue beat to run.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const allChecked = dlgBeats.every(({ n }) => checked.has(n));
      const d = await startRun(t, {
        mode: "dialogue",
        engine,
        format,
        ...(allChecked ? {} : { beats: [...checked].sort((a, b) => a - b).join(",") }),
        lipsync,
        skipTts,
        skipLipsync: voiceOnly,
        noStitch,
      });
      if (d.error) throw new Error(d.error);
      if (!d.id) throw new Error("server did not start a run");
      attachTail(d.id, t);
      onProjectsChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lip-sync run failed.");
    } finally {
      setBusy(false);
    }
  };

  const dir = name.trim() ? outDir(name.trim(), engine, format) : "";
  const wavFor = (n: number) =>
    (Array.isArray(outputs?.files) ? outputs.files : []).filter((f) => new RegExp(`_dlg${n}_.*\\.wav$`).test(f));

  return (
    <div className="song-page">
      <section className={`card song-form-card${formCollapsed ? " collapsed" : ""}`} aria-label="Video LipSync">
        <div className="card-head">
          <h2>Video LipSync</h2>
          {generating && <span className="pill running"><Spinner size={11} /> Lip-syncing…</span>}
          <span className="spacer" />
          <button
            className="icon-btn"
            onClick={toggleFormCollapsed}
            title={formCollapsed ? "Show lip-sync studio" : "Hide lip-sync studio"}
            aria-label={formCollapsed ? "Show lip-sync studio" : "Hide lip-sync studio"}
            aria-expanded={!formCollapsed}
          >
            <IconPanel size={15} />
          </button>
        </div>
        <Collapse open={!formCollapsed}>
          <p className="card-desc">
            Talking-scene workflow per beat: character keyframe → silent clip (LTX/Wan i2v,
            3–5s, generated here when missing) → Hindi dialogue voice (per-character Edge-TTS)
            → lip-sync engine → talking video → re-stitched final. Beats with no detectable
            face fall back to dubbed (voice muxed).
          </p>
          <div className="dialog-actions song-actions song-actions-top">
            <button type="button" className="primary" onClick={handleRun} disabled={busy || generating || !name.trim() || dlgBeats.length === 0 || checked.size === 0}>
              {generating && <Spinner size={13} />}
              {generating ? "Lip-syncing…" : "🎙 Run LipSync"}
            </button>
            {onOpenProject && name.trim() && (
              <button type="button" className="ghost" onClick={() => onOpenProject(name.trim())} disabled={busy}>
                Open project
              </button>
            )}
          </div>
          <div className="song-grid">
            <label htmlFor="lip-project">Project *</label>
            <div className="song-name-row">
              <select
                id="lip-project"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy || generating}
                style={{ flex: 1 }}
              >
                <option value="">Pick a video project…</option>
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
              <button type="button" className="ghost" onClick={() => void loadProject(name)} disabled={loading || busy || generating || !name.trim()}>
                {loading ? "Loading…" : "Load"}
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label htmlFor="lip-engine">Engine</label>
                <select
                  id="lip-engine"
                  value={engine}
                  onChange={(e) => setEngine(e.target.value === "wan" ? "wan" : "ltx")}
                  disabled={busy || generating}
                  style={{ width: "100%", marginTop: 4 }}
                >
                  <option value="ltx">LTX</option>
                  <option value="wan">Wan 2.1</option>
                </select>
              </div>
              <div>
                <label htmlFor="lip-format">Cut</label>
                <select
                  id="lip-format"
                  value={format}
                  onChange={(e) => setFormat(e.target.value === "vertical" ? "vertical" : "landscape")}
                  disabled={busy || generating}
                  style={{ width: "100%", marginTop: 4 }}
                >
                  <option value="landscape">YouTube (landscape)</option>
                  <option value="vertical">Instagram (vertical)</option>
                </select>
              </div>
            </div>
            <div>
              <label htmlFor="lip-engine-sync">Lip-sync engine</label>
              <select
                id="lip-engine-sync"
                value={lipsync}
                onChange={(e) => setLipsync(e.target.value)}
                disabled={busy || generating}
                style={{ width: "100%", marginTop: 4 }}
                title={
                  dlgStatus && !dlgStatus.providers.musetalkWorkflow
                    ? "MuseTalk needs a configured workflow: replace workflows/musetalk_lipsync.json with your exported ComfyUI MuseTalk workflow ({{VIDEO}} / {{AUDIO}} tokens), or set MUSETALK_WORKFLOW"
                    : "Engine used to sync the silent clip to the dialogue voice"
                }
              >
                <option value="wav2lip">Easy-Wav2Lip (local)</option>
                <option
                  value="musetalk-comfy"
                  disabled={!!dlgStatus && !dlgStatus.providers.musetalkWorkflow}
                >
                  MuseTalk (ComfyUI){dlgStatus && !dlgStatus.providers.musetalkWorkflow ? " — not configured" : ""}
                </option>
              </select>
            </div>
            <div className="song-params" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
                <input type="checkbox" checked={voiceOnly} onChange={(e) => setVoiceOnly(e.target.checked)} disabled={busy || generating} />
                Voice only
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
                <input type="checkbox" checked={skipTts} onChange={(e) => setSkipTts(e.target.checked)} disabled={busy || generating} />
                Skip TTS
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
                <input type="checkbox" checked={noStitch} onChange={(e) => setNoStitch(e.target.checked)} disabled={busy || generating} />
                No re-stitch
              </label>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Voice only = generate voice audio without mouth sync · Skip TTS = reuse existing
              voice files · No re-stitch = sync clips but leave the final cut alone (merge later with Stitch).
            </p>
            {cfg && (
              <>
                <div className="section-label">Dialogue beats ({dlgBeats.length})</div>
                {dlgBeats.length === 0 ? (
                  <p className="muted">No dialogue lines in this project — add speaker: line dialogue to its beats first.</p>
                ) : (
                  <ol className="song-list">
                    {dlgBeats.map(({ b, n }) => (
                      <li key={n} className="song-item">
                        <div className="song-item-head">
                          <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
                            <input type="checkbox" checked={checked.has(n)} onChange={() => toggleBeat(n)} disabled={busy || generating} aria-label={`Select beat ${n}`} />
                            <button
                              type="button"
                              className="pill pill-btn"
                              onClick={() => openDialogueEditor(n)}
                              disabled={busy || generating}
                              title={`Edit Scene ${n} dialogue`}
                              aria-label={`Edit Scene ${n} dialogue`}
                            >
                              {n}
                            </button>
                          </label>
                          <span className="song-file" title={b.title}>{b.title || `Beat ${n}`}</span>
                        </div>
                        <StagePills status={dlgStatus?.beats?.find((s) => s.beat === n) ?? null} />
                        <p className="muted" style={{ margin: "4px 0 0" }}>
                          {(Array.isArray(b.dialogue) ? b.dialogue : []).filter((d) => d && String(d.line || "").trim()).map((d, i, arr) => (
                            <span key={i}><b>{d.speaker || "voice"}</b>: {d.line}{i < arr.length - 1 ? <br /> : null}</span>
                          ))}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </div>
          {error && (
            <p className="err-text" role="alert">
              {error}
            </p>
          )}
          {generating && (
            <div className="song-run" role="status" aria-label="Lip-sync progress">
              <p className="muted">Voicing + lip-syncing ({lipsync === "musetalk-comfy" ? "MuseTalk on ComfyUI" : "Wav2Lip takes a while per beat"})…</p>
              {runLog && <pre ref={logRef} className="run-log">{runLog}</pre>}
            </div>
          )}
        </Collapse>
      </section>

      <section className={`card song-list-card${clipsCollapsed ? " collapsed" : ""}`} aria-label="Lip-synced clips">
        <div className="card-head">
          <h2>Lip-Synced Clips</h2>
          <span className="spacer" />
          <button
            type="button"
            className="ghost"
            onClick={() => name.trim() && void refreshOutputs(name.trim(), engine, format)}
            disabled={outputsLoading || !name.trim()}
            title="Reload the clip list"
          >
            {outputsLoading ? "Loading…" : "Refresh"}
          </button>
          <button
            className="icon-btn"
            onClick={toggleClipsCollapsed}
            title={clipsCollapsed ? "Show lip-synced clips" : "Hide lip-synced clips"}
            aria-label={clipsCollapsed ? "Show lip-synced clips" : "Hide lip-synced clips"}
            aria-expanded={!clipsCollapsed}
          >
            <IconPanel size={15} />
          </button>
        </div>
        <Collapse open={!clipsCollapsed}>
          {!name.trim() ? (
            <p className="muted">Pick a project above to see its lip-synced takes.</p>
          ) : outputsLoading && !outputs ? (
            <p className="muted"><Spinner size={13} /> Loading clips…</p>
          ) : dlgBeats.length === 0 ? (
            <p className="muted">No dialogue beats — run the pass above and synced takes appear here.</p>
          ) : (
            <ol className="song-list">
              {dlgBeats.map(({ b, n }) => {
                const clip = outputs?.mains?.beats?.[String(n)]?.clip ?? null;
                const wavs = wavFor(n);
                return (
                  <li key={n} className="song-item">
                    <div className="song-item-head">
                      <button
                        type="button"
                        className="pill pill-btn"
                        onClick={() => openDialogueEditor(n)}
                        disabled={busy || generating}
                        title={`Edit Scene ${n} dialogue`}
                        aria-label={`Edit Scene ${n} dialogue`}
                      >
                        {n}
                      </button>
                      <span className="song-file" title={b.title}>{b.title || `Beat ${n}`}</span>
                      <span className="spacer" />
                      {clip && (
                        <a className="ghost" href={outputUrl(dir, clip)} download={clip} title={`Download ${clip}`}>
                          Download
                        </a>
                      )}
                    </div>
                    {clip ? (
                      <video controls preload="metadata" src={outputUrl(dir, clip)} className="song-player" style={{ width: "100%" }} />
                    ) : (
                      <p className="muted" style={{ margin: "4px 0 0" }}>No synced take yet — run the pass above.</p>
                    )}
                    {wavs.map((w) => (
                      <div key={w} className="song-item-head" style={{ marginTop: 6 }}>
                        <span className="muted" title={w}>🎙 {w}</span>
                        <span className="spacer" />
                        <a className="ghost" href={outputUrl(dir, w)} download={w} title={`Download ${w}`}>
                          Voice
                        </a>
                      </div>
                    ))}
                    {wavs.length > 0 && (
                      <audio controls preload="none" src={outputUrl(dir, wavs[0])} className="song-player" />
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </Collapse>
      </section>

      {/* Scene dialogue editor: opened by clicking a beat number. Shows the
          scene number + its dialogue lines for editing (same speaker: line
          format as everywhere else). Saving writes a new scenario version
          and deletes the stale voice files, so the beat returns to PENDING
          until it is re-voiced + re-synced. */}
      {editingBeat != null && seq[editingBeat - 1] && (
        <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label={`Edit Scene ${editingBeat} dialogue`} onClick={() => { if (!savingDlg) setEditingBeat(null); }}>
          <div className="dlg-box char-popup" onClick={(e) => e.stopPropagation()}>
            <h3 className="dlg-title">
              🎙 Scene {editingBeat} · Dialogue
            </h3>
            <p className="dlg-message">
              One line per dialogue line as <b>speaker: line</b> (optional expression as{" "}
              <b>speaker (expression): line</b> — shapes voice pitch/rate, clip length and lip-sync).
              Saving deletes this scene's voice files; re-run LipSync afterwards.
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label>Shot title</label>
                <input
                  value={seq[editingBeat - 1].title || `Beat ${editingBeat}`}
                  disabled
                  title="Scene title (rename it in the Story Board)"
                />
              </div>
              <div style={{ flex: "0 0 30%", minWidth: 0 }}>
                <label title="Empty keeps the current length">Clip length (sec)</label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={dlgDuration}
                  placeholder={String(seq[editingBeat - 1].duration ?? 3)}
                  disabled={savingDlg}
                  onChange={(e) => setDlgDuration(e.target.value)}
                />
              </div>
            </div>
            <label style={{ marginTop: 8 }}>Dialogue · Scene {editingBeat} (empty = silent scene)</label>
            <textarea
              rows={6}
              value={dlgText}
              maxLength={5000}
              placeholder={"chiku (wide smile): नमस्ते! मैं चीकू हूँ।\nshera (stern): कौन है वहाँ?"}
              disabled={savingDlg}
              onChange={(e) => setDlgText(e.target.value)}
            />
            {dlgError && <p className="err-text" role="alert">{dlgError}</p>}
            <div className="dlg-actions" style={{ marginTop: 12 }}>
              <button className="ghost" onClick={() => setEditingBeat(null)} disabled={savingDlg} title="Close without saving">
                Cancel
              </button>
              <button className="primary" onClick={() => void saveDialogue()} disabled={savingDlg} title="Save dialogue as a new scenario version">
                {savingDlg ? "Saving…" : "Save dialogue"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
