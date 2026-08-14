/**
 * [combined-scope mixup 2026-08-14] Re-resolve service_type (and the missing
 * hourly fields) on jobs booked through the quote builder before the fix.
 *
 * Two defects wrote bad data, both in POST /api/quotes/:id/convert:
 *
 *  1. resolveServiceType tested the "move out" keywords BEFORE "deep", so any
 *     scope naming both — PHES has "Deep Clean or Move In/Out" and "Hourly Deep
 *     Clean or Move In/Out", neither in convert's strict table — always came
 *     back `move_out`. A Deep Clean booking was stamped move_out and the job
 *     card read "Move Out". That is the "quoting tool mixes up Move in/out with
 *     Deep Clean" the office kept reporting.
 *
 *  2. convert never wrote `billing_method`, and wrote `hourly_rate` only from
 *     the office's per-quote override — the scope's own pricing_method='hourly'
 *     and hourly_rate were dropped. So an hourly job carried no signal that it
 *     was hourly, and the card showed a bare flat total.
 *
 * The forward fixes stop new ones. This corrects the rows already written.
 *
 * `quotes.booked_job_id` is the link back from a job to the quote that booked
 * it, and the quote holds `scope_id` — so the original scope NAME is still
 * recoverable and each correction is derived, not guessed. Jobs with no booking
 * quote (manual entry, recurring engine, import) are left alone: there is no
 * scope name to re-resolve, and rewriting them would be invention.
 *
 * Deliberately NOT run at cold start. Rewriting service_type on historical jobs
 * changes what invoices and payroll describe; that should happen with a person
 * watching, once, not silently on every deploy.
 *
 * DRY RUN BY DEFAULT.
 *   pnpm tsx scripts/ai_service_type_backfill.ts           # preview
 *   pnpm tsx scripts/ai_service_type_backfill.ts --apply   # correct
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { resolveServiceType } from "../src/lib/serviceType.js";

// [DISARMED 2026-08-14] --apply alone is no longer enough. A full trace of every
// writer of jobs.service_type showed the premise this script rests on — that a
// scope's NAME determines the service type — is not sound at Phes:
//
//   * One live scope, "Hourly Deep Clean or Move In/Out", backs BOTH the Deep
//     Clean and the Move In/Out hourly sub-type buttons. Its name cannot tell
//     you which one the office picked. Any re-derivation is a coin flip.
//   * FOUR divergent hand-written name mappers exist (lib/serviceType.ts,
//     public.ts, edit-job-modal.tsx, recurring-jobs.ts) and they disagree with
//     each other on exactly these names.
//
// So a mass re-derive would not repair history; it would overwrite correct rows
// with a guess, at scale, with no undo. The DRY RUN is still genuinely useful —
// it shows which jobs disagree with their scope name, which is the evidence
// needed to decide anything — so previewing stays one command.
//
// Writing requires BOTH flags and a per-row review of the dry run first.
const APPLY = process.argv.includes("--apply") && process.argv.includes("--i-reviewed-every-row");

// Mirrors the strict table in routes/quotes.ts. Kept in sync by hand — it only
// exists to reproduce convert's exact decision, so a divergence here would make
// this script propose changes convert would not make.
const SCOPE_TO_ENUM: Record<string, string> = {
  "deep clean": "deep_clean",
  "standard clean": "standard_clean",
  "move in / move out": "move_out",
  "move in/move out": "move_out",
  "one-time standard clean": "standard_clean",
  "recurring cleaning": "recurring",
  "recurring cleaning - weekly": "recurring",
  "recurring cleaning - every 2 weeks": "recurring",
  "recurring cleaning - every 4 weeks": "recurring",
  "hourly deep clean": "deep_clean",
  "hourly standard cleaning": "standard_clean",
  "hourly move in / move out": "move_out",
  "hourly move in/move out": "move_out",
  "deep clean or move in/out": "deep_clean",
  "deep clean or move in / move out": "deep_clean",
  "hourly deep clean or move in/out": "deep_clean",
  "hourly deep clean or move in / move out": "deep_clean",
  "commercial cleaning": "office_cleaning",
  "ppm turnover": "ppm_turnover",
  "ppm common areas": "common_areas",
  "multi-unit common areas": "common_areas",
};

function expected(scopeName: string): string {
  const n = (scopeName || "").toLowerCase().trim();
  return SCOPE_TO_ENUM[n] || resolveServiceType(n);
}

async function main() {
  console.log(`=== quote-booked service_type / hourly backfill — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);

  const rows = (await db.execute(sql`
    SELECT j.id, j.company_id, j.scheduled_date::text AS scheduled_date, j.status,
           j.service_type::text AS service_type,
           j.billing_method::text AS billing_method,
           j.hourly_rate,
           ps.name           AS scope_name,
           ps.pricing_method AS scope_pricing_method,
           ps.hourly_rate    AS scope_hourly_rate,
           NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS client_name
      FROM quotes q
      JOIN jobs j            ON j.id = q.booked_job_id
      JOIN pricing_scopes ps ON ps.id = q.scope_id
      LEFT JOIN clients c    ON c.id = j.client_id
     WHERE q.booked_job_id IS NOT NULL
     ORDER BY j.scheduled_date DESC, j.id`) as any).rows;

  if (!rows.length) {
    console.log("No quote-booked jobs found. Nothing to do.");
    return;
  }
  console.log(`${rows.length} quote-booked job(s) examined.\n`);

  const typeFixes: any[] = [];
  const hourlyFixes: any[] = [];

  for (const r of rows) {
    const want = expected(String(r.scope_name ?? ""));
    if (want !== String(r.service_type)) {
      typeFixes.push({
        job: r.id, date: r.scheduled_date, client: r.client_name ?? "—",
        scope: r.scope_name, from: r.service_type, to: want,
      });
    }
    const scopeIsHourly = String(r.scope_pricing_method ?? "").toLowerCase() === "hourly";
    const scopeRate = parseFloat(String(r.scope_hourly_rate ?? "0"));
    const needsMethod = scopeIsHourly && r.billing_method !== "hourly";
    const needsRate = scopeIsHourly && r.hourly_rate == null && Number.isFinite(scopeRate) && scopeRate > 0;
    if (needsMethod || needsRate) {
      hourlyFixes.push({
        job: r.id, date: r.scheduled_date, client: r.client_name ?? "—",
        scope: r.scope_name,
        billing_method: needsMethod ? `${r.billing_method ?? "NULL"} → hourly` : "—",
        hourly_rate: needsRate ? `NULL → $${scopeRate.toFixed(2)}` : "—",
      });
    }
  }

  if (typeFixes.length) {
    console.log(`── service_type corrections (${typeFixes.length}) ──`);
    console.table(typeFixes);
    const byMove = typeFixes.filter(f => f.from === "move_out" && f.to === "deep_clean").length;
    console.log(`${byMove} of these are the Deep Clean booking that was stamped Move Out.\n`);
  } else {
    console.log("No service_type corrections needed.\n");
  }

  if (hourlyFixes.length) {
    console.log(`── hourly fields to populate (${hourlyFixes.length}) ──`);
    console.table(hourlyFixes);
    console.log("");
  } else {
    console.log("No hourly fields to populate.\n");
  }

  if (!typeFixes.length && !hourlyFixes.length) return;

  if (!APPLY) {
    console.log("DRY RUN — nothing written.");
    console.log("");
    console.log("READ THIS BEFORE WRITING ANYTHING:");
    console.log("  A scope's NAME does not reliably determine the service type here.");
    console.log("  \"Hourly Deep Clean or Move In/Out\" is ONE scope serving BOTH the");
    console.log("  Deep Clean and the Move In/Out buttons, so re-deriving from it is a");
    console.log("  coin flip — and four separate mappers in this codebase disagree on");
    console.log("  names like it. A row appearing above does NOT mean it is wrong.");
    console.log("");
    console.log("  Treat this table as EVIDENCE, not a work list. Check a few against");
    console.log("  what the office actually booked before trusting any of it.");
    console.log("");
    console.log("  To write anyway, after reviewing every row:");
    console.log("    --apply --i-reviewed-every-row");
    return;
  }

  let typed = 0;
  for (const f of typeFixes) {
    // service_type is a Postgres enum; the target always comes from the resolver
    // (a closed set), never from the scope name, so this cast is safe.
    await db.execute(sql`
      UPDATE jobs SET service_type = ${sql.raw(`'${f.to}'::service_type`)}
       WHERE id = ${Number(f.job)}`);
    typed++;
  }

  let hourlied = 0;
  for (const r of rows) {
    const scopeIsHourly = String(r.scope_pricing_method ?? "").toLowerCase() === "hourly";
    if (!scopeIsHourly) continue;
    const scopeRate = parseFloat(String(r.scope_hourly_rate ?? "0"));
    const rate = Number.isFinite(scopeRate) && scopeRate > 0 ? String(scopeRate) : null;
    const res = await db.execute(sql`
      UPDATE jobs
         SET billing_method = 'hourly'::billing_method,
             hourly_rate = COALESCE(hourly_rate, ${rate})
       WHERE id = ${Number(r.id)}
         AND (billing_method IS DISTINCT FROM 'hourly'::billing_method OR hourly_rate IS NULL)
      RETURNING id`);
    if (res.rows[0]) hourlied++;
  }

  console.log(`\nCorrected service_type on ${typed} job(s); populated hourly fields on ${hourlied}.`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
