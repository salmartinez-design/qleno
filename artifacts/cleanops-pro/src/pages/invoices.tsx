import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useListInvoices, ListInvoicesStatus } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { Plus, Search, Send, Download } from "lucide-react";

const STATUS_STYLES: Record<string, React.CSSProperties> = {
  paid:    { background: '#0F2A1A', color: '#4ADE80', border: '1px solid #166534' },
  overdue: { background: '#2A0F0F', color: '#F87171', border: '1px solid #991B1B' },
  draft:   { background: '#1A1A1A', color: '#7A7873', border: '1px solid #333' },
  sent:    { background: '#0F1E2A', color: '#60A5FA', border: '1px solid #1D4ED8' },
};

type TabId = ListInvoicesStatus | 'all';

export default function InvoicesPage() {
  const [activeTab, setActiveTab] = useState<TabId>('all');
  const [search, setSearch] = useState('');

  const { data, isLoading } = useListInvoices(
    activeTab !== 'all' ? { status: activeTab } : {},
    { request: { headers: getAuthHeaders() } }
  );

  const tabs: { id: TabId; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'draft', label: 'Drafts' },
    { id: 'sent', label: 'Sent' },
    { id: 'paid', label: 'Paid' },
    { id: 'overdue', label: 'Overdue' },
  ];

  const invoices = (data?.data || []).filter(i =>
    !search || i.client_name?.toLowerCase().includes(search.toLowerCase())
  );

  const TH: React.CSSProperties = {
    padding: '12px 20px', textAlign: 'left',
    fontSize: '11px', fontWeight: 500, color: '#4A4845',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    borderBottom: '1px solid #1A1A1A',
  };

  const CARD: React.CSSProperties = {
    backgroundColor: '#161616', border: '1px solid #222222',
    borderRadius: '10px', padding: '20px',
  };

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Stat Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
          {[
            { label: 'Total Outstanding', value: `$${(data?.stats?.total_outstanding || 0).toLocaleString()}` },
            { label: 'Total Overdue',     value: `$${(data?.stats?.total_overdue || 0).toLocaleString()}`,     color: '#F87171' },
            { label: 'Paid (Last 30D)',   value: `$${(data?.stats?.total_paid || 0).toLocaleString()}`,        color: '#4ADE80' },
            { label: 'Total Revenue (YTD)', value: `$${(data?.stats?.total_revenue || 0).toLocaleString()}`,  accent: true },
          ].map(c => (
            <div key={c.label} style={{ ...CARD, border: c.accent ? '1px solid rgba(var(--brand-rgb), 0.5)' : '1px solid #222222', transition: 'border-color 0.2s' }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = c.accent ? 'var(--brand)' : 'rgba(var(--brand-rgb), 0.4)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = c.accent ? 'rgba(var(--brand-rgb), 0.5)' : '#222222')}
            >
              <p style={{ fontSize: '11px', fontWeight: 500, color: c.accent ? 'var(--brand)' : '#4A4845', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px 0' }}>{c.label}</p>
              <p style={{ fontSize: '22px', fontWeight: 700, color: c.color || (c.accent ? 'var(--brand)' : '#F0EDE8'), margin: 0 }}>{c.value}</p>
            </div>
          ))}
        </div>

        {/* Table Card */}
        <div style={{ backgroundColor: '#161616', border: '1px solid #222222', borderRadius: '10px', overflow: 'hidden' }}>
          {/* Toolbar */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid #1A1A1A', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '4px', backgroundColor: '#111111', border: '1px solid #222222', borderRadius: '8px', padding: '4px' }}>
              {tabs.map(tab => {
                const isActive = activeTab === tab.id;
                return (
                  <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ padding: '5px 14px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: isActive ? 600 : 400, border: 'none', backgroundColor: isActive ? 'var(--brand)' : 'transparent', color: isActive ? '#0A0A0A' : '#7A7873', transition: 'all 0.15s' }}>
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <div style={{ position: 'relative' }}>
                <Search size={14} strokeWidth={1.5} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#4A4845', pointerEvents: 'none' }} />
                <input placeholder="Search invoice or client..." value={search} onChange={e => setSearch(e.target.value)}
                  style={{ paddingLeft: '36px', paddingRight: '12px', height: '36px', width: '220px', backgroundColor: '#1A1A1A', border: '1px solid #2A2A2A', borderRadius: '8px', color: '#F0EDE8', fontSize: '13px', outline: 'none' }} />
              </div>
              <button style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', backgroundColor: 'var(--brand)', color: '#0A0A0A', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer' }}>
                <Plus size={14} strokeWidth={2} /> Create
              </button>
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Invoice #', 'Client', 'Amount', 'Date', 'Status', ''].map(h => (
                  <th key={h} style={{ ...TH, textAlign: h === '' ? 'right' as const : 'left' as const }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#7A7873', fontSize: '13px' }}>Loading invoices...</td></tr>
              ) : invoices.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: '#7A7873', fontSize: '13px' }}>No invoices found.</td></tr>
              ) : invoices.map(inv => {
                const s = STATUS_STYLES[inv.status] || STATUS_STYLES.draft;
                return (
                  <tr key={inv.id} style={{ borderBottom: '1px solid #0F0F0F', cursor: 'default' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#1C1C1C')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <td style={{ padding: '14px 20px', fontSize: '13px', fontWeight: 500, color: '#F0EDE8' }}>INV-{inv.id.toString().padStart(4, '0')}</td>
                    <td style={{ padding: '14px 20px', fontSize: '13px', fontWeight: 600, color: '#F0EDE8' }}>{inv.client_name}</td>
                    <td style={{ padding: '14px 20px', fontSize: '22px', fontWeight: 700, color: '#F0EDE8' }}>${inv.total.toFixed(2)}</td>
                    <td style={{ padding: '14px 20px', fontSize: '12px', color: '#7A7873' }}>{new Date(inv.created_at).toLocaleDateString()}</td>
                    <td style={{ padding: '14px 20px' }}>
                      <span style={{ ...s, display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                        {inv.status}
                      </span>
                    </td>
                    <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        {inv.status === 'draft' && (
                          <button style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '5px 12px', border: '1px solid #222222', borderRadius: '6px', backgroundColor: 'transparent', color: '#7A7873', fontSize: '12px', cursor: 'pointer' }}>
                            <Send size={12} strokeWidth={1.5} /> Send
                          </button>
                        )}
                        <button style={{ padding: '5px', border: 'none', backgroundColor: 'transparent', color: '#4A4845', cursor: 'pointer', borderRadius: '4px' }}
                          onMouseEnter={e => (e.currentTarget.style.color = 'var(--brand)')}
                          onMouseLeave={e => (e.currentTarget.style.color = '#4A4845')}
                        >
                          <Download size={15} strokeWidth={1.5} />
                        </button>
                      </div>
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
