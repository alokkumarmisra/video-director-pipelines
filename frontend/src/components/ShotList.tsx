import { useEffect, useMemo, useRef, useState } from "react";
import {
  craftBeat,
  listOutputs,
  listProjectAssets,
  listVersions,
  outputUrl,
  outScenario,
  isVerticalOut,
  saveScenario,
  type Engine,
  type RunRequest,
  type ScenarioVersionInfo,
  type VideoFormat,
  type VideoType,
} from "../api";
import type {
  AssetKind,
  Beat,
  MainsInfo,
  OutputsInfo,
  ProjectAsset,
  Scenario,
  VersionsInfo,
} from "../types";
import type { GenerationProgress } from "./GenerationProgressBar";
import { formatLiveElapsed } from "./GenerationProgressBar";
import Lightbox, { type PreviewItem } from "./Lightbox";
import SmoothImage from "./SmoothImage";
import { useDialog } from "./Dialog";
import { SceneBadge } from "./OutputGallery";
import {
  IconCheck,
  IconClapper,
  IconExpand,
  IconFilm,
  IconImage,
  IconPanel,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconX,
  Spinner,
} from "./Icons";
import Collapse from "./Collapse";

// ---------------------------------------------------------------------------
// Shot type heuristic — derived from the real beat prompts, never hard-coded
// per project. Buckets match the compact badge set in the spec.
// ---------------------------------------------------------------------------
export type ShotType = "Cinematic" | "Lip-sync" | "Establishing" | "Close-up" | "Transition";

function classifyBeat(b: Beat): ShotType {
  if (Array.isArray(b.dialogue) && b.dialogue.some((d) => d && String(d.line || "").trim()))
    return "Lip-sync";
  const t = `${b.title} ${b.image} ${b.motion}`.toLowerCase();
  if (/lip[\s-]?sync|lipsync|dialogue|speaking|talking|audio[\s-]?sync|mouth.*(sync|move)|sync.*(mouth|audio|voice)/.test(t))
    return "Lip-sync";
  if (/establish|wide shot|\bws\b|aerial panorama/.test(t)) return "Establishing";
  if (/close[\s-]?up|\bcu\b|\becu\b|face portrait|over[-\s]?shoulder/.test(t)) return "Close-up";
  if (/transition|\bcut\b|\bfade\b|\bdissolve\b|\bwipe\b|\bmorph\b/.test(t)) return "Transition";
  return "Cinematic";
}

type ShotStatus = "generated" | "generating" | "failed" | "pending";

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Dialogue text format (one `speaker: line` per line) for the inline beat
// editors — same shape the Director scene editor uses.
const dialogueToText = (d: Beat["dialogue"]): string =>
  (Array.isArray(d) ? d : []).map((x) => {
    const sp = String(x.speaker || "").trim();
    const ln = String(x.line || "").trim();
    return sp ? `${sp}: ${ln}` : ln;
  }).filter(Boolean).join("\n");
const textToDialogue = (t: string): { speaker: string; line: string }[] =>
  t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const c = l.indexOf(":");
    return c > 0
      ? { speaker: l.slice(0, c).trim(), line: l.slice(c + 1).trim() }
      : { speaker: "", line: l };
  }).filter((d) => d.line);

interface ShotRow {
  /** 1-based scene (= beat) number. */
  n: number;
  /** "N.1" — SceneNumber.ShotNumber (one shot per beat in this pipeline). */
  shot: string;
  beat: Beat;
  type: ShotType;
  imageFile: string | null;
  clipFile: string | null;
  imageStatus: ShotStatus;
  videoStatus: ShotStatus;
  imageError: string | null;
  videoError: string | null;
}

interface Props {
  /** Display name ("" when nothing selected / unsaved draft) — used for the
      scenario APIs (assets, versions, save). Output dirs come from `folder`. */
  name: string;
  /** Immutable storage folder (outputs/<folder>/) — never changes on rename. */
  folder?: string;
  engine: Engine;
  /** Which cut this board shows: landscape (YouTube main) or vertical
      (Instagram Reel). Drives the output dir, the asset-status query and the
      generating spinners — same scenes, other cut's files. */
  format?: VideoFormat;
  /** Catalog cut for the asset statuses (defaults to YOUTUBE server-side). */
  videoType?: VideoType;
  /** Saved (or draft) scenario config — prompts + duration come from here. */
  config: Scenario | null;
  /** Unsaved card edits (Generate Reference + AI Craft) owned by the parent.
      Folded into every beat save so a Story Board edit never persists a stale
      referencePrompt over the user's newer Generate Reference text. */
  overrides?: Partial<Scenario>;
  refreshKey: number;
  /** Output dir of the currently running generation (null when idle). */
  generatingScenario: string | null;
  /** Cut the active run generates (null = unknown/landscape). Gates the
      generating spinners so a vertical Reel run never lights up this
      (landscape) board. */
  generatingFormat?: VideoFormat | null;
  regenTarget: { kind: AssetKind; index?: number } | null;
  /** Live run progress (RunPanel) — persistent bar + current-shot readout. */
  progress: GenerationProgress;
  /** ComfyUI queue depth (running + pending) for the queue readout. */
  comfyQueue: number;
  onRegen: (kind: AssetKind, index: number | null) => void;
  onStitch?: () => void;
  /** Voice + lip-sync one scene (Story Board per-row 🎙 button). The run
      voices + syncs just that beat's clip without rebuilding the final cut,
      so the clip can be reviewed before merging via Stitch. */
  onDialogue?: (index: number) => void;
  /** True while any run is active (disables regen triggers — queue is serial). */
  runBusy?: boolean;
  /** Run requests waiting behind the active run (App drains them serially).
      Buttons for queued targets read "Queued" and stay enabled; only the
      actively generating button is disabled. */
  runQueue?: RunRequest[];
  /** Draft mode: beats edit the unsaved draft locally (no server calls, no regen). */
  isDraft?: boolean;
  /** Draft mode: receives the updated config after each local beat edit. */
  onDraftChange?: (cfg: Scenario) => void;
  /** Saved mode: receives the updated config after each persisted beat edit. */
  onChanged?: (cfg: Scenario) => void;
}

/** Scene tabs live in a horizontal scroll strip; the trailing All tab reveals every scene. */

const emptyOutputs: OutputsInfo = {
  files: [],
  versions: { ref: [], beats: {} },
  mains: { ref: null, beats: {} },
};

// Central production-control screen: SHOT → PROMPT → IMAGE → VIDEO at a glance.
// Reads only real pipeline state (scenario config, /api/outputs version mains,
// /api/project/:name/assets statuses, live run progress). No mocks.
export default function ShotList({
  name,
  folder,
  engine,
  format,
  videoType,
  config,
  overrides,
  refreshKey,
  generatingScenario,
  generatingFormat,
  regenTarget,
  progress,
  comfyQueue,
  onRegen,
  onStitch,
  onDialogue,
  runBusy,
  runQueue = [],
  isDraft,
  onDraftChange,
  onChanged,
}: Props) {
  const [outputs, setOutputs] = useState<OutputsInfo>(emptyOutputs);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [versions, setVersions] = useState<ScenarioVersionInfo[]>([]);
  const dialog = useDialog();
  const [filter, setFilter] = useState<number | "all">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [loadError, setLoadError] = useState("");
  // Horizontal scene-tab strip: arrow buttons shift the list one tab at a
  // time (left arrow sits before scene 1, right arrow just before All).
  const stripRef = useRef<HTMLDivElement>(null);
  const [nav, setNav] = useState({ left: false, right: false });
  const updateNav = () => {
    const el = stripRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setNav({
      left: el.scrollLeft > 1,
      right: el.scrollLeft < max - 1,
    });
  };
  const stepStrip = (dir: 1 | -1) => {
    const el = stripRef.current;
    if (!el) return;
    const tab = el.querySelector<HTMLElement>(".shotlist-scene");
    const step = (tab ? tab.offsetWidth : 64) + 6; // one tab + gap
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };
  // Hide/show toggle (same as the Projects panel — persisted). Collapsing
  // only hides the body JSX; polling and live progress keep running.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-shots") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-shots", c ? "open" : "closed");
      return !c;
    });

  // Inline beat editing — the same fields the Scenario Editor beat blocks
  // used to carry (title, keyframe image, motion & camera). `editing` is the
  // 1-based shot being edited, or "new" for the appended-shot form.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draftBeat, setDraftBeat] = useState<Beat>({ title: "", image: "", motion: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState("");
  const [genCount, setGenCount] = useState(1);
  // Beat edits stay available until a beat's own image/video starts
  // generating: only the actively-generating beat locks (its prompts are
  // already baked into the running ComfyUI job). Pending beats and beats
  // whose files already finished stay editable, so scenes and camera
  // motion can be changed any time before generation — drafts and saved
  // projects alike, even while another beat generates.
  // Dialogue edit text (one `speaker: line` per line) for the inline form.
  const [dialogueText, setDialogueText] = useState("");
  const mutBusy = saving || genBusy;

  const outDir = (folder || name) ? outScenario(folder || name, engine, format ?? "landscape") : "";
  const seq = useMemo(() => (config && Array.isArray(config.sequence) ? config.sequence : []), [config]);
  const clipDur = Number.isFinite(Number(overrides?.duration ?? config?.duration))
    ? Number(overrides?.duration ?? config?.duration) : 0;
  // Per-scene clip length: the beat's own duration (set by the Director per
  // scene, grown to fit the voice at generation time), else the project
  // default. This is what each clip is actually generated at.
  const beatDur = (b: Beat): number => {
    const d = Number(b.duration);
    if (Number.isFinite(d) && d > 0) return d;
    return clipDur;
  };
  const hasDialogue = (b: Beat): boolean =>
    Array.isArray(b.dialogue) && b.dialogue.some((d) => d && String(d.line || "").trim());
  const dlgCount = (b: Beat): number =>
    Array.isArray(b.dialogue) ? b.dialogue.filter((d) => d && String(d.line || "").trim()).length : 0;

  // Clamp the scene filter when the scenario changes / beats shrink.
  useEffect(() => {
    setFilter("all");
    setExpanded(new Set());
  }, [name, folder, engine, format]);
  useEffect(() => {
    if (filter !== "all" && (filter < 1 || filter > seq.length)) setFilter("all");
  }, [filter, seq.length]);
  // Arrow enable/disable follows the strip's scroll position + content size.
  useEffect(() => {
    updateNav();
    const el = stripRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateNav, { passive: true });
    window.addEventListener("resize", updateNav);
    return () => {
      el.removeEventListener("scroll", updateNav);
      window.removeEventListener("resize", updateNav);
    };
  }, [seq.length]);

  // Drafts have no server state yet (nothing saved to list) — beats edit
  // the draft locally until Save Scenario.
  // Never show another project/engine dir's rows: the moment the viewed dir
  // changes, blank outputs/assets/versions (statuses fall back to pending)
  // until the new listing lands. Same-dir refreshes keep their data.
  const dirKeyRef = useRef<string>("");
  useEffect(() => {
    if (!name || isDraft) {
      setOutputs(emptyOutputs);
      setAssets([]);
      setVersions([]);
      setLoadError("");
      dirKeyRef.current = "";
      return;
    }
    const dirKey = `${name}|${outDir}`;
    if (dirKeyRef.current !== dirKey) {
      dirKeyRef.current = dirKey;
      setOutputs(emptyOutputs);
      setAssets([]);
      setVersions([]);
    }
    let cancelled = false;
    const load = async () => {
      try {
        const [o, a, v] = await Promise.all([
          listOutputs(outDir),
          listProjectAssets(name, undefined, undefined, videoType).catch(() => [] as ProjectAsset[]),
          listVersions(name).catch(() => [] as ScenarioVersionInfo[]),
        ]);
        if (cancelled) return;
        // Shape-guard the payloads: an error object must never land in array
        // state (it crashed assetFor with "assets.filter is not a function").
        setOutputs(o && typeof o === "object" ? o : emptyOutputs);
        setAssets(Array.isArray(a) ? a : []);
        setVersions(Array.isArray(v) ? v : []);
        setLoadError("");
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    // Keep statuses live while a run is active (same 15s cadence as the
    // dashboard poll); a single fetch otherwise.
    if (generatingScenario) {
      const t = setInterval(() => void load(), 15000);
      return () => {
        cancelled = true;
        clearInterval(t);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [name, outDir, refreshKey, generatingScenario, isDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  const versionsInfo: VersionsInfo = outputs.versions ?? { ref: [], beats: {} };
  const mainsInfo: MainsInfo = outputs.mains ?? { ref: null, beats: {} };

  // Exact asset row for (beat, type) from the effective project state.
  const assetFor = (beat: number, type: "KEYFRAME" | "VIDEO"): ProjectAsset | null => {
    const rows = assets.filter((r) => r.beat_index === beat && r.asset_type === type);
    if (!rows.length) return null;
    // Effective query already resolves one row per key; prefer the latest version.
    return rows.reduce((a, b) => (b.version > a.version ? b : a));
  };

  // generatingScenario arrives as the run's display name; this board renders
  // the folder-based outDir, so the display name, the folder and the full
  // dir all match (ltx needs no suffix). The format must match as well — a
  // run only spins the board of the cut it renders into.
  const generatingHere = !!generatingScenario && !!outDir &&
    (generatingScenario === outDir || generatingScenario === name || ( !!folder && generatingScenario === folder)) &&
    (generatingFormat ?? "landscape") === (isVerticalOut(outDir) ? "vertical" : "landscape");

  // Per-button run state: only the actively generating target is disabled —
  // everything else stays clickable and queues behind the running job.
  const targetRunning = (kind: "keyframe" | "clip", n: number) =>
    !!runBusy && generatingHere && !!regenTarget &&
    regenTarget.kind === kind && (regenTarget.index ?? n) === n;
  const targetQueued = (kind: "keyframe" | "clip", n: number) =>
    runQueue.some((q) => !q.stitch && q.regen?.kind === kind && (q.regen?.index ?? n) === n);

  // Estimated % for the single in-flight asset (RunPanel: elapsed vs pace).
  // Null = in flight but no pace yet (indeterminate shimmer) or idle.
  const pctFor = (kind: "image" | "video", n: number): number | null => {
    if (progress.status !== "running" || !generatingHere) return null;
    if (progress.activeKind !== kind || progress.activeScene !== n) return null;
    return progress.activePct;
  };
  // Live elapsed for the in-flight asset (real measured time) — shown as
  // "12s" while no pace exists yet for a ~% estimate.
  const elapsedFor = (kind: "image" | "video", n: number): string | null => {
    if (progress.status !== "running" || !generatingHere) return null;
    if (progress.activeKind !== kind || progress.activeScene !== n) return null;
    return formatLiveElapsed(progress.activeElapsedMs);
  };

  // First asset in pipeline order without a file — where a full run is headed.
  const nextMissing = useMemo((): { kind: "keyframe" | "clip"; index: number } | null => {
    for (let i = 1; i <= seq.length; i++) {
      if (!mainsInfo.beats[String(i)]?.keyframe) return { kind: "keyframe", index: i };
    }
    for (let i = 1; i <= seq.length; i++) {
      if (!mainsInfo.beats[String(i)]?.clip) return { kind: "clip", index: i };
    }
    return null;
  }, [mainsInfo, seq.length]);

  // Live in-flight asset from run progress — wins over the first-missing
  // heuristic below: mains are only re-listed every 15s, so the heuristic
  // freezes the generating row on the first missing scene while the real
  // work has moved on. Skips stream as events, so this advances past
  // resumed scenes to the asset actually rendering.
  const liveTarget: { kind: "keyframe" | "clip"; index: number } | null =
    generatingHere && progress.status === "running" && progress.activeScene != null && progress.activeScene > 0
      ? progress.activeKind === "image"
        ? { kind: "keyframe", index: progress.activeScene }
        : progress.activeKind === "video"
          ? { kind: "clip", index: progress.activeScene }
          : null
      : null;

  const rows: ShotRow[] = useMemo(
    () =>
      seq.map((beat, i) => {
        const n = i + 1;
        const imageFile = mainsInfo.beats[String(n)]?.keyframe ?? null;
        const clipFile = mainsInfo.beats[String(n)]?.clip ?? null;
        const kfRow = assetFor(n, "KEYFRAME");
        const vidRow = assetFor(n, "VIDEO");

        const isTarget = (kind: "keyframe" | "clip") => {
          if (!generatingHere) return false;
          if (regenTarget) {
            return regenTarget.kind === kind && (regenTarget.index ?? n) === n;
          }
          if (liveTarget) {
            return liveTarget.kind === kind && liveTarget.index === n;
          }
          return nextMissing?.kind === kind && nextMissing.index === n;
        };

        let imageStatus: ShotStatus = imageFile ? "generated" : "pending";
        let videoStatus: ShotStatus = clipFile ? "generated" : "pending";
        if (kfRow?.status === "FAILED") imageStatus = "failed";
        else if (kfRow?.status === "PROCESSING" || isTarget("keyframe")) {
          imageStatus = imageFile && kfRow?.status !== "PROCESSING" && !isTarget("keyframe") ? imageStatus : "generating";
          if (!imageFile || isTarget("keyframe")) imageStatus = "generating";
        }
        if (vidRow?.status === "FAILED") videoStatus = "failed";
        else if (vidRow?.status === "PROCESSING" || isTarget("clip")) {
          videoStatus = "generating";
        }
        // A finished file always wins over a stale PROCESSING flag.
        if (imageFile && !isTarget("keyframe") && kfRow?.status !== "PROCESSING") imageStatus = "generated";
        if (clipFile && !isTarget("clip") && vidRow?.status !== "PROCESSING") videoStatus = "generated";
        if (!imageFile && isTarget("keyframe")) imageStatus = "generating";
        if (!clipFile && isTarget("clip")) videoStatus = "generating";

        return {
          n,
          shot: `${n}.1`,
          beat,
          type: classifyBeat(beat),
          imageFile,
          clipFile,
          imageStatus,
          videoStatus,
          imageError: kfRow?.error_message ?? null,
          videoError: vidRow?.error_message ?? null,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seq, mainsInfo, assets, generatingHere, regenTarget, nextMissing, liveTarget?.kind, liveTarget?.index]
  );

  // ---- header / summary numbers (all derived, never hard-coded) ----
  const totalShots = rows.length;
  const shotsDone = rows.filter((r) => r.imageFile && r.clipFile).length;
  const cinematicCount = rows.filter((r) => r.type !== "Lip-sync").length;
  const lipsyncCount = rows.filter((r) => r.type === "Lip-sync").length;
  // Total runtime sums each scene's own clip length (Director per-scene
  // durations land on the beat; otherwise the project default).
  const totalDur = rows.reduce((s, r) => s + beatDur(r.beat), 0);

  const refDone = !!mainsInfo.ref;
  const kfDone = rows.filter((r) => r.imageFile).length;
  const clipDone = rows.filter((r) => r.clipFile).length;
  const totalTasks = 1 + 2 * totalShots;
  const doneTasks = (refDone ? 1 : 0) + kfDone + clipDone;
  const pct = totalTasks > 0 ? Math.min(100, Math.round((doneTasks / totalTasks) * 100)) : 0;

  const latestVersion = versions.length ? Math.max(...versions.map((v) => v.version)) : null;
  const pad = (v: number) => String(v).padStart(2, "0");
  const ofLabel = totalShots > 0 ? `${pad(shotsDone)} OF ${pad(totalShots)}` : "—";

  const visible = filter === "all" ? rows : rows.filter((r) => r.n === filter);

  // Selecting a scene tab reveals that scene's full prompts. All reveals
  // the full data for every scene. Details toggles rows individually.
  const selectScene = (n: number) => {
    setFilter(n);
    setExpanded((prev) => new Set(prev).add(n));
  };
  const selectAll = () => {
    setFilter("all");
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const r of rows) next.add(r.n);
      return next;
    });
  };

  // Persist a beat list: drafts update locally (Save Scenario persists
  // them later), saved scenarios store a new version via the API.
  // Unsaved card edits (overrides) are folded in so this save never writes a
  // stale referencePrompt/description over a newer Generate Reference edit.
  const persistSequence = async (nextSeq: Beat[]): Promise<void> => {
    if (!config) return;
    const next: Scenario = { ...config, ...overrides, sequence: nextSeq };
    if (isDraft) {
      onDraftChange?.(next);
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      await saveScenario(name, next);
      onChanged?.(next);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (n: number) => {
    const b = seq[n - 1];
    if (!b) return;
    setDraftBeat({ ...b });
    setDialogueText(dialogueToText(b.dialogue));
    setSaveError("");
    setEditing(n);
    setExpanded((prev) => new Set(prev).add(n));
  };
  const cancelEdit = () => {
    setEditing(null);
    setSaveError("");
  };
  const updateShot = async () => {
    if (editing === null || !config) return;
    const title =
      draftBeat.title.trim() ||
      (editing === "new" ? `beat${seq.length + 1}` : (seq[editing - 1]?.title ?? `beat${editing}`));
    const dur = Number(draftBeat.duration);
    const next: Beat = {
      ...draftBeat,
      title,
      ...(Number.isFinite(dur) && dur > 0 ? { duration: Math.min(30, Math.max(1, Math.round(dur))) } : { duration: undefined }),
      dialogue: textToDialogue(dialogueText),
    };
    const nextSeq =
      editing === "new" ? [...seq, next] : seq.map((b, i) => (i === editing - 1 ? next : b));
    try {
      await persistSequence(nextSeq);
    } catch {
      return; // saveError already set — keep the form open
    }
    if (editing === "new") {
      const n = seq.length + 1;
      setFilter("all");
      setExpanded((prev) => new Set(prev).add(n));
    }
    setEditing(null);
  };
  const deleteShot = async (n: number) => {
    const b = seq[n - 1];
    if (!b) return;
    const ok = await dialog.confirm(
      "Its prompts are removed from the scenario (generated files are kept).",
      {
        title: "Delete shot " + n + ".1 (" + (b.title || "untitled") + ")?",
        tone: "error",
        okText: "Delete",
        cancelText: "Keep",
      }
    );
    if (!ok) return;
    try {
      await persistSequence(seq.filter((_, i) => i !== n - 1));
    } catch {
      return;
    }
    setEditing(null);
  };
  const addShot = () => {
    // Master Prompt prefill: a manually added shot starts with the stored
    // master in the keyframe box (blank master = empty boxes, as before).
    // Unsaved Generate Reference edits win — the box shows what generation
    // will actually use. Motion is never prefilled.
    const master = String(overrides?.referencePrompt ?? config?.referencePrompt ?? "").trim();
    setDraftBeat({ title: `beat${seq.length + 1}`, image: master, motion: "" });
    setDialogueText("");
    setSaveError("");
    setEditing("new");
    setFilter("all");
  };

  // LLM proposes the next N beats from the scenario JSON, each continuing
  // from the previous one, and appends them — review them with Edit.
  const generateBeats = async () => {
    if (!config || genBusy) return;
    setGenBusy(true);
    setGenError("");
    try {
      const res = await craftBeat({ ...config, ...overrides }, genCount);
      const beats = res.beats ?? (res.beat ? [res.beat] : []); // beat = old server shape
      const used = new Set(seq.map((b) => b.title));
      const next = beats.map((b, k) => {
        let title = slug(b.title) || `beat${seq.length + k + 1}`;
        if (used.has(title)) title = `${title}_next`;
        used.add(title);
        return { ...b, title };
      });
      await persistSequence([...seq, ...next]);
      setFilter("all");
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenBusy(false);
    }
  };

  // Inline edit form — same attributes as the old editor beat blocks.
  // `locked` is true only while this beat's own image/clip is actively
  // generating; every other state (pending, finished, another beat
  // generating) keeps the form editable.
  const renderEditForm = (isNew: boolean, n: number | null, locked = false) => (
    <>
      <label>Shot title</label>
      <input
        value={draftBeat.title}
        placeholder="title (file-safe)"
        disabled={saving}
        onChange={(e) => setDraftBeat({ ...draftBeat, title: e.target.value })}
      />
      <p className="beat-meta">{slug(draftBeat.title) || "untitled"}</p>
      <label>Keyframe image — Flux</label>
      <textarea
        rows={2}
        value={draftBeat.image}
        disabled={saving}
        onChange={(e) => setDraftBeat({ ...draftBeat, image: e.target.value })}
      />
      <label>Motion &amp; camera — i2v</label>
      <textarea
        rows={2}
        value={draftBeat.motion}
        disabled={saving}
        onChange={(e) => setDraftBeat({ ...draftBeat, motion: e.target.value })}
      />
      <label title="Clip length for this scene in seconds — dialogue scenes grow to fit the voice automatically">Clip length (sec) — this scene</label>
      <input
        type="number"
        min={1}
        max={30}
        value={draftBeat.duration ?? ""}
        placeholder={String(clipDur || 3)}
        disabled={saving}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDraftBeat({ ...draftBeat, duration: e.target.value === "" || !Number.isFinite(v) ? undefined : v });
        }}
      />
      <label title="One per line as speaker: line — voiced per character (Hindi TTS) and lip-synced; run per scene with the row 🎙 button">Dialogue (speaker: line per line — voiced + lip-synced)</label>
      <textarea
        rows={3}
        value={dialogueText}
        placeholder={"chiku: नमस्ते! मैं चीकू हूँ।\nshera: कौन है वहाँ?"}
        disabled={saving}
        onChange={(e) => setDialogueText(e.target.value)}
      />
      {saveError && <p className="hint err-text">{saveError}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="primary"
          onClick={() => void updateShot()}
          disabled={saving || locked}
          title={
            locked
              ? "This shot is generating right now — editing unlocks when it finishes"
              : isDraft
                ? "Apply to the unsaved draft (Save Scenario persists it)"
                : "Save prompts as a new scenario version"
          }
        >
          {saving ? <Spinner size={13} /> : <IconCheck size={13} />}
          {saving ? "Updating…" : isNew ? "Add shot" : "Update shot"}
        </button>
        <button className="ghost" onClick={cancelEdit} disabled={saving}>
          <IconX size={13} />
          Cancel
        </button>
        <span className="spacer" />
        {!isNew && n != null && (
          <button
            className="ghost"
            onClick={() => void deleteShot(n)}
            disabled={saving || locked}
            title={locked ? "This shot is generating right now" : `Delete shot ${n}.1 (prompts only — generated files are kept)`}
          >
            <IconTrash size={13} />
            Delete shot
          </button>
        )}
      </div>
    </>
  );

  if (!name) {
    return (
      <section className="card shotlist" aria-label="Story Board">
        <div className="shotlist-head">
          <div>
            <h2 className="shotlist-title">Story Board</h2>

          </div>
        </div>
        <div className="empty">
          <span className="empty-icon">
            <IconClapper size={20} />
          </span>
          <span className="empty-title">No project selected</span>
          <span className="empty-sub">Open a project to see its shot-by-shot production status.</span>
        </div>
      </section>
    );
  }

  return (
    <section className={`card shotlist${collapsed ? " collapsed" : ""}`} aria-label={`Story Board for ${name}`}>
      {preview && <Lightbox item={preview} onClose={() => setPreview(null)} />}

      {/* Header */}
      <div className="shotlist-head">
        <div className="shotlist-head-left">
          <span className="head-icon hi-shots" aria-hidden="true"><IconPlay size={16} /></span>
          <div>
            <h2 className="shotlist-title">Story Board</h2>

          </div>
        </div>
        <div className="shotlist-head-right">
          <span className="shotlist-of" title={`${shotsDone} of ${totalShots} shots fully generated (image + video)`}>
            {ofLabel}
          </span>
          {isVerticalOut(outDir) && (
            <span className="pill" title="Showing the Instagram (9:16) cut — switch Video to YouTube for the main cut">
              9:16 Reel
            </span>
          )}
          {latestVersion != null && (
            <span className="pill" title={`Scenario version v${latestVersion}`}>
              v{latestVersion}
            </span>
          )}
          {isDraft && <span className="pill warn">draft · unsaved</span>}
          <button
            className="icon-btn"
            onClick={toggleCollapsed}
            title={collapsed ? "Show shot list" : "Hide shot list"}
            aria-label={collapsed ? "Show shot list" : "Hide shot list"}
            aria-expanded={!collapsed}
          >
            <IconPanel size={15} />
          </button>
        </div>
      </div>

      <Collapse open={!collapsed}>
      {/* Overall generation progress (real coverage, persistent at the top) */}
      <div className="shotlist-progress" role="status" aria-label={`Overall generation ${pct} percent`}>
        <div className="shotlist-progress-top">
          <span className="shotlist-progress-label">Overall generation</span>
          <span className="shotlist-progress-pct">{pct}%</span>
        </div>
        <div className="progress-bar" aria-hidden="true">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="shotlist-progress-meta">
          <span>
            {doneTasks} / {totalTasks} tasks · {kfDone} images · {clipDone} videos
          </span>
          <span>
            {shotsDone} / {totalShots} shots completed
          </span>
        </div>
      </div>

      {/* Compact summary (real counts) */}
      <div className="shotlist-stats" aria-label="Project summary">
        <div className="shotlist-stat" title={`${totalShots} shots in this project`}>
          <span className="shotlist-stat-value">{totalShots}</span>
          <span className="shotlist-stat-label">Shots</span>
        </div>
        <div className="shotlist-stat" title={`${cinematicCount} cinematic shots`}>
          <span className="shotlist-stat-value">{cinematicCount}</span>
          <span className="shotlist-stat-label">Cinematic</span>
        </div>
        <div className="shotlist-stat" title={`${lipsyncCount} lip-sync shots`}>
          <span className="shotlist-stat-value">{lipsyncCount}</span>
          <span className="shotlist-stat-label">Lip-sync</span>
        </div>
        <div className="shotlist-stat" title={totalDur > 0 ? `Total runtime: ${totalDur.toFixed(1)}s (${(totalDur / 60).toFixed(2)} min) — each scene at its own clip length` : "Clip duration not set"}>
          <span className="shotlist-stat-value">{totalDur > 0 ? `${totalDur.toFixed(1)}s` : "—"}</span>
          <span className="shotlist-stat-label">{totalDur > 0 ? `${(totalDur / 60).toFixed(2)} min total` : "duration"}</span>
        </div>
      </div>

      {/* Scene filter tabs: number-only tabs in a scroll strip with step
          arrows ([<] left of scene 1, [>] just before All) + pinned All */}
      {totalShots > 0 && (
        <div className="shotlist-scenes-wrap">
          <button
            className="shotlist-nav"
            onClick={() => stepStrip(-1)}
            disabled={!nav.left}
            title="Scroll scenes one step to the right"
            aria-label="Scroll scenes one step to the right"
          >
            &lt;
          </button>
          <div className="shotlist-scenes-scroll" ref={stripRef} role="tablist" aria-label="Filter by scene">
            {rows.map((r) => {
              const done = !!(r.imageFile && r.clipFile);
              return (
                <button
                  key={r.n}
                  role="tab"
                  aria-selected={filter === r.n}
                  className={`shotlist-scene${filter === r.n ? " on" : ""}`}
                  onClick={() => (filter === r.n ? selectAll() : selectScene(r.n))}
                  title={`Scene ${r.n} — shot ${r.shot}${done ? " (complete)" : ""}`}
                >
                  <span className={`dot${done ? " ok" : ""}`} aria-hidden="true" />
                  {r.n}
                </button>
              );
            })}
          </div>
          <button
            className="shotlist-nav"
            onClick={() => stepStrip(1)}
            disabled={!nav.right}
            title="Scroll scenes one step to the left"
            aria-label="Scroll scenes one step to the left"
          >
            &gt;
          </button>
          <button
            role="tab"
            aria-selected={filter === "all"}
            className={`shotlist-scene shotlist-scene-all${filter === "all" ? " on" : ""}`}
            onClick={selectAll}
            title={`Show all ${totalShots} scenes`}
          >
            All
          </button>
        </div>
      )}

      {loadError && <p className="hint err-text">{loadError}</p>}

      {/* Shot rows */}
      {totalShots === 0 ? (
        <div className="empty">
          <span className="empty-icon">
            <IconFilm size={20} />
          </span>
          <span className="empty-title">No beats yet</span>
          <span className="empty-sub">Add your first shot with Add shot below — it appears here.</span>
        </div>
      ) : (
        <div className="shotlist-list" role="table" aria-label="Shots">
          <div className="shotlist-row-head" role="row" aria-hidden="true">
            <span className="shotlist-head-cell">Shot</span>
            <span className="shotlist-head-cell">Media</span>
            <span className="shotlist-head-cell">Description</span>
            <span className="shotlist-head-cell">Status</span>
            <span className="shotlist-head-cell">Duration</span>
            <span className="shotlist-head-cell">Action</span>
          </div>
          <div className="shotlist-rows">
            {visible.map((r) => {
              const open = expanded.has(r.n);
              // Local beat-mutation states only — an active run no longer
              // locks every button (it queues instead).
              const localBusy = saving || genBusy;
              const imgRunning = targetRunning("keyframe", r.n);
              const imgQueued = !imgRunning && targetQueued("keyframe", r.n);
              const clipRunning = targetRunning("clip", r.n);
              const clipQueued = !clipRunning && targetQueued("clip", r.n);
              // Only this beat's own active generation locks its Edit —
              // everything else (pending, finished, another beat's run)
              // stays editable so scenes / camera motion can change any
              // time before generation.
              const beatLocked = imgRunning || clipRunning;
              const imgPct = pctFor("image", r.n);
              const clipPct = pctFor("video", r.n);
              const imgElapsed = elapsedFor("image", r.n);
              const clipElapsed = elapsedFor("video", r.n);
              // Tile readout: estimated ~% when pace exists, else live
              // elapsed seconds (real), else plain "Generating".
              const imgReadout = imgPct != null ? `~${Math.round(imgPct)}%` : (imgElapsed ?? "Generating");
              const clipReadout = clipPct != null ? `~${Math.round(clipPct)}%` : (clipElapsed ?? "Generating");
              const imgGenLabel = imgPct != null
                ? `Scene ${r.n} keyframe generating… ~${Math.round(imgPct)}% (estimated)`
                : imgElapsed != null
                  ? `Scene ${r.n} keyframe generating… ${imgElapsed} elapsed`
                  : `Scene ${r.n} keyframe generating…`;
              const clipGenLabel = clipPct != null
                ? `Video ${r.n} generating… ~${Math.round(clipPct)}% (estimated)`
                : clipElapsed != null
                  ? `Video ${r.n} generating… ${clipElapsed} elapsed`
                  : `Video ${r.n} generating…`;
              return (
                <div className="shotlist-row-wrap" key={r.n} role="rowgroup">
                  <div className="shotlist-row" role="row">
                    <span className="shotlist-shot" role="cell" title={`Scene ${r.n}, shot 1`}>
                      {r.shot}
                    </span>
                    <span className="shotlist-media" role="cell">
                      <span className="shotlist-media-item">
                        <span className="shotlist-media-label">Image</span>
                        {r.imageFile ? (
                          <span
                            className={`shotlist-thumb${imgRunning ? " is-generating" : ""}`}
                            role="button"
                            tabIndex={0}
                            title={imgRunning ? imgGenLabel : `Scene ${r.n} keyframe image — click to preview`}
                            onClick={() =>
                              setPreview({ src: outputUrl(outDir, r.imageFile!), kind: "image", alt: `shot ${r.shot} image` })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && r.imageFile)
                                setPreview({ src: outputUrl(outDir, r.imageFile), kind: "image", alt: `shot ${r.shot} image` });
                            }}
                          >
                            <SmoothImage src={outputUrl(outDir, r.imageFile)} alt="" />
                            <span className="shotlist-thumb-tag" title={`Scene ${r.n}`}>S{r.n}</span>
                            <span className="shotlist-thumb-expand" title={`Fullscreen preview of scene ${r.n} image`} aria-hidden="true">
                              <IconExpand size={10} />
                            </span>
                            {imgRunning && (imgPct != null || imgElapsed != null) && (
                              <span className="gen-pct" title={imgGenLabel}>{imgReadout}</span>
                            )}
                            {imgRunning && imgPct != null && (
                              <span className="gen-bar" aria-hidden="true">
                                <span style={{ width: `${Math.min(99, Math.max(0, Math.round(imgPct)))}%` }} />
                              </span>
                            )}
                            {imgRunning && (
                              <span className="shotlist-thumb-gen" title={imgGenLabel}>
                                <Spinner size={11} /> <span className="gen-dots">Generating</span>{(imgPct != null || imgElapsed != null) && <span> {imgReadout}</span>}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span
                            className={`shotlist-thumb shotlist-thumb-empty${r.imageStatus === "generating" ? " is-generating" : ""}`}
                            title={r.imageStatus === "generating" ? imgGenLabel : `Scene ${r.n} — no image yet`}
                          >
                            {r.imageStatus === "generating" ? <Spinner size={13} /> : <IconImage size={14} />}
                            <span className="shotlist-thumb-pending">
                              {r.imageStatus === "generating"
                                ? (<><span className="gen-dots">Generating</span>{(imgPct != null || imgElapsed != null) && <span> {imgReadout}</span>}</>)
                                : "Pending"}
                            </span>
                            {r.imageStatus === "generating" && (imgPct != null || imgElapsed != null) && (
                              <>
                                <span className="gen-pct" title={imgGenLabel}>{imgReadout}</span>
                                {imgPct != null && (
                                <span className="gen-bar" aria-hidden="true">
                                  <span style={{ width: `${Math.min(99, Math.max(0, Math.round(imgPct)))}%` }} />
                                </span>
                                )}
                              </>
                            )}
                            <span className="shotlist-thumb-tag" title={`Scene ${r.n}`}>S{r.n}</span>
                          </span>
                        )}
                      </span>
                      <span className="shotlist-media-item">
                        <span className="shotlist-media-label">Video</span>
                        {r.clipFile ? (
                          <span
                            className={`shotlist-thumb${clipRunning ? " is-generating" : ""}`}
                            role="button"
                            tabIndex={0}
                            title={clipRunning ? clipGenLabel : `Video ${r.n} clip — click to preview`}
                            onClick={() =>
                              setPreview({ src: outputUrl(outDir, r.clipFile!), kind: "video", alt: `shot ${r.shot} video` })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && r.clipFile)
                                setPreview({ src: outputUrl(outDir, r.clipFile), kind: "video", alt: `shot ${r.shot} video` });
                            }}
                          >
                            <video src={outputUrl(outDir, r.clipFile)} preload="metadata" muted playsInline />
                            {clipRunning && <span className="gen-scanline" aria-hidden="true" />}
                            <span className="shotlist-thumb-play" aria-hidden="true">
                              {clipRunning ? <Spinner size={10} /> : <IconPlay size={10} />}
                            </span>
                            <span className="shotlist-thumb-tag" title={`Video ${r.n}`}>V{r.n}</span>
                            <span className="shotlist-thumb-expand" title={`Fullscreen preview of video ${r.n}`} aria-hidden="true">
                              <IconExpand size={10} />
                            </span>
                            {clipRunning && (clipPct != null || clipElapsed != null) && (
                              <span className="gen-pct" title={clipGenLabel}>{clipReadout}</span>
                            )}
                            {clipRunning && clipPct != null && (
                              <span className="gen-bar" aria-hidden="true">
                                <span style={{ width: `${Math.min(99, Math.max(0, Math.round(clipPct)))}%` }} />
                              </span>
                            )}
                            {clipRunning && (
                              <span className="shotlist-thumb-gen" title={clipGenLabel}>
                                <span className="gen-eq" aria-hidden="true"><span /><span /><span /><span /></span>
                                <span className="gen-dots">Generating</span>{(clipPct != null || clipElapsed != null) && <span> {clipReadout}</span>}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span
                            className={`shotlist-thumb shotlist-thumb-empty${r.videoStatus === "generating" ? " is-generating" : ""}`}
                            title={r.videoStatus === "generating" ? clipGenLabel : `Video ${r.n} — no clip yet`}
                          >
                            {r.videoStatus === "generating" ? (
                              <>
                                {r.imageFile && (
                                  <span className="video-gen-preview" aria-hidden="true">
                                    <img src={outputUrl(outDir, r.imageFile)} alt="" />
                                  </span>
                                )}
                                <span className="gen-scanline" aria-hidden="true" />
                                <span className="gen-eq" aria-hidden="true"><span /><span /><span /><span /></span>
                                <span className="shotlist-thumb-pending">
                                  <span className="gen-dots">Generating</span>{(clipPct != null || clipElapsed != null) && <span> {clipReadout}</span>}
                                </span>
                                {(clipPct != null || clipElapsed != null) && (
                                  <>
                                    <span className="gen-pct" title={clipGenLabel}>{clipReadout}</span>
                                    {clipPct != null && (
                                    <span className="gen-bar" aria-hidden="true">
                                      <span style={{ width: `${Math.min(99, Math.max(0, Math.round(clipPct)))}%` }} />
                                    </span>
                                    )}
                                  </>
                                )}
                              </>
                            ) : (
                              <>
                                <IconFilm size={14} />
                                <span className="shotlist-thumb-pending">Pending</span>
                              </>
                            )}
                            <span className="shotlist-thumb-tag" title={`Video ${r.n}`}>V{r.n}</span>
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="shotlist-desc" role="cell">
                      <span className="shotlist-desc-title" title={r.beat.title}>
                        {r.beat.title || <span className="muted">untitled</span>}
                      </span>
                      <span className="shotlist-desc-text" title={r.beat.image || r.beat.title}>
                        {r.beat.image || r.beat.title || <span className="muted">No prompt yet</span>}
                      </span>
                    </span>
                    <span className="shotlist-status" role="cell">
                      <StatusLine label="Image" status={r.imageStatus} title={r.imageError ?? imgGenLabel} pctText={r.imageStatus === "generating" && (imgPct != null || imgElapsed != null) ? imgReadout : null} />
                      <StatusLine label="Video" status={r.videoStatus} title={r.videoError ?? clipGenLabel} pctText={r.videoStatus === "generating" && (clipPct != null || clipElapsed != null) ? clipReadout : null} />
                    </span>
                    <span className="shotlist-dur" role="cell" title={Number.isFinite(Number(r.beat.duration)) && Number(r.beat.duration) > 0 ? `Scene ${r.n} clip length: ${beatDur(r.beat).toFixed(1)}s (per-scene setting)` : `Scene ${r.n} clip length: ${beatDur(r.beat).toFixed(1)}s (project default${hasDialogue(r.beat) ? " — grows to fit the voice" : ""})`}>
                      {beatDur(r.beat) > 0 ? `${beatDur(r.beat).toFixed(1)} s` : "—"}
                    </span>
                    <span className="shotlist-actions" role="cell">
                      <button
                        className="ghost shotlist-btn"
                        disabled={localBusy || beatLocked}
                        title={beatLocked ? `Scene ${r.n} is generating right now` : `Edit prompts for shot ${r.shot}`}
                        onClick={() => (editing === r.n ? cancelEdit() : startEdit(r.n))}
                      >
                        {editing === r.n ? "Close" : "Edit"}
                      </button>
                      {!isDraft &&
                        (!r.imageFile ? (
                          <button
                            className="ghost shotlist-btn"
                            disabled={localBusy}
                            title={imgQueued ? "Queued — starts when the current run finishes" : `Generate image for shot ${r.shot}`}
                            onClick={() => onRegen("keyframe", r.n)}
                          >
                            <IconImage size={11} />
                            {imgQueued ? "Queued" : "Gen image"}
                          </button>
                        ) : (
                          <button
                            className="ghost shotlist-btn"
                            disabled={localBusy || imgRunning}
                            title={imgRunning ? `Regenerating image for shot ${r.shot}…` : imgQueued ? "Queued — starts when the current run finishes" : `Regenerate image for shot ${r.shot} (keeps versions)`}
                            onClick={() => onRegen("keyframe", r.n)}
                          >
                            {imgRunning ? <Spinner size={11} /> : <IconRefresh size={11} />}
                            {imgRunning ? "Working…" : imgQueued ? "Queued" : "Regen img"}
                          </button>
                        ))}
                      {!isDraft &&
                        (!r.clipFile ? (
                          <button
                            className="ghost shotlist-btn"
                            disabled={localBusy || !r.imageFile}
                            title={
                              !r.imageFile
                                ? "Generate the image first — video runs from the keyframe"
                                : clipQueued
                                  ? "Queued — starts when the current run finishes"
                                  : `Generate video for shot ${r.shot}`
                            }
                            onClick={() => onRegen("clip", r.n)}
                          >
                            <IconPlay size={11} />
                            {clipQueued ? "Queued" : "Gen video"}
                          </button>
                        ) : (
                          <button
                            className="ghost shotlist-btn"
                            disabled={localBusy || clipRunning}
                            title={clipRunning ? `Regenerating video for shot ${r.shot}…` : clipQueued ? "Queued — starts when the current run finishes" : `Regenerate video for shot ${r.shot} (keeps versions)`}
                            onClick={() => onRegen("clip", r.n)}
                          >
                            {clipRunning ? <Spinner size={11} /> : <IconRefresh size={11} />}
                            {clipRunning ? "Working…" : clipQueued ? "Queued" : "Regen vid"}
                          </button>
                        ))}
                      {!isDraft && onDialogue && hasDialogue(r.beat) && (
                        <button
                          className="ghost shotlist-btn"
                          disabled={localBusy || beatLocked || !!runBusy}
                          title={beatLocked ? `Scene ${r.n} is generating right now` : runBusy ? "Another run is active — voice & lip-sync when it finishes" : `Voice Scene ${r.n} (${dlgCount(r.beat)} line${dlgCount(r.beat) === 1 ? "" : "s"}) + lip-sync its clip — final cut is NOT rebuilt, review this clip first then Stitch`}
                          onClick={() => onDialogue(r.n)}
                        >
                          <span aria-hidden="true">🎙</span>
                          {`Scene ${r.n} voice`}
                        </button>
                      )}
                    </span>
                  </div>
                  <Collapse open={open}>
                    <div className="shotlist-detail">
                      {editing === r.n ? (
                        <>
                          <div className="shotlist-detail-title">
                            Scene {r.n} · editing {r.beat.title || `beat${r.n}`}
                          </div>
                          {renderEditForm(false, r.n, beatLocked)}
                        </>
                      ) : (
                        <>
                          <div className="shotlist-detail-title" title="Beat title">
                            Scene {r.n} · {r.beat.title || `beat${r.n}`}
                          </div>
                          <div className="shotlist-detail-grid">
                            <div>
                              <div className="shotlist-detail-label">Keyframe prompt — Flux</div>
                              <p>{r.beat.image || <span className="muted">—</span>}</p>
                            </div>
                            <div>
                              <div className="shotlist-detail-label">Motion &amp; camera — i2v</div>
                              <p>{r.beat.motion || <span className="muted">—</span>}</p>
                            </div>
                          </div>
                          <div className="shotlist-detail-grid">
                            <div>
                              <div className="shotlist-detail-label">Clip length — this scene</div>
                              <p>{beatDur(r.beat) > 0 ? `${beatDur(r.beat).toFixed(1)}s${Number.isFinite(Number(r.beat.duration)) && Number(r.beat.duration) > 0 ? " (per-scene)" : " (project default)"}` : "—"}</p>
                            </div>
                            <div>
                              <div className="shotlist-detail-label">Dialogue — voiced + lip-synced</div>
                              {hasDialogue(r.beat) ? (
                                <p>{r.beat.dialogue!.filter((d) => d && String(d.line || "").trim()).map((d, i, arr) => (
                                  <span key={i}>
                                    <b>{d.speaker || "voice"}</b>: {d.line}{i < arr.length - 1 ? <br /> : null}
                                  </span>
                                ))}</p>
                              ) : (
                                <p><span className="muted">— silent scene —</span></p>
                              )}
                            </div>
                          </div>
                          <div className="shotlist-detail-meta">
                            <span className="muted">
                              {r.imageFile ? `img: ${r.imageFile}` : "img: —"}
                              {" · "}
                              {r.clipFile ? `vid: ${r.clipFile}` : "vid: —"}
                            </span>
                            {(r.imageError || r.videoError) && (
                              <span className="err-text">{r.imageError ?? r.videoError}</span>
                            )}
                            <span className="spacer" />
                            <button
                              className="ghost shotlist-btn"
                              disabled={localBusy || beatLocked}
                              title={beatLocked ? `Scene ${r.n} is generating right now` : `Edit prompts for shot ${r.shot}`}
                              onClick={() => startEdit(r.n)}
                            >
                              Edit shot
                            </button>
                        {r.imageFile && (
                          <button
                            className="ghost shotlist-btn"
                            onClick={() =>
                              setPreview({ src: outputUrl(outDir, r.imageFile!), kind: "image", alt: `shot ${r.shot} image` })
                            }
                          >
                            View image
                          </button>
                        )}
                        {r.clipFile && (
                          <button
                            className="ghost shotlist-btn"
                            onClick={() =>
                              setPreview({ src: outputUrl(outDir, r.clipFile!), kind: "video", alt: `shot ${r.shot} video` })
                            }
                          >
                            Play video
                          </button>
                        )}
                      </div>
                        </>
                      )}
                    </div>
                  </Collapse>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Beat tools: add + LLM-generate (moved here from the editor) */}
      <div className="row" style={{ marginTop: 4 }}>
        <button
          className="ghost"
          onClick={addShot}
          disabled={mutBusy}
          title="Append a shot — fill in its prompts, then Add shot"
        >
          <IconPlus size={13} />
          Add shot
        </button>
        <button
          className="ghost"
          onClick={() => void generateBeats()}
          disabled={mutBusy}
          title="LLM proposes the next beat(s) from the scenario + existing shots"
        >
          {genBusy ? <Spinner size={13} /> : <IconSparkles size={13} />}
          {genBusy ? "Generating…" : "Generate beat"}
        </button>
        <label className="gen-count wide" title="How many next beats to generate (1 or more)">
          ×
          <input
            type="number"
            min={1}
            value={genCount}
            disabled={mutBusy}
            onChange={(e) => setGenCount(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
      </div>
      {genError && <p className="hint err-text">{genError}</p>}
      <p className="hint">
        {isDraft
          ? "Shot edits apply to the unsaved draft — press Save Scenario to persist them."
          : "Shot edits save immediately as a new scenario version."}{" "}
        Generate beat asks the LLM for the next story beat(s) from the scenario JSON.
      </p>

      {/* Appended-shot form */}
      {editing === "new" && (
        <div className="shotlist-detail">
          <div className="shotlist-detail-title">New shot · Scene {seq.length + 1}</div>
          {renderEditForm(true, null)}
        </div>
      )}

      {/* Footer: stitch shortcut reuses the existing final-cut run */}
      {!isDraft && totalShots > 0 && onStitch && (
        <div className="shotlist-foot">
          <span className="muted">
            {clipDone}/{totalShots} clips · {refDone ? "ref ready" : "ref pending"}
          </span>
          <span className="spacer" />
          <button className="ghost" disabled={!!runBusy || clipDone === 0} onClick={onStitch} title="Concatenate the main clip versions into the final cut">
            Stitch final
          </button>
        </div>
      )}

      {/* Hidden scene-badge host: keeps the established overlay component in the
          bundle for thumbnail numbering consistency (visual tag is inline). */}
      <span style={{ display: "none" }} aria-hidden="true">
        <SceneBadge scene={1} total={1} />
        <IconCheck size={1} />
      </span>
      </Collapse>
    </section>
  );
}

function StatusLine({ label, status, title, pctText }: { label: "Image" | "Video"; status: ShotStatus; title?: string; pctText?: string | null }) {
  if (status === "generated")
    return (
      <span className="shotlist-st shotlist-st-ok" title={title ?? `${label} generated`}>
        <span className="shotlist-st-tag">{label}</span>
        <span className="shotlist-st-val">✓ Generated</span>
      </span>
    );
  if (status === "generating")
    return (
      <span className="shotlist-st shotlist-st-run" title={title ?? `${label} generating…`}>
        <span className="shotlist-st-tag">{label}</span>
        <span className="shotlist-st-val">
          <span className="dot pulse" aria-hidden="true" /> <span className="gen-dots">Generating</span>{pctText ? <span> {pctText}</span> : null}
        </span>
      </span>
    );
  if (status === "failed")
    return (
      <span className="shotlist-st shotlist-st-err" title={title ?? `${label} failed`}>
        <span className="shotlist-st-tag">{label}</span>
        <span className="shotlist-st-val">⚠ Failed</span>
      </span>
    );
  return (
    <span className="shotlist-st" title={title ?? `${label} pending`}>
      <span className="shotlist-st-tag">{label}</span>
      <span className="shotlist-st-val muted">○ Pending</span>
    </span>
  );
}
