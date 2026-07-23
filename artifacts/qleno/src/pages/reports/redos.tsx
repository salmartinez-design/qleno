import { useEffect, useState, type CSSProperties } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

interface RedosData {
  days: number;
  by_cleaner: { employee_id: number; name: string | null; hr_status: string | null; valid_count: number; total_count: number; jobs_done: number }[];
  by_client: { client_id: number; name: string; valid_count: number; invalid_count: number }[];
  by_category: { category: string; n: number }[];
  by_area: { area: string; n: number }[];
}

const card: CSSProperties = { background: "#fff", border: "1px solid #E5E2DC", borderRadius: 12, padding: "16px 18px" };
const hdr: CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: "#9E9B94", marginBottom: 10 };
const subHdr: CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", marginBottom: 6 };
const row: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, padding: "7px 0", borderTop: "1px solid #F2EFE9" };
const note: CSSProperties = { fontSize: 10.5, color: "#9E9B94", marginTop: 10, lineHeight: 1.4 };
const num: CSSProperties = { color: "#6B6860", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
function Empty() { return <div style={{ fontSize: 12, color: "#C4C0B8", padding: "8px 0" }}>No redos in this window.</div>; }

export default function RedosReportPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<RedosData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/api/reports/redos?days=${days}`, { headers: getAuthHeaders() })
      .then(r => r.json()).then((d: RedosData) => setData(d)).catch(() => setData(null)).finally(() => setLoading(false));
  }, [days]);

  const maxArea = Math.max(1, ...(data?.by_area?.map(a => Number(a.n)) ?? [1]));

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: "#1A1917", margin: 0 }}>Redos &amp; Quality</h1>
            <p style={{ fontSize: 13, color: "#6B6860", margin: "4px 0 0" }}>Re-cleans by cleaner, clients with repeat complaints, and the most common reasons.</p>
          </div>
          <select value={days} onChange={e => setDays(Number(e.target.value))} style={{ padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontFamily: FF, fontSize: 13 }}>
            <option value={30}>Last 30 days</option><option value={60}>Last 60 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option>
          </select>
        </div>

        {loading && <div style={{ color: "#9E9B94", fontSize: 13 }}>Loading&hellip;</div>}
        {!loading && data && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <div style={card}>
              <div style={hdr}>Redos by cleaner</div>
              {(data.by_cleaner || []).length === 0 && <Empty />}
              {(data.by_cleaner || []).map(r => {
                const jd = Number(r.jobs_done); const vc = Number(r.valid_count);
                const rate = jd > 0 ? Math.round((vc / jd) * 100) : null;
                return (
                  <div key={r.employee_id} style={row}>
                    <span style={{ fontWeight: 600 }}>{r.name || `#${r.employee_id}`}</span>
                    <span style={num}>{vc}{rate != null ? ` · ${rate}%` : ""}{r.hr_status === "quality_probation" ? <b style={{ color: "#B3261E" }}> · Probation</b> : ""}</span>
                  </div>
                );
              })}
            </div>

            <div style={card}>
              <div style={hdr}>Clients &mdash; repeat complaints</div>
              {(data.by_client || []).length === 0 && <Empty />}
              {(data.by_client || []).map((r, i) => (
                <div key={i} style={row}>
                  <span style={{ fontWeight: 600 }}>{r.name}</span>
                  <span style={num}>{r.valid_count} valid{Number(r.invalid_count) > 0 ? <b style={{ color: "#B3261E" }}> · {r.invalid_count} not</b> : ""}</span>
                </div>
              ))}
              <div style={note}>&ldquo;Not&rdquo; = complaints the office didn&rsquo;t uphold &mdash; watch for guarantee abuse.</div>
            </div>

            <div style={{ ...card, gridColumn: "1 / -1" }}>
              <div style={hdr}>Top reasons &amp; areas</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                <div>
                  <div style={subHdr}>Category</div>
                  {(data.by_category || []).length === 0 && <Empty />}
                  {(data.by_category || []).map((c, i) => (<div key={i} style={row}><span>{c.category}</span><span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{c.n}</span></div>))}
                </div>
                <div>
                  <div style={subHdr}>Area</div>
                  {(data.by_area || []).length === 0 && <Empty />}
                  {(data.by_area || []).map((a, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
                      <span style={{ width: 92, fontSize: 12, color: "#6B6860", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.area}</span>
                      <span style={{ flex: 1, height: 8, background: "#F0EEE9", borderRadius: 5, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${Math.round((Number(a.n) / maxArea) * 100)}%`, background: "var(--brand)" }} /></span>
                      <span style={{ width: 22, textAlign: "right", fontWeight: 700, fontSize: 12 }}>{a.n}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
