// [cadence 2026-07-22] Period-close for bundled ACCOUNT invoicing.
//
// The rule Sal set: no completed job is ever left sitting as a draft, and
// issuing is NOT gated on payment. What differs per account is only the SHAPE
// of the document:
// [issue-on-completion 2026-08-03] ensure-invoice now ISSUES a real invoice for
// every completed priced visit, on EVERY cadence — the bundled accounts no
// longer sit on unbilled drafts waiting for a close that might never come. So
// what a cadence controls is only the document the customer is handed:
//   per_job  (PPM, Meg Daday, the condo assocs, all residential)
//       → the per-visit invoice IS the document. Nothing here.
//   weekly   (National Able)
//       → each Mon–Fri visit is issued as it completes; the Friday close folds
//         the week into ONE invoice and emails the billing contact.
//   monthly  (Cucci, KMA, Daveco, ProManage, Jennifer Halper)
//       → each visit is issued as it completes; the period-end close folds the
//         month into ONE invoice. No email (matches the #1174 default —
//         emailing an account invoice stays a deliberate human action).
// Folding moves each member to 'batched', so the money is on the bundle and
// counted exactly once. If a close never runs, the work is still billed as
// per-visit invoices — the failure mode is a messier bill, not a missed one.
//   custom   → treated as monthly. The only custom cadence in use is a
//              month-end bundle; a real per-account calendar can come later.
//
// WHY fold per-visit drafts instead of building one invoice from jobs:
//   Every visit already carries its OWN locked pricing (hours, add-ons,
//   parking, discounts). Folding sums documents that were priced when the work
//   happened; rebuilding from jobs at period end would silently re-price a
//   month-old visit against today's rates. Same reasoning as the residential
//   batch_invoice merge in routes/batch-invoicing.ts — this is the ACCOUNT-keyed
//   sibling of that flow (that one keys on client_id and pushes to QuickBooks).
//
// NEVER pushes to QuickBooks. Account invoices are AR inside Qleno only (Sal:
// "no pushing" — #1174), so a bundled account invoice never reaches QB either.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { combineInvoices } from "./invoice-billing.js";

export type Cadence = "per_job" | "weekly" | "monthly" | "custom";
export type BundleCadence = "weekly" | "monthly";

// A cadence that bundles. per_job issues per visit and never reaches the close.
export function isBundled(freq: string | null | undefined): boolean {
  return freq === "weekly" || freq === "monthly" || freq === "custom";
}
export function bundleCadence(freq: string | null | undefined): BundleCadence {
  return freq === "weekly" ? "weekly" : "monthly";
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (ymd: string) => new Date(`${ymd.slice(0, 10)}T00:00:00.000Z`);

// All window math is on UTC calendar dates because jobs.scheduled_date is a
// DATE — using local time would drift a day for anyone west of UTC and put a
// Friday visit in the wrong week.
export type Window = { start: string; end: string; label: string; close_date: string };

// The billing window CONTAINING `anchor`.
//   weekly  = Monday..Friday (Sal: "bundle Mon–Fri, auto-issue Friday"). This is
//             deliberately NOT the Sun..Sat window the residential batch flow
//             uses — a weekend visit for a weekday-only commercial account is
//             an exception the office should see, not something silently rolled
//             into a week. A Sat/Sun visit stays a pending draft and shows up
//             in the "held" list rather than being billed in the wrong week.
//   monthly = 1st..last of the anchor's month.
export function windowFor(cadence: BundleCadence, anchorYmd: string): Window {
  const anchor = utc(anchorYmd);
  if (cadence === "weekly") {
    const dow = anchor.getUTCDay(); // 0=Sun..6=Sat
    // Monday of this week. Sunday (0) belongs to the week that just ENDED, so
    // it walks back 6 days, not forward.
    const back = dow === 0 ? 6 : dow - 1;
    const start = new Date(anchor); start.setUTCDate(anchor.getUTCDate() - back);
    const end = new Date(start); end.setUTCDate(start.getUTCDate() + 4); // Friday
    return { start: iso(start), end: iso(end), label: `Week of ${iso(start)}`, close_date: iso(end) };
  }
  const y = anchor.getUTCFullYear(), m = anchor.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  return { start: iso(start), end: iso(end), label: `${y}-${String(m + 1).padStart(2, "0")}`, close_date: iso(end) };
}

// The most recent window that has FULLY ELAPSED as of `asOf` — the one a close
// run should bill. Running on Friday closes that Friday's week (the window ends
// today); running mid-week closes last week.
export function windowToClose(cadence: BundleCadence, asOf: string): Window {
  const w = windowFor(cadence, asOf);
  if (asOf >= w.close_date) return w;
  const prev = utc(w.start);
  prev.setUTCDate(prev.getUTCDate() - 1); // step into the previous window
  return windowFor(cadence, iso(prev));
}

// Every FULLY-ELAPSED window overlapping [from, to]. The nightly cron only ever
// needs the latest one, but a backfill has to walk them all — National Able's
// July has three closed weeks in it, and closing only the most recent would
// leave the earlier two sitting as drafts forever.
export function windowsBetween(cadence: BundleCadence, from: string, to: string): Window[] {
  const out: Window[] = [];
  let cursor = windowFor(cadence, from);
  // Guard the loop on window count, not on dates alone, so a malformed range
  // can never spin: 520 weeks / months is ~10 years, far past any real backfill.
  for (let i = 0; i < 520; i++) {
    if (cursor.start > to) break;
    // Only a window whose close date has passed is billable.
    if (cursor.close_date <= to) out.push(cursor);
    const next = utc(cursor.end);
    next.setUTCDate(next.getUTCDate() + (cadence === "weekly" ? 3 : 1)); // Fri→Mon, or last→1st
    cursor = windowFor(cadence, iso(next));
  }
  return out;
}

export type CloseResult = {
  account_id: number;
  account_name: string;
  cadence: BundleCadence;
  window: string;
  period_start: string;
  period_end: string;
  status: "closed" | "already_closed" | "nothing_to_bill" | "held_unpriced" | "error";
  parent_invoice_id: number | null;
  parent_invoice_number: string | null;
  visit_count: number;
  total: number;
  emailed: boolean;
  email_reason: string | null;
  // Visits inside the window that could NOT be billed because they are still
  // $0 — an unset rate. Surfaced, never silently issued at $0.
  unpriced_invoice_ids: number[];
  message: string | null;
};

// Close ONE account's window: fold every pending per-visit draft whose SERVICE
// DATE falls inside it into the earliest visit's invoice.
//
// Idempotent per (account, window): once a child in the window is 'superseded',
// the window is closed and a re-run is a no-op. Safe to run daily.
export async function closeAccountWindow(opts: {
  companyId: number;
  accountId: number;
  cadence: BundleCadence;
  window: Window;
  dryRun?: boolean;
  email?: boolean;
  userId?: number | null;
}): Promise<CloseResult> {
  const { companyId, accountId, cadence, window: win, dryRun = false, email = false, userId = null } = opts;

  const acctRow = await db.execute(sql`SELECT account_name FROM accounts WHERE id = ${accountId} AND company_id = ${companyId} LIMIT 1`);
  const accountName = ((acctRow as any).rows[0]?.account_name as string) ?? `account#${accountId}`;
  const base: CloseResult = {
    account_id: accountId, account_name: accountName, cadence, window: win.label,
    period_start: win.start, period_end: win.end, status: "nothing_to_bill",
    parent_invoice_id: null, parent_invoice_number: null, visit_count: 0, total: 0,
    emailed: false, email_reason: null, unpriced_invoice_ids: [], message: null,
  };

  try {
    // [batch-invoicing 2026-08-03] The old guard here read "any SUPERSEDED child
    // inside the window means this window is closed." `POST /invoices/merge`
    // also wrote 'superseded', so one manual merge on Jul 29 permanently
    // convinced this function that KMA's July was closed — the month could
    // never bundle again (design D4). The guard now looks only at 'batched'
    // members, the status this engine itself writes, AND only reports rather
    // than blocks: anything still pending gets billed regardless, so a partial
    // manual merge can no longer strand the rest of the month.
    const pend = await db.execute(sql`
      SELECT i.id, i.invoice_number, i.total, i.job_id, j.scheduled_date
        FROM invoices i
        JOIN jobs j ON j.id = i.job_id
       WHERE i.company_id = ${companyId} AND i.account_id = ${accountId}
         AND (
              -- [issue-on-completion 2026-08-03] The normal case now: the visit
              -- already has a REAL issued invoice, and the close reshapes the
              -- window into one document the customer receives. Folding issued
              -- invoices is safe because combineInvoices() moves each member to
              -- 'batched' — the dollars sit on the bundle, counted once.
              (i.status::text = 'sent' AND COALESCE(i.batch_status, '') NOT IN ('batch_parent', 'consolidated'))
              -- Still-pending drafts: an unpriced visit that has since been
              -- given a rate, plus every row written before issue-on-completion.
              -- Kept so the backlog closes out instead of stranding.
           OR (i.status::text = 'draft' AND i.batch_status = 'pending')
         )
         -- A member of an existing bundle is already billed on its parent.
         AND i.parent_invoice_id IS NULL
         -- Never fold a document the customer already has: replacing an emailed
         -- $420 bill with a bundle they never asked about is not a correction.
         AND i.sent_at IS NULL
         AND j.scheduled_date >= ${win.start} AND j.scheduled_date <= ${win.end}
       ORDER BY j.scheduled_date ASC, i.id ASC`);
    const all = (pend as any).rows as any[];
    if (!all.length) {
      const prior = await db.execute(sql`
        SELECT i.id FROM invoices i
          JOIN jobs j ON j.id = i.job_id
         WHERE i.company_id = ${companyId} AND i.account_id = ${accountId}
           AND i.status::text = 'batched'
           AND j.scheduled_date >= ${win.start} AND j.scheduled_date <= ${win.end}
         LIMIT 1`);
      if ((prior as any).rows.length) {
        return { ...base, status: "already_closed", message: `${win.label} is already closed for ${accountName}` };
      }
      return base;
    }

    // A $0 visit is an UNSET RATE, not a free clean. Bundling it would bury the
    // problem inside a big invoice, so it is left pending and reported instead.
    const priced = all.filter(r => parseFloat(r.total || "0") > 0);
    const unpriced = all.filter(r => parseFloat(r.total || "0") <= 0);
    if (!priced.length) {
      return { ...base, status: "held_unpriced", unpriced_invoice_ids: unpriced.map(u => u.id),
        message: `${unpriced.length} visit(s) in ${win.label} are still $0 — set the rate, then re-run the close` };
    }

    const total = Math.round(priced.reduce((s, r) => s + parseFloat(r.total || "0"), 0) * 100) / 100;

    if (dryRun) {
      return { ...base, status: "closed", parent_invoice_id: null,
        parent_invoice_number: null, visit_count: priced.length, total,
        unpriced_invoice_ids: unpriced.map(u => u.id),
        message: `DRY RUN — would combine ${priced.length} visit(s) into one invoice, nothing written` };
    }

    // Net terms come from the account, so a net-30 account keeps net-30 on the
    // bundle rather than being flipped to due-on-receipt by the merge (the
    // residential batch flow hardcodes due-on-receipt; accounts must not).
    const termsRow = await db.execute(sql`SELECT payment_terms_days FROM accounts WHERE id = ${accountId} AND company_id = ${companyId} LIMIT 1`);
    const termsDays = Number((termsRow as any).rows[0]?.payment_terms_days ?? 0) || 0;
    const due = utc(win.end); due.setUTCDate(due.getUTCDate() + termsDays);
    const termsLabel = termsDays === 30 ? "net_30" : termsDays === 15 ? "net_15" : termsDays === 7 ? "net_7" : "due_on_receipt";

    // [batch-invoicing 2026-08-03] The fold is no longer implemented here. It
    // calls the ONE combine primitive (design S-2), the same one the office
    // button and the manual merge use, so the three can't drift apart again.
    //
    // What that changes for the customer: members keep their number and their
    // amount and stay on screen as 'batched'. The old code overwrote the
    // earliest visit's invoice in place and set every other one to
    // `status='superseded', total='0.00'` — and the list view hides superseded.
    // That is the literal mechanism behind Maribel's "they disappeared."
    let parentId: number;
    let parentNumber: string | null;
    if (priced.length === 1) {
      // One visit in the window is not a batch. Issue the visit's own invoice
      // rather than wrapping a single line in a parent document.
      const only = priced[0];
      await db.execute(sql`
        UPDATE invoices SET status = 'sent', batch_status = 'consolidated',
               due_date = ${iso(due)}, payment_terms = ${termsLabel},
               service_date = COALESCE(service_date, ${only.scheduled_date ? String(only.scheduled_date).slice(0, 10) : win.end})
         WHERE id = ${only.id} AND company_id = ${companyId}`);
      parentId = only.id;
      parentNumber = only.invoice_number ?? null;
    } else {
      const combined = await combineInvoices({
        companyId,
        memberInvoiceIds: priced.map(r => r.id),
        actorUserId: userId,
        paymentTerms: termsLabel,
        issuedOn: win.end,
      });
      parentId = combined.parent_id;
      parentNumber = combined.parent_number;
    }

    const out: CloseResult = { ...base, status: "closed", parent_invoice_id: parentId,
      parent_invoice_number: parentNumber, visit_count: priced.length, total,
      unpriced_invoice_ids: unpriced.map(u => u.id), message: null };

    // Weekly accounts get the bundle emailed to the billing contact (Sal:
    // "auto-issue Friday + email the contact"). Monthly bundles are issued
    // silently — emailing those stays a human action, same as #1174.
    if (email) {
      const sent = await emailAccountInvoice(companyId, parentId, accountId, userId);
      out.emailed = sent.sent;
      out.email_reason = sent.reason;
    }
    return out;
  } catch (err: any) {
    console.error("[invoice-cadence] close error (non-fatal):", err?.message ?? err);
    return { ...base, status: "error", message: err?.message ?? "close failed" };
  }
}

// Email a bundled ACCOUNT invoice to its billing contact. Mirrors the recipient
// chain in POST /api/invoices/:id/send (invoice override → account contact
// flagged receives_invoices) and, like it, logs the attempt either way so a
// suppressed send is visible instead of silent. Never throws.
async function emailAccountInvoice(
  companyId: number, invoiceId: number, accountId: number, userId: number | null,
): Promise<{ sent: boolean; reason: string | null }> {
  try {
    const invRow = await db.execute(sql`
      SELECT invoice_number, total, due_date, billing_contact_name, billing_contact_email
        FROM invoices WHERE id = ${invoiceId} AND company_id = ${companyId} LIMIT 1`);
    const inv = (invRow as any).rows[0];
    if (!inv) return { sent: false, reason: "invoice_not_found" };

    let toEmail: string | null = inv.billing_contact_email || null;
    let toName: string | null = inv.billing_contact_name || null;
    if (!toEmail) {
      const ac = await db.execute(sql`
        SELECT name, email FROM account_contacts
         WHERE account_id = ${accountId} AND company_id = ${companyId} AND email IS NOT NULL AND email <> ''
         ORDER BY receives_invoices DESC, (role = 'billing') DESC, is_primary DESC, id ASC LIMIT 1`);
      const row = (ac as any).rows[0];
      if (row?.email) { toEmail = row.email; toName = toName || row.name || null; }
    }
    if (!toEmail) return { sent: false, reason: "no_billing_email_on_file" };

    const invNum = inv.invoice_number || `INV-${invoiceId}`;

    // [account-invoice-email 2026-08-09] invoice_link and service_address used to
    // be hardcoded "" here. That was invisible while the tenant sat on the legacy
    // plaintext template, which referenced neither tag — but the designed invoice
    // email SHOWS an Address row and a pay button, so an empty pair would have
    // shipped a blank address and a dead button the moment the template landed.
    //  - Address: the account's own property, canonical "street, city, ST zip"
    //    (CLAUDE.md: if an address is shown, zip MUST be shown). Left blank on a
    //    multi-property account on purpose — one line would misrepresent an
    //    invoice spanning several buildings, and the line-item table already
    //    names the site per visit. Same rule as sendOneInvoice.
    //  - Pay button: deliberately suppressed. payment_links.client_id is NOT
    //    NULL and every account invoice has a null client_id, so no valid pay
    //    token can exist; a button would 404. Account invoices bill on terms and
    //    carry the PDF.
    const fmtAddr = (street?: string | null, city?: string | null, state?: string | null, zip?: string | null): string => {
      const head = [street, city].map((p) => (p || "").trim()).filter(Boolean).join(", ");
      const tail = [state, zip].map((p) => (p || "").trim()).filter(Boolean).join(" ");
      return [head, tail].filter(Boolean).join(", ");
    };
    let serviceAddress = "";
    try {
      const props = await db.execute(sql`
        SELECT address, city, state, zip FROM account_properties
         WHERE account_id = ${accountId} AND company_id = ${companyId} AND is_active = true
         LIMIT 2`);
      if ((props as any).rows.length === 1) {
        const p = (props as any).rows[0];
        serviceAddress = fmtAddr(p.address, p.city, p.state, p.zip);
      }
    } catch { /* address is decoration — never block a billing email */ }

    // Per-visit work table, same renderer the manual send uses, so a bundled
    // account invoice reads identically to a hand-sent one.
    let linesHtml = "";
    try {
      const { renderInvoiceLinesHtml } = await import("../routes/invoices.js");
      linesHtml = await renderInvoiceLinesHtml(companyId, invoiceId);
    } catch { linesHtml = ""; }

    const mergeVars = {
      first_name: toName || "",
      invoice_number: invNum,
      invoice_amount: parseFloat(inv.total || "0").toFixed(2),
      invoice_due_date: inv.due_date
        ? utc(String(inv.due_date)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
        : "upon receipt",
      invoice_link: "",
      invoice_cta_html: "",
      service_address: serviceAddress,
      invoice_lines_html: linesHtml,
    };

    // PDF attach reuses the exact renderer the manual send uses, so a bundled
    // invoice looks identical to a hand-sent one. Dynamic import keeps the
    // routes → lib direction from becoming a cycle. Best-effort.
    let attachments: any[] | undefined;
    try {
      const { buildInvoicePdfBuffer } = await import("../routes/invoices.js");
      const pdf = await buildInvoicePdfBuffer(companyId, invoiceId);
      if (pdf) attachments = [{ filename: pdf.filename, content: pdf.buffer }];
    } catch { attachments = undefined; }

    const { sendNotification } = await import("../services/notificationService.js");
    const sent = await sendNotification(
      "invoice_sent", "email", companyId, toEmail, null, mergeVars, false, undefined, null, attachments,
    ).catch(() => false);

    // sendNotification honours COMMS_ENABLED and the per-company gate; when it
    // suppresses, the reason is in notification_log — read it back so the close
    // report says "suppressed — company_comms_disabled" instead of just false.
    let reason: string | null = null;
    if (!sent) {
      try {
        const nl = await db.execute(sql`
          SELECT status, error_message FROM notification_log
           WHERE company_id = ${companyId} AND trigger = 'invoice_sent' ORDER BY id DESC LIMIT 1`);
        const r = (nl as any).rows[0];
        reason = r?.error_message || r?.status || null;
      } catch { /* reason stays null */ }
    } else {
      await db.execute(sql`UPDATE invoices SET sent_at = now() WHERE id = ${invoiceId} AND company_id = ${companyId}`);
    }

    try {
      await db.execute(sql`
        INSERT INTO communication_log (company_id, customer_id, account_id, job_id, direction, channel, summary, subject, recipient, delivery_status, source, logged_by)
        VALUES (${companyId}, NULL, ${accountId}, NULL, 'outbound', 'email',
                ${sent ? `Invoice ${invNum} emailed (weekly bundle)` : `Invoice ${invNum} email NOT sent (weekly bundle)${reason ? ` — ${reason}` : ""}`},
                ${`Invoice ${invNum}`}, ${toEmail}, ${sent ? "sent" : "suppressed"}, 'system', ${userId})`);
    } catch (e: any) { console.error("[invoice-cadence] comm-log non-fatal:", e?.message); }

    return { sent, reason };
  } catch (err: any) {
    return { sent: false, reason: err?.message ?? "email_failed" };
  }
}

// Run the close for EVERY bundled account of a company.
//
// `force` ignores the close-day check and bills the last fully-elapsed window —
// what the July backfill needs. Without it, weekly accounts only close on their
// Friday and monthly accounts only on/after the last day of the month, so a
// daily cron is a no-op on every other day.
export async function runInvoiceCadenceClose(opts: {
  companyId: number;
  asOf?: string;
  dryRun?: boolean;
  force?: boolean;
  accountId?: number;
  userId?: number | null;
}): Promise<{ as_of: string; dry_run: boolean; results: CloseResult[] }> {
  const asOf = opts.asOf ?? iso(new Date());
  const dryRun = opts.dryRun ?? false;

  const rows = await db.execute(sql`
    SELECT id, account_name, invoice_frequency FROM accounts
     WHERE company_id = ${opts.companyId} AND is_active = true
       AND invoice_frequency IN ('weekly','monthly','custom')
       ${opts.accountId ? sql`AND id = ${opts.accountId}` : sql``}
     ORDER BY id`);

  const results: CloseResult[] = [];
  for (const a of (rows as any).rows as any[]) {
    const cadence = bundleCadence(a.invoice_frequency);
    const win = windowToClose(cadence, asOf);
    // Only bill a window that has actually ended, unless forced.
    if (!opts.force && asOf < win.close_date) continue;
    results.push(await closeAccountWindow({
      companyId: opts.companyId, accountId: a.id, cadence, window: win,
      dryRun, email: cadence === "weekly", userId: opts.userId ?? null,
    }));
  }
  return { as_of: asOf, dry_run: dryRun, results };
}

// Nightly entry point (5 AM CT, from the index.ts tick). Runs the close for
// every tenant that has bundled accounts. Deliberately NOT forced: a weekly
// account only closes on its Friday, a monthly one only once the month has
// ended, so this is a cheap no-op on every other day. Idempotent, so a
// redeploy or a double-fire can't bill a window twice.
export async function runInvoiceCadenceCron(asOf?: string): Promise<{ companies: number; closed: number; emailed: number }> {
  const day = asOf ?? iso(new Date());
  let closed = 0, emailed = 0, companies = 0;
  try {
    const cos = await db.execute(sql`
      SELECT DISTINCT company_id FROM accounts
       WHERE is_active = true AND invoice_frequency IN ('weekly','monthly','custom')`);
    for (const row of (cos as any).rows as any[]) {
      companies++;
      const out = await runInvoiceCadenceClose({ companyId: row.company_id, asOf: day });
      for (const r of out.results) {
        if (r.status === "closed") closed++;
        if (r.emailed) emailed++;
        if (r.status === "held_unpriced") {
          console.warn(`[invoice-cadence] ${r.account_name} ${r.window}: ${r.unpriced_invoice_ids.length} unpriced visit(s) held — rate not set`);
        }
      }
    }
  } catch (err: any) {
    console.error("[invoice-cadence] cron error (non-fatal):", err?.message ?? err);
  }
  return { companies, closed, emailed };
}
