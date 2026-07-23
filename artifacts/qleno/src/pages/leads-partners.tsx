import { useState, useEffect, useCallback } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { Plus, X, Loader2, Users, ChevronLeft, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Partner {
  id: number;
  name: string;
  type: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  client_id: number | null;
  notes: string | null;
  is_active: boolean;
  lead_count: number;
  booked_count: number;
  booked_value: string;
}

const TYPE_LABELS: Record<string, string> = {
  realtor: "Realtor",
  property_mgr: "Property Manager",
  past_client: "Past Client",
  chamber: "Chamber / Group",
  other: "Other",
};

const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#6B6860", marginBottom: 5 };
const selectStyle: React.CSSProperties = { width: "100%", border: "1px solid #E5E2DC", borderRadius: 6,
  padding: "8px 12px", fontSize: 14, fontFamily: "inherit", background: "#fff", outline: "none", cursor: "pointer" };

function PartnerDrawer({ partner, onClose, onSaved }:
  { partner: Partner | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: partner?.name || "",
    type: partner?.type || "realtor",
    contact_name: partner?.contact_name || "",
    contact_email: partner?.contact_email || "",
    contact_phone: partner?.contact_phone || "",
    notes: partner?.notes || "",
  });
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function handleSave() {
    if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const url = partner ? `${API}/api/referral-partners/${partner.id}` : `${API}/api/referral-partners`;
      const r = await fetch(url, {
        method: partner ? "PATCH" : "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error();
      toast({ title: partner ? "Partner updated" : "Partner added" });
      onSaved(); onClose();
    } catch {
      toast({ title: "Failed to save partner", variant: "destructive" });
    } finally { setSaving(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex" }}>
      <div style={{ flex: 1, background: "rgba(0,0,0,0.3)" }} onClick={onClose} />
      <div style={{ width: 460, background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
        display: "flex", flexDirection: "column", height: "100vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "20px 24px", borderBottom: "1px solid #E5E2DC" }}>
          <span style={{ fontWeight: 700, fontSize: 17, color: "#1A1917" }}>
            {partner ? "Edit Partner" : "Add Referral Partner"}
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
            <X size={18} color="#6B6860" />
          </button>
        </div>
        <div style={{ padding: 24, flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={lbl}>Name *</label>
            <Input value={form.name} onChange={e => set("name", e.target.value)} placeholder="Jane Realty Group" />
          </div>
          <div>
            <label style={lbl}>Type</label>
            <select value={form.type} onChange={e => set("type", e.target.value)} style={selectStyle}>
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Contact Name</label>
            <Input value={form.contact_name} onChange={e => set("contact_name", e.target.value)} placeholder="Jane Doe" />
          </div>
          <div>
            <label style={lbl}>Contact Phone</label>
            <Input value={form.contact_phone} onChange={e => set("contact_phone", e.target.value)} placeholder="(773) 555-0000" />
          </div>
          <div>
            <label style={lbl}>Contact Email</label>
            <Input value={form.contact_email} onChange={e => set("contact_email", e.target.value)} placeholder="jane@example.com" type="email" />
          </div>
          <div>
            <label style={lbl}>Notes</label>
            <textarea value={form.notes} onChange={e => set("notes", e.target.value)}
              placeholder="How you work together, referral terms…"
              style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 12px",
                fontSize: 14, fontFamily: "inherit", resize: "vertical", minHeight: 80, outline: "none", boxSizing: "border-box" }} />
          </div>
        </div>
        <div style={{ padding: 24, display: "flex", gap: 8, borderTop: "1px solid #E5E2DC" }}>
          <Button onClick={handleSave} disabled={saving} style={{ flex: 1, background: "#1A1917", color: "#fff" }}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : "Save Partner"}
          </Button>
          <Button variant="outline" onClick={onClose} style={{ flex: 1 }}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

export default function LeadsPartnersPage() {
  const { toast } = useToast();
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Partner | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/referral-partners${showInactive ? "?include_inactive=1" : ""}`,
        { headers: getAuthHeaders() });
      if (r.ok) setPartners(await r.json());
    } catch { toast({ title: "Failed to load partners", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [showInactive, toast]);

  useEffect(() => { load(); }, [load]);

  async function toggleActive(p: Partner) {
    try {
      const r = await fetch(`${API}/api/referral-partners/${p.id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !p.is_active }),
      });
      if (!r.ok) throw new Error();
      toast({ title: p.is_active ? "Partner deactivated" : "Partner reactivated" });
      load();
    } catch { toast({ title: "Failed to update", variant: "destructive" }); }
  }

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 0 40px" }}>
        <Link href="/leads" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "#6B6860",
          textDecoration: "none", marginBottom: 12 }}>
          <ChevronLeft size={14} /> Back to Pipeline
        </Link>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: 0,
              display: "flex", alignItems: "center", gap: 8 }}>
              <Users size={22} /> Referral Partners
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 14, color: "#6B6860" }}>
              Realtors, property managers, past clients and others who send you leads.
            </p>
          </div>
          <Button onClick={() => setShowAdd(true)}
            style={{ background: "#1A1917", color: "#fff", gap: 6, display: "flex", alignItems: "center" }}>
            <Plus size={15} /> Add Partner
          </Button>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#6B6860",
          marginBottom: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show inactive
        </label>

        <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: "#F7F6F3", borderBottom: "1px solid #E5E2DC" }}>
                {["Partner", "Type", "Contact", "Leads", "Booked", "Booked $", ""].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700,
                    color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ padding: "60px 0", textAlign: "center" }}>
                  <Loader2 size={22} className="animate-spin" color="#6B6860" style={{ margin: "0 auto" }} />
                </td></tr>
              ) : partners.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: "60px 0", textAlign: "center" }}>
                  <Users size={36} color="#E5E2DC" style={{ margin: "0 auto 12px" }} />
                  <div style={{ color: "#6B6860", fontSize: 14 }}>No referral partners yet.</div>
                </td></tr>
              ) : partners.map((p, i) => (
                <tr key={p.id} style={{ borderBottom: i < partners.length - 1 ? "1px solid #F0EEE9" : "none",
                  opacity: p.is_active ? 1 : 0.55 }}>
                  <td style={{ padding: "12px 14px" }}>
                    <div style={{ fontWeight: 600, color: "#1A1917" }}>{p.name}</div>
                    {!p.is_active && <span style={{ fontSize: 11, color: "#9E9B94" }}>Inactive</span>}
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    <span style={{ background: "#F0FDFA", color: "#0D9488", fontSize: 12, fontWeight: 500,
                      padding: "2px 8px", borderRadius: 999 }}>{TYPE_LABELS[p.type] || p.type}</span>
                  </td>
                  <td style={{ padding: "12px 14px", fontSize: 13, color: "#1A1917" }}>
                    {p.contact_name && <div>{p.contact_name}</div>}
                    {p.contact_phone && <div style={{ fontSize: 12, color: "#9E9B94" }}>{p.contact_phone}</div>}
                    {!p.contact_name && !p.contact_phone && <span style={{ color: "#E5E2DC" }}>—</span>}
                  </td>
                  <td style={{ padding: "12px 14px", color: "#1A1917" }}>{Number(p.lead_count) || 0}</td>
                  <td style={{ padding: "12px 14px", color: "#0F7A63", fontWeight: 600 }}>{Number(p.booked_count) || 0}</td>
                  <td style={{ padding: "12px 14px", color: "#1A1917" }}>
                    ${(Number(p.booked_value) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                  <td style={{ padding: "12px 14px", whiteSpace: "nowrap", textAlign: "right" }}>
                    <button onClick={() => setEditing(p)} title="Edit"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#6B6860", padding: 4, marginRight: 8 }}>
                      <Pencil size={15} />
                    </button>
                    <button onClick={() => toggleActive(p)}
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                        fontFamily: "inherit", color: p.is_active ? "#B3261E" : "#0F7A63" }}>
                      {p.is_active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(showAdd || editing) && (
        <PartnerDrawer partner={editing} onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={load} />
      )}
    </DashboardLayout>
  );
}
