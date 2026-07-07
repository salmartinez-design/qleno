// [invoice-number-display 2026-07-07] Single canonical way to display an
// invoice number. Every surface (client profile, invoices list, invoice
// detail, global search, receivables report, account detail) MUST route
// through this — several screens used to fabricate their own label from the
// row id (INV-00684) while the document itself showed the real stored number
// (6134), so the same invoice wore different numbers around the app.
// Rule: show the stored invoice_number; the INV-<id> form is only a fallback
// for legacy rows that never got a number assigned.
export function formatInvoiceNumber(inv: { id: number; invoice_number?: string | null }): string {
  return inv.invoice_number || `INV-${String(inv.id).padStart(4, "0")}`;
}
