import { useEffect } from "react";
import { IconX } from "./Icons";

export interface PreviewItem {
  src: string;
  kind: "image" | "video";
  alt?: string;
}

// Fullscreen preview overlay for any generated image/video.
// Closes on backdrop click, the X button, or Escape.
export default function Lightbox({ item, onClose }: { item: PreviewItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={item.alt || "media preview"}
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
      {item.kind === "video" ? (
        <video
          src={item.src}
          controls
          autoPlay
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img
          src={item.src}
          alt={item.alt || "preview"}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
