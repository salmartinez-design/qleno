// [client-lead-reminders 2026-08-15] Francisco: "I mean creating them from the
// client or lead profile." Reminders already existed on the dashboard, but they
// were company-wide and unattached — you could not open a client and see "follow
// up about scheduling recurring service", and nobody owned the follow-up.
//
// This is the one panel both profiles mount. It reads and writes the SAME
// office_reminders rows the dashboard card shows, so a reminder created here
// still appears in the dashboard list (now labelled with who it's about) and
// completing it in either place completes it everywhere. Attaching to a client
// or lead is just a filter on that shared list, not a second system.
import { useState, useEffect, useCallback } from "react";
import { getAuthHeaders } from "@/lib/auth";

import { Bell, Check, Trash2, Clock } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

/** getAuthHeaders() is typed as a union; every caller in the app narrows it. */
const H = () => getAuthHeaders() as Record<string, string>;

export type Reminder = {
  id: number;
  title: string;
  notes: string | null;
  due_date: string;
  due_time: string | null;
  completed_at: string | null;
  created_by_name: string | null;
  assigned_to: number | null;
  assigned_to_name: string | null;
};

type Staff = { id: number; first_name?: string; last_name?: string; role?: string };

/** Local calendar day as YYYY-MM-DD — used only to colour overdue vs today. */
function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA");
}

function fmtDue(d: string, t: string | null): string {
  const day = new Date(d + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
  if (!t) return day;
  const [h, m] = t.split(":");
  const hr = parseInt(h);
  const ampm = hr >= 12 ? "pm" : "am";
  const h12 = hr % 12 === 0 ? 12 : hr % 12;
  return `${day} at ${h12}:${m}${ampm}`;
}

export function RemindersPanel({
  clientId, leadId, subjectLabel,
}: {
  clientId?: number;
  leadId?: number;
  /** "this client" / "this lead" — used in the empty-state copy. */
  subjectLabel?: string;
}) {
  const [items, setItems] = useState<Reminder[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [rescheduling, setRescheduling] = useState<number | null>(null);

  const scope = clientId ? `client_id=${clientId}` : leadId ? `lead_id=${leadId}` : "";
  const noun = subjectLabel || (leadId ? "this lead" : "this client");

  const load = useCallback(async () => {
    if (!scope) return;
    try {
      // Pending and completed in one call — the profile shows both, per
      // "view pending and completed reminders from the client/lead profile".
      const r = await fetch(`${API}/api/office-reminders?${scope}&include_completed=1`, {
        headers: H(),
      });
      if (r.ok) { const d = await r.json(); setItems(d.reminders || []); }
    } catch {}
    setLoaded(true);
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch(`${API}/api/users?limit=200&is_active=true`, { headers: H() })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return;
        const rows: Staff[] = Array.isArray(d) ? d : d.data || [];
        setStaff(rows.sort((a, b) =>
          `${a.first_name || ""} ${a.last_name || ""}`.localeCompare(`${b.first_name || ""} ${b.last_name || ""}`)));
      })
      .catch(() => {});
  }, []);

  async function add() {
    if (!title.trim() || !dueDate || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/office-reminders`, {
        method: "POST",
        headers: { ...H(), "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          notes: notes.trim() || null,
          due_date: dueDate,
          due_time: dueTime || null,
          assigned_to: assignedTo || null,
          ...(clientId ? { client_id: clientId } : {}),
          ...(leadId ? { lead_id: leadId } : {}),
        }),
      });
      if (r.ok) {
        setTitle(""); setNotes(""); setDueDate(""); setDueTime(""); setAssignedTo("");
        setAddOpen(false);
        await load();
      }
    } catch {}
    setBusy(false);
  }

  async function patch(id: number, body: Record<string, unknown>) {
    try {
      await fetch(`${API}/api/office-reminders/${id}`, {
        method: "PATCH",
        headers: { ...H(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      await load();
    }
  }

  async function remove(id: number) {
    setItems(prev => prev.filter(x => x.id !== id));
    try {
      await fetch(`${API}/api/office-reminders/${id}`, { method: "DELETE", headers: H() });
    } catch { load(); }
  }

  const today = todayLocal();
  const pending = items.filter(r => !r.completed_at);
  const done = items.filter(r => r.completed_at);

  const inputStyle: React.CSSProperties = {
    padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 8,
    fontSize: 13, fontFamily: FF, color: "#1A1917", background: "#FFFFFF",
  };

  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Bell size={14} color="#9E9B94" />
          <p style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", margin: 0, fontFamily: FF }}>
            Notes &amp; Reminders{pending.length ? ` (${pending.length})` : ""}
          </p>
        </div>
        <button onClick={() => setAddOpen(o => !o)}
          style={{ padding: "5px 12px", border: "1px solid #E5E2DC", borderRadius: 7, background: addOpen ? "#F7F6F3" : "#FFFFFF", color: "#1A1917", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
          {addOpen ? "Close" : "+ Reminder"}
        </button>
      </div>

      {addOpen && (
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <input value={title} onChange={e => setTitle(e.target.value)} autoFocus
            placeholder="e.g. Follow up about scheduling recurring service"
            onKeyDown={e => { if (e.key === "Enter") add(); }} style={inputStyle} />
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
            placeholder="Internal note (optional) — only staff can see this"
            style={{ ...inputStyle, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
              style={{ ...inputStyle, flex: "1 1 140px" }} />
            <input type="time" value={dueTime} onChange={e => setDueTime(e.target.value)}
              style={{ ...inputStyle, flex: "1 1 110px" }} />
            <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)}
              style={{ ...inputStyle, flex: "1 1 160px", cursor: "pointer" }}>
              <option value="">Assign to…</option>
              {staff.map(s => (
                <option key={s.id} value={s.id}>
                  {`${s.first_name || ""} ${s.last_name || ""}`.trim() || `User ${s.id}`}
                </option>
              ))}
            </select>
          </div>
          <button onClick={add} disabled={busy || !title.trim() || !dueDate}
            style={{ padding: "9px 16px", border: "none", borderRadius: 8, justifySelf: "start",
              background: busy || !title.trim() || !dueDate ? "#D0CEC9" : "var(--brand)",
              color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: busy ? "default" : "pointer", fontFamily: FF }}>
            Add reminder
          </button>
        </div>
      )}

      {!loaded ? null : pending.length === 0 && !addOpen ? (
        <p style={{ fontSize: 12, color: "#9E9B94", margin: "10px 0 0", fontFamily: FF }}>
          No reminders for {noun}. Use "+ Reminder" for follow-ups, pending quotes, callbacks or concerns.
        </p>
      ) : (
        <div style={{ marginTop: pending.length ? 10 : 0 }}>
          {pending.map((r, i) => {
            const overdue = r.due_date < today;
            const isToday = r.due_date === today;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 0", borderTop: i === 0 ? "none" : "1px solid #F0EEE9" }}>
                <button onClick={() => patch(r.id, { completed: true })} title="Mark done"
                  style={{ width: 18, height: 18, marginTop: 1, flexShrink: 0, border: "1.5px solid #C9C6BF", borderRadius: 5, background: "#FFFFFF", cursor: "pointer", padding: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 13, color: "#1A1917", fontFamily: FF, wordBreak: "break-word" }}>{r.title}</p>
                  {r.notes && (
                    <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6B6860", fontFamily: FF, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.notes}</p>
                  )}
                  <p style={{ margin: "2px 0 0", fontSize: 11, fontWeight: 600, fontFamily: FF, color: overdue ? "#B3261E" : isToday ? "#0A6E5A" : "#9E9B94" }}>
                    {overdue ? `Overdue — ${fmtDue(r.due_date, r.due_time)}` : isToday ? `Today${r.due_time ? ` at ${fmtDue(r.due_date, r.due_time).split(" at ")[1]}` : ""}` : fmtDue(r.due_date, r.due_time)}
                    {r.assigned_to_name ? ` · ${r.assigned_to_name}` : ""}
                  </p>
                  {rescheduling === r.id ? (
                    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      <input type="date" defaultValue={r.due_date}
                        onChange={e => e.target.value && patch(r.id, { due_date: e.target.value }).then(() => setRescheduling(null))}
                        style={{ ...inputStyle, padding: "5px 8px", fontSize: 12 }} />
                      <button onClick={() => setRescheduling(null)}
                        style={{ border: "none", background: "none", color: "#9E9B94", fontSize: 11, cursor: "pointer", fontFamily: FF }}>Cancel</button>
                    </div>
                  ) : (
                    <button onClick={() => setRescheduling(r.id)}
                      style={{ marginTop: 4, padding: 0, border: "none", background: "none", color: "var(--brand)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: FF, display: "flex", alignItems: "center", gap: 4 }}>
                      <Clock size={11} /> Reschedule
                    </button>
                  )}
                </div>
                <button onClick={() => remove(r.id)} title="Delete"
                  style={{ flexShrink: 0, border: "none", background: "none", color: "#C9C6BF", cursor: "pointer", padding: 4, fontFamily: FF, lineHeight: 1 }}>
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {done.length > 0 && (
        <div style={{ marginTop: 10, borderTop: "1px solid #F0EEE9", paddingTop: 8 }}>
          <button onClick={() => setShowDone(s => !s)}
            style={{ border: "none", background: "none", padding: 0, color: "#9E9B94", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
            {showDone ? "Hide" : "Show"} completed ({done.length})
          </button>
          {showDone && done.map(r => (
            <div key={r.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 0" }}>
              <Check size={14} color="#0A6E5A" style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ margin: 0, fontSize: 12, color: "#9E9B94", fontFamily: FF, textDecoration: "line-through", wordBreak: "break-word" }}>{r.title}</p>
                <p style={{ margin: "1px 0 0", fontSize: 11, color: "#C9C6BF", fontFamily: FF }}>
                  {fmtDue(r.due_date, r.due_time)}{r.assigned_to_name ? ` · ${r.assigned_to_name}` : ""}
                </p>
              </div>
              <button onClick={() => patch(r.id, { completed: false })} title="Reopen"
                style={{ flexShrink: 0, border: "none", background: "none", color: "#9E9B94", fontSize: 11, cursor: "pointer", fontFamily: FF }}>
                Reopen
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
