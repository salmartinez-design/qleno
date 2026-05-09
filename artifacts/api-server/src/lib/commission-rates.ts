/**
 * Tiered residential commission rate resolver.
 *
 * Phes raised pricing on Deep Clean and Move In/Out to $80/hr to client.
 * Tech share on those scopes is 32% (vs 35% for standard residential).
 * Commercial routing is on `!!jobs.account_id` and lives outside this
 * module — see CLAUDE.md "Commission engine routing" invariant.
 *
 * Source of truth: `companies.res_tech_pay_pct` /
 * `companies.deep_clean_pay_pct` / `companies.move_in_out_pay_pct`. All
 * three commission surfaces (lib/commission.ts quote-builder,
 * routes/dispatch.ts Commission panel, routes/payroll.ts /detail) MUST
 * route through `resolveResidentialPayPct` so a future scope-rate change
 * stays a one-line database update, not a code edit in three files.
 */
export interface CompanyResRates {
  res_tech_pay_pct: number;
  deep_clean_pay_pct: number;
  move_in_out_pay_pct: number;
}

const DEEP_CLEAN_TYPES = new Set(["deep_clean"]);
const MOVE_IN_OUT_TYPES = new Set(["move_in", "move_out"]);

/**
 * Pick the right residential commission rate for a job's service_type.
 * Caller is responsible for routing commercial jobs (account_id != null)
 * to the commercial branch BEFORE calling this — passing a commercial
 * service_type here returns the standard residential rate as a fallback,
 * which is wrong for commercial.
 */
export function resolveResidentialPayPct(
  serviceType: string | null | undefined,
  rates: CompanyResRates,
): number {
  const t = (serviceType ?? "").toLowerCase();
  if (DEEP_CLEAN_TYPES.has(t)) return rates.deep_clean_pay_pct;
  if (MOVE_IN_OUT_TYPES.has(t)) return rates.move_in_out_pay_pct;
  return rates.res_tech_pay_pct;
}

/**
 * Parse a row from `SELECT res_tech_pay_pct, deep_clean_pay_pct,
 * move_in_out_pay_pct FROM companies` into a numeric struct with
 * sensible Phes defaults (0.35 / 0.32 / 0.32) when columns are missing
 * or null. Defensive: handles the case where the migration hasn't run
 * yet (cold-start order matters on the very first deploy).
 */
export function parseResRatesRow(row: any | null | undefined): CompanyResRates {
  const std = parseFloat(String(row?.res_tech_pay_pct ?? 0.35));
  const deep = parseFloat(String(row?.deep_clean_pay_pct ?? 0.32));
  const move = parseFloat(String(row?.move_in_out_pay_pct ?? 0.32));
  return {
    res_tech_pay_pct: Number.isFinite(std) ? std : 0.35,
    deep_clean_pay_pct: Number.isFinite(deep) ? deep : 0.32,
    move_in_out_pay_pct: Number.isFinite(move) ? move : 0.32,
  };
}
