// Predefined AI Video Preset system tests (spec §18).
// Run: node --test tests/   (from the repo root; zero deps, Node >= 18)
// Covers: preset discovery (42 registered .md files, structure, containment),
// selection (valid ids, unknown/missing -> default), loading (correct file,
// invalid ids rejected, no arbitrary path reads, missing file -> clear
// error), prompt combination order, plus static checks that the server
// exposes the API + injects the preset at craft time (with per-project
// presetRules overrides) and that the UI offers grouped selection with
// per-project editable rules (system presets never modified).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const presets = await import("../lib/presets.mjs");
const {
  DEFAULT_PRESET_ID,
  GetAvailablePresets,
  GetPresetById,
  GetPresetContent,
  resolvePresetId,
  isValidPresetId,
  buildPrompt,
} = presets;

describe("preset discovery", () => {
  it("registers all 42 presets with unique ids and display metadata", () => {
    const all = GetAvailablePresets();
    assert.equal(all.length, 42);
    const ids = all.map((p) => p.id);
    assert.equal(new Set(ids).size, 42);
    for (const p of all) {
      assert.ok(p.id && p.name && p.category && p.description, JSON.stringify(p));
      assert.match(p.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      // Display names are humanized, not filenames.
      assert.ok(!p.name.endsWith(".md"), p.name);
    }
  });

  it("uses proper display names for tricky files", () => {
    const byId = Object.fromEntries(GetAvailablePresets().map((p) => [p.id, p.name]));
    assert.equal(byId["3d-animation"], "3D Animation");
    assert.equal(byId["silent-movie"], "Silent Movie");
    assert.equal(byId["abc-learning"], "ABC Learning");
    assert.equal(byId["youtube-kids"], "YouTube Kids");
    assert.equal(byId["sci-fi"], "Sci-Fi");
    assert.equal(byId["fairy-tale"], "Fairy Tale");
  });

  it("groups cover all seven documented categories", () => {
    const cats = new Set(GetAvailablePresets().map((p) => p.category));
    for (const c of ["General", "Story & Genre", "Culture", "Kids & Education", "Music", "Real World", "Platform"])
      assert.ok(cats.has(c), `missing category ${c}`);
  });

  it("every registered filePath exists, stays inside presets/, and follows the file structure", () => {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, "presets", "presets.json"), "utf8"));
    const dir = path.join(ROOT, "presets");
    for (const p of reg) {
      // Registry paths are repo-root-relative ("presets/kids/kids.md").
      const full = path.normalize(path.join(ROOT, p.filePath));
      assert.ok(full === dir || full.startsWith(dir + path.sep), `escapes presets/: ${p.filePath}`);
      assert.ok(fs.existsSync(full), `missing file: ${p.filePath}`);
      const text = fs.readFileSync(full, "utf8");
      assert.ok(text.trim().length > 0, `empty: ${p.filePath}`);
      for (const h of ["## Purpose", "## Visual Style", "## Continuity", "## Avoid"])
        assert.ok(text.includes(h), `${p.filePath} missing ${h}`);
    }
  });
});

describe("preset selection", () => {
  it("default is cinematic", () => {
    assert.equal(DEFAULT_PRESET_ID, "cinematic");
    assert.ok(GetPresetById("cinematic"));
  });

  it("valid ids resolve, unknown/missing/malformed fall back to default", () => {
    assert.equal(resolvePresetId("kids"), "kids");
    assert.equal(resolvePresetId("youtube-shorts"), "youtube-shorts");
    assert.equal(resolvePresetId("nope"), "cinematic");
    assert.equal(resolvePresetId(undefined), "cinematic");
    assert.equal(resolvePresetId(null), "cinematic");
    assert.equal(resolvePresetId(""), "cinematic");
    assert.equal(resolvePresetId("../../x"), "cinematic");
  });

  it("GetPresetById returns null for anything unregistered", () => {
    assert.equal(GetPresetById("nope"), null);
    assert.equal(GetPresetById("../../package"), null);
    assert.equal(GetPresetById("/abs/path"), null);
    assert.equal(GetPresetById("KIDS"), null);
  });
});

describe("preset loading", () => {
  it("loads the correct .md file for an id", () => {
    const { meta, content } = GetPresetContent("kids");
    assert.equal(meta.id, "kids");
    assert.ok(content.includes("# Kids Video Preset"));
  });

  it("rejects traversal and arbitrary paths without touching the fs", () => {
    for (const evil of ["../../package", "..", "../lib/comfy.mjs", "/etc/passwd", "kids/../../x", "", "a/b", "KIDS "]) {
      assert.equal(isValidPresetId(evil), false, `shape must reject: ${evil}`);
      assert.throws(() => GetPresetContent(evil), /Invalid preset selected\./);
    }
    // Unknown-but-wellformed ids are equally rejected (never read from disk).
    assert.throws(() => GetPresetContent("nope"), /Invalid preset selected\./);
  });

  it("missing preset file -> clear error, no crash (fixture registry)", async () => {
    // Fixture mirrors the real layout: <tmp>/presets/presets.json + .md,
    // with repo-root-relative filePaths ("presets/ok.md"). PRESETS_ROOT is
    // read at module load, so the fixture runs in a child process with a
    // fresh import (the parent already cached the real registry).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presets-"));
    fs.mkdirSync(path.join(tmp, "presets"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "presets", "ok.md"), "# ok\n\n## Purpose\nx\n");
    fs.writeFileSync(path.join(tmp, "presets", "presets.json"), JSON.stringify([
      { id: "ok", name: "Ok", category: "General", description: "ok", filePath: "presets/ok.md" },
      { id: "gone", name: "Gone", category: "General", description: "gone", filePath: "presets/gone.md" },
    ]));
    const { execFileSync } = await import("node:child_process");
    const libUrl = pathToFileURL(path.join(ROOT, "lib", "presets.mjs")).href;
    const script = `
      const m = await import(${JSON.stringify(libUrl)});
      import assert from "node:assert/strict";
      assert.equal(m.GetAvailablePresets().length, 2);
      assert.ok(m.GetPresetContent("ok").content.includes("# ok"));
      assert.throws(() => m.GetPresetContent("gone"), /unavailable.*missing/);
      assert.equal(m.resolvePresetId("gone"), "gone");
      console.log("FIXTURE_OK");
    `;
    try {
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, PRESETS_ROOT: tmp },
        encoding: "utf8",
      });
      assert.ok(out.includes("FIXTURE_OK"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("prompt generation", () => {
  it("combines preset + master + scene in priority order", () => {
    const out = buildPrompt({ presetContent: "PRESET", masterPrompt: "MASTER", scenePrompt: "SCENE" });
    const iP = out.indexOf("PRESET"), iM = out.indexOf("MASTER"), iS = out.indexOf("SCENE");
    assert.ok(iP >= 0 && iM >= 0 && iS >= 0);
    assert.ok(iP < iM && iM < iS, "priority must be preset -> master -> scene");
  });

  it("skips empty layers without leaking 'undefined'", () => {
    assert.equal(buildPrompt({ scenePrompt: "S" }), "Scene content:\nS");
    assert.equal(buildPrompt({}), "");
    assert.ok(!buildPrompt({}).includes("undefined"));
  });
});

describe("server + UI wiring (static)", () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, "frontend", "server.mjs"), "utf8");

    it("server exposes GET /api/presets and GET /api/presets/:id via the registry service", () => {
      assert.ok(serverSrc.includes('"/api/presets"'), "list route missing");
      assert.ok(serverSrc.includes('"/api/presets/"'), "detail route missing");
      assert.ok(serverSrc.includes("GetPresetContent"), "must resolve through PresetService");
      assert.ok(serverSrc.includes("resolvePresetId"), "must sanitize ids through PresetService");
    });

    it("folder resolution reuses a row-less scenario's own dir (no _N scatter)", () => {
      // Regression: every row-less run minted +1 because a merely-existing
      // dir counted as taken, scattering one project's assets across
      // minku_story_2_2, _3, … and emptying its gallery. migrateProjectStorage
      // must reuse the slug dir when absent or prefix-owned, and mint only on
      // genuinely foreign collisions.
      assert.ok(serverSrc.includes("prefixForDir(base)"), "must check prefix ownership");
      assert.match(serverSrc, /startsWith\(`\$\{prefix\}_`\)/, "must match own files by prefix");
      assert.ok(serverSrc.includes("ensureUniqueFolder(displayName, displayName)"), "foreign collisions must still mint");
    });

  it("server never reads preset files from client-supplied paths", () => {
    // The only fs reads of preset content go through GetPresetContent(id).
    assert.ok(!/readFileSync\(\s*`?[^`]*\$\{\s*body/.test(serverSrc), "client body must never build a file path");
  });

  it("craft + craft-beat inject the preset and persist only the id (+ optional per-project rules)", () => {
    assert.ok(serverSrc.includes("cfg.presetId = preset"), "crafted config must carry presetId");
    assert.ok(serverSrc.includes("Visual language"), "preset must enter the LLM prompt");
    assert.ok(serverSrc.includes("craftNextBeat(cur, presetContent)"), "beat extension must inherit the preset");
    // Per-project customization: presetRules replaces the preset file content
    // for that project only (never writes presets/*.md).
    assert.ok(serverSrc.includes("presetRules"), "server must support per-project presetRules overrides");
    assert.ok(!/writeFileSync\([^)]*presets/i.test(serverSrc), "server must never write preset files");
  });

  it("craft user prompt concatenates Description, then Master prompt, then preset rules", () => {
    // The LM Studio user message must carry the brief in this order:
    // Description first, Master prompt second, preset rules appended last.
    const iD = serverSrc.indexOf("Description: ${idea}");
    const iM = serverSrc.indexOf("Master prompt / visual direction:");
    const iP = serverSrc.indexOf('Video-type rules (preset');
    assert.ok(iD > 0 && iM > 0 && iP > 0, "craft user prompt must contain all three blocks");
    assert.ok(iD < iM && iM < iP, "order must be Description -> Master prompt -> preset rules");
  });

  it("scenario save path does not strip presetId", () => {
    const putIdx = serverSrc.indexOf('req.method === "PUT"');
    assert.ok(putIdx > 0);
    const putBlock = serverSrc.slice(putIdx, putIdx + 800);
    assert.ok(!putBlock.includes("presetId"), "PUT must not delete presetId");
  });

  it("PresetSelect is grouped with per-project editable rules preview", () => {
    const raw = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "PresetSelect.tsx"), "utf8");
    // Strip comments: policy words ("delete", ...) may appear in prose, but
    // never as code (no global preset management controls may exist).
    const ui = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(ui.includes("<optgroup"), "must group options by category");
    assert.ok(ui.includes("View / edit rules"), "must offer an editable rules panel");
    assert.ok(ui.includes("<textarea"), "rules must be editable per project");
    assert.ok(ui.includes("Reset to preset default"), "must offer reset to the preset default");
    assert.ok(ui.includes("presetRules") || ui.includes("customRules"), "edits must flow as a per-project override");
    assert.ok(!/\b(deletePreset|uploadPreset|renamePreset|createPreset)\b/i.test(ui), "no global preset management controls allowed");
  });

  it("create + craft screens use the shared dropdown and persist the id", () => {
    const create = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "CreateProjectDialog.tsx"), "utf8");
    const craft = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "CraftPanel.tsx"), "utf8");
    for (const [name, src] of [["CreateProjectDialog", create], ["CraftPanel", craft]]) {
      assert.ok(src.includes("PresetSelect"), `${name} must render the preset dropdown`);
      assert.ok(src.includes("presetId"), `${name} must persist presetId`);
    }
    assert.ok(craft.includes("presetId,"), "craft request must send presetId to /api/craft");
  });
});
