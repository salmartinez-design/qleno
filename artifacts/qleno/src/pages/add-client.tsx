import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useAddressAutocomplete } from "@/hooks/use-address-autocomplete";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

const FREQ_OPTIONS = [
  { value: "", label: "—" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "on_demand", label: "On Demand" },
];

type Form = {
  first_name: string; last_name: string; email: string; phone: string;
  company_name: string; address: string; city: string; state: string;
  zip: string; frequency: string; notes: string; send_welcome: boolean;
};

const EMPTY: Form = {
  first_name: "", last_name: "", email: "", phone: "", company_name: "",
  address: "", city: "", state: "IL", zip: "", frequency: "", notes: "",
  send_welcome: false,
};

export default function AddClientPage() {
  const [, navigate] = useLocation();
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(prev => ({ ...prev, [key]: value }));
  const addrRef = useRef<HTMLInputElement>(null);
  // Google Places autocomplete on the street address — fills city/state/zip too.
  useAddressAutocomplete(addrRef, true, (p) => setForm(prev => ({
    ...prev,
    address: p.street || prev.address,
    city: p.city || prev.city,
    state: p.state || prev.state,
    zip: p.zip || prev.zip,
  })));
  const canSave = form.first_name.trim().length > 0 && form.last_name.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/clients`, {
        method: "POST",
        headers: { ...(getAuthHeaders() as Record<string, string>), "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          email: form.email.trim() || undefined,
          phone: form.phone.trim() || undefined,
          company_name: form.company_name.trim() || undefined,
          address: form.address.trim() || undefined,
          city: form.city.trim() || undefined,
          state: form.state.trim() || undefined,
          zip: form.zip.trim() || undefined,
          frequency: form.frequency || undefined,
          notes: form.notes.trim() || undefined,
          send_welcome: form.send_welcome,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to create client (${res.status})`);
      }
      const created = await res.json();
      toast.success(`${form.first_name} ${form.last_name} added`);
      navigate(`/customers/${created.id}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to create client");
      setSaving(false);
    }
  };

  const label: React.CSSProperties = {
    display: "block", fontSize: "11px", fontWeight: 600, color: "#9E9B94",
    textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "6px",
  };
  const input: React.CSSProperties = {
    width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: "8px",
    fontSize: "14px", color: "#1A1917", backgroundColor: "#FFFFFF", fontFamily: FF, boxSizing: "border-box",
  };
  const field = (key: keyof Form, lbl: string, opts?: { type?: string; required?: boolean; placeholder?: string }) => (
    <div>
      <label style={label}>{lbl}{opts?.required ? " *" : ""}</label>
      <input style={input} type={opts?.type || "text"} placeholder={opts?.placeholder}
        value={form[key] as string} onChange={e => set(key, e.target.value as any)} />
    </div>
  );

  return (
    <DashboardLayout>
      <div style={{ maxWidth: "760px", margin: "0 auto", fontFamily: FF }}>
        <button onClick={() => navigate("/customers")}
          style={{ display: "flex", alignItems: "center", gap: "6px", background: "none", border: "none", color: "#9E9B94", fontSize: "13px", cursor: "pointer", padding: 0, marginBottom: "16px", fontFamily: FF }}>
          <ArrowLeft size={14} strokeWidth={2} /> Clients
        </button>
        <h1 style={{ margin: "0 0 20px", fontSize: "22px", fontWeight: 700, color: "#1A1917" }}>Add Client</h1>
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "12px", padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            {field("first_name", "First name", { required: true })}
            {field("last_name", "Last name", { required: true })}
            {field("email", "Email", { type: "email" })}
            {field("phone", "Phone", { type: "tel" })}
          </div>
          {field("company_name", "Company name", { placeholder: "Optional — for commercial clients" })}
          <div>
            <label style={label}>Street address</label>
            <input ref={addrRef} style={input} type="text" placeholder="Start typing — Google will complete it"
              value={form.address} onChange={e => set("address", e.target.value)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "16px" }}>
            {field("city", "City")}
            {field("state", "State")}
            {field("zip", "Zip")}
          </div>
          <div>
            <label style={label}>Frequency</label>
            <select style={input} value={form.frequency} onChange={e => set("frequency", e.target.value)}>
              {FREQ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label style={label}>Notes</label>
            <textarea style={{ ...input, minHeight: "80px", resize: "vertical" }}
              value={form.notes} onChange={e => set("notes", e.target.value)} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#1A1917", cursor: "pointer" }}>
            <input type="checkbox" checked={form.send_welcome} onChange={e => set("send_welcome", e.target.checked)} />
            Send welcome message
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", paddingTop: "4px" }}>
            <button onClick={() => navigate("/customers")} disabled={saving}
              style={{ padding: "9px 18px", border: "1px solid #E5E2DC", borderRadius: "8px", backgroundColor: "#FFFFFF", color: "#6B7280", fontSize: "13px", fontWeight: 600, cursor: saving ? "default" : "pointer", fontFamily: FF }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={!canSave}
              style={{ display: "flex", alignItems: "center", gap: "8px", padding: "9px 18px", border: "none", borderRadius: "8px", backgroundColor: canSave ? "var(--brand)" : "#9E9B94", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: canSave ? "pointer" : "not-allowed", fontFamily: FF }}>
              {saving && <Loader2 size={14} className="animate-spin" />}
              {saving ? "Saving…" : "Create Client"}
            </button>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
