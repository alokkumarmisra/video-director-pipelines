// Scene/video number badges: numeric badges (n/total, Vn/total) render
// half-size on the generating tint; REF/FINAL labels keep the dark style.
// Run: node --test tests/   (from the repo root; zero deps, Node >= 18)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("scene number badges", () => {
  it("SceneBadge marks numeric badges with scene-badge-num", () => {
    const src = read("frontend/src/components/OutputGallery.tsx");
    assert.match(src, /scene-badge-num/);
    assert.match(src, /\/\^V\?\\d\//);
  });

  it("numeric badges are large and readable on the generating (accent) tint", () => {
    const css = read("frontend/src/styles.css");
    const block = css.match(/\.scene-badge-num \{[^}]*\}/)?.[0] ?? "";
    assert.match(block, /font-size:\s*14px/);
    assert.match(block, /background:\s*var\(--accent-soft\)/);
    assert.match(block, /color:\s*var\(--accent-2\)/);
    const sm = css.match(/\.scene-badge-num\.scene-badge-sm \{[^}]*\}/)?.[0] ?? "";
    assert.match(sm, /font-size:\s*12px/);
  });

  it("shot cards show flat Beat n/N with scene/shot linkage in the header", () => {
    const src = read("frontend/src/components/OutputGallery.tsx");
    // Header text comes from beatHead(): flat `Beat n/N` (N = total beats =
    // total shots) plus `Sc S Sh s/t` linkage, so a 60-scene board with
    // 3-4 shots/scene reads Beat 7/122, not Scene 5/60.
    assert.match(src, /function beatHead\(beats/);
    assert.match(src, /return `Beat \$\{flat\}`/);
    assert.match(src, /Beat \$\{flat\} · Sc \$\{s\.scene\} Sh/);
    assert.doesNotMatch(src, /<SceneBadge scene=\{n\} total=\{total\}/);
    assert.doesNotMatch(src, /<SceneBadge scene=\{n\} total=\{liveTotal\}/);
    assert.doesNotMatch(src, /label=\{`V\$\{n\}\/\$\{total\}`\}/);
  });

  it("scene headers are compact single-row text with no status icon", () => {
    const src = read("frontend/src/components/OutputGallery.tsx");
    assert.doesNotMatch(src, /shot-head-status/);
    assert.doesNotMatch(src, /shot-head-pending/);
    const css = read("frontend/src/styles.css");
    const head = css.match(/\.shot-head \{[^}]*\}/)?.[0] ?? "";
    assert.match(head, /font:\s*700 11px/);
    assert.match(head, /white-space:\s*nowrap/);
    assert.match(head, /background:\s*var\(--accent-soft\)/);
  });

  it("only the generating scene card goes red (rest stay green)", () => {
    const src = read("frontend/src/components/OutputGallery.tsx");
    assert.match(src, /`shot\$\{\(kfGen \|\| clipGen\) \? " generating" : ""\}/);
    const css = read("frontend/src/styles.css");
    const genHead = css.match(/\.shot\.generating \.shot-head \{[^}]*\}/)?.[0] ?? "";
    assert.match(genHead, /background:\s*linear-gradient\(100deg, #450a0a, #7f1d1d/);
    assert.match(css, /\.shot\.generating \.video-frame,[\s\S]*?\.shot\.generating \.shot-clip-frame \{[^}]*animation:\s*genGlow/);
  });

  it("wrapped pending labels (e.g. Video 123 · pending) stay centered", () => {
    const css = read("frontend/src/styles.css");
    const inner = css.match(/\.frame-missing-inner \{[^}]*\}/)?.[0] ?? "";
    assert.match(inner, /text-align:\s*center/);
    const thumb = css.match(/\.shotlist-thumb-pending \{[^}]*\}/)?.[0] ?? "";
    assert.match(thumb, /text-align:\s*center/);
  });
});
