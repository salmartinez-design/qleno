import { useState, useEffect, useCallback } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Loader2, Building2, TrendingUp } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

interface CompanyRoll {
  company_id: number; name: string;
  jobs_total: number; jobs_upcoming: number; revenue: number;
  leads_total: number; leads_open: number; pipeline_value: number;
}
interface Rollup {
  eligible: boolean; owned_count: number;
  companies: CompanyRoll[];
  combined: { jobs_total: number; jobs_upcoming: number; revenue: number; leads_total: number; leads_open: number; pipeline_value: number } | null;
}

const money = (n: number) => "$" + Math.round(n).toLocaleString();
const card: React.CSSProperties = { background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: 18 };
const lbl: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.04em" };

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={lbl}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: "#1A1917", marginTop: 4, fontFamily: FF }}>{value}</div>
    </div>
  );
}

export default function AllLocationsPage() {
  const [data, setData] = useState<Rollup | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/rollup`, { headers: getAuthHeaders() });
      if (r.ok) setData(await r.json());
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 0 40px", fontFamily: FF }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 6px", display: "flex", alignItems: "center", gap: 8 }}>
          <Building2 size={22} /> All Locations
        </h1>
        <p style={{ margin: "0 0 20px", fontSize: 14, color: "#6B6860" }}>
          Combined owner roll-up across the locations you own.
        </p>

        {loading || !data ? (
          <div style={{ textAlign: "center", padding: 80 }}>
            <Loader2 size={24} className="animate-spin" color="#6B6860" style={{ margin: "0 auto" }} />
          </div>
        ) : (data.companies.length === 0) ? (
          <div style={{ ...card, textAlign: "center", color: "#6B6860" }}>
            No owned locations to roll up.
          </div>
        ) : (
          <>
            {/* Combined totals */}
            {data.combined && data.companies.length > 1 && (
              <div style={{ ...card, marginBottom: 18, background: "var(--brand-dim, #EFF6FF)", border: "1px solid rgba(91,155,213,0.3)" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--brand, #2D9B83)", marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                  <TrendingUp size={16} /> Combined — all {data.companies.length} locations
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16 }}>
                  <Metric label="Revenue" value={money(data.combined.revenue)} />
                  <Metric label="Jobs" value={String(data.combined.jobs_total)} />
                  <Metric label="Upcoming" value={String(data.combined.jobs_upcoming)} />
                  <Metric label="Leads" value={String(data.combined.leads_total)} />
                  <Metric label="Open leads" value={String(data.combined.leads_open)} />
                  <Metric label="Pipeline" value={money(data.combined.pipeline_value)} />
                </div>
              </div>
            )}

            {/* Per-location */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
              {data.companies.map(c => (
                <div key={c.company_id} style={card}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", marginBottom: 14 }}>{c.name}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <Metric label="Revenue" value={money(c.revenue)} />
                    <Metric label="Jobs" value={String(c.jobs_total)} />
                    <Metric label="Upcoming" value={String(c.jobs_upcoming)} />
                    <Metric label="Leads" value={String(c.leads_total)} />
                    <Metric label="Open leads" value={String(c.leads_open)} />
                    <Metric label="Pipeline" value={money(c.pipeline_value)} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
