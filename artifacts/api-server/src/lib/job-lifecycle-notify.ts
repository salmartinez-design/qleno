// [comms-cadence-mirror] Customer-facing lifecycle notifications for a job's
// START and COMPLETION, fired so Qleno mirrors MaidCentral's service cadence
// (email + text only — never a phone call).
//
// WHY a shared module: the "started" signal arrives from more than one clock
// path (field tech-clock clock-in, per-house timeclock punch) and "completed"
// arrives from THREE paths (office PATCH /api/jobs/:id, tech-clock clock_out,
// timeclock last-tech clock-out). Centralising here keeps one copy of the merge
// logic and — critically — one IDEMPOTENCY latch so a customer never gets two
// "started"/"complete" messages when several paths fire for the same job.
//
// IDEMPOTENCY: each function CLAIMS the send with a single guarded UPDATE that
// flips the per-job latch (job_started_sent / job_completed_sent) only if it was
// still false, returning the row only to the caller that won the race. Everyone
// else no-ops. completed_at is stamped in the same atomic UPDATE (server NOW(),
// timestamptz) so the review-request cron has a reliable completion key even if
// comms are gated off at completion time.
//
// GATING is delegated entirely to sendNotification(), which already enforces the
// global COMMS_ENABLED kill switch AND the per-tenant companies.comms_enabled
// gate AND resolves the per-tenant Twilio sender. That is what lets Oak Lawn
// (co1) go live independently of Schaumburg (co4): flip co1.comms_enabled and
// these fire only for co1's jobs. Nothing here bypasses a gate.
//
// Fully non-fatal: any error is swallowed so a notification hiccup can never
// break a clock punch or a job-completion write.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sendNotification, labelServiceType } from "../services/notificationService.js";

type JobClientRow = {
  scheduled_date: string | null;
  service_type: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  first_name: string | null;
  email: string | null;
  phone: string | null;
  client_address: string | null;
  client_city: string | null;
  client_state: string | null;
};

async function loadJobClient(companyId: number, jobId: number): Promise<JobClientRow | null> {
  const r = await db.execute(sql`
    SELECT j.scheduled_date, j.service_type,
           j.address_street, j.address_city, j.address_state, j.address_zip,
           c.first_name, c.email, c.phone,
           c.address AS client_address, c.city AS client_city, c.state AS client_state
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
     WHERE j.id = ${jobId} AND j.company_id = ${companyId}
     LIMIT 1`);
  return ((r as any).rows?.[0] as JobClientRow) ?? null;
}

// Canonical address — prefer the per-job address (the override the dispatch/MC
// import populates), fall back to the client record. zip is included when shown,
// per the address-display invariant.
function buildAddress(row: JobClientRow): string {
  const stateZip = [row.address_state, row.address_zip].filter(Boolean).join(" ");
  const fromJob = [row.address_street, row.address_city, stateZip].filter(Boolean).join(", ");
  if (fromJob) return fromJob;
  const fromClient = [row.client_address, row.client_city, row.client_state].filter(Boolean).join(", ");
  return fromClient || "On file";
}

function buildMergeVars(row: JobClientRow): Record<string, string> {
  return {
    first_name:       row.first_name || "",
    appointment_date: row.scheduled_date ? String(row.scheduled_date).slice(0, 10) : "",
    scope:            labelServiceType(row.service_type),
    service_address:  buildAddress(row),
  };
}

/**
 * Fire the "your cleaning has started" email + SMS exactly once for this job.
 * Call on the clock-in / start-job transition. No-op if already sent or if the
 * job has no client (office events). Gating handled by sendNotification.
 */
export async function notifyJobStarted(companyId: number, jobId: number): Promise<void> {
  try {
    const claimed = await db.execute(sql`
      UPDATE jobs
         SET job_started_sent = true
       WHERE id = ${jobId}
         AND company_id = ${companyId}
         AND COALESCE(job_started_sent, false) = false
         AND client_id IS NOT NULL
       RETURNING id`);
    if (!(claimed as any).rows?.[0]) return; // lost the race / already sent / no client

    const row = await loadJobClient(companyId, jobId);
    if (!row) return;
    const mv = buildMergeVars(row);
    await sendNotification("job_started", "email", companyId, row.email, null, mv).catch(() => {});
    await sendNotification("job_started", "sms",   companyId, null, row.phone, mv).catch(() => {});
  } catch (err) {
    console.error("[job-lifecycle] notifyJobStarted non-fatal:", err);
  }
}

/**
 * Fire the "your cleaning is complete" email + SMS exactly once for this job AND
 * stamp completed_at (the review-request cron's key). Call alongside
 * ensureInvoiceForCompletedJob on every completion path. No-op if already sent
 * or if the job has no client. Gating handled by sendNotification.
 */
export async function notifyJobCompleted(companyId: number, jobId: number): Promise<void> {
  try {
    // Stamp completion time + claim the send in one atomic write. completed_at is
    // set regardless of comms gating so the review cron works even if comms were
    // off at completion and enabled later (the latch still prevents a re-blast).
    const claimed = await db.execute(sql`
      UPDATE jobs
         SET job_completed_sent = true,
             completed_at = COALESCE(completed_at, NOW())
       WHERE id = ${jobId}
         AND company_id = ${companyId}
         AND COALESCE(job_completed_sent, false) = false
       RETURNING client_id`);
    const winner = (claimed as any).rows?.[0];
    if (!winner) return;          // lost the race / already sent
    if (!winner.client_id) return; // office event without a customer

    const row = await loadJobClient(companyId, jobId);
    if (!row) return;
    const mv = buildMergeVars(row);
    await sendNotification("job_completed", "email", companyId, row.email, null, mv).catch(() => {});
    await sendNotification("job_completed", "sms",   companyId, null, row.phone, mv).catch(() => {});
  } catch (err) {
    console.error("[job-lifecycle] notifyJobCompleted non-fatal:", err);
  }
}
