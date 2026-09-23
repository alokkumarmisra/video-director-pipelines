import { useCallback, useEffect, useState } from "react";
import {
  docApprove, docBoard, docBoards, docCreate, docDelete, docExport, docPlan,
  docStatus, docTimeline, docUpdate, saveScenario,
  type DocBoard, type DocBoardMeta,
} from "../api";
import { useDialog } from "./Dialog";
import { IconCheck, IconClapper, IconClipboard, IconFilm, IconRefresh, IconSparkles, IconTrash, Spinner } from "./Icons";

type Tab = "plan" | "narration" | "characters" | "locations" | "shots" | "audio" | "timeline" | "final";

const DURATIONS = [20, 25, 30];
const fmtClock = (s: number | null | undefined) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

export default function DocumentaryPage({ onOpenProject, onProjectsChanged }: {
  onOpenProject?: (name: string) => void;
  onProjectsChanged?: () => void;
}) {
  const dialog = useDialog();
  const [boards, setBoards] = useState<DocBoardMeta[]>([]);
  const [board, setBoard] = useState<DocBoard | null>(null);
  const [tab, setTab] = useState<Tab>("plan");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ pct: number; ready: number; shots: number; byStatus: Record<string, number>; status: string } | null>(null);
  const [timeline, setTimeline] = useState<{ total_seconds: number; chapters: { chapter_number: number; title: string; duration_seconds: number; sequences: { sequence_id: string; title: string; shots: { shot_id: string; global_index: number; title: string; duration_seconds: number }[] }[] }[] } | null>(null);
  const [openCh, setOpenCh] = useState<Record<number, boolean>>({ 1: true });

  // Brief form (§5 defaults).
  const [title, setTitle] = useState("महादेव — शिव के दिव्य स्वरूप की यात्रा");
  const [topic, setTopic] = useState("Lord Shiva — a Hindi devotional documentary on his origin, form, leelas, symbolism and grace");
  const [language, setLanguage] = useState("Hindi");
  const [targetMinutes, setTargetMinutes] = useState("25");
  const [audience, setAudience] = useState("Family devotional audience");
  const [tone, setTone] = useState("Spiritual + cinematic + informative");
  const [visualStyle, setVisualStyle] = useState("Cinematic devotional documentary, photorealistic mythological India, 16:9");
  const [narrationStyle, setNarrationStyle] = useState("Hindi documentary narration");
  const [narrationVoice, setNarrationVoice] = useState("hi-IN-MadhurNeural");
  const [musicStyle, setMusicStyle] = useState("Devotional ambient, temple bells, soft drone");
  const [sourceMaterial, setSourceMaterial] = useState("");
  const [sourceType, setSourceType] = useState("mixed");
  const [characters, setCharacters] = useState("Lord Shiva, Parvati, Nandi, Narada");
  const [events, setEvents] = useState("Samudra manthan, marriage with Parvati, Tandava, blessing of devotees");
  const [locations, setLocations] = useState("Mount Kailash, Himalayas, Kailash cave, temple, River Ganga");
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

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); } catch (e) {
      await dialog.alert(e instanceof Error ? e.message : String(e), { title: `${label} failed`, tone: "error" });
    } finally { setBusy(null); }
  };

  const handleCreate = () => run("Creating", async () => {
    const b = await docCreate({
      title: title.trim(), topic: topic.trim(), language,
      targetMinutes: Math.max(1, Math.min(60, Number(targetMinutes) || 25)),
      audience, tone, visualStyle, narrationStyle, narrationVoice, musicStyle,
      sourceMaterial, sourceType, characters, events, locations, instructions,
    });
    await refreshList();
    await loadBoard(b.id);
    setTab("plan");
  });

  const handlePlan = () => board && run("Planning", async () => {
    const b = await docPlan(board.id);
    setBoard(b);
    try { setTimeline(await docTimeline(b.id) as typeof timeline); } catch { /* ignore */ }
    await refreshList();
    setTab("shots");
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
    const r = await docExport(board.id, board.scenarioName ? undefined : undefined);
    await dialog.alert(
      `Final: ${r.documentary_final}\nChapters: ${r.chapters.join(", ") || "—"}\nNarration: ${r.narration_audio}\nMusic: ${r.music_dir}\nSubtitles: ${r.metadata === undefined ? "subtitles.srt" : "subtitles.srt"}\nTotal: ${fmtClock(r.total_seconds)}${r.wrote.length ? `\nWrote: ${r.wrote.join(", ")}` : "\n(Tip: approve + generate first — the manifest assembles from the workspace final cut.)"}`,
      { title: "Documentary export", tone: "success" });
  });

  const totalShots = board ? board.chapters.reduce((a, c) => a + c.sequences.reduce((x, q) => x + q.shots.length, 0), 0) : 0;
  const narrationSec = board ? board.chapters.reduce((a, c) => a + c.sequences.reduce((x, q) =>
    x + q.shots.reduce((y, s) => y + s.narration_lines.join(" ").split(/\s+/).filter(Boolean).length / 2.17, 0), 0), 0) : 0;

  return (
    <div className="cmp doc-layout">
      <style>{`@media (max-width: 1100px) { .doc-layout > .card { grid-column: auto !important; grid-row: auto !important; } }`}</style>
      <div className="card cmp-hero" style={{ gridColumn: "1", gridRow: "1", alignSelf: "start" }}>
        <div className="card-head">
          <h2>
            <span className="head-icon hi-documentary" aria-hidden="true"><IconClipboard size={16} /></span>
            Documentary
          </h2>
          {board && (
            <span className="muted">{board.status} · {fmtClock(timeline?.total_seconds ?? narrationSec)} / {fmtClock(board.brief.targetSeconds)} · {totalShots} shots</span>
          )}
        </div>
        <p className="card-desc">
          20–30 minute Hindi devotional documentaries as an orchestration layer on the existing pipeline.
          Plan narration-first (dynamic 6–15s shots), approve into a standard project, then generate with
          Flux → LTX/Wan + TTS + music + lip-sync and stitch — Song/Story flows are untouched.
        </p>
        {status && board && (
          <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 8 }}>
            <span className="pill">{status.ready}/{status.shots} ready</span>
            <span className="pill">{status.pct}%</span>
            {Object.entries(status.byStatus).map(([k, v]) => (
              <span key={k} className="pill muted">{k}: {v}</span>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button className="btn" disabled={!board || busy === "Planning"} onClick={handlePlan}>
            {busy === "Planning" ? <Spinner size={14} /> : <IconSparkles size={14} />} Plan documentary
          </button>
          <button className="btn primary" disabled={!board || !totalShots || busy === "Approving"} onClick={handleApprove}>
            {busy === "Approving" ? <Spinner size={14} /> : <IconCheck size={14} />} Approve → project
          </button>
          <button className="btn" disabled={!board || busy === "Exporting"} onClick={handleExport}>
            <IconFilm size={14} /> Export manifest
          </button>
          {board && (
            <button className="btn danger" disabled={busy != null} onClick={() => run("Deleting", async () => {
              await docDelete(board.id);
              setBoard(null); setTimeline(null); await refreshList();
            })}>
              <IconTrash size={14} /> Delete
            </button>
          )}
        </div>
      </div>

      <div className="card" style={{ gridColumn: "2", gridRow: "1 / span 2", alignSelf: "start" }}>
        <div className="card-head"><h3><IconClapper size={15} /> Documentary brief</h3></div>
        <div className="grid2">
          <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="महादेव — शिव के दिव्य स्वरूप की यात्रा" /></label>
          <label>Topic<input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What is this documentary about?" /></label>
          <label>Language
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option>Hindi</option><option>English</option><option>Hinglish</option>
            </select>
          </label>
          <label>Target duration (min)
            <div className="row" style={{ gap: 6 }}>
              {DURATIONS.map((d) => (
                <button key={d} type="button" className={`btn sm${String(d) === targetMinutes ? " primary" : ""}`}
                  onClick={() => setTargetMinutes(String(d))}>{d}</button>
              ))}
              <input value={targetMinutes} onChange={(e) => setTargetMinutes(e.target.value)}
                style={{ width: 90 }} title="Custom minutes — use 5 for the acceptance test" />
              <button type="button" className="btn sm" title="5-minute acceptance test" onClick={() => setTargetMinutes("5")}>5-min test</button>
            </div>
          </label>
          <label>Audience<input value={audience} onChange={(e) => setAudience(e.target.value)} /></label>
          <label>Tone<input value={tone} onChange={(e) => setTone(e.target.value)} /></label>
          <label>Visual style (16:9)<input value={visualStyle} onChange={(e) => setVisualStyle(e.target.value)} /></label>
          <label>Narration style<input value={narrationStyle} onChange={(e) => setNarrationStyle(e.target.value)} /></label>
          <label>Narration voice
            <select value={narrationVoice} onChange={(e) => setNarrationVoice(e.target.value)}>
              <option>hi-IN-MadhurNeural</option><option>hi-IN-SwaraNeural</option>
            </select>
          </label>
          <label>Music style<input value={musicStyle} onChange={(e) => setMusicStyle(e.target.value)} /></label>
          <label>Source type
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              <option value="traditional">traditional</option><option value="scriptural">scriptural</option>
              <option value="historical">historical</option><option value="user_provided">user_provided</option>
              <option value="creative">creative</option><option value="mixed">mixed</option>
            </select>
          </label>
          <label>Aspect ratio<input value="16:9" disabled title="Documentary is 16:9 (Reel cut stays in the workspace)" /></label>
        </div>
        <label>Source / story material<textarea value={sourceMaterial} onChange={(e) => setSourceMaterial(e.target.value)} rows={3} placeholder="Scriptural/traditional source text, katha summary, or your own material…" /></label>
        <div className="grid2">
          <label>Characters<textarea value={characters} onChange={(e) => setCharacters(e.target.value)} rows={2} /></label>
          <label>Important locations<textarea value={locations} onChange={(e) => setLocations(e.target.value)} rows={2} /></label>
        </div>
        <label>Important events<textarea value={events} onChange={(e) => setEvents(e.target.value)} rows={2} /></label>
        <label>Special instructions<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} /></label>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn primary" disabled={busy != null || !title.trim()} onClick={handleCreate}>
            {busy === "Creating" ? <Spinner size={14} /> : <IconSparkles size={14} />} Create documentary
          </button>
          <select aria-label="Open saved documentary" value={board?.id ?? ""} onChange={(e) => e.target.value && loadBoard(e.target.value).catch((err) => dialog.alert(err.message, { title: "Open failed", tone: "error" }))}>
            <option value="">Open saved… ({boards.length})</option>
            {boards.map((b) => <option key={b.id} value={b.id}>{b.title} · {b.status} · {b.shots} shots</option>)}
          </select>
          <button className="btn sm" onClick={() => refreshList()} title="Refresh list"><IconRefresh size={14} /></button>
        </div>
      </div>

      {board && (
        <div className="card" style={{ gridColumn: "1", gridRow: "2", alignSelf: "start" }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {(["plan", "narration", "characters", "locations", "shots", "audio", "timeline", "final"] as Tab[]).map((t) => (
              <button key={t} className={`btn sm${tab === t ? " primary" : ""}`} onClick={() => setTab(t)}>
                {t === "plan" ? "Director Plan" : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === "plan" && (
            <div style={{ marginTop: 10 }}>
              <p className="muted">Chapters → sequences (narration-first; shot timing derives from narration, 6–15s each, dynamic count).</p>
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

          {tab === "narration" && (
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
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {tab === "characters" && (
            <div style={{ marginTop: 10 }}>
              {(board.characters as Record<string, unknown>[]).map((c, i) => (
                <details key={String((c as Record<string, unknown>).character_id ?? i)}>
                  <summary>{String((c as Record<string, unknown>).name ?? `Character ${i + 1}`)}</summary>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(c, null, 2)}</pre>
                </details>
              ))}
              {!board.characters.length && <p className="muted">No character bible yet — plan first.</p>}
            </div>
          )}

          {tab === "locations" && (
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

          {tab === "shots" && (
            <div style={{ marginTop: 10 }}>
              {board.chapters.map((c) => (
                <div key={c.chapter_number}>
                  <h4>Chapter {c.chapter_number}: {c.title}</h4>
                  {c.sequences.map((q) => (
                    <div key={q.sequence_id}>
                      {q.shots.map((s) => (
                        <div key={s.shot_id} className="card" style={{ margin: "8px 0", padding: 10 }}>
                          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <strong>#{s.global_index} {s.shot_id}</strong>
                            <span className="pill">{s.status}</span>
                            <span className="pill muted">{s.duration_seconds}s · {s.camera.shot_type} · {s.camera.movement}</span>
                            {s.approved && <span className="pill ok">approved</span>}
                            <span className="spacer" />
                            <button className="btn sm" disabled={busy != null} onClick={() => setShot(s.shot_id, { approved: !s.approved })}>
                              {s.approved ? "Unapprove" : "Approve"}
                            </button>
                            <button className="btn sm" disabled={busy != null} onClick={() => setShot(s.shot_id, { status: s.status === "SKIPPED" ? "WAITING" : "SKIPPED" })}>
                              {s.status === "SKIPPED" ? "Unskip" : "Skip"}
                            </button>
                            <button className="btn sm" disabled={busy != null} onClick={() => setShot(s.shot_id, { status: "WAITING", approved: false })}>
                              Retry
                            </button>
                          </div>
                          <p style={{ margin: "6px 0" }}><strong>{s.title}</strong></p>
                          <p className="muted" style={{ margin: "4px 0" }}>🎙 {s.narration_lines.join(" ") || "—"}</p>
                          <details>
                            <summary>Prompts (Flux image / LTX motion)</summary>
                            <label>Flux prompt<textarea defaultValue={s.flux_prompt} rows={3} id={`flux-${s.shot_id}`} /></label>
                            <label>LTX prompt<textarea defaultValue={s.ltx_prompt || s.motion} rows={2} id={`ltx-${s.shot_id}`} /></label>
                            <button className="btn sm" disabled={busy != null} onClick={() => {
                              const f = (document.getElementById(`flux-${s.shot_id}`) as HTMLTextAreaElement | null)?.value ?? s.flux_prompt;
                              const l = (document.getElementById(`ltx-${s.shot_id}`) as HTMLTextAreaElement | null)?.value ?? s.ltx_prompt;
                              setShot(s.shot_id, { flux_prompt: f, ltx_prompt: l });
                            }}>Save prompts</button>
                          </details>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {tab === "audio" && (
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
          )}

          {tab === "timeline" && (
            <div style={{ marginTop: 10 }}>
              <p><strong>{board.brief.title}</strong> — {fmtClock(timeline?.total_seconds)} target {fmtClock(board.brief.targetSeconds)}</p>
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

          {tab === "final" && (
            <div style={{ marginTop: 10 }}>
              <p className="muted">
                Approve hands the board to the existing workspace (saveScenario → Flux images → LTX/Wan clips →
                TTS/dialogue → music/SFX → lip-sync where needed → chapter masters → final documentary via FFmpeg,
                stream-copy concat). One failed shot never stops the rest — retry/regenerate/skip per shot above;
                resume continues from the last incomplete asset.
              </p>
              <p>Project: <strong>{board.scenarioName ?? "not approved yet"}</strong></p>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" disabled={!totalShots || busy != null} onClick={handleApprove}>
                  <IconCheck size={14} /> Approve → {board.scenarioName ?? "new project"}
                </button>
                <button className="btn" disabled={busy != null} onClick={handleExport}><IconFilm size={14} /> Export manifest + subtitles</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
