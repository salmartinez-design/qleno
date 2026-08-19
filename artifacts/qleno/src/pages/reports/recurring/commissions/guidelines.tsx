import { useMemo, useState, type ReactNode } from "react";
import { Printer, Search } from "lucide-react";
import { C, FF, soft, money, card, eyebrow, btn, th, td, Callout, LoadError } from "../_ui";
import { useCommissionData, type RateCardResp } from "./api";

// [ares-parity 2026-08-18] TAB 7 — Guidelines.
//
// The commission rulebook exactly as Ares published it to VAs, with two
// corrections that Ares' static copy could not carry:
//
//  1. Rates are no longer a hardcoded sentence. They live in the rate card an
//     admin edits (POST /recurring/commissions/rate-card), so this tab reads
//     them live and only falls back to the documented figures if that call
//     fails. The every-6-week and every-8-week rows are NEW as of 2026-08-18:
//     Ares never priced them, so those clients were silently paid the WEEKLY
//     rate. A guideline page that still shows the old sentence is how that
//     overpayment survived, which is why the live read matters here.
//  2. The chargeback section describes the real 3-step lifecycle
//     (pending -> confirmed -> recouped) rather than "chargeback is triggered",
//     including the 14-day dispute window with no deduction and the carry-over
//     of any excess to the next payout.
//
// Everything else is verbatim Ares copy, in Ares' order. Ares was
// dark-mode-first; the only intended difference is colour tokens.

const UPDATED = "Aug 18, 2026";

// ── Rate card ────────────────────────────────────────────────────────────────
// Canonical cadence keys. The rate card stores cadence as a free-ish string, so
// aliases are folded before lookup — a rate that exists but is spelled
// "bi_weekly" must not render as "unpriced" and scare an admin into re-seeding.
type CadenceKey =
  | "weekly" | "biweekly" | "semi_monthly" | "every_3_weeks" | "monthly"
  | "every_5_weeks" | "every_6_weeks" | "every_8_weeks" | "quarterly";

const CADENCE_LABEL: Record<CadenceKey, string> = {
  weekly: "Weekly",
  biweekly: "Bi-Weekly",
  semi_monthly: "Semi-Monthly",
  every_3_weeks: "Every 3 Weeks",
  monthly: "Monthly",
  every_5_weeks: "Every 5 Weeks",
  every_6_weeks: "Every 6 Weeks",
  every_8_weeks: "Every 8 Weeks",
  quarterly: "Quarterly",
};

const CADENCE_ORDER: CadenceKey[] = [
  "weekly", "biweekly", "semi_monthly", "every_3_weeks", "monthly",
  "every_5_weeks", "every_6_weeks", "every_8_weeks", "quarterly",
];

// Documented rates — the fallback, and the figures the amendment announced.
const DOC_RATES: Record<"residential" | "commercial", Record<CadenceKey, number>> = {
  residential: {
    weekly: 75, biweekly: 50, semi_monthly: 50, every_3_weeks: 30, monthly: 25,
    every_5_weeks: 20, every_6_weeks: 20, every_8_weeks: 15, quarterly: 15,
  },
  commercial: {
    weekly: 100, biweekly: 100, semi_monthly: 100, every_3_weeks: 50, monthly: 50,
    every_5_weeks: 50, every_6_weeks: 50, every_8_weeks: 50, quarterly: 50,
  },
};

// Cadences priced for the first time in the 2026-08-18 amendment.
const NEWLY_PRICED: CadenceKey[] = ["every_6_weeks", "every_8_weeks"];

const CADENCE_ALIASES: Record<string, CadenceKey> = {
  weekly: "weekly", every_week: "weekly", every_1_weeks: "weekly",
  biweekly: "biweekly", bi_weekly: "biweekly", every_2_weeks: "biweekly", fortnightly: "biweekly",
  semi_monthly: "semi_monthly", semimonthly: "semi_monthly", twice_monthly: "semi_monthly",
  every_3_weeks: "every_3_weeks", triweekly: "every_3_weeks", tri_weekly: "every_3_weeks",
  monthly: "monthly", every_4_weeks: "monthly", every_month: "monthly",
  every_5_weeks: "every_5_weeks",
  every_6_weeks: "every_6_weeks", bimonthly: "every_6_weeks",
  every_8_weeks: "every_8_weeks",
  quarterly: "quarterly", every_12_weeks: "quarterly", every_3_months: "quarterly",
};

function normCadence(raw: string | null | undefined): CadenceKey | null {
  const k = (raw || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return CADENCE_ALIASES[k] ?? (CADENCE_ORDER.includes(k as CadenceKey) ? (k as CadenceKey) : null);
}

type ResolvedRate = { amount: number; live: boolean };

// Latest still-open row per client_type + cadence wins; a row with an end_date
// has been superseded and must not be quoted to a VA as current.
function resolveRates(resp: RateCardResp | null) {
  const out: Record<string, ResolvedRate> = {};
  const eff: Record<string, string> = {};
  for (const r of resp?.rates ?? []) {
    if (r.end_date) continue;
    const cad = normCadence(r.cadence);
    const type = (r.client_type || "").toLowerCase();
    if (!cad || (type !== "residential" && type !== "commercial")) continue;
    const key = `${type}:${cad}`;
    if (eff[key] && eff[key] > r.effective_date) continue;
    eff[key] = r.effective_date;
    out[key] = { amount: Number(r.amount), live: true };
  }
  return (type: "residential" | "commercial", cad: CadenceKey): ResolvedRate =>
    out[`${type}:${cad}`] ?? { amount: DOC_RATES[type][cad], live: false };
}

// ── Document model ───────────────────────────────────────────────────────────
// Ares kept GUIDELINES_CONTENT as title + one \n-joined string. Same order,
// same words; split into lines so the document can carry real hierarchy and so
// numbered criteria render as a list rather than a wall.
type Extra = "rates-residential" | "rates-commercial" | "chargeback-lifecycle";

interface Section {
  title: string;
  lines: string[];
  extra?: Extra;
  /** 2026-08-18 amendment shown inline so the reader knows the rule is current. */
  note?: string;
}

const SECTIONS: Section[] = [
  {
    title: "Residential Tiers",
    lines: [
      "All residential commissions are subject to a 6-month chargeback window from the first clean date.",
    ],
    extra: "rates-residential",
    note:
      `Updated ${UPDATED}. Ares printed these rates as fixed copy; they now come from the rate card, ` +
      "which an admin can edit, so the table above is the live rate card rather than a sentence in a " +
      "document. Every 6 Weeks ($20) and Every 8 Weeks ($15) are newly priced — Ares never had a rate " +
      "for them and paid those clients the weekly rate by accident.",
  },
  {
    title: "Commercial Tiers",
    lines: [
      "No chargebacks on commercial accounts — protected by 1-year agreement.",
      "Self-sourced commercial lead: +$100 sourcing bonus automatically applied.",
    ],
    extra: "rates-commercial",
    note:
      `Updated ${UPDATED}. Weekly, Bi-Weekly and Semi-Monthly pay $100; every cadence less frequent than ` +
      "that pays $50 — including Every 6 Weeks and Every 8 Weeks, which are priced here for the first " +
      "time. These come from the editable rate card, not from this page.",
  },
  {
    title: "Chargeback Policy",
    lines: [
      "Residential: 6-month chargeback window starting from the first clean date.",
      "Commercial: No chargebacks unless the contract was obtained through misrepresentation.",
      "Partial client refunds do not affect commission unless caused by VA misconduct.",
    ],
    extra: "chargeback-lifecycle",
    note:
      `Updated ${UPDATED}. A chargeback is a three-step lifecycle, not an instant deduction. Nothing is ` +
      "taken out of your pay during the 14-day dispute window, and any amount larger than the payout it " +
      "lands on now carries forward to the next payout instead of being written off.",
  },
  {
    title: "Cancellations & Reschedules",
    lines: [
      "Cancel before first clean: No commission issued.",
      "Reschedule within 7 days: Commission delayed until first clean is completed.",
      "Cancel or refund after first clean: 6-month chargeback window applies.",
    ],
  },
  {
    title: "Frequency Changes",
    lines: [
      "Step-down (e.g., Weekly → Monthly): Commission adjusted to lower tier rate. Difference deducted.",
      "Step-up (e.g., Monthly → Weekly): VA receives a one-time adjustment to the higher tier rate.",
    ],
    note:
      `Updated ${UPDATED}. Both tier rates are read from the rate card at the time of the change, so a ` +
      "step-down to Every 6 Weeks or Every 8 Weeks now adjusts to that cadence's own rate rather than " +
      "leaving the weekly rate in place.",
  },
  {
    title: "Pause / Suspend Rules",
    lines: [
      "Paused after first clean: Commission held 'On Hold' until client resumes service.",
      "Resumed: Commission reactivates automatically; original chargeback window continues.",
      "Auto-churned at 90 days paused: Commission marked ineligible. If within the 6-month window, chargeback is triggered.",
      "Paused before first clean: Commission blocked until first clean is confirmed.",
    ],
    note:
      `Updated ${UPDATED}. "Chargeback is triggered" means the commission moves to Chargeback Pending and ` +
      "your 14-day dispute window opens — see Chargeback Policy. No money is deducted at that point.",
  },
  {
    title: "Payout Schedule",
    lines: [
      "Payout date: Last Friday of the month following the first clean.",
      "Example: January 28 first clean → February payout (last Friday of February).",
      "Accepted payment methods: PayPal, Zelle, or Payoneer.",
    ],
  },
  {
    title: "Qualified Client Definition",
    lines: [
      "A client must meet ALL 4 criteria to qualify for commission:",
      "1. Inactive 90+ consecutive days (or never previously booked)",
      "2. Signed a valid service agreement uploaded to their profile",
      "3. Completed and paid for their first cleaning in full",
      "4. Logged in the CRM with the VA's name as the representative of record",
    ],
  },
  {
    title: "Returning Client Policy",
    lines: [
      "Inactive 90+ days: Eligible for standard commission at the applicable tier rate.",
      "Active within 90 days: No commission issued — returning client does not qualify.",
    ],
  },
  {
    title: "Performance Bonus",
    lines: [
      "Earn a $100 performance bonus when you close 5 or more new weekly or bi-weekly clients in a single calendar month.",
      "Qualifying cadences: Weekly, Bi-Weekly only.",
      "Non-qualifying cadences: Every 3 Weeks, Monthly, Every 5 Weeks, Quarterly.",
      "Bonus counter resets at the start of each new calendar month.",
    ],
    note:
      `Updated ${UPDATED}. Every 6 Weeks and Every 8 Weeks are also non-qualifying — they simply did not ` +
      "exist when this list was written. Semi-Monthly does not qualify either; only Weekly and Bi-Weekly do.",
  },
  {
    title: "Specialty Service Bonus",
    lines: [
      "Earn 5% of total service revenue for proactively scheduled specialty services.",
      "Qualifying services: Deep Clean, Move-In/Out, Post-Renovation, Seasonal, Commercial Add-On, Other.",
      "Requirement: Service must be completed and payment received before bonus is released for approval.",
    ],
  },
  {
    title: "Dispute Resolution",
    lines: [
      "All disputes must be submitted in writing within 14 days of receiving notification.",
      "Management's decision is final after review.",
      "Disputes submitted after the 14-day window will not be considered.",
    ],
    note:
      `Updated ${UPDATED}. The same 14 days are the chargeback dispute window: a chargeback stays Pending ` +
      "and undeducted for those 14 days, then becomes Confirmed.",
  },
];

const CHARGEBACK_LIFECYCLE = [
  {
    step: "1",
    label: "Chargeback Pending",
    body:
      "On loss, the commission moves to Chargeback Pending and your 14-day dispute window opens. " +
      "NO amount is deducted at this stage — your balance is unchanged while the dispute window is open.",
  },
  {
    step: "2",
    label: "Chargeback Confirmed",
    body:
      "If no dispute is upheld within 14 days, the commission becomes Chargeback Confirmed. The amount is " +
      "now owed back, but it still has not been taken out of anything — nothing is deducted until a payout runs.",
  },
  {
    step: "3",
    label: "Recouped at payout",
    body:
      "The confirmed amount is deducted from the next payout and marked Recouped. If it is larger than that " +
      "payout, only what the payout covers is recouped and the remainder carries forward to the following " +
      "payout until it is cleared. A payout is never reduced below zero.",
  },
];

const slug = (t: string) => t.toLowerCase().replace(/\s+/g, "-");

export default function Guidelines() {
  const [searchQuery, setSearchQuery] = useState("");
  const rateQ = useCommissionData<RateCardResp>("/recurring/commissions/rate-card");
  const rateOf = useMemo(() => resolveRates(rateQ.data), [rateQ.data]);
  const ratesAreLive = !!rateQ.data && !rateQ.error;

  // Ares matched on title + content. Rates now live outside the copy, so the
  // rate rows and the lifecycle steps are folded into the same haystack —
  // searching "every 6 weeks" must find the section that prices it.
  const haystack = (s: Section) =>
    [s.title, ...s.lines, s.note ?? "", extraText(s.extra, rateOf)].join("\n").toLowerCase();

  const q = searchQuery.trim().toLowerCase();
  const filtered = SECTIONS.filter(s => q === "" || haystack(s).includes(q));

  // Ares' handlePrint: opens a blank window and writes a full document, and it
  // always prints the whole rulebook, ignoring the search filter. Kept as-is.
  const handlePrint = () => {
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(printDocument(rateOf, ratesAreLive));
    w.document.close();
    w.print();
  };

  return (
    <div style={{ fontFamily: FF, maxWidth: 900 }}>
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "flex-start",
        justifyContent: "space-between", gap: 14, marginBottom: 18,
      }}>
        <div>
          <div style={eyebrow()}>Commission Program</div>
          <h1 style={{
            fontSize: 26, fontWeight: 800, letterSpacing: "-.02em",
            color: C.ink, margin: "6px 0 0",
          }}>
            Commission Program Guidelines
          </h1>
          <p style={{ fontSize: 12.5, color: C.grey, margin: "6px 0 0" }}>
            © 2025 Phes Cleaning LLC · Last Updated: March 2025 · Read-only
          </p>
          <p style={{ fontSize: 12.5, color: C.grey, margin: "3px 0 0" }}>
            Amended {UPDATED} — rate card and chargeback lifecycle. Amended rules are marked below.
          </p>
        </div>
        <button style={btn()} onClick={handlePrint} data-testid="button-print-guidelines">
          <Printer size={14} style={{ verticalAlign: "-2px", marginRight: 7 }} />
          Download / Print PDF
        </button>
      </div>

      {/* ── Search ────────────────────────────────────────────────────────── */}
      <div style={{ position: "relative", marginBottom: 18 }}>
        <Search size={15} color={C.faint} style={{
          position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
        }} />
        <input
          type="text"
          placeholder="Search guidelines..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          data-testid="input-guidelines-search"
          style={{
            width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13.5,
            padding: "9px 14px 9px 34px", borderRadius: "var(--radius-control)",
            border: `1px solid ${C.line}`, background: C.card, color: C.ink,
          }}
        />
      </div>

      {rateQ.error && <LoadError what="the commission rate card" error={rateQ.error} />}
      {!rateQ.error && !rateQ.loading && (rateQ.data?.unpriced?.length ?? 0) > 0 && (
        <Callout tone="warn">
          {rateQ.data!.unpriced.length} cadence
          {rateQ.data!.unpriced.length === 1 ? " has" : "s have"} no rate on the rate card
          {" — "}
          {rateQ.data!.unpriced
            .map(u => { const k = normCadence(u.cadence); return `${u.client_type} ${k ? CADENCE_LABEL[k] : u.cadence}`; })
            .join(", ")}
          . Commissions on an unpriced cadence are what caused the every-6-week overpayment; price them
          on the rate card before approving.
        </Callout>
      )}

      {/* ── Contents ──────────────────────────────────────────────────────── */}
      {q === "" && (
        <nav style={{ ...card(), padding: "16px 20px", marginBottom: 18 }}>
          <div style={eyebrow()}>Contents</div>
          <ol style={{
            listStyle: "none", margin: "10px 0 0", padding: 0,
            display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
            gap: "6px 18px",
          }}>
            {SECTIONS.map((s, i) => (
              <li key={s.title}>
                <button
                  onClick={() => document.getElementById(`guideline-${slug(s.title)}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  style={{
                    appearance: "none", border: 0, background: "none", font: "inherit",
                    padding: 0, cursor: "pointer", color: C.ink, fontSize: 13,
                    fontWeight: 600, textAlign: "left",
                  }}
                >
                  <span style={{ color: C.faint, fontWeight: 800, marginRight: 7 }}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {s.title}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <p style={{ fontSize: 13.5, color: C.grey, textAlign: "center", padding: "32px 0" }}>
          No sections match your search.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {filtered.map(s => (
            <SectionCard
              key={s.title}
              section={s}
              index={SECTIONS.indexOf(s) + 1}
              rateOf={rateOf}
              ratesAreLive={ratesAreLive}
              ratesLoading={rateQ.loading}
            />
          ))}
        </div>
      )}

      <p style={{ fontSize: 12, color: C.faint, margin: "22px 0 0" }}>
        Questions about a rule, or think a commission was scored wrong? Raise it in writing within 14 days
        of the notification — see Dispute Resolution.
      </p>
    </div>
  );
}

function SectionCard({ section, index, rateOf, ratesAreLive, ratesLoading }: {
  section: Section;
  index: number;
  rateOf: (t: "residential" | "commercial", c: CadenceKey) => ResolvedRate;
  ratesAreLive: boolean;
  ratesLoading: boolean;
}) {
  return (
    <section
      id={`guideline-${slug(section.title)}`}
      data-testid={`card-guideline-${slug(section.title)}`}
      style={{ ...card(), padding: "20px 24px 22px", scrollMarginTop: 16 }}
    >
      <div style={{ ...eyebrow(), marginBottom: 4 }}>Section {String(index).padStart(2, "0")}</div>
      <h2 style={{
        fontSize: 17, fontWeight: 800, color: C.ink, margin: "0 0 12px",
        letterSpacing: "-.01em", paddingBottom: 10, borderBottom: `1px solid ${C.lineSoft}`,
      }}>
        {section.title}
      </h2>

      {section.extra === "rates-residential" && (
        <RateTable type="residential" rateOf={rateOf} live={ratesAreLive} loading={ratesLoading} />
      )}
      {section.extra === "rates-commercial" && (
        <RateTable type="commercial" rateOf={rateOf} live={ratesAreLive} loading={ratesLoading} />
      )}

      <Body lines={section.lines} />

      {section.extra === "chargeback-lifecycle" && <Lifecycle />}

      {section.note && (
        <div style={{
          marginTop: 14, background: C.infoBg, border: `1px solid ${soft("var(--info)", 28)}`,
          borderRadius: 12, padding: "12px 16px",
        }}>
          <div style={{ ...eyebrow(), color: C.info, marginBottom: 4 }}>Amended {UPDATED}</div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: C.ink }}>{section.note}</p>
        </div>
      )}
    </section>
  );
}

// Ares rendered the body as one whitespace-pre-line paragraph. The numbered
// criteria in "Qualified Client Definition" are a real list, so they render as
// one — same words, same order.
function Body({ lines }: { lines: string[] }) {
  const isNumbered = (l: string) => /^\d+\.\s/.test(l);
  const out: ReactNode[] = [];
  let buffer: string[] = [];

  const flush = (key: string) => {
    if (!buffer.length) return;
    out.push(
      <ol key={key} style={{ margin: "8px 0 0", padding: "0 0 0 4px", listStyle: "none" }}>
        {buffer.map(l => {
          const [, n, rest] = l.match(/^(\d+)\.\s+(.*)$/) ?? ["", "", l];
          return (
            <li key={l} style={{
              display: "flex", gap: 10, alignItems: "baseline",
              fontSize: 13.5, lineHeight: 1.65, color: C.grey, padding: "3px 0",
            }}>
              <span style={{
                flex: "0 0 auto", minWidth: 20, height: 20, borderRadius: 999,
                background: C.tint2, color: C.ink, fontSize: 11, fontWeight: 800,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}>{n}</span>
              <span>{rest}</span>
            </li>
          );
        })}
      </ol>,
    );
    buffer = [];
  };

  lines.forEach((l, i) => {
    if (isNumbered(l)) { buffer.push(l); return; }
    flush(`ol-${i}`);
    // "Label: rule" is the dominant shape of this rulebook — leading the label
    // makes twelve sections scannable instead of twelve grey blocks.
    const m = l.match(/^([^:]{1,42}):\s+(.*)$/);
    out.push(
      <p key={`p-${i}`} style={{ margin: "8px 0 0", fontSize: 13.5, lineHeight: 1.65, color: C.grey }}>
        {m ? <><strong style={{ color: C.ink, fontWeight: 700 }}>{m[1]}:</strong> {m[2]}</> : l}
      </p>,
    );
  });
  flush("ol-end");
  return <>{out}</>;
}

function RateTable({ type, rateOf, live, loading }: {
  type: "residential" | "commercial";
  rateOf: (t: "residential" | "commercial", c: CadenceKey) => ResolvedRate;
  live: boolean;
  loading: boolean;
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th()}>Cadence</th>
              <th style={{ ...th(), textAlign: "right" }}>Commission</th>
              <th style={th()}>Note</th>
            </tr>
          </thead>
          <tbody>
            {CADENCE_ORDER.map(cad => {
              const r = rateOf(type, cad);
              const isNew = NEWLY_PRICED.includes(cad);
              return (
                <tr key={cad}>
                  <td style={td()}>{CADENCE_LABEL[cad]}</td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800, color: C.ink }}>
                    {money(r.amount)}
                  </td>
                  <td style={{ ...td(), fontSize: 12, color: C.grey }}>
                    {isNew ? (
                      <span style={{
                        background: C.mintBg, color: C.mintDeep, borderRadius: 999,
                        padding: "2px 9px", fontSize: 11, fontWeight: 800,
                      }}>New {UPDATED}</span>
                    ) : !r.live && live ? "Not on the rate card — documented rate" : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 12, color: C.faint, margin: "8px 0 0" }}>
        {loading
          ? "Loading the current rate card…"
          : live
            ? "Live from the commission rate card. An admin can change any of these; this page follows."
            : "Rate card unavailable — showing the rates documented in the Aug 18, 2026 amendment."}
      </p>
    </div>
  );
}

function Lifecycle() {
  return (
    <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
      <div style={eyebrow()}>Chargeback lifecycle — 3 steps</div>
      {CHARGEBACK_LIFECYCLE.map(s => (
        <div key={s.step} style={{
          display: "flex", gap: 12, alignItems: "flex-start",
          border: `1px solid ${C.lineSoft}`, borderRadius: 12, padding: "12px 14px", background: C.tint,
        }}>
          <span style={{
            flex: "0 0 auto", width: 24, height: 24, borderRadius: 999, background: C.card,
            border: `1px solid ${C.line}`, color: C.ink, fontSize: 12, fontWeight: 800,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}>{s.step}</span>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: C.ink }}>{s.label}</div>
            <p style={{ margin: "3px 0 0", fontSize: 13, lineHeight: 1.6, color: C.grey }}>{s.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Print ────────────────────────────────────────────────────────────────────
// Plain text of the parts that are no longer literal copy, so the printed
// rulebook and the screen never disagree.
function extraText(
  extra: Extra | undefined,
  rateOf: (t: "residential" | "commercial", c: CadenceKey) => ResolvedRate,
): string {
  if (extra === "rates-residential" || extra === "rates-commercial") {
    const type = extra === "rates-residential" ? "residential" : "commercial";
    return CADENCE_ORDER
      .map(c => `${CADENCE_LABEL[c]}: ${money(rateOf(type, c).amount)}${NEWLY_PRICED.includes(c) ? ` (new ${UPDATED})` : ""}`)
      .join(" · ");
  }
  if (extra === "chargeback-lifecycle") {
    return CHARGEBACK_LIFECYCLE.map(s => `${s.step}. ${s.label} — ${s.body}`).join("\n");
  }
  return "";
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The print window is a detached document, so it cannot see index.css — the
// tokens are read off the live page and injected as values. Deviation from
// Ares: Ares hardcoded three literal grey hexes here, which this module bans; the
// fallbacks are neutral CSS keywords, never hexes.
function printToken(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function printDocument(
  rateOf: (t: "residential" | "commercial", c: CadenceKey) => ResolvedRate,
  ratesAreLive: boolean,
): string {
  const ink = printToken("--ink", "black");
  const muted = printToken("--ink-muted", "gray");
  const line = printToken("--border", "silver");

  const body = SECTIONS.map(s => {
    const parts = [extraText(s.extra, rateOf), ...s.lines, s.note ? `[Amended ${UPDATED}] ${s.note}` : ""]
      .filter(Boolean)
      .join("\n");
    return `<h2>${esc(s.title)}</h2><p>${esc(parts)}</p>`;
  }).join("");

  return `<html><head><title>PHES Commission Guidelines</title><style>` +
    `body{font-family:sans-serif;max-width:700px;margin:40px auto;line-height:1.6;color:${ink};}` +
    `h1{font-size:1.4rem;}` +
    `h2{font-size:1.05rem;margin-top:2rem;border-bottom:1px solid ${line};padding-bottom:4px;}` +
    `p{white-space:pre-wrap;color:${muted};}` +
    `</style></head><body>` +
    `<h1>PHES Commission Program Guidelines</h1>` +
    `<p style="color:${muted};font-size:0.85rem">© 2025 Phes Cleaning LLC · Last Updated: March 2025 · ` +
    `Amended ${UPDATED} (rate card, chargeback lifecycle)` +
    `${ratesAreLive ? "" : " · rate card unavailable at print time; documented rates shown"}</p>` +
    body +
    `</body></html>`;
}
