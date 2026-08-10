/**
 * [quote-notes-durable 2026-08-09] One-time backfill for quotes that were
 * already converted BEFORE the convert path started saving these two fields.
 *
 * Going forward, POST /quotes/:id/convert writes both. This catches history:
 *   quotes.call_notes  -> clients.office_notes      (append, office-only)
 *   quotes.unit_suite  -> clients.home_access_notes (prepend, tech-visible)
 *
 * Both writes are guarded by a POSITION() containment check, so running this
 * twice is a no-op. Only quotes with status 'booked'/'converted' and a resolved
 * client_id are considered.
 *
 * Run this AFTER the deploy that adds clients.office_notes (the boot migration
 * in phes-data-migration.ts) — otherwise the SELECT 42703s on a missing column.
 *
 * Dry run (default, read-only):
 *   ./artifacts/api-server/node_modules/.bin/tsx --env-file=.env \
 *     artifacts/api-server/scripts/backfill_quote_notes_to_clients.ts
 * Apply:
 *   ... backfill_quote_notes_to_clients.ts --apply
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

async function main() {
  const candidates = await db.execute(sql`
    SELECT q.id AS quote_id, q.client_id, q.status,
           btrim(COALESCE(q.call_notes, '')) AS call_notes,
           btrim(COALESCE(q.unit_suite, '')) AS unit_suite,
           c.company_id,
           COALESCE(c.office_notes, '')      AS cur_office_notes,
           COALESCE(c.home_access_notes, '') AS cur_access_notes,
           c.first_name, c.last_name
      FROM quotes q
      JOIN clients c ON c.id = q.client_id AND c.company_id = q.company_id
     WHERE q.client_id IS NOT NULL
       AND q.status IN ('booked', 'converted')
       AND (btrim(COALESCE(q.call_notes, '')) <> '' OR btrim(COALESCE(q.unit_suite, '')) <> '')
     ORDER BY q.id`);

  let notesToWrite = 0;
  let unitsToWrite = 0;

  for (const r of candidates.rows as any[]) {
    const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
    const callNotes = String(r.call_notes || "");
    const unit = String(r.unit_suite || "");
    const unitLine = unit ? `Unit / Suite: ${unit}` : "";

    const needsNote = callNotes && !String(r.cur_office_notes).includes(callNotes);
    const needsUnit = unitLine && !String(r.cur_access_notes).includes(unitLine);
    if (!needsNote && !needsUnit) continue;

    console.log(
      `quote ${r.quote_id} -> client ${r.client_id} (${name})` +
        (needsNote ? `\n    office_notes  += ${JSON.stringify(callNotes.slice(0, 90))}` : "") +
        (needsUnit ? `\n    access_notes  ^= ${JSON.stringify(unitLine)}` : ""),
    );

    if (needsNote) notesToWrite++;
    if (needsUnit) unitsToWrite++;

    if (!APPLY) continue;

    if (needsNote) {
      await db.execute(sql`
        UPDATE clients
           SET office_notes = CASE
                 WHEN COALESCE(NULLIF(btrim(office_notes), ''), '') = '' THEN ${callNotes}
                 ELSE office_notes || E'\n\n' || ${callNotes}
               END,
               office_notes_updated_at = NOW()
         WHERE id = ${r.client_id} AND company_id = ${r.company_id}
           AND POSITION(${callNotes} IN COALESCE(office_notes, '')) = 0`);
    }
    if (needsUnit) {
      await db.execute(sql`
        UPDATE clients
           SET home_access_notes = CASE
                 WHEN COALESCE(NULLIF(btrim(home_access_notes), ''), '') = '' THEN ${unitLine}
                 ELSE ${unitLine} || E'\n' || home_access_notes
               END
         WHERE id = ${r.client_id} AND company_id = ${r.company_id}
           AND POSITION(${unitLine} IN COALESCE(home_access_notes, '')) = 0`);
    }
  }

  console.log(
    `\n${APPLY ? "APPLIED" : "DRY RUN"} — ${candidates.rows.length} converted quote(s) carry one of these fields; ` +
      `${notesToWrite} call-note append(s), ${unitsToWrite} unit-line prepend(s).`,
  );
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
