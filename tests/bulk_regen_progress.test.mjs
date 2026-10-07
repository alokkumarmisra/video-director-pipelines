// Bulk-regen progress tests: Regenerate (5 / 10 / all scenes) queues one
// single-asset run per checked scene, so the progress bar + Time Remaining
// must cover the whole batch — not just the one asset rendering right now
// (full Generate already does this via its 1 + 2N totals).
// Run: node --test tests/bulk_regen_progress.test.mjs (repo root; zero deps)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("bulk-regen progress covers the whole batch", () => {
  it("RunPanel accepts the waiting queue and folds it into the totals", () => {
    const src = read("frontend/src/components/RunPanel.tsx");
    assert.match(src, /runQueue\?: RunRequest\[\]/);
    assert.match(src, /queuedTaskCounts\(runQueue, N, dlgBeats\)/);
    assert.match(src, /imagesTotal \+= queued\.images/);
    assert.match(src, /videosTotal \+= queued\.videos/);
  });

  it("queued keyframe/clip/ref/stitch runs each count their task kind", () => {
    const src = read("frontend/src/components/RunPanel.tsx");
    assert.match(src, /regen\.kind === "keyframe"/);
    assert.match(src, /out\.images \+= 1/);
    assert.match(src, /out\.videos \+= 1/);
    assert.match(src, /q\.stitch/);
  });

  it("finished batch work is banked so the bar climbs monotonically", () => {
    const src = read("frontend/src/components/RunPanel.tsx");
    assert.match(src, /bankRef/);
    assert.match(src, /bankedForRun/);
    // Banked counts fold into the display totals/completions…
    assert.match(src, /total \+= bank\.done/);
    assert.match(src, /completed \+= bank\.done/);
    // …and clear when the batch drains fully.
    assert.match(src, /bankRef\.current = null/);
  });

  it("a landed final mid-batch does not flash 100% early", () => {
    const src = read("frontend/src/components/RunPanel.tsx");
    assert.match(src, /if \(hasFinal && \(runQueue\?\.length \?\? 0\) === 0 && !bankRef\.current\) pct = 100/);
  });

  it("single-asset regen STEP uses batch totals, not a hardcoded /1", () => {
    const src = read("frontend/src/components/RenderMonitor.tsx");
    assert.doesNotMatch(src, /\$\{progress\.imagesDone\}\/1/);
    assert.doesNotMatch(src, /\$\{progress\.videosDone\}\/1/);
    assert.match(src, /progress\.imagesDone\}\/\$\{Math\.max\(1, progress\.imagesTotal\)\}/);
    assert.match(src, /progress\.videosDone\}\/\$\{Math\.max\(1, progress\.videosTotal\)\}/);
  });

  it("workspace + Director generation both feed their queue into RunPanel", () => {
    assert.match(read("frontend/src/App.tsx"), /runQueue=\{runQueue\}/);
    assert.match(
      read("frontend/src/components/DirectorGeneration.tsx"),
      /runQueue=\{runQueue\}/
    );
  });
});
