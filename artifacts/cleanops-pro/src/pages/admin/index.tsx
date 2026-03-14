import { useEffect, useState } from "react";
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

const PURPLE = "#7F77DD";
const PURPLE_RGB = "127, 119, 221";

function MetricCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{
      backgroundColor: "#161616", border: "1px solid #222",
      borderRadius: "10px", padding: "20px",
      borderTop: accent ? `2px solid ${PURPLE}` : "1px solid #222",
    }}>
      <p style={{ fontSize: "11px", fontWeight: 600, color: "#4A4845", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>{label}</p>
      <p style={{ fontSize: "22px", fontWeight: 700, color: "#F0EDE8", margin: 0, letterSpacing: "-0.02em" }}>{value}</p>
      {sub && <p style={{ fontSize: "12px", color: "#7A7873", margin: "4px 0 0" }}>{sub}</p>}
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
        <div style={{ color: "#4A4845", textAlign: "center", paddingTop: "60px" }}>Loading platform data...</div>
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
          <div style={{ backgroundColor: "#161616", border: "1px solid #222", borderRadius: "10px", padding: "20px" }}>
            <p style={{ fontSize: "13px", fontWeight: 600, color: "#F0EDE8", margin: "0 0 16px" }}>Subscription Status Breakdown</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {[
                { label: "Active", count: data.activeSubs, color: "#4ADE80" },
                { label: "Trialing", count: data.trialSubs, color: "#60A5FA" },
                { label: "Past Due", count: data.pastDueSubs, color: "#FBBF24" },
                { label: "Canceled", count: data.canceledSubs, color: "#F87171" },
              ].map(row => {
                const pct = data.totalCompanies > 0 ? Math.round((row.count / data.totalCompanies) * 100) : 0;
                return (
                  <div key={row.label}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                      <span style={{ fontSize: "12px", color: "#7A7873" }}>{row.label}</span>
                      <span style={{ fontSize: "12px", color: "#F0EDE8", fontWeight: 500 }}>{row.count} ({pct}%)</span>
                    </div>
                    <div style={{ height: "6px", backgroundColor: "#222", borderRadius: "3px" }}>
                      <div style={{ height: "100%", width: `${pct}%`, backgroundColor: row.color, borderRadius: "3px", transition: "width 0.4s" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Flagged companies */}
          {data.flagged.length > 0 && (
            <div style={{ backgroundColor: "#2A0F0F", border: "1px solid #991B1B", borderRadius: "10px", padding: "20px" }}>
              <p style={{ fontSize: "13px", fontWeight: 600, color: "#F87171", margin: "0 0 12px" }}>
                ⚠ Flagged Companies ({data.flagged.length})
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {data.flagged.map(c => (
                  <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "13px", color: "#F0EDE8" }}>{c.name}</span>
                    <span className="badge badge-overdue">{c.status.replace("_", " ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ color: "#F87171", textAlign: "center", paddingTop: "60px" }}>Failed to load dashboard data.</div>
      )}
    </AdminLayout>
  );
}
