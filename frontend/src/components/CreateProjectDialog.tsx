import { useEffect, useRef, useState } from "react";
import { saveScenario, craftMasterPrompt, DEFAULT_PRESET_ID } from "../api";
import type { Scenario } from "../types";
import { IconSparkles, IconX, Spinner } from "./Icons";
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
  const [aiBusy, setAiBusy] = useState(false);
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
      setAiBusy(false);
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

  // Fill the Master Prompt box from the Description + chosen Video Type via
  // LM Studio (POST /api/master-prompt). Nothing is persisted — just the box.
  const fillMasterByAI = async () => {
    const d = description.trim();
    if (!d || busy || aiBusy) {
      if (!d) setError("Enter a Description first — the AI writes the Master Prompt from it.");
      return;
    }
    setAiBusy(true);
    setError(null);
    try {
      const r = await craftMasterPrompt(d, { presetId, presetRules });
      setReferencePrompt(String(r.masterPrompt ?? "").trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Get by AI failed.");
    } finally {
      setAiBusy(false);
    }
  };

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      setError("Project name is required.");
      nameRef.current?.focus();
      return;
    }
    // Master Prompt is optional — blank means only the AI prompt is sent
    // for image and video generation.
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
      await saveScenario(n, { 
        ...config, 
        // Immutable storage folder hint (server is authoritative: it mints a
        // unique folder on creation and freezes it — same rule as
        // lib/variant.mjs folderSlug, kept byte-identical here).
        folder_name: n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 100) || 'project'
      });
      
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
              <label htmlFor="create-duration">Clip length</label>
              <input
                id="create-duration"
                type="number"
                min={1}
                max={10}
                value={duration}
                placeholder="sec"
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
          <label htmlFor="create-master" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>Master Prompt * (Applied in All Scene)</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn-blue"
              onClick={() => void fillMasterByAI()}
              disabled={busy || aiBusy || !description.trim()}
              title={description.trim() ? "Ask LM Studio to write the Master Prompt from the Description + Video Type above" : "Enter a Description above first"}
              style={{ padding: "2px 10px", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {aiBusy ? <Spinner size={12} /> : <IconSparkles size={12} />}
              {aiBusy ? "Writing…" : "Get by AI"}
            </button>
          </label>
          <textarea
            id="create-master"
            value={referencePrompt}
            onChange={(e) => setReferencePrompt(e.target.value)}
            placeholder="Cinematic key-visual of the main character…"
            rows={3}
            disabled={busy || aiBusy}
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
