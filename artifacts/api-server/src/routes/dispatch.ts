import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, usersTable, clientsTable, timeclockTable, jobPhotosTable, serviceZonesTable, serviceZoneEmployeesTable, accountsTable, accountPropertiesTable, employeeAttendanceLogTable, employeeLeaveUsageTable, branchesTable } from "@workspace/db/schema";
import { eq, and, count, sql, inArray } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const date = (req.query.date as string) || new Date().toISOString().split("T")[0];
    const branch_id = req.query.branch_id as string | undefined;

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
        commission_rate: usersTable.commission_rate_override,
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
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        frequency: jobsTable.frequency,
        base_fee: jobsTable.base_fee,
        allowed_hours: jobsTable.allowed_hours,
        notes: jobsTable.notes,
        zone_id: jobsTable.zone_id,
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
        // [AI.6.2] Drives the cascade prompt in the edit modal. Without this
        // field surfaced, every recurring job's edit modal silently submits
        // as cascade_scope='this_job' — operators never see the
        // "this and all future" option.
        recurring_schedule_id: jobsTable.recurring_schedule_id,
        charge_failed_at: jobsTable.charge_failed_at,
        charge_succeeded_at: jobsTable.charge_succeeded_at,
        account_property_id: jobsTable.account_property_id,
        property_address: accountPropertiesTable.address,
        property_city: accountPropertiesTable.city,
        property_state: accountPropertiesTable.state,
        property_zip: accountPropertiesTable.zip,
        property_access_notes: accountPropertiesTable.access_notes,
        office_notes: jobsTable.office_notes,
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
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(accountPropertiesTable, eq(jobsTable.account_property_id, accountPropertiesTable.id))
      .leftJoin(serviceZonesTable, eq(jobsTable.zone_id, serviceZonesTable.id))
      .leftJoin(branchesTable, eq(jobsTable.branch_id, branchesTable.id))
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.scheduled_date, date),
        sql`${jobsTable.status} != 'cancelled'`,
        ...(branch_id && branch_id !== "all" ? [eq(jobsTable.branch_id, parseInt(branch_id))] : [])
      ))
      .orderBy(jobsTable.scheduled_time);

    // Employee zone assignments
    const empZones = await db
      .select({
        user_id: serviceZoneEmployeesTable.user_id,
        zone_id: serviceZoneEmployeesTable.zone_id,
        zone_color: serviceZonesTable.color,
        zone_name: serviceZonesTable.name,
      })
      .from(serviceZoneEmployeesTable)
      .innerJoin(serviceZonesTable, eq(serviceZonesTable.id, serviceZoneEmployeesTable.zone_id))
      .where(eq(serviceZoneEmployeesTable.company_id, companyId));

    const empZoneMap: Record<number, { zone_id: number; zone_color: string; zone_name: string }> = {};
    for (const r of empZones) {
      if (!empZoneMap[r.user_id]) {
        empZoneMap[r.user_id] = { zone_id: r.zone_id, zone_color: r.zone_color, zone_name: r.zone_name };
      }
    }

    // Time-off data for the board date
    // PTO = leave_usage record exists for this date
    const leaveUsage = await db
      .select({ employee_id: employeeLeaveUsageTable.employee_id })
      .from(employeeLeaveUsageTable)
      .where(and(
        eq(employeeLeaveUsageTable.company_id, companyId),
        eq(employeeLeaveUsageTable.date_used, date),
      ));

    // Sick / absent from attendance log for this date
    const attendanceLogs = await db
      .select({ employee_id: employeeAttendanceLogTable.employee_id, type: employeeAttendanceLogTable.type })
      .from(employeeAttendanceLogTable)
      .where(and(
        eq(employeeAttendanceLogTable.company_id, companyId),
        eq(employeeAttendanceLogTable.log_date, date),
        sql`${employeeAttendanceLogTable.type} IN ('plawa_leave','protected_leave','absent','ncns')`,
      ));

    const ptoSet = new Set(leaveUsage.map(r => r.employee_id));
    // sick = plawa_leave / protected_leave; absent = absent / ncns
    const sickSet = new Set(attendanceLogs.filter(r => r.type === 'plawa_leave' || r.type === 'protected_leave').map(r => r.employee_id));
    const absentSet = new Set(attendanceLogs.filter(r => r.type === 'absent' || r.type === 'ncns').map(r => r.employee_id));

    function getTimeOff(empId: number): 'pto' | 'sick' | 'absent' | null {
      if (ptoSet.has(empId)) return 'pto';
      if (sickSet.has(empId)) return 'sick';
      if (absentSet.has(empId)) return 'absent';
      return null;
    }

    if (jobs.length === 0) {
      return res.json({
        employees: employees.map(e => ({
          ...e,
          name: `${e.first_name} ${e.last_name}`,
          jobs: [],
          zone: empZoneMap[e.id] ?? null,
          time_off: getTimeOff(e.id),
          commission_rate: e.commission_rate ? parseFloat(e.commission_rate) : null,
        })),
        unassigned_jobs: [],
      });
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
      })
      .from(timeclockTable)
      .where(sql`${timeclockTable.job_id} = ANY(ARRAY[${sql.raw(idList)}]::int[])`);

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
    let resPct = 0.35;
    let commercialHourlyRate = 20;
    try {
      const compRows = await db.execute(sql`SELECT res_tech_pay_pct, commercial_hourly_rate FROM companies WHERE id = ${companyId} LIMIT 1`);
      const row = (compRows.rows[0] as any);
      if (row) {
        resPct = parseFloat(String(row.res_tech_pay_pct ?? 0.35));
        commercialHourlyRate = parseFloat(String(row.commercial_hourly_rate ?? 20));
      }
    } catch {
      try {
        const fallback = await db.execute(sql`SELECT res_tech_pay_pct FROM companies WHERE id = ${companyId} LIMIT 1`);
        const row = (fallback.rows[0] as any);
        if (row) resPct = parseFloat(String(row.res_tech_pay_pct ?? 0.35));
      } catch { /* keep defaults */ }
    }

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
      });
    }

    // [job-card-redesign] Add-ons per job — drives the "+N" pill on the
    // dispatch chip and the full add-on list in the hover popover. Names
    // come from pricing_addons (preferred, the modern path) with a
    // fallback to the legacy add_ons table for rows imported before
    // pricing_addons existed. Subtotals already reflect quantity × unit
    // price as written by PATCH /api/jobs/:id, so the chip can sum them
    // into a delta without re-multiplying.
    const addOnRows = await db.execute(sql`
      SELECT jao.job_id, jao.quantity, jao.unit_price, jao.subtotal,
             COALESCE(pa.name, ao.name) AS name
        FROM job_add_ons jao
        LEFT JOIN add_ons ao ON ao.id = jao.add_on_id
        LEFT JOIN pricing_addons pa ON pa.id = jao.pricing_addon_id
       WHERE jao.job_id = ANY(ARRAY[${sql.raw(idList)}]::int[])
    `);
    const addOnsByJob = new Map<number, Array<{ name: string; quantity: number; unit_price: number; subtotal: number }>>();
    for (const r of addOnRows.rows as any[]) {
      if (!addOnsByJob.has(r.job_id)) addOnsByJob.set(r.job_id, []);
      addOnsByJob.get(r.job_id)!.push({
        name: r.name ?? "Add-on",
        quantity: r.quantity != null ? parseFloat(String(r.quantity)) : 1,
        unit_price: r.unit_price != null ? parseFloat(String(r.unit_price)) : 0,
        subtotal: r.subtotal != null ? parseFloat(String(r.subtotal)) : 0,
      });
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

      const technicians = jobTechs.map(t => {
        const payType = isCommercial ? t.commercial_pay_type : t.residential_pay_type;
        const payRate = isCommercial ? t.commercial_pay_rate : t.residential_pay_rate;
        const calcPay = payType === "hourly"
          ? Math.round(estHoursPerTech * payRate * 100) / 100
          : Math.round(revenueSharePerTech * payRate * 100) / 100;
        return {
          user_id: t.user_id,
          name: t.name,
          is_primary: t.is_primary,
          est_hours: estHoursPerTech,
          calc_pay: calcPay,
          final_pay: t.final_pay != null ? t.final_pay : (t.pay_override != null ? t.pay_override : calcPay),
          pay_override: t.pay_override,
          // Surface the matrix cell that drove this tech's calc so
          // the JobPanel can render "Hourly $20/hr × 6h" vs
          // "Commission 35% of $160 share" without re-deriving.
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
        ? (isCommercial
            ? (primaryTech.commercial_pay_type === "hourly" ? "commercial_hourly" : "commercial_commission")
            : (primaryTech.residential_pay_type === "commission" ? "residential_pool" : "residential_hourly"))
        : (isCommercial ? "commercial_hourly" : "residential_pool");
      // calcPerTech for legacy callers — sum of per-tech calcs
      // averaged. Modern callers should sum technicians[].calc_pay.
      const calcPerTech = technicians.length
        ? Math.round((technicians.reduce((s, t) => s + t.calc_pay, 0) / technicians.length) * 100) / 100
        : 0;

      return {
        id: j.id,
        client_id: j.client_id,
        client_name: j.client_name,
        client_phone: j.client_phone ?? null,
        client_zip: j.client_zip ?? null,
        client_notes: j.client_notes ?? null,
        client_payment_method: j.client_payment_method ?? null,
        client_type: (j as any).client_type ?? null,
        address: displayAddress,
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
        service_type: j.service_type,
        status: j.status,
        scheduled_date: j.scheduled_date,
        scheduled_time: j.scheduled_time,
        frequency: j.frequency,
        amount: j.base_fee ? parseFloat(j.base_fee) : 0,
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
        // [AI.6.2] Surface schedule linkage so the edit modal's cascade
        // prompt fires for recurring jobs.
        recurring_schedule_id: (j as any).recurring_schedule_id ?? null,
        billing_method: j.billing_method ?? null,
        hourly_rate: j.hourly_rate ? parseFloat(j.hourly_rate) : null,
        estimated_hours: j.estimated_hours ? parseFloat(j.estimated_hours) : null,
        actual_hours: j.actual_hours ? parseFloat(j.actual_hours) : null,
        billed_hours: j.billed_hours ? parseFloat(j.billed_hours) : null,
        billed_amount: j.billed_amount ? parseFloat(j.billed_amount) : null,
        charge_failed_at: j.charge_failed_at ?? null,
        charge_succeeded_at: j.charge_succeeded_at ?? null,
        property_address: displayAddress,
        property_access_notes: j.property_access_notes ?? null,
        office_notes: j.office_notes ?? null,
        // [AF] Completion / lock state — drawer renders read-only UI when
        // locked_at is set.
        locked_at: j.locked_at ?? null,
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
        } : null,
        technicians,
        est_hours_per_tech: estHoursPerTech,
        est_pay_per_tech: calcPerTech,
        company_res_pct: resPct,
        // [pay-matrix 2026-04-29] commission_basis now reflects the
        // primary tech's matrix cell, not a hardcoded company-wide
        // value. Surfaces that need richer per-tech data should read
        // technicians[].pay_type / pay_rate.
        commission_basis: legacyBasis,
        commercial_hourly_rate: isCommercial ? commercialHourlyRate : null,
        // [job-card-redesign] Add-ons drive the "+N" chip pill and the
        // hover popover's full add-on list. Empty array (not null) when
        // a job has none, so the frontend can `.length` directly.
        add_ons: addOnsByJob.get(j.id) ?? [],
        // [job-card-redesign] is_new_client — first-ever job for this
        // residential client (no prior completed). Commercial jobs read
        // false; clients with no client_id (rare/legacy) also read false.
        is_new_client: !isCommercial && j.client_id != null
          ? !clientsWithPriorComplete.has(j.client_id)
          : false,
      };
    });

    const jobsByEmployee = new Map<number, typeof mappedJobs>();
    const unassigned: typeof mappedJobs = [];

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
    const seenSlots = new Set<string>();
    const slotKey = (j: typeof mappedJobs[number]) =>
      `${j.client_id ?? "n"}|${j.scheduled_date ?? ""}|${j.scheduled_time ?? "00:00:00"}`;
    for (const job of mappedJobs) {
      if (seenIds.has(job.id)) continue;
      const slot = slotKey(job);
      if (seenSlots.has(slot)) {
        // Different id, same slot → corrupt-data duplicate. Skip.
        // The next deploy will dedupe it via the migration.
        continue;
      }
      seenIds.add(job.id);
      seenSlots.add(slot);
      if (!job.assigned_user_id) {
        unassigned.push(job);
      } else {
        if (!jobsByEmployee.has(job.assigned_user_id)) jobsByEmployee.set(job.assigned_user_id, []);
        jobsByEmployee.get(job.assigned_user_id)!.push(job);
      }
    }

    return res.json({
      employees: employees.map(e => ({
        id: e.id,
        name: `${e.first_name} ${e.last_name}`,
        role: e.role,
        jobs: jobsByEmployee.get(e.id) || [],
        zone: empZoneMap[e.id] ?? null,
        time_off: getTimeOff(e.id),
        commission_rate: e.commission_rate ? parseFloat(e.commission_rate) : null,
      })),
      unassigned_jobs: unassigned,
    });
  } catch (err) {
    console.error("Dispatch error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to load dispatch" });
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
router.get("/week-summary", requireAuth, async (req, res) => {
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
      ? sql`AND j.branch_id = ${parseInt(branch_id)}`
      : sql``;

    // Per-day aggregate. Excludes cancelled. Unassigned = no assigned_user_id
    // and no row in job_technicians.
    const result = await db.execute(sql`
      SELECT
        scheduled_date::text AS date,
        COUNT(*)::int AS job_count,
        COALESCE(SUM(CAST(base_fee AS NUMERIC)), 0)::numeric AS revenue,
        SUM(
          CASE
            WHEN assigned_user_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id)
            THEN 1 ELSE 0
          END
        )::int AS unassigned_count
      FROM jobs j
      WHERE company_id = ${companyId}
        AND scheduled_date >= ${fromStr}
        AND scheduled_date <= ${toStr}
        AND status != 'cancelled'
        ${branchCond}
      GROUP BY scheduled_date
      ORDER BY scheduled_date ASC
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
router.get("/zone-coverage-audit", requireAuth, async (req, res) => {
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

export default router;
