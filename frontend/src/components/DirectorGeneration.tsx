import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  folderOf, getScenario, listScenarios, outScenario, saveScenario, slugFolder,
  type Engine, type RegenSpec, type RunRequest, type VideoFormat, type VideoType,
} from "../api";
import type { AssetKind } from "../types";
import type { Scenario } from "../types";
import type { GenerationProgress } from "./GenerationProgressBar";
import { emptyProgress } from "./GenerationProgressBar";
import RunPanel from "./RunPanel";
import GenerateReference from "./GenerateReference";
import OutputGallery from "./OutputGallery";
import InstagramCut from "./InstagramCut";

interface Props {
  /** Linked project display name (board.scenarioName). Empty = not approved yet. */
  projectName: string | null;
  /** Board scenes (for the multi-shot header pill only — generation itself
      reads the approved project's flattened shot-beats, one beat per shot). */
  boardScenes?: { scene_number: number; shots?: { shot_id?: unknown }[] }[];
  /** Open the linked project in the full workspace (optional). */
  onOpenProject?: (name: string) => void;
}

const sameRequest = (a: RunRequest, b: RunRequest) =>
  JSON.stringify(a) === JSON.stringify(b);

// Generation section for the Director page — a copy of the workspace's
// Render Clip (RunPanel) + Generate Reference + Keyframes → clips + the
// YouTube/Instagram cut switch, scoped to the board's linked project.
// Fully self-contained (own engine/cut/queue state) so the workspace flow
// is untouched. Multi-shot scenes need no special casing here: APPROVE
// already flattens each shot to one generation beat (scene_N_a/b/…), so the
// beats gallery naturally renders one image + clip per shot.
export default function DirectorGeneration({ projectName, boardScenes = [], onOpenProject }: Props) {
  const [engine, setEngine] = useState<Engine>("ltx");
  const [videoType, setVideoType] = useState<VideoType>("YOUTUBE");
  const [folder, setFolder] = useState("");
  const [cfg, setCfg] = useState<Scenario | null>(null);
  const [refPrompt, setRefPrompt] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Run wiring (mirrors App's workspace queue, scoped to this panel).
  const [runActive, setRunActive] = useState(false);
  const [runScenario, setRunScenario] = useState<string | null>(null);
  const [runFormat, setRunFormat] = useState<VideoFormat>("landscape");
  const [regenTarget, setRegenTarget] = useState<{ kind: AssetKind; index?: number } | null>(null);
  const [pendingRun, setPendingRun] = useState<{
    nonce: number; stitch?: boolean; regen?: RegenSpec | null; count?: number;
    engine?: Engine; format?: VideoFormat; mode?: "dialogue" | "song";
    beats?: string; noStitch?: boolean;
  } | null>(null);
  const [runQueue, setRunQueue] = useState<RunRequest[]>([]);
  const [genProgress, setGenProgress] = useState<GenerationProgress>(emptyProgress);

  const cutFormat: VideoFormat = videoType === "INSTAGRAM" ? "vertical" : "landscape";
  const cutDir = folder ? outScenario(folder, engine, cutFormat) : "";
  const runFolderBase = runActive && runScenario ? slugFolder(runScenario) : null;

  const changeVideoType = (v: VideoType) => {
    setVideoType(v);
    try { localStorage.setItem(`ss-video-type:${folder}`, v); } catch { /* ignore */ }
  };

  // Resolve storage folder + scenario config for the linked project.
  useEffect(() => {
    if (!projectName) {
      setFolder("");
      setCfg(null);
      setRefPrompt("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await listScenarios().catch(() => []);
        if (cancelled) return;
        const hit = (list ?? []).find((s) => s.name === projectName);
        setFolder(hit ? folderOf(hit, projectName) : slugFolder(projectName));
      } catch {
        if (!cancelled) setFolder(slugFolder(projectName));
      }
      try {
        const sc = await getScenario(projectName);
        if (cancelled) return;
        setCfg(sc.config);
        setRefPrompt(String((sc.config as Scenario)?.referencePrompt ?? ""));
      } catch {
        if (!cancelled) setCfg(null);
      }
    })();
    return () => { cancelled = true; };
  }, [projectName]);

  // Restore the per-project cut facing (same key as the workspace).
  useEffect(() => {
    if (!folder) return;
    try {
      setVideoType(localStorage.getItem(`ss-video-type:${folder}`) === "INSTAGRAM" ? "INSTAGRAM" : "YOUTUBE");
    } catch { setVideoType("YOUTUBE"); }
  }, [folder]);

  const requestRun = (spec: RunRequest) => {
    const item: RunRequest = {
      stitch: !!spec.stitch,
      regen: spec.regen ?? null,
      count: spec.count ?? 1,
      engine: spec.engine ?? engine,
      format: spec.format ?? "landscape",
      mode: spec.mode,
      beats: spec.beats,
      noStitch: !!spec.noStitch,
    };
    if (runActive) {
      setRunQueue((q) => (q.some((x) => sameRequest(x, item)) ? q : [...q, item]));
    } else {
      setPendingRun({ nonce: Date.now(), ...item });
    }
  };

  const runActivePrev = useRef(false);
  useEffect(() => {
    if (runActivePrev.current && !runActive && runQueue.length > 0) {
      const [next, ...rest] = runQueue;
      setRunQueue(rest);
      setPendingRun({ nonce: Date.now(), ...next });
    }
    runActivePrev.current = runActive;
  }, [runActive, runQueue]);

  const handleRegen = (kind: AssetKind, index: number | null, format?: VideoFormat) =>
    requestRun({ regen: { kind, index: index ?? undefined }, ...(format ? { format } : {}) });

  const handleBulkRegen = (kind: "keyframe" | "clip" | "both", indices: number[], format?: VideoFormat) => {
    const scenes = [...new Set(indices.filter((n) => Number.isFinite(n) && (n as number) > 0))].sort((a, b) => a - b);
    if (!scenes.length) return;
    const items: RunRequest[] = [];
    for (const n of scenes) {
      if (kind === "both") {
        items.push({ regen: { kind: "keyframe", index: n }, ...(format ? { format } : {}) });
        items.push({ regen: { kind: "clip", index: n }, ...(format ? { format } : {}) });
      } else {
        items.push({ regen: { kind, index: n }, ...(format ? { format } : {}) });
      }
    }
    if (runActive) {
      setRunQueue((q) => {
        const next = [...q];
        for (const item of items) {
          if (!next.some((x) => sameRequest(x, item))) next.push(item);
        }
        return next;
      });
    } else {
      const [first, ...rest] = items;
      setRunQueue((q) => {
        const next = [...q];
        for (const item of rest) {
          if (!next.some((x) => sameRequest(x, item))) next.push(item);
        }
        return next;
      });
      setPendingRun({ nonce: Date.now(), ...first });
    }
  };

  // Generate Reference save-first (same as the workspace): generation reads
  // the saved prompt, so persist the box text before queueing the ref run.
  const handleGenerateRef = async (count: number) => {
    if (!projectName || !cfg) {
      requestRun({ regen: { kind: "ref" }, count, ...(cutFormat === "vertical" ? { format: "vertical" as VideoFormat } : {}) });
      return;
    }
    const merged: Scenario = { ...cfg, referencePrompt: refPrompt };
    try {
      await saveScenario(projectName, merged);
      setCfg(merged);
    } catch {
      // Queue anyway — the run will use the last saved prompt.
    }
    requestRun({ regen: { kind: "ref" }, count, ...(cutFormat === "vertical" ? { format: "vertical" as VideoFormat } : {}) });
  };

  const totalScenes = useMemo(() => {
    if (cfg && Array.isArray((cfg as Scenario).sequence)) return (cfg as Scenario).sequence.length;
    return null;
  }, [cfg]);

  // Shot-aware header: beats group by scene_number (flattened shots share
  // one scene_number with distinct shot_ids). Falls back to the board plan
  // while the config is still loading.
  const shotInfo = useMemo(() => {
    const seq = (cfg as Scenario | null)?.sequence;
    if (Array.isArray(seq) && seq.length) {
      const byScene = new Map<number, number>();
      for (const b of seq) {
        const sn = Number((b as { scene_number?: unknown })?.scene_number);
        if (Number.isFinite(sn) && sn > 0) byScene.set(sn, (byScene.get(sn) ?? 0) + 1);
      }
      if (byScene.size) {
        const multi = [...byScene.values()].filter((c) => c > 1).length;
        return { scenes: byScene.size, beats: seq.length, multi };
      }
      return { scenes: seq.length, beats: seq.length, multi: 0 };
    }
    const scenes = boardScenes.length;
    const beats = boardScenes.reduce((a, s) => a + Math.max(1, s.shots?.length ?? 0), 0);
    return { scenes, beats, multi: boardScenes.filter((s) => (s.shots?.length ?? 0) > 1).length };
  }, [cfg, boardScenes]);

  const refGenerating =
    runActive && regenTarget?.kind === "ref" && !!projectName && runScenario === projectName;

  if (!projectName) return null;

  return (
    <section className="card" aria-label={`Generation for ${projectName}`} style={{ marginTop: 12 }}>
      <div className="card-head">
        <h2>🎬 Generation — {projectName}</h2>
        <span className="pill" title="Multi-shot scenes flatten to one image + video clip per shot">
          🎞 {shotInfo.scenes} scenes · {shotInfo.beats} shots/beats{shotInfo.multi ? ` · ${shotInfo.multi} multi-shot` : ""}
        </span>
        <span className="spacer" />
        {onOpenProject && (
          <button className="ghost" onClick={() => onOpenProject(projectName)} title={`Open ${projectName} in the full workspace`}>
            Open workspace
          </button>
        )}
      </div>
      <p className="card-desc">
        Render Clip + Reference + Keyframes → clips for this storyboard's project — same pipeline as the workspace.
        Each timed shot renders its own keyframe + clip.
      </p>

      <RunPanel
        scenario={projectName}
        folder={folder}
        engine={engine}
        onEngine={setEngine}
        videoType={videoType}
        onVideoType={changeVideoType}
        onDone={refresh}
        onStatus={(s, sc, regen, format) => {
          setRunActive(s === "running");
          setRunScenario(s === "running" ? sc : null);
          setRunFormat(s === "running" ? (format ?? "landscape") : "landscape");
          setRegenTarget(s === "running" ? regen : null);
        }}
        pendingRun={pendingRun}
        onProgress={setGenProgress}
      />

      <div style={{ marginTop: 12 }}>
        <GenerateReference
          referencePrompt={refPrompt}
          onReferencePromptChange={setRefPrompt}
          onGenerateRef={(n) => void handleGenerateRef(n)}
          refBusy={runActive}
          refGenerating={refGenerating}
          isDraft={false}
          referenceSlot={cutDir ? (
            <OutputGallery
              key={`dir-ref:${cutDir}`}
              scenario={cutDir}
              refreshKey={refreshKey}
              section="reference"
              generatingScenario={runFolderBase}
              generatingFormat={runActive ? runFormat : null}
              regenTarget={runActive ? regenTarget : null}
              runQueue={runQueue}
              onRegen={(kind, index) => handleRegen(kind, index, cutFormat === "vertical" ? "vertical" : undefined)}
              onUploaded={refresh}
            />
          ) : null}
        />
      </div>

      {cutDir ? (
        <div style={{ marginTop: 12 }}>
          <OutputGallery
            key={`dir-beats:${cutDir}`}
            scenario={cutDir}
            refreshKey={refreshKey}
            section="beats"
            generatingScenario={runFolderBase}
            generatingFormat={runActive ? runFormat : null}
            regenTarget={runActive ? regenTarget : null}
            runQueue={runQueue}
            onRegen={(kind, index) => handleRegen(kind, index, cutFormat === "vertical" ? "vertical" : undefined)}
            onBulkRegen={(kind, indices) => handleBulkRegen(kind, indices, cutFormat === "vertical" ? "vertical" : undefined)}
            onUploaded={refresh}
            totalScenes={totalScenes}
            beats={cfg && Array.isArray((cfg as Scenario).sequence) ? (cfg as Scenario).sequence : null}
            progress={genProgress}
            projectName={projectName}
            dialogueEngine={engine}
            dialogueFormat={cutFormat}
            onDialogueSaved={() => {
              getScenario(projectName).then((r) => {
                setCfg(r.config);
                setRefPrompt(String((r.config as Scenario)?.referencePrompt ?? ""));
              }).catch(() => {});
              refresh();
            }}
          />
        </div>
      ) : null}

      {videoType === "INSTAGRAM" && folder && (
        <div style={{ marginTop: 12 }}>
          <InstagramCut
            scenario={folder}
            engine={engine}
            refreshKey={refreshKey}
            totalScenes={totalScenes}
            runBusy={runActive}
            verticalGenerating={runActive && runFormat === "vertical" && runScenario === projectName}
            onCreate={() => requestRun({ format: "vertical" })}
          />
        </div>
      )}
    </section>
  );
}
