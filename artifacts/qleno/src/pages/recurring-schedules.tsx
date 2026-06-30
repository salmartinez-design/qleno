import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { RefreshCw, Clock, Search, AlertTriangle } from "lucide-react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { FREQUENCY_LABELS } from "@/lib/frequency-labels";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Schedule = {
  id: number;
  customer_id: number;
  client_name: string;
  frequency: string;
  day_of_week: string | null;
  start_date: string | null;
  scheduled_time: string | null;
  service_type: string | null;
  duration_minutes: number | null;
  base_fee: string | null;
  is_active: boolean;
};

// Canonical plain-language labels — see lib/frequency-labels.
const FREQ_LABEL = FREQUENCY_LABELS;

function fmtTime(t: string | null) {
  if (!t) return null;
  const [h, m] = String(t).split(":");
  let hh = parseInt(h, 10);
  if (isNaN(hh)) return null;
  const ap = hh >= 12 ? "PM" : "AM";
  hh = hh % 12 || 12;
  return `${hh}:${(m ?? "00").slice(0, 2)} ${ap}`;
}

// [recurring-anchor-audit 2026-06-10] The recurring engine anchors a single-day
// schedule on its day_of_week when that's set — even if it disagrees with the
// real start_date. MaidCentral-imported rows sometimes carry a day_of_week
// that doesn't match the start date, so jobs land on the wrong day (e.g.
// "Monday" instead of the true start weekday). Surface the mismatch so the
// office can fix it (edit the schedule's day, or clear it to follow start_date).
const DOW_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
function startWeekday(start: string | null): string | null {
  if (!start) return null;
  const d = new Date(`${String(start).slice(0, 10)}T12:00:00`); // noon = DST/UTC-safe
  return isNaN(d.getTime()) ? null : DOW_NAMES[d.getDay()];
}
function anchorMismatch(r: Schedule): string | null {
  const singleDay = !["daily", "weekdays", "custom_days"].includes(r.frequency);
  if (!singleDay || !r.day_of_week || !r.start_date) return null;
  const actual = startWeekday(r.start_date);
  if (!actual || actual === r.day_of_week.toLowerCase()) return null;
  return `Set to ${cap(r.day_of_week)} but the start date is a ${cap(actual)} — jobs land on ${cap(r.day_of_week)}. Edit the schedule to fix.`;
}

export default function RecurringSchedulesPage() {
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [rows, setRows] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [onlyMissingTime, setOnlyMissingTime] = useState(false);
  const [bulkTime, setBulkTime] = useState("09:00");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/recurring`, { headers: getAuthHeaders() });
      const d = await r.json();
      setRows(Array.isArray(d) ? d : (d?.data ?? []));
    } catch { setRows([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r =>
      (!q || (r.client_name || "").toLowerCase().includes(q)) &&
      (!onlyMissingTime || !r.scheduled_time)
    );
  }, [rows, search, onlyMissingTime]);

  const missingTimeCount = rows.filter(r => !r.scheduled_time).length;
  const allShownSelected = filtered.length > 0 && filtered.every(r => selected.has(r.id));

  function toggle(id: number) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(prev => {
      if (filtered.every(r => prev.has(r.id))) {
        const n = new Set(prev); filtered.forEach(r => n.delete(r.id)); return n;
      }
      const n = new Set(prev); filtered.forEach(r => n.add(r.id)); return n;
    });
  }

  async function applyBulkTime() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/recurring/bulk`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ ids, scheduled_time: bulkTime }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || d.message || `HTTP ${r.status}`);
      toast({ title: `Time set on ${ids.length} schedule${ids.length === 1 ? "" : "s"}`, description: d.jobs_generated ? `${d.jobs_generated} upcoming visits created` : undefined });
      setSelected(new Set());
      load();
    } catch (e: any) {
      toast({ title: "Couldn't update", description: e?.message ?? "Try again", variant: "destructive" });
    } finally { setSaving(false); }
  }

  const th: React.CSSProperties = { textAlign: "left", fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em", padding: "8px 12px", borderBottom: "1px solid #E5E2DC" };
  const td: React.CSSProperties = { fontSize: 13, color: "#1A1917", padding: "10px 12px", borderBottom: "1px solid #F3F4F6" };

  return (
    <DashboardLayout>
      <div style={{ padding: 24, maxWidth: 1000, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <RefreshCw size={20} style={{ color: "var(--brand, #00C9A0)" }} />
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "#1A1917", margin: 0 }}>Recurring Schedules</h1>
        </div>
        <p style={{ fontSize: 13, color: "#6B7280", margin: "0 0 16px" }}>
          Set the visit time on many schedules at once. Pick the schedules, choose a time, and apply.
        </p>

        {/* Controls */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <div style={{ position: "relative", flex: 1, minWidth: 220 }}>
            <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#9E9B94" }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by customer…"
              style={{ width: "100%", padding: "8px 10px 8px 30px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#1A1917", cursor: "pointer" }}>
            <input type="checkbox" checked={onlyMissingTime} onChange={e => setOnlyMissingTime(e.target.checked)} />
            Only missing a time {missingTimeCount > 0 && <span style={{ color: "#9E9B94" }}>({missingTimeCount})</span>}
          </label>
        </div>

        {/* Bulk bar */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 14px", background: selected.size ? "#F0FDFB" : "#F7F6F3", border: `1px solid ${selected.size ? "#99E6D5" : "#E5E2DC"}`, borderRadius: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{selected.size} selected</span>
          <span style={{ color: "#9E9B94" }}>·</span>
          <Clock size={14} style={{ color: "#6B7280" }} />
          <input type="time" value={bulkTime} onChange={e => setBulkTime(e.target.value)}
            style={{ padding: "6px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none" }} />
          <button onClick={applyBulkTime} disabled={selected.size === 0 || saving}
            style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: selected.size && !saving ? "var(--brand, #00C9A0)" : "#D1D5DB", color: "#fff", fontSize: 13, fontWeight: 700, cursor: selected.size && !saving ? "pointer" : "default", fontFamily: "inherit" }}>
            {saving ? "Applying…" : "Set time for selected"}
          </button>
        </div>

        {/* Mobile: card list (a wide table is unusable on a phone) */}
        {isMobile ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {loading ? (
              <p style={{ fontSize: 13, color: "#9E9B94", textAlign: "center", padding: 20 }}>Loading…</p>
            ) : filtered.length === 0 ? (
              <p style={{ fontSize: 13, color: "#9E9B94", textAlign: "center", padding: 20 }}>No recurring schedules.</p>
            ) : filtered.map(r => (
              <div key={r.id} onClick={() => toggle(r.id)}
                style={{ background: selected.has(r.id) ? "#F0FDFB" : "#fff", border: `1px solid ${selected.has(r.id) ? "#99E6D5" : "#E5E2DC"}`, borderRadius: 12, padding: 14, display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
                <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} onClick={e => e.stopPropagation()} style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>{r.client_name?.trim() || `#${r.customer_id}`}</p>
                  <p style={{ fontSize: 12, color: "#6B7280", margin: "0 0 2px" }}>
                    {FREQ_LABEL[r.frequency] ?? r.frequency}{r.day_of_week ? ` · ${r.day_of_week}` : ""} · {r.base_fee ? `$${parseFloat(r.base_fee).toFixed(2)}` : "—"}
                  </p>
                  {anchorMismatch(r) && (
                    <p style={{ display: "inline-flex", alignItems: "flex-start", gap: 5, fontSize: 11, fontWeight: 600, color: "#92400E", background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 6, padding: "4px 8px", margin: "2px 0 4px", lineHeight: 1.4 }}>
                      <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} /> {anchorMismatch(r)}
                    </p>
                  )}
                  <p style={{ fontSize: 12, margin: 0 }}>
                    {fmtTime(r.scheduled_time)
                      ? <span style={{ color: "#1A1917", fontWeight: 600 }}>{fmtTime(r.scheduled_time)}</span>
                      : <span style={{ color: "#B45309", fontWeight: 700 }}>No time set</span>}
                  </p>
                  <Link href={`/customers/${r.customer_id}`} onClick={e => e.stopPropagation()} style={{ fontSize: 12, color: "var(--brand, #00C9A0)", fontWeight: 600, display: "inline-block", marginTop: 6 }}>Open profile</Link>
                </div>
              </div>
            ))}
          </div>
        ) : (
        /* Desktop: table */
        <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 36 }}><input type="checkbox" checked={allShownSelected} onChange={toggleAll} /></th>
                <th style={th}>Customer</th>
                <th style={th}>How often</th>
                <th style={th}>Day</th>
                <th style={th}>Time</th>
                <th style={th}>Rate</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td style={{ ...td, textAlign: "center", color: "#9E9B94" }} colSpan={7}>Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td style={{ ...td, textAlign: "center", color: "#9E9B94" }} colSpan={7}>No recurring schedules.</td></tr>
              ) : filtered.map(r => (
                <tr key={r.id} style={{ background: selected.has(r.id) ? "#F0FDFB" : "#fff" }}>
                  <td style={td}><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td style={{ ...td, fontWeight: 600 }}>{r.client_name?.trim() || `#${r.customer_id}`}</td>
                  <td style={td}>{FREQ_LABEL[r.frequency] ?? r.frequency}</td>
                  <td style={{ ...td, textTransform: "capitalize" }}>
                    {r.day_of_week || "—"}
                    {anchorMismatch(r) && (
                      <span title={anchorMismatch(r)!} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8, fontSize: 11, fontWeight: 700, color: "#92400E", background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 6, padding: "1px 6px", textTransform: "none", cursor: "help" }}>
                        <AlertTriangle size={11} /> Wrong day
                      </span>
                    )}
                  </td>
                  <td style={td}>
                    {fmtTime(r.scheduled_time)
                      ?? <span style={{ color: "#B45309", fontWeight: 600 }}>No time set</span>}
                  </td>
                  <td style={td}>{r.base_fee ? `$${parseFloat(r.base_fee).toFixed(2)}` : "—"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <Link href={`/customers/${r.customer_id}`} style={{ fontSize: 12, color: "var(--brand, #00C9A0)", fontWeight: 600 }}>Open profile</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </DashboardLayout>
  );
}
