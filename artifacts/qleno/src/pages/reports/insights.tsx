import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { TrendingUp, Users, Heart, Star, AlertTriangle, ChevronRight } from "lucide-react";
import { useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const SERVICE_LABELS: Record<string, string> = {
  standard_clean: 'Standard Clean', deep_clean: 'Deep Clean',
  move_out: 'Move Out Clean', recurring: 'Recurring', post_construction: 'Post-Construction',
  office_cleaning: 'Office Cleaning', move_in: 'Move In', common_areas: 'Common Areas',
};

function Avatar({ user }: { user: any }) {
  if (user.avatar_url) return <img src={user.avatar_url} style={{ width: 40, height: 40, borderRadius: 20, objectFit: 'cover' }}/>;
  return (
    <div style={{ width: 40, height: 40, borderRadius: 20, background: '#EBF4FF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#5B9BD5' }}>
      {user.first_name?.[0]}{user.last_name?.[0]}
    </div>
  );
}

function StarRow({ score }: { score: number }) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {[1, 2, 3, 4].map(i => (
        <svg key={i} width={12} height={12} viewBox="0 0 24 24"
          fill={score >= i ? '#F59E0B' : 'none'} stroke={score >= i ? '#F59E0B' : '#D1D5DB'} strokeWidth={1.5}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      ))}
    </div>
  );
}

const CARD: React.CSSProperties = { background: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: 12 };

function useIsMobile() {
  const [m, setM] = useState(typeof window !== "undefined" && window.innerWidth < 640);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 640);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return m;
}

export default function InsightsPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [, navigate] = useLocation();
  const isMobile = useIsMobile();

  useEffect(() => {
    fetch(`${API}/api/reports/insights`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <DashboardLayout title="Performance Insights">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
          <div style={{ width: 28, height: 28, border: '2px solid #E5E2DC', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }}/>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </DashboardLayout>
    );
  }

  const topPerformers = data?.top_performers?.slice(0, 3) || [];
  const concerns = data?.concerns || [];
  const clientHealth = data?.client_health || [];
  const revenueByService = data?.revenue_by_service || [];
  const maxRevenue = Math.max(...revenueByService.map((r: any) => r.total_revenue), 1);

  return (
    <DashboardLayout title="Performance Insights">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: "'Plus Jakarta Sans', sans-serif", overflowX: 'hidden' }}>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 12 }}>
          <div style={{ ...CARD, padding: '14px 18px' }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>Avg Job Value</p>
            <p style={{ fontSize: 28, fontWeight: 700, color: '#1A1917', margin: 0 }}>${(data?.avg_job_value || 0).toFixed(0)}</p>
            <p style={{ fontSize: 11, color: '#6B7280', margin: '2px 0 0' }}>Last 30 days</p>
          </div>
          <div style={{ ...CARD, padding: '14px 18px' }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>Projected Revenue</p>
            <p style={{ fontSize: 28, fontWeight: 700, color: '#1A1917', margin: 0 }}>${(data?.projected_revenue || 0).toFixed(0)}</p>
            <p style={{ fontSize: 11, color: '#6B7280', margin: '2px 0 0' }}>From scheduled jobs</p>
          </div>
          <div style={{ ...CARD, padding: '14px 18px' }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>Concern Flags</p>
            <p style={{ fontSize: 28, fontWeight: 700, color: concerns.length > 0 ? '#DC2626' : '#1A1917', margin: 0 }}>{concerns.length}</p>
            <p style={{ fontSize: 11, color: '#6B7280', margin: '2px 0 0' }}>Employees needing attention</p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>

          {/* TOP PERFORMERS */}
          <div style={{ ...CARD, padding: '20px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
              <Star size={16} color="#F59E0B" fill="#FEF3C7"/>
              <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: 0 }}>Top Performers This Week</p>
            </div>
            {topPerformers.length === 0 && <p style={{ fontSize: 12, color: '#9E9B94', textAlign: 'center', padding: '20px 0' }}>No scorecard data yet</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {topPerformers.map((p: any, i: number) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 24, height: 24, borderRadius: 12, background: i === 0 ? '#FEF3C7' : i === 1 ? '#F3F4F6' : '#FDF4E7', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: i === 0 ? '#B45309' : i === 1 ? '#6B7280' : '#92400E' }}>{i + 1}</span>
                  </div>
                  <Avatar user={p}/>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 13, fontWeight: 600, color: '#1A1917', margin: '0 0 3px 0' }}>{p.first_name} {p.last_name}</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {p.avg_score && <StarRow score={Math.round(p.avg_score)}/>}
                      <span style={{ fontSize: 11, color: '#6B7280' }}>{p.jobs_completed} job{p.jobs_completed !== 1 ? 's' : ''}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => navigate(`/employees/${p.id}`)}
                    style={{ fontSize: 11, fontWeight: 600, color: 'var(--brand, #5B9BD5)', background: 'var(--brand-dim, #EBF4FF)', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>
                    Profile
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* CONCERN ALERTS */}
          <div style={{ ...CARD, padding: '20px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
              <AlertTriangle size={16} color="#DC2626"/>
              <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: 0 }}>Employees Needing Attention</p>
            </div>
            {concerns.length === 0 && (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <p style={{ fontSize: 12, color: '#6B7280', margin: 0 }}>All employees are performing well.</p>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {concerns.map((c: any) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', background: '#FFF7F0', borderRadius: 8, border: '1px solid #FED7AA' }}>
                  <Avatar user={c}/>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 13, fontWeight: 600, color: '#1A1917', margin: '0 0 4px' }}>{c.first_name} {c.last_name}</p>
                    {c.concerns.map((flag: string, j: number) => (
                      <p key={j} style={{ fontSize: 11, color: '#92400E', margin: '0 0 2px 0' }}>{flag}</p>
                    ))}
                  </div>
                  <button onClick={() => navigate(`/employees/${c.id}`)}
                    style={{ fontSize: 11, fontWeight: 600, color: '#92400E', background: '#FEF3C7', border: 'none', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>
                    Review
                  </button>
                </div>
              ))}
            </div>
          </div>

        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>

          {/* CLIENT HEALTH */}
          <div style={{ ...CARD, padding: '20px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
              <Heart size={16} color="#EF4444"/>
              <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: 0 }}>Clients at Risk of Churning</p>
            </div>
            {clientHealth.length === 0 && <p style={{ fontSize: 12, color: '#9E9B94', textAlign: 'center', padding: '20px 0' }}>All clients are booking regularly.</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {clientHealth.map((c: any) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: '#FFF1F2', borderRadius: 8, border: '1px solid #FECDD3' }}>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 600, color: '#1A1917', margin: '0 0 3px 0' }}>{c.first_name} {c.last_name}</p>
                    <p style={{ fontSize: 11, color: '#9F1239', margin: 0 }}>{c.reason}</p>
                  </div>
                  <button onClick={() => navigate('/customers')}
                    style={{ fontSize: 11, fontWeight: 600, color: '#9F1239', background: '#FFE4E6', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>
                    Win Back
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* REVENUE BY SERVICE */}
          <div style={{ ...CARD, padding: '20px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
              <TrendingUp size={16} color="#16A34A"/>
              <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: 0 }}>Revenue by Service Type</p>
              <span style={{ fontSize: 10, color: '#9E9B94', marginLeft: 'auto' }}>Last 30 days</span>
            </div>
            {revenueByService.length === 0 && <p style={{ fontSize: 12, color: '#9E9B94', textAlign: 'center', padding: '20px 0' }}>No completed jobs yet</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {revenueByService.slice(0, 6).map((r: any) => (
                <div key={r.service_type}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: '#1A1917', fontWeight: 500 }}>{SERVICE_LABELS[r.service_type] || r.service_type}</span>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <span style={{ fontSize: 11, color: '#9E9B94' }}>{r.job_count} jobs</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#1A1917' }}>${r.total_revenue.toFixed(0)}</span>
                    </div>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: '#F3F4F6', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(r.total_revenue / maxRevenue) * 100}%`, background: 'var(--brand, #5B9BD5)', borderRadius: 3 }}/>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

      </div>
    </DashboardLayout>
  );
}
