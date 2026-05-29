/**
 * Mobile date picker — bottom sheet with a month grid.
 *
 * Tapped from the date header in the mobile Jobs page so the
 * dispatcher can jump to any day in any month with one gesture
 * instead of chevron-stepping a day at a time. Month-grid is hand-
 * rolled to match the dispatch page's inline-style brand palette
 * (Qleno mint accent, hex colors, Plus Jakarta Sans) — pulling in
 * react-day-picker would clash with the surrounding aesthetic and
 * add weight for a 6×7 grid.
 *
 * Behavior:
 *   - Header: current month + year + prev/next month chevrons.
 *   - Grid: 7 columns Sun→Sat. Trailing/leading days from adjacent
 *     months render in muted color so the grid stays 6 rows.
 *   - Today gets a small dot. Selected day gets the mint accent.
 *   - "Today" button under the grid resets to the current date.
 *   - Tap outside / ESC / drag handle / X close without changing.
 *   - Tap a day → onSelect(date) + close.
 *
 * Matches LegendPopover's mobile sheet styling for visual continuity.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

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

const DAY_HEADERS = ["S", "M", "T", "W", "T", "F", "S"];

export default function MobileDateSheet({
  open,
  selectedDate,
  onSelect,
  onClose,
}: {
  open: boolean;
  selectedDate: Date;
  onSelect: (d: Date) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visibleMonth, setVisibleMonth] = useState<Date>(
    () => startOfMonth(selectedDate),
  );

  useEffect(() => {
    if (open) setVisibleMonth(startOfMonth(selectedDate));
  }, [open, selectedDate]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open, onClose]);

  if (!open) return null;

  const today = new Date();
  // Build a 6×7 grid starting from the Sunday on/before the 1st.
  const firstOfMonth = startOfMonth(visibleMonth);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }

  const monthLabel = visibleMonth.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0,0,0,0.4)",
          zIndex: 410,
        }}
      />
      <div
        ref={ref}
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 411,
          backgroundColor: "#FFFFFF",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          padding: "12px 16px 20px",
          maxHeight: "80vh",
          overflowY: "auto",
          fontFamily: FF,
          boxShadow: "0 -8px 32px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: "#D0CEC9" }} />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <button
            onClick={() => setVisibleMonth((m) => addMonths(m, -1))}
            aria-label="Previous month"
            style={{
              border: "none",
              background: "#F7F6F3",
              borderRadius: 8,
              padding: "6px 10px",
              cursor: "pointer",
              color: "#6B7280",
            }}
          >
            <ChevronLeft size={16} />
          </button>
          <div style={{ fontSize: 15, fontWeight: 800, color: INK }}>{monthLabel}</div>
          <button
            onClick={() => setVisibleMonth((m) => addMonths(m, 1))}
            aria-label="Next month"
            style={{
              border: "none",
              background: "#F7F6F3",
              borderRadius: 8,
              padding: "6px 10px",
              cursor: "pointer",
              color: "#6B7280",
            }}
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            gap: 2,
            marginBottom: 6,
          }}
        >
          {DAY_HEADERS.map((h, i) => (
            <div
              key={i}
              style={{
                textAlign: "center",
                fontSize: 10,
                fontWeight: 700,
                color: MUTED,
                textTransform: "uppercase",
                letterSpacing: "0.07em",
                paddingBottom: 4,
              }}
            >
              {h}
            </div>
          ))}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            gap: 2,
          }}
        >
          {cells.map((d, i) => {
            const inMonth = d.getMonth() === visibleMonth.getMonth();
            const isSelected = sameDay(d, selectedDate);
            const isToday = sameDay(d, today);
            return (
              <button
                key={i}
                onClick={() => {
                  onSelect(d);
                  onClose();
                }}
                style={{
                  position: "relative",
                  aspectRatio: "1 / 1",
                  border: "none",
                  borderRadius: 8,
                  cursor: "pointer",
                  backgroundColor: isSelected ? BRAND : "transparent",
                  color: isSelected ? "#FFFFFF" : inMonth ? INK : "#C9C5BD",
                  fontSize: 14,
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
                  <span
                    style={{
                      position: "absolute",
                      bottom: 4,
                      width: 4,
                      height: 4,
                      borderRadius: "50%",
                      backgroundColor: BRAND,
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 14,
            paddingTop: 12,
            borderTop: `1px solid ${BORDER}`,
          }}
        >
          <button
            onClick={() => {
              onSelect(new Date());
              onClose();
            }}
            style={{
              border: "none",
              background: "#F7F6F3",
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 700,
              color: INK,
              cursor: "pointer",
              fontFamily: FF,
            }}
          >
            Today
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              padding: 4,
            }}
          >
            <X size={18} color="#6B6860" />
          </button>
        </div>
      </div>
    </>
  );
}
