import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, usersTable, jobPhotosTable, timeclockTable, invoicesTable, scorecardsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, count, desc, sql, notExists, inArray } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { generateJobCompletionPdf } from "../lib/generate-job-pdf.js";
import { geocodeAddress } from "../lib/geocode.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, assigned_user_id, client_id, date_from, date_to, page = "1", limit = "50", uninvoiced } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const conditions: any[] = [eq(jobsTable.company_id, req.auth!.companyId)];
    if (status) conditions.push(eq(jobsTable.status, status as any));
    if (assigned_user_id) conditions.push(eq(jobsTable.assigned_user_id, parseInt(assigned_user_id as string)));
    if (client_id) conditions.push(eq(jobsTable.client_id, parseInt(client_id as string)));
    if (date_from) conditions.push(gte(jobsTable.scheduled_date, date_from as string));
    if (date_to) conditions.push(lte(jobsTable.scheduled_date, date_to as string));
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
    const { client_id, assigned_user_id, service_type, scheduled_date, scheduled_time, frequency, base_fee, allowed_hours, notes } = req.body;

    const newJob = await db
      .insert(jobsTable)
      .values({
        company_id: req.auth!.companyId,
        client_id,
        assigned_user_id,
        service_type,
        scheduled_date,
        scheduled_time,
        frequency,
        base_fee,
        allowed_hours,
        notes,
      })
      .returning();

    const jobWithClient = await db
      .select({
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        assigned_user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        address: clientsTable.address,
        city: clientsTable.city,
        state: clientsTable.state,
        zip: clientsTable.zip,
      })
      .from(clientsTable)
      .leftJoin(usersTable, eq(usersTable.id, assigned_user_id))
      .where(eq(clientsTable.id, client_id))
      .limit(1);

    const client = jobWithClient[0];
    const jobId = newJob[0].id;

    if (client?.address) {
      const fullAddress = [client.address, client.city, client.state, client.zip].filter(Boolean).join(", ");
      const coords = await geocodeAddress(fullAddress);
      if (coords) {
        await db
          .update(jobsTable)
          .set({ job_lat: String(coords.lat), job_lng: String(coords.lng), geocode_failed: false })
          .where(eq(jobsTable.id, jobId));
        newJob[0] = { ...newJob[0], job_lat: String(coords.lat) as any, job_lng: String(coords.lng) as any, geocode_failed: false };
      } else {
        await db.update(jobsTable).set({ geocode_failed: true }).where(eq(jobsTable.id, jobId));
        newJob[0] = { ...newJob[0], geocode_failed: true };
      }
    }

    return res.status(201).json({
      ...newJob[0],
      client_name: client?.client_name || "",
      assigned_user_name: client?.assigned_user_name || null,
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
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;

    const jobs = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        address: clientsTable.address,
        city: clientsTable.city,
        state: clientsTable.state,
        zip: clientsTable.zip,
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
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
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
    const { assigned_user_id, service_type, status, scheduled_date, scheduled_time, frequency, base_fee, allowed_hours, notes } = req.body;

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
      })
      .where(and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.company_id, req.auth!.companyId)
      ))
      .returning();

    if (!updated[0]) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }

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

    if (afterPhotos[0].count < 1) {
      return res.status(400).json({
        error: "Bad Request",
        message: "At least 1 after photo required to complete job"
      });
    }

    const updated = await db
      .update(jobsTable)
      .set({ status: "complete" })
      .where(and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.company_id, req.auth!.companyId)
      ))
      .returning();

    if (!updated[0]) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }

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
        company_name: sql<string>`coalesce((select name from companies where id = ${jobsTable.company_id}), 'CleanOps Pro')`,
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
          companyName: d.company_name || "CleanOps Pro",
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

    return res.json({
      ...updated[0],
      client_name: jobDetail[0]?.client_name ?? "",
      assigned_user_name: jobDetail[0]?.assigned_user_name ?? null,
      before_photo_count: beforeCount[0]?.count ?? 0,
      after_photo_count: afterPhotos[0].count,
      completion_pdf_url: pdfUrl,
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

export default router;
