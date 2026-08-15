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
  split_group_size: number | null; amount_before_split: number | null;
  measurement_source: string | null; measurement_is_estimated: boolean;
  from_job_id: number | null; to_job_id: number | null;
  tech_name: string; from_label: string; to_label: string;
}
interface FlaggedLeg extends Leg { flag: string; flag_detail: string }
// [shared-drive-split 2026-08-15] One entry per DRIVE, not per tech — the
// office is deciding about a single drive and the techs on it, so the two legs
// have to be visible side by side.
interface SharedDriveLeg {
  id: number; user_id: number; tech_name: string;
  amount: number; amount_before_split: number | null; status: string;
}
interface SharedDrive {
  key: string; leg_date: string;
  from_job_id: number | null; to_job_id: number | null;
  from_label: string; to_label: string; miles: number;
  is_split: boolean;
  /** What the drive costs once. */
  full_amount: number;
  /** What it costs as it stands — full_amount × techs until it's split. */
  current_total: number;
  overpay: number;
  tech_count: number;
  legs: SharedDriveLeg[];
}
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
  by_week: WeekRow[]; by_tech: TechRow[]; flagged: FlaggedLeg[];
  shared_drives: SharedDrive[]; legs: Leg[];
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
  const hardErrorIds = useMemo(() => new Set(hardErrors.map(f => f.id)), [hardErrors]);
  // Grouped by drive, so both techs appear on one row. Already-split drives stay
  // in the list — the decision is visible and reversible, not hidden once made.
  const sharedDrives = data?.shared_drives ?? [];
  const openDrives = useMemo(() => sharedDrives.filter(d => !d.is_split), [sharedDrives]);
  const splitDrives = useMemo(() => sharedDrives.filter(d => d.is_split), [sharedDrives]);
  const totalOverpay = useMemo(() => openDrives.reduce((a, d) => a + d.overpay, 0), [openDrives]);
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

  // Takes the minimum it needs rather than a full Leg — the shared-drive rows
  // carry miles on the drive, not on each tech's line.
  async function discard(leg: { id: number; miles: number; amount: number }, presetReason: string) {
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

  // [shared-drive-split 2026-08-15] Sal: "in cases where more than one tech is
  // driving this should show on the approval screen, and let me split it
  // amongst both."
  //
  // Splitting changes no status — the legs stay pending and still go through
  // the normal approve. All that changes is what each tech carries, so the
  // drive gets paid once across the two of them instead of once each.
  async function splitDrive(d: SharedDrive) {
    const each = d.full_amount / d.tech_count;
    const names = d.legs.map(l => l.tech_name).join(" and ");
    if (!confirm(
      `Split this drive between ${names}?\n\n` +
      `${d.miles.toFixed(1)} mi · ${fmt$c(d.full_amount)} for the drive\n` +
      `Each gets about ${fmt$c(each)} instead of ${fmt$c(d.full_amount)}.\n\n` +
      `Total drops from ${fmt$c(d.current_total)} to ${fmt$c(d.full_amount)}. ` +
      `Nothing is paid yet — you still approve it below.`
    )) return;
    setBusy(b => [...b, ...d.legs.map(l => l.id)]);
    try {
      await post(`/pay/mileage-legs/split`, { leg_ids: d.legs.map(l => l.id) });
      toast({ title: `Split ${d.tech_count} ways — this drive now costs ${fmt$c(d.full_amount)}` });
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    } finally {
      setBusy([]); reload();
    }
  }

  async function unsplitDrive(d: SharedDrive) {
    setBusy(b => [...b, ...d.legs.map(l => l.id)]);
    try {
      await post(`/pay/mileage-legs/unsplit`, { leg_ids: d.legs.map(l => l.id) });
      toast({ title: "Split undone — each cleaner is back to the full amount" });
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

        {/* Judgement calls — surfaced, never auto-resolved. Grouped by DRIVE:
            one card per drive with every tech on it, because the decision is
            about the drive, not about either tech separately. */}
        {!loading && openDrives.length > 0 && (
          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 700, color: clr.text, marginBottom: 3 }}>
              Your call: {openDrives.length} drive{openDrives.length === 1 ? "" : "s"} with more than one cleaner
            </div>
            <div style={{ fontSize: 12, color: clr.secondary, marginBottom: 4 }}>{FLAG_META.carpool_candidate!.blurb}</div>
            {totalOverpay > 0 && (
              <div style={{ fontSize: 12, color: clr.secondary, marginBottom: 14 }}>
                Each cleaner currently carries the full amount, so approving as-is pays{" "}
                <strong style={{ color: clr.text }}>{fmt$c(totalOverpay)}</strong> more than the drives cost.
                Split the ones where they rode together.
              </div>
            )}
            {openDrives.map(d => (
              <div key={d.key} style={{ padding: "13px 0", borderTop: `1px solid ${clr.border}` }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: clr.text }}>{fmtDate(d.leg_date)}</span>
                  <span style={{ fontSize: 12, color: clr.secondary }}>{d.from_label} → {d.to_label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700, color: clr.text }}>
                    {d.miles.toFixed(1)} mi · {fmt$c(d.full_amount)} the drive
                  </span>
                </div>
                {d.legs.map(l => (
                  <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "5px 0 5px 14px", fontSize: 13 }}>
                    <span style={{ fontWeight: 600, color: clr.text, minWidth: 150 }}>{l.tech_name}</span>
                    <span style={{ marginLeft: "auto", fontWeight: 700 }}>{fmt$c(l.amount)}</span>
                    <button
                      disabled={isBusy(l.id)}
                      onClick={() => discard({ id: l.id, miles: d.miles, amount: l.amount }, "Rode with another cleaner")}
                      style={{ ...btn("#6B6860"), opacity: isBusy(l.id) ? 0.5 : 1 }}>
                      Discard this one
                    </button>
                  </div>
                ))}
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 9, paddingLeft: 14 }}>
                  <button
                    disabled={busy.length > 0}
                    onClick={() => splitDrive(d)}
                    style={{ ...btn("#00A383"), opacity: busy.length ? 0.5 : 1 }}>
                    Split it — {fmt$c(d.full_amount / d.tech_count)} each
                  </button>
                  <span style={{ fontSize: 12, color: clr.secondary }}>
                    They rode together. Or leave it alone and both get {fmt$c(d.full_amount)} for driving separately.
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Drives already split. Kept visible so the decision is auditable and
            a misclick is one click to undo. */}
        {!loading && splitDrives.length > 0 && (
          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 700, color: clr.text, marginBottom: 3 }}>
              {splitDrives.length} shared drive{splitDrives.length === 1 ? "" : "s"} split
            </div>
            <div style={{ fontSize: 12, color: clr.secondary, marginBottom: 14 }}>
              Each of these is paid once, divided between the cleaners who shared it. They're ready to approve with everything else below.
            </div>
            {splitDrives.map(d => (
              <div key={d.key} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "10px 0", borderTop: `1px solid ${clr.border}`, fontSize: 13 }}>
                <span style={{ color: clr.secondary, minWidth: 92 }}>{fmtDate(d.leg_date)}</span>
                <span style={{ fontWeight: 600, color: clr.text }}>
                  {d.legs.map(l => `${l.tech_name} ${fmt$c(l.amount)}`).join("  ·  ")}
                </span>
                <span style={{ marginLeft: "auto", fontWeight: 700 }}>{d.miles.toFixed(1)} mi · {fmt$c(d.full_amount)}</span>
                <button
                  disabled={busy.length > 0}
                  onClick={() => unsplitDrive(d)}
                  style={{ ...btn("#6B6860"), opacity: busy.length ? 0.5 : 1 }}>
                  Undo split
                </button>
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
