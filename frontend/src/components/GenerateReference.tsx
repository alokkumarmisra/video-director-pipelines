import { useState, type ReactNode } from "react";
import { IconPanel, IconSparkles, Spinner } from "./Icons";

interface Props {
  // Effective reference prompt (saved config + any unsaved edits from this
  // card). Edits are held by the parent and merged into the scenario on
  // explicit Save in the Scenario Editor — nothing saves automatically.
  referencePrompt: string;
  onReferencePromptChange: (v: string) => void;
  // Batch-generate reference images from the reference prompt (needs a saved
  // scenario — generation reads prompts/<name>.json). Disabled while a run is
  // active (the ComfyUI queue is serial).
  onGenerateRef: (count: number) => void;
  refBusy?: boolean;
  // True while a reference-only regen run for THIS scenario is active.
  // refBusy disables the button during any run (queue is serial);
  // refGenerating spins it — other runs must not light up this button.
  refGenerating?: boolean;
  isDraft: boolean;
  // Reference gallery rendered just below the Generate Reference button.
  referenceSlot?: ReactNode;
}

// Reference visual authoring: prompt + batch generation + version gallery.
// Split out of the Scenario Editor — this card lives just below the Render
// section while the editor stays in the side column. Prompt edits flow to
// the parent (same state the editor saves), so typing here enables Save.
export default function GenerateReference({
  referencePrompt,
  onReferencePromptChange,
  onGenerateRef,
  refBusy,
  refGenerating,
  isDraft,
  referenceSlot,
}: Props) {
  // Hide/show toggle (same as the other cards — persisted). Collapsing only
  // hides the body JSX; edits stay in the parent state.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-refgen") === "closed");
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-refgen", c ? "open" : "closed");
      return !c;
    });
  const [refCount, setRefCount] = useState(3);

  return (
    <section className={`card${collapsed ? " collapsed" : ""}`} aria-label="Generate Reference">
      <div className="card-head">
        <h2>
          <span className="head-icon hi-ref"><IconSparkles size={15} /></span>
          Generate Reference
        </h2>
        <span className="spacer" />
        <button
          className="icon-btn"
          onClick={toggleCollapsed}
          title={collapsed ? "Show generate reference" : "Hide generate reference"}
          aria-label={collapsed ? "Show generate reference" : "Hide generate reference"}
          aria-expanded={!collapsed}
        >
          <IconPanel size={15} />
        </button>
      </div>
      {!collapsed && (
      <>
      <label>Reference prompt — Flux t2i key visual</label>
      <textarea
        rows={3}
        value={referencePrompt}
        onChange={(e) => onReferencePromptChange(e.target.value)}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="ghost"
          onClick={() => onGenerateRef(refCount)}
          disabled={refBusy || isDraft}
          title={isDraft
            ? "Save scenario first — generation reads the saved prompt"
            : `Generate ${refCount} reference image(s) from the prompt above (each becomes a new version)`}
        >
          {refGenerating ? <Spinner size={13} /> : <IconSparkles size={13} />}
          {refGenerating ? "Generating…" : "Generate Reference"}
        </button>
        <label className="gen-count" title="How many reference images to generate (1–8)">
          ×
          <input
            type="number"
            min={1}
            max={8}
            value={refCount}
            disabled={refBusy}
            onChange={(e) => setRefCount(Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
          />
        </label>
      </div>
      {isDraft ? (
        <p className="hint">Save the scenario first — reference generation runs from the saved prompt.</p>
      ) : (
        <p className="hint">Each image becomes a new reference version — pick the best one below.</p>
      )}
      {referenceSlot}
      </>
      )}
    </section>
  );
}
