import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Loader2, X } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const CATEGORIES = ["deep_clean", "inside_fridge", "inside_oven", "windows", "laundry", "organizing", "other"];
const CAT_LABELS: Record<string, string> = {
  deep_clean: "Deep Clean", inside_fridge: "Inside Fridge", inside_oven: "Inside Oven",
  windows: "Windows", laundry: "Laundry", organizing: "Organizing", other: "Other",
};

const EMPTY = { name: "", price: "", category: "other" };

export default function AddOnCatalogPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(EMPTY);

  const { data: addons = [], isLoading } = useQuery<any[]>({
    queryKey: ["addons"],
    queryFn: () => apiFetch("/api/addons"),
  });

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/api/addons", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["addons"] }); setModalOpen(false); setForm(EMPTY); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, ...body }: any) => apiFetch(`/api/addons/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["addons"] }); setModalOpen(false); setEditing(null); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/addons/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["addons"] }),
  });

  function openAdd() { setForm(EMPTY); setEditing(null); setModalOpen(true); }
  function openEdit(a: any) { setForm({ name: a.name, price: a.price, category: a.category }); setEditing(a); setModalOpen(true); }

  function save() {
    const body = { name: form.name, price: parseFloat(form.price), category: form.category };
    if (editing) updateMut.mutate({ id: editing.id, ...body });
    else createMut.mutate(body);
  }

  const byCategory = CATEGORIES.map(cat => ({
    cat, label: CAT_LABELS[cat], items: addons.filter((a: any) => a.category === cat),
  })).filter(g => g.items.length > 0);

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, fontFamily: FF }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>Add-On Catalog</h1>
            <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>Manage optional services that can be added to any job</p>
          </div>
          <button onClick={openAdd} style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
            <Plus size={14} /> New Add-On
          </button>
        </div>

        {isLoading ? (
          <div style={{ padding: 40, textAlign: "center", color: "#9E9B94" }}>
            <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
          </div>
        ) : addons.length === 0 ? (
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: 40, textAlign: "center", color: "#9E9B94" }}>
            No add-ons yet. Click "New Add-On" to create your first optional service.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {byCategory.map(({ cat, label, items }) => (
              <div key={cat} style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "12px 20px", borderBottom: "1px solid #EEECE7", backgroundColor: "#F8F7F4" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>
                    {items.map((a: any) => (
                      <tr key={a.id} style={{ borderBottom: "1px solid #F0EEE9" }}
                        onMouseEnter={e => e.currentTarget.style.backgroundColor = "#F7F6F3"}
                        onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}>
                        <td style={{ padding: "12px 20px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{a.name}</td>
                        <td style={{ padding: "12px 20px", fontSize: 13, color: "#1A1917", fontWeight: 700 }}>${parseFloat(a.price).toFixed(2)}</td>
                        <td style={{ padding: "12px 20px", textAlign: "right" }}>
                          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <button onClick={() => openEdit(a)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><Pencil size={13} /></button>
                            <button onClick={() => deleteMut.mutate(a.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#EF4444", padding: 4 }}><Trash2 size={13} /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {/* Uncategorized */}
            {addons.filter((a: any) => a.category === "other").length > 0 && byCategory.find(g => g.cat === "other") === undefined && (
              <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "12px 20px", borderBottom: "1px solid #EEECE7" }}>Other</div>
                {addons.filter((a: any) => a.category === "other").map((a: any) => (
                  <div key={a.id} style={{ padding: "12px 20px", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{a.name}</span>
                    <span style={{ fontSize: 13, color: "#1A1917" }}>${parseFloat(a.price).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal */}
      {modalOpen && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, width: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1A1917" }}>{editing ? "Edit Add-On" : "New Add-On"}</h3>
              <button onClick={() => setModalOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}><X size={16} /></button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Name</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Inside Oven Cleaning"
                  style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Price ($)</label>
                  <input type="number" step="0.01" value={form.price} onChange={e => setForm(p => ({ ...p, price: e.target.value }))}
                    style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Category</label>
                  <select value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                    style={{ width: "100%", height: 36, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", background: "#FFFFFF", boxSizing: "border-box" }}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
              <button onClick={() => setModalOpen(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={save} disabled={!form.name || !form.price}
                style={{ padding: "8px 20px", background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                {createMut.isPending || updateMut.isPending ? "Saving..." : editing ? "Save Changes" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </DashboardLayout>
  );
}
