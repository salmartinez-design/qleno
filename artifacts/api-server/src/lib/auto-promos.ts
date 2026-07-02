// [auto-promos 2026-06-21] Engine for tenant-scoped, automatically-applied
// promotional discounts. Two offers ship initially:
//   second_recurring — 15% off the SECOND visit of a customer's recurring plan.
//   deep_clean       — 15% off ANY deep clean, year-round.
//
// Design (single source of truth = job_discounts):
//   * The realized discount ALWAYS lands as a job_discounts row (code prefixed
//     'AUTO_'), so the existing invoice builder itemizes it automatically and
//     every paid dollar is auditable. No new "discount" surface is invented.
//   * `ensureAutoPromosForJob` is the ONE chokepoint — called from
//     buildJobLineItems, so EVERY invoice surface (completion, draft re-sync,
//     office recalc) reflects the promo with no per-call-site wiring. Idempotent:
//     it deletes any prior AUTO_ rows for the job and re-stamps the current one,
//     so a changed rate / re-edit can never duplicate or go stale.
//   * `computeCheckoutPromo` lets runCalculate surface the deep-clean promo at
//     online-booking time so the advertised price is honored at checkout too.
//
// Pure helpers (promoAmount / selectAutoPromo) carry the math + the rule and are
// unit-tested without a DB.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  SECOND_RECURRING,
  DEEP_CLEAN,
  defaultPromoLabel,
  promoCode,
  promoAmount,
  selectAutoPromo,
  type ActivePromo,
} from "./auto-promos-core.js";

// Re-export the pure surface so existing importers of this module are unchanged.
export {
  SECOND_RECURRING,
  DEEP_CLEAN,
  defaultPromoLabel,
  promoCode,
  promoAmount,
  selectAutoPromo,
};
export type { ActivePromo };

// ── DB-backed helpers ────────────────────────────────────────────────────────
//
// Each DB helper takes an optional `exec` executor (the global pool by default).
// Pass a Drizzle transaction to run the whole flow atomically — used by the
// transactional verification harness so the real code can be exercised against
// production data and then rolled back, mutating nothing. Mirrors the recurring
// engine's `txOrDb` convention.

// Load a tenant's active auto-promos. Returns [] when the table doesn't exist
// yet (fresh deploy before the boot migration) or the tenant has none — callers
// then no-op, so this can never break a job/invoice flow.
export async function loadActivePromos(companyId: number, exec: any = db): Promise<ActivePromo[]> {
  try {
    const rows = (await exec.execute(sql`
      SELECT kind, discount_pct, label
        FROM auto_promos
       WHERE company_id = ${companyId} AND is_active = true
    `)).rows as any[];
    return rows.map((r) => {
      const pct = parseFloat(String(r.discount_pct));
      const kind = String(r.kind);
      return { kind, pct, label: r.label || defaultPromoLabel(kind, pct) };
    });
  } catch {
    return [];
  }
}

// 1-based ordinal of a job within its recurring schedule, ordered by the cadence
// slot (occurrence_date, falling back to scheduled_date for legacy rows). The
// 2nd visit is ordinal 2. Counts every prior occurrence row for the schedule
// (regardless of status) so a cancelled-but-present first visit still anchors
// the count. Returns null when the job isn't part of a recurring schedule.
export async function getRecurringOrdinal(companyId: number, jobId: number, exec: any = db): Promise<number | null> {
  const [job] = (await exec.execute(sql`
    SELECT recurring_schedule_id, COALESCE(occurrence_date, scheduled_date)::text AS occ
      FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
  `)).rows as any[];
  if (!job || job.recurring_schedule_id == null || !job.occ) return null;
  const [cnt] = (await exec.execute(sql`
    SELECT count(*)::int AS n
      FROM jobs
     WHERE company_id = ${companyId}
       AND recurring_schedule_id = ${job.recurring_schedule_id}
       AND COALESCE(occurrence_date, scheduled_date) < ${job.occ}::date
  `)).rows as any[];
  return Number(cnt?.n ?? 0) + 1;
}

// THE chokepoint. Ensures a job carries exactly the auto-promo it's entitled to
// (or none) as a job_discounts row, so the invoice builder itemizes it. Returns
// the stamped promo (with computed amount) or null. Idempotent + self-healing:
// always clears prior AUTO_ rows first, so re-running on an edited job re-derives
// the correct discount and never duplicates. Manual (non-AUTO_) discounts are
// never touched.
export async function ensureAutoPromosForJob(
  companyId: number,
  jobId: number,
  exec: any = db,
): Promise<{ kind: string; code: string; pct: number; amount: number; base: number } | null> {
  let job: any;
  try {
    [job] = (await exec.execute(sql`
      SELECT service_type, base_fee, billed_amount, recurring_schedule_id
        FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `)).rows as any[];
  } catch {
    return null;
  }
  if (!job) return null;

  const active = await loadActivePromos(companyId, exec);

  // Clear any prior auto-promo rows so a re-stamp is always clean.
  try {
    await exec.execute(sql`
      DELETE FROM job_discounts
       WHERE company_id = ${companyId} AND job_id = ${jobId} AND code LIKE 'AUTO\\_%'
    `);
  } catch {
    // job_discounts must exist in any real deploy; if the delete fails we bail
    // rather than risk a partial state.
    return null;
  }

  if (!active.length) return null;

  // Is this the 2nd visit of a recurring plan?
  let isSecond = false;
  if (job.recurring_schedule_id != null && active.some((p) => p.kind === SECOND_RECURRING)) {
    const ordinal = await getRecurringOrdinal(companyId, jobId, exec);
    isSecond = ordinal === 2;
  }

  const chosen = selectAutoPromo({
    serviceType: job.service_type ?? null,
    isSecondRecurringVisit: isSecond,
    active,
  });
  if (!chosen) return null;

  // Base = the job's main service-line amount as it appears on the invoice
  // (billed_amount for metered/hourly jobs, else base_fee). This is "the
  // per-visit / deep-clean price" — add-on lines (parking, etc.) are NOT
  // discounted.
  const base = job.billed_amount != null
    ? parseFloat(String(job.billed_amount))
    : parseFloat(String(job.base_fee ?? "0"));
  const amount = promoAmount(chosen.pct, base);
  if (!(amount > 0)) return null;

  const code = promoCode(chosen.kind);
  await exec.execute(sql`
    INSERT INTO job_discounts (company_id, job_id, code, type, value, amount, reason)
    VALUES (${companyId}, ${jobId}, ${code}, 'percent', ${chosen.pct}, ${amount}, ${chosen.label})
  `);
  return { kind: chosen.kind, code, pct: chosen.pct, amount, base };
}

// Checkout-time promo for the online booking widget / quote calculator. Only the
// deep-clean promo is determinable from a single quote (the 2nd-recurring promo
// is contextual to a schedule occurrence and lands at invoice build). Computes
// the discount against the cleaning base price. Returns null when no deep-clean
// promo is active for the tenant.
export async function computeCheckoutPromo(opts: {
  companyId: number;
  serviceType: string | null;
  basePrice: number;
}): Promise<{ kind: string; pct: number; amount: number; label: string } | null> {
  if (opts.serviceType !== "deep_clean") return null;
  const active = await loadActivePromos(opts.companyId);
  const dc = active.find((p) => p.kind === DEEP_CLEAN && p.pct > 0);
  if (!dc) return null;
  const amount = promoAmount(dc.pct, opts.basePrice);
  if (!(amount > 0)) return null;
  return { kind: dc.kind, pct: dc.pct, amount, label: dc.label };
}

// Idempotent boot migration: create the auto_promos table and seed the two
// initial offers for the requested companies (Phes Oak Lawn = co1, Schaumburg =
// co4) at 15%. Re-running is a no-op (ON CONFLICT-free guarded inserts). Safe to
// call on every cold start.
export async function runAutoPromosMigration(seedCompanyIds: number[] = [1, 4]): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS auto_promos (
        id serial PRIMARY KEY,
        company_id integer NOT NULL REFERENCES companies(id),
        kind text NOT NULL,
        discount_pct numeric(5,2) NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        label text,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    // One active row per (company, kind). Partial unique index keeps the seed
    // idempotent and prevents accidental duplicate active promos of a kind.
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS auto_promos_company_kind_active_uidx
        ON auto_promos (company_id, kind) WHERE is_active = true
    `);
    for (const cid of seedCompanyIds) {
      // Only seed if the company exists and has no active row for the kind.
      // [deep-clean-promo-removal 2026-07-02] DEEP_CLEAN is intentionally NOT
      // seeded anymore — the blanket "15% off any deep clean, year-round" offer
      // was silently discounting every deep-clean invoice. Only the advertised
      // second-visit promo is seeded. (Removing it from the seed is also what
      // makes the deactivation below stick — otherwise the next boot would
      // re-insert a fresh active deep_clean row.)
      for (const kind of [SECOND_RECURRING]) {
        await db.execute(sql`
          INSERT INTO auto_promos (company_id, kind, discount_pct, label)
          SELECT ${cid}, ${kind}, 15.00, ${defaultPromoLabel(kind, 15)}
           WHERE EXISTS (SELECT 1 FROM companies WHERE id = ${cid})
             AND NOT EXISTS (
               SELECT 1 FROM auto_promos
                WHERE company_id = ${cid} AND kind = ${kind} AND is_active = true
             )
        `);
      }
    }

    // [deep-clean-promo-removal 2026-07-02] Deactivate the existing blanket
    // deep-clean auto-promo for Oak Lawn (co1) per owner decision — deep cleans
    // no longer auto-discount; the office applies discounts manually per job.
    // Idempotent (0 rows once cleared). Schaumburg (co4) is a separate company
    // and is intentionally left untouched here. Existing invoices already
    // stamped with an AUTO_DEEP_CLEAN discount correct themselves on the next
    // "Recalc from job" / edit (ensureAutoPromosForJob re-derives to none).
    await db.execute(sql`
      UPDATE auto_promos SET is_active = false
       WHERE company_id = 1 AND kind = ${DEEP_CLEAN} AND is_active = true
    `);

    console.log(`[auto-promos] migration ok — seeded companies ${seedCompanyIds.join(", ")}`);
  } catch (err) {
    console.error("[auto-promos] migration error (non-fatal):", err);
  }
}
