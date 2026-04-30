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

// [PR / 2026-04-30] Field-scope classification for the cascade picker.
//
// This is product judgment, not technical truth — the lists may shift
// as we learn how operators use the modal. Today's read:
//
//   "Schedule-template" fields ARE the schedule. Editing them means
//   "I want this schedule template to look different from now on."
//   There's no plausible "just for today" interpretation, so prompting
//   the operator to choose a scope just adds noise to the obvious
//   answer (this_and_future). We auto-cascade.
//
//   "Single-occurrence" fields could plausibly be one-off (today's
//   tech called off, today's notes have a special note for the
//   customer, today's date is a reschedule). We show the picker so
//   the operator can pick scope.
//
// Mixed edits (both buckets touched in one save): we show the picker
// with an honest footnote per Sal's Q1 = (c) — "Choosing 'Just this
// visit' will NOT update the schedule template — your <field> change
// will apply to today only." Single cascade_scope on the wire keeps
// the backend simple; the operator chooses with full context.
//
// Adding a field: pick the bucket that matches the operator's mental
// model. When in doubt, lean "occurrence" (showing the picker is
// safer than auto-cascading the wrong scope).
type FieldScope = "template" | "occurrence";
export const FIELD_SCOPE_CLASSIFICATION: Record<string, FieldScope> = {
  // Schedule-template — editing these IS editing the recurring
  // schedule's identity. Auto-cascade.
  frequency:           "template",
  days_of_week:        "template",
  scheduled_time:      "template",
  allowed_hours:       "template",
  service_type:        "template",
  hourly_rate:         "template",
  base_fee:            "template",
  add_ons:             "template",
  parking_fee_enabled: "template",
  parking_fee_amount:  "template",
  parking_fee_days:    "template",
  // Single-occurrence — editing these could plausibly be a one-off.
  // Show the picker so the operator decides scope.
  team_user_ids:       "occurrence",
  instructions:        "occurrence",
  scheduled_date:      "occurrence",
};

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
  // Hydrated from the recurring_schedules.days_of_week preload below so the
  // modal opens with the user's existing pattern checked. Without preload,
  // canSave blocked the user from saving custom_days jobs (empty array
  // failed the required-day gate) and any save reset the schedule pattern
  // to whatever the user re-picked.
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const isMultiDayFreq = frequency === "daily" || frequency === "weekdays" || frequency === "custom_days";

  // [AI.7.1] Parking-fee schedule-level config. Mirrors the three columns
  // on recurring_schedules. parkingFeeDays is an int[] of weekdays (0=Sun..
  // 6=Sat) — a SUBSET of days_of_week tells the engine "apply parking only
  // on these days," and 7-day or null means "every scheduled day".
  // The day picker renders only when isCommercial && parking is checked
  // && (isMultiDayFreq OR isRecurring), since a single-day schedule has
  // exactly one weekday and parking either applies or doesn't.
  const [parkingFeeAmount, setParkingFeeAmount] = useState<number | null>(null);
  const [parkingFeeDays, setParkingFeeDays] = useState<number[] | null>(null);

  // Snapshot of existing schedule-level parking config so dirty-check can
  // tell whether the user toggled parking, changed amount, or expanded the
  // day set. Updated only by the preload effect.
  const [parkingFeeEnabledInitial, setParkingFeeEnabledInitial] = useState<boolean>(false);
  const [parkingFeeAmountInitial, setParkingFeeAmountInitial] = useState<number | null>(null);
  const [parkingFeeDaysInitial, setParkingFeeDaysInitial] = useState<number[] | null>(null);

  // Snapshot of existing job add-ons so dirty-check can detect when the
  // user added/removed an addon (not just on quantity change). Map<pricing_addon_id, qty>.
  const [initialSelectedAddons, setInitialSelectedAddons] = useState<Map<number, number>>(new Map());

  const [calcResult, setCalcResult] = useState<CalcResponse | null>(null);
  const [calcBusy, setCalcBusy] = useState(false);
  const [calcError, setCalcError] = useState<string>("");

  // [cascade-scope 2026-04-29] Four cascade options now. 'remove_this'
  // shares the write path with 'this_job' but lets the operator signal
  // intent ("skip the schedule's default add-on for this visit only").
  // 'all' updates the template + every non-paid occurrence including
  // past — the route warns when there are paid past jobs.
  // [recurring-on-save 2026-04-30] 'create_recurring' is sent silently
  // (no prompt UI) when the operator hits Save on a one-off job whose
  // form-level frequency is now recurring. The route creates the
  // schedule + links the current job + fans out 60d in one transaction.
  // The form is the source of truth: whatever the dropdown says when
  // they hit Save is what should happen. No second confirm.
  type CascadeChoice = "this_job" | "this_and_future" | "all" | "remove_this" | "create_recurring";
  const [cascadePromptOpen, setCascadePromptOpen] = useState(false);
  const [cascadeChoice, setCascadeChoice] = useState<CascadeChoice>("this_job");
  // [PR / 2026-04-30] Set true when onSaveClick detected a mixed edit
  // (BOTH template + occurrence fields changed). Renders a footnote in
  // the cascade prompt explaining what "Just this visit" will and
  // won't do. See FIELD_SCOPE_CLASSIFICATION at the top of this file.
  const [mixedEditWarning, setMixedEditWarning] = useState<{ template: string[]; occurrence: string[] } | null>(null);
  // [edit-decouple 2026-04-29] When the route returns warn=true, we
  // open this confirmation dialog. User confirms → we re-submit with
  // force_unlock: true so per-field warn locks pass through.
  const [warnPrompt, setWarnPrompt] = useState<{ message: string; field?: string } | null>(null);

  const [saving, setSaving] = useState(false);

  // [PR / 2026-04-30] Persistent in-modal banner for the last save
  // error. Toast machinery is fleeting + easy to miss when the
  // operator's eye is on the cascade prompt. Banner sits above the
  // footer until the next save attempt clears it. Banner copy =
  // verbatim API error message (so the operator distinguishes
  // field-lock vs network vs validation), not a generic "save
  // failed" — no information loss.
  const [lastSaveError, setLastSaveError] = useState<{ title: string; message: string } | null>(null);

  // [PR / 2026-04-30] Cascade dry-run preview. cascadePreviewEnabled
  // gates the "Preview changes" button — fetched from
  // /api/config/feature-flags on modal mount, default false. Sal
  // flips CASCADE_PREVIEW_ENABLED=true in Railway env to expose the
  // button. previewResult holds the dry-run counters (or null when
  // no preview is active).
  const [cascadePreviewEnabled, setCascadePreviewEnabled] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<Record<string, unknown> | null>(null);

  // [PR / 2026-04-30] Fetch runtime feature flags once on mount.
  // Cheap (single GET, single bool) and lets us flip
  // CASCADE_PREVIEW_ENABLED in Railway without rebuilding the
  // bundle. Failure-mode is silent: flag stays false, button stays
  // hidden — same outcome as default-off.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/api/config/feature-flags`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;
        setCascadePreviewEnabled(!!d?.cascade_preview);
      } catch {
        // Silent — flag stays default false.
      }
    })();
    return () => { cancelled = true; };
  }, [API, token]);

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

  // [AI.7.1] Preload existing job state. Fetches GET /api/jobs/:id which
  // returns existing_add_ons (so selectedAddons reflects what's already
  // saved — without this, hitting Save with parking already enabled
  // wiped the row because PATCH replaces the full add_ons set with
  // whatever the modal sent), recurring_schedule snapshot (days_of_week
  // + parking_fee_*), and account_id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/api/jobs/${job.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;

        // Existing add-ons → selectedAddons (keyed by pricing_addon_id).
        const existing = Array.isArray(d.existing_add_ons) ? d.existing_add_ons : [];
        const addonMap = new Map<number, number>();
        for (const a of existing) {
          if (a.pricing_addon_id != null) {
            addonMap.set(Number(a.pricing_addon_id), Number(a.quantity ?? 1));
          }
        }
        setSelectedAddons(addonMap);
        setInitialSelectedAddons(addonMap);

        // Recurring schedule snapshot.
        const rs = d.recurring_schedule;
        if (rs) {
          if (Array.isArray(rs.days_of_week)) {
            setDaysOfWeek(rs.days_of_week);
          }
          setParkingFeeEnabledInitial(!!rs.parking_fee_enabled);
          setParkingFeeAmountInitial(rs.parking_fee_amount != null ? Number(rs.parking_fee_amount) : null);
          setParkingFeeDaysInitial(Array.isArray(rs.parking_fee_days) ? rs.parking_fee_days : null);
          setParkingFeeAmount(rs.parking_fee_amount != null ? Number(rs.parking_fee_amount) : null);
          setParkingFeeDays(Array.isArray(rs.parking_fee_days) ? rs.parking_fee_days : null);
        }
      } catch {
        // Best-effort. If the preload fails the modal still opens with
        // baseline state; user can re-check parking explicitly.
      }
    })();
    return () => { cancelled = true; };
  }, [API, token, job.id]);

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
    // [AI.7.1] Compare addon set against the snapshot loaded from
    // job_add_ons. Without this, opening a job with parking already
    // saved made selectedAddons.size > 0 always true, which marked the
    // modal dirty on open and let the user save without changing anything.
    // Worse, if they intended to ONLY change something else (e.g. hours),
    // the PATCH replaced job_add_ons with the same set — fine — but if
    // the preload race lost (request canceled), selectedAddons stayed
    // empty and the save wiped parking.
    const addonsSame = selectedAddons.size === initialSelectedAddons.size
      && Array.from(selectedAddons.entries()).every(([k, v]) => initialSelectedAddons.get(k) === v);
    if (!addonsSame) return true;
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
    // [AI.7.1] Parking-fee schedule cascade — toggle, amount change, or
    // day-set change all require a save to propagate to the schedule.
    const parkingAddon = availableAddons.find(a => /^parking fee$/i.test(a.name));
    const parkingNowChecked = !!parkingAddon && selectedAddons.has(parkingAddon.id);
    if (parkingNowChecked !== parkingFeeEnabledInitial) return true;
    if (parkingFeeAmount !== parkingFeeAmountInitial) return true;
    const initDays = parkingFeeDaysInitial == null ? null : [...parkingFeeDaysInitial].sort();
    const curDays = parkingFeeDays == null ? null : [...parkingFeeDays].sort();
    if (JSON.stringify(initDays) !== JSON.stringify(curDays)) return true;
    return false;
  }, [frequency, scheduledDate, scheduledTime, allowedHours, baseFee, instructions, manualRate, selectedAddons, initialSelectedAddons, selectedTechIds, job, initialAllowedHours, initialBaseFee, isCommercial, commercialServiceType, hourlyRate, daysOfWeek, availableAddons, parkingFeeAmount, parkingFeeAmountInitial, parkingFeeDays, parkingFeeDaysInitial, parkingFeeEnabledInitial]);

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
  // [recurring-on-save 2026-04-30] Three branches now:
  //   (1) Job is already recurring → existing 4-option cascade prompt.
  //   (2) Job is one-off but the form-level frequency is recurring
  //       (anything except on_demand) → silently submit with
  //       cascade_scope='create_recurring'. Route creates the schedule,
  //       links this job, fans out 60d. Save means save — operators
  //       don't want a second confirm step on top of the dropdown they
  //       just changed.
  //   (3) One-off staying one-off → default cascade='this_job'.
  // The PATCH route also rejects mismatched scope+frequency combos
  // (e.g. cascade='this_job' with a recurring frequency on a one-off)
  // to close the silent-days_of_week-drop bug for any caller.
  // [PR / 2026-04-30] Compute which fields actually changed and bucket
  // them by FIELD_SCOPE_CLASSIFICATION. Mirrors the per-field checks
  // already present in `dirty` above — kept separate (rather than
  // refactored into a single shared diff) because `dirty` only needs
  // a boolean, while this needs the field-name set + bucket label.
  // Each field uses the same canonical names FIELD_SCOPE_CLASSIFICATION
  // keys on; downstream consumers can grep one source.
  function getChangedFieldsByScope(): { template: string[]; occurrence: string[] } {
    const template: string[] = [];
    const occurrence: string[] = [];
    const push = (field: string) => {
      const bucket = FIELD_SCOPE_CLASSIFICATION[field];
      if (bucket === "template") template.push(field);
      else if (bucket === "occurrence") occurrence.push(field);
    };

    if (frequency !== job.frequency) push("frequency");
    if (scheduledDate !== job.scheduled_date) push("scheduled_date");
    if (normalizeTimeStr(job.scheduled_time) !== scheduledTime) push("scheduled_time");
    if (Math.abs(allowedHours - initialAllowedHours) > 0.001) push("allowed_hours");
    if (Math.abs(baseFee - initialBaseFee) > 0.01) push("base_fee");
    if ((job.notes || "") !== instructions) push("instructions");

    const addonsSame = selectedAddons.size === initialSelectedAddons.size
      && Array.from(selectedAddons.entries()).every(([k, v]) => initialSelectedAddons.get(k) === v);
    if (!addonsSame) push("add_ons");

    const techSame = (job.assigned_user_id != null
      && selectedTechIds[0] === job.assigned_user_id
      && selectedTechIds.length === 1)
      || (job.assigned_user_id == null && selectedTechIds.length === 0);
    if (!techSame) push("team_user_ids");

    if (isCommercial) {
      if (commercialServiceType !== job.service_type) push("service_type");
      const prevRate = job.hourly_rate != null ? Number(job.hourly_rate) : 0;
      if (Math.abs(hourlyRate - prevRate) > 0.001) push("hourly_rate");
    }

    if (frequency === "custom_days") {
      // days_of_week change is meaningful inside a custom_days schedule;
      // for other frequencies the modal doesn't expose the field.
      const initDays = (job as any).days_of_week as number[] | null | undefined;
      const sameDays = Array.isArray(initDays)
        && initDays.length === daysOfWeek.length
        && initDays.every((d, i) => d === daysOfWeek[i]);
      if (!sameDays) push("days_of_week");
    }

    const parkingAddon = availableAddons.find(a => /^parking fee$/i.test(a.name));
    const parkingNowChecked = !!parkingAddon && selectedAddons.has(parkingAddon.id);
    if (parkingNowChecked !== parkingFeeEnabledInitial) push("parking_fee_enabled");
    if (parkingFeeAmount !== parkingFeeAmountInitial) push("parking_fee_amount");
    const initParkingDays = parkingFeeDaysInitial == null ? null : [...parkingFeeDaysInitial].sort();
    const curParkingDays = parkingFeeDays == null ? null : [...parkingFeeDays].sort();
    if (JSON.stringify(initParkingDays) !== JSON.stringify(curParkingDays)) push("parking_fee_days");

    return { template, occurrence };
  }

  function onSaveClick() {
    if (!canSave) return;

    // One-off jobs (no schedule attached): existing PR #25 flow —
    // create_recurring on freq-change-to-recurring, else this_job.
    // The picker isn't relevant here.
    if (!isRecurring) {
      const isFreqRecurring = !!frequency && frequency !== "on_demand";
      submit(isFreqRecurring ? "create_recurring" : "this_job");
      return;
    }

    // [PR / 2026-04-30] Recurring job — classify the diff and branch:
    //   template-only → auto-cascade (this_and_future), no picker.
    //                   Editing schedule-template fields IS editing
    //                   the schedule; the second screen would just ask
    //                   the same question wearing different clothes.
    //   occurrence-only → existing 4-option picker.
    //   mixed → picker WITH footnote per Sal's Q1 = (c). Single
    //           cascade_scope on the wire; operator picks with full
    //           context about the trade-off.
    const { template, occurrence } = getChangedFieldsByScope();
    if (template.length > 0 && occurrence.length === 0) {
      submit("this_and_future");
      return;
    }
    if (occurrence.length > 0 && template.length === 0) {
      setMixedEditWarning(null);
      setCascadeChoice("this_job");
      setCascadePromptOpen(true);
      return;
    }
    // Mixed.
    setMixedEditWarning({ template, occurrence });
    setCascadeChoice("this_job");
    setCascadePromptOpen(true);
  }

  async function submit(cascade: CascadeChoice, opts?: { force_unlock?: boolean; dry_run?: boolean }) {
    if (opts?.dry_run) setPreviewing(true); else setSaving(true);
    // [PR / 2026-04-30] Clear stale error banner at the start of
    // every save attempt so retries don't show outdated messages.
    setLastSaveError(null);
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
        // [PR / 2026-04-30] Dry-run flag forwarded when the operator
        // clicked "Preview changes". Backend runs the cascade tx as
        // normal, captures counters, then ROLLBACKs at the end of the
        // tx. Production state stays untouched. Response shape carries
        // `dry_run: true` and `cascade.future_jobs_would_be_*`.
        dry_run: opts?.dry_run === true,
        // [edit-decouple 2026-04-29] When the route returned warn=true on
        // a previous attempt and the operator confirmed in the dialog,
        // we replay the request with this flag set so per-field warn
        // locks (price-on-completed, all-with-paid-past) pass through.
        force_unlock: opts?.force_unlock === true,
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

      // [AI.7.1] Parking-fee cascade. Pass schedule-level config whenever
      // commercial + recurring; PATCH route writes it onto recurring_schedules
      // when cascade=this_and_future. parking_fee_days = null means "every
      // scheduled visit" per the engine's interpretation.
      // [commercial-workflow PR #4 / 2026-04-29] Single-day frequencies
      // force parking_fee_days=NULL — the picker is hidden in that case
      // (see render gate above) so any stale array in state from a prior
      // multi-day session would silently scope parking to weekdays the
      // engine never generates, with parking effectively never stamped.
      // This mirrors customer-profile.tsx:3281–3287 which already guards
      // the recurring-schedule editor save path the same way.
      if (isCommercial && isRecurring) {
        const parkingAddon = availableAddons.find(a => /^parking fee$/i.test(a.name));
        const parkingNowChecked = !!parkingAddon && selectedAddons.has(parkingAddon.id);
        payload.parking_fee_enabled = parkingNowChecked;
        payload.parking_fee_amount = parkingFeeAmount;
        payload.parking_fee_days = parkingNowChecked && isMultiDayFreq
          ? (parkingFeeDays != null && parkingFeeDays.length < 7 ? [...parkingFeeDays].sort() : null)
          : null;
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
        // [edit-decouple 2026-04-29] 409 + warn=true is a "are you sure"
        // signal — surface a confirm dialog and let the operator re-submit
        // with force_unlock: true. Other 409s stay as terminal errors
        // (cancelled job, hard-locked field, tech clocked in).
        if (r.status === 409 && d.warn === true) {
          setWarnPrompt({ message: d.message || "This change requires confirmation.", field: d.field });
          setCascadePromptOpen(false);
        } else {
          // [PR / 2026-04-30] Persistent in-modal banner. Mirrors
          // the toast (transient confirmation) but stays put until
          // the operator's next save attempt clears it. Verbatim
          // API message — no information loss between "field locked"
          // and "tech clocked in" and "validation failed".
          const apiMessage = d.message || d.error || `HTTP ${r.status}`;
          const title = r.status === 409 ? "Cannot edit" : "Save failed";
          setLastSaveError({ title, message: apiMessage });
          toast({ title, description: apiMessage, variant: "destructive" });
        }
        return;
      }
      // [PR / 2026-04-30] Dry-run branch: capture counters into the
      // preview panel and return WITHOUT closing the modal — the
      // operator reviews the projected effect, then either clicks
      // Save changes (real commit) or Cancel preview (clear panel,
      // continue editing). Modal stays open; nothing was persisted.
      if (opts?.dry_run) {
        setPreviewResult(d.cascade ?? {});
        return;
      }
      // [PR / 2026-04-30] Compose an honest success summary from the
      // route's response. Examples:
      //   "Schedule updated. 4 future jobs reflect new times."
      //   "Schedule updated. 4 future jobs reflect new times.
      //    Monday's completed job is unchanged (frequency, base_fee
      //    stayed frozen)."
      // The anchor_protected piece only renders when the route
      // stripped lock-protected fields from the anchor's setParts
      // (completed-anchor + cascadesToTemplate). Everything else
      // gets the simpler version.
      const summaryParts: string[] = [];
      if (d.cascade?.schedule_updated) summaryParts.push("Schedule updated.");
      const futureN = Number(d.cascade?.future_jobs_updated ?? 0);
      if (futureN > 0) summaryParts.push(`${futureN} future job${futureN === 1 ? "" : "s"} reflect new times.`);
      if (d.cascade?.anchor_protected) {
        const fields: string[] = Array.isArray(d.cascade?.anchor_skipped_fields) ? d.cascade.anchor_skipped_fields : [];
        const fieldList = fields.length > 0 ? ` (${fields.join(", ")} stayed frozen)` : "";
        summaryParts.push(`This visit is unchanged${fieldList}.`);
      }
      if (summaryParts.length > 0) {
        toast({ title: "Saved", description: summaryParts.join(" ") });
      }
      onSaved({
        future_jobs_updated: futureN,
        future_jobs_skipped_in_progress: d.cascade?.future_jobs_skipped_in_progress ?? 0,
      });
    } catch (err) {
      // [AI.6.2] Surface the real exception so a network/CORS/parse failure
      // doesn't silently disappear under the modal.
      console.error("[edit-job-modal] PATCH exception", err);
      const networkMsg = opts?.dry_run ? "Preview failed — see DevTools console" : "Could not save changes — see DevTools console";
      // [PR / 2026-04-30] Pin a network-error banner the same way as
      // an HTTP error — same persistence semantics so an operator
      // who wandered off doesn't miss the failure.
      if (!opts?.dry_run) setLastSaveError({ title: "Network error", message: networkMsg });
      toast({ title: "Network error", description: networkMsg, variant: "destructive" });
    } finally {
      if (opts?.dry_run) setPreviewing(false); else setSaving(false);
      if (!opts?.dry_run) {
        setCascadePromptOpen(false);
        setMixedEditWarning(null);
      }
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

            {/* [AI.7.1] Parking-fee day picker. Renders when commercial +
                recurring + parking is checked. Default = schedule's
                days_of_week (or all 7 days if the schedule is single-day).
                Toggling days here writes recurring_schedules.parking_fee_days
                via the cascade=this_and_future PATCH path so future
                occurrences inherit the choice. "All days" sets the array
                to [0..6]; the engine treats null/full-7 as "every visit".
                For Jaira (M/F custom_days) the default is [1,5]; user
                can expand to [0..6] if parking should also apply to ad-hoc
                visits scheduled on other weekdays. */}
            {(() => {
              const parkingAddon = availableAddons.find(a => /^parking fee$/i.test(a.name));
              const isParkingChecked = !!parkingAddon && selectedAddons.has(parkingAddon.id);
              // [commercial-workflow PR #4 / 2026-04-29] Day-picker hidden
              // on single-day frequencies. Weekly / biweekly / every_3_weeks
              // / monthly / custom fire on exactly one weekday per
              // occurrence — there's no choice for the operator to make,
              // so the picker is meaningless and just adds confusion. The
              // picker stays for daily / weekdays / custom_days where
              // multiple weekdays fire and per-day scoping is real. The
              // matching save guard below forces parking_fee_days=NULL on
              // single-day frequencies regardless of state, mirroring the
              // engine's "NULL = apply to every visit" semantic and the
              // already-correct save logic in customer-profile.tsx
              // (lines 3281–3287). Sibling logic in the recurring-schedule
              // editor (customer-profile.tsx:3466) already gates on
              // frequency the same way; this closes the parity gap.
              if (!isCommercial || !parkingAddon || !isParkingChecked || !isRecurring || !isMultiDayFreq) return null;
              const dayLabels: { v: number; l: string }[] = [
                { v: 0, l: "Sun" }, { v: 1, l: "Mon" }, { v: 2, l: "Tue" },
                { v: 3, l: "Wed" }, { v: 4, l: "Thu" }, { v: 5, l: "Fri" }, { v: 6, l: "Sat" },
              ];
              const scheduledDays = new Set(daysOfWeek);
              const effectiveDays = parkingFeeDays != null ? new Set(parkingFeeDays) : new Set(daysOfWeek);
              const isAllDays = parkingFeeDays != null && parkingFeeDays.length === 7;
              return (
                <div style={{
                  marginTop: 10, padding: "10px 12px", borderRadius: 8,
                  backgroundColor: "rgba(0,201,160,0.04)", border: "1px solid rgba(0,201,160,0.25)",
                }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#1A1917", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                    Apply parking on
                  </div>
                  <div style={{ fontSize: 11, color: "#6B6860", marginBottom: 10, lineHeight: 1.4 }}>
                    Future {job.client_name} occurrences will get a parking-fee row when their date falls on a checked day. Save with "this and all future occurrences" to apply.
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                    {dayLabels.map(d => {
                      const checked = effectiveDays.has(d.v);
                      const isScheduled = scheduledDays.has(d.v);
                      return (
                        <button key={d.v} type="button"
                          onClick={() => {
                            const base = parkingFeeDays != null ? [...parkingFeeDays] : [...daysOfWeek];
                            const idx = base.indexOf(d.v);
                            if (idx >= 0) base.splice(idx, 1);
                            else base.push(d.v);
                            base.sort();
                            setParkingFeeDays(base);
                          }}
                          style={{
                            minWidth: 44, minHeight: 32, padding: "0 10px", borderRadius: 6,
                            border: `1.5px solid ${checked ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                            backgroundColor: checked ? "var(--brand, #00C9A0)" : "#FFFFFF",
                            color: checked ? "#FFFFFF" : (isScheduled ? "#1A1917" : "#9E9B94"),
                            fontSize: 12, fontWeight: 700, fontFamily: FF, cursor: "pointer",
                          }}>
                          {d.l}
                          {isScheduled && !checked && <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.6 }}>·sch</span>}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button"
                      onClick={() => setParkingFeeDays([...daysOfWeek].sort())}
                      style={{ fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 6, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B6860", cursor: "pointer", fontFamily: FF }}>
                      Match schedule ({daysOfWeek.length > 0 ? daysOfWeek.map(d => dayLabels[d].l.slice(0,1)).join("") : "—"})
                    </button>
                    <button type="button"
                      onClick={() => setParkingFeeDays([0,1,2,3,4,5,6])}
                      style={{
                        fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 6,
                        border: `1px solid ${isAllDays ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                        background: isAllDays ? "rgba(0,201,160,0.08)" : "#FFFFFF",
                        color: isAllDays ? "var(--brand, #00C9A0)" : "#6B6860",
                        cursor: "pointer", fontFamily: FF,
                      }}>
                      All days
                    </button>
                  </div>
                </div>
              );
            })()}

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

        {/* [PR / 2026-04-30] Preview-result panel. Renders above the
            footer when the operator has run a dry-run preview.
            Counters-only for v1 — what the cascade WOULD do, broken
            out by branch. Production state already untouched (the
            dry_run rollback inside the PATCH route reversed any
            writes); the panel just displays what was rolled back. */}
        {previewResult && (
          <div style={{ padding: "12px 20px", borderTop: "1px solid #E5E2DC", backgroundColor: "#FAFAF8", fontFamily: FF, fontSize: 13, color: "#1A1917" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>Preview — would change:</strong>
              <button onClick={() => setPreviewResult(null)} style={{ fontSize: 12, color: "#6B7280", background: "none", border: "none", cursor: "pointer", fontFamily: FF }}>Clear</button>
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
              <li>Scope: <code>{String(previewResult.scope ?? "—")}</code></li>
              <li>Current job: {previewResult.current_job_would_update ? "update" : "no change"}</li>
              <li>Recurring schedule: {previewResult.schedule_would_be_created ? "create new" : "no change"}</li>
              <li>Future jobs in series — update: {String(previewResult.future_jobs_would_be_updated ?? 0)}, delete: {String(previewResult.future_jobs_would_be_deleted ?? 0)}, insert: {String(previewResult.future_jobs_would_be_inserted_in_tx ?? 0)}, skipped (clocked-in): {String(previewResult.future_jobs_would_be_skipped_in_progress ?? 0)}</li>
              <li style={{ color: "#6B7280", fontSize: 12 }}>Forward 60-day fan-out NOT simulated in v1 — re-run without preview to see actual count.</li>
            </ul>
          </div>
        )}

        {/* [PR / 2026-04-30] Persistent error banner. Sits above the
            footer until the operator's next save attempt clears it
            (submit() → setLastSaveError(null) at start). Pulls the
            verbatim API message — distinguishes field-lock vs
            network vs validation without flattening to "save
            failed". Toast still fires on the same event for
            transient confirmation; the banner is the persistent
            audit trail of the failure. */}
        {lastSaveError && (
          <div style={{ padding: "12px 20px", borderTop: "1px solid #FECACA", backgroundColor: "#FEF2F2", fontFamily: FF, fontSize: 13, color: "#991B1B" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>{lastSaveError.title}</div>
                <div style={{ lineHeight: 1.4 }}>{lastSaveError.message}</div>
              </div>
              <button onClick={() => setLastSaveError(null)} style={{ fontSize: 12, color: "#991B1B", background: "none", border: "none", cursor: "pointer", fontFamily: FF, padding: 0 }}>Dismiss</button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #E5E2DC", backgroundColor: "#FFFFFF", flexShrink: 0, display: "flex", gap: 8 }}>
          <button onClick={onClose} disabled={saving || previewing}
            style={{ flex: 1, padding: "12px", border: "1px solid #E5E2DC", borderRadius: 10, background: "#FFFFFF", color: "#6B7280", fontSize: 14, fontWeight: 600, cursor: (saving || previewing) ? "wait" : "pointer", fontFamily: FF }}>
            Cancel
          </button>
          {/* [PR / 2026-04-30] Preview Changes button. Gated behind
              CASCADE_PREVIEW_ENABLED env var via /api/config/feature-
              flags. When clicked, fires PATCH with dry_run: true; the
              backend runs the cascade tx and rolls back, returning
              counters. Result lands in the preview panel above. */}
          {cascadePreviewEnabled && (
            <button
              onClick={() => {
                setPreviewResult(null);
                if (!canSave) return;
                const isFreqRecurring = !!frequency && frequency !== "on_demand";
                const previewScope: CascadeChoice = isRecurring
                  ? "this_and_future"
                  : (isFreqRecurring ? "create_recurring" : "this_job");
                submit(previewScope, { dry_run: true });
              }}
              disabled={!canSave || previewing || saving}
              style={{ flex: 1, padding: "12px", border: "1px solid #E5E2DC", borderRadius: 10, background: "#FFFFFF", color: canSave ? "#1A1917" : "#9E9B94", fontSize: 14, fontWeight: 600, cursor: (canSave && !previewing && !saving) ? "pointer" : "not-allowed", fontFamily: FF }}>
              {previewing ? "Previewing…" : "Preview changes"}
            </button>
          )}
          <button onClick={onSaveClick} disabled={!canSave || previewing}
            style={{ flex: 2, padding: "12px", border: "none", borderRadius: 10, background: (canSave && !previewing) ? "var(--brand, #00C9A0)" : "#E5E2DC", color: (canSave && !previewing) ? "#FFFFFF" : "#9E9B94", fontSize: 14, fontWeight: 700, cursor: (canSave && !previewing) ? "pointer" : "not-allowed", fontFamily: FF }}>
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
            {/* [PR / 2026-04-30] Mixed-edit footnote — appears when the
                current save touched BOTH schedule-template fields AND
                single-occurrence fields. Picker selection governs all
                fields uniformly (single cascade_scope on the wire per
                Sal's Q1 = c). The footnote tells the operator what
                "Just this visit" actually does for the template-bucket
                fields they changed. */}
            {mixedEditWarning && (
              <div style={{
                fontSize: 12, color: "#92400E", backgroundColor: "#FEF3C7",
                border: "1px solid #FBBF24", borderRadius: 8, padding: "10px 12px",
                marginBottom: 14, lineHeight: 1.45,
              }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Mixed edit</div>
                <div>
                  You changed schedule-template fields ({mixedEditWarning.template.join(", ")})
                  AND single-occurrence fields ({mixedEditWarning.occurrence.join(", ")}).
                  Choosing <strong>Just this visit</strong> will NOT update the schedule
                  template — your template-field changes will apply to today only.
                  Choose <strong>This and all future visits</strong> to update the
                  schedule template + every future scheduled occurrence.
                </div>
              </div>
            )}
            {/* [AI.7.1] When parking-fee dirty, surface "this and future" as
                the meaningful cascade — choosing "this job only" persists
                parking on this occurrence but leaves the schedule template
                untouched, so future M/F jobs (or whatever pattern) still
                miss parking. The hint below clarifies. */}
            {(() => {
              const parkingAddon = availableAddons.find(a => /^parking fee$/i.test(a.name));
              const parkingNowChecked = !!parkingAddon && selectedAddons.has(parkingAddon.id);
              const parkingDirty = parkingNowChecked !== parkingFeeEnabledInitial
                || parkingFeeAmount !== parkingFeeAmountInitial
                || JSON.stringify(parkingFeeDays == null ? null : [...parkingFeeDays].sort())
                   !== JSON.stringify(parkingFeeDaysInitial == null ? null : [...parkingFeeDaysInitial].sort());
              if (!parkingDirty) return null;
              const dayLabels = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
              const days = parkingFeeDays != null && parkingFeeDays.length > 0
                ? parkingFeeDays.map(d => dayLabels[d].slice(0,3)).join("/")
                : "every scheduled visit";
              return (
                <div style={{
                  marginBottom: 14, padding: "10px 12px", borderRadius: 8,
                  backgroundColor: "rgba(0,201,160,0.06)", border: "1px solid rgba(0,201,160,0.25)",
                  fontSize: 12, color: "#1A1917", lineHeight: 1.5,
                }}>
                  <strong>Parking fee:</strong> {parkingNowChecked ? `apply on ${days}` : "remove"}.
                  Choose "this and all future" to update the schedule. "This job only" applies parking just to this occurrence.
                </div>
              );
            })()}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
              {([
                { v: "this_job",        label: "Just this visit",                  sub: "Default. Writes to this job + its add-ons. Other occurrences won't change." },
                { v: "this_and_future", label: "This and all future visits",       sub: "Updates the schedule template + every future scheduled occurrence. Past visits stay untouched." },
                { v: "all",             label: "All visits in the series",         sub: "Backfills past + future. Paid past jobs are skipped to protect the audit trail." },
                { v: "remove_this",     label: "Remove from this visit only",      sub: "Use when an add-on (parking, etc.) is normally on the schedule but isn't happening this time. Schedule template stays intact." },
              ] as Array<{ v: CascadeChoice; label: string; sub: string }>).map(opt => {
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
              <button onClick={() => { setCascadePromptOpen(false); setMixedEditWarning(null); }} disabled={saving}
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

      {/* [edit-decouple 2026-04-29] Confirmation dialog for warn-locked
          edits. Opens when the route returns 409 + warn=true. The
          operator's "Confirm and save" re-submits the same payload with
          force_unlock: true so the per-field warn lock passes through. */}
      {warnPrompt && (
        <>
          <div onClick={() => setWarnPrompt(null)}
            style={{ position: "fixed", inset: 0, backgroundColor: "rgba(15,16,18,0.55)", zIndex: 220 }} />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            zIndex: 221, width: 440, maxWidth: "92vw",
            backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12,
            boxShadow: "0 16px 48px rgba(0,0,0,0.18)", padding: "20px 22px",
            fontFamily: FF,
          }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#1A1917", marginBottom: 8 }}>
              Confirm change
            </div>
            <div style={{ fontSize: 13, color: "#1A1917", lineHeight: 1.5, marginBottom: 18 }}>
              {warnPrompt.message}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setWarnPrompt(null)} disabled={saving}
                style={{ flex: 1, padding: "10px", borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B7280", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                Cancel
              </button>
              <button onClick={() => { setWarnPrompt(null); submit(cascadeChoice, { force_unlock: true }); }} disabled={saving}
                style={{ flex: 2, padding: "10px", borderRadius: 8, border: "none", background: "#D97706", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: saving ? "wait" : "pointer", fontFamily: FF }}>
                {saving ? "Saving…" : "Confirm and save"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
