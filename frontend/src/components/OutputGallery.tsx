import { useEffect, useRef, useState } from "react";
import { listOutputs, outputUrl, selectMain, uploadRef, uploadKeyframe, type AssetEvent } from "../api";
import type { AssetVersion, MainsInfo, VersionsInfo, AssetKind } from "../types";
import { IconFilm, IconImage, IconRefresh, IconScissors, IconCheck, IconUpload, IconClipboard, IconX, IconExpand, Spinner } from "./Icons";
import Lightbox, { type PreviewItem } from "./Lightbox";

interface Props {
  scenario: string;
  refreshKey: number; // bump to re-list files
  assets?: AssetEvent[]; // live: assets finished so far in the current run
  bare?: boolean; // render without the outer card (for nesting in RunPanel)
  generatingScenario?: string | null; // output dir of the scenario currently being generated
  // Which sections to render: everything, only Reference (embedded in the
  // Scenario Editor under Generate Reference), or everything but Reference.
  section?: "all" | "reference" | "rest";
  regenTarget?: { kind: AssetKind; index?: number } | null; // exact asset a regen run is producing
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
export default function OutputGallery({ scenario, refreshKey, assets, bare, generatingScenario, section = "all", regenTarget, onStitch, onRegen, onUploaded, onEngineSwitch }: Props) {
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

  const readAsDataUrl = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("could not read file"));
      r.readAsDataURL(f);
    });

  const doUpload = async (f: File) => {
    if (!scenario || uploading) return;
    if (!f.type.startsWith("image/")) { setUploadError("not an image file"); return; }
    setUploading(true);
    setUploadError("");
    try {
      const data = await readAsDataUrl(f);
      await uploadRef(scenario, data);
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
  }, [refMode, scenario, uploading, assets]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setFiles([]);
    setVersions({ ref: [], beats: {}, final: [] });
    setMains({ ref: null, beats: {}, final: null });
    setViewFinal(null);
    setError("");
    if (!scenario) return;
    if (!assets) {
      listOutputs(scenario).then((r) => {
        setFiles(r.files);
        setVersions(r.versions);
        setMains(r.mains);
      }).catch((e) => setError(String(e.message || e)));
    }
  }, [scenario, refreshKey, assets]);

  // Sibling engine dir (LTX <-> Wan): when THIS dir is empty, check whether
  // the project's renders live under the other engine, so the empty state
  // can point there instead of looking like nothing was ever generated.
  const isWan = scenario.endsWith("_wan");
  const sibScenario = isWan ? scenario.slice(0, -4) : `${scenario}_wan`;
  const sibLabel = isWan ? "LTX 2.5" : "Wan 2.1";
  const [sibCount, setSibCount] = useState<number | null>(null);
  useEffect(() => {
    setSibCount(null);
    if (assets || bare || section === "reference" || !scenario) return;
    if (files.length > 0) return; // own dir has renders — no need to look
    let cancelled = false;
    listOutputs(sibScenario).then((r) => {
      if (cancelled) return;
      setSibCount((r.files || []).filter((f) => /\.(png|mp4)$/i.test(f)).length);
    }).catch(() => { if (!cancelled) setSibCount(null); });
    return () => { cancelled = true; };
  }, [scenario, sibScenario, files, assets, bare, section]);

  // Live-run view: no versioning UI (versions are created by the run itself).
  if (assets) {
    const live = assets;
    const final = live.find((a) => a.stage === "final")?.file;
    const ref = live.find((a) => a.stage === "reference")?.file;
    const keyframes = live.filter((a) => a.stage === "keyframe").sort(byIndex).map((a) => a.file);
    const clips = live.filter((a) => a.stage === "clip").sort(byIndex).map((a) => a.file);
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
              <ExpandButton title="Fullscreen preview of final cut" onOpen={() => setPreview({ src: outputUrl(scenario, final), kind: "video", alt: "final cut" })} />
              <video controls src={outputUrl(scenario, final)} />
            </div>
          </>
        )}
        {ref && (
          <>
            <div className="section-label">Reference</div>
            <div className="img-frame">
              <ExpandButton title="Fullscreen preview of reference" onOpen={() => setPreview({ src: outputUrl(scenario, ref), kind: "image", alt: "reference" })} />
              <img src={outputUrl(scenario, ref)} alt="reference" loading="lazy" />
            </div>
          </>
        )}
        {keyframes.length > 0 && (
          <>
            <div className="section-label">Keyframes → clips</div>
            <div className="grid">
              {keyframes.map((kf, i) => (
                <div className="shot" key={kf}>
                  <div className="img-frame">
                    <ExpandButton title={`Fullscreen preview of ${pretty(kf)}`} onOpen={() => setPreview({ src: outputUrl(scenario, kf), kind: "image", alt: pretty(kf) })} />
                    <img src={outputUrl(scenario, kf)} alt={pretty(kf)} loading="lazy" />
                  </div>
                  {clips[i] && (
                    <div className="video-frame">
                      <ExpandButton title={`Fullscreen preview of ${pretty(clips[i])}`} onOpen={() => setPreview({ src: outputUrl(scenario, clips[i]), kind: "video", alt: pretty(clips[i]) })} />
                      <video controls src={outputUrl(scenario, clips[i])} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        {mediaCount === 0 && (
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

  // True when the active run is generating into THIS output dir. The version
  // rows then show a blinking "generating vN" chip on the asset that is
  // actually in progress. For regen runs the exact target is known; for full
  // runs it's the first asset in pipeline order (ref -> keyframes -> clips)
  // without a version yet.
  const generating = !!generatingScenario && generatingScenario === scenario;
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

  const pickMain = async (kind: "ref" | "keyframe" | "clip", index: number | null, file: string) => {
    try {
      const r = await selectMain(scenario, kind, index, file);
      setVersions(r.versions);
      setMains(r.mains);
      setFiles(r.files);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doStitch = () => onStitch?.();

  // Upload an image as beat N's keyframe: stored as the next keyframe
  // version and set as main, so a later clip regen runs i2v from it.
  const uploadKf = async (n: number, f: File) => {
    if (!f.type.startsWith("image/")) { setError("not an image file"); return; }
    try {
      const data = await readAsDataUrl(f);
      const r = await uploadKeyframe(scenario, n, data);
      setVersions(r.versions);
      setMains(r.mains);
      setFiles(r.files);
      setError("");
      onUploaded?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Shared Browse / Paste buttons (used in both upload layouts below).
  const browseButton = (
    <button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
      <IconUpload size={11} />
      Browse
    </button>
  );
  const pasteButton = (
    <button
      disabled={uploading}
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
            {mains.ref === v.file && <span className="main-badge"><IconCheck size={10} /> main</span>}
            <ExpandButton title={`Fullscreen preview of ${v.file}`} onOpen={() => setPreview({ src: outputUrl(scenario, v.file), kind: "image", alt: `reference V${v.v}` })} />
            <img
              src={outputUrl(scenario, v.file)}
              alt={`reference V${v.v}`}
              loading="lazy"
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

  const mediaCount = beatNums.length + (refFile ? 1 : 0) + (shownFinal ? 1 : 0);

  const Tag = bare || section === "reference" ? "div" : "section";
  return (
    <Tag className={bare || section === "reference" ? (section === "reference" ? "ref-embed" : undefined) : "card"}>
      {!bare && section !== "reference" && (
        <div className="card-head">
          <h2>
            <span className="head-icon"><IconFilm size={15} /></span>
            Outputs
          </h2>
          <span className="spacer" />
          {hasClips && (
            <button
              onClick={doStitch}
              disabled={generating}
              title={stitching ? "Stitching the final cut…" : "Concatenate the selected main clip versions into the final cut"}
            >
              {stitching ? <Spinner size={12} /> : <IconScissors size={12} />}
              {stitching ? "Stitching…" : "Stitch final"}
            </button>
          )}
          {scenario && (
            <span className="muted" style={{ fontSize: 12, fontFamily: "var(--mono)" }}>
              outputs/{scenario}/
            </span>
          )}
        </div>
      )}

      {error && <p className="hint err-text">{error}</p>}
      {preview && <Lightbox item={preview} onClose={() => setPreview(null)} />}

      {section !== "reference" && shownFinal && (
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
            <ExpandButton title="Fullscreen preview of final cut" onOpen={() => setPreview({ src: outputUrl(scenario, shownFinal), kind: "video", alt: "final cut" })} />
            <video
              key={shownFinal}
              controls
              src={`${outputUrl(scenario, shownFinal)}?v=${encodeURIComponent(shownFinal)}`}
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
      {scenario && section !== "rest" ? (
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
                    <ExpandButton title="Fullscreen preview of reference" onOpen={() => setPreview({ src: outputUrl(scenario, refFile), kind: "image", alt: "reference" })} />
                    <img src={outputUrl(scenario, refFile)} alt="reference" loading="lazy" />
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
      {section !== "reference" && (beatNums.length > 0 || fallbackShots.length > 0) && (
        <>
          <div className="section-label">Keyframes → clips</div>
          <div className="grid">
            {beatNums.map((n) => {
              const bv = versions.beats[String(n)];
              const kfMain = mains.beats[String(n)]?.keyframe || bv.keyframe[bv.keyframe.length - 1]?.file || null;
              const clipMain = mains.beats[String(n)]?.clip || bv.clip[bv.clip.length - 1]?.file || null;
              return (
                <div className="shot" key={n}>
                  <div className="img-frame">
                    {kfMain
                      ? <>
                        <ExpandButton title={`Fullscreen preview of ${pretty(kfMain)}`} onOpen={() => setPreview({ src: outputUrl(scenario, kfMain), kind: "image", alt: pretty(kfMain) })} />
                        <img src={outputUrl(scenario, kfMain)} alt={pretty(kfMain)} loading="lazy" />
                      </>
                      : <div className="frame-missing">no keyframe</div>}
                  </div>
                  {genTarget === `kf:${n}` && !bv.keyframe.length && (
                    <GenChip v={1} />
                  )}
                  <VersionRow
                    versions={bv.keyframe}
                    main={mains.beats[String(n)]?.keyframe}
                    kind="image"
                    onSelect={(f) => pickMain("keyframe", n, f)}
                    onRegen={() => onRegen?.("keyframe", n)}
                    onUpload={(f) => uploadKf(n, f)}
                    generating={genTarget === `kf:${n}`}
                    busy={generating}
                  />
                  <div className="video-frame">
                    {clipMain
                      ? <>
                        <ExpandButton title={`Fullscreen preview of ${pretty(clipMain)}`} onOpen={() => setPreview({ src: outputUrl(scenario, clipMain), kind: "video", alt: pretty(clipMain) })} />
                        <video controls src={outputUrl(scenario, clipMain)} />
                      </>
                      : <div className="frame-missing">no clip</div>}
                  </div>
                  {genTarget === `clip:${n}` && !bv.clip.length && (
                    <GenChip v={1} />
                  )}
                  <VersionRow
                    versions={bv.clip}
                    main={mains.beats[String(n)]?.clip}
                    kind="video"
                    onSelect={(f) => pickMain("clip", n, f)}
                    onRegen={() => onRegen?.("clip", n)}
                    generating={genTarget === `clip:${n}`}
                    busy={generating}
                  />
                </div>
              );
            })}
            {fallbackShots.map(({ kf, clip }) => (
              <div className="shot" key={kf}>
                <div className="img-frame">
                  <img src={outputUrl(scenario, kf)} alt={pretty(kf)} loading="lazy" />
                </div>
                {clip && (
                  <div className="video-frame">
                    <video controls src={outputUrl(scenario, clip)} />
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="hint">
            Pick a version to make it <b>main</b> — the final cut stitches the main version of every beat.
            Regenerate keeps old versions. Upload swaps in your own keyframe image (new version, set as main) —
            regen the clip afterwards to generate video from it.
          </p>
        </>
      )}
      {section !== "reference" && mediaCount === 0 && !generating && (
        <div className="empty">
          <span className="empty-icon">
            <IconImage size={20} />
          </span>
          <span className="empty-title">No outputs yet</span>
          <span className="empty-sub">
            {scenario
              ? "Start a run to see the reference, keyframes, and final cut land here."
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
    </Tag>
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
function VersionRow({ versions, main, kind, onSelect, onRegen, onUpload, generating, busy }: {
  versions: AssetVersion[];
  main: string | null;
  kind: "image" | "video";
  onSelect: (file: string) => void;
  onRegen?: () => void;
  onUpload?: (f: File) => Promise<void>; // keyframes only: swap in your own image
  generating?: boolean; // a run is producing the next version right now
  busy?: boolean; // a run is active in this output dir — regen would be ignored
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
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
      {onUpload && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (inputRef.current) inputRef.current.value = "";
              if (!f) return;
              setUploading(true);
              try { await onUpload(f); } finally { setUploading(false); }
            }}
          />
          <button
            className="vchip regen"
            title={busy ? "A run is already in progress" : "Upload your own image as this keyframe — stored as a new version and set as main; regen the clip to generate video from it"}
            onClick={() => inputRef.current?.click()}
            disabled={busy || uploading}
          >
            {uploading ? <Spinner size={10} /> : <IconUpload size={10} />}
            {uploading ? "uploading…" : "upload"}
          </button>
        </>
      )}
      {onRegen && (
        <button
          className="vchip regen"
          title={busy ? (generating ? `Regenerating ${kind}…` : "A run is already in progress") : `Regenerate ${kind} — keeps previous versions`}
          onClick={onRegen}
          disabled={busy}
        >
          {generating ? <Spinner size={10} /> : <IconRefresh size={10} />}
          {generating ? "generating…" : "regen"}
        </button>
      )}
    </div>
  );
}
