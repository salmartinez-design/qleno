import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable, availabilityTable, contactTicketsTable,
  employeeNotesTable, jobsTable, clientsTable, scorecardsTable, additionalPayTable
} from "@workspace/db/schema";
import { eq, and, desc, count, gte, lte, sql } from "drizzle-orm";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { requireAuth, requireRole } from "../lib/auth.js";
import { signToken } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

router.patch("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const body = req.body;

    const allowedFields = [
      "first_name","last_name","role","pay_rate","pay_type","fee_split_pct",
      "allowed_hours_per_week","is_active","hire_date","termination_date","phone",
      "personal_email","address","city","state","zip","dob","gender",
      "employment_type","overtime_eligible","w2_1099","bank_name","bank_account_last4",
      "skills","tags","emergency_contact_name","emergency_contact_phone",
      "emergency_contact_relation","ssn_last4","notes","avatar_url",
    ];

    const update: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) update[field] = body[field];
    }

    const updated = await db
      .update(usersTable)
      .set(update as any)
      .where(and(eq(usersTable.id, userId), eq(usersTable.company_id, req.auth!.companyId)))
      .returning();

    if (!updated[0]) return res.status(404).json({ error: "Not Found" });
    const { password_hash: _, ...safe } = updated[0];
    return res.json(safe);
  } catch (err) {
    console.error("Patch user error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id/availability", requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const rows = await db
      .select()
      .from(availabilityTable)
      .where(and(eq(availabilityTable.user_id, userId), eq(availabilityTable.company_id, req.auth!.companyId)));
    return res.json({ data: rows });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/:id/availability", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { availability } = req.body as { availability: Array<{ day_of_week: number; start_time: string; end_time: string; is_available: boolean }> };

    await db.delete(availabilityTable).where(and(
      eq(availabilityTable.user_id, userId),
      eq(availabilityTable.company_id, req.auth!.companyId)
    ));

    if (availability && availability.length > 0) {
      await db.insert(availabilityTable).values(
        availability.map(a => ({
          company_id: req.auth!.companyId,
          user_id: userId,
          day_of_week: a.day_of_week,
          start_time: a.start_time,
          end_time: a.end_time,
          is_available: a.is_available,
        }))
      );
    }

    const rows = await db
      .select()
      .from(availabilityTable)
      .where(and(eq(availabilityTable.user_id, userId), eq(availabilityTable.company_id, req.auth!.companyId)));
    return res.json({ data: rows });
  } catch (err) {
    console.error("Put availability error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id/contact-tickets", requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const tickets = await db
      .select({
        id: contactTicketsTable.id,
        ticket_type: contactTicketsTable.ticket_type,
        notes: contactTicketsTable.notes,
        client_id: contactTicketsTable.client_id,
        job_id: contactTicketsTable.job_id,
        created_at: contactTicketsTable.created_at,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
      })
      .from(contactTicketsTable)
      .leftJoin(clientsTable, eq(contactTicketsTable.client_id, clientsTable.id))
      .where(and(
        eq(contactTicketsTable.user_id, userId),
        eq(contactTicketsTable.company_id, req.auth!.companyId)
      ))
      .orderBy(desc(contactTicketsTable.created_at));
    return res.json({ data: tickets });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/contact-tickets", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { ticket_type, notes, client_id, job_id } = req.body;
    const ticket = await db.insert(contactTicketsTable).values({
      company_id: req.auth!.companyId,
      user_id: userId,
      ticket_type,
      notes,
      client_id: client_id || null,
      job_id: job_id || null,
      created_by: req.auth!.userId,
    }).returning();
    return res.status(201).json(ticket[0]);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id/notes", requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const notes = await db
      .select({
        id: employeeNotesTable.id,
        note_type: employeeNotesTable.note_type,
        content: employeeNotesTable.content,
        is_system: employeeNotesTable.is_system,
        created_at: employeeNotesTable.created_at,
        created_by: employeeNotesTable.created_by,
        creator_name: sql<string>`concat(u2.first_name, ' ', u2.last_name)`,
      })
      .from(employeeNotesTable)
      .leftJoin(sql`users u2`, sql`${employeeNotesTable.created_by} = u2.id`)
      .where(and(
        eq(employeeNotesTable.user_id, userId),
        eq(employeeNotesTable.company_id, req.auth!.companyId)
      ))
      .orderBy(desc(employeeNotesTable.created_at));
    return res.json({ data: notes });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/notes", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { content, note_type } = req.body;
    const note = await db.insert(employeeNotesTable).values({
      company_id: req.auth!.companyId,
      user_id: userId,
      content,
      note_type: note_type || "manual",
      is_system: false,
      created_by: req.auth!.userId,
    }).returning();
    return res.status(201).json(note[0]);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id/jobs", requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { page = "1", limit = "25", status, from, to } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const conditions = [
      eq(jobsTable.assigned_user_id, userId),
      eq(jobsTable.company_id, req.auth!.companyId),
    ];
    if (status) conditions.push(eq(jobsTable.status, status as any));
    if (from) conditions.push(gte(jobsTable.scheduled_date, from as string));
    if (to) conditions.push(lte(jobsTable.scheduled_date, to as string));

    const jobs = await db
      .select({
        id: jobsTable.id,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        base_fee: jobsTable.base_fee,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .where(and(...conditions))
      .orderBy(desc(jobsTable.scheduled_date))
      .limit(parseInt(limit as string))
      .offset(offset);

    const totalResult = await db
      .select({ count: count() })
      .from(jobsTable)
      .where(and(...conditions));

    return res.json({ data: jobs, total: totalResult[0].count });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/invite", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { user_id } = req.body;
    const token = crypto.randomBytes(32).toString("hex");

    const user = await db
      .update(usersTable)
      .set({ invite_token: token, invite_sent_at: new Date() })
      .where(and(eq(usersTable.id, user_id), eq(usersTable.company_id, req.auth!.companyId)))
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
      });

    if (!user[0]) return res.status(404).json({ error: "User not found" });

    return res.json({
      success: true,
      invite_sent_to: user[0].email,
      invite_token: token,
      invite_url: `/accept-invite?token=${token}`,
      message: `Invitation sent to ${user[0].email}`,
    });
  } catch (err) {
    console.error("Invite error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/invite/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const user = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        invite_sent_at: usersTable.invite_sent_at,
        invite_accepted_at: usersTable.invite_accepted_at,
        company_id: usersTable.company_id,
      })
      .from(usersTable)
      .where(eq(usersTable.invite_token, token))
      .limit(1);

    if (!user[0]) return res.status(404).json({ error: "Invalid invite token" });

    if (user[0].invite_accepted_at) {
      return res.status(400).json({ error: "Invite already accepted" });
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (user[0].invite_sent_at && user[0].invite_sent_at < sevenDaysAgo) {
      return res.status(400).json({ error: "Invite token has expired" });
    }

    return res.json({
      valid: true,
      email: user[0].email,
      first_name: user[0].first_name,
      last_name: user[0].last_name,
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/invite/:token/accept", async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const user = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.invite_token, token))
      .limit(1);

    if (!user[0]) return res.status(404).json({ error: "Invalid invite token" });
    if (user[0].invite_accepted_at) return res.status(400).json({ error: "Invite already accepted" });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (user[0].invite_sent_at && user[0].invite_sent_at < sevenDaysAgo) {
      return res.status(400).json({ error: "Invite expired" });
    }

    const password_hash = await bcrypt.hash(password, 10);
    await db
      .update(usersTable)
      .set({
        password_hash,
        invite_accepted_at: new Date(),
        onboarding_complete: true,
        is_active: true,
      })
      .where(eq(usersTable.id, user[0].id));

    const jwtToken = signToken({ userId: user[0].id, companyId: user[0].company_id!, role: user[0].role });
    return res.json({ success: true, token: jwtToken, role: user[0].role });
  } catch (err) {
    console.error("Accept invite error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/employee-view-log", requireAuth, async (req, res) => {
  if (req.auth!.role !== "owner") {
    return res.status(403).json({ error: "Owner only" });
  }
  const targetId = parseInt(req.params.id);
  await logAudit(req, "employee_view_activated", "user", targetId, null, {
    target_employee_id: targetId,
    performed_by: req.auth!.userId,
  });
  return res.json({ ok: true });
});

export default router;
