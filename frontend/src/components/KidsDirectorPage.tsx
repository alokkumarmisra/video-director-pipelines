import { useEffect, useRef, useState } from "react";
import {
  directorAnalyze, directorScenes, directorApprove, directorBoards,
  directorBoard, directorCoverage, directorValidate, directorRepair,
  directorUploadSong, directorSongUrl, directorDeleteBoard,
  directorAudioTimeline, saveDirectorAudioTimeline,
  estimateDirectorLength, analyzeSong, serviceErrorKind, serviceOfflineKind,
  type DirectorBoard, type DirectorInput, type DirectorScene,
  type DirectorSong, type DirectorSongAnalysis, type DirectorCoverage,
  type DirectorValidation,
  type DirectorAudioTimeline, type DirectorAudioShot,
} from "../api";
import { useDialog } from "./Dialog";
import BatchSizeSelect, { SCENE_BATCH } from "./BatchSizeSelect";
import { IconCheck, IconClapper, IconFilm, IconFolder, IconPanel,
  IconRefresh, IconSparkles, IconTrash, Spinner } from "./Icons";
import Collapse from "./Collapse";

const GENRES = ["Kids", "Educational", "Devotional", "Adventure", "Fantasy", "Comedy", "Custom"];
const EDUCATIONAL_CATEGORIES = [
  "Alphabet & Phonics", "Counting & Math", "Colors & Shapes",
  "Animals & Nature", "Fruits & Vegetables", "Hygiene & Healthy Habits",
  "Good Manners", "Stories & Morals", "Custom",
];
const STYLES = ["3D Preschool Animation", "3D Cinematic", "Cartoon", "Anime", "Custom"];
const LANGS = ["Hindi", "English", "Hinglish"];
const TARGETS = [
  { label: "30 sec", seconds: 30 },
  { label: "1 min", seconds: 60 },
  { label: "2 min", seconds: 120 },
  { label: "3 min", seconds: 180 },
  { label: "5 min", seconds: 300 },
  { label: "Custom", seconds: -1 },
];

const str = (v: unknown): string => (v == null ? "" : String(v));
const fmtT = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n * 10) / 10}s` : "—";
};
const audioClock = (v: number): string => {
  const seconds = Math.max(0, Number(v) || 0);
  const whole = Math.floor(seconds + 0.0001);
  if (whole < 60) return String(whole).padStart(2, "0");
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};

const card = (children: React.ReactNode, style?: React.CSSProperties) => (
  <section className="card" style={{ marginBottom: 16, ...style }}>
    {children}
  </section>
);

const cardHead = (label: string) => (
  <div style={{
    display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
    paddingBottom: 8, borderBottom: "1px solid #e5e7eb",
  }}>
    <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
  </div>
);

const field = (label: string, input: React.ReactNode) => (
  <div style={{ marginBottom: 12 }}>
    <label style={{ display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13 }}>{label}</label>
    {input}
  </div>
);

/**
 * The brief of a Sanskriti Kids project, used to SEED the Director form so
 * the storyboard always matches the studio brief (title, script, language,
 * style, aspect ratio and duration).
 */
export interface KidsDirectorSeed {
  key?: string;
  title?: string;
  story?: string;
  language?: string;
  visualStyle?: string;
  aspectRatio?: string;
  targetSeconds?: number;
  educationalCategory?: string;
}

export default function KidsDirectorPage({ onOpenProject, seed }: {
  onOpenProject: (name: string) => void;
  seed?: KidsDirectorSeed | null;
}) {
  const dialog = useDialog();

  // ---- Panel A: Story input state ----
  const [title, setTitle] = useState("");
  const [story, setStory] = useState("");
  const [mode, setMode] = useState<"story" | "song">("story");
  const [song, setSong] = useState<DirectorSong | null>(null);
  const [storyAudio, setStoryAudio] = useState<DirectorSong | null>(null);
  const [songUploading, setSongUploading] = useState(false);
  // Song analysis: mood, timed segments, narration/visual recommendations.
  const [songAnalysis, setSongAnalysis] = useState<DirectorSongAnalysis | null>(null);
  const [analyzingSong, setAnalyzingSong] = useState(false);

  // Reset song analysis when mode or song changes.
  useEffect(() => {
    setSongAnalysis(null);
  }, [mode, song, storyAudio]);
  const [language, setLanguage] = useState("Hindi");
  const [genre, setGenre] = useState("Kids");
  const [genreCustom, setGenreCustom] = useState("");
  const [eduCategory, setEduCategory] = useState("Alphabet & Phonics");
  const [visualStyle, setVisualStyle] = useState("3D Preschool Animation");
  const [styleCustom, setStyleCustom] = useState("");
  const [targetOpt, setTargetOpt] = useState(60);
  const [targetCustom, setTargetCustom] = useState("90");
  const [autoTarget, setAutoTarget] = useState(true);
  const [autoTargetSeconds, setAutoTargetSeconds] = useState(60);
  const [estimatingTarget, setEstimatingTarget] = useState(false);
  const [targetNote, setTargetNote] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  // Seed the form from the studio brief (the storyboard must never drift from
  // the brief). The user's own edits are never overwritten while they work on
  // the same brief — the seed only re-applies when a DIFFERENT project is
  // selected.
  const seededKey = useRef<string | null>(null);
  useEffect(() => {
    if (!seed) return;
    const key = seed.key || seed.title || "";
    if (!key || seededKey.current === key) return;
    seededKey.current = key;
    if (seed.title) setTitle(seed.title);
    if (seed.story) { setStory(seed.story); setMode("story"); }
    if (seed.language) setLanguage(seed.language);
    if (seed.visualStyle) setVisualStyle(seed.visualStyle);
    if (seed.aspectRatio) setAspectRatio(seed.aspectRatio);
    if (seed.educationalCategory) setEduCategory(seed.educationalCategory);
    if (seed.targetSeconds && seed.targetSeconds > 0) {
      const seconds = Math.round(seed.targetSeconds);
      setTargetOpt(seconds);
      setAutoTarget(false);
      setAutoTargetSeconds(seconds);
    }
  }, [seed]);
  const [instructions, setInstructions] = useState("");
  const [suggestingInstructions, setSuggestingInstructions] = useState(false);
  const [instructionsNote, setInstructionsNote] = useState<string | null>(null);
  const [includeDialogue, setIncludeDialogue] = useState(true);
  const [chainContinuity, setChainContinuity] = useState(true);

  const currentAudio = mode === "song" ? song : storyAudio;
  const targetSeconds = currentAudio
    ? Math.max(0.1, currentAudio.durationSeconds)
    : autoTarget ? autoTargetSeconds : targetOpt === -1 ? Math.max(15, Number(targetCustom) || 60) : targetOpt;

  useEffect(() => {
    if (!autoTarget || mode !== "story") return;
    if (story.trim().length < 20) return;
    const t = window.setTimeout(() => {
      const words = story.split(/\s+/).filter(Boolean).length;
      const lines = story.split("\n").map((l) => l.trim()).filter(Boolean).length;
      const raw = 20 + words * 0.45 + lines * 1.2;
      setAutoTargetSeconds(Math.min(300, Math.max(30, Math.round(raw / 5) * 5)));
    }, 700);
    return () => window.clearTimeout(t);
  }, [story, autoTarget, mode]);

  const handleAiTarget = async () => {
    if (estimatingTarget || story.trim().length < 20) return;
    setEstimatingTarget(true); setTargetNote(null);
    try {
      const r = await estimateDirectorLength(story, {
        title: title.trim(),
        genre: genre === "Custom" && genreCustom.trim() ? genreCustom.trim() : genre,
        language,
      });
      setAutoTargetSeconds(Math.min(300, Math.max(15, Math.round(Number(r.duration) || 60))));
      setTargetNote(r.source === "llm"
        ? `AI set ~${r.duration}s${r.reasoning ? ` — ${r.reasoning}` : ""}`
        : `LLM offline — heuristic set ~${r.duration}s`);
      if (r.source !== "llm") {
        await dialog.alert(
          "AI length needs LM Studio / llama-server but it is unreachable — " +
          `duration was set with the offline heuristic (~${r.duration}s). ` +
          "Start LM Studio with a model loaded, check LLM_BASE, then retry.",
          { title: "LLM API offline", tone: "error" });
      }
    } catch (e) {
      setTargetNote(e instanceof Error ? e.message : String(e));
      alertIfLlm(String(e));
    } finally { setEstimatingTarget(false); }
  };

  const handleSuggestInstructions = async () => {
    if (story.trim().length < 20 && !title.trim()) {
      setInstructionsNote("Paste the story (20+ characters) or give it a title first.");
      return;
    }
    setSuggestingInstructions(true); setInstructionsNote(null);
    try {
      const r = await fetch("/api/director-instructions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          story, title: title.trim(),
          genre: genre === "Custom" && genreCustom.trim() ? genreCustom.trim() : genre,
          visualStyle: visualStyle === "Custom" && styleCustom.trim() ? styleCustom.trim() : visualStyle,
          language, existing: instructions.trim(),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "suggest failed");
      setInstructions(d.instructions);
      setInstructionsNote(d.reasoning ? `AI drafted instructions — ${d.reasoning}` : "AI drafted instructions — review and edit.");
    } catch (e) {
      setInstructionsNote(e instanceof Error ? e.message : String(e));
    } finally { setSuggestingInstructions(false); }
  };

  const uploadDirectorAudio = async (f: File | undefined, save: (audio: DirectorSong) => void) => {
    if (!f) return;
    setError(""); setSongUploading(true);
    try {
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(new Error("could not read the audio file"));
        r.readAsDataURL(f);
      });
      const up = await directorUploadSong(data, f.name);
      save({ ...up, hasLyrics: story.trim().length >= 20, transcript: { status: "not_configured", text: "", segments: [], note: "Transcription runs when you analyze the audio." } });
      if (!title.trim()) {
        const base = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
        if (base) setTitle(base.slice(0, 120));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSongUploading(false); }
  };
  const onSongFile = (f: File | undefined) => uploadDirectorAudio(f, setSong);
  const onStoryAudioFile = (f: File | undefined) => uploadDirectorAudio(f, setStoryAudio);

  const doAnalyzeSong = async () => {
    const audio = mode === "song" ? song : storyAudio;
    if (analyzingSong || !audio) return;
    setAnalyzingSong(true); setError("");
    try {
      const a = await analyzeSong({
        title: title.trim() || audio.fileName,
        lyrics: story.trim(),
        genre,
        language,
        durationSeconds: audio.durationSeconds,
        file: audio.file,
        audioMode: mode,
      });
      setSongAnalysis(a);
      if (!story.trim() && (a.transcript?.text || "").trim().length >= 20) {
        const phraseLines = a.transcript?.segments?.map((s) => s.text.trim()).filter(Boolean) || [];
        setStory(phraseLines.length ? phraseLines.join("\n") : a.transcript!.text);
      }
      // Auto-fill form fields from the analysis when they are not already set.
      if (!instructions.trim()) {
        setInstructions(
          `Mood: ${a.mood}. Narration: ${a.narrationStyle}. Visual: ${a.visualStyle}. Educational: ${a.educationalFocus}.`
        );
      }
      if (!targetNote) setTargetNote(`AI song analysis: ~${a.durationSeconds}s, ${a.source}`);
    } catch (e) {
      reportError(e);
    } finally { setAnalyzingSong(false); }
  };

  // ---- Boards state ----
  const [boards, setBoards] = useState<{ id: string; title: string; scenes: number; sceneCount: number; project_id?: number | null }[]>([]);
  const [board, setBoard] = useState<DirectorBoard | null>(null);
  const [audioTimeline, setAudioTimeline] = useState<DirectorAudioTimeline | null>(null);
  const [timelineSaving, setTimelineSaving] = useState(false);
  const [timelineError, setTimelineError] = useState("");
  const [busy, setBusy] = useState<{ label: string; since: number } | null>(null);
  const [error, setError] = useState("");
  const [generatingRange, setGeneratingRange] = useState<{ from: number; to: number } | null>(null);
  // Scene-planning batch size (scenes per AI Director LLM batch) — chosen
  // from the Batch Size dropdown before Generate Scenes / Continue Planning.
  const [sceneBatch, setSceneBatch] = useState<number>(SCENE_BATCH);
  const [coverage, setCoverage] = useState<DirectorCoverage | null>(null);
  const [validation, setValidation] = useState<DirectorValidation | null>(null);
  const [intelBusy, setIntelBusy] = useState<"check" | "repair" | null>(null);
  const [stoppedNote, setStoppedNote] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const songPlayerRef = useRef<HTMLAudioElement | null>(null);

  const refreshBoards = async () => {
    try { setBoards(await directorBoards()); } catch { /* best-effort */ }
  };
  useEffect(() => { void refreshBoards(); }, []);

  const alertIfLlm = (msg: string) => { void dialog.alert(msg, { title: "LLM API offline", tone: "error" }); };
  const reportError = (e: unknown, suffix = "") => {
    const msg = `${e instanceof Error ? e.message : String(e)}${suffix}`;
    setError(msg);
    const kind = serviceOfflineKind(msg);
    if (kind === "llm") alertIfLlm(msg);
    else if (kind === "comfy") {
      void dialog.alert(msg, { title: "ComfyUI API offline", tone: "error" });
    } else {
      void dialog.alert(msg, { title: "Sanskriti Kids Director request failed", tone: "error" });
    }
  };

  const loadAudioTimeline = async (id: string, hasAudio = true) => {
    if (!hasAudio) { setAudioTimeline(null); setTimelineError(""); return; }
    try { setAudioTimeline(await directorAudioTimeline(id)); setTimelineError(""); }
    catch (e) { setTimelineError(e instanceof Error ? e.message : String(e)); }
  };

  const openBoard = async (id: string) => {
    setError(""); setCoverage(null); setValidation(null); setStoppedNote(null); setAudioTimeline(null);
    try { const b = await directorBoard(id); setBoard(b); await loadAudioTimeline(id, !!(b.input.song || b.input.sourceAudio)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const editAudioShot = (index: number, patch: Partial<DirectorAudioShot>) => {
    setAudioTimeline(current => current ? ({
      ...current,
      shots: current.shots.map((shot, i) => i === index ? { ...shot, ...patch } : shot),
    }) : current);
  };

  const editAudioBoundary = (index: number, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || !audioTimeline) return;
    const boundary = Math.max(0, Math.min(audioTimeline.duration_seconds, Math.round(value * 1000) / 1000));
    setAudioTimeline(current => {
      if (!current || index >= current.shots.length - 1) return current;
      const shots = current.shots.map(s => ({ ...s }));
      shots[index].end_seconds = boundary;
      shots[index].duration_seconds = Math.round((boundary - shots[index].start_seconds) * 1000) / 1000;
      shots[index + 1].start_seconds = boundary;
      shots[index + 1].duration_seconds = Math.round((shots[index + 1].end_seconds - boundary) * 1000) / 1000;
      return { ...current, shots };
    });
  };

  const saveAudioTimeline = async () => {
    if (!board || !audioTimeline || timelineSaving) return;
    setTimelineSaving(true); setTimelineError("");
    try { setAudioTimeline(await saveDirectorAudioTimeline(board.id, audioTimeline)); }
    catch (e) { setTimelineError(e instanceof Error ? e.message : String(e)); }
    finally { setTimelineSaving(false); }
  };

  const doIntelCheck = async () => {
    if (!board || intelBusy) return;
    setIntelBusy("check"); setError("");
    try {
      const [cov, val] = await Promise.all([directorCoverage(board.id), directorValidate(board.id)]);
      setCoverage(cov); setValidation(val);
    } catch (e) { reportError(e); } finally { setIntelBusy(null); }
  };

  const doIntelRepair = async () => {
    if (!board || intelBusy) return;
    setIntelBusy("repair"); setError("");
    try {
      const r = await directorRepair(board.id);
      setBoard(r.board); await refreshBoards();
      const [cov, val] = await Promise.all([directorCoverage(board.id), directorValidate(board.id)]);
      setCoverage(cov); setValidation(val);
    } catch (e) { reportError(e); } finally { setIntelBusy(null); }
  };

  const doAnalyze = async () => {
    if (busy) return;
    const lyrics = story.trim();
    const hasLyrics = lyrics.length >= 20;
    const input: DirectorInput = {
      title: title.trim(),
      story: mode === "song" && !hasLyrics
        ? `[Instrumental song "${title.trim()}" — no lyrics provided]`
        : lyrics,
      language, genre,
      genreCustom: genre === "Custom" ? genreCustom.trim() : "",
      visualStyle, styleCustom: visualStyle === "Custom" ? styleCustom.trim() : "",
      targetSeconds, sceneSeconds: Number(autoTargetSeconds / Math.max(1, Math.round(autoTargetSeconds / 30))) || 3,
      aspectRatio, instructions: instructions.trim(),
      includeDialogue, chainContinuity,
      ...(mode === "song" && song ? { song: { ...song, hasLyrics } } : {}),
      ...(mode === "story" && storyAudio ? { sourceAudio: storyAudio } : {}),
      ...(songAnalysis ? { songAnalysis } : {}),
    };
    if (!input.title) { setError("Give the story a title."); return; }
    if (mode === "song" && !song) { setError("Upload the song first."); return; }
    if (mode === "story" && input.story.length < 20) { setError("Paste the story or lyrics (20+ characters)."); return; }
    setBusy({ label: "Analyzing story — characters, locations, beats…", since: Date.now() });
    setError("");
    try {
      const b = await directorAnalyze(input);
      setBoard(b); await refreshBoards(); await loadAudioTimeline(b.id, !!(input.song || input.sourceAudio));
    } catch (e) { reportError(e); } finally { setBusy(null); }
  };

  const doScenes = async () => {
    if (!board || busy) return;
    cancelRef.current = false;
    setBusy({ label: "Planning scenes…", since: Date.now() }); setError(""); setStoppedNote(null);
    try {
      let b = board;
      while (b.scenes.length < b.sceneCount) {
        if (cancelRef.current) break;
        const batchEnd = Math.min(b.sceneCount, b.scenes.length + sceneBatch);
        setGeneratingRange({ from: b.scenes.length + 1, to: batchEnd });
        b = await directorScenes(b.id, sceneBatch);
        setBoard(b);
      }
      const endOpen = Number.isFinite(targetSeconds) && targetSeconds > 0 &&
        (targetSeconds - boardPlannedSeconds(b.scenes)) > Math.max(1, (Number(b.input.sceneSeconds) || 3) / 2);
      if (cancelRef.current && endOpen) {
        setStoppedNote(`Stopped at ~${boardPlannedSeconds(b.scenes)}s of ~${Math.round(targetSeconds)}s — press Continue to resume.`);
      }
    } catch (e) {
      if (/already running/i.test(String(e))) {
        setStoppedNote("Planning is already running — wait a moment, then Continue.");
      } else {
        reportError(e, " — partial scenes are kept, retry continues.");
      }
    } finally {
      if (board?.id) await loadAudioTimeline(board.id, !!(board.input.song || board.input.sourceAudio));
      setBusy(null); setGeneratingRange(null); cancelRef.current = false;
    }
  };

  const doStop = () => { cancelRef.current = true; setBusy(null); };

  const doApprove = async () => {
    if (!board) return;
    setBusy({ label: "Approving storyboard → saving project…", since: Date.now() });
    try {
      const r = await directorApprove(board.id);
      setError("");
      await dialog.alert(
        `Storyboard approved and saved as project "${r.name}". It will appear in your Projects panel.`,
        { title: "Approved", tone: "success" });
      await refreshBoards();
      if (onOpenProject) onOpenProject(r.name);
    } catch (e) { reportError(e); } finally { setBusy(null); }
  };

  const doDeleteBoard = async (id: string) => {
    if (!confirm("Delete this storyboard? Its scenes and beats will be lost.")) return;
    try { await directorDeleteBoard(id); setBoards(boards.filter((b) => b.id !== id)); if (board?.id === id) setBoard(null); }
    catch (e) { reportError(e); }
  };

  const boardPlannedSeconds = (scenes: DirectorScene[]): number =>
    Math.round(scenes.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0) * 10) / 10;

  const progressPct = board ? Math.round(Math.min(100, (board.scenes.length / Math.max(1, board.sceneCount)) * 100)) : 0;

  const songUrl = currentAudio ? directorSongUrl(currentAudio.file) : null;

  // The audio Analysis panel — rendered inside the upload section (just below the
  // Analyze button) instead of as a separate card further down the page.
  const renderAudioAnalysis = (heading: string) => (
    <div style={{ marginTop: 12, padding: 12, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>{heading}</div>
      {!songAnalysis ? (
        <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>
          Press the Analyze button above — the audio is read for mood, structure, timed
          segments, a Whisper transcript and a visual-style recommendation.
        </p>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 12 }}>
            <div style={{ padding: 10, background: "#f3f4f6", borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, marginBottom: 4 }}>Mood</div>
              <div style={{ fontSize: 13 }}>{songAnalysis.mood}</div>
            </div>
            <div style={{ padding: 10, background: "#f0fdf4", borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: "#15803d", fontWeight: 600, marginBottom: 4 }}>Structure</div>
              <div style={{ fontSize: 13 }}>{songAnalysis.structure}</div>
            </div>
            <div style={{ padding: 10, background: "#fef3c7", borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: "#92400e", fontWeight: 600, marginBottom: 4 }}>Narration Style</div>
              <div style={{ fontSize: 13 }}>{songAnalysis.narrationStyle}</div>
            </div>
            <div style={{ padding: 10, background: "#f3e8ff", borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: "#6b21a8", fontWeight: 600, marginBottom: 4 }}>Educational Focus</div>
              <div style={{ fontSize: 13 }}>{songAnalysis.educationalFocus}</div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginBottom: 12 }}>
            <div className="card" style={{ padding: 9, margin: 0 }}><b>BPM estimate</b><div>{songAnalysis.measured?.signal?.bpm ?? "Not confident"} {songAnalysis.measured?.signal?.bpm != null && `· ${Math.round(songAnalysis.measured.signal.bpmConfidence * 100)}% confidence`}</div></div>
            <div className="card" style={{ padding: 9, margin: 0 }}><b>Musical key estimate</b><div>{songAnalysis.measured?.signal?.keyEstimate?.key ?? "Uncertain"} · {Math.round((songAnalysis.measured?.signal?.keyEstimate?.confidence || 0) * 100)}%</div></div>
            <div className="card" style={{ padding: 9, margin: 0 }}><b>Beats detected</b><div>{songAnalysis.measured?.signal?.beatTimes?.length ?? 0} · estimated</div></div>
            <div className="card" style={{ padding: 9, margin: 0 }}><b>Vocal activity</b><div>{songAnalysis.measured?.signal?.vocalActivity?.status === "not_estimated" ? "Not estimated" : songAnalysis.measured?.signal?.vocalActivity?.status ?? "Unavailable"}</div></div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={{ display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13 }}>
              Song Timeline ({songAnalysis.segments.length} segments)
            </label>
            <div style={{ display: "flex", gap: 6, height: 40, alignItems: "center" }}>
              {songAnalysis.segments.map((seg, i) => {
                const pctStart = (seg.start / songAnalysis.durationSeconds) * 100;
                const pctWidth = ((seg.end - seg.start) / songAnalysis.durationSeconds) * 100;
                return (
                  <div
                    key={i}
                    style={{
                      position: "relative",
                      flex: 1,
                      minWidth: 60,
                      height: "100%",
                      borderRadius: 6,
                      overflow: "hidden",
                      border: "1px solid #e5e7eb",
                      background: "#f9fafb",
                    }}
                  >
                    <div
                      style={{
                        height: "60%",
                        background: "var(--accent)",
                        width: `${Math.max(pctWidth, 8)}%`,
                        margin: "auto",
                        borderRadius: 4,
                      }}
                    />
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {seg.label}
                      </div>
                      <div style={{ fontSize: 10, color: "#666" }}>{seg.start}s–{seg.end}s</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ position: "relative", height: 28, marginTop: 8, borderRadius: 5, background: "#f3f4f6", overflow: "hidden", border: "1px solid #e5e7eb" }}>
              {songAnalysis.segments.map((seg, i) => <div key={`timeline-${i}`} title={`${seg.label}: ${seg.start}s–${seg.end}s · ${seg.mood}`} style={{ position: "absolute", top: 0, bottom: 0, left: `${Math.max(0, seg.start / songAnalysis.durationSeconds * 100)}%`, width: `${Math.max(.5, (seg.end - seg.start) / songAnalysis.durationSeconds * 100)}%`, background: ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24"][i % 4], opacity: .7, borderRight: "1px solid white" }} />)}
              {songAnalysis.segments.map((seg, i) => <span key={`label-${i}`} style={{ position: "absolute", top: 6, left: `${Math.max(0, seg.start / songAnalysis.durationSeconds * 100)}%`, fontSize: 10, paddingLeft: 3, color: "#111827", whiteSpace: "nowrap" }}>{seg.label} · {seg.start}s</span>)}
              {(songAnalysis.measured?.signal?.beatTimes || []).map((t, i) => <i key={`beat-${i}`} title={`Estimated beat at ${t}s`} style={{ position: "absolute", top: 0, bottom: 0, left: `${t / songAnalysis.durationSeconds * 100}%`, width: 1, background: "#111827", opacity: .45 }} />)}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", marginTop: 2 }}><span>0s</span><span>{songAnalysis.durationSeconds}s</span></div>
            {songAnalysis.transcript?.segments?.length ? <div style={{ marginTop: 10, border: "1px solid #e2e8f0", borderRadius: 6, overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 9px", background: "#fffbeb", fontSize: 12, fontWeight: 600 }}>
                <span>Whisper transcript timeline · {songAnalysis.transcript.segments.length} timed phrases</span>
                <span style={{ fontWeight: 400, color: "#64748b" }}>Tap ▶ to preview from that time</span>
              </div>
              {songUrl && <audio ref={songPlayerRef} controls preload="none" src={songUrl} style={{ width: "100%", height: 34 }} />}
              <div style={{ maxHeight: 240, overflowY: "auto" }}>
                {songAnalysis.transcript.segments.map((line, i) => <div key={`lyric-${i}`} style={{ display: "grid", gridTemplateColumns: "44px 92px minmax(0, 1fr)", gap: 8, alignItems: "start", padding: "5px 8px", borderTop: "1px solid #f1f5f9", fontSize: 12, background: i % 2 ? "#fff" : "#f8fafc" }}>
                  <button className="btn" title={`Play from ${line.start.toFixed(1)} seconds`} aria-label={`Play transcript at ${line.start.toFixed(1)} seconds`} onClick={() => { const player = songPlayerRef.current; if (player) { player.currentTime = line.start; void player.play(); } }} style={{ padding: "1px 5px", minHeight: 22, fontSize: 11 }}>▶</button>
                  <span style={{ color: "#64748b", fontVariantNumeric: "tabular-nums" }}>{line.start.toFixed(1)}–{line.end.toFixed(1)}s</span>
                  <span lang={language === "Hindi" ? "hi" : undefined} style={{ lineHeight: 1.45, overflowWrap: "anywhere" }}>{line.text}</span>
                </div>)}
              </div>
            </div> : null}
            <div style={{ marginTop: 8, fontSize: 12, color: "#4b5563" }}>
              {songAnalysis.segments.map((seg, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 11, color: "#666", minWidth: 60 }}>{seg.label}</span>
                  <span style={{ fontSize: 12 }}>{seg.action}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ margin: "10px 0", padding: 10, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6 }}>
            <label style={{ display: "block", fontWeight: 600, fontSize: 13, marginBottom: 5 }}>Lyrics / transcript · {songAnalysis.transcript?.status === "complete" ? "Whisper · please review" : songAnalysis.transcript?.status === "unavailable" ? "Transcription unavailable" : "Whisper not configured — paste/edit lyrics here"}</label>
            <textarea value={story} onChange={e => setStory(e.target.value)} rows={4} className="input" placeholder="Paste or correct the lyrics; these will be used by Analyze Story." style={{ width: "100%" }} />
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{songAnalysis.transcript?.note || "The transcript is not inferred when no speech model is configured."}</div>
          </div>

          <div style={{ fontSize: 12, color: "#64748b" }}>
            Measured loudness: {songAnalysis.measured?.meanVolumeDb ?? "—"} dB · peak {songAnalysis.measured?.peakVolumeDb ?? "—"} dB · analysis: {songAnalysis.measured?.signal ? "FFmpeg PCM estimates" : songAnalysis.measured?.source || "unavailable"}. Beat/key values are estimates; vocal activity detection needs an additional model.
          </div>

          <div style={{ marginTop: 10, padding: 10, background: "#e0f2fe", borderRadius: 6, fontSize: 12 }}>
            <strong>Visual style recommendation:</strong> {songAnalysis.visualStyle}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="page kids-director-page" style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <IconFilm size={24} />
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>🧒 Sanskriti Kids Director</h1>
          <p style={{ margin: 2, fontSize: 13, color: "#6b7280" }}>
            Turn children's lyrics & stories into animated videos — story analysis, character bible, storyboard, animation, final render.
          </p>
        </div>
      </div>

      {error && (
        <div style={{ padding: 10, background: "#fee2e2", color: "#991b1b", borderRadius: 6, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* ===== PANEL A — STORY INPUT ===== */}
      {card(
        <>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12 }}>Panel A — Story Input</div>

          <div>
            <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" placeholder="e.g. A for Apple / बंदर और कथा" />
          </div>

          <div style={{ marginTop: 10 }}>
            <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Mode</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={() => setMode("story")} style={{ flex: 1, background: mode === "story" ? "var(--accent)" : "inherit", color: mode === "story" ? "#fff" : "inherit" }}>Story / Lyrics</button>
              <button className="btn" onClick={() => setMode("song")} style={{ flex: 1, background: mode === "song" ? "var(--accent)" : "inherit", color: mode === "song" ? "#fff" : "inherit" }}>Song Audio</button>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Lyrics / Story</label>
            <textarea value={story} onChange={(e) => setStory(e.target.value)} rows={6} className="input" placeholder="Paste children's lyrics or an educational story…" />
            {mode === "song" && (
              <div style={{ marginTop: 10 }}>
                <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Upload Song (mp3/wav)</label>
                <input type="file" accept="audio/*" onChange={(e) => onSongFile(e.target.files?.[0])} className="input" />
                {songUploading && <span style={{ marginLeft: 8, fontSize: 12, color: "#666" }}>(uploading…)</span>}
                {song && (
                  <div style={{ marginTop: 6, fontSize: 13, color: "#666" }}>
                    {song.fileName} · ~{Math.round(song.durationSeconds)}s
                    {songUrl && ` · <a href="${songUrl}" target="_blank" rel="noopener">preview</a>`}
                  </div>
                )}
                {/* Analyze Song — same section, just below the upload */}
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    className="btn"
                    onClick={doAnalyzeSong}
                    disabled={analyzingSong || songUploading || !song}
                    title={song ? "Read the song — mood, structure, timed segments, transcript" : "Upload a song first"}
                    style={{ padding: "8px 16px", fontSize: 13 }}
                  >
                    {analyzingSong ? <Spinner size={14} /> : songAnalysis ? "Re-analyze Song" : "Analyze Song"}
                  </button>
                  {analyzingSong && <span style={{ fontSize: 12, color: "#666" }}>reading song…</span>}
                </div>
                {renderAudioAnalysis("🎵 Song Analysis")}
              </div>
            )}
            {mode === "story" && (
              <div style={{ marginTop: 10 }}>
                <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Optional narration / dialogue audio (mp3/wav)</label>
                <input type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" onChange={(e) => onStoryAudioFile(e.target.files?.[0])} className="input" />
                {songUploading && <span style={{ marginLeft: 8, fontSize: 12, color: "#666" }}>(uploading…)</span>}
                {storyAudio && <div style={{ marginTop: 6, fontSize: 13, color: "#666" }}>{storyAudio.fileName} · ~{Math.round(storyAudio.durationSeconds)}s{songUrl && <> · <a href={songUrl} target="_blank" rel="noopener">preview</a></>}</div>}
                {/* Analyze narration — same section, just below the upload */}
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    className="btn"
                    onClick={doAnalyzeSong}
                    disabled={analyzingSong || songUploading || !storyAudio}
                    title={storyAudio ? "Read the narration audio — mood, structure, timed segments, transcript" : "Upload narration audio first"}
                    style={{ padding: "8px 16px", fontSize: 13 }}
                  >
                    {analyzingSong ? <Spinner size={14} /> : songAnalysis ? "Re-analyze narration" : "Analyze narration audio"}
                  </button>
                  {analyzingSong && <span style={{ fontSize: 12, color: "#666" }}>reading audio…</span>}
                </div>
                {renderAudioAnalysis("🎙️ Narration Audio Analysis")}
              </div>
            )}
          </div>

          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            {[
              { label: "Language", options: LANGS, value: language, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setLanguage(e.target.value) },
              { label: "Genre", options: GENRES, value: genre, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setGenre(e.target.value); if (e.target.value !== "Custom") setGenreCustom(""); } },
              { label: "Educational Category", options: EDUCATIONAL_CATEGORIES, value: eduCategory, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setEduCategory(e.target.value) },
              { label: "Visual Style", options: STYLES, value: visualStyle, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setVisualStyle(e.target.value); if (e.target.value !== "Custom") setStyleCustom(""); } },
            ].map((f) => (
              <div key={f.label}>
                <label style={{ display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13 }}>{f.label}</label>
                <select value={f.value} onChange={f.onChange as any} className="input" style={{ width: "100%" }}>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                {(f.label === "Genre" && genre === "Custom") || (f.label === "Visual Style" && visualStyle === "Custom") ? (
                  <input value={f.label === "Genre" ? genreCustom : styleCustom} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    if (f.label === "Genre") setGenreCustom(e.target.value);
                    else setStyleCustom(e.target.value);
                  }} className="input" style={{ width: "100%", marginTop: 6 }} placeholder={f.label === "Genre" ? "e.g. Hindi rhyme" : "e.g. cute 3D cartoon"} />
                ) : null}
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14, display: "flex", gap: 12, alignItems: "end" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>Target Duration</label>
              <select value={targetOpt} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setTargetOpt(Number(e.target.value)); setAutoTarget(false); }} className="input">
                {TARGETS.map((t) => <option key={t.seconds} value={t.seconds}>{t.label}</option>)}
              </select>
              {targetOpt === -1 && (
                <input value={targetCustom} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTargetCustom(e.target.value)} className="input" style={{ width: 80 }} placeholder="secs" />
              )}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", userSelect: "none" }}>
              <input type="checkbox" checked={autoTarget} onChange={(e) => setAutoTarget(e.target.checked)} /> Auto length from text
            </label>
            {autoTarget && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <span>~{autoTargetSeconds}s</span>
                <button className="btn" onClick={handleAiTarget} disabled={estimatingTarget} style={{ padding: "4px 10px", fontSize: 12 }}>
                  {estimatingTarget ? <Spinner size={14} /> : "✨ AI length"}
                </button>
                {targetNote && <span style={{ fontSize: 11, color: "#666", marginLeft: 6 }}>{targetNote}</span>}
              </div>
            )}
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", userSelect: "none" }}>
              <input type="checkbox" checked={includeDialogue} onChange={(e) => setIncludeDialogue(e.target.checked)} /> Include dialogue (voice + lip-sync)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", userSelect: "none" }}>
              <input type="checkbox" checked={chainContinuity} onChange={(e) => setChainContinuity(e.target.checked)} /> Connected scenes (visual continuity)
            </label>
          </div>

          <div style={{ marginTop: 14 }}>
            <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>Director Instructions (optional)</label>
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} className="input" placeholder="Any special directing notes…" style={{ width: "100%" }} />
          </div>

          <div style={{ marginTop: 14, display: "flex", gap: 10 }}>
            <button className="btn" onClick={handleSuggestInstructions} disabled={suggestingInstructions} style={{ padding: "8px 16px", fontSize: 13 }}>
              {suggestingInstructions ? <Spinner size={14} /> : "✨ Get AI Instructions"}
            </button>
            <button className="btn primary" onClick={doAnalyze} disabled={!!busy} style={{ padding: "10px 20px", fontSize: 14 }}>
              {busy ? <Spinner size={16} /> : "Analyze Story"}
            </button>
          </div>
        </>
      )}

      {/* ===== PANELS B-F (only after analysis) ===== */}
      {board && (
        <>
          {/* Panel B — AI Story Analysis */}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>Panel B — AI Story Analysis ({board.status})</div>
              <div style={{ padding: 12, background: "#f3f4f6", borderRadius: 6, marginBottom: 12 }}>
                <strong>{str(board.input.title)}</strong>
                {board.input.song ? ` · Song: ${board.input.song.fileName} (~${board.input.song.durationSeconds}s)` : ""}
                <br />
                {str(board.blueprint?.logline) && <span style={{ marginTop: 6, display: "block" }}>Logline: {board.blueprint?.logline}</span>}
                <span style={{ display: "inline-block", marginTop: 6, fontSize: 13, color: "#666" }}>
                  {board.scenes.length} / {board.sceneCount} scenes · ~{boardPlannedSeconds(board.scenes)}s planned of ~{targetSeconds}s target
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 12 }}>
                {[{
                  label: "Characters", color: "#0369a1", bg: "#e0f2fe", value: Array.isArray(board.blueprint?.characters) ? board.blueprint.characters.length : 0,
                }, {
                  label: "Locations", color: "#15803d", bg: "#f0fdf4", value: Array.isArray(board.blueprint?.locations) ? board.blueprint.locations.length : 0,
                }, {
                  label: "Objects / Props", color: "#92400e", bg: "#fef3c7", value: Array.isArray(board.blueprint?.objects) ? board.blueprint.objects.length : 0,
                }, {
                  label: "Beats", color: "#6b21a8", bg: "#f3e8ff", value: Array.isArray(board.blueprint?.beats) ? board.blueprint.beats.length : 0,
                }].map((stat) => (
                  <div key={stat.label} style={{ padding: 12, background: stat.bg, borderRadius: 6 }}>
                    <div style={{ fontSize: 12, color: stat.color, fontWeight: 600, marginBottom: 4 }}>{stat.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>{stat.value}</div>
                  </div>
                ))}
              </div>

              {board.blueprint?.analysis && (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13 }}>Analysis</label>
                  <div style={{ padding: 10, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13 }}>
                    {Object.entries(board.blueprint.analysis as Record<string, unknown>).map(([k, v]) => (
                      <div key={k} style={{ marginBottom: 4 }}><strong>{k}:</strong> {str(v)}</div>
                    ))}
                  </div>
                </div>
              )}

              <BatchSizeSelect value={sceneBatch} onChange={setSceneBatch} disabled={!!busy} />
              <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                <button className="btn primary" onClick={doScenes} disabled={!!busy} style={{ flex: 1 }}>
                  {busy ? <Spinner size={16} /> : board.scenes.length < board.sceneCount ? "Generate Scenes" : "Continue Planning"}
                </button>
                <button className="btn" onClick={doStop} disabled={!busy} style={{ padding: "10px 16px" }}>Stop</button>
                {stoppedNote && <span style={{ fontSize: 12, color: "#666", marginLeft: 8 }}>{stoppedNote}</span>}
              </div>
              {generatingRange && (
                <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
                  Planning scenes {generatingRange.from}–{generatingRange.to} of {board.sceneCount}…
                </div>
              )}
              {progressPct > 0 && board.scenes.length < board.sceneCount && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>{progressPct}% scenes planned</div>
                  <div style={{ height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${progressPct}%`, background: "var(--accent)" }} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* Persisted audio-to-visual shot timeline */}
          {audioTimeline && card(
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>Audio-to-Visual Shot Timeline</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>{audioTimeline.director_mode === "music_video" ? "Music Video Director" : "Story Video Director"} · {audioTimeline.shots.length} shots · exact source end {audioTimeline.duration_seconds.toFixed(3)}s</div>
                </div>
                <button className="btn primary" onClick={saveAudioTimeline} disabled={timelineSaving}>
                  {timelineSaving ? <Spinner size={14} /> : "Save Timeline"}
                </button>
              </div>
              {timelineError && <div style={{ padding: 8, color: "#991b1b", background: "#fee2e2", borderRadius: 5, marginBottom: 8, fontSize: 12 }}>{timelineError}</div>}
              {audioTimeline.warnings.map((warning, i) => <div key={i} style={{ fontSize: 11, color: "#92400e", margin: "3px 0" }}>⚠ {warning}</div>)}
              <div aria-label="Full audio timeline" style={{ display: "flex", height: 28, gap: 1, margin: "10px 0", overflow: "hidden", borderRadius: 5, background: "#e2e8f0" }}>
                {audioTimeline.shots.map((shot, i) => <div key={shot.shot_id} title={`${shot.start_seconds.toFixed(2)}–${shot.end_seconds.toFixed(2)}s · ${shot.audio_type} · ${shot.lyrics_or_dialogue || shot.action}`} style={{ flex: `${Math.max(.1, shot.duration_seconds)} 1 0`, minWidth: 2, background: shot.audio_type === "vocal" ? "#fbbf24" : shot.audio_type === "dialogue" ? "#a78bfa" : shot.audio_type === "instrumental" ? "#38bdf8" : "#34d399", borderRight: i < audioTimeline.shots.length - 1 ? "1px solid white" : "none" }} />)}
              </div>
              <div style={{ fontWeight: 600, fontSize: 13, margin: "12px 0 6px" }}>Time-coded audio timeline</div>
              <div style={{ maxHeight: 420, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 6, marginBottom: 10 }}>
                {audioTimeline.shots.map((shot, index) => {
                  const names = shot.character_ids.map(id => {
                    const character = board.blueprint?.characters?.find(c => String(c.character_id || "") === id);
                    return character ? str(character.name) : id;
                  });
                  const voice = shot.audio_type === "instrumental" ? "Instrumental" : shot.voice_ids.length ? shot.voice_ids.join(", ") : "Unassigned";
                  return <div key={`formatted-${shot.shot_id}-${index}`} style={{ padding: "10px 12px", borderBottom: "1px solid #e2e8f0", background: index % 2 ? "#fff" : "#f8fafc", fontSize: 12, lineHeight: 1.55 }}>
                    <strong style={{ fontVariantNumeric: "tabular-nums" }}>{audioClock(shot.start_seconds)}–{audioClock(shot.end_seconds)}{shot.end_seconds < 60 ? "s" : ""}</strong>
                    <div style={{ color: "#475569" }}>{shot.music_section || "Audio segment"}</div>
                    <div style={{ fontWeight: 600, marginTop: 3 }}>Shot {index + 1} — {shot.action || (shot.audio_type === "instrumental" ? "Musical opening / instrumental visual" : "Visual direction needed")}</div>
                    <div><b>Voice:</b> {voice} · <b>Character:</b> {names.join(", ") || "Unassigned"}</div>
                    {shot.lyrics_or_dialogue && <div><b>Lyrics:</b> {shot.lyrics_or_dialogue}</div>}
                    {shot.action && <div>• <b>Action:</b> {shot.action}{shot.body_movement ? ` ${shot.body_movement}` : ""}</div>}
                    {(shot.camera_shot || shot.camera_angle || shot.camera_movement) && <div>• <b>Camera:</b> {[shot.camera_shot, shot.camera_angle, shot.camera_movement].filter(Boolean).join(", ")}</div>}
                    {shot.mood && <div>• <b>Mood:</b> {shot.mood}</div>}
                    {shot.lip_sync_required && <div>• <b>Lip-sync:</b> required</div>}
                    {(shot.transition_in || shot.transition_out) && <div>• <b>Transition:</b> {[shot.transition_in, shot.transition_out].filter(Boolean).join(" → ")}</div>}
                    {(shot.continuity_from_previous_shot || shot.continuity_to_next_shot) && <div>• <b>Continuity:</b> {[shot.continuity_from_previous_shot, shot.continuity_to_next_shot].filter(Boolean).join(" → ")}</div>}
                  </div>;
                })}
              </div>
              {audioTimeline.storyboard_sync === "synced" ? <div style={{ fontSize: 11, color: "#166534", marginBottom: 8 }}>Saved timing, characters, actions, camera and prompts are synced to storyboard generation. Voice IDs/lip-sync remain annotations until the dialogue pipeline is explicitly configured.</div>
                : audioTimeline.storyboard_sync === "timeline_only" ? <div style={{ fontSize: 11, color: "#92400e", marginBottom: 8 }}>This timeline includes analysis-only or unmatched shots. It is saved for review; those placeholder shots are not sent to generation.</div>
                  : <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>Save to validate this timeline and sync edits to matching storyboard shots; analysis-only intervals remain review-only.</div>}
              {audioTimeline.shots.map((shot, index) => (
                <details key={`${shot.shot_id}-${index}`} style={{ border: "1px solid #e2e8f0", borderRadius: 6, marginBottom: 6, background: "#fff" }}>
                  <summary style={{ cursor: "pointer", padding: "8px 10px", display: "grid", gridTemplateColumns: "80px 120px minmax(0,1fr) 90px", gap: 8, alignItems: "center", fontSize: 12 }}>
                    <strong>{shot.shot_id}</strong>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: "#475569" }}>{shot.start_seconds.toFixed(2)}–{shot.end_seconds.toFixed(2)}s</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shot.lyrics_or_dialogue || shot.action || "Visual direction needed"}</span>
                    <span>{shot.audio_type} · {shot.generation_status}</span>
                  </summary>
                  <div style={{ padding: 10, borderTop: "1px solid #e2e8f0", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8, fontSize: 12 }}>
                    <label>Start (s)<input className="input" value={shot.start_seconds} readOnly style={{ width: "100%" }} /></label>
                    <label>End boundary (s){index < audioTimeline.shots.length - 1 ? <input className="input" type="number" step="0.001" min={shot.start_seconds + .001} max={audioTimeline.duration_seconds} value={shot.end_seconds} onChange={e => editAudioBoundary(index, e.target.value)} style={{ width: "100%" }} /> : <input className="input" value={`${shot.end_seconds} · source end`} readOnly style={{ width: "100%" }} />}</label>
                    <label>Audio type<select className="input" value={shot.audio_type} onChange={e => editAudioShot(index, { audio_type: e.target.value as DirectorAudioShot["audio_type"] })} style={{ width: "100%" }}><option value="instrumental">Instrumental</option><option value="vocal">Vocal</option><option value="dialogue">Dialogue</option><option value="mixed">Mixed</option></select></label>
                    <label>Voice IDs (manual; comma-separated)<input className="input" value={shot.voice_ids.join(", ")} onChange={e => editAudioShot(index, { voice_ids: e.target.value.split(",").map(x => x.trim()).filter(Boolean) })} placeholder="voice_1" style={{ width: "100%" }} /></label>
                    <label>Character IDs (comma-separated)<input className="input" value={shot.character_ids.join(", ")} onChange={e => editAudioShot(index, { character_ids: e.target.value.split(",").map(x => x.trim()).filter(Boolean) })} style={{ width: "100%" }} /></label>
                    <label>Character reference IDs (comma-separated)<input className="input" value={shot.character_reference_ids.join(", ")} onChange={e => editAudioShot(index, { character_reference_ids: e.target.value.split(",").map(x => x.trim()).filter(Boolean) })} style={{ width: "100%" }} /></label>
                    <label>Music section<input className="input" value={shot.music_section} onChange={e => editAudioShot(index, { music_section: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Mood<input className="input" value={shot.mood} onChange={e => editAudioShot(index, { mood: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Lyrics / dialogue<textarea className="input" rows={2} value={shot.lyrics_or_dialogue} onChange={e => editAudioShot(index, { lyrics_or_dialogue: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Action<textarea className="input" rows={2} value={shot.action} onChange={e => editAudioShot(index, { action: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Facial expression<input className="input" value={shot.facial_expression} onChange={e => editAudioShot(index, { facial_expression: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Body movement<input className="input" value={shot.body_movement} onChange={e => editAudioShot(index, { body_movement: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Camera shot<input className="input" value={shot.camera_shot} onChange={e => editAudioShot(index, { camera_shot: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Framing<input className="input" value={shot.framing} onChange={e => editAudioShot(index, { framing: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Camera angle / movement<input className="input" value={`${shot.camera_angle}${shot.camera_angle && shot.camera_movement ? " / " : ""}${shot.camera_movement}`} onChange={e => { const [angle = "", movement = ""] = e.target.value.split("/"); editAudioShot(index, { camera_angle: angle.trim(), camera_movement: movement.trim() }); }} style={{ width: "100%" }} /></label>
                    <label>Location<input className="input" value={shot.location} onChange={e => editAudioShot(index, { location: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Background / props<input className="input" value={`${shot.background}${shot.props.length ? ` / ${shot.props.join(", ")}` : ""}`} onChange={e => { const [background = "", ...props] = e.target.value.split("/"); editAudioShot(index, { background: background.trim(), props: props.join("/").split(",").map(x => x.trim()).filter(Boolean) }); }} style={{ width: "100%" }} /></label>
                    <label>Lighting / palette<input className="input" value={`${shot.lighting}${shot.color_palette.length ? ` / ${shot.color_palette.join(", ")}` : ""}`} onChange={e => { const [lighting = "", ...colors] = e.target.value.split("/"); editAudioShot(index, { lighting: lighting.trim(), color_palette: colors.join("/").split(",").map(x => x.trim()).filter(Boolean) }); }} style={{ width: "100%" }} /></label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={shot.lip_sync_required} onChange={e => editAudioShot(index, { lip_sync_required: e.target.checked })} /> Lip-sync required (manual)</label>
                    <label>Transition in<input className="input" value={shot.transition_in} onChange={e => editAudioShot(index, { transition_in: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Transition out<input className="input" value={shot.transition_out} onChange={e => editAudioShot(index, { transition_out: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Continuity from previous<input className="input" value={shot.continuity_from_previous_shot} onChange={e => editAudioShot(index, { continuity_from_previous_shot: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Continuity to next<input className="input" value={shot.continuity_to_next_shot} onChange={e => editAudioShot(index, { continuity_to_next_shot: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Image prompt<textarea className="input" rows={3} value={shot.image_generation_prompt} onChange={e => editAudioShot(index, { image_generation_prompt: e.target.value })} style={{ width: "100%" }} /></label>
                    <label>Video motion prompt<textarea className="input" rows={3} value={shot.video_motion_prompt} onChange={e => editAudioShot(index, { video_motion_prompt: e.target.value })} style={{ width: "100%" }} /></label>
                    <div style={{ color: "#64748b" }}>BPM: {shot.bpm ?? "unknown"} · beats: {shot.beat_timestamps.map(t => t.toFixed(2)).join(", ") || "none"}<br />Model/workflow IDs are unresolved.</div>
                  </div>
                </details>
              ))}
            </>
          )}

          {/* Panel C — Character Studio */}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>Panel C — Character Studio</div>
              {board.blueprint && Array.isArray(board.blueprint.characters) && board.blueprint.characters.length > 0 ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, marginBottom: 12 }}>
                  {board.blueprint.characters.map((c: Record<string, unknown>, i: number) => (
                    <div key={i} style={{ padding: 12, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff" }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{str(c.name) || `Character ${i + 1}`}</div>
                      <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>{str(c.species)} · {str(c.role)}</div>
                      <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>{str(c.age || "")}</div>
                      <div style={{ fontSize: 11, color: "#4b5563", marginBottom: 8 }}>{str(c.visual_identity_prompt).slice(0, 140)}…</div>
                      <button className="btn" onClick={() => {}} style={{ width: "100%", fontSize: 12, padding: "6px 10px" }}>Generate Reference</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: "#666", fontSize: 13 }}>No characters yet. Analyze the story first.</div>
              )}
            </>
          )}

          {/* Panel D — Storyboard */}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>Panel D — Storyboard</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, marginBottom: 12 }}>
                {board.scenes.map((s) => (
                  <div key={s.scene_number} style={{ padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <div style={{ fontWeight: 600 }}>{`Scene ${s.scene_number}`}</div>
                      <span style={{ fontSize: 11, color: "#666" }}>{fmtT(s.duration_seconds)}</span>
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>{str(s.title)}</div>
                    <div style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>{str(s.action)}</div>
                    <div style={{ fontSize: 11, color: "#666" }}>{str(s.location)}</div>
                    <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                      <button className="btn" onClick={() => {}} style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}>Edit</button>
                      <button className="btn" onClick={() => {}} style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}>Generate Image</button>
                      <button className="btn" onClick={() => {}} style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}>Generate Clip</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Panel E — Animation Director */}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>Panel E — Animation Director</div>
              <div style={{ color: "#666", fontSize: 13 }}>Select a scene from the storyboard to configure its motion plan.</div>
            </>
          )}

          {/* Panel F — Final Video */}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>Panel F — Final Video</div>
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <button className="btn primary" onClick={doApprove} disabled={!!busy} style={{ flex: 1 }}>
                  {busy ? <Spinner size={16} /> : "Approve Storyboard → Save Project"}
                </button>
              </div>
              <div style={{ padding: 10, background: "#f3f4f6", borderRadius: 6, fontSize: 13 }}>
                Approving creates a standard scenario project and opens it in the workspace — where
                image → video → merge → progress → resume are all handled by the existing pipeline.
              </div>
            </>
          )}

          {/* Quality Control */}
          {card(
            <>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>Quality Control — Lyric Coverage & Validation</div>
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <button className="btn" onClick={doIntelCheck} disabled={intelBusy === "check"}>
                  {intelBusy === "check" ? <Spinner size={14} /> : "Run Coverage + Validate"}
                </button>
                <button className="btn" onClick={doIntelRepair} disabled={intelBusy === "repair" || !validation?.issues?.length}>
                  {intelBusy === "repair" ? <Spinner size={14} /> : "AI Repair Flagged Scenes"}
                </button>
              </div>
              {coverage && (
                <div style={{ marginBottom: 10 }}>
                  <strong>Coverage:</strong> {coverage.summary.coveredPhrases} / {coverage.summary.totalPhrases} phrases ({coverage.summary.pct}%)
                  <div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>This measures how much of the transcript the planned scenes cover; it is not Whisper transcription accuracy.</div>
                </div>
              )}
              {validation && (
                <div>
                  <strong>Score:</strong> {validation.score} / 100 &nbsp;|&nbsp;
                  <strong>Genre:</strong> {validation.genreNote}
                  {validation.issues?.length && (
                    <div style={{ marginTop: 6, fontSize: 12, color: "#92400e" }}>
                      Issues: {validation.issues.join("; ")}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Saved Storyboards */}
          <div style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>Saved Storyboards</h2>
            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8 }}>
              {boards.map((b) => (
                <div key={b.id} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 200, padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff" }}>
                  <div style={{ fontWeight: 600 }}>{b.title}</div>
                  <div style={{ fontSize: 12, color: "#666" }}>{b.scenes} / {b.sceneCount} scenes</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button className="btn" onClick={() => openBoard(b.id)} style={{ flex: 1, fontSize: 12 }}>Open</button>
                    <button className="btn" onClick={() => { if (onOpenProject && b.project_id != null) onOpenProject(`board-${b.id}`); }} disabled={!b.project_id} style={{ flex: 1, fontSize: 12, opacity: b.project_id ? 1 : 0.5 }}>Open Project</button>
                    <button className="btn" onClick={() => doDeleteBoard(b.id)} style={{ fontSize: 11, padding: "4px 8px" }}>Delete</button>
                  </div>
                </div>
              ))}
              {boards.length === 0 && <div style={{ fontSize: 13, color: "#666" }}>No saved storyboards yet.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
