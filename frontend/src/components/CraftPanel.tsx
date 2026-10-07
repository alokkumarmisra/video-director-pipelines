import { useEffect, useRef, useState } from "react";
import type { Beat, Scenario } from "../types";
import { applyMasterScene, DEFAULT_PRESET_ID } from "../api";
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
  // opens the Master Prompt popup, which AI-merges the edited master into
  // each of these beats (keyframe image only — motion never touched).
  sceneCount: number;
  // Keyframe beats the popup merges into (title for progress + image merged
  // by the AI). Empty = popup Apply stays disabled.
  beats?: Beat[];
  // Persist the AI-merged sequence + the edited master text. Drafts update
  // locally (next explicit Save persists); saved projects persist immediately
  // as a new version. Resolves { applied, saved } for the confirmation hint.
  onApplyAiSequence: (next: Beat[], newMaster: string) => Promise<{ applied: number; saved: boolean }>;
  // Legacy plain append (kept for compat, unused by the popup flow).
  onApplyMaster?: (master: string) => Promise<{ applied: number; saved: boolean }>;
  // Save-first hook: the parent persists the open saved project's current
  // box edits (rename + new version) BEFORE the LLM crafts, so crafting
  // always builds on stored project data. Resolves the display name to
  // craft against (null = draft/unsaved — craft creates a new project).
  // Throwing aborts the craft with the error shown.
  onBeforeCraft?: () => Promise<string | null>;
}

// Project brief editor (mirrors Create New Project) + description +
// master prompt -> local LLM crafts a scenario JSON.
export default function CraftPanel({
  onCrafted, craftTarget, source, isDraft, syncEpoch, onPatch, onNameChange,
  open, onToggle, sceneCount, beats = [], onApplyAiSequence, onBeforeCraft,
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
  // "Apply to All Scene" popup: the Master Prompt opens editable in a modal;
  // its Apply button AI-merges the text into every scene's keyframe prompt
  // (presence-checked per scene, inserted at the natural place). Result
  // message, not an error.
  const [applyMsg, setApplyMsg] = useState("");
  // Master-prompt popup state. `statuses[i]` tracks the per-scene AI merge
  // so the popup can show live progress ("working on scene N…").
  const [masterOpen, setMasterOpen] = useState(false);
  const [popupMaster, setPopupMaster] = useState("");
  const [popupBusy, setPopupBusy] = useState(false);
  const [popupError, setPopupError] = useState("");
  const [popupDone, setPopupDone] = useState("");
  const [popupAt, setPopupAt] = useState(-1);
  const [statuses, setStatuses] = useState<
    { state: "pending" | "working" | "done" | "skipped" | "failed"; reason: string }[]
  >([]);
  const cancelPopupRef = useRef(false);
  const openMasterPopup = () => {
    setPopupMaster(master);
    setPopupError("");
    setPopupDone("");
    setPopupAt(-1);
    const pendingList = (Array.isArray(beats) ? beats : []).map(() => ({ state: "pending" as const, reason: "" }));
    setStatuses(pendingList);
    cancelPopupRef.current = false;
    setMasterOpen(true);
  };
  const closeMasterPopup = () => {
    if (popupBusy) cancelPopupRef.current = true;
    setMasterOpen(false);
  };
  // Popup Apply: AI-merge `popupMaster` into every beat one by one (sequential
  // so the progress list advances scene-by-scene), then persist the merged
  // sequence + edited master via the parent (draft-local or new version).
  const applyPopupMaster = async () => {
    const list = Array.isArray(beats) ? beats : [];
    const m = popupMaster.trim();
    if (popupBusy || !m || list.length === 0) return;
    cancelPopupRef.current = false;
    setPopupBusy(true);
    setPopupError("");
    setPopupDone("");
    setStatuses(list.map(() => ({ state: "pending" as const, reason: "" })));
    const nextImages: string[] = [];
    let stopped = false;
    for (let i = 0; i < list.length; i++) {
      if (cancelPopupRef.current) { stopped = true; break; }
      setPopupAt(i);
      setStatuses((prev) => prev.map((s, k) => (k === i ? { state: "working", reason: "" } : s)));
      try {
        const r = await applyMasterScene(m, {
          title: list[i].title ?? "",
          image: list[i].image ?? "",
          motion: list[i].motion ?? "",
        });
        nextImages[i] = r.image;
        setStatuses((prev) => prev.map((s, k) => (k === i
          ? r.changed
            ? { state: "done", reason: `${r.fallback ? "LLM offline — appended. " : ""}${r.reason}` }
            : { state: "skipped", reason: r.reason || "Already present — untouched." }
          : s)));
      } catch (e) {
        nextImages[i] = String(list[i].image ?? "");
        setStatuses((prev) => prev.map((s, k) => (k === i
          ? { state: "failed", reason: e instanceof Error ? e.message : String(e) }
          : s)));
      }
    }
    setPopupAt(-1);
    setPopupBusy(false);
    if (stopped) {
      setPopupError(`Stopped after scene ${statuses.filter((s) => s.state !== "pending").length} — no changes were saved.`);
      return;
    }
    const next: Beat[] = list.map((b, i) => (
      nextImages[i] !== undefined && nextImages[i] !== String(b.image ?? "")
        ? { ...b, image: nextImages[i] }
        : { ...b }
    ));
    const changedCount = next.filter((b, i) => b.image !== list[i].image).length;
    // The edited master becomes the stored Master Prompt too (box + save),
    // so the next scene added starts with the new text.
    setMaster(m);
    onPatch({ referencePrompt: m });
    if (changedCount === 0) {
      setPopupDone("Every scene already carries this text — nothing changed.");
      setApplyMsg("Every scene already carries the Master Prompt.");
      return;
    }
    try {
      const r = await onApplyAiSequence(next, m);
      const msg = r.saved
        ? `Master Prompt applied to ${r.applied} scene${r.applied === 1 ? "" : "s"} — saved as a new version.`
        : `Master Prompt applied to ${r.applied} scene${r.applied === 1 ? "" : "s"} — Save scenario to persist.`;
      setPopupDone(msg);
      setApplyMsg(msg);
    } catch (e) {
      setPopupError(e instanceof Error ? e.message : String(e));
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
  const craftBody = (target: string | null, userPrompt?: string) => ({
    description,
    masterPrompt: master,
    ...(rulesEnabled
      ? { presetId, ...(presetRules.trim() ? { presetRules } : {}) }
      : { rulesDisabled: true }),
    ...(target ? { target } : {}),
    ...(userPrompt !== undefined ? { userPrompt } : {}),
  });

  const craft = async (userPrompt?: string) => {
    setBusy(true);
    setError("");
    setSeconds(0);
    const t0 = Date.now();
    const tick = setInterval(() => setSeconds((Date.now() - t0) / 1000), 500);
    try {
      // Persist the open project's current edits FIRST (rename + new
      // version) so the craft builds on stored project data. Drafts skip
      // this — the craft itself creates their project.
      const target = onBeforeCraft ? await onBeforeCraft() : (craftTarget ?? null);
      const r = await fetch("/api/craft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(craftBody(target, userPrompt)),
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
        body: JSON.stringify(craftBody(craftTarget ?? null)),
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

  // Escape closes the master popup (never while a scene merge is in flight —
  // use Stop for that, so a stray keypress can't lose progress).
  useEffect(() => {
    if (!masterOpen || popupBusy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMasterOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [masterOpen, popupBusy]);

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
          <label htmlFor="craft-duration">Clip length</label>
          <input
            id="craft-duration"
            type="number"
            min={1}
            max={10}
            value={durationStr}
            placeholder="sec"
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
      <p className="hint">Edits save automatically before Craft scenario, or on the next explicit Save in the Scenario Editor.</p>
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
          onClick={() => openMasterPopup()}
          disabled={busy || !master.trim() || sceneCount === 0}
          title="Open the Master Prompt popup — edit the text, then AI merges it into every scene's keyframe image prompt (Motion & camera is never touched)"
        >
          <IconCheck size={13} />
          Apply to All Scene
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
      {masterOpen && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !popupBusy) closeMasterPopup(); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="master-popup-title" style={{ maxWidth: 640 }}>
            <div className="dialog-head">
              <h2 id="master-popup-title">Apply Master Prompt to All Scenes</h2>
              <button className="icon-btn" onClick={closeMasterPopup} aria-label="Close master prompt popup">
                <IconX size={15} />
              </button>
            </div>
            <p className="card-desc">
              Edit the master text below (e.g. add “parrot red beak”), then press Apply.
              The AI checks each scene — already-present details are skipped, missing ones are
              inserted at the natural place in the keyframe prompt. Motion &amp; camera is never touched.
            </p>
            <label htmlFor="master-popup-text">Master Prompt (editable)</label>
            <textarea
              id="master-popup-text"
              rows={4}
              value={popupMaster}
              disabled={popupBusy}
              onChange={(e) => setPopupMaster(e.target.value)}
              placeholder="Cinematic key-visual of the main character…"
              aria-label="Master prompt to apply to all scenes (editable)"
            />
            {popupBusy && (
              <div style={{ marginTop: 10 }} role="status" aria-live="polite">
                <p className="hint">
                  {popupAt >= 0 && beats[popupAt]
                    ? "AI is working on scene " + (popupAt + 1) + " of " + beats.length + " — \u201c" + String(beats[popupAt].title || "beat" + (popupAt + 1)).slice(0, 60) + "\u201d…"
                    : "Starting…"}
                </p>
                <div className="progress-bar" aria-hidden="true">
                  <div
                    className="progress-fill"
                    style={{ width: String(beats.length ? Math.round((statuses.filter((s) => s.state !== "pending" && s.state !== "working").length / beats.length) * 100) : 0) + "%" }}
                  />
                </div>
              </div>
            )}
            {statuses.length > 0 && (popupBusy || popupDone || popupError) && (
              <div className="beat-versions" style={{ marginTop: 10, maxHeight: 220, overflowY: "auto" }} aria-label="Per-scene apply progress">
                {statuses.map((s, i) => (
                  <div key={i} className="row" style={{ alignItems: "center", gap: 8, padding: "2px 0" }}>
                    <span className="beat-index" title={`Scene ${i + 1}`}>{i + 1}</span>
                    <span className="beat-title" style={{ flex: 1 }} title={String(beats[i]?.title || "")}>
                      {String(beats[i]?.title || `beat${i + 1}`).slice(0, 60)}
                    </span>
                    <span
                      className={`pill${s.state === "done" ? " ok" : s.state === "failed" ? " warn" : s.state === "working" ? " running" : ""}`}
                      title={s.reason || s.state}
                    >
                      {s.state === "working" ? (<><Spinner size={10} /> working</>) : s.state}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {popupError && <p className="err-text dialog-error" role="alert">{popupError}</p>}
            {popupDone && <p className="hint">{popupDone}</p>}
            <div className="dialog-actions">
              <button type="button" className="ghost" onClick={closeMasterPopup} disabled={false}>
                {popupBusy ? "Stop" : popupDone ? "Close" : "Cancel"}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void applyPopupMaster()}
                disabled={popupBusy || !popupMaster.trim() || beats.length === 0}
                title="AI-check every scene and merge the master text where it is missing"
              >
                {popupBusy ? <Spinner size={13} /> : <IconSparkles size={13} />}
                {popupBusy ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
