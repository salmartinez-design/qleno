import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { companyDateStr } from "../lib/company-tz.js";
import { pickMileageRateForDate, type MileageRateRowInput } from "../lib/mileage-rate-lookup.js";
import { planReprice, type RepriceLegInput } from "../lib/mileage-reprice.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// [mileage-rate-editor 2026-08-17] The dated mileage-rate editor.
//
// `mileage_rates` has been the source of truth for every computed drive leg
// since cutover 2A, and until now it had no editor anywhere in the app — the
// only row each tenant had was the one the boot migration seeded from
// companies.mileage_rate, dated 2000-01-01. So the rate could not be corrected
// without a hand-written database change, which is how Phes Oak Lawn ended up
// on $0.725 and Phes Schaumburg on $0.700 — same state, same IRS rule, two
// different numbers, neither reachable from the UI.
//
// It matters more in 2026 than most years: the IRS opened at 72.5c/mi and then
// revised to 76c/mi effective July 1. A single editable number cannot express
// that. Dated rows can, and they are what makes a past week reproducible at the
// rate that was actually in force then rather than at today's.
//
// Append-only by intent. A correction is a NEW row, never an edit of an old
// one. end_date stays null in normal use: pickMileageRateForDate takes the
// latest effective_date on or before the leg's day, so a later row supersedes
// an earlier one without anyone having to close it by hand.
//
// The one genuinely dangerous edge is the legs already computed at the old
// rate. See lib/mileage-reprice.ts — only `computed` legs are ever touched, and
// the caller has to ask for it.
// ─────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Well above any plausible IRS figure, low enough to catch a slipped decimal. */
const MAX_RATE = 10;

type RateRow = { id: number; rate: string; effective_date: string; end_date: string | null };

async function loadRates(companyId: number): Promise<RateRow[]> {
  const r = await db.execute(sql`
    SELECT id, rate::text AS rate,
           to_char(effective_date, 'YYYY-MM-DD') AS effective_date,
           to_char(end_date, 'YYYY-MM-DD') AS end_date
    FROM mileage_rates
    WHERE company_id = ${companyId}
    ORDER BY effective_date DESC`);
  return ((r as any).rows ?? []) as RateRow[];
}

const toInputs = (rows: RateRow[]): MileageRateRowInput[] =>
  rows.map((r) => ({ rate: r.rate, effective_date: r.effective_date, end_date: r.end_date }));

/** Every leg still sitting in the review queue — the only ones re-pricing may touch. */
async function loadUnpaidLegs(companyId: number): Promise<RepriceLegInput[]> {
  const r = await db.execute(sql`
    SELECT id, to_char(leg_date, 'YYYY-MM-DD') AS leg_date,
           miles::text AS miles, rate_per_mile::text AS rate_per_mile,
           amount::text AS amount, split_group_size
    FROM mileage_legs
    WHERE company_id = ${companyId} AND status = 'computed'
    ORDER BY leg_date`);
  return ((r as any).rows ?? []) as RepriceLegInput[];
}

/**
 * Keep companies.mileage_rate in step with whatever row is in force today.
 *
 * That column is not decorative — routes/mileage-requests.ts prices mileage the
 * office enters by hand from it. If it drifts from the dated table, a
 * hand-entered mile and a measured mile get reimbursed at different rates on
 * the same day, which nobody would ever spot.
 */
async function syncCompanyScalar(companyId: number, rows: RateRow[]): Promise<number | null> {
  const today = companyDateStr(companyId);
  const current = pickMileageRateForDate(toInputs(rows), today);
  if (current == null) return null;
  await db.execute(
    sql`UPDATE companies SET mileage_rate = ${current.toFixed(4)} WHERE id = ${companyId}`,
  );
  return current;
}

/** Owner/admin/office may look. */
router.get("/", requireAuth, requireRole("owner", "admin", "super_admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const rows = await loadRates(companyId);
    const today = companyDateStr(companyId);
    const current = pickMileageRateForDate(toInputs(rows), today);

    // What is waiting in the queue, priced as it stands today. This is the
    // number that quietly goes out wrong if the rate is stale.
    const q = await db.execute(sql`
      SELECT count(*)::int AS legs,
             coalesce(round(sum(miles)::numeric, 1), 0)::float8 AS miles,
             coalesce(round(sum(amount)::numeric, 2), 0)::float8 AS amount
      FROM mileage_legs
      WHERE company_id = ${companyId} AND status = 'computed'`);
    const unpaid = ((q as any).rows ?? [])[0] ?? { legs: 0, miles: 0, amount: 0 };

    return res.json({
      data: {
        rates: rows.map((r) => ({
          id: r.id,
          rate: Number(r.rate),
          effective_date: r.effective_date,
          end_date: r.end_date,
          is_current: current != null && Number(r.rate) === current
            && r.effective_date <= today
            && !rows.some((o) => o.effective_date > r.effective_date && o.effective_date <= today),
        })),
        current_rate: current,
        today,
        unpaid,
      },
    });
  } catch (err) {
    console.error("GET mileage-rates error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * Add a dated rate. There is deliberately no PATCH — rates are append-only, and
 * a correction is a new row. `dry_run: true` returns the same plan without
 * writing anything, so the office sees exactly what re-pricing would do before
 * it happens, which is the house rule for anything that touches money.
 */
router.post("/", requireAuth, requireRole("owner", "super_admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { rate, effective_date, reprice_unpaid, dry_run } = (req.body ?? {}) as Record<string, unknown>;

    const n = Number(rate);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ error: "Bad Request", message: "Enter a rate greater than 0" });
    }
    if (n > MAX_RATE) {
      return res.status(400).json({
        error: "Bad Request",
        message: `A rate of $${n} per mile looks like a typo — the limit is $${MAX_RATE}`,
      });
    }
    const date = String(effective_date ?? "");
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ error: "Bad Request", message: "Enter a start date as YYYY-MM-DD" });
    }

    const existing = await loadRates(companyId);
    const clash = existing.find((r) => r.effective_date === date);
    if (clash) {
      return res.status(409).json({
        error: "Conflict",
        message: `There is already a rate starting ${date} ($${Number(clash.rate).toFixed(4)}/mi). Remove it first, or pick a different start date.`,
      });
    }

    // The history as it WOULD be, so the preview and the write agree exactly.
    const proposed: RateRow[] = [
      ...existing,
      { id: -1, rate: n.toFixed(4), effective_date: date, end_date: null },
    ];
    const wantsReprice = reprice_unpaid === true;
    const plan = wantsReprice
      ? planReprice(await loadUnpaidLegs(companyId), toInputs(proposed))
      : null;

    if (dry_run === true) {
      const today = companyDateStr(companyId);
      return res.json({
        data: {
          dry_run: true,
          would_add: { rate: n, effective_date: date },
          would_become_current: pickMileageRateForDate(toInputs(proposed), today),
          reprice: plan,
        },
      });
    }

    // One transaction: the rate row and the legs it re-prices land together or
    // not at all. A half-applied rate change is the worst outcome available —
    // some legs on the new number, some on the old, no way to tell which.
    let applied = 0;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO mileage_rates (company_id, rate, effective_date, end_date, created_by_user_id)
        VALUES (${companyId}, ${n.toFixed(4)}, ${date}, NULL, ${req.auth!.userId!})`);

      if (plan) {
        for (const c of plan.changes) {
          const r = await tx.execute(sql`
            UPDATE mileage_legs
            SET rate_per_mile = ${c.new_rate.toFixed(4)},
                amount = ${c.new_amount.toFixed(2)},
                updated_at = now()
            WHERE id = ${c.leg_id} AND company_id = ${companyId} AND status = 'computed'`);
          applied += (r as any).rowCount ?? 0;
        }
      }
    });

    const rows = await loadRates(companyId);
    const current = await syncCompanyScalar(companyId, rows);

    return res.json({
      data: {
        added: { rate: n, effective_date: date },
        current_rate: current,
        repriced_legs: applied,
        reprice: plan,
      },
    });
  } catch (err) {
    console.error("POST mileage-rates error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * Remove a rate row.
 *
 * Refused once anything has been PAID on or after that date. Deleting the row
 * changes which rate applies from that day forward, and a period whose pay is
 * already out has to keep reproducing at the rate it was actually paid at.
 * Before any money has moved, removing a mistyped row is harmless.
 */
router.delete("/:id", requireAuth, requireRole("owner", "super_admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid rate id" });
    }

    const rows = await loadRates(companyId);
    const target = rows.find((r) => r.id === id);
    if (!target) return res.status(404).json({ error: "Not Found", message: "Rate not found" });
    if (rows.length === 1) {
      return res.status(409).json({
        error: "Conflict",
        message: "This is the only rate on file. Add the replacement first, then remove this one.",
      });
    }

    const paid = await db.execute(sql`
      SELECT count(*)::int AS n FROM mileage_legs
      WHERE company_id = ${companyId}
        AND status IN ('reviewed', 'applied')
        AND leg_date >= ${target.effective_date}`);
    const n = ((paid as any).rows ?? [])[0]?.n ?? 0;
    if (n > 0) {
      return res.status(409).json({
        error: "Conflict",
        message: `${n} drive${n === 1 ? " has" : "s have"} already been paid on or after ${target.effective_date}. Removing this rate would change what those weeks compute to. Add a new dated rate instead.`,
      });
    }

    await db.execute(sql`DELETE FROM mileage_rates WHERE id = ${id} AND company_id = ${companyId}`);
    const after = await loadRates(companyId);
    const current = await syncCompanyScalar(companyId, after);
    return res.json({ data: { deleted: id, current_rate: current } });
  } catch (err) {
    console.error("DELETE mileage-rates error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
