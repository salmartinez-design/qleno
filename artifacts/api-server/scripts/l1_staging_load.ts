/**
 * Commit L1 — Phase 1 of MC dispatch import.
 *
 * Steps executed:
 *  1.1  Add mc_job_id column + partial unique index to jobs (idempotent)
 *  1.2  Drop + recreate mc_dispatch_staging
 *  1.3  Load migration/mc-exports-2026-04-22/dispatch-board-jan-apr.csv
 *  1.4  Sanity checks
 *
 * No writes to the jobs table itself — only the new column gets added.
 * Phase 2 (matching + merge into jobs) happens in a separate commit.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CSV_PATH = resolve(
  process.cwd(),
  "migration/mc-exports-2026-04-22/dispatch-board-jan-apr.csv"
);

// ---------- RFC-4180-ish CSV parser (handles BOM, quoted commas, escaped quotes) ----------
function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        // close row; skip \n after \r (CRLF) and empty trailing
        row.push(field);
        field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
        if (ch === "\r" && text[i + 1] === "\n") i++;
      } else {
        field += ch;
      }
    }
  }
  // final field / row if file doesn't end with newline
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

// ---------- Scheduled field parser ----------
// Format: "M/D/YYYY H:MM AM - H:MM PM" (no seconds, no timezone, 12-hour)
// Returns { date: 'YYYY-MM-DD', startTime: 'H:MM AM', endTime: 'H:MM PM' }
function parseScheduled(raw: string): {
  date: string | null;
  startTime: string | null;
  endTime: string | null;
} {
  if (!raw) return { date: null, startTime: null, endTime: null };
  const trimmed = raw.trim();

  // Split on " - " (with spaces) to separate start from end time
  const dashIdx = trimmed.indexOf(" - ");
  const leftPart = dashIdx >= 0 ? trimmed.slice(0, dashIdx).trim() : trimmed;
  const endTime = dashIdx >= 0 ? trimmed.slice(dashIdx + 3).trim() : null;

  // leftPart = "M/D/YYYY H:MM AM"
  const spaceIdx = leftPart.indexOf(" ");
  if (spaceIdx < 0) return { date: null, startTime: null, endTime: null };
  const datePart = leftPart.slice(0, spaceIdx);
  const startTime = leftPart.slice(spaceIdx + 1).trim();

  const dateMatch = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!dateMatch) return { date: null, startTime, endTime };
  const [, m, d, y] = dateMatch;
  const mm = m.padStart(2, "0");
  const dd = d.padStart(2, "0");
  return { date: `${y}-${mm}-${dd}`, startTime, endTime };
}

// ---------- normalization ----------
function normName(s: string): string {
  return (s ?? "").trim().replace(/\s+/g, " ");
}
function toNum(s: string): number | null {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function toInt(s: string): number | null {
  if (!s) return null;
  const n = parseInt(String(s), 10);
  return Number.isFinite(n) ? n : null;
}

async function step1_1_addMcJobIdColumn() {
  console.log("\n=== STEP 1.1 — mc_job_id column + partial unique index ===");
  const existing = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'jobs' AND column_name = 'mc_job_id'
  `);
  console.log("Existing column check:", existing.rows);

  if ((existing.rowCount ?? 0) === 0) {
    console.log("Adding mc_job_id BIGINT column...");
    await db.execute(sql`ALTER TABLE jobs ADD COLUMN mc_job_id BIGINT`);
    console.log("Creating partial unique index jobs_mc_job_id_uniq...");
    await db.execute(
      sql`CREATE UNIQUE INDEX jobs_mc_job_id_uniq ON jobs(mc_job_id) WHERE mc_job_id IS NOT NULL`
    );
    console.log("Column + index created.");
  } else {
    console.log("Column already present — skipping ALTER.");
    const idx = await db.execute(sql`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'jobs'
         AND indexname = 'jobs_mc_job_id_uniq'
    `);
    if ((idx.rowCount ?? 0) === 0) {
      console.log("Index missing — creating jobs_mc_job_id_uniq...");
      await db.execute(
        sql`CREATE UNIQUE INDEX jobs_mc_job_id_uniq ON jobs(mc_job_id) WHERE mc_job_id IS NOT NULL`
      );
    } else {
      console.log("Index already present — skipping.");
    }
  }

  const verify = await db.execute(sql`
    SELECT c.column_name, c.data_type, c.is_nullable,
           (SELECT indexdef FROM pg_indexes
             WHERE schemaname='public' AND tablename='jobs'
               AND indexname='jobs_mc_job_id_uniq') AS index_def
      FROM information_schema.columns c
     WHERE c.table_name='jobs' AND c.column_name='mc_job_id'
  `);
  console.log("Post-verify:");
  console.table(verify.rows);
}

async function step1_2_createStagingTable() {
  console.log("\n=== STEP 1.2 — mc_dispatch_staging table ===");
  await db.execute(sql`DROP TABLE IF EXISTS mc_dispatch_staging`);
  await db.execute(sql`
    CREATE TABLE mc_dispatch_staging (
      mc_job_id BIGINT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      billing_terms TEXT,
      phone TEXT,
      address TEXT,
      frequency TEXT,
      scheduled_raw TEXT NOT NULL,
      scheduled_date DATE,
      scheduled_time_start TEXT,
      scheduled_time_end TEXT,
      team_raw TEXT,
      act_start TEXT,
      act_end TEXT,
      act_hours NUMERIC,
      alwd_hours NUMERIC,
      team_size INT,
      bill_rate NUMERIC,
      status_raw TEXT NOT NULL,
      matched_customer_id INT,
      matched_schedule_id INT,
      parsed_techs JSONB,
      mapped_status TEXT
    )
  `);
  console.log("Dropped + recreated mc_dispatch_staging.");
}

async function step1_3_loadCsv() {
  console.log("\n=== STEP 1.3 — Load CSV into staging ===");
  console.log(`Reading ${CSV_PATH}`);
  const raw = readFileSync(CSV_PATH, "utf-8");
  const rows = parseCsv(raw);
  console.log(`Parsed ${rows.length} lines (including header).`);

  const header = rows[0];
  console.log(`Header (${header.length} cols): ${header.join(" | ")}`);

  const expectedCols = [
    "Job ID", "Customer", "Billing Terms", "Phone", "Address", "Freq.",
    "Scheduled", "Team", "Act. Start", "Act. End", "Act. Hrs", "Alwd. Hours",
    "Alwd. - Act. Hrs.", "Norm. Alwd. Hrs.", "Norm. Alwd. - Act. Hrs.",
    "Team Size", "Billing Type", "Bill Rate", "Bill Rate/Act. Hours",
    "Status", "Scorecard",
  ];
  for (let i = 0; i < expectedCols.length; i++) {
    if (header[i] !== expectedCols[i]) {
      throw new Error(
        `Column ${i} mismatch: expected '${expectedCols[i]}', got '${header[i]}'`
      );
    }
  }
  console.log("Header matches expected 21-column schema.");

  const dataRows = rows.slice(1);
  console.log(`Data rows: ${dataRows.length}`);

  // Build param rows in chunks
  const chunkSize = 200;
  let inserted = 0;
  await db.execute(sql`BEGIN`);
  try {
    for (let off = 0; off < dataRows.length; off += chunkSize) {
      const chunk = dataRows.slice(off, off + chunkSize);
      for (const r of chunk) {
        const jobId = toInt(r[0]);
        if (jobId == null) {
          throw new Error(`Row missing Job ID at offset ${off + inserted}: ${r.join("|")}`);
        }
        const customer = normName(r[1]);
        if (!customer) {
          throw new Error(`Row missing Customer at offset ${off + inserted}, Job ID ${jobId}`);
        }
        const statusRaw = (r[19] ?? "").trim();
        if (!statusRaw) {
          throw new Error(`Row missing Status at offset ${off + inserted}, Job ID ${jobId}`);
        }

        const scheduledRaw = (r[6] ?? "").trim();
        const { date, startTime, endTime } = parseScheduled(scheduledRaw);

        await db.execute(sql`
          INSERT INTO mc_dispatch_staging (
            mc_job_id, customer_name, billing_terms, phone, address,
            frequency, scheduled_raw, scheduled_date, scheduled_time_start,
            scheduled_time_end, team_raw, act_start, act_end, act_hours,
            alwd_hours, team_size, bill_rate, status_raw
          ) VALUES (
            ${jobId}, ${customer}, ${r[2] || null}, ${r[3] || null}, ${r[4] || null},
            ${r[5] || null}, ${scheduledRaw}, ${date}::date, ${startTime},
            ${endTime}, ${r[7] || null}, ${r[8] || null}, ${r[9] || null}, ${toNum(r[10])},
            ${toNum(r[11])}, ${toInt(r[15])}, ${toNum(r[17])}, ${statusRaw}
          )
        `);
        inserted++;
      }
      console.log(`  ...inserted ${inserted}/${dataRows.length}`);
    }
    await db.execute(sql`COMMIT`);
    console.log(`Committed ${inserted} rows.`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.error("Load failed, ROLLBACK:", err);
    throw err;
  }
}

async function step1_4_sanityChecks() {
  console.log("\n=== STEP 1.4 — Staging sanity checks ===");

  const totals = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(DISTINCT mc_job_id)::int AS unique_ids,
      COUNT(DISTINCT customer_name)::int AS unique_customers,
      MIN(scheduled_date)::text AS min_date,
      MAX(scheduled_date)::text AS max_date,
      SUM(bill_rate)::numeric(14,2) AS total_bill_rate
    FROM mc_dispatch_staging
  `);
  console.log("Totals:");
  console.table(totals.rows);

  const status = await db.execute(sql`
    SELECT status_raw, COUNT(*)::int AS n
      FROM mc_dispatch_staging
     GROUP BY status_raw
     ORDER BY n DESC
  `);
  console.log("\nBy status:");
  console.table(status.rows);

  const freq = await db.execute(sql`
    SELECT COALESCE(frequency, '(null)') AS frequency, COUNT(*)::int AS n
      FROM mc_dispatch_staging
     GROUP BY frequency
     ORDER BY n DESC
  `);
  console.log("\nBy frequency:");
  console.table(freq.rows);

  // Parse health — any rows where scheduled_date failed to parse
  const parseFail = await db.execute(sql`
    SELECT COUNT(*)::int AS n_no_date
      FROM mc_dispatch_staging
     WHERE scheduled_date IS NULL
  `);
  console.log("\nParse health:");
  console.table(parseFail.rows);

  const parseFailSample = await db.execute(sql`
    SELECT mc_job_id, scheduled_raw
      FROM mc_dispatch_staging
     WHERE scheduled_date IS NULL
     LIMIT 5
  `);
  if ((parseFailSample.rowCount ?? 0) > 0) {
    console.log("Sample un-parseable Scheduled fields:");
    console.table(parseFailSample.rows);
  }

  // Daily distribution for April (quick-look, should match MC's daily numbers)
  const april = await db.execute(sql`
    SELECT scheduled_date::text AS date,
           COUNT(*)::int AS jobs,
           SUM(bill_rate)::numeric(14,2) AS total
      FROM mc_dispatch_staging
     WHERE scheduled_date BETWEEN '2026-04-01' AND '2026-04-30'
     GROUP BY scheduled_date
     ORDER BY scheduled_date
  `);
  console.log("\nApril 2026 daily distribution (preview vs MC ground-truth):");
  console.table(april.rows);
}

async function main() {
  console.log("=== Commit L1 — MC dispatch staging + CSV load ===");
  await step1_1_addMcJobIdColumn();
  await step1_2_createStagingTable();
  await step1_3_loadCsv();
  await step1_4_sanityChecks();
  console.log("\nDone.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
