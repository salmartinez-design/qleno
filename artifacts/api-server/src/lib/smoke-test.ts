import { pool } from "@workspace/db";
import { signToken } from "./auth.js";

const PORT = process.env.PORT || 8080;
const BASE_URL = `http://localhost:${PORT}`;

async function ensureSmokeTestTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smoke_test_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_at TIMESTAMPTZ DEFAULT now(),
      environment TEXT,
      total_tests INTEGER,
      passed INTEGER,
      failed INTEGER,
      results JSONB,
      duration_ms INTEGER
    )
  `);
}

async function getPhesCompanyId(): Promise<number> {
  const r = await pool.query(`SELECT id FROM companies WHERE name ILIKE '%phes%' ORDER BY id LIMIT 1`);
  return r.rows[0]?.id ?? 1;
}

export interface SmokeTestResult {
  passed: number;
  failed: number;
  total: number;
  duration_ms: number;
  results: Array<{ name: string; status: string; error?: string; ms: number }>;
}

export async function runSmokeTests(manual = false): Promise<SmokeTestResult> {
  if (manual) {
    console.log(`[SMOKE] Manual run triggered at ${new Date().toISOString()}`);
  }
  await ensureSmokeTestTable();

  const PHES_ID = await getPhesCompanyId();

  const serviceToken = signToken({
    userId: 0,
    companyId: PHES_ID,
    role: "owner",
    email: "smoke-test@internal",
    isSuperAdmin: true,
  });

  const adminHeaders: Record<string, string> = {
    Authorization: `Bearer ${serviceToken}`,
    "Content-Type": "application/json",
  };

  const smokeTests: Array<{ name: string; test: () => Promise<void> }> = [
    {
      name: "DB connection",
      test: async () => {
        const r = await pool.query("SELECT 1 as ok");
        if (r.rows[0].ok !== 1) throw new Error("SELECT 1 returned unexpected result");
      },
    },
    {
      name: "Auth rejects bad token",
      test: async () => {
        const r = await fetch(`${BASE_URL}/api/clients`, {
          headers: { Authorization: "Bearer bad_token_xyz" },
        });
        if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
      },
    },
    {
      name: "Phes tenant exists",
      test: async () => {
        const r = await pool.query(`SELECT id FROM companies WHERE name ILIKE '%phes%' LIMIT 1`);
        if (r.rows.length === 0) throw new Error("PHES tenant not found in companies table");
      },
    },
    {
      name: "Client count > 0 (Phes)",
      test: async () => {
        const r = await pool.query(`SELECT count(*) FROM clients WHERE company_id = $1`, [PHES_ID]);
        const cnt = parseInt(r.rows[0].count);
        if (cnt <= 100) throw new Error(`Expected > 100 clients, found ${cnt}`);
      },
    },
    {
      name: "Pricing engine — Deep Clean 1800sqft",
      test: async () => {
        const r = await fetch(`${BASE_URL}/api/pricing/calculate`, {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ scope: "deep_clean", sqft: 1800, company_id: PHES_ID }),
        });
        const data = (await r.json()) as any;
        if (!data.total || data.total < 210 || data.total > 800) {
          throw new Error(`Price out of expected range: ${data.total}`);
        }
      },
    },
    {
      name: "Pricing engine — minimum enforced (0 sqft)",
      test: async () => {
        const r = await fetch(`${BASE_URL}/api/pricing/calculate`, {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ scope: "deep_clean", sqft: 0, company_id: PHES_ID }),
        });
        const data = (await r.json()) as any;
        if (data.total !== 210) throw new Error(`Minimum not enforced: ${data.total}`);
      },
    },
    {
      name: "Zone lookup — 60453 returns Oak Lawn zone",
      test: async () => {
        const r = await pool.query(
          `SELECT name, color FROM service_zones WHERE company_id = $1 AND $2 = ANY(zip_codes)`,
          [PHES_ID, "60453"]
        );
        console.log(`[SMOKE ZONE] zip 60453 result:`, r.rows);
        if (r.rows.length === 0) throw new Error("No zone found for 60453");
        if (!r.rows[0].color) throw new Error(`Zone for 60453 has no color (name: ${r.rows[0].name})`);
      },
    },
    {
      name: "Zone lookup — 60464 returns Tinley zone with correct color",
      test: async () => {
        const r = await pool.query(
          `SELECT name, color FROM service_zones WHERE company_id = $1 AND $2 = ANY(zip_codes)`,
          [PHES_ID, "60464"]
        );
        console.log(`[SMOKE ZONE] zip 60464 result:`, r.rows);
        if (r.rows.length === 0) throw new Error("No zone found for 60464");
        if (r.rows[0].color?.toLowerCase() !== "#ffd700") {
          throw new Error(`Wrong color for 60464: ${r.rows[0].color} (zone: ${r.rows[0].name})`);
        }
      },
    },
    {
      name: "Client search returns results",
      test: async () => {
        const r = await fetch(`${BASE_URL}/api/quotes/client-search?q=jim`, {
          headers: adminHeaders,
        });
        const data = (await r.json()) as any;
        if (!Array.isArray(data) || data.length === 0) {
          throw new Error("Client search for 'jim' returned no results");
        }
      },
    },
    {
      name: "Jim Schultz exists and has correct zip",
      test: async () => {
        const r = await pool.query(
          `SELECT id, zip FROM clients WHERE company_id = $1 AND CONCAT(first_name, ' ', last_name) ILIKE '%jim schultz%' LIMIT 1`,
          [PHES_ID]
        );
        if (r.rows.length === 0) throw new Error("Jim Schultz not found in clients");
        if (r.rows[0].zip !== "60464") throw new Error(`Wrong zip for Jim Schultz: ${r.rows[0].zip}`);
      },
    },
    {
      name: "Recurring schedules exist",
      test: async () => {
        // [hotfix 2026-04-29] Column is `is_active boolean`, not
        // `status text`. Pre-existing wrong column reference; smoke
        // test failed silently against an admin-only endpoint until
        // the audit during the clients full-profile hang surfaced it.
        const r = await pool.query(
          `SELECT count(*) FROM recurring_schedules WHERE company_id = $1 AND is_active = true`,
          [PHES_ID]
        );
        const cnt = parseInt(r.rows[0].count);
        if (cnt <= 50) throw new Error(`Only ${cnt} active recurring schedules (expected > 50)`);
      },
    },
    {
      name: "RLS — cross-tenant data leak check",
      test: async () => {
        const companies = await pool.query(`SELECT id FROM companies ORDER BY created_at LIMIT 2`);
        if (companies.rows.length < 2) return;
        const c1 = companies.rows[0].id;
        const c2 = companies.rows[1].id;
        const leak = await pool.query(
          `SELECT count(*) FROM clients WHERE company_id = $1 AND id IN (SELECT id FROM clients WHERE company_id = $2)`,
          [c1, c2]
        );
        if (parseInt(leak.rows[0].count) !== 0) {
          throw new Error("CRITICAL: Cross-tenant data leak detected in clients table");
        }
      },
    },
  ];

  const start = Date.now();
  console.log("[SMOKE] Starting post-deploy smoke tests...");

  const results = await Promise.allSettled(
    smokeTests.map(async (t) => {
      const testStart = Date.now();
      try {
        await t.test();
        const ms = Date.now() - testStart;
        console.log(`[SMOKE PASS] ${t.name} (${ms}ms)`);
        return { name: t.name, status: "pass", ms };
      } catch (err: any) {
        const ms = Date.now() - testStart;
        console.error(`[SMOKE FAIL] ${t.name} — ${err.message}`);
        return { name: t.name, status: "fail", error: err.message, ms };
      }
    })
  );

  const passed = results.filter(
    (r) => r.status === "fulfilled" && (r.value as any).status === "pass"
  ).length;
  const failed = results.filter(
    (r) => r.status === "fulfilled" && (r.value as any).status === "fail"
  ).length;
  const duration = Date.now() - start;

  console.log(`[SMOKE] Complete — ${passed}/${smokeTests.length} passed in ${duration}ms`);
  if (failed > 0) console.error(`[SMOKE] ${failed} test(s) FAILED — review logs above`);

  try {
    await pool.query(
      `INSERT INTO smoke_test_results (environment, total_tests, passed, failed, results, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        process.env.NODE_ENV ?? "development",
        smokeTests.length,
        passed,
        failed,
        JSON.stringify(results.map((r) => (r.status === "fulfilled" ? r.value : { status: "error", reason: (r as any).reason?.message }))),
        duration,
      ]
    );
  } catch (err: any) {
    console.error("[SMOKE] Failed to persist results to DB:", err.message);
  }

  const flatResults = results.map((r) =>
    r.status === "fulfilled" ? r.value : { name: "unknown", status: "error", error: (r as any).reason?.message, ms: 0 }
  );

  return { passed, failed, total: smokeTests.length, duration_ms: duration, results: flatResults };
}
