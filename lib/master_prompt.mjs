// Master Prompt fan-out: whatever is written in the Master Prompt box is
// appended to every scene's KEYFRAME image prompt at craft time (Craft
// scenario, Generate beat, Add beat/shot prefill). Motion & camera prompts
// are never touched — the master is visual direction, not movement.
// Blank master = no-op, so only the AI prompt is sent for generation.
//
// Used by frontend/server.mjs (craftScenario, craftNextBeats) and covered
// by tests/master_prompt.test.mjs. Zero deps, Node >= 18.

/**
 * Append the master prompt to each beat's keyframe image prompt.
 * - Blank/whitespace-only master returns the beats unchanged.
 * - Empty image field becomes exactly the master (nothing to append to).
 * - Motion is always left untouched.
 * - Never double-appends: an image already containing the master is kept as-is.
 * @param {Array<{title,image,motion}>} beats
 * @param {string} masterPrompt
 * @returns a new array (input beats are never mutated)
 */
export function applyMasterToBeats(beats, masterPrompt) {
  const master = String(masterPrompt ?? "").trim();
  if (!master) return Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  return (Array.isArray(beats) ? beats : []).map((b) => {
    const out = { ...(b || {}) };
    const s = String(out.image ?? "").trim();
    if (!s) out.image = master;
    else if (!s.includes(master)) out.image = `${s}, ${master}`;
    else out.image = s;
    return out;
  });
}
