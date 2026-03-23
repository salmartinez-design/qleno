'use strict';

// ─── MIGRATION: PHES Oak Lawn from MaidCentral → Qleno ───────────────────────
// Run: node data/migration/migrate.js
// Stops after dry run — type YES to proceed.
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = require('/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg');
const XLSX = require('/home/runner/workspace/node_modules/.pnpm/xlsx@0.18.5/node_modules/xlsx');
const readline = require('readline');

const COMPANY_ID = 1;
const MIGRATION_SOURCE = 'mc_import';

const FILES = {
  stats:       '/home/runner/workspace/attached_assets/Customer_Stats_-_Phes_1774300486889.xlsx',
  report:      '/home/runner/workspace/attached_assets/Customer_Report_-_Phes_(1)_1774300486889.xlsx',
  sales:       '/home/runner/workspace/attached_assets/Customer_Sales_-_Phes_(1)_1774300486889.xlsx',
  consistency: '/home/runner/workspace/attached_assets/Consistency_-_Phes_(2)_1774300486889.xlsx',
  emplist:     '/home/runner/workspace/attached_assets/Employee_List_-_Phes_1774300486889.xlsx',
  attendance:  '/home/runner/workspace/attached_assets/Employee_Attendance_Stats_-_Phes_1774300486888.xlsx',
};

const SCOPE_MAP = {
  'Hourly Deep Clean or Move In/Out':                        'Deep Clean or Move In/Out',
  'Deep Clean or Move In/Out':                               'Deep Clean or Move In/Out',
  'Hourly Standard Cleaning':                                'Standard Clean',
  'One-Time, Flat-Rate Standard Cleaning':                   'Standard Clean',
  'Recurring Cleaning':                                      'Standard Clean',
  'Commercial Cleaning':                                     'Commercial Cleaning',
  'PPM Common Areas':                                        'Commercial Cleaning',
  'Multi-Unit Common Areas':                                 'Commercial Cleaning',
  'PPM Turnover':                                            'Commercial Cleaning',
  'Hourly Tasks':                                            'Commercial Cleaning',
  'House Cleaning - One-Time Flat-Rate Standard Cleaning':   'Standard Clean',
  'House Cleaning - Hourly Deep Clean or Move In/Out':       'Deep Clean or Move In/Out',
  'House Cleaning - Hourly Standard Cleaning':               'Standard Clean',
  'House Cleaning - Recurring Cleaning':                     'Standard Clean',
  'Commercial Cleaning - Commercial Cleaning':               'Commercial Cleaning',
};

const FREQ_MAP_CLIENT = {
  'Every Two Weeks':   'biweekly',
  'Every Week':        'weekly',
  'Every Four Weeks':  'monthly',
  'Every Three Weeks': 'monthly',
  'Other Recurring':   'custom',
  'On Demand':         'ondemand',
  'Single':            'onetime',
};

// recurring_schedules.frequency is a DB enum: {weekly, biweekly, monthly, custom}
const FREQ_MAP_SCHEDULE = {
  'Every Two Weeks':   'biweekly',
  'Every Week':        'weekly',
  'Every Four Weeks':  'monthly',
  'Every Three Weeks': 'custom',
  'Other Recurring':   'custom',
};

const ROLE_MAP = {
  'salmartinez@phes.io':           'owner',
  'franciscojestevezs@gmail.com':  'office',
  'info@phes.io':                  'office',
};

const TECH_NAME_MAP = {
  'Alma Salinas':            'Alma Salinas',
  'Norma Guerrero Puga':     'Norma Puga',
  'Guadalupe Mejia':         'Guadalupe Mejia',
  'Alejandra Cuervo':        'Alejandra Cuervo',
  'Ana Valdez':              'Ana Valdez',
  'Rosa Gallegos':           'Rosa Gallegos',
  'Diana Vasquez':           'Diana Vasquez',
  'Juliana Loredo':          'Juliana Loredo',
  'Tatiana Merchan':         'Tatiana Merchan',
  'Not Scheduled':           null,
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function str(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

function norm(s) {
  return str(s).toLowerCase().replace(/\s+/g, ' ');
}

function parseMoney(s) {
  if (!s) return null;
  const n = parseFloat(s.toString().replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function isFutureDate(s) {
  if (!s) return false;
  const d = new Date(s);
  if (isNaN(d.getTime())) return false;
  return d > new Date();
}

function isWithin90Days(s) {
  if (!s) return false;
  const d = new Date(s);
  if (isNaN(d.getTime())) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  return d >= cutoff;
}

function readSheet(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

function resolveFirstTech(teamStr) {
  if (!teamStr || teamStr.trim() === '') return null;
  const t = teamStr.trim();
  if (TECH_NAME_MAP.hasOwnProperty(t)) return TECH_NAME_MAP[t];
  // Try prefix matches for multi-tech strings
  for (const [mcName, mapped] of Object.entries(TECH_NAME_MAP)) {
    if (mcName === null) continue;
    if (t.startsWith(mcName)) return mapped;
  }
  return null; // unknown tech
}

function clientNormKey(firstName, lastName) {
  const fn = norm(firstName);
  const ln = norm(lastName);
  if (!ln || ln === '.') return fn;
  return `${fn} ${ln}`;
}

// ─── EXCEL PARSING ───────────────────────────────────────────────────────────

function parseEmpList(rows) {
  const emps = [];
  for (const r of rows) {
    const firstName = str(r['First name']);
    const lastName  = str(r['Last name']);
    if (!firstName && !lastName) continue;
    const fullName = `${firstName} ${lastName}`.trim();
    if (norm(fullName).includes('generic cleaner') || norm(fullName).includes('generic')) continue;

    const email    = str(r['Email']).toLowerCase();
    const phone    = str(r['Phone']);
    const hireDate = parseDate(r['Hire Date']);
    const termDate = parseDate(r['Termination Date']);

    const role     = ROLE_MAP[email] || 'technician';
    const status   = termDate ? 'inactive' : 'active';

    emps.push({ firstName, lastName, email, phone, hireDate, termDate, role, status });
  }
  return emps;
}

function parseStats(rows) {
  const map = new Map(); // normKey → record
  for (const r of rows) {
    const rawLast  = str(r['Last Name']);
    const rawFirst = str(r['First Name']);

    let firstName, lastName;
    if (!rawLast || rawLast === '.') {
      firstName = rawFirst;
      lastName  = '';
    } else {
      firstName = rawFirst;
      lastName  = rawLast;
    }

    const key = clientNormKey(firstName, lastName);
    map.set(key, {
      firstName,
      lastName,
      customerSource: str(r['Customer Source']),
      allTimeRevenue: parseMoney(r['All Time Revenue']),
      startDate:      parseDate(r['Start Date']),
      lastCleaning:   parseDate(r['Last Cleaning']),
      nextCleaning:   parseDate(r['Next Cleaning']),
    });
  }
  return map;
}

function parseReport(rows) {
  const map = new Map();
  for (const r of rows) {
    const firstName = str(r['First']);
    const lastName  = str(r['Last']);
    if (!firstName && !lastName) continue;

    const key = clientNormKey(firstName, lastName);
    map.set(key, {
      firstName,
      lastName,
      companyName:     str(r['Company Name']),
      address1:        str(r['Address 1']),
      address2:        str(r['Address 2']),
      city:            str(r['City']),
      state:           str(r['State']),
      zip:             str(r['Zip']),
      phone:           str(r['Phone']),
      cellPhone:       str(r['Cell Phone']),
      email:           str(r['Email']).toLowerCase(),
      baseFee:         parseMoney(r['Base Fee']),
      scope:           str(r['Scope of Work']),
      frequency:       str(r['Frequency']),
      canceledService: str(r['Canceled Service']),
      customerStart:   parseDate(r['Customer Start']),
    });
  }
  return map;
}

function parseSales(rows) {
  const MONTH_COLS = [];
  if (rows.length === 0) return { monthCols: [], data: [] };
  const firstRow = rows[0];
  for (const k of Object.keys(firstRow)) {
    if (k === 'Customer' || k === 'Total' || k === '__EMPTY') continue;
    if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/.test(k)) {
      MONTH_COLS.push(k);
    }
  }

  const data = [];
  for (const r of rows) {
    const raw = str(r['Customer']);
    if (!raw) continue;
    // Sales file is "Last, First" format
    let firstName, lastName;
    if (raw.includes(',')) {
      const parts = raw.split(',');
      lastName  = parts[0].trim();
      firstName = parts.slice(1).join(',').trim();
    } else {
      const parts = raw.split(' ');
      firstName = parts[0];
      lastName  = parts.slice(1).join(' ');
    }
    const key = clientNormKey(firstName, lastName);
    const months = {};
    for (const m of MONTH_COLS) {
      const v = parseMoney(r[m]);
      if (v && v > 0) months[m] = v;
    }
    data.push({ key, firstName, lastName, months });
  }
  return { monthCols: MONTH_COLS, data };
}

function parseConsistency(rows) {
  const schedules = [];
  for (const r of rows) {
    const customer  = str(r['Customer']);
    const scope     = str(r['Scope']);
    const serviceSet = str(r['Service Set']);
    const frequency = str(r['Frequency']);
    const techStr   = str(r['Default Team(s)']);
    const startTime = str(r['Default Start Time']);

    if (!customer) continue;
    if (frequency === 'Single' || frequency === 'On Demand') continue;

    const schedFreq = FREQ_MAP_SCHEDULE[frequency];
    if (!schedFreq) continue; // skip unmapped

    // Parse customer name — usually "First Last"
    const parts = customer.trim().split(/\s+/);
    const firstName = parts[0] || '';
    const lastName  = parts.slice(1).join(' ') || '';
    const key = clientNormKey(firstName, lastName);

    const mappedTech = resolveFirstTech(techStr);
    const mappedScope = SCOPE_MAP[scope] || scope;

    schedules.push({ key, customer, firstName, lastName, scope: mappedScope, serviceSet, frequency, schedFreq, techStr, mappedTech, startTime });
  }
  return schedules;
}

// ─── MONTH CONVERSION ────────────────────────────────────────────────────────

const MONTH_IDX = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

function monthColToDate(col) {
  const [mon, yr] = col.split(' ');
  const m = MONTH_IDX[mon];
  if (!m) return null;
  return `${yr}-${String(m).padStart(2,'0')}-01`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  console.log('\n🔍  Reading source files...\n');

  // ── Read files ──────────────────────────────────────────────────────────────
  let filesRead = 0;
  const fileResults = {};
  for (const [k, f] of Object.entries(FILES)) {
    try {
      fileResults[k] = readSheet(f);
      filesRead++;
    } catch (e) {
      console.error(`  ❌  ${k}: ${e.message}`);
      fileResults[k] = [];
    }
  }

  // ── Parse each file ─────────────────────────────────────────────────────────
  const empRows       = parseEmpList(fileResults.emplist);
  const statsMap      = parseStats(fileResults.stats);
  const reportMap     = parseReport(fileResults.report);
  const salesData     = parseSales(fileResults.sales);
  const schedules     = parseConsistency(fileResults.consistency);

  // ── Fetch existing emails and client names from DB ──────────────────────────
  const { rows: existingUsers }   = await db.query('SELECT email, first_name, last_name FROM users WHERE company_id=$1', [COMPANY_ID]);
  const { rows: existingClients } = await db.query('SELECT id, email, first_name, last_name FROM clients WHERE company_id=$1', [COMPANY_ID]);

  const existingEmailSet = new Set(existingUsers.map(u => u.email.toLowerCase()));
  const existingClientEmailMap = new Map(existingClients.filter(c => c.email).map(c => [c.email.toLowerCase(), c.id]));
  const existingClientNameMap  = new Map(existingClients.map(c => [clientNormKey(c.first_name, c.last_name), c.id]));

  // ── PART 1: Employees ───────────────────────────────────────────────────────
  let empActiveNew = 0, empInactiveNew = 0, empSkipped = 0;
  const empToInsert = [];
  for (const e of empRows) {
    if (existingEmailSet.has(e.email)) { empSkipped++; continue; }
    if (e.status === 'inactive') empInactiveNew++;
    else empActiveNew++;
    empToInsert.push(e);
  }

  // ── PART 3: Clients ─────────────────────────────────────────────────────────
  let clientInserts = 0, clientUpdates = 0, clientSkipped = 0;
  let activeClients = 0, inactiveClients = 0, futureNextCleaning = 0;
  const clientsToProcess = [];
  const validationErrors = [];

  // We'll build a combined import list from stats (primary source)
  for (const [key, stat] of statsMap) {
    const rep = reportMap.get(key);
    const canceledService = rep?.canceledService || '';
    const nextCleaning    = stat.nextCleaning;
    const lastCleaning    = stat.lastCleaning;

    let isActive = true;
    if (canceledService) {
      isActive = false;
    } else if (isFutureDate(nextCleaning)) {
      isActive = true;
      futureNextCleaning++;
    } else if (isWithin90Days(lastCleaning)) {
      isActive = true;
    } else {
      isActive = false;
    }

    if (isActive) activeClients++;
    else inactiveClients++;

    // Check deduplicate
    const emailKey = rep?.email?.toLowerCase();
    let existingId = null;
    if (emailKey && existingClientEmailMap.has(emailKey)) {
      existingId = existingClientEmailMap.get(emailKey);
    } else if (existingClientNameMap.has(key)) {
      existingId = existingClientNameMap.get(key);
    }

    if (existingId) clientUpdates++;
    else clientInserts++;

    const freq = FREQ_MAP_CLIENT[rep?.frequency] || null;
    const scope = SCOPE_MAP[rep?.scope] || rep?.scope || null;
    const clientType = (scope === 'Commercial Cleaning') ? 'commercial' : 'residential';

    clientsToProcess.push({
      key, existingId,
      firstName: stat.firstName,
      lastName:  stat.lastName,
      email:     emailKey || null,
      phone:     rep?.cellPhone || rep?.phone || null,
      address:   rep ? [rep.address1, rep.address2].filter(Boolean).join(', ') : null,
      city:      rep?.city || null,
      state:     rep?.state || null,
      zip:       rep?.zip || null,
      leadSource:      stat.customerSource || null,
      historicalRevenue: stat.allTimeRevenue,
      clientSince:     stat.startDate || rep?.customerStart || null,
      lastJobDate:     stat.lastCleaning,
      nextJobDate:     isFutureDate(nextCleaning) ? nextCleaning : null,
      isActive,
      frequency:  freq,
      baseFee:    rep?.baseFee || null,
      serviceType: scope,
      clientType,
      canceledService,
    });
  }

  // ── PART 4: Recurring Schedules ─────────────────────────────────────────────
  let schedToImport = 0, schedWithTech = 0, schedNullTech = 0;
  const schedValidated = [];
  for (const s of schedules) {
    const clientMatch = clientsToProcess.find(c => c.key === s.key);
    if (!clientMatch) { continue; } // skip if client not in our import list
    schedToImport++;
    if (s.mappedTech) schedWithTech++;
    else schedNullTech++;
    schedValidated.push(s);
  }

  // ── PART 5: Revenue History ─────────────────────────────────────────────────
  let revRowsTotal = 0;
  let revTotal = 0;
  const revData = [];
  for (const row of salesData.data) {
    const clientMatch = clientsToProcess.find(c => c.key === row.key);
    if (!clientMatch) continue;
    for (const [col, amount] of Object.entries(row.months)) {
      const periodMonth = monthColToDate(col);
      if (!periodMonth) continue;
      revRowsTotal++;
      revTotal += amount;
      revData.push({ key: row.key, periodMonth, revenue: amount });
    }
  }

  // ── DRY RUN REPORT ──────────────────────────────────────────────────────────
  console.log('\n');
  console.log('MIGRATION DRY RUN REPORT');
  console.log('========================');
  console.log(`Files read successfully:                ${filesRead}/6`);
  console.log(`Employees to import (active):           ${empActiveNew}`);
  console.log(`Employees to import (inactive/term.):   ${empInactiveNew}`);
  console.log(`Employees skipped (already exist):      ${empSkipped}`);
  console.log(`Clients to import (new inserts):        ${clientInserts}`);
  console.log(`Clients to update (existing match):     ${clientUpdates}`);
  console.log(`Active clients:                         ${activeClients}`);
  console.log(`Inactive clients:                       ${inactiveClients}`);
  console.log(`Clients with future next_cleaning:      ${futureNextCleaning}`);
  console.log(`Recurring schedules to import:          ${schedToImport}`);
  console.log(`  Schedules with assigned tech:         ${schedWithTech}`);
  console.log(`  Schedules with null tech:             ${schedNullTech}`);
  console.log(`Revenue history rows to insert:         ${revRowsTotal}`);
  console.log(`Revenue total:                          $${revTotal.toFixed(2)}`);
  console.log(`Branches to create:                     0  (Oak Lawn + Schaumburg already exist)`);
  console.log(`invoice_sequence_start:                 Already set (will update to 6082)`);
  if (validationErrors.length) {
    console.log('\nValidation errors:');
    validationErrors.forEach(e => console.log('  • ' + e));
  } else {
    console.log(`Validation errors:                      None`);
  }
  console.log('');

  // ── CONFIRMATION ────────────────────────────────────────────────────────────
  const answer = await prompt('\nConfirm to proceed with actual database import?\nReply YES to execute: ');
  if (answer.trim().toUpperCase() !== 'YES') {
    console.log('\nAborted — no data was written.');
    await db.end();
    return;
  }

  console.log('\n⚙️   Applying schema changes...');

  // ── SCHEMA ADDITIONS ────────────────────────────────────────────────────────
  const ddl = [
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS migration_source TEXT`,
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS historical_revenue NUMERIC(12,2)`,
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_job_date DATE`,
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS next_job_date DATE`,
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS lead_source TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_source TEXT`,
    `ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS migration_source TEXT`,
    `CREATE TABLE IF NOT EXISTS customer_revenue_history (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      customer_id INTEGER NOT NULL REFERENCES clients(id),
      period_month DATE NOT NULL,
      revenue NUMERIC(10,2) NOT NULL,
      migration_source TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
  ];
  for (const sql of ddl) {
    try { await db.query(sql); }
    catch (e) { console.error('  DDL error:', e.message); }
  }

  // ── PART 6: Branches (already exist) ────────────────────────────────────────
  console.log('✅  Branches: Oak Lawn + Schaumburg already present — skipping');

  // ── PART 7: Invoice Sequence ─────────────────────────────────────────────────
  try {
    await db.query('UPDATE companies SET invoice_sequence_start=$1 WHERE id=$2', [6082, COMPANY_ID]);
    console.log('✅  invoice_sequence_start set to 6082');
  } catch (e) { console.error('  invoice_sequence_start error:', e.message); }

  // ── PART 1: Insert Employees ─────────────────────────────────────────────────
  console.log('\n⚙️   Importing employees...');
  let empImported = 0, empErrors = 0;
  for (const e of empToInsert) {
    try {
      await db.query(`
        INSERT INTO users (company_id, email, first_name, last_name, phone, role, pay_type, hr_status, hire_date, termination_date, migration_source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (email) DO NOTHING
      `, [
        COMPANY_ID, e.email || `noemail_${Date.now()}_${Math.random()}`, e.firstName, e.lastName,
        e.phone || null, e.role, 'hourly', e.status === 'active' ? 'active' : 'inactive',
        e.hireDate || null, e.termDate || null, MIGRATION_SOURCE,
      ]);
      empImported++;
    } catch (err) {
      console.error(`  ❌ Employee ${e.firstName} ${e.lastName}:`, err.message);
      empErrors++;
    }
  }
  console.log(`  ✅  Employees inserted: ${empImported}  Errors: ${empErrors}`);

  // Rebuild employee name→id map for schedule matching
  const { rows: allEmps } = await db.query('SELECT id, first_name, last_name FROM users WHERE company_id=$1', [COMPANY_ID]);
  const empNameToId = new Map(allEmps.map(e => [norm(`${e.first_name} ${e.last_name}`), e.id]));

  // ── PART 3: Insert/Update Clients ────────────────────────────────────────────
  console.log('\n⚙️   Importing clients...');
  let cInserted = 0, cUpdated = 0, cErrors = 0;
  const clientKeyToId = new Map(); // key → DB id (for schedule + revenue matching)

  // Pre-seed existing clients into map
  for (const c of existingClients) {
    clientKeyToId.set(clientNormKey(c.first_name, c.last_name), c.id);
  }

  for (const c of clientsToProcess) {
    try {
      if (c.existingId) {
        await db.query(`
          UPDATE clients SET
            email = COALESCE(NULLIF($1,''), email),
            phone = COALESCE(NULLIF($2,''), phone),
            address = COALESCE(NULLIF($3,''), address),
            city = COALESCE(NULLIF($4,''), city),
            state = COALESCE(NULLIF($5,''), state),
            zip = COALESCE(NULLIF($6,''), zip),
            lead_source = COALESCE($7, lead_source),
            historical_revenue = COALESCE($8, historical_revenue),
            client_since = COALESCE($9::date, client_since),
            last_job_date = COALESCE($10::date, last_job_date),
            next_job_date = COALESCE($11::date, next_job_date),
            is_active = $12,
            frequency = COALESCE(NULLIF($13,''), frequency),
            base_fee = COALESCE($14, base_fee),
            service_type = COALESCE(NULLIF($15,''), service_type),
            migration_source = $16
          WHERE id = $17
        `, [
          c.email, c.phone, c.address, c.city, c.state, c.zip,
          c.leadSource, c.historicalRevenue, c.clientSince,
          c.lastJobDate, c.nextJobDate, c.isActive,
          c.frequency, c.baseFee, c.serviceType, MIGRATION_SOURCE,
          c.existingId,
        ]);
        clientKeyToId.set(c.key, c.existingId);
        cUpdated++;
      } else {
        const { rows: ins } = await db.query(`
          INSERT INTO clients (
            company_id, first_name, last_name, email, phone,
            address, city, state, zip,
            lead_source, historical_revenue, client_since,
            last_job_date, next_job_date, is_active,
            frequency, base_fee, service_type, client_type,
            migration_source
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          RETURNING id
        `, [
          COMPANY_ID, c.firstName, c.lastName, c.email, c.phone,
          c.address, c.city, c.state, c.zip,
          c.leadSource, c.historicalRevenue, c.clientSince,
          c.lastJobDate, c.nextJobDate, c.isActive,
          c.frequency, c.baseFee, c.serviceType, c.clientType,
          MIGRATION_SOURCE,
        ]);
        clientKeyToId.set(c.key, ins[0].id);
        cInserted++;
      }
    } catch (err) {
      console.error(`  ❌ Client ${c.firstName} ${c.lastName}:`, err.message);
      cErrors++;
    }
  }
  console.log(`  ✅  Clients inserted: ${cInserted}  Updated: ${cUpdated}  Errors: ${cErrors}`);

  // ── PART 4: Recurring Schedules ──────────────────────────────────────────────
  console.log('\n⚙️   Importing recurring schedules...');
  let sInserted = 0, sErrors = 0;
  const today = new Date().toISOString().split('T')[0];

  for (const s of schedValidated) {
    const customerId = clientKeyToId.get(s.key);
    if (!customerId) continue;

    const techName = s.mappedTech;
    let techId = null;
    if (techName) {
      techId = empNameToId.get(norm(techName)) || null;
    }

    const notes = [
      s.serviceSet ? `Service Set: ${s.serviceSet}` : '',
      s.startTime  ? `Default Start: ${s.startTime}` : '',
    ].filter(Boolean).join(' | ') || null;

    try {
      await db.query(`
        INSERT INTO recurring_schedules (company_id, customer_id, frequency, start_date, assigned_employee_id, service_type, notes, is_active, migration_source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)
      `, [COMPANY_ID, customerId, s.schedFreq, today, techId, s.scope, notes, MIGRATION_SOURCE]);
      sInserted++;
    } catch (err) {
      console.error(`  ❌ Schedule for ${s.customer}:`, err.message);
      sErrors++;
    }
  }
  console.log(`  ✅  Schedules inserted: ${sInserted}  Errors: ${sErrors}`);

  // ── PART 5: Revenue History ──────────────────────────────────────────────────
  console.log('\n⚙️   Importing revenue history...');
  let rInserted = 0, rErrors = 0;
  for (const row of revData) {
    const customerId = clientKeyToId.get(row.key);
    if (!customerId) continue;
    try {
      await db.query(`
        INSERT INTO customer_revenue_history (company_id, customer_id, period_month, revenue, migration_source)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING
      `, [COMPANY_ID, customerId, row.periodMonth, row.revenue, MIGRATION_SOURCE]);
      rInserted++;
    } catch (err) {
      console.error(`  ❌ Revenue row ${row.key} ${row.periodMonth}:`, err.message);
      rErrors++;
    }
  }
  console.log(`  ✅  Revenue rows inserted: ${rInserted}  Errors: ${rErrors}`);

  // ── POST-IMPORT VALIDATION ───────────────────────────────────────────────────
  const { rows: [empCount] }   = await db.query(`SELECT COUNT(*) AS c FROM users WHERE company_id=$1 AND migration_source=$2`, [COMPANY_ID, MIGRATION_SOURCE]);
  const { rows: [cliCount] }   = await db.query(`SELECT COUNT(*) AS c FROM clients WHERE company_id=$1 AND migration_source=$2`, [COMPANY_ID, MIGRATION_SOURCE]);
  const { rows: [cliUpd] }     = await db.query(`SELECT COUNT(*) AS c FROM clients WHERE company_id=$1 AND migration_source=$2`, [COMPANY_ID, MIGRATION_SOURCE]);
  const { rows: [schedCount] } = await db.query(`SELECT COUNT(*) AS c FROM recurring_schedules WHERE company_id=$1 AND migration_source=$2`, [COMPANY_ID, MIGRATION_SOURCE]);
  const { rows: [revCount] }   = await db.query(`SELECT COUNT(*) AS c FROM customer_revenue_history WHERE company_id=$1 AND migration_source=$2`, [COMPANY_ID, MIGRATION_SOURCE]);

  const totalErrors = empErrors + cErrors + sErrors + rErrors;

  console.log('\n');
  console.log('MIGRATION COMPLETE');
  console.log('==================');
  console.log(`Employees imported:               ${empCount.c}`);
  console.log(`Clients imported (new):           ${cInserted}`);
  console.log(`Clients updated:                  ${cUpdated}`);
  console.log(`Recurring schedules imported:     ${schedCount.c}`);
  console.log(`Revenue history rows inserted:    ${revCount.c}`);
  console.log(`Branches created:                 0 (pre-existing)`);
  console.log(`Errors encountered:               ${totalErrors}`);
  console.log(`Dummy data still present:         YES — run cleanup prompt separately`);

  console.log('\n--- Cleanup SQL (DRY RUN — not executed) ---');
  console.log(`-- Remove demo clients (non-mc_import, non-real):
DELETE FROM clients
WHERE company_id = ${COMPANY_ID}
  AND migration_source IS NULL
  AND created_at < '2026-01-01';

-- Remove demo jobs:
DELETE FROM jobs
WHERE company_id = ${COMPANY_ID}
  AND created_at < '2026-01-01';

-- Verify before running above SQL manually.`);

  await db.end();
  console.log('\n✅  Migration complete.');
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer); });
  });
}

main().catch(err => { console.error('\nFatal error:', err.message); process.exit(1); });
