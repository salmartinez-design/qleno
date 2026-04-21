import { useEffect, useState, useCallback } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { getAuthHeaders } from "@/lib/auth";

interface DashboardData {
  totalCompanies: number;
  activeSubs: number;
  trialSubs: number;
  pastDueSubs: number;
  canceledSubs: number;
  mrr: number;
  arr: number;
  newThisWeek: number;
  platformFeeRevenue: number;
  flagged: Array<{ id: number; name: string; status: string }>;
}

interface TenantRow {
  id: number;
  name: string;
  subscription_status: string;
  plan: string;
  tier_name: string | null;
  tier_slug: string | null;
  price_monthly: string | null;
  active_techs: number;
  active_office: number;
  total_users: number;
  mrr: string | number;
  early_tenant: boolean;
  trial_ends_at: string | null;
  created_at: string;
}

function TierBadge({ tier, slug }: { tier: string | null; slug: string | null }) {
  const colors: Record<string, { color: string; bg: string }> = {
    solo:  { color: "#374151", bg: "#F3F4F6" },
    team:  { color: "#1D4ED8", bg: "#DBEAFE" },
    pro:   { color: "#7C3AED", bg: "#F5F3FF" },
  };
  const c = colors[slug ?? "solo"] ?? { color: "#374151", bg: "#F3F4F6" };
  return (
    <span style={{ background: c.bg, color: c.color, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999 }}>
      {tier ?? "—"}
    </span>
  );
}

function SubStatusBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; bg: string }> = {
    active:    { color: "#059669", bg: "#ECFDF5" },
    trialing:  { color: "#1D4ED8", bg: "#DBEAFE" },
    past_due:  { color: "#D97706", bg: "#FFFBEB" },
    canceled:  { color: "#DC2626", bg: "#FEF2F2" },
  };
  const c = map[status] ?? { color: "#6B7280", bg: "#F9FAFB" };
  return (
    <span style={{ background: c.bg, color: c.color, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999 }}>
      {status.replace("_", " ")}
    </span>
  );
}

function TenantList() {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/tenants", { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { setTenants(d.data ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const totalMRR = tenants.reduce((s, t) => s + parseFloat(String(t.mrr || 0)), 0);

  return (
    <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #F0EEE9", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <p style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917", margin: 0 }}>All Tenants</p>
          <p style={{ fontSize: "12px", color: "#9E9B94", margin: "2px 0 0" }}>{tenants.length} companies · ${totalMRR.toLocaleString()} MRR</p>
        </div>
      </div>
      {loading ? (
        <div style={{ padding: "32px 20px", color: "#9E9B94", textAlign: "center" }}>Loading tenants…</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ background: "#FAFAF9" }}>
                {["ID","Company","Tier","Status","Techs","Office","Total Users","MRR","Early","Created"].map(h => (
                  <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid #F0EEE9", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tenants.map((t, i) => (
                <tr key={t.id} style={{ background: i % 2 === 0 ? "#FFFFFF" : "#FAFAF9", borderBottom: "1px solid #F5F3F0" }}>
                  <td style={{ padding: "10px 16px", color: "#9E9B94", fontWeight: 500 }}>#{t.id}</td>
                  <td style={{ padding: "10px 16px", fontWeight: 600, color: "#1A1917", whiteSpace: "nowrap" }}>
                    {t.name}
                  </td>
                  <td style={{ padding: "10px 16px" }}><TierBadge tier={t.tier_name} slug={t.tier_slug} /></td>
                  <td style={{ padding: "10px 16px" }}><SubStatusBadge status={t.subscription_status ?? "unknown"} /></td>
                  <td style={{ padding: "10px 16px", color: "#374151", textAlign: "center" }}>{t.active_techs}</td>
                  <td style={{ padding: "10px 16px", color: "#374151", textAlign: "center" }}>{t.active_office}</td>
                  <td style={{ padding: "10px 16px", color: "#374151", textAlign: "center" }}>{t.total_users}</td>
                  <td style={{ padding: "10px 16px", fontWeight: 600, color: "#059669" }}>${parseFloat(String(t.mrr || 0)).toLocaleString()}</td>
                  <td style={{ padding: "10px 16px" }}>
                    {t.early_tenant ? (
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#7C3AED", background: "#F5F3FF", padding: "2px 7px", borderRadius: 999 }}>Early</span>
                    ) : <span style={{ color: "#D1D5DB" }}>—</span>}
                  </td>
                  <td style={{ padding: "10px 16px", color: "#6B7280", whiteSpace: "nowrap" }}>
                    {new Date(t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface SmokeRun {
  id: string;
  run_at: string;
  environment: string;
  total_tests: number;
  passed: number;
  failed: number;
  duration_ms: number;
  results: Array<{ name: string; status: string; error?: string; ms: number }>;
}

function SmokeTestWidget() {
  const [runs, setRuns] = useState<SmokeRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [auditTesting, setAuditTesting] = useState(false);
  const [auditResult, setAuditResult] = useState<{ healthy: boolean; msg: string } | null>(null);

  const fetchRuns = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/smoke-tests", { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { setRuns(d.runs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  const triggerRun = async () => {
    setRunning(true);
    try {
      await fetch("/api/admin/smoke-tests/run", { method: "POST", headers: getAuthHeaders() });
      fetchRuns();
    } finally {
      setRunning(false);
    }
  };

  const triggerAuditTest = async () => {
    setAuditTesting(true);
    setAuditResult(null);
    try {
      const r = await fetch("/api/admin/audit-test", { method: "POST", headers: getAuthHeaders() });
      const d = await r.json();
      if (d.audit_logging_healthy) {
        const ts = d.row?.performed_at ? new Date(d.row.performed_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) : new Date().toLocaleTimeString();
        setAuditResult({ healthy: true, msg: `Audit log write confirmed — ${ts}` });
      } else {
        setAuditResult({ healthy: false, msg: d.error || "Audit logging unhealthy" });
      }
    } catch {
      setAuditResult({ healthy: false, msg: "Request failed" });
    } finally {
      setAuditTesting(false);
    }
  };

  const latest = runs[0];
  const allPassed = latest && latest.failed === 0;
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) + " " +
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  };

  return (
    <div style={{
      backgroundColor: "#FFFFFF",
      border: "1px solid #E5E2DC",
      borderLeft: latest ? (allPassed ? "4px solid #16A34A" : "4px solid #DC2626") : "4px solid #D1D5DB",
      borderRadius: "10px",
      overflow: "hidden",
    }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #F0EEE9", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <p style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917", margin: 0 }}>Last Deploy Health Check</p>
          {loading ? (
            <p style={{ fontSize: "12px", color: "#9E9B94", margin: "2px 0 0" }}>Loading...</p>
          ) : latest ? (
            <p style={{ fontSize: "12px", color: allPassed ? "#16A34A" : "#DC2626", margin: "2px 0 0", fontWeight: 500 }}>
              Last run: {fmt(latest.run_at)} · {latest.passed}/{latest.total_tests} passed · {latest.duration_ms}ms
            </p>
          ) : (
            <p style={{ fontSize: "12px", color: "#9E9B94", margin: "2px 0 0" }}>No runs yet</p>
          )}
          {auditResult && (
            <p style={{ fontSize: "12px", color: auditResult.healthy ? "#16A34A" : "#DC2626", margin: "4px 0 0", fontWeight: 500 }}>
              {auditResult.healthy ? "✓" : "✗"} {auditResult.msg}
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={triggerAuditTest}
            disabled={auditTesting}
            style={{ padding: "7px 14px", backgroundColor: "transparent", color: auditTesting ? "#9E9B94" : "#374151", border: "1px solid #D1D5DB", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: auditTesting ? "default" : "pointer" }}
          >
            {auditTesting ? "Testing…" : "Test audit logging"}
          </button>
          <button
            onClick={triggerRun}
            disabled={running}
            style={{ padding: "7px 14px", backgroundColor: running ? "#F3F4F6" : "#1A1917", color: running ? "#9E9B94" : "#FFFFFF", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: running ? "default" : "pointer" }}
          >
            {running ? "Running…" : "Run now"}
          </button>
        </div>
      </div>

      {latest && !allPassed && (
        <div style={{ padding: "10px 20px", backgroundColor: "#FEF2F2", borderBottom: "1px solid #FECACA" }}>
          <p style={{ fontSize: 12, color: "#DC2626", margin: 0, fontWeight: 600 }}>Failed tests:</p>
          {(latest.results || []).filter(r => r.status === "fail").map(r => (
            <div key={r.name} style={{ margin: "4px 0 0" }}>
              <p style={{ fontSize: 12, color: "#DC2626", margin: 0 }}>✗ {r.name}</p>
              {r.error && (
                <p style={{ fontSize: 11, color: "#A32D2D", margin: "1px 0 0 12px" }}>→ {r.error}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ background: "#FAFAF9" }}>
                {["Date", "Passed", "Failed", "Duration"].map(h => (
                  <th key={h} style={{ padding: "8px 16px", textAlign: "left", fontWeight: 600, color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid #F0EEE9" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => {
                const ok = run.failed === 0;
                const failedTests = (run.results || []).filter(r => r.status === "fail");
                return (
                  <tr key={run.id} style={{ background: i % 2 === 0 ? "#FFFFFF" : "#FAFAF9", borderBottom: "1px solid #F5F3F0" }}>
                    <td style={{ padding: "8px 16px", color: "#374151", whiteSpace: "nowrap" }}>{fmt(run.run_at)}</td>
                    <td style={{ padding: "8px 16px", color: "#16A34A", fontWeight: 600 }}>{run.passed}/{run.total_tests}</td>
                    <td style={{ padding: "8px 16px" }}>
                      {run.failed > 0 ? (
                        <span
                          style={{ color: "#DC2626", fontWeight: 600, cursor: "pointer", textDecoration: "underline dotted" }}
                          onClick={() => setExpanded(expanded === run.id ? null : run.id)}
                        >
                          {run.failed} ⚠
                        </span>
                      ) : (
                        <span style={{ color: "#9E9B94" }}>0</span>
                      )}
                      {expanded === run.id && failedTests.length > 0 && (
                        <div style={{ marginTop: 4, fontSize: 11, color: "#DC2626" }}>
                          {failedTests.map(t => <div key={t.name}>✗ {t.name}</div>)}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "8px 16px", color: "#374151" }}>{run.duration_ms}ms</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const PURPLE = "#7F77DD";
const PURPLE_RGB = "127, 119, 221";

function MetricCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{
      backgroundColor: "#FFFFFF",
      border: `1px solid ${accent ? `rgba(${PURPLE_RGB}, 0.4)` : "#E5E2DC"}`,
      borderTop: accent ? `3px solid ${PURPLE}` : "1px solid #E5E2DC",
      borderRadius: "10px", padding: "20px",
    }}>
      <p style={{ fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>{label}</p>
      <p style={{ fontSize: "22px", fontWeight: 700, color: "#1A1917", margin: 0, letterSpacing: "-0.02em" }}>{value}</p>
      {sub && <p style={{ fontSize: "12px", color: "#6B7280", margin: "4px 0 0" }}>{sub}</p>}
    </div>
  );
}

export default function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/dashboard", { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <AdminLayout title="Platform Dashboard">
      {loading ? (
        <div style={{ color: "#6B7280", textAlign: "center", paddingTop: "60px" }}>Loading platform data...</div>
      ) : data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {/* Metric grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "12px" }}>
            <MetricCard label="Total Companies" value={String(data.totalCompanies)} accent />
            <MetricCard label="Active Subscriptions" value={String(data.activeSubs)} sub={`${data.trialSubs} in trial`} />
            <MetricCard label="Monthly Recurring Revenue" value={`$${data.mrr.toLocaleString()}`} sub={`$${data.arr.toLocaleString()} ARR`} accent />
            <MetricCard label="Platform Fee Revenue" value={`$${data.platformFeeRevenue.toLocaleString()}`} sub="5% of MRR" />
            <MetricCard label="New Signups (7 days)" value={String(data.newThisWeek)} />
            <MetricCard label="Past Due / Canceled" value={String(data.pastDueSubs + data.canceledSubs)} sub="Requires attention" />
          </div>

          {/* Subscription breakdown */}
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
            <p style={{ fontSize: "13px", fontWeight: 600, color: "#1A1917", margin: "0 0 16px" }}>Subscription Status Breakdown</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {[
                { label: "Active",    count: data.activeSubs,    color: "#16A34A" },
                { label: "Trialing",  count: data.trialSubs,     color: "#1E40AF" },
                { label: "Past Due",  count: data.pastDueSubs,   color: "#D97706" },
                { label: "Canceled",  count: data.canceledSubs,  color: "#DC2626" },
              ].map(row => {
                const pct = data.totalCompanies > 0 ? Math.round((row.count / data.totalCompanies) * 100) : 0;
                return (
                  <div key={row.label}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                      <span style={{ fontSize: "12px", color: "#6B7280" }}>{row.label}</span>
                      <span style={{ fontSize: "12px", color: "#1A1917", fontWeight: 500 }}>{row.count} ({pct}%)</span>
                    </div>
                    <div style={{ height: "6px", backgroundColor: "#F0EEE9", borderRadius: "3px" }}>
                      <div style={{ height: "100%", width: `${pct}%`, backgroundColor: row.color, borderRadius: "3px", transition: "width 0.4s" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Flagged companies */}
          {data.flagged.length > 0 && (
            <div style={{ backgroundColor: "#FEF2F2", border: "1px solid #FECACA", borderRadius: "10px", padding: "20px" }}>
              <p style={{ fontSize: "13px", fontWeight: 600, color: "#DC2626", margin: "0 0 12px" }}>
                Flagged Companies ({data.flagged.length})
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {data.flagged.map(c => (
                  <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "13px", color: "#1A1917" }}>{c.name}</span>
                    <span className="badge badge-overdue">{c.status.replace("_", " ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Last Deploy Health Check */}
          <SmokeTestWidget />

          {/* Tenant List */}
          <TenantList />
        </div>
      ) : (
        <div style={{ color: "#DC2626", textAlign: "center", paddingTop: "60px" }}>Failed to load dashboard data.</div>
      )}
    </AdminLayout>
  );
}
