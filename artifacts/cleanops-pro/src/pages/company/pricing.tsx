import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { Plus, Trash2, ChevronDown, ChevronRight, Save, ToggleLeft, ToggleRight, Edit2, X, Check, Tag } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "Error");
    throw new Error(msg);
  }
  return r.json();
}

// ── Shared styles ──────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: "#FFFFFF",
  border: "1px solid #E5E2DC",
  borderRadius: 10,
  padding: "20px 24px",
  marginBottom: 16,
};

const sectionHead: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 14,
  fontWeight: 700,
  color: "#1A1917",
  marginBottom: 4,
};

const sectionSub: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 12,
  color: "#6B6860",
  marginBottom: 16,
};

const th: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 11,
  fontWeight: 700,
  color: "#9E9B94",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  padding: "6px 10px",
  textAlign: "left" as const,
  borderBottom: "1px solid #E5E2DC",
};

const td: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 13,
  color: "#1A1917",
  padding: "8px 10px",
  borderBottom: "1px solid #F0EDE8",
  verticalAlign: "middle" as const,
};

const inp: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 13,
  color: "#1A1917",
  border: "1px solid #E5E2DC",
  borderRadius: 6,
  padding: "6px 10px",
  outline: "none",
  background: "#FAFAF8",
  width: "100%",
  boxSizing: "border-box" as const,
};

const btn = (variant: "primary" | "secondary" | "ghost" | "danger" = "secondary"): React.CSSProperties => ({
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 7,
  padding: "7px 14px",
  border: "none",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: variant === "primary" ? "var(--brand)" : variant === "danger" ? "#FEE2E2" : variant === "ghost" ? "transparent" : "#F7F6F3",
  color: variant === "primary" ? "#fff" : variant === "danger" ? "#DC2626" : "#1A1917",
  transition: "opacity 0.15s",
});

function Badge({ children, color = "#6B6860" }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 11, fontWeight: 600, background: "#F7F6F3", color, border: "1px solid #E5E2DC", borderRadius: 5, padding: "2px 8px" }}>
      {children}
    </span>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface Scope { id: number; name: string; scope_group: string; hourly_rate: string; minimum_bill: string; is_active: boolean; sort_order: number; }
interface Tier { id?: number; min_sqft: number | string; max_sqft: number | string; hours: number | string; }
interface Frequency { id?: number; frequency: string; label: string; rate_override: string | null; multiplier: string; }
interface Addon { id: number; name: string; price: string | null; price_type: string; percent_of_base: string | null; time_add_minutes: number; unit: string; is_active: boolean; }
interface Discount { id: number; code: string; description: string; discount_type: string; discount_value: string; is_active: boolean; }
interface FeeRule { id: number; rule_type: string; label: string; charge_percent: string; tech_split_percent: string; window_hours: number | null; is_active: boolean; }

const FREQUENCIES = [
  { frequency: "onetime", label: "One Time" },
  { frequency: "weekly", label: "Weekly" },
  { frequency: "biweekly", label: "Bi-Weekly" },
  { frequency: "monthly", label: "Monthly" },
];

// ── Main Component ─────────────────────────────────────────────────────────────

export function PricingTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expandedScope, setExpandedScope] = useState<number | null>(null);
  const [scopeSubTab, setScopeSubTab] = useState<"tiers" | "frequencies" | "addons">("tiers");
  const [showNewScope, setShowNewScope] = useState(false);
  const [newScope, setNewScope] = useState({ name: "", scope_group: "Residential", hourly_rate: "", minimum_bill: "" });

  const { data: scopes = [] } = useQuery<Scope[]>({ queryKey: ["pricing-scopes"], queryFn: () => apiFetch("/api/pricing/scopes") });
  const { data: discounts = [] } = useQuery<Discount[]>({ queryKey: ["pricing-discounts"], queryFn: () => apiFetch("/api/pricing/discounts") });
  const { data: fees = [] } = useQuery<FeeRule[]>({ queryKey: ["pricing-fees"], queryFn: () => apiFetch("/api/pricing/fees") });

  const createScope = useMutation({
    mutationFn: (body: typeof newScope) => apiFetch("/api/pricing/scopes", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-scopes"] }); setShowNewScope(false); setNewScope({ name: "", scope_group: "Residential", hourly_rate: "", minimum_bill: "" }); toast({ title: "Scope created" }); },
    onError: () => toast({ title: "Failed to create scope", variant: "destructive" }),
  });

  const toggleScope = useMutation({
    mutationFn: (s: Scope) => apiFetch(`/api/pricing/scopes/${s.id}`, { method: "PUT", body: JSON.stringify({ is_active: !s.is_active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pricing-scopes"] }),
  });

  const deleteScope = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/pricing/scopes/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-scopes"] }); if (expandedScope) setExpandedScope(null); },
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>

      {/* ── Scopes of Work ─────────────────────────────────────────────── */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={sectionHead}>Scopes of Work</div>
            <div style={sectionSub}>Configure pricing for each cleaning scope. Click to expand tiers, frequencies, and add-ons.</div>
          </div>
          <button style={btn("primary")} onClick={() => setShowNewScope(v => !v)}><Plus size={14} />New Scope</button>
        </div>

        {showNewScope && (
          <div style={{ ...card, borderColor: "var(--brand)", marginBottom: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 140px 140px auto", gap: 10, alignItems: "end" }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>SCOPE NAME</div>
                <input style={inp} placeholder="e.g. Deep Clean or Move In/Out" value={newScope.name} onChange={e => setNewScope(p => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>GROUP</div>
                <select style={{ ...inp }} value={newScope.scope_group} onChange={e => setNewScope(p => ({ ...p, scope_group: e.target.value }))}>
                  <option>Residential</option>
                  <option>Commercial</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>HOURLY RATE ($)</div>
                <input style={inp} type="number" placeholder="70" value={newScope.hourly_rate} onChange={e => setNewScope(p => ({ ...p, hourly_rate: e.target.value }))} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>MIN BILL ($)</div>
                <input style={inp} type="number" placeholder="210" value={newScope.minimum_bill} onChange={e => setNewScope(p => ({ ...p, minimum_bill: e.target.value }))} />
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={btn("primary")} onClick={() => createScope.mutate(newScope)} disabled={!newScope.name}><Check size={13} />Save</button>
                <button style={btn()} onClick={() => setShowNewScope(false)}><X size={13} /></button>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {scopes.map(scope => (
            <div key={scope.id} style={{ border: "1px solid #E5E2DC", borderRadius: 10, background: "#fff", overflow: "hidden" }}>
              <div
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", cursor: "pointer", userSelect: "none" }}
                onClick={() => { setExpandedScope(expandedScope === scope.id ? null : scope.id); setScopeSubTab("tiers"); }}
              >
                {expandedScope === scope.id ? <ChevronDown size={15} color="#9E9B94" /> : <ChevronRight size={15} color="#9E9B94" />}
                <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 14, color: "#1A1917", flex: 1 }}>{scope.name}</span>
                <Badge>{scope.scope_group}</Badge>
                <span style={{ fontSize: 12, color: "#6B6860", minWidth: 80 }}>${parseFloat(scope.hourly_rate).toFixed(0)}/hr</span>
                <span style={{ fontSize: 12, color: "#6B6860", minWidth: 90 }}>Min ${parseFloat(scope.minimum_bill).toFixed(0)}</span>
                <button
                  style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}
                  onClick={e => { e.stopPropagation(); toggleScope.mutate(scope); }}
                  title={scope.is_active ? "Deactivate" : "Activate"}
                >
                  {scope.is_active ? <ToggleRight size={20} color="var(--brand)" /> : <ToggleLeft size={20} color="#9E9B94" />}
                </button>
                <button
                  style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}
                  onClick={e => { e.stopPropagation(); if (confirm(`Delete "${scope.name}"?`)) deleteScope.mutate(scope.id); }}
                >
                  <Trash2 size={14} color="#DC2626" />
                </button>
              </div>

              {expandedScope === scope.id && (
                <div style={{ borderTop: "1px solid #E5E2DC" }}>
                  <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #E5E2DC", padding: "0 18px" }}>
                    {(["tiers", "frequencies", "addons"] as const).map(t => (
                      <button key={t} onClick={() => setScopeSubTab(t)} style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 12, fontWeight: scopeSubTab === t ? 600 : 400, color: scopeSubTab === t ? "var(--brand)" : "#6B6860", borderBottom: `2px solid ${scopeSubTab === t ? "var(--brand)" : "transparent"}`, border: "none", background: "transparent", padding: "10px 14px", marginBottom: -1, cursor: "pointer", textTransform: "capitalize" }}>
                        {t === "frequencies" ? "Frequencies" : t === "addons" ? "Add-Ons" : "Pricing Tiers"}
                      </button>
                    ))}
                  </div>
                  <div style={{ padding: "16px 18px" }}>
                    {scopeSubTab === "tiers" && <TiersEditor scopeId={scope.id} />}
                    {scopeSubTab === "frequencies" && <FrequenciesEditor scopeId={scope.id} />}
                    {scopeSubTab === "addons" && <AddonsEditor scopeId={scope.id} />}
                  </div>
                </div>
              )}
            </div>
          ))}
          {scopes.length === 0 && <div style={{ textAlign: "center", padding: 32, color: "#9E9B94", fontSize: 13 }}>No scopes yet. Create your first scope above.</div>}
        </div>
      </div>

      {/* ── Discount Codes ──────────────────────────────────────────────── */}
      <DiscountsSection discounts={discounts} />

      {/* ── Fee Rules ───────────────────────────────────────────────────── */}
      <FeesSection fees={fees} />

      {/* ── Bundles & Promotions ────────────────────────────────────────── */}
      <BundlesSection />

      {/* ── Offers & Incentives ─────────────────────────────────────────── */}
      <OffersSection />
    </div>
  );
}

// ── Tiers Editor ───────────────────────────────────────────────────────────────

function TiersEditor({ scopeId }: { scopeId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: serverTiers = [], isLoading } = useQuery<Tier[]>({ queryKey: ["pricing-tiers", scopeId], queryFn: () => apiFetch(`/api/pricing/scopes/${scopeId}/tiers`) });
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (!dirty) setTiers(serverTiers); }, [serverTiers]);

  const saveTiers = useMutation({
    mutationFn: () => apiFetch(`/api/pricing/scopes/${scopeId}/tiers`, { method: "POST", body: JSON.stringify(tiers.map(t => ({ min_sqft: Number(t.min_sqft), max_sqft: Number(t.max_sqft), hours: t.hours }))) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-tiers", scopeId] }); setDirty(false); toast({ title: "Tiers saved" }); },
    onError: () => toast({ title: "Failed to save tiers", variant: "destructive" }),
  });

  function addRow() {
    const last = tiers[tiers.length - 1];
    const newMin = last ? Number(last.max_sqft) : 1000;
    setTiers(p => [...p, { min_sqft: newMin, max_sqft: newMin + 200, hours: 0 }]);
    setDirty(true);
  }

  function updateTier(idx: number, field: keyof Tier, val: string) {
    setTiers(p => p.map((t, i) => i === idx ? { ...t, [field]: val } : t));
    setDirty(true);
  }

  function removeRow(idx: number) {
    setTiers(p => p.filter((_, i) => i !== idx));
    setDirty(true);
  }

  if (isLoading) return <div style={{ color: "#9E9B94", fontSize: 13, padding: 8 }}>Loading tiers...</div>;

  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Min Sqft</th>
              <th style={th}>Max Sqft</th>
              <th style={th}>Hours</th>
              <th style={{ ...th, width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i}>
                <td style={td}><input style={{ ...inp, width: 100 }} type="number" value={t.min_sqft} onChange={e => updateTier(i, "min_sqft", e.target.value)} /></td>
                <td style={td}><input style={{ ...inp, width: 100 }} type="number" value={t.max_sqft} onChange={e => updateTier(i, "max_sqft", e.target.value)} /></td>
                <td style={td}><input style={{ ...inp, width: 80 }} type="number" step="0.1" value={t.hours} onChange={e => updateTier(i, "hours", e.target.value)} /></td>
                <td style={td}><button style={{ background: "none", border: "none", cursor: "pointer" }} onClick={() => removeRow(i)}><Trash2 size={13} color="#DC2626" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button style={btn()} onClick={addRow}><Plus size={13} />Add Row</button>
        {dirty && <button style={btn("primary")} onClick={() => saveTiers.mutate()} disabled={saveTiers.isPending}><Save size={13} />{saveTiers.isPending ? "Saving..." : "Save Tiers"}</button>}
      </div>
      {tiers.length === 0 && <div style={{ color: "#9E9B94", fontSize: 13, padding: "8px 0" }}>No tiers yet. Click Add Row to start.</div>}
    </div>
  );
}

// ── Frequencies Editor ─────────────────────────────────────────────────────────

function FrequenciesEditor({ scopeId }: { scopeId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: serverFreqs, isLoading } = useQuery<Frequency[]>({ queryKey: ["pricing-frequencies", scopeId], queryFn: () => apiFetch(`/api/pricing/scopes/${scopeId}/frequencies`) });
  const [freqs, setFreqs] = useState<Frequency[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty && serverFreqs) {
      if (serverFreqs.length > 0) {
        setFreqs(serverFreqs);
      } else {
        setFreqs(FREQUENCIES.map((f, i) => ({ frequency: f.frequency, label: f.label, rate_override: null, multiplier: "1.0000", sort_order: i } as any)));
      }
    }
  }, [serverFreqs]);

  const save = useMutation({
    mutationFn: () => apiFetch(`/api/pricing/scopes/${scopeId}/frequencies`, { method: "POST", body: JSON.stringify(freqs) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-frequencies", scopeId] }); setDirty(false); toast({ title: "Frequencies saved" }); },
    onError: () => toast({ title: "Failed to save frequencies", variant: "destructive" }),
  });

  function update(idx: number, field: keyof Frequency, val: string) {
    setFreqs(p => p.map((f, i) => i === idx ? { ...f, [field]: val === "" && field === "rate_override" ? null : val } : f));
    setDirty(true);
  }

  if (isLoading) return <div style={{ color: "#9E9B94", fontSize: 13 }}>Loading...</div>;

  return (
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Frequency</th>
            <th style={th}>Label</th>
            <th style={th}>Rate Override ($/hr)</th>
            <th style={th}>Multiplier</th>
          </tr>
        </thead>
        <tbody>
          {freqs.map((f, i) => (
            <tr key={f.frequency}>
              <td style={td}><span style={{ fontWeight: 600 }}>{f.frequency}</span></td>
              <td style={td}><input style={{ ...inp, width: 120 }} value={f.label} onChange={e => update(i, "label", e.target.value)} /></td>
              <td style={td}><input style={{ ...inp, width: 110 }} type="number" step="0.01" placeholder="No override" value={f.rate_override ?? ""} onChange={e => update(i, "rate_override", e.target.value)} /></td>
              <td style={td}><input style={{ ...inp, width: 90 }} type="number" step="0.01" value={f.multiplier} onChange={e => update(i, "multiplier", e.target.value)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {dirty && (
        <button style={{ ...btn("primary"), marginTop: 12 }} onClick={() => save.mutate()} disabled={save.isPending}>
          <Save size={13} />{save.isPending ? "Saving..." : "Save Frequencies"}
        </button>
      )}
    </div>
  );
}

// ── Add-ons Editor ─────────────────────────────────────────────────────────────

function AddonsEditor({ scopeId }: { scopeId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: addons = [], isLoading } = useQuery<Addon[]>({ queryKey: ["pricing-addons", scopeId], queryFn: () => apiFetch(`/api/pricing/scopes/${scopeId}/addons`) });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", price: "", price_type: "flat", percent_of_base: "", time_add_minutes: "0", unit: "each" });
  const [editId, setEditId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Partial<Addon>>({});

  const create = useMutation({
    mutationFn: () => apiFetch(`/api/pricing/scopes/${scopeId}/addons`, { method: "POST", body: JSON.stringify({ ...form, price: form.price_type === "flat" ? form.price : null, percent_of_base: form.price_type === "percent" ? form.percent_of_base : null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-addons", scopeId] }); setShowForm(false); setForm({ name: "", price: "", price_type: "flat", percent_of_base: "", time_add_minutes: "0", unit: "each" }); toast({ title: "Add-on created" }); },
    onError: () => toast({ title: "Failed to create add-on", variant: "destructive" }),
  });

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Addon> }) => apiFetch(`/api/pricing/addons/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-addons", scopeId] }); setEditId(null); toast({ title: "Add-on updated" }); },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/pricing/addons/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-addons", scopeId] }); toast({ title: "Add-on removed" }); },
  });

  const toggle = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => apiFetch(`/api/pricing/addons/${id}`, { method: "PUT", body: JSON.stringify({ is_active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pricing-addons", scopeId] }),
  });

  if (isLoading) return <div style={{ color: "#9E9B94", fontSize: 13 }}>Loading...</div>;

  return (
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead>
          <tr>
            <th style={th}>Name</th>
            <th style={th}>Type</th>
            <th style={th}>Price / %</th>
            <th style={th}>Min Add</th>
            <th style={th}>Active</th>
            <th style={{ ...th, width: 60 }}></th>
          </tr>
        </thead>
        <tbody>
          {addons.map(a => editId === a.id ? (
            <tr key={a.id}>
              <td style={td}><input style={{ ...inp, width: 160 }} value={editForm.name ?? a.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} /></td>
              <td style={td}>
                <select style={{ ...inp, width: 90 }} value={editForm.price_type ?? a.price_type} onChange={e => setEditForm(p => ({ ...p, price_type: e.target.value }))}>
                  <option value="flat">Flat</option>
                  <option value="percent">%</option>
                </select>
              </td>
              <td style={td}>
                {(editForm.price_type ?? a.price_type) === "flat"
                  ? <input style={{ ...inp, width: 80 }} type="number" value={editForm.price ?? a.price ?? ""} onChange={e => setEditForm(p => ({ ...p, price: e.target.value }))} />
                  : <input style={{ ...inp, width: 80 }} type="number" value={editForm.percent_of_base ?? a.percent_of_base ?? ""} onChange={e => setEditForm(p => ({ ...p, percent_of_base: e.target.value }))} />
                }
              </td>
              <td style={td}><input style={{ ...inp, width: 60 }} type="number" value={editForm.time_add_minutes ?? a.time_add_minutes} onChange={e => setEditForm(p => ({ ...p, time_add_minutes: parseInt(e.target.value) }))} /></td>
              <td style={td}></td>
              <td style={td}>
                <div style={{ display: "flex", gap: 4 }}>
                  <button style={btn("primary")} onClick={() => update.mutate({ id: a.id, data: { ...editForm } })}><Check size={12} /></button>
                  <button style={btn()} onClick={() => setEditId(null)}><X size={12} /></button>
                </div>
              </td>
            </tr>
          ) : (
            <tr key={a.id} style={{ opacity: a.is_active ? 1 : 0.45 }}>
              <td style={td}>{a.name}</td>
              <td style={td}><Badge>{a.price_type === "flat" ? "Flat" : "Percent"}</Badge></td>
              <td style={td}>{a.price_type === "flat" ? `$${parseFloat(a.price ?? "0").toFixed(2)}` : `${parseFloat(a.percent_of_base ?? "0").toFixed(0)}% of base`}</td>
              <td style={td}>{a.time_add_minutes > 0 ? `+${a.time_add_minutes}min` : "—"}</td>
              <td style={td}>
                <button style={{ background: "none", border: "none", cursor: "pointer" }} onClick={() => toggle.mutate({ id: a.id, is_active: !a.is_active })}>
                  {a.is_active ? <ToggleRight size={18} color="var(--brand)" /> : <ToggleLeft size={18} color="#9E9B94" />}
                </button>
              </td>
              <td style={td}>
                <div style={{ display: "flex", gap: 4 }}>
                  <button style={{ background: "none", border: "none", cursor: "pointer" }} onClick={() => { setEditId(a.id); setEditForm({}); }}><Edit2 size={13} color="#6B6860" /></button>
                  <button style={{ background: "none", border: "none", cursor: "pointer" }} onClick={() => del.mutate(a.id)}><Trash2 size={13} color="#DC2626" /></button>
                </div>
              </td>
            </tr>
          ))}
          {addons.length === 0 && <tr><td colSpan={6} style={{ ...td, color: "#9E9B94", textAlign: "center", padding: 16 }}>No add-ons yet.</td></tr>}
        </tbody>
      </table>

      {showForm ? (
        <div style={{ ...card, marginBottom: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 110px 80px 80px auto", gap: 10, alignItems: "end" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>NAME</div>
              <input style={inp} placeholder="e.g. Oven" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>TYPE</div>
              <select style={{ ...inp }} value={form.price_type} onChange={e => setForm(p => ({ ...p, price_type: e.target.value }))}>
                <option value="flat">Flat $</option>
                <option value="percent">Percent %</option>
              </select>
            </div>
            {form.price_type === "flat" ? (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>PRICE ($)</div>
                <input style={inp} type="number" placeholder="50" value={form.price} onChange={e => setForm(p => ({ ...p, price: e.target.value }))} />
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>% OF BASE</div>
                <input style={inp} type="number" placeholder="15" value={form.percent_of_base} onChange={e => setForm(p => ({ ...p, percent_of_base: e.target.value }))} />
              </div>
            )}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>+MIN</div>
              <input style={inp} type="number" placeholder="0" value={form.time_add_minutes} onChange={e => setForm(p => ({ ...p, time_add_minutes: e.target.value }))} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>UNIT</div>
              <input style={inp} placeholder="each" value={form.unit} onChange={e => setForm(p => ({ ...p, unit: e.target.value }))} />
            </div>
            <div style={{ display: "flex", gap: 6, paddingTop: 20 }}>
              <button style={btn("primary")} onClick={() => create.mutate()} disabled={!form.name}><Check size={13} /></button>
              <button style={btn()} onClick={() => setShowForm(false)}><X size={13} /></button>
            </div>
          </div>
        </div>
      ) : (
        <button style={btn()} onClick={() => setShowForm(true)}><Plus size={13} />Add Add-On</button>
      )}
    </div>
  );
}

// ── Discounts Section ──────────────────────────────────────────────────────────

function DiscountsSection({ discounts }: { discounts: Discount[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: "", description: "", discount_type: "flat", discount_value: "" });

  const create = useMutation({
    mutationFn: () => apiFetch("/api/pricing/discounts", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-discounts"] }); setShowForm(false); setForm({ code: "", description: "", discount_type: "flat", discount_value: "" }); toast({ title: "Discount code created" }); },
    onError: () => toast({ title: "Failed to create discount code", variant: "destructive" }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => apiFetch(`/api/pricing/discounts/${id}`, { method: "PUT", body: JSON.stringify({ is_active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pricing-discounts"] }),
  });

  const del = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/pricing/discounts/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-discounts"] }); toast({ title: "Deleted" }); },
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={sectionHead}>Discount Codes</div>
          <div style={sectionSub}>Flat or percentage discounts applied at checkout or quoting.</div>
        </div>
        <button style={btn("primary")} onClick={() => setShowForm(v => !v)}><Plus size={14} />New Code</button>
      </div>

      {showForm && (
        <div style={{ ...card, borderColor: "var(--brand)", marginBottom: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 110px 120px auto", gap: 10, alignItems: "end" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>CODE</div>
              <input style={inp} placeholder="MANAGER50" value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value.toUpperCase() }))} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>DESCRIPTION</div>
              <input style={inp} placeholder="Manager Discretion" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>TYPE</div>
              <select style={{ ...inp }} value={form.discount_type} onChange={e => setForm(p => ({ ...p, discount_type: e.target.value }))}>
                <option value="flat">Flat $</option>
                <option value="percent">Percent %</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>VALUE</div>
              <input style={inp} type="number" placeholder={form.discount_type === "flat" ? "50" : "15"} value={form.discount_value} onChange={e => setForm(p => ({ ...p, discount_value: e.target.value }))} />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={btn("primary")} onClick={() => create.mutate()} disabled={!form.code || !form.discount_value}><Check size={13} />Save</button>
              <button style={btn()} onClick={() => setShowForm(false)}><X size={13} /></button>
            </div>
          </div>
        </div>
      )}

      <div style={card}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Code</th>
              <th style={th}>Description</th>
              <th style={th}>Type</th>
              <th style={th}>Value</th>
              <th style={th}>Active</th>
              <th style={{ ...th, width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {discounts.map(d => (
              <tr key={d.id} style={{ opacity: d.is_active ? 1 : 0.45 }}>
                <td style={td}><span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 12, background: "#F7F6F3", padding: "2px 8px", borderRadius: 4 }}>{d.code}</span></td>
                <td style={td}>{d.description}</td>
                <td style={td}><Badge>{d.discount_type === "flat" ? "Flat $" : "Percent %"}</Badge></td>
                <td style={td}>{d.discount_type === "flat" ? `$${parseFloat(d.discount_value).toFixed(0)}` : `${parseFloat(d.discount_value).toFixed(0)}%`}</td>
                <td style={td}>
                  <button style={{ background: "none", border: "none", cursor: "pointer" }} onClick={() => toggle.mutate({ id: d.id, is_active: !d.is_active })}>
                    {d.is_active ? <ToggleRight size={18} color="var(--brand)" /> : <ToggleLeft size={18} color="#9E9B94" />}
                  </button>
                </td>
                <td style={td}><button style={{ background: "none", border: "none", cursor: "pointer" }} onClick={() => del.mutate(d.id)}><Trash2 size={13} color="#DC2626" /></button></td>
              </tr>
            ))}
            {discounts.length === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: "#9E9B94", padding: 24 }}>No discount codes yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Fee Rules Section ──────────────────────────────────────────────────────────

function FeesSection({ fees }: { fees: FeeRule[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ rule_type: "skip_fee", label: "", charge_percent: "100", tech_split_percent: "40", window_hours: "" });

  const create = useMutation({
    mutationFn: () => apiFetch("/api/pricing/fees", { method: "POST", body: JSON.stringify({ ...form, window_hours: form.window_hours ? parseInt(form.window_hours) : null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-fees"] }); setShowForm(false); setForm({ rule_type: "skip_fee", label: "", charge_percent: "100", tech_split_percent: "40", window_hours: "" }); toast({ title: "Fee rule created" }); },
    onError: () => toast({ title: "Failed to create fee rule", variant: "destructive" }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => apiFetch(`/api/pricing/fees/${id}`, { method: "PUT", body: JSON.stringify({ is_active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pricing-fees"] }),
  });

  const del = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/pricing/fees/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-fees"] }); toast({ title: "Deleted" }); },
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={sectionHead}>Fee Rules</div>
          <div style={sectionSub}>Cancellation, skip, and lockout fees with tech compensation splits.</div>
        </div>
        <button style={btn("primary")} onClick={() => setShowForm(v => !v)}><Plus size={14} />New Fee Rule</button>
      </div>

      {showForm && (
        <div style={{ ...card, borderColor: "var(--brand)", marginBottom: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 100px 100px 100px auto", gap: 10, alignItems: "end" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>RULE TYPE</div>
              <select style={{ ...inp }} value={form.rule_type} onChange={e => setForm(p => ({ ...p, rule_type: e.target.value }))}>
                <option value="skip_fee">Skip Fee</option>
                <option value="lockout_fee">Lockout Fee</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>LABEL</div>
              <input style={inp} placeholder="e.g. 48hr Cancel Fee" value={form.label} onChange={e => setForm(p => ({ ...p, label: e.target.value }))} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>CHARGE %</div>
              <input style={inp} type="number" value={form.charge_percent} onChange={e => setForm(p => ({ ...p, charge_percent: e.target.value }))} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>TECH SPLIT %</div>
              <input style={inp} type="number" value={form.tech_split_percent} onChange={e => setForm(p => ({ ...p, tech_split_percent: e.target.value }))} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>WINDOW HRS</div>
              <input style={inp} type="number" placeholder="48" value={form.window_hours} onChange={e => setForm(p => ({ ...p, window_hours: e.target.value }))} />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={btn("primary")} onClick={() => create.mutate()} disabled={!form.label}><Check size={13} />Save</button>
              <button style={btn()} onClick={() => setShowForm(false)}><X size={13} /></button>
            </div>
          </div>
        </div>
      )}

      <div style={card}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Type</th>
              <th style={th}>Label</th>
              <th style={th}>Charge %</th>
              <th style={th}>Tech Split %</th>
              <th style={th}>Window</th>
              <th style={th}>Active</th>
              <th style={{ ...th, width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {fees.map(f => (
              <tr key={f.id} style={{ opacity: f.is_active ? 1 : 0.45 }}>
                <td style={td}><Badge>{f.rule_type.replace("_", " ")}</Badge></td>
                <td style={td}>{f.label}</td>
                <td style={td}>{parseFloat(f.charge_percent).toFixed(0)}%</td>
                <td style={td}>{parseFloat(f.tech_split_percent).toFixed(0)}%</td>
                <td style={td}>{f.window_hours != null ? `${f.window_hours}h` : "—"}</td>
                <td style={td}>
                  <button style={{ background: "none", border: "none", cursor: "pointer" }} onClick={() => toggle.mutate({ id: f.id, is_active: !f.is_active })}>
                    {f.is_active ? <ToggleRight size={18} color="var(--brand)" /> : <ToggleLeft size={18} color="#9E9B94" />}
                  </button>
                </td>
                <td style={td}><button style={{ background: "none", border: "none", cursor: "pointer" }} onClick={() => del.mutate(f.id)}><Trash2 size={13} color="#DC2626" /></button></td>
              </tr>
            ))}
            {fees.length === 0 && <tr><td colSpan={7} style={{ ...td, textAlign: "center", color: "#9E9B94", padding: 24 }}>No fee rules yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Bundles & Promotions Section ───────────────────────────────────────────────

interface Bundle {
  id: number;
  name: string;
  description: string | null;
  discount_type: string;
  discount_value: string;
  active: boolean;
  valid_from: string | null;
  valid_until: string | null;
  items: Array<{ id: number; addon_id: number; addon_name: string; price_type: string }>;
}

interface FlatAddon {
  id: number;
  name: string;
  price_type: string;
  price_value: string;
}

const emptyBundleForm = () => ({
  name: "",
  description: "",
  discount_type: "flat_per_item",
  discount_value: "",
  valid_from: "",
  valid_until: "",
  active: true,
  addon_ids: [] as number[],
});

function BundlesSection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editBundle, setEditBundle] = useState<Bundle | null>(null);
  const [form, setForm] = useState(emptyBundleForm());

  const { data: bundles = [] } = useQuery<Bundle[]>({
    queryKey: ["bundles"],
    queryFn: () => apiFetch("/api/bundles"),
  });

  const { data: flatAddons = [] } = useQuery<FlatAddon[]>({
    queryKey: ["bundle-flat-addons"],
    queryFn: () => apiFetch("/api/bundles/flat-addons"),
  });

  const createBundle = useMutation({
    mutationFn: (body: typeof form) => apiFetch("/api/bundles", { method: "POST", body: JSON.stringify({ ...body, discount_value: parseFloat(body.discount_value) || 0 }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bundles"] }); setShowModal(false); setForm(emptyBundleForm()); toast({ title: "Bundle created" }); },
    onError: () => toast({ title: "Failed to create bundle", variant: "destructive" }),
  });

  const updateBundle = useMutation({
    mutationFn: ({ id, body }: { id: number; body: typeof form }) => apiFetch(`/api/bundles/${id}`, { method: "PUT", body: JSON.stringify({ ...body, discount_value: parseFloat(body.discount_value) || 0 }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bundles"] }); setShowModal(false); setEditBundle(null); setForm(emptyBundleForm()); toast({ title: "Bundle updated" }); },
    onError: () => toast({ title: "Failed to update bundle", variant: "destructive" }),
  });

  const toggleBundle = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/bundles/${id}/toggle`, { method: "PUT" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bundles"] }),
  });

  const deleteBundle = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/bundles/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bundles"] }); toast({ title: "Bundle deleted" }); },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  function openNew() {
    setEditBundle(null);
    setForm(emptyBundleForm());
    setShowModal(true);
  }

  function openEdit(b: Bundle) {
    setEditBundle(b);
    setForm({
      name: b.name,
      description: b.description || "",
      discount_type: b.discount_type,
      discount_value: parseFloat(b.discount_value).toString(),
      valid_from: b.valid_from || "",
      valid_until: b.valid_until || "",
      active: b.active,
      addon_ids: b.items.map(it => it.addon_id),
    });
    setShowModal(true);
  }

  function handleSave() {
    if (!form.name.trim() || !form.discount_value || form.addon_ids.length < 2) {
      toast({ title: "Bundle requires a name, discount amount, and at least 2 add-ons", variant: "destructive" });
      return;
    }
    if (editBundle) updateBundle.mutate({ id: editBundle.id, body: form });
    else createBundle.mutate(form);
  }

  const discountLabel = (b: Bundle) => {
    const v = parseFloat(b.discount_value).toFixed(2).replace(/\.00$/, "");
    if (b.discount_type === "flat_per_item") return `$${v} off each`;
    if (b.discount_type === "flat_total") return `$${v} off total`;
    return `${v}% off each`;
  };

  const dateRangeLabel = (b: Bundle) => {
    if (!b.valid_from && !b.valid_until) return "Always active";
    const fmt = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (b.valid_from && b.valid_until) return `${fmt(b.valid_from)} – ${fmt(b.valid_until)}`;
    if (b.valid_from) return `From ${fmt(b.valid_from)}`;
    return `Until ${fmt(b.valid_until!)}`;
  };

  const discountTypeLabel = (dt: string) => {
    if (dt === "flat_per_item") return "$ Off Each Item";
    if (dt === "flat_total") return "$ Off Total";
    return "% Off Each Item";
  };

  const discountValueLabel = (dt: string) => {
    if (dt === "flat_per_item") return "$ per item";
    if (dt === "flat_total") return "$ total";
    return "% per item";
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={sectionHead}>Bundles &amp; Promotions</div>
          <div style={sectionSub}>Group add-ons together with automatic discounts. Customers see savings in real time when selecting bundled items.</div>
        </div>
        <button style={btn("primary")} onClick={openNew}><Plus size={14} />Add Bundle</button>
      </div>

      <div style={card}>
        {bundles.length === 0 ? (
          <div style={{ textAlign: "center", padding: 32, color: "#9E9B94", fontSize: 13 }}>
            No bundles yet. Create your first bundle to start offering automatic discounts.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {bundles.map((b, i) => (
              <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: i < bundles.length - 1 ? "1px solid #E5E2DC" : "none", opacity: b.active ? 1 : 0.5 }}>
                <div style={{ width: 34, height: 34, borderRadius: 8, background: b.active ? "#D1FAE5" : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Tag size={16} color={b.active ? "#2D6A4F" : "#9E9B94"} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "#1A1917" }}>{b.name}</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                    {b.items.map(it => (
                      <span key={it.id} style={{ fontSize: 11, background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 12, padding: "1px 8px", color: "#6B6860" }}>{it.addon_name}</span>
                    ))}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#6B6860", flexShrink: 0, minWidth: 90, textAlign: "right" }}>
                  <div style={{ fontWeight: 600, color: "#1A1917" }}>{discountLabel(b)}</div>
                  <div style={{ fontSize: 11, marginTop: 2 }}>{dateRangeLabel(b)}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <button style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => toggleBundle.mutate(b.id)}>
                    {b.active ? <ToggleRight size={20} color="var(--brand)" /> : <ToggleLeft size={20} color="#9E9B94" />}
                  </button>
                  <button style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => openEdit(b)}>
                    <Edit2 size={14} color="#6B6860" />
                  </button>
                  <button style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => { if (confirm(`Delete "${b.name}"?`)) deleteBundle.mutate(b.id); }}>
                    <Trash2 size={14} color="#DC2626" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 28, width: 520, maxWidth: "calc(100vw - 32px)", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.18)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <p style={{ margin: 0, fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: 15, color: "#1A1917" }}>
                {editBundle ? "Edit Bundle" : "Add Bundle"}
              </p>
              <button style={{ background: "none", border: "none", cursor: "pointer" }} onClick={() => { setShowModal(false); setEditBundle(null); }}>
                <X size={18} color="#9E9B94" />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>BUNDLE NAME</div>
                <input style={inp} placeholder="e.g. Appliance Bundle" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>DESCRIPTION (optional)</div>
                <textarea style={{ ...inp, resize: "vertical" as const, minHeight: 60 }} placeholder="Shown to customers on hover" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 6 }}>ADD-ONS INCLUDED (select at least 2)</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "#F7F6F3", borderRadius: 8, padding: 12 }}>
                  {flatAddons.map(a => (
                    <label key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "#1A1917" }}>
                      <input
                        type="checkbox"
                        checked={form.addon_ids.includes(a.id)}
                        onChange={e => setForm(p => ({ ...p, addon_ids: e.target.checked ? [...p.addon_ids, a.id] : p.addon_ids.filter(x => x !== a.id) }))}
                      />
                      {a.name} <span style={{ color: "#9E9B94", fontSize: 11 }}>(${parseFloat(a.price_value).toFixed(2)})</span>
                    </label>
                  ))}
                  {flatAddons.length === 0 && <span style={{ fontSize: 12, color: "#9E9B94" }}>No flat-priced add-ons found.</span>}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 6 }}>DISCOUNT TYPE</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["flat_per_item", "flat_total", "percentage"] as const).map(dt => (
                    <button
                      key={dt}
                      style={{ ...btn(form.discount_type === dt ? "primary" : "secondary"), padding: "7px 12px", fontSize: 12 }}
                      onClick={() => setForm(p => ({ ...p, discount_type: dt }))}
                    >
                      {discountTypeLabel(dt)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>DISCOUNT AMOUNT ({discountValueLabel(form.discount_type)})</div>
                <input style={inp} type="number" min="0" step="0.01" placeholder={form.discount_type === "percentage" ? "10" : "10.00"} value={form.discount_value} onChange={e => setForm(p => ({ ...p, discount_value: e.target.value }))} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>START DATE (optional)</div>
                  <input style={inp} type="date" value={form.valid_from} onChange={e => setForm(p => ({ ...p, valid_from: e.target.value }))} />
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>END DATE (optional)</div>
                  <input style={inp} type="date" value={form.valid_until} onChange={e => setForm(p => ({ ...p, valid_until: e.target.value }))} />
                </div>
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1A1917", cursor: "pointer" }}>
                <input type="checkbox" checked={form.active} onChange={e => setForm(p => ({ ...p, active: e.target.checked }))} />
                Active (bundle will be shown to customers)
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button style={{ ...btn("secondary"), padding: "10px 20px" }} onClick={() => { setShowModal(false); setEditBundle(null); }}>Cancel</button>
              <button style={{ ...btn("primary"), padding: "10px 20px" }} onClick={handleSave} disabled={createBundle.isPending || updateBundle.isPending}>
                <Check size={14} />{editBundle ? "Save Changes" : "Create Bundle"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Offers & Incentives Section ─────────────────────────────────────────────
const FF = "'Plus Jakarta Sans', sans-serif";

function ToggleSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center" }}
    >
      {value ? <ToggleRight size={28} color="var(--brand)" /> : <ToggleLeft size={28} color="#9E9B94" />}
    </button>
  );
}

function OffersSection() {
  const { toast } = useToast();
  const { data: settings, isLoading } = useQuery<any>({
    queryKey: ["offer-settings"],
    queryFn: () => apiFetch("/api/pricing/offer-settings"),
  });
  const [form, setForm] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings && !form) setForm({ ...settings });
  }, [settings]);

  const upd = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const inp: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, color: "#1A1917", fontFamily: FF, outline: "none", boxSizing: "border-box" as const };
  const fieldLbl = (t: string, help?: string) => (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{t}</div>
      {help && <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginTop: 2 }}>{help}</div>}
    </div>
  );

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await apiFetch("/api/pricing/offer-settings", { method: "PUT", body: JSON.stringify(form) });
      toast({ title: "Offer settings saved" });
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally { setSaving(false); }
  };

  if (isLoading || !form) return null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={sectionHead}>Offers &amp; Incentives</div>
          <div style={sectionSub}>Configure the recurring upsell offer shown on Deep Clean bookings and the rate lock guarantee terms.</div>
        </div>
      </div>

      <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, padding: "0", overflow: "hidden" }}>
        {/* Field 1 — Upsell toggle */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #E5E2DC" }}>
          <div style={{ flex: 1 }}>
            {fieldLbl("Show recurring upsell offer on Deep Clean bookings", "When off, the upsell card is hidden entirely from the booking widget.")}
          </div>
          <ToggleSwitch value={!!form.upsell_enabled} onChange={v => upd("upsell_enabled", v)} />
        </div>

        {/* Field 2 — Discount % */}
        <div style={{ display: "flex", alignItems: "center", gap: 24, padding: "16px 20px", borderBottom: "1px solid #E5E2DC" }}>
          <div style={{ flex: 1 }}>{fieldLbl("First recurring cleaning discount", "Applied to the first recurring cleaning when a customer accepts the upsell. Shown live in the booking widget.")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, width: 120 }}>
            <input type="number" min={0} max={50} value={form.upsell_discount_percent ?? 15} onChange={e => upd("upsell_discount_percent", parseFloat(e.target.value))} style={{ ...inp, width: 80, textAlign: "right" as const }} />
            <span style={{ fontSize: 13, color: "#6B6860", fontFamily: FF }}>%</span>
          </div>
        </div>

        {/* Field 3 — Rate lock toggle */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #E5E2DC" }}>
          <div style={{ flex: 1 }}>{fieldLbl("Offer rate lock guarantee", "When off, rate lock language is hidden from the upsell card and no lock record is created.")}</div>
          <ToggleSwitch value={!!form.rate_lock_enabled} onChange={v => upd("rate_lock_enabled", v)} />
        </div>

        {/* Field 4 — Rate lock duration */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #E5E2DC" }}>
          {fieldLbl("Rate lock duration", "How long the recurring rate is guaranteed after upsell acceptance.")}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {[12, 18, 24].map(m => (
              <button
                key={m}
                onClick={() => upd("rate_lock_duration_months", m)}
                style={{ flex: 1, padding: "8px 0", borderRadius: 7, border: `2px solid ${form.rate_lock_duration_months === m ? "var(--brand)" : "#E5E2DC"}`, background: form.rate_lock_duration_months === m ? "var(--brand-light, #EFF6FF)" : "#FFFFFF", color: form.rate_lock_duration_months === m ? "var(--brand)" : "#6B6860", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}
              >
                {m} months
              </button>
            ))}
          </div>
        </div>

        {/* Field 5 — Overrun threshold */}
        <div style={{ display: "flex", alignItems: "center", gap: 24, padding: "16px 20px", borderBottom: "1px solid #E5E2DC" }}>
          <div style={{ flex: 1 }}>{fieldLbl("Time overrun threshold", "If actual cleaning time exceeds the estimate by this percentage on enough visits, the rate lock is automatically voided.")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, width: 120 }}>
            <input type="number" min={1} max={100} value={form.overrun_threshold_percent ?? 20} onChange={e => upd("overrun_threshold_percent", parseFloat(e.target.value))} style={{ ...inp, width: 80, textAlign: "right" as const }} />
            <span style={{ fontSize: 13, color: "#6B6860", fontFamily: FF }}>%</span>
          </div>
        </div>

        {/* Field 6 — Overrun trigger count */}
        <div style={{ display: "flex", alignItems: "center", gap: 24, padding: "16px 20px", borderBottom: "1px solid #E5E2DC" }}>
          <div style={{ flex: 1 }}>{fieldLbl("Overrun trigger — number of visits", "How many visits must exceed the threshold before the rate lock voids.")}</div>
          <input type="number" min={1} max={10} value={form.overrun_jobs_trigger ?? 2} onChange={e => upd("overrun_jobs_trigger", parseInt(e.target.value))} style={{ ...inp, width: 80, textAlign: "right" as const }} />
        </div>

        {/* Field 7 — Service gap */}
        <div style={{ display: "flex", alignItems: "center", gap: 24, padding: "16px 20px" }}>
          <div style={{ flex: 1 }}>{fieldLbl("Service gap void window", "If a client goes this many days without a completed cleaning, their rate lock is automatically voided.")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, width: 120 }}>
            <input type="number" min={1} value={form.service_gap_days ?? 60} onChange={e => upd("service_gap_days", parseInt(e.target.value))} style={{ ...inp, width: 80, textAlign: "right" as const }} />
            <span style={{ fontSize: 13, color: "#6B6860", fontFamily: FF }}>days</span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
        <button style={btn("primary")} onClick={save} disabled={saving}>
          <Save size={14} />{saving ? "Saving..." : "Save Offer Settings"}
        </button>
      </div>
    </div>
  );
}
