import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

// ─── GET /api/comms?customer_id=&filter=&limit= ────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const { customer_id, filter, limit = "100" } = req.query;
    const companyId = req.auth!.companyId;
    if (!customer_id) return res.status(400).json({ error: "customer_id required" });

    let whereExtra = "";
    const f = filter as string;
    if (f === "sms") whereExtra = `AND cl.channel IN ('sms','text')`;
    else if (f === "email") whereExtra = `AND cl.channel = 'email'`;
    else if (f === "phone") whereExtra = `AND cl.channel = 'phone'`;
    else if (f === "in_person") whereExtra = `AND cl.channel = 'in_person'`;
    else if (f === "system") whereExtra = `AND cl.source = 'system'`;
    else if (f === "staff") whereExtra = `AND cl.source = 'staff'`;
    else if (f === "inbound") whereExtra = `AND cl.direction = 'inbound'`;
    else if (f === "outbound") whereExtra = `AND cl.direction = 'outbound'`;

    const rows = await db.execute(sql`
      SELECT
        cl.id,
        cl.customer_id,
        cl.job_id,
        cl.direction,
        cl.channel,
        cl.summary,
        cl.body,
        cl.subject,
        cl.source,
        cl.sent_by,
        cl.recipient,
        cl.twilio_message_sid,
        cl.resend_email_id,
        cl.delivery_status,
        cl.opened_at,
        cl.clicked_at,
        cl.logged_at,
        cl.logged_at AS created_at,
        u.first_name || ' ' || u.last_name AS logged_by_name,
        cl.tags
      FROM communication_log cl
      LEFT JOIN users u ON u.id = cl.logged_by
      WHERE cl.company_id = ${companyId}
        AND cl.customer_id = ${parseInt(customer_id as string)}
        ${sql.raw(whereExtra)}
      ORDER BY COALESCE(cl.logged_at, NOW()) DESC
      LIMIT ${parseInt(limit as string)}
    `);

    return res.json(rows.rows);
  } catch (err) {
    console.error("[comms GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/comms/:id/events ──────────────────────────────────────────────
router.get("/:id/events", requireAuth, async (req, res) => {
  try {
    const logId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const rows = await db.execute(sql`
      SELECT ce.*
      FROM communication_events ce
      JOIN communication_log cl ON cl.id = ce.communication_log_id
      WHERE ce.communication_log_id = ${logId}
        AND cl.company_id = ${companyId}
      ORDER BY ce.occurred_at ASC
    `);
    return res.json(rows.rows);
  } catch (err) {
    console.error("[comms events GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/comms — manual staff log entry ───────────────────────────────
router.post("/", requireAuth, async (req, res) => {
  try {
    const {
      customer_id, job_id, direction, channel, summary, tags,
      recipient, subject, body, sent_by,
    } = req.body;
    if (!customer_id || !direction || !channel || (!summary && !body)) {
      return res.status(400).json({ error: "customer_id, direction, channel, and summary/body required" });
    }
    const companyId = req.auth!.companyId;
    const userId = req.auth!.userId;

    const userRes = await db.execute(sql`
      SELECT first_name || ' ' || last_name AS full_name FROM users WHERE id = ${userId} LIMIT 1
    `);
    const staffName = (userRes.rows[0] as any)?.full_name || sent_by || null;

    const result = await db.execute(sql`
      INSERT INTO communication_log
        (company_id, customer_id, job_id, direction, channel, summary, body, subject,
         source, sent_by, recipient, logged_by, delivery_status, tags)
      VALUES
        (${companyId}, ${customer_id}, ${job_id || null}, ${direction}::text, ${channel}::text,
         ${(summary || body || "").trim()}, ${(body || summary || "").trim()},
         ${subject || null}, 'staff', ${staffName}, ${recipient || null},
         ${userId}, 'delivered', ${tags || null})
      RETURNING *
    `);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("[comms POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/comms/ingest — internal: auto-log system messages ─────────────
// Called internally from SMS/email senders — no auth middleware
router.post("/ingest", async (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"];
    if (secret !== process.env.INTERNAL_SECRET && process.env.NODE_ENV === "production") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const {
      company_id, customer_id, job_id,
      direction, channel, source, sent_by,
      recipient, subject, body,
      twilio_message_sid, resend_email_id,
      delivery_status = "sent",
    } = req.body;

    if (!company_id || !customer_id || !channel) {
      return res.status(400).json({ error: "company_id, customer_id, channel required" });
    }

    const result = await db.execute(sql`
      INSERT INTO communication_log
        (company_id, customer_id, job_id, direction, channel, source, sent_by,
         recipient, subject, body, summary, twilio_message_sid, resend_email_id, delivery_status)
      VALUES
        (${company_id}, ${customer_id}, ${job_id || null},
         ${direction || "outbound"}::text, ${channel}::text,
         ${source || "system"}, ${sent_by || null},
         ${recipient || null}, ${subject || null}, ${body || null},
         ${(body || "").substring(0, 200)},
         ${twilio_message_sid || null}, ${resend_email_id || null},
         ${delivery_status})
      RETURNING id
    `);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("[comms ingest]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /api/comms/sms/status — Twilio delivery webhook ────────────────────
router.post("/sms/status", async (req, res) => {
  res.status(200).send("OK");
  try {
    const { MessageSid, MessageStatus, To } = req.body;
    if (!MessageSid || !MessageStatus) return;

    await db.execute(sql`
      UPDATE communication_log
      SET delivery_status = ${MessageStatus}
      WHERE twilio_message_sid = ${MessageSid}
    `);

    const logRes = await db.execute(sql`
      SELECT id FROM communication_log WHERE twilio_message_sid = ${MessageSid} LIMIT 1
    `);
    if (logRes.rows.length > 0) {
      const logId = (logRes.rows[0] as any).id;
      await db.execute(sql`
        INSERT INTO communication_events (communication_log_id, event_type, event_data, occurred_at)
        VALUES (${logId}, ${MessageStatus}, ${JSON.stringify({ To, MessageSid })}, NOW())
      `);
    }
  } catch (err) {
    console.error("[Twilio status webhook]", err);
  }
});

// ─── POST /api/comms/email/webhook — Resend delivery webhook ─────────────────
router.post("/email/webhook", async (req, res) => {
  res.status(200).send("OK");
  try {
    const { type, data } = req.body;
    if (!type || !data) return;

    const emailId = data.email_id;
    if (!emailId) return;

    const statusMap: Record<string, string> = {
      "email.sent": "sent",
      "email.delivered": "delivered",
      "email.opened": "delivered",
      "email.clicked": "delivered",
      "email.bounced": "undelivered",
      "email.complained": "failed",
    };
    const newStatus = statusMap[type];

    if (newStatus) {
      await db.execute(sql`
        UPDATE communication_log
        SET
          delivery_status = ${newStatus},
          opened_at = CASE WHEN ${type} = 'email.opened' AND opened_at IS NULL THEN NOW() ELSE opened_at END,
          clicked_at = CASE WHEN ${type} = 'email.clicked' AND clicked_at IS NULL THEN NOW() ELSE clicked_at END
        WHERE resend_email_id = ${emailId}
      `);

      const logRes = await db.execute(sql`
        SELECT id FROM communication_log WHERE resend_email_id = ${emailId} LIMIT 1
      `);
      if (logRes.rows.length > 0) {
        const logId = (logRes.rows[0] as any).id;
        await db.execute(sql`
          INSERT INTO communication_events (communication_log_id, event_type, event_data, occurred_at)
          VALUES (${logId}, ${type}, ${JSON.stringify(data)}, NOW())
        `);
      }
    }
  } catch (err) {
    console.error("[Resend webhook]", err);
  }
});

export default router;
