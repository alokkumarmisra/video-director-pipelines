import { useCallback, useEffect, useRef, useState } from "react";
import {
  listResources, uploadResource, captionResource, saveResourcePrompt,
  deleteResource, useResource, resourceUrl, listScenarios,
  buildProjectFromResources,
} from "../api";
import type { ResourceEntry } from "../api";
import type { ScenarioInfo } from "../types";
import { IconCheck, IconClapper, IconExpand, IconFolder, IconPlus, IconSparkles, IconTrash, Spinner } from "./Icons";
import Lightbox, { type PreviewItem } from "./Lightbox";
import { useDialog } from "./Dialog";

const readAsDataURL = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error(`could not read ${f.name}`));
    r.readAsDataURL(f);
  });

// Resource library: upload your own images/videos, let the local vision
// model read each one into an AI prompt, then wire any entry into the exact
// Project workflow — a brand-new project (caption as Master Prompt + pixels
// as the pinned reference visual) or an existing project's reference.
export default function ResourcePage({ onOpenProject }: {
  onOpenProject: (name: string) => void;
}) {
  const [items, setItems] = useState<ResourceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // Batch run: caption every resource that has no prompt yet.
  const [processingAll, setProcessingAll] = useState(false);
  const [processMsg, setProcessMsg] = useState("");
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  // Per-card working state (keyed by resource id).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [cardError, setCardError] = useState<Record<string, string>>({});
  const [cardNote, setCardNote] = useState<Record<string, string>>({});
  const [newNames, setNewNames] = useState<Record<string, string>>({});
  const [refTargets, setRefTargets] = useState<Record<string, string>>({});
  // Bulk save: one project from the whole library (middle strip below).
  const [projectName, setProjectName] = useState("");
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const dialog = useDialog();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveNote, setSaveNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [rs, ss] = await Promise.all([
        listResources(),
        listScenarios().catch(() => [] as ScenarioInfo[]),
      ]);
      setItems(rs);
      setScenarios(ss.filter((s) => s.isSequence));
      setDrafts(Object.fromEntries(rs.map((r) => [r.id, r.prompt ?? ""])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setCardBusy = (id: string, op: string | null) =>
    setBusy((prev) => {
      const next = { ...prev };
      if (op === null) delete next[id];
      else next[id] = op;
      return next;
    });

  const uploadFiles = async (files: FileList | File[]) => {
    const list = [...files].filter((f) =>
      f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (!list.length) {
      setError("Pick image or video files to upload.");
      return;
    }
    setError("");
    setUploading((n) => n + list.length);
    try {
      for (const f of list) {
        try {
          const entry = await uploadResource(await readAsDataURL(f));
          setItems((prev) => [entry, ...prev]);
          setDrafts((prev) => ({ ...prev, [entry.id]: entry.prompt ?? "" }));
          if (entry.captionError) {
            setCardError((prev) => ({
              ...prev,
              [entry.id]: entry.novision
                ? `${f.name}: saved without a prompt — ${entry.captionError}`
                : `${f.name}: saved, auto-caption failed — ${entry.captionError}`,
            }));
          }
        } catch (e) {
          setError(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      setUploading((n) => Math.max(0, n - list.length));
    }
  };

  const doCaption = async (id: string) => {
    setCardBusy(id, "caption");
    setCardError((prev) => ({ ...prev, [id]: "" }));
    setCardNote((prev) => ({ ...prev, [id]: "" }));
    try {
      const next = await captionResource(id);
      setItems((prev) => prev.map((r) => (r.id === id ? next : r)));
      setDrafts((prev) => ({ ...prev, [id]: next.prompt ?? "" }));
      setCardNote((prev) => ({ ...prev, [id]: "AI prompt generated — review it, then Save prompt or start a project." }));
    } catch (e) {
      const novision = (e as Error & { vision?: boolean }).vision === false;
      setCardError((prev) => ({
        ...prev,
        [id]: novision
          ? `${e instanceof Error ? e.message : String(e)}`
          : `Generate prompt failed: ${e instanceof Error ? e.message : String(e)}`,
      }));
    } finally {
      setCardBusy(id, null);
    }
  };

  // Process All: run the vision model over every image (and every video
  // with a thumbnail) that has no AI prompt yet, one by one. Stops early
  // with the reason shown when no vision model is loaded.
  const processAll = async () => {
    const targets = items.filter(
      (r) => !r.prompt && (r.kind === "image" || (r.kind === "video" && r.thumb)));
    if (targets.length === 0) {
      setProcessMsg("Nothing to process — every image/video already has an AI prompt.");
      return;
    }
    setProcessingAll(true);
    setError("");
    setProcessMsg("");
    let done = 0;
    let failed = 0;
    let stopped = "";
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      setProcessMsg(`Processing ${i + 1}/${targets.length}…`);
      setCardBusy(r.id, "caption");
      setCardError((prev) => ({ ...prev, [r.id]: "" }));
      try {
        const next = await captionResource(r.id);
        setItems((prev) => prev.map((x) => (x.id === r.id ? next : x)));
        setDrafts((prev) => ({ ...prev, [r.id]: next.prompt ?? "" }));
        setCardNote((prev) => ({ ...prev, [r.id]: "AI prompt generated." }));
        done++;
      } catch (e) {
        failed++;
        const novision = (e as Error & { vision?: boolean }).vision === false;
        const msg = e instanceof Error ? e.message : String(e);
        setCardError((prev) => ({ ...prev, [r.id]: msg }));
        if (novision) {
          stopped = msg;
          setCardBusy(r.id, null);
          break;
        }
      } finally {
        setCardBusy(r.id, null);
      }
    }
    setProcessMsg(
      stopped
        ? `Stopped — ${stopped}`
        : failed === 0
          ? `Process All done — ${done} captioned.`
          : `Process All done — ${done} captioned, ${failed} failed (see the cards).`);
    setProcessingAll(false);
  };

  const doSavePrompt = async (id: string) => {
    setCardBusy(id, "save");
    setCardError((prev) => ({ ...prev, [id]: "" }));
    try {
      const next = await saveResourcePrompt(id, drafts[id] ?? "");
      setItems((prev) => prev.map((r) => (r.id === id ? next : r)));
      setCardNote((prev) => ({ ...prev, [id]: "Prompt saved." }));
    } catch (e) {
      setCardError((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCardBusy(id, null);
    }
  };

  const doDelete = async (id: string, file: string) => {
    const ok = await dialog.confirm("This cannot be undone.", {
      title: "Delete resource " + file + "?",
      tone: "error",
      okText: "Delete",
      cancelText: "Keep",
    });
    if (!ok) return;
    setCardBusy(id, "delete");
    try {
      await deleteResource(id);
      setItems((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      setCardError((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
      setCardBusy(id, null);
    }
  };

  const doNewProject = async (id: string) => {
    const name = (newNames[id] ?? "").trim();
    if (!name) {
      setCardError((prev) => ({ ...prev, [id]: "Enter a project name first." }));
      return;
    }
    setCardBusy(id, "new");
    setCardError((prev) => ({ ...prev, [id]: "" }));
    try {
      const r = await useResource(id, { mode: "new", name });
      onOpenProject(r.name ?? name);
    } catch (e) {
      setCardError((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
      setCardBusy(id, null);
    }
  };

  const doUseRef = async (id: string) => {
    const project = refTargets[id] ?? "";
    if (!project) {
      setCardError((prev) => ({ ...prev, [id]: "Pick a project first." }));
      return;
    }
    setCardBusy(id, "ref");
    setCardError((prev) => ({ ...prev, [id]: "" }));
    try {
      await useResource(id, { mode: "ref", project });
      setCardNote((prev) => ({ ...prev, [id]: `Installed as the pinned reference of "${project}" — open it to continue the normal workflow.` }));
    } catch (e) {
      setCardError((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCardBusy(id, null);
    }
  };

  // Save Project: build one project from ALL library items on the server —
  // one beat per resource (AI prompt → scene image, oldest first), first
  // prompt as Master Prompt, first pixels as the pinned reference, media
  // installed under the pipeline filename pattern so Keyframes → clips,
  // Story Board and Rendered Clip resolve by name. The server writes the
  // scenarios row + prompts JSON + projects row + one KEYFRAME/VIDEO
  // project_assets row per scene, then the workspace opens it.
  const doSaveProject = async () => {
    const name = projectName.trim();
    if (!name) {
      setSaveError("Enter a project name first.");
      return;
    }
    if (items.length === 0) {
      setSaveError("No resources yet — upload images/videos first.");
      return;
    }
    if (scenarios.some((s) => s.name === name)) {
      setSaveError(`A project named "${name}" already exists — pick another name.`);
      return;
    }
    setSaving(true);
    setSaveError("");
    setSaveNote("");
    try {
      // Persist any unsaved prompt edits first so the beats carry exactly
      // what the textboxes show (the build reads stored prompts).
      for (const r of items) {
        const d = drafts[r.id] ?? "";
        if (d === (r.prompt ?? "")) continue;
        try {
          const next = await saveResourcePrompt(r.id, d);
          setItems((prev) => prev.map((x) => (x.id === r.id ? next : x)));
        } catch {
          // Build continues with the last saved prompt for this card.
        }
      }
      const r = await buildProjectFromResources(name);
      const warn = Array.isArray(r.warnings) && r.warnings.length
        ? ` (${r.warnings.join(" ")})`
        : "";
      setSaveNote(
        `Project "${r.name}" saved with ${r.scenes} scene${r.scenes === 1 ? "" : "s"}${warn} — opening…`);
      onOpenProject(r.name);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card" aria-label="Resource library">
      {preview && <Lightbox item={preview} onClose={() => setPreview(null)} />}
      <div className="card-head">
        <h2>
          <span className="head-icon hi-craft"><IconFolder size={15} /></span>
          Resource Library
        </h2>
        <span className="spacer" />
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) void uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          className="primary"
          onClick={() => fileRef.current?.click()}
          disabled={uploading > 0 || processingAll}
          title="Upload your own images/videos — the AI reads each one into a prompt"
        >
          {uploading > 0 ? <Spinner size={13} /> : <IconPlus size={13} />}
          {uploading > 0 ? `Uploading ${uploading}…` : "Upload"}
        </button>
        <button
          className="btn-green"
          onClick={() => void processAll()}
          disabled={uploading > 0 || processingAll || loading || items.length === 0}
          title="Run the vision model over every image/video that has no AI prompt yet (one by one — needs a VL model loaded in LM Studio)"
        >
          {processingAll ? <Spinner size={13} /> : <IconSparkles size={13} />}
          {processingAll ? "Processing…" : "Process All"}
        </button>
      </div>
      {processMsg && <p className="hint">{processMsg}</p>}
      <p className="card-desc">
        Your own images and videos, ready for processing. The vision model reads
        each upload into an AI prompt automatically — then start a project from
        it and continue the exact Project workflow (AI Craft beats, Generate).
      </p>
      <div className="res-build">
        <label htmlFor="res-build-name">Save the whole library as one project</label>
        <div className="row">
          <input
            id="res-build-name"
            value={projectName}
            placeholder="New project name…"
            maxLength={60}
            disabled={saving || loading}
            onChange={(e) => setProjectName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doSaveProject(); }}
          />
          <button
            className="primary"
            onClick={() => void doSaveProject()}
            disabled={saving || loading || !projectName.trim() || items.length === 0}
            title="Save all library items as one project — one scene per resource, then open it"
          >
            {saving ? <Spinner size={12} /> : <IconClapper size={12} />}
            {saving ? "Saving…" : "Save Project"}
          </button>
        </div>
        <p className="hint">
          One scene per resource (AI prompt → scene image, oldest first), the first
          item&apos;s prompt as Master Prompt and its pixels as the pinned reference.
        </p>
        {saveError && <p className="hint err-text">{saveError}</p>}
        {saveNote && <p className="hint">{saveNote}</p>}
      </div>
      <div
        className={`res-drop${dragOver ? " over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
        }}
      >
        {loading ? (
          <p className="hint"><Spinner size={13} /> Loading resources…</p>
        ) : items.length === 0 ? (
          <p className="hint">No resources yet — Upload images/videos, or drop them here.</p>
        ) : (
          <div className="res-grid">
            {items.map((r) => {
              const op = busy[r.id] ?? null;
              const draft = drafts[r.id] ?? "";
              const dirty = draft !== (r.prompt ?? "");
              const poster = r.kind === "video" && r.thumb ? resourceUrl(r.thumb) : undefined;
              return (
                <div key={r.id} className="res-card">
                  <div className="res-preview">
                    <button
                      className="frame-expand"
                      title={r.kind === "video" ? `Fullscreen preview of ${r.file}` : `Fullscreen preview of ${r.file}`}
                      aria-label={r.kind === "video" ? `Fullscreen preview of ${r.file}` : `Fullscreen preview of ${r.file}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreview(r.kind === "video"
                          ? { src: resourceUrl(r.file), kind: "video", alt: r.file }
                          : { src: resourceUrl(r.file), kind: "image", alt: r.prompt ?? r.file });
                      }}
                    >
                      <IconExpand size={13} />
                    </button>
                    {r.kind === "image" ? (
                      <img src={resourceUrl(r.file)} alt={r.prompt ?? r.file} loading="lazy" />
                    ) : (
                      <video src={resourceUrl(r.file)} poster={poster} controls preload="metadata" />
                    )}
                    <span className={`res-kind ${r.kind}`}>{r.kind}</span>
                  </div>
                  <p className="beat-meta">{r.file}</p>
                  <label>AI prompt {r.kind === "video" ? "(from middle frame)" : ""}</label>
                  <textarea
                    rows={3}
                    value={draft}
                    placeholder={r.captionError ? "No prompt yet — Generate prompt below, or write one." : "AI prompt…"}
                    disabled={op !== null}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  />
                  {r.captionError && !r.prompt && (
                    <p className="hint err-text">{r.captionError}</p>
                  )}
                  {cardError[r.id] && <p className="hint err-text">{cardError[r.id]}</p>}
                  {cardNote[r.id] && <p className="hint">{cardNote[r.id]}</p>}
                  <div className="row res-actions">
                    <button
                      className="btn-blue"
                      onClick={() => void doCaption(r.id)}
                      disabled={op !== null}
                      title="Have the local vision model read this and write the AI prompt (needs a VL model loaded in LM Studio, e.g. Qwen3-VL)"
                    >
                      {op === "caption" ? <Spinner size={12} /> : <IconSparkles size={12} />}
                      {op === "caption" ? "Reading…" : "Generate prompt"}
                    </button>
                    <button
                      className="ghost"
                      onClick={() => void doSavePrompt(r.id)}
                      disabled={op !== null || !dirty}
                      title={dirty ? "Save the edited prompt" : "No edits — nothing to save"}
                    >
                      {op === "save" ? <Spinner size={12} /> : <IconCheck size={12} />}
                      Save prompt
                    </button>
                    <button
                      className="icon-btn danger"
                      onClick={() => void doDelete(r.id, r.file)}
                      disabled={op !== null}
                      title={`Delete "${r.file}"`}
                      aria-label={`Delete "${r.file}"`}
                    >
                      {op === "delete" ? <Spinner size={12} /> : <IconTrash size={12} />}
                    </button>
                  </div>
                  <div className="res-use">
                    <label>New project from this</label>
                    <div className="row">
                      <input
                        value={newNames[r.id] ?? ""}
                        placeholder="Project name…"
                        maxLength={60}
                        disabled={op !== null}
                        onChange={(e) => setNewNames((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === "Enter") void doNewProject(r.id); }}
                      />
                      <button
                        className="btn-green"
                        onClick={() => void doNewProject(r.id)}
                        disabled={op !== null || !(newNames[r.id] ?? "").trim()}
                        title="Create a project with this prompt as Master Prompt and these pixels as the pinned reference — then Craft + Generate exactly like any project"
                      >
                        {op === "new" ? <Spinner size={12} /> : <IconClapper size={12} />}
                        {op === "new" ? "Creating…" : "Start project"}
                      </button>
                    </div>
                    <label style={{ marginTop: 8 }}>Use as reference in</label>
                    <div className="row">
                      <select
                        value={refTargets[r.id] ?? ""}
                        disabled={op !== null || scenarios.length === 0}
                        onChange={(e) => setRefTargets((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        title={scenarios.length === 0 ? "No projects yet — start one above first" : "Install as the pinned reference visual of this project"}
                      >
                        <option value="">Pick a project…</option>
                        {scenarios.map((s) => (
                          <option key={s.name} value={s.name}>{s.name}</option>
                        ))}
                      </select>
                      <button
                        className="ghost"
                        onClick={() => void doUseRef(r.id)}
                        disabled={op !== null || !(refTargets[r.id] ?? "")}
                        title="Install as this project's pinned reference visual (pipeline then skips reference generation)"
                      >
                        {op === "ref" ? <Spinner size={12} /> : <IconCheck size={12} />}
                        {op === "ref" ? "Installing…" : "Use as reference"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {error && <p className="hint err-text">{error}</p>}
      {uploading > 0 && <p className="hint">Uploading {uploading} file{uploading === 1 ? "" : "s"}…</p>}
      <p className="hint">
        Tip: prompt generation reads through your local vision model — if it reports
        no vision support, load Qwen3-VL-4B (already downloaded) in LM Studio and retry.
      </p>
    </section>
  );
}
