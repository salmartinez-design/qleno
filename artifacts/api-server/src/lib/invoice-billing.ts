// [batch-invoicing 2026-08-03] THE billing-coverage engine.
// Source of truth: docs/BATCH_INVOICING_DESIGN.md
//
// Before this file, "is this visit already invoiced?" was answered four
// different ways by four different engines (invoice-cadence's cron,
// batch-invoicing's route, /invoices/merge, and accounts' generate-invoice),
// and "combine these into one document" was implemented four times. They did
// not agree, they were not aware of each other, and the disagreement billed
// KMA twice in July and pushed the duplicates into QuickBooks.
//
// Everything about billing coverage now goes through here:
//   - which invoice currently carries a visit's money   → findLiveInvoiceForJob
//   - recording that an invoice covers visits           → setInvoiceCoverage
//   - combining several invoices into one document      → combineInvoices
//
// The rules this enforces (design §1):
//   R1  Nothing is ever lost. Combining NEVER destroys its members — they keep
//       their number, keep their total, stay visible. They become 'batched'.
//   R2  Exactly one document per dollar. At most one live invoice per visit,
//       enforced by a partial unique index on invoice_job_links, not by
//       convention. A writer that tries to double-bill gets a constraint
//       violation instead of quietly creating a duplicate.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getNextInvoiceNumber } from "./invoice-number.js";

// Drizzle's transaction handle. Callers pass `tx` inside db.transaction(); the
// helpers fall back to the pool when omitted so read paths stay ergonomic.
type Executor = { execute: (q: any) => Promise<any> };
const ex = (tx?: Executor): Executor => tx ?? (db as unknown as Executor);

// Drizzle's `sql` template does NOT bind a JS array as one array parameter — it
// spreads the elements into separate placeholders. So `= ANY(${ids}::int[])`
// emits `ANY(($2)::int[])` for one id (Postgres: malformed array literal: "9099")
// and `ANY(($2, $3)::int[])` for two (cannot cast type record to integer[]).
// BOTH throw — the pattern never works, at any length.
//
// That is what broke Heritage's "Consolidate 4" button on 2026-08-03: every
// per-visit invoice called setInvoiceCoverage with a single job, hit the
// one-element form, and the 500 surfaced as "Failed to generate invoice".
// Same trap already documented at routes/users.ts:189 and routes/sms.ts:379.
//
// Every id list in this file goes through here instead: a real parameterized IN
// list, one placeholder per value, values coerced to numbers so nothing but a
// number can reach the query. Callers all guard against empty lists; if one ever
// slips through, `IN (NULL)` matches nothing — which fails CLOSED in both
// directions (an empty NOT IN deletes nothing rather than everything).
const idList = (ids: Array<number | string>) => {
  const clean = ids.map(Number).filter((n) => Number.isFinite(n));
  if (!clean.length) return sql`NULL`;
  return sql.join(clean.map((n) => sql`${n}`), sql`, `);
};

export type CoveredJob = { job_id: number; amount?: string | number | null };

export type LiveInvoice = {
  id: number;
  invoice_number: string | null;
  status: string;
  total: string;
};

// Statuses that do NOT hold a visit's money. A voided invoice is a tombstone
// (design D-5): it records that the office deliberately un-billed the visit, so
// the completion engine must not regenerate it. 'batched' members are history,
// not receivables — the parent carries their dollars.
export const INERT_STATUSES = ["void", "superseded", "batched"] as const;

// ── Coverage reads ───────────────────────────────────────────────────────────

/**
 * THE dedup predicate (design D-3). The one and only answer to "does this visit
 * already have a live invoice?" — used by completion auto-invoicing, the
 * account Generate Invoice button, and the uninvoiced-jobs selector, so they can
 * never disagree again.
 *
 * Reads invoice_job_links, NOT `line_items @> {job_id}`. The jsonb probe is what
 * went blind on KMA #966, whose five line items carried no job_id at all.
 */
export async function findLiveInvoiceForJob(
  companyId: number,
  jobId: number,
  tx?: Executor,
): Promise<LiveInvoice | null> {
  const r: any = await ex(tx).execute(sql`
    SELECT i.id, i.invoice_number, i.status::text AS status, i.total
      FROM invoice_job_links l
      JOIN invoices i ON i.id = l.invoice_id
     WHERE l.company_id = ${companyId} AND l.job_id = ${jobId} AND l.is_live
     LIMIT 1`);
  return r.rows?.[0] ?? null;
}

/**
 * Everything the completion engine needs to decide whether to create an invoice.
 *
 * `voided` is the tombstone (design D-5): the office deliberately un-billed this
 * visit, so completion must NOT regenerate it. Today it does — `ne(status,
 * 'void')` — which is why voiding KMA's duplicate invoices 6342/6344/6349 on
 * Jul 22 produced 7112/7113/7114 the same day. Cleaning up duplicates created
 * duplicates. Re-billing a tombstoned visit is an explicit office action.
 */
export async function getVisitBillingState(
  companyId: number,
  jobId: number,
  tx?: Executor,
): Promise<{ live: LiveInvoice | null; voided: boolean }> {
  const r: any = await ex(tx).execute(sql`
    SELECT i.id, i.invoice_number, i.status::text AS status, i.total, l.is_live
      FROM invoice_job_links l
      JOIN invoices i ON i.id = l.invoice_id
     WHERE l.company_id = ${companyId} AND l.job_id = ${jobId}`);
  const rows = r.rows ?? [];
  return {
    live: rows.find((x: any) => x.is_live) ?? null,
    voided: rows.some((x: any) => x.status === "void"),
  };
}

/** Batch form of findLiveInvoiceForJob — one round trip for a job list. */
export async function findLiveInvoicesForJobs(
  companyId: number,
  jobIds: number[],
  tx?: Executor,
): Promise<Map<number, LiveInvoice>> {
  const out = new Map<number, LiveInvoice>();
  if (!jobIds.length) return out;
  const r: any = await ex(tx).execute(sql`
    SELECT l.job_id, i.id, i.invoice_number, i.status::text AS status, i.total
      FROM invoice_job_links l
      JOIN invoices i ON i.id = l.invoice_id
     WHERE l.company_id = ${companyId} AND l.is_live
       AND l.job_id IN (${idList(jobIds)})`);
  for (const row of r.rows ?? []) out.set(Number(row.job_id), row);
  return out;
}

// ── Coverage writes ──────────────────────────────────────────────────────────

/**
 * Record which visits an invoice covers (design D-4). EVERY path that creates or
 * re-lines an invoice must call this — it is what keeps the constraint
 * meaningful. `live: false` records coverage without claiming the money (a
 * batched member, or a draft that is deliberately not in A/R yet).
 *
 * Throws on a duplicate live claim. That is the point: the caller learns it was
 * about to double-bill instead of finding out at month end.
 */
export async function setInvoiceCoverage(
  tx: Executor,
  opts: { companyId: number; invoiceId: number; jobs: CoveredJob[]; live: boolean },
): Promise<void> {
  const { companyId, invoiceId, jobs, live } = opts;
  // Drop coverage this invoice no longer claims (line items edited away).
  const keep = jobs.map((j) => j.job_id);
  if (keep.length) {
    await tx.execute(sql`
      DELETE FROM invoice_job_links
       WHERE invoice_id = ${invoiceId} AND job_id NOT IN (${idList(keep)})`);
  } else {
    await tx.execute(sql`DELETE FROM invoice_job_links WHERE invoice_id = ${invoiceId}`);
    return;
  }
  for (const j of jobs) {
    const amt = j.amount == null ? null : String(j.amount);
    await tx.execute(sql`
      INSERT INTO invoice_job_links (company_id, invoice_id, job_id, amount, is_live)
      VALUES (${companyId}, ${invoiceId}, ${j.job_id}, ${amt}, ${live})
      ON CONFLICT (invoice_id, job_id)
      DO UPDATE SET amount = EXCLUDED.amount, is_live = EXCLUDED.is_live`);
  }
}

/**
 * Flip an invoice's whole coverage live or inert. Called when an invoice is
 * voided (releases its visits so they can be legitimately re-billed by an
 * explicit office action) and when a member is folded into a batch.
 */
export async function setCoverageLive(
  tx: Executor,
  companyId: number,
  invoiceId: number,
  live: boolean,
): Promise<void> {
  await tx.execute(sql`
    UPDATE invoice_job_links SET is_live = ${live}
     WHERE company_id = ${companyId} AND invoice_id = ${invoiceId}`);
}

// ── Terms ────────────────────────────────────────────────────────────────────

/**
 * Due date from payment terms (design D8). The bundle path used to set
 * due_date = issue date, so every KMA document said "Issued Jul 1 / Due Jul 1"
 * on a NET 30 account.
 */
export function dueDateFromTerms(terms: string | null | undefined, issued: Date): string {
  const days = (() => {
    if (!terms) return 0;
    const t = String(terms).toLowerCase();
    if (t.includes("receipt")) return 0;
    const m = t.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  })();
  const d = new Date(Date.UTC(issued.getUTCFullYear(), issued.getUTCMonth(), issued.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Per-visit documents ──────────────────────────────────────────────────────

/**
 * Get (or create) the per-visit invoice for a job — rule R1: every billable
 * visit has its own record, always.
 *
 * This is what lets the office's "select uninvoiced jobs and merge them" work
 * on the same rails as everything else. The account Generate Invoice button used
 * to build ONE document straight from the jobs table, bypassing the per-visit
 * invoices entirely — so completion later created per-visit invoices for work
 * the bundle had already billed. That is the duplicate pair that double-counted
 * revenue in QuickBooks. Now the visits get their documents first and the batch
 * is assembled FROM them.
 */
export async function ensurePerVisitInvoice(opts: {
  companyId: number;
  jobId: number;
  userId?: number | null;
  /** Re-bill a visit whose invoice was voided. Only ever set from an explicit office action. */
  force?: boolean;
  /**
   * [single-path 2026-08-05] Office-supplied overrides. These exist so the
   * manual create route (POST /api/invoices) can delegate here instead of
   * hand-rolling its own INSERT — which it did until now, writing no
   * invoice_job_links row and therefore bypassing BOTH the unique index (S-1)
   * and the integrity sweep's double-bill check. A duplicate created that way
   * was invisible to every safety net in the system.
   *
   * Nothing here changes the dedup or coverage behaviour; they only affect the
   * shape of the document once we've decided it may be created.
   */
  overrides?: {
    /** 'net_30' | 'net_15' | 'net_7' | 'due_on_receipt' — beats the customer default. */
    paymentTerms?: string | null;
    /** Issue straight into A/R instead of parking a draft. */
    issue?: boolean;
    poNumber?: string | null;
    billingContactName?: string | null;
    billingContactEmail?: string | null;
    tips?: number;
  };
}): Promise<{ invoiceId: number | null; created: boolean; reason?: string }> {
  const { companyId, jobId, userId = null, force = false, overrides = {} } = opts;
  const state = await getVisitBillingState(companyId, jobId);
  if (state.live) return { invoiceId: state.live.id, created: false, reason: "already_invoiced" };
  if (state.voided && !force) return { invoiceId: null, created: false, reason: "voided" };

  const jr: any = await db.execute(sql`
    SELECT j.id, j.client_id, j.account_id, j.status::text AS status, j.scheduled_date,
           j.non_billable, j.invoice_hold,
           COALESCE(a.payment_terms_days, c.payment_terms_days, 0) AS terms_days,
           cl.payment_terms::text AS client_terms
      FROM jobs j
      LEFT JOIN accounts a ON a.id = j.account_id
      LEFT JOIN clients cl ON cl.id = j.client_id
      LEFT JOIN companies c ON c.id = j.company_id
     WHERE j.id = ${jobId} AND j.company_id = ${companyId}
     LIMIT 1`);
  const job = jr.rows?.[0];
  if (!job) return { invoiceId: null, created: false, reason: "job_not_found" };
  if (job.status === "cancelled") return { invoiceId: null, created: false, reason: "cancelled" };
  if (job.non_billable) return { invoiceId: null, created: false, reason: "non_billable" };

  const { buildJobLineItems } = await import("./invoice-line-items.js");
  const built = await buildJobLineItems(companyId, jobId);
  const lines = (built?.lineItems ?? []).map((li: any) => ({ ...li, job_id: jobId }));
  const amount = built?.subtotal ?? 0;
  const tips = Number(overrides.tips ?? 0) || 0;
  const total = Math.round((amount + tips) * 100) / 100;

  // Terms precedence: explicit override → account/company days → the client's
  // own net terms. The last leg is why the route used to look up the client
  // itself; keep it so residential net_15/net_30 clients don't silently fall
  // back to due-on-receipt when the company default is 0.
  const termsDays = Number(job.terms_days ?? 0) || 0;
  const terms = overrides.paymentTerms
    || (termsDays === 30 ? "net_30" : termsDays === 15 ? "net_15" : termsDays === 7 ? "net_7" : null)
    || job.client_terms
    || "due_on_receipt";
  const sched = job.scheduled_date ? String(job.scheduled_date).slice(0, 10) : null;
  const status = overrides.issue ? "sent" : "draft";
  // [auto-issue 2026-07-08] sent_at stays NULL — every surface labels
  // sent-with-no-sent_at as ISSUED, never SENT. Emailing is a human action.
  // Only a draft is held for a cadence fold, so only a draft carries 'pending'.
  const batchStatus = overrides.issue ? null : "pending";

  return await db.transaction(async (tx: any) => {
    const ins: any = await tx.execute(sql`
      INSERT INTO invoices (company_id, job_id, client_id, account_id, status, line_items,
                            subtotal, tips, total, due_date, service_date, payment_terms,
                            batch_status, po_number, billing_contact_name, billing_contact_email,
                            created_by)
      VALUES (${companyId}, ${jobId}, ${job.client_id}, ${job.account_id}, ${status},
              ${JSON.stringify(lines)}::jsonb, ${amount.toFixed(2)}, ${tips.toFixed(2)},
              ${total.toFixed(2)},
              ${dueDateFromTerms(terms, sched ? new Date(`${sched}T00:00:00.000Z`) : new Date())},
              ${sched}, ${terms}, ${batchStatus}, ${overrides.poNumber ?? null},
              ${overrides.billingContactName ?? null}, ${overrides.billingContactEmail ?? null},
              ${userId})
      RETURNING id`);
    const invoiceId = Number(ins.rows[0].id);
    const number = await getNextInvoiceNumber(companyId, invoiceId);
    await tx.execute(sql`UPDATE invoices SET invoice_number = ${number} WHERE id = ${invoiceId}`);
    await setInvoiceCoverage(tx, {
      companyId, invoiceId, jobs: [{ job_id: jobId, amount: amount.toFixed(2) }], live: true,
    });
    return { invoiceId, created: true };
  });
}

// ── The one batch primitive ──────────────────────────────────────────────────

export type CombineResult = {
  parent_id: number;
  parent_number: string;
  total: string;
  member_ids: number[];
  covered_job_ids: number[];
};

/**
 * Combine several invoices into ONE document the customer pays (design D-6).
 * The office button, the cadence cron, and the manual merge all call this —
 * there is no second implementation.
 *
 * What it does NOT do, and this is the whole point: it does not zero its
 * members, does not mark them 'superseded', and does not hide them. They keep
 * their invoice number and their amount and become 'batched', pointing at the
 * parent. The old fold wrote `status='superseded', subtotal='0.00',
 * total='0.00'` and the list view hid superseded outright — that is what
 * "they disappeared" was.
 */
export async function combineInvoices(opts: {
  companyId: number;
  memberInvoiceIds: number[];
  actorUserId?: number | null;
  /** Overrides the terms inherited from the members' customer. */
  paymentTerms?: string | null;
  /** Defaults to today (UTC calendar date). */
  issuedOn?: string;
}): Promise<CombineResult> {
  const { companyId, memberInvoiceIds, actorUserId = null } = opts;
  const ids = [...new Set(memberInvoiceIds.map(Number))].filter((n) => Number.isFinite(n));
  if (ids.length < 2) throw new Error("Select at least two invoices to combine.");

  return await db.transaction(async (tx: any) => {
    // Lock the members so two operators combining at once can't interleave.
    const mres: any = await tx.execute(sql`
      SELECT id, company_id, client_id, account_id, status::text AS status,
             invoice_number, total, line_items, service_date, payment_terms,
             billing_contact_name, billing_contact_email, bill_to_name,
             po_number, branch_id, payment_source
        FROM invoices
       WHERE company_id = ${companyId} AND id IN (${idList(ids)})
       ORDER BY id
       FOR UPDATE`);
    const members: any[] = mres.rows ?? [];

    if (members.length !== ids.length) throw new Error("Some invoices were not found for this company.");

    // Guard rails — refuse rather than produce a document nobody can explain.
    for (const m of members) {
      if (m.status === "paid") throw new Error(`Invoice ${m.invoice_number ?? m.id} is already paid and can't be combined.`);
      if (m.status === "void") throw new Error(`Invoice ${m.invoice_number ?? m.id} is void.`);
      if (m.status === "batched" || m.status === "superseded") {
        throw new Error(`Invoice ${m.invoice_number ?? m.id} is already part of another invoice.`);
      }
    }
    const accountIds = new Set(members.map((m) => m.account_id ?? null));
    const clientIds = new Set(members.map((m) => m.client_id ?? null));
    if (accountIds.size > 1 || (accountIds.has(null) && clientIds.size > 1)) {
      throw new Error("All invoices must belong to the same customer.");
    }

    // Parent lines = every member's own lines, carrying job_id through so
    // coverage stays derivable from the document (design D-4).
    const lines: any[] = [];
    const covered: CoveredJob[] = [];
    let total = 0;
    for (const m of members) {
      const raw = Array.isArray(m.line_items) ? m.line_items : [];
      const memberLines = raw.length
        ? raw
        : [{ description: `Invoice ${m.invoice_number ?? m.id}`, quantity: 1, unit_price: m.total, total: m.total }];
      for (const li of memberLines) {
        lines.push({ ...li, source_invoice_id: m.id });
        const jid = Number(li?.job_id);
        if (Number.isFinite(jid)) covered.push({ job_id: jid, amount: li?.total ?? null });
      }
      total += Number(m.total ?? 0);
    }

    // Coverage the members' links already record — authoritative over the jsonb,
    // which is exactly the lesson of #966's id-less line items.
    const lres: any = await tx.execute(sql`
      SELECT DISTINCT job_id FROM invoice_job_links
       WHERE company_id = ${companyId} AND invoice_id IN (${idList(ids)})`);
    for (const row of lres.rows ?? []) {
      const jid = Number(row.job_id);
      if (!covered.some((c) => c.job_id === jid)) covered.push({ job_id: jid });
    }

    // Name every line by WHERE and WHEN the work happened. A combined invoice
    // whose lines read "Commercial Cleaning" five times is unreadable and
    // unverifiable — the client can't tell which building each charge is for,
    // and neither can the office. KMA's bundles printed exactly that.
    const jobIdsOnLines = [...new Set(lines.map((l) => Number(l.job_id)).filter((n) => Number.isFinite(n)))];
    if (jobIdsOnLines.length) {
      const jres: any = await tx.execute(sql`
        SELECT j.id, j.scheduled_date,
               COALESCE(p.property_name, NULLIF(TRIM(j.address_street), '')) AS place
          FROM jobs j
          LEFT JOIN account_properties p ON p.id = j.account_property_id
         WHERE j.company_id = ${companyId} AND j.id IN (${idList(jobIdsOnLines)})`);
      const info = new Map<number, any>();
      for (const r of jres.rows ?? []) info.set(Number(r.id), r);
      for (const l of lines) {
        const j = info.get(Number(l.job_id));
        if (!j) continue;
        const day = j.scheduled_date ? String(j.scheduled_date).slice(0, 10) : null;
        l.service_date = l.service_date ?? day;
        const label = day
          ? new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", {
              month: "short", day: "numeric", timeZone: "UTC",
            })
          : null;
        const parts = [j.place, label].filter(Boolean).join(" — ");
        if (parts) l.description = `${parts}${l.description ? ` · ${l.description}` : ""}`;
      }
    }

    // A visit on this batch that some OTHER invoice already claims would trip
    // the unique index with a raw Postgres error. Catch it here and name the
    // offending document — that conflict IS the KMA bug, and the office needs
    // to see which invoice to void, not a constraint string.
    if (covered.length) {
      const conflict: any = await tx.execute(sql`
        SELECT l.job_id, i.id, i.invoice_number
          FROM invoice_job_links l
          JOIN invoices i ON i.id = l.invoice_id
         WHERE l.company_id = ${companyId} AND l.is_live
           AND l.job_id IN (${idList(covered.map((c) => c.job_id))})
           AND l.invoice_id NOT IN (${idList(ids)})
         LIMIT 3`);
      if (conflict.rows?.length) {
        const which = conflict.rows
          .map((r: any) => `job ${r.job_id} is already on invoice ${r.invoice_number ?? r.id}`)
          .join("; ");
        throw new Error(`Can't combine — ${which}. Void the duplicate first.`);
      }
    }

    const first = members[0];
    const terms = opts.paymentTerms ?? first.payment_terms ?? "due_on_receipt";
    const issued = opts.issuedOn ? new Date(`${opts.issuedOn}T00:00:00.000Z`) : new Date();
    const issuedIso = issued.toISOString().slice(0, 10);
    // Service date = the LAST visit on the document. The old bundle path left it
    // null, which is why two of KMA's three PDFs printed "Service —".
    const serviceDates = members.map((m) => m.service_date).filter(Boolean).sort();
    const serviceDate = serviceDates.length ? serviceDates[serviceDates.length - 1] : issuedIso;

    // Numbering comes from the ONE sequence (design D9). The old account bundle
    // minted `ACC-5-1783100316269` — a raw epoch nobody can search or quote.
    const number = await getNextInvoiceNumber(companyId, 0);

    const pres: any = await tx.execute(sql`
      INSERT INTO invoices (
        company_id, client_id, account_id, invoice_number, status, line_items,
        subtotal, total, due_date, service_date, payment_terms, batch_status,
        billing_contact_name, billing_contact_email, bill_to_name, po_number,
        branch_id, payment_source, created_by)
      VALUES (
        ${companyId}, ${first.client_id}, ${first.account_id}, ${number}, 'sent',
        ${JSON.stringify(lines)}::jsonb, ${total.toFixed(2)}, ${total.toFixed(2)},
        ${dueDateFromTerms(terms, issued)}, ${serviceDate}, ${terms}, 'batch_parent',
        ${first.billing_contact_name}, ${first.billing_contact_email},
        ${first.bill_to_name}, ${first.po_number}, ${first.branch_id},
        ${first.payment_source}, ${actorUserId})
      RETURNING id`);
    const parentId = Number(pres.rows[0].id);

    // Members keep their totals and numbers (R1). Only their STATUS changes.
    await tx.execute(sql`
      UPDATE invoices
         SET status = 'batched', parent_invoice_id = ${parentId}, batch_status = 'batched'
       WHERE company_id = ${companyId} AND id IN (${idList(ids)})`);

    // Hand the money over: members go inert, then the parent claims the visits.
    // Order matters — the unique index would reject the parent's claim while a
    // member still held it, which is precisely the protection we want.
    await tx.execute(sql`
      UPDATE invoice_job_links SET is_live = FALSE
       WHERE company_id = ${companyId} AND invoice_id IN (${idList(ids)})`);
    await setInvoiceCoverage(tx, { companyId, invoiceId: parentId, jobs: covered, live: true });

    return {
      parent_id: parentId,
      parent_number: number,
      total: total.toFixed(2),
      member_ids: ids,
      covered_job_ids: covered.map((c) => c.job_id),
    };
  });
}

/**
 * Undo a combine. The members come back exactly as they were — which is only
 * possible because combining never destroyed them.
 */
export async function splitBatchInvoice(companyId: number, parentId: number): Promise<{ member_ids: number[] }> {
  return await db.transaction(async (tx: any) => {
    const p: any = await tx.execute(sql`
      SELECT id, status::text AS status FROM invoices
       WHERE company_id = ${companyId} AND id = ${parentId} FOR UPDATE`);
    const parent = p.rows?.[0];
    if (!parent) throw new Error("Invoice not found.");
    if (parent.status === "paid") throw new Error("This invoice is paid — split it before recording payment.");

    const m: any = await tx.execute(sql`
      SELECT id FROM invoices
       WHERE company_id = ${companyId} AND parent_invoice_id = ${parentId} AND status::text = 'batched'`);
    const memberIds = (m.rows ?? []).map((r: any) => Number(r.id));
    if (!memberIds.length) throw new Error("This invoice has no combined members.");

    await tx.execute(sql`DELETE FROM invoice_job_links WHERE invoice_id = ${parentId}`);
    await tx.execute(sql`
      UPDATE invoices SET status = 'sent', parent_invoice_id = NULL, batch_status = NULL
       WHERE company_id = ${companyId} AND id IN (${idList(memberIds)})`);
    await tx.execute(sql`
      UPDATE invoice_job_links SET is_live = TRUE
       WHERE company_id = ${companyId} AND invoice_id IN (${idList(memberIds)})`);
    await tx.execute(sql`
      UPDATE invoices SET status = 'void', batch_status = NULL
       WHERE company_id = ${companyId} AND id = ${parentId}`);

    return { member_ids: memberIds };
  });
}

/**
 * Payment on a combined invoice cascades to its members, so per-job revenue
 * reporting stays right without the parent's total being counted twice
 * (the members are excluded from A/R by their 'batched' status).
 */
export async function cascadeBatchPayment(
  tx: Executor,
  companyId: number,
  parentId: number,
  paidAt: Date | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE invoices SET paid_at = ${paidAt}
     WHERE company_id = ${companyId} AND parent_invoice_id = ${parentId} AND status::text = 'batched'`);
}
