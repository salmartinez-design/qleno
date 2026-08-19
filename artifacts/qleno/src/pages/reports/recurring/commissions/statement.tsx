import { useMemo, useState } from "react";
import {
  Printer, Download, ChevronDown, ChevronRight, Target, Shield, TrendingUp,
  Eye, Search, CheckCircle,
} from "lucide-react";
import {
  C, money2, dateFmt, titleCase,
  card, eyebrow, btn, th, td, StatusChip, Callout, LoadError, Empty,
} from "../_ui";
import { useCommissionData, type CommissionRow, type StatementResp } from "./api";

// [ares-parity 2026-08-18] VA Commission Statement — a faithful rebuild of
// Ares' VACommissionStatement (CommissionPortal.tsx:4669-5199) and, via
// `viewingAsOther`, of ImpersonatedVAView (:5201-5596).
//
// Ares was dark-mode-first; Qleno has no dark mode, so the palette is the only
// intended visual difference. Every figure, column, control, empty state and
// verbatim string from the spec is here.
//
// Ares used formatMoney() = 2 decimal places everywhere on this screen, so
// every amount below renders through money2(). A VA reconciles this against a
// PayPal receipt to the cent; rounding to whole dollars would break that.

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  vaUserId: number;
  vaName?: string | null;
  // True when an office user is viewing another VA's statement. Render the
  // "view only" banner and suppress any control that would act as that VA.
  viewingAsOther?: boolean;
  onExitView?: () => void;
}

// ── Status vocabulary (Qleno names; see BUILD-CONTRACT status mapping) ───────
// Ares' `pending` is Qleno's `pending_review`, and Ares' `chargebacked` is
// Qleno's `charged_back`. Qleno also has a pre-review `earned` status Ares had
// no equivalent for — it is treated alongside `pending_review` throughout.

const CHARGEBACK_STATUSES = ["charged_back", "chargeback_pending", "chargeback_confirmed", "recouped"];
// Ares: gross earnings exclude the chargeback family AND rejected — but NOT
// not_eligible. Reproduced as written (routes.ts:4369-4376) rather than
// "corrected", because the footer has to tie out to what Ares paid.
const GROSS_EXCLUDED = [...CHARGEBACK_STATUSES, "rejected"];
// Statuses that count toward "This Month" (Ares: pending, paid, approved).
const THIS_MONTH_STATUSES = ["earned", "pending_review", "approved", "paid"];

// Roll-up order for a client that has several commission lines: the most
// consequential status wins, so a client with a live clawback never reads
// "Paid" in the portfolio.
const STATUS_RANK = [
  "chargeback_confirmed", "charged_back", "chargeback_pending", "recouped",
  "paid", "approved", "on_hold", "pending_review", "earned", "rejected", "not_eligible",
];

// ── Small helpers ────────────────────────────────────────────────────────────

const num = (v: string | number | null | undefined) => {
  // Money arrives as strings on CommissionRow / the ledger — never arithmetic
  // on the raw value.
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// Anchor bare YYYY-MM-DD at local noon, same reason dateFmt() does: a date-only
// value must not render a day early in US Central.
const asDate = (s: string | Date | null | undefined): Date | null => {
  if (!s) return null;
  const d = s instanceof Date ? s : new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s);
  return isNaN(d.getTime()) ? null : d;
};

// Whole CALENDAR days from `from` to `to`. Differencing raw timestamps against
// a noon-anchored date flips the answer at local noon, so the same deadline
// read as N+1 in the morning and N in the afternoon. The deadline day itself is
// 0 days left — which is what the server's daily sweep assumes when it acts on
// `deadline <= today`.
const daysBetweenDays = (from: Date, to: Date) => {
  const a = new Date(from); a.setHours(0, 0, 0, 0);
  const b = new Date(to); b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
};

const periodOf = (d: Date | null) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : null;

// Last Friday of the given month — Ares' payout date rule.
function lastFriday(year: number, monthIndex: number): Date {
  const d = new Date(year, monthIndex + 1, 0, 12, 0, 0);
  while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
  return d;
}

// Ares: last Friday of this month, rolling to next month once it has passed.
function nextPayoutDate(now = new Date()): Date {
  const f = lastFriday(now.getFullYear(), now.getMonth());
  return f >= now ? f : lastFriday(now.getFullYear(), now.getMonth() + 1);
}

// Ares' cadence vocabulary (cadence-config.ts:33-125). Qleno stores the cadence
// as a free-text snapshot on the commission line, so normalize before mapping
// and fall back to title case rather than inventing a label.
function cadenceLabel(cadence: string | null | undefined): string {
  if (!cadence) return "Unknown";
  const k = cadence.toLowerCase().replace(/[^a-z0-9]/g, "");
  const map: Record<string, string> = {
    weekly: "Weekly",
    biweekly: "Biweekly", everyotherweek: "Biweekly", every2weeks: "Biweekly",
    semimonthly: "Semi-Monthly", twicemonthly: "Semi-Monthly",
    every3weeks: "Every 3 Weeks", triweekly: "Every 3 Weeks",
    monthly: "Monthly", every4weeks: "Monthly",
    every5weeks: "Every 5 Weeks",
    every6weeks: "Every 6 Weeks",
    every8weeks: "Every 8 Weeks",
    custom: "Custom",
  };
  return map[k] || titleCase(cadence);
}

// The month a line belongs to. The server buckets ledger entries by the month
// of the first cleaning (sales-commission.ts:425), so the period filter here
// uses the same anchor — otherwise the rows and the footer would disagree.
const lineDate = (l: CommissionRow) => asDate(l.first_cleaning_date || l.earned_date || l.created_at);

// Ares: paid_date when paid; otherwise, for a line still in flight, the last
// Friday of the month AFTER the client's first clean (payout month M pays
// first-cleans in M-1).
function payoutDateFor(l: CommissionRow): string | null {
  if (l.paid_date) return l.paid_date;
  if (!["approved", "pending_review", "earned"].includes(l.status)) return null;
  const start = asDate(l.first_cleaning_date || l.earned_date);
  if (!start) return null;
  return lastFriday(start.getFullYear(), start.getMonth() + 1).toISOString().slice(0, 10);
}

// Ares' generatePeriodOptions (:4683-4693): "All Time", then this month and the
// previous 11.
function periodOptions(now = new Date()): Array<{ value: string; label: string }> {
  const out = [{ value: "all", label: "All Time" }];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    });
  }
  return out;
}

// ── Derived row shapes ───────────────────────────────────────────────────────

interface StatementItem {
  key: string;
  date: string | null;
  description: string;
  type: string;
  amount: number;
  status: string | null;
  payoutDate: string | null;
  disputeDeadline: string | null;
  paidDate: string | null;
}

interface PortfolioRow {
  key: string;
  name: string;
  type: string | null;
  cadence: string | null;
  startDate: string | null;
  commissionEarned: number;
  commissionStatus: string;
  payoutDate: string | null;
  inWindow: boolean;
  daysLeft: number;
  lost: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function Statement({ vaUserId, vaName, viewingAsOther, onExitView }: Props) {
  const [period, setPeriod] = useState("all");
  const [clientSearch, setClientSearch] = useState("");
  const [expandedPayout, setExpandedPayout] = useState<number | null>(null);

  // Qleno's statement endpoint takes no ?period — it returns the VA's whole
  // history and the period select filters client-side. Ares filtered on the
  // server; the visible numbers are the same because the bucketing rule is the
  // same (see lineDate / ledger.related_period).
  const { data, loading, error } = useCommissionData<StatementResp>(
    `/recurring/commissions/statement/${vaUserId}`,
  );

  const options = useMemo(() => periodOptions(), []);
  const periodLabel = options.find(o => o.value === period)?.label ?? "All Time";
  const displayName = vaName || `VA #${vaUserId}`;

  const lines = useMemo(() => data?.lines ?? [], [data]);
  const ledger = useMemo(() => data?.ledger ?? [], [data]);
  const payouts = useMemo(() => data?.payouts ?? [], [data]);

  // ── Earnings summary (§13.3) ───────────────────────────────────────────────
  // total_paid_out / pending_amount / approved_amount come straight from the
  // server's summary. Everything else Ares showed has no field in `summary`, so
  // it is derived here from `lines` / `ledger` and each derivation is named.
  const summary = data?.summary;

  const thisMonthEarnings = useMemo(() => {
    // DERIVED — no summary field. Ares: sum of lines whose first clean (falling
    // back to creation) lands in the current month and whose status is
    // pending/approved/paid. Qleno's pre-review `earned` is included with
    // pending_review per the contract's status mapping.
    const start = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    return lines
      .filter(l => THIS_MONTH_STATUSES.includes(l.status))
      .filter(l => { const d = lineDate(l); return d != null && d >= start; })
      .reduce((s, l) => s + num(l.amount), 0);
  }, [lines]);

  const ytdEarnings = useMemo(() => {
    // DERIVED — no summary field. Taken from the LEDGER's payout entries rather
    // than from paid lines: the schema is explicit that money moves through the
    // ledger and an adjustment can move money without ever creating a line, so
    // summing lines under-reports what the VA was actually paid.
    //
    // Anchored on when the payout was PROCESSED (created_at), not on the payout
    // month it settled (related_period) — that is the same anchor the Payout
    // History block below groups on. Anchoring the two differently put a
    // December payout run in January inside this year's YTD while it rendered
    // under "January <next year>" a few blocks down the same page.
    const year = new Date().getFullYear();
    return ledger
      .filter(e => e.entry_type === "payout")
      .filter(e => { const d = asDate(e.created_at); return d != null && d.getFullYear() === year; })
      .reduce((s, e) => s + Math.abs(num(e.amount)), 0);
  }, [ledger]);

  // DERIVED — no summary field. Ares computed the next payout date on the
  // server as the last Friday of this month, rolling forward once past.
  const nextPayout = useMemo(() => nextPayoutDate(), []);

  // ── Client portfolio (§13.4) ───────────────────────────────────────────────
  const portfolio = useMemo<PortfolioRow[]>(() => {
    // DERIVED — Qleno's statement payload has no subscription portfolio, so the
    // portfolio is rolled up from the VA's own commission lines, one row per
    // client. That is the same population Ares showed (its server-side query
    // also required "has at least one commission submission").
    const now = new Date();
    const groups = new Map<string, CommissionRow[]>();
    for (const l of lines) {
      // A performance bonus has no subscription and no client — it is money,
      // not a client, so it belongs in Statement Detail, not the portfolio.
      if (!l.client_id && !l.client_name) continue;
      const key = String(l.client_id ?? `name:${(l.client_name || "").toLowerCase()}`);
      const arr = groups.get(key);
      if (arr) arr.push(l); else groups.set(key, [l]);
    }
    const rows: PortfolioRow[] = [];
    groups.forEach((rowLines, key) => {
      const first = rowLines[0];
      const rank = (s: string) => { const i = STATUS_RANK.indexOf(s); return i < 0 ? STATUS_RANK.length : i; };
      const lead = rowLines.reduce((a, b) => (rank(b.status) < rank(a.status) ? b : a));
      const starts = rowLines.map(l => l.first_cleaning_date).filter(Boolean).sort();
      const untils = rowLines.map(l => asDate(l.chargeback_until)).filter(Boolean) as Date[];
      const until = untils.length ? new Date(Math.max(...untils.map(d => d.getTime()))) : null;
      const inWindow = !!until && until > now;
      rows.push({
        key,
        name: first.client_name || "Unknown",
        type: rowLines.find(l => l.client_type)?.client_type ?? null,
        cadence: rowLines.find(l => l.cadence)?.cadence ?? null,
        startDate: starts[0] ?? null,
        // Rejected and not-eligible lines never became money, so they must not
        // inflate what this client earned — and neither may a `recouped` line,
        // whose money HAS been taken back out of a payout. The still-open
        // clawback statuses stay in: nothing has moved for them yet, which is
        // the same lifecycle rule the statement detail below follows.
        commissionEarned: rowLines
          .filter(l => !["rejected", "not_eligible", "recouped"].includes(l.status))
          .reduce((s, l) => s + num(l.amount), 0),
        commissionStatus: rowLines.length ? lead.status : "none",
        payoutDate: payoutDateFor(lead),
        inWindow,
        daysLeft: until ? Math.max(0, daysBetweenDays(now, until)) : 0,
        // DERIVED — the statement payload carries no subscription lifecycle, so
        // "lost" is inferred from clawback activity: a chargeback only ever
        // fires because the client cancelled inside the window.
        lost: rowLines.some(l => CHARGEBACK_STATUSES.includes(l.status)),
      });
    });
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }, [lines]);

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    if (!q) return portfolio;
    // Ares' VA view filtered on name OR city; the impersonated view filtered on
    // name only. Qleno's commission line carries no city, so both collapse to
    // name — the city half of the Ares filter has no data to match against.
    return portfolio.filter(c => c.name.toLowerCase().includes(q));
  }, [portfolio, clientSearch]);

  const filteredTotal = filteredClients.reduce((s, c) => s + c.commissionEarned, 0);

  // ── Statement detail (§13.5) ───────────────────────────────────────────────

  // commission id → the period its ledger `chargeback` entry was booked in.
  // That entry is only written when the clawback is actually recouped, and it
  // carries related_period = the PAYOUT month it was netted out of
  // (sales-commission.ts:955), typically one to three months after the loss.
  const chargebackLedgerPeriod = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of ledger) {
      if (e.entry_type !== "chargeback") continue;
      if (e.commission_id == null || !e.related_period) continue;
      m.set(e.commission_id, e.related_period);
    }
    return m;
  }, [ledger]);

  const items = useMemo<StatementItem[]>(() => {
    const out: StatementItem[] = [];
    for (const l of lines) {
      const p = periodOf(lineDate(l));
      if (period === "all" || p === period) {
        out.push({
          key: `c${l.id}`,
          date: l.first_cleaning_date || l.earned_date || l.created_at,
          description: `New Client: ${l.client_name || "Unknown"} (${cadenceLabel(l.cadence)})`,
          type: l.client_type || "—",
          amount: num(l.amount),
          status: l.status,
          payoutDate: payoutDateFor(l),
          disputeDeadline: l.chargeback_dispute_deadline,
          paidDate: l.paid_date,
        });
      }
      // Signed chargeback row, appended per Ares (routes.ts:4340-4365). It is a
      // separate line from the commission it reverses, so the statement shows
      // both the credit and the clawback rather than a silently netted figure.
      if (CHARGEBACK_STATUSES.includes(l.status)) {
        const cbDate = l.chargeback_date || l.created_at;
        // DEVIATION from Ares: the chargeback row is bucketed where the LEDGER
        // books the clawback, because the footer totals below are computed from
        // that same ledger. The ledger's chargeback entry is written at recoup
        // time with related_period = the payout month it was netted out of, NOT
        // the month of the loss — bucketing by the loss date instead left the
        // loss month showing a row against a $0 footer and the payout month a
        // footer with no row. Until that entry exists (nothing has been
        // deducted yet) the loss date is the only date there is, so the row
        // shows up there.
        const cbPeriod = chargebackLedgerPeriod.get(l.id) ?? periodOf(asDate(cbDate));
        if (period === "all" || cbPeriod === period) {
          const label =
            l.status === "chargeback_pending"   ? "CHARGEBACK PENDING"
            : l.status === "chargeback_confirmed" ? "CHARGEBACK CONFIRMED"
            : l.status === "recouped"             ? "CHARGEBACK RECOUPED"
            : "CHARGEBACK";
          out.push({
            key: `cb${l.id}`,
            date: cbDate,
            description: `${label}: ${l.client_name || "Unknown"}`,
            type: "deduction",
            // Only money that has ACTUALLY moved is negative here. The footer's
            // CHARGEBACKS total comes from the server's ledger `chargeback`
            // entries, and those are written only at recoup time — so anything
            // short of `recouped` (pending, confirmed, or disputed) is $0 on the
            // row too. The row itself stays visible, with its status chip and
            // "not deducted yet" copy, so the VA still sees the clawback coming.
            amount: ["chargeback_pending", "chargeback_confirmed", "charged_back"].includes(l.status)
              ? 0
              : -num(l.amount),
            status: l.status,
            payoutDate: l.status === "recouped" ? l.paid_date : null,
            disputeDeadline: l.chargeback_dispute_deadline,
            paidDate: l.paid_date,
          });
        }
      }
    }
    // Ares had no equivalent row, but Qleno's ledger can move money WITHOUT a
    // commission line (a frequency upgrade/downgrade is an `adjustment`). Those
    // dollars are inside the gross/net footer below, so omitting the rows would
    // leave a statement whose lines do not add up to its own total.
    for (const e of ledger) {
      if (e.entry_type !== "adjustment") continue;
      if (period !== "all" && e.related_period !== period) continue;
      out.push({
        key: `l${e.id}`,
        date: e.created_at,
        description: e.description,
        type: "adjustment",
        amount: num(e.amount),
        status: null,
        payoutDate: null,
        disputeDeadline: null,
        paidDate: null,
      });
    }
    // Ares sorted the statement ascending by date.
    return out.sort((a, b) => (asDate(a.date)?.getTime() ?? 0) - (asDate(b.date)?.getTime() ?? 0));
  }, [lines, ledger, period, chargebackLedgerPeriod]);

  const totals = useMemo(() => {
    // At "All Time" these are the server's own summary figures. For a single
    // month they are recomputed from the ledger using the SAME rule the server
    // uses (getCommissionSummary): gross = every entry that is not a chargeback
    // or a payout; chargebacks = the absolute value of the chargeback entries.
    if (period === "all") {
      return {
        gross: summary?.total_earned ?? 0,
        chargebacks: summary?.total_charged_back ?? 0,
        net: summary?.net_earnings ?? 0,
      };
    }
    const scoped = ledger.filter(e => e.related_period === period);
    const gross = scoped
      .filter(e => e.entry_type !== "chargeback" && e.entry_type !== "payout")
      .reduce((s, e) => s + num(e.amount), 0);
    const chargebacks = scoped
      .filter(e => e.entry_type === "chargeback")
      .reduce((s, e) => s + Math.abs(num(e.amount)), 0);
    return { gross, chargebacks, net: Math.round((gross - chargebacks) * 100) / 100 };
  }, [period, summary, ledger]);

  // ── Payout history (§13.6) ─────────────────────────────────────────────────
  const payoutMonths = useMemo(() => {
    // Ares grouped paid commissions by the month of their paid date. Qleno has
    // real payment records, so the grouping is by the month a payout was
    // processed and each payment keeps its own receipt number and method.
    const groups = new Map<string, typeof payouts>();
    for (const p of payouts) {
      const key = periodOf(asDate(p.processed_at)) ?? "unknown";
      const arr = groups.get(key);
      if (arr) arr.push(p); else groups.set(key, [p]);
    }
    return Array.from(groups.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))   // newest month first
      .map(([month, rows]) => ({
        month,
        label: month === "unknown"
          ? "Unknown period"
          : new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
              .toLocaleDateString("en-US", { month: "long", year: "numeric" }),
        total: rows.reduce((s, r) => s + num(r.total_amount), 0),
        rows,
      }));
  }, [payouts]);

  // ── Performance bonus (§13.7) ──────────────────────────────────────────────
  const bonus = useMemo(() => {
    // DERIVED — no summary field. Ares: count this month's commission lines
    // whose lowercased cadence contains "weekly" (which also catches
    // "biweekly"); 5 of them earns a flat $100.
    const start = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const current = lines.filter(l => {
      const d = lineDate(l);
      if (!d || d < start) return false;
      const c = (l.cadence || "").toLowerCase();
      return c.includes("weekly") || c.includes("biweekly");
    }).length;
    return { current, target: 5, amount: 100 };
  }, [lines]);

  const bonusPct = Math.min(100, (bonus.current / bonus.target) * 100);

  const riskClients = useMemo(
    () => portfolio.filter(c => c.inWindow).sort((a, b) => a.daysLeft - b.daysLeft),
    [portfolio],
  );
  const cbRiskClients = portfolio.filter(c => c.inWindow && c.lost).length;

  const totalClients = portfolio.length;
  const lostClients = portfolio.filter(c => c.lost).length;
  const activeClients = totalClients - lostClients;
  // Ares defaulted retention to 100% when a VA has no clients at all.
  const retention = totalClients === 0 ? 100 : Math.round((activeClients / totalClients) * 100);
  const retentionColor = retention >= 80 ? C.mintDeep : retention >= 60 ? C.amber : C.red;

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div style={{ color: C.grey, padding: "40px 0", fontSize: 14 }}>Loading your commission statement…</div>;
  if (error) return <LoadError what="this commission statement" error={error} />;
  // Ares: "Unable to load commission statement". Never render zeroes here — an
  // empty money screen reads as "you earned nothing", the worst wrong answer.
  if (!data || !summary) return <Empty>Unable to load commission statement</Empty>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {/* Ares used Tailwind's print: variant; this module has no Tailwind, so
          the print rules live in one scoped style block. */}
      <style>{`@media print { .va-stmt-noprint { display: none !important; } }`}</style>

      {/* ── View-only banner (§14.1) ──────────────────────────────────────── */}
      {viewingAsOther && (
        <Callout tone="warn">
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Eye size={16} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 800 }}>Viewing as {displayName}</div>
              <div style={{ fontWeight: 600 }}>This is a read-only view of this VA's commission data.</div>
              {/* Ares opened a real impersonation session — the office user
                  became the VA and every action was taken as them. Qleno has no
                  impersonation: this is the office user reading the VA's
                  statement through an endpoint that only permits reads, so
                  there is nothing here that could act as the VA. */}
              <div style={{ fontWeight: 600, fontSize: 12.5, marginTop: 4, opacity: .85 }}>
                Qleno has no impersonation session — you are reading this VA's data as yourself. No control here acts on their behalf.
              </div>
            </div>
            {onExitView && (
              <button className="va-stmt-noprint" style={btn()} onClick={onExitView}>Exit view</button>
            )}
          </div>
        </Callout>
      )}

      {/* ── Block 1 — Statement header (§13.2) ────────────────────────────── */}
      <div className="va-stmt-noprint" style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-.02em", margin: 0 }}>Commission Statement</h2>
          {/* Ares printed "name • email" here. Qleno's statement payload carries
              no email address, so only the name is shown rather than a blank
              bullet. */}
          <p style={{ color: C.grey, fontSize: 13.5, margin: "3px 0 0" }}>{displayName}</p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select
            aria-label="Select Period"
            value={period}
            onChange={e => setPeriod(e.target.value)}
            style={{ ...btn(), width: 180, fontWeight: 600, cursor: "pointer" }}
          >
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button style={btn()} onClick={() => window.print()}>
            <Printer size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />Print
          </button>
          {/* NOT AVAILABLE: Ares hit GET /api/commissions/pdf/va-statement.
              Qleno has no PDF endpoint for the VA statement, so the control is
              rendered disabled and says so rather than being dropped — a money
              screen that looks complete but isn't is the failure to avoid. */}
          <button
            disabled
            title="Needs a server-side PDF endpoint (GET /recurring/commissions/pdf/va-statement) that Qleno does not have yet."
            style={{ ...btn(), opacity: .55, cursor: "not-allowed" }}
          >
            <Download size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />Download My Statement
          </button>
        </div>
        <div style={{ flexBasis: "100%", fontSize: 11.5, color: C.faint }}>
          PDF download needs a statement endpoint Qleno doesn't have yet. Print works and produces the same statement.
        </div>
      </div>

      {/* ── Block 2 — Earnings Summary (§13.3) ────────────────────────────── */}
      <section>
        <div style={{ ...eyebrow(), marginBottom: 10 }}>Earnings Summary</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
          {/* Ares called this "Total Career Earnings"; the later name is
              "Total Paid Out", which is also literally what it sums. */}
          <SummaryCard label="Total Paid Out" value={money2(summary.total_paid_out)} caption="All-time paid commissions" strong />
          <SummaryCard label="This Month" value={money2(thisMonthEarnings)} caption="Earned so far" tone={C.mintDeep} />
          <SummaryCard label="Pending Approval" value={money2(summary.pending_amount)} caption="Awaiting review" tone={C.amber} />
          <SummaryCard
            label="Next Payout"
            value={money2(summary.approved_amount)}
            caption={dateFmt(nextPayout) || "TBD"}
            tone={C.info}
            accent
          />
          <SummaryCard label="YTD Earnings" value={money2(ytdEarnings)} caption={`${new Date().getFullYear()} total paid`} />
        </div>
      </section>

      {/* ── Block 3 — My Client Portfolio (§13.4) ─────────────────────────── */}
      <section style={{ ...card(), overflow: "hidden" }}>
        <div style={{ padding: "18px 22px", borderBottom: `1px solid ${C.lineSoft}`, display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>
              {viewingAsOther ? "Client Portfolio" : "My Client Portfolio"}
            </h3>
            <p style={{ color: C.grey, fontSize: 13, margin: "3px 0 0" }}>
              {viewingAsOther
                ? `Clients signed by ${displayName}`
                : `${totalClients} client${totalClients === 1 ? "" : "s"}`}
            </p>
            {/* Ares printed "N clients | $X/mo MRR" here. MRR is a subscription
                figure and is not in the statement payload — stating a number we
                cannot compute would be worse than naming the gap. */}
            <p style={{ color: C.faint, fontSize: 11.5, margin: "2px 0 0" }}>
              MRR generated isn't part of the statement payload — it needs the recurring subscriptions feed.
            </p>
          </div>
          <label className="va-stmt-noprint" style={{ display: "inline-flex", alignItems: "center", gap: 8, border: `1px solid ${C.line}`, borderRadius: "var(--radius-control)", padding: "6px 10px", background: C.card, width: 200 }}>
            <Search size={14} style={{ color: C.faint, flexShrink: 0 }} />
            <input
              value={clientSearch}
              onChange={e => setClientSearch(e.target.value)}
              placeholder="Search clients..."
              style={{ border: 0, outline: "none", font: "inherit", fontSize: 13, background: "transparent", color: C.ink, width: "100%" }}
            />
          </label>
        </div>

        {/* The 4 stat tiles Ares showed only in the impersonated view (§14.3). */}
        {viewingAsOther && (
          <div style={{ display: "flex", flexWrap: "wrap", borderBottom: `1px solid ${C.lineSoft}` }}>
            <Tile value={activeClients} label="Active" tone={C.mintDeep} />
            <Tile value={riskClients.length} label="In Window" tone={C.amber} />
            {/* "CB Risk" is not the same count as "In Window": it is a client
                that has already been lost AND is still inside the clawback
                window — the population that can actually cost the VA money. */}
            <Tile value={cbRiskClients} label="CB Risk" tone={C.red} />
            <Tile value={lostClients} label="Lost" tone={C.grey} />
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          {/* Ares rendered this twice — a mobile card stack and a desktop table.
              With inline styles and no Tailwind breakpoints, two renderings
              would mean two places to change one column, so this is a single
              table that scrolls horizontally on a phone. The mobile-only
              information (the dispute deadline / deducted date that Ares passed
              to the mobile StatusBadge) is preserved as the chip suffix. */}
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
            <thead>
              <tr>
                <th style={th()}>Client Name</th>
                <th style={th()}>Type</th>
                <th style={th()}>Frequency</th>
                <th style={th()}>First Cleaning</th>
                <th style={{ ...th(), textAlign: "right" }}>Commission</th>
                <th style={th()}>Commission Status</th>
                <th style={th()}>Payout Date</th>
                <th style={th()}>Window Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredClients.map(c => (
                <tr key={c.key}>
                  <td style={{ ...td(), fontWeight: 700 }}>{c.name}</td>
                  <td style={td()}>
                    <span style={{
                      background: c.type === "commercial" ? C.infoBg : C.tint2,
                      color: c.type === "commercial" ? C.info : C.grey,
                      borderRadius: 999, padding: "3px 10px", fontSize: 11.5, fontWeight: 700,
                    }}>{titleCase(c.type) || "—"}</span>
                  </td>
                  <td style={td()}>{cadenceLabel(c.cadence)}</td>
                  <td style={{ ...td(), color: C.grey }}>{c.startDate ? dateFmt(c.startDate) : "—"}</td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 700 }}>{money2(c.commissionEarned)}</td>
                  <td style={td()}><CommissionStatus status={c.commissionStatus} /></td>
                  <td style={{ ...td(), color: C.grey }}>{c.payoutDate ? dateFmt(c.payoutDate) : "—"}</td>
                  <td style={td()}><HealthBadge lost={c.lost} inWindow={c.inWindow} /></td>
                </tr>
              ))}
              {filteredClients.length === 0 && (
                <tr><td colSpan={8} style={{ ...td(), textAlign: "center", color: C.grey, padding: "34px 14px" }}>
                  No commission-eligible clients found
                </td></tr>
              )}
            </tbody>
            {/* Ares' impersonated view dropped this footer; it is kept for both
                viewers because the office user needs the same total the VA sees
                when the two of them are on the phone about it. */}
            {filteredClients.length > 0 && (
              <tfoot>
                <tr>
                  {/* DEVIATION from Ares, which printed the full client count
                      here. The dollar figure beside it is the filtered total,
                      so with a search term active the two disagreed; the count
                      now describes the same rows the total sums. */}
                  <td colSpan={4} style={{ ...td(), fontWeight: 800, borderTop: `1px solid ${C.line}` }}>
                    {filteredClients.length} Commission-Eligible Clients
                  </td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800, borderTop: `1px solid ${C.line}` }}>
                    {money2(filteredTotal)} Total
                  </td>
                  <td colSpan={3} style={{ ...td(), borderTop: `1px solid ${C.line}` }} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* ── Block 4 — Statement Detail (§13.5) ────────────────────────────── */}
      <section style={{ ...card(), overflow: "hidden" }}>
        <div style={{ padding: "18px 22px", borderBottom: `1px solid ${C.lineSoft}` }}>
          <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Statement Detail</h3>
          <p style={{ color: C.grey, fontSize: 13, margin: "3px 0 0" }}>
            {viewingAsOther ? `Transaction history for ${displayName} · ` : ""}Period: {periodLabel}
          </p>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
            <thead>
              <tr>
                <th style={th()}>Date</th>
                <th style={th()}>Description</th>
                <th style={th()}>Type</th>
                <th style={{ ...th(), textAlign: "right" }}>Amount</th>
                <th style={th()}>Status</th>
                <th style={th()}>Payout Date</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.key}>
                  <td style={{ ...td(), whiteSpace: "nowrap", color: C.grey }}>{dateFmt(it.date)}</td>
                  <td style={td()}>{it.description}</td>
                  <td style={{ ...td(), textTransform: "capitalize", color: C.grey }}>{titleCase(it.type)}</td>
                  {/* Ares showed a bare minus sign in rose for a deduction and
                      no plus sign for a credit; reproduced as written. */}
                  <td style={{
                    ...td(), textAlign: "right", fontWeight: 700,
                    color: it.amount < 0 ? C.red : C.ink,
                  }}>
                    {it.amount < 0 ? "-" : ""}{money2(Math.abs(it.amount))}
                  </td>
                  <td style={td()}>
                    {it.status
                      ? <StatusChip status={it.status} suffix={statusSuffix(it)} />
                      : <span style={{ color: C.faint }}>—</span>}
                  </td>
                  <td style={{ ...td(), color: C.grey }}>{it.payoutDate ? dateFmt(it.payoutDate) : "—"}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={6} style={{ ...td(), textAlign: "center", color: C.grey, padding: "34px 14px" }}>
                  No transactions for this period
                </td></tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} style={{ ...td(), ...eyebrow(), borderTop: `1px solid ${C.line}`, color: C.grey }}>GROSS EARNINGS:</td>
                <td style={{ ...td(), textAlign: "right", fontWeight: 800, borderTop: `1px solid ${C.line}` }}>{money2(totals.gross)}</td>
                <td colSpan={2} style={{ ...td(), borderTop: `1px solid ${C.line}` }} />
              </tr>
              <tr>
                <td colSpan={3} style={{ ...td(), ...eyebrow(), color: C.grey }}>CHARGEBACKS:</td>
                <td style={{ ...td(), textAlign: "right", fontWeight: 800, color: C.red }}>-{money2(totals.chargebacks)}</td>
                <td colSpan={2} style={td()} />
              </tr>
              <tr>
                <td colSpan={3} style={{ ...td(), ...eyebrow(), color: C.ink }}>NET EARNINGS:</td>
                <td style={{ ...td(), textAlign: "right", fontWeight: 800, fontSize: 16, color: C.mintDeep }}>{money2(totals.net)}</td>
                <td colSpan={2} style={td()} />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* ── Block 5 — Payout History (§13.6) ──────────────────────────────── */}
      <section style={{ ...card(), overflow: "hidden" }}>
        <div style={{ padding: "18px 22px", borderBottom: `1px solid ${C.lineSoft}` }}>
          <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Payout History</h3>
          <p style={{ color: C.grey, fontSize: 13, margin: "3px 0 0" }}>Previous commission payments</p>
        </div>
        {payoutMonths.length === 0 ? (
          <div style={{ padding: "34px 22px", textAlign: "center", color: C.grey, fontSize: 13.5 }}>No payout history yet</div>
        ) : (
          <div>
            {payoutMonths.map(group => (
              <div key={group.month}>
                <div style={{
                  display: "flex", alignItems: "baseline", gap: 10, padding: "10px 22px",
                  background: C.tint, borderBottom: `1px solid ${C.lineSoft}`,
                }}>
                  <span style={eyebrow()}>{group.label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.grey, fontWeight: 700 }}>{money2(group.total)}</span>
                </div>
                {group.rows.map(p => {
                  const open = expandedPayout === p.id;
                  // Ares listed the commissions inside a payout. Qleno joins
                  // them properly: commissions.payment_id points at the payment
                  // that paid them, so the breakdown is the real line items.
                  const paidLines = lines.filter(l => l.payment_id === p.id);
                  return (
                    <div key={p.id}>
                      <button
                        onClick={() => setExpandedPayout(open ? null : p.id)}
                        style={{
                          appearance: "none", border: 0, background: "none", font: "inherit",
                          cursor: "pointer", width: "100%", textAlign: "left", padding: "14px 22px",
                          borderBottom: `1px solid ${C.lineSoft}`, display: "flex", gap: 12,
                          alignItems: "center", color: C.ink,
                        }}
                      >
                        {open ? <ChevronDown size={16} style={{ color: C.grey }} /> : <ChevronRight size={16} style={{ color: C.grey }} />}
                        <span>
                          <span style={{ fontWeight: 700, display: "block" }}>{dateFmt(p.processed_at)}</span>
                          <span style={{ fontSize: 12, color: C.grey }}>
                            {p.item_count} commission{p.item_count === 1 ? "" : "s"}
                            {p.payment_method ? ` · ${p.payment_method}` : ""}
                            {p.receipt_number ? ` · ${p.receipt_number}` : ""}
                            {p.status !== "processed" ? ` · ${titleCase(p.status)}` : ""}
                          </span>
                        </span>
                        <span style={{ marginLeft: "auto", fontWeight: 800, color: C.mintDeep }}>{money2(num(p.total_amount))}</span>
                      </button>
                      {open && (
                        <div style={{ padding: "10px 22px 16px 50px", borderBottom: `1px solid ${C.lineSoft}` }}>
                          {paidLines.map(l => (
                            <div key={l.id} style={{
                              display: "flex", gap: 10, alignItems: "baseline", padding: "7px 0",
                              borderBottom: `1px dashed ${C.lineSoft}`, fontSize: 13,
                            }}>
                              <span>{l.client_name || "Unknown"}</span>
                              <span style={{ marginLeft: "auto", fontWeight: 700 }}>{money2(num(l.amount))}</span>
                            </div>
                          ))}
                          {paidLines.length === 0 && (
                            <div style={{ fontSize: 12.5, color: C.faint, padding: "7px 0" }}>
                              This payment's line items are no longer linked to it.
                            </div>
                          )}
                          {/* Gross / chargeback / carryover are on the payment
                              record and Ares never showed them; a VA whose
                              payout was netted down deserves to see why. */}
                          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, color: C.grey, paddingTop: 10 }}>
                            <span>Gross {money2(num(p.gross_amount))}</span>
                            {num(p.chargeback_total) > 0 && <span style={{ color: C.red }}>Chargebacks -{money2(num(p.chargeback_total))}</span>}
                            {num(p.carryover_amount) > 0 && <span style={{ color: C.amber }}>Carried forward {money2(num(p.carryover_amount))}</span>}
                            {p.sales_period && <span>{p.sales_period}</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Block 6 — Performance Dashboard (§13.7) ───────────────────────── */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        {/* 1 — Performance Bonus Progress */}
        <div style={{ ...card(), padding: "18px 20px" }}>
          <div style={{ ...eyebrow(), display: "flex", alignItems: "center", gap: 7 }}>
            <Target size={13} />Performance Bonus Progress
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "12px 0 8px" }}>
            <span style={{ fontWeight: 800, fontSize: 15 }}>
              {bonus.current}/{bonus.target} Weekly/Biweekly Clients
            </span>
            <span style={{ marginLeft: "auto", fontWeight: 800, color: C.mintDeep }}>{money2(bonus.amount)}</span>
          </div>
          <div style={{ height: 12, borderRadius: 999, background: C.tint2, overflow: "hidden" }}>
            <div style={{ width: `${bonusPct}%`, height: "100%", background: C.mint, borderRadius: 999 }} />
          </div>
          {bonus.current >= bonus.target ? (
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 6, marginTop: 12,
              background: C.mintBg, color: C.mintDeep, borderRadius: 999,
              padding: "3px 11px", fontSize: 12, fontWeight: 700,
            }}>
              <CheckCircle size={13} />Bonus Earned!
            </div>
          ) : (
            <p style={{ color: C.grey, fontSize: 12.5, margin: "10px 0 0" }}>
              {bonus.target - bonus.current} more client{bonus.target - bonus.current === 1 ? "" : "s"} needed for ${bonus.amount} bonus
            </p>
          )}
        </div>

        {/* 2 — Chargeback Risk Monitor */}
        <div style={{ ...card(), padding: "18px 20px" }}>
          <div style={{ ...eyebrow(), display: "flex", alignItems: "center", gap: 7 }}>
            <Shield size={13} />Chargeback Risk Monitor
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0 4px" }}>
            <span style={{ fontSize: 13.5 }}>Clients in 6-month window</span>
            <span style={{
              marginLeft: "auto", borderRadius: 999, padding: "3px 11px", fontSize: 12, fontWeight: 700,
              background: riskClients.length > 0 ? C.redBg : C.tint2,
              color: riskClients.length > 0 ? C.red : C.grey,
            }}>{riskClients.length}</span>
          </div>
          {riskClients.length > 0 ? (
            <>
              {riskClients.slice(0, 3).map(c => (
                <div key={c.key} style={{ display: "flex", gap: 10, padding: "6px 0", fontSize: 13 }}>
                  <span>{c.name}</span>
                  <span style={{ marginLeft: "auto", color: C.amber, fontWeight: 700 }}>{c.daysLeft}d left</span>
                </div>
              ))}
              {/* chargeback_exposure is a real summary field Ares had no card
                  for — it is the dollars actually at risk behind that count. */}
              <div style={{ fontSize: 12, color: C.grey, marginTop: 8 }}>
                {money2(summary.chargeback_exposure)} at risk if these clients cancel inside the window.
              </div>
            </>
          ) : (
            <p style={{ color: C.mintDeep, fontSize: 13, margin: "8px 0 0", fontWeight: 600 }}>
              All clients outside chargeback window
            </p>
          )}
        </div>

        {/* 3 — Client Retention */}
        <div style={{ ...card(), padding: "18px 20px" }}>
          <div style={{ ...eyebrow(), display: "flex", alignItems: "center", gap: 7 }}>
            <TrendingUp size={13} />Client Retention
          </div>
          <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-.03em", color: retentionColor, marginTop: 10 }}>
            {retention}%
          </div>
          <p style={{ color: C.grey, fontSize: 12.5, margin: "2px 0 10px" }}>Retention Rate</p>
          <div style={{ display: "flex", gap: 10, fontSize: 13 }}>
            <span>Active: {activeClients}</span>
            <span style={{ marginLeft: "auto", color: C.grey }}>Total: {totalClients}</span>
          </div>
          {/* Named, not hidden: without a subscription lifecycle in this payload
              a "lost" client can only be inferred from a clawback. */}
          <div style={{ fontSize: 11.5, color: C.faint, marginTop: 8 }}>
            Lost is inferred from chargeback activity — the statement payload carries no subscription status.
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function SummaryCard({ label, value, caption, tone, strong, accent }: {
  label: string; value: string; caption: string;
  tone?: string; strong?: boolean; accent?: boolean;
}) {
  return (
    <div style={{
      ...card(),
      padding: "16px 18px",
      background: strong ? C.tint2 : C.card,
      borderColor: accent ? C.info : undefined,
    }}>
      <div style={eyebrow()}>{label}</div>
      <div style={{
        fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", margin: "7px 0 3px",
        color: tone || C.ink,
      }}>{value}</div>
      <div style={{ fontSize: 12, color: C.grey }}>{caption}</div>
    </div>
  );
}

function Tile({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div style={{ flex: 1, minWidth: 110, padding: "14px 18px", borderRight: `1px solid ${C.lineSoft}` }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: tone, letterSpacing: "-.02em" }}>{value}</div>
      <div style={{ ...eyebrow(), marginTop: 4 }}>{label}</div>
    </div>
  );
}

// Ares' StatusBadge rendered "No Commission" for the sentinel status "none",
// which is not part of Qleno's STATUS_META — hence the explicit branch.
function CommissionStatus({ status }: { status: string }) {
  if (!status || status === "none") {
    return (
      <span style={{
        background: C.tint2, color: C.grey, borderRadius: 999, padding: "3px 11px",
        fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", display: "inline-block",
      }}>No Commission</span>
    );
  }
  return <StatusChip status={status} />;
}

// Ares' ClientHealthBadge (:220-231) — four mutually exclusive outputs, in this
// precedence order.
function HealthBadge({ lost, inWindow }: { lost: boolean; inWindow: boolean }) {
  const m =
    lost && inWindow ? { label: "Chargeback Risk", fg: C.red, bg: C.redBg }
    : lost           ? { label: "Lost (Safe)", fg: C.grey, bg: C.tint2 }
    : inWindow       ? { label: "In Window", fg: C.amber, bg: C.amberBg }
    :                  { label: "Active", fg: C.mintDeep, bg: C.mintBg };
  return (
    <span style={{
      background: m.bg, color: m.fg, borderRadius: 999, padding: "3px 11px",
      fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", display: "inline-block",
    }}>{m.label}</span>
  );
}

// Ares' dynamic StatusBadge labels: a pending chargeback names the date the
// dispute window closes, a recouped one names the date it was deducted. Only
// its mobile statement rows passed these through; here they are always shown,
// because "when can I still dispute this" is the single most important thing on
// a clawback row.
function statusSuffix(it: StatementItem): string | null {
  if (it.status === "chargeback_pending" && it.disputeDeadline) return `not deducted yet — dispute open until ${dateFmt(it.disputeDeadline)}`;
  if (it.status === "chargeback_pending") return "not deducted yet — dispute still open";
  if (it.status === "chargeback_confirmed") return "not deducted yet — nets out of the next payout";
  if (it.status === "charged_back") return "not deducted yet — disputed, held out of payout netting";
  if (it.status === "recouped" && it.paidDate) return `deducted ${dateFmt(it.paidDate)}`;
  return null;
}
