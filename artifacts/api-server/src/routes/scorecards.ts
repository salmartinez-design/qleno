import { Router } from "express";
import { db } from "@workspace/db";
import { scorecardsTable, scorecardEntriesTable, usersTable, clientsTable } from "@workspace/db/schema";
import { eq, and, avg, count, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

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
        sql`${scorecardEntriesTable.employee_id} = ANY(${[...resolvedEntryEmps]}::int[])`,
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
