import { useEffect, useState } from "react";
import type { MediaSession } from "./DevotionalMediaProgress";
import DevotionalMediaProgress from "./DevotionalMediaProgress";
import { IconCheck, IconFilm, IconImage, IconRefresh } from "./Icons";

// One known media file for the Image & video section (detail rows carry the
// full DevotionalFile; library cards carry the light list versions — both
// fit this shape).
export interface SectionMediaFile {
  id: number;
  url: string;
  file_kind: string;
}

const isVideoFile = (f: SectionMediaFile) =>
  String(f.file_kind || "").toLowerCase() === "video" ||
  /\.(mp4|webm|mov)$/i.test(String(f.url || ""));

// Image & video section for one devotional asset (characters, locations,
// props, styles): the Keyframes → clips tile copied over — a bulk checkbox,
// the still + clip frames with vN badges, v1/v2/… version chips, and regen
// buttons for image and video. Reuses the exact gallery classes (.versions,
// .vchip, .ver-badge, .shot-check, .frame-missing) so it looks identical.
export default function DevotionalMediaSection({ files, checked, onToggleCheck, checkTitle, session, onDone, onDismiss, onRegenImage, onRegenVideo, regenBusy }: {
  files: SectionMediaFile[];
  checked: boolean;
  onToggleCheck: () => void;
  checkTitle: string;
  session: MediaSession | null;
  onDone: () => void;
  onDismiss: () => void;
  onRegenImage: (fileKind: string) => void;
  onRegenVideo: () => void;
  regenBusy: boolean;
}) {
  // Oldest-first per kind so chips read v1, v2, … in creation order (the
  // versions the pump writes: base, base_v2, …). Latest is the effective
  // main everywhere (previews, clip source) — chips switch the SHOWN file.
  const images = (files ?? []).filter((f) => !isVideoFile(f)).sort((a, b) => a.id - b.id);
  const videos = (files ?? []).filter(isVideoFile).sort((a, b) => a.id - b.id);
  const [shownImage, setShownImage] = useState<number | null>(null);
  const [shownVideo, setShownVideo] = useState<number | null>(null);
  // Follow new versions: default to latest, keep the pick while it exists.
  useEffect(() => {
    setShownImage((cur) => (cur != null && images.some((f) => f.id === cur) ? cur : images[images.length - 1]?.id ?? null));
    setShownVideo((cur) => (cur != null && videos.some((f) => f.id === cur) ? cur : videos[videos.length - 1]?.id ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.map((f) => f.id).join(",")]);
  const image = images.find((f) => f.id === shownImage) ?? null;
  const video = videos.find((f) => f.id === shownVideo) ?? null;
  const imageV = image ? images.indexOf(image) + 1 : null;
  const videoV = video ? videos.indexOf(video) + 1 : null;

  const chipRow = (
    list: SectionMediaFile[],
    shownId: number | null,
    onPick: (id: number) => void,
    kind: "image" | "video",
    onRegen: () => void,
  ) => (
    <div className="versions">
      {list.map((f, i) => (
        <button
          key={f.id}
          className={`vchip ${shownId === f.id ? "on" : ""}`}
          title={shownId === f.id ? `${kind} v${i + 1} (showing)` : `Show ${kind} v${i + 1}`}
          onClick={(e) => { e.stopPropagation(); onPick(f.id); }}
        >
          {shownId === f.id && <IconCheck size={10} />}
          v{i + 1}
        </button>
      ))}
      <button
        className="vchip regen"
        title={`Regenerate ${kind} — keeps previous versions`}
        onClick={(e) => { e.stopPropagation(); onRegen(); }}
        disabled={regenBusy}
      >
        <IconRefresh size={10} />
        regen
      </button>
    </div>
  );

  return (
    <div className="dev-media-section">
      <div className="section-label" style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <input
          type="checkbox"
          className="shot-check"
          checked={checked}
          onChange={(e) => { e.stopPropagation(); onToggleCheck(); }}
          onClick={(e) => e.stopPropagation()}
          title={checkTitle}
          aria-label={checkTitle}
        />
        Image &amp; video
        {(images.length + videos.length) > 0 && (
          <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>
            · {images.length} still{images.length === 1 ? "" : "s"} + {videos.length} clip{videos.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="grid">
        <div className="img-frame" title={image ? `Still v${imageV} of ${images.length}` : "Still"}>
          {image ? (
            <>
              {imageV != null && (
                <span className="ver-badge" title={`Still v${imageV} (showing)`}>v{imageV}</span>
              )}
              <img
                src={image.url}
                alt="generated still"
                loading="lazy"
                style={{ width: "100%", borderRadius: 8, display: "block", background: "var(--bg2)" }}
              />
            </>
          ) : (
            <div className="frame-missing">
              <span className="frame-missing-inner"><IconImage size={16} /><span className="muted">No still yet</span></span>
            </div>
          )}
        </div>
        <div className="video-frame" title={video ? `Clip v${videoV} of ${videos.length}` : "Clip"}>
          {video ? (
            <>
              {videoV != null && (
                <span className="ver-badge" title={`Clip v${videoV} (showing)`}>v{videoV}</span>
              )}
              <video controls preload="metadata" src={video.url} style={{ width: "100%", borderRadius: 8, display: "block", background: "#000" }} />
            </>
          ) : (
            <div className="frame-missing">
              <span className="frame-missing-inner"><IconFilm size={16} /><span className="muted">No clip yet</span></span>
            </div>
          )}
        </div>
      </div>
      {chipRow(images, shownImage, setShownImage, "image", () => onRegenImage(image?.file_kind || "master"))}
      {chipRow(videos, shownVideo, setShownVideo, "video", onRegenVideo)}
      {session && (
        <div style={{ marginTop: 8 }}>
          <DevotionalMediaProgress session={session} onDone={onDone} onDismiss={onDismiss} />
        </div>
      )}
    </div>
  );
}
