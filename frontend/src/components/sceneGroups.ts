import type { Beat } from "../types";

// ---- Scene grouping (multi-shot scenes = ONE group, same color) ----------
// Director-approved beats carry scene_number (one beat per timed shot);
// legacy/manual beats carry none and each forms its own single-shot group.
// Grouping is display-only: flat beat indices (save/version/goto/chips)
// are never renumbered. RenderMonitor reuses these exact helpers so its
// rm-chip outlines match the Scenario Editor's Scene card colors.
export interface SceneGroup { key: string; sceneNumber: number | null; indices: number[] }

export const sceneKeyOf = (sceneNumber: number | null, flatIndex: number): string =>
  sceneNumber != null ? `S${sceneNumber}` : `beat:${flatIndex}`;

export const sceneGroupsOf = (beats: Beat[]): SceneGroup[] => {
  const groups: SceneGroup[] = [];
  const byKey = new Map<string, SceneGroup>();
  beats.forEach((b, i) => {
    const sn = Number(b.scene_number);
    const num = Number.isFinite(sn) && sn > 0 ? Math.round(sn) : null;
    const key = sceneKeyOf(num, i);
    let g = byKey.get(key);
    if (!g) {
      g = { key, sceneNumber: num, indices: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.indices.push(i);
  });
  // Shots inside a scene order by shot_number (then flat order).
  for (const g of groups) {
    g.indices.sort((a, b) => {
      const sa = Number(beats[a]?.shot_number);
      const sb = Number(beats[b]?.shot_number);
      const ha = Number.isFinite(sa) && sa > 0;
      const hb = Number.isFinite(sb) && sb > 0;
      if (ha && hb && sa !== sb) return sa - sb;
      if (ha && !hb) return -1;
      if (!ha && hb) return 1;
      return a - b;
    });
  }
  return groups;
};

// Deterministic accent color per Scene group (same color for every shot in
// it). `fallback` is the group's order index — keeps unlinked single-shot
// groups stable as long as the order is built the same way (beat order).
export const sceneColor = (key: string, sceneNumber: number | null, fallback: number): string => {
  void key;
  const n = sceneNumber ?? (fallback * 37 + 11);
  const hue = ((n * 47) % 360 + 360) % 360;
  return `hsl(${hue}, 65%, 45%)`;
};

export const sceneTint = (key: string, sceneNumber: number | null, fallback: number): string => {
  void key;
  const n = sceneNumber ?? (fallback * 37 + 11);
  const hue = ((n * 47) % 360 + 360) % 360;
  return `hsla(${hue}, 65%, 45%, 0.08)`;
};

// Group color for a flat beat index when only the scene-number list is known
// (RenderMonitor chips). Builds groups with the same algorithm/order as
// sceneGroupsOf so colors match the Scenario Editor exactly. Null = unknown
// beat (no outline).
export const groupColorForBeat = (
  sceneNumbers: (number | null)[] | null | undefined,
  flatIndex: number
): string | null => {
  if (!sceneNumbers || flatIndex < 0 || flatIndex >= sceneNumbers.length) return null;
  const groups: SceneGroup[] = [];
  const byKey = new Map<string, SceneGroup>();
  sceneNumbers.forEach((sn, i) => {
    const num = sn != null && Number.isFinite(sn) && sn > 0 ? Math.round(sn) : null;
    const key = sceneKeyOf(num, i);
    let g = byKey.get(key);
    if (!g) {
      g = { key, sceneNumber: num, indices: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.indices.push(i);
  });
  const gi = groups.findIndex((g) => g.indices.includes(flatIndex));
  if (gi < 0) return null;
  return sceneColor(groups[gi].key, groups[gi].sceneNumber, gi);
};

// Scene number for a flat beat index (null = unlinked single-shot beat).
export const sceneNumberForBeat = (
  sceneNumbers: (number | null)[] | null | undefined,
  flatIndex: number
): number | null => {
  if (!sceneNumbers || flatIndex < 0 || flatIndex >= sceneNumbers.length) return null;
  const sn = sceneNumbers[flatIndex];
  return sn != null && Number.isFinite(sn) && sn > 0 ? Math.round(sn) : null;
};
