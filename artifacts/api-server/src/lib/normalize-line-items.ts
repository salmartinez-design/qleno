// [invoice-view-crash 2026-06-20] Pure coercion for invoice line_items.
//
// The invoice edit UI binds its qty/rate <input> fields straight to
// e.target.value, so the saved line_items arrive with `quantity` and
// `unit_price` as STRINGS ("2", "150"). Persisting those strings into the
// line_items jsonb is what crashed the invoice "View": the read render does
// `((item.unit_price ?? item.rate) || 0).toFixed(2)`, and a string has no
// .toFixed → TypeError → the app's ErrorBoundary shows "Something went wrong".
//
// Normalizing on write makes the stored shape always numeric, which protects
// EVERY reader of line_items (the View render, PDF generation, QuickBooks sync,
// recalc) — not just the one render path. Kept dependency-free so it is trivial
// to unit-test without a DB.
export type NormalizedLineItem = {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  [k: string]: unknown;
};

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

export function normalizeInvoiceLineItems(lineItems: unknown): NormalizedLineItem[] | undefined {
  if (!Array.isArray(lineItems)) return undefined;
  return lineItems.map((item: any) => ({
    ...item,
    description: item?.description ?? "",
    quantity: num(item?.quantity),
    // accept the legacy `rate` alias the older render falls back to
    unit_price: num(item?.unit_price ?? item?.rate),
    total: num(item?.total),
  }));
}
