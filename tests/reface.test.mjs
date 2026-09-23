// Reface helper tests (pure logic — no insightface, no ffmpeg).
// Run: node --test tests/   (from the repo root; zero deps, Node >= 18)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newRefaceId,
  REFACE_ID_RE,
  cosineSim,
  clusterEmbeddings,
  refaceJobDir,
  readRefaceMeta,
  writeRefaceMeta,
  refaceSummary,
  refaceDetail,
} from "../lib/reface.mjs";

describe("reface ids", () => {
  it("mints rf_<time>_<hex> ids the job dir accepts", () => {
    const id = newRefaceId();
    assert.match(id, REFACE_ID_RE);
    const dir = refaceJobDir("/tmp/rf-root", id);
    assert.equal(dir, path.join("/tmp/rf-root", id));
  });
  it("rejects traversal ids", () => {
    assert.throws(() => refaceJobDir("/tmp/rf-root", "../x"), /bad reface id/);
    assert.throws(() => refaceJobDir("/tmp/rf-root", "rf_a/b_cdef12"), /bad reface id/);
  });
});

describe("cosineSim", () => {
  it("is 1 for identical vectors, 0 for orthogonal, -1 for opposite", () => {
    assert.ok(Math.abs(cosineSim([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9);
    assert.ok(Math.abs(cosineSim([1, 0], [-1, 0]) + 1) < 1e-9);
  });
  it("is 0 for mismatched/empty inputs (never NaN)", () => {
    assert.equal(cosineSim([], []), 0);
    assert.equal(cosineSim([1], [1, 2]), 0);
    assert.equal(cosineSim([0, 0], [0, 0]), 0);
  });
});

describe("clusterEmbeddings", () => {
  // Two identities: A-ish vectors cluster together, B opens its own cluster.
  const items = [
    { embedding: [1, 0, 0] },
    { embedding: [0.95, 0.05, 0] },
    { embedding: [0, 0, 1] },
    { embedding: [0.02, 0, 0.99] },
  ];
  it("groups same-identity detections, splits strangers", () => {
    const cs = clusterEmbeddings(items, 0.45);
    assert.equal(cs.length, 2);
    assert.deepEqual(cs[0].members, [0, 1]);
    assert.deepEqual(cs[1].members, [2, 3]);
  });
  it("keeps detection order stable (ids = cluster index)", () => {
    const cs = clusterEmbeddings([...items].reverse(), 0.45);
    assert.equal(cs.length, 2);
    assert.deepEqual(cs[0].members, [0, 1]); // reversed B pair first
  });
  it("centroid tracks the member mean", () => {
    const cs = clusterEmbeddings(items.slice(0, 2), 0.45);
    assert.equal(cs.length, 1);
    assert.ok(Math.abs(cs[0].centroid[0] - 0.975) < 1e-9);
  });
});

describe("reface meta IO", () => {
  it("round-trips meta and derives summary/detail", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reface-test-"));
    const id = newRefaceId();
    const dir = path.join(root, id);
    writeRefaceMeta(dir, { id, status: "analyzed", reference: "reference.png" });
    assert.equal(readRefaceMeta(dir)?.status, "analyzed");
    fs.writeFileSync(path.join(dir, "faces.json"), JSON.stringify([
      { id: "face1", thumb: "thumbs/face1.jpg", count: 12 },
    ]));
    const s = refaceSummary(dir);
    assert.equal(s.faces, 1);
    assert.equal(s.hasReference, true);
    assert.equal(s.hasResult, false);
    const d = refaceDetail(dir);
    assert.equal(d.faces[0].id, "face1");
    assert.equal(d.progress, null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("summary is null for non-job dirs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reface-test-"));
    assert.equal(refaceSummary(root), null);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
