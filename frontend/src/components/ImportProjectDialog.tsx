import { useEffect, useRef, useState } from "react";
import { importProject, type ImportResult } from "../api";
import { useDialog } from "./Dialog";
import { IconUpload, IconX, Spinner } from "./Icons";

// Imports an external storyboard/project JSON file as a first-class project:
// scenes[] (scene_number/name/timestamp/camera_angle/visual_assets/
// character_actions/on_screen_text/audio_cues + any extra keys) are converted
// server-side into a canonical Scenario and saved through the standard
// pipeline (scenarios + versions + projects + project_assets + prompts JSON).
function uniqueName(base: string, taken: Set<string>) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base}_${i}`;
    if (!taken.has(n)) return n;
  }
}

// Cheap client-side preview so pasted JSON shows what will be imported
// before anything is sent (the server re-validates authoritatively).
function previewOf(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const scenes = Array.isArray(r.scenes) ? r.scenes
    : Array.isArray(r.sequence) ? r.sequence
    : Array.isArray(r.beats) ? r.beats : null;
  if (!scenes) return null;
  const title = String(
    (r as Record<string, unknown>).project_title
    ?? r.title ?? (r as Record<string, unknown>).name ?? "Imported Project"
  ).trim() || "Imported Project";
  return `${scenes.length} scene${scenes.length === 1 ? "" : "s"} · "${title}"`;
}

export default function ImportProjectDialog({
  open,
  takenNames,
  onClose,
  onImported,
}: {
  open: boolean;
  takenNames: string[];
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}) {
  const [jsonText, setJsonText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [nameOverride, setNameOverride] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialog = useDialog();

  useEffect(() => {
    if (open) {
      setJsonText("");
      setFileName(null);
      setNameOverride("");
      setError(null);
      setBusy(false);
      setTimeout(() => textRef.current?.focus(), 30);
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

  const pickFile = async (file: File) => {
    try {
      setJsonText(await file.text());
      setFileName(file.name);
      setError(null);
    } catch {
      setError("Could not read that file.");
    }
  };

  const preview = (() => {
    if (!jsonText.trim()) return null;
    try {
      return previewOf(JSON.parse(jsonText));
    } catch {
      return null;
    }
  })();

  const submit = async () => {
    if (busy) return;
    if (!jsonText.trim()) {
      setError("Paste your project JSON below or choose a .json file first.");
      textRef.current?.focus();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch {
      setError("That is not valid JSON — check for missing commas, quotes or brackets.");
      textRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const override = nameOverride.trim() || undefined;
      const attempt = (name?: string, overwrite?: boolean) =>
        importProject(raw, { ...(name ? { name } : {}), ...(overwrite ? { overwrite: true } : {}) });
      let result: ImportResult;
      try {
        result = await attempt(override);
      } catch (e) {
        if (!(e instanceof Error && (e as Error & { exists?: boolean }).exists)) throw e;
        const clash = (e as Error & { name?: string }).name || override || "project";
        const over = await dialog.confirm(
          `A project named "${clash}" already exists. Overwrite it with the imported data? (Cancel imports it as a copy instead.)`,
          { title: "Project already exists", tone: "warning", okText: "Overwrite", cancelText: "Import as copy" }
        );
        result = over
          ? await attempt(override || clash, true)
          : await attempt(uniqueName(override || clash, new Set(takenNames)));
      }
      onClose();
      onImported(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="dialog-head">
          <h2 id="import-title">Import Project</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog" disabled={busy}>
            <IconX size={15} />
          </button>
        </div>
        <p className="card-desc">
          Paste a storyboard/project JSON (project_title + scenes with camera,
          visuals, actions, audio cues) or pick a .json file — scenes become
          generation beats, every field (including extras) is stored.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="import-json">Project JSON *</label>
          <textarea
            id="import-json"
            ref={textRef}
            value={jsonText}
            onChange={(e) => {
              setJsonText(e.target.value);
              if (error) setError(null);
            }}
            placeholder='Paste here, e.g. { "project_title": "My Story", "total_duration": "02:10", "scenes": [ … ] }'
            rows={10}
            disabled={busy}
            spellCheck={false}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <IconUpload size={13} /> Choose .json file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              aria-label="Choose project JSON file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void pickFile(f);
              }}
            />
            {fileName && <span className="card-desc" style={{ margin: 0 }}>{fileName}</span>}
            {preview && !error && (
              <span className="pill" title="Parsed from the JSON above">
                {preview}
              </span>
            )}
          </div>
          <label htmlFor="import-name" style={{ marginTop: 12 }}>Project name (optional — defaults to project_title)</label>
          <input
            id="import-name"
            value={nameOverride}
            onChange={(e) => setNameOverride(e.target.value)}
            placeholder="Leave empty to use the JSON title"
            disabled={busy}
            maxLength={120}
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
              {busy ? "Importing…" : "Import Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
