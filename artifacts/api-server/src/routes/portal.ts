import { Router } from "express";
import { db } from "@workspace/db";
import {
  companiesTable, clientsTable, jobsTable, usersTable,
  clientRatingsTable, additionalPayTable
} from "@workspace/db/schema";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { requirePortalAuth, requireCapability, portalCapabilities } from "../lib/portal-auth.js";
import { payDayNow } from "../lib/pay-day.js";
import {
  classifyHold, getActiveHold, getHoldAllowance, resolveHoldPolicy,
} from "../lib/service-hold.js";
import { placeHold, liftHold, holdCapDays, todayYmd, addDays } from "../lib/service-hold-actions.js";
import { describeCadence } from "../lib/recurring-cadences.js";

const router = Router();

// [customer-portal 2026-08-05] This file used to own its own login and its own
// session guard. Both are gone:
//
//  - The LOGIN was dead code. It gated on `clients.portal_password_hash`, a
//    column absent from the Drizzle schema (it existed in ebda8989 / 2ac5a4c2
//    and was removed), so `db.select()` never returned it and every attempt hit
//    "Portal access not enabled". Nobody could ever sign in. Replaced by
//    POST /api/portal/auth/login (routes/portal-auth.ts).
//
//  - The local GUARD read `payload.userId` as a CLIENT id. Under the new
//    identity model that field is a portal_users id, so keeping it would have
//    silently scoped every route below to the wrong customer's rows. It now
//    uses the shared requirePortalAuth, which re-reads portal_users on each
//    request and hands back the attachment.
//
// Also removed: an UNAUTHENTICATED POST /invite-client that accepted client_id,
// company_id and a caller-chosen temp_password, then flipped portal_access on.
// It took the tenant from the request body, so it was cross-tenant by
// construction. Superseded by POST /api/portal/auth/invite, which is
// staff-gated and reads the email off the record rather than the body.
//
// The routes here are residential (client-scoped) by nature. Commercial
// customers reach their account through the /api/portal/account/* routes;
// requireResidential below is what keeps the two from crossing.

/**
 * These routes address a single residential client. A commercial portal user
 * has no client_id, so rather than letting `clientId` fall through as null and
 * quietly matching nothing (or, worse, matching a row with a NULL client_id),
 * refuse the request outright.
 */
function requireResidential(req: Request, res: Response, next: NextFunction): void {
  const session = req.portalSession;
  if (!session?.clientId) {
    res.status(403).json({ error: "Forbidden", message: "Not available on a commercial account" });
    return;
  }
  next();
}

// Resolve the client + company this request may touch. Straight off the
// session, which came off the portal_users row — never off the request.
const scope = (req: Request) => ({
  clientId: req.portalSession!.clientId as number,
  companyId: req.portalSession!.companyId,
});

router.get("/company/:slug", async (req, res) => {
  try {
    const company = await db
      .select({ id: companiesTable.id, name: companiesTable.name, slug: companiesTable.slug, logo_url: companiesTable.logo_url, brand_color: companiesTable.brand_color })
      .from(companiesTable)
      .where(eq(companiesTable.slug, req.params.slug))
      .limit(1);
    if (!company[0]) return res.status(404).json({ error: "Company not found" });
    return res.json(company[0]);
  } catch (err) { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.get("/me", requirePortalAuth, requireResidential, async (req, res) => {
  try {
    // An EXPLICIT column list, not select(). This used to return the whole
    // clients row — 80-odd columns including alarm_code, home_access_notes,
    // office_notes, suspend_reason, the Stripe and Square customer handles, the
    // portal invite token and the unsubscribe token — straight into the
    // customer's browser. Nothing rendered them; they simply travelled. A
    // customer may see their own contact details and nothing about how we run
    // their account.
    const [client] = await db
      .select({
        id: clientsTable.id,
        first_name: clientsTable.first_name,
        last_name: clientsTable.last_name,
        email: clientsTable.email,
        phone: clientsTable.phone,
        address: clientsTable.address,
        city: clientsTable.city,
        state: clientsTable.state,
        zip: clientsTable.zip,
        // profile_picture_url and service_suspended are real columns that the
        // Drizzle model does not carry yet (the existing update below casts
        // `as any` for the same reason). Named in SQL rather than widening the
        // shared schema from inside a portal change.
        profile_picture_url: sql<string | null>`clients.profile_picture_url`,
        service_suspended: sql<boolean>`COALESCE(clients.service_suspended, false)`,
        suspend_until: clientsTable.suspend_until,
      })
      .from(clientsTable)
      .where(and(
        eq(clientsTable.id, scope(req).clientId),
        eq(clientsTable.company_id, scope(req).companyId),
      ))
      .limit(1);
    if (!client) return res.status(404).json({ error: "Not found" });

    const [company] = await db
      .select({
        name: companiesTable.name,
        slug: companiesTable.slug,
        logo_url: companiesTable.logo_url,
        brand_color: companiesTable.brand_color,
        phone: companiesTable.phone,
        email: companiesTable.email,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, scope(req).companyId))
      .limit(1);

    // Capabilities and the impersonation flag ride along, the way they do on
    // the commercial side. Without them the portal shell has to guess what to
    // render, and an office user viewing as a customer gets no banner telling
    // them (or the customer watching over their shoulder) that this is a
    // read-only support session.
    return res.json({
      ...client,
      name: [client.first_name, client.last_name].filter(Boolean).join(" "),
      company: company ?? null,
      capabilities: portalCapabilities(req.portalSession!),
      impersonated: req.portalSession!.impersonatedBy != null,
    });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.get("/jobs", requirePortalAuth, requireResidential, async (req, res) => {
  try {
    // [portal-service-account 2026-08-20] Was a flat "20 most recent, newest
    // first", which meant a weekly customer could see about five months of
    // history and, once they had more than 20 past visits, NONE of their
    // upcoming ones — the thing they actually open the portal for. Upcoming and
    // past are now fetched as two windows so one can never crowd out the other.
    const today = new Date().toISOString().slice(0, 10);
    const cols = {
      id: jobsTable.id,
      service_type: jobsTable.service_type,
      status: jobsTable.status,
      scheduled_date: jobsTable.scheduled_date,
      scheduled_time: jobsTable.scheduled_time,
      // Web bookings put the chosen time here, not in scheduled_time, so a
      // portal that read only scheduled_time would show a blank time to every
      // customer who booked online. Not on the Drizzle model yet.
      arrival_window: sql<string | null>`jobs.arrival_window`,
      base_fee: jobsTable.base_fee,
      cleaner_first: usersTable.first_name,
      cleaner_last: usersTable.last_name,
      cleaner_avatar: usersTable.avatar_url,
    };
    const mine = and(
      eq(jobsTable.client_id, scope(req).clientId),
      eq(jobsTable.company_id, scope(req).companyId),
    );

    const upcoming = await db.select(cols).from(jobsTable)
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(and(mine, gte(jobsTable.scheduled_date, today), sql`${jobsTable.status}::text <> 'cancelled'`))
      .orderBy(jobsTable.scheduled_date)
      .limit(60);

    const past = await db.select(cols).from(jobsTable)
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(and(mine, sql`${jobsTable.scheduled_date} < ${today}`))
      .orderBy(desc(jobsTable.scheduled_date))
      .limit(40);

    return res.json({ today, upcoming, past });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.post("/rate", requirePortalAuth, requireResidential, requireCapability("rateClean"), async (req, res) => {
  try {
    const { job_id, score, comment } = req.body;
    if (!job_id || !score) return res.status(400).json({ error: "job_id and score required" });

    const existing = await db
      .select({ id: clientRatingsTable.id })
      .from(clientRatingsTable)
      .where(and(eq(clientRatingsTable.job_id, job_id), eq(clientRatingsTable.client_id, scope(req).clientId)))
      .limit(1);

    if (existing[0]) {
      await db.update(clientRatingsTable)
        .set({ score, comment })
        .where(eq(clientRatingsTable.id, existing[0].id));
    } else {
      await db.insert(clientRatingsTable).values({
        company_id: scope(req).companyId,
        client_id: scope(req).clientId,
        job_id,
        score,
        comment,
      });
    }

    // [client-scoring → scorecard] A portal star rating (1–4) is a customer
    // rating of the job → flow it to the job's tech(s) Performance Score, same
    // as a tokenized survey response. Idempotent per (job, tech); a later
    // survey/portal rating of the same job replaces it. Non-fatal — the rating
    // is already saved above; the scorecard write is derived.
    try {
      const [job] = await db.select({ dt: jobsTable.scheduled_date })
        .from(jobsTable).where(eq(jobsTable.id, job_id)).limit(1);
      const entryDate = job?.dt ? String(job.dt).slice(0, 10) : new Date().toISOString().slice(0, 10);
      const { captureJobScore } = await import("../lib/scorecard-engine.js");
      await captureJobScore({
        companyId: scope(req).companyId, jobId: job_id,
        score: Math.max(0, Math.min(4, Math.round(Number(score)))),
        entryDate, notes: comment || null,
      });
    } catch (e: any) {
      console.error("[portal/rate] scorecard capture failed (non-fatal):", e?.message ?? e);
    }

    return res.json({ success: true });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

router.post("/tip", requirePortalAuth, requireResidential, requireCapability("payInvoice"), async (req, res) => {
  try {
    const { job_id, amount } = req.body;
    if (!job_id || !amount) return res.status(400).json({ error: "job_id and amount required" });

    const job = await db
      .select({ assigned_user_id: jobsTable.assigned_user_id, company_id: jobsTable.company_id })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, job_id), eq(jobsTable.client_id, scope(req).clientId)))
      .limit(1);

    if (!job[0] || !job[0].assigned_user_id) {
      return res.status(404).json({ error: "Job not found or no cleaner assigned" });
    }

    await db.insert(additionalPayTable).values({
      company_id: job[0].company_id,
      user_id: job[0].assigned_user_id,
      amount: String(amount),
      type: "tips",
      notes: `Client tip via portal for job #${job_id}`,
      job_id,
      // [pay-day 2026-08-17] A customer tipping at 9pm was landing in the next
      // day's payroll, because created_at defaulted to a UTC now() already past
      // midnight. Stamp the tenant's own calendar day.
      effective_date: payDayNow(job[0].company_id),
    });

    return res.json({ success: true, message: `Tip of $${amount} recorded` });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

// ── POST /api/portal/profile-picture ────────────────────────────────────────
router.post("/profile-picture", requirePortalAuth, requireResidential, async (req, res) => {
  try {
    const { image_data } = req.body; // base64 data URL e.g. "data:image/jpeg;base64,..."
    if (!image_data || typeof image_data !== "string") {
      return res.status(400).json({ error: "image_data is required" });
    }
    // Basic validation: must be a data URL
    if (!image_data.startsWith("data:image/")) {
      return res.status(400).json({ error: "Invalid image format" });
    }
    // Limit to ~2MB base64 (~1.5MB actual image)
    if (image_data.length > 2_800_000) {
      return res.status(413).json({ error: "Image too large. Please use an image under 1.5MB." });
    }
    await db
      .update(clientsTable)
      .set({ profile_picture_url: image_data } as any)
      .where(and(
        eq(clientsTable.id, scope(req).clientId),
        eq(clientsTable.company_id, scope(req).companyId),
      ));
    return res.json({ success: true });
  } catch { return res.status(500).json({ error: "Internal Server Error" }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// [portal-service-account 2026-08-20] The residential customer's own account.
//
// Everything below answers for ONE client — the one on the session — and none
// of it takes a client id from the request. The office already has all of this;
// what was missing was the customer's side of the same glass, which is why a
// customer had to phone in to learn when we were coming next or what their
// agreement said.
//
// Two rules run through all of it:
//
//  1. The ACT is shared, the ADAPTER is not. A hold placed here is the same
//     ledger row, consuming the same rolling-12-month allowance, as a hold the
//     office places — both go through lib/service-hold-actions.ts. Two
//     implementations of "pause this customer" would have drifted within a
//     month, and the drift would have shown up as a bill.
//  2. Nothing that MOVES MONEY is self-executing. A free hold is inside the
//     days the agreement already grants, so the customer may place it. A hold
//     long enough to count as termination notice ends the agreement and bills
//     the notice period, so it becomes a request the office answers. Same
//     philosophy as mileage and overtime: capture it, surface it, let a person
//     approve the dollars.
// ═══════════════════════════════════════════════════════════════════════════

const money = (v: any) => (v == null ? 0 : parseFloat(String(v)) || 0);

// [portal-self-serve-holds 2026-08-20] Sal, asked whether a customer should be
// able to pause their own service or whether every pause should reach the office
// first: "lets hold off on that for now."
//
// So every pause a customer starts is a REQUEST, including the short free ones
// that the agreement already entitles them to. The preview screen is untouched:
// they still see how long the pause is, how many pause days they have left, and
// whether it would end their service, before they send anything. What changed is
// only who presses the last button.
//
// One constant, read in two places, so turning self-service back on is one line
// and not an archaeology exercise. When it flips to true, a free pause executes
// immediately and only a notice-length pause stays a request.
const SELF_SERVE_HOLDS: boolean = false;

// ── GET /api/portal/plan ────────────────────────────────────────────────────
// What we agreed to do for you, in your own words: how often we come, what it
// costs, whether service is paused right now, and how much pause time is left.
router.get("/plan", requirePortalAuth, requireResidential, async (req, res) => {
  try {
    const { clientId, companyId } = scope(req);

    // Live schedules AND ones we paused for a hold. Excluding the paused ones
    // would tell a customer on hold that they have no schedule at all, which is
    // the opposite of the truth.
    const schedRows = await db.execute(sql`
      SELECT id, frequency, day_of_week, days_of_week, days_of_month,
             custom_frequency_weeks, week_of_month, month_interval,
             start_date::text AS start_date, end_date::text AS end_date,
             base_fee, monthly_charge_amount, is_active, paused_by_suspension
        FROM recurring_schedules
       WHERE customer_id = ${clientId} AND company_id = ${companyId}
         AND (is_active = true OR paused_by_suspension = true)
       ORDER BY id`);

    const schedules = (schedRows.rows as any[]).map((r) => ({
      id: Number(r.id),
      cadence: describeCadence(r as any),
      rate: money(r.base_fee) || money(r.monthly_charge_amount),
      since: r.start_date ? String(r.start_date).slice(0, 10) : null,
      paused: r.paused_by_suspension === true,
    }));

    const [policy, allowance, hold] = await Promise.all([
      resolveHoldPolicy(companyId),
      getHoldAllowance(companyId, clientId, todayYmd()),
      getActiveHold(companyId, clientId),
    ]);

    // The signed agreement itself. Listed by its public sign token so the PDF
    // the customer downloads is byte-identical to the one they signed, rendered
    // by the same code — not a second renderer that could disagree with it.
    const agrRows = await db.execute(sql`
      SELECT s.id, s.sign_token, s.status, s.signature_name,
             s.signature_at, s.sent_at, t.name AS template_name
        FROM form_submissions s
        LEFT JOIN form_templates t ON t.id = s.form_id
       WHERE s.client_id = ${clientId} AND s.company_id = ${companyId}
         AND s.status IN ('sent', 'viewed', 'signed', 'completed')
       ORDER BY COALESCE(s.signature_at, s.sent_at, s.created_at) DESC
       LIMIT 10`);

    return res.json({
      today: todayYmd(),
      schedules,
      // One line for the whole plan when there is only one schedule, which is
      // the residential norm. Multiple schedules keep their own lines above.
      cadence: schedules.length === 1 ? schedules[0].cadence : null,
      hold: hold
        ? {
            kind: hold.kind as string,
            start_date: hold.start_date,
            end_date: hold.end_date,
            days: Number(hold.days) || 0,
            // A notice hold is not a pause — it is the last month of service.
            // Saying "paused" there would be a lie the customer acts on.
            ends_service: hold.kind === "notice",
          }
        : null,
      pause_days: {
        allowed: allowance.allowed,
        used: allowance.used,
        remaining: allowance.remaining,
        since: allowance.windowStart,
      },
      notice_days: policy.noticeDays,
      max_pause_days: policy.maxDays,
      agreements: (agrRows.rows as any[]).map((r) => ({
        id: Number(r.id),
        name: r.template_name || "Service agreement",
        status: r.signature_at ? "signed" : r.status,
        signed_at: r.signature_at ?? null,
        signed_by: r.signature_name ?? null,
        // The public token route (routes/sign.ts) already serves these.
        pdf_url: r.sign_token ? `/api/sign/${r.sign_token}/agreement.pdf` : null,
        certificate_url: r.signature_at && r.sign_token ? `/api/sign/${r.sign_token}/certificate.pdf` : null,
      })),
    });
  } catch (err) {
    console.error("Portal plan error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not load your plan" });
  }
});

// ── GET /api/portal/hold/preview?until=YYYY-MM-DD ───────────────────────────
// The same classification the office sees before it suspends anyone, shown to
// the customer BEFORE they confirm. If a pause runs past the free days it ends
// their agreement and bills the notice period, and they have to be able to read
// that — with the visit dates and the dollar amount — while they can still
// choose a shorter date.
router.get("/hold/preview", requirePortalAuth, requireResidential, requireCapability("manageHold"), async (req, res) => {
  try {
    const { clientId, companyId } = scope(req);
    const until = String(req.query.until ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return res.status(400).json({ error: "Bad Request", message: "Choose a date to pause until" });
    }
    const today = todayYmd();
    if (until <= today) {
      return res.status(400).json({ error: "Bad Request", message: "Pick a date in the future" });
    }
    const cap = await holdCapDays(companyId);
    const capUntil = addDays(today, cap);
    if (until > capUntil) {
      return res.status(400).json({
        error: "Bad Request",
        message: `We can pause service up to ${cap} days out. Call us and we will work out anything longer.`,
        max_until: capUntil,
      });
    }

    const c = await classifyHold(companyId, clientId, addDays(today, 1), until);
    return res.json({
      until,
      days: c.days,
      // The word the customer reads. "notice" is our word; theirs is that this
      // one ends the service.
      ends_service: c.kind === "notice",
      // A hold that ends service is never self-serve, whatever the capability
      // says, and right now nothing is. The screen uses this to swap Confirm for
      // Send request.
      needs_office: !SELF_SERVE_HOLDS || c.kind === "notice",
      cadence: c.cadence,
      pause_days: {
        allowed: c.allowance.allowed,
        remaining: c.allowance.remaining,
        this_pause: c.freeDaysUsed,
      },
      notice: c.notice
        ? {
            visits: c.notice.visits,
            amount: c.notice.amount,
            dates: c.notice.dates,
            through: c.notice.windowEnd,
            days: c.policy.noticeDays,
          }
        : null,
    });
  } catch (err) {
    console.error("Portal hold preview error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not check those dates" });
  }
});

// ── POST /api/portal/hold ───────────────────────────────────────────────────
// Pause service. Free holds execute; anything that would end the agreement is
// filed as a request instead — see the header note.
router.post("/hold", requirePortalAuth, requireResidential, requireCapability("manageHold"), async (req, res) => {
  try {
    const { clientId, companyId } = scope(req);
    const until = String(req.body?.until ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return res.status(400).json({ error: "Bad Request", message: "Choose a date to pause until" });
    }
    const today = todayYmd();
    const c = await classifyHold(companyId, clientId, addDays(today, 1), until);

    const isNotice = c.kind === "notice";
    if (!SELF_SERVE_HOLDS || isNotice) {
      // Deliberately NOT executed here. A notice-length pause ends the agreement
      // and charges the notice period, and a customer clicking a button in a
      // browser must not be the last checkpoint on that. A free pause is only a
      // request while SELF_SERVE_HOLDS is off. Either way it lands in the same
      // queue as every other portal request.
      const notes = isNotice
        ? `Requested from the customer portal. This pause runs ${c.days} days, past the ${c.policy.freeDays} pause days the agreement includes, so it would serve as ${c.policy.noticeDays} days notice to end service. Cadence: ${c.cadence}. Final visits if it goes ahead: ${c.notice?.visits ?? 0} totalling $${(c.notice?.amount ?? 0).toFixed(2)}.`
        : `Requested from the customer portal. This pause runs ${c.days} days and sits inside the ${c.policy.freeDays} pause days the agreement includes, so nothing is billed. Cadence: ${c.cadence}. Pause days left after this one: ${Math.max(0, c.allowance.remaining - c.freeDaysUsed)}.`;
      const ins = await db.execute(sql`
        INSERT INTO portal_service_requests
          (company_id, client_id, requested_by_portal_user_id, service_description, preferred_date, notes)
        VALUES (${companyId}, ${clientId}, ${req.portalSession!.portalUserId},
                ${`Pause service through ${until}`}, ${until}, ${notes})
        RETURNING id`);
      return res.status(202).json({
        ok: true,
        needs_office: true,
        request_id: (ins.rows[0] as any)?.id ?? null,
        message: isNotice
          ? "We have your request. Because this pause is longer than the pause time your agreement includes, someone from the office will call you before anything changes."
          : "We have your request. Someone from the office will confirm your pause and get back to you. Nothing changes on your schedule until then.",
      });
    }

    const result = await placeHold({
      companyId, clientId, until,
      reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null,
      notify: true,
      actor: { kind: "customer", portalUserId: req.portalSession!.portalUserId },
    });

    if (!result.ok) {
      switch (result.refusal) {
        case "client_not_found":
          return res.status(404).json({ error: "Not Found", message: "We could not find your account" });
        case "already_on_hold":
          return res.status(409).json({ error: "Conflict", message: "Your service is already paused" });
        case "date_not_future":
          return res.status(400).json({ error: "Bad Request", message: "Pick a date in the future" });
        case "date_too_far":
          return res.status(400).json({
            error: "Bad Request",
            message: `We can pause service up to ${result.capDays} days out. Call us and we will work out anything longer.`,
          });
        default:
          // notice_not_acknowledged cannot reach here: the notice branch above
          // never calls placeHold. Refuse rather than guess.
          return res.status(409).json({ error: "Conflict", message: "Give us a call and we will sort this out with you" });
      }
    }

    return res.json({
      ok: true,
      until: result.until,
      cancelled_visits: result.cancelledJobs,
      pause_days_remaining: result.freeDaysRemaining,
      message: `Service is paused through ${result.until}. Nothing is charged while you are paused.`,
    });
  } catch (err) {
    console.error("Portal hold error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not pause your service" });
  }
});

// ── POST /api/portal/hold/resume ────────────────────────────────────────────
// Come back early. Nothing is charged for resuming, and a notice hold resumed
// before it runs out never becomes a termination — which is exactly why this
// has to be one click and not a phone call.
router.post("/hold/resume", requirePortalAuth, requireResidential, requireCapability("manageHold"), async (req, res) => {
  try {
    const { clientId, companyId } = scope(req);
    const result = await liftHold({
      companyId, clientId,
      actor: { kind: "customer", portalUserId: req.portalSession!.portalUserId },
    });
    if (!result.ok) {
      return result.refusal === "not_on_hold"
        ? res.status(409).json({ error: "Conflict", message: "Your service is already running" })
        : res.status(404).json({ error: "Not Found", message: "We could not find your account" });
    }
    return res.json({
      ok: true,
      pause_days_remaining: result.allowance.remaining,
      message: "Welcome back. We will be in touch to confirm your next visit.",
    });
  } catch (err) {
    console.error("Portal resume error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not restart your service" });
  }
});

// ── GET /api/portal/invoices ────────────────────────────────────────────────
// The residential capability table has said `viewInvoices: true` since the
// portal shipped, with no route behind it. This is that route.
router.get("/invoices", requirePortalAuth, requireResidential, requireCapability("viewInvoices"), async (req, res) => {
  try {
    const { clientId, companyId } = scope(req);
    const today = todayYmd();
    const rows = await db.execute(sql`
      SELECT i.id, i.invoice_number, i.total, i.due_date, i.paid_at,
             COALESCE(i.service_date,
               (SELECT j.scheduled_date FROM jobs j WHERE j.id = i.job_id)) AS service_date
        FROM invoices i
       WHERE i.client_id = ${clientId} AND i.company_id = ${companyId}
         AND i.status NOT IN ('draft', 'void', 'batched', 'superseded')
         AND i.parent_invoice_id IS NULL
       ORDER BY service_date DESC NULLS LAST, i.id DESC
       LIMIT 60`);

    const invoices = (rows.rows as any[]).map((r) => ({
      id: Number(r.id),
      invoice_number: r.invoice_number,
      // Our statuses are bookkeeping words. Theirs is paid, due, or overdue.
      status: r.paid_at ? "paid"
        : r.due_date && String(r.due_date).slice(0, 10) < today ? "overdue"
        : "due",
      total: money(r.total),
      due_date: r.due_date ? String(r.due_date).slice(0, 10) : null,
      service_date: r.service_date ? String(r.service_date).slice(0, 10) : null,
      paid_at: r.paid_at ?? null,
    }));
    return res.json({
      invoices,
      outstanding: invoices.filter((i) => i.status !== "paid").reduce((sum, i) => sum + i.total, 0),
    });
  } catch (err) {
    console.error("Portal invoices error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not load your invoices" });
  }
});

// ── GET /api/portal/invoices/:id/pdf ────────────────────────────────────────
router.get("/invoices/:id/pdf", requirePortalAuth, requireResidential, requireCapability("downloadInvoicePdf"), async (req, res) => {
  try {
    const { clientId, companyId } = scope(req);
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) return res.status(404).json({ error: "Not Found" });
    // Re-checked against the caller's own client id. The id came off the URL,
    // so ownership is never assumed from the fact that they asked.
    const own = await db.execute(sql`
      SELECT id FROM invoices
       WHERE id = ${id} AND client_id = ${clientId} AND company_id = ${companyId}
         AND status NOT IN ('draft', 'void', 'batched', 'superseded')
       LIMIT 1`);
    if (!own.rows[0]) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });

    const { buildInvoicePdfBuffer } = await import("./invoices.js");
    const out = await buildInvoicePdfBuffer(companyId, id);
    if (!out) return res.status(404).json({ error: "Not Found", message: "Invoice not found" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${out.filename}"`);
    return res.end(out.buffer);
  } catch (err) {
    console.error("Portal invoice PDF error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not build that invoice" });
  }
});

// ── Service requests ────────────────────────────────────────────────────────
// "Add an extra clean" for a residential customer. Same table, same office
// queue, same rule as the commercial side: a request is an ASK, never a job. It
// carries no price and reserves no cleaner, because a customer writing directly
// into the dispatch board would put unpriced, unassigned work on the schedule
// and into revenue.
router.get("/service-requests", requirePortalAuth, requireResidential, async (req, res) => {
  try {
    const { clientId, companyId } = scope(req);
    const rows = await db.execute(sql`
      SELECT id, service_description, preferred_date, notes, status, office_note, created_at
        FROM portal_service_requests
       WHERE client_id = ${clientId} AND company_id = ${companyId}
       ORDER BY created_at DESC
       LIMIT 50`);
    return res.json((rows.rows as any[]).map((r) => ({
      id: Number(r.id),
      service: r.service_description,
      preferred_date: r.preferred_date ? String(r.preferred_date).slice(0, 10) : null,
      notes: r.notes,
      status: r.status,
      office_note: r.office_note,
      created_at: r.created_at,
    })));
  } catch (err) {
    console.error("Portal service-requests list error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not load your requests" });
  }
});

router.post("/service-requests", requirePortalAuth, requireResidential, requireCapability("requestService"), async (req, res) => {
  try {
    const { clientId, companyId } = scope(req);
    const description = String(req.body?.service_description ?? "").trim();
    if (description.length < 3 || description.length > 2000) {
      return res.status(400).json({ error: "Bad Request", message: "Tell us briefly what you need" });
    }
    const notes = req.body?.notes ? String(req.body.notes).slice(0, 4000) : null;
    const preferred = typeof req.body?.preferred_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.preferred_date)
      ? req.body.preferred_date : null;

    const ins = await db.execute(sql`
      INSERT INTO portal_service_requests
        (company_id, client_id, requested_by_portal_user_id, service_description, preferred_date, notes)
      VALUES (${companyId}, ${clientId}, ${req.portalSession!.portalUserId}, ${description}, ${preferred}, ${notes})
      RETURNING id`);

    return res.status(201).json({
      ok: true,
      id: (ins.rows[0] as any)?.id,
      message: "Request sent. We will confirm a date with you shortly.",
    });
  } catch (err) {
    console.error("Portal service-request create error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not send your request" });
  }
});

// ── POST /api/portal/referrals ──────────────────────────────────────────────
// [referral-one-program 2026-08-20] This used to write a lead and stop there.
// The same customer referring the same friend from the booking confirmation page
// got the whole program: a referrals row, the office alert, a $25-off email to
// the friend and a thank-you to them. From the portal they got a lead nobody
// could trace and a $25 credit that never existed. Both surfaces now call
// submitReferral, so a referral means the same thing wherever it was sent from.
//
// The portal knows exactly who is referring (it is the signed-in customer), so
// it passes the client id rather than letting the program guess by email.
router.post("/referrals", requirePortalAuth, requireResidential, requireCapability("submitReferral"), async (req, res) => {
  try {
    const { clientId, companyId } = scope(req);
    const { submitReferral } = await import("../lib/referral-program.js");
    const result = await submitReferral({
      companyId,
      surface: "portal",
      referralType: req.body?.referral_type === "commercial" ? "commercial" : "residential",
      referrer: { clientId },
      referred: {
        name: req.body?.name,
        phone: req.body?.phone,
        email: req.body?.email,
        zip: req.body?.zip,
        note: req.body?.note,
      },
    });
    if (!result.ok) return res.status(400).json({ error: "Bad Request", message: result.message });

    // The timeline entry is what makes the referral traceable back to the
    // customer who sent it on the lead's own screen, alongside the referrals row.
    if (result.leadId) {
      const [referrer] = await db
        .select({ first_name: clientsTable.first_name, last_name: clientsTable.last_name })
        .from(clientsTable)
        .where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, companyId)))
        .limit(1);
      const referrerName = [referrer?.first_name, referrer?.last_name].filter(Boolean).join(" ") || `Client #${clientId}`;
      await db.execute(sql`
        INSERT INTO lead_activity_log (lead_id, company_id, action_type, note)
        VALUES (${result.leadId}, ${companyId}, 'referral_received',
                ${`Portal referral from ${referrerName} (client #${clientId}). ${result.promo}.`})`);
    }

    return res.status(201).json({ ok: true, message: result.message });
  } catch (err) {
    console.error("Portal referral error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not send that referral" });
  }
});

export default router;
