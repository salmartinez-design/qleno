import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function runNormaPugaMigration() {
  console.log("=== Norma Puga Migration ===");
  const EMPLOYEE_ID = 32;
  const COMPANY_ID = 1;

  // ── 0. Add new enum values ─────────────────────────────────────────────────
  console.log("Step 0: Adding new enum values...");
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TYPE additional_pay_type ADD VALUE IF NOT EXISTS 'attendance_performance';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TYPE additional_pay_type ADD VALUE IF NOT EXISTS 'amount_employee_owes';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TYPE additional_pay_type ADD VALUE IF NOT EXISTS 'employee_referral';
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  console.log("  ✓ Enum values added");

  // ── 1. Core employee info ──────────────────────────────────────────────────
  console.log("Step 1: Updating core profile...");
  await db.execute(sql`
    UPDATE users SET
      mc_employee_id       = '26443',
      hire_date            = '2023-05-11',
      email                = 'normalpuga@gmail.com',
      phone                = '317-400-9136',
      hr_status            = 'active',
      is_active            = true,
      pto_hours_available  = 48,
      sick_hours_available = 32
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
        pay_type    = EXCLUDED.pay_type,
        solo_pct    = EXCLUDED.solo_pct,
        captain_pct = EXCLUDED.captain_pct,
        teammate_pct= EXCLUDED.teammate_pct,
        travel_pay  = EXCLUDED.travel_pay
    `);
  }
  console.log("  ✓ Pay structure upserted (9 scopes)");

  // ── 3. PTO history (42 entries) ────────────────────────────────────────────
  console.log("Step 3: Upserting PTO history...");
  type PtoRow = { d: string; pto_adj: number; pto_bal: number; sick_adj: number; sick_bal: number; notes: string };
  const ptoRows: PtoRow[] = [
    { d:'2026-03-10 16:29:00', pto_adj:-8,    pto_bal:48,     sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2026-03-03 17:29:00', pto_adj:8,     pto_bal:56,     sick_adj:0,   sick_bal:32,   notes:'Cancelled' },
    { d:'2026-02-27 11:41:00', pto_adj:-8,    pto_bal:48,     sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2026-01-26 17:51:00', pto_adj:-8,    pto_bal:56,     sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2026-01-17 09:04:00', pto_adj:-8,    pto_bal:64,     sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2026-01-02 17:28:00', pto_adj:68.25, pto_bal:72,     sick_adj:19,  sick_bal:32,   notes:'Update after PTO Audit' },
    { d:'2025-12-13 17:19:00', pto_adj:-8,    pto_bal:3.75,   sick_adj:0,   sick_bal:13,   notes:'Approved' },
    { d:'2025-12-13 10:41:00', pto_adj:0,     pto_bal:11.75,  sick_adj:-6,  sick_bal:13,   notes:'Approved' },
    { d:'2025-10-01 16:12:00', pto_adj:-6,    pto_bal:11.75,  sick_adj:0,   sick_bal:19,   notes:'Approved' },
    { d:'2025-09-02 13:19:00', pto_adj:-8,    pto_bal:17.75,  sick_adj:0,   sick_bal:19,   notes:'Approved' },
    { d:'2025-07-19 08:57:00', pto_adj:-8,    pto_bal:25.75,  sick_adj:0,   sick_bal:19,   notes:'Approved' },
    { d:'2025-07-03 13:21:00', pto_adj:0,     pto_bal:33.75,  sick_adj:-5,  sick_bal:19,   notes:'Approved' },
    { d:'2025-06-07 11:55:00', pto_adj:-8,    pto_bal:33.75,  sick_adj:0,   sick_bal:24,   notes:'Approved' },
    { d:'2025-05-27 10:59:00', pto_adj:0,     pto_bal:41.75,  sick_adj:-32, sick_bal:24,   notes:'' },
    { d:'2025-05-27 10:58:00', pto_adj:0,     pto_bal:41.75,  sick_adj:-8,  sick_bal:56,   notes:'SICK day taken 5/21. Attendance not updated in time.' },
    { d:'2025-05-22 13:11:00', pto_adj:0,     pto_bal:41.75,  sick_adj:-8,  sick_bal:64,   notes:'Approved' },
    { d:'2025-05-12 14:39:00', pto_adj:-76,   pto_bal:41.75,  sick_adj:0,   sick_bal:72,   notes:'Error' },
    { d:'2025-05-10 21:00:00', pto_adj:80,    pto_bal:117.75, sick_adj:40,  sick_bal:72,   notes:'608: Default Policy' },
    { d:'2025-05-10 21:00:00', pto_adj:0,     pto_bal:37.75,  sick_adj:0,   sick_bal:32,   notes:'608: Default Policy - Carry Over Reset' },
    { d:'2025-05-10 09:32:00', pto_adj:-4,    pto_bal:37.75,  sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2025-05-09 18:38:00', pto_adj:40,    pto_bal:41.75,  sick_adj:0,   sick_bal:32,   notes:'Employee will complete 2 years of service in 2 days' },
    { d:'2025-05-03 12:52:00', pto_adj:-5,    pto_bal:1.75,   sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2025-04-05 10:13:00', pto_adj:-5,    pto_bal:6.75,   sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2025-03-22 09:17:00', pto_adj:-5,    pto_bal:11.75,  sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2025-03-15 10:45:00', pto_adj:-5,    pto_bal:16.75,  sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2025-02-17 09:57:00', pto_adj:-8,    pto_bal:21.75,  sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2025-01-31 17:06:00', pto_adj:-4,    pto_bal:29.75,  sick_adj:0,   sick_bal:32,   notes:'Approved' },
    { d:'2025-01-17 16:47:00', pto_adj:0,     pto_bal:33.75,  sick_adj:-8,  sick_bal:32,   notes:'Approved' },
    { d:'2025-01-07 17:29:00', pto_adj:-6.25, pto_bal:33.75,  sick_adj:0,   sick_bal:40,   notes:'Approved' },
    { d:'2025-01-07 17:20:00', pto_adj:40,    pto_bal:40,     sick_adj:16,  sick_bal:40,   notes:'' },
    { d:'2024-11-16 09:26:00', pto_adj:0,     pto_bal:0,      sick_adj:-8,  sick_bal:24,   notes:'Approved' },
    { d:'2024-09-12 20:42:00', pto_adj:0,     pto_bal:0,      sick_adj:-8,  sick_bal:32,   notes:'Approved' },
    { d:'2024-06-06 10:16:00', pto_adj:-8,    pto_bal:32,     sick_adj:0,   sick_bal:40,   notes:'Approved' },
    { d:'2024-06-06 10:16:00', pto_adj:-8,    pto_bal:24,     sick_adj:0,   sick_bal:40,   notes:'Approved' },
    { d:'2024-06-06 10:16:00', pto_adj:-8,    pto_bal:16,     sick_adj:0,   sick_bal:40,   notes:'Approved' },
    { d:'2024-06-06 10:16:00', pto_adj:-8,    pto_bal:8,      sick_adj:0,   sick_bal:40,   notes:'Approved' },
    { d:'2024-06-06 10:16:00', pto_adj:-8,    pto_bal:0,      sick_adj:0,   sick_bal:40,   notes:'Approved' },
    { d:'2024-06-06 10:15:00', pto_adj:40,    pto_bal:40,     sick_adj:0,   sick_bal:40,   notes:'Fix on payroll report' },
    { d:'2024-06-05 17:44:00', pto_adj:-40,   pto_bal:0,      sick_adj:0,   sick_bal:40,   notes:'Norma wanted to get paid for all her hours' },
    { d:'2024-05-29 12:33:00', pto_adj:0,     pto_bal:40,     sick_adj:40,  sick_bal:40,   notes:'' },
    { d:'2024-05-10 21:00:00', pto_adj:40,    pto_bal:40,     sick_adj:0,   sick_bal:0,    notes:'608: Default Policy' },
    { d:'2024-05-10 21:00:00', pto_adj:0,     pto_bal:0,      sick_adj:0,   sick_bal:0,    notes:'608: Default Policy - Carry Over Reset' },
  ];
  for (const r of ptoRows) {
    await db.execute(sql`
      INSERT INTO employee_pto_history
        (company_id, employee_id, date_changed, pto_adj, pto_bal, sick_adj, sick_bal, notes)
      VALUES
        (${COMPANY_ID}, ${EMPLOYEE_ID}, ${r.d}::timestamp, ${r.pto_adj}, ${r.pto_bal}, ${r.sick_adj}, ${r.sick_bal}, ${r.notes})
      ON CONFLICT DO NOTHING
    `);
  }
  const ptoCount = await db.execute(sql`SELECT COUNT(*) FROM employee_pto_history WHERE employee_id=${EMPLOYEE_ID}`);
  console.log(`  ✓ PTO history rows: ${(ptoCount.rows[0] as any).count}`);

  // ── 4. Attendance stats ────────────────────────────────────────────────────
  console.log("Step 4: Upserting attendance stats...");
  await db.execute(sql`
    INSERT INTO employee_attendance_stats
      (company_id, employee_id, period_start, period_end, scheduled, worked, absent,
       time_off, excused, unexcused, paid_time_off, sick, late, score)
    VALUES
      (${COMPANY_ID}, ${EMPLOYEE_ID}, '2025-09-25', '2026-03-24', 151, 147, 3, 3, 0, 0, 7, 2, 14, 93)
    ON CONFLICT DO NOTHING
  `);
  console.log("  ✓ Attendance stats upserted");

  // ── 5. Productivity metrics (10 scopes) ────────────────────────────────────
  console.log("Step 5: Upserting productivity metrics...");
  type ProdRow = { slug: string; pct: number };
  const prodRows: ProdRow[] = [
    { slug: 'deep-clean-move-in-out',   pct: 107 },
    { slug: 'commercial-cleaning',      pct: 127 },
    { slug: 'hourly-deep-clean',        pct: 105 },
    { slug: 'hourly-standard-cleaning', pct: 105 },
    { slug: 'hourly-tasks',             pct: 116 },
    { slug: 'multi-unit-common-areas',  pct: 0   },
    { slug: 'one-time-standard',        pct: 134 },
    { slug: 'ppm-common-areas',         pct: 110 },
    { slug: 'ppm-turnover',             pct: 103 },
    { slug: 'recurring-cleaning',       pct: 113 },
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
  console.log("  ✓ Productivity metrics upserted (10 scopes)");

  // ── 6. Additional pay (80 records) ─────────────────────────────────────────
  console.log("Step 6: Inserting additional pay records...");
  type PayRow = { date: string; amount: number; type: string; notes: string; job_id?: number };
  const payRows: PayRow[] = [
    { date:'2026-03-20', amount:19.57,   type:'bonus_other',            notes:'FE - Joe Cusimano/Claudia Mosier/Dylan Azadi to Daniel Walter etc - 27mi' },
    { date:'2026-03-14', amount:160.00,  type:'vacation_pay',           notes:'PTO Approved by MC' },
    { date:'2026-03-13', amount:18.34,   type:'other_additional',       notes:'FE - Matt Handel/Robert Stortz/Jim Schultz/Walter Nunchuck to Daniel Walter etc' },
    { date:'2026-03-04', amount:90.00,   type:'vacation_pay',           notes:'Approved by MC' },
    { date:'2026-03-02', amount:100.00,  type:'attendance_performance', notes:'Feb 2026 Employee of the Month - MC' },
    { date:'2026-02-28', amount:35.74,   type:'amount_owed',            notes:'FE - Joe Cusimano/Claudia Mosier etc to Greg Ward/Adam Coppelman etc - 49.3mi' },
    { date:'2026-02-23', amount:10.00,   type:'tips',                   notes:'Tip - Recurring Standard Clean', job_id:57554325 },
    { date:'2026-02-20', amount:12.32,   type:'amount_owed',            notes:'0.8+0.2+13+3×0.725=12.325' },
    { date:'2026-02-20', amount:18.85,   type:'amount_owed',            notes:'9.8+5.2+11×0.725=18.85' },
    { date:'2026-02-20', amount:-210.00, type:'amount_employee_owes',   notes:'Marina Clark cash - Norma kept cash, deducted from pay. Check date 2/27 SM' },
    { date:'2026-02-16', amount:12.60,   type:'other_additional',       notes:'Event - Junta (0.63 hrs x $20.00)' },
    { date:'2026-02-15', amount:160.00,  type:'sick_pay',               notes:'Norma texted Maribel Sat 2/14 sick - Approved SM - Paid Via Zelle 2/20' },
    { date:'2026-02-13', amount:12.32,   type:'amount_owed',            notes:'FE - Joe Cusimano/Daniel Walter/Claudia Mosier/Dylan Azadi to Silas Hundt etc - 17mi' },
    { date:'2026-02-06', amount:13.92,   type:'amount_owed_non_taxed',  notes:'19.2×0.725=13.92' },
    { date:'2026-02-04', amount:100.00,  type:'attendance_performance', notes:'Jan 2026 Employee of the Month' },
    { date:'2026-02-02', amount:160.00,  type:'vacation_pay',           notes:'PTO Requested 1/26/26 - Approved by MC' },
    { date:'2026-01-30', amount:21.02,   type:'amount_owed',            notes:'26+3=29×0.725=21.025 Mileage Reimbursement' },
    { date:'2026-01-23', amount:35.00,   type:'amount_owed',            notes:'35x$0.725=$25.37' },
    { date:'2026-01-21', amount:160.00,  type:'vacation_pay',           notes:'PTO requested 1/16/26 - Approved by MC' },
    { date:'2026-01-16', amount:15.15,   type:'amount_owed',            notes:'13+4.7+3.2=$15.15' },
    { date:'2026-01-12', amount:10.00,   type:'compliment',             notes:'Yvette Coleman 5 Star Google Review' },
    { date:'2026-01-09', amount:30.00,   type:'other_additional',       notes:'Meeting at the Office 01/09/26' },
    { date:'2026-01-05', amount:120.00,  type:'vacation_pay',           notes:'Unpaid time off changed to PTO - MC' },
    { date:'2026-01-02', amount:160.00,  type:'holiday_pay',            notes:'Holiday Pay' },
    { date:'2025-12-25', amount:144.00,  type:'holiday_pay',            notes:'Christmas Day' },
    { date:'2025-12-02', amount:36.00,   type:'tips',                   notes:'Tip - Hourly Standard Service', job_id:57168723 },
    { date:'2025-11-27', amount:144.00,  type:'holiday_pay',            notes:'Thanksgiving' },
    { date:'2025-10-07', amount:40.00,   type:'tips',                   notes:'Tip - Flat Rate Standard', job_id:14876327 },
    { date:'2025-10-05', amount:10.00,   type:'tips',                   notes:'Tip - Hourly Deep Cleaning', job_id:54992155 },
    { date:'2025-08-22', amount:40.00,   type:'tips',                   notes:'Tip - Chen Home - Job Date: 8/22/2025', job_id:53552269 },
    { date:'2025-08-20', amount:30.00,   type:'tips',                   notes:'Tip - Hourly Recurrent Service', job_id:52778999 },
    { date:'2025-08-03', amount:30.00,   type:'tips',                   notes:'Tip - Hourly Deep Cleaning', job_id:52589742 },
    { date:'2025-07-25', amount:144.00,  type:'vacation_pay',           notes:'June 25th' },
    { date:'2025-07-14', amount:10.00,   type:'compliment',             notes:'Google Review from Caitlin Loney - Service from 7/1' },
    { date:'2025-07-14', amount:9.84,    type:'tips',                   notes:'Tip - Hourly Standard Service', job_id:50981812 },
    { date:'2025-07-04', amount:144.00,  type:'holiday_pay',            notes:'4th of July paid holiday' },
    { date:'2025-07-01', amount:29.25,   type:'tips',                   notes:'Tip - Hourly Standard Cleaning', job_id:49607584 },
    { date:'2025-06-09', amount:250.00,  type:'employee_referral',      notes:'Referred Delia Martinez hired 12/9/2024' },
    { date:'2025-05-22', amount:144.00,  type:'sick_pay',               notes:'' },
    { date:'2025-05-21', amount:144.00,  type:'sick_pay',               notes:'' },
    { date:'2025-05-05', amount:90.00,   type:'vacation_pay',           notes:'5 hours of PTO on 5/5' },
    { date:'2025-04-25', amount:27.00,   type:'amount_owed',            notes:'Meeting 4/25/25 7:00am-8:30am' },
    { date:'2025-04-23', amount:30.00,   type:'tips',                   notes:'Tip - Recurring Standard Cleaning', job_id:15945622 },
    { date:'2025-04-18', amount:19.83,   type:'tips',                   notes:'Tip - Flat Rate Move In', job_id:47681520 },
    { date:'2025-04-11', amount:66.00,   type:'amount_owed',            notes:'Lockout: 4/11/2025 - Derik Jardine / Flat Rate Standard / General Clean', job_id:13182490 },
    { date:'2025-04-07', amount:90.00,   type:'vacation_pay',           notes:'Paid time off request' },
    { date:'2025-04-01', amount:36.00,   type:'tips',                   notes:'Tip - Standard Clean Hourly', job_id:47951465 },
    { date:'2025-03-28', amount:144.00,  type:'bonus_other',            notes:'Birthday 03/28' },
    { date:'2025-03-18', amount:90.00,   type:'vacation_pay',           notes:'PTO 3/18 5 hours 1:00pm-6:00pm' },
    { date:'2025-03-13', amount:36.00,   type:'bonus_other',            notes:'Bed making for Jim Schultz 03/12' },
    { date:'2025-03-04', amount:10.00,   type:'compliment',             notes:'Google Review Alexandra Gavin (Alexandra Gross) 02/27/25' },
    { date:'2025-02-28', amount:100.00,  type:'amount_owed',            notes:'$100.00 for February Employee of the Month' },
    { date:'2025-02-25', amount:10.00,   type:'other_additional',       notes:'Google Review from Jessica Thompson' },
    { date:'2025-02-22', amount:144.00,  type:'vacation_pay',           notes:'PTO' },
    { date:'2025-02-19', amount:66.00,   type:'tips',                   notes:'Tip - Flat Rate Standard', job_id:27590550 },
    { date:'2025-02-14', amount:27.00,   type:'amount_owed',            notes:'Team Meeting 7:30am-9:00am' },
    { date:'2025-02-02', amount:29.25,   type:'tips',                   notes:'Tip - Hourly Deep Cleaning', job_id:19452423 },
    { date:'2025-01-27', amount:35.20,   type:'tips',                   notes:'Tip - Flat Rate Standard', job_id:16178857 },
    { date:'2024-12-25', amount:144.00,  type:'holiday_pay',            notes:'Christmas Pay' },
    { date:'2024-12-20', amount:85.30,   type:'tips',                   notes:'Tip - Flat rate move in/out', job_id:16393942 },
    { date:'2024-12-13', amount:20.00,   type:'tips',                   notes:'Tip - Flat Deep Clean', job_id:16382806 },
    { date:'2024-11-28', amount:144.00,  type:'holiday_pay',            notes:'Thanksgiving' },
    { date:'2024-11-19', amount:144.00,  type:'sick_pay',               notes:'' },
    { date:'2024-11-12', amount:33.27,   type:'tips',                   notes:'Tip - Flat Rate Deep Clean', job_id:15870393 },
    { date:'2024-10-15', amount:30.00,   type:'tips',                   notes:'Tip - Hourly Deep Clean', job_id:15471217 },
    { date:'2024-10-04', amount:27.00,   type:'tips',                   notes:'Tip - Devitt Home', job_id:15178321 },
    { date:'2024-10-02', amount:20.05,   type:'tips',                   notes:'Tip - Standard', job_id:15166732 },
    { date:'2024-09-25', amount:38.88,   type:'tips',                   notes:'Tip - Standard', job_id:15089229 },
    { date:'2024-09-24', amount:27.00,   type:'tips',                   notes:'Tip - Noiles Home', job_id:13007351 },
    { date:'2024-09-21', amount:35.95,   type:'tips',                   notes:'Tip - Devitt Home', job_id:15004766 },
    { date:'2024-09-17', amount:144.00,  type:'sick_pay',               notes:'Norma requested sick pay on 9/12 for 9/17' },
    { date:'2024-09-07', amount:40.50,   type:'amount_owed',            notes:'Zoom team meeting 9/7' },
    { date:'2024-08-12', amount:13.50,   type:'tips',                   notes:'Tip - Fields Home - Job Date: 8/12/2024', job_id:14506050 },
    { date:'2024-07-04', amount:144.00,  type:'holiday_pay',            notes:'4th of July' },
    { date:'2024-07-03', amount:49.50,   type:'tips',                   notes:'Tip - Kane Home', job_id:13943729 },
    { date:'2024-05-31', amount:144.00,  type:'vacation_pay',           notes:'PTO - 8 hours' },
    { date:'2024-05-30', amount:144.00,  type:'vacation_pay',           notes:'PTO - 8 hours' },
    { date:'2024-05-29', amount:144.00,  type:'vacation_pay',           notes:'PTO - 8 hours' },
    { date:'2024-05-28', amount:144.00,  type:'vacation_pay',           notes:'PTO - 8 hours' },
    { date:'2024-05-27', amount:144.00,  type:'vacation_pay',           notes:'PTO - 8 hours' },
  ];

  let inserted = 0;
  for (const r of payRows) {
    const exists = await db.execute(sql`
      SELECT 1 FROM additional_pay
      WHERE user_id=${EMPLOYEE_ID}
        AND created_at::date = ${r.date}::date
        AND amount=${r.amount}
        AND type=${r.type}
      LIMIT 1
    `);
    if (exists.rows.length === 0) {
      await db.execute(sql`
        -- [pay-day 2026-08-17] effective_date carries the historical date now;
        -- created_at keeps the same value so the dedupe guard above still matches.
        INSERT INTO additional_pay (company_id, user_id, amount, type, notes, status, created_at, effective_date)
        VALUES (
          ${COMPANY_ID}, ${EMPLOYEE_ID}, ${r.amount},
          ${r.type},
          ${r.notes}, 'pending'::additional_pay_status,
          ${r.date}::date, ${r.date}::date
        )
      `);
      inserted++;
    }
  }
  console.log(`  ✓ Additional pay inserted: ${inserted} new rows`);

  // ── 7. Contact tickets (11 records) ───────────────────────────────────────
  console.log("Step 7: Inserting contact tickets...");
  type TicketRow = { created_at: string; ticket_type: string; notes: string };
  const ticketRows: TicketRow[] = [
    { created_at:'2026-01-18', ticket_type:'complaint_poor_cleaning', notes:'Client complained about missed areas and was not satisfied. Attached pictures.' },
    { created_at:'2025-03-21', ticket_type:'complaint_poor_cleaning', notes:'Crumbs and stuff left on floor. Doesn\'t look like house was thoroughly vacuumed or swept. Below usual quality level.' },
    { created_at:'2025-02-07', ticket_type:'complaint_poor_cleaning', notes:'Two ladies showed up two hours early with no communication. Glass on kitchen lights still dusty despite multiple requests to clean them.' },
    { created_at:'2024-12-13', ticket_type:'complaint_poor_cleaning', notes:'Client upset about missed areas. Floors by trash can. Things not put back as they were at arrival.' },
    { created_at:'2024-10-05', ticket_type:'breakage',                notes:'Norma was dusting with corner duster and accidentally hit an item. It fell and broke off.' },
    { created_at:'2024-09-17', ticket_type:'complaint_poor_cleaning', notes:'Some baseboards missed, a window sill, side of oven tray, sides of appliances.' },
    { created_at:'2024-09-11', ticket_type:'complaint_poor_cleaning', notes:'Unit 1106 - Toilet, bathroom and kitchen floor were not done or not done correctly.' },
    { created_at:'2024-08-17', ticket_type:'complaint_poor_cleaning', notes:'Client said they don\'t know what a deep clean consists of. Floors sticky, bathrooms dirty despite time spent. Basement said to be complete but was not.' },
    { created_at:'2024-08-14', ticket_type:'complaint_poor_cleaning', notes:'Walter complained about grease in the stove. Mercedes had to return 8/13 to redo it.' },
    { created_at:'2024-07-31', ticket_type:'complaint_poor_cleaning', notes:'One door wasn\'t cleaned.' },
    { created_at:'2024-07-25', ticket_type:'compliment',              notes:'' },
  ];
  let ticketsInserted = 0;
  for (const t of ticketRows) {
    const exists = await db.execute(sql`
      SELECT 1 FROM contact_tickets
      WHERE user_id=${EMPLOYEE_ID}
        AND ticket_type=${t.ticket_type}::contact_ticket_type
        AND created_at::date = ${t.created_at}::date
      LIMIT 1
    `);
    if (exists.rows.length === 0) {
      await db.execute(sql`
        INSERT INTO contact_tickets (company_id, user_id, ticket_type, notes, created_at)
        VALUES (
          ${COMPANY_ID}, ${EMPLOYEE_ID},
          ${t.ticket_type}::contact_ticket_type,
          ${t.notes},
          ${t.created_at}::date
        )
      `);
      ticketsInserted++;
    }
  }
  console.log(`  ✓ Contact tickets inserted: ${ticketsInserted} new rows`);

  // ── Final counts ───────────────────────────────────────────────────────────
  console.log("\n=== Verification ===");
  const counts = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM employee_pto_history       WHERE employee_id=${EMPLOYEE_ID}) AS pto_rows,
      (SELECT COUNT(*) FROM employee_pay_structure      WHERE employee_id=${EMPLOYEE_ID}) AS pay_struct_rows,
      (SELECT COUNT(*) FROM employee_productivity       WHERE employee_id=${EMPLOYEE_ID}) AS prod_rows,
      (SELECT COUNT(*) FROM employee_attendance_stats   WHERE employee_id=${EMPLOYEE_ID}) AS att_rows,
      (SELECT COUNT(*) FROM additional_pay              WHERE user_id=${EMPLOYEE_ID})     AS add_pay_rows,
      (SELECT COUNT(*) FROM contact_tickets             WHERE user_id=${EMPLOYEE_ID})     AS ticket_rows,
      (SELECT pto_hours_available FROM users            WHERE id=${EMPLOYEE_ID})          AS pto_bal,
      (SELECT sick_hours_available FROM users           WHERE id=${EMPLOYEE_ID})          AS sick_bal
  `);
  const r = counts.rows[0] as any;
  console.log(`  PTO history:        ${r.pto_rows}     (expect 42)`);
  console.log(`  Pay structure:      ${r.pay_struct_rows}     (expect 9)`);
  console.log(`  Productivity:       ${r.prod_rows}     (expect 10)`);
  console.log(`  Attendance stats:   ${r.att_rows}     (expect 1)`);
  console.log(`  Additional pay:     ${r.add_pay_rows}     (expect 80)`);
  console.log(`  Contact tickets:    ${r.ticket_rows}     (expect 11)`);
  console.log(`  PTO balance:        ${r.pto_bal}   (expect 48)`);
  console.log(`  Sick balance:       ${r.sick_bal}   (expect 32)`);
  console.log("\n✅ Norma Puga migration complete.");
}

runNormaPugaMigration().catch((e) => { console.error(e); process.exit(1); });
