import { Router } from "express";
import { db } from "@workspace/db";
import { employeeEfficiencyTable, usersTable } from "@workspace/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

// MaidCentral service-type label → Qleno package name (quote_scopes /
// commercial_service_types). Imported MC efficiency lands in the matching Qleno
// slot. Labels NOT here are kept verbatim and reported as unmapped so the office
// can reconcile. "Hourly Tasks" has no Qleno package today (reported).
const MC_TO_QLENO: Record<string, string> = {
  "Deep Clean or Move In/Out": "Deep Clean or Move In/Out",
  "Commercial Cleaning": "Commercial Cleaning",
  "Hourly Deep Clean or Move In/Out": "Hourly Deep Clean",
  "Hourly Standard Cleaning": "Hourly Standard Cleaning",
  "Multi-Unit Common Areas": "Common Areas",
  "One-Time/Flat-Rate Standard Cleaning": "One-Time Flat-Rate Standard Cleaning",
  "PPM Common Areas": "PPM Common Areas",
  "PPM Turnover": "PPM Turnover",
  "Recurring Cleaning": "Recurring Cleaning",
};

// The full Qleno package catalog efficiency is keyed to: active residential
// quote_scopes + active commercial_service_types, in a stable display order.
async function loadCatalog(companyId: number): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT name, 0 AS grp, sort FROM (
      SELECT name, id AS sort FROM quote_scopes
       WHERE company_id = ${companyId} AND is_active = true
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

    const rows = await db
      .select()
      .from(employeeEfficiencyTable)
      .where(and(
        eq(employeeEfficiencyTable.company_id, companyId),
        eq(employeeEfficiencyTable.employee_id, employeeId),
      ))
      .orderBy(desc(employeeEfficiencyTable.efficiency_pct));

    const catalog = await loadCatalog(companyId);
    const vals = rows.map(r => parseFloat(r.efficiency_pct)).filter(n => Number.isFinite(n) && n > 0);
    const avg_efficiency = vals.length ? Math.round((vals.reduce((s, n) => s + n, 0) / vals.length)) : null;

    return res.json({ rows, catalog, avg_efficiency });
  } catch (err) {
    console.error("Efficiency fetch error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to fetch efficiency" });
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
    let updated = 0, skipped_no_data = 0;

    type Norm = { uid: number; service_type: string; pct: number; period: string };
    const norm: Norm[] = [];
    for (const r of rows) {
      const uid = resolve(r);
      if (uid == null) { unresolved.push({ ref: r.email ?? r.name ?? r.user_id, service_type: r.service_type }); continue; }
      const pct = parseFloat(r.efficiency_pct);
      // No-data rule: 0 / blank / NaN → skip (not a real 0% efficiency).
      if (!Number.isFinite(pct) || pct <= 0) { skipped_no_data++; continue; }
      const label = String(r.service_type ?? "").trim();
      if (!label) { skipped_no_data++; continue; }
      const qleno = MC_TO_QLENO[label];
      if (!qleno) unmapped_labels.add(label);
      norm.push({ uid, service_type: qleno ?? label, pct, period: r.period ? String(r.period) : "all_time" });
      touchedEmps.add(uid);
    }

    if (replace && touchedEmps.size > 0) {
      await db.delete(employeeEfficiencyTable).where(and(
        eq(employeeEfficiencyTable.company_id, companyId),
        eq(employeeEfficiencyTable.source, "mc"),
        sql`${employeeEfficiencyTable.employee_id} = ANY(${[...touchedEmps]}::int[])`,
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

    return res.json({ ok: true, updated, skipped_no_data, unresolved, unmapped_labels: [...unmapped_labels] });
  } catch (err) {
    console.error("Efficiency import error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to import efficiency" });
  }
});

export default router;
