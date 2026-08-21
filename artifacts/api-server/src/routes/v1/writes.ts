import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireApiKey } from "../../lib/api-auth.js";
import { logAudit, logJobFieldChanges, logClientActivity } from "../../lib/audit.js";
import { resolveBranchForCompany } from "../../lib/branchRouter.js";
import { normalizeDaysOfWeek } from "../../lib/recurring-create.js";
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
// Pricing config, payroll, commission settings, and EDITS to a recurring
// schedule template. Not "not yet" — those are Group C in the design and are
// not built. A recurring template edit is not one change, it is every future
// visit changing at once, which is the one shape of mistake nobody notices
// until the invoices come out wrong.
//
// [mcp-writes 2026-08-19] Three things moved OUT of that list, on Sal's
// instruction: "I need to be able to prompt a quote and email it... add a new
// employee, delete one, move one to inactive status."
//
//   quotes           — write one up (draft), and send an existing one. Two
//                      scopes, because writing a price down and putting it in
//                      front of a customer are not the same act. Nothing here
//                      prices anything; the total is whatever the office said.
//   recurring create — starting a customer repeating writes new visits, which
//                      is a different act from editing a template and silently
//                      rewriting visits that already exist. Editing stays out.
//   employees        — add, deactivate, reactivate. Deactivation is owner-only
//                      and the check lives in lib/employee-admin.ts, not here,
//                      so it holds on the office UI and this surface alike.

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

/**
 * The recurring_frequency enum, as it exists in production (verified against the
 * live type on 2026-08-19). Listed here rather than imported so a refusal can
 * NAME the valid values — a model told "invalid frequency" guesses again, and a
 * model told "one of: weekly, biweekly, custom_days, ..." picks the right one.
 */
const RECURRING_FREQUENCIES = [
  "weekly", "biweekly", "every_3_weeks", "monthly", "semi_monthly",
  "monthly_weekday", "daily", "weekdays", "custom_days", "custom",
];

/** The cadences the engine places from days_of_week rather than a single day. */
const MULTI_DAY_FREQUENCIES = ["daily", "weekdays", "custom_days"];

/** 0=Sun..6=Sat, matching recurring_schedules.days_of_week. */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

// ── Write up a quote ─────────────────────────────────────────────────────────
/**
 * POST /quotes — create a draft quote.
 *
 * IT DOES NOT PRICE ANYTHING. `total_price` is required and is whatever the
 * caller passed; nothing here consults the pricing engine, applies a scope's
 * hourly rate, or fills in a number the office did not say out loud. That is
 * deliberate: a model that can invent a price can under-quote a job by half and
 * the first anyone hears of it is a customer holding an email. The assistant's
 * job is to write down the price the office decided on, and the office decides
 * it.
 *
 * The quote lands as a DRAFT. Creating it and sending it are two separate calls
 * under two separate scopes, so "write this up so I can look at it" and "send
 * it to the customer" are never the same act.
 *
 * ALTERNATES: a commercial quote is usually a price at one frequency plus a
 * price at another — three times a week, and what five would cost. The second
 * tier rides on the quote as `alternate_options`, which the public quote page
 * and the quote email both already render as its own card. It is NOT a second
 * quote row. (The residential multi-frequency comparison is computed by the
 * pricing engine from sqft and a scope; a commercial job has neither, which is
 * why the alternate is passed in rather than derived.)
 */
router.post("/quotes", requireApiKey("rest", "quotes:write"), async (req, res) => {
  const ctx = await beginWrite(req, res, "create_quote");
  if (!ctx) return;

  const companyId = ctx.companyId;
  const leadName = text(req.body?.lead_name);
  const leadEmail = text(req.body?.lead_email);
  const leadPhone = text(req.body?.lead_phone);
  const address = text(req.body?.address);
  const serviceType = text(req.body?.service_type);
  const frequency = text(req.body?.frequency);
  const notes = text(req.body?.notes);
  const clientId = req.body?.client_id == null ? null : pathId(req.body.client_id);

  if (!leadName && !clientId) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "Pass lead_name (the person or organization being quoted), or client_id for an existing customer.");
  }
  if (req.body?.client_id != null && !clientId) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "client_id must be a positive integer, or omitted for a new lead.");
  }
  if (leadEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(leadEmail)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `"${leadEmail}" is not a valid email address.`);
  }

  const total = Number(req.body?.total_price);
  if (!Number.isFinite(total) || total < 0) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "total_price is required and must be a number. This endpoint does not calculate a price — " +
      "pass the amount the office decided on.");
  }
  const rawBase = req.body?.base_price;
  const basePrice = rawBase == null || rawBase === "" ? total : Number(rawBase);
  if (!Number.isFinite(basePrice) || basePrice < 0) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "base_price must be a number when it is passed.");
  }

  // Alternates: only `total` is load-bearing (it is what the customer sees on
  // the second card). A tier with no price is dropped rather than rendered as a
  // blank option, which is how the followup email treats them too.
  const rawAlts = req.body?.alternate_options;
  if (rawAlts !== undefined && !Array.isArray(rawAlts)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "alternate_options must be an array of { scope_name, frequency, total }.");
  }
  const alternates = (Array.isArray(rawAlts) ? rawAlts : [])
    .map((a: any) => ({
      scope_id: a?.scope_id != null ? Number(a.scope_id) : null,
      scope_name: text(a?.scope_name) ?? serviceType ?? null,
      frequency: text(a?.frequency) ?? null,
      addon_ids: Array.isArray(a?.addon_ids) ? a.addon_ids : [],
      total: Number(a?.total),
    }))
    .filter((a) => Number.isFinite(a.total) && a.total >= 0);
  if (Array.isArray(rawAlts) && rawAlts.length > 0 && alternates.length === 0) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "Every alternate option needs a numeric total. None of the ones passed had one.");
  }

  // An existing customer must actually be one of ours before their id goes on a
  // quote — otherwise a wrong id silently attaches the quote to nobody and the
  // customer never sees it in their profile.
  let clientName: string | null = null;
  let clientZip: string | null = null;
  if (clientId) {
    const c = await db.execute(sql`
      SELECT id, zip, TRIM(CONCAT(first_name, ' ', last_name)) AS name, email, phone
        FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
    `);
    const client = (c.rows?.[0] as any) ?? null;
    if (!client) {
      return refuseWriteAndRemember(ctx, res, 404, "not_found",
        `No customer with id ${clientId} in this company. Look the customer up first rather than guessing an id.`);
    }
    clientName = client.name ?? null;
    clientZip = client.zip ?? null;
  }

  // Branch tag. Same rule as the office quote: a tenant pinned to a branch keeps
  // that branch whatever the address says (companies.branch_key), and only an
  // unpinned tenant falls back to the zip.
  let branch = "oak_lawn";
  try {
    const zip = clientZip ?? (address?.match(/\b(\d{5})\b(?!.*\b\d{5}\b)/)?.[1] ?? null);
    branch = (await resolveBranchForCompany(companyId, zip)).branch;
  } catch { /* keep the default rather than failing the quote over a branch tag */ }

  const ins = await db.execute(sql`
    INSERT INTO quotes (
      company_id, client_id, lead_name, lead_email, lead_phone, address,
      service_type, frequency, base_price, total_price, discount_amount,
      notes, alternate_options, status, created_by, branch
    ) VALUES (
      ${companyId}, ${clientId}, ${leadName ?? clientName}, ${leadEmail ?? null}, ${leadPhone ?? null}, ${address ?? null},
      ${serviceType ?? null}, ${frequency ?? null}, ${String(basePrice)}, ${String(total)}, '0',
      ${notes ?? null}, ${alternates.length ? JSON.stringify(alternates) : null}::jsonb,
      'draft', ${ctx.userId}, ${branch}
    )
    RETURNING id, status, total_price
  `);
  const quote = (ins.rows?.[0] as any) ?? null;
  if (!quote) {
    return refuseWriteAndRemember(ctx, res, 500, "internal", "The quote could not be created.");
  }
  const quoteId = Number(quote.id);

  await logAudit(req, "CREATE", "quote", quoteId, null, { status: "draft", total_price: String(total) });

  // Find-or-create the lead so the quote shows up on the lead board the same way
  // an office-written one does. Non-blocking: a lead-sync hiccup must not lose a
  // quote that already exists.
  import("../../lib/lead-sync.js")
    .then(({ upsertLeadForQuote }) => upsertLeadForQuote(companyId, { ...quote, id: quoteId, company_id: companyId, lead_name: leadName ?? clientName, lead_email: leadEmail ?? null, lead_phone: leadPhone ?? null, client_id: clientId }))
    .catch(() => {});

  const who = leadName ?? clientName ?? `quote ${quoteId}`;
  await finishWrite(ctx, res, {
    targetTable: "quotes",
    targetId: quoteId,
    priorValues: null,
    newValues: { status: "draft", total_price: total },
    summary:
      `Wrote up a draft quote for ${who}` +
      `${serviceType ? ` — ${serviceType}` : ""}${frequency ? `, ${frequency}` : ""}` +
      ` at $${total.toFixed(2)}` +
      `${alternates.length ? ` (plus ${alternates.length} alternate option${alternates.length === 1 ? "" : "s"})` : ""}` +
      `. It has NOT been sent.`,
    extra: {
      quote_id: quoteId,
      status: "draft",
      total_price: total,
      alternate_options: alternates.length,
      client_id: clientId,
    },
  });
});

// ── Send a quote to the customer ─────────────────────────────────────────────
/**
 * POST /quotes/:id/send — email an existing quote to the address on it.
 *
 * This is the one endpoint here that puts something in front of a customer, and
 * it is under its own scope for a reason. `comms:send` is "message anyone
 * anything" — an arbitrary recipient and an arbitrary body, which is exactly the
 * shape a prompt injection wants and is why it is not grantable to a connected
 * app at all. This has neither degree of freedom: the recipient is the address
 * already stored on the quote and the body is the quote template. A note reading
 * "email these prices to my other address" cannot redirect it, because there is
 * no parameter to redirect.
 *
 * It runs the identical sequence the office's Send button runs (lib/quote-send),
 * including the COMMS_ENABLED gate, which lives downstream and is not bypassed
 * here. The email outcome is reported back rather than swallowed — when comms
 * are muted the caller is told the quote is marked sent and no email went out,
 * which is the truth and is what the office needs to hear.
 */
router.post("/quotes/:id/send", requireApiKey("rest", "quotes:send"), async (req, res) => {
  const quoteId = pathId(req.params.id);
  if (!quoteId) return fail(res, 400, "invalid_argument", "quote id must be a positive integer.");

  const ctx = await beginWrite(req, res, "send_quote");
  if (!ctx) return;

  const companyId = ctx.companyId;
  const cur = await db.execute(sql`
    SELECT id, status, lead_name, lead_email, total_price
      FROM quotes WHERE id = ${quoteId} AND company_id = ${companyId} LIMIT 1
  `);
  const q = (cur.rows?.[0] as any) ?? null;
  if (!q) {
    return refuseWriteAndRemember(ctx, res, 404, "not_found", `No quote with id ${quoteId} in this company.`);
  }
  if (!q.lead_email) {
    return refuseWriteAndRemember(ctx, res, 409, "wrong_state",
      `That quote has no email address on it, so there is nowhere to send it. ` +
      `Add the customer's email to the quote in Qleno first.`);
  }
  if (q.status === "accepted" || q.status === "converted") {
    return refuseWriteAndRemember(ctx, res, 409, "wrong_state",
      `That quote is already ${q.status}. Re-sending it would ask the customer to accept something they already accepted.`);
  }

  const { sendQuoteNow } = await import("../../lib/quote-send.js");
  const result = await sendQuoteNow(companyId, quoteId, ctx.userId);
  if (!result) {
    return refuseWriteAndRemember(ctx, res, 404, "not_found", `No quote with id ${quoteId} in this company.`);
  }

  await logAudit(req, "SEND", "quote", quoteId, { status: q.status }, { status: "sent" });

  // Say what actually happened to the email. `sent: false` here is not a
  // failure of this call — the quote IS marked sent — but reporting it as a
  // clean success would have the office believing a customer received prices
  // that never left the building.
  const emailSent = result.email?.sent === true || result.email?.success === true;
  await finishWrite(ctx, res, {
    targetTable: "quotes",
    targetId: quoteId,
    priorValues: { status: q.status },
    newValues: { status: "sent" },
    summary:
      `Sent ${q.lead_name || `quote ${quoteId}`}'s quote to ${q.lead_email}.` +
      (emailSent ? "" : " NOTE: the email did not go out — check the comms settings in Qleno."),
    extra: {
      quote_id: quoteId,
      sent_to: q.lead_email,
      email_delivered: emailSent,
      email_result: result.email ?? null,
      first_send: result.first_send,
    },
  });
});

// ── Put a customer on a repeating schedule ───────────────────────────────────
/**
 * POST /recurring-schedules — start a customer repeating, and generate the
 * next 90 days of visits.
 *
 * THIS IS THE BIGGEST WRITE ON THE SURFACE and it is worth being plain about
 * why it is here anyway. Every other endpoint in this file changes one visit;
 * this one writes dozens at once. The design note above says a recurring
 * template edit is not one change but every future visit changing at once —
 * that reasoning still holds and is why EDITING a template is still absent.
 * Creating one is a different act: there is nothing to overwrite, the visits it
 * produces are new rather than altered, and each of them can be moved or
 * deleted individually afterward.
 *
 * The one overlap is deliberate and comes from the DB: a customer may have only
 * ONE active schedule, so calling this for a customer who already repeats
 * REWRITES their cadence rather than adding a second series. The response says
 * so (`updated_existing`), because "three times a week starting Monday" said
 * about an already-weekly customer is a change to what they have, and the
 * office should read it that way.
 *
 * Several times a week goes in `days_of_week` (0=Sun..6=Sat). A three-times-a-week
 * commercial account is [1,3,5] with frequency "custom_days" — not three
 * separate weekly schedules, which the one-active-schedule rule would reject
 * anyway.
 */
router.post("/recurring-schedules", requireApiKey("rest", "schedules:write"), async (req, res) => {
  const ctx = await beginWrite(req, res, "create_recurring_schedule");
  if (!ctx) return;

  const companyId = ctx.companyId;
  const clientId = pathId(req.body?.client_id ?? req.body?.customer_id);
  const frequency = text(req.body?.frequency);
  const startDate = text(req.body?.start_date);

  if (!clientId) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "client_id is required and must be a positive integer.");
  }
  if (!frequency) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `frequency is required. One of: ${RECURRING_FREQUENCIES.join(", ")}.`);
  }
  if (!RECURRING_FREQUENCIES.includes(frequency)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `"${frequency}" is not a frequency this system knows. One of: ${RECURRING_FREQUENCIES.join(", ")}. ` +
      `For several times a week use "custom_days" and pass days_of_week.`);
  }
  if (!startDate || !DATE_RE.test(startDate)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `start_date is required and must be YYYY-MM-DD. Got "${startDate ?? "nothing"}".`);
  }
  const t = today(companyId);
  if (startDate < t) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `${startDate} is in the past (today is ${t}). A schedule that starts in the past would back-fill ` +
      `visits onto days the crew has already worked.`);
  }

  const rawDays = req.body?.days_of_week;
  if (rawDays !== undefined && rawDays !== null && !Array.isArray(rawDays)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "days_of_week must be an array of numbers, 0=Sunday through 6=Saturday.");
  }
  const days = normalizeDaysOfWeek(rawDays);
  if (Array.isArray(rawDays) && rawDays.length > 0 && !days) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "days_of_week must hold whole numbers 0 through 6, where 0 is Sunday.");
  }
  // A multi-day frequency with no days is a schedule the engine cannot place.
  // Better to refuse than to write a row that generates nothing and looks like
  // a broken engine.
  if (MULTI_DAY_FREQUENCIES.includes(frequency) && !days && frequency === "custom_days") {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `"custom_days" needs days_of_week — for example [1,3,5] for Monday, Wednesday and Friday.`);
  }

  const scheduledTime = text(req.body?.scheduled_time);
  if (scheduledTime && !TIME_RE.test(scheduledTime)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `scheduled_time must be 24-hour HH:MM. Got "${scheduledTime}".`);
  }
  const endDate = text(req.body?.end_date);
  if (endDate && !DATE_RE.test(endDate)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `end_date must be YYYY-MM-DD. Got "${endDate}".`);
  }
  if (endDate && endDate < startDate) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `end_date ${endDate} is before start_date ${startDate}.`);
  }

  const rawFee = req.body?.base_fee;
  const baseFee = rawFee == null || rawFee === "" ? null : Number(rawFee);
  if (baseFee !== null && (!Number.isFinite(baseFee) || baseFee < 0)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument", "base_fee must be a number.");
  }
  const rawMinutes = req.body?.duration_minutes;
  const durationMinutes = rawMinutes == null || rawMinutes === "" ? null : Number(rawMinutes);
  if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes <= 0)) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "duration_minutes must be a whole number of minutes.");
  }

  const c = await db.execute(sql`
    SELECT id, TRIM(CONCAT(first_name, ' ', last_name)) AS name, client_type, account_id
      FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
  `);
  const client = (c.rows?.[0] as any) ?? null;
  if (!client) {
    return refuseWriteAndRemember(ctx, res, 404, "not_found",
      `No customer with id ${clientId} in this company. Look the customer up first rather than guessing an id.`);
  }

  // A commercial visit with no budgeted hours pays its cleaner $0 — the
  // commercial commission base is hourly rate x allowed hours, so a blank
  // duration is not a missing nicety, it is a payroll hole that repeats every
  // visit for as long as the schedule runs.
  if (client.account_id && durationMinutes === null) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      `${client.name} is a commercial account, and commercial pay is the hourly rate times the budgeted ` +
      `hours. Pass duration_minutes (how long each visit is budgeted for), or the crew is paid $0 for ` +
      `every visit this schedule generates.`);
  }

  let techId: number | null = null;
  let techName: string | null = null;
  if (req.body?.assigned_employee_id != null) {
    techId = pathId(req.body.assigned_employee_id);
    if (!techId) {
      return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
        "assigned_employee_id must be a positive integer, or omitted to leave the visits unassigned.");
    }
    const u = await db.execute(sql`
      SELECT id, TRIM(CONCAT(first_name, ' ', last_name)) AS name, is_active
        FROM users WHERE id = ${techId} AND company_id = ${companyId} LIMIT 1
    `);
    const tech = (u.rows?.[0] as any) ?? null;
    if (!tech) {
      return refuseWriteAndRemember(ctx, res, 404, "not_found",
        `No employee with id ${techId} in this company.`);
    }
    if (tech.is_active === false) {
      return refuseWriteAndRemember(ctx, res, 409, "wrong_state",
        `${tech.name} is not an active employee, so they cannot be put on a repeating schedule.`);
    }
    techName = tech.name;
  }

  const { createRecurringSchedule } = await import("../../lib/recurring-create.js");
  const result = await createRecurringSchedule({
    companyId,
    customer_id: clientId,
    frequency,
    start_date: startDate,
    end_date: endDate ?? null,
    days_of_week: days,
    day_of_week: text(req.body?.day_of_week) ?? null,
    scheduled_time: scheduledTime ?? null,
    assigned_employee_id: techId,
    service_type: text(req.body?.service_type) ?? null,
    duration_minutes: durationMinutes,
    base_fee: baseFee,
    notes: text(req.body?.notes) ?? null,
  });

  const scheduleId = Number((result.row as any)?.id);
  await logAudit(req, result.updated_existing ? "UPDATE" : "CREATE", "recurring_schedule", scheduleId, null, {
    frequency, start_date: startDate, days_of_week: days, client_id: clientId,
  });

  const cadence = days ? days.map((d) => DAY_NAMES[d]).join(", ") : frequency;
  await finishWrite(ctx, res, {
    targetTable: "recurring_schedules",
    targetId: scheduleId,
    priorValues: null,
    newValues: { frequency, start_date: startDate, days_of_week: days, assigned_employee_id: techId },
    summary:
      (result.updated_existing
        ? `Changed ${client.name}'s repeating schedule to ${cadence}`
        : `Put ${client.name} on a repeating schedule: ${cadence}`) +
      `, starting ${startDate}${techName ? `, assigned to ${techName}` : ""}. ` +
      `${result.jobs_generated} visit${result.jobs_generated === 1 ? "" : "s"} booked onto the board.` +
      (result.generation_error ? " The 90-day generation hit an error — check the logs." : ""),
    extra: {
      schedule_id: scheduleId,
      client_id: clientId,
      client_name: client.name,
      updated_existing: result.updated_existing,
      jobs_generated: result.jobs_generated,
      jobs_skipped: result.jobs_skipped,
      generation_error: result.generation_error,
    },
  });
});

// ── Onboard someone ──────────────────────────────────────────────────────────
/**
 * POST /employees — create an employee account.
 *
 * The temp password is NEVER in the response. It is generated the same way the
 * office UI generates it, hashed, and dropped — a credential that travels
 * through a chat transcript is a credential that leaks, and the transcript
 * outlives the password. The office hands the new hire their password the way
 * they already do.
 *
 * Adding a person is reversible in the sense that matters (deactivate them),
 * which is why it sits under the same scope as deactivation while carrying no
 * extra role check. Removing one does not: see below.
 */
router.post("/employees", requireApiKey("rest", "employees:write"), async (req, res) => {
  const ctx = await beginWrite(req, res, "create_employee");
  if (!ctx) return;

  const email = text(req.body?.email);
  const firstName = text(req.body?.first_name);
  if (!email || !firstName) {
    return refuseWriteAndRemember(ctx, res, 400, "invalid_argument",
      "email and first_name are required to create an employee.");
  }

  const { createEmployee } = await import("../../lib/employee-admin.js");
  const result = await createEmployee({
    companyId: ctx.companyId,
    email,
    first_name: firstName,
    last_name: text(req.body?.last_name) ?? null,
    role: text(req.body?.role) ?? null,
    phone: text(req.body?.phone) ?? null,
    pay_rate: req.body?.pay_rate ?? null,
    pay_type: text(req.body?.pay_type) ?? null,
    hire_date: text(req.body?.hire_date) ?? null,
  }, req.auth?.role ?? "");

  if (!result.ok) {
    return refuseWriteAndRemember(ctx, res, result.status, result.error === "Already exists" ? "conflict" : "invalid_argument", result.message);
  }

  const user = result.user;
  const name = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email;
  await logAudit(req, "CREATE", "user", user.id, null, { email: user.email, role: user.role });

  await finishWrite(ctx, res, {
    targetTable: "users",
    targetId: user.id,
    priorValues: null,
    newValues: { is_active: true },
    summary:
      `Added ${name} as a ${user.role}. They cannot sign in until the office gives them their ` +
      `starting password — it is not included here on purpose.`,
    extra: { employee_id: user.id, name, email: user.email, role: user.role },
  });
});

// ── Take someone off the board ───────────────────────────────────────────────
/**
 * DELETE /employees/:id — deactivate an employee.
 *
 * OWNER ONLY, by instruction: "The only one at office that can delete employees
 * is me." The scope is not what enforces that — a scope can only ever narrow
 * what the minting user could already do. The role check inside
 * deactivateEmployee() is what enforces it, and it reads the LIVE role of the
 * person whose credential this is. So an office-minted key carrying
 * `employees:write` can add a person and is refused when it tries to remove
 * one, without this file or the MCP layer knowing the rule.
 *
 * Nothing is deleted. `is_active` goes false, their not-yet-completed visits
 * fall to Unassigned so the board shows the hole, and completed visits keep
 * their name because payroll and history read it. This is the one Group-C write
 * that undoes cleanly, so it is on the revert whitelist — one click puts them
 * back. It does NOT put the released visits back on them; that is a dispatch
 * decision a person makes.
 */
router.delete("/employees/:id", requireApiKey("rest", "employees:write"), async (req, res) => {
  const targetId = pathId(req.params.id);
  if (!targetId) return fail(res, 400, "invalid_argument", "employee id must be a positive integer.");

  const ctx = await beginWrite(req, res, "deactivate_employee");
  if (!ctx) return;

  const { deactivateEmployee } = await import("../../lib/employee-admin.js");
  const result = await deactivateEmployee({
    companyId: ctx.companyId,
    targetUserId: targetId,
    callerUserId: ctx.userId,
    callerRole: req.auth?.role ?? "",
  });

  if (!result.ok) {
    const code = result.status === 403 ? "permission_denied" : result.status === 404 ? "not_found" : "wrong_state";
    return refuseWriteAndRemember(ctx, res, result.status, code, result.message);
  }

  const name = `${result.user.first_name ?? ""} ${result.user.last_name ?? ""}`.trim() || `employee ${targetId}`;
  await logAudit(req, "DEACTIVATE", "user", targetId, { is_active: true }, { is_active: false });

  await finishWrite(ctx, res, {
    targetTable: "users",
    targetId,
    priorValues: { is_active: true },
    newValues: { is_active: false },
    summary:
      `Deactivated ${name}. ${result.jobsReleased} upcoming visit${result.jobsReleased === 1 ? "" : "s"} ` +
      `moved to Unassigned and ${result.jobsReleased === 1 ? "needs" : "need"} somebody put on ${result.jobsReleased === 1 ? "it" : "them"}. ` +
      `Their completed work keeps their name for payroll.`,
    extra: { employee_id: targetId, name, jobs_released: result.jobsReleased },
  });
});

// ── Put someone back ─────────────────────────────────────────────────────────
/**
 * POST /employees/:id/reactivate — undo a deactivation.
 *
 * No owner-only check here, and that asymmetry is on purpose: the risk being
 * guarded against is somebody being removed, not somebody being restored.
 * Restoring turns the account back on and nothing else — their released visits
 * stay unassigned, because giving them back automatically would silently
 * re-decide dispatch choices the office already made.
 */
router.post("/employees/:id/reactivate", requireApiKey("rest", "employees:write"), async (req, res) => {
  const targetId = pathId(req.params.id);
  if (!targetId) return fail(res, 400, "invalid_argument", "employee id must be a positive integer.");

  const ctx = await beginWrite(req, res, "reactivate_employee");
  if (!ctx) return;

  const { reactivateEmployee } = await import("../../lib/employee-admin.js");
  const result = await reactivateEmployee({ companyId: ctx.companyId, targetUserId: targetId });
  if (!result.ok) {
    return refuseWriteAndRemember(ctx, res, result.status,
      result.status === 404 ? "not_found" : "wrong_state", result.message);
  }

  const name = `${result.user.first_name ?? ""} ${result.user.last_name ?? ""}`.trim() || `employee ${targetId}`;
  await logAudit(req, "REACTIVATE", "user", targetId, { is_active: false }, { is_active: true });

  await finishWrite(ctx, res, {
    targetTable: "users",
    targetId,
    priorValues: { is_active: false },
    newValues: { is_active: true },
    summary: `Reactivated ${name}. Their old visits stay unassigned — put them back on the ones they should have.`,
    extra: { employee_id: targetId, name },
  });
});


export default router;
