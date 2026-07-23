// [job-ids-preserve 2026-07-23] A visit is linked to an invoice by TWO carriers:
// `invoices.job_id` (the per-visit document) and `line_items[].job_id` (the visit
// folded into a consolidated / batch account invoice). PR #1201 made the
// completion guard read both, which stopped a visit named on a batch from being
// re-billed as a second per-visit invoice.
//
// This closes the remaining hole, which is the EDIT path, not the server paths.
// Both generators already write one line per job carrying its own job_id
// (routes/accounts.ts generate-invoice, lib/invoice-cadence.ts). But
// `PUT /api/invoices/:id` accepts whatever line_items the edit UI sends, so when
// the office collapses four $210 job lines into one `quantity: 4` line, three
// job_ids are simply dropped on the floor. Those visits stay billed but unnamed,
// and every job-id-based guard reads them as "never invoiced" — which is how
// Halper's #985 ($840, 4 visits, ONE job_id) let jobs 15630/15631 re-mint into
// per-visit invoices that had to be voided as duplicates.
//
// The fix is a second, additive carrier: `job_ids: number[]` on a line item.
// Nothing is ever removed — `job_id` stays exactly where it was so every existing
// reader (View render, PDF, QB sync, recalc) is untouched. A collapse now keeps
// the orphaned ids instead of losing them, and the containment guards accept
// either shape.
//
// NOTE on `quantity`: it means two different things and must never be used to
// infer a visit count. On hourly commercial work it is HOURS for a single visit
// (National Able 8 x $50, PPM 3-8 x $45, residential Deep Clean 7.09 x $90 — the
// large majority of qty>1 lines). Only on a hand-collapsed monthly line is it a
// count of visits. The two are indistinguishable from `quantity` alone, which is
// exactly why the job ids have to be carried explicitly rather than derived.

/** Every job id a single line item names, via either carrier. */
export function lineItemJobIds(item: any): number[] {
  const out: number[] = [];
  const push = (v: unknown) => {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  };
  push(item?.job_id);
  if (Array.isArray(item?.job_ids)) item.job_ids.forEach(push);
  return out;
}

/** Every job id an invoice's line_items name, deduped, in first-seen order. */
export function collectJobIds(lineItems: unknown): number[] {
  if (!Array.isArray(lineItems)) return [];
  const seen: number[] = [];
  for (const item of lineItems) {
    for (const id of lineItemJobIds(item)) if (!seen.includes(id)) seen.push(id);
  }
  return seen;
}

/**
 * Carry forward any job id the incoming edit dropped.
 *
 * Called on every `PUT /api/invoices/:id` that rewrites line_items. Ids the
 * office genuinely removed a line for are still preserved — the invoice's TOTAL
 * is what the office is editing, and a billed-but-unnamed visit is the failure
 * we are preventing. Preserving is safe in the direction that matters: a
 * conservative "this visit is already billed" answer stops a duplicate, whereas
 * a lost id silently invites one.
 *
 * Orphans land on the first line, which on a collapse is the surviving
 * consolidated line — the line that is actually billing them.
 */
export function preserveJobIds(prevLineItems: unknown, nextLineItems: any[]): any[] {
  if (!Array.isArray(nextLineItems) || nextLineItems.length === 0) return nextLineItems;
  const before = collectJobIds(prevLineItems);
  if (before.length === 0) return nextLineItems;

  const after = new Set(collectJobIds(nextLineItems));
  const orphans = before.filter((id) => !after.has(id));
  if (orphans.length === 0) return nextLineItems;

  const [first, ...rest] = nextLineItems;
  const merged = lineItemJobIds(first);
  for (const id of orphans) if (!merged.includes(id)) merged.push(id);
  return [{ ...first, job_ids: merged }, ...rest];
}
