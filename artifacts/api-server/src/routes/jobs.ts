import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, usersTable, jobPhotosTable, timeclockTable, invoicesTable, scorecardsTable, serviceZonesTable, serviceZoneEmployeesTable, companiesTable, accountsTable, accountRateCardsTable, accountPropertiesTable, paymentsTable, recurringSchedulesTable, branchesTable, userCompaniesTable, jobDiscountsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, count, desc, sql, notExists, inArray, isNotNull, isNull } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { notifyUserAsync } from "../lib/push.js";
import { logAudit, logClientActivity } from "../lib/audit.js";
import { generateJobCompletionPdf } from "../lib/generate-job-pdf.js";
import { geocodeAddress } from "../lib/geocode.js";
import { resolveZoneForZip } from "./zones.js";
import { sendNotification, labelServiceType } from "../services/notificationService.js";
import { parseResRatesRow, resolveResidentialPayPct } from "../lib/commission-rates.js";

const router = Router();

// [invoice-sync 2026-06-11] Keep a job's existing DRAFT invoice in lockstep with
// its price + applied discounts. Discounts render as their own negative line
// items so the invoice total nets them out. NEVER touches a sent/paid invoice
// (QB is write-only + sent invoices are immutable) and never creates one — only
// syncs a draft that already exists. Fully non-fatal: an invoice hiccup must
// never break the underlying job write.
async function syncJobInvoiceDraft(jobId: number, companyId: number): Promise<void> {
  try {
    const [existing] = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.job_id, jobId), eq(invoicesTable.company_id, companyId)))
      .limit(1);
    if (!existing || existing.status !== "draft") return;

    const [job] = await db
      .select({
        service_type: jobsTable.service_type, base_fee: jobsTable.base_fee,
        billed_amount: jobsTable.billed_amount, hourly_rate: jobsTable.hourly_rate, billed_hours: jobsTable.billed_hours,
      })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .limit(1);
    if (!job) return;

    const service = job.billed_amount ? parseFloat(String(job.billed_amount)) : parseFloat(String(job.base_fee ?? "0"));
    const svcLabel = (job.service_type ?? "Cleaning Service").split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const qty = job.billed_hours ? parseFloat(String(job.billed_hours)) : 1;
    const unitPrice = job.hourly_rate ? parseFloat(String(job.hourly_rate)) : service;

    const discounts = await db.select().from(jobDiscountsTable)
      .where(and(eq(jobDiscountsTable.job_id, jobId), eq(jobDiscountsTable.company_id, companyId)));
    const discountTotal = discounts.reduce((s, d) => s + parseFloat(String(d.amount)), 0);
    const net = Math.max(0, Math.round((service - discountTotal) * 100) / 100);

    const lineItems: any[] = [{ description: svcLabel, quantity: qty, unit_price: unitPrice, total: service }];
    for (const d of discounts) {
      const amt = parseFloat(String(d.amount));
      const label = `Discount${d.code ? ` ${d.code}` : (d.type === "percent" ? ` ${parseFloat(String(d.value))}%` : "")}${d.reason && d.reason !== d.code ? ` — ${d.reason}` : ""}`;
      lineItems.push({ description: label, quantity: 1, unit_price: -amt, total: -amt });
    }

    await db.update(invoicesTable)
      .set({ line_items: lineItems, subtotal: net.toFixed(2), total: net.toFixed(2) })
      .where(eq(invoicesTable.id, existing.id));

    // Re-push to QuickBooks (no-op for non-connected tenants). Accounting, not
    // outbound comms — does not respect COMMS_ENABLED.
    import("../services/quickbooks-sync.js").then(({ syncInvoice }) => {
      syncInvoice(companyId, existing.id).catch(e => console.error("[invoice-sync] QB push non-fatal:", e));
    }).catch(e => console.error("[invoice-sync] QB module load non-fatal:", e));
  } catch (err) {
    console.error("[invoice-sync] non-fatal:", err);
  }
}

// Shared add-on persistence. Resolves the add_ons.id FK by company + name
// (creating the row if absent — see AI.6.3 below) and writes job_add_ons,
// replacing any existing rows for the job. Used by BOTH job create
// (POST /) and the edit cascade (PATCH /:id) so the FK-resolution logic
// lives in exactly one place. `exec` is a db or transaction handle (both
// expose .execute).
type JobAddOnInput = { pricing_addon_id?: number; add_on_id?: number; qty?: number; unit_price?: number; subtotal?: number };
export async function persistJobAddOns(exec: any, jobId: number, companyId: number, addOns: JobAddOnInput[]): Promise<void> {
  await exec.execute(sql`DELETE FROM job_add_ons WHERE job_id = ${jobId}`);
  for (const a of addOns) {
    // [AI.6.3] job_add_ons.add_on_id references add_ons.id (older catalog
    // table) and is NOT NULL. The modal historically wrote
    // add_on_id = pricing_addon_id which only worked when the IDs happened
    // to coincide via seeding. PHES's Parking Fee row in pricing_addons has
    // no matching add_ons.id, so the prior INSERT threw a foreign-key
    // violation and the whole save aborted. Resolution: look up an add_ons
    // row by company + name (case-insensitive); if absent, INSERT one
    // mirroring the pricing_addon's name + price; use that row's real id.
    const pricingId = Number(a.pricing_addon_id ?? 0) || null;
    const qty = Number(a.qty ?? 1) || 1;
    const unitPrice = a.unit_price != null ? String(a.unit_price) : "0";
    const subtotal = a.subtotal != null ? String(a.subtotal) : "0";

    let realAddOnId: number | null = null;
    if (pricingId) {
      const paRows = await exec.execute(sql`SELECT name FROM pricing_addons WHERE id = ${pricingId} LIMIT 1`);
      const paName = String((paRows.rows[0] as any)?.name ?? "").trim();
      if (paName) {
        const existing = await exec.execute(sql`
          SELECT id FROM add_ons WHERE company_id = ${companyId} AND LOWER(name) = LOWER(${paName}) LIMIT 1
        `);
        if (existing.rows.length) {
          realAddOnId = Number((existing.rows[0] as any).id);
        } else {
          const created = await exec.execute(sql`
            INSERT INTO add_ons (company_id, name, price, category, is_active)
            VALUES (${companyId}, ${paName}, ${unitPrice}, 'other', true)
            RETURNING id
          `);
          realAddOnId = Number((created.rows[0] as any).id);
        }
      }
    }
    // Last-resort fallback: caller passed an explicit add_on_id that already
    // exists in add_ons. Honor it if present.
    if (!realAddOnId && a.add_on_id) realAddOnId = Number(a.add_on_id);
    if (!realAddOnId) continue;

    await exec.execute(sql`
      INSERT INTO job_add_ons (job_id, add_on_id, quantity, unit_price, subtotal, pricing_addon_id)
      VALUES (${jobId}, ${realAddOnId}, ${qty}, ${unitPrice}, ${subtotal}, ${pricingId})
      ON CONFLICT (job_id, add_on_id) DO UPDATE
        SET quantity = EXCLUDED.quantity,
            unit_price = EXCLUDED.unit_price,
            subtotal = EXCLUDED.subtotal,
            pricing_addon_id = EXCLUDED.pricing_addon_id
    `);
  }
}

// [duplicate-job 2026-06-08] Maribel's HouseCall-Pro-style "duplicate this job
// to a new date, same service" flow (mobile-first). Copies the source job's
// DEFINITION — client/account, service, fee, allowed hours, tech team, add-ons,
// address, zone — into a NEW job on the requested date, and RESETS all
// operational state (status, clock, billing, completion, no-show) so the copy
// is a clean scheduled visit. The duplicate is standalone: frequency on_demand,
// no recurring_schedule_id/occurrence_date — it's a single extra visit, not a
// series (recurring lives on recurring_schedules). Same company scope enforced.
router.post("/:id/duplicate", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const srcId = parseInt(String(req.params.id));
    const { scheduled_date, scheduled_time } = req.body;
    if (!scheduled_date) return res.status(400).json({ error: "scheduled_date required" });

    const srcConds: any[] = [eq(jobsTable.id, srcId), eq(jobsTable.company_id, companyId)];
    const [src] = await db.select().from(jobsTable).where(and(...srcConds));
    if (!src) return res.status(404).json({ error: "Job not found" });

    // Copy every definition column, then override date + reset instance state.
    const { id: _omitId, created_at: _omitCreated, ...rest } = src as any;
    const [dup] = await db
      .insert(jobsTable)
      .values({
        ...rest,
        scheduled_date,
        scheduled_time: scheduled_time ?? src.scheduled_time,
        status: "scheduled",
        frequency: "on_demand",
        recurring_schedule_id: null,
        occurrence_date: null,
        // reset all operational / clock / billing / completion / no-show state
        billed_hours: null,
        billed_amount: null,
        actual_hours: null,
        actual_end_time: null,
        locked_at: null,
        completed_by_user_id: null,
        completion_pdf_url: null,
        completion_pdf_sent_at: null,
        charge_attempted_at: null,
        charge_succeeded_at: null,
        charge_failed_at: null,
        charge_failure_reason: null,
        no_show_marked_by_tech: null,
        no_show_marked_by_user_id: null,
        flagged: false,
      } as any)
      .returning();

    const newId = dup.id;
    logAudit(req, "CREATE", "job", newId, null, dup);

    // Carry the tech team over (same per-job assignment + primary).
    try {
      await db.execute(sql`
        INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
        SELECT ${newId}, user_id, company_id, is_primary FROM job_technicians WHERE job_id = ${srcId}
        ON CONFLICT (job_id, user_id) DO NOTHING
      `);
    } catch (e) { console.error("duplicate job_technicians copy failed for", newId, e); }

    // Carry the add-ons over (Parking Fee, etc.).
    try {
      await db.execute(sql`
        INSERT INTO job_add_ons (job_id, add_on_id, quantity, unit_price, subtotal, pricing_addon_id)
        SELECT ${newId}, add_on_id, quantity, unit_price, subtotal, pricing_addon_id FROM job_add_ons WHERE job_id = ${srcId}
        ON CONFLICT (job_id, add_on_id) DO NOTHING
      `);
    } catch (e) { console.error("duplicate job_add_ons copy failed for", newId, e); }

    return res.status(201).json(dup);
  } catch (err) {
    console.error("[jobs duplicate]", err);
    return res.status(500).json({ error: "Failed to duplicate job" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    // [BUG-7 / 2026-06-01] Added `date` as a single-day filter alongside the
    // existing date_from/date_to range. `?date=YYYY-MM-DD` was being ignored
    // (silently passed through), so callers got the full jobs table back.
    // When `date` is set it takes precedence (clearer intent than passing
    // identical from+to). Range params still work for multi-day queries.
    const { status, assigned_user_id, client_id, date, date_from, date_to, page = "1", limit = "50", uninvoiced, branch_id } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const conditions: any[] = [eq(jobsTable.company_id, req.auth!.companyId)];
    if (status) conditions.push(eq(jobsTable.status, status as any));
    if (assigned_user_id) conditions.push(eq(jobsTable.assigned_user_id, parseInt(assigned_user_id as string)));
    if (client_id) conditions.push(eq(jobsTable.client_id, parseInt(client_id as string)));
    if (date) {
      conditions.push(eq(jobsTable.scheduled_date, date as string));
    } else {
      if (date_from) conditions.push(gte(jobsTable.scheduled_date, date_from as string));
      if (date_to) conditions.push(lte(jobsTable.scheduled_date, date_to as string));
    }
    if (branch_id && branch_id !== "all") conditions.push(eq(jobsTable.branch_id, parseInt(branch_id as string)));
    if (uninvoiced === "true") {
      conditions.push(
        notExists(
          db.select({ id: invoicesTable.id })
            .from(invoicesTable)
            .where(and(
              eq(invoicesTable.job_id, jobsTable.id),
              inArray(invoicesTable.status, ["sent", "paid"])
            ))
        )
      );
    }

    const jobs = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        assigned_user_id: jobsTable.assigned_user_id,
        assigned_user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        frequency: jobsTable.frequency,
        base_fee: jobsTable.base_fee,
        allowed_hours: jobsTable.allowed_hours,
        actual_hours: jobsTable.actual_hours,
        notes: jobsTable.notes,
        created_at: jobsTable.created_at,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(and(...conditions))
      .orderBy(desc(jobsTable.scheduled_date))
      .limit(parseInt(limit as string))
      .offset(offset);

    const totalResult = await db
      .select({ count: count() })
      .from(jobsTable)
      .where(and(...conditions));

    const photoCounts = await db
      .select({
        job_id: jobPhotosTable.job_id,
        photo_type: jobPhotosTable.photo_type,
        cnt: count(),
      })
      .from(jobPhotosTable)
      .groupBy(jobPhotosTable.job_id, jobPhotosTable.photo_type);

    const photoMap = new Map<number, { before: number; after: number }>();
    for (const row of photoCounts) {
      if (!photoMap.has(row.job_id)) photoMap.set(row.job_id, { before: 0, after: 0 });
      const entry = photoMap.get(row.job_id)!;
      if (row.photo_type === "before") entry.before = row.cnt;
      if (row.photo_type === "after") entry.after = row.cnt;
    }

    return res.json({
      data: jobs.map(j => ({
        ...j,
        before_photo_count: photoMap.get(j.id)?.before || 0,
        after_photo_count: photoMap.get(j.id)?.after || 0,
      })),
      total: totalResult[0].count,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
    });
  } catch (err) {
    console.error("List jobs error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list jobs" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const {
      client_id, assigned_user_id, service_type, scheduled_date, scheduled_time,
      frequency, base_fee, allowed_hours, notes,
      account_id, account_property_id, billing_method, hourly_rate, estimated_hours,
      branch_id, add_ons, team_user_ids,
    } = req.body;

    // [multi-tech-create 2026-06-04] The wizard's tech picker is multi-select.
    // Persist the WHOLE team to job_technicians here, atomically with the job,
    // instead of relying on a best-effort follow-up PATCH (which silently
    // dropped the 2nd cleaner — Maribel could pick two but only the first was
    // scheduled). The primary is element 0 and is mirrored onto
    // jobs.assigned_user_id per the assignment-mirror invariant. Older callers
    // that send only assigned_user_id keep working.
    const teamIds: number[] = Array.isArray(team_user_ids)
      ? team_user_ids.map((x: any) => Number(x)).filter((x: number) => Number.isFinite(x))
      : [];
    const primaryTechId = teamIds.length > 0 ? teamIds[0] : (assigned_user_id ?? null);

    const newJob = await db
      .insert(jobsTable)
      .values({
        company_id: req.auth!.companyId,
        client_id: client_id || null,
        assigned_user_id: primaryTechId,
        service_type,
        scheduled_date,
        scheduled_time,
        frequency,
        base_fee: base_fee ?? "0",
        allowed_hours,
        notes,
        account_id: account_id || null,
        account_property_id: account_property_id || null,
        billing_method: billing_method || null,
        hourly_rate: hourly_rate || null,
        estimated_hours: estimated_hours || null,
        branch_id: branch_id || null,
      })
      .returning();

    const jobId = newJob[0].id;
    logAudit(req, "CREATE", "job", jobId, null, newJob[0]);

    // [multi-tech-create 2026-06-04] Write every selected tech to
    // job_technicians (primary = index 0). assigned_user_id was already set to
    // the primary in the insert above, so the dispatch grid + the per-tech
    // fan-out both render every assigned cleaner — not just the first.
    if (teamIds.length > 0) {
      for (let i = 0; i < teamIds.length; i++) {
        await db.execute(sql`
          INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
          VALUES (${jobId}, ${teamIds[i]}, ${req.auth!.companyId}, ${i === 0})
          ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
        `);
      }
    }

    // Persist add-ons (Parking Fee, etc.) selected in the create wizard.
    // base_fee already carries the all-in total (service + add-on subtotals,
    // computed client-side, matching the quote-calc + edit-modal convention),
    // so these rows are the itemized record — no surface re-sums them into
    // revenue. Wrapped so an add-on hiccup never fails the job itself.
    if (Array.isArray(add_ons) && add_ons.length > 0) {
      try {
        await persistJobAddOns(db, jobId, req.auth!.companyId, add_ons);
      } catch (e) {
        console.error("persistJobAddOns (create) failed for job", jobId, e);
      }
    }
    // Stop any active post_job_retention enrollment for this client (non-blocking)
    if (client_id) {
      import("../services/followUpService.js").then(({ stopEnrollmentsForClient }) => {
        stopEnrollmentsForClient(client_id, "rebooked", "post_job_retention").catch(() => {});
      });
    }
    // Fire-and-forget: ensure client exists in QuickBooks (residential + commercial).
    // syncCustomer is idempotent — skips if qb_customer_map already has a mapping
    // and no-ops if tenant isn't QB-connected. Booking UX never waits on QB.
    if (client_id) {
      import("../services/quickbooks-sync.js").then(({ queueSync, syncCustomer }) => {
        queueSync(() => syncCustomer(req.auth!.companyId, client_id));
      }).catch(() => {});
    }
    let geoAddress: string | null = null;
    let geoZip: string | null = null;
    let displayClientName = "";
    let displayAssignedName: string | null = null;

    if (account_property_id) {
      // Commercial job — geocode from property address
      const [prop] = await db
        .select({ address: accountPropertiesTable.address, city: accountPropertiesTable.city, state: accountPropertiesTable.state, zip: accountPropertiesTable.zip })
        .from(accountPropertiesTable)
        .where(eq(accountPropertiesTable.id, account_property_id))
        .limit(1);
      if (prop) {
        geoAddress = [prop.address, prop.city, prop.state, prop.zip].filter(Boolean).join(", ");
        geoZip = prop.zip ?? null;
      }
      // Get account name for display
      if (account_id) {
        const [acc] = await db.select({ account_name: accountsTable.account_name }).from(accountsTable).where(eq(accountsTable.id, account_id)).limit(1);
        displayClientName = acc?.account_name || "";
      }
    } else if (client_id) {
      // Residential job — geocode from client address
      const [clientRow] = await db
        .select({
          client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
          address: clientsTable.address,
          city: clientsTable.city,
          state: clientsTable.state,
          zip: clientsTable.zip,
        })
        .from(clientsTable)
        .where(eq(clientsTable.id, client_id))
        .limit(1);
      if (clientRow) {
        geoAddress = clientRow.address ? [clientRow.address, clientRow.city, clientRow.state, clientRow.zip].filter(Boolean).join(", ") : null;
        geoZip = clientRow.zip ?? null;
        displayClientName = clientRow.client_name || "";
      }
    }

    // Get assigned user name (the primary tech)
    if (primaryTechId) {
      const [emp] = await db
        .select({ name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})` })
        .from(usersTable).where(eq(usersTable.id, primaryTechId)).limit(1);
      displayAssignedName = emp?.name || null;
    }

    if (geoAddress) {
      const coords = await geocodeAddress(geoAddress);
      if (coords) {
        await db.update(jobsTable).set({ job_lat: String(coords.lat), job_lng: String(coords.lng), geocode_failed: false }).where(eq(jobsTable.id, jobId));
        newJob[0] = { ...newJob[0], job_lat: String(coords.lat) as any, job_lng: String(coords.lng) as any, geocode_failed: false };
      } else {
        await db.update(jobsTable).set({ geocode_failed: true }).where(eq(jobsTable.id, jobId));
        newJob[0] = { ...newJob[0], geocode_failed: true };
      }
    }

    if (geoZip) {
      const zoneId = await resolveZoneForZip(req.auth!.companyId, geoZip);
      if (zoneId) {
        await db.update(jobsTable).set({ zone_id: zoneId }).where(eq(jobsTable.id, jobId));
        newJob[0] = { ...newJob[0], zone_id: zoneId } as any;
      }
    }

    return res.status(201).json({
      ...newJob[0],
      client_name: displayClientName,
      assigned_user_name: displayAssignedName,
      before_photo_count: 0,
      after_photo_count: 0,
    });
  } catch (err) {
    console.error("Create job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to create job" });
  }
});

router.get("/my-jobs", requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    // Day navigation: the tech view can page to other days. Default = today.
    const reqDate = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date : today;
    let userId = req.auth!.userId;
    if (req.auth!.role === "owner" && req.query.employee_id) {
      userId = parseInt(req.query.employee_id as string);
    }

    // Cross-tenant my-jobs. The tech's mobile view should include jobs from
    // EVERY tenant they have user_companies membership in (plus their home
    // tenant). One login, one list of jobs, regardless of which business
    // owns each job. The branch chip on the card (set further down) tells
    // the tech which business is which.
    const tenantIdsRow = await db.execute(sql`
      SELECT company_id FROM user_companies WHERE user_id = ${userId}
      UNION
      SELECT company_id FROM users WHERE id = ${userId} AND company_id IS NOT NULL
    `);
    const tenantIds = (tenantIdsRow.rows as any[]).map(r => Number(r.company_id)).filter(Number.isFinite);
    if (tenantIds.length === 0) {
      // No tenant membership — return empty rather than 500. Possible for
      // users with NULL company_id and no user_companies rows.
      return res.json({ data: [] });
    }

    // After-photo-before-clock-out gate is a per-tenant owner setting (default
    // off). Surface it so the tech UI can show/hide the requirement banner +
    // disabled clock-out button. Read from the tech's auth company — the same
    // company the clock-out route enforces against.
    const companyCfg = await db
      .select({
        require_after_photo_for_clockout: companiesTable.require_after_photo_for_clockout,
        business_hours: companiesTable.business_hours,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, req.auth!.companyId))
      .limit(1);
    const requireAfterPhoto = companyCfg[0]?.require_after_photo_for_clockout ?? false;
    const businessHours = companyCfg[0]?.business_hours ?? null;

    const jobs = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        client_name: sql<string>`CASE WHEN ${jobsTable.account_id} IS NOT NULL THEN ${accountsTable.account_name} ELSE concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name}) END`,
        address: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.address} ELSE ${clientsTable.address} END`,
        city: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.city} ELSE ${clientsTable.city} END`,
        state: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.state} ELSE ${clientsTable.state} END`,
        zip: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.zip} ELSE ${clientsTable.zip} END`,
        lat: clientsTable.lat,
        lng: clientsTable.lng,
        job_lat: jobsTable.job_lat,
        job_lng: jobsTable.job_lng,
        geocode_failed: jobsTable.geocode_failed,
        client_phone: clientsTable.phone,
        client_notes: clientsTable.notes,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        base_fee: jobsTable.base_fee,
        notes: jobsTable.notes,
        account_id: jobsTable.account_id,
        account_name: accountsTable.account_name,
        billing_method: jobsTable.billing_method,
        account_property_id: jobsTable.account_property_id,
        property_name: accountPropertiesTable.property_name,
        access_notes: accountPropertiesTable.access_notes,
        estimated_hours: jobsTable.estimated_hours,
        // [tech-card-data 2026-06-09] Allowed hours is the load-bearing budget
        // the tech needs (estimated_hours is the stale creation stamp). Zone
        // (name + color) resolves zone_id first, then any zip source — a
        // gray/zoneless tile is a data error per the zone-resolution invariant.
        // Team = every assigned tech so the cleaner knows who else is going.
        allowed_hours: jobsTable.allowed_hours,
        // [zone-border-fix 2026-06-10] assigned_user_id must ride along — the
        // card's getJobVisualStatus treats a missing value as "unassigned",
        // which painted every tech card with the amber unassigned border
        // override instead of its zone color.
        assigned_user_id: jobsTable.assigned_user_id,
        // [mc-parity 2026-06-10] Cadence + home facts, MaidCentral-style.
        // Cadence prefers the recurring schedule's frequency (the template is
        // the source of truth for generated occurrences), falling back to the
        // job's own stamp. Home facts come from the client's primary home.
        frequency: sql<string | null>`COALESCE(
          (SELECT rs.frequency::text FROM recurring_schedules rs WHERE rs.id = ${jobsTable.recurring_schedule_id}),
          ${jobsTable.frequency}::text
        )`,
        bedrooms: sql<number | null>`(SELECT ch.bedrooms FROM client_homes ch
          WHERE ch.client_id = ${jobsTable.client_id} AND ch.company_id = ${jobsTable.company_id}
          ORDER BY ch.is_primary DESC NULLS LAST, ch.id LIMIT 1)`,
        bathrooms: sql<number | null>`(SELECT ch.bathrooms FROM client_homes ch
          WHERE ch.client_id = ${jobsTable.client_id} AND ch.company_id = ${jobsTable.company_id}
          ORDER BY ch.is_primary DESC NULLS LAST, ch.id LIMIT 1)`,
        sq_footage: sql<number | null>`(SELECT ch.sq_footage FROM client_homes ch
          WHERE ch.client_id = ${jobsTable.client_id} AND ch.company_id = ${jobsTable.company_id}
          ORDER BY ch.is_primary DESC NULLS LAST, ch.id LIMIT 1)`,
        zone_name: sql<string | null>`COALESCE(
          (SELECT z.name FROM service_zones z WHERE z.id = ${jobsTable.zone_id}),
          (SELECT z.name FROM service_zones z WHERE z.company_id = ${jobsTable.company_id} AND z.is_active = true
             AND COALESCE(${jobsTable.address_zip}, CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.zip} ELSE ${clientsTable.zip} END) = ANY(z.zip_codes) LIMIT 1)
        )`,
        zone_color: sql<string | null>`COALESCE(
          (SELECT z.color FROM service_zones z WHERE z.id = ${jobsTable.zone_id}),
          (SELECT z.color FROM service_zones z WHERE z.company_id = ${jobsTable.company_id} AND z.is_active = true
             AND COALESCE(${jobsTable.address_zip}, CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.zip} ELSE ${clientsTable.zip} END) = ANY(z.zip_codes) LIMIT 1)
        )`,
        team: sql<string | null>`(SELECT string_agg(u.first_name, ', ' ORDER BY jt.is_primary DESC, u.first_name)
          FROM job_technicians jt JOIN users u ON u.id = jt.user_id WHERE jt.job_id = ${jobsTable.id})`,
        team_count: sql<number>`(SELECT COUNT(*)::int FROM job_technicians jt WHERE jt.job_id = ${jobsTable.id})`,
        // [field-tech-audit 2026-06-10] The pertinent things a cleaner needs that
        // weren't surfaced: the EXTRAS sold for this visit (so they actually do
        // them), pets (safety/allergy), the entry/alarm code (to get in), the
        // per-job instructions, and whether this is a recurring client + which
        // visit number (calibrates expectations vs a first-time deep clean).
        add_ons: sql<string | null>`(SELECT string_agg(CASE WHEN jao.quantity > 1 THEN ao.name || ' ×' || jao.quantity ELSE ao.name END, ', ' ORDER BY ao.name)
          FROM job_add_ons jao JOIN add_ons ao ON ao.id = jao.add_on_id WHERE jao.job_id = ${jobsTable.id})`,
        pets: sql<string | null>`COALESCE(${clientsTable.pets}, (SELECT ch.pet_notes FROM client_homes ch
          WHERE ch.client_id = ${jobsTable.client_id} AND ch.company_id = ${jobsTable.company_id}
          ORDER BY ch.is_primary DESC NULLS LAST, ch.id LIMIT 1))`,
        alarm_code: clientsTable.alarm_code,
        job_notes: jobsTable.notes,
        is_recurring: sql<boolean>`${jobsTable.recurring_schedule_id} IS NOT NULL`,
        visit_number: sql<number | null>`CASE WHEN ${jobsTable.client_id} IS NOT NULL THEN (
          SELECT COUNT(*)::int FROM jobs j2 WHERE j2.client_id = ${jobsTable.client_id} AND j2.company_id = ${jobsTable.company_id}
            AND (j2.scheduled_date < ${jobsTable.scheduled_date} OR (j2.scheduled_date = ${jobsTable.scheduled_date} AND j2.id <= ${jobsTable.id})))
          ELSE NULL END`,
        // Surface BOTH the tenant (the business that owns the job) and the
        // branch (Phes-internal location, if set). For cross-tenant techs
        // the company_name distinguishes "Phes Oak Lawn" from "PHES
        // Schaumburg"; the branch is intra-tenant.
        company_id: jobsTable.company_id,
        company_name: companiesTable.name,
        branch_id: jobsTable.branch_id,
        branch_name: branchesTable.name,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(accountPropertiesTable, eq(jobsTable.account_property_id, accountPropertiesTable.id))
      .leftJoin(branchesTable, eq(jobsTable.branch_id, branchesTable.id))
      .leftJoin(companiesTable, eq(jobsTable.company_id, companiesTable.id))
      .where(and(
        inArray(jobsTable.company_id, tenantIds),
        eq(jobsTable.assigned_user_id, userId),
        eq(jobsTable.scheduled_date, reqDate),
      ))
      .orderBy(jobsTable.scheduled_time);

    if (jobs.length === 0) return res.json({ data: [], require_after_photo_for_clockout: requireAfterPhoto });

    const jobIds = jobs.map(j => j.id);

    const photoCounts = await db
      .select({ job_id: jobPhotosTable.job_id, photo_type: jobPhotosTable.photo_type, cnt: count() })
      .from(jobPhotosTable)
      .where(sql`${jobPhotosTable.job_id} = ANY(${sql.raw(`ARRAY[${jobIds.join(",")}]`)})`)
      .groupBy(jobPhotosTable.job_id, jobPhotosTable.photo_type);

    // Clock entries can live under ANY tenant the user is a member of —
    // dropping the company_id constraint here keeps a tech who clocks
    // into a cross-tenant job from getting a "no clock found" state.
    const clockEntries = await db
      .select()
      .from(timeclockTable)
      .where(and(
        eq(timeclockTable.user_id, userId),
        inArray(timeclockTable.company_id, tenantIds),
        sql`${timeclockTable.job_id} = ANY(${sql.raw(`ARRAY[${jobIds.join(",")}]`)})`
      ));

    const photoMap = new Map<number, { before: number; after: number }>();
    for (const row of photoCounts) {
      if (!photoMap.has(row.job_id)) photoMap.set(row.job_id, { before: 0, after: 0 });
      const e = photoMap.get(row.job_id)!;
      if (row.photo_type === "before") e.before = row.cnt;
      if (row.photo_type === "after") e.after = row.cnt;
    }

    const clockMap = new Map<number, typeof clockEntries[0]>();
    for (const e of clockEntries) {
      if (!clockMap.has(e.job_id) || (!e.clock_out_at)) clockMap.set(e.job_id, e);
    }

    // Day quality = average of this day's non-excluded visit scorecards for the
    // tech (tied to the day's jobs, regardless of when the rating arrived). Often
    // empty same-day — client ratings land after the visit — so the UI shows
    // "—" until at least one scorecard exists, then it fills in retrospectively.
    let quality: { avg: number; count: number } | null = null;
    try {
      const qc = await db.execute(sql`
        SELECT AVG(score)::float AS avg, COUNT(*)::int AS cnt
        FROM scorecards
        WHERE user_id = ${userId}
          AND excluded = false
          AND job_id = ANY(${sql.raw(`ARRAY[${jobIds.join(",")}]`)})
      `);
      const row = (qc.rows as any[])[0];
      if (row && Number(row.cnt) > 0 && row.avg != null) {
        quality = { avg: Math.round(Number(row.avg) * 10) / 10, count: Number(row.cnt) };
      }
    } catch { /* scorecards table absent — leave null */ }

    return res.json({
      data: jobs.map(j => ({
        ...j,
        lat: j.lat ? parseFloat(j.lat) : null,
        lng: j.lng ? parseFloat(j.lng) : null,
        job_lat: j.job_lat ? parseFloat(j.job_lat) : null,
        job_lng: j.job_lng ? parseFloat(j.job_lng) : null,
        base_fee: j.base_fee ? parseFloat(j.base_fee) : 0,
        estimated_hours: j.estimated_hours ? parseFloat(j.estimated_hours) : null,
        allowed_hours: j.allowed_hours != null ? parseFloat(j.allowed_hours as any) : null,
        before_photo_count: photoMap.get(j.id)?.before || 0,
        after_photo_count: photoMap.get(j.id)?.after || 0,
        time_clock_entry: clockMap.get(j.id) || null,
      })),
      quality,
      business_hours: businessHours,
      require_after_photo_for_clockout: requireAfterPhoto,
    });
  } catch (err) {
    console.error("My jobs error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get my jobs" });
  }
});

// ─── GET /api/jobs/my-jobs/:id/history ───────────────────────────────────────
// [job-detail 2026-06-10] Prior visits at the same client (residential) or
// same property (commercial) for the tech's job-detail screen: when we were
// last there, what was done, who went, how long it took, and any technician
// notes left behind ("gate code changed", "cat hides under the bed"). Tech-
// accessible — requireAuth + company scope only, no office role gate.
router.get("/my-jobs/:id/history", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const base = await db.execute(sql`
      SELECT client_id, account_property_id, scheduled_date
      FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    const baseJob = (base as any).rows?.[0];
    if (!baseJob) return res.status(404).json({ error: "Not Found", message: "Job not found" });
    if (!baseJob.client_id && !baseJob.account_property_id) return res.json({ data: [] });

    const rows = await db.execute(sql`
      SELECT j2.id, j2.scheduled_date, j2.service_type,
        (SELECT ROUND(GREATEST(EXTRACT(EPOCH FROM (MAX(tc.clock_out_at) - MIN(tc.clock_in_at))) / 3600.0, 0)::numeric, 1)
           FROM timeclock tc WHERE tc.job_id = j2.id AND tc.clock_out_at IS NOT NULL) AS hours,
        COALESCE(
          (SELECT string_agg(DISTINCT u.first_name, ', ')
             FROM job_technicians jt JOIN users u ON u.id = jt.user_id WHERE jt.job_id = j2.id),
          (SELECT u2.first_name FROM users u2 WHERE u2.id = j2.assigned_user_id)
        ) AS techs,
        (SELECT string_agg(tn.body, ' · ' ORDER BY tn.created_at)
           FROM technician_notes tn WHERE tn.job_id = j2.id) AS tech_notes
      FROM jobs j2
      WHERE j2.company_id = ${companyId}
        AND j2.id <> ${jobId}
        AND j2.status = 'complete'
        AND j2.scheduled_date <= ${baseJob.scheduled_date}
        AND (
          (${baseJob.account_property_id ?? null}::int IS NOT NULL AND j2.account_property_id = ${baseJob.account_property_id ?? null})
          OR (${baseJob.account_property_id ?? null}::int IS NULL AND ${baseJob.client_id ?? null}::int IS NOT NULL AND j2.client_id = ${baseJob.client_id ?? null})
        )
      ORDER BY j2.scheduled_date DESC, j2.id DESC
      LIMIT 5
    `);
    return res.json({ data: (rows as any).rows });
  } catch (err) {
    console.error("My-jobs history error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get visit history" });
  }
});

// ─── POST /api/jobs/suggest-tech ─────────────────────────────────────────────
router.post("/suggest-tech", requireAuth, async (req, res) => {
  try {
    const { date, start_time, end_time, zip_code } = req.body;
    const companyId = req.auth!.companyId;

    if (!date || !start_time || !end_time || !zip_code) {
      return res.status(400).json({ error: "date, start_time, end_time, zip_code required" });
    }

    function toMinutes(t: string): number {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + (m || 0);
    }
    function fmtMinutes(m: number): string {
      const hh = Math.floor(m / 60) % 24;
      const mm = m % 60;
      const ampm = hh < 12 ? "AM" : "PM";
      const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
      return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
    }

    const bufStart = toMinutes(start_time) - 30;
    const bufEnd   = toMinutes(end_time)   + 30;

    // 1. All active technicians for this company
    const techs = await db
      .select({
        id: usersTable.id,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        home_zip: usersTable.zip,
        avatar_url: usersTable.avatar_url,
        role: usersTable.role,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.company_id, companyId),
          eq(usersTable.is_active, true),
          inArray(usersTable.role, ["technician"] as any),
        )
      );

    if (techs.length === 0) return res.json([]);

    const techIds = techs.map(t => t.id);

    // 2. All jobs that date for these techs
    const dayJobs = await db
      .select({
        assigned_user_id: jobsTable.assigned_user_id,
        scheduled_time:   jobsTable.scheduled_time,
        allowed_hours:    jobsTable.allowed_hours,
        zone_id:          jobsTable.zone_id,
      })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.scheduled_date, date),
          inArray(jobsTable.assigned_user_id, techIds as any),
        )
      );

    // 3. Detect conflicts; track last-job end time & zone per tech
    const conflictedIds = new Set<number>();
    const lastEndMap: Record<number, number>      = {};
    const lastZoneMap: Record<number, number|null> = {};

    for (const j of dayJobs) {
      if (j.assigned_user_id == null) continue;
      const uid   = j.assigned_user_id;
      const jStart = toMinutes(j.scheduled_time || "00:00");
      const jEnd   = jStart + parseFloat(j.allowed_hours ?? "1") * 60;

      if (!lastEndMap[uid] || jEnd > lastEndMap[uid]) {
        lastEndMap[uid]  = jEnd;
        lastZoneMap[uid] = j.zone_id ?? null;
      }

      if (jStart < bufEnd && jEnd > bufStart) conflictedIds.add(uid);
    }

    const available = techs.filter(t => !conflictedIds.has(t.id));
    if (available.length === 0) return res.json([]);

    // 4. Zone assignments for available techs
    const zoneRows = await db
      .select({
        user_id:   serviceZoneEmployeesTable.user_id,
        zone_id:   serviceZoneEmployeesTable.zone_id,
        zone_name: serviceZonesTable.name,
        zone_color: serviceZonesTable.color,
        zip_codes: serviceZonesTable.zip_codes,
      })
      .from(serviceZoneEmployeesTable)
      .innerJoin(serviceZonesTable, eq(serviceZonesTable.id, serviceZoneEmployeesTable.zone_id))
      .where(inArray(serviceZoneEmployeesTable.user_id, available.map(t => t.id)));

    const techZoneMap: Record<number, typeof zoneRows[0]> = {};
    for (const z of zoneRows) techZoneMap[z.user_id] = z;

    // 5. Find the zone that contains the job zip
    const allZones = await db
      .select({ id: serviceZonesTable.id, name: serviceZonesTable.name, color: serviceZonesTable.color, zip_codes: serviceZonesTable.zip_codes })
      .from(serviceZonesTable)
      .where(eq(serviceZonesTable.company_id, companyId));

    const jobZone = allZones.find(z => (z.zip_codes || []).includes(zip_code)) ?? null;

    // 6. Score and rank
    const scored = available.map(t => {
      const tz = techZoneMap[t.id] ?? null;
      const lastEnd = lastEndMap[t.id] ?? null;

      let tier = 4;
      let reason = "Available — different zone";

      if (!tz) {
        tier = 4;
        reason = "No zone assigned";
      } else if (jobZone && tz.zone_id === jobZone.id) {
        tier = 1;
        reason = "Same zone";
      } else if (jobZone && lastZoneMap[t.id] != null && lastZoneMap[t.id] === jobZone.id) {
        tier = 2;
        reason = "Last job in same zone";
      } else if (jobZone && (jobZone.zip_codes || []).includes(t.home_zip || "")) {
        tier = 3;
        reason = "Home in job zone";
      }

      return {
        employee_id: t.id,
        name: `${t.first_name} ${t.last_name}`,
        avatar_url: t.avatar_url ?? null,
        tier,
        reason,
        zone_color: tz?.zone_color ?? null,
        zone_name: tz?.zone_name ?? null,
        last_job_end_time: lastEnd != null ? fmtMinutes(lastEnd) : null,
      };
    });

    scored.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
    return res.json(scored.slice(0, 5));
  } catch (err) {
    console.error("[suggest-tech]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/availability", requireAuth, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date required" });
    const companyId = req.auth!.companyId;
    const jobs = await db
      .select({ scheduled_time: jobsTable.scheduled_time })
      .from(jobsTable)
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.scheduled_date, date as string),
        sql`${jobsTable.status} NOT IN ('cancelled')`,
      ));
    const countsByHour: Record<number, number> = {};
    for (const job of jobs) {
      if (job.scheduled_time) {
        const hour = parseInt(job.scheduled_time.split(":")[0]);
        if (!isNaN(hour)) countsByHour[hour] = (countsByHour[hour] || 0) + 1;
      }
    }
    const slots = [];
    for (let hour = 7; hour <= 17; hour++) {
      slots.push({ hour, count: countsByHour[hour] || 0 });
    }
    return res.json({ slots });
  } catch (err) {
    console.error("[jobs/availability]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── GET /api/jobs/ready-to-charge ─── Daily Stripe charge queue ──────────────
router.get("/ready-to-charge", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const todayStr = new Date().toISOString().slice(0, 10);

    const rows = await db.execute(sql`
      SELECT j.id, j.client_id, j.scheduled_date, j.base_fee, j.billed_amount, j.service_type,
             j.charge_failed_at,
             c.first_name, c.last_name, c.card_last_four, c.card_brand, c.payment_source
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      WHERE j.company_id = ${companyId}
        AND j.status = 'complete'
        AND c.payment_source = 'stripe'
        AND c.stripe_payment_method_id IS NOT NULL
        AND j.charge_succeeded_at IS NULL
        AND j.scheduled_date = ${todayStr}
        AND NOT EXISTS (
          SELECT 1 FROM payments p WHERE p.job_id = j.id AND p.status = 'completed'
        )
      ORDER BY c.last_name, c.first_name
    `);

    return res.json({ data: rows.rows });
  } catch (err) {
    console.error("GET /jobs/ready-to-charge error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);

    const job = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        assigned_user_id: jobsTable.assigned_user_id,
        assigned_user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        frequency: jobsTable.frequency,
        base_fee: jobsTable.base_fee,
        allowed_hours: jobsTable.allowed_hours,
        actual_hours: jobsTable.actual_hours,
        notes: jobsTable.notes,
        created_at: jobsTable.created_at,
        // [PR #27] Schedule linkage + days_of_week so consumers
        // (job detail page, my-jobs view) match the dispatch
        // payload's shape and the edit-modal parking picker gate
        // works regardless of which surface opens the modal.
        recurring_schedule_id: jobsTable.recurring_schedule_id,
        recurring_schedule_days_of_week: recurringSchedulesTable.days_of_week,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .leftJoin(recurringSchedulesTable, eq(jobsTable.recurring_schedule_id, recurringSchedulesTable.id))
      .where(and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.company_id, req.auth!.companyId)
      ))
      .limit(1);

    if (!job[0]) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }

    const photos = await db
      .select()
      .from(jobPhotosTable)
      .where(eq(jobPhotosTable.job_id, jobId));

    const timeclockEntries = await db
      .select({
        id: timeclockTable.id,
        job_id: timeclockTable.job_id,
        user_id: timeclockTable.user_id,
        user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        clock_in_at: timeclockTable.clock_in_at,
        clock_out_at: timeclockTable.clock_out_at,
        clock_in_lat: timeclockTable.clock_in_lat,
        clock_in_lng: timeclockTable.clock_in_lng,
        clock_out_lat: timeclockTable.clock_out_lat,
        clock_out_lng: timeclockTable.clock_out_lng,
        distance_from_job_ft: timeclockTable.distance_from_job_ft,
        flagged: timeclockTable.flagged,
      })
      .from(timeclockTable)
      .leftJoin(usersTable, eq(timeclockTable.user_id, usersTable.id))
      .where(eq(timeclockTable.job_id, jobId));

    const invoiceResult = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.job_id, jobId))
      .limit(1);

    const beforePhotos = photos.filter(p => p.photo_type === "before");
    const afterPhotos = photos.filter(p => p.photo_type === "after");

    // [AI.7.1] Preload data the edit-job modal needs so it can hydrate
    // existing add-ons (selectedAddons keyed by pricing_addon_id),
    // days_of_week (custom-day picker), hourly_rate, recurring_schedule_id,
    // and the schedule's parking_fee_* config. Without this the modal
    // initialized selectedAddons=empty and saved an empty add_ons array,
    // which caused the server to DELETE existing parking-fee rows on save
    // — i.e. "I hit save and parking disappeared" / "none of the changes
    // take place" reproduces. See edit-job-modal.tsx initial-load useEffect.
    // days_of_week lives on recurring_schedules, not jobs — JOIN to read it
    // through the schedule. Without the JOIN, this 500s the entire endpoint
    // with `column "days_of_week" does not exist`. Applies to all jobs
    // (schedule-attached or not) since the SELECT runs unconditionally.
    const jobMetaRows = await db.execute(sql`
      SELECT j.recurring_schedule_id, j.hourly_rate, rs.days_of_week, j.account_id
      FROM jobs j
      LEFT JOIN recurring_schedules rs ON rs.id = j.recurring_schedule_id
      WHERE j.id = ${jobId} LIMIT 1
    `);
    const jobMeta = (jobMetaRows.rows[0] as any) ?? {};

    const existingAddOnsRows = await db.execute(sql`
      SELECT jao.pricing_addon_id, jao.add_on_id, jao.quantity, jao.unit_price, jao.subtotal,
             COALESCE(pa.name, ao.name) AS name
      FROM job_add_ons jao
      LEFT JOIN pricing_addons pa ON pa.id = jao.pricing_addon_id
      LEFT JOIN add_ons ao ON ao.id = jao.add_on_id
      WHERE jao.job_id = ${jobId}
    `);

    let recurringSchedule: any = null;
    if (jobMeta.recurring_schedule_id != null) {
      const rs = await db.execute(sql`
        SELECT id, frequency, day_of_week, days_of_week, custom_frequency_weeks,
               parking_fee_enabled, parking_fee_amount, parking_fee_days,
               commercial_hourly_rate
        FROM recurring_schedules WHERE id = ${jobMeta.recurring_schedule_id} LIMIT 1
      `);
      recurringSchedule = (rs.rows[0] as any) ?? null;
    }

    // Surface the client's primary home sq_footage so the edit-job modal
    // can pre-fill it without an extra round trip and pass it to
    // /api/pricing/calculate. Without this, %-based addons (Windows 15%,
    // Basement 15%) silently compute to $0 because the modal never sends
    // sqft. is_primary is the canonical flag; we fall back to the first
    // row by id when no primary is flagged (legacy MC-imported homes).
    const homeRows = await db.execute(sql`
      SELECT id, sq_footage
      FROM client_homes
      WHERE client_id = ${job[0].client_id}
        AND company_id = ${req.auth!.companyId}
      ORDER BY is_primary DESC NULLS LAST, id ASC
      LIMIT 1
    `);
    const primaryHome = homeRows.rows[0] as { id: number; sq_footage: number | null } | undefined;
    const clientHomeId = primaryHome ? Number(primaryHome.id) : null;
    const clientHomeSqFootage = primaryHome ? primaryHome.sq_footage : null;

    // [PR #63] Surface the per-client hourly rate (from clients.hourly_rate,
    // backfilled in PR #60) so the edit-job modal can pass it to
    // /api/pricing/calculate as an override on scope.hourly_rate. Without
    // this, the engine uses the tenant-wide scope rate (which for Phes's
    // Standard Clean works out to ~$71.67/hr from MC migration math) —
    // Nicholas Cooper's modal returns 3 × $71.67 = $215 instead of his
    // actual 3 × $60 = $180. Per-client variability is the real-world
    // pricing model; the column was already there, we just weren't using it.
    const clientRateRows = await db.execute(sql`
      SELECT hourly_rate FROM clients WHERE id = ${job[0].client_id} LIMIT 1
    `);
    const clientHourlyRate = clientRateRows.rows[0]
      ? (clientRateRows.rows[0] as any).hourly_rate
      : null;

    return res.json({
      ...job[0],
      recurring_schedule_id: jobMeta.recurring_schedule_id ?? null,
      hourly_rate: jobMeta.hourly_rate ?? null,
      days_of_week: jobMeta.days_of_week ?? null,
      account_id: jobMeta.account_id ?? null,
      client_home_id: clientHomeId,
      client_home_sq_footage: clientHomeSqFootage != null ? Number(clientHomeSqFootage) : null,
      client_hourly_rate: clientHourlyRate != null ? Number(clientHourlyRate) : null,
      before_photo_count: beforePhotos.length,
      after_photo_count: afterPhotos.length,
      photos: photos.map(p => ({
        ...p,
        lat: p.lat ? parseFloat(p.lat) : null,
        lng: p.lng ? parseFloat(p.lng) : null,
      })),
      timeclock_entries: timeclockEntries.map(t => ({
        ...t,
        duration_hours: t.clock_out_at
          ? (new Date(t.clock_out_at).getTime() - new Date(t.clock_in_at).getTime()) / 3600000
          : null,
        distance_from_job_ft: t.distance_from_job_ft ? parseFloat(t.distance_from_job_ft) : null,
      })),
      existing_add_ons: existingAddOnsRows.rows.map((r: any) => ({
        pricing_addon_id: r.pricing_addon_id != null ? Number(r.pricing_addon_id) : null,
        add_on_id: r.add_on_id != null ? Number(r.add_on_id) : null,
        quantity: r.quantity != null ? Number(r.quantity) : 1,
        unit_price: r.unit_price != null ? Number(r.unit_price) : 0,
        subtotal: r.subtotal != null ? Number(r.subtotal) : 0,
        name: r.name ?? "",
      })),
      recurring_schedule: recurringSchedule
        ? {
            id: Number(recurringSchedule.id),
            frequency: recurringSchedule.frequency,
            day_of_week: recurringSchedule.day_of_week,
            days_of_week: recurringSchedule.days_of_week,
            custom_frequency_weeks: recurringSchedule.custom_frequency_weeks,
            parking_fee_enabled: !!recurringSchedule.parking_fee_enabled,
            parking_fee_amount: recurringSchedule.parking_fee_amount != null
              ? Number(recurringSchedule.parking_fee_amount) : null,
            parking_fee_days: recurringSchedule.parking_fee_days,
            commercial_hourly_rate: recurringSchedule.commercial_hourly_rate != null
              ? Number(recurringSchedule.commercial_hourly_rate) : null,
          }
        : null,
      invoice: invoiceResult[0] || null,
      checklist_items: [],
    });
  } catch (err) {
    console.error("Get job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get job" });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const { assigned_user_id, service_type, status, scheduled_date, scheduled_time, frequency, base_fee, allowed_hours, notes, office_notes } = req.body;

    const updated = await db
      .update(jobsTable)
      .set({
        ...(assigned_user_id !== undefined && { assigned_user_id }),
        ...(service_type && { service_type }),
        ...(status && { status }),
        ...(scheduled_date && { scheduled_date }),
        ...(scheduled_time !== undefined && { scheduled_time }),
        ...(frequency && { frequency }),
        ...(base_fee !== undefined && { base_fee }),
        ...(allowed_hours !== undefined && { allowed_hours }),
        ...(notes !== undefined && { notes }),
        // [notes-author] Stamp who/when on every office-notes edit.
        ...(office_notes !== undefined && { office_notes, office_notes_updated_by: req.auth!.userId, office_notes_updated_at: new Date() }),
      })
      .where(and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.company_id, req.auth!.companyId)
      ))
      .returning();

    if (!updated[0]) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }

    // [drag-drop-mirror 2026-06-10] Mirror the dropped tech into
    // job_technicians so the card / JobPanel tech selector / commission /
    // payroll agree with the grid row (dispatch reads the primary from
    // job_technicians, falling back to assigned_user_id only when no row
    // exists). main (#381) mirrored the non-null case (demote the old primary,
    // upsert the new one, keeping helpers). This adds the drag-to-Unassigned
    // (null) case #381 didn't handle: a job dragged to the Unassigned row
    // should leave no primary.
    if (assigned_user_id !== undefined) {
      const companyId = req.auth!.companyId!;
      if (assigned_user_id === null) {
        await db.execute(sql`
          UPDATE job_technicians SET is_primary = false
          WHERE job_id = ${jobId} AND is_primary = true
        `);
      } else {
        await db.execute(sql`
          UPDATE job_technicians
          SET is_primary = false
          WHERE job_id = ${jobId} AND is_primary = true AND user_id <> ${Number(assigned_user_id)}
        `);
        await db.execute(sql`
          INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
          VALUES (${jobId}, ${Number(assigned_user_id)}, ${companyId}, true)
          ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = true
        `);
      }
    }

    logAudit(req, "UPDATE", "job", jobId, null, updated[0]);

    // [push 2026-06-03] Schedule-change push to the assigned tech. Strictly
    // gated on a date/time change so office-notes / status-only saves don't
    // fire it. Fire-and-forget; no-op unless COMMS_ENABLED + a device exists.
    const schedChanged = scheduled_date !== undefined || scheduled_time !== undefined;
    const assignedTech = (updated[0] as any).assigned_user_id as number | null;
    if (schedChanged && assignedTech && assignedTech !== req.auth!.userId) {
      const dStr = (updated[0] as any).scheduled_date
        ? new Date(`${(updated[0] as any).scheduled_date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
        : "";
      notifyUserAsync(assignedTech, req.auth!.companyId!, {
        title: "Schedule updated",
        body: dStr ? `A job on your schedule was moved to ${dStr}.` : "A job time on your schedule was updated.",
        data: { type: "job", jobId: String(jobId) },
      });
    }

    return res.json({
      ...updated[0],
      client_name: "",
      assigned_user_name: null,
      before_photo_count: 0,
      after_photo_count: 0,
    });
  } catch (err) {
    console.error("Update job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to update job" });
  }
});

// [AG] PATCH /api/jobs/:id — focused job edit modal endpoint.
//
// Distinct from PUT (above) which is bare-bones and used by drag-and-drop /
// quick reschedule flows. This handler:
//   - Diffs each editable field and writes per-field rows into job_audit_log
//   - Honors a cascade flag ('this_job' | 'this_and_future') for recurring jobs
//   - Blocks edits to date/time/team when a tech is currently clocked in
//   - Persists multi-tech assignments via job_technicians (replaces existing)
//   - Persists add-ons via job_add_ons (replaces existing) with pricing_addon_id
//   - Trusts the client-computed base_fee; client owns manual_rate_override flag
//
// 409 Conflict when status in (complete, cancelled) OR locked_at is non-null.
router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: "Invalid job id" });

    const {
      service_type,
      frequency,
      scheduled_date,
      scheduled_time,
      allowed_hours,
      base_fee,
      hourly_rate,            // [AH] commercial per-visit rate override
      manual_rate_override,
      add_ons,
      team_user_ids,
      instructions,
      cascade_scope,
      days_of_week,           // [AI] multi-day pattern (int array 0..6)
      // [AI.7.1] Parking fee schedule-level cascade. When the user toggles
      // parking ON in the modal and picks "this and future", these flow
      // onto recurring_schedules so the engine stamps parking on every
      // matching future occurrence. parking_fee_days defaults to the
      // schedule's days_of_week (the modal pre-selects them) but can be
      // expanded to all 7 days if the operator wants parking on every
      // future job regardless of which weekdays the schedule visits.
      parking_fee_enabled,
      parking_fee_amount,
      parking_fee_days,
      // [BUG-2 / 2026-06-01] status was referenced at lines ~1136 and ~1214
      // (cancel-modal PATCH path) but never destructured here. Every PATCH
      // request — even ones with no status field at all — hit the bare
      // `status !== undefined` check and threw ReferenceError, breaking
      // the entire Edit-Job modal. status is whitelisted to 'cancelled'
      // only; the validation below stays unchanged.
      status,
      // [BUG-3F1 / 2026-06-02] Allow moving a job to a different property
      // on the same account as a pure UPDATE. Previously this field was
      // silently dropped from the destructure, which combined with some
      // FE retry path Sal hit caused jobs 5654 and 5660 to disappear on
      // 06-01 (recreated as 5976/5977). Property change is an atomic
      // FK rewrite — it must NEVER delete or archive the job row.
      account_property_id,
    } = req.body ?? {};

    // [PR / 2026-04-30] Cascade dry-run mode. Counters-only for v1
    // (Sal Q3.1 = a). When dry_run=true, the route runs the entire
    // cascade transaction as normal — accumulating in-tx counters
    // (future_jobs_updated/deleted/inserted/skipped, schedule_created
    // bool) — then ROLLS BACK at the end of the tx via a sentinel
    // throw. The outer handler catches the sentinel and returns the
    // counters. Production state stays untouched.
    //
    // The post-commit fan-out (generateJobsFromSchedule for the
    // create_recurring path) is SKIPPED entirely under dry_run — it
    // runs outside the tx and would persist real INSERTs that
    // rollback can't reverse. For v1 we omit fan-out simulation; the
    // operator can re-run without dry_run to see the real fan-out
    // count. v2 if v1 proves insufficient.
    //
    // Backend dry-run is always live (any JWT can hit
    // PATCH ?dry_run=true). Frontend "Preview changes" button is
    // gated behind CASCADE_PREVIEW_ENABLED via /api/config/feature-
    // flags (Sal Q3.4).
    const dry_run = req.body?.dry_run === true;

    // [AI] Validate day-pattern exclusivity. Only daily/weekdays/custom_days
    // populate days_of_week; weekly/biweekly/every_3_weeks/monthly use
    // day_of_week (the schedule column) and days_of_week stays null. The
    // engine warns on dual-population but the modal/PATCH path enforces it.
    const isMultiDayFreq = frequency === "daily" || frequency === "weekdays" || frequency === "custom_days";
    if (frequency !== undefined && isMultiDayFreq && Array.isArray(days_of_week)) {
      // custom_days requires ≥1 entry; daily/weekdays ignore the array contents
      if (frequency === "custom_days" && days_of_week.length === 0) {
        return res.status(400).json({ error: "custom_days requires at least one day" });
      }
      const bad = days_of_week.find(n => typeof n !== "number" || n < 0 || n > 6);
      if (bad !== undefined) {
        return res.status(400).json({ error: "days_of_week values must be integers 0..6" });
      }
    }
    if (frequency !== undefined && !isMultiDayFreq && Array.isArray(days_of_week) && days_of_week.length > 0) {
      return res.status(400).json({
        error: "days_of_week is only valid for daily/weekdays/custom_days frequencies",
      });
    }

    // [cascade-scope 2026-04-29] Five valid scopes now:
    //   this_job          — write to this job + job_add_ons (default)
    //   this_and_future   — schedule template + future occurrences
    //   all               — full series including past (warn if paid)
    //   remove_this       — same write path as this_job; signals operator
    //                       intent to remove a schedule-default add-on
    //                       from this occurrence only (no schedule edit).
    //   create_recurring  — [recurring-on-save 2026-04-30] convert a one-off
    //                       job to the first occurrence of a new recurring
    //                       schedule. Route creates a recurring_schedules
    //                       row anchored to this job's scheduled_date,
    //                       links jobs.recurring_schedule_id, copies
    //                       job_add_ons / job_technicians onto the schedule,
    //                       then fans out 60 days forward via
    //                       generateJobsFromSchedule. Rejects with 409 if
    //                       the customer already has an active schedule.
    const VALID_CASCADE = ["this_job", "this_and_future", "all", "remove_this", "create_recurring"] as const;
    if (!VALID_CASCADE.includes(cascade_scope)) {
      return res.status(400).json({
        error: `cascade_scope must be one of: ${VALID_CASCADE.join(", ")}`,
      });
    }

    // ── Pull current job + actor identity ──────────────────────────────────
    const jobRows = await db.execute(sql`
      SELECT id, company_id, recurring_schedule_id, status, locked_at,
             service_type, frequency, scheduled_date, scheduled_time,
             allowed_hours, base_fee, hourly_rate, manual_rate_override, notes,
             assigned_user_id, client_id, account_id, account_property_id,
             billed_amount,
             charge_succeeded_at, charge_failed_at
      FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });
    const before = jobRows.rows[0] as Record<string, unknown>;

    // [PR / 2026-05-03] Completed-job edits are fully unlocked per Sal's
    // directive — notes, tech, time, price, parking, frequency,
    // service_type, anything. Money movement (refunds, surcharges) is
    // handled manually outside the app. Reports query the live row so
    // figures retroactively reflect any edit. Audit log writes capture
    // every change for traceability. Cancelled stays hard-locked
    // (uncancel flow handles restoration).
    //
    // `skipAnchorLockedFields` below still freezes the anchor row's
    // frequency / service_type / price columns when cascade='this_and_future'
    // or 'all', so the historical anchor keeps the values that actually
    // fired. To overwrite the anchor itself, the operator picks
    // cascade='this_job'.
    const isCompleted = before.status === "complete";
    const isCancelled = before.status === "cancelled";

    if (isCancelled) {
      return res.status(409).json({
        error: "Cancelled job",
        message: "Cancelled jobs cannot be edited. Restore the job first.",
      });
    }

    const cascadesToTemplate = cascade_scope === "this_and_future" || cascade_scope === "all";
    const skipAnchorLockedFields = isCompleted && cascadesToTemplate;

    if (cascade_scope === "this_and_future" && before.recurring_schedule_id == null) {
      return res.status(400).json({
        error: "Cannot cascade",
        message: "This job is not part of a recurring schedule. Use cascade_scope='this_job'.",
      });
    }
    if (cascade_scope === "all" && before.recurring_schedule_id == null) {
      return res.status(400).json({
        error: "Cannot cascade",
        message: "This job is not part of a recurring schedule. Use cascade_scope='this_job'.",
      });
    }
    if (cascade_scope === "remove_this" && before.recurring_schedule_id == null) {
      // remove_this only makes sense on a recurring job — it's the
      // operator's way of saying "skip the schedule's default add-on
      // for this occurrence." On a one-off, this_job is equivalent.
      return res.status(400).json({
        error: "Cannot scope",
        message: "remove_this only applies to recurring jobs. Use this_job for one-offs.",
      });
    }

    // [recurring-on-save 2026-04-30] create_recurring scope: convert a
    // one-off job into the first occurrence of a brand-new recurring
    // schedule. Validation: target frequency must be a recurring value
    // (not on_demand / blank), the current job must NOT already have a
    // schedule (use this_and_future for those), and the customer must
    // NOT already have an active schedule on file (409). The actual
    // schedule INSERT + job link + add-on/tech copy + 60d fan-out
    // happen in the transaction block below.
    const RECURRING_FREQS = new Set([
      "weekly", "biweekly", "every_3_weeks", "monthly", "daily", "weekdays", "custom_days",
    ]);
    const wantsCreateRecurring = cascade_scope === "create_recurring";
    const effectiveFrequency = frequency !== undefined ? frequency : (before.frequency as string | null);
    if (wantsCreateRecurring) {
      if (before.recurring_schedule_id != null) {
        return res.status(400).json({
          error: "Cannot create",
          message:
            "This job is already part of a recurring schedule. Use cascade_scope='this_and_future' to update the schedule template instead.",
        });
      }
      if (!effectiveFrequency || !RECURRING_FREQS.has(String(effectiveFrequency))) {
        return res.status(400).json({
          error: "Invalid frequency for create_recurring",
          message:
            "create_recurring requires frequency to be one of: weekly, biweekly, every_3_weeks, monthly, daily, weekdays, custom_days.",
        });
      }
      // Active-schedule conflict — 409 with the conflicting row's id +
      // frequency in the message so the operator knows what's blocking.
      const clientIdNum = Number(before.client_id);
      const existing = await db.execute(sql`
        SELECT id, frequency, day_of_week, days_of_week
          FROM recurring_schedules
         WHERE customer_id = ${clientIdNum}
           AND company_id = ${companyId}
           AND is_active = true
         ORDER BY id
         LIMIT 1
      `);
      if (existing.rows.length) {
        const r = existing.rows[0] as { id: number; frequency: string; day_of_week: string | null; days_of_week: number[] | null };
        const freqLabel = String(r.frequency);
        const dayLabel = r.day_of_week
          ? ` on ${String(r.day_of_week)}s`
          : (Array.isArray(r.days_of_week) && r.days_of_week.length > 0
              ? ` on weekdays [${r.days_of_week.join(",")}]`
              : "");
        return res.status(409).json({
          error: "Conflicting schedule",
          existing_schedule_id: Number(r.id),
          message:
            `This client already has an active recurring schedule (id ${r.id}, ${freqLabel}${dayLabel}). ` +
            `Update or end that schedule before creating a new one.`,
        });
      }
    }
    // [recurring-on-save 2026-04-30] Legacy bad-case guard. If the
    // operator (or a programmatic caller) sends cascade_scope='this_job'
    // with a recurring frequency on a one-off, we'd previously write
    // jobs.frequency='weekdays' to the single row and silently drop
    // days_of_week (no schedule to write to, no fan-out). That's how
    // Jaira ended up with a Monday job tagged 'weekdays' and no Tue–Fri.
    // Reject explicitly and direct callers to the right path.
    if (
      cascade_scope === "this_job"
      && frequency !== undefined
      && RECURRING_FREQS.has(String(frequency))
      && before.recurring_schedule_id == null
    ) {
      return res.status(400).json({
        error: "Frequency requires a recurring schedule",
        message:
          "frequency was set to a recurring value on a one-off job. Use cascade_scope='create_recurring' to create a schedule and fan out, or revert frequency to 'on_demand'.",
      });
    }

    // [PR / 2026-05-03] cascade='all' previously warned when past
    // occurrences were paid. Removed alongside the completion gates —
    // the cascade engine itself silently skips paid past jobs further
    // down (audit-trail preserved), so the heads-up was just friction.

    // ── In-progress guard: open timeclock blocks date/time/team edits ──────
    const tcRows = await db.execute(sql`
      SELECT user_id FROM timeclock
      WHERE job_id = ${jobId} AND clock_out_at IS NULL
      LIMIT 1
    `);
    const isClockedIn = tcRows.rows.length > 0;
    if (isClockedIn) {
      const blockedFields: string[] = [];
      if (scheduled_date !== undefined && scheduled_date !== before.scheduled_date) blockedFields.push("scheduled_date");
      if (scheduled_time !== undefined && scheduled_time !== before.scheduled_time) blockedFields.push("scheduled_time");
      if (team_user_ids !== undefined) blockedFields.push("team_user_ids");
      if (blockedFields.length) {
        return res.status(409).json({
          error: "Tech clocked in",
          message: "A technician is currently clocked in. Stop the timer before changing date, time, or team.",
          blocked_fields: blockedFields,
        });
      }
    }

    // ── Lookup actor (user_name + email at time of edit, for audit snapshot) ─
    const userRows = await db.execute(sql`
      SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1
    `);
    const actor = (userRows.rows[0] as Record<string, unknown>) ?? {};
    const actorName = `${actor.first_name ?? ""} ${actor.last_name ?? ""}`.trim() || "Unknown";
    const actorEmail = String(actor.email ?? "");

    // ── Build per-field change set (only fields actually present in body) ──
    type FieldName =
      | "service_type" | "frequency" | "scheduled_date" | "scheduled_time"
      | "allowed_hours" | "base_fee" | "hourly_rate" | "manual_rate_override"
      | "instructions" | "add_ons" | "team_user_ids" | "status"
      | "account_property_id";
    const changes: Array<{ field: FieldName; old: unknown; next: unknown }> = [];
    const pushChange = (field: FieldName, next: unknown, prev: unknown) => {
      const norm = (v: unknown) => v === null || v === undefined ? null : v;
      if (JSON.stringify(norm(next)) !== JSON.stringify(norm(prev))) {
        changes.push({ field, old: prev ?? null, next: next ?? null });
      }
    };

    if (service_type !== undefined) pushChange("service_type", service_type, before.service_type);
    if (frequency !== undefined) pushChange("frequency", frequency, before.frequency);
    if (scheduled_date !== undefined) pushChange("scheduled_date", scheduled_date, before.scheduled_date);
    if (scheduled_time !== undefined) pushChange("scheduled_time", scheduled_time, before.scheduled_time);
    if (allowed_hours !== undefined) pushChange("allowed_hours", String(allowed_hours), String(before.allowed_hours ?? ""));
    if (base_fee !== undefined) pushChange("base_fee", String(base_fee), String(before.base_fee ?? ""));
    if (hourly_rate !== undefined) pushChange("hourly_rate", String(hourly_rate), String(before.hourly_rate ?? ""));
    if (manual_rate_override !== undefined) pushChange("manual_rate_override", !!manual_rate_override, !!before.manual_rate_override);
    if (instructions !== undefined) pushChange("instructions", instructions, before.notes);
    // [BUG-3F1 / 2026-06-02] account_property_id change is a pure UPDATE.
    // Only valid for commercial jobs (the column is null on residential
    // rows). Reject the change if the requested property doesn't belong
    // to the same account — that's almost always an operator error or a
    // stale FE picker, and we'd rather 4xx than silently move the job to
    // a different customer.
    if (account_property_id !== undefined) {
      const reqPropId = account_property_id == null ? null : Number(account_property_id);
      const curPropId = before.account_property_id == null ? null : Number(before.account_property_id);
      if (reqPropId !== curPropId) {
        if (before.account_id == null) {
          return res.status(400).json({
            error: "Bad Request",
            message: "account_property_id can only be set on commercial jobs (account_id is null on this row).",
          });
        }
        if (reqPropId != null) {
          const propRows = await db.execute(sql`
            SELECT id, account_id FROM account_properties
             WHERE id = ${reqPropId} AND company_id = ${companyId}
             LIMIT 1
          `);
          const prop = propRows.rows[0] as any;
          if (!prop) {
            return res.status(404).json({
              error: "Not Found",
              message: `account_property_id ${reqPropId} not found.`,
            });
          }
          if (Number(prop.account_id) !== Number(before.account_id)) {
            return res.status(409).json({
              error: "Conflict",
              message: `Property ${reqPropId} belongs to account ${prop.account_id}, but this job is on account ${before.account_id}. Cannot move a job across accounts.`,
            });
          }
        }
        pushChange("account_property_id", reqPropId, curPropId);
      }
    }
    // Status transitions via PATCH are scoped to cancellation only — the
    // 'complete' path goes through POST /:id/complete (which writes the
    // completion artifacts: actual_end_time, locked_at, etc.). Allowing
    // status='cancelled' here unblocks the cancel modal in the dispatch
    // drawer; before this, the modal called PATCH { status:'cancelled' }
    // which silently dropped because status wasn't in the whitelist —
    // the row never changed, the UI optimistically removed the job, and
    // on the next refresh the job reappeared ("cancel makes a new one
    // pop in"). Now the status sticks.
    if (status !== undefined && status !== before.status) {
      if (status !== "cancelled") {
        return res.status(400).json({
          error: "Bad Request",
          message: "PATCH /:id only accepts status='cancelled'. Use POST /:id/complete for completions.",
        });
      }
      pushChange("status", status, before.status);
    }

    // For add_ons + team_user_ids we always emit an audit row when payload is present,
    // since per-row diff is verbose; the JSON payload carries the full new value.
    let addOnsProvided = false;
    let teamProvided = false;
    if (Array.isArray(add_ons)) {
      addOnsProvided = true;
      pushChange("add_ons", add_ons, "[unknown — see job_add_ons history]");
    }
    if (Array.isArray(team_user_ids)) {
      if (team_user_ids.length === 0) {
        return res.status(400).json({ error: "team_user_ids must include at least one user" });
      }
      teamProvided = true;
      pushChange("team_user_ids", team_user_ids, "[unknown — see job_technicians history]");
    }

    if (changes.length === 0) {
      return res.status(200).json({ ok: true, changed: false, message: "No changes detected" });
    }

    // ── manual_rate_override semantics ─────────────────────────────────────
    // Honor explicit flag from client. If client omitted it but sent a base_fee,
    // assume manual override. If client changed scope/freq/addons/hours but sent
    // no base_fee, clear the override flag (caller has accepted recalc-driven price).
    let nextManualOverride: boolean | undefined = undefined;
    if (manual_rate_override !== undefined) {
      nextManualOverride = !!manual_rate_override;
    } else if (base_fee !== undefined) {
      nextManualOverride = true;
    } else if (
      service_type !== undefined || frequency !== undefined ||
      addOnsProvided || allowed_hours !== undefined
    ) {
      nextManualOverride = false;
    }

    // [recurring-on-save 2026-04-30] Out-of-transaction handle for the
    // create_recurring path. The schedule INSERT happens inside the
    // transaction; the 60-day fan-out runs after commit (calls into
    // generateJobsFromSchedule which has its own dedupe + best-effort
    // semantics — must not roll back the parent edit if it hiccups).
    let createdScheduleId: number | null = null;

    // [PR / 2026-04-30] Sentinel for the dry-run rollback path. Defined
    // here so it's in scope for both the throw inside the tx callback
    // and the catch around `await db.transaction(...)` below.
    class DryRunRollback extends Error {
      constructor(public summary: Record<string, unknown>) {
        super("dry_run rollback");
      }
    }
    let dryRunSummary: Record<string, unknown> | null = null;

    // ── Apply changes in a transaction ─────────────────────────────────────
    await db.transaction(async (tx) => {
      // Update the jobs row itself.
      const setParts: any = {};
      if (service_type !== undefined) setParts.service_type = service_type;
      if (frequency !== undefined) setParts.frequency = frequency;
      if (scheduled_date !== undefined) setParts.scheduled_date = scheduled_date;
      if (scheduled_time !== undefined) setParts.scheduled_time = scheduled_time;
      if (allowed_hours !== undefined) setParts.allowed_hours = String(allowed_hours);
      if (base_fee !== undefined) setParts.base_fee = String(base_fee);
      if (hourly_rate !== undefined) setParts.hourly_rate = hourly_rate === null ? null : String(hourly_rate);
      if (nextManualOverride !== undefined) setParts.manual_rate_override = nextManualOverride;
      if (instructions !== undefined) setParts.notes = instructions;
      // Status: pushChange validated above that status==='cancelled' only.
      // Writing it here lets the cancel modal's PATCH actually take effect.
      if (status !== undefined && status !== before.status) setParts.status = status;
      // [BUG-3F1 / 2026-06-02] Property change writes the new FK directly.
      // Account validation already happened in pushChange (rejects 409 on
      // cross-account moves), so we trust the value at this point. Note:
      // this is the SAME atomic UPDATE that handles base_fee, time, etc.
      // — no parallel DELETE+INSERT path, no archive, the row keeps its
      // id. Fixes the lost-job repro from 06-01.
      if (account_property_id !== undefined && Number(account_property_id ?? null) !== Number(before.account_property_id ?? null)) {
        setParts.account_property_id = account_property_id == null ? null : Number(account_property_id);
      }

      // [PR / 2026-05-01 — re-implementation of yesterday's PR #34]
      // When the anchor is a completed job AND the operator picked a
      // cascade scope that propagates to the schedule template +
      // future jobs (this_and_future / all), strip the lock-protected
      // fields from setParts. The schedule UPDATE + future-jobs
      // cascade further down apply the changes to the right rows; the
      // anchor's `jobs` row keeps its original frequency / service_type
      // / base_fee / hourly_rate as part of the completed-work audit
      // trail. Surfaced in the response as anchor_protected +
      // anchor_skipped_fields so the modal can render an honest
      // success summary ("This visit is unchanged. Schedule updated.
      // 4 future jobs reflect new times.").
      const anchorSkippedFields: string[] = [];
      if (skipAnchorLockedFields) {
        if ("frequency" in setParts) { delete setParts.frequency; anchorSkippedFields.push("frequency"); }
        if ("service_type" in setParts) { delete setParts.service_type; anchorSkippedFields.push("service_type"); }
        if ("base_fee" in setParts) { delete setParts.base_fee; anchorSkippedFields.push("base_fee"); }
        if ("hourly_rate" in setParts) { delete setParts.hourly_rate; anchorSkippedFields.push("hourly_rate"); }
      }
      (req as any)._anchorSkippedFields = anchorSkippedFields;

      // [recurring-on-save 2026-04-30] create_recurring branch — INSERT
      // the new recurring_schedules row, anchored to the current job's
      // (possibly-just-edited) scheduled_date. Carryover fields come
      // from request payload + the pre-edit job row. The freshly-minted
      // scheduleId gets stamped onto setParts so the existing UPDATE
      // below links the current job in the same transaction. Add-on +
      // technician writes happen further down after their job-side
      // counterparts.
      if (wantsCreateRecurring) {
        const effectiveDate = scheduled_date !== undefined
          ? String(scheduled_date)
          : String(before.scheduled_date);
        const effectiveTime = scheduled_time !== undefined
          ? String(scheduled_time)
          : (before.scheduled_time as string | null);
        const freqStr = String(effectiveFrequency);
        // jobs.frequency → recurring_schedules.frequency. Same map used
        // by the this_and_future cascade further down (kept here to
        // avoid coupling — diverging is a real risk if both edit the
        // map without the other). Audit periodically.
        const freqMap: Record<string, { f: string; weeks: number | null }> = {
          weekly:        { f: "weekly",        weeks: 1 },
          biweekly:      { f: "biweekly",      weeks: 2 },
          every_3_weeks: { f: "every_3_weeks", weeks: null },
          monthly:       { f: "monthly",       weeks: 4 },
          daily:         { f: "daily",         weeks: null },
          weekdays:      { f: "weekdays",      weeks: null },
          custom_days:   { f: "custom_days",   weeks: null },
        };
        const fmap = freqMap[freqStr] ?? { f: "custom", weeks: null };
        // Multi-day frequencies use days_of_week (int[] 0..6); single-
        // day uses day_of_week (enum string). Mutually exclusive per
        // the schema invariant. For weekly/biweekly/etc. we derive the
        // day-of-week from effectiveDate so the schedule's anchor day
        // matches the current job. For daily we materialize [0..6];
        // weekdays = [1..5]; custom_days uses what the modal sent.
        const isMulti = freqStr === "daily" || freqStr === "weekdays" || freqStr === "custom_days";
        let scheduleDow: string | null = null;
        let scheduleDays: number[] | null = null;
        if (isMulti) {
          scheduleDays =
            freqStr === "daily" ? [0,1,2,3,4,5,6]
            : freqStr === "weekdays" ? [1,2,3,4,5]
            : (Array.isArray(days_of_week) ? days_of_week : []);
        } else {
          const DOW_ENUM = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
          // parseDate('YYYY-MM-DD') with no timezone arg lands UTC; we
          // want the local-day interpretation (matches how scheduled_date
          // is stored as a DATE, not TIMESTAMPTZ). Append T00:00 then
          // read getDay() — Date math stays in local TZ, getDay() uses
          // local. KNOWN_BUGS.md #4 (recurring anchor on Monday bug)
          // is the inverse case (UTC parse landing Monday for what
          // should be Sunday); same mitigation applies.
          const d = new Date(`${effectiveDate}T00:00:00`);
          scheduleDow = DOW_ENUM[d.getDay()];
        }
        // assigned_employee_id mirrors the primary tech: if the modal
        // sent a fresh team list, take the first (primary) user; else
        // keep whoever's currently on the job (jobs.assigned_user_id).
        const primaryUid = teamProvided && Array.isArray(team_user_ids) && team_user_ids.length > 0
          ? Number(team_user_ids[0])
          : (before.assigned_user_id != null ? Number(before.assigned_user_id) : null);
        // duration_minutes: convert allowed_hours (the modal's primary
        // duration field) when present, else inherit from before.
        const effectiveAllowedHours = allowed_hours !== undefined
          ? parseFloat(String(allowed_hours))
          : (before.allowed_hours != null ? parseFloat(String(before.allowed_hours)) : null);
        const durationMin = effectiveAllowedHours != null && Number.isFinite(effectiveAllowedHours)
          ? Math.round(effectiveAllowedHours * 60)
          : null;
        // service_type / base_fee / commercial_hourly_rate / parking_*
        // come from payload (preferred) with fallback to before.
        const effectiveServiceType = service_type !== undefined
          ? service_type
          : (before.service_type as string | null);
        const effectiveBaseFee = base_fee !== undefined
          ? String(base_fee)
          : (before.base_fee != null ? String(before.base_fee) : null);
        const effectiveHourlyRate = hourly_rate !== undefined
          ? (hourly_rate === null ? null : String(hourly_rate))
          : (before.hourly_rate != null ? String(before.hourly_rate) : null);
        const effectiveNotes = instructions !== undefined
          ? instructions
          : (before.notes as string | null);
        const effParkingEnabled = parking_fee_enabled !== undefined ? !!parking_fee_enabled : false;
        const effParkingAmount = parking_fee_amount !== undefined && parking_fee_amount !== null
          ? String(parking_fee_amount)
          : null;
        const effParkingDays = Array.isArray(parking_fee_days) && parking_fee_days.length > 0
          ? parking_fee_days
          : null;

        // [recurring-on-save 2026-04-30 / fix #25] Switched from raw
        // `sql` template to Drizzle ORM .insert().values().returning()
        // because the previous tag interpolated `${scheduleDays}` (a
        // JS array) by spreading each element as a separate scalar
        // bind — yielding `($5, $6, $7, $8, $9)::int[]` which is
        // invalid SQL and shifted every subsequent param off by N-1.
        // The ORM path uses the schema's column codecs (notably
        // integer().array() for days_of_week / parking_fee_days and
        // the pgEnum types for frequency / day_of_week) and binds
        // each value as exactly one parameter. Same pattern as
        // POST /api/recurring (routes/recurring.ts:54-66).
        const [insertedRow] = await tx
          .insert(recurringSchedulesTable)
          .values({
            company_id: companyId,
            customer_id: Number(before.client_id),
            frequency: fmap.f as any,
            day_of_week: scheduleDow as any,
            days_of_week: scheduleDays,
            custom_frequency_weeks: fmap.weeks,
            start_date: effectiveDate,
            end_date: null,
            scheduled_time: effectiveTime as any,
            assigned_employee_id: primaryUid,
            service_type: effectiveServiceType,
            duration_minutes: durationMin,
            base_fee: effectiveBaseFee,
            commercial_hourly_rate: effectiveHourlyRate,
            notes: effectiveNotes,
            instructions: effectiveNotes,
            is_active: true,
            parking_fee_enabled: effParkingEnabled,
            parking_fee_amount: effParkingAmount,
            parking_fee_days: effParkingDays,
          })
          .returning({ id: recurringSchedulesTable.id });
        createdScheduleId = Number(insertedRow.id);
        setParts.recurring_schedule_id = createdScheduleId;
      }

      if (Object.keys(setParts).length > 0) {
        await tx.update(jobsTable).set(setParts).where(and(
          eq(jobsTable.id, jobId),
          eq(jobsTable.company_id, companyId),
        ));
      }

      // Replace job_technicians if team_user_ids provided. First user = primary.
      if (teamProvided && Array.isArray(team_user_ids)) {
        await tx.execute(sql`DELETE FROM job_technicians WHERE job_id = ${jobId}`);
        for (let i = 0; i < team_user_ids.length; i++) {
          const uid = team_user_ids[i];
          const isPrimary = i === 0;
          await tx.execute(sql`
            INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
            VALUES (${jobId}, ${uid}, ${companyId}, ${isPrimary})
            ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
          `);
        }
        // Mirror the primary onto jobs.assigned_user_id so the dispatch grid
        // (which reads assigned_user_id, not job_technicians) shows the new
        // tech immediately. Fixes the Jaira-Estrada split-brain we saw.
        await tx.update(jobsTable).set({ assigned_user_id: team_user_ids[0] }).where(and(
          eq(jobsTable.id, jobId),
          eq(jobsTable.company_id, companyId),
        ));
      }

      // Replace job_add_ons if add_ons provided. FK-resolution lives in the
      // shared persistJobAddOns helper (see its [AI.6.3] note) so create and
      // edit stay in lockstep.
      if (addOnsProvided && Array.isArray(add_ons)) {
        await persistJobAddOns(tx, jobId, companyId, add_ons as JobAddOnInput[]);
      }

      // [recurring-on-save 2026-04-30] Seed the new schedule's
      // technician + add-on tables from the just-saved per-job state
      // so future engine-spawned jobs inherit the same crew + add-ons.
      // Mirrors the existing this_and_future cascade block below
      // (lines further down) which does the same for already-existing
      // schedules. team_user_ids fallback: if the modal didn't send
      // a fresh team list (teamProvided=false), seed from the current
      // job's assigned_user_id so the schedule still has an owner.
      if (wantsCreateRecurring && createdScheduleId != null) {
        const newSchedId = Number(createdScheduleId);
        const techList: number[] = teamProvided && Array.isArray(team_user_ids) && team_user_ids.length > 0
          ? team_user_ids.map((u: unknown) => Number(u))
          : (before.assigned_user_id != null ? [Number(before.assigned_user_id)] : []);
        for (let i = 0; i < techList.length; i++) {
          const uid = techList[i];
          const isPrimary = i === 0;
          await tx.execute(sql`
            INSERT INTO recurring_schedule_technicians (recurring_schedule_id, user_id, is_primary)
            VALUES (${newSchedId}, ${uid}, ${isPrimary})
            ON CONFLICT (recurring_schedule_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
          `);
        }
        // [PR #27] Capture the addon list separately from the per-job
        // job_add_ons writes above so the per-date cascade loop below
        // can reuse it for in-place UPDATE'd jobs and freshly INSERTed
        // empty-day jobs alike.
        const cascadeAddonList: Array<{ pricing_addon_id: number; qty: number; unit_price: string; subtotal: string }> = [];
        if (addOnsProvided && Array.isArray(add_ons)) {
          for (const a of add_ons as Array<{ pricing_addon_id?: number; qty?: number; unit_price?: number; subtotal?: number }>) {
            const pricingId = Number(a.pricing_addon_id ?? 0);
            const qty = Number(a.qty ?? 1) || 1;
            if (!pricingId) continue;
            await tx.execute(sql`
              INSERT INTO recurring_schedule_add_ons (recurring_schedule_id, pricing_addon_id, qty)
              VALUES (${newSchedId}, ${pricingId}, ${qty})
            `);
            cascadeAddonList.push({
              pricing_addon_id: pricingId,
              qty,
              unit_price: a.unit_price != null ? String(a.unit_price) : "0",
              subtotal: a.subtotal != null ? String(a.subtotal) : "0",
            });
          }
        }

        // [PR #27] Per-date cascade — overwrite existing future jobs in
        // place + insert on empty days. This is the difference between
        // PR #25/#26 (which only inserted on empty days, leaving
        // imported MaidCentral Tue–Fri jobs untouched with stale
        // service_type/duration/tech/etc.) and the production
        // expectation: edit Monday → expect Tue–Fri to inherit the
        // schedule's settings.
        //
        // Money may have been collected or invoiced; never overwrite
        // billed work. A job is "locked" against overwrite when ANY of
        //   status = 'complete'                       (job marked done)
        //   status = 'cancelled'                      (job killed)
        //   charge_succeeded_at IS NOT NULL           (Stripe/Square paid)
        //   exists(invoices.job_id = jobs.id)         (invoice issued)
        // is true. Locked jobs emit a console log and stay untouched.
        //
        // Tech assignment on update overwrites with the schedule's
        // default crew — mid-week per-day tech swap with "apply to all
        // future" prompt is PR #28, out of scope here.
        const { computeOccurrencesForSchedule, insertJobFromSchedule, resolveParkingAddon, stampParkingFeeOnJob, parkingApplies, DAYS_AHEAD: HORIZON } = await import("../lib/recurring-jobs.js");
        const cascadeSched = await tx.execute(sql`
          SELECT id, company_id, customer_id, frequency, day_of_week, days_of_week,
                 custom_frequency_weeks, start_date, end_date, scheduled_time,
                 assigned_employee_id, service_type, duration_minutes, base_fee,
                 commercial_hourly_rate, notes, instructions,
                 parking_fee_enabled, parking_fee_amount, parking_fee_days
          FROM recurring_schedules WHERE id = ${newSchedId} LIMIT 1
        `);
        const sched = cascadeSched.rows[0] as any;
        const cascadeClient = await tx.execute(sql`
          SELECT zip FROM clients WHERE id = ${Number(before.client_id)} LIMIT 1
        `);
        const cascadeClientZip = ((cascadeClient.rows[0] as any)?.zip ?? null) as string | null;
        const cascadeToday = new Date();
        const cascadeHorizon = new Date(cascadeToday.getTime() + HORIZON * 24 * 60 * 60 * 1000);

        // computeOccurrencesForSchedule returns the matching dates in
        // the window. Its dedupe filters jobs whose
        // recurring_schedule_id = sched.id — but the freshly-INSERTed
        // schedule has zero linked rows in the *committed* state
        // visible to db.select() (this transaction hasn't committed),
        // so the result includes every matching weekday including the
        // current Monday. We skip the current jobId explicitly in the
        // loop below to avoid double-processing.
        const { rows: candidateRows } = await computeOccurrencesForSchedule(
          sched, cascadeToday, cascadeHorizon, null, cascadeClientZip,
        );

        const cascadeParking = sched.parking_fee_enabled === true
          ? await resolveParkingAddon(sched, tx)
          : null;
        if (sched.parking_fee_enabled === true && !cascadeParking) {
          console.warn(
            `[cascade-create-recurring] schedule ${newSchedId} has parking_fee_enabled but ` +
            `company ${companyId} has no active Parking Fee pricing_addon — skipping stamp`,
          );
        }

        // Helper: resolve a real `add_ons.id` for the FK on
        // `job_add_ons.add_on_id` from a pricing_addons.id. Mirrors
        // the resolution logic in the per-job add-ons write above
        // (lines ~1316-1346) — same pricing_addons → add_ons name
        // lookup with create-if-absent fallback.
        const resolveRealAddOnId = async (pricingId: number): Promise<number | null> => {
          const paRows = await tx.execute(sql`
            SELECT name FROM pricing_addons WHERE id = ${pricingId} LIMIT 1
          `);
          const paName = String((paRows.rows[0] as any)?.name ?? "").trim();
          if (!paName) return null;
          const ex = await tx.execute(sql`
            SELECT id FROM add_ons
            WHERE company_id = ${companyId} AND LOWER(name) = LOWER(${paName})
            LIMIT 1
          `);
          if (ex.rows.length) return Number((ex.rows[0] as any).id);
          const cre = await tx.execute(sql`
            INSERT INTO add_ons (company_id, name, price, category, is_active)
            VALUES (${companyId}, ${paName}, '0', 'other', true)
            RETURNING id
          `);
          return Number((cre.rows[0] as any).id);
        };

        // Pre-resolve add_ons FK ids for the schedule's addon list
        // so we don't repeat the lookup per-date.
        const cascadeAddonsResolved: Array<{ pricing_addon_id: number; add_on_id: number; qty: number; unit_price: string; subtotal: string }> = [];
        for (const a of cascadeAddonList) {
          const aid = await resolveRealAddOnId(a.pricing_addon_id);
          if (aid != null) {
            cascadeAddonsResolved.push({ ...a, add_on_id: aid });
          }
        }

        let cascadeOverwritten = 0;
        let cascadeInserted = 0;
        let cascadeSkippedLocked = 0;

        // The anchor job IS the first occurrence — it already carries the
        // schedule's settings and was linked above. The cadence window
        // includes its date, so without this guard the loop would query
        // existing jobs at that date EXCLUDING the anchor (`j.id != jobId`),
        // see "no other job," and INSERT a duplicate of the anchor on the
        // same day. Normalize the anchor's date (before.scheduled_date is a
        // raw pg Date; scheduled_date from the payload is a string) and skip
        // it so we never self-duplicate.
        const anchorDateStr = scheduled_date !== undefined
          ? String(scheduled_date)
          : (before.scheduled_date instanceof Date
              ? `${before.scheduled_date.getFullYear()}-${String(before.scheduled_date.getMonth() + 1).padStart(2, "0")}-${String(before.scheduled_date.getDate()).padStart(2, "0")}`
              : String(before.scheduled_date));

        for (const row of candidateRows) {
          const dateStr = String(row.scheduled_date);
          if (dateStr === anchorDateStr) continue;
          const date = new Date(`${dateStr}T00:00:00`);

          // Find existing jobs at this date for this client EXCEPT the
          // current job (already updated via setParts above). FOR
          // UPDATE locks the rows so concurrent edits don't race.
          const existingJobs = await tx.execute(sql`
            SELECT j.id, j.status, j.charge_succeeded_at,
                   EXISTS(SELECT 1 FROM invoices i WHERE i.job_id = j.id) AS has_invoice
            FROM jobs j
            WHERE j.company_id = ${companyId}
              AND j.client_id = ${Number(before.client_id)}
              AND j.scheduled_date = ${dateStr}::date
              AND j.id != ${jobId}
            FOR UPDATE
          `);
          const existingRows = existingJobs.rows as Array<{
            id: number; status: string;
            charge_succeeded_at: string | null;
            has_invoice: boolean;
          }>;

          if (existingRows.length === 0) {
            // Empty day — INSERT a fresh job from the schedule template.
            const newJobId = await insertJobFromSchedule(
              sched, date, tx, null, cascadeClientZip,
            );
            cascadeInserted++;
            for (let i = 0; i < techList.length; i++) {
              const uid = techList[i];
              const isPrimary = i === 0;
              await tx.execute(sql`
                INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
                VALUES (${newJobId}, ${uid}, ${companyId}, ${isPrimary})
                ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
              `);
            }
            if (techList.length > 0) {
              await tx.execute(sql`
                UPDATE jobs SET assigned_user_id = ${techList[0]}
                WHERE id = ${newJobId} AND company_id = ${companyId}
              `);
            }
            for (const a of cascadeAddonsResolved) {
              await tx.execute(sql`
                INSERT INTO job_add_ons (job_id, add_on_id, quantity, unit_price, subtotal, pricing_addon_id)
                VALUES (${newJobId}, ${a.add_on_id}, ${a.qty}, ${a.unit_price}, ${a.subtotal}, ${a.pricing_addon_id})
                ON CONFLICT (job_id, add_on_id) DO UPDATE
                  SET quantity = EXCLUDED.quantity,
                      unit_price = EXCLUDED.unit_price,
                      subtotal = EXCLUDED.subtotal,
                      pricing_addon_id = EXCLUDED.pricing_addon_id
              `);
            }
            if (cascadeParking && parkingApplies(sched, date)) {
              await stampParkingFeeOnJob(newJobId, cascadeParking, tx);
            }
            continue;
          }

          // 1+ existing jobs at this date. Decide overwrite or skip
          // per row — locked jobs are never overwritten.
          for (const ex of existingRows) {
            const isLocked = ex.status === "complete"
              || ex.status === "cancelled"
              || ex.charge_succeeded_at != null
              || ex.has_invoice === true;
            if (isLocked) {
              console.log(`[cascade-create-recurring] skipped job_id=${ex.id} reason=status_locked`);
              cascadeSkippedLocked++;
              continue;
            }
            // UPDATE in place — preserve job id (audit log + history
            // references depend on stable ids per the spec). Drizzle
            // ORM .update().set() handles the column codecs.
            await tx
              .update(jobsTable)
              .set({
                scheduled_time: sched.scheduled_time as any,
                allowed_hours: sched.duration_minutes
                  ? String((Number(sched.duration_minutes) / 60).toFixed(2))
                  : null as any,
                service_type: sched.service_type as any,
                base_fee: sched.base_fee != null ? String(sched.base_fee) : null as any,
                hourly_rate: sched.commercial_hourly_rate != null
                  ? String(sched.commercial_hourly_rate)
                  : null as any,
                frequency: sched.frequency as any,
                recurring_schedule_id: newSchedId,
                notes: (sched.notes ?? sched.instructions ?? null) as any,
              })
              .where(and(
                eq(jobsTable.id, Number(ex.id)),
                eq(jobsTable.company_id, companyId),
              ));
            // Sync techs: replace job_technicians with the schedule's crew.
            await tx.execute(sql`DELETE FROM job_technicians WHERE job_id = ${Number(ex.id)}`);
            for (let i = 0; i < techList.length; i++) {
              const uid = techList[i];
              const isPrimary = i === 0;
              await tx.execute(sql`
                INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
                VALUES (${Number(ex.id)}, ${uid}, ${companyId}, ${isPrimary})
                ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
              `);
            }
            if (techList.length > 0) {
              await tx.execute(sql`
                UPDATE jobs SET assigned_user_id = ${techList[0]}
                WHERE id = ${Number(ex.id)} AND company_id = ${companyId}
              `);
            }
            // Sync add-ons: replace job_add_ons with the schedule's set.
            await tx.execute(sql`DELETE FROM job_add_ons WHERE job_id = ${Number(ex.id)}`);
            for (const a of cascadeAddonsResolved) {
              await tx.execute(sql`
                INSERT INTO job_add_ons (job_id, add_on_id, quantity, unit_price, subtotal, pricing_addon_id)
                VALUES (${Number(ex.id)}, ${a.add_on_id}, ${a.qty}, ${a.unit_price}, ${a.subtotal}, ${a.pricing_addon_id})
                ON CONFLICT (job_id, add_on_id) DO UPDATE
                  SET quantity = EXCLUDED.quantity,
                      unit_price = EXCLUDED.unit_price,
                      subtotal = EXCLUDED.subtotal,
                      pricing_addon_id = EXCLUDED.pricing_addon_id
              `);
            }
            // Stamp parking on top if the schedule says so for this DOW.
            // Idempotent via stampParkingFeeOnJob's ON CONFLICT.
            if (cascadeParking && parkingApplies(sched, date)) {
              await stampParkingFeeOnJob(Number(ex.id), cascadeParking, tx);
            }
            cascadeOverwritten++;
          }
        }

        // Stash counts for the response.
        (req as any)._cascadeOverwritten = cascadeOverwritten;
        (req as any)._cascadeInserted = cascadeInserted;
        (req as any)._cascadeSkippedLocked = cascadeSkippedLocked;
      }

      // ── Cascade: this_and_future or all ──────────────────────────────────
      // [cascade-scope 2026-04-29] 'all' shares the schedule-template
      // update + cadence-pattern logic with 'this_and_future'; the only
      // semantic difference is the date filter for the future-jobs
      // cascade (no `> CURRENT_DATE` filter on 'all') and an explicit
      // skip of paid past occurrences. We treat them under one block
      // and branch on `cascadeAllScope` at the SQL level.
      let futureCount = 0;
      let futureClockedSkipped = 0;
      let futureDeleted = 0;     // [AI] Hybrid cascade: jobs whose date no longer matches new pattern
      let futureInserted = 0;    // [AI] Hybrid cascade: new dates the new pattern requires
      const cascadeAllScope = cascade_scope === "all";
      if ((cascade_scope === "this_and_future" || cascadeAllScope) && before.recurring_schedule_id != null) {
        const scheduleId = Number(before.recurring_schedule_id);

        // [AI] Detect day-pattern change so we know whether to run the AG
        // in-place UPDATE path or the AI hybrid (UPDATE matching + DELETE
        // non-matching + INSERT new).
        const isMultiDayNext = frequency === "daily" || frequency === "weekdays" || frequency === "custom_days";
        const wasMultiDayBefore = before.frequency === "daily" || before.frequency === "weekdays" || before.frequency === "custom_days";
        const dayPatternChanged =
          (frequency !== undefined && frequency !== before.frequency) ||
          (Array.isArray(days_of_week));

        // [PR / 2026-05-01 — array-binding fix] Update the parent
        // recurring_schedules row using Drizzle ORM .update().set()
        // instead of a hand-rolled `sql` template. The previous
        // implementation interpolated array values (e.g. days_of_week
        // = [1,2,3,4,5]) via `sql\`${rsVals[i]}\``, which Drizzle's
        // template tag spreads into multiple parameter placeholders —
        // same bug class as PR #25's INSERT (fixed in PR #26 by
        // switching to ORM). The bug stayed latent because the
        // completed-anchor 409 lock blocked this code path until
        // PR #39 made the lock cascade-scope-aware. Drizzle's
        // `.set({})` uses the schema's column codecs (the
        // `integer().array()` codec for days_of_week /
        // parking_fee_days, the pgEnum codec for frequency /
        // day_of_week) and binds each value as exactly ONE parameter.
        const rsSetParts: Record<string, unknown> = {};
        if (service_type !== undefined) rsSetParts.service_type = service_type;
        if (scheduled_time !== undefined) rsSetParts.scheduled_time = scheduled_time;
        if (allowed_hours !== undefined) rsSetParts.duration_minutes = Math.round(parseFloat(String(allowed_hours)) * 60);
        if (base_fee !== undefined) rsSetParts.base_fee = String(base_fee);
        if (instructions !== undefined) rsSetParts.instructions = instructions;
        if (nextManualOverride !== undefined) rsSetParts.manual_rate_override = nextManualOverride;
        // [AH] Cascade commercial hourly rate to the schedule template so
        // engine-spawned future jobs inherit the rate.
        if (hourly_rate !== undefined) rsSetParts.commercial_hourly_rate = hourly_rate === null ? null : String(hourly_rate);
        // [AI] Map jobs.frequency to recurring_schedules.frequency.
        // After the AI enum extensions, every_3_weeks/daily/weekdays/custom_days
        // now exist on recurring_frequency too — pass through directly.
        // 'on_demand' has no recurring equivalent → fall back to 'custom'.
        if (frequency !== undefined) {
          const map: Record<string, { f: string; weeks: number | null }> = {
            weekly:        { f: "weekly", weeks: 1 },
            biweekly:      { f: "biweekly", weeks: 2 },
            every_3_weeks: { f: "every_3_weeks", weeks: null },
            monthly:       { f: "monthly", weeks: 4 },
            daily:         { f: "daily", weeks: null },
            weekdays:      { f: "weekdays", weeks: null },
            custom_days:   { f: "custom_days", weeks: null },
            on_demand:     { f: "custom", weeks: null },
          };
          const m = map[String(frequency)] ?? { f: "custom", weeks: null };
          rsSetParts.frequency = m.f;
          rsSetParts.custom_frequency_weeks = m.weeks;
        }
        // [AI] Cascade days_of_week + clear day_of_week when switching to
        // multi-day. Inverse: clear days_of_week when switching back to
        // single-day to preserve the documented exclusivity invariant.
        if (frequency !== undefined) {
          if (isMultiDayNext) {
            // For 'daily' and 'weekdays' we materialize the implicit array onto
            // the row so the engine sees consistent storage; 'custom_days'
            // stores whatever the user picked.
            const arr =
              frequency === "daily" ? [0,1,2,3,4,5,6]
              : frequency === "weekdays" ? [1,2,3,4,5]
              : (Array.isArray(days_of_week) ? days_of_week : []);
            rsSetParts.days_of_week = arr;
            rsSetParts.day_of_week = null;
          } else {
            // Switching back to single-day — clear the multi-day array.
            rsSetParts.days_of_week = null;
          }
        } else if (Array.isArray(days_of_week)) {
          // Frequency unchanged but days_of_week explicitly provided
          // (e.g., user added/removed a day on an existing custom_days schedule)
          rsSetParts.days_of_week = days_of_week;
        }

        // [AI.7.1] Parking fee cascade. Persist parking_fee_enabled +
        // parking_fee_amount + parking_fee_days onto the schedule so the
        // engine applies parking to every future occurrence per the
        // operator's day selection. Null amount = use tenant default;
        // null/empty days = apply to all scheduled days.
        if (parking_fee_enabled !== undefined) {
          rsSetParts.parking_fee_enabled = !!parking_fee_enabled;
        }
        if (parking_fee_amount !== undefined) {
          rsSetParts.parking_fee_amount = parking_fee_amount === null ? null : String(parking_fee_amount);
        }
        if (parking_fee_days !== undefined) {
          rsSetParts.parking_fee_days = Array.isArray(parking_fee_days) && parking_fee_days.length > 0 ? parking_fee_days : null;
        }

        if (Object.keys(rsSetParts).length > 0) {
          await tx
            .update(recurringSchedulesTable)
            .set(rsSetParts as any)
            .where(and(
              eq(recurringSchedulesTable.id, scheduleId),
              eq(recurringSchedulesTable.company_id, companyId),
            ));
          // [PR / 2026-05-01 — re-implementation of yesterday's PR #34]
          // Stash for the response so the modal can compose an honest
          // success summary ("Schedule updated. 4 future jobs reflect
          // new times. This visit is unchanged.")
          (req as any)._scheduleUpdated = true;
        }

        // ── Future-jobs cascade: branch by whether day pattern changed ────
        const futureJobsSet: string[] = [];
        const futureJobsVals: any[] = [];
        const pushFj = (col: string, val: any) => { futureJobsSet.push(col); futureJobsVals.push(val); };
        if (service_type !== undefined) pushFj("service_type", service_type);
        if (frequency !== undefined) pushFj("frequency", frequency);
        if (scheduled_time !== undefined) pushFj("scheduled_time", scheduled_time);
        if (allowed_hours !== undefined) pushFj("allowed_hours", String(allowed_hours));
        if (base_fee !== undefined) pushFj("base_fee", String(base_fee));
        if (hourly_rate !== undefined) pushFj("hourly_rate", hourly_rate === null ? null : String(hourly_rate));
        if (instructions !== undefined) pushFj("notes", instructions);
        if (nextManualOverride !== undefined) pushFj("manual_rate_override", nextManualOverride);

        // Always link cascade targets back to the schedule so the
        // next save sees them via the schedule_id path even if some
        // older path (e.g., MC import, manual SQL fix) left
        // recurring_schedule_id NULL on a row that's truly part of
        // this series.
        pushFj("recurring_schedule_id", scheduleId);

        if (futureJobsSet.length > 0 || dayPatternChanged) {
          // Find candidate jobs in the series. For 'this_and_future' we
          // only touch future scheduled jobs. For 'all' we widen the
          // window to include past too, but skip jobs whose money has
          // already moved (charge_succeeded_at IS NOT NULL) — those need
          // refund/surcharge flows, not silent overwrites — and skip
          // completed jobs whose status would otherwise be downgraded.
          // Cancelled jobs are excluded both ways. The current job
          // updates via the main UPDATE statement so we exclude it
          // here to avoid double-write.
          //
          // [PR / 2026-05-03] Conflict semantics rewrite. The previous
          // PR #42 OR clause also picked up unlinked client jobs whose
          // weekday matched the schedule's days_of_week (the MC-import
          // absorb sweep). That had a nasty side effect: when an
          // unrelated standalone job (different tech / time / service)
          // happened to fall on a matching weekday, the cascade would
          // silently relink it to this schedule (pushFj on line 1828
          // sets recurring_schedule_id = scheduleId). Then the INSERT
          // step's compute() helper, which dedupes by
          // recurring_schedule_id, saw the now-relinked row in
          // existingDates and skipped creating the missing-day
          // occurrence. Net: the standalone got clobbered AND no new
          // recurring instance was created on that day.
          //
          // New behavior matches Google Calendar / Outlook /
          // ServiceTitan / Jobber: cascade only operates on jobs
          // explicitly linked to THIS schedule. Unrelated jobs on the
          // same (client_id, scheduled_date) are left alone, and the
          // cascade INSERTs a fresh recurring occurrence on that day
          // — both jobs coexist; the operator resolves the dupe via
          // the UI (e.g., cancels the unrelated standalone). Trade-off
          // accepted: MC-imported unlinked jobs no longer auto-absorb,
          // so operators see two rows on absorb-eligible days until
          // they archive the standalone.
          const candidates = await tx.execute(sql`
            SELECT j.id, j.scheduled_date::text AS scheduled_date
            FROM jobs j
            WHERE j.company_id = ${companyId}
              AND j.id != ${jobId}
              AND j.status NOT IN ('cancelled')
              AND j.recurring_schedule_id = ${scheduleId}
              AND ${cascadeAllScope
                  ? sql`j.charge_succeeded_at IS NULL AND j.status != 'complete'`
                  : sql`j.scheduled_date > CURRENT_DATE AND j.status = 'scheduled'`}
          `);
          type Cand = { id: number; scheduled_date: string };
          const cands = (candidates.rows as unknown as Cand[]).map(r => ({ id: Number(r.id), scheduled_date: String(r.scheduled_date) }));
          const candIds = cands.map(c => c.id);
          // [PR / 2026-05-01 — comprehensive array-bind audit fix]
          // Was: tx.execute(sql`... = ANY(${candIds}::int[])`) which
          // spreads candIds into N scalar parameters per the same bug
          // that hit PR #25's INSERT (fixed in #26) and PR #38's
          // recurring_schedules UPDATE (fixed in #40). Drizzle's
          // inArray() helper binds the array as a single parameter.
          const clockedRowsRes = candIds.length === 0
            ? [] as Array<{ job_id: number }>
            : await tx
                .selectDistinct({ job_id: timeclockTable.job_id })
                .from(timeclockTable)
                .where(and(
                  isNull(timeclockTable.clock_out_at),
                  inArray(timeclockTable.job_id, candIds),
                ));
          const clockedSet = new Set(clockedRowsRes.map(r => Number(r.job_id)));

          // [AI] Hybrid cascade. Build the new pattern's valid future-date set
          // and bucket each candidate job:
          //   - in valid set → UPDATE (preserve job + tech + instructions)
          //   - not in valid set → DELETE (drop)
          // Then INSERT any new dates the pattern requires that don't yet exist
          // (handled by computeOccurrencesForSchedule's existing dedupe).
          //
          // We don't have access to the unexported generateOccurrences
          // function, so we inline the same DOW-matching logic here. Window
          // matches the engine default (60 days from tomorrow).
          let validDateSet: Set<string> | null = null;
          if (dayPatternChanged) {
            // Pull the freshly-updated schedule row so we use the new pattern.
            const schedRow = await tx.execute(sql`
              SELECT frequency, day_of_week, days_of_week, custom_frequency_weeks
              FROM recurring_schedules WHERE id = ${scheduleId} LIMIT 1
            `);
            const sched = schedRow.rows[0] as any;
            const newFreq = String(sched.frequency);
            const newDow = sched.days_of_week as number[] | null;
            const newDayName = sched.day_of_week as string | null;
            const customWeeks = sched.custom_frequency_weeks as number | null;

            // Multi-day path: easy — match by DOW for every candidate date.
            const isMulti = newFreq === "daily" || newFreq === "weekdays" || newFreq === "custom_days";
            if (isMulti) {
              const dowArr =
                newFreq === "daily" ? [0,1,2,3,4,5,6]
                : newFreq === "weekdays" ? [1,2,3,4,5]
                : (newDow ?? []);
              const dowSet = new Set(dowArr);
              validDateSet = new Set(cands.filter(c => dowSet.has(new Date(c.scheduled_date).getDay())).map(c => c.scheduled_date));
            } else {
              // Single-day path. Match by day-of-week + interval cadence.
              // For weekly/biweekly/every_3_weeks: candidate must be the
              // configured weekday AND offset from the schedule's anchor by
              // a multiple of the interval.
              const dayMap: Record<string, number> = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
              const target = newDayName ? dayMap[String(newDayName).toLowerCase()] : null;
              const interval =
                newFreq === "weekly" ? 7
                : newFreq === "biweekly" ? 14
                : newFreq === "every_3_weeks" ? 21
                : (newFreq === "custom" && customWeeks != null) ? customWeeks * 7
                : null;
              if (target != null && interval != null) {
                // Need a stable anchor. Use the earliest existing future job
                // that matches the target DOW (if any); else just match by DOW.
                validDateSet = new Set(cands.filter(c => {
                  const d = new Date(c.scheduled_date);
                  return d.getDay() === target;
                }).map(c => c.scheduled_date));
              } else if (newFreq === "monthly") {
                // Monthly: preserve all existing future jobs (interval is
                // calendar-month-aware; conservative behavior).
                validDateSet = new Set(cands.map(c => c.scheduled_date));
              }
            }
            if (!validDateSet) validDateSet = new Set();
          }

          // Bucket: jobs to UPDATE, jobs to DELETE.
          const toUpdate: number[] = [];
          const toDelete: number[] = [];
          let skippedClockedUpdate = 0;
          let skippedClockedDelete = 0;
          for (const c of cands) {
            if (clockedSet.has(c.id)) {
              // Clocked-in jobs are never modified or deleted.
              skippedClockedUpdate++;
              continue;
            }
            if (validDateSet && !validDateSet.has(c.scheduled_date)) {
              toDelete.push(c.id);
            } else {
              toUpdate.push(c.id);
            }
          }
          futureClockedSkipped = skippedClockedUpdate + skippedClockedDelete;

          // UPDATE matching jobs in place.
          // [PR / 2026-05-01 — comprehensive array-bind audit fix]
          // Was: hand-rolled `sql\`UPDATE jobs SET ${setSql} WHERE id =
          // ANY(${toUpdate}::int[])\`` — same bug class as PR #25 /
          // PR #40. Switched to Drizzle ORM `.update().set().where(
          // inArray(...))`. The set fields are scalars (frequency,
          // service_type, scheduled_time, allowed_hours, base_fee,
          // hourly_rate, notes, manual_rate_override) — none are
          // arrays — so they're safe in the parameterised set object.
          // The WHERE id IN (...) is the array-bind risk; inArray()
          // binds the JS number[] as ONE int[] parameter.
          if (toUpdate.length > 0 && futureJobsSet.length > 0) {
            const updJobsSet: Record<string, unknown> = {};
            for (let i = 0; i < futureJobsSet.length; i++) {
              updJobsSet[futureJobsSet[i]] = futureJobsVals[i];
            }
            const updRes = await tx
              .update(jobsTable)
              .set(updJobsSet as any)
              .where(inArray(jobsTable.id, toUpdate));
            futureCount = (updRes as any).rowCount ?? toUpdate.length;
          } else {
            futureCount = toUpdate.length;
          }

          // [PR / 2026-05-01] Per-job tech + addon + parking sync for
          // cascaded jobs. The legacy this_and_future UPDATE only wrote
          // scalar fields (frequency / scheduled_time / base_fee /
          // etc.) — never re-assigned techs or addons. Result on Sal's
          // 2026-05-01 repro: Mon's edit set Tue's tech to Alma in
          // jobs.assigned_user_id (wrong path), but Tue's
          // job_technicians still had Juan, so the dispatch grid
          // (which reads job_technicians for the tech chip) still
          // showed Juan. Same gap for parking — the schedule template's
          // parking_fee_days got the new value but cascaded jobs
          // never had their job_add_ons.parking-fee row stamped /
          // re-stamped.
          //
          // Mirrors the create_recurring branch's per-job sync block
          // (see line ~1700 onward). Same skip-locked-jobs rule already
          // applied at the SELECT level above (status NOT IN cancelled
          // + status='scheduled' for this_and_future / charge_succeeded_at
          // IS NULL + status != complete for all). Tech list comes from
          // recurring_schedule_technicians (mirror written further down
          // when teamProvided) — for the cascade target jobs, sync from
          // the team_user_ids payload directly.
          if (toUpdate.length > 0 && (teamProvided || addOnsProvided)) {
            const techListForCascade: number[] = teamProvided && Array.isArray(team_user_ids) && team_user_ids.length > 0
              ? team_user_ids.map((u: unknown) => Number(u))
              : [];
            const { resolveParkingAddon, parkingApplies, stampParkingFeeOnJob } = await import("../lib/recurring-jobs.js");
            const cascadeParkingResolved = await resolveParkingAddon(
              {
                company_id: companyId,
                parking_fee_amount: parking_fee_amount === null || parking_fee_amount === undefined
                  ? null
                  : String(parking_fee_amount),
              },
              tx,
            );
            for (const jId of toUpdate) {
              if (techListForCascade.length > 0) {
                await tx.execute(sql`DELETE FROM job_technicians WHERE job_id = ${jId}`);
                for (let i = 0; i < techListForCascade.length; i++) {
                  const uid = techListForCascade[i];
                  const isPrimary = i === 0;
                  await tx.execute(sql`
                    INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
                    VALUES (${jId}, ${uid}, ${companyId}, ${isPrimary})
                    ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
                  `);
                }
                await tx.execute(sql`
                  UPDATE jobs SET assigned_user_id = ${techListForCascade[0]}
                  WHERE id = ${jId} AND company_id = ${companyId}
                `);
              }
              if (addOnsProvided && Array.isArray(add_ons)) {
                await tx.execute(sql`DELETE FROM job_add_ons WHERE job_id = ${jId}`);
                for (const a of add_ons as Array<{ pricing_addon_id?: number; add_on_id?: number; qty?: number; unit_price?: number; subtotal?: number }>) {
                  const pricingId = Number(a.pricing_addon_id ?? 0) || null;
                  const qty = Number(a.qty ?? 1) || 1;
                  const unitPrice = a.unit_price != null ? String(a.unit_price) : "0";
                  const subtotal = a.subtotal != null ? String(a.subtotal) : "0";
                  let realAddOnId: number | null = null;
                  if (pricingId) {
                    const paRows = await tx.execute(sql`
                      SELECT name FROM pricing_addons WHERE id = ${pricingId} LIMIT 1
                    `);
                    const paName = String((paRows.rows[0] as any)?.name ?? "").trim();
                    if (paName) {
                      const ex = await tx.execute(sql`
                        SELECT id FROM add_ons WHERE company_id = ${companyId} AND LOWER(name) = LOWER(${paName}) LIMIT 1
                      `);
                      if (ex.rows.length) {
                        realAddOnId = Number((ex.rows[0] as any).id);
                      } else {
                        const cre = await tx.execute(sql`
                          INSERT INTO add_ons (company_id, name, price, category, is_active)
                          VALUES (${companyId}, ${paName}, ${unitPrice}, 'other', true)
                          RETURNING id
                        `);
                        realAddOnId = Number((cre.rows[0] as any).id);
                      }
                    }
                  }
                  if (!realAddOnId && a.add_on_id) realAddOnId = Number(a.add_on_id);
                  if (!realAddOnId) continue;
                  await tx.execute(sql`
                    INSERT INTO job_add_ons (job_id, add_on_id, quantity, unit_price, subtotal, pricing_addon_id)
                    VALUES (${jId}, ${realAddOnId}, ${qty}, ${unitPrice}, ${subtotal}, ${pricingId})
                    ON CONFLICT (job_id, add_on_id) DO UPDATE
                      SET quantity = EXCLUDED.quantity,
                          unit_price = EXCLUDED.unit_price,
                          subtotal = EXCLUDED.subtotal,
                          pricing_addon_id = EXCLUDED.pricing_addon_id
                  `);
                }
              }
              // Stamp parking on weekday-matching cascaded dates.
              if (cascadeParkingResolved && parking_fee_enabled === true) {
                // Look up the cascaded job's date to apply parkingApplies.
                const dateRow = await tx.execute(sql`
                  SELECT scheduled_date::text AS d FROM jobs WHERE id = ${jId} LIMIT 1
                `);
                const dateStr = String((dateRow.rows[0] as any)?.d ?? "");
                if (dateStr) {
                  const date = new Date(`${dateStr}T00:00:00`);
                  const synthSched = {
                    parking_fee_enabled: true,
                    parking_fee_days: Array.isArray(parking_fee_days) && parking_fee_days.length > 0 ? parking_fee_days : null,
                  } as any;
                  if (parkingApplies(synthSched, date)) {
                    await stampParkingFeeOnJob(jId, cascadeParkingResolved, tx);
                  }
                }
              }
            }
          }

          // DELETE non-matching jobs (only when day pattern changed).
          // [PR / 2026-05-01 — comprehensive array-bind audit fix]
          // Same bug class. Drizzle .delete().where(inArray()) binds
          // the array as a single int[] parameter.
          if (toDelete.length > 0) {
            const delRes = await tx
              .delete(jobsTable)
              .where(inArray(jobsTable.id, toDelete));
            futureDeleted = (delRes as any).rowCount ?? toDelete.length;
          }

        }

        // ── INSERT missing-day occurrences ─────────────────────────────────
        // [PR / 2026-05-04 — take 2 of PR #48] Fill any day the schedule
        // says should have an occurrence but where one doesn't yet exist
        // linked to this schedule. Runs unconditionally for this_and_future
        // and all on active schedules — not gated on dayPatternChanged
        // (the previous gate left missing days unfilled when the operator
        // toggled M-F off→on without a real pattern change).
        //
        // PR #48 stopped the cascade from re-linking unrelated standalones
        // (good — Juan's 6am job on a Tuesday stays as-is) but didn't add
        // the create-missing pass. Result on Sal's repro: schedule #88
        // (Jaira / weekdays / Alma 8am) Apr 28 had only Juan's standalone
        // (schedule_id=NULL); cascade UPDATE'd 63 future jobs but left
        // Apr 28 with zero schedule-linked rows. This block fixes that.
        //
        // Window:
        //   this_and_future: from before.scheduled_date (the anchor date)
        //                    → today + 90d
        //   all:             from min(earliest existing schedule job,
        //                    schedule.start_date) → today + 90d
        //
        // Status for newly-created rows:
        //   past dates → 'complete' (historical record reflects the
        //                  schedule fired in the real world)
        //   today/future → 'scheduled'
        //
        // Per-occurrence stamps: assigned_user_id + job_technicians from
        // team_user_ids (when teamProvided) else recurring_schedule_technicians;
        // job_add_ons from add_ons (when addOnsProvided) else
        // recurring_schedule_add_ons; parking via stampParkingFeeOnJob
        // when schedule.parking_fee_enabled and DOW matches.
        if ((cascade_scope === "this_and_future" || cascadeAllScope) && before.recurring_schedule_id != null) {
          const scheduleId2 = Number(before.recurring_schedule_id);
          const fillSchedRow = await tx.execute(sql`
            SELECT id, company_id, customer_id, frequency, day_of_week,
                   days_of_week, custom_frequency_weeks, start_date, end_date,
                   assigned_employee_id, service_type, duration_minutes, base_fee,
                   scheduled_time, commercial_hourly_rate, notes, instructions, is_active,
                   parking_fee_enabled, parking_fee_amount, parking_fee_days
            FROM recurring_schedules WHERE id = ${scheduleId2} LIMIT 1
          `);
          const fillSched = fillSchedRow.rows[0] as any;
          if (fillSched && fillSched.is_active) {
            const today2 = new Date();
            today2.setHours(0, 0, 0, 0);
            const horizon2 = new Date(today2);
            horizon2.setDate(horizon2.getDate() + 90);
            const todayStr = `${today2.getFullYear()}-${String(today2.getMonth() + 1).padStart(2, "0")}-${String(today2.getDate()).padStart(2, "0")}`;

            // Coerce a possibly-Date scheduled_date back to "YYYY-MM-DD" so
            // string concatenation with "T00:00:00" produces a valid ISO
            // datetime regardless of driver behavior.
            const toIsoDate = (v: unknown): string => {
              if (v instanceof Date) {
                const y = v.getFullYear();
                const m = String(v.getMonth() + 1).padStart(2, "0");
                const d = String(v.getDate()).padStart(2, "0");
                return `${y}-${m}-${d}`;
              }
              return String(v);
            };
            let fromDate: Date;
            if (cascadeAllScope) {
              const earliestRow = await tx.execute(sql`
                SELECT MIN(scheduled_date)::text AS earliest
                FROM jobs
                WHERE company_id = ${companyId}
                  AND recurring_schedule_id = ${scheduleId2}
              `);
              const earliest = (earliestRow.rows[0] as any)?.earliest as string | null;
              const startStr = toIsoDate(fillSched.start_date);
              const startDate = earliest ? earliest : startStr;
              fromDate = new Date(`${startDate}T00:00:00`);
            } else {
              fromDate = new Date(`${toIsoDate(before.scheduled_date)}T00:00:00`);
            }

            // Tech list for new occurrences. teamProvided update to
            // recurring_schedule_technicians runs AFTER this block (line ~2147),
            // so when teamProvided=true we use the in-scope team_user_ids.
            // Otherwise read the schedule's current crew.
            let fillTechList: number[];
            if (teamProvided && Array.isArray(team_user_ids) && team_user_ids.length > 0) {
              fillTechList = team_user_ids.map((u: unknown) => Number(u));
            } else {
              const techRows = await tx.execute(sql`
                SELECT user_id, is_primary
                FROM recurring_schedule_technicians
                WHERE recurring_schedule_id = ${scheduleId2}
                ORDER BY is_primary DESC NULLS LAST, user_id ASC
              `);
              fillTechList = (techRows.rows as any[]).map(r => Number(r.user_id));
              if (fillTechList.length === 0 && fillSched.assigned_employee_id != null) {
                fillTechList = [Number(fillSched.assigned_employee_id)];
              }
            }

            // Add-on list for new occurrences. Same pattern: addOnsProvided
            // update to recurring_schedule_add_ons runs AFTER this block, so
            // when addOnsProvided=true we use the in-scope add_ons payload.
            type FillAddon = { pricing_addon_id: number; add_on_id: number; qty: number; unit_price: string; subtotal: string };
            const fillAddons: FillAddon[] = [];
            const resolveRealAddOnId2 = async (pricingId: number, fallbackPrice: string): Promise<{ id: number; name: string; price: string } | null> => {
              const paRows = await tx.execute(sql`
                SELECT name, COALESCE(price_value, price, '0')::text AS price
                FROM pricing_addons WHERE id = ${pricingId} LIMIT 1
              `);
              const paName = String((paRows.rows[0] as any)?.name ?? "").trim();
              const paPrice = String((paRows.rows[0] as any)?.price ?? fallbackPrice ?? "0");
              if (!paName) return null;
              const ex = await tx.execute(sql`
                SELECT id FROM add_ons
                WHERE company_id = ${companyId} AND LOWER(name) = LOWER(${paName})
                LIMIT 1
              `);
              let realAddOnId: number;
              if (ex.rows.length) {
                realAddOnId = Number((ex.rows[0] as any).id);
              } else {
                const cre = await tx.execute(sql`
                  INSERT INTO add_ons (company_id, name, price, category, is_active)
                  VALUES (${companyId}, ${paName}, ${paPrice}, 'other', true)
                  RETURNING id
                `);
                realAddOnId = Number((cre.rows[0] as any).id);
              }
              return { id: realAddOnId, name: paName, price: paPrice };
            };
            if (addOnsProvided && Array.isArray(add_ons)) {
              for (const a of add_ons as Array<{ pricing_addon_id?: number; qty?: number; unit_price?: number; subtotal?: number }>) {
                const pricingId = Number(a.pricing_addon_id ?? 0);
                if (!pricingId) continue;
                const resolved = await resolveRealAddOnId2(pricingId, "0");
                if (!resolved) continue;
                const qty = Number(a.qty ?? 1) || 1;
                const unitPrice = a.unit_price != null ? String(a.unit_price) : resolved.price;
                const subtotal = a.subtotal != null
                  ? String(a.subtotal)
                  : String((Number(unitPrice) * qty).toFixed(2));
                fillAddons.push({ pricing_addon_id: pricingId, add_on_id: resolved.id, qty, unit_price: unitPrice, subtotal });
              }
            } else {
              const addonRows = await tx.execute(sql`
                SELECT pricing_addon_id, qty
                FROM recurring_schedule_add_ons
                WHERE recurring_schedule_id = ${scheduleId2}
              `);
              for (const r of addonRows.rows as any[]) {
                const pricingId = Number(r.pricing_addon_id);
                if (!pricingId) continue;
                const resolved = await resolveRealAddOnId2(pricingId, "0");
                if (!resolved) continue;
                const qty = Number(r.qty ?? 1) || 1;
                fillAddons.push({
                  pricing_addon_id: pricingId,
                  add_on_id: resolved.id,
                  qty,
                  unit_price: resolved.price,
                  subtotal: String((Number(resolved.price) * qty).toFixed(2)),
                });
              }
            }

            const { resolveParkingAddon, parkingApplies, stampParkingFeeOnJob, computeOccurrencesForSchedule: compute } =
              await import("../lib/recurring-jobs.js");
            const fillParking = fillSched.parking_fee_enabled === true
              ? await resolveParkingAddon(fillSched, tx)
              : null;

            const fillClientRow = await tx.execute(sql`
              SELECT zip FROM clients WHERE id = ${Number(fillSched.customer_id)} LIMIT 1
            `);
            const fillClientZip = ((fillClientRow.rows[0] as any)?.zip ?? null) as string | null;

            const planned = await compute(fillSched, fromDate, horizon2, null, fillClientZip);
            for (const r of planned.rows) {
              const dateStr = String(r.scheduled_date);
              const isPast = dateStr < todayStr;
              const status = isPast ? "complete" : "scheduled";
              const primaryUid = fillTechList.length > 0
                ? fillTechList[0]
                : (fillSched.assigned_employee_id != null ? Number(fillSched.assigned_employee_id) : null);
              const insertRes = await tx.execute(sql`
                INSERT INTO jobs
                  (company_id, client_id, assigned_user_id, service_type, status,
                   scheduled_date, scheduled_time, frequency, base_fee, hourly_rate,
                   allowed_hours, notes, recurring_schedule_id, booking_location, address_zip)
                VALUES
                  (${r.company_id}, ${r.client_id}, ${primaryUid},
                   ${r.service_type}, ${status}, ${r.scheduled_date},
                   ${fillSched.scheduled_time ?? null},
                   ${r.frequency}, ${r.base_fee},
                   ${fillSched.commercial_hourly_rate != null ? String(fillSched.commercial_hourly_rate) : null},
                   ${r.allowed_hours}, ${r.notes}, ${r.recurring_schedule_id},
                   ${r.booking_location}, ${r.address_zip})
                RETURNING id
              `);
              const newJobId = Number((insertRes.rows[0] as any).id);
              futureInserted++;

              for (let i = 0; i < fillTechList.length; i++) {
                const uid = fillTechList[i];
                const isPrimary = i === 0;
                await tx.execute(sql`
                  INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
                  VALUES (${newJobId}, ${uid}, ${companyId}, ${isPrimary})
                  ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
                `);
              }

              for (const a of fillAddons) {
                await tx.execute(sql`
                  INSERT INTO job_add_ons (job_id, add_on_id, quantity, unit_price, subtotal, pricing_addon_id)
                  VALUES (${newJobId}, ${a.add_on_id}, ${a.qty}, ${a.unit_price}, ${a.subtotal}, ${a.pricing_addon_id})
                  ON CONFLICT (job_id, add_on_id) DO UPDATE
                    SET quantity = EXCLUDED.quantity,
                        unit_price = EXCLUDED.unit_price,
                        subtotal = EXCLUDED.subtotal,
                        pricing_addon_id = EXCLUDED.pricing_addon_id
                `);
              }

              if (fillParking) {
                const occDate = new Date(`${dateStr}T00:00:00`);
                if (parkingApplies(fillSched, occDate)) {
                  await stampParkingFeeOnJob(newJobId, fillParking, tx);
                }
              }
            }
          }
        }

        // Replace recurring_schedule_add_ons + recurring_schedule_technicians.
        if (addOnsProvided && Array.isArray(add_ons)) {
          await tx.execute(sql`DELETE FROM recurring_schedule_add_ons WHERE recurring_schedule_id = ${scheduleId}`);
          for (const a of add_ons as Array<{ pricing_addon_id?: number; qty?: number }>) {
            const pricingId = Number(a.pricing_addon_id ?? 0);
            const qty = Number(a.qty ?? 1) || 1;
            if (!pricingId) continue;
            await tx.execute(sql`
              INSERT INTO recurring_schedule_add_ons (recurring_schedule_id, pricing_addon_id, qty)
              VALUES (${scheduleId}, ${pricingId}, ${qty})
            `);
          }
        }
        if (teamProvided && Array.isArray(team_user_ids)) {
          await tx.execute(sql`DELETE FROM recurring_schedule_technicians WHERE recurring_schedule_id = ${scheduleId}`);
          for (let i = 0; i < team_user_ids.length; i++) {
            const uid = team_user_ids[i];
            const isPrimary = i === 0;
            await tx.execute(sql`
              INSERT INTO recurring_schedule_technicians (recurring_schedule_id, user_id, is_primary)
              VALUES (${scheduleId}, ${uid}, ${isPrimary})
              ON CONFLICT (recurring_schedule_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
            `);
          }
          // Mirror primary onto recurring_schedules.assigned_employee_id so the
          // existing recurring engine (which still reads the single column) sees
          // the new owner.
          await tx.execute(sql`
            UPDATE recurring_schedules SET assigned_employee_id = ${team_user_ids[0]}
            WHERE id = ${scheduleId} AND company_id = ${companyId}
          `);
        }

        // Single summary audit row for the cascade. new_value carries the full
        // payload; field_name='cascade_summary'.
        const summary = {
          changed_fields: changes.map(c => c.field),
          values: Object.fromEntries(changes.map(c => [c.field, c.next])),
          future_jobs_updated: futureCount,
          future_jobs_inserted: futureInserted,
          future_jobs_deleted: futureDeleted,
          future_jobs_skipped_in_progress: futureClockedSkipped,
        };
        await tx.execute(sql`
          INSERT INTO job_audit_log
            (job_id, company_id, user_id, user_name, user_email,
             field_name, old_value, new_value, cascade_scope, schedule_id)
          VALUES
            (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
             'cascade_summary',
             ${null}::jsonb,
             ${JSON.stringify(summary)}::jsonb,
             'this_and_future', ${scheduleId})
        `);
      }

      // Per-field audit rows (always written, regardless of cascade).
      for (const c of changes) {
        await tx.execute(sql`
          INSERT INTO job_audit_log
            (job_id, company_id, user_id, user_name, user_email,
             field_name, old_value, new_value, cascade_scope, schedule_id)
          VALUES
            (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
             ${c.field},
             ${JSON.stringify(c.old)}::jsonb,
             ${JSON.stringify(c.next)}::jsonb,
             ${cascade_scope},
             ${cascade_scope === "this_and_future" ? Number(before.recurring_schedule_id) : null})
        `);
      }

      // Stash counters for the response (read after commit via closure).
      (req as any)._agFutureCount = futureCount;
      (req as any)._agFutureSkipped = futureClockedSkipped;
      (req as any)._agFutureInserted = futureInserted;
      (req as any)._agFutureDeleted = futureDeleted;

      // [PR / 2026-04-30] Dry-run rollback. Throwing here forces
      // Drizzle's tx wrapper to roll back every write that landed
      // inside this callback (including the audit-log inserts above
      // — intentional; we don't want a "real" audit row for a
      // hypothetical edit). The outer try/catch matches on the
      // sentinel class and returns counters to the caller.
      if (dry_run) {
        throw new DryRunRollback({
          scope: cascade_scope,
          current_job_would_update: true,
          schedule_would_be_created: createdScheduleId != null,
          future_jobs_would_be_updated: futureCount,
          future_jobs_would_be_deleted: futureDeleted,
          future_jobs_would_be_inserted_in_tx: futureInserted,
          future_jobs_would_be_skipped_in_progress: futureClockedSkipped,
        });
      }
    }).catch((err: unknown) => {
      // [PR / 2026-04-30] Catch the dry-run sentinel here (the only
      // expected throw). Re-throw anything else — the outer route
      // catch handles real failures via its 500 response.
      if (err instanceof DryRunRollback) {
        dryRunSummary = err.summary;
        return;
      }
      throw err;
    });

    // [commercial-revenue 2026-06-04] Per Sal's decision, ANY edit that can
    // move the price — hourly rate, allowed hours, base fee, add-ons,
    // service type, or the manual-override flag — immediately refreshes the
    // billed_amount cache so payroll + the weekly chart never read a stale
    // number (the $320-vs-$420 staleness). Dispatch already computes live, so
    // this is belt-and-suspenders for the cached consumers. Best-effort: a
    // recompute hiccup must not fail an otherwise-successful edit.
    if (!dry_run && (
      base_fee !== undefined || hourly_rate !== undefined ||
      allowed_hours !== undefined || addOnsProvided ||
      service_type !== undefined || manual_rate_override !== undefined
    )) {
      // Scope to COMMERCIAL jobs only. Residential billed_amount semantics
      // (how add-ons fold into the cache) are unchanged here — recomputing
      // them on a modal edit would drop residential add-ons from the cache.
      let isCommercialJob = (before as any).account_id != null;
      if (!isCommercialJob && (before as any).client_id != null) {
        try {
          const ctRows = await db.execute(sql`
            SELECT client_type FROM clients
            WHERE id = ${(before as any).client_id} AND company_id = ${companyId} LIMIT 1
          `);
          isCommercialJob = (ctRows.rows[0] as any)?.client_type === "commercial";
        } catch { /* fall through — treat as non-commercial */ }
      }
      if (isCommercialJob) {
        try {
          await recomputeJobBilledAmount(jobId, companyId);
        } catch (e) {
          console.warn(`[commercial-revenue] billed_amount recompute failed for job ${jobId}:`, e);
        }
      }
    }

    // [PR #27] The post-commit fan-out from PR #25/#26 is removed —
    // the cascade now runs INSIDE the transaction (see the
    // wantsCreateRecurring block above). Atomicity: any failure
    // during the per-date overwrite loop rolls the entire create
    // back, so we never leave a half-written schedule + linked
    // Monday with un-cascaded Tue–Fri rows.
    //
    // Dry-run interaction (PR #32 + PR #27): under dry_run=true the
    // tx callback throws DryRunRollback at its end, so the in-tx
    // cascade's writes are reverted along with the schedule INSERT
    // + Monday link. The closure-stashed counters (req._cascade*)
    // were set BEFORE the throw, so they still reflect what would
    // have been written. The dry-run response branch below picks
    // them up via dryRunSummary; the create_recurring counters
    // shape here is for the COMMIT path only.
    const createRecurringFanout = createdScheduleId != null
      ? {
          jobs_overwritten: (req as any)._cascadeOverwritten ?? 0,
          jobs_inserted: (req as any)._cascadeInserted ?? 0,
          jobs_skipped_locked: (req as any)._cascadeSkippedLocked ?? 0,
        }
      : null;

    // [PR / 2026-04-30] Dry-run branch. The transaction rolled back
    // before any writes committed, so we don't query the post-state
    // (that's what the operator would normally see) — we return the
    // captured summary instead. Production state is unchanged; the
    // operator can re-run without dry_run when ready.
    if (dry_run && dryRunSummary) {
      const summary: Record<string, unknown> = dryRunSummary;
      return res.json({
        ok: true,
        dry_run: true,
        cascade: {
          ...summary,
          // Counters-only for v1 (Sal Q3.1 = a). Sample-row capture
          // is a follow-up if v1 proves insufficient.
          fan_out_simulated: false,
          note: "Transaction rolled back. No production changes. Post-commit fan-out (forward 60-day inserts via generateJobsFromSchedule) NOT simulated in v1 — re-run without dry_run to see actual fan-out.",
        },
      });
    }

    // ── Build response ────────────────────────────────────────────────────
    const updatedRows = await db.execute(sql`
      SELECT id, status, service_type, frequency, scheduled_date, scheduled_time,
             allowed_hours, base_fee, manual_rate_override, notes, assigned_user_id,
             recurring_schedule_id
      FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    const updated = updatedRows.rows[0];

    // Keep the job's draft invoice (if any) in step with the new price/discounts.
    await syncJobInvoiceDraft(jobId, companyId);

    return res.json({
      ok: true,
      changed: true,
      job: updated,
      diff: changes.map(c => ({ field: c.field, old: c.old, new: c.next })),
      cascade: {
        scope: cascade_scope,
        future_jobs_updated: (req as any)._agFutureCount ?? 0,
        future_jobs_inserted: (req as any)._agFutureInserted ?? 0,
        future_jobs_deleted: (req as any)._agFutureDeleted ?? 0,
        future_jobs_skipped_in_progress: (req as any)._agFutureSkipped ?? 0,
        // [PR / 2026-05-01 — re-implementation of yesterday's PR #34]
        // Anchor-protection signals so the modal can render an honest
        // success summary ("Schedule updated. 4 future jobs reflect
        // new times. This visit is unchanged (frequency, base_fee
        // stayed frozen).") instead of a generic "saved".
        anchor_protected: ((req as any)._anchorSkippedFields ?? []).length > 0,
        anchor_skipped_fields: (req as any)._anchorSkippedFields ?? [],
        schedule_updated: !!(req as any)._scheduleUpdated,
        // [PR #27] create_recurring metadata. Null when this PATCH
        // didn't create a schedule. When present, includes the new
        // schedule_id + the in-tx cascade result: jobs_overwritten
        // (existing future rows updated in place, ids preserved) +
        // jobs_inserted (empty-day inserts) + jobs_skipped_locked
        // (rows untouched because complete/cancelled/paid/invoiced).
        created_schedule_id: createdScheduleId,
        create_recurring: createRecurringFanout,
      },
    });
  } catch (err: any) {
    console.error("PATCH /jobs/:id error:", err);
    // [AI.6.3] Surface the actual exception message in the response so
    // the modal toast shows what went wrong (FK violations, NOT NULL
    // failures, etc.) instead of a generic "Failed to edit job" that
    // hides the cause and forces a Railway-logs trip.
    const detail = err?.message ?? String(err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: detail || "Failed to edit job",
    });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const role = req.auth!.role;

    // [recurring-delete-skip 2026-06-05] Capture the recurring linkage BEFORE
    // deleting so we can tombstone the occurrence's cadence slot on the
    // schedule. Without this, the generator regenerates the deleted occurrence
    // next run and it "keeps coming back". Skip the cadence slot
    // (occurrence_date, falling back to scheduled_date) — the same key the
    // engine dedups on.
    const recurInfo = ((await db.execute(sql`
      SELECT recurring_schedule_id, occurrence_date::text AS occ, scheduled_date::text AS sched
      FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `)).rows[0]) as any;
    async function tombstoneOccurrence() {
      const sid = recurInfo?.recurring_schedule_id;
      const skipDate = recurInfo?.occ ?? recurInfo?.sched;
      if (sid != null && skipDate) {
        await db.execute(sql`
          UPDATE recurring_schedules
          SET skipped_dates = ARRAY(
            SELECT DISTINCT unnest(COALESCE(skipped_dates, '{}'::date[]) || ARRAY[${skipDate}::date])
          )
          WHERE id = ${sid} AND company_id = ${companyId}
        `);
      }
    }

    // [delete-any-job 2026-06-05] Unified delete. Previously the plain path
    // FK-failed on any job that had add-ons / photos / clock rows, and only
    // owner/admin could "force" the cleanup — so the office literally could not
    // delete those jobs (Sal: "we have to make sure we can delete any job").
    // Now ONE path cleans up the child rows that FK to jobs and NULLs the
    // financial back-refs, then deletes — for owner/admin/office. The only hard
    // block is in_progress: a tech is clocked in on-site and deleting under them
    // creates UI ghosts — clock them out first. The ?force flag is now a no-op
    // (cleanup always runs); kept accepted for backward compatibility.
    if (role !== "owner" && role !== "admin" && role !== "office") {
      return res.status(403).json({ error: "Forbidden", message: "You don't have permission to delete jobs" });
    }
    const [existing] = await db
      .select({ id: jobsTable.id, status: jobsTable.status })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .limit(1);
    if (!existing) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }
    if (existing.status === "in_progress") {
      return res.status(409).json({
        error: "Conflict",
        message: "This job has a tech clocked in. Clock them out before deleting it.",
      });
    }
    await db.transaction(async (tx) => {
      // Per-job ephemeral / replaceable data → DELETE child rows (job_id NOT NULL).
      await tx.execute(sql`DELETE FROM timeclock WHERE job_id = ${jobId} AND company_id = ${companyId}`);
      await tx.execute(sql`DELETE FROM job_add_ons WHERE job_id = ${jobId}`);
      await tx.execute(sql`DELETE FROM clock_in_attempts WHERE job_id = ${jobId}`);
      await tx.execute(sql`DELETE FROM job_status_logs WHERE job_id = ${jobId}`);
      await tx.execute(sql`DELETE FROM job_photos WHERE job_id = ${jobId}`);
      await tx.execute(sql`DELETE FROM job_supplies WHERE job_id = ${jobId}`);
      await tx.execute(sql`DELETE FROM scorecards WHERE job_id = ${jobId}`);
      await tx.execute(sql`DELETE FROM client_ratings WHERE job_id = ${jobId}`);
      await tx.execute(sql`DELETE FROM satisfaction_surveys WHERE job_id = ${jobId}`);
      await tx.execute(sql`DELETE FROM cancellation_log WHERE job_id = ${jobId}`);
      // Financial / legal / cross-entity records → NULL the back-reference; the
      // parent row stays intact for billing/accounting/reporting.
      await tx.execute(sql`UPDATE quotes SET booked_job_id = NULL WHERE booked_job_id = ${jobId}`);
      await tx.execute(sql`UPDATE invoices SET job_id = NULL WHERE job_id = ${jobId}`);
      await tx.execute(sql`UPDATE additional_pay SET job_id = NULL WHERE job_id = ${jobId}`);
      await tx.execute(sql`UPDATE loyalty_points_log SET job_id = NULL WHERE job_id = ${jobId}`);
      await tx.execute(sql`UPDATE communication_log SET job_id = NULL WHERE job_id = ${jobId}`);
      await tx.execute(sql`UPDATE contact_tickets SET job_id = NULL WHERE job_id = ${jobId}`);
      await tx.execute(sql`UPDATE form_submissions SET job_id = NULL WHERE job_id = ${jobId}`);
      await tx.execute(sql`UPDATE quality_complaints SET job_id = NULL WHERE job_id = ${jobId}`);
      await tx.execute(sql`UPDATE mileage_requests SET from_job_id = NULL WHERE from_job_id = ${jobId}`);
      await tx.execute(sql`UPDATE mileage_requests SET to_job_id = NULL WHERE to_job_id = ${jobId}`);
      await tx.execute(sql`UPDATE cancellation_log SET rescheduled_to_job_id = NULL WHERE rescheduled_to_job_id = ${jobId}`);
      await tx.delete(jobsTable).where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)));
    });
    await tombstoneOccurrence();
    logAudit(req, "DELETE", "job", jobId, null, { status: existing.status });
    return res.json({ success: true, message: "Job deleted" });
  } catch (err) {
    console.error("Delete job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to delete job" });
  }
});

// DELETE /api/jobs/:id/clock-entries — wipe all clock entries on a job
// (admin/owner only). Useful before deleting a completed job.
router.delete("/:id/clock-entries", requireAuth, async (req, res) => {
  try {
    const role = req.auth!.role;
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({
        error: "Forbidden",
        message: "Only owner or admin can delete clock entries",
      });
    }
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;

    const [existing] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .limit(1);
    if (!existing) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }

    const result = await db.execute(sql`
      DELETE FROM timeclock WHERE job_id = ${jobId} AND company_id = ${companyId}
    `);
    const deleted = (result as any).rowCount ?? 0;
    logAudit(req, "DELETE", "clock_entries", jobId, null, { count: deleted });
    return res.json({ success: true, deleted });
  } catch (err) {
    console.error("Delete clock entries error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to delete clock entries" });
  }
});

router.post("/:id/complete", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);

    const afterPhotos = await db
      .select({ count: count() })
      .from(jobPhotosTable)
      .where(and(
        eq(jobPhotosTable.job_id, jobId),
        eq(jobPhotosTable.photo_type, "after")
      ));

    // [AF] The "≥1 after photo" hard-block only fires when PHOTOS_ENABLED=true.
    // With photos feature-flagged off we still report counts (for existing
    // photos) but don't require one to complete. Re-enabling PHOTOS_ENABLED
    // restores the gate automatically.
    if (process.env.PHOTOS_ENABLED === "true" && afterPhotos[0].count < 1) {
      return res.status(400).json({
        error: "Bad Request",
        message: "At least 1 after photo required to complete job"
      });
    }

    // [AF] Atomic completion UPDATE — also stamps actual_end_time, locked_at,
    // and completed_by_user_id. locked_at is the signal to the drawer UI that
    // this job is read-only (no more status changes, no more commission edits).
    // Guard against double-complete: WHERE status != 'complete' so a second
    // Mark Complete click is a no-op (rowcount=0 → 409 below).
    const nowTs = new Date();
    const updated = await db
      .update(jobsTable)
      .set({
        status: "complete",
        actual_end_time: nowTs,
        locked_at: nowTs,
        completed_by_user_id: req.auth!.userId,
      })
      .where(and(
        eq(jobsTable.id, jobId),
        eq(jobsTable.company_id, req.auth!.companyId),
        sql`${jobsTable.status} NOT IN ('complete', 'cancelled')`,
      ))
      .returning();

    if (!updated[0]) {
      // Either the job doesn't exist, belongs to another tenant, OR is already
      // complete/cancelled. Probe to disambiguate for a clearer client message.
      const [existing] = await db
        .select({ status: jobsTable.status, locked_at: jobsTable.locked_at })
        .from(jobsTable)
        .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, req.auth!.companyId)))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ error: "Not Found", message: "Job not found" });
      }
      return res.status(409).json({
        error: "Conflict",
        message: `Job is already ${existing.status}.`,
        status: existing.status,
        locked_at: existing.locked_at,
      });
    }

    const completedJob = updated[0] as any;

    // ── Synthetic timeclock fallback ────────────────────────────────────
    // [BUG-3F4 / 2026-06-02] If a job is completed without any timeclock
    // activity (typical for MaidCentral imports and one-tap "Mark complete"
    // workflows where the operator never ran the field-app timer), stamp
    // an estimated clock pair for each assigned tech so the payroll
    // report has hours to sum.
    //
    // [PRODUCT INTENT 2026-06-04] FOR NOW — until Phes manages all clocks
    // inside Qleno — the daily clocks are meant to MATCH the assigned job
    // times. That's exactly what this estimate does (clock_in = scheduled
    // start, clock_out = scheduled start + allowed_hours, in Central time),
    // so it is deliberate, not a stopgap to rip out. Do NOT remove this
    // fallback or decouple it from the scheduled time until real field-app
    // punches are the source of truth for the whole fleet.
    //
    // Real punches always win — this only fires
    // when ZERO timeclock rows exist for this job; future real punches
    // would just create new rows that the payroll engine prefers via
    // ORDER BY source='punched' DESC if/when we add the tiebreaker.
    // Window: clock_in_at = scheduled_date + scheduled_time, clock_out_at
    // = clock_in_at + duration_minutes (falls back to allowed_hours*60,
    // then 120 mins as final safety). source='estimated' marks the
    // provenance so reports can badge or exclude as needed.
    try {
      const existingClocks = await db
        .select({ id: timeclockTable.id })
        .from(timeclockTable)
        .where(eq(timeclockTable.job_id, jobId))
        .limit(1);
      if (existingClocks.length === 0) {
        const techRows = await db.execute(sql`
          SELECT user_id
            FROM job_technicians
           WHERE job_id = ${jobId} AND company_id = ${req.auth!.companyId}
        `);
        const techIds: number[] = (techRows.rows as any[]).map(r => Number(r.user_id));
        if (techIds.length === 0 && completedJob.assigned_user_id != null) {
          techIds.push(Number(completedJob.assigned_user_id));
        }
        if (techIds.length > 0) {
          const schedDate = String(completedJob.scheduled_date);
          const schedTime = completedJob.scheduled_time
            ? String(completedJob.scheduled_time)
            : "09:00:00";
          // [BUG-3F4 / 2026-06-02] jobs has no duration_minutes column —
          // allowed_hours is the canonical job-length signal. Fall back
          // to 120 min only as last-ditch (it'd take a malformed import
          // to hit this branch in practice).
          const durationMinutes =
            (completedJob.allowed_hours != null && parseFloat(String(completedJob.allowed_hours)) > 0)
              ? Math.round(parseFloat(String(completedJob.allowed_hours)) * 60)
              : 120;
          // [BUG 2026-06-04] scheduled_time is a Central (America/Chicago) wall
          // time. Building the stamp as a naive `date + time` and letting it
          // land in a `timestamp` column treats that wall time as UTC, so the
          // round-trip renders it shifted by the Chicago offset (a 6:00 AM job
          // showed a 1:00 AM clock-in). Anchor the wall time to Chicago, then
          // express it in UTC for storage — session-timezone independent and
          // consistent with the AT TIME ZONE pattern used elsewhere. Single-tz
          // tenant (Phes); multi-tenant later should derive the zone per branch.
          const clockIn = sql`(((${schedDate}::date + ${schedTime}::time) AT TIME ZONE 'America/Chicago') AT TIME ZONE 'UTC')`;
          for (const uid of techIds) {
            await db.execute(sql`
              INSERT INTO timeclock (
                job_id, user_id, company_id, branch_id,
                clock_in_at, clock_out_at, source, flagged
              ) VALUES (
                ${jobId}, ${uid}, ${req.auth!.companyId},
                ${completedJob.branch_id ?? null},
                ${clockIn},
                ${clockIn} + (${durationMinutes} || ' minutes')::interval,
                'estimated', false
              )
            `);
          }
        }
      }
    } catch (clockErr) {
      console.error("[complete] estimated-clock stamp failed (non-fatal):", clockErr);
    }

    // ── Hourly billing engine ─────────────────────────────────────────────
    if (completedJob.billing_method === "hourly" && completedJob.hourly_rate) {
      try {
        // Sum all completed timeclock entries for this job
        const tcRows = await db
          .select({ clock_in_at: timeclockTable.clock_in_at, clock_out_at: timeclockTable.clock_out_at })
          .from(timeclockTable)
          .where(and(eq(timeclockTable.job_id, jobId), isNotNull(timeclockTable.clock_out_at)));

        const totalMinutes = tcRows.reduce((sum, r) => {
          if (!r.clock_out_at) return sum;
          return sum + (new Date(r.clock_out_at).getTime() - new Date(r.clock_in_at).getTime()) / 60000;
        }, 0);

        // Round up to nearest 0.25h
        const rawHours = totalMinutes / 60;
        const billedHours = Math.ceil(rawHours * 4) / 4;
        const billedAmount = billedHours * parseFloat(completedJob.hourly_rate);

        await db
          .update(jobsTable)
          .set({
            billed_hours: billedHours.toFixed(2),
            billed_amount: billedAmount.toFixed(2),
          })
          .where(eq(jobsTable.id, jobId));

        completedJob.billed_hours = billedHours.toFixed(2);
        completedJob.billed_amount = billedAmount.toFixed(2);
      } catch (billingErr) {
        console.error("Billing engine error (non-fatal):", billingErr);
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    const jobDetail = await db
      .select({
        id: jobsTable.id,
        service_type: jobsTable.service_type,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        base_fee: jobsTable.base_fee,
        actual_hours: jobsTable.actual_hours,
        notes: jobsTable.notes,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        client_address: sql<string>`coalesce(${clientsTable.address}, '')`,
        assigned_user_name: sql<string | null>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        company_name: sql<string>`coalesce((select name from companies where id = ${jobsTable.company_id}), 'Qleno')`,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(eq(jobsTable.id, jobId))
      .limit(1);

    const beforeCount = await db
      .select({ count: count() })
      .from(jobPhotosTable)
      .where(and(eq(jobPhotosTable.job_id, jobId), eq(jobPhotosTable.photo_type, "before")));

    let pdfUrl: string | null = null;
    try {
      if (jobDetail[0]) {
        const d = jobDetail[0];
        pdfUrl = await generateJobCompletionPdf({
          jobId,
          companyName: d.company_name || "Qleno",
          clientName: d.client_name || "Unknown Client",
          clientAddress: d.client_address || "",
          serviceType: d.service_type || "Cleaning",
          scheduledDate: d.scheduled_date || "",
          scheduledTime: d.scheduled_time,
          assignedUserName: d.assigned_user_name,
          baseFee: d.base_fee,
          actualHours: d.actual_hours,
          notes: d.notes,
          beforePhotoCount: beforeCount[0]?.count ?? 0,
          afterPhotoCount: afterPhotos[0].count,
          completedAt: new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }),
        });

        await db
          .update(jobsTable)
          .set({ completion_pdf_url: pdfUrl })
          .where(eq(jobsTable.id, jobId));
      }
    } catch (pdfErr) {
      console.error("PDF generation error (non-fatal):", pdfErr);
    }

    // ── Auto-invoice on completion ────────────────────────────────────────
    let autoInvoice: { id: number; status: string; total: string } | null = null;
    let invoiceCreated = false;
    let invoiceError = false;

    try {
      const companyId = req.auth!.companyId;
      const job = updated[0] as any;

      const existing = await db
        .select({ id: invoicesTable.id, status: invoicesTable.status, total: invoicesTable.total })
        .from(invoicesTable)
        .where(and(eq(invoicesTable.job_id, jobId), eq(invoicesTable.company_id, companyId)))
        .limit(1);

      if (existing[0]) {
        autoInvoice = { id: existing[0].id, status: existing[0].status, total: existing[0].total };
      } else {
        // If this job belongs to an account, check invoice_frequency before auto-creating
        let skipAutoInvoice = false;
        let termsDays = 0;
        let clientId = job.client_id ?? null;

        if (job.account_id) {
          const [acct] = await db
            .select({ invoice_frequency: accountsTable.invoice_frequency, payment_terms_days: accountsTable.payment_terms_days })
            .from(accountsTable)
            .where(eq(accountsTable.id, job.account_id))
            .limit(1);
          if (acct) {
            termsDays = acct.payment_terms_days ?? 30;
            // Only auto-invoice on per_job; weekly/monthly get batched via consolidate endpoint
            if (acct.invoice_frequency !== "per_job") {
              skipAutoInvoice = true;
            }
          }
        } else {
          const [co] = await db
            .select({ payment_terms_days: companiesTable.payment_terms_days })
            .from(companiesTable)
            .where(eq(companiesTable.id, companyId))
            .limit(1);
          termsDays = co?.payment_terms_days ?? 0;
        }

        if (!skipAutoInvoice) {
          const today = new Date();
          const due = new Date(today);
          due.setDate(due.getDate() + termsDays);
          const dueDateStr = due.toISOString().split("T")[0];

          const termsLabel =
            termsDays === 30 ? "net_30" :
            termsDays === 15 ? "net_15" :
            termsDays === 7  ? "net_7"  : "due_on_receipt";

          // Use billed_amount for hourly jobs; otherwise base_fee
          const amount = completedJob.billed_amount
            ? parseFloat(completedJob.billed_amount)
            : parseFloat(job.base_fee ?? "0");
          const svcLabel = (job.service_type ?? "Cleaning Service")
            .split("_").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          const qty = completedJob.billed_hours ? parseFloat(completedJob.billed_hours) : 1;
          const unitPrice = completedJob.hourly_rate ? parseFloat(completedJob.hourly_rate) : amount;

          const lineItems: any[] = [{ description: svcLabel, quantity: qty, unit_price: unitPrice, total: amount }];

          // Itemize any discounts applied to this job as negative lines so the
          // invoice total nets them out (matches the live draft-sync helper).
          const jobDisc = await db.select().from(jobDiscountsTable)
            .where(and(eq(jobDiscountsTable.job_id, jobId), eq(jobDiscountsTable.company_id, companyId)));
          let discTotal = 0;
          for (const d of jobDisc) {
            const amt = parseFloat(String(d.amount));
            discTotal += amt;
            const label = `Discount${d.code ? ` ${d.code}` : (d.type === "percent" ? ` ${parseFloat(String(d.value))}%` : "")}${d.reason && d.reason !== d.code ? ` — ${d.reason}` : ""}`;
            lineItems.push({ description: label, quantity: 1, unit_price: -amt, total: -amt });
          }
          const netAmount = Math.max(0, Math.round((amount - discTotal) * 100) / 100);

          const [newInv] = await db
            .insert(invoicesTable)
            .values({
              company_id: companyId,
              job_id: jobId,
              client_id: clientId,
              account_id: job.account_id ?? null,
              status: "draft",
              line_items: lineItems,
              subtotal: netAmount.toFixed(2),
              total: netAmount.toFixed(2),
              due_date: dueDateStr,
              payment_terms: termsLabel,
              created_by: req.auth!.userId,
            })
            .returning({ id: invoicesTable.id, status: invoicesTable.status, total: invoicesTable.total });

          autoInvoice = { id: newInv.id, status: newInv.status, total: newInv.total };
          invoiceCreated = true;

          // [AF] Fire-and-forget QB invoice push. Enqueue a pending row in
          // qb_sync_queue regardless of whether this tenant is QB-connected —
          // the cron drain (syncAll) checks getValidToken() and no-ops cleanly
          // for tenants without a connection, so queueing is always safe.
          // Does NOT respect COMMS_ENABLED: QB push is accounting, not
          // outbound customer comms.
          try {
            const { syncInvoice } = await import("../services/quickbooks-sync.js");
            syncInvoice(companyId, newInv.id).catch(qbErr => {
              console.error("[AF] QB invoice push error (non-fatal):", qbErr);
            });
          } catch (qbImportErr) {
            console.error("[AF] QB sync module load error (non-fatal):", qbImportErr);
          }
        }
      }
    } catch (invErr) {
      console.error("Auto-invoice error (non-fatal):", invErr);
      invoiceError = true;
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── NPS survey trigger (non-blocking) ────────────────────────────────
    const clientId = (updated[0] as any).client_id;
    if (clientId) {
      fetch(`http://localhost:${process.env.PORT || 8080}/api/satisfaction/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": req.headers.authorization || "",
        },
        body: JSON.stringify({ job_id: jobId, customer_id: clientId }),
      }).catch((npsErr: Error) => console.error("NPS send error (non-fatal):", npsErr));
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── post_job_retention enrollment (non-blocking) ──────────────────────
    if (completedJob.client_id) {
      import("../services/followUpService.js").then(({ enrollForJobComplete }) => {
        enrollForJobComplete(req.auth!.companyId, jobId, completedJob.client_id).catch(() => {});
      });
    }

    // ── job_completed notification (non-blocking) ─────────────────────────
    const companyId = req.auth!.companyId;
    if (clientId && jobDetail[0]) {
      const jd = jobDetail[0];
      db.select({ email: clientsTable.email, phone: clientsTable.phone,
                  address: clientsTable.address, city: clientsTable.city, state: clientsTable.state,
                  first_name: clientsTable.first_name })
        .from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1)
        .then(([cl]) => {
          if (!cl) return;
          const addr = [cl.address, cl.city, cl.state].filter(Boolean).join(", ");
          const mv = {
            first_name:       cl.first_name || "",
            appointment_date: jd.scheduled_date || new Date().toISOString().slice(0, 10),
            scope:            labelServiceType(jd.service_type),
            service_address:  addr,
          };
          sendNotification("job_completed", "email", companyId, cl.email, null, mv).catch(() => {});
          sendNotification("job_completed", "sms",   companyId, null, cl.phone, mv).catch(() => {});
        }).catch(() => {});
    }
    // ─────────────────────────────────────────────────────────────────────

    return res.json({
      ...updated[0],
      client_name: jobDetail[0]?.client_name ?? "",
      assigned_user_name: jobDetail[0]?.assigned_user_name ?? null,
      before_photo_count: beforeCount[0]?.count ?? 0,
      after_photo_count: afterPhotos[0].count,
      completion_pdf_url: pdfUrl,
      invoice: autoInvoice,
      invoice_created: invoiceCreated,
      invoice_error: invoiceError,
    });
  } catch (err) {
    console.error("Complete job error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to complete job" });
  }
});

router.get("/:id/photos", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);

    const photos = await db
      .select()
      .from(jobPhotosTable)
      .where(and(
        eq(jobPhotosTable.job_id, jobId),
        eq(jobPhotosTable.company_id, req.auth!.companyId)
      ))
      .orderBy(jobPhotosTable.timestamp);

    const beforeCount = photos.filter(p => p.photo_type === "before").length;
    const afterCount = photos.filter(p => p.photo_type === "after").length;

    return res.json({
      data: photos.map(p => ({
        ...p,
        lat: p.lat ? parseFloat(p.lat) : null,
        lng: p.lng ? parseFloat(p.lng) : null,
      })),
      before_count: beforeCount,
      after_count: afterCount,
    });
  } catch (err) {
    console.error("Get photos error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get photos" });
  }
});

router.post("/:id/photos", requireAuth, async (req, res) => {
  // [AF] PHOTOS_ENABLED is now an explicit kill switch — photo uploads are
  // ENABLED by default and only blocked when PHOTOS_ENABLED="false".
  if (process.env.PHOTOS_ENABLED === "false") {
    return res.status(503).json({ error: "feature_disabled", message: "Photo uploads are disabled (PHOTOS_ENABLED=false)." });
  }
  try {
    const jobId = parseInt(req.params.id);
    const { photo_type, data_url, lat, lng } = req.body;

    const photo = await db
      .insert(jobPhotosTable)
      .values({
        job_id: jobId,
        company_id: req.auth!.companyId,
        photo_type,
        url: data_url,
        lat,
        lng,
        uploaded_by: req.auth!.userId,
      })
      .returning();

    return res.status(201).json({
      ...photo[0],
      lat: photo[0].lat ? parseFloat(photo[0].lat) : null,
      lng: photo[0].lng ? parseFloat(photo[0].lng) : null,
    });
  } catch (err) {
    console.error("Upload photo error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to upload photo" });
  }
});

// ── POST /api/jobs/:id/charge ─── Manual Stripe charge (owner/admin only) ────
router.post("/:id/charge", requireAuth, async (req, res) => {
  try {
    const role = (req as any).auth?.role;
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;

    // Load job with client info
    const jobRows = await db.execute(sql`
      SELECT j.id, j.company_id, j.client_id, j.status, j.base_fee, j.billed_amount,
             j.charge_failed_at, j.charge_succeeded_at,
             c.stripe_customer_id, c.stripe_payment_method_id, c.payment_source,
             c.card_last_four, c.card_brand,
             c.first_name, c.last_name, c.email, c.phone,
             inv.id as invoice_id, inv.total as invoice_total, inv.status as invoice_status
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      LEFT JOIN invoices inv ON inv.job_id = j.id AND inv.status != 'paid'
      WHERE j.id = ${jobId} AND j.company_id = ${companyId}
      LIMIT 1
    `);

    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });
    const job = jobRows.rows[0] as any;

    if (job.status !== "complete") return res.status(400).json({ error: "Job must be completed before charging" });
    if (job.payment_source !== "stripe") return res.status(400).json({ error: "Client does not have Stripe on file" });
    if (!job.stripe_customer_id || !job.stripe_payment_method_id) {
      return res.status(400).json({ error: "No card on file for this client" });
    }
    if (job.charge_succeeded_at) return res.status(400).json({ error: "Job already charged successfully" });

    // Check for existing successful payment
    const existingPmt = await db.execute(sql`
      SELECT id FROM payments WHERE job_id = ${jobId} AND status = 'completed' LIMIT 1
    `);
    if (existingPmt.rows.length > 0) return res.status(400).json({ error: "Payment already recorded for this job" });

    const chargeAmount = Number(job.billed_amount || job.base_fee || 0);
    if (chargeAmount <= 0) return res.status(400).json({ error: "Invalid charge amount" });
    const amountCents = Math.round(chargeAmount * 100);

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(503).json({ error: "Stripe not configured" });

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });

    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        customer: job.stripe_customer_id,
        payment_method: job.stripe_payment_method_id,
        confirm: true,
        off_session: true,
        description: `Job #${jobId} — ${job.first_name} ${job.last_name}`,
        metadata: {
          job_id: String(jobId),
          client_id: String(job.client_id),
          company_id: String(companyId),
        },
      });

      if (paymentIntent.status !== "succeeded") {
        throw new Error(`Payment status: ${paymentIntent.status}`);
      }

      // Record successful payment
      await db.insert(paymentsTable).values({
        company_id: companyId,
        client_id: job.client_id,
        invoice_id: job.invoice_id || null,
        job_id: jobId,
        amount: String(chargeAmount),
        method: "stripe",
        status: "completed",
        stripe_payment_id: paymentIntent.id,
        last_4: job.card_last_four || null,
        card_brand: job.card_brand || null,
        processed_by: req.auth!.userId,
        attempted_at: new Date(),
      });

      // Mark invoice paid
      if (job.invoice_id) {
        await db.execute(sql`
          UPDATE invoices SET status = 'paid', paid_at = NOW(), stripe_payment_intent_id = ${paymentIntent.id}
          WHERE id = ${job.invoice_id}
        `);
      }

      // Mark job charged
      await db.execute(sql`
        UPDATE jobs SET charge_succeeded_at = NOW(), charge_failed_at = NULL WHERE id = ${jobId}
      `);

      // Fire payment_received notification
      try {
        await sendNotification("payment_received", job.client_id, companyId, {
          client_name: `${job.first_name} ${job.last_name}`,
          client_email: job.email,
          client_phone: job.phone,
          amount: chargeAmount.toFixed(2),
          card_brand: job.card_brand || "Card",
          card_last_four: job.card_last_four || "****",
        });
      } catch (notifErr) {
        console.error("[charge] notification error:", notifErr);
      }

      console.log(`[STRIPE] Charge succeeded — job_id=${jobId} amount=$${chargeAmount} pi=${paymentIntent.id}`);
      return res.json({
        ok: true,
        amount: chargeAmount,
        card_brand: job.card_brand,
        card_last_four: job.card_last_four,
        payment_intent_id: paymentIntent.id,
      });
    } catch (stripeErr: any) {
      const errCode = stripeErr?.code || stripeErr?.raw?.code || "unknown";
      const errMsg = stripeErr?.message || "Charge failed";

      // Record failed payment
      await db.insert(paymentsTable).values({
        company_id: companyId,
        client_id: job.client_id,
        invoice_id: job.invoice_id || null,
        job_id: jobId,
        amount: String(chargeAmount),
        method: "stripe",
        status: "failed",
        stripe_error_code: errCode,
        stripe_error_message: errMsg,
        last_4: job.card_last_four || null,
        card_brand: job.card_brand || null,
        processed_by: req.auth!.userId,
        attempted_at: new Date(),
      });

      // Mark job charge failed
      await db.execute(sql`
        UPDATE jobs SET charge_failed_at = NOW() WHERE id = ${jobId}
      `);

      console.error(`[STRIPE] Charge failed — job_id=${jobId} code=${errCode} msg=${errMsg}`);
      return res.status(402).json({
        error: `Charge failed: ${errMsg}. Contact the client to collect a backup payment method.`,
        stripe_error_code: errCode,
      });
    }
  } catch (err: any) {
    console.error("POST /jobs/:id/charge error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Commission Engine ──────────────────────────────────────────────────────────
// Helper: calculate per-tech commission for a job
async function calculateTechPay(jobId: number, companyId: number): Promise<Array<{
  user_id: number; name: string; is_primary: boolean; est_hours: number;
  calc_pay: number; final_pay: number; pay_override: number | null;
}>> {
  const jobRows = await db.execute(sql`
    SELECT id, base_fee, billed_amount, estimated_hours, assigned_user_id, commission_pool_rate, service_type
    FROM jobs WHERE id = ${jobId} AND company_id = ${companyId}
  `);
  if (!jobRows.rows.length) return [];
  const job = jobRows.rows[0] as any;

  // [tiered-residential] Resolve the per-job pool rate from companies
  // tiered columns; falls back to legacy single-column SELECT then to
  // 0.35 default when the cold-start migration hasn't run yet.
  let resPct = 0.35;
  try {
    const compRows = await db.execute(sql`
      SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct FROM companies WHERE id = ${companyId} LIMIT 1
    `);
    if (compRows.rows[0]) {
      const rates = parseResRatesRow(compRows.rows[0] as any);
      resPct = resolveResidentialPayPct(job.service_type, rates);
    }
  } catch {
    try {
      const compRows = await db.execute(sql`SELECT res_tech_pay_pct FROM companies WHERE id = ${companyId} LIMIT 1`);
      if (compRows.rows[0]) resPct = parseFloat(String((compRows.rows[0] as any).res_tech_pay_pct ?? 0.35));
    } catch { /* keep default 0.35 */ }
  }

  const techRows = await db.execute(sql`
    SELECT jt.user_id, jt.is_primary, jt.pay_override, u.first_name, u.last_name
    FROM job_technicians jt
    JOIN users u ON u.id = jt.user_id
    WHERE jt.job_id = ${jobId}
    ORDER BY jt.is_primary DESC, jt.id
  `);

  let techs: any[] = techRows.rows;

  if (techs.length === 0 && job.assigned_user_id) {
    const userRow = await db.execute(sql`
      SELECT id, first_name, last_name FROM users WHERE id = ${job.assigned_user_id} LIMIT 1
    `);
    if (userRow.rows.length) {
      const u = userRow.rows[0] as any;
      techs = [{ user_id: u.id, first_name: u.first_name, last_name: u.last_name, is_primary: true, pay_override: null }];
    }
  }

  const numTechs = techs.length || 1;
  const jobTotal = parseFloat(String(job.billed_amount || job.base_fee || 0));
  const poolRate = job.commission_pool_rate != null ? parseFloat(String(job.commission_pool_rate)) : resPct;
  const poolAmount = jobTotal * poolRate;
  const estHours = parseFloat(String(job.estimated_hours || 0));
  const estHoursPerTech = numTechs > 0 ? Math.round((estHours / numTechs) * 10) / 10 : estHours;

  return techs.map((t: any) => {
    const calcPay = Math.round((poolAmount / numTechs) * 100) / 100;
    const override = t.pay_override != null ? parseFloat(String(t.pay_override)) : null;
    return {
      user_id: t.user_id,
      name: `${t.first_name} ${t.last_name}`,
      is_primary: !!t.is_primary,
      est_hours: estHoursPerTech,
      calc_pay: calcPay,
      final_pay: override != null ? override : calcPay,
      pay_override: override,
    };
  });
}

// GET /api/jobs/:id/technicians
router.get("/:id/technicians", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const result = await calculateTechPay(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("GET /jobs/:id/technicians error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/jobs/:id/technicians — add a tech to the job
//
// [AI.1] Two invariants we maintain here that the original handler missed:
//   1. jobs.assigned_user_id MUST mirror the primary tech in job_technicians.
//      The dispatch grid keys off jobs.assigned_user_id, so writes that don't
//      mirror create a split-brain (Jaira commission/assignment in AH; CJ
//      Jimenez stays in Unassigned after Add Team Member in AI).
//   2. Adding a tech to a job that has NO primary (typical for drawer "Add
//      Team Member" on an unassigned job) auto-promotes the new tech to
//      primary and mirrors. Caller can still pass is_primary explicitly.
// Audit row written for traceability since this is the most-used path.
router.post("/:id/technicians", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const { user_id, is_primary: isPrimaryReq } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    const jobRows = await db.execute(sql`
      SELECT id, assigned_user_id FROM jobs
      WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });
    const oldAssignedUserId = (jobRows.rows[0] as any).assigned_user_id ?? null;

    // Decide primary status: explicit request wins; else auto-promote when
    // there's no existing primary (covers unassigned jobs and any legacy
    // rows where is_primary was never set).
    const existingPrimary = await db.execute(sql`
      SELECT user_id FROM job_technicians
      WHERE job_id = ${jobId} AND is_primary = true LIMIT 1
    `);
    const noPrimary = existingPrimary.rows.length === 0;
    const willBePrimary = isPrimaryReq === true || (isPrimaryReq !== false && noPrimary);

    // Capture before-state for audit log
    const techsBefore = await db.execute(sql`
      SELECT user_id, is_primary FROM job_technicians
      WHERE job_id = ${jobId} ORDER BY is_primary DESC, id
    `);

    await db.transaction(async (tx) => {
      // If we're promoting this tech to primary, demote any existing primary first.
      if (willBePrimary) {
        await tx.execute(sql`
          UPDATE job_technicians SET is_primary = false
          WHERE job_id = ${jobId} AND user_id != ${user_id}
        `);
      }
      // Upsert the (job, tech) row with the resolved primary flag.
      await tx.execute(sql`
        INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
        VALUES (${jobId}, ${user_id}, ${companyId}, ${willBePrimary})
        ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
      `);
      // Mirror primary onto jobs.assigned_user_id so the dispatch grid sees the change.
      if (willBePrimary) {
        await tx.execute(sql`
          UPDATE jobs SET assigned_user_id = ${user_id}
          WHERE id = ${jobId} AND company_id = ${companyId}
        `);
      }

      // Audit row — drawer "Add Team Member" is the most common assignment
      // flow in production, so we want traceability here even though it
      // bypasses the PATCH endpoint's per-field audit machinery.
      const userRows = await tx.execute(sql`
        SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1
      `);
      const u = (userRows.rows[0] as any) ?? {};
      const actorName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown";
      const actorEmail = String(u.email ?? "");
      const summary = {
        action: "tech_assigned",
        added_user_id: Number(user_id),
        is_primary: willBePrimary,
        mirrored_to_assigned_user_id: willBePrimary && oldAssignedUserId !== Number(user_id),
        previous_assigned_user_id: oldAssignedUserId,
      };
      await tx.execute(sql`
        INSERT INTO job_audit_log
          (job_id, company_id, user_id, user_name, user_email,
           field_name, old_value, new_value, cascade_scope, schedule_id)
        VALUES
          (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
           'tech_assigned',
           ${JSON.stringify({ techs: techsBefore.rows, assigned_user_id: oldAssignedUserId })}::jsonb,
           ${JSON.stringify(summary)}::jsonb,
           'this_job', ${null})
      `);
    });

    const result = await calculateTechPay(jobId, companyId);

    // [push 2026-06-03] Notify the assigned tech (fire-and-forget, no-op unless
    // COMMS_ENABLED and a device is registered). Don't block the response.
    if (Number(user_id) !== userId) {
      try {
        const info = await db.execute(sql`
          SELECT COALESCE(NULLIF(TRIM(COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,'')),''),
                          c.company_name, a.account_name, 'A job') AS who,
                 j.scheduled_date::text AS scheduled_date
          FROM jobs j
          LEFT JOIN clients c ON c.id = j.client_id
          LEFT JOIN accounts a ON a.id = j.account_id
          WHERE j.id = ${jobId} LIMIT 1
        `);
        const row = info.rows[0] as any;
        const when = row?.scheduled_date
          ? new Date(`${row.scheduled_date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
          : "";
        notifyUserAsync(Number(user_id), companyId, {
          title: "New job assigned",
          body: `${row?.who ?? "A job"}${when ? ` · ${when}` : ""}`,
          data: { type: "job", jobId: String(jobId) },
        });
      } catch (e: any) { console.warn("[push] assign notify skipped", e?.message); }
    }

    return res.json({ data: result, primary: willBePrimary });
  } catch (err) {
    console.error("POST /jobs/:id/technicians error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /api/jobs/:id/technicians/:techId
//
// [AI.1] Mirror invariant. If we're removing the primary tech, promote the
// next remaining tech (lowest job_technicians.id) to primary and update
// jobs.assigned_user_id. If no techs remain, jobs.assigned_user_id goes
// NULL (job back to unassigned). Audit row written for traceability.
// ── Per-job discounts (tracked; feeds the discounts report) ─────────────────
// Distinct from the pricing_discounts catalog: this records each discount
// actually applied to a job, with the $ taken off snapshotted at apply time.
router.get("/:id/discounts", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const rows = await db.select().from(jobDiscountsTable)
      .where(and(eq(jobDiscountsTable.job_id, jobId), eq(jobDiscountsTable.company_id, req.auth!.companyId!)))
      .orderBy(desc(jobDiscountsTable.created_at));
    return res.json({ data: rows.map(r => ({ ...r, value: Number(r.value), amount: Number(r.amount) })) });
  } catch (e) { console.error("list job discounts:", e); return res.status(500).json({ error: "Internal Server Error" }); }
});

router.post("/:id/discounts", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const { code, type, value, reason } = req.body ?? {};
    if (type !== "percent" && type !== "flat") return res.status(400).json({ error: "type must be 'percent' or 'flat'" });
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: "value must be a positive number" });
    const jobRows = await db.select({ base_fee: jobsTable.base_fee })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, req.auth!.companyId!)))
      .limit(1);
    if (jobRows.length === 0) return res.status(404).json({ error: "Job not found" });
    const baseFee = jobRows[0].base_fee != null ? parseFloat(String(jobRows[0].base_fee)) : 0;
    // Dollars off this job, snapshotted. Cap at the base fee so it never goes
    // negative; a percent resolves against the current base fee.
    let amount = type === "percent" ? (baseFee * v) / 100 : v;
    amount = Math.round(Math.min(Math.max(amount, 0), baseFee) * 100) / 100;
    const [row] = await db.insert(jobDiscountsTable).values({
      company_id: req.auth!.companyId!, job_id: jobId,
      code: code ? String(code).slice(0, 64) : null, type, value: String(v), amount: String(amount),
      reason: reason ? String(reason).slice(0, 200) : null, applied_by: req.auth!.userId ?? null,
    }).returning();
    try { await logAudit(req, "job_discount.add", "job", jobId, null, { code: row.code, type, value: v, amount }); } catch {}
    await syncJobInvoiceDraft(jobId, req.auth!.companyId!);
    return res.json({ data: { ...row, value: Number(row.value), amount: Number(row.amount) } });
  } catch (e) { console.error("add job discount:", e); return res.status(500).json({ error: "Internal Server Error" }); }
});

router.delete("/:id/discounts/:discountId", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const discountId = parseInt(req.params.discountId);
    await db.delete(jobDiscountsTable).where(and(
      eq(jobDiscountsTable.id, discountId),
      eq(jobDiscountsTable.job_id, jobId),
      eq(jobDiscountsTable.company_id, req.auth!.companyId!),
    ));
    try { await logAudit(req, "job_discount.remove", "job", jobId, null, { discount_id: discountId }); } catch {}
    await syncJobInvoiceDraft(jobId, req.auth!.companyId!);
    return res.json({ ok: true });
  } catch (e) { console.error("delete job discount:", e); return res.status(500).json({ error: "Internal Server Error" }); }
});

router.delete("/:id/technicians/:techId", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const techId = parseInt(req.params.techId);
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;

    const jobRows = await db.execute(sql`
      SELECT assigned_user_id FROM jobs
      WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });
    const oldAssignedUserId = (jobRows.rows[0] as any).assigned_user_id ?? null;

    const removingRow = await db.execute(sql`
      SELECT is_primary FROM job_technicians
      WHERE job_id = ${jobId} AND user_id = ${techId} AND company_id = ${companyId}
      LIMIT 1
    `);
    const wasRemovingPrimary = removingRow.rows.length > 0
      && Boolean((removingRow.rows[0] as any).is_primary);

    let newPrimary: number | null = null;

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM job_technicians
        WHERE job_id = ${jobId} AND user_id = ${techId} AND company_id = ${companyId}
      `);

      if (wasRemovingPrimary) {
        // Promote next remaining tech (oldest by row id). Could be no rows left.
        const remaining = await tx.execute(sql`
          SELECT user_id FROM job_technicians
          WHERE job_id = ${jobId}
          ORDER BY id ASC LIMIT 1
        `);
        if (remaining.rows.length > 0) {
          newPrimary = Number((remaining.rows[0] as any).user_id);
          await tx.execute(sql`
            UPDATE job_technicians SET is_primary = true
            WHERE job_id = ${jobId} AND user_id = ${newPrimary}
          `);
        }
        // Mirror onto jobs.assigned_user_id (NULL when no techs remain).
        await tx.execute(sql`
          UPDATE jobs SET assigned_user_id = ${newPrimary}
          WHERE id = ${jobId} AND company_id = ${companyId}
        `);
      }

      // Audit row.
      const userRows = await tx.execute(sql`
        SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1
      `);
      const u = (userRows.rows[0] as any) ?? {};
      const actorName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown";
      const actorEmail = String(u.email ?? "");
      const summary = {
        action: "tech_removed",
        removed_user_id: techId,
        was_primary: wasRemovingPrimary,
        new_primary_user_id: newPrimary,
        mirrored_to_assigned_user_id: wasRemovingPrimary,
        previous_assigned_user_id: oldAssignedUserId,
      };
      await tx.execute(sql`
        INSERT INTO job_audit_log
          (job_id, company_id, user_id, user_name, user_email,
           field_name, old_value, new_value, cascade_scope, schedule_id)
        VALUES
          (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
           'tech_removed',
           ${JSON.stringify({ removed_user_id: techId, was_primary: wasRemovingPrimary, assigned_user_id: oldAssignedUserId })}::jsonb,
           ${JSON.stringify(summary)}::jsonb,
           'this_job', ${null})
      `);
    });

    const result = await calculateTechPay(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("DELETE /jobs/:id/technicians/:techId error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// PUT /api/jobs/:id/technicians/:techId/override — set pay override for a tech
router.put("/:id/technicians/:techId/override", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const techId = parseInt(req.params.techId);
    const companyId = req.auth!.companyId;
    const { pay_override } = req.body;

    const jobRows = await db.execute(sql`SELECT id FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1`);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });

    const overrideVal = pay_override != null ? parseFloat(String(pay_override)) : null;

    await db.execute(sql`
      INSERT INTO job_technicians (job_id, user_id, company_id, pay_override, final_pay)
      VALUES (${jobId}, ${techId}, ${companyId}, ${overrideVal}, ${overrideVal})
      ON CONFLICT (job_id, user_id) DO UPDATE SET
        pay_override = EXCLUDED.pay_override,
        final_pay = EXCLUDED.final_pay
    `);

    const result = await calculateTechPay(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("PUT /jobs/:id/technicians/:techId/override error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/jobs/:id/commission/set-pool-rate
router.post("/:id/commission/set-pool-rate", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const { commission_pool_rate } = req.body;

    await db.execute(sql`
      UPDATE jobs SET commission_pool_rate = ${parseFloat(String(commission_pool_rate))}
      WHERE id = ${jobId} AND company_id = ${companyId}
    `);

    const result = await calculateTechPay(jobId, companyId);
    return res.json({ data: result });
  } catch (err) {
    console.error("POST /jobs/:id/commission/set-pool-rate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── INLINE EDIT: SWAP PRIMARY TECHNICIAN ─────────────────────────────────────
//
// PATCH /api/jobs/:id/reassign-tech
//
// Body: { new_tech_id: number }
//
// Atomic primary-tech swap used by the dispatch drawer's inline tech editor.
// Branch isolated: the new tech must belong to the same branch as the job.
// The swap demotes any existing primary, upserts the new tech with
// is_primary=true, and mirrors onto jobs.assigned_user_id (per the
// Assignment Mirror invariant in CLAUDE.md). Other team members on the job
// are preserved; only the primary slot rotates. Audit row written to
// job_audit_log so dispatcher activity is traceable.
//
// Differs from POST /:id/technicians (Add Team Member): that flow appends a
// tech (sometimes promoting to primary on unassigned jobs); this flow
// REPLACES the existing primary specifically.
router.patch("/:id/reassign-tech", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const newTechId = Number((req.body ?? {}).new_tech_id);
    if (!Number.isFinite(newTechId) || newTechId <= 0) {
      return res.status(400).json({ error: "new_tech_id required" });
    }

    // Read current job + its branch.
    const jobRows = await db.execute(sql`
      SELECT id, assigned_user_id, branch_id FROM jobs
      WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!jobRows.rows.length) return res.status(404).json({ error: "Job not found" });
    const job = jobRows.rows[0] as any;
    const oldAssignedUserId = job.assigned_user_id ?? null;
    const jobBranchId = job.branch_id ?? null;

    if (oldAssignedUserId === newTechId) {
      // No change, return early.
      return res.json({ data: { unchanged: true, assigned_user_id: newTechId } });
    }

    // Validate the new tech exists, is active, and is in the same branch as
    // the job (branch isolation).
    const techRows = await db.execute(sql`
      SELECT id, branch_id, is_active, role, first_name, last_name
      FROM users
      WHERE id = ${newTechId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!techRows.rows.length) return res.status(404).json({ error: "Technician not found" });
    const tech = techRows.rows[0] as any;
    if (!tech.is_active) {
      return res.status(400).json({ error: "Technician is inactive" });
    }
    if (jobBranchId != null && tech.branch_id != null && jobBranchId !== tech.branch_id) {
      return res.status(403).json({ error: "Technician belongs to a different branch" });
    }

    // Capture before-state for audit log.
    const techsBefore = await db.execute(sql`
      SELECT user_id, is_primary FROM job_technicians
      WHERE job_id = ${jobId} ORDER BY is_primary DESC, id
    `);

    await db.transaction(async (tx) => {
      // Demote any existing primary (and any row for the new tech that was
      // sitting at non-primary before today).
      await tx.execute(sql`
        UPDATE job_technicians SET is_primary = false
        WHERE job_id = ${jobId}
      `);
      // Upsert the new tech as primary.
      await tx.execute(sql`
        INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
        VALUES (${jobId}, ${newTechId}, ${companyId}, true)
        ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = true
      `);
      // Mirror onto jobs.assigned_user_id so the dispatch grid sees the new row.
      await tx.execute(sql`
        UPDATE jobs SET assigned_user_id = ${newTechId}
        WHERE id = ${jobId} AND company_id = ${companyId}
      `);

      // Audit row.
      const userRows = await tx.execute(sql`
        SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1
      `);
      const u = (userRows.rows[0] as any) ?? {};
      const actorName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown";
      const actorEmail = String(u.email ?? "");
      const summary = {
        action: "tech_reassigned",
        new_primary_user_id: newTechId,
        previous_assigned_user_id: oldAssignedUserId,
        previous_techs: techsBefore.rows,
      };
      await tx.execute(sql`
        INSERT INTO job_audit_log
          (job_id, company_id, user_id, user_name, user_email,
           field_name, old_value, new_value, cascade_scope, schedule_id)
        VALUES
          (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
           'tech_reassigned',
           ${JSON.stringify({ assigned_user_id: oldAssignedUserId, techs: techsBefore.rows })}::jsonb,
           ${JSON.stringify(summary)}::jsonb,
           'this_job', ${null})
      `);
    });

    const techPay = await calculateTechPay(jobId, companyId);
    return res.json({
      data: {
        assigned_user_id: newTechId,
        assigned_user_name: `${tech.first_name ?? ""} ${tech.last_name ?? ""}`.trim(),
        techs: techPay,
      },
    });
  } catch (err) {
    console.error("PATCH /jobs/:id/reassign-tech error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── INLINE EDIT: ADDRESS WITH GEOCODE VALIDATION ─────────────────────────────
//
// PATCH /api/jobs/:id/address
//
// Body: { address: string, city?: string, state?: string, zip?: string }
//
// Mode is auto-picked server-side:
//   * If jobs.address_street is already set AND differs from clients.address,
//     this job has a one-off site override and we keep writing at the job
//     level (jobs.address_*).
//   * Otherwise we write at the client level (clients.address/city/state/zip
//     plus clients.lat/lng), which fixes all future occurrences.
//
// Defense in depth: server re-runs geocodeAddress before writing. Failure
// returns 422 even though the popover already pre-validates via
// /api/geocode/validate. Belt and suspenders.
//
// On success, re-resolves the zone via resolveZoneForZip so the dispatch
// tile's zone color flips immediately on the next poll/refresh.
router.patch("/:id/address", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const { address, city, state, zip, mode: requestedMode, cascade_future, preview } = (req.body ?? {}) as {
      address?: string; city?: string; state?: string; zip?: string;
      mode?: "client" | "job";
      // [address-cascade 2026-06-04] How far an "apply to all future" change
      // reaches into jobs already on the calendar. The office picks this via a
      // prompt (Sal's call). "all" = every upcoming job that carries its own
      // saved address; "matching" = only those still at the OLD client address
      // (leaves deliberate one-off sites alone); "none" = client record only,
      // upcoming jobs without an override inherit it automatically.
      cascade_future?: "none" | "matching" | "all";
      // When true, don't write anything — return how many upcoming jobs would
      // be affected so the frontend can render the cascade prompt.
      preview?: boolean;
    };

    if (!address || !address.trim()) {
      return res.status(400).json({ error: "Street address is required." });
    }

    // Read current state for mode decision and audit.
    const ctx = await db.execute(sql`
      SELECT
        j.id, j.client_id, j.zone_id AS job_zone_id,
        j.address_street AS j_addr, j.address_city AS j_city,
        j.address_state AS j_state, j.address_zip AS j_zip,
        c.address AS c_addr, c.city AS c_city,
        c.state AS c_state, c.zip AS c_zip
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.id = ${jobId} AND j.company_id = ${companyId} LIMIT 1
    `);
    if (!ctx.rows.length) return res.status(404).json({ error: "Job not found" });
    const r = ctx.rows[0] as any;

    // [address-cascade 2026-06-04] Preview: count UPCOMING jobs for this client
    // (excluding the one being edited) that carry their OWN saved address —
    // those are the only ones a client-level change won't fix automatically.
    // Split into "same" (still at the old client address — safe to move) vs
    // "different" (a deliberate one-off site). Jobs without an override aren't
    // counted: they inherit the client address the moment it changes.
    if (preview === true) {
      const counts = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE has_override)                AS override_total,
          COUNT(*) FILTER (WHERE has_override AND is_same)    AS same_count,
          COUNT(*) FILTER (WHERE has_override AND NOT is_same) AS diff_count
        FROM (
          SELECT
            (j.address_street IS NOT NULL AND btrim(j.address_street) <> '') AS has_override,
            (lower(btrim(coalesce(j.address_street, ''))) = lower(btrim(coalesce(${r.c_addr ?? ""}, '')))
             AND coalesce(j.address_zip, '') = coalesce(${r.c_zip ?? ""}, '')) AS is_same
          FROM jobs j
          WHERE j.company_id = ${companyId}
            AND j.client_id = ${r.client_id}
            AND j.id <> ${jobId}
            AND j.scheduled_date >= CURRENT_DATE
            AND j.status IN ('scheduled', 'in_progress')
        ) t
      `);
      const c = (counts.rows[0] as any) ?? {};
      return res.json({
        preview: true,
        future_override_total: Number(c.override_total ?? 0),
        future_same: Number(c.same_count ?? 0),
        future_different: Number(c.diff_count ?? 0),
      });
    }

    // Mode resolution. Frontend now sends an explicit mode (the popover's
    // "permanent change" checkbox controls it: unchecked = job, checked =
    // client). Auto-pick stays as a backwards-compatible fallback for any
    // future caller that omits mode, AND for the case where a client has no
    // address on file at all (NULL) — we always cascade to client level
    // there because there is no canonical record to override.
    const clientHasAddress = !!String(r.c_addr ?? "").trim();
    const jobAddrTrim = String(r.j_addr ?? "").trim();
    const jobZipTrim = String(r.j_zip ?? "").trim();
    const cAddrTrim = String(r.c_addr ?? "").trim();
    const cZipTrim = String(r.c_zip ?? "").trim();
    const autoPickedJobOverride = clientHasAddress
      && !!jobAddrTrim
      && (jobAddrTrim !== cAddrTrim || jobZipTrim !== cZipTrim);

    let mode: "client" | "job";
    if (requestedMode === "client" || requestedMode === "job") {
      // Honor the explicit choice unless the client has no address yet.
      // Even if the user picked "job", a client with no canonical address
      // gets the cascade so future jobs are not orphaned.
      mode = (!clientHasAddress) ? "client" : requestedMode;
    } else {
      mode = autoPickedJobOverride ? "job" : "client";
    }

    // Server-side geocode (defense in depth).
    const fullAddress = [address, city, state, zip].filter(Boolean).join(", ");
    const coords = await geocodeAddress(fullAddress);
    if (!coords) {
      return res.status(422).json({
        error: "Could not verify address. Check spelling, city, and zip.",
      });
    }

    const newZoneId = zip ? await resolveZoneForZip(companyId, zip) : null;

    // Per the product rule (Sal, 2026-04-28): the only valid failure case is
    // when the resolved zip is not mapped to any active service zone in this
    // tenant's database. Reject the save with 422 so the inline form can
    // surface the message instead of silently saving an unmapped address
    // (which would render as a gray tile on dispatch).
    if (!newZoneId) {
      return res.status(422).json({
        error: zip
          ? `Zip ${zip} is not in any of your service zones. Add it under Settings → Service Zones first.`
          : "Could not determine a zip code from this address.",
      });
    }

    // Cascade scope only applies to a client-level change. Defaults to "none"
    // (existing behavior) for any caller that doesn't send it.
    const scope: "none" | "matching" | "all" =
      (mode === "client" && (cascade_future === "all" || cascade_future === "matching"))
        ? cascade_future
        : "none";
    let cascadedCount = 0;

    const before = {
      mode,
      address: r.j_addr ?? r.c_addr ?? null,
      city:    r.j_city ?? r.c_city ?? null,
      state:   r.j_state ?? r.c_state ?? null,
      zip:     r.j_zip ?? r.c_zip ?? null,
      zone_id: r.job_zone_id ?? null,
    };

    await db.transaction(async (tx) => {
      if (mode === "job") {
        await tx.execute(sql`
          UPDATE jobs SET
            address_street   = ${address},
            address_city     = ${city ?? null},
            address_state    = ${state ?? null},
            address_zip      = ${zip ?? null},
            address_lat      = ${String(coords.lat)},
            address_lng      = ${String(coords.lng)},
            address_verified = true,
            zone_id          = ${newZoneId}
          WHERE id = ${jobId} AND company_id = ${companyId}
        `);
      } else {
        // Client level: the canonical address for this customer.
        await tx.execute(sql`
          UPDATE clients SET
            address = ${address},
            city    = ${city ?? null},
            state   = ${state ?? null},
            zip     = ${zip ?? null},
            lat     = ${String(coords.lat)},
            lng     = ${String(coords.lng)},
            zone_id = ${newZoneId}
          WHERE id = ${r.client_id} AND company_id = ${companyId}
        `);
        // Mirror the resolved zone onto the job too so the dispatch tile
        // updates without waiting for the recurring engine to regenerate.
        await tx.execute(sql`
          UPDATE jobs SET zone_id = ${newZoneId}
          WHERE id = ${jobId} AND company_id = ${companyId}
        `);

        // [address-cascade 2026-06-04] Rewrite the address on upcoming jobs
        // that carry their OWN saved address, per the scope the office chose
        // in the prompt. Jobs without an override already inherit the client
        // change above, so they're untouched. "matching" leaves deliberate
        // one-off sites (different from the old client address) alone.
        if (scope === "all" || scope === "matching") {
          const sameOnly = scope === "matching"
            ? sql`AND lower(btrim(coalesce(address_street, ''))) = lower(btrim(coalesce(${r.c_addr ?? ""}, '')))
                  AND coalesce(address_zip, '') = coalesce(${r.c_zip ?? ""}, '')`
            : sql``;
          const cascaded = await tx.execute(sql`
            UPDATE jobs SET
              address_street   = ${address},
              address_city     = ${city ?? null},
              address_state    = ${state ?? null},
              address_zip      = ${zip ?? null},
              address_lat      = ${String(coords.lat)},
              address_lng      = ${String(coords.lng)},
              address_verified = true,
              zone_id          = ${newZoneId}
            WHERE company_id = ${companyId}
              AND client_id = ${r.client_id}
              AND id <> ${jobId}
              AND scheduled_date >= CURRENT_DATE
              AND status IN ('scheduled', 'in_progress')
              AND address_street IS NOT NULL AND btrim(address_street) <> ''
              ${sameOnly}
            RETURNING id
          `);
          cascadedCount = cascaded.rows.length;
        }
      }

      // Audit row.
      const userRows = await tx.execute(sql`
        SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1
      `);
      const u = (userRows.rows[0] as any) ?? {};
      const actorName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unknown";
      const actorEmail = String(u.email ?? "");
      const after = {
        mode,
        address, city: city ?? null, state: state ?? null, zip: zip ?? null,
        zone_id: newZoneId,
        lat: String(coords.lat), lng: String(coords.lng),
        cascade_future: scope,
        cascaded_jobs: cascadedCount,
      };
      await tx.execute(sql`
        INSERT INTO job_audit_log
          (job_id, company_id, user_id, user_name, user_email,
           field_name, old_value, new_value, cascade_scope, schedule_id)
        VALUES
          (${jobId}, ${companyId}, ${userId}, ${actorName}, ${actorEmail},
           'address_changed',
           ${JSON.stringify(before)}::jsonb,
           ${JSON.stringify(after)}::jsonb,
           ${mode === "client" ? "all_future" : "this_job"}, ${null})
      `);
    });

    return res.json({
      data: {
        mode,
        address, city, state, zip,
        lat: coords.lat, lng: coords.lng,
        zone_id: newZoneId,
        cascade_future: scope,
        cascaded_jobs: cascadedCount,
      },
    });
  } catch (err) {
    console.error("PATCH /jobs/:id/address error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// JOBS PAGE V2 — KPI, enhanced list, bulk actions, views, column prefs, export
// ═══════════════════════════════════════════════════════════════════════════════

const VALID_STATUSES = ["scheduled", "in_progress", "complete", "cancelled"];
const VALID_SERVICE_TYPES = ["standard_clean", "deep_clean", "move_out", "recurring", "post_construction", "move_in", "office_cleaning", "common_areas", "retail_store", "medical_office", "ppm_turnover", "post_event"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildJobWhereClause(query: any, companyId: number, cursorId?: number | null) {
  const parts: ReturnType<typeof sql>[] = [sql`j.company_id = ${companyId}`];
  if (query.status && VALID_STATUSES.includes(query.status)) parts.push(sql`j.status = ${query.status}`);
  if (query.branch_id && query.branch_id !== "all") { const v = parseInt(query.branch_id); if (!isNaN(v)) parts.push(sql`j.branch_id = ${v}`); }
  if (query.zone_id) { const v = parseInt(query.zone_id); if (!isNaN(v)) parts.push(sql`j.zone_id = ${v}`); }
  if (query.date_from && DATE_RE.test(query.date_from)) parts.push(sql`j.scheduled_date >= ${query.date_from}`);
  if (query.date_to && DATE_RE.test(query.date_to)) parts.push(sql`j.scheduled_date <= ${query.date_to}`);
  if (query.assigned_user_id) {
    if (query.assigned_user_id === "unassigned") parts.push(sql`j.assigned_user_id IS NULL`);
    else { const v = parseInt(query.assigned_user_id); if (!isNaN(v)) parts.push(sql`j.assigned_user_id = ${v}`); }
  }
  if (query.client_id) { const v = parseInt(query.client_id); if (!isNaN(v)) parts.push(sql`j.client_id = ${v}`); }
  if (query.service_type && VALID_SERVICE_TYPES.includes(query.service_type)) parts.push(sql`j.service_type = ${query.service_type}`);
  if (query.flagged === "true") parts.push(sql`j.flagged = true`);
  if (query.has_photos === "true") parts.push(sql`EXISTS (SELECT 1 FROM job_photos jp WHERE jp.job_id = j.id)`);
  if (query.revenue_min) { const v = parseFloat(query.revenue_min); if (!isNaN(v)) parts.push(sql`CAST(j.base_fee AS NUMERIC) >= ${v}`); }
  if (query.revenue_max) { const v = parseFloat(query.revenue_max); if (!isNaN(v)) parts.push(sql`CAST(j.base_fee AS NUMERIC) <= ${v}`); }
  if (query.payment_status === "paid") parts.push(sql`j.charge_succeeded_at IS NOT NULL`);
  else if (query.payment_status === "failed") parts.push(sql`j.charge_failed_at IS NOT NULL AND j.charge_succeeded_at IS NULL`);
  else if (query.payment_status === "unpaid") parts.push(sql`j.charge_succeeded_at IS NULL AND j.charge_failed_at IS NULL AND j.charge_attempted_at IS NULL`);
  if (query.uninvoiced === "true") parts.push(sql`NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status IN ('sent','paid'))`);
  if (query.search) {
    const s = `%${String(query.search)}%`;
    parts.push(sql`(concat(c.first_name, ' ', c.last_name) ILIKE ${s} OR concat(u.first_name, ' ', u.last_name) ILIKE ${s} OR c.address ILIKE ${s} OR c.email ILIKE ${s} OR CAST(j.id AS TEXT) = ${String(query.search)})`);
  }
  if (cursorId) parts.push(sql`j.id < ${cursorId}`);
  return sql.join(parts, sql` AND `);
}

const JOBS_V2_FROM = sql`FROM jobs j LEFT JOIN clients c ON j.client_id = c.id LEFT JOIN users u ON j.assigned_user_id = u.id LEFT JOIN service_zones sz ON j.zone_id = sz.id LEFT JOIN branches b ON j.branch_id = b.id`;

// GET /api/jobs/v2/kpi
router.get("/v2/kpi", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const where = buildJobWhereClause(req.query, companyId);
    const result = await db.execute(sql`
      SELECT
        COALESCE(MIN(CAST(j.base_fee AS NUMERIC)), 0) AS revenue_min,
        COALESCE(MAX(CAST(j.base_fee AS NUMERIC)), 0) AS revenue_max,
        COALESCE(SUM(CAST(j.base_fee AS NUMERIC)), 0) AS revenue_total,
        COUNT(*) FILTER (WHERE j.status = 'complete') AS completed,
        CASE WHEN COUNT(*) > 0 THEN ROUND(SUM(CAST(j.base_fee AS NUMERIC)) / COUNT(*), 2) ELSE 0 END AS avg_job,
        COUNT(*) AS total_jobs,
        COUNT(DISTINCT j.scheduled_date) AS distinct_days,
        COUNT(*) FILTER (WHERE j.assigned_user_id IS NULL) AS unassigned
      ${JOBS_V2_FROM} WHERE ${where}
    `);
    const row = (result as any).rows?.[0] ?? {};
    const totalJobs = parseInt(row.total_jobs) || 0;
    const distinctDays = parseInt(row.distinct_days) || 1;
    return res.json({
      revenue_min: parseFloat(row.revenue_min) || 0,
      revenue_max: parseFloat(row.revenue_max) || 0,
      revenue_total: parseFloat(row.revenue_total) || 0,
      completed: parseInt(row.completed) || 0,
      avg_job: parseFloat(row.avg_job) || 0,
      jobs_per_day: Math.round((totalJobs / distinctDays) * 10) / 10,
      unassigned: parseInt(row.unassigned) || 0,
    });
  } catch (err) {
    console.error("GET /jobs/v2/kpi error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/jobs/v2/list — cursor-paginated
router.get("/v2/list", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 50), 200);
    const cursorRaw = req.query.cursor ? parseInt(req.query.cursor as string) : null;
    const cursor = cursorRaw && !isNaN(cursorRaw) ? cursorRaw : null;
    const sortCol = (req.query.sort as string) || "scheduled_date";
    const sortDir = (req.query.dir as string) === "asc" ? sql`ASC` : sql`DESC`;

    const where = buildJobWhereClause(req.query, companyId, cursor);

    const validSorts: Record<string, ReturnType<typeof sql>> = {
      scheduled_date: sql`j.scheduled_date`,
      client_name: sql`concat(c.first_name, ' ', c.last_name)`,
      status: sql`j.status`,
      base_fee: sql`CAST(j.base_fee AS NUMERIC)`,
      service_type: sql`j.service_type`,
      created_at: sql`j.created_at`,
    };
    const orderExpr = validSorts[sortCol] || sql`j.scheduled_date`;

    const result = await db.execute(sql`
      SELECT
        j.id, j.client_id, j.assigned_user_id, j.service_type, j.status,
        j.scheduled_date, j.scheduled_time, j.frequency, j.base_fee,
        j.allowed_hours, j.actual_hours, j.notes, j.flagged, j.zone_id, j.branch_id,
        j.charge_succeeded_at, j.charge_failed_at, j.charge_attempted_at,
        j.created_at, j.office_notes,
        concat(c.first_name, ' ', c.last_name) AS client_name,
        c.address AS client_address, c.city AS client_city, c.state AS client_state, c.zip AS client_zip, c.referral_source,
        concat(u.first_name, ' ', u.last_name) AS tech_name,
        sz.name AS zone_name, sz.color AS zone_color, b.name AS branch_name
      ${JOBS_V2_FROM} WHERE ${where}
      ORDER BY ${orderExpr} ${sortDir}, j.id DESC
      LIMIT ${limit + 1}
    `);

    const rows = (result as any).rows ?? [];
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].id : null;
    const mapped = data.map((r: any) => ({
      ...r,
      base_fee: r.base_fee ? parseFloat(r.base_fee) : 0,
      payment_status: r.charge_succeeded_at ? "paid" : r.charge_failed_at ? "failed" : r.charge_attempted_at ? "pending" : "unpaid",
    }));

    const countWhere = buildJobWhereClause(req.query, companyId);
    const countResult = await db.execute(sql`SELECT COUNT(*) AS cnt ${JOBS_V2_FROM} WHERE ${countWhere}`);
    const total = parseInt((countResult as any).rows?.[0]?.cnt) || 0;

    return res.json({ data: mapped, total, next_cursor: nextCursor, has_more: hasMore });
  } catch (err) {
    console.error("GET /jobs/v2/list error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/jobs/v2/bulk — bulk actions
router.post("/v2/bulk", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { action, job_ids, payload } = req.body;
    if (!Array.isArray(job_ids) || job_ids.length === 0) return res.status(400).json({ error: "job_ids required" });
    const idList = job_ids.map((id: any) => parseInt(id)).filter((n: number) => !isNaN(n));
    if (idList.length === 0) return res.status(400).json({ error: "no valid job IDs" });

    switch (action) {
      case "mark_complete": {
        await db.execute(sql`UPDATE jobs SET status = 'complete' WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        return res.json({ success: true, affected: idList.length });
      }
      case "mark_paid": {
        await db.execute(sql`UPDATE jobs SET charge_succeeded_at = NOW() WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        return res.json({ success: true, affected: idList.length });
      }
      case "cancel": {
        const reason = String(payload?.reason || "cancelled").slice(0, 200);
        await db.execute(sql`UPDATE jobs SET status = 'cancelled', notes = COALESCE(notes, '') || ${` [Cancelled: ${reason}]`} WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        return res.json({ success: true, affected: idList.length });
      }
      case "reassign": {
        const techId = parseInt(payload?.assigned_user_id);
        if (!techId || isNaN(techId)) return res.status(400).json({ error: "assigned_user_id required" });
        await db.execute(sql`UPDATE jobs SET assigned_user_id = ${techId} WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        return res.json({ success: true, affected: idList.length });
      }
      case "reschedule": {
        const date = payload?.date;
        if (!date || !DATE_RE.test(date)) return res.status(400).json({ error: "valid date required (YYYY-MM-DD)" });
        const timeShift = payload?.time_shift || null;
        if (timeShift) {
          await db.execute(sql`UPDATE jobs SET scheduled_date = ${date}, scheduled_time = ${timeShift} WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        } else {
          await db.execute(sql`UPDATE jobs SET scheduled_date = ${date} WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        }
        return res.json({ success: true, affected: idList.length });
      }
      case "flag": {
        const flagged = payload?.flagged !== false;
        await db.execute(sql`UPDATE jobs SET flagged = ${flagged} WHERE id = ANY(${idList}::int[]) AND company_id = ${companyId}`);
        return res.json({ success: true, affected: idList.length });
      }
      case "batch_invoice_preflight": {
        const pf = await db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status IN ('sent','paid'))) AS to_invoice,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status IN ('sent','paid'))) AS already_invoiced,
            COALESCE(SUM(CAST(j.base_fee AS NUMERIC)) FILTER (WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status IN ('sent','paid'))), 0) AS total_amount
          FROM jobs j WHERE j.id = ANY(${idList}::int[]) AND j.company_id = ${companyId}
        `);
        const r = (pf as any).rows?.[0] ?? {};
        return res.json({ to_invoice: parseInt(r.to_invoice) || 0, already_invoiced: parseInt(r.already_invoiced) || 0, total_amount: parseFloat(r.total_amount) || 0 });
      }
      default: return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("POST /jobs/v2/bulk error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Saved Views CRUD ─────────────────────────────────────────────────────────

router.get("/v2/views", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    const result = await db.execute(sql`
      SELECT * FROM user_saved_views
      WHERE user_id = ${userId} AND company_id = ${companyId} AND page = 'jobs'
      ORDER BY is_default DESC, name ASC
    `);
    return res.json((result as any).rows ?? []);
  } catch (err) {
    console.error("GET /jobs/v2/views error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/v2/views", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    const { name, filter_json, column_config_json } = req.body;
    const result = await db.execute(sql`
      INSERT INTO user_saved_views (user_id, company_id, page, name, filter_json, column_config_json)
      VALUES (${userId}, ${companyId}, 'jobs', ${String(name).slice(0, 100)}, ${JSON.stringify(filter_json)}, ${JSON.stringify(column_config_json)})
      RETURNING *
    `);
    return res.status(201).json(((result as any).rows ?? [])[0]);
  } catch (err) {
    console.error("POST /jobs/v2/views error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/v2/views/:viewId", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const viewId = parseInt(req.params.viewId);
    if (isNaN(viewId)) return res.status(400).json({ error: "invalid viewId" });
    const { name, filter_json, column_config_json, is_default } = req.body;
    if (is_default) {
      await db.execute(sql`UPDATE user_saved_views SET is_default = false WHERE user_id = ${userId} AND page = 'jobs'`);
    }
    const result = await db.execute(sql`
      UPDATE user_saved_views
      SET name = COALESCE(${name ?? null}, name),
          filter_json = COALESCE(${filter_json ? JSON.stringify(filter_json) : null}, filter_json),
          column_config_json = COALESCE(${column_config_json ? JSON.stringify(column_config_json) : null}, column_config_json),
          is_default = COALESCE(${is_default ?? null}, is_default),
          updated_at = NOW()
      WHERE id = ${viewId} AND user_id = ${userId}
      RETURNING *
    `);
    return res.json(((result as any).rows ?? [])[0]);
  } catch (err) {
    console.error("PUT /jobs/v2/views/:viewId error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/v2/views/:viewId", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const viewId = parseInt(req.params.viewId);
    if (isNaN(viewId)) return res.status(400).json({ error: "invalid viewId" });
    await db.execute(sql`DELETE FROM user_saved_views WHERE id = ${viewId} AND user_id = ${userId}`);
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /jobs/v2/views/:viewId error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Column Preferences ───────────────────────────────────────────────────────

router.get("/v2/columns", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    const result = await db.execute(sql`
      SELECT * FROM user_column_preferences
      WHERE user_id = ${userId} AND company_id = ${companyId} AND page = 'jobs'
      ORDER BY sort_order ASC
    `);
    return res.json((result as any).rows ?? []);
  } catch (err) {
    console.error("GET /jobs/v2/columns error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/v2/columns", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    const columns: Array<{ column_key: string; visible: boolean; sort_order: number }> = req.body;
    if (!Array.isArray(columns)) return res.status(400).json({ error: "array required" });
    for (const col of columns) {
      await db.execute(sql`
        INSERT INTO user_column_preferences (user_id, company_id, page, column_key, visible, sort_order)
        VALUES (${userId}, ${companyId}, 'jobs', ${String(col.column_key).slice(0, 50)}, ${!!col.visible}, ${parseInt(String(col.sort_order)) || 0})
        ON CONFLICT (user_id, page, column_key)
        DO UPDATE SET visible = EXCLUDED.visible, sort_order = EXCLUDED.sort_order
      `);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("PUT /jobs/v2/columns error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Export ────────────────────────────────────────────────────────────────────

router.get("/v2/export", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const format = (req.query.format as string) || "csv";
    const where = buildJobWhereClause(req.query, companyId);
    const result = await db.execute(sql`
      SELECT
        j.id, concat(c.first_name, ' ', c.last_name) AS client_name,
        c.address AS client_address, c.city AS client_city,
        concat(u.first_name, ' ', u.last_name) AS tech_name,
        j.scheduled_date, j.scheduled_time, j.service_type, j.status,
        j.base_fee, j.frequency, j.flagged,
        b.name AS branch_name, sz.name AS zone_name, c.referral_source,
        CASE WHEN j.charge_succeeded_at IS NOT NULL THEN 'paid'
             WHEN j.charge_failed_at IS NOT NULL THEN 'failed'
             ELSE 'unpaid' END AS payment_status
      ${JOBS_V2_FROM} WHERE ${where}
      ORDER BY j.scheduled_date DESC, j.id DESC
      LIMIT 10000
    `);

    const rows = (result as any).rows ?? [];
    if (format === "csv") {
      const headers = ["ID","Client","Address","City","Technician","Date","Time","Service","Status","Amount","Frequency","Flagged","Branch","Zone","Source","Payment Status"];
      const csvRows = rows.map((r: any) => [
        r.id, `"${(r.client_name || "").replace(/"/g, '""')}"`,
        `"${(r.client_address || "").replace(/"/g, '""')}"`,
        `"${(r.client_city || "").replace(/"/g, '""')}"`,
        `"${(r.tech_name || "Unassigned").replace(/"/g, '""')}"`,
        r.scheduled_date, r.scheduled_time || "",
        r.service_type, r.status, r.base_fee || "0",
        r.frequency, r.flagged ? "Yes" : "No",
        r.branch_name || "", r.zone_name || "",
        r.referral_source || "", r.payment_status,
      ].join(","));
      const csv = [headers.join(","), ...csvRows].join("\n");
      const today = new Date().toISOString().split("T")[0];
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=qleno_jobs_phes_${today}.csv`);
      return res.send(csv);
    }
    return res.json(rows);
  } catch (err) {
    console.error("GET /jobs/v2/export error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Job rate mods ────────────────────────────────────────────────────────────
// Per-job time and fee adjustments layered on top of jobs.base_fee.
//   - mod_type='time': minutes is required; amount is the computed dollar adjustment
//   - mod_type='flat': minutes ignored; amount is the dollar adjustment (+ or -)
// After every write the route recomputes billed_amount = base_fee + SUM(mods.amount).
// billed_amount is the field every downstream surface (invoicing, payroll commission,
// revenue rollups, manual charge) reads via COALESCE(billed_amount, base_fee), so
// pushing the post-mod total there flows through automatically.

async function recomputeJobBilledAmount(jobId: number, companyId: number): Promise<number> {
  // [commercial-revenue 2026-06-04] Keep billed_amount — the cache payroll +
  // the weekly chart read — in lockstep with how dispatch computes revenue
  // live, so the two never diverge. Commercial work whose price is NOT a
  // pinned flat amount bills hourly_rate × allowed_hours + add-ons + rate-mods
  // (the MaidCentral model). Everything else keeps the legacy base_fee + mods
  // behavior untouched (residential price semantics aren't in scope here).
  const rows = await db.execute(sql`
    SELECT j.base_fee, j.hourly_rate, j.allowed_hours, j.account_id,
           j.manual_rate_override, c.client_type
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    WHERE j.id = ${jobId} AND j.company_id = ${companyId}
    LIMIT 1
  `);
  const job = rows.rows[0] as any;
  if (!job) return 0;
  const base = parseFloat(String(job.base_fee || "0"));
  const sumRows = await db.execute(sql`
    SELECT COALESCE(SUM(amount), 0)::numeric AS total,
           COALESCE(SUM(amount) FILTER (WHERE mod_type = 'flat'), 0)::numeric AS flat_total
    FROM job_rate_mods
    WHERE job_id = ${jobId} AND company_id = ${companyId}
  `);
  const modsTotal = parseFloat(String((sumRows.rows[0] as any)?.total ?? "0"));
  const flatModsTotal = parseFloat(String((sumRows.rows[0] as any)?.flat_total ?? "0"));

  const isCommercial = job.account_id != null || job.client_type === "commercial";
  const override = job.manual_rate_override === true;
  const rate = parseFloat(String(job.hourly_rate || "0"));
  const hrs = parseFloat(String(job.allowed_hours || "0"));

  let newBilled: number;
  if (isCommercial && !override && rate > 0 && hrs > 0) {
    // Commercial: rate × allowed_hours + add-ons + FLAT mods only. 'time' mods
    // already grew allowed_hours (PR #307), so they're in rate × hrs — adding
    // their amount again would double-count the added time.
    const addOnRows = await db.execute(sql`
      SELECT COALESCE(SUM(subtotal), 0)::numeric AS total
      FROM job_add_ons
      WHERE job_id = ${jobId}
    `);
    const addOnsTotal = parseFloat(String((addOnRows.rows[0] as any)?.total ?? "0"));
    newBilled = rate * hrs + flatModsTotal + addOnsTotal;
  } else {
    newBilled = base + modsTotal;
  }

  await db
    .update(jobsTable)
    .set({ billed_amount: newBilled.toFixed(2) })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)));
  return newBilled;
}

// [additional-time 2026-06-04] A 'time' rate-mod (e.g. "Additional Time: 1.5h")
// must also move the job's allowed_hours so commercial commission
// (rate × allowed_hours) and the schedule block grow with the added time.
// Incremental: +minutes on add, −minutes on remove. Clamped at 0.
async function adjustAllowedHours(jobId: number, companyId: number, deltaMinutes: number): Promise<number | null> {
  if (!deltaMinutes) return null;
  const r = await db.execute(sql`
    UPDATE jobs
    SET allowed_hours = GREATEST(0, ROUND((COALESCE(allowed_hours, 0) + ${deltaMinutes / 60})::numeric, 2))
    WHERE id = ${jobId} AND company_id = ${companyId}
    RETURNING allowed_hours
  `);
  const v = (r.rows?.[0] as any)?.allowed_hours;
  return v != null ? parseFloat(String(v)) : null;
}

// GET /api/jobs/:id/rate-mods — list all mods on a job
router.get("/:id/rate-mods", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const rows = await db.execute(sql`
      SELECT m.id, m.mod_type, m.minutes, m.amount, m.reason,
             m.created_by, m.created_at,
             concat(u.first_name, ' ', u.last_name) AS created_by_name
      FROM job_rate_mods m
      LEFT JOIN users u ON u.id = m.created_by
      WHERE m.job_id = ${jobId} AND m.company_id = ${companyId}
      ORDER BY m.created_at ASC
    `);
    return res.json({ mods: rows.rows });
  } catch (err) {
    console.error("GET /jobs/:id/rate-mods error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list rate mods" });
  }
});

// POST /api/jobs/:id/rate-mods — add a mod
//
// [BUG-3 / 2026-06-01] dry_run support. When body has `dry_run: true`, the
// route validates the inputs and returns the projected billed_amount WITHOUT
// inserting a row or updating billed_amount. Previously the flag was silently
// ignored, so a "preview" call by the UI would actually charge the mod — and
// a subsequent real submit would stack a second mod on top (double-charge:
// $320 base + $100 dry-run + $100 real = $520 instead of the intended $420).
// Response shape under dry_run keeps `billed_amount` so the preview UI can
// render it; `mod` is null and `dry_run: true` is echoed back.
router.post("/:id/rate-mods", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const userId = req.auth!.userId;
    const { mod_type, minutes, amount, reason, dry_run } = req.body ?? {};
    const isDryRun = dry_run === true;

    if (mod_type !== "time" && mod_type !== "flat") {
      return res.status(400).json({ error: "Bad Request", message: "mod_type must be 'time' or 'flat'" });
    }
    if (mod_type === "time" && (minutes === undefined || minutes === null || Number.isNaN(Number(minutes)))) {
      return res.status(400).json({ error: "Bad Request", message: "minutes is required for mod_type='time'" });
    }
    const amt = Number(amount);
    if (Number.isNaN(amt)) {
      return res.status(400).json({ error: "Bad Request", message: "amount must be numeric" });
    }
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return res.status(400).json({ error: "Bad Request", message: "reason is required" });
    }

    const [existing] = await db
      .select({ id: jobsTable.id, base_fee: jobsTable.base_fee })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .limit(1);
    if (!existing) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }

    // Dry-run projection: current_billed + amt. No write to job_rate_mods,
    // no UPDATE on jobs.billed_amount, no audit log row.
    if (isDryRun) {
      const base = parseFloat(String(existing.base_fee || "0"));
      const sumRows = await db.execute(sql`
        SELECT COALESCE(SUM(amount), 0)::numeric AS total
        FROM job_rate_mods
        WHERE job_id = ${jobId} AND company_id = ${companyId}
      `);
      const modsTotal = parseFloat(String((sumRows.rows[0] as any)?.total ?? "0"));
      const projected = base + modsTotal + amt;
      return res.status(200).json({
        dry_run: true,
        mod: null,
        billed_amount: projected.toFixed(2),
        projected_billed_amount: projected.toFixed(2),
      });
    }

    const insert = await db.execute(sql`
      INSERT INTO job_rate_mods (company_id, job_id, mod_type, minutes, amount, reason, created_by)
      VALUES (
        ${companyId}, ${jobId}, ${mod_type},
        ${mod_type === "time" ? Number(minutes) : null},
        ${amt.toFixed(2)}, ${reason.trim()}, ${userId}
      )
      RETURNING id, mod_type, minutes, amount, reason, created_by, created_at
    `);
    const newBilled = await recomputeJobBilledAmount(jobId, companyId);
    // Time mods extend the job's allowed hours (commercial commission + block).
    const newAllowedHours = mod_type === "time" ? await adjustAllowedHours(jobId, companyId, Number(minutes)) : null;
    logAudit(req, "CREATE", "job_rate_mod", jobId, null, { mod_type, minutes, amount: amt });
    return res.status(201).json({
      mod: insert.rows[0],
      billed_amount: newBilled.toFixed(2),
      allowed_hours: newAllowedHours,
    });
  } catch (err) {
    console.error("POST /jobs/:id/rate-mods error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to add rate mod" });
  }
});

// DELETE /api/jobs/:id/rate-mods/:modId — remove a mod
router.delete("/:id/rate-mods/:modId", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const modId = parseInt(req.params.modId);
    const companyId = req.auth!.companyId;

    // Read the mod first so a removed 'time' mod also rolls back allowed_hours.
    const modRows = await db.execute(sql`
      SELECT mod_type, minutes FROM job_rate_mods
      WHERE id = ${modId} AND job_id = ${jobId} AND company_id = ${companyId} LIMIT 1
    `);
    const mod = modRows.rows?.[0] as any;
    if (!mod) {
      return res.status(404).json({ error: "Not Found", message: "Rate mod not found" });
    }
    await db.execute(sql`
      DELETE FROM job_rate_mods
      WHERE id = ${modId} AND job_id = ${jobId} AND company_id = ${companyId}
    `);
    const newBilled = await recomputeJobBilledAmount(jobId, companyId);
    const newAllowedHours = mod.mod_type === "time" && mod.minutes
      ? await adjustAllowedHours(jobId, companyId, -Number(mod.minutes)) : null;
    logAudit(req, "DELETE", "job_rate_mod", modId, null, null);
    return res.json({ success: true, billed_amount: newBilled.toFixed(2), allowed_hours: newAllowedHours });
  } catch (err) {
    console.error("DELETE /jobs/:id/rate-mods/:modId error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to delete rate mod" });
  }
});

// ─── DELETE A JOB ────────────────────────────────────────────────────────────
// For made-up / test jobs. Recorded in the audit trail. Clears child rows that
// would block the delete (clock entries, photos, add-ons, status logs, etc.)
// and detaches (nulls) records we keep — invoices, payroll, mileage. Returns
// 409 if the job has links that can't be safely removed → cancel it instead.
router.delete("/:id", requireAuth, async (req, res) => {
  const role = req.auth!.role;
  if (!["owner", "admin", "office"].includes(role)) {
    return res.status(403).json({ error: "Forbidden", message: "Only office, admin, or owner can delete a job." });
  }
  const jobId = parseInt(req.params.id);
  if (isNaN(jobId)) return res.status(400).json({ error: "Invalid id" });
  const [job] = await db.select().from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, req.auth!.companyId))).limit(1);
  if (!job) return res.status(404).json({ error: "Not found" });
  try {
    await db.transaction(async (tx) => {
      const childTables = [
        "job_add_ons", "job_photos", "job_supplies", "job_status_logs", "job_clock_events",
        "job_worksheet", "client_ratings", "cancellation_log", "timeclock", "clock_in_attempts",
        "attendance_proposals", "job_technicians",
      ];
      for (const t of childTables) await tx.execute(sql.raw(`DELETE FROM ${t} WHERE job_id = ${jobId}`));
      const detach: [string, string][] = [
        ["additional_pay", "job_id"], ["communication_log", "job_id"], ["contact_tickets", "job_id"],
        ["form_submissions", "job_id"], ["hr_logs", "job_id"], ["loyalty", "job_id"], ["invoices", "job_id"],
        // [delete-always-works 2026-06-04] quotes.booked_job_id was the missing
        // FK that made delete fail (409 "can't delete") for any job created from
        // a converted quote. Detach it so delete always succeeds.
        ["quotes", "booked_job_id"],
        ["mileage", "from_job_id"], ["mileage", "to_job_id"],
        ["mileage_requests", "from_job_id"], ["mileage_requests", "to_job_id"],
        ["cancellation_log", "rescheduled_to_job_id"],
      ];
      for (const [t, c] of detach) {
        // Tolerate tables/columns that don't exist in a given tenant — a single
        // missing detach target must never block the delete.
        try { await tx.execute(sql.raw(`UPDATE ${t} SET ${c} = NULL WHERE ${c} = ${jobId}`)); }
        catch (e) { console.error(`[delete-job] detach ${t}.${c} skipped:`, (e as any)?.message); }
      }
      await tx.execute(sql.raw(`DELETE FROM jobs WHERE id = ${jobId}`));
    });
    // Global audit trail.
    logAudit(req, "DELETE", "job", jobId, null, {
      client_id: job.client_id, scheduled_date: job.scheduled_date,
      service_type: job.service_type, base_fee: job.base_fee,
    });
    // Cascade to the client's own audit trail so all activity within a client
    // is auditable in one place.
    logClientActivity(req, job.client_id, "job_deleted", {
      job_id: jobId, scheduled_date: job.scheduled_date,
      service_type: job.service_type, base_fee: job.base_fee,
      billed_amount: job.billed_amount, status: job.status,
    }, null);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete job error:", err);
    return res.status(409).json({
      error: "Could not delete",
      message: "This job has linked records (e.g. an invoice or payroll entry) and can't be deleted. Cancel it instead.",
    });
  }
});

// ─── SET A JOB'S ZONE (manual override) ──────────────────────────────────────
// [zone-picker 2026-06-04] Lets the office assign a zone directly on a gray/
// zone-less tile (jobs.zone_id is priority 1 in the dispatch zone chain). Pass
// zone_id null to clear and fall back to the zip-derived chain. Office-only.
router.put("/:id/zone", requireAuth, async (req, res) => {
  const role = req.auth!.role;
  if (!["owner", "admin", "office"].includes(role)) {
    return res.status(403).json({ error: "Forbidden", message: "Only office, admin, or owner can set a zone." });
  }
  const jobId = parseInt(req.params.id);
  if (isNaN(jobId)) return res.status(400).json({ error: "Invalid id" });
  const companyId = req.auth!.companyId;
  const raw = req.body?.zone_id;
  const zoneId = raw == null || raw === "" ? null : parseInt(String(raw));
  if (zoneId != null && isNaN(zoneId)) return res.status(400).json({ error: "Invalid zone_id" });
  try {
    if (zoneId != null) {
      const z = await db.execute(sql`SELECT 1 FROM service_zones WHERE id = ${zoneId} AND company_id = ${companyId} LIMIT 1`);
      if (!z.rows.length) return res.status(400).json({ error: "Zone not found for this company" });
    }
    const upd = await db.update(jobsTable).set({ zone_id: zoneId })
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .returning({ id: jobsTable.id });
    if (!upd.length) return res.status(404).json({ error: "Not found" });
    logAudit(req, "SET_ZONE", "job", jobId, null, { zone_id: zoneId });
    return res.json({ ok: true, zone_id: zoneId });
  } catch (err) {
    console.error("Set job zone error:", err);
    return res.status(500).json({ error: "Failed to set zone" });
  }
});

// ─── APPEND A NOTE TO A JOB ──────────────────────────────────────────────────
// Field techs add notes from mobile. Server-side append (never clobbers
// existing notes), stamped with the date so the history reads cleanly.
router.post("/:id/note", requireAuth, async (req, res) => {
  const jobId = parseInt(req.params.id);
  if (isNaN(jobId)) return res.status(400).json({ error: "Invalid id" });
  const note = String(req.body?.note ?? "").trim();
  if (!note) return res.status(400).json({ error: "note required" });
  const stamp = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const line = `[${stamp}] ${note}`;
  try {
    const [updated] = await db.execute(sql`
      UPDATE jobs
      SET notes = CASE WHEN notes IS NULL OR notes = '' THEN ${line} ELSE notes || E'\n' || ${line} END
      WHERE id = ${jobId} AND company_id = ${req.auth!.companyId}
      RETURNING notes
    `).then((r: any) => r.rows);
    if (!updated) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true, notes: (updated as any).notes });
  } catch (err) {
    console.error("Append job note error:", err);
    return res.status(500).json({ error: "Could not save note" });
  }
});

export { calculateTechPay };
export default router;
