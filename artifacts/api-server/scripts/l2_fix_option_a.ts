/**
 * L2 fix — Option A. Per Sal's decision.
 *
 * F2.1 — Backfill client id=22 (Tom and Carol Butler) phone + address from MC
 * F2.2 — Map 15 "Carol Butler" rows to matched_customer_id = 22
 * F2.3 — Create 6 new residential client rows for one-time MC customers
 *         (uses notes='[mc_import_phase2 2026-04-22]' since clients table has
 *          no migration_source column — same traceability pattern as G-series)
 * F2.4 — Link the 6 new clients back to staging
 * F2.5 — Final match quality summary (must be 0 unmatched)
 *
 * Atomicity: each step in its own BEGIN/COMMIT. If F2.3 fails after F2.1/F2.2
 * succeed, we stop with partial progress logged and recoverable. F2.3 does
 * use a rowcount gate — expect exactly 6 inserted.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const MIG_NOTE = "[mc_import_phase2 2026-04-22]";

async function f2_1_backfillClient22() {
  console.log("\n=== F2.1 — Backfill client id=22 phone + address ===");

  const before = await db.execute(sql`
    SELECT id, first_name, last_name, phone, address, email, is_active
      FROM clients WHERE id = 22 AND company_id = 1
  `);
  console.log("Before:");
  console.table(before.rows);
  if ((before.rowCount ?? 0) !== 1) {
    throw new Error("Expected exactly 1 row for client id=22");
  }

  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      UPDATE clients
         SET phone = '312-301-5678',
             address = COALESCE(address, '121 N Garfield St')
       WHERE id = 22 AND company_id = 1
    `);
    console.log(`UPDATE rowcount: ${res.rowCount} (expect 1)`);
    if (res.rowCount !== 1) throw new Error(`rowcount mismatch: ${res.rowCount}`);
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    throw err;
  }

  const after = await db.execute(sql`
    SELECT id, first_name, last_name, phone, address FROM clients WHERE id = 22
  `);
  console.log("After:");
  console.table(after.rows);
}

async function f2_2_mapCarolButler() {
  console.log("\n=== F2.2 — Map Carol Butler → id=22 ===");

  // Pre-verify: how many Carol Butler rows unmatched
  const pre = await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM mc_dispatch_staging
     WHERE customer_name = 'Carol Butler' AND matched_customer_id IS NULL
  `);
  const preN = Number((pre.rows?.[0] as any)?.n ?? 0);
  console.log(`Pre: unmatched Carol Butler rows = ${preN} (expect 15)`);
  if (preN !== 15) throw new Error(`Expected 15 unmatched Carol Butler rows, got ${preN}`);

  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      UPDATE mc_dispatch_staging
         SET matched_customer_id = 22
       WHERE customer_name = 'Carol Butler'
         AND matched_customer_id IS NULL
    `);
    console.log(`UPDATE rowcount: ${res.rowCount} (expect 15)`);
    if (res.rowCount !== 15) throw new Error(`rowcount mismatch: ${res.rowCount}`);
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    throw err;
  }

  const verify = await db.execute(sql`
    SELECT customer_name,
           COUNT(*)::int AS rows,
           matched_customer_id
      FROM mc_dispatch_staging
     WHERE customer_name = 'Carol Butler'
     GROUP BY customer_name, matched_customer_id
  `);
  console.log("Post-verify:");
  console.table(verify.rows);
}

async function f2_3_createNewClients() {
  console.log("\n=== F2.3 — Create 6 new clients for one-time MC customers ===");

  // Preview the 6 source rows
  const preview = await db.execute(sql`
    SELECT DISTINCT ON (customer_name)
           customer_name, phone, address
      FROM mc_dispatch_staging
     WHERE matched_customer_id IS NULL
     ORDER BY customer_name, mc_job_id
  `);
  console.log("Source rows for new clients:");
  console.table(preview.rows);
  if ((preview.rowCount ?? 0) !== 6) {
    throw new Error(`Expected 6 unmatched unique customer_names, got ${preview.rowCount}`);
  }

  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      INSERT INTO clients (
        company_id, first_name, last_name, phone, address,
        is_active, notes, client_type, created_at
      )
      SELECT
        1 AS company_id,
        -- first_name = everything before the LAST space
        CASE
          WHEN POSITION(' ' IN customer_name) > 0
          THEN SUBSTRING(customer_name FROM 1
                         FOR LENGTH(customer_name) - POSITION(' ' IN REVERSE(customer_name)))
          ELSE customer_name
        END AS first_name,
        -- last_name = everything after the LAST space
        CASE
          WHEN POSITION(' ' IN customer_name) > 0
          THEN SUBSTRING(customer_name FROM
                         LENGTH(customer_name) - POSITION(' ' IN REVERSE(customer_name)) + 2)
          ELSE ''
        END AS last_name,
        phone,
        address,
        false AS is_active,
        ${MIG_NOTE} AS notes,
        'residential'::client_type AS client_type,
        NOW() AS created_at
      FROM (
        SELECT DISTINCT ON (customer_name) customer_name, phone, address
          FROM mc_dispatch_staging
         WHERE matched_customer_id IS NULL
         ORDER BY customer_name, mc_job_id
      ) unmatched
      RETURNING id, first_name, last_name, phone, address
    `);
    console.log(`INSERT rowcount: ${res.rowCount} (expect 6)`);
    console.log("Newly created rows:");
    console.table(res.rows);

    if (res.rowCount !== 6) {
      throw new Error(`INSERT rowcount mismatch: ${res.rowCount}`);
    }

    // Sanity: every new row should have non-empty first_name AND last_name
    for (const r of res.rows as any[]) {
      if (!r.first_name || !r.last_name) {
        throw new Error(
          `Name split produced empty first/last for id=${r.id}: ` +
          `first='${r.first_name}' last='${r.last_name}'`
        );
      }
    }
    console.log("All 6 new clients have valid first+last names. Proceeding to COMMIT.");
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.log("--- ROLLBACK (F2.3) ---");
    throw err;
  }
}

async function f2_4_linkNewClients() {
  console.log("\n=== F2.4 — Link 6 new clients back to staging ===");
  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      UPDATE mc_dispatch_staging s
         SET matched_customer_id = c.id
        FROM clients c
       WHERE c.company_id = 1
         AND c.notes = ${MIG_NOTE}
         AND s.matched_customer_id IS NULL
         AND LOWER(TRIM(s.customer_name))
           = LOWER(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')))
    `);
    console.log(`UPDATE rowcount: ${res.rowCount} (expect 6)`);
    if (res.rowCount !== 6) throw new Error(`rowcount mismatch: ${res.rowCount}`);
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    throw err;
  }

  const unmatched = await db.execute(sql`
    SELECT COUNT(*)::int AS unmatched_rows,
           COUNT(DISTINCT customer_name)::int AS unmatched_unique_names
      FROM mc_dispatch_staging
     WHERE matched_customer_id IS NULL
  `);
  console.log("Final unmatched state:");
  console.table(unmatched.rows);
  const row = unmatched.rows?.[0] as any;
  const unmN = Number(row?.unmatched_rows ?? -1);
  if (unmN !== 0) {
    throw new Error(`Expected 0 unmatched, got ${unmN}`);
  }
  console.log("✓ Zero unmatched. All 983 rows linked.");
}

async function f2_5_qualitySummary() {
  console.log("\n=== F2.5 — Final match quality summary ===");

  const linked = await db.execute(sql`
    SELECT COUNT(DISTINCT matched_customer_id)::int AS qleno_clients_with_mc_history
      FROM mc_dispatch_staging
  `);
  console.table(linked.rows);

  console.log("\nAny MC customer_name → multiple customer_ids? (should be 0):");
  const multi = await db.execute(sql`
    SELECT customer_name, COUNT(DISTINCT matched_customer_id)::int AS distinct_matches
      FROM mc_dispatch_staging
     GROUP BY customer_name
    HAVING COUNT(DISTINCT matched_customer_id) > 1
  `);
  if ((multi.rowCount ?? 0) === 0) console.log("  (none — clean)");
  else console.table(multi.rows);

  console.log("\nTop 10 customers by MC job count:");
  const top = await db.execute(sql`
    SELECT s.matched_customer_id,
           COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'') AS name,
           COUNT(*)::int AS jobs,
           SUM(s.bill_rate)::numeric(14,2) AS total_rev
      FROM mc_dispatch_staging s
      LEFT JOIN clients c ON c.id = s.matched_customer_id
     GROUP BY s.matched_customer_id, c.first_name, c.last_name
     ORDER BY jobs DESC
     LIMIT 10
  `);
  console.table(top.rows);

  // Spot the Tom and Carol Butler row
  const butler = await db.execute(sql`
    SELECT s.matched_customer_id,
           COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'') AS name,
           COUNT(*)::int AS jobs,
           SUM(s.bill_rate)::numeric(14,2) AS total_rev,
           ARRAY_AGG(DISTINCT s.customer_name) AS mc_names
      FROM mc_dispatch_staging s
      LEFT JOIN clients c ON c.id = s.matched_customer_id
     WHERE s.matched_customer_id = 22
     GROUP BY s.matched_customer_id, c.first_name, c.last_name
  `);
  console.log("\nSpotlight — client id=22 after Carol Butler alias:");
  console.table(butler.rows);

  // Spot the 6 new client rows
  const newSpot = await db.execute(sql`
    SELECT c.id, c.first_name, c.last_name, c.phone, c.address, c.is_active,
           (SELECT COUNT(*)::int FROM mc_dispatch_staging s WHERE s.matched_customer_id = c.id) AS mc_jobs_linked
      FROM clients c
     WHERE c.company_id = 1 AND c.notes = ${MIG_NOTE}
     ORDER BY c.id
  `);
  console.log("\nSpotlight — 6 new clients:");
  console.table(newSpot.rows);
}

async function main() {
  console.log("=== L2 fix — Option A ===");
  await f2_1_backfillClient22();
  await f2_2_mapCarolButler();
  await f2_3_createNewClients();
  await f2_4_linkNewClients();
  await f2_5_qualitySummary();
  console.log("\nL2 fix complete. Ready to commit.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
