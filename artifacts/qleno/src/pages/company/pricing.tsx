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

const btn = (variant: "primary" | "secondary" | "ghost" | "danger" | "outline" = "secondary"): React.CSSProperties => {
  // [pricing-restyle] Tab-scoped colors. Primary uses mint #2D9B83 directly
  // (not var(--brand)) because the global brand token is the legacy blue and
  // changing it would restyle every primary button across the app. Danger
  // and outline read as outline buttons — subtle border, transparent fill —
  // matching the row-action treatment used in other modern Phes screens.
  const base: React.CSSProperties = {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 7,
    padding: "7px 14px",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    transition: "background 0.15s, border-color 0.15s, color 0.15s",
    border: "1px solid transparent",
  };
  if (variant === "primary") return { ...base, background: "#2D9B83", color: "#FFFFFF", borderColor: "#2D9B83" };
  if (variant === "danger") return { ...base, background: "transparent", color: "#DC2626", borderColor: "#FCA5A5" };
  if (variant === "outline") return { ...base, background: "transparent", color: "#1A1917", borderColor: "#E5E2DC" };
  if (variant === "ghost") return { ...base, background: "transparent", color: "#1A1917", borderColor: "transparent" };
  return { ...base, background: "#F7F6F3", color: "#1A1917", borderColor: "#F7F6F3" };
};

// [pricing-restyle] One-time hover stylesheet keyed off inline-style color
// hex so we don't have to thread classNames through every button site.
// `[style*="2D9B83"]` matches buttons where the inline style attribute
// contains that hex — primary buttons via btn("primary"). Same pattern for
// outline and danger.
function ensurePricingButtonStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById("qleno-pricing-btn-styles")) return;
  const s = document.createElement("style");
  s.id = "qleno-pricing-btn-styles";
  s.textContent = `
    button[style*="2D9B83"]:hover:not(:disabled) { background: #258774 !important; border-color: #258774 !important; }
    button[style*="FCA5A5"]:hover:not(:disabled) { background: #FEF2F2 !important; }
    button[style*="E5E2DC"]:hover:not(:disabled) { background: #F7F6F3 !important; }
  `;
  document.head.appendChild(s);
}

function Badge({ children, color = "#6B6860" }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 11, fontWeight: 600, background: "#F7F6F3", color, border: "1px solid #E5E2DC", borderRadius: 5, padding: "2px 8px" }}>
      {children}
    </span>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface Scope { id: number; name: string; scope_group: string; pricing_method: string; hourly_rate: string; minimum_bill: string; is_active: boolean; displayed_for_office: boolean; sort_order: number; }
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
  const [newScope, setNewScope] = useState({ name: "", scope_group: "Residential", pricing_method: "sqft", hourly_rate: "", minimum_bill: "" });
  const [recurringExpanded, setRecurringExpanded] = useState(false);
  const [activeRecurringScope, setActiveRecurringScope] = useState<number>(0);
  const [recurringSubTab, setRecurringSubTab] = useState<"tiers" | "frequencies" | "addons">("tiers");
  const [editingScope, setEditingScope] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", scope_group: "", pricing_method: "", hourly_rate: "", minimum_bill: "" });

  useEffect(() => { ensurePricingButtonStyles(); }, []);

  const { data: scopes = [] } = useQuery<Scope[]>({ queryKey: ["pricing-scopes"], queryFn: () => apiFetch("/api/pricing/scopes") });
  const RECURRING_IDS = scopes.filter(s => s.scope_group === 'Recurring Cleaning').map(s => s.id);

  useEffect(() => {
    if (RECURRING_IDS.length > 0 && !RECURRING_IDS.includes(activeRecurringScope)) {
      setActiveRecurringScope(RECURRING_IDS[0]);
    }
  }, [RECURRING_IDS.join(",")]);

  const { data: discounts = [] } = useQuery<Discount[]>({ queryKey: ["pricing-discounts"], queryFn: () => apiFetch("/api/pricing/discounts") });
  const { data: fees = [] } = useQuery<FeeRule[]>({ queryKey: ["pricing-fees"], queryFn: () => apiFetch("/api/pricing/fees") });

  const createScope = useMutation({
    mutationFn: (body: typeof newScope) => apiFetch("/api/pricing/scopes", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-scopes"] }); setShowNewScope(false); setNewScope({ name: "", scope_group: "Residential", pricing_method: "sqft", hourly_rate: "", minimum_bill: "" }); toast({ title: "Scope created" }); },
    onError: () => toast({ title: "Failed to create scope", variant: "destructive" }),
  });

  const toggleActive = useMutation({
    mutationFn: (s: Scope) => apiFetch(`/api/pricing/scopes/${s.id}`, { method: "PUT", body: JSON.stringify({ is_active: !s.is_active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pricing-scopes"] }),
  });

  const toggleOffice = useMutation({
    mutationFn: (s: Scope) => apiFetch(`/api/pricing/scopes/${s.id}`, { method: "PUT", body: JSON.stringify({ displayed_for_office: !s.displayed_for_office }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pricing-scopes"] }),
  });

  const saveScope = useMutation({
    mutationFn: ({ id, body }: { id: number; body: typeof editForm }) => apiFetch(`/api/pricing/scopes/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-scopes"] }); setEditingScope(null); toast({ title: "Scope saved" }); },
    onError: () => toast({ title: "Failed to save scope", variant: "destructive" }),
  });

  const deleteScope = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/pricing/scopes/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["pricing-scopes"] }); if (expandedScope) setExpandedScope(null); },
  });

  function startEdit(scope: Scope) {
    setEditingScope(scope.id);
    setEditForm({ name: scope.name, scope_group: scope.scope_group, pricing_method: scope.pricing_method, hourly_rate: String(scope.hourly_rate), minimum_bill: String(scope.minimum_bill) });
    setExpandedScope(null);
  }

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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 140px 120px 120px auto", gap: 10, alignItems: "end" }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>SCOPE NAME</div>
                <input style={inp} placeholder="e.g. Deep Clean or Move In/Out" value={newScope.name} onChange={e => setNewScope(p => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>GROUP</div>
                <select style={{ ...inp }} value={newScope.scope_group} onChange={e => setNewScope(p => ({ ...p, scope_group: e.target.value }))}>
                  <option>Residential</option>
                  <option>Commercial</option>
                  <option>Recurring Cleaning</option>
                  <option>Hourly</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>PRICING METHOD</div>
                <select style={{ ...inp }} value={newScope.pricing_method} onChange={e => setNewScope(p => ({ ...p, pricing_method: e.target.value }))}>
                  <option value="sqft">By Sq Ft</option>
                  <option value="hourly">Hourly</option>
                  <option value="simplified">Simplified</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4 }}>RATE ($/hr)</div>
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
          {/* Regular active scopes (excluding recurring group 4/9/10 and inactive) */}
          {scopes.filter(s => !RECURRING_IDS.includes(s.id)).map(scope => (
            <div key={scope.id} style={{ border: `1px solid ${!scope.is_active ? "#E5E2DC" : scope.displayed_for_office ? "#E5E2DC" : "#E5E2DC"}`, borderRadius: 10, background: "#fff", overflow: "hidden", opacity: scope.is_active ? 1 : 0.5 }}>

              {/* ── Edit mode row ── */}
              {editingScope === scope.id ? (
                <div style={{ padding: "12px 16px", borderBottom: expandedScope === scope.id ? "1px solid #E5E2DC" : "none" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 140px 100px 100px auto", gap: 8, alignItems: "end" }}>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", marginBottom: 3 }}>NAME</div>
                      <input style={inp} value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", marginBottom: 3 }}>GROUP</div>
                      <select style={{ ...inp }} value={editForm.scope_group} onChange={e => setEditForm(p => ({ ...p, scope_group: e.target.value }))}>
                        <option>Residential</option>
                        <option>Commercial</option>
                        <option>Recurring Cleaning</option>
                        <option>Hourly</option>
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", marginBottom: 3 }}>METHOD</div>
                      <select style={{ ...inp }} value={editForm.pricing_method} onChange={e => setEditForm(p => ({ ...p, pricing_method: e.target.value }))}>
                        <option value="sqft">By Sq Ft</option>
                        <option value="hourly">Hourly</option>
                        <option value="simplified">Simplified</option>
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", marginBottom: 3 }}>RATE ($/hr)</div>
                      <input style={inp} type="number" value={editForm.hourly_rate} onChange={e => setEditForm(p => ({ ...p, hourly_rate: e.target.value }))} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", marginBottom: 3 }}>MIN ($)</div>
                      <input style={inp} type="number" value={editForm.minimum_bill} onChange={e => setEditForm(p => ({ ...p, minimum_bill: e.target.value }))} />
                    </div>
                    <div style={{ display: "flex", gap: 4, paddingTop: 16 }}>
                      <button style={btn("primary")} onClick={() => saveScope.mutate({ id: scope.id, body: editForm })} disabled={saveScope.isPending}><Check size={13} /></button>
                      <button style={btn()} onClick={() => setEditingScope(null)}><X size={13} /></button>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: "pointer", userSelect: "none" }}
                  onClick={() => { if (scope.is_active) { setExpandedScope(expandedScope === scope.id ? null : scope.id); setScopeSubTab("tiers"); } }}
                >
                  {expandedScope === scope.id ? <ChevronDown size={15} color="#9E9B94" /> : <ChevronRight size={15} color="#9E9B94" />}
                  <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 13, color: "#1A1917", flex: 1 }}>{scope.name}</span>
                  <Badge>{scope.scope_group}</Badge>
                  <span style={{ fontSize: 11, color: "#9E9B94", minWidth: 66, textAlign: "right" }}>${parseFloat(scope.hourly_rate).toFixed(0)}/hr</span>
                  <span style={{ fontSize: 11, color: "#9E9B94", minWidth: 72, textAlign: "right" }}>Min ${parseFloat(scope.minimum_bill).toFixed(0)}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 2 }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: scope.displayed_for_office ? "var(--brand)" : "#9E9B94", letterSpacing: "0.02em" }}>OFFICE</span>
                      <button style={{ background: "none", border: "none", cursor: "pointer", padding: "1px 2px", lineHeight: 1 }} onClick={() => toggleOffice.mutate(scope)} title={scope.displayed_for_office ? "Hide from Quote Builder" : "Show in Quote Builder"}>
                        {scope.displayed_for_office ? <ToggleRight size={19} color="var(--brand)" /> : <ToggleLeft size={19} color="#C9C5BE" />}
                      </button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, marginLeft: 6 }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: scope.is_active ? "#059669" : "#9E9B94", letterSpacing: "0.02em" }}>ACTIVE</span>
                      <button style={{ background: "none", border: "none", cursor: "pointer", padding: "1px 2px", lineHeight: 1 }} onClick={() => toggleActive.mutate(scope)} title={scope.is_active ? "Deactivate" : "Activate"}>
                        {scope.is_active ? <ToggleRight size={19} color="#059669" /> : <ToggleLeft size={19} color="#C9C5BE" />}
                      </button>
                    </div>
                  </div>
                  <button style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }} onClick={e => { e.stopPropagation(); startEdit(scope); }} title="Edit formula">
                    <Edit2 size={13} color="#6B6860" />
                  </button>
                  <button style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }} onClick={e => { e.stopPropagation(); if (confirm(`Delete "${scope.name}"?`)) deleteScope.mutate(scope.id); }}>
                    <Trash2 size={13} color="#DC2626" />
                  </button>
                </div>
              )}

              {expandedScope === scope.id && scope.is_active && editingScope !== scope.id && (
                <div style={{ borderTop: "1px solid #E5E2DC" }}>
                  <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #E5E2DC", padding: "0 18px" }}>
                    {(["tiers", "frequencies", "addons"] as const).map(t => (
                      <button key={t} onClick={() => setScopeSubTab(t)} style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 12, fontWeight: scopeSubTab === t ? 600 : 400, color: scopeSubTab === t ? "var(--brand)" : "#6B6860", borderBottom: `2px solid ${scopeSubTab === t ? "var(--brand)" : "transparent"}`, border: "none", background: "transparent", padding: "10px 14px", marginBottom: -1, cursor: "pointer" }}>
                        {t === "tiers" ? "Pricing Tiers" : t === "frequencies" ? "Frequencies" : "Add-Ons"}
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

          {/* Recurring Cleaning — combined accordion, grouped by scope_group='Recurring Cleaning' */}
          {scopes.some(s => RECURRING_IDS.includes(s.id) && s.is_active) && (() => {
            const recurringScopes = scopes
              .filter(s => RECURRING_IDS.includes(s.id) && s.is_active)
              .sort((a, b) => a.id - b.id)
              .map(s => ({
                id: s.id,
                label: s.name.replace(/^Recurring Cleaning\s*[-–]\s*/i, "").trim() || s.name,
                hourly_rate: s.hourly_rate,
                minimum_bill: s.minimum_bill,
              }));
            const recScope = scopes.find(s => s.id === activeRecurringScope) ?? scopes.find(s => RECURRING_IDS.includes(s.id) && s.is_active);
            return (
              <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, background: "#fff", overflow: "hidden" }}>
                <div
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", cursor: "pointer", userSelect: "none" }}
                  onClick={() => setRecurringExpanded(v => !v)}
                >
                  {recurringExpanded ? <ChevronDown size={15} color="#9E9B94" /> : <ChevronRight size={15} color="#9E9B94" />}
                  <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 14, color: "#1A1917", flex: 1 }}>Recurring Cleaning</span>
                  <Badge color="#2D6A4F">Recurring Cleaning</Badge>
                  <span style={{ fontSize: 12, color: "#9E9B94" }}>{recurringScopes.length} frequencies</span>
                </div>
                {recurringExpanded && (
                  <div style={{ borderTop: "1px solid #E5E2DC" }}>
                    {/* Frequency tabs */}
                    <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #E5E2DC", padding: "0 18px", background: "#FAFAF8" }}>
                      {recurringScopes.map(r => (
                        <button key={r.id} onClick={() => { setActiveRecurringScope(r.id); setRecurringSubTab("tiers"); }}
                          style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 13, fontWeight: activeRecurringScope === r.id ? 700 : 400, color: activeRecurringScope === r.id ? "var(--brand)" : "#6B6860", borderBottom: `2px solid ${activeRecurringScope === r.id ? "var(--brand)" : "transparent"}`, border: "none", background: "transparent", padding: "11px 16px", marginBottom: -1, cursor: "pointer" }}>
                          {r.label}
                        </button>
                      ))}
                    </div>
                    {recScope && (
                      <div>
                        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #F0EDE8", padding: "0 18px" }}>
                          {(["tiers", "frequencies", "addons"] as const).map(t => (
                            <button key={t} onClick={() => setRecurringSubTab(t)}
                              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 12, fontWeight: recurringSubTab === t ? 600 : 400, color: recurringSubTab === t ? "var(--brand)" : "#9E9B94", borderBottom: `2px solid ${recurringSubTab === t ? "var(--brand)" : "transparent"}`, border: "none", background: "transparent", padding: "8px 12px", marginBottom: -1, cursor: "pointer" }}>
                              {t === "tiers" ? "Pricing Tiers" : t === "frequencies" ? "Frequencies" : "Add-Ons"}
                            </button>
                          ))}
                        </div>
                        <div style={{ padding: "16px 18px" }}>
                          {recurringSubTab === "tiers" && <TiersEditor scopeId={activeRecurringScope} />}
                          {recurringSubTab === "frequencies" && <FrequenciesEditor scopeId={activeRecurringScope} />}
                          {recurringSubTab === "addons" && <AddonsEditor scopeId={activeRecurringScope} />}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {scopes.length === 0 && <div style={{ textAlign: "center", padding: 32, color: "#9E9B94", fontSize: 13 }}>No scopes yet. Create your first scope above.</div>}
        </div>
      </div>

      {/* ── Discount Codes ──────────────────────────────────────────────── */}
      <DiscountsSection discounts={discounts} />

      {/* ── Fee Rules ───────────────────────────────────────────────────── */}
      <FeesSection fees={fees} />

      {/* ── Cancellation Policy (action-picker defaults + tech pay) ─────── */}
      <CancellationPolicySection />

      {/* ── Bundles & Promotions ────────────────────────────────────────── */}
      <BundlesSection />

      {/* ── Commercial Service Types ────────────────────────────────────── */}
      <CommercialServiceTypesSection />

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

// ── Cancellation Policy Section ────────────────────────────────────────────────
//
// Tenant-wide defaults consumed by the dispatch cancel modal (PR #216):
//   - default_cancel_fee_pct  — % charged when a customer cancels late
//   - default_lockout_fee_pct — % charged when the crew can't get in
//   - cancellation_tech_pay_mode ('flat' | 'percent')
//   - cancellation_tech_pay_amount — $ when flat, % when percent
//
// Per-client overrides on cancel/lockout % live on the customer profile
// (clients.cancel_fee_pct / .lockout_fee_pct). When set there, those win.

interface CancellationPolicy {
  default_cancel_fee_pct: number;
  default_lockout_fee_pct: number;
  default_cancel_fee_flat: number;
  default_lockout_fee_flat: number;
  cancellation_tech_pay_mode: "flat" | "percent";
  cancellation_tech_pay_amount: number;
}

function CancellationPolicySection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<CancellationPolicy>({
    queryKey: ["cancellation-policy"],
    queryFn: () => apiFetch("/api/companies/cancellation-policy"),
  });

  // Local edit buffer so the input never feels laggy (default values seed
  // from server on first load, then user edits drive state).
  const [form, setForm] = useState<CancellationPolicy | null>(null);
  useEffect(() => { if (data && !form) setForm(data); }, [data]);

  const save = useMutation({
    mutationFn: (body: CancellationPolicy) => apiFetch("/api/companies/cancellation-policy", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cancellation-policy"] });
      toast({ title: "Cancellation policy saved" });
    },
    onError: () => toast({ title: "Failed to save policy", variant: "destructive" }),
  });

  if (isLoading || !form) {
    return (
      <div style={card}>
        <div style={sectionHead}>Cancellation Policy</div>
        <div style={{ ...sectionSub, marginBottom: 0 }}>Loading…</div>
      </div>
    );
  }

  // Preview the dollar implication of the current tech-pay setting against
  // a representative $200 visit fee. Helps the operator gut-check %-mode.
  const previewJob = 200;
  const techPreview = form.cancellation_tech_pay_mode === "percent"
    ? Math.round(previewJob * (form.cancellation_tech_pay_amount / 100) * 100) / 100
    : form.cancellation_tech_pay_amount;

  const dirty = !!data && JSON.stringify(form) !== JSON.stringify(data);

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={sectionHead}>Cancellation Policy</div>
          <div style={sectionSub}>
            Defaults the dispatch Cancel button applies for this tenant. Per-customer
            overrides live on the client profile.
          </div>
        </div>
        <button
          style={btn("primary")}
          onClick={() => save.mutate(form)}
          disabled={!dirty || save.isPending}
        >
          <Save size={13} />Save
        </button>
      </div>

      {/* Customer-side fee defaults */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Late Cancel Fee
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              style={{ ...inp, maxWidth: 100 }}
              type="number"
              min={0}
              max={100}
              step={1}
              value={form.default_cancel_fee_pct}
              onChange={e => setForm(p => p && ({ ...p, default_cancel_fee_pct: Number(e.target.value) }))}
            />
            <span style={{ fontSize: 13, color: "#6B6860" }}>% of visit fee</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 13, color: "#6B6860" }}>or $</span>
            <input
              style={{ ...inp, maxWidth: 100 }}
              type="number"
              min={0}
              step={1}
              value={form.default_cancel_fee_flat}
              onChange={e => setForm(p => p && ({ ...p, default_cancel_fee_flat: Number(e.target.value) }))}
            />
            <span style={{ fontSize: 13, color: "#6B6860" }}>flat</span>
          </div>
          <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 6 }}>
            Charged when a customer cancels late. Phes default: 100%. Set a flat $ fee above 0 to charge that instead of the %.
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Lockout Fee
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              style={{ ...inp, maxWidth: 100 }}
              type="number"
              min={0}
              max={100}
              step={1}
              value={form.default_lockout_fee_pct}
              onChange={e => setForm(p => p && ({ ...p, default_lockout_fee_pct: Number(e.target.value) }))}
            />
            <span style={{ fontSize: 13, color: "#6B6860" }}>% of visit fee</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 13, color: "#6B6860" }}>or $</span>
            <input
              style={{ ...inp, maxWidth: 100 }}
              type="number"
              min={0}
              step={1}
              value={form.default_lockout_fee_flat}
              onChange={e => setForm(p => p && ({ ...p, default_lockout_fee_flat: Number(e.target.value) }))}
            />
            <span style={{ fontSize: 13, color: "#6B6860" }}>flat</span>
          </div>
          <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 6 }}>
            Charged when the crew can't get in. Phes default: 100%. Set a flat $ fee above 0 to charge that instead of the %.
          </div>
        </div>
      </div>

      {/* Tech-pay side */}
      <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", marginBottom: 4 }}>
          Tech pay on cancel / lockout
        </div>
        <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 12 }}>
          What each assigned tech earns for a charged cancellation — they were on the
          schedule. Split equally across assigned techs.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 1fr", gap: 16, alignItems: "end" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Pay Mode
            </div>
            <select
              style={inp}
              value={form.cancellation_tech_pay_mode}
              onChange={e => setForm(p => p && ({ ...p, cancellation_tech_pay_mode: e.target.value as "flat" | "percent" }))}
            >
              <option value="flat">Flat dollars</option>
              <option value="percent">% of customer charge</option>
            </select>
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {form.cancellation_tech_pay_mode === "flat" ? "Amount ($)" : "Percent (%)"}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: "#6B6860", minWidth: 10 }}>
                {form.cancellation_tech_pay_mode === "flat" ? "$" : ""}
              </span>
              <input
                style={{ ...inp, maxWidth: 140 }}
                type="number"
                min={0}
                step={form.cancellation_tech_pay_mode === "flat" ? 1 : 0.5}
                value={form.cancellation_tech_pay_amount}
                onChange={e => setForm(p => p && ({ ...p, cancellation_tech_pay_amount: Number(e.target.value) }))}
              />
              <span style={{ fontSize: 13, color: "#6B6860" }}>
                {form.cancellation_tech_pay_mode === "flat" ? "per cancel" : "%"}
              </span>
            </div>
          </div>

          <div style={{ fontSize: 12, color: "#6B6860" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Preview
            </div>
            On a {currency(previewJob)} visit, the assigned tech earns{" "}
            <strong style={{ color: "#1A1917" }}>{currency(techPreview)}</strong>
            {form.cancellation_tech_pay_mode === "percent" ? " (varies with charge)" : " (fixed)"}.
            <br />
            <span style={{ color: "#9E9B94" }}>2 techs → {currency(techPreview / 2)} each.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function currency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
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

// [AI.3] Commercial Service Types — tenant-managed dropdown source for the
// edit-job modal. Slug is server-derived from name on POST and immutable
// thereafter; soft-delete only (is_active=false).
interface CommercialServiceType {
  id: number;
  name: string;
  slug: string;
  default_hourly_rate: string | null;
  is_active: boolean;
  sort_order: number;
}

function CommercialServiceTypesSection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", default_hourly_rate: "" });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", default_hourly_rate: "" });

  const { data: types = [] } = useQuery<CommercialServiceType[]>({
    queryKey: ["commercial-service-types"],
    queryFn: () => apiFetch("/api/commercial-service-types"),
  });

  const create = useMutation({
    mutationFn: (body: { name: string; default_hourly_rate?: string }) =>
      apiFetch("/api/commercial-service-types", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commercial-service-types"] });
      setShowAdd(false);
      setAddForm({ name: "", default_hourly_rate: "" });
      toast({ title: "Service type added" });
    },
    onError: (err: any) => toast({
      title: "Failed to add service type",
      description: err?.message || "",
      variant: "destructive",
    }),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      apiFetch(`/api/commercial-service-types/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commercial-service-types"] });
      setEditingId(null);
      toast({ title: "Service type updated" });
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  const softDelete = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/commercial-service-types/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commercial-service-types"] });
      toast({ title: "Service type deactivated" });
    },
    onError: () => toast({ title: "Failed to deactivate", variant: "destructive" }),
  });

  const toggleActive = (t: CommercialServiceType) =>
    update.mutate({ id: t.id, body: { is_active: !t.is_active } });

  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 20, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>
            Commercial Service Types
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6B6860", fontFamily: FF }}>
            Tenant-managed list shown in the Service Type dropdown for commercial jobs.
            Default rate pre-fills the hourly rate field when picked.
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} style={btn("primary")}>
          <Plus size={14} /> Add Service Type
        </button>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FF }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #E5E2DC", textAlign: "left" as const }}>
            <th style={{ padding: "8px 10px", fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Name</th>
            <th style={{ padding: "8px 10px", fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Slug</th>
            <th style={{ padding: "8px 10px", fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.05em", textAlign: "right" as const }}>Default Rate</th>
            <th style={{ padding: "8px 10px", fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Active</th>
            <th style={{ padding: "8px 10px", width: 160 }} />
          </tr>
        </thead>
        <tbody>
          {types.length === 0 && (
            <tr>
              <td colSpan={5} style={{ padding: "20px 10px", textAlign: "center" as const, fontSize: 13, color: "#9E9B94" }}>
                No service types yet — click Add Service Type to create one.
              </td>
            </tr>
          )}
          {types.map(t => {
            const isEditing = editingId === t.id;
            return (
              <tr key={t.id} style={{ borderBottom: "1px solid #F0EDE8" }}>
                <td style={{ padding: "10px" }}>
                  {isEditing ? (
                    <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                      style={{ ...inp, width: "100%" }} />
                  ) : (
                    <span style={{ fontSize: 13, fontWeight: 600, color: t.is_active ? "#1A1917" : "#9E9B94" }}>
                      {t.name}
                    </span>
                  )}
                </td>
                <td style={{ padding: "10px", fontSize: 12, color: "#6B6860", fontFamily: "monospace" }}>{t.slug}</td>
                <td style={{ padding: "10px", textAlign: "right" as const }}>
                  {isEditing ? (
                    <input value={editForm.default_hourly_rate}
                      onChange={e => setEditForm(f => ({ ...f, default_hourly_rate: e.target.value }))}
                      placeholder="—" type="number" step="0.01" min={0}
                      style={{ ...inp, width: 100, textAlign: "right" as const }} />
                  ) : (
                    <span style={{ fontSize: 13, color: t.default_hourly_rate != null ? "#1A1917" : "#9E9B94" }}>
                      {t.default_hourly_rate != null ? `$${Number(t.default_hourly_rate).toFixed(2)}/hr` : "—"}
                    </span>
                  )}
                </td>
                <td style={{ padding: "10px" }}>
                  <button onClick={() => toggleActive(t)} disabled={isEditing}
                    style={{
                      fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 14,
                      border: `1px solid ${t.is_active ? "#86EFAC" : "#E5E2DC"}`,
                      backgroundColor: t.is_active ? "#DCFCE7" : "#F8F7F4",
                      color: t.is_active ? "#15803D" : "#6B6860",
                      cursor: "pointer", fontFamily: FF,
                    }}>
                    {t.is_active ? "Active" : "Inactive"}
                  </button>
                </td>
                <td style={{ padding: "10px", textAlign: "right" as const }}>
                  {isEditing ? (
                    <div style={{ display: "inline-flex", gap: 6 }}>
                      <button style={btn("primary")} onClick={() => {
                        const body: Record<string, unknown> = { name: editForm.name };
                        body.default_hourly_rate = editForm.default_hourly_rate === "" ? null : editForm.default_hourly_rate;
                        update.mutate({ id: t.id, body });
                      }}>Save</button>
                      <button style={btn("ghost")} onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: "inline-flex", gap: 8 }}>
                      <button style={btn("outline")} onClick={() => {
                        setEditingId(t.id);
                        setEditForm({
                          name: t.name,
                          default_hourly_rate: t.default_hourly_rate ?? "",
                        });
                      }}>Edit</button>
                      {t.is_active && (
                        <button style={btn("danger")} onClick={() => {
                          if (window.confirm(`Deactivate "${t.name}"? Historical jobs that use this type will still display correctly. You can reactivate later.`)) {
                            softDelete.mutate(t.id);
                          }
                        }}>Deactivate</button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {showAdd && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", zIndex: 900, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, width: 420, fontFamily: FF, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h4 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#1A1917" }}>Add Commercial Service Type</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>Name</label>
                <input value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. PPM Common Areas"
                  style={{ ...inp, width: "100%" }} />
                {addForm.name.trim().length > 0 && (
                  <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 4 }}>
                    Slug will be: <code style={{ fontSize: 11, fontFamily: "monospace", color: "#1A1917" }}>
                      {addForm.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}
                    </code>
                  </div>
                )}
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>
                  Default Hourly Rate <span style={{ color: "#9E9B94", fontWeight: 400, textTransform: "none" as const, letterSpacing: 0 }}>(optional)</span>
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13, color: "#6B6860" }}>$</span>
                  <input value={addForm.default_hourly_rate}
                    onChange={e => setAddForm(f => ({ ...f, default_hourly_rate: e.target.value }))}
                    type="number" step="0.01" min={0} placeholder="0.00"
                    style={{ ...inp, width: 120 }} />
                  <span style={{ fontSize: 13, color: "#9E9B94" }}>/hr</span>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <button style={btn("ghost")} onClick={() => { setShowAdd(false); setAddForm({ name: "", default_hourly_rate: "" }); }}>Cancel</button>
              <button style={btn("primary")} disabled={addForm.name.trim().length === 0 || create.isPending}
                onClick={() => create.mutate({
                  name: addForm.name.trim(),
                  default_hourly_rate: addForm.default_hourly_rate === "" ? undefined : addForm.default_hourly_rate,
                })}>
                {create.isPending ? "Adding..." : "Add Service Type"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
