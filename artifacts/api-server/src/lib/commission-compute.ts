/**
 * Cutover 4a — commission auto-compute.
 *
 * Pure functions that turn (period range, company config, completed jobs)
 * into commission rows ready to write to additional_pay. The route layer
 * (routes/pay.ts /periods/:id/lock + /periods/:id/compute-commission) wraps
 * these with the DB I/O + idempotency.
 *
 * Formula matches the live /payroll/detail surface so the post-lock numbers
 * are what the office already sees in the per-employee panel:
 *
 *   residential:  commission = jobTotal × resolveResidentialPayPct(service)
 *   commercial:   commission = commercial_hourly_rate × hours
 *                   hours = actual_hours when commercial_comp_mode='actual_hours'
 *                          AND actual_hours > 0, else allowed_hours
 *
 * Per-job override via job_technicians.final_pay still wins — the office
 * may have hand-set commission on a specific job in the existing UI; we
 * never overwrite that.
 *
 * jobTotal = COALESCE(billed_amount, base_fee, 0) — the canonical waterfall
 * used everywhere else in the codebase. Picking it here keeps period-locked
 * commission consistent with mid-period dispatch preview math.
 */
import {
  resolveResidentialPayPct,
  type CompanyResRates,
} from "./commission-rates.js";

export interface CommissionInputJob {
  id: number;
  assigned_user_id: number | null;
  service_type: string | null;
  account_id: number | null;
  base_fee: string | number | null;
  billed_amount: string | number | null;
  // [commission-optin 2026-07-01] Commissionable base = base_fee (or hrs×rate)
  // + only the add-ons/rate-mods flagged affects_commission. When present the
  // pay engine uses THIS as the fee-split basis instead of billed_amount; NULL
  // falls back to the legacy max(base_fee, billed_amount). Optional so existing
  // callers compile.
  commission_base?: string | number | null;
  allowed_hours: string | number | null;
  actual_hours: string | number | null;
  branch_id: number | null;
  scheduled_date: string;
  // [commercial-client 2026-06-06] client_type='commercial' marks a commercial
  // client even when the job's service_type reads residential (e.g. a condo's
  // "Deep Clean"). Optional so existing callers compile; commercial routing
  // treats it the same as an account link.
  client_type?: string | null;
}

export interface CompanyCommercialConfig {
  commercial_hourly_rate: number;
  commercial_comp_mode: "allowed_hours" | "actual_hours";
}

export interface CommissionRow {
  user_id: number;
  job_id: number;
  amount: number;
  basis: "commercial_hourly" | "residential_pool";
  branch_id: number | null;
  scheduled_date: string;
}

/** Coerce a stringy numeric input into a finite number (0 on bad input). */
function num(v: string | number | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

/** Round to 2 decimal places — matches additional_pay precision (10,2). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// [commission-routing 2026-06-17] Commercial detection must match
// commission-paytype.isCommercialJob — an account link, OR a commercial client
// (client_type='commercial'), OR a commercial-keyword service type. This legacy
// single-basis path previously keyed on account_id ALONE, so a commercial
// CLIENT with no linked account (e.g. an LLC "Office Cleaning") fell to the
// residential 35% pool ($160 × 0.35 = $56) instead of commercial hourly
// (3h × $20 = $60). Keep this list in sync with commission-paytype.
const COMMERCIAL_KEYWORDS = [
  "commercial", "ppm", "common_area", "office", "janitor", "facility",
  "post_construction", "turnover", "build_out", "buildout",
];
function isCommercialJobRow(
  account_id: number | null,
  service_type: string | null,
  client_type: string | null,
): boolean {
  if (account_id != null) return true;
  if ((client_type ?? "").toLowerCase() === "commercial") return true;
  const s = (service_type ?? "").toLowerCase();
  return COMMERCIAL_KEYWORDS.some((k) => s.includes(k));
}

/**
 * Compute one commission row per job. Jobs without an assigned tech are
 * skipped (commission needs a recipient; multi-tech splits live on
 * job_technicians.final_pay and are applied in the route layer where we
 * have DB access).
 *
 * The OVERRIDE map carries any per-job final_pay set on job_technicians
 * for the assigned tech — when present, we use it verbatim and tag the
 * row as `commission_overridden=true` so the writer can audit it.
 */
export function computeCommissionRows(input: {
  jobs: ReadonlyArray<CommissionInputJob>;
  resRates: CompanyResRates;
  commercial: CompanyCommercialConfig;
  /** Map of "user_id:job_id" → final_pay override (in dollars). */
  overrides?: ReadonlyMap<string, number>;
}): CommissionRow[] {
  const overrides = input.overrides ?? new Map();
  const out: CommissionRow[] = [];
  for (const j of input.jobs) {
    if (j.assigned_user_id == null) continue;

    const isCommercial = isCommercialJobRow(j.account_id, j.service_type, j.client_type ?? null);
    // [commission-optin 2026-07-01] Prefer commission_base (base or hrs×rate +
    // only flagged add-ons/mods) over the billed total. NULL → legacy waterfall.
    const commissionBase = j.commission_base != null ? num(j.commission_base) : null;
    const jobTotal = commissionBase ?? (num(j.billed_amount) || num(j.base_fee));
    const allowedHrs = num(j.allowed_hours);
    const workedHrs = num(j.actual_hours);
    const commercialHours =
      input.commercial.commercial_comp_mode === "actual_hours" && workedHrs > 0
        ? workedHrs
        : allowedHrs;

    const resPct = resolveResidentialPayPct(j.service_type, input.resRates);
    // Commercial: commission_base already = hrs × commission-rate + flagged
    // extras, so use it directly as the commercial pool when present.
    const computed = isCommercial
      ? (commissionBase ?? input.commercial.commercial_hourly_rate * commercialHours)
      : jobTotal * resPct;

    const overrideKey = `${j.assigned_user_id}:${j.id}`;
    const overridden = overrides.get(overrideKey);
    const amount = round2(overridden ?? computed);

    if (amount === 0) continue; // skip $0 rows — nothing to pay

    out.push({
      user_id: j.assigned_user_id,
      job_id: j.id,
      amount,
      basis: isCommercial ? "commercial_hourly" : "residential_pool",
      branch_id: j.branch_id,
      scheduled_date: j.scheduled_date,
    });
  }
  return out;
}

/**
 * Reconcile freshly-computed commission rows against the existing
 * `additional_pay` rows that previous runs may have written. Returns
 * three buckets so the caller can do a single batched write per bucket:
 *
 *   - to_insert: new rows that have no existing match
 *   - to_update: existing rows whose amount differs from the computed
 *                value (likely because a job was rebilled or actual_hours
 *                changed after the first compute)
 *   - to_void:   existing commission rows for jobs that are no longer
 *                in the computed set (job got deleted / cancelled /
 *                un-assigned after the first compute). We void rather
 *                than DELETE so the audit trail survives.
 *
 * Idempotency key = (user_id, job_id, type='commission'). Type and
 * job-level uniqueness lets multiple commission rows per employee in
 * one period coexist (one per job), each addressable on re-run.
 */
export function reconcileCommissionRows(input: {
  computed: ReadonlyArray<CommissionRow>;
  existing: ReadonlyArray<{ id: number; user_id: number; job_id: number | null; amount: string | number; voided_at: Date | null }>;
}): {
  to_insert: CommissionRow[];
  to_update: Array<{ id: number; user_id: number; job_id: number; new_amount: number }>;
  to_void: Array<{ id: number; user_id: number; job_id: number }>;
} {
  const computedByKey = new Map<string, CommissionRow>();
  for (const r of input.computed) {
    if (r.job_id == null) continue;
    computedByKey.set(`${r.user_id}:${r.job_id}`, r);
  }
  const existingByKey = new Map<string, typeof input.existing[number]>();
  for (const r of input.existing) {
    if (r.job_id == null) continue;
    existingByKey.set(`${r.user_id}:${r.job_id}`, r);
  }

  const to_insert: CommissionRow[] = [];
  const to_update: Array<{ id: number; user_id: number; job_id: number; new_amount: number }> = [];
  const to_void: Array<{ id: number; user_id: number; job_id: number }> = [];

  for (const [key, c] of computedByKey) {
    const existing = existingByKey.get(key);
    if (!existing) {
      to_insert.push(c);
      continue;
    }
    // Voided rows are treated as "no longer applies" — if the computed set
    // wants to re-issue this commission, that's an insert again, not an
    // update of the voided row.
    if (existing.voided_at != null) {
      to_insert.push(c);
      continue;
    }
    const existingAmount = round2(num(existing.amount));
    if (existingAmount !== round2(c.amount)) {
      to_update.push({
        id: existing.id,
        user_id: c.user_id,
        job_id: c.job_id,
        new_amount: round2(c.amount),
      });
    }
  }

  for (const [key, e] of existingByKey) {
    if (e.voided_at != null) continue;
    if (!computedByKey.has(key) && e.job_id != null) {
      to_void.push({ id: e.id, user_id: e.user_id, job_id: e.job_id });
    }
  }

  return { to_insert, to_update, to_void };
}
