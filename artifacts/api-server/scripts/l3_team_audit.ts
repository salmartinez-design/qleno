/**
 * L3 — team-name audit. READ-ONLY.
 * Scans mc_dispatch_staging.team_raw for every unique string, then tries to
 * match each against the known tech roster. Reports any unrecognized tokens.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Primary techs — longest first for greedy match
const TECHS: Array<{ name: string; userId: number }> = [
  { name: "Norma Guerrero Puga", userId: 32 }, // MC uses 3-word form, DB is "Norma Puga"
  { name: "Norma Puga", userId: 32 },          // fallback if short form appears
  { name: "Alejandra Cuervo", userId: 41 },
  { name: "Guadalupe Mejia", userId: 40 },
  { name: "Tatiana Merchan", userId: 33 },
  { name: "Juliana Loredo", userId: 42 },
  { name: "Diana Vasquez", userId: 38 },
  { name: "Delia Martinez", userId: -1 },       // placeholder — may not exist
  { name: "Rosa Gallegos", userId: 36 },
  { name: "Alma Salinas", userId: 39 },
  { name: "Juan Salazar", userId: 43 },
  { name: "Ana Valdez", userId: 34 },
];
const PLACEHOLDER = "Cleaner";

function parseTeam(raw: string | null): { ids: number[]; unparsed: string | null } {
  if (!raw) return { ids: [], unparsed: null };
  let remaining = raw.trim().replace(/\s+/g, " ");
  const ids: number[] = [];
  // Sort: primary techs first (longest name first), then placeholder
  const sortedNames = [...TECHS].sort((a, b) => b.name.length - a.name.length);
  while (remaining.length > 0) {
    let matched = false;
    for (const t of sortedNames) {
      if (remaining === t.name || remaining.startsWith(t.name + " ")) {
        if (t.userId > 0) ids.push(t.userId);
        remaining = remaining.slice(t.name.length).trim();
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (remaining === PLACEHOLDER || remaining.startsWith(PLACEHOLDER + " ")) {
        remaining = remaining.slice(PLACEHOLDER.length).trim();
        matched = true;
        continue;
      }
      return { ids, unparsed: remaining };
    }
  }
  return { ids, unparsed: null };
}

async function main() {
  // 1. Verify Delia Martinez — search in users
  const delia = await db.execute(sql`
    SELECT id, first_name, last_name, role, is_active, tags
      FROM users
     WHERE company_id = 1
       AND (LOWER(first_name) = 'delia' OR LOWER(last_name) = 'martinez')
     ORDER BY id
  `);
  console.log("=== Delia Martinez probe ===");
  console.table(delia.rows);

  // 2. Count rows by team_raw
  const rows = await db.execute(sql`
    SELECT team_raw, COUNT(*)::int AS n
      FROM mc_dispatch_staging
     GROUP BY team_raw
     ORDER BY n DESC
  `);
  const teams = rows.rows as any[];
  console.log(`\n=== Unique team_raw values: ${teams.length} ===`);

  // 3. Parse each one; collect success/failure
  const results: Array<{ team_raw: string | null; n: number; ids: number[]; unparsed: string | null; ok: boolean }> = [];
  for (const r of teams) {
    const p = parseTeam(r.team_raw);
    results.push({ team_raw: r.team_raw, n: r.n, ids: p.ids, unparsed: p.unparsed, ok: p.unparsed === null });
  }

  // 4. Report failures
  const failed = results.filter(r => !r.ok);
  console.log(`\n=== UNPARSED team_raw values (failures): ${failed.length} ===`);
  if (failed.length > 0) console.table(failed);

  // 5. Report success distribution
  const ok = results.filter(r => r.ok);
  const byCount: Record<number, number> = {};
  let totalRows = 0;
  for (const r of ok) {
    const k = r.ids.length;
    byCount[k] = (byCount[k] ?? 0) + r.n;
    totalRows += r.n;
  }
  console.log(`\n=== Parse success — ${ok.length} unique strings / ${totalRows} rows ===`);
  console.log("Distribution by tech count:", byCount);

  // 6. Sample of successes for spot-checking
  console.log("\n=== Top 30 parsed team_raw with rowcounts ===");
  console.table(ok.slice(0, 30).map(r => ({
    team_raw: r.team_raw,
    rows: r.n,
    techs: r.ids.join(","),
  })));

  // 7. Are there rows with team_raw = NULL or empty?
  const nullTeams = await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM mc_dispatch_staging
     WHERE team_raw IS NULL OR TRIM(team_raw) = ''
  `);
  console.log(`\nRows with NULL or empty team_raw: ${(nullTeams.rows?.[0] as any)?.n}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
