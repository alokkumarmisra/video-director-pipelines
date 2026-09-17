// Generating-tile overlay tests: the Keyframes → clips scene that is
// processing must carry a centered loading indicator on its image or video.
// Run: node --test tests/generating_overlay.test.mjs (repo root; zero deps)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("keyframes → clips generating overlay", () => {
  it("beats tiles render a centered GenOverlay on the generating image/clip", () => {
    const src = read("frontend/src/components/OutputGallery.tsx");
    assert.match(src, /function GenOverlay/);
    // Screen-reader announced + spinner + readout.
    assert.match(src, /role="status"/);
    assert.match(src, /<Spinner size=\{15\} \/>/);
    // Keyframe frame shows it whether a previous version exists or not.
    assert.match(src, /\{kfGen && \(\s*<GenOverlay/s);
    // Clip frame shows it whether a previous version exists or not.
    assert.match(src, /\{clipGen && \(\s*<GenOverlay/s);
  });

  it("overlay CSS centers a dimmed pill above the media", () => {
    const css = read("frontend/src/styles.css");
    assert.match(css, /\.gen-overlay \{[^}]*place-items: center/s);
    assert.match(css, /\.gen-overlay \{[^}]*pointer-events: none/s);
    assert.match(css, /\.gen-overlay-pill \{/);
  });
});
