import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useGetDashboardMetrics } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  DollarSign, CheckCircle2, Users, AlertTriangle, ChevronRight, TrendingUp,
} from "lucide-react";

const mockChartData = [
  { name: 'Mon', revenue: 3200 },
  { name: 'Tue', revenue: 2800 },
  { name: 'Wed', revenue: 4800 },
  { name: 'Thu', revenue: 4100 },
  { name: 'Fri', revenue: 5600 },
  { name: 'Sat', revenue: 2100 },
  { name: 'Sun', revenue: 1400 },
];

const CARD: React.CSSProperties = {
  backgroundColor: '#161616',
  border: '1px solid #222222',
  borderRadius: '10px',
};

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#161616', border: '1px solid #222222', borderRadius: 8, padding: '8px 12px', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <p style={{ fontSize: 11, color: '#4A4845', margin: '0 0 2px' }}>{label}</p>
      <p style={{ fontSize: 15, fontWeight: 600, color: '#F0EDE8', margin: 0 }}>
        ${payload[0].value.toLocaleString()}
      </p>
    </div>
  );
}

export default function Dashboard() {
  const isMobile = useIsMobile();
  const { data } = useGetDashboardMetrics(
    { period: "week" },
    { request: { headers: getAuthHeaders() } }
  );

  const metrics = [
    {
      label: 'Total Revenue',
      value: `$${(data?.total_revenue || 0).toLocaleString()}`,
      sub: '↑ 12% from last week',
      subColor: '#4ADE80',
      icon: TrendingUp,
    },
    {
      label: 'Jobs Today',
      value: data?.jobs_completed ?? 0,
      sub: `${data?.jobs_in_progress || 0} in progress`,
      icon: CheckCircle2,
    },
    {
      label: 'Active Employees',
      value: data?.active_employees ?? 0,
      sub: `Avg score: ${(data?.avg_job_score || 0).toFixed(1)}/4.0`,
      icon: Users,
    },
    {
      label: 'Flagged Clock-Ins',
      value: data?.flagged_clock_ins ?? 0,
      sub: 'Needs review',
      subColor: '#F87171',
      icon: AlertTriangle,
    },
  ];

  const recentJobs = data?.recent_jobs?.slice(0, 5) ?? [];
  const topEmployees = data?.top_employees?.slice(0, 5) ?? [];

  if (isMobile) {
    return (
      <DashboardLayout>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Metric cards — 2 per row on mobile */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {metrics.map(({ label, value, sub, subColor, icon: Icon }) => (
              <div key={label} style={{ ...CARD, padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <p style={{ fontSize: 10, fontWeight: 600, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0, lineHeight: 1.3 }}>
                    {label}
                  </p>
                  <Icon size={13} color="var(--brand)" style={{ flexShrink: 0 }} />
                </div>
                <p style={{ fontSize: 24, fontWeight: 700, color: '#F0EDE8', margin: '0 0 4px' }}>{value}</p>
                {sub && (
                  <p style={{ fontSize: 11, color: subColor || '#7A7873', margin: 0 }}>{sub}</p>
                )}
              </div>
            ))}
          </div>

          {/* Revenue chart */}
          <div style={{ ...CARD, padding: 16 }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: '#F0EDE8', margin: '0 0 2px' }}>Revenue Trend</p>
            <p style={{ fontSize: 12, color: '#7A7873', margin: '0 0 16px' }}>7-day rolling volume</p>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={mockChartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="brandGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="var(--brand)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--brand)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1A1A1A" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#4A4845', fontFamily: "'Plus Jakarta Sans'" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#4A4845', fontFamily: "'Plus Jakarta Sans'" }} axisLine={false} tickLine={false} tickFormatter={v => `$${v / 1000}k`} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="revenue" stroke="var(--brand)" strokeWidth={2} fill="url(#brandGrad)" dot={false} activeDot={{ r: 4, fill: 'var(--brand)', strokeWidth: 0 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Today's jobs */}
          <div style={{ ...CARD, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <p style={{ fontSize: 15, fontWeight: 600, color: '#F0EDE8', margin: 0 }}>Today's Jobs</p>
              <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brand)', fontSize: 12, fontWeight: 600, fontFamily: "'Plus Jakarta Sans', sans-serif", display: 'flex', alignItems: 'center', gap: 2, padding: 0 }}>
                View all <ChevronRight size={13} />
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {recentJobs.length > 0 ? recentJobs.map((job, i) => (
                <div key={job.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '11px 0',
                  borderBottom: i < recentJobs.length - 1 ? '1px solid #222222' : 'none',
                }}>
                  <div style={{ flex: 1, minWidth: 0, marginRight: 10 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, color: '#F0EDE8', margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {job.client_name}
                    </p>
                    <p style={{ fontSize: 11, color: '#7A7873', margin: 0 }}>
                      {job.service_type?.replace(/_/g, ' ')} · {job.scheduled_time || 'Anytime'}
                    </p>
                  </div>
                  <StatusBadge status={job.status as any} />
                </div>
              )) : (
                <p style={{ fontSize: 13, color: '#7A7873', textAlign: 'center', padding: '24px 0', margin: 0 }}>No jobs today</p>
              )}
            </div>
          </div>

          {/* Top employees */}
          <div style={{ ...CARD, padding: 16, marginBottom: 4 }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: '#F0EDE8', margin: '0 0 12px' }}>Top Employees</p>
            {topEmployees.length > 0 ? topEmployees.map((emp, i) => (
              <div key={emp.user_id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 0',
                borderBottom: i < topEmployees.length - 1 ? '1px solid #222222' : 'none',
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: '50%',
                  backgroundColor: 'var(--brand-dim)', border: '1px solid var(--brand-soft)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, fontSize: 12, fontWeight: 700, color: 'var(--brand)',
                }}>
                  {emp.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 500, color: '#F0EDE8', margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {emp.name}
                  </p>
                  <p style={{ fontSize: 11, color: '#7A7873', margin: 0 }}>{emp.jobs_completed} jobs</p>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <p style={{ fontSize: 15, fontWeight: 700, color: '#F0EDE8', margin: '0 0 1px' }}>
                    {typeof emp.avg_score === 'number' ? emp.avg_score.toFixed(1) : '—'}
                  </p>
                  <p style={{ fontSize: 10, color: '#4A4845', margin: 0 }}>score</p>
                </div>
              </div>
            )) : (
              <p style={{ fontSize: 13, color: '#7A7873', textAlign: 'center', padding: '24px 0', margin: 0 }}>No data available</p>
            )}
          </div>

        </div>
      </DashboardLayout>
    );
  }

  // ── DESKTOP LAYOUT ──────────────────────────────────────────────────
  const S = {
    label: {
      fontSize: '11px', fontWeight: 500, color: '#4A4845',
      textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0,
    } as React.CSSProperties,
    value: {
      fontSize: '22px', fontWeight: 700, color: '#F0EDE8',
      marginTop: '12px', marginBottom: '4px',
    } as React.CSSProperties,
    sub: {
      fontSize: '12px', fontWeight: 400, color: '#7A7873', margin: 0,
    } as React.CSSProperties,
    th: {
      padding: '12px 20px', textAlign: 'left' as const,
      fontSize: '11px', fontWeight: 500, color: '#4A4845',
      textTransform: 'uppercase' as const, letterSpacing: '0.06em',
      borderBottom: '1px solid #1A1A1A',
    } as React.CSSProperties,
  };

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* 4-column metric cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
          {metrics.map(({ label, value, sub, subColor, icon: Icon }) => (
            <div
              key={label}
              style={{ ...CARD, padding: '20px', position: 'relative', transition: 'border-color 0.2s', cursor: 'default' }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(var(--brand-rgb), 0.4)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = '#222222')}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <p style={S.label}>{label}</p>
                <Icon size={18} style={{ color: 'var(--brand)', opacity: 0.5, position: 'absolute', top: '20px', right: '20px' }} strokeWidth={1.5} />
              </div>
              <p style={S.value}>{value}</p>
              <p style={{ ...S.sub, color: subColor || '#7A7873' }}>{sub}</p>
            </div>
          ))}
        </div>

        {/* Revenue chart */}
        <div style={{ ...CARD, padding: '24px' }}>
          <p style={{ fontSize: '15px', fontWeight: 600, color: '#F0EDE8', margin: 0 }}>Revenue Trend</p>
          <p style={{ fontSize: '12px', color: '#7A7873', margin: '2px 0 20px 0' }}>7 day rolling volume</p>
          <div style={{ height: '220px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={mockChartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="var(--brand)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1A1A" vertical={false} />
                <XAxis dataKey="name" stroke="transparent" tick={{ fill: '#4A4845', fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis stroke="transparent" tick={{ fill: '#4A4845', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={v => `$${v}`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1C1C1C', border: '1px solid #333', borderRadius: '6px', fontSize: '12px', color: '#F0EDE8' }}
                  itemStyle={{ color: 'var(--brand)' }}
                  labelStyle={{ color: '#7A7873' }}
                  cursor={{ stroke: '#333', strokeWidth: 1 }}
                />
                <Area type="monotone" dataKey="revenue" stroke="var(--brand)" strokeWidth={2} fill="url(#revGrad)" dot={false} activeDot={{ r: 5, fill: 'var(--brand)', stroke: '#fff', strokeWidth: 2 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Two-column: Jobs + Top Employees */}
        <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: '20px' }}>
          {/* Recent Jobs table */}
          <div style={{ ...CARD, overflow: 'hidden' }}>
            <div style={{ padding: '20px 20px 0' }}>
              <p style={{ fontSize: '15px', fontWeight: 600, color: '#F0EDE8', margin: 0 }}>Recent & Upcoming Jobs</p>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '12px' }}>
              <thead>
                <tr>
                  {['Client', 'Date & Time', 'Service', 'Assigned', 'Status'].map(h => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data?.recent_jobs?.slice(0, 6).map(job => (
                  <tr
                    key={job.id}
                    style={{ borderBottom: '1px solid #0F0F0F', cursor: 'default' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#1C1C1C')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <td style={{ padding: '12px 20px', fontSize: '13px', fontWeight: 600, color: '#F0EDE8' }}>{job.client_name}</td>
                    <td style={{ padding: '12px 20px' }}>
                      <p style={{ fontSize: '12px', color: '#7A7873', margin: 0 }}>{new Date(job.scheduled_date).toLocaleDateString()}</p>
                      <p style={{ fontSize: '12px', color: '#7A7873', margin: 0 }}>{job.scheduled_time || 'Anytime'}</p>
                    </td>
                    <td style={{ padding: '12px 20px', fontSize: '12px', color: '#7A7873', textTransform: 'capitalize' }}>{job.service_type?.replace(/_/g, ' ')}</td>
                    <td style={{ padding: '12px 20px', fontSize: '12px', color: '#7A7873' }}>{job.assigned_user_name || 'Unassigned'}</td>
                    <td style={{ padding: '12px 20px' }}><StatusBadge status={job.status as any} /></td>
                  </tr>
                )) || (
                  <tr><td colSpan={5} style={{ padding: '32px 20px', textAlign: 'center', fontSize: '13px', color: '#7A7873' }}>No recent jobs</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Top Employees */}
          <div style={CARD}>
            <p style={{ fontSize: '15px', fontWeight: 600, color: '#F0EDE8', padding: '20px', margin: 0 }}>Top Employees</p>
            {data?.top_employees?.length ? data.top_employees.slice(0, 6).map((emp, i) => (
              <div
                key={emp.user_id}
                style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 20px', borderBottom: '1px solid #0F0F0F', cursor: 'default' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#1C1C1C')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--brand)', width: '20px', flexShrink: 0 }}>{i + 1}</span>
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', backgroundColor: 'var(--brand-dim)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 600, flexShrink: 0 }}>
                  {emp.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '13px', fontWeight: 600, color: '#F0EDE8', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp.name}</p>
                  <p style={{ fontSize: '12px', color: '#7A7873', margin: 0 }}>{emp.jobs_completed} jobs</p>
                </div>
              </div>
            )) : (
              <p style={{ padding: '32px 20px', textAlign: 'center', fontSize: '13px', color: '#7A7873' }}>No data available</p>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
