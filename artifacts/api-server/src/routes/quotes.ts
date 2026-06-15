import { Router } from "express";
import { db } from "@workspace/db";
import { quotesTable, clientsTable, pricingScopesTable, recurringSchedulesTable, usersTable } from "@workspace/db/schema";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { getBranchByZip } from "../lib/branchRouter";
import { randomBytes } from "crypto";
import { generateJobsFromSchedule, DAYS_AHEAD } from "../lib/recurring-jobs.js";
import { persistJobAddOns } from "./jobs.js";

const router = Router();

// [quote-convert-stickiness 2026-06-10] Map the quote's `addons` jsonb
// (addon_breakdown rows: { id: pricing_addons.id, name, amount, price_type })
// into the shape persistJobAddOns expects. The convert previously dropped
// every sold add-on on the floor — the booked job had no job_add_ons rows, so
// the tech card's "Services this visit", the edit-job modal, and invoicing all
// lost the extras the office sold on the quote.
function quoteAddonsToJobAddOns(addons: unknown): { pricing_addon_id?: number; qty: number; unit_price?: number; subtotal?: number }[] {
  if (!Array.isArray(addons)) return [];
  return addons
    .map((a: any) => ({
      pricing_addon_id: Number(a?.id) || undefined,
      qty: 1,
      unit_price: a?.amount != null ? Number(a.amount) : undefined,
      subtotal: a?.amount != null ? Number(a.amount) : undefined,
    }))
    .filter(a => a.pricing_addon_id);
}

async function getQuoteWithDetails(id: number, companyId: number) {
  const [quote] = await db
    .select({
      id: quotesTable.id,
      company_id: quotesTable.company_id,
      client_id: quotesTable.client_id,
      lead_name: quotesTable.lead_name,
      lead_email: quotesTable.lead_email,
      lead_phone: quotesTable.lead_phone,
      address: quotesTable.address,
      service_type: quotesTable.service_type,
      frequency: quotesTable.frequency,
      estimated_hours: quotesTable.estimated_hours,
      base_price: quotesTable.base_price,
      total_price: quotesTable.total_price,
      discount_amount: quotesTable.discount_amount,
      discount_code: quotesTable.discount_code,
      status: quotesTable.status,
      sent_at: quotesTable.sent_at,
      viewed_at: quotesTable.viewed_at,
      accepted_at: quotesTable.accepted_at,
      booked_job_id: quotesTable.booked_job_id,
      notes: quotesTable.notes,
      created_by: quotesTable.created_by,
      created_at: quotesTable.created_at,
      scope_id: quotesTable.scope_id,
      pricing_method: quotesTable.pricing_method,
      addons: quotesTable.addons,
      bedrooms: quotesTable.bedrooms,
      bathrooms: quotesTable.bathrooms,
      half_baths: quotesTable.half_baths,
      sqft: quotesTable.sqft,
      dirt_level: quotesTable.dirt_level,
      pets: quotesTable.pets,
      special_instructions: quotesTable.special_instructions,
      internal_memo: quotesTable.internal_memo,
      client_notes: quotesTable.client_notes,
      call_notes: quotesTable.call_notes,
      manual_hours: quotesTable.manual_hours,
      office_notes: quotesTable.office_notes,
      manual_adjustments: quotesTable.manual_adjustments,
      expires_at: quotesTable.expires_at,
      sign_token: quotesTable.sign_token,
      client_first: clientsTable.first_name,
      client_last: clientsTable.last_name,
      client_email: clientsTable.email,
      client_phone: clientsTable.phone,
      scope_name: pricingScopesTable.name,
      scope_category: pricingScopesTable.scope_group,
    })
    .from(quotesTable)
    .leftJoin(clientsTable, eq(quotesTable.client_id, clientsTable.id))
    .leftJoin(pricingScopesTable, eq(quotesTable.scope_id, pricingScopesTable.id))
    .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, companyId)))
    .limit(1);
  return quote;
}

router.get("/stats", requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const { branch_id } = req.query;
    const statsConds: any[] = [eq(quotesTable.company_id, req.auth!.companyId)];
    if (branch_id && branch_id !== "all") statsConds.push(eq(quotesTable.branch_id, parseInt(branch_id as string)));

    const allQuotes = await db.select({ status: quotesTable.status, accepted_at: quotesTable.accepted_at, booked_job_id: quotesTable.booked_job_id })
      .from(quotesTable)
      .where(and(...statsConds));

    const total = allQuotes.length;
    const pending = allQuotes.filter(q => q.status === "sent" || q.status === "viewed").length;
    const accepted_this_month = allQuotes.filter(q => q.status === "accepted" && q.accepted_at && new Date(q.accepted_at) >= monthStart).length;
    const converted = allQuotes.filter(q => q.status === "booked" || q.booked_job_id).length;

    return res.json({ total, pending, accepted_this_month, converted });
  } catch (err) {
    console.error("Quote stats error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, client_id, branch_id } = req.query;
    const conditions: any[] = [eq(quotesTable.company_id, req.auth!.companyId)];
    if (status && status !== "all") conditions.push(eq(quotesTable.status, status as string));
    if (client_id) conditions.push(eq(quotesTable.client_id, parseInt(client_id as string)));
    if (branch_id && branch_id !== "all") conditions.push(eq(quotesTable.branch_id, parseInt(branch_id as string)));

    const quotes = await db
      .select({
        id: quotesTable.id,
        company_id: quotesTable.company_id,
        client_id: quotesTable.client_id,
        lead_name: quotesTable.lead_name,
        lead_email: quotesTable.lead_email,
        address: quotesTable.address,
        frequency: quotesTable.frequency,
        estimated_hours: quotesTable.estimated_hours,
        base_price: quotesTable.base_price,
        total_price: quotesTable.total_price,
        discount_amount: quotesTable.discount_amount,
        status: quotesTable.status,
        sent_at: quotesTable.sent_at,
        accepted_at: quotesTable.accepted_at,
        created_at: quotesTable.created_at,
        scope_id: quotesTable.scope_id,
        bedrooms: quotesTable.bedrooms,
        bathrooms: quotesTable.bathrooms,
        sqft: quotesTable.sqft,
        client_first: clientsTable.first_name,
        client_last: clientsTable.last_name,
        client_email: clientsTable.email,
        scope_name: pricingScopesTable.name,
        // [quote-breakdown 2026-06-08] who quoted + residential/commercial split.
        created_by: quotesTable.created_by,
        quoted_by_first: usersTable.first_name,
        quoted_by_last: usersTable.last_name,
        client_type: clientsTable.client_type,
      })
      .from(quotesTable)
      .leftJoin(clientsTable, eq(quotesTable.client_id, clientsTable.id))
      .leftJoin(pricingScopesTable, eq(quotesTable.scope_id, pricingScopesTable.id))
      .leftJoin(usersTable, eq(quotesTable.created_by, usersTable.id))
      .where(and(...conditions))
      .orderBy(desc(quotesTable.created_at));

    return res.json(quotes);
  } catch (err) {
    console.error("List quotes error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const quote = await getQuoteWithDetails(parseInt(req.params.id), req.auth!.companyId);
    if (!quote) return res.status(404).json({ error: "Not Found" });
    return res.json(quote);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const {
      client_id, lead_name, lead_email, lead_phone, address,
      scope_id, pricing_method, frequency, estimated_hours, manual_hours,
      base_price, total_price, discount_amount, discount_code, addons,
      bedrooms, bathrooms, half_baths, sqft, dirt_level, pets,
      special_instructions, internal_memo, client_notes, notes, status,
      unit_suite, referral_source, office_notes, manual_adjustments,
    } = req.body;

    const scope = scope_id ? await db.select().from(pricingScopesTable).where(eq(pricingScopesTable.id, scope_id)).limit(1) : null;

    // Resolve branch from client zip for branch tagging
    let quoteBranch = "oak_lawn";
    if (client_id) {
      try {
        const [cl] = await db.select({ zip: clientsTable.zip }).from(clientsTable).where(eq(clientsTable.id, client_id)).limit(1);
        if (cl?.zip) quoteBranch = getBranchByZip(cl.zip).branch;
      } catch {}
    }

    const [q] = await db.insert(quotesTable).values({
      company_id: req.auth!.companyId,
      client_id: client_id || null,
      lead_name, lead_email, lead_phone, address,
      service_type: scope?.[0]?.name || null,
      frequency, estimated_hours: estimated_hours ? String(estimated_hours) : null,
      manual_hours: manual_hours ? String(manual_hours) : null,
      base_price: base_price ? String(base_price) : null,
      total_price: total_price ? String(total_price) : null,
      discount_amount: discount_amount ? String(discount_amount) : "0",
      discount_code: discount_code || null,
      addons: addons || [],
      scope_id: scope_id || null,
      pricing_method: pricing_method || scope?.[0]?.pricing_method || null,
      bedrooms, bathrooms, half_baths, sqft,
      dirt_level: dirt_level || "standard",
      pets: pets || 0,
      special_instructions, internal_memo, client_notes, notes,
      office_notes: office_notes || null,
      manual_adjustments: manual_adjustments || [],
      unit_suite: unit_suite || null,
      referral_source: referral_source || null,
      address_verified: req.body.address_verified === true,
      photo_urls: req.body.photo_urls || [],
      status: status || "draft",
      created_by: req.auth!.userId,
      branch: quoteBranch,
    } as any).returning();

    logAudit(req, "CREATE", "quote", q.id, null, { status: q.status, total_price: q.total_price });
    // Quote→lead: find-or-create the lead + link it (non-blocking).
    import("../lib/lead-sync.js").then(({ upsertLeadForQuote }) =>
      upsertLeadForQuote(req.auth!.companyId, q).catch(() => {})).catch(() => {});
    return res.status(201).json(q);
  } catch (err) {
    console.error("Create quote error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const allowed = [
      "status", "base_price", "total_price", "estimated_hours", "manual_hours",
      "notes", "client_notes", "internal_memo", "special_instructions", "call_notes",
      "frequency", "scope_id", "pricing_method", "addons",
      "discount_code", "discount_amount", "bedrooms", "bathrooms", "half_baths",
      "sqft", "dirt_level", "pets", "sent_at", "viewed_at", "accepted_at",
      "lead_name", "lead_email", "lead_phone", "address", "client_id",
      "alternate_options", "zone_override", "unit_suite", "referral_source", "address_verified",
      "photo_urls", "office_notes", "manual_adjustments",
    ];
    const updates: any = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        if (["base_price", "total_price", "estimated_hours", "manual_hours", "discount_amount"].includes(k)) {
          updates[k] = req.body[k] !== null ? String(req.body[k]) : null;
        } else {
          updates[k] = req.body[k];
        }
      }
    }

    const [q] = await db.update(quotesTable).set(updates)
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, req.auth!.companyId)))
      .returning();

    if (!q) return res.status(404).json({ error: "Not found" });
    const auditAction = updates.status === "draft" ? "DRAFT_SAVED" : "UPDATE";
    logAudit(req, auditAction, "quote", id, null, { status: q.status, total_price: q.total_price });
    return res.json(q);
  } catch (err) {
    console.error("Update quote error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/send", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const [q] = await db.update(quotesTable)
      .set({ status: "sent", sent_at: new Date() })
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, companyId)))
      .returning();
    if (!q) return res.status(404).json({ error: "Not found" });

    // Ensure a public sign_token exists so the customer-facing quote page
    // (app.qleno.com/estimate/<token>, served by the estimates public endpoint
    // with a quote fallback) resolves instead of 404ing. Generated once and
    // reused; idempotent on re-send.
    if (!(q as any).sign_token) {
      const tok = randomBytes(24).toString("hex");
      await db.execute(sql`UPDATE quotes SET sign_token = ${tok} WHERE id = ${id}`);
      (q as any).sign_token = tok;
    }
    console.log(`[QUOTE SENT] id=${id} lead_email=${q.lead_email}`);
    // Enroll in quote_followup sequence (non-blocking)
    import("../services/followUpService.js").then(({ enrollForQuoteSent }) => {
      enrollForQuoteSent(
        companyId,
        id,
        (q as any).client_id ?? null,
        (q as any).lead_name?.split(" ")[0] || "",
        (q as any).lead_email ?? null,
        (q as any).lead_phone ?? null,
      ).catch(() => {});
    });
    // Quote→lead: advance the lead to Quoted + link the enrollment (non-blocking).
    import("../lib/lead-sync.js").then(async ({ upsertLeadForQuote, advanceLeadStage, linkEnrollmentToLead }) => {
      const leadId = await upsertLeadForQuote(companyId, q);
      if (leadId) {
        await advanceLeadStage(companyId, leadId, "quoted", { quoteAmount: (q as any).total_price ?? (q as any).base_price ?? null, userId: req.auth!.userId });
        await linkEnrollmentToLead(companyId, id, leadId);
      }
    }).catch(() => {});
    // NOTE: the quote email + SMS are delivered by the quote-followup CADENCE
    // (touch 1 = the MaidCentral-styled quote email, touch 2 = the quote SMS),
    // enrolled just above via enrollForQuoteSent. The old immediate `quote_sent`
    // notification was removed — it was the source of the broken Replit link and
    // the wrong (global-env Oak Lawn) SMS number, and it double-sent on top of
    // cadence touch 1. The cadence renders the link from sign_token via the
    // per-tenant sender (resolveSender), so this consolidates quote comms onto a
    // single correct path.
    return res.json({ success: true, quote: q });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/accept", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [q] = await db.update(quotesTable)
      .set({ status: "accepted", accepted_at: new Date() })
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, req.auth!.companyId)))
      .returning();
    if (!q) return res.status(404).json({ error: "Not found" });
    // Stop quote_followup enrollment (non-blocking)
    import("../services/followUpService.js").then(({ stopEnrollmentsForQuote }) => {
      stopEnrollmentsForQuote(id, "booked").catch(() => {});
    });
    return res.json({ success: true, quote: q });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/convert", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const { scheduled_date, scheduled_time, assigned_user_id } = req.body || {};

    // Mark quote as booked
    const [q] = await db.update(quotesTable)
      .set({ status: "booked" })
      .where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, companyId)))
      .returning();
    if (!q) return res.status(404).json({ error: "Not found" });

    // Create the actual job
    const jobDate = scheduled_date || new Date().toISOString().split("T")[0];
    // Map scope name → service_type enum value
    const SCOPE_TO_ENUM: Record<string, string> = {
      "deep clean": "deep_clean",
      "standard clean": "standard_clean",
      "move in / move out": "move_out",
      "move in/move out": "move_out",
      "one-time standard clean": "standard_clean",
      "recurring cleaning": "recurring",
      "recurring cleaning - weekly": "recurring",
      "recurring cleaning - every 2 weeks": "recurring",
      "recurring cleaning - every 4 weeks": "recurring",
      "hourly deep clean": "deep_clean",
      "hourly standard cleaning": "standard_clean",
      "commercial cleaning": "office_cleaning",
      "ppm turnover": "ppm_turnover",
      "ppm common areas": "common_areas",
      "multi-unit common areas": "common_areas",
    };
    let serviceType = "standard_clean";
    if (q.scope_id) {
      const scopeResult = await db.execute(sql`SELECT name FROM pricing_scopes WHERE id = ${q.scope_id} LIMIT 1`);
      const scopeName = ((scopeResult.rows[0] as any)?.name || "").toLowerCase().trim();
      serviceType = SCOPE_TO_ENUM[scopeName] || "standard_clean";
    }

    // Map frequency to enum
    const freqRaw = (q.frequency || "onetime").toLowerCase().replace(/[- ]/g, "_");
    const FREQ_MAP: Record<string, string> = {
      "weekly": "weekly", "biweekly": "biweekly", "every_2_weeks": "biweekly",
      "monthly": "monthly", "every_4_weeks": "monthly", "onetime": "on_demand", "one_time": "on_demand",
    };
    const jobFreq = FREQ_MAP[freqRaw] || "on_demand";

    // [recurring-convert-fix 2026-06-05] A recurring quote must create a
    // recurring_schedule and GENERATE THE SERIES — not a single job. The
    // convert previously inserted one job with frequency='weekly' and stopped,
    // so "scheduling a recurrence" only ever produced the first visit
    // (Maribel's bug). When the quote is recurring and tied to a client, build
    // the schedule and synchronously generate the next 90 days (first
    // occurrence included). This calls generateJobsFromSchedule directly, so it
    // works regardless of the RECURRING_ENGINE_ENABLED cron flag.
    const isRecurring = jobFreq !== "on_demand";
    if (isRecurring && q.client_id) {
      const [sched] = await db.insert(recurringSchedulesTable).values({
        company_id: companyId,
        customer_id: q.client_id,
        frequency: jobFreq,
        day_of_week: null, // cadence anchors on start_date's weekday when null
        start_date: jobDate,
        end_date: null,
        assigned_employee_id: assigned_user_id ? parseInt(String(assigned_user_id)) : null,
        service_type: serviceType,
        scheduled_time: scheduled_time || null,
        duration_minutes: q.estimated_hours ? Math.round(parseFloat(String(q.estimated_hours)) * 60) : null,
        base_fee: q.total_price != null ? String(q.total_price) : null,
        notes: q.internal_memo || null,
      }).returning();

      // [quote-convert-stickiness 2026-06-10] Persist the quote's add-ons onto
      // the schedule template (so the edit-job cascade machinery sees them)…
      const schedAddons = quoteAddonsToJobAddOns(q.addons);
      for (const a of schedAddons) {
        try {
          await db.execute(sql`
            INSERT INTO recurring_schedule_add_ons (recurring_schedule_id, pricing_addon_id, qty)
            VALUES (${sched.id}, ${a.pricing_addon_id}, ${a.qty})
          `);
        } catch (e) { console.warn("[quote convert] schedule add-on insert failed:", e); }
      }

      let generated = { created: 0, skipped: 0 };
      try {
        const cl = await db.select({ zip: clientsTable.zip }).from(clientsTable).where(eq(clientsTable.id, q.client_id)).limit(1);
        const clientZip = (cl[0]?.zip as any) ?? null;
        const today = new Date();
        const horizon = new Date(today.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
        generated = await generateJobsFromSchedule(sched as any, today, horizon, null, clientZip);
      } catch (genErr: any) {
        console.warn("[quote convert] recurring generation failed:", genErr?.message ?? genErr);
      }

      // …and onto every occurrence just generated (the engine only stamps the
      // parking fee at generation time, not schedule add-ons).
      if (schedAddons.length) {
        try {
          const genRows = await db.execute(sql`SELECT id FROM jobs WHERE recurring_schedule_id = ${sched.id} AND company_id = ${companyId}`);
          for (const row of (genRows as any).rows) {
            await persistJobAddOns(db, Number(row.id), companyId, schedAddons);
          }
        } catch (e) { console.warn("[quote convert] stamping add-ons on generated jobs failed:", e); }
      }

      logAudit(req, "CONVERTED", "quote", id, null, { status: "booked", recurring_schedule_id: sched.id, jobs_generated: generated.created });
      import("../services/followUpService.js").then(({ stopEnrollmentsForQuote }) => {
        stopEnrollmentsForQuote(id, "booked").catch(() => {});
      });
      // Quote→lead: advance to Booked (non-blocking).
      import("../lib/lead-sync.js").then(async ({ upsertLeadForQuote, advanceLeadStage }) => {
        const leadId = await upsertLeadForQuote(companyId, { ...(q as any), id });
        if (leadId) await advanceLeadStage(companyId, leadId, "booked", { userId: req.auth!.userId });
      }).catch(() => {});
      return res.json({
        success: true, quote: q, recurring_schedule_id: sched.id, jobs_generated: generated.created,
        message: `Quote converted — recurring schedule created with ${generated.created} visit${generated.created === 1 ? "" : "s"} over the next ${DAYS_AHEAD} days.`,
      });
    }

    // [addon-hours 2026-06-04] Carry the quote's estimated hours (which now
    // include add-on time-adds) onto the job as BOTH allowed_hours and
    // estimated_hours. Previously the convert wrote neither, so every
    // quote-booked job landed with NULL allowed_hours — the dispatch Gantt
    // rendered a flat default block and the add-on time never showed up.
    const jobResult = await db.execute(sql`
      INSERT INTO jobs (
        company_id, client_id, scheduled_date, scheduled_time,
        service_type, base_fee, status, assigned_user_id,
        frequency, notes, allowed_hours, estimated_hours, created_at
      ) VALUES (
        ${companyId},
        ${q.client_id || null},
        ${jobDate},
        ${scheduled_time || null},
        ${sql.raw(`'${serviceType}'::service_type`)},
        ${q.total_price || '0'},
        'scheduled',
        ${assigned_user_id || null},
        ${sql.raw(`'${jobFreq}'::frequency`)},
        ${q.internal_memo || null},
        ${q.estimated_hours || null},
        ${q.estimated_hours || null},
        NOW()
      ) RETURNING id
    `);
    const jobId = (jobResult.rows[0] as any)?.id;

    // Link job back to quote (safe — column may not exist yet)
    if (jobId) {
      try {
        await db.execute(sql`UPDATE quotes SET booked_job_id = ${jobId} WHERE id = ${id}`);
      } catch { /* column may not exist */ }
    }

    // [quote-convert-stickiness 2026-06-10] Two more things that previously
    // didn't stick through the convert:
    // 1. branch_id — stamped from the client's home branch. NULL branch was
    //    papered over in the dispatch filter, but timeclock branch attribution
    //    (stamps branch at clock-in, defaults Oak Lawn) and hours-by-branch
    //    reporting still misattributed Schaumburg work.
    // 2. add-ons — the extras sold on the quote now land in job_add_ons, so
    //    the tech card's "Services this visit", the edit-job modal, and
    //    invoicing keep them.
    if (jobId && q.client_id) {
      try {
        await db.execute(sql`
          UPDATE jobs SET branch_id = (SELECT branch_id FROM clients WHERE id = ${q.client_id})
          WHERE id = ${jobId} AND branch_id IS NULL
        `);
      } catch (e) { console.warn("[quote convert] branch stamp failed:", e); }
    }
    const jobAddons = quoteAddonsToJobAddOns(q.addons);
    if (jobId && jobAddons.length) {
      try {
        await persistJobAddOns(db, jobId, companyId, jobAddons);
      } catch (e) { console.warn("[quote convert] add-on persistence failed:", e); }
    }

    // [quote-convert-assignment-mirror] When the office assigns a tech on the
    // Review step, the INSERT above already mirrors onto jobs.assigned_user_id,
    // but the convert previously NEVER wrote job_technicians. That split-brain
    // left the chip in the dispatch Unassigned row ("job needs assignment")
    // even though a tech was chosen in the quote tool. Per the assignment-mirror
    // invariant, every code path that assigns a tech MUST write both. Promote
    // the chosen tech to primary (is_primary=true) so the dispatch grid and the
    // per-tech fan-out recognize the assignment.
    const assignedTechId = assigned_user_id ? parseInt(String(assigned_user_id)) : NaN;
    if (jobId && !isNaN(assignedTechId)) {
      await db.execute(sql`
        INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
        VALUES (${jobId}, ${assignedTechId}, ${companyId}, true)
        ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
      `);
    }

    logAudit(req, "CONVERTED", "quote", id, null, { status: "booked", total_price: q.total_price, job_id: jobId });

    // Booking confirmation email (job_scheduled). Per-tenant via sendNotification
    // (company gate + from-address resolved by company). Previously NO confirmation
    // went out for a quote→job booking; now the customer gets the appointment +
    // policy details. Non-blocking; gate-respecting.
    if ((q as any).lead_email) {
      import("../services/notificationService.js").then(({ sendNotification }) => {
        const apptDate = (() => { try { return new Date(jobDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }); } catch { return jobDate; } })();
        const mv = {
          first_name:      (q as any).lead_name?.split(" ")[0] || "",
          appointment_date: apptDate,
          appointment_time: scheduled_time || "your scheduled window",
          service_type:    serviceType.replace(/_/g, " "),
          service_address: (q as any).address || "",
        };
        sendNotification("job_scheduled", "email", companyId, (q as any).lead_email, null, mv).catch(() => {});
      }).catch(() => {});
    }

    // Stop quote_followup enrollment (non-blocking)
    import("../services/followUpService.js").then(({ stopEnrollmentsForQuote }) => {
      stopEnrollmentsForQuote(id, "booked").catch(() => {});
    });
    // Quote→lead: advance to Booked + link the job (non-blocking).
    import("../lib/lead-sync.js").then(async ({ upsertLeadForQuote, advanceLeadStage }) => {
      const leadId = await upsertLeadForQuote(companyId, { ...(q as any), id });
      if (leadId) await advanceLeadStage(companyId, leadId, "booked", { jobId, userId: req.auth!.userId });
    }).catch(() => {});

    return res.json({ success: true, quote: q, job_id: jobId, message: "Quote converted and job created." });
  } catch (err) {
    console.error("Convert quote error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(quotesTable).where(and(eq(quotesTable.id, id), eq(quotesTable.company_id, req.auth!.companyId)));
    logAudit(req, "DELETE", "quote", id, null, null);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
