import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, TrendingUp, TrendingDown, Minus, Send } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string) {
  const r = await fetch(`${API}${path}`, { headers: getAuthHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function SkeletonCard() {
  return <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px", height: 100, background: "linear-gradient(90deg,#F7F6F3 25%,#EEECE7 50%,#F7F6F3 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.2s infinite" }} />;
}

function NpsScore({ score }: { score: number | null }) {
  if (score === null) return <div style={{ fontSize: 38, fontWeight: 800, color: "#9E9B94" }}>—</div>;
  const color = score >= 50 ? "#16A34A" : score >= 0 ? "#D97706" : "#DC2626";
  return (
    <div>
      <div style={{ fontSize: 38, fontWeight: 800, color }}>{score >= 0 ? "+" : ""}{score}</div>
      <div style={{ height: 4, background: "#F0EEE9", borderRadius: 2, marginTop: 8 }}>
        <div style={{ height: "100%", borderRadius: 2, background: color, width: `${((score + 100) / 200) * 100}%`, transition: "width 0.4s" }} />
      </div>
    </div>
  );
}

export default function SatisfactionReportPage() {
  const [activeTab, setActiveTab] = useState<"overview" | "history">("overview");

  const { data: results, isLoading } = useQuery<any>({
    queryKey: ["satisfaction-results"],
    queryFn: () => apiFetch("/api/satisfaction/results"),
  });

  const nps = results?.nps_rolling_30d ?? null;
  const avgRating = results?.avg_rating_30d ?? null;
  const sentCount = results?.surveys_sent_30d ?? 0;
  const respondedCount = results?.surveys_responded_30d ?? 0;
  const responseRate = results?.response_rate_pct ?? 0;
  const followUpCount = results?.follow_up_queue_count ?? 0;
  const followUps = results?.follow_ups ?? [];
  const techRatings: any[] = results?.nps_by_employee ?? [];
  const history: any[] = results?.history ?? [];

  const lowResponseRate = sentCount > 0 && responseRate < 20;

  const benchmarkPos = nps !== null
    ? nps >= 52 ? "above" : nps >= 38 ? "within" : "below"
    : null;
  const benchmarkBorder = benchmarkPos === "above" ? "#16A34A" : benchmarkPos === "within" ? "#D97706" : "#DC2626";
  const benchmarkBg = benchmarkPos === "above" ? "#F0FDF4" : benchmarkPos === "within" ? "#FFFBEB" : "#FEF2F2";
  const benchmarkText = benchmarkPos === "above" ? "Above benchmark" : benchmarkPos === "within" ? "Within benchmark" : "Below benchmark";

  const tabStyle = (id: string) => ({
    padding: "8px 16px", border: "none", background: "none", cursor: "pointer", fontSize: 13,
    fontWeight: activeTab === id ? 700 : 400, color: activeTab === id ? "var(--brand)" : "#6B7280",
    borderBottom: `2px solid ${activeTab === id ? "var(--brand)" : "transparent"}`, fontFamily: FF,
  } as React.CSSProperties);

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 24, fontFamily: FF }}>
        {/* Header */}
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>NPS &amp; Satisfaction</h1>
          <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>30-day rolling Net Promoter Score and customer satisfaction trends</p>
        </div>

        {/* 4 stat cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          {isLoading ? [1,2,3,4].map(i => <SkeletonCard key={i} />) : (
            <>
              <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 8 }}>Rolling 30-Day NPS</div>
                <NpsScore score={nps} />
              </div>
              <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 8 }}>Avg Rating (30 days)</div>
                <div style={{ fontSize: 38, fontWeight: 800, color: "#1A1917" }}>{avgRating ? avgRating.toFixed(1) : "—"}</div>
                {avgRating && (
                  <div style={{ display: "flex", gap: 2, marginTop: 4 }}>
                    {[1,2,3,4,5].map(s => (
                      <svg key={s} width="14" height="14" viewBox="0 0 24 24" fill={s <= Math.round(avgRating) ? "#F59E0B" : "#E5E2DC"} stroke="none">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ background: lowResponseRate ? "#FEF3C7" : "#FFFFFF", border: `1px solid ${lowResponseRate ? "#FCD34D" : "#E5E2DC"}`, borderRadius: 10, padding: "20px 24px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: lowResponseRate ? "#92400E" : "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 8 }}>Response Rate</div>
                <div style={{ fontSize: 38, fontWeight: 800, color: lowResponseRate ? "#92400E" : "#1A1917" }}>{responseRate}%</div>
                <div style={{ fontSize: 11, color: lowResponseRate ? "#92400E" : "#9E9B94", marginTop: 4 }}>{respondedCount} of {sentCount} surveys</div>
                {lowResponseRate && (
                  <div style={{ fontSize: 11, color: "#92400E", marginTop: 6, fontWeight: 500 }}>Low — consider adjusting send timing</div>
                )}
              </div>
              <div style={{ background: followUpCount > 0 ? "#FEF2F2" : "#FFFFFF", border: `1px solid ${followUpCount > 0 ? "#FCA5A5" : "#E5E2DC"}`, borderRadius: 10, padding: "20px 24px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: followUpCount > 0 ? "#991B1B" : "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 8 }}>Follow-Up Required</div>
                <div style={{ fontSize: 38, fontWeight: 800, color: followUpCount > 0 ? "#991B1B" : "#1A1917" }}>{followUpCount}</div>
                <div style={{ fontSize: 11, color: followUpCount > 0 ? "#991B1B" : "#9E9B94", marginTop: 4 }}>NPS detractors needing outreach</div>
              </div>
            </>
          )}
        </div>

        {/* NPS Benchmark card */}
        {!isLoading && nps !== null && benchmarkPos && (
          <div style={{ background: benchmarkBg, border: `1.5px solid ${benchmarkBorder}`, borderRadius: 10, padding: "16px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>Industry Benchmark — Residential Cleaning: 38–52 NPS</p>
                <p style={{ fontSize: 13, color: "#374151", margin: 0 }}>
                  Your current score: <strong>{nps >= 0 ? "+" : ""}{nps}</strong> — <span style={{ color: benchmarkBorder, fontWeight: 700 }}>{benchmarkText}</span>
                </p>
              </div>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: benchmarkBorder, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {benchmarkPos === "above" ? <TrendingUp size={18} color="#FFFFFF" /> : benchmarkPos === "within" ? <Minus size={18} color="#FFFFFF" /> : <TrendingDown size={18} color="#FFFFFF" />}
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ borderBottom: "1px solid #EEECE7", display: "flex", paddingLeft: 4 }}>
            <button style={tabStyle("overview")} onClick={() => setActiveTab("overview")}>Ratings by Technician</button>
            <button style={tabStyle("history")} onClick={() => setActiveTab("history")}>
              Survey History {followUpCount > 0 ? `· ${followUpCount} need follow-up` : ""}
            </button>
          </div>

          {activeTab === "overview" && (
            <>
              {isLoading ? (
                <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>Loading…</div>
              ) : techRatings.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>No survey responses yet — send surveys after completed jobs.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                      {["Technician", "Avg Rating", "Avg NPS", "Responses"].map(h => (
                        <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {techRatings.map((t: any, i: number) => (
                      <tr key={i} style={{ borderBottom: "1px solid #F0EEE9" }}>
                        <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{t.name || "Unassigned"}</td>
                        <td style={{ padding: "14px 20px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{t.avg_rating ? parseFloat(t.avg_rating).toFixed(1) : "—"}</span>
                            {t.avg_rating && (
                              <div style={{ display: "flex", gap: 1 }}>
                                {[1,2,3,4,5].map(s => <svg key={s} width="11" height="11" viewBox="0 0 24 24" fill={s <= Math.round(t.avg_rating) ? "#F59E0B" : "#E5E2DC"} stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>)}
                              </div>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280" }}>
                          {t.avg_nps != null ? (parseFloat(t.avg_nps) >= 0 ? "+" : "") + parseFloat(t.avg_nps).toFixed(0) : "—"}
                        </td>
                        <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280" }}>{t.response_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* Follow-up queue */}
              {followUps.length > 0 && (
                <div style={{ borderTop: "1px solid #EEECE7" }}>
                  <div style={{ padding: "14px 20px", display: "flex", alignItems: "center", gap: 8 }}>
                    <AlertTriangle size={15} style={{ color: "#EF4444" }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>Follow-Up Queue ({followUps.length})</span>
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                        {["Customer", "NPS", "Rating", "Date", "Action"].map(h => (
                          <th key={h} style={{ padding: "10px 20px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {followUps.map((f: any) => (
                        <tr key={f.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                          <td style={{ padding: "12px 20px" }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{f.client_name}</div>
                            {f.comment && <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>"{f.comment}"</div>}
                          </td>
                          <td style={{ padding: "12px 20px" }}>
                            {f.nps_score != null && <span style={{ padding: "2px 8px", background: "#FEE2E2", color: "#991B1B", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>{f.nps_score}</span>}
                          </td>
                          <td style={{ padding: "12px 20px", fontSize: 13, color: "#6B7280" }}>{f.rating ? `${f.rating}/5` : "—"}</td>
                          <td style={{ padding: "12px 20px", fontSize: 12, color: "#9E9B94" }}>
                            {f.responded_at ? new Date(f.responded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                          </td>
                          <td style={{ padding: "12px 20px" }}>
                            <a href={`/customers/${f.customer_id}?tab=comm-log`}
                              style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", background: "var(--brand)", color: "#FFFFFF", borderRadius: 6, fontSize: 11, fontWeight: 600, textDecoration: "none" }}>
                              <Send size={10} /> Log Outreach
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {activeTab === "history" && (
            <>
              {isLoading ? (
                <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>Loading…</div>
              ) : history.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>No surveys sent yet.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                      {["Customer", "Sent", "Responded", "NPS", "Rating", "Status"].map(h => (
                        <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((s: any) => (
                      <tr key={s.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                        <td style={{ padding: "12px 20px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{s.client_name}</td>
                        <td style={{ padding: "12px 20px", fontSize: 12, color: "#6B7280" }}>
                          {s.sent_at ? new Date(s.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                        </td>
                        <td style={{ padding: "12px 20px", fontSize: 12, color: "#6B7280" }}>
                          {s.responded_at ? new Date(s.responded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                        </td>
                        <td style={{ padding: "12px 20px" }}>
                          {s.nps_score != null ? (
                            <span style={{ padding: "2px 7px", background: s.nps_score >= 9 ? "#DCFCE7" : s.nps_score >= 7 ? "#FEF3C7" : "#FEE2E2", color: s.nps_score >= 9 ? "#166534" : s.nps_score >= 7 ? "#92400E" : "#991B1B", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>{s.nps_score}</span>
                          ) : <span style={{ fontSize: 12, color: "#9E9B94" }}>—</span>}
                        </td>
                        <td style={{ padding: "12px 20px", fontSize: 13, color: "#6B7280" }}>{s.rating ? `${s.rating}/5` : "—"}</td>
                        <td style={{ padding: "12px 20px" }}>
                          {s.suppressed ? (
                            <span style={{ padding: "2px 7px", background: "#F3F4F6", color: "#6B7280", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>Suppressed</span>
                          ) : s.responded_at ? (
                            <span style={{ padding: "2px 7px", background: "#DCFCE7", color: "#166534", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>Responded</span>
                          ) : (
                            <span style={{ padding: "2px 7px", background: "#FEF3C7", color: "#92400E", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>Pending</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
      <style>{`@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }`}</style>
    </DashboardLayout>
  );
}
