// Robust scope-name → service_type enum resolver.
//
// Why this exists: quote→job convert used to look the scope NAME up in a strict
// exact-match table and silently fall back to `standard_clean` on any miss. The
// quote-builder's hourly sub-type selector matches scopes LOOSELY (regex), so a
// scope named with slightly different punctuation/spacing (e.g. "Hourly Move-In /
// Move-Out") passed the UI match but missed the strict table — collapsing every
// such booking to "Standard Clean" on the job card and confirmation email.
//
// Keyword matching (substring, most-specific-first) removes that whole failure
// class. PHES treats "Move In / Move Out" as ONE product mapped to `move_out`;
// standalone "move in" stays `move_in` for the public booking path that offers
// them as separate cards. Values here must stay in sync with serviceTypeEnum
// (lib/db/src/schema/jobs.ts).
export function resolveServiceType(scopeName: string | null | undefined): string {
  const n = (scopeName || "").toLowerCase().trim();
  if (!n) return "standard_clean";
  if (n.includes("move out") || n.includes("move-out") || (n.includes("move in") && n.includes("out"))) return "move_out";
  if (n.includes("move in") || n.includes("move-in")) return "move_in";
  if (n.includes("post construction") || n.includes("post-construction")) return "post_construction";
  if (n.includes("post event") || n.includes("post-event")) return "post_event";
  if (n.includes("deep")) return "deep_clean";
  if (n.includes("carpet")) return "carpet_cleaning";
  if (n.includes("ppm") && n.includes("turnover")) return "ppm_turnover";
  if (n.includes("common area")) return "common_areas";
  if (n.includes("recurring")) return "recurring";
  if (n.includes("retail")) return "retail_store";
  if (n.includes("medical")) return "medical_office";
  if (n.includes("office") || n.includes("commercial")) return "office_cleaning";
  return "standard_clean";
}
