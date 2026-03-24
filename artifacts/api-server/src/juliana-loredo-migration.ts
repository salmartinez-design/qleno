import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function runJulianaLoredoMigration() {
  console.log("=== Juliana Loredo Migration ===");
  const EMPLOYEE_ID = 42;
  const COMPANY_ID = 1;

  // ── 0. Schema additions ────────────────────────────────────────────────────
  console.log("Step 0: Schema additions...");

  // Add technician_note to contact_ticket_type enum
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TYPE contact_ticket_type ADD VALUE IF NOT EXISTS 'technician_note';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  // Create employee_scorecards table if not exists
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS employee_scorecards (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER NOT NULL REFERENCES companies(id),
      employee_id   INTEGER NOT NULL REFERENCES users(id),
      job_date      DATE NOT NULL,
      scored_at     TIMESTAMP,
      customer_name TEXT NOT NULL,
      service_set   TEXT,
      scope_slug    TEXT,
      score         INTEGER NOT NULL CHECK (score BETWEEN 1 AND 4),
      comments      TEXT,
      created_at    TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE (employee_id, job_date, customer_name)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS employee_scorecards_employee_id_idx
    ON employee_scorecards (employee_id)
  `);
  console.log("  ✓ Schema ready");

  // ── 1. Core profile ────────────────────────────────────────────────────────
  console.log("Step 1: Updating core profile...");
  await db.execute(sql`
    UPDATE users SET
      mc_employee_id       = '47897',
      dob                  = '1994-07-15',
      hire_date            = '2026-01-26',
      email                = 'loredo_juliana@yahoo.com',
      phone                = '312-785-9699',
      hr_status            = 'active',
      is_active            = true,
      pto_hours_available  = 0,
      sick_hours_available = 0,
      address              = '6123 South Honore Street',
      city                 = 'Chicago',
      state                = 'IL',
      zip                  = '60636',
      avatar_url           = '/api/uploads/avatars/juliana-42.jpg',
      tags                 = ARRAY['Scheduled', 'Full Time'],
      skills               = ARRAY['Maintenance Cleaning']
    WHERE id = ${EMPLOYEE_ID} AND company_id = ${COMPANY_ID}
  `);
  console.log("  ✓ Core profile updated");

  // ── 2. Pay structure (9 scopes) ────────────────────────────────────────────
  console.log("Step 2: Upserting pay structure...");
  const commercialScopes = [
    'commercial-cleaning',
    'ppm-common-areas',
    'ppm-turnover',
    'multi-unit-common-areas',
  ];
  for (const scope of commercialScopes) {
    await db.execute(sql`
      INSERT INTO employee_pay_structure
        (company_id, employee_id, scope_slug, pay_type, solo_pay, captain_pay, teammate_pay, travel_pay)
      VALUES
        (${COMPANY_ID}, ${EMPLOYEE_ID}, ${scope}, 'flat', 20.00, 0.00, 20.00, 0.00)
      ON CONFLICT (company_id, employee_id, scope_slug)
      DO UPDATE SET
        pay_type     = EXCLUDED.pay_type,
        solo_pay     = EXCLUDED.solo_pay,
        captain_pay  = EXCLUDED.captain_pay,
        teammate_pay = EXCLUDED.teammate_pay,
        travel_pay   = EXCLUDED.travel_pay
    `);
  }
  const houseScopes = [
    'recurring-cleaning',
    'deep-clean-move-in-out',
    'one-time-standard',
    'hourly-deep-clean',
    'hourly-standard-cleaning',
  ];
  for (const scope of houseScopes) {
    await db.execute(sql`
      INSERT INTO employee_pay_structure
        (company_id, employee_id, scope_slug, pay_type, solo_pct, captain_pct, teammate_pct, travel_pay)
      VALUES
        (${COMPANY_ID}, ${EMPLOYEE_ID}, ${scope}, 'percentage', 35.00, 0.00, 35.00, 0.00)
      ON CONFLICT (company_id, employee_id, scope_slug)
      DO UPDATE SET
        pay_type     = EXCLUDED.pay_type,
        solo_pct     = EXCLUDED.solo_pct,
        captain_pct  = EXCLUDED.captain_pct,
        teammate_pct = EXCLUDED.teammate_pct,
        travel_pay   = EXCLUDED.travel_pay
    `);
  }
  console.log("  ✓ Pay structure upserted (9 scopes)");

  // ── 3. Attendance stats ────────────────────────────────────────────────────
  console.log("Step 3: Upserting attendance stats...");
  await db.execute(sql`
    INSERT INTO employee_attendance_stats
      (company_id, employee_id, period_start, period_end, scheduled, worked, absent,
       time_off, excused, unexcused, paid_time_off, sick, late, score)
    VALUES
      (${COMPANY_ID}, ${EMPLOYEE_ID}, '2025-09-25', '2026-03-24', 44, 38, 3, 3, 0, 0, 0, 0, 2, 89)
    ON CONFLICT DO NOTHING
  `);
  console.log("  ✓ Attendance stats upserted");

  // ── 4. Productivity metrics (8 scopes) ─────────────────────────────────────
  console.log("Step 4: Upserting productivity metrics...");
  type ProdRow = { slug: string; pct: number };
  const prodRows: ProdRow[] = [
    { slug: 'deep-clean-move-in-out',   pct: 98  },
    { slug: 'commercial-cleaning',      pct: 400 },
    { slug: 'hourly-deep-clean',        pct: 93  },
    { slug: 'hourly-standard-cleaning', pct: 105 },
    { slug: 'one-time-standard',        pct: 102 },
    { slug: 'ppm-common-areas',         pct: 130 },
    { slug: 'ppm-turnover',             pct: 103 },
    { slug: 'recurring-cleaning',       pct: 100 },
  ];
  for (const r of prodRows) {
    await db.execute(sql`
      INSERT INTO employee_productivity
        (company_id, employee_id, scope_slug, productivity_pct, period_start, period_end)
      VALUES
        (${COMPANY_ID}, ${EMPLOYEE_ID}, ${r.slug}, ${r.pct}, '2025-09-27', '2026-03-14')
      ON CONFLICT (company_id, employee_id, scope_slug)
      DO UPDATE SET
        productivity_pct = EXCLUDED.productivity_pct,
        period_start     = EXCLUDED.period_start,
        period_end       = EXCLUDED.period_end
    `);
  }
  console.log("  ✓ Productivity metrics upserted (8 scopes)");

  // ── 5. Additional pay (2 records) ──────────────────────────────────────────
  console.log("Step 5: Inserting additional pay...");
  type PayRow = { date: string; amount: number; type: string; notes: string };
  const payRows: PayRow[] = [
    { date: '2026-03-20', amount: 35.00, type: 'tips',        notes: 'Tip - Flat Rate Deep Clean' },
    { date: '2026-02-20', amount: 49.30, type: 'amount_owed', notes: 'FE - 02/15/2026 - from one service to other - 4 Sites - 68mi' },
  ];
  let payInserted = 0;
  for (const r of payRows) {
    const exists = await db.execute(sql`
      SELECT 1 FROM additional_pay
      WHERE user_id=${EMPLOYEE_ID}
        AND created_at::date = ${r.date}::date
        AND amount=${r.amount}
        AND type=${r.type}::additional_pay_type
      LIMIT 1
    `);
    if (exists.rows.length === 0) {
      await db.execute(sql`
        INSERT INTO additional_pay (company_id, user_id, amount, type, notes, status, created_at)
        VALUES (
          ${COMPANY_ID}, ${EMPLOYEE_ID}, ${r.amount},
          ${r.type}::additional_pay_type,
          ${r.notes}, 'pending'::additional_pay_status,
          ${r.date}::date
        )
      `);
      payInserted++;
    }
  }
  console.log(`  ✓ Additional pay inserted: ${payInserted} new rows`);

  // ── 6. Employee scorecards (14 records) ────────────────────────────────────
  console.log("Step 6: Upserting scorecards...");
  type ScoreRow = {
    job_date: string; scored_at: string; customer: string;
    service_set: string; scope: string; score: number; comments: string;
  };
  const scoreRows: ScoreRow[] = [
    { job_date:'2026-03-21', scored_at:'2026-03-21 12:12:00', customer:'Ranit Sengupita',    service_set:'Hourly Deep Cleaning',         scope:'hourly-deep-clean',        score:4, comments:'Text Response: 4' },
    { job_date:'2026-03-20', scored_at:'2026-03-21 16:07:00', customer:'Bernardo Carvalho',  service_set:'Flat Rate Standard Cleaning',  scope:'one-time-standard',        score:4, comments:'' },
    { job_date:'2026-03-19', scored_at:'2026-03-19 17:05:00', customer:'Amanda Nolen',       service_set:'Flat Rate Move In/Out',        scope:'deep-clean-move-in-out',   score:4, comments:'Text Response: 4' },
    { job_date:'2026-03-13', scored_at:'2026-03-13 14:05:00', customer:'Kathleen Wing',      service_set:'Hourly Deep Clean',            scope:'hourly-deep-clean',        score:3, comments:'Text Response: 3' },
    { job_date:'2026-03-09', scored_at:'2026-03-09 13:13:00', customer:'Sally Ozinga',       service_set:'Hourly Standard',              scope:'hourly-standard-cleaning', score:4, comments:'Text Response: 4' },
    { job_date:'2026-03-06', scored_at:'2026-03-08 09:38:00', customer:'Bernardo Carvalho',  service_set:'Flat Rate Standard Cleaning',  scope:'one-time-standard',        score:4, comments:'' },
    { job_date:'2026-02-28', scored_at:'2026-02-28 12:59:00', customer:'Samantha Berglind',  service_set:'Flat Standard Service',        scope:'one-time-standard',        score:4, comments:'She did an amazing job and was super sweet! Will definitely request her again in the future.' },
    { job_date:'2026-02-24', scored_at:'2026-02-24 12:38:00', customer:'Ashley Lalich',      service_set:'Hourly Standard Clean',        scope:'hourly-standard-cleaning', score:3, comments:'great job' },
    { job_date:'2026-02-21', scored_at:'2026-02-21 12:34:00', customer:'Janee O\'Neal',      service_set:'Flat Rate Deep Clean',         scope:'deep-clean-move-in-out',   score:4, comments:'Text Response: 4' },
    { job_date:'2026-02-11', scored_at:'2026-02-11 11:39:00', customer:'Faye Windhorst',     service_set:'Hourly Standard',              scope:'hourly-standard-cleaning', score:4, comments:'Text Response: 4' },
    { job_date:'2026-02-07', scored_at:'2026-02-07 14:13:00', customer:'Echo Pang',          service_set:'Hourly Move In/Out',           scope:'hourly-deep-clean',        score:4, comments:'Friendly and communicate timely' },
    { job_date:'2026-02-06', scored_at:'2026-02-06 18:39:00', customer:'Nathaniel Pomeroy',  service_set:'Recurrent Standard Service',   scope:'recurring-cleaning',       score:3, comments:'thank you! The hour is very clean. I have one question for the cleaners.' },
    { job_date:'2026-02-05', scored_at:'2026-02-05 13:41:00', customer:'Daryll Golladay',    service_set:'Hourly Standard Cleaning',     scope:'hourly-standard-cleaning', score:4, comments:'please send her back' },
    { job_date:'2026-02-05', scored_at:'2026-02-05 10:13:00', customer:'Diana Cade',         service_set:'Flat Standard Recurring',      scope:'recurring-cleaning',       score:4, comments:'Text Response: 4' },
  ];
  for (const r of scoreRows) {
    await db.execute(sql`
      INSERT INTO employee_scorecards
        (company_id, employee_id, job_date, scored_at, customer_name, service_set, scope_slug, score, comments)
      VALUES
        (${COMPANY_ID}, ${EMPLOYEE_ID},
         ${r.job_date}::date, ${r.scored_at}::timestamp,
         ${r.customer}, ${r.service_set}, ${r.scope},
         ${r.score}, ${r.comments})
      ON CONFLICT (employee_id, job_date, customer_name)
      DO UPDATE SET
        scored_at   = EXCLUDED.scored_at,
        service_set = EXCLUDED.service_set,
        scope_slug  = EXCLUDED.scope_slug,
        score       = EXCLUDED.score,
        comments    = EXCLUDED.comments
    `);
  }
  const scoreCount = await db.execute(sql`SELECT COUNT(*) FROM employee_scorecards WHERE employee_id=${EMPLOYEE_ID}`);
  console.log(`  ✓ Scorecards: ${(scoreCount.rows[0] as any).count} rows`);

  // ── 7. Contact tickets (2 technician notes) ────────────────────────────────
  console.log("Step 7: Inserting contact tickets...");
  type TicketRow = { created_at: string; notes: string };
  const ticketRows: TicketRow[] = [
    { created_at: '2026-03-24', notes: 'Chris Cucci - Technician Note' },
    { created_at: '2026-03-24', notes: 'Chicago Straford Memorial 7th-day Adventist Church' },
  ];
  let ticketsInserted = 0;
  for (const t of ticketRows) {
    const exists = await db.execute(sql`
      SELECT 1 FROM contact_tickets
      WHERE user_id=${EMPLOYEE_ID}
        AND ticket_type='technician_note'::contact_ticket_type
        AND notes=${t.notes}
      LIMIT 1
    `);
    if (exists.rows.length === 0) {
      await db.execute(sql`
        INSERT INTO contact_tickets (company_id, user_id, ticket_type, notes, created_at)
        VALUES (
          ${COMPANY_ID}, ${EMPLOYEE_ID},
          'technician_note'::contact_ticket_type,
          ${t.notes},
          ${t.created_at}::date
        )
      `);
      ticketsInserted++;
    }
  }
  console.log(`  ✓ Contact tickets inserted: ${ticketsInserted} new rows`);

  // ── Final verification ─────────────────────────────────────────────────────
  console.log("\n=== Verification ===");
  const counts = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM employee_pay_structure    WHERE employee_id=${EMPLOYEE_ID}) AS pay_struct,
      (SELECT COUNT(*) FROM employee_productivity     WHERE employee_id=${EMPLOYEE_ID}) AS prod,
      (SELECT COUNT(*) FROM employee_attendance_stats WHERE employee_id=${EMPLOYEE_ID}) AS att,
      (SELECT COUNT(*) FROM additional_pay            WHERE user_id=${EMPLOYEE_ID})     AS add_pay,
      (SELECT COUNT(*) FROM employee_scorecards       WHERE employee_id=${EMPLOYEE_ID}) AS scorecards,
      (SELECT COUNT(*) FROM contact_tickets           WHERE user_id=${EMPLOYEE_ID})     AS tickets,
      (SELECT pto_hours_available  FROM users WHERE id=${EMPLOYEE_ID}) AS pto_bal,
      (SELECT sick_hours_available FROM users WHERE id=${EMPLOYEE_ID}) AS sick_bal,
      (SELECT avatar_url           FROM users WHERE id=${EMPLOYEE_ID}) AS avatar,
      (SELECT tags                 FROM users WHERE id=${EMPLOYEE_ID}) AS tags,
      (SELECT skills               FROM users WHERE id=${EMPLOYEE_ID}) AS skills
  `);
  const r = counts.rows[0] as any;
  console.log(`  Pay structure:   ${r.pay_struct}  (expect 9)`);
  console.log(`  Productivity:    ${r.prod}  (expect 8)`);
  console.log(`  Attendance:      ${r.att}  (expect 1)`);
  console.log(`  Additional pay:  ${r.add_pay}  (expect 2)`);
  console.log(`  Scorecards:      ${r.scorecards}  (expect 14)`);
  console.log(`  Tickets:         ${r.tickets}  (expect 2)`);
  console.log(`  PTO balance:     ${r.pto_bal}  (expect 0)`);
  console.log(`  Sick balance:    ${r.sick_bal}  (expect 0)`);
  console.log(`  Avatar:          ${r.avatar}`);
  console.log(`  Tags:            ${r.tags}`);
  console.log(`  Skills:          ${r.skills}`);
  console.log("\n✅ Juliana Loredo migration complete.");
}

runJulianaLoredoMigration().catch((e) => { console.error(e); process.exit(1); });
