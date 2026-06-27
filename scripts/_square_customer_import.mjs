/**
 * Square Customer ID Import
 * Fetches all Square customers, matches to Qleno clients by email then phone,
 * writes square_customer_id + card details back to the clients table.
 * Safe to re-run — only updates rows where square_customer_id IS NULL.
 */

import pg from "pg";
import { readFileSync } from "fs";

const { Client } = pg;
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.argv.includes("--dry-run");

if (!SQUARE_TOKEN) { console.error("SQUARE_ACCESS_TOKEN not set"); process.exit(1); }
if (!DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

// ── 1. Fetch all Square customers (paginated) ──────────────────────────────
async function fetchAllSquareCustomers() {
  const customers = [];
  let cursor = null;
  do {
    const url = new URL("https://connect.squareup.com/v2/customers");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), {
      headers: {
        "Square-Version": "2024-01-17",
        "Authorization": `Bearer ${SQUARE_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    const data = await res.json();
    if (data.errors) { console.error("Square API error:", data.errors); process.exit(1); }
    customers.push(...(data.customers || []));
    cursor = data.cursor || null;
    console.log(`  Fetched ${customers.length} customers so far...`);
  } while (cursor);
  return customers;
}

// ── 2. Normalise phone to digits only ─────────────────────────────────────
function normalisePhone(p) {
  return (p || "").replace(/\D/g, "").replace(/^1/, ""); // strip country code
}

// ── Main ───────────────────────────────────────────────────────────────────
const db = new Client({ connectionString: DATABASE_URL });
await db.connect();

console.log(`\n[square-import] Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
console.log("[square-import] Fetching Square customers...");
const squareCustomers = await fetchAllSquareCustomers();
console.log(`[square-import] ${squareCustomers.length} Square customers fetched`);

// Build lookup maps
const byEmail = new Map();
const byPhone = new Map();
for (const c of squareCustomers) {
  if (c.email_address) byEmail.set(c.email_address.toLowerCase().trim(), c);
  const phone = normalisePhone(c.phone_number);
  if (phone.length >= 10) byPhone.set(phone, c);
}

// Fetch Qleno clients that don't yet have a square_customer_id (company 1 = Phes)
const { rows: clients } = await db.query(`
  SELECT id, email, phone, first_name, last_name, square_customer_id
  FROM clients
  WHERE company_id = 1
    AND square_customer_id IS NULL
    AND (email IS NOT NULL OR phone IS NOT NULL)
  ORDER BY id
`);
console.log(`[square-import] ${clients.length} Qleno clients without square_customer_id`);

let matched = 0, skipped = 0, noCard = 0;

for (const client of clients) {
  const email = (client.email || "").toLowerCase().trim();
  const phone = normalisePhone(client.phone);

  // Match by email first, then phone
  let sq = byEmail.get(email) || byPhone.get(phone);
  if (!sq) { skipped++; continue; }

  // Grab first enabled card
  const card = (sq.cards || []).find(c => c.enabled !== false) || (sq.cards || [])[0];

  console.log(`  MATCH: ${client.first_name} ${client.last_name} → Square ${sq.id}${card ? ` (${card.card_brand} ••••${card.last_4})` : " (no card)"}`);
  if (!card) noCard++;

  if (!DRY_RUN) {
    await db.query(`
      UPDATE clients SET
        square_customer_id = $1,
        square_card_brand  = $2,
        square_card_last4  = $3,
        square_card_exp    = $4
      WHERE id = $5
    `, [
      sq.id,
      card?.card_brand?.toLowerCase() || null,
      card?.last_4 || null,
      card ? `${card.exp_month}/${card.exp_year}` : null,
      client.id,
    ]).catch(async (err) => {
      // Columns may not exist yet — add them first
      if (err.message.includes("column") && err.message.includes("does not exist")) {
        console.log("  Adding square card columns to clients table...");
        await db.query(`
          ALTER TABLE clients
            ADD COLUMN IF NOT EXISTS square_customer_id text,
            ADD COLUMN IF NOT EXISTS square_card_brand  text,
            ADD COLUMN IF NOT EXISTS square_card_last4  text,
            ADD COLUMN IF NOT EXISTS square_card_exp    text
        `);
        await db.query(`
          UPDATE clients SET
            square_customer_id = $1,
            square_card_brand  = $2,
            square_card_last4  = $3,
            square_card_exp    = $4
          WHERE id = $5
        `, [sq.id, card?.card_brand?.toLowerCase() || null, card?.last_4 || null,
            card ? `${card.exp_month}/${card.exp_year}` : null, client.id]);
      } else throw err;
    });
  }
  matched++;
}

console.log(`\n[square-import] Done.`);
console.log(`  Matched:   ${matched}`);
console.log(`  No card:   ${noCard}`);
console.log(`  No match:  ${skipped}`);
if (DRY_RUN) console.log("\n  [DRY RUN — no changes written. Remove --dry-run to apply]");

await db.end();
