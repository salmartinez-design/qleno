import { useState, useEffect, useCallback } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CalendarPopover } from "@/components/calendar-popover";
import { Link } from "wouter";
import { ChevronLeft, Loader2, TrendingUp, Plus, Trash2, Settings2, Target } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Metric metadata ──────────────────────────────────────────────────────────────
type Fmt = "int" | "pct" | "money";
const METRICS: Record<string, { label: string; fmt: Fmt; targetable?: boolean }> = {
  leads:          { label: "Total Leads",     fmt: "int",   targetable: true },
  booked:         { label: "Booked",          fmt: "int",   targetable: true },
  lead_to_book:   { label: "Lead → Book",     fmt: "pct",   targetable: true },
  close_rate:     { label: "Close Rate",      fmt: "pct",   targetable: true },
  contact_rate:   { label: "Contact Rate",    fmt: "pct",   targetable: true },
  booked_revenue: { label: "Booked Revenue",  fmt: "money", targetable: true },
  pipeline_value: { label: "Pipeline Value",  fmt: "money", targetable: true },
};
const CARD_CHOICES = Object.keys(METRICS);

const STATUS_LABELS: Record<string, string> = {
  needs_contacted: "Needs Contacted", contacted: "Contacted", quoted: "Quoted",
  follow_up: "Follow Up", booked: "Booked", no_response: "No Response", not_interested: "Not Interested",
};
const FUNNEL_ORDER = ["needs_contacted", "contacted", "quoted", "follow_up", "booked"];
const SOURCE_LABEL = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

function fmtVal(v: number | null, fmt: Fmt): string {
  if (v == null) return "—";
  if (fmt === "money") return "$" + Math.round(v).toLocaleString();
  if (fmt === "pct") return `${v}%`;
  return Math.round(v).toLocaleString();
}

const PERIODS = [
  { k: "rolling_90d", l: "Last 90 days" },
  { k: "month", l: "This month" },
  { k: "quarter", l: "This quarter" },
  { k: "year", l: "This year" },
  { k: "custom", l: "Custom" },
];

const card: React.CSSProperties = { background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: 18 };
const sectionTitle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: "#1A1917", marginBottom: 12 };
const th: React.CSSProperties = { padding: "8px 12px", textAlign: "left", fontSize: 11, fontWeight: 700,
  color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "9px 12px", fontSize: 13, color: "#374151" };
const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#6B6860", marginBottom: 5 };
const selectStyle: React.CSSProperties = { border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 12px",
  fontSize: 14, fontFamily: "inherit", background: "#fff", outline: "none", cursor: "pointer" };

export default function LeadsReportsPage() {
  const { toast } = useToast();
  const [period, setPeriod] = useState("rolling_90d");
  const [cFrom, setCFrom] = useState("");
  const [cTo, setCTo] = useState("");
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [cards, setCards] = useState<string[]>(["leads", "lead_to_book", "close_rate"]);
  const [showCustomize, setShowCustomize] = useState(false);
  const [spend, setSpend] = useState<any[]>([]);
  const [showSpendForm, setShowSpendForm] = useState(false);
  const [spendForm, setSpendForm] = useState({ source: "google_local_services", amount: "", period_start: "", period_end: "", notes: "" });
  const [targetEdits, setTargetEdits] = useState<Record<string, string>>({});

  const loadReport = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ period });
      if (period === "custom" && cFrom && cTo) { params.set("from", cFrom); params.set("to", cTo); }
      const r = await fetch(`${API}/api/lead-analytics/report?${params}`, { headers: getAuthHeaders() });
      if (r.ok) setReport(await r.json());
    } catch { toast({ title: "Failed to load report", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [period, cFrom, cTo, toast]);

  const loadAux = useCallback(async () => {
    try {
      const [sr, cr] = await Promise.all([
        fetch(`${API}/api/lead-analytics/spend`, { headers: getAuthHeaders() }),
        fetch(`${API}/api/lead-analytics/settings`, { headers: getAuthHeaders() }),
      ]);
      if (sr.ok) setSpend(await sr.json());
      if (cr.ok) { const s = await cr.json(); if (Array.isArray(s.headline_cards)) setCards(s.headline_cards); }
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadReport(); }, [loadReport]);
  useEffect(() => { loadAux(); }, [loadAux]);

  async function saveCards(next: string[]) {
    setCards(next);
    try {
      await fetch(`${API}/api/lead-analytics/settings`, {
        method: "PUT", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ headline_cards: next }),
      });
    } catch { /* silent */ }
  }

  function toggleCard(k: string) {
    if (cards.includes(k)) saveCards(cards.filter(c => c !== k));
    else if (cards.length < 4) saveCards([...cards, k]);
    else toast({ title: "Up to 4 cards", variant: "destructive" });
  }

  async function addSpend() {
    if (!spendForm.period_start || !spendForm.period_end) { toast({ title: "Period dates required", variant: "destructive" }); return; }
    try {
      const r = await fetch(`${API}/api/lead-analytics/spend`, {
        method: "POST", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(spendForm),
      });
      if (!r.ok) throw new Error();
      toast({ title: "Spend added" });
      setShowSpendForm(false);
      setSpendForm({ source: "google_local_services", amount: "", period_start: "", period_end: "", notes: "" });
      loadAux(); loadReport();
    } catch { toast({ title: "Failed to add spend", variant: "destructive" }); }
  }

  async function deleteSpend(id: number) {
    try {
      await fetch(`${API}/api/lead-analytics/spend/${id}`, { method: "DELETE", headers: getAuthHeaders() });
      loadAux(); loadReport();
    } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
  }

  async function saveTargets() {
    const targets = Object.entries(targetEdits)
      .filter(([, v]) => v !== "")
      .map(([metric, v]) => ({ metric, target_value: parseFloat(v), period: "monthly" }));
    if (!targets.length) { toast({ title: "Enter at least one target" }); return; }
    try {
      const r = await fetch(`${API}/api/lead-analytics/targets`, {
        method: "PUT", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ targets }),
      });
      if (!r.ok) throw new Error();
      toast({ title: "Targets saved" });
      setTargetEdits({});
      loadReport();
    } catch { toast({ title: "Failed to save targets", variant: "destructive" }); }
  }

  const headlineValue = (k: string): number | null => {
    if (!report) return null;
    if (k === "leads" || k === "booked") return report.totals?.[k] ?? null;
    if (k === "booked_revenue" || k === "pipeline_value") return report.totals?.[k] ?? null;
    return report.rates?.[k] ?? null;
  };

  const maxFunnel = report ? Math.max(1, ...FUNNEL_ORDER.map(s => report.funnel?.[s] || 0)) : 1;
  const maxAge = report ? Math.max(1, ...(report.aging || []).map((a: any) => a.count)) : 1;

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 0 48px" }}>
        <Link href="/leads">
          <a style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "#6B6860",
            textDecoration: "none", marginBottom: 12 }}>
            <ChevronLeft size={14} /> Back to Pipeline
          </a>
        </Link>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <TrendingUp size={22} /> Lead Reporting
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <select value={period} onChange={e => setPeriod(e.target.value)} style={selectStyle}>
              {PERIODS.map(p => <option key={p.k} value={p.k}>{p.l}</option>)}
            </select>
            {period === "custom" && (
              <>
                <CalendarPopover value={cFrom} ariaLabel="Custom range from" onChange={setCFrom} />
                <CalendarPopover value={cTo} ariaLabel="Custom range to" onChange={setCTo} />
              </>
            )}
            <Button variant="outline" onClick={() => setShowCustomize(s => !s)} style={{ gap: 6 }}>
              <Settings2 size={15} /> Cards
            </Button>
          </div>
        </div>

        {showCustomize && (
          <div style={{ ...card, marginBottom: 16 }}>
            <div style={sectionTitle}>Headline cards (pick up to 4)</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {CARD_CHOICES.map(k => {
                const on = cards.includes(k);
                return (
                  <button key={k} onClick={() => toggleCard(k)}
                    style={{ padding: "6px 14px", borderRadius: 999, fontSize: 13, fontWeight: on ? 700 : 500,
                      cursor: "pointer", fontFamily: "inherit",
                      background: on ? "#1A1917" : "#F7F6F3", color: on ? "#fff" : "#374151",
                      border: `1px solid ${on ? "#1A1917" : "#E5E2DC"}` }}>
                    {METRICS[k].label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {loading || !report ? (
          <div style={{ textAlign: "center", padding: 100 }}>
            <Loader2 size={26} className="animate-spin" color="#6B6860" style={{ margin: "0 auto" }} />
          </div>
        ) : (
          <>
            {/* Headline cards */}
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, cards.length)}, 1fr)`, gap: 14, marginBottom: 18 }}>
              {cards.map(k => (
                <div key={k} style={card}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {METRICS[k]?.label || k}
                  </div>
                  <div style={{ fontSize: 30, fontWeight: 700, color: "#1A1917", marginTop: 6 }}>
                    {fmtVal(headlineValue(k), METRICS[k]?.fmt || "int")}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, marginBottom: 16 }}>
              {/* Funnel */}
              <div style={card}>
                <div style={sectionTitle}>Pipeline Funnel</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {FUNNEL_ORDER.map(s => {
                    const v = report.funnel?.[s] || 0;
                    return (
                      <div key={s}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6B6860", marginBottom: 3 }}>
                          <span>{STATUS_LABELS[s]}</span><span style={{ fontWeight: 600, color: "#1A1917" }}>{v}</span>
                        </div>
                        <div style={{ height: 10, background: "#F2F1ED", borderRadius: 999, overflow: "hidden" }}>
                          <div style={{ width: `${(v / maxFunnel) * 100}%`, height: "100%",
                            background: s === "booked" ? "#059669" : "#5B9BD5", borderRadius: 999 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Rates + speed */}
              <div style={card}>
                <div style={sectionTitle}>Conversion & Speed</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <Mini label="Lead → Book" value={`${report.rates.lead_to_book}%`} />
                  <Mini label="Close Rate" value={`${report.rates.close_rate}%`} />
                  <Mini label="Contact Rate" value={`${report.rates.contact_rate}%`} />
                  <Mini label="Quote Rate" value={`${report.rates.quote_rate}%`} />
                  <Mini label="Speed to Lead" value={report.speed.avg_hours_to_contact != null ? `${report.speed.avg_hours_to_contact}h` : "—"} />
                  <Mini label="Quote → Book" value={report.speed.avg_hours_quote_to_book != null ? `${report.speed.avg_hours_quote_to_book}h` : "—"} />
                </div>
              </div>
            </div>

            {/* Cost / ROI */}
            <div style={{ ...card, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <span style={sectionTitle}>Marketing Cost & ROI</span>
                <Button variant="outline" size="sm" onClick={() => setShowSpendForm(s => !s)} style={{ gap: 5 }}>
                  <Plus size={14} /> Add Spend
                </Button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 14 }}>
                <Mini label="Total Spend" value={fmtVal(report.cost.total_spend, "money")} />
                <Mini label="Cost / Lead" value={report.cost.cpl != null ? `$${report.cost.cpl}` : "—"} />
                <Mini label="Cost / Booking" value={report.cost.cpa != null ? `$${report.cost.cpa}` : "—"} />
                <Mini label="ROI" value={report.cost.roi != null ? `${report.cost.roi}%` : "—"}
                  color={report.cost.roi != null && report.cost.roi >= 0 ? "#059669" : "#DC2626"} />
              </div>

              {showSpendForm && (
                <div style={{ background: "#F7F6F3", borderRadius: 8, padding: 14, marginBottom: 14,
                  display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, alignItems: "end" }}>
                  <div>
                    <label style={lbl}>Source</label>
                    <select value={spendForm.source} onChange={e => setSpendForm(f => ({ ...f, source: e.target.value }))} style={{ ...selectStyle, width: "100%" }}>
                      {["google_local_services","google_search","facebook","yelp","referral","other"].map(s =>
                        <option key={s} value={s}>{SOURCE_LABEL(s)}</option>)}
                    </select>
                  </div>
                  <div><label style={lbl}>Amount ($)</label>
                    <Input type="number" value={spendForm.amount} onChange={e => setSpendForm(f => ({ ...f, amount: e.target.value }))} placeholder="500" /></div>
                  <div><label style={lbl}>From</label>
                    <CalendarPopover value={spendForm.period_start} ariaLabel="Spend period from" onChange={ymd => setSpendForm(f => ({ ...f, period_start: ymd }))} block /></div>
                  <div><label style={lbl}>To</label>
                    <CalendarPopover value={spendForm.period_end} ariaLabel="Spend period to" onChange={ymd => setSpendForm(f => ({ ...f, period_end: ymd }))} block /></div>
                  <Button onClick={addSpend} style={{ background: "#1A1917", color: "#fff" }}>Save</Button>
                </div>
              )}

              {spend.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr style={{ borderBottom: "1px solid #E5E2DC" }}>
                    {["Source", "Amount", "Period", ""].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {spend.map(s => (
                      <tr key={s.id} style={{ borderBottom: "1px solid #F3F4F6" }}>
                        <td style={td}>{SOURCE_LABEL(s.source)}</td>
                        <td style={td}>${Math.round(Number(s.amount)).toLocaleString()}</td>
                        <td style={td}>{s.period_start} → {s.period_end}</td>
                        <td style={{ ...td, textAlign: "right" }}>
                          <button onClick={() => deleteSpend(s.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#DC2626" }}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Source / Partner / Rep performance */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              <PerfTable title="By Source" rows={report.by_source}
                cols={[["Source", (r: any) => SOURCE_LABEL(r.source)], ["Leads", (r: any) => r.leads],
                  ["Booked", (r: any) => r.booked], ["Rate", (r: any) => `${r.rate}%`]]} />
              <PerfTable title="By Referral Partner" rows={report.by_partner}
                empty="No partner-attributed leads in this period."
                cols={[["Partner", (r: any) => r.name], ["Leads", (r: any) => r.leads],
                  ["Booked", (r: any) => r.booked], ["Value", (r: any) => `$${Math.round(r.booked_value).toLocaleString()}`]]} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              <PerfTable title="By Owner (Sales Rep)" rows={report.by_rep}
                empty="No assigned leads in this period."
                cols={[["Owner", (r: any) => r.name], ["Leads", (r: any) => r.leads],
                  ["Booked", (r: any) => r.booked], ["Rate", (r: any) => `${r.rate}%`]]} />

              {/* Aging */}
              <div style={card}>
                <div style={sectionTitle}>Open Pipeline Aging</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {(report.aging || []).map((a: any) => (
                    <div key={a.bucket}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6B6860", marginBottom: 3 }}>
                        <span>{a.bucket}</span><span style={{ fontWeight: 600, color: "#1A1917" }}>{a.count}</span>
                      </div>
                      <div style={{ height: 10, background: "#F2F1ED", borderRadius: 999, overflow: "hidden" }}>
                        <div style={{ width: `${(a.count / maxAge) * 100}%`, height: "100%",
                          background: a.bucket.includes("31") ? "#DC2626" : a.bucket.includes("15") ? "#EA580C" : "#5B9BD5",
                          borderRadius: 999 }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* KPI targets */}
            <div style={card}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <span style={{ ...sectionTitle, marginBottom: 0, display: "flex", alignItems: "center", gap: 7 }}>
                  <Target size={16} /> KPI Targets vs Actual
                </span>
                <Button size="sm" onClick={saveTargets} style={{ background: "#1A1917", color: "#fff" }}>Save Targets</Button>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr style={{ borderBottom: "1px solid #E5E2DC" }}>
                  {["Metric", "Target", "Actual", "Status"].map(h => <th key={h} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {CARD_CHOICES.filter(k => METRICS[k].targetable).map(k => {
                    const existing = (report.targets || []).find((t: any) => t.metric === k);
                    const actual = headlineValue(k);
                    const target = existing ? existing.target : null;
                    const met = target != null && actual != null && actual >= target;
                    return (
                      <tr key={k} style={{ borderBottom: "1px solid #F3F4F6" }}>
                        <td style={{ ...td, fontWeight: 600, color: "#1A1917" }}>{METRICS[k].label}</td>
                        <td style={td}>
                          <Input value={targetEdits[k] ?? (target != null ? String(target) : "")}
                            onChange={e => setTargetEdits(p => ({ ...p, [k]: e.target.value }))}
                            placeholder="—" style={{ width: 110, height: 32 }} type="number" />
                        </td>
                        <td style={{ ...td, fontWeight: 600 }}>{fmtVal(actual, METRICS[k].fmt)}</td>
                        <td style={td}>
                          {target == null ? <span style={{ color: "#D1D5DB" }}>—</span> : (
                            <span style={{ fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
                              background: met ? "#ECFDF5" : "#FEF2F2", color: met ? "#059669" : "#DC2626" }}>
                              {met ? "On track" : "Below"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || "#1A1917", marginTop: 3 }}>{value}</div>
    </div>
  );
}

function PerfTable({ title, rows, cols, empty }:
  { title: string; rows: any[]; cols: [string, (r: any) => any][]; empty?: string }) {
  return (
    <div style={card}>
      <div style={sectionTitle}>{title}</div>
      {(!rows || rows.length === 0) ? (
        <div style={{ color: "#9CA3AF", fontSize: 13, padding: "16px 0" }}>{empty || "No data in this period."}</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: "1px solid #E5E2DC" }}>
            {cols.map(([h]) => <th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #F3F4F6" }}>
                {cols.map(([h, fn], j) => (
                  <td key={h} style={{ ...td, fontWeight: j === 0 ? 600 : 400, color: j === 0 ? "#1A1917" : "#374151" }}>{fn(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
