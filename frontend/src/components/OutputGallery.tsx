import { useEffect, useRef, useState, type ReactNode } from "react";
import { listOutputs, outputUrl, selectMain, uploadRef, isVerticalOut, type AssetEvent, type RunRequest, type VideoFormat } from "../api";
import type { AssetVersion, MainsInfo, VersionsInfo, AssetKind } from "../types";
import type { GenerationProgress } from "./GenerationProgressBar";
import { formatLiveElapsed } from "./GenerationProgressBar";
import { IconClapper, IconFilm, IconImage, IconPanel, IconRefresh, IconScissors, IconCheck, IconUpload, IconClipboard, IconX, IconExpand, IconEdit, Spinner } from "./Icons";
import Lightbox, { type PreviewItem } from "./Lightbox";
import SmoothImage from "./SmoothImage";
import Collapse from "./Collapse";

interface Props {
  scenario: string;
  refreshKey: number; // bump to re-list files
  assets?: AssetEvent[]; // live: assets finished so far in the current run
  bare?: boolean; // render without the outer card (for nesting in RunPanel)
  generatingScenario?: string | null; // output dir of the scenario currently being generated
  // Cut the active run generates (null = unknown/landscape). A vertical Reel
  // run must not light up "generating" chips on the landscape cards.
  generatingFormat?: VideoFormat | null;
  // Which sections to render: everything, only Reference (embedded in the
  // Scenario Editor under Generate Reference), only the Output card (final
  // cut), or only the Keyframes → clips card. The workspace renders Output +
  // Keyframes as two separate cards, each with its own hide/show toggle.
  section?: "all" | "reference" | "output" | "beats";
  // Total scene (beat) count for the "n/total" overlay in the live view.
  // The static view derives it from its versioned beats; the live view only
  // sees finished assets so the caller (RunPanel) passes the real total from
  // the scenario config. Falls back to the highest seen beat index.
  totalScenes?: number | null;
  regenTarget?: { kind: AssetKind; index?: number } | null; // exact asset a regen run is producing
  // Requests waiting behind the active run — matching regen chips read
  // "queued" and stay clickable instead of locking like before.
  runQueue?: RunRequest[];
  onStitch?: () => void; // ask the run panel to re-stitch the final cut
  onRegen?: (kind: AssetKind, index: number | null) => void;
  onUploaded?: () => void; // a ref upload landed — ask the app to re-list outputs
  // Called by the "view other engine's outputs" button (shown when this
  // engine dir is empty but the sibling engine dir has renders).
  onEngineSwitch?: () => void;
  /** Live run progress — the in-flight keyframe/clip tile shows its
      estimated ~% (RunPanel). Absent = indeterminate shimmer only. */
  progress?: GenerationProgress | null;
  /** Jump to Scene n in the Scenario Editor (App scrolls + flashes the
      matching beat). Absent = no Edit button on the scene cards. */
  onGotoEditorScene?: (n: number) => void;
}

type RefMode = "generate" | "upload";

const pretty = (f: string) =>
  f.replace(/_[a-z]+\d+_.*\.(mp4|png)$/, "")
    .replace(/_/g, " ")
    .trim();

const byIndex = (a: AssetEvent, b: AssetEvent) => (a.index ?? 0) - (b.index ?? 0);

// Gallery of outputs/<scenario>/: ref, keyframes, clips (with version
// pickers + regenerate), final cut.
export default function OutputGallery({ scenario, refreshKey, assets, bare, generatingScenario, generatingFormat, section = "all", regenTarget, runQueue = [], onStitch, onRegen, onUploaded, onEngineSwitch, totalScenes, progress, onGotoEditorScene }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [versions, setVersions] = useState<VersionsInfo>({ ref: [], beats: {}, final: [] });
  const [mains, setMains] = useState<MainsInfo>({ ref: null, beats: {}, final: null });
  // Master prompt + source per reference file (from project_references).
  const [refMeta, setRefMeta] = useState<Record<string, { prompt?: string | null; source?: string | null }>>({});
  const [error, setError] = useState("");
  // Which final-cut version is previewed (null = latest). Reset whenever the
  // scenario or file list changes so a fresh stitch always shows the new cut.
  const [viewFinal, setViewFinal] = useState<string | null>(null);
  // Reference source: generate with Flux, or upload/paste an image.
  const [refMode, setRefMode] = useState<RefMode>("generate");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  // Output dir whose listing is actually on screen. Stale-while-revalidate:
  // the previous project's files stay mounted until the new listing lands —
  // clearing them first is what flashed "No outputs yet" on every click.
  // All visible URLs/API calls bind to `viewScenario` so filenames are never
  // mixed with the wrong output dir mid-switch.
  const [loadedFor, setLoadedFor] = useState(scenario);
  const viewScenario = loadedFor || scenario;
  const switchingGallery = !assets && !!scenario && loadedFor !== scenario;

  const readAsDataUrl = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("could not read file"));
      r.readAsDataURL(f);
    });

  const doUpload = async (f: File) => {
    if (!viewScenario || uploading || switchingGallery) return;
    if (!f.type.startsWith("image/")) { setUploadError("not an image file"); return; }
    setUploading(true);
    setUploadError("");
    try {
      const data = await readAsDataUrl(f);
      await uploadRef(viewScenario, data);
      onUploaded?.();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Clipboard paste (Ctrl+V) uploads the image as the reference while in
  // upload mode. Window-scoped so it works no matter where focus is.
  useEffect(() => {
    if (refMode !== "upload" || assets) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      const f = item?.getAsFile();
      if (f) { e.preventDefault(); doUpload(f); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [refMode, viewScenario, uploading, assets]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!scenario) {
      setFiles([]);
      setVersions({ ref: [], beats: {}, final: [] });
      setMains({ ref: null, beats: {}, final: null });
      setRefMeta({});
      setViewFinal(null);
      setLoadedFor("");
      setError("");
      return;
    }
    if (assets) return;
    // Keep the old listing on screen until the new one lands (no blanking).
    let cancelled = false;
    const load = () => {
      listOutputs(scenario).then((r) => {
        if (cancelled) return;
        setFiles(r.files);
        setVersions(r.versions);
        setMains(r.mains);
        setRefMeta(r.refMeta ?? {});
        setLoadedFor(scenario);
        setError("");
      }).catch((e) => {
        // A failed background refresh must never wipe already-shown data —
        // keep the stale listing, just surface the error. But a failed load
        // for a NEW dir still advances past it — otherwise the gallery sits
        // on "Loading outputs…" forever with nothing on screen.
        if (!cancelled) setError(String((e as Error).message || e));
        if (!cancelled) setLoadedFor(scenario);
      });
    };
    load();
    // While a run is active anywhere, re-list on the same 15s cadence as the
    // Story Board so landed assets and version mains advance mid-run instead
    // of freezing at their pre-run state (frozen mains pinned the generating
    // chip on the first missing scene for the whole run).
    if (generatingScenario) {
      const t = setInterval(load, 15000);
      return () => { cancelled = true; clearInterval(t); };
    }
    return () => { cancelled = true; };
  }, [scenario, refreshKey, assets, generatingScenario]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the picked final-cut version only when moving to another project
  // (a refreshKey bump from a fresh stitch keeps working via `shownFinal`
  // falling back to latest when the picked file is gone).
  useEffect(() => { setViewFinal(null); }, [scenario]);

  // Never show another dir's files: the moment `scenario` changes, blank
  // the listing (a loading skeleton shows until the new one lands). Refresh
  // polls for the SAME dir keep their data — no flashing mid-run.
  const prevScenarioRef = useRef(scenario);
  useEffect(() => {
    if (assets) return;
    if (prevScenarioRef.current !== scenario) {
      prevScenarioRef.current = scenario;
      setFiles([]);
      setVersions({ ref: [], beats: {}, final: [] });
      setMains({ ref: null, beats: {}, final: null });
      setRefMeta({});
    }
  }, [scenario, assets]);

  // Live "Generated so far" view also tracks the dir's current mains: the
  // Reference tile below shows the version selected as main RIGHT NOW, so a
  // re-picked main (v3) replaces the file the last run emitted (v4) instead
  // of disagreeing with the Generate Reference card. Refetches on every
  // landed asset (state.json is written before the event is emitted) plus a
  // 15s poll for picks made while no new events land.
  useEffect(() => {
    if (!assets || !scenario) return;
    let cancelled = false;
    const load = () => {
      listOutputs(scenario).then((r) => {
        if (cancelled) return;
        setMains(r.mains);
      }).catch(() => {});
    };
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [scenario, assets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sibling engine dir (LTX <-> Wan): when THIS dir is empty, check whether
  // the project's renders live under the other engine, so the empty state
  // can point there instead of looking like nothing was ever generated.
  // Bound to the on-screen listing (viewScenario), not the in-flight target.
  const isWan = viewScenario.endsWith("_wan");
  const sibScenario = isWan ? viewScenario.slice(0, -4) : `${viewScenario}_wan`;
  const sibLabel = isWan ? "LTX 2.5" : "Wan 2.1";
  const [sibCount, setSibCount] = useState<number | null>(null);
  useEffect(() => {
    setSibCount(null);
    if (assets || bare || section === "reference" || !viewScenario || switchingGallery) return;
    if (files.length > 0) return; // own dir has renders — no need to look
    let cancelled = false;
    listOutputs(sibScenario).then((r) => {
      if (cancelled) return;
      setSibCount((r.files || []).filter((f) => /\.(png|mp4)$/i.test(f)).length);
    }).catch(() => { if (!cancelled) setSibCount(null); });
    return () => { cancelled = true; };
  }, [viewScenario, sibScenario, files, assets, bare, section, switchingGallery]);

  // Live-run view: no versioning UI (versions are created by the run itself).
  // Scene numbers come from the real asset beat index (never array position),
  // total from the scenario config via totalScenes (fallback: highest index).
  // Every scene renders a thumbnail slot the moment Generate is clicked —
  // finished assets show media, the in-flight asset shows a generating
  // status, the rest show pending — so no scene ever appears missing.
  if (assets) {
    const live = assets;
    const final = live.find((a) => a.stage === "final")?.file;
    const ref = live.find((a) => a.stage === "reference")?.file;
    const keyframes = live.filter((a) => a.stage === "keyframe").sort(byIndex);
    const clips = live.filter((a) => a.stage === "clip").sort(byIndex);
    const kfByIndex = new Map(keyframes.map((k) => [k.index ?? -1, k.file]));
    const clipByIndex = new Map(clips.map((c) => [c.index ?? -1, c.file]));
    const liveTotal =
      totalScenes != null && totalScenes > 0
        ? totalScenes
        : Math.max(0, ...keyframes.map((k) => k.index ?? 0), ...clips.map((c) => c.index ?? 0)) || null;
    // All scene slots 1..liveTotal render immediately (even with zero assets
    // landed yet). Without a known total, fall back to landed keyframes.
    const liveNums: number[] =
      liveTotal != null && liveTotal > 0
        ? Array.from({ length: liveTotal }, (_, i) => i + 1)
        : keyframes.map((k) => k.index ?? 0).filter((n) => n > 0);
    // Which asset is currently in flight (first missing in pipeline order:
    // reference → keyframes → clips), unless a regen run targets one asset.
    const liveGenTarget: string | null = (() => {
      if (regenTarget) {
        if (regenTarget.kind === "ref") return "ref";
        if (regenTarget.kind === "keyframe") return `kf:${regenTarget.index}`;
        if (regenTarget.kind === "clip") return `clip:${regenTarget.index}`;
        return null;
      }
      if (!ref) return "ref";
      for (const n of liveNums) {
        if (!kfByIndex.has(n)) return `kf:${n}`;
      }
      for (const n of liveNums) {
        if (!clipByIndex.has(n)) return `clip:${n}`;
      }
      return null;
    })();
    const mediaCount = keyframes.length + clips.length + (ref ? 1 : 0) + (final ? 1 : 0);
    // Reference tile file: while the reference itself is in flight, show the
    // run's own file (or the generating placeholder below); otherwise show
    // the version currently selected as main — the run's emit freezes at
    // generation time but a re-picked main (v3 over the run's v4) must win,
    // or this tile disagrees with the Generate Reference card.
    const liveRefFile = liveGenTarget === "ref" ? ref : (mains.ref ?? ref);
    const Tag = bare ? "div" : "section";
    return (
      <Tag className={bare ? undefined : "card"}>
        {bare && <div className="section-label">Generated so far</div>}
        {preview && <Lightbox item={preview} onClose={() => setPreview(null)} />}
        {final && (
          <>
            <div className="section-label">Final cut</div>
            <div className="video-frame final-cut-frame">
              <SceneBadge label="FINAL" title="Stitched final cut" />
              <ExpandButton title="Fullscreen preview of final cut" onOpen={() => setPreview({ src: outputUrl(viewScenario, final), kind: "video", alt: "final cut" })} />
              <video controls src={outputUrl(viewScenario, final)} />
            </div>
          </>
        )}
        <>
          <div className="section-label">Reference</div>
          {liveRefFile ? (
            <div className="img-frame">
              <SceneBadge label="REF" title="Reference visual" />
              <ExpandButton title="Fullscreen preview of reference" onOpen={() => setPreview({ src: outputUrl(viewScenario, liveRefFile), kind: "image", alt: "reference" })} />
              <SmoothImage src={outputUrl(viewScenario, liveRefFile)} alt="reference" />
            </div>
          ) : (
            <div className="img-frame">
              <SceneBadge label="REF" title="Reference visual" />
              <div className="frame-missing">
                {liveGenTarget === "ref"
                  ? <span className="gen-flag"><span className="dot pulse" /> <span className="gen-dots">Generating</span></span>
                  : <span className="frame-missing-inner"><IconImage size={16} /><span className="muted">Reference · pending</span></span>}
              </div>
            </div>
          )}
        </>
        {liveNums.length > 0 && (
          <>
            <div className="section-label">Keyframes → clips</div>
            <div className="grid grid-compact">
              {liveNums.map((n) => {
                const kf = kfByIndex.get(n);
                const clip = clipByIndex.get(n);
                const kfGen = liveGenTarget === `kf:${n}`;
                const clipGen = liveGenTarget === `clip:${n}`;
                // Live readout for the in-flight tile (~% when pace exists,
                // else ticking seconds, else plain "generating").
                const liveReadout = (kind: "image" | "video"): string => {
                  if (progress?.status === "running" && progress.activeKind === kind && progress.activeScene === n) {
                    if (progress.activePct != null) return `~${Math.round(progress.activePct)}%`;
                    const el = formatLiveElapsed(progress.activeElapsedMs);
                    if (el) return el;
                  }
                  return "generating";
                };
                const kfReadout = kfGen ? liveReadout("image") : "generating";
                const clipReadout = clipGen ? liveReadout("video") : "generating";
                return (
                <div className={`shot${(kfGen || clipGen) ? " generating" : ""}`} key={n} id={`shot-${n}`} title={`Scene ${n} — keyframe image + video clip`}>
                  <div className="shot-head" aria-hidden="true">
                    Scene {n}{liveTotal != null ? `/${liveTotal}` : ""}
                  </div>
                  <div className="img-frame">
                    {kf ? (
                      <>
                        <ExpandButton title={`Fullscreen preview of ${pretty(kf)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, kf), kind: "image", alt: pretty(kf) })} />
                        <SmoothImage src={outputUrl(viewScenario, kf)} alt={pretty(kf)} />
                      </>
                    ) : (
                      <div className={`frame-missing${kfGen ? " is-generating" : ""}`}>
                        {kfGen
                          ? <span className="gen-flag"><span className="gen-eq" aria-hidden="true"><span /><span /><span /><span /></span><span className="gen-dots">Generating</span>{kfReadout !== "generating" && <span> {kfReadout}</span>}</span>
                          : <span className="frame-missing-inner"><IconImage size={16} /><span className="muted">Scene {n} · pending</span></span>}
                      </div>
                    )}
                  </div>
                  <div className="video-frame">
                    {clip ? (
                      <>
                        <ExpandButton title={`Fullscreen preview of ${pretty(clip)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, clip), kind: "video", alt: pretty(clip) })} />
                        <video controls src={outputUrl(viewScenario, clip)} />
                      </>
                    ) : (
                      <div className={`frame-missing${clipGen ? " is-generating" : ""}`}>
                        {clipGen
                          ? <>
                              {kf && (
                                <span className="video-gen-preview" aria-hidden="true">
                                  <img src={outputUrl(viewScenario, kf)} alt="" />
                                </span>
                              )}
                              <span className="gen-scanline" aria-hidden="true" />
                              <span className="gen-flag">
                                <span className="gen-eq" aria-hidden="true"><span /><span /><span /><span /></span>
                                <span className="gen-dots">Generating</span>{clipReadout !== "generating" && <span> {clipReadout}</span>}
                              </span>
                            </>
                          : <span className="frame-missing-inner"><IconFilm size={16} /><span className="muted">Video {n} · pending</span></span>}
                      </div>
                    )}
                  </div>
                  {onGotoEditorScene && (
                    <div className="shot-foot">
                      <button
                        className="icon-btn shot-goto"
                        onClick={() => onGotoEditorScene(n)}
                        title={`Edit Scene ${n} in Scenario Editor`}
                        aria-label={`Edit Scene ${n} in Scenario Editor`}
                      >
                        <IconEdit size={13} />
                      </button>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </>
        )}
        {mediaCount === 0 && liveNums.length === 0 && (
          <div className="empty">
            <span className="empty-icon">
              <IconImage size={20} />
            </span>
            <span className="empty-title">No outputs yet</span>
          </div>
        )}
      </Tag>
    );
  }

  // Static view with versioning.
  // Final cuts are versioned like every other asset (v1 = <prefix>_final.mp4,
  // vN = <prefix>_final_vN.mp4) — every stitch writes a NEW file, so the
  // gallery can show v1, v2, … and the browser never replays a cached cut.
  const finalVersions: AssetVersion[] = (versions.final && versions.final.length > 0)
    ? [...versions.final].sort((a, b) => a.v - b.v)
    : files
        .filter((f) => /_final(_v\d+)?\.mp4$/.test(f))
        .map((f) => {
          const m = f.match(/_final_v(\d+)\.mp4$/);
          return { file: f, v: m ? Number(m[1]) : 1 };
        })
        .sort((a, b) => a.v - b.v);
  const latestFinal = mains.final || finalVersions[finalVersions.length - 1]?.file
    || files.find((f) => f.endsWith("_final.mp4")) || null;
  // Preview selection: explicit pick when the user clicks a v-chip, otherwise
  // the latest stitch. Falls back to latest when the picked file is gone.
  const shownFinal = viewFinal && finalVersions.some((v) => v.file === viewFinal)
    ? viewFinal
    : latestFinal;
  const shownFinalV = finalVersions.find((v) => v.file === shownFinal)?.v ?? null;
  const refFile = mains.ref || versions.ref[versions.ref.length - 1]?.file
    || files.find((f) => /_ref(\.png|_v\d+\.png)$/.test(f)) || null;
  const beatNums = Object.keys(versions.beats).map(Number).sort((a, b) => a - b);
  // Fallback for legacy dirs where versioning can't resolve (e.g. beat titles renamed since).
  const fallbackShots = beatNums.length === 0
    ? files
        .filter((f) => /_seq\d+_.*\.png$/.test(f))
        .sort()
        .map((kf) => ({
          kf,
          clip: files.find((c) => /_clip\d+_.*\.mp4$/.test(c) && c.replace(/\.mp4$/, ".png") === kf) || null,
        }))
    : [];
  const hasClips = beatNums.some((n) => (versions.beats[String(n)].clip?.length ?? 0) > 0) || fallbackShots.some((s) => s.clip);

  // True when the active run is generating into the output dir on screen.
  // Compared against the visible listing (viewScenario) so a mid-run project
  // switch keeps the chip on the right gallery. The version rows then show a
  // blinking "generating vN" chip on the asset actually in progress.
  // generatingScenario arrives as the base scenario name; Wan runs render
  // into the suffixed dir, so both forms match. The format must match too —
  // a vertical Reel run never lights up the landscape cards.
  const generating = !!generatingScenario && !!viewScenario &&
    (generatingScenario === viewScenario || `${generatingScenario}_wan` === viewScenario ||
      `${generatingScenario}_vertical` === viewScenario || `${generatingScenario}_wan_vertical` === viewScenario) &&
    (generatingFormat ?? "landscape") === (isVerticalOut(viewScenario) ? "vertical" : "landscape");
  const genTarget = (() => {
    if (!generating) return null;
    if (regenTarget) {
      if (regenTarget.kind === "ref") return "ref";
      if (regenTarget.kind === "keyframe") return `kf:${regenTarget.index}`;
      if (regenTarget.kind === "clip") return `clip:${regenTarget.index}`;
    }
    // Live in-flight asset wins over the first-missing heuristic below:
    // versions/mains are only re-listed on refresh, so the heuristic would
    // freeze the chip on the first missing scene for the whole run while the
    // real work has moved on. progress.activeScene tracks the actual asset
    // (skips stream as events, so it advances past resumed scenes).
    if (progress?.status === "running" && progress.activeScene != null) {
      if (progress.activeKind === "image")
        return progress.activeScene > 0 ? `kf:${progress.activeScene}` : "ref";
      if (progress.activeKind === "video" && progress.activeScene > 0)
        return `clip:${progress.activeScene}`;
    }
    if (!versions.ref.length) return "ref";
    for (const n of beatNums) {
      if (!versions.beats[String(n)].keyframe.length) return `kf:${n}`;
    }
    for (const n of beatNums) {
      if (!versions.beats[String(n)].clip.length) return `clip:${n}`;
    }
    return null; // everything exists — the run is re-stitching the final cut
  })();
  // The Stitch final button's own run: every asset already has a version,
  // so no asset chip is blinking — the button itself spins instead.
  const stitching = generating && genTarget === null;

  // Queued regen for one versioned asset (App drains serially) — its chip
  // reads "queued" and stays clickable; only the generating chip locks.
  const queuedRegen = (kind: "keyframe" | "clip", index: number) =>
    runQueue.some((q) => !q.stitch && q.regen?.kind === kind && (q.regen?.index ?? index) === index);

  const pickMain = async (kind: "ref" | "keyframe" | "clip", index: number | null, file: string) => {
    if (switchingGallery) return;
    try {
      const r = await selectMain(viewScenario, kind, index, file);
      setVersions(r.versions);
      setMains(r.mains);
      setFiles(r.files);
      setRefMeta(r.refMeta ?? {});
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doStitch = () => onStitch?.();

  // Shared Browse / Paste buttons (used in both upload layouts below).
  const browseButton = (
    <button onClick={() => fileInputRef.current?.click()} disabled={uploading || switchingGallery}>
      <IconUpload size={11} />
      Browse
    </button>
  );
  const pasteButton = (
    <button
      disabled={uploading || switchingGallery}
      title="Paste the clipboard image (or press Ctrl+V anywhere)"
      onClick={async () => {
        try {
          const items = await navigator.clipboard.read();
          const img = items.find((i) => i.types.includes("image/png")) || items.find((i) => i.types[0]?.startsWith("image/"));
          if (img) {
            const t = img.types.find((x) => x.startsWith("image/"))!;
            const blob = await img.getType(t);
            doUpload(new File([blob], "clipboard.png", { type: t }));
          } else setUploadError("no image on the clipboard");
        } catch {
          setUploadError("clipboard unavailable — copy an image or use Ctrl+V");
        }
      }}
    >
      <IconClipboard size={11} />
      Paste
    </button>
  );

  // All reference versions in one go — each card header shows its version
  // (V1, V2, …); clicking an image sets it as main. Shared by Generate and
  // Upload modes.
  const refNextV = versions.ref.length ? versions.ref[versions.ref.length - 1].v + 1 : 1;
  const refCards = versions.ref.length || genTarget === "ref" ? (
    <div className="ref-list">
      {versions.ref.map((v) => (
        <div className={`ref-card${mains.ref === v.file ? " on" : ""}`} key={v.file}>
          <div
            className="img-frame"
            title={[
              mains.ref === v.file
                ? `${v.file} (main — ${mains.pinned?.ref ? "your pick" : "latest"})`
                : `Set ${v.file} as main (your pick)`,
              refMeta[v.file]?.prompt?.trim()
                ? `Master prompt: ${refMeta[v.file].prompt!.trim().slice(0, 200)}`
                : null,
            ].filter(Boolean).join("\n")}
          >
            <span className="ver-badge">v{v.v}</span>
            <SceneBadge label="REF" title="Reference visual" />
            {mains.ref === v.file && <span className="main-badge"><IconCheck size={10} /> main</span>}
            <ExpandButton title={`Fullscreen preview of ${v.file}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, v.file), kind: "image", alt: `reference V${v.v}` })} />
            <SmoothImage
              src={outputUrl(viewScenario, v.file)}
              alt={`reference V${v.v}`}
              onClick={() => pickMain("ref", null, v.file)}
            />
          </div>
        </div>
      ))}
      {genTarget === "ref" && (
        <div className="ref-card">
          <div className="img-frame">
            <span className="ver-badge">v{refNextV}</span>
            <div className="frame-missing">
              <span className="gen-flag"><span className="dot pulse" /> <span className="gen-dots">Generating</span></span>
            </div>
          </div>
        </div>
      )}
    </div>
  ) : (
    <div className="img-frame">
      <div className="frame-missing">no reference yet — generate above or switch to Upload</div>
    </div>
  );

  // Every scene in story order: on-disk beats plus config-known scenes
  // (totalScenes) with nothing generated yet. The Rendered Clip card lists
  // each scene's previous image/video first, final cut last.
  const sceneNums: number[] = [
    ...new Set([
      ...beatNums,
      ...(totalScenes != null && totalScenes > 0
        ? Array.from({ length: totalScenes }, (_, i) => i + 1)
        : []),
    ]),
  ].sort((a, b) => a - b);

  // Follow the newest stitch automatically: when a fresh final cut lands
  // while the previous latest (or nothing) was showing, drop the pick so
  // the new final clip shows on its own.
  const prevLatestFinal = useRef<string | null>(null);
  useEffect(() => {
    if (prevLatestFinal.current !== null && latestFinal && latestFinal !== prevLatestFinal.current) {
      const prev = prevLatestFinal.current;
      setViewFinal((v) => (v === null || v === prev ? null : v));
    }
    prevLatestFinal.current = latestFinal;
  });
  // Anchor for an explicit older pick: the latest final at pick time. A
  // refresh (stitch run done, re-list) that brings a NEWER final clears the
  // pick so the fresh full stitch shows on its own — the gallery must never
  // sit on an older cut forever after you hit Stitch. Refreshes with no new
  // final (saves, uploads) keep the pick.
  const pickAnchor = useRef<string | null>(null);
  useEffect(() => {
    if (viewFinal && latestFinal && pickAnchor.current && latestFinal !== pickAnchor.current) {
      pickAnchor.current = latestFinal;
      setViewFinal(null);
    }
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Current loaded media for the Rendered Clip card: the single latest
  // finished keyframe image and clip video (highest scene number with a
  // main file). While image 2 generates, image 1 still shows; while video
  // 3 generates, video 2 still shows — never a spinner in place of the
  // last good file.
  let curKf: { n: number; file: string } | null = null;
  let curClip: { n: number; file: string } | null = null;
  for (const n of sceneNums) {
    const bv = versions.beats[String(n)];
    const kf = mains.beats[String(n)]?.keyframe || bv?.keyframe[bv.keyframe.length - 1]?.file || null;
    if (kf) curKf = { n, file: kf };
    const cl = mains.beats[String(n)]?.clip || bv?.clip[bv.clip.length - 1]?.file || null;
    if (cl) curClip = { n, file: cl };
  }
  if (!curKf && !curClip && fallbackShots.length > 0) {
    const last = fallbackShots[fallbackShots.length - 1];
    const m = last.kf.match(/_seq(\d+)_/);
    const fn = m ? Number(m[1]) : fallbackShots.length;
    curKf = { n: fn, file: last.kf };
    if (last.clip) curClip = { n: fn, file: last.clip };
  }
  // An image is in flight (reference or any keyframe); a video is in
  // flight only when a clip run is active.
  const imgGen = generating && (genTarget === "ref" || (genTarget?.startsWith("kf:") ?? false));
  const clipGen = generating && (genTarget?.startsWith("clip:") ?? false);
  // Live readout for the in-flight clip on the Current-video tile:
  // estimated ~% when pace exists, else ticking seconds (real), else null.
  const curClipReadout = clipGen && progress?.status === "running" && progress.activeKind === "video"
    ? (progress.activePct != null
        ? `~${Math.round(progress.activePct)}%`
        : (formatLiveElapsed(progress.activeElapsedMs) ?? "generating"))
    : null;

  const mediaCount = sceneNums.length + (refFile ? 1 : 0) + (shownFinal ? 1 : 0);

  const Tag = bare || section === "reference" ? "div" : "section";
  // Full card only (embeds have no header to host the toggle): hide/show,
  // persisted like the Projects panel — one key per card. Collapsing only
  // hides the body JSX — listings keep refreshing underneath.
  const isCard = !bare && section !== "reference";
  const isBeats = section === "beats";
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(isBeats ? "ss-sec-beats" : "ss-sec-outputs") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem(isBeats ? "ss-sec-beats" : "ss-sec-outputs", c ? "open" : "closed");
      return !c;
    });
  // Embedded Reference gallery (Generate Reference section) gets its own
  // hide/show toggle — same persisted icon pattern as the cards.
  const [refCollapsed, setRefCollapsed] = useState(() => localStorage.getItem("ss-sec-refgallery") === "closed");
  const toggleRefCollapsed = () =>
    setRefCollapsed((c) => {
      localStorage.setItem("ss-sec-refgallery", c ? "open" : "closed");
      return !c;
    });
  return (
    <Tag className={isCard ? `card${collapsed ? " collapsed" : ""}` : (section === "reference" ? "ref-embed" : undefined)}>
      {!bare && section !== "reference" && (
        <div className="card-head">
          <h2>
            {isBeats ? (
              <>
                <span className="head-icon hi-beats"><IconFilm size={15} /></span>
                Keyframes → clips
              </>
            ) : (
              <>
                <span className="head-icon hi-output"><IconClapper size={15} /></span>
                Rendered Clip
              </>
            )}
          </h2>
          <span className="spacer" />
          {switchingGallery && (
            <span className="pill running switching-pill" title="Loading the newly selected project…">
              <span className="dot pulse" /> switching…
            </span>
          )}
          {isBeats && sceneNums.length > 0 && (
            <span className="muted" style={{ fontSize: 12 }} title={`${sceneNums.length} scenes`}>
              {sceneNums.length} scene{sceneNums.length === 1 ? "" : "s"}
            </span>
          )}
          {isBeats && generating && genTarget !== null && genTarget !== "ref" && (
            <span className="pill running" title="A run is producing a keyframe or clip right now">
              <span className="dot pulse" /> generating…
            </span>
          )}
          {!isBeats && hasClips && (
            <button
              onClick={doStitch}
              disabled={generating || switchingGallery}
              title={stitching ? "Stitching the final cut…" : "Concatenate the selected main clip versions into the final cut"}
            >
              {stitching ? <Spinner size={12} /> : <IconScissors size={12} />}
              {stitching ? "Stitching…" : "Stitch final"}
            </button>
          )}
          {!isBeats && viewScenario && (
            <span className="muted" style={{ fontSize: 12, fontFamily: "var(--mono)" }}>
              outputs/{viewScenario}/
            </span>
          )}
          <button
            className="icon-btn"
            onClick={toggleCollapsed}
            title={collapsed ? (isBeats ? "Show keyframes and clips" : "Show output") : (isBeats ? "Hide keyframes and clips" : "Hide output")}
            aria-label={collapsed ? (isBeats ? "Show keyframes and clips" : "Show output") : (isBeats ? "Hide keyframes and clips" : "Hide output")}
            aria-expanded={!collapsed}
          >
            <IconPanel size={15} />
          </button>
        </div>
      )}

      <Collapse open={!(isCard && collapsed)}>
      {error && <p className="hint err-text">{error}</p>}
      {preview && <Lightbox item={preview} onClose={() => setPreview(null)} />}

      {(section === "all" || section === "output") && (curKf || curClip || generating || shownFinal) && (
        <>
          {(curKf || curClip || generating) && (
            <>
              <div className="section-label">Current image & video</div>
              <div className="grid thumb-half">
                <div className="img-frame" title={curKf ? `Current image — scene ${curKf.n} keyframe` : "Current image"}>
                  {curKf && <SceneBadge scene={curKf.n} total={sceneNums.length || null} title={`Scene ${curKf.n} — current keyframe image`} />}
                  {curKf ? (
                    <>
                      <ExpandButton title={`Fullscreen preview of ${pretty(curKf.file)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, curKf.file), kind: "image", alt: pretty(curKf.file) })} />
                      <SmoothImage src={outputUrl(viewScenario, curKf.file)} alt={pretty(curKf.file)} />
                    </>
                  ) : (
                    <div className="frame-missing">
                      {imgGen
                        ? <span className="gen-flag"><span className="dot pulse" /> <span className="gen-dots">Generating</span></span>
                        : <span className="frame-missing-inner"><IconImage size={16} /><span className="muted">pending</span></span>}
                    </div>
                  )}
                </div>
                <div className="video-frame" title={curClip ? `Current video — video ${curClip.n} clip` : "Current video"}>
                  {curClip && <SceneBadge small label={sceneNums.length ? `V${curClip.n}/${sceneNums.length}` : `V${curClip.n}`} title={`Video ${curClip.n} — current clip`} />}
                  {curClip ? (
                    <>
                      <ExpandButton title={`Fullscreen preview of ${pretty(curClip.file)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, curClip.file), kind: "video", alt: pretty(curClip.file) })} />
                      <video controls preload="metadata" src={outputUrl(viewScenario, curClip.file)} />
                      {clipGen && <span className="gen-scanline" aria-hidden="true" />}
                      {clipGen && curClipReadout && curClipReadout !== "generating" && (
                        <span className="gen-pct" title={`Generating video… ${curClipReadout}${curClipReadout.startsWith("~") ? " (estimated)" : " elapsed"}`}>{curClipReadout}</span>
                      )}
                    </>
                  ) : (
                    <div className={`frame-missing${clipGen ? " is-generating" : ""}`}>
                      {clipGen
                        ? <>
                            {curKf && (
                              <span className="video-gen-preview" aria-hidden="true">
                                <img src={outputUrl(viewScenario, curKf.file)} alt="" />
                              </span>
                            )}
                            <span className="gen-scanline" aria-hidden="true" />
                            <span className="gen-flag">
                              <span className="gen-eq" aria-hidden="true"><span /><span /><span /><span /></span>
                              <span className="gen-dots">Generating</span>{curClipReadout && curClipReadout !== "generating" && <span> {curClipReadout}</span>}
                            </span>
                          </>
                        : <span className="frame-missing-inner"><IconFilm size={16} /><span className="muted">pending</span></span>}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
          {shownFinal && (
            <>
              <div className="section-label">
                Final cut
                {finalVersions.length > 1 && <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}> · {finalVersions.length} versions</span>}
                {generating && genTarget === null && (
                  <span className="gen-flag" title="Re-stitching the final cut from the selected main versions">
                    <span className="dot pulse" /> stitching
                  </span>
                )}
              </div>
              <div className="video-frame final-cut-frame">
                <SceneBadge label="FINAL" title="Stitched final cut" />
                {shownFinalV != null && (
                  <span className="ver-badge" title={`Final cut v${shownFinalV} (showing)`}>v{shownFinalV}</span>
                )}
                <ExpandButton title="Fullscreen preview of final cut" onOpen={() => setPreview({ src: outputUrl(viewScenario, shownFinal), kind: "video", alt: "final cut" })} />
                <video
                  key={shownFinal}
                  controls
                  preload="metadata"
                  src={`${outputUrl(viewScenario, shownFinal)}?v=${encodeURIComponent(shownFinal)}`}
                />
              </div>
              {finalVersions.length > 0 && (
                <div className="versions">
                  {finalVersions.map((v) => (
                    <button
                      key={v.file}
                      className={`vchip ${shownFinal === v.file ? "on" : ""}`}
                      title={shownFinal === v.file ? `${v.file} (showing)` : `Show ${v.file}`}
                      onClick={() => { pickAnchor.current = latestFinal ?? null; setViewFinal(v.file); }}
                    >
                      {shownFinal === v.file && <IconCheck size={10} />}
                      v{v.v}
                    </button>
                  ))}
                  {shownFinalV != null && latestFinal && shownFinal !== latestFinal && (
                    <span className="muted" style={{ fontSize: 11 }}>showing v{shownFinalV} · latest is v{finalVersions[finalVersions.length - 1]?.v}</span>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
      {viewScenario && (section === "all" || section === "reference") ? (
        <>
          {section === "reference" ? (
            <div className="ref-embed-head">
              <span className="section-label">
                Reference
                {versions.ref.length > 1 && <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}> · {versions.ref.length} versions</span>}
              </span>
              <span className="spacer" />
              <button
                className="icon-btn"
                onClick={toggleRefCollapsed}
                title={refCollapsed ? "Show reference images" : "Hide reference images"}
                aria-label={refCollapsed ? "Show reference images" : "Hide reference images"}
                aria-expanded={!refCollapsed}
              >
                <IconPanel size={15} />
              </button>
            </div>
          ) : (
            <div className="section-label">
              Reference
              {versions.ref.length > 1 && <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}> · {versions.ref.length} versions</span>}
            </div>
          )}
          <Collapse open={!(section === "reference" && refCollapsed)}>
          <div className="seg ref-mode">
            <button className={refMode === "generate" ? "on" : ""} onClick={() => setRefMode("generate")} title="Generate the reference with Flux from the reference prompt">
              Generate
            </button>
            <button className={refMode === "upload" ? "on" : ""} onClick={() => setRefMode("upload")} title="Upload or paste your own reference image">
              <IconUpload size={11} />
              Upload
            </button>
          </div>
          {refMode === "generate" ? refCards : (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) doUpload(f);
                }}
              />
              <div
                className={`upload-zone${dragOver ? " over" : ""}${uploading ? " busy" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) doUpload(f);
                }}
              >
                {refFile ? (
                  <div className="upload-side">
                    <SceneBadge label="REF" title="Reference visual" />
                    <ExpandButton title="Fullscreen preview of reference" onOpen={() => setPreview({ src: outputUrl(viewScenario, refFile), kind: "image", alt: "reference" })} />
                    <SmoothImage src={outputUrl(viewScenario, refFile)} alt="reference" />
                    <div className="upload-side-actions">
                      {browseButton}
                      {pasteButton}
                      <span className="muted upload-hint">or drag &amp; drop / Ctrl+V</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="frame-missing">
                      <span className="gen-flag"><span className="dot pulse" /> {uploading ? "uploading…" : genTarget === "ref" ? "generating…" : "no reference yet"}</span>
                    </div>
                    <div className="upload-actions">
                      {browseButton}
                      {pasteButton}
                      <span className="muted upload-hint">or drag &amp; drop / Ctrl+V</span>
                    </div>
                  </>
                )}
              </div>
              {uploadError && <p className="hint err-text">{uploadError}</p>}
              <p className="hint">Uploaded image becomes the main reference — the run uses it instead of generating one.</p>
              {refCards}
            </>
          )}
          </Collapse>
        </>
      ) : null}
      {(section === "all" || section === "beats") && (sceneNums.length > 0 || fallbackShots.length > 0) && (
        <>
          {/* The Keyframes card header already carries this title. */}
          {!isBeats && <div className="section-label">Keyframes → clips</div>}
          <div className="grid grid-compact">
            {(() => {
            const total = sceneNums.length;
            const pctFor = (kind: "image" | "video", beat: number): number | null => {
              if (!generating || progress?.status !== "running") return null;
              if (progress.activeKind !== kind || progress.activeScene !== beat) return null;
              return progress.activePct;
            };
            const elapsedFor = (kind: "image" | "video", beat: number): string | null => {
              if (!generating || progress?.status !== "running") return null;
              if (progress.activeKind !== kind || progress.activeScene !== beat) return null;
              return formatLiveElapsed(progress.activeElapsedMs);
            };
            return sceneNums.map((n) => {
              const bv = versions.beats[String(n)] ?? { keyframe: [], clip: [] };
              const kfMain = mains.beats[String(n)]?.keyframe || bv.keyframe[bv.keyframe.length - 1]?.file || null;
              const clipMain = mains.beats[String(n)]?.clip || bv.clip[bv.clip.length - 1]?.file || null;
              const kfV = kfMain ? bv.keyframe.find((v) => v.file === kfMain)?.v ?? null : null;
              const clipV = clipMain ? bv.clip.find((v) => v.file === clipMain)?.v ?? null : null;
              const kfGen = genTarget === `kf:${n}`;
              const clipGen = genTarget === `clip:${n}`;
              const kfPct = kfGen ? pctFor("image", n) : null;
              const clipPct = clipGen ? pctFor("video", n) : null;
              const kfElapsed = kfGen ? elapsedFor("image", n) : null;
              const clipElapsed = clipGen ? elapsedFor("video", n) : null;
              const kfReadout = kfPct != null ? `~${Math.round(kfPct)}%` : (kfElapsed ?? "generating");
              const clipReadout = clipPct != null ? `~${Math.round(clipPct)}%` : (clipElapsed ?? "generating");
              const kfLabel = kfPct != null ? `Generating scene ${n} keyframe… ~${Math.round(kfPct)}% (estimated)` : kfElapsed != null ? `Generating scene ${n} keyframe… ${kfElapsed} elapsed` : `Generating scene ${n} keyframe…`;
              const clipLabel = clipPct != null ? `Generating video ${n}… ~${Math.round(clipPct)}% (estimated)` : clipElapsed != null ? `Generating video ${n}… ${clipElapsed} elapsed` : `Generating video ${n}…`;
              // Edit button lives in the last row (clip versions), right side.
              const editAction = onGotoEditorScene ? (
                <button
                  className="icon-btn shot-goto"
                  onClick={() => onGotoEditorScene(n)}
                  title={`Edit Scene ${n} in Scenario Editor`}
                  aria-label={`Edit Scene ${n} in Scenario Editor`}
                >
                  <IconEdit size={13} />
                </button>
              ) : null;
              return (
                <div className={`shot${(kfGen || clipGen) ? " generating" : ""}`} key={n} id={`shot-${n}`} title={`Scene ${n} — keyframe image + video clip`}>
                  <div className="shot-head" aria-hidden="true">
                    Scene {n}/{total}
                  </div>
                  <div className="img-frame">
                    {kfMain
                      ? <>
                        {kfV != null && (
                          <span className="ver-badge" title={`Scene ${n} keyframe v${kfV} (main)`}>v{kfV}</span>
                        )}
                        <ExpandButton title={`Fullscreen preview of ${pretty(kfMain)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, kfMain), kind: "image", alt: pretty(kfMain) })} />
                        <SmoothImage src={outputUrl(viewScenario, kfMain)} alt={pretty(kfMain)} />
                      </>
                      : <div className={`frame-missing${kfGen ? " is-generating" : ""}`}>
                          {kfGen
                            ? <span className="gen-flag" title={kfLabel}>
                                <span className="gen-eq" aria-hidden="true"><span /><span /><span /><span /></span>
                                <span className="gen-dots">Generating</span>{(kfPct != null || kfElapsed != null) && <span> {kfReadout}</span>}
                              </span>
                            : <span className="frame-missing-inner"><IconImage size={16} /><span className="muted">Scene {n} · pending</span></span>}
                        </div>}
                  </div>
                  <VersionRow
                    versions={bv.keyframe}
                    main={mains.beats[String(n)]?.keyframe}
                    mainPinned={mains.pinned?.beats?.[String(n)]?.keyframe}
                    kind="image"
                    onSelect={(f) => pickMain("keyframe", n, f)}
                    onRegen={() => onRegen?.("keyframe", n)}
                    generating={kfGen}
                    busy={switchingGallery}
                    queued={!generating && queuedRegen("keyframe", n)}
                    pct={kfPct}
                    elapsed={kfElapsed}
                  />
                  {clipMain ? (
                    <div className="shot-clip-frame">
                      {clipV != null && (
                        <span className="ver-badge" title={`Scene ${n} clip v${clipV} (main)`}>v{clipV}</span>
                      )}
                      <ExpandButton title={`Fullscreen preview of ${pretty(clipMain)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, clipMain), kind: "video", alt: pretty(clipMain) })} />
                      <video controls preload="metadata" src={outputUrl(viewScenario, clipMain)} className="shot-clip-bare" />
                      {clipGen && <span className="gen-scanline" aria-hidden="true" />}
                      {clipGen && (clipPct != null || clipElapsed != null) && (
                        <>
                          <span className="gen-pct" title={clipLabel}>{clipReadout}</span>
                          {clipPct != null && (
                          <span className="gen-bar" aria-hidden="true">
                            <span style={{ width: `${Math.min(99, Math.max(0, Math.round(clipPct)))}%` }} />
                          </span>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="video-frame">
                      <div className={`frame-missing${clipGen ? " is-generating" : ""}`}>
                        {clipGen
                          ? <>
                              {kfMain && (
                                <span className="video-gen-preview" aria-hidden="true">
                                  <img src={outputUrl(viewScenario, kfMain)} alt="" />
                                </span>
                              )}
                              <span className="gen-scanline" aria-hidden="true" />
                              <span className="gen-flag" title={clipLabel}>
                                <span className="gen-eq" aria-hidden="true"><span /><span /><span /><span /></span>
                                <span className="gen-dots">Generating</span>{(clipPct != null || clipElapsed != null) && <span> {clipReadout}</span>}
                              </span>
                              {(clipPct != null || clipElapsed != null) && (
                                <>
                                  <span className="gen-pct" title={clipLabel}>{clipReadout}</span>
                                  {clipPct != null && (
                                  <span className="gen-bar" aria-hidden="true">
                                    <span style={{ width: `${Math.min(99, Math.max(0, Math.round(clipPct)))}%` }} />
                                  </span>
                                  )}
                                </>
                              )}
                            </>
                          : <span className="frame-missing-inner"><IconFilm size={16} /><span className="muted">Video {n} · pending</span></span>}
                      </div>
                    </div>
                  )}
                  <VersionRow
                    versions={bv.clip}
                    main={mains.beats[String(n)]?.clip}
                    mainPinned={mains.pinned?.beats?.[String(n)]?.clip}
                    kind="video"
                    onSelect={(f) => pickMain("clip", n, f)}
                    onRegen={() => onRegen?.("clip", n)}
                    generating={clipGen}
                    busy={switchingGallery}
                    queued={!generating && queuedRegen("clip", n)}
                    pct={clipPct}
                    elapsed={clipElapsed}
                    action={editAction}
                  />
                </div>
              );
            });
            })()}
            {fallbackShots.map(({ kf, clip }, fi) => {
              const m = kf.match(/_seq(\d+)_/);
              const fn = m ? Number(m[1]) : fi + 1;
              return (
              <div className="shot" key={kf} id={`shot-${fn}`} title={`Scene ${fn} — keyframe image + video clip`}>
                <div className="shot-head" aria-hidden="true">Scene {fn}/{fallbackShots.length}</div>
                <div className="img-frame">
                  <ExpandButton title={`Fullscreen preview of ${pretty(kf)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, kf), kind: "image", alt: pretty(kf) })} />
                  <SmoothImage src={outputUrl(viewScenario, kf)} alt={pretty(kf)} />
                </div>
                {clip && (
                  <div className="shot-clip-frame">
                    <ExpandButton title={`Fullscreen preview of ${pretty(clip)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, clip), kind: "video", alt: pretty(clip) })} />
                    <video controls preload="metadata" src={outputUrl(viewScenario, clip)} className="shot-clip-bare" />
                  </div>
                )}
                {onGotoEditorScene && (
                  <div className="shot-foot">
                    <button
                      className="icon-btn shot-goto"
                      onClick={() => onGotoEditorScene(fn)}
                      title={`Edit Scene ${fn} in Scenario Editor`}
                      aria-label={`Edit Scene ${fn} in Scenario Editor`}
                    >
                      <IconEdit size={13} />
                    </button>
                  </div>
                )}
              </div>
              );
            })}
          </div>
          <p className="hint">
            Pick a version to make it <b>your pick</b> — the final cut stitches the main version of every beat.
            Regenerate keeps old versions and selects the newest; a reload also selects the newest unless you picked one.
            Regen the clip afterwards to generate video from the main keyframe.
            Every keyframe is anchored on the reference selected as main — switching the main ref regenerates stale images on the next run.
          </p>
        </>
      )}
      {((section === "all" && switchingGallery && mediaCount === 0) ||
        (section === "output" && switchingGallery && !shownFinal && !curKf && !curClip) ||
        (section === "beats" && switchingGallery && sceneNums.length === 0 && fallbackShots.length === 0)) && (
        <div className="empty" aria-label="Loading outputs">
          <span className="empty-icon">
            <Spinner size={20} />
          </span>
          <span className="empty-title">Loading outputs…</span>
        </div>
      )}
      {((section === "all" && !switchingGallery && mediaCount === 0) ||
        (section === "output" && !switchingGallery && !shownFinal && !curKf && !curClip)) && !generating && (
        <div className="empty">
          <span className="empty-icon">
            <IconImage size={20} />
          </span>
          <span className="empty-title">{section === "output" ? "No final cut yet" : "No outputs yet"}</span>
          <span className="empty-sub">
            {viewScenario
              ? (section === "output"
                ? "Generate clips, then stitch them into the final cut."
                : "Start a run to see the reference, keyframes, and final cut land here.")
              : "Select a scenario to view its outputs."}
          </span>
          {sibCount != null && sibCount > 0 && (
            <>
              <span className="hint">
                This project has {sibCount} {sibLabel} render{sibCount === 1 ? "" : "s"} — switch engine to view them.
              </span>
              {onEngineSwitch && (
                <button className="ghost" onClick={onEngineSwitch}>
                  View {sibLabel} outputs
                </button>
              )}
            </>
          )}
        </div>
      )}
      {section === "beats" && !switchingGallery && sceneNums.length === 0 && fallbackShots.length === 0 && !generating && (
        <div className="empty">
          <span className="empty-icon">
            <IconImage size={20} />
          </span>
          <span className="empty-title">No keyframes yet</span>
          <span className="empty-sub">
            {viewScenario
              ? "Start a run to generate keyframes and clips for every scene."
              : "Select a scenario to view its keyframes."}
          </span>
        </div>
      )}
      </Collapse>
    </Tag>
  );
}

// Scene-number overlay (top-right): "n/total" from real scene metadata, or a
// stage label (REF / FINAL) where no scene number applies. Pure frontend
// overlay — never modifies the generated file. Offset left of the expand
// button so the two never overlap.
export function SceneBadge({ scene, total, label, title, small }: {
  scene?: number;
  total?: number | null;
  label?: string;
  title?: string;
  /** Smaller type for the video-count badges (V1/26, V2/26, …). */
  small?: boolean;
}) {
  const text =
    label ?? (scene != null && total != null ? `${scene}/${total}` : scene != null ? String(scene) : "");
  if (!text) return null;
  // Numeric badges (n/total, Vn/total) render half-size on the generating
  // tint; stage labels (REF / FINAL) keep the full-size dark style.
  const numeric = /^V?\d/.test(text);
  return (
    <span className={`scene-badge${small ? " scene-badge-sm" : ""}${numeric ? " scene-badge-num" : ""}`} title={title ?? `Scene ${scene} of ${total}`}>
      {text}
    </span>
  );
}

// Expand button overlaying a frame corner — opens the fullscreen Lightbox.
export function ExpandButton({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <button
      className="frame-expand"
      title={title}
      aria-label={title}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
    >
      <IconExpand size={13} />
    </button>
  );
}

// Blinking "generating vN" chip (blinking dot) — shown while a run is
// producing this version; previous versions are kept. pct is the estimated
// ~% for the in-flight asset, elapsed the live seconds while no pace exists
// yet (null = indeterminate).
// Version chips (v1, v2, …) + regenerate button for one versioned asset.
// `action` (e.g. the Edit-scene button) pins to the right end of the row.
function VersionRow({ versions, main, mainPinned, kind, onSelect, onRegen, generating, busy, queued, pct, elapsed, action }: {
  versions: AssetVersion[];
  main: string | null;
  // True when the main is the user's explicit pick (survives reloads);
  // otherwise the main is simply the latest version.
  mainPinned?: boolean;
  kind: "image" | "video";
  onSelect: (file: string) => void;
  onRegen?: () => void;
  generating?: boolean; // a run is producing the next version right now
  busy?: boolean; // gallery is mid-switch — regen would hit the wrong dir
  queued?: boolean; // a regen is queued behind the active run
  pct?: number | null; // estimated ~% for the in-flight version (null = indeterminate)
  elapsed?: string | null; // live seconds while no pace exists yet
  action?: ReactNode; // trailing right-aligned element (Edit-scene button)
}) {
  if (versions.length === 0 && !generating && !onRegen && !action) return null;
  const nextV = versions.length > 0 ? versions[versions.length - 1].v + 1 : 1;
  return (
    <div className="versions">
      {versions.map((v) => (
        <button
          key={v.file}
          className={`vchip ${main === v.file ? "on" : ""}`}
          title={main === v.file ? `${v.file} (main — ${mainPinned ? "your pick" : "latest"}${kind === "image" ? ", used for the clip" : ", used in stitch"})` : `Set ${v.file} as main (your pick)`}
          onClick={() => onSelect(v.file)}
        >
          {main === v.file && <IconCheck size={10} />}
          v{v.v}
        </button>
      ))}
      {generating && (
        <span className="vchip gen gen-stacked" title={pct != null ? `Generating v${nextV} — ~${Math.round(pct)}% (estimated), previous versions are kept` : `Generating v${nextV} — previous versions are kept`}>
          <span className="gen-stack-top"><span className="dot pulse" /> <span className="gen-dots">generating</span></span>
          <span className="gen-stack-sub">v{nextV}{pct != null ? ` ~${Math.round(pct)}%` : (elapsed ? ` ${elapsed}` : "")}</span>
        </span>
      )}
      {onRegen && (
        <button
          className="vchip regen"
          title={generating ? `Regenerating ${kind}…` : queued ? "Queued — starts when the current run finishes" : `Regenerate ${kind} — keeps previous versions`}
          onClick={onRegen}
          disabled={busy || generating}
        >
          {generating ? <Spinner size={10} /> : <IconRefresh size={10} />}
          {generating ? "working…" : queued ? "queued" : "regen"}
        </button>
      )}
      {action && <span className="versions-action">{action}</span>}
    </div>
  );
}
