// Master Prompt fan-out: whatever is written in Master Prompt must be
// appended to every scene (Craft scenario, Generate beat, Add beat/shot
// prefill); blank master = only the AI prompt is sent.
// Run: node --test tests/   (from the repo root; zero deps, Node >= 18)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyMasterToBeats } from "../lib/master_prompt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

describe("applyMasterToBeats", () => {
  it("appends the master to the keyframe image, never to motion", () => {
    const out = applyMasterToBeats(
      [{ title: "a", image: "a knight", motion: "walks forward" }],
      "red armor"
    );
    assert.equal(out[0].image, "a knight, red armor");
    assert.equal(out[0].motion, "walks forward");
  });

  it("blank master returns beats unchanged (AI prompt only)", () => {
    const beats = [{ title: "a", image: "img", motion: "mot" }];
    const out = applyMasterToBeats(beats, "   ");
    assert.deepEqual(out, beats);
  });

  it("empty image becomes exactly the master; motion stays empty", () => {
    const out = applyMasterToBeats([{ title: "a", image: "", motion: "" }], "red armor");
    assert.equal(out[0].image, "red armor");
    assert.equal(out[0].motion, "");
  });

  it("never double-appends when the image already carries the master", () => {
    const out = applyMasterToBeats(
      [{ title: "a", image: "a knight, red armor", motion: "walks" }],
      "red armor"
    );
    assert.equal(out[0].image, "a knight, red armor");
    assert.equal(out[0].motion, "walks");
  });

  it("does not mutate the input beats", () => {
    const beats = [{ title: "a", image: "img", motion: "mot" }];
    applyMasterToBeats(beats, "red armor");
    assert.deepEqual(beats, [{ title: "a", image: "img", motion: "mot" }]);
  });
});

describe("master prompt wiring (static)", () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

  it("craftScenario fans the master (details) out to every crafted beat", () => {
    const src = read("frontend/server.mjs");
    assert.match(src, /applyMasterToBeats\(cfg\.sequence, details\)/);
  });

  it("craftNextBeats fans the stored master (referencePrompt) out to new beats", () => {
    const src = read("frontend/server.mjs");
    assert.match(src, /applyMasterToBeats\(beats, cfg\.referencePrompt\)/);
  });

  it("manual Add beat/shot prefill the keyframe box from the stored master", () => {
    assert.match(read("frontend/src/components/ScenarioEditor.tsx"), /image: master, motion: ""/);
    assert.match(read("frontend/src/components/ShotList.tsx"), /image: master, motion: ""/);
  });

  it("Master Prompt labels carry the (Applied in All Scene) note", () => {
    for (const f of [
      "frontend/src/components/CraftPanel.tsx",
      "frontend/src/components/CreateProjectDialog.tsx",
      "frontend/src/components/EditProjectDialog.tsx",
    ]) {
      assert.match(read(f), /Master Prompt.*\(Applied in All Scene\)/, f);
    }
  });

  it("Apply to All Scene button sits between View Prompt and Craft scenario", () => {
    const src = read("frontend/src/components/CraftPanel.tsx");
    assert.ok(src.includes("Apply to All Scene"), "apply button present");
    const iView = src.indexOf("onClick={() => void openPromptPreview()}");
    const iApply = src.indexOf("onClick={() => void applyMaster()}");
    const iCraft = src.indexOf("onClick={() => void craft()}");
    assert.ok(iView !== -1 && iApply !== -1 && iCraft !== -1, "all three buttons present");
    assert.ok(iView < iApply && iApply < iCraft, "order must be View Prompt -> Apply to All Scene -> Craft scenario");
  });

  it("server exposes /api/apply-master with the shared append rules", () => {
    const src = read("frontend/server.mjs");
    assert.match(src, /\/api\/apply-master/);
    assert.match(src, /applyMasterToBeats\(cfg\.sequence, body\.master/);
  });

  it("App applies to drafts locally and saves a version for saved projects", () => {
    const src = read("frontend/src/App.tsx");
    assert.match(src, /onApplyMaster=\{applyMasterToScenes\}/);
    assert.match(src, /\/api\/apply-master/);
    assert.match(src, /saveScenario\(editor\.name/);
  });
});
