import { useCallback, useEffect, useState } from "react";
import { comfyStatus, getHealth } from "../api";
import type { ComfyStatus, HealthResponse } from "../types";
import { IconBlocks, IconRefresh } from "./Icons";

type Source = "llm" | "comfy" | "db";

interface Row {
  name: string;
  detail: string;
  tag: string;
  // Live source for the status pill (omitted = static entry, no endpoint).
  source?: Source;
  note?: string;
}

interface Section {
  title: string;
  blurb: string;
  rows: Row[];
}

// Every engine behind the app, grouped by job. Live rows read the same
// /api/health + /api/comfy payloads as the topbar pills; the rest are
// static inventory (weights, binaries, fallbacks) with no endpoint to poll.
const SECTIONS: Section[] = [
  {
    title: "AI Language Model",
    blurb: "Local LLM that authors scenarios, directs storyboards and captions resources.",
    rows: [
      {
        name: "llama-server (OpenAI-compatible)",
        detail: "Chat completions at LLM_BASE /v1/chat/completions — AI Craft scenarios, Director bible + ≤12-scene batches, resource captions.",
        tag: "LLM",
        source: "llm",
      },
    ],
  },
  {
    title: "Image & Video — remote ComfyUI box",
    blurb: "RTX 3080 Ti · 12 GB over a reverse-proxy tunnel (COMFY_BASE, serial queue — back-to-back runs reuse VRAM).",
    rows: [
      {
        name: "Flux 2 Klein 9B (FP8)",
        detail: "Text-to-image keyframes + reference visuals; merged Flux→LTX bridge, one queue item per scene.",
        tag: "text → image",
        source: "comfy",
      },
      {
        name: "LTX-2.5 22B distilled (INT8)",
        detail: "Image-to-video clips with AAC audio; half-res latent gen + 2× spatial upsample.",
        tag: "image → video",
        source: "comfy",
      },
      {
        name: "Wan 2.1 14B 480p (Q4_K_M + AccVid LoRA)",
        detail: "Alternate image-to-video engine; video-only at fixed 16 fps into a separate _wan cut.",
        tag: "image → video · alt",
        source: "comfy",
      },
      {
        name: "Text encoders",
        detail: "qwen3 8B (Flux) · gemma4 12B (LTX) · umt5_xxl (Wan) · clip_vision_h.",
        tag: "CLIP",
      },
      {
        name: "VAEs + upscaler",
        detail: "flux2 · ltx-2.5 video/audio · wan_2.1 · ltx-2.5 2× latent spatial upscaler.",
        tag: "VAE",
      },
    ],
  },
  {
    title: "Voice & Music",
    blurb: "Spoken Hindi dialogue, sung songs and instrumental beds.",
    rows: [
      {
        name: "Edge-TTS",
        detail: "hi-IN-SwaraNeural + hi-IN-MadhurNeural voices; per-line timing drives multi-speaker beats.",
        tag: "TTS · service",
      },
      {
        name: "ACE-Step 1.5 XL Turbo",
        detail: "Sung song takes + instrumental narration beds via the ComfyUI Audio workflows.",
        tag: "song",
        source: "comfy",
      },
      {
        name: "MiniMax Music 3",
        detail: "Alternate sung-song engine behind the same Create Song form.",
        tag: "song · alt",
        source: "comfy",
      },
    ],
  },
  {
    title: "Lip-sync",
    blurb: "One engine per dialogue run; beats with no detectable face fall back to dubbed voice instead of failing.",
    rows: [
      {
        name: "Easy-Wav2Lip (local)",
        detail: "Default engine via EASY_WAV2LIP_DIR / EASY_WAV2LIP_PYTHON; segmented per speaker line.",
        tag: "default · local",
      },
      {
        name: "MuseTalk via ComfyUI",
        detail: "MUSETALK_WORKFLOW template with {{VIDEO}} / {{AUDIO}} tokens until a real exported workflow replaces it.",
        tag: "musetalk",
        source: "comfy",
        note: "The UI option stays gated on real tokens, never bare file existence.",
      },
    ],
  },
  {
    title: "Data & Runtime",
    blurb: "Catalog, storage and the glue in between.",
    rows: [
      {
        name: "PostgreSQL",
        detail: "Canonical scenarios catalog, version history, project_assets + reference rows, per-cut video types.",
        tag: "database",
        source: "db",
      },
      {
        name: "SQLite fallback",
        detail: "data/scenarios.sqlite takes over only when USE_SQLITE=true is set.",
        tag: "fallback",
      },
      {
        name: "ffmpeg",
        detail: "Lossless -c copy concat stitch — clips from one run share codec/resolution/fps.",
        tag: "local binary",
      },
      {
        name: "App stack",
        detail: "React + Vite (TS) UI over a zero-dep Node backend; runs stream live via SSE asset events.",
        tag: "frontend",
      },
    ],
  },
];

function liveOf(source: Source, health: HealthResponse | null, comfy: ComfyStatus | null): "up" | "down" | "unknown" {
  if (source === "llm") return !health ? "unknown" : health.llm.up ? "up" : "down";
  if (source === "db") return !health ? "unknown" : health.db.up ? "up" : "down";
  return !comfy ? "unknown" : comfy.up ? "up" : "down";
}

function StatusPill({ state }: { state: "up" | "down" | "unknown" }) {
  if (state === "up")
    return <span className="pill ok"><span className="dot pulse" aria-hidden="true" />Live</span>;
  if (state === "down")
    return <span className="pill err"><span className="dot" aria-hidden="true" />Offline</span>;
  return <span className="pill"><span className="dot" aria-hidden="true" />Checking…</span>;
}

export default function ComponentsPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [comfy, setComfy] = useState<ComfyStatus | null>(null);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const [h, c] = await Promise.all([
        getHealth().catch(() => null as HealthResponse | null),
        comfyStatus().catch(() => null as ComfyStatus | null),
      ]);
      setHealth(h);
      setComfy(c);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const queue = comfy?.queue
    ? (comfy.queue.queue_running?.length ?? 0) + (comfy.queue.queue_pending?.length ?? 0)
    : 0;

  return (
    <div className="cmp">
      <div className="card cmp-hero">
        <div className="card-head">
          <h2>
            <span className="head-icon hi-components" aria-hidden="true"><IconBlocks size={16} /></span>
            Components
          </h2>
          <span className="spacer" />
          <button
            className="ghost"
            onClick={refresh}
            disabled={checking}
            title="Refresh live status"
            aria-label="Refresh live status"
            type="button"
          >
            <IconRefresh size={13} aria-hidden="true" />
            {checking ? "Checking…" : "Refresh"}
          </button>
        </div>
        <p className="card-desc">
          Every engine behind the app — language model, generation box, voices and storage.
          Live rows report real-time status; the rest is static inventory.
        </p>
        <div className="row cmp-overall" role="status" aria-label="Core service status">
          <span className="pill svc svc-llm">
            <span className="svc-code" aria-hidden="true">LLM</span>
            <span className={`dot st-${!health ? "wait" : health.llm.up ? "ok" : "err"}${health?.llm.up ? " pulse" : ""}`} aria-hidden="true" />
            <span>{!health ? "checking…" : health.llm.up ? "live" : "offline"}</span>
          </span>
          <span className="pill svc svc-comfy">
            <span className="svc-code" aria-hidden="true">ComfyUI</span>
            <span className={`dot st-${!comfy ? "wait" : comfy.up ? "ok" : "err"}${comfy?.up ? " pulse" : ""}`} aria-hidden="true" />
            <span>{!comfy ? "checking…" : comfy.up ? `live${queue > 0 ? ` · ${queue} queued` : ""}` : "offline"}</span>
          </span>
          <span className="pill svc svc-db">
            <span className="svc-code" aria-hidden="true">PG</span>
            <span className={`dot st-${!health ? "wait" : health.db.up ? "ok" : "err"}${health?.db.up ? " pulse" : ""}`} aria-hidden="true" />
            <span>{!health ? "checking…" : health.db.up ? "connected" : "offline"}</span>
          </span>
        </div>
      </div>
      {SECTIONS.map((s) => (
        <div className="card" key={s.title}>
          <div className="card-head">
            <h2>{s.title}</h2>
          </div>
          <p className="card-desc">{s.blurb}</p>
          <div>
            {s.rows.map((r) => (
              <div className="cmp-row" key={r.name}>
                <div className="cmp-main">
                  <div className="cmp-name">
                    {r.name}
                    <span className="cmp-tag">{r.tag}</span>
                  </div>
                  <div className="cmp-detail">{r.detail}</div>
                  {r.note && <div className="cmp-note">{r.note}</div>}
                </div>
                {r.source
                  ? <StatusPill state={liveOf(r.source, health, comfy)} />
                  : <span className="pill" title="Static inventory — no endpoint to poll">stock</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
