import { useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

const ROLES = [
  { value: "technician", label: "Technician" },
  { value: "team_lead", label: "Team Lead" },
  { value: "office", label: "Office" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

type Form = {
  first_name: string; last_name: string; email: string; personal_email: string;
  phone: string; role: string; address: string; city: string; state: string;
  zip: string; hire_date: string; pay_type: string; pay_rate: string;
};

const EMPTY: Form = {
  first_name: "", last_name: "", email: "", personal_email: "", phone: "",
  role: "technician", address: "", city: "", state: "IL", zip: "",
  hire_date: "", pay_type: "hourly", pay_rate: "",
};

export default function AddEmployeePage() {
  const [, navigate] = useLocation();
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(p => ({ ...p, [k]: v }));
  const canSave = form.first_name.trim() && form.email.trim() && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/users`, {
        method: "POST",
        headers: { ...(getAuthHeaders() as Record<string, string>), "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          email: form.email.trim(),
          personal_email: form.personal_email.trim() || undefined,
          phone: form.phone.trim() || undefined,
          role: form.role,
          address: form.address.trim() || undefined,
          city: form.city.trim() || undefined,
          state: form.state.trim() || undefined,
          zip: form.zip.trim() || undefined,
          hire_date: form.hire_date || undefined,
          pay_type: form.pay_type,
          pay_rate: form.pay_rate.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || body.error || `Failed to create employee (${res.status})`);
      }
      const created = await res.json();
      toast.success(`${form.first_name} ${form.last_name} added`);
      navigate(`/employees/${created.id}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to create employee");
      setSaving(false);
    }
  }

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
        value={form[key]} onChange={e => set(key, e.target.value as any)} />
    </div>
  );

  return (
    <DashboardLayout>
      <div style={{ maxWidth: "760px", margin: "0 auto", fontFamily: FF }}>
        <button onClick={() => navigate("/employees")}
          style={{ display: "flex", alignItems: "center", gap: "6px", background: "none", border: "none", color: "#9E9B94", fontSize: "13px", cursor: "pointer", padding: 0, marginBottom: "16px", fontFamily: FF }}>
          <ArrowLeft size={14} strokeWidth={2} /> Team
        </button>
        <h1 style={{ margin: "0 0 20px", fontSize: "22px", fontWeight: 700, color: "#1A1917" }}>Add Team Member</h1>
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "12px", padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            {field("first_name", "First name", { required: true })}
            {field("last_name", "Last name")}
            {field("email", "Login email", { type: "email", required: true })}
            {field("personal_email", "Personal email", { type: "email" })}
            {field("phone", "Phone", { type: "tel" })}
            <div>
              <label style={label}>Role</label>
              <select style={input} value={form.role} onChange={e => set("role", e.target.value)}>
                {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          </div>
          {field("address", "Street address")}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "16px" }}>
            {field("city", "City")}
            {field("state", "State")}
            {field("zip", "Zip")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
            {field("hire_date", "Hire date", { type: "date" })}
            <div>
              <label style={label}>Pay type</label>
              <select style={input} value={form.pay_type} onChange={e => set("pay_type", e.target.value)}>
                <option value="hourly">Hourly</option>
                <option value="fee_split">Fee Split</option>
                <option value="per_job">Per Job</option>
              </select>
            </div>
            {field("pay_rate", "Pay rate", { type: "number" })}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", paddingTop: "4px" }}>
            <button onClick={() => navigate("/employees")} disabled={saving}
              style={{ padding: "9px 18px", border: "1px solid #E5E2DC", borderRadius: "8px", backgroundColor: "#FFFFFF", color: "#6B7280", fontSize: "13px", fontWeight: 600, cursor: saving ? "default" : "pointer", fontFamily: FF }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={!canSave}
              style={{ display: "flex", alignItems: "center", gap: "8px", padding: "9px 18px", border: "none", borderRadius: "8px", backgroundColor: canSave ? "var(--brand)" : "#9E9B94", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: canSave ? "pointer" : "not-allowed", fontFamily: FF }}>
              {saving && <Loader2 size={14} className="animate-spin" />}
              {saving ? "Saving…" : "Create Team Member"}
            </button>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
