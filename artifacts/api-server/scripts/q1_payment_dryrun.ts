/**
 * Q1 Part 1 — payment_method backfill dry-run. READ-ONLY.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1. Column type for clients.payment_method
  console.log("=== Part 1 — clients.payment_method column type ===");
  const col = await db.execute(sql`
    SELECT column_name, data_type, udt_name, column_default
      FROM information_schema.columns
     WHERE table_name = 'clients' AND column_name = 'payment_method'
  `);
  console.table(col.rows);

  // If enum, what values are valid?
  const udtName = (col.rows?.[0] as any)?.udt_name;
  if (udtName && udtName !== 'text') {
    const enumVals = await db.execute(sql`
      SELECT enumlabel, enumsortorder
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
       WHERE t.typname = ${udtName}
       ORDER BY enumsortorder
    `);
    console.log(`\nEnum ${udtName} values:`);
    console.table(enumVals.rows);
  } else {
    // Currently-used values on clients
    const distinctVals = await db.execute(sql`
      SELECT DISTINCT payment_method FROM clients WHERE company_id = 1
    `);
    console.log("\nCurrent distinct payment_method values on clients:");
    console.table(distinctVals.rows);
  }

  // 2. MC billing_terms coverage per client
  console.log("\n=== Clients with MC history count ===");
  const coverage = await db.execute(sql`
    SELECT COUNT(DISTINCT matched_customer_id)::int AS clients_with_mc_history
      FROM mc_dispatch_staging
     WHERE matched_customer_id IS NOT NULL
  `);
  console.table(coverage.rows);

  // 3. Top-20 dominant billing_terms per client preview (sample)
  console.log("\n=== Top-20 clients: dominant billing_terms ===");
  const sample = await db.execute(sql`
    SELECT c.id,
           c.first_name || ' ' || c.last_name AS name,
           stats.billing_terms AS mc_dominant_terms,
           stats.job_count,
           c.payment_method AS current_payment_method
      FROM clients c
      JOIN LATERAL (
        SELECT billing_terms, COUNT(*)::int AS job_count
          FROM mc_dispatch_staging mcs
         WHERE mcs.matched_customer_id = c.id
           AND mcs.billing_terms IS NOT NULL
         GROUP BY billing_terms
         ORDER BY COUNT(*) DESC, billing_terms ASC
         LIMIT 1
      ) stats ON true
     WHERE c.company_id = 1
     ORDER BY stats.job_count DESC, c.id
     LIMIT 20
  `);
  console.table(sample.rows);

  // 4. Full distribution of MC-dominant billing_terms
  console.log("\n=== Full distribution: MC-dominant billing_terms across all 266 linked clients ===");
  const dist = await db.execute(sql`
    WITH per_client AS (
      SELECT DISTINCT ON (c.id)
             c.id,
             mcs.billing_terms,
             COUNT(mcs.mc_job_id) OVER (PARTITION BY c.id, mcs.billing_terms) AS job_count
        FROM clients c
        JOIN mc_dispatch_staging mcs ON mcs.matched_customer_id = c.id
       WHERE c.company_id = 1
         AND mcs.billing_terms IS NOT NULL
       ORDER BY c.id, COUNT(mcs.mc_job_id) OVER (PARTITION BY c.id, mcs.billing_terms) DESC, mcs.billing_terms
    )
    SELECT COALESCE(billing_terms, '(null)') AS dominant_mc_terms,
           COUNT(*)::int AS client_count
      FROM per_client
     GROUP BY billing_terms
     ORDER BY client_count DESC
  `);
  console.table(dist.rows);

  // 5. Tie-cases: clients where MC has multiple billing_terms and one is dominant
  console.log("\n=== Clients with mixed billing_terms (for tie-break sanity) ===");
  const ties = await db.execute(sql`
    SELECT c.id,
           c.first_name || ' ' || c.last_name AS name,
           ARRAY_AGG(DISTINCT mcs.billing_terms ORDER BY mcs.billing_terms) AS all_terms,
           COUNT(DISTINCT mcs.billing_terms)::int AS distinct_terms
      FROM clients c
      JOIN mc_dispatch_staging mcs ON mcs.matched_customer_id = c.id
     WHERE c.company_id = 1 AND mcs.billing_terms IS NOT NULL
     GROUP BY c.id, c.first_name, c.last_name
     HAVING COUNT(DISTINCT mcs.billing_terms) > 1
     ORDER BY distinct_terms DESC, c.id
     LIMIT 20
  `);
  console.log(`Mixed-terms clients: ${ties.rowCount}`);
  console.table(ties.rows);

  // 6. Clients with NO MC billing_terms signal (NULL only)
  console.log("\n=== Clients where ALL MC rows have NULL billing_terms ===");
  const noSig = await db.execute(sql`
    SELECT c.id, c.first_name || ' ' || c.last_name AS name,
           COUNT(*)::int AS mc_rows
      FROM clients c
      JOIN mc_dispatch_staging mcs ON mcs.matched_customer_id = c.id
     WHERE c.company_id = 1
     GROUP BY c.id, c.first_name, c.last_name
     HAVING COUNT(*) FILTER (WHERE mcs.billing_terms IS NOT NULL) = 0
     ORDER BY mc_rows DESC
     LIMIT 10
  `);
  console.log(`Clients with all-NULL billing_terms: ${noSig.rowCount}`);
  console.table(noSig.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
