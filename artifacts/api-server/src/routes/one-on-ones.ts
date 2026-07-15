// [one-on-ones 2026-07-14] Owner-only quarterly 1-on-1 check-ins. See
// lib/db/src/schema/one_on_ones.ts for the model + the privacy rule.
//
// PRIVACY — OWNER ONLY. Every route here gates to role 'owner' via requireRole
// ("owner") with NO "admin" in the list, so the office-parity elevation in
// requireRole does NOT apply — admin/office (Maribel, Pancho) get 403 on all of
// it, including their own records. No customer SMS/email ever fires from here.
//
// The board block is a separate dispatch_events row (kind='one_on_one') that the
// office CAN see/schedule around; it carries who+when but none of the content
// below. Creating a 1-on-1 here creates that block and links it.
//
// The scheduled employee gets a single INTERNAL in-app bell notification (the
// appointment — who + when — never the content). It uses an unmapped notify
// type, so it delivers in-app ONLY and never emails/SMS the tech, leaving the
// COMMS_ENABLED gate untouched. The private conversation stays owner-only.

import { Router } from "express";
import { db } from "@workspace/db";
import { oneOnOnesTable, dispatchEventsTable, usersTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { resolveWindow } from "../lib/report-periods.js";
import { notifyUser } from "../lib/notify.js";

const router = Router();
// Strict owner gate — office/admin are NOT elevated in here (no "admin" role in
// the list, so requireRole's office-parity branch never triggers).
const ownerOnly = requireRole("owner");

// Standard quarterly 1-on-1 question set. Snapshotted onto each record at
// creation (one_on_ones.questions) so historical write-ups render faithfully
// even after this list changes. Versioned by QUESTIONS_VERSION.
const QUESTIONS_VERSION = 1;
const QUESTIONS = [
  { id: "scorecard", section: "Scorecard review", label: "Walk their scorecard together — how do they react to the numbers?", hint: "Their quarter score is shown above." },
  { id: "work_going_well", section: "Work", label: "What's going well right now?" },
  { id: "work_friction", section: "Work", label: "What's frustrating or getting in your way?" },
  { id: "growth", section: "Growth", label: "Where do you want to get better, or grow into?" },
  { id: "personal", section: "Personal", label: "How are things outside work? Anything you want me to know?", hint: "Optional — only what they choose to share." },
  { id: "culture", section: "Culture", label: "How does it actually feel to work here right now? Do you feel heard and respected?" },
  { id: "ideas", section: "Ideas", label: "If you ran Phes for a day, what would you change? What ideas do you have for us?" },
  { id: "support", section: "Support", label: "What can I do to support you better?" },
  { id: "action_items", section: "Action items", label: "What did we both agree to do next?" },
];

// Pull an employee's scorecard for the quarter containing `anchorDate`. Mirrors
// GET /api/scorecards/report (scope=employee, period=quarter) so the snapshot
// matches what the Performance Score tab shows.
async function pullScorecard(companyId: number, employeeId: number, anchorDate: string) {
  const win = resolveWindow("quarter", { anchor: anchorDate });
  const r = await db.execute(sql`
    SELECT ROUND(AVG(score_value / NULLIF(max_value, 0)) * 100, 2) AS score_pct, COUNT(*)::int AS responses
      FROM scorecard_entries
     WHERE source = 'qleno' AND excluded = false AND company_id = ${companyId}
       AND employee_id = ${employeeId}
       AND entry_date >= ${win.from} AND entry_date <= ${win.to}`);
  const row: any = r.rows[0] ?? {};
  const cr = await db.execute(sql`
    SELECT scorecard_composite_90d, score_satisfaction_90d, score_attendance_90d, score_complaint_free_90d
      FROM users WHERE id = ${employeeId} AND company_id = ${companyId} LIMIT 1`);
  const c: any = cr.rows[0] ?? {};
  const snapshot = {
    window: win,
    score_pct: row.score_pct != null ? parseFloat(row.score_pct) : null,
    responses: Number(row.responses ?? 0),
    composite_pct: c.scorecard_composite_90d != null ? parseFloat(c.scorecard_composite_90d) : null,
    satisfaction_pct: c.score_satisfaction_90d != null ? parseFloat(c.score_satisfaction_90d) : null,
    attendance_pct: c.score_attendance_90d != null ? parseFloat(c.score_attendance_90d) : null,
    complaint_free_pct: c.score_complaint_free_90d != null ? parseFloat(c.score_complaint_free_90d) : null,
  };
  const headline = snapshot.composite_pct ?? snapshot.score_pct ?? null;
  return { win, snapshot, headline };
}

const empName = sql<string>`NULLIF(btrim(concat(${usersTable.first_name}, ' ', ${usersTable.last_name})), '')`;

// GET /api/one-on-ones/questions — the standard question set (for rendering a
// brand-new, not-yet-saved 1-on-1). Saved records carry their own snapshot.
router.get("/questions", requireAuth, ownerOnly, (_req, res) => {
  return res.json({ version: QUESTIONS_VERSION, questions: QUESTIONS });
});

// GET /api/one-on-ones/coverage?period=quarter&date=YYYY-MM-DD
// Who has / hasn't had their 1-on-1 in the period. Covers every active employee
// the owner meets (excludes the owner themselves, the external accountant, and
// platform super_admin).
router.get("/coverage", requireAuth, ownerOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const win = resolveWindow(String(req.query.period ?? "quarter"), { anchor: req.query.date });
    const people = await db
      .select({ id: usersTable.id, name: empName, role: usersTable.role })
      .from(usersTable)
      .where(and(
        eq(usersTable.company_id, companyId),
        eq(usersTable.is_active, true),
        sql`${usersTable.role} NOT IN ('owner', 'super_admin', 'accountant')`,
      ))
      .orderBy(usersTable.first_name);
    const rows = await db
      .select({ employee_id: oneOnOnesTable.employee_id, status: oneOnOnesTable.status, id: oneOnOnesTable.id, event_date: oneOnOnesTable.event_date })
      .from(oneOnOnesTable)
      .where(and(eq(oneOnOnesTable.company_id, companyId), eq(oneOnOnesTable.period_label, win.label)));
    const byEmp = new Map<number, { status: string; id: number; event_date: string }>();
    for (const r of rows) {
      const prev = byEmp.get(r.employee_id);
      // Prefer a completed record over a merely scheduled one.
      if (!prev || (prev.status !== "completed" && r.status === "completed")) {
        byEmp.set(r.employee_id, { status: r.status, id: r.id, event_date: r.event_date });
      }
    }
    const coverage = people.map(p => {
      const rec = byEmp.get(p.id);
      return { employee_id: p.id, name: p.name, role: p.role, status: rec?.status ?? "none", one_on_one_id: rec?.id ?? null, event_date: rec?.event_date ?? null };
    });
    const completed = coverage.filter(c => c.status === "completed").length;
    return res.json({ period_label: win.label, window: win, total: coverage.length, completed, coverage });
  } catch (err) {
    console.error("GET /one-on-ones/coverage error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/one-on-ones?employee_id=123 — an employee's 1-on-1 history.
router.get("/", requireAuth, ownerOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const employeeId = req.query.employee_id ? parseInt(String(req.query.employee_id), 10) : null;
    const rows = await db
      .select()
      .from(oneOnOnesTable)
      .where(and(
        eq(oneOnOnesTable.company_id, companyId),
        Number.isFinite(employeeId as number) ? eq(oneOnOnesTable.employee_id, employeeId as number) : sql`true`,
      ))
      .orderBy(desc(oneOnOnesTable.event_date), desc(oneOnOnesTable.id));
    return res.json(rows);
  } catch (err) {
    console.error("GET /one-on-ones error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/one-on-ones/:id — one record + employee name + a LIVE scorecard
// re-pull for the record's quarter (so the owner sees current numbers while
// conducting), alongside the stored snapshot.
router.get("/:id", requireAuth, ownerOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const [rec] = await db.select().from(oneOnOnesTable)
      .where(and(eq(oneOnOnesTable.id, id), eq(oneOnOnesTable.company_id, companyId))).limit(1);
    if (!rec) return res.status(404).json({ error: "not found" });
    const [emp] = await db.select({ id: usersTable.id, name: empName }).from(usersTable)
      .where(eq(usersTable.id, rec.employee_id)).limit(1);
    let live_scorecard: any = null;
    try { live_scorecard = (await pullScorecard(companyId, rec.employee_id, rec.event_date)).snapshot; } catch { /* best-effort */ }
    return res.json({ ...rec, employee_name: emp?.name ?? null, live_scorecard });
  } catch (err) {
    console.error("GET /one-on-ones/:id error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/one-on-ones — schedule a 1-on-1. Creates the board block AND the
// private record, and captures the quarter scorecard.
// Body: { employee_id, event_date, start_time?, end_time? }
router.post("/", requireAuth, ownerOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const ownerId = req.auth!.userId!;
    const b = req.body ?? {};

    const employeeId = Number.isFinite(b.employee_id) ? b.employee_id : null;
    if (!employeeId) return res.status(400).json({ error: "employee_id is required" });
    const eventDate = typeof b.event_date === "string" ? b.event_date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return res.status(400).json({ error: "event_date=YYYY-MM-DD is required" });

    // Confirm the employee belongs to this company.
    const [emp] = await db.select({ id: usersTable.id, name: empName }).from(usersTable)
      .where(and(eq(usersTable.id, employeeId), eq(usersTable.company_id, companyId))).limit(1);
    if (!emp) return res.status(404).json({ error: "employee not found" });

    const win = resolveWindow("quarter", { anchor: eventDate });
    const { snapshot, headline } = await pullScorecard(companyId, employeeId, eventDate);

    const startTime = typeof b.start_time === "string" && /^\d{1,2}:\d{2}/.test(b.start_time) ? (b.start_time.length === 5 ? `${b.start_time}:00` : b.start_time) : null;
    const endTime = typeof b.end_time === "string" && /^\d{1,2}:\d{2}/.test(b.end_time) ? (b.end_time.length === 5 ? `${b.end_time}:00` : b.end_time) : null;

    // Board block — office-visible, no content. Neutral "1-on-1" label.
    const [block] = await db.insert(dispatchEventsTable).values({
      company_id: companyId,
      kind: "one_on_one",
      title: "1-on-1",
      assigned_user_id: employeeId,
      event_date: eventDate,
      start_time: startTime,
      end_time: endTime,
      all_day: false,
      created_by_user_id: ownerId,
    }).returning({ id: dispatchEventsTable.id });

    const [rec] = await db.insert(oneOnOnesTable).values({
      company_id: companyId,
      employee_id: employeeId,
      manager_id: ownerId,
      period_label: win.label,
      event_date: eventDate,
      dispatch_event_id: block?.id ?? null,
      scorecard_pct: headline != null ? String(headline) : null,
      scorecard_snapshot: snapshot,
      questions: QUESTIONS,
      responses: {},
      status: "scheduled",
      created_by_user_id: ownerId,
    }).returning();

    // Internal in-app bell to the employee — appointment only (who + when),
    // never the content. Unmapped notify type => in-app ONLY, no email/SMS, so
    // the COMMS_ENABLED gate is untouched. Best-effort; never blocks the create.
    try {
      const [mgr] = await db.select({ name: empName }).from(usersTable).where(eq(usersTable.id, ownerId)).limit(1);
      const [yy, mm, dd] = eventDate.split("-").map(Number);
      const prettyDate = new Date(yy, mm - 1, dd).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      let prettyTime = "";
      if (startTime) {
        const [h, m] = startTime.split(":").map(Number);
        prettyTime = ` at ${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
      }
      await notifyUser({
        companyId,
        userId: employeeId,
        type: "one_on_one_scheduled",
        title: "1-on-1 scheduled",
        body: `${mgr?.name ? `${mgr.name} ` : ""}scheduled a 1-on-1 with you on ${prettyDate}${prettyTime}.`,
        link: "/my-jobs",
      });
    } catch (e) { console.error("one-on-one notify failed:", e); }

    return res.status(201).json({ ...rec, employee_name: emp.name });
  } catch (err) {
    console.error("POST /one-on-ones error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// PATCH /api/one-on-ones/:id — save answers / notes / complete.
// Body: { responses?, notes?, status? }
router.patch("/:id", requireAuth, ownerOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const [existing] = await db.select().from(oneOnOnesTable)
      .where(and(eq(oneOnOnesTable.id, id), eq(oneOnOnesTable.company_id, companyId))).limit(1);
    if (!existing) return res.status(404).json({ error: "not found" });

    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (b.responses && typeof b.responses === "object") patch.responses = b.responses;
    if (typeof b.notes === "string") patch.notes = b.notes;
    if (b.status === "completed" || b.status === "scheduled") {
      patch.status = b.status;
      if (b.status === "completed") {
        patch.completed_at = new Date();
        // Refresh the scorecard snapshot so the finalized record shows the
        // latest number for the quarter.
        try {
          const { snapshot, headline } = await pullScorecard(companyId, existing.employee_id, existing.event_date);
          patch.scorecard_snapshot = snapshot;
          if (headline != null) patch.scorecard_pct = String(headline);
        } catch { /* keep the creation snapshot on failure */ }
      } else {
        patch.completed_at = null;
      }
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });

    const [updated] = await db.update(oneOnOnesTable).set(patch)
      .where(and(eq(oneOnOnesTable.id, id), eq(oneOnOnesTable.company_id, companyId))).returning();
    return res.json(updated);
  } catch (err) {
    console.error("PATCH /one-on-ones/:id error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /api/one-on-ones/:id — remove the record AND its board block.
router.delete("/:id", requireAuth, ownerOnly, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const [rec] = await db.select({ id: oneOnOnesTable.id, dispatch_event_id: oneOnOnesTable.dispatch_event_id })
      .from(oneOnOnesTable)
      .where(and(eq(oneOnOnesTable.id, id), eq(oneOnOnesTable.company_id, companyId))).limit(1);
    if (!rec) return res.status(404).json({ error: "not found" });
    await db.delete(oneOnOnesTable).where(and(eq(oneOnOnesTable.id, id), eq(oneOnOnesTable.company_id, companyId)));
    if (rec.dispatch_event_id != null) {
      await db.delete(dispatchEventsTable).where(and(eq(dispatchEventsTable.id, rec.dispatch_event_id), eq(dispatchEventsTable.company_id, companyId)));
    }
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("DELETE /one-on-ones/:id error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
