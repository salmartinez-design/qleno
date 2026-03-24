import pg from "pg";

/**
 * Pre-push enum fix — run before drizzle-kit push during production builds.
 *
 * If additional_pay.type is still typed as the additional_pay_type enum in
 * the target database, this converts it to plain text BEFORE drizzle-kit push
 * runs. Drizzle then sees the column already matches the schema (text) and
 * generates no diff — preventing the DROP TYPE error that occurs when drizzle
 * tries to drop an enum that still has dependent columns.
 *
 * The enum type itself is intentionally preserved in the database because:
 *   - phes-data-migration.ts and norma-puga-migration.ts ALTER TYPE it at runtime
 *   - additionalPayTypeEnum is declared in the Drizzle schema so drizzle manages it
 *   - Once the column is already text, drizzle generates no diff → no DROP
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("pre-push-fix: no DATABASE_URL — skipping");
    return;
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name   = 'additional_pay'
            AND column_name  = 'type'
            AND udt_name     = 'additional_pay_type'
        ) THEN
          ALTER TABLE additional_pay ALTER COLUMN type TYPE text USING type::text;
          RAISE NOTICE 'pre-push-fix: converted additional_pay.type → text';
        ELSE
          RAISE NOTICE 'pre-push-fix: additional_pay.type already text — nothing to do';
        END IF;
      END
      $$;
    `);
    console.log("pre-push-fix: done");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.warn("pre-push-fix: failed (non-fatal):", err.message);
  process.exit(0); // non-fatal — let drizzle push still attempt
});
