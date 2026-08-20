// [customer-copy 2026-08-19] Rewrite the customer-facing notification copy on
// both branches (co1 Oak Lawn, co4 Schaumburg).
//
// Three things are being fixed at once, all in the same wording pass:
//
//  1. THE ARRIVAL PROMISE. Nothing in the app computes an arrival WINDOW for
//     the on-my-way message. routes/tech-clock.ts takes now + the live drive
//     time and formats ONE clock time, or the bare word "shortly" when there
//     are no coordinates to estimate from. The copy wrapped that in "arriving
//     during your {{appointment_window}} window", so customers were reading
//     "during your 9:35 AM window" and, with no GPS, "during your shortly
//     window". The sender now hands over a self-describing label ("around
//     9:35 AM" / "shortly") and the copy just says "will arrive {{...}}".
//
//  2. OAK LAWN'S ON-MY-WAY TEXT. It was the seven characters
//     " {{company_name}} is on the way" - leading space, no customer name, no
//     cleaner, no time, no phone number. Schaumburg's was a full sentence.
//     Sal: "oak lawn to my knowledge does not state a 2 hour window", and it
//     does not state anything else either. Both branches now send the same
//     sentence.
//
//  3. EM AND EN DASHES. Banned in every customer-facing Phes surface. These
//     are rewritten sentences, not comma swaps - a dash usually marks a place
//     where two sentences were welded together, so they get separated. The one
//     exception is the co1 booking SMS, where en dashes are BULLET MARKERS
//     rather than prose; those become hyphens.
//
// Canonical tag names are written in as well ({{tech_name}},
// {{arrival_window}}, {{company_phone}}), so the office reading a template
// sees the name the sender actually passes. The alias safety net in
// lib/customer-messages.ts stays for anything not touched here.
//
// Deliberately a one-off script, not a boot migration. A copy sweep that
// re-runs on every cold start would silently undo an edit the office makes in
// the app - the same failure mode that resurrected 55 deleted visits in the
// June-fill incident.
//
// Usage:  railway run node scripts/fix-customer-copy.mjs           (dry run)
//         railway run node scripts/fix-customer-copy.mjs --apply
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const COMPANIES = [1, 4];
const FIELDS = ["subject", "body", "body_html", "body_text"];

// find -> replace. `where` narrows to a trigger when a phrase is generic
// enough to appear elsewhere. Every rule must match something, or the script
// says so and refuses to apply: a rule that silently stops matching means the
// live copy drifted and the rewrite was never really made.
const RULES = [
  // ── 1. the arrival promise ────────────────────────────────────────────────
  {
    where: "on_my_way",
    find: "Hi {{first_name}}, {{technician_name}} from {{company_name}} is on the way — arriving during your {{appointment_window}} window. Questions? {{company_phone}}.",
    to: "Hi {{first_name}}, {{tech_name}} from {{company_name}} is on the way and will arrive {{arrival_window}}. Questions? Call {{company_phone}}.",
  },
  {
    where: "on_my_way",
    // The email card underneath already shows the time on its own line, so the
    // opening sentence does not need to describe it at all.
    find: "<strong>{{technician_name}}</strong> is on the way and will arrive during your scheduled window.",
    to: "<strong>{{tech_name}}</strong> is on the way to your home.",
  },
  { where: "on_my_way", find: "{{technician_name}}", to: "{{tech_name}}" },
  { where: "on_my_way", find: "{{appointment_window}}", to: "{{arrival_window}}" },
  {
    where: "on_my_way",
    // Oak Lawn's entire SMS. `exact` means the whole field must BE this, not
    // merely contain it: as a substring rule it also matched inside the
    // sentence the rule above had just written, and spliced a second copy of
    // the message into the middle of the first.
    exact: true,
    find: " {{company_name}} is on the way",
    to: "Hi {{first_name}}, {{tech_name}} from {{company_name}} is on the way and will arrive {{arrival_window}}. Questions? Call {{company_phone}}.",
  },

  // ── 2. dashes: rewritten sentences ────────────────────────────────────────
  { find: "thank you — please disregard this note.", to: "thank you. Please disregard this note." },
  { find: "Questions? {{company_phone}} — {{company_name}}.", to: "Questions? Call {{company_phone}}. Thank you, {{company_name}}." },
  { find: "Questions? Call us at {{office_phone}}. — Phes", to: "Questions? Call {{company_name}} at {{company_phone}}." },
  { find: "Your cleaning is complete — thank you, {{first_name}}", to: "Your cleaning is complete. Thank you, {{first_name}}" },
  { find: "we will make it right. Thank you — {{company_name}} {{company_phone}}.", to: "we will make it right. Thank you for choosing {{company_name}}. Questions? Call {{company_phone}}." },
  { find: "{{first_name}}, thank you for your booking with us! — {{appointment_date}}", to: "{{first_name}}, thank you for booking with us. You are confirmed for {{appointment_date}}" },
  { find: "notice to cancel or reschedule — Sundays don't count.", to: "notice to cancel or reschedule. Sundays do not count." },
  { find: "at {{appointment_time}} — {{service_type}} at {{service_address}}.", to: "at {{appointment_time}}. That is your {{service_type}} at {{service_address}}." },
  { find: "Questions? {{company_phone}}. — The {{company_name}} Team", to: "Questions? Call {{company_phone}}. The {{company_name}} Team" },
  { find: "Great news — your {{service_type}} is confirmed", to: "Great news. Your {{service_type}} is confirmed" },
  { find: "Your cleaning is confirmed — {{appointment_date}}", to: "Your cleaning is confirmed for {{appointment_date}}" },
  { find: "we do not offer refunds &mdash; the re-clean is our remedy.", to: "we do not offer refunds. The re-clean is our remedy." },
  { find: "We bring all supplies — you do not need to provide anything", to: "We bring all supplies. You do not need to provide anything" },
  { find: "One reschedule per appointment — additional reschedules are treated as cancellations", to: "One reschedule per appointment. Additional reschedules are treated as cancellations" },
  { find: "ignore this email — your password will not change.", to: "ignore this email. Your password will not change." },
  { find: "ignore this email — your password hasn't changed.", to: "ignore this email. Your password has not changed." },
  { find: "Payment confirmed — Thank you!", to: "Payment confirmed. Thank you!" },
  { find: "Your quote from {{company_name}} — #{{quote_number}}", to: "Quote #{{quote_number}} from {{company_name}}" },
  { find: "is ready — ${{quote_total}} estimated.", to: "is ready. Your estimated total is ${{quote_total}}." },
  { find: "Your cleaning is tomorrow — {{appointment_date}}", to: "Your cleaning is tomorrow, {{appointment_date}}" },
  { find: "Special instructions on file — if anything changed,", to: "Special instructions on file. If anything changed," },
  { find: "Your cleaning appointment is coming up — {{appointment_date}}", to: "Your cleaning appointment is coming up on {{appointment_date}}" },
  { find: "just a reminder — your {{service_type}} with Phes is coming up on {{appointment_date}}. Questions? Call us at {{office_phone}}.", to: "just a reminder that your {{service_type}} with {{company_name}} is coming up on {{appointment_date}}. Questions? Call {{company_phone}}." },
  { find: "Tap your answer below — that’s it.", to: "Tap your answer below. That is it." },
  { find: ">Thrilled — Great Work<", to: ">Thrilled with the work<" },
  { find: ">Happy — Good Work<", to: ">Happy with the work<" },
  { find: "{{review_link}} — means a lot to our team.", to: "{{review_link}}. It means a lot to our team." },
  { find: "please reach out before posting — we want the chance to make it right.", to: "please reach out before posting. We want the chance to make it right." },
  { find: "share your experience on Google — it means the world to our team", to: "share your experience on Google. It means the world to our team" },
  { find: "{{google_review_link}}. Thank you — Phes", to: "{{google_review_link}}. Thank you, {{company_name}}." },

  // ── 3. en dashes used as bullet markers, not prose ────────────────────────
  { where: "job_scheduled", find: "– We do not", to: "- We do not" },
  { where: "job_scheduled", find: "– Areas must be", to: "- Areas must be" },
  { where: "job_scheduled", find: "– For kitchen cabinets", to: "- For kitchen cabinets" },
  { where: "job_scheduled", find: "– If the home has", to: "- If the home has" },
];

const DASH = /(—|–|&mdash;|&ndash;)/;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query("BEGIN");
try {
  const { rows } = await c.query(
    `SELECT id, company_id, "trigger", channel, subject, body, body_html, body_text
       FROM notification_templates
      WHERE company_id = ANY($1::int[]) AND is_active
      ORDER BY "trigger", company_id, channel, id`,
    [COMPANIES],
  );

  const hits = new Map(RULES.map((r) => [r.find, 0]));
  let touched = 0;

  for (const row of rows) {
    const set = {};
    for (const f of FIELDS) {
      let v = row[f];
      if (v == null) continue;
      const before = v;
      for (const rule of RULES) {
        if (rule.where && row.trigger !== rule.where) continue;
        if (rule.exact) {
          if (v !== rule.find) continue;
          hits.set(rule.find, hits.get(rule.find) + 1);
          v = rule.to;
          continue;
        }
        if (!v.includes(rule.find)) continue;
        hits.set(rule.find, hits.get(rule.find) + v.split(rule.find).length - 1);
        v = v.split(rule.find).join(rule.to);
      }
      if (v !== before) set[f] = v;
    }
    if (!Object.keys(set).length) continue;
    touched++;

    // Which field does renderCustomerTemplate actually read? email prefers
    // body_html then body; sms prefers body_text then body. Anything else is
    // stored text a customer never sees, so label it - it changes how much a
    // given edit matters.
    const live = row.channel === "email" ? (row.body_html ? "body_html" : "body")
                                         : (row.body_text ? "body_text" : "body");
    console.log(`\n### id=${row.id} co${row.company_id} ${row.trigger}/${row.channel}`);
    for (const [f, after] of Object.entries(set)) {
      const seen = f === "subject" || f === live ? "customers see this" : "stored but not sent";
      console.log(`  ${f} (${seen}):`);
      const bl = String(row[f]).split("\n");
      const al = after.split("\n");
      for (let i = 0; i < Math.max(bl.length, al.length); i++) {
        if (bl[i] === al[i]) continue;
        if (bl[i] != null) console.log(`    -  ${bl[i].trim().slice(0, 300)}`);
        if (al[i] != null) console.log(`    +  ${al[i].trim().slice(0, 300)}`);
      }
    }
    const cols = Object.keys(set);
    await c.query(
      `UPDATE notification_templates SET ${cols.map((f, i) => `"${f}"=$${i + 1}`).join(",")} WHERE id=$${cols.length + 1}`,
      [...cols.map((f) => set[f]), row.id],
    );
  }

  console.log(`\n=== RULES THAT MATCHED NOTHING ===`);
  const dead = RULES.filter((r) => hits.get(r.find) === 0);
  dead.forEach((r) => console.log(`  ! ${JSON.stringify(r.find.slice(0, 90))}`));
  if (!dead.length) console.log("  none - every rewrite found its text");

  // The point of the pass: no dash may survive in anything a customer reads.
  const { rows: left } = await c.query(
    `SELECT id, company_id, "trigger", channel FROM notification_templates
      WHERE company_id = ANY($1::int[]) AND is_active
        AND (COALESCE(subject,'')
             || CASE WHEN channel='email' THEN COALESCE(NULLIF(body_html,''), COALESCE(body,''))
                     ELSE COALESCE(NULLIF(body_text,''), COALESCE(body,'')) END)
            ~ '(—|–|&mdash;|&ndash;)'`,
    [COMPANIES],
  );
  console.log(`\n=== DASHES LEFT IN WHAT CUSTOMERS ACTUALLY RECEIVE ===`);
  if (!left.length) console.log("  none");
  left.forEach((r) => console.log(`  ! id=${r.id} co${r.company_id} ${r.trigger}/${r.channel}`));

  console.log(`\n${touched} templates rewritten.`);
  if (APPLY && !dead.length && !left.length) {
    await c.query("COMMIT");
    console.log("APPLIED.");
  } else if (APPLY) {
    await c.query("ROLLBACK");
    console.log("REFUSED and rolled back: the live copy is not what this script expects.");
    process.exitCode = 1;
  } else {
    await c.query("ROLLBACK");
    console.log("DRY RUN - rolled back. Re-run with --apply to commit.");
  }
} catch (err) {
  await c.query("ROLLBACK");
  console.error("\nFAILED, rolled back:", err.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
