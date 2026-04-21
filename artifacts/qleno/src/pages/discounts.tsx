import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useToast } from "@/hooks/use-toast";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Tag, Copy, Trash2, ToggleLeft, ToggleRight } from "lucide-react";

interface Discount {
  id: number;
  name: string;
  code: string;
  type: "percentage" | "flat_amount" | "free_service";
  value: string;
  scope: "all_clients" | "specific_clients" | "new_clients";
  max_uses: number | null;
  uses_count: number;
  active: boolean;
  expires_at: string | null;
  created_at: string;
}

function discountLabel(d: Discount): string {
  if (d.type === "percentage") return `${parseFloat(d.value).toFixed(0)}% off`;
  if (d.type === "flat_amount") return `$${parseFloat(d.value).toFixed(2)} off`;
  return "Free service";
}

function scopeLabel(s: string): string {
  if (s === "all_clients") return "All clients";
  if (s === "new_clients") return "New clients only";
  return "Specific clients";
}

const CARD: React.CSSProperties = {
  backgroundColor: '#FFFFFF',
  border: '1px solid #E5E2DC',
  borderRadius: '10px',
};

interface NewDiscountForm {
  name: string;
  code: string;
  type: "percentage" | "flat_amount" | "free_service";
  value: string;
  scope: "all_clients" | "specific_clients" | "new_clients";
  max_uses: string;
  expires_at: string;
}

const DEFAULT_FORM: NewDiscountForm = {
  name: '', code: '', type: 'percentage', value: '10',
  scope: 'all_clients', max_uses: '', expires_at: '',
};

const LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: '#9E9B94',
  textTransform: 'uppercase', letterSpacing: '0.06em',
  display: 'block', marginBottom: '6px',
};

const INP: React.CSSProperties = {
  width: '100%', height: '38px', backgroundColor: '#F7F6F3',
  border: '1px solid #DEDAD4', borderRadius: '8px',
  color: '#1A1917', fontSize: '13px', padding: '0 12px',
  fontFamily: "'Plus Jakarta Sans', sans-serif", outline: 'none',
};

export default function DiscountsPage() {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<NewDiscountForm>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: discounts = [], isLoading } = useQuery<Discount[]>({
    queryKey: ['/api/discounts'],
    queryFn: async () => {
      const res = await fetch('/api/discounts', { headers: getAuthHeaders() });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const handleCreate = async () => {
    if (!form.name.trim() || !form.code.trim()) {
      toast({ variant: 'destructive', title: 'Name and code are required.' });
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, any> = {
        name: form.name,
        code: form.code.toUpperCase(),
        type: form.type,
        value: parseFloat(form.value) || 0,
        scope: form.scope,
      };
      if (form.max_uses) body.max_uses = parseInt(form.max_uses);
      if (form.expires_at) body.expires_at = new Date(form.expires_at).toISOString();

      const res = await fetch('/api/discounts', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create');
      }
      toast({ title: 'Discount created', description: `Code: ${form.code.toUpperCase()}` });
      setForm(DEFAULT_FORM);
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ['/api/discounts'] });
    } catch (e: any) {
      toast({ variant: 'destructive', title: e.message || 'Failed to create discount' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`Delete discount "${name}"?`)) return;
    try {
      await fetch(`/api/discounts/${id}`, { method: 'DELETE', headers: getAuthHeaders() });
      toast({ title: 'Discount deleted' });
      queryClient.invalidateQueries({ queryKey: ['/api/discounts'] });
    } catch {
      toast({ variant: 'destructive', title: 'Failed to delete discount' });
    }
  };

  const handleToggle = async (d: Discount) => {
    try {
      const res = await fetch(`/api/discounts/${d.id}`, {
        method: 'PATCH',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !d.active }),
      });
      if (!res.ok) throw new Error();
      queryClient.invalidateQueries({ queryKey: ['/api/discounts'] });
    } catch {
      toast({ variant: 'destructive', title: 'Failed to update discount' });
    }
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    toast({ title: `Copied: ${code}` });
  };

  const autoCode = (name: string) =>
    name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12);

  const activeCount  = discounts.filter(d => d.active).length;
  const totalUses    = discounts.reduce((s, d) => s + d.uses_count, 0);

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '42px', color: '#1A1917', margin: 0, lineHeight: 1.1 }}>Discounts</h1>
            <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '13px', color: '#6B7280', marginTop: '6px' }}>Create and manage promo codes and discount rules.</p>
          </div>
          <button
            onClick={() => setShowForm(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 18px', backgroundColor: 'var(--brand)', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer' }}
          >
            <Plus size={14} strokeWidth={2} />
            New Discount
          </button>
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
          {[
            { label: 'Total Discounts', value: discounts.length },
            { label: 'Active', value: activeCount, color: '#16A34A' },
            { label: 'Total Uses', value: totalUses },
          ].map(c => (
            <div key={c.label} style={CARD}>
              <div style={{ padding: '20px' }}>
                <p style={{ fontSize: '11px', fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>{c.label}</p>
                <p style={{ fontSize: '22px', fontWeight: 700, color: c.color || '#1A1917', margin: 0 }}>{c.value}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Create form (expandable) */}
        {showForm && (
          <div style={{ ...CARD, padding: '24px' }}>
            <p style={{ fontSize: '15px', fontWeight: 600, color: '#1A1917', margin: '0 0 20px' }}>Create New Discount</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '14px' }}>
              <div>
                <label style={LABEL}>Name</label>
                <input
                  style={INP}
                  placeholder="Summer Deal"
                  value={form.name}
                  onChange={e => {
                    const n = e.target.value;
                    setForm(f => ({ ...f, name: n, code: f.code || autoCode(n) }));
                  }}
                />
              </div>
              <div>
                <label style={LABEL}>Promo Code</label>
                <input
                  style={INP}
                  placeholder="SUMMER10"
                  value={form.code}
                  onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                />
              </div>
              <div>
                <label style={LABEL}>Type</label>
                <select style={INP} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))}>
                  <option value="percentage">Percentage (%)</option>
                  <option value="flat_amount">Flat Amount ($)</option>
                  <option value="free_service">Free Service</option>
                </select>
              </div>
              {form.type !== 'free_service' && (
                <div>
                  <label style={LABEL}>Value {form.type === 'percentage' ? '(%)' : '($)'}</label>
                  <input style={INP} type="number" min="0" value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} />
                </div>
              )}
              <div>
                <label style={LABEL}>Scope</label>
                <select style={INP} value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value as any }))}>
                  <option value="all_clients">All Clients</option>
                  <option value="new_clients">New Clients Only</option>
                  <option value="specific_clients">Specific Clients</option>
                </select>
              </div>
              <div>
                <label style={LABEL}>Max Uses (optional)</label>
                <input style={INP} type="number" min="1" placeholder="Unlimited" value={form.max_uses} onChange={e => setForm(f => ({ ...f, max_uses: e.target.value }))} />
              </div>
              <div>
                <label style={LABEL}>Expiry Date (optional)</label>
                <input style={INP} type="date" value={form.expires_at} onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
              <button onClick={() => { setShowForm(false); setForm(DEFAULT_FORM); }} style={{ padding: '9px 18px', border: '1px solid #E5E2DC', borderRadius: '8px', backgroundColor: 'transparent', color: '#6B7280', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleCreate} disabled={saving} style={{ padding: '9px 24px', backgroundColor: 'var(--brand)', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Creating...' : 'Create Discount'}
              </button>
            </div>
          </div>
        )}

        {/* Discounts list */}
        <div style={CARD}>
          {isLoading ? (
            <div style={{ padding: '48px', textAlign: 'center', color: '#6B7280', fontSize: '13px' }}>Loading discounts...</div>
          ) : discounts.length === 0 ? (
            <div style={{ padding: '64px', textAlign: 'center' }}>
              <Tag size={40} strokeWidth={1} style={{ color: '#DEDAD4', display: 'block', margin: '0 auto 16px' }} />
              <p style={{ fontSize: '16px', fontWeight: 500, color: '#1A1917', margin: '0 0 6px' }}>No discounts yet</p>
              <p style={{ fontSize: '13px', color: '#6B7280', margin: '0 0 20px' }}>Create your first promo code to get started.</p>
              <button onClick={() => setShowForm(true)} style={{ padding: '9px 20px', backgroundColor: 'var(--brand)', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer' }}>
                Create Discount
              </button>
            </div>
          ) : (
            <div>
              {/* Table header */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1fr 1fr auto', gap: '0', borderBottom: '1px solid #EEECE7' }}>
                {['Name & Code', 'Value', 'Scope', 'Uses', 'Expires', 'Status', ''].map(h => (
                  <div key={h} style={{ padding: '12px 16px', fontSize: '11px', fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</div>
                ))}
              </div>
              {discounts.map((d, idx) => (
                <div
                  key={d.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1fr 1fr auto',
                    alignItems: 'center', gap: '0',
                    borderBottom: idx < discounts.length - 1 ? '1px solid #F0EEE9' : 'none',
                    cursor: 'default',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#F7F6F3')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  {/* Name + code */}
                  <div style={{ padding: '14px 16px' }}>
                    <p style={{ fontSize: '13px', fontWeight: 600, color: '#1A1917', margin: '0 0 4px' }}>{d.name}</p>
                    <button
                      onClick={() => copyCode(d.code)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', background: 'var(--brand-dim)', border: '1px solid rgba(var(--brand-rgb),0.2)', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', color: 'var(--brand)', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em' }}
                    >
                      {d.code} <Copy size={10} />
                    </button>
                  </div>

                  {/* Value */}
                  <div style={{ padding: '14px 16px' }}>
                    <span style={{ fontSize: '16px', fontWeight: 700, color: '#1A1917' }}>{discountLabel(d)}</span>
                  </div>

                  {/* Scope */}
                  <div style={{ padding: '14px 16px', fontSize: '12px', color: '#6B7280' }}>
                    {scopeLabel(d.scope)}
                  </div>

                  {/* Uses */}
                  <div style={{ padding: '14px 16px', fontSize: '13px', fontWeight: 500, color: '#1A1917' }}>
                    {d.uses_count}{d.max_uses ? ` / ${d.max_uses}` : ''}
                  </div>

                  {/* Expires */}
                  <div style={{ padding: '14px 16px', fontSize: '12px', color: '#6B7280' }}>
                    {d.expires_at ? new Date(d.expires_at).toLocaleDateString() : 'Never'}
                  </div>

                  {/* Status toggle */}
                  <div style={{ padding: '14px 16px' }}>
                    <button onClick={() => handleToggle(d)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: d.active ? 'var(--brand)' : '#DEDAD4', display: 'flex', alignItems: 'center' }}>
                      {d.active ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
                    </button>
                  </div>

                  {/* Delete */}
                  <div style={{ padding: '14px 12px' }}>
                    <button
                      onClick={() => handleDelete(d.id, d.name)}
                      style={{ width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', color: '#DC2626', cursor: 'pointer' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
