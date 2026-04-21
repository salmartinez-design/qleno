import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLocation } from "wouter";
import { ChevronRight, Calendar, ShieldAlert, Building2, Car, Check, X } from "lucide-react";
import { CloseDayModal } from "@/components/close-day-modal";
import { useBranch } from "@/contexts/branch-context";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

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

function useRevenueChart() {
  const [data, setData] = useState<{ data: { month: string; revenue: number; jobs: number }[]; prior_year: { month: string; revenue: number }[] }>({ data: [], prior_year: [] });
  useEffect(() => {
    const load = async () => {
      try {
        const r = await apiFetch('/api/dashboard/revenue-chart');
        if (r.ok) {
          const json = await r.json();
          setData({ data: json.data || [], prior_year: json.prior_year || [] });
        }
      } catch {}
    };
    load();
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

const CARD: React.CSSProperties = {
  backgroundColor: '#FFFFFF',
  border: '0.5px solid #E5E2DC',
  borderRadius: 12,
};

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
          <div style={{ width: 200, height: 12, background: '#F0EDE8', borderRadius: 4, marginBottom: 16, animation: 'wf-pulse 1.5s ease-in-out infinite' }} />
          <div style={{ width: '100%', height: 100, background: '#F0EDE8', borderRadius: 6, animation: 'wf-pulse 1.5s ease-in-out infinite' }} />
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
        <div style={{ borderBottom: '0.5px solid #F0EDE8', paddingBottom: 10, marginBottom: 12 }}>
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
            const cellBorder = isToday ? '1.5px solid #5B9BD5' : (s.border ?? '0.5px solid transparent');
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
        <div style={{ borderTop: '0.5px solid #F0EDE8', paddingTop: 10, marginTop: 10 }}>
          <p style={{ fontSize: 11, color: '#6B6860', margin: 0, fontFamily: FF }}>{summaryNote}</p>
        </div>

        {/* Legend */}
        <div style={{ borderTop: '0.5px solid #F0EDE8', paddingTop: 10, marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          {[
            { label: 'Above avg', bg: '#639922', border: undefined },
            { label: 'Below avg', bg: '#EF9F27', border: undefined },
            { label: 'Low',       bg: '#E24B4A', border: undefined },
            { label: 'Closed',    bg: '#E5E2DC', border: undefined },
            { label: 'Projected', bg: '#F7F6F3', border: '1px dashed #C5C0B8' },
            { label: 'Today',     bg: 'transparent', border: '1.5px solid #5B9BD5' },
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

export default function Dashboard() {
  const isMobile = useIsMobile();
  const [, navigate] = useLocation();
  const [showCloseDay, setShowCloseDay] = useState(false);
  const { activeBranchId, activeBranch } = useBranch();

  const today = useToday(activeBranchId);
  const kpis = useKpis();
  const revenueChart = useRevenueChart();
  const techsData = useTechsToday();

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
  const STATUS_CARDS = [
    { key: 'in_progress', label: 'In Progress', bg: '#E6F1FB', color: '#1E40AF', dispatchKey: 'in_progress', accent: undefined },
    { key: 'scheduled',   label: 'Scheduled',   bg: '#F7F6F3', color: '#1A1917', dispatchKey: 'scheduled',   accent: undefined },
    { key: 'complete',    label: 'Complete',     bg: '#EAF3DE', color: '#1D9E75', dispatchKey: 'complete',   accent: undefined },
    { key: 'flagged',     label: 'Flagged',      bg: '#FAECE7', color: '#D85A30', dispatchKey: 'flagged',    accent: '#D85A30' },
    { key: 'unassigned',  label: 'Unassigned',   bg: '#FCEBEB', color: '#E24B4A', dispatchKey: 'unassigned', accent: '#E24B4A' },
  ];

  // Intelligence strip — hide if all values are dashes
  const hcp = kpis?.hcp;
  const HCP_TILES = [
    { label: 'Revenue Booked Today', value: hcp == null ? '—' : fmt$(hcp.rev_booked_today), sub: 'on schedule today' },
    { label: 'New Jobs Booked',      value: hcp == null ? '—' : String(hcp.new_jobs_this_week), sub: 'this week' },
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

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: FF }}>

        {/* ── GREETING ─────────────────────────────────────────── */}
        <div style={{
          background: 'var(--brand-dim)',
          border: '1px solid color-mix(in srgb, var(--brand) 20%, transparent)',
          borderBottom: '0.5px solid #E5E2DC',
          borderRadius: 12, padding: isMobile ? '18px 16px 20px' : '20px 24px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12,
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <p style={{ fontSize: isMobile ? 20 : 24, fontWeight: 500, color: '#1A1917', margin: 0, fontFamily: FF }}>{greeting}</p>
              {activeBranch && (
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--brand)', background: 'var(--brand-dim)', padding: '2px 8px', borderRadius: 10, letterSpacing: '0.03em', fontFamily: FF }}>
                  {activeBranch.name}
                </span>
              )}
            </div>
            <p style={{ fontSize: 13, color: '#6B6860', margin: '4px 0 0', fontFamily: FF }}>{todayDate}</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'row', gap: 20, alignItems: 'center' }}>
            {canAdmin && (
              <button onClick={() => setShowCloseDay(true)} style={{ alignSelf: 'center', marginLeft: 4, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', backgroundColor: 'rgba(255,255,255,0.7)', color: '#1A1917', border: '1px solid rgba(0,0,0,0.12)', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FF }}>
                <Calendar size={14} /> Close Day
              </button>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 120 }}>
              <span style={{ display: 'block', fontSize: 11, fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, fontFamily: FF }}>Revenue this week</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 28, fontWeight: 600, color: '#1A1917', fontFamily: FF, lineHeight: 1 }}>
                  {kpis != null ? (kpis.week_revenue > 0 ? fmt$(kpis.week_revenue) : '—') : '—'}
                </span>
                {kpis?.week_delta != null && (
                  <span style={{ fontSize: 13, fontWeight: 500, color: kpis.week_delta >= 0 ? '#166534' : '#A32D2D', fontFamily: FF }}>
                    {kpis.week_delta >= 0 ? '+' : ''}{kpis.week_delta}%
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── STATUS CHIPS ─────────────────────────────────────── */}
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontFamily: FF }}>Today's Status</p>
          <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4, scrollbarWidth: 'none' }}>
            {STATUS_CARDS.map(card => {
              const val = Number(counts[card.key] ?? 0);
              return (
                <StatusChip
                  key={card.key}
                  label={card.label}
                  value={val}
                  bg={card.bg}
                  color={card.color}
                  accentColor={card.accent}
                  onClick={() => navigate(`/dispatch?status=${card.dispatchKey}`)}
                />
              );
            })}
          </div>
        </div>

        {/* ── HCP STRIP (above monthly revenue row) ── */}
        {hcp != null && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 8,
            paddingBottom: 14,
            borderBottom: '0.5px solid #F0EDE8',
          }}>
            {[
              { label: 'Revenue Booked Today', value: hcp == null ? '—' : fmtWF(hcp.rev_booked_today), sub: 'on schedule today' },
              { label: 'New Jobs Booked',      value: hcp == null ? '—' : String(hcp.new_jobs_this_week), sub: 'this week' },
            ].map((tile, i) => (
              <div key={i} style={{ ...CARD, padding: '20px 24px', minHeight: 88, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <p style={{ fontSize: 11, fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px', fontFamily: FF }}>{tile.label}</p>
                <p style={{ fontSize: 28, fontWeight: 500, color: '#1A1917', margin: 0, lineHeight: 1, fontFamily: FF }}>{tile.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── 4-TILE METRICS ROW ───────────────────────────────── */}
        <div>
          <p style={{ fontSize: 11, fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px', marginTop: 2, fontFamily: FF }}>Key Numbers</p>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 14 }}>
            {/* Monthly Revenue */}
            <div style={{ ...CARD, padding: isMobile ? '16px 16px' : '22px 24px', minHeight: 100 }}>
              <p style={{ fontSize: 11, fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px', fontFamily: FF }}>Monthly Revenue</p>
              <p style={{ fontSize: isMobile ? 24 : 36, fontWeight: 500, color: '#1A1917', margin: '0 0 6px', lineHeight: 1, fontFamily: FF }}>
                {kpis == null ? '—' : (kpis.month_revenue > 0 ? fmt$(kpis.month_revenue) : '—')}
              </p>
              <DeltaBadge delta={kpis?.month_delta ?? null} />
            </div>

            {/* Avg Bill */}
            <div style={{ ...CARD, padding: isMobile ? '16px 16px' : '22px 24px', minHeight: 100 }}>
              <p style={{ fontSize: 11, fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px', fontFamily: FF }}>Avg Bill</p>
              <p style={{ fontSize: isMobile ? 24 : 36, fontWeight: 500, color: '#1A1917', margin: '0 0 6px', lineHeight: 1, fontFamily: FF }}>
                {kpis == null ? '—' : (kpis.avg_bill > 0 ? `$${kpis.avg_bill.toFixed(0)}` : '—')}
              </p>
              <p style={{ fontSize: 13, color: '#6B6860', margin: 0, fontFamily: FF }}>Last 30 days</p>
            </div>

            {/* Active Clients */}
            <div style={{ ...CARD, padding: isMobile ? '16px 16px' : '22px 24px', minHeight: 100 }}>
              <p style={{ fontSize: 11, fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px', fontFamily: FF }}>Active Clients</p>
              <p style={{ fontSize: isMobile ? 24 : 36, fontWeight: 500, color: '#1A1917', margin: '0 0 6px', lineHeight: 1, fontFamily: FF }}>
                {kpis == null ? '—' : (kpis.active_clients != null ? kpis.active_clients : '—')}
              </p>
              {kpis?.recurring_count != null && (
                <p style={{ fontSize: 13, color: '#6B6860', margin: 0, fontFamily: FF }}>{kpis.recurring_count} recurring</p>
              )}
            </div>

            {/* Next 7 Days */}
            <div style={{ ...CARD, padding: isMobile ? '16px 16px' : '22px 24px', minHeight: 100 }}>
              <p style={{ fontSize: 11, fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px', fontFamily: FF }}>Next 7 Days</p>
              <p style={{ fontSize: isMobile ? 24 : 36, fontWeight: 500, color: '#1A1917', margin: '0 0 6px', lineHeight: 1, fontFamily: FF }}>
                {kpis == null ? '—' : (kpis.next7_revenue > 0 ? fmt$(kpis.next7_revenue) : '—')}
              </p>
              {kpis?.next7_jobs != null && (
                <p style={{ fontSize: 13, color: '#6B6860', margin: 0, fontFamily: FF }}>{kpis.next7_jobs} jobs on the books</p>
              )}
            </div>
          </div>
        </div>

        {/* ── TWO-COLUMN: REVENUE CHART + TECHS TODAY ─────────── */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
          {/* Revenue Chart — 60% */}
          <div style={{ ...CARD, padding: '24px', flex: '0 0 60%', minWidth: 0 }}>
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
                    <span style={{ display: 'inline-block', width: 14, height: 2, backgroundColor: '#5B9BD5', borderRadius: 1 }} />
                    <span style={{ fontSize: 12, color: '#4A4845', fontFamily: FF }}>This year</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed #B5D4F4' }} />
                    <span style={{ fontSize: 12, color: '#4A4845', fontFamily: FF }}>Prior year</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F0EDE8" vertical={false} />
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
                      stroke="#5B9BD5"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: '#5B9BD5', strokeWidth: 0 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="prior_revenue"
                      stroke="#B5D4F4"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={false}
                      activeDot={{ r: 3, fill: '#B5D4F4', strokeWidth: 0 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </>
            )}
          </div>

          {/* Techs Today — 38% (always rendered, independent of chart data) */}
          <div style={{ ...CARD, padding: '20px', flex: '0 0 38%', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0, fontFamily: FF }}>Techs Today</p>
              <button onClick={() => navigate('/employees/clocks')} style={{ fontSize: 11, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF, display: 'flex', alignItems: 'center', gap: 3, padding: 0 }}>
                Clock Monitor <ChevronRight size={12} />
              </button>
            </div>
            {!techsData ? (
              <p style={{ fontSize: 12, color: '#9E9B94', margin: 0, fontFamily: FF }}>Loading…</p>
            ) : (
              <TechsTodayPanel techsData={techsData} navigate={navigate} />
            )}
          </div>
        </div>



        {/* ── INTELLIGENCE STRIP (hidden if all dashes, below Needs Attention) ── */}
        {kpis && !allIntelDashes && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)', gap: 10 }}>
            {[
              { label: 'Revenue Forecast', value: kpis.forecast_next_month != null ? fmt$(kpis.forecast_next_month) : '—', sub: 'next 30 days', color: 'var(--brand)', bg: 'var(--brand-dim)' },
              { label: 'Avg Client LTV', value: kpis.avg_ltv != null ? fmt$(kpis.avg_ltv) : '—', sub: 'estimated lifetime', color: '#16A34A', bg: '#DCFCE7' },
              { label: 'Avg NPS', value: kpis.avg_nps != null ? kpis.avg_nps.toFixed(1) : '—', sub: 'last 90 days', color: '#1D4ED8', bg: '#DBEAFE' },
            ].filter(w => w.value !== '—').map(w => (
              <div key={w.label} style={{ backgroundColor: w.bg, border: '1px solid transparent', borderRadius: 10, padding: '14px 16px' }}>
                <p style={{ fontSize: isMobile ? 10 : 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px', fontFamily: FF }}>{w.label}</p>
                <p style={{ fontSize: isMobile ? 20 : 24, fontWeight: 800, color: w.color, margin: '0 0 2px', lineHeight: 1, fontFamily: FF }}>{w.value}</p>
                <p style={{ fontSize: 10, color: '#9E9B94', margin: 0, fontFamily: FF }}>{w.sub}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Weekly Revenue Forecast ── */}
        <WeeklyForecastSection />

        {/* ── Commercial Alerts ── */}
        {canAdmin && <CommercialAlertsBanner />}

        {/* ── HR Alerts widget (owner/admin only) ── */}
        {canAdmin && <HRAlertsBanner />}

        {/* ── Mileage Pending queue (owner/admin only) ── */}
        {canAdmin && <MileagePendingBanner />}


      </div>
      {showCloseDay && <CloseDayModal onClose={() => setShowCloseDay(false)} />}
    </DashboardLayout>
  );
}

function StatusChip({ label, value, bg, color, accentColor, onClick }: { label: string; value: number; bg: string; color: string; accentColor?: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const hasAccent = Boolean(accentColor);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flexShrink: 0, minWidth: 130,
        minHeight: 90,
        backgroundColor: bg,
        border: hovered ? '1px solid #5B9BD5' : '0.5px solid #E5E2DC',
        borderLeft: hasAccent ? `4px solid ${accentColor}` : (hovered ? '1px solid #5B9BD5' : '0.5px solid #E5E2DC'),
        borderRadius: hasAccent ? '0 12px 12px 0' : 12,
        padding: hasAccent ? '20px 16px 20px 14px' : '20px 16px',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
        fontFamily: FF, transition: 'border-color 0.15s',
      }}
    >
      <p style={{ fontSize: 36, fontWeight: 600, color, margin: 0, lineHeight: 1, fontFamily: FF }}>{value}</p>
      <p style={{ fontSize: 12, fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '8px 0 0', fontFamily: FF }}>{label}</p>
    </button>
  );
}

const ACTION_DOT: Record<string, string> = { red: '#EF4444', amber: '#F59E0B', blue: '#3B82F6' };

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
          style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 12, fontWeight: 600, color: '#5B9BD5', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF, padding: '4px 0', flexShrink: 0 }}
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
            <div style={{ width: 60, height: 6, backgroundColor: '#F0EDE8', borderRadius: 3, flexShrink: 0, overflow: 'hidden' }}>
              <div style={{ width: `${capacityPct}%`, height: '100%', backgroundColor: '#5B9BD5', borderRadius: 3 }} />
            </div>
          </div>
        );
      })}

      {techs.length > MAX_DISPLAY && (
        <button
          onClick={() => navigate('/employees')}
          style={{ fontSize: 11, color: '#5B9BD5', background: 'none', border: 'none', cursor: 'pointer', fontFamily: FF, textAlign: 'left', padding: '2px 0' }}
        >
          View all →
        </button>
      )}

      {/* Capacity summary */}
      <div style={{ borderTop: '1px solid #F0EDE8', paddingTop: 10, marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
