import { useEffect, useRef, useState } from "react";
import type { Beat, Scenario } from "../types";
import type { ScenarioVersionInfo } from "../api";
import { getScenario, listVersions, getVersion, deleteVersion as deleteVersionApi, craftBeat } from "../api";
import { IconCheck, IconEye, IconEyeOff, IconFilm, IconLayers, IconPanel, IconPlus, IconSparkles, IconTrash, Spinner } from "./Icons";
import Collapse from "./Collapse";
import { useDialog } from "./Dialog";
import { sceneColor, sceneGroupsOf, sceneTint, type SceneGroup } from "./sceneGroups";

const slug = (s: string) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Shot label for a scene section. Director-approved beats carry
// scene_number/shot_id/shot_number (one beat per timed shot); legacy or
// manual beats carry none and render as a single-shot scene "N.1" (same
// convention as the Story Board's ShotList).
const shotLabel = (b: Beat, i: number): string => {
  const sn = Number(b.scene_number);
  if (Number.isFinite(sn) && sn > 0) {
    const shotNum = Number(b.shot_number);
    const sid = String(b.shot_id ?? "").trim();
    const letter = Number.isFinite(shotNum) && shotNum > 0
      ? String.fromCharCode(64 + Math.max(1, Math.round(shotNum)))
      : "";
    const id = sid || `${Math.round(sn)}-${letter || "A"}`;
    const num = Number.isFinite(shotNum) && shotNum > 0 ? ` · shot ${Math.round(shotNum)}` : "";
    const st = Number(b.start_time);
    const en = Number(b.end_time);
    const timing = Number.isFinite(st) && Number.isFinite(en) ? ` · ${st}–${en}s` : "";
    return `🎞 S${Math.round(sn)} · ${id}${num}${timing}`;
  }
  return `🎞 Shot ${i + 1}.1`;
};

// Scene grouping + accent colors live in sceneGroups.ts (shared with
// RenderMonitor so the rm-chip outlines match these Scene cards exactly).

// Dialogue text format — one line per dialogue line as `speaker: line`,
// with an optional per-line expression as `speaker (expression): line`
// (same convention as the Story Board / LipSync editors).
const dialogueToText = (d: Beat["dialogue"]): string =>
  (Array.isArray(d) ? d : []).map((x) => {
    const sp = String(x.speaker || "").trim();
    const ln = String(x.line || "").trim();
    const ex = String((x as { expression?: string }).expression || "").trim();
    const head = sp && ex ? `${sp} (${ex})` : sp;
    return head ? `${head}: ${ln}` : ln;
  }).filter(Boolean).join("\n");
const textToDialogue = (t: string): NonNullable<Beat["dialogue"]> =>
  t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const c = l.indexOf(":");
    if (c <= 0) return { speaker: "", line: l };
    const head = l.slice(0, c).trim();
    const line = l.slice(c + 1).trim();
    const m = head.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    return m
      ? { speaker: m[1].trim(), expression: m[2].trim(), line }
      : { speaker: head, line };
  }).filter((d) => d.speaker || d.line);

// Per-scene dialogue field. Holds the raw text locally and only commits
// the parsed `[{ speaker, line }]` to the parent — so in-progress typing
// (trailing spaces, blank lines, mid-word pauses such as "; " at end of
// line) is never stripped or reformatted under the cursor. External
// changes (version switch, Shot List saves) still resync the text.
function BeatDialogueField({ value, disabled, onChange }: {
  value: Beat["dialogue"];
  disabled?: boolean;
  onChange: (d: NonNullable<Beat["dialogue"]>) => void;
}) {
  const [text, setText] = useState(() => dialogueToText(value));
  const lastExt = useRef(dialogueToText(value));
  useEffect(() => {
    const ext = dialogueToText(value);
    if (ext !== lastExt.current) {
      lastExt.current = ext;
      setText(ext);
    }
  }, [value]);
  return (
    <textarea
      rows={3}
      value={text}
      placeholder={"chiku: नमस्ते! मैं चीकू हूँ।\nshera: कौन है वहाँ?"}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        const parsed = textToDialogue(e.target.value);
        lastExt.current = dialogueToText(parsed);
        onChange(parsed);
      }}
    />
  );
}

interface Props {
  name: string;
  config: Scenario;
  isDraft: boolean;
  onSave: (cfg: Scenario) => Promise<void>;
  // Unsaved field edits owned by the AI Craft + Generate Reference cards
  // (absent key = no edit — cfg applies). Merged into the save payload and
  // the dirty check here, since this editor owns Save. The parent drops the
  // bag once the save lands (and bumps the craft sync epoch so those cards
  // refill from the freshly saved config).
  overrides: Partial<Scenario>;
  onOverridesClear: () => void;
  // Collapsed state lives in the parent (like the Projects panel) so the
  // workspace grid can shrink the right column and let the middle expand.
  // Closed renders only the slim right-docked reopen rail.
  open: boolean;
  onToggle: () => void;
  /** Jump to Scene n in Keyframes → clips (App scrolls + flashes the
      matching gallery card). Absent = no goto icon on the scene headers. */
  onGotoClipScene?: (n: number) => void;
}

// Project save point: version picker + explicit Save. The brief fields
// (description, duration, reference prompt) live in the
// AI Craft + Generate Reference cards — their unsaved edits arrive via
// overrides and are saved here with everything else. Keyframe beats (title,
// keyframe image, motion & camera) live in the Shot List, which edits them
// inline with the same fields. Nothing saves automatically — every explicit
// Save stores ALL fields as a new version in the database.
export default function ScenarioEditor({ name, config, isDraft, onSave, overrides, onOverridesClear, open, onToggle, onGotoClipScene }: Props) {
  const [cfg, setCfg] = useState<Scenario>(config);
  const [pristine, setPristine] = useState<Scenario>(config);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // Effective config = working copy + card overrides. Dirty = actually
  // different from the last saved/loaded state (typing then reverting counts
  // as clean). Save stays disabled while clean.
  const merged: Scenario = { ...cfg, ...overrides };
  const dirty = JSON.stringify(merged) !== JSON.stringify(pristine);
  const [error, setError] = useState("");
  const [versions, setVersions] = useState<ScenarioVersionInfo[]>([]);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  // Per-scene version history: which saved version each scene's pill shows.
  // beatView[i] = null/undefined -> latest (editable); = V -> viewing the
  // snapshot of scene i+1 stored at scenario version V (read-only preview).
  // vCfgCache holds fetched version configs so each old version is loaded once.
  const [beatView, setBeatView] = useState<Record<number, number | null>>({});
  const [vCfgCache, setVCfgCache] = useState<Record<number, Scenario>>({});
  const [beatViewBusy, setBeatViewBusy] = useState<Record<number, boolean>>({});
  // Collapsing only hides the body JSX; edits stay in state.
  // Per-scene show/hide (one toggle per scene section). Collapsing only
  // hides that scene's fields; edits stay in state. Reset on scenario
  // switch so a new project always opens expanded.
  const [hiddenBeats, setHiddenBeats] = useState<Record<number, boolean>>({});
  const toggleBeat = (i: number) =>
    setHiddenBeats((prev) => ({ ...prev, [i]: !prev[i] }));
  // Scene-level collapse (one toggle per Scene card). Shots stay
  // individually expandable via hiddenBeats above.
  const [hiddenScenes, setHiddenScenes] = useState<Record<string, boolean>>({});
  const toggleScene = (key: string) =>
    setHiddenScenes((prev) => ({ ...prev, [key]: !prev[key] }));
  // LLM beat generator (same "Generate beat" tool as the Story Board, but
  // applied to the unsaved working copy here — Save persists the result).
  const [genCount, setGenCount] = useState(1);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState("");
  const dialog = useDialog();

  const loadVersions = async () => {
    try {
      setVersions(await listVersions(name));
    } catch {
      setVersions([]);
    }
  };
  useEffect(() => {
    setVersions([]);
    setViewVersion(null);
    setBeatView({});
    setVCfgCache({});
    setBeatViewBusy({});
    if (!isDraft) void loadVersions();
  }, [isDraft, name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resync when the parent passes a new name/config identity. Internal
  // edits (setCfg) never change the prop identity, so typing is never wiped
  // by this. The parent swaps the config identity when a different scenario
  // finishes loading, when a fresh craft lands (new draft object), and when
  // the Shot List persists beat edits for this scenario. Tell them apart by
  // the non-beat fields: a full reset on scenario switch / fresh craft
  // (this is what makes crafted beats appear here, not just in the Story
  // Board), sequence-only adoption for same-scenario beat saves (preserves
  // in-progress edits to the beats that live in this editor).
  const prevProp = useRef<{ name: string; config: Scenario }>({ name, config });
  useEffect(() => {
    const prev = prevProp.current;
    if (prev.name === name && prev.config === config) return;
    const prevName = prev.name;
    const prevConfig = prev.config;
    prevProp.current = { name, config };
    const rest = (c: Scenario) => {
      const { sequence, ...fields } = c;
      return JSON.stringify(fields);
    };
    if (name !== prevName || rest(config) !== rest(prevConfig)) {
      // Project/draft switch, or a fresh craft (non-beat fields changed):
      // adopt everything so the crafted beats bind here too.
      setCfg(config);
      setPristine(config);
      setSaved(false);
      setError("");
      setViewVersion(null);
      setBeatView({});
      setVCfgCache({});
      setBeatViewBusy({});
      setHiddenBeats({});
      setHiddenScenes({});
      setGenError("");
      return;
    }
    // Sequence-only external change (a Shot List beat save): adopt it —
    // unless the editor holds unsaved beat edits of its own, which win
    // on the next explicit Save instead of being overwritten here.
    const seq = JSON.stringify(config.sequence);
    if (JSON.stringify(cfg.sequence) === JSON.stringify(pristine.sequence)) {
      if (JSON.stringify(cfg.sequence) !== seq) {
        setCfg((cur) => ({ ...cur, sequence: config.sequence }));
        setPristine((cur) => ({ ...cur, sequence: config.sequence }));
      }
    }
  }, [name, config]); // eslint-disable-line react-hooks/exhaustive-deps

  // Explicit save: persists everything as a NEW version of the same project,
  // folding in unsaved card edits (the parent drops its override copy once
  // the save lands).
  const doSave = async (next: Scenario = merged) => {
    setSaving(true);
    setError("");
    try {
      await onSave(next);
      setCfg(next);
      setSaved(true);
      setPristine(next);
      setViewVersion(null);
      setBeatView({});
      // Keep the config cache (old snapshots stay valid); a fresh save only
      // adds a new version — the pills rebuild from the reloaded list below.
      if (!isDraft) await loadVersions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Delete the viewed version (or latest when viewing latest). Deleting the
  // latest rolls the current config back to the previous version; reload it.
  const removeVersion = async () => {
    const target = viewVersion ?? versions[0]?.version;
    if (target == null || delBusy) return;
    const isLatest = target === versions[0]?.version;
    const okDel = await dialog.confirm(
      (dirty ? "Your unsaved edits will be lost. " : "") +
      (isLatest ? "Current config rolls back to the previous version." : "This cannot be undone."),
      {
        title: "Delete v" + target + " of " + name + "?",
        tone: "error",
        okText: "Delete",
        cancelText: "Keep",
      }
    );
    if (!okDel) return;
    setDelBusy(true);
    setError("");
    try {
      await deleteVersionApi(name, target);
      const r = await getScenario(name);
      setCfg(r.config);
      setPristine(r.config);
      onOverridesClear();
      setViewVersion(null);
      setBeatView({});
      setVCfgCache({});
      setBeatViewBusy({});
      setSaved(true);
      await loadVersions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDelBusy(false);
    }
  };

  const switchVersion = async (v: number | null) => {
    if (dirty) {
      const okSwitch = await dialog.confirm("Switch to the selected version without saving?", {
        title: "Discard unsaved edits?",
        tone: "warning",
        okText: "Discard",
        cancelText: "Keep editing",
      });
      if (!okSwitch) return;
    }
    setError("");
    try {
      const r = v === null ? await getScenario(name) : await getVersion(name, v);
      setCfg(r.config);
      setPristine(r.config);
      onOverridesClear();
      setViewVersion(v);
      setBeatView({});
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ---- Per-scene version history -------------------------------------------
  // project_assets + scenario_versions share one version counter (one
  // transaction per Save): v1 snapshots every scene, v2+ stores ONLY the
  // changed scenes as new rows. A scene's history is therefore the subset of
  // global versions whose delta lists that scene — e.g. 10 scenes with only
  // scene 3 edited in v2 gives scene 3 = [v1, v2], every other scene = [v1].
  // The pills below each scene render exactly that list (latest selected);
  // clicking an older pill previews that scene's stored prompts read-only.
  const beatHistory = (beat1: number): number[] => {
    if (!versions.length) return [];
    const asc = [...versions].sort((a, b) => a.version - b.version);
    const out: number[] = [];
    for (const v of asc) {
      if (!v.changes || !Array.isArray(v.changes.beats)) {
        // No delta info (legacy row) — assume the scene was present.
        out.push(v.version);
        continue;
      }
      if (v.changes.beats.includes(beat1)) out.push(v.version);
    }
    return out;
  };
  // Switch scene i (0-based) to view version V (null = back to latest/editable).
  const viewBeatVersion = async (i: number, v: number | null) => {
    if (v === null) {
      setBeatView((prev) => ({ ...prev, [i]: null }));
      return;
    }
    if (vCfgCache[v]) {
      setBeatView((prev) => ({ ...prev, [i]: v }));
      return;
    }
    setBeatViewBusy((prev) => ({ ...prev, [i]: true }));
    setError("");
    try {
      const r = await getVersion(name, v);
      setVCfgCache((prev) => ({ ...prev, [v]: r.config }));
      setBeatView((prev) => ({ ...prev, [i]: v }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBeatViewBusy((prev) => ({ ...prev, [i]: false }));
    }
  };

  // ---- Story beats: the same Shot title / Keyframe image / Motion &
  // camera fields as the Story Board, edited here against the unsaved
  // working copy — nothing persists until Save Scenario stores everything
  // together (dirty tracking picks beat edits up automatically).
  const beats: Beat[] = Array.isArray(cfg.sequence) ? cfg.sequence : [];
  const updateBeat = (i: number, patch: Partial<Beat>) => {
    setCfg((prev) => {
      const seq = Array.isArray(prev.sequence) ? [...prev.sequence] : [];
      if (!seq[i]) return prev;
      seq[i] = { ...seq[i], ...patch };
      return { ...prev, sequence: seq };
    });
    setSaved(false);
  };
  const addBeat = () => {
    // Master Prompt prefill: a manually added scene starts with the stored
    // master in the keyframe box (blank master = empty boxes, as before) —
    // the user then extends it with the scene specifics before Save.
    // Motion is never prefilled.
    const master = String(merged.referencePrompt ?? "").trim();
    setCfg((prev) => {
      const seq = Array.isArray(prev.sequence) ? [...prev.sequence] : [];
      seq.push({ title: `beat${seq.length + 1}`, image: master, motion: "" });
      return { ...prev, sequence: seq };
    });
    setSaved(false);
  };
  const deleteBeat = async (i: number) => {
    const b = beats[i];
    if (!b) return;
    const okBeat = await dialog.confirm(
      "Its prompts are removed on the next Save (generated files are kept).",
      {
        title: "Delete Shot " + (i + 1) + " (" + (b.title || "untitled") + ")?",
        tone: "error",
        okText: "Delete",
        cancelText: "Keep",
      }
    );
    if (!okBeat) return;
    setCfg((prev) => ({ ...prev, sequence: (prev.sequence || []).filter((_, k) => k !== i) }));
    setSaved(false);
  };
  // Append a new shot to an existing numbered Scene (same scene_number, next
  // shot_number/shot_id, inserted right after the scene's last shot).
  const addShotToScene = (sceneNumber: number, indices: number[]) => {
    if (!Number.isFinite(sceneNumber) || sceneNumber <= 0 || saving) return;
    const sn = Math.round(sceneNumber);
    const master = String(merged.referencePrompt ?? "").trim();
    setCfg((prev) => {
      const seq = Array.isArray(prev.sequence) ? [...prev.sequence] : [];
      const inScene = indices
        .map((i) => seq[i])
        .filter(Boolean);
      const maxShot = inScene.reduce((a, b) => {
        const n = Number(b.shot_number);
        return Number.isFinite(n) && n > a ? Math.round(n) : a;
      }, inScene.length);
      const nextShot = maxShot + 1;
      const letter = String.fromCharCode(64 + Math.max(1, nextShot));
      const first = inScene[0] ?? {};
      const stem = String(first.title ?? `scene${sn}`).replace(/_[a-z]$/i, "") || `scene${sn}`;
      const at = Math.max(...indices) + 1;
      const shot: Beat = {
        title: `${slug(stem) || `scene${sn}`}_${letter.toLowerCase()}`,
        image: String(first.image ?? master ?? ""),
        motion: "",
        duration: Number(first.duration) > 0 ? Number(first.duration) : undefined,
        scene_number: sn,
        shot_id: `${sn}-${letter}`,
        shot_number: nextShot,
        dialogue: [],
      };
      seq.splice(Math.min(at, seq.length), 0, shot);
      return { ...prev, sequence: seq };
    });
    setSaved(false);
  };
  const deleteScene = async (label: string, indices: number[]) => {
    if (!indices.length) return;
    const ok = await dialog.confirm(
      `Removes ${indices.length} shot${indices.length === 1 ? "" : "s"} on the next Save (generated files are kept).`,
      { title: `Delete ${label}?`, tone: "error", okText: "Delete", cancelText: "Keep" }
    );
    if (!ok) return;
    const drop = new Set(indices);
    setCfg((prev) => ({ ...prev, sequence: (prev.sequence || []).filter((_, k) => !drop.has(k)) }));
    setSaved(false);
  };
  // LLM proposes the next N beats from the working copy and appends them
  // locally — review them below, then Save Scenario persists everything.
  const generateBeats = async () => {
    if (genBusy || saving) return;
    setGenBusy(true);
    setGenError("");
    try {
      const res = await craftBeat(merged, genCount);
      const fresh = res.beats ?? (res.beat ? [res.beat] : []);
      const used = new Set((merged.sequence || []).map((b) => b.title));
      const next = fresh.map((b, k) => {
        let title = slug(b.title) || `beat${beats.length + k + 1}`;
        if (used.has(title)) title = `${title}_next`;
        used.add(title);
        return { ...b, title };
      });
      if (next.length === 0) {
        setGenError("The LLM returned no beats — try again.");
        return;
      }
      setCfg((prev) => ({ ...prev, sequence: [...(prev.sequence || []), ...next] }));
      setSaved(false);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenBusy(false);
    }
  };

  // Scene groups for display (multi-shot scenes = one Scene card holding
  // all its shots). Flat beat indices are preserved for save/version/goto.
  const groups: SceneGroup[] = sceneGroupsOf(beats);

  if (!open) {
    return (
      <button
        className="sidebar-show rail-right"
        onClick={onToggle}
        title="Show scenario editor"
        aria-label="Show scenario editor"
        aria-expanded={false}
      >
        <IconPanel size={15} />
        <span className="sidebar-show-label">Scenario Editor</span>
      </button>
    );
  }

  return (
    <section className="card" aria-label="Scenario Editor">
      <div className="card-head">
        <h2>
          <span className="head-icon hi-editor"><IconLayers size={15} /></span>
          Scenario Editor
          {isDraft && <span className="pill warn">draft · unsaved</span>}
        </h2>
        <span className="spacer" />
        {!isDraft && versions.length > 0 && (
          <label className="version-pick" title="Every save stores a new version — pick one to view">
            Version
            <select
              value={viewVersion === null ? "latest" : String(viewVersion)}
              onChange={(e) => void switchVersion(e.target.value === "latest" ? null : Number(e.target.value))}
            >
              <option value="latest">Latest{versions[0] ? ` (v${versions[0].version})` : ""}</option>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}{v.changes ? ` — ${[
                    v.changes.refChanged ? "ref" : "",
                    ...v.changes.beats.map((b) => `beat ${b}`),
                  ].filter(Boolean).join(", ") || "no asset change"}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {!isDraft && versions.length > 0 && (
          <button
            className="icon-btn danger"
            title={`Delete ${viewVersion === null ? "latest" : `v${viewVersion}`} (config only — generated outputs are kept)`}
            aria-label="Delete selected version"
            onClick={() => void removeVersion()}
            disabled={delBusy}
          >
            {delBusy ? <Spinner size={13} /> : <IconTrash size={13} />}
          </button>
        )}
        {viewVersion !== null && versions.length > 0 && versions[0] && viewVersion !== versions[0].version && (
          <span className="pill warn">viewing v{viewVersion}</span>
        )}
        <button
          className="primary"
          onClick={() => doSave()}
          disabled={saving || (!isDraft && !dirty)}
          title={isDraft ? "Save everything as v1 of this project" : dirty ? "Save everything as a new version of this project" : "No changes — nothing to save"}
        >
          {saving ? <Spinner size={13} /> : <IconCheck size={13} />}
          {saving ? "Saving…" : "Save Scenario"}
        </button>
        <button
          className="icon-btn"
          onClick={onToggle}
          title="Hide scenario editor"
          aria-label="Hide scenario editor"
          aria-expanded={true}
        >
          <IconPanel size={15} />
        </button>
      </div>
      {cfg.description && <p className="card-desc">{cfg.description}</p>}
      {error && <p className="hint err-text">{error}</p>}
      {saved && !dirty && (
        <p className="hint">{versions[0] ? `Saved as v${versions[0].version} — stored in the database.` : "Saved."}</p>
      )}

      <p className="hint">
        Project fields (description, duration, video type, reference prompt) live in the AI Craft + Generate Reference sections — edit them there; Save stores everything together.
      </p>
      <p className="hint">
        Beats with the same Scene no. group into one Scene card (same accent color) — each shot inside stays individually expandable.
        Story beats carry the same Shot title / Keyframe image / Motion &amp; camera as the Story Board — edit them here, then Save Scenario stores everything together. The Shot List mirrors the same prompts.
      </p>

      <div className="shotlist-detail" aria-label="Story beats">
        <div className="shotlist-detail-title">
          Story beats — {beats.length} shot{beats.length === 1 ? "" : "s"} · {groups.length} scene{groups.length === 1 ? "" : "s"}
        </div>
        {beats.length === 0 && (
          <p className="hint">No beats yet — add the first scene below.</p>
        )}
        {groups.map((g, gi) => {
          const color = sceneColor(g.key, g.sceneNumber, gi);
          const tint = sceneTint(g.key, g.sceneNumber, gi);
          const sceneHidden = !!hiddenScenes[g.key];
          const isMulti = g.indices.length > 1;
          const label = g.sceneNumber != null ? `Scene ${g.sceneNumber}` : `Scene ${g.indices[0] + 1}`;
          const totalDur = g.indices.reduce((a, idx) => {
            const d = Number(beats[idx]?.duration);
            return a + (Number.isFinite(d) && d > 0 ? d : 0);
          }, 0);
          const dlgLines = g.indices.reduce((a, idx) => {
            const d = beats[idx]?.dialogue;
            return a + (Array.isArray(d) ? d.filter((x) => x && String(x.line || "").trim()).length : 0);
          }, 0);
          return (
          <div key={g.key} className="ed-scene" style={{ border: "1px solid var(--line)", borderLeft: `4px solid ${color}`, borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
            <div className="ed-scene-head" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: tint, borderBottom: sceneHidden ? "none" : "1px solid var(--line)" }}>
              <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: "50%", background: color, flexShrink: 0 }} />
              <span className="beat-title" style={{ fontWeight: 700 }}>
                {label} · {g.indices.length} shot{g.indices.length === 1 ? "" : "s"}
                {totalDur > 0 ? ` · ${totalDur}s` : ""}
                {dlgLines ? ` · 🎙 ${dlgLines}` : ""}
                {!isMulti && beats[g.indices[0]] ? ` · ${beats[g.indices[0]].title || `beat${g.indices[0] + 1}`}` : ""}
              </span>
              <span className="spacer" />
              <button
                className="icon-btn"
                onClick={() => toggleScene(g.key)}
                title={sceneHidden ? `Show ${label}` : `Hide ${label}`}
                aria-label={sceneHidden ? `Show ${label}` : `Hide ${label}`}
                aria-expanded={!sceneHidden}
              >
                {sceneHidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
              </button>
              {onGotoClipScene && (
                <button
                  className="icon-btn"
                  onClick={() => onGotoClipScene(g.indices[0] + 1)}
                  title={`View ${label} in Keyframes → clips`}
                  aria-label={`View ${label} in Keyframes → clips`}
                >
                  <IconFilm size={13} />
                </button>
              )}
              {g.sceneNumber != null && (
                <button
                  className="ghost shotlist-btn"
                  onClick={() => addShotToScene(g.sceneNumber as number, g.indices)}
                  disabled={saving}
                  title={`Append a new shot to ${label} (same scene number, next shot id)`}
                >
                  <IconPlus size={12} />
                  Shot
                </button>
              )}
              <button
                className="icon-btn danger"
                onClick={() => void deleteScene(label, g.indices)}
                disabled={saving}
                title={`Delete ${label} (${g.indices.length} shot${g.indices.length === 1 ? "" : "s"} — prompts only, files kept)`}
                aria-label={`Delete ${label}`}
              >
                <IconTrash size={12} />
              </button>
            </div>
            <Collapse open={!sceneHidden}>
            {g.indices.map((i, k) => {
          const b = beats[i];
          if (!b) return null;
          const hidden = !!hiddenBeats[i];
          // Saved history for this scene (delta-based: only versions that
          // touched this scene). Latest = selected by default (editable).
          const hist = !isDraft && viewVersion === null ? beatHistory(i + 1) : [];
          const latestV = hist.length ? hist[hist.length - 1] : null;
          const selV = beatView[i] ?? latestV;
          const viewingOld = selV != null && latestV != null && selV !== latestV;
          const oldBeat: Beat | null = viewingOld && selV != null
            ? (Array.isArray(vCfgCache[selV]?.sequence) ? (vCfgCache[selV].sequence as Beat[])[i] ?? null : null)
            : null;
          const busyOld = !!beatViewBusy[i];
          return (
          <div key={i} id={`beat-${i + 1}`} className={`beat${hidden ? " is-collapsed" : ""}`} style={{ borderLeft: `3px solid ${color}`, margin: 0, borderRadius: 0, borderTop: k > 0 ? "1px solid var(--line)" : "none" }}>
            <div className="beat-head">
              <span className="beat-index" style={{ background: color, borderColor: color }} title={`Flat beat ${i + 1} of ${beats.length}`}>{i + 1}</span>
              <span className="beat-title">
                Shot {k + 1}/{g.indices.length} · {b.title || `beat${i + 1}`}
                {Number.isFinite(Number(b.duration)) && Number(b.duration) > 0 ? ` · ${Number(b.duration)}s` : ""}
                {Array.isArray(b.dialogue) && b.dialogue.some((d) => d && String(d.line || "").trim()) ? ` · 🎙 ${b.dialogue.filter((d) => d && String(d.line || "").trim()).length}` : ""}
                {" · "}
                <span title={b.scene_number != null ? `Scene ${b.scene_number}, shot ${b.shot_id ?? b.shot_number ?? "1"} — one beat per timed shot (Director multi-shot scenes flatten this way)` : "Single-shot scene (one beat = one shot)"}>
                  {shotLabel(b, i)}
                </span>
              </span>
              <span className="spacer" />
              <button
                className="icon-btn"
                onClick={() => toggleBeat(i)}
                title={hidden ? `Expand shot ${k + 1} of ${label}` : `Collapse shot ${k + 1} of ${label}`}
                aria-label={hidden ? `Expand shot ${k + 1} of ${label}` : `Collapse shot ${k + 1} of ${label}`}
                aria-expanded={!hidden}
              >
                {hidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
              </button>
              {onGotoClipScene && (
                <button
                  className="icon-btn"
                  onClick={() => onGotoClipScene(i + 1)}
                  title={`View shot ${k + 1} of ${label} in Keyframes → clips`}
                  aria-label={`View shot ${k + 1} of ${label} in Keyframes → clips`}
                >
                  <IconFilm size={13} />
                </button>
              )}
              <button
                className="ghost shotlist-btn"
                onClick={() => deleteBeat(i)}
                disabled={saving}
                title={`Delete shot ${k + 1} of ${label} (prompts only — generated files are kept)`}
              >
                <IconTrash size={12} />
                Delete
              </button>
            </div>
            <Collapse open={!hidden}>
            <label>Shot title</label>
            <input
              value={b.title}
              placeholder="title (file-safe)"
              disabled={saving}
              onChange={(e) => updateBeat(i, { title: e.target.value })}
            />
            <p className="beat-meta">{slug(b.title) || "untitled"}</p>
            <div className="grid grid-3" style={{ marginBottom: 4 }}>
              <div>
                <label title="Director scene this shot belongs to — beats with the same scene number group as one multi-shot scene">Scene no.</label>
                <p className="beat-meta" title={b.scene_number != null ? `Scene ${b.scene_number} (from the Director board)` : "Single-shot scene — no Director scene linkage"}>
                  {b.scene_number != null ? `S${b.scene_number}` : ""}
                </p>
              </div>
              <div>
                <label title="Shot id within the scene (e.g. 3-A) — from the Director board">Shot id</label>
                <p className="beat-meta" title={b.shot_id ? `Shot ${b.shot_id} (from the Director board)` : "No Director shot id"}>
                  {b.shot_id ? String(b.shot_id) : ""}
                </p>
              </div>
              <div>
                <label title="1-based shot position inside its scene (from the Director board)">Shot no.</label>
                <p className="beat-meta" title={b.shot_number != null ? `Shot ${b.shot_number} of its scene (from the Director board)` : "No Director shot number"}>
                  {b.shot_number != null ? String(b.shot_number) : ""}
                </p>
              </div>
            </div>
            <label>Keyframe image — Flux</label>
            <textarea
              rows={2}
              value={b.image}
              placeholder="Static keyframe prompt for Flux…"
              disabled={saving}
              onChange={(e) => updateBeat(i, { image: e.target.value })}
            />
            <label>Motion &amp; camera — i2v</label>
            <textarea
              rows={2}
              value={b.motion}
              placeholder="Motion + camera direction for image-to-video…"
              disabled={saving}
              onChange={(e) => updateBeat(i, { motion: e.target.value })}
            />
            <label title="One per line as speaker: line — voiced per character (Hindi TTS) and lip-synced">Dialogue (speaker: line per line — voiced + lip-synced)</label>
            <BeatDialogueField
              value={b.dialogue}
              disabled={saving}
              onChange={(d) => updateBeat(i, { dialogue: d })}
            />
            </Collapse>
            {(
              <div className="beat-versions beat-versions-mini" aria-label={`Shot ${k + 1} of ${label} versions and length`}>
                <div className="beat-versions-pills" style={{ alignItems: "center" }}>
                  {hist.map((v) => {
                    const on = selV === v;
                    const isLatest = v === latestV;
                    return (
                      <button
                        key={v}
                        className={`v-pill${on ? " on" : ""}${isLatest ? " latest" : ""}`}
                        disabled={busyOld}
                        onClick={() => void viewBeatVersion(i, isLatest ? null : v)}
                        title={isLatest ? `Scene ${i + 1} latest (V${v}) — editable` : `View Scene ${i + 1} at V${v} (read-only)`}
                        aria-pressed={on}
                        aria-label={`Scene ${i + 1} version ${v}${isLatest ? " (latest)" : ""}`}
                      >
                        {`V${v}`}
                      </button>
                    );
                  })}
                  {busyOld && <span className="hint inline"><Spinner size={11} /></span>}
                  <span className="spacer" />
                  <span title="Clip length(sec) — dialogue shots grow to fit the voice automatically; empty = project default" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={b.duration ?? ""}
                      placeholder="—"
                      disabled={saving}
                      aria-label="Clip length(sec)"
                      style={{ maxWidth: 64, padding: "6px 8px", fontSize: 12 }}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        updateBeat(i, { duration: e.target.value === "" || !Number.isFinite(v) ? undefined : Math.min(30, Math.max(1, Math.round(v))) });
                      }}
                    />
                    <span className="muted">s</span>
                  </span>
                </div>
                {viewingOld && (
                  <div className="beat-versions-view">
                    <p className="hint">
                      Viewing Scene {i + 1} at v{selV} (read-only) — latest is v{latestV}. Click v{latestV} above to return.
                    </p>
                    {oldBeat ? (
                      <>
                        <label>Shot title — v{selV}</label>
                        <p className="beat-versions-text">{oldBeat.title || "—"}</p>
                        <label>Scene / shot — v{selV}</label>
                        <p className="beat-versions-text">{shotLabel(oldBeat, i)}</p>
                        <label>Keyframe image — v{selV}</label>
                        <p className="beat-versions-text">{oldBeat.image || "—"}</p>
                        <label>Motion &amp; camera — v{selV}</label>
                        <p className="beat-versions-text">{oldBeat.motion || "—"}</p>
                        <label>Clip length — v{selV}</label>
                        <p className="beat-versions-text">{Number.isFinite(Number(oldBeat.duration)) && Number(oldBeat.duration) > 0 ? `${Number(oldBeat.duration)}s` : "project default"}</p>
                        <label>Dialogue — v{selV}</label>
                        <p className="beat-versions-text">{Array.isArray(oldBeat.dialogue) && oldBeat.dialogue.length ? oldBeat.dialogue.map((d) => {
                          const sp = String(d.speaker || "").trim();
                          const ln = String(d.line || "").trim();
                          return sp ? `${sp}: ${ln}` : ln;
                        }).filter(Boolean).join("\n") || "—" : "—"}</p>
                      </>
                    ) : (
                      <p className="hint">Scene {i + 1} did not exist at v{selV} (added later).</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          );
            })}
            </Collapse>
          </div>
          );
        })}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn-green" onClick={addBeat} disabled={saving || genBusy} title="Append a scene — fill in its prompts, then Save Scenario">
            <IconPlus size={13} />
            Add beat
          </button>
          <button
            className="btn-purple"
            onClick={() => void generateBeats()}
            disabled={saving || genBusy}
            title="LLM proposes the next beat(s) from the scenario + existing scenes (appends below — Save persists them)"
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
              disabled={saving || genBusy}
              onChange={(e) => setGenCount(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
        </div>
        {genError && <p className="hint err-text">{genError}</p>}
        <p className="hint">
          Generate beat asks the LLM for the next story beat(s) — they append below as unsaved edits; press Save Scenario to persist them.
        </p>
      </div>
    </section>
  );
}
