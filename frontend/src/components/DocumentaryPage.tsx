import { Fragment, useCallback, useEffect, useState } from "react";
import {
  alertServiceError, docApprove, docBoard, docBoards, docCreate, docDelete, docExport, docPlan,
  docStatus, docTimeline, docUpdate, saveScenario,
  type DocAnalysis, type DocBoard, type DocBoardMeta, type DocShot,
} from "../api";
import { useDialog } from "./Dialog";
import { useQuietMs } from "./useIdleFollow";
import { IconCheck, IconClapper, IconClipboard, IconEye, IconFilm, IconFolder, IconImage, IconLayers, IconLock, IconMic, IconPlay, IconPlus, IconRefresh, IconScissors, IconSearch, IconSparkles, IconStar, IconTrash, IconUpload, IconUser, Spinner } from "./Icons";

type Tab = "create" | "raw" | "understanding" | "characters" | "dialogue" | "narration" | "emotion" | "location" | "action" | "visual" | "scene" | "shot" | "continuity" | "image" | "video" | "timeline";

// Icon per pipeline tab, rendered left of the label inside each tab button.
const TAB_ICONS: Record<string, (p: { size?: number }) => JSX.Element> = {
  create: IconPlus,
  understanding: IconSearch,
  characters: IconUser,
  dialogue: IconMic,
  narration: IconClipboard,
  emotion: IconStar,
  location: IconFolder,
  action: IconPlay,
  visual: IconEye,
  scene: IconClapper,
  shot: IconScissors,
  continuity: IconLock,
  image: IconImage,
  video: IconFilm,
  timeline: IconLayers,
};


// Per-stage tabs for the Analysis pipeline, left to right (RAW POEM first,
// Final Timeline last). Documentary mode only.
const STAGE_ORDER = ["raw", "understanding", "characters", "dialogue", "narration", "emotion",
  "location", "action", "visual", "scene", "shot", "continuity", "image", "video", "timeline"];
const STAGE_LABELS: Record<string, string> = {
  raw: "Raw Poem", understanding: "Story Understanding", characters: "Character Detection",
  dialogue: "Dialogue Detection", narration: "Narration Detection", emotion: "Emotion & Mood",
  location: "Location / Time", action: "Action Detection", visual: "Visual Meaning",
  scene: "Scene Planning", shot: "Shot Planning", continuity: "Character Continuity",
  image: "Image Prompts", video: "Video Prompts", timeline: "Final Timeline",
};
// Idle window before an armed stage Approve auto-approves (20s of
// uninterrupted quiet; any activity restarts the clock).
const APPROVE_IDLE_MS = 20000;
const fmtClock = (s: number | null | undefined) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

// Every button in the Create Document section maps to the tab section(s) its
// work fills. While that button's operation is in flight (busy === label),
// each target tab shows live progress instead of a stale empty state.
const BUSY_TARGET_TABS: Record<string, string[]> = {
  Creating: ["create"],
  Planning: ["understanding", "characters", "dialogue", "narration", "emotion",
    "location", "action", "visual", "scene", "shot", "continuity", "image", "video", "timeline"],
  Deleting: ["create"],
  Approving: ["timeline"],
  Exporting: ["timeline"],
  Saving: ["shot"],
};
const busyTargets = (busy: string | null): string[] => {
  if (!busy) return [];
  if (BUSY_TARGET_TABS[busy]) return BUSY_TARGET_TABS[busy];
  // "Saving approval" and any future per-stage save affect the open stage tab;
  // the caller passes the open tab so it still shows progress.
  if (/saving/i.test(busy)) return ["__open__"];
  return [];
};
// Short tab-pill label per operation.
const busyTabLabel = (busy: string, tabKey: string): string => {
  if (busy === "Planning") return tabKey === "understanding" ? "understanding…" : "queued…";
  if (busy === "Creating") return "creating…";
  if (busy === "Deleting") return "deleting…";
  if (busy === "Approving") return "approving…";
  if (busy === "Exporting") return "exporting…";
  if (/saving/i.test(busy)) return "saving…";
  return "working…";
};
// Human-readable progress title per operation (Create section + stage banners).
const busyTitle = (busy: string): string => {
  if (busy === "Creating") return "Creating documentary…";
  if (busy === "Planning") return "Planning documentary…";
  if (busy === "Deleting") return "Deleting documentary…";
  if (busy === "Approving") return "Approving documentary…";
  if (busy === "Exporting") return "Exporting manifest…";
  if (/saving/i.test(busy)) return `${busy}…`;
  return `${busy}…`;
};
const busyDetail = (busy: string): string => {
  if (busy === "Creating") return "Detecting topic, duration and brief fields from the pasted text. The new document opens automatically — no need to refresh.";
  if (busy === "Planning") return "Step 1/3 Story Understanding → Step 2/3 bible → Step 3/3 chapter shots. Each stage tab fills in as its step lands.";
  if (busy === "Deleting") return "Removing the board and its files. The list refreshes automatically.";
  if (busy === "Approving") return "Flattening shots to a standard scenario and handing it to the workspace pipeline.";
  if (busy === "Exporting") return "Writing the documentary manifest (subtitles, timeline, chapters) next to the outputs folder.";
  if (/saving/i.test(busy)) return "Persisting edits to the board. The tab refreshes automatically.";
  return "Working — the affected tab updates automatically.";
};

// One pipeline stage tab: current execution data, past executions, and the
// per-stage Approve button (20s idle auto-approve). Documentary mode only.
// `busy` is the in-flight Create-section operation (Creating/Planning/…);
// when it targets this stage the tab shows live progress instead of a stale
// "plan first" empty state. `planning` is kept as a derived convenience.
function DocStagePanel({ stageKey, stage, board, analysis, timelineTotal, shots, history, approval, pending, remainSec, planning, busy, busySince, onApprove, onCancel, onUnapprove }: {
  stageKey: string;
  stage: { key: string; label: string; done: boolean; detail: string };
  board: DocBoard;
  analysis: DocAnalysis | null;
  timelineTotal: number | null;
  shots: import("../api").DocShot[];
  history: { at: string; source: string; stages: { key: string; done: boolean; detail: string }[] }[];
  approval: { approved: boolean; at: string | null; auto: boolean } | null;
  pending: boolean;
  remainSec: number;
  planning: boolean;
  busy: string | null;
  busySince: number | null;
  onApprove: () => void;
  onCancel: () => void;
  onUnapprove: () => void;
}) {
  const past = history
    .map((h) => ({ at: h.at, source: h.source, st: (h.stages || []).find((s) => s.key === stageKey) }))
    .filter((p) => p.st);
  const seqs = board.chapters.flatMap((c) => c.sequences);
  const list = (items: string[]) => items.length ? items : ["-"];
  let body: JSX.Element | null = null;
  if (stageKey === "raw") {
    body = (<>
      <p style={{ margin: "4px 0" }}><strong>Topic:</strong> {board.brief.topic || "-"}</p>
      <p style={{ margin: "4px 0" }}><strong>Events:</strong> {board.brief.events || "-"}</p>
      <p className="muted">Source material ({(board.brief.sourceMaterial || "").split(/\s+/).filter(Boolean).length} words):</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{board.brief.sourceMaterial || "(no pasted poem/story - topic brief only)"}</pre>
    </>);
  } else if (stageKey === "understanding") {
    body = analysis?.understanding?.summary ? (<>
      <p style={{ margin: "4px 0" }}>{analysis.understanding.summary}</p>
      <p className="muted">Themes: {list(analysis.understanding.themes).join(", ")}</p>
      <p className="muted">Arc: {list(analysis.understanding.narrative_arc).join(" - ")}</p>
    </>) : planning ? (<>
      <p style={{ margin: "4px 0", display: "flex", alignItems: "center", gap: 8 }}>
        <Spinner size={14} /> <strong>Story Understanding is in progress…</strong>
      </p>
      <p className="muted" style={{ margin: "4px 0" }}>
        Reading the source material — extracting the summary, themes and narrative arc.
        This is step 1 of planning (then bible, then chapter shots). The results appear
        here automatically — no need to refresh.
      </p>
      <ul className="muted" style={{ margin: "6px 0 0 18px", padding: 0 }}>
        <li>Reading source material…</li>
        <li>Detecting themes…</li>
        <li>Mapping narrative arc…</li>
      </ul>
    </>) : (<p className="muted">No understanding yet - plan first.</p>);
  } else if (stageKey === "characters") {
    body = (<>
      {(analysis?.characters_detected ?? []).map((c, i) => (
        <p key={i} style={{ margin: "2px 0" }}>{c.name} <span className="muted">· {c.role} · {c.mentions} mentions</span></p>
      ))}
      {!analysis?.characters_detected?.length && <p className="muted">No detection yet - plan first.</p>}
      <p className="muted">Bible: {board.characters.map((c) => String((c as Record<string, unknown>).name ?? "")).filter(Boolean).join(", ") || "-"}</p>
    </>);
  } else if (stageKey === "dialogue") {
    const withDlg = shots.filter((s) => (s.dialogue_lines ?? []).length > 0);
    body = (<>
      {(analysis?.dialogues ?? []).slice(0, 20).map((d, i) => (
        <p key={i} style={{ margin: "2px 0" }}><strong>{d.speaker || "voice"}:</strong> {d.line}</p>
      ))}
      {!analysis?.dialogues?.length && <p className="muted">No spoken lines detected in the source.</p>}
      <p className="muted">{withDlg.length} shot(s) carry dialogue_lines.</p>
    </>);
  } else if (stageKey === "narration") {
    body = (<>
      {(analysis?.narrations ?? []).slice(0, 10).map((n, i) => (
        <p key={i} style={{ margin: "4px 0" }}><span className="muted">[{n.voice}]</span> {n.text.slice(0, 220)}{n.text.length > 220 ? " ..." : ""}</p>
      ))}
      {!analysis?.narrations?.length && <p className="muted">No narration blocks detected.</p>}
      <p className="muted">{seqs.filter((q) => q.narration).length}/{seqs.length} sequences narrated · {shots.filter((s) => s.narration_lines.length).length}/{shots.length} shots voiced.</p>
    </>);
  } else if (stageKey === "emotion") {
    body = (<>
      {(analysis?.emotions ?? []).map((e, i) => (
        <p key={i} style={{ margin: "2px 0" }}><strong>{e.emotion}</strong> <span className="muted">· {e.mood} · {e.intensity} · {e.scope}</span></p>
      ))}
      {!analysis?.emotions?.length && <p className="muted">No emotion analysis yet - plan first.</p>}
    </>);
  } else if (stageKey === "location") {
    body = (<>
      {(analysis?.locations_times ?? []).map((l, i) => (
        <p key={i} style={{ margin: "2px 0" }}><strong>{l.location}</strong> <span className="muted">· {l.time_of_day} · {l.time_period}{l.environment ? " · " + l.environment : ""}</span></p>
      ))}
      {!analysis?.locations_times?.length && <p className="muted">No place/time detection yet - plan first.</p>}
      <p className="muted">Bible places: {board.locations.map((l) => String((l as Record<string, unknown>).name ?? "")).filter(Boolean).join(", ") || "-"}</p>
    </>);
  } else if (stageKey === "action") {
    body = (<>
      {(analysis?.actions ?? []).slice(0, 20).map((a, i) => (
        <p key={i} style={{ margin: "2px 0" }}><strong>{a.action}</strong> <span className="muted">{a.actor || ""} {a.object || ""} - {a.context}</span></p>
      ))}
      {!analysis?.actions?.length && <p className="muted">No actions detected in the source.</p>}
    </>);
  } else if (stageKey === "visual") {
    body = (<>
      {(analysis?.visual_meanings ?? []).map((v, i) => (
        <p key={i} style={{ margin: "4px 0" }}><strong>{v.subject}</strong> <span className="muted">({v.literal})</span> = {v.symbolic_meaning}</p>
      ))}
      {!analysis?.visual_meanings?.length && <p className="muted">No visual meanings extracted yet - plan first.</p>}
    </>);
  } else if (stageKey === "scene") {
    body = (<>
      {board.chapters.map((c) => (
        <div key={c.chapter_number} style={{ margin: "6px 0" }}>
          <strong>Ch{c.chapter_number}: {c.title}</strong> <span className="muted">· {c.sequences.length} sequences</span>
          {c.sequences.map((q) => (
            <p key={q.sequence_id} className="muted" style={{ margin: "2px 0 2px 12px" }}>{q.sequence_id} {q.title} - {q.purpose || q.visual_goal} ({q.duration_seconds}s, {q.shots.length} shots)</p>
          ))}
        </div>
      ))}
      {!board.chapters.length && <p className="muted">No scenes planned yet.</p>}
    </>);
  } else if (stageKey === "shot") {
    body = (<>
      {shots.map((s) => (
        <p key={s.shot_id} className="muted" style={{ margin: "2px 0" }}>
          #{s.global_index} {s.shot_id} · {s.title} · {s.duration_seconds}s
          {s.emotion ? " · mood " + s.emotion : ""}{s.time_of_day ? " · " + s.time_of_day : ""}{(s.actions ?? []).length ? " · " + (s.actions ?? []).join(", ") : ""}{(s.dialogue_lines ?? []).length ? " · dlg " + (s.dialogue_lines ?? []).length : ""}
        </p>
      ))}
      {!shots.length && <p className="muted">No shots planned yet.</p>}
    </>);
  } else if (stageKey === "continuity") {
    body = (<>
      {board.characters.map((c, i) => (
        <details key={String((c as Record<string, unknown>).character_id ?? i)} style={{ margin: "4px 0" }}>
          <summary>{String((c as Record<string, unknown>).name ?? "Character " + (i + 1))} - {((c as Record<string, unknown>).consistency_rules as unknown[] ?? []).length} rules</summary>
          <ul>{(((c as Record<string, unknown>).consistency_rules as unknown[]) ?? []).map((r, k) => (<li key={k} className="muted">{String(r)}</li>))}</ul>
        </details>
      ))}
      {!board.characters.length && <p className="muted">No character bible yet.</p>}
    </>);
  } else if (stageKey === "image") {
    body = (<>
      {shots.map((s) => (
        <details key={s.shot_id} style={{ margin: "4px 0" }}>
          <summary>#{s.global_index} {s.shot_id} - {s.title}</summary>
          <p className="muted" style={{ margin: "2px 0 2px 12px" }}>{s.flux_prompt || "(no image prompt)"}</p>
        </details>
      ))}
      {!shots.length && <p className="muted">No image prompts yet.</p>}
    </>);
  } else if (stageKey === "video") {
    body = (<>
      {shots.map((s) => (
        <details key={s.shot_id} style={{ margin: "4px 0" }}>
          <summary>#{s.global_index} {s.shot_id} - {s.title}</summary>
          <p className="muted" style={{ margin: "2px 0 2px 12px" }}>{s.ltx_prompt || s.motion || "(no video prompt)"}</p>
        </details>
      ))}
      {!shots.length && <p className="muted">No video prompts yet.</p>}
    </>);
  } else if (stageKey === "timeline") {
    body = (<>
      <p><strong>{board.brief.title}</strong> - {timelineTotal != null ? Math.floor(timelineTotal / 60) + ":" + String(Math.round(timelineTotal % 60)).padStart(2, "0") : "-"} target {Math.floor(board.brief.targetSeconds / 60)}:{String(board.brief.targetSeconds % 60).padStart(2, "0")}</p>
      {board.chapters.map((c) => (
        <p key={c.chapter_number} className="muted" style={{ margin: "2px 0" }}>
          Ch{c.chapter_number} {c.title} - {c.sequences.reduce((a, q) => a + q.shots.length, 0)} shots
        </p>
      ))}
    </>);
  }
  // Any Create-section operation targeting this stage shows its progress here.
  // "__open__" covers per-stage saves whose tab isn't known by label.
  const targets = busyTargets(busy);
  const activeHere = !!busy && !stage.done &&
    (targets.includes(stageKey) || (targets.includes("__open__")));
  const activeBanner = activeHere ? (
    <div
      className="row"
      style={{ gap: 8, alignItems: "center", margin: "8px 0", padding: "8px 10px", border: "1px solid var(--accent-line)", borderRadius: 8 }}
      role="status"
      aria-live="polite"
      aria-label={busy === "Planning" && stageKey === "understanding" ? "Story Understanding is in progress" : `${busyTitle(busy)} ${stage.label}`}
    >
      <Spinner size={14} />
      <span>
        {busy === "Planning" && stageKey === "understanding"
          ? (<><strong>Story Understanding is in progress…</strong> <span className="muted">analyzing source → themes → arc (step 1 of planning)</span></>)
          : busy === "Planning"
            ? (<><strong>Planning in progress…</strong> <span className="muted">Story Understanding runs first — this stage fills in after it</span></>)
            : (<><strong>{busyTitle(busy)}</strong> <span className="muted">{busyDetail(busy)}</span></>)}
      </span>
      {busySince != null && (
        <span className="muted">· {Math.max(0, Math.round((Date.now() - busySince) / 1000))}s elapsed</span>
      )}
    </div>
  ) : null;
  return (
    <div className="card" style={{ margin: "8px 0", padding: 10 }} role="tabpanel" aria-label={stage.label}>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>{stage.label}</strong>
        {activeHere
          ? <span className="pill running"><Spinner size={11} /> {busyTabLabel(busy!, stageKey)}</span>
          : <span className={"pill" + (stage.done ? " ok" : "")}>{stage.done ? "done" : "pending"}</span>}
        <span className="muted">{stage.detail}</span>
        <span className="spacer" />
        {approval?.approved
          ? (<>
            <span className="pill ok" title={approval.at ?? ""}>{approval.auto ? "auto-approved" : "approved"}</span>
            <button className="btn sm" onClick={onUnapprove} title="Revoke this stage approval">Unapprove</button>
          </>)
          : pending
            ? (<>
              <span className="pill running" title="Stay idle - any activity restarts the 20s clock">auto-approving in {remainSec}s…</span>
              <button className="btn sm" onClick={onCancel} title="Cancel the pending approval">Cancel</button>
            </>)
            : (<button className="btn sm primary" onClick={onApprove} title="Arm approval - auto-approves after 20 quiet seconds">Approve</button>)}
      </div>
      {pending && (
        <p className="muted" style={{ margin: "6px 0" }}>
          Waiting for 20 idle seconds… any pointer, key, wheel, touch or scroll activity restarts the clock.
        </p>
      )}
      {activeBanner}
      <div style={{ marginTop: 8 }}>{body}</div>
      <details style={{ marginTop: 8 }}>
        <summary>Past executions ({past.length})</summary>
        {past.length === 0 && <p className="muted">No past executions yet - re-running Plan stores a snapshot here.</p>}
        {past.slice(0, 10).map((p, i) => (
          <p key={i} className="muted" style={{ margin: "2px 0 2px 12px" }}>
            {p.at ? new Date(p.at).toLocaleString() : "-"} · {p.source} · {p.st ? (p.st.done ? "done" : "pending") : "-"} · {p.st?.detail ?? "-"}
          </p>
        ))}
      </details>
    </div>
  );
}

export default function DocumentaryPage({ onOpenProject, onProjectsChanged }: {
  onOpenProject?: (name: string) => void;
  onProjectsChanged?: () => void;
}) {
  const dialog = useDialog();
  const [boards, setBoards] = useState<DocBoardMeta[]>([]);
  const [board, setBoard] = useState<DocBoard | null>(null);
  const [tab, setTab] = useState<Tab>("create");
  const [busy, setBusy] = useState<string | null>(null);
  const [busySince, setBusySince] = useState<number | null>(null);
  // Re-render tick so the planning elapsed counters stay live.
  const [, setPlanTick] = useState(0);
  const planning = busy === "Planning";
  const [status, setStatus] = useState<{ pct: number; ready: number; shots: number; byStatus: Record<string, number>; status: string } | null>(null);
  const [timeline, setTimeline] = useState<{ total_seconds: number; chapters: { chapter_number: number; title: string; duration_seconds: number; sequences: { sequence_id: string; title: string; shots: { shot_id: string; global_index: number; title: string; duration_seconds: number }[] }[] }[] } | null>(null);
  const [openCh, setOpenCh] = useState<Record<number, boolean>>({ 1: true });
  // Stage-tab selection inside the Analysis tab ("overview" = checklist).
  // Armed stage approval: counts down APPROVE_IDLE_MS of quiet, then auto
  // approves (persisted). Page-level so switching stage tabs never loses it.
  const [pendingStage, setPendingStage] = useState<string | null>(null);
  const { idle: approveIdle, quietMs } = useQuietMs(APPROVE_IDLE_MS);

  // Brief form (§5 defaults).
  const [title, setTitle] = useState("");
  const [sourceMaterial, setSourceMaterial] = useState("");
  const [instructions, setInstructions] = useState("");
  const refreshList = useCallback(async () => {
    try { setBoards(await docBoards()); } catch { /* keep old list */ }
  }, []);
  useEffect(() => { refreshList().catch(() => {}); }, [refreshList]);

  const loadBoard = useCallback(async (id: string) => {
    const b = await docBoard(id);
    setBoard(b);
    try {
      const t = await docTimeline(id);
      setTimeline(t as typeof timeline);
    } catch { setTimeline(null); }
  }, []);

  // Live status poll (every 5s while a board is open).
  useEffect(() => {
    if (!board) { setStatus(null); return; }
    let stop = false;
    const poll = async () => {
      try {
        const s = await docStatus(board.id);
        if (!stop) setStatus(s);
      } catch { /* transient */ }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [board?.id]);

  // 1s tick while any operation runs so elapsed counters stay live.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setPlanTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // Live board refresh while planning: the server writes the board after
  // TASK 0/3 (analysis) and per chapter, so polling surfaces Story
  // Understanding the moment it lands instead of only at the very end.
  useEffect(() => {
    if (!planning || !board) return;
    const id = board.id;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const fresh = await docBoard(id);
        if (!stop) setBoard(fresh);
      } catch { /* transient — the final POST still delivers */ }
    }, 4000);
    return () => { stop = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planning, board?.id]);

  // Idle auto-approve: an armed stage lands 20 quiet seconds after arming
  // (any pointer/key/wheel/touch/scroll activity restarts the clock in the
  // hook, so this only fires after 20 uninterrupted idle seconds).
  useEffect(() => {
    if (!pendingStage || !board || !approveIdle) return;
    const key = pendingStage;
    setPendingStage(null);
    const next = {
      ...(board.stage_approvals ?? {}),
      [key]: { approved: true, at: new Date().toISOString(), auto: true },
    };
    docUpdate(board.id, { stageApprovals: next }).then(setBoard).catch((e) => {
      void dialog.alert(e instanceof Error ? e.message : String(e), { title: "Stage approval failed", tone: "error" });
    });
    // board/dialog intentionally stable while the user is idle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStage, approveIdle]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setBusySince(Date.now());
    try { await fn(); } catch (e) {
      // Down LLM/ComfyUI APIs pop their dedicated offline alert window;
      // anything else keeps the generic failure alert.
      const shown = await alertServiceError(e, dialog, label);
      if (!shown) {
        await dialog.alert(e instanceof Error ? e.message : String(e), { title: `${label} failed`, tone: "error" });
      }
    } finally { setBusy(null); setBusySince(null); }
  };

  const handleCreate = () => run("Creating", async () => {
    // Only the title is typed and the story pasted — topic, duration and
    // everything else auto-fill from the text at create time.
    const b = await docCreate({
      title: title.trim(),
      sourceMaterial, instructions,
      language: "", tone: "", audience: "", visualStyle: "", narrationStyle: "",
      narrationVoice: "", musicStyle: "", sourceType: "", characters: "", events: "", locations: "",
    });
    await refreshList();
    await loadBoard(b.id);
  });

  const handlePlan = () => board && run("Planning", async () => {
    const b = await docPlan(board.id);
    setBoard(b);
    // The server falls back to a heuristic plan when the LLM is down, so a
    // "successful" plan with heuristic analysis still means API offline.
    if ((b.analysis as DocAnalysis | null | undefined)?.source === "heuristic") {
      await dialog.alert(
        "Planning needs the AI service (LM Studio / llama-server), but it is unreachable — " +
          "this plan was built with the offline heuristic fallback (no AI understanding, " +
          "detection or enrichment). Start LM Studio with a model loaded, check LLM_BASE, " +
          "then Plan again for the full AI result. Live status: the topbar pills / GET /api/health.",
        { title: "LLM API offline", tone: "error" },
      );
    }
    try { setTimeline(await docTimeline(b.id) as typeof timeline); } catch { /* ignore */ }
    await refreshList();
    setTab("shot");
  });

  const handleApprove = () => board && run("Approving", async () => {
    const r = await docApprove(board.id);
    // Existing pipeline handoff: persist via saveScenario, then open workspace.
    await saveScenario(r.name, r.config);
    onProjectsChanged?.();
    const fresh = await docBoard(board.id);
    setBoard(fresh);
    await dialog.alert(
      `Approved ${r.shots} shots (~${fmtClock(r.narrationSeconds)} narration) as project "${r.name}".\nGenerate images/videos with the existing workspace pipeline (Flux → LTX/Wan, TTS, music, lip-sync), then stitch — resume and versioning keep working per shot.`,
      { title: "Documentary approved", tone: "success" });
    if (onOpenProject) onOpenProject(r.name);
  });

  const setShot = (shot_id: string, patch: Record<string, unknown>) => board && run("Saving", async () => {
    const b = await docUpdate(board.id, { shot: { shot_id, ...patch } });
    setBoard(b);
  });

  const handleExport = () => board && run("Exporting", async () => {
    // Pass the linked project/outputs folder so subtitles.srt +
    // documentary.json are written next to the generated media (when it
    // exists); without generation yet, the manifest still returns.
    const r = await docExport(board.id, board.scenarioName ?? undefined);
    await dialog.alert(
      `Final: ${r.documentary_final}\nChapters: ${r.chapters.join(", ") || "—"}\nNarration: ${r.narration_audio}\nMusic: ${r.music_dir}\nSubtitles: ${r.subtitles}\nTotal: ${fmtClock(r.total_seconds)}${r.wrote.length ? `\nWrote: ${r.wrote.join(", ")}` : "\n(Tip: approve + generate first — files are written next to the outputs folder.)"}`,
      { title: "Documentary export", tone: "success" });
  });

  const totalShots = board ? board.chapters.reduce((a, c) => a + c.sequences.reduce((x, q) => x + q.shots.length, 0), 0) : 0;
  // Dialogue-driven clock: per-line ~2.17 wps + 0.35s per inter-line gap
  // (DOC_LINE_GAP_SECONDS — same seam the TTS stitching uses).
  const lineSecs = (lines: string[]) =>
    lines.map((x) => String(x).split(/\s+/).filter(Boolean).length / 2.17).reduce((a, w) => a + w, 0);
  const shotSecs = (s: DocShot) => {
    const ls = [...s.narration_lines, ...(s.dialogue_lines ?? []).map((d) => {
      const m = String(d).match(/^[^:()]{1,40}:\s*(.{1,500})$/);
      return m ? m[1] : String(d);
    })];
    return lineSecs(ls) + (ls.length > 1 ? 0.35 * (ls.length - 1) : 0);
  };
  const narrationSec = board ? board.chapters.reduce((a, c) => a + c.sequences.reduce((x, q) =>
    x + q.shots.reduce((y, s) => y + shotSecs(s), 0), 0), 0) : 0;
  const allShots = board ? board.chapters.flatMap((c) => c.sequences.flatMap((q) => q.shots)) : [];
  // 15-stage source pipeline (RAW POEM → Final Timeline) status, derived
  // from the live board — Documentary mode only.
  const analysis: DocAnalysis | null = (board?.analysis ?? null) as DocAnalysis | null;
  const pipeStages: { key: string; label: string; done: boolean; detail: string }[] = board ? [
    { key: "raw", label: "Raw Poem / Source", done: !!(board.brief.sourceMaterial?.trim() || board.brief.topic?.trim()), detail: board.brief.sourceMaterial?.trim() ? `${board.brief.sourceMaterial.trim().split(/\s+/).length} words of source material` : "topic brief" },
    { key: "understanding", label: "Story Understanding", done: !!analysis?.understanding?.summary, detail: analysis?.understanding?.themes?.length ? `themes: ${analysis.understanding.themes.slice(0, 4).join(", ")}` : "runs with Plan" },
    { key: "characters", label: "Character Detection", done: board.characters.length > 0, detail: `${board.characters.length} in bible${analysis ? ` · ${analysis.characters_detected.length} detected` : ""}` },
    { key: "dialogue", label: "Dialogue Detection", done: (analysis?.dialogues?.length ?? 0) > 0 || allShots.some((s) => (s.dialogue_lines ?? []).length > 0), detail: `${analysis?.dialogues?.length ?? 0} detected · ${allShots.filter((s) => (s.dialogue_lines ?? []).length > 0).length} shots carry dialogue` },
    { key: "narration", label: "Narration Detection", done: (analysis?.narrations?.length ?? 0) > 0 || allShots.some((s) => s.narration_lines.length > 0), detail: `${fmtClock(narrationSec)} narration` },
    { key: "emotion", label: "Emotion & Mood Analysis", done: (analysis?.emotions?.length ?? 0) > 0, detail: analysis?.emotions?.length ? analysis.emotions.slice(0, 3).map((e) => `${e.emotion} (${e.mood})`).join(", ") : "runs with Plan" },
    { key: "location", label: "Location / Time Detection", done: board.locations.length > 0 || (analysis?.locations_times?.length ?? 0) > 0, detail: `${board.locations.length} places · ${analysis?.locations_times?.filter((l) => l.time_of_day && l.time_of_day !== "unspecified").length ?? 0} timed` },
    { key: "action", label: "Action Detection", done: (analysis?.actions?.length ?? 0) > 0, detail: `${analysis?.actions?.length ?? 0} actions` },
    { key: "visual", label: "Visual Meaning Extraction", done: (analysis?.visual_meanings?.length ?? 0) > 0, detail: `${analysis?.visual_meanings?.length ?? 0} symbols` },
    { key: "scene", label: "Scene Planning", done: board.chapters.some((c) => c.sequences.length > 0), detail: `${board.chapters.length} chapters` },
    { key: "shot", label: "Shot Planning", done: totalShots > 0, detail: `${totalShots} shots` },
    { key: "continuity", label: "Character Continuity", done: board.characters.some((c) => ((c as Record<string, unknown>).consistency_rules as unknown[] ?? []).length > 0), detail: "locked identities, verbatim reuse" },
    { key: "image", label: "Image Prompts", done: allShots.some((s) => s.flux_prompt?.trim()), detail: `${allShots.filter((s) => s.flux_prompt?.trim()).length}/${totalShots} flux prompts` },
    { key: "video", label: "Video Prompts", done: allShots.some((s) => (s.ltx_prompt || s.motion)?.trim()), detail: `${allShots.filter((s) => (s.ltx_prompt || s.motion)?.trim()).length}/${totalShots} motion prompts` },
    { key: "timeline", label: "Final Timeline", done: !!timeline && (timeline?.chapters?.length ?? 0) > 0, detail: timeline ? fmtClock(timeline.total_seconds) : "plan first" },
  ] : [];

  return (
    <div className="cmp doc-layout">
      <style>{`@media (max-width: 1100px) { .doc-layout > .card { grid-column: auto !important; grid-row: auto !important; } }`}</style>
      <div className="card" style={{ gridColumn: "1 / span 2", gridRow: "1", alignSelf: "start" }}>
          {(board || busy) && (
            <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
              <span className="muted">{busy ?? board?.status} · {fmtClock(timeline?.total_seconds ?? narrationSec)} / {fmtClock(board?.brief.targetSeconds ?? 0)} · {totalShots} shots</span>
              {busy && (
                <span className="pill running" role="status" aria-live="polite" title={`${busyTitle(busy)} ${busyDetail(busy)}`}>
                  <Spinner size={11} /> {busyTitle(busy).replace(/…$/, "")}…{busySince != null ? ` ${Math.max(0, Math.round((Date.now() - busySince) / 1000))}s` : ""}
                </span>
              )}
              {status && (
                <>
                  <span className="pill">{status.ready}/{status.shots} ready</span>
                  <span className="pill">{status.pct}%</span>
                  {Object.entries(status.byStatus).map(([k, v]) => (
                    <span key={k} className="pill muted">{k}: {v}</span>
                  ))}
                </>
              )}
            </div>
          )}
          <div className="doc-tabs doc-tabs-rows" role="tablist" aria-label="Documentary workflow">
            {(() => {
              const allTabs: { key: Tab; label: string }[] = [
                { key: "create", label: "Create Document" },
                ...STAGE_ORDER.filter((k) => k !== "raw").map((k) => ({ key: k as Tab, label: STAGE_LABELS[k] ?? k })),
              ];
              const split = Math.ceil(allTabs.length / 2);
              const rows = [allTabs.slice(0, split), allTabs.slice(split)];
              const renderTab = (t: { key: Tab; label: string }) => {
                const TabIcon = TAB_ICONS[t.key] ?? IconClipboard;
                if (t.key === "create") {
                  const createActive = !!busy && busyTargets(busy).includes("create");
                  return (
                    <button key="create" role="tab" aria-selected={tab === "create"}
                      className={`doc-tab${tab === "create" ? " active" : ""}`}
                      onClick={() => setTab("create")} title={createActive ? `${busyTitle(busy!)} ${busyDetail(busy!)}` : "Create a documentary brief"}>
                      <span className="doc-tab-label"><TabIcon size={12} />{t.label}{createActive ? " …" : ""}</span>
                      {createActive && <span className="doc-tab-state running">{busyTabLabel(busy!, "create")}</span>}
                    </button>
                  );
                }
                const st = pipeStages.find((x) => x.key === t.key);
                const ap = board ? (board.stage_approvals ?? {})[t.key] : undefined;
                const targets = busyTargets(busy);
                const activeHere = !!busy && !st?.done && !ap?.approved &&
                  (targets.includes(t.key) || (targets.includes("__open__") && tab === t.key));
                const stateCls = ap?.approved ? "approved" : st?.done ? "done" : activeHere ? "running" : "pending";
                const stateTxt = ap?.approved
                  ? (ap.auto ? "auto-approved ✓" : "approved ✓")
                  : st?.done ? "done ✓" : activeHere ? busyTabLabel(busy!, t.key) : "pending …";
                return (
                  <button key={t.key} role="tab" aria-selected={tab === t.key} disabled={!board}
                    className={"doc-tab" + (tab === t.key ? " active" : "") + (!board ? " disabled" : "")}
                    onClick={() => setTab(t.key)}
                    title={(st?.done ? "done" : "pending") + (ap?.approved ? (ap.auto ? " - auto-approved" : " - approved") : "") + (pendingStage === t.key ? " - approval pending" : "")}>
                    <span className="doc-tab-label"><TabIcon size={12} />{t.label}{pendingStage === t.key ? " …" : ""}</span>
                    <span className={`doc-tab-state ${stateCls}`}>{stateTxt}</span>
                  </button>
                );
              };
              return rows.map((rowTabs, ri) => (
                <div key={ri} className="doc-tabs-row" role="presentation">
                  {rowTabs.map((t, ti) => (
                    <Fragment key={t.key}>
                      {ti > 0 && <span className="doc-tab-arrow" aria-hidden="true">→</span>}
                      {renderTab(t)}
                    </Fragment>
                  ))}
                  {ri === 1 && (
                    <Fragment key="export">
                      <span className="doc-tab-arrow" aria-hidden="true">→</span>
                      <button key="export-btn" className="doc-tab doc-tab-export"
                        disabled={!board || busy != null}
                        onClick={handleExport}
                        title={board ? "Export documentary manifest" : "Create a document first"}>
                        <span className="doc-tab-label"><IconUpload size={12} />{busy === "Exporting" ? "Exporting…" : "Export"}</span>
                      </button>
                    </Fragment>
                  )}
                </div>
              ));
            })()}
          </div>

          {tab === "create" && (
            <div style={{ marginTop: 10 }}>
          <div className="card-head"><h3><IconClapper size={15} /> Create Document</h3></div>
          <p className="hint">Give it a title and paste the text - topic, duration and everything else fills automatically.</p>
          <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Enter documentary title…" /></label>
          <label>Source / story material<textarea value={sourceMaterial} onChange={(e) => setSourceMaterial(e.target.value)} rows={10} placeholder="Paste the full story, poem or documentary text here - topic, duration and everything else fills automatically…" /></label>
          <label>Special instructions<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} /></label>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn primary" disabled={busy != null || !title.trim()} onClick={handleCreate}>
              {busy === "Creating" ? <Spinner size={14} /> : <IconSparkles size={14} />} Create documentary
            </button>
            <button className="btn" disabled={!board || busy === "Planning"} onClick={handlePlan} title={!board ? "Create a document first" : "Generate chapters, shots and prompts for the open documentary"}>
              {busy === "Planning" ? <Spinner size={14} /> : <IconSparkles size={14} />} Plan documentary
            </button>
            <select aria-label="Open saved documentary" value={board?.id ?? ""} onChange={(e) => e.target.value && loadBoard(e.target.value).catch((err) => dialog.alert(err.message, { title: "Open failed", tone: "error" }))}>
              <option value="">Open saved… ({boards.length})</option>
              {boards.map((b) => <option key={b.id} value={b.id}>{b.title} · {b.status} · {b.shots} shots</option>)}
            </select>
            <button className="btn sm" onClick={() => refreshList()} title="Refresh list"><IconRefresh size={14} /></button>
            {board && (
              <button className="btn danger" disabled={busy != null} onClick={() => run("Deleting", async () => {
                await docDelete(board.id);
                setBoard(null); setTimeline(null); await refreshList(); setTab("create");
              })}>
                <IconTrash size={14} /> Delete
              </button>
            )}
          </div>
          {busy && (
            <div
              className="card"
              style={{ marginTop: 8, padding: 10, border: "1px solid var(--accent-line)" }}
              role="status"
              aria-live="polite"
              aria-label={`${busyTitle(busy)} progress`}
            >
              <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Spinner size={14} />
                <strong>{busyTitle(busy)}</strong>
                {busySince != null && (
                  <span className="muted">· {Math.max(0, Math.round((Date.now() - busySince) / 1000))}s elapsed</span>
                )}
                <span className="spacer" />
                {busy === "Planning" && board && (
                  <button className="btn sm" onClick={() => setTab("understanding")} title="Jump to the Story Understanding tab to watch live progress">
                    View Story Understanding →
                  </button>
                )}
                {busy === "Approving" && (
                  <button className="btn sm" onClick={() => setTab("timeline")} title="Jump to the Final Timeline tab to watch approval progress">
                    View Timeline →
                  </button>
                )}
                {busy === "Saving" && (
                  <button className="btn sm" onClick={() => setTab("shot")} title="Jump to the Shot Planning tab to watch save progress">
                    View Shots →
                  </button>
                )}
              </div>
              <p className="muted" style={{ margin: "6px 0 0" }}>{busyDetail(busy)}</p>
              {busy === "Planning" && (
                <ul className="muted" style={{ margin: "6px 0 0 18px", padding: 0 }}>
                  <li>Step 1/3 Story Understanding — reading source → themes → arc…</li>
                  <li>Step 2/3 bible — characters, locations, chapters…</li>
                  <li>Step 3/3 chapter shots — narration, prompts, timing…</li>
                </ul>
              )}
            </div>
          )}
          {board && (
            <div className="card" style={{ marginTop: 8, padding: 8 }} aria-label="Detected brief">
              <p className="muted" style={{ margin: "2px 0" }}>
                Detected: {fmtClock(board.brief.targetSeconds)} - {board.brief.topic || "-"} - {board.brief.language || "-"} - {board.brief.tone || "-"} - {board.brief.audience || "-"} - {board.brief.sourceType || "-"} - {board.brief.narrationVoice || "-"}
              </p>
              <p className="muted" style={{ margin: "2px 0" }}>Characters: {board.brief.characters || "-"}</p>
              <p className="muted" style={{ margin: "2px 0" }}>Locations: {board.brief.locations || "-"}</p>
              <p className="muted" style={{ margin: "2px 0" }}>Events: {board.brief.events || "-"}</p>
            </div>
          )}
            </div>
          )}
          {tab !== "create" && !board && (
            <p className="muted" style={{ marginTop: 10 }}>Create a document first - pick the Create Document tab.</p>
          )}
          {tab !== "create" && board && (
            <DocStagePanel
              stageKey={tab}
              stage={pipeStages.find((x) => x.key === tab) ?? { key: tab, label: STAGE_LABELS[tab] ?? tab, done: false, detail: "" }}
              board={board}
              analysis={analysis}
              timelineTotal={timeline?.total_seconds ?? null}
              shots={allShots}
              history={board.stage_history ?? []}
              approval={(board.stage_approvals ?? {})[tab] ?? null}
              pending={pendingStage === tab}
              remainSec={Math.max(0, Math.ceil((APPROVE_IDLE_MS - quietMs) / 1000))}
              planning={planning}
              busy={busy}
              busySince={busySince}
              onApprove={() => setPendingStage(tab)}
              onCancel={() => setPendingStage(null)}
              onUnapprove={() => run("Saving approval", async () => {
                const next = { ...(board.stage_approvals ?? {}) };
                delete next[tab];
                setBoard(await docUpdate(board.id, { stageApprovals: next }));
              })}
            />
          )}

          {tab === "scene" && board && (
            <div style={{ marginTop: 10 }}>
              <p className="muted">Chapters → sequences (narration-first + dialogue; shot timing derives from spoken lines, 3–15s each, dynamic count).</p>
              {board.chapters.map((c) => (
                <details key={c.chapter_number} open={c.chapter_number === 1}>
                  <summary>Chapter {c.chapter_number}: {c.title} — {fmtClock(c.target_duration_seconds)}</summary>
                  <p className="muted">{c.purpose}</p>
                  {c.sequences.map((q) => (
                    <div key={q.sequence_id} style={{ margin: "8px 0", paddingLeft: 8, borderLeft: "2px solid var(--accent-line)" }}>
                      <strong>{q.sequence_id} · {q.title}</strong>
                      <span className="muted"> · {q.pacing} · {fmtClock(q.duration_seconds)} · {q.shots.length} shots</span>
                      <p style={{ margin: "4px 0" }}>{q.purpose}</p>
                      <p className="muted" style={{ margin: "4px 0" }}>Visual goal: {q.visual_goal}</p>
                    </div>
                  ))}
                </details>
              ))}
              {!board.chapters.length && <p className="muted">No plan yet — click “Plan documentary”. Works offline via the heuristic planner; the LLM enriches it when available.</p>}
            </div>
          )}

          {tab === "narration" && board && (
            <div style={{ marginTop: 10 }}>
              {board.chapters.map((c) => (
                <div key={c.chapter_number}>
                  <h4>Chapter {c.chapter_number}: {c.title}</h4>
                  {c.sequences.map((q) => (
                    <div key={q.sequence_id} style={{ marginBottom: 8 }}>
                      <strong>{q.sequence_id} · {q.title}</strong>
                      <p style={{ margin: "4px 0" }}>{q.narration || <span className="muted">(no narration — plan first)</span>}</p>
                      {q.shots.map((s) => (
                        <p key={s.shot_id} className="muted" style={{ margin: "2px 0 2px 12px" }}>
                          #{s.global_index} {s.shot_id} ({s.duration_seconds}s): {s.narration_lines.join(" ") || "—"}
                          {(s.dialogue_lines ?? []).length > 0 && <> 💬 {(s.dialogue_lines ?? []).join(" ‖ ")}</>}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {tab === "characters" && board && (
            <div style={{ marginTop: 10 }}>
              {(board.characters as Record<string, unknown>[]).map((c, i) => (
                <details key={String((c as Record<string, unknown>).character_id ?? i)}>
                  <summary>{String((c as Record<string, unknown>).name ?? `Character ${i + 1}`)}{(c as Record<string, unknown>).role ? ` · ${String((c as Record<string, unknown>).role)}` : ""}{(c as Record<string, unknown>).voice ? ` · 🎙 ${String((c as Record<string, unknown>).voice)}` : ""}</summary>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(c, null, 2)}</pre>
                </details>
              ))}
              {!board.characters.length && <p className="muted">No character bible yet — plan first.</p>}
            </div>
          )}

          {tab === "location" && board && (
            <div style={{ marginTop: 10 }}>
              {(board.locations as Record<string, unknown>[]).map((l, i) => (
                <details key={String((l as Record<string, unknown>).location_id ?? i)}>
                  <summary>{String((l as Record<string, unknown>).name ?? `Location ${i + 1}`)}</summary>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(l, null, 2)}</pre>
                </details>
              ))}
              {!board.locations.length && <p className="muted">No location bible yet — plan first.</p>}
            </div>
          )}

          {tab === "shot" && board && (
            <div className="doc-shots" style={{ marginTop: 10 }}>
              {(() => {
                const shots = board.chapters.flatMap((c) => c.sequences.flatMap((q) => q.shots));
                const approved = shots.filter((s) => s.approved).length;
                const skipped = shots.filter((s) => s.status === "SKIPPED").length;
                const secs = shots.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0);
                const pct = shots.length ? Math.round((approved / shots.length) * 100) : 0;
                return (
                  <div className="card doc-shots-summary" aria-label="Shot planning summary">
                    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong><IconScissors size={14} /> Shot Planning</strong>
                      <span className="pill">{shots.length} shots</span>
                      <span className="pill ok">{approved} approved</span>
                      {skipped > 0 && <span className="pill warn">{skipped} skipped</span>}
                      <span className="pill muted">{fmtClock(secs)} total</span>
                      <span className="spacer" />
                      <span className="muted" style={{ fontSize: 12 }}>{pct}% approved</span>
                    </div>
                    <div className="doc-shots-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Approved shots progress">
                      <div className="doc-shots-progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="muted doc-shots-hint">
                      Chapters → sequences → shots. Approve per shot to lock it for generation;
                      Skip to leave it out of the cut. Timing derives from spoken lines (3–15s each).
                    </p>
                  </div>
                );
              })()}
              {board.chapters.map((c) => {
                const chShots = c.sequences.reduce((a, q) => a + q.shots.length, 0);
                const chSecs = c.sequences.reduce((a, q) => a + q.shots.reduce((x, s) => x + (Number(s.duration_seconds) || 0), 0), 0);
                const chApproved = c.sequences.reduce((a, q) => a + q.shots.filter((s) => s.approved).length, 0);
                return (
                  <section key={c.chapter_number} className="card doc-chapter" aria-label={`Chapter ${c.chapter_number}: ${c.title}`}>
                    <header className="doc-chapter-head">
                      <span className="doc-chapter-badge" aria-hidden="true">Ch {c.chapter_number}</span>
                      <div className="doc-chapter-titles">
                        <strong className="doc-chapter-title">{c.title}</strong>
                        {c.purpose && <span className="muted doc-chapter-purpose">{c.purpose}</span>}
                      </div>
                      <span className="spacer" />
                      <span className="pill">{chShots} shots</span>
                      <span className="pill muted">{fmtClock(chSecs)}</span>
                      {chApproved > 0 && <span className="pill ok">{chApproved} ✓</span>}
                    </header>
                    {c.sequences.map((q) => (
                      <div key={q.sequence_id} className="doc-seq">
                        <div className="doc-seq-head">
                          <span className="doc-seq-id">{q.sequence_id}</span>
                          <strong className="doc-seq-title">{q.title}</strong>
                          <span className="muted doc-seq-meta">
                            {q.pacing ? ` · ${q.pacing}` : ""} · {fmtClock(q.duration_seconds)} · {q.shots.length} shots
                          </span>
                        </div>
                        <div className="doc-seq-shots">
                          {q.shots.map((s) => {
                            const skipped = s.status === "SKIPPED";
                            const dlg = s.dialogue_lines ?? [];
                            const actions = s.actions ?? [];
                            const craftBits = [
                              s.emotion ? `🎭 ${s.emotion}` : "",
                              s.time_of_day ? `🕰 ${s.time_of_day}` : "",
                              s.location ? `📍 ${s.location}` : "",
                              (s.characters ?? []).length ? `👥 ${(s.characters ?? []).join(", ")}` : "",
                              s.visual_type && s.visual_type !== "unspecified" ? `🎞 ${s.visual_type}` : "",
                              s.lighting ? `💡 ${s.lighting}` : "",
                              s.audio?.sfx ? `🔊 SFX${s.audio.sfx_kind ? ` (${s.audio.sfx_kind})` : ""}` : "",
                              s.visual_meaning ? `🔍 ${s.visual_meaning}` : "",
                            ].filter(Boolean);
                            return (
                              <article
                                key={s.shot_id}
                                className={`doc-shot${s.approved ? " is-approved" : ""}${skipped ? " is-skipped" : ""}`}
                                aria-label={`Shot ${s.global_index}: ${s.title}`}
                              >
                                <div className="row doc-shot-top" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                  <span className="doc-shot-index" title={`Global shot #${s.global_index}`}>#{s.global_index}</span>
                                  <code className="doc-shot-id">{s.shot_id}</code>
                                  <span className={`pill${s.approved ? " ok" : ""}`}>{s.status}</span>
                                  {s.approved && <span className="pill ok">approved ✓</span>}
                                  {skipped && <span className="pill warn">skipped</span>}
                                  <span className="spacer" />
                                  <button className={`btn sm${s.approved ? " btn-green" : ""}`} disabled={busy != null} onClick={() => setShot(s.shot_id, { approved: !s.approved })} title={s.approved ? "Revoke shot approval" : "Approve this shot"}>
                                    {s.approved ? "✓ Approved" : "Approve"}
                                  </button>
                                  <button className="btn sm ghost" disabled={busy != null} onClick={() => setShot(s.shot_id, { status: skipped ? "WAITING" : "SKIPPED" })} title={skipped ? "Return shot to the cut" : "Leave shot out of the cut"}>
                                    {skipped ? "Unskip" : "Skip"}
                                  </button>
                                  <button className="btn sm ghost" disabled={busy != null} onClick={() => setShot(s.shot_id, { status: "WAITING", approved: false })} title="Reset shot to waiting">
                                    Retry
                                  </button>
                                </div>
                                <p className="doc-shot-title"><strong>{s.title}</strong></p>
                                <div className="doc-shot-pills">
                                  <span className="pill muted" title="Shot duration">⏱ {s.duration_seconds}s</span>
                                  {s.camera?.shot_type && <span className="pill" title={`Shot type · ${s.camera.angle || "angle n/a"}`}>🎥 {s.camera.shot_type}</span>}
                                  {s.camera?.movement && <span className="pill" title="Camera movement">🎬 {s.camera.movement}</span>}
                                  {s.camera?.angle && <span className="pill muted" title="Camera angle">{s.camera.angle}</span>}
                                  {s.pacing && <span className="pill muted" title="Pacing">{s.pacing}</span>}
                                </div>
                                <div className="doc-shot-body">
                                  <div className="doc-shot-line doc-shot-narr" title="Narration voice-over">
                                    <span className="doc-shot-ico" aria-hidden="true">🎙</span>
                                    <p>{s.narration_lines.join(" ") || <span className="muted">(no narration)</span>}</p>
                                  </div>
                                  {dlg.length > 0 && (
                                    <div className="doc-shot-line doc-shot-dlg" title="Spoken dialogue">
                                      <span className="doc-shot-ico" aria-hidden="true">💬</span>
                                      <p>{dlg.join(" ‖ ")}</p>
                                    </div>
                                  )}
                                  {actions.length > 0 && (
                                    <div className="doc-shot-line doc-shot-act" title="On-screen action">
                                      <span className="doc-shot-ico" aria-hidden="true">🎬</span>
                                      <p className="muted">{actions.join(" · ")}</p>
                                    </div>
                                  )}
                                </div>
                                {craftBits.length > 0 && (
                                  <p className="muted doc-shot-craft">{craftBits.join("  ·  ")}</p>
                                )}
                                <div className="doc-shot-edits">
                                  <details className="doc-shot-edit">
                                    <summary>Dialogue & micro-timing <span className="muted">(one per line; dialogue as Speaker: line)</span></summary>
                                    <div className="doc-shot-edit-body">
                                      <label>Narration lines<textarea defaultValue={s.narration_lines.join("\n")} rows={2} id={`narr-${s.shot_id}`} /></label>
                                      <label>Dialogue lines<textarea defaultValue={dlg.join("\n")} rows={2} id={`dlg-${s.shot_id}`} placeholder="Shiva: Behold my dance!" /></label>
                                      <div className="doc-shot-grid">
                                        <label>Duration (3–60s)<input type="number" min={3} max={60} defaultValue={s.duration_seconds} id={`dur-${s.shot_id}`} /></label>
                                        <label>Emotion<input defaultValue={s.emotion ?? ""} id={`emo-${s.shot_id}`} /></label>
                                        <label>Time of day<input defaultValue={s.time_of_day ?? ""} id={`tod-${s.shot_id}`} placeholder="dusk" /></label>
                                      </div>
                                      <label>Actions (one per line)<textarea defaultValue={actions.join("\n")} rows={2} id={`act-${s.shot_id}`} /></label>
                                      <button className="btn sm" disabled={busy != null} onClick={() => {
                                        const val = (id: string) => (document.getElementById(id) as HTMLTextAreaElement | HTMLInputElement | null)?.value ?? "";
                                        setShot(s.shot_id, {
                                          narration_lines: String(val(`narr-${s.shot_id}`)).split("\n").map((x) => x.trim()).filter(Boolean),
                                          dialogue_lines: String(val(`dlg-${s.shot_id}`)).split("\n").map((x) => x.trim()).filter(Boolean),
                                          duration_seconds: Number(val(`dur-${s.shot_id}`)) || s.duration_seconds,
                                          emotion: String(val(`emo-${s.shot_id}`)),
                                          time_of_day: String(val(`tod-${s.shot_id}`)),
                                          actions: String(val(`act-${s.shot_id}`)).split("\n").map((x) => x.trim()).filter(Boolean),
                                        });
                                      }}>Save dialogue & timing</button>
                                    </div>
                                  </details>
                                  <details className="doc-shot-edit">
                                    <summary>Prompts <span className="muted">(Flux image / LTX motion)</span></summary>
                                    <div className="doc-shot-edit-body">
                                      <label>Flux prompt<textarea defaultValue={s.flux_prompt} rows={3} id={`flux-${s.shot_id}`} /></label>
                                      <label>LTX prompt<textarea defaultValue={s.ltx_prompt || s.motion} rows={2} id={`ltx-${s.shot_id}`} /></label>
                                      <button className="btn sm" disabled={busy != null} onClick={() => {
                                        const f = (document.getElementById(`flux-${s.shot_id}`) as HTMLTextAreaElement | null)?.value ?? s.flux_prompt;
                                        const l = (document.getElementById(`ltx-${s.shot_id}`) as HTMLTextAreaElement | null)?.value ?? s.ltx_prompt;
                                        setShot(s.shot_id, { flux_prompt: f, ltx_prompt: l });
                                      }}>Save prompts</button>
                                    </div>
                                  </details>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </section>
                );
              })}
              {!board.chapters.length && <p className="muted">No plan yet — click “Plan documentary”. Works offline via the heuristic planner; the LLM enriches it when available.</p>}
            </div>
          )}


          {tab === "timeline" && board && (
            <div style={{ marginTop: 10 }}>
              <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <button className="btn primary" disabled={!board || !totalShots || busy === "Approving"} onClick={handleApprove}>
                  {busy === "Approving" ? <Spinner size={14} /> : <IconCheck size={14} />} Approve → project
                </button>
                <button className="btn" disabled={!board || busy === "Exporting"} onClick={handleExport}>
                  {busy === "Exporting" ? <Spinner size={14} /> : <IconFilm size={14} />} Export manifest
                </button>
              </div>
              <p><strong>{board.brief.title}</strong> — {fmtClock(timeline?.total_seconds)} target {fmtClock(board.brief.targetSeconds)}</p>
              <div style={{ marginTop: 10 }}>
                <p>Voice: <strong>{board.brief.narrationVoice}</strong> ({board.brief.narrationStyle}) · Music: {board.brief.musicStyle}</p>
                <p className="muted">Narration TTS + music beds + SFX render through the existing pipelines after approval:
                  per-line Edge-TTS timing voices each shot, ACE-Step renders 1–5 min beds mixed under narration via FFmpeg,
                  SFX only where flagged. Same-speaker voices stay stable across the documentary.</p>
                {(board.musicBeds as Record<string, unknown>[]).map((m, i) => (
                  <p key={i} className="muted">🎵 {String((m as Record<string, unknown>).bed_id ?? `bed ${i + 1}`)} · {String((m as Record<string, unknown>).mood ?? "")} · {String((m as Record<string, unknown>).duration_seconds ?? "?")}s — {String((m as Record<string, unknown>).description ?? "")}</p>
                ))}
                <p className="muted">SFX shots: {board.chapters.flatMap((c) => c.sequences.flatMap((q) => q.shots)).filter((s) => s.audio.sfx).map((s) => `${s.shot_id}${s.audio.sfx_kind ? ` (${s.audio.sfx_kind})` : ""}`).join(", ") || "none flagged"}</p>
              </div>
                <p className="muted">
                  Approve hands the board to the existing workspace (saveScenario → Flux images → LTX/Wan clips →
                  TTS/dialogue → music/SFX → lip-sync where needed → chapter masters → final documentary via FFmpeg,
                  stream-copy concat). One failed shot never stops the rest — retry/regenerate/skip per shot above;
                  resume continues from the last incomplete asset.
                </p>
              {(timeline?.chapters ?? []).map((c) => (
                <div key={c.chapter_number} className="card" style={{ margin: "6px 0", padding: 8 }}>
                  <button className="btn sm" onClick={() => setOpenCh((o) => ({ ...o, [c.chapter_number]: !o[c.chapter_number] }))}>
                    {openCh[c.chapter_number] === false ? "▸" : "▾"} Chapter {c.chapter_number} · {c.title} · {fmtClock(c.duration_seconds)}
                  </button>
                  {openCh[c.chapter_number] !== false && c.sequences.map((q) => (
                    <div key={q.sequence_id} style={{ marginLeft: 16 }}>
                      <p style={{ margin: "4px 0" }}><strong>{q.sequence_id}</strong> {q.title}</p>
                      {q.shots.map((s) => (
                        <p key={s.shot_id} className="muted" style={{ margin: "2px 0 2px 16px" }}>
                          #{s.global_index} {s.shot_id} · {s.title} · {s.duration_seconds}s
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
              {!timeline && <p className="muted">No timeline yet — plan first.</p>}
            </div>
          )}

        </div>
    </div>
  );
}
