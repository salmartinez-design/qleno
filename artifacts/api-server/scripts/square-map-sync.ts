// [square-map 2026-07-22] Build / refresh the Square ↔ Qleno customer map.
//
// Usage:
//   npx tsx --env-file=.env artifacts/api-server/scripts/square-map-sync.ts --company=1 --dry-run
//   npx tsx --env-file=.env artifacts/api-server/scripts/square-map-sync.ts --company=1 --apply
//
// READ-ONLY against Square (GET customers + cards). Never charges a card,
// never merges Square records, never touches QuickBooks. --dry-run computes
// and prints the full plan without writing a single row.
import { syncSquareCustomerMap, type MapRow } from "../src/lib/square-customer-map.js";

const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.split("=")[1];
const has = (k: string) => process.argv.includes(`--${k}`);

const companyId = Number(arg("company") ?? 1);
const dryRun = !has("apply");

async function main() {
  console.log(`\nSquare ↔ Qleno customer map — company ${companyId} — ${dryRun ? "DRY RUN (no writes)" : "APPLY (writing)"}\n`);
  const { summary, rows } = await syncSquareCustomerMap({ companyId, dryRun });

  console.log("── Square side ─────────────────────────────");
  console.log(`  customers pulled     : ${summary.squareCustomers}`);
  console.log(`  cards on file pulled : ${summary.squareCards}`);
  console.log(`  records with a card  : ${summary.withCardOnFile}`);

  console.log("\n── Match outcome ───────────────────────────");
  console.log(`  auto-mapped (linked) : ${summary.linked}`);
  console.log(`  needs review         : ${summary.needsReview}`);
  console.log(`  unmatched            : ${summary.unmatched}`);
  console.log(`  email mismatches     : ${summary.emailMismatches} (linked, but the two systems disagree on email)`);
  console.log("\n  by match method:");
  for (const [m, n] of Object.entries(summary.byMethod).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${m.padEnd(18)} ${n}`);
  }

  if (!dryRun) {
    console.log("\n── Mirrored onto Qleno records (NULLs only) ─");
    console.log(`  clients.square_customer_id  : +${summary.mirroredToClients}`);
    console.log(`  accounts.square_customer_id : +${summary.mirroredToAccounts}`);
  }

  console.log("\n── Qleno accounts with NO Square link ──────");
  if (!summary.unmatchedQlenoAccounts.length) console.log("  (none)");
  for (const a of summary.unmatchedQlenoAccounts) console.log(`  acct#${a.id}  ${a.name}`);
  console.log(`\n  active Qleno clients with no Square link: ${summary.unmatchedActiveClients}`);

  const review = rows.filter((r: MapRow) => r.status === "needs_review");
  console.log(`\n── Needs Review (${review.length}) ──────────────────────`);
  for (const r of review.slice(0, 60)) {
    console.log(`  ${(r.square_customer_name ?? "(no name)").slice(0, 38).padEnd(38)} ${(r.square_email ?? "-").slice(0, 30).padEnd(30)} ${r.review_reason}`);
  }
  if (review.length > 60) console.log(`  ... and ${review.length - 60} more`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
