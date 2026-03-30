import { useState, useEffect, useCallback, useRef } from "react";
import { useRoute } from "wouter";
import { Phone, Mail, Clock, MapPin, CheckCircle2, AlertCircle, ChevronLeft, ChevronRight, Minus, Plus, Calendar, Tag } from "lucide-react";

// ── API base (public, no auth) ───────────────────────────────────────────────
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
async function pubFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── Types ────────────────────────────────────────────────────────────────────
interface CompanyData {
  id: number;
  name: string;
  slug: string;
  brand_color: string;
  logo_url: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  business_hours: string | null;
  booking_policies: string | null;
  online_booking_lead_hours: number | null;
  active_scopes: Array<{ id: number; name: string; scope_group: string }>;
}

interface PricingFrequency {
  id: number;
  frequency: string;
  label: string;
  multiplier: string;
  rate_override: string | null;
  sort_order: number;
}

interface PricingAddon {
  id: number;
  name: string;
  price_type: string;
  price: string | null;
  percent_of_base: string | null;
  time_add_minutes: number;
}

interface CalcResult {
  scope_name: string;
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

// ── Stepper counter component ────────────────────────────────────────────────
function Stepper({ value, onChange, min = 0, max = 20 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        style={{ width: 32, height: 32, borderRadius: "50%", border: "1px solid #E5E2DC", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
      >
        <Minus size={14} />
      </button>
      <span style={{ minWidth: 24, textAlign: "center", fontWeight: 600, fontSize: 16 }}>{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        style={{ width: 32, height: 32, borderRadius: "50%", border: "1px solid #E5E2DC", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

// ── Simple calendar ──────────────────────────────────────────────────────────
type AvailableDays = { sun: boolean; mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean };
const DAY_KEYS: (keyof AvailableDays)[] = ["sun","mon","tue","wed","thu","fri","sat"];

function SimpleCalendar({
  selected,
  onSelect,
  brand,
  leadDays,
  maxAdvanceDays,
  availableDays,
}: {
  selected: string;
  onSelect: (d: string) => void;
  brand: string;
  leadDays?: number;
  maxAdvanceDays?: number;
  availableDays?: AvailableDays;
}) {
  const effectiveLeadDays = leadDays ?? 7;
  const effectiveMaxAdvanceDays = maxAdvanceDays ?? 60;
  const effectiveAvail: AvailableDays = availableDays ?? { sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const minDate = new Date(today);
  minDate.setDate(minDate.getDate() + effectiveLeadDays);

  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + effectiveMaxAdvanceDays);

  function isDisabledDate(d: Date): boolean {
    const cmp = new Date(d); cmp.setHours(0,0,0,0);
    if (cmp < minDate || cmp > maxDate) return true;
    return !effectiveAvail[DAY_KEYS[cmp.getDay()]];
  }

  function firstAvailableDate(): Date {
    const d = new Date(minDate);
    for (let i = 0; i < effectiveMaxAdvanceDays; i++) {
      if (!isDisabledDate(d)) return new Date(d);
      d.setDate(d.getDate() + 1);
    }
    return new Date(minDate);
  }

  const defaultDate = firstAvailableDate();

  const [viewDate, setViewDate] = useState(() => new Date(defaultDate.getFullYear(), defaultDate.getMonth(), 1));

  useEffect(() => {
    if (!selected) {
      const ds = defaultDate.toISOString().split("T")[0];
      onSelect(ds);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = viewDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const minViewYear = minDate.getFullYear();
  const minViewMonth = minDate.getMonth();
  const maxViewYear = maxDate.getFullYear();
  const maxViewMonth = maxDate.getMonth();
  const canGoPrev = year > minViewYear || (year === minViewYear && month > minViewMonth);
  const canGoNext = year < maxViewYear || (year === maxViewYear && month < maxViewMonth);

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  function fmtDay(day: number) {
    const d = new Date(year, month, day);
    return d.toISOString().split("T")[0];
  }

  function isDisabledDay(day: number): boolean {
    return isDisabledDate(new Date(year, month, day));
  }

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 12, padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <button
          onClick={() => canGoPrev && setViewDate(new Date(year, month - 1, 1))}
          disabled={!canGoPrev}
          style={{ background: "none", border: "none", cursor: canGoPrev ? "pointer" : "default", padding: 4, borderRadius: 6, opacity: canGoPrev ? 1 : 0.25 }}
        >
          <ChevronLeft size={18} color="#6B6860" />
        </button>
        <span style={{ fontWeight: 600, fontSize: 15, color: "#1A1917" }}>{monthName}</span>
        <button
          onClick={() => canGoNext && setViewDate(new Date(year, month + 1, 1))}
          disabled={!canGoNext}
          style={{ background: "none", border: "none", cursor: canGoNext ? "pointer" : "default", padding: 4, borderRadius: 6, opacity: canGoNext ? 1 : 0.25 }}
        >
          <ChevronRight size={18} color="#6B6860" />
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 8 }}>
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, color: "#9E9B94", padding: "4px 0" }}>{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {days.map((day, i) => {
          if (!day) return <div key={i} />;
          const dateStr = fmtDay(day);
          const disabled = isDisabledDay(day);
          const sel = dateStr === selected;
          return (
            <button
              key={i}
              disabled={disabled}
              onClick={() => onSelect(dateStr)}
              style={{
                width: "100%", aspectRatio: "1", borderRadius: 8, border: sel ? `2px solid ${brand}` : "1px solid transparent",
                background: sel ? brand : disabled ? "#F7F6F3" : "#fff",
                color: sel ? "#fff" : disabled ? "#C4C1BA" : "#1A1917",
                fontSize: 13, fontWeight: sel ? 700 : 400, cursor: disabled ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.1s",
              }}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Synchronous upsell price calculation (no async, no loading state) ────────
// Tiers derived from actual DB data: scope 4 (weekly) × $60/hr,
// scope 9 (biweekly) × $65/hr, scope 10 (monthly) × $70/hr.
// Mirrors the server-side rate_override values set in pricing_frequencies.
type UpsellTier = { min: number; max: number; price: number };
const UPSELL_TIERS: Record<string, UpsellTier[]> = {
  weekly: [
    { min: 0,    max: 749,   price: 174.00 },
    { min: 750,  max: 999,   price: 174.60 },
    { min: 1000, max: 1249,  price: 180.00 },
    { min: 1250, max: 1499,  price: 190.80 },
    { min: 1500, max: 1749,  price: 198.00 },
    { min: 1750, max: 1999,  price: 229.20 },
    { min: 2000, max: 2249,  price: 240.00 },
    { min: 2250, max: 2499,  price: 270.00 },
    { min: 2500, max: 2749,  price: 300.00 },
    { min: 2750, max: 3499,  price: 327.00 },
    { min: 3500, max: 3749,  price: 327.00 },
    { min: 3750, max: 3999,  price: 420.00 },
    { min: 4000, max: 4999,  price: 570.00 },
    { min: 5000, max: 99999, price: 660.00 },
  ],
  biweekly: [
    { min: 0,    max: 749,   price: 195.00 },
    { min: 750,  max: 999,   price: 195.00 },
    { min: 1000, max: 1249,  price: 201.50 },
    { min: 1250, max: 1499,  price: 212.55 },
    { min: 1500, max: 1749,  price: 224.25 },
    { min: 1750, max: 1999,  price: 260.00 },
    { min: 2000, max: 2249,  price: 265.85 },
    { min: 2250, max: 2499,  price: 305.50 },
    { min: 2500, max: 2749,  price: 342.55 },
    { min: 2750, max: 3499,  price: 364.00 },
    { min: 3500, max: 3749,  price: 403.00 },
    { min: 3750, max: 3999,  price: 472.55 },
    { min: 4000, max: 4999,  price: 650.00 },
    { min: 5000, max: 99999, price: 780.00 },
  ],
  monthly: [
    { min: 0,    max: 749,   price: 216.30 },
    { min: 750,  max: 999,   price: 216.30 },
    { min: 1000, max: 1249,  price: 224.00 },
    { min: 1250, max: 1499,  price: 241.50 },
    { min: 1500, max: 1749,  price: 247.80 },
    { min: 1750, max: 1999,  price: 292.60 },
    { min: 2000, max: 2249,  price: 317.80 },
    { min: 2250, max: 2499,  price: 350.00 },
    { min: 2500, max: 2749,  price: 381.50 },
    { min: 2750, max: 3499,  price: 420.00 },
    { min: 3500, max: 3749,  price: 462.00 },
    { min: 3750, max: 3999,  price: 560.00 },
    { min: 4000, max: 4999,  price: 735.00 },
    { min: 5000, max: 99999, price: 910.00 },
  ],
};
function calculateUpsellPrice(sqft: number, cadence: string, discountPct = 15): { recurringRate: number; firstVisitRate: number } | null {
  if (!sqft || sqft <= 0 || !cadence) return null;
  const tiers = UPSELL_TIERS[cadence];
  if (!tiers) return null;
  const tier = tiers.find(t => sqft >= t.min && sqft <= t.max);
  if (!tier) return null;
  const recurringRate = Math.round(tier.price * 100) / 100;
  const firstVisitRate = Math.round(recurringRate * (1 - discountPct / 100) * 100) / 100;
  return { recurringRate, firstVisitRate };
}

// ── Main booking widget ──────────────────────────────────────────────────────
export default function BookPage() {
  const [, params] = useRoute("/book/:slug");
  const slug = params?.slug ?? "";

  const [company, setCompany] = useState<CompanyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const brand = company?.brand_color || "#00C9A0";

  // Resolve relative logo URLs to absolute so they work in any embed context
  function resolveUrl(url: string | null): string | null {
    if (!url) return null;
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    return `${window.location.origin}${url.startsWith("/") ? url : `/${url}`}`;
  }
  const logoSrc = resolveUrl(company?.logo_url ?? null);

  // ── Step state ───────────────────────────────────────────────────────────
  const [step, setStep] = useState(0);
  const TOTAL_STEPS = 6;

  // Step 0: Contact
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [zip, setZip] = useState("");
  const [referral, setReferral] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [termsConsent, setTermsConsent] = useState(false);

  // Step 1: Scope + Home Details
  const [scopeId, setScopeId] = useState<number | null>(null);
  const [sqft, setSqft] = useState(0);
  const [bedrooms, setBedrooms] = useState(0);
  const [bathrooms, setBathrooms] = useState(0);
  const [halfBaths, setHalfBaths] = useState(0);
  const [floors, setFloors] = useState(0);
  const [people, setPeople] = useState(0);
  const [pets, setPets] = useState(0);
  const [cleanliness, setCleanliness] = useState(0);
  const [lastCleanedResponse, setLastCleanedResponse] = useState("");
  const [lastCleanedOverride, setLastCleanedOverride] = useState(false);
  const [overageAcknowledged, setOverageAcknowledged] = useState(false);

  // Display scope key — distinguishes Deep Clean vs Move In/Out (same DB scope)
  const [displayScopeKey, setDisplayScopeKey] = useState<string | null>(null);

  // Move In/Out acknowledgments
  const [moveInAck, setMoveInAck] = useState(false);
  const [moveInNotes, setMoveInNotes] = useState("");

  // Offer settings (loaded from API, never hardcoded)
  const [offerSettings, setOfferSettings] = useState<{
    upsell_enabled: boolean;
    upsell_discount_percent: number;
    rate_lock_enabled: boolean;
    rate_lock_duration_months: number;
    overrun_threshold_percent: number;
    overrun_jobs_trigger: number;
    service_gap_days: number;
  } | null>(null);

  // Upsell state (Deep Clean recurring upsell)
  const [upsellCadence, setUpsellCadence] = useState("");
  const [upsellAccepted, setUpsellAccepted] = useState(false);
  const [upsellDeclined, setUpsellDeclined] = useState(false);
  const [upsellTermsOpen, setUpsellTermsOpen] = useState(false);
  const [upsellCadenceError, setUpsellCadenceError] = useState(false);

  // Step 2: Frequency + Add-ons
  const [frequencyStr, setFrequencyStr] = useState("");
  const [selectedAddonIds, setSelectedAddonIds] = useState<number[]>([]);
  const [address, setAddressField] = useState("");

  // Step 3: Date
  const [selectedDate, setSelectedDate] = useState("");
  const [bookingSettings, setBookingSettings] = useState<{
    booking_lead_days: number;
    max_advance_days: number;
    available_sun: boolean; available_mon: boolean; available_tue: boolean;
    available_wed: boolean; available_thu: boolean; available_fri: boolean; available_sat: boolean;
  } | null>(null);

  // Step 5: Booking result
  const [bookResult, setBookResult] = useState<any>(null);
  const [bookError, setBookError] = useState("");
  const [booking, setBooking] = useState(false);

  // Commercial booking
  const [commercialOption, setCommercialOption] = useState<"single" | "walkthrough" | null>(null);
  const [walkthroughBooking, setWalkthroughBooking] = useState(false);

  // Step 4: Stripe card capture
  const [stripeEnabled, setStripeEnabled] = useState<boolean | null>(null); // null = unknown
  const [stripeSetupLoading, setStripeSetupLoading] = useState(false);
  const [stripeClientSecret, setStripeClientSecret] = useState<string | null>(null);
  const [stripeCustomerId, setStripeCustomerId] = useState<string | null>(null);
  const [stripePubKey, setStripePubKey] = useState<string | null>(null);
  const [stripeInstance, setStripeInstance] = useState<any>(null);
  const [stripeCardElement, setStripeCardElement] = useState<any>(null);
  const [stripeCardReady, setStripeCardReady] = useState(false);

  // Pricing
  const [calcResult, setCalcResult] = useState<CalcResult | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);

  // Scope frequencies/addons
  const [frequencies, setFrequencies] = useState<PricingFrequency[]>([]);
  const [addons, setAddons] = useState<PricingAddon[]>([]);

  // Bundles
  const [bundles, setBundles] = useState<any[]>([]);

  // Step 0 errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCleanedRef = useRef<HTMLDivElement>(null);

  // ── Load company ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    pubFetch(`/api/public/company/${slug}`)
      .then(d => {
        setCompany(d);
        setLoading(false);
        pubFetch(`/api/public/bundles/${d.id}`).then(bs => setBundles(bs)).catch(() => {});
        pubFetch(`/api/public/offer-settings/${slug}`).then(os => setOfferSettings(os)).catch(() => {});
        pubFetch(`/api/public/booking-settings/${slug}`).then(bs => setBookingSettings(bs)).catch(() => {});
      })
      .catch(() => { setNotFound(true); setLoading(false); });
  }, [slug]);

  // ── Load frequencies + addons when scope changes ──────────────────────────
  useEffect(() => {
    if (!scopeId) return;
    setFrequencies([]);
    setAddons([]);
    setFrequencyStr("");
    setSelectedAddonIds([]);
    setLastCleanedResponse("");
    setLastCleanedOverride(false);
    setOverageAcknowledged(false);
    // Scope 11 (Recurring Cleaning) has no addons defined — fetch from One-Time Standard (3)
    // so we have pricing data; frontend scope filter then enforces visibility rules
    const addonScopeId = scopeId === 11 ? 3 : scopeId;
    Promise.all([
      pubFetch(`/api/public/frequencies/${scopeId}`),
      pubFetch(`/api/public/addons/${addonScopeId}`),
    ]).then(([freqs, ads]) => {
      const filteredFreqs = (freqs as PricingFrequency[]).filter(f => {
        if (scopeId === 11) return !f.frequency.toLowerCase().includes("onetime") && !f.frequency.toLowerCase().includes("one_time") && f.frequency !== "onetime";
        return true;
      });
      setFrequencies(filteredFreqs);
      setAddons(ads);
      const defaultFreq = filteredFreqs.find((f: PricingFrequency) => f.frequency === "weekly") ?? filteredFreqs[0];
      setFrequencyStr(defaultFreq?.frequency ?? "");
    }).catch(() => {});
  }, [scopeId]);

  // ── Scroll last-cleaned question into view when Recurring is selected ────
  useEffect(() => {
    if (!company || !scopeId) return;
    const sel = company.active_scopes.find(s => s.id === scopeId);
    if (sel?.name?.toLowerCase() === "recurring cleaning" && lastCleanedRef.current) {
      setTimeout(() => lastCleanedRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 150);
    }
  }, [scopeId, company]);

  // ── Live pricing calculation ──────────────────────────────────────────────
  const runCalc = useCallback(async () => {
    if (!company || !scopeId || !sqft || !frequencyStr) { setCalcResult(null); return; }
    setCalcLoading(true);
    try {
      const result = await pubFetch("/api/public/calculate", {
        method: "POST",
        body: JSON.stringify({
          company_id: company.id,
          scope_id: scopeId,
          sqft,
          frequency: frequencyStr,
          addon_ids: selectedAddonIds,
        }),
      });
      setCalcResult(result);
    } catch { /* silent */ }
    finally { setCalcLoading(false); }
  }, [company, scopeId, sqft, frequencyStr, selectedAddonIds]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(runCalc, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [scopeId, sqft, frequencyStr, selectedAddonIds]);


  // ── Step 0 validation ─────────────────────────────────────────────────────
  function validateStep0() {
    const errs: Record<string, string> = {};
    if (!firstName.trim()) errs.firstName = "First name is required";
    if (!lastName.trim()) errs.lastName = "Last name is required";
    if (!phone.trim()) errs.phone = "Phone number is required";
    else if (!/^\+?[\d\s\-().]{10,}$/.test(phone.replace(/\s/g, ""))) errs.phone = "Enter a valid phone number";
    if (!email.trim()) errs.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = "Enter a valid email address";
    if (!zip.trim()) errs.zip = "Zip code is required";
    if (!address.trim()) errs.address = "Service address is required";
    if (!termsConsent) errs.terms = "You must agree to the terms";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  // ── Stripe setup: called when entering Step 4 ─────────────────────────────
  useEffect(() => {
    if (step !== 4 || !company || stripeClientSecret || stripeEnabled === false || stripeSetupLoading) return;
    setStripeSetupLoading(true);
    setBookError("");
    pubFetch("/api/public/book/setup", {
      method: "POST",
      body: JSON.stringify({ company_id: company.id, email, first_name: firstName, last_name: lastName, phone }),
    })
      .then((res) => {
        if (!res.stripe_enabled) { setStripeEnabled(false); return; }
        setStripeEnabled(true);
        setStripePubKey(res.publishable_key);
        setStripeClientSecret(res.client_secret);
        setStripeCustomerId(res.customer_id);
      })
      .catch(() => { setStripeEnabled(false); })
      .finally(() => setStripeSetupLoading(false));
  }, [step, company]);

  // ── Mount Stripe card element once we have client_secret + publishable_key ─
  useEffect(() => {
    if (!stripeEnabled || !stripeClientSecret || !stripePubKey) return;
    const mountCard = () => {
      const w = window as any;
      if (!w.Stripe) return;
      const stripe = w.Stripe(stripePubKey);
      const elements = stripe.elements({ clientSecret: stripeClientSecret });
      const cardEl = elements.create("card", {
        style: {
          base: {
            fontFamily: "'Plus Jakarta Sans', Arial, sans-serif",
            fontSize: "15px",
            color: "#1A1917",
            "::placeholder": { color: "#9E9B94" },
          },
        },
      });
      const container = document.getElementById("stripe-card-element-book");
      if (container && !container.hasChildNodes()) {
        cardEl.mount("#stripe-card-element-book");
        cardEl.on("ready", () => setStripeCardReady(true));
        setStripeInstance(stripe);
        setStripeCardElement(cardEl);
      }
    };

    const existing = document.getElementById("stripe-js-book");
    if (existing) { mountCard(); return; }
    const script = document.createElement("script");
    script.id = "stripe-js-book";
    script.src = "https://js.stripe.com/v3/";
    script.onload = mountCard;
    document.head.appendChild(script);
  }, [stripeEnabled, stripeClientSecret, stripePubKey]);

  // ── Book submission (Stripe path) ─────────────────────────────────────────
  async function submitBooking() {
    if (!company) return;
    setBooking(true);
    setBookError("");

    try {
      // If Stripe is enabled, confirm the SetupIntent first
      if (stripeEnabled && stripeInstance && stripeCardElement && stripeClientSecret) {
        const { setupIntent, error } = await stripeInstance.confirmCardSetup(stripeClientSecret, {
          payment_method: { card: stripeCardElement },
        });
        if (error) {
          setBookError("We were unable to verify your card. Please check your details or use a different card.");
          setBooking(false);
          return;
        }
        const paymentMethodId = setupIntent.payment_method;
        const isCommercialSingle = commercialOption === "single";
        const result = await pubFetch(isCommercialSingle ? "/api/public/book/commercial-confirm" : "/api/public/book/confirm", {
          method: "POST",
          body: JSON.stringify(isCommercialSingle ? {
            company_id: company.id,
            first_name: firstName, last_name: lastName, phone, email, zip,
            referral_source: referral || null, sms_consent: smsConsent,
            address, preferred_date: selectedDate,
            payment_method_id: paymentMethodId,
            stripe_customer_id: stripeCustomerId,
          } : {
            company_id: company.id,
            first_name: firstName, last_name: lastName, phone, email, zip,
            referral_source: referral || null, sms_consent: smsConsent,
            scope_id: scopeId, sqft, frequency: frequencyStr,
            addon_ids: selectedAddonIds,
            bedrooms, bathrooms, half_baths: halfBaths, floors, people, pets, cleanliness,
            home_condition_rating: showCleanlinessQ ? (cleanliness || 1) : null,
            condition_multiplier: showCleanlinessQ ? conditionMultiplier : null,
            applied_bundle_id: activeBundleId,
            bundle_discount_total: bundleSavings > 0 ? bundleSavings : null,
            last_cleaned_response: isRecurringScope ? (lastCleanedResponse || null) : null,
            last_cleaned_flag: isRecurringScope ? (["1_3_months", "over_3_months"].includes(lastCleanedResponse) ? "overdue" : "ok") : null,
            overage_disclaimer_acknowledged: lastCleanedOverride && overageAcknowledged,
            overage_rate: (lastCleanedOverride && overageAcknowledged) ? getOverageRate(frequencyStr) : null,
            upsell_shown: isDeepCleanScope,
            upsell_accepted: upsellAccepted,
            upsell_declined: upsellDeclined && !upsellAccepted,
            upsell_deferred: upsellDeclined && !upsellAccepted,
            upsell_cadence_selected: upsellAccepted ? upsellCadence : null,
            upsell_locked_rate: upsellAccepted && upsellPriceResult ? upsellPriceResult.recurringRate : null,
            property_vacant: isMoveInOut,
            move_in_notes: isMoveInOut && moveInNotes.trim() ? moveInNotes.trim() : null,
            address, preferred_date: selectedDate,
            payment_method_id: paymentMethodId,
            stripe_customer_id: stripeCustomerId,
          }),
        });
        setBookResult(result);
        setStep(5);
        return;
      }

      // Stripe disabled fallback
      const result = await pubFetch("/api/public/book", {
        method: "POST",
        body: JSON.stringify({
          company_id: company.id,
          first_name: firstName, last_name: lastName, phone, email, zip,
          referral_source: referral || null, sms_consent: smsConsent,
          scope_id: scopeId, sqft, frequency: frequencyStr,
          addon_ids: selectedAddonIds,
          bedrooms, bathrooms, half_baths: halfBaths, floors, people, pets, cleanliness,
          address, preferred_date: selectedDate,
        }),
      });
      setBookResult(result);
      setStep(5);
    } catch (err: any) {
      let msg = err.message || "Something went wrong. Please try again.";
      try { const parsed = JSON.parse(msg); if (parsed.error) msg = parsed.error; } catch {}
      setBookError(msg);
    } finally {
      setBooking(false);
    }
  }

  // ── Walkthrough submission (no Stripe) ───────────────────────────────────
  async function submitWalkthroughBooking() {
    if (!company) return;
    setWalkthroughBooking(true);
    setBookError("");
    try {
      const result = await pubFetch("/api/public/book/walkthrough", {
        method: "POST",
        body: JSON.stringify({
          company_id: company.id,
          first_name: firstName, last_name: lastName, phone, email, zip,
          referral_source: referral || null, sms_consent: smsConsent,
          address, preferred_date: selectedDate,
        }),
      });
      setBookResult(result);
      setStep(5);
    } catch (err: any) {
      let msg = err.message || "Something went wrong. Please try again.";
      try { const parsed = JSON.parse(msg); if (parsed.error) msg = parsed.error; } catch {}
      setBookError(msg);
    } finally {
      setWalkthroughBooking(false);
    }
  }

  // ── Scope selection helper — sets DB scope + display key + resets state ──
  function selectScope(newScopeId: number, key: string) {
    setScopeId(newScopeId);
    setDisplayScopeKey(key);
    setMoveInAck(false); setMoveInNotes("");
    setUpsellCadence(""); setUpsellAccepted(false); setUpsellDeclined(false);
    setUpsellTermsOpen(false); setUpsellCadenceError(false);
    setLastCleanedResponse(""); setLastCleanedOverride(false); setOverageAcknowledged(false);
  }

  // ── Frequency label helper ────────────────────────────────────────────────
  function wLabel(f: string) {
    const m: Record<string, string> = { onetime: "One-Time", weekly: "Weekly", biweekly: "Every 2 Weeks", monthly: "Every 4 Weeks" };
    return m[f] || f;
  }

  // ── Shared styles ─────────────────────────────────────────────────────────
  const s = {
    input: {
      width: "100%", padding: "10px 14px", border: "1px solid #E5E2DC", borderRadius: 8,
      fontSize: 14, color: "#1A1917", background: "#fff", outline: "none",
      fontFamily: "'Plus Jakarta Sans', sans-serif",
      boxSizing: "border-box" as const,
    },
    label: { display: "block", fontSize: 12, fontWeight: 600, color: "#6B6860", marginBottom: 6 },
    field: { marginBottom: 16 },
    err: { fontSize: 11, color: "#EF4444", marginTop: 4, display: "flex", alignItems: "center", gap: 4 },
    card: { background: "#fff", border: "1px solid #E5E2DC", borderRadius: 12, padding: 24 },
    h2: { fontSize: 20, fontWeight: 700, color: "#1A1917", marginBottom: 6, marginTop: 0 },
    sub: { fontSize: 14, color: "#6B6860", marginBottom: 24 },
    btn: (primary = true) => ({
      padding: "12px 28px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600,
      background: primary ? brand : "#F7F6F3", color: primary ? "#fff" : "#1A1917",
      transition: "opacity 0.15s", fontFamily: "'Plus Jakarta Sans', sans-serif",
    }),
    scopeCard: (sel: boolean) => ({
      padding: "14px 18px", border: `2px solid ${sel ? brand : "#E5E2DC"}`, borderRadius: 10,
      cursor: "pointer", background: sel ? `${brand}12` : "#fff", transition: "all 0.15s",
    }),
    freqCard: (sel: boolean) => ({
      padding: "12px 16px", border: `2px solid ${sel ? brand : "#E5E2DC"}`, borderRadius: 10,
      cursor: "pointer", background: sel ? `${brand}12` : "#fff", transition: "all 0.15s", textAlign: "left" as const,
      width: "100%",
    }),
    addonCard: (_sel: boolean) => ({ display: "none" }), // replaced by icon-card layout
  };

  // ── Loading / not found states ────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#F7F6F3", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
        <div style={{ color: "#6B6860", fontSize: 15 }}>Loading...</div>
      </div>
    );
  }

  if (notFound || !company) {
    return (
      <div style={{ minHeight: "100vh", background: "#F7F6F3", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: 24, fontWeight: 700, color: "#1A1917", marginBottom: 8 }}>Company not found</p>
          <p style={{ fontSize: 14, color: "#6B6860" }}>The booking link you followed does not match any active company.</p>
        </div>
      </div>
    );
  }

  const selectedScope = company.active_scopes.find(s => s.id === scopeId);
  const isCommercial = (selectedScope?.name ?? "").toLowerCase().includes("commercial");
  const isRecurringScope = !isCommercial && !!scopeId && (selectedScope?.name ?? "").toLowerCase() === "recurring cleaning";
  const isMoveInOut = displayScopeKey === "move_in_out";
  const isDeepClean = displayScopeKey === "deep_clean";
  const isDeepCleanScope = selectedScope?.name?.toLowerCase().trim() === "deep clean";
  const getOverageRate = (freq: string) => freq === "weekly" ? 60 : freq === "biweekly" ? 65 : 70;

  // Upsell state machine — mutually exclusive, explicit
  const showVeryDirtyCard   = isDeepCleanScope && cleanliness === 3;
  const showUpsellOffer     = isDeepCleanScope && cleanliness > 0 && cleanliness !== 3 && !upsellAccepted && !upsellDeclined;
  const showUpsellConfirmed = isDeepCleanScope && upsellAccepted === true;
  const showSoftNudge       = isDeepCleanScope && upsellDeclined === true && cleanliness !== 3;
  const cleanlinessLabel: Record<number, string> = { 1: "Very Clean", 2: "Moderately Clean", 3: "Very Dirty" };

  // Synchronous upsell price — instant, zero network dependency
  const upsellPriceResult = calculateUpsellPrice(sqft, upsellCadence, offerSettings?.upsell_discount_percent ?? 15);

  const scopeNameLower = (selectedScope?.name ?? "").toLowerCase();
  const showCleanlinessQ = !isCommercial && !!scopeId && (
    (scopeNameLower.includes("deep clean") && !scopeNameLower.includes("hourly")) ||
    scopeNameLower.includes("one-time standard") ||
    scopeNameLower.startsWith("recurring")
  );
  const conditionMultiplier = 1.0;

  // ── Scope-based add-on visibility rules ──────────────────────────────────
  const ALLOWED_ADDON_IDS: Record<string, number[]> = {
    deep_clean:        [8, 10, 12, 16, 19],
    move_in_out:       [8, 10, 12, 16],
    one_time_standard: [8, 10, 12],
    recurring:         [8, 10, 12],
    commercial:        [22],
  };
  const scopeKeyForAddons = isDeepCleanScope ? "deep_clean"
    : isMoveInOut ? "move_in_out"
    : scopeNameLower.includes("one-time") || scopeNameLower.includes("one time") ? "one_time_standard"
    : isRecurringScope ? "recurring"
    : isCommercial ? "commercial"
    : null;
  const allowedAddonIds: number[] | null = scopeKeyForAddons ? (ALLOWED_ADDON_IDS[scopeKeyForAddons] ?? null) : null;

  const visibleAddons = addons.filter(a => {
    const nl = a.name.toLowerCase();
    if (nl.includes("loyalty")) return false;
    if (nl.includes("promo")) return false;
    if (nl.includes("second appointment")) return false;
    if (nl.includes("commercial adjustment")) return false;
    if (allowedAddonIds && !allowedAddonIds.includes(a.id)) return false;
    return true;
  });

  const isDynamicPricedAddon = (addonId: number) => {
    const a = addons.find(x => x.id === addonId);
    return a && (a.price_type === "percentage" || a.price_type === "percent" || a.price_type === "sqft_pct");
  };

  const activeBundleId: number | null = (() => {
    for (const b of bundles) {
      const items = b.items as { addon_id: number }[];
      if (items.every(it => selectedAddonIds.includes(it.addon_id))) return b.id as number;
    }
    return null;
  })();
  const activeBundle = bundles.find(b => b.id === activeBundleId) ?? null;

  const calcBundleSavings = (bundle: any): number => {
    const items = (bundle.items as { addon_id: number; price_type: string }[]).filter(it => !isDynamicPricedAddon(it.addon_id));
    const dv = parseFloat(bundle.discount_value);
    if (bundle.discount_type === "flat_per_item") return items.length * dv;
    if (bundle.discount_type === "flat_total") return dv;
    if (bundle.discount_type === "percentage") {
      let sum = 0;
      for (const it of items) {
        const ab = calcResult?.addon_breakdown.find(x => x.id === it.addon_id);
        if (ab) sum += ab.amount * dv / 100;
      }
      return Math.round(sum * 100) / 100;
    }
    return 0;
  };
  const bundleSavings = activeBundle ? calcBundleSavings(activeBundle) : 0;

  const partialBundleNudge: { bundleName: string; missingName: string } | null = (() => {
    if (activeBundleId !== null) return null;
    for (const b of bundles) {
      const items = b.items as { addon_id: number; addon_name: string }[];
      const selected = items.filter(it => selectedAddonIds.includes(it.addon_id));
      const missing = items.filter(it => !selectedAddonIds.includes(it.addon_id));
      if (selected.length > 0 && missing.length === 1) return { bundleName: b.name, missingName: missing[0].addon_name };
    }
    return null;
  })();

  const bundleAddonIds = new Set(bundles.flatMap(b => (b.items as { addon_id: number }[]).map(it => it.addon_id)));

  const addonPersuasionLine = (() => {
    if (!scopeNameLower || isCommercial) return null;
    if (scopeNameLower.includes("deep clean")) return "Deep cleans are the perfect time to tackle appliances and those forgotten spots — add extras while we're already there.";
    if (scopeNameLower.includes("one-time") || scopeNameLower.includes("one time")) return "Make the most of your single visit — add any extras you want handled today.";
    if (scopeNameLower.startsWith("recurring")) return "Regular clients save the most by including consistent extras in every visit.";
    if (scopeNameLower.includes("move")) return "Moving out or in? Add appliance and cabinet cleaning to leave the place spotless.";
    return null;
  })();

  const stepLabels = ["Contact", "Scope", "Frequency", "Date", "Payment", "Confirmed"];

  // ── Right panel ───────────────────────────────────────────────────────────
  const sectionLabel: React.CSSProperties = {
    margin: "0 0 12px", fontWeight: 700, fontSize: 11, textTransform: "uppercase",
    letterSpacing: "0.07em", color: "#9E9B94",
  };
  const rightPanel = (
    <div className="bw-sidebar" style={{ width: 300, flexShrink: 0 }}>
      <div style={{ position: "sticky", top: 24, display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Section 1 — Contact Information */}
        <div style={s.card}>
          <p style={sectionLabel}>Contact Information</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {company.phone && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <Phone size={14} color={brand} style={{ flexShrink: 0 }} />
                <a href={`tel:${company.phone}`} style={{ color: brand, textDecoration: "none", fontWeight: 600 }}>{company.phone}</a>
              </div>
            )}
            {company.email && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <Mail size={14} color={brand} style={{ flexShrink: 0 }} />
                <a href={`mailto:${company.email}`} style={{ color: "#1A1917", textDecoration: "none" }}>{company.email}</a>
              </div>
            )}
          </div>
        </div>

        {/* Section 2 — Office Locations */}
        <div style={s.card}>
          <p style={sectionLabel}>Office Locations</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <MapPin size={14} color={brand} style={{ marginTop: 2, flexShrink: 0 }} />
              <div>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1A1917" }}>Oak Lawn, IL</p>
                <p style={{ margin: 0, fontSize: 12, color: "#9E9B94" }}>Oak Lawn, IL</p>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <MapPin size={14} color={brand} style={{ marginTop: 2, flexShrink: 0 }} />
              <div>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1A1917" }}>Schaumburg</p>
                <p style={{ margin: 0, fontSize: 12, color: "#9E9B94" }}>Schaumburg, IL</p>
              </div>
            </div>
          </div>
        </div>

        {/* Section 3 — Business Hours */}
        <div style={s.card}>
          <p style={sectionLabel}>Business Hours</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {(company.business_hours ?? "").split("\n").filter(Boolean).map(line => {
              const colonIdx = line.indexOf(": ");
              const day = colonIdx >= 0 ? line.slice(0, colonIdx) : line;
              const time = colonIdx >= 0 ? line.slice(colonIdx + 2) : "";
              return (
                <div key={line} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 13 }}>
                  <span style={{ color: "#6B6860" }}>{day}</span>
                  <span style={{ color: time === "Closed" ? "#9E9B94" : "#1A1917", fontWeight: 500 }}>{time || day}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Section 4 — Important Policies */}
        <div style={s.card}>
          <p style={sectionLabel}>Important Policies</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 14 }}>
            {["48-hour cancellation notice required", "24-hour satisfaction guarantee", "Licensed, bonded & insured"].map(policy => (
              <div key={policy} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "#6B6860" }}>
                <CheckCircle2 size={14} color={brand} style={{ marginTop: 1, flexShrink: 0 }} />
                <span>{policy}</span>
              </div>
            ))}
          </div>
          <a href="https://phes.io/terms" target="_blank" rel="noreferrer"
            style={{ display: "block", textAlign: "center", fontSize: 12, fontWeight: 600, color: brand, textDecoration: "none", padding: "9px 14px", border: `1px solid ${brand}`, borderRadius: 8 }}>
            View Full Terms & Conditions
          </a>
        </div>

        {/* Estimate summary (appears once pricing is selected) */}
        {calcResult && (
          <div style={s.card}>
            <p style={{ margin: "0 0 12px", fontWeight: 700, fontSize: 14, color: "#1A1917", borderBottom: "1px solid #E5E2DC", paddingBottom: 10 }}>Estimate Summary</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Row label="Service" value={calcResult.scope_name} />
              <Row label="Sq Ft" value={`${sqft.toLocaleString()} sqft`} />
              <Row label="Frequency" value={calcResult.frequency} />
              <Row label="Est. Hours" value={`${calcResult.base_hours.toFixed(1)}h`} />
              <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 8, marginTop: 4 }} />
              <Row label="Base Price" value={`$${calcResult.base_price.toFixed(2)}`} />
              {calcResult.addon_breakdown.map(a => (
                <Row key={a.id} label={a.name} value={`+$${a.amount.toFixed(2)}`} />
              ))}
              {calcResult.discount_amount > 0 && (
                <Row label="Bundle Discount" value={`-$${calcResult.discount_amount.toFixed(2)}`} green />
              )}
              {calcResult.minimum_applied && (
                <p style={{ fontSize: 11, color: "#F59E0B", margin: 0 }}>Minimum bill rate applied</p>
              )}
            </div>
            <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 12, marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 13, color: "#6B6860" }}>Estimated Total</span>
              <span style={{ fontSize: 24, fontWeight: 800, color: "#1A1917" }}>${(calcResult.final_total * conditionMultiplier).toFixed(2)}</span>
            </div>
            <p style={{ fontSize: 11, color: "#9E9B94", margin: "6px 0 0" }}>Final price confirmed at time of service.</p>
          </div>
        )}
      </div>
    </div>
  );

  // ── Page wrapper ──────────────────────────────────────────────────────────
  return (
    <div className="bw-root" style={{ minHeight: "100vh", background: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: `
        @media (max-width: 767px) {
          .bw-topbar { padding: 12px 16px !important; }
          .bw-progress { padding: 10px 16px !important; }
          .bw-progress-inner { gap: 2px !important; }
          .bw-step-label { display: none !important; }
          .bw-step-label.active { display: inline !important; }
          .bw-body { flex-direction: column !important; padding: 16px !important; }
          .bw-sidebar { display: none !important; }
          .bw-form { width: 100% !important; }
          .bw-grid2 { grid-template-columns: 1fr !important; }
          .bw-consent { font-size: 13px !important; line-height: 1.6 !important; }
          .bw-root input:not([type="checkbox"]):not([type="radio"]), .bw-root select, .bw-root textarea { min-height: 48px !important; font-size: 16px !important; }
          .bw-nav { flex-direction: column !important; gap: 8px !important; }
          .bw-nav button { width: 100% !important; min-height: 52px !important; font-size: 15px !important; }
          .bw-nav-end button { width: 100% !important; min-height: 52px !important; font-size: 15px !important; }
          .bw-nav-end { justify-content: stretch !important; }
        }
        @media (max-width: 400px) {
          .bw-step-label { display: none !important; }
          .bw-step-label.active { display: inline !important; }
        }
      `}} />
      {/* Top bar */}
      <div className="bw-topbar" style={{ background: "#fff", borderBottom: "1px solid #E5E2DC", padding: "14px 32px", display: "flex", alignItems: "center", gap: 16 }}>
        {logoSrc ? (
          <img src={logoSrc} alt={company.name} style={{ height: 32, objectFit: "contain" }} />
        ) : (
          <span style={{ fontWeight: 800, fontSize: 18, color: brand }}>{company.name}</span>
        )}
        <span style={{ fontSize: 14, color: "#6B6860", marginLeft: "auto" }}>Online Booking</span>
      </div>

      {/* Progress bar */}
      {step < 5 && (
        <div className="bw-progress" style={{ background: "#fff", borderBottom: "1px solid #E5E2DC", padding: "12px 32px" }}>
          <div className="bw-progress-inner" style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "center", gap: 4 }}>
            {stepLabels.slice(0, 5).map((label, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", flex: i < 4 ? "1" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 700, flexShrink: 0,
                    background: i < step ? brand : i === step ? brand : "#E5E2DC",
                    color: i <= step ? "#fff" : "#9E9B94",
                  }}>
                    {i < step ? <CheckCircle2 size={14} /> : i + 1}
                  </div>
                  <span className={`bw-step-label${i === step ? " active" : ""}`} style={{ fontSize: 12, fontWeight: i === step ? 700 : 400, color: i === step ? "#1A1917" : "#9E9B94", whiteSpace: "nowrap" }}>
                    {label}
                  </span>
                </div>
                {i < 4 && <div style={{ flex: 1, height: 2, background: i < step ? brand : "#E5E2DC", margin: "0 8px", borderRadius: 2 }} />}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bw-body" style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px", display: "flex", gap: 32, alignItems: "flex-start" }}>
        <div className="bw-form" style={{ flex: 1, minWidth: 0 }}>

          {/* ── Step 0: Contact Info ────────────────────────────────────────── */}
          {step === 0 && (
            <div style={s.card}>
              <p style={s.h2}>Let's get started</p>
              <p style={s.sub}>Tell us a bit about yourself so we can get your home on the schedule.</p>

              <div className="bw-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
                <FieldWrap label="First Name" error={errors.firstName}>
                  <input style={s.input} value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Jane" />
                </FieldWrap>
                <FieldWrap label="Last Name" error={errors.lastName}>
                  <input style={s.input} value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Doe" />
                </FieldWrap>
              </div>
              <div className="bw-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
                <FieldWrap label="Cell Phone" error={errors.phone}>
                  <input style={s.input} value={phone} onChange={e => setPhone(e.target.value)} placeholder="(773) 555-0000" type="tel" />
                </FieldWrap>
                <FieldWrap label="Email" error={errors.email}>
                  <input style={s.input} value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com" type="email" />
                </FieldWrap>
              </div>
              <div className="bw-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
                <FieldWrap label="Zip Code" error={errors.zip}>
                  <input style={s.input} value={zip} onChange={e => setZip(e.target.value)} placeholder="60453" maxLength={5} />
                </FieldWrap>
                <FieldWrap label="How did you hear about us?">
                  <select style={{ ...s.input, width: "100%" }} value={referral} onChange={e => setReferral(e.target.value)}>
                    <option value="">Select...</option>
                    {["Google","Facebook","Instagram","Nextdoor","Friend/Family","Other"].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </FieldWrap>
              </div>

              <FieldWrap label="Service Address" error={errors.address}>
                <input style={s.input} value={address} onChange={e => setAddressField(e.target.value)} placeholder="Enter your service address" />
              </FieldWrap>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={smsConsent} onChange={e => setSmsConsent(e.target.checked)} style={{ marginTop: 3, accentColor: brand, width: 16, height: 16, flexShrink: 0, minHeight: "unset" }} />
                  <span className="bw-consent" style={{ fontSize: 13, color: "#6B6860", width: "100%" }}>
                    By checking this box, you agree to receive transactional SMS messages from Phes regarding your appointment. Message frequency varies. Message and data rates may apply. Reply STOP to opt out. You must be 18 or older to opt in. View our{" "}
                    <a href="https://phes.io/terms" target="_blank" rel="noopener noreferrer" style={{ color: brand, textDecoration: "underline" }}>Terms of Service</a>
                    {" "}and{" "}
                    <a href="https://phes.io/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: brand, textDecoration: "underline" }}>Privacy Policy</a>.
                  </span>
                </label>
              </div>
              <div style={{ marginBottom: 24 }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={termsConsent} onChange={e => setTermsConsent(e.target.checked)} style={{ marginTop: 3, accentColor: brand, width: 16, height: 16, flexShrink: 0, minHeight: "unset" }} />
                  <span style={{ fontSize: 13, color: "#6B6860" }}>
                    I have read and agree to the{" "}
                    <a href="https://phes.io/terms" target="_blank" rel="noopener noreferrer"
                      style={{ color: brand, textDecoration: "underline", fontWeight: 600 }}>
                      terms and conditions
                    </a>.
                  </span>
                </label>
                {errors.terms && <div style={s.err}><AlertCircle size={12} />{errors.terms}</div>}
              </div>

              <div className="bw-nav-end" style={{ display: "flex", justifyContent: "flex-end" }}>
                <button style={s.btn()} onClick={() => { if (validateStep0()) setStep(1); }}>
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* ── Step 1: Scope + Home Details ─────────────────────────────────── */}
          {step === 1 && (
            <div style={s.card}>
              <p style={s.h2}>What type of cleaning do you need?</p>
              <p style={s.sub}>Select a service and tell us about your home.</p>

              {/* Scope cards — 5-scope display (Deep Clean + Move In/Out split), name-matched from DB */}
              {(() => {
                type ScopeDef = { key: string; displayName: string; match: (n: string) => boolean };
                const WIDGET_SCOPES: { group: string; scopes: ScopeDef[] }[] = [
                  {
                    group: "Residential",
                    scopes: [
                      { key: "deep_clean",       displayName: "Deep Clean",           match: (n) => n === "deep clean" },
                      { key: "move_in_out",       displayName: "Move In / Move Out",   match: (n) => n === "move in / move out" },
                      { key: "one_time_standard", displayName: "One-Time Standard Clean", match: (n) => n.includes("one-time standard") || n.includes("one time standard") },
                      { key: "recurring",         displayName: "Recurring Cleaning",   match: (n) => n === "recurring cleaning" },
                    ],
                  },
                  {
                    group: "Commercial",
                    scopes: [
                      { key: "commercial", displayName: "Commercial Cleaning", match: (n) => n.includes("commercial cleaning") },
                    ],
                  },
                ];
                return WIDGET_SCOPES.map(({ group, scopes }) => {
                  const rendered = scopes
                    .map(def => {
                      const dbScope = company.active_scopes.find(s => def.match(s.name.toLowerCase()));
                      return dbScope ? { def, dbScope } : null;
                    })
                    .filter(Boolean) as { def: ScopeDef; dbScope: typeof company.active_scopes[0] }[];
                  if (rendered.length === 0) return null;
                  return (
                    <div key={group} style={{ marginBottom: 20 }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>{group}</p>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        {rendered.map(({ def, dbScope }) => {
                          const sel = displayScopeKey === def.key;
                          return (
                            <div key={def.key} style={s.scopeCard(sel)} onClick={() => selectScope(dbScope.id, def.key)}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${sel ? brand : "#C4C1BA"}`, background: sel ? brand : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                  {sel && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />}
                                </div>
                                <span style={{ fontWeight: 600, fontSize: 14, color: "#1A1917" }}>{def.displayName}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                });
              })()}

              {/* ── Last-Cleaned Question (Recurring only) ──────────────────── */}
              {isRecurringScope && (() => {
                const LAST_CLEANED_OPTS = [
                  { value: "within_2_weeks", label: "Within the last 2 weeks" },
                  { value: "2_4_weeks",      label: "2–4 weeks ago" },
                  { value: "1_3_months",     label: "1–3 months ago" },
                  { value: "over_3_months",  label: "Over 3 months ago — or never" },
                ];
                const isOverdue = ["1_3_months", "over_3_months"].includes(lastCleanedResponse);
                const showDCRec = isOverdue && !lastCleanedOverride;
                return (
                  <div ref={lastCleanedRef} style={{ borderTop: "1px solid #E5E2DC", paddingTop: 24, marginTop: 8, marginBottom: 0 }}>
                    <p style={{ fontWeight: 700, fontSize: 15, color: "#1A1917", marginBottom: 4 }}>
                      When was your home last professionally cleaned?
                    </p>
                    <p style={{ fontSize: 13, color: "#6B6860", margin: "0 0 14px" }}>
                      This helps us send the right team prepared for your home.
                    </p>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 0 }}>
                      {LAST_CLEANED_OPTS.map(opt => {
                        const sel = lastCleanedResponse === opt.value;
                        return (
                          <div
                            key={opt.value}
                            onClick={() => { setLastCleanedResponse(opt.value); setLastCleanedOverride(false); }}
                            style={{
                              padding: "12px 14px",
                              border: `2px solid ${sel ? brand : "#E5E2DC"}`,
                              borderRadius: 10,
                              background: sel ? `${brand}12` : "#fff",
                              cursor: "pointer",
                              fontSize: 13,
                              fontWeight: sel ? 700 : 500,
                              color: sel ? brand : "#1A1917",
                              transition: "all 0.15s",
                            }}
                          >
                            {opt.label}
                          </div>
                        );
                      })}
                    </div>

                    {/* Original rec card — shown when overdue + not yet overridden */}
                    {isOverdue && !lastCleanedOverride && (
                      <div style={{ marginTop: 16, background: "#fff", border: "1px solid #E5E2DC", borderLeft: `3px solid ${brand}`, borderRadius: 10, padding: 16 }}>
                        <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 14, color: "#1A1917" }}>
                          We recommend starting with a Deep Clean
                        </p>
                        <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6B6860", lineHeight: 1.55 }}>
                          When a home hasn't been professionally cleaned in over 30 days, a Deep Clean ensures the best results — and sets the foundation for a great recurring service. Most customers who start with a Deep Clean stay recurring long-term.
                        </p>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <button
                            onClick={() => {
                              const dcScope = company.active_scopes.find(s => s.name.toLowerCase().trim() === "deep clean");
                              if (dcScope) selectScope(dcScope.id, "deep_clean");
                            }}
                            style={{ padding: "10px 18px", background: brand, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
                          >
                            Book a Deep Clean Instead
                          </button>
                          <button
                            onClick={() => { setLastCleanedOverride(true); setOverageAcknowledged(false); }}
                            style={{ padding: "10px 18px", background: "#fff", color: brand, border: `1.5px solid ${brand}`, borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
                          >
                            Continue with Recurring Anyway
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Disclaimer card — shown after "Continue with Recurring Anyway" is clicked */}
                    {isOverdue && lastCleanedOverride && (
                      <div style={{ marginTop: 16, background: "#fff", border: "1px solid #E5E2DC", borderLeft: `3px solid ${brand}`, borderRadius: 10, padding: 16 }}>
                        <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 14, color: "#1A1917" }}>
                          Before you continue — please read carefully
                        </p>
                        <p style={{ margin: "0 0 12px", fontSize: 14, color: "#6B6860", lineHeight: 1.6 }}>
                          Since you've chosen to skip our recommended Deep Clean, please note that our time estimate for your first visit is approximate. Homes that haven't been professionally cleaned recently often require additional time to reach our quality standard.
                        </p>
                        <p style={{ margin: "0 0 8px", fontSize: 14, color: "#6B6860", lineHeight: 1.6 }}>
                          If your cleaning requires more time than estimated, the following extended service rates apply:
                        </p>
                        <div style={{ marginBottom: 14, fontSize: 13 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 0", marginBottom: 4 }}>
                            <span style={{ fontWeight: 700, color: "#1A1917", paddingBottom: 4, borderBottom: "1px solid #E5E2DC" }}>Frequency</span>
                            <span style={{ fontWeight: 700, color: "#1A1917", paddingBottom: 4, borderBottom: "1px solid #E5E2DC", paddingLeft: 8 }}>Extended Service Rate</span>
                          </div>
                          {[
                            ["Weekly", "$60 / additional hour"],
                            ["Every 2 Weeks", "$65 / additional hour"],
                            ["Every 4 Weeks or less frequent", "$70 / additional hour"],
                          ].map(([freq, rate]) => (
                            <div key={freq} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", paddingTop: 6 }}>
                              <span style={{ color: "#6B6860" }}>{freq}</span>
                              <span style={{ color: "#1A1917", fontWeight: 600, paddingLeft: 8 }}>{rate}</span>
                            </div>
                          ))}
                        </div>
                        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={overageAcknowledged}
                            onChange={e => setOverageAcknowledged(e.target.checked)}
                            style={{ marginTop: 2, accentColor: brand, width: 16, height: 16, flexShrink: 0 }}
                          />
                          <span style={{ fontSize: 14, color: "#1A1917", lineHeight: 1.5 }}>
                            I understand that time estimates are approximate and I agree to the extended service rates above if additional time is needed.
                          </span>
                        </label>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── Move In / Move Out special notes + acknowledgment ─────────── */}
              {isMoveInOut && scopeId && (
                <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 24, marginTop: 8, marginBottom: 8 }}>

                  {/* Notes textarea */}
                  <div style={{ marginBottom: 20 }}>
                    <label style={{ display: "block", fontWeight: 600, fontSize: 13, color: "#1A1917", marginBottom: 6 }}>
                      Special notes or anything you'd like us to know
                    </label>
                    <textarea
                      value={moveInNotes}
                      onChange={e => setMoveInNotes(e.target.value)}
                      placeholder="e.g. garage access code, fragile items in cabinets, areas to avoid…"
                      rows={3}
                      style={{
                        width: "100%", boxSizing: "border-box",
                        border: "1.5px solid #E5E2DC", borderRadius: 8,
                        padding: "10px 12px", fontSize: 13, color: "#1A1917",
                        fontFamily: "'Plus Jakarta Sans', sans-serif",
                        resize: "vertical", outline: "none",
                        background: "#fff", lineHeight: 1.5,
                      }}
                    />
                  </div>

                  {/* Single consolidated acknowledgment */}
                  <p style={{ fontWeight: 600, fontSize: 15, color: "#1A1917", marginBottom: 12 }}>Before we confirm your booking</p>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={moveInAck}
                      onChange={e => setMoveInAck(e.target.checked)}
                      style={{ marginTop: 2, accentColor: brand, width: 16, height: 16, flexShrink: 0 }}
                    />
                    <span style={{ fontSize: 13, color: "#1A1917", lineHeight: 1.5 }}>
                      I confirm the property will be completely empty of furniture and personal belongings, no other contractors will be present, and the property will have running water and working electricity on the day of cleaning.
                    </span>
                  </label>
                </div>
              )}

              {scopeId && !isCommercial && (
                <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 24, marginTop: isMoveInOut ? 0 : (isRecurringScope ? 16 : 8) }}>
                  <p style={{ fontWeight: 700, fontSize: 15, color: "#1A1917", marginBottom: 16 }}>Home Details</p>

                  <FieldWrap label="Square Footage">
                    <input
                      style={s.input}
                      type="number"
                      value={sqft || ""}
                      onChange={e => setSqft(parseInt(e.target.value) || 0)}
                      onBlur={() => runCalc()}
                      placeholder="e.g. 2000"
                    />
                  </FieldWrap>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                    {([
                      ["Bedrooms", bedrooms, setBedrooms],
                      ["Full Bathrooms", bathrooms, setBathrooms],
                      ["Half Bathrooms", halfBaths, setHalfBaths],
                      ["Floors", floors, setFloors],
                      ["People in Household", people, setPeople],
                      ["Pets", pets, setPets],
                    ] as [string, number, (v: number) => void][]).map(([label, val, setter]) => (
                      <div key={label}>
                        <span style={s.label}>{label}</span>
                        <Stepper value={val} onChange={setter} />
                      </div>
                    ))}
                  </div>

                  {showCleanlinessQ && (
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6B6860", marginBottom: 8 }}>
                        How would you rate the current cleanliness of your home?
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        {([
                          [1, "1 — Very Clean"],
                          [2, "2 — Moderately Clean"],
                          [3, "3 — Very Dirty"],
                        ] as [number, string][]).map(([v, label]) => (
                          <button
                            key={v}
                            onClick={() => setCleanliness(v)}
                            style={{
                              flex: 1, padding: "10px 6px", borderRadius: 8,
                              border: `2px solid ${cleanliness === v ? brand : "#E5E2DC"}`,
                              background: cleanliness === v ? `${brand}10` : "#fff",
                              fontWeight: 600, fontSize: 12,
                              color: cleanliness === v ? brand : "#1A1917",
                              cursor: "pointer", transition: "all 0.15s",
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {showVeryDirtyCard && (
                        <div style={{ marginTop: 12, background: "#FFF8F0", border: "1.5px solid #F59E0B", borderRadius: 10, padding: 16 }}>
                          <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: "0.07em" }}>Custom Quote Required</p>
                          <p style={{ margin: 0, fontSize: 14, color: "#78350F", lineHeight: 1.5 }}>
                            Heavily soiled homes require an in-person assessment before we can book online. Our office team will reach out to get you scheduled right away.
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Deep Clean Recurring Upsell ──────────────────────────── */}
                  {(showUpsellOffer || showUpsellConfirmed || showSoftNudge) && offerSettings?.upsell_enabled !== false && (
                    <div style={{ marginTop: 16, background: "#FFFFFF", border: "1px solid #E5E2DC", borderLeft: `3px solid ${brand}`, borderRadius: 10, padding: 20 }}>
                      {showUpsellOffer && (
                        <>
                          <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 700, color: brand, textTransform: "uppercase", letterSpacing: "0.08em" }}>Limited Offer</p>
                          <p style={{ margin: "0 0 12px", fontSize: 18, fontWeight: 600, color: "#1A1917", lineHeight: 1.3 }}>Turn today's Deep Clean into a fresh start</p>
                          <p style={{ margin: "0 0 16px", fontSize: 14, color: "#6B6860", lineHeight: 1.6 }}>
                            Start recurring service today and get {offerSettings?.upsell_discount_percent ?? 15}% off your first recurring cleaning{offerSettings?.rate_lock_enabled !== false ? ` — plus your recurring rate is locked for ${offerSettings?.rate_lock_duration_months ?? 24} months. Your rate will never increase as long as your home stays consistent and your service continues.` : "."}
                          </p>

                          <div style={{ marginBottom: 14 }}>
                            <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>How often would you like us to come back?</p>
                            <div style={{ display: "flex", gap: 8 }}>
                              {[
                                { value: "weekly", label: "Weekly" },
                                { value: "biweekly", label: "Every 2 Weeks" },
                                { value: "monthly", label: "Every 4 Weeks" },
                              ].map(opt => (
                                <button
                                  key={opt.value}
                                  onClick={() => { setUpsellCadence(opt.value); setUpsellCadenceError(false); }}
                                  style={{
                                    flex: 1, padding: "10px 4px", borderRadius: 8,
                                    border: `2px solid ${upsellCadence === opt.value ? brand : (upsellCadenceError ? brand : "#E5E2DC")}`,
                                    background: upsellCadence === opt.value ? `${brand}12` : "#fff",
                                    fontWeight: 600, fontSize: 13, color: upsellCadence === opt.value ? brand : "#1A1917",
                                    cursor: "pointer", transition: "all 0.15s", fontFamily: "'Plus Jakarta Sans', sans-serif",
                                  }}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                            {upsellCadenceError && <p style={{ margin: "6px 0 0", fontSize: 12, color: brand }}>Please select how often you'd like us to come back.</p>}
                          </div>

                          {upsellCadence && (
                            <div style={{ marginBottom: 14, padding: "12px 14px", background: "#F7F6F3", borderRadius: 8, minHeight: 56 }}>
                              {!sqft ? (
                                <p style={{ margin: 0, fontSize: 12, color: "#6B6860" }}>Enter your home size above to see your rate.</p>
                              ) : upsellPriceResult ? (
                                <>
                                  <p style={{ margin: "0 0 3px", fontSize: 15, fontWeight: 600, color: "#1A1917" }}>
                                    Your first recurring cleaning:{" "}
                                    <span style={{ textDecoration: "line-through", color: "#9E9B94", fontWeight: 400 }}>${upsellPriceResult.recurringRate.toFixed(2)}</span>
                                    {" "}<strong style={{ color: brand }}>${upsellPriceResult.firstVisitRate.toFixed(2)}</strong>
                                  </p>
                                  <p style={{ margin: 0, fontSize: 12, color: "#6B6860" }}>
                                    Then ${upsellPriceResult.recurringRate.toFixed(2)}/visit{offerSettings?.rate_lock_enabled !== false ? ` — locked for ${offerSettings?.rate_lock_duration_months ?? 24} months.` : "."}
                                  </p>
                                </>
                              ) : (
                                <p style={{ margin: 0, fontSize: 12, color: "#6B6860" }}>Contact us for a custom rate.</p>
                              )}
                            </div>
                          )}

                          {offerSettings?.rate_lock_enabled !== false && (
                            <div style={{ marginBottom: 16 }}>
                              <button
                                onClick={() => setUpsellTermsOpen(o => !o)}
                                style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: brand, textDecoration: "underline", cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
                              >
                                Rate lock terms
                              </button>
                              {upsellTermsOpen && (
                                <p style={{ margin: "8px 0 0", fontSize: 12, color: "#6B6860", lineHeight: 1.6, fontStyle: "italic" }}>
                                  Your rate is guaranteed for {offerSettings?.rate_lock_duration_months ?? 24} months as long as your home stays the same. If your home significantly changes — new pets, more people, or major renovations — we may need to adjust your rate. Your guarantee also pauses if you skip service for more than {offerSettings?.service_gap_days ?? 60} days, or if your first few cleanings consistently take longer than expected.
                                </p>
                              )}
                            </div>
                          )}

                          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <button
                              onClick={() => {
                                if (!upsellCadence) { setUpsellCadenceError(true); return; }
                                if (!upsellPriceResult) return;
                                setUpsellAccepted(true); setUpsellDeclined(false); setFrequencyStr(upsellCadence);
                              }}
                              disabled={!upsellCadence || !upsellPriceResult}
                              style={{
                                padding: "12px 20px", background: brand, color: "#fff", border: "none", borderRadius: 8,
                                fontSize: 14, fontWeight: 600, fontFamily: "'Plus Jakarta Sans', sans-serif",
                                cursor: (!upsellCadence || !upsellPriceResult) ? "not-allowed" : "pointer",
                                opacity: (!upsellCadence || !upsellPriceResult) ? 0.55 : 1,
                                transition: "opacity 0.15s",
                              }}
                            >
                              {!upsellCadence || upsellPriceResult ? "Yes — lock in my rate" : "Enter your home size to continue"}
                            </button>
                            <button
                              onClick={() => { setUpsellDeclined(true); setUpsellAccepted(false); }}
                              style={{ padding: "12px 20px", background: "#FFFFFF", color: "#6B6860", border: "1px solid #6B6860", borderRadius: 8, fontSize: 14, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
                            >
                              No thanks, just the Deep Clean
                            </button>
                          </div>
                        </>
                      )}

                      {showUpsellConfirmed && (
                        <>
                          <p style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Rate lock confirmed</p>
                          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#6B6860", lineHeight: 1.5 }}>
                            {offerSettings?.rate_lock_enabled !== false && <>Your recurring rate will be locked for {offerSettings?.rate_lock_duration_months ?? 24} months at ${upsellPriceResult?.recurringRate?.toFixed(2) ?? "--"}/visit. </>}
                            First visit: <strong style={{ color: brand }}>${upsellPriceResult?.firstVisitRate?.toFixed(2) ?? "--"}</strong> ({offerSettings?.upsell_discount_percent ?? 15}% off applied).
                          </p>
                          <button
                            onClick={() => { setUpsellAccepted(false); setUpsellDeclined(false); setUpsellCadence(""); }}
                            style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: "#6B6860", textDecoration: "underline", cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
                          >
                            Change selection
                          </button>
                        </>
                      )}

                      {showSoftNudge && (
                        <>
                          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#6B6860", lineHeight: 1.6 }}>
                            No problem. You can always set up recurring service later — just give our office a call or reply to your confirmation email and we'll get you set up.
                          </p>
                          <button
                            onClick={() => { setUpsellDeclined(false); setUpsellAccepted(false); setUpsellCadence(""); }}
                            style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: brand, textDecoration: "underline", cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
                          >
                            Actually, I'd like to set up recurring service
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {scopeId && isCommercial && (
                <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 24, marginTop: 8 }}>
                  <p style={{ fontWeight: 700, fontSize: 15, color: "#1A1917", marginBottom: 4 }}>Select Service Type</p>
                  <p style={{ fontSize: 13, color: "#6B6860", marginBottom: 20 }}>Choose the option that fits your needs.</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                    {/* Single Visit */}
                    <div
                      onClick={() => setCommercialOption("single")}
                      style={{
                        padding: "18px 20px", borderRadius: 10, cursor: "pointer", transition: "all 0.15s",
                        border: `2px solid ${commercialOption === "single" ? brand : "#E5E2DC"}`,
                        background: commercialOption === "single" ? `${brand}10` : "#fff",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        <div style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${commercialOption === "single" ? brand : "#C4C1BA"}`, background: commercialOption === "single" ? brand : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          {commercialOption === "single" && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />}
                        </div>
                        <span style={{ fontWeight: 700, fontSize: 15, color: "#1A1917" }}>Single Visit Cleaning</span>
                      </div>
                      <p style={{ margin: "0 0 0 28px", fontSize: 13, color: "#6B6860" }}>$180 for up to 3 hours. Each additional hour is $60.</p>
                    </div>

                    {/* Cleaning Walkthrough */}
                    <div
                      onClick={() => setCommercialOption("walkthrough")}
                      style={{
                        padding: "18px 20px", borderRadius: 10, cursor: "pointer", transition: "all 0.15s", position: "relative",
                        border: `2px solid ${brand}`,
                        background: commercialOption === "walkthrough" ? `${brand}10` : "#fff",
                      }}
                    >
                      <div style={{ position: "absolute", top: -11, left: 16, background: brand, color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 12px", borderRadius: 20, letterSpacing: "0.04em" }}>Recommended</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        <div style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${commercialOption === "walkthrough" ? brand : "#C4C1BA"}`, background: commercialOption === "walkthrough" ? brand : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          {commercialOption === "walkthrough" && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />}
                        </div>
                        <span style={{ fontWeight: 700, fontSize: 15, color: "#1A1917" }}>Cleaning Walkthrough</span>
                      </div>
                      <p style={{ margin: "0 0 0 28px", fontSize: 13, color: "#6B6860" }}>Free assessment. We visit your space, understand your needs, and build a custom recurring cleaning plan.</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="bw-nav" style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
                <button style={s.btn(false)} onClick={() => setStep(0)}>Back</button>
                <button
                  style={{ ...s.btn(), opacity: (() => {
                    if (isCommercial) return !commercialOption ? 0.5 : 1;
                    if (!scopeId || !sqft) return 0.5;
                    if (isMoveInOut && !moveInAck) return 0.5;
                    if (isMoveInOut && showCleanlinessQ && cleanliness === 0) return 0.5;
                    if (showVeryDirtyCard) return 0.5;
                    if (isDeepCleanScope && (cleanliness === 0 || (!upsellAccepted && !upsellDeclined))) return 0.5;
                    if (isRecurringScope && (!lastCleanedResponse || (["1_3_months", "over_3_months"].includes(lastCleanedResponse) && (!lastCleanedOverride || !overageAcknowledged)) || cleanliness === 0)) return 0.5;
                    if (!isMoveInOut && !isDeepCleanScope && !isRecurringScope && showCleanlinessQ && cleanliness === 0) return 0.5;
                    return 1;
                  })() }}
                  disabled={(() => {
                    if (isCommercial) return !commercialOption;
                    if (!scopeId || !sqft) return true;
                    if (isMoveInOut && !moveInAck) return true;
                    if (isMoveInOut && showCleanlinessQ && cleanliness === 0) return true;
                    if (showVeryDirtyCard) return true;
                    if (isDeepCleanScope && (cleanliness === 0 || (!upsellAccepted && !upsellDeclined))) return true;
                    if (isRecurringScope && (!lastCleanedResponse || (["1_3_months", "over_3_months"].includes(lastCleanedResponse) && (!lastCleanedOverride || !overageAcknowledged)) || cleanliness === 0)) return true;
                    if (!isMoveInOut && !isDeepCleanScope && !isRecurringScope && showCleanlinessQ && cleanliness === 0) return true;
                    return false;
                  })()}
                  onClick={() => isCommercial ? setStep(3) : setStep(2)}
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* ── Step 2: Frequency + Add-ons ──────────────────────────────────── */}
          {step === 2 && (
            <div style={s.card}>
              {/* Heading — scope-aware */}
              {isRecurringScope ? (
                <>
                  <p style={s.h2}>How often and what extras?</p>
                  <p style={s.sub}>Choose your cleaning frequency and any add-ons.</p>
                </>
              ) : (
                <>
                  <p style={s.h2}>Add extras to your cleaning</p>
                  <p style={s.sub}>{upsellAccepted ? "Your recurring schedule is confirmed. Choose any extras below." : "Customize your cleaning with any optional add-ons."}</p>
                </>
              )}

              {/* Deep Clean + upsell accepted — read-only frequency row */}
              {isDeepCleanScope && upsellAccepted && (
                <div style={{ marginBottom: 24, padding: "14px 16px", background: "#F7F6F3", borderRadius: 10, border: "1px solid #E5E2DC" }}>
                  <p style={{ margin: "0 0 4px", fontSize: 13, color: "#6B6860", fontWeight: 600 }}>Cleaning Frequency</p>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{wLabel(upsellCadence)}</p>
                    <button
                      onClick={() => { setUpsellAccepted(false); setUpsellDeclined(false); setStep(1); }}
                      style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: brand, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600 }}
                    >
                      Change
                    </button>
                  </div>
                </div>
              )}

              {/* Recurring normal path — cadence picker (required) */}
              {isRecurringScope && (
                <div style={{ marginBottom: 24 }}>
                  <span style={s.label}>Frequency</span>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {([
                      { value: "weekly",   label: "Weekly" },
                      { value: "biweekly", label: "Every 2 Weeks" },
                      { value: "monthly",  label: "Every 4 Weeks" },
                    ] as { value: string; label: string }[]).map(f => (
                      <button key={f.value} style={s.freqCard(frequencyStr === f.value)} onClick={() => setFrequencyStr(f.value)}>
                        <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: "#1A1917" }}>{f.label}</p>
                      </button>
                    ))}
                  </div>
                  {lastCleanedOverride && overageAcknowledged && frequencyStr && (
                    <p style={{ margin: "10px 0 0", fontSize: 12, color: "#6B6860", lineHeight: 1.5 }}>
                      Extended service rate applies if additional time is needed based on your selected frequency.
                    </p>
                  )}
                </div>
              )}

              {/* Add-ons grid — explicit hardcoded cards, one SVG per card */}
              {(() => {
                // Resolve DB addon IDs by known IDs — display is always shown regardless
                const dbById = (id: number) => addons.find(a => a.id === id);
                const ovenDb   = dbById(8);
                const fridgeDb = dbById(10);
                const cabDb    = dbById(12);
                const winDb    = dbById(16);
                const basDb    = dbById(19);

                const deepBase = calcResult?.base_price ?? 0;
                const dynPrice = (deepBase > 0 && sqft > 0)
                  ? Math.round(deepBase * 0.15 * 100) / 100
                  : null;

                const ovenSel  = selectedAddonIds.includes(ovenDb?.id ?? 8);
                const fridgeSel = selectedAddonIds.includes(fridgeDb?.id ?? 10);
                const cabSel   = selectedAddonIds.includes(cabDb?.id ?? 12);
                const winSel   = selectedAddonIds.includes(winDb?.id ?? 16);
                const basSel   = selectedAddonIds.includes(basDb?.id ?? 19);

                const applianceActive  = ovenSel && fridgeSel;
                const bundleDisc = parseFloat(activeBundle?.discount_value ?? "0");

                // Show oven nudge on oven card if ONLY fridge is selected
                const showOvenNudge   = fridgeSel && !ovenSel;
                // Show fridge nudge on fridge card if ONLY oven is selected
                const showFridgeNudge = ovenSel && !fridgeSel;

                const cardStyle = (sel: boolean) => ({
                  border: `2px solid ${sel ? brand : "#E5E2DC"}`,
                  borderRadius: 8,
                  background: sel ? `${brand}0F` : "#FFFFFF",
                  cursor: "pointer", overflow: "hidden",
                  transition: "border-color 0.15s, background 0.15s",
                });
                const iconAreaStyle = (sel: boolean) => ({
                  height: 120, background: sel ? `${brand}22` : "#F7F6F3",
                  borderRadius: "8px 8px 0 0", display: "flex",
                  alignItems: "center", justifyContent: "center",
                  position: "relative" as const, transition: "background 0.15s",
                });
                const checkStyle = (sel: boolean) => ({
                  width: 22, height: 22, borderRadius: 5,
                  border: `2px solid ${sel ? brand : "#C4C1BA"}`,
                  background: sel ? brand : "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0 as const,
                  transition: "background 0.15s, border-color 0.15s",
                });
                const addedChip = (
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: "#fff",
                    background: brand, borderRadius: 20,
                    padding: "2px 8px", flexShrink: 0,
                    fontFamily: "'Plus Jakarta Sans', sans-serif",
                  }}>Added</span>
                );
                const popularBadge = (
                  <span style={{
                    position: "absolute", top: 8, right: 8,
                    fontSize: 10, fontWeight: 700,
                    background: brand, color: "#fff",
                    padding: "2px 8px", borderRadius: 20,
                    fontFamily: "'Plus Jakarta Sans', sans-serif",
                  }}>Most Popular</span>
                );
                const amberNudge = (text: string) => (
                  <p style={{
                    fontSize: 11, color: "#92400E", margin: 0,
                    background: "#FEF3C7", padding: "4px 8px",
                    borderRadius: 6, lineHeight: 1.4,
                    fontFamily: "'Plus Jakarta Sans', sans-serif",
                  }}>{text}</p>
                );
                const flatPriceNode = (pv: number, bundleActive: boolean) => {
                  if (!bundleActive) return <span>+${pv.toFixed(2)}</span>;
                  const disc = Math.round((pv - bundleDisc) * 100) / 100;
                  return (
                    <span>
                      <span style={{ textDecoration: "line-through", color: "#9E9B94", marginRight: 4 }}>+${pv.toFixed(2)}</span>
                      <span style={{ color: "#2D6A4F", fontWeight: 700 }}>+${disc.toFixed(2)}</span>
                    </span>
                  );
                };
                const dynPriceNode = dynPrice !== null
                  ? <span>+${dynPrice.toFixed(2)}</span>
                  : null;
                const dynSubLabel = dynPrice !== null
                  ? `+$${dynPrice.toFixed(2)}`
                  : "Price varies by home size";

                const toggle = (id: number) => {
                  setSelectedAddonIds(prev =>
                    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
                  );
                };

                // Scoped visibility: which hardcoded cards show per scope
                const showDynCards = isDeepCleanScope || isMoveInOut; // Windows shows for deep + move
                const showBasCard  = isDeepCleanScope;                  // Basement only for Deep Clean
                const showFlatCards = !isCommercial;                    // Oven/Fridge/Cabinet for all non-commercial

                const hasAnyCard = showFlatCards || showDynCards || showBasCard;

                return hasAnyCard ? (
                  <div style={{ marginBottom: 16 }}>
                    <span style={s.label}>Add-ons (optional)</span>
                    <div className="bw-grid2" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginTop: 8 }}>

                      {/* Card 1 — Oven Cleaning */}
                      {showFlatCards && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <div style={cardStyle(ovenSel)} onClick={() => toggle(ovenDb?.id ?? 8)}>
                            <div style={iconAreaStyle(ovenSel)}>
                              <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: brand }}>
                                <rect x="8" y="8" width="48" height="48" rx="4" stroke="currentColor" strokeWidth="2.5"/>
                                <rect x="16" y="24" width="32" height="24" rx="2" stroke="currentColor" strokeWidth="2"/>
                                <circle cx="20" cy="16" r="3" stroke="currentColor" strokeWidth="2"/>
                                <circle cx="32" cy="16" r="3" stroke="currentColor" strokeWidth="2"/>
                                <circle cx="44" cy="16" r="3" stroke="currentColor" strokeWidth="2"/>
                                <line x1="22" y1="36" x2="42" y2="36" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                              </svg>
                              {popularBadge}
                            </div>
                            <div style={{ padding: 16 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <div style={checkStyle(ovenSel)}>{ovenSel && <CheckCircle2 size={14} color="#fff" />}</div>
                                <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, color: "#1A1917" }}>Oven Cleaning</div>
                                {ovenSel ? addedChip : <div style={{ fontWeight: 600, fontSize: 13, color: "#1A1917", flexShrink: 0 }}>{flatPriceNode(50, applianceActive)}</div>}
                              </div>
                              <p style={{ margin: "6px 0 0 28px", fontSize: 12, color: "#6B6860", lineHeight: 1.4 }}>
                                Recommended by 9 out of 10 clients
                              </p>
                            </div>
                          </div>
                          {showOvenNudge && amberNudge("Add Oven Cleaning to unlock the Appliance Bundle — save $10")}
                        </div>
                      )}

                      {/* Card 2 — Refrigerator Cleaning */}
                      {showFlatCards && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <div style={cardStyle(fridgeSel)} onClick={() => toggle(fridgeDb?.id ?? 10)}>
                            <div style={iconAreaStyle(fridgeSel)}>
                              <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: brand }}>
                                <rect x="12" y="4" width="40" height="56" rx="4" stroke="currentColor" strokeWidth="2.5"/>
                                <line x1="12" y1="24" x2="52" y2="24" stroke="currentColor" strokeWidth="2"/>
                                <line x1="28" y1="12" x2="28" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                                <line x1="28" y1="32" x2="28" y2="48" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                              </svg>
                              {popularBadge}
                            </div>
                            <div style={{ padding: 16 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <div style={checkStyle(fridgeSel)}>{fridgeSel && <CheckCircle2 size={14} color="#fff" />}</div>
                                <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, color: "#1A1917" }}>Refrigerator Cleaning</div>
                                {fridgeSel ? addedChip : <div style={{ fontWeight: 600, fontSize: 13, color: "#1A1917", flexShrink: 0 }}>{flatPriceNode(50, applianceActive)}</div>}
                              </div>
                              <p style={{ margin: "6px 0 0 28px", fontSize: 12, color: "#6B6860", lineHeight: 1.4 }}>
                                Recommended by 9 out of 10 clients
                              </p>
                            </div>
                          </div>
                          {showFridgeNudge && amberNudge("Add Refrigerator Cleaning to unlock the Appliance Bundle — save $10")}
                        </div>
                      )}

                      {/* Card 3 — Kitchen Cabinets */}
                      {showFlatCards && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <div style={cardStyle(cabSel)} onClick={() => toggle(cabDb?.id ?? 12)}>
                            <div style={iconAreaStyle(cabSel)}>
                              <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: brand }}>
                                <rect x="4" y="8" width="26" height="48" rx="2" stroke="currentColor" strokeWidth="2.5"/>
                                <rect x="34" y="8" width="26" height="48" rx="2" stroke="currentColor" strokeWidth="2.5"/>
                                <circle cx="24" cy="32" r="2.5" fill="currentColor"/>
                                <circle cx="40" cy="32" r="2.5" fill="currentColor"/>
                                <line x1="4" y1="32" x2="30" y2="32" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3"/>
                                <line x1="34" y1="32" x2="60" y2="32" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3"/>
                              </svg>
                            </div>
                            <div style={{ padding: 16 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <div style={checkStyle(cabSel)}>{cabSel && <CheckCircle2 size={14} color="#fff" />}</div>
                                <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, color: "#1A1917" }}>Kitchen Cabinets</div>
                                {cabSel ? addedChip : <span style={{ fontWeight: 600, fontSize: 13, color: "#1A1917", flexShrink: 0 }}>+$50.00</span>}
                              </div>
                              <p style={{ margin: "6px 0 0 28px", fontSize: 12, color: "#6B6860", lineHeight: 1.4 }}>
                                Cabinets must be empty upon arrival
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Card 4 — Windows */}
                      {showDynCards && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <div style={cardStyle(winSel)} onClick={() => toggle(winDb?.id ?? 16)}>
                            <div style={iconAreaStyle(winSel)}>
                              <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: brand }}>
                                <rect x="6" y="6" width="52" height="52" rx="3" stroke="currentColor" strokeWidth="2.5"/>
                                <line x1="32" y1="6" x2="32" y2="58" stroke="currentColor" strokeWidth="2"/>
                                <line x1="6" y1="32" x2="58" y2="32" stroke="currentColor" strokeWidth="2"/>
                                <path d="M14 14 Q20 20 14 26" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.5"/>
                              </svg>
                            </div>
                            <div style={{ padding: 16 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <div style={checkStyle(winSel)}>{winSel && <CheckCircle2 size={14} color="#fff" />}</div>
                                <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, color: "#1A1917" }}>Windows (inside panes only) — Tracks not included</div>
                                {winSel ? addedChip : dynPriceNode && <div style={{ fontWeight: 600, fontSize: 13, color: "#1A1917", flexShrink: 0 }}>{dynPriceNode}</div>}
                              </div>
                              <p style={{ margin: "6px 0 0 28px", fontSize: 12, color: "#6B6860", lineHeight: 1.4 }}>
                                {dynSubLabel}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Card 5 — Clean Basement */}
                      {showBasCard && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <div style={cardStyle(basSel)} onClick={() => toggle(basDb?.id ?? 19)}>
                            <div style={iconAreaStyle(basSel)}>
                              <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: brand }}>
                                <path d="M4 28 L32 8 L60 28" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                                <rect x="8" y="28" width="48" height="28" rx="2" stroke="currentColor" strokeWidth="2.5"/>
                                <rect x="24" y="40" width="16" height="16" rx="1" stroke="currentColor" strokeWidth="2"/>
                                <line x1="8" y1="40" x2="22" y2="40" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                                <line x1="42" y1="40" x2="56" y2="40" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                              </svg>
                            </div>
                            <div style={{ padding: 16 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <div style={checkStyle(basSel)}>{basSel && <CheckCircle2 size={14} color="#fff" />}</div>
                                <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, color: "#1A1917" }}>Clean Basement</div>
                                {basSel ? addedChip : dynPriceNode && <div style={{ fontWeight: 600, fontSize: 13, color: "#1A1917", flexShrink: 0 }}>{dynPriceNode}</div>}
                              </div>
                              <p style={{ margin: "6px 0 0 28px", fontSize: 12, color: "#6B6860", lineHeight: 1.4 }}>
                                {dynSubLabel}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                    </div>

                    {/* Appliance Bundle badge */}
                    {activeBundle && bundleSavings > 0 && (
                      <div style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        marginTop: 12, padding: "8px 16px",
                        background: "#2D6A4F", borderRadius: 20,
                      }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#fff", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                          Appliance Bundle applied — you're saving ${bundleSavings.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                ) : null;
              })()}

              <p style={{ fontSize: 12, color: "#6B6860", marginBottom: 16, marginTop: 4, lineHeight: 1.5, textAlign: "center" }}>
                Add extras now — requesting them later may require a separate visit.
              </p>

              {/* Running total */}
              {calcResult && selectedAddonIds.length > 0 && (
                <div style={{ textAlign: "right", marginBottom: 12 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#1A1917", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                    Subtotal: ${(calcResult.final_total).toFixed(2)}
                  </span>
                </div>
              )}

              <div className="bw-nav" style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                <button style={s.btn(false)} onClick={() => setStep(1)}>Back</button>
                <button
                  style={{ ...s.btn(), opacity: (isRecurringScope && !frequencyStr) ? 0.5 : 1 }}
                  disabled={isRecurringScope && !frequencyStr}
                  onClick={() => setStep(3)}
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: Date Selection ────────────────────────────────────────── */}
          {step === 3 && (
            <div style={s.card}>
              <p style={s.h2}>When would you like your first cleaning?</p>
              <p style={s.sub}>All available dates are shown below. Select your preferred date.</p>

              <SimpleCalendar
                selected={selectedDate}
                onSelect={setSelectedDate}
                brand={brand}
                leadDays={bookingSettings?.booking_lead_days ?? 7}
                maxAdvanceDays={bookingSettings?.max_advance_days ?? 60}
                availableDays={bookingSettings ? {
                  sun: bookingSettings.available_sun,
                  mon: bookingSettings.available_mon,
                  tue: bookingSettings.available_tue,
                  wed: bookingSettings.available_wed,
                  thu: bookingSettings.available_thu,
                  fri: bookingSettings.available_fri,
                  sat: bookingSettings.available_sat,
                } : undefined}
              />

              {selectedDate && (
                <div style={{ marginTop: 16, padding: "12px 16px", background: `${brand}12`, borderRadius: 10, border: `1px solid ${brand}`, display: "flex", alignItems: "center", gap: 10 }}>
                  <Calendar size={16} color={brand} />
                  <span style={{ fontWeight: 600, fontSize: 14, color: "#1A1917" }}>
                    First Job: {new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                  </span>
                </div>
              )}

              {bookError && (
                <div style={{ marginTop: 16, padding: "12px 16px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#DC2626" }}>
                  <AlertCircle size={14} /> {bookError}
                </div>
              )}

              <div className="bw-nav" style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
                <button style={s.btn(false)} onClick={() => isCommercial ? setStep(1) : setStep(2)}>Back</button>
                <button
                  style={{ ...s.btn(), opacity: (!selectedDate || walkthroughBooking) ? 0.5 : 1 }}
                  disabled={!selectedDate || walkthroughBooking}
                  onClick={() => {
                    if (isCommercial && commercialOption === "walkthrough") {
                      submitWalkthroughBooking();
                    } else {
                      setStep(4);
                    }
                  }}
                >
                  {walkthroughBooking ? "Scheduling..." : (isCommercial && commercialOption === "walkthrough") ? "Schedule Walkthrough" : "Continue"}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 4: Payment ───────────────────────────────────────────────── */}
          {step === 4 && (
            <div style={s.card}>
              <p style={s.h2}>Secure your appointment</p>
              <p style={s.sub}>Your card is saved securely and charged only after each completed cleaning.</p>

              {/* Stripe card form (when Stripe is configured) */}
              {stripeEnabled !== false && (
                <div style={{ marginBottom: 20 }}>
                  {stripeSetupLoading || stripeEnabled === null ? (
                    <div style={{ padding: "20px", textAlign: "center", fontSize: 13, color: "#9E9B94" }}>Setting up secure payment...</div>
                  ) : (
                    <div>
                      <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 13, color: "#1A1917" }}>Card Details</p>
                      <div
                        id="stripe-card-element-book"
                        style={{
                          border: "1px solid #E5E2DC", borderRadius: 8,
                          padding: "14px 16px", backgroundColor: "#FFFFFF",
                          minHeight: 48,
                        }}
                      />
                      <p style={{ margin: "8px 0 0", fontSize: 11, color: "#9E9B94" }}>
                        Secured by Stripe. Your card details are encrypted and never stored on our servers.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 16, marginBottom: 20 }}>
                <p style={{ margin: "0 0 12px", fontWeight: 700, fontSize: 13, color: "#1A1917" }}>Booking Summary</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <Row label="Name" value={`${firstName} ${lastName}`} />
                  <Row label="Email" value={email} />
                  <Row label="Phone" value={phone} />
                  <Row label="Service" value={selectedScope?.name ?? ""} />
                  {sqft > 0 && <Row label="Sq Ft" value={`${sqft.toLocaleString()} sqft`} />}
                  <Row label="Frequency" value={frequencyStr} />
                  {selectedDate && <Row label="First Date" value={new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} />}
                  {address && <Row label="Address" value={address} />}
                  {calcResult && <Row label="Estimated Total" value={`$${(calcResult.final_total * conditionMultiplier).toFixed(2)}`} bold />}
                </div>
              </div>

              {bookError && (
                <div style={{ marginBottom: 16, padding: "12px 16px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#DC2626" }}>
                  <AlertCircle size={14} /> {bookError}
                </div>
              )}

              <div className="bw-nav" style={{ display: "flex", justifyContent: "space-between" }}>
                <button style={s.btn(false)} onClick={() => setStep(3)}>Back</button>
                <button
                  style={{ ...s.btn(), opacity: (booking || (stripeEnabled && !stripeCardReady)) ? 0.7 : 1 }}
                  disabled={booking || (stripeEnabled === true && !stripeCardReady)}
                  onClick={submitBooking}
                >
                  {booking ? "Processing..." : stripeEnabled ? "Confirm & Book" : "Book It"}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 5: Confirmation ──────────────────────────────────────────── */}
          {step === 5 && bookResult && isCommercial && commercialOption === "walkthrough" && (
            <div style={s.card}>
              <div style={{ textAlign: "center", marginBottom: 32 }}>
                <div style={{ width: 64, height: 64, borderRadius: "50%", background: `${brand}20`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                  <Calendar size={32} color={brand} />
                </div>
                <p style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 800, color: "#1A1917" }}>We'll see you soon.</p>
                <p style={{ margin: 0, fontSize: 14, color: "#6B6860" }}>Your walkthrough is scheduled. A member of our team will reach out to confirm your appointment and answer any questions before your visit.</p>
              </div>

              <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 24 }}>
                <p style={{ margin: "0 0 16px", fontWeight: 700, fontSize: 15, color: "#1A1917" }}>Appointment Details</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <Row label="Name" value={`${firstName} ${lastName}`} />
                  <Row label="Email" value={email} />
                  <Row label="Phone" value={phone} />
                  {address && <Row label="Address" value={address} />}
                  {selectedDate && <Row label="Walkthrough Date" value={new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })} bold />}
                </div>
              </div>
            </div>
          )}

          {step === 5 && bookResult && !(isCommercial && commercialOption === "walkthrough") && (
            <div style={s.card}>
              <div style={{ textAlign: "center", marginBottom: 32 }}>
                <div style={{ width: 64, height: 64, borderRadius: "50%", background: `${brand}20`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                  <CheckCircle2 size={32} color={brand} />
                </div>
                <p style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 800, color: "#1A1917" }}>You're all set!</p>
                <p style={{ margin: 0, fontSize: 14, color: "#6B6860" }}>Your booking has been confirmed. We'll reach out with additional details.</p>
              </div>

              <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 24, marginBottom: 24 }}>
                <p style={{ margin: "0 0 16px", fontWeight: 700, fontSize: 15, color: "#1A1917" }}>Booking Details</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <Row label="Name" value={`${firstName} ${lastName}`} />
                  <Row label="Email" value={email} />
                  <Row label="Phone" value={phone} />
                  {address && <Row label="Address" value={address} />}
                  <Row label="Service" value={selectedScope?.name ?? ""} />
                  {sqft > 0 && <Row label="Sq Ft" value={`${sqft.toLocaleString()} sqft · ${bedrooms}br / ${bathrooms}ba`} />}
                  {!isCommercial && <Row label="Frequency" value={frequencyStr} />}
                  {isCommercial && commercialOption === "single" && <Row label="Rate" value="$180 for up to 3 hrs · $60/additional hr" />}
                  {selectedDate && <Row label="First Cleaning" value={new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })} bold />}
                  {bookResult.pricing?.final_total !== undefined && <Row label="Estimated Total" value={`$${bookResult.pricing.final_total.toFixed(2)}`} bold />}
                </div>
              </div>

              {bookResult.pricing?.addon_breakdown?.length > 0 && (
                <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 16, marginBottom: 24 }}>
                  <p style={{ margin: "0 0 12px", fontWeight: 700, fontSize: 14, color: "#1A1917" }}>Add-ons</p>
                  {bookResult.pricing.addon_breakdown.map((a: any) => (
                    <Row key={a.id} label={a.name} value={`$${a.amount.toFixed(2)}`} />
                  ))}
                </div>
              )}

              <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 10, padding: "14px 18px", marginBottom: 24 }}>
                <p style={{ margin: 0, fontSize: 13, color: "#166534", fontWeight: 600 }}>Your card has been saved securely.</p>
                <p style={{ margin: "4px 0 0", fontSize: 13, color: "#166534" }}>You will be charged after each completed cleaning, not at booking.</p>
              </div>

              {company.booking_policies && (
                <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 20 }}>
                  <p style={{ margin: "0 0 10px", fontWeight: 700, fontSize: 14, color: "#1A1917" }}>Things to Know</p>
                  <div style={{ fontSize: 13, color: "#6B6860", lineHeight: 1.7, whiteSpace: "pre-line" }}>
                    {company.booking_policies}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {rightPanel}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function FieldWrap({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6B6860", marginBottom: 6 }}>{label}</label>
      {children}
      {error && (
        <div style={{ fontSize: 11, color: "#EF4444", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
          <AlertCircle size={12} />{error}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, green, bold }: { label: string; value: string; green?: boolean; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
      <span style={{ fontSize: 13, color: "#6B6860", flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: bold ? 700 : 400, color: green ? "#10B981" : "#1A1917", textAlign: "right" }}>{value}</span>
    </div>
  );
}
