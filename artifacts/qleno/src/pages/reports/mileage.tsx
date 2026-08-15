import { useState, useMemo } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useToast } from "@/hooks/use-toast";
import { fmt$c, fmtDate, clr, KpiCard, DateRange, ReportHeader, useReportData } from "./_shared";

// [mileage-report 2026-08-15] Sal: "I need a report where i can see how much in
// mileage we are rembursing. Check the accuracy as well please."
//
// This page is also where mileage gets APPROVED. The approve control already
// existed on /payroll, but only inside an expanded employee card under a dashed
// divider — Sal couldn't find it across three separate attempts, which is a
// discoverability failure, not a user error. The action belongs next to the
// number it changes, so it lives here too.
//
// Ordering is deliberate: what's wrong comes BEFORE what's owed. The $7,009.71
// haversine leg sat in the pending pool for weeks precisely because every
// surface led with totals and nothing led with defects.

const API_BASE = (import.meta as any).env?.BASE_URL?.replace(/\/$/, "") || "";
function getToken() { return typeof window !== "undefined" ? localStorage.getItem("qleno_token") : null; }

function today() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split("T")[0]; }

interface Leg {
  id: number; user_id: number; leg_date: string; miles: number; minutes: number;
  amount: number; rate_per_mile: number; status: string;
  measurement_source: string | null; measurement_is_estimated: boolean;
  from_job_id: number | null; to_job_id: number | null;
  tech_name: string; from_label: string; to_label: string;
}
interface FlaggedLeg extends Leg { flag: string; flag_detail: string }
interface WeekRow { week_start: string; legs: number; miles: number; amount: number; applied_amount: number; pending_amount: number }
interface TechRow { user_id: number; tech_name: string; legs: number; miles: number; amount: number; applied_amount: number; pending_amount: number; flagged_legs: number }
interface MileageData {
  from: string; to: string; rate_per_mile: number | null;
  summary: {
    applied_amount: number; applied_miles: number; applied_legs: number;
    pending_amount: number; pending_miles: number; pending_legs: number;
    discarded_amount: number; discarded_legs: number;
    total_legs: number; clean_pending_amount: number;
  };
  by_week: WeekRow[]; by_tech: TechRow[]; flagged: FlaggedLeg[]; legs: Leg[];
}

const FLAG_META: Record<string, { label: string; color: string; bg: string; blurb: string }> = {
  implausible_distance: {
    label: "Impossible distance", color: "#B3261E", bg: "#FDF0EF",
    blurb: "No drive between two houses is this long. One end is missing an address, so the distance was never really measured. Do not pay these.",
  },
  estimated: {
    label: "Estimated, not measured", color: "#9B7B17", bg: "#FEF6E0",
    blurb: "The mapping API never measured this drive — the mileage is a straight-line guess because a job was missing its address. Fix the address, then recompute.",
  },
  duplicate: {
    label: "Duplicate", color: "#9B7B17", bg: "#FEF6E0",
    blurb: "The same tech, same day, same two houses, recorded more than once. Pay one and discard the rest.",
  },
  carpool_candidate: {
    label: "Two techs, same drive", color: "#6B6860", bg: "#F4F3F0",
    blurb: "Two cleaners have the identical drive on the same day. If they rode together, only one should be paid. If they drove separately, both are owed — and nothing in the data records who rode with whom, so this is your call, not an error.",
  },
};

export default function MileageReportPage() {
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(today());
  const [busy, setBusy] = useState<number[]>([]);
  const { toast } = useToast();

  const { data, loading, reload } = useReportData<MileageData>(`/reports/mileage?from=${from}&to=${to}`);
  const s = data?.summary;
  const flagged = data?.flagged ?? [];

  // Hard errors vs judgement calls. Only the former block a bulk approve.
  const hardErrors = useMemo(() => flagged.filter(f => f.flag !== "carpool_candidate"), [flagged]);
  const judgementCalls = useMemo(() => flagged.filter(f => f.flag === "carpool_candidate"), [flagged]);
  const hardErrorIds = useMemo(() => new Set(hardErrors.map(f => f.id)), [hardErrors]);
  const cleanPendingLegs = useMemo(
    () => (data?.legs ?? []).filter(l => (l.status === "computed" || l.status === "reviewed") && l.amount > 0 && !hardErrorIds.has(l.id)),
    [data, hardErrorIds],
  );
  // Two houses at one address, or two units in one building. A $0 leg owes
  // nothing, so approving it would only mint an empty pay adjustment — but the
  // count has to be stated or the pending-leg total looks like it lost rows.
  const zeroPending = useMemo(
    () => (data?.legs ?? []).filter(l => (l.status === "computed" || l.status === "reviewed") && l.amount <= 0).length,
    [data],
  );

  async function post(path: string, body?: any) {
    const r = await fetch(`${API_BASE}/api${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || `Request failed (${r.status})`);
    return r.json();
  }

  // A leg lands as `computed`; apply refuses anything not already `reviewed`.
  // So one office "Approve" is two sequential calls, not one.
  async function approve(legs: Leg[], label: string) {
    const total = legs.reduce((a, l) => a + l.amount, 0);
    if (!confirm(`Approve ${legs.length} drive${legs.length === 1 ? "" : "s"} — ${fmt$c(total)}?\n\n${label}\n\nThis creates pay adjustments. The mileage becomes real money owed.`)) return;
    setBusy(b => [...b, ...legs.map(l => l.id)]);
    let ok = 0;
    try {
      for (const l of legs) {
        if (l.status === "computed") await post(`/pay/mileage-legs/${l.id}/review`);
        await post(`/pay/mileage-legs/${l.id}/apply`);
        ok++;
      }
      toast({ title: `Approved ${ok} drive${ok === 1 ? "" : "s"} — ${fmt$c(total)}` });
    } catch (e: any) {
      toast({ title: ok ? `Approved ${ok}, then stopped: ${e.message}` : e.message, variant: "destructive" });
    } finally {
      setBusy([]); reload();
    }
  }

  async function discard(leg: Leg, presetReason: string) {
    const reason = prompt(`Discard this drive (${leg.miles.toFixed(1)} mi, ${fmt$c(leg.amount)})?\n\nIt will never be paid. Reason:`, presetReason);
    if (!reason?.trim()) return;
    setBusy(b => [...b, leg.id]);
    try {
      await post(`/pay/mileage-legs/${leg.id}/discard`, { reason: reason.trim() });
      toast({ title: `Discarded — ${fmt$c(leg.amount)} will not be paid` });
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    } finally {
      setBusy([]); reload();
    }
  }

  const isBusy = (id: number) => busy.includes(id);

  const card: React.CSSProperties = { background: clr.card, border: `1px solid ${clr.border}`, borderRadius: 12, padding: "18px 20px", marginBottom: 20 };
  const th: React.CSSProperties = { textAlign: "left", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.06em", padding: "0 12px 8px 0", borderBottom: `1px solid ${clr.border}` };
  const td: React.CSSProperties = { padding: "10px 12px 10px 0", fontSize: 13, color: clr.text, borderBottom: `1px solid #F2F0EC` };
  const btn = (bg: string): React.CSSProperties => ({ fontFamily: "inherit", fontSize: 11, fontWeight: 700, color: "#fff", background: bg, border: "none", borderRadius: 999, padding: "5px 13px", cursor: "pointer" });

  return (
    <DashboardLayout title="Mileage Reimbursement">
      <div style={{ padding: "24px 28px", maxWidth: 1180 }}>
        <ReportHeader
          title="Mileage Reimbursement"
          subtitle={`What we reimburse for drives between jobs${data?.rate_per_mile ? ` — currently $${data.rate_per_mile.toFixed(4)}/mile` : ""}. Home and office legs are never reimbursed.`}
          printable
          filters={<DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />}
        />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
          <KpiCard label="Reimbursed" value={fmt$c(s?.applied_amount ?? 0)} sub={`${(s?.applied_miles ?? 0).toFixed(0)} mi paid · ${s?.applied_legs ?? 0} drives`} color={clr.green} />
          <KpiCard label="Pending approval" value={fmt$c(s?.pending_amount ?? 0)} sub={`${s?.pending_legs ?? 0} drives · not yet money`} color={clr.amber} />
          <KpiCard label="Clean & ready" value={fmt$c(s?.clean_pending_amount ?? 0)} sub="pending minus flagged errors" color={clr.brand} />
          <KpiCard label="Needs review" value={String(hardErrors.length)} sub={hardErrors.length ? `${fmt$c(hardErrors.reduce((a, f) => a + f.amount, 0))} at risk` : "nothing flagged"} color={hardErrors.length ? clr.red : clr.secondary} />
        </div>

        {/* Errors first. Totals are meaningless while a bad leg is inside them. */}
        {!loading && hardErrors.length > 0 && (
          <div style={{ ...card, borderColor: "#F0D9D6", background: "#FFFCFC" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: clr.text, marginBottom: 3 }}>Check these before you approve anything</div>
            <div style={{ fontSize: 12, color: clr.secondary, marginBottom: 14 }}>
              {hardErrors.length} drive{hardErrors.length === 1 ? "" : "s"} worth {fmt$c(hardErrors.reduce((a, f) => a + f.amount, 0))} look wrong. Approving in bulk without clearing these pays the bad ones too.
            </div>
            {hardErrors.map(f => {
              const meta = FLAG_META[f.flag]!;
              return (
                <div key={f.id} style={{ padding: "12px 0", borderTop: `1px solid ${clr.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 5 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: meta.color, background: meta.bg, borderRadius: 999, padding: "3px 9px" }}>{meta.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: clr.text }}>{f.tech_name}</span>
                    <span style={{ fontSize: 12, color: clr.secondary }}>{fmtDate(f.leg_date)}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: clr.red, marginLeft: "auto" }}>{f.miles.toFixed(1)} mi · {fmt$c(f.amount)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: clr.secondary, marginBottom: 4 }}>{f.from_label} → {f.to_label}</div>
                  <div style={{ fontSize: 12, color: clr.secondary, marginBottom: 9 }}>{f.flag_detail}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button disabled={isBusy(f.id)} onClick={() => discard(f, meta.label)} style={{ ...btn("#B3261E"), opacity: isBusy(f.id) ? 0.5 : 1 }}>
                      {isBusy(f.id) ? "Working…" : "Discard — never pay"}
                    </button>
                    <button disabled={isBusy(f.id)} onClick={() => approve([f], "Flagged, approving anyway.")} style={{ ...btn("#6B6860"), opacity: isBusy(f.id) ? 0.5 : 1 }}>
                      Pay it anyway
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Judgement calls — surfaced, never auto-resolved. */}
        {!loading && judgementCalls.length > 0 && (
          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 700, color: clr.text, marginBottom: 3 }}>Your call: {judgementCalls.length} drive{judgementCalls.length === 1 ? "" : "s"} shared by two techs</div>
            <div style={{ fontSize: 12, color: clr.secondary, marginBottom: 14 }}>{FLAG_META.carpool_candidate!.blurb}</div>
            {judgementCalls.map(f => (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "9px 0", borderTop: `1px solid ${clr.border}`, fontSize: 13 }}>
                <span style={{ fontWeight: 600, color: clr.text, minWidth: 130 }}>{f.tech_name}</span>
                <span style={{ color: clr.secondary }}>{fmtDate(f.leg_date)}</span>
                <span style={{ color: clr.secondary }}>{f.from_label} → {f.to_label}</span>
                <span style={{ marginLeft: "auto", fontWeight: 700 }}>{f.miles.toFixed(1)} mi · {fmt$c(f.amount)}</span>
                <button disabled={isBusy(f.id)} onClick={() => discard(f, "Rode with another tech")} style={{ ...btn("#6B6860"), opacity: isBusy(f.id) ? 0.5 : 1 }}>Discard</button>
              </div>
            ))}
          </div>
        )}

        {/* The approve gate. */}
        {!loading && cleanPendingLegs.length > 0 && (
          <div style={{ ...card, borderColor: "#B7ECDD", background: "linear-gradient(120deg,#F0FDF9,#E9FBF5)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 500, color: "#9B9890", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Ready to approve</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: "#00A383", lineHeight: 1 }}>{fmt$c(cleanPendingLegs.reduce((a, l) => a + l.amount, 0))}</div>
                <div style={{ fontSize: 12, color: clr.secondary, marginTop: 6 }}>
                  {cleanPendingLegs.length} drives worth paying.
                  {hardErrors.length > 0 ? ` The ${hardErrors.length} flagged above ${hardErrors.length === 1 ? "is" : "are"} excluded.` : ""}
                  {zeroPending > 0 ? ` ${zeroPending} zero-mile drive${zeroPending === 1 ? "" : "s"} skipped — nothing to pay.` : ""}
                </div>
              </div>
              <button
                disabled={busy.length > 0}
                onClick={() => approve(cleanPendingLegs, "Every pending drive that passed the accuracy check.")}
                style={{ ...btn("#0A6E8A"), marginLeft: "auto", fontSize: 13, padding: "10px 20px", opacity: busy.length ? 0.5 : 1 }}>
                {busy.length ? "Approving…" : `Approve all clean (${cleanPendingLegs.length})`}
              </button>
            </div>
          </div>
        )}

        {/* By week */}
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: clr.text, marginBottom: 12 }}>By week</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
              <thead><tr>
                <th style={th}>Week of</th>
                <th style={{ ...th, textAlign: "right" }}>Drives</th>
                <th style={{ ...th, textAlign: "right" }}>Miles</th>
                <th style={{ ...th, textAlign: "right" }}>Paid</th>
                <th style={{ ...th, textAlign: "right" }}>Pending</th>
                <th style={{ ...th, textAlign: "right" }}>Total</th>
              </tr></thead>
              <tbody>
                {(data?.by_week ?? []).map(w => (
                  <tr key={w.week_start}>
                    <td style={td}>{fmtDate(w.week_start)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{w.legs}</td>
                    <td style={{ ...td, textAlign: "right" }}>{w.miles.toFixed(0)}</td>
                    <td style={{ ...td, textAlign: "right", color: clr.green, fontWeight: 600 }}>{w.applied_amount ? fmt$c(w.applied_amount) : "—"}</td>
                    <td style={{ ...td, textAlign: "right", color: clr.amber, fontWeight: 600 }}>{w.pending_amount ? fmt$c(w.pending_amount) : "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{fmt$c(w.amount)}</td>
                  </tr>
                ))}
                {!loading && !(data?.by_week ?? []).length && (
                  <tr><td style={{ ...td, color: clr.muted }} colSpan={6}>No drives recorded in this range.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* By tech */}
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: clr.text, marginBottom: 12 }}>By cleaner</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
              <thead><tr>
                <th style={th}>Cleaner</th>
                <th style={{ ...th, textAlign: "right" }}>Drives</th>
                <th style={{ ...th, textAlign: "right" }}>Miles</th>
                <th style={{ ...th, textAlign: "right" }}>Paid</th>
                <th style={{ ...th, textAlign: "right" }}>Pending</th>
                <th style={{ ...th, textAlign: "right" }}>Flagged</th>
                <th style={{ ...th, textAlign: "right" }}>Total</th>
              </tr></thead>
              <tbody>
                {(data?.by_tech ?? []).map(t => (
                  <tr key={t.user_id}>
                    <td style={{ ...td, fontWeight: 600 }}>{t.tech_name}</td>
                    <td style={{ ...td, textAlign: "right" }}>{t.legs}</td>
                    <td style={{ ...td, textAlign: "right" }}>{t.miles.toFixed(0)}</td>
                    <td style={{ ...td, textAlign: "right", color: clr.green, fontWeight: 600 }}>{t.applied_amount ? fmt$c(t.applied_amount) : "—"}</td>
                    <td style={{ ...td, textAlign: "right", color: clr.amber, fontWeight: 600 }}>{t.pending_amount ? fmt$c(t.pending_amount) : "—"}</td>
                    <td style={{ ...td, textAlign: "right", color: t.flagged_legs ? clr.red : clr.muted, fontWeight: t.flagged_legs ? 700 : 400 }}>{t.flagged_legs || "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{fmt$c(t.amount)}</td>
                  </tr>
                ))}
                {!loading && !(data?.by_tech ?? []).length && (
                  <tr><td style={{ ...td, color: clr.muted }} colSpan={7}>No drives recorded in this range.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {loading && <div style={{ fontSize: 13, color: clr.muted, padding: "10px 0" }}>Loading mileage…</div>}
      </div>
    </DashboardLayout>
  );
}
