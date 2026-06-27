// [sms-mms-scheduling] Process pending scheduled SMS/MMS messages whose
// scheduled_for <= NOW(). Called from the minute cron tick in index.ts.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function processScheduledSms(): Promise<void> {
  // Fetch due messages (with a SELECT FOR UPDATE SKIP LOCKED to avoid double-send
  // in future multi-instance deployments).
  const due = await db.execute(sql`
    SELECT id, company_id, contact_phone, client_id, lead_id, message, media_urls
      FROM scheduled_sms
     WHERE status = 'pending' AND scheduled_for <= NOW()
     LIMIT 20`);

  if (!due.rows.length) return;

  const { resolveSender, sendSmsVia } = await import("./comms-sender.js");
  const { recordOutboundSms, matchContact } = await import("./sms-store.js");
  const { r2Configured, r2SignedGetUrl } = await import("./r2.js");

  for (const row of due.rows as any[]) {
    const { id, company_id, contact_phone, client_id, lead_id, message, media_urls } = row;
    try {
      // Mark in-flight immediately to prevent double-sends on slow iterations
      await db.execute(sql`UPDATE scheduled_sms SET status = 'sending' WHERE id = ${id} AND status = 'pending'`);

      const mediaKeys: string[] = Array.isArray(media_urls) ? media_urls : [];
      let twilioMediaUrls: string[] = [];
      if (mediaKeys.length > 0 && r2Configured()) {
        twilioMediaUrls = await Promise.all(mediaKeys.map((k: string) => r2SignedGetUrl(k, 3600)));
      }

      const sender = await resolveSender(company_id, null);
      let twilioResult: any = null;
      let smsStatus = "suppressed";
      let failureReason: string | null = null;

      if (!sender.reason) {
        twilioResult = await sendSmsVia(sender, contact_phone, message || "", twilioMediaUrls.length ? twilioMediaUrls : undefined);
        smsStatus = "sent";
      } else {
        failureReason = sender.reason;
      }

      // Resolve contact if not already linked
      let resolvedClientId = client_id;
      let resolvedLeadId = lead_id;
      if (resolvedClientId == null && resolvedLeadId == null) {
        const m = await matchContact(company_id, contact_phone);
        resolvedClientId = m.client_id;
        resolvedLeadId = m.lead_id;
      }

      const { id: smsId } = await recordOutboundSms({
        companyId: company_id,
        toRaw: contact_phone,
        fromNumber: sender.from_number,
        body: message || "",
        providerId: twilioResult?.sid ?? null,
        clientId: resolvedClientId,
        leadId: resolvedLeadId,
        status: smsStatus,
        mediaUrls: mediaKeys.length ? mediaKeys : null,
        scheduledSmsId: id,
      });

      await db.execute(sql`
        UPDATE scheduled_sms
           SET status = ${failureReason ? "failed" : "sent"},
               sent_sms_id = ${smsId},
               failure_reason = ${failureReason}
         WHERE id = ${id}`);
    } catch (e: any) {
      console.error(`[sms-scheduler] scheduled_sms id=${id} failed:`, e?.message ?? e);
      await db.execute(sql`
        UPDATE scheduled_sms SET status = 'failed', failure_reason = ${e?.message ?? "unknown"}
         WHERE id = ${id}`);
    }
  }
}
