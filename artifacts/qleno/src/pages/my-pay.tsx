// [my-pay 2026-07-04] Employee-facing "My Pay" — each employee sees ONLY their
// own PUBLISHED pay. Data comes from GET /api/payroll/pay-history with NO
// user_id param, which the server scopes to the caller: a technician is locked
// to their own user_id server-side (a passed id is ignored), so this page can
// never show another person's pay. Cascades automatically: the moment the
// office hits Publish on a period, that period's snapshot appears here.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useEmployeeView } from "@/contexts/employee-view-context";
import { Lock, ChevronDown, ChevronUp } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";
const money = (n: any) => `$${Number(n || 0).toFixed(2)}`;

type Week = {
  pay_period_start: string; pay_period_end: string;
  gross: string | number; base: string | number; hours: string | number;
  tips: string | number; overtime: string | number; bonus: string | number;
  adjustments: string | number; breakdown: any; published_at: string;
};

function fmtRange(s: string, e: string) {
  const d = (x: string) => { const [, m, day] = x.split("-"); return `${parseInt(m)}/${parseInt(day)}`; };
  return `${d(s)} – ${d(e)}, ${s.slice(0, 4)}`;
}

export default function MyPayPage() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  // [preview-fix 2026-07-07] "View as Employee" must be a TRUE view-as (Sal):
  // in preview, load the previewed employee's published pay via the office
  // path (?user_id=) instead of the owner's own /me scope. The server still
  // locks technicians to their own id — this only widens what an office
  // caller previews, same as the employee-profile Pay tab.
  const { employeeView } = useEmployeeView();
  const previewId = employeeView?.employeeId ?? null;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["my-pay", previewId],
    queryFn: async () => {
      const url = previewId
        ? `${API}/api/payroll/pay-history?user_id=${previewId}`
        : `${API}/api/payroll/pay-history`;
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error("Failed to load pay");
      return res.json() as Promise<{ weeks: Week[]; scoped: string }>;
    },
  });

  const weeks: Week[] = data?.weeks ?? [];
  const latest = weeks[0];
  const ytdGross = weeks
    .filter(w => String(w.pay_period_start).slice(0, 4) === String(new Date().getFullYear()))
    .reduce((s, w) => s + Number(w.gross || 0), 0);

  const CARD: React.CSSProperties = { background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 20 };

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 18, fontFamily: FF, maxWidth: 760 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: "#1A1917", margin: 0, letterSpacing: "-0.02em" }}>My Pay</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, color: "#6B6860", fontSize: 13 }}>
            <Lock size={13} /> Only you can see this — your pay is private to your account.
          </div>
        </div>

        {/* Summary cards: most recent published + year-to-date */}
        {!isLoading && !isError && weeks.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            <div style={CARD}>
              <p style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>Most recent pay</p>
              <p style={{ fontSize: 26, fontWeight: 800, color: "var(--brand)", margin: 0 }}>{money(latest.gross)}</p>
              <p style={{ fontSize: 12, color: "#9DA3B0", margin: "6px 0 0" }}>{fmtRange(latest.pay_period_start, latest.pay_period_end)}</p>
            </div>
            <div style={CARD}>
              <p style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>Year to date</p>
              <p style={{ fontSize: 26, fontWeight: 800, color: "#1A1917", margin: 0 }}>{money(ytdGross)}</p>
              <p style={{ fontSize: 12, color: "#9DA3B0", margin: "6px 0 0" }}>{weeks.length} published {weeks.length === 1 ? "period" : "periods"}</p>
            </div>
          </div>
        )}

        <div style={{ ...CARD, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid #EEECE7", fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Published pay</div>

          {isLoading ? (
            <div style={{ padding: 24, color: "#6B6860", fontSize: 14 }}>Loading your pay…</div>
          ) : isError ? (
            <div style={{ padding: 24, color: "#B4441F", fontSize: 14 }}>Couldn't load your pay. Pull to refresh or try again shortly.</div>
          ) : weeks.length === 0 ? (
            <div style={{ padding: 24, color: "#6B6860", fontSize: 14, lineHeight: 1.5 }}>
              No published pay yet. Once the office publishes a pay period, your pay and history appear here automatically.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
              {weeks.map((w) => {
                const key = `${w.pay_period_start}_${w.pay_period_end}`;
                const open = openKey === key;
                const jobs: any[] = Array.isArray(w.breakdown) ? w.breakdown : [];
                return (
                  <div key={key} style={{ border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden", background: "#FFFFFF" }}>
                    <button onClick={() => setOpenKey(open ? null : key)}
                      style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left", fontFamily: FF }}>
                      <div>
                        <div style={{ fontWeight: 700, color: "#1A1917", fontSize: 15 }}>{fmtRange(w.pay_period_start, w.pay_period_end)}</div>
                        <div style={{ fontSize: 12, color: "#9DA3B0", marginTop: 2 }}>{Number(w.hours).toFixed(2)} hrs · published {String(w.published_at).slice(0, 10)}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontWeight: 800, color: "var(--brand)", fontSize: 18 }}>{money(w.gross)}</span>
                        {open ? <ChevronUp size={16} color="#9DA3B0" /> : <ChevronDown size={16} color="#9DA3B0" />}
                      </div>
                    </button>
                    {open && (
                      <div style={{ borderTop: "1px solid #E5E2DC", padding: "14px 16px", background: "#F7F6F3" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: "8px 24px", fontSize: 13, marginBottom: jobs.length ? 14 : 0 }}>
                          {[["Base pay (jobs)", w.base], ["Tips", w.tips], ["Overtime", w.overtime], ["Bonus", w.bonus], ["Adjustments", w.adjustments], ["Gross", w.gross]].map(([lbl, val]: any, i: number) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #E5E2DC", paddingBottom: 4 }}>
                              <span style={{ color: "#6B6860" }}>{lbl}</span>
                              <span style={{ fontWeight: lbl === "Gross" ? 800 : 600, color: lbl === "Gross" ? "var(--brand)" : "#1A1917" }}>{money(val)}</span>
                            </div>
                          ))}
                        </div>
                        {jobs.length > 0 && (
                          <div style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 420 }}>
                              <thead><tr style={{ textAlign: "left", color: "#9DA3B0" }}>
                                <th style={{ padding: "4px 0" }}>Date</th><th>Job</th><th>Basis</th>
                                <th style={{ textAlign: "right" }}>Hrs</th><th style={{ textAlign: "right" }}>Pay</th>
                              </tr></thead>
                              <tbody>
                                {jobs.map((j: any, i: number) => (
                                  <tr key={i} style={{ borderTop: "1px solid #E5E2DC" }}>
                                    <td style={{ padding: "5px 0" }}>{String(j.date).slice(5)}</td>
                                    <td>{j.client}</td>
                                    <td style={{ color: "#6B6860" }}>{j.basis}</td>
                                    <td style={{ textAlign: "right" }}>{Number(j.hours).toFixed(2)}</td>
                                    <td style={{ textAlign: "right", fontWeight: 600 }}>{money(j.amount)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <p style={{ fontSize: 12, color: "#9DA3B0", margin: 0, lineHeight: 1.5 }}>
          Pay is commission + tips + mileage. Hours are shown for your records — you're not paid hourly.
          Questions about a period? Contact the office.
        </p>
      </div>
    </DashboardLayout>
  );
}
