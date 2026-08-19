import { useMemo, useState, type ReactNode } from "react";
import { FileText, BarChart3, Download, Clock, MessageSquare, Users, AlertTriangle } from "lucide-react";
import { C, money2, dateFmt, card, eyebrow, btn, th, td, Callout, LoadError, Empty } from "../_ui";
import { useCommissionData, PAYOUT_PERIODS, initials, type CommissionRow, type PaymentRow } from "./api";

// [ares-parity 2026-08-18] Reports tab — rebuild of Ares' CommissionPortal
// "Reports & Exports" (:2943-3134).
//
// Two honest halves:
//   * PDF (owner statement, per-VA statements, emailed statements) has NO Qleno
//     endpoint. The controls are rendered for real and disabled, each with a
//     one-line note naming what is missing. Per the build contract we do not
//     fake them and we do not quietly drop them — a money screen that looks
//     finished but isn't is the failure mode.
//   * CSV is genuinely buildable in the browser from the rows we already hold,
//     so all three Quick Exports are live, with Ares' exact column sets.

interface Props {
  commissions: CommissionRow[];
  vaOptions: Array<{ id: number; name: string }>;
}

// Ares' /api/commissions/pdf/* has no counterpart in Qleno yet. One constant so
// the note reads identically everywhere it appears.
const PDF_NOTE =
  "Disabled — this needs a PDF endpoint on the commissions API (Ares used /commissions/pdf/...); Qleno has none yet. The CSV exports below are live.";

// Ares treated pending/approved/paid as "eligible" for a period. Qleno splits
// Ares' pending into earned (pre-review) + pending_review, so both count.
const ELIGIBLE_STATUSES = ["earned", "pending_review", "approved", "paid"];

// Payout lands on the last Friday of the month AFTER the month the work was
// earned in — same rule the payout engine uses.
function lastFridayOf(year: number, monthIdx0: number): Date {
  const d = new Date(year, monthIdx0 + 1, 0);
  while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
  return d;
}

// Ares performed no CSV escaping at all except a comma -> semicolon swap on the
// YTD export. DEVIATION: we apply that same swap to every text cell in all
// three exports. A client named "Smith, Jane" silently shifted every following
// column in Ares' file, which is a data bug, not a feature worth replicating.
const csvText = (v: unknown) => String(v ?? "").replace(/,/g, ";").replace(/[\r\n]+/g, " ");

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const today = () => new Date().toISOString().split("T")[0];

// An export with nothing to export is greyed rather than hidden, so the office
// can see the button exists and that the reason it is off is "no rows".
const csvBtn = (empty: boolean) => (empty ? { ...btn(), opacity: .5, cursor: "not-allowed" } : btn());

export default function Reports({ commissions, vaOptions }: Props) {
  const [ownerStatementPeriod, setOwnerStatementPeriod] = useState("all");
  // Stands in for Ares' toast: the office needs to see that a file left.
  const [lastExport, setLastExport] = useState<string | null>(null);

  // Ares' reconciliation table read /api/commission-payments/period-status.
  // Qleno has no period-status endpoint, so we derive the same shape from the
  // commissions already in memory plus the real payment records.
  const paymentsQ = useCommissionData<{ count: number; payments: PaymentRow[] }>(
    "/recurring/commissions/payments",
  );
  const payments = paymentsQ.data?.payments ?? [];

  const vaName = useMemo(() => {
    const m = new Map<number, string>();
    vaOptions.forEach(v => m.set(v.id, v.name));
    return m;
  }, [vaOptions]);

  // ── Reconciliation: last 12 earned months, oldest first ───────────────────
  const months = useMemo(() => {
    const now = new Date();
    const out: Array<{
      key: string; label: string; eligibleCommissions: number; eligibleAmount: number;
      isPaid: boolean; isOverdue: boolean; isFuture: boolean;
      totalAmount: number; receiptNumbers: string[]; payoutDue: Date;
    }> = [];

    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

      // Bonuses carry no first cleaning date, so fall back to earned_date —
      // exactly what the payout window does. Ares only looked at the first
      // clean and therefore silently omitted every bonus from this table.
      const eligible = commissions.filter(c => {
        const anchor = c.first_cleaning_date || c.earned_date;
        return !!anchor && anchor.slice(0, 7) === key && ELIGIBLE_STATUSES.includes(c.status);
      });
      const eligibleAmount = eligible.reduce((s, c) => s + Number(c.amount || 0), 0);

      // A payment's period_start is the earned window it settled, so it keys
      // to the same month this row is about.
      const mine = payments.filter(p => (p.period_start || "").slice(0, 7) === key);
      const paidViaItems = eligible.length > 0 && eligible.every(c => c.status === "paid");
      const isPaid = mine.length > 0 || paidViaItems;

      // Work earned in month M is paid on the last Friday of M+1 (see the
      // rule stated above and implemented by the payout engine), so the due
      // date is anchored a month AFTER the earned month this row is about.
      // lastFridayOf() rolls December into the next January on its own.
      const payoutDue = lastFridayOf(d.getFullYear(), d.getMonth() + 1);
      const isFuture = payoutDue >= now;
      const isOverdue = payoutDue < now && !isPaid && eligible.length > 0;

      out.push({
        key,
        label: d.toLocaleString("en-US", { month: "long", year: "numeric" }),
        eligibleCommissions: eligible.length,
        eligibleAmount,
        isPaid,
        isOverdue,
        isFuture,
        totalAmount: mine.length > 0
          ? mine.reduce((s, p) => s + Number(p.total_amount || 0), 0)
          : eligible.filter(c => c.status === "paid").reduce((s, c) => s + Number(c.amount || 0), 0),
        receiptNumbers: mine.map(p => p.receipt_number).filter(Boolean) as string[],
        payoutDue,
      });
    }
    return out;
  }, [commissions, payments]);

  // ── Quick Exports (live) ──────────────────────────────────────────────────
  const exportAllCommissions = () => {
    const name = `PHES-All-Commissions-${today()}.csv`;
    downloadCsv(
      name,
      ["Client", "VA", "Type", "First Clean", "Amount", "Status", "CB Expires"],
      commissions.map(c => [
        csvText(c.client_name),
        csvText(c.va_name || vaName.get(c.va_user_id) || ""),
        csvText(c.client_type),
        c.first_cleaning_date ? csvText(dateFmt(c.first_cleaning_date)) : "",
        c.amount || "0",
        csvText(c.status),
        c.chargeback_until ? csvText(dateFmt(c.chargeback_until)) : "",
      ]),
    );
    setLastExport(name);
  };

  // Ares filtered status === "pending". Qleno split that into earned
  // (pre-review) + pending_review; both are "not yet decided", so both belong
  // in a file whose whole purpose is "what still needs a decision".
  const pendingRows = useMemo(
    () => commissions.filter(c => c.status === "pending_review" || c.status === "earned"),
    [commissions],
  );

  const exportPendingCommissions = () => {
    const name = `PHES-Pending-Commissions-${today()}.csv`;
    downloadCsv(
      name,
      ["Client", "VA", "Type", "Cadence", "First Clean", "Amount"],
      pendingRows.map(c => [
        csvText(c.client_name),
        csvText(c.va_name || vaName.get(c.va_user_id) || ""),
        csvText(c.client_type),
        csvText(c.cadence),
        c.first_cleaning_date ? csvText(dateFmt(c.first_cleaning_date)) : "",
        c.amount || "0",
      ]),
    );
    setLastExport(name);
  };

  const year = new Date().getFullYear();
  const ytdPayments = useMemo(
    () => payments.filter(p => p.processed_at && new Date(p.processed_at).getFullYear() === year),
    [payments, year],
  );

  const exportYtdPayouts = () => {
    const name = `PHES-YTD-Payouts-${year}.csv`;
    downloadCsv(
      name,
      ["Date", "VA", "Sales Period", "Receipt #", "Method", "Amount", "Commissions", "Notes"],
      ytdPayments.map(p => [
        p.processed_at ? new Date(p.processed_at).toLocaleDateString() : "",
        csvText(p.va_name || vaName.get(p.va_user_id) || ""),
        csvText(p.sales_period),
        csvText(p.receipt_number),
        csvText(p.payment_method),
        p.total_amount || "0",
        p.item_count || 0,
        csvText(p.notes),
      ]),
    );
    setLastExport(name);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>

      <div>
        <h2 style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-.02em", margin: 0 }}>
          Reports &amp; Exports
        </h2>
        <p style={{ fontSize: 13.5, color: C.grey, margin: "5px 0 0" }}>
          Download commission reports, VA statements, and owner summaries
        </p>
      </div>

      {/* ── Owner Payout Statement ──────────────────────────────────────── */}
      <section style={{ ...card(), padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <FileText size={16} style={{ color: C.grey }} />
          <span style={{ fontWeight: 800, fontSize: 15 }}>Owner Payout Statement</span>
        </div>
        <p style={{ fontSize: 13.5, color: C.grey, margin: "6px 0 16px" }}>
          Comprehensive payout summary for ownership review — all VAs, totals, and cadence breakdown
        </p>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ display: "block" }}>
            <span style={eyebrow()}>Statement Period</span>
            <select
              value={ownerStatementPeriod}
              onChange={e => setOwnerStatementPeriod(e.target.value)}
              style={{
                display: "block", marginTop: 6, font: "inherit", fontSize: 13,
                padding: "7px 10px", borderRadius: "var(--radius-control)",
                border: `1px solid ${C.line}`, background: C.card, color: C.ink, minWidth: 230,
              }}
            >
              <option value="all">All Time</option>
              {PAYOUT_PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>

          <button
            disabled
            title={PDF_NOTE}
            style={{ ...btn("primary"), opacity: .5, cursor: "not-allowed" }}
          >
            <Download size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Download Owner Statement
          </button>
        </div>

        <Note>{PDF_NOTE}</Note>
      </section>

      {/* ── Reconciliation Dashboard ────────────────────────────────────── */}
      <section style={{ ...card(), overflow: "hidden" }}>
        <div style={{ padding: "20px 24px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <BarChart3 size={16} style={{ color: C.grey }} />
            <span style={{ fontWeight: 800, fontSize: 15 }}>Reconciliation Dashboard</span>
          </div>
          <p style={{ fontSize: 13.5, color: C.grey, margin: "6px 0 0" }}>
            Monthly owed vs. paid comparison for the last 12 months
          </p>
        </div>

        {paymentsQ.error && (
          <div style={{ padding: "0 24px" }}>
            <LoadError what="the payout records" error={paymentsQ.error} />
          </div>
        )}

        {paymentsQ.loading ? (
          <div style={{ padding: "24px", color: C.grey, fontSize: 13.5 }}>Loading reconciliation data…</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th()}>Period</th>
                  <th style={{ ...th(), textAlign: "right" }}>Eligible</th>
                  <th style={{ ...th(), textAlign: "right" }}>Eligible $</th>
                  <th style={{ ...th(), textAlign: "right" }}>Paid</th>
                  <th style={th()}>Status</th>
                  <th style={th()}>Receipt(s)</th>
                </tr>
              </thead>
              <tbody>
                {/* Newest month first, as Ares rendered it. */}
                {months.slice().reverse().map(m => (
                  <tr key={m.key}>
                    <td style={{ ...td(), fontWeight: 700 }}>{m.label}</td>
                    <td style={{ ...td(), textAlign: "right" }}>{m.eligibleCommissions}</td>
                    <td style={{ ...td(), textAlign: "right" }}>
                      {m.eligibleAmount > 0 ? money2(m.eligibleAmount) : "—"}
                    </td>
                    <td style={{ ...td(), textAlign: "right", color: m.isPaid ? C.mintDeep : C.faint, fontWeight: m.isPaid ? 700 : 400 }}>
                      {m.isPaid ? money2(m.totalAmount) : "—"}
                    </td>
                    <td style={td()}><PeriodStatus m={m} /></td>
                    <td style={{ ...td(), fontFamily: "ui-monospace, monospace", fontSize: 12.5, color: C.grey }}>
                      {m.receiptNumbers.length > 0 ? m.receiptNumbers.join(", ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ padding: "0 24px 18px" }}>
          <Note>
            Derived on this screen from the commission list and the real payout records — Qleno has no
            period-status endpoint, so &quot;paid&quot; means a payout record exists for the period or every
            eligible commission in it is already paid.
          </Note>
        </div>
      </section>

      {/* ── VA Statements ───────────────────────────────────────────────── */}
      <section>
        <h3 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 12px" }}>VA Statements</h3>

        {vaOptions.length === 0 ? (
          <Empty>
            <Users size={30} style={{ opacity: .3, display: "block", margin: "0 auto 10px" }} />
            <p style={{ margin: 0 }}>No VAs found</p>
          </Empty>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
            {vaOptions.map(va => (
              <div key={va.id} style={{ ...card(), padding: "18px 20px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 999, background: C.tint2, color: C.grey,
                    display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13, flexShrink: 0,
                  }}>{initials(va.name)}</div>
                  <div style={{ fontWeight: 800 }}>{va.name}</div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
                  <button disabled title={PDF_NOTE} style={{ ...btn(), opacity: .5, cursor: "not-allowed", textAlign: "left" }}>
                    <Download size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                    All-Time Statement
                  </button>
                  <button disabled title={PDF_NOTE} style={{ ...btn(), opacity: .5, cursor: "not-allowed", textAlign: "left" }}>
                    <FileText size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                    Current Month
                  </button>
                  <button
                    disabled
                    title="Disabled — needs a commission email endpoint and template. Any send would still pass Qleno's COMMS_ENABLED gate."
                    style={{ ...btn(), opacity: .5, cursor: "not-allowed", textAlign: "left", border: "0", background: "none" }}
                  >
                    <MessageSquare size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                    Email Statement
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <Note>
          {PDF_NOTE} Email Statement additionally needs a commission email endpoint, and any send would
          still pass the COMMS_ENABLED gate. Ares also printed each VA&apos;s email address on this card;
          the VA list this tab receives carries id and name only.
        </Note>
      </section>

      {/* ── Quick Exports (live) ────────────────────────────────────────── */}
      <section style={{ ...card(), padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Download size={16} style={{ color: C.grey }} />
          <span style={{ fontWeight: 800, fontSize: 15 }}>Quick Exports</span>
        </div>
        <p style={{ fontSize: 13.5, color: C.grey, margin: "6px 0 16px" }}>
          Download system-wide commission and payout data
        </p>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button style={csvBtn(commissions.length === 0)} onClick={exportAllCommissions} disabled={commissions.length === 0}>
            <Download size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            All Commissions (CSV) · {commissions.length}
          </button>
          <button style={csvBtn(pendingRows.length === 0)} onClick={exportPendingCommissions} disabled={pendingRows.length === 0}>
            <Clock size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Pending Review (CSV) · {pendingRows.length}
          </button>
          <button style={csvBtn(ytdPayments.length === 0)} onClick={exportYtdPayouts} disabled={ytdPayments.length === 0}>
            <BarChart3 size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            YTD Payouts (CSV) · {ytdPayments.length}
          </button>
        </div>

        {lastExport && (
          <div style={{ marginTop: 12 }}>
            <Callout tone="ok">Downloaded {lastExport}</Callout>
          </div>
        )}

        <Note>
          Built in the browser from the rows on screen, so the file always matches what you are looking at.
          &quot;Pending Review&quot; includes both earned and pending_review — Qleno splits Ares&apos; single
          pending status in two and both still need a decision. Commas inside names and notes are written as
          semicolons so a column never shifts.
        </Note>
      </section>
    </div>
  );
}

// A short, quiet line explaining why something is off or where a number came
// from. Kept visually subordinate to a Callout so it never reads as an alarm.
function Note({ children }: { children: ReactNode }) {
  return (
    <div style={{
      marginTop: 12, fontSize: 12.5, lineHeight: 1.5, color: C.grey,
      borderLeft: `2px solid ${C.line}`, paddingLeft: 10,
    }}>
      {children}
    </div>
  );
}

function PeriodStatus({ m }: { m: { isPaid: boolean; isOverdue: boolean; isFuture: boolean } }) {
  const pill = (label: string, fg: string, bg: string) => (
    <span style={{
      background: bg, color: fg, borderRadius: 999, padding: "3px 11px",
      fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5,
    }}>{label}</span>
  );
  if (m.isPaid) return pill("Paid", C.mintDeep, C.mintBg);
  if (m.isOverdue) {
    return (
      <span style={{
        background: C.redBg, color: C.red, borderRadius: 999, padding: "3px 11px",
        fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5,
      }}>
        <AlertTriangle size={12} /> Overdue
      </span>
    );
  }
  if (m.isFuture) return pill("Upcoming", C.grey, C.tint2);
  return pill("No Activity", C.faint, C.tint2);
}
