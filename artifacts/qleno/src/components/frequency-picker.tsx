import { useEffect, useState } from "react";

// Shared cadence picker — used by the estimate builder (per-line + "set every
// line") and the Settings → Packages authoring screen so both surfaces offer the
// exact same options + Custom behavior.
const FF = "'Plus Jakarta Sans', sans-serif";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const inp: React.CSSProperties = {
  width: "100%", padding: "9px 11px", border: `1px solid ${BORDER}`, borderRadius: 9,
  fontSize: 14, fontFamily: FF, background: "#fff", boxSizing: "border-box", color: INK,
};
const listBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", background: "#fff", border: `1px solid ${BORDER}`,
  borderRadius: 9, padding: "7px 12px", fontSize: 13, fontWeight: 700, color: INK, cursor: "pointer", fontFamily: FF,
};

export const FREQUENCY_OPTIONS = ["Daily", "5x/week", "3x/week", "2x/week", "Weekly", "Bi-weekly", "Semi-monthly", "Monthly", "Quarterly", "One-time"];

// [frequency-custom] Custom cadence = a count + a unit (e.g. 2 × per month).
// Stored as "Nx/<unit>" — same shape as the standard "2x/week" options.
const CADENCE_UNITS = [
  { v: "day", label: "per day" },
  { v: "week", label: "per week" },
  { v: "month", label: "per month" },
  { v: "year", label: "per year" },
];
export const parseCustomFreq = (v: string): { n: string; unit: string } | null => {
  const m = /^(\d+)x\/(day|week|month|year)$/.exec((v || "").trim());
  return m ? { n: m[1], unit: m[2] } : null;
};
export const composeFreq = (n: string, unit: string) => `${Math.max(1, Number(n) || 1)}x/${unit}`;

// A real dropdown of all cadence options + "Custom…". A free-text input with a
// datalist only shows suggestions matching what's already typed, so a filled
// field looked like it had a single option — this always shows the full list.
// Custom… reveals a structured builder: a count (Frequency) + a cadence selector
// (per day/week/month/year), e.g. 2 × per month.
export function FrequencyPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isStd = FREQUENCY_OPTIONS.includes(value);
  const parsed = parseCustomFreq(value);
  const [custom, setCustom] = useState(value !== "" && !isStd);
  const [n, setN] = useState(parsed?.n ?? "2");
  const [unit, setUnit] = useState(parsed?.unit ?? "month");
  useEffect(() => { if (FREQUENCY_OPTIONS.includes(value)) setCustom(false); }, [value]);
  // Keep the builder in sync when an existing custom value loads in.
  useEffect(() => { const p = parseCustomFreq(value); if (p) { setN(p.n); setUnit(p.unit); } }, [value]);

  if (custom) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input style={{ ...inp, width: 70 }} type="number" min="1" step="1" value={n} autoFocus aria-label="Times"
          onChange={e => { setN(e.target.value); onChange(composeFreq(e.target.value, unit)); }} />
        <select style={inp} value={unit} aria-label="Cadence"
          onChange={e => { setUnit(e.target.value); onChange(composeFreq(n, e.target.value)); }}>
          {CADENCE_UNITS.map(u => <option key={u.v} value={u.v}>{u.label}</option>)}
        </select>
        <button type="button" onClick={() => { setCustom(false); onChange(""); }} style={{ ...listBtn, flexShrink: 0 }} title="Back to the list">List</button>
      </div>
    );
  }
  return (
    <select style={inp} value={isStd ? value : ""} onChange={e => {
      if (e.target.value === "__custom__") { setCustom(true); onChange(composeFreq(n, unit)); }
      else onChange(e.target.value);
    }}>
      <option value="">Select…</option>
      {FREQUENCY_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
      <option value="__custom__">Custom…</option>
    </select>
  );
}
