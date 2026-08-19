import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, Calendar, CheckCircle, Clock, DollarSign, Download, History, Mail } from "lucide-react";
import { C, soft, money2, dateFmt, card, eyebrow, btn, th, td, Callout, LoadError } from "../_ui";
import { useBranch } from "@/contexts/branch-context";
import {
  apiGet, apiPost, useCommissionData, PAYOUT_PERIODS,
  type CommissionRow, type PayoutPreview, type PaymentRow,
} from "./api";

// [ares-parity 2026-08-18] Payout History tab — a rebuild of Ares
// CommissionPortal :2457-2859 (pay-period tracker, process-payout section,
// period summary, VA breakdown, payout history log) plus the Confirm Payout
// Processing modal (:4139-4306).
//
// ONE structural difference from Ares, and it is the API's, not a choice:
// Ares processed a whole month in a single POST for every VA at once. Qleno's
// payout endpoints are per-VA (`va_user_id` is required, and the run is
// idempotent per company+VA+month). So the period-level "Process Payout" button
// is rendered disabled with an honest note and the work happens on the VA rows.
// Faking a single all-VA button on top of N calls would hide partial failures
// on a money screen, which is the one thing this rebuild must not do.
//
// The netting is the point of this screen: gross earned, minus confirmed
// chargebacks, minus carryover left over from an earlier month that could not
// be collected, equals net paid — and anything that still does not fit carries
// forward again. Ares computed carryover, announced it, and then dropped it;
// here every one of those numbers is shown as its own line.

interface Props {
  commissions: CommissionRow[];
  vaOptions: Array<{ id: number; name: string }>;
  reload: () => void;
}

// Ares :4195-4200 — value → label, verbatim.
const PAYMENT_METHODS: Array<{ value: string; label: string }> = [
  { value: "PayPal", label: "PayPal" },
  { value: "Zelle", label: "Zelle" },
  { value: "Payoneer", label: "Payoneer" },
  { value: "ACH", label: "ACH / Bank Transfer" },
  { value: "Check", label: "Check" },
  { value: "Other", label: "Other" },
];

// Statuses the pay-period tracker counts as "eligible" for a month
// (server parity: routes.ts:4864-4954 used pending/approved/paid; Qleno adds
// `earned`, the pre-review state Ares had no equivalent for, and `on_hold`,
// which Ares carried as plain `pending` — an on-hold line is still money owed,
// so leaving it out would let a month read "Paid" with an unpaid line in it).
const ELIGIBLE_STATUSES = ["earned", "pending_review", "on_hold", "approved", "paid"];

// COALESCE(first_cleaning_date, earned_date) — the exact key previewPayout()
// uses server-side. Anything else and this table would quietly disagree with
// what the API actually pays. Bonuses carry no first cleaning date, which is
// why they silently never paid out in Ares.
const qualifyingKey = (r: CommissionRow) => (r.first_cleaning_date || r.earned_date || "").slice(0, 7);

const num = (v: string | number | null | undefined) => Number(v ?? 0) || 0;
const sumAmount = (rows: CommissionRow[]) => rows.reduce((s, r) => s + num(r.amount), 0);

// Ares pays on the LAST FRIDAY of month M for first cleans in M-1.
const lastFridayOf = (year: number, month1to12: number) => {
  const d = new Date(year, month1to12, 0);
  while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
  return d;
};

const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
};

// earned YYYY-MM → the payout month that settles it (Ares :294-299).
const earnedKeyToPayoutValue = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

const control: CSSProperties = {
  font: "inherit", fontSize: 13, fontWeight: 600, color: C.ink, background: C.card,
  border: `1px solid ${C.line}`, borderRadius: "var(--radius-control)", padding: "7px 10px",
};
const fieldLabel: CSSProperties = { ...eyebrow(), display: "block", marginBottom: 5 };

interface ConfirmTarget { vaId: number; vaName: string; preview: PayoutPreview }

export default function Payout({ commissions, vaOptions, reload }: Props) {
  const { activeBranchId } = useBranch();
  const [selected, setSelected] = useState<string>(
    () => (PAYOUT_PERIODS.find(p => p.isCurrent) ?? PAYOUT_PERIODS[0]).value,
  );
  const [historyVa, setHistoryVa] = useState<number | "all">("all");
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);

  // The confirm modal snapshots a preview. If the period changes underneath it,
  // it would re-render the previous period's numbers under the new period's
  // label — so close it rather than let the two disagree.
  useEffect(() => { setConfirm(null); }, [selected]);
  const processRef = useRef<HTMLDivElement | null>(null);

  const period = useMemo(
    () => PAYOUT_PERIODS.find(p => p.value === selected) ?? PAYOUT_PERIODS[0],
    [selected],
  );

  const paymentsQ = useCommissionData<{ count: number; payments: PaymentRow[] }>(
    "/recurring/commissions/payments",
  );
  const payments = useMemo(() => paymentsQ.data?.payments ?? [], [paymentsQ.data]);

  const vaName = useCallback((id: number) =>
    vaOptions.find(v => v.id === id)?.name
    ?? commissions.find(c => c.va_user_id === id)?.va_name
    ?? `VA #${id}`, [vaOptions, commissions]);

  // ── The selected period ───────────────────────────────────────────────────
  const inPeriod = useMemo(
    () => commissions.filter(c => qualifyingKey(c) === period.qualifyingValue),
    [commissions, period],
  );
  const { approvedRows, paidRows } = useMemo(() => ({
    approvedRows: inPeriod.filter(c => c.status === "approved"),
    paidRows: inPeriod.filter(c => c.status === "paid"),
  }), [inPeriod]);
  const approvedTotal = sumAmount(approvedRows);
  const paidTotal = sumAmount(paidRows);
  const periodOverdue = period.payoutDate < new Date() && approvedTotal > 0;

  // ── Previews ──────────────────────────────────────────────────────────────
  // One GET per VA who either has approved work in this period or carries an
  // outstanding confirmed chargeback — a clawback follows the VA even into a
  // month where they earned nothing, and that case must still be visible.
  const previewKey = useMemo(() => {
    const s = new Set<number>();
    approvedRows.forEach(c => s.add(c.va_user_id));
    commissions.forEach(c => { if (c.status === "chargeback_confirmed") s.add(c.va_user_id); });
    return [...s].sort((a, b) => a - b).join(",");
  }, [approvedRows, commissions]);

  const [previews, setPreviews] = useState<Record<number, PayoutPreview>>({});
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadPreviews = useCallback(() => {
    // Drop the previous period's snapshot FIRST. Anything still in state while
    // the new fetch is in flight belongs to the old payout month, and the row
    // buttons post `preview.payout_month` — so a stale map here pays March
    // under an April heading.
    setPreviews({});
    const ids = previewKey ? previewKey.split(",").map(Number) : [];
    if (!ids.length) { setPreviews({}); setPreviewError(null); setPreviewLoading(false); return; }
    setPreviewLoading(true);
    setPreviewError(null);
    // useCommissionData is one-path-per-hook, so these go through apiGet; the
    // branch filter is appended by hand to match the rest of the module.
    const branch = activeBranchId === "all" ? "" : `&branch_id=${activeBranchId}`;
    Promise.all(ids.map(id =>
      apiGet<PayoutPreview>(
        `/recurring/commissions/payout/preview?va_user_id=${id}&payout_month=${period.value}${branch}`,
      ).then(p => [id, p] as const),
    ))
      .then(entries => { setPreviews(Object.fromEntries(entries)); setPreviewLoading(false); })
      .catch(e => {
        // Never fall back to a partial map: half a payout table reads as
        // "these VAs are owed nothing", which is the wrong answer.
        setPreviews({});
        setPreviewError(e instanceof Error ? e.message : String(e));
        setPreviewLoading(false);
      });
  }, [previewKey, period.value, activeBranchId]);

  useEffect(() => { loadPreviews(); }, [loadPreviews]);

  const afterPayout = useCallback(() => {
    reload();
    paymentsQ.reload();
    loadPreviews();
  }, [reload, paymentsQ, loadPreviews]);

  // ── VA breakdown rows ─────────────────────────────────────────────────────
  const vaRows = useMemo(() => {
    const ids = new Set<number>();
    inPeriod.forEach(c => ids.add(c.va_user_id));
    Object.keys(previews).forEach(k => ids.add(Number(k)));
    const order = (id: number) => {
      const i = vaOptions.findIndex(v => v.id === id);
      return i === -1 ? 9999 : i;
    };
    return [...ids].sort((a, b) => order(a) - order(b)).map(id => {
      const mine = inPeriod.filter(c => c.va_user_id === id);
      const pv = previews[id] ?? null;
      return {
        id,
        name: vaName(id),
        // Only the rows that make up the Gross/Net figures beside this count —
        // not_eligible/rejected/chargeback_*/recouped contribute nothing.
        count: mine.filter(c => c.status === "approved" || c.status === "paid").length,
        approvedAmount: sumAmount(mine.filter(c => c.status === "approved")),
        paidAmount: sumAmount(mine.filter(c => c.status === "paid")),
        preview: pv,
      };
    });
  }, [inPeriod, previews, vaOptions, vaName]);

  const totals = vaRows.reduce((acc, r) => ({
    gross: acc.gross + (r.preview ? r.preview.gross : 0),
    chargebacks: acc.chargebacks + (r.preview ? r.preview.chargeback_total : 0),
    prior: acc.prior + (r.preview ? r.preview.prior_carryover : 0),
    net: acc.net + (r.preview ? r.preview.net : 0),
    carryover: acc.carryover + (r.preview ? r.preview.carryover : 0),
  }), { gross: 0, chargebacks: 0, prior: 0, net: 0, carryover: 0 });

  // ── Pay Period Status tracker (Ares :2460-2531) ───────────────────────────
  // Ares read this from a dedicated /period-status endpoint. Qleno has none, so
  // it is derived client-side from the same two sources the server used:
  // commission rows and processed payments. Same rules, same wording.
  const tracker = useMemo(() => {
    const now = new Date();
    const out: Array<{
      key: string; label: string; eligibleCount: number; eligibleAmount: number;
      pendingCount: number; approvedCount: number; paidCount: number;
      isPaid: boolean; isFuture: boolean; isOverdue: boolean;
      totalAmount: number; vaCount: number; paidDate: string | null;
      receipts: string[]; payoutDue: Date;
    }> = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const eligible = commissions.filter(c => qualifyingKey(c) === key && ELIGIBLE_STATUSES.includes(c.status));
      const pays = payments.filter(p => (p.period_start || "").slice(0, 7) === key);
      const payoutDue = lastFridayOf(d.getFullYear(), d.getMonth() + 2);
      const paidViaItems = eligible.length > 0 && eligible.every(c => c.status === "paid");
      const isPaid = pays.length > 0 || paidViaItems;
      const isFuture = !(payoutDue < now);
      const paidDates = pays.length
        ? pays.map(p => p.processed_at).filter(Boolean)
        : eligible.map(c => c.paid_date).filter(Boolean) as string[];
      out.push({
        key,
        label: monthLabel(key),
        eligibleCount: eligible.length,
        eligibleAmount: sumAmount(eligible),
        pendingCount: eligible.filter(c => c.status === "pending_review" || c.status === "earned").length,
        approvedCount: eligible.filter(c => c.status === "approved").length,
        paidCount: eligible.filter(c => c.status === "paid").length,
        isPaid,
        isFuture,
        isOverdue: payoutDue < now && !isPaid && eligible.length > 0,
        totalAmount: pays.length
          ? pays.reduce((s, p) => s + num(p.total_amount), 0)
          : sumAmount(eligible.filter(c => c.status === "paid")),
        vaCount: pays.length
          ? new Set(pays.map(p => p.va_user_id)).size
          : new Set(eligible.map(c => c.va_user_id)).size,
        paidDate: paidDates.length ? paidDates.sort().slice(-1)[0] : null,
        receipts: pays.map(p => p.receipt_number).filter(Boolean) as string[],
        payoutDue,
      });
    }
    return out;
  }, [commissions, payments]);

  const selectPeriodFromTracker = (key: string) => {
    const value = earnedKeyToPayoutValue(key);
    if (PAYOUT_PERIODS.some(p => p.value === value)) setSelected(value);
    // Ares also opened a Period Detail modal here (:3531-3699). That modal
    // belongs to no Qleno endpoint of its own and is not part of this tab's
    // scope; selecting the period and scrolling to the payout controls is the
    // action the card was actually for.
    window.setTimeout(() => processRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };

  // ── Payout history ────────────────────────────────────────────────────────
  const historyRows = payments.filter(p => historyVa === "all" || p.va_user_id === historyVa);

  const exportCsv = () => {
    // Pure client-side, from rows already loaded — no export endpoint needed.
    const cell = (v: unknown) => String(v ?? "").replace(/,/g, ";").replace(/[\r\n]+/g, " ");
    // Mirror whichever table is actually on screen. In fallback mode (Mode A)
    // there are no grouped payments at all, so serialising `historyRows` would
    // hand the operator a file containing nothing but a header row.
    const grouped = payments.length > 0;
    const head = grouped
      ? "Date,VA,Sales Period,Receipt #,Method,Amount,Commissions,Notes"
      : "Date Paid,Client,VA,First Clean,Type,Amount,Receipt #";
    const body = grouped
      ? historyRows.map(p => [
        p.processed_at ? new Date(p.processed_at).toLocaleDateString() : "",
        p.va_name ?? vaName(p.va_user_id),
        p.sales_period ?? "",
        p.receipt_number ?? "",
        p.payment_method ?? "",
        num(p.total_amount).toFixed(2),
        p.item_count,
        p.notes ?? "",
      ].map(cell).join(","))
      : paidFallback.map(c => [
        c.paid_date ?? "",
        c.client_name ?? "",
        c.va_name ?? vaName(c.va_user_id),
        c.first_cleaning_date ?? "",
        c.client_type ?? "",
        num(c.amount).toFixed(2),
        c.payment_id ? `Payment #${c.payment_id}` : "",
      ].map(cell).join(","));
    const blob = new Blob([[head, ...body].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "PHES-Payout-History.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Fallback view when no grouped payment records exist yet (Ares :2715-2797).
  const paidFallback = useMemo(() => commissions
    .filter(c => c.status === "paid" && (historyVa === "all" || c.va_user_id === historyVa))
    .sort((a, b) => String(b.paid_date || b.created_at).localeCompare(String(a.paid_date || a.created_at))),
    [commissions, historyVa]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>

      {paymentsQ.error && <LoadError what="payout history" error={paymentsQ.error} />}
      {previewError && <LoadError what="the payout preview" error={previewError} />}

      {/* ── Pay Period Status ──────────────────────────────────────────────── */}
      <section style={{ ...card(), padding: "20px 24px" }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: "-.01em" }}>Pay Period Status</h2>
        <p style={{ margin: "4px 0 16px", fontSize: 13, color: C.grey }}>
          Monthly payout completion overview — last 12 months
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 10 }}>
          {tracker.map(m => {
            const isActionable = !m.isPaid && !m.isFuture && m.eligibleCount > 0;
            const tone = m.isPaid
              ? { border: C.mintDeep, bg: C.mintBg }
              : m.isOverdue
                ? { border: C.red, bg: C.redBg }
                : isActionable
                  ? { border: C.amber, bg: C.amberBg }
                  : { border: C.line, bg: C.card };
            return (
              <button
                key={m.key}
                onClick={() => selectPeriodFromTracker(m.key)}
                style={{
                  appearance: "none", font: "inherit", textAlign: "left", cursor: "pointer",
                  background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 12, padding: "12px 14px",
                }}
              >
                <div style={{ fontWeight: 800, fontSize: 13, color: C.ink }}>{m.label}</div>
                {m.isPaid ? (
                  <>
                    <div style={{ fontWeight: 800, fontSize: 17, color: C.mintDeep, marginTop: 4 }}>
                      {money2(m.totalAmount)}
                    </div>
                    <div style={{ fontSize: 12, color: C.grey }}>
                      Paid · {m.vaCount} VA{m.vaCount === 1 ? "" : "s"}
                    </div>
                    {m.paidDate && <div style={{ fontSize: 12, color: C.grey }}>{dateFmt(m.paidDate)}</div>}
                    {m.receipts.length > 0 && (
                      <div style={{ fontSize: 11, color: C.faint, marginTop: 3, fontFamily: "monospace" }}>
                        {m.receipts.join(" · ")}
                      </div>
                    )}
                  </>
                ) : m.isFuture ? (
                  <div style={{ fontSize: 12, color: C.grey, marginTop: 4 }}>Upcoming</div>
                ) : m.isOverdue ? (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, color: C.red, fontWeight: 800, fontSize: 12, marginTop: 4 }}>
                      <AlertTriangle size={13} /> OVERDUE
                    </div>
                    {m.pendingCount > 0 && (
                      <div style={{ fontSize: 12, color: C.amber }}>{m.pendingCount} awaiting approval</div>
                    )}
                    {m.approvedCount > 0 && (
                      <div style={{ fontSize: 12, color: C.mintDeep }}>{m.approvedCount} ready to pay</div>
                    )}
                    <div style={{ fontSize: 12, color: C.grey, marginTop: 3 }}>Click to take action →</div>
                  </>
                ) : isActionable ? (
                  <>
                    {m.pendingCount > 0 && (
                      <div style={{ fontSize: 12, color: C.amber, marginTop: 4 }}>{m.pendingCount} awaiting approval</div>
                    )}
                    {m.approvedCount > 0 && (
                      <div style={{ fontSize: 12, color: C.mintDeep }}>{m.approvedCount} ready to pay</div>
                    )}
                    <div style={{ fontSize: 12, color: C.grey, marginTop: 3 }}>Click to select →</div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: C.faint, marginTop: 4 }}>No commissions</div>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Process New Payout ─────────────────────────────────────────────── */}
      <section ref={processRef} style={{ ...card(), padding: "20px 24px" }}>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: "-.01em" }}>Process New Payout</h2>
              {periodOverdue && (
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 5, background: C.redBg, color: C.red,
                  borderRadius: 999, padding: "3px 10px", fontSize: 11, fontWeight: 800,
                }}>
                  <AlertTriangle size={12} /> OVERDUE
                </span>
              )}
            </div>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: C.grey }}>
              Select a period and mark approved commissions as paid
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <label style={fieldLabel} htmlFor="payout-period">Payout period</label>
              <select
                id="payout-period"
                style={{ ...control, width: 250 }}
                value={period.value}
                onChange={e => setSelected(e.target.value)}
              >
                {PAYOUT_PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            {/* Ares' single all-VA button. Qleno's endpoint is per-VA, so this
                stays disabled rather than pretending one click settles the
                month — the row buttons below do the real work. */}
            <button
              style={{ ...btn("primary"), opacity: .5, cursor: "not-allowed" }}
              disabled
              title="Qleno processes payouts per VA — use the Review & pay button on each row."
            >
              <DollarSign size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              Process Payout ({money2(approvedTotal)})
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: C.grey, marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Calendar size={13} /> Covers first cleans in <strong style={{ color: C.ink }}>{period.qualifyingLabel}</strong>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Clock size={13} /> Pays on <strong style={{ color: C.ink }}>{dateFmt(period.payoutDate)}</strong>
          </span>
          <span>Payouts run one VA at a time and are idempotent — re-running a VA for the same month cannot pay twice.</span>
        </div>
      </section>

      {/* ── Period summary — 3 across ──────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        <div style={{ ...card(), padding: "16px 20px" }}>
          <div style={eyebrow()}>Approved (Ready)</div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.03em", color: C.mintDeep, marginTop: 5 }}>
            {money2(approvedTotal)}
          </div>
          <div style={{ fontSize: 12.5, color: C.grey }}>{approvedRows.length} commissions</div>
        </div>
        <div style={{ ...card(), padding: "16px 20px" }}>
          <div style={eyebrow()}>Already Paid</div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.03em", color: C.info, marginTop: 5 }}>
            {money2(paidTotal)}
          </div>
          <div style={{ fontSize: 12.5, color: C.grey }}>{paidRows.length} commissions</div>
        </div>
        <div style={{ ...card(), padding: "16px 20px" }}>
          <div style={eyebrow()}>Period Total</div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.03em", marginTop: 5 }}>
            {money2(approvedTotal + paidTotal)}
          </div>
          <div style={{ fontSize: 12.5, color: C.grey }}>
            {approvedRows.length + paidRows.length} commissions
          </div>
        </div>
      </div>

      {/* ── VA breakdown, with the netting spelled out ─────────────────────── */}
      <section style={{ ...card(), overflow: "hidden" }}>
        <div style={{ padding: "18px 24px 0" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>VA Breakdown</h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.grey }}>
            Gross earned, less confirmed chargebacks and any carryover still owed from an earlier month, equals net paid.
          </p>
        </div>
        {previewLoading && (
          <div style={{ padding: "14px 24px", fontSize: 13, color: C.grey }}>Loading payout preview…</div>
        )}
        {vaRows.length === 0 ? (
          <div style={{ padding: "40px 24px", textAlign: "center" }}>
            <DollarSign size={28} style={{ opacity: .3 }} />
            <p style={{ margin: "10px 0 0", fontSize: 13.5, color: C.grey }}>No commissions for this period</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th()}>VA</th>
                  <th style={{ ...th(), textAlign: "right" }}>Gross</th>
                  <th style={{ ...th(), textAlign: "right" }}>Chargebacks</th>
                  <th style={{ ...th(), textAlign: "right" }}>Prior carryover</th>
                  <th style={{ ...th(), textAlign: "right" }}>Net payout</th>
                  <th style={{ ...th(), textAlign: "right" }}>Carries forward</th>
                  <th style={{ ...th(), textAlign: "right" }}>Already paid</th>
                  <th style={th()}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {vaRows.map(r => {
                  const pv = r.preview;
                  return (
                    <tr key={r.id}>
                      <td style={td()}>
                        <div style={{ fontWeight: 700 }}>{r.name}</div>
                        <div style={{ fontSize: 12, color: C.grey }}>
                          {r.count} commission{r.count === 1 ? "" : "s"}
                          {pv ? ` · ${pv.lines.length} in this payout` : ""}
                        </div>
                      </td>
                      <td style={{ ...td(), textAlign: "right", fontWeight: 700 }}>
                        {pv ? money2(pv.gross) : money2(r.approvedAmount)}
                      </td>
                      <td style={{ ...td(), textAlign: "right", color: pv && pv.chargeback_total > 0 ? C.red : C.faint }}>
                        {pv && pv.chargeback_total > 0 ? `-${money2(pv.chargeback_total)}` : "—"}
                      </td>
                      <td style={{ ...td(), textAlign: "right", color: pv && pv.prior_carryover > 0 ? C.red : C.faint }}>
                        {pv && pv.prior_carryover > 0 ? `-${money2(pv.prior_carryover)}` : "—"}
                      </td>
                      <td style={{ ...td(), textAlign: "right", fontWeight: 800, color: pv && pv.net > 0 ? C.mintDeep : C.grey }}>
                        {pv ? money2(pv.net) : "—"}
                      </td>
                      <td style={{ ...td(), textAlign: "right", color: pv && pv.carryover > 0 ? C.amber : C.faint }}>
                        {pv && pv.carryover > 0 ? money2(pv.carryover) : "—"}
                      </td>
                      <td style={{ ...td(), textAlign: "right", color: C.grey }}>
                        {r.paidAmount > 0 ? money2(r.paidAmount) : "—"}
                      </td>
                      <td style={td()}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            style={pv && pv.lines.length > 0 && !previewLoading ? btn("primary") : { ...btn(), opacity: .5, cursor: "not-allowed" }}
                            disabled={!pv || pv.lines.length === 0 || previewLoading}
                            onClick={() => pv && setConfirm({ vaId: r.id, vaName: r.name, preview: pv })}
                            title={previewLoading
                              ? "Refreshing the payout preview…"
                              : pv && pv.lines.length === 0 ? "Nothing approved for this VA in this period" : undefined}
                          >
                            Review & pay
                          </button>
                          {/* Ares sent a payout email per VA (:4309-4420). Qleno
                              has no email-preview or send endpoint yet, so the
                              control stays but does nothing it cannot do. */}
                          <button
                            style={{ ...btn(), opacity: .5, cursor: "not-allowed" }}
                            disabled
                            title="Needs a commission email endpoint — not built yet."
                          >
                            <Mail size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Email
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...td(), fontWeight: 800 }}>Total</td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>{money2(totals.gross)}</td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800, color: totals.chargebacks > 0 ? C.red : C.faint }}>
                    {totals.chargebacks > 0 ? `-${money2(totals.chargebacks)}` : "—"}
                  </td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800, color: totals.prior > 0 ? C.red : C.faint }}>
                    {totals.prior > 0 ? `-${money2(totals.prior)}` : "—"}
                  </td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800, color: C.mintDeep }}>{money2(totals.net)}</td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800, color: totals.carryover > 0 ? C.amber : C.faint }}>
                    {totals.carryover > 0 ? money2(totals.carryover) : "—"}
                  </td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>{money2(paidTotal)}</td>
                  <td style={td()} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* ── Payout History Log ─────────────────────────────────────────────── */}
      <section style={{ ...card(), overflow: "hidden" }}>
        <div style={{
          padding: "18px 24px", display: "flex", gap: 14, alignItems: "flex-end",
          flexWrap: "wrap", borderBottom: `1px solid ${C.lineSoft}`,
        }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Payout History Log</h3>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: C.grey }}>All processed payouts with receipt numbers</p>
          </div>
          <div>
            <label style={fieldLabel} htmlFor="history-va">VA</label>
            <select
              id="history-va"
              style={{ ...control, width: 180 }}
              value={String(historyVa)}
              onChange={e => setHistoryVa(e.target.value === "all" ? "all" : Number(e.target.value))}
            >
              <option value="all">All VAs</option>
              {vaOptions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <button style={btn()} onClick={exportCsv} disabled={historyRows.length === 0 && paidFallback.length === 0}>
            <Download size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Export CSV
          </button>
        </div>

        {paymentsQ.loading ? (
          <div style={{ padding: "24px", fontSize: 13, color: C.grey }}>Loading payout history…</div>
        ) : payments.length > 0 ? (
          /* Mode B — grouped payment records exist. */
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th()}>Date</th>
                  <th style={th()}>VA</th>
                  <th style={th()}>Sales Period</th>
                  <th style={th()}>Receipt #</th>
                  <th style={th()}>Method</th>
                  <th style={{ ...th(), textAlign: "right" }}>Gross</th>
                  <th style={{ ...th(), textAlign: "right" }}>Deductions</th>
                  <th style={{ ...th(), textAlign: "right" }}>Carried forward</th>
                  <th style={{ ...th(), textAlign: "right" }}>Amount</th>
                  <th style={{ ...th(), textAlign: "right" }}>Commissions</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map(p => (
                  <tr key={p.id}>
                    <td style={td()}>{dateFmt(p.processed_at)}</td>
                    <td style={td()}>{p.va_name || vaName(p.va_user_id)}</td>
                    <td style={td()}>
                      {p.sales_period
                        || (p.period_start && p.period_end ? `${p.period_start} → ${p.period_end}` : "—")}
                    </td>
                    <td style={td()}>
                      {p.receipt_number ? (
                        <span style={{
                          fontFamily: "monospace", fontSize: 12, border: `1px solid ${C.line}`,
                          borderRadius: 6, padding: "2px 7px",
                        }}>{p.receipt_number}</span>
                      ) : "—"}
                    </td>
                    <td style={td()}>{p.payment_method || "—"}</td>
                    <td style={{ ...td(), textAlign: "right" }}>{money2(num(p.gross_amount))}</td>
                    <td style={{ ...td(), textAlign: "right", color: num(p.chargeback_total) > 0 ? C.red : C.faint }}>
                      {num(p.chargeback_total) > 0 ? `-${money2(num(p.chargeback_total))}` : "—"}
                    </td>
                    <td style={{ ...td(), textAlign: "right", color: num(p.carryover_amount) > 0 ? C.amber : C.faint }}>
                      {num(p.carryover_amount) > 0 ? money2(num(p.carryover_amount)) : "—"}
                    </td>
                    <td style={{ ...td(), textAlign: "right", fontWeight: 800, color: C.mintDeep }}>
                      {money2(num(p.total_amount))}
                    </td>
                    <td style={{ ...td(), textAlign: "right" }}>{p.item_count || 0}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...td(), fontWeight: 800 }} colSpan={8}>Total</td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>
                    {money2(historyRows.reduce((s, p) => s + num(p.total_amount), 0))}
                  </td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>
                    {historyRows.reduce((s, p) => s + (p.item_count || 0), 0)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : paidFallback.length === 0 ? (
          <div style={{ padding: "40px 24px", textAlign: "center" }}>
            <History size={28} style={{ opacity: .3 }} />
            <p style={{ margin: "10px 0 2px", fontSize: 13.5, color: C.grey }}>No payout records yet</p>
            <p style={{ margin: 0, fontSize: 12.5, color: C.faint }}>
              Process your first payout above to see records here
            </p>
          </div>
        ) : (
          /* Mode A — individual paid commissions, no grouped record yet. */
          <div>
            <div style={{ padding: "12px 24px", fontSize: 12.5, color: C.grey }}>
              Showing individual commission payments. Use "Review &amp; pay" above to create grouped payout records with receipts.
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th()}>Date Paid</th>
                    <th style={th()}>Client</th>
                    <th style={th()}>VA</th>
                    <th style={th()}>First Clean</th>
                    <th style={th()}>Type</th>
                    <th style={{ ...th(), textAlign: "right" }}>Amount</th>
                    <th style={th()}>Receipt #</th>
                  </tr>
                </thead>
                <tbody>
                  {paidFallback.map(c => (
                    <tr key={c.id}>
                      <td style={td()}>{c.paid_date ? dateFmt(c.paid_date) : "—"}</td>
                      <td style={td()}>{c.client_name || "Unknown"}</td>
                      <td style={td()}>{c.va_name || vaName(c.va_user_id)}</td>
                      <td style={td()}>{c.first_cleaning_date ? dateFmt(c.first_cleaning_date) : "—"}</td>
                      <td style={td()}>
                        <span style={{
                          border: `1px solid ${C.line}`, borderRadius: 999, padding: "2px 9px",
                          fontSize: 11.5, fontWeight: 700, color: C.grey,
                        }}>
                          {c.client_type ? c.client_type[0].toUpperCase() + c.client_type.slice(1) : "—"}
                        </span>
                      </td>
                      <td style={{ ...td(), textAlign: "right", fontWeight: 700, color: C.mintDeep }}>
                        {money2(num(c.amount))}
                      </td>
                      {/* Ares synthesised a receipt string (PHR-yy-mm-NNN) for
                          rows that had none. Qleno issues real receipt numbers
                          when a payout runs, so an invented one here would be a
                          lie on a money screen — these rows simply have none. */}
                      <td style={{ ...td(), color: C.faint }}>
                        {c.payment_id ? `Payment #${c.payment_id}` : "— not grouped"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ ...td(), fontWeight: 800 }} colSpan={5}>Total</td>
                    <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>{money2(sumAmount(paidFallback))}</td>
                    <td style={td()} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </section>

      {confirm && (
        <ConfirmPayoutModal
          key={`${confirm.vaId}:${period.value}`}
          vaId={confirm.vaId}
          vaName={confirm.vaName}
          preview={confirm.preview}
          periodLabel={period.label}
          onDone={afterPayout}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// ── Confirm Payout Processing (Ares :4139-4306) ─────────────────────────────
// The preview is frozen at open time: a background reload must never change the
// numbers an office user is in the middle of confirming.
function ConfirmPayoutModal({ vaId, vaName, preview, periodLabel, onDone, onClose }: {
  vaId: number; vaName: string; preview: PayoutPreview; periodLabel: string;
  onDone: () => void; onClose: () => void;
}) {
  const [snapshot] = useState<PayoutPreview>(preview);
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyPaid, setAlreadyPaid] = useState<string | null>(null);
  // What the server actually settled. `processPayout` recomputes the preview
  // inside the transaction, so a chargeback confirmed while this modal was open
  // changes these numbers — the snapshot below is only what the operator saw.
  const [result, setResult] = useState<
    { receipt_number: string; payment_id: number; preview: PayoutPreview } | null
  >(null);

  const owedBack = snapshot.chargeback_total + snapshot.prior_carryover;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setAlreadyPaid(null);
    try {
      const out = await apiPost<{ payment_id: number; receipt_number: string; preview: PayoutPreview }>(
        "/recurring/commissions/payout/process",
        {
          va_user_id: vaId,
          payout_month: snapshot.payout_month,
          payment_method: method || null,
          notes: notes || null,
        },
      );
      setResult(out);
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The server answers a repeat run with 409 "<month> has already been paid
      // for this VA (<receipt>)". apiPost surfaces the message but not the
      // status, so we match on it: an idempotent no-op is information, not a
      // failure, and must not read like the payout broke.
      if (/already been paid|already paid/i.test(msg)) {
        setAlreadyPaid(msg);
        onDone();
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm Payout Processing"
      style={{
        position: "fixed", inset: 0, background: soft("var(--night)", 45), zIndex: 60,
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "6vh 16px", overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div style={{ ...card(), width: "min(720px, 100%)", padding: 0 }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: "20px 24px 0" }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Confirm Payout Processing</h3>
          <p style={{ margin: "5px 0 0", fontSize: 13, color: C.grey }}>
            Review the commissions that will be marked as paid. This action cannot be undone.
          </p>
        </div>

        <div style={{ padding: "16px 24px 24px", display: "flex", flexDirection: "column", gap: 16 }}>

          {result && (
            <Callout tone="ok">
              Payout processed for {vaName} — receipt <strong>{result.receipt_number}</strong>.{" "}
              {money2(result.preview.net)} paid across {result.preview.lines.length} commission
              {result.preview.lines.length === 1 ? "" : "s"}.
              {result.preview.carryover > 0
                ? ` ${money2(result.preview.carryover)} of chargebacks could not be collected and carries to next month.`
                : ""}
              {result.preview.net !== snapshot.net
                ? ` This differs from the ${money2(snapshot.net)} previewed — the figures were recomputed at the moment of payment.`
                : ""}
            </Callout>
          )}
          {alreadyPaid && <Callout tone="info">{alreadyPaid} Nothing was paid twice — the figures below are already settled.</Callout>}
          {error && <Callout tone="danger">Couldn't process this payout: {error}</Callout>}

          {/* Summary panel */}
          <div style={{ background: C.mintBg, borderRadius: 12, padding: "14px 18px" }}>
            {[
              ["VA", vaName],
              ["Payout Period", `${periodLabel} · earned ${dateFmt(snapshot.period_start)} – ${dateFmt(snapshot.period_end)}`],
              ["Payout Date", dateFmt(snapshot.payout_date)],
              ["Total Commissions", String(snapshot.lines.length)],
              ["Gross Amount", money2(snapshot.gross)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 16, fontSize: 13, padding: "3px 0" }}>
                <span style={{ color: C.grey, fontWeight: 600 }}>{k}</span>
                <span style={{ fontWeight: 800, textAlign: "right" }}>{v}</span>
              </div>
            ))}
          </div>

          {/* Payout details */}
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 10 }}>
              Payout Details <span style={{ color: C.faint, fontWeight: 600 }}>(optional)</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              <div>
                <label style={fieldLabel} htmlFor="sales-period">Sales Period Label</label>
                {/* Ares let the operator type this. Qleno derives it from the
                    earning window server-side, so the field shows what will be
                    stored instead of pretending to accept an override. */}
                <input
                  id="sales-period"
                  style={{ ...control, width: "100%", opacity: .6 }}
                  disabled
                  value={`${new Date(snapshot.period_start + "T12:00:00").toLocaleString("en-US", { month: "long", year: "numeric" })} sales`}
                  readOnly
                />
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 4 }}>
                  Set automatically from the earning period — the payout API derives it.
                </div>
              </div>
              <div>
                <label style={fieldLabel} htmlFor="payout-method">Payment Method</label>
                <select
                  id="payout-method"
                  style={{ ...control, width: "100%" }}
                  value={method}
                  onChange={e => setMethod(e.target.value)}
                  disabled={!!result}
                >
                  <option value="">Select method...</option>
                  {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label style={fieldLabel} htmlFor="payout-notes">Notes / Confirmation #</label>
                <input
                  id="payout-notes"
                  style={{ ...control, width: "100%" }}
                  placeholder="e.g. Transaction ID, reference number..."
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  disabled={!!result}
                />
              </div>
            </div>
          </div>

          {/* The netting, line by line */}
          <div>
            <div style={{ ...eyebrow(), marginBottom: 8 }}>Commissions in this payout</div>
            {snapshot.lines.length === 0 ? (
              <div style={{ fontSize: 13, color: C.grey }}>No approved commissions for this payout period</div>
            ) : (
              <div style={{ border: `1px solid ${C.lineSoft}`, borderRadius: 10, overflow: "hidden" }}>
                {snapshot.lines.map(l => (
                  <div key={l.id} style={{
                    display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13,
                    padding: "8px 12px", borderBottom: `1px solid ${C.lineSoft}`,
                  }}>
                    <span>
                      {l.client_name || "Unknown"}
                      <span style={{ color: C.faint }}>
                        {l.first_cleaning_date ? ` (${dateFmt(l.first_cleaning_date)})` : ""}
                      </span>
                    </span>
                    <span style={{ fontWeight: 700 }}>{money2(l.amount)}</span>
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "8px 12px", fontWeight: 800 }}>
                  <span>Gross</span><span>{money2(snapshot.gross)}</span>
                </div>
              </div>
            )}
          </div>

          {(snapshot.chargebacks.length > 0 || snapshot.prior_carryover > 0) && (
            <div>
              <div style={{ ...eyebrow(), marginBottom: 8, color: C.red }}>Chargeback Deductions</div>
              <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                {snapshot.chargebacks.map(cb => (
                  <div key={cb.id} style={{
                    display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13,
                    padding: "8px 12px", color: C.red, borderBottom: `1px solid ${C.lineSoft}`,
                  }}>
                    <span>{cb.client_name || "Unknown client"}</span>
                    <span style={{ fontWeight: 700 }}>-{money2(cb.amount)}</span>
                  </div>
                ))}
                {snapshot.prior_carryover > 0 && (
                  <div style={{
                    display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13,
                    padding: "8px 12px", color: C.red, borderBottom: `1px solid ${C.lineSoft}`,
                  }}>
                    <span>Carryover still owed from an earlier payout</span>
                    <span style={{ fontWeight: 700 }}>-{money2(snapshot.prior_carryover)}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "8px 12px", fontWeight: 800 }}>
                  <span>Total deducted</span><span style={{ color: C.red }}>-{money2(owedBack)}</span>
                </div>
              </div>
            </div>
          )}

          <div style={{
            display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline",
            background: C.tint2, borderRadius: 10, padding: "12px 16px",
          }}>
            <span style={{ fontWeight: 800, fontSize: 14 }}>Net Payout</span>
            <span style={{ fontWeight: 800, fontSize: 22, color: C.mintDeep, letterSpacing: "-.02em" }}>
              {money2(snapshot.net)}
            </span>
          </div>

          {snapshot.carryover > 0 && (
            <Callout tone="warn">
              Note: {money2(snapshot.carryover)} in chargebacks exceeds this payout and will carry to next month.
            </Callout>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
            <button style={btn()} onClick={onClose}>{result || alreadyPaid ? "Close" : "Cancel"}</button>
            {!result && !alreadyPaid && (
              <button
                style={submitting || snapshot.lines.length === 0
                  ? { ...btn("primary"), opacity: .5, cursor: "not-allowed" }
                  : btn("primary")}
                disabled={submitting || snapshot.lines.length === 0}
                onClick={submit}
              >
                {submitting
                  ? "Processing…"
                  : <><CheckCircle size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />Confirm Payout ({money2(snapshot.net)})</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
