// [commission-base-drift 2026-08-09] Keep the pay number moving with the price.
//
// THE BUG THIS CLOSES: a residential job carries two money columns.
//   jobs.base_fee        — what the customer is charged.
//   jobs.commission_base — the number the cleaner's fee split is paid on.
// They are supposed to be the same number on residential work. But base_fee is
// written from at least four different places and commission_base was only ever
// re-synced from ONE of them (PATCH /api/jobs/:id, the single-job modal save).
// Every other price edit moved the customer's number and left the pay number
// frozen at whatever it was before:
//   • routes/jobs.ts   — the edit-job modal's this_and_future / all cascade
//   • routes/clients.ts — the customer-profile recurring-schedule cascade
//   • routes/quotes.ts  — a re-book stamping the new agreed rate on future visits
// A price DROP then overpaid the cleaner on every future visit; a price RISE
// underpaid them. 52 live jobs had drifted this way by 2026-08-09 (~$1,440 of
// commission on a $4,113 gap), and a $215 -> $195 schedule change on one client
// alone accounted for 27 of them.
//
// WHY A DELTA AND NOT A RECOMPUTE: recomputeJobBilledAmount() derives
// commission_base = base + commissionable mods + commissionable add-ons. That is
// correct for commercial, where base is the raw service line. It is WRONG for
// residential, where base_fee is all-in — the add-ons are already inside it, so
// re-deriving would add them a second time and overpay. So residential moves
// commission_base by exactly the base-price delta: the office changed the price
// by $X, the pay base changes by $X, and every add-on/adjustment already baked
// into it survives untouched.
//
// WHEN commission_base IS NULL there is nothing to keep in step — the pay
// engines fall back to base_fee, which is already the new number. Leave it null.
//
// IF YOU ADD A NEW PATH THAT WRITES jobs.base_fee: use this. Do not inline a
// third formula.

import { sql, type SQL } from "drizzle-orm";

/**
 * A SET-clause expression for `commission_base` that moves it by the same delta
 * as `base_fee`.
 *
 * MUST be used in the SAME `UPDATE jobs` statement that writes
 * `base_fee = <newBaseFee>`, and with the same value. Postgres evaluates every
 * SET expression against the row's PRE-UPDATE values, so the delta is computed
 * against the old price even though both columns are written at once — which
 * also makes it atomic. Running it as a separate statement afterwards would
 * read the already-updated base_fee and always compute a delta of zero.
 *
 * Self-guarding, so it is safe to attach unconditionally to a bulk cascade:
 *   - null new price, null old price, or null commission_base -> unchanged
 *   - commercial job (account_id, or a commercial client) -> unchanged, because
 *     commercial commission is allowed_hours x rate, not the price
 *   - never goes negative
 */
export function commissionBaseFollowsBaseFee(newBaseFee: string | number | null): SQL {
  const nb = newBaseFee === null || newBaseFee === undefined || newBaseFee === ""
    ? null
    : String(newBaseFee);
  return sql`CASE
      WHEN ${nb}::numeric IS NULL OR base_fee IS NULL OR commission_base IS NULL
        THEN commission_base
      WHEN account_id IS NOT NULL
        THEN commission_base
      WHEN COALESCE((SELECT c.client_type::text FROM clients c WHERE c.id = jobs.client_id), '') = 'commercial'
        THEN commission_base
      ELSE GREATEST(0, (commission_base)::numeric + (${nb}::numeric - (base_fee)::numeric))
    END`;
}
