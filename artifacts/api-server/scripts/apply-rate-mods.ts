/**
 * One-shot: apply job_rate_mods schema + backfill the specific April adjustments
 * Sal called out, then recompute billed_amount on the affected jobs.
 *
 * Run:
 *   cd artifacts/api-server
 *   ./node_modules/.bin/tsx --env-file=../../.env scripts/apply-rate-mods.ts [--dry-run]
 */
import { pool, db } from "@workspace/db";
import { sql } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");

type Backfill = {
  client_first: string;
  client_last: string;
  scheduled_date?: string;          // optional pin to a specific date
  month?: { from: string; to: string }; // or anywhere in this window
  mod_type: "time" | "flat";
  minutes?: number;
  amount: number;
  reason: string;
};

const BACKFILL: Backfill[] = [
  // Chris Schultz April: +30 min → +$30
  { client_first: "Chris", client_last: "Schultz",
    month: { from: "2026-04-01", to: "2026-04-30" },
    mod_type: "time", minutes: 30, amount: 30, reason: "Extra time on site" },
  // Jim Schultz April: +30 min → +$27.50
  { client_first: "Jim", client_last: "Schultz",
    month: { from: "2026-04-01", to: "2026-04-30" },
    mod_type: "time", minutes: 30, amount: 27.5, reason: "Extra time on site" },
  // Daniel Walter April: +2 hrs → +$100
  { client_first: "Daniel", client_last: "Walter",
    month: { from: "2026-04-01", to: "2026-04-30" },
    mod_type: "time", minutes: 120, amount: 100, reason: "Additional 2 hours" },
  // Jaira Estrada Apr 20: flat +$20 parking, flat -$50 adjustment
  { client_first: "Jaira", client_last: "Estrada", scheduled_date: "2026-04-20",
    mod_type: "flat", amount: 20, reason: "Parking" },
  { client_first: "Jaira", client_last: "Estrada", scheduled_date: "2026-04-20",
    mod_type: "flat", amount: -50, reason: "Adjustment" },
  // Jaira Estrada Apr 21
  { client_first: "Jaira", client_last: "Estrada", scheduled_date: "2026-04-21",
    mod_type: "flat", amount: 20, reason: "Parking" },
  { client_first: "Jaira", client_last: "Estrada", scheduled_date: "2026-04-21",
    mod_type: "flat", amount: -50, reason: "Adjustment" },
  // Jaira Estrada Apr 24
  { client_first: "Jaira", client_last: "Estrada", scheduled_date: "2026-04-24",
    mod_type: "flat", amount: 20, reason: "Parking" },
  { client_first: "Jaira", client_last: "Estrada", scheduled_date: "2026-04-24",
    mod_type: "flat", amount: -50, reason: "Adjustment" },
  // Jaira Estrada Apr 28: parking only
  { client_first: "Jaira", client_last: "Estrada", scheduled_date: "2026-04-28",
    mod_type: "flat", amount: 20, reason: "Parking" },
];

async function ensureSchema(): Promise<void> {
  console.log("[schema] CREATE TABLE IF NOT EXISTS job_rate_mods");
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS job_rate_mods (
      id          SERIAL PRIMARY KEY,
      company_id  INT NOT NULL REFERENCES companies(id),
      job_id      INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      mod_type    TEXT NOT NULL CHECK (mod_type IN ('time', 'flat')),
      minutes     INT,
      amount      NUMERIC(10,2) NOT NULL,
      reason      TEXT NOT NULL,
      created_by  INT REFERENCES users(id),
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS idx_job_rate_mods_job ON job_rate_mods(company_id, job_id)`
  ));
}

async function findJobs(b: Backfill): Promise<number[]> {
  const conditions: string[] = [
    `c.first_name ILIKE $1`,
    `c.last_name ILIKE $2`,
  ];
  const params: any[] = [b.client_first, b.client_last];
  if (b.scheduled_date) {
    conditions.push(`j.scheduled_date = $${params.length + 1}::date`);
    params.push(b.scheduled_date);
  } else if (b.month) {
    conditions.push(
      `j.scheduled_date BETWEEN $${params.length + 1}::date AND $${params.length + 2}::date`
    );
    params.push(b.month.from, b.month.to);
  }
  const queryText = `
    SELECT j.id
    FROM jobs j
    JOIN clients c ON c.id = j.client_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY j.scheduled_date ASC
  `;
  const result = await pool.query(queryText, params);
  return result.rows.map((r: any) => Number(r.id));
}

async function jobAlreadyHasMod(jobId: number, b: Backfill): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM job_rate_mods
     WHERE job_id = $1 AND mod_type = $2 AND amount = $3 AND reason = $4
     LIMIT 1`,
    [jobId, b.mod_type, b.amount.toFixed(2), b.reason]
  );
  return result.rows.length > 0;
}

async function getCompanyId(jobId: number): Promise<number> {
  const r = await pool.query(`SELECT company_id FROM jobs WHERE id = $1`, [jobId]);
  return Number(r.rows[0].company_id);
}

async function recomputeBilledAmount(jobId: number, companyId: number): Promise<{ base: number; mods: number; billed: number }> {
  const j = await pool.query(`SELECT base_fee FROM jobs WHERE id = $1`, [jobId]);
  const base = parseFloat(j.rows[0].base_fee || "0");
  const m = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM job_rate_mods WHERE job_id = $1 AND company_id = $2`,
    [jobId, companyId]
  );
  const modsTotal = parseFloat(m.rows[0].total || "0");
  const billed = base + modsTotal;
  if (!DRY_RUN) {
    await pool.query(
      `UPDATE jobs SET billed_amount = $1 WHERE id = $2 AND company_id = $3`,
      [billed.toFixed(2), jobId, companyId]
    );
  }
  return { base, mods: modsTotal, billed };
}

async function main(): Promise<void> {
  console.log(DRY_RUN ? "[DRY RUN — no writes]" : "[LIVE — writing to DB]");
  // Schema creation is idempotent (IF NOT EXISTS); run it even on dry-run
  // so the dup-check query below has a table to read.
  await ensureSchema();

  const touchedJobs = new Set<number>();
  const touchedJobMeta = new Map<number, number>(); // jobId → companyId

  for (const b of BACKFILL) {
    const jobs = await findJobs(b);
    const tag = `${b.client_first} ${b.client_last} ${b.scheduled_date ?? b.month?.from + ".." + b.month?.to}`;
    if (jobs.length === 0) {
      console.warn(`  ⚠ no jobs matched: ${tag}`);
      continue;
    }
    if (b.scheduled_date && jobs.length > 1) {
      console.warn(`  ⚠ ${jobs.length} jobs matched for date-pinned mod: ${tag} — using all`);
    }
    if (b.month && jobs.length > 1) {
      // For month-window backfills, the spec says "April job" (singular) — only
      // apply to the first job if multiple matched.
      console.warn(`  ⚠ ${jobs.length} jobs matched for month window — using FIRST only: ${tag}`);
      jobs.length = 1;
    }
    for (const jobId of jobs) {
      const companyId = await getCompanyId(jobId);
      touchedJobMeta.set(jobId, companyId);
      if (await jobAlreadyHasMod(jobId, b)) {
        console.log(`  ↻ skip (already exists): job ${jobId} ${b.mod_type} ${b.amount} "${b.reason}"`);
        touchedJobs.add(jobId);
        continue;
      }
      console.log(
        `  + job ${jobId}: ${b.mod_type}${b.minutes !== undefined ? " " + b.minutes + "min" : ""} ${b.amount >= 0 ? "+" : ""}$${b.amount} (${b.reason})`
      );
      if (!DRY_RUN) {
        await pool.query(
          `INSERT INTO job_rate_mods (company_id, job_id, mod_type, minutes, amount, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [companyId, jobId, b.mod_type, b.mod_type === "time" ? b.minutes ?? null : null,
           b.amount.toFixed(2), b.reason]
        );
      }
      touchedJobs.add(jobId);
    }
  }

  console.log(`\n[recompute] ${touchedJobs.size} affected job(s)`);
  for (const jobId of touchedJobs) {
    const companyId = touchedJobMeta.get(jobId)!;
    const { base, mods, billed } = await recomputeBilledAmount(jobId, companyId);
    console.log(`  job ${jobId}: base $${base.toFixed(2)} + mods $${mods.toFixed(2)} = billed $${billed.toFixed(2)}`);
  }

  await pool.end();
  console.log(DRY_RUN ? "\n[DRY RUN complete — no rows changed]" : "\n[DONE]");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
