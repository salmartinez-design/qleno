// Robust scope-name → service_type enum resolver.
//
// Why this exists: quote→job convert used to look the scope NAME up in a strict
// exact-match table and silently fall back to `standard_clean` on any miss. The
// quote-builder's hourly sub-type selector matches scopes LOOSELY (regex), so a
// scope named with slightly different punctuation/spacing (e.g. "Hourly Move-In /
// Move-Out") passed the UI match but missed the strict table — collapsing every
// such booking to "Standard Clean" on the job card and confirmation email.
//
// Keyword matching removes that whole failure class. PHES treats
// "Move In / Move Out" as ONE product mapped to `move_out`; standalone "move in"
// stays `move_in` for the public booking path that offers them as separate
// cards. Values here must stay in sync with serviceTypeEnum
// (lib/db/src/schema/jobs.ts).
//
// [combined-scope mixup 2026-08-14] This used to be a fixed if-chain that tested
// the move keywords BEFORE "deep". PHES has live scopes whose names contain
// both — "Deep Clean or Move In/Out" and "Hourly Deep Clean or Move In/Out" —
// and neither is in convert's strict SCOPE_TO_ENUM table, so both fell through
// to here and always came back `move_out`. A Deep Clean booking was stamped
// move_out and the job card read "Move Out", which is what the office kept
// reporting as "the quoting tool mixes up Move in/out with Deep Clean".
//
// A fixed order can't resolve a name that genuinely names two services. So
// instead of hardcoding which one wins, match on WHERE each keyword appears and
// take the earliest — the same way a person reads "Deep Clean or Move In/Out"
// as primarily a deep clean. Names with only one service keyword are unaffected;
// ties fall back to the old most-specific-first order.

/** Earliest index at which any of `needles` occurs, or -1 if none do. */
function firstIdx(haystack: string, needles: string[]): number {
  let best = -1;
  for (const needle of needles) {
    const i = haystack.indexOf(needle);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

// Ordered most-specific-first. The order still decides ties; position decides
// everything else.
const MATCHERS: Array<{ needles: string[]; type: string }> = [
  { needles: ["post construction", "post-construction"], type: "post_construction" },
  { needles: ["post event", "post-event"], type: "post_event" },
  { needles: ["deep"], type: "deep_clean" },
  { needles: ["carpet"], type: "carpet_cleaning" },
  { needles: ["common area"], type: "common_areas" },
  { needles: ["recurring"], type: "recurring" },
  { needles: ["retail"], type: "retail_store" },
  { needles: ["medical"], type: "medical_office" },
  { needles: ["office", "commercial"], type: "office_cleaning" },
];

export function resolveServiceType(scopeName: string | null | undefined): string {
  const n = (scopeName || "").toLowerCase().trim();
  if (!n) return "standard_clean";

  // "PPM Turnover" needs both words and beats a bare "turnover", so it stays a
  // standalone check ahead of the positional pass.
  if (n.includes("ppm") && n.includes("turnover")) return "ppm_turnover";

  const candidates: Array<{ idx: number; rank: number; type: string }> = [];

  // The move family is ONE matcher: its position is the earliest "move", and
  // whether it means move_out or move_in is decided by the rest of the name.
  // Splitting it would let "move in / move out" match twice at two positions.
  const moveIdx = firstIdx(n, ["move in", "move-in", "move out", "move-out"]);
  if (moveIdx !== -1) {
    const isOut = n.includes("move out") || n.includes("move-out") || n.includes("out");
    candidates.push({ idx: moveIdx, rank: 0, type: isOut ? "move_out" : "move_in" });
  }

  MATCHERS.forEach((m, rank) => {
    const idx = firstIdx(n, m.needles);
    if (idx !== -1) candidates.push({ idx, rank: rank + 1, type: m.type });
  });

  if (!candidates.length) return "standard_clean";
  candidates.sort((a, b) => (a.idx !== b.idx ? a.idx - b.idx : a.rank - b.rank));
  return candidates[0].type;
}
