import { useState, useEffect, useMemo } from "react";
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
import { ArrowLeft, Save, SendHorizonal, ArrowRight, ChevronDown, User, Home, Calculator, PlusSquare } from "lucide-react";
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

interface Scope {
  id: number;
  name: string;
  pricing_method: string;
  base_hourly_rate: string;
  min_bill_rate: string;
  frequencies: Frequency[];
  sqft_table: SqftEntry[];
  addons: Addon[];
}

interface Frequency {
  id: number;
  frequency: string;
  factor: string;
  available_office: boolean;
}

interface SqftEntry {
  sqft_min: number;
  sqft_max: number | null;
  estimated_hours: string;
}

interface Addon {
  id: number;
  name: string;
  price_type: string;
  price_value: string;
  time_minutes: number;
  is_active: boolean;
  available_office: boolean;
}

interface SelectedAddon {
  id: number;
  name: string;
  price: number;
}

const DIRT_LEVELS = [
  { value: "light", label: "Light — recently cleaned, minor touch-up" },
  { value: "standard", label: "Standard — regular household cleaning" },
  { value: "heavy", label: "Heavy — needs extra time and attention" },
  { value: "very_heavy", label: "Very Heavy — move-out / construction level" },
];

const DIRT_MULTIPLIERS: Record<string, number> = {
  light: 0.9,
  standard: 1.0,
  heavy: 1.15,
  very_heavy: 1.3,
};

function calcHours(scope: Scope, sqft: number): number | null {
  if (!sqft || scope.pricing_method !== "sqft") return null;
  const row = scope.sqft_table.find(
    r => sqft >= r.sqft_min && (r.sqft_max === null || sqft <= r.sqft_max)
  );
  return row ? parseFloat(row.estimated_hours) : null;
}

function calcPrice(
  scope: Scope | null,
  frequency: Frequency | null,
  sqft: number,
  dirtLevel: string,
  manualHours: number,
  selectedAddons: SelectedAddon[],
  discount: number
): { basePrice: number; estimatedHours: number | null; addonTotal: number; total: number } {
  if (!scope) return { basePrice: 0, estimatedHours: null, addonTotal: 0, total: 0 };

  const rate = parseFloat(scope.base_hourly_rate) || 65;
  const minBill = parseFloat(scope.min_bill_rate) || 180;
  const freqFactor = frequency ? parseFloat(frequency.factor) || 1 : 1;
  const dirtMult = DIRT_MULTIPLIERS[dirtLevel] || 1;

  let estimatedHours: number | null = null;
  let basePrice = 0;

  if (scope.pricing_method === "sqft" && sqft > 0) {
    const hrs = calcHours(scope, sqft);
    if (hrs !== null) {
      estimatedHours = hrs * dirtMult;
      basePrice = Math.max(estimatedHours * rate * freqFactor, minBill);
    }
  } else if (scope.pricing_method === "hourly" && manualHours > 0) {
    estimatedHours = manualHours;
    basePrice = Math.max(manualHours * rate * freqFactor, minBill);
  } else if (scope.pricing_method === "flat") {
    basePrice = minBill;
  }

  const addonTotal = selectedAddons.reduce((sum, a) => sum + a.price, 0);
  const subtotal = basePrice + addonTotal;
  const total = Math.max(0, subtotal - discount);

  return { basePrice, estimatedHours, addonTotal, total };
}

const SECTION_ICONS = [User, Home, Calculator, PlusSquare];
const SECTION_LABELS = ["Customer Info", "Property Details", "Service & Pricing", "Add-ons & Notes"];

export default function QuoteBuilderPage() {
  const [matchEdit, editParams] = useRoute("/quotes/:id"); const id = editParams?.id;
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

  const [scopeId, setScopeId] = useState<number | null>(null);
  const [frequencyId, setFrequencyId] = useState<number | null>(null);
  const [sqft, setSqft] = useState<number>(0);
  const [bedrooms, setBedrooms] = useState<number>(2);
  const [bathrooms, setBathrooms] = useState<number>(1);
  const [halfBaths, setHalfBaths] = useState<number>(0);
  const [pets, setPets] = useState<number>(0);
  const [dirtLevel, setDirtLevel] = useState("standard");
  const [manualHours, setManualHours] = useState<number>(0);
  const [selectedAddons, setSelectedAddons] = useState<SelectedAddon[]>([]);
  const [discount, setDiscount] = useState<number>(0);
  const [discountCode, setDiscountCode] = useState("");
  const [notes, setNotes] = useState("");
  const [internalMemo, setInternalMemo] = useState("");

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["clients-list"],
    queryFn: () => apiFetch("/api/clients?limit=200").then((r: any) => r.data ?? r),
  });

  const { data: scopes = [] } = useQuery<Scope[]>({
    queryKey: ["quote-scopes"],
    queryFn: () => apiFetch("/api/quote-scopes"),
  });

  const { data: existingQuote } = useQuery({
    queryKey: ["quote", id],
    queryFn: () => apiFetch(`/api/quotes/${id}`),
    enabled: isEdit,
  });

  const selectedScope = scopes.find(s => s.id === scopeId) ?? null;
  const selectedFrequency = selectedScope?.frequencies.find(f => f.id === frequencyId) ?? null;

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
      setManualHours(parseFloat(existingQuote.manual_hours || "0") || 0);
      setDiscount(parseFloat(existingQuote.discount_amount || "0") || 0);
      setDiscountCode(existingQuote.discount_code || "");
      setNotes(existingQuote.notes || "");
      setInternalMemo(existingQuote.internal_memo || "");
      setSelectedAddons(Array.isArray(existingQuote.addons) ? existingQuote.addons : []);
    }
  }, [existingQuote]);

  useEffect(() => {
    if (existingQuote && scopeId && scopes.length) {
      const scope = scopes.find(s => s.id === scopeId);
      if (scope && existingQuote.frequency) {
        const freq = scope.frequencies.find(f => f.frequency === existingQuote.frequency);
        if (freq) setFrequencyId(freq.id);
      }
    }
  }, [existingQuote, scopeId, scopes]);

  useEffect(() => {
    if (scopeId && scopes.length) {
      const scope = scopes.find(s => s.id === scopeId);
      if (scope) {
        const officeFreqs = scope.frequencies.filter(f => f.available_office);
        if (officeFreqs.length && !frequencyId) {
          const biWeekly = officeFreqs.find(f => f.frequency.toLowerCase().includes("two week"));
          setFrequencyId(biWeekly?.id ?? officeFreqs[0].id);
        }
        setSelectedAddons([]);
      }
    }
  }, [scopeId]);

  const pricing = useMemo(
    () => calcPrice(selectedScope, selectedFrequency, sqft, dirtLevel, manualHours, selectedAddons, discount),
    [selectedScope, selectedFrequency, sqft, dirtLevel, manualHours, selectedAddons, discount]
  );

  function buildPayload(status: string) {
    const client = selectedClientId ? clients.find(c => c.id === selectedClientId) : null;
    return {
      client_id: selectedClientId || null,
      lead_name: client ? `${client.first_name} ${client.last_name}`.trim() : leadName || null,
      lead_email: client?.email || leadEmail || null,
      lead_phone: client?.phone || leadPhone || null,
      address: address || client?.address || null,
      scope_id: scopeId || null,
      pricing_method: selectedScope?.pricing_method || null,
      frequency: selectedFrequency?.frequency || null,
      estimated_hours: pricing.estimatedHours ? String(pricing.estimatedHours.toFixed(2)) : null,
      manual_hours: manualHours > 0 ? String(manualHours) : null,
      base_price: pricing.basePrice > 0 ? String(pricing.basePrice.toFixed(2)) : null,
      total_price: pricing.total > 0 ? String(pricing.total.toFixed(2)) : null,
      discount_amount: String(discount),
      discount_code: discountCode || null,
      addons: selectedAddons,
      bedrooms, bathrooms, half_baths: halfBaths,
      sqft: sqft || null, dirt_level: dirtLevel, pets,
      notes: notes || null,
      internal_memo: internalMemo || null,
      status,
    };
  }

  async function save(status: string = "draft") {
    setSaving(true);
    try {
      const payload = buildPayload(status);
      let result;
      if (isEdit) {
        result = await apiFetch(`/api/quotes/${id}`, { method: "PATCH", body: payload });
        toast.success(status === "sent" ? "Quote sent" : "Quote saved");
      } else {
        result = await apiFetch("/api/quotes", { method: "POST", body: payload });
        toast.success(status === "sent" ? "Quote created and marked as sent" : "Quote saved as draft");
      }
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote-stats"] });
      navigate(`/quotes`);
    } catch (err) {
      toast.error("Failed to save quote");
    } finally {
      setSaving(false);
    }
  }

  const selectedClient = clients.find(c => c.id === selectedClientId);

  const toggleAddon = (addon: Addon) => {
    setSelectedAddons(prev => {
      const exists = prev.find(a => a.id === addon.id);
      if (exists) return prev.filter(a => a.id !== addon.id);
      const price = addon.price_type === "flat"
        ? parseFloat(addon.price_value) || 0
        : (pricing.basePrice * (parseFloat(addon.price_value) || 0)) / 100;
      return [...prev, { id: addon.id, name: addon.name, price }];
    });
  };

  const sectionComplete = [
    Boolean(selectedClientId || leadName || leadEmail),
    Boolean(sqft > 0 || selectedScope?.pricing_method === "hourly"),
    Boolean(scopeId && frequencyId),
    true,
  ];

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
          <Button size="sm" onClick={() => save("sent")} disabled={saving} className="bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white gap-1.5">
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
                      ? "bg-[#5B9BD5] text-white"
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

                <div>
                  <Label className="text-xs">Service Address</Label>
                  <Input value={address} onChange={e => setAddress(e.target.value)} placeholder="123 Main St, City, State" className="mt-1" />
                </div>

                <div className="flex justify-end">
                  <Button size="sm" className="bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white gap-1.5" onClick={() => setActiveSection(1)}>
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
                <Button size="sm" className="bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white gap-1.5" onClick={() => setActiveSection(2)}>
                  Next: Service & Pricing <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </SectionCard>
          )}

          {activeSection === 2 && (
            <SectionCard title="Service & Pricing">
              <div className="space-y-4">
                <div>
                  <Label className="text-xs">Service Scope</Label>
                  <Select value={scopeId ? String(scopeId) : ""} onValueChange={v => { setScopeId(parseInt(v)); setFrequencyId(null); }}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select a service..." />
                    </SelectTrigger>
                    <SelectContent>
                      {scopes.filter(s => s.is_active !== false).map(s => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          <div>
                            <span className="font-medium">{s.name}</span>
                            <span className="text-[#9E9B94] ml-2 text-xs">
                              ${parseFloat(s.base_hourly_rate).toFixed(0)}/hr · min ${parseFloat(s.min_bill_rate).toFixed(0)}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedScope && (
                  <>
                    <div>
                      <Label className="text-xs">Frequency</Label>
                      <div className="grid grid-cols-2 gap-2 mt-1">
                        {selectedScope.frequencies.filter(f => f.available_office).map(freq => (
                          <button
                            key={freq.id}
                            onClick={() => setFrequencyId(freq.id)}
                            className={cn(
                              "px-3 py-2 rounded-lg border text-left transition-colors text-sm",
                              frequencyId === freq.id
                                ? "bg-[#5B9BD5]/10 border-[#5B9BD5] text-[#5B9BD5]"
                                : "bg-white border-[#E5E2DC] text-[#6B7280] hover:bg-[#F7F6F3]"
                            )}
                          >
                            <p className="font-medium text-xs">{freq.frequency}</p>
                            <p className="text-xs text-[#9E9B94]">×{parseFloat(freq.factor).toFixed(2)}</p>
                          </button>
                        ))}
                      </div>
                    </div>

                    {selectedScope.pricing_method === "hourly" && (
                      <div>
                        <Label className="text-xs">Manual Hours</Label>
                        <Input
                          type="number"
                          step="0.5"
                          value={manualHours || ""}
                          onChange={e => setManualHours(parseFloat(e.target.value) || 0)}
                          placeholder="e.g. 3.5"
                          className="mt-1"
                        />
                      </div>
                    )}

                    <div>
                      <Label className="text-xs">Discount Amount ($)</Label>
                      <div className="grid grid-cols-2 gap-2 mt-1">
                        <Input type="number" value={discount || ""} onChange={e => setDiscount(parseFloat(e.target.value) || 0)} placeholder="0.00" />
                        <Input value={discountCode} onChange={e => setDiscountCode(e.target.value)} placeholder="Code (optional)" />
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="flex justify-between mt-4">
                <Button size="sm" variant="ghost" onClick={() => setActiveSection(1)}>Back</Button>
                <Button size="sm" className="bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white gap-1.5" onClick={() => setActiveSection(3)}>
                  Next: Add-ons <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </SectionCard>
          )}

          {activeSection === 3 && (
            <SectionCard title="Add-ons & Notes">
              <div className="space-y-4">
                {selectedScope?.addons.filter(a => a.is_active && a.available_office).length ? (
                  <div>
                    <Label className="text-xs mb-2 block">Add-ons for {selectedScope?.name}</Label>
                    <div className="grid grid-cols-2 gap-2">
                      {selectedScope.addons.filter(a => a.is_active && a.available_office).map(addon => {
                        const isSelected = selectedAddons.some(a => a.id === addon.id);
                        return (
                          <label
                            key={addon.id}
                            className={cn(
                              "flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors",
                              isSelected ? "bg-[#5B9BD5]/10 border-[#5B9BD5]" : "bg-white border-[#E5E2DC] hover:bg-[#F7F6F3]"
                            )}
                          >
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleAddon(addon)}
                              className="mt-0.5"
                            />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-[#1A1917]">{addon.name}</p>
                              <p className="text-xs text-[#9E9B94]">
                                {addon.price_type === "flat" ? `$${parseFloat(addon.price_value).toFixed(2)}` : `${addon.price_value}%`}
                                {addon.time_minutes > 0 ? ` · ${addon.time_minutes}min` : ""}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

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
                    <Button size="sm" onClick={() => save("sent")} disabled={saving} className="bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white gap-1.5">
                      <SendHorizonal className="w-3.5 h-3.5" /> Send Quote
                    </Button>
                  </div>
                </div>
              </div>
            </SectionCard>
          )}
        </div>

        <div className="w-72 shrink-0">
          <div className="bg-white border border-[#E5E2DC] rounded-lg p-4 space-y-4 sticky top-6">
            <h3 className="font-semibold text-[#1A1917] text-sm border-b border-[#E5E2DC] pb-3">Price Preview</h3>

            {selectedScope ? (
              <>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Scope</span>
                    <span className="text-right text-[#1A1917] font-medium text-xs max-w-[140px] truncate">{selectedScope.name}</span>
                  </div>
                  {selectedFrequency && (
                    <div className="flex justify-between text-[#6B7280]">
                      <span>Frequency</span>
                      <span className="text-[#1A1917]">{selectedFrequency.frequency}</span>
                    </div>
                  )}
                  {sqft > 0 && (
                    <div className="flex justify-between text-[#6B7280]">
                      <span>Sq Ft</span>
                      <span className="text-[#1A1917]">{sqft.toLocaleString()}</span>
                    </div>
                  )}
                  {pricing.estimatedHours !== null && (
                    <div className="flex justify-between text-[#6B7280]">
                      <span>Est. Hours</span>
                      <span className="text-[#1A1917]">{pricing.estimatedHours.toFixed(1)}h</span>
                    </div>
                  )}
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Rate</span>
                    <span className="text-[#1A1917]">${parseFloat(selectedScope.base_hourly_rate).toFixed(0)}/hr</span>
                  </div>
                  {selectedFrequency && (
                    <div className="flex justify-between text-[#6B7280]">
                      <span>Freq. Factor</span>
                      <span className="text-[#1A1917]">×{parseFloat(selectedFrequency.factor).toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Dirt Level</span>
                    <span className="text-[#1A1917]">×{DIRT_MULTIPLIERS[dirtLevel]?.toFixed(2)}</span>
                  </div>
                </div>

                <div className="border-t border-[#E5E2DC] pt-3 space-y-1.5 text-sm">
                  <div className="flex justify-between text-[#6B7280]">
                    <span>Base Price</span>
                    <span className="text-[#1A1917]">${pricing.basePrice.toFixed(2)}</span>
                  </div>
                  <p className="text-xs text-[#9E9B94]">
                    Min bill: ${parseFloat(selectedScope.min_bill_rate).toFixed(2)}
                  </p>
                  {pricing.addonTotal > 0 && (
                    <div className="flex justify-between text-[#6B7280]">
                      <span>Add-ons</span>
                      <span className="text-[#1A1917]">+${pricing.addonTotal.toFixed(2)}</span>
                    </div>
                  )}
                  {discount > 0 && (
                    <div className="flex justify-between text-green-600">
                      <span>Discount{discountCode ? ` (${discountCode})` : ""}</span>
                      <span>-${discount.toFixed(2)}</span>
                    </div>
                  )}
                </div>

                <div className="border-t border-[#E5E2DC] pt-3">
                  <div className="flex justify-between items-baseline">
                    <span className="text-[#6B7280] text-sm">Total</span>
                    <span className="text-2xl font-bold text-[#1A1917]">
                      ${pricing.total.toFixed(2)}
                    </span>
                  </div>
                  {pricing.basePrice > 0 && pricing.total === parseFloat(selectedScope.min_bill_rate) && (
                    <p className="text-xs text-[#9E9B94] mt-1">Minimum bill rate applied</p>
                  )}
                </div>

                {selectedAddons.length > 0 && (
                  <div className="border-t border-[#E5E2DC] pt-3 space-y-1">
                    <p className="text-xs text-[#9E9B94] font-medium">Selected Add-ons</p>
                    {selectedAddons.map(a => (
                      <div key={a.id} className="flex justify-between text-xs text-[#6B7280]">
                        <span>{a.name}</span>
                        <span>${a.price.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="py-6 text-center text-[#9E9B94] text-sm">
                Select a scope to see pricing.
              </div>
            )}

            <div className="border-t border-[#E5E2DC] pt-3 space-y-2">
              <Button
                className="w-full bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white gap-1.5"
                size="sm"
                onClick={() => save("sent")}
                disabled={saving || !scopeId}
              >
                <SendHorizonal className="w-3.5 h-3.5" />
                Save & Send
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
