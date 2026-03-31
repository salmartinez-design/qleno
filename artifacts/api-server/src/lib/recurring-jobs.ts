import { db } from "@workspace/db";
import { recurringSchedulesTable, jobsTable, clientsTable } from "@workspace/db/schema";
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

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
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

export async function generateJobsFromSchedule(
  schedule: {
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
  },
  fromDate: Date,
  toDate: Date,
  bookingLocation?: string | null,
  clientZip?: string | null
): Promise<{ created: number; skipped: number }> {
  const occurrences = generateOccurrences(schedule, fromDate, toDate);
  if (!occurrences.length) return { created: 0, skipped: 0 };

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

  if (!toInsert.length) return { created: 0, skipped };

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

  await db.insert(jobsTable).values(rows as any[]);
  return { created: toInsert.length, skipped };
}

export async function generateRecurringJobs(
  companyId: number,
  daysAhead = DAYS_AHEAD
): Promise<{ jobs_created: number; schedules_processed: number; skipped_duplicates: number; unassigned_jobs: number }> {
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
    return { jobs_created: 0, schedules_processed: 0, skipped_duplicates: 0, unassigned_jobs: 0 };
  }

  const customerIds = [...new Set(schedules.map(s => s.customer_id).filter((id): id is number => id != null))];

  let clientZipMap: Record<number, string | null> = {};
  if (customerIds.length > 0) {
    const clientRows = await db
      .select({ id: clientsTable.id, zip: clientsTable.zip })
      .from(clientsTable)
      .where(inArray(clientsTable.id, customerIds));
    for (const row of clientRows) {
      clientZipMap[row.id] = row.zip || null;
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

  for (const schedule of schedules) {
    const clientZip = clientZipMap[schedule.customer_id!] ?? null;
    const bookingLocation = clientZip ? (zipLocationMap[clientZip] ?? null) : null;

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

  console.log(`[recurring-jobs] Done — created ${totalCreated}, skipped ${totalSkipped} duplicates, ${schedules.length} schedules`);
  return { jobs_created: totalCreated, schedules_processed: schedulesProcessed, skipped_duplicates: totalSkipped, unassigned_jobs: unassignedJobs };
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
