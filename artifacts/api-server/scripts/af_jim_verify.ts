/**
 * AF — Post-click verify for Jim Schultz's Apr 23 job (id=3695).
 * Run AFTER hitting "Mark Complete" → "Yes, complete" in the drawer.
 * Reports status transition, AF column writes, PDF generation, invoice
 * creation, and QB queue state.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== AF — Jim Schultz (job 3695) post-complete verify ===\n");

  console.log("--- 1. Jobs row ---");
  const job = await db.execute(sql`
    SELECT id, status,
           actual_end_time, locked_at, completed_by_user_id,
           completion_pdf_url IS NOT NULL AS has_pdf,
           completion_pdf_sent_at,
           billed_hours, billed_amount
      FROM jobs WHERE id = 3695
  `);
  console.table(job.rows);

  const row = (job.rows as any[])[0];
  const pass = row?.status === "complete"
            && row?.actual_end_time !== null
            && row?.locked_at !== null
            && row?.completed_by_user_id !== null;
  console.log(pass ? "\n✓ AF column writes PASS" : "\n✗ AF column writes FAIL (see row above)");

  console.log("\n--- 2. Who completed it (via completed_by_user_id → users) ---");
  const who = await db.execute(sql`
    SELECT u.id, u.first_name, u.last_name, u.email, u.role
      FROM jobs j JOIN users u ON u.id = j.completed_by_user_id
     WHERE j.id = 3695
  `);
  console.table(who.rows);

  console.log("\n--- 3. Invoice created from this job ---");
  const inv = await db.execute(sql`
    SELECT id, status, total, payment_terms, due_date, created_at
      FROM invoices WHERE job_id = 3695 AND company_id = 1
     ORDER BY created_at DESC
  `);
  if (inv.rows.length === 0) console.log("(no invoice row — invoice_error path hit)");
  else console.table(inv.rows);

  console.log("\n--- 4. QB sync queue (should be empty for PHES — qb_connected=false) ---");
  const q = await db.execute(sql`
    SELECT id, entity_type, entity_id, status, attempts, LEFT(COALESCE(last_error,''), 60) AS last_error, created_at
      FROM qb_sync_queue
     WHERE company_id = 1 AND entity_type = 'invoice'
     ORDER BY created_at DESC LIMIT 5
  `);
  if (q.rows.length === 0) console.log("(empty — expected; syncInvoice() no-op'd on null token)");
  else console.table(q.rows);

  console.log("\n--- 5. Drawer-read surface via /api/dispatch fields ---");
  // These are the fields the drawer uses to render locked state post-click.
  const drawer = await db.execute(sql`
    SELECT j.locked_at, j.actual_end_time, j.completed_by_user_id, j.status,
           (j.locked_at IS NOT NULL OR j.status IN ('complete','cancelled')) AS is_locked_per_drawer,
           to_char(j.actual_end_time AT TIME ZONE 'America/Chicago', 'Mon DD, HH:MI AM') AS completed_at_label
      FROM jobs j WHERE j.id = 3695
  `);
  console.table(drawer.rows);

  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
