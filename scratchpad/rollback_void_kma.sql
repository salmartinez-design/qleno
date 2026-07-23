-- Rollback for the 2026-07-22 KMA batch-duplicate void.
-- Restores status (and nothing else — nothing else was written).
BEGIN;
UPDATE invoices i SET status = s.status
  FROM invoice_void_snapshot_kma_20260722 s
 WHERE i.id = s.id AND i.id = ANY(ARRAY[964,966]::int[]);
-- verify: expect 7 rows back at 'sent'
SELECT id, invoice_number, status, total FROM invoices
 WHERE id = ANY(ARRAY[964,966]::int[]) ORDER BY id;
COMMIT;
