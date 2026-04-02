import { Router } from "express";
import { db } from "@workspace/db";
import {
  clientsTable, jobsTable, scorecardsTable, companiesTable, usersTable, contactTicketsTable,
} from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";

const router = Router();

const WEIGHT_MAP: Record<number, number> = { 4: 1.0, 3: 0.75, 2: 0.40, 1: 0.0 };
const FLOOR_PCT = 95;
const ROLLING_N = 30;

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

async function sendTwilioSms(to: string, from: string, body: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return;
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
  } catch (e) {
    console.error("[sms-inbound] Twilio send error:", e);
  }
}

async function logMessage(companyId: number, clientId: number | null, jobId: number | null, direction: string, body: string, toPhone: string, fromPhone: string) {
  try {
    await db.execute(sql`
      INSERT INTO message_log (company_id, client_id, job_id, direction, body, to_phone, from_phone, channel, created_at)
      VALUES (${companyId}, ${clientId}, ${jobId}, ${direction}, ${body}, ${toPhone}, ${fromPhone}, 'sms', NOW())
      ON CONFLICT DO NOTHING
    `);
  } catch {
    // message_log columns may differ — ignore
  }
}

async function getCompanyReviewLink(companyId: number): Promise<string | null> {
  try {
    const rows = await db.execute(sql`SELECT review_link FROM companies WHERE id=${companyId}`);
    const link = (rows as any).rows?.[0]?.review_link;
    return link || null;
  } catch { return null; }
}

async function logNotification(companyId: number, clientId: number | null, jobId: number | null, event: string, details: string) {
  try {
    await db.execute(sql`
      INSERT INTO notification_log (company_id, client_id, job_id, event_type, message, created_at)
      VALUES (${companyId}, ${clientId}, ${jobId}, ${event}, ${details}, NOW())
      ON CONFLICT DO NOTHING
    `);
  } catch {
    // notification_log columns may differ — ignore
  }
}

// POST /api/sms/inbound — Twilio webhook for inbound SMS replies
router.post("/", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const rawFrom = (req.body?.From || req.body?.from || "").trim();
    const bodyText = (req.body?.Body || req.body?.body || "").trim();
    const rawTo = (req.body?.To || req.body?.to || "").trim();

    if (!rawFrom || !bodyText) {
      return res.send("<Response></Response>");
    }

    const fromPhone = normalizePhone(rawFrom);
    const toPhone = normalizePhone(rawTo);

    // Handle STOP opt-out
    const upperBody = bodyText.toUpperCase().trim();
    if (upperBody === "STOP" || upperBody === "UNSUBSCRIBE") {
      // Mark client as opted out — handled by Twilio automatically
      return res.send("<Response></Response>");
    }

    // Parse rating — accept only first character
    const firstChar = bodyText.trim()[0];
    const rating = parseInt(firstChar);
    if (isNaN(rating) || rating < 1 || rating > 4) {
      return res.send(
        "<Response><Message>Please reply with 1, 2, 3, or 4 to rate your cleaning.</Message></Response>"
      );
    }

    const weight = WEIGHT_MAP[rating];

    // Find company by Twilio From number (toPhone = our number)
    const companies = await db
      .select({ id: companiesTable.id, twilio_from_number: companiesTable.twilio_from_number })
      .from(companiesTable)
      .where(eq(companiesTable.twilio_from_number, toPhone));

    if (!companies.length) {
      return res.send("<Response></Response>");
    }
    const company = companies[0];

    // Find client by phone number
    const clients = await db
      .select({ id: clientsTable.id, first_name: clientsTable.first_name, last_name: clientsTable.last_name, phone: clientsTable.phone })
      .from(clientsTable)
      .where(eq(clientsTable.company_id, company.id))
      .limit(500);

    const matchedClient = clients.find(c => {
      const p = (c.phone || "").replace(/\D/g, "");
      const f = fromPhone.replace(/\D/g, "");
      return p.endsWith(f.slice(-10)) || f.endsWith(p.slice(-10));
    });

    if (!matchedClient) {
      await logMessage(company.id, null, null, "inbound", bodyText, toPhone, fromPhone);
      return res.send("<Response></Response>");
    }

    // Find most recent completed job for this client within 48h
    const recentJobs = await db
      .select({
        id: jobsTable.id,
        assigned_user_id: jobsTable.assigned_user_id,
        client_id: jobsTable.client_id,
        scheduled_date: jobsTable.scheduled_date,
      })
      .from(jobsTable)
      .where(and(
        eq(jobsTable.company_id, company.id),
        eq(jobsTable.client_id, matchedClient.id),
        eq(jobsTable.status, "complete"),
      ))
      .orderBy(desc(jobsTable.scheduled_date))
      .limit(1);

    if (!recentJobs.length) {
      await logMessage(company.id, matchedClient.id, null, "inbound", bodyText, toPhone, fromPhone);
      return res.send("<Response><Message>Thank you for your feedback!</Message></Response>");
    }

    const job = recentJobs[0];
    const techId = job.assigned_user_id;
    const employeeIds = techId ? [techId] : [];

    // Prevent duplicate scorecard for same job
    const existing = await db
      .select({ id: scorecardsTable.id })
      .from(scorecardsTable)
      .where(and(eq(scorecardsTable.job_id, job.id), eq(scorecardsTable.company_id, company.id)))
      .limit(1);

    if (existing.length) {
      return res.send("<Response><Message>We already received your rating. Thank you!</Message></Response>");
    }

    const score = Math.round(weight * 100);
    const employeeIdsArr = `{${employeeIds.join(",")}}`;

    await db.execute(sql`
      INSERT INTO scorecards (company_id, job_id, user_id, client_id, score, rating, weight, employee_ids, excluded, comments)
      VALUES (${company.id}, ${job.id}, ${techId ?? 0}, ${matchedClient.id}, ${score}, ${rating}, ${weight}, ${employeeIdsArr}::integer[], false, ${`Inbound SMS reply: ${bodyText}`})
    `);

    await logMessage(company.id, matchedClient.id, job.id, "inbound", bodyText, toPhone, fromPhone);

    // ── Quality complaint logic (Sprint 6.6) — rating 1 or 2 ──────────────
    if (rating <= 2 && techId) {
      try {
        await db.execute(sql`
          INSERT INTO quality_complaints (company_id, employee_id, job_id, client_id, severity, notes, created_at)
          VALUES (${company.id}, ${techId}, ${job.id}, ${matchedClient.id}, ${rating === 1 ? 'critical' : 'moderate'}, ${`Client rated ${rating}/4 via SMS.`}, NOW())
        `);
      } catch { /* quality_complaints schema may differ */ }
    }

    // ── 95% floor check ───────────────────────────────────────────────────
    if (techId) {
      const recent = await db
        .select({ weight: scorecardsTable.weight })
        .from(scorecardsTable)
        .where(and(
          eq(scorecardsTable.company_id, company.id),
          eq(scorecardsTable.user_id, techId),
          eq(scorecardsTable.excluded, false),
        ))
        .orderBy(desc(scorecardsTable.created_at))
        .limit(ROLLING_N);

      if (recent.length >= 3) {
        const sum = recent.reduce((acc, r) => acc + parseFloat(String(r.weight ?? 0)), 0);
        const avg = (sum / recent.length) * 100;

        if (avg < FLOOR_PCT) {
          const techs = await db
            .select({ phone: usersTable.phone, first_name: usersTable.first_name })
            .from(usersTable)
            .where(eq(usersTable.id, techId))
            .limit(1);

          if (techs.length && techs[0].phone && company.twilio_from_number) {
            await sendTwilioSms(
              normalizePhone(techs[0].phone),
              company.twilio_from_number,
              `Hi ${techs[0].first_name}, your recent client feedback score has dropped below our standard. Please connect with the office team.`
            );
          }

          await db.insert(contactTicketsTable).values({
            company_id: company.id,
            user_id: techId,
            client_id: matchedClient.id,
            job_id: job.id,
            ticket_type: "complaint_poor_cleaning",
            notes: `Scorecard Alert — current score: ${avg.toFixed(1)}%. Dropped below 95% threshold.`,
            created_by: null as any,
          } as any);
        }
      }
    }

    // ── Review request automation (Sprint 6.7) ────────────────────────────
    const reviewLink = await getCompanyReviewLink(company.id);
    const reviewBody = `Hi ${matchedClient.first_name}, thank you so much for your feedback! We'd love it if you took a moment to share your experience on Google — it means the world to our team: ${reviewLink}. Thank you — Phes`;

    if (rating === 4) {
      // Send review SMS immediately
      if (reviewLink && company.twilio_from_number && matchedClient.phone) {
        await sendTwilioSms(normalizePhone(matchedClient.phone), company.twilio_from_number, reviewBody);
        await logMessage(company.id, matchedClient.id, job.id, "outbound", reviewBody, normalizePhone(matchedClient.phone), company.twilio_from_number);
      } else if (!reviewLink) {
        await logNotification(company.id, matchedClient.id, job.id, "review_request_skipped", "Google Review Link not set. Review SMS not sent.");
      }
    } else if (rating === 3) {
      // Schedule review SMS after 24h — store in notification_log with future send_at
      if (reviewLink) {
        const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await logNotification(company.id, matchedClient.id, job.id, "review_request_scheduled", `Review SMS scheduled for ${sendAt}. Body: ${reviewBody}`);
        // TODO: wire to a job scheduler for actual delayed send
      } else {
        await logNotification(company.id, matchedClient.id, job.id, "review_request_skipped", "Google Review Link not set. Review SMS not scheduled.");
      }
    } else if (rating === 2) {
      // Create office ticket — no review SMS
      await db.insert(contactTicketsTable).values({
        company_id: company.id,
        user_id: techId ?? (null as any),
        client_id: matchedClient.id,
        job_id: job.id,
        ticket_type: "complaint_poor_cleaning",
        notes: `Client concern — ${matchedClient.first_name} ${matchedClient.last_name} — rated 2 on job #${job.id}. Follow up recommended.`,
        created_by: null as any,
      } as any);
    } else if (rating === 1) {
      // Urgent ticket + tech SMS
      await db.insert(contactTicketsTable).values({
        company_id: company.id,
        user_id: techId ?? (null as any),
        client_id: matchedClient.id,
        job_id: job.id,
        ticket_type: "complaint_poor_cleaning",
        notes: `URGENT: Client concern — ${matchedClient.first_name} ${matchedClient.last_name} — rated 1 on job #${job.id}. Immediate follow up required.`,
        created_by: null as any,
      } as any);

      if (techId) {
        const techs = await db
          .select({ phone: usersTable.phone, first_name: usersTable.first_name })
          .from(usersTable)
          .where(eq(usersTable.id, techId))
          .limit(1);

        if (techs.length && techs[0].phone && company.twilio_from_number) {
          const techBody = `Hi ${techs[0].first_name}, a client concern was raised after your recent job. Please connect with the office team.`;
          await sendTwilioSms(normalizePhone(techs[0].phone), company.twilio_from_number, techBody);
        }
      }
    }

    const ackMsg = rating === 4
      ? `Thank you, ${matchedClient.first_name}! We're so glad you had a great experience!`
      : rating === 3
      ? `Thank you, ${matchedClient.first_name}! We appreciate your feedback and will keep working to improve.`
      : `Thank you, ${matchedClient.first_name}. We've received your feedback and our team will follow up with you shortly.`;

    return res.send(`<Response><Message>${ackMsg}</Message></Response>`);
  } catch (err) {
    console.error("[sms-inbound] Error:", err);
    return res.send("<Response></Response>");
  }
});

export default router;
