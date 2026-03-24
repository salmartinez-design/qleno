import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, usersTable, clientsTable, timeclockTable, jobPhotosTable, serviceZonesTable, serviceZoneEmployeesTable, accountsTable, accountPropertiesTable, employeeAttendanceLogTable, employeeLeaveUsageTable } from "@workspace/db/schema";
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
        address: clientsTable.address,
        city: clientsTable.city,
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
        zone_color: serviceZonesTable.color,
        zone_name: serviceZonesTable.name,
        account_id: jobsTable.account_id,
        account_name: accountsTable.account_name,
        billing_method: jobsTable.billing_method,
        hourly_rate: jobsTable.hourly_rate,
        estimated_hours: jobsTable.estimated_hours,
        billed_hours: jobsTable.billed_hours,
        billed_amount: jobsTable.billed_amount,
        charge_failed_at: jobsTable.charge_failed_at,
        charge_succeeded_at: jobsTable.charge_succeeded_at,
        account_property_id: jobsTable.account_property_id,
        property_address: accountPropertiesTable.address,
        property_city: accountPropertiesTable.city,
        property_access_notes: accountPropertiesTable.access_notes,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(accountPropertiesTable, eq(jobsTable.account_property_id, accountPropertiesTable.id))
      .leftJoin(serviceZonesTable, eq(jobsTable.zone_id, serviceZonesTable.id))
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

    const mappedJobs = jobs.map(j => {
      const clock = clockMap.get(j.id);
      const photos = photoMap.get(j.id) || { before: 0, after: 0 };
      const durationMinutes = j.allowed_hours ? Math.round(parseFloat(j.allowed_hours) * 60) : 120;
      const isCommercial = !!j.account_id;
      const displayAddress = isCommercial
        ? (j.property_address ? `${j.property_address}${j.property_city ? `, ${j.property_city}` : ""}` : null)
        : (j.address ? `${j.address}${j.city ? `, ${j.city}` : ""}` : null);
      return {
        id: j.id,
        client_id: j.client_id,
        client_name: j.client_name,
        client_phone: j.client_phone ?? null,
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
        account_id: j.account_id ?? null,
        account_name: j.account_name ?? null,
        billing_method: j.billing_method ?? null,
        hourly_rate: j.hourly_rate ? parseFloat(j.hourly_rate) : null,
        estimated_hours: j.estimated_hours ? parseFloat(j.estimated_hours) : null,
        billed_hours: j.billed_hours ? parseFloat(j.billed_hours) : null,
        billed_amount: j.billed_amount ? parseFloat(j.billed_amount) : null,
        charge_failed_at: j.charge_failed_at ?? null,
        charge_succeeded_at: j.charge_succeeded_at ?? null,
        property_address: displayAddress,
        property_access_notes: j.property_access_notes ?? null,
        clock_entry: clock ? {
          id: clock.id,
          clock_in_at: clock.clock_in_at,
          clock_out_at: clock.clock_out_at,
          distance_from_job_ft: clock.distance_from_job_ft ? parseFloat(clock.distance_from_job_ft) : null,
          is_flagged: clock.flagged,
        } : null,
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
