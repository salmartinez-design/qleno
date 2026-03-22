import { useState, useEffect, useRef, useCallback } from "react";
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
import { ArrowLeft, Save, SendHorizonal, ArrowRight, ChevronDown, User, Home, Calculator, PlusSquare, AlertCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
async function apiFetch(path: string, opts: { method?: string; body?: any; headers?: any } = {}) {
  const { body, headers: extraHeaders, ...rest } = opts;
  const r = await fetch(`${API}${path}`, { headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...extraHeaders }, ...rest, ...(body !== undefined && { body: JSON.stringify(body) }) });
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
  hourly_rate: string;
  minimum_bill: string;
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
  sort_order: number;
}

interface PricingAddon {
  id: number;
  scope_id: number;
  name: string;
  price_type: string;
  price: string | null;
  percent_of_base: string | null;
  time_add_minutes: number;
  is_active: boolean;
}

interface CalcResult {
  scope_id: number;
  scope_name: string;
  sqft: number;
  frequency: string;
  base_hours: number;
  hourly_rate: number;
  base_price: number;
  minimum_applied: boolean;
  addons_total: number;
  addon_breakdown: Array<{ id: number; name: string; amount: number }>;
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

const DIRT_MULTIPLIERS: Record<string, number> = { pristine: 0.9, standard: 1.0, heavy: 1.15 };

const SECTION_ICONS = [User, Home, Calculator, PlusSquare];
const SECTION_LABELS = ["Customer Info", "Property Details", "Service & Pricing", "Add-ons & Notes"];

export default function QuoteBuilderPage() {
  const [matchEdit, editParams] = useRoute("/quotes/:id/edit"); const id = editParams?.id;
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const isEdit = Boolean(id && id !== "new");

  const [activeSection, setActiveSection] = useState(0);
  const [saving, setSaving] = useState(false);

  const [clientOpen, setClientOpen] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [leadName, setLeadName] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadPhone, setLeadPhone] = useState("");
  const [address, setAddress] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [zipZone, setZipZone] = useState<{ name: string; color: string } | null | "uncovered">("uncovered" as const);
  const [checkingZip, setCheckingZip] = useState(false);

  const [scopeId, setScopeId] = useState<number | null>(null);
  const [frequencyStr, setFrequencyStr] = useState<string>("");
  const [sqft, setSqft] = useState<number>(0);
  const [bedrooms, setBedrooms] = useState<number>(2);
  const [bathrooms, setBathrooms] = useState<number>(1);
  const [halfBaths, setHalfBaths] = useState<number>(0);
  const [pets, setPets] = useState<number>(0);
  const [dirtLevel, setDirtLevel] = useState("standard");
  const [selectedAddonIds, setSelectedAddonIds] = useState<number[]>([]);
  const [discountCode, setDiscountCode] = useState("");
  const [discountInput, setDiscountInput] = useState("");
  const [notes, setNotes] = useState("");
  const [internalMemo, setInternalMemo] = useState("");

  const [calcResult, setCalcResult] = useState<CalcResult | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);
  const [discountError, setDiscountError] = useState("");

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Data queries ────────────────────────────────────────────────────────────

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["clients-list"],
    queryFn: () => apiFetch("/api/clients?limit=200").then((r: any) => r.data ?? r),
  });

  const { data: scopes = [] } = useQuery<PricingScope[]>({
    queryKey: ["pricing-scopes"],
    queryFn: () => apiFetch("/api/pricing/scopes"),
  });

  const { data: frequencies = [] } = useQuery<PricingFrequency[]>({
    queryKey: ["pricing-frequencies", scopeId],
    queryFn: () => apiFetch(`/api/pricing/scopes/${scopeId}/frequencies`),
    enabled: Boolean(scopeId),
  });

  const { data: scopeAddons = [] } = useQuery<PricingAddon[]>({
    queryKey: ["pricing-addons", scopeId],
    queryFn: () => apiFetch(`/api/pricing/scopes/${scopeId}/addons`),
    enabled: Boolean(scopeId),
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
      if (Array.isArray(existingQuote.addons)) {
        const ids = existingQuote.addons.map((a: any) => a.id).filter(Boolean);
        setSelectedAddonIds(ids);
      }
    }
  }, [existingQuote]);

  // ── Auto-default frequency when scope changes ────────────────────────────────

  useEffect(() => {
    if (scopeId && frequencies.length > 0 && !frequencyStr) {
      const oneTime = frequencies.find(f => f.frequency.toLowerCase().includes("one") || f.frequency.toLowerCase().includes("single"));
      setFrequencyStr(oneTime?.frequency ?? frequencies[0].frequency);
    }
    if (scopeId) setSelectedAddonIds([]);
  }, [scopeId, frequencies]);

  // ── Live price calculation (debounced 200ms) ─────────────────────────────────

  const runCalculate = useCallback(async (opts?: { withCode?: string }) => {
    if (!scopeId || !sqft || !frequencyStr) {
      setCalcResult(null);
      return;
    }
    setCalcLoading(true);
    try {
      const result = await apiFetch("/api/pricing/calculate", {
        method: "POST",
        body: {
          scope_id: scopeId,
          sqft,
          frequency: frequencyStr,
          addon_ids: selectedAddonIds,
          discount_code: opts?.withCode ?? discountCode,
        },
      });
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
    } catch { /* ignore */ }
    finally { setCalcLoading(false); }
  }, [scopeId, sqft, frequencyStr, selectedAddonIds, discountCode]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { runCalculate(); }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [scopeId, sqft, frequencyStr, selectedAddonIds]);

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
      estimated_hours: cr ? String(cr.base_hours) : null,
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
        toast.success(isEdit ? "Quote sent" : "Quote created and marked as sent. Configure Resend API to enable email.");
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
  const selectedScope = scopes.find(s => s.id === scopeId);

  function toggleAddon(id: number) {
    setSelectedAddonIds(prev =>
      prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]
    );
  }

  function addonDisplayPrice(addon: PricingAddon): string {
    if (addon.price_type === "flat" && addon.price != null) {
      return `$${parseFloat(addon.price).toFixed(2)}`;
    }
    if (addon.price_type === "percent" && addon.percent_of_base != null) {
      return `${addon.percent_of_base}% of base`;
    }
    return "";
  }

  const sectionComplete = [
    Boolean(selectedClientId || leadName || leadEmail),
    Boolean(sqft > 0),
    Boolean(scopeId && frequencyStr),
    true,
  ];

  // ── Group scopes by scope_group ──────────────────────────────────────────────
  const scopeGroups = scopes.filter(s => s.is_active).reduce<Record<string, PricingScope[]>>((acc, s) => {
    const g = s.scope_group || "Other";
    if (!acc[g]) acc[g] = [];
    acc[g].push(s);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
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
        <div className="flex-1 min-w-0 space-y-4">
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

          {activeSection === 0 && (
            <SectionCard title="Customer Info">
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-[#9E9B94] mb-1 block">Existing Client</Label>
                  <Popover open={clientOpen} onOpenChange={setClientOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        className="w-full justify-between text-sm font-normal"
                      >
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
                      <Input value={leadEmail} onChange={e => setLeadEmail(e.target.value)} placeholder="jane@example.com" className="mt-1" type="email" />
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

                {checkingZip && (
                  <div className="text-xs text-[#9E9B94] px-1">Checking service area...</div>
                )}
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

          {activeSection === 1 && (
            <SectionCard title="Property Details">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs">Square Footage</Label>
                  <Input type="number" value={sqft || ""} onChange={e => setSqft(parseInt(e.target.value) || 0)} placeholder="e.g. 1800" className="mt-1" />
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
                  <p className="text-xs text-[#9E9B94] mt-1">
                    {DIRT_LEVELS.find(d => d.value === dirtLevel)?.label.split(" — ")[1]}
                  </p>
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

          {activeSection === 2 && (
            <SectionCard title="Service & Pricing">
              <div className="space-y-5">
                <div>
                  <Label className="text-xs">Service Scope</Label>
                  <Select
                    value={scopeId ? String(scopeId) : ""}
                    onValueChange={v => { setScopeId(parseInt(v)); setFrequencyStr(""); setSelectedAddonIds([]); }}
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
                                  ${parseFloat(s.hourly_rate).toFixed(0)}/hr · min ${parseFloat(s.minimum_bill).toFixed(0)}
                                </span>
                              </div>
                            </SelectItem>
                          ))}
                        </div>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {scopeId && sqft === 0 && (
                  <div className="bg-[#FEF3C7] border border-[#FDE68A] rounded-lg px-4 py-3 text-sm text-[#92400E]">
                    Enter square footage in Property Details to calculate pricing.
                  </div>
                )}

                {frequencies.length > 0 && (
                  <div>
                    <Label className="text-xs mb-2 block">Frequency</Label>
                    <div className="grid grid-cols-2 gap-2">
                      {frequencies.map(freq => (
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
                          {freq.rate_override ? (
                            <p className="text-xs text-[#9E9B94]">${parseFloat(freq.rate_override).toFixed(0)}/hr</p>
                          ) : (
                            <p className="text-xs text-[#9E9B94]">×{parseFloat(freq.multiplier).toFixed(2)}</p>
                          )}
                        </button>
                      ))}
                    </div>
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

          {activeSection === 3 && (
            <SectionCard title="Add-ons & Notes">
              <div className="space-y-4">
                {scopeAddons.filter(a => a.is_active).length > 0 && (
                  <div>
                    <Label className="text-xs mb-2 block">Add-ons for {selectedScope?.name}</Label>
                    <div className="grid grid-cols-2 gap-2">
                      {scopeAddons.filter(a => a.is_active).map(addon => {
                        const isSelected = selectedAddonIds.includes(addon.id);
                        const fromResult = calcResult?.addon_breakdown.find(b => b.id === addon.id);
                        return (
                          <label
                            key={addon.id}
                            className={cn(
                              "flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors",
                              isSelected ? "bg-[#00C9A0]/10 border-[#00C9A0]" : "bg-white border-[#E5E2DC] hover:bg-[#F7F6F3]"
                            )}
                          >
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleAddon(addon.id)}
                              className="mt-0.5"
                            />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-[#1A1917]">{addon.name}</p>
                              <p className="text-xs text-[#9E9B94]">
                                {fromResult ? `$${fromResult.amount.toFixed(2)}` : addonDisplayPrice(addon)}
                                {addon.time_add_minutes > 0 ? ` · +${addon.time_add_minutes}min` : ""}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

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
                  <Textarea
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder="Notes visible to the client..."
                    rows={3}
                    className="mt-1 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Internal Memo</Label>
                  <Textarea
                    value={internalMemo}
                    onChange={e => setInternalMemo(e.target.value)}
                    placeholder="Internal notes not visible to the client..."
                    rows={2}
                    className="mt-1 text-sm"
                  />
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

        {/* ── Live Price Panel ──────────────────────────────────────────────── */}
        <div className="w-72 shrink-0">
          <div className="bg-white border border-[#E5E2DC] rounded-lg p-4 space-y-4 sticky top-6">
            <h3 className="font-semibold text-[#1A1917] text-sm border-b border-[#E5E2DC] pb-3">Price Preview</h3>

            {calcLoading && (
              <div className="py-4 text-center text-xs text-[#9E9B94]">Calculating...</div>
            )}

            {!calcLoading && calcResult ? (
              <>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Scope</span>
                    <span className="text-right text-[#1A1917] font-medium text-xs max-w-[140px] truncate">{calcResult.scope_name}</span>
                  </div>
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Frequency</span>
                    <span className="text-[#1A1917]">{calcResult.frequency}</span>
                  </div>
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Sq Ft</span>
                    <span className="text-[#1A1917]">{calcResult.sqft.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Est. Hours</span>
                    <span className="text-[#1A1917]">{calcResult.base_hours.toFixed(1)}h</span>
                  </div>
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Hourly Rate</span>
                    <span className="text-[#1A1917]">${calcResult.hourly_rate.toFixed(0)}/hr</span>
                  </div>
                </div>

                <div className="border-t border-[#E5E2DC] pt-3 space-y-1.5 text-sm">
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Base Price</span>
                    <span className="text-[#1A1917]">${calcResult.base_price.toFixed(2)}</span>
                  </div>
                  {calcResult.minimum_applied && (
                    <p className="text-xs text-amber-600">Minimum bill rate applied</p>
                  )}

                  {calcResult.addon_breakdown.map(a => (
                    <div key={a.id} className="flex justify-between text-[#6B7280]">
                      <span className="truncate max-w-[150px]">{a.name}</span>
                      <span className="text-[#1A1917]">+${a.amount.toFixed(2)}</span>
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

                <div className="border-t border-[#E5E2DC] pt-3">
                  <div className="flex justify-between items-baseline">
                    <span className="text-[#6B7280] text-sm">Total</span>
                    <span className="text-2xl font-bold text-[#1A1917]">
                      ${calcResult.final_total.toFixed(2)}
                    </span>
                  </div>
                </div>
              </>
            ) : !calcLoading && !selectedScope ? (
              <div className="py-6 text-center text-[#9E9B94] text-sm">
                Select a scope to see pricing.
              </div>
            ) : !calcLoading && (!sqft || sqft === 0) ? (
              <div className="py-6 text-center text-[#9E9B94] text-sm">
                Enter square footage to calculate price.
              </div>
            ) : null}

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
              <Button
                className="w-full"
                variant="outline"
                size="sm"
                onClick={() => save("draft")}
                disabled={saving}
              >
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
