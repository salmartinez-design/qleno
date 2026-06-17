// [invoicing-engine 2026-06-16] Shared invoice-number allocator. Extracted from
// routes/invoices.ts so the per-visit auto-invoice engine, the office create
// route, and batch consolidation all mint numbers from ONE sequence.
//
// Decision (Sal, 2026-06-16): new invoices use the bare-integer sequence
// continuing from companies.invoice_sequence_start (Phes co1 = 6082, the
// MaidCentral/Square carryover). The legacy INV-YYYY-NNNN format is retired for
// NEW invoices — generateInvoiceNumber() stays only as a last-resort fallback
// label when a row somehow has no stored number (never written as the canonical
// value going forward).
import { db } from "@workspace/db";
import { companiesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

export function generateInvoiceNumber(id: number): string {
  const year = new Date().getFullYear();
  return `INV-${year}-${String(id).padStart(4, "0")}`;
}

// Next bare-integer invoice number for a company: max existing numeric number + 1,
// floored at the company's configured sequence start. Falls back to the legacy
// label only if the lookup throws.
export async function getNextInvoiceNumber(companyId: number, fallbackId: number): Promise<string> {
  try {
    const [company] = await db
      .select({ invoice_sequence_start: companiesTable.invoice_sequence_start })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);

    const seqStart = company?.invoice_sequence_start ?? 1;

    // db.execute returns a node-postgres QueryResult ({ rows: [...] }); read
    // .rows[0]. (The pre-refactor destructuring `const [maxRow] = ...` read the
    // QueryResult object itself, not a row — a latent bug that made maxNum always
    // 0, so the sequence floor silently fell back to seqStart every time.)
    const maxResult: any = await db.execute(
      sql`SELECT COALESCE(MAX(CAST(invoice_number AS INTEGER)), 0) as max_num
          FROM invoices
          WHERE company_id = ${companyId}
          AND invoice_number ~ '^[0-9]+$'`
    );
    const maxNum = parseInt(maxResult?.rows?.[0]?.max_num ?? "0") || 0;
    const next = Math.max(maxNum + 1, seqStart);
    return String(next);
  } catch {
    return generateInvoiceNumber(fallbackId);
  }
}
