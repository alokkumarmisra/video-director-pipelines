import { useEffect, useRef, useState } from "react";
import { startRun, killRun, tailRun, outScenario, type AssetEvent, type Engine, type RegenSpec } from "../api";
import OutputGallery from "./OutputGallery";
import { IconPlay, IconScissors, IconStop, IconTerminal, Spinner } from "./Icons";

export type RunStatus = "idle" | "running" | "done" | "error";

interface Props {
  scenario: string;
  engine: Engine;
  onEngine: (e: Engine) => void;
  onDone: () => void;
  // Status reports the regen spec of the run that is actually active
  // (null for full runs) — so the gallery/editor can spin exactly the
  // button that triggered it instead of every busy-looking button.
  onStatus?: (s: RunStatus, scenario: string, regen: RegenSpec | null) => void;
  // External run trigger (Stitch final / Regenerate from the output gallery /
  // Generate Reference from the scenario editor; count batches ref regens).
  pendingRun: { nonce: number; stitch?: boolean; regen?: RegenSpec | null; count?: number } | null;
}

const STAGES = ["Reference", "Keyframes", "Clips", "Stitch"];

// Start / stitch / stop a run + live log tail (SSE) + live asset gallery.
export default function RunPanel({ scenario, engine, onEngine, onDone, onStatus, pendingRun }: Props) {
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  // Scenario this panel's run is generating (captured at start, so it stays
  // correct even if the user switches scenarios mid-run). runRegen is the
  // trigger of the active run (null = full run) — reported via onStatus so
  // App never has to guess from a stale pendingRun.
  const [runScenario, setRunScenario] = useState<string | null>(null);
  const [runRegen, setRunRegen] = useState<RegenSpec | null>(null);
  // Which local button started the POST (null = triggered externally via
  // pendingRun, or idle). Shows the spinner on the clicked button during
  // the startRun round-trip, before status flips to "running".
  const [starting, setStarting] = useState<"run" | "stitch" | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => { onStatus?.(status, runScenario ?? scenario, status === "running" ? runRegen : null); }, [status, onStatus, runScenario, runRegen, scenario]);
  useEffect(() => { if (status !== "running") setStopping(false); }, [status]);
  const [log, setLog] = useState("");
  const [assets, setAssets] = useState<AssetEvent[]>([]);
  const closeTail = useRef<() => void>(() => {});
  const boxRef = useRef<HTMLPreElement>(null);

  useEffect(() => () => closeTail.current(), []);
  useEffect(() => {
    boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [log]);

  const begin = async (stitch: boolean, regen: RegenSpec | null = null, count = 1, which: "run" | "stitch" | "external" = "external") => {
    if (!scenario) return;
    if (which !== "external") setStarting(which);
    try {
      const res = await startRun(scenario, { stitch, regen, engine, count });
      if (!res.id) throw new Error(res.error || "run rejected by server");
      const { id } = res;
      setRunId(id);
      setRunScenario(scenario);
      setRunRegen(regen);
      setStatus("running");
      setLog("");
      setAssets([]);
      closeTail.current();
      closeTail.current = tailRun(
        id,
        (line) => setLog((l) => l + line),
        (s) => { setStatus(s === "done" ? "done" : "error"); onDone(); },
        (a) => setAssets((prev) => prev.some((x) => x.file === a.file) ? prev : [...prev, a])
      );
    } catch (e) {
      setStatus("error");
      setLog(`run failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
    } finally {
      setStarting(null);
    }
  };

  // Runs triggered from the output gallery (stitch / regenerate) or the
  // scenario editor (batch reference generation).
  useEffect(() => {
    if (pendingRun) begin(!!pendingRun.stitch, pendingRun.regen || null, pendingRun.count ?? 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRun?.nonce]);

  // Derive a coarse stage from the live asset stream.
  const stage =
    assets.some((a) => a.stage === "final") ? 3 :
    assets.some((a) => a.stage === "clip") ? 2 :
    assets.some((a) => a.stage === "keyframe") ? 1 :
    assets.some((a) => a.stage === "reference") ? 0.5 : 0;
  const pct = Math.min(100, (stage / 3) * 100);

  const statusPill = {
    idle: <span className="pill">idle</span>,
    running: (
      <span className="pill running">
        <Spinner size={11} />
        running{runScenario && runScenario !== scenario ? ` · ${runScenario}` : ""}
      </span>
    ),
    done: <span className="pill done">done</span>,
    error: <span className="pill error">error</span>,
  }[status];

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <span className="head-icon"><IconTerminal size={15} /></span>
          Run
        </h2>
        <span className="spacer" />
        <span className="seg" title="i2v engine">
          <button className={engine === "ltx" ? "on" : ""} onClick={() => onEngine("ltx")}>
            LTX 2.5
          </button>
          <button className={engine === "wan" ? "on" : ""} onClick={() => onEngine("wan")}>
            Wan 2.1
          </button>
        </span>
        {statusPill}
      </div>

      {status === "running" && (
        <div className="progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="progress-meta">
            <span>{STAGES[Math.min(3, Math.floor(stage))]}…</span>
            <span className="muted">{assets.length} asset{assets.length === 1 ? "" : "s"}</span>
          </div>
        </div>
      )}

      <div className="row">
        <button className="primary" onClick={() => begin(false, null, 1, "run")} disabled={status === "running" || starting !== null || !scenario}>
          {starting === "run" ? <Spinner size={12} /> : <IconPlay size={12} />}
          {starting === "run" ? "Starting…" : "Generate"}
        </button>
        <button onClick={() => begin(true, null, 1, "stitch")} disabled={status === "running" || starting !== null || !scenario}>
          {starting === "stitch" ? <Spinner size={12} /> : <IconScissors size={12} />}
          {starting === "stitch" ? "Starting…" : "Stitch only"}
        </button>
        <button
          className="danger"
          disabled={status !== "running" || !runId || stopping}
          onClick={async () => {
            if (!runId || stopping) return;
            setStopping(true);
            try {
              await killRun(runId);
            } catch {
              setStopping(false);
            }
          }}
        >
          {stopping ? <Spinner size={12} /> : <IconStop size={12} />}
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
      {!scenario && (
        <p className="hint">Select or save a scenario first, then start a run.</p>
      )}

      <pre ref={boxRef} className="log">
        {log || <span className="log-empty">— log will stream here once a run starts —</span>}
      </pre>

      {assets.length > 0 && (
        <OutputGallery scenario={outScenario(scenario, engine)} refreshKey={0} assets={assets} bare />
      )}
    </section>
  );
}
