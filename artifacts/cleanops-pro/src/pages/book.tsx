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
function SimpleCalendar({ selected, onSelect, brand, leadHours }: { selected: string; onSelect: (d: string) => void; brand: string; leadHours?: number }) {
  const effectiveLeadHours = leadHours ?? 48;
  const minDate = new Date();
  minDate.setTime(minDate.getTime() + effectiveLeadHours * 60 * 60 * 1000);
  minDate.setHours(0, 0, 0, 0);

  const [viewDate, setViewDate] = useState(() => {
    const d = new Date(minDate);
    return d;
  });

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = viewDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  function fmtDay(day: number) {
    const d = new Date(year, month, day);
    return d.toISOString().split("T")[0];
  }

  function isPast(day: number) {
    const d = new Date(year, month, day);
    d.setHours(0, 0, 0, 0);
    return d < minDate;
  }

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 12, padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <button onClick={() => setViewDate(new Date(year, month - 1, 1))} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 6 }}>
          <ChevronLeft size={18} color="#6B6860" />
        </button>
        <span style={{ fontWeight: 600, fontSize: 15, color: "#1A1917" }}>{monthName}</span>
        <button onClick={() => setViewDate(new Date(year, month + 1, 1))} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 6 }}>
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
          const past = isPast(day);
          const sel = dateStr === selected;
          return (
            <button
              key={i}
              disabled={past}
              onClick={() => onSelect(dateStr)}
              style={{
                width: "100%", aspectRatio: "1", borderRadius: 8, border: sel ? `2px solid ${brand}` : "1px solid transparent",
                background: sel ? brand : past ? "#F7F6F3" : "#fff",
                color: sel ? "#fff" : past ? "#C4C1BA" : "#1A1917",
                fontSize: 13, fontWeight: sel ? 700 : 400, cursor: past ? "default" : "pointer",
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
  const [bedrooms, setBedrooms] = useState(2);
  const [bathrooms, setBathrooms] = useState(1);
  const [halfBaths, setHalfBaths] = useState(0);
  const [floors, setFloors] = useState(1);
  const [people, setPeople] = useState(2);
  const [pets, setPets] = useState(0);
  const [cleanliness, setCleanliness] = useState(0);
  const [lastCleanedResponse, setLastCleanedResponse] = useState("");
  const [lastCleanedOverride, setLastCleanedOverride] = useState(false);

  // Step 2: Frequency + Add-ons
  const [frequencyStr, setFrequencyStr] = useState("");
  const [selectedAddonIds, setSelectedAddonIds] = useState<number[]>([]);
  const [address, setAddressField] = useState("");
  const [discountInput, setDiscountInput] = useState("");
  const [discountCode, setDiscountCode] = useState("");
  const [discountError, setDiscountError] = useState("");

  // Step 3: Date
  const [selectedDate, setSelectedDate] = useState("");

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

  // ── Load company ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    pubFetch(`/api/public/company/${slug}`)
      .then(d => {
        setCompany(d);
        setLoading(false);
        pubFetch(`/api/public/bundles/${d.id}`).then(bs => setBundles(bs)).catch(() => {});
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
    Promise.all([
      pubFetch(`/api/public/frequencies/${scopeId}`),
      pubFetch(`/api/public/addons/${scopeId}`),
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

  // ── Live pricing calculation ──────────────────────────────────────────────
  const runCalc = useCallback(async (opts?: { code?: string }) => {
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
          discount_code: opts?.code ?? discountCode,
        }),
      });
      setCalcResult(result);
      if (opts?.code !== undefined) {
        if (result.discount_valid === false) {
          setDiscountError("Code not found or inactive");
          setDiscountCode("");
        } else if (result.discount_amount > 0) {
          setDiscountError("");
          setDiscountCode(opts.code);
        }
      }
    } catch { /* silent */ }
    finally { setCalcLoading(false); }
  }, [company, scopeId, sqft, frequencyStr, selectedAddonIds, discountCode]);

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
            addon_ids: selectedAddonIds, discount_code: discountCode || null,
            bedrooms, bathrooms, half_baths: halfBaths, floors, people, pets, cleanliness,
            home_condition_rating: showCleanlinessQ ? (cleanliness || 1) : null,
            condition_multiplier: showCleanlinessQ ? conditionMultiplier : null,
            applied_bundle_id: activeBundleId,
            bundle_discount_total: bundleSavings > 0 ? bundleSavings : null,
            last_cleaned_response: scopeId === 11 ? (lastCleanedResponse || null) : null,
            last_cleaned_flag: scopeId === 11 ? (["1_3_months", "over_3_months"].includes(lastCleanedResponse) ? "overdue" : "ok") : null,
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
          addon_ids: selectedAddonIds, discount_code: discountCode || null,
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
    addonCard: (sel: boolean) => ({
      display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 16px",
      border: `2px solid ${sel ? brand : "#E5E2DC"}`, borderRadius: 10,
      cursor: "pointer", background: sel ? `${brand}12` : "#fff", transition: "all 0.15s",
    }),
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
  const cleanlinessLabel: Record<number, string> = { 1: "Very Clean", 2: "Moderately Clean", 3: "Very Dirty" };

  const scopeNameLower = (selectedScope?.name ?? "").toLowerCase();
  const showCleanlinessQ = !isCommercial && !!scopeId && (
    (scopeNameLower.includes("deep clean") && !scopeNameLower.includes("hourly")) ||
    scopeNameLower.includes("one-time standard") ||
    scopeNameLower.startsWith("recurring")
  );
  const conditionMultiplier = (showCleanlinessQ && cleanliness === 3) ? 1.08 : 1.0;

  // ── Bundle detection ──────────────────────────────────────────────────────
  const visibleAddons = addons.filter(a => !a.name.toLowerCase().includes("loyalty discount"));

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
    <div style={{ width: 300, flexShrink: 0 }}>
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
              <Row label="Hourly Rate" value={`$${calcResult.hourly_rate.toFixed(0)}/hr`} />
              <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 8, marginTop: 4 }} />
              <Row label="Base Price" value={`$${calcResult.base_price.toFixed(2)}`} />
              {calcResult.addon_breakdown.map(a => (
                <Row key={a.id} label={a.name} value={`+$${a.amount.toFixed(2)}`} />
              ))}
              {calcResult.discount_amount > 0 && (
                <Row label={`Discount${discountCode ? ` (${discountCode})` : ""}`} value={`-$${calcResult.discount_amount.toFixed(2)}`} green />
              )}
              {conditionMultiplier > 1 && (
                <Row label="Condition Adj. (+8%)" value={`+$${(calcResult.final_total * 0.08).toFixed(2)}`} />
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
    <div style={{ minHeight: "100vh", background: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      {/* Top bar */}
      <div style={{ background: "#fff", borderBottom: "1px solid #E5E2DC", padding: "14px 32px", display: "flex", alignItems: "center", gap: 16 }}>
        {logoSrc ? (
          <img src={logoSrc} alt={company.name} style={{ height: 32, objectFit: "contain" }} />
        ) : (
          <span style={{ fontWeight: 800, fontSize: 18, color: brand }}>{company.name}</span>
        )}
        <span style={{ fontSize: 14, color: "#6B6860", marginLeft: "auto" }}>Online Booking</span>
      </div>

      {/* Progress bar */}
      {step < 5 && (
        <div style={{ background: "#fff", borderBottom: "1px solid #E5E2DC", padding: "12px 32px" }}>
          <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "center", gap: 4 }}>
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
                  <span style={{ fontSize: 12, fontWeight: i === step ? 700 : 400, color: i === step ? "#1A1917" : "#9E9B94", whiteSpace: "nowrap" }}>
                    {label}
                  </span>
                </div>
                {i < 4 && <div style={{ flex: 1, height: 2, background: i < step ? brand : "#E5E2DC", margin: "0 8px", borderRadius: 2 }} />}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px", display: "flex", gap: 32, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>

          {/* ── Step 0: Contact Info ────────────────────────────────────────── */}
          {step === 0 && (
            <div style={s.card}>
              <p style={s.h2}>Let's get started</p>
              <p style={s.sub}>Tell us a bit about yourself so we can get your home on the schedule.</p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
                <FieldWrap label="First Name" error={errors.firstName}>
                  <input style={s.input} value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Jane" />
                </FieldWrap>
                <FieldWrap label="Last Name" error={errors.lastName}>
                  <input style={s.input} value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Doe" />
                </FieldWrap>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
                <FieldWrap label="Cell Phone" error={errors.phone}>
                  <input style={s.input} value={phone} onChange={e => setPhone(e.target.value)} placeholder="(773) 555-0000" type="tel" />
                </FieldWrap>
                <FieldWrap label="Email" error={errors.email}>
                  <input style={s.input} value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com" type="email" />
                </FieldWrap>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
                <FieldWrap label="Zip Code" error={errors.zip}>
                  <input style={s.input} value={zip} onChange={e => setZip(e.target.value)} placeholder="60453" maxLength={5} />
                </FieldWrap>
                <FieldWrap label="How did you hear about us?">
                  <select style={s.input} value={referral} onChange={e => setReferral(e.target.value)}>
                    <option value="">Select...</option>
                    {["Google","Facebook","Instagram","Nextdoor","Friend/Family","Other"].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </FieldWrap>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={smsConsent} onChange={e => setSmsConsent(e.target.checked)} style={{ marginTop: 3, accentColor: brand, width: 16, height: 16 }} />
                  <span style={{ fontSize: 13, color: "#6B6860" }}>
                    By checking this box, you agree to receive transactional SMS messages from Phes regarding your appointment. Message frequency varies. Message and data rates may apply. Reply STOP to opt out. You must be 18 or older to opt in. View our{" "}
                    <a href="https://phes.io/terms" target="_blank" rel="noopener noreferrer" style={{ color: brand, textDecoration: "underline" }}>Terms of Service</a>
                    {" "}and{" "}
                    <a href="https://phes.io/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: brand, textDecoration: "underline" }}>Privacy Policy</a>.
                  </span>
                </label>
              </div>
              <div style={{ marginBottom: 24 }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={termsConsent} onChange={e => setTermsConsent(e.target.checked)} style={{ marginTop: 3, accentColor: brand, width: 16, height: 16 }} />
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

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
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

              {/* Scope cards — fixed 4-scope allowlist in 2 groups */}
              {(() => {
                const ALLOWED_IDS = [1, 3, 11, 7];
                const allScopes = company.active_scopes.filter(sc => ALLOWED_IDS.includes(sc.id));
                const residentialIds = [1, 3, 11];
                const commercialIds = [7];
                const residentialScopes = residentialIds.map(id => allScopes.find(sc => sc.id === id)).filter(Boolean) as typeof allScopes;
                const commercialScopes = commercialIds.map(id => allScopes.find(sc => sc.id === id)).filter(Boolean) as typeof allScopes;
                const groups: [string, typeof allScopes][] = [];
                if (residentialScopes.length > 0) groups.push(["Residential", residentialScopes]);
                if (commercialScopes.length > 0) groups.push(["Commercial", commercialScopes]);
                return groups.map(([group, groupScopes]) => (
                  <div key={group} style={{ marginBottom: 20 }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>{group}</p>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {groupScopes.map(sc => (
                        <div key={sc.id} style={s.scopeCard(scopeId === sc.id)} onClick={() => setScopeId(sc.id)}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${scopeId === sc.id ? brand : "#C4C1BA"}`, background: scopeId === sc.id ? brand : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              {scopeId === sc.id && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />}
                            </div>
                            <span style={{ fontWeight: 600, fontSize: 14, color: "#1A1917" }}>{sc.name}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ));
              })()}

              {/* ── Last-Cleaned Question (Recurring only) ──────────────────── */}
              {scopeId === 11 && !isCommercial && (() => {
                const LAST_CLEANED_OPTS = [
                  { value: "within_2_weeks", label: "Within the last 2 weeks" },
                  { value: "2_4_weeks",      label: "2–4 weeks ago" },
                  { value: "1_3_months",     label: "1–3 months ago" },
                  { value: "over_3_months",  label: "Over 3 months ago — or never" },
                ];
                const isOverdue = ["1_3_months", "over_3_months"].includes(lastCleanedResponse);
                const showDCRec = isOverdue && !lastCleanedOverride;
                return (
                  <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 24, marginTop: 8, marginBottom: 0 }}>
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

                    {showDCRec && (
                      <div style={{
                        marginTop: 16,
                        background: "#fff",
                        border: "1px solid #E5E2DC",
                        borderLeft: `3px solid ${brand}`,
                        borderRadius: 10,
                        padding: 16,
                      }}>
                        <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 14, color: "#1A1917" }}>
                          We recommend starting with a Deep Clean
                        </p>
                        <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6B6860", lineHeight: 1.55 }}>
                          When a home hasn't been professionally cleaned in over 30 days, a Deep Clean ensures the best results — and sets the foundation for a great recurring service. Most customers who start with a Deep Clean stay recurring long-term.
                        </p>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <button
                            onClick={() => { setScopeId(1); setLastCleanedResponse(""); setLastCleanedOverride(false); }}
                            style={{ padding: "10px 18px", background: brand, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
                          >
                            Book a Deep Clean Instead
                          </button>
                          <button
                            onClick={() => setLastCleanedOverride(true)}
                            style={{ padding: "10px 18px", background: "#fff", color: brand, border: `1.5px solid ${brand}`, borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
                          >
                            Continue with Recurring Anyway
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {scopeId && !isCommercial && (
                <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 24, marginTop: scopeId === 11 ? 16 : 8 }}>
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
                      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6B6860", marginBottom: 4 }}>
                        How would you rate the current cleanliness of your home?
                      </label>
                      <p style={{ margin: "0 0 10px", fontSize: 11, color: "#9E9B94" }}>1 — Very Clean · 2 — Moderately Clean · 3 — Very Dirty</p>
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
                      {cleanliness === 3 && (
                        <p style={{ margin: "6px 0 0", fontSize: 11, color: "#F59E0B" }}>An 8% condition adjustment will be added to your estimate.</p>
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

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
                <button style={s.btn(false)} onClick={() => setStep(0)}>Back</button>
                <button
                  style={{ ...s.btn(), opacity: (isCommercial ? !commercialOption : (!scopeId || !sqft || (scopeId === 11 && (!lastCleanedResponse || (["1_3_months", "over_3_months"].includes(lastCleanedResponse) && !lastCleanedOverride))))) ? 0.5 : 1 }}
                  disabled={isCommercial ? !commercialOption : (!scopeId || !sqft || (scopeId === 11 && (!lastCleanedResponse || (["1_3_months", "over_3_months"].includes(lastCleanedResponse) && !lastCleanedOverride))))}
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
              <p style={s.h2}>How often and what extras?</p>
              <p style={s.sub}>Choose your cleaning frequency and any add-ons.</p>

              {frequencies.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <span style={s.label}>Frequency</span>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {frequencies.map(f => (
                      <button key={f.id} style={s.freqCard(frequencyStr === f.frequency)} onClick={() => setFrequencyStr(f.frequency)}>
                        <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: "#1A1917" }}>{f.label || f.frequency}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {visibleAddons.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  {addonPersuasionLine && (
                    <p style={{ fontSize: 12, color: "#6B6860", marginBottom: 10, fontStyle: "italic", lineHeight: 1.5 }}>
                      {addonPersuasionLine}
                    </p>
                  )}
                  <span style={s.label}>Add-ons (optional)</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {visibleAddons.map(a => {
                      const sel = selectedAddonIds.includes(a.id);
                      const isBundleAddon = bundleAddonIds.has(a.id);
                      const fromResult = calcResult?.addon_breakdown.find(b => b.id === a.id);
                      const pv = parseFloat(String((a as any).price_value ?? a.price ?? 0));
                      const isPct = a.price_type === "percentage" || a.price_type === "percent";
                      const bundleDiscount = (activeBundle && isBundleAddon && !isDynamicPricedAddon(a.id))
                        ? parseFloat(activeBundle.discount_value)
                        : 0;
                      let displayPrice = fromResult
                        ? (fromResult.amount < 0 ? `-$${Math.abs(fromResult.amount).toFixed(2)}` : `+$${fromResult.amount.toFixed(2)}`)
                        : a.price_type === "time_only"
                        ? "No additional charge"
                        : a.price_type === "flat" && pv !== 0
                        ? (pv < 0 ? `-$${Math.abs(pv).toFixed(2)}` : `+$${pv.toFixed(2)}`)
                        : isPct
                        ? (pv < 0 ? `${Math.abs(pv).toFixed(0)}% off — calculated on estimate` : `${pv.toFixed(0)}% of estimate — price varies by home size`)
                        : "";
                      if (bundleDiscount > 0 && a.price_type === "flat" && pv > 0) {
                        const discounted = pv - bundleDiscount;
                        displayPrice = (
                          <span>
                            <span style={{ textDecoration: "line-through", color: "#9E9B94", marginRight: 4 }}>+${pv.toFixed(2)}</span>
                            <span style={{ color: "#2D6A4F", fontWeight: 600 }}>+${discounted.toFixed(2)}</span>
                          </span>
                        ) as any;
                      }
                      return (
                        <div key={a.id} style={{ position: "relative" }}>
                          <div style={s.addonCard(sel)} onClick={() => setSelectedAddonIds(prev => sel ? prev.filter(x => x !== a.id) : [...prev, a.id])}>
                            <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${sel ? brand : "#C4C1BA"}`, background: sel ? brand : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>
                              {sel && <CheckCircle2 size={13} color="#fff" />}
                            </div>
                            <div style={{ flex: 1 }}>
                              <p style={{ margin: 0, fontWeight: 600, fontSize: 14, color: "#1A1917" }}>{a.name}</p>
                              <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9E9B94" }}>{displayPrice}</p>
                            </div>
                            {isBundleAddon && (
                              <span style={{ fontSize: 10, fontWeight: 700, background: brand, color: "#fff", padding: "2px 7px", borderRadius: 20, flexShrink: 0, alignSelf: "center" }}>
                                Most Popular
                              </span>
                            )}
                          </div>
                          {partialBundleNudge && partialBundleNudge.missingName === a.name && !sel && (
                            <p style={{ fontSize: 11, color: "#92400E", margin: "4px 0 0", paddingLeft: 4 }}>
                              Add this to unlock the {partialBundleNudge.bundleName} discount
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {activeBundle && bundleSavings > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, padding: "8px 12px", background: "#D1FAE5", borderRadius: 8 }}>
                      <Tag size={13} color="#2D6A4F" />
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#2D6A4F" }}>
                        {activeBundle.name} applied — you're saving ${bundleSavings.toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <FieldWrap label="Discount Code">
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    style={{ ...s.input, flex: 1 }}
                    value={discountInput}
                    onChange={e => { setDiscountInput(e.target.value.toUpperCase()); setDiscountError(""); }}
                    placeholder="e.g. WELCOME10"
                  />
                  <button
                    style={{ ...s.btn(), padding: "10px 20px", opacity: !discountInput.trim() ? 0.5 : 1, flexShrink: 0 }}
                    disabled={!discountInput.trim()}
                    onClick={() => runCalc({ code: discountInput.trim() })}
                  >
                    Apply
                  </button>
                </div>
                {discountError && <div style={s.err}><AlertCircle size={12} />{discountError}</div>}
                {discountCode && calcResult && calcResult.discount_amount > 0 && (
                  <div style={{ ...s.err, color: "#10B981" }}><CheckCircle2 size={12} />Code applied: -{`$${calcResult.discount_amount.toFixed(2)}`}</div>
                )}
              </FieldWrap>

              <FieldWrap label="Service Address">
                <input style={s.input} value={address} onChange={e => setAddressField(e.target.value)} placeholder="3165 W 84th Place, Chicago, IL" />
              </FieldWrap>

              <p style={{ fontSize: 11, color: "#9E9B94", marginBottom: 16, marginTop: -4, lineHeight: 1.5 }}>
                Add extras now — requesting them later may require a separate visit.
              </p>

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                <button style={s.btn(false)} onClick={() => setStep(1)}>Back</button>
                <button style={{ ...s.btn(), opacity: !frequencyStr ? 0.5 : 1 }} disabled={!frequencyStr} onClick={() => setStep(3)}>
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

              <SimpleCalendar selected={selectedDate} onSelect={setSelectedDate} brand={brand} leadHours={company.online_booking_lead_hours ?? 48} />

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

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
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

              <div style={{ display: "flex", justifyContent: "space-between" }}>
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
