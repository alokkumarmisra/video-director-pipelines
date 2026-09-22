import { useEffect, useRef, useState } from "react";
import {
  directorAddEntry, directorAnalyze, directorApprove, directorBoard, directorBoards, directorDeleteBoard,
  directorRegenEntry, directorRegenScene, directorScenes, directorSongUrl, directorUpdateBoard, directorUploadSong, estimateDirectorLength, fmtRelative, saveScenario,
  type DirectorBoard, type DirectorBoardMeta, type DirectorEntryKind, type DirectorInput, type DirectorScene, type DirectorSong,
} from "../api";
import { useDialog } from "./Dialog";
import { IconCheck, IconClapper, IconFilm, IconFolder, IconPanel, IconRefresh, IconSparkles, IconTrash, Spinner } from "./Icons";
import Collapse from "./Collapse";
import {
  emptyProgress, formatDuration, loadDirectorPace, recordDirectorPaceDuration,
  type GenerationProgress,
} from "./GenerationProgressBar";

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

// Local fallback for story target duration (mirrors the server heuristic):
// ~0.45s per word + 1.2s per line + 20s pad, clamped 30–600s, rounded to 5s.
const estimateStoryDurationLocal = (story: string): number => {
  const words = story.split(/\s+/).filter(Boolean).length;
  const lines = story.split("\n").map((l) => l.trim()).filter(Boolean).length;
  if (!words) return 60;
  const raw = 20 + words * 0.45 + lines * 1.2;
  return Math.round(Math.min(600, Math.max(30, raw)) / 5) * 5;
};

// Pre-defined CHARACTER CONSISTENCY rules (mirrors
// DEFAULT_CHARACTER_CONSISTENCY_RULES in lib/director.mjs). Every character
// gets these by default; the per-character popup lets the user edit, add,
// delete or reset them at any time. Saved as character.consistency_rules
// and sent to the AI with every scene-batch + regen call.
const DEFAULT_CHAR_RULES = [
  "Keep the exact same face: shape, eyes, nose, lips, jawline and skin tone in every scene.",
  "Keep the exact same body, species traits and proportions in every scene.",
  "Keep the exact same clothing, colors and accessories unless the story explicitly changes them.",
  "Paste the visual_identity_prompt verbatim into every image_prompt — never paraphrase or shorten it.",
  "Keep the same art style and rendering for this character across all scenes.",
  "Stage speaking scenes front-facing so the face stays clearly visible.",
];
const charRules = (c: Record<string, unknown>): string[] =>
  Array.isArray(c.consistency_rules)
    ? (c.consistency_rules as unknown[]).map((x) => String(x ?? "")).filter(Boolean)
    : [...DEFAULT_CHAR_RULES];

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

// Saved-storyboard card language: board status -> pill label + tone.
const BOARD_STATUS: Record<string, { label: string; cls: string }> = {
  analyzed: { label: "Analyzed", cls: "warn" },
  "scenes-partial": { label: "Scenes partial", cls: "running" },
  ready: { label: "Ready", cls: "ok" },
  approved: { label: "Approved", cls: "done" },
  "approved-partial": { label: "Approved · partial", cls: "done" },
};
const boardStatusOf = (s: string) => BOARD_STATUS[s] ?? { label: s, cls: "" };
export default function DirectorPage({ onOpenProject, onProjectsChanged, onPlanningProgress }: {
  onOpenProject: (name: string) => void;
  onProjectsChanged: () => void;
  /** Lifts AI planning progress (analyze + scene batches) to the menu's
      Progress Status — same shape as generation progress, unit "scenes". */
  onPlanningProgress?: (p: GenerationProgress) => void;
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
  // Auto length (default ON, like Create Song): the story text drives the
  // target duration via a local heuristic + the ✨ AI length button (LLM).
  // Uncheck to pick a manual duration from the dropdown.
  const [autoTarget, setAutoTarget] = useState(true);
  const [autoTargetSeconds, setAutoTargetSeconds] = useState(60);
  const [estimatingTarget, setEstimatingTarget] = useState(false);
  const [targetNote, setTargetNote] = useState<string | null>(null);
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
  // Scene boxes currently being planned by the AI (rendered as Generating…;
  // every later box renders as To be Generated until its batch lands).
  const [generatingRange, setGeneratingRange] = useState<{ from: number; to: number } | null>(null);
  const [stoppedNote, setStoppedNote] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Planning progress for the menu's Progress Status (total + per-scene Time
  // Remaining, same countdown language as Projects). planPhase is set for the
  // two LLM phases only (analyze + scene batches) — approve/migrate/regen
  // are seconds-long and stay local. Batch stats accumulate per-board so
  // Stop/resume keeps its live pace instead of restarting cold.
  const [planPhase, setPlanPhase] = useState<{
    kind: "analyze" | "scenes"; startedAt: number; title: string; total: number;
  } | null>(null);
  const batchStartRef = useRef<number | null>(null);
  const planStatsRef = useRef<{ boardId: string; sceneMs: number; scenes: number } | null>(null);
  // 1s ticker so the remaining-time countdowns stay live while planning.
  const [dirNow, setDirNow] = useState(() => Date.now());
  useEffect(() => {
    if (!planPhase) return;
    const t = setInterval(() => setDirNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [planPhase]);
  // Editing + master-detail selection (compact cards + one full detail section).
  const [selectedScene, setSelectedScene] = useState<number | null>(null);
  const [editingScene, setEditingScene] = useState<number | null>(null);
  // Scene Details/Edit popup: one modal per scene (mode details = full
  // breakdown, mode edit = edit form). Cards stay compact; the separate
  // details section below the grid is replaced by this popup.
  const [sceneModal, setSceneModal] = useState<{ index: number; mode: "details" | "edit" } | null>(null);
  const [sceneDraft, setSceneDraft] = useState<Partial<DirectorScene>>({});
  const [dialogueDraft, setDialogueDraft] = useState("");
  const [regenScene, setRegenScene] = useState<number | null>(null);
  // AI append (Add Character / Location / Object): one LLM call that reads
  // the master input + already-generated bible and appends a single entry.
  const [addingEntry, setAddingEntry] = useState<DirectorEntryKind | null>(null);
  // Per-card AI regenerate (one bible entry rewritten in place).
  const [regenEntry, setRegenEntry] = useState<{ kind: DirectorEntryKind; index: number } | null>(null);
  // Per-character CHARACTER CONSISTENCY popup (prompt + editable rules).
  const [editingChar, setEditingChar] = useState<number | null>(null);
  const [charDraft, setCharDraft] = useState<Record<string, string>>({});
  const [ruleDraft, setRuleDraft] = useState<string[]>([]);
  const [newRule, setNewRule] = useState("");
  const [savingChar, setSavingChar] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-director") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-director", c ? "open" : "closed");
      return !c;
    });
  // Saved-storyboard rail on the right: open by default, collapsible to a
  // slim Boards rail (same pattern as the Projects panel). Choice persists.
  const [boardsOpen, setBoardsOpen] = useState(() => localStorage.getItem("ss-sec-boards") !== "closed");
  const toggleBoards = () =>
    setBoardsOpen((o) => {
      localStorage.setItem("ss-sec-boards", o ? "closed" : "open");
      return !o;
    });

  const targetSeconds = mode === "song" && song
    ? Math.max(15, song.durationSeconds)
    : autoTarget
      ? autoTargetSeconds
      : targetOpt === -1 ? Math.max(15, Number(targetCustom) || 60) : targetOpt;

  // Auto length: story edits re-estimate locally (debounced, like Create Song).
  useEffect(() => {
    if (!autoTarget || mode !== "story") return;
    if (story.trim().length < 20) return;
    const t = window.setTimeout(() => {
      setAutoTargetSeconds(estimateStoryDurationLocal(story));
    }, 700);
    return () => window.clearTimeout(t);
  }, [story, autoTarget, mode]);

  // ✨ AI length: the local LLM reads the story + genre and sets the exact target.
  const handleAiTarget = async () => {
    if (estimatingTarget || story.trim().length < 20) return;
    setEstimatingTarget(true);
    setTargetNote(null);
    try {
      const r = await estimateDirectorLength(story, {
        title: title.trim(),
        genre: genre === "Custom" && genreCustom.trim() ? genreCustom.trim() : genre,
        language,
        sceneSeconds,
      });
      setAutoTargetSeconds(Math.min(3600, Math.max(15, Math.round(Number(r.duration) || 60))));
      setTargetNote(
        r.source === "llm"
          ? `AI set ~${r.duration}s${r.reasoning ? ` — ${r.reasoning}` : ""}`
          : `LLM offline — heuristic set ~${r.duration}s`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTargetNote(msg);
      alertIfLlm(msg);
    } finally {
      setEstimatingTarget(false);
    }
  };
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

  // LLM failures (e.g. "LLM HTTP 400: …" from llama-server) pop the centered
  // alert dialog — inline text under the header is too easy to miss mid-flow.
  // The message is ALSO kept inline so it survives after dismissing.
  const alertIfLlm = (msg: string) => {
    if (/LLM(\s|$|_BASE)|llama|chat\/completions/i.test(msg)) {
      void dialog.alert(msg, { title: "AI request failed", tone: "error" });
    }
  };
  const reportError = (e: unknown, suffix = "") => {
    const msg = `${e instanceof Error ? e.message : String(e)}${suffix}`;
    setError(msg);
    alertIfLlm(msg);
  };

  const openBoard = async (id: string) => {
    setError("");
    setStoppedNote(null);
    try {
      setBoard(await directorBoard(id));
      setSelectedScene(0);
      setEditingScene(null);
      setSceneModal(null);
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
    setPlanPhase({ kind: "analyze", startedAt: Date.now(), title: title.trim(), total: plannedScenes });
    try {
      const b = await directorAnalyze(input);
      setBoard(b);
      setSelectedScene(0);
      await refreshBoards();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
      setPlanPhase(null);
    }
  };

  // Generate scenes in batches until the plan is complete. Resumable: the
  // server appends from scenes.length, so Stop / retry continues from the
  // next scene, never restarts (e.g. Stop during 61–72 resumes at 73).
  const doScenes = async () => {
    if (!board || busy) return;
    cancelRef.current = false;
    setBusy({ label: "Planning scenes…", since: Date.now() });
    setError("");
    setStoppedNote(null);
    // Fresh board (or finished plan) restarts the live pace; Stop/resume on
    // the same board keeps accumulating so the countdown doesn't go cold.
    const stats = planStatsRef.current;
    if (!stats || stats.boardId !== board.id) {
      planStatsRef.current = { boardId: board.id, sceneMs: 0, scenes: 0 };
    }
    setPlanPhase({ kind: "scenes", startedAt: Date.now(), title: board.input.title, total: board.sceneCount });
    try {
      // Reload the freshest board first so a resume after Stop never re-plans
      // scenes the server already saved while we were away.
      let b = await directorBoard(board.id).catch(() => board);
      setBoard(b);
      while (b.scenes.length < b.sceneCount) {
        if (cancelRef.current) break;
        setSceneProgress(`Scene ${b.scenes.length + 1}–${Math.min(b.sceneCount, b.scenes.length + 12)} of ${b.sceneCount}`);
        setGeneratingRange({ from: b.scenes.length + 1, to: Math.min(b.sceneCount, b.scenes.length + 12) });
        const ctl = new AbortController();
        abortRef.current = ctl;
        const prevLen = b.scenes.length;
        const batchStart = Date.now();
        batchStartRef.current = batchStart;
        try {
          b = await directorScenes(b.id, undefined, ctl.signal);
        } catch (e) {
          // Stop pressed mid-batch: the server may still save that batch —
          // reload and report exactly where the resume continues from.
          if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
            try { b = await directorBoard(board.id); } catch { /* keep last */ }
            setBoard(b);
            break;
          }
          throw e;
        } finally {
          abortRef.current = null;
          batchStartRef.current = null;
        }
        // One landed batch = one pace sample (per-scene), feeding both the
        // live countdown below and the persisted pace for the next plan.
        const landed = b.scenes.length - prevLen;
        if (landed > 0) {
          const perScene = (Date.now() - batchStart) / landed;
          const st = planStatsRef.current;
          if (st && st.boardId === b.id) {
            st.sceneMs += perScene * landed;
            st.scenes += landed;
          }
          recordDirectorPaceDuration(perScene);
        }
        setBoard(b);
      }
      if (cancelRef.current && b.scenes.length < b.sceneCount) {
        setStoppedNote(`Stopped after scene ${b.scenes.length} of ${b.sceneCount} — press Continue to resume from scene ${b.scenes.length + 1}.`);
      }
      setSelectedScene((sel) => (sel == null && b.scenes.length ? 0 : sel));
      await refreshBoards();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 409 = another batch is already planning this board (double-click or a
      // second tab) — it was rejected server-side, so nothing was duplicated.
      // Reload and point at the true resume position instead of erroring.
      if (/already running/i.test(msg)) {
        try {
          const fresh = await directorBoard(board.id);
          setBoard(fresh);
          setStoppedNote(`Planning is already running for this board — wait a moment, then Continue from scene ${fresh.scenes.length + 1} of ${fresh.sceneCount}. No duplicates were saved.`);
        } catch { /* keep sick */ }
      } else {
        reportError(e, " — partial scenes are kept, retry continues.");
        try { setBoard(await directorBoard(board.id)); } catch { /* keep sick */ }
      }
    } finally {
      setBusy(null);
      setSceneProgress("");
      setGeneratingRange(null);
      batchStartRef.current = null;
      setPlanPhase(null);
      abortRef.current = null;
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
      reportError(e);
    } finally {
      setRegenScene(null);
    }
  };

  const doDeleteScene = async (index: number) => {
    if (!board) return;
    if (sceneModal) setSceneModal(null);
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

  // AI append: the server re-reads the story/lyrics + master settings +
  // the already-generated bible and appends exactly one new entry.
  const doAddEntry = async (kind: DirectorEntryKind) => {
    if (!board || addingEntry || busy) return;
    setAddingEntry(kind);
    setError("");
    try {
      const b = await directorAddEntry(board.id, kind);
      setBoard(b);
      await refreshBoards();
    } catch (e) {
      reportError(e);
    } finally {
      setAddingEntry(null);
    }
  };

  // AI rewrite: the server re-reads the story/lyrics + master settings +
  // the full bible and swaps in a richer rewrite of the selected entry.
  // The id is pinned server-side so scene references keep working.
  const doRegenEntry = async (kind: DirectorEntryKind, index: number) => {
    if (!board || regenEntry || addingEntry || busy) return;
    setRegenEntry({ kind, index });
    setError("");
    try {
      const b = await directorRegenEntry(board.id, kind, index);
      setBoard(b);
      await refreshBoards();
    } catch (e) {
      reportError(e);
    } finally {
      setRegenEntry(null);
    }
  };

  const doDeleteChar = async (index: number) => {
    if (!board?.blueprint) return;
    const list = (board.blueprint.characters ?? []) as Record<string, unknown>[];
    const c = list[index] as Record<string, unknown> | undefined;
    const ok = await dialog.confirm("Scenes that reference this character keep its name as plain text — update them or regenerate before approving.", {
      title: `Delete character "${str(c?.name) || `Character ${index + 1}`}"?`,
      tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      const b = await directorUpdateBoard(board.id, { characters: list.filter((_, i) => i !== index) });
      setBoard(b);
      setEditingChar(null);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDeleteLoc = async (index: number) => {
    if (!board?.blueprint) return;
    const list = (board.blueprint.locations ?? []) as Record<string, unknown>[];
    const l = list[index] as Record<string, unknown> | undefined;
    const ok = await dialog.confirm("Scenes set in this location keep its name as plain text — update them before approving.", {
      title: `Delete location "${str(l?.name) || `Location ${index + 1}`}"?`,
      tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      const b = await directorUpdateBoard(board.id, { locations: list.filter((_, i) => i !== index) });
      setBoard(b);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDeleteObj = async (index: number) => {
    if (!board?.blueprint) return;
    const list = (board.blueprint.objects ?? []) as Record<string, unknown>[];
    const o = list[index] as Record<string, unknown> | undefined;
    const ok = await dialog.confirm("Scenes showing this object keep its name as plain text — update them before approving.", {
      title: `Delete object "${str(o?.name) || `Object ${index + 1}`}"?`,
      tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      const b = await directorUpdateBoard(board.id, { objects: list.filter((_, i) => i !== index) });
      setBoard(b);
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
      const ex = String((d as { expression?: string }).expression || "").trim();
      const head = sp && ex ? `${sp} (${ex})` : sp;
      return head ? `${head}: ${ln}` : ln;
    }).filter(Boolean).join("\n") : "");
  };
  const saveEditScene = async () => {
    if (!board || editingScene == null) return;
    const dlg = dialogueDraft.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const c = l.indexOf(":");
      if (c <= 0) return { speaker: "", line: l };
      const head = l.slice(0, c).trim();
      const line = l.slice(c + 1).trim();
      const m = head.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
      return m
        ? { speaker: m[1].trim(), expression: m[2].trim(), line }
        : { speaker: head, line };
    }).filter((d) => d.line);
    const next = board.scenes.map((s, i) => (i === editingScene ? { ...s, ...sceneDraft, dialogue: dlg } : s));
    try {
      const b = await directorUpdateBoard(board.id, { scenes: next });
      setBoard(b);
      setEditingScene(null);
      setSceneModal(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Close the scene popup (discards an unsaved edit).
  const closeSceneModal = () => {
    setSceneModal(null);
    setEditingScene(null);
  };

  const startEditChar = (index: number) => {
    const c = board?.blueprint?.characters?.[index] as Record<string, unknown> | undefined;
    if (!c) return;
    setEditingChar(index);
    setCharDraft({ name: str(c.name), role: str(c.role), visual_identity_prompt: str(c.visual_identity_prompt) });
    setRuleDraft(charRules(c));
    setNewRule("");
  };
  const saveEditChar = async () => {
    if (!board?.blueprint || editingChar == null || savingChar) return;
    setSavingChar(true);
    const next = board.blueprint.characters.map((c, i) =>
      i === editingChar
        ? { ...(c as object), ...charDraft, consistency_rules: ruleDraft.map((r) => r.trim()).filter(Boolean) }
        : c);
    try {
      const b = await directorUpdateBoard(board.id, { characters: next });
      setBoard(b);
      setEditingChar(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingChar(false);
    }
  };
  // Lock background scroll + Esc to close while the popup is open.
  useEffect(() => {
    if (editingChar == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditingChar(null);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [editingChar]);
  // Same lock for the scene Details/Edit popup.
  useEffect(() => {
    if (sceneModal == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSceneModal();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [sceneModal]);

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

  // Partial migration: after Stop (or anytime while scenes are still being
  // planned), migrate the scenes planned so far into a project now; the rest
  // follow later into the SAME project via "Migrate remaining" (the server
  // reuses board.scenarioName and the generation pipeline skips assets that
  // already exist, so nothing is rebuilt).
  const doMigratePartial = async () => {
    if (!board || busy || !board.scenes.length || board.scenes.length >= board.sceneCount) return;
    const migrated = board.migratedScenes ?? (board.scenarioName ? board.scenes.length : 0);
    const fresh = Math.max(0, board.scenes.length - (board.scenarioName ? migrated : 0));
    const songNote = board.input.song
      ? ` The uploaded song ("${board.input.song.fileName}", ~${board.input.song.durationSeconds}s) travels with the project.`
      : "";
    const ok = board.scenarioName
      ? await dialog.confirm(
        `Appends ${fresh} new scene${fresh === 1 ? "" : "s"} (1–${board.scenes.length} planned so far) into existing project "${board.scenarioName}" (updates its scenario). Already-generated images/videos are kept — only new scenes generate.${songNote}`,
        { title: `Migrate remaining scenes into "${board.scenarioName}"?`, tone: "info", okText: fresh ? "Migrate remaining" : "Re-migrate", cancelText: "Keep planning" }
      )
      : await dialog.confirm(
        `Migrates scenes 1–${board.scenes.length} of ${board.sceneCount} planned into project "${board.input.title}" now and opens it for generation (images → videos → final cut). Keep planning here — Continue plans the rest, then Migrate remaining appends them to the same project.${songNote}`,
        { title: `Migrate partial project (${board.scenes.length}/${board.sceneCount} scenes)?`, tone: "info", okText: "Migrate partial", cancelText: "Keep planning" }
      );
    if (!ok) return;
    setBusy({ label: "Migrating partial project…", since: Date.now() });
    setError("");
    try {
      const { name, config } = await directorApprove(board.id);
      await saveScenario(name, config);
      onProjectsChanged();
      try { setBoard(await directorBoard(board.id)); } catch { /* navigated away */ }
      await refreshBoards();
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

  // Delete one saved storyboard straight from the grid (same confirm + API
  // as the open-board delete; removes the DB row and the file together).
  const doDeleteBoardById = async (id: string, title: string) => {
    const ok = await dialog.confirm("The story input and all planned scenes are removed. Generated projects are kept.", {
      title: `Delete board "${title}"?`, tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      await directorDeleteBoard(id);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Jump the viewport to the live work: the first Generating box of the
  // current batch, else the last planned scene card. The sticky header pill
  // calls this so progress is one click away on long boards.
  const scrollToLive = () => {
    const from = generatingRange?.from;
    const live = from != null ? document.getElementById(`dir-scene-pending-${from}`) : null;
    const last = document.getElementById(`dir-scene-${board?.scenes.length ?? 0}`);
    (live ?? last)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  // Auto-follow the live batch: each new batch brings its first Generating
  // box into view so the active work stays visible while 80+ scenes push it
  // far below the fold. Skipped while the scene popup is open (background
  // is scroll-locked then — the pill click still jumps on demand).
  const liveFromRef = useRef<number | null>(null);
  useEffect(() => {
    if (!generatingRange || sceneModal) return;
    if (liveFromRef.current === generatingRange.from) return;
    liveFromRef.current = generatingRange.from;
    const from = generatingRange.from;
    window.setTimeout(() => {
      document.getElementById(`dir-scene-pending-${from}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  }, [generatingRange, sceneModal]);
  useEffect(() => { liveFromRef.current = null; }, [board?.id]);
  // Scene Details/Edit popups (scene cards stay compact with essentials
  // only; the full breakdown + edit form live in the modal).
  const openSceneDetails = (i: number) => {
    if (!board || i < 0 || i >= board.scenes.length) return;
    setSelectedScene(i);
    setSceneModal({ index: i, mode: "details" });
  };
  const openSceneEdit = (i: number) => {
    if (!board || i < 0 || i >= board.scenes.length) return;
    startEditScene(i);
    setSelectedScene(i);
    setSceneModal({ index: i, mode: "edit" });
  };
  const stepSceneModal = (dir: 1 | -1) => {
    if (!board || !sceneModal) return;
    const next = Math.min(board.scenes.length - 1, Math.max(0, sceneModal.index + dir));
    if (next === sceneModal.index) return;
    if (sceneModal.mode === "edit") startEditScene(next);
    setSelectedScene(next);
    setSceneModal({ index: next, mode: sceneModal.mode });
  };

  const chars = (board?.blueprint?.characters ?? []) as Record<string, unknown>[];

  // ---- Planning Time Remaining (total + per-scene) ----
  // Per-scene pace: live average from this plan's landed batches first, then
  // the persisted pace from previous plans (same fallback chain as Projects).
  // Total = remaining scenes × pace − time already spent in the current batch.
  const planPace = (() => {
    const st = planStatsRef.current;
    if (planPhase?.kind === "scenes" && st && st.boardId === (board?.id ?? "") && st.scenes > 0) {
      return st.sceneMs / st.scenes;
    }
    return loadDirectorPace();
  })();
  const planBatchElapsed = batchStartRef.current != null ? Math.max(0, dirNow - batchStartRef.current) : 0;
  const planTotal = planPhase
    ? planPhase.kind === "analyze" ? Math.max(1, planPhase.total) : Math.max(1, board?.sceneCount ?? planPhase.total)
    : 0;
  const planDone = planPhase
    ? planPhase.kind === "analyze" ? 0 : Math.min(planTotal, board?.scenes.length ?? 0)
    : 0;
  const planRemainingMs = planPhase && planPace != null && planTotal > planDone
    ? Math.max(0, Math.round((planTotal - planDone) * planPace - planBatchElapsed))
    : null;
  // Per-scene remaining for a 1-based pending scene number: its queue position
  // × pace − time already spent in the current batch. Null while paceless.
  const planSceneEta = (num: number): number | null => {
    if (!planPhase || planPhase.kind !== "scenes" || planPace == null) return null;
    if (num <= planDone) return null;
    return Math.max(0, Math.round((num - planDone) * planPace - planBatchElapsed));
  };
  // Lift to the menu's Progress Status (unit "scenes" so the header reads
  // counts + countdown in scene terms). Idle when no LLM phase is active, so
  // the menu falls back to generation progress exactly as before.
  const planMenuProgress: GenerationProgress = planPhase
    ? {
        ...emptyProgress,
        status: "running",
        unit: "scenes",
        scenario: planPhase.title || "storyboard",
        pct: planTotal > 0 ? (planDone / planTotal) * 100 : 0,
        completed: planDone,
        total: planTotal,
        scene: planPhase.kind === "scenes" && planTotal > planDone ? planDone + 1 : null,
        totalScenes: planPhase.kind === "scenes" ? planTotal : null,
        etaMs: planRemainingMs,
        elapsedMs: Math.max(0, dirNow - planPhase.startedAt),
        startedAt: planPhase.startedAt,
      }
    : emptyProgress;
  const planBoardId = board?.id ?? null;
  const planDoneCount = board?.scenes.length ?? 0;
  const planCount = board?.sceneCount ?? 0;
  useEffect(() => {
    onPlanningProgress?.(planMenuProgress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planPhase, planBoardId, planDoneCount, planCount, dirNow]);
  const locs = (board?.blueprint?.locations ?? []) as Record<string, unknown>[];
  const objs = (board?.blueprint?.objects ?? []) as Record<string, unknown>[];
  const beats = (board?.blueprint?.beats ?? []) as { n: number; title: string; summary: string }[];
  const analysis = (board?.blueprint?.analysis ?? {}) as Record<string, unknown>;

  // Saved-storyboard rail content: the same board cards, always listed in
  // the right rail (even while a board is open) so every board stays one
  // click away. The open board gets the `current` tint.
  const boardsPanel = boards.length === 0 ? (
    <div className="sidebar-empty">No saved boards yet — direct a story to save one here.</div>
  ) : (
    <div className="dir-board-grid dir-board-grid-2">
      {boards.map((b) => {
        const st = boardStatusOf(b.status);
        const total = Math.max(0, Number(b.sceneCount) || 0);
        const done = Math.min(total, Math.max(0, Number(b.scenes) || 0));
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const chips = [b.genre, b.visualStyle, b.language, b.aspectRatio].filter(Boolean) as string[];
        const when = b.updatedAt ? Date.parse(b.updatedAt) : null;
        return (
          <article
            key={b.id}
            className={`dir-board-card${board?.id === b.id ? " current" : ""}`}
            role="button"
            tabIndex={0}
            title={`Open ${b.title}`}
            aria-label={`Open storyboard ${b.title}`}
            aria-current={board?.id === b.id ? "true" : undefined}
            onClick={() => void openBoard(b.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openBoard(b.id); } }}
          >
            <div className="dir-board-top">
              <span className={`pill ${st.cls}`.trim()}>{st.label}</span>
              <span className="muted dir-board-when" title={b.updatedAt ?? ""}>
                {when != null ? fmtRelative(when) : ""}
              </span>
              <button
                className="icon-btn danger"
                onClick={(e) => { e.stopPropagation(); void doDeleteBoardById(b.id, b.title); }}
                title={`Delete board "${b.title}"`}
                aria-label={`Delete board "${b.title}"`}
              >
                <IconTrash size={13} />
              </button>
            </div>
            <h4 className="dir-board-title" title={b.title}>{b.title}</h4>
            {b.logline && <p className="dir-board-logline" title={b.logline}>{b.logline}</p>}
            {chips.length > 0 && (
              <div className="dir-board-chips">
                {chips.map((c) => <span key={c} className="dir-chip">{c}</span>)}
              </div>
            )}
            <div className="dir-board-progress" title={`${done}/${total} scenes planned`}>
              <div className="dir-board-bar"><span style={{ width: `${pct}%` }} /></div>
              <span className="muted">{done}/{total} scenes</span>
            </div>
            <div className="dir-board-foot">
              {b.scenarioName
                ? <span className="pill done" title={`Approved as project ${b.scenarioName}${b.project_id != null ? ` (#${b.project_id})` : ""}`}>→ {b.scenarioName}{b.project_id != null ? ` #${b.project_id}` : ""}</span>
                : <span />}
              <button
                type="button"
                className="btn-blue shotlist-btn dir-board-open"
                tabIndex={-1}
                title={`Open ${b.title}`}
              >
                Open
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );

  return (
    <div className="dir-layout">
    <section className={`card dir-main${collapsed ? " collapsed" : ""}`} aria-label="AI Story Director">
      <div className="card-head">
        <h2>
          <span className="head-icon hi-output"><IconClapper size={15} /></span>
          AI Story Director
        </h2>
        {busy && (
          <span
            className="pill running live-jump"
            title={`${busy.label} — click to jump to the scenes being generated`}
            role="button"
            tabIndex={0}
            onClick={() => scrollToLive()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); scrollToLive(); } }}
          >
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
              maxLength={10000}
              placeholder={mode === "song" ? "[Verse 1]\nPaste the song lyrics here… (or leave empty for an instrumental)" : "Once upon a time… (paste the full story)"}
              onChange={(e) => setStory(e.target.value)}
            />
            <div className="grid grid-3" style={{ marginTop: 8 }}>
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
              <div>
                <label htmlFor="dir-style">Visual style</label>
                <select id="dir-style" value={visualStyle} onChange={(e) => setVisualStyle(e.target.value)}>
                  {STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {visualStyle === "Custom" && (
                  <input value={styleCustom} maxLength={120} placeholder="Describe the custom style…" onChange={(e) => setStyleCustom(e.target.value)} style={{ marginTop: 6 }} />
                )}
              </div>
            </div>
            <div className="grid grid-3" style={{ marginTop: 8 }}>
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
              <div>
                <label htmlFor="dir-target">Target duration{mode === "story" && autoTarget ? ` · ~${autoTargetSeconds}s auto` : ""}</label>
                {mode === "song" ? (
                  <p className="hint" style={{ margin: "6px 0 0" }}>
                    {song ? <>🔒 ~{song.durationSeconds}s (song length)</> : "Upload the song — the timeline locks to its length."}
                  </p>
                ) : autoTarget ? (
                  <>
                    <p className="hint" style={{ margin: "6px 0 0" }}>
                      ✨ ~{autoTargetSeconds}s — AI follows your story. Uncheck Auto to pick manually.
                    </p>
                    <button
                      type="button"
                      className="ghost shotlist-btn"
                      onClick={() => void handleAiTarget()}
                      disabled={busy != null || estimatingTarget || story.trim().length < 20}
                      title="Ask the local LLM to read the story and set the exact target duration"
                      style={{ marginTop: 4 }}
                    >
                      {estimatingTarget ? "Analyzing…" : "✨ AI length"}
                    </button>
                    {targetNote && <p className="muted" style={{ margin: "4px 0 0" }}>{targetNote}</p>}
                  </>
                ) : (
                  <>
                    <select
                      id="dir-target"
                      value={targetOpt}
                      onChange={(e) => { setTargetOpt(Number(e.target.value)); }}
                      disabled={busy != null}
                    >
                      {TARGETS.map((t) => <option key={t.seconds} value={t.seconds}>{t.label}</option>)}
                    </select>
                    {targetOpt === -1 && (
                      <input type="number" min={15} max={3600} value={targetCustom} onChange={(e) => setTargetCustom(e.target.value)} style={{ marginTop: 6 }} disabled={busy != null} />
                    )}
                    <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, fontWeight: 400 }}>
                      <input
                        type="checkbox"
                        checked={autoTarget}
                        onChange={(e) => {
                          setAutoTarget(e.target.checked);
                          if (e.target.checked && story.trim().length >= 20) {
                            setAutoTargetSeconds(estimateStoryDurationLocal(story));
                          }
                        }}
                        disabled={busy != null}
                      />
                      Auto length
                    </label>
                  </>
                )}
                {mode === "story" && autoTarget && (
                  <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, fontWeight: 400 }}>
                    <input
                      type="checkbox"
                      checked={autoTarget}
                      onChange={(e) => {
                        setAutoTarget(e.target.checked);
                        if (e.target.checked && story.trim().length >= 20) {
                          setAutoTargetSeconds(estimateStoryDurationLocal(story));
                        }
                      }}
                      disabled={busy != null}
                    />
                    Auto length
                  </label>
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
              {!busy && board.scenes.length > 0 && board.scenes.length < board.sceneCount && (
                (() => {
                  const migrated = board.migratedScenes ?? (board.scenarioName ? board.scenes.length : 0);
                  const fresh = Math.max(0, board.scenes.length - (board.scenarioName ? migrated : 0));
                  return board.scenarioName ? (
                    <button
                      className="ghost"
                      onClick={() => void doMigratePartial()}
                      title={fresh
                        ? `Append the ${fresh} new scene${fresh === 1 ? "" : "s"} into existing project "${board.scenarioName}" — the rest can follow later the same way`
                        : `Re-migrate all ${board.scenes.length} planned scenes into "${board.scenarioName}"`}
                    >
                      {fresh ? `Migrate remaining (${fresh} new) → ${board.scenarioName}` : `Re-migrate → ${board.scenarioName}`}
                    </button>
                  ) : (
                    <button
                      className="ghost"
                      onClick={() => void doMigratePartial()}
                      title={`Migrate scenes 1–${board.scenes.length} of ${board.sceneCount} into a project now — Continue plans the rest, Migrate remaining appends them later`}
                    >
                      Migrate partial ({board.scenes.length}/{board.sceneCount})
                    </button>
                  );
                })()
              )}
              {busy && (
                <button
                  className="ghost"
                  onClick={() => { cancelRef.current = true; abortRef.current?.abort(); }}
                  title="Stop now — planned scenes are kept, Continue resumes from the next scene"
                >
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
            {busy && sceneProgress && <p className="hint">{sceneProgress}{planRemainingMs != null && ` · ⏳ ${formatDuration(planRemainingMs)} left`} · partial scenes are kept — Stop resumes from the next scene.</p>}
            {!busy && stoppedNote && board.scenes.length < board.sceneCount && (
              <p className="hint">{stoppedNote} Or migrate what's planned so far with Migrate partial — the rest can follow later.</p>
            )}

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

            {board.blueprint && (
              <>
                <div className="row" style={{ alignItems: "center", marginTop: 4 }}>
                  <div className="section-label" style={{ margin: 0 }}>Characters · {chars.length}</div>
                  <span className="spacer" />
                  <button
                    className="ghost shotlist-btn"
                    onClick={() => void doAddEntry("character")}
                    disabled={addingEntry != null || busy != null}
                    title="AI reads the story/lyrics + master settings + existing bible and appends one new character"
                  >
                    {addingEntry === "character" ? <Spinner size={11} /> : <span aria-hidden="true">＋</span>}
                    {addingEntry === "character" ? "Adding…" : "Add character"}
                  </button>
                </div>
                {chars.length === 0 && addingEntry == null && (
                  <p className="hint" style={{ margin: "4px 0 0" }}>No characters yet — press Add character and the AI will invent one from the story.</p>
                )}
                <div
                  className="grid grid-bible"
                  style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(chars.length, 1), 5)}, minmax(0, 1fr))` }}
                >
                  {chars.map((c, i) => (
                    <div className="shot" key={String(c.character_id ?? i)}>
                      <div className="shot-head" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span aria-hidden="true" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {str(c.name) || `Character ${i + 1}`} · {str(c.role) || "supporting"}
                        </span>
                        <button
                          className="icon-btn"
                          onClick={() => void doRegenEntry("character", i)}
                          disabled={busy != null || addingEntry != null || regenEntry != null}
                          title={`Regenerate ${str(c.name) || `Character ${i + 1}`} with AI`}
                          aria-label={`Regenerate ${str(c.name) || `Character ${i + 1}`} with AI`}
                        >
                          {regenEntry?.kind === "character" && regenEntry.index === i ? <Spinner size={12} /> : <IconRefresh size={12} />}
                        </button>
                        <button
                          className="icon-btn danger"
                          onClick={() => void doDeleteChar(i)}
                          disabled={busy != null || addingEntry != null}
                          title={`Delete ${str(c.name) || `Character ${i + 1}`}`}
                          aria-label={`Delete ${str(c.name) || `Character ${i + 1}`}`}
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                      <p className="hint" style={{ margin: 0 }}>{str(c.visual_identity_prompt) || [str(c.species), str(c.age)].filter(Boolean).join(" · ") || "—"}</p>
                      <div className="row" style={{ marginTop: 6 }}>
                        <button
                          className="ghost shotlist-btn"
                          onClick={() => startEditChar(i)}
                          title={`Edit ${str(c.name) || `Character ${i + 1}`} — CHARACTER CONSISTENCY prompt + rules`}
                        >
                          🔒 Consistency · {charRules(c).length}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {editingChar != null && chars[editingChar] && (
                  <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label="Character consistency" onClick={() => setEditingChar(null)}>
                    <div className="dlg-box char-popup" onClick={(e) => e.stopPropagation()}>
                      <h3 className="dlg-title">
                        🔒 {str(chars[editingChar].name) || `Character ${editingChar + 1}`} — Character Consistency
                      </h3>
                      <p className="dlg-message">
                        The prompt is pasted verbatim into every scene; the rules steer the AI on every
                        scene batch. Changes apply to future generations.
                      </p>
                      <label>Name</label>
                      <input value={charDraft.name ?? ""} maxLength={60} onChange={(e) => setCharDraft((d) => ({ ...d, name: e.target.value }))} />
                      <label style={{ marginTop: 8 }}>Role</label>
                      <input value={charDraft.role ?? ""} maxLength={40} onChange={(e) => setCharDraft((d) => ({ ...d, role: e.target.value }))} />
                      <label style={{ marginTop: 8 }}>CHARACTER CONSISTENCY prompt (verbatim into every image_prompt)</label>
                      <textarea
                        rows={5}
                        value={charDraft.visual_identity_prompt ?? ""}
                        placeholder="Species + body + face + eyes + colors + clothing, comma-separated…"
                        onChange={(e) => setCharDraft((d) => ({ ...d, visual_identity_prompt: e.target.value }))}
                      />
                      <div className="char-rules-head">
                        <label style={{ margin: 0 }}>Consistency rules · {ruleDraft.length}</label>
                        <button
                          className="ghost shotlist-btn"
                          onClick={() => { setRuleDraft([...DEFAULT_CHAR_RULES]); }}
                          title="Restore the pre-defined default rules"
                        >
                          Reset defaults
                        </button>
                      </div>
                      <div className="char-rules-list">
                        {ruleDraft.map((r, ri) => (
                          <div className="char-rule-row" key={ri}>
                            <input
                              value={r}
                              maxLength={240}
                              onChange={(e) => setRuleDraft((list) => list.map((x, xi) => (xi === ri ? e.target.value : x)))}
                              title={`Rule ${ri + 1} — editable, sent to the AI`}
                            />
                            <button
                              className="icon-btn danger"
                              onClick={() => setRuleDraft((list) => list.filter((_, xi) => xi !== ri))}
                              title={`Delete rule ${ri + 1}`}
                              aria-label={`Delete rule ${ri + 1}`}
                            >
                              <IconTrash size={12} />
                            </button>
                          </div>
                        ))}
                        {ruleDraft.length === 0 && (
                          <p className="hint" style={{ margin: "4px 0" }}>
                            No rules — the AI gets no per-character consistency instructions. Reset defaults to restore.
                          </p>
                        )}
                      </div>
                      <div className="char-rule-row" style={{ marginTop: 6 }}>
                        <input
                          value={newRule}
                          maxLength={240}
                          placeholder="Add a custom rule, e.g. Always keep the red scarf visible…"
                          onChange={(e) => setNewRule(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && newRule.trim()) {
                              e.preventDefault();
                              setRuleDraft((list) => [...list, newRule.trim()]);
                              setNewRule("");
                            }
                          }}
                          title="Type a custom consistency rule and press Enter or Add"
                        />
                        <button
                          className="ghost shotlist-btn"
                          disabled={!newRule.trim()}
                          onClick={() => {
                            if (!newRule.trim()) return;
                            setRuleDraft((list) => [...list, newRule.trim()]);
                            setNewRule("");
                          }}
                          title="Add this custom rule"
                        >
                          Add
                        </button>
                      </div>
                      <div className="dlg-actions">
                        <button className="ghost" onClick={() => setEditingChar(null)} title="Close without saving">
                          Cancel
                        </button>
                        <button className="primary" onClick={() => void saveEditChar()} disabled={savingChar} title="Save prompt + rules for this character">
                          {savingChar ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {board.blueprint && (
              <>
                <div className="row" style={{ alignItems: "center", marginTop: 8 }}>
                  <div className="section-label" style={{ margin: 0 }}>World · {locs.length} location{locs.length === 1 ? "" : "s"} · {objs.length} object{objs.length === 1 ? "" : "s"}</div>
                  <span className="spacer" />
                  <button
                    className="ghost shotlist-btn"
                    onClick={() => void doAddEntry("location")}
                    disabled={addingEntry != null || busy != null}
                    title="AI reads the story/lyrics + master settings + existing bible and appends one new location"
                  >
                    {addingEntry === "location" ? <Spinner size={11} /> : <span aria-hidden="true">＋</span>}
                    {addingEntry === "location" ? "Adding…" : "Add location"}
                  </button>
                  <button
                    className="ghost shotlist-btn"
                    onClick={() => void doAddEntry("object")}
                    disabled={addingEntry != null || busy != null}
                    title="AI reads the story/lyrics + master settings + existing bible and appends one new object"
                  >
                    {addingEntry === "object" ? <Spinner size={11} /> : <span aria-hidden="true">＋</span>}
                    {addingEntry === "object" ? "Adding…" : "Add object"}
                  </button>
                </div>
                <div
                  className="grid grid-bible"
                  style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(locs.length + objs.length, 1), 5)}, minmax(0, 1fr))` }}
                >
                  {locs.map((l, i) => (
                    <div className="shot" key={String(l.location_id ?? `l${i}`)}>
                      <div className="shot-head" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span aria-hidden="true" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>📍 {str(l.name) || `Location ${i + 1}`}</span>
                        <button
                          className="icon-btn"
                          onClick={() => void doRegenEntry("location", i)}
                          disabled={busy != null || addingEntry != null || regenEntry != null}
                          title={`Regenerate ${str(l.name) || `Location ${i + 1}`} with AI`}
                          aria-label={`Regenerate ${str(l.name) || `Location ${i + 1}`} with AI`}
                        >
                          {regenEntry?.kind === "location" && regenEntry.index === i ? <Spinner size={12} /> : <IconRefresh size={12} />}
                        </button>
                        <button
                          className="icon-btn danger"
                          onClick={() => void doDeleteLoc(i)}
                          disabled={busy != null || addingEntry != null}
                          title={`Delete ${str(l.name) || `Location ${i + 1}`}`}
                          aria-label={`Delete ${str(l.name) || `Location ${i + 1}`}`}
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                      <p className="hint" style={{ margin: 0 }}>{str(l.visual_identity_prompt) || str(l.description) || "—"}</p>
                    </div>
                  ))}
                  {objs.map((o, i) => (
                    <div className="shot" key={String(o.object_id ?? `o${i}`)}>
                      <div className="shot-head" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span aria-hidden="true" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>🧭 {str(o.name) || `Object ${i + 1}`}</span>
                        <button
                          className="icon-btn"
                          onClick={() => void doRegenEntry("object", i)}
                          disabled={busy != null || addingEntry != null || regenEntry != null}
                          title={`Regenerate ${str(o.name) || `Object ${i + 1}`} with AI`}
                          aria-label={`Regenerate ${str(o.name) || `Object ${i + 1}`} with AI`}
                        >
                          {regenEntry?.kind === "object" && regenEntry.index === i ? <Spinner size={12} /> : <IconRefresh size={12} />}
                        </button>
                        <button
                          className="icon-btn danger"
                          onClick={() => void doDeleteObj(i)}
                          disabled={busy != null || addingEntry != null}
                          title={`Delete ${str(o.name) || `Object ${i + 1}`}`}
                          aria-label={`Delete ${str(o.name) || `Object ${i + 1}`}`}
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                      <p className="hint" style={{ margin: 0 }}>{str(o.visual_identity_prompt) || str(o.description) || "—"}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {beats.length > 0 && (
              <>
                <div className="row" style={{ alignItems: "center" }}>
                  <div className="section-label" style={{ margin: 0 }}>Story beats · {beats.length}</div>
                  <span className="spacer" />
                  <span className="pill" title={`${beats.length} story beats drive the scene plan`}>🎬 {beats.length} beats</span>
                </div>
                <div className="dir-beats">
                  {beats.map((b) => (
                    <div className="dir-beat" key={b.n} title={`Beat ${b.n}: ${b.title}`}>
                      <span className="dir-beat-num" aria-hidden="true">{b.n}</span>
                      <span className="dir-beat-body">
                        <span className="dir-beat-title" title={b.title}>{b.title}</span>
                        <span className="dir-beat-text" title={b.summary}>{b.summary || "—"}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(board.scenes.length > 0 || board.sceneCount > 0) && (
              <>
                <div className="section-label">Scenes · {board.scenes.length}/{board.sceneCount}</div>
                <div
                  className="grid grid-bible"
                  style={{ gridTemplateColumns: `repeat(${boardsOpen ? 5 : 6}, minmax(0, 1fr))` }}
                  title={boardsOpen ? undefined : "Boards collapsed — showing 6 scenes per row"}
                >
                  {board.scenes.map((s, i) => {
                    const selected = selectedScene === i;
                    return (
                      <div className="shot" key={s.scene_number} id={`dir-scene-${s.scene_number}`} style={selected ? { borderColor: "var(--accent-line)" } : undefined}>
                        <div className="shot-head" aria-hidden="true">
                          Scene {s.scene_number}/{board.sceneCount}
                        </div>
                        <div className="shotlist-desc-title" title={s.title}>{s.title}</div>
                        <p className="hint" style={{ margin: "4px 0" }}>{s.action || "—"}</p>
                        <span className="muted" style={{ fontSize: 11 }}>
                          {s.camera?.shot_type ?? ""}{s.camera?.movement ? ` · ${s.camera.movement}` : ""} · {s.duration_seconds}s
                          {Array.isArray(s.dialogue) && s.dialogue.length ? ` · 🎙 ${s.dialogue.length} line${s.dialogue.length === 1 ? "" : "s"}` : ""}
                        </span>
                        <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
                          <button
                            className={`ghost shotlist-btn${selected ? " on" : ""}`}
                            onClick={() => openSceneDetails(i)}
                            title={`Open the full breakdown of Scene ${s.scene_number} in a popup`}
                          >
                            Details
                          </button>
                          <button className="ghost shotlist-btn" onClick={() => openSceneEdit(i)} title={`Edit Scene ${s.scene_number} in a popup`}>
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
                      </div>
                    );
                  })}
                  {Array.from({ length: Math.max(0, board.sceneCount - board.scenes.length) }, (_, k) => {
                    const num = board.scenes.length + 1 + k;
                    const isGen = generatingRange != null && num >= generatingRange.from && num <= generatingRange.to;
                    const eta = planSceneEta(num);
                    return (
                      <div
                        className={`shot${isGen ? " generating" : " is-queued"}`}
                        key={`pending-${num}`}
                        id={`dir-scene-pending-${num}`}
                        aria-label={`Scene ${num} ${isGen ? "generating" : "to be generated"}${eta != null ? `, about ${formatDuration(eta)} remaining` : ""}`}
                      >
                        <div className="shot-head" aria-hidden="true">
                          Scene {num}/{board.sceneCount}
                        </div>
                        {isGen ? (
                          <p className="hint" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                            <Spinner size={11} /> Generating…{eta != null && ` · ~${formatDuration(eta)} left`}
                          </p>
                        ) : (
                          <p className="hint" style={{ margin: 0 }}>To be Generated{eta != null && ` · ~${formatDuration(eta)}`}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
                {sceneModal && (() => {
                  const d = board.scenes[sceneModal.index];
                  if (!d) return null;
                  const isEdit = sceneModal.mode === "edit" && editingScene === sceneModal.index;
                  return (
                    <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label={isEdit ? `Edit Scene ${d.scene_number}` : `Scene ${d.scene_number} details`} onClick={() => closeSceneModal()}>
                      <div className="dlg-box scene-popup" onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
                          <h3 className="dlg-title" style={{ margin: 0, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                            {isEdit ? `✏️ Edit Scene ${d.scene_number}/${board.sceneCount}` : `🎬 Scene ${d.scene_number}/${board.sceneCount}`} — {isEdit ? str(sceneDraft.title ?? d.title) || d.title : d.title}
                          </h3>
                          <button className="icon-btn" onClick={() => closeSceneModal()} title="Close popup (Esc)" aria-label="Close popup">
                            ✕
                          </button>
                        </div>
                        {isEdit ? (
                          <>
                            <label>Title</label>
                            <input value={str(sceneDraft.title ?? "")} maxLength={80} onChange={(e) => setSceneDraft((x) => ({ ...x, title: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Action (visible behavior)</label>
                            <textarea rows={3} value={str(sceneDraft.action ?? "")} onChange={(e) => setSceneDraft((x) => ({ ...x, action: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Emotion</label>
                            <input value={str(sceneDraft.emotion ?? "")} maxLength={60} onChange={(e) => setSceneDraft((x) => ({ ...x, emotion: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Duration (sec)</label>
                            <input type="number" min={1} max={30} value={Number(sceneDraft.duration_seconds ?? d.duration_seconds)} onChange={(e) => setSceneDraft((x) => ({ ...x, duration_seconds: Number(e.target.value) }))} />
                            <label style={{ marginTop: 6 }} title="One per line as speaker: line — voiced per character (Edge-TTS Hindi) and lip-synced; the clip grows to fit the voice">Dialogue (speaker: line per line — voiced + lip-synced)</label>
                            <textarea rows={3} value={dialogueDraft} placeholder={"chiku: नमस्ते! मैं चीकू हूँ।\nshera: कौन है वहाँ?"} onChange={(e) => setDialogueDraft(e.target.value)} />
                            <label style={{ marginTop: 6 }}>Image prompt</label>
                            <textarea rows={4} value={str(sceneDraft.image_prompt ?? "")} onChange={(e) => setSceneDraft((x) => ({ ...x, image_prompt: e.target.value }))} />
                            <label style={{ marginTop: 6 }}>Video prompt</label>
                            <textarea rows={4} value={str(sceneDraft.video_prompt ?? "")} onChange={(e) => setSceneDraft((x) => ({ ...x, video_prompt: e.target.value }))} />
                            <div className="dlg-actions" style={{ marginTop: 12 }}>
                              <button className="ghost" onClick={() => { setEditingScene(null); setSceneModal({ index: sceneModal.index, mode: "details" }); }} title="Back to the full breakdown without saving">
                                Back
                              </button>
                              <button className="primary" onClick={() => void saveEditScene()} title="Save changes to this scene">
                                Save scene
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
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
                              <p>{d.dialogue.map((x, li) => (
                                <span key={li} title={`${x.speaker} (voice: per-character Hindi TTS)`}>
                                  <b>{x.speaker || "voice"}</b>: {x.line}{li < d.dialogue.length - 1 ? <br /> : null}
                                </span>
                              ))}</p>
                            ) : (
                              <p>—</p>
                            )}
                            <div className="row" style={{ marginTop: 12 }}>
                              <button
                                className="ghost shotlist-btn"
                                disabled={sceneModal.index <= 0}
                                onClick={() => stepSceneModal(-1)}
                                title="Previous scene"
                              >
                                ← Prev
                              </button>
                              <button
                                className="ghost shotlist-btn"
                                disabled={sceneModal.index >= board.scenes.length - 1}
                                onClick={() => stepSceneModal(1)}
                                title="Next scene"
                              >
                                Next →
                              </button>
                              <span className="spacer" />
                              <button
                                className="ghost shotlist-btn"
                                onClick={() => openSceneEdit(sceneModal.index)}
                                title={`Edit Scene ${d.scene_number}`}
                              >
                                Edit scene
                              </button>
                              <button className="primary" onClick={() => closeSceneModal()} title="Close popup (Esc)">
                                Close
                              </button>
                            </div>
                          </>
                        )}
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
      {boardsOpen ? (
        <aside className="card dir-rail" aria-label="Saved storyboards">
          <div className="card-head">
            <h2>
              <span className="head-icon hi-output" aria-hidden="true"><IconFolder size={15} /></span>
              Saved Storyboards
            </h2>
            <span className="muted" title={`${boards.length} boards stored in the database`}>{boards.length}</span>
            <span className="spacer" />
            <button
              className="icon-btn"
              onClick={toggleBoards}
              title="Collapse saved storyboards to the right"
              aria-label="Collapse saved storyboards"
              aria-expanded="true"
            >
              <IconPanel size={15} />
            </button>
          </div>
          {boardsPanel}
        </aside>
      ) : (
        <button
          className="sidebar-show rail-right"
          onClick={toggleBoards}
          title="Show saved storyboards"
          aria-label="Show saved storyboards"
          aria-expanded="false"
          type="button"
        >
          <IconFolder size={15} />
          <span className="sidebar-show-label">Boards</span>
        </button>
      )}
    </div>
  );
}
