import { useEffect, useRef, useState } from "react";
import { getScenario, renameScenario, saveScenario } from "../api";
import type { Scenario } from "../types";
import { IconX, Spinner } from "./Icons";

// Edits a project's metadata through the EXISTING scenario APIs: field
// changes go through PUT /api/scenario/:name (new version, same as the
// workspace Save) and a renamed project goes through POST
// /api/scenario/:name/rename first (prompts JSON + outputs dirs + every
// name-keyed DB row move with it). Beats/character are preserved untouched.
export default function EditProjectDialog({
  name,
  onClose,
  onSaved,
}: {
  // Project being edited; null = dialog closed.
  name: string | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [base, setBase] = useState<Scenario | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [description, setDescription] = useState("");
  const [referencePrompt, setReferencePrompt] = useState("");
  const [duration, setDuration] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!name) return;
    setBase(null);
    setLoading(true);
    setLoadError(null);
    setError(null);
    setBusy(false);
    getScenario(name)
      .then(({ config }) => {
        setBase(config);
        setNewName(name);
        setDescription(config.description ?? "");
        setReferencePrompt(config.referencePrompt ?? "");
        setDuration(Number(config.duration) || 3);
        setTimeout(() => nameRef.current?.focus(), 30);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [name]);

  useEffect(() => {
    if (!name) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [name, busy, onClose]);

  if (!name) return null;

  const submit = async () => {
    if (!base) return;
    const n = newName.trim();
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
      ...base,
      ...(description.trim() ? { description: description.trim() } : { description: undefined }),
      referencePrompt: referencePrompt.trim(),
      duration: Math.min(10, Math.max(1, Number(duration) || 3)),
    };
    // Strip keys the user cleared so a removed value doesn't linger in the DB.
    if (!description.trim()) delete config.description;
    try {
      let finalName = name;
      if (n !== name) {
        const r = await renameScenario(name, n);
        finalName = r.name;
      }
      await saveScenario(finalName, config);
      onClose();
      onSaved(finalName);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy && !loading) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="edit-title">
        <div className="dialog-head">
          <h2 id="edit-title">Edit Project</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog" disabled={busy}>
            <IconX size={15} />
          </button>
        </div>
        {loading && (
          <p className="card-desc">
            <Spinner size={13} /> Loading project…
          </p>
        )}
        {loadError && (
          <p className="err-text dialog-error" role="alert">
            {loadError}
          </p>
        )}
        {!loading && !loadError && base && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) submit();
            }}
          >
            <div className="form-row">
              <div className="form-row-main">
                <label htmlFor="edit-name">Project Name *</label>
                <input
                  id="edit-name"
                  ref={nameRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  disabled={busy}
                  maxLength={60}
                />
              </div>
              <div className="form-row-side">
                <label htmlFor="edit-duration">Clip length (sec)</label>
                <input
                  id="edit-duration"
                  type="number"
                  min={1}
                  max={10}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  disabled={busy}
                />
              </div>
            </div>
            <label htmlFor="edit-desc">Description</label>
            <input
              id="edit-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this video about?"
              disabled={busy}
              maxLength={240}
            />
            <label htmlFor="edit-master">Master Prompt * (Applied in All Scene)</label>
            <textarea
              id="edit-master"
              value={referencePrompt}
              onChange={(e) => setReferencePrompt(e.target.value)}
              placeholder="Cinematic key-visual of the main character…"
              rows={3}
              disabled={busy}
            />
            <p className="card-desc">
              {base.sequence.length} beat{base.sequence.length === 1 ? "" : "s"} preserved — editing here never touches the story beats.
            </p>
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
                {busy ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
