import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, usersTable, jobPhotosTable, timeclockTable, invoicesTable, scorecardsTable, serviceZonesTable, serviceZoneEmployeesTable, companiesTable, accountsTable, accountRateCardsTable, accountPropertiesTable, paymentsTable, recurringSchedulesTable } from "@workspace/db/schema";
import { eq, and, gte, lte, count, desc, sql, notExists, inArray, isNotNull } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { generateJobCompletionPdf } from "../lib/generate-job-pdf.js";
import { geocodeAddress } from "../lib/geocode.js";
import { resolveZoneForZip } from "./zones.js";
import { sendNotification, labelServiceType } from "../services/notificationService.js";

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
    const todayStr = new Date().toISOString().slice(0, 10);

    const rows = await db.execute(sql`
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

    // [AI.7.1] Preload data the edit-job modal needs so it can hydrate
    // existing add-ons (selectedAddons keyed by pricing_addon_id),
    // days_of_week (custom-day picker), hourly_rate, recurring_schedule_id,
    // and the schedule's parking_fee_* config. Without this the modal
    // initialized selectedAddons=empty and saved an empty add_ons array,
    // which caused the server to DELETE existing parking-fee rows on save
    // — i.e. "I hit save and parking disappeared" / "none of the changes
    // take place" reproduces. See edit-job-modal.tsx initial-load useEffect.
    const jobMetaRows = await db.execute(sql`
      SELECT recurring_schedule_id, hourly_rate, days_of_week, account_id
      FROM jobs WHERE id = ${jobId} LIMIT 1
    `);
    const jobMeta = (jobMetaRows.rows[0] as any) ?? {};

    const existingAddOnsRows = await db.execute(sql`
      SELECT jao.pricing_addon_id, jao.add_on_id, jao.quantity, jao.unit_price, jao.subtotal,
             COALESCE(pa.name, ao.name) AS name
      FROM job_add_ons jao
      LEFT JOIN pricing_addons pa ON pa.id = jao.pricing_addon_id
      LEFT JOIN add_ons ao ON ao.id = jao.add_on_id
      WHERE jao.job_id = ${jobId}
    `);

    let recurringSchedule: any = null;
    if (jobMeta.recurring_schedule_id != null) {
      const rs = await db.execute(sql`
        SELECT id, frequency, day_of_week, days_of_week, custom_frequency_weeks,
               parking_fee_enabled, parking_fee_amount, parking_fee_days,
               commercial_hourly_rate
        FROM recurring_schedules WHERE id = ${jobMeta.recurring_schedule_id} LIMIT 1
      `);
      recurringSchedule = (rs.rows[0] as any) ?? null;
    }

    return res.json({
      ...job[0],
      recurring_schedule_id: jobMeta.recurring_schedule_id ?? null,
      hourly_rate: jobMeta.hourly_rate ?? null,
      days_of_week: jobMeta.days_of_week ?? null,
      account_id: jobMeta.account_id ?? null,
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
      existing_add_ons: existingAddOnsRows.rows.map((r: any) => ({
        pricing_addon_id: r.pricing_addon_id != null ? Number(r.pricing_addon_id) : null,
        add_on_id: r.add_on_id != null ? Number(r.add_on_id) : null,
        quantity: r.quantity != null ? Number(r.quantity) : 1,
        unit_price: r.unit_price != null ? Number(r.unit_price) : 0,
        subtotal: r.subtotal != null ? Number(r.subtotal) : 0,
        name: r.name ?? "",
      })),
      recurring_schedule: recurringSchedule
        ? {
            id: Number(recurringSchedule.id),
            frequency: recurringSchedule.frequency,
            day_of_week: recurringSchedule.day_of_week,
            days_of_week: recurringSchedule.days_of_week,
            custom_frequency_weeks: recurringSchedule.custom_frequency_weeks,
            parking_fee_enabled: !!recurringSchedule.parking_fee_enabled,
            parking_fee_amount: recurringSchedule.parking_fee_amount != null
              ? Number(recurringSchedule.parking_fee_amount) : null,
            parking_fee_days: recurringSchedule.parking_fee_days,
            commercial_hourly_rate: recurringSchedule.commercial_hourly_rate != null
              ? Number(recurringSchedule.commercial_hourly_rate) : null,
          }
        : null,
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

// [AG] PATCH /api/jobs/:id — focused job edit modal endpoint.
//
// Distinct from PUT (above) which is bare-bones and used by drag-and-drop /
// quick reschedule flows. This handler:
//   - Diffs each editable field and writes per-field rows into job_audit_log
//   - Honors a cascade flag ('this_job' | 'this_and_future') for recurring jobs
//   - Blocks edits to date/time/team when a tech is currently clocked in
//   - Persists multi-tech assignments via job_technicians (replaces existing)
//   - Persists add-ons via job_add_ons (replaces existing) with pricing_addon_id
//   - Trusts the client-computed base_fee; client owns manual_rate_override flag
//
// 409 Conflict when status in (complete, cancelled) OR locked_at is non-null.
router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: "Invalid job id" });

    const {
      service_type,
      frequency,
      scheduled_date,
      scheduled_time,
      allowed_hours,
      base_fee,
      hourly_rate,            // [AH] commercial per-visit rate override
      manual_rate_override,
      add_ons,
      team_user_ids,
      instructions,
      cascade_scope,
      days_of_week,           // [AI] multi-day pattern (int array 0..6)
      // [AI.7.1] Parking fee schedule-level cascade. When the user toggles
      // parking ON in the modal and picks "this and future", these flow
      // onto recurring_schedules so the engine stamps parking on every
      // matching future occurrence. parking_fee_days defaults to the
      // schedule's days_of_week (the modal pre-selects them) but can be
      // expanded to all 7 days if the operator wants parking on every
      // future job regardless of which weekdays the schedule visits.
      parking_fee_enabled,
      parking_fee_amount,
      parking_fee_days,
    } = req.body ?? {};

    // [PR / 2026-04-30] Cascade dry-run mode. Counters-only for v1
    // (Sal Q3.1 = a). When dry_run=true, the route runs the entire
    // cascade transaction as normal — accumulating in-tx counters
    // (future_jobs_updated/deleted/inserted/skipped, schedule_created
    // bool) — then ROLLS BACK at the end of the tx via a sentinel
    // throw. The outer handler catches the sentinel and returns the
    // counters. Production state stays untouched.
    //
    // The post-commit fan-out (generateJobsFromSchedule for the
    // create_recurring path) is SKIPPED entirely under dry_run — it
    // runs outside the tx and would persist real INSERTs that
    // rollback can't reverse. For v1 we omit fan-out simulation; the
    // operator can re-run without dry_run to see the real fan-out
    // count. v2 if v1 proves insufficient.
    //
    // Backend dry-run is always live (any JWT can hit
    // PATCH ?dry_run=true). Frontend "Preview changes" button is
    // gated behind CASCADE_PREVIEW_ENABLED via /api/config/feature-
    // flags (Sal Q3.4).
    const dry_run = req.body?.dry_run === true;

    // [AI] Validate day-pattern exclusivity. Only daily/weekdays/custom_days
    // populate days_of_week; weekly/biweekly/every_3_weeks/monthly use
    // day_of_week (the schedule column) and days_of_week stays null. The
    // engine warns on dual-population but the modal/PATCH path enforces it.
    const isMultiDayFreq = frequency === "daily" || frequency === "weekdays" || frequency === "custom_days";
    if (frequency !== undefined && isMultiDayFreq && Array.isArray(days_of_week)) {
      // custom_days requires ≥1 entry; daily/weekdays ignore the array contents
      if (frequency === "custom_days" && days_of_week.length === 0) {
        return res.status(400).json({ error: "custom_days requires at least one day" });
      }
      const bad = days_of_week.find(n => typeof n !== "number" || n < 0 || n > 6);
      if (bad !== undefined) {
        return res.status(400).json({ error: "days_of_week values must be integers 0..6" });
      }
    }
    if (frequency !== undefined && !isMultiDayFreq && Array.isArray(days_of_week) && days_of_week.length > 0) {
      return res.status(400).json({
        error: "days_of_week is only valid for daily/weekdays/custom_days frequencies",
      });
    }

    // [cascade-scope 2026-04-29] Five valid scopes now:
    //   this_job          — write to this job + job_add_ons (default)
    //   this_and_future   — schedule template + future occurrences
    //   all               — full series including past (warn if paid)
    //   remove_this       — same write path as this_job; signals operator
    //                       intent to remove a schedule-default add-on
    //                       from this occurrence only (no schedule edit).
    //   create_recurring  — [recurring-on-save 2026-04-30] convert a one-off
    //                       job to the first occurrence of a new recurring
    //                       schedule. Route creates a recurring_schedules
    //                       row anchored to this job's scheduled_date,
    //                       links jobs.recurring_schedule_id, copies
    //                       job_add_ons / job_technicians onto the schedule,
    //                       then fans out 60 days forward via
    //                       generateJobsFromSchedule. Rejects with 409 if
    //                       the customer already has an active schedule.
    const VALID_CASCADE = ["this_job", "this_and_future", "all", "remove_this", "create_recurring"] as const;
    if (!VALID_CASCADE.includes(cascade_scope)) {
      return res.status(400).json({
        error: `cascade_scope must be one of: ${VALID_CASCADE.join(", ")}`,
      });
    }

    // ── Pull current job + actor identity ──────────────────────────────────
    const jobRows = await db.execute(sql`
      SELECT id, company_id, recurring_schedule_id, status, locked_at,
             service_type, frequency, scheduled_date, scheduled_time,
             allowed_hours, base_fee, hourly_rate, manual_rate_override, notes,
             assigned_user_id, client_id, billed_amount,
             charge_succeeded_at, charge_failed_at
      FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });
    const before = jobRows.rows[0] as Record<string, unknown>;

    // [edit-decouple 2026-04-29] Per-field lock matrix replaces the prior
    // blanket "completed/cancelled/locked = no edits". Operators need to
    // fix tech assignments and clock-in timestamps after the fact for
    // payroll, and surfacing edits via the audit log is more useful than
    // hiding the door entirely.
    //
    //   Free fields:        notes, address, scheduled_date/time,
    //                       allowed_hours, instructions, manual_rate_override,
    //                       team_user_ids, add_ons, parking_*, days_of_week
    //   Hard-locked fields on completed: service_type, frequency
    //                       (changing these changes commission routing /
    //                        recurrence semantics — use void-and-rebook)
    //   Warn-then-unlock:   base_fee on completed (warn if invoiced),
    //                       hourly_rate on completed
    //   Hard-locked when paid: base_fee, hourly_rate
    //                       (charge_succeeded_at IS NOT NULL means money
    //                        moved — refund flow, not edit)
    //   Always free:        team_user_ids, instructions, address fields,
    //                       notes, add_ons (audit-trailed in all cases)
    //
    // Caller signals "I see the warning, proceed" via `force_unlock: true`
    // in the body. Without it, warn-locked field edits return 409.
    const force_unlock = req.body?.force_unlock === true;
    const isCompleted = before.status === "complete";
    const isCancelled = before.status === "cancelled";
    const isPaid = before.charge_succeeded_at != null;

    if (isCancelled) {
      // Cancelled jobs stay locked. Restore-from-cancelled is a different
      // flow (uncancel route, not editor).
      return res.status(409).json({
        error: "Cancelled job",
        message: "Cancelled jobs cannot be edited. Restore the job first.",
      });
    }

    // [PR / 2026-04-30] Cascade-scope-aware completed-job lock.
    //
    // The legacy hard-lock returned 409 when an operator tried to
    // change frequency / service_type / price on a completed job —
    // regardless of cascade_scope. That conflated two intents:
    //   (1) "edit this completed job's fields"   (cascade_scope=this_job)
    //   (2) "edit the schedule TEMPLATE via this completed job as
    //        the anchor; future jobs should inherit, this one stays
    //        as-is in the audit trail" (cascade_scope=this_and_future)
    //
    // (2) is a real workflow — most common trigger: client completes
    // Monday, calls Tuesday morning to change the schedule going
    // forward. Operator opens Monday (the only edit surface they have
    // for this client's schedule), changes frequency, picks
    // 'this and all future'. Pre-fix this 409'd. Post-fix the route
    // strips the locked fields from the anchor's `setParts` UPDATE
    // (audit record stays clean) but proceeds with the schedule-
    // template UPDATE + future-jobs cascade.
    const cascadesToTemplate = cascade_scope === "this_and_future" || cascade_scope === "all";
    const skipAnchorLockedFields = isCompleted && cascadesToTemplate;

    if (isCompleted && !cascadesToTemplate) {
      // Editing only this completed job — hard-lock service_type /
      // frequency. Changing them rewrites commission routing and
      // recurrence semantics on already-billed work. Operator must
      // void-and-rebook for those.
      if (service_type !== undefined && service_type !== before.service_type) {
        return res.status(409).json({
          error: "Field locked",
          field: "service_type",
          message: "Service type can't change on a completed job. Cancel and re-book if the wrong type was billed, or use 'This and all future' to update the schedule template.",
        });
      }
      if (frequency !== undefined && frequency !== before.frequency) {
        return res.status(409).json({
          error: "Field locked",
          field: "frequency",
          message: "Frequency can't change on a completed job. Cancel and re-book if the recurrence was wrong, or use 'This and all future' to update the schedule template.",
        });
      }
    }
    if (isCompleted) {
      // Warn-locked: pricing on completed jobs. Hard-locked when paid.
      // For cascadesToTemplate: skip the warn/hard-lock entirely. The
      // price change applies to the schedule template + future jobs;
      // the anchor's `jobs.base_fee` / `jobs.hourly_rate` stay frozen
      // (stripped from setParts below).
      const priceChanged =
        (base_fee !== undefined && String(base_fee) !== String(before.base_fee ?? "")) ||
        (hourly_rate !== undefined && String(hourly_rate ?? "") !== String(before.hourly_rate ?? ""));
      if (priceChanged && !cascadesToTemplate) {
        if (isPaid) {
          return res.status(409).json({
            error: "Field locked",
            field: "base_fee",
            message: "Job is already paid. Issue a refund or surcharge instead of editing the price.",
          });
        }
        if (!force_unlock) {
          return res.status(409).json({
            error: "Confirmation required",
            field: "base_fee",
            warn: true,
            message: "This job is completed. Changing the price may require manual invoice adjustment. Re-submit with force_unlock=true to confirm.",
          });
        }
      }
    }

    if (cascade_scope === "this_and_future" && before.recurring_schedule_id == null) {
      return res.status(400).json({
        error: "Cannot cascade",
        message: "This job is not part of a recurring schedule. Use cascade_scope='this_job'.",
      });
    }
    if (cascade_scope === "all" && before.recurring_schedule_id == null) {
      return res.status(400).json({
        error: "Cannot cascade",
        message: "This job is not part of a recurring schedule. Use cascade_scope='this_job'.",
      });
    }
    if (cascade_scope === "remove_this" && before.recurring_schedule_id == null) {
      // remove_this only makes sense on a recurring job — it's the
      // operator's way of saying "skip the schedule's default add-on
      // for this occurrence." On a one-off, this_job is equivalent.
      return res.status(400).json({
        error: "Cannot scope",
        message: "remove_this only applies to recurring jobs. Use this_job for one-offs.",
      });
    }

    // [recurring-on-save 2026-04-30] create_recurring scope: convert a
    // one-off job into the first occurrence of a brand-new recurring
    // schedule. Validation: target frequency must be a recurring value
    // (not on_demand / blank), the current job must NOT already have a
    // schedule (use this_and_future for those), and the customer must
    // NOT already have an active schedule on file (409). The actual
    // schedule INSERT + job link + add-on/tech copy + 60d fan-out
    // happen in the transaction block below.
    const RECURRING_FREQS = new Set([
      "weekly", "biweekly", "every_3_weeks", "monthly", "daily", "weekdays", "custom_days",
    ]);
    const wantsCreateRecurring = cascade_scope === "create_recurring";
    const effectiveFrequency = frequency !== undefined ? frequency : (before.frequency as string | null);
    if (wantsCreateRecurring) {
      if (before.recurring_schedule_id != null) {
        return res.status(400).json({
          error: "Cannot create",
          message:
            "This job is already part of a recurring schedule. Use cascade_scope='this_and_future' to update the schedule template instead.",
        });
      }
      if (!effectiveFrequency || !RECURRING_FREQS.has(String(effectiveFrequency))) {
        return res.status(400).json({
          error: "Invalid frequency for create_recurring",
          message:
            "create_recurring requires frequency to be one of: weekly, biweekly, every_3_weeks, monthly, daily, weekdays, custom_days.",
        });
      }
      // Active-schedule conflict — 409 with the conflicting row's id +
      // frequency in the message so the operator knows what's blocking.
      const clientIdNum = Number(before.client_id);
      const existing = await db.execute(sql`
        SELECT id, frequency, day_of_week, days_of_week
          FROM recurring_schedules
         WHERE customer_id = ${clientIdNum}
           AND company_id = ${companyId}
           AND is_active = true
         ORDER BY id
         LIMIT 1
      `);
      if (existing.rows.length) {
        const r = existing.rows[0] as { id: number; frequency: string; day_of_week: string | null; days_of_week: number[] | null };
        const freqLabel = String(r.frequency);
        const dayLabel = r.day_of_week
          ? ` on ${String(r.day_of_week)}s`
          : (Array.isArray(r.days_of_week) && r.days_of_week.length > 0
              ? ` on weekdays [${r.days_of_week.join(",")}]`
              : "");
        return res.status(409).json({
          error: "Conflicting schedule",
          existing_schedule_id: Number(r.id),
          message:
            `This client already has an active recurring schedule (id ${r.id}, ${freqLabel}${dayLabel}). ` +
            `Update or end that schedule before creating a new one.`,
        });
      }
    }
    // [recurring-on-save 2026-04-30] Legacy bad-case guard. If the
    // operator (or a programmatic caller) sends cascade_scope='this_job'
    // with a recurring frequency on a one-off, we'd previously write
    // jobs.frequency='weekdays' to the single row and silently drop
    // days_of_week (no schedule to write to, no fan-out). That's how
    // Jaira ended up with a Monday job tagged 'weekdays' and no Tue–Fri.
    // Reject explicitly and direct callers to the right path.
    if (
      cascade_scope === "this_job"
      && frequency !== undefined
      && RECURRING_FREQS.has(String(frequency))
      && before.recurring_schedule_id == null
    ) {
      return res.status(400).json({
        error: "Frequency requires a recurring schedule",
        message:
          "frequency was set to a recurring value on a one-off job. Use cascade_scope='create_recurring' to create a schedule and fan out, or revert frequency to 'on_demand'.",
      });
    }

    // [cascade-scope 2026-04-29] cascade='all' warns when any past
    // occurrence in the series has been paid. Operator must confirm
    // via force_unlock=true to proceed (same flag used by the
    // per-field warn-then-unlock above).
    if (cascade_scope === "all" && before.recurring_schedule_id != null) {
      const paidPast = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM jobs
         WHERE recurring_schedule_id = ${Number(before.recurring_schedule_id)}
           AND company_id = ${companyId}
           AND charge_succeeded_at IS NOT NULL
           AND scheduled_date < ${String(before.scheduled_date)}
      `);
      const n = Number((paidPast.rows[0] as any)?.n ?? 0);
      if (n > 0 && !force_unlock) {
        return res.status(409).json({
          error: "Confirmation required",
          warn: true,
          paid_past_count: n,
          message: `This recurring series has ${n} past paid occurrence${n === 1 ? "" : "s"}. Backfilling 'all' will leave those paid jobs untouched but template + past unpaid will update. Re-submit with force_unlock=true to confirm.`,
        });
      }
    }

    // ── In-progress guard: open timeclock blocks date/time/team edits ──────
    const tcRows = await db.execute(sql`
      SELECT user_id FROM timeclock
      WHERE job_id = ${jobId} AND clock_out_at IS NULL
      LIMIT 1
    `);
    const isClockedIn = tcRows.rows.length > 0;
    if (isClockedIn) {
      const blockedFields: string[] = [];
      if (scheduled_date !== undefined && scheduled_date !== before.scheduled_date) blockedFields.push("scheduled_date");
      if (scheduled_time !== undefined && scheduled_time !== before.scheduled_time) blockedFields.push("scheduled_time");
      if (team_user_ids !== undefined) blockedFields.push("team_user_ids");
      if (blockedFields.length) {
        return res.status(409).json({
          error: "Tech clocked in",
          message: "A technician is currently clocked in. Stop the timer before changing date, time, or team.",
          blocked_fields: blockedFields,
        });
      }
    }

    // ── Lookup actor (user_name + email at time of edit, for audit snapshot) ─
    const userRows = await db.execute(sql`
      SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1
    `);
    const actor = (userRows.rows[0] as Record<string, unknown>) ?? {};
    const actorName = `${actor.first_name ?? ""} ${actor.last_name ?? ""}`.trim() || "Unknown";
    const actorEmail = String(actor.email ?? "");

    // ── Build per-field change set (only fields actually present in body) ──
    type FieldName =
      | "service_type" | "frequency" | "scheduled_date" | "scheduled_time"
      | "allowed_hours" | "base_fee" | "hourly_rate" | "manual_rate_override"
      | "instructions" | "add_ons" | "team_user_ids";
    const changes: Array<{ field: FieldName; old: unknown; next: unknown }> = [];
    const pushChange = (field: FieldName, next: unknown, prev: unknown) => {
      const norm = (v: unknown) => v === null || v === undefined ? null : v;
      if (JSON.stringify(norm(next)) !== JSON.stringify(norm(prev))) {
        changes.push({ field, old: prev ?? null, next: next ?? null });
      }
    };

    if (service_type !== undefined) pushChange("service_type", service_type, before.service_type);
    if (frequency !== undefined) pushChange("frequency", frequency, before.frequency);
    if (scheduled_date !== undefined) pushChange("scheduled_date", scheduled_date, before.scheduled_date);
    if (scheduled_time !== undefined) pushChange("scheduled_time", scheduled_time, before.scheduled_time);
    if (allowed_hours !== undefined) pushChange("allowed_hours", String(allowed_hours), String(before.allowed_hours ?? ""));
    if (base_fee !== undefined) pushChange("base_fee", String(base_fee), String(before.base_fee ?? ""));
    if (hourly_rate !== undefined) pushChange("hourly_rate", String(hourly_rate), String(before.hourly_rate ?? ""));
    if (manual_rate_override !== undefined) pushChange("manual_rate_override", !!manual_rate_override, !!before.manual_rate_override);
    if (instructions !== undefined) pushChange("instructions", instructions, before.notes);

    // For add_ons + team_user_ids we always emit an audit row when payload is present,
    // since per-row diff is verbose; the JSON payload carries the full new value.
    let addOnsProvided = false;
    let teamProvided = false;
    if (Array.isArray(add_ons)) {
      addOnsProvided = true;
      pushChange("add_ons", add_ons, "[unknown — see job_add_ons history]");
    }
    if (Array.isArray(team_user_ids)) {
      if (team_user_ids.length === 0) {
        return res.status(400).json({ error: "team_user_ids must include at least one user" });
      }
      teamProvided = true;
      pushChange("team_user_ids", team_user_ids, "[unknown — see job_technicians history]");
    }

    if (changes.length === 0) {
      return res.status(200).json({ ok: true, changed: false, message: "No changes detected" });
    }

    // ── manual_rate_override semantics ─────────────────────────────────────
    // Honor explicit flag from client. If client omitted it but sent a base_fee,
    // assume manual override. If client changed scope/freq/addons/hours but sent
    // no base_fee, clear the override flag (caller has accepted recalc-driven price).
    let nextManualOverride: boolean | undefined = undefined;
    if (manual_rate_override !== undefined) {
      nextManualOverride = !!manual_rate_override;
    } else if (base_fee !== undefined) {
      nextManualOverride = true;
    } else if (
      service_type !== undefined || frequency !== undefined ||
      addOnsProvided || allowed_hours !== undefined
    ) {
      nextManualOverride = false;
    }

    // [recurring-on-save 2026-04-30] Out-of-transaction handle for the
    // create_recurring path. The schedule INSERT happens inside the
    // transaction; the 60-day fan-out runs after commit (calls into
    // generateJobsFromSchedule which has its own dedupe + best-effort
    // semantics — must not roll back the parent edit if it hiccups).
    let createdScheduleId: number | null = null;

    // [PR / 2026-04-30] Sentinel for the dry-run rollback path. Defined
    // here so it's in scope for both the throw inside the tx callback
    // and the catch around `await db.transaction(...)` below.
    class DryRunRollback extends Error {
      constructor(public summary: Record<string, unknown>) {
        super("dry_run rollback");
      }
    }
    let dryRunSummary: Record<string, unknown> | null = null;

    // ── Apply changes in a transaction ─────────────────────────────────────
    await db.transaction(async (tx) => {
      // Update the jobs row itself.
      const setParts: any = {};
      if (service_type !== undefined) setParts.service_type = service_type;
      if (frequency !== undefined) setParts.frequency = frequency;
      if (scheduled_date !== undefined) setParts.scheduled_date = scheduled_date;
      if (scheduled_time !== undefined) setParts.scheduled_time = scheduled_time;
      if (allowed_hours !== undefined) setParts.allowed_hours = String(allowed_hours);
      if (base_fee !== undefined) setParts.base_fee = String(base_fee);
      if (hourly_rate !== undefined) setParts.hourly_rate = hourly_rate === null ? null : String(hourly_rate);
      if (nextManualOverride !== undefined) setParts.manual_rate_override = nextManualOverride;
      if (instructions !== undefined) setParts.notes = instructions;

      // [PR / 2026-04-30] When the anchor is a completed job AND the
      // operator picked a cascade scope that propagates to the
      // schedule template + future jobs, strip the lock-protected
      // fields from setParts. The schedule UPDATE + future-jobs
      // cascade further down apply the changes to the right rows;
      // the anchor's `jobs` row keeps its original frequency /
      // service_type / base_fee / hourly_rate as part of the
      // completed-work audit trail.
      const anchorSkippedFields: string[] = [];
      if (skipAnchorLockedFields) {
        if ("frequency" in setParts) { delete setParts.frequency; anchorSkippedFields.push("frequency"); }
        if ("service_type" in setParts) { delete setParts.service_type; anchorSkippedFields.push("service_type"); }
        if ("base_fee" in setParts) { delete setParts.base_fee; anchorSkippedFields.push("base_fee"); }
        if ("hourly_rate" in setParts) { delete setParts.hourly_rate; anchorSkippedFields.push("hourly_rate"); }
      }
      // Stash for the response (read after commit via closure).
      (req as any)._anchorSkippedFields = anchorSkippedFields;

      // [recurring-on-save 2026-04-30] create_recurring branch — INSERT
      // the new recurring_schedules row, anchored to the current job's
      // (possibly-just-edited) scheduled_date. Carryover fields come
      // from request payload + the pre-edit job row. The freshly-minted
      // scheduleId gets stamped onto setParts so the existing UPDATE
      // below links the current job in the same transaction. Add-on +
      // technician writes happen further down after their job-side
      // counterparts.
      if (wantsCreateRecurring) {
        const effectiveDate = scheduled_date !== undefined
          ? String(scheduled_date)
          : String(before.scheduled_date);
        const effectiveTime = scheduled_time !== undefined
          ? String(scheduled_time)
          : (before.scheduled_time as string | null);
        const freqStr = String(effectiveFrequency);
        // jobs.frequency → recurring_schedules.frequency. Same map used
        // by the this_and_future cascade further down (kept here to
        // avoid coupling — diverging is a real risk if both edit the
        // map without the other). Audit periodically.
        const freqMap: Record<string, { f: string; weeks: number | null }> = {
          weekly:        { f: "weekly",        weeks: 1 },
          biweekly:      { f: "biweekly",      weeks: 2 },
          every_3_weeks: { f: "every_3_weeks", weeks: null },
          monthly:       { f: "monthly",       weeks: 4 },
          daily:         { f: "daily",         weeks: null },
          weekdays:      { f: "weekdays",      weeks: null },
          custom_days:   { f: "custom_days",   weeks: null },
        };
        const fmap = freqMap[freqStr] ?? { f: "custom", weeks: null };
        // Multi-day frequencies use days_of_week (int[] 0..6); single-
        // day uses day_of_week (enum string). Mutually exclusive per
        // the schema invariant. For weekly/biweekly/etc. we derive the
        // day-of-week from effectiveDate so the schedule's anchor day
        // matches the current job. For daily we materialize [0..6];
        // weekdays = [1..5]; custom_days uses what the modal sent.
        const isMulti = freqStr === "daily" || freqStr === "weekdays" || freqStr === "custom_days";
        let scheduleDow: string | null = null;
        let scheduleDays: number[] | null = null;
        if (isMulti) {
          scheduleDays =
            freqStr === "daily" ? [0,1,2,3,4,5,6]
            : freqStr === "weekdays" ? [1,2,3,4,5]
            : (Array.isArray(days_of_week) ? days_of_week : []);
        } else {
          const DOW_ENUM = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
          // parseDate('YYYY-MM-DD') with no timezone arg lands UTC; we
          // want the local-day interpretation (matches how scheduled_date
          // is stored as a DATE, not TIMESTAMPTZ). Append T00:00 then
          // read getDay() — Date math stays in local TZ, getDay() uses
          // local. KNOWN_BUGS.md #4 (recurring anchor on Monday bug)
          // is the inverse case (UTC parse landing Monday for what
          // should be Sunday); same mitigation applies.
          const d = new Date(`${effectiveDate}T00:00:00`);
          scheduleDow = DOW_ENUM[d.getDay()];
        }
        // assigned_employee_id mirrors the primary tech: if the modal
        // sent a fresh team list, take the first (primary) user; else
        // keep whoever's currently on the job (jobs.assigned_user_id).
        const primaryUid = teamProvided && Array.isArray(team_user_ids) && team_user_ids.length > 0
          ? Number(team_user_ids[0])
          : (before.assigned_user_id != null ? Number(before.assigned_user_id) : null);
        // duration_minutes: convert allowed_hours (the modal's primary
        // duration field) when present, else inherit from before.
        const effectiveAllowedHours = allowed_hours !== undefined
          ? parseFloat(String(allowed_hours))
          : (before.allowed_hours != null ? parseFloat(String(before.allowed_hours)) : null);
        const durationMin = effectiveAllowedHours != null && Number.isFinite(effectiveAllowedHours)
          ? Math.round(effectiveAllowedHours * 60)
          : null;
        // service_type / base_fee / commercial_hourly_rate / parking_*
        // come from payload (preferred) with fallback to before.
        const effectiveServiceType = service_type !== undefined
          ? service_type
          : (before.service_type as string | null);
        const effectiveBaseFee = base_fee !== undefined
          ? String(base_fee)
          : (before.base_fee != null ? String(before.base_fee) : null);
        const effectiveHourlyRate = hourly_rate !== undefined
          ? (hourly_rate === null ? null : String(hourly_rate))
          : (before.hourly_rate != null ? String(before.hourly_rate) : null);
        const effectiveNotes = instructions !== undefined
          ? instructions
          : (before.notes as string | null);
        const effParkingEnabled = parking_fee_enabled !== undefined ? !!parking_fee_enabled : false;
        const effParkingAmount = parking_fee_amount !== undefined && parking_fee_amount !== null
          ? String(parking_fee_amount)
          : null;
        const effParkingDays = Array.isArray(parking_fee_days) && parking_fee_days.length > 0
          ? parking_fee_days
          : null;

        // [recurring-on-save 2026-04-30 / fix #25] Switched from raw
        // `sql` template to Drizzle ORM .insert().values().returning()
        // because the previous tag interpolated `${scheduleDays}` (a
        // JS array) by spreading each element as a separate scalar
        // bind — yielding `($5, $6, $7, $8, $9)::int[]` which is
        // invalid SQL and shifted every subsequent param off by N-1.
        // The ORM path uses the schema's column codecs (notably
        // integer().array() for days_of_week / parking_fee_days and
        // the pgEnum types for frequency / day_of_week) and binds
        // each value as exactly one parameter. Same pattern as
        // POST /api/recurring (routes/recurring.ts:54-66).
        const [insertedRow] = await tx
          .insert(recurringSchedulesTable)
          .values({
            company_id: companyId,
            customer_id: Number(before.client_id),
            frequency: fmap.f as any,
            day_of_week: scheduleDow as any,
            days_of_week: scheduleDays,
            custom_frequency_weeks: fmap.weeks,
            start_date: effectiveDate,
            end_date: null,
            scheduled_time: effectiveTime as any,
            assigned_employee_id: primaryUid,
            service_type: effectiveServiceType,
            duration_minutes: durationMin,
            base_fee: effectiveBaseFee,
            commercial_hourly_rate: effectiveHourlyRate,
            notes: effectiveNotes,
            instructions: effectiveNotes,
            is_active: true,
            parking_fee_enabled: effParkingEnabled,
            parking_fee_amount: effParkingAmount,
            parking_fee_days: effParkingDays,
          })
          .returning({ id: recurringSchedulesTable.id });
        createdScheduleId = Number(insertedRow.id);
        setParts.recurring_schedule_id = createdScheduleId;
      }

      if (Object.keys(setParts).length > 0) {
        await tx.update(jobsTable).set(setParts).where(and(
          eq(jobsTable.id, jobId),
          eq(jobsTable.company_id, companyId),
        ));
      }

      // Replace job_technicians if team_user_ids provided. First user = primary.
      if (teamProvided && Array.isArray(team_user_ids)) {
        await tx.execute(sql`DELETE FROM job_technicians WHERE job_id = ${jobId}`);
        for (let i = 0; i < team_user_ids.length; i++) {
          const uid = team_user_ids[i];
          const isPrimary = i === 0;
          await tx.execute(sql`
            INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
            VALUES (${jobId}, ${uid}, ${companyId}, ${isPrimary})
            ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
          `);
        }
        // Mirror the primary onto jobs.assigned_user_id so the dispatch grid
        // (which reads assigned_user_id, not job_technicians) shows the new
        // tech immediately. Fixes the Jaira-Estrada split-brain we saw.
        await tx.update(jobsTable).set({ assigned_user_id: team_user_ids[0] }).where(and(
          eq(jobsTable.id, jobId),
          eq(jobsTable.company_id, companyId),
        ));
      }

      // Replace job_add_ons if add_ons provided.
      //
      // [AI.6.3] FK fix. job_add_ons.add_on_id references add_ons.id (older
      // catalog table) and is NOT NULL. The modal historically wrote
      // add_on_id = pricing_addon_id which only worked when the IDs
      // happened to coincide via seeding. PHES's Parking Fee row in
      // pricing_addons does NOT have a matching add_ons.id, so the prior
      // INSERT threw a foreign-key violation and the whole save aborted.
      //
      // Resolution path: look up an add_ons row by company + name (case-
      // insensitive). If absent, INSERT one (mirroring the pricing_addon's
      // name + price). Use that row's real id as add_on_id.
      if (addOnsProvided && Array.isArray(add_ons)) {
        await tx.execute(sql`DELETE FROM job_add_ons WHERE job_id = ${jobId}`);
        for (const a of add_ons as Array<{ pricing_addon_id?: number; add_on_id?: number; qty?: number; unit_price?: number; subtotal?: number }>) {
          const pricingId = Number(a.pricing_addon_id ?? 0) || null;
          const qty = Number(a.qty ?? 1) || 1;
          const unitPrice = a.unit_price != null ? String(a.unit_price) : "0";
          const subtotal = a.subtotal != null ? String(a.subtotal) : "0";

          // Resolve a valid add_ons.id for the FK. Source-of-truth name
          // comes from pricing_addons via the supplied pricing_addon_id.
          let realAddOnId: number | null = null;
          if (pricingId) {
            const paRows = await tx.execute(sql`
              SELECT name FROM pricing_addons WHERE id = ${pricingId} LIMIT 1
            `);
            const paName = String((paRows.rows[0] as any)?.name ?? "").trim();
            if (paName) {
              const existing = await tx.execute(sql`
                SELECT id FROM add_ons
                WHERE company_id = ${companyId} AND LOWER(name) = LOWER(${paName})
                LIMIT 1
              `);
              if (existing.rows.length) {
                realAddOnId = Number((existing.rows[0] as any).id);
              } else {
                const created = await tx.execute(sql`
                  INSERT INTO add_ons (company_id, name, price, category, is_active)
                  VALUES (${companyId}, ${paName}, ${unitPrice}, 'other', true)
                  RETURNING id
                `);
                realAddOnId = Number((created.rows[0] as any).id);
              }
            }
          }
          // Last-resort fallback: caller passed an explicit add_on_id that
          // already exists in add_ons. Honor it if present.
          if (!realAddOnId && a.add_on_id) realAddOnId = Number(a.add_on_id);
          if (!realAddOnId) continue;

          await tx.execute(sql`
            INSERT INTO job_add_ons (job_id, add_on_id, quantity, unit_price, subtotal, pricing_addon_id)
            VALUES (${jobId}, ${realAddOnId}, ${qty}, ${unitPrice}, ${subtotal}, ${pricingId})
            ON CONFLICT (job_id, add_on_id) DO UPDATE
              SET quantity = EXCLUDED.quantity,
                  unit_price = EXCLUDED.unit_price,
                  subtotal = EXCLUDED.subtotal,
                  pricing_addon_id = EXCLUDED.pricing_addon_id
          `);
        }
      }

      // [recurring-on-save 2026-04-30] Seed the new schedule's
      // technician + add-on tables from the just-saved per-job state
      // so future engine-spawned jobs inherit the same crew + add-ons.
      // Mirrors the existing this_and_future cascade block below
      // (lines further down) which does the same for already-existing
      // schedules. team_user_ids fallback: if the modal didn't send
      // a fresh team list (teamProvided=false), seed from the current
      // job's assigned_user_id so the schedule still has an owner.
      if (wantsCreateRecurring && createdScheduleId != null) {
        const newSchedId = Number(createdScheduleId);
        const techList: number[] = teamProvided && Array.isArray(team_user_ids) && team_user_ids.length > 0
          ? team_user_ids.map((u: unknown) => Number(u))
          : (before.assigned_user_id != null ? [Number(before.assigned_user_id)] : []);
        for (let i = 0; i < techList.length; i++) {
          const uid = techList[i];
          const isPrimary = i === 0;
          await tx.execute(sql`
            INSERT INTO recurring_schedule_technicians (recurring_schedule_id, user_id, is_primary)
            VALUES (${newSchedId}, ${uid}, ${isPrimary})
            ON CONFLICT (recurring_schedule_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
          `);
        }
        if (addOnsProvided && Array.isArray(add_ons)) {
          for (const a of add_ons as Array<{ pricing_addon_id?: number; qty?: number }>) {
            const pricingId = Number(a.pricing_addon_id ?? 0);
            const qty = Number(a.qty ?? 1) || 1;
            if (!pricingId) continue;
            await tx.execute(sql`
              INSERT INTO recurring_schedule_add_ons (recurring_schedule_id, pricing_addon_id, qty)
              VALUES (${newSchedId}, ${pricingId}, ${qty})
            `);
          }
        }
      }

      // ── Cascade: this_and_future or all ──────────────────────────────────
      // [cascade-scope 2026-04-29] 'all' shares the schedule-template
      // update + cadence-pattern logic with 'this_and_future'; the only
      // semantic difference is the date filter for the future-jobs
      // cascade (no `> CURRENT_DATE` filter on 'all') and an explicit
      // skip of paid past occurrences. We treat them under one block
      // and branch on `cascadeAllScope` at the SQL level.
      let futureCount = 0;
      let futureClockedSkipped = 0;
      let futureDeleted = 0;     // [AI] Hybrid cascade: jobs whose date no longer matches new pattern
      let futureInserted = 0;    // [AI] Hybrid cascade: new dates the new pattern requires
      const cascadeAllScope = cascade_scope === "all";
      if ((cascade_scope === "this_and_future" || cascadeAllScope) && before.recurring_schedule_id != null) {
        const scheduleId = Number(before.recurring_schedule_id);

        // [AI] Detect day-pattern change so we know whether to run the AG
        // in-place UPDATE path or the AI hybrid (UPDATE matching + DELETE
        // non-matching + INSERT new).
        const isMultiDayNext = frequency === "daily" || frequency === "weekdays" || frequency === "custom_days";
        const wasMultiDayBefore = before.frequency === "daily" || before.frequency === "weekdays" || before.frequency === "custom_days";
        const dayPatternChanged =
          (frequency !== undefined && frequency !== before.frequency) ||
          (Array.isArray(days_of_week));

        // Update the parent recurring_schedules row with the cascadable fields.
        const rsSet: string[] = [];
        const rsVals: any[] = [];
        const push = (col: string, val: any) => { rsSet.push(col); rsVals.push(val); };
        if (service_type !== undefined) push("service_type", service_type);
        if (scheduled_time !== undefined) push("scheduled_time", scheduled_time);
        if (allowed_hours !== undefined) push("duration_minutes", Math.round(parseFloat(String(allowed_hours)) * 60));
        if (base_fee !== undefined) push("base_fee", String(base_fee));
        if (instructions !== undefined) push("instructions", instructions);
        if (nextManualOverride !== undefined) push("manual_rate_override", nextManualOverride);
        // [AH] Cascade commercial hourly rate to the schedule template so
        // engine-spawned future jobs inherit the rate.
        if (hourly_rate !== undefined) push("commercial_hourly_rate", hourly_rate === null ? null : String(hourly_rate));
        // [AI] Map jobs.frequency to recurring_schedules.frequency.
        // After the AI enum extensions, every_3_weeks/daily/weekdays/custom_days
        // now exist on recurring_frequency too — pass through directly.
        // 'on_demand' has no recurring equivalent → fall back to 'custom'.
        if (frequency !== undefined) {
          const map: Record<string, { f: string; weeks: number | null }> = {
            weekly:        { f: "weekly", weeks: 1 },
            biweekly:      { f: "biweekly", weeks: 2 },
            every_3_weeks: { f: "every_3_weeks", weeks: null },
            monthly:       { f: "monthly", weeks: 4 },
            daily:         { f: "daily", weeks: null },
            weekdays:      { f: "weekdays", weeks: null },
            custom_days:   { f: "custom_days", weeks: null },
            on_demand:     { f: "custom", weeks: null },
          };
          const m = map[String(frequency)] ?? { f: "custom", weeks: null };
          push("frequency", m.f);
          push("custom_frequency_weeks", m.weeks);
        }
        // [AI] Cascade days_of_week + clear day_of_week when switching to
        // multi-day. Inverse: clear days_of_week when switching back to
        // single-day to preserve the documented exclusivity invariant.
        if (frequency !== undefined) {
          if (isMultiDayNext) {
            // For 'daily' and 'weekdays' we materialize the implicit array onto
            // the row so the engine sees consistent storage; 'custom_days'
            // stores whatever the user picked.
            const arr =
              frequency === "daily" ? [0,1,2,3,4,5,6]
              : frequency === "weekdays" ? [1,2,3,4,5]
              : (Array.isArray(days_of_week) ? days_of_week : []);
            push("days_of_week", arr);
            push("day_of_week", null);
          } else {
            // Switching back to single-day — clear the multi-day array.
            push("days_of_week", null);
          }
        } else if (Array.isArray(days_of_week)) {
          // Frequency unchanged but days_of_week explicitly provided
          // (e.g., user added/removed a day on an existing custom_days schedule)
          push("days_of_week", days_of_week);
        }

        // [AI.7.1] Parking fee cascade. Persist parking_fee_enabled +
        // parking_fee_amount + parking_fee_days onto the schedule so the
        // engine applies parking to every future occurrence per the
        // operator's day selection. Null amount = use tenant default;
        // null/empty days = apply to all scheduled days.
        if (parking_fee_enabled !== undefined) {
          push("parking_fee_enabled", !!parking_fee_enabled);
        }
        if (parking_fee_amount !== undefined) {
          push("parking_fee_amount", parking_fee_amount === null ? null : String(parking_fee_amount));
        }
        if (parking_fee_days !== undefined) {
          push("parking_fee_days", Array.isArray(parking_fee_days) && parking_fee_days.length > 0 ? parking_fee_days : null);
        }

        if (rsSet.length > 0) {
          // Build a parameterised UPDATE … SET col = $n
          const setClauses = rsSet.map((c, i) => sql`${sql.identifier(c)} = ${rsVals[i]}`);
          const setSql = sql.join(setClauses, sql`, `);
          await tx.execute(sql`UPDATE recurring_schedules SET ${setSql} WHERE id = ${scheduleId} AND company_id = ${companyId}`);
          // [PR / 2026-04-30] Surface "schedule was touched" so the
          // response can render an honest summary ("Schedule updated.
          // 4 future jobs reflect new times.") rather than the
          // generic save-confirmation toast.
          (req as any)._scheduleUpdated = true;
        }

        // ── Future-jobs cascade: branch by whether day pattern changed ────
        const futureJobsSet: string[] = [];
        const futureJobsVals: any[] = [];
        const pushFj = (col: string, val: any) => { futureJobsSet.push(col); futureJobsVals.push(val); };
        if (service_type !== undefined) pushFj("service_type", service_type);
        if (frequency !== undefined) pushFj("frequency", frequency);
        if (scheduled_time !== undefined) pushFj("scheduled_time", scheduled_time);
        if (allowed_hours !== undefined) pushFj("allowed_hours", String(allowed_hours));
        if (base_fee !== undefined) pushFj("base_fee", String(base_fee));
        if (hourly_rate !== undefined) pushFj("hourly_rate", hourly_rate === null ? null : String(hourly_rate));
        if (instructions !== undefined) pushFj("notes", instructions);
        if (nextManualOverride !== undefined) pushFj("manual_rate_override", nextManualOverride);

        if (futureJobsSet.length > 0 || dayPatternChanged) {
          // Find candidate jobs in the series. For 'this_and_future' we
          // only touch future scheduled jobs. For 'all' we widen the
          // window to include past too, but skip jobs whose money has
          // already moved (charge_succeeded_at IS NOT NULL) — those need
          // refund/surcharge flows, not silent overwrites — and skip
          // completed jobs whose status would otherwise be downgraded.
          // Cancelled jobs are excluded both ways. The current job
          // updates via the main UPDATE statement so we exclude it
          // here to avoid double-write.
          const candidates = await tx.execute(sql`
            SELECT j.id, j.scheduled_date::text AS scheduled_date
            FROM jobs j
            WHERE j.recurring_schedule_id = ${scheduleId}
              AND j.company_id = ${companyId}
              AND j.id != ${jobId}
              AND j.status NOT IN ('cancelled')
              AND ${cascadeAllScope
                  ? sql`j.charge_succeeded_at IS NULL AND j.status != 'complete'`
                  : sql`j.scheduled_date > CURRENT_DATE AND j.status = 'scheduled'`}
          `);
          type Cand = { id: number; scheduled_date: string };
          const cands = (candidates.rows as unknown as Cand[]).map(r => ({ id: Number(r.id), scheduled_date: String(r.scheduled_date) }));
          const candIds = cands.map(c => c.id);
          const clockedRows = candIds.length === 0 ? { rows: [] as any[] } : await tx.execute(sql`
            SELECT DISTINCT job_id FROM timeclock
            WHERE clock_out_at IS NULL AND job_id = ANY(${candIds}::int[])
          `);
          const clockedSet = new Set((clockedRows.rows as Array<{ job_id: number }>).map(r => Number(r.job_id)));

          // [AI] Hybrid cascade. Build the new pattern's valid future-date set
          // and bucket each candidate job:
          //   - in valid set → UPDATE (preserve job + tech + instructions)
          //   - not in valid set → DELETE (drop)
          // Then INSERT any new dates the pattern requires that don't yet exist
          // (handled by computeOccurrencesForSchedule's existing dedupe).
          //
          // We don't have access to the unexported generateOccurrences
          // function, so we inline the same DOW-matching logic here. Window
          // matches the engine default (60 days from tomorrow).
          let validDateSet: Set<string> | null = null;
          if (dayPatternChanged) {
            // Pull the freshly-updated schedule row so we use the new pattern.
            const schedRow = await tx.execute(sql`
              SELECT frequency, day_of_week, days_of_week, custom_frequency_weeks
              FROM recurring_schedules WHERE id = ${scheduleId} LIMIT 1
            `);
            const sched = schedRow.rows[0] as any;
            const newFreq = String(sched.frequency);
            const newDow = sched.days_of_week as number[] | null;
            const newDayName = sched.day_of_week as string | null;
            const customWeeks = sched.custom_frequency_weeks as number | null;

            // Multi-day path: easy — match by DOW for every candidate date.
            const isMulti = newFreq === "daily" || newFreq === "weekdays" || newFreq === "custom_days";
            if (isMulti) {
              const dowArr =
                newFreq === "daily" ? [0,1,2,3,4,5,6]
                : newFreq === "weekdays" ? [1,2,3,4,5]
                : (newDow ?? []);
              const dowSet = new Set(dowArr);
              validDateSet = new Set(cands.filter(c => dowSet.has(new Date(c.scheduled_date).getDay())).map(c => c.scheduled_date));
            } else {
              // Single-day path. Match by day-of-week + interval cadence.
              // For weekly/biweekly/every_3_weeks: candidate must be the
              // configured weekday AND offset from the schedule's anchor by
              // a multiple of the interval.
              const dayMap: Record<string, number> = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
              const target = newDayName ? dayMap[String(newDayName).toLowerCase()] : null;
              const interval =
                newFreq === "weekly" ? 7
                : newFreq === "biweekly" ? 14
                : newFreq === "every_3_weeks" ? 21
                : (newFreq === "custom" && customWeeks != null) ? customWeeks * 7
                : null;
              if (target != null && interval != null) {
                // Need a stable anchor. Use the earliest existing future job
                // that matches the target DOW (if any); else just match by DOW.
                validDateSet = new Set(cands.filter(c => {
                  const d = new Date(c.scheduled_date);
                  return d.getDay() === target;
                }).map(c => c.scheduled_date));
              } else if (newFreq === "monthly") {
                // Monthly: preserve all existing future jobs (interval is
                // calendar-month-aware; conservative behavior).
                validDateSet = new Set(cands.map(c => c.scheduled_date));
              }
            }
            if (!validDateSet) validDateSet = new Set();
          }

          // Bucket: jobs to UPDATE, jobs to DELETE.
          const toUpdate: number[] = [];
          const toDelete: number[] = [];
          let skippedClockedUpdate = 0;
          let skippedClockedDelete = 0;
          for (const c of cands) {
            if (clockedSet.has(c.id)) {
              // Clocked-in jobs are never modified or deleted.
              skippedClockedUpdate++;
              continue;
            }
            if (validDateSet && !validDateSet.has(c.scheduled_date)) {
              toDelete.push(c.id);
            } else {
              toUpdate.push(c.id);
            }
          }
          futureClockedSkipped = skippedClockedUpdate + skippedClockedDelete;

          // UPDATE matching jobs in place.
          if (toUpdate.length > 0 && futureJobsSet.length > 0) {
            const setClauses = futureJobsSet.map((c, i) => sql`${sql.identifier(c)} = ${futureJobsVals[i]}`);
            const setSql = sql.join(setClauses, sql`, `);
            const updRes = await tx.execute(sql`
              UPDATE jobs SET ${setSql}
              WHERE id = ANY(${toUpdate}::int[])
            `);
            futureCount = (updRes as any).rowCount ?? toUpdate.length;
          } else {
            futureCount = toUpdate.length;
          }

          // DELETE non-matching jobs (only when day pattern changed).
          if (toDelete.length > 0) {
            const delRes = await tx.execute(sql`
              DELETE FROM jobs WHERE id = ANY(${toDelete}::int[])
            `);
            futureDeleted = (delRes as any).rowCount ?? toDelete.length;
          }

          // INSERT new dates the new pattern requires. Use the cron's compute
          // helper so dedupe matches engine behavior. Dates with existing jobs
          // (the toUpdate set) get filtered by the helper's dedupe.
          if (dayPatternChanged) {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(0, 0, 0, 0);
            const horizon = new Date(tomorrow);
            horizon.setDate(horizon.getDate() + 60);
            const schedRow = await tx.execute(sql`
              SELECT id, company_id, customer_id, frequency, day_of_week,
                     days_of_week, custom_frequency_weeks, start_date, end_date,
                     assigned_employee_id, service_type, duration_minutes,
                     base_fee, notes
              FROM recurring_schedules WHERE id = ${scheduleId} LIMIT 1
            `);
            const sched = schedRow.rows[0] as any;
            const { computeOccurrencesForSchedule: compute } = await import("../lib/recurring-jobs.js");
            const planned = await compute(sched, tomorrow, horizon, null, null);
            // Per-row INSERT — small N (≤60 daily for one schedule) so loop is fine,
            // and keeps the SQL shape readable. The compute helper's dedupe ensures
            // no duplicates against existing jobs.
            for (const r of planned.rows) {
              await tx.execute(sql`
                INSERT INTO jobs
                  (company_id, client_id, assigned_user_id, service_type, status,
                   scheduled_date, scheduled_time, frequency, base_fee, allowed_hours,
                   notes, recurring_schedule_id, booking_location, address_zip)
                VALUES
                  (${r.company_id}, ${r.client_id}, ${r.assigned_user_id},
                   ${r.service_type}, ${r.status}, ${r.scheduled_date},
                   ${r.scheduled_time}, ${r.frequency}, ${r.base_fee},
                   ${r.allowed_hours}, ${r.notes}, ${r.recurring_schedule_id},
                   ${r.booking_location}, ${r.address_zip})
              `);
              futureInserted++;
            }
          }
        }

        // Replace recurring_schedule_add_ons + recurring_schedule_technicians.
        if (addOnsProvided && Array.isArray(add_ons)) {
          await tx.execute(sql`DELETE FROM recurring_schedule_add_ons WHERE recurring_schedule_id = ${scheduleId}`);
          for (const a of add_ons as Array<{ pricing_addon_id?: number; qty?: number }>) {
            const pricingId = Number(a.pricing_addon_id ?? 0);
            const qty = Number(a.qty ?? 1) || 1;
            if (!pricingId) continue;
            await tx.execute(sql`
              INSERT INTO recurring_schedule_add_ons (recurring_schedule_id, pricing_addon_id, qty)
              VALUES (${scheduleId}, ${pricingId}, ${qty})
            `);
          }
        }
        if (teamProvided && Array.isArray(team_user_ids)) {
          await tx.execute(sql`DELETE FROM recurring_schedule_technicians WHERE recurring_schedule_id = ${scheduleId}`);
          for (let i = 0; i < team_user_ids.length; i++) {
            const uid = team_user_ids[i];
            const isPrimary = i === 0;
            await tx.execute(sql`
              INSERT INTO recurring_schedule_technicians (recurring_schedule_id, user_id, is_primary)
              VALUES (${scheduleId}, ${uid}, ${isPrimary})
              ON CONFLICT (recurring_schedule_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
            `);
          }
          // Mirror primary onto recurring_schedules.assigned_employee_id so the
          // existing recurring engine (which still reads the single column) sees
          // the new owner.
          await tx.execute(sql`
            UPDATE recurring_schedules SET assigned_employee_id = ${team_user_ids[0]}
            WHERE id = ${scheduleId} AND company_id = ${companyId}
          `);
        }

        // Single summary audit row for the cascade. new_value carries the full
        // payload; field_name='cascade_summary'.
        const summary = {
          changed_fields: changes.map(c => c.field),
          values: Object.fromEntries(changes.map(c => [c.field, c.next])),
          future_jobs_updated: futureCount,
          future_jobs_skipped_in_progress: futureClockedSkipped,
        };
        await tx.execute(sql`
          INSERT INTO job_audit_log
            (job_id, company_id, user_id, user_name, user_email,
             field_name, old_value, new_value, cascade_scope, schedule_id)
          VALUES
            (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
             'cascade_summary',
             ${null}::jsonb,
             ${JSON.stringify(summary)}::jsonb,
             'this_and_future', ${scheduleId})
        `);
      }

      // Per-field audit rows (always written, regardless of cascade).
      for (const c of changes) {
        await tx.execute(sql`
          INSERT INTO job_audit_log
            (job_id, company_id, user_id, user_name, user_email,
             field_name, old_value, new_value, cascade_scope, schedule_id)
          VALUES
            (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
             ${c.field},
             ${JSON.stringify(c.old)}::jsonb,
             ${JSON.stringify(c.next)}::jsonb,
             ${cascade_scope},
             ${cascade_scope === "this_and_future" ? Number(before.recurring_schedule_id) : null})
        `);
      }

      // Stash counters for the response (read after commit via closure).
      (req as any)._agFutureCount = futureCount;
      (req as any)._agFutureSkipped = futureClockedSkipped;

      // [PR / 2026-04-30] Dry-run rollback. Throwing here forces
      // Drizzle's tx wrapper to roll back every write that landed
      // inside this callback (including the audit-log inserts above
      // — intentional; we don't want a "real" audit row for a
      // hypothetical edit). The outer try/catch matches on the
      // sentinel class and returns counters to the caller.
      if (dry_run) {
        throw new DryRunRollback({
          scope: cascade_scope,
          current_job_would_update: true,
          schedule_would_be_created: createdScheduleId != null,
          future_jobs_would_be_updated: futureCount,
          future_jobs_would_be_deleted: futureDeleted,
          future_jobs_would_be_inserted_in_tx: futureInserted,
          future_jobs_would_be_skipped_in_progress: futureClockedSkipped,
        });
      }
    }).catch((err: unknown) => {
      // [PR / 2026-04-30] Catch the dry-run sentinel here (the only
      // expected throw). Re-throw anything else — the outer route
      // catch handles real failures via its 500 response.
      if (err instanceof DryRunRollback) {
        dryRunSummary = err.summary;
        return;
      }
      throw err;
    });

    // [recurring-on-save 2026-04-30] After-commit fan-out for the
    // create_recurring path. Mirrors POST /api/recurring's pattern:
    // synchronously generate the next 60 days so the dispatch board
    // populates immediately. Best-effort — engine hiccups don't roll
    // back the parent edit (the schedule + linked job already exist;
    // the nightly 2 AM cron will catch any missed dates). Failures
    // get surfaced in the response so the operator sees them.
    // [PR / 2026-04-30] Skip the post-commit fan-out under dry_run.
    // generateJobsFromSchedule writes real INSERTs outside the
    // transaction; rollback can't reverse them. v1 reports
    // counters-only and omits the fan-out estimate (Sal Q3.1 = a).
    let createRecurringFanout: { jobs_generated: number; jobs_skipped: number; error?: string } | null = null;
    if (createdScheduleId != null && !dry_run) {
      try {
        const { generateJobsFromSchedule, DAYS_AHEAD: HORIZON } = await import("../lib/recurring-jobs.js");
        const schedRow = await db.execute(sql`
          SELECT id, company_id, customer_id, frequency, day_of_week, days_of_week,
                 custom_frequency_weeks, start_date, end_date, scheduled_time,
                 assigned_employee_id, service_type, duration_minutes, base_fee,
                 commercial_hourly_rate, notes, instructions,
                 parking_fee_enabled, parking_fee_amount, parking_fee_days
          FROM recurring_schedules WHERE id = ${Number(createdScheduleId)} LIMIT 1
        `);
        const sched = schedRow.rows[0];
        // Pull the client's zip for the booking_location/address_zip
        // stamping the engine does on each generated job.
        const cl = await db.execute(sql`
          SELECT zip FROM clients WHERE id = ${Number(before.client_id)} LIMIT 1
        `);
        const clientZip = (cl.rows[0] as any)?.zip ?? null;
        const today = new Date();
        const horizon = new Date(today.getTime() + HORIZON * 24 * 60 * 60 * 1000);
        const result = await generateJobsFromSchedule(
          sched as any,
          today,
          horizon,
          null,
          clientZip,
        );
        createRecurringFanout = {
          jobs_generated: result.created,
          jobs_skipped: result.skipped,
        };
      } catch (genErr: any) {
        console.warn("[PATCH /jobs/:id create_recurring] sync fan-out failed:", genErr?.message ?? genErr);
        createRecurringFanout = {
          jobs_generated: 0,
          jobs_skipped: 0,
          error: String(genErr?.message ?? genErr),
        };
      }
    }

    // [PR / 2026-04-30] Dry-run branch. The transaction rolled back
    // before any writes committed, so we don't query the post-state
    // (that's what the operator would normally see) — we return the
    // captured summary instead. Production state is unchanged; the
    // operator can re-run without dry_run when ready.
    if (dry_run && dryRunSummary) {
      const summary: Record<string, unknown> = dryRunSummary;
      return res.json({
        ok: true,
        dry_run: true,
        cascade: {
          ...summary,
          // Counters-only for v1 (Sal Q3.1 = a). Sample-row capture
          // is a follow-up if v1 proves insufficient.
          fan_out_simulated: false,
          note: "Transaction rolled back. No production changes. Post-commit fan-out (forward 60-day inserts via generateJobsFromSchedule) NOT simulated in v1 — re-run without dry_run to see actual fan-out.",
        },
      });
    }

    // ── Build response ────────────────────────────────────────────────────
    const updatedRows = await db.execute(sql`
      SELECT id, status, service_type, frequency, scheduled_date, scheduled_time,
             allowed_hours, base_fee, manual_rate_override, notes, assigned_user_id,
             recurring_schedule_id
      FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    const updated = updatedRows.rows[0];

    return res.json({
      ok: true,
      changed: true,
      job: updated,
      diff: changes.map(c => ({ field: c.field, old: c.old, new: c.next })),
      cascade: {
        scope: cascade_scope,
        future_jobs_updated: (req as any)._agFutureCount ?? 0,
        future_jobs_skipped_in_progress: (req as any)._agFutureSkipped ?? 0,
        // [recurring-on-save 2026-04-30] create_recurring metadata.
        // Null when this PATCH didn't create a schedule. Otherwise
        // includes the new schedule_id + the synchronous fan-out
        // result (created / skipped / optional error).
        created_schedule_id: createdScheduleId,
        create_recurring: createRecurringFanout,
        // [PR / 2026-04-30] Anchor-protection signals for the modal's
        // success banner. anchor_protected=true means the operator
        // edited a completed job with cascade_scope=this_and_future|all
        // and the route stripped lock-protected fields from the
        // anchor's `setParts` UPDATE. anchor_skipped_fields lists
        // exactly which fields were stripped — modal shows them in
        // the success summary so the operator sees what stayed
        // frozen. schedule_updated=true means the recurring_schedules
        // template row was UPDATEd in the cascade block.
        anchor_protected: ((req as any)._anchorSkippedFields ?? []).length > 0,
        anchor_skipped_fields: (req as any)._anchorSkippedFields ?? [],
        schedule_updated: !!(req as any)._scheduleUpdated,
      },
    });
  } catch (err: any) {
    console.error("PATCH /jobs/:id error:", err);
    // [AI.6.3] Surface the actual exception message in the response so
    // the modal toast shows what went wrong (FK violations, NOT NULL
    // failures, etc.) instead of a generic "Failed to edit job" that
    // hides the cause and forces a Railway-logs trip.
    const detail = err?.message ?? String(err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: detail || "Failed to edit job",
    });
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
    const jobRows = await db.execute(sql`
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
    const existingPmt = await db.execute(sql`
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
        await db.execute(sql`
          UPDATE invoices SET status = 'paid', paid_at = NOW(), stripe_payment_intent_id = ${paymentIntent.id}
          WHERE id = ${job.invoice_id}
        `);
      }

      // Mark job charged
      await db.execute(sql`
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
      await db.execute(sql`
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

// ── Commission Engine ──────────────────────────────────────────────────────────
// Helper: calculate per-tech commission for a job
async function calculateTechPay(jobId: number, companyId: number): Promise<Array<{
  user_id: number; name: string; is_primary: boolean; est_hours: number;
  calc_pay: number; final_pay: number; pay_override: number | null;
}>> {
  const jobRows = await db.execute(sql`
    SELECT id, base_fee, billed_amount, estimated_hours, assigned_user_id, commission_pool_rate
    FROM jobs WHERE id = ${jobId} AND company_id = ${companyId}
  `);
  if (!jobRows.rows.length) return [];
  const job = jobRows.rows[0] as any;

  const compRows = await db.execute(sql`
    SELECT res_tech_pay_pct FROM companies WHERE id = ${companyId} LIMIT 1
  `);
  const resPct = parseFloat(String((compRows.rows[0] as any)?.res_tech_pay_pct ?? 0.35));

  const techRows = await db.execute(sql`
    SELECT jt.user_id, jt.is_primary, jt.pay_override, u.first_name, u.last_name
    FROM job_technicians jt
    JOIN users u ON u.id = jt.user_id
    WHERE jt.job_id = ${jobId}
    ORDER BY jt.is_primary DESC, jt.id
  `);

  let techs: any[] = techRows.rows;

  if (techs.length === 0 && job.assigned_user_id) {
    const userRow = await db.execute(sql`
      SELECT id, first_name, last_name FROM users WHERE id = ${job.assigned_user_id} LIMIT 1
    `);
    if (userRow.rows.length) {
      const u = userRow.rows[0] as any;
      techs = [{ user_id: u.id, first_name: u.first_name, last_name: u.last_name, is_primary: true, pay_override: null }];
    }
  }

  const numTechs = techs.length || 1;
  const jobTotal = parseFloat(String(job.billed_amount || job.base_fee || 0));
  const poolRate = job.commission_pool_rate != null ? parseFloat(String(job.commission_pool_rate)) : resPct;
  const poolAmount = jobTotal * poolRate;
  const estHours = parseFloat(String(job.estimated_hours || 0));
  const estHoursPerTech = numTechs > 0 ? Math.round((estHours / numTechs) * 10) / 10 : estHours;

  return techs.map((t: any) => {
    const calcPay = Math.round((poolAmount / numTechs) * 100) / 100;
    const override = t.pay_override != null ? parseFloat(String(t.pay_override)) : null;
    return {
      user_id: t.user_id,
      name: `${t.first_name} ${t.last_name}`,
      is_primary: !!t.is_primary,
      est_hours: estHoursPerTech,
      calc_pay: calcPay,
      final_pay: override != null ? override : calcPay,
      pay_override: override,
    };
  });
}

// GET /api/jobs/:id/technicians
router.get("/:id/technicians", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const result = await calculateTechPay(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("GET /jobs/:id/technicians error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/jobs/:id/technicians — add a tech to the job
//
// [AI.1] Two invariants we maintain here that the original handler missed:
//   1. jobs.assigned_user_id MUST mirror the primary tech in job_technicians.
//      The dispatch grid keys off jobs.assigned_user_id, so writes that don't
//      mirror create a split-brain (Jaira commission/assignment in AH; CJ
//      Jimenez stays in Unassigned after Add Team Member in AI).
//   2. Adding a tech to a job that has NO primary (typical for drawer "Add
//      Team Member" on an unassigned job) auto-promotes the new tech to
//      primary and mirrors. Caller can still pass is_primary explicitly.
// Audit row written for traceability since this is the most-used path.
router.post("/:id/technicians", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const { user_id, is_primary: isPrimaryReq } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    const jobRows = await db.execute(sql`
      SELECT id, assigned_user_id FROM jobs
      WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });
    const oldAssignedUserId = (jobRows.rows[0] as any).assigned_user_id ?? null;

    // Decide primary status: explicit request wins; else auto-promote when
    // there's no existing primary (covers unassigned jobs and any legacy
    // rows where is_primary was never set).
    const existingPrimary = await db.execute(sql`
      SELECT user_id FROM job_technicians
      WHERE job_id = ${jobId} AND is_primary = true LIMIT 1
    `);
    const noPrimary = existingPrimary.rows.length === 0;
    const willBePrimary = isPrimaryReq === true || (isPrimaryReq !== false && noPrimary);

    // Capture before-state for audit log
    const techsBefore = await db.execute(sql`
      SELECT user_id, is_primary FROM job_technicians
      WHERE job_id = ${jobId} ORDER BY is_primary DESC, id
    `);

    await db.transaction(async (tx) => {
      // If we're promoting this tech to primary, demote any existing primary first.
      if (willBePrimary) {
        await tx.execute(sql`
          UPDATE job_technicians SET is_primary = false
          WHERE job_id = ${jobId} AND user_id != ${user_id}
        `);
      }
      // Upsert the (job, tech) row with the resolved primary flag.
      await tx.execute(sql`
        INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
        VALUES (${jobId}, ${user_id}, ${companyId}, ${willBePrimary})
        ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
      `);
      // Mirror primary onto jobs.assigned_user_id so the dispatch grid sees the change.
      if (willBePrimary) {
        await tx.execute(sql`
          UPDATE jobs SET assigned_user_id = ${user_id}
          WHERE id = ${jobId} AND company_id = ${companyId}
        `);
      }

      // Audit row — drawer "Add Team Member" is the most common assignment
      // flow in production, so we want traceability here even though it
      // bypasses the PATCH endpoint's per-field audit machinery.
      const userRows = await tx.execute(sql`
        SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1
      `);
      const u = (userRows.rows[0] as any) ?? {};
      const actorName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown";
      const actorEmail = String(u.email ?? "");
      const summary = {
        action: "tech_assigned",
        added_user_id: Number(user_id),
        is_primary: willBePrimary,
        mirrored_to_assigned_user_id: willBePrimary && oldAssignedUserId !== Number(user_id),
        previous_assigned_user_id: oldAssignedUserId,
      };
      await tx.execute(sql`
        INSERT INTO job_audit_log
          (job_id, company_id, user_id, user_name, user_email,
           field_name, old_value, new_value, cascade_scope, schedule_id)
        VALUES
          (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
           'tech_assigned',
           ${JSON.stringify({ techs: techsBefore.rows, assigned_user_id: oldAssignedUserId })}::jsonb,
           ${JSON.stringify(summary)}::jsonb,
           'this_job', ${null})
      `);
    });

    const result = await calculateTechPay(jobId, companyId);
    return res.json({ data: result, primary: willBePrimary });
  } catch (err) {
    console.error("POST /jobs/:id/technicians error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /api/jobs/:id/technicians/:techId
//
// [AI.1] Mirror invariant. If we're removing the primary tech, promote the
// next remaining tech (lowest job_technicians.id) to primary and update
// jobs.assigned_user_id. If no techs remain, jobs.assigned_user_id goes
// NULL (job back to unassigned). Audit row written for traceability.
router.delete("/:id/technicians/:techId", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const techId = parseInt(req.params.techId);
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;

    const jobRows = await db.execute(sql`
      SELECT assigned_user_id FROM jobs
      WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });
    const oldAssignedUserId = (jobRows.rows[0] as any).assigned_user_id ?? null;

    const removingRow = await db.execute(sql`
      SELECT is_primary FROM job_technicians
      WHERE job_id = ${jobId} AND user_id = ${techId} AND company_id = ${companyId}
      LIMIT 1
    `);
    const wasRemovingPrimary = removingRow.rows.length > 0
      && Boolean((removingRow.rows[0] as any).is_primary);

    let newPrimary: number | null = null;

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM job_technicians
        WHERE job_id = ${jobId} AND user_id = ${techId} AND company_id = ${companyId}
      `);

      if (wasRemovingPrimary) {
        // Promote next remaining tech (oldest by row id). Could be no rows left.
        const remaining = await tx.execute(sql`
          SELECT user_id FROM job_technicians
          WHERE job_id = ${jobId}
          ORDER BY id ASC LIMIT 1
        `);
        if (remaining.rows.length > 0) {
          newPrimary = Number((remaining.rows[0] as any).user_id);
          await tx.execute(sql`
            UPDATE job_technicians SET is_primary = true
            WHERE job_id = ${jobId} AND user_id = ${newPrimary}
          `);
        }
        // Mirror onto jobs.assigned_user_id (NULL when no techs remain).
        await tx.execute(sql`
          UPDATE jobs SET assigned_user_id = ${newPrimary}
          WHERE id = ${jobId} AND company_id = ${companyId}
        `);
      }

      // Audit row.
      const userRows = await tx.execute(sql`
        SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1
      `);
      const u = (userRows.rows[0] as any) ?? {};
      const actorName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown";
      const actorEmail = String(u.email ?? "");
      const summary = {
        action: "tech_removed",
        removed_user_id: techId,
        was_primary: wasRemovingPrimary,
        new_primary_user_id: newPrimary,
        mirrored_to_assigned_user_id: wasRemovingPrimary,
        previous_assigned_user_id: oldAssignedUserId,
      };
      await tx.execute(sql`
        INSERT INTO job_audit_log
          (job_id, company_id, user_id, user_name, user_email,
           field_name, old_value, new_value, cascade_scope, schedule_id)
        VALUES
          (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
           'tech_removed',
           ${JSON.stringify({ removed_user_id: techId, was_primary: wasRemovingPrimary, assigned_user_id: oldAssignedUserId })}::jsonb,
           ${JSON.stringify(summary)}::jsonb,
           'this_job', ${null})
      `);
    });

    const result = await calculateTechPay(jobId, companyId);
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

    const jobRows = await db.execute(sql`SELECT id FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1`);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });

    const overrideVal = pay_override != null ? parseFloat(String(pay_override)) : null;

    await db.execute(sql`
      INSERT INTO job_technicians (job_id, user_id, company_id, pay_override, final_pay)
      VALUES (${jobId}, ${techId}, ${companyId}, ${overrideVal}, ${overrideVal})
      ON CONFLICT (job_id, user_id) DO UPDATE SET
        pay_override = EXCLUDED.pay_override,
        final_pay = EXCLUDED.final_pay
    `);

    const result = await calculateTechPay(jobId, companyId);
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

    await db.execute(sql`
      UPDATE jobs SET commission_pool_rate = ${parseFloat(String(commission_pool_rate))}
      WHERE id = ${jobId} AND company_id = ${companyId}
    `);

    const result = await calculateTechPay(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("POST /jobs/:id/commission/set-pool-rate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── INLINE EDIT: SWAP PRIMARY TECHNICIAN ─────────────────────────────────────
//
// PATCH /api/jobs/:id/reassign-tech
//
// Body: { new_tech_id: number }
//
// Atomic primary-tech swap used by the dispatch drawer's inline tech editor.
// Branch isolated: the new tech must belong to the same branch as the job.
// The swap demotes any existing primary, upserts the new tech with
// is_primary=true, and mirrors onto jobs.assigned_user_id (per the
// Assignment Mirror invariant in CLAUDE.md). Other team members on the job
// are preserved; only the primary slot rotates. Audit row written to
// job_audit_log so dispatcher activity is traceable.
//
// Differs from POST /:id/technicians (Add Team Member): that flow appends a
// tech (sometimes promoting to primary on unassigned jobs); this flow
// REPLACES the existing primary specifically.
router.patch("/:id/reassign-tech", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const newTechId = Number((req.body ?? {}).new_tech_id);
    if (!Number.isFinite(newTechId) || newTechId <= 0) {
      return res.status(400).json({ error: "new_tech_id required" });
    }

    // Read current job + its branch.
    const jobRows = await db.execute(sql`
      SELECT id, assigned_user_id, branch_id FROM jobs
      WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });
    const job = jobRows.rows[0] as any;
    const oldAssignedUserId = job.assigned_user_id ?? null;
    const jobBranchId = job.branch_id ?? null;

    if (oldAssignedUserId === newTechId) {
      // No change, return early.
      return res.json({ data: { unchanged: true, assigned_user_id: newTechId } });
    }

    // Validate the new tech exists, is active, and is in the same branch as
    // the job (branch isolation).
    const techRows = await db.execute(sql`
      SELECT id, branch_id, is_active, role, first_name, last_name
      FROM users
      WHERE id = ${newTechId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!techRows.rows.length) return res.status(404).json({ error: "Technician not found" });
    const tech = techRows.rows[0] as any;
    if (!tech.is_active) {
      return res.status(400).json({ error: "Technician is inactive" });
    }
    if (jobBranchId != null && tech.branch_id != null && jobBranchId !== tech.branch_id) {
      return res.status(403).json({ error: "Technician belongs to a different branch" });
    }

    // Capture before-state for audit log.
    const techsBefore = await db.execute(sql`
      SELECT user_id, is_primary FROM job_technicians
      WHERE job_id = ${jobId} ORDER BY is_primary DESC, id
    `);

    await db.transaction(async (tx) => {
      // Demote any existing primary (and any row for the new tech that was
      // sitting at non-primary before today).
      await tx.execute(sql`
        UPDATE job_technicians SET is_primary = false
        WHERE job_id = ${jobId}
      `);
      // Upsert the new tech as primary.
      await tx.execute(sql`
        INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
        VALUES (${jobId}, ${newTechId}, ${companyId}, true)
        ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = true
      `);
      // Mirror onto jobs.assigned_user_id so the dispatch grid sees the new row.
      await tx.execute(sql`
        UPDATE jobs SET assigned_user_id = ${newTechId}
        WHERE id = ${jobId} AND company_id = ${companyId}
      `);

      // Audit row.
      const userRows = await tx.execute(sql`
        SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1
      `);
      const u = (userRows.rows[0] as any) ?? {};
      const actorName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown";
      const actorEmail = String(u.email ?? "");
      const summary = {
        action: "tech_reassigned",
        new_primary_user_id: newTechId,
        previous_assigned_user_id: oldAssignedUserId,
        previous_techs: techsBefore.rows,
      };
      await tx.execute(sql`
        INSERT INTO job_audit_log
          (job_id, company_id, user_id, user_name, user_email,
           field_name, old_value, new_value, cascade_scope, schedule_id)
        VALUES
          (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
           'tech_reassigned',
           ${JSON.stringify({ assigned_user_id: oldAssignedUserId, techs: techsBefore.rows })}::jsonb,
           ${JSON.stringify(summary)}::jsonb,
           'this_job', ${null})
      `);
    });

    const techPay = await calculateTechPay(jobId, companyId);
    return res.json({
      data: {
        assigned_user_id: newTechId,
        assigned_user_name: `${tech.first_name ?? ""} ${tech.last_name ?? ""}`.trim(),
        techs: techPay,
      },
    });
  } catch (err) {
    console.error("PATCH /jobs/:id/reassign-tech error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── INLINE EDIT: ADDRESS WITH GEOCODE VALIDATION ─────────────────────────────
//
// PATCH /api/jobs/:id/address
//
// Body: { address: string, city?: string, state?: string, zip?: string }
//
// Mode is auto-picked server-side:
//   * If jobs.address_street is already set AND differs from clients.address,
//     this job has a one-off site override and we keep writing at the job
//     level (jobs.address_*).
//   * Otherwise we write at the client level (clients.address/city/state/zip
//     plus clients.lat/lng), which fixes all future occurrences.
//
// Defense in depth: server re-runs geocodeAddress before writing. Failure
// returns 422 even though the popover already pre-validates via
// /api/geocode/validate. Belt and suspenders.
//
// On success, re-resolves the zone via resolveZoneForZip so the dispatch
// tile's zone color flips immediately on the next poll/refresh.
router.patch("/:id/address", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const { address, city, state, zip, mode: requestedMode } = (req.body ?? {}) as {
      address?: string; city?: string; state?: string; zip?: string;
      mode?: "client" | "job";
    };

    if (!address || !address.trim()) {
      return res.status(400).json({ error: "Street address is required." });
    }

    // Read current state for mode decision and audit.
    const ctx = await db.execute(sql`
      SELECT
        j.id, j.client_id, j.zone_id AS job_zone_id,
        j.address_street AS j_addr, j.address_city AS j_city,
        j.address_state AS j_state, j.address_zip AS j_zip,
        c.address AS c_addr, c.city AS c_city,
        c.state AS c_state, c.zip AS c_zip
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.id = ${jobId} AND j.company_id = ${companyId} LIMIT 1
    `);
    if (!ctx.rows.length) return res.status(404).json({ error: "Job not found" });
    const r = ctx.rows[0] as any;

    // Mode resolution. Frontend now sends an explicit mode (the popover's
    // "permanent change" checkbox controls it: unchecked = job, checked =
    // client). Auto-pick stays as a backwards-compatible fallback for any
    // future caller that omits mode, AND for the case where a client has no
    // address on file at all (NULL) — we always cascade to client level
    // there because there is no canonical record to override.
    const clientHasAddress = !!String(r.c_addr ?? "").trim();
    const jobAddrTrim = String(r.j_addr ?? "").trim();
    const jobZipTrim = String(r.j_zip ?? "").trim();
    const cAddrTrim = String(r.c_addr ?? "").trim();
    const cZipTrim = String(r.c_zip ?? "").trim();
    const autoPickedJobOverride = clientHasAddress
      && !!jobAddrTrim
      && (jobAddrTrim !== cAddrTrim || jobZipTrim !== cZipTrim);

    let mode: "client" | "job";
    if (requestedMode === "client" || requestedMode === "job") {
      // Honor the explicit choice unless the client has no address yet.
      // Even if the user picked "job", a client with no canonical address
      // gets the cascade so future jobs are not orphaned.
      mode = (!clientHasAddress) ? "client" : requestedMode;
    } else {
      mode = autoPickedJobOverride ? "job" : "client";
    }

    // Server-side geocode (defense in depth).
    const fullAddress = [address, city, state, zip].filter(Boolean).join(", ");
    const coords = await geocodeAddress(fullAddress);
    if (!coords) {
      return res.status(422).json({
        error: "Could not verify address. Check spelling, city, and zip.",
      });
    }

    const newZoneId = zip ? await resolveZoneForZip(companyId, zip) : null;

    // Per the product rule (Sal, 2026-04-28): the only valid failure case is
    // when the resolved zip is not mapped to any active service zone in this
    // tenant's database. Reject the save with 422 so the inline form can
    // surface the message instead of silently saving an unmapped address
    // (which would render as a gray tile on dispatch).
    if (!newZoneId) {
      return res.status(422).json({
        error: zip
          ? `Zip ${zip} is not in any of your service zones. Add it under Settings → Service Zones first.`
          : "Could not determine a zip code from this address.",
      });
    }

    const before = {
      mode,
      address: r.j_addr ?? r.c_addr ?? null,
      city:    r.j_city ?? r.c_city ?? null,
      state:   r.j_state ?? r.c_state ?? null,
      zip:     r.j_zip ?? r.c_zip ?? null,
      zone_id: r.job_zone_id ?? null,
    };

    await db.transaction(async (tx) => {
      if (mode === "job") {
        await tx.execute(sql`
          UPDATE jobs SET
            address_street   = ${address},
            address_city     = ${city ?? null},
            address_state    = ${state ?? null},
            address_zip      = ${zip ?? null},
            address_lat      = ${String(coords.lat)},
            address_lng      = ${String(coords.lng)},
            address_verified = true,
            zone_id          = ${newZoneId}
          WHERE id = ${jobId} AND company_id = ${companyId}
        `);
      } else {
        // Client level: the canonical address for this customer.
        await tx.execute(sql`
          UPDATE clients SET
            address = ${address},
            city    = ${city ?? null},
            state   = ${state ?? null},
            zip     = ${zip ?? null},
            lat     = ${String(coords.lat)},
            lng     = ${String(coords.lng)},
            zone_id = ${newZoneId}
          WHERE id = ${r.client_id} AND company_id = ${companyId}
        `);
        // Mirror the resolved zone onto the job too so the dispatch tile
        // updates without waiting for the recurring engine to regenerate.
        await tx.execute(sql`
          UPDATE jobs SET zone_id = ${newZoneId}
          WHERE id = ${jobId} AND company_id = ${companyId}
        `);
      }

      // Audit row.
      const userRows = await tx.execute(sql`
        SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1
      `);
      const u = (userRows.rows[0] as any) ?? {};
      const actorName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown";
      const actorEmail = String(u.email ?? "");
      const after = {
        mode,
        address, city: city ?? null, state: state ?? null, zip: zip ?? null,
        zone_id: newZoneId,
        lat: String(coords.lat), lng: String(coords.lng),
      };
      await tx.execute(sql`
        INSERT INTO job_audit_log
          (job_id, company_id, user_id, user_name, user_email,
           field_name, old_value, new_value, cascade_scope, schedule_id)
        VALUES
          (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
           'address_changed',
           ${JSON.stringify(before)}::jsonb,
           ${JSON.stringify(after)}::jsonb,
           ${mode === "client" ? "all_future" : "this_job"}, ${null})
      `);
    });

    return res.json({
      data: {
        mode,
        address, city, state, zip,
        lat: coords.lat, lng: coords.lng,
        zone_id: newZoneId,
      },
    });
  } catch (err) {
    console.error("PATCH /jobs/:id/address error:", err);
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
        c.address AS client_address, c.city AS client_city, c.state AS client_state, c.zip AS client_zip, c.referral_source,
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

export { calculateTechPay };
export default router;
