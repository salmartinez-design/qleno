import { Router } from "express";
import { db } from "@workspace/db";
import {
  clientsTable, jobsTable, usersTable, invoicesTable,
  scorecardsTable, clientHomesTable, technicianPreferencesTable,
  clientNotificationsTable, clientCommunicationsTable, clientAgreementsTable,
  serviceZonesTable, quotesTable, contactTicketsTable, clientAttachmentsTable,
  recurringSchedulesTable, jobPhotosTable, qbCustomerMapTable, companiesTable,
} from "@workspace/db/schema";
import { eq, and, ilike, or, count, sum, desc, sql, gte, inArray } from "drizzle-orm";
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
        conditions.push(
          or(
            ilike(clientsTable.first_name, `%${s}%`),
            ilike(clientsTable.last_name, `%${s}%`),
            ilike(clientsTable.email, `%${s}%`),
            ilike(clientsTable.phone, `%${s}%`),
            ilike(clientsTable.address, `%${s}%`),
            ilike(clientsTable.city, `%${s}%`),
            ilike(clientsTable.company_name, `%${s}%`)
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
    const last_cleaning = completed_jobs[0]?.scheduled_date || null;
    const upcoming_jobs = jobs.filter(j => ["scheduled","in_progress"].includes(j.status || "") && j.scheduled_date && j.scheduled_date >= now.toISOString().split("T")[0]);
    const next_cleaning = upcoming_jobs[0]?.scheduled_date || null;
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
      last_cleaning_ms >= sixty_days_ago_ms || upcoming_jobs.length > 0 ? "active" : "inactive";

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

    return res.json({
      ...client,
      ...(zoneData || {}),
      qb_status,
      homes,
      tech_preferences: preferences,
      notification_settings: notifications,
      scorecards,
      invoices,
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

// ─── UPDATE CLIENT ─────────────────────────────────────────────────────────────
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const {
      first_name, last_name, email, phone, address, city, state, zip, notes, company_name,
      frequency, service_type, base_fee, allowed_hours, is_active, home_access_notes,
      alarm_code, pets, client_since,
      client_type, billing_contact_name, billing_contact_email, billing_contact_phone,
      po_number_required, default_po_number, payment_terms, auto_charge,
      card_last_four, card_brand, card_expiry, card_saved_at,
      payment_method, net_terms,
      commercial_hourly_rate,    // [AH] Per-client commercial hourly rate
      parking_fee_enabled, parking_fee_amount,
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
      ...(client_since !== undefined && { client_since }),
      ...(geo && { lat: geo.lat, lng: geo.lng }),
      ...(client_type !== undefined && { client_type }),
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
      ...(card_saved_at !== undefined && { card_saved_at }),
      ...(payment_method !== undefined && { payment_method }),
      ...(net_terms !== undefined && { net_terms: Number(net_terms) || 0 }),
      ...(newZoneId !== undefined && { zone_id: newZoneId }),
      ...(commercial_hourly_rate !== undefined && {
        commercial_hourly_rate: commercial_hourly_rate === null || commercial_hourly_rate === ""
          ? null
          : String(commercial_hourly_rate),
      }),
      ...(parking_fee_enabled !== undefined && { parking_fee_enabled: !!parking_fee_enabled }),
      ...(parking_fee_amount !== undefined && {
        parking_fee_amount: parking_fee_amount === null || parking_fee_amount === ""
          ? null
          : String(parking_fee_amount),
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
      .where(and(...conditions))
      .orderBy(desc(clientCommunicationsTable.created_at));
    return res.json(comms);
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
    let twilioResult = null;
    if (process.env.COMMS_ENABLED !== "true") {
      console.log("[COMMS BLOCKED] Client SMS suppressed:", { to, message: message?.substring(0, 80) });
    } else if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      try {
        const fromNum = process.env.TWILIO_FROM_NUMBER || "";
        const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
        const body = new URLSearchParams({ To: to, From: fromNum, Body: message });
        const r = await fetch(url, { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body });
        twilioResult = await r.json();
      } catch { /* log but don't fail */ }
    }
    const [comm] = await db.insert(clientCommunicationsTable).values({
      company_id: req.auth!.companyId, client_id: clientId,
      type: "sms", direction: "outbound", body: message, to_contact: to,
      from_name: req.auth!.email,
      sent_by: req.auth!.userId,
    }).returning();
    return res.status(201).json({ ...comm, twilio: twilioResult });
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
  return res.json({ geocoded: updated, total: clients.length });
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

    const records = rows.rows as Array<{
      id: number; job_date: string; revenue: string;
      service_type: string | null; technician: string | null; notes: string | null;
    }>;

    // Last cleaning from job_history
    const last_cleaning: string | null = records.length > 0 ? records[0].job_date : null;

    // Next cleaning from jobs table (nearest scheduled job in the future)
    const nextJobRes = await db.execute(sql`
      SELECT scheduled_date FROM jobs
      WHERE client_id = ${clientId} AND company_id = ${companyId}
        AND status = 'scheduled' AND scheduled_date >= CURRENT_DATE
      ORDER BY scheduled_date ASC LIMIT 1
    `);
    const next_cleaning: string | null = nextJobRes.rows.length > 0
      ? String((nextJobRes.rows[0] as any).scheduled_date)
      : null;

    // Is this client on an active recurring schedule?
    const recurrRes = await db.execute(sql`
      SELECT id FROM recurring_schedules
      WHERE customer_id = ${clientId} AND company_id = ${companyId} AND is_active = true
      LIMIT 1
    `);
    const is_recurring = recurrRes.rows.length > 0;

    // Skips and bumps — cast status to text to avoid enum validation errors if values not yet in enum
    let skips = 0;
    let bumps = 0;
    try {
      const statusRes = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status::text = 'skipped') AS skips,
          COUNT(*) FILTER (WHERE status::text = 'bumped') AS bumps
        FROM jobs
        WHERE client_id = ${clientId} AND company_id = ${companyId}
      `);
      skips = parseInt(String((statusRes.rows[0] as any)?.skips ?? 0));
      bumps = parseInt(String((statusRes.rows[0] as any)?.bumps ?? 0));
    } catch (_err) {
      // Status enum may not include these values yet — default to 0
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
      // [AI.6] Parking fee per-occurrence config. days uses 0=Sun..6=Sat;
      // null/empty days = "apply to every scheduled occurrence."
      parking_fee_enabled, parking_fee_amount, parking_fee_days,
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
    }).where(and(
      eq(recurringSchedulesTable.customer_id, clientId),
      eq(recurringSchedulesTable.company_id, companyId),
      eq(recurringSchedulesTable.is_active, true),
    )).returning();

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
        // Pass the raw value — the jobs.service_type enum is the same
        // as recurring_schedules.service_type so no mapping needed.
        setFragments.push(sql`service_type = ${service_type}::service_type`);
      }
      if (frequency !== undefined) {
        setFragments.push(sql`frequency = ${frequency}::frequency`);
      }
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

    return res.json({
      ...(updated[0] || {}),
      cascade: { updated_jobs: cascadeUpdated },
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
      duration_minutes: recurringSchedulesTable.duration_minutes,
      base_fee: recurringSchedulesTable.base_fee,
      notes: recurringSchedulesTable.notes,
      is_active: recurringSchedulesTable.is_active,
      assigned_employee_id: recurringSchedulesTable.assigned_employee_id,
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
        u.id AS technician_id
      FROM jobs j
      LEFT JOIN users u ON u.id = j.assigned_user_id
      WHERE j.client_id = ${clientId}
        AND j.company_id = ${companyId}
        ${from ? sql`AND j.scheduled_date >= ${from}::date` : sql``}
        ${to   ? sql`AND j.scheduled_date <= ${to}::date`   : sql``}
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

    await db.execute(sql`
      UPDATE jobs SET scheduled_date = ${new_date}::date WHERE id = ${jobId}
    `);

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

