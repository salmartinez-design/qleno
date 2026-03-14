import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { getAuthHeaders } from "@/lib/auth";

const PURPLE = "#7F77DD";
const PURPLE_RGB = "127, 119, 221";

interface BillingData {
  mrr: number;
  arr: number;
  platformFees: number;
  byPlan: { starter: number; growth: number; enterprise: number };
  upcomingRenewals: number;
  failedPayments: number;
  mrrHistory: Array<{ month: string; mrr: number }>;
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{
      backgroundColor: "#161616", border: "1px solid #222",
      borderRadius: "10px", padding: "20px",
      borderLeft: color ? `3px solid ${color}` : undefined,
    }}>
      <p style={{ fontSize: "11px", fontWeight: 600, color: "#4A4845", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>{label}</p>
      <p style={{ fontSize: "22px", fontWeight: 700, color: "#F0EDE8", margin: 0, letterSpacing: "-0.02em" }}>{value}</p>
      {sub && <p style={{ fontSize: "12px", color: "#7A7873", margin: "4px 0 0" }}>{sub}</p>}
    </div>
  );
}

export default function AdminBilling() {
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/billing", { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return <AdminLayout title="Billing & Revenue"><div style={{ color: "#4A4845", textAlign: "center", paddingTop: "60px" }}>Loading...</div></AdminLayout>;
  }
  if (!data) {
    return <AdminLayout title="Billing & Revenue"><div style={{ color: "#F87171", textAlign: "center", paddingTop: "60px" }}>Failed to load billing data.</div></AdminLayout>;
  }

  const maxMrr = Math.max(...data.mrrHistory.map(m => m.mrr), 1);

  const PLAN_MRR: Record<string, number> = { starter: 49, growth: 149, enterprise: 299 };
  const planKeys = ["starter", "growth", "enterprise"] as const;

  return (
    <AdminLayout title="Billing & Revenue">
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        {/* Key metrics */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "12px" }}>
          <StatCard label="Monthly Recurring Revenue" value={`$${data.mrr.toLocaleString()}`} sub={`$${data.arr.toLocaleString()} ARR`} color={PURPLE} />
          <StatCard label="Platform Fees (5%)" value={`$${data.platformFees.toLocaleString()}`} sub="This month" color="#4ADE80" />
          <StatCard label="Upcoming Renewals" value={String(data.upcomingRenewals)} color="#60A5FA" />
          <StatCard label="Failed Payments" value={String(data.failedPayments)} color="#F87171" />
        </div>

        {/* MRR chart */}
        <div style={{ backgroundColor: "#161616", border: "1px solid #222", borderRadius: "10px", padding: "20px" }}>
          <p style={{ fontSize: "13px", fontWeight: 600, color: "#F0EDE8", margin: "0 0 20px" }}>MRR Trend (6 months)</p>
          <div style={{ display: "flex", alignItems: "flex-end", gap: "12px", height: "120px" }}>
            {data.mrrHistory.map(m => {
              const pct = (m.mrr / maxMrr) * 100;
              return (
                <div key={m.month} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", height: "100%", justifyContent: "flex-end" }}>
                  <span style={{ fontSize: "11px", color: "#7A7873", fontWeight: 500 }}>${(m.mrr / 1000).toFixed(1)}k</span>
                  <div style={{
                    width: "100%", backgroundColor: `rgba(${PURPLE_RGB}, 0.8)`,
                    borderRadius: "4px 4px 0 0",
                    height: `${Math.max(pct, 4)}%`,
                    transition: "height 0.4s",
                  }} />
                  <span style={{ fontSize: "10px", color: "#4A4845" }}>{m.month}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Plan breakdown */}
        <div style={{ backgroundColor: "#161616", border: "1px solid #222", borderRadius: "10px", padding: "20px" }}>
          <p style={{ fontSize: "13px", fontWeight: 600, color: "#F0EDE8", margin: "0 0 16px" }}>Subscription Plan Breakdown</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {planKeys.map(plan => {
              const count = data.byPlan[plan] || 0;
              const revenue = count * PLAN_MRR[plan];
              const total = planKeys.reduce((s, p) => s + (data.byPlan[p] || 0) * PLAN_MRR[p], 0);
              const pct = total > 0 ? Math.round((revenue / total) * 100) : 0;
              const colors: Record<string, string> = { starter: "#7A7873", growth: PURPLE, enterprise: "#FBBF24" };
              return (
                <div key={plan}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: colors[plan] }} />
                      <span style={{ fontSize: "13px", color: "#F0EDE8", textTransform: "capitalize" }}>{plan}</span>
                      <span style={{ fontSize: "12px", color: "#4A4845" }}>({count} companies × ${PLAN_MRR[plan]}/mo)</span>
                    </div>
                    <span style={{ fontSize: "13px", fontWeight: 600, color: "#F0EDE8" }}>${revenue.toLocaleString()}/mo</span>
                  </div>
                  <div style={{ height: "6px", backgroundColor: "#222", borderRadius: "3px" }}>
                    <div style={{ height: "100%", width: `${pct}%`, backgroundColor: colors[plan], borderRadius: "3px", transition: "width 0.4s" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Note about Stripe */}
        <div style={{
          backgroundColor: "#0F1E2A", border: "1px solid #1D4ED8",
          borderRadius: "10px", padding: "16px 20px",
          display: "flex", alignItems: "flex-start", gap: "10px",
        }}>
          <span style={{ fontSize: "16px" }}>ℹ</span>
          <div>
            <p style={{ fontSize: "13px", fontWeight: 600, color: "#60A5FA", margin: "0 0 4px" }}>Stripe Integration Pending</p>
            <p style={{ fontSize: "12px", color: "#7A7873", margin: 0 }}>Revenue figures shown are derived from active subscription plans. Connect Stripe to see real payment data, failed charges, and upcoming renewals.</p>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
