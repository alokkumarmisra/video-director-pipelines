import { useEffect, useRef, useState } from "react";

// Inactivity period after which auto-follow scrolling engages (2 minutes).
// The live Generating tile is only brought into view once the user has not
// interacted for this long — i.e. they walked away from the screen or the
// system sits idle. While the user is working (pointer / keys / wheel /
// touch / scroll), auto-scroll stays off entirely; the "generating scene N"
// pill still jumps on demand (manual clicks are never gated).
export const IDLE_FOLLOW_MS = 2 * 60 * 1000;

// True once the user has been inactive for `timeoutMs` (default 2 min).
// Any pointer/key/wheel/touch/scroll activity flips it back to false
// immediately; a 5s ticker flips it to true when the deadline passes.
// High-frequency events (mousemove/scroll) are throttled to one stamp per
// second — plenty for a minutes-long window. Tab switches need no special
// case: a hidden tab produces no input, so the deadline passes on its own
// and the caller scrolls on return (visibility/focus) when still idle.
export function useIdleFollow(timeoutMs: number = IDLE_FOLLOW_MS): boolean {
  const [idle, setIdle] = useState(false);
  const lastActive = useRef<number>(Date.now());
  const timeoutRef = useRef(timeoutMs);
  timeoutRef.current = timeoutMs;

  useEffect(() => {
    const stamp = () => {
      lastActive.current = Date.now();
      // setIdle(false) with no change bails out — safe to call per event.
      setIdle(false);
    };
    let lastMove = 0;
    const stampThrottled = () => {
      const t = Date.now();
      if (t - lastMove < 1000) return;
      lastMove = t;
      stamp();
    };
    const opts = { passive: true } as AddEventListenerOptions;
    window.addEventListener("pointerdown", stamp, opts);
    window.addEventListener("keydown", stamp, opts);
    window.addEventListener("wheel", stamp, opts);
    window.addEventListener("touchstart", stamp, opts);
    window.addEventListener("mousemove", stampThrottled, opts);
    window.addEventListener("scroll", stampThrottled, opts);
    const tick = window.setInterval(() => {
      setIdle(Date.now() - lastActive.current >= timeoutRef.current);
    }, 5000);
    return () => {
      window.removeEventListener("pointerdown", stamp);
      window.removeEventListener("keydown", stamp);
      window.removeEventListener("wheel", stamp);
      window.removeEventListener("touchstart", stamp);
      window.removeEventListener("mousemove", stampThrottled);
      window.removeEventListener("scroll", stampThrottled);
      window.clearInterval(tick);
    };
  }, []);

  return idle;
}

// Quiet-time countdown for idle auto-approve: returns how long the user has
// been inactive (ms, ticking every second) plus the idle flag at `timeoutMs`.
// Stage Approve buttons use this with 20s — any pointer/key/wheel/touch/
// scroll activity restarts the clock, so approval only lands after 20
// uninterrupted idle seconds.
export function useQuietMs(timeoutMs: number = IDLE_FOLLOW_MS): { idle: boolean; quietMs: number } {
  const [quietMs, setQuietMs] = useState(0);
  const [idle, setIdle] = useState(false);
  const lastActive = useRef<number>(Date.now());
  const timeoutRef = useRef(timeoutMs);
  timeoutRef.current = timeoutMs;

  useEffect(() => {
    const stamp = () => {
      lastActive.current = Date.now();
      setIdle(false);
    };
    let lastMove = 0;
    const stampThrottled = () => {
      const t = Date.now();
      if (t - lastMove < 1000) return;
      lastMove = t;
      stamp();
    };
    const opts = { passive: true } as AddEventListenerOptions;
    window.addEventListener("pointerdown", stamp, opts);
    window.addEventListener("keydown", stamp, opts);
    window.addEventListener("wheel", stamp, opts);
    window.addEventListener("touchstart", stamp, opts);
    window.addEventListener("mousemove", stampThrottled, opts);
    window.addEventListener("scroll", stampThrottled, opts);
    const tick = window.setInterval(() => {
      const q = Date.now() - lastActive.current;
      setQuietMs(q);
      setIdle(q >= timeoutRef.current);
    }, 1000);
    return () => {
      window.removeEventListener("pointerdown", stamp);
      window.removeEventListener("keydown", stamp);
      window.removeEventListener("wheel", stamp);
      window.removeEventListener("touchstart", stamp);
      window.removeEventListener("mousemove", stampThrottled);
      window.removeEventListener("scroll", stampThrottled);
      window.clearInterval(tick);
    };
  }, []);

  return { idle, quietMs };
}
