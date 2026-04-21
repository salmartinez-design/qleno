import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { Plus, Building2, Users, Trash2, Edit2, ChevronRight, X, Check } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const card: React.CSSProperties = { backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" };
const label: React.CSSProperties = { fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", fontFamily: "inherit", boxSizing: "border-box" };

const EMPTY_FORM = { name: "", contact_name: "", contact_email: "", contact_phone: "", billing_centralized: false, notes: "" };

export default function PropertyGroupsPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ["property-groups"],
    queryFn: () => apiFetch("/api/property-groups"),
  });

  const { data: groupClients = [] } = useQuery({
    queryKey: ["property-group-clients", expandedId],
    queryFn: () => expandedId ? apiFetch(`/api/property-groups/${expandedId}/clients`) : Promise.resolve([]),
    enabled: !!expandedId,
  });

  const createMut = useMutation({
    mutationFn: (d: any) => apiFetch("/api/property-groups", { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["property-groups"] }); setShowForm(false); setForm({ ...EMPTY_FORM }); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, d }: { id: number; d: any }) => apiFetch(`/api/property-groups/${id}`, { method: "PATCH", body: JSON.stringify(d) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["property-groups"] }); setEditId(null); setForm({ ...EMPTY_FORM }); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/property-groups/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["property-groups"] }),
  });

  function startEdit(g: any) {
    setEditId(g.id);
    setForm({ name: g.name || "", contact_name: g.contact_name || "", contact_email: g.contact_email || "", contact_phone: g.contact_phone || "", billing_centralized: g.billing_centralized || false, notes: g.notes || "" });
    setShowForm(true);
  }

  function handleSubmit() {
    if (!form.name.trim()) return;
    if (editId) {
      updateMut.mutate({ id: editId, d: form });
    } else {
      createMut.mutate(form);
    }
  }

  const totalClients = groups.reduce((s: number, g: any) => s + (g.client_count || 0), 0);

  return (
    <DashboardLayout>
      <div style={{ padding: "28px 32px", maxWidth: "1100px", margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "24px" }}>
          <div>
            <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#1A1917", margin: 0 }}>Property Management Groups</h1>
            <div style={{ fontSize: "13px", color: "#6B7280", marginTop: "4px" }}>
              Group clients under a property management company or parent account. {groups.length} groups, {totalClients} clients.
            </div>
          </div>
          <button onClick={() => { setShowForm(true); setEditId(null); setForm({ ...EMPTY_FORM }); }} style={{ backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: "8px", padding: "10px 18px", fontSize: "13px", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: "8px" }}>
            <Plus size={14} /> New Group
          </button>
        </div>

        {/* Create / Edit form */}
        {showForm && (
          <div style={{ ...card, borderLeft: "3px solid var(--brand)", marginBottom: "24px" }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917", marginBottom: "16px" }}>{editId ? "Edit Group" : "New Property Management Group"}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={label}>Group Name</div>
                <input style={inputStyle} placeholder="e.g. Sunset Properties LLC" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <div style={label}>Contact Name</div>
                <input style={inputStyle} placeholder="Property manager name" value={form.contact_name} onChange={e => setForm(p => ({ ...p, contact_name: e.target.value }))} />
              </div>
              <div>
                <div style={label}>Contact Email</div>
                <input style={inputStyle} type="email" placeholder="manager@company.com" value={form.contact_email} onChange={e => setForm(p => ({ ...p, contact_email: e.target.value }))} />
              </div>
              <div>
                <div style={label}>Contact Phone</div>
                <input style={inputStyle} type="tel" placeholder="(555) 000-0000" value={form.contact_phone} onChange={e => setForm(p => ({ ...p, contact_phone: e.target.value }))} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", paddingTop: "20px" }}>
                <input type="checkbox" id="billing_centralized" checked={form.billing_centralized} onChange={e => setForm(p => ({ ...p, billing_centralized: e.target.checked }))} style={{ width: "16px", height: "16px" }} />
                <label htmlFor="billing_centralized" style={{ fontSize: "13px", color: "#1A1917", cursor: "pointer" }}>Centralized billing (invoice to PM, not individual clients)</label>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={label}>Notes</div>
                <textarea style={{ ...inputStyle, minHeight: "60px", resize: "vertical" }} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "16px", justifyContent: "flex-end" }}>
              <button onClick={() => { setShowForm(false); setEditId(null); setForm({ ...EMPTY_FORM }); }} style={{ backgroundColor: "#F3F4F6", color: "#6B7280", border: "none", borderRadius: "6px", padding: "8px 14px", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={handleSubmit} disabled={createMut.isPending || updateMut.isPending} style={{ backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: "6px", padding: "8px 14px", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}>
                {createMut.isPending || updateMut.isPending ? "Saving..." : editId ? "Save Changes" : "Create Group"}
              </button>
            </div>
          </div>
        )}

        {/* Groups list */}
        {isLoading ? (
          <div style={{ ...card, textAlign: "center", color: "#9E9B94", padding: "60px" }}>Loading groups...</div>
        ) : groups.length === 0 ? (
          <div style={{ ...card, textAlign: "center", padding: "60px" }}>
            <Building2 size={40} style={{ color: "#C4C0BB", marginBottom: "12px" }} />
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#6B7280", marginBottom: "6px" }}>No property groups yet</div>
            <div style={{ fontSize: "13px", color: "#9E9B94" }}>Create a group to manage clients under a property management company</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {groups.map((g: any) => (
              <div key={g.id} style={{ ...card, padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: "16px" }}>
                  <div style={{ width: "40px", height: "40px", backgroundColor: "#EFF6FF", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Building2 size={20} style={{ color: "var(--brand)" }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>{g.name}</div>
                      {g.billing_centralized && <span style={{ backgroundColor: "#FEF3C7", color: "#92400E", fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px" }}>CENTRALIZED BILLING</span>}
                    </div>
                    <div style={{ display: "flex", gap: "16px", fontSize: "12px", color: "#6B7280", flexWrap: "wrap" }}>
                      {g.contact_name && <span>{g.contact_name}</span>}
                      {g.contact_email && <span>{g.contact_email}</span>}
                      {g.contact_phone && <span>{g.contact_phone}</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <div style={{ textAlign: "center", padding: "6px 12px", backgroundColor: "#F7F6F3", borderRadius: "6px" }}>
                      <div style={{ fontSize: "18px", fontWeight: 800, color: "var(--brand)" }}>{g.client_count || 0}</div>
                      <div style={{ fontSize: "10px", color: "#9E9B94", fontWeight: 600 }}>CLIENTS</div>
                    </div>
                    <button onClick={() => startEdit(g)} style={{ backgroundColor: "#F7F6F3", color: "#6B7280", border: "none", borderRadius: "6px", padding: "8px", cursor: "pointer" }}>
                      <Edit2 size={14} />
                    </button>
                    <button onClick={() => { if (confirm(`Delete "${g.name}"? Clients will be unassigned.`)) deleteMut.mutate(g.id); }} style={{ backgroundColor: "#FEE2E2", color: "#991B1B", border: "none", borderRadius: "6px", padding: "8px", cursor: "pointer" }}>
                      <Trash2 size={14} />
                    </button>
                    <button onClick={() => setExpandedId(expandedId === g.id ? null : g.id)} style={{ backgroundColor: "#F7F6F3", color: "#6B7280", border: "none", borderRadius: "6px", padding: "8px", cursor: "pointer" }}>
                      <ChevronRight size={14} style={{ transform: expandedId === g.id ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
                    </button>
                  </div>
                </div>
                {expandedId === g.id && (
                  <div style={{ borderTop: "1px solid #F0EDE8", padding: "16px 20px", backgroundColor: "#F7F6F3" }}>
                    <div style={{ fontSize: "12px", fontWeight: 700, color: "#9E9B94", marginBottom: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Clients in this group</div>
                    {groupClients.length === 0 ? (
                      <div style={{ fontSize: "13px", color: "#9E9B94" }}>No clients assigned to this group. Assign clients from their profile portal tab.</div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                        {groupClients.map((c: any) => (
                          <a key={c.id} href={`/customers/${c.id}`} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 12px", backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "6px", textDecoration: "none", color: "#1A1917", fontSize: "13px", fontWeight: 500 }}>
                            <Users size={12} style={{ color: "var(--brand)" }} />
                            {c.first_name} {c.last_name}
                          </a>
                        ))}
                      </div>
                    )}
                    {g.notes && <div style={{ marginTop: "10px", fontSize: "12px", color: "#6B7280", fontStyle: "italic" }}>{g.notes}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
