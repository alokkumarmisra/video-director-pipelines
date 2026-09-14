import { useEffect, useRef, useState } from "react";
import { fmtRelative } from "../api";
import type { DashboardProject } from "../types";
import { IconDots, IconFilm, IconFolder, Spinner } from "./Icons";
import SmoothImage from "./SmoothImage";

const STATUS_LABEL: Record<DashboardProject["status"], string> = {
  draft: "Draft",
  in_progress: "In Progress",
  completed: "Completed",
};

function Thumb({ project }: { project: DashboardProject }) {
  if (!project.thumbnailUrl) {
    return (
      <div className="proj-thumb proj-thumb-fallback" aria-hidden="true">
        <IconFilm size={28} />
      </div>
    );
  }
  // SmoothImage preloads behind the old frame + fades in, so card thumbnail
  // swaps (filter/sort/poll) never flash blank.
  return (
    <SmoothImage
      src={project.thumbnailUrl}
      alt=""
      frameClassName="proj-thumb"
      fallback={
        <span className="smooth-fallback" aria-hidden="true">
          <IconFilm size={28} />
        </span>
      }
    />
  );
}

export default function ProjectCard({
  project,
  onOpen,
  onEdit,
  onDuplicate,
  onMakeClip,
  onDownload,
  onDelete,
  busyAction = null,
}: {
  project: DashboardProject;
  onOpen: (name: string) => void;
  onEdit: (name: string) => void;
  onDuplicate: (name: string) => void;
  onMakeClip: (name: string) => void;
  onDownload: (name: string) => void;
  onDelete: (name: string) => void;
  busyAction?: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [menuOpen]);

  const busy = busyAction != null;
  const clipBusy = busyAction === `clip:${project.name}`;
  const dlBusy = busyAction === `download:${project.name}`;
  const editDisabled = busy || project.generating;
  // Make-a-clip stays enabled while generating: the handler then just opens
  // the workspace so the live progress is visible ("View progress").
  const clipDisabled = busy;
  const delDisabled = busy || project.generating;
  const clipLabel = clipBusy ? "Making…" : project.generating ? "View progress" : "Make a clip";
  const dlLabel = dlBusy ? "Preparing…" : "Download";
  const item = (label: string, fn: () => void, opts: { danger?: boolean; disabled?: boolean } = {}) => (
    <button
      key={label}
      role="menuitem"
      className={`menu-item ${opts.danger ? "danger" : ""}`}
      disabled={opts.disabled}
      onClick={() => {
        setMenuOpen(false);
        fn();
      }}
    >
      {label}
    </button>
  );

  return (
    <article
      className={`card proj-card${project.generating ? " generating" : ""}`}
      aria-label={`Project ${project.name}${project.generating ? " (generating)" : ""}`}
    >
      <div className="proj-media">
        <Thumb project={project} />
        {project.generating && (
          <span className="pill running proj-gen" role="status">
            <Spinner size={11} />
            Generating {project.progress}%
          </span>
        )}
        <div className="proj-menu" ref={menuRef}>
          <button
            className="icon-btn proj-menu-btn"
            aria-label={`Project actions for ${project.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <IconDots size={15} />
          </button>
          {menuOpen && (
            <div className="menu" role="menu">
              {item("Open", () => onOpen(project.name))}
              {item("Edit", () => onEdit(project.name), { disabled: editDisabled })}
              {item(clipBusy ? "Making clip…" : clipLabel, () => onMakeClip(project.name), {
                disabled: clipDisabled,
              })}
              {item(dlLabel, () => onDownload(project.name), { disabled: busy })}
              {item("Duplicate", () => onDuplicate(project.name), { disabled: busy })}
              {item("Delete", () => onDelete(project.name), { danger: true, disabled: delDisabled })}
            </div>
          )}
        </div>
      </div>

      <div className="proj-body">
        <button className="proj-name" onClick={() => onOpen(project.name)} title={project.name}>
          {project.name}
        </button>
        {project.description && <p className="proj-desc">{project.description}</p>}

        {/* While a run is active the card reports Generating (pulsing) instead
            of the coverage status — a fresh project still says Draft
            underneath, which hides the live run. */}
        <div className="proj-status-row" aria-live="polite">
          {project.generating ? (
            <span className="pill running proj-status">
              <span className="dot pulse" />
              Generating…
            </span>
          ) : (
            <span className={`pill proj-status ${project.status === "completed" ? "ok" : project.status === "in_progress" ? "running" : ""}`}>
              {STATUS_LABEL[project.status]}
            </span>
          )}
          <span className="proj-progress-num">{project.progress}%</span>
        </div>
        <div
          className="progress-bar proj-progress"
          role="progressbar"
          aria-label={`${project.name} progress`}
          aria-valuenow={project.progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`progress-fill${project.generating ? " sweep" : ""}`}
            style={{ width: `${project.progress}%` }}
          />
        </div>

        <div className="proj-counts">
          <span title="Scenes">
            <IconFolder size={12} /> {project.sceneCount} Scenes
          </span>
          <span title="Beats with a generated keyframe image">{project.imageCount} Images</span>
          <span title="Beats with a generated video clip">{project.videoCount} Videos</span>
        </div>

        {/* Always-visible actions — the ⋯ menu above offers the same items,
            but these buttons keep Edit / Make a clip / Download / Delete
            discoverable without opening the menu. */}
        <div className="proj-actions" role="toolbar" aria-label={`Actions for ${project.name}`}>
          <button
            className="ghost proj-act"
            title={project.generating ? "Stop the run before editing" : `Edit ${project.name}`}
            disabled={editDisabled}
            onClick={() => onEdit(project.name)}
          >
            Edit
          </button>
          <button
            className="ghost proj-act"
            title={project.generating ? "Open the workspace to watch progress" : `Generate a clip for ${project.name}`}
            disabled={clipDisabled}
            onClick={() => onMakeClip(project.name)}
          >
            {clipLabel}
          </button>
          <button
            className="ghost proj-act"
            title={`Download the finished file for ${project.name}`}
            disabled={busy}
            onClick={() => onDownload(project.name)}
          >
            {dlLabel}
          </button>
          <button
            className="ghost danger proj-act"
            title={project.generating ? "Stop the run before deleting" : `Delete ${project.name}`}
            disabled={delDisabled}
            onClick={() => onDelete(project.name)}
          >
            Delete
          </button>
        </div>
        <div className="proj-foot">
          <span className="muted">Updated {fmtRelative(project.updatedAt)}</span>
          <button className="primary proj-continue" onClick={() => onOpen(project.name)}>
            Continue
          </button>
        </div>
      </div>
    </article>
  );
}
