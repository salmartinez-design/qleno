import { Router } from "express";
import { db } from "@workspace/db";
import { employeeEfficiencyTable, usersTable } from "@workspace/db/schema";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { recomputeAllEfficiency } from "../lib/efficiency-engine.js";

const router = Router();

// MaidCentral service-type label → Qleno package name (quote_scopes /
// commercial_service_types). Imported MC efficiency lands in the matching Qleno
// slot. Labels NOT here are kept verbatim and reported as unmapped so the office
// can reconcile. "Hourly Tasks" has no Qleno package today (reported).
const MC_TO_QLENO: Record<string, string> = {
  "Deep Clean or Move In/Out": "Deep Clean or Move In/Out",
  "Commercial Cleaning": "Commercial Cleaning",
  "Multi-Unit Common Areas": "Common Areas",
  // MC emits this label with a comma; accept comma, slash, and no-punctuation forms.
  "One-Time, Flat-Rate Standard Cleaning": "One-Time Flat-Rate Standard Cleaning",
  "One-Time/Flat-Rate Standard Cleaning": "One-Time Flat-Rate Standard Cleaning",
  "One-Time Flat-Rate Standard Cleaning": "One-Time Flat-Rate Standard Cleaning",
  "PPM Common Areas": "PPM Common Areas",
  "PPM Turnover": "PPM Turnover",
  "Recurring Cleaning": "Recurring Cleaning",
};

// Pure-hourly packages have no time target, so efficiency is not meaningful —
// these MC labels are dropped entirely on import (not stored, not displayed).
const HOURLY_MC_LABELS = new Set<string>([
  "Hourly Deep Clean or Move In/Out",
  "Hourly Standard Cleaning",
  "Hourly Tasks",
]);

// The full Qleno package catalog efficiency is keyed to: active residential
// quote_scopes + active commercial_service_types, in a stable display order.
async function loadCatalog(companyId: number): Promise<string[]> {
  // Only packages with a TIME TARGET are scored. Residential quote_scopes that
  // are pure-hourly (no flat-rate budget) are excluded — their names are
  // prefixed "Hourly". Commercial service types are all allowed-hours budgeted.
  const res = await db.execute(sql`
    SELECT name, 0 AS grp, sort FROM (
      SELECT name, id AS sort FROM quote_scopes
       WHERE company_id = ${companyId} AND is_active = true
         AND name NOT ILIKE 'Hourly%'
    ) q
    UNION ALL
    SELECT name, 1 AS grp, id AS sort FROM commercial_service_types
     WHERE company_id = ${companyId} AND is_active = true
    ORDER BY grp, sort
  `);
  return (res.rows as any[]).map(r => r.name);
}

// GET /api/efficiency/:employee_id → { rows, catalog, avg_efficiency }
// rows = stored efficiency for this employee; catalog = every Qleno package so
// the UI can render a slot for each (data → %, none → no-data). avg over rows.
router.get("/:employee_id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const employeeId = parseInt(req.params.employee_id);
    if (isNaN(employeeId)) return res.status(400).json({ error: "Invalid employee_id" });

    const allRows = await db
      .select()
      .from(employeeEfficiencyTable)
      .where(and(
        eq(employeeEfficiencyTable.company_id, companyId),
        eq(employeeEfficiencyTable.employee_id, employeeId),
      ))
      .orderBy(desc(employeeEfficiencyTable.efficiency_pct));

    // One effective row per package, preferring live source='qleno' over the
    // imported 'mc' baseline (qleno wins regardless of value).
    const byPkg = new Map<string, any>();
    for (const r of allRows) {
      const ex = byPkg.get(r.service_type);
      if (!ex || (r.source === "qleno" && ex.source !== "qleno")) byPkg.set(r.service_type, r);
    }
    const rows = [...byPkg.values()];

    const catalog = await loadCatalog(companyId);
    const vals = rows.map(r => parseFloat(r.efficiency_pct)).filter(n => Number.isFinite(n) && n > 0);
    const avg_efficiency = vals.length ? Math.round((vals.reduce((s, n) => s + n, 0) / vals.length)) : null;

    return res.json({ rows, catalog, avg_efficiency });
  } catch (err) {
    console.error("Efficiency fetch error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to fetch efficiency" });
  }
});

// POST /api/efficiency/recompute (owner/admin) — backfill the live source='qleno'
// efficiency from every completed job (allowed vs actual clocked hours). Safe to
// re-run; leaves the imported source='mc' baseline untouched.
router.post("/recompute", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const result = await recomputeAllEfficiency(req.auth!.companyId!);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Efficiency recompute error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to recompute efficiency" });
  }
});

// POST /api/efficiency/import (owner/admin) — bulk-load per-employee, per-service
// efficiency from MaidCentral. Body:
//   { rows: [{ user_id?|email?|name?, service_type, efficiency_pct, period? }], replace? }
// - 0% / blank / non-numeric efficiency is treated as NO-DATA and skipped
//   (means "no jobs of that type in the window", not real 0%).
// - service_type is mapped MC→Qleno; unmapped labels are kept verbatim + reported.
router.post("/import", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { rows = [], replace = false } = req.body ?? {};

    const users = await db
      .select({ id: usersTable.id, email: usersTable.email, first_name: usersTable.first_name, last_name: usersTable.last_name })
      .from(usersTable)
      .where(eq(usersTable.company_id, companyId));
    const byId = new Map(users.map(u => [u.id, u]));
    const byEmail = new Map(users.filter(u => u.email).map(u => [u.email!.toLowerCase(), u]));
    const byName = new Map(users.map(u => [`${u.first_name} ${u.last_name}`.trim().toLowerCase(), u]));
    const resolve = (r: any): number | null => {
      if (r.user_id != null && byId.has(Number(r.user_id))) return Number(r.user_id);
      if (r.email && byEmail.has(String(r.email).toLowerCase())) return byEmail.get(String(r.email).toLowerCase())!.id;
      if (r.name && byName.has(String(r.name).trim().toLowerCase())) return byName.get(String(r.name).trim().toLowerCase())!.id;
      return null;
    };

    const unresolved: any[] = [];
    const unmapped_labels = new Set<string>();
    const touchedEmps = new Set<number>();
    let updated = 0, skipped_no_data = 0, dropped_hourly = 0;

    type Norm = { uid: number; service_type: string; pct: number; period: string };
    const norm: Norm[] = [];
    for (const r of rows) {
      const uid = resolve(r);
      if (uid == null) { unresolved.push({ ref: r.email ?? r.name ?? r.user_id, service_type: r.service_type }); continue; }
      const label = String(r.service_type ?? "").trim();
      if (!label) { skipped_no_data++; continue; }
      // Pure-hourly packages have no time target — drop entirely (not scored).
      if (HOURLY_MC_LABELS.has(label)) { dropped_hourly++; continue; }
      const pct = parseFloat(r.efficiency_pct);
      // No-data rule: 0 / blank / NaN → skip (not a real 0% efficiency).
      if (!Number.isFinite(pct) || pct <= 0) { skipped_no_data++; continue; }
      const qleno = MC_TO_QLENO[label];
      if (!qleno) unmapped_labels.add(label);
      // Normalize: MC sends a literal date-range string; the model only has one
      // window concept, so store it as 'all_time' (keeps the unique key stable).
      norm.push({ uid, service_type: qleno ?? label, pct, period: "all_time" });
      touchedEmps.add(uid);
    }

    if (replace && touchedEmps.size > 0) {
      await db.delete(employeeEfficiencyTable).where(and(
        eq(employeeEfficiencyTable.company_id, companyId),
        eq(employeeEfficiencyTable.source, "mc"),
        inArray(employeeEfficiencyTable.employee_id, [...touchedEmps]),
      ));
    }

    for (const n of norm) {
      await db.insert(employeeEfficiencyTable).values({
        company_id: companyId,
        employee_id: n.uid,
        service_type: n.service_type,
        efficiency_pct: String(n.pct),
        source: "mc",
        period: n.period,
      }).onConflictDoUpdate({
        target: [employeeEfficiencyTable.company_id, employeeEfficiencyTable.employee_id, employeeEfficiencyTable.service_type, employeeEfficiencyTable.period],
        set: { efficiency_pct: String(n.pct), source: "mc", updated_at: new Date() },
      });
      updated++;
    }

    return res.json({ ok: true, updated, skipped_no_data, dropped_hourly, unresolved, unmapped_labels: [...unmapped_labels] });
  } catch (err) {
    console.error("Efficiency import error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to import efficiency" });
  }
});

export default router;
