import { useState, useEffect, useRef, useCallback } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  ArrowLeft, Save, SendHorizonal, ArrowRight, ChevronDown,
  User, Home, Calculator, PlusSquare, AlertCircle, CheckCircle2, Check,
  X, Phone, ImagePlus, Loader2, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { calculateCommissionSplit } from "@/lib/commission";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

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

interface Client {
  id: number; first_name: string; last_name: string; email: string; phone: string; address: string;
  zip?: string; frequency?: string | null; client_type?: string | null;
  last_service_date?: string | null; next_job_date?: string | null;
  zone_color?: string | null; zone_name?: string | null;
}

interface PricingScope {
  id: number; name: string; scope_group: string; pricing_method: string;
  hourly_rate: string; minimum_bill: string; displayed_for_office: boolean;
  is_active: boolean; sort_order: number;
}

interface PricingFrequency {
  id: number; scope_id: number; frequency: string; label: string;
  multiplier: string; rate_override: string | null; show_office: boolean; sort_order: number;
}

interface PricingAddon {
  id: number; scope_id: number; name: string; addon_type: string; scope_ids: string;
  price_type: string; price_value: string; price: string | null; percent_of_base: string | null;
  time_add_minutes: number; time_unit: string; is_itemized: boolean;
  show_office: boolean; show_online: boolean; is_active: boolean;
}

interface CalcResult {
  scope_id: number; pricing_method: string; sqft: number | null; frequency: string | null;
  base_hours: number; hourly_rate: number; base_price: number; minimum_applied: boolean;
  minimum_bill: number; addons_total: number;
  addon_breakdown: Array<{ id: number; name: string; amount: number; price_type?: string }>;
  bundle_discount: number; bundle_breakdown: Array<{ name: string; discount: number }>;
  subtotal: number; discount_amount: number; discount_valid?: boolean; final_total: number;
}

interface SelectedScopeState {
  scope_id: number;
  frequency: string;
  hours: number;
  hoursOverrideSet: boolean;
  addon_ids: number[];
  addonQtys: Record<number, number>;
  addonRecurring: Record<number, boolean>;
  adjPlus: number;
  adjPlusReason: string;
  adjMinus: number;
  adjMinusReason: string;
  frequencies: PricingFrequency[];
  addons: PricingAddon[];
  calc: CalcResult | null;
  calcLoading: boolean;
  expanded: boolean;
}

interface SuggestedTech { id: number; name: string; zone_name: string; zone_color: string; }

interface PreferredTech { id: number; full_name: string; job_count: number; }
interface RecentService { scope: string; last_date: string; last_price: number; frequency: string | null; addons: string[]; }
interface PhotoUpload { id: string; objectPath: string; previewUrl: string; inJobNotes: boolean; uploading: boolean; name: string; error?: string; }

const SECTION_LABELS = ["Customer Info", "Service & Pricing", "Property Details", "Add-ons & Notes", "Review"];
const SECTION_ICONS = [User, Calculator, Home, PlusSquare, CheckCircle2];
const DIRT_LEVELS = [
  { value: "pristine", label: "1 — Very Clean" },
  { value: "standard", label: "2 — Moderately Clean" },
  { value: "heavy", label: "3 — Very Dirty" },
];

export default function QuoteBuilderPage() {
  const [matchEdit, editParams] = useRoute("/quotes/:id/edit");
  const id = editParams?.id;
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const isEdit = Boolean(id && id !== "new");
  const token = useAuthStore(s => s.token);

  const userRole = (() => { try { return JSON.parse(atob((token || "").split(".")[1])).role || "office"; } catch { return "office"; } })();

  const [activeSection, setActiveSection] = useState(0);
  const [saving, setSaving] = useState(false);

  // ── Section 0: Customer Info ─────────────────────────────────────────────
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [clientSearch, setClientSearch] = useState("");
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);
  const [clientSearchLoading, setClientSearchLoading] = useState(false);
  const [clientResults, setClientResults] = useState<Client[]>([]);
  const [clientLoaded, setClientLoaded] = useState<Client | null>(null);
  const [clientBannerVisible, setClientBannerVisible] = useState(false);
  const [leadFirstName, setLeadFirstName] = useState("");
  const [leadLastName, setLeadLastName] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadPhone, setLeadPhone] = useState("");
  const [address, setAddress] = useState("");
  const [unitSuite, setUnitSuite] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [referralSource, setReferralSource] = useState("");
  const [zipZone, setZipZone] = useState<{ name: string; color: string } | null | "uncovered">(null);
  const [checkingZip, setCheckingZip] = useState(false);
  const [zoneOverride, setZoneOverride] = useState(false);

  // ── Section 1: Property Details ──────────────────────────────────────────
  const [sqft, setSqft] = useState<number>(0);
  const [bedrooms, setBedrooms] = useState<number>(0);
  const [bathrooms, setBathrooms] = useState<number>(0);
  const [halfBaths, setHalfBaths] = useState<number>(0);
  const [pets, setPets] = useState<number>(0);
  const [dirtLevel, setDirtLevel] = useState("standard");

  // ── Section 2: Multi-scope selection ────────────────────────────────────
  const [selectedScopes, setSelectedScopes] = useState<SelectedScopeState[]>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedTime, setSelectedTime] = useState("09:00");

  // ── Section 3: Notes + discount + photos ─────────────────────────────────
  const [notes, setNotes] = useState("");
  const [internalMemo, setInternalMemo] = useState("");
  const [officeMemo, setOfficeMemo] = useState("");
  const [manualAdjValue, setManualAdjValue] = useState("");
  const [discountCode, setDiscountCode] = useState("");
  const [discountInput, setDiscountInput] = useState("");
  const [discountError, setDiscountError] = useState("");
  const [photoUploads, setPhotoUploads] = useState<PhotoUpload[]>([]);
  const photoFileInputRef = useRef<HTMLInputElement>(null);

  // ── Section 4: Review — final scope selection ────────────────────────────
  const [finalScopeId, setFinalScopeId] = useState<number | null>(null);

  // ── Call Notes ───────────────────────────────────────────────────────────
  const [callNotes, setCallNotes] = useState("");
  const [callNotesSaving, setCallNotesSaving] = useState(false);
  const [callNotesSavedVisible, setCallNotesSavedVisible] = useState(false);
  const [callNotesMobileOpen, setCallNotesMobileOpen] = useState(false);
  const callNotesRef = useRef<HTMLTextAreaElement>(null);
  const autoSavedIdRef = useRef<string | null>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const discountCodeRef = useRef<string>("");

  // ── Google Maps Places ───────────────────────────────────────────────────
  const [mapsReady, setMapsReady] = useState(false);
  const [inputMounted, setInputMounted] = useState(false);
  const [addressVerified, setAddressVerified] = useState<boolean | null>(null);
  const [addressFormatted, setAddressFormatted] = useState("");
  const [callNoteTooltip, setCallNoteTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [pushConfirmed, setPushConfirmed] = useState(false);

  // ── Returning client ─────────────────────────────────────────────────────
  const [returningClient, setReturningClient] = useState<{ id: number; name: string; phone?: string; email?: string; address?: string } | null>(null);
  const [returningClientDismissed, setReturningClientDismissed] = useState(false);

  // ── Tech suggestions ─────────────────────────────────────────────────────
  const [suggestedTechs, setSuggestedTechs] = useState<SuggestedTech[]>([]);
  const [selectedTechId, setSelectedTechId] = useState<number | null>(null);
  const [techAvailability, setTechAvailability] = useState<Record<number, number>>({});
  const [techAvailLoading, setTechAvailLoading] = useState(false);

  // ── Quick Book (returning client) ─────────────────────────────────────────
  const [preferredTech, setPreferredTech] = useState<PreferredTech | null>(null);
  const [recentServices, setRecentServices] = useState<RecentService[]>([]);
  const [quickBookDismissed, setQuickBookDismissed] = useState(false);
  const [quickBookBanner, setQuickBookBanner] = useState<{ scope: string; date: string } | null>(null);
  const [quickBookPrice, setQuickBookPrice] = useState<number | null>(null);
  const [hourlyExpanded, setHourlyExpanded] = useState(false);
  const [hourlySubType, setHourlySubType] = useState<string | null>(null);
  const [callNotesOpen, setCallNotesOpen] = useState(false);

  // ── Mobile ───────────────────────────────────────────────────────────────
  const isMobile = useIsMobile();
  const [mobileNotesOpen, setMobileNotesOpen] = useState(false);
  const [mobileClientSearch, setMobileClientSearch] = useState("");
  const [mobileClientDropdown, setMobileClientDropdown] = useState(false);
  const [mobileStep, setMobileStep] = useState(1);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);

  // ── Refs for recalc (avoid stale closures) ───────────────────────────────
  const clientSearchRef = useRef<HTMLDivElement>(null);
  const sqftRef = useRef(sqft);
  useEffect(() => { sqftRef.current = sqft; }, [sqft]);
  const selectedScopesRef = useRef<SelectedScopeState[]>([]);
  useEffect(() => { selectedScopesRef.current = selectedScopes; }, [selectedScopes]);
  useEffect(() => { discountCodeRef.current = discountCode; }, [discountCode]);
  const recalcTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  // ── Data queries ─────────────────────────────────────────────────────────

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["clients-list"],
    queryFn: () => apiFetch("/api/clients?limit=200").then((r: any) => r.data ?? r),
  });

  const { data: scopes = [] } = useQuery<PricingScope[]>({
    queryKey: ["pricing-scopes-office"],
    queryFn: () => apiFetch("/api/pricing/scopes?office=true"),
    staleTime: 0,
  });

  const { data: existingQuote } = useQuery({
    queryKey: ["quote", id],
    queryFn: () => apiFetch(`/api/quotes/${id}`),
    enabled: isEdit,
  });

  // ── Client search debounce ───────────────────────────────────────────────
  useEffect(() => {
    if (selectedClientId) return; // already selected, don't re-search
    const q = clientSearch.trim();
    if (q.length < 2) { setClientResults([]); setClientDropdownOpen(false); return; }
    setClientSearchLoading(true);
    setClientDropdownOpen(true);
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/clients?search=${encodeURIComponent(q)}&limit=8`);
        setClientResults(Array.isArray(res) ? res : (res.data ?? []));
      } catch { setClientResults([]); } finally { setClientSearchLoading(false); }
    }, 200);
    return () => clearTimeout(t);
  }, [clientSearch, selectedClientId]);

  // ── Client search click-outside ──────────────────────────────────────────
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (clientSearchRef.current && !clientSearchRef.current.contains(e.target as Node)) {
        setClientDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Pre-select client from ?client_id= on mount (when opened from customer profile) ──
  useEffect(() => {
    if (isEdit || selectedClientId) return; // editing existing quote, or already picked
    const params = new URLSearchParams(window.location.search);
    const cid = parseInt(params.get("client_id") || "");
    if (!cid || isNaN(cid)) return;
    (async () => {
      try {
        const client = await apiFetch(`/api/clients/${cid}`);
        if (!client || !client.id) return;
        setSelectedClientId(client.id);
        const displayName = client.company_name || `${client.first_name || ""} ${client.last_name || ""}`.trim();
        setClientSearch(displayName);
        setLeadFirstName(client.first_name || "");
        setLeadLastName(client.last_name || "");
        setLeadEmail(client.email || "");
        setLeadPhone(client.phone || "");
        setAddress(client.address || "");
      } catch {}
    })();
  }, [isEdit]);

  // ── Restore existing quote ───────────────────────────────────────────────
  useEffect(() => {
    if (!existingQuote) return;
    setSelectedClientId(existingQuote.client_id || null);
    const nameParts = (existingQuote.lead_name || "").split(" ");
    setLeadFirstName(nameParts[0] || "");
    setLeadLastName(nameParts.slice(1).join(" ") || "");
    setLeadEmail(existingQuote.lead_email || "");
    setLeadPhone(existingQuote.lead_phone || "");
    setAddress(existingQuote.address || "");
    setSqft(existingQuote.sqft || 0);
    setBedrooms(existingQuote.bedrooms ?? 0);
    setBathrooms(existingQuote.bathrooms ?? 0);
    setHalfBaths(existingQuote.half_baths || 0);
    setPets(existingQuote.pets || 0);
    setDirtLevel(existingQuote.dirt_level || "standard");
    setDiscountCode(existingQuote.discount_code || "");
    setDiscountInput(existingQuote.discount_code || "");
    setNotes(existingQuote.notes || "");
    setInternalMemo(existingQuote.internal_memo || "");
    setOfficeMemo(existingQuote.office_notes || "");
    setCallNotes(existingQuote.call_notes || "");
    setZoneOverride(existingQuote.zone_override || false);
    if (Array.isArray(existingQuote.photo_urls) && existingQuote.photo_urls.length > 0) {
      setPhotoUploads(existingQuote.photo_urls.map((p: string) => ({
        id: p, objectPath: p,
        previewUrl: `${API}/photos${p}`,
        inJobNotes: true, uploading: false, name: p.split("/").pop() || "photo",
      })));
    }
    setUnitSuite(existingQuote.unit_suite || "");
    setReferralSource(existingQuote.referral_source || "");
    // Restore single scope from existing quote (backward compat)
    if (existingQuote.scope_id && scopes.length > 0) {
      const scope = scopes.find((s: PricingScope) => s.id === existingQuote.scope_id);
      if (scope) {
        toggleScope(scope, {
          frequency: existingQuote.frequency || "",
          hours: existingQuote.estimated_hours ? parseFloat(existingQuote.estimated_hours) : 0,
          addon_ids: Array.isArray(existingQuote.addons) ? existingQuote.addons.map((a: any) => a.id).filter(Boolean) : [],
        });
      }
    }
  }, [existingQuote, scopes.length]);

  // ── Call Notes auto-save (10s debounce) ─────────────────────────────────
  useEffect(() => {
    if (!callNotes) return;
    const timer = setTimeout(async () => {
      const targetId = isEdit ? id : autoSavedIdRef.current;
      setCallNotesSaving(true);
      try {
        if (targetId) {
          await apiFetch(`/api/quotes/${targetId}`, { method: "PATCH", body: { call_notes: callNotes } });
        } else {
          const result = await apiFetch("/api/quotes", { method: "POST", body: { call_notes: callNotes, status: "draft" } });
          autoSavedIdRef.current = String(result.id);
        }
        setCallNotesSavedVisible(true);
        setTimeout(() => setCallNotesSavedVisible(false), 2500);
      } catch { /* silent */ }
      finally { setCallNotesSaving(false); }
    }, 10000);
    return () => clearTimeout(timer);
  }, [callNotes, isEdit, id]);

  // ── Recalc all sqft-based scopes when sqft changes ───────────────────────
  useEffect(() => {
    selectedScopesRef.current.forEach(s => {
      const scope = scopes.find(sc => sc.id === s.scope_id);
      if (scope?.pricing_method === "sqft") recalcScopeById(s.scope_id);
    });
  }, [sqft]);

  // ── Load Google Maps Places API ──────────────────────────────────────────
  useEffect(() => {
    const key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY ?? "";
    if ((window as any).google?.maps?.places) { setMapsReady(true); return; }
    const scriptId = "gmap-places-script";
    if (document.getElementById(scriptId)) {
      const existing = document.getElementById(scriptId) as HTMLScriptElement;
      if (existing) { existing.addEventListener("load", () => setMapsReady(true)); }
      return;
    }
    if (!key) return;
    const s = document.createElement("script");
    s.id = scriptId;
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
    s.async = true;
    s.defer = true;
    s.onload = () => setMapsReady(true);
    document.head.appendChild(s);
  }, []);

  // ── Wire autocomplete after Maps ready + input mounted ──────────────────
  useEffect(() => {
    if (!mapsReady || !inputMounted || !addressInputRef.current) return;
    const g = (window as any).google;
    if (!g?.maps?.places?.Autocomplete) return;
    const ac = new g.maps.places.Autocomplete(addressInputRef.current, {
      componentRestrictions: { country: "us" },
      fields: ["address_components", "formatted_address", "geometry"],
      types: ["address"],
    });
    const listener = ac.addListener("place_changed", () => {
      const place = ac.getPlace();
      if (!place?.address_components) return;
      const get = (type: string) =>
        place.address_components.find((c: any) => c.types.includes(type))?.long_name ?? "";
      const shortGet = (type: string) =>
        place.address_components.find((c: any) => c.types.includes(type))?.short_name ?? "";
      const street = `${get("street_number")} ${get("route")}`.trim();
      const zip = get("postal_code");
      const formatted = place.formatted_address ?? "";
      setAddress(street || formatted);
      if (zip) { setZipCode(zip); checkZip(zip); }
      setAddressVerified(true);
      setAddressFormatted(formatted);
    });
    return () => { g.maps.event.removeListener(listener); };
  }, [mapsReady, inputMounted]);

  // ── Geocode helper for client-loaded addresses ───────────────────────────
  async function geocodeVerify(addressStr: string) {
    const key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY ?? "";
    if (!key || !addressStr.trim()) { setAddressVerified(false); return; }
    try {
      const r = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressStr)}&key=${key}`
      );
      const data = await r.json();
      const result = data?.results?.[0];
      if (result && ["ROOFTOP", "RANGE_INTERPOLATED"].includes(result.geometry?.location_type)) {
        setAddressVerified(true);
        setAddressFormatted(result.formatted_address ?? addressStr);
      } else {
        setAddressVerified(false);
        setAddressFormatted("");
      }
    } catch {
      setAddressVerified(false);
      setAddressFormatted("");
    }
  }

  // ── Recalc function (uses refs to avoid stale closures) ─────────────────
  function recalcScopeById(scopeId: number, delay = 300) {
    if (recalcTimers.current[scopeId]) clearTimeout(recalcTimers.current[scopeId]);
    recalcTimers.current[scopeId] = setTimeout(async () => {
      const state = selectedScopesRef.current.find(s => s.scope_id === scopeId);
      const scope = scopes.find(s => s.id === scopeId);
      if (!state || !scope) return;
      const method = scope.pricing_method;
      const currentSqft = sqftRef.current;
      if (method === "sqft" && (!currentSqft || currentSqft === 0)) {
        setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, calc: null } : s));
        return;
      }
      if ((method === "hourly" || method === "simplified") && (!state.hours || state.hours <= 0)) {
        setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, calc: null } : s));
        return;
      }
      setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, calcLoading: true } : s));
      try {
        const counterAddonIds = Object.keys(state.addonQtys).filter(k => (state.addonQtys[Number(k)] ?? 0) > 0).map(Number);
        const allAddonIds = [...new Set([...state.addon_ids, ...counterAddonIds])];
        const addonQtysFiltered: Record<string, number> = {};
        for (const id of counterAddonIds) {
          addonQtysFiltered[String(id)] = state.addonQtys[id];
        }
        const body: Record<string, unknown> = { scope_id: scopeId, frequency: state.frequency || undefined, addon_ids: allAddonIds };
        if (Object.keys(addonQtysFiltered).length > 0) body.addon_quantities = addonQtysFiltered;
        if (method === "sqft") { body.sqft = currentSqft; }
        else {
          const hoursToUse = state.hoursOverrideSet ? state.hours : state.hours;
          body.hours = hoursToUse;
          if (currentSqft > 0) body.sqft = currentSqft;
        }
        if (discountCodeRef.current) body.discount_code = discountCodeRef.current;
        const result = await apiFetch("/api/pricing/calculate", { method: "POST", body });
        setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, calc: result, calcLoading: false } : s));
      } catch {
        setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, calcLoading: false } : s));
      }
    }, delay);
  }

  // ── Toggle scope selection ────────────────────────────────────────────────
  async function toggleScope(scope: PricingScope, initialState?: { frequency?: string; hours?: number; addon_ids?: number[] }) {
    const isSelected = selectedScopesRef.current.some(s => s.scope_id === scope.id);
    if (isSelected && !initialState) {
      setSelectedScopes(prev => prev.filter(s => s.scope_id !== scope.id));
      if (finalScopeId === scope.id) setFinalScopeId(null);
      return;
    }
    if (isSelected) return; // already there on restore
    try {
      const [freqs, addons] = await Promise.all([
        apiFetch(`/api/pricing/scopes/${scope.id}/frequencies?office=true`),
        apiFetch(`/api/pricing/scopes/${scope.id}/addons`),
      ]);
      const defaultFreq = (freqs as PricingFrequency[]).find(f =>
        f.frequency.toLowerCase().includes("one") || f.frequency.toLowerCase().includes("single") || f.frequency.toLowerCase().includes("once")
      ) ?? (freqs as PricingFrequency[])[0];
      const newState: SelectedScopeState = {
        scope_id: scope.id,
        frequency: initialState?.frequency ?? defaultFreq?.frequency ?? "",
        hours: initialState?.hours ?? 0,
        hoursOverrideSet: false,
        addon_ids: initialState?.addon_ids ?? [],
        addonQtys: {},
        addonRecurring: {},
        adjPlus: 0,
        adjPlusReason: "",
        adjMinus: 0,
        adjMinusReason: "",
        frequencies: freqs as PricingFrequency[],
        addons: addons as PricingAddon[],
        calc: null,
        calcLoading: false,
        expanded: true,
      };
      setSelectedScopes(prev => [...prev, newState]);
      setTimeout(() => recalcScopeById(scope.id, 100), 50);
    } catch {
      setSelectedScopes(prev => [...prev, {
        scope_id: scope.id, frequency: initialState?.frequency ?? "", hours: initialState?.hours ?? 0,
        hoursOverrideSet: false, addon_ids: initialState?.addon_ids ?? [],
        addonQtys: {}, addonRecurring: {}, adjPlus: 0, adjPlusReason: "", adjMinus: 0, adjMinusReason: "",
        frequencies: [], addons: [],
        calc: null, calcLoading: false, expanded: true,
      }]);
    }
  }

  function updateScopeFrequency(scopeId: number, freq: string) {
    setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, frequency: freq } : s));
    setTimeout(() => recalcScopeById(scopeId), 50);
  }

  function updateScopeHours(scopeId: number, hours: number) {
    setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, hours } : s));
    recalcScopeById(scopeId);
  }

  function updateScopeHoursManual(scopeId: number, hours: number) {
    setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, hours: Math.max(0.5, hours), hoursOverrideSet: true } : s));
    setTimeout(() => recalcScopeById(scopeId), 50);
  }

  function resetScopeHours(scopeId: number) {
    const s = selectedScopes.find(sc => sc.scope_id === scopeId);
    const calcHours = s?.calc?.base_hours ?? 0;
    setSelectedScopes(prev => prev.map(sc => sc.scope_id === scopeId ? { ...sc, hours: calcHours, hoursOverrideSet: false } : sc));
    setTimeout(() => recalcScopeById(scopeId), 50);
  }

  function updateScopeAddonQty(scopeId: number, addonId: number, qty: number) {
    setSelectedScopes(prev => prev.map(s => {
      if (s.scope_id !== scopeId) return s;
      const newQtys = { ...s.addonQtys, [addonId]: Math.max(0, qty) };
      if (newQtys[addonId] === 0) delete newQtys[addonId];
      return { ...s, addonQtys: newQtys };
    }));
    setTimeout(() => recalcScopeById(scopeId), 50);
  }

  function updateScopeAddonRecurring(scopeId: number, addonId: number, recurring: boolean) {
    setSelectedScopes(prev => prev.map(s => {
      if (s.scope_id !== scopeId) return s;
      return { ...s, addonRecurring: { ...s.addonRecurring, [addonId]: recurring } };
    }));
  }

  function updateScopeAdj(scopeId: number, field: "adjPlus" | "adjMinus" | "adjPlusReason" | "adjMinusReason", val: number | string) {
    setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, [field]: val } : s));
  }

  function updateScopeAddon(scopeId: number, addonId: number, checked: boolean) {
    setSelectedScopes(prev => prev.map(s => {
      if (s.scope_id !== scopeId) return s;
      const addon_ids = checked ? [...s.addon_ids, addonId] : s.addon_ids.filter(id => id !== addonId);
      return { ...s, addon_ids };
    }));
    recalcScopeById(scopeId);
  }

  // ── Section completion ────────────────────────────────────────────────────
  const sectionComplete = [
    Boolean(selectedClientId || leadFirstName || leadEmail),
    selectedScopes.length > 0,
    Boolean(sqft > 0),
    true,
    Boolean(finalScopeId || selectedScopes.length === 1),
  ];

  // ── Build payload & save ─────────────────────────────────────────────────
  function buildPayload(status: string) {
    const primaryScopeId = finalScopeId ?? (selectedScopes.length === 1 ? selectedScopes[0].scope_id : null);
    const primaryScopeState = selectedScopes.find(s => s.scope_id === primaryScopeId);
    const cr = primaryScopeState?.calc ?? null;
    const client = clientLoaded;
    const alternateOptions = selectedScopes
      .filter(s => s.scope_id !== primaryScopeId)
      .map(s => ({
        scope_id: s.scope_id,
        scope_name: scopes.find(sc => sc.id === s.scope_id)?.name ?? "",
        frequency: s.frequency,
        addon_ids: s.addon_ids,
        total: s.calc?.final_total ?? null,
      }));
    return {
      client_id: selectedClientId || null,
      lead_name: client ? `${client.first_name} ${client.last_name}`.trim() : `${leadFirstName} ${leadLastName}`.trim() || null,
      lead_email: client?.email || leadEmail || null,
      lead_phone: client?.phone || leadPhone || null,
      address: address || client?.address || null,
      scope_id: primaryScopeId || null,
      frequency: primaryScopeState?.frequency || null,
      sqft: sqft || null,
      bedrooms, bathrooms,
      half_baths: halfBaths,
      pets, dirt_level: dirtLevel,
      addons: cr?.addon_breakdown ?? [],
      discount_code: discountCode || null,
      base_price: quickBookPrice != null ? String(quickBookPrice) : (cr ? String(cr.base_price) : null),
      addons_total: cr ? String(cr.addons_total) : "0",
      discount_amount: cr ? String(cr.discount_amount) : "0",
      total_price: quickBookPrice != null ? String(quickBookPrice) : (cr ? String(cr.final_total) : null),
      estimated_hours: cr ? String(cr.base_hours) : primaryScopeState?.hours ? String(primaryScopeState.hours) : null,
      hourly_rate: cr ? String(cr.hourly_rate) : null,
      notes: notes || null,
      internal_memo: internalMemo || null,
      office_notes: officeMemo || null,
      call_notes: callNotes || null,
      unit_suite: unitSuite || null,
      referral_source: referralSource || null,
      alternate_options: alternateOptions.length > 0 ? alternateOptions : null,
      zone_override: zoneOverride || null,
      address_verified: addressVerified === true,
      photo_urls: photoUploads.filter(p => !p.uploading && p.objectPath).map(p => p.objectPath),
      manual_adjustments: selectedScopes.flatMap(s => {
        const items: Array<{ scope_id: number; type: string; amount: number; reason: string }> = [];
        if (s.adjPlus > 0) items.push({ scope_id: s.scope_id, type: "add", amount: s.adjPlus, reason: s.adjPlusReason || "" });
        if (s.adjMinus > 0) items.push({ scope_id: s.scope_id, type: "subtract", amount: s.adjMinus, reason: s.adjMinusReason || "" });
        return items;
      }),
      status,
    };
  }

  async function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    e.target.value = "";
    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const previewUrl = URL.createObjectURL(file);
      setPhotoUploads(prev => [...prev, { id, objectPath: "", previewUrl, inJobNotes: true, uploading: true, name: file.name }]);
      try {
        const urlRes = await apiFetch("/api/photos/request-url", {
          method: "POST",
          body: { name: file.name, size: file.size, contentType: file.type || "image/jpeg" },
        });
        await fetch(urlRes.uploadURL, {
          method: "PUT",
          headers: { "Content-Type": file.type || "image/jpeg" },
          body: file,
        });
        setPhotoUploads(prev => prev.map(p => p.id === id ? { ...p, uploading: false, objectPath: urlRes.objectPath } : p));
      } catch {
        setPhotoUploads(prev => prev.map(p => p.id === id ? { ...p, uploading: false, error: "Upload failed" } : p));
      }
    }
  }

  function applyDiscount() {
    const code = discountInput.trim();
    if (!code) { setDiscountError("Please enter a promo code."); return; }
    setDiscountCode(code);
    discountCodeRef.current = code;
    setDiscountError("");
    selectedScopesRef.current.forEach(s => recalcScopeById(s.scope_id, 50));
  }

  function clearDiscount() {
    setDiscountCode("");
    setDiscountInput("");
    setDiscountError("");
    discountCodeRef.current = "";
    selectedScopesRef.current.forEach(s => recalcScopeById(s.scope_id, 50));
  }

  async function save(status: string = "draft", thenConvert = false) {
    setSaving(true);
    try {
      const payload = buildPayload(status);
      let result;
      const targetId = isEdit ? id : autoSavedIdRef.current;
      if (targetId) {
        result = await apiFetch(`/api/quotes/${targetId}`, { method: "PATCH", body: payload });
      } else {
        result = await apiFetch("/api/quotes", { method: "POST", body: payload });
      }
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote-stats"] });
      const savedId = result?.id ?? id;
      if (thenConvert && savedId) {
        await apiFetch(`/api/quotes/${savedId}/convert`, {
          method: "POST",
          body: {
            scheduled_date: selectedDate || undefined,
            scheduled_time: selectedTime || undefined,
            assigned_user_id: selectedTechId || undefined,
          },
        });
        toast.success("Quote converted to job.");
        navigate(selectedDate ? `/dispatch?date=${selectedDate}` : "/jobs");
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

  // ── Zip zone check ────────────────────────────────────────────────────────
  async function checkZip(zip: string) {
    const clean = zip.trim().replace(/\D/g, "").slice(0, 5);
    if (clean.length < 5) { setZipZone(null); setSuggestedTechs([]); return; }
    setCheckingZip(true);
    try {
      const zones = await apiFetch("/api/zones");
      const match = (Array.isArray(zones) ? zones : []).find((z: any) => Array.isArray(z.zip_codes) && z.zip_codes.includes(clean));
      if (match) {
        setZipZone({ name: match.name, color: match.color });
        setSuggestedTechs((match.employees ?? []).map((e: any) => ({ id: e.id, name: e.name, zone_name: match.name, zone_color: match.color })));
        setTechAvailability({});
      } else {
        setZipZone("uncovered");
        setSuggestedTechs([]);
      }
    } catch { setZipZone(null); setSuggestedTechs([]); }
    finally { setCheckingZip(false); }
  }

  // ── Tech availability (Phase 2) ──────────────────────────────────────────
  async function fetchTechAvailability(date: string) {
    if (!suggestedTechs.length || !date) return;
    setTechAvailLoading(true);
    try {
      const data = await apiFetch(`/api/dispatch?date=${date}`);
      const countMap: Record<number, number> = {};
      const techIds = new Set(suggestedTechs.map(t => t.id));
      for (const emp of (data.employees ?? [])) {
        if (techIds.has(emp.id)) {
          countMap[emp.id] = (emp.jobs ?? []).filter((j: any) => !["void", "moved", "skip", "cancelled"].includes(j.status)).length;
        }
      }
      setTechAvailability(countMap);
    } catch { /* silent */ }
    finally { setTechAvailLoading(false); }
  }

  function techAvailDot(count: number): { color: string; label: string; muted: boolean } {
    if (count === 0) return { color: "#22C55E", label: "Available", muted: false };
    if (count === 1) return { color: "#EAB308", label: "1 job that day", muted: false };
    if (count < 4) return { color: "#F97316", label: `${count} jobs that day`, muted: false };
    return { color: "#9E9B94", label: "Likely unavailable", muted: true };
  }

  // ── Returning client ─────────────────────────────────────────────────────
  function handlePhoneBlur(phone: string) {
    if (!phone || phone.trim().length < 7 || selectedClientId || returningClientDismissed) return;
    const cleaned = phone.replace(/\D/g, "");
    if (cleaned.length < 7) return;
    const tail = cleaned.slice(-7);
    const match = clients.find(c => c.phone && c.phone.replace(/\D/g, "").includes(tail));
    if (match) setReturningClient({ id: match.id, name: `${match.first_name} ${match.last_name}`, phone: match.phone, email: match.email, address: match.address });
  }

  function handleEmailBlur(email: string) {
    if (!email || !email.includes("@") || selectedClientId || returningClientDismissed) return;
    const match = clients.find(c => c.email?.toLowerCase() === email.toLowerCase());
    if (match) setReturningClient({ id: match.id, name: `${match.first_name} ${match.last_name}`, phone: match.phone, email: match.email, address: match.address });
  }

  function selectClient(c: Client) {
    setSelectedClientId(c.id);
    setClientLoaded(c);
    setClientSearch(`${c.first_name} ${c.last_name}`.trim());
    setClientDropdownOpen(false);
    setAddress(c.address || "");
    if (c.zip) { setZipCode(c.zip); checkZip(c.zip); }
    setClientBannerVisible(true);
    setTimeout(() => setClientBannerVisible(false), 4000);
    setReturningClient(null);
    setReturningClientDismissed(true);
    setReferralSource("existing_client");
    setQuickBookDismissed(false);
    setQuickBookBanner(null);
    setQuickBookPrice(null);
    setPreferredTech(null);
    setRecentServices([]);
    // Existing client with an address on file — trust it, skip geocode verification.
    // Only geocode-verify when the address is later changed to a new one.
    if (c.address) {
      setAddressVerified(true);
      setAddressFormatted([c.address, c.zip].filter(Boolean).join(", "));
    } else {
      setAddressVerified(null);
      setAddressFormatted("");
    }
    apiFetch(`/api/clients/${c.id}/quote-context`)
      .then((data: any) => {
        setPreferredTech(data.preferred_technician || null);
        setRecentServices(data.recent_services || []);
        // Pre-fill property details from client's home record
        if (data.property) {
          if (data.property.sq_footage > 0) setSqft(data.property.sq_footage);
          if (data.property.bedrooms > 0) setBedrooms(data.property.bedrooms);
          if (data.property.bathrooms > 0) setBathrooms(data.property.bathrooms);
        }
      })
      .catch(() => {});
  }

  function clearClient() {
    setSelectedClientId(null);
    setClientLoaded(null);
    setClientSearch("");
    setClientDropdownOpen(false);
    setClientBannerVisible(false);
    setReferralSource("");
    setPreferredTech(null);
    setRecentServices([]);
    setQuickBookDismissed(false);
    setQuickBookBanner(null);
    setQuickBookPrice(null);
    setAddressVerified(null);
    setAddressFormatted("");
    setAddress("");
    setZipCode("");
    setZipZone(null);
    setSuggestedTechs([]);
    setUnitSuite("");
  }

  function applyReturningClient() {
    if (!returningClient) return;
    const client = clients.find(c => c.id === returningClient.id);
    if (client) { selectClient(client); }
    setReturningClient(null);
    setReturningClientDismissed(true);
  }

  async function handleQuickBook(service: RecentService) {
    setSelectedScopes([]);
    const matchedScope = scopes.find(s => s.name.toLowerCase().trim() === service.scope.toLowerCase().trim());
    if (matchedScope) {
      await toggleScope(matchedScope, { frequency: service.frequency ?? undefined });
      setFinalScopeId(matchedScope.id);
    }
    if (preferredTech) setSelectedTechId(preferredTech.id);
    setQuickBookPrice(service.last_price);
    setQuickBookBanner({ scope: service.scope, date: service.last_date });
    setActiveSection(4);
  }

  // ── Highlight-to-push ────────────────────────────────────────────────────
  function handleCallNotesMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().length <= 3) { setCallNoteTooltip(null); return; }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    setCallNoteTooltip({ x: rect.left + rect.width / 2, y: rect.top - 8, text: sel.toString() });
  }

  function pushSelectedToJobNotes() {
    if (!callNoteTooltip) return;
    setInternalMemo(prev => prev ? `${prev}\n${callNoteTooltip.text}` : callNoteTooltip.text);
    setCallNoteTooltip(null);
    window.getSelection()?.removeAllRanges();
    setPushConfirmed(true);
    setTimeout(() => setPushConfirmed(false), 1500);
  }

  // ── Add-on display price ─────────────────────────────────────────────────
  function addonDisplayPrice(addon: PricingAddon): string {
    const pv = parseFloat(String(addon.price_value ?? addon.price ?? 0));
    switch (addon.price_type) {
      case "flat": return pv < 0 ? `($${Math.abs(pv).toFixed(2)}) discount` : `$${pv.toFixed(2)}`;
      case "percentage": return pv < 0 ? `${pv.toFixed(1)}% off` : `+${pv.toFixed(1)}%`;
      case "sqft_pct": return `${pv.toFixed(2)}% × sq.ft.`;
      case "time_only": return "No additional charge";
      case "manual_adj": return "Enter amount below";
      case "percent": return addon.percent_of_base ? `${addon.percent_of_base}% of base` : "";
      default: return pv ? `$${pv.toFixed(2)}` : "";
    }
  }

  const selectedClient = clientLoaded;
  const selectedScopeIds = selectedScopes.map(s => s.scope_id);
  const hasCustomerInfo = Boolean(selectedClientId || leadFirstName || leadEmail || address);
  const canConvert = hasCustomerInfo && selectedScopes.length > 0 && (finalScopeId !== null || selectedScopes.length === 1);

  // ── Mobile helpers ────────────────────────────────────────────────────────
  const mobileFilteredClients = mobileClientSearch.trim().length > 0
    ? clients.filter(c => `${c.first_name} ${c.last_name} ${c.email}`.toLowerCase().includes(mobileClientSearch.toLowerCase())).slice(0, 30)
    : clients.slice(0, 30);

  // ── MOBILE LAYOUT ────────────────────────────────────────────────────────
  if (isMobile) {
    const MOBILE_FINAL_STEP = 4;

    const SCOPE_CATEGORIES = [
      { label: "FLAT RATE", match: (n: string) => /deep clean|move in|one.time standard/i.test(n) },
      { label: "HOURLY", match: (n: string) => /hourly/i.test(n) },
      { label: "RECURRING", match: (n: string) => /recurring/i.test(n) },
      { label: "COMMERCIAL & SPECIALTY", match: (n: string) => /commercial|ppm|multi.unit/i.test(n) },
    ];
    const categorized: { label: string; scopes: typeof scopes }[] = [];
    const usedIds = new Set<number>();
    for (const cat of SCOPE_CATEGORIES) {
      const matched = scopes.filter(s => cat.match(s.name) && !usedIds.has(s.id));
      matched.forEach(s => usedIds.add(s.id));
      if (matched.length > 0) categorized.push({ label: cat.label, scopes: matched });
    }
    const remaining = scopes.filter(s => !usedIds.has(s.id));
    if (remaining.length > 0) categorized.push({ label: "OTHER", scopes: remaining });

    const totalEstimate = selectedScopes.reduce((sum, s) => sum + (s.calc?.final_total ?? 0), 0);
    const anyCalcLoading = selectedScopes.some(s => s.calcLoading);
    const estimatedTotalStr = selectedScopes.length === 0 ? "—" : anyCalcLoading ? "…" : `$${totalEstimate.toFixed(2)}`;

    return (
      <div style={{ minHeight: "100vh", background: "#F7F6F3", fontFamily: FF, paddingBottom: 90 }}>

        {/* Header */}
        <div style={{ position: "sticky", top: 0, zIndex: 30, background: "#FFF", borderBottom: "1px solid #E5E2DC", padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => navigate("/quotes")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, color: "#6B6860", fontSize: 14, fontFamily: FF }}>
            <ArrowLeft size={18} /> Back
          </button>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>{isEdit ? "Edit Quote" : "New Quote"}</span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "#9E9B94", fontFamily: FF }}>Step {mobileStep} of {MOBILE_FINAL_STEP}</span>
        </div>

        {/* ── STEP 1: Client + Scope ────────────────────────────────────── */}
        {mobileStep === 1 && (
          <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 24 }}>

            {/* Client */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, fontFamily: FF }}>Client</div>
              {selectedClient ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", border: "2px solid var(--brand)", borderRadius: 10, background: "#EFF6FF" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>{selectedClient.first_name} {selectedClient.last_name}</div>
                    {selectedClient.email && <div style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>{selectedClient.email}</div>}
                  </div>
                  <button onClick={() => { clearClient(); setMobileClientSearch(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#6B6860" }}>
                    <X size={18} />
                  </button>
                </div>
              ) : (
                <div style={{ position: "relative" }}>
                  <input
                    ref={mobileSearchInputRef}
                    value={mobileClientSearch}
                    onChange={e => { setMobileClientSearch(e.target.value); setMobileClientDropdown(true); }}
                    onFocus={() => setMobileClientDropdown(true)}
                    onTouchStart={(e) => e.stopPropagation()}
                    inputMode="search"
                    autoComplete="off"
                    placeholder="Search clients..."
                    style={{ width: "100%", boxSizing: "border-box", height: 48, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 16, padding: "0 14px", fontFamily: FF }}
                  />
                  {mobileClientDropdown && (
                    <div style={{ position: "absolute", top: 52, left: 0, right: 0, background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 9999, maxHeight: 260, overflowY: "auto" }}>
                      <div onClick={() => { clearClient(); setMobileClientDropdown(false); setMobileClientSearch(""); mobileSearchInputRef.current?.blur(); }} style={{ padding: "12px 14px", borderBottom: "1px solid #F0EEE9", cursor: "pointer", fontSize: 13, color: "#6B6860" }}>— Enter lead info instead</div>
                      {mobileFilteredClients.map(c => (
                        <div key={c.id} onClick={() => { selectClient(c); setMobileClientDropdown(false); setMobileClientSearch(""); mobileSearchInputRef.current?.blur(); }} style={{ padding: "12px 14px", borderBottom: "1px solid #F0EEE9", cursor: "pointer" }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{c.first_name} {c.last_name}</div>
                          <div style={{ fontSize: 12, color: "#9E9B94" }}>{c.email}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Scope cards — categorized */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Service</div>
              {categorized.map(cat => (
                <div key={cat.label}>
                  <div style={{ fontSize: 11, fontWeight: 500, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 16, marginBottom: 8, paddingLeft: 4 }}>{cat.label}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {cat.scopes.map(s => {
                      const isSel = selectedScopeIds.includes(s.id);
                      return (
                        <button key={s.id} onClick={() => toggleScope(s)} style={{ padding: "14px 12px", border: `2px solid ${isSel ? "var(--brand)" : "#E5E2DC"}`, borderRadius: 10, background: isSel ? "#EFF6FF" : "#FFF", textAlign: "center", cursor: "pointer", fontFamily: FF, minHeight: 64, fontSize: 13 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: isSel ? "var(--brand)" : "#1A1917" }}>{s.name}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── STEP 2: Property Details ──────────────────────────────────── */}
        {mobileStep === 2 && (
          <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.08em" }}>Property Details</div>
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 6 }}>Square Footage</div>
                <input type="number" value={sqft || ""} onChange={e => setSqft(parseInt(e.target.value) || 0)} placeholder="e.g. 1800" style={{ width: "100%", boxSizing: "border-box", height: 44, border: "1px solid #E5E2DC", borderRadius: 8, padding: "0 14px", fontSize: 16, fontFamily: FF, outline: "none" }} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 6 }}>Bedrooms</div>
                <Stepper value={bedrooms} onChange={setBedrooms} min={0} max={10} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 6 }}>Full Bathrooms</div>
                <Stepper value={bathrooms} onChange={setBathrooms} min={0} max={8} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 6 }}>Half Bathrooms</div>
                <Stepper value={halfBaths} onChange={setHalfBaths} min={0} max={4} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 6 }}>Pets</div>
                <Stepper value={pets} onChange={setPets} min={0} max={6} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 8 }}>Home Cleanliness</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {DIRT_LEVELS.map(d => (
                    <button key={d.value} onClick={() => setDirtLevel(d.value)} style={{ flex: 1, minWidth: 90, padding: "8px 6px", border: dirtLevel === d.value ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", borderRadius: 8, background: dirtLevel === d.value ? "#EBF4FF" : "#FFF", fontSize: 12, fontWeight: dirtLevel === d.value ? 600 : 400, color: dirtLevel === d.value ? "var(--brand)" : "#6B6860", cursor: "pointer", fontFamily: FF }}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 3: Add-ons & Notes ───────────────────────────────────── */}
        {mobileStep === 3 && (
          <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.08em" }}>Add-ons & Notes</div>
            {selectedScopes.length === 0 ? (
              <div style={{ textAlign: "center", fontSize: 14, color: "#9E9B94", padding: "24px 0" }}>No services selected. Go back to Step 1.</div>
            ) : selectedScopes.map(s => {
              const scope = scopes.find(sc => sc.id === s.scope_id);
              if (!scope) return null;
              const activeAddons = s.addons.filter(a => a.is_active);
              return (
                <div key={s.scope_id} style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", marginBottom: 12 }}>{scope.name}</div>
                  {s.frequencies.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Frequency</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {s.frequencies.map(f => (
                          <button key={f.id} onClick={() => updateScopeFrequency(s.scope_id, f.frequency)} style={{ padding: "6px 14px", borderRadius: 6, border: s.frequency === f.frequency ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: s.frequency === f.frequency ? "#EBF4FF" : "#FFF", color: s.frequency === f.frequency ? "var(--brand)" : "#6B6860", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FF }}>
                            {f.label || f.frequency}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {activeAddons.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Add-ons</div>
                      {activeAddons.map(a => (
                        <label key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #F5F3F0", cursor: "pointer" }}>
                          <input type="checkbox" checked={s.addon_ids.includes(a.id)} onChange={e => updateScopeAddon(s.scope_id, a.id, e.target.checked)} style={{ width: 18, height: 18, flexShrink: 0 }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, color: "#1A1917", fontFamily: FF }}>{a.name}</div>
                            <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>{addonDisplayPrice(a)}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                  {activeAddons.length === 0 && s.frequencies.length === 0 && (
                    <div style={{ fontSize: 13, color: "#9E9B94" }}>No add-ons available for this service.</div>
                  )}
                </div>
              );
            })}
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#1A1917", marginBottom: 10 }}>Job Notes</div>
              <textarea value={internalMemo} onChange={e => setInternalMemo(e.target.value)} placeholder="Notes for the technician..." rows={4} style={{ width: "100%", boxSizing: "border-box", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 14, padding: "10px 12px", fontFamily: FF, resize: "vertical", outline: "none" }} />
            </div>
          </div>
        )}

        {/* ── STEP 4: Review ────────────────────────────────────────────── */}
        {mobileStep === 4 && (
          <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.08em" }}>Review</div>
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Client</div>
              {selectedClient ? (
                <div style={{ fontSize: 14, color: "#1A1917", fontWeight: 600 }}>{selectedClient.first_name} {selectedClient.last_name}
                  {selectedClient.email && <span style={{ fontWeight: 400, color: "#6B6860" }}> · {selectedClient.email}</span>}
                </div>
              ) : (leadFirstName || leadEmail) ? (
                <div style={{ fontSize: 14, color: "#1A1917" }}>{[leadFirstName, leadLastName].filter(Boolean).join(" ")} {leadEmail && `· ${leadEmail}`}</div>
              ) : (
                <div style={{ fontSize: 14, color: "#9E9B94" }}>No client selected</div>
              )}
            </div>
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Services</div>
              {selectedScopes.length === 0 ? (
                <div style={{ fontSize: 14, color: "#9E9B94" }}>No services selected</div>
              ) : (
                <>
                  {selectedScopes.map(s => {
                    const scope = scopes.find(sc => sc.id === s.scope_id);
                    return (
                      <div key={s.scope_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 8, marginBottom: 8, borderBottom: "1px solid #F0EEE9" }}>
                        <span style={{ fontSize: 14, color: "#1A1917" }}>{scope?.name}</span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{s.calcLoading ? "…" : s.calc ? `$${s.calc.final_total.toFixed(2)}` : "—"}</span>
                      </div>
                    );
                  })}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Total</span>
                    <span style={{ fontSize: 20, fontWeight: 800, color: "#1A1917" }}>{estimatedTotalStr}</span>
                  </div>
                </>
              )}
            </div>
            {(sqft > 0 || bedrooms > 0 || bathrooms > 0) && (
              <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Property</div>
                <div style={{ fontSize: 14, color: "#6B6860" }}>
                  {[sqft > 0 && `${sqft} sqft`, bedrooms > 0 && `${bedrooms} bed`, bathrooms > 0 && `${bathrooms} bath`, halfBaths > 0 && `${halfBaths} half bath`, pets > 0 && `${pets} pet${pets > 1 ? "s" : ""}`].filter(Boolean).join(" · ")}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Call Notes FAB */}
        <button onClick={() => setCallNotesMobileOpen(true)} style={{ position: "fixed", bottom: 82, right: 16, zIndex: 45, width: 52, height: 52, borderRadius: "50%", background: callNotes ? "#1A1917" : "#F7F6F3", border: callNotes ? "none" : "1.5px solid #E5E2DC", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 12px rgba(0,0,0,0.18)", cursor: "pointer" }}>
          <Phone size={20} color={callNotes ? "#FFF" : "#6B6860"} />
        </button>

        {callNotesMobileOpen && (
          <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", flexDirection: "column" }}>
            <div onClick={() => setCallNotesMobileOpen(false)} style={{ flex: 1, background: "rgba(0,0,0,0.45)" }} />
            <div style={{ background: "#FFF", borderRadius: "16px 16px 0 0", padding: 24, paddingBottom: 40 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1917" }}>Call Notes</span>
                <button onClick={() => setCallNotesMobileOpen(false)} style={{ background: "none", border: "none", cursor: "pointer" }}><X size={20} color="#6B6860" /></button>
              </div>
              <textarea value={callNotes} onChange={e => setCallNotes(e.target.value)} placeholder="Notes from this call..." rows={6} style={{ width: "100%", boxSizing: "border-box", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 14, padding: "10px 12px", resize: "none", outline: "none" }} />
            </div>
          </div>
        )}

        {/* Bottom bar */}
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#FFF", borderTop: "0.5px solid #E5E2DC", padding: "12px 16px", paddingBottom: "calc(12px + env(safe-area-inset-bottom))", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, zIndex: 100 }}>
          <div>
            <div style={{ fontSize: 11, color: "#6B6860" }}>Estimated Total</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#1A1917" }}>{estimatedTotalStr}</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => save("draft")}
              disabled={saving || selectedScopes.length === 0}
              style={{ height: 44, padding: "0 16px", background: "transparent", color: saving || selectedScopes.length === 0 ? "#D1D5DB" : "#374151", border: `1px solid ${saving || selectedScopes.length === 0 ? "#E5E2DC" : "#D1D5DB"}`, borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: saving || selectedScopes.length === 0 ? "default" : "pointer", fontFamily: FF }}
            >
              {saving ? "Saving..." : "Save Draft"}
            </button>
            {mobileStep < MOBILE_FINAL_STEP ? (
              <button
                onClick={() => { setMobileStep(s => s + 1); window.scrollTo(0, 0); }}
                style={{ height: 44, padding: "0 20px", background: "var(--brand)", color: "#FFF", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FF }}
              >
                Next →
              </button>
            ) : (
              <button
                onClick={() => save("draft")}
                disabled={saving || selectedScopes.length === 0}
                style={{ height: 44, padding: "0 20px", background: saving || selectedScopes.length === 0 ? "#D1D5DB" : "var(--brand)", color: "#FFF", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: saving || selectedScopes.length === 0 ? "default" : "pointer", fontFamily: FF }}
              >
                {saving ? "Saving..." : "Save Quote"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── DESKTOP LAYOUT ────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen" style={{ background: "#F7F6F3", fontFamily: FF }}>

      {/* Highlight-to-push tooltip */}
      {callNoteTooltip && (
        <div
          style={{ position: "fixed", left: callNoteTooltip.x, top: callNoteTooltip.y, transform: "translateX(-50%) translateY(-100%)", background: "#1A1917", color: "#FFF", fontSize: 12, borderRadius: 4, padding: "4px 10px", zIndex: 9999, whiteSpace: "nowrap", cursor: "pointer", userSelect: "none", boxShadow: "0 2px 8px rgba(0,0,0,0.3)" }}
          onMouseDown={e => e.preventDefault()}
          onClick={pushSelectedToJobNotes}
        >
          Push to Job Notes
        </div>
      )}

      {/* Header */}
      <div style={{ borderBottom: "1px solid #E5E2DC", background: "#FFF", padding: "14px 24px", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 50 }}>
        <Button variant="ghost" size="sm" onClick={() => navigate("/quotes")} className="gap-1.5 text-[#6B7280]">
          <ArrowLeft className="w-4 h-4" /> Back to Quotes
        </Button>
        <div className="h-5 w-px bg-[#E5E2DC]" />
        <h1 style={{ fontSize: 18, fontWeight: 600, color: "#1A1917" }}>{isEdit ? "Edit Quote" : "New Quote"}</h1>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => save("draft")} disabled={saving} className="gap-1.5 text-[#1A1917]">
            <Save className="w-4 h-4" /> Save Draft
          </Button>
          <Button size="sm" variant="outline" onClick={() => save("sent")} disabled={saving} className="gap-1.5">
            <SendHorizonal className="w-4 h-4" /> Save & Send
          </Button>
          <Button size="sm" onClick={() => save("draft", true)} disabled={saving || !canConvert} style={{ background: "var(--brand)", color: "#FFF" }} className="gap-1.5 hover:opacity-90">
            <ArrowRight className="w-4 h-4" /> Save & Convert to Job
          </Button>
        </div>
      </div>

      {/* Two-column body */}
      <div style={{ display: "grid", gridTemplateColumns: "58fr 42fr", gap: 20, padding: "24px", alignItems: "flex-start", paddingBottom: 80 }}>

        {/* ── LEFT: Wizard ──────────────────────────────────────────────── */}
        <div style={{ minWidth: 0 }}>

          {/* Step tabs */}
          <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
            {SECTION_LABELS.map((label, i) => {
              const Icon = SECTION_ICONS[i];
              const isActive = activeSection === i;
              return (
                <button key={i} onClick={() => setActiveSection(i)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: FF, cursor: "pointer", border: "none", transition: "all 0.15s", background: isActive ? "var(--brand)" : "#F7F6F3", color: isActive ? "#FFF" : "#6B6860" }}>
                  <Icon style={{ width: 14, height: 14 }} />
                  {label}
                  {sectionComplete[i] && !isActive && <span style={{ width: 6, height: 6, background: "#22C55E", borderRadius: "50%", display: "inline-block" }} />}
                </button>
              );
            })}
          </div>

          {/* ── Section 0: Customer Info ─────────────────────────────── */}
          {activeSection === 0 && (
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 24 }}>
              <div className="space-y-4">

                {/* Existing client search — custom combobox */}
                <div ref={clientSearchRef} style={{ position: "relative" }}>
                  <Label className="text-xs text-[#9E9B94] mb-1 block">Existing Client</Label>
                  {/* Input */}
                  <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                    <svg style={{ position: "absolute", left: 12, width: 16, height: 16, color: "#6B6860", flexShrink: 0, pointerEvents: "none" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                    <input
                      value={clientSearch}
                      onChange={e => { setClientSearch(e.target.value); if (selectedClientId) clearClient(); }}
                      onFocus={() => { if (clientSearch.trim().length >= 2 && !selectedClientId) setClientDropdownOpen(true); }}
                      onKeyDown={e => { if (e.key === "Escape") setClientDropdownOpen(false); }}
                      placeholder="Search by client name, address, or phone..."
                      readOnly={!!selectedClientId}
                      style={{
                        width: "100%", height: 40, border: `1px solid ${clientDropdownOpen ? "#5B9BD5" : "#E5E2DC"}`, borderRadius: 8, background: selectedClientId ? "#F7F6F3" : "#FFF",
                        padding: "0 36px 0 36px", fontSize: 14, fontFamily: FF, outline: "none", cursor: selectedClientId ? "default" : "text", boxSizing: "border-box",
                      }}
                    />
                    {selectedClientId && (
                      <button onClick={clearClient} style={{ position: "absolute", right: 10, background: "none", border: "none", cursor: "pointer", color: "#9E9B94", display: "flex", alignItems: "center" }}>
                        <X size={15} />
                      </button>
                    )}
                  </div>

                  {/* Green confirmation banner */}
                  {clientBannerVisible && clientLoaded && (
                    <div style={{ marginTop: 6, background: "#EAF3DE", border: "1px solid #639922", borderRadius: 6, padding: "6px 12px", fontSize: 12, color: "#3B6D11", fontFamily: FF }}>
                      Client loaded — {clientLoaded.first_name} {clientLoaded.last_name}
                    </div>
                  )}

                  {/* Dropdown */}
                  {clientDropdownOpen && !selectedClientId && (
                    <div style={{ position: "absolute", top: 46, left: 0, right: 0, zIndex: 50, background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.08)", maxHeight: 280, overflowY: "auto" }}>
                      {/* Enter lead info instead */}
                      <div
                        onClick={() => { clearClient(); setClientDropdownOpen(false); }}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "#F7F6F3", borderBottom: "1px solid #E5E2DC", cursor: "pointer", fontSize: 13, color: "#5B9BD5", fontWeight: 500, fontFamily: FF }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#EBF4FF")}
                        onMouseLeave={e => (e.currentTarget.style.background = "#F7F6F3")}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth={2.5}><path d="M12 5v14M5 12h14"/></svg>
                        Enter lead info instead
                      </div>

                      {/* Loading */}
                      {clientSearchLoading && (
                        <div style={{ padding: "12px 14px", fontSize: 13, color: "#6B6860", fontFamily: FF }}>Searching...</div>
                      )}

                      {/* No results */}
                      {!clientSearchLoading && clientResults.length === 0 && clientSearch.trim().length >= 2 && (
                        <>
                          <div style={{ padding: "12px 14px", fontSize: 13, color: "#9E9B94", fontFamily: FF }}>No clients found for "{clientSearch.trim()}"</div>
                          <div onClick={() => { clearClient(); setClientDropdownOpen(false); }} style={{ padding: "10px 14px", fontSize: 13, color: "var(--brand)", fontFamily: FF, cursor: "pointer", borderTop: "1px solid #F0EDE8" }}>
                            Create new lead instead →
                          </div>
                        </>
                      )}

                      {/* Results */}
                      {!clientSearchLoading && clientResults.map(c => {
                        // Frequency label
                        const freqMap: Record<string, string> = {
                          weekly: "Weekly", every_2_weeks: "Biweekly", biweekly: "Biweekly",
                          every_4_weeks: "Monthly", monthly: "Monthly",
                          onetime: "One-Time", one_time: "One-Time",
                        };
                        const freqLabel = c.frequency ? (freqMap[c.frequency] ?? null) : null;

                        // Last service date
                        const fmtSvcDate = (d: string | null | undefined) => {
                          if (!d) return null;
                          const dt = new Date(d + "T12:00:00");
                          const now = new Date();
                          const sameYear = dt.getFullYear() === now.getFullYear();
                          return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
                        };
                        const lastDoneStr = c.last_service_date ? fmtSvcDate(c.last_service_date) : null;
                        const nextJobStr  = c.next_job_date     ? fmtSvcDate(c.next_job_date)     : null;

                        return (
                          <div
                            key={c.id}
                            onClick={() => selectClient(c)}
                            style={{ padding: "10px 14px", borderBottom: "1px solid #F0EDE8", cursor: "pointer" }}
                            onMouseEnter={e => (e.currentTarget.style.background = "#F7F6F3")}
                            onMouseLeave={e => (e.currentTarget.style.background = "#FFF")}
                          >
                            {/* Line 1: Name + Frequency badge */}
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                              <span style={{ fontSize: 14, fontWeight: 500, color: "#1A1917", fontFamily: FF }}>{c.first_name} {c.last_name}</span>
                              {freqLabel && (
                                <span style={{ fontSize: 10, fontWeight: 500, color: "#4A4845", background: "#F0EDE8", borderRadius: 10, padding: "2px 7px", flexShrink: 0, fontFamily: FF }}>{freqLabel}</span>
                              )}
                            </div>
                            {/* Line 2: Zone dot + address (left) · last done / next (right) */}
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 3, gap: 8 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                <span
                                  title={c.zone_name || "No zone"}
                                  style={{ width: 10, height: 10, borderRadius: "50%", background: c.zone_color || "#B4B2A9", flexShrink: 0, display: "inline-block" }}
                                />
                                <span style={{ fontSize: 12, color: "#4A4845", fontFamily: FF, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {c.address || c.phone || c.email || ""}
                                </span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0, fontSize: 11, fontFamily: FF }}>
                                <span style={{ color: "#6B6860" }}>Last done: {lastDoneStr || "—"}</span>
                                <span style={{ color: "#C5C0B8", margin: "0 4px" }}>·</span>
                                <span style={{ color: nextJobStr ? "#6B6860" : "#A32D2D" }}>Next: {nextJobStr || "none"}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Lead fields */}
                {!selectedClientId && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">First Name</Label>
                      <Input value={leadFirstName} onChange={e => setLeadFirstName(e.target.value)} placeholder="Jane" className="mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Last Name</Label>
                      <Input value={leadLastName} onChange={e => setLeadLastName(e.target.value)} placeholder="Doe" className="mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Email</Label>
                      <Input value={leadEmail} onChange={e => setLeadEmail(e.target.value)} onBlur={e => handleEmailBlur(e.target.value)} placeholder="jane@example.com" type="email" className="mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Phone</Label>
                      <Input value={leadPhone} onChange={e => setLeadPhone(e.target.value)} onBlur={e => handlePhoneBlur(e.target.value)} placeholder="(555) 000-0000" className="mt-1" />
                    </div>
                  </div>
                )}

                {/* Returning client banner */}
                {returningClient && !selectedClientId && (
                  <div style={{ background: "#EBF4FF", border: "1px solid #5B9BD5", borderRadius: 6, padding: "8px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>Returning client — {returningClient.name}</div>
                      {returningClient.address && <div style={{ fontSize: 12, color: "#5B9BD5", marginTop: 2 }}>{returningClient.address}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                      <button onClick={applyReturningClient} style={{ fontSize: 12, fontWeight: 600, color: "#2563EB", background: "#DBEAFE", border: "none", cursor: "pointer", padding: "4px 10px", borderRadius: 4 }}>Use this client</button>
                      <button onClick={() => { setReturningClient(null); setReturningClientDismissed(true); }} style={{ fontSize: 12, color: "#6B7280", background: "none", border: "none", cursor: "pointer", padding: "4px 8px" }}>Not them</button>
                    </div>
                  </div>
                )}

                {/* Address + Zip */}
                <div className="flex gap-3">
                  <div className="flex-1">
                    <Label className="text-xs">Service Address</Label>
                    <input
                      ref={el => { (addressInputRef as any).current = el; if (el && !inputMounted) setInputMounted(true); }}
                      value={address}
                      onChange={e => { setAddress(e.target.value); setAddressVerified(null); setAddressFormatted(""); }}
                      placeholder="123 Main St, City, State"
                      className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </div>
                  <div style={{ width: 120 }}>
                    <Label className="text-xs">Zip Code</Label>
                    <Input value={zipCode} onChange={e => setZipCode(e.target.value)} onBlur={e => checkZip(e.target.value)} placeholder="60453" maxLength={5} className="mt-1" />
                  </div>
                </div>

                {/* Inline address verification + zone pill row */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minHeight: 20 }}>
                  {address.trim().length > 5 && addressVerified === true && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#3B6D11", fontFamily: FF }}>
                      <Check style={{ width: 13, height: 13 }} /> Verified
                    </span>
                  )}
                  {address.trim().length > 5 && addressVerified === false && (
                    <span style={{ fontSize: 11, color: "#854F0B", fontFamily: FF }}>
                      Not verified — select from suggestions
                    </span>
                  )}
                  {checkingZip && <span style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>Checking zone...</span>}
                  {!checkingZip && zipZone && zipZone !== "uncovered" && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600, background: `${zipZone.color || "#639922"}18`, color: zipZone.color || "#639922", border: `1px solid ${zipZone.color || "#639922"}40`, fontFamily: FF }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: zipZone.color || "#639922" }} />
                      {zipZone.name}
                    </span>
                  )}
                </div>
                {!checkingZip && zipZone === "uncovered" && zipCode.trim().length === 5 && (
                  <div style={{ borderLeft: "3px solid #A32D2D", paddingLeft: 10, fontSize: 12, color: "#791F1F", fontFamily: FF }}>
                    We don't currently service {zipCode}. Quote can still be saved.
                    <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 12, color: "#6B6860", cursor: "pointer" }}>
                      <Checkbox checked={zoneOverride} onCheckedChange={v => setZoneOverride(Boolean(v))} />
                      Override — office confirmed.
                    </label>
                  </div>
                )}

                {/* Unit / Suite / Access Instructions */}
                <div>
                  <Label className="text-xs">Unit, Suite, or Additional Access Instructions</Label>
                  <Input value={unitSuite} onChange={e => setUnitSuite(e.target.value)} placeholder="e.g. Apt 2B, gate code #1234, leave key under mat..." className="mt-1" />
                </div>

                {/* Compact tech suggestion row */}
                {suggestedTechs.length > 0 && !zoneOverride && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>Zone techs:</span>
                    {suggestedTechs.map(tech => {
                      const isSel = selectedTechId === tech.id;
                      return (
                        <button key={tech.id} onClick={() => setSelectedTechId(isSel ? null : tech.id)}
                          style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 14, fontSize: 12, fontWeight: isSel ? 600 : 400, border: isSel ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: isSel ? "#EAF9F4" : "#FFF", color: "#1A1917", cursor: "pointer", fontFamily: FF }}>
                          <span style={{ width: 18, height: 18, borderRadius: "50%", background: isSel ? "var(--brand)" : "#E5E2DC", display: "flex", alignItems: "center", justifyContent: "center", color: isSel ? "#FFF" : "#6B6860", fontSize: 9, fontWeight: 700 }}>{tech.name.charAt(0)}</span>
                          {tech.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                {!checkingZip && suggestedTechs.length === 0 && zipZone && zipZone !== "uncovered" && !zoneOverride && (
                  <span style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>No techs in zone — will be unassigned</span>
                )}

                {/* How did you hear about us? — only for new leads */}
                {!selectedClientId && (
                  <div>
                    <Label className="text-xs">How did you hear about us?</Label>
                    <select
                      value={referralSource}
                      onChange={e => setReferralSource(e.target.value)}
                      className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                      style={{ height: 36 }}
                    >
                      <option value="">Select…</option>
                      <option value="Google">Google</option>
                      <option value="Facebook">Facebook</option>
                      <option value="Instagram">Instagram</option>
                      <option value="Nextdoor">Nextdoor</option>
                      <option value="Yelp">Yelp</option>
                      <option value="Referral - Friend/Family">Referral — Friend / Family</option>
                      <option value="Referral - Previous Client">Referral — Previous Client</option>
                      <option value="Door Hanger / Flyer">Door Hanger / Flyer</option>
                      <option value="Yard Sign">Yard Sign</option>
                      <option value="Online Booking">Online Booking</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                )}

                {/* ── Preferred Tech — compact inline row ── */}
                {selectedClientId && preferredTech && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>Preferred:</span>
                    <button
                      onClick={() => setSelectedTechId(selectedTechId === preferredTech.id ? null : preferredTech.id)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 14, fontSize: 12, fontWeight: selectedTechId === preferredTech.id ? 600 : 400, border: selectedTechId === preferredTech.id ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: selectedTechId === preferredTech.id ? "#EAF9F4" : "#FFF", color: "#1A1917", cursor: "pointer", fontFamily: FF }}
                    >
                      <span style={{ width: 18, height: 18, borderRadius: "50%", background: selectedTechId === preferredTech.id ? "var(--brand)" : "#5B9BD5", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFF", fontSize: 9, fontWeight: 700 }}>{preferredTech.full_name.charAt(0)}</span>
                      {preferredTech.full_name}
                      {selectedTechId === preferredTech.id && <Check style={{ width: 12, height: 12, color: "var(--brand)" }} />}
                    </button>
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button size="sm" style={{ background: "var(--brand)", color: "#FFF" }} className="gap-1.5 hover:opacity-90" onClick={() => setActiveSection(1)}>
                    Next: Service &amp; Pricing <ArrowRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ── Section 1: Service & Pricing ─────────────────────────── */}
          {activeSection === 1 && (
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 24 }}>

              {/* sqft missing notice */}
              {sqft === 0 && (
                <div style={{ background: "#FAEEDA", border: "1px solid #BA7517", borderRadius: 6, padding: "8px 12px", fontSize: 12, color: "#854F0B", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
                  <AlertCircle style={{ width: 14, height: 14, flexShrink: 0 }} />
                  Property details incomplete — prices are estimated. Go back to Property Details (Step 3) to enter sqft.
                </div>
              )}

              {/* ── Quick Book panel (existing client only) ── */}
              {selectedClientId && recentServices.length > 0 && !quickBookDismissed && (
                <div style={{ background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: "14px 16px", marginBottom: 20 }}>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>Quick Re-Book</div>
                    <div style={{ fontSize: 11, color: "#6B6860", marginTop: 1, fontFamily: FF }}>Re-book a previous service at the same price — skips straight to Review</div>
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {recentServices.map((svc, i) => {
                      const lastDate = (() => {
                        try {
                          const d = new Date(svc.last_date + "T12:00:00");
                          return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                        } catch { return svc.last_date; }
                      })();
                      const freqMap: Record<string, string> = { weekly: "Weekly", every_2_weeks: "Biweekly", biweekly: "Biweekly", every_4_weeks: "Monthly", monthly: "Monthly", onetime: "One-Time", one_time: "One-Time" };
                      const freqLabel = svc.frequency ? (freqMap[svc.frequency] ?? svc.frequency) : null;
                      return (
                        <div
                          key={i}
                          onClick={() => handleQuickBook(svc)}
                          style={{ background: "#FFFFFF", border: "0.5px solid #E5E2DC", borderRadius: 8, padding: "10px 14px", minWidth: 180, cursor: "pointer", transition: "border-color 0.15s, background 0.15s" }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--brand)"; (e.currentTarget as HTMLElement).style.background = "#EAF9F4"; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#E5E2DC"; (e.currentTarget as HTMLElement).style.background = "#FFFFFF"; }}
                        >
                          <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1917", fontFamily: FF }}>{svc.scope}</div>
                          <div style={{ fontSize: 11, color: "#6B6860", marginTop: 2, fontFamily: FF }}>Last: {lastDate}</div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                            <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1917", fontFamily: FF }}>
                              ${svc.last_price > 0 ? svc.last_price.toLocaleString("en-US") : "\u2014"}
                            </div>
                            {freqLabel && (
                              <span style={{ fontSize: 10, background: "#F0EDE8", color: "#4A4845", borderRadius: 10, padding: "2px 6px", fontFamily: FF }}>{freqLabel}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => setQuickBookDismissed(true)}
                    style={{ marginTop: 10, fontSize: 12, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: FF, padding: 0, fontWeight: 500 }}
                  >
                    Build custom quote instead
                  </button>
                </div>
              )}

              {/* Scope cards — grouped by scope_group */}
              {(() => {
                const isCommercialClient = clientLoaded?.client_type === "commercial";
                const GROUP_ORDER = isCommercialClient
                  ? ["commercial", "hourly"]
                  : ["residential", "recurring cleaning", "hourly"];
                const GROUP_LABELS: Record<string, string> = {
                  "residential": "One-Time / Flat Rate",
                  "recurring cleaning": "Recurring",
                  "hourly": "Hourly",
                  "commercial": "Commercial",
                };
                const grouped = new Map<string, typeof scopes>();
                for (const s of scopes) {
                  const g = (s.scope_group || "other").toLowerCase();
                  if (!grouped.has(g)) grouped.set(g, []);
                  grouped.get(g)!.push(s);
                }
                const orderedGroups = GROUP_ORDER.filter(g => grouped.has(g));

                return (
                  <div style={{ marginBottom: 20 }}>
                    {orderedGroups.map(groupKey => {
                      const groupScopes = grouped.get(groupKey) || [];
                      const label = GROUP_LABELS[groupKey] || groupKey.charAt(0).toUpperCase() + groupKey.slice(1);
                      const groupHasSelection = groupScopes.some(s => selectedScopeIds.includes(s.id));

                      // ── Special Hourly rendering: single card + sub-type selector ──
                      if (groupKey === "hourly") {
                        const hourlySelected = groupHasSelection;
                        const HOURLY_SUBS = [
                          { key: "standard", label: "Standard Cleaning", scopeMatch: /hourly.*standard/i },
                          { key: "deep", label: "Deep Clean", scopeMatch: /hourly.*deep/i },
                          { key: "moveinout", label: "Move In / Move Out", scopeMatch: /hourly.*(move|in.*out)/i },
                          { key: "other", label: "Other", scopeMatch: null },
                        ];
                        return (
                          <div key={groupKey} style={{ marginBottom: 16 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: "#4A4845", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: FF }}>{label}</div>
                              {hourlySelected && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--brand)", display: "inline-block" }} />}
                              <div style={{ flex: 1, height: 1, background: "#E5E2DC" }} />
                            </div>
                            {/* Single Hourly card */}
                            <div
                              onClick={() => {
                                if (hourlyExpanded) {
                                  // Collapse: deselect all hourly scopes
                                  groupScopes.forEach(s => { if (selectedScopeIds.includes(s.id)) toggleScope(s); });
                                  setHourlyExpanded(false);
                                  setHourlySubType(null);
                                } else {
                                  setHourlyExpanded(true);
                                }
                              }}
                              style={{
                                border: hourlySelected ? "1.5px solid var(--brand)" : "0.5px solid #E5E2DC",
                                background: hourlySelected ? "#EAF9F4" : "#FFFFFF",
                                borderRadius: 10, padding: "12px 14px", cursor: "pointer", transition: "all 0.15s",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1917", fontFamily: FF }}>
                                  Hourly{hourlySubType ? ` — ${HOURLY_SUBS.find(s => s.key === hourlySubType)?.label}` : ""}
                                </div>
                                <Checkbox checked={hourlyExpanded || hourlySelected} onCheckedChange={() => {
                                  if (hourlyExpanded) {
                                    groupScopes.forEach(s => { if (selectedScopeIds.includes(s.id)) toggleScope(s); });
                                    setHourlyExpanded(false);
                                    setHourlySubType(null);
                                  } else { setHourlyExpanded(true); }
                                }} onClick={e => e.stopPropagation()} />
                              </div>
                            </div>
                            {/* Sub-type options (shown when expanded) */}
                            {hourlyExpanded && (
                              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8, paddingLeft: 12 }}>
                                {HOURLY_SUBS.map(sub => {
                                  const isActive = hourlySubType === sub.key;
                                  return (
                                    <button
                                      key={sub.key}
                                      onClick={() => {
                                        // Deselect previous hourly scope
                                        groupScopes.forEach(s => { if (selectedScopeIds.includes(s.id)) toggleScope(s); });
                                        setHourlySubType(sub.key);
                                        // Select matching scope
                                        if (sub.scopeMatch) {
                                          const match = groupScopes.find(s => sub.scopeMatch!.test(s.name));
                                          if (match) toggleScope(match);
                                        } else {
                                          // "Other" — select first hourly scope as fallback
                                          if (groupScopes[0]) toggleScope(groupScopes[0]);
                                        }
                                      }}
                                      style={{
                                        padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: isActive ? 600 : 400,
                                        border: isActive ? "1.5px solid var(--brand)" : "1px solid #E5E2DC",
                                        background: isActive ? "#EAF9F4" : "#FFF",
                                        color: isActive ? "#0A0E1A" : "#6B6860",
                                        cursor: "pointer", fontFamily: FF, textAlign: "left" as const,
                                      }}
                                    >
                                      {sub.label}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      }

                      // ── Standard group rendering ──
                      return (
                        <div key={groupKey} style={{ marginBottom: 16 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#4A4845", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: FF }}>{label}</div>
                            {groupHasSelection && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--brand)", display: "inline-block" }} />}
                            <div style={{ flex: 1, height: 1, background: "#E5E2DC" }} />
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            {groupScopes.map(scope => {
                              const isSel = selectedScopeIds.includes(scope.id);
                              const selState = selectedScopes.find(s => s.scope_id === scope.id);
                              const priceText = selState?.calcLoading
                                ? "..."
                                : selState?.calc
                                  ? `$${selState.calc.final_total.toFixed(2)}`
                                  : "";
                              return (
                                <div
                                  key={scope.id}
                                  onClick={() => toggleScope(scope)}
                                  style={{
                                    position: "relative",
                                    border: isSel ? "1.5px solid var(--brand)" : "0.5px solid #E5E2DC",
                                    background: isSel ? "#EAF9F4" : "#FFFFFF",
                                    borderRadius: 10, padding: "12px 14px 10px", cursor: "pointer",
                                    transition: "all 0.15s", minHeight: 70,
                                    display: "flex", flexDirection: "column" as const, justifyContent: "space-between",
                                  }}
                                >
                                  <div style={{ position: "absolute", top: 10, right: 10 }}>
                                    <Checkbox checked={isSel} onCheckedChange={() => toggleScope(scope)} onClick={e => e.stopPropagation()} />
                                  </div>
                                  <div>
                                    <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1917", paddingRight: 28, fontFamily: FF }}>{scope.name}</div>
                                    {selState?.frequency && (
                                      <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2, fontFamily: FF }}>{selState.frequency}</div>
                                    )}
                                  </div>
                                  {priceText && (
                                    <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", textAlign: "right", marginTop: 6, fontFamily: FF }}>
                                      {priceText}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {selectedScopes.length === 0 && (
                      <div style={{ textAlign: "center", fontSize: 13, color: "#9E9B94", marginTop: 8, fontFamily: FF }}>
                        Select one or more service options to build this quote.
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Date picker */}
              <div style={{ marginBottom: selectedDate && suggestedTechs.length > 0 ? 16 : 0 }}>
                <Label className="text-xs">Preferred Date</Label>
                <input type="date" value={selectedDate}
                  onChange={e => { setSelectedDate(e.target.value); fetchTechAvailability(e.target.value); }}
                  style={{ display: "block", width: "100%", marginTop: 4, height: 38, border: "1px solid #E5E2DC", borderRadius: 8, padding: "0 12px", fontSize: 14, color: "#1A1917", fontFamily: FF, background: "#FFF", outline: "none", boxSizing: "border-box" }}
                />
              </div>

              {/* Tech availability (Phase 2) */}
              {suggestedTechs.length > 0 && selectedDate && (
                <div style={{ background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: 12, marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                    Technician Availability
                    {techAvailLoading && <span style={{ fontSize: 11, fontWeight: 400, color: "#9E9B94", textTransform: "none" }}>Loading...</span>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {[...suggestedTechs].sort((a, b) => (techAvailability[a.id] ?? 0) - (techAvailability[b.id] ?? 0)).map(tech => {
                      const count = techAvailability[tech.id];
                      const avail = count !== undefined ? techAvailDot(count) : null;
                      const isSel = selectedTechId === tech.id;
                      return (
                        <div key={tech.id} onClick={() => setSelectedTechId(isSel ? null : tech.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6, cursor: "pointer", border: isSel ? "2px solid var(--brand)" : "1px solid #E5E2DC", background: isSel ? "rgba(0,201,160,0.05)" : "#FFF", opacity: avail?.muted ? 0.55 : 1 }}>
                          <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFF", fontSize: 11, fontWeight: 700 }}>{tech.name.charAt(0).toUpperCase()}</div>
                          <div style={{ flex: 1, fontSize: 13, fontWeight: isSel ? 700 : 500, color: "#1A1917" }}>{tech.name}</div>
                          {avail && (
                            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: avail.color, flexShrink: 0 }}>
                              <div style={{ width: 7, height: 7, borderRadius: "50%", background: avail.color }} />
                              {avail.label}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Discount code section */}
              {selectedScopes.length > 0 && (
                <div style={{ marginTop: 16, padding: "14px 16px", background: "#F7F6F3", border: "0.5px solid #E5E2DC", borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", marginBottom: 8, fontFamily: FF }}>Promo / Discount Code</div>
                  {discountCode ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, fontFamily: FF, color: "#1A1917", fontWeight: 600 }}>{discountCode}</span>
                      <span style={{ fontSize: 11, color: "#16A34A", fontFamily: FF }}>applied</span>
                      <button onClick={clearDiscount} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11, color: "#6B6860", background: "none", border: "1px solid #E5E2DC", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontFamily: FF }}>
                        <X size={10} /> Remove
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 6, flexDirection: "column" }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <input
                          type="text"
                          value={discountInput}
                          onChange={e => { setDiscountInput(e.target.value.toUpperCase()); setDiscountError(""); }}
                          onKeyDown={e => e.key === "Enter" && applyDiscount()}
                          placeholder="e.g. PHES10OFF"
                          style={{ flex: 1, height: 34, border: "1px solid #E5E2DC", borderRadius: 6, padding: "0 10px", fontSize: 13, fontFamily: FF, outline: "none", background: "#FFF", textTransform: "uppercase" }}
                        />
                        <button
                          onClick={applyDiscount}
                          style={{ padding: "0 14px", height: 34, background: "#1A1917", color: "#FFF", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF, whiteSpace: "nowrap" }}
                        >
                          Apply
                        </button>
                      </div>
                      {discountError && <div style={{ fontSize: 11, color: "#DC2626", fontFamily: FF }}>{discountError}</div>}
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-between mt-4">
                <Button size="sm" variant="ghost" onClick={() => setActiveSection(0)}>Back</Button>
                <Button
                  size="sm"
                  onClick={() => setActiveSection(2)}
                  disabled={selectedScopes.length === 0}
                  style={selectedScopes.length === 0 ? { background: "#D1D5DB", color: "#9E9B94", cursor: "not-allowed" } : { background: "var(--brand)", color: "#FFF" }}
                  className="gap-1.5 hover:opacity-90"
                >
                  Next: Property Details <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* ── Section 2: Property Details ──────────────────────────── */}
          {activeSection === 2 && (
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 24 }}>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <Label className="text-xs">Square Footage</Label>
                  <Input type="number" value={sqft || ""} onChange={e => setSqft(parseInt(e.target.value) || 0)} placeholder="e.g. 1800" className="mt-1" />
                </div>
                <div>
                  <Label className="text-xs">Bedrooms</Label>
                  <Stepper value={bedrooms} onChange={setBedrooms} min={0} max={10} />
                </div>
                <div>
                  <Label className="text-xs">Full Bathrooms</Label>
                  <Stepper value={bathrooms} onChange={setBathrooms} min={0} max={8} />
                </div>
                <div>
                  <Label className="text-xs">Half Bathrooms</Label>
                  <Stepper value={halfBaths} onChange={setHalfBaths} min={0} max={4} />
                </div>
                <div>
                  <Label className="text-xs">Pets</Label>
                  <Stepper value={pets} onChange={setPets} min={0} max={6} />
                </div>
                <div className="col-span-2">
                  <Label className="text-xs">How would you rate the current cleanliness of your home?</Label>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    {DIRT_LEVELS.map(d => (
                      <button key={d.value} onClick={() => setDirtLevel(d.value)} style={{ flex: 1, padding: "8px 6px", border: dirtLevel === d.value ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", borderRadius: 8, background: dirtLevel === d.value ? "#EBF4FF" : "#FFF", fontSize: 12, fontWeight: dirtLevel === d.value ? 600 : 400, color: dirtLevel === d.value ? "var(--brand)" : "#6B6860", cursor: "pointer", fontFamily: FF, textAlign: "center" as const }}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-between mt-6">
                <Button size="sm" variant="ghost" onClick={() => setActiveSection(1)}>Back</Button>
                <Button size="sm" style={{ background: "var(--brand)", color: "#FFF" }} className="gap-1.5 hover:opacity-90" onClick={() => setActiveSection(3)}>
                  Next: Add-ons &amp; Notes <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* ── Section 3: Add-ons & Notes ───────────────────────────── */}
          {activeSection === 3 && (
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 24 }}>

              {selectedScopes.length === 0 ? (
                <div style={{ textAlign: "center", fontSize: 14, color: "#9E9B94", padding: "24px 0" }}>
                  No scopes selected. <button onClick={() => setActiveSection(1)} style={{ color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Go back to Service &amp; Pricing</button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                  {/* A. Quote-level Frequency picker */}
                  {(() => {
                    const allFreqs = selectedScopes.flatMap(s => s.frequencies);
                    const uniqueFreqs = Array.from(new Map(allFreqs.map(f => [f.frequency, f])).values());
                    const currentFreq = selectedScopes[0]?.frequency || "onetime";
                    if (uniqueFreqs.length === 0) return null;
                    return (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#4A4845", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8, fontFamily: FF }}>Frequency</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {uniqueFreqs.map(f => {
                            const isActive = currentFreq === f.frequency;
                            return (
                              <button key={f.frequency} onClick={() => selectedScopes.forEach(s => updateScopeFrequency(s.scope_id, f.frequency))}
                                style={{ padding: "6px 14px", borderRadius: 8, border: isActive ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: isActive ? "#EAF9F4" : "#FFF", color: isActive ? "#0A0E1A" : "#6B6860", fontSize: 12, fontWeight: isActive ? 600 : 400, cursor: "pointer", fontFamily: FF }}>
                                {f.label || f.frequency}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {/* B. Scope summary cards (collapsed by default) */}
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#4A4845", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8, fontFamily: FF }}>Services on this quote</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {selectedScopes.map(s => {
                        const scope = scopes.find(sc => sc.id === s.scope_id);
                        if (!scope) return null;
                        const isHourly = scope.pricing_method === "hourly" || scope.pricing_method === "simplified";
                        const estHours = s.hours || s.calc?.base_hours || 0;
                        const subtotal = s.calcLoading ? "..." : s.calc ? `$${s.calc.final_total.toFixed(2)}` : (isHourly && !s.hours ? "Enter hours" : "\u2014");
                        return (
                          <div key={s.scope_id} style={{ border: "0.5px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
                            <button
                              onClick={() => setSelectedScopes(prev => prev.map(ss => ss.scope_id === s.scope_id ? { ...ss, expanded: !ss.expanded } : ss))}
                              style={{ width: "100%", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, background: s.expanded ? "#FAFAF9" : "#FFF", border: "none", cursor: "pointer", borderBottom: s.expanded ? "0.5px solid #E5E2DC" : "none" }}
                            >
                              <span style={{ flex: 1, textAlign: "left", fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{scope.name}</span>
                              {estHours > 0 && <span style={{ fontSize: 11, color: "#6B6860", fontFamily: FF }}>{estHours} hrs est.</span>}
                              <span style={{ fontSize: 13, fontWeight: 500, color: "#1A1917", fontFamily: FF, minWidth: 60, textAlign: "right" }}>{subtotal}</span>
                              <ChevronDown style={{ width: 14, height: 14, color: "#9E9B94", transform: s.expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }} />
                            </button>
                            {s.expanded && (
                              <div style={{ padding: "12px 14px" }}>
                                {!isHourly && s.calc && (
                                  <div style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>
                                    {sqft > 0 ? `${sqft.toLocaleString()} sqft` : "No sqft"} {"\u2192"} {s.calc.base_hours || estHours} hrs {"\u00D7"} $70/hr = ${s.calc.base_price.toFixed(2)}
                                  </div>
                                )}
                                {isHourly && (
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>Hours:</span>
                                    <button onClick={() => updateScopeHoursManual(s.scope_id, Math.max(0.5, (s.hours || 0) - 0.5))}
                                      style={{ width: 28, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, background: "#F7F6F3", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>-</button>
                                    <input type="number" min="0.5" step="0.5" value={s.hours || ""} placeholder="0"
                                      onChange={e => updateScopeHoursManual(s.scope_id, parseFloat(e.target.value) || 0.5)}
                                      style={{ width: 60, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, padding: "0 6px", fontSize: 13, fontFamily: FF, outline: "none", textAlign: "center" }} />
                                    <button onClick={() => updateScopeHoursManual(s.scope_id, (s.hours || 0) + 0.5)}
                                      style={{ width: 28, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, background: "#F7F6F3", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                                    <span style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF }}>
                                      {s.hours ? `= $${(s.hours * 70).toFixed(2)}` : "Enter hours to calculate"}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* C. Unified Add-ons & Discounts */}
                  {(() => {
                    // Use first scope's addons as the canonical list
                    const primaryScope = selectedScopes[0];
                    if (!primaryScope) return null;
                    const activeAddons = primaryScope.addons.filter(a => a.is_active);
                    const multiScope = selectedScopes.length > 1;
                    return (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#4A4845", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8, fontFamily: FF }}>Add-ons &amp; Discounts</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {activeAddons.map(addon => {
                            const addonNameLc = addon.name.toLowerCase();
                            const isCounter = addonNameLc.includes("oven") || addonNameLc.includes("refrigerator") || addonNameLc.includes("cabinet");
                            const targetScope = primaryScope;
                            const fromCalc = targetScope.calc?.addon_breakdown.find(b => b.id === addon.id);
                            const priceText = fromCalc
                              ? (fromCalc.amount < 0 ? `-$${Math.abs(fromCalc.amount).toFixed(2)}` : `$${fromCalc.amount.toFixed(2)}`)
                              : addonDisplayPrice(addon);
                            const qty = targetScope.addonQtys[addon.id] ?? 0;
                            const isSel = isCounter ? qty > 0 : targetScope.addon_ids.includes(addon.id);
                            return (
                              <div key={addon.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, border: isSel ? "1px solid var(--brand)" : "1px solid transparent", background: isSel ? "#EAF9F4" : "transparent" }}>
                                {isCounter ? (
                                  <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                                    <button onClick={() => updateScopeAddonQty(targetScope.scope_id, addon.id, qty - 1)} disabled={qty === 0}
                                      style={{ width: 22, height: 22, border: "1px solid #E5E2DC", borderRadius: 4, background: qty === 0 ? "#F7F6F3" : "#FFF", cursor: qty === 0 ? "not-allowed" : "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", color: qty === 0 ? "#C4C2BB" : "#1A1917" }}>-</button>
                                    <span style={{ width: 18, textAlign: "center", fontSize: 12, fontWeight: 600, fontFamily: FF }}>{qty}</span>
                                    <button onClick={() => updateScopeAddonQty(targetScope.scope_id, addon.id, qty + 1)}
                                      style={{ width: 22, height: 22, border: "1px solid #E5E2DC", borderRadius: 4, background: "#FFF", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                                  </div>
                                ) : (
                                  <Checkbox checked={isSel} onCheckedChange={checked => updateScopeAddon(targetScope.scope_id, addon.id, Boolean(checked))} />
                                )}
                                <span style={{ flex: 1, fontSize: 12, color: "#1A1917", fontFamily: FF }}>{addon.name}</span>
                                <span style={{ fontSize: 11, color: fromCalc && fromCalc.amount < 0 ? "#DC2626" : "#9E9B94", flexShrink: 0, fontFamily: FF }}>{priceText}</span>
                              </div>
                            );
                          })}
                        </div>

                        {/* Manual price adjustments */}
                        <div style={{ marginTop: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontFamily: FF }}>Price Adjustments</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 12, color: "#22C55E", fontWeight: 700, width: 12, flexShrink: 0 }}>+</span>
                              <input type="number" min="0" step="1" placeholder="$0" value={primaryScope.adjPlus || ""}
                                onChange={e => updateScopeAdj(primaryScope.scope_id, "adjPlus", parseFloat(e.target.value) || 0)}
                                style={{ width: 70, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, padding: "0 6px", fontSize: 12, fontFamily: FF, outline: "none" }} />
                              <input type="text" placeholder="Reason" value={primaryScope.adjPlusReason}
                                onChange={e => updateScopeAdj(primaryScope.scope_id, "adjPlusReason", e.target.value)}
                                style={{ flex: 1, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, padding: "0 6px", fontSize: 12, fontFamily: FF, outline: "none" }} />
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 12, color: "#DC2626", fontWeight: 700, width: 12, flexShrink: 0 }}>-</span>
                              <input type="number" min="0" step="1" placeholder="$0" value={primaryScope.adjMinus || ""}
                                onChange={e => updateScopeAdj(primaryScope.scope_id, "adjMinus", parseFloat(e.target.value) || 0)}
                                style={{ width: 70, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, padding: "0 6px", fontSize: 12, fontFamily: FF, outline: "none" }} />
                              <input type="text" placeholder="Reason" value={primaryScope.adjMinusReason}
                                onChange={e => updateScopeAdj(primaryScope.scope_id, "adjMinusReason", e.target.value)}
                                style={{ flex: 1, height: 28, border: "1px solid #E5E2DC", borderRadius: 6, padding: "0 6px", fontSize: 12, fontFamily: FF, outline: "none" }} />
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Notes section */}
              <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1917", marginBottom: 2, fontFamily: FF }}>Job Notes</div>
                  <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 6, fontFamily: FF }}>Visible to technician.</div>
                  <Textarea value={internalMemo} onChange={e => setInternalMemo(e.target.value)} placeholder="Instructions and notes for the technician..." rows={3} className="mt-1 text-sm" />
                  {pushConfirmed && <p style={{ fontSize: 11, color: "#9E9B94", marginTop: 4, fontFamily: FF }}>✓ Added from call notes.</p>}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1917", marginBottom: 2, fontFamily: FF }}>Client-Facing Notes</div>
                  <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 6, fontFamily: FF }}>Visible to client on the quote.</div>
                  <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes visible to the client..." rows={3} className="mt-1 text-sm" />
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1917", marginBottom: 2, fontFamily: FF }}>Internal Office Memo</div>
                  <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 6, fontFamily: FF }}>Internal only — never shown to clients or technicians.</div>
                  <Textarea value={officeMemo} onChange={e => setOfficeMemo(e.target.value)} placeholder="Office-only notes..." rows={3} className="mt-1 text-sm" />
                </div>

                {/* Photo upload section */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1917", marginBottom: 2, fontFamily: FF }}>Photos</div>
                  <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 8, fontFamily: FF }}>Attach photos to this quote (property, damage, before/after).</div>
                  <input
                    ref={photoFileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: "none" }}
                    onChange={handlePhotoSelect}
                  />
                  {photoUploads.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: 8, marginBottom: 10 }}>
                      {photoUploads.map(photo => (
                        <div key={photo.id} style={{ position: "relative", borderRadius: 8, overflow: "hidden", border: "0.5px solid #E5E2DC", background: "#F7F6F3", aspectRatio: "1", display: "flex", flexDirection: "column" }}>
                          {photo.uploading ? (
                            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 4 }}>
                              <Loader2 size={20} color="#9E9B94" className="animate-spin" />
                              <span style={{ fontSize: 9, color: "#9E9B94", textAlign: "center", padding: "0 4px" }}>Uploading…</span>
                            </div>
                          ) : photo.error ? (
                            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 6 }}>
                              <span style={{ fontSize: 10, color: "#DC2626", textAlign: "center" }}>{photo.error}</span>
                            </div>
                          ) : (
                            <img src={photo.previewUrl} alt={photo.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          )}
                          {/* Remove button */}
                          <button
                            onClick={() => {
                              setPhotoUploads(prev => prev.filter(p => p.id !== photo.id));
                              if (!photo.objectPath && photo.previewUrl.startsWith("blob:")) URL.revokeObjectURL(photo.previewUrl);
                            }}
                            style={{ position: "absolute", top: 4, right: 4, width: 20, height: 20, borderRadius: "50%", background: "rgba(0,0,0,0.55)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
                          >
                            <X size={11} color="#FFF" />
                          </button>
                          {/* Job notes badge */}
                          {!photo.uploading && !photo.error && (
                            <button
                              title={photo.inJobNotes ? "In Job Notes (click to remove)" : "Add to Job Notes"}
                              onClick={() => setPhotoUploads(prev => prev.map(p => p.id === photo.id ? { ...p, inJobNotes: !p.inJobNotes } : p))}
                              style={{ position: "absolute", bottom: 4, left: 4, fontSize: 9, fontWeight: 600, background: photo.inJobNotes ? "#1A1917" : "rgba(0,0,0,0.35)", color: "#FFF", border: "none", borderRadius: 4, padding: "2px 5px", cursor: "pointer", fontFamily: FF, whiteSpace: "nowrap" }}
                            >
                              {photo.inJobNotes ? "✓ Job Notes" : "+ Job Notes"}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={() => photoFileInputRef.current?.click()}
                    style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500, color: "#6B6860", background: "#F7F6F3", border: "1px dashed #C9C6C0", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontFamily: FF, transition: "background 0.15s" }}
                    onMouseOver={e => (e.currentTarget.style.background = "#EFEDE8")}
                    onMouseOut={e => (e.currentTarget.style.background = "#F7F6F3")}
                  >
                    <ImagePlus size={15} />
                    Add Photos
                  </button>
                </div>
              </div>

              <div className="flex justify-between mt-6">
                <Button size="sm" variant="ghost" onClick={() => setActiveSection(2)}>Back</Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (selectedScopes.length === 1 && !finalScopeId) setFinalScopeId(selectedScopes[0].scope_id);
                    setActiveSection(4);
                  }}
                  style={{ background: "var(--brand)", color: "#FFF" }}
                  className="gap-1.5 hover:opacity-90"
                >
                  Next: Review <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* ── Section 4: Review ─────────────────────────────────────── */}
          {activeSection === 4 && (
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 24 }}>

              {/* Quick Book pre-fill banner */}
              {quickBookBanner && (
                <div style={{ background: "#EBF4FF", border: "1px solid #5B9BD5", borderRadius: 6, padding: "8px 12px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontSize: 12, color: "#185FA5", fontFamily: FF }}>
                    Pre-filled from <strong>{quickBookBanner.scope}</strong> on{" "}
                    {(() => { try { return new Date(quickBookBanner.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch { return quickBookBanner.date; } })()}.{" "}
                    Adjust anything before saving.
                  </span>
                  <button onClick={() => setQuickBookBanner(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5B9BD5", padding: 0, flexShrink: 0, fontFamily: FF, fontSize: 16, lineHeight: 1 }}>×</button>
                </div>
              )}

              <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 14, fontFamily: FF }}>
                Select option to send client
              </div>

              {selectedScopes.length === 0 ? (
                <div style={{ textAlign: "center", fontSize: 14, color: "#9E9B94", padding: "24px 0" }}>
                  No scopes selected. <button onClick={() => setActiveSection(1)} style={{ color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Go back to Service &amp; Pricing</button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                  {selectedScopes.map(s => {
                    const scope = scopes.find(sc => sc.id === s.scope_id);
                    const isFinal = finalScopeId === s.scope_id;
                    const addonNames = s.addons.filter(a => s.addon_ids.includes(a.id)).map(a => a.name);
                    const addonSummary = addonNames.length > 0 ? ` + ${addonNames.join(", ")}` : "";
                    return (
                      <div
                        key={s.scope_id}
                        onClick={() => setFinalScopeId(s.scope_id)}
                        style={{ border: isFinal ? "1.5px solid #5B9BD5" : "0.5px solid #E5E2DC", background: isFinal ? "#EBF4FF" : "#FFF", padding: "12px 16px", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, transition: "all 0.15s" }}
                      >
                        <input type="radio" checked={isFinal} onChange={() => setFinalScopeId(s.scope_id)} style={{ flexShrink: 0, accentColor: "#5B9BD5", width: 16, height: 16 }} onClick={e => e.stopPropagation()} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{scope?.name}{addonSummary}</div>
                          {s.frequency && <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2, fontFamily: FF }}>{s.frequency}</div>}
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 500, color: "#1A1917", flexShrink: 0, fontFamily: FF }}>
                          {s.calcLoading ? "..." : s.calc ? `$${s.calc.final_total.toFixed(2)}` : "—"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Schedule & Assign (for Convert to Job) ── */}
              <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 16, marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10, fontFamily: FF }}>
                  Schedule &amp; Assign
                </div>
                <div className="flex gap-3" style={{ marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <Label className="text-xs">Scheduled Date</Label>
                    <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
                      style={{ width: "100%", height: 36, border: "1px solid #E5E2DC", borderRadius: 8, padding: "0 10px", fontSize: 13, fontFamily: FF, outline: "none", background: "#FFF", marginTop: 4 }}
                    />
                  </div>
                  <div style={{ width: 140 }}>
                    <Label className="text-xs">Start Time</Label>
                    <select value={selectedTime} onChange={e => setSelectedTime(e.target.value)}
                      style={{ width: "100%", height: 36, border: "1px solid #E5E2DC", borderRadius: 8, padding: "0 8px", fontSize: 13, fontFamily: FF, outline: "none", background: "#FFF", marginTop: 4, cursor: "pointer" }}>
                      {["7:00 AM","7:30 AM","8:00 AM","8:30 AM","9:00 AM","9:30 AM","10:00 AM","10:30 AM","11:00 AM","11:30 AM","12:00 PM","12:30 PM","1:00 PM","1:30 PM","2:00 PM","2:30 PM","3:00 PM","3:30 PM","4:00 PM","4:30 PM","5:00 PM"].map(t => {
                        const [time, ampm] = t.split(" ");
                        const [h, m] = time.split(":");
                        const h24 = ampm === "PM" && h !== "12" ? parseInt(h) + 12 : ampm === "AM" && h === "12" ? 0 : parseInt(h);
                        const val = `${String(h24).padStart(2,"0")}:${m}`;
                        return <option key={val} value={val}>{t}</option>;
                      })}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Label className="text-xs">Assign Technician</Label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                      {/* Preferred tech shortcut */}
                      {preferredTech && (
                        <button
                          onClick={() => setSelectedTechId(selectedTechId === preferredTech.id ? null : preferredTech.id)}
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 14, fontSize: 12, fontWeight: selectedTechId === preferredTech.id ? 600 : 400, border: selectedTechId === preferredTech.id ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: selectedTechId === preferredTech.id ? "#EAF9F4" : "#FFF", color: "#1A1917", cursor: "pointer", fontFamily: FF }}
                        >
                          <span style={{ width: 18, height: 18, borderRadius: "50%", background: selectedTechId === preferredTech.id ? "var(--brand)" : "#5B9BD5", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFF", fontSize: 9, fontWeight: 700 }}>{preferredTech.full_name.charAt(0)}</span>
                          {preferredTech.full_name}
                          {selectedTechId === preferredTech.id && <Check style={{ width: 12, height: 12, color: "var(--brand)" }} />}
                        </button>
                      )}
                      {/* Zone techs */}
                      {suggestedTechs.filter(t => t.id !== preferredTech?.id).map(tech => {
                        const isSel = selectedTechId === tech.id;
                        return (
                          <button key={tech.id} onClick={() => setSelectedTechId(isSel ? null : tech.id)}
                            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 14, fontSize: 12, fontWeight: isSel ? 600 : 400, border: isSel ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: isSel ? "#EAF9F4" : "#FFF", color: "#1A1917", cursor: "pointer", fontFamily: FF }}
                          >
                            <span style={{ width: 18, height: 18, borderRadius: "50%", background: isSel ? "var(--brand)" : "#E5E2DC", display: "flex", alignItems: "center", justifyContent: "center", color: isSel ? "#FFF" : "#6B6860", fontSize: 9, fontWeight: 700 }}>{tech.name.charAt(0)}</span>
                            {tech.name}
                          </button>
                        );
                      })}
                      {!preferredTech && suggestedTechs.length === 0 && (
                        <span style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF, padding: "4px 0" }}>No techs available — will be unassigned</span>
                      )}
                    </div>
                  </div>
                </div>
                {!selectedDate && (
                  <div style={{ fontSize: 11, color: "#BA7517", fontFamily: FF, marginBottom: 8 }}>
                    Select a date to convert to a scheduled job.
                  </div>
                )}
              </div>

              <div className="flex justify-between mt-4">
                <Button size="sm" variant="ghost" onClick={() => setActiveSection(3)}>Back</Button>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => save("draft")} disabled={saving} className="gap-1.5">
                    <Save className="w-3.5 h-3.5" /> Save Draft
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => save("sent")} disabled={saving || !finalScopeId} className="gap-1.5">
                    <SendHorizonal className="w-3.5 h-3.5" /> Save &amp; Send Quote
                  </Button>
                  <Button size="sm" onClick={() => save("draft", true)} disabled={saving || !canConvert || !selectedDate} style={{ background: !selectedDate ? "#D1D5DB" : "var(--brand)", color: "#FFF", cursor: !selectedDate ? "not-allowed" : "pointer" }} className="gap-1.5 hover:opacity-90">
                    <ArrowRight className="w-3.5 h-3.5" /> Save &amp; Convert to Job
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: Sticky Panel ──────────────────────────────────────── */}
        <div style={{ position: "sticky", top: 80 }}>

          {/* Call Notes */}
          <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Call Notes</span>
                <span style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>Not visible to client.</span>
              </div>
              <span style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, minWidth: 50, textAlign: "right" }}>
                {callNotesSaving ? "Saving..." : callNotesSavedVisible ? "Saved" : ""}
              </span>
            </div>
            <textarea
              ref={callNotesRef}
              value={callNotes}
              onChange={e => setCallNotes(e.target.value)}
              onMouseUp={handleCallNotesMouseUp}
              onTouchEnd={handleCallNotesMouseUp}
              onClick={() => setCallNoteTooltip(null)}
              placeholder="Notes from the call..."
              rows={10}
              style={{ width: "100%", boxSizing: "border-box", resize: "none", border: "1px solid #E5E2DC", borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: "1.6", color: "#1A1917", fontFamily: FF, background: "#FAFAF9", outline: "none" }}
            />
          </div>

          {/* Price Preview */}
          <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #E5E2DC" }}>Price Preview</h3>

            {/* 0 scopes */}
            {selectedScopes.length === 0 && (
              <div style={{ padding: "20px 0", textAlign: "center", fontSize: 13, color: "#9E9B94", fontFamily: FF }}>
                Select a scope to see pricing.
              </div>
            )}

            {/* 1 scope — full breakdown */}
            {selectedScopes.length === 1 && (() => {
              const s = selectedScopes[0];
              const scope = scopes.find(sc => sc.id === s.scope_id);
              return (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF, marginBottom: 10 }}>{scope?.name}</div>
                  {s.calcLoading && <div style={{ fontSize: 13, color: "#9E9B94", fontFamily: FF }}>Calculating...</div>}
                  {!s.calcLoading && s.calc ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6B6860" }}>
                        <span>Base</span><span>${s.calc.base_price.toFixed(2)}</span>
                      </div>
                      {s.calc.addon_breakdown.map(a => (
                        <div key={a.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6B6860" }}>
                          <span>{a.name}</span><span>{a.amount < 0 ? `-$${Math.abs(a.amount).toFixed(2)}` : `+$${a.amount.toFixed(2)}`}</span>
                        </div>
                      ))}
                      {s.calc.discount_amount > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#16A34A" }}>
                          <span>Discount</span><span>-${s.calc.discount_amount.toFixed(2)}</span>
                        </div>
                      )}
                      {s.adjPlus > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#22C55E" }}>
                          <span>+{s.adjPlusReason || "Adjustment"}</span><span>+${s.adjPlus.toFixed(2)}</span>
                        </div>
                      )}
                      {s.adjMinus > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#DC2626" }}>
                          <span>−{s.adjMinusReason || "Adjustment"}</span><span>-${s.adjMinus.toFixed(2)}</span>
                        </div>
                      )}
                      {/* Estimated hours */}
                      {(s.hours || s.calc?.base_hours) && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6B6860" }}>
                          <span>Est. hours</span><span>{s.hours || s.calc?.base_hours} hrs</span>
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid #E5E2DC", marginTop: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Total</span>
                        <span style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>${(s.calc.final_total + (s.adjPlus || 0) - (s.adjMinus || 0)).toFixed(2)}</span>
                      </div>
                      {/* Commission breakdown */}
                      {(() => {
                        const total = s.calc.final_total + (s.adjPlus || 0) - (s.adjMinus || 0);
                        const estHrs = s.hours || s.calc?.base_hours || 0;
                        const techCount = selectedTechId ? 1 : 0;
                        const cs = calculateCommissionSplit(total, estHrs, techCount);
                        return (
                          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed #E5E2DC" }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", marginBottom: 4, fontFamily: FF }}>Commission (35%)</div>
                            <div style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>
                              Pool: ${cs.totalCommission.toFixed(2)}
                            </div>
                            {cs.mode === "unassigned" && (
                              <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginTop: 2 }}>Will calculate once techs are assigned</div>
                            )}
                            {cs.mode === "equal" && cs.perTech.length > 0 && (
                              <div style={{ fontSize: 11, color: "#6B6860", fontFamily: FF, marginTop: 2 }}>
                                ${cs.totalCommission.toFixed(2)} / {techCount} tech = ${cs.perTech[0].commission.toFixed(2)} each
                                {estHrs > 0 && ` | ${cs.perTech[0].hours} hrs each`}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  ) : !s.calcLoading && (
                    <div style={{ fontSize: 13, color: "#9E9B94", fontFamily: FF }}>
                      {scope?.pricing_method === "sqft" ? "Enter square footage to calculate." : "Enter hours to calculate."}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 2+ scopes — list with hours + commission */}
            {selectedScopes.length >= 2 && (() => {
              const grandTotal = selectedScopes.reduce((sum, s) => sum + (s.calc?.final_total ?? 0) + (s.adjPlus || 0) - (s.adjMinus || 0), 0);
              const totalHours = selectedScopes.reduce((sum, s) => sum + (s.hours || s.calc?.base_hours || 0), 0);
              const techCount = selectedTechId ? 1 : 0;
              const cs = calculateCommissionSplit(grandTotal, totalHours, techCount);
              return (
                <div>
                  {selectedScopes.map(s => {
                    const scope = scopes.find(sc => sc.id === s.scope_id);
                    const estHrs = s.hours || s.calc?.base_hours || 0;
                    return (
                      <div key={s.scope_id} style={{ padding: "8px 0", borderBottom: "1px solid #F0EEE9" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: 13, color: "#1A1917", fontFamily: FF }}>{scope?.name}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>
                            {s.calcLoading ? "..." : s.calc ? `$${s.calc.final_total.toFixed(2)}` : "\u2014"}
                          </span>
                        </div>
                        {estHrs > 0 && <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>Est. {estHrs} hrs</div>}
                      </div>
                    );
                  })}
                  {/* Grand total */}
                  <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, marginTop: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Total</span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>${grandTotal.toFixed(2)}</span>
                  </div>
                  {totalHours > 0 && <div style={{ fontSize: 11, color: "#6B6860", textAlign: "right", fontFamily: FF }}>{totalHours} hrs total</div>}
                  {/* Commission */}
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed #E5E2DC" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", marginBottom: 2, fontFamily: FF }}>Commission (35%): ${cs.totalCommission.toFixed(2)}</div>
                    {cs.mode === "unassigned" && <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>Will calculate once techs are assigned</div>}
                    {cs.mode === "equal" && cs.perTech.length > 0 && (
                      <div style={{ fontSize: 11, color: "#6B6860", fontFamily: FF }}>${cs.perTech[0].commission.toFixed(2)} / tech | {cs.perTech[0].hours} hrs / tech</div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 10, textAlign: "center", fontFamily: FF }}>
                    Select the final option in Step 5.
                  </div>
                </div>
              );
            })()}

            {/* Action buttons */}
            <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 12, marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              <Button
                className="w-full gap-1.5 hover:opacity-90"
                style={{ background: "var(--brand)", color: "#FFF" }}
                size="sm"
                onClick={() => save("draft", true)}
                disabled={saving || !canConvert}
              >
                <ArrowRight className="w-3.5 h-3.5" /> Save & Convert to Job
              </Button>
              <Button className="w-full gap-1.5" variant="outline" size="sm" onClick={() => save("sent")} disabled={saving}>
                <SendHorizonal className="w-3.5 h-3.5" /> Save & Send Quote
              </Button>
              <Button className="w-full gap-1.5" variant="ghost" size="sm" onClick={() => save("draft")} disabled={saving}>
                <Save className="w-3.5 h-3.5" /> Save Draft
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stepper({ value, onChange, min = 0, max = 10 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  const btn = (disabled: boolean): React.CSSProperties => ({
    width: 44, height: 44, border: "1px solid #E5E2DC", borderRadius: 0, background: disabled ? "#F7F6F3" : "#FFF",
    color: disabled ? "#D1D5DB" : "#1A1917", fontSize: 18, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center",
  });
  return (
    <div style={{ display: "flex", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden", height: 44, marginTop: 6 }}>
      <button style={btn(value <= min)} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF, borderLeft: "1px solid #E5E2DC", borderRight: "1px solid #E5E2DC" }}>{value}</div>
      <button style={btn(value >= max)} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );
}
