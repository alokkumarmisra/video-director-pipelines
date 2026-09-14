// Reattach ETA tests: refreshing mid-run must not corrupt Time Remaining.
// Run: node --test tests/   (from the repo root; zero deps, Node >= 18)
//
// Background: the SSE endpoint replays pre-refresh assets on every (re)connect.
// The client used to stamp them Date.now(), fabricating one huge interval
// (reattach − run start) that blew up the ETA after every refresh — and
// poisoned the persisted pace (ss-pace-v1) for all future runs. The protocol
// now flags backlog events (replay:true); the client restores counts/gallery
// from them but records no timing, anchors intervals at reattach time, and
// reads pace from a fresh key.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("reattach ETA (static wiring)", () => {
  it("server flags SSE backlog events as replay, live events stay unflagged", () => {
    const src = read("frontend/server.mjs");
    assert.match(src, /\{\s*\.\.\.a,\s*replay:\s*true\s*\}/,
      "backlog replay must carry replay:true");
    // The live broadcast path (inside push/chunk handling) still sends the
    // raw asset — only the connect-time backlog is flagged.
    assert.match(src, /JSON\.stringify\(asset\)/,
      "live asset broadcasts must stay unflagged");
  });

  it("AssetEvent carries the optional replay flag", () => {
    const src = read("frontend/src/api.ts");
    assert.match(src, /replay\?: boolean/, "AssetEvent needs replay?: boolean");
  });

  it("RunPanel records no timing or pace for replayed events", () => {
    const src = read("frontend/src/components/RunPanel.tsx");
    // The shared handler gates every timing side-effect behind !a.replay.
    const handler = src.slice(src.indexOf("handleAssetEvent"));
    assert.ok(handler.includes("!a.replay"), "must gate on !a.replay");
    assert.ok(handler.includes("recordPaceDuration"), "must still seed pace for live events");
    assert.ok(handler.includes("setAssetTimes"), "must still track live completion times");
    assert.ok(handler.includes("setAssets"), "replayed events must still restore counts/gallery");
  });

  it("RunPanel anchors post-reattach intervals at reattach time, not run start", () => {
    const src = read("frontend/src/components/RunPanel.tsx");
    assert.match(src, /let prev = timeAnchor \?\? startedAt/,
      "interval chain must anchor at reattach time when present");
    assert.ok(src.includes("setTimeAnchor(Date.now())"),
      "both fresh and reattached tails must set the anchor");
  });

  it("persisted pace starts from a fresh key (v1 was poisoned by replay bursts)", () => {
    const src = read("frontend/src/components/GenerationProgressBar.tsx");
    assert.match(src, /PACE_KEY = "ss-pace-v2"/, "pace key must be v2");
    assert.ok(!src.includes('"ss-pace-v1"'), "no reader may use the poisoned v1 key");
  });
});
