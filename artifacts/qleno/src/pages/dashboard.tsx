import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLocation, Link } from "wouter";
import { ChevronRight, Calendar, ShieldAlert, Building2, Car, Check, X } from "lucide-react";
import { CloseDayModal } from "@/components/close-day-modal";
import { useBranch } from "@/contexts/branch-context";
import MobileDashboard from "@/components/mobile-dashboard";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// [booked-today-drilldown 2026-07-22] Today's calendar date in America/Chicago —
// the tz the "booked today" KPI counts in server-side. Using the browser's local
// date instead would hand the drill-down a different day than the tile counted
// for anyone not on Central time.
function ctToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

const FF = "'Plus Jakarta Sans', sans-serif";

function apiFetch(path: string) {
  return fetch(`${API}${path}`, { headers: getAuthHeaders() });
}

// [dashboard-resilience 2026-07-08] A dashboard tab that's open across a deploy
// hits the readiness gate (HTTP 503, "warming up") for ~30–60s. The one-shot
// GETs used to give up on that first failure and leave the card blank/zero
// until a manual reload (Sal: "shows zeros / long time to load again"). This
// retries a read a few times with short backoff so the dashboard self-heals
// within seconds of the server coming back — no reload needed. GET-only; never
// used for writes.
async function fetchJsonWithRetry(path: string, tries = 6, delayMs = 2500): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await apiFetch(path);
      if (r.ok) return await r.json();
    } catch { /* network/warmup — fall through to retry */ }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
}

function fmt$(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

// [ui-consistency 2026-07-22] The value itself is always --ink. Direction is
// carried by this chip and nothing else, so a row of numbers reads as one
// scale instead of four competing colors.
function DeltaBadge({ delta, suffix }: { delta: number | null; suffix?: string }) {
  if (delta === null || delta === undefined) return null;
  const pos = delta >= 0;
  return (
    <span style={{
      fontSize: 12, fontWeight: 600,
      color: pos ? 'var(--ok)' : 'var(--danger)',
      background: pos ? 'var(--ok-bg)' : 'var(--danger-bg)',
      borderRadius: 4, padding: '1px 6px', fontFamily: FF,
    }}>
      {pos ? '+' : ''}{delta}%{suffix ? ` ${suffix}` : ''}
    </span>
  );
}

function useToday(branchId: number | "all") {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    // Holds the previous branch's tiles until the new ones land — same
    // no-blank-on-refetch rule as the period hooks below.
    let alive = true;
    const qs = branchId !== "all" ? `?branch_id=${branchId}` : "";
    const load = async () => {
      const j = await fetchJsonWithRetry(`/api/dashboard/today${qs}`);
      if (alive && j) setData(j);
    };
    load();
    const iv = setInterval(load, 60000);
    return () => { alive = false; clearInterval(iv); };
  }, [branchId]);
  return data;
}

// [office-reminders 2026-07-07] Internal reminders for the office (Maribel:
// "Do we have the options to set reminders form Qleno?"). Plain company-wide
// list — nothing here messages customers. Overdue reminders stay visible in
// red until completed or deleted.
// [dashboard-leads 2026-07-08] Sal: the dashboard never showed the leads
// pipeline — how many came in online vs office, or that a lead closed to
// booked. This card surfaces this-month intake (online/office/booked) + the
// open pipeline, each tile clicking through to the filtered Leads board.
function LeadsCard({ isMobile }: { isMobile: boolean }) {
  const [, navigate] = useLocation();
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    fetchJsonWithRetry("/api/leads/summary").then((j) => { if (alive && j) setData(j); });
    return () => { alive = false; };
  }, []);
  if (!data) return null;
  // [today-view 2026-07-08] Sal wants today, not month — "as an owner I need to
  // know what's going on today; month I check in a report." Card reads today's
  // intake; the pipeline chips below stay all-time (that's the current backlog).
  const m = data.today || {}; const p = data.pipeline || {};
  const Tile = ({ label, value, sub, onClick, accent }: { label: string; value: number; sub?: string; onClick: () => void; accent?: string }) => (
    <button onClick={onClick} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "12px 14px", cursor: "pointer", fontFamily: FF }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || "#1A1917", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: "#9E9B94", marginTop: 1 }}>{sub}</div>}
    </button>
  );
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 10px" }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", margin: 0, fontFamily: FF }}>Leads · Today</p>
        <button onClick={() => navigate("/leads")} style={{ fontSize: 11, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: FF, fontWeight: 600 }}>Open pipeline →</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 8 }}>
        {/* [dashboard-deeplink 2026-07-21] Each tile lands on the board filtered
            to exactly what it counted, instead of dumping onto the full list.
            Today's-intake tiles carry ?window=today (+ channel); Booked opens the
            Booked column (booked-today is a booked_at metric, not created-today,
            so it deep-links the stage rather than a mismatched date window). */}
        <Tile label="New leads" value={m.total ?? 0} sub={`${m.online ?? 0} online · ${m.office ?? 0} office`} onClick={() => navigate("/leads?window=today")} />
        <Tile label="Online" value={m.online ?? 0} sub="from the web" onClick={() => navigate("/leads?window=today&channel=online")} />
        <Tile label="Office" value={m.office ?? 0} sub="phone / walk-in" onClick={() => navigate("/leads?window=today&channel=office")} />
        <Tile label="Booked" value={m.booked ?? 0} sub="closed today" accent="#0A6E5A" onClick={() => navigate("/leads?status=booked")} />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        {[
          { k: "Needs contact", v: p.needs_contact ?? 0, c: "#B3261E", to: "/leads?status=new,needs_contacted" },
          { k: "Contacted", v: p.contacted ?? 0, c: "#B45309", to: "/leads?status=contacted" },
          { k: "Quoted", v: p.quoted ?? 0, c: "#2F3646", to: "/leads?status=quoted" },
          { k: "Booked (open)", v: p.booked ?? 0, c: "#0A6E5A", to: "/leads?status=booked" },
        ].map(chip => (
          <button key={chip.k} onClick={() => navigate(chip.to)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", border: "1px solid #E5E2DC", borderRadius: 20, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: chip.c }} />
            <span style={{ fontSize: 12, color: "#6B6860" }}>{chip.k}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#1A1917" }}>{chip.v}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function OfficeReminders({ isMobile }: { isMobile: boolean }) {
  const [reminders, setReminders] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const load = async () => {
    try {
      const r = await apiFetch("/api/office-reminders");
      if (r.ok) { const d = await r.json(); setReminders(d.reminders || []); }
    } catch {}
    setLoaded(true);
  };
  useEffect(() => { load(); }, []);

  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  async function add() {
    if (!title.trim() || !dueDate || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/office-reminders`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), due_date: dueDate }),
      });
      if (r.ok) { setTitle(""); setDueDate(""); setAddOpen(false); await load(); }
    } catch {}
    setBusy(false);
  }
  async function complete(id: number) {
    setReminders(prev => prev.filter(x => x.id !== id));
    try {
      await fetch(`${API}/api/office-reminders/${id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true }),
      });
    } catch { load(); }
  }
  async function remove(id: number) {
    setReminders(prev => prev.filter(x => x.id !== id));
    try {
      await fetch(`${API}/api/office-reminders/${id}`, { method: "DELETE", headers: getAuthHeaders() });
    } catch { load(); }
  }
  const fmtDue = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: reminders.length || addOpen ? 10 : 0 }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", margin: 0, fontFamily: FF }}>
          Office Reminders{reminders.length ? ` (${reminders.length})` : ""}
        </p>
        <button onClick={() => setAddOpen(o => !o)}
          style={{ padding: "5px 12px", border: "1px solid #E5E2DC", borderRadius: 7, background: addOpen ? "#F7F6F3" : "#FFFFFF", color: "#1A1917", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
          {addOpen ? "Close" : "+ Reminder"}
        </button>
      </div>
      {addOpen && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: isMobile ? "wrap" : "nowrap" }}>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Call Daveco about payment"
            onKeyDown={e => { if (e.key === "Enter") add(); }}
            style={{ flex: "1 1 220px", padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, color: "#1A1917", background: "#FFFFFF" }} />
          <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
            style={{ padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, color: "#1A1917", background: "#FFFFFF" }} />
          <button onClick={add} disabled={busy || !title.trim() || !dueDate}
            style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: busy || !title.trim() || !dueDate ? "#D0CEC9" : "var(--brand)", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: busy ? "default" : "pointer", fontFamily: FF }}>
            Add
          </button>
        </div>
      )}
      {!loaded ? null : reminders.length === 0 ? (
        !addOpen && <p style={{ fontSize: 12, color: "#9E9B94", margin: "8px 0 0", fontFamily: FF }}>No reminders. Use "+ Reminder" for office to-dos — "call Daveco Friday", "Lupe out until July 11".</p>
      ) : (
        <div>
          {reminders.map((r, i) => {
            const overdue = r.due_date < todayStr;
            const isToday = r.due_date === todayStr;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: i === 0 ? "none" : "1px solid #F0EEE9" }}>
                <button onClick={() => complete(r.id)} title="Mark done"
                  style={{ width: 18, height: 18, flexShrink: 0, border: "1.5px solid #C9C6BF", borderRadius: 5, background: "#FFFFFF", cursor: "pointer", padding: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 13, color: "#1A1917", fontFamily: FF, wordBreak: "break-word" }}>{r.title}</p>
                  <p style={{ margin: "1px 0 0", fontSize: 11, fontWeight: 600, fontFamily: FF, color: overdue ? "#B3261E" : isToday ? "#0A6E5A" : "#9E9B94" }}>
                    {overdue ? `Overdue — ${fmtDue(r.due_date)}` : isToday ? "Today" : fmtDue(r.due_date)}
                    {r.created_by_name ? ` · ${r.created_by_name}` : ""}
                  </p>
                </div>
                <button onClick={() => remove(r.id)} title="Delete"
                  style={{ flexShrink: 0, border: "none", background: "none", color: "#C9C6BF", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 4, fontFamily: FF }}>
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function useKpis() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    fetchJsonWithRetry('/api/dashboard/kpis').then((j) => { if (alive && j) setData(j); });
    return () => { alive = false; };
  }, []);
  return data;
}

function useRevenueChart() {
  const [data, setData] = useState<{ data: { month: string; revenue: number; jobs: number }[]; prior_year: { month: string; revenue: number }[] }>({ data: [], prior_year: [] });
  useEffect(() => {
    let alive = true;
    fetchJsonWithRetry('/api/dashboard/revenue-chart').then((json) => {
      if (alive && json) setData({ data: json.data || [], prior_year: json.prior_year || [] });
    });
    return () => { alive = false; };
  }, []);
  return data;
}

function useTechsToday() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    const load = async () => {
      try {
        const r = await apiFetch('/api/dashboard/techs-today');
        if (r.ok) setData(await r.json());
      } catch {}
    };
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, []);
  return data;
}

function useFirstName(): string {
  const token = useAuthStore(state => state.token) || '';
  const [name, setName] = useState('');
  useEffect(() => {
    try {
      const p = JSON.parse(atob(token.split('.')[1]));
      if (p.first_name) { setName(p.first_name); return; }
    } catch {}
    if (!token) return;
    apiFetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.first_name) setName(d.first_name); })
      .catch(() => {});
  }, [token]);
  return name;
}

function useGreeting(firstName: string) {
  const hour = new Date().getHours();
  const suffix = firstName ? `, ${firstName}` : '';
  if (hour < 12) return `Good morning${suffix}.`;
  if (hour < 17) return `Good afternoon${suffix}.`;
  return `Good evening${suffix}.`;
}

// One card treatment for the whole page: white, one border, one radius.
// The audit found 8/10/12px cards and two near-identical grays across the app.
const CARD: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-card)',
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--ink-faint)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  margin: '0 0 10px', fontFamily: FF,
};

// One gap value for every grid on the page. Columns line up down the whole
// dashboard — the thing that most read as "not enterprise" before.
const GAP = 12;

// ── Weekly Forecast hook ──────────────────────────────────────────────────────
function useWeeklyForecast() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    setLoading(true); setError(false);
    apiFetch('/api/dashboard/weekly-forecast')
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, []);
  return { data, loading, error };
}

// ── Recent Activity (HCP-style stream, under the revenue forecast) ────────────
type ActivityRow = {
  id: number; action: string; target_type: string; target_id: string | null;
  new_value: any; performed_at: string; user_name: string | null;
};

function useRecentActivity() {
  const [data, setData] = useState<ActivityRow[] | null>(null);
  useEffect(() => {
    const load = async () => {
      try {
        const r = await apiFetch('/api/dashboard/recent-activity?limit=12');
        if (r.ok) { const j = await r.json(); setData(j.activities || []); }
      } catch {}
    };
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, []);
  return data;
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const min = Math.floor((Date.now() - then) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function actMoney(v: any): string | null {
  const n = parseFloat(String(v ?? ''));
  return isNaN(n) ? null : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Map a raw audit row to a human label + in-app route. The frontend owns the
// route table, so links stay correct if routes move.
function describeActivity(a: ActivityRow): { label: string; link: string | null } {
  const id = a.target_id;
  const nv = a.new_value || {};
  const amt = actMoney(nv.total_price ?? nv.amount ?? nv.total);
  const verb = a.action.toLowerCase().replace(/_/g, ' ');
  switch (a.target_type) {
    case 'quote':
      if (a.action === 'CONVERTED') return { label: `Quote #${id} converted to a job`, link: id ? `/quotes/${id}` : null };
      if (a.action === 'CREATE') return { label: `Quote #${id} created${amt ? ` — ${amt}` : ''}`, link: id ? `/quotes/${id}` : null };
      if (a.action === 'DELETE') return { label: `Quote #${id} deleted`, link: null };
      return { label: `Quote #${id} ${verb}`, link: id ? `/quotes/${id}` : null };
    case 'job':
      if (a.action === 'CREATE') return { label: `New job created${amt ? ` — ${amt}` : ''}`, link: '/dispatch' };
      if (a.action === 'UPDATE') return { label: `Job #${id} updated`, link: '/dispatch' };
      if (a.action === 'DELETE') return { label: `Job #${id} deleted`, link: null };
      if (a.action === 'SET_ZONE') return { label: `Job #${id} zone set`, link: '/dispatch' };
      return { label: `Job #${id} ${verb}`, link: '/dispatch' };
    case 'invoice':
      if (a.action === 'PAYMENT_CHARGED') return { label: `Payment charged${amt ? ` — ${amt}` : ''}`, link: id ? `/invoices/${id}` : '/invoices' };
      if (a.action === 'CREATE') return { label: `Invoice created${amt ? ` — ${amt}` : ''}`, link: id ? `/invoices/${id}` : '/invoices' };
      return { label: `Invoice #${id} ${verb}`, link: id ? `/invoices/${id}` : '/invoices' };
    case 'client':
      if (a.action === 'CREATE') return { label: 'New client added', link: id ? `/customers/${id}` : '/customers' };
      return { label: `Client ${verb}`, link: id ? `/customers/${id}` : '/customers' };
    case 'employee': {
      const map: Record<string, string> = {
        CREATE: 'Employee added', CREATE_EMPLOYEE: 'Employee added',
        DELETE: 'Employee removed', DELETE_EMPLOYEE: 'Employee removed',
        ACTIVATE_EMPLOYEE: 'Employee activated', DEACTIVATE_EMPLOYEE: 'Employee deactivated',
        UPDATE: 'Employee updated',
      };
      return { label: map[a.action] || `Employee ${verb}`, link: id ? `/employees/${id}` : '/employees' };
    }
    default:
      return { label: `${a.target_type} ${verb}`, link: null };
  }
}

function RecentActivitySection() {
  const activities = useRecentActivity();
  const [, setLocation] = useLocation();
  return (
    <div>
      <p style={{ fontSize: 11, fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px', fontFamily: FF }}>Recent Activity</p>
      <div style={{ ...CARD, padding: '6px 0' }}>
        {activities == null ? (
          <p style={{ fontSize: 13, color: '#9E9B94', fontFamily: FF, padding: '14px 24px', margin: 0 }}>Loading…</p>
        ) : activities.length === 0 ? (
          <p style={{ fontSize: 13, color: '#9E9B94', fontFamily: FF, padding: '14px 24px', margin: 0 }}>No recent activity in the last 30 days.</p>
        ) : (
          activities.map((a, i) => {
            const { label, link } = describeActivity(a);
            return (
              <div
                key={a.id}
                onClick={() => link && setLocation(link)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                  padding: '11px 24px',
                  borderTop: i === 0 ? 'none' : '0.5px solid #F0EEE9',
                  cursor: link ? 'pointer' : 'default',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 500, color: '#1A1917', margin: 0, fontFamily: FF, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</p>
                  <p style={{ fontSize: 11, color: '#9E9B94', margin: '2px 0 0', fontFamily: FF }}>{a.user_name || 'System'}</p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ fontSize: 11, color: '#9E9B94', fontFamily: FF }}>{relTime(a.performed_at)}</span>
                  {link && <ChevronRight size={14} color="#C9C5BD" />}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── WeeklyForecastSection component ──────────────────────────────────────────
function fmtWF(n: number) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

type WFDay = {
  date: string; day_name: string; revenue: number; job_count: number;
  unassigned_count: number; is_weekend: boolean; is_past: boolean; is_today: boolean;
  entry_type: 'last' | 'current' | 'projected';
};
type WFWeek = {
  id: string; label: string; date_range: string;
  total_revenue: number; total_jobs: number; total_unassigned: number;
  daily_avg: number; daily_avg_jobs: number; days: WFDay[];
};

function dayStyle(day: WFDay, dailyAvg: number): { bg: string; revColor: string; jobColor: string; bar: string; border: string | undefined } {
  if (day.is_weekend) return { bg: '#F7F6F3', revColor: '#6B6860', jobColor: '#6B6860', bar: '#E5E2DC', border: undefined };

  const { revenue, is_past, entry_type } = day;
  const isProjected = entry_type === 'projected';

  let color: 'green' | 'amber' | 'red' = 'amber';
  if (dailyAvg > 0) {
    if (revenue >= dailyAvg * 0.9) color = 'green';
    else if (revenue >= dailyAvg * 0.6) color = 'amber';
    else color = 'red'; // < 60% OR revenue=0 and past
  }
  if (revenue === 0 && !is_past && !isProjected) color = 'amber'; // future unbooked weekday on current week, no avg

  const styles = {
    green: { bg: '#EAF3DE', revColor: '#27500A', jobColor: '#3B6D11', bar: '#639922' },
    amber: { bg: '#FAEEDA', revColor: '#633806', jobColor: '#854F0B', bar: '#EF9F27' },
    red:   { bg: '#FCEBEB', revColor: '#791F1F', jobColor: '#A32D2D', bar: '#E24B4A' },
  };
  const base = styles[color];

  // Projected days: override bg + border unless red
  if (isProjected) {
    if (color === 'red') return { ...base, border: '1.5px dashed #E24B4A' };
    // amber or green projected → neutral bg, dashed border
    return { ...base, bg: '#F7F6F3', border: '0.5px dashed #E5E2DC' };
  }

  return { ...base, border: undefined };
}

function WeeklyForecastSection() {
  const { data, loading, error } = useWeeklyForecast();
  const [selectedWeekId, setSelectedWeekId] = useState<string>('current');
  const todayStr = new Date().toISOString().split('T')[0];

  if (error) {
    return (
      <div style={{ padding: '14px 18px', background: '#F7F6F3', border: '0.5px solid #E5E2DC', borderRadius: 10, fontSize: 12, color: '#9E9B94', fontFamily: FF }}>
        Weekly forecast unavailable — check back shortly.
      </div>
    );
  }

  if (loading || !data) {
    return (
      <>
        <style>{`@keyframes wf-pulse{0%,100%{opacity:1}50%{opacity:.45}}`}</style>
        <div style={{ background: '#FFFFFF', border: '0.5px solid #E5E2DC', borderRadius: 12, padding: '24px' }}>
          <div style={{ width: 200, height: 12, background: '#F0EEE9', borderRadius: 4, marginBottom: 16, animation: 'wf-pulse 1.5s ease-in-out infinite' }} />
          <div style={{ width: '100%', height: 100, background: '#F0EEE9', borderRadius: 6, animation: 'wf-pulse 1.5s ease-in-out infinite' }} />
        </div>
      </>
    );
  }

  const weeks: WFWeek[] = data.weeks;
  const week = weeks.find(w => w.id === selectedWeekId) ?? weeks[1];
  const isCurrentWeek = week.id === 'current';
  const isNextWeek = week.id === 'next';
  const isLastWeek = week.id === 'last';

  const weekdays = week.days.filter(d => !d.is_weekend);
  const redDays = weekdays.filter(d => dayStyle(d, week.daily_avg).revColor === '#791F1F');
  const firstRed = redDays[0];

  let summaryNote = '';
  if (isLastWeek) {
    summaryNote = `Daily avg (Mon–Fri): ${fmtWF(week.daily_avg)} · Sun/Sat closed`;
  } else if (isCurrentWeek) {
    if (firstRed) {
      summaryNote = `${firstRed.day_name} is thin — ${firstRed.job_count} jobs vs ${week.daily_avg_jobs} avg`;
      if (week.total_unassigned > 0) summaryNote += ` · ${week.total_unassigned} unassigned`;
    } else {
      summaryNote = `On track — ${week.total_jobs} jobs booked this week`;
      if (week.total_unassigned > 0) summaryNote += ` · ${week.total_unassigned} unassigned`;
    }
  } else {
    summaryNote = firstRed
      ? `${firstRed.day_name} critically thin — ${firstRed.job_count} jobs vs ${week.daily_avg_jobs} avg. Fill now.`
      : `${week.total_jobs} jobs projected. Looks healthy.`;
  }

  const summaryParts: JSX.Element[] = [
    <span key="rev">{fmtWF(week.total_revenue)} {isLastWeek ? 'actual' : isCurrentWeek ? 'booked' : 'projected'}</span>,
    <span key="d1" style={{ color: '#C5C0B8' }}> · </span>,
    <span key="jobs">{week.total_jobs} jobs{isNextWeek ? ' scheduled' : ''}</span>,
  ];
  if ((isCurrentWeek || isNextWeek) && week.total_unassigned > 0) {
    summaryParts.push(<span key="d2" style={{ color: '#C5C0B8' }}> · </span>);
    summaryParts.push(<span key="ua" style={{ color: '#E24B4A' }}>{week.total_unassigned} unassigned</span>);
  }

  const WEEK_OPTIONS = [
    { id: 'last',    label: 'Last Week' },
    { id: 'current', label: 'Current Week' },
    { id: 'next',    label: 'Next Week' },
  ];

  const bookedLabel = isLastWeek ? 'actual' : isCurrentWeek ? 'booked' : 'projected';

  return (
    <>
      <style>{`@keyframes wf-pulse{0%,100%{opacity:1}50%{opacity:.45}}`}</style>
      <div style={{ background: '#FFFFFF', border: '0.5px solid #E5E2DC', borderRadius: 12, padding: '24px' }}>

        {/* Header: label+date left / dropdown right */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <p style={{ fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#4A4845', margin: '0 0 2px', fontFamily: FF }}>Revenue Forecast</p>
            <p style={{ fontSize: 11, color: '#6B6860', margin: 0, fontFamily: FF }}>{week.date_range}</p>
          </div>
          <select
            value={selectedWeekId}
            onChange={e => setSelectedWeekId(e.target.value)}
            style={{
              fontSize: 12, fontWeight: 500, color: '#1A1917', background: '#F7F6F3',
              border: '0.5px solid #E5E2DC', borderRadius: 6, padding: '4px 8px',
              cursor: 'pointer', fontFamily: FF, outline: 'none',
            }}
          >
            {WEEK_OPTIONS.map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Booked total line */}
        <div style={{ borderBottom: '0.5px solid #F0EEE9', paddingBottom: 10, marginBottom: 12 }}>
          <p style={{ fontSize: 16, fontWeight: 500, color: '#1A1917', margin: 0, fontFamily: FF }}>
            {fmtWF(week.total_revenue)} {bookedLabel} · {week.total_jobs} jobs
            {(isCurrentWeek || isNextWeek) && week.total_unassigned > 0 && (
              <span style={{ color: '#E24B4A' }}> · {week.total_unassigned} unassigned</span>
            )}
          </p>
        </div>

        {/* 7-column day grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 10 }}>
          {week.days.map(day => {
            const s = dayStyle(day, week.daily_avg);
            const isToday = day.date === todayStr;
            const cellBorder = isToday ? '1.5px solid var(--brand)' : (s.border ?? '0.5px solid transparent');
            const cellRadius = isToday ? 8 : 6;
            const dateParts = day.date.split('-');
            const displayDate = `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(dateParts[1])-1]} ${parseInt(dateParts[2])}`;
            return (
              <div key={day.date} style={{ background: s.bg, border: cellBorder, borderRadius: cellRadius, padding: '12px 10px', minHeight: 100 }}>
                <p style={{ fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#4A4845', margin: '0 0 2px', fontFamily: FF }}>{day.day_name}</p>
                <p style={{ fontSize: 12, color: '#6B6860', margin: '0 0 8px', fontFamily: FF }}>{displayDate}</p>
                {day.is_weekend ? (
                  <>
                    <p style={{ fontSize: 16, fontWeight: 500, color: '#6B6860', margin: '0 0 2px', fontFamily: FF }}>—</p>
                    <p style={{ fontSize: 12, color: '#9E9B94', margin: 0, fontFamily: FF }}>Closed</p>
                  </>
                ) : (
                  <>
                    <p style={{ fontSize: 16, fontWeight: 500, color: s.revColor, margin: '0 0 2px', fontFamily: FF }}>{fmtWF(day.revenue)}</p>
                    <p style={{ fontSize: 12, color: s.jobColor, margin: 0, fontFamily: FF }}>{day.job_count} jobs</p>
                  </>
                )}
                <div style={{ height: 4, borderRadius: 2, background: s.bar, marginTop: 10 }} />
              </div>
            );
          })}
        </div>

        {/* Summary note */}
        <div style={{ borderTop: '0.5px solid #F0EEE9', paddingTop: 10, marginTop: 10 }}>
          <p style={{ fontSize: 11, color: '#6B6860', margin: 0, fontFamily: FF }}>{summaryNote}</p>
        </div>

        {/* Legend */}
        <div style={{ borderTop: '0.5px solid #F0EEE9', paddingTop: 10, marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          {[
            { label: 'Above avg', bg: '#639922', border: undefined },
            { label: 'Below avg', bg: '#EF9F27', border: undefined },
            { label: 'Low',       bg: '#E24B4A', border: undefined },
            { label: 'Closed',    bg: '#E5E2DC', border: undefined },
            { label: 'Projected', bg: '#F7F6F3', border: '1px dashed #C5C0B8' },
            { label: 'Today',     bg: 'transparent', border: '1.5px solid var(--brand)' },
          ].map(sw => (
            <div key={sw.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: sw.bg, border: sw.border, display: 'inline-block', flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: '#6B6860', fontFamily: FF }}>{sw.label}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Period selector + the money row it scopes ────────────────────────────────
// [dashboard-period 2026-07-22] Before this, every number on the page carried a
// different implicit window (today / this week / last 30 days / MTD / 12mo) and
// none of them could be changed. One selector now owns the page: the money row
// and the growth row both read the window it resolves, and each card states its
// own window in words so the label can never drift from the SQL.

type Period = 'today' | 'week' | 'month';

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week',  label: 'This week' },
  { key: 'month', label: 'This month' },
];

function PeriodSelector({ value, onChange, dark }: { value: Period; onChange: (p: Period) => void; dark?: boolean }) {
  return (
    <div style={{
      display: 'inline-flex', padding: 2, gap: 2,
      // `dark` means "sitting on the mint hero", not "dark mode" (Qleno has
      // none). The active tab is solid Night with white type — the same pairing
      // the delta pill uses, so the two accents on the band match.
      background: dark ? 'rgba(10,14,26,0.16)' : 'var(--bg-base)',
      border: `1px solid ${dark ? 'rgba(10,14,26,0.24)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-control)',
    }}>
      {PERIODS.map(p => {
        const on = p.key === value;
        return (
          <button key={p.key} onClick={() => onChange(p.key)}
            style={{
              padding: '6px 14px', border: 'none', cursor: 'pointer', fontFamily: FF,
              fontSize: 12, fontWeight: 600,
              borderRadius: 6,
              background: on ? (dark ? 'var(--night)' : 'var(--bg-card)') : 'transparent',
              color: on ? (dark ? '#FFFFFF' : 'var(--ink)') : (dark ? 'rgba(255,255,255,0.88)' : 'var(--ink-muted)'),
              boxShadow: on && !dark ? 'inset 0 0 0 1px var(--border)' : 'none',
            }}>
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

type Summary = {
  period: Period; label: string;
  window: { from: string; to: string };
  revenue_booked: { value: number; prev: number; delta_pct: number | null; jobs: number };
  collected: { value: number; prev: number; delta_pct: number | null; company_wide: boolean };
  // Always the last completed Sun–Sat week — Phes pays in arrears, so the
  // in-flight week's commission isn't owed yet and its ratio means nothing.
  payroll: { cost: number; revenue: number; pct_of_revenue: number | null; window: { from: string; to: string }; label: string };
};

// [dashboard-window-range 2026-07-22] "THIS WEEK" doesn't say which week. Every
// label that names a window now shows the dates the SQL actually used, straight
// off summary.window — so the words and the number can't drift apart.
// Dates arrive as YYYY-MM-DD; they're parsed as parts, never `new Date(str)`,
// which would read them as UTC midnight and render the previous day in Central.
function fmtRange(from: string, to: string) {
  const parse = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const a = parse(from), b = parse(to);
  const mon = (d: Date) => d.toLocaleDateString('en-US', { month: 'short' });
  if (from === to) return `${mon(a)} ${a.getDate()}`;
  if (a.getMonth() === b.getMonth()) return `${mon(a)} ${a.getDate()}–${b.getDate()}`;
  return `${mon(a)} ${a.getDate()} – ${mon(b)} ${b.getDate()}`;
}

// [period-jolt 2026-07-23] These hooks used to blank their data on every period
// change. That made each card collapse to a short "Loading…" body and then
// spring back once the fetch landed — the page visibly jumped twice on every
// Today/Week/Month tap. They now HOLD the previous window's values until the new
// ones arrive, so the swap is a single in-place update at a stable height. The
// values are briefly one window stale, but the label, the range and the numbers
// all come from the same payload, so the card is never internally inconsistent —
// it just shows the old window for a beat instead of showing nothing.
function useSummary(period: Period, branchId: number | 'all') {
  const [data, setData] = useState<Summary | null>(null);
  useEffect(() => {
    let alive = true;
    const b = branchId !== 'all' ? `&branch_id=${branchId}` : '';
    fetchJsonWithRetry(`/api/dashboard/summary?period=${period}${b}`)
      .then(j => { if (alive && j) setData(j); });
    return () => { alive = false; };
  }, [period, branchId]);
  return data;
}

// Lead analytics for exactly the window the selector resolved. The cohort is
// leads CREATED in the window (Sal's call): "of the 17 Google Local leads that
// came in this week, 53% booked" — so close rate and source rows describe the
// same set of leads, not a mix of intake and conversion dates.
function useLeadReport(win: { from: string; to: string } | null) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    if (!win) return;
    let alive = true;
    fetchJsonWithRetry(`/api/lead-analytics/report?period=custom&from=${win.from}&to=${win.to}`)
      .then(j => { if (alive && j) setData(j); });
    return () => { alive = false; };
  }, [win?.from, win?.to]);
  return data;
}

// [referral-window 2026-07-23] "How they heard about us" gets its OWN trailing
// 90-day window instead of following the period selector.
//
// On a Today view the selector window is a single day, and a single day almost
// always has zero new leads — so the card sat on "No leads in this window"
// permanently and read as broken. Referral source is a slow marketing signal,
// not a daily operational one: nobody makes a decision off "who heard about us
// on Tuesday". Ninety days is enough sample for the mix to mean something.
// The card states its own window in the subhead so it can't be misread as
// belonging to the period above it.
const REFERRAL_WINDOW_DAYS = 90;
function useReferralReport(win: { from: string; to: string } | null) {
  const [data, setData] = useState<any>(null);
  const to = win?.to ?? null;
  useEffect(() => {
    if (!to) return;
    let alive = true;
    // Parse as local Y/M/D — `new Date('2026-07-23')` is UTC midnight and would
    // slide the window a day west of Central.
    const [y, m, d] = to.split('-').map(Number);
    const start = new Date(y, m - 1, d);
    start.setDate(start.getDate() - (REFERRAL_WINDOW_DAYS - 1));
    const p = (n: number) => String(n).padStart(2, '0');
    const from = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`;
    fetchJsonWithRetry(`/api/lead-analytics/report?period=custom&from=${from}&to=${to}`)
      .then(j => { if (alive && j) setData(j); });
    return () => { alive = false; };
  }, [to]);
  return data;
}

// ── Live weather ─────────────────────────────────────────────────────────────
// [dashboard-weather 2026-07-22] Operations input, not decoration: snow and
// heavy rain move drive time, stretch arrival windows and drive same-day
// cancellations. Scoped to the active branch — Oak Lawn and Schaumburg get
// genuinely different weather.
function useWeather(branchId: number | 'all') {
  const [wx, setWx] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    const b = branchId !== 'all' ? `?branch_id=${branchId}` : '';
    fetchJsonWithRetry(`/api/dashboard/weather${b}`).then(j => { if (alive && j) setWx(j); });
    return () => { alive = false; };
  }, [branchId]);
  return wx;
}

// Minimal line-art glyphs — no emoji (brand rule), no icon dependency.
function WeatherGlyph({ code, size = 26 }: { code: number; size?: number }) {
  const s = { width: size, height: size, stroke: 'currentColor', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const sun = <><circle cx="12" cy="12" r="4.2" />{[0, 45, 90, 135, 180, 225, 270, 315].map(a => {
    const r = (a * Math.PI) / 180;
    return <line key={a} x1={12 + Math.cos(r) * 6.6} y1={12 + Math.sin(r) * 6.6} x2={12 + Math.cos(r) * 8.6} y2={12 + Math.sin(r) * 8.6} />;
  })}</>;
  const cloud = <path d="M7 18h10a3.6 3.6 0 0 0 .3-7.2A5.4 5.4 0 0 0 6.8 11 3.5 3.5 0 0 0 7 18Z" />;
  let art: React.ReactNode = sun;
  if (code === 1 || code === 2) art = <><g opacity={0.85}>{sun}</g>{cloud}</>;
  else if (code === 3 || code === 45 || code === 48) art = cloud;
  else if (code >= 51 && code <= 67) art = <>{cloud}<line x1="9" y1="20" x2="8.4" y2="22" /><line x1="12.5" y1="20" x2="11.9" y2="22" /><line x1="16" y1="20" x2="15.4" y2="22" /></>;
  else if (code >= 71 && code <= 77) art = <>{cloud}<line x1="9" y1="21" x2="9" y2="21.1" /><line x1="12.5" y1="21.6" x2="12.5" y2="21.7" /><line x1="16" y1="21" x2="16" y2="21.1" /></>;
  else if (code >= 80 && code <= 86) art = <>{cloud}<line x1="9.5" y1="19.6" x2="8.4" y2="22.4" /><line x1="14.5" y1="19.6" x2="13.4" y2="22.4" /></>;
  else if (code >= 95) art = <>{cloud}<path d="M13 19.4 10.6 22.4h2.6L11.6 25" /></>;
  return <svg viewBox="0 0 24 24" style={s} aria-hidden>{art}</svg>;
}

// ── Hero band ────────────────────────────────────────────────────────────────
// [dashboard-hero 2026-07-22] The page was all white cards on beige and read as
// a generic admin template — no tenant colour anywhere above the fold. The
// headline number now sits in the tenant's own brand, graded into Qleno Night,
// which is where the app's palette actually lives. Everything in here is
// derived from var(--brand), so a tenant with a different brand_color gets a
// coherent band rather than a blue one.
function HeroBand({ greeting, todayDate, summary, period, setPeriod, weather }: {
  greeting: string; todayDate: string;
  summary: Summary | null; period: Period; setPeriod: (p: Period) => void; weather: any;
}) {
  const delta = summary?.revenue_booked.delta_pct ?? null;
  const prevLabel = period === 'today' ? 'yesterday' : period === 'week' ? 'last week' : 'last month';
  return (
    <div style={{
      borderRadius: 'var(--radius-card)',
      // [hero-mint 2026-07-23] Mint IS the field, at Sal's call — it's the
      // primary brand color and the hero is where the brand should land.
      // SOLID #00C9A0, no gradient, no variant — Sal's explicit call. Do NOT
      // reintroduce a ramp. White type on it is ~2.1:1, so every label on this
      // band is weight 600 at 11px+ to hold its edges. The accent ON this band
      // is Qleno Night — see the delta pill and the selector.
      background: 'var(--brand)',
      color: '#FFFFFF', padding: '22px 26px',
      display: 'flex', alignItems: 'stretch', justifyContent: 'space-between', gap: 28, flexWrap: 'wrap',
    }}>
      {/* left — who / when / where */}
      <div style={{ minWidth: 200 }}>
        {/* [branch-dedupe 2026-07-22] No branch pill here. The header's branch
            dropdown is the one place branch is named AND switchable; repeating
            it beside the greeting read as "Oak Lawn Oak Lawn". The weather line
            below still names the city because that's the forecast's location,
            not the branch selector. */}
        <p style={{ fontSize: 20, fontWeight: 600, margin: 0, fontFamily: FF, color: '#FFFFFF' }}>{greeting}</p>
        <p style={{ fontSize: 12, margin: '6px 0 0', fontFamily: FF, color: 'rgba(255,255,255,0.85)' }}>{todayDate}</p>

        {weather?.available && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
            <span style={{ color: '#FFFFFF', display: 'flex' }}><WeatherGlyph code={weather.code} /></span>
            {/* Current temp + condition only. Precip %, then the H/L · wind ·
                city line, were both cut at Sal's call — numbers nobody acts on.
                The rough-day pill below is the part that changes a decision. */}
            <p style={{ fontSize: 14, fontWeight: 600, margin: 0, fontFamily: FF, color: '#FFFFFF' }}>
              {weather.temp}° · {weather.condition}
            </p>
          </div>
        )}
        {/* Weather earns its space by saying what it means for the day. */}
        {weather?.available && weather.rough && (
          <p style={{ fontSize: 11, fontWeight: 600, margin: '8px 0 0', padding: '3px 8px', display: 'inline-block', borderRadius: 999, background: 'rgba(10,14,26,0.22)', color: '#FFFFFF', fontFamily: FF }}>
            Expect longer drive times and same-day cancellations
          </p>
        )}
      </div>

      {/* centre — the headline number for the selected window */}
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 220 }}>
        {/* [dashboard-booked 2026-07-22] This said "Revenue booked", which was
            wrong: the SQL behind it filters on jobs.scheduled_date, so it's the
            value of the work ON THE CALENDAR in this window — not what got sold
            in it. Sal caught it ("that's just today's job revenue"). What was
            actually booked now has its own card under Leads closed, fed by
            jobs.created_at. Two different questions, two different numbers,
            two different labels. */}
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.85)', fontFamily: FF }}>
          Job revenue · {summary?.label ?? PERIODS.find(p => p.key === period)!.label}
        </span>
        {summary && (
          <span style={{ fontSize: 11, fontWeight: 500, marginTop: 3, color: 'rgba(255,255,255,0.78)', fontFamily: FF }}>
            {fmtRange(summary.window.from, summary.window.to)}
          </span>
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 40, fontWeight: 600, lineHeight: 1, fontFamily: FF, color: '#FFFFFF' }}>
            {summary ? fmtWF(summary.revenue_booked.value) : '—'}
          </span>
          {delta !== null && (
            <span style={{
              fontSize: 12, fontWeight: 600, fontFamily: FF, padding: '2px 8px', borderRadius: 999,
              // Night is the accent ON mint — the one dark note that carries
              // enough contrast for white type. Up weeks get the solid pill;
              // down weeks drop to a wash rather than turning red, because the
              // hero orients, it doesn't alarm. Alarms live in Needs attention.
              background: delta >= 0 ? 'var(--night)' : 'rgba(10,14,26,0.22)',
              color: '#FFFFFF',
            }}>
              {delta >= 0 ? '+' : ''}{delta}% vs {prevLabel}
            </span>
          )}
        </div>
        <span style={{ fontSize: 12, marginTop: 8, color: 'rgba(255,255,255,0.85)', fontFamily: FF }}>
          {summary ? `${summary.revenue_booked.jobs} jobs on the schedule` : 'Loading…'}
        </span>
      </div>

      {/* right — the one control that scopes the page */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.85)', fontFamily: FF }}>Showing</span>
        <PeriodSelector value={period} onChange={setPeriod} dark />
      </div>
    </div>
  );
}

function MoneyCard({ label, value, sub, delta, deltaSuffix, href, navigate }: {
  label: string; value: string; sub: string;
  delta?: number | null; deltaSuffix?: string;
  href?: string; navigate?: (p: string) => void;
}) {
  const clickable = Boolean(href && navigate);
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={() => href && navigate && navigate(href)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...CARD, padding: '18px 20px', minHeight: 108,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        cursor: clickable ? 'pointer' : 'default',
        borderColor: hover && clickable ? 'var(--brand)' : 'var(--border)',
        background: hover && clickable ? 'var(--brand-soft)' : 'var(--bg-card)',
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      {/* The brand tick is what ties a white card back to the tenant's palette
          without tinting the number, which has to stay --ink. */}
      <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0, fontFamily: FF, display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 3, height: 12, borderRadius: 2, background: 'var(--brand)', display: 'inline-block', flexShrink: 0 }} />
        {label}
      </p>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '10px 0 6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 30, fontWeight: 600, color: 'var(--ink)', lineHeight: 1, fontFamily: FF }}>{value}</span>
        <DeltaBadge delta={delta ?? null} suffix={deltaSuffix} />
      </div>
      <p style={{ fontSize: 12, color: 'var(--ink-faint)', margin: 0, fontFamily: FF }}>{sub}</p>
    </div>
  );
}

// Ring + funnel: what share of the leads that came in this window have booked.
function ConversionCard({ report, periodLabel, navigate }: { report: any; periodLabel: string; navigate: (p: string) => void }) {
  const totals = report?.totals || {};
  const rates = report?.rates || {};
  const funnel = report?.funnel || {};
  const leads = totals.leads ?? 0;
  const booked = totals.booked ?? 0;
  const rate = rates.lead_to_book ?? 0;
  const R = 34, C = 2 * Math.PI * R;
  const steps = [
    { k: 'New',     v: leads },
    { k: 'Quoted',  v: (funnel.quoted || 0) + (funnel.follow_up || 0) + booked },
    { k: 'Booked',  v: booked },
  ];
  const max = Math.max(1, ...steps.map(s => s.v));
  return (
    <div style={{ ...CARD, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0, fontFamily: FF }}>Leads closed</p>
        <button onClick={() => navigate('/leads')} style={{ fontSize: 11, fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF }}>Open pipeline →</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div style={{ position: 'relative', width: 84, height: 84, flexShrink: 0 }}>
          <svg width={84} height={84} viewBox="0 0 84 84">
            <circle cx={42} cy={42} r={R} fill="none" stroke="var(--border)" strokeWidth={8} />
            <circle cx={42} cy={42} r={R} fill="none" stroke="var(--brand)" strokeWidth={8}
              strokeLinecap="round" strokeDasharray={`${(rate / 100) * C} ${C}`}
              transform="rotate(-90 42 42)" />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--ink)', fontFamily: FF, lineHeight: 1 }}>{report ? `${Math.round(rate)}%` : '—'}</span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {steps.map((s, i) => (
            <div key={s.k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: i ? 8 : 0 }}>
              <span style={{ fontSize: 12, color: 'var(--ink-muted)', fontFamily: FF, width: 52, flexShrink: 0 }}>{s.k}</span>
              <div style={{ flex: 1, height: 6, background: 'var(--bg-base)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${(s.v / max) * 100}%`, height: '100%', background: 'var(--brand)', opacity: 1 - i * 0.25, borderRadius: 3 }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', fontFamily: FF, width: 30, textAlign: 'right' }}>{report ? s.v : '—'}</span>
            </div>
          ))}
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--ink-faint)', margin: '14px 0 0', fontFamily: FF }}>
        {report ? `${booked} of ${leads} leads created ${periodLabel.toLowerCase()} have booked` : 'Loading…'}
      </p>
    </div>
  );
}

// ── What actually got booked ─────────────────────────────────────────────────
// [dashboard-booked 2026-07-22] The hero answers "what's on the calendar".
// This answers "what did we sell" — jobs whose booking was CREATED in the
// window (jobs.created_at), the money the funnel above it produced. It sits
// directly under Leads closed on purpose: that card ends on "N booked", and
// this is what those bookings were worth, what kind of work they were, and
// which channel they came from.
//
// "Sold" deliberately EXCLUDES occurrences the recurring engine generated —
// those carry a created_at too, and this week that was 289 of the 309 jobs
// created. Counting them would report $65.8k of new business on $7.3k of
// actual sales. They get their own quiet line instead.
type Booked = {
  label: string;
  window: { from: string; to: string };
  total: { revenue: number; jobs: number };
  recurring: { revenue: number; jobs: number };
  by_service: { key: string; jobs: number; revenue: number }[];
  by_source: { key: string; jobs: number; revenue: number }[];
};

function useBooked(period: Period, branchId: number | 'all') {
  const [data, setData] = useState<Booked | null>(null);
  useEffect(() => {
    let alive = true;
    const b = branchId !== 'all' ? `&branch_id=${branchId}` : '';
    fetchJsonWithRetry(`/api/dashboard/booked?period=${period}${b}`)
      .then(j => { if (alive && j) setData(j); });
    return () => { alive = false; };
  }, [period, branchId]);
  return data;
}

const SERVICE_LABEL: Record<string, string> = {
  standard: 'Standard clean', deep_clean: 'Deep clean', move_in: 'Move in',
  move_out: 'Move out', move_in_out: 'Move in/out', post_construction: 'Post-construction',
  recurring: 'Recurring', one_time: 'One time', commercial: 'Commercial',
};
const prettyService = (s: string | null) =>
  !s ? 'Unspecified' : (SERVICE_LABEL[s] || s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));

const SOURCE_LABEL: Record<string, string> = {
  website: 'Website', quote: 'Office quote', phone: 'Phone', referral: 'Referral',
  google: 'Google', google_local: 'Google Local', facebook: 'Facebook',
  instagram: 'Instagram', yelp: 'Yelp', repeat: 'Repeat client', other: 'Other',
};
const prettySource = (s: string | null) =>
  !s ? 'Unknown' : (SOURCE_LABEL[s] || s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));

// [lead-source-palette 2026-07-22] A single mint→night ramp, so the card reads
// as one family instead of a pie-chart rainbow. The steps are ordered by how
// much the channel costs us: Referral gets Qleno Night — the darkest, most
// distinguished step — because it's the free channel Sal wants to see first,
// and it can never be confused with a paid source. Everything else steps down
// in mint toward the neutral for the long tail.
//
// This map encodes DATA (which channel a color means), so it is deliberately
// literal and exempt from the var(--brand) sweep — a tenant's brand_color must
// not repaint "Referral".
//
// The KEYS here must be the raw `source` values /lead-analytics/report returns
// — for Phes today that's quote / web_quote / very_dirty / widget /
// booking_widget, not the tidy names. Keying on a guess is why every row first
// rendered the gray fallback. Same precedence rule as the leads board
// (`leadSourceTag`): explicit key first, then a web-ish regex, then neutral.
const SOURCE_COLOR: Record<string, string> = {
  // Free channels — Qleno Night, the darkest and most distinguished step.
  referral:              '#0A0E1A',
  repeat:                '#0A0E1A',
  realtor:               '#0A0E1A',
  // Paid search — Electric Mint.
  google_local_services: '#00C9A0',
  google_search:         '#00C9A0',
  google:                '#00C9A0',
  // Paid social.
  facebook:              '#4C8C7B',
  instagram:             '#4C8C7B',
  // Office-built work: a quote your team keyed in, or an inbound call.
  quote:                 '#5E7A72',
  manual:                '#5E7A72',
  phone_in:              '#5E7A72',
  // Inbound from the site.
  web_quote:             '#8FB8AC',
  contact_form:          '#8FB8AC',
  quote_request:         '#8FB8AC',
  online_booking:        '#8FB8AC',
  booking_widget:        '#A9CCC2',
  widget:                '#A9CCC2',
  very_dirty:            '#A9CCC2',
  very_dirty_callback:   '#A9CCC2',
};
const SOURCE_FALLBACK = '#C8C4BC';
const sourceColor = (s: string | null) => {
  if (!s) return SOURCE_FALLBACK;
  if (SOURCE_COLOR[s]) return SOURCE_COLOR[s];
  return /web|widget|online|form|very_dirty/.test(s.toLowerCase())
    ? SOURCE_COLOR.web_quote
    : SOURCE_FALLBACK;
};

// Sits directly under ConversionCard: the funnel ends on "Booked N", this says
// what those N were worth, what kind of work they were and where they came from.
function BookedCard({ booked, navigate }: { booked: Booked | null; navigate: (p: string) => void }) {
  const svc = (booked?.by_service || []).slice(0, 4);
  const src = (booked?.by_source || []).slice(0, 4);
  const maxSvc = Math.max(1, ...svc.map(r => r.revenue));
  const maxSrc = Math.max(1, ...src.map(r => r.revenue));

  const Column = ({ title, rows, max, color }: {
    title: string; rows: { key: string; jobs: number; revenue: number }[];
    max: number; color: (k: string) => string;
  }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <p style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px', fontFamily: FF }}>{title}</p>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--ink-faint)', margin: 0, fontFamily: FF }}>—</p>
      ) : rows.map((r, i) => (
        <div key={r.key} style={{ marginTop: i ? 9 : 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--ink)', fontFamily: FF, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title === 'Kind of work' ? prettyService(r.key === 'unknown' ? null : r.key) : prettySource(r.key === 'unknown' ? null : r.key)}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', fontFamily: FF, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {fmtWF(r.revenue)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <div style={{ flex: 1, height: 5, background: 'var(--bg-base)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${(r.revenue / max) * 100}%`, height: '100%', background: color(r.key), borderRadius: 3 }} />
            </div>
            <span style={{ fontSize: 11, color: 'var(--ink-faint)', fontFamily: FF, flexShrink: 0, width: 46, textAlign: 'right' }}>
              {r.jobs} job{r.jobs === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ ...CARD, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0, fontFamily: FF }}>
          Revenue booked{booked ? ` · ${fmtRange(booked.window.from, booked.window.to)}` : ''}
        </p>
        <button onClick={() => navigate('/leads/reports')} style={{ fontSize: 11, fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF }}>Full report →</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 26, fontWeight: 600, color: 'var(--ink)', lineHeight: 1, fontFamily: FF }}>
          {booked ? fmtWF(booked.total.revenue) : '—'}
        </span>
        <span style={{ fontSize: 12, color: 'var(--ink-faint)', fontFamily: FF }}>
          {booked ? `${booked.total.jobs} job${booked.total.jobs === 1 ? '' : 's'} sold` : 'Loading…'}
        </span>
      </div>
      <p style={{ fontSize: 11, color: 'var(--ink-faint)', margin: '0 0 14px', fontFamily: FF }}>
        work sold in this window, whenever it's scheduled
        {booked && booked.recurring.jobs > 0
          ? ` · plus ${booked.recurring.jobs} recurring occurrence${booked.recurring.jobs === 1 ? '' : 's'} (${fmtWF(booked.recurring.revenue)}) the schedule generated`
          : ''}
      </p>

      <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start' }}>
        <Column title="Kind of work" rows={svc} max={maxSvc} color={() => 'var(--brand)'} />
        <Column title="Where it came from" rows={src} max={maxSrc} color={k => sourceColor(k === 'unknown' ? null : k)} />
      </div>
    </div>
  );
}

// [referral-card 2026-07-23] "How did you hear about us?" — the ANSWER, not the
// entry channel.
//
// This card used to show `by_source` (Office quote / Web Quote / Very Dirty),
// which is exactly what the "Where it came from" column inside Revenue booked
// already shows. Two cards, one fact, and neither of them the one Sal actually
// needs: which marketing is producing customers. Now it groups on
// `leads.referral_source` — Google, Yelp, a friend — and the entry-channel
// reading lives in Revenue booked alone.
//
// `unasked` is rendered, deliberately, and always sorts last. Most office-keyed
// quotes never filled this in, so hiding the gap would make a 6-answer sample
// look like the whole picture. Seeing "31 not asked" is the nudge to ask.
const REFERRAL_LABEL: Record<string, string> = {
  google: 'Google', facebook: 'Facebook', instagram: 'Instagram', nextdoor: 'Nextdoor',
  yelp: 'Yelp', client_referral: 'Friend or family', door_hanger: 'Door hanger',
  yard_sign: 'Yard sign', website: 'Our website', other: 'Other',
  unasked: 'Not asked',
};
const prettyReferral = (s: string | null) =>
  !s ? 'Not asked' : (REFERRAL_LABEL[s] || s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));

// [referral-colors 2026-07-23] These follow the CHANNELS' OWN brand marks, not
// the Qleno ramp — Sal's call: "Google should be Yellow, Yelp Red, FB Blue,
// Referral Green".
//
// This is the one deliberate exception to the one-palette rule, and it earns it:
// nobody has to learn a legend when Google is Google-yellow and Yelp is
// Yelp-red. The mint ramp that used to be here made every channel a shade of
// the same green, which is exactly what made the card unreadable at a glance.
// Each hex is the real mark desaturated a step so it sits on the warm #F7F6F3
// page instead of glowing off it.
//
// Channels that are OURS (our website, door hangers, yard signs) stay in the
// Qleno palette — they have no outside brand to borrow. "Not asked" keeps the
// border tone so a wall of unanswered reads as absence, not as a channel.
//
// Encodes DATA, so it stays literal and is exempt from the var(--brand) sweep —
// a tenant's brand_color must not repaint "Friend or family".
const REFERRAL_COLOR: Record<string, string> = {
  google:          '#E0A233', // Google yellow
  yelp:            '#C4362E', // Yelp red
  facebook:        '#3B5C9F', // Facebook blue
  client_referral: '#0F7A63', // word of mouth — the free channel, our green
  instagram:       '#B84A8A', // Instagram magenta
  nextdoor:        '#6E9440', // Nextdoor green, olive-shifted off the referral green
  website:         '#2F3646', // ours
  door_hanger:     '#C2673F', // ours
  yard_sign:       '#D9A88A', // ours
  other:           '#C8C4BC',
  unasked:         '#E5E2DC',
};
const referralColor = (s: string | null) => REFERRAL_COLOR[s ?? 'unasked'] ?? '#C8C4BC';

function LeadSourcesCard({ report, navigate }: { report: any; navigate: (p: string) => void }) {
  const all: any[] = report?.by_referral || [];
  // Answered channels first by volume; "Not asked" is pinned last no matter how
  // large it gets, so it reads as the footnote it is rather than the headline.
  const rows = [
    ...all.filter(r => r.referral !== 'unasked').sort((a, b) => b.leads - a.leads),
    ...all.filter(r => r.referral === 'unasked'),
  ].slice(0, 6);
  const maxLeads = Math.max(1, ...rows.map(r => r.leads || 0));
  const answered = all.filter(r => r.referral !== 'unasked').reduce((n, r) => n + r.leads, 0);
  const total = all.reduce((n, r) => n + r.leads, 0);

  return (
    <div style={{ ...CARD, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0, fontFamily: FF }}>How they heard about us</p>
        <button onClick={() => navigate('/leads/reports')} style={{ fontSize: 11, fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF }}>Full report →</button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--ink-faint)', margin: '0 0 12px', fontFamily: FF }}>
        {/* [referral-window 2026-07-23] Always name the 90 days. This card is
            the one thing on the page that does NOT follow the period selector,
            so leaving the window implicit would let a Today view be read as
            "nobody heard about us today". */}
        {total > 0
          ? `last 90 days · ${answered} of ${total} lead${total === 1 ? '' : 's'} told us`
          : 'last 90 days · referral source, not entry channel'}
      </p>
      {report == null ? (
        <p style={{ fontSize: 12, color: 'var(--ink-faint)', margin: 0, fontFamily: FF }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--ink-faint)', margin: 0, fontFamily: FF }}>No leads in the last 90 days.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FF }}>
          <thead>
            <tr>
              {['Heard about us', 'Leads', 'Close rate', 'Booked value'].map((h, i) => (
                <th key={h} style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: i ? 'right' : 'left', padding: '0 0 6px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.referral ?? `s${i}`} style={{ borderTop: '1px solid var(--border-sub)' }}>
                {/* Share bar carries the channel's own color, so the same
                    channel is the same swatch here and in the full report.
                    Numbers stay --ink — color is never the value. "Not asked"
                    also drops its type to --ink-faint: it's a gap in the data,
                    not a marketing channel competing with the real ones. */}
                <td style={{ fontSize: 13, color: r.referral === 'unasked' ? 'var(--ink-faint)' : 'var(--ink)', padding: '9px 12px 9px 0', minWidth: 120 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: referralColor(r.referral), flexShrink: 0 }} />
                    {prettyReferral(r.referral)}
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-base)', marginTop: 5, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.round((r.leads / maxLeads) * 100)}%`, height: '100%', background: referralColor(r.referral), borderRadius: 2 }} />
                  </div>
                </td>
                <td style={{ fontSize: 13, color: r.referral === 'unasked' ? 'var(--ink-faint)' : 'var(--ink)', textAlign: 'right' }}>{r.leads}</td>
                <td style={{ fontSize: 13, color: r.referral === 'unasked' ? 'var(--ink-faint)' : 'var(--ink)', textAlign: 'right' }}>{Math.round(r.rate)}%</td>
                <td style={{ fontSize: 13, color: r.referral === 'unasked' ? 'var(--ink-faint)' : 'var(--ink)', textAlign: 'right' }}>{fmtWF(r.booked_value || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// [notifications 2026-07-22] Two feeds, one section, side by side.
//
//   Office    — money and account exceptions the office has to clear
//               (commercial alerts, pending mileage approvals)
//   Employees — people exceptions from HR attendance (NCNS, absences)
//
// These three banners already existed; they were stacked at the very bottom of
// the page under the charts, which is why a "Charge failed" alert could sit
// unread all day. Nothing about their data or their actions changed — they were
// moved up and given a shared heading so the two audiences read separately.
// A column with nothing in it says so rather than collapsing, so "quiet" and
// "broken" don't look the same; the whole section hides only when both are dry.
// The `techs` slot is the "who is working today" column — it rides in the same
// band so the operator reads people and exceptions in one pass instead of
// scrolling past four charts to find them.
function NotificationsSection({ techs }: { techs?: React.ReactNode }) {
  const [commercial, setCommercial] = useState<number | null>(null);
  const [mileage, setMileage] = useState<number | null>(null);
  const [hr, setHr] = useState<number | null>(null);

  const officeCount = (commercial ?? 0) + (mileage ?? 0);
  const loaded = commercial !== null && mileage !== null && hr !== null;

  const empty = (text: string) => (
    <div style={{ ...CARD, padding: '16px 18px' }}>
      <p style={{ fontSize: 12, color: 'var(--ink-faint)', margin: 0, fontFamily: FF }}>{text}</p>
    </div>
  );
  const colLabel: React.CSSProperties = { ...SECTION_LABEL, margin: '0 0 2px', color: 'var(--ink-faint)' };

  return (
    <div>
      <p style={SECTION_LABEL}>Right now</p>
      <div style={{ display: 'grid', gridTemplateColumns: techs ? '1.1fr 1fr 1fr' : '1fr 1fr', gap: GAP, alignItems: 'start' }}>
        {techs && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
            <p style={colLabel}>Working today</p>
            {techs}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          <p style={colLabel}>Office</p>
          <CommercialAlertsBanner onCount={setCommercial} />
          <MileagePendingBanner onCount={setMileage} />
          {loaded && officeCount === 0 && empty('Nothing to clear.')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          <p style={colLabel}>Employees</p>
          <HRAlertsBanner onCount={setHr} />
          {loaded && hr === 0 && empty('Everyone accounted for today.')}
        </div>
      </div>
    </div>
  );
}

// Risk first. Renders only when something actually needs a human — an empty
// strip is worse than no strip (it trains the operator to skip the top of the
// page). Alerts come from /today; unassigned is the day's own count.
function NeedsAttentionStrip({ alerts, unassigned, flagged, navigate }: {
  alerts: any[]; unassigned: number; flagged: number; navigate: (p: string) => void;
}) {
  const items: { text: string; to: string }[] = [];
  if (unassigned > 0) items.push({ text: `${unassigned} unassigned today`, to: '/dispatch?status=unassigned' });
  if (flagged > 0) items.push({ text: `${flagged} flagged clock-in${flagged > 1 ? 's' : ''}`, to: '/employees/clocks' });
  for (const a of alerts.slice(0, 3)) items.push({ text: a.message, to: a.action === 'send_invoice' ? '/invoices' : '/dispatch' });
  if (items.length === 0) return null;
  return (
    <div style={{
      background: 'var(--warn-bg)', border: '1px solid var(--warn)',
      borderRadius: 'var(--radius-card)', padding: '12px 16px',
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--warn)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: FF }}>Needs attention</span>
      {items.map((it, i) => (
        <button key={i} onClick={() => navigate(it.to)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 999, padding: '4px 10px', cursor: 'pointer',
            fontSize: 12, color: 'var(--ink)', fontFamily: FF,
          }}>
          {it.text} <ChevronRight size={12} />
        </button>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const isMobile = useIsMobile();
  const [, navigate] = useLocation();
  const [showCloseDay, setShowCloseDay] = useState(false);
  const { activeBranchId } = useBranch();

  // [dashboard-default 2026-07-22] Opens on TODAY. Sal's read of the page is
  // "what is my business doing right now" — the week is one tap away, not the
  // default.
  const [period, setPeriod] = useState<Period>('today');
  const summary = useSummary(period, activeBranchId);
  const leadReport = useLeadReport(summary?.window ?? null);
  const referralReport = useReferralReport(summary?.window ?? null);
  const booked = useBooked(period, activeBranchId);
  const weather = useWeather(activeBranchId);

  const today = useToday(activeBranchId);
  const kpis = useKpis();
  const revenueChart = useRevenueChart();
  const techsData = useTechsToday();

  // BUSINESS HEALTH cards (rate trend, payroll %, retention) — sourced from
  // job_history via the shared backend calc, NOT the corrupted jobs table.
  const [bizHealth, setBizHealth] = useState<{ rate_trend: number; avg_bill_12mo: number; retention: number; payroll_pct: number; payroll_window: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/api/dashboard/business-health`, { headers: getAuthHeaders() });
        if (!cancelled) setBizHealth(await r.json());
      } catch { /* leave null → cards render — */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const token = useAuthStore(state => state.token) || '';
  let userRole = 'office';
  try {
    const p = JSON.parse(atob(token.split('.')[1]));
    userRole = p.role || 'office';
  } catch {}
  const canAdmin = userRole === 'owner' || userRole === 'admin';

  const firstName = useFirstName();
  const greeting = useGreeting(firstName);
  const todayDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const counts = today?.counts || {};
  const actions: any[] = kpis?.action_items || [];

  // Status chips — navigate to /dispatch?status=<key>
  // [today-view 2026-07-08] Owner's at-a-glance for the day. "Scheduled Today"
  // is the REAL total booked today (was showing only not-started, so it read
  // wrong); "Remaining" is what's left; the always-0 "In Progress" tile is
  // gone (Phes jobs go scheduled→complete via the clock, never stamped
  // in_progress). Flagged lives in tickets.
  // [ui-consistency 2026-07-22] Four tiles, one treatment. They used to be
  // plain / blue / green / red-with-a-stripe — and "0 COMPLETE" was tinted
  // green (success) while it's the bad number at 6pm, so the color argued
  // against the data. Count color now carries no meaning; risk is surfaced by
  // the Needs-attention strip above instead.
  const STATUS_CARDS = [
    { key: 'scheduled_total', label: 'Scheduled today', dispatchKey: 'all' },
    { key: 'remaining',       label: 'Remaining',       dispatchKey: 'scheduled' },
    { key: 'complete',        label: 'Complete',        dispatchKey: 'complete' },
    { key: 'unassigned',      label: 'Unassigned',      dispatchKey: 'unassigned' },
  ];

  // Intelligence strip — hide if all values are dashes
  const hcp = kpis?.hcp;
  const HCP_TILES = [
    { label: 'Daily Revenue',        value: hcp == null ? '—' : fmt$(hcp.rev_booked_today), sub: "today's scheduled jobs" },
    { label: 'New Jobs Booked',      value: hcp == null ? '—' : String(hcp.new_jobs_today), sub: 'booked today' },
    { label: 'Quotes Given',         value: hcp == null ? '—' : String(hcp.quotes_given_today), sub: 'today' },
    { label: 'Booked Online',        value: hcp == null ? '—' : String(hcp.booked_online_month), sub: 'this month' },
  ];

  const intelligenceValues = [
    kpis?.forecast_next_month,
    kpis?.avg_ltv,
    kpis?.avg_nps,
  ];
  const allIntelDashes = intelligenceValues.every(v => v == null);

  // Merged chart data — align prior_year by month label (already aligned server-side)
  const chartData = revenueChart.data.map((d, i) => ({
    month: d.month,
    revenue: d.revenue,
    prior_revenue: revenueChart.prior_year[i]?.revenue ?? 0,
  }));

  // YTD = current calendar year only (months whose label ends in current year)
  const currentYearSuffix = `'${String(new Date().getFullYear()).slice(2)}`;
  const ytdTotal = revenueChart.data
    .filter(r => r.month.endsWith(currentYearSuffix))
    .reduce((s, r) => s + r.revenue, 0);

  // Mobile gets the role-based, user-customizable card dashboard. Desktop
  // (below) is unchanged. All hooks above run in both paths, so this early
  // return is safe re: rules-of-hooks.
  if (isMobile) {
    return (
      <DashboardLayout>
        <MobileDashboard />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: GAP, fontFamily: FF }}>

        {/* ── HERO ─────────────────────────────────────────────── */}
        {/* One control owns the page: the money row and the growth row both read
            the window it resolves, and each card states its own window in words
            so a label can never drift from the SQL. */}
        <HeroBand
          greeting={greeting}
          todayDate={todayDate}
          summary={summary}
          period={period}
          setPeriod={setPeriod}
          weather={weather}
        />

        {/* ── NEEDS ATTENTION (risk first, hidden when clean) ───── */}
        <NeedsAttentionStrip
          alerts={today?.alerts || []}
          unassigned={Number(counts.unassigned ?? 0)}
          flagged={Number(counts.flagged ?? 0)}
          navigate={navigate}
        />

        {/* ── TODAY ON THE BOARD ───────────────────────────────── */}
        {/* [board-first 2026-07-23] Sits directly under the risk strip, above
            Money. It answers "what is happening right now" — the operational
            question the morning starts with. Money and Growth are review
            surfaces; they read fine further down. */}
        <div>
          <p style={SECTION_LABEL}>Today on the board</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: GAP }}>
            {STATUS_CARDS.map(card => (
              <StatusChip
                key={card.key}
                label={card.label}
                value={Number(counts[card.key] ?? 0)}
                onClick={() => navigate(`/dispatch?status=${card.dispatchKey}`)}
              />
            ))}
          </div>
        </div>

        {/* ── MONEY ────────────────────────────────────────────── */}
        {/* Revenue booked is the hero above; this row is the rest of the money
            picture. Receivables was removed at Sal's call — it lives on
            /reports/receivables and was noise here. */}
        <div>
          <p style={SECTION_LABEL}>Money · {summary?.label ?? PERIODS.find(p => p.key === period)!.label}{summary ? ` · ${fmtRange(summary.window.from, summary.window.to)}` : ''}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: GAP }}>
            <MoneyCard
              label="Cash collected"
              value={summary ? fmtWF(summary.collected.value) : '—'}
              delta={summary?.collected.delta_pct}
              sub={summary ? `payments received${summary.collected.company_wide ? ' · all branches' : ''}` : 'Loading…'}
              href="/invoices" navigate={navigate}
            />
            <MoneyCard
              label="Booked today"
              value={hcp == null ? '—' : String(hcp.new_jobs_today)}
              sub={hcp == null ? 'Loading…' : `${fmtWF(hcp.rev_booked_today)} scheduled for today`}
              href={`/reports/jobs?booked_on=${ctToday()}`} navigate={navigate}
            />
            {/* Arrears: always the last COMPLETED week, never the selector's
                window. This week's commission isn't owed yet, so its ratio
                would swing every morning and mean nothing. */}
            <MoneyCard
              label="Payroll · last week"
              value={summary?.payroll.pct_of_revenue != null ? `${summary.payroll.pct_of_revenue}%` : '—'}
              sub={summary ? `${fmtWF(summary.payroll.cost)} commission on ${fmtWF(summary.payroll.revenue)} · ${summary.payroll.window.from.slice(5)} – ${summary.payroll.window.to.slice(5)}` : 'Loading…'}
              href="/reports/payroll" navigate={navigate}
            />
          </div>
        </div>

        {/* ── GROWTH ───────────────────────────────────────────── */}
        <div>
          <p style={SECTION_LABEL}>Growth · {summary?.label ?? PERIODS.find(p => p.key === period)!.label}{summary ? ` · ${fmtRange(summary.window.from, summary.window.to)}` : ''}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: GAP, alignItems: 'start' }}>
            {/* Booked sits under the funnel, not beside it — the funnel's last
                step is "Booked N" and this is what those N were worth. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
              <ConversionCard report={leadReport} periodLabel={summary?.label ?? 'this week'} navigate={navigate} />
              <BookedCard booked={booked} navigate={navigate} />
            </div>
            <LeadSourcesCard report={referralReport} navigate={navigate} />
          </div>
        </div>

        {/* ── BOOK OF BUSINESS ─────────────────────────────────── */}
        {/* The old "Key Numbers" row plus the orphan two-tile HCP strip, merged.
            Both were showing standing counts in two different card treatments;
            they're one row now. "Booked today" keeps its #1196 drill-down. */}
        <div>
          <p style={SECTION_LABEL}>Book of business</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: GAP }}>
            <MoneyCard
              label="Avg bill"
              value={kpis == null ? '—' : (kpis.avg_bill > 0 ? `$${kpis.avg_bill.toFixed(0)}` : '—')}
              sub="last 30 days"
            />
            <MoneyCard
              label="Active clients"
              value={kpis == null ? '—' : (kpis.active_clients != null ? String(kpis.active_clients) : '—')}
              sub={kpis?.recurring_count != null ? `${kpis.recurring_count} recurring` : ' '}
              href="/clients" navigate={navigate}
            />
            <MoneyCard
              label="Next 7 days"
              value={kpis == null ? '—' : (kpis.next7_revenue > 0 ? fmtWF(kpis.next7_revenue) : '—')}
              sub={kpis?.next7_jobs != null ? `${kpis.next7_jobs} jobs on the books` : ' '}
              href="/dispatch" navigate={navigate}
            />
          </div>
        </div>

        {/* ── RIGHT NOW: who's working + the two notification feeds ─ */}
        {/* Techs Today used to sit beside the 12-month revenue chart, and the
            three alert banners were stacked below everything. Both are
            "someone has to look at this today" content, so they read together
            here instead of bracketing half a page of trend charts. */}
        {canAdmin && (
          <NotificationsSection
            techs={
              <div style={{ ...CARD, padding: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0, fontFamily: FF }}>Techs today</p>
                  <button onClick={() => navigate('/employees/clocks')} style={{ fontSize: 11, fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF, display: 'flex', alignItems: 'center', gap: 3, padding: 0 }}>
                    Clock monitor <ChevronRight size={12} />
                  </button>
                </div>
                {!techsData
                  ? <p style={{ fontSize: 12, color: 'var(--ink-faint)', margin: 0, fontFamily: FF }}>Loading…</p>
                  : <TechsTodayPanel techsData={techsData} navigate={navigate} />}
              </div>
            }
          />
        )}

        {/* ── OFFICE REMINDERS ─────────────────────────────────── */}
        {canAdmin && <OfficeReminders isMobile={isMobile} />}

        {/* ── REVENUE TREND ────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: GAP, alignItems: 'stretch' }}>
          <div style={{ ...CARD, padding: '24px', flex: 1, minWidth: 0 }}>
            {chartData.length === 0 ? (
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ fontSize: 12, color: '#9E9B94', margin: 0, fontFamily: FF }}>No revenue data yet.</p>
              </div>
            ) : (
              <>
                {/* Title + YTD */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
                  <p style={{ fontSize: 13, fontWeight: 500, color: '#1A1917', margin: 0, fontFamily: FF }}>
                    Revenue — Last 12 Months
                  </p>
                  <p style={{ fontSize: 13, fontWeight: 500, color: '#1A1917', margin: 0, fontFamily: FF }}>
                    YTD {ytdTotal >= 1_000_000
                      ? `$${(ytdTotal / 1_000_000).toFixed(2)}M`
                      : `$${(ytdTotal / 1000).toFixed(1)}k`}
                  </p>
                </div>
                {/* Legend — above chart canvas */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ display: 'inline-block', width: 14, height: 2, backgroundColor: 'var(--brand)', borderRadius: 1 }} />
                    <span style={{ fontSize: 12, color: '#4A4845', fontFamily: FF }}>This year</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed var(--ink-faint)' }} />
                    <span style={{ fontSize: 12, color: '#4A4845', fontFamily: FF }}>Prior year</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F0EEE9" vertical={false} />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 10, fill: '#9E9B94', fontFamily: FF }}
                      axisLine={false}
                      tickLine={false}
                      interval={isMobile ? 2 : 0}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#9E9B94', fontFamily: FF }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`}
                      width={44}
                    />
                    <Tooltip
                      contentStyle={{ fontFamily: FF, fontSize: 12, borderRadius: 8, border: '1px solid #E5E2DC', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}
                      formatter={(value: number, name: string) => [
                        `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
                        name === 'revenue' ? 'This year' : 'Prior year',
                      ]}
                      labelStyle={{ fontWeight: 600, color: '#1A1917' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="revenue"
                      stroke="var(--brand)"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: 'var(--brand)', strokeWidth: 0 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="prior_revenue"
                      stroke="var(--ink-faint)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={false}
                      activeDot={{ r: 3, fill: 'var(--ink-faint)', strokeWidth: 0 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </>
            )}
          </div>

        </div>

        {/* ── INTELLIGENCE STRIP (hidden if all dashes, below Needs Attention) ── */}
        {/* Was three tinted tiles — brand / green / blue — with 800-weight
            numbers in three different colors. None of the three is a status,
            so none of them earns a color: same white card as every other tile,
            value in --ink, brand tick for the family. */}
        {kpis && !allIntelDashes && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)', gap: GAP }}>
            {[
              { label: 'Revenue forecast', value: kpis.forecast_next_month != null ? fmt$(kpis.forecast_next_month) : '—', sub: 'next 30 days' },
              { label: 'Avg client LTV', value: kpis.avg_ltv != null ? fmt$(kpis.avg_ltv) : '—', sub: 'estimated lifetime' },
              { label: 'Avg NPS', value: kpis.avg_nps != null ? kpis.avg_nps.toFixed(1) : '—', sub: 'last 90 days' },
            ].filter(w => w.value !== '—').map(w => (
              <MoneyCard key={w.label} label={w.label} value={w.value} sub={w.sub} />
            ))}
          </div>
        )}

        {/* ── BUSINESS HEALTH ──────────────────────────────────── */}
        {/* Same three numbers, same sources — moved onto MoneyCard so this row
            stops being a fourth card treatment (36px/500 values, orange for a
            negative rate trend, teal for retention, its own 14px gap). Rate
            trend keeps its sign in the text; it no longer needs a color to say
            "down", which was the only number on the page painted by value. */}
        <div>
          <p style={SECTION_LABEL}>Business health</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: GAP }}>
            <MoneyCard
              label="Rate trend"
              value={bizHealth == null ? '—' : `${bizHealth.rate_trend > 0 ? '+' : ''}${bizHealth.rate_trend}%`}
              sub="avg bill, 12mo vs prior 12mo"
            />
            <MoneyCard
              label="Payroll %"
              value={bizHealth == null ? '—' : `${bizHealth.payroll_pct}%`}
              sub={`payroll cost / revenue, ${bizHealth?.payroll_window ?? '—'}`}
            />
            <MoneyCard
              label="Retention"
              value={bizHealth == null ? '—' : `${bizHealth.retention}%`}
              sub="recurring clients active"
            />
          </div>
        </div>

        {/* ── Weekly Revenue Forecast ── */}
        <WeeklyForecastSection />

        {/* ── Recent Activity (under the revenue forecast) ── */}
        <RecentActivitySection />

        {/* Commercial alerts, HR alerts and the mileage queue used to stack here,
            below every chart. They now render in the Right-now band near the top
            of the page — same components, same data, same actions. */}

      </div>
      {showCloseDay && <CloseDayModal onClose={() => setShowCloseDay(false)} />}
    </DashboardLayout>
  );
}

// [ui-consistency 2026-07-22] One treatment for all four tiles. They used to be
// plain / blue / green / red-with-a-stripe, and "0 COMPLETE" was tinted green
// (success) while it's the bad number at 6pm — the color argued against the
// data. Risk now lives in the Needs-attention strip, not in tile chrome.
function StatusChip({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...CARD,
        minWidth: 0, width: '100%', minHeight: 90,
        border: `1px solid ${hovered ? 'var(--brand)' : 'var(--border)'}`,
        padding: '18px 8px',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
        fontFamily: FF, transition: 'border-color 0.15s',
      }}
    >
      <p style={{ fontSize: 30, fontWeight: 600, color: 'var(--ink)', margin: 0, lineHeight: 1, fontFamily: FF }}>{value}</p>
      <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.03em', margin: '6px 0 0', fontFamily: FF, textAlign: 'center', lineHeight: 1.15 }}>{label}</p>
    </button>
  );
}

const ACTION_DOT: Record<string, string> = { red: '#B3261E', amber: '#F59E0B', blue: '#2F3646' };

function NeedsAttentionItem({ item, navigate }: { item: any; navigate: (path: string) => void }) {
  return (
    <div style={{ backgroundColor: '#FFFFFF', border: '0.5px solid #E5E2DC', borderRadius: 8, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: ACTION_DOT[item.level] || '#9E9B94', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: '0 0 2px', fontFamily: FF }}>{item.title}</p>
        <p style={{ fontSize: 12, color: '#6B6860', margin: 0, lineHeight: 1.4, fontFamily: FF }}>{item.text}</p>
      </div>
      {item.action && (
        <button
          onClick={() => navigate(item.action)}
          style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 12, fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF, padding: '4px 0', flexShrink: 0 }}
        >
          View <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}

function TechsTodayPanel({ techsData, navigate }: { techsData: any; navigate: (path: string) => void }) {
  const techs: any[] = techsData?.techs || [];
  const totalJobsToday: number = techsData?.total_jobs_today ?? 0;
  const MAX_DISPLAY = 6;
  const displayTechs = techs.slice(0, MAX_DISPLAY);
  const activeTechs = techs.filter(t => t.job_count > 0).length;
  const totalCapacity = techs.length * 4;
  const openSlots = Math.max(0, totalCapacity - totalJobsToday);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {displayTechs.map((tech: any) => {
        const initials = `${tech.first_name?.[0] ?? ''}${tech.last_name?.[0] ?? ''}`.toUpperCase();
        const hasJobs = tech.job_count > 0;
        const capacityPct = Math.min(tech.job_count / 4, 1) * 100;
        return (
          <div key={tech.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 16,
              backgroundColor: '#E8F0FB', color: '#185FA5',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, flexShrink: 0, fontFamily: FF,
            }}>
              {initials}
            </div>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#1A1917', margin: 0, flex: 1, fontFamily: FF, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {tech.first_name} {tech.last_name?.[0]}.
            </p>
            <span style={{
              fontSize: 12, fontWeight: 700,
              color: hasJobs ? '#185FA5' : '#D85A30',
              background: hasJobs ? '#E8F0FB' : '#FEF0E7',
              borderRadius: 10, padding: '3px 9px', flexShrink: 0, fontFamily: FF,
            }}>
              {tech.job_count}
            </span>
            <div style={{ width: 60, height: 6, backgroundColor: '#F0EEE9', borderRadius: 3, flexShrink: 0, overflow: 'hidden' }}>
              <div style={{ width: `${capacityPct}%`, height: '100%', backgroundColor: 'var(--brand)', borderRadius: 3 }} />
            </div>
          </div>
        );
      })}

      {techs.length > MAX_DISPLAY && (
        <button
          onClick={() => navigate('/employees')}
          style={{ fontSize: 11, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF, textAlign: 'left', padding: '2px 0' }}
        >
          View all →
        </button>
      )}

      {/* Capacity summary */}
      <div style={{ borderTop: '1px solid #F0EEE9', paddingTop: 10, marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#9E9B94', fontFamily: FF }}>
          <span style={{ fontSize: 22, fontWeight: 500, color: openSlots > 0 ? '#1D9E75' : '#F59E0B' }}>{openSlots}</span> open slots
        </span>
        <span style={{ fontSize: 11, color: '#9E9B94', fontFamily: FF }}>
          {activeTechs} active / {totalJobsToday} jobs
        </span>
      </div>
    </div>
  );
}

// onCount lets the Notifications section know whether this feed has anything,
// without lifting the fetch out of the banner. A feed that reports 0 is hidden
// by its own `return null` AND lets the section hide its column heading.
function CommercialAlertsBanner({ onCount }: { onCount?: (n: number) => void } = {}) {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [, navigate] = useLocation();

  useEffect(() => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${base}/api/dashboard/commercial-alerts`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : { alerts: [] })
      .then(d => { setAlerts(d.alerts || []); onCount?.((d.alerts || []).length); })
      .catch(() => onCount?.(0));
  }, []);

  if (!alerts.length) return null;

  const COLOR: Record<string, { bg: string; border: string; text: string; dot: string }> = {
    red:   { bg: "#FCEBEA", border: "#F1D0CB", text: "#B3261E", dot: "#B3261E" },
    amber: { bg: "#FDF3E4", border: "#F2DFB8", text: "#B45309", dot: "#F59E0B" },
    blue:  { bg: "#EFEFF2", border: "#DEDEE4", text: "#2F3646", dot: "#2F3646" },
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Building2 size={15} color="#6B6860" />
        <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: FF }}>Commercial Alerts</span>
        <span style={{ fontSize: 11, fontWeight: 700, background: alerts.some(a => a.level === "red") ? "#FCEBEA" : "#FDF3E4", color: alerts.some(a => a.level === "red") ? "#B3261E" : "#B45309", borderRadius: 10, padding: "1px 8px", fontFamily: FF }}>
          {alerts.length}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {alerts.map((a, i) => {
          const c = COLOR[a.level] ?? COLOR.blue;
          const href = a.job_id ? `/jobs` : a.account_id ? `/accounts/${a.account_id}` : null;
          return (
            <div
              key={i}
              onClick={() => href && navigate(href)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                background: c.bg, border: `1px solid ${c.border}`, borderRadius: 7,
                cursor: href ? "pointer" : "default",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 3, background: c.dot, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: c.text, fontFamily: FF, flex: 1, lineHeight: 1.4 }}>{a.text}</span>
              {href && <ChevronRight size={13} color={c.text} style={{ flexShrink: 0 }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MileagePendingBanner({ onCount }: { onCount?: (n: number) => void } = {}) {
  const [requests, setRequests] = useState<any[]>([]);
  const [actioning, setActioning] = useState<Record<number, boolean>>({});
  const [denyingId, setDenyingId] = useState<number | null>(null);
  const [denyReason, setDenyReason] = useState("");

  const load = () => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${base}/api/mileage-requests?status=pending`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then((rows: any[]) => { setRequests(rows); onCount?.(rows.length); })
      .catch(() => onCount?.(0));
  };

  useEffect(() => { load(); }, []);

  const handleApprove = async (id: number) => {
    setActioning(p => ({ ...p, [id]: true }));
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    await fetch(`${base}/api/mileage-requests/${id}/approve`, { method: "POST", headers: getAuthHeaders() }).catch(() => {});
    setActioning(p => ({ ...p, [id]: false }));
    load();
  };

  const handleDeny = async (id: number) => {
    setActioning(p => ({ ...p, [id]: true }));
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    await fetch(`${base}/api/mileage-requests/${id}/deny`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ denial_reason: denyReason }),
    }).catch(() => {});
    setActioning(p => ({ ...p, [id]: false }));
    setDenyingId(null);
    setDenyReason("");
    load();
  };

  if (!requests.length) return null;

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Car size={15} color="#6B6860"/>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: FF }}>
          Mileage Requests
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, background: "#FDF3E4", color: "#B45309", borderRadius: 10, padding: "1px 7px", marginLeft: 4, fontFamily: FF }}>
          {requests.length} pending
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {requests.map((r: any) => (
          <div key={r.id} style={{ background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", margin: "0 0 2px", fontFamily: FF }}>{r.employee_name}</p>
                <p style={{ fontSize: 12, color: "#6B6860", margin: "0 0 2px", fontFamily: FF }}>
                  {r.from_client_name} → {r.to_client_name}
                </p>
                <p style={{ fontSize: 12, color: "#6B6860", margin: 0, fontFamily: FF }}>
                  {r.miles} mi · <span style={{ fontWeight: 600, color: "#1A1917" }}>${parseFloat(r.reimbursement_amount || "0").toFixed(2)}</span>
                  {r.service_date && ` · ${new Date(r.service_date + "T00:00:00").toLocaleDateString()}`}
                </p>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button onClick={() => handleApprove(r.id)} disabled={actioning[r.id]}
                  style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", background: "#E6F6F1", color: "#0F7A63", border: "1px solid #C7E7DE", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                  <Check size={12}/> Approve
                </button>
                <button onClick={() => setDenyingId(r.id)} disabled={actioning[r.id]}
                  style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", background: "#FCEBEA", color: "#B3261E", border: "1px solid #F1D0CB", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                  <X size={12}/> Deny
                </button>
              </div>
            </div>
            {denyingId === r.id && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E2DC" }}>
                <input value={denyReason} onChange={e => setDenyReason(e.target.value)}
                  placeholder="Reason for denial (optional)"
                  style={{ width: "100%", padding: "7px 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, marginBottom: 8, boxSizing: "border-box" as const }}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => { setDenyingId(null); setDenyReason(""); }}
                    style={{ padding: "5px 12px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, background: "#fff", cursor: "pointer", fontFamily: FF }}>Cancel</button>
                  <button onClick={() => handleDeny(r.id)}
                    style={{ padding: "5px 12px", background: "#B3261E", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>Confirm Deny</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function HRAlertsBanner({ onCount }: { onCount?: (n: number) => void } = {}) {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [, navigate] = useLocation();

  useEffect(() => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${base}/api/hr-attendance/today`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then((todayLogs: any[]) => {
        const hrAlerts: any[] = [];
        const ncns = todayLogs.filter((l: any) => l.type === "ncns");
        const absences = todayLogs.filter((l: any) => l.type === "absent");
        if (ncns.length > 0) hrAlerts.push({ level: "red", text: `${ncns.length} NCNS today — review required`, href: null });
        if (absences.length > 0) hrAlerts.push({ level: "amber", text: `${absences.length} absence(s) logged today`, href: null });
        setAlerts(hrAlerts);
        onCount?.(hrAlerts.length);
      })
      .catch(() => onCount?.(0));
  }, []);

  if (!alerts.length) return null;

  const COLOR: Record<string, { bg: string; border: string; text: string; dot: string }> = {
    red:   { bg: "#FCEBEA", border: "#F1D0CB", text: "#B3261E", dot: "#B3261E" },
    amber: { bg: "#FDF3E4", border: "#F2DFB8", text: "#B45309", dot: "#F59E0B" },
    blue:  { bg: "#EFEFF2", border: "#DEDEE4", text: "#2F3646", dot: "#2F3646" },
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <ShieldAlert size={15} color="#6B6860" />
        <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: FF }}>HR Alerts</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {alerts.map((a, i) => {
          const c = COLOR[a.level] ?? COLOR.blue;
          return (
            <div
              key={i}
              onClick={() => a.href && navigate(a.href)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                background: c.bg, border: `1px solid ${c.border}`, borderRadius: 7,
                cursor: a.href ? "pointer" : "default",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 3, background: c.dot, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: c.text, fontFamily: FF }}>{a.text}</span>
              {a.href && <ChevronRight size={13} color={c.text} style={{ marginLeft: "auto" }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
