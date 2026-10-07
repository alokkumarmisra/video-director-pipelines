// Idle-gated auto-follow tests: auto-scroll to the live Generating tile
// must engage only after 2 idle minutes (user walked away / system idle) —
// never while the user is working. Manual pill jumps stay ungated.
// Run: node --test tests/autofollow_idle.test.mjs (repo root; zero deps)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("idle-gated auto-follow", () => {
  it("shared hook defines the 2-minute window and working-input signals", () => {
    const src = read("frontend/src/components/useIdleFollow.ts");
    assert.match(src, /IDLE_FOLLOW_MS\s*=\s*2\s*\*\s*60\s*\*\s*1000/);
    assert.match(src, /export function useIdleFollow/);
    for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "mousemove", "scroll"]) {
      assert.ok(src.includes(`"${ev}"`), `listens to ${ev}`);
    }
  });

  it("Keyframes auto-follow scrolls only when idle", () => {
    const src = read("frontend/src/components/OutputGallery.tsx");
    assert.match(src, /useIdleFollow\(\)/);
    // The gen-target effect bails for working users before any scrolling.
    const fx = src.slice(src.indexOf("genTileRef"));
    assert.ok(fx.includes("if (!idle) return"), "idle gate before scroll");
    assert.ok(
      fx.indexOf("if (!idle) return") < fx.indexOf("scrollIntoView"),
      "gate precedes the auto scroll"
    );
  });

  it("manual generating-pill jump is never idle-gated", () => {
    const src = read("frontend/src/components/OutputGallery.tsx");
    const at = src.indexOf("const scrollToGen");
    const end = src.indexOf("};", at);
    const manual = src.slice(at, end);
    assert.ok(manual.includes("scrollIntoView"), "manual jump scrolls");
    assert.ok(!manual.includes("idle"), "manual jump has no idle check");
  });

  it("returning to the screen re-centers the live tile when still idle", () => {
    const src = read("frontend/src/components/OutputGallery.tsx");
    assert.match(src, /visibilitychange/);
    assert.match(src, /window\.addEventListener\("focus"/);
  });

  it("Director planning auto-follow is idle-gated too", () => {
    const src = read("frontend/src/components/DirectorPage.tsx");
    assert.match(src, /useIdleFollow\(\)/);
    const fx = src.slice(src.indexOf("liveFromRef"));
    assert.ok(fx.includes("if (!idle) return"), "planning follow gated");
  });
});
