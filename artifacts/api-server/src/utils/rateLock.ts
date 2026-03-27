import { db } from "@workspace/db";
import { sql as dsql } from "drizzle-orm";

async function getOfferSettings(companyId: number) {
  const result = await db.execute(
    dsql`SELECT * FROM offer_settings WHERE company_id = ${companyId} LIMIT 1`
  );
  if (result.rows.length === 0) {
    return { overrun_threshold_percent: 20, overrun_jobs_trigger: 2, service_gap_days: 60, rate_lock_duration_months: 24, renewal_alert_days: 30 };
  }
  return result.rows[0] as any;
}

async function sendLockEmail(subject: string, html: string) {
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({ from: "Qleno <noreply@phes.io>", to: "info@phes.io", subject, html });
  } catch (err) {
    console.error("[RATE_LOCK] Email send failed:", err);
  }
}

export async function checkRateLockVoidConditions(clientId: number, companyId: number): Promise<void> {
  try {
    const settings = await getOfferSettings(companyId);
    const threshold = parseFloat(settings.overrun_threshold_percent ?? 20);
    const triggerCount = parseInt(settings.overrun_jobs_trigger ?? 2);

    const recentJobs = await db.execute(
      dsql`
        SELECT id, estimated_hours, actual_duration, status
        FROM jobs
        WHERE client_id = ${clientId}
          AND company_id = ${companyId}
          AND status = 'complete'
          AND frequency != 'onetime'
        ORDER BY scheduled_date DESC
        LIMIT 3
      `
    );

    const overrunJobs = (recentJobs.rows as any[]).filter(j => {
      if (!j.actual_duration || !j.estimated_hours) return false;
      const estimatedMins = parseFloat(j.estimated_hours) * 60;
      return j.actual_duration > estimatedMins * (1 + threshold / 100);
    });

    if (overrunJobs.length >= triggerCount) {
      const activeLock = await db.execute(
        dsql`SELECT id, locked_rate FROM rate_locks WHERE client_id = ${clientId} AND active = true LIMIT 1`
      );
      if (activeLock.rows.length > 0) {
        const lock = activeLock.rows[0] as any;
        const clientRow = await db.execute(
          dsql`SELECT first_name, last_name FROM clients WHERE id = ${clientId} LIMIT 1`
        );
        const clientName = clientRow.rows.length > 0
          ? `${(clientRow.rows[0] as any).first_name} ${(clientRow.rows[0] as any).last_name}`
          : `Client #${clientId}`;

        await db.execute(
          dsql`UPDATE rate_locks SET active = false, void_reason = 'time_overrun', voided_at = NOW() WHERE id = ${lock.id}`
        );

        await sendLockEmail(
          `Rate Lock Voided — Time Overrun: ${clientName}`,
          `<p><strong>Rate lock voided due to recurring time overruns.</strong></p>
           <p>Client: ${clientName} (ID: ${clientId})</p>
           <p>Locked rate: $${lock.locked_rate}/visit</p>
           <p>${overrunJobs.length} of the last 3 cleanings exceeded the estimated time by more than ${threshold}%.</p>
           <p>Please re-quote this client at their next visit.</p>`
        );

        console.log(`[RATE_LOCK] Voided — time_overrun — client_id=${clientId}`);
      }
    }
  } catch (err) {
    console.error("[RATE_LOCK] checkRateLockVoidConditions error:", err);
  }
}

export async function runRateLockNightlyChecks(): Promise<void> {
  try {
    const today = new Date().toISOString().split("T")[0];

    const activeLocks = await db.execute(
      dsql`
        SELECT rl.id, rl.client_id, rl.company_id, rl.locked_rate, rl.cadence,
               rl.lock_expires_at, rl.renewal_alert_30_sent,
               c.first_name, c.last_name
        FROM rate_locks rl
        JOIN clients c ON c.id = rl.client_id
        WHERE rl.active = true
      `
    );

    for (const lock of activeLocks.rows as any[]) {
      const settings = await getOfferSettings(lock.company_id);
      const serviceGapDays = parseInt(settings.service_gap_days ?? 60);
      const renewalAlertDays = parseInt(settings.renewal_alert_days ?? 30);
      const clientName = `${lock.first_name} ${lock.last_name}`;

      // Condition 3 — Natural expiry
      if (lock.lock_expires_at < today) {
        await db.execute(
          dsql`UPDATE rate_locks SET active = false, void_reason = 'expired', voided_at = NOW() WHERE id = ${lock.id}`
        );
        console.log(`[RATE_LOCK] Expired — client_id=${lock.client_id}`);
        continue;
      }

      // Condition 2 — Service gap
      const lastJob = await db.execute(
        dsql`SELECT scheduled_date FROM jobs WHERE client_id = ${lock.client_id} AND status = 'complete' ORDER BY scheduled_date DESC LIMIT 1`
      );
      if (lastJob.rows.length > 0) {
        const lastDate = new Date((lastJob.rows[0] as any).scheduled_date);
        const daysSince = Math.floor((Date.now() - lastDate.getTime()) / 86400000);
        if (daysSince >= serviceGapDays) {
          await db.execute(
            dsql`UPDATE rate_locks SET active = false, void_reason = 'service_gap', voided_at = NOW() WHERE id = ${lock.id}`
          );
          await sendLockEmail(
            `Rate Lock Voided — Service Gap: ${clientName}`,
            `<p><strong>Rate lock voided due to ${serviceGapDays}+ day service gap.</strong></p>
             <p>Client: ${clientName} (ID: ${lock.client_id})</p>
             <p>Locked rate: $${lock.locked_rate}/visit</p>
             <p>Last service: ${lastDate.toLocaleDateString()} (${daysSince} days ago)</p>`
          );
          console.log(`[RATE_LOCK] Voided — service_gap — client_id=${lock.client_id}`);
          continue;
        }
      }

      // Condition 4 — Renewal alert (30 days before expiry)
      const expiryDate = new Date(lock.lock_expires_at);
      const daysUntilExpiry = Math.ceil((expiryDate.getTime() - Date.now()) / 86400000);
      if (daysUntilExpiry <= renewalAlertDays && !lock.renewal_alert_30_sent) {
        await sendLockEmail(
          `Rate Lock Expiring Soon: ${clientName}`,
          `<p><strong>A client's rate lock is expiring in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? "s" : ""}.</strong></p>
           <p>Client: ${clientName} (ID: ${lock.client_id})</p>
           <p>Locked rate: $${lock.locked_rate}/visit</p>
           <p>Cadence: ${lock.cadence}</p>
           <p>Expiry date: ${expiryDate.toLocaleDateString()}</p>
           <p>Consider reaching out to offer a renewal before expiry.</p>`
        );
        await db.execute(
          dsql`UPDATE rate_locks SET renewal_alert_30_sent = true WHERE id = ${lock.id}`
        );
        console.log(`[RATE_LOCK] Renewal alert sent — client_id=${lock.client_id}`);
      }
    }
  } catch (err) {
    console.error("[RATE_LOCK] runRateLockNightlyChecks error:", err);
  }
}
