/**
 * Desktop calendar popover — a button that opens an inline month grid.
 *
 * Same visual language and navigation model as the mobile date sheet
 * (`mobile-date-sheet.tsx`): a 6×7 month grid with prev/next month
 * chevrons (left/right, NOT the native up/down month stepper), a Today
 * shortcut, mint-accent selected day, and a today dot. Built so date
 * selection feels identical on desktop and mobile instead of falling
 * back to the OS-native `<input type="date">` picker.
 *
 * Value in/out is a local `YYYY-MM-DD` string (matching what the native
 * date input emitted) so callers don't change. Parsing/formatting use
 * LOCAL date parts — never `toISOString()` — to avoid the timezone
 * off-by-one that shifts a clicked day to the previous date.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from "lucide-react";

const FF = "'Plus Jakarta Sans', sans-serif";
const BRAND = "#00C9A0";
const INK = "#1A1917";
const MUTED = "#9E9B94";
const BORDER = "#EEECE7";

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
// Local YMD — avoids the toISOString() UTC shift that lands a click on the
// previous day for users west of GMT.
function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseYmd(s: string | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const DAY_HEADERS = ["S", "M", "T", "W", "T", "F", "S"];

export function CalendarPopover({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (ymd: string) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const selected = parseYmd(value);
  const [visibleMonth, setVisibleMonth] = useState<Date>(
    () => startOfMonth(selected ?? new Date()),
  );

  // Re-anchor the visible month to the selected value each time we open.
  useEffect(() => {
    if (open) setVisibleMonth(startOfMonth(parseYmd(value) ?? new Date()));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const today = new Date();
  const label = selected
    ? selected.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "Select date";

  // 6×7 grid from the Sunday on/before the 1st.
  const firstOfMonth = startOfMonth(visibleMonth);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }
  const monthLabel = visibleMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        style={{
          height: 34,
          padding: "0 12px",
          border: "1px solid #E5E2DC",
          borderRadius: 6,
          fontSize: 13,
          color: INK,
          background: "#fff",
          outline: "none",
          fontFamily: FF,
          fontWeight: 600,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <CalendarIcon size={14} color={MUTED} />
        {label}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: 40,
            left: 0,
            zIndex: 60,
            backgroundColor: "#FFFFFF",
            border: `1px solid ${BORDER}`,
            borderRadius: 12,
            padding: "12px 14px 14px",
            width: 260,
            boxShadow: "0 12px 32px rgba(0,0,0,0.14)",
            fontFamily: FF,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <button
              type="button"
              onClick={() => setVisibleMonth((m) => addMonths(m, -1))}
              aria-label="Previous month"
              style={{ border: "none", background: "#F7F6F3", borderRadius: 8, padding: "5px 9px", cursor: "pointer", color: "#6B7280" }}
            >
              <ChevronLeft size={16} />
            </button>
            <div style={{ fontSize: 14, fontWeight: 800, color: INK }}>{monthLabel}</div>
            <button
              type="button"
              onClick={() => setVisibleMonth((m) => addMonths(m, 1))}
              aria-label="Next month"
              style={{ border: "none", background: "#F7F6F3", borderRadius: 8, padding: "5px 9px", cursor: "pointer", color: "#6B7280" }}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
            {DAY_HEADERS.map((h, i) => (
              <div key={i} style={{ textAlign: "center", fontSize: 10, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.07em", paddingBottom: 2 }}>
                {h}
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
            {cells.map((d, i) => {
              const inMonth = d.getMonth() === visibleMonth.getMonth();
              const isSelected = selected ? sameDay(d, selected) : false;
              const isToday = sameDay(d, today);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    onChange(toYmd(d));
                    setOpen(false);
                  }}
                  style={{
                    position: "relative",
                    aspectRatio: "1 / 1",
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                    backgroundColor: isSelected ? BRAND : "transparent",
                    color: isSelected ? "#FFFFFF" : inMonth ? INK : "#C9C5BD",
                    fontSize: 13,
                    fontWeight: isSelected || isToday ? 800 : 600,
                    fontFamily: FF,
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {d.getDate()}
                  {isToday && !isSelected && (
                    <span style={{ position: "absolute", bottom: 3, width: 4, height: 4, borderRadius: "50%", backgroundColor: BRAND }} />
                  )}
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BORDER}` }}>
            <button
              type="button"
              onClick={() => {
                onChange(toYmd(new Date()));
                setOpen(false);
              }}
              style={{ border: "none", background: "#F7F6F3", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, color: INK, cursor: "pointer", fontFamily: FF }}
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CalendarPopover;
