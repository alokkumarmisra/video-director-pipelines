import { useEffect, useState, type ReactNode } from "react";
import { IconImage, Spinner } from "./Icons";

interface SmoothImageProps {
  src: string;
  alt: string;
  title?: string;
  loading?: "lazy" | "eager";
  /** Extra class on the frame (e.g. "proj-thumb" to fill an aspect box). */
  frameClassName?: string;
  /** Extra class on the rendered <img>. */
  imgClassName?: string;
  onClick?: () => void;
  /** Shown when the image fails to load (defaults to a muted icon). */
  fallback?: ReactNode;
}

// Image that never flashes: the currently visible frame stays mounted while
// the incoming src preloads invisibly behind it, and only swaps once the new
// file is fully decoded (cached → instant). First paint shows a shimmer
// placeholder with a spinner that reserves the space, so surrounding layout
// never collapses or jumps while media lands.
export default function SmoothImage({
  src,
  alt,
  title,
  loading = "lazy",
  frameClassName,
  imgClassName,
  onClick,
  fallback,
}: SmoothImageProps) {
  // What's actually on screen. Lags `src` by exactly one preload — the old
  // frame covers the swap, so a project/engine switch never shows a blank
  // or half-decoded image.
  const [shown, setShown] = useState(src);
  // True once the on-screen frame has painted (spinner only before that).
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (src === shown) return;
    setFailed(false);
    let live = true;
    const im = new Image();
    im.onload = () => {
      if (live) setShown(src);
    };
    im.onerror = () => {
      if (live) {
        setShown(src);
        setFailed(true);
      }
    };
    im.src = src;
    return () => {
      live = false;
    };
  }, [src, shown]);

  if (!src) {
    return (
      <span className={`smooth-img is-empty${frameClassName ? ` ${frameClassName}` : ""}`} aria-hidden="true">
        {fallback ?? (
          <span className="smooth-fallback">
            <IconImage size={18} />
          </span>
        )}
      </span>
    );
  }

  return (
    <span
      className={`smooth-img${!ready ? " is-loading" : ""}${onClick ? " clickable" : ""}${
        frameClassName ? ` ${frameClassName}` : ""
      }`}
    >
      {!ready && !failed && (
        <span className="smooth-spin" aria-hidden="true">
          <Spinner size={14} />
        </span>
      )}
      {!failed ? (
        <img
          key={shown}
          src={shown}
          alt={alt}
          title={title}
          loading={loading}
          decoding="async"
          draggable={false}
          className={imgClassName}
          onClick={onClick}
          onLoad={() => setReady(true)}
          onError={() => {
            setReady(true);
            setFailed(true);
          }}
        />
      ) : (
        fallback ?? (
          <span className="smooth-fallback" aria-label={alt || "image unavailable"}>
            <IconImage size={18} />
          </span>
        )
      )}
    </span>
  );
}
