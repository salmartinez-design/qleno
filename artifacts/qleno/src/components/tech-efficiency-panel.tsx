// [tech-efficiency 2026-07-24] The tech's trailing-90-day rolling efficiency,
// shown on the My Jobs home when they tap the Efficiency tile (mirrors the score
// tile). Efficiency = Allowed ÷ Actual job hours (≥100% = under budget = good) —
// Qleno's one canonical metric. Headline = median across service types (same as
// the day tile); a per-service-type breakdown sits below. Self-scoped
// server-side; threads employeeId so the office "Viewing as" preview follows.
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const authHeaders = () => getAuthHeaders() as Record<string, string>;

// Same thresholds as the day Efficiency tile: ≥100 good, ≥85 watch, else behind.
const effColor = (v: number | null | undefined) =>
  v == null ? "#C9CCD6" : v >= 100 ? "#0F9D77" : v >= 85 ? "#B7791F" : "#B3261E";
const pctText = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)}%`);

interface EffType { service_type: string; service_type_name: string | null; allowed: number; actual: number; jobs: number; pct: number | null }
interface Efficiency {
  efficiency_pct: number | null; overall_pct: number | null;
  by_type: EffType[]; job_count: number; window: string;
}

const prettyType = (t: EffType) =>
  t.service_type_name ||
  t.service_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

export function TechEfficiencyPanel({ employeeId }: { employeeId?: number }) {
  const qs = employeeId ? `?employee_id=${employeeId}` : "";

  const effQ = useQuery<Efficiency | null>({
    queryKey: ["tech-efficiency", employeeId ?? "self"],
    queryFn: async () => { const r = await fetch(`${API}/api/tech/efficiency${qs}`, { headers: authHeaders() }); return r.ok ? r.json() : null; },
    staleTime: 60_000,
  });

  const eff = effQ.data;
  const pct = eff?.efficiency_pct;

  return (
    <div style={{ fontFamily: FF }}>
      {effQ.isLoading ? (
        <div style={{ textAlign: "center", padding: 30, color: "#9E9B94", fontSize: 13 }}>Loading…</div>
      ) : (
        <div>
          {/* Headline efficiency */}
          <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 18, marginBottom: 16, textAlign: "center" }}>
            <div style={{ fontSize: 40, fontWeight: 800, color: effColor(pct), lineHeight: 1 }}>
              {pct == null ? "—" : `${Math.round(pct)}%`}
            </div>
            <div style={{ fontSize: 12.5, color: "#9E9B94", marginTop: 6 }}>
              Your efficiency · rolling, trailing 90 days
            </div>
            {eff && eff.job_count > 0 && (
              <div style={{ fontSize: 11.5, color: "#9E9B94", marginTop: 3 }}>
                {eff.overall_pct != null ? `${eff.overall_pct}% overall · ` : ""}{eff.job_count} job{eff.job_count === 1 ? "" : "s"}
              </div>
            )}
          </div>

          {/* Breakdown by service type — allowed vs actual + each type's % */}
          {eff && eff.by_type.length > 0 ? (
            <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "6px 14px 8px" }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: "#9E9B94", padding: "12px 0 4px" }}>By service type · trailing 90 days</div>
              {eff.by_type.map((t, i) => (
                <div key={t.service_type} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 0", borderTop: i ? "1px solid #F0EEE9" : "none" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{prettyType(t)}</div>
                    <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>
                      {t.allowed.toFixed(1)} allowed / {t.actual.toFixed(1)} actual · {t.jobs} job{t.jobs === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: effColor(t.pct), flexShrink: 0 }}>{pctText(t.pct)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "26px 16px", color: "#9E9B94", fontSize: 13, border: "1px dashed #E5E2DC", borderRadius: 12, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <Gauge size={20} style={{ color: "#C9C4BA" }} />
              No efficiency yet. It builds up as you complete clocked jobs over the last 90 days.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
