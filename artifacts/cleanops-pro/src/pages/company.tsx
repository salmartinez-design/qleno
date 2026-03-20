import { useState, useEffect, useRef } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useGetMyCompany, useUpdateMyCompany } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { applyTenantColor } from "@/lib/tenant-brand";
import { useToast } from "@/hooks/use-toast";
import { Upload, X, ImageIcon } from "lucide-react";
import { HRPoliciesTab } from "./company/hr-policies";

type Tab = 'general' | 'branding' | 'integrations' | 'payroll' | 'notifications' | 'clock-inout' | 'invoicing' | 'hr-policies';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'branding', label: 'Branding' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'clock-inout', label: 'Clock In/Out' },
  { id: 'invoicing', label: 'Invoicing' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'payroll', label: 'Payroll Options' },
  { id: 'hr-policies', label: 'HR Policies' },
];

export default function CompanyPage() {
  const [activeTab, setActiveTab] = useState<Tab>('branding');

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        <div>
          <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '42px', color: '#1A1917', margin: 0, lineHeight: 1.1 }}>Company Settings</h1>
          <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '13px', color: '#6B7280', marginTop: '6px' }}>Manage your company profile, branding, and integrations.</p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid #E5E2DC', paddingBottom: '0' }}>
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '10px 20px',
                fontSize: '13px',
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                fontWeight: activeTab === tab.id ? 500 : 400,
                cursor: 'pointer',
                border: 'none',
                backgroundColor: 'transparent',
                color: activeTab === tab.id ? 'var(--brand)' : '#6B7280',
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
        {activeTab === 'notifications' && <NotificationsTab />}
        {activeTab === 'clock-inout' && <ClockInOutTab />}
        {activeTab === 'invoicing' && <InvoicingTab />}
        {activeTab === 'integrations' && <PlaceholderTab title="Integrations" desc="Connect QuickBooks, Stripe, and other services." />}
        {activeTab === 'payroll' && <PlaceholderTab title="Payroll Options" desc="Configure pay cadence and export settings." />}
        {activeTab === 'hr-policies' && <HRPoliciesTab />}
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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      { data: { brand_color: brandColor } as any },
      {
        onSuccess: () => {
          applyTenantColor(brandColor);
          toast({ title: "Brand updated", description: "Color is live across the app." });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Error", description: "Failed to save brand settings." });
        }
      }
    );
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(file.type)) {
      toast({ variant: "destructive", title: "Invalid file type", description: "Please choose a PNG, JPG, or WebP file." });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ variant: "destructive", title: "File too large", description: "Maximum file size is 2MB." });
      return;
    }

    setSelectedFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setUploadPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const headers = getAuthHeaders();
      const res = await fetch('/api/companies/logo', {
        method: 'POST',
        headers,
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Upload failed');
      }

      const data = await res.json();
      const freshUrl = `${data.logo_url}?t=${Date.now()}`;
      setLogoUrl(freshUrl);
      setSelectedFile(null);
      setUploadPreview(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast({ title: "Logo uploaded", description: "Refreshing to apply changes..." });
      setTimeout(() => window.location.reload(), 800);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Upload failed", description: err.message });
    } finally {
      setUploading(false);
    }
  };

  const hexToRgb = (hex: string) => {
    const c = hex.replace('#', '');
    return `${parseInt(c.slice(0,2),16)}, ${parseInt(c.slice(2,4),16)}, ${parseInt(c.slice(4,6),16)}`;
  };

  const previewRgb = hexToRgb(previewColor);
  const displayLogoUrl = uploadPreview || logoUrl;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', alignItems: 'start' }}>
      {/* Left: Controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>

        {/* Brand Color */}
        <Section title="Brand Color" desc="Applied across all accents, buttons, and highlights.">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              type="color"
              value={brandColor}
              onChange={e => handleColorChange(e.target.value)}
              style={{ width: '48px', height: '48px', padding: '2px', backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '8px', cursor: 'pointer' }}
            />
            <input
              type="text"
              value={brandColor}
              onChange={e => {
                if (/^#[0-9A-Fa-f]{0,6}$/.test(e.target.value)) {
                  setBrandColor(e.target.value);
                  if (e.target.value.length === 7) handleColorChange(e.target.value);
                }
              }}
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '14px', color: '#1A1917', backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '6px', padding: '8px 14px', width: '120px', letterSpacing: '0.08em', outline: 'none' }}
            />
          </div>
          <p style={{ fontSize: '11px', color: '#6B7280', marginTop: '8px' }}>Affects sidebar, buttons, badges, charts.</p>
          <button
            onClick={handleSave}
            disabled={updateCompany.isPending}
            style={{ marginTop: '12px', padding: '8px 20px', backgroundColor: 'var(--brand)', color: '#FFFFFF', borderRadius: '6px', fontSize: '12px', fontWeight: 600, border: 'none', cursor: 'pointer', opacity: updateCompany.isPending ? 0.7 : 1 }}
          >
            {updateCompany.isPending ? 'Saving...' : 'Save Color'}
          </button>
        </Section>

        {/* Logo Upload */}
        <Section title="Company Logo" desc="PNG or JPG, transparent background recommended, max 2MB.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

            {/* Current / preview on both backgrounds */}
            {displayLogoUrl && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div style={{ backgroundColor: '#1A1917', border: '1px solid #333', borderRadius: '8px', padding: '14px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                  <img src={displayLogoUrl} alt="Logo dark" style={{ maxHeight: '40px', maxWidth: '100%', objectFit: 'contain' }} />
                  <span style={{ fontSize: '10px', color: '#9E9B94' }}>Dark bg</span>
                </div>
                <div style={{ backgroundColor: '#F0EDE8', border: '1px solid #DDD', borderRadius: '8px', padding: '14px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                  <img src={displayLogoUrl} alt="Logo light" style={{ maxHeight: '40px', maxWidth: '100%', objectFit: 'contain' }} />
                  <span style={{ fontSize: '10px', color: '#888' }}>Light bg</span>
                </div>
              </div>
            )}

            {/* No logo state */}
            {!displayLogoUrl && (
              <div style={{ backgroundColor: '#F7F6F3', border: '1px dashed #DEDAD4', borderRadius: '8px', padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                <ImageIcon size={24} color="#9E9B94" />
                <span style={{ fontSize: '12px', color: '#9E9B94' }}>No logo uploaded yet</span>
              </div>
            )}

            {/* File picker */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{
                  flex: 1, height: '38px', backgroundColor: '#F7F6F3',
                  border: '1px solid #DEDAD4', borderRadius: '8px',
                  color: '#1A1917', fontSize: '12px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                }}
              >
                <Upload size={13} />
                {selectedFile ? selectedFile.name : 'Choose file...'}
              </button>
              {selectedFile && (
                <button
                  onClick={() => { setSelectedFile(null); setUploadPreview(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                  style={{ width: '38px', height: '38px', backgroundColor: '#FEE2E2', border: '1px solid #FECACA', borderRadius: '8px', color: '#991B1B', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {selectedFile && (
              <button
                onClick={handleUpload}
                disabled={uploading}
                style={{ height: '40px', backgroundColor: 'var(--brand)', color: '#FFFFFF', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', opacity: uploading ? 0.7 : 1 }}
              >
                {uploading ? 'Uploading...' : 'Upload Logo'}
              </button>
            )}

            <p style={{ fontSize: '11px', color: '#9E9B94', margin: 0 }}>
              PNG with transparent background works best. The logo appears in the sidebar header.
            </p>
          </div>
        </Section>
      </div>

      {/* Right: Preview */}
      <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '10px', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #EEECE7' }}>
          <p style={{ fontSize: '11px', color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>Sidebar Preview</p>
        </div>
        <div style={{ padding: '16px' }}>
          {/* Company header */}
          <div style={{ paddingBottom: '12px', borderBottom: '1px solid #EEECE7', marginBottom: '12px' }}>
            {displayLogoUrl ? (
              <div style={{ backgroundColor: '#F7F6F3', borderRadius: '6px', padding: '4px 8px', display: 'inline-block', marginBottom: '4px', border: '1px solid #EEECE7' }}>
                <img src={displayLogoUrl} alt="Logo" style={{ height: '26px', width: 'auto', objectFit: 'contain', display: 'block' }} />
              </div>
            ) : (
              <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '14px', color: '#1A1917', margin: '0 0 4px 0' }}>{(company as any)?.name || 'Your Company'}</p>
            )}
            <p style={{ fontSize: '11px', color: '#9E9B94', margin: 0 }}>Qleno</p>
          </div>
          {[
            { label: 'Dashboard', active: false },
            { label: 'Jobs', active: true },
            { label: 'Employees', active: false },
            { label: 'Customers', active: false },
          ].map(item => (
            <div key={item.label} style={{
              height: '34px', padding: '0 10px', margin: '2px 0',
              borderRadius: '6px', display: 'flex', alignItems: 'center',
              backgroundColor: item.active ? `rgba(${previewRgb}, 0.07)` : 'transparent',
              color: item.active ? previewColor : '#6B7280',
              fontSize: '13px', fontWeight: item.active ? 500 : 400,
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
  const [paymentTermsDays, setPaymentTermsDays] = useState(0);

  useEffect(() => {
    if (company) {
      setName(company.name || '');
      setPayCadence(company.pay_cadence || 'biweekly');
      setPaymentTermsDays((company as any).payment_terms_days ?? 0);
    }
  }, [company]);

  const handleSave = () => {
    updateCompany.mutate(
      { data: { name, pay_cadence: payCadence as any, payment_terms_days: paymentTermsDays } as any },
      {
        onSuccess: () => toast({ title: "Settings saved", description: "Company profile updated." }),
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to save settings." }),
      }
    );
  };

  const FF = "'Plus Jakarta Sans', sans-serif";
  const selectStyle: React.CSSProperties = {
    width: '100%', fontFamily: FF, fontSize: '13px', color: '#1A1917',
    backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '6px',
    padding: '10px 14px', outline: 'none', cursor: 'pointer', appearance: 'none' as any,
  };

  return (
    <div style={{ maxWidth: '560px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <Section title="Company Name" desc="">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          style={{ width: '100%', fontFamily: FF, fontSize: '13px', color: '#1A1917', backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '6px', padding: '10px 14px', outline: 'none' }}
        />
      </Section>
      <Section title="Pay Cadence" desc="How often payroll is processed.">
        <div style={{ display: 'flex', gap: '8px' }}>
          {[{ id: 'weekly', label: 'Weekly' }, { id: 'biweekly', label: 'Bi-weekly' }, { id: 'semimonthly', label: 'Semi-monthly' }].map(opt => (
            <button key={opt.id} onClick={() => setPayCadence(opt.id)} style={{ padding: '7px 16px', borderRadius: '6px', fontSize: '12px', fontFamily: FF, cursor: 'pointer', border: payCadence === opt.id ? 'none' : '1px solid #E5E2DC', backgroundColor: payCadence === opt.id ? 'var(--brand)' : 'transparent', color: payCadence === opt.id ? '#FFFFFF' : '#6B7280' }}>
              {opt.label}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Default payment terms" desc="Applied to all auto-generated invoices. Can be overridden per invoice.">
        <select
          value={paymentTermsDays}
          onChange={e => setPaymentTermsDays(parseInt(e.target.value))}
          style={selectStyle}
        >
          <option value={0}>Due on receipt</option>
          <option value={7}>NET 7</option>
          <option value={15}>NET 15</option>
          <option value={30}>NET 30</option>
        </select>
      </Section>
      <button onClick={handleSave} disabled={updateCompany.isPending} style={{ alignSelf: 'flex-start', padding: '10px 24px', backgroundColor: 'var(--brand)', color: '#FFFFFF', borderRadius: '6px', fontSize: '13px', fontFamily: FF, fontWeight: 600, border: 'none', cursor: 'pointer', opacity: updateCompany.isPending ? 0.7 : 1 }}>
        {updateCompany.isPending ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 500, fontSize: '13px', color: '#1A1917', margin: '0 0 4px 0' }}>{title}</h3>
      {desc && <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '12px', color: '#6B7280', margin: '0 0 12px 0' }}>{desc}</p>}
      {children}
    </div>
  );
}

function PlaceholderTab({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ padding: '48px 0', textAlign: 'center', border: '1px dashed #E5E2DC', borderRadius: '8px' }}>
      <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '24px', color: '#1A1917', margin: '0 0 8px 0' }}>{title}</h3>
      <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '13px', color: '#6B7280', margin: 0 }}>{desc}</p>
    </div>
  );
}

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const TRIGGER_LABELS: Record<string, string> = {
  job_scheduled: "Job Scheduled",
  job_reminder_24h: "Job Reminder (24h before)",
  job_complete: "Job Completed",
  invoice_sent: "Invoice Sent",
  employee_clock_in: "Employee Clock In",
  payment_received: "Payment Received",
};

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email", sms: "SMS", in_app: "In-App",
};

const VARIABLES_HELP = [
  "{{client_name}}", "{{service_type}}", "{{date}}", "{{time}}",
  "{{company_name}}", "{{employee_name}}", "{{amount}}", "{{invoice_number}}",
];

const SMS_TOGGLES = [
  { key: "sms_on_my_way_enabled",  label: "On My Way",  desc: "Sent when employee taps 'On My Way' before arrival" },
  { key: "sms_arrived_enabled",    label: "Arrived",     desc: "Sent when employee clocks in at the job" },
  { key: "sms_paused_enabled",     label: "Pause / Resume", desc: "Sent when employee pauses or resumes the job" },
  { key: "sms_complete_enabled",   label: "Job Complete", desc: "Sent when employee clocks out after completing the job" },
] as const;

function SmsSmsSettingsCard() {
  const { toast } = useToast();
  const FF = "'Plus Jakarta Sans', sans-serif";
  const [settings, setSettings] = useState<Record<string, boolean>>({
    sms_on_my_way_enabled: false, sms_arrived_enabled: false,
    sms_paused_enabled: false, sms_complete_enabled: false,
  });
  const [twilioFrom, setTwilioFrom] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/companies/me`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const c = d.data ?? d;
        setSettings({
          sms_on_my_way_enabled: !!c.sms_on_my_way_enabled,
          sms_arrived_enabled:   !!c.sms_arrived_enabled,
          sms_paused_enabled:    !!c.sms_paused_enabled,
          sms_complete_enabled:  !!c.sms_complete_enabled,
        });
        setTwilioFrom(c.twilio_from_number ?? "");
      })
      .finally(() => setLoading(false));
  }, []);

  async function saveSmsSettings() {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/companies/me`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, twilio_from_number: twilioFrom || null }),
      });
      if (!r.ok) throw new Error();
      toast({ title: "SMS settings saved" });
    } catch { toast({ title: "Failed to save", variant: "destructive" }); }
    finally { setSaving(false); }
  }

  if (loading) return null;

  return (
    <div style={{ background: '#fff', border: '1px solid #E5E2DC', borderRadius: 12, padding: '18px 20px', marginBottom: 24, fontFamily: FF }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: '0 0 3px' }}>Job Status SMS</p>
          <p style={{ fontSize: 12, color: '#9E9B94', margin: 0 }}>Send SMS to clients when job status changes. Requires Twilio.</p>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        {SMS_TOGGLES.map(t => (
          <div key={t.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: '#F7F6F3', borderRadius: 8 }}>
            <div>
              <p style={{ fontSize: 13, fontWeight: 600, color: '#1A1917', margin: '0 0 2px' }}>{t.label}</p>
              <p style={{ fontSize: 11, color: '#9E9B94', margin: 0 }}>{t.desc}</p>
            </div>
            <button
              onClick={() => setSettings(prev => ({ ...prev, [t.key]: !prev[t.key] }))}
              style={{
                width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                background: settings[t.key] ? 'var(--brand, #5B9BD5)' : '#E5E2DC', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
              }}>
              <div style={{
                width: 18, height: 18, borderRadius: 9, background: '#fff',
                position: 'absolute', top: 3, left: settings[t.key] ? 23 : 3,
                transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
              }} />
            </button>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Twilio From Number</p>
        <input
          value={twilioFrom}
          onChange={e => setTwilioFrom(e.target.value)}
          placeholder="+15551234567"
          style={{ width: '100%', padding: '9px 12px', border: '1px solid #E5E2DC', borderRadius: 8, fontSize: 13, fontFamily: FF, outline: 'none', boxSizing: 'border-box' }}
        />
        <p style={{ fontSize: 11, color: '#9E9B94', margin: '5px 0 0' }}>Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in environment secrets.</p>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={saveSmsSettings}
          disabled={saving}
          style={{ padding: '8px 18px', border: 'none', borderRadius: 8, background: 'var(--brand, #5B9BD5)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: FF, opacity: saving ? 0.7 : 1 }}
        >
          {saving ? "Saving…" : "Save SMS Settings"}
        </button>
      </div>
    </div>
  );
}

function NotificationsTab() {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editSubject, setEditSubject] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [saving, setSaving] = useState<number | null>(null);

  async function load() {
    try {
      const [t, l] = await Promise.all([
        fetch(`${API}/api/notifications/templates`, { headers: getAuthHeaders() }).then(r => r.json()),
        fetch(`${API}/api/notifications/log`, { headers: getAuthHeaders() }).then(r => r.json()),
      ]);
      setTemplates(t.data || []);
      setLogs(l.data || []);
    } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function toggle(id: number, is_active: boolean) {
    const tmpl = templates.find(t => t.id === id);
    if (!tmpl) return;
    setTemplates(prev => prev.map(t => t.id === id ? { ...t, is_active } : t));
    try {
      await fetch(`${API}/api/notifications/templates/${id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ is_active, subject: tmpl.subject, body: tmpl.body }),
      });
      toast({ title: `Notification ${is_active ? "enabled" : "disabled"}` });
    } catch {
      toast({ title: "Failed to update", variant: "destructive" });
      load();
    }
  }

  async function save(id: number) {
    setSaving(id);
    try {
      const tmpl = templates.find(t => t.id === id)!;
      await fetch(`${API}/api/notifications/templates/${id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: tmpl.is_active, subject: editSubject, body: editBody }),
      });
      setTemplates(prev => prev.map(t => t.id === id ? { ...t, subject: editSubject, body: editBody } : t));
      toast({ title: "Template saved" });
      setEditingId(null);
    } catch { toast({ title: "Failed to save", variant: "destructive" }); }
    finally { setSaving(null); }
  }

  async function testNotification(id: number) {
    setTesting(id);
    try {
      const r = await fetch(`${API}/api/notifications/templates/${id}/test`, {
        method: "POST", headers: getAuthHeaders(),
      });
      const d = await r.json();
      toast({ title: "Test sent!", description: d.message });
      load();
    } catch { toast({ title: "Test failed", variant: "destructive" }); }
    finally { setTesting(null); }
  }

  function startEdit(tmpl: any) {
    setEditingId(tmpl.id);
    setEditBody(tmpl.body);
    setEditSubject(tmpl.subject || "");
  }

  const FF = "'Plus Jakarta Sans', sans-serif";
  const CARD: React.CSSProperties = { background: '#fff', border: '1px solid #E5E2DC', borderRadius: 12, padding: '18px 20px', marginBottom: 12 };

  if (loading) return <div style={{ padding: '40px 0', textAlign: 'center', color: '#9E9B94', fontFamily: FF }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, fontFamily: FF }}>
      <SmsSmsSettingsCard />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: '0 0 4px' }}>Notification Triggers</p>
          <p style={{ fontSize: 12, color: '#9E9B94', margin: 0 }}>Configure automatic messages sent to clients and staff</p>
        </div>
        <button onClick={() => setShowLog(!showLog)}
          style={{ fontSize: 12, fontWeight: 600, color: 'var(--brand, #5B9BD5)', background: '#EBF4FF', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontFamily: FF }}>
          {showLog ? "Hide Log" : "View Log"} {logs.length > 0 && `(${logs.length})`}
        </button>
      </div>

      {showLog && (
        <div style={{ ...CARD, marginBottom: 20 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: '0 0 12px' }}>Recent Notification Log</p>
          {logs.length === 0 && <p style={{ fontSize: 12, color: '#9E9B94', margin: 0 }}>No notifications sent yet.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
            {logs.map(l => (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 10px', background: '#F7F6F3', borderRadius: 6, alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#1A1917' }}>{TRIGGER_LABELS[l.trigger] || l.trigger}</span>
                  <span style={{ fontSize: 11, color: '#9E9B94', marginLeft: 8 }}>{CHANNEL_LABELS[l.channel] || l.channel} → {l.recipient}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: l.status === 'test_sent' ? '#7C3AED' : '#16A34A', fontWeight: 600 }}>{l.status}</span>
                  <span style={{ fontSize: 10, color: '#9E9B94' }}>{new Date(l.sent_at).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {templates.map(tmpl => (
        <div key={tmpl.id} style={{ ...CARD, borderLeft: `3px solid ${tmpl.is_active ? 'var(--brand, #5B9BD5)' : '#E5E2DC'}` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: editingId === tmpl.id ? 14 : 0 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#6B7280' }}>{CHANNEL_LABELS[tmpl.channel] || tmpl.channel}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#1A1917' }}>{TRIGGER_LABELS[tmpl.trigger] || tmpl.trigger}</span>
                <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9E9B94', background: '#F3F4F6', padding: '2px 7px', borderRadius: 4 }}>{tmpl.channel}</span>
              </div>
              {editingId !== tmpl.id && (
                <p style={{ fontSize: 12, color: '#6B7280', margin: 0, lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {tmpl.subject ? <><strong>{tmpl.subject}</strong> — </> : ""}{tmpl.body}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => toggle(tmpl.id, !tmpl.is_active)}
                style={{
                  width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                  background: tmpl.is_active ? 'var(--brand, #5B9BD5)' : '#E5E2DC', position: 'relative', transition: 'background 0.2s',
                }}>
                <div style={{
                  width: 18, height: 18, borderRadius: 9, background: '#fff',
                  position: 'absolute', top: 3, left: tmpl.is_active ? 23 : 3,
                  transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                }}/>
              </button>
              <div style={{ display: 'flex', gap: 5 }}>
                <button onClick={() => editingId === tmpl.id ? setEditingId(null) : startEdit(tmpl)}
                  style={{ fontSize: 11, color: 'var(--brand, #5B9BD5)', background: '#EBF4FF', border: 'none', borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontFamily: FF, fontWeight: 600 }}>
                  {editingId === tmpl.id ? "Cancel" : "Edit"}
                </button>
                <button onClick={() => testNotification(tmpl.id)} disabled={testing === tmpl.id}
                  style={{ fontSize: 11, color: '#6B7280', background: '#F3F4F6', border: 'none', borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontFamily: FF }}>
                  {testing === tmpl.id ? "…" : "Test"}
                </button>
              </div>
            </div>
          </div>

          {editingId === tmpl.id && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {tmpl.channel === 'email' && (
                <div>
                  <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', margin: '0 0 5px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Subject Line</p>
                  <input value={editSubject} onChange={e => setEditSubject(e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #E5E2DC', borderRadius: 7, fontSize: 13, fontFamily: FF, outline: 'none', boxSizing: 'border-box' }}/>
                </div>
              )}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', margin: '0 0 5px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Message Body</p>
                <textarea value={editBody} onChange={e => setEditBody(e.target.value)}
                  style={{ width: '100%', height: 120, padding: '10px 12px', border: '1px solid #E5E2DC', borderRadius: 7, fontSize: 12, fontFamily: FF, outline: 'none', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.5 }}/>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: '#9E9B94', alignSelf: 'center', marginRight: 2 }}>Variables:</span>
                {VARIABLES_HELP.map(v => (
                  <button key={v} onClick={() => setEditBody(b => b + v)}
                    style={{ fontSize: 10, color: '#7C3AED', background: '#EDE9FE', border: 'none', borderRadius: 4, padding: '2px 7px', cursor: 'pointer', fontFamily: FF }}>
                    {v}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => setEditingId(null)}
                  style={{ padding: '7px 14px', border: '1px solid #E5E2DC', borderRadius: 7, background: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: FF }}>
                  Cancel
                </button>
                <button onClick={() => save(tmpl.id)} disabled={saving === tmpl.id}
                  style={{ padding: '7px 16px', border: 'none', borderRadius: 7, background: 'var(--brand, #5B9BD5)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: FF }}>
                  {saving === tmpl.id ? "Saving…" : "Save Template"}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
        background: checked ? 'var(--brand, #5B9BD5)' : '#E5E2DC',
        position: 'relative', transition: 'background 0.2s', flexShrink: 0,
      }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: 9, background: '#fff',
        position: 'absolute', top: 3, left: checked ? 23 : 3,
        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
      }} />
    </button>
  );
}

function ClockInOutTab() {
  const { toast } = useToast();
  const FF = "'Plus Jakarta Sans', sans-serif";
  const BASE = (window as any).__BASE__ || import.meta.env?.BASE_URL?.replace(/\/$/, '') || '';

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState({
    geofence_enabled: true,
    geofence_clockin_radius_ft: 500,
    geofence_clockout_radius_ft: 1000,
    geofence_override_allowed: true,
    geofence_soft_mode: false,
  });

  useEffect(() => {
    const headers = getAuthHeaders();
    fetch(`${BASE}/api/companies/me`, { headers })
      .then(r => r.json())
      .then(d => {
        setSettings({
          geofence_enabled: d.geofence_enabled ?? true,
          geofence_clockin_radius_ft: d.geofence_clockin_radius_ft ?? 500,
          geofence_clockout_radius_ft: d.geofence_clockout_radius_ft ?? 1000,
          geofence_override_allowed: d.geofence_override_allowed ?? true,
          geofence_soft_mode: d.geofence_soft_mode ?? false,
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
      const res = await fetch(`${BASE}/api/companies/me`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error('Save failed');
      toast({ title: 'Clock In/Out settings saved' });
    } catch {
      toast({ variant: 'destructive', title: 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  };

  const CARD: React.CSSProperties = {
    background: '#fff', border: '1px solid #E5E2DC', borderRadius: 12,
    padding: '20px 24px', marginBottom: 12,
  };
  const ROW: React.CSSProperties = {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#9E9B94', fontFamily: FF }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, fontFamily: FF, maxWidth: 640 }}>
      <p style={{ fontSize: 13, color: '#6B7280', margin: '0 0 20px' }}>
        Control GPS enforcement for employee clock-in and clock-out. Employees must be within the configured radius of the job address.
      </p>

      <div style={CARD}>
        <div style={ROW}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: '0 0 3px' }}>Enforce Geofencing</p>
            <p style={{ fontSize: 12, color: '#6B7280', margin: 0 }}>Employees must be within range of job address to clock in and out</p>
          </div>
          <ToggleSwitch checked={settings.geofence_enabled} onChange={v => setSettings(s => ({ ...s, geofence_enabled: v }))} />
        </div>
      </div>

      <div style={{ ...CARD, opacity: settings.geofence_enabled ? 1 : 0.45, pointerEvents: settings.geofence_enabled ? 'auto' : 'none' }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: '0 0 16px' }}>Radius Settings</p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
              Clock In Radius (feet)
            </label>
            <input
              type="number"
              min={100} max={2640}
              value={settings.geofence_clockin_radius_ft}
              onChange={e => setSettings(s => ({ ...s, geofence_clockin_radius_ft: parseInt(e.target.value) || 500 }))}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #E5E2DC', borderRadius: 7, fontSize: 13, fontFamily: FF, outline: 'none', boxSizing: 'border-box' }}
            />
            <p style={{ fontSize: 11, color: '#9E9B94', margin: '4px 0 0' }}>How close must employee be to clock in. Range: 100–2640 ft</p>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
              Clock Out Radius (feet)
            </label>
            <input
              type="number"
              min={100} max={2640}
              value={settings.geofence_clockout_radius_ft}
              onChange={e => setSettings(s => ({ ...s, geofence_clockout_radius_ft: parseInt(e.target.value) || 1000 }))}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #E5E2DC', borderRadius: 7, fontSize: 13, fontFamily: FF, outline: 'none', boxSizing: 'border-box' }}
            />
            <p style={{ fontSize: 11, color: '#9E9B94', margin: '4px 0 0' }}>Slightly larger to account for employees finishing outside</p>
          </div>
        </div>

        <div style={{ marginTop: 12, padding: '10px 14px', background: '#F0F7FF', borderRadius: 8 }}>
          <p style={{ fontSize: 12, color: '#1E40AF', margin: 0 }}>
            {(settings.geofence_clockin_radius_ft / 5280).toFixed(2)} mi clock-in radius &nbsp;·&nbsp; {(settings.geofence_clockout_radius_ft / 5280).toFixed(2)} mi clock-out radius
          </p>
        </div>
      </div>

      <div style={{ ...CARD, opacity: settings.geofence_enabled ? 1 : 0.45, pointerEvents: settings.geofence_enabled ? 'auto' : 'none' }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: '0 0 16px' }}>Enforcement Mode</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={ROW}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: '#1A1917', margin: '0 0 3px' }}>Allow Override</p>
              <p style={{ fontSize: 12, color: '#6B7280', margin: 0 }}>Owner and admins can manually approve a failed geofence check</p>
            </div>
            <ToggleSwitch checked={settings.geofence_override_allowed} onChange={v => setSettings(s => ({ ...s, geofence_override_allowed: v }))} />
          </div>
          <div style={{ borderTop: '1px solid #F0EEE9', paddingTop: 16, ...ROW }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: '#1A1917', margin: '0 0 3px' }}>Soft Mode</p>
              <p style={{ fontSize: 12, color: '#6B7280', margin: 0 }}>Warn employee if outside range but still allow clock in — logs the distance violation</p>
            </div>
            <ToggleSwitch checked={settings.geofence_soft_mode} onChange={v => setSettings(s => ({ ...s, geofence_soft_mode: v }))} />
          </div>
        </div>

        {settings.geofence_soft_mode && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: '#FFFBEB', borderLeft: '3px solid #F59E0B', borderRadius: '0 6px 6px 0' }}>
            <p style={{ fontSize: 12, color: '#92400E', margin: 0 }}>
              Soft mode is active. Employees outside the radius will see a warning but can still clock in. All violations are logged.
            </p>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '10px 24px', background: 'var(--brand, #5B9BD5)', color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700,
            cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
            fontFamily: FF,
          }}
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}

function InvoicingTab() {
  const { toast } = useToast();
  const FF = "'Plus Jakarta Sans', sans-serif";
  const BASE = (window as any).__BASE__ || import.meta.env?.BASE_URL?.replace(/\/$/, '') || '';

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState({
    default_payment_terms_residential: 'due_on_receipt',
    default_payment_terms_commercial: 'net_30',
    default_invoice_notes_residential: '',
    default_invoice_notes_commercial: '',
    auto_send_invoices: false,
    auto_charge_on_invoice: false,
  });

  useEffect(() => {
    const headers = getAuthHeaders();
    fetch(`${BASE}/api/companies/me`, { headers })
      .then(r => r.json())
      .then(d => {
        const c = d.data || d;
        setSettings({
          default_payment_terms_residential: c.default_payment_terms_residential || 'due_on_receipt',
          default_payment_terms_commercial: c.default_payment_terms_commercial || 'net_30',
          default_invoice_notes_residential: c.default_invoice_notes_residential || '',
          default_invoice_notes_commercial: c.default_invoice_notes_commercial || '',
          auto_send_invoices: !!c.auto_send_invoices,
          auto_charge_on_invoice: !!c.auto_charge_on_invoice,
        });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
      const res = await fetch(`${BASE}/api/companies/me`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error('Save failed');
      toast({ title: 'Invoicing settings saved' });
    } catch {
      toast({ title: 'Save failed', description: 'Please try again.', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const termOptions = [
    { value: 'due_on_receipt', label: 'Due on Receipt' },
    { value: 'net_15', label: 'NET 15' },
    { value: 'net_30', label: 'NET 30' },
  ];

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 600, color: '#6B7280',
    marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: FF,
  };
  const selectStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', border: '1px solid #E5E2DC', borderRadius: 8,
    fontSize: 14, fontFamily: FF, color: '#1A1917', background: '#fff', appearance: 'none',
  };
  const textareaStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', border: '1px solid #E5E2DC', borderRadius: 8,
    fontSize: 13, fontFamily: FF, color: '#1A1917', background: '#fff', resize: 'vertical',
    minHeight: 80, boxSizing: 'border-box',
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#9E9B94', fontFamily: FF }}>Loading...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Payment Terms */}
      <div style={{ background: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, padding: '20px 24px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1A1917', marginBottom: 4, fontFamily: FF }}>Default Payment Terms</div>
        <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 20, fontFamily: FF }}>Applied when creating new invoices if not overridden per client.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={labelStyle}>Residential Clients</label>
            <select
              value={settings.default_payment_terms_residential}
              onChange={e => setSettings(s => ({ ...s, default_payment_terms_residential: e.target.value }))}
              style={selectStyle}
            >
              {termOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Commercial Clients</label>
            <select
              value={settings.default_payment_terms_commercial}
              onChange={e => setSettings(s => ({ ...s, default_payment_terms_commercial: e.target.value }))}
              style={selectStyle}
            >
              {termOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Default Invoice Notes */}
      <div style={{ background: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, padding: '20px 24px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1A1917', marginBottom: 4, fontFamily: FF }}>Default Invoice Notes</div>
        <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 20, fontFamily: FF }}>Pre-filled on new invoices for each client type.</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Residential</label>
            <textarea
              value={settings.default_invoice_notes_residential}
              onChange={e => setSettings(s => ({ ...s, default_invoice_notes_residential: e.target.value }))}
              placeholder="Thank you for your business!"
              style={textareaStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Commercial</label>
            <textarea
              value={settings.default_invoice_notes_commercial}
              onChange={e => setSettings(s => ({ ...s, default_invoice_notes_commercial: e.target.value }))}
              placeholder="Please include invoice number on your payment."
              style={textareaStyle}
            />
          </div>
        </div>
      </div>

      {/* Automation */}
      <div style={{ background: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, padding: '20px 24px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1A1917', marginBottom: 20, fontFamily: FF }}>Automation</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: '#1A1917', fontFamily: FF }}>Auto-send invoices on job completion</div>
              <div style={{ fontSize: 12, color: '#6B7280', fontFamily: FF, marginTop: 3 }}>Automatically create and send invoice when a job is marked complete</div>
            </div>
            <ToggleSwitch
              checked={settings.auto_send_invoices}
              onChange={v => setSettings(s => ({ ...s, auto_send_invoices: v }))}
            />
          </div>
          <div style={{ borderTop: '1px solid #F0EEE9', paddingTop: 16, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: '#1A1917', fontFamily: FF }}>Auto-charge on invoice creation</div>
              <div style={{ fontSize: 12, color: '#6B7280', fontFamily: FF, marginTop: 3 }}>Automatically charge card on file when invoice is created for clients with auto-charge enabled</div>
            </div>
            <ToggleSwitch
              checked={settings.auto_charge_on_invoice}
              onChange={v => setSettings(s => ({ ...s, auto_charge_on_invoice: v }))}
            />
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          padding: '10px 24px', background: 'var(--brand, #5B9BD5)', color: '#fff',
          border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, alignSelf: 'flex-start',
          cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1, fontFamily: FF,
        }}
      >
        {saving ? 'Saving…' : 'Save Invoicing Settings'}
      </button>
    </div>
  );
}
