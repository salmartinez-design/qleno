import { useState, useEffect, useRef, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useGetMyCompany, useUpdateMyCompany } from "@workspace/api-client-react";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { applyTenantColor } from "@/lib/tenant-brand";
import { useToast } from "@/hooks/use-toast";
import { useBranch } from "@/contexts/branch-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload, X, ImageIcon, CheckCircle, AlertCircle, RefreshCw, Link, Unlink, Clock, BarChart2, Mail, MessageSquare, ChevronDown, ChevronUp, Edit2, Save, Lock } from "lucide-react";
import { HRPoliciesTab } from "./company/hr-policies";
import { DocumentsTab } from "./company/documents";
import { PricingTab } from "./company/pricing";
import { AddonsTab } from "./company/addons-tab";

type Tab = 'general' | 'branding' | 'integrations' | 'payroll' | 'notifications' | 'clock-inout' | 'invoicing' | 'hr-policies' | 'documents' | 'pricing' | 'addons' | 'online-booking' | 'service-zones' | 'follow-up';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'branding', label: 'Branding' },
  { id: 'pricing', label: 'Pricing & Scopes' },
  { id: 'addons', label: 'Add-ons' },
  { id: 'online-booking', label: 'Online Booking' },
  { id: 'service-zones', label: 'Service Zones' },
  { id: 'follow-up', label: 'Follow-Up Sequences' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'clock-inout', label: 'Clock In/Out' },
  { id: 'invoicing', label: 'Invoicing' },
  { id: 'payroll', label: 'Payroll Options' },
  { id: 'hr-policies', label: 'HR Policies' },
  { id: 'documents', label: 'Documents' },
  { id: 'integrations', label: 'Integrations' },
];

export default function CompanyPage() {
  const [activeTab, setActiveTab] = useState<Tab>('branding');
  const { activeBranchId, activeBranch } = useBranch();

  const branchName = activeBranchId === "all" ? null : activeBranch?.name ?? null;

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        <div>
          <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '42px', color: '#1A1917', margin: 0, lineHeight: 1.1 }}>Company Settings</h1>
          <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '13px', color: '#6B7280', marginTop: '6px' }}>Manage your company profile, branding, and integrations.</p>
          {branchName && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 10, backgroundColor: 'var(--brand-dim)', border: '1px solid rgba(91,155,213,0.3)', borderRadius: 8, padding: '6px 12px', fontSize: 12, color: 'var(--brand)', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--brand)', display: 'inline-block' }} />
              Viewing: {branchName} Branch Settings
            </div>
          )}
        </div>

        {/* Tabs */}
        <div style={{ borderBottom: '1px solid #E5E2DC', flexShrink: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0' }}>
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: '9px 16px',
                  fontSize: '13px',
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  fontWeight: activeTab === tab.id ? 600 : 400,
                  cursor: 'pointer',
                  border: 'none',
                  backgroundColor: 'transparent',
                  color: activeTab === tab.id ? 'var(--brand)' : '#6B7280',
                  borderBottom: `2px solid ${activeTab === tab.id ? 'var(--brand)' : 'transparent'}`,
                  marginBottom: '-1px',
                  transition: 'color 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {activeTab === 'branding' && <BrandingTab />}
        {activeTab === 'general' && <GeneralTab />}
        {activeTab === 'notifications' && <NotificationsTab />}
        {activeTab === 'clock-inout' && <ClockInOutTab />}
        {activeTab === 'invoicing' && <InvoicingTab />}
        {activeTab === 'integrations' && <IntegrationsTab />}
        {activeTab === 'payroll' && <PayrollOptionsTab />}
        {activeTab === 'pricing' && <PricingTab />}
        {activeTab === 'addons' && <AddonsTab />}
        {activeTab === 'online-booking' && <OnlineBookingTab />}
        {activeTab === 'service-zones' && <ServiceZonesTab />}
        {activeTab === 'follow-up' && <FollowUpSequencesTab />}
        {activeTab === 'hr-policies' && <HRPoliciesTab />}
        {activeTab === 'documents' && <DocumentsTab />}
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

const HOUR_OPTIONS = Array.from({ length: 19 }, (_, i) => {
  const h = i + 5; // 5 AM → 11 PM
  const label = h === 12 ? "12:00 PM" : h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
  return { value: h, label };
});

function BranchContactCard({ branchId }: { branchId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const FF = "'Plus Jakarta Sans', sans-serif";
  const { data: bco, isLoading } = useQuery({
    queryKey: ['branch-company', branchId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/branches/${branchId}/company`, { headers: getAuthHeaders() });
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
  });
  const [bName, setBName] = useState('');
  const [bPhone, setBPhone] = useState('');
  const [bEmail, setBEmail] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (bco) { setBName(bco.name || ''); setBPhone(bco.phone || ''); setBEmail(bco.email || ''); }
  }, [bco]);
  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/branches/${branchId}/company`, {
        method: 'PATCH', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: bName, phone: bPhone, email: bEmail }),
      });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ['branch-company', branchId] });
      toast({ title: 'Branch contact info saved' });
    } catch { toast({ variant: 'destructive', title: 'Failed to save' }); }
    setSaving(false);
  };
  const inputStyle: React.CSSProperties = { width: '100%', fontFamily: FF, fontSize: '13px', color: '#1A1917', backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '6px', padding: '10px 14px', outline: 'none', boxSizing: 'border-box' as any };
  return (
    <div style={{ backgroundColor: 'var(--brand-dim)', border: '1px solid rgba(91,155,213,0.25)', borderRadius: 10, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <p style={{ fontFamily: FF, fontWeight: 700, fontSize: 14, color: 'var(--brand)', margin: '0 0 4px' }}>Branch Contact Info</p>
        <p style={{ fontFamily: FF, fontSize: 12, color: '#6B7280', margin: 0 }}>Name, phone, and email shown on invoices, emails, and booking pages for this branch.</p>
      </div>
      {isLoading ? <div style={{ fontSize: 13, color: '#9E9B94' }}>Loading…</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontFamily: FF, fontSize: 12, fontWeight: 600, color: '#6B7280', display: 'block', marginBottom: 4 }}>Branch Name</label>
            <input value={bName} onChange={e => setBName(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontFamily: FF, fontSize: 12, fontWeight: 600, color: '#6B7280', display: 'block', marginBottom: 4 }}>Phone</label>
            <input value={bPhone} onChange={e => setBPhone(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontFamily: FF, fontSize: 12, fontWeight: 600, color: '#6B7280', display: 'block', marginBottom: 4 }}>Email</label>
            <input value={bEmail} onChange={e => setBEmail(e.target.value)} type="email" style={inputStyle} />
          </div>
          <button onClick={handleSave} disabled={saving}
            style={{ alignSelf: 'flex-start', padding: '8px 20px', backgroundColor: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: FF, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Save Contact Info'}
          </button>
        </div>
      )}
    </div>
  );
}

function GeneralTab() {
  const { data: company } = useGetMyCompany({ request: { headers: getAuthHeaders() } });
  const updateCompany = useUpdateMyCompany({ request: { headers: getAuthHeaders() } });
  const { toast } = useToast();
  const { activeBranchId } = useBranch();
  const [name, setName] = useState('');
  const [payCadence, setPayCadence] = useState('biweekly');
  const [paymentTermsDays, setPaymentTermsDays] = useState(0);
  const [overheadRatePct, setOverheadRatePct] = useState(10);
  const [dispatchStartHour, setDispatchStartHour] = useState(8);
  const [dispatchEndHour, setDispatchEndHour] = useState(18);
  const [reviewLink, setReviewLink] = useState('');

  useEffect(() => {
    if (company) {
      setName(company.name || '');
      setPayCadence(company.pay_cadence || 'biweekly');
      setPaymentTermsDays((company as any).payment_terms_days ?? 0);
      setOverheadRatePct(parseFloat(String((company as any).overhead_rate_pct ?? 10)));
      setDispatchStartHour((company as any).dispatch_start_hour ?? 8);
      setDispatchEndHour((company as any).dispatch_end_hour ?? 18);
      setReviewLink((company as any).review_link || '');
    }
  }, [company]);

  const handleSave = () => {
    if (dispatchEndHour <= dispatchStartHour) {
      toast({ variant: "destructive", title: "Invalid hours", description: "End time must be after start time." });
      return;
    }
    updateCompany.mutate(
      { data: { name, pay_cadence: payCadence as any, payment_terms_days: paymentTermsDays, overhead_rate_pct: overheadRatePct, dispatch_start_hour: dispatchStartHour, dispatch_end_hour: dispatchEndHour, review_link: reviewLink || null } as any },
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
      {activeBranchId !== "all" && <BranchContactCard branchId={activeBranchId as number} />}
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
      <Section title="Google Review Link" desc="Paste your Google review URL here. Used in post-job review request messages. Leave blank to disable review requests.">
        <input
          type="url"
          value={reviewLink}
          onChange={e => setReviewLink(e.target.value)}
          placeholder="https://g.page/r/your-review-link"
          style={{ width: '100%', fontFamily: FF, fontSize: '13px', color: '#1A1917', backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '6px', padding: '10px 14px', outline: 'none', boxSizing: 'border-box' }}
        />
        {reviewLink && (
          <p style={{ fontFamily: FF, fontSize: 11, color: '#6B7280', marginTop: 6 }}>
            <a href={reviewLink} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand)', textDecoration: 'underline' }}>Test link</a>
          </p>
        )}
      </Section>
      <Section title="Overhead Rate %" desc="Used in the profitability breakdown to allocate indirect costs (insurance, software, office, vehicle) per client.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="number" min="0" max="100" step="0.5"
            value={overheadRatePct}
            onChange={e => setOverheadRatePct(parseFloat(e.target.value) || 0)}
            style={{ width: 100, fontFamily: FF, fontSize: '14px', color: '#1A1917', backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '6px', padding: '10px 14px', outline: 'none', textAlign: 'right' as const }}
          />
          <span style={{ fontFamily: FF, fontSize: 13, color: '#6B7280' }}>% of revenue</span>
        </div>
        <p style={{ fontFamily: FF, fontSize: 11, color: '#9E9B94', margin: '6px 0 0' }}>
          Typical range: 8–15%. Default is 10%.
        </p>
      </Section>
      <Section title="Dispatch Board Hours" desc="The dispatch timeline will only show this window by default. Jobs outside this range cannot be scheduled from the board.">
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontFamily: FF, fontSize: '11px', fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>Start</label>
            <select value={dispatchStartHour} onChange={e => setDispatchStartHour(parseInt(e.target.value))} style={selectStyle}>
              {HOUR_OPTIONS.filter(o => o.value < dispatchEndHour).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ paddingTop: 20, color: '#9E9B94', fontFamily: FF, fontSize: 13 }}>to</div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontFamily: FF, fontSize: '11px', fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>End</label>
            <select value={dispatchEndHour} onChange={e => setDispatchEndHour(parseInt(e.target.value))} style={selectStyle}>
              {HOUR_OPTIONS.filter(o => o.value > dispatchStartHour).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <p style={{ fontFamily: FF, fontSize: 11, color: '#9E9B94', margin: '8px 0 0' }}>
          Default: 8:00 AM – 6:00 PM. Changes take effect on next page load.
        </p>
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

// ─── QB Integrations Tab ──────────────────────────────────────────────────────

interface QbStatus {
  connected: boolean;
  company_name: string | null;
  last_sync_at: string | null;
  realm_id: string | null;
  invoice_sequence_start: number | null;
}

interface QbLogEntry {
  id: number;
  entity_type: string;
  entity_id: number;
  status: string;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

function IntegrationsTab() {
  const { toast } = useToast();
  const [status, setStatus] = useState<QbStatus | null>(null);
  const [logs, setLogs] = useState<QbLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const f = (path: string, opts?: RequestInit) =>
    fetch(`${API}/api/integrations/quickbooks${path}`, {
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      ...opts,
    });

  const loadStatus = useCallback(async () => {
    try {
      setLoading(true);
      const [sRes, lRes] = await Promise.all([f("/status"), f("/log")]);
      if (sRes.ok) setStatus(await sRes.json());
      if (lRes.ok) setLogs(await lRes.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleConnect = () => {
    window.location.href = `${API}/api/integrations/quickbooks/connect`;
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect QuickBooks? Sync will stop until you reconnect.")) return;
    setDisconnecting(true);
    try {
      const res = await f("/disconnect", { method: "POST" });
      if (res.ok) {
        toast({ title: "QuickBooks disconnected" });
        loadStatus();
      } else {
        toast({ title: "Failed to disconnect", variant: "destructive" });
      }
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await f("/sync", { method: "POST" });
      if (res.ok) {
        toast({ title: "Full sync started", description: "Customers, invoices, and payments are being synced." });
        setTimeout(loadStatus, 3000);
      } else {
        toast({ title: "Sync failed", variant: "destructive" });
      }
    } finally {
      setSyncing(false);
    }
  };

  const S: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #E5E2DC', borderRadius: '12px', padding: '24px', marginBottom: '16px' },
    row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' as const, gap: '12px' },
    label: { fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '14px', color: '#1A1917' },
    sub: { fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 400, fontSize: '13px', color: '#6B7280', marginTop: '2px' },
    btn: { fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' },
    btnPrimary: { background: '#00C9A0', color: '#fff' },
    btnDanger: { background: '#FEE2E2', color: '#DC2626' },
    btnGhost: { background: '#F5F4F1', color: '#1A1917' },
    badge: { display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600, fontFamily: "'Plus Jakarta Sans', sans-serif" },
    badgeGreen: { background: '#D1FAF0', color: '#059669' },
    badgeGray: { background: '#F3F4F6', color: '#6B7280' },
  };

  if (loading) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', fontFamily: "'Plus Jakarta Sans', sans-serif", color: '#6B7280' }}>
        Loading integrations...
      </div>
    );
  }

  const connected = status?.connected ?? false;
  const lastSync = status?.last_sync_at ? new Date(status.last_sync_at).toLocaleString() : "Never";

  return (
    <div>
      {/* QB Card */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' as const, gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            {/* QB Logo placeholder — green square with "QB" */}
            <div style={{ width: '48px', height: '48px', borderRadius: '10px', background: '#2CA01C', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 800, fontSize: '16px', color: '#fff', letterSpacing: '-0.5px' }}>QB</span>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={S.label}>QuickBooks Online</span>
                <span style={{ ...S.badge, ...(connected ? S.badgeGreen : S.badgeGray) }}>
                  {connected ? <CheckCircle size={11} /> : <AlertCircle size={11} />}
                  {connected ? "Connected" : "Not connected"}
                </span>
              </div>
              {connected && status?.company_name && (
                <div style={S.sub}>{status.company_name}</div>
              )}
              {!connected && (
                <div style={S.sub}>Connect to sync customers, invoices, and payments automatically.</div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' as const }}>
            {connected ? (
              <>
                <button style={{ ...S.btn, ...S.btnGhost }} onClick={handleSync} disabled={syncing}>
                  <RefreshCw size={14} style={{ animation: syncing ? 'spin 1s linear infinite' : undefined }} />
                  {syncing ? "Syncing..." : "Sync Now"}
                </button>
                <button style={{ ...S.btn, ...S.btnDanger }} onClick={handleDisconnect} disabled={disconnecting}>
                  <Unlink size={14} />
                  {disconnecting ? "Disconnecting..." : "Disconnect"}
                </button>
              </>
            ) : (
              <button style={{ ...S.btn, ...S.btnPrimary }} onClick={handleConnect}>
                <Link size={14} />
                Connect QuickBooks
              </button>
            )}
          </div>
        </div>

        {connected && (
          <div style={{ marginTop: '20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
            <div style={{ background: '#F9F8F6', borderRadius: '8px', padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <Clock size={13} color="#6B7280" />
                <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 500, fontSize: '12px', color: '#6B7280' }}>Last Synced</span>
              </div>
              <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '13px', color: '#1A1917' }}>{lastSync}</div>
            </div>
            <div style={{ background: '#F9F8F6', borderRadius: '8px', padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <BarChart2 size={13} color="#6B7280" />
                <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 500, fontSize: '12px', color: '#6B7280' }}>Invoice Start #</span>
              </div>
              <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '13px', color: '#1A1917' }}>
                {status?.invoice_sequence_start ?? "—"}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Sync Log */}
      {connected && logs.length > 0 && (
        <div style={S.card}>
          <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '15px', color: '#1A1917', marginBottom: '14px' }}>Recent Sync Activity</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0px' }}>
            {logs.slice(0, 15).map((entry, i) => (
              <div
                key={entry.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 0',
                  borderBottom: i < Math.min(logs.length, 15) - 1 ? '1px solid #F5F4F1' : 'none',
                  gap: '12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <span
                    style={{
                      ...S.badge,
                      ...(entry.status === 'success' ? S.badgeGreen : { background: '#FEE2E2', color: '#DC2626' }),
                      flexShrink: 0,
                    }}
                  >
                    {entry.status === 'success' ? <CheckCircle size={10} /> : <AlertCircle size={10} />}
                    {entry.status}
                  </span>
                  <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 500, fontSize: '13px', color: '#1A1917', textTransform: 'capitalize' }}>
                    {entry.entity_type.replace(/_/g, ' ')} #{entry.entity_id}
                  </span>
                  {entry.error_message && (
                    <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '12px', color: '#DC2626', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      — {entry.error_message}
                    </span>
                  )}
                </div>
                <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '12px', color: '#9CA3AF', flexShrink: 0 }}>
                  {new Date(entry.created_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!connected && (
        <div style={{ ...S.card, background: '#F9F8F6', border: '1px dashed #D1D5DB' }}>
          <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '14px', color: '#6B7280', marginBottom: '8px' }}>What syncs automatically</div>
          {[
            "New clients are created as QuickBooks customers",
            "Invoices are pushed to QuickBooks when created or updated",
            "Payments are recorded in QuickBooks when invoices are marked paid",
            "Invoice numbers start at your configured sequence (PHES: 6082)",
          ].map((item) => (
            <div key={item} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '6px' }}>
              <CheckCircle size={14} color="#00C9A0" style={{ marginTop: '1px', flexShrink: 0 }} />
              <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '13px', color: '#4B5563' }}>{item}</span>
            </div>
          ))}
        </div>
      )}
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

function PayrollOptionsTab() {
  const { data: company } = useGetMyCompany({ request: { headers: getAuthHeaders() } });
  const updateCompany = useUpdateMyCompany({ request: { headers: getAuthHeaders() } });
  const { toast } = useToast();
  const [mileageRate, setMileageRate] = useState('0.700');
  const [resTechPayPct, setResTechPayPct] = useState('35');
  const [commercialHourlyRate, setCommercialHourlyRate] = useState('20');
  const [commercialCompMode, setCommercialCompMode] = useState('allowed_hours');
  const [trainingPayRate, setTrainingPayRate] = useState('20');
  const [minJobPayHours, setMinJobPayHours] = useState('3');
  const [recleanTechRate, setRecleanTechRate] = useState('20');
  const [companyPayFloor, setCompanyPayFloor] = useState('18');
  const [unavailableReclassRate, setUnavailableReclassRate] = useState('20');
  const [qpThreshold, setQpThreshold] = useState('2');
  const [qpWindowDays, setQpWindowDays] = useState('30');
  const [qpPayRate, setQpPayRate] = useState('20');
  const [saving, setSaving] = useState(false);
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
  const role = getTokenRole();
  const isOwner = role === 'owner' || role === 'super_admin';

  useEffect(() => {
    const c = company?.data as any;
    if (c?.res_tech_pay_pct != null) setResTechPayPct(String(Math.round(parseFloat(c.res_tech_pay_pct) * 100)));
    if (c?.commercial_hourly_rate != null) setCommercialHourlyRate(String(c.commercial_hourly_rate));
    if (c?.commercial_comp_mode != null) setCommercialCompMode(c.commercial_comp_mode);
    // Load detailed payroll settings from payroll_settings table
    fetch(`${BASE}/api/payroll-settings`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const ps = d?.data;
        if (!ps) return;
        if (ps.res_tech_pay_pct != null) setResTechPayPct(String(ps.res_tech_pay_pct));
        if (ps.commercial_hourly_rate != null) setCommercialHourlyRate(String(ps.commercial_hourly_rate));
        if (ps.commercial_pay_default != null) setCommercialCompMode(ps.commercial_pay_default);
        if (ps.training_pay_rate != null) setTrainingPayRate(String(ps.training_pay_rate));
        if (ps.minimum_job_pay_hours != null) setMinJobPayHours(String(ps.minimum_job_pay_hours));
        if (ps.reclean_tech_rate != null) setRecleanTechRate(String(ps.reclean_tech_rate));
        if (ps.company_pay_floor != null) setCompanyPayFloor(String(ps.company_pay_floor));
        if (ps.unavailable_reclassification_rate != null) setUnavailableReclassRate(String(ps.unavailable_reclassification_rate));
        if (ps.quality_probation_threshold_complaints != null) setQpThreshold(String(ps.quality_probation_threshold_complaints));
        if (ps.quality_probation_window_days != null) setQpWindowDays(String(ps.quality_probation_window_days));
        if (ps.quality_probation_pay_rate != null) setQpPayRate(String(ps.quality_probation_pay_rate));
        if (ps.mileage_rate != null) setMileageRate(String(ps.mileage_rate));
      });
  }, [company?.data]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`${BASE}/api/payroll-settings`, {
        method: 'PATCH',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          res_tech_pay_pct: parseFloat(resTechPayPct),
          commercial_hourly_rate: parseFloat(commercialHourlyRate),
          commercial_pay_default: commercialCompMode,
          training_pay_rate: parseFloat(trainingPayRate),
          minimum_job_pay_hours: parseFloat(minJobPayHours),
          reclean_tech_rate: parseFloat(recleanTechRate),
          company_pay_floor: parseFloat(companyPayFloor),
          unavailable_reclassification_rate: parseFloat(unavailableReclassRate),
          quality_probation_threshold_complaints: parseInt(qpThreshold),
          quality_probation_window_days: parseInt(qpWindowDays),
          quality_probation_pay_rate: parseFloat(qpPayRate),
          mileage_rate: parseFloat(mileageRate),
        }),
      });
      // Also sync to companies table for backward compat
      await fetch(`${BASE}/api/companies/me`, {
        method: 'PATCH',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          res_tech_pay_pct: parseFloat(resTechPayPct) / 100,
          commercial_hourly_rate: parseFloat(commercialHourlyRate),
          commercial_comp_mode: commercialCompMode,
        }),
      });
      toast({ title: 'Payroll settings saved' });
    } catch {
      toast({ title: 'Failed to save', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const FF2 = "'Plus Jakarta Sans', sans-serif";
  const fieldLabel = { fontSize: 11, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase' as const, letterSpacing: '0.06em', display: 'block', marginBottom: 5, fontFamily: FF2 };
  const fieldInput: React.CSSProperties = { padding: '9px 12px', border: '1px solid #E5E2DC', borderRadius: 8, fontSize: 13, fontFamily: FF2, background: '#fff', color: '#1A1917', width: 160, outline: 'none' };
  const sectionCard: React.CSSProperties = { background: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, padding: '20px 24px' };

  const inputStyle = (base: React.CSSProperties): React.CSSProperties =>
    isOwner ? base : { ...base, background: '#F9FAFB', color: '#9CA3AF', cursor: 'not-allowed' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 640 }}>
      <div>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#1A1917', margin: '0 0 4px', fontFamily: FF2 }}>Payroll Options</h3>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0, fontFamily: FF2 }}>Configure pay cadence, reimbursement, and technician compensation.</p>
      </div>

      {!isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#FFFBEB', border: '1px solid #FCD34D', borderRadius: 8, padding: '10px 14px' }}>
          <Lock size={14} color="#D97706" />
          <span style={{ fontSize: 13, color: '#92400E', fontFamily: FF2 }}>
            Payroll settings are <strong>read-only</strong> for your role. Contact your owner to make changes.
          </span>
        </div>
      )}

      <div style={sectionCard}>
        <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: '0 0 16px', fontFamily: FF2 }}>Residential Tech Commission</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={fieldLabel}>Commission % of Job Total (per tech)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="number" step="1" min="1" max="100" value={resTechPayPct}
              onChange={e => setResTechPayPct(e.target.value)} style={inputStyle(fieldInput)} placeholder="35"
              disabled={!isOwner}
            />
            <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF2 }}>%</span>
          </div>
          <p style={{ fontSize: 12, color: '#9E9B94', margin: 0, fontFamily: FF2 }}>Formula: Job Total × pct ÷ number of techs on job. Default 35%.</p>
        </div>
      </div>

      <div style={sectionCard}>
        <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: '0 0 16px', fontFamily: FF2 }}>Commercial Tech Compensation</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={fieldLabel}>Hourly Rate for Commercial Jobs</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#1A1917' }}>$</span>
              <input
                type="number" step="0.25" min="0" value={commercialHourlyRate}
                onChange={e => setCommercialHourlyRate(e.target.value)} style={fieldInput} placeholder="20.00"
              />
              <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF2 }}>/hr</span>
            </div>
          </div>
          <div>
            <label style={fieldLabel}>Default Hours Used for Pay Calculation</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { value: 'allowed_hours', label: 'Allowed Hours', desc: 'Scheduled / estimated hours' },
                { value: 'worked_hours', label: 'Worked Hours', desc: 'Actual clocked time' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setCommercialCompMode(opt.value)}
                  style={{
                    flex: 1, padding: '12px 14px', borderRadius: 8, cursor: 'pointer', textAlign: 'left' as const,
                    border: `2px solid ${commercialCompMode === opt.value ? 'var(--brand, #5B9BD5)' : '#E5E2DC'}`,
                    background: commercialCompMode === opt.value ? 'rgba(91,155,213,0.07)' : '#fff',
                    fontFamily: FF2,
                  }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: '0 0 2px' }}>{opt.label}</p>
                  <p style={{ fontSize: 11, color: '#9E9B94', margin: 0 }}>{opt.desc}</p>
                </button>
              ))}
            </div>
            <p style={{ fontSize: 12, color: '#9E9B94', margin: '6px 0 0', fontFamily: FF2 }}>Formula: rate × hours. Can be overridden per job.</p>
          </div>
        </div>
      </div>

      <div style={sectionCard}>
        <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: '0 0 16px', fontFamily: FF2 }}>Mileage Reimbursement</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={fieldLabel}>Rate per mile</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#1A1917' }}>$</span>
            <input
              type="number" step="0.001" min="0" value={mileageRate}
              onChange={e => setMileageRate(e.target.value)} style={fieldInput} placeholder="0.700"
            />
          </div>
          <p style={{ fontSize: 12, color: '#9E9B94', margin: 0, fontFamily: FF2 }}>Updated annually to match the IRS standard mileage rate.</p>
        </div>
      </div>

      <div style={sectionCard}>
        <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: '0 0 4px', fontFamily: FF2 }}>Training Pay</p>
        <p style={{ fontSize: 12, color: '#9E9B94', margin: '0 0 16px', fontFamily: FF2 }}>While training status is active (default hire date + 21 days), tech earns this flat rate — no commission.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={fieldLabel}>Training Pay Rate</label>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#1A1917' }}>$</span>
          <input type="number" step="0.25" min="0" value={trainingPayRate} onChange={e => setTrainingPayRate(e.target.value)} style={fieldInput} placeholder="20.00" />
          <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF2 }}>/hr</span>
        </div>
      </div>

      <div style={sectionCard}>
        <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: '0 0 4px', fontFamily: FF2 }}>Minimum Job Pay</p>
        <p style={{ fontSize: 12, color: '#9E9B94', margin: '0 0 16px', fontFamily: FF2 }}>Every dispatched job guarantees this many hours of pay. If actual hours are less, the minimum is paid.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={fieldLabel}>Minimum Job Pay Hours</label>
          <input type="number" step="0.5" min="1" value={minJobPayHours} onChange={e => setMinJobPayHours(e.target.value)} style={fieldInput} placeholder="3" />
          <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF2 }}>hours</span>
        </div>
      </div>

      <div style={sectionCard}>
        <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: '0 0 4px', fontFamily: FF2 }}>Re-Clean & Recovery Pay</p>
        <p style={{ fontSize: 12, color: '#9E9B94', margin: '0 0 16px', fontFamily: FF2 }}>Rates used when jobs are reclassified due to quality issues. Pay floor is a weekly safety net — not per job.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ ...fieldLabel, width: 220 }}>Re-Clean Tech Rate</label>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#1A1917' }}>$</span>
            <input type="number" step="0.25" min="0" value={recleanTechRate} onChange={e => setRecleanTechRate(e.target.value)} style={fieldInput} placeholder="20.00" />
            <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF2 }}>/hr</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ ...fieldLabel, width: 220 }}>Company Pay Floor (weekly)</label>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#1A1917' }}>$</span>
            <input type="number" step="0.25" min="0" value={companyPayFloor} onChange={e => setCompanyPayFloor(e.target.value)} style={fieldInput} placeholder="18.00" />
            <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF2 }}>/hr</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ ...fieldLabel, width: 220 }}>Unavailable Reclassification Rate</label>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#1A1917' }}>$</span>
            <input type="number" step="0.25" min="0" value={unavailableReclassRate} onChange={e => setUnavailableReclassRate(e.target.value)} style={fieldInput} placeholder="20.00" />
            <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF2 }}>/hr</span>
          </div>
        </div>
      </div>

      <div style={sectionCard}>
        <p style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', margin: '0 0 4px', fontFamily: FF2 }}>Quality Probation</p>
        <p style={{ fontSize: 12, color: '#9E9B94', margin: '0 0 16px', fontFamily: FF2 }}>Triggered when a tech accumulates N complaints within a rolling window. Pay switches to probation rate — no commission.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ ...fieldLabel, width: 220 }}>Probation Threshold (complaints)</label>
            <input type="number" step="1" min="1" value={qpThreshold} onChange={e => setQpThreshold(e.target.value)} style={{ ...fieldInput, width: 80 }} placeholder="2" />
            <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF2 }}>in</span>
            <input type="number" step="1" min="1" value={qpWindowDays} onChange={e => setQpWindowDays(e.target.value)} style={{ ...fieldInput, width: 80 }} placeholder="30" />
            <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF2 }}>days</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ ...fieldLabel, width: 220 }}>Quality Probation Pay Rate</label>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#1A1917' }}>$</span>
            <input type="number" step="0.25" min="0" value={qpPayRate} onChange={e => setQpPayRate(e.target.value)} style={fieldInput} placeholder="20.00" />
            <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF2 }}>/hr flat</span>
          </div>
        </div>
      </div>

      {isOwner ? (
        <button
          onClick={handleSave}
          disabled={saving}
          style={{ padding: '9px 20px', background: 'var(--brand, #00C9A0)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, fontFamily: FF2, cursor: 'pointer', alignSelf: 'flex-start' }}
        >
          {saving ? 'Saving...' : 'Save Payroll Settings'}
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#9CA3AF', fontSize: 12, fontFamily: FF2 }}>
          <Lock size={12} />
          <span>Owner-only — read-only view</span>
        </div>
      )}
    </div>
  );
}

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

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
  const [arrivalAlertWindow, setArrivalAlertWindow] = useState("45");
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
        setArrivalAlertWindow(String(c.arrival_alert_window_minutes ?? 45));
      })
      .finally(() => setLoading(false));
  }, []);

  async function saveSmsSettings() {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/companies/me`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, twilio_from_number: twilioFrom || null, arrival_alert_window_minutes: parseInt(arrivalAlertWindow) || 45 }),
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
        <p style={{ fontSize: 11, fontWeight: 700, color: '#9E9B94', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Arrival Alert Window</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="number"
            min="5"
            max="120"
            value={arrivalAlertWindow}
            onChange={e => setArrivalAlertWindow(e.target.value)}
            style={{ width: 80, padding: '9px 12px', border: '1px solid #E5E2DC', borderRadius: 8, fontSize: 13, fontFamily: FF, outline: 'none' }}
          />
          <span style={{ fontSize: 13, color: '#6B6860', fontFamily: FF }}>minutes before arrival — client receives "on my way" SMS</span>
        </div>
        <p style={{ fontSize: 11, color: '#9E9B94', margin: '5px 0 0' }}>Used as the <span style={{ fontFamily: 'monospace' }}>&#123;&#123;arrival_alert_window&#125;&#125;</span> placeholder in SMS templates.</p>
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

// ── Online Booking Tab ────────────────────────────────────────────────────────
type BookingAvailDays = { sun: boolean; mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean };
const AVAIL_DAY_LABELS: { key: keyof BookingAvailDays; label: string }[] = [
  { key: 'sun', label: 'Sun' },
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
];

function OnlineBookingTab() {
  const FF = "'Plus Jakarta Sans', sans-serif";
  const { toast } = useToast();
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

  const [leadDays, setLeadDays] = useState(7);
  const [maxAdvanceDays, setMaxAdvanceDays] = useState(60);
  const [avail, setAvail] = useState<BookingAvailDays>({ sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/companies/booking-settings`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => {
        if (d && !d.error) {
          setLeadDays(d.booking_lead_days ?? 7);
          setMaxAdvanceDays(d.max_advance_days ?? 60);
          setAvail({
            sun: !!d.available_sun, mon: !!d.available_mon, tue: !!d.available_tue,
            wed: !!d.available_wed, thu: !!d.available_thu, fri: !!d.available_fri, sat: !!d.available_sat,
          });
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [BASE]);

  async function handleSave() {
    setSaving(true);
    try {
      const r = await fetch(`${BASE}/api/companies/booking-settings`, {
        method: 'PUT',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          booking_lead_days: leadDays,
          max_advance_days: maxAdvanceDays,
          available_sun: avail.sun, available_mon: avail.mon, available_tue: avail.tue,
          available_wed: avail.wed, available_thu: avail.thu, available_fri: avail.fri, available_sat: avail.sat,
        }),
      });
      if (!r.ok) throw new Error('Failed');
      toast({ title: 'Saved', description: 'Online booking settings updated.' });
    } catch {
      toast({ title: 'Error', description: 'Could not save settings.', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  function toggleDay(key: keyof BookingAvailDays) {
    setAvail(prev => ({ ...prev, [key]: !prev[key] }));
  }

  const cardStyle = { background: '#fff', border: '1px solid #E5E2DC', borderRadius: 10, padding: '20px 24px' };
  const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#6B7280', marginBottom: 6, fontFamily: FF };
  const numInputStyle: React.CSSProperties = {
    width: 90, padding: '9px 12px', border: '1px solid #E5E2DC', borderRadius: 8,
    fontSize: 14, color: '#1A1917', background: '#fff', outline: 'none', fontFamily: FF,
  };

  if (!loaded) return <div style={{ padding: 24, color: '#9E9B94', fontFamily: FF, fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1A1917', marginBottom: 20, fontFamily: FF }}>Booking Lead Time</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <label style={labelStyle}>Minimum notice before a client can book (calendar days)</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="number" min={1} max={60} value={leadDays}
                onChange={e => setLeadDays(Math.max(1, Math.min(60, parseInt(e.target.value) || 1)))}
                style={numInputStyle}
              />
              <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF }}>days from today</span>
            </div>
            <p style={{ fontSize: 12, color: '#9E9B94', marginTop: 8, fontFamily: FF }}>
              Dates within this window are blocked on the booking calendar.
            </p>
          </div>
          <div>
            <label style={labelStyle}>How far in advance clients can book (calendar days)</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="number" min={14} max={365} value={maxAdvanceDays}
                onChange={e => setMaxAdvanceDays(Math.max(14, Math.min(365, parseInt(e.target.value) || 60)))}
                style={numInputStyle}
              />
              <span style={{ fontSize: 13, color: '#6B7280', fontFamily: FF }}>days out</span>
            </div>
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1A1917', marginBottom: 4, fontFamily: FF }}>Available Days</div>
        <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 18, fontFamily: FF }}>
          Select which days of the week clients can book. Unavailable days are hidden on the calendar.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {AVAIL_DAY_LABELS.map(({ key, label }) => {
            const on = avail[key];
            return (
              <button
                key={key}
                onClick={() => toggleDay(key)}
                style={{
                  padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, fontFamily: FF,
                  border: `2px solid ${on ? 'var(--brand, #5B9BD5)' : '#E5E2DC'}`,
                  background: on ? 'var(--brand, #5B9BD5)' : '#fff',
                  color: on ? '#fff' : '#6B7280',
                  cursor: 'pointer', transition: 'all 0.1s',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1A1917', marginBottom: 8, fontFamily: FF }}>New Booking Assignment</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ fontSize: 12, color: '#6B7280', fontFamily: FF }}>
            All bookings submitted through the widget are placed in the Unassigned queue for manual dispatch. This cannot be changed.
          </div>
          <div style={{ padding: '6px 14px', background: '#F7F6F3', border: '1px solid #E5E2DC', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#1A1917', fontFamily: FF, flexShrink: 0 }}>
            Unassigned (required)
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
        {saving ? 'Saving…' : 'Save Booking Settings'}
      </button>
    </div>
  );
}

// ─── SERVICE ZONES TAB ────────────────────────────────────────────────────────
const SZ_COLORS = ["#FF69B4","#5B9BD5","#2D6A4F","#7F77DD","#F97316","#E53E3E","#0D9488","#EAB308","#43F411","#FFB200","#C96969"];

function SzLocationBadge({ loc }: { loc: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", padding: "2px 8px",
      borderRadius: 10, fontSize: 10, fontFamily: FF, fontWeight: 600, letterSpacing: "0.03em",
      backgroundColor: loc === "schaumburg" ? "#2D6A4F" : "#5B9BD5", color: "#FFFFFF",
    }}>
      {loc === "schaumburg" ? "Schaumburg" : "Oak Lawn"}
    </span>
  );
}

interface SzZone {
  id: number; name: string; color: string; zip_codes: string[];
  is_active: boolean; location: string; employee_count: number; jobs_this_month: number;
}

function ServiceZonesTab() {
  const FF = "'Plus Jakarta Sans', sans-serif";
  const SZ_API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { toast } = useToast();
  const [zones, setZones] = useState<SzZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [locFilter, setLocFilter] = useState<"all" | "oak_lawn" | "schaumburg">("all");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [addZipInputs, setAddZipInputs] = useState<Record<number, string>>({});
  const [addZipErrors, setAddZipErrors] = useState<Record<number, string>>({});
  const [modalOpen, setModalOpen] = useState(false);
  const [editZone, setEditZone] = useState<SzZone | null>(null);
  const [mName, setMName] = useState("");
  const [mLoc, setMLoc] = useState<"oak_lawn" | "schaumburg">("oak_lawn");
  const [mColor, setMColor] = useState("#5B9BD5");
  const [mZips, setMZips] = useState<string[]>([]);
  const [mSaving, setMSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${SZ_API}/api/zones`, { headers: getAuthHeaders() });
      if (r.ok) setZones(await r.json());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = locFilter === "all" ? zones : zones.filter(z => z.location === locFilter);

  const toggleExpand = (id: number) => setExpanded(p => ({ ...p, [id]: !p[id] }));

  const removeZip = async (zoneId: number, zip: string) => {
    try {
      const r = await fetch(`${SZ_API}/api/zones/${zoneId}/zips/${zip}`, { method: "DELETE", headers: getAuthHeaders() });
      if (!r.ok) throw new Error();
      setZones(prev => prev.map(z => z.id === zoneId ? { ...z, zip_codes: z.zip_codes.filter(x => x !== zip) } : z));
    } catch { toast({ title: "Failed to remove zip", variant: "destructive" }); }
  };

  const addZip = async (zoneId: number) => {
    const raw = addZipInputs[zoneId] || "";
    const clean = raw.trim().replace(/\D/g, "").slice(0, 5);
    if (clean.length !== 5) {
      setAddZipErrors(p => ({ ...p, [zoneId]: "Enter a 5-digit zip" }));
      return;
    }
    try {
      const r = await fetch(`${SZ_API}/api/zones/${zoneId}/zips`, {
        method: "POST", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ zip: clean }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (data.error === "zip_conflict" && data.conflicts?.length) {
          setAddZipErrors(p => ({ ...p, [zoneId]: `${clean} is already in "${data.conflicts[0].existingZone}"` }));
        } else {
          setAddZipErrors(p => ({ ...p, [zoneId]: data.error || "Error" }));
        }
        return;
      }
      setZones(prev => prev.map(z => z.id === zoneId ? { ...z, zip_codes: data.zip_codes } : z));
      setAddZipInputs(p => ({ ...p, [zoneId]: "" }));
      setAddZipErrors(p => ({ ...p, [zoneId]: "" }));
    } catch { toast({ title: "Failed to add zip", variant: "destructive" }); }
  };

  const deleteZone = async (z: SzZone) => {
    if (!confirm(`Delete "${z.name}"? This cannot be undone.`)) return;
    try {
      await fetch(`${SZ_API}/api/zones/${z.id}`, { method: "DELETE", headers: getAuthHeaders() });
      toast({ title: "Zone deleted" });
      load();
    } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
  };

  const openAdd = () => {
    setEditZone(null); setMName(""); setMLoc("oak_lawn"); setMColor("#5B9BD5"); setMZips([]);
    setModalOpen(true);
  };
  const openEdit = (z: SzZone) => {
    setEditZone(z); setMName(z.name); setMLoc(z.location as any); setMColor(z.color); setMZips(z.zip_codes || []);
    setModalOpen(true);
  };

  const saveModal = async () => {
    if (!mName.trim()) { toast({ title: "Zone name required", variant: "destructive" }); return; }
    setMSaving(true);
    try {
      const url = editZone ? `${SZ_API}/api/zones/${editZone.id}` : `${SZ_API}/api/zones`;
      const method = editZone ? "PATCH" : "POST";
      const r = await fetch(url, {
        method, headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: mName.trim(), color: mColor, zip_codes: mZips, location: mLoc }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (data.error === "zip_conflict" && data.conflicts?.length) {
          toast({ title: "Zip conflict", description: `${data.conflicts[0].zip} is already in "${data.conflicts[0].existingZone}"`, variant: "destructive" });
        } else {
          throw new Error(data.error || "Save failed");
        }
        return;
      }
      toast({ title: editZone ? "Zone updated" : "Zone created" });
      setModalOpen(false);
      load();
    } catch (e: any) {
      toast({ title: "Failed to save", description: e.message, variant: "destructive" });
    } finally { setMSaving(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontFamily: FF, fontWeight: 700, fontSize: 22, color: "#1A1917", margin: 0 }}>Service Zones</h2>
          <p style={{ fontFamily: FF, fontSize: 13, color: "#6B7280", margin: "4px 0 0" }}>Manage zip code coverage for each location. No zip can exist in two zones.</p>
        </div>
        <button
          onClick={openAdd}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontFamily: FF, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          + Add Zone
        </button>
      </div>

      {/* Location Filter Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #E5E2DC" }}>
        {([["all", "All Zones"], ["oak_lawn", "Oak Lawn"], ["schaumburg", "Schaumburg"]] as const).map(([val, label]) => (
          <button key={val} onClick={() => setLocFilter(val)} style={{
            padding: "8px 16px", border: "none", cursor: "pointer", fontFamily: FF, fontSize: 13, fontWeight: locFilter === val ? 500 : 400,
            color: locFilter === val ? "var(--brand)" : "#6B7280", backgroundColor: "transparent",
            borderBottom: `2px solid ${locFilter === val ? "var(--brand)" : "transparent"}`, marginBottom: -1, transition: "color 0.15s",
          }}>{label}</button>
        ))}
      </div>

      {/* Zone Cards */}
      {loading ? (
        <p style={{ fontFamily: FF, fontSize: 13, color: "#9E9B94", textAlign: "center", padding: 32 }}>Loading zones...</p>
      ) : filtered.length === 0 ? (
        <p style={{ fontFamily: FF, fontSize: 13, color: "#9E9B94", textAlign: "center", padding: 32 }}>No zones{locFilter !== "all" ? " for this location" : ""}. Click "+ Add Zone" to create one.</p>
      ) : filtered.map(z => (
        <div key={z.id} style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          {/* Card Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer" }} onClick={() => toggleExpand(z.id)}>
            <div style={{ width: 16, height: 16, borderRadius: "50%", backgroundColor: z.color, flexShrink: 0 }} />
            <span style={{ fontFamily: FF, fontWeight: 600, fontSize: 14, color: "#1A1917", flex: 1 }}>{z.name}</span>
            <SzLocationBadge loc={z.location} />
            <span style={{ fontFamily: FF, fontSize: 12, color: "#6B7860", marginLeft: 8 }}>
              {(z.zip_codes || []).length} zip{(z.zip_codes || []).length !== 1 ? "s" : ""}
            </span>
            <button onClick={e => { e.stopPropagation(); openEdit(z); }} style={{ padding: "4px 10px", background: "transparent", border: "1px solid #E5E2DC", borderRadius: 6, fontFamily: FF, fontSize: 12, color: "#6B7280", cursor: "pointer" }}>Edit</button>
            <button onClick={e => { e.stopPropagation(); deleteZone(z); }} style={{ padding: "4px 10px", background: "transparent", border: "1px solid #E5E2DC", borderRadius: 6, fontFamily: FF, fontSize: 12, color: "#EF4444", cursor: "pointer" }}>Delete</button>
            <span style={{ color: "#9E9B94", fontSize: 14, marginLeft: 4, userSelect: "none" }}>{expanded[z.id] ? "▲" : "▼"}</span>
          </div>

          {/* Expanded: zip chips + add zip */}
          {expanded[z.id] && (
            <div style={{ borderTop: "1px solid #F0EEE9", padding: "12px 16px", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {(z.zip_codes || []).map(zip => (
                <span key={zip} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 6, fontFamily: FF, fontSize: 12, color: "#1A1917" }}>
                  {zip}
                  <button onClick={() => removeZip(z.id, zip)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#9E9B94", display: "flex", lineHeight: 1 }}>×</button>
                </span>
              ))}
              {/* Add zip inline */}
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    value={addZipInputs[z.id] || ""}
                    onChange={e => { setAddZipInputs(p => ({ ...p, [z.id]: e.target.value })); setAddZipErrors(p => ({ ...p, [z.id]: "" })); }}
                    onKeyDown={e => { if (e.key === "Enter") addZip(z.id); }}
                    placeholder="+ Add zip"
                    maxLength={5}
                    style={{ width: 70, padding: "3px 7px", border: "1px dashed #C0BDB8", borderRadius: 6, fontFamily: FF, fontSize: 12, color: "#1A1917", outline: "none" }}
                  />
                  <button onClick={() => addZip(z.id)} style={{ padding: "3px 8px", background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 6, fontFamily: FF, fontSize: 12, cursor: "pointer" }}>Add</button>
                </div>
                {addZipErrors[z.id] && <p style={{ fontFamily: FF, fontSize: 11, color: "#EF4444", margin: 0 }}>{addZipErrors[z.id]}</p>}
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Add/Edit Zone Modal */}
      {modalOpen && (
        <>
          <div onClick={() => setModalOpen(false)} style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", zIndex: 200 }} />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
            backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, zIndex: 201,
            width: 460, maxHeight: "90vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 20,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ fontFamily: FF, fontWeight: 700, fontSize: 18, color: "#1A1917", margin: 0 }}>{editZone ? "Edit Zone" : "Add Zone"}</h3>
              <button onClick={() => setModalOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", fontSize: 20, lineHeight: 1 }}>×</button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Zone Name</label>
              <input value={mName} onChange={e => setMName(e.target.value)} placeholder="e.g. Southwest Zone"
                style={{ padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontFamily: FF, fontSize: 13, color: "#1A1917", outline: "none" }} />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Location</label>
              <div style={{ display: "flex", borderRadius: 8, border: "1px solid #E5E2DC", overflow: "hidden" }}>
                {([["oak_lawn", "Oak Lawn"], ["schaumburg", "Schaumburg"]] as const).map(([val, label]) => (
                  <button key={val} onClick={() => setMLoc(val)} style={{
                    flex: 1, padding: "9px 0", border: "none", cursor: "pointer", fontFamily: FF, fontSize: 13, fontWeight: 500,
                    backgroundColor: mLoc === val ? (val === "schaumburg" ? "#2D6A4F" : "#5B9BD5") : "#FAFAF9",
                    color: mLoc === val ? "#FFFFFF" : "#6B7280", transition: "all 0.15s",
                  }}>{label}</button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Color</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {SZ_COLORS.map(c => (
                  <button key={c} onClick={() => setMColor(c)} style={{
                    width: 28, height: 28, borderRadius: "50%", backgroundColor: c, border: "none", cursor: "pointer",
                    outline: mColor === c ? `3px solid ${c}` : "none", outlineOffset: 2,
                    boxShadow: mColor === c ? "0 0 0 2px #FFFFFF inset" : "none",
                  }} />
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontFamily: FF, fontWeight: 500, fontSize: 13, color: "#1A1917" }}>Zip Codes</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, minHeight: 44 }}>
                {mZips.map(z => (
                  <span key={z} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", backgroundColor: "#F0EEE9", borderRadius: 12, fontFamily: FF, fontSize: 12, color: "#1A1917" }}>
                    {z}
                    <button onClick={() => setMZips(p => p.filter(x => x !== z))} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 0, lineHeight: 1 }}>×</button>
                  </span>
                ))}
                <input
                  placeholder="Type zip, press Enter"
                  style={{ border: "none", outline: "none", fontFamily: FF, fontSize: 13, color: "#1A1917", minWidth: 140, flex: 1, background: "transparent" }}
                  onKeyDown={e => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      const val = (e.currentTarget.value || "").trim().replace(/\D/g, "").slice(0, 5);
                      if (val.length === 5 && !mZips.includes(val)) setMZips(p => [...p, val]);
                      e.currentTarget.value = "";
                    }
                  }}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={saveModal} disabled={mSaving} style={{
                flex: 1, padding: "10px 0", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none",
                borderRadius: 8, fontFamily: FF, fontSize: 14, fontWeight: 600, cursor: mSaving ? "not-allowed" : "pointer", opacity: mSaving ? 0.7 : 1,
              }}>{mSaving ? "Saving..." : "Save Zone"}</button>
              <button onClick={() => setModalOpen(false)} style={{
                padding: "10px 18px", backgroundColor: "transparent", color: "#6B7280", border: "1px solid #E5E2DC",
                borderRadius: 8, fontFamily: FF, fontSize: 14, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Follow-Up Sequences Tab ──────────────────────────────────────────────────
interface FuStep {
  id: number;
  step_number: number;
  delay_hours: number;
  channel: string;
  subject: string | null;
  message_template: string;
}

interface FuSequence {
  id: number;
  sequence_type: string;
  name: string;
  is_active: boolean;
  steps: FuStep[];
}

const SEQ_LABELS: Record<string, string> = {
  quote_followup: "Quote Follow-Up",
  post_job_retention: "Post-Job Retention",
};

const SEQ_DESCS: Record<string, string> = {
  quote_followup: "Sent automatically after a quote is emailed to a prospect. Stops when the quote is accepted or converted.",
  post_job_retention: "Sent after a job is marked complete to re-engage one-time clients. Stops if the client books a new job.",
};

function delayLabel(hours: number): string {
  if (hours < 24) return `${hours}h after trigger`;
  const d = Math.floor(hours / 24);
  return `Day ${d}`;
}

function FollowUpSequencesTab() {
  const FFF = "'Plus Jakarta Sans', sans-serif";
  const FU_API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { toast } = useToast();

  const [sequences, setSequences] = useState<FuSequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  const [editingStep, setEditingStep] = useState<number | null>(null);
  const [editTemplate, setEditTemplate] = useState("");
  const [editSubject, setEditSubject] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${FU_API}/api/follow-up/sequences`, { headers: getAuthHeaders() as any });
      if (!res.ok) throw new Error("Failed");
      setSequences(await res.json());
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not load sequences." });
    } finally {
      setLoading(false);
    }
  }, [FU_API]);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (seq: FuSequence) => {
    try {
      const res = await fetch(`${FU_API}/api/follow-up/sequences/${seq.id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders() as any, "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !seq.is_active }),
      });
      if (!res.ok) throw new Error("Failed");
      setSequences(prev => prev.map(s => s.id === seq.id ? { ...s, is_active: !s.is_active } : s));
      toast({ title: seq.is_active ? "Sequence paused" : "Sequence activated" });
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not update sequence." });
    }
  };

  const startEditStep = (step: FuStep) => {
    setEditingStep(step.id);
    setEditTemplate(step.message_template);
    setEditSubject(step.subject ?? "");
  };

  const saveStep = async (seqId: number, stepId: number) => {
    setSaving(true);
    try {
      const res = await fetch(`${FU_API}/api/follow-up/steps/${stepId}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders() as any, "Content-Type": "application/json" },
        body: JSON.stringify({ message_template: editTemplate, subject: editSubject || null }),
      });
      if (!res.ok) throw new Error("Failed");
      setSequences(prev => prev.map(s =>
        s.id === seqId
          ? { ...s, steps: s.steps.map(st => st.id === stepId ? { ...st, message_template: editTemplate, subject: editSubject || null } : st) }
          : s
      ));
      setEditingStep(null);
      toast({ title: "Step saved" });
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Could not save step." });
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", fontFamily: FFF, fontSize: 13, color: "#1A1917",
    background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 6,
    padding: "8px 12px", outline: "none", boxSizing: "border-box",
  };

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontFamily: FFF }}>Loading sequences...</div>;

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ fontFamily: FFF, fontSize: 13, color: "#6B6860", marginBottom: 24 }}>
        Automated follow-up messages sent via SMS and email. Each sequence runs independently.
        Toggle a sequence on or off without losing your message templates.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {sequences.map(seq => {
          const isExpanded = expandedSeq === seq.id;
          return (
            <div key={seq.id} style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
              {/* Header */}
              <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 14 }}>
                {/* Toggle */}
                <div
                  onClick={() => toggleActive(seq)}
                  style={{
                    width: 40, height: 22, borderRadius: 11, cursor: "pointer", position: "relative", flexShrink: 0,
                    background: seq.is_active ? "var(--brand)" : "#D1D5DB", transition: "background 0.2s",
                  }}
                >
                  <div style={{
                    position: "absolute", top: 3, left: seq.is_active ? 21 : 3,
                    width: 16, height: 16, borderRadius: "50%", background: "#FFFFFF",
                    transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  }} />
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: FFF, fontWeight: 600, fontSize: 15, color: "#1A1917" }}>
                      {SEQ_LABELS[seq.sequence_type] ?? seq.name}
                    </span>
                    <span style={{
                      padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 600, fontFamily: FFF,
                      background: seq.is_active ? "#DCFCE7" : "#F3F4F6",
                      color: seq.is_active ? "#166534" : "#6B7280",
                    }}>
                      {seq.is_active ? "ACTIVE" : "PAUSED"}
                    </span>
                  </div>
                  <p style={{ fontFamily: FFF, fontSize: 12, color: "#6B6860", margin: "2px 0 0" }}>
                    {SEQ_DESCS[seq.sequence_type] ?? ""}
                  </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <span style={{ fontFamily: FFF, fontSize: 12, color: "#9E9B94" }}>
                    {seq.steps.length} step{seq.steps.length !== 1 ? "s" : ""}
                  </span>
                  <button
                    onClick={() => setExpandedSeq(isExpanded ? null : seq.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#6B6860", padding: 4, display: "flex" }}
                  >
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                </div>
              </div>

              {/* Steps */}
              {isExpanded && (
                <div style={{ borderTop: "1px solid #F0EDE8" }}>
                  {seq.steps.map((step, idx) => {
                    const isEditing = editingStep === step.id;
                    return (
                      <div key={step.id} style={{
                        padding: "14px 20px",
                        borderBottom: idx < seq.steps.length - 1 ? "1px solid #F7F6F3" : "none",
                        background: isEditing ? "#FFFBF5" : "transparent",
                      }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                          {/* Step number */}
                          <div style={{
                            width: 26, height: 26, borderRadius: "50%", background: "#F0EDE8",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontFamily: FFF, fontSize: 11, fontWeight: 700, color: "#6B6860", flexShrink: 0,
                          }}>
                            {step.step_number}
                          </div>

                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                              {step.channel === "email"
                                ? <Mail size={13} color="#2D6A4F" />
                                : <MessageSquare size={13} color="#1D4ED8" />}
                              <span style={{ fontFamily: FFF, fontSize: 12, fontWeight: 600, color: "#1A1917" }}>
                                {step.channel === "email" ? "Email" : "SMS"} — {delayLabel(step.delay_hours)}
                              </span>
                            </div>

                            {isEditing ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                {step.channel === "email" && (
                                  <div>
                                    <label style={{ fontFamily: FFF, fontSize: 11, fontWeight: 600, color: "#6B6860", display: "block", marginBottom: 4 }}>SUBJECT</label>
                                    <input
                                      value={editSubject}
                                      onChange={e => setEditSubject(e.target.value)}
                                      style={inputStyle}
                                    />
                                  </div>
                                )}
                                <div>
                                  <label style={{ fontFamily: FFF, fontSize: 11, fontWeight: 600, color: "#6B6860", display: "block", marginBottom: 4 }}>MESSAGE</label>
                                  <textarea
                                    value={editTemplate}
                                    onChange={e => setEditTemplate(e.target.value)}
                                    rows={4}
                                    style={{ ...inputStyle, resize: "vertical" }}
                                  />
                                  <p style={{ fontFamily: FFF, fontSize: 10, color: "#9E9B94", margin: "4px 0 0" }}>
                                    Variables: {"{{client_name}}"} {"{{company_name}}"} {"{{phone}}"} {"{{quote_link}}"}
                                  </p>
                                </div>
                                <div style={{ display: "flex", gap: 8 }}>
                                  <button
                                    onClick={() => saveStep(seq.id, step.id)}
                                    disabled={saving}
                                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 6, fontFamily: FFF, fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: saving ? 0.7 : 1 }}
                                  >
                                    <Save size={12} />
                                    {saving ? "Saving..." : "Save"}
                                  </button>
                                  <button
                                    onClick={() => setEditingStep(null)}
                                    style={{ padding: "7px 14px", background: "none", border: "1px solid #E5E2DC", borderRadius: 6, fontFamily: FFF, fontSize: 12, color: "#6B6860", cursor: "pointer" }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div>
                                {step.subject && (
                                  <p style={{ fontFamily: FFF, fontSize: 11, color: "#6B6860", margin: "0 0 2px", fontStyle: "italic" }}>
                                    Subject: {step.subject}
                                  </p>
                                )}
                                <p style={{ fontFamily: FFF, fontSize: 12, color: "#1A1917", margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                                  {step.message_template}
                                </p>
                                <button
                                  onClick={() => startEditStep(step)}
                                  style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 6, padding: "4px 10px", background: "none", border: "1px solid #E5E2DC", borderRadius: 5, fontFamily: FFF, fontSize: 11, color: "#6B6860", cursor: "pointer" }}
                                >
                                  <Edit2 size={10} /> Edit
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
