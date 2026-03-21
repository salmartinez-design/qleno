import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLocation } from "wouter";
import { ChevronRight, Calendar, ShieldAlert, Building2, Car, Check, X } from "lucide-react";
import { CloseDayModal } from "@/components/close-day-modal";
import { useBranch } from "@/contexts/branch-context";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const FF = "'Plus Jakarta Sans', sans-serif";

function apiFetch(path: string) {
  return fetch(`${API}${path}`, { headers: getAuthHeaders() });
}

function fmt$(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) return null;
  const pos = delta >= 0;
  return (
    <span style={{
      fontSize: 12, fontWeight: 600,
      color: pos ? '#166534' : '#991B1B',
      background: pos ? '#DCFCE7' : '#FEE2E2',
      borderRadius: 4, padding: '1px 6px',
    }}>
      {pos ? '+' : ''}{delta}%
    </span>
  );
}

function useToday(branchId: number | "all") {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    setData(null);
    const qs = branchId !== "all" ? `?branch_id=${branchId}` : "";
    const load = async () => {
      try {
        const r = await apiFetch(`/api/dashboard/today${qs}`);
        if (r.ok) setData(await r.json());
      } catch {}
    };
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, [branchId]);
  return data;
}

function useKpis() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    const load = async () => {
      try {
        const r = await apiFetch('/api/dashboard/kpis');
        if (r.ok) setData(await r.json());
      } catch {}
    };
    load();
  }, []);
  return data;
}

function useGreeting(firstName: string) {
  const hour = new Date().getHours();
  if (hour < 12) return `Good morning, ${firstName}.`;
  if (hour < 17) return `Good afternoon, ${firstName}.`;
  return `Good evening, ${firstName}.`;
}

export default function Dashboard() {
  const isMobile = useIsMobile();
  const [, navigate] = useLocation();
  const [dismissedActions, setDismissedActions] = useState<Set<number>>(new Set());
  const [showCloseDay, setShowCloseDay] = useState(false);
  const { activeBranchId, activeBranch } = useBranch();

  const today = useToday(activeBranchId);
  const kpis = useKpis();

  const token = useAuthStore(state => state.token) || '';
  let firstName = 'there';
  let userRole = 'office';
  try {
    const p = JSON.parse(atob(token.split('.')[1]));
    firstName = p.first_name || 'there';
    userRole = p.role || 'office';
  } catch {}
  const canAdmin = userRole === 'owner' || userRole === 'admin';

  const greeting = useGreeting(firstName);
  const todayDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const counts = today?.counts || {};
  const actions: any[] = (kpis?.action_items || []).filter((_: any, i: number) => !dismissedActions.has(i));

  const STATUS_CARDS = [
    { key: 'in_progress', label: 'In Progress', bg: '#DBEAFE', color: '#1E40AF', href: '/jobs' },
    { key: 'scheduled',   label: 'Scheduled',   bg: '#F3F4F6', color: '#374151', href: '/jobs' },
    { key: 'complete',    label: 'Complete',     bg: '#DCFCE7', color: '#166534', href: '/jobs' },
    { key: 'flagged',     label: 'Flagged',      bg: null,      color: '#991B1B', href: '/employees/clocks', valueFn: () => today?.alerts?.filter((a: any) => a.action === 'review_clock').length ?? 0 },
    { key: 'unassigned',  label: 'Unassigned',   bg: null,      color: '#92400E', href: '/jobs', valueFn: () => kpis?.action_items?.filter((a: any) => a.text?.includes('unassigned'))[0] ? parseInt(kpis.action_items.find((a: any) => a.text?.includes('unassigned')).text) : 0 },
  ];

  const KPI_ROWS = [
    [
      {
        label: 'Monthly Revenue', value: kpis ? fmt$(kpis.month_revenue) : '—',
        delta: kpis?.month_delta ?? null, warn: false,
      },
      {
        label: 'Avg Bill', value: kpis ? `$${(kpis.avg_bill || 0).toFixed(0)}` : '—',
        delta: null, warn: false,
      },
      {
        label: 'Active Clients', value: kpis?.active_clients ?? '—',
        delta: null, warn: false,
      },
    ],
    [
      {
        label: 'Quality Score', value: kpis?.quality_score != null ? `${kpis.quality_score}/100` : '—',
        delta: null, warn: false,
      },
      {
        label: 'Clients at Risk', value: kpis?.clients_at_risk ?? '—',
        delta: null, warn: (kpis?.clients_at_risk || 0) > 0, click: '/customers',
      },
      {
        label: 'Week Revenue', value: kpis ? fmt$(kpis.week_revenue) : '—',
        delta: kpis?.week_delta ?? null, warn: false,
      },
    ],
  ];

  const ACTION_DOT: Record<string, string> = { red: '#EF4444', amber: '#F59E0B', blue: '#3B82F6' };

  const CARD: React.CSSProperties = { backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: 10 };

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: FF }}>

        {/* ── SECTION 1: GREETING ─────────────────────────── */}
        <div style={{
          background: 'var(--brand-dim)',
          border: '1px solid color-mix(in srgb, var(--brand) 20%, transparent)',
          borderRadius: 12, padding: isMobile ? '18px 16px' : '20px 24px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12,
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <p style={{ fontSize: isMobile ? 15 : 16, fontWeight: 600, color: '#1A1917', margin: 0, fontFamily: FF }}>{greeting}</p>
              {activeBranch && (
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--brand)', background: 'var(--brand-dim)', padding: '2px 8px', borderRadius: 10, letterSpacing: '0.03em', fontFamily: FF }}>
                  {activeBranch.name}
                </span>
              )}
            </div>
            <p style={{ fontSize: 13, color: '#6B6860', margin: 0, fontFamily: FF }}>{todayDate}</p>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {canAdmin && (
              <button onClick={() => setShowCloseDay(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', backgroundColor: 'rgba(255,255,255,0.7)', color: '#1A1917', border: '1px solid rgba(0,0,0,0.12)', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FF }}>
                <Calendar size={14} /> Close Day
              </button>
            )}
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: 12, color: '#6B6860', margin: '0 0 2px', fontFamily: FF }}>Revenue this week</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 22, fontWeight: 700, color: '#1A1917', fontFamily: FF }}>
                  {kpis ? fmt$(kpis.week_revenue) : '—'}
                </span>
                <DeltaBadge delta={kpis?.week_delta ?? null} />
              </div>
            </div>
          </div>
        </div>

        {/* ── SECTION 2: TODAY'S STATUS ─────────────────────── */}
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontFamily: FF }}>Today's Status</p>
          <div style={{
            display: 'flex', gap: 10, overflowX: 'auto',
            paddingBottom: 4, scrollbarWidth: 'none',
          }}>
            {STATUS_CARDS.map(card => {
              const rawVal = card.valueFn ? card.valueFn() : (counts[card.key] ?? 0);
              const val = Number(rawVal);
              const isAlert = (card.key === 'flagged' || card.key === 'unassigned') && val > 0;
              const bg = isAlert ? (card.key === 'flagged' ? '#FEE2E2' : '#FEF3C7') : (card.bg || '#F9F9F7');
              return (
                <button
                  key={card.key}
                  onClick={() => navigate(card.href)}
                  style={{
                    flexShrink: 0, width: 140, height: 80, minWidth: 120,
                    backgroundColor: bg, border: `1px solid ${card.color}22`,
                    borderRadius: 10, padding: '14px 16px',
                    cursor: 'pointer', textAlign: 'left',
                    fontFamily: FF, transition: 'transform 0.1s',
                  }}
                >
                  <p style={{ fontSize: 28, fontWeight: 700, color: card.color, margin: '0 0 2px', lineHeight: 1, fontFamily: FF }}>{val}</p>
                  <p style={{ fontSize: 11, color: card.color, textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0, opacity: 0.75, fontFamily: FF }}>{card.label}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── SECTION 3: KEY NUMBERS ───────────────────────── */}
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontFamily: FF }}>Key Numbers</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {KPI_ROWS.map((row, ri) => (
              <div key={ri} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                {row.map((kpi, ki) => (
                  <button
                    key={ki}
                    onClick={() => kpi.click ? navigate(kpi.click) : undefined}
                    style={{
                      ...CARD,
                      padding: isMobile ? '14px 14px' : '16px 20px',
                      backgroundColor: kpi.warn ? '#FEF3C7' : '#FFFFFF',
                      border: `1px solid ${kpi.warn ? '#F59E0B44' : '#E5E2DC'}`,
                      cursor: kpi.click ? 'pointer' : 'default',
                      textAlign: 'left', fontFamily: FF,
                    }}
                  >
                    <p style={{ fontSize: isMobile ? 10 : 11, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px', fontFamily: FF }}>
                      {kpi.label}
                    </p>
                    <p style={{ fontSize: isMobile ? 20 : 26, fontWeight: 700, color: kpi.warn ? '#92400E' : '#1A1917', margin: '0 0 4px', lineHeight: 1, fontFamily: FF }}>
                      {kpi.value}
                    </p>
                    {kpi.delta !== null && <DeltaBadge delta={kpi.delta} />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* ── SECTION 3B: INTELLIGENCE STRIP ───────────────── */}
        {kpis && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 10 }}>
            {[
              { label: 'Revenue Forecast', value: kpis.forecast_next_month != null ? fmt$(kpis.forecast_next_month) : '—', sub: 'next 30 days', color: 'var(--brand)', bg: 'var(--brand-dim)' },
              { label: 'Avg Client LTV', value: kpis.avg_ltv != null ? fmt$(kpis.avg_ltv) : '—', sub: 'estimated lifetime', color: '#16A34A', bg: '#DCFCE7' },
              { label: 'High Churn Risk', value: kpis.high_churn_count != null ? kpis.high_churn_count : (kpis.clients_at_risk ?? '—'), sub: 'clients at risk', color: (kpis.high_churn_count || kpis.clients_at_risk || 0) > 0 ? '#991B1B' : '#166534', bg: (kpis.high_churn_count || kpis.clients_at_risk || 0) > 0 ? '#FEE2E2' : '#DCFCE7' },
              { label: 'Avg NPS', value: kpis.avg_nps != null ? kpis.avg_nps.toFixed(1) : '—', sub: 'last 90 days', color: '#1D4ED8', bg: '#DBEAFE' },
            ].map(w => (
              <div key={w.label} style={{ backgroundColor: w.bg, border: '1px solid transparent', borderRadius: 10, padding: '14px 16px' }}>
                <p style={{ fontSize: isMobile ? 10 : 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px', fontFamily: FF }}>{w.label}</p>
                <p style={{ fontSize: isMobile ? 20 : 24, fontWeight: 800, color: w.color, margin: '0 0 2px', lineHeight: 1, fontFamily: FF }}>{w.value}</p>
                <p style={{ fontSize: 10, color: '#9E9B94', margin: 0, fontFamily: FF }}>{w.sub}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── SECTION 4: ACTION ITEMS ───────────────────────── */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: 0, fontFamily: FF }}>Needs Attention</p>
            {actions.length > 0 && (
              <span style={{ fontSize: 11, fontWeight: 600, background: '#FEE2E2', color: '#991B1B', borderRadius: 10, padding: '2px 8px', fontFamily: FF }}>
                {actions.length}
              </span>
            )}
          </div>

          {actions.length === 0 ? (
            <div style={{ ...CARD, padding: '20px 16px', textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: '#9E9B94', margin: 0, fontFamily: FF }}>Nothing needs attention right now.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(kpis?.action_items || []).map((a: any, i: number) => {
                if (dismissedActions.has(i)) return null;
                return (
                  <div key={i} style={{ ...CARD, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ACTION_DOT[a.level] || '#9E9B94', flexShrink: 0 }} />
                    <p style={{ fontSize: 13, color: '#1A1917', margin: 0, flex: 1, lineHeight: 1.4, fontFamily: FF }}>{a.text}</p>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                      <button
                        onClick={() => navigate(a.action)}
                        style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 12, fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF, padding: '4px 0' }}
                      >
                        View <ChevronRight size={13} />
                      </button>
                      <button
                        onClick={() => setDismissedActions(prev => new Set([...prev, i]))}
                        style={{ fontSize: 11, color: '#9E9B94', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF, padding: '4px 0' }}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Commercial Alerts ── */}
        {canAdmin && <CommercialAlertsBanner />}

        {/* ── HR Alerts widget (owner/admin only) ── */}
        {canAdmin && <HRAlertsBanner />}

        {/* ── Mileage Pending queue (owner/admin only) ── */}
        {canAdmin && <MileagePendingBanner />}

        {/* Employee board — compact version */}
        {today?.employee_board?.length > 0 && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0, fontFamily: FF }}>Team Today</p>
              <button onClick={() => navigate('/employees/clocks')} style={{ fontSize: 12, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF, display: 'flex', alignItems: 'center', gap: 3 }}>
                Clock Monitor <ChevronRight size={13} />
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
              {today.employee_board.filter((e: any) => e.status !== 'OFF TODAY').slice(0, 8).map((emp: any) => {
                const STATUS_CFG: Record<string, { color: string; bg: string; dot: string }> = {
                  'ON JOB':    { color: '#166534', bg: '#DCFCE7', dot: '#22C55E' },
                  'EN ROUTE':  { color: '#1D4ED8', bg: '#DBEAFE', dot: '#3B82F6' },
                  'SCHEDULED': { color: '#6B7280', bg: '#F3F4F6', dot: '#9CA3AF' },
                  'COMPLETE':  { color: '#0F766E', bg: '#CCFBF1', dot: '#14B8A6' },
                };
                const cfg = STATUS_CFG[emp.status] || STATUS_CFG['SCHEDULED'];
                return (
                  <button
                    key={emp.id}
                    onClick={() => navigate(`/employees/${emp.id}`)}
                    style={{
                      backgroundColor: cfg.bg, border: `1px solid ${cfg.color}18`,
                      borderRadius: 10, padding: '10px 12px', cursor: 'pointer',
                      textAlign: 'left', fontFamily: FF,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                      {emp.avatar_url
                        ? <img src={emp.avatar_url} style={{ width: 22, height: 22, borderRadius: 11, objectFit: 'cover', flexShrink: 0 }} />
                        : <div style={{ width: 22, height: 22, borderRadius: 11, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#6B7280', flexShrink: 0 }}>
                            {emp.first_name?.[0]}{emp.last_name?.[0]}
                          </div>
                      }
                      <p style={{ fontSize: 11, fontWeight: 600, color: '#1A1917', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FF }}>{emp.first_name} {emp.last_name}</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: cfg.dot, flexShrink: 0 }} />
                      <span style={{ fontSize: 10, fontWeight: 700, color: cfg.color, fontFamily: FF }}>{emp.status}</span>
                    </div>
                    {emp.detail && <p style={{ fontSize: 10, color: '#6B7280', margin: '3px 0 0 0', lineHeight: 1.3, fontFamily: FF }}>{emp.detail}</p>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

      </div>
      {showCloseDay && <CloseDayModal onClose={() => setShowCloseDay(false)} />}
    </DashboardLayout>
  );
}

function CommercialAlertsBanner() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [, navigate] = useLocation();

  useEffect(() => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${base}/api/dashboard/commercial-alerts`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : { alerts: [] })
      .then(d => setAlerts(d.alerts || []))
      .catch(() => {});
  }, []);

  if (!alerts.length) return null;

  const COLOR: Record<string, { bg: string; border: string; text: string; dot: string }> = {
    red:   { bg: "#FEF2F2", border: "#FECACA", text: "#991B1B", dot: "#EF4444" },
    amber: { bg: "#FFFBEB", border: "#FDE68A", text: "#92400E", dot: "#F59E0B" },
    blue:  { bg: "#EFF6FF", border: "#BFDBFE", text: "#1E40AF", dot: "#3B82F6" },
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Building2 size={15} color="#6B7280" />
        <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: FF }}>Commercial Alerts</span>
        <span style={{ fontSize: 11, fontWeight: 700, background: alerts.some(a => a.level === "red") ? "#FEE2E2" : "#FEF3C7", color: alerts.some(a => a.level === "red") ? "#991B1B" : "#92400E", borderRadius: 10, padding: "1px 8px", fontFamily: FF }}>
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

function MileagePendingBanner() {
  const [requests, setRequests] = useState<any[]>([]);
  const [actioning, setActioning] = useState<Record<number, boolean>>({});
  const [denyingId, setDenyingId] = useState<number | null>(null);
  const [denyReason, setDenyReason] = useState("");

  const load = () => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${base}/api/mileage-requests?status=pending`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then(setRequests)
      .catch(() => {});
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
        <Car size={15} color="#6B7280"/>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: FF }}>
          Mileage Requests
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, background: "#FEF3C7", color: "#92400E", borderRadius: 10, padding: "1px 7px", marginLeft: 4, fontFamily: FF }}>
          {requests.length} pending
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {requests.map((r: any) => (
          <div key={r.id} style={{ background: "#FAFAF9", border: "1px solid #E5E2DC", borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", margin: "0 0 2px", fontFamily: FF }}>{r.employee_name}</p>
                <p style={{ fontSize: 12, color: "#6B7280", margin: "0 0 2px", fontFamily: FF }}>
                  {r.from_client_name} → {r.to_client_name}
                </p>
                <p style={{ fontSize: 12, color: "#6B7280", margin: 0, fontFamily: FF }}>
                  {r.miles} mi · <span style={{ fontWeight: 600, color: "#1A1917" }}>${parseFloat(r.reimbursement_amount || "0").toFixed(2)}</span>
                  {r.service_date && ` · ${new Date(r.service_date + "T00:00:00").toLocaleDateString()}`}
                </p>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button onClick={() => handleApprove(r.id)} disabled={actioning[r.id]}
                  style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                  <Check size={12}/> Approve
                </button>
                <button onClick={() => setDenyingId(r.id)} disabled={actioning[r.id]}
                  style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", background: "#FEE2E2", color: "#991B1B", border: "1px solid #FECACA", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
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
                    style={{ padding: "5px 12px", background: "#EF4444", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>Confirm Deny</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function HRAlertsBanner() {
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
      })
      .catch(() => {});
  }, []);

  if (!alerts.length) return null;

  const COLOR: Record<string, { bg: string; border: string; text: string; dot: string }> = {
    red:   { bg: "#FEF2F2", border: "#FECACA", text: "#991B1B", dot: "#EF4444" },
    amber: { bg: "#FFFBEB", border: "#FDE68A", text: "#92400E", dot: "#F59E0B" },
    blue:  { bg: "#EFF6FF", border: "#BFDBFE", text: "#1E40AF", dot: "#3B82F6" },
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <ShieldAlert size={15} color="#6B7280" />
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
