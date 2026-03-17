import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import { Star, AlertTriangle, Send, TrendingUp, Loader2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string) {
  const r = await fetch(`${API}${path}`, { headers: getAuthHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function NpsGauge({ score }: { score: number }) {
  const pct = ((score + 100) / 200) * 100;
  const color = score >= 50 ? "#22C55E" : score >= 0 ? "#F59E0B" : "#EF4444";
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 48, fontWeight: 800, color }}>{score >= 0 ? "+" : ""}{score.toFixed(0)}</div>
      <div style={{ fontSize: 12, color: "#9E9B94", fontWeight: 500 }}>NPS Score</div>
      <div style={{ height: 6, backgroundColor: "#F0EEE9", borderRadius: 3, marginTop: 12 }}>
        <div style={{ width: `${pct}%`, height: "100%", backgroundColor: color, borderRadius: 3, transition: "width 0.4s" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#9E9B94", marginTop: 4 }}>
        <span>-100</span><span>0</span><span>+100</span>
      </div>
    </div>
  );
}

export default function SatisfactionReportPage() {
  const { data: results, isLoading } = useQuery<any>({
    queryKey: ["satisfaction-results"],
    queryFn: () => apiFetch("/api/satisfaction/results"),
  });

  const avgNps = parseFloat(results?.avg_nps ?? "0");
  const avgRating = parseFloat(results?.avg_rating ?? "0");
  const totalResponses = results?.total_responses ?? 0;
  const followUps = results?.follow_ups ?? [];

  // NPS distribution from follow_ups + responses (simplified)
  const npsGroups = [
    { label: "Detractors\n(0–6)", value: followUps.filter((f: any) => f.nps_score <= 6).length, color: "#EF4444" },
    { label: "Passives\n(7–8)", value: followUps.filter((f: any) => f.nps_score === 7 || f.nps_score === 8).length, color: "#F59E0B" },
    { label: "Promoters\n(9–10)", value: followUps.filter((f: any) => f.nps_score >= 9).length, color: "#22C55E" },
  ];

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 24, fontFamily: FF }}>
        {/* Header */}
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>NPS &amp; Satisfaction</h1>
          <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>Net Promoter Score and customer satisfaction trends</p>
        </div>

        {/* KPI Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px" }}>
            {isLoading ? <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /> : <NpsGauge score={avgNps} />}
          </div>
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 36, fontWeight: 800, color: "#1A1917" }}>{avgRating > 0 ? avgRating.toFixed(1) : "—"}</div>
            <div style={{ display: "flex", justifyContent: "center", gap: 2, margin: "4px 0 8px" }}>
              {[1,2,3,4,5].map(s => <svg key={s} width="14" height="14" viewBox="0 0 24 24" fill={s <= Math.round(avgRating) ? "#F59E0B" : "#E5E2DC"} stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>)}
            </div>
            <div style={{ fontSize: 12, color: "#9E9B94" }}>Avg Star Rating</div>
          </div>
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 36, fontWeight: 800, color: "#1A1917" }}>{totalResponses}</div>
            <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 4 }}>Total Responses</div>
          </div>
          <div style={{ backgroundColor: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 10, padding: "20px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 36, fontWeight: 800, color: "#991B1B" }}>{results?.follow_up_count ?? 0}</div>
            <div style={{ fontSize: 12, color: "#991B1B", marginTop: 4 }}>Need Follow-Up</div>
          </div>
        </div>

        {/* Follow-Up List */}
        {followUps.length > 0 && (
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #EEECE7", display: "flex", alignItems: "center", gap: 8 }}>
              <AlertTriangle size={16} style={{ color: "#EF4444" }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Follow-Up Required</span>
            </div>
            <div>
              {followUps.slice(0, 10).map((f: any) => (
                <div key={f.id} style={{ padding: "14px 20px", borderBottom: "1px solid #F0EEE9", display: "flex", gap: 16, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", marginBottom: 2 }}>{f.client_name}</div>
                    {f.comment && <div style={{ fontSize: 12, color: "#6B7280" }}>"{f.comment}"</div>}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    {f.nps_score != null && (
                      <span style={{ padding: "2px 8px", backgroundColor: "#FEE2E2", color: "#991B1B", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>NPS {f.nps_score}</span>
                    )}
                    {f.rating != null && (
                      <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12, color: "#92400E" }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="#F59E0B" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                        {f.rating}/5
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: "#9E9B94" }}>
                      {new Date(f.responded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </DashboardLayout>
  );
}
