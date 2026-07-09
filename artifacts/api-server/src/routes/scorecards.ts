import { Router } from "express";
import { db } from "@workspace/db";
import { scorecardsTable, scorecardEntriesTable, usersTable, clientsTable } from "@workspace/db/schema";
import { eq, and, avg, count, desc, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { resolveWindow } from "../lib/report-periods.js";
import { recomputeAllScorecards, recomputeEmployeeScorecard } from "../lib/scorecard-engine.js";
import { computeCompositeForEmployee, recomputeAllComposites } from "../lib/scorecard-composite.js";

const router = Router();

// GET /api/scorecards/report — time-bucketed scorecard over a window.
//   ?scope=employee|company &period=rolling_90d|month|quarter|year|custom
//   &date= (anchor) &from=&to= (custom) &employee_id= (employee scope)
// MC formula: score % = unweighted MEAN of non-excluded 0–4 responses ÷ max ×100.
// Company = unweighted mean of ALL responses (entry-level — NOT avg of tech
// averages). Computed from live source='qleno' dated entries.
router.get("/report", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const scope = req.query.scope === "company" ? "company" : "employee";
    const win = resolveWindow(String(req.query.period ?? "rolling_90d"), {
      anchor: req.query.date, from: req.query.from, to: req.query.to,
    });
    // Column-qualified WHERE so the company byTech JOIN (users also has
    // company_id) isn't ambiguous. `a` is a literal alias prefix we control.
    const cond = (a: string) => sql`${sql.raw(a)}source = 'qleno' AND ${sql.raw(a)}excluded = false
      AND ${sql.raw(a)}company_id = ${companyId}
      AND ${sql.raw(a)}entry_date >= ${win.from} AND ${sql.raw(a)}entry_date <= ${win.to}`;

    if (scope === "employee") {
      const employeeId = parseInt(String(req.query.employee_id ?? ""));
      if (isNaN(employeeId)) return res.status(400).json({ error: "employee_id required for scope=employee" });
      const r = await db.execute(sql`
        SELECT ROUND(AVG(score_value / NULLIF(max_value, 0)) * 100, 2) AS score_pct, COUNT(*)::int AS responses
          FROM scorecard_entries WHERE ${cond("")} AND employee_id = ${employeeId}`);
      const row: any = r.rows[0] ?? {};
      // [90d-composite] Persisted composite columns so the report can show the
      // displayed headline next to the satisfaction-only score_pct.
      const cr = await db.execute(sql`
        SELECT scorecard_composite_90d, score_satisfaction_90d, score_attendance_90d, score_complaint_free_90d
          FROM users WHERE id = ${employeeId} AND company_id = ${companyId} LIMIT 1`);
      const c: any = cr.rows[0] ?? {};
      return res.json({
        scope, employee_id: employeeId, window: win,
        score_pct: row.score_pct != null ? parseFloat(row.score_pct) : null,
        responses: Number(row.responses ?? 0),
        composite_pct: c.scorecard_composite_90d != null ? parseFloat(c.scorecard_composite_90d) : null,
        satisfaction_pct: c.score_satisfaction_90d != null ? parseFloat(c.score_satisfaction_90d) : null,
        attendance_pct: c.score_attendance_90d != null ? parseFloat(c.score_attendance_90d) : null,
        complaint_free_pct: c.score_complaint_free_90d != null ? parseFloat(c.score_complaint_free_90d) : null,
      });
    }

    // Company: overall (unweighted mean of all responses) + per-tech breakdown.
    const overall = await db.execute(sql`
      SELECT ROUND(AVG(score_value / NULLIF(max_value, 0)) * 100, 2) AS score_pct, COUNT(*)::int AS responses
        FROM scorecard_entries WHERE ${cond("")}`);
    const byTech = await db.execute(sql`
      SELECT e.employee_id, (u.first_name || ' ' || u.last_name) AS name,
             ROUND(AVG(e.score_value / NULLIF(e.max_value, 0)) * 100, 2) AS score_pct, COUNT(*)::int AS responses,
             u.scorecard_composite_90d AS composite_pct
        FROM scorecard_entries e LEFT JOIN users u ON u.id = e.employee_id
       WHERE ${cond("e.")} GROUP BY e.employee_id, u.first_name, u.last_name, u.scorecard_composite_90d
       ORDER BY score_pct DESC NULLS LAST`);
    const o: any = overall.rows[0] ?? {};
    return res.json({
      scope: "company", window: win,
      score_pct: o.score_pct != null ? parseFloat(o.score_pct) : null,
      responses: Number(o.responses ?? 0),
      employees: (byTech.rows as any[]).map(r => ({ employee_id: r.employee_id, name: r.name, score_pct: r.score_pct != null ? parseFloat(r.score_pct) : null, responses: Number(r.responses), composite_pct: r.composite_pct != null ? parseFloat(r.composite_pct) : null })),
    });
  } catch (err) {
    console.error("Scorecard report error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to build scorecard report" });
  }
});

// PATCH /api/scorecards/entries/:id/exclude { excluded } — office "Exclude from
// employee" action; recomputes the affected tech's headline.
router.patch("/entries/:id/exclude", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const excluded = req.body?.excluded !== false;
    const [row] = await db.update(scorecardEntriesTable)
      .set({ excluded })
      .where(and(eq(scorecardEntriesTable.id, id), eq(scorecardEntriesTable.company_id, companyId)))
      .returning({ employee_id: scorecardEntriesTable.employee_id });
    if (!row) return res.status(404).json({ error: "Entry not found" });
    await recomputeEmployeeScorecard(companyId, row.employee_id);
    return res.json({ ok: true, excluded, employee_id: row.employee_id });
  } catch (err) {
    console.error("Scorecard exclude error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to update entry" });
  }
});

// POST /api/scorecards/recompute — backfill qleno scorecard headlines from
// non-excluded survey responses. MC baseline preserved.
router.post("/recompute", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const result = await recomputeAllScorecards(req.auth!.companyId!);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Scorecard recompute error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to recompute scorecards" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const { user_id, client_id } = req.query;
    const conditions: any[] = [eq(scorecardsTable.company_id, req.auth!.companyId)];
    if (user_id) conditions.push(eq(scorecardsTable.user_id, parseInt(user_id as string)));
    if (client_id) conditions.push(eq(scorecardsTable.client_id, parseInt(client_id as string)));

    const scorecards = await db
      .select({
        id: scorecardsTable.id,
        job_id: scorecardsTable.job_id,
        user_id: scorecardsTable.user_id,
        user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        client_id: scorecardsTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        score: scorecardsTable.score,
        comments: scorecardsTable.comments,
        excluded: scorecardsTable.excluded,
        created_at: scorecardsTable.created_at,
      })
      .from(scorecardsTable)
      .leftJoin(usersTable, eq(scorecardsTable.user_id, usersTable.id))
      .leftJoin(clientsTable, eq(scorecardsTable.client_id, clientsTable.id))
      .where(and(...conditions))
      .orderBy(desc(scorecardsTable.created_at));

    const avgResult = await db
      .select({ avg: avg(scorecardsTable.score) })
      .from(scorecardsTable)
      .where(and(...conditions, eq(scorecardsTable.excluded, false)));

    return res.json({
      data: scorecards,
      total: scorecards.length,
      average_score: avgResult[0].avg ? parseFloat(avgResult[0].avg) : null,
    });
  } catch (err) {
    console.error("List scorecards error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list scorecards" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const { job_id, user_id, client_id, score, comments, excluded = false } = req.body;

    const newScorecard = await db
      .insert(scorecardsTable)
      .values({
        company_id: req.auth!.companyId,
        job_id,
        user_id,
        client_id,
        score,
        comments,
        excluded,
      })
      .returning();

    const user = await db
      .select({ first_name: usersTable.first_name, last_name: usersTable.last_name })
      .from(usersTable)
      .where(eq(usersTable.id, user_id))
      .limit(1);

    const client = await db
      .select({ first_name: clientsTable.first_name, last_name: clientsTable.last_name })
      .from(clientsTable)
      .where(eq(clientsTable.id, client_id))
      .limit(1);

    return res.status(201).json({
      ...newScorecard[0],
      user_name: `${user[0]?.first_name || ""} ${user[0]?.last_name || ""}`.trim(),
      client_name: `${client[0]?.first_name || ""} ${client[0]?.last_name || ""}`.trim(),
    });
  } catch (err) {
    console.error("Create scorecard error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to create scorecard" });
  }
});

// Per-employee scorecard detail: the authoritative % + the per-job history
// rows (scorecard_entries) for the employee profile Scorecards tab.
router.get("/entries/:employee_id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const employeeId = parseInt(req.params.employee_id);
    if (isNaN(employeeId)) return res.status(400).json({ error: "Invalid employee_id" });

    const [emp] = await db
      .select({ scorecard_pct: usersTable.scorecard_pct })
      .from(usersTable)
      .where(and(eq(usersTable.id, employeeId), eq(usersTable.company_id, companyId)))
      .limit(1);

    const entries = await db
      .select()
      .from(scorecardEntriesTable)
      .where(and(
        eq(scorecardEntriesTable.company_id, companyId),
        eq(scorecardEntriesTable.employee_id, employeeId),
      ))
      .orderBy(desc(scorecardEntriesTable.entry_date));

    return res.json({ scorecard_pct: emp?.scorecard_pct ?? null, entries });
  } catch (err) {
    console.error("Scorecard entries error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to fetch scorecard entries" });
  }
});

// [90d-composite] Live 90-day rolling composite for one tech: the three
// sub-scores (satisfaction / attendance / complaint-free), the blended
// composite (the displayed headline), the per-tenant weights, the window, and
// the underlying counts for drill-down on the employee profile. Computed fresh
// (not just the persisted snapshot) so the profile always reflects "as of now".
router.get("/composite/:employee_id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const employeeId = parseInt(req.params.employee_id);
    if (isNaN(employeeId)) return res.status(400).json({ error: "Invalid employee_id" });
    const result = await computeCompositeForEmployee(companyId, employeeId);
    return res.json(result);
  } catch (err) {
    console.error("Scorecard composite error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to compute composite" });
  }
});

// [90d-composite] Office backfill — recompute + persist every tech's composite.
router.post("/recompute-composite", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const result = await recomputeAllComposites(req.auth!.companyId!);
    return res.json(result);
  } catch (err) {
    console.error("Scorecard recompute-composite error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to recompute composites" });
  }
});

// [GAP3] Office/owner reply to the customer's feedback on a scorecard entry.
// Surfaces on the employee profile Scorecards tab next to the customer comment.
// Owner/admin/office only; tenant-scoped. Send reply: "" to clear.
router.post("/entries/:entryId/reply", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const entryId = parseInt(req.params.entryId);
    if (isNaN(entryId)) return res.status(400).json({ error: "Invalid entryId" });
    const reply = typeof req.body?.reply === "string" ? req.body.reply.trim() : "";
    const cleared = reply.length === 0;

    const updated = await db
      .update(scorecardEntriesTable)
      .set({
        office_reply: cleared ? null : reply.slice(0, 2000),
        office_reply_by_user_id: cleared ? null : req.auth!.userId,
        office_reply_at: cleared ? null : new Date(),
      })
      .where(and(
        eq(scorecardEntriesTable.id, entryId),
        eq(scorecardEntriesTable.company_id, companyId),
      ))
      .returning();

    if (!updated[0]) return res.status(404).json({ error: "Not Found", message: "Scorecard entry not found" });
    return res.json({ entry: updated[0] });
  } catch (err) {
    console.error("Scorecard reply error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to save reply" });
  }
});

// ── MaidCentral scorecard import (bulk) ──────────────────────────────────────
// Loads (a) each employee's authoritative MC scorecard % into users.scorecard_pct
// (stored as-is, NOT recomputed) and (b) per-job history into scorecard_entries.
// Employees resolved by user_id, else email, else exact "First Last" (case-insensitive).
// Idempotent for %s (upsert). Entries: pass replace=true to clear existing
// source='mc' rows for the matched employees before inserting (safe re-runs).
//
// Body: {
//   replace?: boolean,
//   employee_pcts?: [{ user_id?, email?, name?, pct }],
//   entries?: [{ user_id?, email?, name?, job_id?, entry_date, score_value, max_value?, source?, notes? }]
// }
router.post("/import", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { employee_pcts = [], entries = [], replace = false } = req.body ?? {};

    // Resolver: build a lookup of this company's users by id / email / name.
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
    let pctsUpdated = 0;

    // (a) per-employee authoritative %
    for (const p of employee_pcts) {
      const uid = resolve(p);
      if (uid == null) { unresolved.push({ kind: "pct", ref: p.email ?? p.name ?? p.user_id }); continue; }
      const pct = Number(p.pct);
      if (!Number.isFinite(pct)) { unresolved.push({ kind: "pct_value", ref: p.email ?? p.name }); continue; }
      await db.update(usersTable).set({ scorecard_pct: String(pct) })
        .where(and(eq(usersTable.id, uid), eq(usersTable.company_id, companyId)));
      pctsUpdated++;
    }

    // (b) per-job history
    const resolvedEntryEmps = new Set<number>();
    const rows: any[] = [];
    for (const e of entries) {
      const uid = resolve(e);
      if (uid == null) { unresolved.push({ kind: "entry", ref: e.email ?? e.name ?? e.user_id, date: e.entry_date }); continue; }
      if (!e.entry_date || e.score_value == null) { unresolved.push({ kind: "entry_fields", ref: e.email ?? e.name }); continue; }
      resolvedEntryEmps.add(uid);
      rows.push({
        company_id: companyId,
        employee_id: uid,
        job_id: e.job_id != null ? Number(e.job_id) : null,
        entry_date: String(e.entry_date),
        score_value: String(Number(e.score_value)),
        max_value: e.max_value != null ? String(Number(e.max_value)) : "100",
        source: e.source === "qleno" ? "qleno" : "mc",
        notes: e.notes ?? null,
      });
    }

    if (replace && resolvedEntryEmps.size > 0) {
      await db.delete(scorecardEntriesTable).where(and(
        eq(scorecardEntriesTable.company_id, companyId),
        eq(scorecardEntriesTable.source, "mc"),
        inArray(scorecardEntriesTable.employee_id, [...resolvedEntryEmps]),
      ));
    }

    let entriesInserted = 0;
    // Chunked insert to stay well under parameter limits for 781 rows.
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      if (chunk.length) { await db.insert(scorecardEntriesTable).values(chunk); entriesInserted += chunk.length; }
    }

    return res.json({ ok: true, pcts_updated: pctsUpdated, entries_inserted: entriesInserted, unresolved });
  } catch (err) {
    console.error("Scorecard import error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to import scorecards" });
  }
});

export default router;
