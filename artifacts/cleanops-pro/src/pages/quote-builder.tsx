import { useState, useEffect, useRef, useCallback } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { getAuthHeaders } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  ArrowLeft, Save, SendHorizonal, ArrowRight, ChevronDown,
  User, Home, Calculator, PlusSquare, AlertCircle, CheckCircle2,
  Clock, Ruler, X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const EMPTY_SCOPES: PricingScope[] = [];
const EMPTY_FREQUENCIES: PricingFrequency[] = [];
const EMPTY_ADDONS: PricingAddon[] = [];

async function apiFetch(path: string, opts: { method?: string; body?: any; headers?: any } = {}) {
  const { body, headers: extraHeaders, ...rest } = opts;
  const r = await fetch(`${API}${path}`, {
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...extraHeaders },
    ...rest,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

interface Client {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
}

interface PricingScope {
  id: number;
  name: string;
  scope_group: string;
  pricing_method: string;
  hourly_rate: string;
  minimum_bill: string;
  displayed_for_office: boolean;
  is_active: boolean;
  sort_order: number;
}

interface PricingFrequency {
  id: number;
  scope_id: number;
  frequency: string;
  label: string;
  multiplier: string;
  rate_override: string | null;
  show_office: boolean;
  sort_order: number;
}

interface PricingAddon {
  id: number;
  scope_id: number;
  name: string;
  addon_type: string;
  scope_ids: string;
  price_type: string;
  price_value: string;
  price: string | null;
  percent_of_base: string | null;
  time_add_minutes: number;
  time_unit: string;
  is_itemized: boolean;
  show_office: boolean;
  show_online: boolean;
  is_active: boolean;
}

interface CalcResult {
  scope_id: number;
  pricing_method: string;
  sqft: number | null;
  frequency: string | null;
  base_hours: number;
  hourly_rate: number;
  base_price: number;
  minimum_applied: boolean;
  minimum_bill: number;
  addons_total: number;
  addon_breakdown: Array<{ id: number; name: string; amount: number; price_type?: string }>;
  subtotal: number;
  discount_amount: number;
  discount_valid?: boolean;
  final_total: number;
}

const DIRT_LEVELS = [
  { value: "pristine", label: "Pristine — barely been used" },
  { value: "standard", label: "Standard — normal wear" },
  { value: "heavy", label: "Heavy — needs deep attention" },
];

const SECTION_ICONS = [User, Home, Calculator, PlusSquare];
const SECTION_LABELS = ["Customer Info", "Property Details", "Service & Pricing", "Add-ons & Notes"];

export default function QuoteBuilderPage() {
  const [matchEdit, editParams] = useRoute("/quotes/:id/edit"); const id = editParams?.id;
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const isEdit = Boolean(id && id !== "new");

  const [activeSection, setActiveSection] = useState(0);
  const [saving, setSaving] = useState(false);

  // Section 0 — Customer
  const [clientOpen, setClientOpen] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [leadName, setLeadName] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadPhone, setLeadPhone] = useState("");
  const [address, setAddress] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [zipZone, setZipZone] = useState<{ name: string; color: string } | null | "uncovered">("uncovered" as const);
  const [checkingZip, setCheckingZip] = useState(false);

  // Section 1 — Property
  const [sqft, setSqft] = useState<number>(0);
  const [bedrooms, setBedrooms] = useState<number>(2);
  const [bathrooms, setBathrooms] = useState<number>(1);
  const [halfBaths, setHalfBaths] = useState<number>(0);
  const [pets, setPets] = useState<number>(0);
  const [dirtLevel, setDirtLevel] = useState("standard");

  // Section 2 — Service & Pricing
  const [scopeId, setScopeId] = useState<number | null>(null);
  const [frequencyStr, setFrequencyStr] = useState<string>("");
  const [hoursInput, setHoursInput] = useState<number>(0);

  // Section 3 — Add-ons & Notes
  const [selectedAddonIds, setSelectedAddonIds] = useState<number[]>([]);
  const [manualAdjValue, setManualAdjValue] = useState<string>("");
  const [discountCode, setDiscountCode] = useState("");
  const [discountInput, setDiscountInput] = useState("");
  const [notes, setNotes] = useState("");
  const [internalMemo, setInternalMemo] = useState("");

  const [calcResult, setCalcResult] = useState<CalcResult | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);
  const [discountError, setDiscountError] = useState("");

  // Mobile-specific state
  const isMobile = useIsMobile();
  const [mobileNotesOpen, setMobileNotesOpen] = useState(false);
  const [mobileClientSearch, setMobileClientSearch] = useState("");
  const [mobileClientDropdown, setMobileClientDropdown] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Data queries ────────────────────────────────────────────────────────────

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["clients-list"],
    queryFn: () => apiFetch("/api/clients?limit=200").then((r: any) => r.data ?? r),
  });

  // Only fetch office-visible active scopes — staleTime:0 ensures fresh on every open
  const { data: scopes = EMPTY_SCOPES } = useQuery<PricingScope[]>({
    queryKey: ["pricing-scopes-office"],
    queryFn: () => apiFetch("/api/pricing/scopes?office=true"),
    staleTime: 0,
  });

  // Only fetch office-visible frequencies for selected scope
  const { data: frequencies = EMPTY_FREQUENCIES } = useQuery<PricingFrequency[]>({
    queryKey: ["pricing-frequencies-office", scopeId],
    queryFn: () => apiFetch(`/api/pricing/scopes/${scopeId}/frequencies?office=true`),
    enabled: Boolean(scopeId),
    staleTime: 0,
  });

  const { data: scopeAddons = EMPTY_ADDONS } = useQuery<PricingAddon[]>({
    queryKey: ["pricing-addons", scopeId],
    queryFn: () => apiFetch(`/api/pricing/scopes/${scopeId}/addons`),
    enabled: Boolean(scopeId),
    staleTime: 0,
  });

  const { data: existingQuote } = useQuery({
    queryKey: ["quote", id],
    queryFn: () => apiFetch(`/api/quotes/${id}`),
    enabled: isEdit,
  });

  // ── Restore existing quote ───────────────────────────────────────────────────

  useEffect(() => {
    if (existingQuote) {
      setSelectedClientId(existingQuote.client_id || null);
      setLeadName(existingQuote.lead_name || "");
      setLeadEmail(existingQuote.lead_email || "");
      setLeadPhone(existingQuote.lead_phone || "");
      setAddress(existingQuote.address || "");
      setScopeId(existingQuote.scope_id || null);
      setSqft(existingQuote.sqft || 0);
      setBedrooms(existingQuote.bedrooms || 2);
      setBathrooms(existingQuote.bathrooms || 1);
      setHalfBaths(existingQuote.half_baths || 0);
      setPets(existingQuote.pets || 0);
      setDirtLevel(existingQuote.dirt_level || "standard");
      setDiscountCode(existingQuote.discount_code || "");
      setDiscountInput(existingQuote.discount_code || "");
      setNotes(existingQuote.notes || "");
      setInternalMemo(existingQuote.internal_memo || "");
      setFrequencyStr(existingQuote.frequency || "");
      setHoursInput(existingQuote.estimated_hours ? parseFloat(existingQuote.estimated_hours) : 0);
      if (Array.isArray(existingQuote.addons)) {
        setSelectedAddonIds(existingQuote.addons.map((a: any) => a.id).filter(Boolean));
      }
    }
  }, [existingQuote]);

  // Reset add-ons and frequency when scope changes
  useEffect(() => {
    if (scopeId !== null) {
      setSelectedAddonIds([]);
      setManualAdjValue("");
      setFrequencyStr("");
      setHoursInput(0);
    }
  }, [scopeId]);

  // Auto-default frequency once frequencies load
  useEffect(() => {
    if (scopeId && frequencies.length > 0 && !frequencyStr) {
      const oneTime = frequencies.find(f =>
        f.frequency.toLowerCase().includes("one") || f.frequency.toLowerCase().includes("single")
      );
      setFrequencyStr(oneTime?.frequency ?? frequencies[0].frequency);
    }
  }, [scopeId, frequencies, frequencyStr]);

  const selectedScope = scopes.find(s => s.id === scopeId);
  const pricingMethod = selectedScope?.pricing_method ?? "sqft";

  // ── Live price calculation (debounced 300ms) ─────────────────────────────────

  const runCalculate = useCallback(async (opts?: { withCode?: string }) => {
    if (!scopeId) { setCalcResult(null); return; }

    const method = selectedScope?.pricing_method ?? "sqft";

    // Need sqft for sqft method
    if (method === "sqft" && (!sqft || sqft === 0)) { setCalcResult(null); return; }
    // Need hours for hourly/simplified
    if ((method === "hourly" || method === "simplified") && (!hoursInput || hoursInput <= 0)) {
      setCalcResult(null); return;
    }

    setCalcLoading(true);
    try {
      const manualAdjNum = parseFloat(manualAdjValue);
      const body: Record<string, unknown> = {
        scope_id: scopeId,
        frequency: frequencyStr || undefined,
        addon_ids: selectedAddonIds,
        discount_code: opts?.withCode ?? discountCode,
        ...(manualAdjValue && !isNaN(manualAdjNum) ? { manual_adjustment: manualAdjNum } : {}),
      };
      if (method === "sqft") {
        body.sqft = sqft;
      } else {
        body.hours = hoursInput;
        if (sqft > 0) body.sqft = sqft;
      }

      const result = await apiFetch("/api/pricing/calculate", { method: "POST", body });
      setCalcResult(result);

      if (opts?.withCode !== undefined) {
        if (result.discount_valid === false) {
          setDiscountError("Code not found or inactive");
          setDiscountCode("");
        } else if (result.discount_amount > 0) {
          setDiscountError("");
          setDiscountCode(opts.withCode);
        }
      }
    } catch { /* ignore transient errors */ }
    finally { setCalcLoading(false); }
  }, [scopeId, sqft, hoursInput, frequencyStr, selectedAddonIds, manualAdjValue, discountCode, selectedScope]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { runCalculate(); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [scopeId, sqft, hoursInput, frequencyStr, selectedAddonIds, manualAdjValue]);

  // ── Section completion ────────────────────────────────────────────────────────

  const sectionComplete = [
    Boolean(selectedClientId || leadName || leadEmail),
    Boolean(sqft > 0 || pricingMethod !== "sqft"),
    Boolean(scopeId && frequencyStr && (pricingMethod === "sqft" ? sqft > 0 : hoursInput > 0)),
    true,
  ];

  // ── Scope groups (office-visible, active only) ────────────────────────────────

  const scopeGroups = scopes.reduce<Record<string, PricingScope[]>>((acc, s) => {
    const g = s.scope_group || "Other";
    if (!acc[g]) acc[g] = [];
    acc[g].push(s);
    return acc;
  }, {});

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function buildPayload(status: string) {
    const client = selectedClientId ? clients.find(c => c.id === selectedClientId) : null;
    const cr = calcResult;
    return {
      client_id: selectedClientId || null,
      lead_name: client ? `${client.first_name} ${client.last_name}`.trim() : leadName || null,
      lead_email: client?.email || leadEmail || null,
      lead_phone: client?.phone || leadPhone || null,
      address: address || client?.address || null,
      scope_id: scopeId || null,
      frequency: frequencyStr || null,
      sqft: sqft || null,
      bedrooms,
      bathrooms,
      half_baths: halfBaths,
      pets,
      dirt_level: dirtLevel,
      addons: cr?.addon_breakdown ?? [],
      discount_code: discountCode || null,
      base_price: cr ? String(cr.base_price) : null,
      addons_total: cr ? String(cr.addons_total) : null,
      discount_amount: cr ? String(cr.discount_amount) : "0",
      total_price: cr ? String(cr.final_total) : null,
      estimated_hours: cr ? String(cr.base_hours) : (hoursInput > 0 ? String(hoursInput) : null),
      hourly_rate: cr ? String(cr.hourly_rate) : null,
      notes: notes || null,
      internal_memo: internalMemo || null,
      status,
    };
  }

  async function checkZip(zip: string) {
    const clean = zip.trim().replace(/\D/g, "").slice(0, 5);
    if (clean.length < 5) { setZipZone(null); return; }
    setCheckingZip(true);
    try {
      const zones = await apiFetch("/api/zones");
      const match = (Array.isArray(zones) ? zones : []).find((z: any) => Array.isArray(z.zip_codes) && z.zip_codes.includes(clean));
      setZipZone(match ? { name: match.name, color: match.color } : "uncovered");
    } catch { setZipZone(null); }
    finally { setCheckingZip(false); }
  }

  async function save(status: string = "draft", thenConvert = false) {
    setSaving(true);
    try {
      const payload = buildPayload(status);
      let result;
      if (isEdit) {
        result = await apiFetch(`/api/quotes/${id}`, { method: "PATCH", body: payload });
      } else {
        result = await apiFetch("/api/quotes", { method: "POST", body: payload });
      }
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote-stats"] });
      const savedId = result?.id ?? id;
      if (thenConvert && savedId) {
        await apiFetch(`/api/quotes/${savedId}/convert`, { method: "POST" });
        toast.success("Quote converted to job. Go to Jobs to complete setup.");
        navigate("/jobs");
      } else if (status === "sent") {
        toast.success(isEdit ? "Quote sent" : "Quote created and marked as sent.");
        navigate(`/quotes/${savedId}`);
      } else {
        toast.success("Quote saved as draft");
        navigate(`/quotes/${savedId}`);
      }
    } catch {
      toast.error("Failed to save quote");
    } finally {
      setSaving(false);
    }
  }

  const selectedClient = clients.find(c => c.id === selectedClientId);

  function toggleAddon(addonId: number) {
    setSelectedAddonIds(prev =>
      prev.includes(addonId) ? prev.filter(a => a !== addonId) : [...prev, addonId]
    );
  }

  function addonDisplayPrice(addon: PricingAddon): string {
    const pv = parseFloat(String(addon.price_value ?? addon.price ?? 0));
    switch (addon.price_type) {
      case "flat":
        if (pv < 0) return `($${Math.abs(pv).toFixed(2)}) discount`;
        return `$${pv.toFixed(2)}`;
      case "percentage":
        if (pv < 0) return `${pv.toFixed(1)}% off`;
        return `+${pv.toFixed(1)}%`;
      case "sqft_pct":
        return `${pv.toFixed(2)}% × sq.ft.`;
      case "time_only":
        return "No additional charge";
      case "manual_adj":
        return "Enter amount below";
      case "percent":
        return addon.percent_of_base ? `${addon.percent_of_base}% of base` : "";
      default:
        return pv ? `$${pv.toFixed(2)}` : "";
    }
  }

  // ── Pricing method helpers ───────────────────────────────────────────────────

  function pricingMethodLabel(method: string): string {
    if (method === "hourly") return "Hourly";
    if (method === "simplified") return "Simplified";
    return "Sq Ft Based";
  }

  function effectiveHourlyRate(): number {
    if (!selectedScope) return 0;
    const base = parseFloat(selectedScope.hourly_rate);
    const freq = frequencies.find(f => f.frequency === frequencyStr);
    if (freq?.rate_override) return parseFloat(freq.rate_override);
    if (freq) return base * parseFloat(freq.multiplier);
    return base;
  }

  // ── Mobile variables ─────────────────────────────────────────────────────
  const MFF = "'Plus Jakarta Sans', sans-serif";
  const mobileActiveAddons = scopeAddons.filter(a => a.is_active && a.show_office !== false);
  const mobileFilteredClients = mobileClientSearch.trim().length > 0
    ? clients.filter(c => `${c.first_name} ${c.last_name} ${c.email}`.toLowerCase().includes(mobileClientSearch.toLowerCase())).slice(0, 30)
    : clients.slice(0, 30);

  // ── Mobile layout ─────────────────────────────────────────────────────────
  if (isMobile) {
    const secHead = (label: string) => (
      <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 10, fontFamily: MFF }}>
        {label}
      </div>
    );
    const fieldLbl = (t: string) => <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: MFF, marginBottom: 6 }}>{t}</div>;
    const inp: React.CSSProperties = { width: "100%", boxSizing: "border-box" as const, height: 48, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 16, padding: "0 14px", fontFamily: MFF, color: "#1A1917", outline: "none", background: "#FFF" };

    return (
      <div style={{ minHeight: "100vh", background: "#F7F6F3", fontFamily: MFF, paddingBottom: 90 }}>

        {/* Sticky header */}
        <div style={{ position: "sticky", top: 0, zIndex: 30, background: "#FFF", borderBottom: "1px solid #E5E2DC", padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => navigate("/quotes")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, color: "#6B6860", fontSize: 14, fontFamily: MFF, padding: 0 }}>
            <ArrowLeft size={18} /> Back
          </button>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: MFF }}>{isEdit ? "Edit Quote" : "New Quote"}</span>
        </div>

        <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 24 }}>

          {/* ── Client ─────────────────────────────────────────────────── */}
          <div>
            {secHead("Client")}

            {/* Selected client summary */}
            {selectedClient ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", border: "2px solid var(--brand)", borderRadius: 10, background: "#EFF6FF" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: MFF }}>{selectedClient.first_name} {selectedClient.last_name}</div>
                  {selectedClient.email && <div style={{ fontSize: 12, color: "#6B6860", fontFamily: MFF }}>{selectedClient.email}</div>}
                </div>
                <button onClick={() => { setSelectedClientId(null); setMobileClientSearch(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#6B6860", padding: 4 }}>
                  <X size={18} />
                </button>
              </div>
            ) : (
              <div style={{ position: "relative" }}>
                <input
                  value={mobileClientSearch}
                  onChange={e => { setMobileClientSearch(e.target.value); setMobileClientDropdown(true); }}
                  onFocus={() => setMobileClientDropdown(true)}
                  placeholder="Search clients by name or email..."
                  style={inp}
                />
                {mobileClientDropdown && (
                  <div style={{ position: "absolute", top: 50, left: 0, right: 0, background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 20, maxHeight: 260, overflowY: "auto" }}>
                    <div
                      onClick={() => { setSelectedClientId(null); setMobileClientDropdown(false); setMobileClientSearch(""); }}
                      style={{ padding: "12px 14px", borderBottom: "1px solid #F0EEE9", cursor: "pointer", fontSize: 13, color: "#6B6860", fontFamily: MFF }}
                    >
                      — Enter lead info instead
                    </div>
                    {mobileFilteredClients.map(c => (
                      <div
                        key={c.id}
                        onClick={() => { setSelectedClientId(c.id); setAddress(c.address || ""); setMobileClientDropdown(false); setMobileClientSearch(""); }}
                        style={{ padding: "12px 14px", borderBottom: "1px solid #F0EEE9", cursor: "pointer" }}
                      >
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#1A1917", fontFamily: MFF }}>{c.first_name} {c.last_name}</div>
                        <div style={{ fontSize: 12, color: "#9E9B94", fontFamily: MFF }}>{c.email}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Lead fields when no client selected */}
            {!selectedClientId && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  {fieldLbl("Lead Name")}
                  <input value={leadName} onChange={e => setLeadName(e.target.value)} placeholder="Jane Doe" style={inp} />
                </div>
                <div>
                  {fieldLbl("Email")}
                  <input value={leadEmail} onChange={e => setLeadEmail(e.target.value)} placeholder="jane@example.com" type="email" style={inp} />
                </div>
                <div>
                  {fieldLbl("Phone")}
                  <input value={leadPhone} onChange={e => setLeadPhone(e.target.value)} placeholder="(555) 000-0000" type="tel" style={inp} />
                </div>
                <div>
                  {fieldLbl("Service Address")}
                  <input value={address} onChange={e => setAddress(e.target.value)} placeholder="123 Main St, City, State" style={inp} />
                </div>
              </div>
            )}
          </div>

          {/* ── Service (scope pill cards) ──────────────────────────────── */}
          <div>
            {secHead("Service")}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {scopes.map(s => (
                <button
                  key={s.id}
                  onClick={() => { setScopeId(s.id); setFrequencyStr(""); setSelectedAddonIds([]); setHoursInput(0); }}
                  style={{
                    padding: "14px 10px", border: `2px solid ${scopeId === s.id ? "var(--brand)" : "#E5E2DC"}`,
                    borderRadius: 10, background: scopeId === s.id ? "#EFF6FF" : "#FFF",
                    textAlign: "center" as const, cursor: "pointer", fontFamily: MFF, minHeight: 60,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: scopeId === s.id ? "var(--brand)" : "#1A1917", fontFamily: MFF, lineHeight: 1.3 }}>{s.name}</div>
                </button>
              ))}
            </div>
          </div>

          {/* ── Home Details (steppers) — appears after scope selected ─── */}
          {scopeId && (
            <div>
              {secHead("Home Details")}
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                {/* Square footage */}
                <div>
                  {fieldLbl(pricingMethod === "sqft" ? "Square Footage (required)" : "Square Footage")}
                  <input
                    type="number"
                    value={sqft || ""}
                    onChange={e => setSqft(parseInt(e.target.value) || 0)}
                    placeholder="e.g. 2000"
                    style={inp}
                  />
                </div>

                {/* Hours input for hourly/simplified scopes */}
                {(pricingMethod === "hourly" || pricingMethod === "simplified") && (
                  <div>
                    {fieldLbl("Estimated Hours")}
                    <input
                      type="number"
                      min="0.5"
                      step="0.5"
                      value={hoursInput || ""}
                      onChange={e => setHoursInput(parseFloat(e.target.value) || 0)}
                      placeholder="e.g. 3.0"
                      style={inp}
                    />
                  </div>
                )}

                <div>
                  {fieldLbl("Bedrooms")}
                  <Stepper value={bedrooms} onChange={setBedrooms} min={1} max={10} />
                </div>
                <div>
                  {fieldLbl("Full Bathrooms")}
                  <Stepper value={bathrooms} onChange={setBathrooms} min={1} max={8} />
                </div>
                <div>
                  {fieldLbl("Half Bathrooms")}
                  <Stepper value={halfBaths} onChange={setHalfBaths} min={0} max={4} />
                </div>
              </div>
            </div>
          )}

          {/* ── Frequency (pill row) — only if scope has frequencies ─── */}
          {scopeId && frequencies.length > 0 && (
            <div>
              {secHead("Frequency")}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {frequencies.map(freq => (
                  <button
                    key={freq.id}
                    onClick={() => setFrequencyStr(freq.frequency)}
                    style={{
                      height: 48, border: `2px solid ${frequencyStr === freq.frequency ? "var(--brand)" : "#E5E2DC"}`,
                      borderRadius: 10, background: frequencyStr === freq.frequency ? "#EFF6FF" : "#FFF",
                      color: frequencyStr === freq.frequency ? "var(--brand)" : "#1A1917",
                      fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: MFF,
                    }}
                  >
                    {freq.label || freq.frequency}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Add-ons (full-width checkbox cards, 56px min height) ─── */}
          {scopeId && mobileActiveAddons.length > 0 && (
            <div>
              {secHead("Add-ons")}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {mobileActiveAddons.map(addon => {
                  const isSelected = selectedAddonIds.includes(addon.id);
                  const fromResult = calcResult?.addon_breakdown.find(b => b.id === addon.id);
                  const priceText = fromResult
                    ? (fromResult.amount < 0 ? `-$${Math.abs(fromResult.amount).toFixed(2)}` : `+$${fromResult.amount.toFixed(2)}`)
                    : addonDisplayPrice(addon);
                  return (
                    <label
                      key={addon.id}
                      style={{
                        display: "flex", alignItems: "center", gap: 14, minHeight: 56,
                        border: `2px solid ${isSelected ? "var(--brand)" : "#E5E2DC"}`,
                        borderRadius: 10, padding: "10px 14px", cursor: "pointer",
                        background: isSelected ? "#EFF6FF" : "#FFF",
                      }}
                    >
                      <Checkbox checked={isSelected} onCheckedChange={() => toggleAddon(addon.id)} className="shrink-0" />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#1A1917", fontFamily: MFF }}>{addon.name}</div>
                        <div style={{ fontSize: 12, color: "#9E9B94", fontFamily: MFF }}>{priceText}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Discount Code ───────────────────────────────────────────── */}
          <div>
            {secHead("Discount Code")}
            <div style={{ display: "flex", gap: 10 }}>
              <input
                value={discountInput}
                onChange={e => { setDiscountInput(e.target.value.toUpperCase()); setDiscountError(""); }}
                placeholder="e.g. MANAGER50"
                style={{ ...inp, flex: 1 }}
              />
              <button
                onClick={() => runCalculate({ withCode: discountInput.trim() })}
                disabled={!discountInput.trim() || calcLoading}
                style={{ height: 48, padding: "0 20px", border: "1px solid #E5E2DC", borderRadius: 8, background: "#FFF", fontSize: 14, fontWeight: 600, color: "#1A1917", cursor: "pointer", fontFamily: MFF, flexShrink: 0 }}
              >
                Apply
              </button>
            </div>
            {discountError && <div style={{ fontSize: 12, color: "#DC2626", marginTop: 6, fontFamily: MFF }}>{discountError}</div>}
            {discountCode && calcResult && calcResult.discount_amount > 0 && (
              <div style={{ fontSize: 12, color: "#16A34A", marginTop: 6, fontFamily: MFF }}>Code applied — -${calcResult.discount_amount.toFixed(2)}</div>
            )}
          </div>

          {/* ── Internal Notes (collapsible) ────────────────────────────── */}
          <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
            <button
              onClick={() => setMobileNotesOpen(v => !v)}
              style={{ width: "100%", padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", cursor: "pointer", fontFamily: MFF }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: "#1A1917" }}>Internal Notes</span>
              {mobileNotesOpen ? <ChevronDown size={16} color="#6B6860" style={{ transform: "rotate(180deg)" }} /> : <ChevronDown size={16} color="#6B6860" />}
            </button>
            {mobileNotesOpen && (
              <div style={{ padding: "0 16px 16px" }}>
                <textarea
                  value={internalMemo}
                  onChange={e => setInternalMemo(e.target.value)}
                  placeholder="Add notes for the office — not shown to client"
                  rows={4}
                  style={{ width: "100%", boxSizing: "border-box" as const, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 14, padding: "10px 12px", fontFamily: MFF, color: "#1A1917", resize: "vertical" as const, outline: "none" }}
                />
              </div>
            )}
          </div>

        </div>

        {/* ── Sticky bottom price bar ──────────────────────────────────── */}
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#FFF", borderTop: "1px solid #E5E2DC", padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, zIndex: 40, boxShadow: "0 -2px 12px rgba(0,0,0,0.07)" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#6B6860", fontFamily: MFF }}>Estimated Total</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#1A1917", fontFamily: MFF }}>
              {calcLoading ? "..." : calcResult ? `$${calcResult.final_total.toFixed(2)}` : "—"}
            </div>
          </div>
          <button
            onClick={() => save("draft")}
            disabled={saving || !scopeId}
            style={{
              height: 48, padding: "0 24px", background: saving || !scopeId ? "#D1D5DB" : "var(--brand)",
              color: "#FFF", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700,
              cursor: saving || !scopeId ? "not-allowed" : "pointer", fontFamily: MFF, flexShrink: 0,
            }}
          >
            {saving ? "Saving..." : "Save Quote"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      {/* Header */}
      <div className="border-b border-[#E5E2DC] bg-white px-6 py-4 flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/quotes")} className="gap-1.5 text-[#6B7280]">
          <ArrowLeft className="w-4 h-4" />
          Back to Quotes
        </Button>
        <div className="h-5 w-px bg-[#E5E2DC]" />
        <h1 className="text-lg font-semibold text-[#1A1917]">{isEdit ? "Edit Quote" : "New Quote"}</h1>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => save("draft")} disabled={saving} className="gap-1.5">
            <Save className="w-4 h-4" />
            Save Draft
          </Button>
          <Button size="sm" onClick={() => save("sent")} disabled={saving} className="bg-[#00C9A0] hover:bg-[#00b890] text-white gap-1.5">
            <SendHorizonal className="w-4 h-4" />
            Save & Send
          </Button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6 flex gap-6">
        {/* ── Main Wizard ─────────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Section tabs */}
          <div className="flex gap-2 mb-2">
            {SECTION_LABELS.map((label, i) => {
              const Icon = SECTION_ICONS[i];
              return (
                <button
                  key={i}
                  onClick={() => setActiveSection(i)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                    activeSection === i
                      ? "bg-[#00C9A0] text-white"
                      : "bg-white border border-[#E5E2DC] text-[#6B7280] hover:bg-[#F7F6F3]"
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                  {sectionComplete[i] && activeSection !== i && (
                    <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                  )}
                </button>
              );
            })}
          </div>

          {/* ── Section 0: Customer Info ───────────────────────────────────── */}
          {activeSection === 0 && (
            <SectionCard title="Customer Info">
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-[#9E9B94] mb-1 block">Existing Client</Label>
                  <Popover open={clientOpen} onOpenChange={setClientOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" role="combobox" className="w-full justify-between text-sm font-normal">
                        {selectedClient
                          ? `${selectedClient.first_name} ${selectedClient.last_name}`
                          : "Search clients..."}
                        <ChevronDown className="w-4 h-4 ml-2 text-[#9E9B94]" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[400px] p-0">
                      <Command>
                        <CommandInput placeholder="Search by name or email..." />
                        <CommandList>
                          <CommandEmpty>No clients found.</CommandEmpty>
                          <CommandGroup>
                            <CommandItem value="lead" onSelect={() => { setSelectedClientId(null); setClientOpen(false); }}>
                              — Enter lead info instead
                            </CommandItem>
                            {clients.map(c => (
                              <CommandItem
                                key={c.id}
                                value={`${c.first_name} ${c.last_name} ${c.email}`}
                                onSelect={() => {
                                  setSelectedClientId(c.id);
                                  setAddress(c.address || "");
                                  setClientOpen(false);
                                }}
                              >
                                <div>
                                  <p className="text-sm font-medium">{c.first_name} {c.last_name}</p>
                                  <p className="text-xs text-[#9E9B94]">{c.email}</p>
                                </div>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                {!selectedClientId && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <Label className="text-xs">Lead Name</Label>
                      <Input value={leadName} onChange={e => setLeadName(e.target.value)} placeholder="Jane Doe" className="mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Email</Label>
                      <Input value={leadEmail} onChange={e => setLeadEmail(e.target.value)} placeholder="jane@example.com" type="email" className="mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Phone</Label>
                      <Input value={leadPhone} onChange={e => setLeadPhone(e.target.value)} placeholder="(555) 000-0000" className="mt-1" />
                    </div>
                  </div>
                )}

                <div className="flex gap-3">
                  <div className="flex-1">
                    <Label className="text-xs">Service Address</Label>
                    <Input value={address} onChange={e => setAddress(e.target.value)} placeholder="123 Main St, City, State" className="mt-1" />
                  </div>
                  <div style={{ width: 110 }}>
                    <Label className="text-xs">Zip Code</Label>
                    <Input value={zipCode} onChange={e => setZipCode(e.target.value)} onBlur={e => checkZip(e.target.value)} placeholder="60453" maxLength={5} className="mt-1" />
                  </div>
                </div>

                {checkingZip && <div className="text-xs text-[#9E9B94] px-1">Checking service area...</div>}
                {!checkingZip && zipZone && zipZone !== "uncovered" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, backgroundColor: `${zipZone.color}14`, border: `1px solid ${zipZone.color}44`, fontSize: 12, fontWeight: 600, color: zipZone.color }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: zipZone.color, flexShrink: 0 }} />
                    This address is in {zipZone.name} — covered service zone.
                  </div>
                )}
                {!checkingZip && zipZone === "uncovered" && zipCode.trim().length === 5 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, backgroundColor: "#FEF3C7", border: "1px solid #FDE68A", fontSize: 12, fontWeight: 600, color: "#92400E" }}>
                    This zip code is outside current service zones. You may still create the quote.
                  </div>
                )}

                <div className="flex justify-end">
                  <Button size="sm" className="bg-[#00C9A0] hover:bg-[#00b890] text-white gap-1.5" onClick={() => setActiveSection(1)}>
                    Next: Property Details <ArrowRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </SectionCard>
          )}

          {/* ── Section 1: Property Details ────────────────────────────────── */}
          {activeSection === 1 && (
            <SectionCard title="Property Details">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs">Square Footage</Label>
                  <p className="text-[10px] text-[#9E9B94] mb-1">
                    {pricingMethod === "sqft" ? "Required for pricing" : "Optional for reference"}
                  </p>
                  <Input
                    type="number"
                    value={sqft || ""}
                    onChange={e => setSqft(parseInt(e.target.value) || 0)}
                    placeholder="e.g. 1800"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Bedrooms</Label>
                  <Select value={String(bedrooms)} onValueChange={v => setBedrooms(parseInt(v))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[1,2,3,4,5,6,7,8].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Full Bathrooms</Label>
                  <Select value={String(bathrooms)} onValueChange={v => setBathrooms(parseInt(v))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[1,2,3,4,5,6].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Half Bathrooms</Label>
                  <Select value={String(halfBaths)} onValueChange={v => setHalfBaths(parseInt(v))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[0,1,2,3].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Pets</Label>
                  <Select value={String(pets)} onValueChange={v => setPets(parseInt(v))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[0,1,2,3,4].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Dirt Level</Label>
                  <Select value={dirtLevel} onValueChange={setDirtLevel}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DIRT_LEVELS.map(d => <SelectItem key={d.value} value={d.value}>{d.label.split(" — ")[0]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-[#9E9B94] mt-1">{DIRT_LEVELS.find(d => d.value === dirtLevel)?.label.split(" — ")[1]}</p>
                </div>
              </div>
              <div className="flex justify-between mt-4">
                <Button size="sm" variant="ghost" onClick={() => setActiveSection(0)}>Back</Button>
                <Button size="sm" className="bg-[#00C9A0] hover:bg-[#00b890] text-white gap-1.5" onClick={() => setActiveSection(2)}>
                  Next: Service & Pricing <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </SectionCard>
          )}

          {/* ── Section 2: Service & Pricing ──────────────────────────────── */}
          {activeSection === 2 && (
            <SectionCard title="Service & Pricing">
              <div className="space-y-5">

                {/* Scope selector */}
                <div>
                  <Label className="text-xs">Service Scope</Label>
                  <Select
                    value={scopeId ? String(scopeId) : ""}
                    onValueChange={v => {
                      setScopeId(parseInt(v));
                      setFrequencyStr("");
                      setSelectedAddonIds([]);
                      setHoursInput(0);
                    }}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select a service..." />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(scopeGroups).map(([group, groupScopes]) => (
                        <div key={group}>
                          <div className="px-2 py-1 text-[10px] font-semibold text-[#9E9B94] uppercase tracking-wider">{group}</div>
                          {groupScopes.map(s => (
                            <SelectItem key={s.id} value={String(s.id)}>
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{s.name}</span>
                                <span className="text-[#9E9B94] text-xs">
                                  ${parseFloat(s.hourly_rate).toFixed(0)}/hr · min ${parseFloat(s.minimum_bill).toFixed(0)} · {pricingMethodLabel(s.pricing_method)}
                                </span>
                              </div>
                            </SelectItem>
                          ))}
                        </div>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Pricing method context */}
                {selectedScope && (
                  <div className="flex items-center gap-2 text-xs text-[#6B7280]">
                    {pricingMethod === "sqft" && <Ruler className="w-3.5 h-3.5" />}
                    {(pricingMethod === "hourly" || pricingMethod === "simplified") && <Clock className="w-3.5 h-3.5" />}
                    <span>
                      {pricingMethod === "sqft" && "Sq ft-based pricing — hours looked up from tier table"}
                      {pricingMethod === "hourly" && "Hourly pricing — enter hours below"}
                      {pricingMethod === "simplified" && "Simplified hourly pricing — enter hours below"}
                    </span>
                  </div>
                )}

                {/* Sqft scope: remind user to enter sqft */}
                {scopeId && pricingMethod === "sqft" && sqft === 0 && (
                  <div className="bg-[#FEF3C7] border border-[#FDE68A] rounded-lg px-4 py-3 text-sm text-[#92400E] flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    Enter square footage in Property Details to calculate pricing.
                  </div>
                )}

                {/* Hourly / Simplified: hours input */}
                {scopeId && (pricingMethod === "hourly" || pricingMethod === "simplified") && (
                  <div>
                    <Label className="text-xs">Estimated Hours</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <Input
                        type="number"
                        min="0.5"
                        step="0.5"
                        value={hoursInput || ""}
                        onChange={e => setHoursInput(parseFloat(e.target.value) || 0)}
                        placeholder="e.g. 3.0"
                        className="w-32"
                      />
                      <span className="text-sm text-[#6B7280]">hrs</span>
                      {hoursInput > 0 && frequencyStr && (
                        <span className="text-xs text-[#9E9B94]">
                          × ${effectiveHourlyRate().toFixed(2)}/hr
                        </span>
                      )}
                    </div>
                    {selectedScope && (
                      <p className="text-xs text-[#9E9B94] mt-1">
                        Minimum bill: ${parseFloat(selectedScope.minimum_bill).toFixed(2)}
                      </p>
                    )}
                  </div>
                )}

                {/* Frequency selector */}
                {frequencies.length > 0 && (
                  <div>
                    <Label className="text-xs mb-2 block">Frequency</Label>
                    <div className="grid grid-cols-2 gap-2">
                      {frequencies.map(freq => {
                        const rate = freq.rate_override
                          ? parseFloat(freq.rate_override)
                          : selectedScope
                            ? parseFloat(selectedScope.hourly_rate) * parseFloat(freq.multiplier)
                            : null;
                        return (
                          <button
                            key={freq.id}
                            onClick={() => setFrequencyStr(freq.frequency)}
                            className={cn(
                              "px-3 py-2.5 rounded-lg border text-left transition-colors",
                              frequencyStr === freq.frequency
                                ? "bg-[#00C9A0]/10 border-[#00C9A0] text-[#00C9A0]"
                                : "bg-white border-[#E5E2DC] text-[#6B7280] hover:bg-[#F7F6F3]"
                            )}
                          >
                            <p className="font-semibold text-sm">{freq.label || freq.frequency}</p>
                            {rate !== null && (
                              <p className="text-xs text-[#9E9B94]">${rate.toFixed(2)}/hr</p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {frequencies.length === 0 && scopeId && (
                  <div className="text-xs text-[#9E9B94] italic">
                    No frequencies configured for this scope. Pricing will use the base hourly rate.
                  </div>
                )}

                <div className="flex justify-between mt-4">
                  <Button size="sm" variant="ghost" onClick={() => setActiveSection(1)}>Back</Button>
                  <Button size="sm" className="bg-[#00C9A0] hover:bg-[#00b890] text-white gap-1.5" onClick={() => setActiveSection(3)}>
                    Next: Add-ons <ArrowRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </SectionCard>
          )}

          {/* ── Section 3: Add-ons & Notes ─────────────────────────────────── */}
          {activeSection === 3 && (
            <SectionCard title="Add-ons & Notes">
              <div className="space-y-4">
                {scopeAddons.filter(a => a.is_active && a.show_office !== false).length > 0 && (() => {
                  const activeAddons = scopeAddons.filter(a => a.is_active && a.show_office !== false);
                  const grouped: Record<string, PricingAddon[]> = {};
                  for (const a of activeAddons) {
                    const g = a.addon_type || "cleaning_extras";
                    if (!grouped[g]) grouped[g] = [];
                    grouped[g].push(a);
                  }
                  const groupOrder = ["cleaning_extras", "other"];
                  const groupLabels: Record<string, string> = {
                    cleaning_extras: "Cleaning Extras",
                    other: "Discounts & Adjustments",
                  };
                  return (
                    <div className="space-y-5">
                      {[...groupOrder, ...Object.keys(grouped).filter(k => !groupOrder.includes(k))].filter(k => grouped[k]?.length).map(groupKey => (
                        <div key={groupKey}>
                          <Label className="text-xs mb-2 block">{groupLabels[groupKey] ?? groupKey}</Label>
                          <div className="grid grid-cols-2 gap-2">
                            {grouped[groupKey].map(addon => {
                              const isManualAdj = addon.price_type === "manual_adj";
                              const isTimeOnly = addon.price_type === "time_only";
                              const isSelected = selectedAddonIds.includes(addon.id);
                              const fromResult = calcResult?.addon_breakdown.find(b => b.id === addon.id);

                              if (isManualAdj) {
                                return (
                                  <div key={addon.id} className="col-span-2 flex items-center gap-3 p-3 rounded-lg border border-[#E5E2DC] bg-[#FAFAF9]">
                                    <div className="flex-1">
                                      <p className="text-sm font-medium text-[#1A1917]">{addon.name}</p>
                                      <p className="text-xs text-[#9E9B94]">Manual adjustment — office only</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm text-[#6B7280]">$</span>
                                      <Input
                                        type="number"
                                        step="0.01"
                                        value={manualAdjValue}
                                        onChange={e => setManualAdjValue(e.target.value)}
                                        placeholder="0.00"
                                        className="w-28 h-8 text-sm"
                                      />
                                    </div>
                                  </div>
                                );
                              }

                              if (isTimeOnly) {
                                return (
                                  <label
                                    key={addon.id}
                                    className={cn(
                                      "flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors",
                                      isSelected ? "bg-[#00C9A0]/10 border-[#00C9A0]" : "bg-white border-[#E5E2DC] hover:bg-[#F7F6F3]"
                                    )}
                                  >
                                    <Checkbox checked={isSelected} onCheckedChange={() => toggleAddon(addon.id)} className="mt-0.5" />
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium text-[#1A1917]">{addon.name}</p>
                                      <p className="text-xs text-[#9E9B94]">
                                        No additional charge
                                        {addon.time_add_minutes > 0 ? ` · +${addon.time_add_minutes}min` : ""}
                                      </p>
                                    </div>
                                  </label>
                                );
                              }

                              return (
                                <label
                                  key={addon.id}
                                  className={cn(
                                    "flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors",
                                    isSelected ? "bg-[#00C9A0]/10 border-[#00C9A0]" : "bg-white border-[#E5E2DC] hover:bg-[#F7F6F3]"
                                  )}
                                >
                                  <Checkbox checked={isSelected} onCheckedChange={() => toggleAddon(addon.id)} className="mt-0.5" />
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium text-[#1A1917]">{addon.name}</p>
                                    <p className={cn("text-xs", fromResult && fromResult.amount < 0 ? "text-red-500" : "text-[#9E9B94]")}>
                                      {fromResult
                                        ? (fromResult.amount < 0 ? `-$${Math.abs(fromResult.amount).toFixed(2)}` : `$${fromResult.amount.toFixed(2)}`)
                                        : addonDisplayPrice(addon)}
                                      {addon.time_add_minutes > 0 ? ` · +${addon.time_add_minutes}min` : ""}
                                    </p>
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Discount code */}
                <div>
                  <Label className="text-xs mb-1 block">Discount Code</Label>
                  <div className="flex gap-2">
                    <Input
                      value={discountInput}
                      onChange={e => { setDiscountInput(e.target.value.toUpperCase()); setDiscountError(""); }}
                      placeholder="e.g. MANAGER50"
                      className="flex-1"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runCalculate({ withCode: discountInput.trim() })}
                      disabled={!discountInput.trim() || calcLoading}
                    >
                      Apply
                    </Button>
                  </div>
                  {discountError && (
                    <div className="flex items-center gap-1.5 mt-1 text-xs text-red-600">
                      <AlertCircle className="w-3.5 h-3.5" /> {discountError}
                    </div>
                  )}
                  {discountCode && calcResult && calcResult.discount_amount > 0 && (
                    <div className="flex items-center gap-1.5 mt-1 text-xs text-green-600">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Code applied: -{`$${calcResult.discount_amount.toFixed(2)}`}
                    </div>
                  )}
                </div>

                <div>
                  <Label className="text-xs">Client-Facing Notes</Label>
                  <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes visible to the client..." rows={3} className="mt-1 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Internal Memo</Label>
                  <Textarea value={internalMemo} onChange={e => setInternalMemo(e.target.value)} placeholder="Internal notes not visible to the client..." rows={2} className="mt-1 text-sm" />
                </div>

                <div className="flex justify-between mt-2">
                  <Button size="sm" variant="ghost" onClick={() => setActiveSection(2)}>Back</Button>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => save("draft")} disabled={saving} className="gap-1.5">
                      <Save className="w-3.5 h-3.5" /> Save Draft
                    </Button>
                    <Button size="sm" onClick={() => save("sent")} disabled={saving} className="bg-[#00C9A0] hover:bg-[#00b890] text-white gap-1.5">
                      <SendHorizonal className="w-3.5 h-3.5" /> Send Quote
                    </Button>
                  </div>
                </div>
              </div>
            </SectionCard>
          )}
        </div>

        {/* ── Live Price Panel ─────────────────────────────────────────────── */}
        <div className="w-72 shrink-0">
          <div className="bg-white border border-[#E5E2DC] rounded-lg p-4 space-y-4 sticky top-6">
            <h3 className="font-semibold text-[#1A1917] text-sm border-b border-[#E5E2DC] pb-3">Price Preview</h3>

            {calcLoading && (
              <div className="py-4 text-center text-xs text-[#9E9B94]">Calculating...</div>
            )}

            {!calcLoading && calcResult ? (
              <>
                {/* Scope + frequency summary */}
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Scope</span>
                    <span className="text-right text-[#1A1917] font-medium text-xs max-w-[140px] truncate">{selectedScope?.name}</span>
                  </div>
                  {calcResult.frequency && (
                    <div className="flex justify-between text-[#6B7280]">
                      <span>Frequency</span>
                      <span className="text-[#1A1917]">{calcResult.frequency}</span>
                    </div>
                  )}

                  {/* Sqft method: show sqft → hours line */}
                  {calcResult.pricing_method === "sqft" && calcResult.sqft && (
                    <div className="flex justify-between text-[#6B7280]">
                      <span>Sq Ft</span>
                      <span className="text-[#1A1917]">{calcResult.sqft.toLocaleString()}</span>
                    </div>
                  )}

                  {/* Hours line (all methods) */}
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Est. Hours</span>
                    <span className="text-[#1A1917]">{calcResult.base_hours.toFixed(1)}h</span>
                  </div>

                  <div className="flex justify-between text-[#6B7280]">
                    <span>Hourly Rate</span>
                    <span className="text-[#1A1917]">${calcResult.hourly_rate.toFixed(2)}/hr</span>
                  </div>

                  {/* Calculation line */}
                  <div className="bg-[#F7F6F3] rounded px-2 py-1.5 text-xs text-[#6B7280] font-mono">
                    {calcResult.base_hours.toFixed(1)}h × ${calcResult.hourly_rate.toFixed(2)}/hr = ${(calcResult.base_hours * calcResult.hourly_rate).toFixed(2)}
                  </div>
                </div>

                {/* Price breakdown */}
                <div className="border-t border-[#E5E2DC] pt-3 space-y-1.5 text-sm">
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Base Price</span>
                    <span className="text-[#1A1917]">${calcResult.base_price.toFixed(2)}</span>
                  </div>

                  {calcResult.minimum_applied && (
                    <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      Minimum bill of ${calcResult.minimum_bill.toFixed(2)} applied
                    </div>
                  )}

                  {calcResult.addon_breakdown.map(a => (
                    <div key={a.id} className="flex justify-between text-[#6B7280]">
                      <span className="truncate max-w-[150px]">{a.name}</span>
                      <span className={a.amount < 0 ? "text-red-500 font-medium" : "text-[#1A1917]"}>
                        {a.amount < 0 ? `-$${Math.abs(a.amount).toFixed(2)}` : `+$${a.amount.toFixed(2)}`}
                      </span>
                    </div>
                  ))}

                  {calcResult.addons_total > 0 && (
                    <div className="flex justify-between text-[#6B7280]">
                      <span>Add-ons Total</span>
                      <span className="text-[#1A1917]">+${calcResult.addons_total.toFixed(2)}</span>
                    </div>
                  )}

                  <div className="flex justify-between text-[#6B7280]">
                    <span>Subtotal</span>
                    <span className="text-[#1A1917]">${calcResult.subtotal.toFixed(2)}</span>
                  </div>

                  {calcResult.discount_amount > 0 && (
                    <div className="flex justify-between text-green-600">
                      <span>Discount{discountCode ? ` (${discountCode})` : ""}</span>
                      <span>-${calcResult.discount_amount.toFixed(2)}</span>
                    </div>
                  )}
                </div>

                {/* Total */}
                <div className="border-t border-[#E5E2DC] pt-3">
                  <div className="flex justify-between items-baseline">
                    <span className="text-[#6B7280] text-sm">Total</span>
                    <span className="text-2xl font-bold text-[#1A1917]">${calcResult.final_total.toFixed(2)}</span>
                  </div>
                </div>
              </>
            ) : !calcLoading && !selectedScope ? (
              <div className="py-6 text-center text-[#9E9B94] text-sm">
                Select a scope to see pricing.
              </div>
            ) : !calcLoading && pricingMethod === "sqft" && (!sqft || sqft === 0) ? (
              <div className="py-6 text-center text-[#9E9B94] text-sm">
                Enter square footage to calculate price.
              </div>
            ) : !calcLoading && (pricingMethod === "hourly" || pricingMethod === "simplified") && (!hoursInput || hoursInput <= 0) ? (
              <div className="py-6 text-center text-[#9E9B94] text-sm">
                Enter estimated hours to calculate price.
              </div>
            ) : null}

            {/* Action buttons */}
            <div className="border-t border-[#E5E2DC] pt-3 space-y-2">
              <Button
                className="w-full bg-[#00C9A0] hover:bg-[#00b890] text-white gap-1.5"
                size="sm"
                onClick={() => save("sent")}
                disabled={saving || !scopeId}
              >
                <SendHorizonal className="w-3.5 h-3.5" />
                Save & Send Quote
              </Button>
              <Button
                className="w-full bg-[#1A1917] hover:bg-[#333] text-white gap-1.5"
                size="sm"
                onClick={() => save("draft", true)}
                disabled={saving || !scopeId}
              >
                <ArrowRight className="w-3.5 h-3.5" />
                Save & Convert to Job
              </Button>
              <Button className="w-full" variant="outline" size="sm" onClick={() => save("draft")} disabled={saving}>
                <Save className="w-3.5 h-3.5 mr-1.5" />
                Save Draft
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[#E5E2DC] rounded-lg p-5">
      <h2 className="text-sm font-semibold text-[#1A1917] mb-4">{title}</h2>
      {children}
    </div>
  );
}

function Stepper({ value, onChange, min = 0, max = 10 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  const FF = "'Plus Jakarta Sans', sans-serif";
  const btn = (disabled: boolean): React.CSSProperties => ({
    width: 48, height: 48, border: "1px solid #E5E2DC", borderRadius: 0, background: disabled ? "#F7F6F3" : "#FFF",
    color: disabled ? "#D1D5DB" : "#1A1917", fontSize: 20, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center",
  });
  return (
    <div style={{ display: "flex", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden", height: 48 }}>
      <button style={btn(value <= min)} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF, borderLeft: "1px solid #E5E2DC", borderRight: "1px solid #E5E2DC" }}>
        {value}
      </div>
      <button style={btn(value >= max)} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );
}
