/**
 * Q1 — one-time backfill of clients.payment_method from MC billing_terms.
 *
 * Adapted mapping (CHECK constraint limits payment_method to
 * {card_on_file, check, zelle, net_30, manual}):
 *   Credit Card     → card_on_file  (253 clients)
 *   Batch Invoice   → net_30        (7)
 *   Invoice         → net_30        (4)
 *   Prepay          → manual        (1 — no "prepaid" value allowed, keep current)
 *   Other           → (no change, stays 'manual')  (1)
 *
 * Expected: 264 UPDATEs (Prepay + Other excluded from filter; no-op anyway).
 * Transaction with rowcount gate, ROLLBACK on mismatch.
 *
 * Rollback:
 *   UPDATE clients SET payment_method = 'manual'
 *    WHERE company_id = 1
 *      AND payment_method IN ('credit_card', 'invoice', 'prepaid')
 *      AND notes LIKE '%mc_import_phase2%'
 *     OR  id IN (SELECT DISTINCT matched_customer_id FROM mc_dispatch_staging);
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const EXPECTED = 264;

async function main() {
  console.log("=== Q1 — payment_method backfill ===\n");

  // Pre-flight: confirm DISTINCT client count for the 3 mapped categories
  const pre = await db.execute(sql`
    SELECT COUNT(DISTINCT mcs.matched_customer_id)::int AS n
      FROM mc_dispatch_staging mcs
     WHERE mcs.matched_customer_id IS NOT NULL
       AND mcs.billing_terms IN ('Credit Card', 'Batch Invoice', 'Invoice')
  `);
  console.log(`Pre-flight distinct-client count: ${(pre.rows?.[0] as any)?.n} (expect ${EXPECTED})`);

  console.log("\n=== Transaction ===");
  await db.execute(sql`BEGIN`);
  try {
    // Use DISTINCT ON with ORDER BY billing_terms to pick a deterministic
    // terms per client (all clients have exactly one distinct value per the
    // dry-run — ties should not occur, but DISTINCT ON is the safety net).
    const res = await db.execute(sql`
      UPDATE clients c
         SET payment_method = CASE stats.billing_terms
               WHEN 'Credit Card'    THEN 'card_on_file'
               WHEN 'Invoice'        THEN 'net_30'
               WHEN 'Batch Invoice'  THEN 'net_30'
               ELSE c.payment_method
             END
        FROM (
          SELECT DISTINCT ON (mcs.matched_customer_id)
                 mcs.matched_customer_id AS customer_id,
                 mcs.billing_terms
            FROM mc_dispatch_staging mcs
           WHERE mcs.matched_customer_id IS NOT NULL
             AND mcs.billing_terms IS NOT NULL
           ORDER BY mcs.matched_customer_id, mcs.billing_terms
        ) stats
       WHERE c.id = stats.customer_id
         AND c.company_id = 1
         AND stats.billing_terms IN ('Credit Card', 'Invoice', 'Batch Invoice')
      RETURNING c.id, c.first_name, c.last_name, c.payment_method
    `);
    console.log(`UPDATE rowcount: ${res.rowCount} (expect ${EXPECTED})`);
    if (res.rowCount !== EXPECTED) {
      throw new Error(`rowcount mismatch: got ${res.rowCount}, expected ${EXPECTED}`);
    }

    // Show a sample of what changed
    console.log("\nSample of updated rows (first 10):");
    console.table((res.rows as any[]).slice(0, 10));

    await db.execute(sql`COMMIT`);
    console.log("--- COMMIT OK ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.log("--- ROLLBACK ---");
    throw err;
  }

  // Post-verify — full distribution
  console.log("\n=== Post-verify: full clients.payment_method distribution ===");
  const dist = await db.execute(sql`
    SELECT payment_method, COUNT(*)::int AS n
      FROM clients
     WHERE company_id = 1
     GROUP BY payment_method
     ORDER BY n DESC
  `);
  console.table(dist.rows);

  // Verify no MC client still has 'manual' (except the 1 'Other' case)
  const residual = await db.execute(sql`
    SELECT c.id, c.first_name || ' ' || c.last_name AS name,
           c.payment_method,
           stats.billing_terms AS mc_terms
      FROM clients c
      JOIN (
        SELECT DISTINCT ON (mcs.matched_customer_id)
               mcs.matched_customer_id AS customer_id, mcs.billing_terms
          FROM mc_dispatch_staging mcs
         WHERE mcs.matched_customer_id IS NOT NULL
           AND mcs.billing_terms IS NOT NULL
         ORDER BY mcs.matched_customer_id, mcs.billing_terms
      ) stats ON stats.customer_id = c.id
     WHERE c.company_id = 1 AND c.payment_method = 'manual'
     ORDER BY c.id
  `);
  console.log("\n=== MC-linked clients still on 'manual' (expect 1: the 'Other' row) ===");
  console.table(residual.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
