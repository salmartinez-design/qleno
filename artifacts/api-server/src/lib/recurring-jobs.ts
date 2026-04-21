import { db } from "@workspace/db";
import { recurringSchedulesTable, jobsTable, clientsTable, companiesTable } from "@workspace/db/schema";
import { eq, and, sql, inArray, gte, lte } from "drizzle-orm";

const DAYS_AHEAD = 60;

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
  return "biweekly";
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

function generateOccurrences(
  schedule: { frequency: string; day_of_week: string | null; start_date: string; end_date?: string | null },
  fromDate: Date,
  toDate: Date
): Date[] {
  const start = parseDate(schedule.start_date);
  const endLimit = schedule.end_date ? parseDate(schedule.end_date) : toDate;
  const effectiveEnd = endLimit < toDate ? endLimit : toDate;

  const targetDow = schedule.day_of_week
    ? (DAY_NAME_TO_NUM[schedule.day_of_week.toLowerCase()] ?? start.getDay())
    : start.getDay();

  const freq = schedule.frequency;
  const dates: Date[] = [];

  if (freq === "monthly") {
    const dayOfMonth = start.getDate();
    let current = new Date(fromDate.getFullYear(), fromDate.getMonth(), dayOfMonth);
    if (current < fromDate) current = addMonths(current, 1);
    while (current <= effectiveEnd) {
      if (current >= fromDate) dates.push(new Date(current));
      current = addMonths(current, 1);
    }
  } else {
    const intervalDays = freq === "weekly" ? 7 : 14;
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
  start_date: string;
  end_date?: string | null;
  assigned_employee_id: number | null;
  service_type: string | null;
  duration_minutes: number | null;
  base_fee: string | null;
  notes: string | null;
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

  const rows = toInsert.map(d => ({
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
  }));

  return { rows, skipped };
}

export async function generateJobsFromSchedule(
  schedule: ScheduleInput,
  fromDate: Date,
  toDate: Date,
  bookingLocation?: string | null,
  clientZip?: string | null
): Promise<{ created: number; skipped: number }> {
  const { rows, skipped } = await computeOccurrencesForSchedule(
    schedule, fromDate, toDate, bookingLocation, clientZip
  );
  if (!rows.length) return { created: 0, skipped };
  await db.insert(jobsTable).values(rows as any[]);
  return { created: rows.length, skipped };
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

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = addDays(today, daysAhead);
  const todayStr = toDateStr(today);
  const horizonStr = toDateStr(horizon);

  console.log(`[recurring-jobs] company=${companyId} window: ${todayStr} → ${horizonStr}`);

  const schedules = await db
    .select()
    .from(recurringSchedulesTable)
    .where(and(
      eq(recurringSchedulesTable.company_id, companyId),
      eq(recurringSchedulesTable.is_active, true)
    ));

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

  // Dry-run accumulators — populated only when opts.dryRun
  let totalOccurrencesPlanned = 0;
  let totalOccurrencesSkippedFeeGuard = 0;
  const plannedInserts: PlannedInsert[] = [];

  for (const schedule of schedules) {
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
