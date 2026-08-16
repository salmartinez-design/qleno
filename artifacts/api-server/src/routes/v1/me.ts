import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireApiKey } from "../../lib/api-auth.js";
import { READ_SCOPES, WRITE_SCOPES } from "../../lib/api-keys.js";
import { countFor, companyOf, MAX_LIMIT, DEFAULT_LIMIT } from "./_shared.js";

// [ai-access 2026-08-15] Identity + capability discovery for Qleno Connect.
//
// This is the first call any integration should make, and the one an assistant
// should make before it guesses. It answers three questions no amount of trying
// endpoints answers cleanly: which company am I acting for, what am I allowed
// to do, and what am I NOT allowed to do. Publishing the missing scopes
// alongside the granted ones is deliberate — an assistant that gets a 403
// halfway through a task has already half-done it; one that can see up front
// that it lacks `jobs:write` says so before it starts.
//
// Requires no scope beyond a valid key. A key that cannot describe itself is
// undebuggable from the caller's side.
const router = Router();

router.get("/me", requireApiKey("rest"), async (req, res) => {
  const companyId = companyOf(req);
  const key = req.apiKey!;
  const userId = req.auth!.userId;

  // The user is joined WITH an explicit company scope, not just by id. The id
  // came from a verified key so it is already trustworthy — but a join that
  // reads a users row without naming the tenant is the pattern that gets copied
  // into a handler where the id came from the caller.
  const rows = await db.execute(sql`
    SELECT c.id, c.name, c.timezone, c.plan, c.api_access_enabled,
           u.id AS user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS user_name,
           u.email, u.role
    FROM companies c
    JOIN users u ON u.id = ${userId} AND u.company_id = ${companyId}
    WHERE c.id = ${companyId}
    LIMIT 1
  `);
  const r = (rows.rows as any[])[0] ?? {};

  const granted = key.scopes;
  const missing = [...READ_SCOPES, ...WRITE_SCOPES].filter((s) => !granted.includes(s));

  countFor(res, 1);
  res.json({
    company: {
      id: Number(r.id ?? companyId),
      name: r.name ?? null,
      // Every date in this API is a calendar date in the company's own timezone,
      // never UTC. An assistant computing "today" needs to know which one.
      timezone: r.timezone ?? "America/Chicago",
      plan: r.plan ?? null,
    },
    key: {
      id: key.keyId,
      name: key.name,
      // The key acts as this person. Anything it writes is attributed to them,
      // and deactivating them stops the key on the next request.
      acting_as: {
        user_id: Number(r.user_id ?? userId),
        name: r.user_name ?? null,
        email: r.email ?? null,
        role: r.role ?? null,
      },
      scopes: granted,
      missing_scopes: missing,
    },
    limits: {
      requests_per_minute: 300,
      default_page_size: DEFAULT_LIMIT,
      max_page_size: MAX_LIMIT,
    },
    // Stated, not implied. v1 is read-only; write endpoints are a later phase and
    // will require both a write scope and an explicit confirm on anything
    // irreversible. An assistant told this up front stops looking for a way to
    // book a job through an endpoint that does not exist yet.
    capabilities: {
      read: true,
      write: false,
      write_note: "Version 1 is read-only. Write access ships in a later release and will require a write scope plus explicit confirmation on irreversible actions.",
    },
    api_version: "v1",
  });
});

export default router;
