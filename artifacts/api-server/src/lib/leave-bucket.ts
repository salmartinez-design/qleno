/**
 * Map a leave_type slug to the canonical bucket tag written into
 * employee_leave_usage note text ("usage/<bucket>").
 *
 * The per-bucket "View History" modal on the employee profile filters usage
 * rows on a "/pto" vs "/plawa" substring (the same convention the [MC import]
 * rows already use). Tagging app-approved usage rows by bucket keeps PTO and
 * Sick history complete for leave approved going forward; unpaid/unexcused get
 * their own self-describing tags and stay out of the PTO/Sick views (correct).
 */
export function slugToBucket(slug?: string | null): string {
  const s = String(slug ?? "").toLowerCase();
  if (s === "plawa" || s.includes("plawa") || s.includes("sick")) return "plawa";
  if (s.includes("pto")) return "pto";
  if (s.includes("unpaid")) return "unpaid";
  if (s.includes("unexcused")) return "unexcused";
  return s || "other";
}
