import { useEffect, useRef, useState } from "react";
import { saveScenario, DEFAULT_PRESET_ID } from "../api";
import type { Scenario } from "../types";
import { IconX, Spinner } from "./Icons";
import PresetSelect from "./PresetSelect";

// Creates a project through the EXISTING scenario save API (PUT
// /api/scenario/:name) with the existing scenario model — an empty beat list
// the workspace editor / Craft panel then fills in. No parallel creation path.
export default function CreateProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [referencePrompt, setReferencePrompt] = useState("");
  const [duration, setDuration] = useState(3);
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID);
  const [presetRules, setPresetRules] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setReferencePrompt("");
      setDuration(3);
      setPresetId(DEFAULT_PRESET_ID);
      setPresetRules("");
      setError(null);
      setBusy(false);
      setTimeout(() => nameRef.current?.focus(), 30);
    }
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      setError("Project name is required.");
      nameRef.current?.focus();
      return;
    }
    if (!referencePrompt.trim()) {
      setError("Master prompt is required — it defines the main visual.");
      return;
    }
    setBusy(true);
    setError(null);
    const config: Scenario = {
      ...(description.trim() ? { description: description.trim() } : {}),
      referencePrompt: referencePrompt.trim(),
      duration: Math.min(10, Math.max(1, Number(duration) || 3)),
      presetId,
      ...(presetRules.trim() ? { presetRules } : {}),
      sequence: [],
    };
    try {
      await saveScenario(n, config);
      onClose();
      onCreated(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed.");
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="dialog-head">
          <h2 id="create-title">Create New Project</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog" disabled={busy}>
            <IconX size={15} />
          </button>
        </div>
        <p className="card-desc">
          Starts an empty character-sequence project. Add story beats in the
          workspace editor or craft them with the LLM.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) submit();
          }}
        >
          <div className="form-row">
            <div className="form-row-main">
              <label htmlFor="create-name">Project Name *</label>
              <input
                id="create-name"
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My music video 2025"
                disabled={busy}
                maxLength={60}
              />
            </div>
            <div className="form-row-side">
              <label htmlFor="create-duration">Clip length (sec)</label>
              <input
                id="create-duration"
                type="number"
                min={1}
                max={10}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                disabled={busy}
              />
            </div>
          </div>
          <label htmlFor="create-desc">Description</label>
          <input
            id="create-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this video about?"
            disabled={busy}
            maxLength={240}
          />
          <PresetSelect
            id="create-preset"
            value={presetId}
            onChange={setPresetId}
            customRules={presetRules}
            onCustomRulesChange={(v) => setPresetRules(v ?? "")}
            disabled={busy}
          />
          <label htmlFor="create-master">Master Prompt *</label>
          <textarea
            id="create-master"
            value={referencePrompt}
            onChange={(e) => setReferencePrompt(e.target.value)}
            placeholder="Cinematic key-visual of the main character…"
            rows={3}
            disabled={busy}
          />
          {error && (
            <p className="err-text dialog-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy && <Spinner size={13} />}
              {busy ? "Creating…" : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
