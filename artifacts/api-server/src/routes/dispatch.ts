import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, usersTable, clientsTable, timeclockTable, jobPhotosTable, serviceZonesTable, serviceZoneEmployeesTable, accountsTable, accountPropertiesTable, employeeAttendanceLogTable, employeeLeaveUsageTable, leaveRequestsTable, leaveTypesTable, branchesTable, recurringSchedulesTable } from "@workspace/db/schema";
import { eq, and, count, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { parseResRatesRow, resolveResidentialPayPct } from "../lib/commission-rates.js";
import { computePerTechCommissionRows, type JobTechRow } from "../lib/commission-paytype.js";
import { unionHoursByKey } from "../lib/timeclock-hours.js";
import { jobRevenueExpr } from "../lib/job-revenue-sql.js";
import { DAYS_AHEAD } from "../lib/recurring-jobs.js";
import { resolveBucketDisplay, ABSENT_DISPLAY } from "../lib/leave-bucket-display.js";

const router = Router();

// [tech-boundary 2026-06-17] All /api/dispatch routes are office-tier
// only — techs have no business reading the full company dispatch
// payload (every other tech's name, every client, every job). Was a
// real leak: dispatch.ts had ZERO requireRole calls before this PR
// even though every other office route in the codebase gated. A tech
// with the URL could hit GET /api/dispatch?date=... via devtools/curl
// and pull the entire day's office data.
const dispatchOfficeGate = requireRole("owner", "admin", "office", "super_admin");

// [combined-board 2026-06-17] Dispatch payload builder, extracted from the
// GET "/" handler so the cross-company /all-locations route can reuse it per
// owned company. Single-company behavior is unchanged — the route below just
// calls this and res.json()s the result.
// [trainee 2026-06-19] Trainee is DERIVED from hire_date — the first 3 weeks
// on the job — not a stored status. Phes has no "primary" tech; everyone is a
// technician, and a brand-new one is flagged "trainee" for 21 days so the
// office sees it on the board.
const TRAINEE_WINDOW_DAYS = 21;
function isTraineeFromHire(hireDate: string | Date | null | undefined): boolean {
  if (!hireDate) return false;
  const h = new Date(`${String(hireDate).slice(0, 10)}T00:00:00`);
  if (isNaN(h.getTime())) return false;
  const days = (Date.now() - h.getTime()) / 86400000;
  return days >= 0 && days <= TRAINEE_WINDOW_DAYS;
}

async function buildDispatchPayload(
  companyId: number,
  date: string,
  branch_id: string | undefined,
): Promise<{ employees: any[]; unassigned_jobs: any[] }> {

    // Only show field technicians on the dispatch board:
    // - role = technician or team_lead always included
    // - role = admin/owner/office only if their tags array contains 'field' or 'technician'
    const employees = await db
      .select({
        id: usersTable.id,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        role: usersTable.role,
        tags: usersTable.tags,
        hire_date: usersTable.hire_date,
        commission_rate: usersTable.commission_rate_override,
        // [2026-06-02] Surface avatar so the EmployeeRow can render the
        // tech's profile picture instead of initials. Frontend keeps the
        // initials fallback when avatar_url is null.
        avatar_url: usersTable.avatar_url,
      })
      .from(usersTable)
      .where(and(
        eq(usersTable.company_id, companyId),
        eq(usersTable.is_active, true),
        sql`(
          ${usersTable.role} NOT IN ('admin', 'owner', 'office', 'super_admin')
          OR (COALESCE(${usersTable.tags}, '{}') && ARRAY['field','technician']::text[])
        )`
      ))
      .orderBy(usersTable.first_name);

    const jobs = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        client_name: sql<string>`CASE WHEN ${jobsTable.account_id} IS NOT NULL THEN ${accountsTable.account_name} ELSE concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name}) END`,
        // [scheduling-engine 2026-04-29] Surface company_name +
        // first/last name separately so the chip can display
        // "Company - Contact" for commercial clients without an
        // account_id linkage (Jaira-style: client_type='commercial'
        // + clients.company_name set + no accounts row).
        client_company_name: clientsTable.company_name,
        client_first_name: clientsTable.first_name,
        client_last_name: clientsTable.last_name,
        client_phone: clientsTable.phone,
        // [AD] Prefer per-job address overrides (jobs.address_*) over the
        // client default (clients.*). MC-imported rows populate
        // jobs.address_street for one-off job-site addresses (e.g. Shannon
        // Heidloff's Apr 23 at 1111 Whitfield Rd while her client default
        // stays 4411 N Damen). We keep the field name `client_zip` to
        // preserve the frontend contract, but its semantic is now
        // "resolved job zip" — job-level preferred, client-level fallback.
        client_zip: sql<string | null>`COALESCE(NULLIF(${jobsTable.address_zip}, ''), ${clientsTable.zip})`,
        address: sql<string | null>`COALESCE(NULLIF(${jobsTable.address_street}, ''), ${clientsTable.address})`,
        city:    sql<string | null>`COALESCE(NULLIF(${jobsTable.address_city}, ''),   ${clientsTable.city})`,
        // [AI.7.6] State + zip pulled through so the canonical address
        // formatter can render "<street>, <city>, <state> <zip>" everywhere.
        // Job-level preferred, client-level fallback (mirrors the
        // address/city resolution above).
        state:   sql<string | null>`COALESCE(NULLIF(${jobsTable.address_state}, ''),  ${clientsTable.state})`,
        zip:     sql<string | null>`COALESCE(NULLIF(${jobsTable.address_zip}, ''),    ${clientsTable.zip})`,
        // [inline-edit] Raw fields needed by the popover address editor to
        // detect mode (job-level override vs client-level default) before
        // showing the form. Frontend compares jobs.address_* against
        // clients.* to pick the correct subtitle.
        job_address_street: jobsTable.address_street,
        job_address_city:   jobsTable.address_city,
        job_address_state:  jobsTable.address_state,
        job_address_zip:    jobsTable.address_zip,
        client_address: clientsTable.address,
        client_city:    clientsTable.city,
        client_state:   clientsTable.state,
        client_address_zip: clientsTable.zip,
        // [Q2] New: surface notes + payment method on the client row for hover card
        client_notes: clientsTable.notes,
        client_payment_method: clientsTable.payment_method,
        // [tile redesign] Client type drives the Res/Comm pill on the tile.
        // Commercial detection on the tile uses account_id OR client_type.
        client_type: clientsTable.client_type,
        assigned_user_id: jobsTable.assigned_user_id,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        // [count-rule 2026-06-08] job_kind distinguishes real visits ('cleaning')
        // from office events/meetings so the FE can exclude events from the count.
        job_kind: jobsTable.job_kind,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        time_change_pending: jobsTable.time_change_pending,
        time_change_from: jobsTable.time_change_from,
        frequency: jobsTable.frequency,
        base_fee: jobsTable.base_fee,
        allowed_hours: jobsTable.allowed_hours,
        notes: jobsTable.notes,
        zone_id: jobsTable.zone_id,
        // [distance-order 2026-06-12] Job coords (geocoded; address fallback) so
        // the Add tech picker can rank candidates by real distance, not just zone.
        job_lat: sql<number | null>`COALESCE(${jobsTable.job_lat}, ${jobsTable.address_lat})`,
        job_lng: sql<number | null>`COALESCE(${jobsTable.job_lng}, ${jobsTable.address_lng})`,
        // [Q2/S] Zone name/color — prefer direct JOIN (when jobs.zone_id set).
        // Fall back to deriving from clients.zip via service_zones.zip_codes.
        // [S] Second fallback: extract first 5-digit ZIP pattern from
        // clients.address text if clients.zip is NULL but address looks like
        // "... 60647" or similar. MC-imported rows have jobs.zone_id NULL, so
        // they rely on these fallbacks.
        // [AD] Zone derivation now uses the RESOLVED zip/address — job-level
        // preferred, client-level fallback. This way a client's recurring
        // service colors from their default zip, but a one-off job at a
        // different site colors from that site's zip. If neither jobs.address_zip
        // nor clients.zip is set, we still fall back to the 5-digit
        // pattern embedded in the street (same heuristic as S).
        // [AI.7.6] Zone resolution — extended to include
        // account_properties.zip / account_properties.address so commercial
        // jobs route to the right zone via the property's zip (was missing
        // — caused gray tiles on commercial jobs whose clients.zip was
        // null but the property had a zip). Resolution order:
        //   1. jobs.zone_id direct join (when explicit)
        //   2. jobs.address_zip → service_zones.zip_codes
        //   3. clients.zip → service_zones.zip_codes
        //   4. account_properties.zip → service_zones.zip_codes (NEW)
        //   5. regex-extracted 5-digit zip from any address text
        zone_color: sql<string | null>`COALESCE(
          ${serviceZonesTable.color},
          (SELECT z.color FROM service_zones z
             WHERE z.company_id = ${companyId}
               AND z.is_active = true
               AND (
                 NULLIF(${jobsTable.address_zip}, '') = ANY(z.zip_codes)
                 OR NULLIF(${clientsTable.zip}, '') = ANY(z.zip_codes)
                 OR NULLIF(${accountPropertiesTable.zip}, '') = ANY(z.zip_codes)
                 OR SUBSTRING(NULLIF(${jobsTable.address_street}, '') FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
                 OR SUBSTRING(NULLIF(${clientsTable.address}, '') FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
                 OR SUBSTRING(NULLIF(${accountPropertiesTable.address}, '') FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
               )
             LIMIT 1)
        )`,
        zone_name: sql<string | null>`COALESCE(
          ${serviceZonesTable.name},
          (SELECT z.name FROM service_zones z
             WHERE z.company_id = ${companyId}
               AND z.is_active = true
               AND (
                 NULLIF(${jobsTable.address_zip}, '') = ANY(z.zip_codes)
                 OR NULLIF(${clientsTable.zip}, '') = ANY(z.zip_codes)
                 OR NULLIF(${accountPropertiesTable.zip}, '') = ANY(z.zip_codes)
                 OR SUBSTRING(NULLIF(${jobsTable.address_street}, '') FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
                 OR SUBSTRING(NULLIF(${clientsTable.address}, '') FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
                 OR SUBSTRING(NULLIF(${accountPropertiesTable.address}, '') FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
               )
             LIMIT 1)
        )`,
        // [Q2] New: branch name from branches JOIN
        branch_id: jobsTable.branch_id,
        branch_name: branchesTable.name,
        // [Q2] New: most-recent prior service date from job_history. Only
        // counts rows strictly before this job's scheduled_date.
        last_service_date: sql<string | null>`(
          SELECT MAX(jh.job_date)::text FROM job_history jh
           WHERE jh.company_id = ${companyId}
             AND jh.customer_id = ${jobsTable.client_id}
             AND jh.job_date < ${jobsTable.scheduled_date}
        )`,
        account_id: jobsTable.account_id,
        account_name: accountsTable.account_name,
        billing_method: jobsTable.billing_method,
        hourly_rate: jobsTable.hourly_rate,
        estimated_hours: jobsTable.estimated_hours,
        actual_hours: jobsTable.actual_hours,
        billed_hours: jobsTable.billed_hours,
        billed_amount: jobsTable.billed_amount,
        // [tc-pay-sync 2026-07-01] Commissionable base (opt-in add-ons/mods,
        // #814) so the per-tech pay engine reproduces the time-clock/payroll
        // figure exactly. NULL → engine falls back to max(base_fee, billed).
        commission_base: jobsTable.commission_base,
        // [commercial-revenue 2026-06-04] Distinguishes an explicit flat
        // "Change price" / "Override rate" (true) from a normal commercial
        // job whose revenue is hourly_rate × allowed_hours (false). The
        // amount computation below branches on it so the hourly rate the
        // office sees ALWAYS reconciles with the billed total.
        manual_rate_override: jobsTable.manual_rate_override,
        // [AI.6.2] Drives the cascade prompt in the edit modal. Without this
        // field surfaced, every recurring job's edit modal silently submits
        // as cascade_scope='this_job' — operators never see the
        // "this and all future" option.
        recurring_schedule_id: jobsTable.recurring_schedule_id,
        // [PR #27] Surfaced for the parking-fee day picker render gate
        // in edit-job-modal.tsx. When a job is attached to a multi-day
        // recurring schedule (daily/weekdays/custom_days), the modal
        // renders the picker even if the job's local form-level
        // frequency state lags. Null when no schedule attached.
        recurring_schedule_days_of_week: recurringSchedulesTable.days_of_week,
        charge_failed_at: jobsTable.charge_failed_at,
        charge_succeeded_at: jobsTable.charge_succeeded_at,
        account_property_id: jobsTable.account_property_id,
        property_address: accountPropertiesTable.address,
        property_city: accountPropertiesTable.city,
        property_state: accountPropertiesTable.state,
        property_zip: accountPropertiesTable.zip,
        property_access_notes: accountPropertiesTable.access_notes,
        // [building-notes 2026-07-07] Live building-level OFFICE note — shown
        // on every job at this property. Replaces the removed copy-into-
        // jobs.office_notes propagation (the cross-visit note bleed).
        property_notes: accountPropertiesTable.notes,
        office_notes: jobsTable.office_notes,
        office_notes_updated_by: jobsTable.office_notes_updated_by,
        office_notes_updated_at: jobsTable.office_notes_updated_at,
        // [AF] Completion flow surface-area — drawer renders read-only state
        // when locked_at is set. actual_end_time + completed_by render the
        // "Completed at …" label below the Mark Complete slot.
        locked_at: jobsTable.locked_at,
        actual_end_time: jobsTable.actual_end_time,
        completed_by_user_id: jobsTable.completed_by_user_id,
        // [phes-lifecycle 2026-04-29] Manual no-show flag — drives the
        // NO_SHOW visual state. Set by the field app's "No Show" button
        // after the tech waits NO_SHOW_WAIT_MINUTES on-site for the
        // customer.
        no_show_marked_by_tech: jobsTable.no_show_marked_by_tech,
        no_show_marked_by_user_id: jobsTable.no_show_marked_by_user_id,
        // [dispatch-invoice 2026-06-27] Live invoice for this job so the panel
        // can show "View Invoice" + status without a second fetch. Uses the
        // most-recent non-void, non-superseded invoice (idempotent engine
        // ensures at most one, but guard order is safest). Null on pre-cutover
        // or uncompleted jobs that have no invoice yet.
        // [job-card-invoice-link 2026-07-06] Also matches invoices that carry
        // the job INSIDE line_items (consolidated account invoices from
        // POST /api/accounts/:id/generate-invoice, merge parents) — those have
        // job_id NULL, so the direct-FK match alone left the job card showing
        // "No invoice yet" even though the invoice existed (Maribel, Awaken
        // Church common-areas). Direct job_id match wins over a line-item
        // match; the @> containment predicate is the same one the account
        // uninvoiced-jobs dedup guard uses. Third arm: historical merge
        // parents created before lines carried job_id — follow the job's
        // superseded child (which kept its job_id) up to its parent.
        invoice_id: sql<number | null>`(SELECT iv.id FROM invoices iv WHERE iv.company_id = ${jobsTable.company_id} AND iv.status NOT IN ('void','superseded') AND (iv.job_id = ${jobsTable.id} OR iv.line_items @> jsonb_build_array(jsonb_build_object('job_id', ${jobsTable.id})) OR EXISTS (SELECT 1 FROM invoices ch WHERE ch.company_id = iv.company_id AND ch.parent_invoice_id = iv.id AND ch.job_id = ${jobsTable.id})) ORDER BY (iv.job_id = ${jobsTable.id}) DESC, iv.created_at DESC LIMIT 1)`,
        invoice_status: sql<string | null>`(SELECT iv.status FROM invoices iv WHERE iv.company_id = ${jobsTable.company_id} AND iv.status NOT IN ('void','superseded') AND (iv.job_id = ${jobsTable.id} OR iv.line_items @> jsonb_build_array(jsonb_build_object('job_id', ${jobsTable.id})) OR EXISTS (SELECT 1 FROM invoices ch WHERE ch.company_id = iv.company_id AND ch.parent_invoice_id = iv.id AND ch.job_id = ${jobsTable.id})) ORDER BY (iv.job_id = ${jobsTable.id}) DESC, iv.created_at DESC LIMIT 1)`,
        invoice_total: sql<string | null>`(SELECT iv.total FROM invoices iv WHERE iv.company_id = ${jobsTable.company_id} AND iv.status NOT IN ('void','superseded') AND (iv.job_id = ${jobsTable.id} OR iv.line_items @> jsonb_build_array(jsonb_build_object('job_id', ${jobsTable.id})) OR EXISTS (SELECT 1 FROM invoices ch WHERE ch.company_id = iv.company_id AND ch.parent_invoice_id = iv.id AND ch.job_id = ${jobsTable.id})) ORDER BY (iv.job_id = ${jobsTable.id}) DESC, iv.created_at DESC LIMIT 1)`,
        // [commission-override 2026-06-27] Office-set pool rate override for demanding jobs.
        commission_override_pct: sql<number | null>`(SELECT commission_override_pct FROM jobs WHERE id = ${jobsTable.id} LIMIT 1)`,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(accountPropertiesTable, eq(jobsTable.account_property_id, accountPropertiesTable.id))
      .leftJoin(serviceZonesTable, eq(jobsTable.zone_id, serviceZonesTable.id))
      .leftJoin(branchesTable, eq(jobsTable.branch_id, branchesTable.id))
      // [PR #27] Surfaces recurring_schedule_days_of_week for the
      // edit-modal parking picker gate. LEFT JOIN — null when the
      // job has no schedule attached.
      .leftJoin(recurringSchedulesTable, eq(jobsTable.recurring_schedule_id, recurringSchedulesTable.id))
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.scheduled_date, date),
        sql`${jobsTable.status} != 'cancelled'`,
        // [cancel-off-board 2026-06-18] A charged Cancel/Lockout keeps
        // status='complete' (so the fee counts as revenue + shows in the Fees
        // report + client profile), but it is NOT work on the schedule — keep
        // it OFF the dispatch board so a cancelled visit doesn't sit in a tech's
        // lane (Sal: "it's still on the job board, I need it off"). The fee is
        // still tracked everywhere else.
        sql`NOT EXISTS (SELECT 1 FROM cancellation_log cl WHERE cl.job_id = ${jobsTable.id} AND cl.cancel_action IN ('cancel','lockout'))`,
        // [quote-convert-branch 2026-06-08] Untagged (NULL-branch) jobs must NOT
        // vanish under a location filter. Quote→job convert never set branch_id,
        // so converted jobs "didn't stick" on the board when the office viewed a
        // specific branch (Oak Lawn). Treat NULL branch as "shows under any
        // branch" — same fix as the techs-disappearing-under-Oak-Lawn case.
        ...(branch_id && branch_id !== "all"
          ? [sql`(${jobsTable.branch_id} = ${parseInt(branch_id)} OR ${jobsTable.branch_id} IS NULL)`]
          : [])
      ))
      .orderBy(jobsTable.scheduled_time);

    // Employee zone assignments. [2026-06-02] Two sources, in priority:
    //   1. users.zip → service_zones.zip_codes match — "the zone the tech
    //      lives in" (Sal's spec). This auto-updates when an operator
    //      edits the tech's home address; no manual zone assignment needed.
    //   2. service_zone_employees row — legacy/manual override, used as a
    //      fallback when the tech has no home zip on file or their zip
    //      doesn't match any zone's zip_codes list.
    // The small dot next to each tech's name on the dispatch row uses this
    // resolved zone — purple for Chicago Central, etc.
    const empZoneRows = await db.execute(sql`
      SELECT
        u.id AS user_id,
        COALESCE(home_match.id, manual_match.zone_id) AS zone_id,
        COALESCE(home_match.color, manual_match.zone_color) AS zone_color,
        COALESCE(home_match.name, manual_match.zone_name) AS zone_name,
        CASE WHEN home_match.id IS NOT NULL THEN 'home' ELSE 'manual' END AS zone_source
      FROM users u
      LEFT JOIN LATERAL (
        SELECT z.id, z.color, z.name
        FROM service_zones z
        WHERE z.company_id = ${companyId}
          AND z.is_active = true
          AND NULLIF(u.zip, '') = ANY(z.zip_codes)
        LIMIT 1
      ) home_match ON true
      LEFT JOIN (
        SELECT sze.user_id, sze.zone_id, sz.color AS zone_color, sz.name AS zone_name
        FROM service_zone_employees sze
        JOIN service_zones sz ON sz.id = sze.zone_id
        WHERE sze.company_id = ${companyId}
      ) manual_match ON manual_match.user_id = u.id
      WHERE u.company_id = ${companyId}
        AND (home_match.id IS NOT NULL OR manual_match.zone_id IS NOT NULL)
    `);
    const empZoneMap: Record<number, { zone_id: number; zone_color: string; zone_name: string; zone_source: 'home' | 'manual' }> = {};
    for (const r of empZoneRows.rows as any[]) {
      if (!empZoneMap[r.user_id] && r.zone_id != null) {
        empZoneMap[r.user_id] = {
          zone_id: Number(r.zone_id),
          zone_color: String(r.zone_color),
          zone_name: String(r.zone_name),
          zone_source: r.zone_source === 'home' ? 'home' : 'manual',
        };
      }
    }

    // Time-off data for the board date
    // [time-block 2026-07-08] Manual entries now carry a DESIGNATION
    // (leave_type_id on deductions) and an optional TIME BLOCK (start/end on
    // both tables). The board used to guess: any office deduction rendered as
    // full-day PTO (Hilda's 4h UNPAID 2-6 PM block), and a partial call-off
    // tinted the whole row (Jose worked his morning job). Now the slug comes
    // from the record and the tint covers only the designated window.
    const leaveUsage = await db
      .select({
        employee_id: employeeLeaveUsageTable.employee_id,
        slug: leaveTypesTable.slug,
        start_time: employeeLeaveUsageTable.start_time,
        end_time: employeeLeaveUsageTable.end_time,
      })
      .from(employeeLeaveUsageTable)
      .leftJoin(leaveTypesTable, eq(employeeLeaveUsageTable.leave_type_id, leaveTypesTable.id))
      .where(and(
        eq(employeeLeaveUsageTable.company_id, companyId),
        eq(employeeLeaveUsageTable.date_used, date),
      ));

    // Sick / absent from attendance log for this date
    const attendanceLogs = await db
      .select({
        employee_id: employeeAttendanceLogTable.employee_id,
        type: employeeAttendanceLogTable.type,
        start_time: employeeAttendanceLogTable.start_time,
        end_time: employeeAttendanceLogTable.end_time,
      })
      .from(employeeAttendanceLogTable)
      .where(and(
        eq(employeeAttendanceLogTable.company_id, companyId),
        eq(employeeAttendanceLogTable.log_date, date),
        sql`${employeeAttendanceLogTable.type} IN ('plawa_leave','protected_leave','absent','ncns')`,
      ));

    // Approved leave requests overlapping the board date → the FOUR distinct
    // buckets + the day unit (full/AM/PM/custom). This is the authoritative
    // source so PTO / PLAWA / Unpaid / Unexcused each show distinctly; a
    // half-day keeps the tech available the worked half (we surface the unit;
    // the board treats half-days as still-suggestable).
    const approvedLeave = await db
      .select({ user_id: leaveRequestsTable.user_id, slug: leaveTypesTable.slug, day_unit: leaveRequestsTable.day_unit, start_time: leaveRequestsTable.start_time, end_time: leaveRequestsTable.end_time })
      .from(leaveRequestsTable)
      .innerJoin(leaveTypesTable, eq(leaveRequestsTable.leave_type_id, leaveTypesTable.id))
      .where(and(
        eq(leaveRequestsTable.company_id, companyId),
        eq(leaveRequestsTable.status, 'approved'),
        sql`${leaveRequestsTable.start_date} <= ${date} AND ${leaveRequestsTable.end_date} >= ${date}`,
      ));
    // [Phase 3] Tenant-dynamic bucket display: resolve each bucket's row tint +
    // label from the tenant's own leave_types.display_config (no hardcoded
    // SLUG_TO_BUCKET / TIME_OFF_BG). time_off is now the SLUG; the board renders
    // the returned time_off_color / time_off_label directly.
    const tenantBuckets = await db
      .select({ slug: leaveTypesTable.slug, display_name: leaveTypesTable.display_name, display_config: leaveTypesTable.display_config })
      .from(leaveTypesTable)
      .where(eq(leaveTypesTable.company_id, companyId));
    const bucketDisplayBySlug = new Map(
      tenantBuckets.map((b) => [String(b.slug), resolveBucketDisplay(b as any)]),
    );
    type TimeOffRec = { slug: string; unit: 'full_day' | 'morning' | 'afternoon' | 'custom'; start: string | null; end: string | null };
    const hhmm = (t: any): string | null => (t ? String(t).slice(0, 5) : null);
    const blockUnit = (start: any, end: any): 'full_day' | 'custom' => (start && end ? 'custom' : 'full_day');
    // Priority: approved leave request (authoritative) → attendance log →
    // manual leave-usage deduction. First writer per employee wins within
    // each tier; a request always beats manual rows.
    const timeOffByEmp = new Map<number, TimeOffRec>();
    for (const r of [...attendanceLogs.map(a => ({
      employee_id: a.employee_id,
      // The board's designation for an office-recorded absence/ncns is the
      // tenant's UNEXCUSED bucket (its color/label were picked by the
      // office); plawa/protected map to the PLAWA bucket. 'absent' pseudo-
      // bucket stays the fallback when the tenant has no unexcused bucket.
      slug: (a.type === 'plawa_leave' || a.type === 'protected_leave')
        ? 'plawa'
        : (bucketDisplayBySlug.has('unexcused') ? 'unexcused' : 'absent'),
      start_time: a.start_time, end_time: a.end_time,
    })), ...leaveUsage.map(u => ({
      employee_id: u.employee_id,
      // Designation from the deduction's recorded bucket; legacy rows
      // without one keep the old PTO assumption.
      slug: u.slug ? String(u.slug) : 'pto_phes',
      start_time: u.start_time, end_time: u.end_time,
    }))]) {
      if (!timeOffByEmp.has(r.employee_id)) {
        timeOffByEmp.set(r.employee_id, { slug: r.slug, unit: blockUnit(r.start_time, r.end_time), start: hhmm(r.start_time), end: hhmm(r.end_time) });
      }
    }
    for (const r of approvedLeave) {
      timeOffByEmp.set(r.user_id, {
        slug: String(r.slug),
        unit: String(r.day_unit) as TimeOffRec['unit'],
        start: hhmm((r as any).start_time),
        end: hhmm((r as any).end_time),
      });
    }

    function getTimeOff(empId: number): string | null {
      return timeOffByEmp.get(empId)?.slug ?? null;
    }
    function getTimeOffUnit(empId: number): TimeOffRec['unit'] | null {
      return timeOffByEmp.get(empId)?.unit ?? null;
    }
    function getTimeOffBlock(empId: number): { start: string | null; end: string | null } {
      const rec = timeOffByEmp.get(empId);
      return { start: rec?.start ?? null, end: rec?.end ?? null };
    }
    function getTimeOffColor(empId: number): string | null {
      const slug = getTimeOff(empId);
      if (!slug) return null;
      if (slug === 'absent') return ABSENT_DISPLAY.tint;
      return bucketDisplayBySlug.get(slug)?.tint ?? null;
    }
    function getTimeOffLabel(empId: number): string | null {
      const slug = getTimeOff(empId);
      if (!slug) return null;
      if (slug === 'absent') return ABSENT_DISPLAY.board_label;
      return bucketDisplayBySlug.get(slug)?.board_label ?? null;
    }

    if (jobs.length === 0) {
      return {
        employees: employees.map(e => ({
          ...e,
          name: `${e.first_name} ${e.last_name}`,
          is_trainee: isTraineeFromHire(e.hire_date),
          jobs: [],
          zone: empZoneMap[e.id] ?? null,
          time_off: getTimeOff(e.id),
          time_off_unit: getTimeOffUnit(e.id),
          time_off_color: getTimeOffColor(e.id),
          time_off_label: getTimeOffLabel(e.id),
          time_off_start: getTimeOffBlock(e.id).start,
          time_off_end: getTimeOffBlock(e.id).end,
          commission_rate: e.commission_rate ? parseFloat(e.commission_rate) : null,
        })),
        unassigned_jobs: [],
      };
    }

    const jobIds = jobs.map(j => j.id);
    const idList = jobIds.join(",");

    const photoCounts = await db
      .select({ job_id: jobPhotosTable.job_id, photo_type: jobPhotosTable.photo_type, cnt: count() })
      .from(jobPhotosTable)
      .where(sql`${jobPhotosTable.job_id} = ANY(ARRAY[${sql.raw(idList)}]::int[])`)
      .groupBy(jobPhotosTable.job_id, jobPhotosTable.photo_type);

    const clockEntries = await db
      .select({
        id: timeclockTable.id,
        job_id: timeclockTable.job_id,
        user_id: timeclockTable.user_id,
        clock_in_at: timeclockTable.clock_in_at,
        clock_out_at: timeclockTable.clock_out_at,
        distance_from_job_ft: timeclockTable.distance_from_job_ft,
        flagged: timeclockTable.flagged,
        clock_in_lat: timeclockTable.clock_in_lat,
        clock_in_lng: timeclockTable.clock_in_lng,
        clock_in_distance_ft: timeclockTable.clock_in_distance_ft,
        clock_out_distance_ft: timeclockTable.clock_out_distance_ft,
        clock_in_outside_geofence: timeclockTable.clock_in_outside_geofence,
        clock_out_outside_geofence: timeclockTable.clock_out_outside_geofence,
        source: timeclockTable.source,
      })
      .from(timeclockTable)
      .where(sql`${timeclockTable.job_id} = ANY(ARRAY[${sql.raw(idList)}]::int[])`);

    // [notes-author] id → name, to resolve who last edited the office notes
    // (office staff aren't in the technician `employees` list above).
    const allCompanyUsers = await db
      .select({ id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name })
      .from(usersTable)
      .where(eq(usersTable.company_id, companyId));
    const userNameById = new Map<number, string>();
    for (const u of allCompanyUsers) userNameById.set(u.id, `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim());

    // [lockout-visibility 2026-06-17] A charged Cancel/Lockout leaves the job
    // status='complete' (so it counts as revenue) but it is NOT a real visit.
    // Surface cancel_action per job so the chip + drawer can badge it as a
    // fee charge instead of a normal completed clean (Sal: "no indication
    // this job was saved as a lockout/cancel anywhere").
    const cancelActionByJob = new Map<number, string>();
    try {
      const jobIds = (jobs as any[]).map((j: any) => j.id).filter((x: any) => x != null);
      if (jobIds.length) {
        const cc = await db.execute(sql`
          SELECT DISTINCT job_id, cancel_action FROM cancellation_log
           WHERE company_id = ${companyId} AND cancel_action IN ('cancel','lockout')
             AND job_id IN (${sql.join(jobIds.map((n: number) => sql`${n}`), sql`, `)})`);
        for (const r of cc.rows as any[]) cancelActionByJob.set(Number(r.job_id), String(r.cancel_action));
      }
    } catch { /* cancellation_log absent — no badge */ }

    // [gps-flag] Tenant toggle — when off, suppress the "GPS unavailable" flag.
    const gpsFlagRow = await db.execute(sql`SELECT flag_missing_gps FROM companies WHERE id = ${companyId} LIMIT 1`);
    const flagMissingGps = (gpsFlagRow.rows[0] as any)?.flag_missing_gps ?? true;

    const photoMap = new Map<number, { before: number; after: number }>();
    for (const row of photoCounts) {
      if (!photoMap.has(row.job_id)) photoMap.set(row.job_id, { before: 0, after: 0 });
      const e = photoMap.get(row.job_id)!;
      if (row.photo_type === "before") e.before = row.cnt;
      else if (row.photo_type === "after") e.after = row.cnt;
    }

    const clockMap = new Map<number, typeof clockEntries[0]>();
    for (const e of clockEntries) {
      if (!clockMap.has(e.job_id) || !e.clock_out_at) clockMap.set(e.job_id, e);
    }

    // Fetch job_technicians + per-employee pay matrix for commission
    // display. The four pay-matrix columns drive the per-tech
    // commission calculation below; each tech can be on a different
    // (residential|commercial) × (commission|hourly) combo.
    const techRows = await db.execute(sql`
      SELECT jt.job_id, jt.user_id, jt.is_primary, jt.pay_override, jt.final_pay,
             jt.pay_type, jt.hourly_rate, jt.commission_pct,
             jt.pay_deduction_pct, jt.pay_deduction_flat,
             u.first_name, u.last_name,
             u.residential_pay_type, u.residential_pay_rate,
             u.commercial_pay_type,  u.commercial_pay_rate
      FROM job_technicians jt
      JOIN users u ON u.id = jt.user_id
      WHERE jt.job_id = ANY(ARRAY[${sql.raw(idList)}]::int[])
      ORDER BY jt.job_id, jt.is_primary DESC, jt.id
    `);

    // Fetch company commission rates. resPct = residential pool fraction;
    // commercialHourlyRate = flat $/hr commercial commission base.
    // [AI.7.5.hotfix] Try the joint SELECT first; if commercial_hourly_rate
    // column is absent (older DB, migration hadn't yet run on Railway when
    // AI.7.4 deployed → blanked the dispatch board), retry with just
    // res_tech_pay_pct and default the commercial rate to $20/hr.
    // The migration in phes-data-migration.ts now provisions the column,
    // but the fallback stays so a missing column never breaks dispatch
    // again.
    let resRates = parseResRatesRow(null);
    let commercialHourlyRate = 20;
    try {
      const compRows = await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate FROM companies WHERE id = ${companyId} LIMIT 1`);
      const row = (compRows.rows[0] as any);
      if (row) {
        resRates = parseResRatesRow(row);
        commercialHourlyRate = parseFloat(String(row.commercial_hourly_rate ?? 20));
      }
    } catch {
      // Tiered columns absent — fall back to legacy SELECT, keep tier defaults (0.32 / 0.32)
      try {
        const compRows = await db.execute(sql`SELECT res_tech_pay_pct, commercial_hourly_rate FROM companies WHERE id = ${companyId} LIMIT 1`);
        const row = (compRows.rows[0] as any);
        if (row) {
          resRates = parseResRatesRow(row);
          commercialHourlyRate = parseFloat(String(row.commercial_hourly_rate ?? 20));
        }
      } catch {
        try {
          const fallback = await db.execute(sql`SELECT res_tech_pay_pct FROM companies WHERE id = ${companyId} LIMIT 1`);
          const row = (fallback.rows[0] as any);
          if (row) resRates = parseResRatesRow(row);
        } catch { /* keep defaults */ }
      }
    }
    // Standard residential rate kept for the legacy company_res_pct
    // payload field consumed by the JobPanel; per-job branching uses
    // resolveResidentialPayPct(serviceType, resRates) below.
    const resPct = resRates.res_tech_pay_pct;

    type TechRow = {
      user_id: number;
      name: string;
      is_primary: boolean;
      pay_override: number | null;
      final_pay: number | null;
      residential_pay_type: "commission" | "hourly";
      residential_pay_rate: number;
      commercial_pay_type: "commission" | "hourly";
      commercial_pay_rate: number;
      // [tc-pay-sync 2026-07-01] Per-JOB pay override the office sets on the
      // time clock (job_technicians). When present it drives actual pay via the
      // shared engine, overriding the employee-matrix estimate below.
      pay_type: string | null;
      hourly_rate: string | null;
      commission_pct: string | null;
      pay_deduction_pct: string | null;
      pay_deduction_flat: string | null;
    };
    const techByJob = new Map<number, TechRow[]>();
    for (const r of techRows.rows as any[]) {
      if (!techByJob.has(r.job_id)) techByJob.set(r.job_id, []);
      techByJob.get(r.job_id)!.push({
        user_id: r.user_id,
        name: `${r.first_name} ${r.last_name}`,
        is_primary: !!r.is_primary,
        pay_override: r.pay_override != null ? parseFloat(String(r.pay_override)) : null,
        final_pay: r.final_pay != null ? parseFloat(String(r.final_pay)) : null,
        residential_pay_type: (r.residential_pay_type === "hourly" ? "hourly" : "commission") as "commission" | "hourly",
        residential_pay_rate: r.residential_pay_rate != null ? parseFloat(String(r.residential_pay_rate)) : 0.35,
        commercial_pay_type:  (r.commercial_pay_type  === "commission" ? "commission" : "hourly")  as "commission" | "hourly",
        commercial_pay_rate:  r.commercial_pay_rate  != null ? parseFloat(String(r.commercial_pay_rate))  : 20,
        pay_type: r.pay_type ?? null,
        hourly_rate: r.hourly_rate != null ? String(r.hourly_rate) : null,
        commission_pct: r.commission_pct != null ? String(r.commission_pct) : null,
        pay_deduction_pct: r.pay_deduction_pct != null ? String(r.pay_deduction_pct) : null,
        pay_deduction_flat: r.pay_deduction_flat != null ? String(r.pay_deduction_flat) : null,
      });
    }

    // [tc-pay-sync 2026-07-01] Reconcile the dispatch Commission tile with the
    // TIME CLOCK / payroll. Historically dispatch computed each tech's pay from
    // the employee pay-matrix (users.residential/commercial_pay_type+rate) — a
    // SEPARATE model from what actually pays people (computePerTechCommissionRows,
    // driven by the per-JOB override on job_technicians + actual clocked hours).
    // So when the office set Jose=Fee Split 32% / Hilda=Hourly on the time clock,
    // the dispatch card kept showing the stale matrix estimate ($60+$60=$120)
    // instead of the real split ($76.80 + $60.01). We now run the SAME engine
    // here and use its dollars for any job the office has actually touched —
    // one that has real punches OR a per-tech pay-type override. Untouched jobs
    // keep the existing matrix estimate, so this is a targeted correction with
    // no blast radius on jobs nobody has configured yet.
    const enginePayByKey = new Map<string, number>();   // "job_id:user_id" → $
    const engineJobIds = new Set<number>();
    try {
      // Jobs with a per-tech pay-type override set on the time clock.
      for (const r of techRows.rows as any[]) {
        if (r.pay_type != null) engineJobIds.add(Number(r.job_id));
      }
      // Jobs with at least one REAL (punched) closed clock pair.
      const punched = clockEntries.filter((e: any) => e.source === "punched" && e.clock_in_at && e.clock_out_at);
      for (const e of punched) engineJobIds.add(Number(e.job_id));

      if (engineJobIds.size > 0) {
        const techHoursByKey = unionHoursByKey(punched as any);
        // Per-service fee-split % (mirrors the time-clock/payroll path).
        const serviceTypePctBySlug = new Map<string, number>();
        try {
          const svc = await db.execute(sql`SELECT slug, commission_pct FROM service_types WHERE company_id = ${companyId} AND commission_pct IS NOT NULL`);
          for (const s of svc.rows as any[]) { const p = parseFloat(String(s.commission_pct)); if (Number.isFinite(p)) serviceTypePctBySlug.set(String(s.slug).toLowerCase(), p); }
        } catch { /* per-service column absent */ }
        let commercialCompMode: "allowed_hours" | "actual_hours" = "allowed_hours";
        try {
          const cm = await db.execute(sql`SELECT commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
          if ((cm.rows[0] as any)?.commercial_comp_mode === "actual_hours") commercialCompMode = "actual_hours";
        } catch { /* column absent — keep allowed_hours */ }
        const commercial = { commercial_hourly_rate: commercialHourlyRate, commercial_comp_mode: commercialCompMode };

        const jobsForCalc = jobs
          .filter((j: any) => engineJobIds.has(Number(j.id)))
          .map((j: any) => ({
            id: Number(j.id),
            assigned_user_id: j.assigned_user_id != null ? Number(j.assigned_user_id) : null,
            service_type: j.service_type ?? null,
            account_id: j.account_id ?? null,
            base_fee: j.base_fee ?? null,
            billed_amount: j.billed_amount ?? null,
            commission_base: j.commission_base ?? null,
            allowed_hours: j.allowed_hours ?? null,
            actual_hours: null,
            branch_id: j.branch_id ?? null,
            scheduled_date: j.scheduled_date ?? date,
            client_type: (j as any).client_type ?? null,
          }));
        const jobTechsForCalc: JobTechRow[] = (techRows.rows as any[])
          .filter((t: any) => engineJobIds.has(Number(t.job_id)))
          .map((t: any) => ({
            job_id: Number(t.job_id), user_id: Number(t.user_id), is_primary: t.is_primary === true,
            pay_type: t.pay_type ?? null, hourly_rate: t.hourly_rate ?? null, commission_pct: t.commission_pct ?? null,
            pay_deduction_pct: t.pay_deduction_pct ?? null, pay_deduction_flat: t.pay_deduction_flat ?? null,
          }));
        for (const r of computePerTechCommissionRows({ jobs: jobsForCalc, jobTechs: jobTechsForCalc, techHoursByKey, serviceTypePctBySlug, resRates, commercial })) {
          enginePayByKey.set(`${r.job_id}:${r.user_id}`, r.amount);
        }
      }
    } catch (e) { console.error("[dispatch] tc-pay-sync engine error:", e); /* fall back to matrix estimate */ }

    // [job-card-redesign] Add-ons per job — drives the "+N" pill on the
    // dispatch chip and the full add-on list in the hover popover. Names
    // come from pricing_addons (preferred, the modern path) with a
    // fallback to the legacy add_ons table for rows imported before
    // pricing_addons existed. Subtotals already reflect quantity × unit
    // price as written by PATCH /api/jobs/:id, so the chip can sum them
    // into a delta without re-multiplying.
    const addOnRows = await db.execute(sql`
      SELECT jao.job_id, jao.quantity, jao.unit_price, jao.subtotal,
             jao.pricing_addon_id, jao.add_on_id,
             COALESCE(pa.name, ao.name) AS name
        FROM job_add_ons jao
        LEFT JOIN add_ons ao ON ao.id = jao.add_on_id
        LEFT JOIN pricing_addons pa ON pa.id = jao.pricing_addon_id
       WHERE jao.job_id = ANY(ARRAY[${sql.raw(idList)}]::int[])
    `);
    // [job-card-redesign 2026-06-25] Carry pricing_addon_id + add_on_id so the
    // card's inline pricing editor can persist edits/removals via the same
    // PATCH /api/jobs/:id { base_fee, add_ons } the edit-modal uses.
    const addOnsByJob = new Map<number, Array<{ name: string; quantity: number; unit_price: number; subtotal: number; pricing_addon_id: number | null; add_on_id: number | null }>>();
    for (const r of addOnRows.rows as any[]) {
      if (!addOnsByJob.has(r.job_id)) addOnsByJob.set(r.job_id, []);
      addOnsByJob.get(r.job_id)!.push({
        name: r.name ?? "Add-on",
        quantity: r.quantity != null ? parseFloat(String(r.quantity)) : 1,
        unit_price: r.unit_price != null ? parseFloat(String(r.unit_price)) : 0,
        subtotal: r.subtotal != null ? parseFloat(String(r.subtotal)) : 0,
        pricing_addon_id: r.pricing_addon_id != null ? Number(r.pricing_addon_id) : null,
        add_on_id: r.add_on_id != null ? Number(r.add_on_id) : null,
      });
    }

    // [BUG-6 follow-up / 2026-06-02] Rate-mod totals per job for the LIVE
    // amount computation. Previously dispatch read jobs.billed_amount, but
    // PATCH /api/jobs/:id changes base_fee without recomputing that cache,
    // so any edit left dispatch reporting the stale pre-edit total
    // (Jaira's 4322: base_fee 320→400 left billed_amount at 320; dispatch
    // showed 340 = 320 + 20 parking, not the correct 420). One aggregated
    // query keyed by job_id avoids N+1 round trips.
    const rateModSumByJob = new Map<number, number>();
    // [commercial-revenue 2026-06-04] Flat-only mod total. Commercial revenue
    // is rate × allowed_hours, and a 'time' mod already grew allowed_hours
    // (PR #307), so re-adding its dollar amount would double-count the added
    // time. Commercial therefore adds only 'flat' mods; residential keeps the
    // all-mods total.
    const flatModSumByJob = new Map<number, number>();
    if (idList.length > 0) {
      const modRows = await db.execute(sql`
        SELECT job_id,
               COALESCE(SUM(amount), 0)::numeric AS total,
               COALESCE(SUM(amount) FILTER (WHERE mod_type = 'flat'), 0)::numeric AS flat_total
          FROM job_rate_mods
         WHERE job_id = ANY(ARRAY[${sql.raw(idList)}]::int[])
         GROUP BY job_id
      `);
      for (const r of modRows.rows as any[]) {
        rateModSumByJob.set(Number(r.job_id), parseFloat(String(r.total ?? "0")));
        flatModSumByJob.set(Number(r.job_id), parseFloat(String(r.flat_total ?? "0")));
      }
    }

    // [discount-net 2026-07-02] Per-job discount total (job_discounts.amount).
    // The invoice subtracts these; the dispatch card total must too, so the card
    // MIRRORS the invoice. Loaded once (same pattern as the rate-mod sum above).
    const discountSumByJob = new Map<number, number>();
    if (idList.length > 0) {
      const discRows = await db.execute(sql`
        SELECT job_id, COALESCE(SUM(amount), 0)::numeric AS total
          FROM job_discounts
         WHERE job_id = ANY(ARRAY[${sql.raw(idList)}]::int[])
         GROUP BY job_id
      `);
      for (const r of discRows.rows as any[]) {
        discountSumByJob.set(Number(r.job_id), parseFloat(String(r.total ?? "0")));
      }
    }

    // [job-card-redesign] is_new_client — true when the residential client
    // has zero completed jobs strictly before today's board date. Drives
    // the "NEW" pill + inset white outline on the chip. Commercial jobs
    // (account_id set) always read false — the account contract is the
    // billing entity, not a person, and "first job for this account"
    // doesn't carry the same operational signal.
    const residentialClientIds: number[] = [];
    const seenClientIds = new Set<number>();
    for (const j of jobs) {
      if (!j.account_id && j.client_id != null && !seenClientIds.has(j.client_id)) {
        seenClientIds.add(j.client_id);
        residentialClientIds.push(j.client_id);
      }
    }
    const clientsWithPriorComplete = new Set<number>();
    if (residentialClientIds.length > 0) {
      const clientList = residentialClientIds.join(",");
      const priorRows = await db.execute(sql`
        SELECT DISTINCT client_id FROM jobs
         WHERE company_id = ${companyId}
           AND status = 'complete'
           AND scheduled_date < ${date}
           AND client_id = ANY(ARRAY[${sql.raw(clientList)}]::int[])
      `);
      for (const r of priorRows.rows as any[]) {
        if (r.client_id != null) clientsWithPriorComplete.add(r.client_id);
      }
    }

    const mappedJobs = jobs.map(j => {
      const clock = clockMap.get(j.id);
      const photos = photoMap.get(j.id) || { before: 0, after: 0 };
      // Build commission data for this job (moved up — durationMinutes now
      // depends on numTechs to divide team-aggregated allowed_hours into
      // calendar time per job)
      const jobTechs = techByJob.get(j.id) || [];
      const numTechsForDur = jobTechs.length || 1;
      // [Z] MC's allowed_hours is TEAM-AGGREGATED (e.g. 11.25 across 2
      // techs = 5.625h calendar time). Divide by tech count so the Gantt
      // chip reflects actual calendar time, not summed tech-hours.
      // For single-tech jobs, numTechs=1 → no-op. Minimum 30 min so a
      // badly-configured alwd_hours=0.5 on a team doesn't collapse.
      const durationMinutes = j.allowed_hours
        ? Math.max(30, Math.round((parseFloat(j.allowed_hours) / numTechsForDur) * 60))
        : 120;
      const isCommercial = !!j.account_id;
      // [commercial-clients 2026-06-02] Pay routing is broader than the
      // account flag: a commercial CLIENT (client_type='commercial', no
      // account) is ALSO paid the commercial way (hourly × allowed_hours),
      // never a residential %. `isCommercial` stays account-only for address
      // / account-contract display; `isCommercialPay` drives the commission.
      const isCommercialPay = isCommercial || (j as any).client_type === "commercial";
      // [AI.7.6] Canonical address render: "<street>, <city>, <state> <zip>".
      // formatAddress() inlined here on the server side; the same shape
      // ships to the frontend so there's only one rule. State + zip are
      // mandatory if address is shown — see CLAUDE.md "Address display"
      // invariant.
      const fmtAddr = (street?: string | null, city?: string | null, state?: string | null, zip?: string | null): string | null => {
        const parts: string[] = [];
        if (street) parts.push(street.trim());
        if (city) parts.push(city.trim());
        const stateZip = [state?.trim(), zip?.trim()].filter(Boolean).join(" ");
        if (stateZip) parts.push(stateZip);
        return parts.length > 0 ? parts.join(", ") : null;
      };
      const displayAddress = isCommercial
        ? fmtAddr(j.property_address, j.property_city, j.property_state, j.property_zip)
        : fmtAddr(j.address, j.city, j.state, j.zip);
      const jobTotal = j.billed_amount ? parseFloat(j.billed_amount) : (j.base_fee ? parseFloat(j.base_fee) : 0);
      // [pay-matrix 2026-04-29] Per-tech commission. The 4-cell matrix
      // (residential|commercial × commission|hourly) on each user row
      // means every tech can be paid differently on the same job. The
      // calc routes on the JOB's commercial flag, then picks the
      // tech's corresponding type + rate.
      //
      //   commission rate is fraction (0.00–1.00) → pay = revenue_share × rate
      //   hourly     rate is dollars/hour         → pay = est_hours_per_tech × rate
      //
      // Revenue share for commission: jobTotal ÷ numTechs. Each tech's
      // share of the job's billable revenue, then their personal % of
      // their share. So a 40%-rate tech and a 30%-rate tech on a
      // 2-tech $320 job earn $64 and $48 respectively (each gets
      // their_pct × $160), not the 35% pool split.
      const allowedHours = j.allowed_hours ? parseFloat(j.allowed_hours) : 0;
      const estHoursSource = allowedHours > 0
        ? allowedHours
        : (j.estimated_hours ? parseFloat(j.estimated_hours) : 0);
      const numTechs = jobTechs.length || 1;
      const estHoursPerTech = numTechs > 0 ? Math.round((estHoursSource / numTechs) * 10) / 10 : estHoursSource;
      const revenueSharePerTech = numTechs > 0 ? jobTotal / numTechs : jobTotal;

      // [tiered-residential] For commission-type techs on deep_clean /
      // move_in / move_out jobs, the company tier rate (32%) wins over
      // the per-tech matrix value. Standard residential keeps the matrix
      // rate (so per-tech overrides like senior 40% still apply).
      // Commercial routing is unchanged.
      const tierResPct = resolveResidentialPayPct(j.service_type as any, resRates);
      const tierApplies = !isCommercialPay && tierResPct !== resRates.res_tech_pay_pct;
      // [tc-pay-sync 2026-07-01] When the office has touched this job (real
      // punches or a per-tech pay-type override), its dollars come from the
      // shared engine above so the card matches the time clock / payroll to the
      // penny. We still surface pay_type/pay_rate for the "Fee Split 32%" /
      // "Hourly $20/hr" sub-label — resolved from the per-job override, then the
      // job default (commercial → hourly $/hr; residential → the scope %).
      const useEngine = engineJobIds.has(j.id);
      const technicians = jobTechs.map(t => {
        const matrixPayType = isCommercialPay ? t.commercial_pay_type : t.residential_pay_type;
        const matrixRate = isCommercialPay ? t.commercial_pay_rate : t.residential_pay_rate;
        const matrixPayRate = (tierApplies && matrixPayType === "commission") ? tierResPct : matrixRate;
        const matrixCalc = matrixPayType === "hourly"
          ? Math.round(estHoursPerTech * matrixPayRate * 100) / 100
          : Math.round(revenueSharePerTech * matrixPayRate * 100) / 100;

        // Effective per-tech pay type/rate for the label + calc source.
        let payType: "commission" | "hourly" = matrixPayType;
        let payRate = matrixPayRate;
        let calcPay = matrixCalc;
        if (useEngine) {
          // Engine dollars (actual, honors overrides + clocked hours).
          calcPay = Math.round((enginePayByKey.get(`${j.id}:${t.user_id}`) ?? 0) * 100) / 100;
          const ov = t.pay_type;   // per-job override, or null → job default
          if (ov === "fee_split") {
            payType = "commission";
            payRate = t.commission_pct != null ? parseFloat(t.commission_pct) : tierResPct;
          } else if (ov === "hourly" || ov === "allowed_hours") {
            payType = "hourly";
            payRate = t.hourly_rate != null ? parseFloat(t.hourly_rate)
              : (isCommercialPay ? commercialHourlyRate : matrixPayRate);
          } else {
            // No explicit override — the job default the engine applied.
            payType = isCommercialPay ? "hourly" : "commission";
            payRate = isCommercialPay ? commercialHourlyRate : tierResPct;
          }
        }
        return {
          user_id: t.user_id,
          name: t.name,
          is_primary: t.is_primary,
          est_hours: estHoursPerTech,
          calc_pay: calcPay,
          final_pay: t.final_pay != null ? t.final_pay : (t.pay_override != null ? t.pay_override : calcPay),
          pay_override: t.pay_override,
          // Surface the cell that drove this tech's calc so the JobPanel can
          // render "Hourly $20/hr × 6h" vs "Commission 35% of $160 share"
          // without re-deriving.
          pay_type: payType,
          pay_rate: payRate,
        };
      });
      // Backwards-compat: company_res_pct / commercial_hourly_rate /
      // commission_basis are kept for surfaces that still consume
      // them. They reflect the FIRST tech on the job (primary) so the
      // legacy single-tech display remains correct in single-tech
      // jobs. Multi-tech surfaces should read job.technicians[].pay_*
      // instead.
      const primaryTech = jobTechs[0];
      const legacyBasis = primaryTech
        ? (isCommercialPay
            ? (primaryTech.commercial_pay_type === "hourly" ? "commercial_hourly" : "commercial_commission")
            : (primaryTech.residential_pay_type === "commission" ? "residential_pool" : "residential_hourly"))
        : (isCommercialPay ? "commercial_hourly" : "residential_pool");
      // calcPerTech for legacy callers — sum of per-tech calcs
      // averaged. Modern callers should sum technicians[].calc_pay.
      const calcPerTech = technicians.length
        ? Math.round((technicians.reduce((s, t) => s + t.calc_pay, 0) / technicians.length) * 100) / 100
        : 0;

      // [scheduling-engine 2026-04-29] Display name composition.
      // Commercial clients with a company_name render as
      // "Company Name - Contact First Last". Falls back to the
      // existing client_name (account_name for jobs with account_id,
      // else first+last) so behavior is unchanged when company_name
      // is null. The chip + JobPanel + hover popover all read this
      // single field — no per-surface composition needed.
      const company = (j as any).client_company_name ?? null;
      const isCommercialClient = (j as any).client_type === "commercial";
      const contactFirst = (j as any).client_first_name ?? "";
      const contactLast = (j as any).client_last_name ?? "";
      const contactName = `${contactFirst} ${contactLast}`.trim();
      const display_name = isCommercialClient && company && company.trim()
        ? (contactName ? `${company} - ${contactName}` : company)
        : (j.client_name as string);

      return {
        id: j.id,
        client_id: j.client_id,
        client_name: j.client_name,
        // Composed for chip rendering — preserves the legacy
        // client_name for any caller still doing per-surface
        // composition (none in-tree, but external integrations).
        display_name,
        client_company_name: company,
        client_phone: j.client_phone ?? null,
        client_zip: j.client_zip ?? null,
        client_notes: j.client_notes ?? null,
        client_payment_method: j.client_payment_method ?? null,
        client_type: (j as any).client_type ?? null,
        address: displayAddress,
        // [distance-order 2026-06-12] Job coords for the Add tech distance sort.
        job_lat: (j as any).job_lat != null ? Number((j as any).job_lat) : null,
        job_lng: (j as any).job_lng != null ? Number((j as any).job_lng) : null,
        // [inline-edit] Raw fields for the address editor's mode detection.
        job_address_street: (j as any).job_address_street ?? null,
        job_address_city:   (j as any).job_address_city ?? null,
        job_address_state:  (j as any).job_address_state ?? null,
        job_address_zip:    (j as any).job_address_zip ?? null,
        client_address: (j as any).client_address ?? null,
        client_city:    (j as any).client_city ?? null,
        client_state:   (j as any).client_state ?? null,
        client_address_zip: (j as any).client_address_zip ?? null,
        assigned_user_id: j.assigned_user_id,
        // [job-panel 2026-06-10] Surface the primary tech's display name on
        // every dispatch job so the JobPanel's InlineTechEdit dropdown
        // renders the real name immediately, without a second roundtrip to
        // /api/users/techs-with-status. Without this the dropdown raced the
        // techs-list fetch and fell back to the "Technician #<id>"
        // placeholder Maribel saw in the 06-10 screenshot.
        assigned_user_name: j.assigned_user_id != null
          ? (userNameById.get(j.assigned_user_id) || null)
          : null,
        service_type: j.service_type,
        status: j.status,
        job_kind: (j as any).job_kind ?? "cleaning",
        scheduled_date: j.scheduled_date,
        scheduled_time: j.scheduled_time,
        time_change_pending: (j as any).time_change_pending ?? false,
        time_change_from: (j as any).time_change_from ?? null,
        frequency: j.frequency,
        // [BUG-6 follow-up / 2026-06-02] Compute amount LIVE from the three
        // sources of truth: base_fee + SUM(rate_mods) + SUM(add_on subtotals).
        // Previously we COALESCE'd to billed_amount, but that column is a
        // cache that PATCH /api/jobs/:id doesn't refresh on base_fee/hourly_rate
        // edits — Jaira's 4322 showed 340 ($320 stale + $20 parking) after
        // base_fee 320→400, instead of the correct 420. The recompute path
        // exists (`recomputeJobBilledAmount`) but only fires from the
        // rate-mods routes. Reading live avoids the cache-invalidation
        // class of bug entirely. Trade-off: one extra aggregated SUM query
        // per dispatch render (loaded above as rateModSumByJob), and we
        // give up the chance to display a "preview" billed_amount that
        // dispatch had explicitly persisted — but dispatch is a
        // read-only view, so persisted preview was never the intent.
        amount: (() => {
          // [discount-net 2026-07-02] Compute the GROSS total (unchanged logic
          // below), then subtract job_discounts so the displayed total mirrors
          // the invoice. Commission is computed separately off gross
          // billed_amount, so the office still absorbs the discount by default —
          // only this customer-facing number nets it.
          const discount = discountSumByJob.get(j.id) ?? 0;
          const gross = (() => {
          const mods = rateModSumByJob.get(j.id) ?? 0;
          const addOns = (addOnsByJob.get(j.id) ?? []).reduce((s, a) => s + (a.subtotal ?? 0), 0);
          const override = (j as any).manual_rate_override === true;
          // [commercial-revenue 2026-06-04] Commercial revenue = the SERVICE
          // amount + add-ons + rate-mods, computed LIVE so the hourly rate the
          // office sees always reconciles with the billed total (the
          // "$50/hr × 8h but billed $320" confusion). The service amount is:
          //   • hourly_rate × allowed_hours  — the normal MC model, when the
          //     office hasn't pinned a flat price. This is authoritative even
          //     if a stale billed_amount cache disagrees (Jaira: $50×8 + $20
          //     parking = $420, not the cached $320).
          //   • base_fee                     — when the office EXPLICITLY set a
          //     flat price via "Override rate" / "Change price"
          //     (manual_rate_override=true), e.g. a flat-contract commercial
          //     account billed $578.40 regardless of hours.
          // We compute live rather than trust billed_amount because that cache
          // isn't refreshed on a rate/hours edit and silently throws revenue
          // off. The recompute helper keeps billed_amount fresh for payroll,
          // but dispatch never depends on it being fresh.
          if (isCommercialPay) {
            const rate = j.hourly_rate ? parseFloat(j.hourly_rate) : 0;
            const hrs = j.allowed_hours ? parseFloat(j.allowed_hours) : 0;
            if (!override && rate > 0 && hrs > 0) {
              // Auto MC model: hourly service + add-ons + FLAT rate-mods only
              // ('time' mods already live in allowed_hours → rate × hrs).
              const flatMods = flatModSumByJob.get(j.id) ?? 0;
              return rate * hrs + flatMods + addOns;
            }
            // Pinned flat price ("Change price"/"Override rate") or no hourly
            // inputs: base_fee carries the all-in amount the office set, so
            // add-ons are considered included — don't double-add them. Mirrors
            // recomputeJobBilledAmount's else branch exactly.
            const base = j.base_fee ? parseFloat(j.base_fee) : 0;
            return base + mods;
          }
          // Residential: unchanged. An explicit billed price (e.g. manual
          // "Change price") wins; otherwise base_fee + rate-mods.
          // [addon-doublecount-fix 2026-06-16] (#2/#14) base_fee is the all-in
          // residential total — it ALREADY includes the add-on subtotals (the
          // wizard/quote/edit-modal convention; jobs.ts:388, and
          // recomputeJobBilledAmount residential = base + mods, no add-ons).
          // job_add_ons rows are the itemized breakdown of money already inside
          // base_fee, so re-adding `addOns` here double-counted every
          // residential add-on job (e.g. converted job 6805: 744.80 base + 248.80
          // add-ons shown as 993.60). Do NOT re-add add-ons; match the stored
          // base_fee convention and the recompute helper.
          const billed = (j as any).billed_amount != null ? parseFloat(String((j as any).billed_amount)) : null;
          if (billed != null && billed > 0) return billed;
          const base = j.base_fee ? parseFloat(j.base_fee) : 0;
          return base + mods;
          })();
          const net = Math.round((gross - discount) * 100) / 100;
          return net > 0 ? net : 0;
        })(),
        duration_minutes: durationMinutes,
        notes: j.notes,
        before_photo_count: photos.before,
        after_photo_count: photos.after,
        zone_id: j.zone_id,
        zone_color: j.zone_color ?? null,
        zone_name: j.zone_name ?? null,
        branch_id: j.branch_id ?? null,
        branch_name: j.branch_name ?? null,
        last_service_date: j.last_service_date ?? null,
        account_id: j.account_id ?? null,
        account_name: j.account_name ?? null,
        // [BUG-1 / 2026-06-01] Needed by the slotKey dedupe below to
        // distinguish two commercial jobs at the same (account, date, time)
        // serving different properties. Without it the second one collapsed.
        account_property_id: (j as any).account_property_id ?? null,
        // [AI.6.2] Surface schedule linkage so the edit modal's cascade
        // prompt fires for recurring jobs.
        recurring_schedule_id: (j as any).recurring_schedule_id ?? null,
        // [PR #27] Drives the parking-fee day picker render gate in
        // edit-job-modal.tsx — the picker shows when the attached
        // schedule is multi-day, regardless of the modal's local
        // form-level frequency state. Null when no schedule attached.
        recurring_schedule_days_of_week: (j as any).recurring_schedule_days_of_week ?? null,
        billing_method: j.billing_method ?? null,
        hourly_rate: j.hourly_rate ? parseFloat(j.hourly_rate) : null,
        // [commercial-revenue 2026-06-04] Lets the FE show "$50/hr × 8h" on
        // commercial jobs whose revenue is rate-driven, and suppress the
        // rate label when the office pinned a flat price.
        manual_rate_override: (j as any).manual_rate_override === true,
        estimated_hours: j.estimated_hours ? parseFloat(j.estimated_hours) : null,
        actual_hours: j.actual_hours ? parseFloat(j.actual_hours) : null,
        billed_hours: j.billed_hours ? parseFloat(j.billed_hours) : null,
        // [2026-06-02] Surface allowed_hours so the FE can sum the day's
        // total hours and the drag-and-drop slot resolver can read the
        // original allowed budget. MC's Schedule view shows 57.3h for
        // 06-01; without this Qleno couldn't compute the matching total.
        allowed_hours: j.allowed_hours ? parseFloat(j.allowed_hours) : null,
        billed_amount: j.billed_amount ? parseFloat(j.billed_amount) : null,
        charge_failed_at: j.charge_failed_at ?? null,
        charge_succeeded_at: j.charge_succeeded_at ?? null,
        property_address: displayAddress,
        property_access_notes: j.property_access_notes ?? null,
        property_notes: (j as any).property_notes ?? null,
        office_notes: j.office_notes ?? null,
        office_notes_updated_at: (j as any).office_notes_updated_at ?? null,
        office_notes_updated_by_name: (j as any).office_notes_updated_by != null ? (userNameById.get((j as any).office_notes_updated_by) || null) : null,
        // [AF] Completion / lock state — drawer renders read-only UI when
        // locked_at is set.
        locked_at: j.locked_at ?? null,
        // 'cancel' | 'lockout' when this completed job is actually a charged
        // cancellation/lockout (fee billed, not a service visit); else null.
        cancel_action: cancelActionByJob.get(Number(j.id)) ?? null,
        actual_end_time: j.actual_end_time ?? null,
        completed_by_user_id: j.completed_by_user_id ?? null,
        no_show_marked_by_tech: (j as any).no_show_marked_by_tech ?? null,
        no_show_marked_by_user_id: (j as any).no_show_marked_by_user_id ?? null,
        clock_entry: clock ? {
          id: clock.id,
          clock_in_at: clock.clock_in_at,
          clock_out_at: clock.clock_out_at,
          distance_from_job_ft: clock.distance_from_job_ft ? parseFloat(clock.distance_from_job_ft) : null,
          is_flagged: clock.flagged,
          clock_in_distance_ft: clock.clock_in_distance_ft != null ? parseFloat(clock.clock_in_distance_ft) : null,
          clock_out_distance_ft: clock.clock_out_distance_ft != null ? parseFloat(clock.clock_out_distance_ft) : null,
          clock_in_outside_geofence: clock.clock_in_outside_geofence ?? false,
          clock_out_outside_geofence: clock.clock_out_outside_geofence ?? false,
          // GPS unavailable = no coordinates captured at clock-in. Suppressed
          // for synthetic 'estimated' completion stamps (legitimately no GPS).
          gps_missing: flagMissingGps && clock.source !== "estimated" && (clock.clock_in_lat == null || clock.clock_in_lng == null),
        } : null,
        technicians,
        est_hours_per_tech: estHoursPerTech,
        est_pay_per_tech: calcPerTech,
        // [tiered-residential] Returns the rate that applies to THIS job
        // (32% for deep clean / move in-out, else 35%). Frontend renders
        // "Pool rate: X% of job total" — was always 35% before tiering.
        company_res_pct: (j as any).commission_override_pct != null
          ? parseFloat(String((j as any).commission_override_pct))
          : tierResPct,
        commission_override_pct: (j as any).commission_override_pct != null
          ? parseFloat(String((j as any).commission_override_pct))
          : null,
        // [pay-matrix 2026-04-29] commission_basis now reflects the
        // primary tech's matrix cell, not a hardcoded company-wide
        // value. Surfaces that need richer per-tech data should read
        // technicians[].pay_type / pay_rate.
        commission_basis: legacyBasis,
        commercial_hourly_rate: isCommercialPay ? commercialHourlyRate : null,
        // [job-card-redesign] Add-ons drive the "+N" chip pill and the
        // hover popover's full add-on list. Empty array (not null) when
        // a job has none, so the frontend can `.length` directly.
        add_ons: addOnsByJob.get(j.id) ?? [],
        // [job-card-redesign] is_new_client — first-ever job for this
        // residential client (no prior completed). Commercial jobs read
        // false; clients with no client_id (rare/legacy) also read false.
        is_new_client: !isCommercialPay && j.client_id != null
          ? !clientsWithPriorComplete.has(j.client_id)
          : false,
        // [job-card-invoice-link 2026-07-07] The SELECT has computed these
        // since 2026-06-27, but this shaper never carried them through — so
        // job.invoice_id was ALWAYS undefined on the board and every
        // completed job showed "No invoice yet" regardless of reality
        // (Maribel: "jobs with invoices still say 'no invoice yet'").
        invoice_id: (j as any).invoice_id != null ? Number((j as any).invoice_id) : null,
        invoice_status: (j as any).invoice_status ?? null,
        invoice_total: (j as any).invoice_total != null ? parseFloat(String((j as any).invoice_total)) : null,
      };
    });

    const jobsByEmployee = new Map<number, typeof mappedJobs>();
    const unassigned: typeof mappedJobs = [];
    // [inactive-tech-unassigned 2026-06-04] A job assigned to a tech who is no
    // longer active (deactivated/removed) must fall into Unassigned, not vanish.
    // `employees` is already filtered to active techs, so any assigned user_id
    // not in this set is treated as unassigned below.
    const activeEmployeeIds = new Set(employees.map(e => e.id));

    // [hotfix iter 2] Two-level dedupe. The first level (seenIds) catches
    // the case where the same job.id appears twice via a JOIN fan-out.
    // The second level (seenSlots) catches the actual data corruption
    // case Sal saw on Monday April 27: two distinct job.ids occupying
    // the same (client_id, date, time) slot. The DB-side migration +
    // partial unique index closes this going forward, but a stale row
    // already in the table still renders twice without this fallback.
    // Tiebreak when slot collides: prefer the row whose tech assignment
    // matches a known employee (already grouped) and is most recently
    // updated — but absent that, latest mappedJobs wins via insertion
    // order (Map preserves order; we just keep the first one in).
    const seenIds = new Set<number>();
    // [BUG-1 follow-up / 2026-06-02] The first BUG-1 patch added an identity
    // discriminator to slotKey (c<client> vs a<acct>p<prop>) but two
    // commercial jobs at the same (date, time) still collapsed live in
    // prod — the surviving symptom was 5654 (acct=4/prop=28 @14:00) and
    // 5660 (acct=3/prop=29 @13:00) silently dropped while 5663/5661
    // survived. The fix below appends job.id as the ultimate tiebreaker
    // so two distinct DB rows can NEVER deduplicate, regardless of
    // whether (account_id, account_property_id) is populated correctly
    // on the mappedJobs output. The dedupe still catches the original
    // failure mode (JOIN fan-out emitting the same job.id twice) via
    // seenIds — that's the only true duplicate the dispatch query can
    // produce now that the partial unique index on jobs prevents the
    // historical April 27 data-corruption case Sal described. Persisted
    // jobs are the source of truth; if two rows exist, two cards render.
    const seenSlots = new Set<string>();
    const slotKey = (j: typeof mappedJobs[number]) => {
      const identity = j.client_id != null
        ? `c${j.client_id}`
        : `a${j.account_id ?? "n"}p${j.account_property_id ?? "n"}`;
      // job.id at the end makes the key uniquely identify the row.
      return `${identity}|${j.scheduled_date ?? ""}|${j.scheduled_time ?? "00:00:00"}|${j.id}`;
    };
    for (const job of mappedJobs) {
      if (seenIds.has(job.id)) continue;
      const slot = slotKey(job);
      if (seenSlots.has(slot)) {
        // Same job.id surfaced twice via JOIN fan-out — seenIds above
        // catches this first, this is the belt-and-suspenders branch.
        continue;
      }
      seenIds.add(job.id);
      seenSlots.add(slot);

      // [BUG-3F2 / 2026-06-02] Multi-tech fan-out. Previously the board
      // only rendered a job under jobs.assigned_user_id (the primary), so
      // team members on shared jobs — 5657 Joe Cusimano (Jose primary +
      // Norma team) and 5656 Nitzsche (Alejandra primary + Juliana team)
      // — were missing from their rows; their utilization tile read
      // 0 jobs / 0 hours / $0. Now we fan the job onto every tech in
      // technicians[] (the same array the payroll engine + JobPanel
      // read). Each rendered copy carries team_role ('primary' | 'team')
      // so the FE can style; revenue_share weights the badge $ tile by
      // each tech's calc_pay share so per-row totals sum back to the
      // company-wide revenue (no double counting). amount stays as
      // the full job value on the chip — that's what the operator wants
      // to see. assigned_user_id stays — still drives drag-and-drop and
      // the chip's tech name badge for the primary.
      const rawTechs: Array<{ user_id: number; is_primary?: boolean; calc_pay?: number }> =
        (Array.isArray((job as any).technicians) && (job as any).technicians.length > 0)
          ? (job as any).technicians
          : (job.assigned_user_id != null
              ? [{ user_id: Number(job.assigned_user_id), is_primary: true, calc_pay: Number((job as any).est_pay_per_tech) || 0 }]
              : []);
      // Drop assignees who are no longer active techs (removed/deactivated) so
      // their jobs surface under Unassigned instead of disappearing.
      const techsArr = rawTechs.filter(t => activeEmployeeIds.has(Number(t.user_id)));

      if (techsArr.length === 0) {
        unassigned.push(job);
        continue;
      }

      const totalCalcPay = techsArr.reduce((s, t) => s + (Number(t.calc_pay) || 0), 0);
      const jobAmount = Number(job.amount) || 0;

      for (const t of techsArr) {
        const techId = Number(t.user_id);
        if (!jobsByEmployee.has(techId)) jobsByEmployee.set(techId, []);
        // Per-tech weighting: proportional to calc_pay when available,
        // equal split otherwise. Matches the payroll engine's view of
        // "who earned what slice of this job."
        const share = totalCalcPay > 0
          ? (Number(t.calc_pay) || 0) / totalCalcPay
          : 1 / techsArr.length;
        const perRender = {
          ...job,
          team_role: t.is_primary ? "primary" : "team",
          revenue_share: Math.round(jobAmount * share * 100) / 100,
        };
        jobsByEmployee.get(techId)!.push(perRender);
      }
    }

    return {
      employees: employees.map(e => ({
        id: e.id,
        name: `${e.first_name} ${e.last_name}`,
        role: e.role,
        is_trainee: isTraineeFromHire(e.hire_date),
        jobs: jobsByEmployee.get(e.id) || [],
        zone: empZoneMap[e.id] ?? null,
        time_off: getTimeOff(e.id),
        time_off_unit: getTimeOffUnit(e.id),
        time_off_color: getTimeOffColor(e.id),
        time_off_label: getTimeOffLabel(e.id),
        time_off_start: getTimeOffBlock(e.id).start,
        time_off_end: getTimeOffBlock(e.id).end,
        commission_rate: e.commission_rate ? parseFloat(e.commission_rate) : null,
        avatar_url: e.avatar_url ?? null,
      })),
      unassigned_jobs: unassigned,
    };
}

router.get("/", requireAuth, dispatchOfficeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const date = (req.query.date as string) || new Date().toISOString().split("T")[0];
    const branch_id = req.query.branch_id as string | undefined;
    return res.json(await buildDispatchPayload(companyId, date, branch_id));
  } catch (err) {
    console.error("Dispatch error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to load dispatch" });
  }
});

// [job-card-redesign 2026-06-25] GET /api/dispatch/jobs/:id — one job in the
// FULL dispatch shape (technicians, commission_basis, zone_color, allowed_hours,
// add-ons, …) so the same editable JobPanel the dispatch board uses can be
// rendered from the customer profile. Reuses buildDispatchPayload for the job's
// own date and plucks the job out — no query duplication, identical shape.
router.get("/jobs/:id", requireAuth, dispatchOfficeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: "Invalid job id" });
    const row = (await db.execute(sql`
      SELECT to_char(scheduled_date, 'YYYY-MM-DD') AS d
      FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `)).rows[0] as { d: string } | undefined;
    if (!row?.d) return res.status(404).json({ error: "Job not found" });
    const payload = await buildDispatchPayload(companyId, row.d, undefined);
    let job: any = (payload.unassigned_jobs || []).find((j: any) => j.id === jobId);
    if (!job) {
      for (const e of (payload.employees || [])) {
        const f = (e.jobs || []).find((j: any) => j.id === jobId);
        if (f) { job = f; break; }
      }
    }
    if (!job) return res.status(404).json({ error: "Job not visible on the dispatch board (e.g. a charged cancellation)" });
    return res.json({ data: job });
  } catch (err) {
    console.error("Dispatch single-job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to load job" });
  }
});

// [combined-board 2026-06-17] Cross-company combined dispatch. Resolves the
// companies this user OWNS (same gate as /api/rollup) and merges each one's
// dispatch payload, tagging every employee + unassigned job with its company
// so the board can group by location. No branch filter — combined shows all.
router.get("/all-locations", requireAuth, dispatchOfficeGate, async (req, res) => {
  try {
    const userId = req.auth!.userId!;
    const homeCompanyId = req.auth!.companyId!;
    const date = (req.query.date as string) || new Date().toISOString().split("T")[0];
    const ownedRows = (await db.execute(sql`
      SELECT uc.company_id AS company_id, c.name AS name
      FROM user_companies uc JOIN companies c ON c.id = uc.company_id
      WHERE uc.user_id = ${userId} AND uc.role = 'owner'
      ORDER BY c.name
    `)).rows as { company_id: number; name: string }[];
    let companies = ownedRows.map(r => ({ id: Number(r.company_id), name: r.name }));
    if (companies.length === 0) {
      const homeRow = (await db.execute(sql`SELECT name FROM companies WHERE id = ${homeCompanyId} LIMIT 1`)).rows[0] as any;
      companies = [{ id: homeCompanyId, name: homeRow?.name ?? "Company" }];
    }
    const employees: any[] = [];
    const unassigned_jobs: any[] = [];
    for (const co of companies) {
      const payload = await buildDispatchPayload(co.id, date, undefined);
      for (const e of payload.employees) employees.push({ ...e, company_id: co.id, company_name: co.name });
      for (const j of payload.unassigned_jobs) unassigned_jobs.push({ ...j, company_id: co.id, company_name: co.name });
    }
    return res.json({ employees, unassigned_jobs, companies });
  } catch (err) {
    console.error("Dispatch all-locations error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to load combined dispatch" });
  }
});

// [AI.7] GET /api/dispatch/week-summary
//
// Lightweight per-day aggregates for the mobile week view's risk-first
// dashboard. Returns one row per date in the [from..to] window with job
// count, revenue, and unassigned count. Used to render the 7-bar weekly
// chart and the collapsed-day headers without fetching every job in the
// week up-front. Today's full job data still flows through the existing
// /api/dispatch?date=... endpoint; expanding any other day fetches that
// day's full data on demand.
//
// Window defaults to current Sunday–Saturday when from/to omitted.
router.get("/week-summary", requireAuth, dispatchOfficeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const branch_id = req.query.branch_id as string | undefined;

    // Resolve window. Default = current week Sun..Sat.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = today.getDay(); // 0=Sun..6=Sat
    const defaultFrom = new Date(today);
    defaultFrom.setDate(today.getDate() - dow);
    const defaultTo = new Date(defaultFrom);
    defaultTo.setDate(defaultFrom.getDate() + 6);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const fromStr = (req.query.from as string) || fmt(defaultFrom);
    const toStr = (req.query.to as string) || fmt(defaultTo);

    const branchCond = branch_id && branch_id !== "all"
      ? sql`AND (j.branch_id = ${parseInt(branch_id)} OR j.branch_id IS NULL)`
      : sql``;

    // Per-day aggregate. Excludes cancelled. Unassigned = no assigned_user_id
    // and no row in job_technicians.
    const result = await db.execute(sql`
      SELECT
        j.scheduled_date::text AS date,
        COUNT(*)::int AS job_count,
        COALESCE(SUM(${jobRevenueExpr(sql`CAST(j.base_fee AS NUMERIC)`)}), 0)::numeric AS revenue,
        SUM(
          CASE
            WHEN j.assigned_user_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id)
            THEN 1 ELSE 0
          END
        )::int AS unassigned_count
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.company_id = ${companyId}
        AND j.scheduled_date >= ${fromStr}
        AND j.scheduled_date <= ${toStr}
        AND j.status != 'cancelled'
        ${branchCond}
      GROUP BY j.scheduled_date
      ORDER BY j.scheduled_date ASC
    `);

    type Row = { date: string; job_count: number; revenue: string; unassigned_count: number };
    const rows = (result.rows as unknown as Row[]).map(r => ({
      date: String(r.date),
      job_count: Number(r.job_count),
      revenue: parseFloat(String(r.revenue)),
      unassigned_count: Number(r.unassigned_count),
    }));

    // Pad to all 7 days even when no jobs (so the chart renders bars for
    // empty days as zero-height with day labels).
    const byDate = new Map(rows.map(r => [r.date, r]));
    const days: Array<{ date: string; job_count: number; revenue: number; unassigned_count: number }> = [];
    const cursor = new Date(fromStr + "T00:00:00");
    const end = new Date(toStr + "T00:00:00");
    while (cursor <= end) {
      const k = fmt(cursor);
      days.push(byDate.get(k) ?? { date: k, job_count: 0, revenue: 0, unassigned_count: 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    const total_jobs = days.reduce((s, d) => s + d.job_count, 0);
    const total_revenue = days.reduce((s, d) => s + d.revenue, 0);
    const total_unassigned = days.reduce((s, d) => s + d.unassigned_count, 0);

    return res.json({
      from: fromStr,
      to: toStr,
      days,
      total_jobs,
      total_revenue,
      total_unassigned,
    });
  } catch (err) {
    console.error("Week summary error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to load week summary" });
  }
});

// [AI.7.6] Zone coverage audit — segments today's jobs by why zone
// resolution failed, so the operator sees the gap (no_zip / zip
// outside zones / other) and can fix the underlying data instead of
// papering over with a default zone. Per Sal's standing rule, every
// job must surface its zone color; failures are data errors.
//
// GET /api/dispatch/zone-coverage-audit?from=YYYY-MM-DD&to=YYYY-MM-DD
//   defaults to today.
//
// Response shape:
//   {
//     window: { from, to },
//     total: number,
//     resolved: number,
//     unresolved: {
//       a_no_zip:           { count, samples: [{ id, client_name, scheduled_date }] },
//       b_zip_outside_zones:{ count, samples: [...], unmatched_zips: string[] },
//       c_other:            { count, samples: [...] },
//     },
//   }
router.get("/zone-coverage-audit", requireAuth, dispatchOfficeGate, async (req, res) => {
  try {
    const companyId = (req as any).auth!.companyId;
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    const from = (req.query.from as string) || todayStr;
    const to = (req.query.to as string) || todayStr;

    // Pull jobs in window with all candidate zip / address sources so we
    // can segment failures by root cause without re-running the resolver
    // SQL multiple times.
    const rows = await db.execute(sql`
      SELECT
        j.id,
        j.scheduled_date::text AS scheduled_date,
        CASE WHEN j.account_id IS NOT NULL
             THEN a.account_name
             ELSE concat(c.first_name, ' ', c.last_name) END AS client_name,
        NULLIF(j.address_zip, '')                              AS job_zip,
        NULLIF(c.zip, '')                                      AS client_zip,
        NULLIF(ap.zip, '')                                     AS property_zip,
        SUBSTRING(NULLIF(j.address_street, '') FROM '\\y(\\d{5})\\y') AS job_addr_zip_extracted,
        SUBSTRING(NULLIF(c.address, '')      FROM '\\y(\\d{5})\\y') AS client_addr_zip_extracted,
        SUBSTRING(NULLIF(ap.address, '')     FROM '\\y(\\d{5})\\y') AS property_addr_zip_extracted,
        j.zone_id,
        (SELECT z.id FROM service_zones z
           WHERE z.company_id = ${companyId}
             AND z.is_active = true
             AND (
               NULLIF(j.address_zip, '') = ANY(z.zip_codes)
               OR NULLIF(c.zip, '') = ANY(z.zip_codes)
               OR NULLIF(ap.zip, '') = ANY(z.zip_codes)
               OR SUBSTRING(NULLIF(j.address_street, '') FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
               OR SUBSTRING(NULLIF(c.address, '')      FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
               OR SUBSTRING(NULLIF(ap.address, '')     FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
             )
           LIMIT 1) AS resolved_zone_id
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
      LEFT JOIN account_properties ap ON ap.id = j.account_property_id
      WHERE j.company_id = ${companyId}
        AND j.scheduled_date >= ${from}
        AND j.scheduled_date <= ${to}
    `);

    type Bucket = { count: number; samples: Array<{ id: number; client_name: string; scheduled_date: string }> };
    const noZip: Bucket = { count: 0, samples: [] };
    const outsideZones: Bucket & { unmatched_zips: Set<string> } = { count: 0, samples: [], unmatched_zips: new Set() };
    const other: Bucket = { count: 0, samples: [] };
    let resolved = 0;
    const total = rows.rows.length;

    for (const r of rows.rows as any[]) {
      const candidateZips = [
        r.job_zip, r.client_zip, r.property_zip,
        r.job_addr_zip_extracted, r.client_addr_zip_extracted, r.property_addr_zip_extracted,
      ].filter(Boolean) as string[];
      const hasResolution = r.zone_id != null || r.resolved_zone_id != null;
      const sample = { id: Number(r.id), client_name: String(r.client_name ?? ""), scheduled_date: String(r.scheduled_date ?? "") };

      if (hasResolution) {
        resolved++;
        continue;
      }
      if (candidateZips.length === 0) {
        noZip.count++;
        if (noZip.samples.length < 20) noZip.samples.push(sample);
      } else {
        // Has at least one zip but no zone matched → zip outside coverage.
        outsideZones.count++;
        if (outsideZones.samples.length < 20) outsideZones.samples.push(sample);
        for (const z of candidateZips) outsideZones.unmatched_zips.add(z);
      }
    }
    // c_other reserved for future cases (e.g. service_zones row exists
    // but is_active=false). Always returned for shape stability.
    void other;

    return res.json({
      window: { from, to },
      total,
      resolved,
      unresolved: {
        a_no_zip: noZip,
        b_zip_outside_zones: { ...outsideZones, unmatched_zips: Array.from(outsideZones.unmatched_zips).sort() },
        c_other: other,
      },
    });
  } catch (err) {
    console.error("Zone coverage audit error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err instanceof Error ? err.message : "Failed to run audit" });
  }
});

// ─── Far-future recurring-job cleanup (storage reclamation) ──────────────────
// [recurring-horizon-trim 2026-06-19] Companion to the 365→90 horizon cut in
// recurring-jobs.ts. Trimming the horizon stops NEW far-future rows from being
// generated, but the ~260-day backlog already materialized under the old 365
// horizon stays on disk (it filled the Postgres volume to 98% in production).
// These two endpoints let the owner reclaim that space safely:
//   GET  /api/dispatch/storage-audit   — read-only; reports how many
//        far-future recurring occurrences are prunable and which schedules
//        they belong to. Safe to run anytime.
//   POST /api/dispatch/prune-far-future — DRY-RUN by default; only deletes
//        when the body carries { confirm: true }. Owner-only.
//
// Prunable = an UNTOUCHED, never-started future occurrence the nightly cron
// will regenerate on its own once the rolling window reaches it again. The
// predicate is deliberately conservative so a manually-edited or in-flight
// visit is never removed:
//   - status = 'scheduled' (never started / completed / cancelled)
//   - recurring_schedule_id IS NOT NULL (engine-generated → self-heals)
//   - scheduled_date beyond the live DAYS_AHEAD window
//   - manual_rate_override = false (office never re-priced it)
//   - no charge attempted/succeeded, no actual_hours, not locked, not
//     completed, not flagged no-show
//   - no clock punches (timeclock / job_clock_events) and no invoice
// Because deletion runs in a transaction, any unexpected FK child rolls the
// whole thing back rather than leaving a half-deleted job.
const prunableFarFutureWhere = (companyId: number, cutoffDays: number) => sql`
  j.company_id = ${companyId}
  AND j.status = 'scheduled'
  AND j.recurring_schedule_id IS NOT NULL
  AND j.scheduled_date > (CURRENT_DATE + ${cutoffDays})
  AND j.manual_rate_override = false
  AND j.charge_succeeded_at IS NULL
  AND j.charge_attempted_at IS NULL
  AND j.actual_hours IS NULL
  AND j.locked_at IS NULL
  AND j.completed_by_user_id IS NULL
  AND j.no_show_marked_by_tech IS NULL
  AND NOT EXISTS (SELECT 1 FROM timeclock tc WHERE tc.job_id = j.id)
  AND NOT EXISTS (SELECT 1 FROM job_clock_events ce WHERE ce.job_id = j.id)
  AND NOT EXISTS (SELECT 1 FROM invoices iv WHERE iv.job_id = j.id)
`;

router.get("/storage-audit", requireAuth, dispatchOfficeGate, async (req, res) => {
  try {
    const companyId = (req as any).auth!.companyId;
    const cutoffDays = DAYS_AHEAD;

    // Total scheduled future rows vs. the prunable subset, plus a per-schedule
    // breakdown so the owner can see exactly what would go.
    const totals = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE j.status = 'scheduled'
            AND j.recurring_schedule_id IS NOT NULL
            AND j.scheduled_date > (CURRENT_DATE + ${cutoffDays})
        ) AS far_future_recurring_total,
        COUNT(*) FILTER (WHERE (${prunableFarFutureWhere(companyId, cutoffDays)})) AS prunable
      FROM jobs j
      WHERE j.company_id = ${companyId}
    `);

    const bySchedule = await db.execute(sql`
      SELECT
        j.recurring_schedule_id AS schedule_id,
        CASE WHEN j.account_id IS NOT NULL
             THEN a.account_name
             ELSE TRIM(concat(c.first_name, ' ', c.last_name)) END AS client_name,
        COUNT(*)                  AS prunable_count,
        MIN(j.scheduled_date)::text AS earliest,
        MAX(j.scheduled_date)::text AS latest
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
      WHERE ${prunableFarFutureWhere(companyId, cutoffDays)}
      GROUP BY j.recurring_schedule_id, client_name
      ORDER BY prunable_count DESC
      LIMIT 100
    `);

    const t = (totals.rows[0] || {}) as any;
    return res.json({
      cutoff_days: cutoffDays,
      far_future_recurring_total: Number(t.far_future_recurring_total ?? 0),
      prunable: Number(t.prunable ?? 0),
      by_schedule: (bySchedule.rows as any[]).map(r => ({
        schedule_id: Number(r.schedule_id),
        client_name: String(r.client_name ?? ""),
        prunable_count: Number(r.prunable_count ?? 0),
        earliest: String(r.earliest ?? ""),
        latest: String(r.latest ?? ""),
      })),
    });
  } catch (err) {
    console.error("Storage audit error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err instanceof Error ? err.message : "Failed to run audit" });
  }
});

router.post("/prune-far-future", requireAuth, requireRole("owner", "super_admin"), async (req, res) => {
  try {
    const companyId = (req as any).auth!.companyId;
    const cutoffDays = DAYS_AHEAD;
    const confirm = req.body?.confirm === true;

    // Resolve the target ids once so the dry-run preview and the actual delete
    // operate on the same set.
    const targets = await db.execute(sql`
      SELECT j.id FROM jobs j WHERE ${prunableFarFutureWhere(companyId, cutoffDays)}
    `);
    const ids = (targets.rows as any[]).map(r => Number(r.id));

    if (!confirm) {
      return res.json({ dry_run: true, would_delete: ids.length, cutoff_days: cutoffDays,
        note: "No rows deleted. Re-POST with { \"confirm\": true } to apply." });
    }
    if (ids.length === 0) {
      return res.json({ dry_run: false, deleted: 0, cutoff_days: cutoffDays });
    }

    // Delete non-cascading children first, then the jobs. job_technicians and
    // job_audit_log cascade on delete; the rest do not, so they go explicitly.
    // All in one transaction — an unexpected FK child rolls everything back.
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM job_add_ons     WHERE job_id = ANY(${ids})`);
      await tx.execute(sql`DELETE FROM job_discounts   WHERE job_id = ANY(${ids})`);
      await tx.execute(sql`DELETE FROM job_status_logs WHERE job_id = ANY(${ids})`);
      await tx.execute(sql`DELETE FROM jobs j WHERE j.id = ANY(${ids}) AND j.company_id = ${companyId}`);
    });

    return res.json({ dry_run: false, deleted: ids.length, cutoff_days: cutoffDays });
  } catch (err) {
    console.error("Prune far-future error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err instanceof Error ? err.message : "Failed to prune" });
  }
});

export default router;
