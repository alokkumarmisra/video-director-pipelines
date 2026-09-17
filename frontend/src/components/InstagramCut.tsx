import { useEffect, useRef, useState } from "react";
import { cutReel, listOutputs, outputUrl, outScenario, type Engine } from "../api";
import type { MainsInfo, VersionsInfo } from "../types";
import { IconClapper, IconFilm, IconImage, IconPanel, IconPlay, Spinner } from "./Icons";
import Lightbox, { type PreviewItem } from "./Lightbox";
import SmoothImage from "./SmoothImage";
import { SceneBadge, ExpandButton } from "./OutputGallery";
import Collapse from "./Collapse";

interface Props {
  /** Storage folder ("" when nothing selected / unsaved draft) — dirs only. */
  scenario: string;
  engine: Engine;
  refreshKey: number;
  /** Total beats from the scenario config (for the n/total progress line). */
  totalScenes: number | null;
  /** True while ANY run is active (the ComfyUI queue is serial). */
  runBusy: boolean;
  /** True while a vertical Reel run for this scenario+engine is active. */
  verticalGenerating: boolean;
  /** Start (or resume) the vertical Reel run. */
  onCreate: () => void;
}

const empty = { files: [] as string[], versions: { ref: [], beats: {}, final: [] } as VersionsInfo, mains: { ref: null, beats: {} } as MainsInfo };

type ReelChoice = "entire" | "30" | "60" | "90";

const CUT_KEY = (d: string) => `ss-reel-cut:${d}`;
const CUTFROM_KEY = (d: string) => `ss-reel-cut-from:${d}`;

// Trimmed short file for N seconds, if one is on disk.
const reelFileFor = (files: string[], seconds: number) =>
  files.filter((f) => f.endsWith(`_reel_${seconds}s.mp4`)).sort().pop() ?? null;

const fmtDur = (s: number | null): string => {
  if (s == null || !Number.isFinite(s)) return "";
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

// Instagram Reel cut (9:16): fresh vertical images + clips generated from the
// same beats into outputs/<folder>[_wan]_vertical/. The main (landscape)
// video is never touched. The run is resumable — assets already on disk are
// skipped — so re-clicking after a partial run continues where it stopped.
export default function InstagramCut({ scenario, engine, refreshKey, totalScenes, runBusy, verticalGenerating, onCreate }: Props) {
  const [mainFinal, setMainFinal] = useState<string | null>(null);
  const [vVersions, setVVersions] = useState<VersionsInfo>({ ref: [], beats: {}, final: [] });
  const [vMains, setVMains] = useState<MainsInfo>({ ref: null, beats: {}, final: null });
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  // Short-cut picker: Entire video (the full final, nothing written) or a
  // 30/60/90s trim of it, cut on select and played in the panel below.
  // The choice persists per output dir; the trimmed file is
  // <prefix>_reel_<N>s.mp4 next to the final (re-cutting overwrites it).
  const [vFiles, setVFiles] = useState<string[]>([]);
  const [choice, setChoice] = useState<ReelChoice>("entire");
  const [cutFile, setCutFile] = useState<string | null>(null);
  const [cutFrom, setCutFrom] = useState<string | null>(null);
  const [cutDur, setCutDur] = useState<number | null>(null);
  const [cutSrcDur, setCutSrcDur] = useState<number | null>(null);
  const [cutBusy, setCutBusy] = useState(false);
  const [cutError, setCutError] = useState("");
  const cutBusyRef = useRef(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-reel") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-reel", c ? "open" : "closed");
      return !c;
    });

  const mainDir = scenario ? outScenario(scenario, engine) : "";
  const vDir = scenario ? outScenario(scenario, engine, "vertical") : "";

  // Derived listing values — computed before the effects below use them
  // (vFinal drives the short-cut sync effect).
  const beatNums = Object.keys(vVersions.beats || {}).map(Number).sort((a, b) => a - b);
  const total = totalScenes ?? (beatNums.length || null);
  let kfDone = 0;
  let clipDone = 0;
  for (const n of beatNums) {
    if (vMains.beats[String(n)]?.keyframe) kfDone += 1;
    if (vMains.beats[String(n)]?.clip) clipDone += 1;
  }
  const vFinals = [...(vVersions.final ?? [])].sort((a, b) => a.v - b.v);
  const vFinal = vMains.final || vFinals[vFinals.length - 1]?.file || null;
  const hasVertical = kfDone > 0 || clipDone > 0 || !!vFinal || (vVersions.ref?.length ?? 0) > 0;
  // Latest vertical assets (highest scene with a main file) — all three
  // render side by side in one row below.
  let curKf: string | null = null;
  let curClip: string | null = null;
  for (const n of beatNums) {
    const kf = vMains.beats[String(n)]?.keyframe;
    if (kf) curKf = kf;
    const cl = vMains.beats[String(n)]?.clip;
    if (cl) curClip = cl;
  }
  const canCreate = !!scenario && !!mainFinal && !runBusy;

  // Never show another project/engine dir's renders: the moment the viewed
  // dirs change, blank the listing until the new one lands (same-dir
  // refreshes keep their data).
  const dirsRef = useRef("");
  useEffect(() => {
    if (!scenario) {
      setMainFinal(null);
      setVVersions({ ref: [], beats: {}, final: [] });
      setVMains({ ref: null, beats: {}, final: null });
      setVFiles([]);
      dirsRef.current = "";
      return;
    }
    const dirsKey = `${mainDir}|${vDir}`;
    if (dirsRef.current !== dirsKey) {
      dirsRef.current = dirsKey;
      setMainFinal(null);
      setVVersions({ ref: [], beats: {}, final: [] });
      setVMains({ ref: null, beats: {}, final: null });
      setVFiles([]);
    }
    let cancelled = false;
    (async () => {
      try {
        const [main, vert] = await Promise.all([listOutputs(mainDir), listOutputs(vDir)]);
        if (cancelled) return;
        setMainFinal(main.mains?.final ?? null);
        setVVersions(vert.versions ?? { ref: [], beats: {}, final: [] });
        setVMains(vert.mains ?? { ref: null, beats: {}, final: null });
        setVFiles(vert.files ?? []);
      } catch {
        // A failed background refresh keeps the previous listing.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, mainDir, vDir, refreshKey]);

  // Reload the persisted short-cut choice when switching dirs/engines.
  useEffect(() => {
    const c = localStorage.getItem(CUT_KEY(vDir));
    setChoice(c === "30" || c === "60" || c === "90" ? c : "entire");
    setCutFile(null);
    setCutFrom(localStorage.getItem(CUTFROM_KEY(vDir)));
    setCutDur(null);
    setCutSrcDur(null);
    setCutError("");
  }, [vDir]);

  // Keep the short cut in sync: reuse the on-disk trim when it was cut from
  // the current final, otherwise (re-)cut via the server (stream copy —
  // fast, lossless). A fresh final auto-refreshes the short.
  useEffect(() => {
    if (!vDir || choice === "entire" || !vFinal || cutBusyRef.current) return;
    const seconds = Number(choice);
    if (cutFile && cutFrom === vFinal) return;
    const existing = reelFileFor(vFiles, seconds);
    if (existing && localStorage.getItem(CUTFROM_KEY(vDir)) === vFinal) {
      setCutFile(existing);
      setCutFrom(vFinal);
      return;
    }
    cutBusyRef.current = true;
    setCutBusy(true);
    setCutError("");
    cutReel(vDir, seconds as 30 | 60 | 90).then((r) => {
      setCutFile(r.file);
      setCutFrom(vFinal);
      setCutDur(r.duration ?? null);
      setCutSrcDur(r.fromDuration ?? null);
      try { localStorage.setItem(CUTFROM_KEY(vDir), vFinal); } catch { /* ignore */ }
    }).catch((e) => {
      setCutError(e instanceof Error ? e.message : String(e));
    }).finally(() => {
      cutBusyRef.current = false;
      setCutBusy(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vDir, vFinal, choice, vFiles, cutFile, cutFrom]);

  const choose = (c: ReelChoice) => {
    setChoice(c);
    try { localStorage.setItem(CUT_KEY(vDir), c); } catch { /* ignore */ }
    setCutError("");
    setCutDur(null);
    setCutSrcDur(null);
    // Clearing forces the sync effect above to reuse or re-cut; Entire
    // needs nothing (the full final is already playing in this panel).
    setCutFile(null);
    if (c === "entire") setCutFrom(null);
  };

  if (!scenario) return null;

  return (
    <section className={`card reel-card${collapsed ? " collapsed" : ""}`} aria-label="Instagram Reel">
      <div className="card-head">
        <h2>
          <span className="head-icon hi-beats"><IconClapper size={15} /></span>
          Instagram Reel · 9:16
        </h2>
        <span className="spacer" />
        {verticalGenerating && (
          <span className="pill running" title="A vertical Reel run is generating right now">
            <span className="dot pulse" /> generating…
          </span>
        )}
        <button
          className="primary"
          onClick={onCreate}
          disabled={!canCreate}
          title={
            !mainFinal
              ? "Generate the main video first — the Reel is cut after the main final cut lands"
              : runBusy
                ? "A run is already active — the Reel queues right after it finishes"
                : hasVertical
                  ? "Regenerate the 9:16 cut — existing vertical assets are kept, missing ones resume"
                  : "Generate a fresh 9:16 cut — new vertical images + clips from the same beats"
          }
        >
          {verticalGenerating ? <Spinner size={12} /> : <IconPlay size={12} />}
          {verticalGenerating ? "Generating…" : hasVertical ? "Regenerate Instagram video" : "Create Instagram video"}
        </button>
        <button
          className="icon-btn"
          onClick={toggleCollapsed}
          title={collapsed ? "Show Instagram Reel" : "Hide Instagram Reel"}
          aria-label={collapsed ? "Show Instagram Reel" : "Hide Instagram Reel"}
          aria-expanded={!collapsed}
        >
          <IconPanel size={15} />
        </button>
      </div>

      <Collapse open={!collapsed}>
          {preview && <Lightbox item={preview} onClose={() => setPreview(null)} />}
          {!mainFinal && (
            <p className="hint">
              Finish the main video first — the <b>Create Instagram video</b> button unlocks once the main
              final cut lands in <span style={{ fontFamily: "var(--mono)" }}>outputs/{mainDir}/</span>.
            </p>
          )}
          {mainFinal && !hasVertical && !verticalGenerating && (
            <p className="hint">
              Ready — this creates <b>new 9:16 images + clips</b> from the same beats
              into <span style={{ fontFamily: "var(--mono)" }}>outputs/{vDir}/</span>. The main video is untouched.
            </p>
          )}
          {(hasVertical || verticalGenerating) && (
            <>
              <div className="section-label">
                Vertical scenes + final cut
                {total != null && total > 0 && (
                  <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>
                    {" "}· {kfDone}/{total} images · {clipDone}/{total} clips
                  </span>
                )}
                {verticalGenerating && (
                  <span className="gen-flag" title="Regenerating the vertical cut from the same beats">
                    <span className="dot pulse" /> generating
                  </span>
                )}
              </div>
              <div className="grid reel-split">
                <div className="reel-side">
                <div className="img-frame" title="Latest vertical keyframe image">
                  <SceneBadge label="9:16" title="Vertical keyframe image" />
                  {curKf ? (
                    <>
                      <ExpandButton title="Fullscreen preview of vertical keyframe" onOpen={() => setPreview({ src: outputUrl(vDir, curKf!), kind: "image", alt: "vertical keyframe" })} />
                      <SmoothImage
                        src={outputUrl(vDir, curKf)}
                        alt="vertical keyframe"
                        onClick={() => setPreview({ src: outputUrl(vDir, curKf!), kind: "image", alt: "vertical keyframe" })}
                      />
                    </>
                  ) : (
                    <div className="frame-missing">
                      {verticalGenerating
                        ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
                        : <span className="frame-missing-inner"><IconImage size={16} /><span className="muted">pending</span></span>}
                    </div>
                  )}
                </div>
                <div className="video-frame" title="Latest vertical clip">
                  <SceneBadge small label="REEL" title="Vertical clip" />
                  {curClip ? (
                    <>
                      <ExpandButton title="Fullscreen preview of vertical clip" onOpen={() => setPreview({ src: outputUrl(vDir, curClip!), kind: "video", alt: "vertical clip" })} />
                      <video controls preload="metadata" src={outputUrl(vDir, curClip)} />
                    </>
                  ) : (
                    <div className="frame-missing">
                      {verticalGenerating
                        ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
                        : <span className="frame-missing-inner"><IconFilm size={16} /><span className="muted">pending</span></span>}
                    </div>
                  )}
                </div>
                </div>
                <div className="video-frame reel-final" title="Vertical final cut">
                  <SceneBadge label="FINAL" title="Stitched vertical final cut" />
                  {vFinal ? (
                    <>
                      <ExpandButton title="Fullscreen preview of vertical final cut" onOpen={() => setPreview({ src: `${outputUrl(vDir, vFinal!)}?v=${encodeURIComponent(vFinal!)}`, kind: "video", alt: "vertical final cut" })} />
                      <video
                        key={vFinal}
                        controls
                        preload="metadata"
                        src={`${outputUrl(vDir, vFinal)}?v=${encodeURIComponent(vFinal)}`}
                      />
                    </>
                  ) : (
                    <div className="frame-missing">
                      {verticalGenerating
                        ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
                        : <span className="frame-missing-inner"><IconFilm size={16} /><span className="muted">pending</span></span>}
                    </div>
                  )}
                </div>
              </div>
              <div className="row reel-cut-row">
                <label htmlFor="reel-cut-choice">Short version</label>
                <select
                  id="reel-cut-choice"
                  value={choice}
                  disabled={!vFinal || cutBusy}
                  onChange={(e) => choose(e.target.value as ReelChoice)}
                  title={vFinal
                    ? "Cut the final video down to a short for Reels/Shorts — Entire keeps the full video"
                    : "Create the Instagram video first — the short is cut from its final cut"}
                >
                  <option value="entire">Entire video</option>
                  <option value="30">30 seconds</option>
                  <option value="60">60 seconds</option>
                  <option value="90">90 seconds</option>
                </select>
                {cutBusy && <Spinner size={12} />}
                {!vFinal && <span className="muted upload-hint">Create the Instagram video first</span>}
              </div>
              {cutError && <p className="hint err-text">{cutError}</p>}
              {choice !== "entire" && (cutFile || cutBusy) && (
                <>
                  <div className="section-label">
                    Short cut
                    {cutDur != null && (
                      <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>
                        {" "}· {fmtDur(cutDur)}{cutSrcDur != null && cutSrcDur > cutDur ? ` of ${fmtDur(cutSrcDur)}` : ""}
                      </span>
                    )}
                    {cutBusy && (
                      <span className="gen-flag" title="Trimming the short version">
                        <span className="dot pulse" /> cutting
                      </span>
                    )}
                  </div>
                  <div className="video-frame reel-final" title={cutFile ? `Short cut — ${cutFile}` : "Short cut"}>
                    <SceneBadge label="SHORT" title="Trimmed short version for Reels/Shorts" />
                    {cutFile ? (
                      <>
                        <ExpandButton title="Fullscreen preview of short cut" onOpen={() => setPreview({ src: `${outputUrl(vDir, cutFile!)}?v=${encodeURIComponent(cutFile!)}`, kind: "video", alt: "short cut" })} />
                        <video
                          key={cutFile}
                          controls
                          preload="metadata"
                          src={`${outputUrl(vDir, cutFile)}?v=${encodeURIComponent(cutFile)}`}
                        />
                      </>
                    ) : (
                      <div className="frame-missing">
                        <span className="gen-flag"><span className="dot pulse" /> cutting…</span>
                      </div>
                    )}
                  </div>
                </>
              )}
              <p className="hint">
                Vertical assets are versioned like the main cut — re-running resumes missing scenes and stitches a new final.
                Uses the same engine ({engine === "wan" ? "Wan 2.1" : "LTX 2.5"}) as the main view.
                Every vertical scene browses above (Reference, Story Board, Keyframes → clips all follow this cut).
              </p>
            </>
          )}
      </Collapse>
    </section>
  );
}
