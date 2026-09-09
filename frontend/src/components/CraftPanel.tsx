import { useEffect, useState } from "react";
import type { Scenario, ScenarioInfo } from "../types";
import { fmtDateTime } from "../api";
import { IconSparkles, Spinner } from "./Icons";

interface Props {
  onCrafted: (name: string, config: Scenario, meta: { topic: string; requirements: string }, project_id?: number | null) => void;
  // Existing workflow (scenario) JSONs + which one is selected, so the user
  // can switch to another workflow (or clear the selection) without
  // refreshing the page.
  scenarios: ScenarioInfo[];
  selected: string;
  onSelect: (name: string) => void;
  // What the selected scenario/draft was crafted from — the boxes fill with
  // these on selection (key "saved:<name>"), clear on "(new)".
  contextKey: string;
  contextTopic: string;
  contextReqs: string;
}

// High-level topic + requirements -> local LLM crafts a scenario JSON.
export default function CraftPanel({ onCrafted, scenarios, selected, onSelect, contextKey, contextTopic, contextReqs }: Props) {
  const [topic, setTopic] = useState("");
  const [reqs, setReqs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);

  // Show what the selected scenario was crafted from. Local typing never
  // retriggers this (props only change on selection / loaded data) — and
  // drafts are skipped so the post-craft clear stays cleared.
  useEffect(() => {
    if (!contextKey.startsWith("saved:") && contextKey !== "new") return;
    setTopic(contextTopic);
    setReqs(contextReqs);
  }, [contextKey, contextTopic, contextReqs]);

  const selInfo = scenarios.find((s) => s.name === selected);

  const craft = async () => {
    setBusy(true);
    setError("");
    setSeconds(0);
    const t0 = Date.now();
    const tick = setInterval(() => setSeconds((Date.now() - t0) / 1000), 500);
    try {
      const r = await fetch("/api/craft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, requirements: reqs }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onCrafted(d.name, d.config, { topic, requirements: reqs }, d.project_id ?? null);
      setTopic("");
      setReqs("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearInterval(tick);
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <span className="head-icon"><IconSparkles size={15} /></span>
          AI Craft
        </h2>
        {busy && (
          <span className="pill running">
            <Spinner size={11} />
            {Math.round(seconds)}s
          </span>
        )}
      </div>

      <div className="workflow-head">
        <label>Workflow</label>
        {selInfo && (
          <span
            className="muted workflow-dt"
            title="Last edited"
          >
            {fmtDateTime(selInfo.mtimeMs)}
          </span>
        )}
      </div>
      <select
        value={selected}
        onChange={(e) => onSelect(e.target.value)}
        disabled={busy}
        title="Pick a workflow (scenario JSON), or clear the selection"
      >
        <option value="">(new)</option>
        {scenarios.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>

      <label>High-level topic</label>
      <input
        value={topic}
        placeholder="e.g. a cyberpunk street medic in Neo-Mumbai"
        onChange={(e) => setTopic(e.target.value)}
        disabled={busy}
      />
      <label>Requirements — style, mood, beats, length…</label>
      <textarea
        rows={3}
        value={reqs}
        placeholder="e.g. neo-noir, rain, 4 beats: arrival, surgery, escape, dawn on the roof"
        onChange={(e) => setReqs(e.target.value)}
        disabled={busy}
      />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={craft} disabled={busy || !topic.trim()}>
          {busy ? <Spinner size={13} /> : <IconSparkles size={13} />}
          {busy ? "Crafting…" : "Craft scenario"}
        </button>
      </div>
      {error && <p className="hint err-text">{error}</p>}
      <p className="hint">
        The LLM drafts a full scenario below with its topic, requirements and all
        prompts — review it, then Save scenario to store it as v1.
      </p>
    </section>
  );
}
