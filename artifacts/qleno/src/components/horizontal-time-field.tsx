// ─── HORIZONTAL TIME FIELD ────────────────────────────────────────────────────
// A friendly, horizontal replacement for the native <input type="time"> spinner
// (Chrome's vertical clock is clumsy and hard to click). Reads left-to-right as
// [ Hour ] : [ Min ] [ AM | PM ] — the whole control is clickable, and picking
// an hour immediately populates a valid time (minute defaults to :00, AM) so the
// user adjusts rather than starting from a blank "--:-- --".
//
// Value contract is IDENTICAL to the native input it replaces: a zero-padded
// 24-hour "HH:mm" string (e.g. "10:00", "14:30"), or "" when blank. Callers that
// string-compare start/end (recStart >= recEnd) and submit start_time/end_time
// keep working unchanged.
import { useEffect, useRef, useState } from "react";

const BORDER = "#E5E2DC";
const TEXT = "#1A1917";
const MUTED = "#9E9B94";
const MINT = "#00C9A0";
const NIGHT = "#0A0E1A";

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// "HH:mm" (24h) → 12-hour parts, or nulls when blank/invalid.
function parse(value: string): { h12: number | null; min: number | null; mer: "" | "AM" | "PM" } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  if (!m) return { h12: null, min: null, mer: "" };
  const h24 = Number(m[1]);
  const min = Number(m[2]);
  if (h24 > 23 || min > 59) return { h12: null, min: null, mer: "" };
  const mer: "AM" | "PM" = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { h12, min, mer };
}

export function HorizontalTimeField({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
}) {
  const p = parse(value);
  const [h12, setH12] = useState<number | "">(p.h12 ?? "");
  const [min, setMin] = useState<number | "">(p.min ?? "");
  const [mer, setMer] = useState<"" | "AM" | "PM">(p.mer);

  // Re-sync when the parent resets/changes value externally (e.g. modal reopen
  // clears to ""). We track what we last emitted so our own edits don't loop.
  const lastEmitted = useRef<string>(value);
  useEffect(() => {
    if (value === lastEmitted.current) return;
    const np = parse(value);
    setH12(np.h12 ?? "");
    setMin(np.min ?? "");
    setMer(np.mer);
    lastEmitted.current = value;
  }, [value]);

  function emit(nh: number | "", nm: number | "", nmer: "" | "AM" | "PM") {
    let out = "";
    if (nh !== "") {
      const mm = nm === "" ? 0 : nm;
      const me = nmer || "AM";
      const h24 = (nh % 12) + (me === "PM" ? 12 : 0);
      out = `${pad(h24)}:${pad(mm)}`;
    }
    lastEmitted.current = out;
    onChange(out);
  }

  const active = h12 !== "";

  function changeHour(v: string) {
    if (v === "") {
      // Clearing the hour blanks the whole field → "whole day".
      setH12("");
      setMin("");
      setMer("");
      emit("", "", "");
      return;
    }
    const nh = Number(v);
    const nm = min === "" ? 0 : min;
    const nmer = mer || "AM";
    setH12(nh);
    setMin(nm);
    setMer(nmer);
    emit(nh, nm, nmer);
  }

  function changeMin(v: string) {
    const nm = Number(v);
    const nmer = mer || "AM";
    setMin(nm);
    setMer(nmer);
    emit(h12, nm, nmer);
  }

  function changeMer(nmer: "AM" | "PM") {
    setMer(nmer);
    emit(h12, min === "" ? 0 : min, nmer);
  }

  const selBase: React.CSSProperties = {
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    fontSize: 13,
    fontFamily: "inherit",
    padding: "9px 8px",
    background: "#FFFFFF",
    cursor: "pointer",
  };

  return (
    <div role="group" aria-label={ariaLabel} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
      <select
        aria-label="Hour"
        value={h12}
        onChange={e => changeHour(e.target.value)}
        style={{ ...selBase, color: active ? TEXT : MUTED }}
      >
        <option value="">--</option>
        {HOURS.map(h => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
      <span style={{ color: MUTED, fontWeight: 700 }}>:</span>
      <select
        aria-label="Minute"
        value={min}
        onChange={e => changeMin(e.target.value)}
        disabled={!active}
        style={{ ...selBase, color: active ? TEXT : MUTED, opacity: active ? 1 : 0.5, cursor: active ? "pointer" : "not-allowed" }}
      >
        <option value="">--</option>
        {MINUTES.map(m => (
          <option key={m} value={m}>{pad(m)}</option>
        ))}
      </select>
      <div style={{ display: "inline-flex", border: `1px solid ${BORDER}`, borderRadius: 8, overflow: "hidden", opacity: active ? 1 : 0.5 }}>
        {(["AM", "PM"] as const).map(m => {
          const on = mer === m;
          return (
            <button
              key={m}
              type="button"
              disabled={!active}
              onClick={() => changeMer(m)}
              style={{
                border: "none",
                padding: "9px 12px",
                fontSize: 13,
                fontFamily: "inherit",
                fontWeight: 700,
                cursor: active ? "pointer" : "not-allowed",
                background: on ? MINT : "#FFFFFF",
                color: on ? NIGHT : MUTED,
              }}
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}
