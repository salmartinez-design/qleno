/**
 * Repair the addresses that were saved incomplete, and the zones that were
 * never assigned.
 *
 * [quote-address-cascade 2026-08-19] #1513 stopped the leak: a converted quote
 * now splits its one-line address into components and resolves the zone. It
 * changed nothing already in the database. Every client and job created from a
 * quote before that deploy still has the whole address crammed into one column
 * with city, state and zip empty — Cynthiia Lopezz (CL-1533) reading "17878
 * Argos Court, Tinley Park, IL 60477" with three blank columns beside it — and
 * jobs sitting on the board with a valid zip and no zone.
 *
 * Two endpoints, PREVIEW then APPLY, the same shape as the tz-audit /
 * tz-backfill pair the office already uses for clock corrections. Nothing is
 * written until someone with the authority to do it asks twice.
 *
 * ── THE RULES, AND WHY ───────────────────────────────────────────────────────
 *
 *  1. NEVER overwrite a value that is already there. This only fills blanks. A
 *     city somebody typed by hand outranks a parse of a stale one-line copy,
 *     always — that is the whole reason fillAddressGaps exists.
 *
 *  2. Only fill from a confident parse. parseAddressLine hands back nulls
 *     rather than guesses; a row it cannot read is left exactly as it is and
 *     reported as unparseable, so the office can fix it at the source. A wrong
 *     city routes a cleaner to the wrong town and prints a wrong address on the
 *     customer's confirmation — worse in every way than a blank one.
 *
 *  3. A zone is only set when the zip maps to an ACTIVE zone of that same
 *     company. No cross-tenant match is possible, and an unmapped zip stays
 *     null: a grey tile is visible and fixable, an invented zone is neither.
 *
 *  4. PAST jobs are left alone by default. A finished visit records where the
 *     service actually happened; re-deriving its address later is rewriting
 *     history. `include_past=true` is available for a deliberate cleanup.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { parseAddressLine } from "../lib/parse-address.js";

const router = Router();

interface ClientFix {
  id: number; name: string; address: string;
  set: { city?: string; state?: string; zip?: string };
}
interface JobFix {
  id: number; date: string; name: string;
  set: { address_city?: string; address_state?: string; address_zip?: string; zone_id?: number };
  from: string;
}

/** Everything the repair would touch. Reads only; used by both endpoints. */
async function planRepair(companyId: number, includePast: boolean) {
  // ── Clients whose components are blank but derivable from their own line ──
  const clientRows = (await db.execute(sql`
    SELECT id, address, city, state, zip,
           NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '') AS name
      FROM clients
     WHERE company_id = ${companyId}
       AND NULLIF(BTRIM(address), '') IS NOT NULL
       AND (NULLIF(BTRIM(city),'') IS NULL OR NULLIF(BTRIM(state),'') IS NULL OR NULLIF(BTRIM(zip),'') IS NULL)
     ORDER BY id`) as any).rows as any[];

  const clientFixes: ClientFix[] = [];
  const clientUnparseable: Array<{ id: number; name: string; address: string }> = [];
  for (const c of clientRows) {
    const p = parseAddressLine(c.address);
    const set: ClientFix["set"] = {};
    // Rule 1: fill blanks only.
    if (!String(c.city ?? "").trim() && p.city) set.city = p.city;
    if (!String(c.state ?? "").trim() && p.state) set.state = p.state;
    if (!String(c.zip ?? "").trim() && p.zip) set.zip = p.zip;
    if (Object.keys(set).length) {
      clientFixes.push({ id: Number(c.id), name: c.name || `client ${c.id}`, address: c.address, set });
    } else {
      clientUnparseable.push({ id: Number(c.id), name: c.name || `client ${c.id}`, address: c.address });
    }
  }

  // ── Jobs missing components or a zone ────────────────────────────────────
  // The client's stored values are preferred over a parse of the job's own
  // line, for the same reason as everywhere else: the customer record is
  // canonical and may already have been corrected.
  const jobRows = (await db.execute(sql`
    SELECT j.id, j.scheduled_date::text AS date, j.zone_id,
           j.address_street, j.address_city, j.address_state, j.address_zip,
           c.address AS c_address, c.city AS c_city, c.state AS c_state, c.zip AS c_zip,
           COALESCE(a.account_name,
                    NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''),
                    'job ' || j.id::text) AS name
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
     WHERE j.company_id = ${companyId}
       AND j.status IN ('scheduled', 'in_progress')
       ${includePast ? sql`` : sql`AND j.scheduled_date >= CURRENT_DATE`}
       AND (
         j.zone_id IS NULL
         OR (NULLIF(BTRIM(j.address_street), '') IS NOT NULL
             AND (NULLIF(BTRIM(j.address_city),'') IS NULL OR NULLIF(BTRIM(j.address_zip),'') IS NULL))
       )
     ORDER BY j.scheduled_date, j.id`) as any).rows as any[];

  const jobFixes: JobFix[] = [];
  const jobNoZone: Array<{ id: number; date: string; name: string; zip: string | null }> = [];
  for (const j of jobRows) {
    const set: JobFix["set"] = {};
    let source = "";

    // Components: only for a job that HAS its own street (one that doesn't
    // simply inherits the client's whole address and needs nothing).
    if (String(j.address_street ?? "").trim()) {
      const p = parseAddressLine(j.address_street);
      const city = String(j.c_city ?? "").trim() || p.city;
      const state = String(j.c_state ?? "").trim() || p.state;
      const zip = String(j.c_zip ?? "").trim() || p.zip;
      if (!String(j.address_city ?? "").trim() && city) { set.address_city = city; source = "client + parse"; }
      if (!String(j.address_state ?? "").trim() && state) set.address_state = state;
      if (!String(j.address_zip ?? "").trim() && zip) set.address_zip = zip;
    }

    // Zone: from whatever zip we can establish, mapped to one of THIS
    // company's active zones. Resolved in SQL at apply time; previewed here.
    const effZip = String(set.address_zip ?? j.address_zip ?? j.c_zip ?? "").replace(/\D/g, "").slice(0, 5);
    if (j.zone_id == null && effZip.length === 5) {
      const z = (await db.execute(sql`
        SELECT id FROM service_zones
         WHERE company_id = ${companyId} AND is_active = true
           AND zip_codes @> ARRAY[${effZip}]::text[]
         LIMIT 1`) as any).rows[0];
      if (z) { set.zone_id = Number(z.id); if (!source) source = "zip → zone"; }
      else jobNoZone.push({ id: Number(j.id), date: j.date, name: j.name, zip: effZip });
    } else if (j.zone_id == null) {
      jobNoZone.push({ id: Number(j.id), date: j.date, name: j.name, zip: effZip || null });
    }

    if (Object.keys(set).length) {
      jobFixes.push({ id: Number(j.id), date: j.date, name: j.name, set, from: source || "parse" });
    }
  }

  return { clientFixes, clientUnparseable, jobFixes, jobNoZone };
}

/**
 * GET /api/address-repair/audit — what WOULD change. Writes nothing.
 *
 * Office-readable: this is a data-quality report and the office is who fixes
 * the rows it cannot repair automatically.
 */
router.get("/audit", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const includePast = String(req.query.include_past ?? "") === "true";
    const plan = await planRepair(companyId, includePast);
    return res.json({
      include_past: includePast,
      clients: {
        would_fix: plan.clientFixes.length,
        unparseable: plan.clientUnparseable.length,
        sample: plan.clientFixes.slice(0, 25),
        unparseable_sample: plan.clientUnparseable.slice(0, 25),
      },
      jobs: {
        would_fix: plan.jobFixes.length,
        no_zone_possible: plan.jobNoZone.length,
        sample: plan.jobFixes.slice(0, 25),
        // A zip in none of the tenant's zones. Not a bug to fix here — either
        // the zone list needs that zip, or the job is genuinely out of area.
        no_zone_sample: plan.jobNoZone.slice(0, 25),
      },
    });
  } catch (err) {
    console.error("[address-repair] audit:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * POST /api/address-repair/apply — write the plan above.
 *
 * Owner only, mirroring tz-backfill: this rewrites customer records in bulk and
 * is not an everyday action. Returns exactly what it changed.
 */
router.post("/apply", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const includePast = req.body?.include_past === true;
    const plan = await planRepair(companyId, includePast);

    let clientsFixed = 0;
    for (const c of plan.clientFixes) {
      // COALESCE guards the write as well as the plan: if the row gained a city
      // between the preview and now, the existing value still wins.
      await db.execute(sql`
        UPDATE clients SET
          city  = COALESCE(NULLIF(BTRIM(city), ''),  ${c.set.city ?? null}),
          state = COALESCE(NULLIF(BTRIM(state), ''), ${c.set.state ?? null}),
          zip   = COALESCE(NULLIF(BTRIM(zip), ''),   ${c.set.zip ?? null})
         WHERE id = ${c.id} AND company_id = ${companyId}`);
      clientsFixed++;
    }

    let jobsFixed = 0;
    for (const j of plan.jobFixes) {
      await db.execute(sql`
        UPDATE jobs SET
          address_city  = COALESCE(NULLIF(BTRIM(address_city), ''),  ${j.set.address_city ?? null}),
          address_state = COALESCE(NULLIF(BTRIM(address_state), ''), ${j.set.address_state ?? null}),
          address_zip   = COALESCE(NULLIF(BTRIM(address_zip), ''),   ${j.set.address_zip ?? null}),
          zone_id       = COALESCE(zone_id, ${j.set.zone_id ?? null})
         WHERE id = ${j.id} AND company_id = ${companyId}`);
      jobsFixed++;
    }

    console.log(`[address-repair] company ${companyId}: ${clientsFixed} client(s), ${jobsFixed} job(s) repaired`);
    return res.json({
      ok: true,
      clients_fixed: clientsFixed,
      jobs_fixed: jobsFixed,
      clients_unparseable: plan.clientUnparseable.length,
      jobs_still_without_zone: plan.jobNoZone.length,
    });
  } catch (err) {
    console.error("[address-repair] apply:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
