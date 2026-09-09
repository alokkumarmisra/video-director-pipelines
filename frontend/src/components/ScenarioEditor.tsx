import { useEffect, useState, type ReactNode } from "react";
import type { Scenario } from "../types";
import type { ScenarioVersionInfo } from "../api";
import { craftBeat, getScenario, listVersions, getVersion, deleteVersion as deleteVersionApi } from "../api";
import { IconCheck, IconPlus, IconX, IconLayers, IconSparkles, IconTrash, Spinner } from "./Icons";

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

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Editable prompt JSON: reference prompt, duration, and the keyframe beats.
// Nothing saves automatically — every explicit Save stores ALL fields
// (topic, requirements, prompts, camera) as a new version in the database.
export default function ScenarioEditor({ name, config, isDraft, onSave, onGenerateRef, refBusy, refGenerating, referenceSlot }: Props) {
  const [cfg, setCfg] = useState<Scenario>(config);
  const [pristine, setPristine] = useState<Scenario>(config);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // Dirty = actually different from the last saved/loaded state (typing then
  // reverting counts as clean). Save stays disabled while clean.
  const dirty = JSON.stringify(cfg) !== JSON.stringify(pristine);
  const [error, setError] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState("");
  const [genCount, setGenCount] = useState(1);
  const [versions, setVersions] = useState<ScenarioVersionInfo[]>([]);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [delBusy, setDelBusy] = useState(false);
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
  // passes a new name/config). Internal edits (set/setBeat) don't change
  // the prop identity, so typing is never wiped by this.
  useEffect(() => {
    setCfg(config);
    setPristine(config);
    setSaved(false);
    setError("");
    setViewVersion(null);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setCfg(config);
    setPristine(config);
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<Scenario>) => {
    setCfg({ ...cfg, ...patch });
    setSaved(false);
  };
  const setBeat = (i: number, patch: Partial<Scenario["sequence"][number]>) => {
    const sequence = cfg.sequence.map((b, j) => (j === i ? { ...b, ...patch } : b));
    set({ sequence });
  };
  const addBeat = () =>
    set({ sequence: [...cfg.sequence, { title: `beat${cfg.sequence.length + 1}`, image: "", motion: "" }] });
  const removeBeat = (i: number) => set({ sequence: cfg.sequence.filter((_, j) => j !== i) });

  // LLM proposes the next N beats from the scenario JSON (description + existing
  // beats), each continuing from the previous one, and appends them —
  // review/edit them here, then Save + run the pipeline.
  const generateBeat = async () => {
    setGenBusy(true);
    setGenError("");
    try {
      const res = await craftBeat(cfg, genCount);
      const beats = res.beats ?? (res.beat ? [res.beat] : []); // beat = old server shape
      const used = new Set(cfg.sequence.map((b) => b.title));
      const next = beats.map((b, k) => {
        let title = slug(b.title) || `beat${cfg.sequence.length + k + 1}`;
        if (used.has(title)) title = `${title}_next`;
        used.add(title);
        return { ...b, title };
      });
      set({ sequence: [...cfg.sequence, ...next] });
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenBusy(false);
    }
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
    <section className="card">
      <div className="card-head">
        <h2>
          <span className="head-icon"><IconLayers size={15} /></span>
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
        <span className="muted" style={{ fontSize: 12, fontFamily: "var(--mono)" }}>{name}</span>
        <button
          className="primary"
          onClick={() => doSave()}
          disabled={saving || (!isDraft && !dirty)}
          title={isDraft ? "Save everything as v1 of this project" : dirty ? "Save everything as a new version of this project" : "No changes — nothing to save"}
        >
          {saving ? <Spinner size={13} /> : <IconCheck size={13} />}
          {saving ? "Saving…" : "Save Scenario"}
        </button>
      </div>
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

      {cfg.sequence.map((b, i) => (
        <div className={`beat ${i % 2 ? "alt" : ""}`} key={i}>
          <div className="beat-head">
            <span className="beat-index">{i + 1}</span>
            <input
              className="beat-title"
              value={b.title}
              placeholder="title (file-safe)"
              onChange={(e) => setBeat(i, { title: e.target.value })}
            />
            <button
              className="icon-btn danger"
              title="Remove beat"
              onClick={() => removeBeat(i)}
            >
              <IconX size={13} />
            </button>
          </div>
          <p className="beat-meta">{slug(b.title) || "untitled"}</p>
          <label>Keyframe image — Flux</label>
          <textarea
            rows={2}
            value={b.image}
            onChange={(e) => setBeat(i, { image: e.target.value })}
          />
          <label>Motion &amp; camera — i2v</label>
          <textarea
            rows={2}
            value={b.motion}
            onChange={(e) => setBeat(i, { motion: e.target.value })}
          />
        </div>
      ))}
      <div className="row" style={{ marginTop: 4 }}>
        <button className="ghost" onClick={addBeat} disabled={genBusy}>
          <IconPlus size={13} />
          Add beat
        </button>
        <button className="ghost" onClick={generateBeat} disabled={genBusy} title="LLM proposes the next beat(s) from the scenario + existing beats">
          {genBusy ? <Spinner size={13} /> : <IconSparkles size={13} />}
          {genBusy ? "Generating…" : "Generate beat"}
        </button>
        <label className="gen-count" title="How many next beats to generate (1–8)">
          ×
          <input
            type="number"
            min={1}
            max={8}
            value={genCount}
            disabled={genBusy}
            onChange={(e) => setGenCount(Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
          />
        </label>
      </div>
      {genError && <p className="hint err-text">{genError}</p>}
      <p className="hint">Generate beat asks the LLM for the next story beat(s) from the scenario JSON. Nothing saves until you press Save — every save stores a new version.</p>
    </section>
  );
}
