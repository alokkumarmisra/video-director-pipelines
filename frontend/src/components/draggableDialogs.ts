// Global draggable dialogs (zero deps).
// Every popup box (.dlg-box, .dialog, .db-modal) becomes draggable by its
// header: drag the title bar to move it, release to drop. Implemented once
// via pointer-event delegation so all current AND future popups are covered
// without touching each popup site.
//
// Rules:
// - Only a press that starts on a header (`.dlg-title`, `.dialog-head`,
//   `.db-modal-head`, `[data-drag-handle]`) begins a drag — body text,
//   buttons, inputs, textareas, selects, links and media are never stolen.
// - The overlay stays put; only the box translates (GPU transform).
// - Position clamps so ≥48px of the box stays inside the viewport.
// - Box mounts fresh on each open (conditional render), so there is no stale
//   offset to reset. Escape/backdrop behavior of each popup is untouched.

const BOX_SEL = ".dlg-box, .dialog, .db-modal";
const HANDLE_SEL = ".dlg-title, .dialog-head, .db-modal-head, [data-drag-handle]";
const INTERACTIVE_SEL = "button, input, textarea, select, a, video, audio, img, [contenteditable]";

let installed = false;

export function installGlobalDialogDrag(): () => void {
  if (installed) return () => {};
  installed = true;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const handle = (e.target as HTMLElement | null)?.closest?.(HANDLE_SEL);
    if (!handle) return;
    const box = handle.closest(BOX_SEL) as HTMLElement | null;
    if (!box || box.dataset.nodrag === "1") return;
    // Never hijack presses on controls inside the header (close ✕ etc.).
    if ((e.target as HTMLElement).closest?.(INTERACTIVE_SEL)) return;

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = readOffset(box);
    box.classList.add("is-dragging");
    try { (handle as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* noop */ }

    const onMove = (mv: PointerEvent) => {
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;
      const next = clampToViewport(box, base.x + dx, base.y + dy);
      writeOffset(box, next.x, next.y);
    };
    const onUp = () => {
      box.classList.remove("is-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  return () => document.removeEventListener("pointerdown", onPointerDown, { capture: true } as AddEventListenerOptions);
}

function readOffset(box: HTMLElement): { x: number; y: number } {
  const x = Number((box.dataset.dragX ?? "").trim() || 0);
  const y = Number((box.dataset.dragY ?? "").trim() || 0);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

function writeOffset(box: HTMLElement, x: number, y: number) {
  box.dataset.dragX = String(Math.round(x));
  box.dataset.dragY = String(Math.round(y));
  box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function clampToViewport(box: HTMLElement, x: number, y: number): { x: number; y: number } {
  const r = box.getBoundingClientRect();
  // Rect already includes the current transform; remove it to get the resting spot.
  const cur = readOffset(box);
  const restLeft = r.left - cur.x;
  const restTop = r.top - cur.y;
  const w = r.width;
  const h = r.height;
  const margin = 48;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Keep at least `margin` px of the box visible on each axis.
  const loX = margin - (restLeft + w);
  const hiX = vw - margin - restLeft;
  const loY = margin - (restTop + h);
  const hiY = vh - margin - restTop;
  return {
    x: Math.min(hiX, Math.max(loX, x)),
    y: Math.min(hiY, Math.max(loY, y)),
  };
}
