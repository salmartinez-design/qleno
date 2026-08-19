# Ares → Qleno migration — how to run it

Everything the script needs is in this folder. You supply only DATABASE_URL.

    cd ~/Desktop/qleno-fixes/artifacts/api-server
    export DATABASE_URL='<from Railway → Variables>'

## 0. Create the 11 tables the module needs — REQUIRED FIRST

Do NOT use `drizzle-kit push`. The live DB has 212 tables; the Drizzle schema
defines 153, so push asks "created, or renamed from one of these 59?" for every
missing table — and a wrong pick renames a live production table out of
existence. Use this instead. It executes exactly the statements in
`lib/db/migrations/2026-08-19-ares-tables-create-only.sql` and refuses to run
if that file contains a drop, truncate, delete or rename.

    npx tsx ares-migration/apply-ares-tables.ts            # dry run — lists the 30 statements
    npx tsx ares-migration/apply-ares-tables.ts --commit   # apply
    npx tsx ares-migration/check-schema.ts                 # expect 15/15 present

Idempotent — safe to re-run.

## 1. Dry run — writes NOTHING

    npx tsx src/ares-data-migration.ts \
      --file ares-migration/ares-export.sql \
      --company 1 \
      --create-missing ares-migration/new-clients.csv \
      --report ares-migration/matches.csv

Prints: every client it WOULD create, the match report, and how much MRR is
covered. Check `ares-migration/matches.csv` — anything marked WEAK or NONE was
not linked; set `qleno_client_id` by hand if you disagree with it.

## 2. Commit — add --commit and --matches

    npx tsx src/ares-data-migration.ts \
      --file ares-migration/ares-export.sql \
      --company 1 \
      --create-missing ares-migration/new-clients.csv \
      --matches ares-migration/matches.csv \
      --commit

Ends with a parity check. Target, from Ares' own dashboard:

    active 108 · lost 28 · MRR $36,884.97

If those three don't reproduce, the import is wrong — don't accept it.

## Notes
- `--company 1` assumes Phes is company 1. Check first:
  `SELECT id, name FROM companies;`
- Re-running is safe: client creation matches on email / last-10 of phone /
  name before inserting. The subscription insert is NOT idempotent, so do not
  run `--commit` twice without clearing `recurring_subscriptions` first.
- 7 plaintext payment card numbers were found in the Ares notes. They are
  stripped from new-clients.csv and scrubbed by the importer. They still exist
  in Ares and in ares-export.sql — delete that file when you're done.
