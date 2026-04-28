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
        // [Q2] New: surface notes + payment method on the client row for hover card
        client_notes: clientsTable.notes,
        client_payment_method: clientsTable.payment_method,
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
        zone_color: sql<string | null>`COALESCE(
          ${serviceZonesTable.color},
          (SELECT z.color FROM service_zones z
             WHERE z.company_id = ${companyId}
               AND z.is_active = true
               AND (
                 COALESCE(NULLIF(${jobsTable.address_zip}, ''), ${clientsTable.zip}) = ANY(z.zip_codes)
                 OR SUBSTRING(COALESCE(NULLIF(${jobsTable.address_street}, ''), ${clientsTable.address}) FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
               )
             LIMIT 1)
        )`,
        zone_name: sql<string | null>`COALESCE(
          ${serviceZonesTable.name},
          (SELECT z.name FROM service_zones z
             WHERE z.company_id = ${companyId}
               AND z.is_active = true
               AND (
                 COALESCE(NULLIF(${jobsTable.address_zip}, ''), ${clientsTable.zip}) = ANY(z.zip_codes)
                 OR SUBSTRING(COALESCE(NULLIF(${jobsTable.address_street}, ''), ${clientsTable.address}) FROM '\\y(\\d{5})\\y') = ANY(z.zip_codes)
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
        property_access_notes: accountPropertiesTable.access_notes,
        office_notes: jobsTable.office_notes,
        // [AF] Completion flow surface-area — drawer renders read-only state
        // when locked_at is set. actual_end_time + completed_by render the
        // "Completed at …" label below the Mark Complete slot.
        locked_at: jobsTable.locked_at,
        actual_end_time: jobsTable.actual_end_time,
        completed_by_user_id: jobsTable.completed_by_user_id,
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

    // Fetch job_technicians for commission display
    const techRows = await db.execute(sql`
      SELECT jt.job_id, jt.user_id, jt.is_primary, jt.pay_override, jt.final_pay,
             u.first_name, u.last_name
      FROM job_technicians jt
      JOIN users u ON u.id = jt.user_id
      WHERE jt.job_id = ANY(ARRAY[${sql.raw(idList)}]::int[])
      ORDER BY jt.job_id, jt.is_primary DESC, jt.id
    `);

    // Fetch company commission rate
    const compRows = await db.execute(sql`SELECT res_tech_pay_pct FROM companies WHERE id = ${companyId} LIMIT 1`);
    const resPct = parseFloat(String((compRows.rows[0] as any)?.res_tech_pay_pct ?? 0.35));

    const techByJob = new Map<number, Array<{ user_id: number; name: string; is_primary: boolean; pay_override: number | null; final_pay: number | null }>>();
    for (const r of techRows.rows as any[]) {
      if (!techByJob.has(r.job_id)) techByJob.set(r.job_id, []);
      techByJob.get(r.job_id)!.push({
        user_id: r.user_id,
        name: `${r.first_name} ${r.last_name}`,
        is_primary: !!r.is_primary,
        pay_override: r.pay_override != null ? parseFloat(String(r.pay_override)) : null,
        final_pay: r.final_pay != null ? parseFloat(String(r.final_pay)) : null,
      });
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
      const displayAddress = isCommercial
        ? (j.property_address ? `${j.property_address}${j.property_city ? `, ${j.property_city}` : ""}` : null)
        : (j.address ? `${j.address}${j.city ? `, ${j.city}` : ""}` : null);
      const jobTotal = j.billed_amount ? parseFloat(j.billed_amount) : (j.base_fee ? parseFloat(j.base_fee) : 0);
      const estHours = j.estimated_hours ? parseFloat(j.estimated_hours) : 0;
      const numTechs = jobTechs.length || 1;
      const poolAmount = jobTotal * resPct;
      const estHoursPerTech = numTechs > 0 ? Math.round((estHours / numTechs) * 10) / 10 : estHours;
      const technicians = jobTechs.map(t => ({
        user_id: t.user_id,
        name: t.name,
        is_primary: t.is_primary,
        est_hours: estHoursPerTech,
        calc_pay: Math.round((poolAmount / numTechs) * 100) / 100,
        final_pay: t.final_pay != null ? t.final_pay : (t.pay_override != null ? t.pay_override : Math.round((poolAmount / numTechs) * 100) / 100),
        pay_override: t.pay_override,
      }));

      return {
        id: j.id,
        client_id: j.client_id,
        client_name: j.client_name,
        client_phone: j.client_phone ?? null,
        client_zip: j.client_zip ?? null,
        client_notes: j.client_notes ?? null,
        client_payment_method: j.client_payment_method ?? null,
        address: displayAddress,
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
        clock_entry: clock ? {
          id: clock.id,
          clock_in_at: clock.clock_in_at,
          clock_out_at: clock.clock_out_at,
          distance_from_job_ft: clock.distance_from_job_ft ? parseFloat(clock.distance_from_job_ft) : null,
          is_flagged: clock.flagged,
        } : null,
        technicians,
        est_hours_per_tech: estHoursPerTech,
        est_pay_per_tech: numTechs > 0 ? Math.round((poolAmount / numTechs) * 100) / 100 : Math.round(poolAmount * 100) / 100,
        company_res_pct: resPct,
      };
    });

    const jobsByEmployee = new Map<number, typeof mappedJobs>();
    const unassigned: typeof mappedJobs = [];

    for (const job of mappedJobs) {
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

export default router;
