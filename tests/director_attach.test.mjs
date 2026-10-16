// Director Generation follows foreign server runs: a run started in the
// workspace (or before a refresh) must still pulse its Keyframes → clips
// tile in the Director panel. Run: node --test tests/ (repo root, zero deps)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("director generation follows foreign runs", () => {
  it("exports a folder-first run matcher (folder authoritative, scenario fallback)", () => {
    const src = read("frontend/src/components/DirectorGeneration.tsx");
    assert.match(src, /export function foreignRunForProject\(/);
    // Latest running record wins; folder match first, display-name fallback.
    assert.match(src, /r\.status !== "running"/);
    assert.match(src, /r\.folder === folder\) \|\| \(projectName && r\.scenario === projectName\)/);
  });

  it("polls the run list while locally idle and hands matches to RunPanel", () => {
    const src = read("frontend/src/components/DirectorGeneration.tsx");
    assert.match(src, /listRuns\(\)/);
    assert.match(src, /if \(runActive\) return; \/\/ a live local run wins/);
    assert.match(src, /attachRun=\{attachRun\}/);
  });

  it("clears the attach when the foreign run leaves the running state", () => {
    const src = read("frontend/src/components/DirectorGeneration.tsx");
    assert.match(src, /if \(!match\) return prev && prev\.id \? null : prev;/);
  });

  it("resolves the active run folder rename-proof (folder first, slug fallback)", () => {
    const src = read("frontend/src/components/DirectorGeneration.tsx");
    assert.match(src, /runScenario === projectName && folder \? folder : slugFolder\(runScenario\)/);
  });
});
