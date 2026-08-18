import { useMemo, useState, type ReactNode } from "react";
import { Bell, Mail, PlayCircle, SendHorizonal, DollarSign, AlertTriangle, History, Plus } from "lucide-react";
import { C, money2, dateFmt, card, eyebrow, btn, th, td, Callout, LoadError } from "../_ui";
import { getTokenRole } from "@/lib/auth";
import { apiPost, useCommissionData, type RateCardResp } from "./api";

// [ares-parity 2026-08-18] Settings tab.
//
// Ares' Settings was 21 email-notification switches, an extra-recipients list,
// two manual send buttons and an email log (:3139-3448). Qleno has NONE of the
// storage behind that: no commission email-preferences table, no commission
// email log, no commission notification jobs. Per the build contract those
// controls are rendered for real and disabled, each with an honest note — they
// are not faked and they are not dropped.
//
// What Qleno DOES have and Ares did not is the commission rate card, which is
// the setting that actually decides what a commission is worth. It is built for
// real here against GET/POST /recurring/commissions/rate-card.
//
// DEVIATION (ordering): Ares put notifications first. The rate card leads here
// because it is the only live control on the screen; burying a working money
// setting under a wall of disabled switches would be worse than the fidelity
// gained. Every Ares heading and string below is still present, in Ares' order,
// underneath.

const ACT_ROLES = ["owner", "admin", "super_admin"];

// The rate-card key space (server: ARES_SEED_RATES + UNPRICED_CADENCES).
// 'custom' and 'weekdays' have no fixed interval, so nothing prices them by
// default — that is exactly why they show up in unpriced[].
const CADENCES: Array<{ value: string; label: string }> = [
  { value: "weekly",        label: "Weekly" },
  { value: "biweekly",      label: "Biweekly" },
  { value: "semi_monthly",  label: "Semi-Monthly" },
  { value: "every_3_weeks", label: "Every 3 Weeks" },
  { value: "monthly",       label: "Monthly" },
  { value: "every_5_weeks", label: "Every 5 Weeks" },
  { value: "every_6_weeks", label: "Every 6 Weeks" },
  { value: "every_8_weeks", label: "Every 8 Weeks" },
  { value: "quarterly",     label: "Quarterly" },
  { value: "custom",        label: "Custom" },
  { value: "weekdays",      label: "Weekdays" },
];

const CLIENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "residential", label: "Residential" },
  { value: "commercial",  label: "Commercial" },
];

const cadenceLabel = (v: string) =>
  CADENCES.find(c => c.value === v)?.label ?? v.replace(/_/g, " ");

const clientTypeLabel = (v: string) =>
  CLIENT_TYPES.find(c => c.value === v)?.label ?? v;

// The one gate that is never bypassed, no matter what any preference says.
const COMMS_NOTE =
  "Even once preferences are stored, every send still passes Qleno's COMMS_ENABLED gate — it is never bypassed.";

const PREFS_NOTE =
  "Disabled — this needs a commission email-preferences table and the notification jobs behind it. Qleno has neither, so nothing here is on or off yet; showing these as saved settings would be a lie about who is being emailed.";

export default function Settings() {
  const role = getTokenRole();
  const canEdit = !!role && ACT_ROLES.includes(role);
  const isAdmin = canEdit; // Ares' "Owner Alerts (Admin Only)" gate.

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <RateCard canEdit={canEdit} />
      <NotificationSettings isAdmin={isAdmin} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Commission Rate Card — live
   ───────────────────────────────────────────────────────────────────────── */

function RateCard({ canEdit }: { canEdit: boolean }) {
  const q = useCommissionData<RateCardResp>("/recurring/commissions/rate-card");
  const [showHistory, setShowHistory] = useState(false);

  const [ct, setCt] = useState("residential");
  const [cadence, setCadence] = useState("weekly");
  const [amount, setAmount] = useState("");
  const [effective, setEffective] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const rates = q.data?.rates ?? [];
  const unpriced = q.data?.unpriced ?? [];

  // "Live" = no end date. The API returns newest-effective first per key, so
  // the first live row for a key is the rate in force today.
  const live = useMemo(() => {
    const m = new Map<string, RateCardResp["rates"][number]>();
    for (const r of rates) {
      const k = `${r.client_type}:${r.cadence}`;
      if (!r.end_date && !m.has(k)) m.set(k, r);
    }
    return m;
  }, [rates]);

  const unpricedSet = useMemo(
    () => new Set(unpriced.map(u => `${u.client_type}:${u.cadence}`)),
    [unpriced],
  );

  // Show every cadence the card knows about, plus anything the data carries
  // that this list does not — a rate nobody can see is a rate nobody can fix.
  const cadenceRows = useMemo(() => {
    const known = new Set(CADENCES.map(c => c.value));
    const extra = [...new Set(rates.map(r => r.cadence))].filter(c => !known.has(c));
    return [...CADENCES.map(c => c.value), ...extra];
  }, [rates]);

  const historyRows = useMemo(
    () => rates.filter(r => !!r.end_date),
    [rates],
  );

  const submit = async () => {
    setErr(null);
    setOk(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) { setErr("Amount must be a number of 0 or more."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) { setErr("Effective date must be a real date."); return; }
    setSaving(true);
    try {
      await apiPost("/recurring/commissions/rate-card", {
        client_type: ct, cadence, amount: amt, effective_date: effective,
      });
      setOk(`${clientTypeLabel(ct)} · ${cadenceLabel(cadence)} is ${money2(amt)} from ${dateFmt(effective)}. The previous rate was end-dated, not overwritten.`);
      setAmount("");
      q.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    font: "inherit", fontSize: 13, padding: "7px 10px",
    borderRadius: "var(--radius-control)", border: `1px solid ${C.line}`,
    background: C.card, color: C.ink,
  } as const;

  return (
    <section style={{ ...card(), overflow: "hidden" }}>
      <div style={{ padding: "20px 24px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <DollarSign size={16} style={{ color: C.grey }} />
          <span style={{ fontWeight: 800, fontSize: 15 }}>Commission Rate Card</span>
        </div>
        <p style={{ fontSize: 13.5, color: C.grey, margin: "6px 0 16px" }}>
          What a base commission is worth, by client type and service frequency. Ares hard-coded these
          in application code; here they are data, dated, and auditable.
        </p>
      </div>

      {q.error && <div style={{ padding: "0 24px" }}><LoadError what="the rate card" error={q.error} /></div>}

      {q.loading ? (
        <div style={{ padding: "0 24px 24px", color: C.grey, fontSize: 13.5 }}>Loading rate card…</div>
      ) : (
        <>
          {(q.data?.seeded ?? 0) > 0 && (
            <div style={{ padding: "0 24px" }}>
              <Callout tone="info">
                Seeded {q.data!.seeded} default rates from the legacy Ares rate card — this company had none
                stored. Review them before the next payout run.
              </Callout>
            </div>
          )}

          {unpriced.length > 0 && (
            <div style={{ padding: "0 24px" }}>
              <Callout tone="warn">
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <div>
                      {unpriced.length} cadence{unpriced.length === 1 ? "" : "s"} {unpriced.length === 1 ? "has" : "have"} no
                      live rate. A client on an unpriced cadence earns a base commission of $0 — silently, on every
                      job — until a rate is added below.
                    </div>
                    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {unpriced.map(u => (
                        <button
                          key={`${u.client_type}:${u.cadence}`}
                          onClick={() => { setCt(u.client_type); setCadence(u.cadence); setErr(null); setOk(null); }}
                          style={{
                            appearance: "none", font: "inherit", fontSize: 12, fontWeight: 700,
                            background: C.card, color: C.amber, border: `1px solid ${C.line}`,
                            borderRadius: 999, padding: "3px 10px", cursor: "pointer",
                          }}
                          title="Fill the add-rate form with this gap"
                        >
                          {clientTypeLabel(u.client_type)} · {cadenceLabel(u.cadence)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </Callout>
            </div>
          )}

          {/* Current rates, by client type and cadence. */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th()}>Cadence</th>
                  {CLIENT_TYPES.map(t => (
                    <th key={t.value} style={{ ...th(), textAlign: "right" }}>{t.label}</th>
                  ))}
                  <th style={th()}>In force since</th>
                </tr>
              </thead>
              <tbody>
                {cadenceRows.map(cad => {
                  const cells = CLIENT_TYPES.map(t => live.get(`${t.value}:${cad}`));
                  const since = cells.find(Boolean)?.effective_date ?? null;
                  return (
                    <tr key={cad}>
                      <td style={{ ...td(), fontWeight: 700 }}>{cadenceLabel(cad)}</td>
                      {CLIENT_TYPES.map((t, i) => {
                        const r = cells[i];
                        const gap = unpricedSet.has(`${t.value}:${cad}`);
                        return (
                          <td key={t.value} style={{ ...td(), textAlign: "right" }}>
                            {r ? (
                              <span style={{ fontWeight: 800 }}>{money2(Number(r.amount))}</span>
                            ) : (
                              <span style={{
                                background: gap ? C.amberBg : C.tint2, color: gap ? C.amber : C.faint,
                                borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 700,
                              }}>
                                {gap ? "Not priced · pays $0" : "—"}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      <td style={{ ...td(), color: C.grey }}>{since ? dateFmt(since) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Add a dated rate. */}
          <div style={{ borderTop: `1px solid ${C.line}`, padding: "18px 24px", background: C.tint }}>
            <div style={eyebrow()}>Add a dated rate</div>
            <p style={{ fontSize: 13, color: C.grey, margin: "7px 0 14px", maxWidth: 720 }}>
              Rates are never edited in place. Saving here end-dates the current rate on the day before the
              new effective date and adds a new row, so a commission earned last month can always be
              explained by the rate that was live when it was earned. That is what makes a historical
              payout defensible to the VA it was paid to.
            </p>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label>
                <span style={eyebrow()}>Client type</span>
                <select value={ct} onChange={e => setCt(e.target.value)} disabled={!canEdit}
                        style={{ ...inputStyle, display: "block", marginTop: 6, minWidth: 150 }}>
                  {CLIENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>

              <label>
                <span style={eyebrow()}>Cadence</span>
                <select value={cadence} onChange={e => setCadence(e.target.value)} disabled={!canEdit}
                        style={{ ...inputStyle, display: "block", marginTop: 6, minWidth: 170 }}>
                  {CADENCES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </label>

              <label>
                <span style={eyebrow()}>Amount per client</span>
                <input
                  type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00"
                  value={amount} onChange={e => setAmount(e.target.value)} disabled={!canEdit}
                  style={{ ...inputStyle, display: "block", marginTop: 6, width: 130 }}
                />
              </label>

              <label>
                <span style={eyebrow()}>Effective from</span>
                <input
                  type="date" value={effective} onChange={e => setEffective(e.target.value)} disabled={!canEdit}
                  style={{ ...inputStyle, display: "block", marginTop: 6 }}
                />
              </label>

              <button
                style={canEdit && !saving ? btn("primary") : { ...btn("primary"), opacity: .5, cursor: "not-allowed" }}
                onClick={submit}
                disabled={!canEdit || saving || amount.trim() === ""}
              >
                <Plus size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                {saving ? "Saving…" : "Add rate"}
              </button>
            </div>

            {!canEdit && (
              <Note>
                Read-only for your role. Changing a rate changes what every future commission pays, so it is
                limited to owner and admin accounts — the same rule the API enforces.
              </Note>
            )}
            {err && <div style={{ marginTop: 12 }}><Callout tone="danger">{err}</Callout></div>}
            {ok && <div style={{ marginTop: 12 }}><Callout tone="ok">{ok}</Callout></div>}
          </div>

          {/* Superseded rates — the audit trail. */}
          <div style={{ borderTop: `1px solid ${C.line}`, padding: "14px 24px 18px" }}>
            <button
              onClick={() => setShowHistory(v => !v)}
              style={{
                appearance: "none", border: 0, background: "none", font: "inherit", cursor: "pointer",
                padding: 0, color: C.ink, fontWeight: 700, fontSize: 13.5,
                display: "inline-flex", alignItems: "center", gap: 7,
              }}
            >
              <History size={14} style={{ color: C.grey }} />
              Superseded rates ({historyRows.length})
            </button>

            {showHistory && (
              historyRows.length === 0 ? (
                <div style={{ marginTop: 12, fontSize: 13, color: C.grey }}>
                  No rate has been changed yet — every rate on this card is still the original.
                </div>
              ) : (
                <div style={{ overflowX: "auto", marginTop: 12 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={th()}>Client type</th>
                        <th style={th()}>Cadence</th>
                        <th style={{ ...th(), textAlign: "right" }}>Amount</th>
                        <th style={th()}>Effective</th>
                        <th style={th()}>Ended</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyRows.map(r => (
                        <tr key={r.id}>
                          <td style={td()}>{clientTypeLabel(r.client_type)}</td>
                          <td style={td()}>{cadenceLabel(r.cadence)}</td>
                          <td style={{ ...td(), textAlign: "right", fontWeight: 700 }}>{money2(Number(r.amount))}</td>
                          <td style={{ ...td(), color: C.grey }}>{dateFmt(r.effective_date)}</td>
                          <td style={{ ...td(), color: C.grey }}>{dateFmt(r.end_date)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>
        </>
      )}
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Notification settings — rendered, disabled, honest
   ───────────────────────────────────────────────────────────────────────── */

interface Toggle { key: string; label: string; description: string }

const COMMISSION_TOGGLES: Toggle[] = [
  { key: "immediateNewCommission", label: "New Commission Submitted",              description: "When a new commission is submitted for review" },
  { key: "commissionNotEligible",  label: "Commission Marked Not Eligible",        description: "When a commission is marked as not eligible" },
  { key: "payoutConfirmations",    label: "Commission Approved / Payout Processed", description: "When your commission is approved or paid out" },
  { key: "chargebackWarnings",     label: "Chargeback Warnings",                   description: "When a commission is at risk of chargeback" },
];

const CLIENT_TOGGLES: Toggle[] = [
  { key: "clientPaused",  label: "Client Paused Service",  description: "When one of your clients pauses their cleaning service" },
  { key: "clientResumed", label: "Client Resumed Service", description: "When a paused client resumes their cleaning service" },
];

const DIGEST_TOGGLES: Toggle[] = [
  { key: "weeklySummary",    label: "Weekly Summary",    description: "Weekly digest of commission activity" },
  { key: "monthlyStatement", label: "Monthly Statement", description: "Monthly commission statement notification" },
];

// The 13 owner alerts, admin-only in Ares (:3234-3266).
const OWNER_TOGGLES: Toggle[] = [
  { key: "overduePayoutAlert",      label: "Overdue Payout Alert",          description: "When approved commissions have not been paid for over 14 days" },
  { key: "payoutDueReminder",       label: "Payout Due Reminder",           description: "3-day reminder before payout deadlines" },
  { key: "weeklyCommissionSummary", label: "Weekly Commission Summary",     description: "Weekly owner overview of new and pending commissions" },
  { key: "dataIssuesAlert",         label: "Data Issues Alert",             description: "Alerts for data quality or integrity issues" },
  { key: "chargebackExpiring",      label: "Chargeback Window Expiring",    description: "When commissions are about to exit the chargeback window" },
  { key: "newClientAlert",          label: "New Client Alert",              description: "When a new client subscription is created" },
  { key: "clientLostAlert",         label: "Client Lost Alert",             description: "When a client is marked as lost with reason and MRR impact" },
  { key: "clientPausedAlert",       label: "Client Paused Alert (Owner)",   description: "When a client pauses service — owner-facing with MRR impact" },
  { key: "clientResumedAlert",      label: "Client Resumed Alert (Owner)",  description: "When a paused client resumes service" },
  { key: "pauseWarningAlert",       label: "Pause Duration Warnings",       description: "Alerts at 60, 75, 85, and 90 days of continuous pause" },
  { key: "cadenceChangeAlert",      label: "Cadence Change Alert",          description: "When a client's service frequency is changed (upgrade or downgrade)" },
  { key: "priceChangeAlert",        label: "Price Change Alert",            description: "When a client's per-visit rate is updated" },
  { key: "dailyDigestEnabled",      label: "Daily Digest (6pm)",            description: "Daily 6pm summary of all client and revenue events from the day" },
];

function NotificationSettings({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-.02em", margin: 0 }}>
          Notification Settings
        </h2>
        <p style={{ fontSize: 13.5, color: C.grey, margin: "5px 0 0" }}>
          Control which email notifications you receive for commission and client events
        </p>
      </div>

      <Callout tone="warn">
        None of the controls in this block are connected. {PREFS_NOTE} {COMMS_NOTE}
      </Callout>

      {/* Email Notification Preferences */}
      <section style={{ ...card(), padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Bell size={16} style={{ color: C.grey }} />
          <span style={{ fontWeight: 800, fontSize: 15 }}>Email Notification Preferences</span>
        </div>
        <p style={{ fontSize: 13.5, color: C.grey, margin: "6px 0 4px" }}>
          Toggle the types of email notifications you want to receive
        </p>

        <ToggleGroup title="Commission Notifications" items={COMMISSION_TOGGLES} />
        <ToggleGroup title="Client Notifications" items={CLIENT_TOGGLES} />
        <ToggleGroup title="Summaries & Digests" items={DIGEST_TOGGLES} />
        {isAdmin && <ToggleGroup title="Owner Alerts (Admin Only)" items={OWNER_TOGGLES} />}

        <Note>{PREFS_NOTE}</Note>
      </section>

      {/* Additional Email Recipients — admin only */}
      {isAdmin && (
        <section style={{ ...card(), padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <Mail size={16} style={{ color: C.grey }} />
            <span style={{ fontWeight: 800, fontSize: 15 }}>Additional Email Recipients</span>
          </div>
          <p style={{ fontSize: 13.5, color: C.grey, margin: "6px 0 14px" }}>
            Owner notification emails are sent to all admin accounts by default. Add extra addresses here
            to CC additional recipients on all owner alerts.
          </p>

          <p style={{ fontSize: 13.5, color: C.faint, margin: "0 0 12px" }}>
            No additional recipients configured.
          </p>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="email" placeholder="email@example.com" disabled
              style={{
                font: "inherit", fontSize: 13, padding: "7px 10px", minWidth: 240,
                borderRadius: "var(--radius-control)", border: `1px solid ${C.line}`,
                background: C.tint2, color: C.faint, cursor: "not-allowed",
              }}
            />
            <button disabled style={{ ...btn(), opacity: .5, cursor: "not-allowed" }}>Add</button>
          </div>

          <Note>{PREFS_NOTE}</Note>
        </section>
      )}

      {/* Manual Notification Triggers — admin only */}
      {isAdmin && (
        <section style={{ ...card(), padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <PlayCircle size={16} style={{ color: C.grey }} />
            <span style={{ fontWeight: 800, fontSize: 15 }}>Manual Notification Triggers</span>
          </div>
          <p style={{ fontSize: 13.5, color: C.grey, margin: "6px 0 14px" }}>
            Manually send notifications outside of the automated schedule
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button disabled style={{ ...btn(), opacity: .5, cursor: "not-allowed" }}>
              <Mail size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              Send Monthly Statements to All VAs
            </button>
            <button disabled style={{ ...btn(), opacity: .5, cursor: "not-allowed" }}>
              <SendHorizonal size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              Run Owner Alert Checks
            </button>
          </div>

          <p style={{ fontSize: 12.5, color: C.grey, margin: "12px 0 0" }}>
            These will only send emails to users who have the relevant notification type enabled in their
            preferences.
          </p>

          <Note>
            Disabled — there are no commission notification jobs in Qleno to trigger. {COMMS_NOTE}
          </Note>
        </section>
      )}

      {/* Email Log History */}
      <section style={{ ...card(), padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Mail size={16} style={{ color: C.grey }} />
          <span style={{ fontWeight: 800, fontSize: 15 }}>Email Log History</span>
        </div>
        <p style={{ fontSize: 13.5, color: C.grey, margin: "6px 0 14px" }}>
          Recent emails sent by the notification system
        </p>

        <p style={{ fontSize: 13.5, color: C.faint, margin: 0 }}>No emails have been sent yet.</p>

        <Note>
          Empty because there is no commission email log in Qleno — not because nothing was sent. An
          invented &quot;delivered&quot; row here would be worse than no row at all.
        </Note>
      </section>
    </div>
  );
}

function ToggleGroup({ title, items }: { title: string; items: Toggle[] }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={eyebrow()}>{title}</div>
      <div style={{ marginTop: 8 }}>
        {items.map(t => (
          <div
            key={t.key}
            style={{
              display: "flex", alignItems: "center", gap: 14, padding: "11px 0",
              borderBottom: `1px solid ${C.lineSoft}`, opacity: .62,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t.label}</div>
              <div style={{ fontSize: 12.5, color: C.grey, marginTop: 2 }}>{t.description}</div>
            </div>
            <DeadSwitch label={t.label} />
          </div>
        ))}
      </div>
    </div>
  );
}

// A switch rendered in a neutral, unset position — deliberately NOT the "on"
// that Ares defaulted to. There is nothing stored behind it, and a switch that
// looks on is a promise that an email will arrive.
function DeadSwitch({ label }: { label: string }) {
  return (
    <span
      role="switch"
      aria-checked={false}
      aria-disabled
      aria-label={label}
      title="Not connected — needs an email-preferences table"
      style={{
        width: 38, height: 21, borderRadius: 999, background: C.tint2,
        border: `1px solid ${C.line}`, flexShrink: 0, position: "relative",
        display: "inline-block", cursor: "not-allowed",
      }}
    >
      <span style={{
        position: "absolute", top: 2, left: 2, width: 15, height: 15, borderRadius: 999,
        background: C.card, border: `1px solid ${C.line}`,
      }} />
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div style={{
      marginTop: 14, fontSize: 12.5, lineHeight: 1.5, color: C.grey,
      borderLeft: `2px solid ${C.line}`, paddingLeft: 10,
    }}>
      {children}
    </div>
  );
}
