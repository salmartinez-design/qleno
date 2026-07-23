import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";
import { Loader2, Users, Gift } from "lucide-react";
import { useLocation } from "wouter";
import { useState } from "react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

// [referral-program] Give $25 / Get $25 tracker. Status is derived server-side
// from the referred person's linked lead (new → booked → completed → credited);
// "completed" means the referrer's $25 is owed — the Mark credited button
// records it once the office applies the discount to their next job.
const PROGRAM_STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  new: { label: "New lead", bg: "#E6F1FB", fg: "#185FA5" },
  booked: { label: "Booked", bg: "#FAEEDA", fg: "#854F0B" },
  completed: { label: "Completed · credit owed", bg: "#FCEBEB", fg: "#A32D2D" },
  credited: { label: "Completed · credited", bg: "#E1F5EE", fg: "#0F6E56" },
};

function ReferralProgramSection() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [crediting, setCrediting] = useState<number | null>(null);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["referral-program", year],
    queryFn: async () => {
      const r = await fetch(`${API}/api/referrals/report?year=${year}`, { headers: getAuthHeaders() });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  async function markCredited(id: number) {
    setCrediting(id);
    try {
      const r = await fetch(`${API}/api/referrals/${id}/credit`, { method: "POST", headers: getAuthHeaders() });
      if (r.ok) qc.invalidateQueries({ queryKey: ["referral-program"] });
    } finally {
      setCrediting(null);
    }
  }

  const kpis = data?.kpis;
  const rows: any[] = data?.rows ?? [];
  const money = (n: number) => `$${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  return (
    <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid #EEECE7", display: "flex", alignItems: "center", gap: 8 }}>
        <Gift size={15} style={{ color: "var(--brand)" }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Referral Program — Give $25, Get $25</span>
        <select value={year} onChange={e => setYear(Number(e.target.value))}
          style={{ marginLeft: "auto", fontFamily: FF, fontSize: 12, fontWeight: 600, color: "#1A1917", border: "1px solid #E5E2DC", borderRadius: 6, padding: "5px 8px", background: "#fff" }}>
          {Array.from({ length: 3 }, (_, i) => thisYear - i).map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      {isLoading ? (
        <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /></div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, padding: "16px 20px" }}>
            {[
              { label: "Referred", value: String(kpis?.referred ?? 0) },
              { label: "Booked", value: String(kpis?.booked ?? 0) },
              { label: "Completed", value: String(kpis?.completed ?? 0) },
              { label: "Referred revenue", value: money(kpis?.referred_revenue), green: true },
              { label: "Credits given", value: money(kpis?.credits_given_dollars) },
            ].map(k => (
              <div key={k.label} style={{ background: "#F7F6F3", borderRadius: 8, padding: "12px 12px", textAlign: "center" }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: k.green ? "#0F6E56" : "#1A1917" }}>{k.value}</div>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#6B6860", marginTop: 2 }}>{k.label}</div>
              </div>
            ))}
          </div>
          {(kpis?.credits_owed ?? 0) > 0 && (
            <div style={{ margin: "0 20px 14px", padding: "10px 14px", background: "#FCEBEB", borderRadius: 8, fontSize: 12.5, color: "#A32D2D", fontWeight: 600 }}>
              {kpis.credits_owed} referrer{kpis.credits_owed !== 1 ? "s are" : " is"} owed a $25 credit — apply it to their next job, then mark it credited below.
            </div>
          )}
          {rows.length === 0 ? (
            <p style={{ padding: "0 20px 20px", fontSize: 13, color: "#9E9B94", margin: 0 }}>No program referrals in {year} yet. They come in from the booking widget's "Refer a friend or business" card.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderTop: "1px solid #EEECE7", borderBottom: "1px solid #EEECE7" }}>
                  {["Referred", "By", "Type", "Status", "Date", ""].map((h, i) => (
                    <th key={i} style={{ padding: "10px 20px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = PROGRAM_STATUS[r.status] ?? PROGRAM_STATUS.new;
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                      <td style={{ padding: "12px 20px", fontSize: 13, fontWeight: 600, color: r.lead_id ? "var(--brand)" : "#1A1917", cursor: r.lead_id ? "pointer" : "default" }}
                        onClick={() => r.lead_id && navigate(`/leads?lead=${r.lead_id}`)}>
                        {r.referred_name}
                        <div style={{ fontSize: 11.5, fontWeight: 400, color: "#9E9B94" }}>{r.referred_phone || r.referred_email || ""}</div>
                      </td>
                      <td style={{ padding: "12px 20px", fontSize: 13, color: "#1A1917" }}>{r.referrer_name || "—"}</td>
                      <td style={{ padding: "12px 20px", fontSize: 13, color: "#6B6860" }}>{r.referral_type === "commercial" ? "Business" : "Home"}</td>
                      <td style={{ padding: "12px 20px" }}>
                        <span style={{ display: "inline-block", fontSize: 10.5, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: st.bg, color: st.fg }}>{st.label}</span>
                      </td>
                      <td style={{ padding: "12px 20px", fontSize: 12.5, color: "#6B6860", whiteSpace: "nowrap" }}>
                        {r.created_at ? new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}
                      </td>
                      <td style={{ padding: "12px 20px", textAlign: "right" }}>
                        {r.status === "completed" && (
                          <button onClick={() => markCredited(r.id)} disabled={crediting === r.id}
                            style={{ fontFamily: FF, fontSize: 11.5, fontWeight: 700, color: "#0F6E56", background: "#E1F5EE", border: "none", borderRadius: 6, padding: "6px 12px", cursor: "pointer", opacity: crediting === r.id ? 0.6 : 1, whiteSpace: "nowrap" }}>
                            {crediting === r.id ? "Saving…" : "Mark $25 credited"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  google: "Google", nextdoor: "Nextdoor", facebook: "Facebook", yelp: "Yelp",
  client_referral: "Client Referral", door_hanger: "Door Hanger",
  yard_sign: "Yard Sign", website: "Website", other: "Other",
};

const COLORS = ["var(--brand)", "#22C55E", "#F59E0B", "#8B5CF6", "#EF4444", "#06B6D4", "#EC4899", "#14B8A6", "#9E9B94"];

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

        {/* Give $25 / Get $25 program tracker */}
        <ReferralProgramSection />

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
