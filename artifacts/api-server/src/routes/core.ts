/**
 * Cutover 1A — `/api/core/*` read endpoints (data backbone verification).
 *
 * Thin, tenant-scoped GET endpoints so 1B (tech day view) has stable
 * shapes to read from and 1A's migration can be verified end-to-end on
 * production without poking at the DB directly. No business logic,
 * no writes, no clock semantics. Three endpoints:
 *
 *   GET /api/core/service-types
 *   GET /api/core/clients?limit=...
 *   GET /api/core/jobs?date=YYYY-MM-DD&assigned_user_id=...
 *
 * Mounted at /api/core in routes/index.ts. Distinct namespace from the
 * existing /api/service-types, /api/clients, /api/jobs which carry
 * richer payloads + write semantics. The core endpoints are intentionally
 * minimal so later pieces (1B-1E) compose on top of a stable contract.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  serviceTypesTable,
  clientsTable,
  jobsTable,
} from "@workspace/db/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/core/service-types — tenant catalog of cleaning service types
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns active service types for the caller's tenant, ordered by
// (parent_slug, display_order, id). 1B reads this to populate the
// service-type filter chips on the day view. No write semantics.

router.get("/service-types", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }

    const rows = await db
      .select({
        id: serviceTypesTable.id,
        company_id: serviceTypesTable.company_id,
        parent_slug: serviceTypesTable.parent_slug,
        slug: serviceTypesTable.slug,
        name: serviceTypesTable.name,
        description: serviceTypesTable.description,
        is_active: serviceTypesTable.is_active,
        display_order: serviceTypesTable.display_order,
        default_allowed_hours: serviceTypesTable.default_allowed_hours,
      })
      .from(serviceTypesTable)
      .where(
        and(
          eq(serviceTypesTable.company_id, companyId),
          eq(serviceTypesTable.is_active, true),
        ),
      )
      .orderBy(
        asc(serviceTypesTable.parent_slug),
        asc(serviceTypesTable.display_order),
        asc(serviceTypesTable.id),
      );

    return res.json({ data: rows });
  } catch (err) {
    console.error("[core] GET /service-types error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load service types" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/core/clients?limit=N — tenant client catalog (minimal shape)
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns active clients for the caller's tenant. The shape is intentionally
// narrow — just enough for 1B's client autocomplete + day-view "who is this
// job for" lookups. Full client detail lives at /api/clients/:id.
//
// Default limit = 100. Cap at 500 to avoid runaway lookups.

router.get("/clients", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }

    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.trunc(limitRaw)), 500)
      : 100;

    const rows = await db
      .select({
        id: clientsTable.id,
        company_id: clientsTable.company_id,
        first_name: clientsTable.first_name,
        last_name: clientsTable.last_name,
        company_name: clientsTable.company_name,
        email: clientsTable.email,
        phone: clientsTable.phone,
        address: clientsTable.address,
        city: clientsTable.city,
        state: clientsTable.state,
        zip: clientsTable.zip,
        lat: clientsTable.lat,
        lng: clientsTable.lng,
        zone_id: clientsTable.zone_id,
        client_type: clientsTable.client_type,
        is_active: clientsTable.is_active,
      })
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.company_id, companyId),
          eq(clientsTable.is_active, true),
        ),
      )
      .orderBy(asc(clientsTable.last_name), asc(clientsTable.first_name))
      .limit(limit);

    return res.json({ data: rows });
  } catch (err) {
    console.error("[core] GET /clients error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load clients" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/core/jobs?date=YYYY-MM-DD&assigned_user_id=N — daily job feed
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns jobs for a single day, optionally filtered to one assignee.
// 1B's tech day view consumes this. Shape is the additive 1A column
// set (scope flags + job_kind + service_type_id) plus the operational
// fields the day view needs (scheduled_date/time, allowed_hours,
// status, client_id, assigned_user_id, service_type).
//
// Tenant-scoped; cross-tenant rows are invisible. If `date` is omitted,
// defaults to today (UTC date — refine later for timezone correctness).
// Caps result at 500 rows to bound the response.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/jobs", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }

    const dateRaw = (req.query.date as string | undefined) ?? "";
    let date: string;
    if (dateRaw === "") {
      const today = new Date();
      date = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    } else if (ISO_DATE_RE.test(dateRaw)) {
      date = dateRaw;
    } else {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "date must be YYYY-MM-DD" });
    }

    const assignedUserIdRaw = req.query.assigned_user_id as string | undefined;
    let assignedUserId: number | null = null;
    if (assignedUserIdRaw !== undefined && assignedUserIdRaw !== "") {
      const parsed = Number(assignedUserIdRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "assigned_user_id must be a positive integer" });
      }
      assignedUserId = parsed;
    }

    const conditions = [
      eq(jobsTable.company_id, companyId),
      eq(jobsTable.scheduled_date, date),
    ];
    if (assignedUserId !== null) {
      conditions.push(eq(jobsTable.assigned_user_id, assignedUserId));
    }

    const rows = await db
      .select({
        id: jobsTable.id,
        company_id: jobsTable.company_id,
        client_id: jobsTable.client_id,
        account_id: jobsTable.account_id,
        assigned_user_id: jobsTable.assigned_user_id,
        service_type: jobsTable.service_type,
        service_type_id: jobsTable.service_type_id,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        allowed_hours: jobsTable.allowed_hours,
        frequency: jobsTable.frequency,
        job_kind: jobsTable.job_kind,
        scope_deep_clean: jobsTable.scope_deep_clean,
        scope_first_time_in: jobsTable.scope_first_time_in,
        scope_priority: jobsTable.scope_priority,
        special_equipment_needed: jobsTable.special_equipment_needed,
        out_of_rotation: jobsTable.out_of_rotation,
        address_street: jobsTable.address_street,
        address_city: jobsTable.address_city,
        address_state: jobsTable.address_state,
        address_zip: jobsTable.address_zip,
        address_lat: jobsTable.address_lat,
        address_lng: jobsTable.address_lng,
        zone_id: jobsTable.zone_id,
      })
      .from(jobsTable)
      .where(and(...conditions))
      .orderBy(asc(jobsTable.scheduled_time), asc(jobsTable.id))
      .limit(500);

    return res.json({ data: rows });
  } catch (err) {
    console.error("[core] GET /jobs error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load jobs" });
  }
});

export default router;
