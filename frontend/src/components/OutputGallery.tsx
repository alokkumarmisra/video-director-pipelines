import { useEffect, useRef, useState } from "react";
import { listOutputs, outputUrl, selectMain, uploadRef, type AssetEvent, type RunRequest } from "../api";
import type { AssetVersion, MainsInfo, VersionsInfo, AssetKind } from "../types";
import { IconClapper, IconFilm, IconImage, IconPanel, IconRefresh, IconScissors, IconCheck, IconUpload, IconClipboard, IconX, IconExpand, Spinner } from "./Icons";
import Lightbox, { type PreviewItem } from "./Lightbox";
import SmoothImage from "./SmoothImage";

interface Props {
  scenario: string;
  refreshKey: number; // bump to re-list files
  assets?: AssetEvent[]; // live: assets finished so far in the current run
  bare?: boolean; // render without the outer card (for nesting in RunPanel)
  generatingScenario?: string | null; // output dir of the scenario currently being generated
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
}

type RefMode = "generate" | "upload";

const pretty = (f: string) =>
  f.replace(/_[a-z]+\d+_.*\.(mp4|png)$/, "")
    .replace(/_/g, " ")
    .trim();

const byIndex = (a: AssetEvent, b: AssetEvent) => (a.index ?? 0) - (b.index ?? 0);

// Gallery of outputs/<scenario>/: ref, keyframes, clips (with version
// pickers + regenerate), final cut.
export default function OutputGallery({ scenario, refreshKey, assets, bare, generatingScenario, section = "all", regenTarget, runQueue = [], onStitch, onRegen, onUploaded, onEngineSwitch, totalScenes }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [versions, setVersions] = useState<VersionsInfo>({ ref: [], beats: {}, final: [] });
  const [mains, setMains] = useState<MainsInfo>({ ref: null, beats: {}, final: null });
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
      setViewFinal(null);
      setLoadedFor("");
      setError("");
      return;
    }
    if (assets) return;
    // Keep the old listing on screen until the new one lands (no blanking).
    let cancelled = false;
    listOutputs(scenario).then((r) => {
      if (cancelled) return;
      setFiles(r.files);
      setVersions(r.versions);
      setMains(r.mains);
      setLoadedFor(scenario);
      setError("");
    }).catch((e) => {
      // A failed background refresh must never wipe already-shown data —
      // keep the stale listing, just surface the error.
      if (!cancelled) setError(String((e as Error).message || e));
    });
    return () => { cancelled = true; };
  }, [scenario, refreshKey, assets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the picked final-cut version only when moving to another project
  // (a refreshKey bump from a fresh stitch keeps working via `shownFinal`
  // falling back to latest when the picked file is gone).
  useEffect(() => { setViewFinal(null); }, [scenario]);

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
    const Tag = bare ? "div" : "section";
    return (
      <Tag className={bare ? undefined : "card"}>
        {bare && <div className="section-label">Generated so far</div>}
        {preview && <Lightbox item={preview} onClose={() => setPreview(null)} />}
        {final && (
          <>
            <div className="section-label">Final cut</div>
            <div className="video-frame">
              <SceneBadge label="FINAL" title="Stitched final cut" />
              <ExpandButton title="Fullscreen preview of final cut" onOpen={() => setPreview({ src: outputUrl(viewScenario, final), kind: "video", alt: "final cut" })} />
              <video controls src={outputUrl(viewScenario, final)} />
            </div>
          </>
        )}
        <>
          <div className="section-label">Reference</div>
          {ref ? (
            <div className="img-frame">
              <SceneBadge label="REF" title="Reference visual" />
              <ExpandButton title="Fullscreen preview of reference" onOpen={() => setPreview({ src: outputUrl(viewScenario, ref), kind: "image", alt: "reference" })} />
              <SmoothImage src={outputUrl(viewScenario, ref)} alt="reference" />
            </div>
          ) : (
            <div className="img-frame">
              <SceneBadge label="REF" title="Reference visual" />
              <div className="frame-missing">
                {liveGenTarget === "ref"
                  ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
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
                return (
                <div className="shot" key={n} title={`Scene ${n} — keyframe image + video clip`}>
                  <div className="shot-head" aria-hidden="true">Scene {n}</div>
                  <div className="img-frame">
                    <SceneBadge scene={n} total={liveTotal} title={`Scene ${n} of ${liveTotal} — keyframe image`} />
                    {kf ? (
                      <>
                        <ExpandButton title={`Fullscreen preview of ${pretty(kf)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, kf), kind: "image", alt: pretty(kf) })} />
                        <SmoothImage src={outputUrl(viewScenario, kf)} alt={pretty(kf)} />
                      </>
                    ) : (
                      <div className="frame-missing">
                        {kfGen
                          ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
                          : <span className="frame-missing-inner"><IconImage size={16} /><span className="muted">Scene {n} · pending</span></span>}
                      </div>
                    )}
                  </div>
                  <div className="video-frame">
                    <SceneBadge small label={liveTotal != null ? `V${n}/${liveTotal}` : `V${n}`} title={`Video ${n}${liveTotal != null ? ` of ${liveTotal}` : ""} — clip`} />
                    {clip ? (
                      <>
                        <ExpandButton title={`Fullscreen preview of ${pretty(clip)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, clip), kind: "video", alt: pretty(clip) })} />
                        <video controls src={outputUrl(viewScenario, clip)} />
                      </>
                    ) : (
                      <div className="frame-missing">
                        {clipGen
                          ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
                          : <span className="frame-missing-inner"><IconFilm size={16} /><span className="muted">Video {n} · pending</span></span>}
                      </div>
                    )}
                  </div>
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
  // into the suffixed dir, so both forms match.
  const generating = !!generatingScenario && !!viewScenario &&
    (generatingScenario === viewScenario || `${generatingScenario}_wan` === viewScenario);
  const genTarget = (() => {
    if (!generating) return null;
    if (regenTarget) {
      if (regenTarget.kind === "ref") return "ref";
      if (regenTarget.kind === "keyframe") return `kf:${regenTarget.index}`;
      if (regenTarget.kind === "clip") return `clip:${regenTarget.index}`;
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
            title={mains.ref === v.file ? `${v.file} (main)` : `Set ${v.file} as main`}
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
              <span className="gen-flag"><span className="dot pulse" /> generating…</span>
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
  // the new final clip shows on its own. An explicit older pick is kept.
  const prevLatestFinal = useRef<string | null>(null);
  useEffect(() => {
    if (prevLatestFinal.current !== null && latestFinal && latestFinal !== prevLatestFinal.current) {
      const prev = prevLatestFinal.current;
      setViewFinal((v) => (v === null || v === prev ? null : v));
    }
    prevLatestFinal.current = latestFinal;
  });

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

      {!(isCard && collapsed) && (
      <>
      {error && <p className="hint err-text">{error}</p>}
      {preview && <Lightbox item={preview} onClose={() => setPreview(null)} />}

      {(section === "all" || section === "output") && (curKf || curClip || generating || shownFinal) && (
        <>
          {(curKf || curClip || generating) && (
            <>
              <div className="section-label">Current image & video</div>
              <div className="grid">
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
                        ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
                        : <span className="frame-missing-inner"><IconImage size={16} /><span className="muted">pending</span></span>}
                    </div>
                  )}
                </div>
                <div className="video-frame" title={curClip ? `Current video — video ${curClip.n} clip` : "Current video"}>
                  {curClip && <SceneBadge small label={sceneNums.length ? `V${curClip.n}/${sceneNums.length}` : `V${curClip.n}`} title={`Video ${curClip.n} — current clip`} />}
                  {curClip ? (
                    <video controls preload="metadata" src={outputUrl(viewScenario, curClip.file)} />
                  ) : (
                    <div className="frame-missing">
                      {clipGen
                        ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
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
              <div className="video-frame">
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
                      onClick={() => setViewFinal(v.file)}
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
          <div className="section-label">
            Reference
            {versions.ref.length > 1 && <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}> · {versions.ref.length} versions</span>}
          </div>
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
        </>
      ) : null}
      {(section === "all" || section === "beats") && (sceneNums.length > 0 || fallbackShots.length > 0) && (
        <>
          {/* The Keyframes card header already carries this title. */}
          {!isBeats && <div className="section-label">Keyframes → clips</div>}
          <div className="grid grid-compact">
            {(() => {
            const total = sceneNums.length;
            return sceneNums.map((n) => {
              const bv = versions.beats[String(n)] ?? { keyframe: [], clip: [] };
              const kfMain = mains.beats[String(n)]?.keyframe || bv.keyframe[bv.keyframe.length - 1]?.file || null;
              const clipMain = mains.beats[String(n)]?.clip || bv.clip[bv.clip.length - 1]?.file || null;
              const kfV = kfMain ? bv.keyframe.find((v) => v.file === kfMain)?.v ?? null : null;
              const clipV = clipMain ? bv.clip.find((v) => v.file === clipMain)?.v ?? null : null;
              const kfGen = genTarget === `kf:${n}`;
              const clipGen = genTarget === `clip:${n}`;
              return (
                <div className="shot" key={n} title={`Scene ${n} — keyframe image + video clip`}>
                  <div className="shot-head" aria-hidden="true">Scene {n}</div>
                  <div className="img-frame">
                    <SceneBadge scene={n} total={total} title={`Scene ${n} of ${total} — keyframe image`} />
                    {kfMain
                      ? <>
                        {kfV != null && (
                          <span className="ver-badge" title={`Scene ${n} keyframe v${kfV} (main)`}>v{kfV}</span>
                        )}
                        <ExpandButton title={`Fullscreen preview of ${pretty(kfMain)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, kfMain), kind: "image", alt: pretty(kfMain) })} />
                        <SmoothImage src={outputUrl(viewScenario, kfMain)} alt={pretty(kfMain)} />
                      </>
                      : <div className="frame-missing">
                          {kfGen
                            ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
                            : <span className="frame-missing-inner"><IconImage size={16} /><span className="muted">Scene {n} · pending</span></span>}
                        </div>}
                  </div>
                  {kfGen && !bv.keyframe.length && (
                    <GenChip v={1} />
                  )}
                  <VersionRow
                    versions={bv.keyframe}
                    main={mains.beats[String(n)]?.keyframe}
                    kind="image"
                    onSelect={(f) => pickMain("keyframe", n, f)}
                    onRegen={() => onRegen?.("keyframe", n)}
                    generating={kfGen}
                    busy={switchingGallery}
                    queued={!generating && queuedRegen("keyframe", n)}
                  />
                  {clipMain ? (
                    <div className="shot-clip-frame">
                      <SceneBadge small label={`V${n}/${total}`} title={`Video ${n} of ${total} — clip`} />
                      {clipV != null && (
                        <span className="ver-badge" title={`Scene ${n} clip v${clipV} (main)`}>v{clipV}</span>
                      )}
                      <video controls preload="metadata" src={outputUrl(viewScenario, clipMain)} className="shot-clip-bare" />
                    </div>
                  ) : (
                    <div className="video-frame">
                      <SceneBadge small label={`V${n}/${total}`} title={`Video ${n} of ${total} — clip`} />
                      <div className="frame-missing">
                        {clipGen
                          ? <span className="gen-flag"><span className="dot pulse" /> generating…</span>
                          : <span className="frame-missing-inner"><IconFilm size={16} /><span className="muted">Video {n} · pending</span></span>}
                      </div>
                    </div>
                  )}
                  {clipGen && !bv.clip.length && (
                    <GenChip v={1} />
                  )}
                  <VersionRow
                    versions={bv.clip}
                    main={mains.beats[String(n)]?.clip}
                    kind="video"
                    onSelect={(f) => pickMain("clip", n, f)}
                    onRegen={() => onRegen?.("clip", n)}
                    generating={clipGen}
                    busy={switchingGallery}
                    queued={!generating && queuedRegen("clip", n)}
                  />
                </div>
              );
            });
            })()}
            {fallbackShots.map(({ kf, clip }, fi) => {
              const m = kf.match(/_seq(\d+)_/);
              const fn = m ? Number(m[1]) : fi + 1;
              return (
              <div className="shot" key={kf} title={`Scene ${fn} — keyframe image + video clip`}>
                <div className="shot-head" aria-hidden="true">Scene {fn}</div>
                <div className="img-frame">
                  <SceneBadge scene={fn} total={fallbackShots.length} title={`Scene ${fn} of ${fallbackShots.length} — keyframe image`} />
                  <ExpandButton title={`Fullscreen preview of ${pretty(kf)}`} onOpen={() => setPreview({ src: outputUrl(viewScenario, kf), kind: "image", alt: pretty(kf) })} />
                  <SmoothImage src={outputUrl(viewScenario, kf)} alt={pretty(kf)} />
                </div>
                {clip && (
                  <div className="shot-clip-frame">
                    <SceneBadge small label={`V${fn}/${fallbackShots.length}`} title={`Video ${fn} of ${fallbackShots.length} — clip`} />
                    <video controls preload="metadata" src={outputUrl(viewScenario, clip)} className="shot-clip-bare" />
                  </div>
                )}
              </div>
              );
            })}
          </div>
          <p className="hint">
            Pick a version to make it <b>main</b> — the final cut stitches the main version of every beat.
            Regenerate keeps old versions; regen the clip afterwards to generate video from the main keyframe.
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
      </>
      )}
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
  return (
    <span className={`scene-badge${small ? " scene-badge-sm" : ""}`} title={title ?? `Scene ${scene} of ${total}`}>
      {text}
    </span>
  );
}

// Expand button overlaying a frame corner — opens the fullscreen Lightbox.
function ExpandButton({ title, onOpen }: { title: string; onOpen: () => void }) {
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
// producing this version; previous versions are kept.
function GenChip({ v }: { v: number }) {
  return (
    <div className="versions">
      <span className="vchip gen" title={`Generating v${v} — previous versions are kept`}>
        <span className="dot pulse" />
        v{v} generating
      </span>
    </div>
  );
}

// Version chips (v1, v2, …) + regenerate button for one versioned asset.
function VersionRow({ versions, main, kind, onSelect, onRegen, generating, busy, queued }: {
  versions: AssetVersion[];
  main: string | null;
  kind: "image" | "video";
  onSelect: (file: string) => void;
  onRegen?: () => void;
  generating?: boolean; // a run is producing the next version right now
  busy?: boolean; // gallery is mid-switch — regen would hit the wrong dir
  queued?: boolean; // a regen is queued behind the active run
}) {
  if (versions.length === 0) return null;
  const nextV = versions[versions.length - 1].v + 1;
  return (
    <div className="versions">
      {versions.map((v) => (
        <button
          key={v.file}
          className={`vchip ${main === v.file ? "on" : ""}`}
          title={main === v.file ? `${v.file} (main — used in stitch)` : `Set ${v.file} as main`}
          onClick={() => onSelect(v.file)}
        >
          {main === v.file && <IconCheck size={10} />}
          v{v.v}
        </button>
      ))}
      {generating && (
        <span className="vchip gen" title={`Generating v${nextV} — previous versions are kept`}>
          <span className="dot pulse" />
          v{nextV} generating
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
          {generating ? "generating…" : queued ? "queued" : "regen"}
        </button>
      )}
    </div>
  );
}
