// [ghost-completion-revert 2026-07-28] A "ghost completion" is a job that shows
// status='complete' on the dispatch board but has ZERO clock evidence, because
// the punch that completed it (via field/office clock-out) was later deleted.
// Deleting a punch never reverted the job status, so a "Complete but 0 punched"
// phantom was left behind (the Furness Rockwell / Anissa Bello bug).
//
// The predicate is deliberately TIGHT so it ONLY catches clock-path completions
// whose punches are gone — never a legitimately-kept completion:
//
//   status = 'complete'
//   completed_by_user_id IS NOT NULL   → only the office "Mark Complete" and the
//                                        field/office CLOCK-OUT paths stamp this.
//                                        Bulk mark_complete, recurring back-fill,
//                                        and charged cancels DO NOT, so they can
//                                        never match.
//   locked_at IS NULL                  → office "Mark Complete" and charged
//                                        cancel/lockout both stamp locked_at;
//                                        the clock-out paths do NOT. This is what
//                                        isolates clock-out completions from the
//                                        office one-tap complete (which stamps
//                                        estimated clocks + locks) and from
//                                        charged cancels.
//   charge_succeeded_at IS NULL        → the job was never successfully charged.
//   no invoice in (sent|paid|overdue)  → not issued into AR / not settled. A
//                                        DRAFT invoice (what completion auto-
//                                        creates) does NOT protect the job.
//   zero timeclock rows                → no clock evidence of ANY kind remains
//                                        (no real 'punched' rows and no synthetic
//                                        'estimated' rows). Guarantees "0 punched"
//                                        while also refusing to fire when an
//                                        office completion still has its estimated
//                                        clocks.
//
// Net effect: only a field/office clock-out completion whose every punch has been
// deleted matches. Legitimate clock completions keep their punches; office
// completions keep locked_at + estimated clocks; charged cancels keep locked_at;
// bulk / back-fill never set completed_by_user_id — all excluded.
//
// On a match the job is reverted to 'scheduled' (there is never a live/open punch
// because there are zero timeclock rows, so 'in_progress' is unreachable here),
// completed_by_user_id / actual_end_time are cleared (locked_at is already NULL),
// and a status audit row is written so the revert shows in the client Activity
// feed. Assignment is untouched, so the assignment-mirror invariant is unaffected.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logJobStatusChange } from "./audit.js";

// Shared WHERE fragment. Assumes the jobs table is aliased `j`.
const GHOST_PREDICATE = sql`
  j.status = 'complete'
  AND j.completed_by_user_id IS NOT NULL
  AND j.locked_at IS NULL
  AND j.charge_succeeded_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM timeclock tc WHERE tc.job_id = j.id)
  AND NOT EXISTS (
    SELECT 1 FROM invoices inv
    WHERE inv.job_id = j.id AND inv.status IN ('sent', 'paid', 'overdue')
  )
`;

// [auto-issue killed the revert 2026-08-12] Maribel, for at least the third
// time: "Yesterday Lupe clocked in by mistake, I deleted the clock and it's
// still showing the check mark. We have reported this one a few times already."
//
// She is right, and the reason is a collision between two features that were
// each correct on their own day.
//
// The predicate above refuses to revert a job that carries an invoice in
// ('sent','paid','overdue') — written 2026-07-28, when completion produced a
// DRAFT and the comment could honestly say "a DRAFT invoice does NOT protect
// the job". But since 2026-07-08, with companies.auto_issue_invoices ON,
// completion ISSUES the invoice: status 'sent', sent_at NULL, no email sent,
// nobody billed (see lib/ensure-invoice.ts). Every clock-out completion now
// mints exactly the row the predicate treats as untouchable — so the revert
// has been dead on arrival for any tenant with auto-issue on, every single
// time, which is exactly why it keeps getting re-reported.
//
// 'sent' is doing two different jobs in this schema: "issued into AR" and
// "actually emailed to the customer". Only the second is a reason to refuse.
// So this variant asks whether the invoice has genuinely LEFT THE BUILDING:
//   sent_at IS NOT NULL  → a human emailed it
//   paid_at IS NOT NULL  → money arrived
//   status paid/overdue  → it is real AR
// An auto-issued, never-emailed, unpaid completion invoice is none of those —
// it is an artifact of the mistaken completion, and it gets voided with it
// (below) rather than left behind pointing at a job that is no longer done.
//
// Used by the FORWARD path only (delete a punch → revert). The startup heal
// deliberately keeps the original tight predicate — see healGhostCompletions.
const GHOST_PREDICATE_FORWARD = sql`
  j.status = 'complete'
  AND j.completed_by_user_id IS NOT NULL
  AND j.locked_at IS NULL
  AND j.charge_succeeded_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM timeclock tc WHERE tc.job_id = j.id)
  AND NOT EXISTS (
    SELECT 1 FROM invoices inv
    WHERE inv.job_id = j.id
      AND (
        inv.status IN ('paid', 'overdue')
        OR inv.sent_at IS NOT NULL
        OR inv.paid_at IS NOT NULL
      )
  )
`;

// Called by the two clock-deletion paths (DELETE /api/timeclock/:id and
// DELETE /api/jobs/:id/clock-entries) AFTER the delete. If the job is now a ghost
// completion by the tight predicate above, revert it and audit the auto-revert
// with the deleting user as the actor. Returns true when a revert happened.
export async function revertJobIfGhostCompletion(opts: {
  companyId: number | null;
  jobId: number;
  actorUserId: number | null;
}): Promise<boolean> {
  const { companyId, jobId, actorUserId } = opts;
  if (companyId == null) return false;
  try {
    // Re-check the predicate inside the UPDATE so it's atomic w.r.t. concurrent
    // punch inserts (a new punch between check and write means it's no longer a
    // ghost — the guarded WHERE makes it a no-op).
    const upd = await db.execute(sql`
      UPDATE jobs AS j
      SET status = 'scheduled',
          completed_by_user_id = NULL,
          actual_end_time = NULL
      WHERE j.id = ${jobId} AND j.company_id = ${companyId} AND ${GHOST_PREDICATE_FORWARD}
      RETURNING j.id
    `);
    if (!upd.rows[0]) return false;

    // Void the completion's own invoice. The predicate above already proved it
    // was never emailed and never paid, so this is an artifact of the mistaken
    // completion — and leaving it issued would put a bogus invoice in the
    // client's AR pointing at a job that is no longer complete. Voided, not
    // deleted: the number stays on the record with its history.
    let voidedInvoices = 0;
    try {
      const voided = await db.execute(sql`
        UPDATE invoices
           SET status = 'void'
         WHERE job_id = ${jobId} AND company_id = ${companyId}
           AND status IN ('draft', 'sent')
           AND sent_at IS NULL AND paid_at IS NULL
        RETURNING id`);
      voidedInvoices = voided.rows.length;
    } catch (e) {
      console.error("[ghost-revert] invoice void non-fatal:", (e as any)?.message ?? e);
    }

    await logJobStatusChange({
      companyId,
      jobId,
      actorUserId,
      priorStatus: "complete",
      newStatus: "scheduled",
      source: "auto-revert",
      note: voidedInvoices > 0
        ? `Auto-reverted out of Complete — last clock punch deleted, job had no clock evidence. ${voidedInvoices} unsent invoice${voidedInvoices === 1 ? "" : "s"} voided.`
        : "Auto-reverted out of Complete — last clock punch deleted, job had no clock evidence",
    });
    return true;
  } catch (err) {
    console.error("[ghost-revert] non-fatal:", (err as any)?.message ?? err);
    return false;
  }
}

// One-time, idempotent, bounded, logged heal for ghosts that already exist (the
// forward revert above only fires on FUTURE deletes). Runs at startup after the
// port is bound (runPostListenDataTasks). Idempotent: once a job is reverted it
// no longer matches the predicate, so re-runs are no-ops. Bounded by LIMIT so a
// pathological match set can never mass-revert unattended. Blanket (not
// windowed) is safe because the predicate is tight enough that only clock-out
// completions with deleted punches can match.
export async function healGhostCompletions(): Promise<{ healed: number; jobIds: number[] }> {
  const jobIds: number[] = [];
  try {
    const rows = await db.execute(sql`
      SELECT j.id, j.company_id
      FROM jobs AS j
      WHERE ${GHOST_PREDICATE}
      ORDER BY j.id
      LIMIT 500
    `);
    for (const r of rows.rows as any[]) {
      const jobId = Number(r.id);
      const companyId = Number(r.company_id);
      const upd = await db.execute(sql`
        UPDATE jobs AS j
        SET status = 'scheduled', completed_by_user_id = NULL, actual_end_time = NULL
        WHERE j.id = ${jobId} AND j.company_id = ${companyId} AND ${GHOST_PREDICATE}
        RETURNING j.id
      `);
      if (!upd.rows[0]) continue;
      await logJobStatusChange({
        companyId,
        jobId,
        actorUserId: null,
        actorName: "Qleno",
        priorStatus: "complete",
        newStatus: "scheduled",
        source: "auto-revert (maintenance)",
        note: "Auto-reverted out of Complete — completed by clock-out but every clock punch was deleted (ghost cleanup)",
      });
      jobIds.push(jobId);
    }
  } catch (err) {
    console.error("[ghost-heal] non-fatal:", (err as any)?.message ?? err);
  }
  return { healed: jobIds.length, jobIds };
}
