import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, usersTable, jobPhotosTable, timeclockTable, invoicesTable, scorecardsTable, serviceZonesTable, serviceZoneEmployeesTable, companiesTable, accountsTable, accountRateCardsTable, accountPropertiesTable, paymentsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, count, desc, sql, notExists, inArray, isNotNull } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { generateJobCompletionPdf } from "../lib/generate-job-pdf.js";
import { geocodeAddress } from "../lib/geocode.js";
import { resolveZoneForZip } from "./zones.js";
import { sendNotification, labelServiceType } from "../services/notificationService.js";
import { computeJobCommissions, recalcJobCommissions } from "../lib/commission-engine.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, assigned_user_id, client_id, date_from, date_to, page = "1", limit = "50", uninvoiced, branch_id } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const conditions: any[] = [eq(jobsTable.company_id, req.auth!.companyId)];
    if (status) conditions.push(eq(jobsTable.status, status as any));
    if (assigned_user_id) conditions.push(eq(jobsTable.assigned_user_id, parseInt(assigned_user_id as string)));
    if (client_id) conditions.push(eq(jobsTable.client_id, parseInt(client_id as string)));
    if (date_from) conditions.push(gte(jobsTable.scheduled_date, date_from as string));
    if (date_to) conditions.push(lte(jobsTable.scheduled_date, date_to as string));
    if (branch_id && branch_id !== "all") conditions.push(eq(jobsTable.branch_id, parseInt(branch_id as string)));
    if (uninvoiced === "true") {
      conditions.push(
        notExists(
          db.select({ id: invoicesTable.id })
            .from(invoicesTable)
            .where(and(
              eq(invoicesTable.job_id, jobsTable.id),
              inArray(invoicesTable.status, ["sent", "paid"])
            ))
        )
      );
    }

    const jobs = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        assigned_user_id: jobsTable.assigned_user_id,
        assigned_user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        frequency: jobsTable.frequency,
        base_fee: jobsTable.base_fee,
        allowed_hours: jobsTable.allowed_hours,
        actual_hours: jobsTable.actual_hours,
        notes: jobsTable.notes,
        created_at: jobsTable.created_at,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(and(...conditions))
      .orderBy(desc(jobsTable.scheduled_date))
      .limit(parseInt(limit as string))
      .offset(offset);

    const totalResult = await db
      .select({ count: count() })
      .from(jobsTable)
      .where(and(...conditions));

    const photoCounts = await db
      .select({
        job_id: jobPhotosTable.job_id,
        photo_type: jobPhotosTable.photo_type,
        cnt: count(),
      })
      .from(jobPhotosTable)
      .groupBy(jobPhotosTable.job_id, jobPhotosTable.photo_type);

    const photoMap = new Map<number, { before: number; after: number }>();
    for (const row of photoCounts) {
      if (!photoMap.has(row.job_id)) photoMap.set(row.job_id, { before: 0, after: 0 });
      const entry = photoMap.get(row.job_id)!;
      if (row.photo_type === "before") entry.before = row.cnt;
      if (row.photo_type === "after") entry.after = row.cnt;
    }

    return res.json({
      data: jobs.map(j => ({
        ...j,
        before_photo_count: photoMap.get(j.id)?.before || 0,
        after_photo_count: photoMap.get(j.id)?.after || 0,
      })),
      total: totalResult[0].count,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
    });
  } catch (err) {
    console.error("List jobs error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list jobs" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const {
      client_id, assigned_user_id, service_type, scheduled_date, scheduled_time,
      frequency, base_fee, allowed_hours, notes,
      account_id, account_property_id, billing_method, hourly_rate, estimated_hours,
      branch_id,
    } = req.body;

    const newJob = await db
      .insert(jobsTable)
      .values({
        company_id: req.auth!.companyId,
        client_id: client_id || null,
        assigned_user_id,
        service_type,
        scheduled_date,
        scheduled_time,
        frequency,
        base_fee: base_fee ?? "0",
        allowed_hours,
        notes,
        account_id: account_id || null,
        account_property_id: account_property_id || null,
        billing_method: billing_method || null,
        hourly_rate: hourly_rate || null,
        estimated_hours: estimated_hours || null,
        branch_id: branch_id || null,
      })
      .returning();

    const jobId = newJob[0].id;
    logAudit(req, "CREATE", "job", jobId, null, newJob[0]);
    // Stop any active post_job_retention enrollment for this client (non-blocking)
    if (client_id) {
      import("../services/followUpService.js").then(({ stopEnrollmentsForClient }) => {
        stopEnrollmentsForClient(client_id, "rebooked", "post_job_retention").catch(() => {});
      });
    }
    // Fire-and-forget: ensure client exists in QuickBooks (residential + commercial).
    // syncCustomer is idempotent — skips if qb_customer_map already has a mapping
    // and no-ops if tenant isn't QB-connected. Booking UX never waits on QB.
    if (client_id) {
      import("../services/quickbooks-sync.js").then(({ queueSync, syncCustomer }) => {
        queueSync(() => syncCustomer(req.auth!.companyId, client_id));
      }).catch(() => {});
    }
    let geoAddress: string | null = null;
    let geoZip: string | null = null;
    let displayClientName = "";
    let displayAssignedName: string | null = null;

    if (account_property_id) {
      // Commercial job — geocode from property address
      const [prop] = await db
        .select({ address: accountPropertiesTable.address, city: accountPropertiesTable.city, state: accountPropertiesTable.state, zip: accountPropertiesTable.zip })
        .from(accountPropertiesTable)
        .where(eq(accountPropertiesTable.id, account_property_id))
        .limit(1);
      if (prop) {
        geoAddress = [prop.address, prop.city, prop.state, prop.zip].filter(Boolean).join(", ");
        geoZip = prop.zip ?? null;
      }
      // Get account name for display
      if (account_id) {
        const [acc] = await db.select({ account_name: accountsTable.account_name }).from(accountsTable).where(eq(accountsTable.id, account_id)).limit(1);
        displayClientName = acc?.account_name || "";
      }
    } else if (client_id) {
      // Residential job — geocode from client address
      const [clientRow] = await db
        .select({
          client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
          address: clientsTable.address,
          city: clientsTable.city,
          state: clientsTable.state,
          zip: clientsTable.zip,
        })
        .from(clientsTable)
        .where(eq(clientsTable.id, client_id))
        .limit(1);
      if (clientRow) {
        geoAddress = clientRow.address ? [clientRow.address, clientRow.city, clientRow.state, clientRow.zip].filter(Boolean).join(", ") : null;
        geoZip = clientRow.zip ?? null;
        displayClientName = clientRow.client_name || "";
      }
    }

    // Get assigned user name
    if (assigned_user_id) {
      const [emp] = await db
        .select({ name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})` })
        .from(usersTable).where(eq(usersTable.id, assigned_user_id)).limit(1);
      displayAssignedName = emp?.name || null;
    }

    if (geoAddress) {
      const coords = await geocodeAddress(geoAddress);
      if (coords) {
        await db.update(jobsTable).set({ job_lat: String(coords.lat), job_lng: String(coords.lng), geocode_failed: false }).where(eq(jobsTable.id, jobId));
        newJob[0] = { ...newJob[0], job_lat: String(coords.lat) as any, job_lng: String(coords.lng) as any, geocode_failed: false };
      } else {
        await db.update(jobsTable).set({ geocode_failed: true }).where(eq(jobsTable.id, jobId));
        newJob[0] = { ...newJob[0], geocode_failed: true };
      }
    }

    if (geoZip) {
      const zoneId = await resolveZoneForZip(req.auth!.companyId, geoZip);
      if (zoneId) {
        await db.update(jobsTable).set({ zone_id: zoneId }).where(eq(jobsTable.id, jobId));
        newJob[0] = { ...newJob[0], zone_id: zoneId } as any;
      }
    }

    return res.status(201).json({
      ...newJob[0],
      client_name: displayClientName,
      assigned_user_name: displayAssignedName,
      before_photo_count: 0,
      after_photo_count: 0,
    });
  } catch (err) {
    console.error("Create job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to create job" });
  }
});

router.get("/my-jobs", requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const companyId = req.auth!.companyId;
    let userId = req.auth!.userId;
    if (req.auth!.role === "owner" && req.query.employee_id) {
      userId = parseInt(req.query.employee_id as string);
    }

    const jobs = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        client_name: sql<string>`CASE WHEN ${jobsTable.account_id} IS NOT NULL THEN ${accountsTable.account_name} ELSE concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name}) END`,
        address: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.address} ELSE ${clientsTable.address} END`,
        city: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.city} ELSE ${clientsTable.city} END`,
        state: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.state} ELSE ${clientsTable.state} END`,
        zip: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.zip} ELSE ${clientsTable.zip} END`,
        lat: clientsTable.lat,
        lng: clientsTable.lng,
        job_lat: jobsTable.job_lat,
        job_lng: jobsTable.job_lng,
        geocode_failed: jobsTable.geocode_failed,
        client_notes: clientsTable.notes,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        base_fee: jobsTable.base_fee,
        notes: jobsTable.notes,
        account_id: jobsTable.account_id,
        account_name: accountsTable.account_name,
        billing_method: jobsTable.billing_method,
        account_property_id: jobsTable.account_property_id,
        property_name: accountPropertiesTable.property_name,
        access_notes: accountPropertiesTable.access_notes,
        estimated_hours: jobsTable.estimated_hours,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(accountPropertiesTable, eq(jobsTable.account_property_id, accountPropertiesTable.id))
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.assigned_user_id, userId),
        eq(jobsTable.scheduled_date, today),
      ))
      .orderBy(jobsTable.scheduled_time);

    if (jobs.length === 0) return res.json({ data: [] });

    const jobIds = jobs.map(j => j.id);

    const photoCounts = await db
      .select({ job_id: jobPhotosTable.job_id, photo_type: jobPhotosTable.photo_type, cnt: count() })
      .from(jobPhotosTable)
      .where(sql`${jobPhotosTable.job_id} = ANY(${sql.raw(`ARRAY[${jobIds.join(",")}]`)})`)
      .groupBy(jobPhotosTable.job_id, jobPhotosTable.photo_type);

    const clockEntries = await db
      .select()
      .from(timeclockTable)
      .where(and(
        eq(timeclockTable.user_id, userId),
        eq(timeclockTable.company_id, companyId),
        sql`${timeclockTable.job_id} = ANY(${sql.raw(`ARRAY[${jobIds.join(",")}]`)})`
      ));

    const photoMap = new Map<number, { before: number; after: number }>();
    for (const row of photoCounts) {
      if (!photoMap.has(row.job_id)) photoMap.set(row.job_id, { before: 0, after: 0 });
      const e = photoMap.get(row.job_id)!;
      if (row.photo_type === "before") e.before = row.cnt;
      if (row.photo_type === "after") e.after = row.cnt;
    }

    const clockMap = new Map<number, typeof clockEntries[0]>();
    for (const e of clockEntries) {
      if (!clockMap.has(e.job_id) || (!e.clock_out_at)) clockMap.set(e.job_id, e);
    }

    return res.json({
      data: jobs.map(j => ({
        ...j,
        lat: j.lat ? parseFloat(j.lat) : null,
        lng: j.lng ? parseFloat(j.lng) : null,
        job_lat: j.job_lat ? parseFloat(j.job_lat) : null,
        job_lng: j.job_lng ? parseFloat(j.job_lng) : null,
        base_fee: j.base_fee ? parseFloat(j.base_fee) : 0,
        estimated_hours: j.estimated_hours ? parseFloat(j.estimated_hours) : null,
        before_photo_count: photoMap.get(j.id)?.before || 0,
        after_photo_count: photoMap.get(j.id)?.after || 0,
        time_clock_entry: clockMap.get(j.id) || null,
      })),
    });
  } catch (err) {
    console.error("My jobs error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get my jobs" });
  }
});

// ─── POST /api/jobs/suggest-tech ─────────────────────────────────────────────
router.post("/suggest-tech", requireAuth, async (req, res) => {
  try {
    const { date, start_time, end_time, zip_code } = req.body;
    const companyId = req.auth!.companyId;

    if (!date || !start_time || !end_time || !zip_code) {
      return res.status(400).json({ error: "date, start_time, end_time, zip_code required" });
    }

    function toMinutes(t: string): number {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + (m || 0);
    }
    function fmtMinutes(m: number): string {
      const hh = Math.floor(m / 60) % 24;
      const mm = m % 60;
      const ampm = hh < 12 ? "AM" : "PM";
      const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
      return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
    }

    const bufStart = toMinutes(start_time) - 30;
    const bufEnd   = toMinutes(end_time)   + 30;

    // 1. All active technicians for this company
    const techs = await db
      .select({
        id: usersTable.id,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        home_zip: usersTable.zip,
        avatar_url: usersTable.avatar_url,
        role: usersTable.role,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.company_id, companyId),
          eq(usersTable.is_active, true),
          inArray(usersTable.role, ["technician"] as any),
        )
      );

    if (techs.length === 0) return res.json([]);

    const techIds = techs.map(t => t.id);

    // 2. All jobs that date for these techs
    const dayJobs = await db
      .select({
        assigned_user_id: jobsTable.assigned_user_id,
        scheduled_time:   jobsTable.scheduled_time,
        allowed_hours:    jobsTable.allowed_hours,
        zone_id:          jobsTable.zone_id,
      })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.scheduled_date, date),
          inArray(jobsTable.assigned_user_id, techIds as any),
        )
      );

    // 3. Detect conflicts; track last-job end time & zone per tech
    const conflictedIds = new Set<number>();
    const lastEndMap: Record<number, number>      = {};
    const lastZoneMap: Record<number, number|null> = {};

    for (const j of dayJobs) {
      if (j.assigned_user_id == null) continue;
      const uid   = j.assigned_user_id;
      const jStart = toMinutes(j.scheduled_time || "00:00");
      const jEnd   = jStart + parseFloat(j.allowed_hours ?? "1") * 60;

      if (!lastEndMap[uid] || jEnd > lastEndMap[uid]) {
        lastEndMap[uid]  = jEnd;
        lastZoneMap[uid] = j.zone_id ?? null;
      }

      if (jStart < bufEnd && jEnd > bufStart) conflictedIds.add(uid);
    }

    const available = techs.filter(t => !conflictedIds.has(t.id));
    if (available.length === 0) return res.json([]);

    // 4. Zone assignments for available techs
    const zoneRows = await db
      .select({
        user_id:   serviceZoneEmployeesTable.user_id,
        zone_id:   serviceZoneEmployeesTable.zone_id,
        zone_name: serviceZonesTable.name,
        zone_color: serviceZonesTable.color,
        zip_codes: serviceZonesTable.zip_codes,
      })
      .from(serviceZoneEmployeesTable)
      .innerJoin(serviceZonesTable, eq(serviceZonesTable.id, serviceZoneEmployeesTable.zone_id))
      .where(inArray(serviceZoneEmployeesTable.user_id, available.map(t => t.id)));

    const techZoneMap: Record<number, typeof zoneRows[0]> = {};
    for (const z of zoneRows) techZoneMap[z.user_id] = z;

    // 5. Find the zone that contains the job zip
    const allZones = await db
      .select({ id: serviceZonesTable.id, name: serviceZonesTable.name, color: serviceZonesTable.color, zip_codes: serviceZonesTable.zip_codes })
      .from(serviceZonesTable)
      .where(eq(serviceZonesTable.company_id, companyId));

    const jobZone = allZones.find(z => (z.zip_codes || []).includes(zip_code)) ?? null;

    // 6. Score and rank
    const scored = available.map(t => {
      const tz = techZoneMap[t.id] ?? null;
      const lastEnd = lastEndMap[t.id] ?? null;

      let tier = 4;
      let reason = "Available — different zone";

      if (!tz) {
        tier = 4;
        reason = "No zone assigned";
      } else if (jobZone && tz.zone_id === jobZone.id) {
        tier = 1;
        reason = "Same zone";
      } else if (jobZone && lastZoneMap[t.id] != null && lastZoneMap[t.id] === jobZone.id) {
        tier = 2;
        reason = "Last job in same zone";
      } else if (jobZone && (jobZone.zip_codes || []).includes(t.home_zip || "")) {
        tier = 3;
        reason = "Home in job zone";
      }

      return {
        employee_id: t.id,
        name: `${t.first_name} ${t.last_name}`,
        avatar_url: t.avatar_url ?? null,
        tier,
        reason,
        zone_color: tz?.zone_color ?? null,
        zone_name: tz?.zone_name ?? null,
        last_job_end_time: lastEnd != null ? fmtMinutes(lastEnd) : null,
      };
    });

    scored.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
    return res.json(scored.slice(0, 5));
  } catch (err) {
    console.error("[suggest-tech]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/availability", requireAuth, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date required" });
    const companyId = req.auth!.companyId;
    const jobs = await db
      .select({ scheduled_time: jobsTable.scheduled_time })
      .from(jobsTable)
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.scheduled_date, date as string),
        sql`${jobsTable.status} NOT IN ('cancelled')`,
      ));
    const countsByHour: Record<number, number> = {};
    for (const job of jobs) {
      if (job.scheduled_time) {
        const hour = parseInt(job.scheduled_time.split(":")[0]);
        if (!isNaN(hour)) countsByHour[hour] = (countsByHour[hour] || 0) + 1;
      }
    }
    const slots = [];
    for (let hour = 7; hour <= 17; hour++) {
      slots.push({ hour, count: countsByHour[hour] || 0 });
    }
    return res.json({ slots });
  } catch (err) {
    console.error("[jobs/availability]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── GET /api/jobs/ready-to-charge ─── Daily Stripe charge queue ──────────────
router.get("/ready-to-charge", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { sql: drizzleSql } = await import("drizzle-orm");
    const todayStr = new Date().toISOString().slice(0, 10);

    const rows = await db.execute(drizzleSql`
      SELECT j.id, j.client_id, j.scheduled_date, j.base_fee, j.billed_amount, j.service_type,
             j.charge_failed_at,
             c.first_name, c.last_name, c.card_last_four, c.card_brand, c.payment_source
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      WHERE j.company_id = ${companyId}
        AND j.status = 'complete'
        AND c.payment_source = 'stripe'
        AND c.stripe_payment_method_id IS NOT NULL
        AND j.charge_succeeded_at IS NULL
        AND j.scheduled_date = ${todayStr}
        AND NOT EXISTS (
          SELECT 1 FROM payments p WHERE p.job_id = j.id AND p.status = 'completed'
        )
      ORDER BY c.last_name, c.first_name
    `);

    return res.json({ data: rows.rows });
  } catch (err) {
    console.error("GET /jobs/ready-to-charge error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);

    const job = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        assigned_user_id: jobsTable.assigned_user_id,
        assigned_user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        frequency: jobsTable.frequency,
        base_fee: jobsTable.base_fee,
        allowed_hours: jobsTable.allowed_hours,
        actual_hours: jobsTable.actual_hours,
        notes: jobsTable.notes,
        created_at: jobsTable.created_at,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.company_id, req.auth!.companyId)
      ))
      .limit(1);

    if (!job[0]) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }

    const photos = await db
      .select()
      .from(jobPhotosTable)
      .where(eq(jobPhotosTable.job_id, jobId));

    const timeclockEntries = await db
      .select({
        id: timeclockTable.id,
        job_id: timeclockTable.job_id,
        user_id: timeclockTable.user_id,
        user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        clock_in_at: timeclockTable.clock_in_at,
        clock_out_at: timeclockTable.clock_out_at,
        clock_in_lat: timeclockTable.clock_in_lat,
        clock_in_lng: timeclockTable.clock_in_lng,
        clock_out_lat: timeclockTable.clock_out_lat,
        clock_out_lng: timeclockTable.clock_out_lng,
        distance_from_job_ft: timeclockTable.distance_from_job_ft,
        flagged: timeclockTable.flagged,
      })
      .from(timeclockTable)
      .leftJoin(usersTable, eq(timeclockTable.user_id, usersTable.id))
      .where(eq(timeclockTable.job_id, jobId));

    const invoiceResult = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.job_id, jobId))
      .limit(1);

    const beforePhotos = photos.filter(p => p.photo_type === "before");
    const afterPhotos = photos.filter(p => p.photo_type === "after");

    return res.json({
      ...job[0],
      before_photo_count: beforePhotos.length,
      after_photo_count: afterPhotos.length,
      photos: photos.map(p => ({
        ...p,
        lat: p.lat ? parseFloat(p.lat) : null,
        lng: p.lng ? parseFloat(p.lng) : null,
      })),
      timeclock_entries: timeclockEntries.map(t => ({
        ...t,
        duration_hours: t.clock_out_at
          ? (new Date(t.clock_out_at).getTime() - new Date(t.clock_in_at).getTime()) / 3600000
          : null,
        distance_from_job_ft: t.distance_from_job_ft ? parseFloat(t.distance_from_job_ft) : null,
      })),
      invoice: invoiceResult[0] || null,
      checklist_items: [],
    });
  } catch (err) {
    console.error("Get job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get job" });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const { assigned_user_id, service_type, status, scheduled_date, scheduled_time, frequency, base_fee, allowed_hours, notes, office_notes } = req.body;

    // AI.15a: read the row before update so we can decide whether the
    // mutation affects commission inputs (base_fee, estimated_hours,
    // billing_method). Recalc only fires when one of those actually
    // changed. Cheap one row read on the primary key. Avoids spamming
    // polling tile updates on every notes or scheduled_time edit.
    const beforeRows = await db
      .select({
        base_fee: jobsTable.base_fee,
        estimated_hours: jobsTable.estimated_hours,
        billing_method: jobsTable.billing_method,
      })
      .from(jobsTable)
      .where(and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.company_id, req.auth!.companyId)
      ))
      .limit(1);
    const before = beforeRows[0] ?? null;

    const updated = await db
      .update(jobsTable)
      .set({
        ...(assigned_user_id !== undefined && { assigned_user_id }),
        ...(service_type && { service_type }),
        ...(status && { status }),
        ...(scheduled_date && { scheduled_date }),
        ...(scheduled_time !== undefined && { scheduled_time }),
        ...(frequency && { frequency }),
        ...(base_fee !== undefined && { base_fee }),
        ...(allowed_hours !== undefined && { allowed_hours }),
        ...(notes !== undefined && { notes }),
        ...(office_notes !== undefined && { office_notes }),
      })
      .where(and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.company_id, req.auth!.companyId)
      ))
      .returning();

    if (!updated[0]) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }

    // AI.15a: dirty check on commission inputs. Today this PUT body only
    // carries base_fee. estimated_hours and billing_method checks are
    // forward compatible. If a future caller adds them to the body,
    // recalc fires automatically without further plumbing.
    //
    // Use numeric tolerance (cent for money, tenth for hours) because the
    // client typically sends numbers and Drizzle returns numeric columns
    // as decimal strings. A naive String() compare would mark every
    // base_fee touch as changed even when the value did not move.
    if (before) {
      const body = req.body as Record<string, unknown>;
      const numEq = (a: unknown, b: unknown, eps: number) =>
        Math.abs(parseFloat(String(a ?? 0)) - parseFloat(String(b ?? 0))) < eps;

      const baseFeeChanged = base_fee !== undefined
        && !numEq(base_fee, before.base_fee, 0.005);
      const estHoursChanged = body.estimated_hours !== undefined
        && !numEq(body.estimated_hours, before.estimated_hours, 0.05);
      const billingMethodChanged = body.billing_method !== undefined
        && body.billing_method !== before.billing_method;
      if (baseFeeChanged || estHoursChanged || billingMethodChanged) {
        await recalcJobCommissions(jobId, req.auth!.companyId);
      }
    }

    logAudit(req, "UPDATE", "job", jobId, null, updated[0]);
    return res.json({
      ...updated[0],
      client_name: "",
      assigned_user_name: null,
      before_photo_count: 0,
      after_photo_count: 0,
    });
  } catch (err) {
    console.error("Update job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to update job" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    await db
      .delete(jobsTable)
      .where(and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.company_id, req.auth!.companyId)
      ));
    logAudit(req, "DELETE", "job", jobId, null, null);
    return res.json({ success: true, message: "Job deleted" });
  } catch (err) {
    console.error("Delete job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to delete job" });
  }
});

router.post("/:id/complete", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);

    const afterPhotos = await db
      .select({ count: count() })
      .from(jobPhotosTable)
      .where(and(
        eq(jobPhotosTable.job_id, jobId),
        eq(jobPhotosTable.photo_type, "after")
      ));

    // [AF] The "≥1 after photo" hard-block only fires when PHOTOS_ENABLED=true.
    // With photos feature-flagged off we still report counts (for existing
    // photos) but don't require one to complete. Re-enabling PHOTOS_ENABLED
    // restores the gate automatically.
    if (process.env.PHOTOS_ENABLED === "true" && afterPhotos[0].count < 1) {
      return res.status(400).json({
        error: "Bad Request",
        message: "At least 1 after photo required to complete job"
      });
    }

    // [AF] Atomic completion UPDATE — also stamps actual_end_time, locked_at,
    // and completed_by_user_id. locked_at is the signal to the drawer UI that
    // this job is read-only (no more status changes, no more commission edits).
    // Guard against double-complete: WHERE status != 'complete' so a second
    // Mark Complete click is a no-op (rowcount=0 → 409 below).
    const nowTs = new Date();
    const updated = await db
      .update(jobsTable)
      .set({
        status: "complete",
        actual_end_time: nowTs,
        locked_at: nowTs,
        completed_by_user_id: req.auth!.userId,
      })
      .where(and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.company_id, req.auth!.companyId),
        sql`${jobsTable.status} NOT IN ('complete', 'cancelled')`,
      ))
      .returning();

    if (!updated[0]) {
      // Either the job doesn't exist, belongs to another tenant, OR is already
      // complete/cancelled. Probe to disambiguate for a clearer client message.
      const [existing] = await db
        .select({ status: jobsTable.status, locked_at: jobsTable.locked_at })
        .from(jobsTable)
        .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, req.auth!.companyId)))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ error: "Not Found", message: "Job not found" });
      }
      return res.status(409).json({
        error: "Conflict",
        message: `Job is already ${existing.status}.`,
        status: existing.status,
        locked_at: existing.locked_at,
      });
    }

    // ── Hourly billing engine ─────────────────────────────────────────────
    const completedJob = updated[0] as any;
    if (completedJob.billing_method === "hourly" && completedJob.hourly_rate) {
      try {
        // Sum all completed timeclock entries for this job
        const tcRows = await db
          .select({ clock_in_at: timeclockTable.clock_in_at, clock_out_at: timeclockTable.clock_out_at })
          .from(timeclockTable)
          .where(and(eq(timeclockTable.job_id, jobId), isNotNull(timeclockTable.clock_out_at)));

        const totalMinutes = tcRows.reduce((sum, r) => {
          if (!r.clock_out_at) return sum;
          return sum + (new Date(r.clock_out_at).getTime() - new Date(r.clock_in_at).getTime()) / 60000;
        }, 0);

        // Round up to nearest 0.25h
        const rawHours = totalMinutes / 60;
        const billedHours = Math.ceil(rawHours * 4) / 4;
        const billedAmount = billedHours * parseFloat(completedJob.hourly_rate);

        await db
          .update(jobsTable)
          .set({
            billed_hours: billedHours.toFixed(2),
            billed_amount: billedAmount.toFixed(2),
          })
          .where(eq(jobsTable.id, jobId));

        completedJob.billed_hours = billedHours.toFixed(2);
        completedJob.billed_amount = billedAmount.toFixed(2);
      } catch (billingErr) {
        console.error("Billing engine error (non-fatal):", billingErr);
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    const jobDetail = await db
      .select({
        id: jobsTable.id,
        service_type: jobsTable.service_type,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        base_fee: jobsTable.base_fee,
        actual_hours: jobsTable.actual_hours,
        notes: jobsTable.notes,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        client_address: sql<string>`coalesce(${clientsTable.address}, '')`,
        assigned_user_name: sql<string | null>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        company_name: sql<string>`coalesce((select name from companies where id = ${jobsTable.company_id}), 'Qleno')`,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(eq(jobsTable.id, jobId))
      .limit(1);

    const beforeCount = await db
      .select({ count: count() })
      .from(jobPhotosTable)
      .where(and(eq(jobPhotosTable.job_id, jobId), eq(jobPhotosTable.photo_type, "before")));

    let pdfUrl: string | null = null;
    try {
      if (jobDetail[0]) {
        const d = jobDetail[0];
        pdfUrl = await generateJobCompletionPdf({
          jobId,
          companyName: d.company_name || "Qleno",
          clientName: d.client_name || "Unknown Client",
          clientAddress: d.client_address || "",
          serviceType: d.service_type || "Cleaning",
          scheduledDate: d.scheduled_date || "",
          scheduledTime: d.scheduled_time,
          assignedUserName: d.assigned_user_name,
          baseFee: d.base_fee,
          actualHours: d.actual_hours,
          notes: d.notes,
          beforePhotoCount: beforeCount[0]?.count ?? 0,
          afterPhotoCount: afterPhotos[0].count,
          completedAt: new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }),
        });

        await db
          .update(jobsTable)
          .set({ completion_pdf_url: pdfUrl })
          .where(eq(jobsTable.id, jobId));
      }
    } catch (pdfErr) {
      console.error("PDF generation error (non-fatal):", pdfErr);
    }

    // ── Auto-invoice on completion ────────────────────────────────────────
    let autoInvoice: { id: number; status: string; total: string } | null = null;
    let invoiceCreated = false;
    let invoiceError = false;

    try {
      const companyId = req.auth!.companyId;
      const job = updated[0] as any;

      const existing = await db
        .select({ id: invoicesTable.id, status: invoicesTable.status, total: invoicesTable.total })
        .from(invoicesTable)
        .where(and(eq(invoicesTable.job_id, jobId), eq(invoicesTable.company_id, companyId)))
        .limit(1);

      if (existing[0]) {
        autoInvoice = { id: existing[0].id, status: existing[0].status, total: existing[0].total };
      } else {
        // If this job belongs to an account, check invoice_frequency before auto-creating
        let skipAutoInvoice = false;
        let termsDays = 0;
        let clientId = job.client_id ?? null;

        if (job.account_id) {
          const [acct] = await db
            .select({ invoice_frequency: accountsTable.invoice_frequency, payment_terms_days: accountsTable.payment_terms_days })
            .from(accountsTable)
            .where(eq(accountsTable.id, job.account_id))
            .limit(1);
          if (acct) {
            termsDays = acct.payment_terms_days ?? 30;
            // Only auto-invoice on per_job; weekly/monthly get batched via consolidate endpoint
            if (acct.invoice_frequency !== "per_job") {
              skipAutoInvoice = true;
            }
          }
        } else {
          const [co] = await db
            .select({ payment_terms_days: companiesTable.payment_terms_days })
            .from(companiesTable)
            .where(eq(companiesTable.id, companyId))
            .limit(1);
          termsDays = co?.payment_terms_days ?? 0;
        }

        if (!skipAutoInvoice) {
          const today = new Date();
          const due = new Date(today);
          due.setDate(due.getDate() + termsDays);
          const dueDateStr = due.toISOString().split("T")[0];

          const termsLabel =
            termsDays === 30 ? "net_30" :
            termsDays === 15 ? "net_15" :
            termsDays === 7  ? "net_7"  : "due_on_receipt";

          // Use billed_amount for hourly jobs; otherwise base_fee
          const amount = completedJob.billed_amount
            ? parseFloat(completedJob.billed_amount)
            : parseFloat(job.base_fee ?? "0");
          const svcLabel = (job.service_type ?? "Cleaning Service")
            .split("_").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          const qty = completedJob.billed_hours ? parseFloat(completedJob.billed_hours) : 1;
          const unitPrice = completedJob.hourly_rate ? parseFloat(completedJob.hourly_rate) : amount;

          const lineItems = [{ description: svcLabel, quantity: qty, unit_price: unitPrice, total: amount }];

          const [newInv] = await db
            .insert(invoicesTable)
            .values({
              company_id: companyId,
              job_id: jobId,
              client_id: clientId,
              account_id: job.account_id ?? null,
              status: "draft",
              line_items: lineItems,
              subtotal: amount.toFixed(2),
              total: amount.toFixed(2),
              due_date: dueDateStr,
              payment_terms: termsLabel,
              created_by: req.auth!.userId,
            })
            .returning({ id: invoicesTable.id, status: invoicesTable.status, total: invoicesTable.total });

          autoInvoice = { id: newInv.id, status: newInv.status, total: newInv.total };
          invoiceCreated = true;

          // [AF] Fire-and-forget QB invoice push. Enqueue a pending row in
          // qb_sync_queue regardless of whether this tenant is QB-connected —
          // the cron drain (syncAll) checks getValidToken() and no-ops cleanly
          // for tenants without a connection, so queueing is always safe.
          // Does NOT respect COMMS_ENABLED: QB push is accounting, not
          // outbound customer comms.
          try {
            const { syncInvoice } = await import("../services/quickbooks-sync.js");
            syncInvoice(companyId, newInv.id).catch(qbErr => {
              console.error("[AF] QB invoice push error (non-fatal):", qbErr);
            });
          } catch (qbImportErr) {
            console.error("[AF] QB sync module load error (non-fatal):", qbImportErr);
          }
        }
      }
    } catch (invErr) {
      console.error("Auto-invoice error (non-fatal):", invErr);
      invoiceError = true;
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── NPS survey trigger (non-blocking) ────────────────────────────────
    const clientId = (updated[0] as any).client_id;
    if (clientId) {
      fetch(`http://localhost:${process.env.PORT || 8080}/api/satisfaction/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": req.headers.authorization || "",
        },
        body: JSON.stringify({ job_id: jobId, customer_id: clientId }),
      }).catch((npsErr: Error) => console.error("NPS send error (non-fatal):", npsErr));
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── post_job_retention enrollment (non-blocking) ──────────────────────
    if (completedJob.client_id) {
      import("../services/followUpService.js").then(({ enrollForJobComplete }) => {
        enrollForJobComplete(req.auth!.companyId, jobId, completedJob.client_id).catch(() => {});
      });
    }

    // ── job_completed notification (non-blocking) ─────────────────────────
    const companyId = req.auth!.companyId;
    if (clientId && jobDetail[0]) {
      const jd = jobDetail[0];
      db.select({ email: clientsTable.email, phone: clientsTable.phone,
                  address: clientsTable.address, city: clientsTable.city, state: clientsTable.state,
                  first_name: clientsTable.first_name })
        .from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1)
        .then(([cl]) => {
          if (!cl) return;
          const addr = [cl.address, cl.city, cl.state].filter(Boolean).join(", ");
          const mv = {
            first_name:       cl.first_name || "",
            appointment_date: jd.scheduled_date || new Date().toISOString().slice(0, 10),
            scope:            labelServiceType(jd.service_type),
            service_address:  addr,
          };
          sendNotification("job_completed", "email", companyId, cl.email, null, mv).catch(() => {});
          sendNotification("job_completed", "sms",   companyId, null, cl.phone, mv).catch(() => {});
        }).catch(() => {});
    }
    // ─────────────────────────────────────────────────────────────────────

    return res.json({
      ...updated[0],
      client_name: jobDetail[0]?.client_name ?? "",
      assigned_user_name: jobDetail[0]?.assigned_user_name ?? null,
      before_photo_count: beforeCount[0]?.count ?? 0,
      after_photo_count: afterPhotos[0].count,
      completion_pdf_url: pdfUrl,
      invoice: autoInvoice,
      invoice_created: invoiceCreated,
      invoice_error: invoiceError,
    });
  } catch (err) {
    console.error("Complete job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to complete job" });
  }
});

router.get("/:id/photos", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);

    const photos = await db
      .select()
      .from(jobPhotosTable)
      .where(and(
        eq(jobPhotosTable.job_id, jobId),
        eq(jobPhotosTable.company_id, req.auth!.companyId)
      ))
      .orderBy(jobPhotosTable.timestamp);

    const beforeCount = photos.filter(p => p.photo_type === "before").length;
    const afterCount = photos.filter(p => p.photo_type === "after").length;

    return res.json({
      data: photos.map(p => ({
        ...p,
        lat: p.lat ? parseFloat(p.lat) : null,
        lng: p.lng ? parseFloat(p.lng) : null,
      })),
      before_count: beforeCount,
      after_count: afterCount,
    });
  } catch (err) {
    console.error("Get photos error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get photos" });
  }
});

router.post("/:id/photos", requireAuth, async (req, res) => {
  // [AF] PHOTOS_ENABLED feature gate — blocks new photo uploads while the
  // before/after workflow is paused. GETs + existing photo rows stay intact.
  if (process.env.PHOTOS_ENABLED !== "true") {
    return res.status(503).json({ error: "feature_disabled", message: "Photo uploads are temporarily disabled (PHOTOS_ENABLED=false)." });
  }
  try {
    const jobId = parseInt(req.params.id);
    const { photo_type, data_url, lat, lng } = req.body;

    const photo = await db
      .insert(jobPhotosTable)
      .values({
        job_id: jobId,
        company_id: req.auth!.companyId,
        photo_type,
        url: data_url,
        lat,
        lng,
        uploaded_by: req.auth!.userId,
      })
      .returning();

    return res.status(201).json({
      ...photo[0],
      lat: photo[0].lat ? parseFloat(photo[0].lat) : null,
      lng: photo[0].lng ? parseFloat(photo[0].lng) : null,
    });
  } catch (err) {
    console.error("Upload photo error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to upload photo" });
  }
});

// ── POST /api/jobs/:id/charge ─── Manual Stripe charge (owner/admin only) ────
router.post("/:id/charge", requireAuth, async (req, res) => {
  try {
    const role = (req as any).auth?.role;
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;

    // Load job with client info
    const { sql: drizzleSql } = await import("drizzle-orm");
    const jobRows = await db.execute(drizzleSql`
      SELECT j.id, j.company_id, j.client_id, j.status, j.base_fee, j.billed_amount,
             j.charge_failed_at, j.charge_succeeded_at,
             c.stripe_customer_id, c.stripe_payment_method_id, c.payment_source,
             c.card_last_four, c.card_brand,
             c.first_name, c.last_name, c.email, c.phone,
             inv.id as invoice_id, inv.total as invoice_total, inv.status as invoice_status
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      LEFT JOIN invoices inv ON inv.job_id = j.id AND inv.status != 'paid'
      WHERE j.id = ${jobId} AND j.company_id = ${companyId}
      LIMIT 1
    `);

    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });
    const job = jobRows.rows[0] as any;

    if (job.status !== "complete") return res.status(400).json({ error: "Job must be completed before charging" });
    if (job.payment_source !== "stripe") return res.status(400).json({ error: "Client does not have Stripe on file" });
    if (!job.stripe_customer_id || !job.stripe_payment_method_id) {
      return res.status(400).json({ error: "No card on file for this client" });
    }
    if (job.charge_succeeded_at) return res.status(400).json({ error: "Job already charged successfully" });

    // Check for existing successful payment
    const existingPmt = await db.execute(drizzleSql`
      SELECT id FROM payments WHERE job_id = ${jobId} AND status = 'completed' LIMIT 1
    `);
    if (existingPmt.rows.length > 0) return res.status(400).json({ error: "Payment already recorded for this job" });

    const chargeAmount = Number(job.billed_amount || job.base_fee || 0);
    if (chargeAmount <= 0) return res.status(400).json({ error: "Invalid charge amount" });
    const amountCents = Math.round(chargeAmount * 100);

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(503).json({ error: "Stripe not configured" });

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });

    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        customer: job.stripe_customer_id,
        payment_method: job.stripe_payment_method_id,
        confirm: true,
        off_session: true,
        description: `Job #${jobId} — ${job.first_name} ${job.last_name}`,
        metadata: {
          job_id: String(jobId),
          client_id: String(job.client_id),
          company_id: String(companyId),
        },
      });

      if (paymentIntent.status !== "succeeded") {
        throw new Error(`Payment status: ${paymentIntent.status}`);
      }

      // Record successful payment
      await db.insert(paymentsTable).values({
        company_id: companyId,
        client_id: job.client_id,
        invoice_id: job.invoice_id || null,
        job_id: jobId,
        amount: String(chargeAmount),
        method: "stripe",
        status: "completed",
        stripe_payment_id: paymentIntent.id,
        last_4: job.card_last_four || null,
        card_brand: job.card_brand || null,
        processed_by: req.auth!.userId,
        attempted_at: new Date(),
      });

      // Mark invoice paid
      if (job.invoice_id) {
        await db.execute(drizzleSql`
          UPDATE invoices SET status = 'paid', paid_at = NOW(), stripe_payment_intent_id = ${paymentIntent.id}
          WHERE id = ${job.invoice_id}
        `);
      }

      // Mark job charged
      await db.execute(drizzleSql`
        UPDATE jobs SET charge_succeeded_at = NOW(), charge_failed_at = NULL WHERE id = ${jobId}
      `);

      // Fire payment_received notification
      try {
        await sendNotification("payment_received", job.client_id, companyId, {
          client_name: `${job.first_name} ${job.last_name}`,
          client_email: job.email,
          client_phone: job.phone,
          amount: chargeAmount.toFixed(2),
          card_brand: job.card_brand || "Card",
          card_last_four: job.card_last_four || "****",
        });
      } catch (notifErr) {
        console.error("[charge] notification error:", notifErr);
      }

      console.log(`[STRIPE] Charge succeeded — job_id=${jobId} amount=$${chargeAmount} pi=${paymentIntent.id}`);
      return res.json({
        ok: true,
        amount: chargeAmount,
        card_brand: job.card_brand,
        card_last_four: job.card_last_four,
        payment_intent_id: paymentIntent.id,
      });
    } catch (stripeErr: any) {
      const errCode = stripeErr?.code || stripeErr?.raw?.code || "unknown";
      const errMsg = stripeErr?.message || "Charge failed";

      // Record failed payment
      await db.insert(paymentsTable).values({
        company_id: companyId,
        client_id: job.client_id,
        invoice_id: job.invoice_id || null,
        job_id: jobId,
        amount: String(chargeAmount),
        method: "stripe",
        status: "failed",
        stripe_error_code: errCode,
        stripe_error_message: errMsg,
        last_4: job.card_last_four || null,
        card_brand: job.card_brand || null,
        processed_by: req.auth!.userId,
        attempted_at: new Date(),
      });

      // Mark job charge failed
      await db.execute(drizzleSql`
        UPDATE jobs SET charge_failed_at = NOW() WHERE id = ${jobId}
      `);

      console.error(`[STRIPE] Charge failed — job_id=${jobId} code=${errCode} msg=${errMsg}`);
      return res.status(402).json({
        error: `Charge failed: ${errMsg}. Contact the client to collect a backup payment method.`,
        stripe_error_code: errCode,
      });
    }
  } catch (err: any) {
    console.error("POST /jobs/:id/charge error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Commission engine extracted to ../lib/commission-engine.ts.
// computeJobCommissions for reads, recalcJobCommissions for mutations.

// GET /api/jobs/:id/technicians
router.get("/:id/technicians", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const result = await computeJobCommissions(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("GET /jobs/:id/technicians error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/jobs/:id/technicians — add a tech to the job
router.post("/:id/technicians", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const { user_id, is_primary } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    const jobRows = await db.execute(drizzleSql`SELECT id FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1`);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });

    await db.execute(drizzleSql`
      INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
      VALUES (${jobId}, ${user_id}, ${companyId}, ${is_primary ?? false})
      ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
    `);

    const result = await recalcJobCommissions(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("POST /jobs/:id/technicians error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /api/jobs/:id/technicians/:techId
router.delete("/:id/technicians/:techId", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const techId = parseInt(req.params.techId);
    const companyId = req.auth!.companyId;

    await db.execute(drizzleSql`
      DELETE FROM job_technicians WHERE job_id = ${jobId} AND user_id = ${techId} AND company_id = ${companyId}
    `);

    const result = await recalcJobCommissions(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("DELETE /jobs/:id/technicians/:techId error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// PUT /api/jobs/:id/technicians/:techId/override — set pay override for a tech
router.put("/:id/technicians/:techId/override", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const techId = parseInt(req.params.techId);
    const companyId = req.auth!.companyId;
    const { pay_override } = req.body;

    const jobRows = await db.execute(drizzleSql`SELECT id FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1`);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });

    const overrideVal = pay_override != null ? parseFloat(String(pay_override)) : null;

    await db.execute(drizzleSql`
      INSERT INTO job_technicians (job_id, user_id, company_id, pay_override, final_pay)
      VALUES (${jobId}, ${techId}, ${companyId}, ${overrideVal}, ${overrideVal})
      ON CONFLICT (job_id, user_id) DO UPDATE SET
        pay_override = EXCLUDED.pay_override,
        final_pay = EXCLUDED.final_pay
    `);

    const result = await recalcJobCommissions(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("PUT /jobs/:id/technicians/:techId/override error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/jobs/:id/commission/set-pool-rate
router.post("/:id/commission/set-pool-rate", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const { commission_pool_rate } = req.body;

    await db.execute(drizzleSql`
      UPDATE jobs SET commission_pool_rate = ${parseFloat(String(commission_pool_rate))}
      WHERE id = ${jobId} AND company_id = ${companyId}
    `);

    const result = await recalcJobCommissions(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("POST /jobs/:id/commission/set-pool-rate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// JOBS PAGE V2 — KPI, enhanced list, bulk actions, views, column prefs, export
// ═══════════════════════════════════════════════════════════════════════════════

const VALID_STATUSES = ["scheduled", "in_progress", "complete", "cancelled"];
const VALID_SERVICE_TYPES = ["standard_clean", "deep_clean", "move_out", "recurring", "post_construction", "move_in", "office_cleaning", "common_areas", "retail_store", "medical_office", "ppm_turnover", "post_event"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildJobWhereClause(query: any, companyId: number, cursorId?: number | null) {
  const parts: ReturnType<typeof sql>[] = [sql`j.company_id = ${companyId}`];
  if (query.status && VALID_STATUSES.includes(query.status)) parts.push(sql`j.status = ${query.status}`);
  if (query.branch_id && query.branch_id !== "all") { const v = parseInt(query.branch_id); if (!isNaN(v)) parts.push(sql`j.branch_id = ${v}`); }
  if (query.zone_id) { const v = parseInt(query.zone_id); if (!isNaN(v)) parts.push(sql`j.zone_id = ${v}`); }
  if (query.date_from && DATE_RE.test(query.date_from)) parts.push(sql`j.scheduled_date >= ${query.date_from}`);
  if (query.date_to && DATE_RE.test(query.date_to)) parts.push(sql`j.scheduled_date <= ${query.date_to}`);
  if (query.assigned_user_id) {
    if (query.assigned_user_id === "unassigned") parts.push(sql`j.assigned_user_id IS NULL`);
    else { const v = parseInt(query.assigned_user_id); if (!isNaN(v)) parts.push(sql`j.assigned_user_id = ${v}`); }
  }
  if (query.client_id) { const v = parseInt(query.client_id); if (!isNaN(v)) parts.push(sql`j.client_id = ${v}`); }
  if (query.service_type && VALID_SERVICE_TYPES.includes(query.service_type)) parts.push(sql`j.service_type = ${query.service_type}`);
  if (query.flagged === "true") parts.push(sql`j.flagged = true`);
  if (query.has_photos === "true") parts.push(sql`EXISTS (SELECT 1 FROM job_photos jp WHERE jp.job_id = j.id)`);
  if (query.revenue_min) { const v = parseFloat(query.revenue_min); if (!isNaN(v)) parts.push(sql`CAST(j.base_fee AS NUMERIC) >= ${v}`); }
  if (query.revenue_max) { const v = parseFloat(query.revenue_max); if (!isNaN(v)) parts.push(sql`CAST(j.base_fee AS NUMERIC) <= ${v}`); }
  if (query.payment_status === "paid") parts.push(sql`j.charge_succeeded_at IS NOT NULL`);
  else if (query.payment_status === "failed") parts.push(sql`j.charge_failed_at IS NOT NULL AND j.charge_succeeded_at IS NULL`);
  else if (query.payment_status === "unpaid") parts.push(sql`j.charge_succeeded_at IS NULL AND j.charge_failed_at IS NULL AND j.charge_attempted_at IS NULL`);
  if (query.uninvoiced === "true") parts.push(sql`NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status IN ('sent','paid'))`);
  if (query.search) {
    const s = `%${String(query.search)}%`;
    parts.push(sql`(concat(c.first_name, ' ', c.last_name) ILIKE ${s} OR concat(u.first_name, ' ', u.last_name) ILIKE ${s} OR c.address ILIKE ${s} OR c.email ILIKE ${s} OR CAST(j.id AS TEXT) = ${String(query.search)})`);
  }
  if (cursorId) parts.push(sql`j.id < ${cursorId}`);
  return sql.join(parts, sql` AND `);
}

const JOBS_V2_FROM = sql`FROM jobs j LEFT JOIN clients c ON j.client_id = c.id LEFT JOIN users u ON j.assigned_user_id = u.id LEFT JOIN service_zones sz ON j.zone_id = sz.id LEFT JOIN branches b ON j.branch_id = b.id`;

// GET /api/jobs/v2/kpi
router.get("/v2/kpi", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const where = buildJobWhereClause(req.query, companyId);
    const result = await db.execute(sql`
      SELECT
        COALESCE(MIN(CAST(j.base_fee AS NUMERIC)), 0) AS revenue_min,
        COALESCE(MAX(CAST(j.base_fee AS NUMERIC)), 0) AS revenue_max,
        COALESCE(SUM(CAST(j.base_fee AS NUMERIC)), 0) AS revenue_total,
        COUNT(*) FILTER (WHERE j.status = 'complete') AS completed,
        CASE WHEN COUNT(*) > 0 THEN ROUND(SUM(CAST(j.base_fee AS NUMERIC)) / COUNT(*), 2) ELSE 0 END AS avg_job,
        COUNT(*) AS total_jobs,
        COUNT(DISTINCT j.scheduled_date) AS distinct_days,
        COUNT(*) FILTER (WHERE j.assigned_user_id IS NULL) AS unassigned
      ${JOBS_V2_FROM} WHERE ${where}
    `);
    const row = (result as any).rows?.[0] ?? {};
    const totalJobs = parseInt(row.total_jobs) || 0;
    const distinctDays = parseInt(row.distinct_days) || 1;
    return res.json({
      revenue_min: parseFloat(row.revenue_min) || 0,
      revenue_max: parseFloat(row.revenue_max) || 0,
      revenue_total: parseFloat(row.revenue_total) || 0,
      completed: parseInt(row.completed) || 0,
      avg_job: parseFloat(row.avg_job) || 0,
      jobs_per_day: Math.round((totalJobs / distinctDays) * 10) / 10,
      unassigned: parseInt(row.unassigned) || 0,
    });
  } catch (err) {
    console.error("GET /jobs/v2/kpi error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/jobs/v2/list — cursor-paginated
router.get("/v2/list", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 50), 200);
    const cursorRaw = req.query.cursor ? parseInt(req.query.cursor as string) : null;
    const cursor = cursorRaw && !isNaN(cursorRaw) ? cursorRaw : null;
    const sortCol = (req.query.sort as string) || "scheduled_date";
    const sortDir = (req.query.dir as string) === "asc" ? sql`ASC` : sql`DESC`;

    const where = buildJobWhereClause(req.query, companyId, cursor);

    const validSorts: Record<string, ReturnType<typeof sql>> = {
      scheduled_date: sql`j.scheduled_date`,
      client_name: sql`concat(c.first_name, ' ', c.last_name)`,
      status: sql`j.status`,
      base_fee: sql`CAST(j.base_fee AS NUMERIC)`,
      service_type: sql`j.service_type`,
      created_at: sql`j.created_at`,
    };
    const orderExpr = validSorts[sortCol] || sql`j.scheduled_date`;

    const result = await db.execute(sql`
      SELECT
        j.id, j.client_id, j.assigned_user_id, j.service_type, j.status,
        j.scheduled_date, j.scheduled_time, j.frequency, j.base_fee,
        j.allowed_hours, j.actual_hours, j.notes, j.flagged, j.zone_id, j.branch_id,
        j.charge_succeeded_at, j.charge_failed_at, j.charge_attempted_at,
        j.created_at, j.office_notes,
        concat(c.first_name, ' ', c.last_name) AS client_name,
        c.address AS client_address, c.city AS client_city, c.referral_source,
        concat(u.first_name, ' ', u.last_name) AS tech_name,
        sz.name AS zone_name, sz.color AS zone_color, b.name AS branch_name
      ${JOBS_V2_FROM} WHERE ${where}
      ORDER BY ${orderExpr} ${sortDir}, j.id DESC
      LIMIT ${limit + 1}
    `);

    const rows = (result as any).rows ?? [];
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].id : null;
    const mapped = data.map((r: any) => ({
      ...r,
      base_fee: r.base_fee ? parseFloat(r.base_fee) : 0,
      payment_status: r.charge_succeeded_at ? "paid" : r.charge_failed_at ? "failed" : r.charge_attempted_at ? "pending" : "unpaid",
    }));

    const countWhere = buildJobWhereClause(req.query, companyId);
    const countResult = await db.execute(sql`SELECT COUNT(*) AS cnt ${JOBS_V2_FROM} WHERE ${countWhere}`);
    const total = parseInt((countResult as any).rows?.[0]?.cnt) || 0;

    return res.json({ data: mapped, total, next_cursor: nextCursor, has_more: hasMore });
  } catch (err) {
    console.error("GET /jobs/v2/list error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/jobs/v2/bulk — bulk actions
router.post("/v2/bulk", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { action, job_ids, payload } = req.body;
    if (!Array.isArray(job_ids) || job_ids.length === 0) return res.status(400).json({ error: "job_ids required" });
    const idList = job_ids.map((id: any) => parseInt(id)).filter((n: number) => !isNaN(n));
    if (idList.length === 0) return res.status(400).json({ error: "no valid job IDs" });

    switch (action) {
      case "mark_complete": {
        await db.execute(sql`UPDATE jobs SET status = 'complete' WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        return res.json({ success: true, affected: idList.length });
      }
      case "mark_paid": {
        await db.execute(sql`UPDATE jobs SET charge_succeeded_at = NOW() WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        return res.json({ success: true, affected: idList.length });
      }
      case "cancel": {
        const reason = String(payload?.reason || "cancelled").slice(0, 200);
        await db.execute(sql`UPDATE jobs SET status = 'cancelled', notes = COALESCE(notes, '') || ${` [Cancelled: ${reason}]`} WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        return res.json({ success: true, affected: idList.length });
      }
      case "reassign": {
        const techId = parseInt(payload?.assigned_user_id);
        if (!techId || isNaN(techId)) return res.status(400).json({ error: "assigned_user_id required" });
        await db.execute(sql`UPDATE jobs SET assigned_user_id = ${techId} WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        return res.json({ success: true, affected: idList.length });
      }
      case "reschedule": {
        const date = payload?.date;
        if (!date || !DATE_RE.test(date)) return res.status(400).json({ error: "valid date required (YYYY-MM-DD)" });
        const timeShift = payload?.time_shift || null;
        if (timeShift) {
          await db.execute(sql`UPDATE jobs SET scheduled_date = ${date}, scheduled_time = ${timeShift} WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        } else {
          await db.execute(sql`UPDATE jobs SET scheduled_date = ${date} WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        }
        return res.json({ success: true, affected: idList.length });
      }
      case "flag": {
        const flagged = payload?.flagged !== false;
        await db.execute(sql`UPDATE jobs SET flagged = ${flagged} WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        return res.json({ success: true, affected: idList.length });
      }
      case "batch_invoice_preflight": {
        const pf = await db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status IN ('sent','paid'))) AS to_invoice,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status IN ('sent','paid'))) AS already_invoiced,
            COALESCE(SUM(CAST(j.base_fee AS NUMERIC)) FILTER (WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status IN ('sent','paid'))), 0) AS total_amount
          FROM jobs j WHERE j.id = ANY(${idList}::int[]) AND j.company_id = ${companyId}
        `);
        const r = (pf as any).rows?.[0] ?? {};
        return res.json({ to_invoice: parseInt(r.to_invoice) || 0, already_invoiced: parseInt(r.already_invoiced) || 0, total_amount: parseFloat(r.total_amount) || 0 });
      }
      default: return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("POST /jobs/v2/bulk error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Saved Views CRUD ─────────────────────────────────────────────────────────

router.get("/v2/views", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    const result = await db.execute(sql`
      SELECT * FROM user_saved_views
      WHERE user_id = ${userId} AND company_id = ${companyId} AND page = 'jobs'
      ORDER BY is_default DESC, name ASC
    `);
    return res.json((result as any).rows ?? []);
  } catch (err) {
    console.error("GET /jobs/v2/views error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/v2/views", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    const { name, filter_json, column_config_json } = req.body;
    const result = await db.execute(sql`
      INSERT INTO user_saved_views (user_id, company_id, page, name, filter_json, column_config_json)
      VALUES (${userId}, ${companyId}, 'jobs', ${String(name).slice(0, 100)}, ${JSON.stringify(filter_json)}, ${JSON.stringify(column_config_json)})
      RETURNING *
    `);
    return res.status(201).json(((result as any).rows ?? [])[0]);
  } catch (err) {
    console.error("POST /jobs/v2/views error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/v2/views/:viewId", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const viewId = parseInt(req.params.viewId);
    if (isNaN(viewId)) return res.status(400).json({ error: "invalid viewId" });
    const { name, filter_json, column_config_json, is_default } = req.body;
    if (is_default) {
      await db.execute(sql`UPDATE user_saved_views SET is_default = false WHERE user_id = ${userId} AND page = 'jobs'`);
    }
    const result = await db.execute(sql`
      UPDATE user_saved_views
      SET name = COALESCE(${name ?? null}, name),
          filter_json = COALESCE(${filter_json ? JSON.stringify(filter_json) : null}, filter_json),
          column_config_json = COALESCE(${column_config_json ? JSON.stringify(column_config_json) : null}, column_config_json),
          is_default = COALESCE(${is_default ?? null}, is_default),
          updated_at = NOW()
      WHERE id = ${viewId} AND user_id = ${userId}
      RETURNING *
    `);
    return res.json(((result as any).rows ?? [])[0]);
  } catch (err) {
    console.error("PUT /jobs/v2/views/:viewId error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/v2/views/:viewId", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const viewId = parseInt(req.params.viewId);
    if (isNaN(viewId)) return res.status(400).json({ error: "invalid viewId" });
    await db.execute(sql`DELETE FROM user_saved_views WHERE id = ${viewId} AND user_id = ${userId}`);
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /jobs/v2/views/:viewId error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Column Preferences ───────────────────────────────────────────────────────

router.get("/v2/columns", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    const result = await db.execute(sql`
      SELECT * FROM user_column_preferences
      WHERE user_id = ${userId} AND company_id = ${companyId} AND page = 'jobs'
      ORDER BY sort_order ASC
    `);
    return res.json((result as any).rows ?? []);
  } catch (err) {
    console.error("GET /jobs/v2/columns error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/v2/columns", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    const columns: Array<{ column_key: string; visible: boolean; sort_order: number }> = req.body;
    if (!Array.isArray(columns)) return res.status(400).json({ error: "array required" });
    for (const col of columns) {
      await db.execute(sql`
        INSERT INTO user_column_preferences (user_id, company_id, page, column_key, visible, sort_order)
        VALUES (${userId}, ${companyId}, 'jobs', ${String(col.column_key).slice(0, 50)}, ${!!col.visible}, ${parseInt(String(col.sort_order)) || 0})
        ON CONFLICT (user_id, page, column_key)
        DO UPDATE SET visible = EXCLUDED.visible, sort_order = EXCLUDED.sort_order
      `);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("PUT /jobs/v2/columns error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Export ────────────────────────────────────────────────────────────────────

router.get("/v2/export", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const format = (req.query.format as string) || "csv";
    const where = buildJobWhereClause(req.query, companyId);
    const result = await db.execute(sql`
      SELECT
        j.id, concat(c.first_name, ' ', c.last_name) AS client_name,
        c.address AS client_address, c.city AS client_city,
        concat(u.first_name, ' ', u.last_name) AS tech_name,
        j.scheduled_date, j.scheduled_time, j.service_type, j.status,
        j.base_fee, j.frequency, j.flagged,
        b.name AS branch_name, sz.name AS zone_name, c.referral_source,
        CASE WHEN j.charge_succeeded_at IS NOT NULL THEN 'paid'
             WHEN j.charge_failed_at IS NOT NULL THEN 'failed'
             ELSE 'unpaid' END AS payment_status
      ${JOBS_V2_FROM} WHERE ${where}
      ORDER BY j.scheduled_date DESC, j.id DESC
      LIMIT 10000
    `);

    const rows = (result as any).rows ?? [];
    if (format === "csv") {
      const headers = ["ID","Client","Address","City","Technician","Date","Time","Service","Status","Amount","Frequency","Flagged","Branch","Zone","Source","Payment Status"];
      const csvRows = rows.map((r: any) => [
        r.id, `"${(r.client_name || "").replace(/"/g, '""')}"`,
        `"${(r.client_address || "").replace(/"/g, '""')}"`,
        `"${(r.client_city || "").replace(/"/g, '""')}"`,
        `"${(r.tech_name || "Unassigned").replace(/"/g, '""')}"`,
        r.scheduled_date, r.scheduled_time || "",
        r.service_type, r.status, r.base_fee || "0",
        r.frequency, r.flagged ? "Yes" : "No",
        r.branch_name || "", r.zone_name || "",
        r.referral_source || "", r.payment_status,
      ].join(","));
      const csv = [headers.join(","), ...csvRows].join("\n");
      const today = new Date().toISOString().split("T")[0];
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=qleno_jobs_phes_${today}.csv`);
      return res.send(csv);
    }
    return res.json(rows);
  } catch (err) {
    console.error("GET /jobs/v2/export error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
