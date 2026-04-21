import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import {
  ArrowLeft, Plus, Pencil, Trash2, Check, X,
  Tag, DollarSign, Clock, Eye, EyeOff,
} from "lucide-react";
import { toast } from "sonner";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: { method?: string; body?: any } = {}) {
  const { body, ...rest } = opts;
  const r = await fetch(`${API}${path}`, {
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    ...rest,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

interface PricingScope {
  id: number;
  name: string;
  pricing_method: string;
  hourly_rate: string;
  minimum_bill: string;
  scope_group: string;
  is_active: boolean;
  sort_order: number;
}

interface PricingAddon {
  id: number;
  name: string;
  addon_type: string;
  scope_ids: string;
  price_type: string;
  price_value: string;
  time_add_minutes: number;
  time_unit: string;
  is_itemized: boolean;
  is_taxed: boolean;
  show_office: boolean;
  show_online: boolean;
  show_portal: boolean;
  is_active: boolean;
  sort_order: number;
}

const PRICE_TYPES = [
  { value: "flat",       label: "Flat ($)" },
  { value: "percentage", label: "Percentage (%)" },
  { value: "sqft_pct",  label: "Sq Ft % (price_value × sq.ft.)" },
  { value: "time_only", label: "Time Only (no charge)" },
  { value: "manual_adj",label: "Manual Entry (office-only)" },
];

const ADDON_TYPES = [
  { value: "cleaning_extras", label: "Cleaning Extras" },
  { value: "other",           label: "Discounts & Other" },
];

const TIME_UNITS = [
  { value: "each",  label: "Each" },
  { value: "sqft",  label: "Per Sq Ft" },
];

function getPriceValue(addon: PricingAddon): number {
  return parseFloat(String(addon.price_value ?? 0));
}

function formatAddonPrice(addon: PricingAddon): string {
  const pv = getPriceValue(addon);
  switch (addon.price_type) {
    case "flat":
      if (pv < 0) return `(${Math.abs(pv).toFixed(2)})`;
      return `$${pv.toFixed(2)}`;
    case "percentage":
      return pv < 0 ? `${pv.toFixed(1)}%` : `+${pv.toFixed(1)}%`;
    case "sqft_pct":
      return `${pv.toFixed(2)}% × sq.ft.`;
    case "time_only":
      return "Time only";
    case "manual_adj":
      return "Manual entry";
    default:
      return pv ? `$${pv.toFixed(2)}` : "—";
  }
}

function parseAddonScopeIds(addon: PricingAddon): number[] {
  try { return JSON.parse(addon.scope_ids || "[]"); }
  catch { return []; }
}

function VisibilityDot({ on, label }: { on: boolean; label: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      padding: "2px 6px", borderRadius: 9999, fontSize: 11, fontWeight: 600,
      background: on ? "#F0FDF9" : "#F7F6F3",
      color: on ? "#00C9A0" : "#C4C1BA",
      border: `1px solid ${on ? "#9FE7D0" : "#E5E2DC"}`,
    }}>
      {on ? <Eye size={10} /> : <EyeOff size={10} />}
      {label}
    </span>
  );
}

// ── Drawer ───────────────────────────────────────────────────────────────────

interface DrawerProps {
  open: boolean;
  editing: PricingAddon | null;
  allScopes: PricingScope[];
  selectedScopeId: number | null;
  onClose: () => void;
  onSaved: () => void;
}

function AddonDrawer({ open, editing, allScopes, selectedScopeId, onClose, onSaved }: DrawerProps) {
  const [name, setName] = useState("");
  const [addonType, setAddonType] = useState("cleaning_extras");
  const [scopeIds, setScopeIds] = useState<number[]>([]);
  const [priceType, setPriceType] = useState("flat");
  const [priceValue, setPriceValue] = useState<string>("0");
  const [timeMinutes, setTimeMinutes] = useState<string>("0");
  const [timeUnit, setTimeUnit] = useState("each");
  const [isItemized, setIsItemized] = useState(true);
  const [isTaxed, setIsTaxed] = useState(false);
  const [showOffice, setShowOffice] = useState(true);
  const [showOnline, setShowOnline] = useState(true);
  const [showPortal, setShowPortal] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      if (editing) {
        setName(editing.name);
        setAddonType(editing.addon_type || "cleaning_extras");
        setScopeIds(parseAddonScopeIds(editing));
        setPriceType(editing.price_type || "flat");
        setPriceValue(String(getPriceValue(editing)));
        setTimeMinutes(String(editing.time_add_minutes || 0));
        setTimeUnit(editing.time_unit || "each");
        setIsItemized(editing.is_itemized !== false);
        setIsTaxed(editing.is_taxed === true);
        setShowOffice(editing.show_office !== false);
        setShowOnline(editing.show_online !== false);
        setShowPortal(editing.show_portal !== false);
      } else {
        setName("");
        setAddonType("cleaning_extras");
        setScopeIds(selectedScopeId ? [selectedScopeId] : []);
        setPriceType("flat");
        setPriceValue("0");
        setTimeMinutes("0");
        setTimeUnit("each");
        setIsItemized(true); setIsTaxed(false);
        setShowOffice(true); setShowOnline(true); setShowPortal(true);
      }
    }
  }, [open, editing, selectedScopeId]);

  function toggleScope(id: number) {
    setScopeIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function handleSave() {
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (scopeIds.length === 0) { toast.error("Select at least one scope"); return; }
    setSaving(true);
    try {
      const body = {
        name: name.trim(), addon_type: addonType, scope_ids: scopeIds,
        price_type: priceType, price_value: parseFloat(priceValue) || 0,
        time_add_minutes: parseInt(timeMinutes) || 0, time_unit: timeUnit,
        is_itemized: isItemized, is_taxed: isTaxed,
        show_office: showOffice, show_online: showOnline, show_portal: showPortal,
      };
      if (editing) {
        await apiFetch(`/api/pricing/addons/${editing.id}`, { method: "PATCH", body });
        toast.success("Add-on updated");
      } else {
        await apiFetch("/api/pricing/addons", { method: "POST", body });
        toast.success("Add-on created");
      }
      onSaved();
    } catch {
      toast.error("Failed to save add-on");
    } finally {
      setSaving(false);
    }
  }

  const showPriceInput = priceType !== "time_only" && priceType !== "manual_adj";

  return (
    <>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 40,
        opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none", transition: "opacity 0.2s",
      }} />
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 460, zIndex: 50,
        background: "#fff", boxShadow: "-4px 0 32px rgba(0,0,0,0.12)",
        transform: open ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.25s cubic-bezier(0.32,0.72,0,1)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        fontFamily: "'Plus Jakarta Sans', sans-serif",
      }}>
        {/* Header */}
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #E5E2DC", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#0A0E1A" }}>
              {editing ? "Edit Add-on" : "New Add-on"}
            </div>
            <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 2 }}>Rate modification rule</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "#9E9B94" }}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Name */}
            <Field label="Name" required>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Oven Cleaning"
                style={iStyle} />
            </Field>

            {/* Addon Type */}
            <Field label="Category">
              <select value={addonType} onChange={e => setAddonType(e.target.value)} style={iStyle}>
                {ADDON_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>

            {/* Scopes */}
            <Field label="Applies to Scopes" required>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                {allScopes.filter(s => s.is_active).map(scope => (
                  <label key={scope.id} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "8px 12px", borderRadius: 8, border: `1px solid ${scopeIds.includes(scope.id) ? "#00C9A0" : "#E5E2DC"}`, background: scopeIds.includes(scope.id) ? "#F0FDF9" : "#FAFAFA" }}>
                    <div onClick={() => toggleScope(scope.id)} style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${scopeIds.includes(scope.id) ? "#00C9A0" : "#C4C1BA"}`, background: scopeIds.includes(scope.id) ? "#00C9A0" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {scopeIds.includes(scope.id) && <Check size={10} color="#fff" />}
                    </div>
                    <div onClick={() => toggleScope(scope.id)} style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#0A0E1A" }}>{scope.name}</div>
                      <div style={{ fontSize: 11, color: "#9E9B94" }}>{scope.pricing_method} · ${parseFloat(scope.hourly_rate).toFixed(0)}/hr</div>
                    </div>
                  </label>
                ))}
              </div>
            </Field>

            {/* Price Type */}
            <Field label="Price Type">
              <select value={priceType} onChange={e => setPriceType(e.target.value)} style={iStyle}>
                {PRICE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>

            {/* Price Value */}
            {showPriceInput && (
              <Field label={priceType === "sqft_pct" ? "Percentage (% of sq.ft.)" : priceType === "percentage" ? "Percentage (%)" : "Amount ($)"}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {priceType === "flat" && <span style={{ color: "#6B7280", fontSize: 14 }}>$</span>}
                  <input type="number" value={priceValue} onChange={e => setPriceValue(e.target.value)}
                    placeholder="0.00" step="0.01" style={{ ...iStyle, flex: 1 }} />
                  {(priceType === "percentage" || priceType === "sqft_pct") && <span style={{ color: "#6B7280", fontSize: 14 }}>%</span>}
                </div>
                {priceType === "flat" && (
                  <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 4 }}>Use a negative value for discounts, e.g. -50 for $50 off</div>
                )}
                {priceType === "percentage" && (
                  <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 4 }}>Use a negative value to reduce price, e.g. -15 for 15% off</div>
                )}
              </Field>
            )}

            {priceType === "time_only" && (
              <div style={{ background: "#F0FDF9", border: "1px solid #9FE7D0", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#047857" }}>
                This add-on adds time to the job only — no price is charged. Time minutes below will be added to the booking.
              </div>
            )}
            {priceType === "manual_adj" && (
              <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#92400E" }}>
                The amount is entered manually by the office when creating a quote. Not shown to customers online.
              </div>
            )}

            {/* Time */}
            <div style={{ display: "flex", gap: 12 }}>
              <Field label="Add Time (minutes)" style={{ flex: 1 }}>
                <input type="number" value={timeMinutes} onChange={e => setTimeMinutes(e.target.value)}
                  min="0" step="15" style={iStyle} />
              </Field>
              <Field label="Unit" style={{ flex: 1 }}>
                <select value={timeUnit} onChange={e => setTimeUnit(e.target.value)} style={iStyle}>
                  {TIME_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                </select>
              </Field>
            </div>

            {/* Flags */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>Visibility</div>
              {[
                { key: "show_office", label: "Show in Office (quote builder)", val: showOffice, set: setShowOffice },
                { key: "show_online", label: "Show Online (booking widget)", val: showOnline, set: setShowOnline },
                { key: "show_portal", label: "Show in Customer Portal", val: showPortal, set: setShowPortal },
              ].map(f => (
                <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <div onClick={() => f.set(!f.val)} style={{ width: 36, height: 20, borderRadius: 10, background: f.val ? "#00C9A0" : "#E5E2DC", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                    <div style={{ position: "absolute", top: 2, left: f.val ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                  </div>
                  <span style={{ fontSize: 13, color: "#0A0E1A" }}>{f.label}</span>
                </label>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>Accounting</div>
              {[
                { key: "is_itemized", label: "Show as line item on invoice", val: isItemized, set: setIsItemized },
                { key: "is_taxed", label: "Taxable add-on", val: isTaxed, set: setIsTaxed },
              ].map(f => (
                <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <div onClick={() => f.set(!f.val)} style={{ width: 36, height: 20, borderRadius: 10, background: f.val ? "#00C9A0" : "#E5E2DC", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                    <div style={{ position: "absolute", top: 2, left: f.val ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                  </div>
                  <span style={{ fontSize: 13, color: "#0A0E1A" }}>{f.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "16px 24px", borderTop: "1px solid #E5E2DC", display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button onClick={onClose} style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid #E5E2DC", background: "#fff", fontSize: 13, fontWeight: 600, color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: saving ? "#9FE7D0" : "#00C9A0", color: "#fff", fontSize: 13, fontWeight: 700, cursor: saving ? "default" : "pointer", fontFamily: "inherit" }}>
            {saving ? "Saving…" : editing ? "Save Changes" : "Create Add-on"}
          </button>
        </div>
      </div>
    </>
  );
}

function Field({ label, required, children, style }: { label: string; required?: boolean; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={style}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#0A0E1A", marginBottom: 6 }}>
        {label}{required && <span style={{ color: "#EF4444", marginLeft: 2 }}>*</span>}
      </div>
      {children}
    </div>
  );
}

const iStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  padding: "9px 12px", borderRadius: 8, border: "1px solid #E5E2DC",
  fontSize: 13, color: "#0A0E1A", background: "#FAFAFA",
  fontFamily: "'Plus Jakarta Sans', sans-serif", outline: "none",
};

// ── Main Page ────────────────────────────────────────────────────────────────

export default function RatesPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [selectedScopeId, setSelectedScopeId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingAddon, setEditingAddon] = useState<PricingAddon | null>(null);

  const { data: scopes = [] } = useQuery<PricingScope[]>({
    queryKey: ["pricing-scopes-all"],
    queryFn: () => apiFetch("/api/pricing/scopes"),
    staleTime: 0,
  });

  const { data: addons = [], isLoading: addonsLoading } = useQuery<PricingAddon[]>({
    queryKey: ["pricing-addons-scope", selectedScopeId],
    queryFn: () => apiFetch(`/api/pricing/addons?scope_id=${selectedScopeId}`),
    enabled: selectedScopeId !== null,
    staleTime: 0,
  });

  // Auto-select first scope
  useEffect(() => {
    if (scopes.length > 0 && selectedScopeId === null) {
      setSelectedScopeId(scopes[0].id);
    }
  }, [scopes, selectedScopeId]);

  const selectedScope = scopes.find(s => s.id === selectedScopeId);

  function openDrawer(addon: PricingAddon | null) {
    setEditingAddon(addon);
    setDrawerOpen(true);
  }
  function closeDrawer() { setDrawerOpen(false); setTimeout(() => setEditingAddon(null), 300); }
  function onSaved() {
    qc.invalidateQueries({ queryKey: ["pricing-addons-scope"] });
    closeDrawer();
  }

  async function deactivateAddon(id: number) {
    if (!confirm("Remove this add-on from this scope? It will be deactivated.")) return;
    try {
      await apiFetch(`/api/pricing/addons/${id}`, { method: "PATCH", body: { is_active: false } });
      toast.success("Add-on removed");
      qc.invalidateQueries({ queryKey: ["pricing-addons-scope"] });
    } catch {
      toast.error("Failed to remove add-on");
    }
  }

  const addonGroups: Record<string, PricingAddon[]> = {};
  for (const a of addons) {
    const t = a.addon_type || "cleaning_extras";
    if (!addonGroups[t]) addonGroups[t] = [];
    addonGroups[t].push(a);
  }

  const groupOrder = ["cleaning_extras", "other"];
  const groupLabels: Record<string, string> = {
    cleaning_extras: "Cleaning Extras",
    other: "Discounts & Adjustments",
  };

  return (
    <DashboardLayout title="Rates & Add-ons">
      <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", display: "flex", height: "calc(100vh - 64px)", overflow: "hidden", background: "#F7F6F3" }}>

        {/* ── Left: Scope Panel ─────────────────────────────────────────────── */}
        <div style={{ width: 264, background: "#fff", borderRight: "1px solid #E5E2DC", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid #E5E2DC" }}>
            <button onClick={() => navigate("/company")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#6B7280", fontSize: 13, fontFamily: "inherit", padding: 0, marginBottom: 12 }}>
              <ArrowLeft size={14} /> Company Settings
            </button>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#0A0E1A" }}>Rates & Add-ons</div>
            <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 2 }}>MC rate modifications by scope</div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
            {scopes.map(scope => {
              const isSelected = scope.id === selectedScopeId;
              return (
                <div key={scope.id} onClick={() => setSelectedScopeId(scope.id)} style={{
                  padding: "10px 16px", cursor: "pointer", borderLeft: `3px solid ${isSelected ? "#00C9A0" : "transparent"}`,
                  background: isSelected ? "#F0FDF9" : "transparent", transition: "background 0.15s",
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: isSelected ? "#00C9A0" : "#0A0E1A" }}>{scope.name}</div>
                  <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>
                    {scope.pricing_method} · ${parseFloat(scope.hourly_rate).toFixed(0)}/hr
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: Add-ons Panel ───────────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Header */}
          <div style={{ padding: "20px 32px", borderBottom: "1px solid #E5E2DC", background: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            {selectedScope ? (
              <div>
                <div style={{ fontWeight: 700, fontSize: 18, color: "#0A0E1A" }}>{selectedScope.name}</div>
                <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 2 }}>
                  {selectedScope.pricing_method === "sqft" ? "Sq ft-based pricing" : "Hourly pricing"} ·{" "}
                  ${parseFloat(selectedScope.hourly_rate).toFixed(0)}/hr base ·{" "}
                  ${parseFloat(selectedScope.minimum_bill).toFixed(0)} minimum
                </div>
              </div>
            ) : (
              <div style={{ color: "#9E9B94", fontSize: 14 }}>Select a scope to view its add-ons</div>
            )}
            {selectedScope && (
              <button onClick={() => openDrawer(null)} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "9px 18px", borderRadius: 8, border: "none",
                background: "#00C9A0", color: "#fff", fontSize: 13, fontWeight: 700,
                cursor: "pointer", fontFamily: "inherit",
              }}>
                <Plus size={15} /> New Add-on
              </button>
            )}
          </div>

          {/* Addon Table */}
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 32px" }}>
            {!selectedScope && (
              <div style={{ textAlign: "center", color: "#9E9B94", marginTop: 80, fontSize: 14 }}>
                Select a scope from the left panel to manage its add-ons.
              </div>
            )}

            {selectedScope && addonsLoading && (
              <div style={{ color: "#9E9B94", fontSize: 14, textAlign: "center", marginTop: 40 }}>Loading…</div>
            )}

            {selectedScope && !addonsLoading && addons.length === 0 && (
              <div style={{ textAlign: "center", marginTop: 60 }}>
                <Tag size={32} color="#C4C1BA" style={{ margin: "0 auto 12px" }} />
                <div style={{ fontWeight: 600, color: "#0A0E1A", fontSize: 15 }}>No add-ons yet</div>
                <div style={{ color: "#9E9B94", fontSize: 13, marginTop: 4, marginBottom: 20 }}>
                  Create rate modifications for this scope — extras, discounts, and adjustments.
                </div>
                <button onClick={() => openDrawer(null)} style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#00C9A0", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  <Plus size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />New Add-on
                </button>
              </div>
            )}

            {selectedScope && !addonsLoading && groupOrder.map(groupKey => {
              const group = addonGroups[groupKey];
              if (!group?.length) return null;
              return (
                <div key={groupKey} style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                    {groupLabels[groupKey] ?? groupKey}
                  </div>
                  <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E5E2DC", overflow: "hidden" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "#F7F6F3", borderBottom: "1px solid #E5E2DC" }}>
                          <th style={thStyle}>Name</th>
                          <th style={thStyle}>Price</th>
                          <th style={thStyle}>Time</th>
                          <th style={thStyle}>Scopes</th>
                          <th style={thStyle}>Visibility</th>
                          <th style={thStyle}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.map((addon, idx) => (
                          <tr key={addon.id} style={{ borderBottom: idx < group.length - 1 ? "1px solid #F0EDE8" : "none" }}>
                            <td style={tdStyle}>
                              <div style={{ fontWeight: 600, color: "#0A0E1A" }}>{addon.name}</div>
                              {(addon.is_taxed || !addon.is_itemized) && (
                                <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                                  {addon.is_taxed && <span style={{ fontSize: 10, background: "#FEF3C7", color: "#92400E", padding: "1px 5px", borderRadius: 9999 }}>Taxed</span>}
                                  {!addon.is_itemized && <span style={{ fontSize: 10, background: "#F7F6F3", color: "#6B7280", padding: "1px 5px", borderRadius: 9999 }}>Not itemized</span>}
                                </div>
                              )}
                            </td>
                            <td style={tdStyle}>
                              <span style={{ fontWeight: 600, fontFamily: "monospace", color: getPriceValue(addon) < 0 ? "#EF4444" : "#0A0E1A" }}>
                                {formatAddonPrice(addon)}
                              </span>
                            </td>
                            <td style={tdStyle}>
                              {addon.time_add_minutes > 0 ? (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#6B7280" }}>
                                  <Clock size={12} />+{addon.time_add_minutes}min
                                </span>
                              ) : "—"}
                            </td>
                            <td style={tdStyle}>
                              <ScopeCount addon={addon} allScopes={scopes} />
                            </td>
                            <td style={{ ...tdStyle, verticalAlign: "top" }}>
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                <VisibilityDot on={addon.show_office} label="Office" />
                                <VisibilityDot on={addon.show_online} label="Online" />
                                <VisibilityDot on={addon.show_portal} label="Portal" />
                              </div>
                            </td>
                            <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                              <button onClick={() => openDrawer(addon)} style={actionBtn("#6B7280")}>
                                <Pencil size={13} />
                              </button>
                              <button onClick={() => deactivateAddon(addon.id)} style={actionBtn("#EF4444")}>
                                <Trash2 size={13} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}

            {/* Remaining unknown groups */}
            {selectedScope && !addonsLoading && Object.keys(addonGroups).filter(k => !groupOrder.includes(k)).map(groupKey => {
              const group = addonGroups[groupKey];
              if (!group?.length) return null;
              return (
                <div key={groupKey} style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>{groupKey}</div>
                  {group.map(addon => (
                    <div key={addon.id} style={{ padding: "10px 16px", background: "#fff", borderRadius: 8, border: "1px solid #E5E2DC", marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{addon.name}</span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => openDrawer(addon)} style={actionBtn("#6B7280")}><Pencil size={13} /></button>
                        <button onClick={() => deactivateAddon(addon.id)} style={actionBtn("#EF4444")}><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <AddonDrawer
        open={drawerOpen}
        editing={editingAddon}
        allScopes={scopes}
        selectedScopeId={selectedScopeId}
        onClose={closeDrawer}
        onSaved={onSaved}
      />
    </DashboardLayout>
  );
}

function ScopeCount({ addon, allScopes }: { addon: PricingAddon; allScopes: PricingScope[] }) {
  const ids = parseAddonScopeIds(addon);
  const names = ids.map(id => allScopes.find(s => s.id === id)?.name).filter(Boolean) as string[];
  if (names.length === 0) return <span style={{ color: "#C4C1BA" }}>—</span>;
  if (names.length === 1) return <span style={{ fontSize: 12, color: "#6B7280" }}>{names[0]}</span>;
  return (
    <span title={names.join(", ")} style={{ fontSize: 12, color: "#6B7280" }}>
      {names[0]}{names.length > 1 ? ` +${names.length - 1}` : ""}
    </span>
  );
}

const thStyle: React.CSSProperties = {
  padding: "10px 16px", textAlign: "left", fontSize: 11,
  fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em",
};

const tdStyle: React.CSSProperties = {
  padding: "12px 16px", verticalAlign: "middle",
};

function actionBtn(hoverColor: string): React.CSSProperties {
  return {
    background: "none", border: "none", cursor: "pointer",
    padding: "4px 6px", borderRadius: 6, color: "#9E9B94",
    fontFamily: "inherit",
  };
}
