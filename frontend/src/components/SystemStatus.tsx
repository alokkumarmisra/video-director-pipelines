import type { HealthResponse } from "../types";

function StatusItem({ label, up, detail }: { label: string; up: boolean | null; detail?: string }) {
  const text = up == null ? "Checking" : up ? "Connected" : "Offline";
  return (
    <span className="sys-item" title={detail ?? ""}>
      <span className={`dot ${up ? "pulse" : ""}`} aria-hidden="true" />
      <span className="sys-label">{label}</span>
      <span className={`sys-state ${up == null ? "" : up ? "ok" : "err"}`}>{text}</span>
    </span>
  );
}

// Real service availability. Each service fails independently — an offline
// LLM/ComfyUI never blocks project data (that comes from /api/dashboard).
export default function SystemStatus({ health }: { health: HealthResponse | null }) {
  const queue = health?.comfy.up
    ? (health.comfy.queueRunning ?? 0) + (health.comfy.queuePending ?? 0)
    : null;
  return (
    <div className="sys-status" role="status" aria-label="System status">
      <StatusItem label="PostgreSQL" up={health ? health.db.up : null} />
      <StatusItem
        label="LM Studio"
        up={health ? health.llm.up : null}
        detail={health?.llm.error}
      />
      <StatusItem
        label="ComfyUI"
        up={health ? health.comfy.up : null}
        detail={health?.comfy.error ?? (queue ? `${queue} queued` : undefined)}
      />
    </div>
  );
}
