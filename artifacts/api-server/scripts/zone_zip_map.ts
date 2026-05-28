import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // Show active zones + their zip_codes — so I can verify proposed backfill zips
  // will resolve to colors.
  const zones = await db.execute(sql`
    SELECT name, color, zip_codes
      FROM service_zones
     WHERE company_id = 1 AND is_active = true
     ORDER BY name
  `);
  for (const z of zones.rows as any[]) {
    console.log(`${z.name} (${z.color}) → [${(z.zip_codes || []).join(", ")}]`);
  }

  // Cross-reference the specific zips I propose to backfill
  console.log("\n=== Zone match for proposed backfill zips ===");
  const proposed = [
    { id: 21, name: "Jaira Estrada", zip: "60608" },
    { id: 31, name: "Chicago Straford Memorial", zip: "60628" },
    { id: 37, name: "City Light Church", zip: "60653" },
    { id: 40, name: "Heritage Condominium", zip: "60453" },
    { id: 66, name: "Hickory Hills Condominium", zip: "60457" },
    { id: 110, name: "John Piscopo", zip: "60707" },
    { id: 1052, name: "Danni Varenhorst", zip: "60608" },
  ];
  for (const p of proposed) {
    const z = await db.execute(sql`
      SELECT name, color FROM service_zones
       WHERE company_id = 1 AND is_active = true
         AND ${p.zip} = ANY(zip_codes)
       LIMIT 1
    `);
    const hit = z.rows?.[0] as any;
    console.log(`${p.name} (id=${p.id}) zip=${p.zip} → ${hit ? `${hit.name} (${hit.color})` : "NO ZONE MATCH"}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
