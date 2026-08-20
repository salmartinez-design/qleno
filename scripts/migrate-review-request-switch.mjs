// [message-switches 2026-08-20] Move the review ask onto its own on/off switch,
// and repair the Google review link, without changing a word a customer reads.
//
// Today the survey TEXT is built from two company columns rather than from the
// message template like every other message:
//   companies.survey_enabled          -> whether it sends at all
//   companies.survey_message_template -> what it says
// That is why the office could switch the survey "off" on the Customer Survey
// screen while the review EMAIL kept going out: two screens, one message.
//
// The code now renders the review_request/sms TEMPLATE and honors ITS is_active.
// This script carries the existing intent across so the switch-over is silent:
//   1. template body  <- companies.survey_message_template   (same wording)
//   2. template on/off <- companies.survey_enabled           (same tenants off)
// Without step 1 the text would change from the 0-4 rating ask, the thing that
// feeds the cleaner quality score, to the generic "leave a review" wording that
// happened to be sitting unused in the template row.
//
// It also repairs the Google review link. g.page/r/phes/review is dead, so the
// 44 customers who rated us 3 or 4 and tapped "Leave a Google review" on the
// survey page landed nowhere. Schaumburg had no link at all, so its happy
// customers were never shown the button. Both place ids verified by hand.
//
// Deliberately NOT a boot migration for the template copy: a sweep that
// rewrites template bodies on every cold start would silently undo the office's
// own edits. (The link repair IS also in the boot path, because it is a fixed
// correction to a dead URL rather than a copy the office owns.)
//
// Usage:  railway run node scripts/migrate-review-request-switch.mjs
//         railway run node scripts/migrate-review-request-switch.mjs --apply
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const BROKEN = "https://g.page/r/phes/review";
const LINKS = [
  { match: { col: "id", val: 1 }, label: "Phes (Oak Lawn)",
    url: "https://search.google.com/local/writereview?placeid=ChIJ_8FDx7U7DogRqE7Xx1IRDts" },
  { match: { col: "branch_key", val: "schaumburg" }, label: "Phes Schaumburg",
    url: "https://search.google.com/local/writereview?placeid=ChIJuScOpU_WT20RyUqIr1WHUGQ" },
];

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const log = (...a) => console.log(...a);
let changes = 0;

await c.query("BEGIN");
try {
  // ── 1. Google review link ──────────────────────────────────────────────────
  log("\n=== 1. GOOGLE REVIEW LINK ===");
  for (const l of LINKS) {
    const { rows } = await c.query(
      `SELECT id, name, review_link FROM companies WHERE ${l.match.col} = $1`,
      [l.match.val],
    );
    for (const co of rows) {
      const broken = !co.review_link || co.review_link === BROKEN;
      if (!broken) {
        log(`  = ${co.name}: already custom (${co.review_link}) - left alone`);
        continue;
      }
      await c.query(`UPDATE companies SET review_link = $1 WHERE id = $2`, [l.url, co.id]);
      log(`  ~ ${co.name}: ${co.review_link ?? "(none)"}\n      -> ${l.url}`);
      changes++;
    }
  }

  // ── 2. The wording, carried onto the template ──────────────────────────────
  // Both column names are read because the SMS renderer prefers body_text and
  // falls back to body; writing only one of them would leave the other stale.
  log("\n=== 2. REVIEW TEXT WORDING -> TEMPLATE ===");
  const { rows: cos } = await c.query(
    `SELECT id, name, survey_enabled, survey_message_template FROM companies ORDER BY id`);
  for (const co of cos) {
    const wording = (co.survey_message_template || "").trim();
    if (!wording) { log(`  - ${co.name}: no survey wording set, nothing to carry`); continue; }
    const { rows: tpl } = await c.query(
      `SELECT id, coalesce(body_text, body) AS current FROM notification_templates
        WHERE company_id = $1 AND trigger = 'review_request' AND channel = 'sms' LIMIT 1`,
      [co.id]);
    if (!tpl.length) { log(`  ! ${co.name}: no review_request/sms template row - skipped`); continue; }
    if ((tpl[0].current || "").trim() === wording) {
      log(`  = ${co.name}: template already matches the live wording`);
      continue;
    }
    await c.query(
      `UPDATE notification_templates SET body = $1, body_text = $1 WHERE id = $2`,
      [wording, tpl[0].id]);
    log(`  ~ ${co.name}:\n      was:  ${tpl[0].current}\n      now:  ${wording}`);
    changes++;
  }

  // ── 3. The on/off intent, carried onto the template ────────────────────────
  log("\n=== 3. SURVEY ON/OFF -> TEMPLATE SWITCH ===");
  for (const co of cos) {
    const want = co.survey_enabled === true;
    const { rows: tpl } = await c.query(
      `SELECT id, is_active FROM notification_templates
        WHERE company_id = $1 AND trigger = 'review_request' AND channel = 'sms' LIMIT 1`,
      [co.id]);
    if (!tpl.length) { log(`  ! ${co.name}: no review_request/sms template row - skipped`); continue; }
    if (tpl[0].is_active === want) {
      log(`  = ${co.name}: switch already ${want ? "ON" : "OFF"}`);
      continue;
    }
    await c.query(`UPDATE notification_templates SET is_active = $1 WHERE id = $2`, [want, tpl[0].id]);
    log(`  ~ ${co.name}: switch ${tpl[0].is_active ? "ON" : "OFF"} -> ${want ? "ON" : "OFF"}` +
        ` (matching survey_enabled)`);
    changes++;
  }

  // ── 4. What the customer will read afterwards ──────────────────────────────
  log("\n=== 4. RESULT: THE REVIEW ASK, PER TENANT ===");
  const { rows: after } = await c.query(
    `SELECT co.id, co.name, co.review_link,
            max(CASE WHEN t.channel='sms'   THEN t.is_active::text END) sms_on,
            max(CASE WHEN t.channel='email' THEN t.is_active::text END) email_on,
            max(CASE WHEN t.channel='sms'   THEN coalesce(t.body_text,t.body) END) sms_body
       FROM companies co
       LEFT JOIN notification_templates t
              ON t.company_id = co.id AND t.trigger = 'review_request'
      GROUP BY co.id, co.name, co.review_link ORDER BY co.id`);
  for (const r of after) {
    log(`\n  ${r.name} (#${r.id})`);
    log(`    text:  ${r.sms_on === "true" ? "ON" : "OFF"}   email: ${r.email_on === "true" ? "ON" : "OFF"}`);
    log(`    link:  ${r.review_link ?? "(none - happy customers see no Google button)"}`);
    log(`    text reads: ${r.sms_body ?? "(no template)"}`);
  }

  if (APPLY) {
    await c.query("COMMIT");
    log(`\nAPPLIED. ${changes} changes committed.`);
  } else {
    await c.query("ROLLBACK");
    log(`\nDRY RUN - rolled back. ${changes} changes would be made.`);
    log("Re-run with --apply to commit.");
  }
} catch (err) {
  await c.query("ROLLBACK");
  console.error("\nFAILED, rolled back:", err.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
