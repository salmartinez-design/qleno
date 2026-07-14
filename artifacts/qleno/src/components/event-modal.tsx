// [dispatch-events 2026-07-14] "+ New → Event" create modal. Drops a non-job
// entry onto the dispatch board. One modal, three kinds picked at the top:
//   tech_block   — block a technician's time (meeting, training, personal)
//   company_day  — a company-wide day marker (holiday, all-hands, no-service)
//   client_visit — a non-job appointment on a tech's row, tied to a client
// Deliberately NOT a job: no service/pricing/comms. Posts to
// POST /api/dispatch-events; the board reloads its events on success.
import { useEffect, useRef, useState } from "react";
import { CalendarClock, CalendarDays, MapPin, X, Check } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const FF = "'Plus Jakarta Sans', sans-serif";
const BRAND = "var(--brand, #00C9A0)";

type Kind = "tech_block" | "company_day" | "client_visit";

export interface EventModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  techs: { id: number; name: string }[];
  presetDate: string; // YYYY-MM-DD — the board's current day
  branchId?: number | null;
}

interface ClientHit { id: number; name: string; }

const KIND_OPTIONS: { value: Kind; label: string; desc: string; Icon: typeof CalendarClock }[] = [
  { value: "tech_block", label: "Block a tech", desc: "Hold time on one technician's row", Icon: CalendarClock },
  { value: "company_day", label: "Company day", desc: "Holiday or all-hands across the board", Icon: CalendarDays },
  { value: "client_visit", label: "Client visit", desc: "Non-job appointment for a client", Icon: MapPin },
];

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #E5E2DC",
  fontSize: 14, fontFamily: FF, color: "#1A1917", background: "#FFFFFF", boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 700, color: "#6B7280", marginBottom: 6, fontFamily: FF,
};

export function EventModal({ open, onClose, onCreated, techs, presetDate, branchId }: EventModalProps) {
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [kind, setKind] = useState<Kind>("tech_block");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(presetDate);
  const [techId, setTechId] = useState<number | "">("");
  const [allDay, setAllDay] = useState(false);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("11:00");
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
    setAllDay(false); setStartTime("09:00"); setEndTime("11:00"); setNotes("");
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

  const needsTech = kind === "tech_block" || kind === "client_visit";
  const needsClient = kind === "client_visit";
  const showTimes = !(kind === "company_day" && allDay);

  const canSave =
    title.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    (!needsTech || techId !== "") &&
    (!needsClient || client !== null) &&
    !submitting;

  async function submit() {
    setError(null);
    if (!canSave) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        kind,
        title: title.trim(),
        event_date: date,
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 18 }}>
            {KIND_OPTIONS.map(opt => {
              const sel = kind === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => setKind(opt.value)}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6,
                    padding: "12px 12px", borderRadius: 12, cursor: "pointer", textAlign: "left",
                    border: `2px solid ${sel ? BRAND : "#E5E2DC"}`,
                    background: sel ? "rgba(0,201,160,0.05)" : "#FFFFFF",
                  }}
                >
                  <opt.Icon size={18} color={sel ? BRAND : "#6B7280"} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: sel ? "#0A0E1A" : "#1A1917" }}>{opt.label}</span>
                  <span style={{ fontSize: 11, color: "#9E9B94", lineHeight: 1.3 }}>{opt.desc}</span>
                </button>
              );
            })}
          </div>

          {/* Title */}
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
                <input type="time" style={inputStyle} value={startTime} onChange={e => setStartTime(e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>End</label>
                <input type="time" style={inputStyle} value={endTime} onChange={e => setEndTime(e.target.value)} />
              </div>
            </div>
          )}

          {/* Notes */}
          <div style={{ marginBottom: 6 }}>
            <label style={labelStyle}>Notes (optional)</label>
            <textarea style={{ ...inputStyle, minHeight: 64, resize: "vertical" }} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>

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
            {submitting ? "Creating…" : "Create event"}
          </button>
        </div>
      </div>
    </div>
  );
}
