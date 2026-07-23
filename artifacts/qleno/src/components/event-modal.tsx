// [dispatch-events 2026-07-14] "+ New → Event" create modal. Drops a non-job
// entry onto the dispatch board. One modal, three kinds picked at the top:
//   tech_block   — block a technician's time (meeting, training, personal)
//   company_day  — a company-wide day marker (holiday, all-hands, no-service)
//   client_visit — a non-job appointment on a tech's row, tied to a client
// Deliberately NOT a job: no service/pricing/comms. Posts to
// POST /api/dispatch-events; the board reloads its events on success.
import { useEffect, useRef, useState } from "react";
import { CalendarClock, CalendarDays, MapPin, MessageSquare, X, Check } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const FF = "'Plus Jakarta Sans', sans-serif";
const BRAND = "var(--brand)";
// [event-address 2026-07-15] Events default to the Phes office; the office can
// edit it per event (Sal). Editable freeform string.
const OFFICE_ADDRESS = "9850 S Cicero Ave, Oak Lawn, IL 60453";

type Kind = "tech_block" | "company_day" | "client_visit" | "one_on_one";

export interface EventModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  techs: { id: number; name: string }[];
  presetDate: string; // YYYY-MM-DD — the board's current day
  branchId?: number | null;
  isOwner?: boolean; // gates the owner-only "1-on-1" kind
}

interface ClientHit { id: number; name: string; }

const KIND_OPTIONS: { value: Kind; label: string; desc: string; Icon: typeof CalendarClock; ownerOnly?: boolean }[] = [
  { value: "tech_block", label: "Block a tech", desc: "Hold time on one technician's row", Icon: CalendarClock },
  { value: "company_day", label: "Company day", desc: "Holiday or all-hands across the board", Icon: CalendarDays },
  { value: "client_visit", label: "Client visit", desc: "Non-job appointment for a client", Icon: MapPin },
  { value: "one_on_one", label: "1-on-1", desc: "Private quarterly check-in with a tech", Icon: MessageSquare, ownerOnly: true },
];

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #E5E2DC",
  fontSize: 14, fontFamily: FF, color: "#1A1917", background: "#FFFFFF", boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 700, color: "#6B7280", marginBottom: 6, fontFamily: FF,
};

// [2026-07-15] The native <input type="time"> wheel is miserable to navigate
// (Sal). A plain dropdown of 15-minute slots with readable 12-hour labels is
// one tap and scannable. Value stays "HH:MM" (24h), same as before.
const TIME_OPTIONS: { value: string; label: string }[] = (() => {
  const out: { value: string; label: string }[] = [];
  for (let mins = 5 * 60; mins <= 22 * 60; mins += 15) {
    const h = Math.floor(mins / 60), m = mins % 60;
    const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const hr12 = h % 12 || 12;
    out.push({ value, label: `${hr12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}` });
  }
  return out;
})();

function to12h(v: string): string {
  const [h, m] = v.split(":").map(Number);
  if (Number.isNaN(h)) return v;
  const hr12 = h % 12 || 12;
  return `${hr12}:${String(m ?? 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

// A time picked from a 15-min dropdown. If the current value falls off the grid
// (odd minute from earlier data), it's shown as a leading option so nothing is
// silently lost.
function TimeSelect({ value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel: string }) {
  const inList = TIME_OPTIONS.some(o => o.value === value);
  return (
    <select aria-label={ariaLabel} style={inputStyle} value={value} onChange={e => onChange(e.target.value)}>
      {!inList && value && <option value={value}>{to12h(value)}</option>}
      {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function EventModal({ open, onClose, onCreated, techs, presetDate, branchId, isOwner }: EventModalProps) {
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const kindOptions = KIND_OPTIONS.filter(o => !o.ownerOnly || isOwner);
  const [kind, setKind] = useState<Kind>("tech_block");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(presetDate);
  const [techId, setTechId] = useState<number | "">("");
  const [allDay, setAllDay] = useState(false);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("11:00");
  const [address, setAddress] = useState(OFFICE_ADDRESS);
  const [notes, setNotes] = useState("");

  // Client typeahead (client_visit only).
  const [clientQuery, setClientQuery] = useState("");
  const [clientHits, setClientHits] = useState<ClientHit[]>([]);
  const [client, setClient] = useState<ClientHit | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to a clean slate each time the modal opens on a (possibly new) day.
  useEffect(() => {
    if (!open) return;
    setKind("tech_block"); setTitle(""); setDate(presetDate); setTechId("");
    setAllDay(false); setStartTime("09:00"); setEndTime("11:00"); setAddress(OFFICE_ADDRESS); setNotes("");
    setClientQuery(""); setClientHits([]); setClient(null);
    setSubmitting(false); setError(null);
  }, [open, presetDate]);

  // Debounced client search.
  useEffect(() => {
    if (kind !== "client_visit") return;
    if (client && clientQuery === client.name) return; // already selected
    if (clientQuery.trim().length < 2) { setClientHits([]); return; }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/api/clients?search=${encodeURIComponent(clientQuery.trim())}&limit=6`, { headers: getAuthHeaders() as Record<string, string> });
        if (!r.ok) return;
        const rows = await r.json();
        const list: ClientHit[] = (Array.isArray(rows) ? rows : rows?.data ?? []).map((c: any) => ({
          id: c.id,
          name: c.company_name?.trim() || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.name || `Client #${c.id}`,
        }));
        setClientHits(list);
      } catch { /* ignore — typeahead is best-effort */ }
    }, 250);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [clientQuery, kind, client, API]);

  if (!open) return null;

  const isOneOnOne = kind === "one_on_one";
  const needsTech = kind === "tech_block" || kind === "client_visit" || isOneOnOne;
  const needsClient = kind === "client_visit";
  const needsTitle = !isOneOnOne; // 1-on-1 has a fixed title, set server-side
  const showTimes = !(kind === "company_day" && allDay);

  const canSave =
    (!needsTitle || title.trim().length > 0) &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    (!needsTech || techId !== "") &&
    (!needsClient || client !== null) &&
    !submitting;

  async function submit() {
    setError(null);
    if (!canSave) return;
    setSubmitting(true);
    try {
      // A 1-on-1 posts to the owner-only endpoint, which creates BOTH the
      // private record and the board block. Everything else is a plain event.
      if (isOneOnOne) {
        const r = await fetch(`${API}/api/one-on-ones`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(getAuthHeaders() as Record<string, string>) },
          body: JSON.stringify({ employee_id: techId, event_date: date, start_time: startTime, end_time: endTime, address: address.trim() || null }),
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          let msg = `HTTP ${r.status}`;
          try { const j = JSON.parse(txt); msg = j.error || j.message || msg; } catch { /* not json */ }
          throw new Error(msg);
        }
        onCreated();
        return;
      }
      const body: Record<string, unknown> = {
        kind,
        title: title.trim(),
        event_date: date,
        address: address.trim() || undefined,
        notes: notes.trim() || undefined,
        branch_id: typeof branchId === "number" ? branchId : undefined,
      };
      if (needsTech) body.assigned_user_id = techId;
      if (needsClient && client) body.client_id = client.id;
      if (kind === "company_day" && allDay) {
        body.all_day = true;
      } else {
        body.start_time = startTime;
        body.end_time = endTime;
      }
      const r = await fetch(`${API}/api/dispatch-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(getAuthHeaders() as Record<string, string>) },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        let msg = `HTTP ${r.status}`;
        try { const j = JSON.parse(txt); msg = j.error || j.message || msg; } catch { /* not json */ }
        throw new Error(msg);
      }
      onCreated();
    } catch (e: any) {
      setError(e?.message || "Could not create the event.");
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9998, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px 16px" }}
      onClick={onClose}
    >
      <div
        style={{ background: "#FFFFFF", borderRadius: 16, width: "min(560px, 96vw)", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 80px rgba(0,0,0,0.18)", fontFamily: FF }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px", borderBottom: "1px solid #E5E2DC" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#1A1917" }}>New event</div>
            <div style={{ fontSize: 12.5, color: "#9E9B94", marginTop: 2 }}>A non-job entry on the dispatch board</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", padding: 4, color: "#6B7280" }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ padding: 20 }}>
          {/* Kind picker */}
          <div style={{ display: "grid", gridTemplateColumns: kindOptions.length >= 4 ? "1fr 1fr" : "1fr 1fr 1fr", gap: 8, marginBottom: 18 }}>
            {kindOptions.map(opt => {
              const sel = kind === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => setKind(opt.value)}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6,
                    padding: "12px 12px", borderRadius: 12, cursor: "pointer", textAlign: "left",
                    border: `2px solid ${sel ? BRAND : "#E5E2DC"}`,
                    background: sel ? "rgba(var(--brand-rgb),0.05)" : "#FFFFFF",
                  }}
                >
                  <opt.Icon size={18} color={sel ? BRAND : "#6B7280"} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: sel ? "#0A0E1A" : "#1A1917" }}>{opt.label}</span>
                  <span style={{ fontSize: 11, color: "#9E9B94", lineHeight: 1.3 }}>{opt.desc}</span>
                </button>
              );
            })}
          </div>

          {/* Title (not for 1-on-1 — it has a fixed neutral label) */}
          {needsTitle && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Title</label>
              <input
                style={inputStyle}
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder={kind === "company_day" ? "e.g. Company holiday" : kind === "client_visit" ? "e.g. Estimate walkthrough" : "e.g. Team meeting"}
                autoFocus
              />
            </div>
          )}

          {/* 1-on-1 privacy note */}
          {isOneOnOne && (
            <div style={{ marginBottom: 14, padding: "10px 12px", borderRadius: 10, background: "rgba(var(--brand-rgb),0.06)", border: "1px solid #CDEDE5", fontSize: 12.5, color: "#3A6B60", lineHeight: 1.4 }}>
              Creates a private 1-on-1 on this tech's profile — the questions, answers, and notes are <strong>owner-only</strong>. The board shows a neutral "1-on-1" block so the office schedules around it.
            </div>
          )}

          {/* Tech */}
          {needsTech && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Technician</label>
              <select style={inputStyle} value={techId} onChange={e => setTechId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Select a technician…</option>
                {techs.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}

          {/* Client typeahead */}
          {needsClient && (
            <div style={{ marginBottom: 14, position: "relative" }}>
              <label style={labelStyle}>Client</label>
              <input
                style={inputStyle}
                value={clientQuery}
                onChange={e => { setClientQuery(e.target.value); setClient(null); }}
                placeholder="Search clients by name…"
              />
              {client && (
                <div style={{ marginTop: 6, fontSize: 12.5, color: BRAND, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
                  <Check size={13} /> {client.name}
                </div>
              )}
              {!client && clientHits.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 5, marginTop: 4, background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.12)", overflow: "hidden" }}>
                  {clientHits.map(h => (
                    <button
                      key={h.id}
                      onClick={() => { setClient(h); setClientQuery(h.name); setClientHits([]); }}
                      style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", border: "none", background: "none", cursor: "pointer", fontSize: 14, color: "#1A1917", fontFamily: FF }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#F7F6F3")}
                      onMouseLeave={e => (e.currentTarget.style.background = "none")}
                    >
                      {h.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Date + all-day (company day) */}
          <div style={{ display: "flex", gap: 12, marginBottom: 14, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Date</label>
              <input type="date" style={inputStyle} value={date} onChange={e => setDate(e.target.value)} />
            </div>
            {kind === "company_day" && (
              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, color: "#1A1917", padding: "10px 0", cursor: "pointer", whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} />
                All day
              </label>
            )}
          </div>

          {/* Times */}
          {showTimes && (
            <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Start</label>
                <TimeSelect ariaLabel="Start time" value={startTime} onChange={setStartTime} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>End</label>
                <TimeSelect ariaLabel="End time" value={endTime} onChange={setEndTime} />
              </div>
            </div>
          )}

          {/* Address — defaults to the office, editable. Skipped for an all-day
              company day (no location needed). */}
          {!(kind === "company_day" && allDay) && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Address</label>
              <input
                style={inputStyle}
                value={address}
                onChange={e => setAddress(e.target.value)}
                placeholder="Where is this happening?"
              />
              <div style={{ fontSize: 11.5, color: "#9E9B94", marginTop: 5 }}>Defaults to the office — edit for an off-site event.</div>
            </div>
          )}

          {/* Notes (not for 1-on-1 — private notes are captured on the record) */}
          {!isOneOnOne && (
            <div style={{ marginBottom: 6 }}>
              <label style={labelStyle}>Notes (optional)</label>
              <textarea style={{ ...inputStyle, minHeight: 64, resize: "vertical" }} value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
          )}

          {error && (
            <div style={{ marginTop: 12, padding: "9px 12px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", color: "#B91C1C", fontSize: 13 }}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 20px", borderTop: "1px solid #E5E2DC", position: "sticky", bottom: 0, background: "#FFFFFF" }}>
          <button
            onClick={onClose}
            style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#1A1917", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: FF }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSave}
            style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: canSave ? BRAND : "#CDEDE5", color: "#0A0E1A", fontWeight: 800, fontSize: 14, cursor: canSave ? "pointer" : "not-allowed", fontFamily: FF }}
          >
            {submitting ? (isOneOnOne ? "Scheduling…" : "Creating…") : (isOneOnOne ? "Schedule 1-on-1" : "Create event")}
          </button>
        </div>
      </div>
    </div>
  );
}
