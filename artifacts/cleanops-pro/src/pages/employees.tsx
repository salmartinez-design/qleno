import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useListUsers } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { Plus, Search, MoreHorizontal } from "lucide-react";

const ROLE_BADGES: Record<string, React.CSSProperties> = {
  owner:       { background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid rgba(var(--brand-rgb),0.3)' },
  admin:       { background: '#1A1227', color: '#A78BFA', border: '1px solid #5B21B6' },
  technician:  { background: '#0F2A1A', color: '#4ADE80', border: '1px solid #166534' },
  office:      { background: '#2A1F0A', color: '#FBBF24', border: '1px solid #92400E' },
  super_admin: { background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid rgba(var(--brand-rgb),0.3)' },
};

function ProductivityRing({ pct }: { pct: number }) {
  const r = 16;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <div style={{ position: 'relative', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width="36" height="36" style={{ transform: 'rotate(-90deg)', position: 'absolute' }}>
        <circle cx="18" cy="18" r={r} fill="none" stroke="#222222" strokeWidth={4} />
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--brand)" strokeWidth={4}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--brand)', position: 'relative', zIndex: 1 }}>{pct}%</span>
    </div>
  );
}

export default function EmployeesPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useListUsers({}, { request: { headers: getAuthHeaders() } });

  const employees = (data?.data || []).filter(u =>
    !search || `${u.first_name} ${u.last_name}`.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Controls */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} strokeWidth={1.5} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#4A4845', pointerEvents: 'none' }} />
            <input
              placeholder="Search team..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: '36px', paddingRight: '12px', height: '36px', width: '260px', backgroundColor: '#1A1A1A', border: '1px solid #2A2A2A', borderRadius: '8px', color: '#F0EDE8', fontSize: '13px', outline: 'none' }}
            />
          </div>
          <button style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', backgroundColor: 'var(--brand)', color: '#0A0A0A', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer' }}>
            <Plus size={14} strokeWidth={2} /> Add Team Member
          </button>
        </div>

        {/* Table */}
        <div style={{ backgroundColor: '#161616', border: '1px solid #222222', borderRadius: '10px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1A1A1A' }}>
                {['Employee', 'Role', 'Pay Structure', 'Productivity', 'Score', ''].map(h => (
                  <th key={h} style={{
                    padding: '12px 20px',
                    textAlign: (h === 'Productivity' || h === 'Score') ? 'center' : 'left',
                    fontSize: '11px', fontWeight: 500, color: '#4A4845',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                  } as React.CSSProperties}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#7A7873', fontSize: '13px' }}>Loading employees...</td></tr>
              ) : employees.map(user => {
                const roleBadge = ROLE_BADGES[user.role] || ROLE_BADGES.technician;
                const productivity = (user as any).productivity_pct || 85;
                return (
                  <tr
                    key={user.id}
                    style={{ borderBottom: '1px solid #0F0F0F', cursor: 'default' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#1C1C1C')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <td style={{ padding: '14px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: 'var(--brand-dim)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 600, flexShrink: 0 }}>
                          {user.first_name[0]}{user.last_name[0]}
                        </div>
                        <div>
                          <p style={{ fontSize: '13px', fontWeight: 600, color: '#F0EDE8', margin: 0 }}>{user.first_name} {user.last_name}</p>
                          <p style={{ fontSize: '12px', color: '#7A7873', margin: 0 }}>{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px' }}>
                      <span style={{ ...roleBadge, display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                        {user.role.replace('_', ' ')}
                      </span>
                    </td>
                    <td style={{ padding: '14px 20px' }}>
                      <p style={{ fontSize: '13px', fontWeight: 500, color: '#F0EDE8', margin: 0 }}>${user.pay_rate}/hr</p>
                      <p style={{ fontSize: '12px', color: '#7A7873', margin: 0, textTransform: 'capitalize' }}>{user.pay_type?.replace('_', ' ')}</p>
                    </td>
                    <td style={{ padding: '14px 20px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', justifyContent: 'center' }}>
                        <ProductivityRing pct={productivity} />
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px', textAlign: 'center' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--brand)" stroke="none">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                        <span style={{ fontSize: '13px', fontWeight: 500, color: '#F0EDE8' }}>3.9</span>
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                      <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4A4845', padding: '4px' }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#F0EDE8')}
                        onMouseLeave={e => (e.currentTarget.style.color = '#4A4845')}
                      >
                        <MoreHorizontal size={16} strokeWidth={1.5} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  );
}
