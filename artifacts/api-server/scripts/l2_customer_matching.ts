/**
 * Commit L2 — Phase 2 customer matching.
 *
 * 2.1  Baseline clients view
 * 2.2  Pass 1 — normalized name match
 * 2.3  Pass 2 — phone last-10-digits match (for residuals)
 * 2.4  Pass 3 — address prefix match (for residuals)
 * 2.5  HARD FAIL gate — any unmatched → print + exit 1
 * 2.6  Match quality summary (only if zero unmatched)
 *
 * Writes to mc_dispatch_staging.matched_customer_id only.
 * No writes to jobs / job_history / recurring_schedules.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function step2_1_baseline() {
  console.log("\n=== STEP 2.1 — baseline clients table ===");

  const total = await db.execute(sql`
    SELECT COUNT(*)::int AS total_clients,
           COUNT(*) FILTER (WHERE is_active = true)::int AS active,
           COUNT(*) FILTER (WHERE is_active = false)::int AS inactive
      FROM clients
     WHERE company_id = 1
  `);
  console.log("Clients totals (company_id=1):");
  console.table(total.rows);

  const uniqueNorm = await db.execute(sql`
    SELECT COUNT(DISTINCT
      LOWER(TRIM(REGEXP_REPLACE(
        COALESCE(first_name,'') || ' ' || COALESCE(last_name,''),
        '\\s+', ' ', 'g')))
    )::int AS unique_normalized_names
    FROM clients
    WHERE company_id = 1
  `);
  console.log("Unique normalized names:");
  console.table(uniqueNorm.rows);

  // Relevant columns
  const cols = await db.execute(sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'clients'
       AND column_name IN ('first_name','last_name','phone','email','name',
                           'display_name','company_name','address','is_active')
     ORDER BY ordinal_position
  `);
  console.log("Relevant clients columns:");
  console.table(cols.rows);
}

async function step2_2_nameMatch() {
  console.log("\n=== STEP 2.2 — Pass 1: exact normalized name ===");
  const res = await db.execute(sql`
    UPDATE mc_dispatch_staging s
       SET matched_customer_id = c.id
      FROM clients c
     WHERE c.company_id = 1
       AND s.matched_customer_id IS NULL
       AND LOWER(TRIM(REGEXP_REPLACE(
             REGEXP_REPLACE(s.customer_name, '\\s+', ' ', 'g'),
             '\\s*\\.\\s*$', '', 'g')))
         = LOWER(TRIM(REGEXP_REPLACE(
             REGEXP_REPLACE(
               COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''),
               '\\s+', ' ', 'g'),
             '\\s*\\.\\s*$', '', 'g')))
  `);
  console.log(`Pass 1 UPDATE rowcount: ${res.rowCount}`);
  await reportMatchRate("After Pass 1 (name)");
}

async function step2_3_phoneMatch() {
  console.log("\n=== STEP 2.3 — Pass 2: phone last-10-digits ===");
  const res = await db.execute(sql`
    UPDATE mc_dispatch_staging s
       SET matched_customer_id = c.id
      FROM clients c
     WHERE c.company_id = 1
       AND s.matched_customer_id IS NULL
       AND s.phone IS NOT NULL
       AND c.phone IS NOT NULL
       AND LENGTH(REGEXP_REPLACE(s.phone, '[^0-9]', '', 'g')) >= 10
       AND LENGTH(REGEXP_REPLACE(c.phone, '[^0-9]', '', 'g')) >= 10
       AND RIGHT(REGEXP_REPLACE(s.phone, '[^0-9]', '', 'g'), 10)
         = RIGHT(REGEXP_REPLACE(c.phone, '[^0-9]', '', 'g'), 10)
  `);
  console.log(`Pass 2 UPDATE rowcount: ${res.rowCount}`);
  await reportMatchRate("After Pass 2 (phone)");
}

async function step2_4_addressMatch() {
  console.log("\n=== STEP 2.4 — Pass 3: address prefix (first 20 chars) ===");
  const res = await db.execute(sql`
    UPDATE mc_dispatch_staging s
       SET matched_customer_id = c.id
      FROM clients c
     WHERE c.company_id = 1
       AND s.matched_customer_id IS NULL
       AND s.address IS NOT NULL
       AND c.address IS NOT NULL
       AND LENGTH(TRIM(s.address)) >= 5
       AND LENGTH(TRIM(c.address)) >= 5
       AND LOWER(LEFT(REGEXP_REPLACE(TRIM(s.address), '\\s+', ' ', 'g'), 20))
         = LOWER(LEFT(REGEXP_REPLACE(TRIM(c.address), '\\s+', ' ', 'g'), 20))
  `);
  console.log(`Pass 3 UPDATE rowcount: ${res.rowCount}`);
  await reportMatchRate("After Pass 3 (address)");
}

async function reportMatchRate(label: string) {
  const r = await db.execute(sql`
    SELECT COUNT(*) FILTER (WHERE matched_customer_id IS NOT NULL)::int AS matched,
           COUNT(*) FILTER (WHERE matched_customer_id IS NULL)::int AS unmatched,
           COUNT(DISTINCT customer_name) FILTER (WHERE matched_customer_id IS NOT NULL)::int AS matched_unique_names,
           COUNT(DISTINCT customer_name) FILTER (WHERE matched_customer_id IS NULL)::int AS unmatched_unique_names
      FROM mc_dispatch_staging
  `);
  console.log(`${label}:`);
  console.table(r.rows);
}

async function step2_5_hardFail(): Promise<boolean> {
  console.log("\n=== STEP 2.5 — HARD FAIL gate ===");
  const unm = await db.execute(sql`
    SELECT COUNT(*)::int AS unmatched_rows,
           COUNT(DISTINCT customer_name)::int AS unmatched_unique_names
      FROM mc_dispatch_staging
     WHERE matched_customer_id IS NULL
  `);
  const row = unm.rows?.[0] as any;
  const unmatched = Number(row?.unmatched_rows ?? 0);
  console.log(`Unmatched: ${unmatched} rows / ${row?.unmatched_unique_names} unique names`);

  if (unmatched > 0) {
    console.log("\n⚠ HARD-FAIL — unmatched customers below. STOPPING. No L2 commit.\n");
    const detail = await db.execute(sql`
      SELECT customer_name,
             phone,
             address,
             COUNT(*)::int AS job_count,
             SUM(bill_rate)::numeric(14,2) AS total_rev
        FROM mc_dispatch_staging
       WHERE matched_customer_id IS NULL
       GROUP BY customer_name, phone, address
       ORDER BY job_count DESC, customer_name
    `);
    console.table(detail.rows);

    // Also surface candidate matches for Sal — fuzzy name suggestions
    console.log("\nFuzzy candidate matches for each unmatched name (clients with similar first 5 chars):");
    const unmatchedNames = await db.execute(sql`
      SELECT DISTINCT customer_name
        FROM mc_dispatch_staging
       WHERE matched_customer_id IS NULL
       ORDER BY customer_name
    `);
    for (const r of unmatchedNames.rows as any[]) {
      const candidates = await db.execute(sql`
        SELECT id,
               COALESCE(first_name,'') || ' ' || COALESCE(last_name,'') AS name,
               phone,
               LEFT(COALESCE(address,''), 40) AS addr
          FROM clients
         WHERE company_id = 1
           AND LOWER(LEFT(COALESCE(first_name,'') || COALESCE(last_name,''), 5))
             = LOWER(LEFT(REGEXP_REPLACE(${r.customer_name}, '\\s+', '', 'g'), 5))
         LIMIT 5
      `);
      console.log(`  "${r.customer_name}" → ${candidates.rowCount ?? 0} candidates`);
      if ((candidates.rowCount ?? 0) > 0) console.table(candidates.rows);
    }
    return false;
  }

  console.log("All 983 rows matched. No hard-fail.");
  return true;
}

async function step2_6_qualitySummary() {
  console.log("\n=== STEP 2.6 — Match quality summary ===");

  const linked = await db.execute(sql`
    SELECT COUNT(DISTINCT matched_customer_id)::int AS qleno_clients_with_mc_history
      FROM mc_dispatch_staging
  `);
  console.log("Unique Qleno clients linked:");
  console.table(linked.rows);

  const top = await db.execute(sql`
    SELECT s.matched_customer_id,
           COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'') AS name,
           COUNT(*)::int AS jobs,
           SUM(s.bill_rate)::numeric(14,2) AS total_rev
      FROM mc_dispatch_staging s
      LEFT JOIN clients c ON c.id = s.matched_customer_id
     GROUP BY s.matched_customer_id, c.first_name, c.last_name
     ORDER BY jobs DESC
     LIMIT 20
  `);
  console.log("Top 20 customers by MC job count:");
  console.table(top.rows);

  console.log("\nPotentially-wrong: one MC customer_name → multiple matched_customer_id (distinct_matches > 1):");
  const multi = await db.execute(sql`
    SELECT customer_name,
           COUNT(DISTINCT matched_customer_id)::int AS distinct_matches,
           ARRAY_AGG(DISTINCT matched_customer_id) AS matched_ids
      FROM mc_dispatch_staging
     GROUP BY customer_name
    HAVING COUNT(DISTINCT matched_customer_id) > 1
     ORDER BY distinct_matches DESC
  `);
  if ((multi.rowCount ?? 0) === 0) {
    console.log("  (none — good)");
  } else {
    console.table(multi.rows);
  }

  console.log("\nConsolidation: multiple MC names → same matched_customer_id (name_variants > 1):");
  const consolidate = await db.execute(sql`
    SELECT s.matched_customer_id,
           COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'') AS db_name,
           ARRAY_AGG(DISTINCT s.customer_name) AS mc_names,
           COUNT(DISTINCT s.customer_name)::int AS name_variants
      FROM mc_dispatch_staging s
      LEFT JOIN clients c ON c.id = s.matched_customer_id
     GROUP BY s.matched_customer_id, c.first_name, c.last_name
    HAVING COUNT(DISTINCT s.customer_name) > 1
     ORDER BY name_variants DESC
  `);
  if ((consolidate.rowCount ?? 0) === 0) {
    console.log("  (none — one-to-one matching)");
  } else {
    console.table(consolidate.rows);
  }

  // Breakdown by which pass caught each row — we can't tell exactly post-hoc,
  // but we can see unique matched customer_ids that were linked
  const coverage = await db.execute(sql`
    SELECT
      (SELECT COUNT(DISTINCT customer_name)::int FROM mc_dispatch_staging) AS mc_unique,
      (SELECT COUNT(DISTINCT matched_customer_id)::int FROM mc_dispatch_staging) AS qleno_unique
  `);
  console.log("\nCoverage:");
  console.table(coverage.rows);
}

async function main() {
  console.log("=== Commit L2 — MC dispatch customer matching ===");
  await step2_1_baseline();
  await step2_2_nameMatch();
  await step2_3_phoneMatch();
  await step2_4_addressMatch();

  const clean = await step2_5_hardFail();
  if (!clean) {
    process.exit(1);
  }

  await step2_6_qualitySummary();
  console.log("\nPhase 2 complete. No hard-fail. Ready to commit L2.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
