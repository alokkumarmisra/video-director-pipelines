// Scene-planning batch size (the AI Story Director plans scenes in LLM
// batches). lib/director.mjs defaults to SCENE_BATCH = 10 and caps a
// user-chosen batch at SCENE_BATCH_MAX (12) — the dropdown below offers the
// user-selectable range 1..SCENE_BATCH_MAX, defaulting to the server default
// batch (10) until the user picks one.
export const SCENE_BATCH = 10;
export const SCENE_BATCH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export default function BatchSizeSelect({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
      <label htmlFor="director-batch-size" style={{ margin: 0, flexShrink: 0 }}>Batch size</label>
      <select
        id="director-batch-size"
        className="input"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        style={{ width: 76, flex: "none" }}
        aria-label="Scene planning batch size"
        title="Scenes per AI Director planning batch (1–12) — sent as the batch scene count when Generate scenes / Continue scenes run"
      >
        {SCENE_BATCH_OPTIONS.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <span className="muted" style={{ fontSize: 11, flex: "none" }}>
        scenes per planning batch · default {SCENE_BATCH}
      </span>
    </div>
  );
}
