import pg from "pg";

/**
 * Pre-push enum fix — run before drizzle-kit push during production builds.
 *
 * 1. If additional_pay.type is still typed as the additional_pay_type enum,
 *    convert it to plain text.
 * 2. If the additional_pay_type enum type still exists in the DB (and nothing
 *    depends on it), drop it so drizzle-kit push sees no enum to manage and
 *    never generates a DROP TYPE statement in its own diff.
 *
 * Why drop the enum here instead of letting drizzle do it:
 *   drizzle drops the enum AFTER altering the column, but Postgres refuses the
 *   DROP when other objects still depend on it (e.g. a column that was just
 *   altered is still tracked in the catalogue momentarily). Running the DROP
 *   in a separate transaction before drizzle-kit push avoids the race.
 *
 * The additionalPayTypeEnum pgEnum has been removed from the Drizzle schema so
 * drizzle will not try to recreate the enum after we drop it.
 *
 * Runtime migrations (phes-data-migration, norma-puga-migration) already guard
 * their ALTER TYPE calls with IF EXISTS checks, so they are safe.
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
    // Step A: convert column from enum → text if it is still an enum
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
          RAISE NOTICE 'pre-push-fix: additional_pay.type already text — step A skipped';
        END IF;
      END
      $$;
    `);

    // Step B: drop the enum type if it still exists and nothing depends on it
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'additional_pay_type') THEN
          DROP TYPE "public"."additional_pay_type";
          RAISE NOTICE 'pre-push-fix: dropped additional_pay_type enum';
        ELSE
          RAISE NOTICE 'pre-push-fix: additional_pay_type enum already gone — step B skipped';
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
