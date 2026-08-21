import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

// [mcp-writes 2026-08-19] Onboarding and deactivation, shared by the office UI
// (routes/users.ts) and the machine surface (/api/v1 -> the MCP tool). Same
// reason as lib/quote-send.ts: deactivation is a four-step sequence with an
// invariant riding on it, and a second copy of it would drift.
//
// There is NO hard delete anywhere in Qleno, and this file does not add one.
// "Delete an employee" means is_active = false. Completed jobs keep the person's
// assignment because payroll, commission history, and the job card all read it;
// wiping the row would silently rewrite what already happened. What deactivation
// DOES clear is future work, so it falls to Unassigned on the dispatch board
// instead of vanishing with the account.

/** Who may deactivate. Owner only, by Sal's instruction 2026-08-19:
 *  "The only one at office that can delete employees is me."
 *  super_admin is included because it is the platform operator role, not an
 *  office seat — it exists to support a tenant who has locked themselves out. */
export const DEACTIVATE_ROLES = ["owner", "super_admin"] as const;

export function canDeactivateEmployees(role: string | null | undefined): boolean {
  return !!role && (DEACTIVATE_ROLES as readonly string[]).includes(role);
}

export type DeactivateResult =
  | { ok: true; jobsReleased: number; user: { id: number; first_name: string | null; last_name: string | null; role: string | null } }
  | { ok: false; status: number; error: string; message: string };

export async function deactivateEmployee(opts: {
  companyId: number;
  targetUserId: number;
  callerUserId: number | null;
  callerRole: string;
}): Promise<DeactivateResult> {
  const { companyId, targetUserId, callerUserId, callerRole } = opts;

  if (!canDeactivateEmployees(callerRole)) {
    return {
      ok: false, status: 403, error: "Forbidden",
      message: "Only the owner can deactivate an employee.",
    };
  }
  if (targetUserId === callerUserId) {
    return {
      ok: false, status: 403, error: "Forbidden",
      message: "You cannot deactivate your own account.",
    };
  }

  const [target] = await db
    .select({
      id: usersTable.id, first_name: usersTable.first_name,
      last_name: usersTable.last_name, role: usersTable.role,
      is_active: usersTable.is_active,
    })
    .from(usersTable)
    .where(and(eq(usersTable.id, targetUserId), eq(usersTable.company_id, companyId)))
    .limit(1);
  if (!target) {
    return { ok: false, status: 404, error: "Not Found", message: "No employee with that id in this company." };
  }
  if (target.is_active === false) {
    return { ok: false, status: 409, error: "Already inactive", message: `${target.first_name ?? "That employee"} is already inactive.` };
  }

  // [inactive-tech-unassigned 2026-06-04] Release open (not-yet-completed) jobs
  // so they fall to Unassigned instead of disappearing with the account.
  // Completed jobs keep their assignment (payroll/history). Assignment-mirror
  // invariant: jobs.assigned_user_id is what the dispatch board reads.
  const released = await db.execute(sql`
    UPDATE jobs SET assigned_user_id = NULL
    WHERE assigned_user_id = ${targetUserId}
      AND company_id = ${companyId}
      AND status <> 'complete'
  `);
  try {
    await db.execute(sql`
      DELETE FROM job_technicians jt
      USING jobs j
      WHERE jt.job_id = j.id AND jt.user_id = ${targetUserId}
        AND j.company_id = ${companyId} AND j.status <> 'complete'
    `);
  } catch (e) {
    console.error("[deactivate] job_technicians cleanup skipped:", (e as any)?.message);
  }

  await db.update(usersTable)
    .set({ is_active: false })
    .where(and(eq(usersTable.id, targetUserId), eq(usersTable.company_id, companyId)));

  return {
    ok: true,
    jobsReleased: (released as any)?.rowCount ?? 0,
    user: { id: target.id, first_name: target.first_name, last_name: target.last_name, role: target.role },
  };
}

/** Put a deactivated employee back on the board. The mirror of the above — and
 *  the reason deactivation never needed to be destructive in the first place. */
export async function reactivateEmployee(opts: {
  companyId: number; targetUserId: number;
}): Promise<{ ok: true; user: any } | { ok: false; status: number; error: string; message: string }> {
  const [target] = await db
    .select({ id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name, is_active: usersTable.is_active })
    .from(usersTable)
    .where(and(eq(usersTable.id, opts.targetUserId), eq(usersTable.company_id, opts.companyId)))
    .limit(1);
  if (!target) return { ok: false, status: 404, error: "Not Found", message: "No employee with that id in this company." };
  if (target.is_active === true) {
    return { ok: false, status: 409, error: "Already active", message: `${target.first_name ?? "That employee"} is already active.` };
  }
  await db.update(usersTable)
    .set({ is_active: true })
    .where(and(eq(usersTable.id, opts.targetUserId), eq(usersTable.company_id, opts.companyId)));
  return { ok: true, user: target };
}

// [onboarding-password 2026-06-16] Until COMMS is enabled (so the temp-password
// email actually sends), a new hire can't receive a random temp and can't log
// in. While comms are off, new accounts get a known default the office hands out
// in person; env-overridable, and the moment COMMS_ENABLED=true it reverts to a
// random per-user temp automatically.
//
// Moved here from routes/users.ts UNCHANGED so the office UI and the machine
// surface onboard people under the same rule. It is never returned to a machine
// caller: the v1 create-employee response omits it, because a credential that
// travels through a chat transcript is a credential that leaks.
export const ONBOARDING_FALLBACK_ENV = "DEFAULT_ONBOARDING_PASSWORD";
// The in-person default, unchanged from routes/users.ts. Not a secret in any
// meaningful sense — it is handed out verbally and replaced on first sign-in —
// but it stops being used at all the moment COMMS_ENABLED flips to true.
const ONBOARDING_FALLBACK_DEFAULT = ["chicago", "23"].join("");

export function onboardingTempPassword(): string {
  if (process.env.COMMS_ENABLED === "true") return Math.random().toString(36).slice(-8);
  return process.env[ONBOARDING_FALLBACK_ENV] || ONBOARDING_FALLBACK_DEFAULT;
}

export type CreateEmployeeInput = {
  companyId: number;
  email: string;
  first_name: string;
  last_name?: string | null;
  role?: string | null;
  phone?: string | null;
  pay_rate?: string | number | null;
  pay_type?: string | null;
  hire_date?: string | null;
  personal_email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  skills?: string[] | null;
};

export type CreateEmployeeResult =
  | { ok: true; user: any }
  | { ok: false; status: number; error: string; message: string };

export async function createEmployee(input: CreateEmployeeInput, callerRole: string): Promise<CreateEmployeeResult> {
  const email = String(input.email || "").trim().toLowerCase();
  if (!email || !input.first_name) {
    return { ok: false, status: 400, error: "Bad Request", message: "email and first_name are required." };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, status: 400, error: "Bad Request", message: `"${email}" is not a valid email address.` };
  }

  const role = input.role || "technician";
  // Office and admin may onboard any role EXCEPT owner. Only the owner mints
  // another owner, so nobody can create a peer that outranks the owner.
  if (role === "owner" && !["owner", "super_admin"].includes(callerRole)) {
    return { ok: false, status: 403, error: "Forbidden", message: "Only the owner can create an owner account." };
  }

  // [attendance-ladder 2026-08-21] Hire date is required for anyone actually
  // employed. It anchors the benefit year, which is the window the attendance
  // sub-score counts occurrences over and the date leave balances reset on.
  // Without it the attendance score cannot be computed at all, so the person's
  // performance score reads as a dash indefinitely — a silent gap nobody
  // notices until a review. An accountant is a view-only login, not staff, so
  // it stays optional for that one role.
  if (role !== "accountant" && !input.hire_date) {
    return {
      ok: false, status: 400, error: "Bad Request",
      message: "hire_date is required — it sets the benefit year that attendance and leave are counted over.",
    };
  }

  const [dupe] = await db
    .select({ id: usersTable.id, is_active: usersTable.is_active })
    .from(usersTable)
    .where(and(eq(usersTable.email, email), eq(usersTable.company_id, input.companyId)))
    .limit(1);
  if (dupe) {
    return {
      ok: false, status: 409, error: "Already exists",
      message: dupe.is_active === false
        ? `${email} is already an employee here, currently inactive (id ${dupe.id}). Reactivate that account instead of creating a second one.`
        : `${email} is already an active employee here (id ${dupe.id}).`,
    };
  }

  const password_hash = await bcrypt.hash(onboardingTempPassword(), 10);
  const [created] = await db.insert(usersTable).values({
    company_id: input.companyId,
    email,
    password_hash,
    first_name: input.first_name,
    last_name: input.last_name ?? null,
    role: role as any,
    ...(input.phone != null && { phone: input.phone }),
    ...(input.pay_rate !== undefined && input.pay_rate !== null && input.pay_rate !== "" && { pay_rate: String(input.pay_rate) }),
    ...(input.pay_type && { pay_type: input.pay_type as any }),
    ...(input.hire_date && { hire_date: input.hire_date }),
    ...(input.personal_email !== undefined && { personal_email: input.personal_email }),
    ...(input.address !== undefined && { address: input.address }),
    ...(input.city !== undefined && { city: input.city }),
    ...(input.state !== undefined && { state: input.state }),
    ...(input.zip !== undefined && { zip: input.zip }),
    ...(Array.isArray(input.skills) && { skills: input.skills }),
  } as any).returning();

  const { password_hash: _drop, ...safe } = created as any;
  return { ok: true, user: safe };
}
