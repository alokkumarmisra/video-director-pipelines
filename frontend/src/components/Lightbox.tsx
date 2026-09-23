import { useEffect } from "react";
import { IconX } from "./Icons";

export interface PreviewItem {
  src: string;
  kind: "image" | "video";
  alt?: string;
}

// Fullscreen preview overlay for any generated image/video.
// Closes on backdrop click, the X button, or Escape.
// When `items` (the full gallery for the current section) is provided with
// `index` + `onIndexChange`, Left/Right arrows and the on-screen ‹ › buttons
// step through every image/video without closing the overlay.
export default function Lightbox({
  item,
  items,
  index,
  onIndexChange,
  onClose,
}: {
  item: PreviewItem;
  items?: PreviewItem[];
  index?: number | null;
  onIndexChange?: (i: number) => void;
  onClose: () => void;
}) {
  const list = items && items.length > 0 ? items : [item];
  // Resolve the current position: explicit index wins, otherwise match by src.
  let cur = typeof index === "number" && index >= 0 && index < list.length ? index : list.findIndex((x) => x.src === item.src);
  if (cur < 0) cur = 0;
  const current = list[cur] ?? item;
  const canNav = list.length > 1 && !!onIndexChange;
  const go = (dir: 1 | -1) => {
    if (!canNav || !onIndexChange) return;
    onIndexChange((cur + dir + list.length) % list.length);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      const t = e.target as HTMLElement | null;
      // Never hijack arrows while typing in a field.
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, canNav, cur, list.length]);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={current.alt || "media preview"}
      onClick={onClose}
    >
      <button
        className="lightbox-close"
        onClick={onClose}
        aria-label="Close preview"
        title="Close (Esc)"
      >
        <IconX size={16} />
      </button>
      {canNav && (
        <>
          <button
            className="lightbox-nav lightbox-prev"
            onClick={(e) => { e.stopPropagation(); go(-1); }}
            aria-label="Previous media"
            title="Previous (←)"
          >
            ‹
          </button>
          <button
            className="lightbox-nav lightbox-next"
            onClick={(e) => { e.stopPropagation(); go(1); }}
            aria-label="Next media"
            title="Next (→)"
          >
            ›
          </button>
          <span className="lightbox-count" aria-hidden="true">
            {cur + 1} / {list.length}
          </span>
        </>
      )}
      {current.kind === "video" ? (
        <video
          key={current.src}
          src={current.src}
          controls
          autoPlay
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img
          key={current.src}
          src={current.src}
          alt={current.alt || "preview"}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
