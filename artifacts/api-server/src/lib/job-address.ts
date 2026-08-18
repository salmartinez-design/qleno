/**
 * When does a job's own address snapshot win over the client record?
 *
 * A job may carry `jobs.address_street/city/state/zip` — a one-off service site
 * (a move-out at another house). When it does, that snapshot beats
 * `clients.address` everywhere the address is shown or texted.
 *
 * Two rules, learned the hard way, and they pull against each other:
 *
 * 1. RESOLVE AS A UNIT. [addr-city-state 2026-08-08] Every component must come
 *    from the same source. Per-field COALESCE(job, client) rendered Jess
 *    Wilhite's job (CL-1520) as "333 North Jefferson Street, Brownsburg, IN
 *    60661" — stale city and state from the job, corrected zip from the client,
 *    an address that exists nowhere.
 *
 * 2. A STREET ALONE IS NOT AN OVERRIDE. [partial-override 2026-08-18] The
 *    booking and quote flows write a street with no city/state/zip. Under rule
 *    1 that snapshot then suppressed the client's city, state AND zip too, so
 *    Cynthiia Lopezz's job 21015 rendered "17878 Argos Court" while her profile
 *    said "17878 Argos Court, Tinley Park, IL 60477". Maribel, on the second
 *    report of the same card: "still happening. it doesnt show the full
 *    address." Sal's standing rule (CLAUDE.md) is that if an address is shown,
 *    the zip is shown — and a street with no town is not somewhere a cleaner
 *    can drive.
 *
 * The reconciliation: an override needs at least one component BEYOND the
 * street. With a city or a zip there is a second location genuinely being
 * described, and it wins whole. With neither, there is nothing to protect —
 * it is an incomplete copy of the client's address, and the client record wins
 * whole. Either way, one source, never a blend.
 *
 * `ap.*` (account_property) jobs never reach this: a property job IS that
 * property and has no per-job override — see lib/job-coords.ts.
 */
import { sql, type SQL } from "drizzle-orm";

const nonBlank = (col: unknown) => sql`NULLIF(BTRIM(${col}), '') IS NOT NULL`;

/**
 * Drizzle form. Every component of the address MUST switch on this one
 * expression, or the hybrid from rule 1 comes back.
 */
export function jobHasOwnAddress(jobs: {
  address_street: unknown; address_city: unknown; address_zip: unknown;
}): SQL {
  return sql`(${nonBlank(jobs.address_street)}
    AND (${nonBlank(jobs.address_city)} OR ${nonBlank(jobs.address_zip)}))`;
}

/** Raw-SQL form. Requires the jobs table aliased as `j`. */
export const JOB_HAS_OWN_ADDRESS_SQL: SQL = sql`(NULLIF(BTRIM(j.address_street), '') IS NOT NULL
  AND (NULLIF(BTRIM(j.address_city), '') IS NOT NULL OR NULLIF(BTRIM(j.address_zip), '') IS NOT NULL))`;
