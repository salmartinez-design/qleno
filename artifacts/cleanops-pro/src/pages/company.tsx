import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useGetMyCompany, useUpdateMyCompany } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { applyTenantColor } from "@/lib/tenant-brand";
import { useToast } from "@/hooks/use-toast";

type Tab = 'general' | 'branding' | 'integrations' | 'payroll';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'branding', label: 'Branding' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'payroll', label: 'Payroll Options' },
];

export default function CompanyPage() {
  const [activeTab, setActiveTab] = useState<Tab>('branding');

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        <div>
          <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '42px', color: '#F0EDE8', margin: 0, lineHeight: 1.1 }}>Company Settings</h1>
          <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '13px', color: '#7A7873', marginTop: '6px' }}>Manage your company profile, branding, and integrations.</p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid #252525', paddingBottom: '0' }}>
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '10px 20px',
                fontSize: '13px',
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                fontWeight: activeTab === tab.id ? 400 : 300,
                cursor: 'pointer',
                border: 'none',
                backgroundColor: 'transparent',
                color: activeTab === tab.id ? 'var(--brand)' : '#7A7873',
                borderBottom: `2px solid ${activeTab === tab.id ? 'var(--brand)' : 'transparent'}`,
                marginBottom: '-1px',
                transition: 'color 0.15s',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'branding' && <BrandingTab />}
        {activeTab === 'general' && <GeneralTab />}
        {activeTab === 'integrations' && <PlaceholderTab title="Integrations" desc="Connect QuickBooks, Stripe, and other services." />}
        {activeTab === 'payroll' && <PlaceholderTab title="Payroll Options" desc="Configure pay cadence and export settings." />}
      </div>
    </DashboardLayout>
  );
}

function BrandingTab() {
  const { data: company } = useGetMyCompany({ request: { headers: getAuthHeaders() } });
  const updateCompany = useUpdateMyCompany({ request: { headers: getAuthHeaders() } });
  const { toast } = useToast();

  const [brandColor, setBrandColor] = useState('#00C9A7');
  const [logoUrl, setLogoUrl] = useState('');
  const [previewColor, setPreviewColor] = useState('#00C9A7');

  useEffect(() => {
    if (company) {
      const c = (company as any).brand_color || '#00C9A7';
      setBrandColor(c);
      setPreviewColor(c);
      setLogoUrl((company as any).logo_url || '');
    }
  }, [company]);

  const handleColorChange = (hex: string) => {
    setBrandColor(hex);
    setPreviewColor(hex);
    applyTenantColor(hex);
  };

  const handleSave = () => {
    updateCompany.mutate(
      { data: { brand_color: brandColor, logo_url: logoUrl || undefined } as any },
      {
        onSuccess: () => {
          applyTenantColor(brandColor);
          toast({ title: "Brand updated", description: "Changes are live." });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Error", description: "Failed to save brand settings." });
        }
      }
    );
  };

  const hexToRgb = (hex: string) => {
    const c = hex.replace('#', '');
    return `${parseInt(c.slice(0,2),16)}, ${parseInt(c.slice(2,4),16)}, ${parseInt(c.slice(4,6),16)}`;
  };

  const previewRgb = hexToRgb(previewColor);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', alignItems: 'start' }}>
      {/* Left: Controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        {/* Brand Color */}
        <Section title="Brand Color" desc="Applied across all accents, buttons, and highlights.">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ position: 'relative' }}>
              <input
                type="color"
                value={brandColor}
                onChange={e => handleColorChange(e.target.value)}
                style={{ width: '48px', height: '48px', padding: '2px', backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '8px', cursor: 'pointer' }}
              />
            </div>
            <input
              type="text"
              value={brandColor}
              onChange={e => {
                if (/^#[0-9A-Fa-f]{0,6}$/.test(e.target.value)) {
                  setBrandColor(e.target.value);
                  if (e.target.value.length === 7) handleColorChange(e.target.value);
                }
              }}
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '14px', color: '#F0EDE8', backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '6px', padding: '8px 14px', width: '120px', letterSpacing: '0.08em', outline: 'none' }}
            />
          </div>
          <p style={{ fontSize: '11px', fontFamily: "'Plus Jakarta Sans', sans-serif", color: '#7A7873', marginTop: '8px' }}>
            Affects sidebar nav, buttons, badges, progress bars, chart lines.
          </p>
        </Section>

        {/* Logo */}
        <Section title="Company Logo" desc="Displayed in sidebar header, replacing the wordmark.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={{ fontSize: '11px', fontFamily: "'Plus Jakarta Sans', sans-serif", color: '#7A7873', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: '6px' }}>Logo URL (dark backgrounds)</label>
              <input
                type="url"
                value={logoUrl}
                onChange={e => setLogoUrl(e.target.value)}
                placeholder="https://..."
                style={{ width: '100%', fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '13px', color: '#F0EDE8', backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '6px', padding: '8px 12px', outline: 'none' }}
              />
            </div>
            {logoUrl && (
              <div style={{ backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '8px', padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <img src={logoUrl} alt="Preview" style={{ maxHeight: '36px', objectFit: 'contain' }} />
                <span style={{ fontSize: '11px', fontFamily: "'Plus Jakarta Sans', sans-serif", color: '#7A7873' }}>Preview on dark</span>
              </div>
            )}
            <p style={{ fontSize: '11px', fontFamily: "'Plus Jakarta Sans', sans-serif", color: '#4A4845' }}>
              PNG with transparency, max 2MB. File upload via storage coming soon.
            </p>
          </div>
        </Section>

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={updateCompany.isPending}
          style={{ alignSelf: 'flex-start', padding: '10px 24px', backgroundColor: 'var(--brand)', color: '#0A0A0A', borderRadius: '6px', fontSize: '13px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 400, border: 'none', cursor: 'pointer', opacity: updateCompany.isPending ? 0.7 : 1 }}
        >
          {updateCompany.isPending ? 'Saving...' : 'Save Brand Settings'}
        </button>
      </div>

      {/* Right: Preview */}
      <div style={{ backgroundColor: '#111111', border: '1px solid #252525', borderRadius: '10px', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #252525' }}>
          <p style={{ fontSize: '11px', fontFamily: "'Plus Jakarta Sans', sans-serif", color: '#7A7873', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>Sidebar Preview</p>
        </div>
        <div style={{ padding: '16px' }}>
          {/* Company header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingBottom: '12px', borderBottom: '1px solid #252525', marginBottom: '12px' }}>
            <div style={{ width: '28px', height: '28px', borderRadius: '6px', backgroundColor: previewColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ color: '#0A0A0A', fontSize: '13px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700 }}>C</span>
            </div>
            <div>
              <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '14px', color: '#F0EDE8', margin: 0 }}>CleanOps Pro</p>
              <p style={{ fontSize: '11px', color: '#7A7873', fontFamily: "'Plus Jakarta Sans', sans-serif", margin: 0 }}>{(company as any)?.name || 'Your Company'}</p>
            </div>
          </div>
          {/* Nav items preview */}
          {[
            { label: 'Dashboard', active: false },
            { label: 'Jobs', active: true },
            { label: 'Employees', active: false },
            { label: 'Customers', active: false },
          ].map(item => (
            <div key={item.label} style={{
              padding: '8px 10px',
              marginBottom: '2px',
              borderRadius: '0',
              borderLeft: item.active ? `3px solid ${previewColor}` : '3px solid transparent',
              backgroundColor: item.active ? `rgba(${previewRgb}, 0.12)` : 'transparent',
              color: item.active ? previewColor : '#7A7873',
              fontSize: '13px',
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontWeight: item.active ? 400 : 300,
            }}>
              {item.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GeneralTab() {
  const { data: company } = useGetMyCompany({ request: { headers: getAuthHeaders() } });
  const updateCompany = useUpdateMyCompany({ request: { headers: getAuthHeaders() } });
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [payCadence, setPayCadence] = useState('biweekly');

  useEffect(() => {
    if (company) {
      setName(company.name || '');
      setPayCadence(company.pay_cadence || 'biweekly');
    }
  }, [company]);

  const handleSave = () => {
    updateCompany.mutate(
      { data: { name, pay_cadence: payCadence as any } as any },
      {
        onSuccess: () => toast({ title: "Settings saved", description: "Company profile updated." }),
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to save settings." }),
      }
    );
  };

  return (
    <div style={{ maxWidth: '560px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <Section title="Company Name" desc="">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          style={{ width: '100%', fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '13px', color: '#F0EDE8', backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '6px', padding: '10px 14px', outline: 'none' }}
        />
      </Section>
      <Section title="Pay Cadence" desc="How often payroll is processed.">
        <div style={{ display: 'flex', gap: '8px' }}>
          {[{ id: 'weekly', label: 'Weekly' }, { id: 'biweekly', label: 'Bi-weekly' }, { id: 'semimonthly', label: 'Semi-monthly' }].map(opt => (
            <button key={opt.id} onClick={() => setPayCadence(opt.id)} style={{ padding: '7px 16px', borderRadius: '6px', fontSize: '12px', fontFamily: "'Plus Jakarta Sans', sans-serif", cursor: 'pointer', border: payCadence === opt.id ? 'none' : '1px solid #252525', backgroundColor: payCadence === opt.id ? 'var(--brand)' : 'transparent', color: payCadence === opt.id ? '#0A0A0A' : '#7A7873' }}>
              {opt.label}
            </button>
          ))}
        </div>
      </Section>
      <button onClick={handleSave} disabled={updateCompany.isPending} style={{ alignSelf: 'flex-start', padding: '10px 24px', backgroundColor: 'var(--brand)', color: '#0A0A0A', borderRadius: '6px', fontSize: '13px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 400, border: 'none', cursor: 'pointer', opacity: updateCompany.isPending ? 0.7 : 1 }}>
        {updateCompany.isPending ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 400, fontSize: '13px', color: '#F0EDE8', margin: '0 0 4px 0' }}>{title}</h3>
      {desc && <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '12px', color: '#7A7873', margin: '0 0 12px 0' }}>{desc}</p>}
      {children}
    </div>
  );
}

function PlaceholderTab({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ padding: '48px 0', textAlign: 'center', border: '1px dashed #252525', borderRadius: '8px' }}>
      <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '24px', color: '#F0EDE8', margin: '0 0 8px 0' }}>{title}</h3>
      <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '13px', color: '#7A7873', margin: 0 }}>{desc}</p>
    </div>
  );
}
