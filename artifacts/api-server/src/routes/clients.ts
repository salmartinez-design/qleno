import { Router } from "express";
import { db } from "@workspace/db";
import {
  clientsTable, jobsTable, usersTable, invoicesTable,
  scorecardsTable, clientHomesTable, technicianPreferencesTable,
  clientNotificationsTable, clientCommunicationsTable, clientAgreementsTable,
  serviceZonesTable, quotesTable, contactTicketsTable, clientAttachmentsTable,
  recurringSchedulesTable, jobPhotosTable, qbCustomerMapTable, companiesTable,
  accountPropertiesTable,
} from "@workspace/db/schema";
import { eq, and, ilike, or, count, sum, desc, sql, gte, inArray, ne } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { syncCustomer, queueSync } from "../services/quickbooks-sync.js";
import { resolveZoneForZip } from "./zones.js";
import crypto from "crypto";

const router = Router();

async function geocodeAddress(address: string, city?: string, state?: string, zip?: string): Promise<{ lat: string; lng: string } | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const full = [address, city, state, zip].filter(Boolean).join(", ");
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(full)}&key=${key}`);
    const data = await res.json() as any;
    if (data.results?.[0]) {
      const loc = data.results[0].geometry.location;
      return { lat: String(loc.lat), lng: String(loc.lng) };
    }
  } catch { /* silent */ }
  return null;
}

function assertClientAccess(client: any, companyId: number, res: any): boolean {
  if (!client || client.company_id !== companyId) {
    res.status(404).json({ error: "Not Found", message: "Client not found" });
    return false;
  }
  return true;
}

// ─── LIST CLIENTS ─────────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const { search, page = "1", limit = "50", status, frequency, portal, branch_id } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const conditions = [eq(clientsTable.company_id, req.auth!.companyId)];
    if (search) {
      const s = search as string;
      const clMatch = s.match(/^cl-?(\d+)$/i);
      if (clMatch) {
        // Search by client ID (CL-XXXX format)
        conditions.push(eq(clientsTable.id, parseInt(clMatch[1])));
      } else {
        // [search-fullname 2026-06-26] Match the term against the combined
        // "first last" name too. Without this, "Sal Martinez" matched NOTHING —
        // the per-field ILIKE checks each column alone, so a term spanning
        // first+last never hit. trim() each part so trailing/leading spaces in
        // the stored name (common from the MaidCentral import) don't break it,
        // and collapse runs of whitespace in the term. This fixes full-name
        // search for every client, not just this one.
        const sNorm = s.trim().replace(/\s+/g, " ");
        conditions.push(
          or(
            ilike(clientsTable.first_name, `%${s}%`),
            ilike(clientsTable.last_name, `%${s}%`),
            ilike(clientsTable.email, `%${s}%`),
            ilike(clientsTable.phone, `%${s}%`),
            ilike(clientsTable.address, `%${s}%`),
            ilike(clientsTable.city, `%${s}%`),
            ilike(clientsTable.company_name, `%${s}%`),
            sql`(trim(coalesce(${clientsTable.first_name}, '')) || ' ' || trim(coalesce(${clientsTable.last_name}, ''))) ILIKE ${`%${sNorm}%`}`
          ) as any
        );
      }
    }
    if (status === "active") conditions.push(eq(clientsTable.is_active, true));
    if (status === "inactive") conditions.push(eq(clientsTable.is_active, false));
    if (frequency && frequency !== "all") conditions.push(eq(clientsTable.frequency, frequency as string));
    if (portal === "registered") conditions.push(eq(clientsTable.portal_access, true));
    if (branch_id && branch_id !== "all") conditions.push(eq(clientsTable.branch_id, parseInt(branch_id as string)));
    if (portal === "invited") {
      conditions.push(sql`${clientsTable.portal_invite_sent_at} IS NOT NULL AND ${clientsTable.portal_access} = false`);
    }
    if (portal === "not_invited") {
      conditions.push(sql`${clientsTable.portal_invite_sent_at} IS NULL AND ${clientsTable.portal_access} = false`);
    }

    const clients = await db
      .select()
      .from(clientsTable)
      .where(and(...conditions))
      .orderBy(desc(clientsTable.is_active), clientsTable.last_name, clientsTable.first_name)
      .limit(parseInt(limit as string))
      .offset(offset);

    const clientIds = clients.map(c => c.id);
    const companyId = req.auth!.companyId;

    // Run all supplemental queries in parallel
    const [zonesResult, lastJobsResult, nextJobsResult, histLastResult, totalResult] = await Promise.all([
      // All service zones for this company (zip→zone lookup)
      db.select({ name: serviceZonesTable.name, color: serviceZonesTable.color, zip_codes: serviceZonesTable.zip_codes })
        .from(serviceZonesTable)
        .where(eq(serviceZonesTable.company_id, companyId)),

      // Last completed job per client (jobs table)
      clientIds.length > 0
        ? db.select({ client_id: jobsTable.client_id, scheduled_date: jobsTable.scheduled_date })
            .from(jobsTable)
            .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), inArray(jobsTable.client_id, clientIds)))
            .orderBy(desc(jobsTable.scheduled_date))
        : Promise.resolve([]),

      // Next upcoming job per client
      clientIds.length > 0
        ? db.select({ client_id: jobsTable.client_id, scheduled_date: jobsTable.scheduled_date })
            .from(jobsTable)
            .where(and(
              eq(jobsTable.company_id, companyId),
              sql`${jobsTable.status} IN ('scheduled','in_progress')`,
              sql`${jobsTable.scheduled_date} >= CURRENT_DATE`,
              inArray(jobsTable.client_id, clientIds)
            ))
            .orderBy(jobsTable.scheduled_date)
        : Promise.resolve([]),

      // Last service from job_history (may include archived history before jobs table era)
      clientIds.length > 0
        ? db.execute(sql`
            SELECT customer_id::int AS cid, MAX(job_date)::text AS last_date
            FROM job_history
            WHERE company_id = ${companyId}
              AND customer_id IN (${sql.join(clientIds.map(id => sql`${id}`), sql`, `)})
            GROUP BY customer_id
          `)
        : Promise.resolve({ rows: [] } as any),

      // Total count for pagination
      db.select({ count: count() }).from(clientsTable).where(and(...conditions)),
    ]);

    // Build zip → zone map (first match wins)
    const zipZoneMap = new Map<string, { color: string; name: string }>();
    for (const z of zonesResult) {
      for (const zip of (z.zip_codes as string[])) {
        if (!zipZoneMap.has(zip)) zipZoneMap.set(zip, { color: z.color, name: z.name });
      }
    }

    // Build client maps
    const lastJobMap: Record<number, string | null> = {};
    for (const r of lastJobsResult as any[]) {
      if (!lastJobMap[r.client_id!] && r.scheduled_date) lastJobMap[r.client_id!] = r.scheduled_date;
    }

    const nextJobMap: Record<number, string | null> = {};
    for (const r of nextJobsResult as any[]) {
      if (!nextJobMap[r.client_id!] && r.scheduled_date) nextJobMap[r.client_id!] = r.scheduled_date;
    }

    const histMap: Record<number, string | null> = {};
    for (const r of (histLastResult as any).rows) {
      histMap[r.cid] = r.last_date;
    }

    const enriched = clients.map(c => {
      const lastFromJobs = lastJobMap[c.id] || null;
      const lastFromHist = histMap[c.id] || null;
      // Take the more recent of jobs table vs job_history
      let lastServiceDate: string | null = null;
      if (lastFromJobs && lastFromHist) {
        lastServiceDate = lastFromJobs >= lastFromHist ? lastFromJobs : lastFromHist;
      } else {
        lastServiceDate = lastFromJobs || lastFromHist;
      }
      const daysSinceLast = lastServiceDate
        ? Math.floor((Date.now() - new Date(lastServiceDate).getTime()) / 86400000)
        : 999;
      const zone = zipZoneMap.get(c.zip || '') || null;
      return {
        ...c,
        last_service_date: lastServiceDate,
        next_service_date: nextJobMap[c.id] || null,
        next_job_date: nextJobMap[c.id] || null,
        zone_color: zone?.color || null,
        zone_name: zone?.name || null,
        at_risk: false,
        days_since_last: daysSinceLast,
      };
    });

    return res.json({
      data: enriched,
      total: totalResult[0].count,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
    });
  } catch (err) {
    console.error("List clients error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list clients" });
  }
});

// ─── CREATE CLIENT ─────────────────────────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
  try {
    const { first_name, last_name, email, phone, address, city, state, zip, notes, company_name, frequency, service_type, base_fee, allowed_hours, send_welcome } = req.body;
    const geo = address ? await geocodeAddress(address, city, state, zip) : null;
    const zoneId = await resolveZoneForZip(req.auth!.companyId, zip);
    const newClient = await db.insert(clientsTable).values({
      company_id: req.auth!.companyId,
      first_name, last_name, email, phone, address, city, state, zip, notes,
      company_name, frequency, service_type,
      ...(base_fee && { base_fee: String(base_fee) }),
      ...(allowed_hours && { allowed_hours: String(allowed_hours) }),
      ...(geo && { lat: geo.lat, lng: geo.lng }),
      ...(zoneId && { zone_id: zoneId }),
    }).returning();

    // Audit log
    if (newClient[0]) {
      logAudit(req, "CREATE", "client", newClient[0].id, null, newClient[0]);
    }

    // QB sync (fire and forget)
    if (newClient[0]) {
      queueSync(() => syncCustomer(req.auth!.companyId, newClient[0].id));
    }

    // new_client_welcome notification (non-blocking)
    if (newClient[0] && send_welcome) {
      const companyId = req.auth!.companyId;
      const mv = { first_name: first_name || "" };
      import("../services/notificationService.js").then(({ sendNotification }) => {
        sendNotification("new_client_welcome", "email", companyId, email ?? null, null, mv).catch(() => {});
        sendNotification("new_client_welcome", "sms",   companyId, null, phone ?? null, mv).catch(() => {});
      });
    }

    return res.status(201).json(newClient[0]);
  } catch (err) {
    console.error("Create client error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to create client" });
  }
});

// ─── FULL PROFILE ─────────────────────────────────────────────────────────────
router.get("/:id/full-profile", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;

    const [client] = await db.select().from(clientsTable)
      .where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, companyId))).limit(1);
    if (!assertClientAccess(client, companyId, res)) return;

    const [homes, preferences, notifications, scorecards, invoices, jobs] = await Promise.all([
      db.select().from(clientHomesTable).where(and(eq(clientHomesTable.client_id, clientId), eq(clientHomesTable.company_id, companyId))).orderBy(desc(clientHomesTable.is_primary)),
      db.select({ id: technicianPreferencesTable.id, user_id: technicianPreferencesTable.user_id, preference: technicianPreferencesTable.preference, notes: technicianPreferencesTable.notes, created_at: technicianPreferencesTable.created_at, first_name: usersTable.first_name, last_name: usersTable.last_name, avatar_url: usersTable.avatar_url })
        .from(technicianPreferencesTable)
        .leftJoin(usersTable, eq(technicianPreferencesTable.user_id, usersTable.id))
        .where(and(eq(technicianPreferencesTable.client_id, clientId), eq(technicianPreferencesTable.company_id, companyId))),
      db.select().from(clientNotificationsTable).where(and(eq(clientNotificationsTable.client_id, clientId), eq(clientNotificationsTable.company_id, companyId))),
      db.select({ id: scorecardsTable.id, score: scorecardsTable.score, comments: scorecardsTable.comments, excluded: scorecardsTable.excluded, created_at: scorecardsTable.created_at, job_id: scorecardsTable.job_id, scheduled_date: jobsTable.scheduled_date, first_name: usersTable.first_name, last_name: usersTable.last_name })
        .from(scorecardsTable)
        .leftJoin(jobsTable, eq(scorecardsTable.job_id, jobsTable.id))
        .leftJoin(usersTable, eq(scorecardsTable.user_id, usersTable.id))
        .where(and(eq(scorecardsTable.client_id, clientId), eq(scorecardsTable.company_id, companyId)))
        .orderBy(desc(scorecardsTable.created_at)),
      db.select().from(invoicesTable)
        .where(and(eq(invoicesTable.client_id, clientId), eq(invoicesTable.company_id, companyId)))
        .orderBy(desc(invoicesTable.created_at)).limit(20),
      db.select().from(jobsTable)
        .where(and(eq(jobsTable.client_id, clientId), eq(jobsTable.company_id, companyId)))
        .orderBy(desc(jobsTable.scheduled_date)).limit(50),
    ]);

    // Compute stats
    const now = new Date();
    const twelve_months_ago = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const revenue_all_time = invoices.reduce((s, i) => s + parseFloat(i.total || "0"), 0);
    const revenue_last_12mo = invoices
      .filter(i => i.paid_at && new Date(i.paid_at) >= twelve_months_ago)
      .reduce((s, i) => s + parseFloat(i.total || "0"), 0);
    const completed_jobs = jobs.filter(j => j.status === "complete");
    // [last-next-fix 2026-06-18] Compute via direct SQL, not the 50-most-recent
    // in-memory `jobs` slice — a client with hundreds of future jobs could push
    // the real last-completed out of the window, and the old next picked the
    // LATEST future job (desc order) instead of the soonest, even surfacing a
    // stale past 'scheduled' job. Last = most recent completed on/before today;
    // Next = soonest scheduled on/after today.
    const lastNextRes = await db.execute(sql`
      SELECT
        (SELECT MAX(scheduled_date) FROM jobs
           WHERE client_id = ${clientId} AND company_id = ${companyId}
             AND status = 'complete' AND scheduled_date <= CURRENT_DATE) AS last_cleaning,
        (SELECT MIN(scheduled_date) FROM jobs
           WHERE client_id = ${clientId} AND company_id = ${companyId}
             AND status::text IN ('scheduled','in_progress') AND scheduled_date >= CURRENT_DATE) AS next_cleaning
    `);
    const last_cleaning = (lastNextRes.rows[0] as any)?.last_cleaning ? String((lastNextRes.rows[0] as any).last_cleaning) : null;
    const next_cleaning = (lastNextRes.rows[0] as any)?.next_cleaning ? String((lastNextRes.rows[0] as any).next_cleaning) : null;
    const avg_bill_completed = completed_jobs.length ? revenue_all_time / completed_jobs.length : 0;
    const avg_bill = invoices.length ? revenue_all_time / invoices.length : 0;

    // [scheduling-engine 2026-04-29] Derived client_status + recurrence
    // + loyalty tier + tech consistency. Replaces the hardcoded
    // "ACTIVE / ONE-TIME" badge that read off `frequency` (which is
    // sometimes NULL or stale) and the rough loyalty math that didn't
    // match the spec's recency guard.
    const sixty_days_ago_ms = now.getTime() - 60 * 24 * 60 * 60 * 1000;
    const six_months_ago_ms = now.getTime() - 182 * 24 * 60 * 60 * 1000;
    const last_cleaning_ms = last_cleaning ? new Date(last_cleaning + "T00:00:00").getTime() : 0;

    // ACTIVE if any job in the last 60 days; otherwise INACTIVE.
    const client_status: "active" | "inactive" =
      last_cleaning_ms >= sixty_days_ago_ms || next_cleaning != null ? "active" : "inactive";

    // RECURRING if the client has any active recurring_schedules row.
    // [hotfix 2026-04-29] Column is `is_active`, not `active`. The bad
    // name caused Postgres 42703 missing-column on every full-profile
    // load, which the frontend surfaced as an indefinite "Loading client
    // profile…" spinner.
    const recurringRows = await db.execute(sql`
      SELECT 1 FROM recurring_schedules
       WHERE customer_id = ${clientId}
         AND company_id = ${companyId}
         AND COALESCE(is_active, true) = true
       LIMIT 1
    `);
    const client_recurrence: "recurring" | "one_time" = recurringRows.rows.length > 0 ? "recurring" : "one_time";

    // [commercial-workflow PR #2 / 2026-04-29] is_hybrid_client.
    //
    // True when the client has BOOKED jobs (status >= 'scheduled') in
    // BOTH residential AND commercial service-type parents within the
    // last 12 months. Quotes don't count — only an actual booked job
    // flips the flag. After 12 months of single-type behavior the flag
    // returns to false automatically (rolling window).
    //
    // Joins jobs.service_type::text against service_types.slug to get
    // the parent_slug. Jobs whose service_type isn't in service_types
    // (legacy slugs not yet seeded — only `recurring` per Sal's count
    // query, which is being cleaned up in PR #6) drop out of the JOIN
    // and don't contribute. That's the correct behavior — we don't
    // want conflated legacy data flipping clients to hybrid.
    const hybridRows = await db.execute(sql`
      WITH typed_jobs AS (
        SELECT DISTINCT s.parent_slug AS job_type
          FROM jobs j
          JOIN service_types s
            ON s.slug = j.service_type::text
           AND s.company_id = j.company_id
         WHERE j.client_id = ${clientId}
           AND j.company_id = ${companyId}
           AND j.status IN ('scheduled', 'in_progress', 'complete')
           AND j.scheduled_date >= (NOW() - INTERVAL '12 months')::date
      )
      SELECT COUNT(DISTINCT job_type)::int AS distinct_types FROM typed_jobs
    `);
    const distinct_types = Number((hybridRows.rows[0] as any)?.distinct_types ?? 0);
    const is_hybrid_client = distinct_types >= 2;

    // Loyalty tier — spec:
    //   no_tier  < $1000 lifetime OR no visit in the last 6 months
    //   bronze   $1000–$5000
    //   silver   $5000–$15000
    //   gold     $15000–$50000
    //   platinum $50000+
    const stale = last_cleaning_ms === 0 || last_cleaning_ms < six_months_ago_ms;
    const loyalty_tier: "no_tier" | "bronze" | "silver" | "gold" | "platinum" =
      stale || revenue_all_time < 1000 ? "no_tier"
      : revenue_all_time < 5000        ? "bronze"
      : revenue_all_time < 15000       ? "silver"
      : revenue_all_time < 50000       ? "gold"
      :                                  "platinum";

    // Tech consistency — unique techs across completed jobs ÷ total
    // completed visits. Low ratio (< 30%) means the client sees a lot
    // of different techs; the frontend can flag that as a churn risk.
    const techCount = completed_jobs.length === 0 ? null : await db.execute(sql`
      SELECT COUNT(DISTINCT jt.user_id)::int AS unique_techs
        FROM job_technicians jt
        JOIN jobs j ON j.id = jt.job_id
       WHERE j.client_id = ${clientId}
         AND j.company_id = ${companyId}
         AND j.status = 'complete'
    `);
    const unique_techs = techCount ? Number((techCount.rows[0] as any)?.unique_techs ?? 0) : 0;
    const tech_consistency = completed_jobs.length > 0
      ? Math.round((unique_techs / completed_jobs.length) * 100) / 100
      : null;

    // Look up zone data if client has a zone_id
    let zoneData: { zone_name: string; zone_color: string } | null = null;
    if (client.zone_id) {
      const [zone] = await db.select({ name: serviceZonesTable.name, color: serviceZonesTable.color })
        .from(serviceZonesTable).where(eq(serviceZonesTable.id, client.zone_id)).limit(1);
      if (zone) zoneData = { zone_name: zone.name, zone_color: zone.color };
    }

    // [per-home zone 2026-06-02] Each service address resolves its OWN zone
    // from its zip. The profile previously showed the single client-level
    // zone on every address card, so a home in a different area displayed
    // the wrong zone (Maribel: added a River Forest address, the card kept
    // the client's old Naperville zone). Match each home's zip against the
    // active service_zones zip_codes; leave it null when the zip matches no
    // zone — a visible gap is more honest than a confidently-wrong default.
    const activeZones = await db
      .select({ id: serviceZonesTable.id, name: serviceZonesTable.name, color: serviceZonesTable.color, zip_codes: serviceZonesTable.zip_codes })
      .from(serviceZonesTable)
      .where(and(eq(serviceZonesTable.company_id, companyId), eq(serviceZonesTable.is_active, true)));
    const homesWithZone = homes.map(h => {
      const clean = String(h.zip ?? "").trim().replace(/\D/g, "").slice(0, 5);
      const match = clean.length === 5 ? activeZones.find(z => z.zip_codes?.includes(clean)) : undefined;
      return { ...h, zone_id: match?.id ?? null, zone_name: match?.name ?? null, zone_color: match?.color ?? null };
    });

    // QuickBooks status — tenant connected + client synced?
    const [company] = await db.select({ qb_connected: companiesTable.qb_connected })
      .from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
    const [qbMap] = await db.select({ qb_customer_id: qbCustomerMapTable.qb_customer_id, synced_at: qbCustomerMapTable.created_at })
      .from(qbCustomerMapTable)
      .where(and(eq(qbCustomerMapTable.qleno_customer_id, clientId), eq(qbCustomerMapTable.company_id, companyId)))
      .limit(1);
    const qb_status = {
      connected: !!company?.qb_connected,
      synced: !!qbMap?.qb_customer_id,
      synced_at: qbMap?.synced_at ?? null,
      qb_customer_id: qbMap?.qb_customer_id ?? null,
    };

    // [invoice-service-date 2026-06-20] Attach each invoice's LIVE service date
    // (its linked job's scheduled_date) so the Billing tab shows the real service
    // date instead of created_at — which is a creation snapshot that goes stale
    // when a job is rescheduled. One batched lookup; null when job gone/unlinked.
    const invJobIds = invoices.map((i: any) => i.job_id).filter((x: any) => x != null);
    const invJobDates = new Map<number, string | null>();
    if (invJobIds.length) {
      const jrows = await db
        .select({ id: jobsTable.id, scheduled_date: jobsTable.scheduled_date })
        .from(jobsTable)
        .where(inArray(jobsTable.id, invJobIds));
      for (const j of jrows) invJobDates.set(j.id, (j.scheduled_date as any) ?? null);
    }
    const invoicesWithService = invoices.map((i: any) => ({
      ...i,
      service_date: i.job_id ? (invJobDates.get(i.job_id) ?? null) : null,
    }));
    // [invoice-order-fix] The base query orders by created_at, but the UI shows
    // (and users reason about) the SERVICE date. When an invoice is entered out
    // of sequence (late-billed or backfilled), created order and service-date
    // order disagree and the list looks scrambled. Re-sort by the displayed date
    // — service_date, falling back to created_at — newest first.
    invoicesWithService.sort((a: any, b: any) => {
      const key = (x: any) => String(x.service_date || x.created_at || "").slice(0, 10);
      return key(b).localeCompare(key(a));
    });

    return res.json({
      ...client,
      ...(zoneData || {}),
      qb_status,
      homes: homesWithZone,
      tech_preferences: preferences,
      notification_settings: notifications,
      scorecards,
      invoices: invoicesWithService,
      jobs: jobs.slice(0, 20),
      stats: {
        revenue_all_time,
        revenue_last_12mo,
        last_cleaning,
        next_cleaning,
        total_jobs: jobs.length,
        completed_jobs: completed_jobs.length,
        avg_bill,
        avg_bill_completed,
        scorecard_avg: scorecards.length ? scorecards.reduce((s, sc) => s + sc.score, 0) / scorecards.length : null,
        // [scheduling-engine 2026-04-29] Derived fields the profile
        // page needs to render the badge + tier + consistency flag
        // without re-deriving on the client.
        client_status,         // 'active' | 'inactive'
        client_recurrence,     // 'recurring' | 'one_time'
        // [commercial-workflow PR #2] true when the client has BOOKED
        // jobs in BOTH residential AND commercial service_types
        // parents within the last 12 months. Drives the JobWizard's
        // "show both option sets" hybrid flow.
        is_hybrid_client,
        loyalty_tier,          // 'no_tier' | 'bronze' | 'silver' | 'gold' | 'platinum'
        unique_techs,
        tech_consistency,      // unique_techs / completed_jobs (null when no completed)
      },
    });
  } catch (err) {
    console.error("Full profile error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── GET CLIENT QUOTE CONTEXT (preferred tech + recent services) ─────────────
router.get("/:id/quote-context", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;

    const [preferredTechResult, recentServicesResult, freqResult, homeResult] = await Promise.all([
      // Most frequent assigned technician from jobs table
      db.execute(sql`
        SELECT u.id, concat(u.first_name, ' ', u.last_name) AS full_name, COUNT(*) AS job_count
        FROM jobs j
        JOIN users u ON u.id = j.assigned_user_id
        WHERE j.client_id = ${clientId} AND j.company_id = ${companyId}
          AND j.assigned_user_id IS NOT NULL
          AND j.status IN ('complete','scheduled','in_progress')
        GROUP BY u.id, u.first_name, u.last_name
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `),
      // Last 20 jobs from job_history with service_type + revenue
      db.execute(sql`
        SELECT service_type, job_date, revenue
        FROM job_history
        WHERE company_id = ${companyId} AND customer_id = ${clientId}
          AND service_type IS NOT NULL AND service_type != ''
        ORDER BY job_date DESC
        LIMIT 20
      `),
      // Active recurring frequency
      db.execute(sql`
        SELECT frequency FROM recurring_schedules
        WHERE customer_id = ${clientId} AND company_id = ${companyId}
          AND is_active = true
        ORDER BY id DESC LIMIT 1
      `),
      // Primary home property details
      db.execute(sql`
        SELECT sq_footage, bedrooms, bathrooms, has_pets, access_notes, alarm_code, parking_notes
        FROM client_homes
        WHERE client_id = ${clientId} AND company_id = ${companyId}
        ORDER BY is_primary DESC NULLS LAST, id ASC
        LIMIT 1
      `),
    ]);

    const prefRow = preferredTechResult.rows[0] as any;
    const clientFreq = (freqResult.rows[0] as any)?.frequency ?? null;

    // Deduplicate by service_type, max 3 unique
    const seen = new Set<string>();
    const recentServices: Array<{ scope: string; last_date: string; last_price: number; frequency: string | null; addons: string[] }> = [];
    for (const row of recentServicesResult.rows as any[]) {
      const scope = row.service_type as string;
      if (seen.has(scope) || recentServices.length >= 3) continue;
      seen.add(scope);
      recentServices.push({
        scope,
        last_date: String(row.job_date),
        last_price: parseFloat(row.revenue) || 0,
        frequency: clientFreq,
        addons: [],
      });
    }

    const homeRow = homeResult.rows[0] as any;

    res.json({
      preferred_technician: prefRow ? {
        id: Number(prefRow.id),
        full_name: String(prefRow.full_name),
        job_count: parseInt(String(prefRow.job_count)),
      } : null,
      recent_services: recentServices,
      property: homeRow ? {
        sq_footage: parseInt(homeRow.sq_footage) || 0,
        bedrooms: parseInt(homeRow.bedrooms) || 0,
        bathrooms: parseInt(homeRow.bathrooms) || 0,
        has_pets: homeRow.has_pets ?? false,
        access_notes: homeRow.access_notes || null,
        alarm_code: homeRow.alarm_code || null,
        parking_notes: homeRow.parking_notes || null,
      } : null,
    });
  } catch (err) {
    console.error("Quote context error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── GET CLIENT ───────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const [client] = await db.select().from(clientsTable)
      .where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, req.auth!.companyId))).limit(1);
    if (!client) return res.status(404).json({ error: "Not Found" });
    const [recentJobs, statsResult, lastJob] = await Promise.all([
      db.select({ id: jobsTable.id, service_type: jobsTable.service_type, status: jobsTable.status, scheduled_date: jobsTable.scheduled_date, base_fee: jobsTable.base_fee })
        .from(jobsTable).where(and(eq(jobsTable.client_id, clientId), eq(jobsTable.company_id, req.auth!.companyId))).orderBy(desc(jobsTable.scheduled_date)).limit(10),
      db.select({ total_jobs: count(), total_revenue: sum(invoicesTable.total) })
        .from(jobsTable).leftJoin(invoicesTable, eq(invoicesTable.job_id, jobsTable.id))
        .where(and(eq(jobsTable.client_id, clientId), eq(jobsTable.company_id, req.auth!.companyId))),
      db.select({ scheduled_date: jobsTable.scheduled_date }).from(jobsTable)
        .where(and(eq(jobsTable.client_id, clientId), eq(jobsTable.status, "complete")))
        .orderBy(desc(jobsTable.scheduled_date)).limit(1),
    ]);
    return res.json({ ...client, recent_jobs: recentJobs, total_jobs: statsResult[0].total_jobs, total_revenue: statsResult[0].total_revenue ? parseFloat(statsResult[0].total_revenue) : 0, last_service_date: lastJob[0]?.scheduled_date || null });
  } catch (err) {
    console.error("Get client error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── CUSTOMER MESSAGE HISTORY ──────────────────────────────────────────────────
// Every automated + manual message we've sent this customer, newest first —
// unioned across notification_log (booking/reminder/completion/review sends),
// sms_messages (two-way texting), and communication_log (logged emails/SMS).
// Powers the "Messages" timeline on the customer profile. Office + up.
router.get("/:id/messages", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const clientId = parseInt(req.params.id);
    const [client] = await db.select({ email: clientsTable.email, phone: clientsTable.phone })
      .from(clientsTable)
      .where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, companyId))).limit(1);
    if (!client) return res.status(404).json({ error: "Not Found" });
    const email = client.email || "";
    const phone = client.phone || "";
    // [comms-by-phone 2026-06-26] Match texts by PHONE, not just client_id.
    // Two-way SMS often land on a duplicate client record (same number, second
    // profile) or with a null client_id, so a client_id-only match silently
    // drops real conversations. Normalize to the last 10 digits and match the
    // number on any of the SMS phone fields. Only used when we have a full
    // 10-digit number (else '' disables the phone match).
    const phoneDigits = (() => { const d = phone.replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; })();

    const result = await db.execute(sql`
      SELECT * FROM (
        SELECT nl.sent_at AS at, nl.channel::text AS channel, 'outbound'::text AS direction,
               nl.trigger::text AS type, nl.recipient::text AS recipient, nl.status::text AS status,
               (nl.metadata->>'subject')::text AS subject, (nl.metadata->>'body')::text AS body,
               (nl.metadata->>'html')::text AS email_html, 'automated'::text AS source,
               CASE WHEN nl.trigger = 'invoice_sent' THEN 'invoice' END::text AS doc_type,
               CASE WHEN nl.trigger = 'invoice_sent'
                    THEN (SELECT i.id FROM invoices i
                           WHERE i.company_id = nl.company_id AND i.client_id = ${clientId}
                             AND i.invoice_number = (nl.metadata->>'invoice_number') LIMIT 1)
               END AS doc_id
          FROM notification_log nl
         WHERE nl.company_id = ${companyId}
           AND (( ${email} <> '' AND nl.recipient = ${email}) OR ( ${phone} <> '' AND nl.recipient = ${phone}))
        UNION ALL
        SELECT created_at AS at, 'sms'::text AS channel, direction::text AS direction,
               'sms'::text AS type, COALESCE(to_number, from_number)::text AS recipient,
               status::text AS status, NULL::text AS subject, body::text AS body,
               NULL::text AS email_html, 'two_way'::text AS source,
               NULL::text AS doc_type, NULL::int AS doc_id
          FROM sms_messages
         WHERE company_id = ${companyId} AND (
               client_id = ${clientId}
            OR (${phoneDigits} <> '' AND RIGHT(regexp_replace(COALESCE(contact_phone, ''), '[^0-9]', '', 'g'), 10) = ${phoneDigits})
            OR (${phoneDigits} <> '' AND RIGHT(regexp_replace(COALESCE(to_number, ''),    '[^0-9]', '', 'g'), 10) = ${phoneDigits})
            OR (${phoneDigits} <> '' AND RIGHT(regexp_replace(COALESCE(from_number, ''),   '[^0-9]', '', 'g'), 10) = ${phoneDigits}))
        UNION ALL
        SELECT logged_at AS at, channel::text AS channel, direction::text AS direction,
               COALESCE(source, 'message')::text AS type, recipient::text AS recipient,
               delivery_status::text AS status, subject::text AS subject, body::text AS body,
               NULL::text AS email_html, 'logged'::text AS source,
               NULL::text AS doc_type, NULL::int AS doc_id
          FROM communication_log
         WHERE company_id = ${companyId} AND customer_id = ${clientId}
        UNION ALL
        SELECT sent_at AS at, channel::text AS channel, 'outbound'::text AS direction,
               COALESCE(sequence_name, 'message')::text AS type,
               COALESCE(recipient_email, recipient_phone)::text AS recipient,
               status::text AS status, subject::text AS subject, body::text AS body,
               CASE WHEN channel = 'email' AND body ~ '<[a-zA-Z]' THEN body END AS email_html,
               'cadence'::text AS source,
               NULL::text AS doc_type, NULL::int AS doc_id
          FROM message_log
         WHERE company_id = ${companyId} AND (
               client_id = ${clientId}
            OR (${email} <> '' AND recipient_email = ${email})
            OR (${phoneDigits} <> '' AND RIGHT(regexp_replace(COALESCE(recipient_phone, ''), '[^0-9]', '', 'g'), 10) = ${phoneDigits}))
      ) t
      ORDER BY at DESC NULLS LAST
      LIMIT 200`);

    return res.json({ data: result.rows });
  } catch (err) {
    console.error("Customer messages history error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── UPDATE CLIENT ─────────────────────────────────────────────────────────────
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const {
      first_name, last_name, email, phone, address, city, state, zip, notes, company_name,
      frequency, service_type, base_fee, allowed_hours, is_active, home_access_notes,
      alarm_code, pets, client_since,
      client_type, commercial_category, billing_contact_name, billing_contact_email, billing_contact_phone,
      po_number_required, default_po_number, payment_terms, auto_charge,
      card_last_four, card_brand, card_expiry, card_saved_at,
      payment_method, net_terms,
      commercial_hourly_rate,    // [AH] Per-client commercial hourly rate (commission engine)
      hourly_rate,               // [PR #60] Per-client hourly rate (Schedule Rate auto-calc)
      parking_fee_enabled, parking_fee_amount,
      cancel_fee_pct, lockout_fee_pct,  // Cancellation policy overrides (null = use tenant default)
      cancellation_notify_via,          // 'sms' | 'email' | 'both' | 'none'
    } = req.body;

    // [AH] Snapshot the previous commercial_hourly_rate so we can write a
    // client_audit_log row when it changes. The full audit_log table only
    // captures the new value; this gives proper before/after.
    const before = await db.select({
      commercial_hourly_rate: clientsTable.commercial_hourly_rate,
    }).from(clientsTable)
      .where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, req.auth!.companyId)))
      .limit(1);
    const prevRate = before[0]?.commercial_hourly_rate ?? null;
    const geo = address !== undefined ? await geocodeAddress(address, city, state, zip) : null;
    const newZoneId = zip !== undefined ? await resolveZoneForZip(req.auth!.companyId, zip) : undefined;
    const updated = await db.update(clientsTable).set({
      ...(first_name && { first_name }),
      ...(last_name && { last_name }),
      ...(email !== undefined && { email }),
      ...(phone !== undefined && { phone }),
      ...(company_name !== undefined && { company_name }),
      ...(address !== undefined && { address }),
      ...(city !== undefined && { city }),
      ...(state !== undefined && { state }),
      ...(zip !== undefined && { zip }),
      ...(notes !== undefined && { notes }),
      ...(frequency !== undefined && { frequency }),
      ...(service_type !== undefined && { service_type }),
      ...(base_fee !== undefined && { base_fee: String(base_fee) }),
      ...(allowed_hours !== undefined && { allowed_hours: String(allowed_hours) }),
      ...(is_active !== undefined && { is_active }),
      ...(home_access_notes !== undefined && { home_access_notes }),
      ...(alarm_code !== undefined && { alarm_code }),
      ...(pets !== undefined && { pets }),
      // [client-save-fix 2026-07-01] The edit drawer sends "" for an empty
      // Client Since; `client_since` is a DATE column and Postgres rejects ''
      // ("invalid input syntax for type date"), which failed the WHOLE update
      // and surfaced as a generic "Failed to save profile" for every client
      // with no Client Since. Coerce empty → null (the intended "unset").
      ...(client_since !== undefined && { client_since: client_since === "" ? null : client_since }),
      ...(geo && { lat: geo.lat, lng: geo.lng }),
      ...(client_type !== undefined && { client_type }),
      ...(commercial_category !== undefined && { commercial_category }),
      ...(billing_contact_name !== undefined && { billing_contact_name }),
      ...(billing_contact_email !== undefined && { billing_contact_email }),
      ...(billing_contact_phone !== undefined && { billing_contact_phone }),
      ...(po_number_required !== undefined && { po_number_required }),
      ...(default_po_number !== undefined && { default_po_number }),
      ...(payment_terms !== undefined && { payment_terms }),
      ...(auto_charge !== undefined && { auto_charge }),
      ...(card_last_four !== undefined && { card_last_four }),
      ...(card_brand !== undefined && { card_brand }),
      ...(card_expiry !== undefined && { card_expiry }),
      ...(card_saved_at !== undefined && { card_saved_at: card_saved_at === "" ? null : card_saved_at }),
      ...(payment_method !== undefined && { payment_method }),
      ...(net_terms !== undefined && { net_terms: Number(net_terms) || 0 }),
      ...(newZoneId !== undefined && { zone_id: newZoneId }),
      ...(commercial_hourly_rate !== undefined && {
        commercial_hourly_rate: commercial_hourly_rate === null || commercial_hourly_rate === ""
          ? null
          : String(commercial_hourly_rate),
      }),
      // [PR #60] Per-client hourly rate. Persisted explicitly so the
      // recurring-schedule editor's Schedule Rate auto-calc has a
      // first-class field rather than inferring from base_fee/allowed_hours.
      ...(hourly_rate !== undefined && {
        hourly_rate: hourly_rate === null || hourly_rate === ""
          ? null
          : String(hourly_rate),
      }),
      ...(parking_fee_enabled !== undefined && { parking_fee_enabled: !!parking_fee_enabled }),
      ...(parking_fee_amount !== undefined && {
        parking_fee_amount: parking_fee_amount === null || parking_fee_amount === ""
          ? null
          : String(parking_fee_amount),
      }),
      // Cancellation policy overrides — null/empty means "use tenant
      // default" (the dispatch cancel modal reads companies.default_*
      // when these are null). Clamp 0-100 so the UI can't push bad data.
      ...(cancel_fee_pct !== undefined && {
        cancel_fee_pct: cancel_fee_pct === null || cancel_fee_pct === ""
          ? null
          : String(Math.max(0, Math.min(100, Number(cancel_fee_pct)))),
      }),
      ...(lockout_fee_pct !== undefined && {
        lockout_fee_pct: lockout_fee_pct === null || lockout_fee_pct === ""
          ? null
          : String(Math.max(0, Math.min(100, Number(lockout_fee_pct)))),
      }),
      ...(cancellation_notify_via !== undefined && {
        cancellation_notify_via: ["sms", "email", "both", "none"].includes(cancellation_notify_via)
          ? cancellation_notify_via
          : "sms",
      }),
    }).where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, req.auth!.companyId))).returning();
    if (!updated[0]) return res.status(404).json({ error: "Not Found" });

    logAudit(req, "UPDATE", "client", clientId, null, updated[0]);

    // [AH] Per-field audit row for commercial_hourly_rate. Only writes when
    // the rate actually changed; null↔null is skipped.
    if (commercial_hourly_rate !== undefined) {
      const nextRate = updated[0].commercial_hourly_rate ?? null;
      const a = prevRate == null ? null : String(prevRate);
      const b = nextRate == null ? null : String(nextRate);
      if (a !== b) {
        try {
          const userRows = await db.execute(sql`
            SELECT first_name, last_name, email FROM users WHERE id = ${req.auth!.userId} LIMIT 1
          `);
          const u = (userRows.rows[0] as Record<string, unknown>) ?? {};
          const actorName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown";
          const actorEmail = String(u.email ?? "");
          await db.execute(sql`
            INSERT INTO client_audit_log
              (client_id, company_id, user_id, user_name, user_email,
               field_name, old_value, new_value)
            VALUES
              (${clientId}, ${req.auth!.companyId}, ${req.auth!.userId},
               ${actorName}, ${actorEmail},
               'commercial_hourly_rate',
               ${JSON.stringify(a)}::jsonb,
               ${JSON.stringify(b)}::jsonb)
          `);
        } catch (auditErr) {
          // Don't fail the update if audit insert fails — log and continue.
          console.warn("[AH] client_audit_log insert failed:", auditErr);
        }
      }
    }

    // QB sync (fire and forget)
    queueSync(() => syncCustomer(req.auth!.companyId, clientId));

    return res.json(updated[0]);
  } catch (err) {
    console.error("Update client error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── DELETE CLIENT ─────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    await db.delete(clientsTable).where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, req.auth!.companyId)));
    logAudit(req, "DELETE", "client", clientId, null, null);
    return res.json({ success: true });
  } catch (err) {
    console.error("Delete client error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── HOMES ────────────────────────────────────────────────────────────────────
router.get("/:id/homes", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const homes = await db.select().from(clientHomesTable)
      .where(and(eq(clientHomesTable.client_id, clientId), eq(clientHomesTable.company_id, req.auth!.companyId)))
      .orderBy(desc(clientHomesTable.is_primary));
    return res.json(homes);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/homes", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { name, address, city, state, zip, sq_footage, bedrooms, bathrooms, access_notes, alarm_code, has_pets, pet_notes, parking_notes, is_primary, base_fee, allowed_hours, frequency, service_type } = req.body;
    const geo = address ? await geocodeAddress(address, city, state, zip) : null;
    if (is_primary) {
      await db.update(clientHomesTable).set({ is_primary: false })
        .where(and(eq(clientHomesTable.client_id, clientId), eq(clientHomesTable.company_id, req.auth!.companyId)));
    }
    const [home] = await db.insert(clientHomesTable).values({
      company_id: req.auth!.companyId, client_id: clientId,
      name, address, city, state, zip, sq_footage, bedrooms, bathrooms,
      access_notes, alarm_code, has_pets, pet_notes, parking_notes, is_primary: is_primary ?? true,
      frequency, service_type,
      ...(base_fee && { base_fee: String(base_fee) }),
      ...(allowed_hours && { allowed_hours: String(allowed_hours) }),
      ...(geo && { lat: String(geo.lat), lng: String(geo.lng) }),
    }).returning();
    return res.status(201).json(home);
  } catch (err) {
    console.error("Create home error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id/homes/:homeId", requireAuth, async (req, res) => {
  try {
    const homeId = parseInt(req.params.homeId);
    const { name, address, city, state, zip, sq_footage, bedrooms, bathrooms, access_notes, alarm_code, has_pets, pet_notes, parking_notes, is_primary, base_fee, allowed_hours, frequency, service_type } = req.body;
    const geo = address ? await geocodeAddress(address, city, state, zip) : null;
    const [home] = await db.update(clientHomesTable).set({
      ...(name !== undefined && { name }),
      ...(address !== undefined && { address }),
      ...(city !== undefined && { city }),
      ...(state !== undefined && { state }),
      ...(zip !== undefined && { zip }),
      ...(sq_footage !== undefined && { sq_footage }),
      ...(bedrooms !== undefined && { bedrooms }),
      ...(bathrooms !== undefined && { bathrooms }),
      ...(access_notes !== undefined && { access_notes }),
      ...(alarm_code !== undefined && { alarm_code }),
      ...(has_pets !== undefined && { has_pets }),
      ...(pet_notes !== undefined && { pet_notes }),
      ...(parking_notes !== undefined && { parking_notes }),
      ...(is_primary !== undefined && { is_primary }),
      ...(frequency !== undefined && { frequency }),
      ...(service_type !== undefined && { service_type }),
      ...(base_fee !== undefined && { base_fee: String(base_fee) }),
      ...(allowed_hours !== undefined && { allowed_hours: String(allowed_hours) }),
      ...(geo && { lat: String(geo.lat), lng: String(geo.lng) }),
    }).where(and(eq(clientHomesTable.id, homeId), eq(clientHomesTable.company_id, req.auth!.companyId))).returning();

    // When an address is promoted to the main one, it must be the ONLY primary,
    // and the client-level zone follows it — the main address is what routing
    // (comms/assignments) keys off when there's no per-job address context.
    if (is_primary === true && home) {
      const clientId = parseInt(req.params.id);
      await db.update(clientHomesTable).set({ is_primary: false })
        .where(and(
          eq(clientHomesTable.client_id, clientId),
          eq(clientHomesTable.company_id, req.auth!.companyId),
          ne(clientHomesTable.id, homeId),
        ));
      const zoneId = await resolveZoneForZip(req.auth!.companyId, home.zip ?? "");
      if (zoneId) {
        await db.update(clientsTable).set({ zone_id: zoneId })
          .where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, req.auth!.companyId)));
      }
    }
    return res.json(home);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id/homes/:homeId", requireAuth, async (req, res) => {
  try {
    const homeId = parseInt(req.params.homeId);
    await db.delete(clientHomesTable).where(and(eq(clientHomesTable.id, homeId), eq(clientHomesTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── COMMUNICATIONS ────────────────────────────────────────────────────────────
router.get("/:id/communications", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { type } = req.query;
    const conditions: any[] = [
      eq(clientCommunicationsTable.client_id, clientId),
      eq(clientCommunicationsTable.company_id, req.auth!.companyId),
    ];
    if (type && type !== "all") conditions.push(eq(clientCommunicationsTable.type, type as string));
    const comms = await db.select({
      id: clientCommunicationsTable.id,
      type: clientCommunicationsTable.type,
      direction: clientCommunicationsTable.direction,
      subject: clientCommunicationsTable.subject,
      body: clientCommunicationsTable.body,
      from_name: clientCommunicationsTable.from_name,
      to_contact: clientCommunicationsTable.to_contact,
      has_attachment: clientCommunicationsTable.has_attachment,
      attachment_url: clientCommunicationsTable.attachment_url,
      created_at: clientCommunicationsTable.created_at,
      sent_by_first: usersTable.first_name,
      sent_by_last: usersTable.last_name,
    }).from(clientCommunicationsTable)
      .leftJoin(usersTable, eq(clientCommunicationsTable.sent_by, usersTable.id))
      // SMS now lives in the unified sms_messages store (canonical for in+out
      // threading), so exclude any legacy 'sms' rows here to avoid double-listing.
      .where(and(...conditions, ne(clientCommunicationsTable.type, "sms")))
      .orderBy(desc(clientCommunicationsTable.created_at));

    // Merge in the SMS thread (inbound + outbound) from sms_messages.
    let merged: any[] = comms as any[];
    if (!type || type === "all" || type === "sms") {
      const smsRows = await db.execute(sql`
        SELECT id, direction, body, from_number, to_number, status, read_at, created_at
          FROM sms_messages WHERE company_id = ${req.auth!.companyId} AND client_id = ${clientId}
          ORDER BY created_at DESC`);
      const sms = (smsRows.rows as any[]).map(r => ({
        id: `sms-${r.id}`, type: "sms", direction: r.direction, subject: null, body: r.body,
        from_name: r.direction === "inbound" ? r.from_number : null,
        to_contact: r.direction === "inbound" ? r.to_number : r.to_number,
        has_attachment: false, attachment_url: null, created_at: r.created_at,
        sent_by_first: null, sent_by_last: null, status: r.status,
      }));
      merged = type === "sms" ? sms : [...sms, ...(comms as any[])]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
    return res.json(merged);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/communications/note", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { body, subject } = req.body;
    const [comm] = await db.insert(clientCommunicationsTable).values({
      company_id: req.auth!.companyId, client_id: clientId,
      type: "note", direction: "internal", body, subject,
      from_name: req.auth!.email,
      sent_by: req.auth!.userId,
    }).returning();
    return res.status(201).json(comm);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/communications/sms", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { to, message } = req.body;
    let twilioResult: any = null;
    let fromNumber: string | null = null;
    let status = "suppressed";
    // Per-tenant send only — resolveSender(companyId) picks THIS company's creds
    // + from-number (full gate ladder). No global-env number.
    try {
      const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
      const sender = await resolveSender(req.auth!.companyId, null);
      fromNumber = sender.from_number;
      if (sender.reason) {
        console.log("[clients] Client SMS suppressed:", sender.reason);
      } else {
        twilioResult = await sendSmsVia(sender, to, message);
        status = "sent";
      }
    } catch (e: any) {
      status = "failed";
      console.error("[clients] Client SMS error:", e?.message || e);
    }
    // Persist into the unified SMS conversation store (canonical for threads/inbox).
    const { recordOutboundSms } = await import("../lib/sms-store.js");
    const { id } = await recordOutboundSms({
      companyId: req.auth!.companyId, toRaw: to, fromNumber, body: message,
      providerId: twilioResult?.sid ?? null, sentBy: req.auth!.userId, clientId, status,
    });
    return res.status(201).json({ id, direction: "outbound", type: "sms", body: message, to_contact: to, status, twilio: twilioResult });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/communications/email", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { to, subject, body } = req.body;
    const [comm] = await db.insert(clientCommunicationsTable).values({
      company_id: req.auth!.companyId, client_id: clientId,
      type: "email", direction: "outbound", body, subject, to_contact: to,
      from_name: req.auth!.email,
      sent_by: req.auth!.userId,
    }).returning();
    return res.status(201).json(comm);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── TECH PREFERENCES ─────────────────────────────────────────────────────────
router.get("/:id/tech-preferences", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const prefs = await db.select({
      id: technicianPreferencesTable.id,
      user_id: technicianPreferencesTable.user_id,
      preference: technicianPreferencesTable.preference,
      notes: technicianPreferencesTable.notes,
      created_at: technicianPreferencesTable.created_at,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
      avatar_url: usersTable.avatar_url,
    }).from(technicianPreferencesTable)
      .leftJoin(usersTable, eq(technicianPreferencesTable.user_id, usersTable.id))
      .where(and(eq(technicianPreferencesTable.client_id, clientId), eq(technicianPreferencesTable.company_id, req.auth!.companyId)));
    return res.json(prefs);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/tech-preferences", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { user_id, preference, notes } = req.body;
    const [pref] = await db.insert(technicianPreferencesTable).values({
      company_id: req.auth!.companyId, client_id: clientId, user_id, preference, notes,
    }).returning();
    return res.status(201).json(pref);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id/tech-preferences/:prefId", requireAuth, async (req, res) => {
  try {
    const prefId = parseInt(req.params.prefId);
    await db.delete(technicianPreferencesTable)
      .where(and(eq(technicianPreferencesTable.id, prefId), eq(technicianPreferencesTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── NOTIFICATIONS ─────────────────────────────────────────────────────────────
router.get("/:id/notifications", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const notifs = await db.select().from(clientNotificationsTable)
      .where(and(eq(clientNotificationsTable.client_id, clientId), eq(clientNotificationsTable.company_id, req.auth!.companyId)));
    return res.json(notifs);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/notifications", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { contact_value, contact_type, triggers } = req.body;
    const [notif] = await db.insert(clientNotificationsTable).values({
      company_id: req.auth!.companyId, client_id: clientId,
      contact_value, contact_type, triggers: triggers || [],
    }).returning();
    return res.status(201).json(notif);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id/notifications/:notifId", requireAuth, async (req, res) => {
  try {
    const notifId = parseInt(req.params.notifId);
    const { contact_value, contact_type, triggers, is_active } = req.body;
    const [notif] = await db.update(clientNotificationsTable).set({
      ...(contact_value !== undefined && { contact_value }),
      ...(contact_type !== undefined && { contact_type }),
      ...(triggers !== undefined && { triggers }),
      ...(is_active !== undefined && { is_active }),
    }).where(and(eq(clientNotificationsTable.id, notifId), eq(clientNotificationsTable.company_id, req.auth!.companyId))).returning();
    return res.json(notif);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id/notifications/:notifId", requireAuth, async (req, res) => {
  try {
    const notifId = parseInt(req.params.notifId);
    await db.delete(clientNotificationsTable)
      .where(and(eq(clientNotificationsTable.id, notifId), eq(clientNotificationsTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── CUSTOMER NOTIFICATION PREFERENCES ──────────────────────────────────────
// Which automated customer messages this client receives, per channel. For
// clients that belong to an account, prefs are controlled at the ACCOUNT level
// (an account has many properties/jobs) — the GET reports that so the UI can
// redirect the office to the account page instead of editing per-client.
router.get("/:id/notification-preferences", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;
    const [client] = await db.select({ id: clientsTable.id, company_id: clientsTable.company_id, account_id: clientsTable.account_id })
      .from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
    if (!assertClientAccess(client, companyId, res)) return;

    const { PREFERENCE_CATALOG, getScopeOverrides } = await import("../lib/notification-preferences.js");
    const managedByAccount = client.account_id != null;
    const scopeType = managedByAccount ? "account" : "client";
    const scopeId = managedByAccount ? Number(client.account_id) : clientId;
    const overrides = await getScopeOverrides(companyId, scopeType as any, scopeId);
    return res.json({
      catalog: PREFERENCE_CATALOG,
      overrides,
      scope_type: scopeType,
      managed_by_account: managedByAccount,
      account_id: managedByAccount ? Number(client.account_id) : null,
    });
  } catch (err) {
    console.error("[notif-prefs] GET client prefs error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/:id/notification-preferences", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;
    const [client] = await db.select({ id: clientsTable.id, company_id: clientsTable.company_id, account_id: clientsTable.account_id })
      .from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
    if (!assertClientAccess(client, companyId, res)) return;
    // Account clients are managed at the account scope — reject per-client writes
    // so the office can't set a pref that resolution would silently ignore.
    if (client.account_id != null) {
      return res.status(409).json({ error: "Managed by account", account_id: Number(client.account_id) });
    }
    const overrides = Array.isArray(req.body?.overrides) ? req.body.overrides : [];
    const { setScopeOverrides } = await import("../lib/notification-preferences.js");
    await setScopeOverrides(companyId, "client", clientId, overrides);
    await logAudit(req, "client.notification_preferences.update", "client", clientId, null, { count: overrides.length });
    return res.json({ success: true });
  } catch (err) {
    console.error("[notif-prefs] PUT client prefs error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── PORTAL INVITE ─────────────────────────────────────────────────────────────
router.post("/:id/portal-invite", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const [client] = await db.select().from(clientsTable)
      .where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, req.auth!.companyId))).limit(1);
    if (!client) return res.status(404).json({ error: "Not Found" });
    const token = crypto.randomBytes(32).toString("hex");
    await db.update(clientsTable).set({
      portal_invite_token: token,
      portal_invite_sent_at: new Date(),
    }).where(eq(clientsTable.id, clientId));
    await db.insert(clientCommunicationsTable).values({
      company_id: req.auth!.companyId, client_id: clientId,
      type: "system", direction: "outbound",
      body: `Portal invitation sent to ${client.email || "client"}`,
      from_name: "System",
    });
    return res.json({ success: true, token, message: "Invitation sent" });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── AGREEMENTS ────────────────────────────────────────────────────────────────
router.get("/:id/agreements", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const agreements = await db.select().from(clientAgreementsTable)
      .where(and(eq(clientAgreementsTable.client_id, clientId), eq(clientAgreementsTable.company_id, req.auth!.companyId)))
      .orderBy(desc(clientAgreementsTable.created_at));
    return res.json(agreements);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/agreements/send", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { template_name, home_id } = req.body;
    const [agreement] = await db.insert(clientAgreementsTable).values({
      company_id: req.auth!.companyId, client_id: clientId,
      home_id, template_name, sent_at: new Date(),
    }).returning();
    await db.insert(clientCommunicationsTable).values({
      company_id: req.auth!.companyId, client_id: clientId,
      type: "system", direction: "outbound",
      body: `Service agreement "${template_name || "Standard"}" sent to client`,
      from_name: "System", sent_by: req.auth!.userId,
    });
    return res.status(201).json(agreement);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── GEOCODE ALL ───────────────────────────────────────────────────────────────
router.post("/geocode-all", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(503).json({ error: "GOOGLE_MAPS_API_KEY not configured" });
  const clients = await db.select().from(clientsTable)
    .where(and(eq(clientsTable.company_id, req.auth!.companyId), sql`${clientsTable.address} IS NOT NULL`, sql`${clientsTable.lat} IS NULL`));
  let updated = 0;
  for (const client of clients) {
    const geo = await geocodeAddress(client.address!, client.city ?? undefined, client.state ?? undefined, client.zip ?? undefined);
    if (geo) {
      await db.update(clientsTable).set({ lat: geo.lat, lng: geo.lng }).where(eq(clientsTable.id, client.id));
      updated++;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // [mileage-account-coords 2026-07-08] Also geocode ACCOUNT PROPERTIES.
  // Commercial/account jobs (e.g. PPM turnovers) carry their address on the
  // account property, not a client — and those were never geocoded, so every
  // mileage leg touching an account job skipped for "no coords" and the tech's
  // mileage came out $0 (Sal: on 7/6 Alejandra's PPM legs "nothing populated").
  const props = await db.select().from(accountPropertiesTable)
    .where(and(eq(accountPropertiesTable.company_id, req.auth!.companyId), sql`${accountPropertiesTable.address} IS NOT NULL`, sql`${accountPropertiesTable.lat} IS NULL`));
  let propsUpdated = 0;
  for (const p of props) {
    const geo = await geocodeAddress(p.address!, p.city ?? undefined, p.state ?? undefined, p.zip ?? undefined);
    if (geo) {
      await db.update(accountPropertiesTable).set({ lat: geo.lat, lng: geo.lng }).where(eq(accountPropertiesTable.id, p.id));
      propsUpdated++;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return res.json({ geocoded: updated, total: clients.length, properties_geocoded: propsUpdated, properties_total: props.length });
});

// ─── CLIENT ACTIVITY FEED ────────────────────────────────────────────────────
// [client-activity 2026-06-04] One chronological audit feed of ALL activity for
// a client — job created/edited/rescheduled/cancelled/deleted, price changes,
// tech reassignments, client field edits, and communications. Aggregates the
// audit tables Qleno already writes (so it shows history retroactively) rather
// than dual-writing everywhere. Each source is independently try/caught so a
// missing table never blanks the feed. Office-only; scoped to client + company.
router.get("/:id/activity", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  const clientId = parseInt(req.params.id);
  if (isNaN(clientId)) return res.status(400).json({ error: "Invalid id" });
  const companyId = req.auth!.companyId;
  const limit = Math.min(parseInt(String(req.query.limit ?? "200")) || 200, 500);

  type Ev = { event_type: string; occurred_at: string; user_name: string | null; field_name: string | null; old_value: any; new_value: any; related_job_id: number | null; related_job_date: string | null; action: string | null };
  // Job's scheduled_date (YYYY-MM-DD) — lets the frontend deep-link the
  // "Job #N" tag to the dispatch board (/dispatch?date=…&job=…), which loads
  // by date. Null when the job is gone (deletes) or the event has no job.
  const jobDate = (v: any): string | null => (v ? String(v).slice(0, 10) : null);
  const events: Ev[] = [];

  // All five audit tables use zone-less timestamps stored in UTC; the raw
  // driver hands them back as bare strings ("2026-07-07 12:08:34") which
  // browsers parse as LOCAL time — Maribel saw a 7:08 AM cancellation
  // rendered as 12:08 PM. Normalize to explicit-UTC ISO (same fix as leave.ts).
  const utcIso = (v: any): string => {
    if (v == null) return "";
    if (v instanceof Date) return v.toISOString();
    const s = String(v);
    return /Z$|[+-]\d{2}:?\d{2}$/.test(s)
      ? new Date(s).toISOString()
      : new Date(s.replace(" ", "T") + "Z").toISOString();
  };

  // 1. Per-field job edits (price changes, reschedule-by-edit, reassignments…)
  try {
    const r = await db.execute(sql`
      SELECT jal.edited_at, jal.user_name, jal.field_name, jal.old_value, jal.new_value, jal.job_id, jal.cascade_scope, j.scheduled_date
      FROM job_audit_log jal JOIN jobs j ON jal.job_id = j.id
      WHERE j.client_id = ${clientId} AND jal.company_id = ${companyId}
      ORDER BY jal.edited_at DESC LIMIT ${limit}`);
    for (const x of r.rows as any[]) events.push({ event_type: "job_edit", occurred_at: x.edited_at, user_name: x.user_name, field_name: x.field_name, old_value: x.old_value, new_value: x.new_value, related_job_id: x.job_id != null ? Number(x.job_id) : null, related_job_date: jobDate(x.scheduled_date), action: x.cascade_scope ?? null });
  } catch (e) { console.error("[client-activity] job_audit_log:", (e as any)?.message); }

  // 2. Client field edits + job deletions (delete writes here via logClientActivity)
  try {
    const r = await db.execute(sql`
      SELECT edited_at, user_name, field_name, old_value, new_value
      FROM client_audit_log
      WHERE client_id = ${clientId} AND company_id = ${companyId}
      ORDER BY edited_at DESC LIMIT ${limit}`);
    for (const x of r.rows as any[]) events.push({ event_type: x.field_name === "job_deleted" ? "job_deleted" : "client_edit", occurred_at: x.edited_at, user_name: x.user_name, field_name: x.field_name, old_value: x.old_value, new_value: x.new_value, related_job_id: x.old_value?.job_id ?? null, related_job_date: null, action: null });
  } catch (e) { console.error("[client-activity] client_audit_log:", (e as any)?.message); }

  // 3. Cancellations / reschedules / lockouts
  try {
    const r = await db.execute(sql`
      SELECT cl.cancelled_at, cl.cancel_action, cl.cancel_reason, cl.customer_charge_amount, cl.notes, cl.job_id, jb.scheduled_date,
             NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS user_name
      FROM cancellation_log cl LEFT JOIN users u ON cl.cancelled_by = u.id LEFT JOIN jobs jb ON cl.job_id = jb.id
      WHERE cl.customer_id = ${clientId} AND cl.company_id = ${companyId}
      ORDER BY cl.cancelled_at DESC LIMIT ${limit}`);
    for (const x of r.rows as any[]) events.push({ event_type: (x.cancel_action === "move" || x.cancel_action === "bump") ? "job_rescheduled" : "job_cancelled", occurred_at: x.cancelled_at, user_name: x.user_name, field_name: x.cancel_action, old_value: null, new_value: { reason: x.cancel_reason, charge: x.customer_charge_amount, notes: x.notes }, related_job_id: x.job_id != null ? Number(x.job_id) : null, related_job_date: jobDate(x.scheduled_date), action: x.cancel_action });
  } catch (e) { console.error("[client-activity] cancellation_log:", (e as any)?.message); }

  // 4. Communications (SMS / email / calls / notes)
  try {
    const r = await db.execute(sql`
      SELECT com.logged_at, com.channel, com.direction, com.summary, com.subject, com.job_id, jb.scheduled_date,
             NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS user_name
      FROM communication_log com LEFT JOIN users u ON com.logged_by = u.id LEFT JOIN jobs jb ON com.job_id = jb.id
      WHERE com.customer_id = ${clientId} AND com.company_id = ${companyId}
      ORDER BY com.logged_at DESC LIMIT ${limit}`);
    for (const x of r.rows as any[]) events.push({ event_type: "communication", occurred_at: x.logged_at, user_name: x.user_name, field_name: x.channel, old_value: null, new_value: { direction: x.direction, summary: x.summary, subject: x.subject }, related_job_id: x.job_id != null ? Number(x.job_id) : null, related_job_date: jobDate(x.scheduled_date), action: x.direction });
  } catch (e) { console.error("[client-activity] communication_log:", (e as any)?.message); }

  // 5. Creations (job + client) from the global audit log
  try {
    const r = await db.execute(sql`
      SELECT aal.performed_at, aal.action, aal.target_type, aal.target_id, aal.new_value, jj.scheduled_date,
             NULLIF(TRIM(COALESCE(au.first_name,'') || ' ' || COALESCE(au.last_name,'')), '') AS user_name
      FROM app_audit_log aal
      LEFT JOIN users au ON aal.performed_by = au.id
      LEFT JOIN jobs jj ON aal.target_type = 'job' AND aal.target_id ~ '^[0-9]+$' AND aal.target_id::int = jj.id
      WHERE aal.company_id = ${companyId} AND aal.action = 'CREATE'
        AND ((aal.target_type = 'client' AND aal.target_id = ${String(clientId)})
          OR (aal.target_type = 'job' AND jj.client_id = ${clientId}))
      ORDER BY aal.performed_at DESC LIMIT ${limit}`);
    for (const x of r.rows as any[]) events.push({ event_type: x.target_type === "job" ? "job_created" : "client_created", occurred_at: x.performed_at, user_name: x.user_name, field_name: null, old_value: null, new_value: x.new_value, related_job_id: x.target_type === "job" ? Number(x.target_id) : null, related_job_date: jobDate(x.scheduled_date), action: x.action });
  } catch (e) { console.error("[client-activity] app_audit_log:", (e as any)?.message); }

  for (const e of events) e.occurred_at = utcIso(e.occurred_at);
  events.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  return res.json({ events: events.slice(0, limit) });
});

// ─── GET JOB HISTORY (from job_history table, mc_import + future sources) ─────
router.get("/:id/job-history", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;

    // Deduplicate on (job_date, technician, revenue) — prevents double-rows from deployment race conditions
    const rows = await db.execute(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (job_date, technician, revenue)
          id, job_date, revenue, service_type, technician, notes
        FROM job_history
        WHERE company_id = ${companyId} AND customer_id = ${clientId}
        ORDER BY job_date, technician, revenue, id
      ) t
      ORDER BY job_date DESC
    `);

    const histRecords = rows.rows as Array<{
      id: number; job_date: string; revenue: string;
      service_type: string | null; technician: string | null; notes: string | null;
    }>;

    // [history-unify 2026-06-30] job_history is the frozen MaidCentral import; it
    // stops at the cutover and never grows. After we switch off MC, completed work
    // lives in `jobs`, so Job History / Total Visits / Lifetime Revenue would
    // silently freeze. Append completed live jobs dated STRICTLY AFTER this
    // client's last imported visit — that keeps every historical number identical
    // (no double-count, no shift) while letting post-cutover work flow in. A
    // client with no import history (born in Qleno) gets all their completed jobs.
    const lastHistDate = histRecords.reduce<string | null>(
      (mx, r) => (r.job_date && (!mx || r.job_date > mx) ? r.job_date : mx), null);
    const liveRes = await db.execute(sql`
      SELECT j.id, j.scheduled_date::text AS job_date, j.billed_amount,
             j.service_type, (u.first_name || ' ' || u.last_name) AS technician
      FROM jobs j
      LEFT JOIN users u ON u.id = j.assigned_user_id
      WHERE j.client_id = ${clientId} AND j.company_id = ${companyId}
        AND j.status::text IN ('complete','invoiced')
        ${lastHistDate ? sql`AND j.scheduled_date > ${lastHistDate}::date` : sql``}
      ORDER BY j.scheduled_date DESC
    `);
    const liveRecords = (liveRes.rows as any[]).map(r => ({
      // Negative id: live jobs and job_history share an id space, and the table
      // uses id as its React key. Negating the (positive) job id guarantees a
      // unique, collision-free key distinct from every positive job_history id.
      id: -Number(r.id),
      job_date: String(r.job_date),
      revenue: String(r.billed_amount ?? 0),
      service_type: r.service_type ?? null,
      technician: (r.technician && String(r.technician).trim()) || null,
      notes: null as string | null,
    }));
    // Live rows are strictly newer than every imported row, so plain concat keeps
    // the overall newest-first order the response and stats rely on.
    const records = [...liveRecords, ...histRecords];

    // [last-next-fix 2026-06-18] Last = most recent COMPLETED job on/before
    // today (records[0] could be a future or non-completed row → showed a
    // nonsensical "Next before Last"); Next = soonest scheduled on/after today.
    const lastJobRes = await db.execute(sql`
      SELECT MAX(scheduled_date) AS d FROM jobs
      WHERE client_id = ${clientId} AND company_id = ${companyId}
        AND status = 'complete' AND scheduled_date <= CURRENT_DATE
    `);
    const last_cleaning: string | null = (lastJobRes.rows[0] as any)?.d
      ? String((lastJobRes.rows[0] as any).d) : null;

    const nextJobRes = await db.execute(sql`
      SELECT MIN(scheduled_date) AS d FROM jobs
      WHERE client_id = ${clientId} AND company_id = ${companyId}
        AND status::text IN ('scheduled','in_progress') AND scheduled_date >= CURRENT_DATE
    `);
    const next_cleaning: string | null = (nextJobRes.rows[0] as any)?.d
      ? String((nextJobRes.rows[0] as any).d) : null;

    // Is this client on an active recurring schedule?
    const recurrRes = await db.execute(sql`
      SELECT id FROM recurring_schedules
      WHERE customer_id = ${clientId} AND company_id = ${companyId} AND is_active = true
      LIMIT 1
    `);
    const is_recurring = recurrRes.rows.length > 0;

    // [stats-fix 2026-06-30] Skips and bumps. These USED to read jobs.status =
    // 'skipped'/'bumped', but the job_status enum only has
    // scheduled/in_progress/complete/cancelled — those values never exist, so
    // the counters were permanently 0. Skip/bump/move are recorded as
    // cancellation_log actions, so count them there. (move = customer-initiated
    // reschedule, bump = office-initiated; both surface as "Bumps".)
    let skips = 0;
    let bumps = 0;
    try {
      const statusRes = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE cl.cancel_action = 'skip') AS skips,
          COUNT(*) FILTER (WHERE cl.cancel_action IN ('bump','move')) AS bumps
        FROM cancellation_log cl
        JOIN jobs j ON j.id = cl.job_id
        WHERE j.client_id = ${clientId} AND j.company_id = ${companyId}
      `);
      skips = parseInt(String((statusRes.rows[0] as any)?.skips ?? 0));
      bumps = parseInt(String((statusRes.rows[0] as any)?.bumps ?? 0));
    } catch (_err) {
      // Defensive: if cancellation_log is unavailable, fall back to 0.
    }

    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    const priorSixStart = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());

    const total_revenue = records.reduce((s, r) => s + parseFloat(r.revenue), 0);
    const ytdStart = new Date().getFullYear();
    const ytd_revenue = records
      .filter(r => new Date(r.job_date).getFullYear() >= ytdStart)
      .reduce((s, r) => s + parseFloat(r.revenue), 0);
    const total_visits = records.length;
    const unique_techs = new Set(records.map(r => r.technician).filter(Boolean)).size;
    // Earliest real visit — drives the "Since" date on the Lifetime Value card.
    // Previously the card fell back to clients.created_at (the Qleno import date),
    // which misreported a 2024 client as "Since Mar 2026".
    const first_cleaning = records.reduce<string | null>(
      (mn, r) => (r.job_date && (!mn || r.job_date < mn) ? r.job_date : mn), null);

    const last12 = records.filter(r => new Date(r.job_date) >= twelveMonthsAgo);
    const revenue_last_12mo = last12.reduce((s, r) => s + parseFloat(r.revenue), 0);
    const avg_bill = last12.length > 0 ? revenue_last_12mo / last12.length : (records.length > 0 ? total_revenue / total_visits : 0);

    const last6Rev = records.filter(r => new Date(r.job_date) >= sixMonthsAgo).reduce((s, r) => s + parseFloat(r.revenue), 0);
    const prior6Rev = records.filter(r => {
      const d = new Date(r.job_date);
      return d >= priorSixStart && d < sixMonthsAgo;
    }).reduce((s, r) => s + parseFloat(r.revenue), 0);

    const revenue_trend_pct = prior6Rev > 0 ? ((last6Rev - prior6Rev) / prior6Rev) * 100 : null;

    // Pending jobs count
    let pending_jobs = 0;
    try {
      const pendingRes = await db.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM jobs
        WHERE client_id = ${clientId} AND company_id = ${companyId}
          AND status::text = 'scheduled' AND scheduled_date >= CURRENT_DATE
      `);
      pending_jobs = parseInt(String((pendingRes.rows[0] as any)?.cnt ?? 0));
    } catch (_err) { /* default 0 */ }

    // eCard % — scorecards submitted / total visits
    let ecard_pct = 0;
    if (total_visits > 0) {
      try {
        const scRes = await db.execute(sql`
          SELECT COUNT(*)::int AS cnt FROM scorecards
          WHERE client_id = ${clientId} AND company_id = ${companyId} AND (excluded IS NULL OR excluded = false)
        `);
        const scCount = parseInt(String((scRes.rows[0] as any)?.cnt ?? 0));
        ecard_pct = Math.round((scCount / total_visits) * 100);
      } catch (_err) { /* default 0 */ }
    }

    return res.json({
      rows: records,
      stats: {
        total_revenue,
        ytd_revenue,
        total_visits,
        unique_techs,
        first_cleaning,
        revenue_last_12mo,
        avg_bill,
        revenue_trend_pct,
        last_cleaning,
        next_cleaning,
        is_recurring,
        skips,
        bumps,
        pending_jobs,
        ecard_pct,
      },
    });
  } catch (err) {
    console.error("Job history error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── GET CLIENT QUOTES ────────────────────────────────────────────────────────
router.get("/:id/quotes", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const rows = await db.select().from(quotesTable)
      .where(and(eq(quotesTable.client_id, clientId), eq(quotesTable.company_id, companyId)))
      .orderBy(desc(quotesTable.created_at));
    return res.json(rows);
  } catch (err) {
    console.error("Client quotes error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── GET CLIENT CONTACT TICKETS ───────────────────────────────────────────────
router.get("/:id/contact-tickets", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const rows = await db.select({
      id: contactTicketsTable.id,
      ticket_type: contactTicketsTable.ticket_type,
      notes: contactTicketsTable.notes,
      job_id: contactTicketsTable.job_id,
      created_at: contactTicketsTable.created_at,
      created_by_first: usersTable.first_name,
      created_by_last: usersTable.last_name,
    })
      .from(contactTicketsTable)
      .leftJoin(usersTable, eq(contactTicketsTable.created_by, usersTable.id))
      .where(and(eq(contactTicketsTable.client_id, clientId), eq(contactTicketsTable.company_id, companyId)))
      .orderBy(desc(contactTicketsTable.created_at));
    return res.json(rows);
  } catch (err) {
    console.error("Contact tickets error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── POST CLIENT CONTACT TICKET ───────────────────────────────────────────────
router.post("/:id/contact-tickets", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const { ticket_type, notes, job_id } = req.body;
    const [row] = await db.insert(contactTicketsTable).values({
      client_id: clientId,
      company_id: companyId,
      user_id: req.auth!.userId,
      created_by: req.auth!.userId,
      ticket_type,
      notes,
      job_id: job_id || null,
    }).returning();
    return res.json(row);
  } catch (err) {
    console.error("Create ticket error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── GET CLIENT ATTACHMENTS ───────────────────────────────────────────────────
router.get("/:id/attachments", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const rows = await db.select({
      id: clientAttachmentsTable.id,
      name: clientAttachmentsTable.name,
      file_url: clientAttachmentsTable.file_url,
      file_type: clientAttachmentsTable.file_type,
      file_size: clientAttachmentsTable.file_size,
      category: clientAttachmentsTable.category,
      created_at: clientAttachmentsTable.created_at,
      uploader_first: usersTable.first_name,
      uploader_last: usersTable.last_name,
    })
      .from(clientAttachmentsTable)
      .leftJoin(usersTable, eq(clientAttachmentsTable.uploaded_by, usersTable.id))
      .where(and(eq(clientAttachmentsTable.client_id, clientId), eq(clientAttachmentsTable.company_id, companyId)))
      .orderBy(desc(clientAttachmentsTable.created_at));
    return res.json(rows);
  } catch (err) {
    console.error("Attachments error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── GET CLIENT RECURRING SCHEDULE ───────────────────────────────────────────
// ─── PATCH RECURRING SCHEDULE ─────────────────────────────────────────────────
router.patch("/:id/recurring-schedule", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const {
      frequency, day_of_week, duration_minutes, base_fee, service_type, notes,
      // Time-of-day for the recurring visit ("HH:MM"). null clears it.
      scheduled_time,
      // [AI.6] Parking fee per-occurrence config. days uses 0=Sun..6=Sat;
      // null/empty days = "apply to every scheduled occurrence."
      parking_fee_enabled, parking_fee_amount, parking_fee_days,
      // [PR #58] Anchor days for monthly + semi_monthly. Sentinel 0 = "last day".
      days_of_month,
      // [PR #58] N for "every N weeks" custom cadence (frequency='custom').
      custom_frequency_weeks,
      // [audit BUG #3] cascade flag — default true. When true, the
      // schedule's rate / hours / service_type / frequency changes
      // also propagate to existing future scheduled jobs linked to
      // this schedule. Operator can pass cascade=false to update only
      // the template (used by silent backfills and tests).
      cascade,
    } = req.body;
    const updated = await db.update(recurringSchedulesTable).set({
      ...(frequency && { frequency }),
      ...(day_of_week !== undefined && { day_of_week }),
      ...(duration_minutes !== undefined && { duration_minutes: duration_minutes === "" ? null : parseInt(String(duration_minutes)) || null }),
      ...(base_fee !== undefined && { base_fee: base_fee === "" ? null : String(base_fee) }),
      ...(service_type !== undefined && { service_type }),
      ...(scheduled_time !== undefined && { scheduled_time: scheduled_time === "" || scheduled_time === null ? null : scheduled_time }),
      ...(notes !== undefined && { notes }),
      ...(parking_fee_enabled !== undefined && { parking_fee_enabled: !!parking_fee_enabled }),
      ...(parking_fee_amount !== undefined && {
        parking_fee_amount: parking_fee_amount === null || parking_fee_amount === "" ? null : String(parking_fee_amount),
      }),
      ...(parking_fee_days !== undefined && {
        parking_fee_days: Array.isArray(parking_fee_days) && parking_fee_days.length > 0
          ? parking_fee_days.filter((n: unknown) => typeof n === "number" && (n as number) >= 0 && (n as number) <= 6)
          : null,
      }),
      // [PR #58] days_of_month: validate 0–31. Sentinel 0 means "last day"
      // and the engine resolves per-month. Empty array stored as NULL so
      // queries can use IS NULL semantics (mirrors parking_fee_days).
      ...(days_of_month !== undefined && {
        days_of_month: Array.isArray(days_of_month) && days_of_month.length > 0
          ? days_of_month.filter((n: unknown) => typeof n === "number" && (n as number) >= 0 && (n as number) <= 31)
          : null,
      }),
      // [PR #58] custom_frequency_weeks: 1..52 only — "every N weeks".
      ...(custom_frequency_weeks !== undefined && {
        custom_frequency_weeks: custom_frequency_weeks === null || custom_frequency_weeks === ""
          ? null
          : Math.max(1, Math.min(52, parseInt(String(custom_frequency_weeks)) || 0)) || null,
      }),
    }).where(and(
      eq(recurringSchedulesTable.customer_id, clientId),
      eq(recurringSchedulesTable.company_id, companyId),
      eq(recurringSchedulesTable.is_active, true),
    )).returning();

    // [PR #59] If no active schedule existed (operator is converting a
    // one-time client to recurring via the consolidated Service Details
    // editor), INSERT the schedule. UPSERT semantics so the same endpoint
    // handles "first save" + "subsequent edits" — no separate POST route.
    // Required fields fall back to safe defaults (start_date = today,
    // is_active=true). The day_of_week / days_of_month / etc. that the
    // operator just picked land on the new row.
    if (!updated[0] && frequency) {
      const today = new Date().toISOString().slice(0, 10);
      const inserted = await db.insert(recurringSchedulesTable).values({
        company_id: companyId,
        customer_id: clientId,
        frequency: frequency as any,
        day_of_week: day_of_week || null,
        start_date: today,
        is_active: true,
        service_type: service_type ?? null,
        scheduled_time: scheduled_time || null,
        duration_minutes: duration_minutes === "" || duration_minutes == null
          ? null
          : (parseInt(String(duration_minutes)) || null),
        base_fee: base_fee === "" || base_fee == null ? null : String(base_fee),
        notes: notes ?? null,
        parking_fee_enabled: !!parking_fee_enabled,
        parking_fee_amount: parking_fee_amount === null || parking_fee_amount === "" || parking_fee_amount == null
          ? null
          : String(parking_fee_amount),
        parking_fee_days: Array.isArray(parking_fee_days) && parking_fee_days.length > 0
          ? parking_fee_days.filter((n: unknown) => typeof n === "number" && (n as number) >= 0 && (n as number) <= 6)
          : null,
        days_of_month: Array.isArray(days_of_month) && days_of_month.length > 0
          ? days_of_month.filter((n: unknown) => typeof n === "number" && (n as number) >= 0 && (n as number) <= 31)
          : null,
        custom_frequency_weeks: custom_frequency_weeks === null || custom_frequency_weeks === "" || custom_frequency_weeks == null
          ? null
          : (Math.max(1, Math.min(52, parseInt(String(custom_frequency_weeks)) || 0)) || null),
      } as any).returning();
      updated[0] = inserted[0];
    }

    // [PR #59] Mirror schedule fields back onto clients.* columns so the
    // legacy code paths that read them (booking widget defaults, quote
    // builder, scattered display surfaces) stay correct. The customer
    // profile UI no longer surfaces these — the schedule is the single
    // source of truth — but the data drift from old code reading
    // clients.frequency would surface stale values otherwise.
    //
    // [PR #60] Also recompute clients.hourly_rate when base_fee or
    // duration_minutes change. The recurring-schedule editor's Schedule
    // Rate auto-calc treats hourly_rate as first-class, so keep it in
    // sync with whatever (rate, hours) the operator just saved.
    if (updated[0]) {
      const sched = updated[0] as any;
      const newBaseFee = base_fee === "" || base_fee == null ? null : Number(base_fee);
      const newAllowedHours = duration_minutes === "" || duration_minutes == null
        ? null
        : Number(duration_minutes) / 60;
      const computedHourlyRate = newBaseFee != null && newAllowedHours != null && newAllowedHours > 0
        ? Number((newBaseFee / newAllowedHours).toFixed(2))
        : null;
      await db.update(clientsTable).set({
        ...(frequency && { frequency: String(frequency) }),
        ...(service_type !== undefined && { service_type: service_type ?? null }),
        ...(base_fee !== undefined && {
          base_fee: newBaseFee == null ? null : String(newBaseFee),
        }),
        ...(duration_minutes !== undefined && {
          allowed_hours: newAllowedHours == null ? null : String(newAllowedHours.toFixed(2)),
        }),
        ...((base_fee !== undefined || duration_minutes !== undefined) && computedHourlyRate != null && {
          hourly_rate: String(computedHourlyRate),
        }),
      }).where(and(
        eq(clientsTable.id, clientId),
        eq(clientsTable.company_id, companyId),
      ));
    }

    // [audit BUG #3] Cascade rate / hours / service_type / frequency
    // changes to existing future scheduled jobs. Without this, operators
    // editing the customer-profile schedule saw their changes vanish on
    // "next visit" because the existing job rows were frozen at their
    // original migration-time values. Mirrors the edit-job modal's
    // cascade=this_and_future behavior, scoped to the same client +
    // schedule.
    //
    // NOT cascaded: parking_fee_*, day_of_week, notes. Parking has its
    // own per-job stamping flow (job_add_ons rows are added by the
    // engine at generation time; updating the template doesn't
    // retroactively stamp existing jobs — operator opens the edit-job
    // modal to flip parking on individual occurrences). day_of_week
    // changes the *scheduled_date* of future visits, which is the
    // engine's job, not a row update. Notes are template-only.
    let cascadeUpdated = 0;
    const shouldCascade = cascade !== false && updated[0];
    const hasCascadableField = base_fee !== undefined
      || duration_minutes !== undefined
      || service_type !== undefined
      || frequency !== undefined;
    if (shouldCascade && hasCascadableField) {
      const today = new Date().toISOString().slice(0, 10);
      // Build the SET clause dynamically — only include fields the
      // operator actually changed, mirror jobs columns from the new
      // schedule values. allowed_hours is the per-job analogue of
      // duration_minutes (jobs stores hours, not minutes).
      const setFragments: any[] = [];
      if (base_fee !== undefined) {
        const v = base_fee === "" ? null : String(base_fee);
        setFragments.push(sql`base_fee = ${v}`);
      }
      if (duration_minutes !== undefined) {
        const mins = duration_minutes === "" ? null : parseInt(String(duration_minutes)) || null;
        const hrs = mins == null ? null : (mins / 60).toFixed(2);
        setFragments.push(sql`allowed_hours = ${hrs}`);
      }
      if (service_type !== undefined) {
        // [PR #61] After PR #57 the Service Type dropdown stores the
        // readable scope name ("Standard Clean") instead of the slug
        // ("standard_clean"). The jobs.service_type enum only accepts
        // slug values — casting "Standard Clean"::service_type fails
        // and aborts the entire save with "Failed to save changes."
        // Convert to slug + validate against the enum allowlist before
        // cascading. If the value isn't a recognized enum, skip the
        // cascade for service_type (the schedule template still updates
        // — just doesn't rewrite existing jobs' service_type).
        const validEnumSlugs = new Set([
          "standard_clean", "deep_clean", "move_out", "recurring",
          "post_construction", "move_in", "office_cleaning",
          "common_areas", "retail_store", "medical_office",
          "ppm_turnover", "post_event", "ppm_common_areas",
          "commercial_cleaning", "recurring_commercial_cleaning", "turnover",
        ]);
        const slugify = (s: string) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
        const candidate = service_type ? slugify(String(service_type)) : "";
        if (candidate && validEnumSlugs.has(candidate)) {
          setFragments.push(sql`service_type = ${candidate}::service_type`);
        } else if (service_type) {
          console.warn(`[recurring-schedule cascade] skipping service_type cast — "${service_type}" doesn't match a known enum slug. Schedule template updated; jobs.service_type left unchanged.`);
        }
      }
      if (frequency !== undefined) {
        // [PR #61] Defensive cast for frequency too. Belt-and-suspenders
        // against future UI changes that might pass non-canonical values.
        const validFreqs = new Set([
          "weekly", "biweekly", "every_3_weeks", "monthly", "on_demand",
          "daily", "weekdays", "custom_days", "semi_monthly",
        ]);
        if (frequency && validFreqs.has(String(frequency))) {
          setFragments.push(sql`frequency = ${frequency}::frequency`);
        } else if (frequency) {
          console.warn(`[recurring-schedule cascade] skipping frequency cast — "${frequency}" not in enum. Schedule template updated; jobs.frequency left unchanged.`);
        }
      }
      // [PR #61] Skip the cascade UPDATE entirely when no fragments
      // survived validation — happens when the only changed field is
      // service_type or frequency and the value didn't match a valid
      // enum slug. Otherwise we'd build "UPDATE jobs SET WHERE ..."
      // and Postgres would error on the empty SET clause.
      if (setFragments.length > 0) {
        const setSql = setFragments.reduce((acc: any, frag: any, i: number) => i === 0 ? frag : sql`${acc}, ${frag}`);
        const cascadeRes = await db.execute(sql`
          UPDATE jobs
          SET ${setSql}
          WHERE company_id = ${companyId}
            AND recurring_schedule_id = ${updated[0].id}
            AND status = 'scheduled'
            AND scheduled_date >= ${today}
        `);
        cascadeUpdated = (cascadeRes as any).rowCount ?? 0;
      }
    }

    // [parking-cascade] Cascade parking config to existing future scheduled
    // jobs. The recurring engine stamps parking on NEW occurrences via
    // stampParkingFeeOnJob, but existing jobs created before the operator
    // toggled parking on (or before they changed the amount) carry no
    // job_add_ons row OR carry a stale unit_price. The user-reported repro:
    // saved parking $15 on Nicholas Cooper's profile, May 11 job stayed at
    // base $180 with no parking row. Now we:
    //  - Resolve the tenant's Parking Fee addon once (3-tier waterfall)
    //  - For each existing future scheduled job linked to this schedule
    //    where parking_fee_days matches the job's weekday:
    //      enabled  -> UPSERT job_add_ons with the new unit_price
    //      disabled -> DELETE the job_add_ons parking row
    let parkingCascadeUpserted = 0;
    let parkingCascadeRemoved = 0;
    const parkingTouched = parking_fee_enabled !== undefined
      || parking_fee_amount !== undefined
      || parking_fee_days !== undefined;
    if (shouldCascade && parkingTouched && updated[0]) {
      const today = new Date().toISOString().slice(0, 10);
      const sched = updated[0] as any;
      if (sched.parking_fee_enabled) {
        // UPSERT path. Pull the resolved parking addon (handles 3-tier
        // waterfall: schedule.parking_fee_amount > clients.parking_fee_amount
        // > pricing_addons.parking_fee.price). Reuse the engine helper so
        // the resolution logic stays single-sourced.
        const { resolveParkingAddon } = await import("../lib/recurring-jobs.js");
        const resolved = await resolveParkingAddon({
          company_id: companyId,
          customer_id: clientId,
          parking_fee_amount: sched.parking_fee_amount,
        });
        if (resolved) {
          // Day filter: NULL parking_fee_days = "every visit"; populated
          // array = "only matching weekdays". Postgres EXTRACT(DOW...)
          // returns 0=Sun..6=Sat which matches our 0=Sun..6=Sat
          // convention for parking_fee_days.
          const dayFilter = sched.parking_fee_days == null
            ? sql`TRUE`
            : sql`EXTRACT(DOW FROM scheduled_date)::int = ANY(${sched.parking_fee_days as number[]})`;
          // INSERT ... ON CONFLICT (job_id, add_on_id) DO UPDATE so amount
          // changes propagate to already-stamped jobs.
          const upsertRes = await db.execute(sql`
            INSERT INTO job_add_ons (job_id, add_on_id, quantity, unit_price, subtotal, pricing_addon_id)
            SELECT j.id, ${resolved.add_on_id}, 1, ${resolved.unit_price}, ${resolved.unit_price}, ${resolved.pricing_addon_id}
            FROM jobs j
            WHERE j.company_id = ${companyId}
              AND j.recurring_schedule_id = ${sched.id}
              AND j.status = 'scheduled'
              AND j.scheduled_date >= ${today}
              AND ${dayFilter}
            ON CONFLICT (job_id, add_on_id) DO UPDATE
              SET unit_price = EXCLUDED.unit_price,
                  subtotal = EXCLUDED.subtotal
          `);
          parkingCascadeUpserted = (upsertRes as any).rowCount ?? 0;
          // Also DELETE parking from jobs whose weekday is NOT in the day
          // filter (when parking_fee_days is set to a partial subset and
          // some jobs previously had parking stamped via "every visit").
          if (sched.parking_fee_days != null) {
            const removeRes = await db.execute(sql`
              DELETE FROM job_add_ons
              WHERE add_on_id = ${resolved.add_on_id}
                AND job_id IN (
                  SELECT j.id
                  FROM jobs j
                  WHERE j.company_id = ${companyId}
                    AND j.recurring_schedule_id = ${sched.id}
                    AND j.status = 'scheduled'
                    AND j.scheduled_date >= ${today}
                    AND NOT (EXTRACT(DOW FROM scheduled_date)::int = ANY(${sched.parking_fee_days as number[]}))
                )
            `);
            parkingCascadeRemoved = (removeRes as any).rowCount ?? 0;
          }
        }
      } else {
        // Parking toggled OFF — DELETE parking rows from all future
        // scheduled jobs linked to this schedule. Use a name-based
        // lookup to find the add_on row (no schedule-amount required).
        const removeRes = await db.execute(sql`
          DELETE FROM job_add_ons
          WHERE add_on_id IN (
            SELECT id FROM add_ons
            WHERE company_id = ${companyId} AND LOWER(name) = 'parking fee'
          )
          AND job_id IN (
            SELECT j.id
            FROM jobs j
            WHERE j.company_id = ${companyId}
              AND j.recurring_schedule_id = ${sched.id}
              AND j.status = 'scheduled'
              AND j.scheduled_date >= ${today}
          )
        `);
        parkingCascadeRemoved = (removeRes as any).rowCount ?? 0;
      }
    }

    // [recurrence-generation 2026-06-03] Actually GENERATE the upcoming jobs
    // from the schedule. Previously this endpoint updated the template and
    // cascaded to EXISTING jobs but never generated new ones — so saving a
    // fresh recurrence (e.g. a newly-recurring client) produced an empty
    // calendar ("it saved the recurrence but that didn't trigger the
    // scheduling"). The /api/recurring POST already did this; the
    // customer-profile editor (this endpoint) didn't. The engine dedupes on
    // (recurring_schedule_id, scheduled_date), so it's idempotent with the
    // nightly cron and safe to re-run on every save.
    let jobsGenerated = 0;
    if (updated[0]) {
      try {
        const { generateJobsFromSchedule, DAYS_AHEAD } = await import("../lib/recurring-jobs.js");
        const cl = await db.select({ zip: clientsTable.zip }).from(clientsTable)
          .where(eq(clientsTable.id, clientId)).limit(1);
        const clientZip = (cl[0]?.zip as any) ?? null;
        const now = new Date();
        const horizon = new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
        const gen = await generateJobsFromSchedule(updated[0] as any, now, horizon, null, clientZip);
        jobsGenerated = gen.created;
      } catch (genErr: any) {
        console.warn("[recurring-schedule PATCH] sync generation failed:", genErr?.message ?? genErr);
      }
    }

    return res.json({
      ...(updated[0] || {}),
      cascade: {
        updated_jobs: cascadeUpdated,
        parking_upserted: parkingCascadeUpserted,
        parking_removed: parkingCascadeRemoved,
      },
      jobs_generated: jobsGenerated,
    });
  } catch (err) {
    console.error("Patch recurring schedule error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── JOB PHOTOS FOR CLIENT ────────────────────────────────────────────────────
router.get("/:id/job-photos", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const rows = await db.select({
      photo_id: jobPhotosTable.id,
      job_id: jobPhotosTable.job_id,
      photo_type: jobPhotosTable.photo_type,
      url: jobPhotosTable.url,
      photo_timestamp: jobPhotosTable.timestamp,
      job_date: jobsTable.scheduled_date,
      service_type: jobsTable.service_type,
      status: jobsTable.status,
      tech_first: usersTable.first_name,
      tech_last: usersTable.last_name,
    })
      .from(jobPhotosTable)
      .innerJoin(jobsTable, and(eq(jobPhotosTable.job_id, jobsTable.id), eq(jobsTable.client_id, clientId), eq(jobsTable.company_id, companyId)))
      .leftJoin(usersTable, eq(jobPhotosTable.uploaded_by, usersTable.id))
      .orderBy(desc(jobsTable.scheduled_date), desc(jobPhotosTable.timestamp));
    return res.json(rows);
  } catch (err) {
    console.error("Job photos error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [cancellation-reporting 2026-06-01] Per-client cancellation +
// reschedule activity feed. Returns every cancellation_log row for
// the client with a friendly label per action, the job's original
// date, the charge amount (zero for free actions), and any operator
// note. Powers the "Cancellations & Reschedules" section on the
// client profile so office can see at a glance how often this
// customer reschedules / cancels / locks the crew out.
router.get("/:id/cancellation-history", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    if (!Number.isFinite(clientId)) {
      return res.status(400).json({ error: "Invalid client id" });
    }
    const rows = await db.execute(sql`
      SELECT
        cl.id,
        cl.cancel_action,
        cl.customer_charge_amount,
        cl.affects_future_jobs,
        cl.notes,
        cl.cancelled_at,
        cl.job_id,
        j.scheduled_date AS original_date,
        j.base_fee AS original_amount,
        u.first_name || ' ' || COALESCE(u.last_name, '') AS cancelled_by_name
      FROM cancellation_log cl
      JOIN jobs j ON j.id = cl.job_id
      LEFT JOIN users u ON u.id = cl.cancelled_by
      WHERE cl.company_id = ${companyId} AND cl.customer_id = ${clientId}
      ORDER BY cl.cancelled_at DESC
      LIMIT 200
    `);
    const data = (rows.rows as Array<{
      id: number;
      cancel_action: string | null;
      customer_charge_amount: string;
      affects_future_jobs: boolean;
      notes: string | null;
      cancelled_at: Date;
      job_id: number;
      original_date: string;
      original_amount: string | null;
      cancelled_by_name: string | null;
    }>).map(r => {
      const action = r.cancel_action ?? "legacy";
      const labels: Record<string, string> = {
        move: "Moved (customer)",
        bump: "Bumped (office)",
        skip: "Skipped",
        cancel: "Cancelled (fee)",
        lockout: "Lockout (fee)",
        cancel_service: "Service cancelled",
        legacy: "Cancellation",
      };
      return {
        id: r.id,
        action,
        label: labels[action] ?? action,
        is_reschedule: action === "move" || action === "bump",
        charges_customer: action === "cancel" || action === "lockout",
        ends_service: action === "cancel_service",
        customer_charge_amount: parseFloat(String(r.customer_charge_amount ?? 0)),
        affects_future_jobs: r.affects_future_jobs,
        notes: r.notes,
        cancelled_at: r.cancelled_at,
        cancelled_by_name: r.cancelled_by_name?.trim() || null,
        job_id: r.job_id,
        original_date: r.original_date,
        original_amount: r.original_amount != null ? parseFloat(String(r.original_amount)) : null,
      };
    });
    // Summary chip at the top of the section.
    const summary = data.reduce(
      (acc, e) => {
        if (e.action === "move") acc.moves += 1;
        if (e.action === "bump") acc.bumps += 1;
        if (e.action === "skip") acc.skips += 1;
        if (e.action === "cancel") { acc.cancels += 1; acc.total_charged += e.customer_charge_amount; }
        if (e.action === "lockout") { acc.lockouts += 1; acc.total_charged += e.customer_charge_amount; }
        if (e.action === "cancel_service") acc.services_ended += 1;
        return acc;
      },
      { moves: 0, bumps: 0, skips: 0, cancels: 0, lockouts: 0, services_ended: 0, total_charged: 0 }
    );
    return res.json({ data, summary });
  } catch (err) {
    console.error("[clients/cancellation-history]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/:id/recurring-schedule", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const rows = await db.select({
      id: recurringSchedulesTable.id,
      frequency: recurringSchedulesTable.frequency,
      day_of_week: recurringSchedulesTable.day_of_week,
      start_date: recurringSchedulesTable.start_date,
      end_date: recurringSchedulesTable.end_date,
      service_type: recurringSchedulesTable.service_type,
      scheduled_time: recurringSchedulesTable.scheduled_time,
      duration_minutes: recurringSchedulesTable.duration_minutes,
      base_fee: recurringSchedulesTable.base_fee,
      notes: recurringSchedulesTable.notes,
      is_active: recurringSchedulesTable.is_active,
      assigned_employee_id: recurringSchedulesTable.assigned_employee_id,
      // [audit BUG #1] Parking-fee config columns (added in PR #51) were
      // missing from this SELECT. Customer-profile editor seeds
      // form.rec_parking_fee_* from these — without them, the editor opens
      // with parking unchecked + amount blank even when the DB has saved
      // values, and saving wipes the schedule's parking config because the
      // form thinks nothing was set.
      parking_fee_enabled: recurringSchedulesTable.parking_fee_enabled,
      parking_fee_amount: recurringSchedulesTable.parking_fee_amount,
      parking_fee_days: recurringSchedulesTable.parking_fee_days,
      // [audit BUG #4 prep] days_of_week needed by the parking-day picker
      // gate; surface here so the customer-profile editor matches the
      // edit-job modal's behavior. NULL for single-day frequencies.
      days_of_week: recurringSchedulesTable.days_of_week,
      // [PR #58] days_of_month anchors for semi_monthly + monthly
      // sentence-builder UI ([1, 15] / [15, 30] / single day for monthly).
      days_of_month: recurringSchedulesTable.days_of_month,
      custom_frequency_weeks: recurringSchedulesTable.custom_frequency_weeks,
      tech_first: usersTable.first_name,
      tech_last: usersTable.last_name,
    })
      .from(recurringSchedulesTable)
      .leftJoin(usersTable, eq(recurringSchedulesTable.assigned_employee_id, usersTable.id))
      .where(and(
        eq(recurringSchedulesTable.customer_id, clientId),
        eq(recurringSchedulesTable.company_id, companyId),
        eq(recurringSchedulesTable.is_active, true),
      ))
      .orderBy(desc(recurringSchedulesTable.created_at))
      .limit(1);
    return res.json(rows[0] || null);
  } catch (err) {
    console.error("Recurring schedule error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /:id/rate-lock (manual create) ──────────────────────────────────────
router.post("/:id/rate-lock", requireAuth, async (req, res) => {
  const { sql: dsql } = await import("drizzle-orm");
  const companyId = (req as any).user?.company_id;
  const { locked_rate, cadence, start_date, duration_months, notes } = req.body;
  try {
    const clientId = parseInt(req.params.id);
    const startDateStr = start_date || new Date().toISOString().split("T")[0];
    const months = parseInt(duration_months) || 24;
    const expiry = new Date(startDateStr);
    expiry.setMonth(expiry.getMonth() + months);
    const expiryStr = expiry.toISOString().split("T")[0];
    const result = await db.execute(
      dsql`
        INSERT INTO rate_locks (company_id, client_id, locked_rate, cadence, lock_start_date, lock_expires_at, active, created_manually, void_notes, created_at)
        VALUES (${companyId}, ${clientId}, ${parseFloat(locked_rate)}, ${cadence}, ${startDateStr}::date, ${expiryStr}::date, true, true, ${notes || null}, NOW())
        RETURNING id
      `
    );
    return res.json({ id: (result.rows[0] as any).id });
  } catch (err) {
    console.error("POST create rate-lock:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /:id/rate-lock ────────────────────────────────────────────────────────
router.get("/:id/rate-lock", requireAuth, async (req, res) => {
  const { sql: dsql } = await import("drizzle-orm");
  try {
    const result = await db.execute(
      dsql`SELECT * FROM rate_locks WHERE client_id = ${req.params.id} ORDER BY created_at DESC LIMIT 1`
    );
    return res.json(result.rows[0] || null);
  } catch (err) {
    console.error("GET rate-lock:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /:id/rate-lock/:lockId/void ─────────────────────────────────────────
router.post("/:id/rate-lock/:lockId/void", requireAuth, async (req, res) => {
  const { sql: dsql } = await import("drizzle-orm");
  const { reason, notes } = req.body;
  try {
    await db.execute(
      dsql`UPDATE rate_locks SET active = false, void_reason = ${reason || "manual"}, void_notes = ${notes || null}, voided_at = NOW() WHERE id = ${req.params.lockId} AND client_id = ${req.params.id}`
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST void rate-lock:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


// ──────────── Client Loyalty ────────────────────────────────────────────────
router.get("/:id/loyalty", requireAuth, async (req, res) => {
  const companyId = req.auth!.companyId;
  const clientId = parseInt(req.params.id);
  try {
    const loyaltyRes = await db.execute(sql`
      SELECT cl.* FROM client_loyalty cl
      WHERE cl.client_id = ${clientId} AND cl.company_id = ${companyId}
      LIMIT 1
    `);
    const tiersRes = await db.execute(sql`
      SELECT * FROM loyalty_tiers WHERE company_id = ${companyId} ORDER BY min_visits ASC
    `);
    const statsRes = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed')::int AS total_visits,
        COALESCE(SUM(CASE WHEN status='completed' THEN total::numeric ELSE 0 END), 0) AS lifetime_revenue
      FROM jobs WHERE client_id = ${clientId} AND company_id = ${companyId}
    `);
    return res.json({
      loyalty: loyaltyRes.rows[0] || null,
      tiers: tiersRes.rows,
      stats: statsRes.rows[0] || { total_visits: 0, lifetime_revenue: 0 },
    });
  } catch (err) {
    console.error("GET loyalty:", err);
    return res.status(500).json({ error: "Failed to get loyalty data" });
  }
});

router.patch("/:id/loyalty", requireAuth, async (req, res) => {
  const companyId = req.auth!.companyId;
  const clientId = parseInt(req.params.id);
  const { tier_override, notes, tier_id } = req.body;
  try {
    const existing = await db.execute(sql`
      SELECT id FROM client_loyalty WHERE client_id = ${clientId} AND company_id = ${companyId} LIMIT 1
    `);
    if (existing.rows.length > 0) {
      await db.execute(sql`
        UPDATE client_loyalty SET
          tier_override = ${tier_override ?? null},
          tier_id = ${tier_id ?? null},
          notes = ${notes ?? null},
          updated_at = NOW()
        WHERE client_id = ${clientId} AND company_id = ${companyId}
      `);
    } else {
      await db.execute(sql`
        INSERT INTO client_loyalty (client_id, company_id, tier_override, tier_id, notes)
        VALUES (${clientId}, ${companyId}, ${tier_override ?? null}, ${tier_id ?? null}, ${notes ?? null})
      `);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH loyalty:", err);
    return res.status(500).json({ error: "Failed to update loyalty" });
  }
});

router.post("/:id/loyalty/points", requireAuth, async (req, res) => {
  const companyId = req.auth!.companyId;
  const clientId = parseInt(req.params.id);
  const { points, reason } = req.body;
  if (!points || isNaN(parseInt(points))) return res.status(400).json({ error: "Points required" });
  const pts = parseInt(points);
  try {
    const existing = await db.execute(sql`
      SELECT id, points_balance, total_points_earned FROM client_loyalty
      WHERE client_id = ${clientId} AND company_id = ${companyId} LIMIT 1
    `);
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as any;
      const newBalance = (row.points_balance || 0) + pts;
      const newTotal = (row.total_points_earned || 0) + (pts > 0 ? pts : 0);
      await db.execute(sql`
        UPDATE client_loyalty SET points_balance = ${newBalance}, total_points_earned = ${newTotal}, updated_at = NOW()
        WHERE client_id = ${clientId} AND company_id = ${companyId}
      `);
    } else {
      const bal = pts > 0 ? pts : 0;
      await db.execute(sql`
        INSERT INTO client_loyalty (client_id, company_id, points_balance, total_points_earned)
        VALUES (${clientId}, ${companyId}, ${bal}, ${bal})
      `);
    }
    return res.json({ ok: true, points_added: pts, reason });
  } catch (err) {
    console.error("POST loyalty/points:", err);
    return res.status(500).json({ error: "Failed to add points" });
  }
});

// ──────────── Client Referrals ───────────────────────────────────────────────
router.get("/:id/referrals", requireAuth, async (req, res) => {
  const companyId = req.auth!.companyId;
  const clientId = parseInt(req.params.id);
  try {
    const result = await db.execute(sql`
      SELECT * FROM referrals
      WHERE referrer_client_id = ${clientId} AND company_id = ${companyId}
      ORDER BY created_at DESC
    `);
    return res.json(result.rows);
  } catch (err) {
    console.error("GET referrals:", err);
    return res.status(500).json({ error: "Failed to get referrals" });
  }
});

router.post("/:id/referrals", requireAuth, async (req, res) => {
  const companyId = req.auth!.companyId;
  const clientId = parseInt(req.params.id);
  const { referred_name, referred_phone, referred_email, notes } = req.body;
  if (!referred_name?.trim()) return res.status(400).json({ error: "Referred name required" });
  try {
    const result = await db.execute(sql`
      INSERT INTO referrals (company_id, referrer_client_id, referred_name, referred_phone, referred_email, notes, source, status)
      VALUES (${companyId}, ${clientId}, ${referred_name.trim()}, ${referred_phone || null}, ${referred_email || null}, ${notes || null}, 'manual', 'pending')
      RETURNING *
    `);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST referrals:", err);
    return res.status(500).json({ error: "Failed to create referral" });
  }
});

// ─── PATCH JOB STATUS (from calendar — void / skip / done / booked) ──────────
router.patch("/:clientId/jobs/:jobId/status", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId);
    const companyId = req.auth!.companyId;
    const { status } = req.body;

    const ALLOWED = ["scheduled", "cancelled", "complete"];
    // Also accept our UI-friendly aliases
    const mapped: Record<string, string> = {
      booked: "scheduled", void: "cancelled", done: "complete",
      skip: "cancelled", skipped: "cancelled",
    };
    const dbStatus = mapped[String(status)] ?? String(status);
    if (!ALLOWED.includes(dbStatus)) {
      return res.status(400).json({ error: `Invalid status: ${status}` });
    }

    const existing = await db.execute(sql`
      SELECT id, status, client_id FROM jobs
      WHERE id = ${jobId} AND company_id = ${companyId}
      LIMIT 1
    `);
    if (!existing.rows.length) return res.status(404).json({ error: "Job not found" });

    await db.execute(sql`
      UPDATE jobs SET status = ${dbStatus}::job_status WHERE id = ${jobId}
    `);

    return res.json({ ok: true, status: dbStatus });
  } catch (err) {
    console.error("PATCH job status:", err);
    return res.status(500).json({ error: "Failed to update job status" });
  }
});

// ─── GET CALENDAR JOBS ────────────────────────────────────────────────────────
router.get("/:id/calendar-jobs", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const { from, to } = req.query as { from?: string; to?: string };

    const rows = await db.execute(sql`
      SELECT
        j.id, j.scheduled_date, j.status, j.service_type, j.base_fee,
        j.billed_amount, j.estimated_hours, j.actual_hours,
        j.scheduled_time, j.address_street, j.address_city,
        u.first_name || ' ' || u.last_name AS technician_name,
        u.id AS technician_id,
        -- Latest cancellation_log action (any type). The calendar resolves the
        -- chip off this: charged cancel/lockout keep status='complete' so they
        -- must read "Cancel fee"/"Lockout" not "Done"; cancelled jobs that were
        -- skipped/moved read "Skipped"/"Moved" not the generic "Cancelled". A
        -- completed job is still shown Done by the client (see chipKeyFor) — a
        -- stale historical move/skip never downgrades a finished visit.
        (SELECT cl.cancel_action FROM cancellation_log cl
          WHERE cl.job_id = j.id
          ORDER BY cl.cancelled_at DESC LIMIT 1) AS cancel_action
      FROM jobs j
      LEFT JOIN users u ON u.id = j.assigned_user_id
      WHERE j.client_id = ${clientId}
        AND j.company_id = ${companyId}
        ${from ? sql`AND j.scheduled_date >= ${from}::date` : sql``}
        ${to   ? sql`AND j.scheduled_date <= ${to}::date`   : sql``}
        -- [ghost-suppression 2026-06-30] The recurring engine double-generated
        -- some schedules and CANCELLED (not deleted) the duplicate, leaving a
        -- ghost "Cancelled" row stacked on the live job → every recurring date
        -- painted both a Scheduled and a Cancelled chip. Hide a cancelled row
        -- ONLY when it has no cancellation_log entry (so it's an engine artifact,
        -- never a real office cancellation) AND a live job already occupies the
        -- same date for this client. A standalone cancellation still shows.
        AND NOT (
          j.status::text = 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM cancellation_log clx WHERE clx.job_id = j.id)
          AND EXISTS (
            SELECT 1 FROM jobs s
            WHERE s.company_id = j.company_id
              AND s.client_id = j.client_id
              AND s.scheduled_date = j.scheduled_date
              AND s.id <> j.id
              AND s.status::text IN ('scheduled','in_progress','complete','invoiced')
          )
        )
      ORDER BY j.scheduled_date ASC
    `);
    return res.json(rows.rows);
  } catch (err) {
    console.error("GET calendar-jobs:", err);
    return res.status(500).json({ error: "Failed to fetch calendar jobs" });
  }
});

// ─── PATCH JOB RESCHEDULE ─────────────────────────────────────────────────────
router.patch("/:clientId/jobs/:jobId/reschedule", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId);
    const companyId = req.auth!.companyId;
    const userId = req.auth!.userId;
    const { new_date, reason, notes } = req.body;

    if (!new_date || !reason) {
      return res.status(400).json({ error: "new_date and reason are required" });
    }

    const existing = await db.execute(sql`
      SELECT id, scheduled_date, status FROM jobs
      WHERE id = ${jobId} AND company_id = ${companyId}
      LIMIT 1
    `);
    if (!existing.rows.length) return res.status(404).json({ error: "Job not found" });

    const job = existing.rows[0] as any;
    const oldDate = String(job.scheduled_date).split("T")[0];

    if (["complete", "invoiced"].includes(String(job.status))) {
      return res.status(400).json({ error: "Cannot reschedule a completed or invoiced job" });
    }

    // [reschedule-dedupe-fix 2026-06-16] (#6) Moving a recurring job onto a
    // date that holds a CANCELLED occurrence of the same schedule used to throw
    // a generic 500 ("Failed to reschedule job"). The real fix is the
    // jobs_recurring_dedupe_idx rebuild (scripts/j6_reschedule_dedupe_fix.ts)
    // which excludes cancelled rows from the unique slot. Until/if that index
    // is in place, catch the unique-violation (SQLSTATE 23505) explicitly and
    // return an actionable 409 instead of the opaque generic error.
    try {
      await db.execute(sql`
        UPDATE jobs SET scheduled_date = ${new_date}::date WHERE id = ${jobId}
      `);
    } catch (updErr: any) {
      if (String(updErr?.code) === "23505") {
        return res.status(409).json({
          error: "That date already has another occurrence of this recurring service. Cancel or move the existing one first.",
        });
      }
      throw updErr;
    }

    try {
      await db.execute(sql`
        INSERT INTO job_reschedule_log (job_id, company_id, old_date, new_date, reason, notes, changed_by)
        VALUES (${jobId}, ${companyId}, ${oldDate}::date, ${new_date}::date, ${reason}, ${notes || null}, ${userId})
      `);
    } catch (logErr) {
      console.warn("PATCH reschedule: audit log insert failed (non-fatal):", logErr);
    }

    const updated = await db.execute(sql`
      SELECT id, scheduled_date, status, service_type, base_fee FROM jobs WHERE id = ${jobId}
    `);

    return res.json({ ok: true, old_date: oldDate, new_date, job: updated.rows[0] || null });
  } catch (err) {
    console.error("PATCH reschedule:", err);
    return res.status(500).json({ error: "Failed to reschedule job" });
  }
});

// ─── GET CLIENT PROFITABILITY ─────────────────────────────────────────────────
router.get("/:id/profitability", requireAuth, requireRole("owner", "office"), async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const period = (req.query.period as string) || "monthly";

    const now = new Date();
    let startDate: Date;
    if (period === "quarterly") {
      startDate = new Date(now); startDate.setDate(now.getDate() - 90);
    } else if (period === "annually") {
      startDate = new Date(now); startDate.setDate(now.getDate() - 365);
    } else {
      startDate = new Date(now); startDate.setDate(now.getDate() - 30);
    }
    const ytdStart = new Date(now.getFullYear(), 0, 1);

    const startDateStr = startDate.toISOString().split("T")[0];
    const ytdStartStr = ytdStart.toISOString().split("T")[0];

    // Revenue + jobs in period
    const periodRes = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'complete') AS total_jobs,
        COALESCE(SUM(COALESCE(billed_amount, base_fee)) FILTER (WHERE status = 'complete'), 0) AS revenue,
        COALESCE(SUM(COALESCE(supply_cost, 0)) FILTER (WHERE status = 'complete'), 0) AS supply_cost,
        COALESCE(AVG(COALESCE(billed_amount, base_fee)) FILTER (WHERE status = 'complete'), 0) AS avg_bill,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count
      FROM jobs
      WHERE client_id = ${clientId} AND company_id = ${companyId}
        AND scheduled_date >= ${startDateStr}::date
    `);

    const pRow = (periodRes.rows[0] as any) || {};
    const revenue = parseFloat(String(pRow.revenue ?? 0));
    const supplyCost = parseFloat(String(pRow.supply_cost ?? 0));
    const totalJobs = parseInt(String(pRow.total_jobs ?? 0));
    const avgBill = parseFloat(String(pRow.avg_bill ?? 0));
    const cancelledCount = parseInt(String(pRow.cancelled_count ?? 0));

    // YTD revenue
    const ytdRes = await db.execute(sql`
      SELECT COALESCE(SUM(COALESCE(billed_amount, base_fee)), 0) AS ytd_revenue
      FROM jobs
      WHERE client_id = ${clientId} AND company_id = ${companyId}
        AND status = 'complete' AND scheduled_date >= ${ytdStartStr}::date
    `);
    const ytdRevenue = parseFloat(String((ytdRes.rows[0] as any)?.ytd_revenue ?? 0));

    // Labor cost
    const laborRes = await db.execute(sql`
      SELECT COALESCE(SUM(jt.final_pay), 0) AS labor_cost
      FROM job_technicians jt
      JOIN jobs j ON jt.job_id = j.id
      WHERE j.client_id = ${clientId} AND j.company_id = ${companyId}
        AND j.status = 'complete' AND j.scheduled_date >= ${startDateStr}::date
    `);
    const laborCost = parseFloat(String((laborRes.rows[0] as any)?.labor_cost ?? 0));

    // Overhead rate from company settings
    const coRes = await db.execute(sql`
      SELECT COALESCE(overhead_rate_pct, 10) AS overhead_rate_pct FROM companies WHERE id = ${companyId}
    `);
    const overheadPct = parseFloat(String((coRes.rows[0] as any)?.overhead_rate_pct ?? 10));
    const overhead = (overheadPct / 100) * revenue;

    const netProfit = revenue - laborCost - supplyCost - overhead;
    const laborPct = revenue > 0 ? (laborCost / revenue) * 100 : 0;
    const supplyPct = revenue > 0 ? (supplyCost / revenue) * 100 : 0;
    const overheadPctOfRev = revenue > 0 ? (overhead / revenue) * 100 : 0;
    const netPct = revenue > 0 ? (netProfit / revenue) * 100 : 0;

    // Days in period for monthly normalization
    const periodDays = period === "annually" ? 365 : period === "quarterly" ? 90 : 30;
    const monthMultiplier = 30 / periodDays;

    // Last job date (completed) for health score
    const lastJobRes = await db.execute(sql`
      SELECT scheduled_date FROM jobs
      WHERE client_id = ${clientId} AND company_id = ${companyId} AND status = 'complete'
      ORDER BY scheduled_date DESC LIMIT 1
    `);
    const lastJobDate: string | null = lastJobRes.rows.length > 0
      ? String((lastJobRes.rows[0] as any).scheduled_date)
      : null;
    const daysSinceLastJob = lastJobDate
      ? Math.floor((Date.now() - new Date(lastJobDate).getTime()) / 86400000)
      : 999;

    // Company average avg_bill (for health score)
    const coAvgRes = await db.execute(sql`
      SELECT COALESCE(AVG(sub.avg_per_client), 0) AS company_avg_bill
      FROM (
        SELECT AVG(COALESCE(billed_amount, base_fee)) AS avg_per_client
        FROM jobs
        WHERE company_id = ${companyId} AND status = 'complete'
          AND scheduled_date >= ${startDateStr}::date
        GROUP BY client_id
      ) sub
    `);
    const companyAvgBill = parseFloat(String((coAvgRes.rows[0] as any)?.company_avg_bill ?? 0));

    // Health score
    let health = 100;
    if (laborPct > 40) health -= 20;
    else if (laborPct > 35) health -= 10;
    if (netPct < 15) health -= 15;
    else if (netPct < 20) health -= 10;
    if (cancelledCount > 2) health -= 10;
    if (daysSinceLastJob > 45) health -= 10;
    if (companyAvgBill > 0 && avgBill < companyAvgBill) health -= 5;
    health = Math.max(0, Math.min(100, health));

    // [account-health 2026-06-25] Bug #9: replace the money-only score with a
    // simple 3-check model — Happy / Active / Making money. The old score
    // ignored quality entirely, so an unhappy-but-profitable client read
    // "Healthy" (Maribel's complaint). Each check links to real records for the
    // click-through detail. Quality window 90d, real (past) cancellations 60d.
    const recleanRows = (await db.execute(sql`
      SELECT qc.id, qc.complaint_date::text AS date, qc.description, qc.job_id
      FROM quality_complaints qc JOIN jobs j ON j.id = qc.job_id
      WHERE j.client_id = ${clientId} AND qc.company_id = ${companyId}
        AND (qc.re_clean_required OR qc.valid)
        AND qc.complaint_date >= CURRENT_DATE - INTERVAL '90 days'
      ORDER BY qc.complaint_date DESC`)).rows as any[];
    const ticketRows = (await db.execute(sql`
      SELECT t.id, t.ticket_type::text AS ticket_type, t.notes, t.job_id, t.created_at::text AS date
      FROM contact_tickets t
      WHERE t.client_id = ${clientId} AND t.company_id = ${companyId}
        AND t.ticket_type IN ('complaint_poor_cleaning','complaint_attitude','breakage','incident')
        AND t.created_at >= CURRENT_DATE - INTERVAL '90 days'
      ORDER BY t.created_at DESC`)).rows as any[];
    const refundRows = (await db.execute(sql`
      SELECT p.id, p.amount, p.refunded_at::text AS date, p.refund_reason, p.job_id
      FROM payments p JOIN jobs j ON j.id = p.job_id
      WHERE j.client_id = ${clientId} AND p.refunded_at IS NOT NULL
        AND p.refunded_at >= CURRENT_DATE - INTERVAL '90 days'
      ORDER BY p.refunded_at DESC`)).rows as any[];
    const cancelRows = (await db.execute(sql`
      SELECT id, scheduled_date::text AS date FROM jobs
      WHERE client_id = ${clientId} AND company_id = ${companyId} AND status = 'cancelled'
        AND scheduled_date BETWEEN CURRENT_DATE - INTERVAL '60 days' AND CURRENT_DATE
      ORDER BY scheduled_date DESC`)).rows as any[];

    const happyPass = (recleanRows.length + ticketRows.length + refundRows.length) === 0;
    const realCancels = cancelRows.length;
    const activePass = realCancels < 3;                       // 3+ real cancellations = churn risk
    // No billed revenue in the period = not enough data to judge margin, so
    // treat Money as neutral (pass) rather than penalizing missing history —
    // otherwise every client with no completed jobs reads as "low margin".
    const hasRevenue = revenue > 0;
    const moneyPass = !hasRevenue || (netPct >= 15 && laborPct <= 40);
    const fails = [happyPass, activePass, moneyPass].filter(p => !p).length;
    const healthStatus = fails === 0 ? "healthy" : fails === 1 ? "watch" : "at_risk";

    const ticketLabel = (t: string) => ({ complaint_poor_cleaning: "Poor cleaning", complaint_attitude: "Attitude", breakage: "Breakage", incident: "Incident" } as Record<string,string>)[t] ?? t;
    const happyParts: string[] = [];
    if (recleanRows.length) happyParts.push(`${recleanRows.length} re-clean${recleanRows.length > 1 ? "s" : ""}`);
    if (ticketRows.length) happyParts.push(`${ticketRows.length} complaint${ticketRows.length > 1 ? "s" : ""}`);
    if (refundRows.length) happyParts.push(`${refundRows.length} refund${refundRows.length > 1 ? "s" : ""}`);
    const healthChecks = {
      happy: {
        pass: happyPass,
        summary: happyPass ? "No complaints or re-cleans" : happyParts.join(", "),
        items: [
          ...recleanRows.map(r => ({ kind: "reclean", label: r.description || "Re-clean", date: r.date, job_id: r.job_id, tag: "RE-CLEAN" })),
          ...ticketRows.map(t => ({ kind: "complaint", label: t.notes || ticketLabel(t.ticket_type), date: String(t.date).split("T")[0], job_id: t.job_id, tag: ticketLabel(t.ticket_type).toUpperCase() })),
          ...refundRows.map(r => ({ kind: "refund", label: `Refund $${Number(r.amount || 0).toFixed(0)}${r.refund_reason ? ` · ${r.refund_reason}` : ""}`, date: String(r.date).split("T")[0], job_id: r.job_id, tag: "REFUND" })),
        ],
      },
      active: {
        pass: activePass,
        summary: activePass ? "Visits on track" : `Cancelled ${realCancels} visit${realCancels > 1 ? "s" : ""} recently`,
        items: cancelRows.map(c => ({ kind: "cancel", label: "Cancelled visit", date: c.date, job_id: c.id, tag: "CANCELLED" })),
      },
      money: {
        pass: moneyPass,
        summary: !hasRevenue ? "No billed jobs in this period" : (moneyPass ? "Healthy margin" : (netPct < 15 ? `Low margin (${netPct.toFixed(0)}%)` : `Labor cost high (${laborPct.toFixed(0)}%)`)),
        details: { revenue, net_pct: netPct, labor_pct: laborPct, avg_bill: avgBill, company_avg_bill: companyAvgBill },
      },
    };

    // Top services by revenue
    const svcsRes = await db.execute(sql`
      SELECT service_type,
        COALESCE(SUM(COALESCE(billed_amount, base_fee)), 0) AS total,
        COUNT(*) AS job_count
      FROM jobs
      WHERE client_id = ${clientId} AND company_id = ${companyId}
        AND status = 'complete' AND scheduled_date >= ${startDateStr}::date
      GROUP BY service_type ORDER BY total DESC LIMIT 5
    `);
    const topServicesRevTotal = (svcsRes.rows as any[]).reduce((s: number, r: any) => s + parseFloat(String(r.total)), 0);
    const topServices = (svcsRes.rows as any[]).map((r: any) => {
      const svcRevenue = parseFloat(String(r.total));
      return {
        service_type: r.service_type,
        revenue: svcRevenue,
        pct: topServicesRevTotal > 0 ? Math.round((svcRevenue / topServicesRevTotal) * 100) : 0,
        job_count: parseInt(String(r.job_count)),
      };
    });

    // Trend data (weeks for monthly, months for quarterly/annually)
    let trendRows: any[];
    if (period === "monthly") {
      const trendRes = await db.execute(sql`
        SELECT
          date_trunc('week', scheduled_date::timestamp) AS bucket,
          COALESCE(SUM(COALESCE(billed_amount, base_fee)), 0) AS revenue
        FROM jobs
        WHERE client_id = ${clientId} AND company_id = ${companyId}
          AND status = 'complete' AND scheduled_date >= ${startDateStr}::date
        GROUP BY 1 ORDER BY 1
      `);
      trendRows = (trendRes.rows as any[]).map((r: any) => ({
        label: new Date(r.bucket).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        revenue: parseFloat(String(r.revenue)),
      }));
    } else {
      const trendRes = await db.execute(sql`
        SELECT
          date_trunc('month', scheduled_date::timestamp) AS bucket,
          COALESCE(SUM(COALESCE(billed_amount, base_fee)), 0) AS revenue
        FROM jobs
        WHERE client_id = ${clientId} AND company_id = ${companyId}
          AND status = 'complete' AND scheduled_date >= ${startDateStr}::date
        GROUP BY 1 ORDER BY 1
      `);
      trendRows = (trendRes.rows as any[]).map((r: any) => ({
        label: new Date(r.bucket).toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
        revenue: parseFloat(String(r.revenue)),
      }));
    }

    return res.json({
      period,
      revenue,
      labor_cost: laborCost,
      supply_cost: supplyCost,
      overhead,
      overhead_pct: overheadPct,
      net_profit: netProfit,
      total_jobs: totalJobs,
      avg_bill: avgBill,
      ytd_revenue: ytdRevenue,
      labor_pct: laborPct,
      supply_pct: supplyPct,
      overhead_pct_of_rev: overheadPctOfRev,
      net_pct: netPct,
      month_multiplier: monthMultiplier,
      health_score: health,
      health_status: healthStatus,
      health_checks: healthChecks,
      last_job_date: lastJobDate,
      days_since_last_job: daysSinceLastJob,
      company_avg_bill: companyAvgBill,
      cancelled_count: cancelledCount,
      top_services: topServices,
      trend_data: trendRows,
    });
  } catch (err) {
    console.error("GET profitability:", err);
    return res.status(500).json({ error: "Failed to load profitability data" });
  }
});

export default router;

