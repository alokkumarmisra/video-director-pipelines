import { useEffect, useState } from "react";
import { getPresetsCached, getPreset, type PresetInfo } from "../api";
import Collapse from "./Collapse";

// Category group order for the dropdown (matches the documented preset
// groups). Unknown categories sink to the end, never lost.
export const PRESET_GROUP_ORDER = [
  "General",
  "Story & Genre",
  "Culture",
  "Kids & Education",
  "Music",
  "Real World",
  "Platform",
];

// Video Type dropdown with per-project editable rules: grouped native
// <select> (same control as the Scenario Editor version picker — no new UI
// framework), a short description under the selection, and a "View / edit
// rules" panel. The system-owned presets/*.md files are never modified —
// edits are stored as `presetRules` on the project (Scenario) and replace
// the preset file content for that project only. Empty = use preset default.
export default function PresetSelect({
  id,
  value,
  onChange,
  disabled,
  customRules,
  onCustomRulesChange,
  rulesEnabled,
  onRulesEnabledChange,
}: {
  id: string;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  customRules?: string | null;
  onCustomRulesChange?: (rules: string | null) => void;
  // Optional rules on/off switch (AI Craft). True/absent = rules apply as
  // before; false = the caller crafts without any video-type rules. When the
  // toggle handler is absent no button renders and behavior is unchanged.
  rulesEnabled?: boolean;
  onRulesEnabledChange?: (enabled: boolean) => void;
}) {
  const [presets, setPresets] = useState<PresetInfo[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [showRules, setShowRules] = useState(false);
  const [defaultRules, setDefaultRules] = useState<string | null>(null);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [rulesError, setRulesError] = useState("");
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    getPresetsCached()
      .then(setPresets)
      .catch(() => setLoadError("Video types unavailable — the default will be used."));
  }, []);

  // A new selection reloads the preset default (the panel shows the newly
  // selected preset — a per-project customization stays applied on top).
  useEffect(() => {
    setShowRules(false);
    setDefaultRules(null);
    setDraft(null);
    setRulesError("");
  }, [value]);

  // When the panel opens with fresh defaults, seed the editor from the
  // project customization (or the preset default when none exists).
  useEffect(() => {
    if (showRules && defaultRules !== null && draft === null) {
      setDraft((customRules ?? "").trim() ? (customRules as string) : defaultRules);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRules, defaultRules]);

  const list = presets ?? [];
  const current = list.find((p) => p.id === value) ?? null;
  const groups = PRESET_GROUP_ORDER.filter((g) => list.some((p) => p.category === g));
  for (const p of list) if (!groups.includes(p.category)) groups.push(p.category);

  // Rules switch: present only when the parent wires the toggle (AI Craft).
  // Off = no video-type rules are concatenated into the craft prompt.
  const rulesOn = rulesEnabled !== false;
  const showToggle = typeof onRulesEnabledChange === "function";
  // Closing the panel while rules are off keeps a stale editor from
  // reappearing on re-enable.
  useEffect(() => {
    if (!rulesOn) setShowRules(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesOn]);

  const customized = !!((customRules ?? "").trim());
  // Effective rules shown/saved = customization when present, else default.
  const effective = customized ? (customRules as string) : (defaultRules ?? "");
  const dirty = draft !== null && draft !== effective;

  const toggleRules = async () => {
    if (showRules) {
      setShowRules(false);
      return;
    }
    setShowRules(true);
    if (defaultRules !== null || rulesBusy) return;
    setRulesBusy(true);
    setRulesError("");
    try {
      const d = await getPreset(value);
      setDefaultRules(d.content);
      // Seed the editor on first load (the effect above only runs when
      // defaultRules flips from null — set it here too for immediacy).
      setDraft((prev) => prev ?? (((customRules ?? "").trim() ? (customRules as string) : d.content)));
    } catch (e) {
      setRulesError(e instanceof Error ? e.message : "Could not load preset rules.");
    } finally {
      setRulesBusy(false);
    }
  };

  const saveCustom = () => {
    if (!onCustomRulesChange || draft === null) return;
    const t = draft.trim();
    // Saving text identical to the preset default = no override needed.
    if (!t || (defaultRules !== null && t === defaultRules.trim())) {
      onCustomRulesChange(null);
    } else {
      onCustomRulesChange(draft);
    }
  };

  const resetDefault = () => {
    onCustomRulesChange?.(null);
    if (defaultRules !== null) setDraft(defaultRules);
  };

  return (
    <div className="preset-select">
      <label htmlFor={id}>Video Type</label>
      <select
        id={id}
        value={value}
        disabled={disabled || !presets || !rulesOn}
        onChange={(e) => onChange(e.target.value)}
        title={rulesOn
          ? "Predefined visual style for this project, customizable per project below"
          : "Video type is ignored while rules are disabled"}
      >
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {list
              .filter((p) => p.category === g)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {loadError ? (
        <p className="hint err-text">{loadError}</p>
      ) : (
        current && (
          <p className="hint">
            {current.description}
            {customized && onCustomRulesChange && (
              <span className="pill warn preset-custom-badge" title="This project uses customized rules instead of the preset default">
                {" "}customized
              </span>
            )}
          </p>
        )
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="ghost preset-rules-btn"
          onClick={() => void toggleRules()}
          disabled={disabled || !rulesOn}
          aria-expanded={showRules}
          title="View and customize this project's visual rules (preset default + your edits)"
        >
          {showRules ? "Hide rules" : customized ? "View / edit rules (customized)" : "View / edit rules"}
        </button>
        {showToggle && (
          <button
            type="button"
            className="ghost preset-rules-btn"
            onClick={() => onRulesEnabledChange?.(!rulesOn)}
            disabled={disabled}
            aria-pressed={!rulesOn}
            title={rulesOn
              ? "Skip the video-type rules for the next craft — only Description + Master prompt are sent"
              : "Include the video-type rules with the master prompt again"}
          >
            {rulesOn ? "Disable rules" : "Enable rules"}
          </button>
        )}
      </div>
      {!rulesOn && showToggle && (
        <p className="hint">Rules disabled — Craft scenario uses only Description + Master prompt.</p>
      )}
      <Collapse open={showRules && rulesOn}>
        <div className="preset-rules" aria-label="Preset rules (editable per project)">
          {rulesBusy ? (
            <p className="hint">Loading rules…</p>
          ) : rulesError ? (
            <p className="hint err-text">{rulesError}</p>
          ) : onCustomRulesChange ? (
            <>
              <textarea
                className="preset-rules-edit"
                rows={10}
                value={draft ?? ""}
                disabled={disabled}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="Custom video-type rules for this project"
                placeholder="Visual style rules for this project…"
              />
              <div className="row preset-rules-actions">
                <button
                  type="button"
                  className="primary preset-save-btn"
                  onClick={saveCustom}
                  disabled={disabled || !dirty}
                  title={dirty ? "Save these rules for this project (stored with the project on Save)" : "No changes — nothing to save"}
                >
                  Save rules for this project
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={resetDefault}
                  disabled={disabled || (!customized && draft === defaultRules)}
                  title="Discard your customization and use the preset default again"
                >
                  Reset to preset default
                </button>
              </div>
              <p className="hint">
                {customized
                  ? "Customized — these rules replace the preset default for this project only (saved with the project)."
                  : "Preset default — edit + save to customize for this project only. The shared preset is never modified."}
              </p>
            </>
          ) : (
            <pre>{defaultRules ?? ""}</pre>
          )}
        </div>
      </Collapse>
    </div>
  );
}
