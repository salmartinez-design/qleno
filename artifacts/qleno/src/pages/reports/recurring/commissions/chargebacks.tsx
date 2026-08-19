import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, Clock, RotateCcw, Shield } from "lucide-react";
import { C, money2, dateFmt, card, eyebrow, btn, th, td, StatusChip, Callout, LoadError } from "../_ui";
import { apiPost, type CommissionRow } from "./api";

// [ares-parity 2026-08-18] Chargebacks tab — Ares CommissionPortal :2864-2938.
//
// Ares showed one table: residential commissions still inside their 6-month
// window, with a button to open a clawback. That is kept verbatim at the bottom
// of this screen. What Ares never showed — and what caused the arguments — is
// what happens after the button is pressed, so the clawback lifecycle is now
// rendered as its own three steps:
//
//   1. chargeback_pending    the dispute window is open until
//                            chargeback_dispute_deadline. NO money is deducted.
//   2. chargeback_confirmed  the window closed. The amount will be deducted at
//                            the next payout — still not deducted yet.
//   3. recouped              actually deducted, on paid_date, against a payout.
//
// A VA disputing a clawback parks it in `charged_back` ("Disputed by VA"),
// which takes it out of payout netting until someone resolves it.

interface Props {
  commissions: CommissionRow[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const LIFECYCLE_STATUSES = ["chargeback_pending", "chargeback_confirmed", "charged_back", "recouped"];
const STEP_ORDER: Record<string, number> = {
  chargeback_pending: 0, charged_back: 1, chargeback_confirmed: 2, recouped: 3,
};

const num = (v: string | number | null | undefined) => Number(v ?? 0) || 0;

// Date-only values are anchored to local noon, same as _ui's dateFmt, so a
// deadline never reads a day early in US Central.
const parseDay = (s: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s);

// Whole CALENDAR days between today and the target day, not elapsed hours: a
// difference taken against Date.now() flips from N+1 to N at local noon, so the
// same deadline read differently in the morning and the afternoon. The deadline
// day itself is 0 days left, which is what the server's 7am sweep assumes when
// it promotes on `deadline <= today`.
const daysUntil = (s: string) => {
  const target = parseDay(s);
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
};

// The LOCAL calendar date. toISOString() is UTC, which from 19:00 US Central is
// already tomorrow — a loss date in the future, a dispute deadline a day late
// and a ledger entry that can land in the wrong month.
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const control: CSSProperties = {
  font: "inherit", fontSize: 13, fontWeight: 600, color: C.ink, background: C.card,
  border: `1px solid ${C.line}`, borderRadius: "var(--radius-control)", padding: "7px 10px",
};

interface ArmedChargeback { id: number; lossDate: string; reason: string }
interface ArmedDispute { id: number; reason: string }

export default function Chargebacks({ commissions, loading, error, reload }: Props) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [armedChargeback, setArmedChargeback] = useState<ArmedChargeback | null>(null);
  const [armedDispute, setArmedDispute] = useState<ArmedDispute | null>(null);

  // Ares :1017-1021 — approved OR paid, with a chargeback window that has not
  // expired. Deliberately NOT filtered to residential: the tab badge and this
  // table have always counted every open window, and the copy above explains
  // why commercial rarely appears here.
  const atRisk = useMemo(() => commissions.filter(c =>
    (c.status === "approved" || c.status === "paid")
    && !!c.chargeback_until
    && parseDay(c.chargeback_until) > new Date()), [commissions]);

  const lifecycle = useMemo(() => commissions
    .filter(c => LIFECYCLE_STATUSES.includes(c.status))
    .sort((a, b) => {
      const s = (STEP_ORDER[a.status] ?? 9) - (STEP_ORDER[b.status] ?? 9);
      if (s !== 0) return s;
      return String(b.chargeback_date || b.created_at).localeCompare(String(a.chargeback_date || a.created_at));
    }), [commissions]);

  const bucket = (status: string) => lifecycle.filter(c => c.status === status);
  const pending = bucket("chargeback_pending");
  const confirmed = bucket("chargeback_confirmed");
  const disputed = bucket("charged_back");
  const recouped = bucket("recouped");
  const total = (rows: CommissionRow[]) => rows.reduce((s, r) => s + num(r.amount), 0);

  const run = async (id: number, path: string, body: Record<string, unknown>, okMessage: string) => {
    setBusyId(id);
    setActionError(null);
    setActionOk(null);
    try {
      await apiPost(path, body);
      setActionOk(okMessage);
      setArmedChargeback(null);
      setArmedDispute(null);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (error) return <LoadError what="chargebacks" error={error} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>

      <div>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: "-.01em" }}>Chargeback Management</h2>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: C.grey, maxWidth: 720 }}>
          Monitor residential commissions within the 6-month chargeback window. Commercial clients carry a 1-year
          agreement with no chargeback.
        </p>
      </div>

      {actionOk && <Callout tone="ok">{actionOk}</Callout>}
      {actionError && <Callout tone="danger">That didn't go through: {actionError}</Callout>}

      {/* ── The three steps, with what each one means for money ────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14 }}>
        <StepCard
          step="Step 1"
          title="Chargeback pending"
          tone={C.amber}
          toneBg={C.amberBg}
          amount={total(pending)}
          count={pending.length}
          body="Dispute window is open. Nothing has been deducted yet — the VA still has time to contest it."
        />
        <StepCard
          step="Step 2"
          title="Chargeback confirmed"
          tone={C.red}
          toneBg={C.redBg}
          amount={total(confirmed)}
          count={confirmed.length}
          body="Dispute window closed. This amount will be deducted from the VA's next payout. Still not deducted."
        />
        <StepCard
          step="Step 3"
          title="Recouped"
          tone={C.grey}
          toneBg={C.tint2}
          amount={total(recouped)}
          count={recouped.length}
          body="Already deducted against a processed payout. The date shown is the payout it came out of."
        />
        <StepCard
          step="Parked"
          title="Disputed by VA"
          tone={C.info}
          toneBg={C.infoBg}
          amount={total(disputed)}
          count={disputed.length}
          body="Under review. A disputed clawback is left out of payout netting until it is resolved."
        />
      </div>

      {loading && <div style={{ fontSize: 13, color: C.grey }}>Loading commission data…</div>}

      {/* ── Clawbacks in progress ──────────────────────────────────────────── */}
      <section style={{ ...card(), overflow: "hidden" }}>
        <div style={{ padding: "18px 24px 0" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Clawbacks in progress</h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.grey }}>
            Every open and settled clawback, in lifecycle order. Money only moves at step 3.
          </p>
        </div>

        {lifecycle.length === 0 ? (
          <div style={{ padding: "36px 24px", textAlign: "center" }}>
            <Shield size={28} style={{ opacity: .3 }} />
            <p style={{ margin: "10px 0 0", fontSize: 13.5, color: C.grey }}>No clawbacks have been opened</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th()}>Client</th>
                  <th style={th()}>VA</th>
                  <th style={{ ...th(), textAlign: "right" }}>Amount</th>
                  <th style={th()}>Step</th>
                  <th style={th()}>Where it stands</th>
                  <th style={th()}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {lifecycle.map(c => {
                  const deadline = c.chargeback_dispute_deadline;
                  const left = deadline ? daysUntil(deadline) : null;
                  const suffix =
                    c.status === "chargeback_pending"
                      ? (deadline ? `dispute open until ${dateFmt(deadline)}` : "dispute open")
                      : c.status === "chargeback_confirmed" ? "deducting next payout"
                      : c.status === "recouped" ? (c.paid_date ? `deducted ${dateFmt(c.paid_date)}` : "deducted")
                      : "under review";
                  const armed = armedDispute?.id === c.id;
                  return (
                    <tr key={c.id}>
                      <td style={td()}>
                        <div style={{ fontWeight: 700 }}>{c.client_name || "Unknown"}</div>
                        <div style={{ fontSize: 12, color: C.faint }}>
                          Opened {c.chargeback_date ? dateFmt(c.chargeback_date) : dateFmt(c.created_at)}
                        </div>
                      </td>
                      <td style={td()}>{c.va_name || `VA #${c.va_user_id}`}</td>
                      <td style={{ ...td(), textAlign: "right", fontWeight: 700, color: c.status === "recouped" ? C.grey : C.red }}>
                        {c.status === "recouped" ? `-${money2(num(c.amount))}` : money2(num(c.amount))}
                      </td>
                      <td style={td()}>
                        <div style={{ ...eyebrow(), marginBottom: 4 }}>
                          {c.status === "chargeback_pending" ? "Step 1 of 3"
                            : c.status === "chargeback_confirmed" ? "Step 2 of 3"
                            : c.status === "recouped" ? "Step 3 of 3" : "Parked"}
                        </div>
                        <StatusChip status={c.status} suffix={suffix} />
                      </td>
                      <td style={{ ...td(), fontSize: 12.5, color: C.grey, maxWidth: 280 }}>
                        {c.status === "chargeback_pending" && (
                          <>
                            No deduction yet.{" "}
                            {deadline
                              ? <span style={{ color: left != null && left <= 3 ? C.red : C.amber, fontWeight: 700 }}>
                                  Dispute closes {dateFmt(deadline)}{left != null ? ` (${left}d left)` : ""}
                                </span>
                              : "Dispute window has no recorded deadline."}
                          </>
                        )}
                        {c.status === "chargeback_confirmed" && <>Will be netted out of the VA's next payout.</>}
                        {c.status === "recouped" && <>Deducted {c.paid_date ? dateFmt(c.paid_date) : "at payout"}.</>}
                        {c.status === "charged_back" && <>Disputed by the VA — held out of payout netting until resolved.</>}
                      </td>
                      <td style={td()}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {(c.status === "chargeback_pending" || c.status === "chargeback_confirmed") && (
                            <button
                              style={btn()}
                              disabled={busyId === c.id}
                              onClick={() => { setArmedChargeback(null); setArmedDispute(armed ? null : { id: c.id, reason: "" }); }}
                            >
                              <RotateCcw size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                              {armed ? "Cancel dispute" : "Record dispute"}
                            </button>
                          )}
                          {c.status === "chargeback_pending" && (
                            // Step 2 is a server cron (7am CT sweep), not a
                            // button. The control is shown so nobody goes
                            // looking for it, and says who actually does it.
                            <button
                              style={{ ...btn(), opacity: .5, cursor: "not-allowed" }}
                              disabled
                              title="Confirmed automatically once the dispute window closes — the daily 7am CT sweep does this."
                            >
                              Confirm deduction
                            </button>
                          )}
                        </div>
                        {armed && (
                          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                            <input
                              style={{ ...control, minWidth: 220 }}
                              placeholder="Reason the VA is disputing this"
                              value={armedDispute?.reason ?? ""}
                              onChange={e => setArmedDispute({ id: c.id, reason: e.target.value })}
                            />
                            <button
                              style={btn("primary")}
                              disabled={busyId === c.id}
                              onClick={() => run(
                                c.id,
                                `/recurring/commissions/${c.id}/dispute`,
                                { reason: armedDispute?.reason || "" },
                                `Dispute recorded for ${c.client_name || "this client"} — held out of payout netting until it is resolved.`,
                              )}
                            >
                              {busyId === c.id ? "Saving…" : "Save dispute"}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Still inside the chargeback window (Ares :2879-2936) ───────────── */}
      <section style={{ ...card(), overflow: "hidden" }}>
        <div style={{ padding: "18px 24px 0" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Clients still inside the chargeback window</h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.grey }}>
            {atRisk.length} commission{atRisk.length === 1 ? "" : "s"} at risk — paid or approved, and the client can
            still be lost inside the window. Nothing is owed back unless the client is actually lost.
          </p>
        </div>

        {atRisk.length === 0 ? (
          <div style={{ padding: "40px 24px", textAlign: "center" }}>
            <Shield size={28} style={{ opacity: .3 }} />
            <p style={{ margin: "10px 0 2px", fontSize: 13.5, color: C.grey }}>No active chargeback windows</p>
            <p style={{ margin: 0, fontSize: 12.5, color: C.faint }}>
              All residential commissions have cleared their 6-month chargeback window
            </p>
          </div>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th()}>Client</th>
                  <th style={th()}>VA</th>
                  <th style={th()}>First Clean</th>
                  <th style={{ ...th(), textAlign: "right" }}>Amount</th>
                  <th style={th()}>Status</th>
                  <th style={th()}>Window Expires</th>
                  <th style={th()}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {atRisk.map(c => {
                  const left = c.chargeback_until ? daysUntil(c.chargeback_until) : 0;
                  const armed = armedChargeback?.id === c.id;
                  const isBonus = !c.subscription_id;
                  return (
                    <tr key={c.id}>
                      <td style={{ ...td(), fontWeight: 700 }}>{c.client_name || "Unknown"}</td>
                      <td style={td()}>{c.va_name || `VA #${c.va_user_id}`}</td>
                      <td style={td()}>{c.first_cleaning_date ? dateFmt(c.first_cleaning_date) : "—"}</td>
                      <td style={{ ...td(), textAlign: "right", fontWeight: 700 }}>{money2(num(c.amount))}</td>
                      <td style={td()}><StatusChip status={c.status} /></td>
                      <td style={{ ...td(), color: left <= 14 ? C.red : C.amber, fontWeight: 700 }}>
                        {c.chargeback_until ? `${dateFmt(c.chargeback_until)} (${left}d left)` : "—"}
                      </td>
                      <td style={td()}>
                        {/* Ares fired this straight off one click with no
                            confirmation (:2925-2935). Deliberate deviation: it
                            opens a clawback against a VA's pay, so it now takes
                            a second click — and the loss date and reason the
                            API accepts are actually collected rather than
                            hardcoded. */}
                        {!armed ? (
                          <button
                            style={isBonus ? { ...btn(), opacity: .5, cursor: "not-allowed" } : btn("danger")}
                            disabled={isBonus || busyId === c.id}
                            title={isBonus ? "Chargebacks apply to subscription commissions — a bonus line has no subscription." : undefined}
                            onClick={() => {
                              setArmedDispute(null);
                              setArmedChargeback({ id: c.id, lossDate: todayStr(), reason: "Client lost within 6-month window" });
                            }}
                          >
                            <AlertTriangle size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Chargeback
                          </button>
                        ) : (
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                            <label style={{ ...eyebrow(), alignSelf: "center" }} htmlFor={`loss-${c.id}`}>Loss date</label>
                            <input
                              id={`loss-${c.id}`}
                              type="date"
                              style={control}
                              value={armedChargeback?.lossDate ?? todayStr()}
                              onChange={e => setArmedChargeback({ ...armedChargeback!, lossDate: e.target.value })}
                            />
                            <input
                              style={{ ...control, minWidth: 220 }}
                              placeholder="Reason"
                              value={armedChargeback?.reason ?? ""}
                              onChange={e => setArmedChargeback({ ...armedChargeback!, reason: e.target.value })}
                            />
                            <button
                              style={btn("danger")}
                              disabled={busyId === c.id}
                              onClick={() => run(
                                c.id,
                                `/recurring/commissions/${c.id}/chargeback`,
                                { loss_date: armedChargeback?.lossDate || todayStr(), reason: armedChargeback?.reason || null },
                                `Clawback opened for ${c.client_name || "this client"}. The dispute window is open — no money has been deducted yet.`,
                              )}
                            >
                              {busyId === c.id ? "Opening…" : "Confirm chargeback"}
                            </button>
                            <button style={btn()} onClick={() => setArmedChargeback(null)}>Cancel</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...td(), fontWeight: 800 }} colSpan={3}>At risk</td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>{money2(total(atRisk))}</td>
                  <td style={td()} colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <div style={{ fontSize: 12.5, color: C.grey, display: "flex", gap: 8, alignItems: "flex-start" }}>
        <Clock size={14} style={{ marginTop: 1, flexShrink: 0 }} />
        <span>
          A clawback opened here does not move money. It sits in step 1 until the dispute window closes, becomes step 2
          automatically, and is only deducted when the VA's next payout is processed on the Payout History tab.
        </span>
      </div>
    </div>
  );
}

function StepCard({ step, title, tone, toneBg, amount, count, body }: {
  step: string; title: string; tone: string; toneBg: string;
  amount: number; count: number; body: string;
}) {
  return (
    <div style={{ ...card(), padding: "16px 18px", borderTop: `3px solid ${tone}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={eyebrow()}>{step}</span>
        <span style={{
          background: toneBg, color: tone, borderRadius: 999, padding: "2px 9px",
          fontSize: 11.5, fontWeight: 800,
        }}>{count}</span>
      </div>
      <div style={{ fontWeight: 800, fontSize: 14, marginTop: 6 }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", marginTop: 3 }}>{money2(amount)}</div>
      <div style={{ fontSize: 12.5, color: C.grey, marginTop: 6 }}>{body}</div>
    </div>
  );
}
