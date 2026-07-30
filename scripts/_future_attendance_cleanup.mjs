// Future-dated attendance cleanup (audit 2026-07-30).
//
// WHY THIS EXISTS
// Nothing used to validate that an attendance record's log_date was a day that
// had actually happened, and the occurrence ladder fires on WRITE — stamping
// its discipline row with that same log_date. So recording an absence months
// out minted a live, future-dated disciplinary record. That is how a
// Termination effective 2026-10-17 ended up on a profile in July: the two
// "absences" behind it were 8/1 and 10/17, the exact dates of two PENDING
// unpaid-leave requests. Days the employee ASKED for off, logged as days she
// failed to show up.
//
// PR #1334 blocks new ones and stops existing ones counting toward the tiles
// and the ladder. It does NOT delete what is already in the tables — the
// discipline row still exists and still renders. That is this script's job.
//
// WHAT IT TOUCHES
//   1. employee_attendance_log rows with log_date > today (Central)
//   2. employee_discipline_log rows whose effective_date > today (Central)
//      AND whose reason carries the ladder's auto-generated marker
//      (`unexcused-occ` / `tardy-occ` / `unexcused-ladder`) — i.e. rows the
//      ENGINE wrote. A future-dated write-up entered by hand is left alone:
//      the office may legitimately post-date a document, and this script has
//      no business second-guessing that.
//
// Dry-run by default: SELECT only, prints exactly what it would remove.
// --apply performs the deletes inside ONE transaction. Idempotent.
//
// Usage (from the repo root, with .env holding DATABASE_URL):
//   node scripts/_future_attendance_cleanup.mjs
//   node scripts/_future_attendance_cleanup.mjs --apply
import pg from "pg";
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const ENV_PATH = process.env.QLENO_ENV ?? ".env";

const env = readFileSync(ENV_PATH, "utf8");
const line = env.split("\n").find((l) => l.startsWith("DATABASE_URL="));
if (!line) {
  console.error(`No DATABASE_URL in ${ENV_PATH}. Set QLENO_ENV to point at the right .env.`);
  process.exit(1);
}
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");

// Central calendar day — the same boundary the app now enforces on write.
// The UTC date is already tomorrow after 7 PM Central, which would make this
// script spare a row the app would reject.
const TODAY_CT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

console.log(`=== Future-dated attendance cleanup — ${APPLY ? "APPLY" : "DRY-RUN"} ===`);
console.log(`Central today: ${TODAY_CT}\n`);

const att = (await c.query(
  `SELECT a.id, a.company_id, a.employee_id,
          u.first_name || ' ' || u.last_name AS employee,
          a.log_date::text AS log_date, a.type, a.protected, a.notes
     FROM employee_attendance_log a
     JOIN users u ON u.id = a.employee_id
    WHERE a.log_date > $1
    ORDER BY a.log_date, a.employee_id`,
  [TODAY_CT],
)).rows;

const disc = (await c.query(
  `SELECT d.id, d.company_id, d.employee_id,
          u.first_name || ' ' || u.last_name AS employee,
          d.effective_date::text AS effective_date, d.discipline_type,
          d.custom_label, d.pending_review, d.dismissed, d.reason
     FROM employee_discipline_log d
     JOIN users u ON u.id = d.employee_id
    WHERE d.effective_date > $1
      AND (d.reason LIKE '%unexcused-occ%'
        OR d.reason LIKE '%tardy-occ%'
        OR d.reason LIKE '%unexcused-ladder%')
    ORDER BY d.effective_date, d.employee_id`,
  [TODAY_CT],
)).rows;

console.log(`Future-dated ATTENDANCE rows: ${att.length}`);
if (att.length) console.table(att);

console.log(`\nFuture-dated ENGINE-WRITTEN DISCIPLINE rows: ${disc.length}`);
if (disc.length) console.table(disc);

// Anything future-dated that was entered by hand — surfaced, never touched.
const manual = (await c.query(
  `SELECT d.id, u.first_name || ' ' || u.last_name AS employee,
          d.effective_date::text AS effective_date, d.discipline_type, d.reason
     FROM employee_discipline_log d
     JOIN users u ON u.id = d.employee_id
    WHERE d.effective_date > $1
      AND COALESCE(d.reason, '') NOT LIKE '%unexcused-occ%'
      AND COALESCE(d.reason, '') NOT LIKE '%tardy-occ%'
      AND COALESCE(d.reason, '') NOT LIKE '%unexcused-ladder%'
    ORDER BY d.effective_date`,
  [TODAY_CT],
)).rows;
if (manual.length) {
  console.log(`\nNOT TOUCHED — future-dated discipline with no engine marker (${manual.length}).`);
  console.log("Review these by hand; a deliberately post-dated write-up is legitimate.");
  console.table(manual);
}

if (!att.length && !disc.length) {
  console.log("\nNothing to clean.");
  await c.end();
  process.exit(0);
}

if (!APPLY) {
  console.log(`\nDRY-RUN — nothing written. Re-run with --apply to delete ${att.length} attendance + ${disc.length} discipline row(s).`);
  await c.end();
  process.exit(0);
}

try {
  await c.query("BEGIN");
  const d1 = await c.query(
    `DELETE FROM employee_discipline_log
      WHERE effective_date > $1
        AND (reason LIKE '%unexcused-occ%'
          OR reason LIKE '%tardy-occ%'
          OR reason LIKE '%unexcused-ladder%')`,
    [TODAY_CT],
  );
  // Attendance rows go second: the discipline rows are the thing they caused,
  // and deleting the cause first would leave the effect orphaned if this failed
  // partway. One transaction makes the ordering moot, but the intent is clearer.
  const d2 = await c.query(
    `DELETE FROM employee_attendance_log WHERE log_date > $1`,
    [TODAY_CT],
  );
  await c.query("COMMIT");
  console.log(`\nAPPLIED — deleted ${d1.rowCount} discipline row(s) and ${d2.rowCount} attendance row(s).`);
  console.log("Re-open the affected employee profiles to confirm the phantom records are gone.");
} catch (e) {
  await c.query("ROLLBACK");
  console.error("\nFAILED — rolled back, nothing changed.");
  console.error(e);
  process.exitCode = 1;
}
await c.end();
