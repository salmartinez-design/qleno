import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Plus, Save, X, Check, ToggleLeft, ToggleRight, Trash2, Edit2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) throw new Error(await r.text().catch(() => "Error"));
  return r.json();
}

const card: React.CSSProperties = {
  background: "#FFFFFF",
  border: "1px solid #E5E2DC",
  borderRadius: 10,
  padding: "20px 24px",
  marginBottom: 16,
};

const sectionHead: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 15,
  fontWeight: 700,
  color: "#1A1917",
  margin: "0 0 4px",
};

const sectionSub: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 12,
  color: "#6B6860",
  margin: "0 0 16px",
};

const th: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 11,
  fontWeight: 700,
  color: "#9E9B94",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "0 10px 10px 0",
  textAlign: "left" as const,
  whiteSpace: "nowrap" as const,
};

const td: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 13,
  color: "#1A1917",
  padding: "8px 10px 8px 0",
  verticalAlign: "middle" as const,
  borderTop: "1px solid #F4F3F0",
};

const inputStyle: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 13,
  border: "1px solid #E5E2DC",
  borderRadius: 6,
  padding: "5px 8px",
  width: "100%",
  outline: "none",
  color: "#1A1917",
  background: "#fff",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 13,
  fontWeight: 600,
  background: "var(--brand)",
  color: "#fff",
  border: "none",
  borderRadius: 7,
  padding: "8px 16px",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const btnGhost: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 12,
  fontWeight: 500,
  background: "none",
  border: "1px solid #E5E2DC",
  borderRadius: 6,
  padding: "5px 10px",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 4,
  color: "#6B6860",
};

const PRICE_TYPES = [
  { value: "flat", label: "Flat ($)" },
  { value: "percentage", label: "Percentage (%)" },
  { value: "time_only", label: "Time Add Only" },
  { value: "sqft_pct", label: "Sqft %" },
  { value: "manual_adj", label: "Manual Adj" },
];

const SCOPE_OPTIONS = [
  { id: 1, name: "Deep Clean" },
  { id: 2, name: "Standard Clean" },
  { id: 3, name: "One-Time Standard Clean" },
  { id: 4, name: "Recurring Weekly" },
  { id: 5, name: "Hourly Deep Clean" },
  { id: 6, name: "Hourly Standard" },
  { id: 7, name: "Commercial" },
  { id: 8, name: "PPM Turnover" },
  { id: 9, name: "Recurring Every 2 Weeks" },
  { id: 10, name: "Recurring Every 4 Weeks" },
  { id: 12, name: "Move In / Move Out" },
];

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: value ? "var(--brand)" : "#CBD5E1" }}>
      {value ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
    </button>
  );
}

function ScopeIds({ ids }: { ids: number[] }) {
  const names = ids.map(id => SCOPE_OPTIONS.find(s => s.id === id)?.name?.split(" ")[0] ?? String(id));
  if (!names.length) return <span style={{ color: "#9E9B94", fontSize: 12 }}>None</span>;
  return (
    <span style={{ fontSize: 11, color: "#6B6860" }}>
      {names.join(", ")}
    </span>
  );
}

type Addon = {
  id: number;
  name: string;
  price_type: string;
  price_value: string;
  scope_ids: number[] | string;
  show_online: boolean;
  show_office: boolean;
  is_active: boolean;
  sort_order: number;
};

type Bundle = {
  id: number;
  name: string;
  description: string;
  discount_type: string;
  discount_value: string;
  active: boolean;
  items: { id: number; addon_id: number; addon_name: string }[];
};

type FeeRule = {
  id: number;
  rule_type: string;
  label: string;
  charge_percent: string;
  tech_split_percent: string;
  window_hours: number;
  is_active: boolean;
};

const EMPTY_ADDON = { name: "", price_type: "flat", price_value: "0", scope_ids: [] as number[], show_online: true, show_office: true };

export function AddonsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: addons = [] } = useQuery<Addon[]>({
    queryKey: ["pricing-addons-all"],
    queryFn: () => apiFetch("/api/pricing/addons?all=true"),
  });

  const { data: bundles = [] } = useQuery<Bundle[]>({
    queryKey: ["bundles"],
    queryFn: () => apiFetch("/api/bundles"),
  });

  const { data: feeRules = [] } = useQuery<FeeRule[]>({
    queryKey: ["fee-rules"],
    queryFn: () => apiFetch("/api/pricing/fee-rules"),
  });

  const patchAddon = useMutation({
    mutationFn: ({ id, updates }: { id: number; updates: Record<string, any> }) =>
      apiFetch(`/api/pricing/addons/${id}`, { method: "PATCH", body: JSON.stringify(updates) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-addons-all"] }); toast({ title: "Saved" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const createAddon = useMutation({
    mutationFn: (data: typeof EMPTY_ADDON) => apiFetch("/api/pricing/addons", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-addons-all"] }); setShowNewAddon(false); setNewAddon({ ...EMPTY_ADDON }); toast({ title: "Add-on created" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const patchBundle = useMutation({
    mutationFn: ({ id, updates }: { id: number; updates: Record<string, any> }) =>
      apiFetch(`/api/bundles/${id}`, { method: "PUT", body: JSON.stringify(updates) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bundles"] }); toast({ title: "Bundle updated" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const toggleBundle = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/bundles/${id}/toggle`, { method: "PUT" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bundles"] }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const patchFeeRule = useMutation({
    mutationFn: ({ id, updates }: { id: number; updates: Record<string, any> }) =>
      apiFetch(`/api/pricing/fee-rules/${id}`, { method: "PATCH", body: JSON.stringify(updates) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fee-rules"] }); toast({ title: "Saved" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editRow, setEditRow] = useState<Partial<Addon>>({});
  const [editScopeIds, setEditScopeIds] = useState<number[]>([]);
  const [showScopeEdit, setShowScopeEdit] = useState<number | null>(null);

  const [showNewAddon, setShowNewAddon] = useState(false);
  const [newAddon, setNewAddon] = useState({ ...EMPTY_ADDON });
  const [newAddonScopes, setNewAddonScopes] = useState<number[]>([]);

  const [editBundleDiscount, setEditBundleDiscount] = useState<Record<number, string>>({});
  const [editFeeRule, setEditFeeRule] = useState<Record<number, Partial<FeeRule>>>({});

  function parseScopeIds(raw: number[] | string): number[] {
    if (Array.isArray(raw)) return raw.map(Number);
    try { return JSON.parse(String(raw)).map(Number); } catch { return []; }
  }

  function startEdit(addon: Addon) {
    setEditingId(addon.id);
    setEditRow({ name: addon.name, price_type: addon.price_type, price_value: addon.price_value });
    setEditScopeIds(parseScopeIds(addon.scope_ids));
    setShowScopeEdit(null);
  }

  function saveEdit(addon: Addon) {
    patchAddon.mutate({ id: addon.id, updates: { ...editRow, scope_ids: editScopeIds } });
    setEditingId(null);
  }

  function cancelEdit() { setEditingId(null); }

  function toggleScopeInEdit(id: number, current: number[], setter: (v: number[]) => void) {
    setter(current.includes(id) ? current.filter(x => x !== id) : [...current, id]);
  }

  return (
    <div>
      {/* ── Add-ons Table ─────────────────────────────────────────────── */}
      <div style={card}>
        <p style={sectionHead}>Add-ons</p>
        <p style={sectionSub}>Manage all add-ons — pricing, scope visibility, and online availability.</p>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>Type</th>
                <th style={th}>Value</th>
                <th style={th}>Scopes</th>
                <th style={{ ...th, textAlign: "center" as const }}>Online</th>
                <th style={{ ...th, textAlign: "center" as const }}>Active</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {addons.map(addon => {
                const isEditing = editingId === addon.id;
                const scopeIds = parseScopeIds(addon.scope_ids);
                return (
                  <tr key={addon.id}>
                    <td style={{ ...td, fontWeight: 500 }}>
                      {isEditing
                        ? <input style={{ ...inputStyle, width: 180 }} value={String(editRow.name ?? "")} onChange={e => setEditRow(p => ({ ...p, name: e.target.value }))} />
                        : addon.name}
                    </td>
                    <td style={td}>
                      {isEditing
                        ? <select style={{ ...selectStyle, width: 130 }} value={String(editRow.price_type ?? "")} onChange={e => setEditRow(p => ({ ...p, price_type: e.target.value }))}>
                            {PRICE_TYPES.map(pt => <option key={pt.value} value={pt.value}>{pt.label}</option>)}
                          </select>
                        : <span style={{ fontSize: 12, background: "#F4F3F0", borderRadius: 4, padding: "2px 6px" }}>{addon.price_type}</span>}
                    </td>
                    <td style={td}>
                      {isEditing
                        ? <input style={{ ...inputStyle, width: 80 }} type="number" step="0.01" value={String(editRow.price_value ?? "")} onChange={e => setEditRow(p => ({ ...p, price_value: e.target.value }))} />
                        : <span style={{ fontWeight: 600 }}>{Number(addon.price_value) !== 0 ? `$${Number(addon.price_value).toFixed(2)}` : "—"}</span>}
                    </td>
                    <td style={{ ...td, maxWidth: 220 }}>
                      {isEditing ? (
                        <div>
                          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4, marginBottom: 4 }}>
                            {SCOPE_OPTIONS.map(s => (
                              <button key={s.id} onClick={() => toggleScopeInEdit(s.id, editScopeIds, setEditScopeIds)}
                                style={{ fontSize: 11, padding: "2px 7px", borderRadius: 4, border: `1px solid ${editScopeIds.includes(s.id) ? "var(--brand)" : "#E5E2DC"}`, background: editScopeIds.includes(s.id) ? `var(--brand)15` : "#fff", color: editScopeIds.includes(s.id) ? "var(--brand)" : "#6B6860", cursor: "pointer", fontFamily: "inherit" }}>
                                {s.name.split(" ")[0]}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <ScopeIds ids={scopeIds} />
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "center" as const }}>
                      <Toggle value={addon.show_online} onChange={() => patchAddon.mutate({ id: addon.id, updates: { show_online: !addon.show_online } })} />
                    </td>
                    <td style={{ ...td, textAlign: "center" as const }}>
                      <Toggle value={addon.is_active} onChange={() => patchAddon.mutate({ id: addon.id, updates: { is_active: !addon.is_active } })} />
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" as const }}>
                      {isEditing ? (
                        <div style={{ display: "flex", gap: 4 }}>
                          <button style={{ ...btnGhost, color: "var(--brand)", borderColor: "var(--brand)" }} onClick={() => saveEdit(addon)}><Check size={13} /> Save</button>
                          <button style={btnGhost} onClick={cancelEdit}><X size={13} /></button>
                        </div>
                      ) : (
                        <button style={btnGhost} onClick={() => startEdit(addon)}><Edit2 size={12} /> Edit</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <button style={{ ...btnPrimary, marginTop: 14 }} onClick={() => { setShowNewAddon(true); setNewAddon({ ...EMPTY_ADDON }); setNewAddonScopes([]); }}>
          <Plus size={14} /> Add New
        </button>

        {/* New add-on modal */}
        {showNewAddon && (
          <>
            <div onClick={() => setShowNewAddon(false)} style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", zIndex: 200 }} />
            <div style={{
              position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
              zIndex: 201, backgroundColor: "#FFFFFF", borderRadius: 12, width: 480, maxWidth: "calc(100vw - 32px)",
              boxShadow: "0 16px 48px rgba(0,0,0,0.18)", padding: "28px 28px 24px", display: "flex", flexDirection: "column", gap: 18,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h3 style={{ margin: 0, fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: 17, color: "#1A1917" }}>New Add-on</h3>
                <button onClick={() => setShowNewAddon(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4, display: "flex" }}>
                  <X size={18} />
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#6B6860" }}>Name <span style={{ color: "#EF4444" }}>*</span></label>
                <input
                  autoFocus
                  style={{ ...inputStyle, width: "100%", boxSizing: "border-box" as const }}
                  value={newAddon.name}
                  onChange={e => setNewAddon(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Oven Cleaning"
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#6B6860" }}>Price Type</label>
                  <select style={{ ...selectStyle, width: "100%" }} value={newAddon.price_type} onChange={e => setNewAddon(p => ({ ...p, price_type: e.target.value }))}>
                    {PRICE_TYPES.map(pt => <option key={pt.value} value={pt.value}>{pt.label}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#6B6860" }}>Value</label>
                  <input
                    style={{ ...inputStyle, width: "100%", boxSizing: "border-box" as const }}
                    type="number" step="0.01" min="0"
                    value={newAddon.price_value}
                    onChange={e => setNewAddon(p => ({ ...p, price_value: e.target.value }))}
                  />
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#6B6860" }}>Applies to Scopes</label>
                <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4 }}>
                  {SCOPE_OPTIONS.map(s => (
                    <button key={s.id} onClick={() => toggleScopeInEdit(s.id, newAddonScopes, setNewAddonScopes)}
                      style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: `1px solid ${newAddonScopes.includes(s.id) ? "var(--brand)" : "#E5E2DC"}`, background: newAddonScopes.includes(s.id) ? "var(--brand)" : "#fff", color: newAddonScopes.includes(s.id) ? "#fff" : "#6B6860", cursor: "pointer", fontFamily: "inherit", fontWeight: newAddonScopes.includes(s.id) ? 600 : 400 }}>
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", gap: 20 }}>
                <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" as const }}>
                  <div
                    onClick={() => setNewAddon(p => ({ ...p, show_online: !p.show_online }))}
                    style={{ width: 38, height: 22, borderRadius: 11, backgroundColor: newAddon.show_online ? "var(--brand)" : "#E5E2DC", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}
                  >
                    <div style={{ position: "absolute", top: 3, left: newAddon.show_online ? 19 : 3, width: 16, height: 16, borderRadius: "50%", backgroundColor: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                  </div>
                  Show in booking widget
                </label>
                <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" as const }}>
                  <div
                    onClick={() => setNewAddon(p => ({ ...p, show_office: !p.show_office }))}
                    style={{ width: 38, height: 22, borderRadius: 11, backgroundColor: newAddon.show_office ? "var(--brand)" : "#E5E2DC", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}
                  >
                    <div style={{ position: "absolute", top: 3, left: newAddon.show_office ? 19 : 3, width: 16, height: 16, borderRadius: "50%", backgroundColor: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                  </div>
                  Show in office (job wizard)
                </label>
              </div>

              <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
                <button
                  style={{ ...btnPrimary, flex: 1, justifyContent: "center" }}
                  onClick={() => createAddon.mutate({ ...newAddon, scope_ids: newAddonScopes })}
                  disabled={!newAddon.name || createAddon.isPending}
                >
                  <Check size={14} /> {createAddon.isPending ? "Saving..." : "Create Add-on"}
                </button>
                <button style={{ ...btnGhost, padding: "8px 18px" }} onClick={() => { setShowNewAddon(false); setNewAddon({ ...EMPTY_ADDON }); setNewAddonScopes([]); }}>
                  Cancel
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Bundle Management ─────────────────────────────────────────── */}
      <div style={card}>
        <p style={sectionHead}>Bundle Management</p>
        <p style={sectionSub}>Add-on bundles apply automatic discounts when multiple add-ons are selected together.</p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Bundle Name</th>
              <th style={th}>Includes</th>
              <th style={th}>Discount</th>
              <th style={{ ...th, textAlign: "center" as const }}>Active</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {bundles.map(bundle => (
              <tr key={bundle.id}>
                <td style={{ ...td, fontWeight: 500 }}>{bundle.name}</td>
                <td style={td}>
                  <span style={{ fontSize: 12, color: "#6B6860" }}>
                    {(bundle.items ?? []).map((it: any) => it.addon_name).join(" + ")}
                  </span>
                </td>
                <td style={td}>
                  {editBundleDiscount[bundle.id] !== undefined ? (
                    <div style={{ display: "flex", gap: 4 }}>
                      <input style={{ ...inputStyle, width: 80 }} type="number" step="0.01" value={editBundleDiscount[bundle.id]}
                        onChange={e => setEditBundleDiscount(p => ({ ...p, [bundle.id]: e.target.value }))} />
                      <button style={{ ...btnGhost, color: "var(--brand)", borderColor: "var(--brand)" }}
                        onClick={() => {
                          patchBundle.mutate({ id: bundle.id, updates: { discount_value: editBundleDiscount[bundle.id], discount_type: bundle.discount_type } });
                          setEditBundleDiscount(p => { const n = { ...p }; delete n[bundle.id]; return n; });
                        }}>
                        <Check size={13} />
                      </button>
                      <button style={btnGhost} onClick={() => setEditBundleDiscount(p => { const n = { ...p }; delete n[bundle.id]; return n; })}><X size={13} /></button>
                    </div>
                  ) : (
                    <span
                      style={{ fontWeight: 600, cursor: "pointer", borderBottom: "1px dashed #D1CEC9" }}
                      onClick={() => setEditBundleDiscount(p => ({ ...p, [bundle.id]: bundle.discount_value }))}>
                      ${Number(bundle.discount_value).toFixed(2)} / item
                    </span>
                  )}
                </td>
                <td style={{ ...td, textAlign: "center" as const }}>
                  <Toggle value={bundle.active} onChange={() => toggleBundle.mutate(bundle.id)} />
                </td>
                <td style={td}></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Fee Rules ─────────────────────────────────────────────────── */}
      <div style={card}>
        <p style={sectionHead}>Fee Rules</p>
        <p style={sectionSub}>Configure skip and lockout fees applied to jobs.</p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Rule</th>
              <th style={th}>Charge %</th>
              <th style={th}>Tech Split %</th>
              <th style={th}>Window (hrs)</th>
              <th style={{ ...th, textAlign: "center" as const }}>Active</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {feeRules.map(rule => {
              const editing = editFeeRule[rule.id];
              return (
                <tr key={rule.id}>
                  <td style={{ ...td, fontWeight: 500 }}>{rule.label}</td>
                  <td style={td}>
                    {editing ? (
                      <input style={{ ...inputStyle, width: 70 }} type="number" step="0.01" value={String(editing.charge_percent ?? rule.charge_percent)}
                        onChange={e => setEditFeeRule(p => ({ ...p, [rule.id]: { ...p[rule.id], charge_percent: e.target.value as any } }))} />
                    ) : `${rule.charge_percent}%`}
                  </td>
                  <td style={td}>
                    {editing ? (
                      <input style={{ ...inputStyle, width: 70 }} type="number" step="0.01" value={String(editing.tech_split_percent ?? rule.tech_split_percent)}
                        onChange={e => setEditFeeRule(p => ({ ...p, [rule.id]: { ...p[rule.id], tech_split_percent: e.target.value as any } }))} />
                    ) : `${rule.tech_split_percent}%`}
                  </td>
                  <td style={td}>
                    {editing ? (
                      <input style={{ ...inputStyle, width: 60 }} type="number" value={String(editing.window_hours ?? rule.window_hours)}
                        onChange={e => setEditFeeRule(p => ({ ...p, [rule.id]: { ...p[rule.id], window_hours: parseInt(e.target.value) } }))} />
                    ) : rule.window_hours}
                  </td>
                  <td style={{ ...td, textAlign: "center" as const }}>
                    <Toggle value={rule.is_active} onChange={() => patchFeeRule.mutate({ id: rule.id, updates: { is_active: !rule.is_active } })} />
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" as const }}>
                    {editing ? (
                      <div style={{ display: "flex", gap: 4 }}>
                        <button style={{ ...btnGhost, color: "var(--brand)", borderColor: "var(--brand)" }}
                          onClick={() => {
                            patchFeeRule.mutate({ id: rule.id, updates: {
                              charge_percent: editing.charge_percent ?? rule.charge_percent,
                              tech_split_percent: editing.tech_split_percent ?? rule.tech_split_percent,
                              window_hours: editing.window_hours ?? rule.window_hours,
                            }});
                            setEditFeeRule(p => { const n = { ...p }; delete n[rule.id]; return n; });
                          }}>
                          <Check size={13} /> Save
                        </button>
                        <button style={btnGhost} onClick={() => setEditFeeRule(p => { const n = { ...p }; delete n[rule.id]; return n; })}><X size={13} /></button>
                      </div>
                    ) : (
                      <button style={btnGhost} onClick={() => setEditFeeRule(p => ({ ...p, [rule.id]: {} }))}><Edit2 size={12} /> Edit</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
