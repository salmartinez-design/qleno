// [AG] Focused job edit modal — accessed from JobPanel drawer's action footer.
// Sections: Service · Schedule · Team · Add-ons · Pricing · Instructions
// Cascade prompt shown when job has recurring_schedule_id.
//
// Pricing approach: tenant's pricing_scopes is a dropdown (decision 1c).
// Modal calls POST /api/pricing/calculate as inputs change. base_fee is the
// only persisted pricing value; manual_rate_override flips when user types
// a custom rate.
//
// [AH] Commercial fork. When the client is client_type='commercial' the
// modal swaps the service section: shows the 6 commercial service_types as
// a dropdown (instead of pricing_scopes), an editable hourly rate input
// (prefilled from clients.commercial_hourly_rate), and filters add-ons to
// show only Parking Fee. Pricing is computed client-side as
// hourly_rate × allowed_hours + parking. No round-trip to /pricing/calculate
// since the math is trivial. PATCH submits with `hourly_rate` so the server
// can cascade to recurring_schedules.commercial_hourly_rate and future jobs.
import { useEffect, useMemo, useRef, useState } from "react";
import { X, AlertTriangle, Loader2 } from "lucide-react";
import { useAuthStore } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

const FF = "'Plus Jakarta Sans', sans-serif";

// Mirrors the DispatchJob shape from jobs.tsx — only the fields the modal
// reads. Kept loose-typed so we don't have to cross-import.
export interface EditableJob {
  id: number;
  client_id: number;
  client_name: string;
  recurring_schedule_id?: number | null;
  service_type: string;
  frequency: string;
  scheduled_date: string;
  scheduled_time: string | null;
  duration_minutes: number;
  amount: number;
  base_fee?: number | string | null;
  notes: string | null;
  status: string;
  locked_at?: string | null;
  assigned_user_id: number | null;
  hourly_rate?: number | string | null;
  // [AI.1] account_id !== null is an additional commercial signal. Defensive
  // against MC-import client_type drift — clients linked to a commercial
  // account but tagged residential still get the commercial UI fork.
  account_id?: number | null;
}

// [AI.3] Commercial service types are now tenant-managed via
// /api/commercial-service-types. The modal fetches active rows on open.
// `slug` lines up with jobs.service_type enum values; new tenant-added
// types extend the enum server-side. See pricing.tsx → "Commercial Service
// Types" section for management UI.
interface CommercialServiceType {
  id: number;
  name: string;
  slug: string;
  default_hourly_rate: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface TeamCandidate {
  id: number;
  name: string;
  role?: string;
  is_primary?: boolean;
}

interface PricingScope {
  id: number;
  name: string;
  scope_group: string;
  pricing_method: string;
  hourly_rate: string | number;
}

interface PricingAddon {
  id: number;
  name: string;
  // [AI.2] PHES seeds populate price_value (NUMERIC, default '0'), not the
  // separate-but-similarly-named `price` column (NULLABLE NUMERIC).
  // Pre-AI.2 modal read .price → null → "$0" labels for every add-on
  // regardless of the seeded price. Read price_value primarily; fall back
  // to price for any rows that may have populated the older column.
  price?: string | number | null;
  price_value?: string | number | null;
  price_type: string;
  time_add_minutes?: number;
}

interface CalcResponse {
  base_price: number;
  addons_total: number;
  bundle_discount: number;
  bundle_breakdown?: { name: string; discount: number }[];
  addon_breakdown?: { id: number; name: string; amount: number; price_type: string }[];
  total_hours: number;
  hourly_rate: number;
  subtotal: number;
  final_total: number;
}

// [AI] Frequency options grouped via <optgroup>. Standard set is shown to
// every client. Commercial multi-day group only renders when
// client.client_type === 'commercial'.
// [AI.5] Normalize a stored scheduled_time string to canonical "HH:MM".
// jobs.scheduled_time is TEXT; depending on how the row was written it may
// arrive as "09:00", "09:00:00", "9:00", or null. The <input type="time">
// expects "HH:MM" exactly, and canSave's regex enforces that. Without this
// helper, a job whose scheduled_time stores "09:00:00" (Postgres time-text
// round-trip) silently kills Save with no visible message.
function normalizeTimeStr(t: string | null | undefined): string {
  if (!t) return "09:00";
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "09:00";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

const FREQUENCIES_STANDARD: Array<{ value: string; label: string }> = [
  { value: "on_demand", label: "One-time" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "every_3_weeks", label: "Every 3 weeks" },
  { value: "monthly", label: "Every 4 weeks / Monthly" },
];
const FREQUENCIES_COMMERCIAL_MULTI: Array<{ value: string; label: string }> = [
  { value: "daily",       label: "Daily (every day)" },
  { value: "weekdays",    label: "Weekdays (M–F)" },
  { value: "custom_days", label: "Custom days" },
];

// Day picker labels for custom_days. Order is Sun..Sat, value 0..6 to match
// JS Date.getDay() and the DB days_of_week array.
const DAY_PICKER: Array<{ value: number; short: string }> = [
  { value: 0, short: "Sun" }, { value: 1, short: "Mon" }, { value: 2, short: "Tue" },
  { value: 3, short: "Wed" }, { value: 4, short: "Thu" }, { value: 5, short: "Fri" },
  { value: 6, short: "Sat" },
];

const SECTION: React.CSSProperties = {
  margin: "14px 20px 0",
  backgroundColor: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #E5E2DC",
  padding: "14px 16px",
};
const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: "#9E9B94",
  textTransform: "uppercase", letterSpacing: "0.07em",
  display: "block", marginBottom: 10,
};
const INPUT: React.CSSProperties = {
  // [AI.6] 44px minimum touch target per iOS HIG (was 40); 16px font
  // prevents iOS Safari zoom-on-focus behavior on number inputs.
  width: "100%", height: 44, padding: "0 12px",
  border: "1px solid #E5E2DC", borderRadius: 8,
  fontSize: 16, outline: "none", boxSizing: "border-box",
  fontFamily: FF, backgroundColor: "#F7F6F3", color: "#1A1917",
};

export default function EditJobModal({
  job, employees, mobile, onClose, onSaved,
}: {
  job: EditableJob;
  employees: TeamCandidate[];
  mobile: boolean;
  onClose: () => void;
  onSaved: (info: { future_jobs_updated: number; future_jobs_skipped_in_progress: number }) => void;
}) {
  const token = useAuthStore(s => s.token)!;
  const { toast } = useToast();
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const isRecurring = job.recurring_schedule_id != null;

  // ── Initial values (snapshot from the loaded job) ──────────────────────
  const initialBaseFee = useMemo(
    () => Number(job.base_fee ?? job.amount ?? 0),
    [job.base_fee, job.amount],
  );
  const initialAllowedHours = useMemo(
    () => Math.max(0.25, Math.round((job.duration_minutes / 60) * 100) / 100),
    [job.duration_minutes],
  );

  // ── Form state ─────────────────────────────────────────────────────────
  const [scopeId, setScopeId] = useState<number | null>(null);
  const [scopes, setScopes] = useState<PricingScope[]>([]);
  const [scopesLoading, setScopesLoading] = useState(true);

  const [frequency, setFrequency] = useState(job.frequency || "on_demand");
  const [scheduledDate, setScheduledDate] = useState(job.scheduled_date);
  // [AI.5] Normalize on init — DB may store "09:00:00" or "9:00" which would
  // silently kill canSave's regex (only HH:MM passes). See normalizeTimeStr.
  const [scheduledTime, setScheduledTime] = useState(normalizeTimeStr(job.scheduled_time));
  const [allowedHours, setAllowedHours] = useState<number>(initialAllowedHours);
  const [instructions, setInstructions] = useState(job.notes || "");

  const [selectedTechIds, setSelectedTechIds] = useState<number[]>(
    job.assigned_user_id != null ? [job.assigned_user_id] : []
  );

  const [availableAddons, setAvailableAddons] = useState<PricingAddon[]>([]);
  const [addonsLoading, setAddonsLoading] = useState(false);
  const [selectedAddons, setSelectedAddons] = useState<Map<number, number>>(new Map());

  const [baseFee, setBaseFee] = useState<number>(initialBaseFee);
  const [manualRate, setManualRate] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState<string>(String(initialBaseFee));

  // [AH] Commercial state. clientType is 'residential' until the client
  // profile loads. clientLoaded gates rendering so we don't flash residential
  // UI for a commercial client. commercialServiceType holds the dropdown
  // value (one of COMMERCIAL_SERVICE_TYPES). hourlyRate is editable per-visit;
  // clientDefaultRate stores the saved client default for the helper text.
  const [clientLoaded, setClientLoaded] = useState(false);
  const [clientType, setClientType] = useState<"residential" | "commercial">("residential");
  const [clientDefaultRate, setClientDefaultRate] = useState<number | null>(null);
  const [commercialServiceType, setCommercialServiceType] = useState<string>(job.service_type);
  const [commercialServiceTypes, setCommercialServiceTypes] = useState<CommercialServiceType[]>([]);
  const [hourlyRate, setHourlyRate] = useState<number>(
    job.hourly_rate != null ? Number(job.hourly_rate) : 0
  );

  // [AI] Multi-day picker state. Only used when frequency='custom_days'.
  // Initialized empty; user must check at least one day to save.
  // TODO(AJ): preload from recurring_schedules.days_of_week when opening a
  // custom_days job — requires fetching the schedule row alongside the
  // client load. For now the user re-picks on edit; canSave guards against
  // accidental empty-array saves.
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const isMultiDayFreq = frequency === "daily" || frequency === "weekdays" || frequency === "custom_days";

  const [calcResult, setCalcResult] = useState<CalcResponse | null>(null);
  const [calcBusy, setCalcBusy] = useState(false);
  const [calcError, setCalcError] = useState<string>("");

  // Cascade prompt state
  const [cascadePromptOpen, setCascadePromptOpen] = useState(false);
  const [cascadeChoice, setCascadeChoice] = useState<"this_job" | "this_and_future">("this_job");

  const [saving, setSaving] = useState(false);

  // [AH] Load client (resolve commercial vs residential) BEFORE scopes/addons.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/api/clients/${job.client_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        if (cancelled) return;
        const ct = d?.client_type === "commercial" ? "commercial" : "residential";
        setClientType(ct);
        const def = d?.commercial_hourly_rate != null ? Number(d.commercial_hourly_rate) : null;
        setClientDefaultRate(def);
        // If the job already has hourly_rate, keep that. Otherwise fall back
        // to the client default. If neither, leave at 0 (validation will block save).
        if (ct === "commercial" && (job.hourly_rate == null || Number(job.hourly_rate) <= 0) && def != null && def > 0) {
          setHourlyRate(def);
        }
      } catch {
        // Best-effort — falls through to residential default.
      } finally {
        if (!cancelled) setClientLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [API, token, job.client_id, job.hourly_rate]);

  // [AI.3] Load tenant-managed commercial service types. Active-only, sorted
  // server-side. Used to populate the Service Type dropdown (commercial branch)
  // and to pre-fill the hourly rate when a type is picked.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/api/commercial-service-types?active=true`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const d: CommercialServiceType[] = await r.json();
        if (cancelled) return;
        const list = Array.isArray(d) ? d : [];
        setCommercialServiceTypes(list);
        // [AI.4] If the job's existing service_type isn't in the active
        // tenant-managed list (legacy MC import value or a soft-deleted slug),
        // clear the dropdown. User must explicitly pick a real commercial
        // type before save. The (current) fallback option is gone — see
        // CLAUDE.md "Tenant-managed commercial service types".
        if (job.service_type && !list.some(t => t.slug === job.service_type)) {
          setCommercialServiceType("");
        }
      } catch {
        // Best-effort. If the fetch fails, dropdown will be empty and
        // canSave's "service type required" gate prevents accidental saves.
      }
    })();
    return () => { cancelled = true; };
  }, [API, token, job.service_type]);

  // [AI.1] Broadened: client_type='commercial' OR job has an account_id set.
  // The job-level account_id signal is defensive — MC import sometimes left
  // commercial clients tagged client_type='residential', and the dispatch
  // route already uses `!!j.account_id` as its commercial test (dispatch.ts).
  // Aligning here means jobs flagged commercial by either signal get the
  // commercial UI fork.
  const isCommercial = clientType === "commercial" || job.account_id != null;

  // ── Load scopes once ────────────────────────────────────────────────────
  // Skipped for commercial clients (modal uses the commercial dropdown instead).
  useEffect(() => {
    if (!clientLoaded) return;
    if (isCommercial) { setScopesLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/api/pricing/scopes`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        const list: PricingScope[] = Array.isArray(d) ? d : (d.data ?? []);
        if (cancelled) return;
        setScopes(list);
        // Best-effort match on name to current job.service_type label
        const guess = list.find(s =>
          s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").includes(job.service_type)
          || job.service_type.includes(s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"))
        );
        if (guess) setScopeId(guess.id);
        else if (list[0]) setScopeId(list[0].id);
      } catch {
        if (!cancelled) toast({ title: "Could not load pricing scopes", variant: "destructive" });
      } finally {
        if (!cancelled) setScopesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [API, token, job.service_type, toast, clientLoaded, isCommercial]);

  // ── Load addons whenever scope changes ─────────────────────────────────
  // For commercial: load /api/pricing/addons (full list) and filter to
  // Parking Fee client-side. For residential: load addons for the chosen
  // scope_id.
  useEffect(() => {
    if (!clientLoaded) return;
    if (!isCommercial && scopeId == null) return;
    let cancelled = false;
    setAddonsLoading(true);
    (async () => {
      try {
        const url = isCommercial
          ? `${API}/api/pricing/addons`
          : `${API}/api/pricing/scopes/${scopeId}/addons`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json();
        const rows: PricingAddon[] = Array.isArray(d) ? d : (d.data ?? d.rows ?? []);
        if (cancelled) return;
        if (isCommercial) {
          // [AH] Per decision 2: filter client-side by name. Parking Fee only.
          setAvailableAddons(rows.filter(a => /^parking fee$/i.test(a.name)));
        } else {
          setAvailableAddons(rows);
        }
      } catch {
        if (!cancelled) setAvailableAddons([]);
      } finally {
        if (!cancelled) setAddonsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [API, token, scopeId, clientLoaded, isCommercial]);

  // ── Recalc on input changes (debounced) ─────────────────────────────────
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (manualRate) return; // honor manual override; no recalc
    if (!clientLoaded) return;

    // [AH] Commercial path — client-side math, no round-trip.
    // base_fee = hourly_rate × allowed_hours + sum(selected commercial addons)
    if (isCommercial) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const hourly = Number(hourlyRate) || 0;
        const hrs = Number(allowedHours) || 0;
        const hourlyTotal = Math.round(hourly * hrs * 100) / 100;
        const addonBreakdown: { id: number; name: string; amount: number; price_type: string }[] = [];
        let addonsTotal = 0;
        for (const [aid, qty] of selectedAddons.entries()) {
          const a = availableAddons.find(x => x.id === aid);
          if (!a) continue;
          // [AI.2] Read price_value primarily (PHES seed populates this);
          // fall back to price for legacy rows. See PricingAddon interface.
          const unit = Number(a.price_value ?? a.price ?? 0);
          const amount = Math.round(unit * qty * 100) / 100;
          addonsTotal += amount;
          addonBreakdown.push({ id: a.id, name: a.name, amount, price_type: a.price_type });
        }
        const total = Math.round((hourlyTotal + addonsTotal) * 100) / 100;
        setCalcResult({
          base_price: hourlyTotal,
          addons_total: addonsTotal,
          bundle_discount: 0,
          addon_breakdown: addonBreakdown,
          total_hours: hrs,
          hourly_rate: hourly,
          subtotal: total,
          final_total: total,
        });
        setBaseFee(total);
        setCalcError("");
      }, 100);
      return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }

    // Residential path — pricing engine round-trip.
    if (scopeId == null) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setCalcBusy(true);
      setCalcError("");
      try {
        const r = await fetch(`${API}/api/pricing/calculate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            scope_id: scopeId,
            hours: allowedHours,
            frequency,
            addon_ids: Array.from(selectedAddons.keys()),
            addon_quantities: Object.fromEntries(
              Array.from(selectedAddons.entries()).map(([k, v]) => [String(k), v])
            ),
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Calc failed");
        setCalcResult(d);
        setBaseFee(Number(d.final_total ?? d.subtotal ?? 0));
      } catch (err: any) {
        setCalcError(err.message || "Could not calculate price");
      } finally {
        setCalcBusy(false);
      }
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [API, token, scopeId, allowedHours, frequency, selectedAddons, manualRate, clientLoaded, isCommercial, hourlyRate, availableAddons]);

  // ── Validation / dirty check ────────────────────────────────────────────
  const dirty = useMemo(() => {
    if (frequency !== job.frequency) return true;
    if (scheduledDate !== job.scheduled_date) return true;
    // [AI.5] Compare against normalized form so opening a job whose stored
    // time is "09:00:00" doesn't show as dirty just because we displayed
    // it as "09:00".
    if (normalizeTimeStr(job.scheduled_time) !== scheduledTime) return true;
    if (Math.abs(allowedHours - initialAllowedHours) > 0.001) return true;
    if (Math.abs(baseFee - initialBaseFee) > 0.01) return true;
    if ((job.notes || "") !== instructions) return true;
    if (manualRate) return true;
    if (selectedAddons.size > 0) return true;
    if (job.assigned_user_id != null && (selectedTechIds[0] !== job.assigned_user_id || selectedTechIds.length !== 1)) return true;
    if (job.assigned_user_id == null && selectedTechIds.length > 0) return true;
    // [AH] Commercial-only dirty checks
    if (isCommercial) {
      if (commercialServiceType !== job.service_type) return true;
      const prevRate = job.hourly_rate != null ? Number(job.hourly_rate) : 0;
      if (Math.abs(hourlyRate - prevRate) > 0.001) return true;
    }
    // [AI] Multi-day picker — frequency change to daily/weekdays/custom_days
    // already counts as dirty via the frequency check; days_of_week change
    // (when staying in custom_days) is also dirty.
    if (frequency === "custom_days" && daysOfWeek.length > 0) return true;
    return false;
  }, [frequency, scheduledDate, scheduledTime, allowedHours, baseFee, instructions, manualRate, selectedAddons, selectedTechIds, job, initialAllowedHours, initialBaseFee, isCommercial, commercialServiceType, hourlyRate, daysOfWeek]);

  // [AI.4] Commercial save requires a real tenant-managed service type slug.
  // Legacy MC-import values (e.g., 'standard_clean') get auto-cleared when
  // the modal loads — user must explicitly pick a current type. Save button
  // stays disabled with the inline "Service type required" message until
  // the dropdown selection lands on an active slug.
  const commercialServiceTypeValid = isCommercial
    ? commercialServiceType !== "" && commercialServiceTypes.some(t => t.slug === commercialServiceType)
    : true;

  const canSave = dirty
    && !saving
    && allowedHours > 0
    && selectedTechIds.length > 0
    && /^\d{2}:\d{2}$/.test(scheduledTime)
    // [AH] Commercial requires a positive hourly rate.
    && (!isCommercial || hourlyRate > 0)
    // [AI] custom_days requires at least one day checked.
    && (frequency !== "custom_days" || daysOfWeek.length > 0)
    // [AI.4] Commercial requires a valid service type from the active list.
    && commercialServiceTypeValid;

  // ── Cascade prompt or direct submit ─────────────────────────────────────
  function onSaveClick() {
    if (!canSave) return;
    if (isRecurring) {
      setCascadeChoice("this_job");
      setCascadePromptOpen(true);
      return;
    }
    submit("this_job");
  }

  async function submit(cascade: "this_job" | "this_and_future") {
    setSaving(true);
    try {
      // Build add-ons payload. We persist into job_add_ons via add_on_id (legacy
      // FK), but also pass pricing_addon_id for traceability per AG.
      // For now the simplest approach: write add_on_id = pricing_addon_id (DB
      // permits this since pricing_addons rows have similar shape). A future
      // pass can map distinct addon catalogs.
      const addOnsPayload = Array.from(selectedAddons.entries()).map(([pricingAddonId, qty]) => {
        const detail = calcResult?.addon_breakdown?.find(x => x.id === pricingAddonId);
        return {
          add_on_id: pricingAddonId,
          pricing_addon_id: pricingAddonId,
          qty,
          unit_price: detail ? Math.round((detail.amount / qty) * 100) / 100 : 0,
          subtotal: detail ? detail.amount : 0,
        };
      });

      const payload: Record<string, unknown> = {
        // Note: residential service_type omitted — we don't have a clean enum
        // mapping from pricing_scopes.id back to jobs.service_type yet
        // (decision 1c says no persist of scope_id). Frequency cascades regardless.
        frequency,
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        allowed_hours: allowedHours,
        base_fee: baseFee,
        manual_rate_override: manualRate,
        add_ons: addOnsPayload,
        team_user_ids: selectedTechIds,
        instructions,
        cascade_scope: cascade,
      };
      // [AH] Commercial-only fields. service_type is a real enum value the
      // user picked from the commercial dropdown; hourly_rate persists to
      // jobs.hourly_rate (and cascades to recurring_schedules.commercial_hourly_rate).
      if (isCommercial) {
        payload.service_type = commercialServiceType;
        payload.hourly_rate = hourlyRate;
      }
      // [AI] Multi-day fields. days_of_week is only meaningful when frequency
      // is one of the multi-day values; PATCH endpoint validates exclusivity.
      if (isMultiDayFreq) {
        if (frequency === "custom_days") {
          payload.days_of_week = [...daysOfWeek].sort();
        } else if (frequency === "daily") {
          payload.days_of_week = [0, 1, 2, 3, 4, 5, 6];
        } else if (frequency === "weekdays") {
          payload.days_of_week = [1, 2, 3, 4, 5];
        }
      }

      const r = await fetch(`${API}/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // [AI.6.2] Always log status + body so DevTools shows the actual server
      // response when "I hit Save but nothing happened" repros.
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error("[edit-job-modal] PATCH failed", { status: r.status, body: d, payload });
        if (r.status === 409) {
          toast({ title: "Cannot edit", description: d.message || "Job is locked or a tech is clocked in.", variant: "destructive" });
        } else {
          toast({ title: "Save failed", description: d.message || d.error || `HTTP ${r.status}`, variant: "destructive" });
        }
        return;
      }
      onSaved({
        future_jobs_updated: d.cascade?.future_jobs_updated ?? 0,
        future_jobs_skipped_in_progress: d.cascade?.future_jobs_skipped_in_progress ?? 0,
      });
    } catch (err) {
      // [AI.6.2] Surface the real exception so a network/CORS/parse failure
      // doesn't silently disappear under the modal.
      console.error("[edit-job-modal] PATCH exception", err);
      toast({ title: "Network error", description: "Could not save changes — see DevTools console", variant: "destructive" });
    } finally {
      setSaving(false);
      setCascadePromptOpen(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const overlay: React.CSSProperties = {
    position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 399,
  };
  const shell: React.CSSProperties = mobile
    ? {
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 400,
        backgroundColor: "#F7F6F3", borderRadius: "16px 16px 0 0",
        maxHeight: "92vh", display: "flex", flexDirection: "column", fontFamily: FF,
      }
    : {
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        zIndex: 400, backgroundColor: "#F7F6F3", borderRadius: 16,
        width: "100%", maxWidth: 680, maxHeight: "92vh",
        display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.25)", fontFamily: FF,
      };

  return (
    <>
      <div style={overlay} onClick={() => !saving && onClose()} />
      <div style={shell}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "18px 20px 16px", backgroundColor: "#FFFFFF",
          borderRadius: "16px 16px 0 0", borderBottom: "1px solid #E5E2DC", flexShrink: 0,
        }}>
          <div>
            <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1917" }}>Edit Job</span>
            <div style={{ fontSize: 12, color: "#6B6860", marginTop: 2 }}>{job.client_name}</div>
          </div>
          <button onClick={onClose} disabled={saving}
            style={{ background: "none", border: "none", cursor: saving ? "wait" : "pointer", padding: 6, display: "flex", alignItems: "center" }}>
            <X size={18} color="#6B6860" />
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", flex: 1, padding: "0 0 8px" }}>
          {/* Section 1 — Service */}
          <div style={SECTION}>
            <span style={LABEL}>{isCommercial ? "Service · Commercial" : "Service"}</span>
            {isCommercial ? (
              // [AH] Commercial fork: service_type dropdown + per-visit hourly
              // rate input + frequency. No pricing_scopes lookup.
              <>
                <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 10 }}>
                  <div>
                    <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Service type</span>
                    <select value={commercialServiceType}
                      onChange={e => {
                        const newSlug = e.target.value;
                        setCommercialServiceType(newSlug);
                        // [AI.3] Pre-fill hourly rate from picked service type's
                        // default. Only writes to job form state — does NOT update
                        // clients.commercial_hourly_rate (per AH per-client flow).
                        const match = commercialServiceTypes.find(t => t.slug === newSlug);
                        if (match && match.default_hourly_rate != null) {
                          const rate = Number(match.default_hourly_rate);
                          if (rate > 0) setHourlyRate(rate);
                        }
                      }}
                      style={INPUT}>
                      {/* [AI.4] Empty placeholder option — fires when the job's
                          service_type isn't in the active tenant-managed list
                          (legacy MC import, soft-deleted slug). User must pick
                          a real type before save. (current) fallback removed
                          per Sal's instruction. */}
                      {commercialServiceType === "" && (
                        <option value="" disabled>Select a service type…</option>
                      )}
                      {commercialServiceTypes.map(t => (
                        <option key={t.id} value={t.slug}>
                          {t.name}{t.default_hourly_rate != null
                            ? ` — $${Number(t.default_hourly_rate).toFixed(0)}/hr`
                            : ""}
                        </option>
                      ))}
                    </select>
                    {/* [AI.4] Inline validation: red message + Save disabled
                        until the user picks a tenant-managed slug. */}
                    {isCommercial && !commercialServiceTypeValid && (
                      <span style={{ fontSize: 11, color: "#991B1B", marginTop: 4, display: "block", fontWeight: 600 }}>
                        Service type required.
                      </span>
                    )}
                  </div>
                  <div>
                    <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Frequency</span>
                    <select value={frequency} onChange={e => setFrequency(e.target.value)} style={INPUT}>
                      <optgroup label="Standard">
                        {FREQUENCIES_STANDARD.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </optgroup>
                      <optgroup label="Commercial multi-day">
                        {FREQUENCIES_COMMERCIAL_MULTI.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </optgroup>
                    </select>
                  </div>
                </div>
                {/* [AI] Custom-days picker — 7 checkboxes, only when frequency='custom_days' */}
                {frequency === "custom_days" && (
                  <div style={{ marginTop: 10 }}>
                    <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 6 }}>
                      Days {daysOfWeek.length === 0 && (
                        <span style={{ color: "#D97706", fontWeight: 600 }}>· pick at least one</span>
                      )}
                    </span>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {DAY_PICKER.map(d => {
                        const checked = daysOfWeek.includes(d.value);
                        return (
                          <label key={d.value}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 4,
                              padding: "6px 10px", borderRadius: 6,
                              border: `1.5px solid ${checked ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                              backgroundColor: checked ? "rgba(0,201,160,0.07)" : "#F7F6F3",
                              fontSize: 12, fontFamily: FF, cursor: "pointer",
                              color: checked ? "var(--brand, #00C9A0)" : "#1A1917",
                              fontWeight: checked ? 700 : 500,
                            }}>
                            <input type="checkbox" checked={checked}
                              onChange={() => {
                                setDaysOfWeek(prev =>
                                  prev.includes(d.value) ? prev.filter(x => x !== d.value) : [...prev, d.value]
                                );
                              }} />
                            {d.short}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 10, marginTop: 10 }}>
                  <div>
                    <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Hourly rate</span>
                    {/* [AI.6] Mobile UX: $ / /hr labels are now adornments
                        baked into the input via padding + absolutely-positioned
                        spans rather than separate flex siblings — typing "50"
                        feels like one tap-and-type instead of fighting layout.
                        inputMode="decimal" surfaces the right mobile keyboard. */}
                    <div style={{ position: "relative" }}>
                      <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "#6B6860", pointerEvents: "none" }}>$</span>
                      <input type="number" min={0} step={0.01} inputMode="decimal"
                        value={hourlyRate === 0 ? "" : hourlyRate}
                        // [AI.6.1] No placeholder "0" — it read as a literal value
                        // users tried to backspace. Empty state stays empty.
                        // onFocus selects existing content so tapping a field with
                        // a value lets typing replace it (iOS-native expectation).
                        onFocus={e => e.target.select()}
                        onChange={e => {
                          const v = e.target.value;
                          const cleaned = v.replace(/^0+(?=\d)/, "");
                          setHourlyRate(parseFloat(cleaned) || 0);
                        }}
                        style={{ ...INPUT, paddingLeft: 26, paddingRight: 36 }} />
                      <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#9E9B94", pointerEvents: "none" }}>/hr</span>
                    </div>
                    {clientDefaultRate != null && Math.abs(hourlyRate - clientDefaultRate) > 0.001 && (
                      <span style={{ fontSize: 11, color: "#9E9B94", marginTop: 4, display: "block" }}>
                        Client default: ${clientDefaultRate.toFixed(2)}/hr
                      </span>
                    )}
                    {clientDefaultRate == null && (
                      <span style={{ fontSize: 11, color: "#D97706", marginTop: 4, display: "block" }}>
                        No client default set — <a href={`/clients/${job.client_id}`} style={{ color: "#1D4ED8", fontWeight: 600 }}>set one in the client profile</a>
                      </span>
                    )}
                  </div>
                  <div>
                    <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Allowed hours</span>
                    {/* [AI.6] Same mobile fix: inputMode hint + strip leading
                        zeros. Empty input = 0 (validation catches it). */}
                    <input type="number" min={0.25} step={0.25} inputMode="decimal"
                      value={allowedHours === 0 ? "" : allowedHours}
                      onFocus={e => e.target.select()}
                      onChange={e => {
                        const v = e.target.value.replace(/^0+(?=\d)/, "");
                        setAllowedHours(parseFloat(v) || 0);
                      }}
                      style={INPUT} />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 10 }}>
                  <div>
                    <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Scope</span>
                    <select value={scopeId ?? ""} onChange={e => setScopeId(parseInt(e.target.value))}
                      style={INPUT} disabled={scopesLoading}>
                      {scopesLoading ? <option>Loading…</option> : null}
                      {scopes.map(s => (
                        <option key={s.id} value={s.id}>{s.name} {s.scope_group ? `· ${s.scope_group}` : ""}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Frequency</span>
                    <select value={frequency} onChange={e => setFrequency(e.target.value)} style={INPUT}>
                      {/* Residential: only Standard group. Commercial multi-day options
                          are deliberately not exposed here. */}
                      {FREQUENCIES_STANDARD.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Allowed hours</span>
                  <input type="number" min={0.25} step={0.25} inputMode="decimal"
                    value={allowedHours === 0 ? "" : allowedHours}
                    onFocus={e => e.target.select()}
                    onChange={e => {
                      const v = e.target.value.replace(/^0+(?=\d)/, "");
                      setAllowedHours(parseFloat(v) || 0);
                    }}
                    style={INPUT} />
                </div>
              </>
            )}
          </div>

          {/* Section 2 — Schedule */}
          <div style={SECTION}>
            <span style={LABEL}>Schedule</span>
            <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 10 }}>
              <div>
                <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Date</span>
                <input type="date" value={scheduledDate}
                  onChange={e => setScheduledDate(e.target.value)} style={INPUT} />
              </div>
              <div>
                <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Start time</span>
                <input type="time" value={scheduledTime} step={900}
                  onChange={e => setScheduledTime(e.target.value)} style={INPUT} />
              </div>
            </div>
          </div>

          {/* Section 3 — Team */}
          <div style={SECTION}>
            <span style={LABEL}>Team {selectedTechIds.length > 1 ? `(${selectedTechIds.length})` : ""}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {employees.length === 0 && (
                <span style={{ fontSize: 12, color: "#9E9B94" }}>No technicians available</span>
              )}
              {employees.map(e => {
                const idx = selectedTechIds.indexOf(e.id);
                const selected = idx >= 0;
                const isPrimary = idx === 0 && selectedTechIds.length > 0;
                return (
                  <div key={e.id} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 12px", borderRadius: 8,
                    border: `1.5px solid ${selected ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                    backgroundColor: selected ? "rgba(0,201,160,0.07)" : "#F7F6F3",
                    cursor: "pointer", fontFamily: FF,
                  }}
                  onClick={() => {
                    setSelectedTechIds(prev => {
                      const cur = prev.indexOf(e.id);
                      if (cur >= 0) return prev.filter(id => id !== e.id);
                      return [...prev, e.id];
                    });
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="checkbox" checked={selected} readOnly />
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{e.name}</span>
                      {isPrimary && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#15803D", backgroundColor: "#DCFCE7", padding: "2px 6px", borderRadius: 4 }}>Primary</span>
                      )}
                    </div>
                    {selected && !isPrimary && (
                      <button onClick={ev => {
                        ev.stopPropagation();
                        setSelectedTechIds(prev => [e.id, ...prev.filter(id => id !== e.id)]);
                      }} style={{
                        fontSize: 11, color: "#1D4ED8", background: "none", border: "none",
                        cursor: "pointer", fontFamily: FF, fontWeight: 600,
                      }}>Set as primary</button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 4 — Add-ons */}
          <div style={SECTION}>
            <span style={LABEL}>Add-ons</span>
            {addonsLoading ? (
              <div style={{ fontSize: 12, color: "#9E9B94", display: "flex", alignItems: "center", gap: 6 }}>
                <Loader2 size={12} className="animate-spin" /> Loading add-ons…
              </div>
            ) : availableAddons.length === 0 ? (
              <span style={{ fontSize: 12, color: "#9E9B94" }}>No add-ons configured for this scope.</span>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {availableAddons.map(a => {
                  const checked = selectedAddons.has(a.id);
                  return (
                    <label key={a.id} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "8px 10px", borderRadius: 8,
                      border: `1px solid ${checked ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                      backgroundColor: checked ? "rgba(0,201,160,0.05)" : "#F7F6F3",
                      cursor: "pointer", fontFamily: FF,
                    }}>
                      <input type="checkbox" checked={checked}
                        onChange={() => {
                          setSelectedAddons(prev => {
                            const next = new Map(prev);
                            if (next.has(a.id)) next.delete(a.id);
                            else next.set(a.id, 1);
                            return next;
                          });
                        }} />
                      <span style={{ flex: 1, fontSize: 13, color: "#1A1917" }}>{a.name}</span>
                      <span style={{ fontSize: 12, color: "#6B6860" }}>
                        {/* [AI.2] price_value is the canonical column; price_type
                            seeded as 'percentage' (not 'percent'), accept both. */}
                        {(() => {
                          const v = a.price_value ?? a.price ?? 0;
                          const isPct = a.price_type === "percent" || a.price_type === "percentage";
                          return isPct ? `${v}%` : `$${Number(v).toFixed(0)}`;
                        })()}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {calcResult?.bundle_breakdown && calcResult.bundle_breakdown.length > 0 && (
              <div style={{ marginTop: 8, padding: "6px 10px", backgroundColor: "#F0FDF4", borderRadius: 6, border: "1px solid #BBF7D0" }}>
                {calcResult.bundle_breakdown.map(b => (
                  <div key={b.name} style={{ fontSize: 11, color: "#166534", fontWeight: 600 }}>
                    Bundle: {b.name} − ${b.discount.toFixed(0)}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 5 — Pricing */}
          <div style={SECTION}>
            <span style={LABEL}>Pricing</span>
            {calcError && (
              <div style={{ fontSize: 12, color: "#991B1B", marginBottom: 8 }}>{calcError}</div>
            )}
            {/* [AH] Commercial breakdown — show "$50/hr × 6 = $300 + $20 parking" */}
            {isCommercial && !manualRate && (
              <div style={{ fontSize: 12, color: "#6B6860", marginBottom: 8, lineHeight: 1.5 }}>
                ${hourlyRate.toFixed(2)}/hr × {allowedHours} hrs = ${(hourlyRate * allowedHours).toFixed(2)}
                {calcResult?.addon_breakdown?.map(a => ` + $${a.amount.toFixed(2)} ${a.name.toLowerCase()}`).join("")}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 14, color: "#6B6860" }}>Current</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#1A1917" }}>${initialBaseFee.toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
              <span style={{ fontSize: 14, color: "#6B6860" }}>New</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: "#1A1917" }}>
                {calcBusy ? "…" : `$${baseFee.toFixed(2)}`}
              </span>
            </div>
            {/* [AI.6] Delta is rendered on its own row in muted parens copy
                — was inline next to "New $X" with red/green color which read
                as a discount line item (Sal feedback). Now reads as
                "$50 less than current" — clearly framed as comparison. */}
            {!calcBusy && Math.abs(baseFee - initialBaseFee) > 0.01 && (
              <div style={{ marginTop: 4, fontSize: 12, color: "#6B6860", textAlign: "right" as const }}>
                ({Math.abs(baseFee - initialBaseFee).toFixed(2) === "0.00" ? "no change" :
                  baseFee > initialBaseFee
                    ? `$${(baseFee - initialBaseFee).toFixed(2)} more than current`
                    : `$${(initialBaseFee - baseFee).toFixed(2)} less than current`})
              </div>
            )}
            {manualRate && (
              <div style={{ marginTop: 8, padding: "6px 10px", backgroundColor: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 6, fontSize: 12, color: "#92400E", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={12} /> Manual rate active
                </span>
                <button onClick={() => { setManualRate(false); setManualOpen(false); }}
                  style={{ fontSize: 11, color: "#92400E", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>
                  Reset to calculated
                </button>
              </div>
            )}
            {!manualOpen && !manualRate && (
              <button onClick={() => { setManualOpen(true); setManualValue(baseFee.toFixed(2)); }}
                style={{ marginTop: 8, fontSize: 12, color: "#1D4ED8", background: "none", border: "none", cursor: "pointer", fontFamily: FF, fontWeight: 600, padding: 0 }}>
                Override rate
              </button>
            )}
            {manualOpen && !manualRate && (
              <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "#6B6860" }}>$</span>
                <input type="number" min={0} step={0.01} value={manualValue}
                  onChange={e => setManualValue(e.target.value)}
                  style={{ ...INPUT, width: 140 }} />
                <button onClick={() => {
                  const v = parseFloat(manualValue);
                  if (!isNaN(v) && v >= 0) {
                    setBaseFee(v); setManualRate(true); setManualOpen(false);
                  }
                }} style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: "var(--brand, #00C9A0)", border: "none", borderRadius: 6, padding: "8px 12px", cursor: "pointer", fontFamily: FF }}>
                  Apply
                </button>
                <button onClick={() => setManualOpen(false)} style={{ fontSize: 12, color: "#6B7280", background: "none", border: "none", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              </div>
            )}
          </div>

          {/* Section 6 — Instructions */}
          <div style={SECTION}>
            <span style={LABEL}>Instructions</span>
            <textarea value={instructions} onChange={e => setInstructions(e.target.value)}
              placeholder="Notes for technicians on this job…"
              rows={4}
              style={{ ...INPUT, height: "auto", padding: "10px 12px", lineHeight: 1.5, resize: "vertical" }} />
          </div>

          <div style={{ height: 16 }} />
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #E5E2DC", backgroundColor: "#FFFFFF", flexShrink: 0, display: "flex", gap: 8 }}>
          <button onClick={onClose} disabled={saving}
            style={{ flex: 1, padding: "12px", border: "1px solid #E5E2DC", borderRadius: 10, background: "#FFFFFF", color: "#6B7280", fontSize: 14, fontWeight: 600, cursor: saving ? "wait" : "pointer", fontFamily: FF }}>
            Cancel
          </button>
          <button onClick={onSaveClick} disabled={!canSave}
            style={{ flex: 2, padding: "12px", border: "none", borderRadius: 10, background: canSave ? "var(--brand, #00C9A0)" : "#E5E2DC", color: canSave ? "#FFFFFF" : "#9E9B94", fontSize: 14, fontWeight: 700, cursor: canSave ? "pointer" : "not-allowed", fontFamily: FF }}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {/* Cascade prompt */}
      {cascadePromptOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 410 }} />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            zIndex: 411, backgroundColor: "#FFFFFF", borderRadius: 14, padding: 24,
            width: "100%", maxWidth: 420, fontFamily: FF, boxShadow: "0 16px 48px rgba(0,0,0,0.3)",
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", marginBottom: 6 }}>Recurring job</div>
            <div style={{ fontSize: 13, color: "#6B6860", marginBottom: 16, lineHeight: 1.5 }}>
              This job is part of a recurring schedule. Apply changes to:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
              {[
                { v: "this_job" as const, label: "This job only", sub: "Other future jobs in this schedule won't change." },
                { v: "this_and_future" as const, label: "This and all future occurrences", sub: "Updates the schedule template + all future scheduled jobs." },
              ].map(opt => {
                const sel = cascadeChoice === opt.v;
                return (
                  <button key={opt.v} type="button" onClick={() => setCascadeChoice(opt.v)}
                    style={{
                      textAlign: "left", padding: "12px 14px", borderRadius: 10,
                      border: `1.5px solid ${sel ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                      backgroundColor: sel ? "rgba(0,201,160,0.07)" : "#F7F6F3",
                      cursor: "pointer", fontFamily: FF,
                    }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: "#6B6860", marginTop: 2 }}>{opt.sub}</div>
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setCascadePromptOpen(false)} disabled={saving}
                style={{ flex: 1, padding: "10px", borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B7280", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                Cancel
              </button>
              <button onClick={() => submit(cascadeChoice)} disabled={saving}
                style={{ flex: 2, padding: "10px", borderRadius: 8, border: "none", background: "var(--brand, #00C9A0)", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: saving ? "wait" : "pointer", fontFamily: FF }}>
                {saving ? "Applying…" : "Apply changes"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
