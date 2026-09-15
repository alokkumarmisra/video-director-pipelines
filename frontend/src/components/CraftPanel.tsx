import { useEffect, useState } from "react";
import type { Scenario } from "../types";
import { DEFAULT_PRESET_ID } from "../api";
import { IconCheck, IconPanel, IconSparkles, IconX, Spinner } from "./Icons";
import PresetSelect from "./PresetSelect";

// Saved snapshot of every Create New Project field for the open project.
// The panel mirrors the create form control-for-control (text inputs,
// number input, preset dropdown + rules customization, textareas) so the
// whole brief is visible AND editable here.
export interface CraftSource {
  name: string;
  description: string;
  duration: number | null;
  presetId: string;
  presetRules: string;
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
    presetId?: string | null;
    presetRules?: string | null;
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
  // Scenes currently below (Story Board / Scenario Editor). The Apply button
  // appends the Master Prompt box text to every one of them.
  sceneCount: number;
  // Append `master` to all scenes below: drafts update locally (persisted by
  // the next explicit Save), saved projects persist immediately as a new
  // version. Resolves { applied, saved } for the confirmation hint.
  onApplyMaster: (master: string) => Promise<{ applied: number; saved: boolean }>;
}

// Project brief editor (mirrors Create New Project) + description +
// master prompt -> local LLM crafts a scenario JSON.
export default function CraftPanel({
  onCrafted, craftTarget, source, isDraft, syncEpoch, onPatch, onNameChange,
  open, onToggle, sceneCount, onApplyMaster,
}: Props) {
  const [name, setName] = useState(source.name);
  const [description, setDescription] = useState(source.description);
  const [durationStr, setDurationStr] = useState(source.duration != null ? String(source.duration) : "");
  const [presetId, setPresetId] = useState(source.presetId || DEFAULT_PRESET_ID);
  const [presetRules, setPresetRules] = useState(source.presetRules || "");
  // Rules on/off for the next craft (persisted per browser, NOT saved on the
  // project). Off = Craft scenario sends only Description + Master prompt —
  // no video-type rules are concatenated.
  const [rulesEnabled, setRulesEnabled] = useState(() => {
    try {
      return localStorage.getItem("ss-craft-rules") !== "off";
    } catch {
      return true;
    }
  });
  const setRulesOn = (v: boolean) => {
    setRulesEnabled(v);
    try {
      localStorage.setItem("ss-craft-rules", v ? "on" : "off");
    } catch { /* storage unavailable — toggle still works in-memory */ }
  };
  const [master, setMaster] = useState(source.masterPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  // "Apply to All Scene": appends the Master Prompt box text to every scene
  // below (Story Board + Scenario Editor). Result message, not an error.
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyMsg, setApplyMsg] = useState("");
  const applyMaster = async () => {
    if (applyBusy) return;
    setApplyBusy(true);
    setApplyMsg("");
    setError("");
    try {
      const r = await onApplyMaster(master);
      setApplyMsg(
        r.applied === 0
          ? "Every scene already carries the Master Prompt."
          : r.saved
            ? `Master Prompt applied to ${r.applied} scene${r.applied === 1 ? "" : "s"} — saved as a new version.`
            : `Master Prompt applied to ${r.applied} scene${r.applied === 1 ? "" : "s"} — Save scenario to persist.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyBusy(false);
    }
  };
  // "View Prompt" popup: the exact LLM messages the next craft would send.
  // The user message is editable — crafting from the popup sends the edited
  // text as `userPrompt` (this craft only; the Description / Master boxes
  // are left untouched).
  const [promptOpen, setPromptOpen] = useState(false);
  const [previewSystem, setPreviewSystem] = useState("");
  const [previewUser, setPreviewUser] = useState("");
  const [previewMeta, setPreviewMeta] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");

  // Refill every box from the saved snapshot: on project switch, after Save,
  // and after the editor drops overrides (version switch/delete). Local
  // typing never retriggers this — `source` only changes on selection /
  // loaded data, and `syncEpoch` only on external resets.
  useEffect(() => {
    setName(source.name);
    setDescription(source.description);
    setDurationStr(source.duration != null ? String(source.duration) : "");
    setPresetId(source.presetId || DEFAULT_PRESET_ID);
    setPresetRules(source.presetRules || "");
    setMaster(source.masterPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncEpoch]);

  // Request body shared by preview + craft so the popup shows exactly
  // what "Craft scenario" would send. `userPrompt` carries popup edits.
  const craftBody = (userPrompt?: string) => ({
    description,
    masterPrompt: master,
    ...(rulesEnabled
      ? { presetId, ...(presetRules.trim() ? { presetRules } : {}) }
      : { rulesDisabled: true }),
    ...(craftTarget ? { target: craftTarget } : {}),
    ...(userPrompt !== undefined ? { userPrompt } : {}),
  });

  const craft = async (userPrompt?: string) => {
    setBusy(true);
    setError("");
    setSeconds(0);
    const t0 = Date.now();
    const tick = setInterval(() => setSeconds((Date.now() - t0) / 1000), 500);
    try {
      const r = await fetch("/api/craft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(craftBody(userPrompt)),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // The crafted draft becomes the new baseline (parent refills every box
      // from it).
      setPromptOpen(false);
      onCrafted(d.name, d.config, d.project_id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearInterval(tick);
      setBusy(false);
    }
  };

  // Open the popup with a fresh preview. The brief is read from the stored
  // project (database first, prompts JSON fallback) merged with the current
  // box edits — the popup header shows which source backs it.
  const openPromptPreview = async () => {
    // Boxes may be empty for a stored project — the server backfills the
    // brief from the database / prompts JSON copy via `target`.
    if (busy || (!description.trim() && !craftTarget)) return;
    setPromptOpen(true);
    setPreviewError("");
    setPreviewSystem("");
    setPreviewUser("");
    setPreviewMeta("");
    setPreviewBusy(true);
    try {
      const r = await fetch("/api/craft-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(craftBody()),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setPreviewSystem(typeof d.system === "string" ? d.system : "");
      setPreviewUser(typeof d.user === "string" ? d.user : "");
      const src =
        d.source === "database" ? "Database" :
        d.source === "json" ? "prompts JSON" : "Current edits";
      const proj = typeof d.project === "string" && d.project ? ` \u201c${d.project}\u201d` : "";
      const rules = d.rulesApplied ? `Rules: ${d.presetName || "preset"} applied` : "Rules disabled — brief only";
      setPreviewMeta(`Source: ${src}${proj} \u00b7 ${rules}`);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  // Escape closes the popup (same pattern as Create Project).
  useEffect(() => {
    if (!promptOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPromptOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [promptOpen]);

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

      <div className="form-row">
        <div className="form-row-main">
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
        </div>
        <div className="form-row-side">
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
        </div>
      </div>
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
      <PresetSelect
        id="craft-preset"
        value={presetId}
        onChange={(v) => {
          setPresetId(v);
          onPatch({ presetId: v });
        }}
        customRules={presetRules}
        onCustomRulesChange={(v) => {
          setPresetRules(v ?? "");
          onPatch({ presetRules: v });
        }}
        rulesEnabled={rulesEnabled}
        onRulesEnabledChange={setRulesOn}
        disabled={busy}
      />
      <label htmlFor="craft-master">Master Prompt * (Applied in All Scene)</label>
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
      <div className="row craft-actions" style={{ marginTop: 12 }}>
        <button
          className="btn-blue"
          onClick={() => void openPromptPreview()}
          disabled={busy || (!description.trim() && !craftTarget)}
          title="Preview the exact prompt sent to the LLM — review and edit it before crafting"
        >
          View Prompt
        </button>
        <button
          onClick={() => void applyMaster()}
          disabled={busy || applyBusy || !master.trim() || sceneCount === 0}
          title="Append the Master Prompt text above to every scene's keyframe image prompt below (Motion & camera is never touched)"
        >
          {applyBusy ? <Spinner size={13} /> : <IconCheck size={13} />}
          {applyBusy ? "Applying…" : "Apply to All Scene"}
        </button>
        <button className="primary" onClick={() => void craft()} disabled={busy || !description.trim()}>
          {busy ? <Spinner size={13} /> : <IconSparkles size={13} />}
          {busy ? "Crafting…" : "Craft scenario"}
        </button>
      </div>
      {error && <p className="hint err-text">{error}</p>}
      {applyMsg && <p className="hint">{applyMsg}</p>}
      <p className="hint">
        {craftTarget ? (
          <>The LLM drafts a new version of <b>{craftTarget}</b> below — review it, then Save scenario to store it as the next version (only changed scenes get new rows).</>
        ) : (
          <>The LLM drafts a full scenario below with all prompts — review it, then Save scenario to store it as v1.</>
        )}
      </p>
      {promptOpen && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setPromptOpen(false); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="craft-prompt-title" style={{ maxWidth: 720 }}>
            <div className="dialog-head">
              <h2 id="craft-prompt-title">Craft Prompt Preview</h2>
              <button className="icon-btn" onClick={() => setPromptOpen(false)} aria-label="Close prompt preview" disabled={busy}>
                <IconX size={15} />
              </button>
            </div>
            <p className="card-desc">
              Exactly what the LLM receives{previewMeta ? ` — ${previewMeta}` : ""}. Edit the user
              message below, then craft with it.
            </p>
            {previewBusy ? (
              <p className="hint">Building preview…</p>
            ) : previewError ? (
              <p className="err-text dialog-error" role="alert">{previewError}</p>
            ) : (
              <>
                <label>System prompt (read-only)</label>
                <div className="preset-rules" aria-label="System prompt (read-only)">
                  <pre>{previewSystem}</pre>
                </div>
                <label htmlFor="craft-prompt-user" style={{ marginTop: 12 }}>User prompt (editable)</label>
                <textarea
                  id="craft-prompt-user"
                  className="prompt-preview-edit"
                  rows={16}
                  value={previewUser}
                  disabled={busy}
                  onChange={(e) => setPreviewUser(e.target.value)}
                  aria-label="Final user prompt sent to the LLM (editable)"
                />
                <p className="hint">
                  Edits apply to this craft only — the Description / Master prompt boxes are unchanged.
                </p>
              </>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => void openPromptPreview()}
                disabled={busy || previewBusy}
                title="Rebuild the preview from the current Description / Master prompt / rules"
              >
                Refresh
              </button>
              <button type="button" className="ghost" onClick={() => setPromptOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void craft(previewUser)}
                disabled={busy || previewBusy || !previewUser.trim()}
                title="Send this exact prompt to the LLM and save the drafted scenario"
              >
                {busy ? <Spinner size={13} /> : <IconSparkles size={13} />}
                {busy ? "Crafting…" : "Craft with this prompt"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
