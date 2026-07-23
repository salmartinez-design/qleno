import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Loader2, X, Check } from "lucide-react";
import { FrequencyPicker } from "@/components/frequency-picker";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";
const INK = "#1A1917", MUTE = "#6B6860", BORDER = "#E5E2DC", MINT = "var(--brand)";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...(getAuthHeaders() as Record<string, string>), "Content-Type": "application/json", ...opts.headers } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const money = (n: any) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inp: React.CSSProperties = { width: "100%", padding: "9px 11px", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, fontFamily: FF, background: "#fff", boxSizing: "border-box", color: INK };
const lbl: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 };

type Form = { id: number | null; name: string; frequency: string; price: string; intro_note: string; scope: string[] };
const EMPTY: Form = { id: null, name: "", frequency: "Monthly", price: "", intro_note: "", scope: [""] };

export default function PackagesPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);

  // Packages = flat-price templates. Other (itemized) templates are managed from
  // the estimate via "Save as template", so this screen lists flat ones only.
  const { data: packages = [], isLoading } = useQuery<any[]>({
    queryKey: ["estimate-packages"],
    queryFn: () => apiFetch("/api/estimates/templates").then(r => (r.data || []).filter((t: any) => t.billing_mode === "flat")),
  });

  const saveMut = useMutation({
    mutationFn: (f: Form) => {
      const body = {
        name: f.name.trim(),
        billing_mode: "flat",
        flat_price: parseFloat(f.price) || 0,
        intro_note: f.intro_note.trim() || null,
        items: f.scope.filter(s => s.trim()).map(name => ({ name: name.trim(), pricing_type: "flat", frequency: f.frequency, quantity: 1, unit_rate: 0 })),
      };
      return f.id
        ? apiFetch(`/api/estimates/templates/${f.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : apiFetch("/api/estimates/templates", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["estimate-packages"] }); setModalOpen(false); setForm(EMPTY); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/estimates/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["estimate-packages"] }),
  });

  function openAdd() { setForm(EMPTY); setModalOpen(true); }
  async function openEdit(p: any) {
    const full = await apiFetch(`/api/estimates/templates/${p.id}`);
    const items = Array.isArray(full.items) ? full.items : [];
    setForm({
      id: p.id, name: full.name || "", price: full.flat_price != null ? String(full.flat_price) : "",
      frequency: items[0]?.frequency || "Monthly", intro_note: full.intro_note || "",
      scope: items.length ? items.map((i: any) => i.name || "") : [""],
    });
    setModalOpen(true);
  }

  const setScope = (i: number, v: string) => setForm(f => ({ ...f, scope: f.scope.map((s, idx) => idx === i ? v : s) }));
  const addScope = () => setForm(f => ({ ...f, scope: [...f.scope, ""] }));
  const removeScope = (i: number) => setForm(f => ({ ...f, scope: f.scope.length > 1 ? f.scope.filter((_, idx) => idx !== i) : f.scope }));

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, fontFamily: FF }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: INK, margin: "0 0 4px" }}>Service Packages</h1>
            <p style={{ fontSize: 13, color: MUTE, margin: 0 }}>Flat-price packages (e.g. Basic, Standard, Premium). Pick one when building an estimate to drop in the price and scope.</p>
          </div>
          <button onClick={openAdd} style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
            <Plus size={14} /> New Package
          </button>
        </div>

        {isLoading ? (
          <div style={{ padding: 40, textAlign: "center", color: "#9E9B94" }}><Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} /></div>
        ) : packages.length === 0 ? (
          <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, padding: 40, textAlign: "center", color: "#9E9B94" }}>
            No packages yet. Click "New Package" to create your first one — for example Basic, Standard, and Premium tiers.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
            {packages.map((p: any) => (
              <div key={p.id} style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: INK }}>{p.name}</span>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button onClick={() => openEdit(p)} title="Edit" style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 2 }}><Pencil size={14} /></button>
                    <button onClick={() => { if (confirm(`Delete package "${p.name}"?`)) deleteMut.mutate(p.id); }} title="Delete" style={{ background: "none", border: "none", cursor: "pointer", color: "#B3261E", padding: 2 }}><Trash2 size={14} /></button>
                  </div>
                </div>
                <span style={{ fontSize: 20, fontWeight: 800, color: INK }}>{money(p.flat_price)}</span>
                <span style={{ fontSize: 12, color: MUTE }}>{`${p.item_count ?? 0} item${(p.item_count ?? 0) === 1 ? "" : "s"} included`}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {modalOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 26, width: 480, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: INK }}>{form.id ? "Edit package" : "New package"}</h3>
              <button onClick={() => setModalOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}><X size={16} /></button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={lbl}>Package name</label>
                <input style={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Standard" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={lbl}>Frequency</label>
                  <FrequencyPicker value={form.frequency} onChange={v => setForm(f => ({ ...f, frequency: v }))} />
                </div>
                <div>
                  <label style={lbl}>Price</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: MUTE }}>$</span>
                    <input style={inp} type="number" min="0" step="0.01" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="0.00" />
                  </div>
                </div>
              </div>
              <div>
                <label style={lbl}>What's included</label>
                {form.scope.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ width: 18, height: 18, borderRadius: 5, background: MINT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Check size={12} /></span>
                    <input style={inp} value={s} onChange={e => setScope(i, e.target.value)} placeholder="Restrooms — clean & restock" />
                    <button onClick={() => removeScope(i)} title="Remove" style={{ background: "none", border: `1px solid ${BORDER}`, borderRadius: 8, width: 34, height: 34, cursor: "pointer", color: MUTE, flexShrink: 0 }}><Trash2 size={14} /></button>
                  </div>
                ))}
                <button onClick={addScope} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#fff", border: `1px dashed ${BORDER}`, borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 700, color: INK, cursor: "pointer", fontFamily: FF }}><Plus size={14} /> Add item</button>
              </div>
              <div>
                <label style={lbl}>Intro note (optional)</label>
                <textarea style={{ ...inp, minHeight: 56, resize: "vertical" }} value={form.intro_note} onChange={e => setForm(f => ({ ...f, intro_note: e.target.value }))} placeholder="Shown to the client at the top of the estimate." />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
              <button onClick={() => setModalOpen(false)} style={{ padding: "8px 16px", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, background: "#fff", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={() => saveMut.mutate(form)} disabled={!form.name.trim() || saveMut.isPending}
                style={{ padding: "8px 20px", background: "var(--brand)", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: form.name.trim() ? "pointer" : "default", opacity: form.name.trim() ? 1 : 0.6, fontFamily: FF }}>
                {saveMut.isPending ? "Saving…" : form.id ? "Save changes" : "Create package"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </DashboardLayout>
  );
}
