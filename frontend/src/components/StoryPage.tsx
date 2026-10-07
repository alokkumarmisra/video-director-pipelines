// Story Mode — STORY PAGE ONLY.
//
// This is the Story → AI Director → CINEMATIC STORY PRODUCTION surface. It
// authors nothing itself: every AI stage reuses the EXISTING Director
// pipeline (same LLM convention, same bible/scene/album storage, same
// approve → saveScenario → workspace generation):
//
//   USER STORY
//   → directorAnalyze  (story analysis + character/location/object bibles +
//                       beats: the structured screenplay / single source of
//                       truth — stable character_id slugs, never bare names)
//   → directorScenes   (scene batches ≤12: scene segmentation + dialogue
//                       ownership + emotion/expression/body/camera + timed
//                       shots + continuity + visual prompts)
//   → Story QA         (client-side checklist, §21 — pure, no LLM call)
//   → directorApprove + saveScenario (standard scenario config → EXISTING
//                       image → video → dialogue/TTS → lip-sync → final cut)
//   → DirectorGeneration (existing RunPanel/OutputGallery — renders the
//                       approved project's clips; dialogue beats grow to fit
//                       real voice-audio length, lip-sync runs per active
//                       speaker only)
//
// No new tables, no new endpoints, no new generation code. The canonical
// plan object is the DirectorBoard: RAW STORY → BOARD → GENERATION PLAN →
// AUDIO/IMAGE/VIDEO/LIP-SYNC. Downstream stages never reinterpret the raw
// story — they read the board.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  directorAnalyze, directorApprove, directorBoard,
  directorRegenScene, directorScenes, directorUpdateBoard, saveScenario,
  type DirectorBoard, type DirectorInput, type DirectorScene, type ImageMode,
} from "../api";
import { useDialog } from "./Dialog";
import DirectorGeneration from "./DirectorGeneration";
import { IconCheck, IconClapper, IconFilm, IconRefresh, IconSparkles, IconTrash, Spinner } from "./Icons";

type StoryTab = "characters" | "scenes" | "dialogue" | "timeline";

const LANGS = ["Hindi", "English", "Hinglish"];
const GENRES = ["Kids", "Devotional", "Adventure", "Fantasy", "Comedy", "Mythological", "Educational", "Custom"];
const STYLES = ["3D Preschool Animation", "3D Cinematic", "Realistic", "Anime", "Cartoon", "Indian Mythological", "Fantasy", "Custom"];

const str = (v: unknown, fb = ""): string => (v == null ? fb : String(v));

// Pipeline step flow for the hero (derived from board state, never stored).
const STEPS = ["Write", "Analyze", "Plan scenes", "Validate & Approve", "Generate"];
// Stable per-speaker hue for avatars/bubbles (HSL hue only — bubble
// gradients stay theme-safe in dark + light).
const spkHue = (name: string): number => {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

// First acceptance-test story (§42): Ram / Sita / Shyam, 5 dialogues with
// exact ownership Ram → Sita → Shyam → Ram → Shyam.
const TEST_STORY = `Ram and Sita are walking through a peaceful forest. Sita looks worried. Ram notices her expression and looks at her with concern.

Ram says, 'Sita, do not worry. I am with you.'

Sita looks at Ram and smiles gently.

Sita says, 'I know, Ram. When you are with me, I am not afraid.'

Suddenly, Shyam appears from behind the trees. He looks frightened.

Shyam says, 'Ram! Sita! You must leave this place immediately.'

Ram turns toward Shyam with a serious expression.

Ram says, 'What happened, Shyam?'

Shyam replies, 'There is danger ahead.'`;

type CharRec = Record<string, unknown>;
const charsOf = (b: DirectorBoard | null): CharRec[] =>
  (b?.blueprint?.characters ?? []) as unknown as CharRec[];
const charIdOf = (c: CharRec, i: number): string =>
  str(c.character_id || c.id || c.name || `character_${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "_") || `character_${i + 1}`;
const charById = (b: DirectorBoard | null, id: string): CharRec | undefined => {
  const want = str(id).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return charsOf(b).find((c, i) => charIdOf(c, i) === want);
};

// "speaker: line" per line, optional "(expression)" after the speaker — the
// same line grammar the Director editor uses, so edits stay compatible.
const parseDlg = (text: string): { speaker: string; line: string; expression?: string }[] =>
  text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const c = l.indexOf(":");
    if (c <= 0) return { speaker: "", line: l };
    const head = l.slice(0, c).trim();
    const line = l.slice(c + 1).trim();
    const m = head.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    return m ? { speaker: m[1].trim(), expression: m[2].trim(), line } : { speaker: head, line };
  }).filter((d) => d.line);
const formatDlg = (dlg: unknown): string =>
  (Array.isArray(dlg) ? dlg.map((d) => {
    const o = d as { speaker?: unknown; line?: unknown; expression?: unknown };
    const sp = str(o.speaker).trim();
    const ln = str(o.line).trim();
    const ex = str(o.expression).trim();
    const head = sp && ex ? `${sp} (${ex})` : sp;
    return head ? `${head}: ${ln}` : ln;
  }).filter(Boolean).join("\n") : "");

// Rough speak time for the dialogue timeline until real TTS audio exists
// (the generation pipeline replaces estimates with measured wav lengths and
// grows each clip to fit — see beatTargetDuration in the sequence runners).
const estLineSeconds = (line: string): number => {
  const words = line.split(/\s+/).filter(Boolean).length;
  return Math.round((0.8 + words * 0.45) * 10) / 10;
};

interface QaResult { errors: string[]; warnings: string[] }

// Story QA (§21) — pure client-side checklist over the single source of
// truth (the board). Mirrors validateStoryBoard in lib/director.mjs (the
// server approve gate uses the same rules). Errors block Approve; warnings
// are advisory.
function validateStory(b: DirectorBoard): QaResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const chars = charsOf(b);
  const ids = new Set(chars.map((c, i) => charIdOf(c, i)));
  const names = new Map(chars.map((c, i) => [str(c.name).toLowerCase(), charIdOf(c, i)]));
  if (!b.blueprint) errors.push("No story analysis yet — press Analyze Story first.");
  if (!chars.length) errors.push("No characters in the registry — regenerate the analysis.");
  if (!b.scenes.length) errors.push("No scenes planned yet — press Generate Scenes.");
  // Continuity canon: every character should carry a visual identity prompt.
  chars.forEach((c, i) => {
    if (!str(c.visual_identity_prompt).trim()) {
      warnings.push(`Character "${str(c.name) || charIdOf(c, i)}" has no visual identity — appearance may drift between scenes.`);
    }
  });
  // Scene order: numbers unique and strictly increasing in plan order.
  const seenNums = new Set<number>();
  let prevNum = 0;
  b.scenes.forEach((s, si) => {
    const n = Number(s.scene_number);
    const label = `Scene ${s.scene_number || si + 1}`;
    if (!Number.isFinite(n) || n <= 0) errors.push(`${label} has no valid scene_number.`);
    else {
      if (seenNums.has(n)) errors.push(`${label} reuses scene_number ${n} — plan order is ambiguous.`);
      seenNums.add(n);
      if (n <= prevNum) errors.push(`${label} is out of order (scene_number ${n} after ${prevNum}).`);
      prevNum = Math.max(prevNum, n);
    }
  });
  const seenLines = new Map<string, { where: string; speaker: string }>();
  const checkDlg = (dlg: unknown, where: string) => {
    (Array.isArray(dlg) ? dlg : []).forEach((dd, di) => {
      const d = dd as { speaker?: unknown; line?: unknown; emotion?: unknown; expression?: unknown };
      const at = `${where} dialogue ${di + 1}`;
      const line = str(d.line).trim();
      const speaker = str(d.speaker).trim();
      if (!line) { errors.push(`${at} has no text.`); return; }
      if (!speaker) { errors.push(`${at} ("${line.slice(0, 40)}…") has no speaker.`); return; }
      const key = speaker.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (!ids.has(key) && !names.has(speaker.toLowerCase())) {
        errors.push(`${at} speaker "${speaker}" is not a registered character.`);
        return;
      }
      if (!str(d.emotion).trim()) errors.push(`${at} (${speaker}) is missing emotion.`);
      if (!str(d.expression).trim()) errors.push(`${at} (${speaker}) is missing expression.`);
      const norm = line.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
      if (norm) {
        const prev = seenLines.get(norm);
        if (prev && prev.speaker !== key) {
          errors.push(`${at} repeats the line from ${prev.where} under a different speaker — dialogue belongs to exactly one character.`);
        } else if (prev && prev.where === where) {
          warnings.push(`${at} repeats a line from the same scene — possible AI duplication.`);
        } else if (!prev) {
          seenLines.set(norm, { where, speaker: key });
        }
      }
    });
  };
  b.scenes.forEach((s, si) => {
    const label = `Scene ${s.scene_number || si + 1}`;
    for (const cid of s.characters ?? []) {
      const key = str(cid).toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (key && !ids.has(key) && !names.has(str(cid).toLowerCase())) {
        errors.push(`${label} references unknown character "${str(cid)}" (not in the registry).`);
      }
    }
    (s.shots ?? []).forEach((sh) => {
      for (const cid of sh.characters ?? []) {
        const key = str(cid).toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (key && !ids.has(key) && !names.has(str(cid).toLowerCase())) {
          errors.push(`${label} shot ${str(sh.shot_id)} references unknown character "${str(cid)}".`);
        }
      }
      if (Array.isArray((sh as { dialogue?: unknown }).dialogue) && ((sh as { dialogue?: unknown[] }).dialogue ?? []).length) {
        checkDlg((sh as { dialogue?: unknown }).dialogue, `${label} shot ${str(sh.shot_id)}`);
      }
    });
    checkDlg(s.dialogue, label);
  });
  return { errors, warnings };
}

export default function StoryPage({ onOpenProject, onProjectsChanged, imageMode, onImageMode }: {
  onOpenProject?: (name: string) => void;
  onProjectsChanged?: () => void;
  imageMode?: ImageMode;
  onImageMode?: (mode: ImageMode) => void;
} = {}) {
  const dialog = useDialog();
  // Story input (§3). Advanced knobs stay hidden — the board + style lock
  // carry the cinematic defaults from the existing pipeline.
  const [title, setTitle] = useState("");
  const [story, setStory] = useState("");
  const [language, setLanguage] = useState("Hindi");
  const [genre, setGenre] = useState("Kids");
  const [visualStyle, setVisualStyle] = useState("3D Preschool Animation");
  const [targetSeconds, setTargetSeconds] = useState("60");
  const [sceneSeconds, setSceneSeconds] = useState("5");
  const [includeDialogue, setIncludeDialogue] = useState(true);
  const [tab, setTab] = useState<StoryTab>("characters");
  const [board, setBoard] = useState<DirectorBoard | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [qa, setQa] = useState<QaResult | null>(null);
  const [regenScene, setRegenScene] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(0);
  const [showPrompts, setShowPrompts] = useState(false);
  // Story Editor (§23): inline drafts, persisted via directorUpdateBoard.
  const [editingChar, setEditingChar] = useState<number | null>(null);
  const [charName, setCharName] = useState("");
  const [charIdentity, setCharIdentity] = useState("");
  const [editingScene, setEditingScene] = useState<number | null>(null);
  const [sceneDlgDraft, setSceneDlgDraft] = useState("");
  const [sceneActionDraft, setSceneActionDraft] = useState("");
  const cancelRef = useRef(false);
  // 1s ticker so the busy elapsed counter stays live while planning.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const fail = (e: unknown, suffix = "") => {
    const msg = `${e instanceof Error ? e.message : String(e)}${suffix}`;
    setError(msg);
    if (/LLM(\s|$|_BASE)|llama|chat\/completions/i.test(msg)) {
      void dialog.alert(msg, { title: "AI request failed", tone: "error" });
    }
  };

  const newStory = () => {
    setBoard(null); setQa(null); setError(""); setProgress("");
    setTitle(""); setStory(""); setExpanded(0); setEditingChar(null); setEditingScene(null);
  };

  const doAnalyze = async () => {
    if (busy) return;
    const input: DirectorInput = {
      title: title.trim(), story: story.trim(), language,
      genre, genreCustom: "", visualStyle, styleCustom: "",
      targetSeconds: Math.max(15, Math.min(3600, Math.round(Number(targetSeconds) || 60))),
      sceneSeconds: Math.min(30, Math.max(1, Math.round(Number(sceneSeconds) || 5))),
      aspectRatio: "16:9", instructions: "",
      includeDialogue, chainContinuity: true,
    };
    if (!input.title) { setError("Give the story a title."); return; }
    if (input.story.length < 20) { setError("Paste the full story (20+ characters)."); return; }
    setBusy("Analyzing story — characters, locations, beats…");
    setBusySince(Date.now()); setError(""); setQa(null);
    try {
      const b = await directorAnalyze(input);
      setBoard(b); setTab("characters"); setExpanded(0);
    } catch (e) { fail(e); }
    finally { setBusy(null); setBusySince(null); }
  };

  // Duration-driven scene planning (§11–12): resumable batches until the
  // timeline is covered; Stop keeps planned scenes, Continue resumes. A
  // no-progress batch breaks the loop instead of spinning forever.
  const doScenes = async () => {
    if (!board || busy) return;
    cancelRef.current = false;
    setBusy("Planning scenes…"); setBusySince(Date.now()); setError("");
    try {
      let b = await directorBoard(board.id).catch(() => board);
      setBoard(b);
      while (b.scenes.length < b.sceneCount) {
        if (cancelRef.current) break;
        setProgress(`Scene ${b.scenes.length + 1}–${Math.min(b.sceneCount, b.scenes.length + 12)} of ${b.sceneCount}`);
        const prevLen = b.scenes.length;
        b = await directorScenes(b.id);
        setBoard(b);
        if (b.scenes.length <= prevLen) {
          setError("Scene planning stalled (server returned no new scenes) — partial scenes are kept, retry continues.");
          break;
        }
      }
      setTab("scenes");
    } catch (e) { fail(e, " — partial scenes are kept, retry continues."); }
    finally { setBusy(null); setBusySince(null); setProgress(""); }
  };

  const doRegenScene = async (index: number) => {
    if (!board || regenScene != null) return;
    setRegenScene(index); setError(""); setQa(null);
    try { setBoard(await directorRegenScene(board.id, index)); }
    catch (e) { fail(e); }
    finally { setRegenScene(null); }
  };

  const doDeleteScene = async (index: number) => {
    if (!board) return;
    const s = board.scenes[index];
    const ok = await dialog.confirm("The plan renumbers after deletion.", {
      title: `Delete Scene ${s.scene_number} (${s.title})?`, tone: "error", okText: "Delete", cancelText: "Keep",
    });
    if (!ok) return;
    try {
      setBoard(await directorUpdateBoard(board.id, { scenes: board.scenes.filter((_, i) => i !== index) }));
      setQa(null);
    } catch (e) { fail(e); }
  };

  const startEditChar = (i: number) => {
    const c = charsOf(board)[i];
    if (!c) return;
    setEditingChar(i);
    setCharName(str(c.name));
    setCharIdentity(str(c.visual_identity_prompt));
  };
  const saveChar = async () => {
    if (!board?.blueprint || editingChar == null) return;
    const oldRec = charsOf(board)[editingChar];
    const oldId = charIdOf(oldRec, editingChar);
    const oldName = str(oldRec.name).toLowerCase();
    const nextName = charName.trim() || str(oldRec.name);
    // The stable id follows character_id, falling back to the name — so a
    // rename can change the effective id. Remap every scene ref + dialogue
    // speaker using the old id (or old display name) to the new id, or the
    // rename orphans that character's lines (QA: unregistered speaker).
    const nextId = str((oldRec as { character_id?: unknown }).character_id || nextName)
      .toLowerCase().replace(/[^a-z0-9]+/g, "_") || oldId;
    const remap = (v: unknown) => {
      const s = str(v);
      const k = s.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      return (k === oldId || s.toLowerCase() === oldName) ? nextId : s;
    };
    const next = (board.blueprint.characters as CharRec[]).map((c, i) =>
      i === editingChar ? { ...(c as object), name: nextName, visual_identity_prompt: charIdentity.trim() } : c);
    const scenes = board.scenes.map((s) => ({
      ...s,
      characters: (s.characters ?? []).map(remap),
      dialogue: (s.dialogue ?? []).map((d) => ({ ...d, speaker: remap((d as { speaker?: unknown }).speaker) })),
      shots: (s.shots ?? []).map((sh) => ({
        ...sh,
        characters: (sh.characters ?? []).map(remap),
        dialogue: ((sh as { dialogue?: Array<{ speaker?: unknown }> }).dialogue ?? []).map((d) => ({ ...d, speaker: remap(d.speaker) })),
      })),
    }));
    try {
      // Character changed → affected visuals regenerate from the new canon
      // on the next Generate run (existing versioning keeps old assets).
      setBoard(await directorUpdateBoard(board.id, { characters: next, scenes }));
      setEditingChar(null); setQa(null);
    } catch (e) { fail(e); }
  };

  const startEditScene = (i: number) => {
    const s = board?.scenes[i];
    if (!s) return;
    setEditingScene(i);
    setSceneDlgDraft(formatDlg(s.dialogue));
    setSceneActionDraft(str(s.action));
  };
  const saveScene = async () => {
    if (!board || editingScene == null) return;
    const parsed = parseDlg(sceneDlgDraft);
    const prev = board.scenes[editingScene]?.dialogue ?? [];
    // The one-line grammar carries speaker/line/(expression) only — emotion
    // and pitch live outside it. Merge by line index so editing text never
    // strips them (a stripped line would trip Story QA right after saving);
    // brand-new lines get neutral defaults that pass QA immediately.
    const dlg = parsed.map((p, i) => {
      const o = (prev[i] ?? {}) as { emotion?: unknown; expression?: unknown; pitch?: unknown };
      return {
        speaker: p.speaker,
        line: p.line,
        expression: p.expression || str(o.expression) || "calm, natural expression",
        emotion: str(o.emotion) || "neutral",
        ...(str(o.pitch) ? { pitch: str(o.pitch) } : {}),
      };
    });
    const next = board.scenes.map((s, i) => (i === editingScene
      ? { ...s, dialogue: dlg, action: sceneActionDraft.trim() || s.action }
      : s));
    try {
      // Dialogue changed → voice + lip-sync go stale and re-render from the
      // edited lines (clip pixels are kept); action changed → shot re-render.
      setBoard(await directorUpdateBoard(board.id, { scenes: next }));
      setEditingScene(null); setQa(null);
    } catch (e) { fail(e); }
  };

  const runQa = () => {
    if (!board) return;
    const r = validateStory(board);
    setQa(r);
    if (r.errors.length) setTab("characters");
  };

  // Fix Automatically (§21): safe repairs only — fill missing
  // emotion/expression with neutral defaults, drop unknown character refs
  // and empty lines, renumber scenes 1..N. Persists via directorUpdateBoard
  // (existing versioning keeps prior assets); per-scene regen stays manual.
  const doAutoFix = async () => {
    if (!board || busy) return;
    const normKey = (v: unknown) => str(v).toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const charIds = new Set(charsOf(board).map((c, i) => charIdOf(c, i)));
    const charNames = new Set(charsOf(board).map((c) => str(c.name).toLowerCase()).filter(Boolean));
    const known = (v: unknown) => {
      const k = normKey(v);
      return !!k && (charIds.has(k) || charNames.has(str(v).toLowerCase()));
    };
    const fixed: string[] = [];
    const fixDlg = (dlg: DirectorScene["dialogue"] | undefined, where: string) => {
      const out: NonNullable<DirectorScene["dialogue"]> = [];
      for (const dd of dlg ?? []) {
        const d = { ...(dd as object) } as { speaker?: unknown; line?: unknown; emotion?: unknown; expression?: unknown };
        if (!str(d.line).trim()) { fixed.push(`${where}: removed empty dialogue line.`); continue; }
        if (d.speaker && !known(d.speaker)) { fixed.push(`${where}: dropped dialogue by unknown speaker "${str(d.speaker)}".`); continue; }
        if (!str(d.emotion).trim()) { d.emotion = "neutral"; fixed.push(`${where}: filled missing emotion with "neutral".`); }
        if (!str(d.expression).trim()) { d.expression = "calm, natural expression"; fixed.push(`${where}: filled missing expression with a calm default.`); }
        out.push(d as never);
      }
      return out;
    };
    const scenes = board.scenes.map((s, si) => {
      const label = `Scene ${s.scene_number || si + 1}`;
      const kept = (s.characters ?? []).filter((c) => known(c));
      if (kept.length !== (s.characters ?? []).length) fixed.push(`${label}: dropped unknown character refs.`);
      const shots = (s.shots ?? []).map((sh) => ({
        ...sh,
        characters: (sh.characters ?? []).filter((c) => known(c)),
        dialogue: fixDlg((sh as { dialogue?: DirectorScene["dialogue"] }).dialogue, `${label} shot ${str(sh.shot_id)}`),
      }));
      if (Number(s.scene_number) !== si + 1) fixed.push(`${label}: renumbered to scene ${si + 1}.`);
      return { ...s, characters: kept, dialogue: fixDlg(s.dialogue, label), shots, scene_number: si + 1 };
    });
    if (!fixed.length) {
      await dialog.alert("Nothing safe to auto-fix — edit the flagged rows manually or regenerate the scene.", { title: "No automatic fixes", tone: "info" });
      return;
    }
    setBusy("Applying story fixes…");
    try {
      const nb = await directorUpdateBoard(board.id, { scenes });
      setBoard(nb);
      setQa(validateStory(nb));
      await dialog.alert(`Applied ${fixed.length} safe fix(es):\n• ${[...new Set(fixed)].slice(0, 8).join("\n• ")}`, { title: "Story fixes applied", tone: "success" });
    } catch (e) { fail(e); }
    finally { setBusy(null); }
  };

  const doApprove = async () => {
    if (!board || busy || !board.scenes.length) return;
    const r = validateStory(board);
    setQa(r);
    if (r.errors.length) {
      await dialog.alert(`Fix ${r.errors.length} story error(s) before approving:\n• ${r.errors.slice(0, 6).join("\n• ")}${r.errors.length > 6 ? `\n…+${r.errors.length - 6} more` : ""}`, { title: "Story QA failed", tone: "error" });
      return;
    }
    const beats = board.scenes.reduce((a, s) => a + Math.max(1, (s.shots ?? []).length), 0);
    const partial = board.scenes.length < board.sceneCount;
    const ok = await dialog.confirm(
      partial
        ? `Only ${board.scenes.length}/${board.sceneCount} scenes are planned — approving now creates a PARTIAL project ("${board.input.title}", ${beats} clips). Plan the rest first, or re-approve later to migrate remaining scenes into the same project.`
        : `Creates project "${board.input.title}" with ${board.scenes.length} scenes (${beats} clips — one per shot), then generates images → videos → dialogue voices → character lip-sync → final cut in the existing pipeline.`,
      { title: `Approve story "${board.input.title}"?`, tone: "info", okText: partial ? "Approve partial" : "Approve", cancelText: "Keep editing" });
    if (!ok) return;
    setBusy("Approving story…"); setBusySince(Date.now()); setError("");
    try {
      const { name, config } = await directorApprove(board.id);
      await saveScenario(name, config);
      onProjectsChanged?.();
      setBoard(await directorBoard(board.id));
      await dialog.alert(`Approved as project "${name}". Generate below (same pipeline as the workspace), or open it from Projects for the full workspace.`, { title: "Story approved", tone: "success" });
      if (onOpenProject) onOpenProject(name);
    } catch (e) { fail(e); }
    finally { setBusy(null); setBusySince(null); }
  };

  // Dialogue timeline (§18): per-scene cue sheet in story order, including
  // shot-level lines (multi-shot scenes carry dialogue on shots). Estimates
  // until voice audio exists — the pipeline re-times from real wav lengths.
  const timeline = useMemo(() => {
    if (!board) return [];
    let t = 0;
    const rows: { scene: number; title: string; speaker: string; line: string; emotion: string; expression: string; start: number; end: number; listeners: string[]; shot?: string }[] = [];
    const pushLine = (scene: number, title: string, cast: string[], d: { speaker?: unknown; line?: unknown; emotion?: unknown; expression?: unknown }, shot?: string) => {
      const line = str(d.line).trim();
      if (!line) return;
      const dur = estLineSeconds(line);
      const speaker = str(d.speaker).trim() || "—";
      rows.push({
        scene, title, speaker, line,
        emotion: str(d.emotion), expression: str(d.expression),
        start: Math.round(t * 10) / 10, end: Math.round((t + dur) * 10) / 10,
        listeners: cast.filter((c) => c.toLowerCase() !== speaker.toLowerCase()),
        ...(shot ? { shot } : {}),
      });
      t += dur;
    };
    for (const s of board.scenes) {
      const cast = (s.characters ?? []).map((c) => str(c));
      for (const d of s.dialogue ?? []) pushLine(s.scene_number, str(s.title), cast, d);
      for (const sh of s.shots ?? []) {
        for (const d of (sh as { dialogue?: Array<{ speaker?: unknown; line?: unknown; emotion?: unknown; expression?: unknown }> }).dialogue ?? []) {
          pushLine(s.scene_number, str(s.title), cast, d, str(sh.shot_id));
        }
      }
      t += 0.6; // reaction beat between scenes
    }
    return rows;
  }, [board]);

  const plannedSeconds = useMemo(() =>
    Math.round((board?.scenes ?? []).reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0) * 10) / 10,
    [board]);
  const qaErrors = qa?.errors.length ?? 0;
  // Hero step: 0 Write → 1 Analyzed → 2 Planning → 3 Ready to approve → 4 Approved.
  const stepIdx = !board ? 0
    : board.scenarioName ? 4
    : board.scenes.length > 0 && board.scenes.length >= board.sceneCount ? 3
    : board.scenes.length > 0 ? 2 : 1;

  return (
    <div className="page story-page">
      <header className="story-hero">
        <div className="story-hero-top">
          <span className="story-hero-badge">🎬</span>
          <div>
            <h2>Story Studio</h2>
            <p className="story-hero-sub">Story → AI Director → Character → Dialogue → Emotion → Lip-Sync → Video</p>
          </div>
          <span className="story-hero-actions">
            <button className="ghost" onClick={() => { setStory(TEST_STORY); if (!title.trim()) setTitle("Ram, Sita and Shyam — Forest of Whispers"); }} disabled={!!busy} title="Fill the acceptance-test story (Ram / Sita / Shyam)">
              Fill test story
            </button>
            <button className="ghost" onClick={newStory} disabled={!!busy}>+ New Story</button>
          </span>
        </div>
        <div className="story-steps" aria-label="Story pipeline progress">
          {STEPS.map((s, i) => (
            <span key={s} style={{ display: "contents" }}>
              <span className={`story-step${i < stepIdx ? " done" : i === stepIdx ? " now" : ""}`}>
                <span className="story-step-dot">{i < stepIdx ? "✓" : i + 1}</span>
                <span className="story-step-label">{s}</span>
              </span>
              {i < STEPS.length - 1 && <span className={`story-step-link${i < stepIdx ? " done" : ""}`} />}
            </span>
          ))}
        </div>
      </header>
      {error && <div className="story-err" role="alert">{error}</div>}

      {/* Story input (§3): title + raw text only — no technical knobs up front. */}
      <section className="card">
        <div className="card-head"><span className="story-sec-tag">Step 1 ·</span><h2>📝 Story input</h2></div>
        <div className="form-grid">
          <label>Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Ram, Sita and Shyam — Forest of Whispers" maxLength={120} />
          </label>
          <div className="row">
            <label>Language
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <label>Genre
              <select value={genre} onChange={(e) => setGenre(e.target.value)}>
                {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <label>Style
              <select value={visualStyle} onChange={(e) => setVisualStyle(e.target.value)}>
                {STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label>Target (s)
              <input value={targetSeconds} onChange={(e) => setTargetSeconds(e.target.value)} inputMode="numeric" style={{ width: 70 }} />
            </label>
            <label>Scene (s)
              <input value={sceneSeconds} onChange={(e) => setSceneSeconds(e.target.value)} inputMode="numeric" style={{ width: 60 }} />
            </label>
            <label className="check"><input type="checkbox" checked={includeDialogue} onChange={(e) => setIncludeDialogue(e.target.checked)} /> Dialogues (voice + lip-sync)</label>
          </div>
          <label>Story text — paste the whole story, nothing else is needed
            <textarea value={story} onChange={(e) => setStory(e.target.value)} rows={8} placeholder={'Ram and Sita are walking through a peaceful forest. Sita looks worried…\nRam says, "Sita, do not worry…"'} />
          </label>
          <div className="row">
            <button className="primary" onClick={doAnalyze} disabled={!!busy || story.trim().length < 20 || !title.trim()}>
              {busy ? <><Spinner size={14} /> {busy}</> : <><IconSparkles /> Analyze Story</>}
            </button>
            {board && (
              <button className="ghost" onClick={doScenes} disabled={!!busy || board.scenes.length >= board.sceneCount}>
                {busy ? <><Spinner size={14} /> Planning…</> : <><IconFilm /> {board.scenes.length ? `Continue planning (${board.scenes.length}/${board.sceneCount})` : "Generate Scenes"}</>}
              </button>
            )}
            {busy && <button className="ghost" onClick={() => { cancelRef.current = true; }}>Stop</button>}
            {busySince != null && <span className="muted">· {Math.max(0, Math.round((now - busySince) / 1000))}s</span>}
            {progress && <span className="muted">{progress}</span>}
          </div>
          <p className="card-desc">Analyze extracts the character registry + beats (structured screenplay). Generate Scenes plans shots, dialogue ownership, emotions, expressions and visual prompts — duration-driven, resumable.</p>
        </div>
      </section>

      {/* The active board streams below once analyzed — no saved-list here;
          past stories live in the Director view; this page is one story at
          a time (Analyze → Scenes → Validate → Approve → Generate). */}
      {board && (
        <>
          <section className="card">
            <div className="card-head">
              <span className="story-sec-tag">Plan ·</span>
              <h2><IconClapper /> {str(board.input.title)} — {board.scenes.length}/{board.sceneCount} scenes · ⏱ ~{plannedSeconds}s / ~{Math.round(Number(board.input.targetSeconds) || 0)}s</h2>
              <span className="pill">{board.status}</span>
              {board.scenes.length < board.sceneCount && <span className="pill warn" title="Scene planning is incomplete — Continue planning, or approve now for a partial project">partial plan</span>}
              {board.warn && <span className="pill warn" title={board.warn}>⚠️ grounding fixes — see scenes</span>}
              <span className="spacer" />
              <button className="ghost" onClick={runQa}><IconCheck /> Validate Story</button>
              <button className="ghost" onClick={doAutoFix} disabled={!!busy} title="Fill missing emotion/expression, drop unknown refs, renumber scenes">Fix Automatically</button>
              <button className="primary" onClick={doApprove} disabled={!!busy || !board.scenes.length}><IconCheck /> Approve → Project</button>
            </div>
            {qa && (
              <div className={`story-qa${qaErrors ? " bad" : " ok"}`}>
                <div className="story-qa-title">{qaErrors ? `⛔ ${qaErrors} error(s) — fix before approving` : "✅ Story QA passed — ready to approve"}</div>
                {qa.errors.slice(0, 8).map((e, i) => <div key={`e${i}`}>• {e}</div>)}
                {qa.errors.length > 8 && <div>…+{qa.errors.length - 8} more</div>}
                {qa.warnings.slice(0, 5).map((w, i) => <div key={`w${i}`} className="muted">• {w}</div>)}
              </div>
            )}
            <div className="tabs" role="tablist">
              {(["characters", "scenes", "dialogue", "timeline"] as StoryTab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
                  {t === "characters" ? `Characters (${charsOf(board).length})` : t === "scenes" ? `Scenes (${board.scenes.length})` : t === "dialogue" ? "Dialogue" : "Timeline"}
                </button>
              ))}
              <span className="spacer" />
              <label className="check muted"><input type="checkbox" checked={showPrompts} onChange={(e) => setShowPrompts(e.target.checked)} /> prompts</label>
            </div>
          </section>

          {tab === "characters" && (
            <section className="card">
              <div className="card-head"><span className="story-sec-tag">Cast ·</span><h2>👥 Character registry — stable IDs, one canon per character</h2></div>
              <div className="story-chars">
                {charsOf(board).map((c, i) => {
                  const id = charIdOf(c, i);
                  const app = (c.appearance ?? {}) as Record<string, unknown>;
                  const clo = (c.clothing ?? {}) as Record<string, unknown>;
                  const nm = str(c.name);
                  return (
                    <div key={`${id}-${i}`} className="story-char">
                      <div className="story-char-top">
                        <span className="story-avatar" style={{ ["--spk" as string]: spkHue(nm || id) }} aria-hidden>{(nm || id).trim().charAt(0).toUpperCase()}</span>
                        <span>
                          <div className="story-char-name">{nm}</div>
                          <span className="story-char-id">{id}</span>
                        </span>
                        <span className="spacer" />
                        <span className="pill">{str(c.role) || "supporting"}</span>
                      </div>
                      {(str(c.species) || str(c.age)) && <span className="story-char-fact">{[str(c.species), str(c.age)].filter(Boolean).join(" · ")}</span>}
                      {Object.keys(app).length > 0 && <span className="story-char-fact"><b>Looks</b> — {Object.entries(app).map(([k, v]) => `${k}: ${str(v)}`).join("; ").slice(0, 160)}</span>}
                      {Object.keys(clo).length > 0 && <span className="story-char-fact"><b>Wears</b> — {Object.entries(clo).map(([k, v]) => `${k}: ${str(v)}`).join("; ").slice(0, 160)}</span>}
                      {str(c.visual_identity_prompt) && <span className="story-char-canon">{str(c.visual_identity_prompt).slice(0, 180)}{str(c.visual_identity_prompt).length > 180 ? "…" : ""}</span>}
                      {editingChar === i ? (
                        <span>
                          <input value={charName} onChange={(e) => setCharName(e.target.value)} placeholder="Character name" />
                          <textarea value={charIdentity} onChange={(e) => setCharIdentity(e.target.value)} rows={3} placeholder="Canonical visual description (face, body, clothing — reused verbatim in every scene)" />
                          <span className="row">
                            <button className="primary" onClick={saveChar}>Save</button>
                            <button className="ghost" onClick={() => setEditingChar(null)}>Cancel</button>
                          </span>
                        </span>
                      ) : (
                        <span className="row">
                          <button className="ghost" onClick={() => startEditChar(i)}>Edit</button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {board.blueprint && (
                <p className="card-desc">Logline: {str(board.blueprint.logline) || "—"}{board.blueprint.beats?.length ? ` · ${board.blueprint.beats.length} beats` : ""} · Continuity: face / clothing / style locked via consistency rules + verbatim identity prompts pasted into every image prompt.</p>
              )}
            </section>
          )}

          {tab === "scenes" && (
            <section className="card">
              <div className="card-head"><span className="story-sec-tag">Breakdown ·</span><h2>🎞 Scenes — segmentation, shots, continuity</h2><span className="spacer" /><span className="muted">{board.scenes.length} scenes · ⏱ ~{plannedSeconds}s</span></div>
              <div className="story-scenes">
              {board.scenes.map((s: DirectorScene, i: number) => {
                const shots = Array.isArray(s.shots) ? s.shots : [];
                const open = expanded === i;
                const shotTotal = shots.reduce((a, sh) => a + (Number(sh.duration_seconds) || 0), 0);
                return (
                  <div key={`${s.scene_number}-${i}`} className={`story-scene${open ? " open" : ""}`}>
                    <div className="story-scene-rail">
                      <span className="story-scene-num">{s.scene_number}</span>
                      <span className="story-scene-dur">~{Number(s.duration_seconds) || 0}s</span>
                    </div>
                    <div className="story-scene-main">
                      <div className="story-scene-head" onClick={() => setExpanded(open ? null : i)}>
                        <span className="story-scene-title">{str(s.title) || `Scene ${s.scene_number}`}</span>
                        <span className="story-scene-loc">📍 {str(s.location) || "—"}{str(s.time_of_day) ? ` · ${str(s.time_of_day)}` : ""}</span>
                        <span className="story-scene-tools">
                          <button className="ghost" onClick={(e) => { e.stopPropagation(); doRegenScene(i); }} disabled={regenScene != null} title="Regenerate this scene only">{regenScene === i ? <Spinner size={12} /> : <IconRefresh />}</button>
                          <button className="ghost danger" onClick={(e) => { e.stopPropagation(); doDeleteScene(i); }} title="Delete scene"><IconTrash /></button>
                        </span>
                      </div>
                      {open && (
                        <div>
                          {str(s.story_beat) && <div className="story-scene-beat">{str(s.story_beat)}</div>}
                          <div className="story-chips">
                            {str(s.emotion) && <span className="story-chip">🎭 <b>{str(s.emotion)}</b></span>}
                            {str(s.expression) && <span className="story-chip">🙂 {str(s.expression)}</span>}
                            {str(s.body_language) && <span className="story-chip">🧍 {str(s.body_language)}</span>}
                            {(str(s.camera?.shot_type) || str(s.camera?.movement)) && <span className="story-chip">🎬 {str(s.camera?.shot_type)}{str(s.camera?.angle) ? ` · ${str(s.camera?.angle)}` : ""}{str(s.camera?.movement) ? ` · ${str(s.camera?.movement)}` : ""}</span>}
                            {str(s.lighting) && <span className="story-chip">💡 {str(s.lighting)}</span>}
                            {(s.characters ?? []).length > 0 && <span className="story-chip cast">👥 {(s.characters ?? []).map((c) => str(c)).join(" · ")}</span>}
                          </div>
                          {(s.continuity_from_previous_scene || s.transition_to_next_scene) && (
                            <div className="story-scene-beat">🔗 {str(s.continuity_from_previous_scene)}{str(s.continuity_from_previous_scene) && str(s.transition_to_next_scene) ? " → " : ""}{str(s.transition_to_next_scene)}</div>
                          )}
                          {(s.dialogue ?? []).length > 0 && (
                            <div>
                              {editingScene === i ? (
                                <span>
                                  <textarea value={sceneDlgDraft} onChange={(e) => setSceneDlgDraft(e.target.value)} rows={Math.min(8, Math.max(2, sceneDlgDraft.split("\n").length + 1))} placeholder={"Ram: Sita, do not worry.\nSita (gently): I know, Ram."} />
                                  <div className="muted">Emotion/pitch are kept per line ({(s.dialogue ?? []).map((d) => `${str(d.speaker) || "?"}: ${str(d.emotion) || "neutral"}${str(d.pitch) ? `/${str(d.pitch)}` : ""}`).join(" · ") || "—"}). Edit raw emotion in Fix Automatically or re-generate the scene.</div>
                                  <input value={sceneActionDraft} onChange={(e) => setSceneActionDraft(e.target.value)} placeholder="Visible action (not feelings)" />
                                  <span className="row">
                                    <button className="primary" onClick={saveScene}>Save scene</button>
                                    <button className="ghost" onClick={() => setEditingScene(null)}>Cancel</button>
                                  </span>
                                </span>
                              ) : (
                                <span>
                                  <div className="story-dlg">
                                    {(s.dialogue ?? []).map((d, di) => {
                                      const cast = (s.characters ?? []).map((c) => str(c));
                                      const listeners = cast.filter((c) => c.toLowerCase() !== str(d.speaker).toLowerCase());
                                      const reg = charById(board, str(d.speaker));
                                      const nm = str(d.speaker) || "?";
                                      return (
                                        <div key={di} className={`story-line${reg ? "" : " unreg"}`}>
                                          <span className="story-line-avatar" style={{ ["--spk" as string]: spkHue(nm) }} aria-hidden>{nm.trim().charAt(0).toUpperCase()}</span>
                                          <div>
                                            <div className="story-line-head">
                                              <span className="story-line-name">🎙 {nm}</span>
                                              {(str(d.emotion) || str(d.expression)) && <span className="story-line-mood">🎭 {str(d.emotion) || "—"} · 🙂 {str(d.expression) || "—"}</span>}
                                              {!reg && <span className="pill err">unregistered</span>}
                                            </div>
                                            <div className="story-line-text">“{str(d.line)}”</div>
                                            <div className="story-line-foot">
                                              <span className="pill">👄 lip-sync: {nm}</span>
                                              {listeners.length > 0 && <span>👂 reacts: {listeners.join(", ")}</span>}
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  <span className="row"><button className="ghost" onClick={() => startEditScene(i)}>Edit dialogue / action</button></span>
                                </span>
                              )}
                            </div>
                          )}
                          {shots.length > 0 && (
                            <div className="story-shots" title="Shot rail — width ∝ duration">
                              {shots.map((sh, shi) => (
                                <div key={`${str(sh.shot_id)}-${shi}`} className="story-shot" style={{ flex: `${Math.max(Number(sh.duration_seconds) || 0.5, 0.5)} 1 0` }} title={`${str(sh.shot_id)} · ${Number(sh.duration_seconds) || 0}s${str(sh.camera?.shot_type) ? ` · ${str(sh.camera?.shot_type)}` : ""}`}>
                                  <span className="story-shot-id">🎞 {str(sh.shot_id)}</span>
                                  <span className="story-shot-meta">{Number(sh.duration_seconds) || 0}s{str(sh.camera?.shot_type) ? ` · ${str(sh.camera?.shot_type)}` : ""}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {shotTotal > 0 && Math.abs(shotTotal - (Number(s.duration_seconds) || 0)) > 0.01 && (
                            <div className="muted">Shots tile ~{Math.round(shotTotal * 10) / 10}s of ~{Number(s.duration_seconds) || 0}s scene time.</div>
                          )}
                          {showPrompts && (
                            <div className="muted">
                              <div>🖼 {str(s.image_prompt).slice(0, 400)}{str(s.image_prompt).length > 400 ? "…" : ""}</div>
                              <div>🎥 {str(s.video_prompt).slice(0, 300)}{str(s.video_prompt).length > 300 ? "…" : ""}</div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
            </section>
          )}

          {tab === "dialogue" && (
            <section className="card">
              <div className="card-head"><span className="story-sec-tag">Voices ·</span><h2>🎙 Dialogue — one speaker per line, lip-sync follows the speaker</h2><span className="spacer" /><span className="muted">{timeline.length} lines</span></div>
              {timeline.length === 0 && <p className="muted">No dialogue planned{board.input.includeDialogue === false ? " (dialogues OFF — silent film)." : " yet."}</p>}
              {timeline.map((r, i) => (
                <div key={i} className="story-dlg-card">
                  <div className="story-dlg-tag"><strong>Sc {r.scene}</strong>{r.shot ? <span className="pill">🎞 {r.shot}</span> : null}<span>{r.title}</span></div>
                  <div className="story-line">
                    <span className="story-line-avatar" style={{ ["--spk" as string]: spkHue(r.speaker) }} aria-hidden>{r.speaker.trim().charAt(0).toUpperCase()}</span>
                    <div>
                      <div className="story-line-head">
                        <span className="story-line-name">🎙 {r.speaker}</span>
                        <span className="story-line-mood">🎭 {r.emotion || "—"} · 🙂 {r.expression || "—"}</span>
                      </div>
                      <div className="story-line-text">“{r.line}”</div>
                      <div className="story-line-foot">
                        <span className="pill">👄 {r.speaker}</span>
                        {r.listeners.length > 0 && <span>👂 {r.listeners.join(", ")} react{r.listeners.length > 1 ? "" : "s"}</span>}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <p className="card-desc">Only the active speaker is lip-synced; listeners keep reaction faces. Clip lengths grow to the real voice-audio duration at generation time — estimates above are placeholders.</p>
            </section>
          )}

          {tab === "timeline" && (
            <section className="card">
              <div className="card-head"><span className="story-sec-tag">Cues ·</span><h2>⏱ Dialogue timeline — estimated cues</h2></div>
              <div className="story-tl">
                {timeline.map((r, i) => (
                  <div key={i} className="story-tl-row">
                    <span className="story-tl-time">{r.start.toFixed(1)}–{r.end.toFixed(1)}s</span>
                    <span>Sc {r.scene}{r.shot ? `/${r.shot}` : ""} · <strong>{r.speaker}</strong>: {r.line.slice(0, 80)}{r.line.length > 80 ? "…" : ""}</span>
                  </div>
                ))}
              </div>
              {timeline.length > 0 && <div className="muted story-tl-total">Total voiced ≈ {timeline[timeline.length - 1].end.toFixed(1)}s (estimates — replaced by measured TTS lengths during generation).</div>}
            </section>
          )}

          {/* Generation — 100% the existing pipeline, scoped to this story. */}
          <DirectorGeneration projectName={board.scenarioName ?? null} boardScenes={board.scenes} onOpenProject={onOpenProject} imageMode={imageMode} onImageMode={onImageMode} />
        </>
      )}
    </div>
  );
}
