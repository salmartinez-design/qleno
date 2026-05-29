/**
 * L2 — targeted probes for the 7 unmatched customers. READ-ONLY.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1. Carol Butler — is this "Tom and Carol Butler" id=22?
  console.log("=== Probe 1: Carol Butler cross-check ===");
  const carolProbe = await db.execute(sql`
    SELECT id,
           first_name || ' ' || last_name AS name,
           phone, address, is_active
      FROM clients
     WHERE company_id = 1
       AND (LOWER(first_name || ' ' || last_name) LIKE '%butler%'
            OR LOWER(COALESCE(company_name,'')) LIKE '%butler%'
            OR phone LIKE '%301-5678%'
            OR address ILIKE '%121 N Garfield%'
            OR address ILIKE '%121 north garfield%')
     ORDER BY id
  `);
  console.table(carolProbe.rows);

  // 2. For each unmatched name, search by last_name only and by phone digits
  console.log("\n=== Probe 2: last-name + phone-digit wildcards for each unmatched ===");
  const names = [
    ["Connie Castillo", "Castillo", "773-266-9673"],
    ["Falana Smart", "Smart", "313-722-5035"],
    ["Lauren Covalle", "Covalle", "586-292-7152"],
    ["Lauren Kent", "Kent", "773-354-7896"],
    ["Mackenzie Dongmo", "Dongmo", "872-310-8477"],
    ["Peter Nicieja", "Nicieja", "773-598-0216"],
  ];
  for (const [mcName, lastName, phone] of names) {
    const digits = phone.replace(/\D/g, "");
    const probe = await db.execute(sql`
      SELECT id,
             first_name || ' ' || last_name AS name,
             phone,
             LEFT(COALESCE(address,''), 40) AS addr,
             is_active
        FROM clients
       WHERE company_id = 1
         AND (
           LOWER(last_name) = LOWER(${lastName})
           OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE ${'%' + digits.slice(-7) + '%'}
         )
       LIMIT 5
    `);
    console.log(`\nMC "${mcName}" (last=${lastName}, ph=${phone}) → ${probe.rowCount ?? 0} hits`);
    if ((probe.rowCount ?? 0) > 0) console.table(probe.rows);
  }

  // 3. Address-level probes on unmatched
  console.log("\n=== Probe 3: address-based probes for each unmatched ===");
  const addrs = [
    "121 N Garfield",
    "96 Foxfire",
    "9955 Nottingham",
    "11411 South Ewing",
    "6214 South Champlain",
    "5009 North Sheridan",
    "4455 North Hamilton",
  ];
  for (const a of addrs) {
    const probe = await db.execute(sql`
      SELECT id, first_name || ' ' || last_name AS name,
             phone, LEFT(COALESCE(address,''), 50) AS addr
        FROM clients
       WHERE company_id = 1 AND address ILIKE ${'%' + a + '%'}
       LIMIT 5
    `);
    console.log(`\nAddr "${a}" → ${probe.rowCount ?? 0} hits`);
    if ((probe.rowCount ?? 0) > 0) console.table(probe.rows);
  }

  // 4. Recurring schedules for these unmatched names (are any of them active schedules?)
  console.log("\n=== Probe 4: any MC frequency suggests recurring? ===");
  const freq = await db.execute(sql`
    SELECT customer_name, frequency, COUNT(*)::int AS jobs, SUM(bill_rate)::numeric(14,2) AS total
      FROM mc_dispatch_staging
     WHERE matched_customer_id IS NULL
     GROUP BY customer_name, frequency
     ORDER BY customer_name, jobs DESC
  `);
  console.table(freq.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
