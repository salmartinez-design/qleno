import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// [payroll-settings-one-store 2026-08-17] Payroll settings read and write
// `companies`, and nothing else.
//
// What was wrong: both verbs targeted a `payroll_settings` table that does not
// exist in any environment, so every GET and every PATCH threw. The screen
// swallowed the error and reported "saved". Ten of the fourteen fields on it
// reached no calculation at all, and the four that did only survived because
// the page quietly PATCHed /api/companies/me as well — where the same
// commission number had to be divided by 100 first, because the screen worked
// in percent and the database stores a fraction. Two stores, two unit systems,
// one silent failure.
//
// The rule now: this route is a thin, typed view over the SAME columns the pay
// engines read (lib/commission-rates.ts, lib/commission-paytype.ts,
// lib/payroll-compute.ts, lib/payroll-snapshot.ts, lib/period-pay.ts,
// lib/leave-pay.ts, routes/tech.ts, routes/mileage-requests.ts). A field only
// belongs here if some engine reads it. If you add a control to the settings
// screen, add it to FIELDS below and point it at a real column — never at a
// second store, and never at a column nothing consumes. A control that does
// nothing is worse than no control, because the office will trust it.
//
// Units: the API speaks the database's language. Commission percentages cross
// the wire as FRACTIONS (0.35), exactly as stored. A value above 1 is rejected
// with a 400 rather than coerced, so the old percent/fraction mix-up can never
// silently write 35× pay again.
//
// Deliberately NOT here:
//   • mileage rate history — companies.mileage_rate is the scalar used by the
//     manual mileage-request path only. Computed drive legs price off the dated
//     `mileage_rates` table, which needs its own effective-dated editor.
//   • minimum_job_pay_hours — belongs to the compliance screen, and today no
//     pay engine reads it.
//   • re-clean / pay floor / unavailable-reclassification / quality-probation
//     rates — removed. Nothing in the codebase has ever read them.
// ─────────────────────────────────────────────────────────────────────────────

type FieldKind = "fraction" | "money" | "choice";

interface Field {
  /** companies column name; also the JSON key in and out. */
  col: string;
  kind: FieldKind;
  /** money only: clamp ceiling, so a stray keystroke can't write $20,000/hr. */
  max?: number;
  /** choice only: the exact values the engines branch on. */
  choices?: readonly string[];
}

const FIELDS: readonly Field[] = [
  // Residential commission, by service type. All three are live:
  // lib/commission-rates.ts picks one of them per job from the service type,
  // so editing only the standard rate leaves deep cleans and move-in/outs on
  // their own number. That invisibility is why they are on the screen now.
  { col: "res_tech_pay_pct", kind: "fraction" },
  { col: "deep_clean_pay_pct", kind: "fraction" },
  { col: "move_in_out_pay_pct", kind: "fraction" },
  // Commercial: rate x hours. The mode chooses WHICH hours.
  { col: "commercial_hourly_rate", kind: "money", max: 500 },
  { col: "commercial_comp_mode", kind: "choice", choices: ["allowed_hours", "actual_hours"] },
  // Paid leave (PLAWA / PTO) — lib/leave-pay.ts.
  { col: "leave_pay_rate", kind: "money", max: 200 },
  // Mileage reimbursement for hand-entered mileage requests.
  { col: "mileage_rate", kind: "money", max: 10 },
  // Training and other clockable non-job events — routes/tech.ts.
  { col: "training_pay_rate", kind: "money", max: 200 },
  // Which hours an hourly tech is paid for — lib/payroll-compute.ts.
  { col: "payroll_hours_basis", kind: "choice", choices: ["actual_clocked", "allowed_hours", "greater_of"] },
] as const;

const SELECT_COLS = sql.raw(FIELDS.map((f) => f.col).join(", "));

/** Owner/admin/office may look; only an owner may change what people are paid. */
router.get("/", requireAuth, requireRole("owner", "admin", "super_admin"), async (req, res) => {
  try {
    const rows = await db.execute(
      sql`SELECT ${SELECT_COLS} FROM companies WHERE id = ${req.auth!.companyId} LIMIT 1`,
    );
    const row = (rows as any).rows?.[0] ?? null;
    if (!row) return res.status(404).json({ error: "Not Found", message: "Company not found" });
    // Numerics come back from pg as strings; hand the screen real numbers so it
    // never has to guess whether "0.35" is a fraction or a typo.
    const data: Record<string, unknown> = {};
    for (const f of FIELDS) {
      data[f.col] = f.kind === "choice" ? String(row[f.col]) : Number(row[f.col]);
    }
    return res.json({ data });
  } catch (err) {
    console.error("GET payroll-settings error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/", requireAuth, requireRole("owner", "super_admin"), async (req, res) => {
  try {
    const sets: ReturnType<typeof sql>[] = [];

    for (const f of FIELDS) {
      const raw = (req.body ?? {})[f.col];
      if (raw === undefined) continue;

      if (f.kind === "choice") {
        const v = String(raw);
        if (!f.choices!.includes(v)) {
          return res.status(400).json({
            error: "Bad Request",
            message: `${f.col} must be one of: ${f.choices!.join(", ")}`,
          });
        }
        sets.push(sql`${sql.raw(f.col)} = ${v}`);
        continue;
      }

      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: "Bad Request", message: `${f.col} must be a number of 0 or more` });
      }
      if (f.kind === "fraction") {
        // 0.35, never 35. Refusing >1 outright is the whole point: the old
        // screen sent 35 here and 0.35 to the other endpoint, and whichever
        // wrote last decided what a cleaner earned.
        if (n > 1) {
          return res.status(400).json({
            error: "Bad Request",
            message: `${f.col} is a fraction of the job total (0.35 = 35%), so it cannot be above 1`,
          });
        }
        sets.push(sql`${sql.raw(f.col)} = ${n.toFixed(4)}`);
      } else {
        if (n > f.max!) {
          return res.status(400).json({ error: "Bad Request", message: `${f.col} cannot be above ${f.max}` });
        }
        sets.push(sql`${sql.raw(f.col)} = ${n.toFixed(4)}`);
      }
    }

    if (sets.length) {
      await db.execute(
        sql`UPDATE companies SET ${sql.join(sets, sql`, `)} WHERE id = ${req.auth!.companyId}`,
      );
    }

    const rows = await db.execute(
      sql`SELECT ${SELECT_COLS} FROM companies WHERE id = ${req.auth!.companyId} LIMIT 1`,
    );
    const row = (rows as any).rows?.[0] ?? {};
    const data: Record<string, unknown> = {};
    for (const f of FIELDS) {
      data[f.col] = f.kind === "choice" ? String(row[f.col]) : Number(row[f.col]);
    }
    return res.json({ data });
  } catch (err) {
    console.error("PATCH payroll-settings error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
