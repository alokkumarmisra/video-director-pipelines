import { useEffect, useState, type ReactNode } from "react";
import type { Scenario } from "../types";
import type { ScenarioVersionInfo } from "../api";
import { getScenario, listVersions, getVersion, deleteVersion as deleteVersionApi } from "../api";
import { IconCheck, IconLayers, IconPanel, IconSparkles, IconTrash, Spinner } from "./Icons";

interface Props {
  name: string;
  config: Scenario;
  isDraft: boolean;
  onSave: (cfg: Scenario) => Promise<void>;
  // Batch-generate reference images from the reference prompt (needs a saved
  // scenario — generation reads prompts/<name>.json). Disabled while a run is
  // active (the ComfyUI queue is serial).
  onGenerateRef: (count: number) => void;
  refBusy?: boolean;
  // True while a reference-only regen run for THIS scenario is active.
  // refBusy disables the button during any run (queue is serial);
  // refGenerating spins it — other runs must not light up this button.
  refGenerating?: boolean;
  // Reference gallery rendered just below the Generate Reference button.
  referenceSlot?: ReactNode;
}

// Editable prompt JSON: reference prompt and clip duration. Keyframe beats
// (title, keyframe image, motion & camera) live in the Shot List, which edits
// them inline with the same fields. Nothing saves automatically — every
// explicit Save stores ALL fields as a new version in the database.
export default function ScenarioEditor({ name, config, isDraft, onSave, onGenerateRef, refBusy, refGenerating, referenceSlot }: Props) {
  const [cfg, setCfg] = useState<Scenario>(config);
  const [pristine, setPristine] = useState<Scenario>(config);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // Dirty = actually different from the last saved/loaded state (typing then
  // reverting counts as clean). Save stays disabled while clean.
  const dirty = JSON.stringify(cfg) !== JSON.stringify(pristine);
  const [error, setError] = useState("");
  const [versions, setVersions] = useState<ScenarioVersionInfo[]>([]);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  // Hide/show toggle (same as the Projects panel — persisted). Collapsing
  // only hides the body JSX; edits stay in state.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-editor") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-editor", c ? "open" : "closed");
      return !c;
    });
  const [refCount, setRefCount] = useState(3);

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

  // Resync when a different workflow is picked from the dropdown (parent
  // passes a new name/config). Internal edits (set) don't change
  // the prop identity, so typing is never wiped by this.
  useEffect(() => {
    setCfg(config);
    setPristine(config);
    setSaved(false);
    setError("");
    setViewVersion(null);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  // The parent swaps the config identity when a different scenario finishes
  // loading, and when the Shot List persists beat edits for this scenario.
  // Tell them apart by the non-beat fields: a full reset on scenario switch,
  // sequence-only adoption for same-scenario beat saves (preserves
  // in-progress edits to the fields that live in this editor).
  const [lastSeen, setLastSeen] = useState(config);
  if (config !== lastSeen) {
    setLastSeen(config);
    const rest = (c: Scenario) => {
      const { sequence, ...fields } = c;
      return JSON.stringify(fields);
    };
    if (rest(config) === rest(pristine)) {
      const seq = JSON.stringify(config.sequence);
      setCfg((prev) => (JSON.stringify(prev.sequence) === seq ? prev : { ...prev, sequence: config.sequence }));
      setPristine((prev) => (JSON.stringify(prev.sequence) === seq ? prev : { ...prev, sequence: config.sequence }));
    } else {
      setCfg(config);
      setPristine(config);
      setSaved(false);
      setError("");
      setViewVersion(null);
    }
  }

  const set = (patch: Partial<Scenario>) => {
    setCfg({ ...cfg, ...patch });
    setSaved(false);
  };

  // Explicit save: persists everything as a NEW version of the same project.
  const doSave = async (next: Scenario = cfg) => {
    setSaving(true);
    setError("");
    try {
      await onSave(next);
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
      setViewVersion(v);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className={`card${collapsed ? " collapsed" : ""}`} aria-label="Scenario Editor">
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
          onClick={toggleCollapsed}
          title={collapsed ? "Show scenario editor" : "Hide scenario editor"}
          aria-label={collapsed ? "Show scenario editor" : "Hide scenario editor"}
          aria-expanded={!collapsed}
        >
          <IconPanel size={15} />
        </button>
      </div>
      {!collapsed && (
      <>
      {cfg.description && <p className="card-desc">{cfg.description}</p>}
      {error && <p className="hint err-text">{error}</p>}
      {saved && !dirty && (
        <p className="hint">{versions[0] ? `Saved as v${versions[0].version} — stored in the database.` : "Saved."}</p>
      )}

      {(cfg.topic !== undefined || cfg.requirements !== undefined) && (
        <>
          <label>Craft topic</label>
          <input
            value={cfg.topic || ""}
            placeholder="high-level topic this scenario was crafted from"
            onChange={(e) => set({ topic: e.target.value })}
          />
          <label>Craft requirements — style, mood, beats</label>
          <textarea
            rows={2}
            value={cfg.requirements || ""}
            placeholder="requirements this scenario was crafted from"
            onChange={(e) => set({ requirements: e.target.value })}
          />
        </>
      )}

      <label>Reference prompt — Flux t2i key visual</label>
      <textarea
        rows={3}
        value={cfg.referencePrompt}
        onChange={(e) => set({ referencePrompt: e.target.value })}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="ghost"
          onClick={() => onGenerateRef(refCount)}
          disabled={refBusy || saving || isDraft}
          title={isDraft
            ? "Save scenario first — generation reads the saved prompt"
            : `Generate ${refCount} reference image(s) from the prompt above (each becomes a new version)`}
        >
          {refGenerating ? <Spinner size={13} /> : <IconSparkles size={13} />}
          {refGenerating ? "Generating…" : "Generate Reference"}
        </button>
        <label className="gen-count" title="How many reference images to generate (1–8)">
          ×
          <input
            type="number"
            min={1}
            max={8}
            value={refCount}
            disabled={refBusy}
            onChange={(e) => setRefCount(Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
          />
        </label>
      </div>
      {isDraft ? (
        <p className="hint">Save the scenario first — reference generation runs from the saved prompt.</p>
      ) : (
        <p className="hint">Each image becomes a new reference version — pick the best one below.</p>
      )}
      {referenceSlot}
      <label>Clip duration (s)</label>
      <input
        type="number"
        min={1}
        max={10}
        value={cfg.duration}
        style={{ maxWidth: 140 }}
        onChange={(e) => set({ duration: Number(e.target.value) })}
      />
      <p className="hint">
        Shots live in the Shot List — edit, add, generate or delete them there with the same prompts.
      </p>
      </>
      )}
    </section>
  );
}
