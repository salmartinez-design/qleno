import { Router } from "express";
import { db } from "@workspace/db";
import { communicationLogTable, clientsTable, companiesTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

async function sendTwilioSms(to: string, from: string, body: string) {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] Manual SMS suppressed:", { to, body: body.substring(0, 80) });
    return { status: "suppressed", reason: "COMMS_ENABLED=false" };
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error("Twilio credentials not configured");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    }
  );
  if (!res.ok) {
    const err: any = await res.json();
    throw new Error(err?.message || "Twilio API error");
  }
  return res.json();
}

// GET /api/communications/sms/status — check if Twilio is configured
router.get("/sms/status", requireAuth, async (_req, res) => {
  const configured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  return res.json({ configured });
});

// GET /api/communications — fetch communication thread for a customer
router.get("/", requireAuth, async (req, res) => {
  try {
    const { customer_id, job_id } = req.query;
    if (!customer_id) return res.status(400).json({ error: "customer_id required" });
    const companyId = req.auth!.companyId;

    const conditions: ReturnType<typeof eq>[] = [
      eq(communicationLogTable.company_id, companyId),
      eq(communicationLogTable.customer_id, parseInt(customer_id as string)),
    ];
    if (job_id) conditions.push(eq(communicationLogTable.job_id, parseInt(job_id as string)));

    const rows = await db
      .select()
      .from(communicationLogTable)
      .where(and(...conditions))
      .orderBy(desc(communicationLogTable.logged_at))
      .limit(50);

    return res.json(rows);
  } catch (err) {
    console.error("[communications GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/communications/sms — send a custom SMS to a client from the job panel
router.post("/sms", requireAuth, async (req, res) => {
  try {
    const { customer_id, job_id, message } = req.body;
    if (!customer_id || !message) {
      return res.status(400).json({ error: "customer_id and message required" });
    }
    const companyId = req.auth!.companyId;

    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      return res.status(503).json({
        error: "sms_unconfigured",
        message: "SMS not configured — add Twilio keys in Company Settings to enable messaging.",
      });
    }

    const clients = await db
      .select({ phone: clientsTable.phone, first_name: clientsTable.first_name })
      .from(clientsTable)
      .where(eq(clientsTable.id, parseInt(customer_id)))
      .limit(1);
    const client = clients[0];
    if (!client?.phone) {
      return res.status(422).json({ error: "Client has no phone number on file" });
    }

    const companies = await db
      .select({ twilio_from_number: companiesTable.twilio_from_number })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);
    const company = companies[0];
    if (!company?.twilio_from_number) {
      return res.status(503).json({
        error: "sms_unconfigured",
        message: "No Twilio phone number configured for your company.",
      });
    }

    try {
      await sendTwilioSms(client.phone, company.twilio_from_number, message);
    } catch (smsErr: any) {
      return res.status(502).json({ error: "sms_failed", message: smsErr.message });
    }

    const [log] = await db
      .insert(communicationLogTable)
      .values({
        company_id: companyId,
        customer_id: parseInt(customer_id),
        job_id: job_id ? parseInt(job_id) : null,
        direction: "outbound",
        channel: "sms",
        summary: message,
        logged_by: req.auth!.userId,
      })
      .returning();

    return res.json({ success: true, log_id: log.id });
  } catch (err) {
    console.error("[communications/sms POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/communications/sms/webhook — Twilio inbound SMS webhook (no auth — Twilio calls this)
router.post("/sms/webhook", async (req, res) => {
  try {
    const { From, Body } = req.body as { From?: string; Body?: string };
    if (!From || !Body) return res.status(400).send("Bad Request");

    const clients = await db
      .select({ id: clientsTable.id, company_id: clientsTable.company_id })
      .from(clientsTable)
      .where(eq(clientsTable.phone, From))
      .limit(1);
    const client = clients[0];

    if (client) {
      await db.insert(communicationLogTable).values({
        company_id: client.company_id,
        customer_id: client.id,
        direction: "inbound",
        channel: "sms",
        summary: Body,
      });
    }

    res.set("Content-Type", "text/xml");
    return res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    console.error("[communications/sms/webhook]", err);
    return res.status(500).send("Error");
  }
});

export default router;
