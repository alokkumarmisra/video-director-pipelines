import { useMemo, useState } from "react";
import type { Beat } from "../types";
import {
  ALL_SCOPE,
  addTextToBeats,
  countChanged,
  findInBeats,
  replaceInBeats,
  type AddPosition,
  type AddTarget,
  type TextScope,
} from "../sceneText";
import { IconEdit, IconPanel, IconSearch, Spinner } from "./Icons";

interface Props {
  // Collapsed state lives in the parent (like AI Craft). Rendered inside the
  // fixed right-edge dock (see .toolsnav): closed shows only the rail button,
  // open shows the full panel.
  open: boolean;
  onToggle: () => void;
  // Effective beats of the open project (draft or saved config).
  beats: Beat[];
  // Persist the edited sequence: drafts update locally, saved projects save
  // immediately as a new version (same flow as Apply to All Scene).
  // Resolves { applied, saved } for the confirmation hint.
  onApplySequence: (next: Beat[]) => Promise<{ applied: number; saved: boolean }>;
  // Jump to Scene n in the Scenario Editor.
  onGotoScene: (n: number) => void;
  // Hide the header collapse button (the fixed dock's rail tab owns the
  // toggle instead — clicking it again collapses the container).
  hideToggle?: boolean;
}

const FIELD_LABEL: Record<string, string> = {
  title: "title",
  image: "image",
  motion: "motion",
  dialogue: "dialogue",
};

function ScopeChecks({ value, onChange, withDialogue }: {
  value: TextScope;
  onChange: (v: TextScope) => void;
  withDialogue: boolean;
}) {
  const items: { key: keyof TextScope; label: string }[] = [
    { key: "titles", label: "Titles" },
    { key: "images", label: "Images" },
    { key: "motions", label: "Motion" },
    ...(withDialogue ? [{ key: "dialogue" as keyof TextScope, label: "Dialogue" }] : []),
  ];
  return (
    <div className="tools-scope">
      {items.map((it) => (
        <label key={it.key}>
          <input
            type="checkbox"
            checked={value[it.key]}
            onChange={() => onChange({ ...value, [it.key]: !value[it.key] })}
          />
          {it.label}
        </label>
      ))}
    </div>
  );
}

// Bulk text tools over every scene: Find (with jump-to-scene), literal
// Find & Replace, and Add-text-to-all-scenes (append/prepend with
// duplicate guard). All edits go through the versioned save path.
export default function SceneTools({ open, onToggle, beats, onApplySequence, onGotoScene, hideToggle }: Props) {
  // Find state (read-only — no save involved).
  const [findQ, setFindQ] = useState("");
  const [findScope, setFindScope] = useState<TextScope>({ ...ALL_SCOPE });
  const [findCase, setFindCase] = useState(false);
  // Replace state.
  const [repFind, setRepFind] = useState("");
  const [repWith, setRepWith] = useState("");
  const [repScope, setRepScope] = useState<TextScope>({ titles: false, images: true, motions: true, dialogue: false });
  const [repCase, setRepCase] = useState(false);
  const [repBusy, setRepBusy] = useState(false);
  const [repMsg, setRepMsg] = useState("");
  // Add-text state.
  const [addText, setAddText] = useState("");
  const [addTarget, setAddTarget] = useState<AddTarget>("both");
  const [addPos, setAddPos] = useState<AddPosition>("append");
  const [addSkip, setAddSkip] = useState(true);
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState("");

  const matches = useMemo(
    () => findInBeats(beats, findQ, findScope, findCase),
    [beats, findQ, findScope, findCase],
  );
  const repPreview = useMemo(
    () => replaceInBeats(beats, repFind, repWith, repScope, repCase),
    [beats, repFind, repWith, repScope, repCase],
  );
  const repCount = useMemo(() => countChanged(beats, repPreview), [beats, repPreview]);
  const addPreview = useMemo(
    () => addTextToBeats(beats, addText, addTarget, addPos, addSkip),
    [beats, addText, addTarget, addPos, addSkip],
  );
  const addCount = useMemo(() => countChanged(beats, addPreview), [beats, addPreview]);

  const applyReplace = async () => {
    if (repBusy || !repFind.trim() || repCount === 0) return;
    setRepBusy(true);
    setRepMsg("");
    try {
      const r = await onApplySequence(repPreview);
      setRepMsg(
        r.applied === 0
          ? "No scene needed the replacement."
          : r.saved
            ? `Replaced in ${r.applied} scene${r.applied === 1 ? "" : "s"} — saved as a new version.`
            : `Replaced in ${r.applied} scene${r.applied === 1 ? "" : "s"} — Save scenario to persist.`,
      );
    } catch (e) {
      setRepMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRepBusy(false);
    }
  };

  const applyAdd = async () => {
    if (addBusy || !addText.trim() || addCount === 0) return;
    setAddBusy(true);
    setAddMsg("");
    try {
      const r = await onApplySequence(addPreview);
      setAddMsg(
        r.applied === 0
          ? "Every scene already carries that text."
          : r.saved
            ? `Added to ${r.applied} scene${r.applied === 1 ? "" : "s"} — saved as a new version.`
            : `Added to ${r.applied} scene${r.applied === 1 ? "" : "s"} — Save scenario to persist.`,
      );
    } catch (e) {
      setAddMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        className="sidebar-show rail-right"
        onClick={onToggle}
        title="Show Scene Tools"
        aria-label="Show Scene Tools"
        aria-expanded={false}
      >
        <IconPanel size={15} />
        <span className="sidebar-show-label">Scene Tools</span>
      </button>
    );
  }

  const total = Array.isArray(beats) ? beats.length : 0;
  return (
    <section className="card" aria-label="Scene Tools">
      <div className="card-head">
        <h2>
          <span className="head-icon hi-craft"><IconSearch size={15} /></span>
          Scene Tools
        </h2>
        {total > 0 && (
          <span className="beats-count" title={`${total} scenes in this project`}>
            {total} scene{total === 1 ? "" : "s"}
          </span>
        )}
        <span className="spacer" />
        {!hideToggle && (
          <button
            className="icon-btn"
            onClick={onToggle}
            title="Hide Scene Tools"
            aria-label="Hide Scene Tools"
            aria-expanded={true}
          >
            <IconPanel size={15} />
          </button>
        )}
      </div>

      {total === 0 ? (
        <p className="hint">Open a project with scenes to find, replace, or add text across them.</p>
      ) : (
        <>
          <div className="tools-sec">
            <div className="tools-sec-title">Find in scenes</div>
            <input
              value={findQ}
              placeholder="Search titles, prompts, dialogue…"
              maxLength={200}
              onChange={(e) => setFindQ(e.target.value)}
              aria-label="Find text in scenes"
            />
            <ScopeChecks value={findScope} onChange={setFindScope} withDialogue />
            <div className="tools-row">
              <label className="tools-check">
                <input type="checkbox" checked={findCase} onChange={() => setFindCase((v) => !v)} />
                Match case
              </label>
              {findQ.trim() && (
                <span className="muted" style={{ fontSize: 12 }}>
                  {matches.length} match{matches.length === 1 ? "" : "es"}
                </span>
              )}
            </div>
            {findQ.trim() !== "" && (
              matches.length === 0 ? (
                <p className="hint">No matches.</p>
              ) : (
                <ul className="tools-matches">
                  {matches.map((m, i) => (
                    <li key={`${m.n}-${m.field}-${i}`}>
                      <button
                        type="button"
                        className="ghost tools-match"
                        onClick={() => onGotoScene(m.n)}
                        title={`Jump to Scene ${m.n} in the Scenario Editor`}
                      >
                        <span className="pill">{m.n}</span>
                        <span className="tools-match-field">{FIELD_LABEL[m.field] ?? m.field}</span>
                        <span className="tools-match-text">{m.snippet}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>

          <div className="tools-sec">
            <div className="tools-sec-title">Find &amp; replace in scenes</div>
            <input
              value={repFind}
              placeholder="Find…"
              maxLength={500}
              onChange={(e) => setRepFind(e.target.value)}
              aria-label="Find text to replace"
            />
            <input
              value={repWith}
              placeholder="Replace with…"
              maxLength={500}
              onChange={(e) => setRepWith(e.target.value)}
              aria-label="Replacement text"
              style={{ marginTop: 6 }}
            />
            <ScopeChecks value={repScope} onChange={setRepScope} withDialogue />
            <div className="tools-row">
              <label className="tools-check">
                <input type="checkbox" checked={repCase} onChange={() => setRepCase((v) => !v)} />
                Match case
              </label>
              <span className="spacer" />
              <button
                className="primary"
                onClick={() => void applyReplace()}
                disabled={repBusy || !repFind.trim() || repCount === 0}
                title={!repFind.trim() ? "Enter the text to find first" : repCount === 0 ? "Nothing to replace" : `Replace in ${repCount} scene${repCount === 1 ? "" : "s"} (literal text, old versions kept)`}
              >
                {repBusy ? <Spinner size={12} /> : <IconEdit size={12} />}
                {repBusy ? "Replacing…" : repCount > 0 ? `Replace in ${repCount}` : "Replace"}
              </button>
            </div>
            {repMsg && <p className="hint">{repMsg}</p>}
          </div>

          <div className="tools-sec">
            <div className="tools-sec-title">Add text to all scenes</div>
            <input
              value={addText}
              placeholder="Text to add, e.g. temple bells ringing softly"
              maxLength={500}
              onChange={(e) => setAddText(e.target.value)}
              aria-label="Text to add to all scenes"
            />
            <div className="tools-row" style={{ marginTop: 6 }}>
              <select
                value={addTarget}
                onChange={(e) => setAddTarget(e.target.value as AddTarget)}
                title="Which prompt field gets the text"
                aria-label="Target field for added text"
              >
                <option value="both">Image + Motion</option>
                <option value="image">Image prompts</option>
                <option value="motion">Motion prompts</option>
                <option value="title">Titles</option>
              </select>
              <span className="seg" title="Add at the start or the end">
                <button className={addPos === "prepend" ? "on" : ""} onClick={() => setAddPos("prepend")} type="button">
                  Start
                </button>
                <button className={addPos === "append" ? "on" : ""} onClick={() => setAddPos("append")} type="button">
                  End
                </button>
              </span>
            </div>
            <div className="tools-row" style={{ marginTop: 6 }}>
              <label className="tools-check" title="Fields already carrying the text are left untouched">
                <input type="checkbox" checked={addSkip} onChange={() => setAddSkip((v) => !v)} />
                Skip scenes that already have it
              </label>
              <span className="spacer" />
              <button
                className="primary"
                onClick={() => void applyAdd()}
                disabled={addBusy || !addText.trim() || addCount === 0}
                title={!addText.trim() ? "Enter the text to add first" : addCount === 0 ? "Nothing to add" : `Add to ${addCount} scene${addCount === 1 ? "" : "s"} (old versions kept)`}
              >
                {addBusy ? <Spinner size={12} /> : <IconEdit size={12} />}
                {addBusy ? "Adding…" : addCount > 0 ? `Add to ${addCount}` : "Add to all"}
              </button>
            </div>
            {addMsg && <p className="hint">{addMsg}</p>}
          </div>
          <p className="hint">Edits write a new scenario version (old versions kept) — regenerate clips afterwards for scenes whose prompts changed.</p>
        </>
      )}
    </section>
  );
}
