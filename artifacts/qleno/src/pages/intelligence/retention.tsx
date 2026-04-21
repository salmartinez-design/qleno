import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Loader2, ChevronRight } from "lucide-react";
import { useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const RISK_COLORS: Record<string, { bg: string; text: string; border: string; label: string }> = {
  low:      { bg: "#DCFCE7", text: "#166534", border: "#86EFAC", label: "Low Risk" },
  medium:   { bg: "#FEF3C7", text: "#92400E", border: "#FCD34D", label: "Watch" },
  high:     { bg: "#FEE2E2", text: "#991B1B", border: "#FCA5A5", label: "At Risk" },
  critical: { bg: "#FEE2E2", text: "#7F1D1D", border: "#EF4444", label: "Flight Risk" },
};

export default function RetentionBoardPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const { data: scores = [], isLoading } = useQuery<any[]>({
    queryKey: ["retention-scores"],
    queryFn: () => apiFetch("/api/retention/scores"),
  });

  const calcMut = useMutation({
    mutationFn: () => apiFetch("/api/retention/calculate", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["retention-scores"] }),
  });

  const totals = { critical: 0, high: 0, medium: 0, low: 0 };
  scores.forEach((s: any) => { totals[s.risk_level as keyof typeof totals]++; });

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, fontFamily: FF }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>Tech Retention Board</h1>
            <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>Monitor flight risk for your cleaning technicians</p>
          </div>
          <button onClick={() => calcMut.mutate()} disabled={calcMut.isPending}
            style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
            {calcMut.isPending ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />}
            {calcMut.isPending ? "Scoring..." : "Recalculate"}
          </button>
        </div>

        {/* Summary cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {(["critical", "high", "medium", "low"] as const).map(r => {
            const rc = RISK_COLORS[r];
            return (
              <div key={r} style={{ backgroundColor: rc.bg, border: `1px solid ${rc.border}`, borderRadius: 10, padding: "16px 20px" }}>
                <div style={{ fontSize: 24, fontWeight: 800, color: rc.text }}>{totals[r]}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: rc.text, marginTop: 2 }}>{rc.label}</div>
              </div>
            );
          })}
        </div>

        {/* Table */}
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                {["Technician", "Risk", "Flight Score", "Tenure", "Jobs (30d)", "Avg Rating", ""].map(h => (
                  <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>
                  <Loader2 size={18} style={{ animation: "spin 1s linear infinite", marginBottom: 8 }} /><br />Loading retention data...
                </td></tr>
              ) : scores.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>
                  No data yet — click Recalculate to generate retention scores
                </td></tr>
              ) : scores.map((s: any) => {
                const rc = RISK_COLORS[s.risk_level] || RISK_COLORS.low;
                const tenure = s.tenure_days ? (s.tenure_days >= 365 ? `${Math.floor(s.tenure_days / 365)}y` : `${s.tenure_days}d`) : "—";
                return (
                  <tr key={s.employee_id} style={{ borderBottom: "1px solid #F0EEE9", cursor: "pointer" }}
                    onClick={() => navigate(`/employees/${s.employee_id}`)}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = "#F7F6F3"}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}>
                    <td style={{ padding: "14px 20px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 34, height: 34, borderRadius: "50%", backgroundColor: "var(--brand-dim)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>
                          {(s.employee_name || "??").split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{s.employee_name}</div>
                          <div style={{ fontSize: 11, color: "#9E9B94", textTransform: "capitalize" }}>{(s.role || "").replace("_", " ")}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      <span style={{ ...rc, display: "inline-flex", padding: "3px 9px", borderRadius: 4, fontSize: 11, fontWeight: 700, border: `1px solid ${rc.border}` }}>
                        {rc.label}
                      </span>
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ height: 6, width: 80, backgroundColor: "#F0EEE9", borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${s.flight_risk_score}%`, backgroundColor: s.flight_risk_score > 75 ? "#EF4444" : s.flight_risk_score > 50 ? "#F59E0B" : "#22C55E", borderRadius: 3 }} />
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{s.flight_risk_score}</span>
                      </div>
                    </td>
                    <td style={{ padding: "14px 20px", fontSize: 13, color: "#1A1917" }}>{tenure}</td>
                    <td style={{ padding: "14px 20px", fontSize: 13, color: "#1A1917" }}>{s.jobs_completed_30d ?? "—"}</td>
                    <td style={{ padding: "14px 20px" }}>
                      {s.avg_rating_30d ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 13, color: "#1A1917", fontWeight: 500 }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="#F59E0B" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                          {parseFloat(s.avg_rating_30d).toFixed(1)}
                        </span>
                      ) : <span style={{ color: "#9E9B94", fontSize: 13 }}>—</span>}
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
