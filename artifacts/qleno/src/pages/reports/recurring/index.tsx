import { useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useReportData } from "../_shared";

// [recurring-revenue 2026-07-12] Recurring Revenue module — Phase 1, RESIDENTIAL.
// Reads GET /api/recurring/overview (SELECT-only) and renders the live Data
// Health + Dashboard. Analytics / Growth / Commissions / Capture land next.

const C = {
  card: "#FFFFFF", ink: "#1A1917", grey: "#6B6860", faint: "#9A968E",
  line: "#E5E2DC", lineSoft: "#EEEBE4", tint: "#FAF9F6", tint2: "#F3F1EC",
  mint: "#00C9A0", mintDeep: "#0A8F76", mintBg: "#E7F7F2",
  amber: "#C6791A", amberBg: "#FBF1E1", red: "#B3261E", redBg: "#FBEBEB",
};
const FF = "'Plus Jakarta Sans', sans-serif";
const money = (n: number | null | undefined) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

interface Issue { severity: "blocker" | "high"; key: string; title: string; detail: string; count: number; }
interface Overview {
  client_type: string;
  data_health: {
    total_active: number; computable: number; blocked_zero_rate: number; blocked_no_multiplier: number;
    derived_mrr: number; confidence: number; issues: Issue[];
  };
  dashboard: {
    active_recurring: number; active_total: number; mrr: number; confidence: number;
    paused: number; lost: number; starting_this_week: number; capture_started: boolean;
    cadence_breakdown: Array<{ cadence: string; count: number; mrr: number; computable: number }>;
  };
}

interface ClientRow {
  client_id: number; name: string; city: string | null; cadence: string; cadence_key: string;
  rate: number | null; mrr: number | null; mrr_computable: boolean; mrr_reason: string | null;
  cleaner: string | null; start_date: string | null; status: string;
}
interface ClientsResp { count: number; total_mrr: number; clients: ClientRow[] }
interface AnalyticsResp {
  total_active: number; computable: number; total_mrr: number;
  avg_client_value_month: number; avg_client_value_visit: number;
  portfolio: Array<{ cadence: string; count: number; count_pct: number; mrr: number; mrr_pct: number }>;
  acquisition_monthly: Array<{ month: string; count: number }>;
  churn: { lost_all_time: number; capture_started: boolean };
}

const TABS = [
  { k: "clients", label: "Clients", live: true },
  { k: "dash", label: "Dashboard", live: true },
  { k: "analytics", label: "Analytics", live: true },
  { k: "growth", label: "Growth", live: false },
  { k: "commissions", label: "Commissions", live: false },
];

export default function RecurringRevenuePage() {
  const [tab, setTab] = useState("clients");
  const { data, loading, error } = useReportData<Overview>("/recurring/overview");
  const { data: clientsData, loading: clientsLoading } = useReportData<ClientsResp>("/recurring/clients");
  const { data: analyticsData, loading: analyticsLoading } = useReportData<AnalyticsResp>("/recurring/analytics");

  const db = data?.dashboard;

  return (
    <DashboardLayout>
      <div style={{ padding: "22px 26px 56px", fontFamily: FF, color: C.ink, fontVariantNumeric: "tabular-nums" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: 23, fontWeight: 800, letterSpacing: "-.02em", margin: 0 }}>Ares</h1>
            <p style={{ color: C.grey, fontSize: 14, margin: "3px 0 0" }}>Recurring revenue, retention &amp; VA commission — computed from your own data.</p>
          </div>
          <span style={{ marginLeft: "auto", border: `1px solid ${C.line}`, background: "#fff", borderRadius: 999, padding: "7px 6px 7px 14px", fontSize: 13, fontWeight: 700, display: "inline-flex", gap: 10, alignItems: "center" }}>
            <span style={{ background: C.mintBg, color: C.mintDeep, borderRadius: 999, padding: "3px 11px", fontSize: 12 }}>Residential</span>
            <span style={{ color: C.faint, fontWeight: 600, fontSize: 12 }}>Commercial</span>
          </span>
        </div>

        {/* tabs */}
        <div style={{ display: "flex", gap: 26, borderBottom: `1px solid ${C.line}`, margin: "18px 0 24px", flexWrap: "wrap" }}>
          {TABS.map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} style={{
              appearance: "none", border: 0, background: "none", font: "inherit", cursor: "pointer",
              padding: "0 2px 14px", color: tab === t.k ? C.ink : C.grey, fontWeight: 700, fontSize: 14.5,
              borderBottom: `2.5px solid ${tab === t.k ? C.mint : "transparent"}`, marginBottom: -1,
              display: "inline-flex", alignItems: "center", gap: 8,
            }}>
              {t.label}
              {!t.live && <span style={{ background: C.tint2, color: C.faint, borderRadius: 999, fontSize: 11, padding: "1px 8px", fontWeight: 800 }}>Soon</span>}
            </button>
          ))}
        </div>

        {tab === "clients" && <Clients data={clientsData} loading={clientsLoading} />}
        {tab === "analytics" && <Analytics data={analyticsData} loading={analyticsLoading} />}

        {tab === "dash" && (
          <>
            {loading && <div style={{ color: C.grey, padding: "40px 0" }}>Loading your recurring data…</div>}
            {error && !loading && (
              <div style={{ background: C.redBg, border: `1px solid #F1C9C9`, borderRadius: 14, padding: "18px 20px", color: C.red, fontWeight: 600 }}>
                Couldn't load this view: {error}. Try refreshing — if it persists, tell me.
              </div>
            )}
            {!loading && db && <Dashboard db={db} />}
          </>
        )}

        {["growth", "commissions"].includes(tab) && (
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "40px 28px", textAlign: "center", color: C.grey }}>
            <div style={{ fontWeight: 800, color: C.ink, marginBottom: 4 }}>Building this next</div>
            <div style={{ fontSize: 13.5 }}>{TABS.find(t => t.k === tab)?.label} runs on the same live data — coming right after this.</div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

function card(): React.CSSProperties {
  return { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, boxShadow: "0 1px 2px rgba(20,18,14,.04), 0 10px 30px rgba(20,18,14,.05)" };
}
function eyebrow(): React.CSSProperties {
  return { fontSize: 11, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: C.faint };
}

function Dashboard({ db }: { db: Overview["dashboard"] }) {
  const cell = (big: string, lab: string, sub: string, mut?: boolean) => (
    <div style={{ flex: 1, padding: "0 18px", borderLeft: `1px solid ${C.lineSoft}` }}>
      <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1.05, color: mut ? C.faint : C.ink }}>{big}</div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: C.faint, marginTop: 7 }}>{lab}</div>
      <div style={{ fontSize: 12, color: C.grey, marginTop: 3 }}>{sub}</div>
    </div>
  );
  return (
    <>
      {!db.capture_started && (
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", borderRadius: 14, padding: "16px 18px", fontSize: 13.5, background: C.mintBg, border: "1px solid #C4EFE3", marginBottom: 16 }}>
          <div><b style={{ fontWeight: 800 }}>Capture starts today.</b> Paused, lost, and acquisition numbers fill in from here forward — they can't be back-computed, which is why capture ships before the dashboards. MRR below is live now.</div>
        </div>
      )}
      <div style={card()}>
        <div style={{ display: "flex", padding: "20px 6px" }}>
          <div style={{ flex: 1, padding: "0 18px" }}>
            <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1.05 }}>{db.active_recurring}</div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: C.faint, marginTop: 7 }}>Active Recurring</div>
            <div style={{ fontSize: 12, color: C.grey, marginTop: 3 }}>of {db.active_total} · {db.active_total - db.active_recurring} pending data</div>
          </div>
          {cell(money(db.mrr), "MRR", `${db.confidence}% confidence`)}
          {cell(db.paused ? String(db.paused) : "—", "Paused", "captured forward", !db.paused)}
          {cell(db.lost ? String(db.lost) : "—", "Lost · all time", "captured forward", !db.lost)}
          {cell(db.starting_this_week ? String(db.starting_this_week) : "—", "Starting this wk", "from 1st-clean date", !db.starting_this_week)}
        </div>
      </div>

      <div style={{ ...card(), marginTop: 16, padding: "22px 24px", maxWidth: 560 }}>
        <div style={eyebrow()}>MRR by cadence · live</div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
          <thead><tr>
            <th style={{ textAlign: "left", border: 0, padding: "12px 0", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: C.faint, fontWeight: 800 }}>Cadence</th>
            <th style={{ textAlign: "right", border: 0, fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: C.faint, fontWeight: 800 }}>Clients</th>
            <th style={{ textAlign: "right", border: 0, fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: C.faint, fontWeight: 800 }}>MRR</th>
          </tr></thead>
          <tbody>
            {db.cadence_breakdown.map((c) => {
              const blocked = c.computable === 0;
              return (
                <tr key={c.cadence}>
                  <td style={{ padding: "11px 0", borderTop: `1px solid ${C.lineSoft}`, color: blocked ? C.grey : C.ink }}>{c.cadence}{blocked && <span style={{ marginLeft: 8, background: C.tint2, color: C.grey, fontSize: 11, fontWeight: 800, padding: "2px 9px", borderRadius: 999 }}>blocked</span>}</td>
                  <td style={{ padding: "11px 0", borderTop: `1px solid ${C.lineSoft}`, textAlign: "right", color: blocked ? C.grey : C.ink }}>{c.count}</td>
                  <td style={{ padding: "11px 0", borderTop: `1px solid ${C.lineSoft}`, textAlign: "right", fontWeight: 700, color: blocked ? C.grey : C.ink }}>{blocked ? "—" : money(c.mrr)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  if (isNaN(t.getTime())) return "—";
  return t.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
}

function Clients({ data, loading }: { data: ClientsResp | null; loading: boolean }) {
  const [, setLocation] = useLocation();
  if (loading) return <div style={{ color: C.grey, padding: "40px 0" }}>Loading your recurring clients…</div>;
  if (!data) return <div style={{ color: C.grey, padding: "40px 0" }}>Couldn't load clients — try refreshing.</div>;
  const td: React.CSSProperties = { padding: "13px 18px", borderTop: `1px solid ${C.lineSoft}`, fontSize: 13.5 };
  return (
    <>
      <style>{`.rr-row{cursor:pointer} .rr-row:hover{background:${C.tint}}`}</style>
      <div style={{ ...card(), display: "flex", alignItems: "baseline", gap: 26, padding: "16px 22px", marginBottom: 16, flexWrap: "wrap" }}>
        <div><span style={{ fontSize: 24, fontWeight: 800 }}>{data.count}</span> <span style={{ color: C.grey, fontSize: 13, fontWeight: 600 }}>recurring clients</span></div>
        <div><span style={{ fontSize: 24, fontWeight: 800 }}>{money(data.total_mrr)}</span> <span style={{ color: C.grey, fontSize: 13, fontWeight: 600 }}>combined MRR</span></div>
        <span style={{ marginLeft: "auto", fontSize: 12, color: C.faint }}>Live from your active recurring schedules</span>
      </div>
      <div style={{ ...card(), overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead><tr>
              {["Client", "City", "Cadence", "Cleaner", "First cleaning", "Monthly", "Status"].map((h, i) => (
                <th key={h} style={{ textAlign: i === 5 ? "right" : "left", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: C.faint, fontWeight: 800, padding: "12px 18px", borderBottom: `1px solid ${C.line}` }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {data.clients.map((c) => (
                <tr key={c.client_id} className="rr-row" onClick={() => setLocation(`/customers/${c.client_id}`)}>
                  <td style={{ ...td, fontWeight: 700, color: C.mintDeep }}>{c.name}</td>
                  <td style={{ ...td, color: C.grey }}>{c.city || "—"}</td>
                  <td style={td}><span style={{ background: C.tint2, color: C.grey, fontSize: 11.5, fontWeight: 700, padding: "3px 10px", borderRadius: 999 }}>{c.cadence}</span></td>
                  <td style={{ ...td, color: c.cleaner ? C.ink : C.faint }}>{c.cleaner || "Unassigned"}</td>
                  <td style={{ ...td, color: C.grey }}>{fmtDate(c.start_date)}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{c.mrr_computable ? money(c.mrr) : <span style={{ color: C.amber, fontSize: 12, fontWeight: 700 }}>needs data</span>}</td>
                  <td style={td}><span style={{ background: C.mintBg, color: C.mintDeep, fontSize: 11.5, fontWeight: 700, padding: "3px 10px", borderRadius: 999 }}>Active</span></td>
                </tr>
              ))}
              {data.clients.length === 0 && (
                <tr><td colSpan={7} style={{ padding: "40px 18px", textAlign: "center", color: C.grey }}>No active recurring residential clients found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Analytics({ data, loading }: { data: AnalyticsResp | null; loading: boolean }) {
  if (loading) return <div style={{ color: C.grey, padding: "40px 0" }}>Loading analytics…</div>;
  if (!data) return <div style={{ color: C.grey, padding: "40px 0" }}>Couldn't load analytics — try refreshing.</div>;
  const maxAcq = Math.max(1, ...data.acquisition_monthly.map((m) => m.count));
  const kpi = (lab: string, big: string, sub: string, mut?: boolean) => (
    <div style={{ ...card(), padding: "18px 20px" }}>
      <div style={eyebrow()}>{lab}</div>
      <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.02em", margin: "6px 0 2px", color: mut ? C.faint : C.ink }}>{big}</div>
      <div style={{ fontSize: 12, color: C.grey }}>{sub}</div>
    </div>
  );
  const td: React.CSSProperties = { padding: "11px 8px", borderTop: `1px solid ${C.lineSoft}`, fontSize: 13.5 };
  const th: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: C.faint, fontWeight: 800, padding: "10px 8px" };
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        {kpi("MRR", money(data.total_mrr), `${data.computable} of ${data.total_active} active`)}
        {kpi("Avg client value / mo", money(data.avg_client_value_month), "computable clients")}
        {kpi("Avg client value / visit", money(data.avg_client_value_visit), "per cleaning")}
        {kpi("Retention rate", "—", "captured going forward", true)}
      </div>

      <div style={{ ...eyebrow(), margin: "30px 2px 12px" }}>Client acquisition · last 12 months</div>
      <div style={{ ...card(), padding: "22px 24px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 150 }}>
          {data.acquisition_monthly.map((m) => (
            <div key={m.month} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", gap: 6, height: "100%" }}>
              <div style={{ fontSize: 11, color: C.grey, fontWeight: 700 }}>{m.count || ""}</div>
              <div style={{ width: "100%", maxWidth: 34, height: `${Math.round((m.count / maxAcq) * 100)}%`, minHeight: m.count ? 4 : 0, background: C.mint, borderRadius: "6px 6px 0 0" }} />
              <div style={{ fontSize: 10.5, color: C.faint }}>{new Date(m.month + "-01").toLocaleDateString("en-US", { month: "short" })}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: C.faint, marginTop: 10 }}>New recurring clients by first-cleaning month.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 24, alignItems: "start" }}>
        <div style={{ ...card(), padding: "22px 24px" }}>
          <div style={eyebrow()}>Portfolio &amp; MRR by cadence</div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
            <thead><tr>
              <th style={{ ...th, textAlign: "left" }}>Cadence</th>
              <th style={{ ...th, textAlign: "right" }}>Clients</th>
              <th style={{ ...th, textAlign: "right" }}>%</th>
              <th style={{ ...th, textAlign: "right" }}>MRR</th>
              <th style={{ ...th, textAlign: "right" }}>%</th>
            </tr></thead>
            <tbody>
              {data.portfolio.map((p) => (
                <tr key={p.cadence}>
                  <td style={td}>{p.cadence}</td>
                  <td style={{ ...td, textAlign: "right" }}>{p.count}</td>
                  <td style={{ ...td, textAlign: "right", color: C.faint, fontSize: 12 }}>{p.count_pct}%</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{p.mrr ? money(p.mrr) : "—"}</td>
                  <td style={{ ...td, textAlign: "right", color: C.faint, fontSize: 12 }}>{p.mrr_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ ...card(), padding: "22px 24px" }}>
          <div style={eyebrow()}>Retention &amp; churn</div>
          <div style={{ padding: "20px 0 4px", color: C.grey, fontSize: 13.5 }}>
            <div style={{ fontWeight: 800, color: C.ink, marginBottom: 6 }}>Captured going forward</div>
            Churn, lost MRR, and reasons fill in as clients are classified on cancel — that history can't be back-computed.{data.churn.lost_all_time > 0 ? ` ${data.churn.lost_all_time} lost so far.` : ""}
          </div>
        </div>
      </div>
    </>
  );
}
