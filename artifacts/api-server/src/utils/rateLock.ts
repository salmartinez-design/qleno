import { db } from "@workspace/db";
import { sql as dsql } from "drizzle-orm";

interface RateLockVoidResult {
  voided: boolean;
  reason?: string;
  clientName?: string;
}

export async function checkRateLockVoidConditions(
  clientId: number,
  companyId: number
): Promise<RateLockVoidResult[]> {
  const results: RateLockVoidResult[] = [];

  try {
    // Condition 1 — Time overrun pattern (2 of last 3 recurring jobs exceeded est by >20%)
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
      const estimated = parseFloat(j.estimated_hours) * 60;
      return j.actual_duration > estimated * 1.20;
    });

    if (overrunJobs.length >= 2) {
      const activeLock = await db.execute(
        dsql`SELECT id, locked_rate FROM rate_locks WHERE client_id = ${clientId} AND active = true LIMIT 1`
      );
      if (activeLock.rows.length > 0) {
        const lockId = (activeLock.rows[0] as any).id;
        const clientRow = await db.execute(
          dsql`SELECT first_name, last_name FROM clients WHERE id = ${clientId} LIMIT 1`
        );
        const clientName = clientRow.rows.length > 0
          ? `${(clientRow.rows[0] as any).first_name} ${(clientRow.rows[0] as any).last_name}`
          : `Client #${clientId}`;

        await db.execute(
          dsql`UPDATE rate_locks SET active = false, void_reason = 'time_overrun', voided_at = NOW() WHERE id = ${lockId}`
        );

        try {
          const { Resend } = await import("resend");
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: "Qleno <noreply@phes.io>",
            to: "info@phes.io",
            subject: `Rate Lock Voided — Time Overrun: ${clientName}`,
            html: `
              <p><strong>Rate lock voided due to recurring time overruns.</strong></p>
              <p>Client: ${clientName} (ID: ${clientId})</p>
              <p>Locked rate: $${(activeLock.rows[0] as any).locked_rate}/visit</p>
              <p>${overrunJobs.length} of the last 3 cleanings exceeded estimated time by more than 20%.</p>
              <p>Please re-quote this client at their next visit.</p>
            `,
          });
        } catch (emailErr) {
          console.error("[RATE_LOCK] Email send failed:", emailErr);
        }

        results.push({ voided: true, reason: "time_overrun", clientName });
      }
    }
  } catch (err) {
    console.error("[RATE_LOCK] checkRateLockVoidConditions error:", err);
  }

  return results;
}

export async function runNightlyRateLockChecks(): Promise<void> {
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    const today = new Date().toISOString().split("T")[0];

    // Condition 2 — Service gap (60+ days without service)
    const activeLocks = await db.execute(
      dsql`
        SELECT rl.id, rl.client_id, rl.locked_rate, rl.cadence,
               c.first_name, c.last_name
        FROM rate_locks rl
        JOIN clients c ON c.id = rl.client_id
        WHERE rl.active = true AND rl.lock_expires_at > ${today}::date
      `
    );

    for (const lock of activeLocks.rows as any[]) {
      const lastJob = await db.execute(
        dsql`
          SELECT scheduled_date FROM jobs
          WHERE client_id = ${lock.client_id} AND status = 'complete'
          ORDER BY scheduled_date DESC LIMIT 1
        `
      );
      if (lastJob.rows.length > 0) {
        const lastDate = new Date((lastJob.rows[0] as any).scheduled_date);
        const daysSince = Math.floor((Date.now() - lastDate.getTime()) / 86400000);
        if (daysSince >= 60) {
          await db.execute(
            dsql`UPDATE rate_locks SET active = false, void_reason = 'service_gap', voided_at = NOW() WHERE id = ${lock.id}`
          );
          const clientName = `${lock.first_name} ${lock.last_name}`;
          try {
            await resend.emails.send({
              from: "Qleno <noreply@phes.io>",
              to: "info@phes.io",
              subject: `Rate Lock Voided — Service Gap: ${clientName}`,
              html: `
                <p><strong>Rate lock voided due to 60+ day service gap.</strong></p>
                <p>Client: ${clientName} (ID: ${lock.client_id})</p>
                <p>Locked rate: $${lock.locked_rate}/visit</p>
                <p>Last service: ${lastDate.toLocaleDateString()} (${daysSince} days ago)</p>
              `,
            });
          } catch { /* silent */ }
        }
      }
    }

    // Condition 3 — Natural expiry
    await db.execute(
      dsql`UPDATE rate_locks SET active = false, void_reason = 'expired', voided_at = NOW() WHERE active = true AND lock_expires_at < ${today}::date`
    );
  } catch (err) {
    console.error("[RATE_LOCK] runNightlyRateLockChecks error:", err);
  }
}
