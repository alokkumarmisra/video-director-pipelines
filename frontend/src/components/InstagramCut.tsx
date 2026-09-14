import { useEffect, useState } from "react";
import { listOutputs, outputUrl, outScenario, type Engine } from "../api";
import type { MainsInfo, VersionsInfo } from "../types";
import { IconClapper, IconFilm, IconImage, IconPanel, IconPlay, Spinner } from "./Icons";
import Lightbox, { type PreviewItem } from "./Lightbox";
import SmoothImage from "./SmoothImage";
import { SceneBadge } from "./OutputGallery";

interface Props {
  /** Base scenario name ("" when nothing selected / unsaved draft). */
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

// Instagram Reel cut (9:16): fresh vertical images + clips generated from the
// same beats into outputs/<scenario>[_wan]_vertical/. The main (landscape)
// video is never touched. The run is resumable — assets already on disk are
// skipped — so re-clicking after a partial run continues where it stopped.
export default function InstagramCut({ scenario, engine, refreshKey, totalScenes, runBusy, verticalGenerating, onCreate }: Props) {
  const [mainFinal, setMainFinal] = useState<string | null>(null);
  const [vVersions, setVVersions] = useState<VersionsInfo>({ ref: [], beats: {}, final: [] });
  const [vMains, setVMains] = useState<MainsInfo>({ ref: null, beats: {}, final: null });
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-reel") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-reel", c ? "open" : "closed");
      return !c;
    });

  const mainDir = scenario ? outScenario(scenario, engine) : "";
  const vDir = scenario ? outScenario(scenario, engine, "vertical") : "";

  useEffect(() => {
    if (!scenario) {
      setMainFinal(null);
      setVVersions({ ref: [], beats: {}, final: [] });
      setVMains({ ref: null, beats: {}, final: null });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [main, vert] = await Promise.all([listOutputs(mainDir), listOutputs(vDir)]);
        if (cancelled) return;
        setMainFinal(main.mains?.final ?? null);
        setVVersions(vert.versions ?? { ref: [], beats: {}, final: [] });
        setVMains(vert.mains ?? { ref: null, beats: {}, final: null });
      } catch {
        // A failed background refresh keeps the previous listing.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, mainDir, vDir, refreshKey]);

  if (!scenario) return null;

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

      {!(collapsed) && (
        <>
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
                    <SmoothImage
                      src={outputUrl(vDir, curKf)}
                      alt="vertical keyframe"
                      onClick={() => setPreview({ src: outputUrl(vDir, curKf!), kind: "image", alt: "vertical keyframe" })}
                    />
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
                    <video controls preload="metadata" src={outputUrl(vDir, curClip)} />
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
                    <video
                      key={vFinal}
                      controls
                      preload="metadata"
                      src={`${outputUrl(vDir, vFinal)}?v=${encodeURIComponent(vFinal)}`}
                    />
                  ) : (
                    <div className="frame-missing">
                      {verticalGenerating
                        ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
                        : <span className="frame-missing-inner"><IconFilm size={16} /><span className="muted">pending</span></span>}
                    </div>
                  )}
                </div>
              </div>
              <p className="hint">
                Vertical assets are versioned like the main cut — re-running resumes missing scenes and stitches a new final.
                Uses the same engine ({engine === "wan" ? "Wan 2.1" : "LTX 2.5"}) as the main view.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
