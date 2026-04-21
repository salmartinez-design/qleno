import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Edit2, UserCheck, Ban } from "lucide-react";

const PURPLE = "#7F77DD";
const PURPLE_RGB = "127, 119, 221";

interface Company {
  id: number;
  name: string;
  slug: string;
  plan: string;
  subscription_status: string;
  employee_count: number;
  brand_color: string;
  created_at: string;
  mrr: number;
  owner: { email: string; first_name: string; last_name: string } | null;
}

const STATUS_FILTERS = ["all", "active", "trialing", "past_due", "canceled"];

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "badge-complete",
    trialing: "badge-scheduled",
    past_due: "badge-in_progress",
    canceled: "badge-cancelled",
  };
  return <span className={`badge ${map[status] || "badge-draft"}`}>{status.replace("_", " ")}</span>;
}

function PlanBadge({ plan }: { plan: string }) {
  const colors: Record<string, { bg: string; text: string; border: string }> = {
    starter:    { bg: "#F3F4F6", text: "#6B7280", border: "#E5E7EB" },
    growth:     { bg: `rgba(${PURPLE_RGB}, 0.10)`, text: PURPLE, border: `rgba(${PURPLE_RGB}, 0.3)` },
    enterprise: { bg: "#FEF3C7", text: "#92400E", border: "#FDE68A" },
  };
  const c = colors[plan] || colors.starter;
  return (
    <span style={{
      fontSize: "11px", fontWeight: 600, textTransform: "uppercase",
      letterSpacing: "0.05em", padding: "2px 8px", borderRadius: "4px",
      backgroundColor: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>
      {plan}
    </span>
  );
}

interface EditModalProps {
  company: Company;
  onClose: () => void;
  onSave: () => void;
}

function EditModal({ company, onClose, onSave }: EditModalProps) {
  const [plan, setPlan] = useState(company.plan);
  const [status, setStatus] = useState(company.subscription_status);
  const [brandColor, setBrandColor] = useState(company.brand_color);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const save = async () => {
    setSaving(true);
    try {
      await fetch(`/api/admin/companies/${company.id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ plan, subscription_status: status, brand_color: brandColor }),
      });
      toast({ title: "Company updated" });
      onSave();
      onClose();
    } catch {
      toast({ variant: "destructive", title: "Failed to update company" });
    } finally {
      setSaving(false);
    }
  };

  const sel: React.CSSProperties = {
    width: "100%", height: "38px", backgroundColor: "#F7F6F3",
    border: "1px solid #DEDAD4", borderRadius: "8px", color: "#1A1917",
    fontSize: "13px", padding: "0 12px",
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.4)" }}>
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "12px", padding: "28px", width: "360px", boxShadow: "0 20px 40px rgba(0,0,0,0.12)" }}>
        <p style={{ fontSize: "15px", fontWeight: 600, color: "#1A1917", margin: "0 0 20px" }}>Edit {company.name}</p>

        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div>
            <label style={{ fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: "6px" }}>Plan</label>
            <select value={plan} onChange={e => setPlan(e.target.value)} style={sel}>
              <option value="starter">Starter — $49/mo</option>
              <option value="growth">Growth — $149/mo</option>
              <option value="enterprise">Enterprise — $299/mo</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: "6px" }}>Subscription Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)} style={sel}>
              <option value="active">Active</option>
              <option value="trialing">Trialing</option>
              <option value="past_due">Past Due</option>
              <option value="canceled">Canceled</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: "6px" }}>Brand Color</label>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input type="color" value={brandColor} onChange={e => setBrandColor(e.target.value)} style={{ width: "44px", height: "38px", border: "none", borderRadius: "6px", cursor: "pointer", backgroundColor: "transparent" }} />
              <input type="text" value={brandColor} onChange={e => setBrandColor(e.target.value)} style={{ flex: 1, height: "38px", backgroundColor: "#F7F6F3", border: "1px solid #DEDAD4", borderRadius: "8px", color: "#1A1917", fontSize: "13px", padding: "0 12px" }} />
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", marginTop: "24px" }}>
          <button onClick={onClose} style={{ flex: 1, height: "38px", backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: "8px", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ flex: 1, height: "38px", backgroundColor: PURPLE, border: "none", borderRadius: "8px", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminCompanies() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const impersonate = useAuthStore(state => state.impersonate);
  const { toast } = useToast();

  const fetchCompanies = () => {
    setLoading(true);
    fetch(`/api/admin/companies?status=${filter}`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { setCompanies(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { fetchCompanies(); }, [filter]);

  const handleImpersonate = async (company: Company) => {
    try {
      const res = await fetch(`/api/admin/companies/${company.id}/impersonate`, {
        method: "POST", headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.token) {
        toast({ title: `Entering ${company.name} portal`, description: "Click 'Exit Impersonation' in the sidebar to return." });
        setTimeout(() => impersonate(data.token), 500);
      }
    } catch {
      toast({ variant: "destructive", title: "Impersonation failed" });
    }
  };

  const handleSuspend = async (company: Company) => {
    if (!confirm(`Suspend ${company.name}? This will deactivate all their users.`)) return;
    try {
      await fetch(`/api/admin/companies/${company.id}/suspend`, {
        method: "POST", headers: getAuthHeaders(),
      });
      toast({ title: `${company.name} suspended` });
      fetchCompanies();
    } catch {
      toast({ variant: "destructive", title: "Failed to suspend company" });
    }
  };

  return (
    <AdminLayout title="Companies">
      {editingCompany && (
        <EditModal
          company={editingCompany}
          onClose={() => setEditingCompany(null)}
          onSave={fetchCompanies}
        />
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px", flexWrap: "wrap" }}>
        {STATUS_FILTERS.map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              height: "30px", padding: "0 14px", borderRadius: "6px",
              fontSize: "12px", fontWeight: 500, cursor: "pointer",
              backgroundColor: filter === f ? `rgba(${PURPLE_RGB}, 0.12)` : "#FFFFFF",
              color: filter === f ? PURPLE : "#6B7280",
              border: filter === f ? `1px solid rgba(${PURPLE_RGB}, 0.3)` : "1px solid #E5E2DC",
              transition: "all 0.15s",
            }}
          >
            {f === "all" ? "All" : f.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase())}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                {["Company", "Owner Email", "Plan", "Status", "Employees", "MRR", "Joined", "Actions"].map(h => (
                  <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ padding: "40px", textAlign: "center", color: "#6B7280" }}>Loading...</td></tr>
              ) : companies.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: "40px", textAlign: "center", color: "#6B7280" }}>No companies found.</td></tr>
              ) : companies.map(c => (
                <tr key={c.id} style={{ borderBottom: "1px solid #F0EEE9", cursor: "default" }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#F7F6F3")}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}
                >
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: c.brand_color, flexShrink: 0 }} />
                      <span style={{ fontSize: "13px", fontWeight: 500, color: "#1A1917" }}>{c.name}</span>
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280" }}>{c.owner?.email || "—"}</td>
                  <td style={{ padding: "12px 16px" }}><PlanBadge plan={c.plan} /></td>
                  <td style={{ padding: "12px 16px" }}><StatusBadge status={c.subscription_status} /></td>
                  <td style={{ padding: "12px 16px", fontSize: "13px", color: "#1A1917" }}>{c.employee_count}</td>
                  <td style={{ padding: "12px 16px", fontSize: "13px", color: "#1A1917", fontWeight: 500 }}>
                    {c.mrr > 0 ? `$${c.mrr}` : "—"}
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280" }}>
                    {new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        onClick={() => handleImpersonate(c)}
                        title="View as Tenant"
                        style={{ display: "flex", alignItems: "center", gap: "5px", height: "28px", padding: "0 10px", backgroundColor: `rgba(${PURPLE_RGB}, 0.08)`, border: `1px solid rgba(${PURPLE_RGB}, 0.25)`, borderRadius: "6px", color: PURPLE, fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
                      >
                        <UserCheck size={12} />
                        View as Tenant
                      </button>
                      <button
                        onClick={() => setEditingCompany(c)}
                        title="Edit"
                        style={{ width: "28px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: "6px", color: "#6B7280", cursor: "pointer" }}
                      >
                        <Edit2 size={13} />
                      </button>
                      <button
                        onClick={() => handleSuspend(c)}
                        title="Suspend"
                        style={{ width: "28px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#FEF2F2", border: "1px solid #FECACA", borderRadius: "6px", color: "#DC2626", cursor: "pointer" }}
                      >
                        <Ban size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 16px", borderTop: "1px solid #EEECE7", display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "#F7F6F3" }}>
          <span style={{ fontSize: "12px", color: "#6B7280" }}>{companies.length} companies</span>
          <span style={{ fontSize: "12px", color: "#6B7280" }}>
            MRR: <strong style={{ color: "#1A1917" }}>${companies.reduce((s, c) => s + c.mrr, 0).toLocaleString()}</strong>
          </span>
        </div>
      </div>
    </AdminLayout>
  );
}
