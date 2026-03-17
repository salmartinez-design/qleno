import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, TrendingDown, Users, Phone, Mail, Loader2, ChevronRight } from "lucide-react";
import { useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const RISK_COLORS: Record<string, { bg: string; text: string; border: string; label: string }> = {
  low:      { bg: "#DCFCE7", text: "#166534", border: "#86EFAC", label: "Low" },
  medium:   { bg: "#FEF3C7", text: "#92400E", border: "#FCD34D", label: "Medium" },
  high:     { bg: "#FEE2E2", text: "#991B1B", border: "#FCA5A5", label: "High" },
  critical: { bg: "#FEE2E2", text: "#7F1D1D", border: "#EF4444", label: "Critical" },
};

export default function ChurnBoardPage() {
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<string>("all");
  const qc = useQueryClient();

  const { data: scores = [], isLoading } = useQuery<any[]>({
    queryKey: ["churn-scores"],
    queryFn: () => apiFetch("/api/churn/scores"),
  });

  const calcMut = useMutation({
    mutationFn: () => apiFetch("/api/churn/calculate", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["churn-scores"] }),
  });

  const filtered = filter === "all" ? scores : scores.filter(s => s.risk_level === filter);

  const counts = { all: scores.length, low: 0, medium: 0, high: 0, critical: 0 };
  scores.forEach(s => { counts[s.risk_level as keyof typeof counts]++; });

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, fontFamily: FF }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>Churn Risk Board</h1>
            <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>Identify customers at risk of leaving before it's too late</p>
          </div>
          <button onClick={() => calcMut.mutate()} disabled={calcMut.isPending}
            style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
            {calcMut.isPending ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />}
            {calcMut.isPending ? "Scoring..." : "Recalculate"}
          </button>
        </div>

        {/* Risk Filters */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {(["all", "critical", "high", "medium", "low"] as const).map(r => {
            const active = filter === r;
            const style = r !== "all" ? RISK_COLORS[r] : { bg: "#F0EEE9", text: "#1A1917", border: "#E5E2DC", label: "All" };
            return (
              <button key={r} onClick={() => setFilter(r)}
                style={{ padding: "6px 14px", borderRadius: 20, border: `1px solid ${active ? style.border : "#E5E2DC"}`, backgroundColor: active ? style.bg : "#FFFFFF", color: active ? style.text : "#6B7280", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF, display: "flex", alignItems: "center", gap: 6 }}>
                {r === "all" ? "All Customers" : style.label} <span style={{ fontSize: 11, opacity: 0.7 }}>({counts[r === "all" ? "all" : r as keyof typeof counts]})</span>
              </button>
            );
          })}
        </div>

        {/* Table */}
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                {["Customer", "Risk Level", "Score", "Signals", ""].map(h => (
                  <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={5} style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>
                  <Loader2 size={18} style={{ animation: "spin 1s linear infinite", marginBottom: 8 }} /><br />Loading scores...
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>
                  {scores.length === 0 ? "No scores yet — click Recalculate to score your customers" : "No customers at this risk level"}
                </td></tr>
              ) : filtered.map((s: any) => {
                const rc = RISK_COLORS[s.risk_level] || RISK_COLORS.low;
                const signals: string[] = [];
                if (s.signals) {
                  if (s.signals.last_job_cancelled) signals.push("Last job cancelled");
                  if (s.signals.cancellations_60d) signals.push(`${s.signals.cancellations_60d} cancels (60d)`);
                  if (s.signals.invoice_overdue) signals.push("Invoice overdue");
                  if (s.signals.nps_detractor != null) signals.push(`NPS detractor (${s.signals.nps_detractor})`);
                  if (s.signals.no_comm_60d) signals.push("No contact 60d");
                  if (s.signals.new_client) signals.push("New client");
                }
                return (
                  <tr key={s.id} style={{ borderBottom: "1px solid #F0EEE9", cursor: "pointer" }}
                    onClick={() => navigate(`/customers/${s.customer_id}`)}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = "#F7F6F3"}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}>
                    <td style={{ padding: "14px 20px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 34, height: 34, borderRadius: "50%", backgroundColor: "var(--brand-dim)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                          {(s.client_name || "??").split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{s.client_name}</div>
                          <div style={{ fontSize: 11, color: "#9E9B94" }}>{s.email || s.phone || ""}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      <span style={{ ...rc, display: "inline-flex", padding: "3px 9px", borderRadius: 4, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", border: `1px solid ${rc.border}` }}>
                        {rc.label}
                      </span>
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ height: 6, width: 80, backgroundColor: "#F0EEE9", borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${s.score}%`, backgroundColor: s.score > 75 ? "#EF4444" : s.score > 50 ? "#F59E0B" : "#22C55E", borderRadius: 3 }} />
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{s.score}</span>
                      </div>
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {signals.slice(0, 3).map(sig => (
                          <span key={sig} style={{ padding: "2px 7px", backgroundColor: "#F0EEE9", borderRadius: 4, fontSize: 11, color: "#6B7280" }}>{sig}</span>
                        ))}
                        {signals.length > 3 && <span style={{ fontSize: 11, color: "#9E9B94" }}>+{signals.length - 3} more</span>}
                      </div>
                    </td>
                    <td style={{ padding: "14px 20px", textAlign: "right" }}>
                      <ChevronRight size={14} style={{ color: "#9E9B94" }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </DashboardLayout>
  );
}
