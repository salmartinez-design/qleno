// [branch-settings-sync 2026-08-19] Second half of making Schaumburg (co4) a
// replica of Oak Lawn (co1): the notification templates.
//
// This is not cosmetic. sendNotification has NO built-in fallback — when the
// template row is missing it logs "skipped" and returns false. Schaumburg had no
// portal_invite and no portal_password_reset row, so clicking "Invite to portal"
// on a Schaumburg customer sent nothing at all, and a Schaumburg customer
// clicking "forgot password" got no reset mail. Both are the transactional sends
// that deliberately bypass the comms gate precisely so they always arrive.
// (The five leave_request_* triggers degrade more gently — leave-notifications.ts
// falls back to built-in copy — but the office cannot EDIT what isn't there.)
//
// Bodies are copied verbatim. Verified beforehand that none of the seven carry a
// hardcoded phone, inbox or branch name; they are entirely {{merge_tag}} driven,
// so the wrapper fills in Schaumburg's own details at send time. A template with
// Oak Lawn's number baked in would undo the branch-stamp work.
//
// Never overwrites an existing co4 body — the office may have edited it. Missing
// rows are INSERTed; rows present on both only have is_active aligned.
//
// Usage:  railway run node scripts/sync-branch-templates.mjs           (dry run)
//         railway run node scripts/sync-branch-templates.mjs --apply
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const MASTER = 1;
const REPLICA = 4;

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

await c.query("BEGIN");
try {
  const { rows: missing } = await c.query(
    `SELECT a.trigger, a.channel, a.is_active
       FROM notification_templates a
      WHERE a.company_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM notification_templates b
           WHERE b.company_id = $2 AND b.trigger = a.trigger
             AND b.channel = a.channel
             AND b.service_type IS NOT DISTINCT FROM a.service_type)
      ORDER BY a.trigger, a.channel`,
    [MASTER, REPLICA],
  );

  console.log("\n=== TEMPLATES TO COPY TO SCHAUMBURG ===");
  for (const t of missing) console.log(`  + ${t.trigger} / ${t.channel}`);
  if (!missing.length) console.log("  none");

  const { rowCount: copied } = await c.query(
    `INSERT INTO notification_templates
       (company_id, trigger, channel, subject, body, body_html, body_text,
        is_active, service_type)
     SELECT $2, a.trigger, a.channel, a.subject, a.body, a.body_html, a.body_text,
            a.is_active, a.service_type
       FROM notification_templates a
      WHERE a.company_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM notification_templates b
           WHERE b.company_id = $2 AND b.trigger = a.trigger
             AND b.channel = a.channel
             AND b.service_type IS NOT DISTINCT FROM a.service_type)`,
    [MASTER, REPLICA],
  );

  // Present on both but switched on in one branch and off in the other.
  const { rows: flips } = await c.query(
    `SELECT b.id, b.trigger, b.channel, b.is_active AS was, a.is_active AS will
       FROM notification_templates a
       JOIN notification_templates b
         ON b.company_id = $2 AND b.trigger = a.trigger AND b.channel = a.channel
        AND b.service_type IS NOT DISTINCT FROM a.service_type
      WHERE a.company_id = $1 AND a.is_active IS DISTINCT FROM b.is_active
      ORDER BY b.trigger, b.channel`,
    [MASTER, REPLICA],
  );
  console.log("\n=== ON/OFF STATE TO ALIGN ===");
  for (const f of flips) {
    console.log(`  ~ ${f.trigger} / ${f.channel}: ${f.was ? "on" : "off"} -> ${f.will ? "on" : "off"}`);
    await c.query(`UPDATE notification_templates SET is_active=$1 WHERE id=$2`, [f.will, f.id]);
  }
  if (!flips.length) console.log("  none");

  // The two that were silently sending nothing. Prove they resolve now.
  const { rows: check } = await c.query(
    `SELECT trigger, (body_html IS NOT NULL AND length(body_html) > 0) AS has_body, is_active
       FROM notification_templates
      WHERE company_id = $1 AND channel = 'email' AND is_active
        AND trigger IN ('portal_invite','portal_password_reset')
      ORDER BY trigger`,
    [REPLICA],
  );
  console.log("\n=== THE TWO THAT WERE SENDING NOTHING ===");
  for (const r of check) {
    console.log(`  ${r.trigger}: active=${r.is_active} body=${r.has_body ? "present" : "EMPTY"}`);
  }
  if (check.length < 2) console.log("  STILL BROKEN - expected 2 rows, got " + check.length);

  const { rows: tally } = await c.query(
    `SELECT company_id, count(*)::int total,
            count(*) FILTER (WHERE is_active)::int active
       FROM notification_templates WHERE company_id IN ($1,$2)
      GROUP BY company_id ORDER BY company_id`,
    [MASTER, REPLICA],
  );
  console.log("\n=== FINAL TALLY ===");
  for (const t of tally) {
    console.log(`  ${t.company_id === MASTER ? "Oak Lawn  " : "Schaumburg"}: ${t.total} templates, ${t.active} active`);
  }

  if (APPLY) {
    await c.query("COMMIT");
    console.log(`\nAPPLIED. ${copied} copied, ${flips.length} realigned.`);
  } else {
    await c.query("ROLLBACK");
    console.log(`\nDRY RUN - rolled back. ${copied} would be copied, ${flips.length} realigned.`);
  }
} catch (err) {
  await c.query("ROLLBACK");
  console.error("\nFAILED, rolled back:", err.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
