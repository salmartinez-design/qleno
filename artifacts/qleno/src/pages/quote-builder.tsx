import { useState, useEffect, useRef, useCallback } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { CalendarPopover } from "@/components/calendar-popover";
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
import { QuoteAttachments } from "@/components/quote-attachments";
import {
  ArrowLeft, Save, SendHorizonal, ArrowRight, ChevronDown,
  User, Home, Calculator, PlusSquare, AlertCircle, CheckCircle2, Check,
  X, Phone, ImagePlus, Loader2, Trash2, CreditCard,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { calculateCommissionSplit } from "@/lib/commission";
import { usePickerSources } from "@/lib/acquisition-sources";
import { AddonIcon } from "@/lib/addon-icons";
import { SquareCardForm } from "@/components/square-card-form";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

// [counter-unify 2026-05-27] Centralized rule for which add-ons render
// with the +/- counter UI vs a checkbox. Name-matched (case-insensitive)
// so it works regardless of slug/scope-id.
// [addon-qty 2026-07-28] Baseboards added — Sal wants a real qty on every
// flat per-item add-on (Oven, Refrigerator, Kitchen Cabinets, Baseboards,
// Parking). The percentage-typed ones (Windows +15%, Clean Basement +15%)
// are excluded at the call site via `isPercentAddon(addon)` because a qty
// multiplier on a percentage is nonsense — this name list is intentionally
// a superset and the price_type guard has the final say.
function isCounterAddon(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("oven") ||
    n.includes("refrigerator") ||
    n.includes("cabinet") ||
    n.includes("baseboard") ||
    n.includes("window") ||
    n.includes("basement") ||
    n.includes("parking")
  );
}

// [addon-qty 2026-07-28] Percentage-priced add-ons must NEVER get a qty
// counter — multiplying a percentage (e.g. Windows +15%) by a count is
// meaningless. This is the guard that overrides the name-based list above.
function isPercentAddon(addon: { price_type?: string | null }): boolean {
  return addon.price_type === "percentage" || addon.price_type === "percent";
}

// [addon-recurrence 2026-07-28] A scope is "recurring" when a cadence is
// selected that isn't a one-time visit. Drives the per-add-on First visit /
// Every visit choice — only recurring services repeat, so a one-time quote
// never shows the toggle (its add-ons apply to the single job as before).
function isRecurringFrequency(freq: string | null | undefined): boolean {
  const f = (freq || "").toLowerCase();
  if (!f) return false;
  return !/one|single|once/.test(f);
}

// [translate-job-notes 2026-05-27] Inline "Translate to Spanish" button +
// expandable Spanish display below the Job Notes textarea. Hits
// /api/translate (Claude API) — server-side, so the API key stays off the
// client bundle. Hidden when the textarea is empty so the form doesn't
// scream "translate" at draft-time.
function JobNotesTranslate({ text }: { text: string }) {
  const [translated, setTranslated] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the translation if the source text changes after a translation
  // — stale output is worse than no output.
  useEffect(() => { setTranslated(null); setError(null); }, [text]);

  if (!text.trim()) return null;

  async function translate() {
    setLoading(true); setError(null);
    try {
      const result = await apiFetch("/api/translate", { method: "POST", body: { text, target: "es" } });
      setTranslated(String(result?.translated ?? "").trim() || null);
    } catch (e: any) {
      setError(e?.message?.includes("503")
        ? "Translation isn't configured yet — ask an admin to set ANTHROPIC_API_KEY in Railway."
        : "Translation failed. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  function copy() {
    if (!translated) return;
    try { navigator.clipboard.writeText(translated); } catch { /* ignore */ }
  }

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <button
        type="button"
        onClick={translate}
        disabled={loading}
        style={{
          fontSize: 11, fontWeight: 600, fontFamily: FF,
          padding: "3px 9px", borderRadius: 6,
          border: "1px solid #E5E2DC", background: "#FFF", color: "#1A1917",
          cursor: loading ? "wait" : "pointer", opacity: loading ? 0.6 : 1,
        }}
        title="Translate the current Job Notes to Spanish using Claude"
      >
        {loading ? "Translating..." : translated ? "Re-translate" : "Translate to Spanish"}
      </button>
      {translated && (
        <button
          type="button"
          onClick={copy}
          style={{ fontSize: 11, fontWeight: 600, fontFamily: FF, padding: "3px 9px", borderRadius: 6, border: "1px solid #E5E2DC", background: "#FFF", color: "#1A1917", cursor: "pointer" }}
          title="Copy Spanish to clipboard"
        >
          Copy
        </button>
      )}
      {(translated || error) && (
        <div style={{ flexBasis: "100%" }}>
          {translated && (
            <div style={{ marginTop: 6, padding: "8px 10px", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 12, color: "#1A1917", fontFamily: FF, whiteSpace: "pre-wrap" }}>
              {translated}
            </div>
          )}
          {error && (
            <div style={{ marginTop: 6, fontSize: 11, color: "#B3261E", fontFamily: FF }}>{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

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
  base_hours: number; addon_hours?: number; total_hours?: number;
  hourly_rate: number; base_price: number; minimum_applied: boolean;
  minimum_bill: number; addons_total: number;
  addon_breakdown: Array<{ id: number; name: string; amount: number; price_type?: string }>;
  bundle_discount: number; bundle_breakdown: Array<{ id: number; name: string; discount: number; applied: boolean }>;
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
  // [combo-optional] Bundle ids the office toggled OFF for this scope. Passed
  // to the pricing engine so their discount isn't applied to the total.
  disabledBundleIds: number[];
  // [rate-override 2026-07-11] Office-typed $/hr for THIS quote (Sunday /
  // after-hours / special pricing) — overrides the scope's config rate for this
  // quote only. null = use the configured rate. Sent to /pricing/calculate as
  // hourly_rate_override (engine already supports it), baked into the quote's
  // total, and carried to the job on convert. Does NOT change base pricing.
  hourlyRateOverride: number | null;
  frequencies: PricingFrequency[];
  addons: PricingAddon[];
  calc: CalcResult | null;
  calcLoading: boolean;
  expanded: boolean;
  // [hourly-recurring-label] The "Recurring" hourly sub-type reuses the Hourly
  // Standard scope for pricing, so its raw scope name is "Hourly Standard
  // Cleaning" — misleading when the office picked Recurring. displayLabel, set
  // at selection time, overrides the shown name on every surface (Services list,
  // Price Preview, add-ons header, Review) so it reads "Hourly Recurring
  // Cleaning". null/undefined = fall back to the real scope name.
  displayLabel?: string;
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

// [custom-recurring] Sentinel frequency for a scope whose cadence is the
// flexible custom pattern (see the customRec state). Kept off the standard
// SNAP_KEY set so the convert route branches on `custom_recurrence` instead.
const CUSTOM_FREQ = "custom_pattern";
// [cadence-display 2026-07-27] Human labels for the recurring cadence shown on
// each quote line (drives the hourly-recurring $60/$65/$70 rate). One-time keys
// map to null so no chip renders for a single visit.
const CADENCE_LABELS: Record<string, string | null> = {
  weekly: "Weekly", every_2_weeks: "Bi-Weekly", biweekly: "Bi-Weekly",
  every_3_weeks: "Every 3 Weeks", every_4_weeks: "Monthly", monthly: "Monthly",
  semi_monthly: "Twice a Month", monthly_weekday: "Monthly", custom: "Custom",
  onetime: null, one_time: null,
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEK_OF_MONTH = [
  { value: 1, label: "1st" }, { value: 2, label: "2nd" }, { value: 3, label: "3rd" },
  { value: 4, label: "4th" }, { value: 5, label: "Last" },
];
// Ordinal helper for the live-preview sentence ("every 3 weeks", "every 2 months").
function customRecSummary(r: { interval: number; unit: "weeks" | "months"; weekday: number; weekOfMonth: number }): string {
  const every = r.interval === 1 ? "" : `${r.interval} `;
  if (r.unit === "weeks") {
    return `Every ${every}${r.interval === 1 ? "week" : "weeks"} on ${WEEKDAYS[r.weekday]}`;
  }
  const nth = WEEK_OF_MONTH.find(w => w.value === r.weekOfMonth)?.label ?? "1st";
  return `Every ${every}${r.interval === 1 ? "month" : "months"}, on the ${nth} ${WEEKDAYS[r.weekday]}`;
}

export default function QuoteBuilderPage() {
  const [matchEdit, editParams] = useRoute("/quotes/:id/edit");
  const id = editParams?.id;
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const isEdit = Boolean(id && id !== "new");
  const fromClientId = parseInt(new URLSearchParams(window.location.search).get("client_id") || "") || null;
  const token = useAuthStore(s => s.token);

  const userRole = (() => { try { return JSON.parse(atob((token || "").split(".")[1])).role || "office"; } catch { return "office"; } })();

  const [activeSection, setActiveSection] = useState(0);
  const [saving, setSaving] = useState(false);

  // [sqft-notice-gate 2026-07-25] The "prices are estimated — enter sqft"
  // banner on Service & Pricing (Step 2) must NOT fire before the user has
  // actually reached Property Details (Step 3, the sqft entry). On a fresh
  // quote sqft defaults to 0, so the banner used to show immediately on
  // Step 2 telling the user to go "back" to a step that's still ahead —
  // premature and backwards. Only warn once they've visited Property
  // Details and left sqft blank. Property Details is activeSection === 2.
  const [reachedPropertyDetails, setReachedPropertyDetails] = useState(false);
  useEffect(() => {
    if (activeSection >= 2) setReachedPropertyDetails(true);
  }, [activeSection]);

  // [scroll-on-step 2026-05-27] Snap viewport to top whenever the user
  // advances or backs up a section. Without this the page keeps its
  // prior scroll position — the new section's "Next" button sat in view
  // while the section header was off-screen above, so it looked like the
  // form had jumped to its bottom. Mobile already did this inline at the
  // step-button onClick; mirroring it here covers every entry point
  // (top-tab clicks, programmatic setActiveSection on convert, etc.).
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeSection]);

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
  // [leadsource-unify 2026-07-28] Options come from Settings (acquisition_sources)
  // so this picker always matches the configured "How did you hear about us?"
  // list — no longer a hardcoded enum that diverged from Settings. The stored
  // value is the source slug (referral_source is TEXT). "existing_client" is set
  // programmatically for known clients and never offered as an option.
  const referralOptions = usePickerSources();
  // [referral-required-step 2026-07-25] A new lead must pick how they heard
  // about us before leaving Customer Info — the save() gate at status="sent"
  // caught it too late (whole quote built, then blocked). Existing clients are
  // exempt (they already answered). referralError drives the red field + hint.
  const [referralError, setReferralError] = useState(false);
  const [zipZone, setZipZone] = useState<{ name: string; color: string } | null | "uncovered">(null);
  const [checkingZip, setCheckingZip] = useState(false);
  const [zoneOverride, setZoneOverride] = useState(false);

  // ── Section 1: Property Details ──────────────────────────────────────────
  const [sqft, setSqft] = useState<number>(0);
  const [bedrooms, setBedrooms] = useState<number>(0);
  const [bathrooms, setBathrooms] = useState<number>(0);
  // [rentcast 2026-07-27] Look up what RentCast has for the typed address and just
  // SHOW it (sqft/beds/baths) as a reference — never auto-fills the field (Sal:
  // "just shows us the sq ft it has, is all"). Backend is gated on
  // RENTCAST_API_KEY, so this is inert until that key is set in Railway.
  const [rcResult, setRcResult] = useState<any>(null);
  const [rcLoading, setRcLoading] = useState(false);
  async function lookupRentcast() {
    const addr = (addressFormatted || [address, zipCode].filter(Boolean).join(", ")).trim();
    if (!addr) { setRcResult({ configured: true, found: false, no_address: true }); return; }
    setRcLoading(true); setRcResult(null);
    try { setRcResult(await apiFetch(`/api/property-lookup?address=${encodeURIComponent(addr)}`)); }
    catch { setRcResult({ configured: true, found: false }); }
    finally { setRcLoading(false); }
  }
  const [halfBaths, setHalfBaths] = useState<number>(0);
  const [pets, setPets] = useState<number>(0);
  const [dirtLevel, setDirtLevel] = useState("standard");

  // ── Section 2: Multi-scope selection ────────────────────────────────────
  const [selectedScopes, setSelectedScopes] = useState<SelectedScopeState[]>([]);
  // Default the convert date to today (local, not UTC — avoids the
  // off-by-one that would land the job on the previous day in Central time).
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
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
  // [multi-option-send 2026-07-25] When 2+ scopes are on the quote, the office
  // decides at send time whether the client sees BOTH options (they pick one)
  // or only the recommended one. `finalScopeId` is the recommended/only scope;
  // this flag decides whether the others ride along as alternate_options on the
  // client's booking page. Defaults to sending both. Irrelevant for 1 scope.
  const [sendBoth, setSendBoth] = useState(true);

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
  // [autocomplete-remount 2026-08-10] Track the address input ELEMENT, not a
  // one-way "has it mounted yet" boolean. The old flag latched true on first
  // mount and never reset, so stepping forward past the address step and back
  // remounted the input but left the flag unchanged — the wiring effect's deps
  // never changed, so Google Autocomplete stayed bound to the discarded DOM
  // node and the live input had nothing attached. Editing the address after
  // clicking Next then silently stopped verifying, which is why the zip never
  // refreshed (Francisco, 8/8). Holding the node in state re-runs the effect on
  // every remount. The setter identity must be stable (useCallback) or React
  // would invoke the ref on every render and loop.
  const [addressEl, setAddressEl] = useState<HTMLInputElement | null>(null);
  const setAddressInputRef = useCallback((el: HTMLInputElement | null) => {
    (addressInputRef as any).current = el;
    setAddressEl(el);
  }, []);
  const [addressVerified, setAddressVerified] = useState<boolean | null>(null);
  const [addressFormatted, setAddressFormatted] = useState("");
  // [rentcast 2026-07-27] Auto-look up the property's sq ft the moment the
  // address verifies, right here on Customer Info (where the office is typing) —
  // Sal wants "type the address and RentCast just shows the sq ft it has." Guard
  // on the last-looked-up address so it fires once per address, not every render
  // (protects the RentCast API quota). Inert until RENTCAST_API_KEY is set.
  const rcLastAddrRef = useRef<string>("");
  useEffect(() => {
    if (addressVerified !== true) return;
    const addr = (addressFormatted || [address, zipCode].filter(Boolean).join(", ")).trim();
    if (!addr || addr === rcLastAddrRef.current) return;
    rcLastAddrRef.current = addr;
    lookupRentcast();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressVerified, addressFormatted]);
  // [rentcast-autofill 2026-07-27] When RentCast finds the property, carry its
  // sqft / beds / baths over to Property Details as a starting point — but
  // NON-destructively: only fill a field the office hasn't already set (still
  // 0 / empty). Never overwrites a value the office typed. rcAppliedRef pins
  // the applied result object so a later re-render (or the office editing a
  // field, which re-runs this effect) can't re-fill anything — it applies once
  // per distinct lookup result. RentCast has no half-bath figure, so
  // bathrooms → Full Bathrooms only; Half Bathrooms / Pets stay untouched.
  const rcAppliedRef = useRef<any>(null);
  useEffect(() => {
    if (!rcResult || !rcResult.found || rcAppliedRef.current === rcResult) return;
    rcAppliedRef.current = rcResult;
    const sf = parseInt(rcResult.square_footage, 10);
    if (!sqft && !isNaN(sf) && sf > 0) setSqft(sf);
    if (!bedrooms && rcResult.bedrooms != null) {
      const b = parseInt(rcResult.bedrooms, 10);
      if (!isNaN(b) && b > 0) setBedrooms(b);
    }
    // [half-baths 2026-08-12] Take the SPLIT the lookup now returns rather than
    // parseInt-ing the combined figure. RentCast reports "2.5" for two full and
    // one half; parseInt made that a 2 and the half bath vanished from the
    // quote entirely (Francisco). full_bathrooms/half_bathrooms fall back to
    // the old field so an older API response still fills the full-bath box.
    const fullFromLookup = rcResult.full_bathrooms ?? rcResult.bathrooms;
    if (!bathrooms && fullFromLookup != null) {
      const ba = Math.floor(Number(fullFromLookup));
      if (!isNaN(ba) && ba > 0) setBathrooms(ba);
    }
    if (!halfBaths && rcResult.half_bathrooms != null) {
      const hb = Math.floor(Number(rcResult.half_bathrooms));
      if (!isNaN(hb) && hb > 0) setHalfBaths(hb);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rcResult]);
  // [maps-runtime-fallback] Cache the resolved Maps key so the geocode
  // helper (separate REST call) doesn't need to know how it was sourced.
  const mapsKeyRef = useRef<string>("");
  const [callNoteTooltip, setCallNoteTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [pushConfirmed, setPushConfirmed] = useState(false);

  // ── Returning client ─────────────────────────────────────────────────────
  const [returningClient, setReturningClient] = useState<{ id: number; name: string; phone?: string; email?: string; address?: string } | null>(null);
  const [returningClientDismissed, setReturningClientDismissed] = useState(false);

  // ── Tech suggestions ─────────────────────────────────────────────────────
  const [suggestedTechs, setSuggestedTechs] = useState<SuggestedTech[]>([]);
  // Multi-tech assignment: the office can assign more than one cleaner to a
  // job at quote time. First selected = primary (mirrored onto
  // jobs.assigned_user_id); the rest become job_technicians rows on convert.
  const [selectedTechIds, setSelectedTechIds] = useState<number[]>([]);
  const toggleTech = (id: number) =>
    setSelectedTechIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const [techAvailability, setTechAvailability] = useState<Record<number, number>>({});
  const [techAvailLoading, setTechAvailLoading] = useState(false);

  // ── Card on file (Square) — Review step ───────────────────────────────────
  // Two ways to put a card on file from the quote: capture it now (type it in
  // via the Square Web Payments SDK), or send the customer a leave-a-card link.
  // Both are gated on a real, saved client (selectedClientId) — you can't save
  // a card to a lead that has no client row yet.
  const [cardModalOpen, setCardModalOpen] = useState(false);
  const [sqCfg, setSqCfg] = useState<{ configured: boolean; applicationId: string; locationId: string; environment: "sandbox" | "production" } | null>(null);
  const [sqCfgLoading, setSqCfgLoading] = useState(false);
  const [cardSaved, setCardSaved] = useState(false);
  // [lead-card-capture 2026-08-08] For a NEW lead there is no client row yet, so
  // the card can't be saved at entry time. Hold the one-time Square nonce here
  // and ship it with the convert, which materializes the client and attaches it
  // server-side. Never a PAN — this is the `cnon:` token the SDK hands back, and
  // it dies with the page.
  const [pendingCardToken, setPendingCardToken] = useState<string | null>(null);
  // [lead-card-link 2026-08-08] Whether the selected client ALREADY has a card,
  // so the button reads "Replace card on file" instead of silently overwriting
  // one the office didn't know was there. GET /api/clients/:id returns the row,
  // so both the Stripe display column and the Square mirror are available.
  const existingCardLast4: string | null =
    (clientLoaded as any)?.card_last_four
    ?? (clientLoaded as any)?.square_card_last4
    ?? (clientLoaded as any)?.default_card_last_4
    ?? null;
  const existingCardBrand: string | null =
    (clientLoaded as any)?.card_brand ?? (clientLoaded as any)?.square_card_brand ?? null;
  const [linkSending, setLinkSending] = useState<null | "email" | "sms">(null);
  const [linkSent, setLinkSent] = useState<null | "email" | "sms">(null);
  // The customer's phone/email cascade here from the Customer Info step so the
  // office can text/email the leave-a-card link without re-typing — but stay
  // editable (send it to a spouse's phone, fix a typo) before sending. Once the
  // office edits a field, we stop auto-syncing it so their edit sticks.
  const [cardLinkPhone, setCardLinkPhone] = useState("");
  const [cardLinkEmail, setCardLinkEmail] = useState("");
  const cardLinkPhoneEdited = useRef(false);
  const cardLinkEmailEdited = useRef(false);
  useEffect(() => {
    if (!cardLinkPhoneEdited.current) setCardLinkPhone(clientLoaded?.phone || leadPhone || "");
  }, [clientLoaded?.phone, leadPhone]);
  useEffect(() => {
    if (!cardLinkEmailEdited.current) setCardLinkEmail(clientLoaded?.email || leadEmail || "");
  }, [clientLoaded?.email, leadEmail]);

  const openCardModal = async () => {
    setCardModalOpen(true);
    if (sqCfg) return;
    setSqCfgLoading(true);
    try {
      const r = await fetch(`${API}/api/square/config`, { headers: getAuthHeaders() });
      const d = await r.json();
      // [square-appid-case 2026-08-07] GET /api/square/config returns CAMELCASE
      // (`applicationId` / `locationId` — see lib/square-config.ts). This read
      // snake_case, so both ids came back "" while `configured` stayed true, and
      // the modal handed Square.payments("", "") to the SDK — which is exactly
      // the "The Payment 'applicationId' option is not in the correct format."
      // error. Only the PUBLIC /pay link payload uses snake_case, and that's a
      // different endpoint (routes/payment-links.ts) read by pay.tsx.
      setSqCfg({
        configured: !!d.configured,
        applicationId: d.applicationId || "",
        locationId: d.locationId || "",
        environment: d.environment === "production" ? "production" : "sandbox",
      });
    } catch {
      setSqCfg({ configured: false, applicationId: "", locationId: "", environment: "sandbox" });
    } finally {
      setSqCfgLoading(false);
    }
  };

  const saveSquareCard = async (sourceId: string) => {
    // [lead-card-capture 2026-08-08] New lead, no client row yet: park the token
    // and let the convert attach it. The office sees "will be saved when you
    // book", so the card is taken on the call instead of chasing the customer
    // afterwards.
    if (!selectedClientId) {
      setPendingCardToken(sourceId);
      setCardSaved(true);
      setTimeout(() => setCardModalOpen(false), 1400);
      return;
    }
    const r = await fetch(`${API}/api/square/clients/${selectedClientId}/save-card`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: sourceId }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || d.message || "Could not save card");
    }
    setCardSaved(true);
    setTimeout(() => setCardModalOpen(false), 1400);
  };

  const sendCardLink = async (channel: "email" | "sms") => {
    if (channel === "sms" && !cardLinkPhone.trim()) { toast.error("Enter a mobile number to text the card link."); return; }
    if (channel === "email" && !cardLinkEmail.trim()) { toast.error("Enter an email to send the card link."); return; }
    setLinkSending(channel);
    try {
      // [lead-card-link 2026-08-08] A payment link needs a client row
      // (payment_links.client_id is NOT NULL), so a new lead used to be barred
      // from texting or emailing one — the office could only offer it to
      // customers already in the system, which is backwards on a first call.
      // Save the quote, let the server materialize the client from the lead's
      // details (the same dedupe convert uses, so no twin gets created), then
      // send. Failures surface as a toast rather than a dead button.
      let linkClientId = selectedClientId;
      if (!linkClientId) {
        const saved = await apiFetch(
          autoSavedIdRef.current || (isEdit ? id : null)
            ? `/api/quotes/${autoSavedIdRef.current || id}`
            : "/api/quotes",
          {
            method: autoSavedIdRef.current || (isEdit ? id : null) ? "PATCH" : "POST",
            body: buildPayload("draft"),
          },
        );
        const qid = saved?.id ?? autoSavedIdRef.current ?? id;
        if (!qid) throw new Error("Could not save this quote, so the link can't be sent yet.");
        autoSavedIdRef.current = qid;
        const ensured = await apiFetch(`/api/quotes/${qid}/ensure-client`, { method: "POST" });
        linkClientId = ensured?.client_id ?? null;
        if (!linkClientId) throw new Error("Add a name, phone, email or address before sending a card link.");
      }
      const r = await fetch(`${API}/api/payment-links`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: linkClientId,
          purpose: "save_card",
          provider: "square",
          send_email: channel === "email",
          send_sms: channel === "sms",
          // Editable recipient overrides — backend honors to_phone/to_email.
          to_phone: channel === "sms" ? cardLinkPhone.trim() : undefined,
          to_email: channel === "email" ? cardLinkEmail.trim() : undefined,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast.error(d.error || d.message || "Could not send card link");
        return;
      }
      setLinkSent(channel);
      toast.success(channel === "email" ? "Card link emailed to the customer." : "Card link texted to the customer.");
    } catch (e: any) {
      // Surface the real reason — "Add a name, phone, email or address" is
      // actionable, "Could not send card link" is not.
      toast.error(e?.message || "Could not send card link");
    } finally {
      setLinkSending(null);
    }
  };

  // ── Quick Book (returning client) ─────────────────────────────────────────
  const [preferredTech, setPreferredTech] = useState<PreferredTech | null>(null);
  const [recentServices, setRecentServices] = useState<RecentService[]>([]);
  const [quickBookDismissed, setQuickBookDismissed] = useState(false);
  const [quickBookBanner, setQuickBookBanner] = useState<{ scope: string; date: string } | null>(null);
  const [quickBookPrice, setQuickBookPrice] = useState<number | null>(null);
  const [hourlyExpanded, setHourlyExpanded] = useState(false);
  const [hourlySubType, setHourlySubType] = useState<string | null>(null);
  const [callNotesOpen, setCallNotesOpen] = useState(false);

  // ── Custom recurrence ──────────────────────────────────────────────────────
  // [custom-recurring] A flexible pattern shared by TWO entry points: the
  // "Custom" card in the Recurring group, and the "Custom…" option in the
  // Hourly cadence dropdown. The card/cadence sets a base scope's frequency to
  // the CUSTOM_FREQ sentinel; when that's active we pass `custom_recurrence` on
  // convert and the server maps it to recurring_schedules columns:
  //   unit=weeks  → frequency='custom' + custom_frequency_weeks=interval + day_of_week
  //   unit=months → frequency='monthly_weekday' + week_of_month + day_of_week + month_interval
  // Price is unchanged — the base recurring (or hourly) scope drives it. Custom
  // ONLY changes WHEN the visits land (Sal: "same per-visit recurring rate").
  const [customRecOpen, setCustomRecOpen] = useState(false);
  const [customRec, setCustomRec] = useState<{ interval: number; unit: "weeks" | "months"; weekday: number; weekOfMonth: number }>(
    { interval: 2, unit: "weeks", weekday: 2, weekOfMonth: 1 }
  );
  // [custom-recurring] The Hourly → Recurring "Custom…" cadence gets its OWN
  // open-state + pattern, fully separate from the top Recurring-group Custom
  // card above. They are different services (hourly-billed vs flat recurring),
  // so opening one must NOT light up / open the other (Sal: "they are
  // separate"). convert() ships whichever one is active.
  const [hourlyCustomOpen, setHourlyCustomOpen] = useState(false);
  const [hourlyCustomRec, setHourlyCustomRec] = useState<{ interval: number; unit: "weeks" | "months"; weekday: number; weekOfMonth: number }>(
    { interval: 2, unit: "weeks", weekday: 2, weekOfMonth: 1 }
  );

  // ── Mobile ───────────────────────────────────────────────────────────────
  const isMobile = useIsMobile();
  const [mobileNotesOpen, setMobileNotesOpen] = useState(false);
  const [mobileClientSearch, setMobileClientSearch] = useState("");
  const [mobileClientDropdown, setMobileClientDropdown] = useState(false);
  const [mobileStep, setMobileStep] = useState(1);
  // [new-client-mobile-fix] Reveals the new-prospect entry form on mobile Step 1.
  // Without it, mobile had no way to enter a brand-new client (the dropdown's
  // "Enter lead info instead" only closed the dropdown).
  const [mobileLeadForm, setMobileLeadForm] = useState(false);
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

  // Full assignable roster — the same endpoint the dispatch Add-Team-Member
  // picker uses (technician + team_lead, active only). Used as the fallback
  // for the "Assign Technician" picker when the matched zone has no employees
  // mapped to it (common post-MaidCentral-migration). Without this fallback
  // the office sees "No techs available" and can't assign anyone at quote
  // time even though techs exist — Maribel's report 2026-06-17.
  const { data: allTechs = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["quote-all-techs"],
    queryFn: () => apiFetch("/api/users/techs-with-status").then((r: any) => (Array.isArray(r?.data) ? r.data : [])),
    staleTime: 5 * 60 * 1000,
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

  // ── Pre-fill from ?lead_id= on mount (opened from a lead's "Build a quote") ──
  // [lead-prefill 2026-07-16] The office-initiated quote-from-lead path had NO
  // prefill: the lead button went to /quotes/new with no id and the builder only
  // understood ?client_id=, so the lead's captured info came up blank
  // (Francisco/Maribel: "when you create the quote from the lead the information
  // is not populating"). Mirror the client path — fetch the lead and map its
  // fields onto the form. A lead has no client_id yet (unless already converted),
  // so the quote carries the lead's contact as lead_name/email/phone and lead-sync
  // links it on send. Property fields fall back to the widget `details` JSON.
  useEffect(() => {
    if (isEdit || selectedClientId) return;
    const params = new URLSearchParams(window.location.search);
    const lid = parseInt(params.get("lead_id") || "");
    if (!lid || isNaN(lid)) return;
    (async () => {
      try {
        const lead = await apiFetch(`/api/leads/${lid}`);
        if (!lead || !lead.id) return;
        const wd: any = lead.details || {};
        const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
        setLeadFirstName(lead.first_name || "");
        setLeadLastName(lead.last_name || "");
        setLeadEmail(lead.email || "");
        setLeadPhone(lead.phone || "");
        setAddress(lead.address || "");
        setSqft(num(lead.sqft ?? wd.sqft));
        setBedrooms(num(lead.bedrooms ?? wd.bedrooms));
        setBathrooms(num(lead.bathrooms ?? wd.bathrooms));
        if (lead.referral_source || wd.referral_source) setReferralSource(String(lead.referral_source || wd.referral_source));
        if (lead.notes) setNotes(String(lead.notes));
        // A lead that was already converted to a client → link the client record
        // so pricing uses it, exactly like the ?client_id= path.
        if (lead.client_id) {
          setSelectedClientId(lead.client_id);
          setClientSearch(`${lead.first_name || ""} ${lead.last_name || ""}`.trim());
        }
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
        // [discount-rehydrate 2026-07-27] Pull this scope's saved manual
        // adjustments back out of manual_adjustments so the Add charge / Discount
        // the office entered is restored on reopen (was silently dropped).
        const adjs = Array.isArray(existingQuote.manual_adjustments) ? existingQuote.manual_adjustments : [];
        const addAdj = adjs.find((a: any) => a?.type === "add" && Number(a?.scope_id) === Number(existingQuote.scope_id));
        const subAdj = adjs.find((a: any) => a?.type === "subtract" && Number(a?.scope_id) === Number(existingQuote.scope_id));
        toggleScope(scope, {
          frequency: existingQuote.frequency || "",
          hours: existingQuote.estimated_hours ? parseFloat(existingQuote.estimated_hours) : 0,
          addon_ids: Array.isArray(existingQuote.addons) ? existingQuote.addons.map((a: any) => a.id).filter(Boolean) : [],
          // [addon-qty 2026-07-28] Carry the raw saved add-on rows so qty +
          // first/every-visit round-trip on reopen (not just the ids).
          addon_meta: Array.isArray(existingQuote.addons) ? existingQuote.addons : [],
          // [rate-override 2026-07-11] Restore the explicit per-quote rate override
          // so editing a quote doesn't silently drop it.
          hourly_rate_override: existingQuote.hourly_rate_override != null ? parseFloat(existingQuote.hourly_rate_override) : null,
          adjPlus: addAdj ? Number(addAdj.amount) || 0 : 0,
          adjPlusReason: addAdj ? String(addAdj.reason || "") : "",
          adjMinus: subAdj ? Number(subAdj.amount) || 0 : 0,
          adjMinusReason: subAdj ? String(subAdj.reason || "") : "",
        });
      }
    }
  }, [existingQuote, scopes.length]);

  // [quote-attachments] Async resolver passed to the <QuoteAttachments>
  // component. Returns the working quote id; if no quote exists yet
  // (brand-new draft, no auto-save fired), mints a draft now so an
  // attachment can be associated. Subsequent uploads reuse the id.
  const ensureQuoteId = useCallback(async (): Promise<number | null> => {
    if (isEdit && id) return parseInt(id);
    if (autoSavedIdRef.current) return parseInt(autoSavedIdRef.current);
    try {
      const result = await apiFetch("/api/quotes", { method: "POST", body: { status: "draft" } });
      autoSavedIdRef.current = String(result.id);
      return result.id;
    } catch {
      return null;
    }
  }, [isEdit, id]);

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
  // [maps-runtime-fallback 2026-05-26] Same pattern as jobs.tsx — fetch the
  // key from /api/config/google-maps-key first so we stay resilient when
  // the Railway build didn't inject VITE_GOOGLE_MAPS_API_KEY. Falls back
  // to the build-time var if the server endpoint is unreachable.
  useEffect(() => {
    if ((window as any).google?.maps?.places) { setMapsReady(true); return; }
    const scriptId = "gmap-places-script";
    if (document.getElementById(scriptId)) {
      const existing = document.getElementById(scriptId) as HTMLScriptElement;
      if (existing) { existing.addEventListener("load", () => setMapsReady(true)); }
      return;
    }

    let cancelled = false;
    (async () => {
      let key = "";
      try {
        const r = await fetch(`${API}/api/config/google-maps-key`, { headers: getAuthHeaders() });
        if (r.ok) {
          const body = await r.json().catch(() => ({}));
          key = String(body?.key ?? "");
        }
      } catch { /* fall through to build-time fallback */ }
      if (!key) key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY ?? "";
      if (cancelled || !key) return;
      mapsKeyRef.current = key;

      // Re-check whether another instance already injected the script
      // while we were awaiting the fetch.
      if ((window as any).google?.maps?.places) { setMapsReady(true); return; }
      if (document.getElementById(scriptId)) return;
      const s = document.createElement("script");
      s.id = scriptId;
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
      s.async = true;
      s.defer = true;
      s.onload = () => { if (!cancelled) setMapsReady(true); };
      document.head.appendChild(s);
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Wire autocomplete after Maps ready + input mounted ──────────────────
  useEffect(() => {
    if (!mapsReady || !addressEl) return;
    const g = (window as any).google;
    if (!g?.maps?.places?.Autocomplete) return;
    const ac = new g.maps.places.Autocomplete(addressEl, {
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
    // Also drop Google's injected .pac-container for THIS instance, otherwise
    // each remount leaves an orphaned dropdown behind.
    return () => {
      g.maps.event.removeListener(listener);
      g.maps.event.clearInstanceListeners(ac);
    };
  }, [mapsReady, addressEl]);

  // ── Geocode helper for client-loaded addresses ───────────────────────────
  async function geocodeVerify(addressStr: string) {
    const key = mapsKeyRef.current || (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || "";
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
        // [hourly-included-addons 2026-07-27] On hourly/simplified scopes the
        // price is strictly hours × rate — add-ons are performed within the
        // hourly rate at NO extra charge. We still track the office's add-on
        // selection in `state.addon_ids` (so it rides onto the quote/job via
        // buildPayload's extraSelectedAddons as amount:0 rows), but we must NOT
        // send those ids to /calculate or the engine would add their price and
        // inflate final_total. Strip them here so toggling an included add-on
        // never moves the total.
        const isHourlyMethod = method === "hourly" || method === "simplified";
        const counterAddonIds = isHourlyMethod ? [] : Object.keys(state.addonQtys).filter(k => (state.addonQtys[Number(k)] ?? 0) > 0).map(Number);
        const allAddonIds = isHourlyMethod ? [] : [...new Set([...state.addon_ids, ...counterAddonIds])];
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
        // [rate-override 2026-07-11] Per-quote $/hr override — the engine recomputes
        // base_price = hours × override (pricing.ts already supports this param).
        if (state.hourlyRateOverride != null && state.hourlyRateOverride > 0) body.hourly_rate_override = state.hourlyRateOverride;
        // [combo-optional] Tell the engine which bundles the office toggled off
        // so their discount isn't applied (they're still returned for the UI).
        if (state.disabledBundleIds && state.disabledBundleIds.length > 0) body.disabled_bundle_ids = state.disabledBundleIds;
        const result = await apiFetch("/api/pricing/calculate", { method: "POST", body });
        setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, calc: result, calcLoading: false } : s));
      } catch {
        setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, calcLoading: false } : s));
      }
    }, delay);
  }

  // [hourly-recurring-label] Display name for a selected scope. Prefers the
  // per-scope displayLabel override (set when the Recurring hourly sub-type is
  // chosen) so the office never sees the misleading "Hourly Standard Cleaning"
  // when they picked Recurring. Falls back to the real scope name.
  function scopeLabel(s: SelectedScopeState): string {
    return s.displayLabel ?? scopes.find(sc => sc.id === s.scope_id)?.name ?? "Service";
  }

  // ── Toggle scope selection ────────────────────────────────────────────────
  async function toggleScope(scope: PricingScope, initialState?: { frequency?: string; hours?: number; addon_ids?: number[]; addon_meta?: any[]; hourly_rate_override?: number | null; displayLabel?: string; adjPlus?: number; adjPlusReason?: string; adjMinus?: number; adjMinusReason?: string }) {
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
      // [counter-unify 2026-05-27] Seed qty for any counter-style addon that came
      // in via addon_ids on quote restore, so the counter shows the real count
      // instead of 0. [addon-qty 2026-07-28] Prefer the saved qty from the quote
      // JSON row (now persisted) and fall back to 1 for older drafts.
      const savedMeta: Record<number, any> = {};
      for (const m of initialState?.addon_meta ?? []) { if (m && m.id != null) savedMeta[Number(m.id)] = m; }
      const seededQtys: Record<number, number> = {};
      const seededRecurring: Record<number, boolean> = {};
      for (const aid of initialState?.addon_ids ?? []) {
        const a = (addons as PricingAddon[]).find(x => x.id === aid);
        const meta = savedMeta[aid];
        if (a && !isPercentAddon(a) && isCounterAddon(a.name)) {
          const savedQty = meta && meta.qty != null ? Math.max(1, parseInt(String(meta.qty), 10) || 1) : 1;
          seededQtys[aid] = savedQty;
        }
        // every_visit === false → office chose "first visit only"; anything else
        // defaults to every visit, so only persist the explicit false.
        if (meta && meta.every_visit === false) seededRecurring[aid] = false;
      }
      const newState: SelectedScopeState = {
        scope_id: scope.id,
        frequency: initialState?.frequency ?? defaultFreq?.frequency ?? "",
        hours: initialState?.hours ?? 0,
        hoursOverrideSet: false,
        addon_ids: initialState?.addon_ids ?? [],
        addonQtys: seededQtys,
        addonRecurring: seededRecurring,
        // [discount-rehydrate 2026-07-27] Restore the saved per-scope manual
        // adjustments (Add charge / Discount) so reopening a quote doesn't wipe
        // the discount the office already entered.
        adjPlus: initialState?.adjPlus ?? 0,
        adjPlusReason: initialState?.adjPlusReason ?? "",
        adjMinus: initialState?.adjMinus ?? 0,
        adjMinusReason: initialState?.adjMinusReason ?? "",
        disabledBundleIds: [],
        hourlyRateOverride: initialState?.hourly_rate_override ?? null,
        frequencies: freqs as PricingFrequency[],
        addons: addons as PricingAddon[],
        calc: null,
        calcLoading: false,
        expanded: true,
        displayLabel: initialState?.displayLabel,
      };
      setSelectedScopes(prev => [...prev, newState]);
      setTimeout(() => recalcScopeById(scope.id, 100), 50);
    } catch {
      setSelectedScopes(prev => [...prev, {
        scope_id: scope.id, frequency: initialState?.frequency ?? "", hours: initialState?.hours ?? 0,
        hoursOverrideSet: false, addon_ids: initialState?.addon_ids ?? [],
        addonQtys: {}, addonRecurring: {},
        adjPlus: initialState?.adjPlus ?? 0, adjPlusReason: initialState?.adjPlusReason ?? "",
        adjMinus: initialState?.adjMinus ?? 0, adjMinusReason: initialState?.adjMinusReason ?? "",
        disabledBundleIds: [],
        hourlyRateOverride: initialState?.hourly_rate_override ?? null,
        frequencies: [], addons: [],
        calc: null, calcLoading: false, expanded: true,
        displayLabel: initialState?.displayLabel,
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

  // [rate-override 2026-07-11] Set/clear the per-quote $/hr override, then
  // recompute so the line total reflects the new rate. null clears it back to
  // the configured rate.
  function updateScopeRate(scopeId: number, rate: number | null) {
    const clean = rate != null && isFinite(rate) && rate > 0 ? rate : null;
    setSelectedScopes(prev => prev.map(s => s.scope_id === scopeId ? { ...s, hourlyRateOverride: clean } : s));
    setTimeout(() => recalcScopeById(scopeId), 50);
  }

  function resetScopeHours(scopeId: number) {
    const s = selectedScopes.find(sc => sc.scope_id === scopeId);
    const calcHours = s?.calc?.base_hours ?? 0;
    setSelectedScopes(prev => prev.map(sc => sc.scope_id === scopeId ? { ...sc, hours: calcHours, hoursOverrideSet: false } : sc));
    setTimeout(() => recalcScopeById(scopeId), 50);
  }

  // [custom-recurring] Shared flexible-recurrence builder. Rendered under BOTH
  // the Recurring group's "Custom" card and the Hourly "Custom…" cadence. It's
  // pure UI over the `customRec` state; convert() ships that state as
  // `custom_recurrence` and the server maps it onto recurring_schedules columns.
  // Pricing is NOT touched here — each visit stays at the scope's recurring rate.
  function renderCustomBuilder(
    rec: typeof customRec = customRec,
    setRec: typeof setCustomRec = setCustomRec,
  ) {
    const r = rec;
    const set = (patch: Partial<typeof customRec>) => setRec(prev => ({ ...prev, ...patch }));
    const miniSel: React.CSSProperties = {
      padding: "6px 8px", borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFF",
      fontSize: 13, color: "#1A1917", fontFamily: FF, cursor: "pointer",
    };
    return (
      <div style={{ marginTop: 10, padding: "12px 14px", border: "1px solid #E5E2DC", borderRadius: 10, background: "#FBFDFC" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#00A886", letterSpacing: "0.06em", marginBottom: 10, fontFamily: FF }}>CUSTOM SCHEDULE</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "#4A4845", fontFamily: FF }}>Repeat every</span>
          <input
            type="number" min={1} max={52} value={r.interval}
            onChange={e => set({ interval: Math.min(52, Math.max(1, parseInt(e.target.value) || 1)) })}
            style={{ width: 56, padding: "6px 8px", borderRadius: 8, border: "1px solid #E5E2DC", fontSize: 13, fontFamily: FF, textAlign: "center" }}
          />
          <select value={r.unit} onChange={e => set({ unit: e.target.value as "weeks" | "months" })} style={miniSel}>
            <option value="weeks">{r.interval === 1 ? "week" : "weeks"}</option>
            <option value="months">{r.interval === 1 ? "month" : "months"}</option>
          </select>
          {r.unit === "months" ? (
            <>
              <span style={{ fontSize: 13, color: "#4A4845", fontFamily: FF }}>on the</span>
              <select value={r.weekOfMonth} onChange={e => set({ weekOfMonth: parseInt(e.target.value) })} style={miniSel}>
                {WEEK_OF_MONTH.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
              </select>
            </>
          ) : (
            <span style={{ fontSize: 13, color: "#4A4845", fontFamily: FF }}>on</span>
          )}
          <select value={r.weekday} onChange={e => set({ weekday: parseInt(e.target.value) })} style={miniSel}>
            {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
        </div>
        {/* [residential-custom-recurrence 2026-07-27] Maribel: "for residential
            there's no custom option for recurrence such as every 5, 6, 7 weeks."
            Weekly / bi-weekly / every-3 / every-4(monthly) all have dedicated
            scope cards; 5–8 weeks did not. The number input above already accepts
            any 1–52 interval and round-trips as frequency='custom' +
            custom_frequency_weeks — these chips just surface the named cadences as
            one tap. Weeks-only (months uses the week-of-month picker instead). */}
        {r.unit === "weeks" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            <span style={{ fontSize: 11.5, color: "#9E9B94", fontFamily: FF }}>Quick pick:</span>
            {[5, 6, 7, 8].map(n => {
              const active = r.interval === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => set({ interval: n, unit: "weeks" })}
                  style={{
                    padding: "4px 10px", borderRadius: 999, cursor: "pointer", fontFamily: FF,
                    fontSize: 12, fontWeight: 600,
                    border: active ? "1.5px solid var(--brand)" : "1px solid #E5E2DC",
                    background: active ? "#EAF9F4" : "#FFFFFF",
                    color: active ? "#0A6E5A" : "#4A4845",
                  }}
                >
                  {n} weeks
                </button>
              );
            })}
          </div>
        )}
        <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 600, color: "#00A886", fontFamily: FF }}>↻ {customRecSummary(r)}</div>
        <div style={{ marginTop: 6, fontSize: 11.5, color: "#9E9B94", fontFamily: FF, lineHeight: 1.5 }}>
          Per-visit price = your standard recurring rate. Custom only changes when visits recur.
        </div>
      </div>
    );
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

  // [combo-optional] Toggle a bundle (e.g. "Appliance Combo") on/off for a
  // scope, then recalc so the total reflects whether its discount applies.
  function toggleBundle(scopeId: number, bundleId: number) {
    setSelectedScopes(prev => prev.map(s => {
      if (s.scope_id !== scopeId) return s;
      const off = s.disabledBundleIds.includes(bundleId);
      return { ...s, disabledBundleIds: off ? s.disabledBundleIds.filter(id => id !== bundleId) : [...s.disabledBundleIds, bundleId] };
    }));
    recalcScopeById(scopeId, 0);
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
    // [draft-persist 2026-07-09] A draft saved BEFORE the Review step (where the
    // office picks finalScopeId) used to null out scope/base/total/add-ons when
    // 2+ scopes were selected, because primaryScopeId resolved to null and every
    // pricing field derives from it. That produced the $0.00 reopened draft.
    // Fall back to the first selected scope so a draft always persists real
    // pricing; the remaining scopes still ride along as alternate_options below.
    const primaryScopeId = finalScopeId ?? (selectedScopes.length >= 1 ? selectedScopes[0].scope_id : null);
    const primaryScopeState = selectedScopes.find(s => s.scope_id === primaryScopeId);
    const cr = primaryScopeState?.calc ?? null;
    // [draft-addons 2026-07-09] Persist the FULL add-on selection, not just the
    // priced breakdown. Time-based add-ons (Oven, Cabinets, Basement…) are
    // price_type='time_only'; the pricing engine omits them from addon_breakdown
    // (their cost folds into hours), so they were dropped on save and lost on
    // reopen even for a single hourly scope. Carry them as zero-amount rows keyed
    // by id so reopen restores the selection and convert keeps them as job
    // add-ons. No double-count: amount=0 and the time already lives in
    // estimated_hours.
    // [addon-qty+recurrence 2026-07-28] Carry a real per-add-on quantity and the
    // first-visit/every-visit flag through persist → convert → job_add_ons /
    // recurring_schedule_add_ons. `qty` mirrors the counter the office set
    // (default 1); `every_visit` is true unless the office chose "first visit
    // only" on a recurring scope. amount stays the priced TOTAL (qty × unit, as
    // the engine folds it) so downstream can derive per-unit = amount / qty.
    const qtyOf = (id: number) => primaryScopeState?.addonQtys[id] ?? 1;
    const everyVisitOf = (id: number) => primaryScopeState?.addonRecurring[id] !== false;
    const pricedAddons = cr?.addon_breakdown ?? [];
    const pricedAddonIds = new Set(pricedAddons.map(a => a.id));
    // Enrich real priced rows with qty + recurrence; leave the synthetic Manual
    // Adjustment row (id -1) untouched.
    const enrichedPriced = pricedAddons.map(a => a.id > 0 ? { ...a, qty: qtyOf(a.id), every_visit: everyVisitOf(a.id) } : a);
    // Selected = checkbox add-ons (addon_ids) ∪ counter add-ons with qty > 0
    // (hourly ovens etc. live only in addonQtys, never addon_ids).
    const selectedAddonIds = new Set<number>([
      ...(primaryScopeState?.addon_ids ?? []),
      ...Object.entries(primaryScopeState?.addonQtys ?? {}).filter(([, q]) => (q as number) > 0).map(([k]) => Number(k)),
    ]);
    const extraSelectedAddons = [...selectedAddonIds]
      .filter(id => !pricedAddonIds.has(id))
      .map(id => {
        const meta = primaryScopeState?.addons.find(a => a.id === id);
        return { id, name: meta?.name ?? "", amount: 0, price_type: meta?.price_type ?? "time_only", qty: qtyOf(id), every_visit: everyVisitOf(id) };
      });
    const addonsPersist = [...enrichedPriced, ...extraSelectedAddons];
    const client = clientLoaded;
    const alternateOptions = selectedScopes
      .filter(s => s.scope_id !== primaryScopeId)
      .map(s => ({
        scope_id: s.scope_id,
        scope_name: scopeLabel(s),
        frequency: s.frequency,
        addon_ids: s.addon_ids,
        // Include this scope's manual price adjustments so the saved total
        // matches the preview (the engine's final_total excludes them).
        total: s.calc?.final_total != null ? s.calc.final_total + (s.adjPlus || 0) - (s.adjMinus || 0) : null,
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
      addons: addonsPersist,
      discount_code: discountCode || null,
      base_price: quickBookPrice != null ? String(quickBookPrice) : (cr ? String(cr.base_price) : null),
      addons_total: cr ? String(cr.addons_total) : "0",
      discount_amount: cr ? String(cr.discount_amount) : "0",
      total_price: quickBookPrice != null ? String(quickBookPrice) : (cr ? String(cr.final_total + (primaryScopeState?.adjPlus || 0) - (primaryScopeState?.adjMinus || 0)) : null),
      // [addon-hours 2026-06-04] Persist TOTAL hours (base + add-on time-adds)
      // so Hourly/Time-Add add-ons (Oven, Cabinets, Basement, etc.) flow into
      // the booked job's allowed hours. Was base_hours, which silently dropped
      // every add-on's time — the job came out under-budgeted on the schedule.
      estimated_hours: cr ? String(cr.total_hours ?? cr.base_hours) : primaryScopeState?.hours ? String(primaryScopeState.hours) : null,
      hourly_rate: cr ? String(cr.hourly_rate) : null,
      // [rate-override 2026-07-11] The EXPLICIT per-quote $/hr override (null when
      // not overridden), stored on its own so it round-trips on edit + convert
      // without being confused with the computed effective rate.
      hourly_rate_override: primaryScopeState?.hourlyRateOverride != null
        ? String(primaryScopeState.hourlyRateOverride) : null,
      notes: notes || null,
      internal_memo: internalMemo || null,
      office_notes: officeMemo || null,
      call_notes: callNotes || null,
      unit_suite: unitSuite || null,
      referral_source: referralSource || null,
      // [multi-option-send 2026-07-25] The stored alternate_options ARE what the
      // client's booking page renders. When the office chose "send one option
      // only", drop them so the client sees just the recommended scope. Drafts
      // always keep every scope so reopening a parked quote is lossless — the
      // send-mode choice only bites on the sent/converted row.
      alternate_options: (alternateOptions.length > 0 && (sendBoth || status === "draft")) ? alternateOptions : null,
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
    // [referral-required 2026-07-23] A new customer can't leave without us
    // knowing how they found us. The dashboard's "How they heard about us" card
    // is only as good as this field, and it was optional — so ~90% of
    // office-keyed quotes had it blank and the card read almost entirely "Not
    // asked". Gated to NEW leads only: an existing client already answered this
    // the first time, and re-asking would be re-prompting for a fact we have.
    // Drafts are exempt so a half-finished quote can still be parked.
    if (!selectedClientId && !referralSource && status !== "draft") {
      toast.error("Pick how they heard about us before sending.");
      return;
    }
    setSaving(true);
    try {
      // [edit-after-sent 2026-07-16] Plain "Save" (status="draft") on a quote that
      // was ALREADY sent/viewed/accepted must NOT silently downgrade it back to
      // draft — the office is just correcting a mistake. Preserve the existing
      // status and skip re-sending. "Save & Send" (status="sent") still re-sends
      // the corrected quote. Only applies when editing (not a convert flow).
      const originalStatus = isEdit ? (existingQuote?.status as string | undefined) : undefined;
      const preserveStatus = status === "draft" && !thenConvert && originalStatus
        && originalStatus !== "draft";
      const effectiveStatus = preserveStatus ? originalStatus! : status;
      const payload = buildPayload(effectiveStatus);
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
      if (thenConvert) {
        // If the save didn't return an id we can't convert — say so instead
        // of silently falling through to the "saved as draft" branch (which
        // looked like "nothing happened" to the office).
        if (!savedId) {
          toast.error("Couldn't convert — the quote didn't save. Try again.");
          return;
        }
        const convertRes: any = await apiFetch(`/api/quotes/${savedId}/convert`, {
          method: "POST",
          body: {
            scheduled_date: selectedDate || undefined,
            scheduled_time: selectedTime || undefined,
            // Primary = first selected (mirrored onto jobs.assigned_user_id);
            // team_user_ids carries the full crew so the convert writes a
            // job_technicians row per cleaner.
            assigned_user_id: selectedTechIds[0] || undefined,
            team_user_ids: selectedTechIds,
            // [lead-card-capture 2026-08-08] A card taken on the call for a NEW
            // customer rides along here; the server attaches it once it has
            // materialized the client. Absent for existing clients — theirs saved
            // immediately via /api/square/clients/:id/save-card.
            square_card_token: pendingCardToken || undefined,
            // [custom-recurring] When the office chose a flexible pattern (Recurring
            // "Custom" card OR Hourly "Custom…" cadence — separate, independent
            // states), ship it so the server maps it onto the recurring_schedules
            // columns instead of the baked cadence. Hourly wins if both are open.
            custom_recurrence: (() => {
              const cr = hourlyCustomOpen ? hourlyCustomRec : (customRecOpen ? customRec : null);
              return cr ? { interval: cr.interval, unit: cr.unit, weekday: cr.weekday, week_of_month: cr.weekOfMonth } : undefined;
            })(),
          },
        });
        // [lead-card-capture 2026-08-08] If a card rode along with the convert,
        // say what happened to it. A silent failure here is the worst case: the
        // office believes a new customer is on file and only finds out weeks
        // later when the first invoice can't be charged.
        const cardResult = convertRes?.card_saved;
        if (pendingCardToken && cardResult && !cardResult.ok) {
          toast.error(`Job booked, but the card didn't save: ${cardResult.error || "unknown error"}. Add it from the customer's profile.`);
        } else if (pendingCardToken && cardResult?.ok) {
          toast.success(`Quote converted to job. Card ending ${cardResult.last4 ?? "••••"} saved on file.`);
        } else {
          toast.success("Quote converted to job.");
        }
        setPendingCardToken(null);
        navigate(selectedDate ? `/dispatch?date=${selectedDate}` : "/jobs");
      } else if (status === "sent") {
        // Saving with status "sent" only persists the row — it does NOT deliver
        // the quote or advance the lead. The canonical /send endpoint enrolls
        // the quote-followup cadence (which actually emails + texts the customer
        // via the tenant sender) and advances the lead to "Quoted". Without this
        // call the customer received nothing and the lead stayed "Needs
        // Contacted". Best-effort so a comms hiccup doesn't lose the saved quote.
        if (savedId) {
          try {
            await apiFetch(`/api/quotes/${savedId}/send`, { method: "POST" });
          } catch (sendErr) {
            console.error("Quote /send failed:", sendErr);
            toast.error("Quote saved, but sending failed — open it and try Send again.");
            navigate(`/quotes/${savedId}`);
            return;
          }
        }
        toast.success(isEdit ? "Quote sent" : "Quote created and sent.");
        navigate(`/quotes/${savedId}`);
      } else {
        toast.success(preserveStatus ? "Quote updated" : "Quote saved as draft");
        navigate(`/quotes/${savedId}`);
      }
    } catch (e: any) {
      // Surface the real reason instead of a generic message, so a failed
      // save/convert is self-diagnosing on the live site. apiFetch throws
      // Error(responseBodyText); that body is often JSON ({error|message}).
      let msg = String(e?.message || "").trim();
      try { const j = JSON.parse(msg); msg = j.message || j.error || msg; } catch { /* plain text body */ }
      toast.error(msg ? `Couldn't save: ${msg.slice(0, 200)}` : "Failed to save quote");
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
          // [half-baths 2026-08-12] Prefill the half-bath count from the saved
          // property too, so a repeat quote for an existing client doesn't
          // quietly reset it to zero.
          if (data.property.half_baths > 0) setHalfBaths(data.property.half_baths);
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
    if (preferredTech) setSelectedTechIds([preferredTech.id]);
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

  // Shared Square card-capture modal — rendered in both the mobile and desktop
  // return trees so "Save card on file now" works from either Review layout.
  const cardModalEl = cardModalOpen ? (
    <div onClick={() => setCardModalOpen(false)}
      style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 14, width: "100%", maxWidth: 420, padding: 22, fontFamily: FF, boxShadow: "0 20px 50px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1917" }}>Save card on file</div>
          <button type="button" onClick={() => setCardModalOpen(false)} style={{ border: "none", background: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 13, color: "#6B6860", marginBottom: 16 }}>
          {/* [lead-card-capture 2026-08-08] A lead has no client row, so fall
              back to the name typed on the quote rather than "This client". */}
          {selectedClient
            ? `${selectedClient.first_name} ${selectedClient.last_name}`
            : (`${leadFirstName} ${leadLastName}`.trim() || "This customer")} — card is stored securely with Square, not on our servers.
        </div>
        {cardSaved ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#0F7A63", fontWeight: 600, padding: "12px 0" }}>
            <CheckCircle2 size={18} />
            {selectedClientId ? "Card saved on file." : "Card captured — saves when you book."}
          </div>
        ) : sqCfgLoading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#6B6860", padding: "12px 0" }}>
            <Loader2 size={15} className="animate-spin" /> Loading secure card form…
          </div>
        ) : sqCfg?.configured && sqCfg.applicationId && sqCfg.locationId ? (
          <SquareCardForm
            applicationId={sqCfg.applicationId}
            locationId={sqCfg.locationId}
            environment={sqCfg.environment}
            onToken={saveSquareCard}
            submitLabel="Save card on file"
            busyLabel="Saving…"
          />
        ) : (
          <div style={{ fontSize: 13, color: "#BA7517", background: "#FDF3E4", border: "1px solid #F2DFB8", borderRadius: 8, padding: "10px 12px" }}>
            Square card capture isn't configured yet. Use "Text link" or "Email link" to have the customer add their card, or save it from Square directly.
          </div>
        )}
      </div>
    </div>
  ) : null;

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
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", border: "2px solid var(--brand)", borderRadius: 10, background: "#EFEFF2" }}>
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
                      <div onClick={() => { clearClient(); setMobileLeadForm(true); setMobileClientDropdown(false); setMobileClientSearch(""); mobileSearchInputRef.current?.blur(); }} style={{ padding: "12px 14px", borderBottom: "1px solid #F0EEE9", cursor: "pointer", fontSize: 13, color: "#6B6860" }}>+ Enter new client / lead info</div>
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

            {/* New-client / lead entry — mobile parity with desktop Customer Info.
                Shows when no existing client is selected and the user opts to
                enter a new prospect (or has already typed lead details). */}
            {!selectedClient && (mobileLeadForm || leadFirstName || leadLastName || leadEmail || leadPhone || address) && (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: FF }}>New Client</div>
                  <button onClick={() => { setMobileLeadForm(false); setLeadFirstName(""); setLeadLastName(""); setLeadEmail(""); setLeadPhone(""); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", fontSize: 12, fontFamily: FF }}>Clear</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <input value={leadFirstName} onChange={e => setLeadFirstName(e.target.value)} placeholder="First name" autoComplete="off"
                      style={{ width: "100%", boxSizing: "border-box", height: 48, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 16, padding: "0 14px", fontFamily: FF }} />
                    <input value={leadLastName} onChange={e => setLeadLastName(e.target.value)} placeholder="Last name" autoComplete="off"
                      style={{ width: "100%", boxSizing: "border-box", height: 48, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 16, padding: "0 14px", fontFamily: FF }} />
                  </div>
                  <input value={leadEmail} onChange={e => setLeadEmail(e.target.value)} onBlur={e => handleEmailBlur(e.target.value)} placeholder="Email" type="email" inputMode="email" autoComplete="off"
                    style={{ width: "100%", boxSizing: "border-box", height: 48, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 16, padding: "0 14px", fontFamily: FF }} />
                  <input value={leadPhone} onChange={e => setLeadPhone(e.target.value)} onBlur={e => handlePhoneBlur(e.target.value)} placeholder="Phone" type="tel" inputMode="tel" autoComplete="off"
                    style={{ width: "100%", boxSizing: "border-box", height: 48, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 16, padding: "0 14px", fontFamily: FF }} />
                  <input value={address} onChange={e => setAddress(e.target.value)} placeholder="Service address" autoComplete="off"
                    style={{ width: "100%", boxSizing: "border-box", height: 48, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 16, padding: "0 14px", fontFamily: FF }} />
                  <select value={referralSource} onChange={e => setReferralSource(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", height: 48, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 16, padding: "0 12px", fontFamily: FF, background: "#FFF" }}>
                    {/* [leadsource-unify 2026-07-28] Options are the tenant's
                        configured acquisition_sources (Settings), so this select
                        matches Settings and the booking widget. The stored value
                        is the source slug. Both this select and the Review-step
                        one below share the same list. */}
                    <option value="">How did they hear about us?</option>
                    {referralOptions.map(s => <option key={s.slug} value={s.slug}>{s.name}</option>)}
                  </select>
                </div>
              </div>
            )}

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
                        <button key={s.id} onClick={() => toggleScope(s)} style={{ padding: "14px 12px", border: `2px solid ${isSel ? "var(--brand)" : "#E5E2DC"}`, borderRadius: 10, background: isSel ? "#EFEFF2" : "#FFF", textAlign: "center", cursor: "pointer", fontFamily: FF, minHeight: 64, fontSize: 13 }}>
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
                {/* [rentcast 2026-07-27] Reference only — shows what RentCast has for
                    this address so the office doesn't open Google in another tab. */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={lookupRentcast} disabled={rcLoading}
                    style={{ padding: "6px 12px", border: "1px solid #E5E2DC", borderRadius: 8, background: "#FFF", color: "#6B6860", fontSize: 12, fontWeight: 600, cursor: rcLoading ? "default" : "pointer", fontFamily: FF }}>
                    {rcLoading ? "Checking RentCast…" : "Check RentCast for sq ft"}
                  </button>
                  {rcResult && (
                    <span style={{ fontSize: 12.5, color: rcResult.configured === false ? "#9E9B94" : rcResult.found ? "#0A6E5A" : "#B45309" }}>
                      {rcResult.configured === false
                        ? "RentCast isn't set up yet."
                        : rcResult.no_address
                          ? "Enter the address first."
                          : rcResult.found
                            ? `RentCast has ${rcResult.square_footage ? Number(rcResult.square_footage).toLocaleString() + " sq ft" : "no sq ft on file"}${rcResult.bedrooms != null ? ` · ${rcResult.bedrooms} bd` : ""}${rcResult.bathrooms != null ? ` · ${rcResult.bathrooms} ba` : ""}`
                            : "RentCast has no record for this address."}
                    </span>
                  )}
                </div>
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
                    <button key={d.value} onClick={() => setDirtLevel(d.value)} style={{ flex: 1, minWidth: 90, padding: "8px 6px", border: dirtLevel === d.value ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", borderRadius: 8, background: dirtLevel === d.value ? "var(--brand-soft)" : "#FFF", fontSize: 12, fontWeight: dirtLevel === d.value ? 600 : 400, color: dirtLevel === d.value ? "var(--brand)" : "#6B6860", cursor: "pointer", fontFamily: FF }}>
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
              const scopeIsHourly = scope.pricing_method === "hourly" || scope.pricing_method === "simplified";
              return (
                <div key={s.scope_id} style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", marginBottom: 12 }}>{scopeLabel(s)}</div>
                  {s.frequencies.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Frequency</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {s.frequencies.map(f => (
                          <button key={f.id} onClick={() => updateScopeFrequency(s.scope_id, f.frequency)} style={{ padding: "6px 14px", borderRadius: 6, border: s.frequency === f.frequency ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: s.frequency === f.frequency ? "var(--brand-soft)" : "#FFF", color: s.frequency === f.frequency ? "var(--brand)" : "#6B6860", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FF }}>
                            {f.label || f.frequency}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {activeAddons.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Add-ons</div>
                      {scopeIsHourly && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#E9F6F1", border: "1px solid #CDE9E0", color: "#0F7A63", borderRadius: 9, padding: "8px 11px", fontSize: 11.5, fontWeight: 600, marginBottom: 10, fontFamily: FF }}>
                          <Check size={15} strokeWidth={2.2} style={{ flexShrink: 0 }} />
                          <span>Included in the hourly rate — no extra charge.</span>
                        </div>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {activeAddons.map(a => {
                          const isPct = isPercentAddon(a);
                          const isSel = s.addon_ids.includes(a.id);
                          const clay = isPct && !scopeIsHourly;
                          const chipBg = clay ? "#F3ECDD" : "var(--brand-dim)";
                          const chipColor = clay ? "#8A6D2E" : "#0F7A63";
                          const selBorder = clay ? "#CBB37A" : "var(--brand)";
                          const selBg = clay ? "#FBF6EC" : "var(--brand-soft)";
                          const scopeIsRecurring = isRecurringFrequency(s.frequency);
                          const everyVisit = s.addonRecurring[a.id] !== false;
                          return (
                            <div key={a.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 11px", borderRadius: 10, border: `1px solid ${isSel ? selBorder : "#E5E2DC"}`, background: isSel ? selBg : "#FFF" }}>
                              <label style={{ display: "flex", alignItems: "center", gap: 11, cursor: "pointer" }}>
                                <span style={{ flex: "none", width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", background: chipBg, color: chipColor }}>
                                  <AddonIcon name={a.name} size={18} color={chipColor} />
                                </span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{a.name}</div>
                                  <div style={{ fontSize: 11, fontFamily: FF, color: scopeIsHourly ? "#0F7A63" : "#6B6860", fontWeight: scopeIsHourly ? 600 : 400 }}>{scopeIsHourly ? "Included" : addonDisplayPrice(a)}</div>
                                </div>
                                <input type="checkbox" checked={isSel} onChange={e => updateScopeAddon(s.scope_id, a.id, e.target.checked)} style={{ width: 18, height: 18, flexShrink: 0 }} />
                              </label>
                              {/* [addon-recurrence 2026-07-28] First visit / Every visit — recurring scopes only, once selected. */}
                              {isSel && scopeIsRecurring && (
                                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 45 }}>
                                  {([{ key: true, label: "Every visit" }, { key: false, label: "First visit only" }] as const).map(opt => {
                                    const on = everyVisit === opt.key;
                                    return (
                                      <button key={String(opt.key)} type="button"
                                        onClick={() => updateScopeAddonRecurring(s.scope_id, a.id, opt.key)}
                                        style={{ fontSize: 10.5, fontWeight: on ? 700 : 500, fontFamily: FF, color: on ? "var(--brand)" : "#6B6860", border: `1px solid ${on ? "var(--brand)" : "#E5E2DC"}`, background: on ? "var(--brand-soft)" : "#FFF", borderRadius: 20, padding: "3px 10px", cursor: "pointer" }}>
                                        {opt.label}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {activeAddons.length === 0 && s.frequencies.length === 0 && (
                    <div style={{ fontSize: 13, color: "#9E9B94" }}>{scopeIsHourly ? "Included · no extra charge" : "No add-ons available for this service."}</div>
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
                        <span style={{ fontSize: 14, color: "#1A1917" }}>{scopeLabel(s)}</span>
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
            {(sqft > 0 || bedrooms > 0 || bathrooms > 0 || rcResult?.found) && (
              <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Property</div>
                {(sqft > 0 || bedrooms > 0 || bathrooms > 0) && (
                  <div style={{ fontSize: 14, color: "#6B6860" }}>
                    {[sqft > 0 && `${sqft} sqft`, bedrooms > 0 && `${bedrooms} bed`, bathrooms > 0 && `${bathrooms} bath`, halfBaths > 0 && `${halfBaths} half bath`, pets > 0 && `${pets} pet${pets > 1 ? "s" : ""}`].filter(Boolean).join(" · ")}
                  </div>
                )}
                {/* [rentcast-carry 2026-07-28] RentCast reference carried onto Review, reference only. */}
                {rcResult?.found && <div style={{ marginTop: (sqft > 0 || bedrooms > 0 || bathrooms > 0) ? 6 : 0 }}><RentcastRef rc={rcResult} /></div>}
              </div>
            )}
            {/* Card on file (Square) */}
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Payment Method</div>
              {selectedClientId ? (
                cardSaved ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#0F7A63", fontWeight: 600 }}>
                    <CheckCircle2 size={16} /> Card saved on file.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <button type="button" onClick={openCardModal}
                      style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%", padding: "12px", borderRadius: 8, border: "none", background: "var(--brand)", color: "#FFF", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
                      <CreditCard size={16} /> Save card on file now
                    </button>
                    <div style={{ fontSize: 12, color: "#9E9B94" }}>Or send a link for the customer to add it:</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input value={cardLinkPhone} onChange={e => { cardLinkPhoneEdited.current = true; setCardLinkPhone(e.target.value); if (linkSent === "sms") setLinkSent(null); }}
                        placeholder="Mobile number" type="tel" inputMode="tel"
                        style={{ flex: 1, minWidth: 0, height: 42, border: "1px solid #E5E2DC", borderRadius: 8, padding: "0 12px", fontSize: 14, fontFamily: FF, outline: "none", background: "#FFF" }} />
                      <button type="button" onClick={() => sendCardLink("sms")} disabled={linkSending !== null}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "0 14px", borderRadius: 8, border: "1px solid #E5E2DC", background: linkSent === "sms" ? "#EAF9F4" : "#F7F6F3", color: "#1A1917", fontSize: 13, fontWeight: 600, cursor: linkSending ? "default" : "pointer", fontFamily: FF, whiteSpace: "nowrap" }}>
                        {linkSending === "sms" ? <Loader2 size={14} className="animate-spin" /> : linkSent === "sms" ? <Check size={14} style={{ color: "#0F7A63" }} /> : null}
                        {linkSent === "sms" ? "Sent" : "Text"}
                      </button>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input value={cardLinkEmail} onChange={e => { cardLinkEmailEdited.current = true; setCardLinkEmail(e.target.value); if (linkSent === "email") setLinkSent(null); }}
                        placeholder="Email" type="email" inputMode="email"
                        style={{ flex: 1, minWidth: 0, height: 42, border: "1px solid #E5E2DC", borderRadius: 8, padding: "0 12px", fontSize: 14, fontFamily: FF, outline: "none", background: "#FFF" }} />
                      <button type="button" onClick={() => sendCardLink("email")} disabled={linkSending !== null}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "0 14px", borderRadius: 8, border: "1px solid #E5E2DC", background: linkSent === "email" ? "#EAF9F4" : "#F7F6F3", color: "#1A1917", fontSize: 13, fontWeight: 600, cursor: linkSending ? "default" : "pointer", fontFamily: FF, whiteSpace: "nowrap" }}>
                        {linkSending === "email" ? <Loader2 size={14} className="animate-spin" /> : linkSent === "email" ? <Check size={14} style={{ color: "#0F7A63" }} /> : null}
                        {linkSent === "email" ? "Sent" : "Email"}
                      </button>
                    </div>
                  </div>
                )
              ) : (
                <div style={{ fontSize: 13, color: "#9E9B94" }}>
                  Select an existing client to save a card on file — new leads can add one from their profile after converting.
                </div>
              )}
            </div>
          </div>
        )}
        {cardModalEl}

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
              style={{ height: 44, padding: "0 16px", background: "transparent", color: saving || selectedScopes.length === 0 ? "#E5E2DC" : "#1A1917", border: `1px solid ${saving || selectedScopes.length === 0 ? "#E5E2DC" : "#E5E2DC"}`, borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: saving || selectedScopes.length === 0 ? "default" : "pointer", fontFamily: FF }}
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
                style={{ height: 44, padding: "0 20px", background: saving || selectedScopes.length === 0 ? "#E5E2DC" : "var(--brand)", color: "#FFF", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: saving || selectedScopes.length === 0 ? "default" : "pointer", fontFamily: FF }}
              >
                {saving ? "Saving..." : "Save Quote"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // [referral-required-step 2026-07-25] New leads must answer "How did you
  // hear about us?" before leaving Customer Info. Existing clients already
  // answered, so they're exempt. Used to gate both the Next button and any
  // forward tab jump; returns false (and flags the field) when it should block.
  const referralMissing = !selectedClientId && !referralSource;
  function guardLeaveCustomerInfo(target: number): boolean {
    if (activeSection === 0 && target > 0 && referralMissing) {
      setReferralError(true);
      return false;
    }
    return true;
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
        <Button variant="ghost" size="sm" onClick={() => navigate(fromClientId ? `/customers/${fromClientId}` : "/quotes")} className="gap-1.5 text-[#6B6860]">
          <ArrowLeft className="w-4 h-4" /> {fromClientId ? "Back to Client" : "Back to Quotes"}
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

          {/* Sticky client context bar — shows on steps 1-4 so the team
              always knows who they're quoting without going back to step 1 */}
          {activeSection > 0 && (leadFirstName || clientLoaded) && (
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "10px 14px", marginBottom: 14, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 20px" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>
                {clientLoaded
                  ? `${clientLoaded.first_name ?? ""} ${clientLoaded.last_name ?? ""}`.trim() || clientLoaded.name
                  : `${leadFirstName} ${leadLastName}`.trim()}
              </span>
              {(leadPhone || clientLoaded?.phone) && (
                <span style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>
                  {leadPhone || clientLoaded?.phone}
                </span>
              )}
              {(leadEmail || clientLoaded?.email) && (
                <span style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>
                  {leadEmail || clientLoaded?.email}
                </span>
              )}
              {address && (
                <span style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>
                  {address}{zipCode ? `, ${zipCode}` : ""}
                </span>
              )}
              {zipZone && zipZone !== "uncovered" && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, fontFamily: FF, color: (zipZone as any).color }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: (zipZone as any).color, flexShrink: 0 }} />
                  {(zipZone as any).name}
                </span>
              )}
              <button
                onClick={() => setActiveSection(0)}
                style={{ marginLeft: "auto", fontSize: 11, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: FF, whiteSpace: "nowrap" }}
              >
                Edit
              </button>
            </div>
          )}

          {/* Step tabs */}
          <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
            {SECTION_LABELS.map((label, i) => {
              const Icon = SECTION_ICONS[i];
              const isActive = activeSection === i;
              return (
                <button key={i} onClick={() => { if (!guardLeaveCustomerInfo(i)) return; setActiveSection(i); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: FF, cursor: "pointer", border: "none", transition: "all 0.15s", background: isActive ? "var(--brand)" : "#F7F6F3", color: isActive ? "#FFF" : "#6B6860" }}>
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
                        width: "100%", height: 40, border: `1px solid ${clientDropdownOpen ? "var(--brand)" : "#E5E2DC"}`, borderRadius: 8, background: selectedClientId ? "#F7F6F3" : "#FFF",
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
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "#F7F6F3", borderBottom: "1px solid #E5E2DC", cursor: "pointer", fontSize: 13, color: "var(--brand)", fontWeight: 500, fontFamily: FF }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--brand-soft)")}
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
                          <div onClick={() => { clearClient(); setClientDropdownOpen(false); }} style={{ padding: "10px 14px", fontSize: 13, color: "var(--brand)", fontFamily: FF, cursor: "pointer", borderTop: "1px solid #F0EEE9" }}>
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
                            style={{ padding: "10px 14px", borderBottom: "1px solid #F0EEE9", cursor: "pointer" }}
                            onMouseEnter={e => (e.currentTarget.style.background = "#F7F6F3")}
                            onMouseLeave={e => (e.currentTarget.style.background = "#FFF")}
                          >
                            {/* Line 1: Name + Frequency badge */}
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                              <span style={{ fontSize: 14, fontWeight: 500, color: "#1A1917", fontFamily: FF }}>{c.first_name} {c.last_name}</span>
                              {freqLabel && (
                                <span style={{ fontSize: 10, fontWeight: 500, color: "#4A4845", background: "#F0EEE9", borderRadius: 10, padding: "2px 7px", flexShrink: 0, fontFamily: FF }}>{freqLabel}</span>
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
                  <div style={{ background: "var(--brand-soft)", border: "1px solid var(--brand)", borderRadius: 6, padding: "8px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>Returning client — {returningClient.name}</div>
                      {returningClient.address && <div style={{ fontSize: 12, color: "var(--brand)", marginTop: 2 }}>{returningClient.address}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                      <button onClick={applyReturningClient} style={{ fontSize: 12, fontWeight: 600, color: "#2F3646", background: "#EFEFF2", border: "none", cursor: "pointer", padding: "4px 10px", borderRadius: 4 }}>Use this client</button>
                      <button onClick={() => { setReturningClient(null); setReturningClientDismissed(true); }} style={{ fontSize: 12, color: "#6B6860", background: "none", border: "none", cursor: "pointer", padding: "4px 8px" }}>Not them</button>
                    </div>
                  </div>
                )}

                {/* Address + Zip */}
                <div className="flex gap-3">
                  <div className="flex-1">
                    <Label className="text-xs">Service Address</Label>
                    <input
                      ref={setAddressInputRef}
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

                {/* [rentcast 2026-07-27] Reference sq ft for the verified address,
                    auto-fetched on verify (see the effect near addressVerified).
                    Display only — never auto-fills the quote. Hidden entirely when
                    RentCast isn't configured (configured === false). */}
                {addressVerified === true && (rcLoading || (rcResult && rcResult.configured !== false)) && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontFamily: FF, color: "#6B6860" }}>
                    <span style={{ fontWeight: 600 }}>RentCast:</span>
                    {rcLoading
                      ? <span style={{ color: "#9E9B94" }}>checking sq ft…</span>
                      : rcResult.found
                        ? <span style={{ color: "#0A6E5A" }}>{rcResult.square_footage ? `${Number(rcResult.square_footage).toLocaleString()} sq ft` : "no sq ft on file"}{rcResult.bedrooms != null ? ` · ${rcResult.bedrooms} bd` : ""}{rcResult.bathrooms != null ? ` · ${rcResult.bathrooms} ba` : ""} <span style={{ color: "#9E9B94" }}>· reference only</span></span>
                        : <span style={{ color: "#9E9B94" }}>no record for this address</span>}
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
                      const isSel = selectedTechIds.includes(tech.id);
                      return (
                        <button key={tech.id} onClick={() => toggleTech(tech.id)}
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

                {/* How did you hear about us? — required for new leads */}
                {!selectedClientId && (
                  <div>
                    <Label className="text-xs">
                      How did you hear about us? <span style={{ color: "#C0392B" }}>*</span>
                    </Label>
                    <select
                      value={referralSource}
                      onChange={e => { setReferralSource(e.target.value); if (e.target.value) setReferralError(false); }}
                      className="mt-1 w-full rounded-md bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                      style={{ height: 36, border: referralError ? "1px solid #C0392B" : "1px solid hsl(var(--input))" }}
                    >
                      {/* Same Settings-configured list as the intake select
                          above — see the note there. Keep the two identical. */}
                      <option value="">Select…</option>
                      {referralOptions.map(s => <option key={s.slug} value={s.slug}>{s.name}</option>)}
                    </select>
                    {referralError && (
                      <span style={{ display: "block", marginTop: 5, fontSize: 11, color: "#C0392B", fontFamily: FF }}>
                        Pick how they heard about us to continue. Use “Other” if unknown.
                      </span>
                    )}
                  </div>
                )}

                {/* ── Preferred Tech — compact inline row ── */}
                {selectedClientId && preferredTech && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>Preferred:</span>
                    <button
                      onClick={() => toggleTech(preferredTech.id)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 14, fontSize: 12, fontWeight: selectedTechIds.includes(preferredTech.id) ? 600 : 400, border: selectedTechIds.includes(preferredTech.id) ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: selectedTechIds.includes(preferredTech.id) ? "#EAF9F4" : "#FFF", color: "#1A1917", cursor: "pointer", fontFamily: FF }}
                    >
                      <span style={{ width: 18, height: 18, borderRadius: "50%", background: selectedTechIds.includes(preferredTech.id) ? "var(--brand)" : "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFF", fontSize: 9, fontWeight: 700 }}>{preferredTech.full_name.charAt(0)}</span>
                      {preferredTech.full_name}
                      {selectedTechIds.includes(preferredTech.id) && <Check style={{ width: 12, height: 12, color: "var(--brand)" }} />}
                    </button>
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    onClick={() => { if (!guardLeaveCustomerInfo(1)) return; setActiveSection(1); }}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 8,
                      padding: "0 24px", height: 46, borderRadius: 10, border: "none",
                      fontSize: 15, fontWeight: 700, fontFamily: FF,
                      background: referralMissing ? "#B8B4AC" : "var(--brand)", color: "#FFF",
                      cursor: referralMissing ? "not-allowed" : "pointer",
                      boxShadow: referralMissing ? "none" : "0 2px 8px rgba(0,201,160,0.35)", transition: "all 0.15s",
                    }}
                    className="hover:opacity-90"
                  >
                    Next: Service &amp; Pricing <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Section 1: Service & Pricing ─────────────────────────── */}
          {activeSection === 1 && (
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 24 }}>

              {/* sqft missing notice — only after the user has actually
                  reached Property Details (Step 3) and left sqft blank.
                  Never fire on the first pass through Step 2. */}
              {sqft === 0 && reachedPropertyDetails && (
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
                              <span style={{ fontSize: 10, background: "#F0EEE9", color: "#4A4845", borderRadius: 10, padding: "2px 6px", fontFamily: FF }}>{freqLabel}</span>
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
                          // [custom-recurring] "Other" renamed "Recurring" (Sal, mock v2).
                          // Maps to the dedicated "Hourly Recurring Cleaning" scope
                          // ($65) — split out from Hourly Standard ($70) so the two
                          // rates are independent and separately editable in Settings.
                          { key: "recurring", label: "Recurring", scopeMatch: /hourly.*recurring/i },
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
                                  Hourly
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
                                        // [custom-recurring] "Recurring" sub-type carries a real
                                        // recurring cadence, never one-time. Seed it to weekly so
                                        // the Cadence dropdown opens on a recurring value; the other
                                        // sub-types keep their scope default (one-time). toggleScope
                                        // is async (awaits the freq/addon fetch), so the seed MUST go
                                        // through initialState — a post-call updateScopeFrequency
                                        // would race ahead of the scope being added.
                                        setHourlyCustomOpen(false);
                                        // [hourly-recurring-label] Recurring reuses the Hourly Standard
                                        // scope for its $65 rate, so carry a displayLabel override so
                                        // every surface reads "Hourly Recurring Cleaning" instead of
                                        // the scope's real "Hourly Standard Cleaning" name.
                                        const seed = sub.key === "recurring" ? { frequency: "weekly", displayLabel: "Hourly Recurring Cleaning" } : undefined;
                                        // Select matching scope
                                        if (sub.scopeMatch) {
                                          const match = groupScopes.find(s => sub.scopeMatch!.test(s.name));
                                          if (match) toggleScope(match, seed);
                                        } else {
                                          // "Other" — select first hourly scope as fallback
                                          if (groupScopes[0]) toggleScope(groupScopes[0], seed);
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
                            {/* Cadence dropdown — how often this hourly service recurs */}
                            {hourlySubType && (() => {
                              const hourlySel = selectedScopes.find(s => groupScopes.some(gs => gs.id === s.scope_id));
                              if (!hourlySel) return null;
                              // [custom-recurring] The "Recurring" sub-type must offer real
                              // recurring cadences inline (weekly / bi-weekly / monthly + Custom)
                              // and NOT one-time — a recurring service is by definition not a
                              // single visit. Force the canonical recurring set regardless of the
                              // scope's own frequency list (Hourly Standard only carries onetime).
                              // Other sub-types keep the scope's frequencies (or the mixed fallback).
                              const isRecurringSub = hourlySubType === "recurring";
                              const cadenceOpts = isRecurringSub
                                ? [
                                    { value: "weekly", label: "Weekly" },
                                    { value: "every_2_weeks", label: "Bi-Weekly" },
                                    { value: "every_4_weeks", label: "Monthly" },
                                  ]
                                : hourlySel.frequencies.length
                                ? hourlySel.frequencies.map(f => ({ value: f.frequency, label: f.label || f.frequency }))
                                : [
                                    { value: "onetime", label: "One Time" },
                                    { value: "weekly", label: "Weekly" },
                                    { value: "every_2_weeks", label: "Bi-Weekly" },
                                    { value: "every_4_weeks", label: "Monthly" },
                                  ];
                              return (
                                <div style={{ marginTop: 10, paddingLeft: 12 }}>
                                  <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", marginBottom: 4, fontFamily: FF }}>Cadence</div>
                                  <select
                                    value={hourlyCustomOpen ? CUSTOM_FREQ : (hourlySel.frequency && (!isRecurringSub || hourlySel.frequency !== "onetime") ? hourlySel.frequency : (isRecurringSub ? "weekly" : "onetime"))}
                                    onChange={e => {
                                      const v = e.target.value;
                                      if (v === CUSTOM_FREQ) {
                                        // Custom pattern: keep a real recurring frequency on the
                                        // scope (so convert creates a schedule) while the builder
                                        // drives the actual cadence via custom_recurrence. Uses the
                                        // Hourly-specific state so the top Recurring Custom card is
                                        // untouched.
                                        setHourlyCustomOpen(true);
                                        updateScopeFrequency(hourlySel.scope_id, "weekly");
                                      } else {
                                        setHourlyCustomOpen(false);
                                        updateScopeFrequency(hourlySel.scope_id, v);
                                      }
                                    }}
                                    style={{
                                      width: "100%", maxWidth: 240, padding: "8px 10px", borderRadius: 8,
                                      border: "1px solid #E5E2DC", background: "#FFF", fontSize: 13, color: "#1A1917",
                                      fontFamily: FF, cursor: "pointer",
                                    }}
                                  >
                                    {cadenceOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    <option value={CUSTOM_FREQ}>＋ Custom…</option>
                                  </select>
                                  {hourlyCustomOpen && renderCustomBuilder(hourlyCustomRec, setHourlyCustomRec)}
                                </div>
                              );
                            })()}
                            {/* [hourly-hours 2026-07-25] How many hours this hourly
                                service is quoted for. Lives right where the office picks
                                the service (previously only editable on the Add-ons step,
                                buried in a collapsed card) so the estimate stops silently
                                defaulting to the engine's guess. Drives base_price = hours
                                × rate via updateScopeHoursManual. */}
                            {hourlySubType && (() => {
                              const hourlySel = selectedScopes.find(s => groupScopes.some(gs => gs.id === s.scope_id));
                              if (!hourlySel) return null;
                              const hScope = scopes.find(sc => sc.id === hourlySel.scope_id);
                              const rate = hourlySel.hourlyRateOverride ?? Number(hScope?.hourly_rate ?? 0);
                              const hrs = hourlySel.hours || 0;
                              return (
                                <div style={{ marginTop: 10, paddingLeft: 12 }}>
                                  <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", marginBottom: 4, fontFamily: FF }}>Hours</div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <button type="button" onClick={() => updateScopeHoursManual(hourlySel.scope_id, Math.max(0.5, hrs - 0.5))}
                                      style={{ width: 32, height: 32, border: "1px solid #E5E2DC", borderRadius: 8, background: "#F7F6F3", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FF }}>−</button>
                                    <input type="number" min="0.5" step="0.5" value={hourlySel.hours || ""} placeholder="0"
                                      onChange={e => updateScopeHoursManual(hourlySel.scope_id, parseFloat(e.target.value) || 0.5)}
                                      style={{ width: 72, height: 32, border: "1px solid #E5E2DC", borderRadius: 8, padding: "0 8px", fontSize: 14, fontFamily: FF, outline: "none", textAlign: "center" }} />
                                    <button type="button" onClick={() => updateScopeHoursManual(hourlySel.scope_id, hrs + 0.5)}
                                      style={{ width: 32, height: 32, border: "1px solid #E5E2DC", borderRadius: 8, background: "#F7F6F3", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FF }}>+</button>
                                    <span style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF, marginLeft: 2 }}>
                                      {hrs ? `${hrs} hrs × $${rate.toFixed(2)}/hr = $${(hrs * rate).toFixed(2)}` : "Enter hours to price this service"}
                                    </span>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        );
                      }

                      // ── Standard group rendering ──
                      // [custom-recurring] The Recurring group gains a 4th "Custom" card that
                      // anchors pricing to the Every-4-Weeks scope (same $65 recurring rate)
                      // and opens the shared flexible-pattern builder. Custom is treated as the
                      // single cadence: opening it clears any other selected recurring scope.
                      const isRecurringGroup = groupKey === "recurring cleaning";
                      const baseScope = isRecurringGroup
                        ? (groupScopes.find(s => /every\s*4\s*weeks/i.test(s.name)) ?? groupScopes[groupScopes.length - 1])
                        : null;
                      const baseSelState = baseScope ? selectedScopes.find(s => s.scope_id === baseScope.id) : null;
                      const customPriceText = baseSelState?.calcLoading
                        ? "..."
                        : baseSelState?.calc ? `$${baseSelState.calc.final_total.toFixed(2)} / visit` : "";
                      const openCustom = async () => {
                        if (!baseScope) return;
                        groupScopes.forEach(s => { if (s.id !== baseScope.id && selectedScopeIds.includes(s.id)) toggleScope(s); });
                        if (!selectedScopeIds.includes(baseScope.id)) await toggleScope(baseScope);
                        setCustomRecOpen(true);
                      };
                      const closeCustom = () => {
                        if (baseScope && selectedScopeIds.includes(baseScope.id)) toggleScope(baseScope);
                        setCustomRecOpen(false);
                      };
                      return (
                        <div key={groupKey} style={{ marginBottom: 16 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#4A4845", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: FF }}>{label}</div>
                            {groupHasSelection && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--brand)", display: "inline-block" }} />}
                            <div style={{ flex: 1, height: 1, background: "#E5E2DC" }} />
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            {groupScopes.map(scope => {
                              // Hide the base scope's own selection highlight while Custom owns it.
                              const isSel = selectedScopeIds.includes(scope.id) && !(customRecOpen && baseScope != null && scope.id === baseScope.id);
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
                                  </div>
                                  {priceText && (
                                    <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", textAlign: "right", marginTop: 6, fontFamily: FF }}>
                                      {priceText}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                            {isRecurringGroup && baseScope && (
                              <div
                                onClick={() => (customRecOpen ? closeCustom() : openCustom())}
                                style={{
                                  position: "relative",
                                  border: customRecOpen ? "1.5px solid var(--brand)" : "0.5px solid #E5E2DC",
                                  background: customRecOpen ? "#EAF9F4" : "#FFFFFF",
                                  borderRadius: 10, padding: "12px 14px 10px", cursor: "pointer",
                                  transition: "all 0.15s", minHeight: 70,
                                  display: "flex", flexDirection: "column" as const, justifyContent: "space-between",
                                }}
                              >
                                <div style={{ position: "absolute", top: 10, right: 10 }}>
                                  <Checkbox checked={customRecOpen} onCheckedChange={() => (customRecOpen ? closeCustom() : openCustom())} onClick={e => e.stopPropagation()} />
                                </div>
                                <div>
                                  <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1917", paddingRight: 28, fontFamily: FF }}>
                                    Custom
                                  </div>
                                </div>
                                {customRecOpen && customPriceText && (
                                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", textAlign: "right", marginTop: 6, fontFamily: FF }}>
                                    {customPriceText}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          {isRecurringGroup && customRecOpen && renderCustomBuilder()}
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
                <div style={{ marginTop: 4 }}>
                  <CalendarPopover value={selectedDate} onChange={(v) => { setSelectedDate(v); fetchTechAvailability(v); }} block ariaLabel="Preferred date" />
                </div>
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
                      const isSel = selectedTechIds.includes(tech.id);
                      return (
                        <div key={tech.id} onClick={() => toggleTech(tech.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6, cursor: "pointer", border: isSel ? "2px solid var(--brand)" : "1px solid #E5E2DC", background: isSel ? "rgba(var(--brand-rgb),0.05)" : "#FFF", opacity: avail?.muted ? 0.55 : 1 }}>
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
                      <span style={{ fontSize: 11, color: "#0F7A63", fontFamily: FF }}>applied</span>
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
                      {discountError && <div style={{ fontSize: 11, color: "#B3261E", fontFamily: FF }}>{discountError}</div>}
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-between items-center mt-5">
                <Button size="sm" variant="ghost" onClick={() => setActiveSection(0)}>Back</Button>
                <button
                  onClick={() => setActiveSection(2)}
                  disabled={selectedScopes.length === 0}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 8,
                    padding: "0 24px", height: 46, borderRadius: 10, border: "none",
                    fontSize: 15, fontWeight: 700, fontFamily: FF,
                    background: selectedScopes.length === 0 ? "#E5E2DC" : "var(--brand)",
                    color: selectedScopes.length === 0 ? "#9E9B94" : "#FFF",
                    cursor: selectedScopes.length === 0 ? "not-allowed" : "pointer",
                    boxShadow: selectedScopes.length === 0 ? "none" : "0 2px 8px rgba(0,201,160,0.35)",
                    transition: "all 0.15s",
                  }}
                  className="hover:opacity-90"
                >
                  Next: Property Details <ArrowRight className="w-4 h-4" />
                </button>
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
                  {/* [rentcast-carry 2026-07-28] Carry the Customer-Info RentCast
                      reference here so the office can compare it against what they
                      type. Reference only — never auto-fills. Hidden if no record. */}
                  {rcResult?.found && <div style={{ marginTop: 6 }}><RentcastRef rc={rcResult} /></div>}
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
                      <button key={d.value} onClick={() => setDirtLevel(d.value)} style={{ flex: 1, padding: "8px 6px", border: dirtLevel === d.value ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", borderRadius: 8, background: dirtLevel === d.value ? "var(--brand-soft)" : "#FFF", fontSize: 12, fontWeight: dirtLevel === d.value ? 600 : 400, color: dirtLevel === d.value ? "var(--brand)" : "#6B6860", cursor: "pointer", fontFamily: FF, textAlign: "center" as const }}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-between items-center mt-6">
                <Button size="sm" variant="ghost" onClick={() => setActiveSection(1)}>Back</Button>
                <button
                  onClick={() => setActiveSection(3)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 8,
                    padding: "0 24px", height: 46, borderRadius: 10, border: "none",
                    fontSize: 15, fontWeight: 700, fontFamily: FF,
                    background: "var(--brand)", color: "#FFF", cursor: "pointer",
                    boxShadow: "0 2px 8px rgba(0,201,160,0.35)", transition: "all 0.15s",
                  }}
                  className="hover:opacity-90"
                >
                  Next: Add-ons &amp; Notes <ArrowRight className="w-4 h-4" />
                </button>
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

                  {/* Frequency moved to the Service & Pricing step (per-scope cadence) */}

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
                        // [cadence-display 2026-07-27] Surface the recurring cadence on the line.
                        // It drives the hourly-recurring rate ($60 weekly / $65 biweekly / $70
                        // monthly), so the office must see WHICH cadence is being priced. One-time
                        // carries no cadence chip.
                        const cadence = s.frequency ? (CADENCE_LABELS[s.frequency] ?? null) : null;
                        return (
                          <div key={s.scope_id} style={{ border: "0.5px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
                            <button
                              onClick={() => setSelectedScopes(prev => prev.map(ss => ss.scope_id === s.scope_id ? { ...ss, expanded: !ss.expanded } : ss))}
                              style={{ width: "100%", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, background: s.expanded ? "#F7F6F3" : "#FFF", border: "none", cursor: "pointer", borderBottom: s.expanded ? "0.5px solid #E5E2DC" : "none" }}
                            >
                              <span style={{ textAlign: "left", fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{scopeLabel(s)}</span>
                              {cadence && <span style={{ fontSize: 10, fontWeight: 600, background: "#EAF9F4", color: "#0A6E5A", borderRadius: 10, padding: "2px 8px", fontFamily: FF }}>{cadence}</span>}
                              <span style={{ flex: 1 }} />
                              {estHours > 0 && <span style={{ fontSize: 11, color: "#6B6860", fontFamily: FF }}>{estHours} hrs est.</span>}
                              <span style={{ fontSize: 13, fontWeight: 500, color: "#1A1917", fontFamily: FF, minWidth: 60, textAlign: "right" }}>{subtotal}</span>
                              <ChevronDown style={{ width: 14, height: 14, color: "#9E9B94", transform: s.expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }} />
                            </button>
                            {s.expanded && (
                              <div style={{ padding: "12px 14px" }}>
                                {/* [rate-override 2026-07-11] Editable $/hr for this quote (Sunday /
                                    after-hours / special pricing). Blank = configured rate. */}
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                                  <span style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>Rate: $</span>
                                  <input type="number" min="0" step="1"
                                    value={s.hourlyRateOverride ?? ""}
                                    placeholder={Number(s.calc?.hourly_rate ?? scope.hourly_rate).toFixed(2)}
                                    onChange={e => updateScopeRate(s.scope_id, e.target.value === "" ? null : parseFloat(e.target.value))}
                                    title="Override the hourly rate for this quote only"
                                    style={{ width: 74, height: 28, border: `1px solid ${s.hourlyRateOverride != null ? "var(--brand)" : "#E5E2DC"}`, borderRadius: 6, padding: "0 6px", fontSize: 13, fontFamily: FF, outline: "none", textAlign: "center" }} />
                                  <span style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF }}>/hr</span>
                                  {s.hourlyRateOverride != null && (
                                    <button onClick={() => updateScopeRate(s.scope_id, null)} title="Reset to the configured rate"
                                      style={{ fontSize: 11, color: "#6B6860", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", fontFamily: FF, padding: 0 }}>reset</button>
                                  )}
                                </div>
                                {!isHourly && s.calc && (
                                  <div style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>
                                    {sqft > 0 ? `${sqft.toLocaleString()} sqft` : "No sqft"} {"\u2192"} {s.calc.base_hours || estHours} hrs {"\u00D7"} ${Number(s.calc.hourly_rate ?? scope.hourly_rate).toFixed(2)}/hr = ${s.calc.base_price.toFixed(2)}
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
                                      {s.hours ? `= $${(s.hours * (s.hourlyRateOverride ?? Number(scope.hourly_rate))).toFixed(2)}` : "Enter hours to calculate"}
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

                  {/* C. Add-ons & Discounts — one block PER selected service. Each
                      scope carries its own applicable add-ons + price adjustments, so
                      a quote with e.g. Deep Clean + Hourly lets the office pick add-ons
                      for BOTH, not just the first (Sal). Single-scope stays flat; with
                      2+ scopes each gets a titled sub-card. */}
                  {selectedScopes.length > 0 && (() => {
                    const multiScope = selectedScopes.length > 1;
                    return (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#4A4845", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8, fontFamily: FF }}>Add-ons &amp; Discounts</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: multiScope ? 14 : 0 }}>
                          {selectedScopes.map(targetScope => {
                            const scopeMeta = scopes.find(sc => sc.id === targetScope.scope_id);
                            const scopeIsHourly = scopeMeta?.pricing_method === "hourly" || scopeMeta?.pricing_method === "simplified";
                            // [addon-recurrence 2026-07-28] Recurring services get the
                            // First visit / Every visit choice per selected add-on.
                            const scopeIsRecurring = isRecurringFrequency(targetScope.frequency);
                            // [addon-adjustment-exclude 2026-07-27] "Manual Adjustment"
                            // and "Commercial Adjustment" aren't real add-ons — they're
                            // free-form price levers already covered by the Price
                            // Adjustments box below. Keep them out of the tile grid in
                            // every scope group.
                            const activeAddons = targetScope.addons.filter(
                              a => a.is_active && !/manual adjustment|commercial adjustment/i.test(a.name ?? "")
                            );
                            return (
                              <div
                                key={targetScope.scope_id}
                                style={multiScope ? { border: "1px solid #E5E2DC", borderRadius: 10, padding: "12px 14px", background: "#FCFBF9" } : {}}
                              >
                                {multiScope && (
                                  <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", marginBottom: 8, fontFamily: FF }}>{scopeLabel(targetScope)}</div>
                                )}
                                {/* [addon-sqft-gate] A sqft-priced service (Deep Clean, Standard,
                                    Move In/Out) can't price its add-ons until square footage is set —
                                    recalcScopeById bails when sqft=0, so toggling an add-on here would
                                    silently do nothing ("the add-ons aren't loading"). Tell the office
                                    why instead of leaving the click inert. */}
                                {scopeMeta?.pricing_method === "sqft" && !sqft && (
                                  <button
                                    type="button"
                                    onClick={() => setActiveSection(2)}
                                    style={{ display: "block", width: "100%", textAlign: "left", fontSize: 11, color: "#8A5A00", fontFamily: FF, marginBottom: 8, padding: "7px 9px", background: "#FBF3E2", border: "1px solid #F0D9A8", borderRadius: 6, cursor: "pointer" }}
                                  >
                                    Enter square footage on the Property Details step to price this service and its add-ons.
                                  </button>
                                )}
                                {/* [addons-redesign 2026-07-27] Hourly services carry
                                    their add-ons as "included in the hourly rate" — the
                                    office picks what gets performed, but nothing is billed
                                    on top of hours × rate. */}
                                {scopeIsHourly && activeAddons.length > 0 && (
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#E9F6F1", border: "1px solid #CDE9E0", color: "#0F7A63", borderRadius: 9, padding: "8px 11px", fontSize: 11.5, fontWeight: 600, marginBottom: 10, fontFamily: FF }}>
                                    <Check size={15} strokeWidth={2.2} style={{ flexShrink: 0 }} />
                                    <span>Add-ons are <strong>included in the hourly rate</strong> — select what to perform, no extra charge.</span>
                                  </div>
                                )}
                                {activeAddons.length === 0 ? (
                                  <div style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF, padding: "2px 0" }}>
                                    {scopeIsHourly ? "Included · no extra charge" : "No add-ons available for this service."}
                                  </div>
                                ) : (
                                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 230px), 1fr))", gap: 8 }}>
                                    {activeAddons.map(addon => {
                                      const isPct = isPercentAddon(addon);
                                      // [addon-qty 2026-07-28] Counter (qty stepper) applies to
                                      // per-item add-ons on BOTH billed and hourly scopes — on
                                      // hourly the count still tells the tech "clean 2 ovens"
                                      // while each unit stays $0. Percentage add-ons never count.
                                      const isCounter = !isPct && isCounterAddon(addon.name);
                                      const fromCalc = targetScope.calc?.addon_breakdown.find(b => b.id === addon.id);
                                      const qty = targetScope.addonQtys[addon.id] ?? 0;
                                      const isSel = isCounter ? qty > 0 : targetScope.addon_ids.includes(addon.id);
                                      const priceText = scopeIsHourly
                                        ? "Included"
                                        : fromCalc
                                          ? (fromCalc.amount < 0 ? `-$${Math.abs(fromCalc.amount).toFixed(2)}` : `+$${fromCalc.amount.toFixed(2)}`)
                                          : addonDisplayPrice(addon);
                                      // Clay tint for percentage-priced add-ons (billed scopes only);
                                      // mint for everything else and for hourly-included tiles.
                                      const clay = isPct && !scopeIsHourly;
                                      const chipBg = clay ? "#F3ECDD" : "var(--brand-dim)";
                                      const chipColor = clay ? "#8A6D2E" : "#0F7A63";
                                      const selBorder = clay ? "#CBB37A" : "var(--brand)";
                                      const selBg = clay ? "#FBF6EC" : "var(--brand-soft)";
                                      // [addon-recurrence 2026-07-28] every visit (default) vs
                                      // first visit only — shown once the add-on is selected on
                                      // a recurring scope. addonRecurring[id] === false → first
                                      // visit only; anything else → every visit.
                                      const everyVisit = targetScope.addonRecurring[addon.id] !== false;
                                      return (
                                        <div key={addon.id} style={{ display: "flex", flexDirection: "column", gap: 8, background: isSel ? selBg : "#FFF", border: `1px solid ${isSel ? selBorder : "#E5E2DC"}`, borderRadius: 10, padding: "10px 11px", transition: "border-color 0.12s, background 0.12s" }}>
                                          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                                            <span style={{ flex: "none", width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", background: chipBg, color: chipColor }}>
                                              <AddonIcon name={addon.name} size={18} color={chipColor} />
                                            </span>
                                            <div style={{ minWidth: 0, flex: 1 }}>
                                              <div style={{ fontSize: 12.5, fontWeight: 600, color: "#1A1917", fontFamily: FF, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{addon.name}</div>
                                              <div style={{ fontSize: 11, marginTop: 1, fontFamily: FF, color: scopeIsHourly ? "#0F7A63" : (fromCalc && fromCalc.amount < 0 ? "#B3261E" : "#6B6860"), fontWeight: scopeIsHourly ? 600 : 400 }}>{priceText}</div>
                                            </div>
                                            <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
                                              {isCounter ? (
                                                <>
                                                  <button onClick={() => updateScopeAddonQty(targetScope.scope_id, addon.id, qty - 1)} disabled={qty === 0}
                                                    style={{ width: 26, height: 26, borderRadius: 7, border: "1px solid #E5E2DC", background: qty === 0 ? "#F7F6F3" : "#FFF", color: qty === 0 ? "#C4C2BB" : "#6B6860", fontSize: 15, lineHeight: 1, cursor: qty === 0 ? "not-allowed" : "pointer", display: "grid", placeItems: "center" }}>−</button>
                                                  <span style={{ minWidth: 16, textAlign: "center", fontSize: 13, fontWeight: 600, fontFamily: FF, fontVariantNumeric: "tabular-nums" }}>{qty}</span>
                                                  <button onClick={() => updateScopeAddonQty(targetScope.scope_id, addon.id, qty + 1)}
                                                    style={{ width: 26, height: 26, borderRadius: 7, border: "1px solid #E5E2DC", background: "#FFF", color: "#6B6860", fontSize: 15, lineHeight: 1, cursor: "pointer", display: "grid", placeItems: "center" }}>+</button>
                                                </>
                                              ) : isSel ? (
                                                <button onClick={() => updateScopeAddon(targetScope.scope_id, addon.id, false)} title="Remove"
                                                  style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, color: scopeIsHourly ? "#0F7A63" : (clay ? "#8A6D2E" : "var(--brand)"), border: scopeIsHourly ? "none" : `1px solid ${clay ? "#CBB37A" : "var(--brand)"}`, background: scopeIsHourly ? "#E9F6F1" : "#FFF", borderRadius: scopeIsHourly ? 20 : 7, padding: scopeIsHourly ? "3px 9px" : "5px 10px", cursor: "pointer", fontFamily: FF }}>
                                                  {scopeIsHourly ? "Included" : <><Check size={12} strokeWidth={2.6} /> Added</>}
                                                </button>
                                              ) : (
                                                <button onClick={() => updateScopeAddon(targetScope.scope_id, addon.id, true)}
                                                  style={{ fontSize: 11, fontWeight: 700, color: clay ? "#8A6D2E" : "var(--brand)", border: `1px solid ${clay ? "#CBB37A" : "var(--brand)"}`, background: "#FFF", borderRadius: 7, padding: "5px 11px", cursor: "pointer", fontFamily: FF }}>Add</button>
                                              )}
                                            </div>
                                          </div>
                                          {/* [addon-recurrence 2026-07-28] First visit / Every visit — recurring scopes only, once selected. */}
                                          {isSel && scopeIsRecurring && (
                                            <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 45 }}>
                                              {([
                                                { key: true, label: "Every visit" },
                                                { key: false, label: "First visit only" },
                                              ] as const).map(opt => {
                                                const on = everyVisit === opt.key;
                                                return (
                                                  <button key={String(opt.key)} type="button"
                                                    onClick={() => updateScopeAddonRecurring(targetScope.scope_id, addon.id, opt.key)}
                                                    style={{ fontSize: 10.5, fontWeight: on ? 700 : 500, fontFamily: FF, color: on ? "var(--brand)" : "#6B6860", border: `1px solid ${on ? "var(--brand)" : "#E5E2DC"}`, background: on ? "var(--brand-soft)" : "#FFF", borderRadius: 20, padding: "3px 10px", cursor: "pointer" }}>
                                                    {opt.label}
                                                  </button>
                                                );
                                              })}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}

                                {/* Manual price adjustments — per service */}
                                <div style={{ marginTop: 14 }}>
                                  <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8, fontFamily: FF }}>Price Adjustments</div>
                                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                                    {([
                                      { kind: "add", amtField: "adjPlus", reasonField: "adjPlusReason", amt: targetScope.adjPlus, reason: targetScope.adjPlusReason, sign: "+", tint: "#1E8C4E", tintBg: "#F0FBF4", label: "Add charge", ph: "Reason (e.g. extra bathroom)" },
                                      { kind: "sub", amtField: "adjMinus", reasonField: "adjMinusReason", amt: targetScope.adjMinus, reason: targetScope.adjMinusReason, sign: "−", tint: "#B3261E", tintBg: "#FDF3F2", label: "Discount", ph: "Reason" },
                                    ] as const).map(row => {
                                      const active = (row.amt || 0) > 0;
                                      return (
                                        <div key={row.kind} style={{ border: `1px solid ${active ? row.tint : "#E5E2DC"}`, borderRadius: 10, padding: 10, background: active ? row.tintBg : "#FFF", transition: "all 0.15s", display: "flex", flexDirection: "column", gap: 8 }}>
                                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                            <span style={{ width: 18, height: 18, borderRadius: "50%", background: row.tint, color: "#FFF", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, lineHeight: 1 }}>{row.sign}</span>
                                            <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{row.label}</span>
                                          </div>
                                          <div style={{ display: "flex", alignItems: "center", height: 34, border: "1px solid #E5E2DC", borderRadius: 8, background: "#FFF", overflow: "hidden" }}>
                                            <span style={{ padding: "0 8px", fontSize: 14, color: "#9E9B94", fontFamily: FF, borderRight: "1px solid #E5E2DC", lineHeight: "34px", background: "#FAF9F7" }}>$</span>
                                            <input
                                              type="text" inputMode="decimal" placeholder="0.00"
                                              value={row.amt ? String(row.amt) : ""}
                                              onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ""); updateScopeAdj(targetScope.scope_id, row.amtField, parseFloat(v) || 0); }}
                                              style={{ flex: 1, minWidth: 0, height: 34, border: "none", padding: "0 8px", fontSize: 14, fontWeight: 600, color: "#1A1917", fontFamily: FF, outline: "none", background: "transparent" }} />
                                          </div>
                                          <input
                                            type="text" placeholder={row.ph} value={row.reason}
                                            onChange={e => updateScopeAdj(targetScope.scope_id, row.reasonField, e.target.value)}
                                            style={{ width: "100%", boxSizing: "border-box", height: 32, border: "1px solid #E5E2DC", borderRadius: 8, padding: "0 8px", fontSize: 12, color: "#1A1917", fontFamily: FF, outline: "none", background: "#FFF" }} />
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Notes section */}
              <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 2 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1917", fontFamily: FF }}>Job Notes</div>
                    <JobNotesTranslate text={internalMemo} />
                  </div>
                  <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 6, fontFamily: FF }}>Visible to the technician on the job card.</div>
                  <Textarea value={internalMemo} onChange={e => setInternalMemo(e.target.value)} placeholder="Instructions and notes for the technician..." rows={3} className="mt-1 text-sm" />
                  {pushConfirmed && <p style={{ fontSize: 11, color: "#9E9B94", marginTop: 4, fontFamily: FF }}>✓ Added from call notes.</p>}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1917", marginBottom: 2, fontFamily: FF }}>Client-Facing Notes</div>
                  <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 6, fontFamily: FF }}>Shown to the client on the quote.</div>
                  <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes visible to the client..." rows={3} className="mt-1 text-sm" />
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1917", marginBottom: 2, fontFamily: FF }}>Internal Office Memo</div>
                  <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 6, fontFamily: FF }}>Internal only — never shown to clients or technicians.</div>
                  <Textarea value={officeMemo} onChange={e => setOfficeMemo(e.target.value)} placeholder="Office-only notes..." rows={3} className="mt-1 text-sm" />
                </div>

                {/* Photo upload section — gated by VITE_PHOTOS_ENABLED flag.
                    When false (default), the section is hidden entirely so
                    quote builder users don't see a broken upload path. */}
                {import.meta.env.VITE_PHOTOS_ENABLED === "true" && (
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
                              <span style={{ fontSize: 10, color: "#B3261E", textAlign: "center" }}>{photo.error}</span>
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
                )}
              </div>

              <div className="flex justify-between mt-6">
                <Button size="sm" variant="ghost" onClick={() => setActiveSection(2)}>Back</Button>
                <button
                  onClick={() => {
                    // Default the recommended/only scope so Save & Send is never
                    // blocked — with 2+ scopes the office can still re-pick which
                    // one is the recommendation on the Review step.
                    if (!finalScopeId && selectedScopes.length >= 1) setFinalScopeId(selectedScopes[0].scope_id);
                    setActiveSection(4);
                  }}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 8,
                    padding: "0 24px", height: 46, borderRadius: 10, border: "none",
                    fontSize: 15, fontWeight: 700, fontFamily: FF,
                    background: "var(--brand)", color: "#FFF", cursor: "pointer",
                    boxShadow: "0 2px 8px rgba(0,201,160,0.35)", transition: "all 0.15s",
                  }}
                  className="hover:opacity-90"
                >
                  Next: Review <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* ── Section 4: Review ─────────────────────────────────────── */}
          {activeSection === 4 && (
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 24 }}>

              {/* Quick Book pre-fill banner */}
              {quickBookBanner && (
                <div style={{ background: "var(--brand-soft)", border: "1px solid var(--brand)", borderRadius: 6, padding: "8px 12px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontSize: 12, color: "#185FA5", fontFamily: FF }}>
                    Pre-filled from <strong>{quickBookBanner.scope}</strong> on{" "}
                    {(() => { try { return new Date(quickBookBanner.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch { return quickBookBanner.date; } })()}.{" "}
                    Adjust anything before saving.
                  </span>
                  <button onClick={() => setQuickBookBanner(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--brand)", padding: 0, flexShrink: 0, fontFamily: FF, fontSize: 16, lineHeight: 1 }}>×</button>
                </div>
              )}

              <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6, fontFamily: FF }}>
                {selectedScopes.length >= 2 ? "What to send the client" : "Option to send client"}
              </div>

              {/* [multi-option-send 2026-07-25] With 2+ scopes the office chooses
                  whether the client sees both options (and picks one on their
                  booking page) or only the recommended one. Nothing sends here —
                  this only shapes what the "Save & Send Quote" email contains. */}
              {selectedScopes.length >= 2 && (
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  {[
                    { key: true, title: "Send both options", sub: "Client picks one" },
                    { key: false, title: "Send one option", sub: "Only the one you choose" },
                  ].map(opt => {
                    const active = sendBoth === opt.key;
                    return (
                      <button
                        key={String(opt.key)}
                        type="button"
                        onClick={() => setSendBoth(opt.key)}
                        style={{ flex: 1, textAlign: "left", padding: "10px 14px", borderRadius: 8, cursor: "pointer", fontFamily: FF, border: active ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: active ? "var(--brand-soft)" : "#FFF" }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{opt.title}</div>
                        <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>{opt.sub}</div>
                      </button>
                    );
                  })}
                </div>
              )}

              {selectedScopes.length === 0 ? (
                <div style={{ textAlign: "center", fontSize: 14, color: "#9E9B94", padding: "24px 0" }}>
                  No scopes selected. <button onClick={() => setActiveSection(1)} style={{ color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Go back to Service &amp; Pricing</button>
                </div>
              ) : (
                <>
                  {selectedScopes.length >= 2 && (
                    <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 8, fontFamily: FF }}>
                      {sendBoth ? "Mark the recommended option — the client sees both and both are on the booking page." : "Choose the one option to send — the client sees only this."}
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                    {selectedScopes.map(s => {
                      const scope = scopes.find(sc => sc.id === s.scope_id);
                      const isFinal = finalScopeId === s.scope_id;
                      const dropped = selectedScopes.length >= 2 && !sendBoth && !isFinal;
                      const addonNames = s.addons.filter(a => s.addon_ids.includes(a.id)).map(a => a.name);
                      const addonSummary = addonNames.length > 0 ? ` + ${addonNames.join(", ")}` : "";
                      return (
                        <div
                          key={s.scope_id}
                          onClick={() => setFinalScopeId(s.scope_id)}
                          style={{ border: isFinal ? "1.5px solid var(--brand)" : "0.5px solid #E5E2DC", background: isFinal ? "var(--brand-soft)" : "#FFF", padding: "12px 16px", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, transition: "all 0.15s", opacity: dropped ? 0.5 : 1 }}
                        >
                          <input type="radio" checked={isFinal} onChange={() => setFinalScopeId(s.scope_id)} style={{ flexShrink: 0, accentColor: "var(--brand)", width: 16, height: 16 }} onClick={e => e.stopPropagation()} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>
                              {scopeLabel(s)}{addonSummary}
                              {isFinal && selectedScopes.length >= 2 && sendBoth && (
                                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#0F7A63", background: "#E4F8F2", borderRadius: 6, padding: "2px 7px", verticalAlign: "middle" }}>RECOMMENDED</span>
                              )}
                            </div>
                            {s.frequency && <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2, fontFamily: FF }}>{s.frequency}{dropped ? " · not sent" : ""}</div>}
                          </div>
                          <div style={{ fontSize: 16, fontWeight: 500, color: "#1A1917", flexShrink: 0, fontFamily: FF }}>
                            {s.calcLoading ? "..." : s.calc ? `$${s.calc.final_total.toFixed(2)}` : "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* [rentcast-carry 2026-07-28] RentCast reference carried onto the
                  Review step (reference only — never fills the quote). Hidden when
                  RentCast found no record / isn't configured. */}
              {rcResult?.found && (
                <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 16, marginTop: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8, fontFamily: FF }}>
                    Property Reference
                  </div>
                  <RentcastRef rc={rcResult} />
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
                    <div style={{ marginTop: 4 }}>
                      <CalendarPopover value={selectedDate} onChange={setSelectedDate} block ariaLabel="Scheduled date" />
                    </div>
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
                          onClick={() => toggleTech(preferredTech.id)}
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 14, fontSize: 12, fontWeight: selectedTechIds.includes(preferredTech.id) ? 600 : 400, border: selectedTechIds.includes(preferredTech.id) ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: selectedTechIds.includes(preferredTech.id) ? "#EAF9F4" : "#FFF", color: "#1A1917", cursor: "pointer", fontFamily: FF }}
                        >
                          <span style={{ width: 18, height: 18, borderRadius: "50%", background: selectedTechIds.includes(preferredTech.id) ? "var(--brand)" : "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFF", fontSize: 9, fontWeight: 700 }}>{preferredTech.full_name.charAt(0)}</span>
                          {preferredTech.full_name}
                          {selectedTechIds.includes(preferredTech.id) && <Check style={{ width: 12, height: 12, color: "var(--brand)" }} />}
                        </button>
                      )}
                      {/* Tech chips. Prefer the zone-matched techs; if the
                          zone has none mapped, fall back to the full active
                          roster so the office can always assign someone. */}
                      {(() => {
                        const usingFallback = suggestedTechs.length === 0;
                        const pickList = usingFallback ? allTechs : suggestedTechs;
                        const chips = pickList.filter(t => t.id !== preferredTech?.id);
                        return (
                          <>
                            {chips.map(tech => {
                              const isSel = selectedTechIds.includes(tech.id);
                              return (
                                <button key={tech.id} onClick={() => toggleTech(tech.id)}
                                  style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 14, fontSize: 12, fontWeight: isSel ? 600 : 400, border: isSel ? "1.5px solid var(--brand)" : "1px solid #E5E2DC", background: isSel ? "#EAF9F4" : "#FFF", color: "#1A1917", cursor: "pointer", fontFamily: FF }}
                                >
                                  <span style={{ width: 18, height: 18, borderRadius: "50%", background: isSel ? "var(--brand)" : "#E5E2DC", display: "flex", alignItems: "center", justifyContent: "center", color: isSel ? "#FFF" : "#6B6860", fontSize: 9, fontWeight: 700 }}>{tech.name.charAt(0)}</span>
                                  {tech.name}
                                </button>
                              );
                            })}
                            {usingFallback && chips.length > 0 && (
                              <span style={{ width: "100%", fontSize: 11, color: "#9E9B94", fontFamily: FF, marginTop: 2 }}>
                                No techs mapped to this zone — showing all technicians.
                              </span>
                            )}
                            {!preferredTech && chips.length === 0 && (
                              <span style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF, padding: "4px 0" }}>No techs available — will be unassigned</span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>
                {!selectedDate && (
                  <div style={{ fontSize: 11, color: "#BA7517", fontFamily: FF, marginBottom: 8 }}>
                    Select a date to convert to a scheduled job.
                  </div>
                )}
              </div>

              {/* ── Card on file (Square) ── */}
              <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 16, marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10, fontFamily: FF }}>
                  Payment Method
                </div>
                {cardSaved ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#0F7A63", fontWeight: 600, fontFamily: FF }}>
                    <CheckCircle2 size={16} />
                    {selectedClientId
                      ? `Card saved on file for ${selectedClient?.first_name || "this client"}.`
                      : "Card captured — it saves when you book this job."}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {/* [lead-card-capture 2026-08-08] This block used to be
                        replaced wholesale by "select an existing client above"
                        for a new lead — so the office could not take a card on
                        the call, which is the one moment the customer will
                        happily read one out. Now the entry form shows for
                        everyone; only the SEND-A-LINK options still need a
                        client, because a link has to be addressed to a saved
                        record. */}
                    {/* [lead-card-link 2026-08-08] All three options, always:
                        type it in, text a link, email a link. The link buttons
                        used to be hidden for a new lead because a payment link
                        needs a client row — the server now materializes one from
                        the quote, so the office gets the same choices on a first
                        call as on a repeat one. */}
                    {existingCardLast4 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 12.5, color: "#6B6860", fontFamily: FF }}>
                        <CreditCard size={14} />
                        <span>Card on file: {existingCardBrand ? `${existingCardBrand} ` : ""}•••• {existingCardLast4}. Saving a new one replaces it.</span>
                      </div>
                    )}
                    <div>
                      <button type="button" onClick={openCardModal}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 8, border: "none", background: "var(--brand)", color: "#FFF", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
                        <CreditCard size={15} /> {existingCardLast4 ? "Replace card on file" : "Save card on file now"}
                      </button>
                      {!selectedClientId && (
                        <div style={{ fontSize: 11.5, color: "#9E9B94", fontFamily: FF, marginTop: 6 }}>
                          New customer — the card is held securely and saves the moment you book the job.
                        </div>
                      )}
                    </div>
                    <>
                      <div style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF }}>
                        Or send the customer a link to {existingCardLast4 ? "update it" : "add it"} themselves:
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input value={cardLinkPhone} onChange={e => { cardLinkPhoneEdited.current = true; setCardLinkPhone(e.target.value); if (linkSent === "sms") setLinkSent(null); }}
                            placeholder="Mobile number" type="tel" inputMode="tel"
                            style={{ width: 150, height: 36, border: "1px solid #E5E2DC", borderRadius: 8, padding: "0 10px", fontSize: 13, fontFamily: FF, outline: "none", background: "#FFF" }} />
                          <button type="button" onClick={() => sendCardLink("sms")} disabled={linkSending !== null}
                            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: 8, border: "1px solid #E5E2DC", background: linkSent === "sms" ? "#EAF9F4" : "#FFF", color: "#1A1917", fontSize: 12, fontWeight: 600, cursor: linkSending ? "default" : "pointer", fontFamily: FF, whiteSpace: "nowrap" }}>
                            {linkSending === "sms" ? <Loader2 size={13} className="animate-spin" /> : linkSent === "sms" ? <Check size={13} style={{ color: "#0F7A63" }} /> : null}
                            {linkSent === "sms" ? "Text sent" : "Text link"}
                          </button>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input value={cardLinkEmail} onChange={e => { cardLinkEmailEdited.current = true; setCardLinkEmail(e.target.value); if (linkSent === "email") setLinkSent(null); }}
                            placeholder="Email" type="email" inputMode="email"
                            style={{ width: 190, height: 36, border: "1px solid #E5E2DC", borderRadius: 8, padding: "0 10px", fontSize: 13, fontFamily: FF, outline: "none", background: "#FFF" }} />
                          <button type="button" onClick={() => sendCardLink("email")} disabled={linkSending !== null}
                            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: 8, border: "1px solid #E5E2DC", background: linkSent === "email" ? "#EAF9F4" : "#FFF", color: "#1A1917", fontSize: 12, fontWeight: 600, cursor: linkSending ? "default" : "pointer", fontFamily: FF, whiteSpace: "nowrap" }}>
                            {linkSending === "email" ? <Loader2 size={13} className="animate-spin" /> : linkSent === "email" ? <Check size={13} style={{ color: "#0F7A63" }} /> : null}
                            {linkSent === "email" ? "Email sent" : "Email link"}
                          </button>
                        </div>
                      </div>
                    </>
                  </div>
                )}
              </div>

              {/* [multi-option-send 2026-07-25] Make the no-auto-email rule
                  explicit: booking on the call never emails; only Save & Send does. */}
              <div style={{ fontSize: 11.5, color: "#9E9B94", fontFamily: FF, marginTop: 16, marginBottom: 2 }}>
                {/* [convert-copy 2026-08-08] Was "does not email the client",
                    which reads as total silence — Maribel asked what it meant.
                    Convert DOES email: sendJobScheduledConfirmation fires the
                    booking confirmation (email + SMS). What it skips is the
                    QUOTE. Say which email, not whether. */}
                Booking on the call (Convert to Job) sends the appointment confirmation, not the quote. <strong style={{ color: "#6B6860" }}>Save &amp; Send</strong> is what emails the quote for approval.
              </div>
              <div className="flex justify-between mt-4">
                <Button size="sm" variant="ghost" onClick={() => setActiveSection(3)}>Back</Button>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => save("draft")} disabled={saving} className="gap-1.5">
                    <Save className="w-3.5 h-3.5" /> Save Draft
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => save("sent")} disabled={saving || !finalScopeId} className="gap-1.5">
                    <SendHorizonal className="w-3.5 h-3.5" />
                    {selectedScopes.length >= 2 && sendBoth ? "Save & Send Both" : "Save & Send Quote"}
                  </Button>
                  <Button size="sm" onClick={() => {
                      // Never a silent no-op: tell the office exactly what's missing
                      // instead of a dead, pointer-events:none button.
                      if (!canConvert) { toast.error("Add a customer and pick a service before converting."); return; }
                      if (!selectedDate) { toast.error("Pick a scheduled date to convert to a job."); return; }
                      save("draft", true);
                    }} disabled={saving} style={{ background: "var(--brand)", color: "#FFF", cursor: "pointer" }} className="gap-1.5 hover:opacity-90">
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
              style={{ width: "100%", boxSizing: "border-box", resize: "none", border: "1px solid #E5E2DC", borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: "1.6", color: "#1A1917", fontFamily: FF, background: "#F7F6F3", outline: "none" }}
            />
            {/* [quote-attachments] Drop zone + thumbnail row. Photos and
                PDFs office uploads stay private to office + assigned techs. */}
            <QuoteAttachments ensureQuoteId={ensureQuoteId} />
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
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF, marginBottom: 10 }}>{scopeLabel(s)}</div>
                  {s.calcLoading && <div style={{ fontSize: 13, color: "#9E9B94", fontFamily: FF }}>Calculating...</div>}
                  {!s.calcLoading && s.calc ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6B6860" }}>
                        <span>Base</span><span>${s.calc.base_price.toFixed(2)}</span>
                      </div>
                      {/* [min-applied 2026-06-05] When hours × rate falls below the
                          scope's Minimum Bill, the floor takes over and Base shows the
                          minimum. Surface it so the office knows the price was floored
                          (not mis-computed) — minimum applies regardless of sq ft. */}
                      {s.calc.minimum_applied && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#9E9B94", fontFamily: FF, marginTop: -2 }}>
                          <span>Minimum applied</span><span>${s.calc.minimum_bill.toFixed(2)} floor</span>
                        </div>
                      )}
                      {s.calc.addon_breakdown.map(a => (
                        <div key={a.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6B6860" }}>
                          <span>{a.name}</span><span>{a.amount < 0 ? `-$${Math.abs(a.amount).toFixed(2)}` : `+$${a.amount.toFixed(2)}`}</span>
                        </div>
                      ))}
                      {/* [bundle-display 2026-06-05] Bundle discounts are subtracted from
                          the total in the calc but were never shown here — so the line
                          items summed to MORE than the Total and it looked like broken
                          addition (Maribel's "the issue is the addition" — a hidden $35).
                          Render each matched bundle so Base + add-ons − bundle = Total. */}
                      {/* [combo-optional] Each matched bundle is a toggle. Applied
                          bundles subtract; toggling off keeps the line (greyed,
                          struck) with an "Add" affordance so the office controls
                          whether the combo discount applies. */}
                      {(s.calc.bundle_breakdown ?? []).map((b, i) => (
                        <div key={`bundle-${b.id ?? i}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: b.applied ? "#0F7A63" : "#9E9B94" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <button
                              type="button"
                              onClick={() => toggleBundle(s.scope_id, b.id)}
                              title={b.applied ? "Remove this combo discount" : "Apply this combo discount"}
                              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: 4, border: "1px solid #E5E2DC", background: b.applied ? "#0F7A63" : "#FFF", color: b.applied ? "#FFF" : "#9E9B94", fontSize: 11, lineHeight: 1, cursor: "pointer", padding: 0, fontFamily: FF }}
                            >
                              {b.applied ? "×" : "+"}
                            </button>
                            <span style={{ textDecoration: b.applied ? "none" : "line-through" }}>{b.name || "Bundle discount"}</span>
                          </span>
                          <span style={{ textDecoration: b.applied ? "none" : "line-through" }}>-${b.discount.toFixed(2)}</span>
                        </div>
                      ))}
                      {s.calc.discount_amount > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#0F7A63" }}>
                          <span>Discount</span><span>-${s.calc.discount_amount.toFixed(2)}</span>
                        </div>
                      )}
                      {s.adjPlus > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#22C55E" }}>
                          <span>+{s.adjPlusReason || "Adjustment"}</span><span>+${s.adjPlus.toFixed(2)}</span>
                        </div>
                      )}
                      {s.adjMinus > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#B3261E" }}>
                          <span>−{s.adjMinusReason || "Adjustment"}</span><span>-${s.adjMinus.toFixed(2)}</span>
                        </div>
                      )}
                      {/* Estimated hours — total_hours from the backend already includes
                          add-on time-adds (Oven +45 min, etc). Falls back to base_hours
                          when the calc hasn't returned yet. */}
                      {(s.hours || s.calc?.total_hours || s.calc?.base_hours) && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6B6860" }}>
                          <span>Est. hours</span><span>{s.calc?.total_hours ?? s.hours ?? s.calc?.base_hours} hrs</span>
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid #E5E2DC", marginTop: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Total</span>
                        <span style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>${(s.calc.final_total + (s.adjPlus || 0) - (s.adjMinus || 0)).toFixed(2)}</span>
                      </div>
                      {/* Commission breakdown */}
                      {(() => {
                        // [discount-commission 2026-07-27] Commission is paid on the
                        // PRE-discount service price (Maribel: "the discount shouldn't
                        // affect the cleaner's commission"). Base = subtotal (base +
                        // add-ons) + the additive Add-charge adjustment, EXCLUDING the
                        // promo/bundle discount AND the manual Discount (adjMinus). We
                        // rebuild it from final_total by adding back every discount the
                        // engine already subtracted so bundles are covered too.
                        const commissionBase = s.calc.final_total
                          + (s.calc.discount_amount || 0)
                          + (s.calc.bundle_discount || 0)
                          + (s.adjPlus || 0);
                        // [addon-time 2026-05-27] Use total_hours so commission-per-tech
                        // hours reflect add-on time (e.g. Oven +45 min) just like the
                        // Est. hours line above.
                        const estHrs = s.calc?.total_hours ?? s.hours ?? s.calc?.base_hours ?? 0;
                        const techCount = selectedTechIds.length;
                        const cs = calculateCommissionSplit(commissionBase, estHrs, techCount, undefined, "residential", scope?.name);
                        const ratePct = Math.round((cs.commissionRate ?? 0.35) * 100);
                        return (
                          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed #E5E2DC" }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", marginBottom: 4, fontFamily: FF }}>Commission ({ratePct}%)</div>
                            <div style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>
                              Tech Pay: ${cs.totalCommission.toFixed(2)}
                            </div>
                            {cs.mode === "unassigned" && (
                              <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginTop: 2 }}>Will calculate once techs are assigned</div>
                            )}
                            {cs.mode === "equal" && cs.perTech.length > 0 && (
                              <div style={{ fontSize: 11, color: "#6B6860", fontFamily: FF, marginTop: 2 }}>
                                {techCount === 1 ? (
                                  <>${cs.perTech[0].commission.toFixed(2)}{estHrs > 0 && ` · ${cs.perTech[0].hours} hrs`}</>
                                ) : (
                                  <>${cs.totalCommission.toFixed(2)} ÷ {techCount} techs = ${cs.perTech[0].commission.toFixed(2)} each{estHrs > 0 && ` · ${cs.perTech[0].hours} hrs each`}</>
                                )}
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
              // [addon-time 2026-05-27] Sum total_hours so add-on time-adds roll up
              // into the multi-scope grand total (was summing base_hours and dropping
              // Oven/Refrigerator/etc. minutes).
              const totalHours = selectedScopes.reduce((sum, s) => sum + (s.calc?.total_hours ?? s.hours ?? s.calc?.base_hours ?? 0), 0);
              const techCount = selectedTechIds.length;
              // [tiered-residential] Per-scope commission so a quote
              // with mixed Standard + Deep Clean shows the right total
              // (35% × standard + 32% × deep), not a flat 35%.
              const perScopeCommission = selectedScopes.reduce((sum, ss) => {
                const sc = scopes.find(sx => sx.id === ss.scope_id);
                // [discount-commission 2026-07-27] Pay commission on the pre-discount
                // price: add back every discount the engine netted out and the
                // additive Add-charge, but NOT the manual Discount (adjMinus).
                const t = (ss.calc?.final_total ?? 0)
                  + (ss.calc?.discount_amount || 0)
                  + (ss.calc?.bundle_discount || 0)
                  + (ss.adjPlus || 0);
                return sum + t * (sc ? (sc.name ? (/\bdeep\s*clean\b|\bmove[-\s]?(in|out)\b/i.test(sc.name) ? 0.32 : 0.35) : 0.35) : 0.35);
              }, 0);
              const cs = calculateCommissionSplit(grandTotal, totalHours, techCount);
              const csTotalCommission = Math.round(perScopeCommission * 100) / 100;
              return (
                <div>
                  {selectedScopes.map(s => {
                    const scope = scopes.find(sc => sc.id === s.scope_id);
                    const estHrs = s.calc?.total_hours ?? s.hours ?? s.calc?.base_hours ?? 0;
                    const cad = s.frequency ? (CADENCE_LABELS[s.frequency] ?? null) : null;
                    const hasDetail = !!s.calc && ((s.calc.addon_breakdown?.length ?? 0) > 0 || (s.calc.bundle_breakdown?.length ?? 0) > 0);
                    return (
                      <div key={s.scope_id} style={{ padding: "8px 0", borderBottom: "1px solid #F0EEE9" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 13, color: "#1A1917", fontFamily: FF }}>{scopeLabel(s)}</span>
                          {cad && <span style={{ fontSize: 9, fontWeight: 600, background: "#EAF9F4", color: "#0A6E5A", borderRadius: 10, padding: "1px 7px", fontFamily: FF }}>{cad}</span>}
                          <span style={{ flex: 1 }} />
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>
                            {s.calcLoading ? "..." : s.calc ? `$${s.calc.final_total.toFixed(2)}` : "\u2014"}
                          </span>
                        </div>
                        {/* [addon-breakdown 2026-07-27] Multi-scope quotes now show each
                            scope's Base + add-on lines + combo-bundle toggles \u2014 the same
                            detail the single-scope preview always had. It was collapsed to
                            a lump total, so the office couldn't see the add-on math or
                            CHOOSE whether to apply each bundle discount (Sal, office quote). */}
                        {hasDetail && (
                          <div style={{ marginTop: 5, paddingLeft: 10, display: "flex", flexDirection: "column", gap: 3 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#9E9B94", fontFamily: FF }}>
                              <span>Base</span><span>${s.calc!.base_price.toFixed(2)}</span>
                            </div>
                            {s.calc!.addon_breakdown.map(a => (
                              <div key={a.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6B6860", fontFamily: FF }}>
                                <span>{a.name}</span><span>{a.amount < 0 ? `-$${Math.abs(a.amount).toFixed(2)}` : `+$${a.amount.toFixed(2)}`}</span>
                              </div>
                            ))}
                            {(s.calc!.bundle_breakdown ?? []).map((b, i) => (
                              <div key={`bundle-${b.id ?? i}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: b.applied ? "#0F7A63" : "#9E9B94", fontFamily: FF }}>
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                  <button type="button" onClick={() => toggleBundle(s.scope_id, b.id)} title={b.applied ? "Remove this combo discount" : "Apply this combo discount"}
                                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 15, height: 15, borderRadius: 4, border: "1px solid #E5E2DC", background: b.applied ? "#0F7A63" : "#FFF", color: b.applied ? "#FFF" : "#9E9B94", fontSize: 10, lineHeight: 1, cursor: "pointer", padding: 0, fontFamily: FF }}>
                                    {b.applied ? "\u00d7" : "+"}
                                  </button>
                                  <span style={{ textDecoration: b.applied ? "none" : "line-through" }}>{b.name || "Bundle discount"}</span>
                                </span>
                                <span style={{ textDecoration: b.applied ? "none" : "line-through" }}>-${b.discount.toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {estHrs > 0 && <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginTop: 3 }}>Est. {estHrs} hrs</div>}
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
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", marginBottom: 2, fontFamily: FF }}>Commission (blended): ${csTotalCommission.toFixed(2)}</div>
                    {cs.mode === "unassigned" && <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>Will calculate once techs are assigned</div>}
                    {cs.mode === "equal" && cs.perTech.length > 0 && (
                      <div style={{ fontSize: 11, color: "#6B6860", fontFamily: FF }}>
                        {techCount === 1
                          ? <>${cs.perTech[0].commission.toFixed(2)} · {cs.perTech[0].hours} hrs</>
                          : <>${cs.perTech[0].commission.toFixed(2)} / tech · {cs.perTech[0].hours} hrs / tech</>}
                      </div>
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
      {cardModalEl}
    </div>
  );
}

// [rentcast-carry 2026-07-28] Reference-only RentCast line, reused from Customer
// Info onto Property Details + Review so the fetched numbers follow the office
// through the whole wizard. Matches the Customer Info "found" styling exactly
// (mint value + muted "· reference only"). Renders NOTHING when RentCast found
// no record / isn't configured — never an empty "reference" line. Display only:
// it never writes back to sqft/beds/baths.
function RentcastRef({ rc }: { rc: any }) {
  if (!rc || !rc.found) return null;
  const parts = [
    rc.square_footage ? `${Number(rc.square_footage).toLocaleString()} sq ft` : null,
    rc.bedrooms != null ? `${rc.bedrooms} bd` : null,
    rc.bathrooms != null ? `${rc.bathrooms} ba` : null,
  ].filter(Boolean);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontFamily: FF, color: "#6B6860" }}>
      <span style={{ fontWeight: 600 }}>RentCast:</span>
      <span style={{ color: "#0A6E5A" }}>{parts.length ? parts.join(" · ") : "no sq ft on file"} <span style={{ color: "#9E9B94" }}>· reference only</span></span>
    </div>
  );
}

function Stepper({ value, onChange, min = 0, max = 10 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  const btn = (disabled: boolean): React.CSSProperties => ({
    width: 44, height: 44, border: "1px solid #E5E2DC", borderRadius: 0, background: disabled ? "#F7F6F3" : "#FFF",
    color: disabled ? "#E5E2DC" : "#1A1917", fontSize: 18, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center",
  });
  // [typeable-steppers 2026-07-27] The office hates clicking +/-, so the middle
  // is now a real number input they can type into and TAB between (sqft → beds →
  // full bath → half bath → pets). The − / + buttons stay for anyone who wants
  // them but are pulled out of the tab order (tabIndex -1) so TAB flows
  // field-to-field, not through every button. Whole numbers only, clamped to
  // [min, max] — the same clamp the buttons enforce.
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  return (
    <div style={{ display: "flex", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden", height: 44, marginTop: 6 }}>
      <button type="button" tabIndex={-1} style={btn(value <= min)} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <input
        // [no-native-spinner 2026-07-28] type="text" + inputMode="numeric" so the
        // browser's native up/down spin caret never renders (redundant next to the
        // − / + buttons). Still typeable and TAB-navigable; digits-only, clamped to
        // [min, max] — same behavior the number input had.
        type="text"
        inputMode="numeric"
        value={value || ""}
        onChange={e => {
          const digits = e.target.value.replace(/[^0-9]/g, "");
          onChange(digits === "" ? min : clamp(parseInt(digits, 10)));
        }}
        style={{ flex: 1, width: "100%", minWidth: 0, textAlign: "center", fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF, border: "none", borderLeft: "1px solid #E5E2DC", borderRight: "1px solid #E5E2DC", outline: "none", background: "#FFF", padding: 0, boxSizing: "border-box" }}
      />
      <button type="button" tabIndex={-1} style={btn(value >= max)} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );
}
