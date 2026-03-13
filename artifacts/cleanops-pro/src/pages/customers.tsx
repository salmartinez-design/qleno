import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useListClients } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { Plus, Search, Phone, Mail, MapPin } from "lucide-react";

export default function CustomersPage() {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const { data, isLoading } = useListClients({}, { request: { headers: getAuthHeaders() } });

  const clients = (data?.data || []).filter(c =>
    !search || `${c.first_name} ${c.last_name}`.toLowerCase().includes(search.toLowerCase())
  );

  const toggleSelect = (id: number) =>
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const TH: React.CSSProperties = {
    padding: '12px 16px', textAlign: 'left',
    fontSize: '11px', fontWeight: 500, color: '#4A4845',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    borderBottom: '1px solid #1A1A1A',
  };

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Controls */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <div style={{ position: 'relative' }}>
              <Search size={14} strokeWidth={1.5} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#4A4845', pointerEvents: 'none' }} />
              <input
                placeholder="Search clients..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ paddingLeft: '36px', paddingRight: '12px', height: '36px', width: '280px', backgroundColor: '#1A1A1A', border: '1px solid #2A2A2A', borderRadius: '8px', color: '#F0EDE8', fontSize: '13px', outline: 'none' }}
              />
            </div>
            {selected.length > 0 && (
              <button style={{ padding: '7px 14px', border: '1px solid #222222', borderRadius: '8px', backgroundColor: 'transparent', color: '#7A7873', fontSize: '13px', cursor: 'pointer' }}>
                Batch Actions ({selected.length})
              </button>
            )}
          </div>
          <button style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', backgroundColor: 'var(--brand)', color: '#0A0A0A', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer' }}>
            <Plus size={14} strokeWidth={2} /> Add Client
          </button>
        </div>

        {/* Table */}
        <div style={{ backgroundColor: '#161616', border: '1px solid #222222', borderRadius: '10px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...TH, width: '44px' }}></th>
                {['Client Info', 'Contact', 'Address', 'Loyalty', 'Status'].map(h => (
                  <th key={h} style={{ ...TH, textAlign: h === 'Loyalty' ? 'center' as const : 'left' as const }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#7A7873', fontSize: '13px' }}>Loading clients...</td></tr>
              ) : clients.map(client => {
                const isSelected = selected.includes(client.id);
                const rewardReady = client.loyalty_points > 100;
                return (
                  <tr
                    key={client.id}
                    style={{ borderBottom: '1px solid #0F0F0F', backgroundColor: isSelected ? 'rgba(var(--brand-rgb), 0.06)' : 'transparent', cursor: 'default' }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.backgroundColor = '#1C1C1C'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent'; }}
                  >
                    <td style={{ padding: '14px 16px' }}>
                      <button
                        onClick={() => toggleSelect(client.id)}
                        style={{ width: '16px', height: '16px', borderRadius: '50%', border: `1px solid ${isSelected ? 'var(--brand)' : '#333'}`, backgroundColor: isSelected ? 'var(--brand)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      >
                        {isSelected && <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#0A0A0A' }} />}
                      </button>
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <p style={{ fontSize: '13px', fontWeight: 600, color: '#F0EDE8', margin: 0 }}>{client.first_name} {client.last_name}</p>
                      <p style={{ fontSize: '11px', color: '#4A4845', margin: 0 }}>CL-{client.id.toString().padStart(4, '0')}</p>
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        {client.phone && <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#7A7873' }}><Phone size={11} strokeWidth={1.5} />{client.phone}</div>}
                        {client.email && <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#7A7873' }}><Mail size={11} strokeWidth={1.5} />{client.email}</div>}
                      </div>
                    </td>
                    <td style={{ padding: '14px 16px', maxWidth: '180px' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', color: '#7A7873', fontSize: '12px' }}>
                        <MapPin size={12} strokeWidth={1.5} style={{ marginTop: '2px', flexShrink: 0 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{client.address || 'No address'}, {client.city}</span>
                      </div>
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                        <div style={{ width: '44px', height: '44px', borderRadius: '50%', backgroundColor: 'var(--brand-dim)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1px' }}>
                          <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--brand)', lineHeight: 1 }}>{client.loyalty_points}</span>
                          <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--brand)', letterSpacing: '0.05em', lineHeight: 1 }}>PTS</span>
                        </div>
                        {rewardReady && (
                          <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--brand)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Reward Ready</span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <span style={{ background: '#0F2A1A', color: '#4ADE80', border: '1px solid #166534', display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Active</span>
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
