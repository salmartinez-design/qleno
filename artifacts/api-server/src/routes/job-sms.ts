import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, usersTable, companiesTable, jobStatusLogsTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { sendNotification } from "../services/notificationService.js";

const router = Router();

const SMS_MESSAGES: Record<string, (name: string, client: string, addr: string) => string> = {
  on_my_way: (name, client, addr) => `Hi ${client}! Your cleaner ${name} is on their way to ${addr}. They'll arrive shortly!`,
  arrived:   (name, client, addr) => `Hi ${client}! ${name} has arrived at ${addr} and is starting your clean.`,
  paused:    (name, client, addr) => `Hi ${client}! ${name} has paused your clean at ${addr} and will resume shortly.`,
  resumed:   (name, client, addr) => `Hi ${client}! ${name} has resumed your clean at ${addr}.`,
  complete:  (name, client, addr) => `Hi ${client}! Your clean at ${addr} is complete. Thank you for choosing us!`,
};

const SMS_SETTING_MAP: Record<string, keyof typeof companiesTable.$inferSelect> = {
  on_my_way: "sms_on_my_way_enabled",
  arrived:   "sms_arrived_enabled",
  paused:    "sms_paused_enabled",
  resumed:   "sms_paused_enabled",
  complete:  "sms_complete_enabled",
};

async function sendTwilioSms(to: string, from: string, body: string) {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] Job status SMS suppressed:", { to, body: body.substring(0, 80) });
    return { status: "suppressed", reason: "COMMS_ENABLED=false" };
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error("Twilio credentials not configured");

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err?.message || "Twilio API error");
  }
  return res.json();
}

// POST /api/jobs/:id/sms-status — fire SMS event for a job
router.post("/:id/sms-status", requireAuth, async (req, res) => {
  try {
    const jobId    = parseInt(req.params.id);
    const { event } = req.body as { event: string };
    const userId   = req.auth!.userId!;
    const companyId = req.auth!.companyId!;

    if (!SMS_MESSAGES[event]) return res.status(400).json({ error: "Invalid event" });

    // Load job + client
    const jobs = await db.select({
      id: jobsTable.id, status: jobsTable.status, notes: jobsTable.notes,
      client_id: jobsTable.client_id, assigned_user_id: jobsTable.assigned_user_id,
    }).from(jobsTable).where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)));
    const job = jobs[0];
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.assigned_user_id !== userId) return res.status(403).json({ error: "Not your job" });

    const clients = await db.select({ first_name: clientsTable.first_name, last_name: clientsTable.last_name, phone: clientsTable.phone, address: clientsTable.address, city: clientsTable.city }).from(clientsTable).where(eq(clientsTable.id, job.client_id));
    const client = clients[0];

    const employees = await db.select({ first_name: usersTable.first_name, last_name: usersTable.last_name }).from(usersTable).where(eq(usersTable.id, userId));
    const emp = employees[0];

    const companies = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    const company = companies[0];

    // Insert log entry first (regardless of SMS)
    const [log] = await db.insert(jobStatusLogsTable).values({
      company_id: companyId, job_id: jobId, user_id: userId,
      event: event as any, sms_sent: false,
    }).returning();

    // Fire template-based email for on_my_way event (non-blocking)
    if (event === "on_my_way" && client?.phone) {
      const emailMv = {
        first_name:         client.first_name || "",
        technician_name:    `${emp?.first_name ?? ""} ${emp?.last_name ?? ""}`.trim(),
        appointment_window: "shortly",
        service_address:    [client.address, client.city].filter(Boolean).join(", "),
      };
      const clientEmail = await db.select({ email: clientsTable.email })
        .from(clientsTable).where(eq(clientsTable.id, job.client_id)).limit(1)
        .then(r => r[0]?.email ?? null);
      sendNotification("on_my_way", "email", companyId, clientEmail, null, emailMv).catch(() => {});
    }

    // Check SMS enabled for this event
    const settingKey = SMS_SETTING_MAP[event];
    const smsEnabled = settingKey ? (company as any)[settingKey] : false;

    if (!smsEnabled) {
      return res.json({ success: true, sms_sent: false, reason: "SMS disabled for this event", log_id: log.id });
    }

    if (!client?.phone) {
      return res.json({ success: true, sms_sent: false, reason: "Client has no phone number", log_id: log.id });
    }

    if (!company.twilio_from_number) {
      return res.json({ success: true, sms_sent: false, reason: "No Twilio phone number configured", log_id: log.id });
    }

    const clientName = `${client.first_name}`;
    const empName    = `${emp?.first_name ?? "Your cleaner"}`;
    const addr       = [client.address, client.city].filter(Boolean).join(", ") || "your address";
    const message    = SMS_MESSAGES[event](empName, clientName, addr);

    try {
      await sendTwilioSms(client.phone, company.twilio_from_number, message);
      await db.update(jobStatusLogsTable).set({ sms_sent: true }).where(eq(jobStatusLogsTable.id, log.id));
      return res.json({ success: true, sms_sent: true, message, log_id: log.id });
    } catch (smsErr: any) {
      await db.update(jobStatusLogsTable).set({ sms_error: String(smsErr.message) }).where(eq(jobStatusLogsTable.id, log.id));
      return res.json({ success: true, sms_sent: false, reason: smsErr.message, log_id: log.id });
    }
  } catch (err) {
    console.error("SMS status error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/jobs/:id/status-log — get SMS history for a job
router.get("/:id/status-log", requireAuth, async (req, res) => {
  try {
    const jobId     = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;

    const logs = await db.select({
      id: jobStatusLogsTable.id, event: jobStatusLogsTable.event,
      sms_sent: jobStatusLogsTable.sms_sent, sms_error: jobStatusLogsTable.sms_error,
      created_at: jobStatusLogsTable.created_at,
      emp_first: usersTable.first_name, emp_last: usersTable.last_name,
    }).from(jobStatusLogsTable)
      .leftJoin(usersTable, eq(usersTable.id, jobStatusLogsTable.user_id))
      .where(and(eq(jobStatusLogsTable.job_id, jobId), eq(jobStatusLogsTable.company_id, companyId)))
      .orderBy(desc(jobStatusLogsTable.created_at))
      .limit(20);

    return res.json({ data: logs.map(l => ({ ...l, employee: `${l.emp_first ?? ""} ${l.emp_last ?? ""}`.trim() })) });
  } catch (err) {
    console.error("Status log error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
