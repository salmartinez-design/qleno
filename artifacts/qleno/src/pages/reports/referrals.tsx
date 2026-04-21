import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";
import { Loader2, Users } from "lucide-react";
import { useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

const SOURCE_LABELS: Record<string, string> = {
  google: "Google", nextdoor: "Nextdoor", facebook: "Facebook", yelp: "Yelp",
  client_referral: "Client Referral", door_hanger: "Door Hanger",
  yard_sign: "Yard Sign", website: "Website", other: "Other",
};

const COLORS = ["#5B9BD5", "#22C55E", "#F59E0B", "#8B5CF6", "#EF4444", "#06B6D4", "#EC4899", "#14B8A6", "#9E9B94"];

export default function ReferralReportPage() {
  const [, navigate] = useLocation();

  const { data: customers = [], isLoading } = useQuery<any[]>({
    queryKey: ["customers-referral"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/clients?limit=500`, { headers: getAuthHeaders() });
      if (!r.ok) throw new Error("Failed");
      const d = await r.json();
      return d.clients || d || [];
    },
  });

  // Build referral source summary
  const sourceCounts: Record<string, { count: number; clients: any[] }> = {};
  customers.forEach((c: any) => {
    const src = c.referral_source || "other";
    if (!sourceCounts[src]) sourceCounts[src] = { count: 0, clients: [] };
    sourceCounts[src].count++;
    sourceCounts[src].clients.push(c);
  });

  const chartData = Object.entries(sourceCounts)
    .map(([source, { count }]) => ({ source, label: SOURCE_LABELS[source] || source, count }))
    .sort((a, b) => b.count - a.count);

  const topSource = chartData[0];

  // Client referral chains
  const referralChains = customers.filter((c: any) => c.referral_source === "client_referral" && c.referral_by_customer_id);

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 24, fontFamily: FF }}>
        {/* Header */}
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>Referral Tracking</h1>
          <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>Where are your new customers coming from?</p>
        </div>

        {isLoading ? (
          <div style={{ padding: 60, textAlign: "center" }}><Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} /></div>
        ) : (
          <>
            {/* Summary cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
              <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 20px" }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: "#1A1917" }}>{customers.length}</div>
                <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 2 }}>Total Clients</div>
              </div>
              <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 20px" }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: "var(--brand)" }}>{sourceCounts["client_referral"]?.count || 0}</div>
                <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 2 }}>Client Referrals</div>
              </div>
              {topSource && (
                <div style={{ backgroundColor: "#F0F7FF", border: "1px solid #BAD8F7", borderRadius: 10, padding: "20px 20px" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#1D4ED8" }}>{topSource.label}</div>
                  <div style={{ fontSize: 11, color: "#1D4ED8", marginTop: 2 }}>Top Source ({topSource.count} clients)</div>
                </div>
              )}
            </div>

            {/* Chart */}
            {chartData.length > 0 && (
              <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px" }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", margin: "0 0 16px" }}>Clients by Source</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F0EEE9" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#9E9B94", fontFamily: FF }} />
                    <YAxis tick={{ fontSize: 11, fill: "#9E9B94", fontFamily: FF }} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontFamily: FF, fontSize: 12, borderRadius: 6, border: "1px solid #E5E2DC" }} />
                    <Bar dataKey="count" name="Clients" radius={[4, 4, 0, 0]}>
                      {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Client Referral Chain */}
            {referralChains.length > 0 && (
              <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: "1px solid #EEECE7", display: "flex", alignItems: "center", gap: 8 }}>
                  <Users size={15} style={{ color: "var(--brand)" }} />
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Client Referral Chain</span>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                      {["New Client", "Referred By"].map(h => (
                        <th key={h} style={{ padding: "10px 20px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {referralChains.slice(0, 20).map((c: any) => {
                      const referrer = customers.find((x: any) => x.id === c.referral_by_customer_id);
                      return (
                        <tr key={c.id} style={{ borderBottom: "1px solid #F0EEE9" }}
                          onMouseEnter={e => e.currentTarget.style.backgroundColor = "#F7F6F3"}
                          onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}>
                          <td style={{ padding: "12px 20px", fontSize: 13, color: "#1A1917", cursor: "pointer" }}
                            onClick={() => navigate(`/customers/${c.id}`)}>
                            {c.first_name} {c.last_name}
                          </td>
                          <td style={{ padding: "12px 20px", fontSize: 13, color: "var(--brand)", cursor: "pointer" }}
                            onClick={() => referrer && navigate(`/customers/${referrer.id}`)}>
                            {referrer ? `${referrer.first_name} ${referrer.last_name}` : `Client #${c.referral_by_customer_id}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* All sources breakdown */}
            <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid #EEECE7" }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>All Sources</span>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                    {["Source", "Clients", "% of Total"].map(h => (
                      <th key={h} style={{ padding: "10px 20px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {chartData.map(({ source, label, count }) => (
                    <tr key={source} style={{ borderBottom: "1px solid #F0EEE9" }}>
                      <td style={{ padding: "12px 20px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{label}</td>
                      <td style={{ padding: "12px 20px", fontSize: 13, color: "#1A1917" }}>{count}</td>
                      <td style={{ padding: "12px 20px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ flex: 1, height: 6, backgroundColor: "#F0EEE9", borderRadius: 3 }}>
                            <div style={{ width: `${customers.length > 0 ? (count / customers.length) * 100 : 0}%`, height: "100%", backgroundColor: "var(--brand)", borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 12, color: "#6B7280", minWidth: 32 }}>
                            {customers.length > 0 ? `${((count / customers.length) * 100).toFixed(0)}%` : "0%"}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </DashboardLayout>
  );
}
