import { useEffect, useRef, useState } from "react";
import {
  directorAnalyze, directorApprove, directorBoard, directorBoards, directorDeleteBoard,
  directorRegenScene, directorScenes, directorSongUrl, directorUpdateBoard, directorUploadSong, saveScenario,
  type DirectorBoard, type DirectorBoardMeta, type DirectorInput, type DirectorScene, type DirectorSong,
} from "../api";
import { useDialog } from "./Dialog";
import { IconCheck, IconClapper, IconFilm, IconRefresh, IconSparkles, IconTrash, Spinner } from "./Icons";
import Collapse from "./Collapse";

const GENRES = ["Kids", "Devotional", "Adventure", "Fantasy", "Horror", "Comedy", "Educational", "Custom"];
const STYLES = ["3D Preschool Animation", "3D Cinematic", "Realistic", "Anime", "Cartoon", "Indian Mythological", "Fantasy", "Custom"];
const LANGS = ["Hindi", "English", "Hinglish"];
const TARGETS = [
  { label: "30 sec", seconds: 30 },
  { label: "1 min", seconds: 60 },
  { label: "2 min", seconds: 120 },
  { label: "3 min", seconds: 180 },
  { label: "5 min", seconds: 300 },
  { label: "10 min", seconds: 600 },
  { label: "Custom", seconds: -1 },
];
const SCENE_DURS = [
  { label: "3 sec", seconds: 3 },
  { label: "5 sec", seconds: 5 },
  { label: "6 sec", seconds: 6 },
  { label: "8 sec", seconds: 8 },
  { label: "Custom", seconds: -1 },
];
const ASPECTS = ["16:9", "9:16", "1:1"];

const str = (v: unknown): string => (v == null ? "" : String(v));

// Elapsed seconds since `since` (null = not running).
function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [since]);
  if (since == null) return null;
  const s = Math.max(0, Math.round((now - since) / 1000));
  return <span className="muted"> · {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

// AI Story Director — Story-to-Video workflow. Authors a storyboard
// (analysis -> bibles -> beats -> scenes) via the local LLM; APPROVE hands
// a standard scenario to the EXISTING save/generation pipeline, so image /
// video / merge / progress / resume are all reused, never reimplemented.
export default function DirectorPage({ onOpenProject, onProjectsChanged }: {
  onOpenProject: (name: string) => void;
  onProjectsChanged: () => void;
}) {
  const dialog = useDialog();
  // Story form.
  const [title, setTitle] = useState("");
  const [story, setStory] = useState("");
  // Music-video mode: upload an mp3, paste lyrics (optional), storyboard +
  // video are paced to the song length, and the song is muxed over the final
  // cut after generation. The local LLM is text-only (no audio transcription)
  // — it "reads" the song via the pasted lyrics + title + duration.
  const [mode, setMode] = useState<"story" | "song">("story");
  const [song, setSong] = useState<DirectorSong | null>(null);
  const [songUploading, setSongUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [language, setLanguage] = useState("English");
  const [genre, setGenre] = useState("Kids");
  const [genreCustom, setGenreCustom] = useState("");
  const [visualStyle, setVisualStyle] = useState("3D Preschool Animation");
  const [styleCustom, setStyleCustom] = useState("");
  const [targetOpt, setTargetOpt] = useState(60);
  const [targetCustom, setTargetCustom] = useState("90");
  const [sceneOpt, setSceneOpt] = useState(3);
  const [sceneCustom, setSceneCustom] = useState("4");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [instructions, setInstructions] = useState("");
  // Boards.
  const [boards, setBoards] = useState<DirectorBoardMeta[]>([]);
  const [board, setBoard] = useState<DirectorBoard | null>(null);
  const [busy, setBusy] = useState<{ label: string; since: number } | null>(null);
  const [error, setError] = useState("");
  const [sceneProgress, setSceneProgress] = useState("");
  const cancelRef = useRef(false);
  // Editing + master-detail selection (compact cards + one full detail section).
  const [selectedScene, setSelectedScene] = useState<number | null>(null);
  const [editingScene, setEditingScene] = useState<number | null>(null);
  const [sceneDraft, setSceneDraft] = useState<Partial<DirectorScene>>({});
  const [dialogueDraft, setDialogueDraft] = useState("");
  const [regenScene, setRegenScene] = useState<number | null>(null);
  const [editingChar, setEditingChar] = useState<number | null>(null);
  const [charDraft, setCharDraft] = useState<Record<string, string>>({});
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-director") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-director", c ? "open" : "closed");
      return !c;
    });

  const targetSeconds = mode === "song" && song
    ? Math.max(15, song.durationSeconds)
    : targetOpt === -1 ? Math.max(15, Number(targetCustom) || 60) : targetOpt;
  const sceneSeconds = sceneOpt === -1 ? Math.min(30, Math.max(1, Number(sceneCustom) || 4)) : sceneOpt;
  // Scene count is purely story + time driven (target / scene). The 300 safety
  // ceiling in lib/director.mjs only guards runaway custom inputs.
  const plannedScenes = Math.min(300, Math.max(1, Math.round(targetSeconds / sceneSeconds)));

  const onSongFile = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    setSongUploading(true);
    try {
      const data: string = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(new Error("could not read the audio file"));
        r.readAsDataURL(f);
      });
      const up = await directorUploadSong(data, f.name);
      setSong({ ...up, hasLyrics: story.trim().length >= 20 });
      if (!title.trim()) {
        const base = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
        if (base) setTitle(base.slice(0, 120));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSongUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const refreshBoards = async () => {
    try { setBoards(await directorBoards()); }
    catch { /* board list is best-effort */ }
  };
  useEffect(() => { void refreshBoards(); }, []);

  const openBoard = async (id: string) => {
    setError("");
    try {
      setBoard(await directorBoard(id));
      setSelectedScene(0);
      setEditingScene(null);
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const doAnalyze = async () => {
    if (busy) return;
    const lyrics = story.trim();
    const hasLyrics = lyrics.length >= 20;
    const input: DirectorInput = {
      title: title.trim(),
      story: mode === "song" && !hasLyrics
        ? `[Instrumental song "${title.trim()}" — no lyrics provided; direct a matching visual story]`
        : lyrics,
      language, genre,
      genreCustom: genre === "Custom" ? genreCustom.trim() : "",
      visualStyle, styleCustom: visualStyle === "Custom" ? styleCustom.trim() : "",
      targetSeconds, sceneSeconds, aspectRatio, instructions: instructions.trim(),
      ...(mode === "song" && song
        ? { song: { ...song, hasLyrics } }
        : {}),
    };
    if (!input.title) {
      setError("Give the story a title.");
      return;
    }
    if (mode === "song" && !song) {
      setError("Upload the song first (mp3 or wav) — the timeline comes from its length.");
      return;
    }
    if (mode === "story" && input.story.length < 20) {
      setError("Give the story a title and paste the full story (20+ characters).");
      return;
    }
    setBusy({ label: mode === "song" ? "Reading the song — characters, locations, beats…" : "Analyzing story — characters, locations, beats…", since: Date.now() });
    setError("");
    try {
      const b = await directorAnalyze(input);
      setBoard(b);
      setSelectedScene(0);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // Generate scenes in batches until the plan is complete. Resumable: the
  // server appends from scenes.length, so retry continues, never restarts.
  const doScenes = async () => {
    if (!board || busy) return;
    cancelRef.current = false;
    setBusy({ label: "Planning scenes…", since: Date.now() });
    setError("");
    try {
      let b = board;
      while (b.scenes.length < b.sceneCount) {
        if (cancelRef.current) break;
        setSceneProgress(`Scene ${b.scenes.length + 1}–${Math.min(b.sceneCount, b.scenes.length + 12)} of ${b.sceneCount}`);
        b = await directorScenes(b.id);
        setBoard(b);
      }
      setSelectedScene((sel) => (sel == null && b.scenes.length ? 0 : sel));
      await refreshBoards();
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)} — partial scenes are kept, retry continues.`);
      try { setBoard(await directorBoard(board.id)); } catch { /* keep sick */ }
    } finally {
      setBusy(null);
      setSceneProgress("");
    }
  };

  const doRegenScene = async (index: number) => {
    if (!board || regenScene != null) return;
    setRegenScene(index);
    setError("");
    try {
      const b = await directorRegenScene(board.id, index);
      setBoard(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenScene(null);
    }
  };

  const doDeleteScene = async (index: number) => {
    if (!board) return;
    const s = board.scenes[index];
    const ok = await dialog.confirm("The plan renumbers after deletion.", {
      title: `Delete Scene ${s.scene_number} (${s.title})?`,
      tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      const b = await directorUpdateBoard(board.id, { scenes: board.scenes.filter((_, i) => i !== index) });
      setBoard(b);
      setSelectedScene((sel) => (sel == null ? sel : Math.min(sel, Math.max(0, b.scenes.length - 1))));
      setEditingScene(null);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startEditScene = (index: number) => {
    if (!board) return;
    setEditingScene(index);
    setSceneDraft({ ...board.scenes[index] });
    const dlg = board.scenes[index].dialogue;
    setDialogueDraft(Array.isArray(dlg) ? dlg.map((d) => {
      const sp = String(d.speaker || "").trim();
      const ln = String(d.line || "").trim();
      return sp ? `${sp}: ${ln}` : ln;
    }).filter(Boolean).join("\n") : "");
  };
  const saveEditScene = async () => {
    if (!board || editingScene == null) return;
    const dlg = dialogueDraft.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const c = l.indexOf(":");
      return c > 0
        ? { speaker: l.slice(0, c).trim(), line: l.slice(c + 1).trim() }
        : { speaker: "", line: l };
    }).filter((d) => d.line);
    const next = board.scenes.map((s, i) => (i === editingScene ? { ...s, ...sceneDraft, dialogue: dlg } : s));
    try {
      const b = await directorUpdateBoard(board.id, { scenes: next });
      setBoard(b);
      setEditingScene(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startEditChar = (index: number) => {
    const c = board?.blueprint?.characters?.[index] as Record<string, unknown> | undefined;
    if (!c) return;
    setEditingChar(index);
    setCharDraft({ name: str(c.name), role: str(c.role), visual_identity_prompt: str(c.visual_identity_prompt) });
  };
  const saveEditChar = async () => {
    if (!board?.blueprint || editingChar == null) return;
    const next = board.blueprint.characters.map((c, i) =>
      i === editingChar ? { ...(c as object), ...charDraft } : c);
    try {
      const b = await directorUpdateBoard(board.id, { characters: next });
      setBoard(b);
      setEditingChar(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doRenameBoard = async () => {
    if (!board || !titleDraft.trim()) return;
    try {
      const b = await directorUpdateBoard(board.id, { input: { title: titleDraft.trim() } });
      setBoard(b);
      setEditingTitle(false);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doApprove = async () => {
    if (!board || busy || !board.scenes.length) return;
    const songNote = board.input.song
      ? ` The uploaded song ("${board.input.song.fileName}", ~${board.input.song.durationSeconds}s) travels with the project — after the final cut is stitched, mix it over the video from the project workspace.`
      : "";
    const ok = await dialog.confirm(
      `Creates project "${board.input.title}" with ${board.scenes.length} scenes, then opens it in the workspace for generation (images → videos → final cut).${songNote}`,
      { title: `Approve storyboard for "${board.input.title}"?`, tone: "info", okText: "Approve", cancelText: "Keep editing" }
    );
    if (!ok) return;
    setBusy({ label: "Approving storyboard…", since: Date.now() });
    setError("");
    try {
      const { name, config } = await directorApprove(board.id);
      await saveScenario(name, config);
      onProjectsChanged();
      onOpenProject(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doDeleteBoard = async () => {
    if (!board) return;
    const ok = await dialog.confirm("The story input and all planned scenes are removed. Generated projects are kept.", {
      title: `Delete board "${board.input.title}"?`, tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      await directorDeleteBoard(board.id);
      setBoard(null);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Select a scene to inspect its full breakdown in the separate Scene
  // details section below (scene cards stay compact with essentials only).
  const selectScene = (i: number) => {
    setSelectedScene(i);
    window.setTimeout(() => {
      document.getElementById("dir-scene-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  };
  const editSceneFromDetail = (i: number) => {
    startEditScene(i);
    window.setTimeout(() => {
      const el = document.getElementById(`dir-scene-${board?.scenes[i]?.scene_number ?? i + 1}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  };

  const chars = (board?.blueprint?.characters ?? []) as Record<string, unknown>[];
  const locs = (board?.blueprint?.locations ?? []) as Record<string, unknown>[];
  const objs = (board?.blueprint?.objects ?? []) as Record<string, unknown>[];
  const beats = (board?.blueprint?.beats ?? []) as { n: number; title: string; summary: string }[];
  const analysis = (board?.blueprint?.analysis ?? {}) as Record<string, unknown>;

  return (
    <section className={`card${collapsed ? " collapsed" : ""}`} aria-label="AI Story Director">
      <div className="card-head">
        <h2>
          <span className="head-icon hi-output"><IconClapper size={15} /></span>
          AI Story Director
        </h2>
        {busy && (
          <span className="pill running" title={busy.label}>
            <Spinner size={11} />
            {busy.label.split("—")[0].trim()}…
            <Elapsed since={busy.since} />
          </span>
        )}
        <span className="spacer" />
        {board && (
          <button className="ghost" onClick={() => { setBoard(null); setError(""); void refreshBoards(); }} title="Back to the story form and saved boards">
            Boards
          </button>
        )}
        <button
          className="icon-btn"
          onClick={toggleCollapsed}
          title={collapsed ? "Show story director" : "Hide story director"}
          aria-label={collapsed ? "Show story director" : "Hide story director"}
          aria-expanded={!collapsed}
        >
          <span aria-hidden="true">⧉</span>
        </button>
      </div>
      <Collapse open={!collapsed}>
        {error && <p className="hint err-text">{error}</p>}

        {!board && (
          <>
            <p className="card-desc">
              Tell a story — the AI Director breaks it into characters, locations, beats and
              cinematic scenes with image + video prompts. Approving hands a standard project
              to the existing generation pipeline (nothing here renders pixels itself).
              Prefer a music video? Switch to Song mode: upload the mp3, optionally paste
              the lyrics, and the storyboard + video are paced to the song length.
            </p>
            <div className="row" role="tablist" aria-label="Director input mode" style={{ marginBottom: 10 }}>
              <button
                className={`ghost shotlist-btn${mode === "story" ? " on" : ""}`}
                role="tab"
                aria-selected={mode === "story"}
                onClick={() => setMode("story")}
                title="Paste a story and direct it scene by scene"
              >
                📖 Story
              </button>
              <button
                className={`ghost shotlist-btn${mode === "song" ? " on" : ""}`}
                role="tab"
                aria-selected={mode === "song"}
                onClick={() => setMode("song")}
                title="Upload a song — storyboard + video paced to its length"
              >
                🎵 Song → Video
              </button>
            </div>
            {mode === "song" && (
              <div className="beat-meta-box" style={{ marginBottom: 10 }}>
                <div className="section-label">Song (mp3 / wav)</div>
                {!song ? (
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,.mp3,.wav,.m4a"
                      disabled={songUploading}
                      onChange={(e) => void onSongFile(e.target.files?.[0])}
                      title="Upload the song — its length becomes the video timeline"
                    />
                    <p className="hint" style={{ margin: "4px 0 0" }}>
                      {songUploading
                        ? "Reading the song file…"
                        : "Upload the mp3 — its exact length becomes the video timeline. The Director reads the pasted lyrics + title (audio itself isn't transcribed — the local LLM is text-only)."}
                    </p>
                  </>
                ) : (
                  <>
                    <p style={{ margin: "2px 0 6px" }}>
                      <b>{song.fileName}</b> · ~{song.durationSeconds}s · timeline locked 🎵
                    </p>
                    <audio controls src={directorSongUrl(song.file)} style={{ width: "100%" }} />
                    <div className="row" style={{ marginTop: 6 }}>
                      <button
                        className="ghost shotlist-btn"
                        onClick={() => setSong(null)}
                        disabled={songUploading || busy != null}
                        title="Remove the song and upload a different one"
                      >
                        Remove song
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            <label htmlFor="dir-title">Story title</label>
            <input
              id="dir-title"
              value={title}
              maxLength={120}
              placeholder="The Mouse and the Magic Cheese"
              onChange={(e) => setTitle(e.target.value)}
            />
            <label htmlFor="dir-story" style={{ marginTop: 8 }}>
              {mode === "song" ? "Lyrics (optional — paste for best results; empty = instrumental visual story)" : "Story"}
            </label>
            <textarea
              id="dir-story"
              rows={8}
              value={story}
              placeholder={mode === "song" ? "[Verse 1]\nPaste the song lyrics here… (or leave empty for an instrumental)" : "Once upon a time… (paste the full story)"}
              onChange={(e) => setStory(e.target.value)}
            />
            <div className="grid" style={{ marginTop: 8 }}>
              <div>
                <label htmlFor="dir-lang">Language</label>
                <select id="dir-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="dir-genre">Genre</label>
                <select id="dir-genre" value={genre} onChange={(e) => setGenre(e.target.value)}>
                  {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
                {genre === "Custom" && (
                  <input value={genreCustom} maxLength={40} placeholder="Custom genre…" onChange={(e) => setGenreCustom(e.target.value)} style={{ marginTop: 6 }} />
                )}
              </div>
            </div>
            <div className="grid" style={{ marginTop: 8 }}>
              <div>
                <label htmlFor="dir-style">Visual style</label>
                <select id="dir-style" value={visualStyle} onChange={(e) => setVisualStyle(e.target.value)}>
                  {STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {visualStyle === "Custom" && (
                  <input value={styleCustom} maxLength={120} placeholder="Describe the custom style…" onChange={(e) => setStyleCustom(e.target.value)} style={{ marginTop: 6 }} />
                )}
              </div>
              <div>
                <label htmlFor="dir-aspect">Aspect ratio</label>
                <select id="dir-aspect" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                  {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <p className="hint" style={{ margin: "4px 0 0" }}>
                  {aspectRatio === "9:16"
                    ? "9:16 renders through the Instagram Reel flow after approval."
                    : aspectRatio === "1:1"
                      ? "The pipeline renders 16:9/9:16 — approved as 16:9."
                      : "Standard landscape cut."}
                </p>
              </div>
            </div>
            <div className="grid" style={{ marginTop: 8 }}>
              <div>
                <label htmlFor="dir-target">Target duration</label>
                {mode === "song" ? (
                  <p className="hint" style={{ margin: "6px 0 0" }}>
                    {song ? <>🔒 ~{song.durationSeconds}s (song length)</> : "Upload the song — the timeline locks to its length."}
                  </p>
                ) : (
                  <>
                    <select id="dir-target" value={targetOpt} onChange={(e) => setTargetOpt(Number(e.target.value))}>
                      {TARGETS.map((t) => <option key={t.seconds} value={t.seconds}>{t.label}</option>)}
                    </select>
                    {targetOpt === -1 && (
                      <input type="number" min={15} max={3600} value={targetCustom} onChange={(e) => setTargetCustom(e.target.value)} style={{ marginTop: 6 }} />
                    )}
                  </>
                )}
              </div>
              <div>
                <label htmlFor="dir-scene">Scene duration</label>
                <select id="dir-scene" value={sceneOpt} onChange={(e) => setSceneOpt(Number(e.target.value))}>
                  {SCENE_DURS.map((t) => <option key={t.seconds} value={t.seconds}>{t.label}</option>)}
                </select>
                {sceneOpt === -1 && (
                  <input type="number" min={1} max={30} value={sceneCustom} onChange={(e) => setSceneCustom(e.target.value)} style={{ marginTop: 6 }} />
                )}
              </div>
            </div>
            <p className="hint">Plans ≈ {plannedScenes} scene{plannedScenes === 1 ? "" : "s"} ({sceneSeconds}s each toward ~{targetSeconds}s).</p>
            <label htmlFor="dir-instructions" style={{ marginTop: 8 }}>Additional director instructions</label>
            <textarea
              id="dir-instructions"
              rows={3}
              value={instructions}
              placeholder="Keep Minku's appearance exactly the same… avoid scary scenes…"
              onChange={(e) => setInstructions(e.target.value)}
            />
            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" onClick={() => void doAnalyze()} disabled={busy != null || songUploading || !title.trim() || (mode === "song" ? !song : story.trim().length < 20)} title={mode === "song" ? "Read the song into characters, locations, beats (no images/videos yet)" : "Analyze the story into characters, locations, beats (no images/videos yet)"}>
                {busy ? <Spinner size={13} /> : <IconSparkles size={13} />}
                {busy ? "Directing…" : mode === "song" ? "Generate Song Storyboard" : "Generate Storyboard"}
              </button>
            </div>

            {boards.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 16 }}>Saved storyboards</div>
                <div className="shotlist-list">
                  {boards.map((b) => (
                    <div className="shotlist-row" role="row" key={b.id}>
                      <span className="shotlist-shot" role="cell" title={b.title}>
                        <IconFilm size={14} />
                      </span>
                      <span className="shotlist-desc" role="cell">
                        <span className="shotlist-desc-title" title={b.title}>{b.title}</span>
                        <span className="shotlist-desc-text" title={`${b.scenes}/${b.sceneCount} scenes · ${b.status}`}>
                          {b.scenes}/{b.sceneCount} scenes · {b.status}{b.scenarioName ? ` · → ${b.scenarioName}` : ""}
                        </span>
                      </span>
                      <span className="shotlist-actions" role="cell">
                        <button className="ghost shotlist-btn" onClick={() => void openBoard(b.id)} title={`Open ${b.title}`}>
                          Open
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {board && (
          <>
            <div className="section-label">Storyboard</div>
            <p className="card-desc">
              {editingTitle ? (
                <span className="row" style={{ display: "inline-flex", gap: 6 }}>
                  <input
                    value={titleDraft}
                    maxLength={120}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void doRenameBoard(); }}
                    title="Board title — the approved project takes exactly this name"
                    style={{ minWidth: 200 }}
                  />
                  <button className="primary" onClick={() => void doRenameBoard()} disabled={!titleDraft.trim()} title="Save the new title">
                    Save
                  </button>
                  <button className="ghost" onClick={() => setEditingTitle(false)} title="Keep the current title">
                    Cancel
                  </button>
                </span>
              ) : (
                <>
                  <b>{board.input.title}</b>{" "}
                  <button
                    className="ghost shotlist-btn"
                    onClick={() => { setTitleDraft(board.input.title); setEditingTitle(true); }}
                    title="Rename — the approved project takes exactly this name"
                  >
                    Rename
                  </button>
                </>
              )}
              {" "}· {board.input.genre} · {board.input.language} · {board.input.aspectRatio} ·
              {" "}{board.scenes.length}/{board.sceneCount} scenes · ~{board.sceneCount * board.input.sceneSeconds}s
              {board.scenarioName ? <> · approved → <b>{board.scenarioName}</b></> : null}
            </p>
            {board.blueprint?.logline ? <p className="hint">{board.blueprint.logline}</p> : null}
            {board.input.song?.file ? (
              <div className="beat-meta-box" style={{ marginBottom: 12 }}>
                <div className="section-label">🎵 Song · {board.input.song.fileName} · ~{board.input.song.durationSeconds}s</div>
                <audio controls src={directorSongUrl(board.input.song.file)} style={{ width: "100%" }} />
                <p className="hint" style={{ margin: "4px 0 0" }}>
                  Timeline is locked to the song. After the final cut is stitched in the project
                  workspace, mix this song over it (the approved project carries the song along).
                </p>
              </div>
            ) : null}
            <div className="row" style={{ marginBottom: 8 }}>
              {board.scenes.length < board.sceneCount ? (
                <button className="primary" onClick={() => void doScenes()} disabled={busy != null} title="Plan the remaining scenes (resumes on retry)">
                  {busy ? <Spinner size={13} /> : <IconFilm size={13} />}
                  {busy ? `Planning…${sceneProgress ? ` ${sceneProgress}` : ""}` : board.scenes.length ? `Continue scenes (${board.scenes.length}/${board.sceneCount})` : "Generate scenes"}
                </button>
              ) : (
                <button className="btn-green" onClick={() => void doApprove()} disabled={busy != null} title="Create a standard project from these scenes and open it in the workspace for generation">
                  {busy ? <Spinner size={13} /> : <IconCheck size={13} />}
                  {busy ? "Approving…" : "Approve Storyboard"}
                </button>
              )}
              {busy && (
                <button className="ghost" onClick={() => { cancelRef.current = true; }} title="Stop after the current batch (planned scenes are kept)">
                  Stop
                </button>
              )}
              <button
                className="ghost"
                onClick={() => setShowAnalysis((s) => !s)}
                title={showAnalysis ? "Hide story analysis" : "Show story analysis"}
                aria-expanded={showAnalysis}
              >
                {showAnalysis ? "Hide analysis" : "Show analysis"}
              </button>
              <span className="spacer" />
              <button className="icon-btn danger" onClick={() => void doDeleteBoard()} disabled={busy != null} title={`Delete board "${board.input.title}"`} aria-label="Delete board">
                <IconTrash size={13} />
              </button>
            </div>
            {busy && sceneProgress && <p className="hint">{sceneProgress} · partial scenes are kept on failure — retry continues.</p>}

            {showAnalysis && (
              <div className="beat-meta-box" style={{ marginBottom: 12 }}>
                {Object.entries(analysis).map(([k, v]) => (
                  <div key={k} style={{ marginBottom: 6 }}>
                    <div className="shotlist-detail-label">{k.replace(/_/g, " ")}</div>
                    <p style={{ margin: "2px 0 0" }}>{Array.isArray(v) ? v.map(String).join(", ") || "—" : (str(v) || (v == null ? "—" : str(v)))}</p>
                  </div>
                ))}
              </div>
            )}

            {chars.length > 0 && (
              <>
                <div className="section-label">Characters · {chars.length}</div>
                <div className="grid grid-compact">
                  {chars.map((c, i) => (
                    <div className="shot" key={String(c.character_id ?? i)}>
                      <div className="shot-head" aria-hidden="true">
                        {str(c.name) || `Character ${i + 1}`} · {str(c.role) || "supporting"}
                      </div>
                      {editingChar === i ? (
                        <>
                          <label>Name</label>
                          <input value={charDraft.name ?? ""} maxLength={60} onChange={(e) => setCharDraft((d) => ({ ...d, name: e.target.value }))} />
                          <label style={{ marginTop: 6 }}>Role</label>
                          <input value={charDraft.role ?? ""} maxLength={40} onChange={(e) => setCharDraft((d) => ({ ...d, role: e.target.value }))} />
                          <label style={{ marginTop: 6 }}>Visual identity prompt</label>
                          <textarea rows={4} value={charDraft.visual_identity_prompt ?? ""} onChange={(e) => setCharDraft((d) => ({ ...d, visual_identity_prompt: e.target.value }))} />
                          <div className="row" style={{ marginTop: 6 }}>
                            <button className="primary" onClick={() => void saveEditChar()}>Save</button>
                            <button className="ghost" onClick={() => setEditingChar(null)}>Cancel</button>
                          </div>
                        </>
                      ) : (
                        <>
                          <p className="hint" style={{ margin: 0 }}>{str(c.visual_identity_prompt) || [str(c.species), str(c.age)].filter(Boolean).join(" · ") || "—"}</p>
                          <div className="row" style={{ marginTop: 6 }}>
                            <button className="ghost shotlist-btn" onClick={() => startEditChar(i)}>Edit</button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {(locs.length > 0 || objs.length > 0) && (
              <>
                <div className="section-label">World · {locs.length} location{locs.length === 1 ? "" : "s"} · {objs.length} object{objs.length === 1 ? "" : "s"}</div>
                <div className="grid grid-compact">
                  {locs.map((l, i) => (
                    <div className="shot" key={String(l.location_id ?? `l${i}`)}>
                      <div className="shot-head" aria-hidden="true">📍 {str(l.name) || `Location ${i + 1}`}</div>
                      <p className="hint" style={{ margin: 0 }}>{str(l.visual_identity_prompt) || str(l.description) || "—"}</p>
                    </div>
                  ))}
                  {objs.map((o, i) => (
                    <div className="shot" key={String(o.object_id ?? `o${i}`)}>
                      <div className="shot-head" aria-hidden="true">🧭 {str(o.name) || `Object ${i + 1}`}</div>
                      <p className="hint" style={{ margin: 0 }}>{str(o.visual_identity_prompt) || str(o.description) || "—"}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {beats.length > 0 && (
              <>
                <div className="section-label">Story beats · {beats.length}</div>
                <div className="shotlist-list">
                  {beats.map((b) => (
                    <div className="shotlist-row" role="row" key={b.n}>
                      <span className="shotlist-shot" role="cell" title={`Beat ${b.n}`}>{b.n}</span>
                      <span className="shotlist-desc" role="cell">
                        <span className="shotlist-desc-title" title={b.title}>{b.title}</span>
                        <span className="shotlist-desc-text" title={b.summary}>{b.summary || "—"}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {board.scenes.length > 0 && (
              <>
                <div className="section-label">Scenes · {board.scenes.length}/{board.sceneCount}</div>
                <div className="grid grid-compact">
                  {board.scenes.map((s, i) => {
                    const selected = selectedScene === i;
                    return (
                      <div className="shot" key={s.scene_number} id={`dir-scene-${s.scene_number}`} style={selected ? { borderColor: "var(--accent-line)" } : undefined}>
                        <div className="shot-head" aria-hidden="true">
                          Scene {s.scene_number}/{board.sceneCount}
                        </div>
                        {editingScene === i ? (
                          <>
                            <label>Title</label>
                            <input value={str(sceneDraft.title ?? "")} maxLength={80} onChange={(e) => setSceneDraft((d) => ({ ...d, title: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Action (visible behavior)</label>
                            <textarea rows={3} value={str(sceneDraft.action ?? "")} onChange={(e) => setSceneDraft((d) => ({ ...d, action: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Emotion</label>
                            <input value={str(sceneDraft.emotion ?? "")} maxLength={60} onChange={(e) => setSceneDraft((d) => ({ ...d, emotion: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Duration (sec)</label>
                            <input type="number" min={1} max={30} value={Number(sceneDraft.duration_seconds ?? s.duration_seconds)} onChange={(e) => setSceneDraft((d) => ({ ...d, duration_seconds: Number(e.target.value) }))} />
                            <label style={{ marginTop: 6 }} title="One per line as speaker: line — voiced per character (Edge-TTS Hindi) and lip-synced; the clip grows to fit the voice">Dialogue (speaker: line per line — voiced + lip-synced)</label>
                            <textarea rows={3} value={dialogueDraft} placeholder={"chiku: नमस्ते! मैं चीकू हूँ।\nshera: कौन है वहाँ?"} onChange={(e) => setDialogueDraft(e.target.value)} />
                            <label style={{ marginTop: 6 }}>Image prompt</label>
                            <textarea rows={4} value={str(sceneDraft.image_prompt ?? "")} onChange={(e) => setSceneDraft((d) => ({ ...d, image_prompt: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Video prompt</label>
                            <textarea rows={4} value={str(sceneDraft.video_prompt ?? "")} onChange={(e) => setSceneDraft((d) => ({ ...d, video_prompt: e.target.value }))} />
                            <div className="row" style={{ marginTop: 6 }}>
                              <button className="primary" onClick={() => void saveEditScene()}>Save scene</button>
                              <button className="ghost" onClick={() => setEditingScene(null)}>Cancel</button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="shotlist-desc-title" title={s.title}>{s.title}</div>
                            <p className="hint" style={{ margin: "4px 0" }}>{s.action || "—"}</p>
                            <span className="muted" style={{ fontSize: 11 }}>
                              {s.camera?.shot_type ?? ""}{s.camera?.movement ? ` · ${s.camera.movement}` : ""} · {s.duration_seconds}s
                              {Array.isArray(s.dialogue) && s.dialogue.length ? ` · 🎙 ${s.dialogue.length} line${s.dialogue.length === 1 ? "" : "s"}` : ""}
                            </span>
                            <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
                              <button
                                className={`ghost shotlist-btn${selected ? " on" : ""}`}
                                onClick={() => selectScene(i)}
                                title={`Show the full breakdown of Scene ${s.scene_number} below`}
                              >
                                Details
                              </button>
                              <button className="ghost shotlist-btn" onClick={() => startEditScene(i)} title={`Edit Scene ${s.scene_number}`}>
                                Edit
                              </button>
                              <button
                                className="ghost shotlist-btn"
                                disabled={regenScene != null || busy != null}
                                onClick={() => void doRegenScene(i)}
                                title={regenScene === i ? "Regenerating…" : `Regenerate Scene ${s.scene_number} with the AI Director`}
                              >
                                {regenScene === i ? <Spinner size={11} /> : <IconRefresh size={11} />}
                                {regenScene === i ? "Working…" : "Regen"}
                              </button>
                              <button
                                className="icon-btn danger"
                                onClick={() => void doDeleteScene(i)}
                                disabled={busy != null}
                                title={`Delete Scene ${s.scene_number}`}
                                aria-label={`Delete Scene ${s.scene_number}`}
                              >
                                <IconTrash size={12} />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const d = selectedScene != null ? board.scenes[selectedScene] : undefined;
                  if (!d) return null;
                  return (
                    <div id="dir-scene-detail" style={{ marginTop: 12 }}>
                      <div className="section-label">
                        Scene details · {d.scene_number}/{board.sceneCount} — {d.title}
                      </div>
                      <div className="shot">
                        <div className="shotlist-detail-grid">
                          <div>
                            <div className="shotlist-detail-label">Story beat</div>
                            <p>{d.story_beat || "—"}</p>
                          </div>
                          <div>
                            <div className="shotlist-detail-label">Duration</div>
                            <p>{d.duration_seconds}s</p>
                          </div>
                        </div>
                        <div className="shotlist-detail-grid">
                          <div>
                            <div className="shotlist-detail-label">Characters</div>
                            <p>{d.characters?.join(", ") || "—"}</p>
                          </div>
                          <div>
                            <div className="shotlist-detail-label">Location</div>
                            <p>{d.location || "—"}</p>
                          </div>
                        </div>
                        <div className="shotlist-detail-grid">
                          <div>
                            <div className="shotlist-detail-label">Time of day</div>
                            <p>{d.time_of_day || "—"}</p>
                          </div>
                          <div>
                            <div className="shotlist-detail-label">Emotion</div>
                            <p>{d.emotion || "—"}</p>
                          </div>
                        </div>
                        <div className="shotlist-detail-label">Action</div>
                        <p>{d.action || "—"}</p>
                        <div className="shotlist-detail-label">Expression / body language</div>
                        <p>{[d.expression, d.body_language].filter(Boolean).join(" · ") || "—"}</p>
                        <div className="shotlist-detail-label">Camera</div>
                        <p>{[d.camera?.shot_type, d.camera?.angle, d.camera?.movement].filter(Boolean).join(" · ") || "—"}</p>
                        <div className="shotlist-detail-grid">
                          <div>
                            <div className="shotlist-detail-label">Lighting</div>
                            <p>{d.lighting || "—"}</p>
                          </div>
                          <div>
                            <div className="shotlist-detail-label">Environment</div>
                            <p>{d.environment || "—"}</p>
                          </div>
                        </div>
                        <div className="shotlist-detail-label">Continuity from previous</div>
                        <p>{d.continuity_from_previous_scene || "—"}</p>
                        <div className="shotlist-detail-label">Transition to next</div>
                        <p>{d.transition_to_next_scene || "—"}</p>
                        <div className="shotlist-detail-label">Image prompt</div>
                        <p>{d.image_prompt || "—"}</p>
                        <div className="shotlist-detail-label">Video prompt</div>
                        <p>{d.video_prompt || "—"}</p>
                        <div className="shotlist-detail-label">Dialogue (voiced per character + lip-synced)</div>
                        {Array.isArray(d.dialogue) && d.dialogue.length ? (
                          <p>{d.dialogue.map((x, i) => (
                            <span key={i} title={`${x.speaker} (voice: per-character Hindi TTS)`}>
                              <b>{x.speaker || "voice"}</b>: {x.line}{i < d.dialogue.length - 1 ? <br /> : null}
                            </span>
                          ))}</p>
                        ) : (
                          <p>—</p>
                        )}
                        <div className="row" style={{ marginTop: 8 }}>
                          <button
                            className="ghost shotlist-btn"
                            disabled={selectedScene == null || selectedScene <= 0}
                            onClick={() => selectScene(Math.max(0, (selectedScene ?? 1) - 1))}
                            title="Previous scene details"
                          >
                            ← Prev
                          </button>
                          <button
                            className="ghost shotlist-btn"
                            disabled={selectedScene == null || selectedScene >= board.scenes.length - 1}
                            onClick={() => selectScene(Math.min(board.scenes.length - 1, (selectedScene ?? -1) + 1))}
                            title="Next scene details"
                          >
                            Next →
                          </button>
                          <span className="spacer" />
                          <button
                            className="ghost shotlist-btn"
                            onClick={() => selectedScene != null && editSceneFromDetail(selectedScene)}
                            title={`Edit Scene ${d.scene_number}`}
                          >
                            Edit scene
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </>
        )}
      </Collapse>
    </section>
  );
}
