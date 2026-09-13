import { useEffect, useState } from "react";
import type { Scenario } from "../types";
import { IconPanel, IconSparkles, Spinner } from "./Icons";

// Saved snapshot of every Create New Project field for the open project.
// The panel mirrors the create form control-for-control (text inputs,
// number input, textareas) so the whole brief is visible AND editable here.
export interface CraftSource {
  name: string;
  description: string;
  duration: number | null;
  masterPrompt: string;
}

interface Props {
  onCrafted: (name: string, config: Scenario, project_id?: number | null) => void;  // Saved scenario the craft applies to (the open project) — the LLM drafts
  // a new version of THIS project, so Save stores v(N+1) with delta rows for
  // changed scenes only. Null = craft a brand-new project.
  craftTarget: string | null;
  // Saved values of the open project (or draft). Locals start from here and
  // resync on syncEpoch (project switch / save / version switch).
  source: CraftSource;
  // True for an unsaved draft — the project name can't be renamed before the
  // first save (nothing exists to rename yet).
  isDraft: boolean;
  // Bump to refill every box from `source` (used after external resets the
  // parent can't express through `source` alone).
  syncEpoch: number;
  // Field edits flow to the parent's override bag (null = drop the override)
  // and are merged into the next explicit Save in the Scenario Editor.
  onPatch: (p: {
    description?: string | null;
    duration?: number | null;
    referencePrompt?: string | null;
  }) => void;
  // Project rename (saved projects only) — staged in the parent, applied on
  // the next explicit Save via the rename API.
  onNameChange: (v: string | null) => void;
  // Collapsed state lives in the parent (like the Projects panel) so the
  // workspace grid can shrink the right column and let the middle expand.
  // Closed renders only the slim right-docked reopen rail.
  open: boolean;
  onToggle: () => void;
}

// Project brief editor (mirrors Create New Project) + description +
// master prompt -> local LLM crafts a scenario JSON.
export default function CraftPanel({
  onCrafted, craftTarget, source, isDraft, syncEpoch, onPatch, onNameChange,
  open, onToggle,
}: Props) {
  const [name, setName] = useState(source.name);
  const [description, setDescription] = useState(source.description);
  const [durationStr, setDurationStr] = useState(source.duration != null ? String(source.duration) : "");
  const [master, setMaster] = useState(source.masterPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);

  // Refill every box from the saved snapshot: on project switch, after Save,
  // and after the editor drops overrides (version switch/delete). Local
  // typing never retriggers this — `source` only changes on selection /
  // loaded data, and `syncEpoch` only on external resets.
  useEffect(() => {
    setName(source.name);
    setDescription(source.description);
    setDurationStr(source.duration != null ? String(source.duration) : "");
    setMaster(source.masterPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncEpoch]);

  const craft = async () => {
    setBusy(true);
    setError("");
    setSeconds(0);
    const t0 = Date.now();
    const tick = setInterval(() => setSeconds((Date.now() - t0) / 1000), 500);
    try {
      const r = await fetch("/api/craft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          masterPrompt: master,
          ...(craftTarget ? { target: craftTarget } : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // The crafted draft becomes the new baseline (parent refills every box
      // from it).
      onCrafted(d.name, d.config, d.project_id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearInterval(tick);
      setBusy(false);
    }
  };

  const setDuration = (v: string) => {
    setDurationStr(v);
    const t = v.trim();
    const num = Number(t);
    onPatch({ duration: t === "" || !Number.isFinite(num) ? null : Math.min(10, Math.max(1, Math.round(num))) });
  };

  if (!open) {
    return (
      <button
        className="sidebar-show rail-right"
        onClick={onToggle}
        title="Show AI Craft"
        aria-label="Show AI Craft"
        aria-expanded={false}
      >
        <IconPanel size={15} />
        <span className="sidebar-show-label">AI Craft</span>
      </button>
    );
  }

  return (
    <section className="card" aria-label="AI Craft">
      <div className="card-head">
        <h2>
          <span className="head-icon hi-craft"><IconSparkles size={15} /></span>
          AI Craft
        </h2>
        {busy && (
          <span className="pill running">
            <Spinner size={11} />
            {Math.round(seconds)}s
          </span>
        )}
        <span className="spacer" />
        <button
          className="icon-btn"
          onClick={onToggle}
          title="Hide AI Craft"
          aria-label="Hide AI Craft"
          aria-expanded={true}
        >
          <IconPanel size={15} />
        </button>
      </div>

      <label htmlFor="craft-name">Project Name *</label>
      <input
        id="craft-name"
        value={name}
        placeholder="My music video 2025"
        maxLength={60}
        disabled={busy || isDraft}
        title={isDraft ? "Save the project first to rename it" : "Rename the project — applied on Save"}
        onChange={(e) => {
          setName(e.target.value);
          onNameChange(e.target.value);
        }}
      />
      {isDraft && (
        <p className="hint">Save the project first — renaming unlocks after the first save.</p>
      )}
      <label htmlFor="craft-desc">Description</label>
      <input
        id="craft-desc"
        value={description}
        placeholder="What is this video about?"
        maxLength={240}
        disabled={busy}
        onChange={(e) => {
          setDescription(e.target.value);
          onPatch({ description: e.target.value });
        }}
      />
      <label htmlFor="craft-duration">Clip length (sec)</label>
      <input
        id="craft-duration"
        type="number"
        min={1}
        max={10}
        value={durationStr}
        placeholder="3"
        disabled={busy}
        onChange={(e) => setDuration(e.target.value)}
      />
      <label htmlFor="craft-master">Master Prompt *</label>
      <textarea
        id="craft-master"
        rows={3}
        value={master}
        placeholder="Cinematic key-visual of the main character…"
        disabled={busy}
        onChange={(e) => {
          setMaster(e.target.value);
          onPatch({ referencePrompt: e.target.value });
        }}
      />
      <p className="hint">Edits update on the next explicit Save in the Scenario Editor.</p>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={craft} disabled={busy || !description.trim()}>
          {busy ? <Spinner size={13} /> : <IconSparkles size={13} />}
          {busy ? "Crafting…" : "Craft scenario"}
        </button>
      </div>
      {error && <p className="hint err-text">{error}</p>}
      <p className="hint">
        {craftTarget ? (
          <>The LLM drafts a new version of <b>{craftTarget}</b> below — review it, then Save scenario to store it as the next version (only changed scenes get new rows).</>
        ) : (
          <>The LLM drafts a full scenario below with all prompts — review it, then Save scenario to store it as v1.</>
        )}
      </p>
    </section>
  );
}
