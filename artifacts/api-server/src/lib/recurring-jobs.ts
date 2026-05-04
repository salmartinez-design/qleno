import { db } from "@workspace/db";
import { recurringSchedulesTable, jobsTable, clientsTable, companiesTable } from "@workspace/db/schema";
import { eq, and, sql, inArray, gte, lte } from "drizzle-orm";

// [scheduling-engine 2026-04-29] Rolling generation window — extended
// from 60 to 90 days so dispatchers can see roughly a quarter ahead.
// Nightly 2 AM cron re-runs with this horizon; idempotent dedupe in
// generateJobsFromSchedule prevents duplicate inserts when the window
// overlaps existing rows.
export const DAYS_AHEAD = 90;

const DAY_NAME_TO_NUM: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function mapServiceType(raw: string | null): string {
  if (!raw) return "recurring";
  const s = raw.toLowerCase().trim();
  if (s.includes("deep")) return "deep_clean";
  if (s.includes("move out") || s.includes("move-out")) return "move_out";
  if (s.includes("move in") || s.includes("move-in")) return "move_in";
  if (s.includes("post construct") || s.includes("post-construct")) return "post_construction";
  if (s.includes("commercial") || s.includes("office")) return "office_cleaning";
  if (s.includes("common")) return "common_areas";
  if (s.includes("retail")) return "retail_store";
  if (s.includes("medical")) return "medical_office";
  if (s.includes("standard") || s.includes("regular")) return "standard_clean";
  return "recurring";
}

function mapFrequency(freq: string): string {
  if (freq === "weekly") return "weekly";
  if (freq === "biweekly") return "biweekly";
  if (freq === "monthly") return "monthly";
  // [AI] every_3_weeks now lives on both enums (was AG bug — fell back to
  // 'custom' on recurring_schedules.frequency); pass through unchanged.
  if (freq === "every_3_weeks") return "every_3_weeks";
  // [AI] Multi-day frequencies — child jobs mirror the parent's frequency.
  if (freq === "daily") return "daily";
  if (freq === "weekdays") return "weekdays";
  if (freq === "custom_days") return "custom_days";
  return "biweekly";
}

// [recurring-on-save 2026-04-30 / PR #27] Resolved parking config for a
// schedule. Cached by the caller so we look up `pricing_addons` /
// `add_ons` once per generation run, not once per occurrence. Null
// when the tenant has no active "Parking Fee" pricing_addon.
export type ResolvedParkingAddon = {
  pricing_addon_id: number;
  add_on_id: number;
  unit_price: string;
  override_amount: string | null;
};

// [recurring-on-save 2026-04-30 / PR #27] Look up the tenant's Parking
// Fee pricing_addons row + the matching add_ons.id (resolving the FK
// to the older catalog table). Returns null when no active row found
// (engine then logs once and skips parking stamping for the run).
export async function resolveParkingAddon(
  schedule: Pick<ScheduleInput, "company_id" | "customer_id" | "parking_fee_amount">,
  txOrDb: any = db,
): Promise<ResolvedParkingAddon | null> {
  const addonLookup = await txOrDb.execute(sql`
    SELECT id, name, COALESCE(price_value, price, '0')::numeric AS price
    FROM pricing_addons
    WHERE company_id = ${schedule.company_id}
      AND LOWER(name) = 'parking fee'
      AND is_active = true
    LIMIT 1
  `);
  const addonRow = addonLookup.rows[0] as { id: number; name: string; price: string } | undefined;
  if (!addonRow) return null;

  const addonName = String(addonRow.name ?? "Parking Fee");
  const tenantDefault = String(addonRow.price ?? "20");

  // 3-tier waterfall: schedule.parking_fee_amount > clients.parking_fee_amount
  // > pricing_addons.price (tenant default). Only hit the clients lookup when
  // the schedule didn't pin a value — saves the query on schedules that
  // already have an explicit override.
  const scheduleOverride = schedule.parking_fee_amount;
  let clientDefault: string | null = null;
  if ((scheduleOverride == null || scheduleOverride === "") && schedule.customer_id != null) {
    const clientRow = await txOrDb.execute(sql`
      SELECT parking_fee_amount FROM clients WHERE id = ${schedule.customer_id} LIMIT 1
    `);
    const cd = (clientRow.rows[0] as any)?.parking_fee_amount;
    if (cd != null && cd !== "") clientDefault = String(cd);
  }
  const unitPrice = scheduleOverride != null && scheduleOverride !== ""
    ? String(scheduleOverride)
    : (clientDefault ?? tenantDefault);

  // Resolve the real `add_ons.id` for the FK on `job_add_ons.add_on_id`.
  // pricing_addons.id and add_ons.id live in different tables; the
  // older PATCH code naively reused the pricing id as the FK and threw
  // FK violations whenever the IDs didn't coincide.
  const existing = await txOrDb.execute(sql`
    SELECT id FROM add_ons
    WHERE company_id = ${schedule.company_id} AND LOWER(name) = LOWER(${addonName})
    LIMIT 1
  `);
  let realAddOnId: number;
  if (existing.rows.length) {
    realAddOnId = Number((existing.rows[0] as any).id);
  } else {
    const created = await txOrDb.execute(sql`
      INSERT INTO add_ons (company_id, name, price, category, is_active)
      VALUES (${schedule.company_id}, ${addonName}, ${unitPrice}, 'other', true)
      RETURNING id
    `);
    realAddOnId = Number((created.rows[0] as any).id);
  }

  // override_amount = "anything other than the tenant default was used to
  // produce this row", regardless of which tier (schedule or client) supplied
  // it. Callers use this for diagnostic logging / cascade decisions.
  const effectiveOverride = scheduleOverride != null && scheduleOverride !== ""
    ? String(scheduleOverride)
    : clientDefault;

  return {
    pricing_addon_id: Number(addonRow.id),
    add_on_id: realAddOnId,
    unit_price: unitPrice,
    override_amount: effectiveOverride,
  };
}

// [recurring-on-save 2026-04-30 / PR #27] Returns true if the schedule's
// parking config applies to the given weekday. NULL `parking_fee_days`
// = "every visit"; non-null = "only the listed weekdays" (0=Sun..6=Sat).
export function parkingApplies(
  schedule: Pick<ScheduleInput, "parking_fee_enabled" | "parking_fee_days">,
  date: Date,
): boolean {
  if (!schedule.parking_fee_enabled) return false;
  const days = schedule.parking_fee_days ?? null;
  if (days == null) return true;
  return days.includes(date.getDay());
}

// [recurring-on-save 2026-04-30 / PR #27] Stamp a parking-fee row onto
// `job_add_ons` for `jobId`. Idempotent via ON CONFLICT (job_id,
// add_on_id) DO NOTHING — safe to call after either an INSERT or an
// UPDATE of the parent job. Caller is responsible for checking
// `parkingApplies` first.
export async function stampParkingFeeOnJob(
  jobId: number,
  resolved: ResolvedParkingAddon,
  txOrDb: any = db,
): Promise<void> {
  await txOrDb.execute(sql`
    INSERT INTO job_add_ons
      (job_id, add_on_id, quantity, unit_price, subtotal, pricing_addon_id)
    VALUES
      (${jobId}, ${resolved.add_on_id}, 1, ${resolved.unit_price},
       ${resolved.unit_price}, ${resolved.pricing_addon_id})
    ON CONFLICT (job_id, add_on_id) DO NOTHING
  `);
}

// [recurring-on-save 2026-04-30 / PR #27] Insert ONE job row from a
// schedule template at the given date, returning the new id. Pure
// INSERT — no dedupe, no parking stamping. Caller decides whether to
// dedupe (PATCH cascade does its own existing-job lookup) and whether
// to call `stampParkingFeeOnJob` after.
//
// Reused by the nightly engine path (looped from
// `generateJobsFromSchedule`) and by the EditJobModal cascade path
// (`PATCH /api/jobs/:id` cascade_scope='create_recurring' empty-day
// inserts). Drizzle ORM `.insert().values()` only — no raw `sql` for
// table writes (PR #25 array-binding bug, fixed in PR #26).
export async function insertJobFromSchedule(
  schedule: ScheduleInput,
  date: Date,
  txOrDb: any = db,
  bookingLocation: string | null = null,
  clientZip: string | null = null,
): Promise<number> {
  const [row] = await txOrDb
    .insert(jobsTable)
    .values({
      company_id: schedule.company_id,
      client_id: schedule.customer_id,
      assigned_user_id: schedule.assigned_employee_id ?? null,
      service_type: mapServiceType(schedule.service_type) as any,
      status: "scheduled" as const,
      scheduled_date: toDateStr(date),
      scheduled_time: null as any,
      frequency: mapFrequency(schedule.frequency) as any,
      base_fee: schedule.base_fee ? String(parseFloat(schedule.base_fee).toFixed(2)) : "0.00",
      allowed_hours: schedule.duration_minutes
        ? String((schedule.duration_minutes / 60).toFixed(2))
        : null as any,
      notes: schedule.notes ?? null,
      recurring_schedule_id: schedule.id,
      booking_location: (bookingLocation ?? null) as any,
      address_zip: (clientZip ?? null) as any,
    })
    .returning({ id: jobsTable.id });
  return Number(row.id);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(str: string): Date {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function getFirstOccurrence(start: Date, targetDow: number, fromDate: Date): Date {
  let d = new Date(fromDate);
  const diff = (targetDow - d.getDay() + 7) % 7;
  return addDays(d, diff);
}

// Resolve the multi-day pattern from a schedule's frequency + days_of_week.
// Returns an array of weekday integers (0=Sunday..6=Saturday) or null when
// the schedule is single-day (handled by the legacy day_of_week branch).
//
// [AI] daily      → [0,1,2,3,4,5,6] regardless of days_of_week column
// [AI] weekdays   → [1,2,3,4,5]     regardless of days_of_week column
// [AI] custom_days → days_of_week  (validated at write-time; ≥1 entry)
function resolveMultiDayPattern(
  freq: string,
  daysOfWeek: number[] | null,
): number[] | null {
  if (freq === "daily") return [0, 1, 2, 3, 4, 5, 6];
  if (freq === "weekdays") return [1, 2, 3, 4, 5];
  if (freq === "custom_days") {
    const arr = (daysOfWeek ?? []).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
    return arr.length > 0 ? Array.from(new Set(arr)).sort() : null;
  }
  return null;
}

function generateOccurrences(
  schedule: {
    frequency: string;
    day_of_week: string | null;
    days_of_week?: number[] | null;
    custom_frequency_weeks?: number | null;
    start_date: string;
    end_date?: string | null;
  },
  fromDate: Date,
  toDate: Date
): Date[] {
  const start = parseDate(schedule.start_date);
  const endLimit = schedule.end_date ? parseDate(schedule.end_date) : toDate;
  const effectiveEnd = endLimit < toDate ? endLimit : toDate;

  const freq = schedule.frequency;
  const dates: Date[] = [];

  // [AI] If both day_of_week and days_of_week are populated, prefer the
  // multi-day path and warn. PATCH endpoint enforces exclusivity but defend
  // against bad data (manual SQL, future code paths, etc.).
  if (schedule.day_of_week && (schedule.days_of_week?.length ?? 0) > 0) {
    console.warn(
      `[recurring-engine] schedule has BOTH day_of_week and days_of_week populated — preferring days_of_week`,
    );
  }

  // ── Multi-day path: daily / weekdays / custom_days ──────────────────────
  // Walk every date from fromDate to effectiveEnd, emit when DOW matches.
  // No interval math — every matching weekday in the window produces a job.
  const multiDay = resolveMultiDayPattern(freq, schedule.days_of_week ?? null);
  if (multiDay) {
    const targetSet = new Set(multiDay);
    let current = new Date(fromDate);
    while (current <= effectiveEnd) {
      if (current >= start && targetSet.has(current.getDay())) {
        dates.push(new Date(current));
      }
      current = addDays(current, 1);
    }
    return dates;
  }

  // ── Single-day path: weekly / biweekly / every_3_weeks / monthly ────────
  const targetDow = schedule.day_of_week
    ? (DAY_NAME_TO_NUM[schedule.day_of_week.toLowerCase()] ?? start.getDay())
    : start.getDay();

  if (freq === "monthly") {
    const dayOfMonth = start.getDate();
    let current = new Date(fromDate.getFullYear(), fromDate.getMonth(), dayOfMonth);
    if (current < fromDate) current = addMonths(current, 1);
    while (current <= effectiveEnd) {
      if (current >= fromDate) dates.push(new Date(current));
      current = addMonths(current, 1);
    }
  } else {
    // Interval picker. Order matters — explicit checks before the legacy
    // fallback. [AI] every_3_weeks honored; AG's custom_frequency_weeks
    // honored as a fallback when frequency='custom' on recurring_schedules.
    let intervalDays: number;
    if (freq === "weekly") {
      intervalDays = 7;
    } else if (freq === "biweekly") {
      intervalDays = 14;
    } else if (freq === "every_3_weeks") {
      intervalDays = 21;
    } else if (freq === "custom" && schedule.custom_frequency_weeks != null) {
      intervalDays = schedule.custom_frequency_weeks * 7;
    } else {
      // Conservative fallback for any unrecognized frequency string. Keeps
      // historical behavior for rows without custom_frequency_weeks.
      intervalDays = 14;
    }
    let current = getFirstOccurrence(start, targetDow, fromDate);
    while (current <= effectiveEnd) {
      if (current >= fromDate) dates.push(new Date(current));
      current = addDays(current, intervalDays);
    }
  }

  return dates;
}

type ScheduleInput = {
  id: number;
  company_id: number;
  customer_id: number;
  frequency: string;
  day_of_week: string | null;
  // [AI] Multi-day fields. days_of_week is the int array (0=Sun..6=Sat) for
  // daily/weekdays/custom_days. custom_frequency_weeks is AG's column for
  // walking N-week intervals when frequency='custom' (now superseded by
  // 'every_3_weeks' enum value but the column remains for backward compat).
  days_of_week?: number[] | null;
  custom_frequency_weeks?: number | null;
  start_date: string;
  end_date?: string | null;
  assigned_employee_id: number | null;
  service_type: string | null;
  duration_minutes: number | null;
  base_fee: string | null;
  notes: string | null;
  // [AI.6] Parking fee per-occurrence config. When enabled, generated jobs
  // for matching weekdays get a job_add_ons row stamped at insertion time.
  // parking_fee_days uses 0=Sun..6=Sat (matches days_of_week convention).
  // NULL parking_fee_days means "apply to every scheduled occurrence."
  parking_fee_enabled?: boolean | null;
  parking_fee_amount?: string | null;
  parking_fee_days?: number[] | null;
};

// Pure compute: produces insert-ready rows after the dedupe check, but does NOT
// insert. Returned rows can be handed to db.insert() directly (live run) or
// serialized into a dry-run response.
export async function computeOccurrencesForSchedule(
  schedule: ScheduleInput,
  fromDate: Date,
  toDate: Date,
  bookingLocation?: string | null,
  clientZip?: string | null
): Promise<{ rows: Record<string, any>[]; skipped: number }> {
  const occurrences = generateOccurrences(schedule, fromDate, toDate);
  if (!occurrences.length) return { rows: [], skipped: 0 };

  const fromStr = toDateStr(fromDate);
  const toStr = toDateStr(toDate);

  const existingRows = await db
    .select({ scheduled_date: jobsTable.scheduled_date })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.company_id, schedule.company_id),
        eq((jobsTable as any).recurring_schedule_id, schedule.id),
        gte(jobsTable.scheduled_date, fromStr),
        lte(jobsTable.scheduled_date, toStr)
      )
    );

  const existingDates = new Set(existingRows.map(r => String(r.scheduled_date)));

  const toInsert = occurrences.filter(d => !existingDates.has(toDateStr(d)));
  const skipped = occurrences.length - toInsert.length;

  if (!toInsert.length) return { rows: [], skipped };

  // [AI.6] Per-occurrence parking decision. Sidecar flag attached to each
  // generated row; live path strips before INSERT and uses for job_add_ons
  // stamping. Dry-run path passes it through to the planned inserts response
  // so operators can verify which dates would have parking.
  const parkingEnabled = !!schedule.parking_fee_enabled;
  const parkingDays: number[] | null = schedule.parking_fee_days ?? null;

  const rows = toInsert.map(d => {
    const dow = d.getDay(); // 0=Sun..6=Sat
    const parkingApplies = parkingEnabled && (parkingDays == null || parkingDays.includes(dow));
    return {
      company_id: schedule.company_id,
      client_id: schedule.customer_id,
      assigned_user_id: schedule.assigned_employee_id ?? null,
      service_type: mapServiceType(schedule.service_type) as any,
      status: "scheduled" as const,
      scheduled_date: toDateStr(d),
      scheduled_time: null as any,
      frequency: mapFrequency(schedule.frequency) as any,
      base_fee: schedule.base_fee ? String(parseFloat(schedule.base_fee).toFixed(2)) : "0.00",
      allowed_hours: schedule.duration_minutes ? String((schedule.duration_minutes / 60).toFixed(2)) : null as any,
      notes: schedule.notes ?? null,
      recurring_schedule_id: schedule.id,
      booking_location: (bookingLocation ?? null) as any,
      address_zip: (clientZip ?? null) as any,
      // Sidecar — NOT a jobs column. Stripped in generateJobsFromSchedule
      // before the actual INSERT; passed through unchanged in dry-run.
      _parking_fee_applies: parkingApplies,
    };
  });

  return { rows, skipped };
}

export async function generateJobsFromSchedule(
  schedule: ScheduleInput,
  fromDate: Date,
  toDate: Date,
  bookingLocation?: string | null,
  clientZip?: string | null
): Promise<{ created: number; skipped: number; parking_stamped?: number }> {
  const { rows, skipped } = await computeOccurrencesForSchedule(
    schedule, fromDate, toDate, bookingLocation, clientZip
  );
  if (!rows.length) return { created: 0, skipped };

  // [recurring-on-save 2026-04-30 / PR #27] Refactor: per-date inserts
  // via the shared `insertJobFromSchedule` helper instead of one bulk
  // INSERT. Cost: N round trips instead of 1 (acceptable on the
  // nightly cron — runs once per day, dedupe in compute means N is
  // small per-schedule). Benefit: single source of truth for the
  // INSERT shape so the EditJobModal cascade path can use the same
  // helper without forking divergent column lists.
  //
  // Parking lookup is hoisted OUT of the loop (one query per run, not
  // one per occurrence) via `resolveParkingAddon`.
  const anyParking = rows.some(r => Boolean((r as any)._parking_fee_applies));
  let resolved: ResolvedParkingAddon | null = null;
  if (anyParking) {
    resolved = await resolveParkingAddon(schedule);
    if (!resolved) {
      console.warn(
        `[recurring-engine] schedule ${schedule.id} has parking_fee_enabled but ` +
        `company ${schedule.company_id} has no active Parking Fee pricing_addon — skipping stamp`,
      );
    }
  }

  let parkingStamped = 0;
  let created = 0;
  for (const row of rows) {
    // Reconstruct the Date from the YYYY-MM-DD string stamped by
    // computeOccurrencesForSchedule. Use a midnight-local construction
    // so DOW math matches the engine's existing behavior (avoids the
    // UTC-vs-local landing case from KNOWN_BUGS.md #4).
    const date = new Date(`${String(row.scheduled_date)}T00:00:00`);
    const newId = await insertJobFromSchedule(
      schedule,
      date,
      db,
      bookingLocation ?? null,
      clientZip ?? null,
    );
    created++;
    if (resolved && (row as any)._parking_fee_applies) {
      await stampParkingFeeOnJob(newId, resolved);
      parkingStamped++;
    }
  }

  return { created, skipped, parking_stamped: parkingStamped };
}

type SkippedSchedule = {
  schedule_id: number;
  client_id: number | null;
  client_name: string | null;
  frequency: string;
  reason: "null_fee" | "zero_fee";
};

type PlannedInsert = {
  schedule_id: number;
  client_id: number | null;
  scheduled_date: string;
  base_fee: string;
};

export type FailedSchedule = {
  schedule_id: number;
  error: string;
};

export type RecurringRunResult = {
  // back-compat fields
  jobs_created: number;
  schedules_processed: number;
  skipped_duplicates: number;
  unassigned_jobs: number;
  skipped?: boolean;
  reason?: string;
  // Session 2 — base_fee guard
  inserted: number;
  skipped_null_fee: number;
  skipped_zero_fee: number;
  skipped_schedules: SkippedSchedule[];
  // Session 2 — dry-run mode (present only when opts.dryRun)
  dry_run?: boolean;
  planned?: number;
  total_schedules_evaluated?: number;
  total_occurrences_planned?: number;
  total_occurrences_skipped_fee_guard?: number;
  planned_inserts?: PlannedInsert[];
  planned_inserts_total?: number;
  // J3 — per-schedule resilience + advisory lock
  failed_schedules?: FailedSchedule[];
  skipped_due_to_lock?: boolean;
};

const SKIPPED_SCHEDULES_CAP = 200;
const PLANNED_INSERTS_CAP = 500;

export async function generateRecurringJobs(
  companyId: number,
  daysAhead = DAYS_AHEAD,
  opts: { dryRun?: boolean } = {}
): Promise<RecurringRunResult> {
  const dryRun = opts.dryRun === true;

  // Per-tenant disable flag — skip this company if their engine is off.
  // Dry-run intentionally bypasses this so operators can plan against a
  // disabled tenant before flipping the flag back on.
  const company = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  if (!company[0] || (!company[0].recurring_engine_enabled && !dryRun)) {
    console.log(`[recurring-engine] Skipping company_id=${companyId} — engine disabled for this tenant`);
    return {
      jobs_created: 0, schedules_processed: 0, skipped_duplicates: 0, unassigned_jobs: 0,
      skipped: true, reason: "tenant_disabled",
      inserted: 0, skipped_null_fee: 0, skipped_zero_fee: 0, skipped_schedules: [],
    };
  }

  // J3 — per-company advisory lock. Two args to pg_try_advisory_lock form a
  // 64-bit key (namespace constant + company_id). If another process already
  // holds this lock, skip the run silently. This is the primary defense
  // against the 5× concurrent startup cascade that caused the 2026-04-22
  // overnight duplication incident.
  const LOCK_NAMESPACE = 4242;
  const lockResult = await db.execute(sql`
    SELECT pg_try_advisory_lock(${LOCK_NAMESPACE}, ${companyId}) AS acquired
  `);
  const acquired = (lockResult.rows?.[0] as any)?.acquired;
  if (!acquired) {
    console.warn(
      `[recurring-engine] company_id=${companyId}: ` +
      `another process holds the lock — skipping this run.`
    );
    return {
      jobs_created: 0, schedules_processed: 0, skipped_duplicates: 0, unassigned_jobs: 0,
      skipped: true, reason: "lock_not_acquired",
      inserted: 0, skipped_null_fee: 0, skipped_zero_fee: 0, skipped_schedules: [],
      failed_schedules: [], skipped_due_to_lock: true,
    };
  }

  try {

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = addDays(today, daysAhead);
  const todayStr = toDateStr(today);
  const horizonStr = toDateStr(horizon);

  console.log(`[recurring-jobs] company=${companyId} window: ${todayStr} → ${horizonStr}`);

  // J3 — deterministic schedule order so processing is reproducible across
  // restarts and across concurrent processes. Without ORDER BY, different
  // processes could hit different subsets on the same company and create
  // partial-overlap inserts (the pattern we saw in the 2026-04-22 incident).
  const schedules = await db
    .select()
    .from(recurringSchedulesTable)
    .where(and(
      eq(recurringSchedulesTable.company_id, companyId),
      eq(recurringSchedulesTable.is_active, true)
    ))
    .orderBy(recurringSchedulesTable.id);

  if (!schedules.length) {
    console.log(`[recurring-jobs] No active schedules for company ${companyId}`);
    return {
      jobs_created: 0, schedules_processed: 0, skipped_duplicates: 0, unassigned_jobs: 0,
      inserted: 0, skipped_null_fee: 0, skipped_zero_fee: 0, skipped_schedules: [],
    };
  }

  const customerIds = [...new Set(schedules.map(s => s.customer_id).filter((id): id is number => id != null))];

  let clientZipMap: Record<number, string | null> = {};
  let clientNameMap: Record<number, string | null> = {};
  if (customerIds.length > 0) {
    const clientRows = await db
      .select({ id: clientsTable.id, zip: clientsTable.zip, first_name: clientsTable.first_name, last_name: clientsTable.last_name })
      .from(clientsTable)
      .where(inArray(clientsTable.id, customerIds));
    for (const row of clientRows) {
      clientZipMap[row.id] = row.zip || null;
      const parts = [row.first_name, row.last_name].filter((p): p is string => !!p);
      clientNameMap[row.id] = parts.length ? parts.join(" ") : null;
    }
  }

  let zipLocationMap: Record<string, string | null> = {};
  const zoneRows = await db.execute(sql`
    SELECT location, unnest(zip_codes) as zip
      FROM service_zones
     WHERE company_id = ${companyId} AND is_active = true
  `);
  for (const row of zoneRows.rows as any[]) {
    if (row.zip && row.location) zipLocationMap[String(row.zip)] = row.location;
  }

  let totalCreated = 0;
  let totalSkipped = 0;
  let schedulesProcessed = 0;
  let unassignedJobs = 0;
  let skippedNullFee = 0;
  let skippedZeroFee = 0;
  const skippedSchedules: SkippedSchedule[] = [];
  // J3 — per-schedule failure tracking. One bad schedule no longer aborts the
  // entire company run; we record the error and continue. Exposed in the
  // RecurringRunResult so the API + cron logs surface bad rows instead of
  // silently swallowing them.
  const failedSchedules: FailedSchedule[] = [];

  // Dry-run accumulators — populated only when opts.dryRun
  let totalOccurrencesPlanned = 0;
  let totalOccurrencesSkippedFeeGuard = 0;
  const plannedInserts: PlannedInsert[] = [];

  for (const schedule of schedules) {
    try {
      // Guard: reject schedules with unusable base_fee. Prevents phantom $0 jobs
      // like the 744 cleaned up in Session 1. Backfilling base_fee from MaidCentral
      // rates or client-history median is a separate concern.
      const feeRaw = schedule.base_fee;
      const feeTrimmed = typeof feeRaw === "string" ? feeRaw.trim() : feeRaw;
      const clientId = schedule.customer_id ?? null;
      const clientName = clientId != null ? (clientNameMap[clientId] ?? null) : null;

      if (feeTrimmed == null || feeTrimmed === "") {
        console.warn(`[recurring-engine] SKIP schedule id=${schedule.id} client=${clientId} — base_fee is NULL`);
        skippedNullFee++;
        if (skippedSchedules.length < SKIPPED_SCHEDULES_CAP) {
          skippedSchedules.push({
            schedule_id: schedule.id,
            client_id: clientId,
            client_name: clientName,
            frequency: schedule.frequency,
            reason: "null_fee",
          });
        }
        // In dry-run, also count what WOULD have been generated had the fee been set
        if (dryRun) {
          totalOccurrencesSkippedFeeGuard += generateOccurrences(schedule, today, horizon).length;
        }
        continue;
      }

      const feeNum = parseFloat(feeTrimmed);
      if (!Number.isFinite(feeNum) || feeNum === 0) {
        console.warn(`[recurring-engine] SKIP schedule id=${schedule.id} client=${clientId} — base_fee is 0`);
        skippedZeroFee++;
        if (skippedSchedules.length < SKIPPED_SCHEDULES_CAP) {
          skippedSchedules.push({
            schedule_id: schedule.id,
            client_id: clientId,
            client_name: clientName,
            frequency: schedule.frequency,
            reason: "zero_fee",
          });
        }
        if (dryRun) {
          totalOccurrencesSkippedFeeGuard += generateOccurrences(schedule, today, horizon).length;
        }
        continue;
      }

      const clientZip = clientZipMap[schedule.customer_id!] ?? null;
      const bookingLocation = clientZip ? (zipLocationMap[clientZip] ?? null) : null;

      if (dryRun) {
        // Compute but do not insert; do not update last_generated_date
        const { rows, skipped } = await computeOccurrencesForSchedule(
          schedule, today, horizon, bookingLocation, clientZip
        );
        totalSkipped += skipped;
        totalOccurrencesPlanned += rows.length;
        if (rows.length > 0) schedulesProcessed++;
        for (const r of rows) {
          if (plannedInserts.length >= PLANNED_INSERTS_CAP) break;
          plannedInserts.push({
            schedule_id: schedule.id,
            client_id: clientId,
            scheduled_date: String(r.scheduled_date),
            base_fee: String(r.base_fee),
          });
        }
        continue;
      }

      const { created, skipped } = await generateJobsFromSchedule(
        schedule, today, horizon, bookingLocation, clientZip
      );

      totalSkipped += skipped;
      if (created > 0) {
        totalCreated += created;
        schedulesProcessed++;
        if (!schedule.assigned_employee_id) unassignedJobs += created;

        await db
          .update(recurringSchedulesTable)
          .set({ last_generated_date: todayStr })
          .where(eq(recurringSchedulesTable.id, schedule.id));
      }
    } catch (err: any) {
      console.error(
        `[recurring-engine] Schedule ${schedule.id} (client ${schedule.customer_id}) ` +
        `failed — continuing with remaining schedules. Error:`, err?.message || err
      );
      failedSchedules.push({
        schedule_id: schedule.id,
        error: String(err?.message || err).slice(0, 500),
      });
      continue;
    }
  }

  if (failedSchedules.length > 0) {
    console.error(
      `[recurring-engine] company_id=${companyId}: ${failedSchedules.length} schedules ` +
      `failed during generation:`, failedSchedules
    );
  }

  const inserted = dryRun ? 0 : totalCreated;
  console.log(
    `[recurring-jobs]${dryRun ? " [dry-run]" : ""} Done — ` +
    `${dryRun ? `planned ${totalOccurrencesPlanned}` : `created ${totalCreated}`}, ` +
    `skipped ${totalSkipped} duplicates, ` +
    `${skippedNullFee} null-fee, ${skippedZeroFee} zero-fee, ` +
    `${schedules.length} schedules evaluated`
  );

  const base: RecurringRunResult = {
    jobs_created: inserted,
    schedules_processed: schedulesProcessed,
    skipped_duplicates: totalSkipped,
    unassigned_jobs: unassignedJobs,
    inserted,
    skipped_null_fee: skippedNullFee,
    skipped_zero_fee: skippedZeroFee,
    skipped_schedules: skippedSchedules,
    failed_schedules: failedSchedules,
  };

  if (dryRun) {
    base.dry_run = true;
    base.planned = totalOccurrencesPlanned;
    base.total_schedules_evaluated = schedules.length;
    base.total_occurrences_planned = totalOccurrencesPlanned;
    base.total_occurrences_skipped_fee_guard = totalOccurrencesSkippedFeeGuard;
    base.planned_inserts = plannedInserts;
    base.planned_inserts_total = totalOccurrencesPlanned;
  }

  return base;

  } finally {
    // J3 — always release the advisory lock, even on thrown exceptions.
    // pg_advisory_unlock is idempotent per-session; a missed release would
    // survive until the DB connection dies and is never catastrophic, but
    // missing it under high restart pressure defeats the point of the lock.
    try {
      await db.execute(sql`
        SELECT pg_advisory_unlock(${LOCK_NAMESPACE}, ${companyId})
      `);
    } catch (unlockErr) {
      console.error(
        `[recurring-engine] company_id=${companyId}: failed to release advisory lock:`,
        unlockErr
      );
    }
  }
}

export async function runRecurringJobGeneration() {
  const companyRows = await db.execute(sql`SELECT id FROM companies ORDER BY id`);
  let total = 0;
  for (const company of companyRows.rows as any[]) {
    try {
      const result = await generateRecurringJobs(Number(company.id), DAYS_AHEAD);
      total += result.jobs_created;
    } catch (err) {
      console.error(`[recurring-jobs] company ${company.id} failed:`, err);
    }
  }

  // ── job_unassigned alerts: jobs within 48h with no assigned technician ────
  try {
    const now = new Date();
    const in48h = new Date(now.getTime() + 48 * 3600 * 1000);
    const today = now.toISOString().slice(0, 10);
    const future = in48h.toISOString().slice(0, 10);

    const unassigned = await db.execute(
      sql`SELECT j.id, j.company_id, j.scheduled_date, c.first_name, c.last_name
          FROM jobs j
          LEFT JOIN clients c ON c.id = j.client_id
          WHERE j.scheduled_date BETWEEN ${today} AND ${future}
            AND j.status = 'scheduled'
            AND j.company_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM notifications n
              WHERE n.company_id = j.company_id
                AND n.type = 'job_unassigned'
                AND (n.meta->>'job_id')::int = j.id
                AND n.read = false
                AND n.created_at > now() - interval '24 hours'
            )`
    );

    for (const row of unassigned.rows as any[]) {
      try {
        const clientName = row.first_name ? `${row.first_name} ${row.last_name}` : "Unknown Client";
        const title = `Unassigned Job — ${clientName}`;
        const body = `Job #${row.id} (${row.scheduled_date}) has no assigned technician and is coming up within 48 hours.`;
        await db.execute(
          sql`INSERT INTO notifications (company_id, type, title, body, link, meta)
              VALUES (${Number(row.company_id)}, 'job_unassigned', ${title}, ${body}, ${'/dispatch'}, ${JSON.stringify({ job_id: row.id, client_name: clientName })}::jsonb)`
        );
      } catch (e) {
        console.error(`[job_unassigned] failed for job ${row.id}:`, e);
      }
    }

    if (unassigned.rows.length > 0) {
      console.log(`[recurring-jobs] Inserted ${unassigned.rows.length} job_unassigned notifications`);
    }
  } catch (err) {
    console.error("[job_unassigned] cron check failed:", err);
  }

  return total;
}

export function startRecurringJobCron() {
  function scheduleNext() {
    const now = new Date();
    const next = new Date(now);
    next.setDate(now.getDate() + 1);
    next.setHours(2, 0, 0, 0);
    const msUntilNext = next.getTime() - now.getTime();
    console.log(`[recurring-jobs] Next cron run scheduled for ${next.toISOString()} (~${Math.round(msUntilNext / 3600000)}h from now)`);

    setTimeout(async () => {
      try {
        await runRecurringJobGeneration();
      } catch (err) {
        console.error("[recurring-jobs] Cron run failed:", err);
      }
      scheduleNext();
    }, msUntilNext);
  }

  scheduleNext();
}
