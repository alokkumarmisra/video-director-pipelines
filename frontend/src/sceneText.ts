import type { Beat } from "./types";

// Pure text tools over scenario beats (Find / Replace / Add-to-all-scenes).
// No DOM, no fs, no network — fully unit-testable. The SceneTools card calls
// these, then persists the returned sequence through the standard versioned
// save path (every Apply = a new scenario version, never an overwrite).

export interface TextScope {
  titles: boolean;
  images: boolean;
  motions: boolean;
  dialogue: boolean;
}

export const ALL_SCOPE: TextScope = { titles: true, images: true, motions: true, dialogue: true };

export type MatchField = "title" | "image" | "motion" | "dialogue";

export interface TextMatch {
  n: number;
  field: MatchField;
  snippet: string;
}

export type AddTarget = "image" | "motion" | "both" | "title";
export type AddPosition = "append" | "prepend";

const norm = (v: unknown): string => String(v ?? "");
const escRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function snippet(src: string, idx: number, len: number): string {
  const pre = Math.max(0, idx - 30);
  const post = Math.min(src.length, idx + len + 30);
  return `${pre > 0 ? "…" : ""}${src.slice(pre, post)}${post < src.length ? "…" : ""}`;
}

/** Case-insensitive-aware literal match positions (no regex input). */
function matchIndex(haystack: string, needle: string, caseSensitive: boolean): number {
  if (!needle) return -1;
  return caseSensitive
    ? haystack.indexOf(needle)
    : haystack.toLowerCase().indexOf(needle.toLowerCase());
}

/** Find a query across beats. Returns one entry per matching field (1-based n). */
export function findInBeats(
  beats: Beat[],
  query: string,
  scope: TextScope = ALL_SCOPE,
  caseSensitive = false,
): TextMatch[] {
  const q = norm(query);
  const out: TextMatch[] = [];
  if (!q || !Array.isArray(beats)) return out;
  beats.forEach((b, i) => {
    if (!b || typeof b !== "object") return;
    const n = i + 1;
    if (scope.titles) {
      const t = norm(b.title);
      const k = matchIndex(t, q, caseSensitive);
      if (k >= 0) out.push({ n, field: "title", snippet: snippet(t, k, q.length) });
    }
    if (scope.images) {
      const t = norm(b.image);
      const k = matchIndex(t, q, caseSensitive);
      if (k >= 0) out.push({ n, field: "image", snippet: snippet(t, k, q.length) });
    }
    if (scope.motions) {
      const t = norm(b.motion);
      const k = matchIndex(t, q, caseSensitive);
      if (k >= 0) out.push({ n, field: "motion", snippet: snippet(t, k, q.length) });
    }
    if (scope.dialogue && Array.isArray(b.dialogue)) {
      b.dialogue.forEach((d) => {
        if (!d) return;
        const line = norm(d.line);
        if (!line.trim()) return;
        const sp = norm(d.speaker).trim();
        const full = sp ? `${sp}: ${line}` : line;
        const k = matchIndex(full, q, caseSensitive);
        if (k >= 0) {
          // One entry per scene (not per line) — the jump lands on the beat.
          if (!out.some((m) => m.n === n && m.field === "dialogue")) {
            out.push({ n, field: "dialogue", snippet: snippet(full, k, q.length) });
          }
        }
      });
    }
  });
  return out;
}

/** Literal (non-regex) string replace inside one field value. */
function litReplace(src: string, find: string, rep: string, caseSensitive: boolean): string {
  if (!find) return src;
  if (caseSensitive) return src.split(find).join(rep);
  const re = new RegExp(escRegExp(find), "gi");
  // Escape `$` sequences in the replacement (they are patterns to replace()).
  return src.replace(re, rep.replace(/\$/g, "$$$$"));
}

/** Replace text across beats (never mutates the input). Empty find = no-op. */
export function replaceInBeats(
  beats: Beat[],
  find: string,
  rep: string,
  scope: TextScope = ALL_SCOPE,
  caseSensitive = false,
): Beat[] {
  if (!Array.isArray(beats)) return beats;
  const f = norm(find);
  const r = norm(rep);
  if (!f) return beats;
  return beats.map((b) => {
    if (!b || typeof b !== "object") return b;
    const nb = { ...b };
    if (scope.titles && typeof nb.title === "string") nb.title = litReplace(nb.title, f, r, caseSensitive);
    if (scope.images && typeof nb.image === "string") nb.image = litReplace(nb.image, f, r, caseSensitive);
    if (scope.motions && typeof nb.motion === "string") nb.motion = litReplace(nb.motion, f, r, caseSensitive);
    if (scope.dialogue && Array.isArray(nb.dialogue)) {
      nb.dialogue = nb.dialogue.map((d) =>
        d && typeof d.line === "string" ? { ...d, line: litReplace(d.line, f, r, caseSensitive) } : d,
      );
    }
    return nb;
  });
}

/**
 * Add text to every scene's field(s). Prompt fields join with ", " (prompt
 * style), titles with a space. skipPresent leaves fields already carrying the
 * text untouched (no duplicates). Never mutates the input.
 */
export function addTextToBeats(
  beats: Beat[],
  text: string,
  target: AddTarget = "both",
  position: AddPosition = "append",
  skipPresent = true,
): Beat[] {
  if (!Array.isArray(beats)) return beats;
  const t = norm(text).trim();
  if (!t) return beats;
  const low = t.toLowerCase();
  const join = (field: unknown, isTitle: boolean): string => {
    const f = norm(field);
    if (skipPresent && f.toLowerCase().includes(low)) return f;
    if (!f) return t;
    if (position === "prepend") return isTitle ? `${t} ${f}` : `${t}, ${f}`;
    return isTitle ? `${f} ${t}` : `${f}, ${t}`;
  };
  return beats.map((b) => {
    if (!b || typeof b !== "object") return b;
    const nb = { ...b };
    if (target === "image" || target === "both") nb.image = join(b.image, false);
    if (target === "motion" || target === "both") nb.motion = join(b.motion, false);
    if (target === "title") nb.title = join(b.title, true);
    return nb;
  });
}

/** Beats changed between two sequences (by value) — the Apply summary count. */
export function countChanged(before: Beat[], after: Beat[]): number {
  const len = Math.max(
    Array.isArray(before) ? before.length : 0,
    Array.isArray(after) ? after.length : 0,
  );
  let n = 0;
  for (let i = 0; i < len; i++) {
    if (JSON.stringify(before?.[i] ?? null) !== JSON.stringify(after?.[i] ?? null)) n++;
  }
  return n;
}
