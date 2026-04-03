import { Router } from "express";
import { db } from "@workspace/db";
import {
  clientsTable, jobsTable, usersTable, invoicesTable,
  scorecardsTable, clientHomesTable, technicianPreferencesTable,
  clientNotificationsTable, clientCommunicationsTable, clientAgreementsTable,
  serviceZonesTable, quotesTable, contactTicketsTable, clientAttachmentsTable,
  recurringSchedulesTable, jobPhotosTable,
} from "@workspace/db/schema";
import { eq, and, ilike, or, count, sum, desc, sql, gte, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
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

    // Fetch last job date per client to determine AT RISK
    const clientIds = clients.map(c => c.id);
    let lastJobMap: Record<number, string | null> = {};
    if (clientIds.length > 0) {
      const lastJobs = await db
        .select({ client_id: jobsTable.client_id, scheduled_date: jobsTable.scheduled_date })
        .from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, req.auth!.companyId),
          eq(jobsTable.status, "complete"),
          inArray(jobsTable.client_id, clientIds)
        ))
        .orderBy(desc(jobsTable.scheduled_date));
      for (const r of lastJobs) {
        if (!lastJobMap[r.client_id!] && r.scheduled_date) lastJobMap[r.client_id!] = r.scheduled_date;
      }
    }

    // Fetch next job date per client
    let nextJobMap: Record<number, string | null> = {};
    if (clientIds.length > 0) {
      const nextJobs = await db
        .select({ client_id: jobsTable.client_id, scheduled_date: jobsTable.scheduled_date })
        .from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, req.auth!.companyId),
          sql`${jobsTable.status} IN ('scheduled','in_progress')`,
          sql`${jobsTable.scheduled_date} >= CURRENT_DATE`,
          inArray(jobsTable.client_id, clientIds)
        ))
        .orderBy(jobsTable.scheduled_date);
      for (const r of nextJobs) {
        if (!nextJobMap[r.client_id!] && r.scheduled_date) nextJobMap[r.client_id!] = r.scheduled_date;
      }
    }

    const enriched = clients.map(c => {
      const last = lastJobMap[c.id];
      const daysSinceLast = last
        ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000)
        : 999;
      return {
        ...c,
        last_service_date: last || null,
        next_service_date: nextJobMap[c.id] || null,
        at_risk: false, // disabled until churn thresholds configured in company settings
        days_since_last: daysSinceLast,
      };
    });

    const totalResult = await db
      .select({ count: count() })
      .from(clientsTable)
      .where(and(...conditions));

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
    const avg_bill = invoices.length ? revenue_all_time / invoices.length : 0;

    // Look up zone data if client has a zone_id
    let zoneData: { zone_name: string; zone_color: string } | null = null;
    if (client.zone_id) {
      const [zone] = await db.select({ name: serviceZonesTable.name, color: serviceZonesTable.color })
        .from(serviceZonesTable).where(eq(serviceZonesTable.id, client.zone_id)).limit(1);
      if (zone) zoneData = { zone_name: zone.name, zone_color: zone.color };
    }

    return res.json({
      ...client,
      ...(zoneData || {}),
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
        scorecard_avg: scorecards.length ? scorecards.reduce((s, sc) => s + sc.score, 0) / scorecards.length : null,
      },
    });
  } catch (err) {
    console.error("Full profile error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
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
    } = req.body;
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
      ...(newZoneId !== undefined && { zone_id: newZoneId }),
    }).where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, req.auth!.companyId))).returning();
    if (!updated[0]) return res.status(404).json({ error: "Not Found" });

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
    const { frequency, day_of_week, duration_minutes, base_fee, service_type, notes } = req.body;
    const updated = await db.update(recurringSchedulesTable).set({
      ...(frequency && { frequency }),
      ...(day_of_week !== undefined && { day_of_week }),
      ...(duration_minutes !== undefined && { duration_minutes: duration_minutes === "" ? null : parseInt(String(duration_minutes)) || null }),
      ...(base_fee !== undefined && { base_fee: base_fee === "" ? null : String(base_fee) }),
      ...(service_type !== undefined && { service_type }),
      ...(notes !== undefined && { notes }),
    }).where(and(
      eq(recurringSchedulesTable.customer_id, clientId),
      eq(recurringSchedulesTable.company_id, companyId),
      eq(recurringSchedulesTable.is_active, true),
    )).returning();
    return res.json(updated[0] || null);
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

    await db.execute(sql`
      INSERT INTO job_reschedule_log (job_id, company_id, old_date, new_date, reason, notes, changed_by)
      VALUES (${jobId}, ${companyId}, ${oldDate}::date, ${new_date}::date, ${reason}, ${notes || null}, ${userId})
    `);

    return res.json({ ok: true, old_date: oldDate, new_date });
  } catch (err) {
    console.error("PATCH reschedule:", err);
    return res.status(500).json({ error: "Failed to reschedule job" });
  }
});

export default router;

