import { useEffect, useRef, useState } from "react";
import type { Beat, Scenario } from "../types";
import type { ScenarioVersionInfo } from "../api";
import { getScenario, listVersions, getVersion, deleteVersion as deleteVersionApi, craftBeat } from "../api";
import { IconCheck, IconEye, IconEyeOff, IconLayers, IconPanel, IconPlus, IconSparkles, IconTrash, Spinner } from "./Icons";

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

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
}

// Project save point: version picker + explicit Save. The brief fields
// (description, duration, reference prompt) live in the
// AI Craft + Generate Reference cards — their unsaved edits arrive via
// overrides and are saved here with everything else. Keyframe beats (title,
// keyframe image, motion & camera) live in the Shot List, which edits them
// inline with the same fields. Nothing saves automatically — every explicit
// Save stores ALL fields as a new version in the database.
export default function ScenarioEditor({ name, config, isDraft, onSave, overrides, onOverridesClear, open, onToggle }: Props) {
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
  // Collapsing only hides the body JSX; edits stay in state.
  // Per-scene show/hide (one toggle per scene section). Collapsing only
  // hides that scene's fields; edits stay in state. Reset on scenario
  // switch so a new project always opens expanded.
  const [hiddenBeats, setHiddenBeats] = useState<Record<number, boolean>>({});
  const toggleBeat = (i: number) =>
    setHiddenBeats((prev) => ({ ...prev, [i]: !prev[i] }));
  // LLM beat generator (same "Generate beat" tool as the Story Board, but
  // applied to the unsaved working copy here — Save persists the result).
  const [genCount, setGenCount] = useState(1);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState("");

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
      setHiddenBeats({});
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
    if (!window.confirm(
      `Delete v${target} of "${name}"?` +
      (dirty ? " Your unsaved edits will be lost." : "") +
      (isLatest ? " Current config rolls back to the previous version." : "")
    )) return;
    setDelBusy(true);
    setError("");
    try {
      await deleteVersionApi(name, target);
      const r = await getScenario(name);
      setCfg(r.config);
      setPristine(r.config);
      onOverridesClear();
      setViewVersion(null);
      setSaved(true);
      await loadVersions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDelBusy(false);
    }
  };

  const switchVersion = async (v: number | null) => {
    if (dirty && !window.confirm("Discard unsaved edits and switch version?")) return;
    setError("");
    try {
      const r = v === null ? await getScenario(name) : await getVersion(name, v);
      setCfg(r.config);
      setPristine(r.config);
      onOverridesClear();
      setViewVersion(v);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
  const deleteBeat = (i: number) => {
    const b = beats[i];
    if (!b) return;
    if (
      !window.confirm(
        `Delete Scene ${i + 1} (${b.title || "untitled"})? Its prompts are removed on the next Save (generated files are kept).`
      )
    )
      return;
    setCfg((prev) => ({ ...prev, sequence: (prev.sequence || []).filter((_, k) => k !== i) }));
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
        Story beats below carry the same Shot title / Keyframe image / Motion &amp; camera as the Story Board — edit them here, then Save Scenario stores everything together. The Shot List mirrors the same prompts.
      </p>

      <div className="shotlist-detail" aria-label="Story beats">
        <div className="shotlist-detail-title">
          Story beats — {beats.length} scene{beats.length === 1 ? "" : "s"}
        </div>
        {beats.length === 0 && (
          <p className="hint">No beats yet — add the first scene below.</p>
        )}
        {beats.map((b, i) => {
          const hidden = !!hiddenBeats[i];
          return (
          <div key={i} className={`beat${i % 2 === 1 ? " alt" : ""}${hidden ? " is-collapsed" : ""}`}>
            <div className="beat-head">
              <span className="beat-index">{i + 1}</span>
              <span className="beat-title">
                Scene {i + 1} · {b.title || `beat${i + 1}`}
              </span>
              <span className="spacer" />
              <button
                className="icon-btn"
                onClick={() => toggleBeat(i)}
                title={hidden ? `Show Scene ${i + 1}` : `Hide Scene ${i + 1}`}
                aria-label={hidden ? `Show Scene ${i + 1}` : `Hide Scene ${i + 1}`}
                aria-expanded={!hidden}
              >
                {hidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
              </button>
              <button
                className="ghost shotlist-btn"
                onClick={() => deleteBeat(i)}
                disabled={saving}
                title={`Delete Scene ${i + 1} (prompts only — generated files are kept)`}
              >
                <IconTrash size={12} />
                Delete
              </button>
            </div>
            {!hidden && (
            <>
            <label>Shot title</label>
            <input
              value={b.title}
              placeholder="title (file-safe)"
              disabled={saving}
              onChange={(e) => updateBeat(i, { title: e.target.value })}
            />
            <p className="beat-meta">{slug(b.title) || "untitled"}</p>
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
            </>
            )}
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
