/**
 * L3.1 — Create Delia Martinez as inactive tech + re-parse her 33 staging rows.
 *
 * D.2  INSERT users row for Delia (is_active=false, synthetic unloginable email)
 * D.3  Re-parse parsed_techs to include Delia's new user id on the 33 rows
 * D.4  Verify distribution
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

// Same tech roster as L3 plus Delia — sorted below by DESC name length.
// userId for Delia is filled in at runtime after the INSERT.
const TECH_ROSTER = (deliaId: number) => [
  { name: "Norma Guerrero Puga", userId: 32 },
  { name: "Alejandra Cuervo",    userId: 41 },
  { name: "Guadalupe Mejia",     userId: 40 },
  { name: "Tatiana Merchan",     userId: 33 },
  { name: "Delia Martinez",      userId: deliaId }, // <-- now populated
  { name: "Juliana Loredo",      userId: 42 },
  { name: "Diana Vasquez",       userId: 38 },
  { name: "Rosa Gallegos",       userId: 36 },
  { name: "Alma Salinas",        userId: 39 },
  { name: "Juan Salazar",        userId: 43 },
  { name: "Norma Puga",          userId: 32 }, // short form
  { name: "Ana Valdez",          userId: 34 },
];
const PLACEHOLDER = "Cleaner";

function parseTeam(raw: string | null, roster: Array<{ name: string; userId: number }>): { ids: number[]; unparsed: string | null } {
  if (!raw) return { ids: [], unparsed: null };
  let remaining = raw.trim().replace(/\s+/g, " ");
  const ids: number[] = [];
  const sorted = [...roster].sort((a, b) => b.name.length - a.name.length);
  while (remaining.length > 0) {
    let matched = false;
    for (const t of sorted) {
      if (remaining === t.name || remaining.startsWith(t.name + " ")) {
        if (t.userId > 0) ids.push(t.userId);
        remaining = remaining.slice(t.name.length).trim();
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (remaining === PLACEHOLDER || remaining.startsWith(PLACEHOLDER + " ")) {
      remaining = remaining.slice(PLACEHOLDER.length).trim();
      continue;
    }
    return { ids, unparsed: remaining };
  }
  return { ids, unparsed: null };
}

async function d2_insertDelia(): Promise<number> {
  console.log("=== D.2 — Insert Delia Martinez ===");

  // Guard: is she already present? Idempotent if someone re-runs.
  const existing = await db.execute(sql`
    SELECT id FROM users
     WHERE company_id = 1
       AND LOWER(first_name) = 'delia'
       AND LOWER(last_name) = 'martinez'
  `);
  if ((existing.rowCount ?? 0) > 0) {
    const id = Number((existing.rows?.[0] as any).id);
    console.log(`Delia already exists, id=${id}. Skipping INSERT.`);
    return id;
  }

  // Generate a 32-char hex placeholder like other imported users
  const placeholder = `IMPORT_PLACEHOLDER_${randomBytes(16).toString("hex")}`;
  const syntheticEmail = "delia.martinez.former@phes.internal";

  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      INSERT INTO users (
        company_id, email, password_hash, role,
        first_name, last_name, is_active, pay_type,
        notes, created_at
      ) VALUES (
        1,
        ${syntheticEmail},
        ${placeholder},
        'technician',
        'Delia', 'Martinez', false, 'hourly',
        '[mc_import_phase3 2026-04-22 former employee]',
        NOW()
      )
      RETURNING id, first_name, last_name, role, is_active, email, notes
    `);
    console.log("INSERT RETURNING:");
    console.table(res.rows);
    const newId = Number((res.rows?.[0] as any)?.id);
    if (!newId || newId <= 0) throw new Error("INSERT did not return a valid id");
    await db.execute(sql`COMMIT`);
    console.log(`Delia Martinez created with user id=${newId}`);
    return newId;
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.log("--- ROLLBACK ---");
    throw err;
  }
}

async function d3_reparseTechs(deliaId: number) {
  console.log(`\n=== D.3 — Re-parse staging rows with Delia id=${deliaId} ===`);

  const roster = TECH_ROSTER(deliaId);

  // Only need to update rows where team_raw contains Delia
  const deliaRows = await db.execute(sql`
    SELECT mc_job_id, team_raw, parsed_techs::text AS parsed_techs_before
      FROM mc_dispatch_staging
     WHERE team_raw ILIKE '%Delia%'
     ORDER BY mc_job_id
  `);
  console.log(`Rows containing 'Delia' in team_raw: ${deliaRows.rowCount} (expect 33)`);

  const updates: Array<{ mc_job_id: number; oldIds: number[]; newIds: number[]; team_raw: string }> = [];
  let unparsed = 0;
  for (const r of deliaRows.rows as any[]) {
    const p = parseTeam(r.team_raw, roster);
    if (p.unparsed !== null) {
      unparsed++;
      console.log(`UNPARSED mc_job_id=${r.mc_job_id} team_raw='${r.team_raw}' remaining='${p.unparsed}'`);
      continue;
    }
    const oldIds = JSON.parse(r.parsed_techs_before || "[]");
    updates.push({
      mc_job_id: Number(r.mc_job_id),
      oldIds,
      newIds: p.ids,
      team_raw: r.team_raw,
    });
  }
  if (unparsed > 0) throw new Error(`${unparsed} rows failed to re-parse`);

  // Spot a few before applying
  console.log("\nSample (first 10 updates):");
  console.table(updates.slice(0, 10).map(u => ({
    mc_job_id: u.mc_job_id,
    team_raw: u.team_raw,
    old: u.oldIds.join(","),
    new: u.newIds.join(","),
  })));

  // Apply updates
  await db.execute(sql`BEGIN`);
  try {
    let done = 0;
    for (const u of updates) {
      await db.execute(sql`
        UPDATE mc_dispatch_staging
           SET parsed_techs = ${JSON.stringify(u.newIds)}::jsonb
         WHERE mc_job_id = ${u.mc_job_id}
      `);
      done++;
    }
    console.log(`\nUPDATE rowcount: ${done} (expect ${updates.length})`);
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    throw err;
  }
}

async function d4_verify() {
  console.log("\n=== D.4 — Post-reparse verification ===");
  const dist = await db.execute(sql`
    SELECT JSONB_ARRAY_LENGTH(parsed_techs)::int AS tech_count,
           COUNT(*)::int AS rows
      FROM mc_dispatch_staging
     GROUP BY 1
     ORDER BY 1
  `);
  console.log("Updated tech-count distribution:");
  console.table(dist.rows);

  const totalAssignments = await db.execute(sql`
    SELECT SUM(JSONB_ARRAY_LENGTH(parsed_techs))::int AS total_assignments
      FROM mc_dispatch_staging
  `);
  console.log("Total tech assignments:", totalAssignments.rows);

  // Spot-check: sample Delia rows
  const sample = await db.execute(sql`
    SELECT mc_job_id, team_raw, parsed_techs
      FROM mc_dispatch_staging
     WHERE team_raw ILIKE '%Delia%'
     ORDER BY mc_job_id
     LIMIT 10
  `);
  console.log("\nSample Delia-team rows after re-parse:");
  console.table(sample.rows);

  // Confirm total still 983 and 0 unparsed
  const integrity = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(parsed_techs)::int AS with_techs,
           COUNT(*) FILTER (WHERE parsed_techs IS NULL)::int AS null_techs
      FROM mc_dispatch_staging
  `);
  console.log("\nIntegrity:");
  console.table(integrity.rows);

  // Coverage by row containing each tech id
  const deliaCoverage = await db.execute(sql`
    SELECT COUNT(*)::int AS delia_rows
      FROM mc_dispatch_staging
     WHERE parsed_techs @> (
       SELECT JSONB_BUILD_ARRAY(id) FROM users WHERE company_id=1 AND first_name='Delia' AND last_name='Martinez'
     )
  `);
  console.log("\nRows now assigned to Delia:");
  console.table(deliaCoverage.rows);
}

async function main() {
  console.log("=== L3.1 — Delia Martinez fix ===");
  const deliaId = await d2_insertDelia();
  await d3_reparseTechs(deliaId);
  await d4_verify();
  console.log("\nL3.1 complete.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
