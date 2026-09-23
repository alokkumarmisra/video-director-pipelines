// Global beautified tooltips — one delegated manager for every native
// `title` attribute app-wide (100+ call sites, none of which change).
//
// How it works: on hover/focus of any [title] element the manager stashes the
// text, removes the attribute (so the ugly native box never appears) and
// shows a single shared theme-aware floating bubble after a short delay.
// On leave/blur/scroll/Escape the bubble hides and the attribute is restored,
// so React re-renders and accessibility tree see the original markup.
//
// No React, no deps — initialized once from main.tsx. Note: disabled
// buttons/inputs don't fire mouse events, so (like native titles) they show
// the bubble on keyboard focus instead.
const SHOW_DELAY_MS = 280;
const GAP = 10;
const MARGIN = 8;

let tip: HTMLDivElement | null = null;
let timer: number | null = null;
let touchTimer: number | null = null;
let current: { el: Element; text: string } | null = null;

function ensureTip(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip-float";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

function clearTimer() {
  if (timer != null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

function hide(restore = true) {
  clearTimer();
  if (touchTimer != null) {
    window.clearTimeout(touchTimer);
    touchTimer = null;
  }
  if (tip) tip.hidden = true;
  if (restore && current) {
    // Put the title back exactly where it was (React owns the prop; the
    // attribute is only borrowed while the bubble is armed/visible).
    try {
      if (!current.el.hasAttribute("title")) current.el.setAttribute("title", current.text);
    } catch { /* detached node — nothing to restore */ }
  }
  current = null;
}

function place(el: Element) {
  const box = ensureTip();
  box.hidden = false;
  // Measure unclamped first so flipping decisions use real dimensions.
  box.classList.remove("tip-top", "tip-bottom");
  box.style.left = "0px";
  box.style.top = "-9999px";
  const tw = box.offsetWidth;
  const th = box.offsetHeight;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(MARGIN, Math.min(left, vw - tw - MARGIN));
  const fitsAbove = r.top >= th + GAP + MARGIN;
  if (fitsAbove) {
    box.classList.add("tip-top");
    box.style.top = `${Math.max(MARGIN, r.top - th - GAP)}px`;
  } else {
    box.classList.add("tip-bottom");
    box.style.top = `${r.bottom + GAP}px`;
  }
  box.style.left = `${left}px`;
  // Caret tracks the anchor point, clamped inside the bubble.
  const caret = Math.max(12, Math.min(tw - 12, r.left + r.width / 2 - left));
  box.style.setProperty("--tip-caret", `${caret}px`);
}

function arm(el: Element, text: string, delay: number) {
  hide();
  current = { el, text };
  try {
    el.removeAttribute("title");
  } catch { current = null; return; }
  clearTimer();
  timer = window.setTimeout(() => {
    if (!current) return;
    const box = ensureTip();
    box.textContent = current.text;
    place(current.el);
  }, delay);
}

/** Nearest ancestor (or self) carrying a non-empty title. */
function titledFrom(e: Event): { el: Element; text: string } | null {
  const t = e.target as Element | null;
  if (!t || !(t instanceof Element)) return null;
  const el = t.closest("[title]");
  if (!el) return null;
  const text = (el.getAttribute("title") || "").trim();
  return text ? { el, text } : null;
}

export function initTooltips(): () => void {
  const onOver = (e: MouseEvent) => {
    // Moving between children of the same titled ancestor keeps the bubble.
    if (current && current.el.contains(e.target as Node)) return;
    const found = titledFrom(e);
    if (!found) {
      hide();
      return;
    }
    if (current && current.el === found.el) return;
    arm(found.el, found.text, SHOW_DELAY_MS);
  };
  const onOut = (e: MouseEvent) => {
    if (!current) return;
    const to = e.relatedTarget as Node | null;
    // Still inside the same titled element (child to child) — stay armed.
    if (to && current.el.contains(to)) return;
    hide();
  };
  const onFocusIn = (e: FocusEvent) => {
    const found = titledFrom(e);
    if (!found) return;
    arm(found.el, found.text, 120);
  };
  const onFocusOut = () => hide();
  const onScroll = () => hide();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") hide();
  };
  const onDown = () => hide();
  const onTouchStart = (e: TouchEvent) => {
    const found = titledFrom(e);
    if (!found) return;
    // Long-press shows the bubble; a plain tap must not leave it stuck.
    if (touchTimer != null) window.clearTimeout(touchTimer);
    touchTimer = window.setTimeout(() => {
      if (!titledFrom(e)) return;
      arm(found.el, found.text, 0);
    }, 450);
  };
  const onTouchEnd = () => {
    if (touchTimer != null) {
      window.clearTimeout(touchTimer);
      touchTimer = null;
    }
    hide();
  };

  document.addEventListener("mouseover", onOver);
  document.addEventListener("mouseout", onOut);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onDown);
  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchend", onTouchEnd);
  document.addEventListener("touchcancel", onTouchEnd);
  return () => {
    document.removeEventListener("mouseover", onOver);
    document.removeEventListener("mouseout", onOut);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onDown);
    document.removeEventListener("touchstart", onTouchStart);
    document.removeEventListener("touchend", onTouchEnd);
    document.removeEventListener("touchcancel", onTouchEnd);
    hide(false);
    if (tip?.parentNode) tip.parentNode.removeChild(tip);
    tip = null;
  };
}
