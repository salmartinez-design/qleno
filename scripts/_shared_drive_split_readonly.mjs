/**
 * [shared-drive-split 2026-08-15] READ-ONLY audit of shared drives.
 *
 * Shows every pending drive that has more than one tech on it, what the group
 * currently pays, and what it would pay after an even split. Writes nothing.
 *
 * Run:
 *   node --env-file=/Users/salvadormartinez/qleno/.env scripts/_shared_drive_split_readonly.mjs
 */
import pg from "/Users/salvadormartinez/qleno/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js";

const { Pool } = pg;

const money = (n) => `$${n.toFixed(2)}`;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Does the split schema exist yet?
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'mileage_legs'
      AND column_name IN ('split_group_size', 'amount_before_split')
  `);
  console.log(
    `split columns present: ${cols.rows.length}/2` +
      (cols.rows.length === 2 ? "" : "  (deploy's cold-start migration adds them)"),
  );

  const { rows } = await pool.query(`
    SELECT
      to_char(ml.leg_date, 'YYYY-MM-DD') AS leg_date,
      ml.from_job_id, ml.to_job_id,
      ml.id, ml.user_id, ml.miles, ml.amount, ml.status,
      u.first_name || ' ' || COALESCE(u.last_name, '') AS tech_name
    FROM mileage_legs ml
    JOIN users u ON u.id = ml.user_id
    WHERE ml.company_id = 1
      AND ml.status IN ('computed', 'reviewed')
    ORDER BY ml.leg_date, ml.from_job_id, ml.to_job_id, ml.id
  `);

  const groups = new Map();
  for (const r of rows) {
    const k = `${r.leg_date}|${r.from_job_id}|${r.to_job_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  let currentTotal = 0;
  let splitTotal = 0;
  let count = 0;
  console.log("\nShared drives (more than one cleaner, pending):\n");
  for (const [k, legs] of groups) {
    const techs = new Set(legs.map((l) => l.user_id));
    if (techs.size < 2) continue;
    const amounts = legs.map((l) => Math.round(Number(l.amount) * 100));
    const full = Math.max(...amounts);
    if (full <= 0) continue;
    const now = amounts.reduce((a, b) => a + b, 0);
    count++;
    currentTotal += now;
    splitTotal += full;
    const [date] = k.split("|");
    console.log(
      `  ${date}  ${Number(legs[0].miles).toFixed(1)} mi  ` +
        `pays ${money(now / 100)} now → ${money(full / 100)} split`,
    );
    for (const l of legs) {
      console.log(
        `      leg ${l.id}  ${l.tech_name.trim().padEnd(24)} ${money(Number(l.amount))}`,
      );
    }
  }

  console.log(
    `\n${count} shared drive${count === 1 ? "" : "s"}.` +
      `\n  Pays today if approved as-is:  ${money(currentTotal / 100)}` +
      `\n  Pays if every one is split:    ${money(splitTotal / 100)}` +
      `\n  Difference:                    ${money((currentTotal - splitTotal) / 100)}`,
  );

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
