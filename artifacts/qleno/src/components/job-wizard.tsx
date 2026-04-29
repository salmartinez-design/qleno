import { useState, useEffect, useRef } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { formatAddress } from "@/lib/format-address";
import { useBranch } from "@/contexts/branch-context";
import { X, ChevronRight, ChevronLeft, Search, Check, Clock, User, Calendar, Sparkles, Zap, ArrowRightCircle, Home, RefreshCw, Wrench, Building2, LayoutGrid, MapPin, AlertTriangle, DollarSign } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface SuggestedTech {
  employee_id: number;
  name: string;
  avatar_url: string | null;
  tier: number;
  reason: string;
  zone_color: string | null;
  zone_name: string | null;
  last_job_end_time: string | null;
}

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const SERVICE_TYPES: { value: string; label: string; price: number; icon: LucideIcon; duration: number }[] = [
  { value: "standard_clean",    label: "Standard Clean",    price: 120, icon: Sparkles,         duration: 120 },
  { value: "deep_clean",        label: "Deep Clean",        price: 220, icon: Zap,              duration: 180 },
  { value: "move_out",          label: "Move Out",          price: 300, icon: ArrowRightCircle, duration: 240 },
  { value: "move_in",           label: "Move In",           price: 280, icon: Home,             duration: 240 },
  { value: "recurring",         label: "Recurring",         price: 95,  icon: RefreshCw,        duration: 90  },
  { value: "post_construction", label: "Post-Construction", price: 450, icon: Wrench,           duration: 300 },
  { value: "office_cleaning",   label: "Office Cleaning",   price: 200, icon: Building2,        duration: 150 },
  { value: "common_areas",      label: "Common Areas",      price: 150, icon: LayoutGrid,       duration: 120 },
];

const TIME_OPTIONS = [
  "07:00","08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00",
];

const DURATION_OPTIONS = [60, 90, 120, 150, 180, 210, 240, 300, 360];

const FREQ_OPTIONS = [
  { value: "on_demand", label: "One Time" },
  { value: "weekly",    label: "Weekly" },
  { value: "biweekly",  label: "Bi-Weekly" },
  { value: "monthly",   label: "Monthly" },
];

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled", in_progress: "In Progress", complete: "Complete", cancelled: "Cancelled",
};

const COMMERCIAL_SERVICE_TYPES = [
  "standard_clean", "deep_clean", "office_cleaning", "common_areas", "carpet_cleaning",
  "window_cleaning", "move_out", "post_construction",
];

function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatDate(d: string) {
  return new Date(d + "T00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function fmtSvcLabel(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

interface JobWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /**
   * Optional preselected client. When provided, the wizard skips the
   * "Type" and "Client" steps and jumps directly to the Details step.
   * Used when opening the wizard from a client profile page — context
   * is already known, no need to re-search.
   */
  preselectedClient?: {
    id: number;
    first_name?: string | null;
    last_name?: string | null;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    client_type?: string | null;
    payment_method?: string | null;
    net_terms?: number | null;
    qb_status?: {
      connected: boolean;
      synced: boolean;
      synced_at?: string | null;
      qb_customer_id?: string | null;
    } | null;
  } | null;
  /**
   * [scheduling-engine 2026-04-29] Optional preset date in
   * "YYYY-MM-DD". Used when the wizard is opened from the client
   * profile MiniCalendar — the operator picked a specific empty
   * future day, so the wizard skips the today-default and lands on
   * that day instead. Editable by the operator afterwards.
   */
  presetDate?: string | null;
}

export function JobWizard({ open, onClose, onCreated, preselectedClient, presetDate }: JobWizardProps) {
  const { activeBranchId, branches } = useBranch();
  const [selectedBranchOverride, setSelectedBranchOverride] = useState<string | number>("all");
  const [step, setStep] = useState(0);

  // Step 0 — Type
  const [clientType, setClientType] = useState<"residential" | "commercial">("residential");

  // Step 1 — Residential Client
  const [clientQuery, setClientQuery] = useState("");
  const [clientResults, setClientResults] = useState<any[]>([]);
  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [clientRecentJobs, setClientRecentJobs] = useState<any[]>([]);
  const clientDebounce = useRef<ReturnType<typeof setTimeout>>();

  // Step 1 — New Customer Inline Form
  const [showNewCust, setShowNewCust] = useState(false);
  const [newCustFirst, setNewCustFirst] = useState("");
  const [newCustLast, setNewCustLast] = useState("");
  const [newCustPhone, setNewCustPhone] = useState("");
  const [newCustEmail, setNewCustEmail] = useState("");
  const [newCustAddress, setNewCustAddress] = useState("");
  const [newCustSaving, setNewCustSaving] = useState(false);
  const [newCustError, setNewCustError] = useState("");

  // Step 1 — Commercial Account
  const [accountQuery, setAccountQuery] = useState("");
  const [accountResults, setAccountResults] = useState<any[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<any>(null);
  const accountDebounce = useRef<ReturnType<typeof setTimeout>>();

  // Step 1B — Commercial Property
  const [propertyQuery, setPropertyQuery] = useState("");
  const [properties, setProperties] = useState<any[]>([]);
  const [selectedProperty, setSelectedProperty] = useState<any>(null);

  // Step 2 — Residential Details
  const [serviceType, setServiceType] = useState("standard_clean");
  // [scheduling-engine 2026-04-29] Honor presetDate when supplied —
  // initial state only (operator can still change it). Cleared on
  // wizard close via the existing reset block at line ~191.
  const [scheduledDate, setScheduledDate] = useState(presetDate || todayStr());
  const [scheduledTime, setScheduledTime] = useState("09:00");
  const [duration, setDuration] = useState(120);
  const [price, setPrice] = useState(120);
  const [priceOverridden, setPriceOverridden] = useState(false);
  const [frequency, setFrequency] = useState("on_demand");
  const [notes, setNotes] = useState("");

  // Step 2 — Quote
  const [showQuote, setShowQuote] = useState(false);
  const [quoteSending, setQuoteSending] = useState(false);
  const [quoteSent, setQuoteSent] = useState(false);
  const [quoteError, setQuoteError] = useState("");

  // Step 2 — Commercial Service + Rate
  const [commercialServiceType, setCommercialServiceType] = useState("standard_clean");
  const [rateLookup, setRateLookup] = useState<any>(null);
  const [rateLookupLoading, setRateLookupLoading] = useState(false);
  const [rateLookupDone, setRateLookupDone] = useState(false);
  const [rateOverride, setRateOverride] = useState(false);
  const [overrideRate, setOverrideRate] = useState("");
  const [estimatedHours, setEstimatedHours] = useState("");
  const [manualBillingMethod, setManualBillingMethod] = useState("hourly");
  const [manualRate, setManualRate] = useState("");
  const [commercialScheduledDate, setCommercialScheduledDate] = useState(todayStr());
  const [commercialScheduledTime, setCommercialScheduledTime] = useState("09:00");
  const [commercialDuration, setCommercialDuration] = useState(120);
  const [commercialFrequency, setCommercialFrequency] = useState("on_demand");
  const [commercialNotes, setCommercialNotes] = useState("");

  // Step 3 — Assign
  const [employees, setEmployees] = useState<any[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Smart suggestions
  const [suggestions, setSuggestions] = useState<SuggestedTech[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);

  const maxStep = clientType === "commercial" ? 4 : 3;

  // [scheduling-engine 2026-04-29] When the wizard opens with a
  // presetDate (from MiniCalendar empty-date click), seed the date
  // picker with it. Without this, the useState default only fires
  // on first mount; subsequent opens with different presetDate
  // values would still show today's date.
  useEffect(() => {
    if (open && presetDate) setScheduledDate(presetDate);
  }, [open, presetDate]);

  useEffect(() => {
    if (!open) {
      setStep(0);
      setClientType("residential");
      setClientQuery(""); setClientResults([]); setSelectedClient(null); setClientRecentJobs([]);
      setShowNewCust(false); setNewCustFirst(""); setNewCustLast(""); setNewCustPhone(""); setNewCustEmail(""); setNewCustAddress(""); setNewCustSaving(false); setNewCustError("");
      setAccountQuery(""); setAccountResults([]); setSelectedAccount(null);
      setPropertyQuery(""); setProperties([]); setSelectedProperty(null);
      setServiceType("standard_clean"); setScheduledDate(todayStr()); setScheduledTime("09:00");
      setDuration(120); setPrice(120); setPriceOverridden(false); setFrequency("on_demand"); setNotes("");
      setShowQuote(false); setQuoteSending(false); setQuoteSent(false); setQuoteError("");
      setCommercialServiceType("standard_clean"); setRateLookup(null); setRateLookupLoading(false);
      setRateLookupDone(false); setRateOverride(false); setOverrideRate(""); setEstimatedHours("");
      setManualBillingMethod("hourly"); setManualRate("");
      setCommercialScheduledDate(todayStr()); setCommercialScheduledTime("09:00");
      setCommercialDuration(120); setCommercialFrequency("on_demand"); setCommercialNotes("");
      setSelectedEmployee(null); setSubmitting(false); setError("");
      setSuggestions([]); setSuggestionsLoading(false); setSuggestionsDismissed(false);
    } else {
      setSelectedBranchOverride(activeBranchId);
      // If opened from a client profile, skip type + client-search +
      // (for commercial-tagged clients) the account/property picker.
      //
      // [scheduling-engine 2026-04-29] The previous routing tried to
      // synthesize a fake account when preselectedClient.client_type
      // === "commercial" and landed the wizard on the property
      // picker. Clients tagged commercial without an actual
      // account_id linkage (Jaira-style: the dispatch route bills
      // her commercially via client_type, but there's no
      // accounts/account_properties row to pick from) hit a dead
      // end — the property search returned nothing.
      //
      // Fix: from a client profile we already know the client and
      // their address. Always set selectedClient + skip to step 2.
      // The wizard's downstream commercial billing math reads off
      // the client's record (client_type / hourly rate config /
      // pay matrix), not off the wizard's clientType toggle, so
      // billing stays correct. The "pick an account, then a
      // property" flow remains available via the "+ New Job"
      // entry point that starts without preselection.
      if (preselectedClient) {
        setClientType("residential"); // wizard UI mode only — billing reads from client record
        setSelectedClient({
          id: preselectedClient.id,
          first_name: preselectedClient.first_name || "",
          last_name: preselectedClient.last_name || "",
          address: preselectedClient.address || "",
          phone: preselectedClient.phone || "",
          email: preselectedClient.email || "",
        });
        setStep(2); // jump straight to Details — client + address known
      }
    }
  }, [open, preselectedClient?.id]);

  // Residential client search
  useEffect(() => {
    clearTimeout(clientDebounce.current);
    if (clientType !== "residential" || clientQuery.length < 2) { setClientResults([]); return; }
    clientDebounce.current = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/api/clients?search=${encodeURIComponent(clientQuery)}&limit=6`, { headers: getAuthHeaders() });
        if (r.ok) { const d = await r.json(); setClientResults(d.data || d || []); }
      } catch {}
    }, 250);
  }, [clientQuery, clientType]);

  // Commercial account search
  useEffect(() => {
    clearTimeout(accountDebounce.current);
    if (clientType !== "commercial") { setAccountResults([]); return; }
    accountDebounce.current = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/api/accounts?active=true&limit=20`, { headers: getAuthHeaders() });
        if (r.ok) {
          const d = await r.json();
          const all = d.data || d || [];
          const q = accountQuery.trim().toLowerCase();
          setAccountResults(q ? all.filter((a: any) => a.account_name?.toLowerCase().includes(q)) : all);
        }
      } catch {}
    }, 200);
  }, [accountQuery, clientType]);

  // Load properties when account selected
  useEffect(() => {
    if (!selectedAccount) { setProperties([]); setSelectedProperty(null); return; }
    fetch(`${API}/api/accounts/${selectedAccount.id}/properties`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : { data: [] })
      .then(d => setProperties(d.data || d || []))
      .catch(() => {});
  }, [selectedAccount]);

  // Load recent jobs when residential client selected
  useEffect(() => {
    if (!selectedClient) { setClientRecentJobs([]); return; }
    fetch(`${API}/api/jobs?client_id=${selectedClient.id}&limit=3&sort=desc`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => setClientRecentJobs(d?.data?.slice(0, 3) || []))
      .catch(() => {});
  }, [selectedClient]);

  // Re-book: pre-fill Step 2 details from a past job
  function rebookFromPastJob(pastJob: any) {
    if (pastJob.service_type) setServiceType(pastJob.service_type);
    const mins = pastJob.duration_minutes
      ?? (pastJob.allowed_hours ? Math.round(parseFloat(pastJob.allowed_hours) * 60) : null);
    if (mins && mins > 0) setDuration(mins);
    if (pastJob.base_fee != null) {
      const n = parseFloat(String(pastJob.base_fee));
      if (!isNaN(n) && n > 0) { setPrice(n); setPriceOverridden(true); }
    }
    if (pastJob.frequency) setFrequency(pastJob.frequency);
  }

  // Inline payment_method edit — persists via PUT /api/clients/:id
  const [pmEditing, setPmEditing] = useState(false);
  const [pmSaving, setPmSaving] = useState(false);
  const [pmValue, setPmValue] = useState<string>(preselectedClient?.payment_method || "manual");
  useEffect(() => {
    if (preselectedClient?.payment_method !== undefined) setPmValue(preselectedClient.payment_method || "manual");
  }, [preselectedClient?.id, preselectedClient?.payment_method]);

  async function savePaymentMethod(newMethod: string) {
    if (!preselectedClient?.id) return;
    setPmSaving(true);
    try {
      await fetch(`${API}/api/clients/${preselectedClient.id}`, {
        method: "PUT",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ payment_method: newMethod, net_terms: newMethod === "net_30" ? 30 : 0 }),
      });
      setPmValue(newMethod);
    } catch {} finally { setPmSaving(false); setPmEditing(false); }
  }

  // Rate lookup for commercial
  useEffect(() => {
    if (!selectedAccount || !commercialServiceType || clientType !== "commercial") return;
    setRateLookup(null); setRateLookupDone(false); setRateLookupLoading(true);
    fetch(`${API}/api/accounts/${selectedAccount.id}/rates/lookup?service_type=${encodeURIComponent(commercialServiceType)}`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { setRateLookup(d?.rate || null); setRateLookupDone(true); })
      .catch(() => { setRateLookupDone(true); })
      .finally(() => setRateLookupLoading(false));
  }, [selectedAccount, commercialServiceType, clientType]);

  // Load employees when entering step 3
  useEffect(() => {
    if (step !== 3) return;
    fetch(`${API}/api/users?is_active=true&limit=50`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const all = d?.data || d || [];
        setEmployees(all.filter((e: any) => e.role === "cleaner" || e.role === "employee" || e.role === "lead" || e.role === "admin"));
      })
      .catch(() => {});
  }, [step]);

  // Smart suggestions
  const suggestZip = clientType === "commercial" ? selectedProperty?.zip : selectedClient?.zip;
  const suggestDate = clientType === "commercial" ? commercialScheduledDate : scheduledDate;
  const suggestTime = clientType === "commercial" ? commercialScheduledTime : scheduledTime;
  const suggestDuration = clientType === "commercial" ? commercialDuration : duration;

  useEffect(() => {
    if (step !== 3) return;
    if (!suggestDate || !suggestTime || !suggestDuration || !suggestZip) return;
    const [h, m] = suggestTime.split(":").map(Number);
    const endTotalMins = h * 60 + (m || 0) + suggestDuration;
    const endH = Math.floor(endTotalMins / 60) % 24;
    const endM = endTotalMins % 60;
    const endTime = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
    setSuggestionsLoading(true);
    setSuggestions([]);
    fetch(`${API}/api/jobs/suggest-tech`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ date: suggestDate, start_time: suggestTime, end_time: endTime, zip_code: suggestZip }),
    })
      .then(r => r.ok ? r.json() : [])
      .then(d => setSuggestions(Array.isArray(d) ? d : []))
      .catch(() => setSuggestions([]))
      .finally(() => setSuggestionsLoading(false));
  }, [step, suggestDate, suggestTime, suggestDuration, suggestZip]);

  // Auto-price on service type change (residential only)
  useEffect(() => {
    if (clientType !== "residential" || priceOverridden) return;
    const svc = SERVICE_TYPES.find(s => s.value === serviceType);
    if (svc) { setPrice(svc.price); setDuration(svc.duration); }
  }, [serviceType, priceOverridden, clientType]);

  async function submit() {
    setSubmitting(true); setError("");
    try {
      let body: any;
      if (clientType === "commercial") {
        const billingMethod = rateLookup ? rateLookup.billing_method : manualBillingMethod;
        const effectiveRate = rateOverride ? overrideRate : (rateLookup?.rate_amount || manualRate);
        const baseFee = billingMethod === "flat_rate"
          ? (parseFloat(effectiveRate) || 0)
          : (parseFloat(effectiveRate) || 0) * (parseFloat(estimatedHours) || 1);
        body = {
          account_id: selectedAccount?.id,
          account_property_id: selectedProperty?.id,
          service_type: commercialServiceType,
          scheduled_date: commercialScheduledDate,
          scheduled_time: commercialScheduledTime + ":00",
          duration_minutes: commercialDuration,
          base_fee: baseFee || undefined,
          frequency: commercialFrequency,
          notes: commercialNotes || undefined,
          assigned_user_id: selectedEmployee || undefined,
          status: "scheduled",
          billing_method: billingMethod,
          hourly_rate: billingMethod === "hourly" ? effectiveRate : undefined,
          estimated_hours: estimatedHours || undefined,
          branch_id: selectedBranchOverride !== "all" ? selectedBranchOverride : undefined,
        };
      } else {
        if (!selectedClient) return;
        body = {
          client_id: selectedClient.id,
          service_type: serviceType,
          scheduled_date: scheduledDate,
          scheduled_time: scheduledTime + ":00",
          duration_minutes: duration,
          base_fee: price,
          frequency,
          notes: notes || undefined,
          assigned_user_id: selectedEmployee || undefined,
          status: "scheduled",
          branch_id: selectedBranchOverride !== "all" ? selectedBranchOverride : undefined,
        };
      }
      const r = await fetch(`${API}/api/jobs`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error || "Failed"); }
      onCreated();
      onClose();
    } catch (e: any) {
      setError(e.message || "Failed to create job");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const svcConfig = SERVICE_TYPES.find(s => s.value === serviceType)!;
  const effectiveBillingMethod = rateOverride ? manualBillingMethod : (rateLookup?.billing_method || manualBillingMethod);
  const effectiveRate = rateOverride ? overrideRate : (rateLookup?.rate_amount || manualRate);

  const OVERLAY: React.CSSProperties = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9998,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "'Plus Jakarta Sans', sans-serif",
  };
  const MODAL: React.CSSProperties = {
    background: "#FFFFFF", borderRadius: 16, width: "min(600px, 96vw)",
    maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 80px rgba(0,0,0,0.18)",
    position: "relative",
  };

  const resSteps = ["Client", "Details", "Assign"];
  const comSteps = ["Account", "Service", "Assign", "Confirm"];
  const stepLabels = clientType === "commercial" ? comSteps : resSteps;

  const STEP_LABEL = (n: number, label: string, activeStep: number) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        width: 28, height: 28, borderRadius: 14,
        background: activeStep >= n ? "var(--brand, #00C9A0)" : "#F3F4F6",
        color: activeStep >= n ? "#fff" : "#9E9B94",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, fontWeight: 700, flexShrink: 0,
      }}>{activeStep > n ? <Check size={13}/> : n}</div>
      <span style={{ fontSize: 12, fontWeight: activeStep === n ? 700 : 400, color: activeStep === n ? "#1A1917" : "#9E9B94" }}>{label}</span>
    </div>
  );

  const displayStep = step; // 0 = type, 1..4 = wizard steps

  function canGoNext() {
    if (step === 0) return true;
    if (step === 1 && clientType === "residential") return !!selectedClient;
    if (step === 1 && clientType === "commercial") return !!selectedAccount && !!selectedProperty;
    if (step === 2 && clientType === "commercial") return !!commercialServiceType && (rateLookupDone || !selectedAccount);
    return true;
  }

  return (
    <div style={OVERLAY} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={MODAL}>
        {/* Header */}
        <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid #F3F4F6" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <p style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", margin: "0 0 12px" }}>Create New Job</p>
              {step > 0 && (
                <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                  {stepLabels.map((label, idx) => (
                    <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {STEP_LABEL(idx + 1, label, step)}
                      {idx < stepLabels.length - 1 && <div style={{ width: 20, height: 1, background: "#E5E2DC" }}/>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={20}/></button>
          </div>
        </div>

        <div style={{ padding: "20px 24px" }}>

          {/* ── STEP 0: CLIENT TYPE ── */}
          {step === 0 && (
            <div>
              <p style={{ fontSize: 13, color: "#6B7280", margin: "0 0 16px" }}>Who is this job for?</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[
                  { value: "residential", icon: Home, label: "Residential Client", sublabel: "Individual home, flat-rate billing" },
                  { value: "commercial", icon: Building2, label: "Commercial Account", sublabel: "Property management, hourly billing" },
                ].map(opt => {
                  const Icon = opt.icon;
                  const sel = clientType === opt.value;
                  return (
                    <button key={opt.value} onClick={() => setClientType(opt.value as any)}
                      style={{
                        padding: "20px 16px", border: `2px solid ${sel ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                        borderRadius: 12, background: sel ? "color-mix(in srgb, var(--brand) 8%, #fff)" : "#fff",
                        cursor: "pointer", textAlign: "left", fontFamily: "inherit", transition: "all 0.15s",
                      }}>
                      <div style={{ marginBottom: 10 }}>
                        <Icon size={24} color={sel ? "var(--brand, #00C9A0)" : "#6B7280"}/>
                      </div>
                      <p style={{ fontSize: 14, fontWeight: 700, color: sel ? "var(--brand, #00C9A0)" : "#1A1917", margin: "0 0 4px" }}>{opt.label}</p>
                      <p style={{ fontSize: 12, color: "#9E9B94", margin: 0, lineHeight: 1.4 }}>{opt.sublabel}</p>
                      {sel && (
                        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 4 }}>
                          <Check size={13} color="var(--brand, #00C9A0)"/>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--brand, #00C9A0)" }}>Selected</span>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── STEP 1: CLIENT (Residential) ── */}
          {step === 1 && clientType === "residential" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ position: "relative" }}>
                <Search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#9E9B94" }}/>
                <input
                  autoFocus
                  value={clientQuery}
                  onChange={e => setClientQuery(e.target.value)}
                  placeholder="Search client by name, email, or phone…"
                  style={{ width: "100%", padding: "10px 12px 10px 34px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                />
              </div>

              {clientResults.length > 0 && !selectedClient && (
                <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
                  {clientResults.map((c, i) => (
                    <button key={c.id} onClick={() => { setSelectedClient(c); setClientQuery(`${c.first_name} ${c.last_name}`); setClientResults([]); }}
                      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "11px 14px", background: "#fff", border: "none", borderBottom: i < clientResults.length - 1 ? "1px solid #F3F4F6" : "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                      <div style={{ width: 34, height: 34, borderRadius: 17, background: "var(--brand-dim, #EBF4FF)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "var(--brand, #00C9A0)", flexShrink: 0 }}>
                        {c.first_name?.[0]}{c.last_name?.[0]}
                      </div>
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", margin: "0 0 2px" }}>{c.first_name} {c.last_name}</p>
                        <p style={{ fontSize: 11, color: "#9E9B94", margin: 0 }}>{c.email} · {c.city || c.address || ""}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {selectedClient && (
                <div style={{ background: "var(--brand-dim, #EBF4FF)", border: "1px solid color-mix(in srgb, var(--brand) 30%, transparent)", borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 18, background: "var(--brand, #00C9A0)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                    {selectedClient.first_name?.[0]}{selectedClient.last_name?.[0]}
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", margin: "0 0 2px" }}>{selectedClient.first_name} {selectedClient.last_name}</p>
                    <p style={{ fontSize: 12, color: "#6B7280", margin: 0 }}>{selectedClient.email}{selectedClient.address ? ` · ${selectedClient.address}` : ""}</p>
                  </div>
                  <button onClick={() => { setSelectedClient(null); setClientQuery(""); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={14}/></button>
                </div>
              )}

              {!selectedClient && !showNewCust && (
                <button
                  type="button"
                  onClick={() => { setShowNewCust(true); setClientQuery(""); setClientResults([]); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "11px 14px", background: "#F7F6F3", border: "1px dashed #D1D5DB", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--brand, #00C9A0)", fontFamily: "inherit", touchAction: "manipulation" }}>
                  <span style={{ fontSize: 18, lineHeight: 1 }}>+</span> Add New Customer
                </button>
              )}

              {showNewCust && (
                <div style={{ border: "1px solid #E5E2DC", borderRadius: 12, padding: 16, backgroundColor: "#F7F6F3" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", margin: 0 }}>New Customer</p>
                    <button type="button" onClick={() => { setShowNewCust(false); setNewCustError(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 2 }}><X size={14}/></button>
                  </div>
                  {newCustError && <p style={{ fontSize: 12, color: "#DC2626", margin: "0 0 10px", padding: "8px 12px", background: "#FEE2E2", borderRadius: 6 }}>{newCustError}</p>}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>First Name *</label>
                      <input value={newCustFirst} onChange={e => setNewCustFirst(e.target.value)} placeholder="First"
                        style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Last Name *</label>
                      <input value={newCustLast} onChange={e => setNewCustLast(e.target.value)} placeholder="Last"
                        style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                    </div>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Phone *</label>
                    <input value={newCustPhone} onChange={e => setNewCustPhone(e.target.value)} placeholder="(555) 555-5555" type="tel"
                      style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Email</label>
                    <input value={newCustEmail} onChange={e => setNewCustEmail(e.target.value)} placeholder="email@example.com" type="email"
                      style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Address</label>
                    <input value={newCustAddress} onChange={e => setNewCustAddress(e.target.value)} placeholder="123 Main St, City, FL"
                      style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => { setShowNewCust(false); setNewCustError(""); }}
                      style={{ flex: 1, padding: "10px 14px", border: "1px solid #E5E2DC", borderRadius: 8, background: "#FFFFFF", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: "#6B7280" }}>
                      Cancel
                    </button>
                    <button type="button" disabled={newCustSaving}
                      onClick={async () => {
                        if (!newCustFirst.trim() || !newCustLast.trim() || !newCustPhone.trim()) {
                          setNewCustError("First name, last name, and phone are required."); return;
                        }
                        setNewCustSaving(true); setNewCustError("");
                        try {
                          const r = await fetch(`${API}/api/clients`, {
                            method: "POST", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                            body: JSON.stringify({ first_name: newCustFirst.trim(), last_name: newCustLast.trim(), phone: newCustPhone.trim(), email: newCustEmail.trim() || undefined, address: newCustAddress.trim() || undefined }),
                          });
                          if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any).message || "Failed to create customer"); }
                          const created = await r.json();
                          setSelectedClient(created);
                          setClientQuery(`${created.first_name} ${created.last_name}`);
                          setShowNewCust(false);
                          setNewCustFirst(""); setNewCustLast(""); setNewCustPhone(""); setNewCustEmail(""); setNewCustAddress("");
                        } catch (e: any) {
                          setNewCustError(e.message || "Something went wrong");
                        } finally { setNewCustSaving(false); }
                      }}
                      style={{ flex: 2, padding: "10px 14px", border: "none", borderRadius: 8, background: "var(--brand, #00C9A0)", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: newCustSaving ? 0.7 : 1 }}>
                      {newCustSaving ? "Saving..." : "Save Customer"}
                    </button>
                  </div>
                </div>
              )}

              {selectedClient && clientRecentJobs.length > 0 && (
                <div>
                  <p style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>Last 3 Jobs</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {clientRecentJobs.map((j: any) => (
                      <div key={j.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", background: "#F9F9F9", borderRadius: 8, border: "1px solid #E5E2DC" }}>
                        <span style={{ fontSize: 12, color: "#1A1917" }}>{j.service_type?.replace(/_/g, " ")}</span>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <span style={{ fontSize: 11, color: "#9E9B94" }}>{formatDate(j.scheduled_date)}</span>
                          <span style={{ fontSize: 11, fontWeight: 600, color: j.status === "complete" ? "#16A34A" : "#6B7280" }}>{STATUS_LABELS[j.status] || j.status}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── STEP 1: ACCOUNT + PROPERTY (Commercial) ── */}
          {step === 1 && clientType === "commercial" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Account</p>
                {!selectedAccount ? (
                  <>
                    <div style={{ position: "relative" }}>
                      <Search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#9E9B94" }}/>
                      <input
                        autoFocus
                        value={accountQuery}
                        onChange={e => setAccountQuery(e.target.value)}
                        placeholder="Search accounts…"
                        style={{ width: "100%", padding: "10px 12px 10px 34px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                      />
                    </div>
                    {accountResults.length > 0 && (
                      <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden", marginTop: 8 }}>
                        {accountResults.slice(0, 8).map((a: any, i: number) => (
                          <button key={a.id} onClick={() => { setSelectedAccount(a); setAccountQuery(""); }}
                            style={{ display: "flex", alignItems: "flex-start", gap: 10, width: "100%", padding: "12px 14px", background: "#fff", border: "none", borderBottom: i < Math.min(accountResults.length, 8) - 1 ? "1px solid #F3F4F6" : "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--brand-dim, #EBF4FF)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              <Building2 size={15} color="var(--brand, #00C9A0)"/>
                            </div>
                            <div>
                              <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", margin: "0 0 2px" }}>{a.account_name}</p>
                              <p style={{ fontSize: 11, color: "#9E9B94", margin: 0 }}>
                                {a.stats?.active_properties || 0} properties · {(a.payment_method || "").replace(/_/g, " ")}
                              </p>
                            </div>
                          </button>
                        ))}
                        <button onClick={() => window.open("/accounts", "_blank")}
                          style={{ display: "block", width: "100%", padding: "10px 14px", background: "#F9F9F7", border: "none", borderTop: "1px solid #F3F4F6", cursor: "pointer", textAlign: "left", fontFamily: "inherit", fontSize: 12, color: "var(--brand, #00C9A0)", fontWeight: 600 }}>
                          + Create new account
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ background: "var(--brand-dim, #EBF4FF)", border: "1px solid color-mix(in srgb, var(--brand) 30%, transparent)", borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--brand, #00C9A0)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Building2 size={16} color="#fff"/>
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", margin: "0 0 2px" }}>{selectedAccount.account_name}</p>
                      <p style={{ fontSize: 12, color: "#6B7280", margin: 0 }}>{(selectedAccount.payment_method || "").replace(/_/g, " ")}</p>
                    </div>
                    <button onClick={() => { setSelectedAccount(null); setSelectedProperty(null); setProperties([]); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={14}/></button>
                  </div>
                )}
              </div>

              {selectedAccount && (
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Property</p>
                  {!selectedProperty ? (
                    <>
                      <div style={{ position: "relative" }}>
                        <Search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#9E9B94" }}/>
                        <input
                          value={propertyQuery}
                          onChange={e => setPropertyQuery(e.target.value)}
                          placeholder="Search properties…"
                          style={{ width: "100%", padding: "10px 12px 10px 34px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                        />
                      </div>
                      {properties.length > 0 && (
                        <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden", marginTop: 8 }}>
                          {properties
                            .filter((p: any) => !propertyQuery || (p.property_name || p.address || "").toLowerCase().includes(propertyQuery.toLowerCase()))
                            .slice(0, 8)
                            .map((p: any, i: number, arr: any[]) => (
                              <button key={p.id} onClick={() => setSelectedProperty(p)}
                                style={{ display: "flex", alignItems: "flex-start", gap: 10, width: "100%", padding: "12px 14px", background: "#fff", border: "none", borderBottom: i < arr.length - 1 ? "1px solid #F3F4F6" : "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                                <MapPin size={14} style={{ color: "#9E9B94", marginTop: 2, flexShrink: 0 }}/>
                                <div>
                                  <p style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", margin: "0 0 2px" }}>{p.property_name || p.address}</p>
                                  <p style={{ fontSize: 11, color: "#9E9B94", margin: 0 }}>
                                    {formatAddress(p.address, p.city, p.state, (p as any).zip)}
                                    {p.property_type && <span style={{ marginLeft: 6, padding: "1px 6px", background: "#F3F4F6", borderRadius: 4, fontSize: 10, fontWeight: 600, color: "#6B7280" }}>{p.property_type.replace(/_/g, " ")}</span>}
                                  </p>
                                </div>
                              </button>
                            ))}
                          <button onClick={() => window.open(`/accounts/${selectedAccount.id}`, "_blank")}
                            style={{ display: "block", width: "100%", padding: "10px 14px", background: "#F9F9F7", border: "none", borderTop: "1px solid #F3F4F6", cursor: "pointer", textAlign: "left", fontFamily: "inherit", fontSize: 12, color: "var(--brand, #00C9A0)", fontWeight: 600 }}>
                            + Add property to this account
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div style={{ background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                        <MapPin size={15} style={{ color: "var(--brand, #00C9A0)", flexShrink: 0 }}/>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", margin: "0 0 2px" }}>{selectedProperty.property_name || selectedProperty.address}</p>
                          <p style={{ fontSize: 12, color: "#6B7280", margin: 0 }}>{formatAddress(selectedProperty.address, selectedProperty.city, (selectedProperty as any).state, (selectedProperty as any).zip)}</p>
                        </div>
                        <button onClick={() => setSelectedProperty(null)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={14}/></button>
                      </div>
                      {selectedProperty.access_notes && (
                        <div style={{ marginTop: 8, background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "flex-start", gap: 8 }}>
                          <AlertTriangle size={14} style={{ color: "#D97706", flexShrink: 0, marginTop: 1 }}/>
                          <p style={{ fontSize: 12, color: "#92400E", margin: 0 }}>Access: {selectedProperty.access_notes}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── STEP 2: DETAILS (Residential) ── */}
          {step === 2 && clientType === "residential" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {/* Context bar: QB status + payment method — shown when launched from client profile */}
              {preselectedClient && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "8px 12px", background: "#FAFAF8", border: "1px solid #E5E2DC", borderRadius: 10 }}>
                  {/* QuickBooks badge */}
                  {preselectedClient.qb_status?.connected && (
                    <span
                      title={preselectedClient.qb_status.synced
                        ? "Customer synced to QuickBooks. Invoice will sync when job is marked complete."
                        : "QuickBooks will sync this customer when the job is saved. Invoice syncs at completion."}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, fontFamily: "inherit", background: preselectedClient.qb_status.synced ? "#DCFCE7" : "#FEF3C7", color: preselectedClient.qb_status.synced ? "#15803D" : "#92400E" }}
                    >
                      <span>{preselectedClient.qb_status.synced ? "✓" : "○"}</span>
                      QuickBooks: {preselectedClient.qb_status.synced ? "customer synced" : "sync pending"}
                    </span>
                  )}
                  {/* Payment method pill + inline edit */}
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.04em" }}>Payment:</span>
                    {!pmEditing ? (
                      <button onClick={() => setPmEditing(true)}
                        style={{ padding: "3px 10px", border: "1px solid #E5E2DC", borderRadius: 20, background: "#FFFFFF", fontSize: 11, fontWeight: 600, color: "#1A1917", fontFamily: "inherit", cursor: "pointer" }}>
                        {({ card_on_file: "Card on file", check: "Check", zelle: "Zelle", net_30: "Net 30", manual: "Manual" } as Record<string, string>)[pmValue] || "Manual"} ▾
                      </button>
                    ) : (
                      <select value={pmValue} onChange={e => savePaymentMethod(e.target.value)} disabled={pmSaving}
                        style={{ padding: "3px 8px", border: "1px solid #E5E2DC", borderRadius: 20, background: "#FFFFFF", fontSize: 11, fontWeight: 600, color: "#1A1917", fontFamily: "inherit" }}
                        autoFocus onBlur={() => setPmEditing(false)}>
                        <option value="manual">Manual</option>
                        <option value="card_on_file">Card on file</option>
                        <option value="check">Check</option>
                        <option value="zelle">Zelle</option>
                        <option value="net_30">Net 30</option>
                      </select>
                    )}
                  </div>
                </div>
              )}

              {/* Last 3 Jobs — quick re-book (office-side parity) */}
              {preselectedClient && clientRecentJobs.length > 0 && (
                <div>
                  <p style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>Last 3 Jobs — click to re-book</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {clientRecentJobs.map((j: any) => (
                      <button key={j.id} onClick={() => rebookFromPastJob(j)} type="button"
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", background: "#F9F9F9", borderRadius: 8, border: "1px solid #E5E2DC", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#F0FDFB")}
                        onMouseLeave={e => (e.currentTarget.style.background = "#F9F9F9")}>
                        <span style={{ fontSize: 12, color: "#1A1917", fontWeight: 600 }}>{String(j.service_type || "").replace(/_/g, " ")}</span>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <span style={{ fontSize: 11, color: "#9E9B94" }}>{String(j.scheduled_date || "")}</span>
                          {j.base_fee != null && <span style={{ fontSize: 11, color: "#6B6860", fontWeight: 600 }}>${parseFloat(String(j.base_fee)).toFixed(0)}</span>}
                          <span style={{ fontSize: 10, color: "#2D9B83", fontWeight: 700 }}>Re-book ▸</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Service Type</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                  {SERVICE_TYPES.map(svc => (
                    <button key={svc.value} onClick={() => setServiceType(svc.value)}
                      style={{ padding: "12px 8px", border: `2px solid ${serviceType === svc.value ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, borderRadius: 10, background: serviceType === svc.value ? "var(--brand-dim, #EBF4FF)" : "#fff", cursor: "pointer", textAlign: "center", fontFamily: "inherit", transition: "all 0.15s" }}>
                      <div style={{ display: "flex", justifyContent: "center", marginBottom: 4 }}>
                        <svc.icon size={18} color={serviceType === svc.value ? "var(--brand, #00C9A0)" : "#6B7280"}/>
                      </div>
                      <p style={{ fontSize: 10, fontWeight: 600, color: serviceType === svc.value ? "var(--brand, #00C9A0)" : "#6B7280", margin: 0, lineHeight: 1.3 }}>{svc.label}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Date</p>
                  <input type="date" value={scheduledDate} onChange={e => setScheduledDate(e.target.value)}
                    style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                </div>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Time</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {TIME_OPTIONS.map(t => (
                      <button key={t} onClick={() => setScheduledTime(t)}
                        style={{ padding: "5px 10px", border: `1.5px solid ${scheduledTime === t ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, borderRadius: 6, background: scheduledTime === t ? "var(--brand-dim, #EBF4FF)" : "#fff", fontSize: 11, fontWeight: scheduledTime === t ? 700 : 400, color: scheduledTime === t ? "var(--brand, #00C9A0)" : "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>
                        {formatTime(t)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Duration</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {DURATION_OPTIONS.map(d => (
                      <button key={d} onClick={() => setDuration(d)}
                        style={{ padding: "5px 10px", border: `1.5px solid ${duration === d ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, borderRadius: 6, background: duration === d ? "var(--brand-dim, #EBF4FF)" : "#fff", fontSize: 11, fontWeight: duration === d ? 700 : 400, color: duration === d ? "var(--brand, #00C9A0)" : "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>
                        {d >= 60 ? `${d / 60}h` : `${d}m`}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: 0, textTransform: "uppercase", letterSpacing: "0.06em" }}>Price</p>
                    <span style={{ fontSize: 10, color: "#9E9B94" }}>{priceOverridden ? "Custom" : `Auto (${svcConfig?.label})`}</span>
                  </div>
                  <div style={{ position: "relative" }}>
                    <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#6B7280" }}>$</span>
                    <input type="number" value={price} onChange={e => { setPrice(Number(e.target.value)); setPriceOverridden(true); }}
                      style={{ width: "100%", padding: "9px 12px 9px 24px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Frequency</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {FREQ_OPTIONS.map(f => (
                      <button key={f.value} onClick={() => setFrequency(f.value)}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: `1.5px solid ${frequency === f.value ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, borderRadius: 8, background: frequency === f.value ? "var(--brand-dim, #EBF4FF)" : "#fff", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                        {frequency === f.value && <Check size={12} color="var(--brand, #00C9A0)"/>}
                        <span style={{ fontSize: 12, fontWeight: frequency === f.value ? 600 : 400, color: frequency === f.value ? "var(--brand, #00C9A0)" : "#6B7280" }}>{f.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Notes (optional)</p>
                  <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Special instructions, access codes, etc…"
                    style={{ width: "100%", height: 130, padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 12, fontFamily: "inherit", outline: "none", resize: "none", boxSizing: "border-box", lineHeight: 1.5 }}/>
                </div>
              </div>

              {/* View Quote section */}
              {serviceType && duration > 0 && (
                <div>
                  {!showQuote ? (
                    <button type="button" onClick={() => setShowQuote(true)}
                      style={{ width: "100%", padding: "11px 14px", border: "1px solid #E5E2DC", borderRadius: 10, background: "#F7F6F3", fontSize: 13, fontWeight: 600, color: "var(--brand, #00C9A0)", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, touchAction: "manipulation" }}>
                      View Quote
                    </button>
                  ) : (
                    <div style={{ border: "1px solid #E5E2DC", borderRadius: 12, padding: 16, backgroundColor: "#F7F6F3" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                        <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", margin: 0 }}>Quote Summary</p>
                        <button type="button" onClick={() => { setShowQuote(false); setQuoteSent(false); setQuoteError(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 2 }}><X size={14}/></button>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                          <span style={{ color: "#6B7280" }}>Service</span>
                          <span style={{ fontWeight: 600, color: "#1A1917" }}>{fmtSvcLabel(serviceType)}</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                          <span style={{ color: "#6B7280" }}>Duration</span>
                          <span style={{ fontWeight: 600, color: "#1A1917" }}>{duration >= 60 ? `${duration / 60}h` : `${duration}m`}</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                          <span style={{ color: "#6B7280" }}>Frequency</span>
                          <span style={{ fontWeight: 600, color: "#1A1917" }}>{frequency.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, borderTop: "1px solid #E5E2DC", paddingTop: 10, marginTop: 2 }}>
                          <span style={{ fontWeight: 700, color: "#1A1917" }}>Total</span>
                          <span style={{ fontWeight: 800, color: "var(--brand, #00C9A0)" }}>${price.toFixed(2)}</span>
                        </div>
                      </div>
                      {quoteError && <p style={{ fontSize: 12, color: "#DC2626", margin: "0 0 10px", padding: "8px 12px", background: "#FEE2E2", borderRadius: 6 }}>{quoteError}</p>}
                      {quoteSent ? (
                        <p style={{ fontSize: 13, fontWeight: 600, color: "#16A34A", textAlign: "center", padding: "10px 0" }}>Quote sent to client</p>
                      ) : (
                        <button type="button" disabled={quoteSending || !selectedClient}
                          title={!selectedClient ? "Select a client first" : ""}
                          onClick={async () => {
                            if (!selectedClient) return;
                            setQuoteSending(true); setQuoteError("");
                            try {
                              const r = await fetch(`${API}/api/quotes`, {
                                method: "POST", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
                                body: JSON.stringify({ client_id: selectedClient.id, service_type: serviceType, duration_minutes: duration, price, frequency, notes: notes || undefined, send_email: true }),
                              });
                              if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any).message || "Failed to send quote"); }
                              setQuoteSent(true);
                            } catch (e: any) { setQuoteError(e.message || "Failed to send quote"); }
                            finally { setQuoteSending(false); }
                          }}
                          style={{ width: "100%", padding: "11px 14px", border: "none", borderRadius: 8, background: selectedClient ? "var(--brand, #00C9A0)" : "#E5E2DC", color: selectedClient ? "#FFFFFF" : "#9E9B94", fontSize: 13, fontWeight: 700, cursor: selectedClient ? "pointer" : "not-allowed", fontFamily: "inherit", opacity: quoteSending ? 0.7 : 1, touchAction: "manipulation" }}>
                          {quoteSending ? "Sending..." : "Send Quote to Client"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── STEP 2: SERVICE + RATE (Commercial) ── */}
          {step === 2 && clientType === "commercial" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <div>
                <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Service Type</p>
                <select value={commercialServiceType} onChange={e => { setCommercialServiceType(e.target.value); setRateLookup(null); setRateLookupDone(false); setRateOverride(false); }}
                  style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", background: "#fff", boxSizing: "border-box" }}>
                  {COMMERCIAL_SERVICE_TYPES.map(s => (
                    <option key={s} value={s}>{fmtSvcLabel(s)}</option>
                  ))}
                </select>
              </div>

              {rateLookupLoading && (
                <div style={{ background: "#F7F6F3", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#9E9B94" }}>Looking up rate…</div>
              )}

              {rateLookupDone && rateLookup && !rateOverride && (
                <div style={{ background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 8, padding: "12px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <p style={{ fontSize: 12, fontWeight: 700, color: "#166534", margin: "0 0 2px" }}>
                        Rate: ${parseFloat(rateLookup.rate_amount || "0").toFixed(2)}{rateLookup.billing_method === "hourly" ? "/hr" : rateLookup.billing_method === "per_unit" ? `/${rateLookup.unit_label || "unit"}` : " flat"} — {fmtSvcLabel(rateLookup.service_type)}
                      </p>
                      <p style={{ fontSize: 11, color: "#166534", margin: 0 }}>From account rate card · {rateLookup.billing_method === "hourly" ? "Hourly" : rateLookup.billing_method === "flat_rate" ? "Flat rate" : "Per unit"}</p>
                    </div>
                    <Check size={16} color="#16A34A"/>
                  </div>
                  <button onClick={() => setRateOverride(true)}
                    style={{ marginTop: 8, fontSize: 11, color: "#6B7280", background: "none", border: "1px solid #D1D5DB", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                    Override for this job
                  </button>
                </div>
              )}

              {rateLookupDone && !rateLookup && (
                <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <AlertTriangle size={14} color="#D97706"/>
                    <p style={{ fontSize: 12, fontWeight: 700, color: "#92400E", margin: 0 }}>No rate configured for "{fmtSvcLabel(commercialServiceType)}" on this account.</p>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <p style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", margin: "0 0 6px" }}>Billing Method</p>
                      <select value={manualBillingMethod} onChange={e => setManualBillingMethod(e.target.value)}
                        style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none", background: "#fff" }}>
                        <option value="hourly">Hourly</option>
                        <option value="flat_rate">Flat Rate</option>
                      </select>
                    </div>
                    <div>
                      <p style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", margin: "0 0 6px" }}>Rate ($)</p>
                      <div style={{ position: "relative" }}>
                        <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "#6B7280" }}>$</span>
                        <input type="number" value={manualRate} onChange={e => setManualRate(e.target.value)} placeholder="0.00"
                          style={{ width: "100%", padding: "8px 10px 8px 22px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                      </div>
                    </div>
                  </div>
                  <button onClick={() => window.open(`/accounts/${selectedAccount?.id}`, "_blank")}
                    style={{ marginTop: 8, fontSize: 11, color: "var(--brand, #00C9A0)", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
                    + Add to account rate card
                  </button>
                </div>
              )}

              {rateOverride && (
                <div style={{ background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: "12px 14px" }}>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", margin: "0 0 10px" }}>Override rate for this job</p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <p style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", margin: "0 0 6px" }}>Billing Method</p>
                      <select value={manualBillingMethod} onChange={e => setManualBillingMethod(e.target.value)}
                        style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none", background: "#fff" }}>
                        <option value="hourly">Hourly</option>
                        <option value="flat_rate">Flat Rate</option>
                      </select>
                    </div>
                    <div>
                      <p style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", margin: "0 0 6px" }}>Rate ($)</p>
                      <div style={{ position: "relative" }}>
                        <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "#6B7280" }}>$</span>
                        <input type="number" value={overrideRate} onChange={e => setOverrideRate(e.target.value)} placeholder="0.00"
                          style={{ width: "100%", padding: "8px 10px 8px 22px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                      </div>
                    </div>
                  </div>
                  <button onClick={() => setRateOverride(false)}
                    style={{ marginTop: 8, fontSize: 11, color: "#9E9B94", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
                    Cancel override
                  </button>
                </div>
              )}

              {(effectiveBillingMethod === "hourly") && (
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Estimated Duration (hrs)</p>
                  <input type="number" step="0.5" min="0.5" value={estimatedHours} onChange={e => setEstimatedHours(e.target.value)} placeholder="2.5"
                    style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                  <p style={{ fontSize: 11, color: "#9E9B94", margin: "4px 0 0" }}>Used for scheduling only. Invoice calculated from actual clock time.</p>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Date</p>
                  <input type="date" value={commercialScheduledDate} onChange={e => setCommercialScheduledDate(e.target.value)}
                    style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}/>
                </div>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Time</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {TIME_OPTIONS.map(t => (
                      <button key={t} onClick={() => setCommercialScheduledTime(t)}
                        style={{ padding: "5px 10px", border: `1.5px solid ${commercialScheduledTime === t ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, borderRadius: 6, background: commercialScheduledTime === t ? "var(--brand-dim, #EBF4FF)" : "#fff", fontSize: 11, fontWeight: commercialScheduledTime === t ? 700 : 400, color: commercialScheduledTime === t ? "var(--brand, #00C9A0)" : "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>
                        {formatTime(t)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Frequency</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {FREQ_OPTIONS.map(f => (
                      <button key={f.value} onClick={() => setCommercialFrequency(f.value)}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: `1.5px solid ${commercialFrequency === f.value ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, borderRadius: 8, background: commercialFrequency === f.value ? "var(--brand-dim, #EBF4FF)" : "#fff", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                        {commercialFrequency === f.value && <Check size={12} color="var(--brand, #00C9A0)"/>}
                        <span style={{ fontSize: 12, fontWeight: commercialFrequency === f.value ? 600 : 400, color: commercialFrequency === f.value ? "var(--brand, #00C9A0)" : "#6B7280" }}>{f.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Notes (optional)</p>
                  <textarea value={commercialNotes} onChange={e => setCommercialNotes(e.target.value)} placeholder="Special instructions…"
                    style={{ width: "100%", height: 130, padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 12, fontFamily: "inherit", outline: "none", resize: "none", boxSizing: "border-box", lineHeight: 1.5 }}/>
                </div>
              </div>
            </div>
          )}

          {/* ── STEP 3: ASSIGN ── */}
          {step === 3 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Summary card */}
              <div style={{ background: "#F7F6F3", borderRadius: 10, padding: "14px 16px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <div>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", margin: "0 0 3px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {clientType === "commercial" ? "Account" : "Client"}
                  </p>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", margin: 0 }}>
                    {clientType === "commercial" ? selectedAccount?.account_name : `${selectedClient?.first_name} ${selectedClient?.last_name}`}
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", margin: "0 0 3px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Service</p>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", margin: 0 }}>
                    {fmtSvcLabel(clientType === "commercial" ? commercialServiceType : serviceType)}
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", margin: "0 0 3px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Date & Time</p>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", margin: 0 }}>
                    {formatDate(clientType === "commercial" ? commercialScheduledDate : scheduledDate)} · {formatTime(clientType === "commercial" ? commercialScheduledTime : scheduledTime)}
                  </p>
                </div>
              </div>

              {/* Location override */}
              {branches.length >= 2 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>Location</label>
                  <select
                    value={String(selectedBranchOverride)}
                    onChange={e => setSelectedBranchOverride(e.target.value === "all" ? "all" : parseInt(e.target.value))}
                    style={{
                      width: "100%", padding: "9px 12px", borderRadius: 8,
                      border: "1px solid #E5E2DC", background: "#fff",
                      fontSize: 13, fontWeight: 500, color: "#1A1917",
                      fontFamily: "'Plus Jakarta Sans', sans-serif", cursor: "pointer",
                    }}
                  >
                    <option value="all">All Locations</option>
                    {branches.map(b => (
                      <option key={b.id} value={String(b.id)}>{b.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Access notes reminder for commercial */}
              {clientType === "commercial" && selectedProperty?.access_notes && (
                <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <AlertTriangle size={14} style={{ color: "#D97706", flexShrink: 0, marginTop: 1 }}/>
                  <div>
                    <p style={{ fontSize: 12, fontWeight: 700, color: "#92400E", margin: "0 0 2px" }}>Building access</p>
                    <p style={{ fontSize: 12, color: "#92400E", margin: 0 }}>{selectedProperty.access_notes}</p>
                  </div>
                </div>
              )}

              {/* Smart Suggestions */}
              {!suggestionsDismissed && (suggestionsLoading || suggestions.length > 0 || (!suggestionsLoading && suggestZip)) && (
                <div style={{ border: "1px solid #E5E2DC", borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "#F7F6F3", borderBottom: "1px solid #E5E2DC" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <MapPin size={13} color="var(--brand, #00C9A0)"/>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#1A1917", textTransform: "uppercase", letterSpacing: "0.06em" }}>Smart Suggestions</span>
                    </div>
                    <button onClick={() => setSuggestionsDismissed(true)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 2, lineHeight: 1 }}>
                      <X size={13}/>
                    </button>
                  </div>

                  {suggestionsLoading && (
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      {[0, 1, 2].map(i => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderBottom: i < 2 ? "1px solid #F3F4F6" : "none" }}>
                          <div style={{ width: 34, height: 34, borderRadius: 17, background: "#F3F4F6", flexShrink: 0 }}/>
                          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                            <div style={{ height: 11, width: "55%", background: "#F3F4F6", borderRadius: 4 }}/>
                            <div style={{ height: 9, width: "35%", background: "#F3F4F6", borderRadius: 4 }}/>
                          </div>
                          <div style={{ height: 28, width: 58, background: "#F3F4F6", borderRadius: 6 }}/>
                        </div>
                      ))}
                    </div>
                  )}

                  {!suggestionsLoading && suggestions.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      {suggestions.map((s, i) => {
                        const isTop = i === 0;
                        const initials = s.name.split(" ").map((n: string) => n[0]).slice(0, 2).join("");
                        return (
                          <div key={s.employee_id} style={{
                            display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
                            borderLeft: isTop ? "3px solid var(--brand, #00C9A0)" : "3px solid transparent",
                            borderBottom: i < suggestions.length - 1 ? "1px solid #F3F4F6" : "none",
                            background: selectedEmployee === s.employee_id ? "var(--brand-dim, #EBF4FF)" : "#fff",
                          }}>
                            {s.avatar_url
                              ? <img src={s.avatar_url} style={{ width: 34, height: 34, borderRadius: 17, objectFit: "cover", flexShrink: 0 }}/>
                              : <div style={{ width: 34, height: 34, borderRadius: 17, background: isTop ? "var(--brand-dim, #EBF4FF)" : "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: isTop ? "var(--brand, #00C9A0)" : "#6B7280", flexShrink: 0 }}>{initials}</div>
                            }
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{s.name}</span>
                                {s.zone_color && (
                                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.zone_color, flexShrink: 0, display: "inline-block" }}/>
                                    <span style={{ fontSize: 10, color: "#9E9B94" }}>{s.zone_name}</span>
                                  </span>
                                )}
                              </div>
                              <span style={{
                                fontSize: 10, fontWeight: 600, padding: "1px 7px", borderRadius: 10,
                                background: s.tier === 1 ? "#DCFCE7" : s.tier === 2 ? "var(--brand-dim, #EBF4FF)" : s.tier === 3 ? "#FEF3C7" : "#F3F4F6",
                                color: s.tier === 1 ? "#16A34A" : s.tier === 2 ? "var(--brand, #00C9A0)" : s.tier === 3 ? "#D97706" : "#6B7280",
                              }}>
                                {s.reason}
                              </span>
                            </div>
                            <button onClick={() => setSelectedEmployee(selectedEmployee === s.employee_id ? null : s.employee_id)}
                              style={{ padding: "6px 14px", border: `1.5px solid ${selectedEmployee === s.employee_id ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, borderRadius: 8, background: selectedEmployee === s.employee_id ? "var(--brand, #00C9A0)" : "#fff", color: selectedEmployee === s.employee_id ? "#fff" : "#6B7280", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                              {selectedEmployee === s.employee_id ? "Assigned" : "Assign"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Full employee list */}
              <div>
                <p style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {suggestions.length > 0 && !suggestionsDismissed ? "All Technicians" : "Choose Assignee (optional)"}
                </p>
                {employees.length === 0 && (
                  <p style={{ fontSize: 13, color: "#9E9B94", textAlign: "center", padding: "20px 0" }}>No active employees found</p>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {employees.map((e: any) => (
                    <button key={e.id} onClick={() => setSelectedEmployee(selectedEmployee === e.id ? null : e.id)}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: `2px solid ${selectedEmployee === e.id ? "var(--brand, #00C9A0)" : "#E5E2DC"}`, borderRadius: 10, background: selectedEmployee === e.id ? "var(--brand-dim, #EBF4FF)" : "#fff", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                      {e.avatar_url
                        ? <img src={e.avatar_url} style={{ width: 36, height: 36, borderRadius: 18, objectFit: "cover", flexShrink: 0 }}/>
                        : <div style={{ width: 36, height: 36, borderRadius: 18, background: "#E5E2DC", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#6B7280", flexShrink: 0 }}>
                            {e.first_name?.[0]}{e.last_name?.[0]}
                          </div>
                      }
                      <div style={{ flex: 1 }}>
                        <p style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", margin: "0 0 2px" }}>{e.first_name} {e.last_name}</p>
                        <p style={{ fontSize: 11, color: "#9E9B94", margin: 0, textTransform: "capitalize" }}>{e.role?.replace(/_/g, " ")}</p>
                      </div>
                      {selectedEmployee === e.id && <Check size={16} color="var(--brand, #00C9A0)"/>}
                    </button>
                  ))}
                </div>
              </div>

              {clientType === "residential" && error && (
                <p style={{ fontSize: 12, color: "#DC2626", background: "#FEE2E2", borderRadius: 6, padding: "8px 12px", margin: 0 }}>{error}</p>
              )}
            </div>
          )}

          {/* ── STEP 4: CONFIRMATION (Commercial only) ── */}
          {step === 4 && clientType === "commercial" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "#F7F6F3", borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Job Summary</p>
                {[
                  { label: "Account", value: selectedAccount?.account_name },
                  { label: "Property", value: formatAddress(selectedProperty?.address, selectedProperty?.city, (selectedProperty as any)?.state, (selectedProperty as any)?.zip) },
                  { label: "Service", value: fmtSvcLabel(commercialServiceType) },
                  {
                    label: "Billing",
                    value: effectiveBillingMethod === "hourly"
                      ? `$${parseFloat(effectiveRate || "0").toFixed(2)}/hr · Hourly${estimatedHours ? ` · est. ${estimatedHours}h` : ""}`
                      : `$${parseFloat(effectiveRate || "0").toFixed(2)} · Flat Rate`,
                  },
                  { label: "Scheduled", value: `${formatDate(commercialScheduledDate)} · ${formatTime(commercialScheduledTime)}` },
                  { label: "Frequency", value: FREQ_OPTIONS.find(f => f.value === commercialFrequency)?.label || commercialFrequency },
                  { label: "Team", value: employees.find(e => e.id === selectedEmployee)?.first_name ? `${employees.find(e => e.id === selectedEmployee)?.first_name} ${employees.find(e => e.id === selectedEmployee)?.last_name}` : "Unassigned" },
                  { label: "Payment", value: selectedAccount?.payment_method === "card_on_file" ? "Card on file — auto-charge on completion" : selectedAccount?.payment_method === "invoice_only" ? `Invoice only` : (selectedAccount?.payment_method || "").replace(/_/g, " ") },
                ].map(row => (
                  <div key={row.label} style={{ display: "flex", gap: 16, justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, color: "#9E9B94", minWidth: 80 }}>{row.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", textAlign: "right" }}>{row.value || "—"}</span>
                  </div>
                ))}
              </div>

              {effectiveBillingMethod === "hourly" && (
                <div style={{ background: "#DBEAFE", border: "1px solid #93C5FD", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <DollarSign size={14} style={{ color: "#1D4ED8", flexShrink: 0, marginTop: 1 }}/>
                  <p style={{ fontSize: 12, color: "#1E40AF", margin: 0 }}>Final invoice amount calculated from actual clock in/out time on completion.</p>
                </div>
              )}

              {selectedProperty?.access_notes && (
                <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <AlertTriangle size={14} style={{ color: "#D97706", flexShrink: 0, marginTop: 1 }}/>
                  <p style={{ fontSize: 12, color: "#92400E", margin: 0 }}>Building access: {selectedProperty.access_notes}</p>
                </div>
              )}

              {error && <p style={{ fontSize: 12, color: "#DC2626", background: "#FEE2E2", borderRadius: 6, padding: "8px 12px", margin: 0 }}>{error}</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "16px 24px", borderTop: "1px solid #F3F4F6", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button
            onClick={() => step > 0 ? setStep(s => s - 1) : onClose()}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 18px", border: "1px solid #E5E2DC", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#6B7280", fontFamily: "inherit" }}>
            <ChevronLeft size={14}/> {step === 0 ? "Cancel" : "Back"}
          </button>

          {step < maxStep
            ? <button
                onClick={() => {
                  if (!canGoNext()) return;
                  setStep(s => s + 1);
                }}
                disabled={!canGoNext()}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 20px", border: "none", borderRadius: 8, background: canGoNext() ? "var(--brand, #00C9A0)" : "#E5E2DC", cursor: canGoNext() ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 700, color: canGoNext() ? "#fff" : "#9E9B94", fontFamily: "inherit" }}>
                Next <ChevronRight size={14}/>
              </button>
            : <button onClick={submit} disabled={submitting}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 22px", border: "none", borderRadius: 8, background: submitting ? "#9E9B94" : "var(--brand, #00C9A0)", cursor: submitting ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 700, color: "#fff", fontFamily: "inherit" }}>
                {submitting ? "Creating…" : "Create Job"}
              </button>
          }
        </div>
      </div>
    </div>
  );
}
