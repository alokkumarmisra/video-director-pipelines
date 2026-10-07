import { useState, type ReactNode } from "react";
import { IconEye, IconPanel, IconSparkles, Spinner } from "./Icons";
import Collapse from "./Collapse";

// Must stay in sync with VERTICAL_PROMPT_SUFFIX in lib/variant.mjs — the
// only text the backend still appends, and only on vertical (Instagram) runs.
const VERTICAL_SUFFIX =
  ", vertical 9:16 portrait composition, subject large and centered, full height framing, optimized for phone viewing";

interface Props {
  // Effective reference prompt (saved config + any unsaved edits from this
  // card). Edits are held by the parent and merged into the scenario on
  // explicit Save in the Scenario Editor — and are also persisted
  // automatically when Generate Reference is pressed (generation reads the
  // saved prompt, so the save happens first).
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
  // Reference gallery rendered on top of the reference prompt.
  referenceSlot?: ReactNode;
  // True when the viewed cut is vertical (Instagram) — the backend appends
  // the 9:16 framing suffix, so the preview shows it too. Landscape sends
  // the textarea text exactly as written.
  isVertical?: boolean;
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
  isVertical = false,
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
  const [showPreview, setShowPreview] = useState(false);
  // The exact text Flux receives: textarea verbatim, plus the 9:16 framing
  // suffix on vertical cuts only (nothing else is appended server-side).
  const trimmed = referencePrompt.trim();
  const hasText = trimmed.length > 0;
  const finalPrompt = hasText ? trimmed + (isVertical ? VERTICAL_SUFFIX : "") : "";

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
      <Collapse open={!collapsed}>
      {referenceSlot}
      <div className="row" style={{ alignItems: "center", flexWrap: "nowrap" }}>
        <label style={{ flex: 1, minWidth: 0, marginBottom: 0 }}>Reference prompt — Flux t2i key visual</label>
        <button
          className="btn sm ghost"
          onClick={() => setShowPreview(true)}
          disabled={!hasText}
          title={hasText ? "Preview the exact prompt Flux will receive" : "Type a prompt above to preview it"}
          aria-label="Show prompt"
        >
          <IconEye size={13} /> Show prompt
        </button>
      </div>
      <textarea
        rows={3}
        value={referencePrompt}
        onChange={(e) => onReferencePromptChange(e.target.value)}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button
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
        <p className="hint">Generate saves the prompt above first, then renders — each image becomes a new reference version; pick the best one above.</p>
      )}
      </Collapse>
      {showPreview && (
        <div
          className="dlg-overlay"
          onClick={() => setShowPreview(false)}
          role="presentation"
        >
          <div
            className="dlg-box"
            role="dialog"
            aria-modal="true"
            aria-label="Final reference prompt sent to Flux"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(560px, 100%)", textAlign: "left" }}
          >
            <h3 className="dlg-title" style={{ textAlign: "center" }}>Final prompt sent to Flux</h3>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                margin: "0 0 8px",
                padding: "10px 12px",
                fontSize: 12.5,
                lineHeight: 1.55,
                color: "var(--text-2)",
                background: "var(--inset)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-s)",
                maxHeight: 320,
                overflowY: "auto",
              }}
            >
              {finalPrompt}
            </pre>
            <p className="hint" style={{ margin: "0 0 14px" }}>
              {isVertical
                ? "Instagram cut: textarea verbatim + the 9:16 framing suffix (tall-frame composition only)."
                : "Sent verbatim — exactly what you typed, nothing appended."}{" "}
              {finalPrompt.length} chars.
            </p>
            <div className="dlg-actions">
              <button
                className="ghost"
                onClick={() => {
                  try {
                    void navigator.clipboard?.writeText(finalPrompt);
                  } catch { /* clipboard unavailable — text stays selectable above */ }
                }}
                title="Copy the final prompt to the clipboard"
              >
                Copy
              </button>
              <button className="primary" onClick={() => setShowPreview(false)} title="Close preview">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
