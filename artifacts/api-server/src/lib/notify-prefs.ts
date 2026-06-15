import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Per-user notification preferences ─────────────────────────────────────────
// Categories: messages | new_jobs | job_changes. Channels: inapp | email.
// A pref column NULL = fall back to a role-sensible default; explicit true/false
// = the user's choice. notification type → category mapping is centralized here.

export type Category = "messages" | "new_jobs" | "job_changes";
export type Channel = "inapp" | "email" | "push";

export const TYPE_TO_CATEGORY: Record<string, Category> = {
  new_message: "messages",
  job_assigned: "new_jobs",
  job_changed: "job_changes",
};

// Role-sensible defaults (in-app). Email defaults OFF everywhere (opt-in).
//  - messages    → office ON, techs OFF
//  - new_jobs    → techs ON, office OFF
//  - job_changes → techs ON, office OFF
function roleDefault(role: string, category: Category, channel: Channel): boolean {
  if (channel === "email") return false; // email opt-in everywhere
  const isOffice = ["owner", "admin", "office", "super_admin"].includes(role);
  const isTech = ["technician", "team_lead"].includes(role);
  // in-app AND push share the same role defaults: techs → job categories on;
  // office → messages on. (Push only actually fires once the device is subscribed.)
  if (category === "messages") return isOffice;
  if (category === "new_jobs") return isTech;
  if (category === "job_changes") return isTech;
  return false;
}

export interface EffectivePrefs {
  messages_inapp: boolean; messages_email: boolean; messages_push: boolean;
  new_jobs_inapp: boolean; new_jobs_email: boolean; new_jobs_push: boolean;
  job_changes_inapp: boolean; job_changes_email: boolean; job_changes_push: boolean;
}

export async function getEffectivePrefs(userId: number): Promise<EffectivePrefs & { role: string }> {
  const ur = await db.execute(sql`SELECT role FROM users WHERE id = ${userId} LIMIT 1`);
  const role = String((ur.rows[0] as any)?.role ?? "");
  const pr = await db.execute(sql`SELECT * FROM notification_prefs WHERE user_id = ${userId} LIMIT 1`);
  const p: any = pr.rows[0] ?? {};
  const eff = (col: string, cat: Category, ch: Channel) =>
    p[col] === true ? true : p[col] === false ? false : roleDefault(role, cat, ch);
  return {
    role,
    messages_inapp: eff("messages_inapp", "messages", "inapp"),
    messages_email: eff("messages_email", "messages", "email"),
    messages_push: eff("messages_push", "messages", "push"),
    new_jobs_inapp: eff("new_jobs_inapp", "new_jobs", "inapp"),
    new_jobs_email: eff("new_jobs_email", "new_jobs", "email"),
    new_jobs_push: eff("new_jobs_push", "new_jobs", "push"),
    job_changes_inapp: eff("job_changes_inapp", "job_changes", "inapp"),
    job_changes_email: eff("job_changes_email", "job_changes", "email"),
    job_changes_push: eff("job_changes_push", "job_changes", "push"),
  };
}

// Is a given channel allowed for the user, for the category implied by `type`?
// Types with no category mapping (e.g. new_booking) are always allowed.
export async function isAllowed(userId: number, type: string, channel: Channel): Promise<boolean> {
  const cat = TYPE_TO_CATEGORY[type];
  if (!cat) return true;
  const p = await getEffectivePrefs(userId);
  return (p as any)[`${cat}_${channel}`] === true;
}
