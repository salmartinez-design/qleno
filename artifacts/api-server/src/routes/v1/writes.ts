import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireApiKey } from "../../lib/api-auth.js";
import { logJobFieldChanges, logClientActivity } from "../../lib/audit.js";
import { syncJobInvoiceDraft } from "../jobs.js";
import { notifyUserAsync } from "../../lib/push.js";
import {
  fail, companyOf, dateOnly, today,
  beginWrite, finishWrite, refuseWriteAndRemember,
} from "./_shared.js";

// [ai-access-write 2026-08-16] The v1 write surface — Phase 5.
// Design: docs/AI_ACCESS_WRITE_DESIGN.md §6.
//
// This is the whole list of things an assistant can change. Keeping it in one
// file rather than beside the matching reads is deliberate: the question
// "what can the AI actually do to my business" should be answerable by opening
// one file and reading it top to bottom, not by grepping for verbs.
//
// THE SHAPE EVERY HANDLER FOLLOWS
// -------------------------------
//   1. beginWrite()  — budget, replay, actor. Returns null when it already
//                      answered; `if (!ctx) return;` is the whole convention.
//   2. Load the CURRENT row, scoped by company_id, and refuse if it is missing
//      or in a state this change does not apply to.
//   3. Make the change.
//   4. Write the audit rows the office actually reads (logJobFieldChanges).
//   5. finishWrite() — the undo ledger, the idempotency record, the response.
//
// WHY THE REFUSALS ARE SPECIFIC
// -----------------------------
// A model that gets "forbidden" retries; a model that gets "this visit is
// already marked complete, so its date cannot be changed — reopen it in Qleno
// first" reports something the office can act on. Every refusal below names the
// state that caused it and what a person would do instead.
//
// WHAT IS DELIBERATELY ABSENT
// ---------------------------
// Pricing, payroll, commission settings, employee records, and recurring
// schedule templates. Not "not yet" — those are Group C in the design and are
// not built. A recurring template edit is not one change, it is every future
// visit changing at once, which is the one shape of mistake nobody notices
// until the invoices come out wrong.

const router = Router();

/** Trim and collapse, or undefined. Model input arrives padded surprisingly often. */
const text = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** HH:MM or HH:MM:SS, 24-hour. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const pathId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * `jobs.scheduled_time` is TEXT and production holds three shapes at once —
 * 4,785 rows of "09:00:00", 711 of "09:00", and 344 of "9:00 AM" (counted
 * 2026-08-16). So the same nine o'clock compares unequal to itself depending on
 * which era wrote the row.
 *
 * That matters here and nowhere else in the codebase, because this is the one
 * caller whose input is composed by a language model. Ask an assistant to move a
 * 9am visit to 9am and string equality says the time changed: the write goes
 * through, a budget slot is spent, and the customer's history gains a line
 * reading "Time changed from 09:00:00 to 09:00". A trail that records
 * non-events is worse than one that records nothing, because the reader stops
 * believing the lines that do matter.
 *
 * Returns minutes past midnight, or null for anything unparseable — a null
 * never claims equality, so an unrecognized format falls back to being treated
 * as a real change rather than silently swallowed.
 */
const clockMinutes = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const m = /^\s*(\d{1,2}):([0-5]\d)(?::[0-5]\d)?\s*([AaPp][Mm])?\s*$/.exec(v);
  if (!m) return null;
  let h = Number(m[1]);
  const suffix = m[3]?.toLowerCase();
  if (suffix) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (suffix === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  return h * 60 + Number(m[2]);
};

/** Same moment on the clock, whichever of the three formats each side is in. */
const sameClockTime = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = clockMinutes(a);
  const y = clockMinutes(b);
  return x !== null && y !== null && x === y;
};

// ── Move a visit ─────────────────────────────────────────────────────────────
/**
 * PATCH /jobs/:id/schedule — change a visit's date and/or time.
 *
 * This is the endpoint the whole phase was authorised for: the office asks its
 * assistant to move a job and the job moves, with the change landing in the
 * customer's Activity feed naming the connection that made it.
 *
 * It moves ONE visit. A recurring visit moved here does not move its siblings
 * and does not touch the schedule template — "move Tuesday" means Tuesday, and
 * an assistant that silently shifted the whole series would be doing something
 * nobody asked for to customers who never appear in the conversation.
 */
router.patch("/jobs/:id/schedule", requireApiKey("rest", "jobs:write"), async (req, res) => {
  const jobId = pathId(req.params.id);
  if (!jobId) return fail(res, 400, "invalid_argument", "job id must be a positive integer.");

  const ctx = await beginWrite(req, res, "reschedule_job");
  if (!ctx) return;

  const newDate = text(req.body?.scheduled_date);
  const newTime = text(req.body?.scheduled_time);
  if (!newDate && !newTime) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "Nothing to change: pass scheduled_date, scheduled_time, or both.");
  }
  if (newDate && !DATE_RE.test(newDate)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `scheduled_date must be YYYY-MM-DD. Got "${newDate}".`);
  }
  if (newTime && !TIME_RE.test(newTime)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `scheduled_time must be 24-hour HH:MM. Got "${newTime}".`);
  }

  const companyId = ctx.companyId;
  const cur = await db.execute(sql`
    SELECT j.id, j.status, j.scheduled_date, j.scheduled_time, j.assigned_user_id, j.client_id,
           TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS client_name
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.id = ${jobId} AND j.company_id = ${companyId}
     LIMIT 1
  `);
  const job = (cur.rows?.[0] as any) ?? null;
  // Same wording whether the job belongs to another tenant or does not exist.
  // Distinguishing the two would let a caller probe for the existence of other
  // companies' job ids one number at a time.
  if (!job) {
    return refuseWriteAndRemember(ctx, res, 404, "not_found",
      `No visit with id ${jobId} in this company.`);
  }
  if (job.status === "complete" || job.status === "cancelled") {
    return refuseWriteAndRemember(ctx, res, 409, "wrong_state",
      `This visit is already marked ${job.status}, so its date cannot be changed. ` +
      `Reopen it in Qleno first if it was closed by mistake.`);
  }

  // A move into the past is almost always a model mis-parsing "last Tuesday" as
  // a target rather than a reference. Refusing costs a corrected retry; allowing
  // it puts a visit on a day the crew has already worked, where it shows up in
  // a closed payroll week.
  const t = today(companyId);
  if (newDate && newDate < t) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `${newDate} is in the past (today is ${t}). Visits can only be moved to today or later. ` +
      `If a past visit needs correcting, the office does that in Qleno.`);
  }

  const priorDate = dateOnly(job.scheduled_date);
  const priorTime = job.scheduled_time ?? null;
  const dateChanged = !!newDate && newDate !== priorDate;
  // Compared as clock time, not as text — "09:00" against a stored "09:00:00"
  // is the same nine o'clock and must not count as a move. See sameClockTime.
  const timeChanged = !!newTime && !sameClockTime(newTime, priorTime);
  if (!dateChanged && !timeChanged) {
    return refuseWriteAndRemember(ctx, res, 409, "no_change",
      `That visit is already on ${priorDate}${priorTime ? ` at ${priorTime}` : ""}. Nothing was changed.`);
  }

  // No `updated_at = now()` here, and none in any UPDATE in this file: neither
  // `jobs` nor `clients` has that column. Verified against the live schema on
  // 2026-08-16 — `jobs` carries `office_notes_updated_at` and nothing else of
  // that shape. Setting it would throw on the first assistant write, and no
  // typecheck can see it because this is raw SQL. The "when did this change"
  // question is answered by the audit rows written just below, which is the
  // record Sal actually asked for.
  // Only the halves that actually moved are written. Passing newTime through
  // unconditionally would rewrite "09:00:00" as "09:00" on a date-only move —
  // a silent format edit to a column three other formats already live in.
  await db.execute(sql`
    UPDATE jobs
       SET scheduled_date = COALESCE(${dateChanged ? newDate : null}::date, scheduled_date),
           scheduled_time = COALESCE(${timeChanged ? newTime : null}, scheduled_time)
     WHERE id = ${jobId} AND company_id = ${companyId}
  `);

  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  if (dateChanged) changes.push({ field: "scheduled_date", from: priorDate, to: newDate });
  if (timeChanged) changes.push({ field: "scheduled_time", from: priorTime, to: newTime });

  await logJobFieldChanges({
    companyId, jobId, userId: ctx.userId, actor: ctx.actor, changes,
  });

  // The invoice mirrors the job card, including its due date. Skipping this
  // would leave the customer's bill dated against the old visit.
  syncJobInvoiceDraft(jobId, companyId, dateChanged ? { newDate } : {})
    .catch((e) => console.error("[v1 reschedule] invoice sync non-fatal:", e));

  // The tech finds out the same way they would if the office had dragged the
  // chip. An assistant-initiated move that skipped this would be the one kind
  // of reschedule a crew learns about by showing up on the wrong day.
  if (job.assigned_user_id && dateChanged) {
    const pretty = new Date(`${newDate}T12:00:00`).toLocaleDateString("en-US",
      { weekday: "short", month: "short", day: "numeric" });
    notifyUserAsync(job.assigned_user_id, companyId, {
      title: "Schedule updated",
      body: `A job on your schedule was moved to ${pretty}.`,
      data: { type: "job", jobId: String(jobId) },
    });
  }

  const who = job.client_name || `job ${jobId}`;
  await finishWrite(ctx, res, {
    targetTable: "jobs",
    targetId: jobId,
    // newValues has to state what is now IN the row, not what was asked for.
    // revertAssistantWrite compares the live row against these to decide whether
    // a person edited it afterward; recording "09:00" for a row still holding
    // "09:00:00" would make every revert refuse with changed_since and the undo
    // button would be dead on arrival.
    priorValues: { scheduled_date: priorDate, scheduled_time: priorTime },
    newValues: {
      scheduled_date: dateChanged ? newDate : priorDate,
      scheduled_time: timeChanged ? newTime : priorTime,
    },
    summary:
      `Moved ${who}'s visit from ${priorDate}${priorTime ? ` ${priorTime}` : ""} ` +
      `to ${dateChanged ? newDate : priorDate}` +
      `${timeChanged ? ` ${newTime}` : priorTime ? ` ${priorTime}` : ""}.`,
    extra: { job_id: jobId, client_name: job.client_name ?? null },
  });
});

// ── Put a cleaner on a visit ─────────────────────────────────────────────────
/**
 * POST /jobs/:id/assign — set (or clear) which cleaner is on a visit.
 *
 * THE MIRROR IS NOT OPTIONAL. The dispatch grid reads jobs.assigned_user_id
 * while the job card, commission, and payroll read job_technicians. Writing one
 * without the other produces a job that is assigned in the office's records and
 * sitting in the Unassigned row on the board — see the assignment-mirror
 * invariant in CLAUDE.md. Both are written below, in the same order the office
 * paths use.
 */
router.post("/jobs/:id/assign", requireApiKey("rest", "jobs:write"), async (req, res) => {
  const jobId = pathId(req.params.id);
  if (!jobId) return fail(res, 400, "invalid_argument", "job id must be a positive integer.");

  const ctx = await beginWrite(req, res, "assign_technician");
  if (!ctx) return;

  const companyId = ctx.companyId;
  const raw = req.body?.technician_id;
  // null clears the assignment; undefined means the caller forgot the argument.
  // Treating those the same would let a malformed call quietly unassign a job.
  if (raw === undefined) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "Pass technician_id to assign someone, or null to leave the visit unassigned.");
  }
  const techId = raw === null ? null : pathId(raw);
  if (raw !== null && !techId) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "technician_id must be a positive integer, or null to unassign.");
  }

  const cur = await db.execute(sql`
    SELECT j.id, j.status, j.assigned_user_id, j.scheduled_date,
           TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS client_name
      FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.id = ${jobId} AND j.company_id = ${companyId} LIMIT 1
  `);
  const job = (cur.rows?.[0] as any) ?? null;
  if (!job) {
    return refuseWriteAndRemember(ctx, res, 404, "not_found", `No visit with id ${jobId} in this company.`);
  }
  if (job.status === "cancelled") {
    return refuseWriteAndRemember(ctx, res, 409, "wrong_state",
      "This visit is cancelled, so nobody can be assigned to it.");
  }

  let techName: string | null = null;
  if (techId !== null) {
    const u = await db.execute(sql`
      SELECT id, TRIM(CONCAT(first_name, ' ', last_name)) AS name, is_active
        FROM users WHERE id = ${techId} AND company_id = ${companyId} LIMIT 1
    `);
    const tech = (u.rows?.[0] as any) ?? null;
    if (!tech) {
      return refuseWriteAndRemember(ctx, res, 404, "not_found",
        `No employee with id ${techId} in this company. Look the person up first rather than guessing an id.`);
    }
    if (tech.is_active === false) {
      return refuseWriteAndRemember(ctx, res, 409, "wrong_state",
        `${tech.name} is not an active employee, so they cannot be put on a visit.`);
    }
    techName = tech.name;
  }

  const priorId = job.assigned_user_id ?? null;
  if (priorId === techId) {
    return refuseWriteAndRemember(ctx, res, 409, "no_change",
      techId === null
        ? "That visit is already unassigned. Nothing was changed."
        : `${techName} is already on that visit. Nothing was changed.`);
  }

  await db.execute(sql`
    UPDATE jobs SET assigned_user_id = ${techId}
     WHERE id = ${jobId} AND company_id = ${companyId}
  `);

  // The mirror. Demote whoever held the slot, then upsert the new person into
  // it — helpers already on the job keep their rows either way.
  if (techId === null) {
    await db.execute(sql`
      UPDATE job_technicians SET is_primary = false WHERE job_id = ${jobId} AND is_primary = true
    `);
  } else {
    await db.execute(sql`
      UPDATE job_technicians SET is_primary = false
       WHERE job_id = ${jobId} AND is_primary = true AND user_id <> ${techId}
    `);
    await db.execute(sql`
      INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
      VALUES (${jobId}, ${techId}, ${companyId}, true)
      ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = true
    `);
  }

  let priorName: string | null = null;
  if (priorId) {
    const p = await db.execute(sql`
      SELECT TRIM(CONCAT(first_name, ' ', last_name)) AS name FROM users WHERE id = ${priorId} LIMIT 1
    `);
    priorName = ((p.rows?.[0] as any)?.name as string) ?? null;
  }

  await logJobFieldChanges({
    companyId, jobId, userId: ctx.userId, actor: ctx.actor,
    changes: [{ field: "assigned_user_id", from: priorName ?? priorId, to: techName ?? null }],
  });

  if (techId) {
    notifyUserAsync(techId, companyId, {
      title: "New job assigned",
      body: `A visit on ${dateOnly(job.scheduled_date) ?? "your schedule"} was assigned to you.`,
      data: { type: "job", jobId: String(jobId) },
    });
  }

  const who = job.client_name || `job ${jobId}`;
  await finishWrite(ctx, res, {
    targetTable: "jobs",
    targetId: jobId,
    priorValues: { assigned_user_id: priorId },
    newValues: { assigned_user_id: techId },
    summary: techId === null
      ? `Removed ${priorName ?? "the cleaner"} from ${who}'s visit — it is now unassigned.`
      : `Put ${techName} on ${who}'s visit${priorName ? `, replacing ${priorName}` : ""}.`,
    extra: { job_id: jobId, technician_name: techName },
  });
});

// ── Add a note to a visit ────────────────────────────────────────────────────
/**
 * POST /jobs/:id/notes — append a line to the job's office notes.
 *
 * APPEND, never replace. A replace here would let one call throw away access
 * instructions, pet warnings, and gate codes that somebody typed months ago,
 * and the loss would be silent — the next person to open the card simply sees
 * an emptier note than the one they wrote.
 *
 * The line is stamped so the note itself says where it came from, because a
 * note is copied, quoted, and pasted into messages far from any audit table.
 */
router.post("/jobs/:id/notes", requireApiKey("rest", "jobs:write"), async (req, res) => {
  const jobId = pathId(req.params.id);
  if (!jobId) return fail(res, 400, "invalid_argument", "job id must be a positive integer.");

  const ctx = await beginWrite(req, res, "add_job_note");
  if (!ctx) return;

  const note = text(req.body?.note);
  if (!note) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument", "Pass a note with some text in it.");
  }
  if (note.length > 2000) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `That note is ${note.length} characters; the limit is 2000. Shorten it to the part the crew needs.`);
  }

  const companyId = ctx.companyId;
  const cur = await db.execute(sql`
    SELECT j.id, j.office_notes, TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS client_name
      FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.id = ${jobId} AND j.company_id = ${companyId} LIMIT 1
  `);
  const job = (cur.rows?.[0] as any) ?? null;
  if (!job) {
    return refuseWriteAndRemember(ctx, res, 404, "not_found", `No visit with id ${jobId} in this company.`);
  }

  const prior = (job.office_notes as string | null) ?? "";
  const stamped = `[via ${ctx.actor.label}] ${note}`;
  const next = prior.trim().length > 0 ? `${prior.trimEnd()}\n${stamped}` : stamped;

  await db.execute(sql`
    UPDATE jobs SET office_notes = ${next}
     WHERE id = ${jobId} AND company_id = ${companyId}
  `);

  await logJobFieldChanges({
    companyId, jobId, userId: ctx.userId, actor: ctx.actor,
    changes: [{ field: "office_notes", from: prior || null, to: next }],
  });

  await finishWrite(ctx, res, {
    targetTable: "jobs",
    targetId: jobId,
    priorValues: { office_notes: prior || null },
    newValues: { office_notes: next },
    summary: `Added a note to ${job.client_name || `job ${jobId}`}'s visit: "${note.slice(0, 120)}".`,
    extra: { job_id: jobId },
  });
});

// ── Correct a customer's phone or email ──────────────────────────────────────
/**
 * PATCH /clients/:id/contact — update a customer's phone number or email.
 *
 * Contact details only. Not the address, because the address decides which
 * branch a job routes to and what the crew's drive looks like; not the name,
 * because a renamed customer is unrecognisable in every historical record that
 * already refers to them.
 */
router.patch("/clients/:id/contact", requireApiKey("rest", "clients:write"), async (req, res) => {
  const clientId = pathId(req.params.id);
  if (!clientId) return fail(res, 400, "invalid_argument", "client id must be a positive integer.");

  const ctx = await beginWrite(req, res, "update_client_contact");
  if (!ctx) return;

  const email = text(req.body?.email);
  const phone = text(req.body?.phone);
  if (!email && !phone) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "Nothing to change: pass email, phone, or both.");
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `"${email}" is not a valid email address.`);
  }
  // Ten digits, however the caller punctuated them. A customer who cannot be
  // reached is the whole cost of getting this wrong, so a short or long string
  // is refused rather than stored and discovered at the next reminder send.
  let normalizedPhone: string | undefined;
  if (phone) {
    const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (digits.length !== 10) {
      return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
        `"${phone}" is not a 10-digit US phone number.`);
    }
    normalizedPhone = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  const companyId = ctx.companyId;
  const cur = await db.execute(sql`
    SELECT id, email, phone, TRIM(CONCAT(first_name, ' ', last_name)) AS name
      FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
  `);
  const client = (cur.rows?.[0] as any) ?? null;
  if (!client) {
    return refuseWriteAndRemember(ctx, res, 404, "not_found", `No customer with id ${clientId} in this company.`);
  }

  const priorEmail = (client.email as string | null) ?? null;
  const priorPhone = (client.phone as string | null) ?? null;
  const nextEmail = email ?? priorEmail;
  const nextPhone = normalizedPhone ?? priorPhone;
  if (nextEmail === priorEmail && nextPhone === priorPhone) {
    return refuseWriteAndRemember(ctx, res, 409, "no_change",
      `${client.name} already has those contact details. Nothing was changed.`);
  }

  await db.execute(sql`
    UPDATE clients
       SET email = ${nextEmail}, phone = ${nextPhone}
     WHERE id = ${clientId} AND company_id = ${companyId}
  `);

  // Writes client_audit_log, which is the customer profile's own trail. It
  // reads the actor off the request, so the row names the connection.
  if (email && nextEmail !== priorEmail) {
    await logClientActivity(req, clientId, "email", { value: priorEmail }, { value: nextEmail });
  }
  if (normalizedPhone && nextPhone !== priorPhone) {
    await logClientActivity(req, clientId, "phone", { value: priorPhone }, { value: nextPhone });
  }

  await finishWrite(ctx, res, {
    targetTable: "clients",
    targetId: clientId,
    priorValues: { email: priorEmail, phone: priorPhone },
    newValues: { email: nextEmail, phone: nextPhone },
    summary: `Updated ${client.name}'s contact details.`,
    extra: { client_id: clientId, client_name: client.name },
  });
});

export default router;
