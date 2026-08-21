import { db } from "@workspace/db";
import {
  commissionsTable,
  commissionPolicyTable,
  commissionPaymentsTable,
  commissionRateCardTable,
  commissionLedgerTable,
  commissionStatusEventsTable,
  commissionChargebacksTable,
  subscriptionCadenceHistoryTable,
  recurringSubscriptionsTable,
  clientsTable,
} from "@workspace/db/schema";
import { and, eq, isNull, or, sql, desc } from "drizzle-orm";
import { tzOf } from "./company-tz.js";

// [ares-parity 2026-08-18] The VA SALES commission engine — a faithful port of
// the legacy Ares `commissionService.ts`, rebuilt on Qleno's own data.
//
// NOT the technician-pay engine. See CLAUDE.md "Commission engine routing" —
// that one is lib/commission.ts + commission-compute.ts and branches on
// jobs.account_id. Nothing here touches payroll.
//
// Model: FLAT DOLLARS from a (client_type, cadence) rate card. Not a percentage
// of MRR. A commission's amount is always
//     base_amount + source_bonus_amount + specialty_bonus_amount
// and every dollar that moves also writes a signed commission_ledger row, so a
// VA statement is a ledger sum and never a recomputation.
//
// Every function takes an explicit companyId and branchId. Nothing here reads
// req — callers resolve tenancy and pass it in.

// ─────────────────────────────────────────────────────────────────────────────
// Rate card
// ─────────────────────────────────────────────────────────────────────────────

// The rates Ares actually pays, as of the 2026-08-18 export
// (server/commissionService.ts:6-24). Used to seed commission_rate_card for a
// company that has none; after seeding, the DB is the source of truth.
//
// [rates 2026-08-18, Sal] every_6_weeks and every_8_weeks are NEW here — Ares
// never priced them, and its normalizer accidentally matched both to "weekly"
// (every string contains "week"), paying $75 residential / $100 commercial for
// a client cleaned 6-8 times a YEAR. That was an overpay bug, not a rate.
// Their correct rates were derived from the schedule Ares does define:
//   • Commercial is a clean two-tier rule — 2+ visits/month = $100, anything
//     less frequent = $50. Both new cadences are less frequent, so both = $50.
//   • Residential steps 75 / 50 / 30 / 25 / 20 / 15 in $5 increments. The two
//     new cadences sit between every_5_weeks ($20 @ 0.87 visits/mo) and
//     quarterly ($15 @ 0.33), one step apart: 6 weeks = $20, 8 weeks = $15.
// These two carry the CUTOVER effective_date, not 2020-01-01: they are new
// rates from today forward and must never re-rate historical commissions.
// Past overpays are left alone by decision — paid is paid.
export const RATE_CUTOVER_DATE = "2026-08-18";

export const ARES_SEED_RATES: Array<{ client_type: "residential" | "commercial"; cadence: string; amount: string; effective_date?: string }> = [
  { client_type: "residential", cadence: "weekly",         amount: "75" },
  { client_type: "residential", cadence: "biweekly",       amount: "50" },
  { client_type: "residential", cadence: "semi_monthly",   amount: "50" },
  { client_type: "residential", cadence: "every_3_weeks",  amount: "30" },
  { client_type: "residential", cadence: "monthly",        amount: "25" },
  { client_type: "residential", cadence: "every_5_weeks",  amount: "20" },
  { client_type: "residential", cadence: "every_6_weeks",  amount: "20", effective_date: RATE_CUTOVER_DATE },
  { client_type: "residential", cadence: "every_8_weeks",  amount: "15", effective_date: RATE_CUTOVER_DATE },
  { client_type: "residential", cadence: "quarterly",      amount: "15" },
  { client_type: "commercial",  cadence: "weekly",         amount: "100" },
  { client_type: "commercial",  cadence: "biweekly",       amount: "100" },
  { client_type: "commercial",  cadence: "semi_monthly",   amount: "100" },
  { client_type: "commercial",  cadence: "every_3_weeks",  amount: "50" },
  { client_type: "commercial",  cadence: "monthly",        amount: "50" },
  { client_type: "commercial",  cadence: "every_5_weeks",  amount: "50" },
  { client_type: "commercial",  cadence: "every_6_weeks",  amount: "50", effective_date: RATE_CUTOVER_DATE },
  { client_type: "commercial",  cadence: "every_8_weeks",  amount: "50", effective_date: RATE_CUTOVER_DATE },
  { client_type: "commercial",  cadence: "quarterly",      amount: "50" },
];

// Cadences a client can carry that have NO deterministic rate — 'custom' and
// 'weekdays' have no fixed interval, so there is nothing to price. A client on
// one of these earns $0 and is surfaced on Data Health, never silently rated.
export const UNPRICED_CADENCES = new Set(["custom", "weekdays"]);

// Normalize any inbound cadence string to the rate-card key space.
// Qleno's recurring_cadence enum keys pass through unchanged; this exists to
// absorb the free-text spellings that arrive from imports and the legacy app
// ("Every 3 Weeks", "bi-weekly", "tri-weekly", "every3weeks", …).
//
// Unlike Ares' normalizer this NEVER falls through to "weekly" on a partial
// match — an unrecognized cadence returns the slugified input and is priced at
// $0 with `unpriced: true`, so it shows up rather than paying the wrong rate.
export function normalizeCadenceKey(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (!s) return "";

  // Exact keys first.
  const known = new Set([
    "weekly", "biweekly", "semi_monthly", "every_3_weeks", "every_5_weeks",
    "every_6_weeks", "every_8_weeks", "monthly", "quarterly", "custom", "weekdays",
  ]);
  if (known.has(s)) return s;

  // every_N_weeks in any spelling: every3weeks, every_3_week, 3_weeks, tri_weekly.
  const everyN = s.match(/every_?(\d+)_?weeks?/) || s.match(/^(\d+)_?weeks?$/);
  if (everyN) {
    const n = parseInt(everyN[1], 10);
    if (n === 1) return "weekly";
    if (n === 2) return "biweekly";
    return `every_${n}_weeks`;
  }
  if (/^tri_?weekly$/.test(s)) return "every_3_weeks";

  // Two-a-month before the generic month/week rules.
  if (s.includes("semi") && s.includes("month")) return "semi_monthly";
  if (/^(bi_?weekly|every_other_week|fortnight(ly)?)$/.test(s)) return "biweekly";
  if (/^weekly$/.test(s)) return "weekly";
  if (/^monthly$/.test(s)) return "monthly";
  if (/^quarterly$/.test(s)) return "quarterly";

  return s;   // unrecognized — priced at $0, flagged unpriced
}

export interface RateLookup {
  amount: number;
  rate_card_id: number | null;
  unpriced: boolean;
  reason: string | null;
}

// Resolve the flat base rate for a (client_type, cadence) on a given date.
// Branch-specific rows win over company-wide (branch_id IS NULL) rows.
export async function lookupBaseRate(
  companyId: number,
  branchId: number | null,
  clientType: "residential" | "commercial",
  cadence: string | null | undefined,
  onDate: Date = new Date(),
): Promise<RateLookup> {
  const key = normalizeCadenceKey(cadence);
  if (!key) {
    return { amount: 0, rate_card_id: null, unpriced: true, reason: "no cadence on the subscription" };
  }

  const day = onDate.toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(commissionRateCardTable)
    .where(and(
      eq(commissionRateCardTable.company_id, companyId),
      eq(commissionRateCardTable.client_type, clientType),
      eq(commissionRateCardTable.cadence, key),
      sql`${commissionRateCardTable.effective_date} <= ${day}`,
      or(isNull(commissionRateCardTable.end_date), sql`${commissionRateCardTable.end_date} >= ${day}`),
      branchId == null
        ? isNull(commissionRateCardTable.branch_id)
        : or(eq(commissionRateCardTable.branch_id, branchId), isNull(commissionRateCardTable.branch_id)),
    ))
    // branch-specific first, then most recently effective
    .orderBy(desc(commissionRateCardTable.branch_id), desc(commissionRateCardTable.effective_date));

  const hit = rows[0];
  if (!hit) {
    const reason = UNPRICED_CADENCES.has(key)
      ? `cadence '${key}' has no rate card entry — set one in Ares → Commissions → Settings`
      : `unrecognized cadence '${key}' — no rate card entry`;
    return { amount: 0, rate_card_id: null, unpriced: true, reason };
  }
  return { amount: Number(hit.amount), rate_card_id: hit.id, unpriced: false, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedPolicy {
  id: number | null;
  chargeback_window_days: number;
  commercial_chargeback_window_days: number;
  chargeback_dispute_days: number;
  self_sourced_bonus: number;
  performance_bonus_amount: number;
  performance_bonus_threshold: number;
  specialty_bonus_rate: number;
  payout_schedule: string;
}

// Ares' hardcoded constants, used when a company has no commission_policy row.
const DEFAULT_POLICY: ResolvedPolicy = {
  id: null,
  chargeback_window_days: 180,              // residential: first cleaning + 6 months
  commercial_chargeback_window_days: 0,     // commercial: exempt (1-year agreements)
  chargeback_dispute_days: 14,
  self_sourced_bonus: 100,
  performance_bonus_amount: 100,
  performance_bonus_threshold: 5,
  specialty_bonus_rate: 0.05,
  payout_schedule: "monthly",
};

export async function resolvePolicy(
  companyId: number,
  branchId: number | null,
  onDate: Date = new Date(),
): Promise<ResolvedPolicy> {
  const day = onDate.toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(commissionPolicyTable)
    .where(and(
      eq(commissionPolicyTable.company_id, companyId),
      sql`${commissionPolicyTable.effective_date} <= ${day}`,
      or(isNull(commissionPolicyTable.end_date), sql`${commissionPolicyTable.end_date} >= ${day}`),
      branchId == null
        ? isNull(commissionPolicyTable.branch_id)
        : or(eq(commissionPolicyTable.branch_id, branchId), isNull(commissionPolicyTable.branch_id)),
    ))
    .orderBy(desc(commissionPolicyTable.branch_id), desc(commissionPolicyTable.effective_date));

  const p = rows[0];
  if (!p) return DEFAULT_POLICY;
  return {
    id: p.id,
    chargeback_window_days: p.chargeback_window_days,
    commercial_chargeback_window_days: p.commercial_chargeback_window_days,
    chargeback_dispute_days: p.chargeback_dispute_days,
    self_sourced_bonus: Number(p.self_sourced_bonus),
    performance_bonus_amount: Number(p.performance_bonus_amount),
    performance_bonus_threshold: p.performance_bonus_threshold,
    specialty_bonus_rate: Number(p.specialty_bonus_rate),
    payout_schedule: p.payout_schedule,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const periodOf = (d: Date) => d.toISOString().slice(0, 7);           // YYYY-MM
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

export interface Actor { userId: number | null }

// Append-only status transition. Every status change goes through here.
export async function recordStatusEvent(
  companyId: number, branchId: number | null, commissionId: number,
  from: string | null, to: string, actor: Actor, note?: string,
) {
  await db.insert(commissionStatusEventsTable).values({
    company_id: companyId,
    branch_id: branchId,
    commission_id: commissionId,
    from_status: from as any,
    to_status: to as any,
    actor_user_id: actor.userId,
    note: note ?? null,
  });
}

// Signed money movement. Positive = owed to the VA, negative = clawed back.
export async function recordLedger(entry: {
  companyId: number; branchId: number | null;
  commissionId?: number | null; subscriptionId?: number | null; clientId?: number | null;
  vaUserId: number; entryType: string; amount: number; description: string;
  metadata?: Record<string, unknown> | null; relatedPeriod?: string | null; createdBy?: number | null;
}) {
  await db.insert(commissionLedgerTable).values({
    company_id: entry.companyId,
    branch_id: entry.branchId,
    commission_id: entry.commissionId ?? null,
    subscription_id: entry.subscriptionId ?? null,
    client_id: entry.clientId ?? null,
    va_user_id: entry.vaUserId,
    entry_type: entry.entryType as any,
    amount: money(entry.amount),
    description: entry.description,
    metadata: entry.metadata ?? null,
    related_period: entry.relatedPeriod ?? null,
    created_by: entry.createdBy ?? null,
  });
}

// Chargeback window end. Commercial is exempt when its window is 0 → NULL.
export function computeChargebackUntil(
  clientType: "residential" | "commercial",
  firstCleaningDate: Date | null,
  policy: ResolvedPolicy,
): string | null {
  if (!firstCleaningDate) return null;
  const days = clientType === "commercial"
    ? policy.commercial_chargeback_window_days
    : policy.chargeback_window_days;
  if (!days || days <= 0) return null;      // exempt
  return dayStr(addDays(firstCleaningDate, days));
}

export function isInChargebackWindow(chargebackUntil: string | null, now: Date = new Date()): boolean {
  if (!chargebackUntil) return false;
  return dayStr(now) < chargebackUntil;
}

// ─────────────────────────────────────────────────────────────────────────────
// Qualification
// ─────────────────────────────────────────────────────────────────────────────

export interface Qualification { qualified: boolean; reason: string | null }

// Ares: a subscription earns a commission only when it has a first cleaning
// date, a cadence, and is active. A signed service agreement is explicitly NOT
// required to earn — it gates approval, not creation.
export function checkQualification(sub: {
  status: string | null; cadence: string | null; first_cleaning_date: string | Date | null;
}): Qualification {
  if (!sub.first_cleaning_date) return { qualified: false, reason: "no first cleaning date" };
  if (!sub.cadence) return { qualified: false, reason: "no cadence" };
  if (sub.status !== "active") return { qualified: false, reason: `status is '${sub.status}', not active` };
  return { qualified: true, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Earning — the main creation path
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateResult {
  created: boolean;
  commission_id: number | null;
  amount: number;
  skipped_reason: string | null;
  unpriced: boolean;
  performance_bonus_id: number | null;
}

// Ares: CommissionOrchestrator.createCommissionForNewClient.
// Called when a recurring subscription is captured with a VA attribution.
export async function createCommissionForNewClient(opts: {
  companyId: number; branchId: number | null;
  subscriptionId: number; vaUserId: number; vaName?: string | null;
  isSelfSourced?: boolean; actor: Actor;
}): Promise<CreateResult> {
  const none: CreateResult = {
    created: false, commission_id: null, amount: 0,
    skipped_reason: null, unpriced: false, performance_bonus_id: null,
  };

  const [sub] = await db.select().from(recurringSubscriptionsTable)
    .where(and(
      eq(recurringSubscriptionsTable.id, opts.subscriptionId),
      eq(recurringSubscriptionsTable.company_id, opts.companyId),
    ));
  if (!sub) return { ...none, skipped_reason: "subscription not found" };

  const q = checkQualification(sub as any);
  if (!q.qualified) return { ...none, skipped_reason: q.reason };

  const clientType = (sub.client_type ?? "residential") as "residential" | "commercial";
  const firstClean = sub.first_cleaning_date ? new Date(sub.first_cleaning_date as any) : null;
  const policy = await resolvePolicy(opts.companyId, opts.branchId, firstClean ?? new Date());
  const rate = await lookupBaseRate(opts.companyId, opts.branchId, clientType, sub.cadence, firstClean ?? new Date());

  // Commercial self-sourced leads carry a flat sourcing bonus.
  const sourceBonus = clientType === "commercial" && opts.isSelfSourced ? policy.self_sourced_bonus : 0;
  const total = rate.amount + sourceBonus;

  // Client name snapshot + returning-client detection. A client who cancelled
  // 90+ days ago and came back is flagged so the approval queue can rule on it.
  let clientName: string | null = null;
  let reactivationDate: string | null = null;
  let daysInactive: number | null = null;
  if (sub.client_id) {
    const [c] = await db.select({
      first_name: clientsTable.first_name,
      last_name: clientsTable.last_name,
      company_name: clientsTable.company_name,
    }).from(clientsTable).where(eq(clientsTable.id, sub.client_id));
    if (c) clientName = (c.company_name || `${c.first_name} ${c.last_name}`).trim();

    // Most recent prior loss for THIS client, across any of its subscriptions.
    const prior = await db.execute(sql`
      SELECT MAX(le.loss_date) AS loss_date
        FROM subscription_lifecycle_events le
        JOIN recurring_subscriptions rs ON rs.id = le.subscription_id
       WHERE le.company_id = ${opts.companyId}
         AND le.event_type = 'loss'
         AND rs.company_id = ${opts.companyId}
         AND rs.client_id = ${sub.client_id}
    `);
    const priorLoss = (prior.rows?.[0] as { loss_date: string | null } | undefined)?.loss_date ?? null;
    const lastLoss = priorLoss ? new Date(priorLoss) : null;
    if (lastLoss && firstClean) {
      const gap = Math.floor((firstClean.getTime() - lastLoss.getTime()) / 86400000);
      if (gap >= 90) { reactivationDate = dayStr(firstClean); daysInactive = gap; }
    }
  }

  const [row] = await db.insert(commissionsTable).values({
    company_id: opts.companyId,
    branch_id: opts.branchId,
    subscription_id: opts.subscriptionId,
    client_id: sub.client_id ?? null,
    client_name: clientName,
    va_user_id: opts.vaUserId,
    va_name: opts.vaName ?? null,
    status: "pending_review",
    commission_type: "base",
    client_type: clientType,
    cadence: normalizeCadenceKey(sub.cadence),
    base_amount: money(rate.amount),
    source_bonus_amount: money(sourceBonus),
    specialty_bonus_amount: "0",
    amount: money(total),
    commission_policy_id: policy.id,
    rate_card_id: rate.rate_card_id,
    earned_date: dayStr(new Date()),
    first_cleaning_date: firstClean ? dayStr(firstClean) : null,
    chargeback_until: computeChargebackUntil(clientType, firstClean, policy),
    reactivation_date: reactivationDate,
    days_inactive: daysInactive,
    notes: rate.unpriced ? `UNPRICED: ${rate.reason}` : null,
  }).returning({ id: commissionsTable.id });

  await recordStatusEvent(
    opts.companyId, opts.branchId, row.id, null, "pending_review", opts.actor,
    rate.unpriced ? `Earned at $0 — ${rate.reason}` : `Earned $${money(total)} (${clientType} ${normalizeCadenceKey(sub.cadence)})`,
  );

  const period = firstClean ? periodOf(firstClean) : periodOf(new Date());
  if (rate.amount !== 0) {
    await recordLedger({
      companyId: opts.companyId, branchId: opts.branchId, commissionId: row.id,
      subscriptionId: opts.subscriptionId, clientId: sub.client_id ?? null,
      vaUserId: opts.vaUserId, entryType: "base", amount: rate.amount,
      description: `Base commission — ${clientName ?? "client"} (${normalizeCadenceKey(sub.cadence)})`,
      relatedPeriod: period, createdBy: opts.actor.userId,
    });
  }
  if (sourceBonus > 0) {
    await recordLedger({
      companyId: opts.companyId, branchId: opts.branchId, commissionId: row.id,
      subscriptionId: opts.subscriptionId, clientId: sub.client_id ?? null,
      vaUserId: opts.vaUserId, entryType: "commercial_source_bonus", amount: sourceBonus,
      description: `Self-sourced commercial bonus — ${clientName ?? "client"}`,
      relatedPeriod: period, createdBy: opts.actor.userId,
    });
  }

  const bonusId = await maybeAwardPerformanceBonus({
    companyId: opts.companyId, branchId: opts.branchId,
    vaUserId: opts.vaUserId, vaName: opts.vaName ?? null,
    cadence: normalizeCadenceKey(sub.cadence), policy, actor: opts.actor,
  });

  return {
    created: true, commission_id: row.id, amount: total,
    skipped_reason: null, unpriced: rate.unpriced, performance_bonus_id: bonusId,
  };
}

// Ares: N qualifying weekly/biweekly clients in one calendar month earns a flat
// bonus, once per VA per month. Only weekly/biweekly count toward the tally.
async function maybeAwardPerformanceBonus(opts: {
  companyId: number; branchId: number | null; vaUserId: number; vaName: string | null;
  cadence: string; policy: ResolvedPolicy; actor: Actor;
}): Promise<number | null> {
  if (opts.cadence !== "weekly" && opts.cadence !== "biweekly") return null;

  const now = new Date();
  const monthStart = dayStr(new Date(now.getFullYear(), now.getMonth(), 1));
  const period = periodOf(now);

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
    .from(commissionsTable)
    .where(sql`${commissionsTable.company_id} = ${opts.companyId}
               AND ${commissionsTable.va_user_id} = ${opts.vaUserId}
               AND ${commissionsTable.commission_type} = 'base'
               AND ${commissionsTable.cadence} IN ('weekly','biweekly')
               AND ${commissionsTable.status} NOT IN ('not_eligible','charged_back','on_hold','rejected')
               AND ${commissionsTable.created_at} >= ${monthStart}`);

  if (n < opts.policy.performance_bonus_threshold) return null;

  const [existing] = await db.select({ id: commissionsTable.id })
    .from(commissionsTable)
    .where(sql`${commissionsTable.company_id} = ${opts.companyId}
               AND ${commissionsTable.va_user_id} = ${opts.vaUserId}
               AND ${commissionsTable.commission_type} = 'performance_bonus'
               AND to_char(${commissionsTable.created_at}, 'YYYY-MM') = ${period}`);
  if (existing) return null;

  const amt = opts.policy.performance_bonus_amount;
  // [label-date-tz 2026-08-21] On the last evening of a month, UTC has already
  // rolled over, so a bonus earned in August would be labelled September.
  const label = new Date().toLocaleString("en-US", { timeZone: tzOf(opts.companyId), month: "long", year: "numeric" });
  const [row] = await db.insert(commissionsTable).values({
    company_id: opts.companyId,
    branch_id: opts.branchId,
    subscription_id: null,                 // earned against a month, not a client
    va_user_id: opts.vaUserId,
    va_name: opts.vaName,
    status: "pending_review",
    commission_type: "performance_bonus",
    base_amount: "0",
    source_bonus_amount: "0",
    specialty_bonus_amount: "0",
    amount: money(amt),
    earned_date: dayStr(new Date()),
    service_agreement_verified: true,      // nothing to verify on a month bonus
    notes: `Performance bonus — ${n} qualifying clients in ${label}`,
  }).returning({ id: commissionsTable.id });

  await recordStatusEvent(opts.companyId, opts.branchId, row.id, null, "pending_review", opts.actor,
    `Performance bonus earned — ${n} qualifying weekly/biweekly clients in ${label}`);
  await recordLedger({
    companyId: opts.companyId, branchId: opts.branchId, commissionId: row.id,
    vaUserId: opts.vaUserId, entryType: "performance_bonus", amount: amt,
    description: `Performance bonus — ${n} qualifying clients in ${label}`,
    relatedPeriod: period, createdBy: opts.actor.userId,
  });
  return row.id;
}

// Ares: a manually-created bonus worth a share of specialty-service revenue
// (deep clean, move-in/out, post-renovation, seasonal, commercial add-on).
export async function createSpecialtyBonus(opts: {
  companyId: number; branchId: number | null; vaUserId: number; vaName?: string | null;
  subscriptionId?: number | null; clientId?: number | null; clientName?: string | null;
  serviceType: string; revenueAmount: number; actor: Actor;
}): Promise<{ commission_id: number; amount: number }> {
  const policy = await resolvePolicy(opts.companyId, opts.branchId);
  const amt = Math.round(opts.revenueAmount * policy.specialty_bonus_rate * 100) / 100;

  const [row] = await db.insert(commissionsTable).values({
    company_id: opts.companyId,
    branch_id: opts.branchId,
    subscription_id: opts.subscriptionId ?? null,
    client_id: opts.clientId ?? null,
    client_name: opts.clientName ?? null,
    va_user_id: opts.vaUserId,
    va_name: opts.vaName ?? null,
    status: "pending_review",
    commission_type: "specialty_bonus",
    specialty_service_type: opts.serviceType,
    revenue_amount: money(opts.revenueAmount),
    base_amount: "0",
    source_bonus_amount: "0",
    specialty_bonus_amount: money(amt),
    amount: money(amt),
    commission_policy_id: policy.id,
    earned_date: dayStr(new Date()),
    service_agreement_verified: true,
  }).returning({ id: commissionsTable.id });

  const pct = (policy.specialty_bonus_rate * 100).toFixed(0);
  await recordStatusEvent(opts.companyId, opts.branchId, row.id, null, "pending_review", opts.actor,
    `Specialty bonus — ${opts.serviceType}, ${pct}% of $${money(opts.revenueAmount)}`);
  await recordLedger({
    companyId: opts.companyId, branchId: opts.branchId, commissionId: row.id,
    subscriptionId: opts.subscriptionId ?? null, clientId: opts.clientId ?? null,
    vaUserId: opts.vaUserId, entryType: "specialty_bonus", amount: amt,
    description: `Specialty bonus (${opts.serviceType}) — ${pct}% of $${money(opts.revenueAmount)}`,
    relatedPeriod: periodOf(new Date()), createdBy: opts.actor.userId,
  });
  return { commission_id: row.id, amount: amt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cadence change → commission adjustment
// ─────────────────────────────────────────────────────────────────────────────

// Ares: CommissionOrchestrator.handleCadenceChange. A client moving from
// monthly to weekly is worth more commission; the delta is booked as an
// adjustment against the existing line rather than a new commission.
//
// DEVIATION FROM ARES (deliberate): Ares skipped writing the history row when
// the money delta was zero, so same-price cadence changes vanished. Here the
// history row is ALWAYS written and carries a possibly-zero adjustment_amount.
export async function handleCadenceChange(opts: {
  companyId: number; branchId: number | null; subscriptionId: number;
  previousCadence: string | null; newCadence: string; actor: Actor;
}): Promise<{ adjusted: boolean; adjustment: number }> {
  const prev = normalizeCadenceKey(opts.previousCadence);
  const next = normalizeCadenceKey(opts.newCadence);
  if (!next || prev === next) return { adjusted: false, adjustment: 0 };

  const [sub] = await db.select().from(recurringSubscriptionsTable)
    .where(and(
      eq(recurringSubscriptionsTable.id, opts.subscriptionId),
      eq(recurringSubscriptionsTable.company_id, opts.companyId),
    ));
  const clientType = (sub?.client_type ?? "residential") as "residential" | "commercial";

  const before = prev ? await lookupBaseRate(opts.companyId, opts.branchId, clientType, prev) : { amount: 0 } as RateLookup;
  const after = await lookupBaseRate(opts.companyId, opts.branchId, clientType, next);
  const delta = Math.round((after.amount - before.amount) * 100) / 100;

  const direction = delta > 0 ? "Frequency upgrade" : delta < 0 ? "Frequency downgrade" : "Frequency change";
  const reason = `${direction}: ${prev || "none"} → ${next}` + (delta !== 0 ? ` (${delta > 0 ? "+" : ""}$${money(delta)})` : " (no rate change)");

  await db.insert(subscriptionCadenceHistoryTable).values({
    company_id: opts.companyId,
    branch_id: opts.branchId,
    subscription_id: opts.subscriptionId,
    previous_cadence: prev || null,
    new_cadence: next,
    adjustment_amount: money(delta),
    changed_by: opts.actor.userId,
    reason,
  });

  if (delta === 0) return { adjusted: false, adjustment: 0 };

  // Adjust the base line for this subscription. Never touch a line whose money
  // has already settled — Ares mutated paid and recouped rows here, which
  // rewrote history after the fact.
  const [line] = await db.select().from(commissionsTable)
    .where(sql`${commissionsTable.company_id} = ${opts.companyId}
               AND ${commissionsTable.subscription_id} = ${opts.subscriptionId}
               AND ${commissionsTable.commission_type} = 'base'
               AND ${commissionsTable.status} IN ('earned','pending_review','approved','on_hold')`)
    .orderBy(commissionsTable.id);
  if (!line) return { adjusted: false, adjustment: 0 };

  const newBase = Number(line.base_amount) + delta;
  const newTotal = Number(line.amount) + delta;
  await db.update(commissionsTable).set({
    base_amount: money(newBase),
    amount: money(newTotal),
    cadence: next,
    rate_card_id: after.rate_card_id,
    updated_at: new Date(),
  }).where(eq(commissionsTable.id, line.id));

  await recordLedger({
    companyId: opts.companyId, branchId: opts.branchId, commissionId: line.id,
    subscriptionId: opts.subscriptionId, clientId: line.client_id,
    vaUserId: line.va_user_id, entryType: "adjustment", amount: delta,
    description: reason,
    metadata: { previous_cadence: prev, new_cadence: next, client_name: line.client_name },
    relatedPeriod: periodOf(new Date()), createdBy: opts.actor.userId,
  });

  return { adjusted: true, adjustment: delta };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loss → chargeback, step 1 of 3
// ─────────────────────────────────────────────────────────────────────────────

export interface LossOutcome {
  action: "none" | "rejected" | "chargeback_opened";
  commission_id: number | null;
  amount: number;
  dispute_deadline: string | null;
}

// Ares: CommissionOrchestrator.handleLostClient. Called when a subscription is
// classified as lost.
//   • not yet approved  → the commission is rejected outright and reversed.
//   • approved/paid, still inside the chargeback window → clawback opens with a
//     dispute deadline. NO money is deducted at this point (that is step 3).
//   • approved/paid, outside the window → nothing. The VA keeps it.
export async function handleLostClient(opts: {
  companyId: number; branchId: number | null; subscriptionId: number;
  lossDate?: Date | null; reason?: string | null; actor: Actor;
}): Promise<LossOutcome> {
  const none: LossOutcome = { action: "none", commission_id: null, amount: 0, dispute_deadline: null };

  const [line] = await db.select().from(commissionsTable)
    .where(sql`${commissionsTable.company_id} = ${opts.companyId}
               AND ${commissionsTable.subscription_id} = ${opts.subscriptionId}
               AND ${commissionsTable.commission_type} = 'base'`)
    .orderBy(commissionsTable.id);
  if (!line) return none;

  const lossDate = opts.lossDate ?? new Date();
  const policy = await resolvePolicy(opts.companyId, opts.branchId, lossDate);
  const amount = Number(line.amount);

  // Not yet approved — reverse it cleanly, no clawback machinery needed.
  if (line.status === "earned" || line.status === "pending_review" || line.status === "on_hold") {
    await db.update(commissionsTable).set({
      status: "rejected",
      notes: [line.notes, "Client marked lost before the commission was approved"].filter(Boolean).join(" · "),
      updated_at: new Date(),
    }).where(eq(commissionsTable.id, line.id));

    await recordStatusEvent(opts.companyId, opts.branchId, line.id, line.status, "rejected", opts.actor,
      opts.reason ? `Client lost — ${opts.reason}` : "Client lost before approval");
    if (amount !== 0) {
      await recordLedger({
        companyId: opts.companyId, branchId: opts.branchId, commissionId: line.id,
        subscriptionId: opts.subscriptionId, clientId: line.client_id,
        vaUserId: line.va_user_id, entryType: "adjustment", amount: -amount,
        description: `Reversed — client lost before approval (${line.client_name ?? "client"})`,
        relatedPeriod: periodOf(lossDate), createdBy: opts.actor.userId,
      });
    }
    return { action: "rejected", commission_id: line.id, amount, dispute_deadline: null };
  }

  // Approved or paid — clawback only if still inside the window.
  if (line.status !== "approved" && line.status !== "paid") return none;
  if (!isInChargebackWindow(line.chargeback_until, lossDate)) return none;

  const deadline = dayStr(addDays(lossDate, policy.chargeback_dispute_days));
  await db.update(commissionsTable).set({
    status: "chargeback_pending",
    chargeback_date: dayStr(lossDate),
    chargeback_dispute_deadline: deadline,
    updated_at: new Date(),
  }).where(eq(commissionsTable.id, line.id));

  await db.insert(commissionChargebacksTable).values({
    company_id: opts.companyId,
    branch_id: opts.branchId,
    commission_id: line.id,
    subscription_id: opts.subscriptionId,
    reason: opts.reason ?? "Client lost inside the chargeback window",
    clawback_amount: money(amount),
    chargeback_date: dayStr(lossDate),
    dispute_deadline: deadline,
    created_by: opts.actor.userId,
  });

  await recordStatusEvent(opts.companyId, opts.branchId, line.id, line.status, "chargeback_pending", opts.actor,
    `Chargeback opened — dispute window closes ${deadline}. No deduction yet.`);

  return { action: "chargeback_opened", commission_id: line.id, amount, dispute_deadline: deadline };
}

// ── step 2 of 3 — the daily sweep ────────────────────────────────────────────
// Promotes chargeback_pending → chargeback_confirmed once the dispute window
// has closed. Deduction still does not happen here; it happens at payout.
// Safe to run repeatedly — it only ever moves rows whose deadline has passed.
export async function promoteExpiredChargebacks(companyId: number, actor: Actor = { userId: null }) {
  const today = dayStr(new Date());
  const due = await db.select().from(commissionsTable)
    .where(sql`${commissionsTable.company_id} = ${companyId}
               AND ${commissionsTable.status} = 'chargeback_pending'
               AND ${commissionsTable.chargeback_dispute_deadline} IS NOT NULL
               AND ${commissionsTable.chargeback_dispute_deadline} <= ${today}`);

  for (const line of due) {
    await db.update(commissionsTable)
      .set({ status: "chargeback_confirmed", updated_at: new Date() })
      .where(eq(commissionsTable.id, line.id));
    await recordStatusEvent(companyId, line.branch_id, line.id, "chargeback_pending", "chargeback_confirmed", actor,
      "Dispute window closed — deduction scheduled for the next payout");
  }
  return { promoted: due.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout — step 3 of 3
// ─────────────────────────────────────────────────────────────────────────────

// Ares pays on the LAST FRIDAY of month M, covering clients whose first
// cleaning fell in month M-1.
export function lastFridayOf(year: number, month1to12: number): Date {
  const d = new Date(year, month1to12, 0);            // last day of the month
  while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
  return d;
}

// The earning window a payout month covers: the whole of the previous month.
export function payoutEarningWindow(payoutMonth: string): { start: string; end: string } {
  const [y, m] = payoutMonth.split("-").map(Number);
  return { start: dayStr(new Date(y, m - 2, 1)), end: dayStr(new Date(y, m - 1, 0)) };
}

export interface PayoutLine {
  id: number; client_name: string | null; commission_type: string;
  cadence: string | null; amount: number; first_cleaning_date: string | null;
}
export interface PayoutPreview {
  va_user_id: number; va_name: string | null; payout_month: string;
  period_start: string; period_end: string; payout_date: string;
  lines: PayoutLine[]; gross: number;
  chargebacks: Array<{ id: number; client_name: string | null; amount: number }>;
  chargeback_total: number;
  prior_carryover: number;
  prior_carryover_payment_ids: number[];
  net: number; carryover: number;
}

// Read-only. Same math as processPayout so the preview can never disagree with
// what actually runs.
export async function previewPayout(opts: {
  companyId: number; branchId: number | null; vaUserId: number; payoutMonth: string;
}): Promise<PayoutPreview> {
  const { start, end } = payoutEarningWindow(opts.payoutMonth);
  const [y, m] = opts.payoutMonth.split("-").map(Number);

  // Approved lines earned in the window. Bonuses carry no first cleaning date,
  // so they fall back to earned_date — in Ares they had neither and therefore
  // silently never paid out.
  // Branch scope must match the list the operator was just looking at. Without
  // it the screen showed one branch's total and this paid the whole company's.
  const branchFilter = opts.branchId != null
    ? sql`AND ${commissionsTable.branch_id} = ${opts.branchId}`
    : sql``;

  const rows = await db.select().from(commissionsTable)
    .where(sql`${commissionsTable.company_id} = ${opts.companyId}
               AND ${commissionsTable.va_user_id} = ${opts.vaUserId}
               AND ${commissionsTable.status} = 'approved'
               AND ${commissionsTable.payment_id} IS NULL
               ${branchFilter}
               AND COALESCE(${commissionsTable.first_cleaning_date}, ${commissionsTable.earned_date})
                   BETWEEN ${start} AND ${end}`)
    .orderBy(commissionsTable.first_cleaning_date);

  const lines: PayoutLine[] = rows.map(r => ({
    id: r.id,
    client_name: r.client_name,
    commission_type: r.commission_type as string,
    cadence: r.cadence,
    amount: Number(r.amount),
    first_cleaning_date: (r.first_cleaning_date as unknown as string) ?? null,
  }));
  const gross = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

  // ALL outstanding confirmed chargebacks for this VA, not just this period's —
  // a clawback follows the VA until it is actually collected.
  const cbRows = await db.select().from(commissionsTable)
    .where(sql`${commissionsTable.company_id} = ${opts.companyId}
               AND ${commissionsTable.va_user_id} = ${opts.vaUserId}
               ${branchFilter}
               AND ${commissionsTable.status} = 'chargeback_confirmed'`);
  const chargebacks = cbRows.map(r => ({ id: r.id, client_name: r.client_name, amount: Number(r.amount) }));
  const cbSum = Math.round(chargebacks.reduce((s, c) => s + c.amount, 0) * 100) / 100;

  // Carryover left uncollected by earlier runs. Ares computed this, announced it
  // in an email, and then dropped it — the excess was silently forgiven.
  const priorRows = await db.select({
    id: commissionPaymentsTable.id,
    carryover_amount: commissionPaymentsTable.carryover_amount,
  }).from(commissionPaymentsTable)
    .where(sql`${commissionPaymentsTable.company_id} = ${opts.companyId}
               AND ${commissionPaymentsTable.va_user_id} = ${opts.vaUserId}
               AND ${commissionPaymentsTable.status} = 'processed'
               ${opts.branchId != null ? sql`AND ${commissionPaymentsTable.branch_id} = ${opts.branchId}` : sql``}
               AND ${commissionPaymentsTable.carryover_collected_at} IS NULL
               AND ${commissionPaymentsTable.carryover_amount} > 0`);
  const priorCarry = Math.round(priorRows.reduce((s, r) => s + Number(r.carryover_amount), 0) * 100) / 100;

  const owedBack = Math.round((cbSum + priorCarry) * 100) / 100;
  const net = Math.max(0, Math.round((gross - owedBack) * 100) / 100);
  const carryover = Math.max(0, Math.round((owedBack - gross) * 100) / 100);

  return {
    va_user_id: opts.vaUserId,
    va_name: rows[0]?.va_name ?? null,
    payout_month: opts.payoutMonth,
    period_start: start, period_end: end,
    payout_date: dayStr(lastFridayOf(y, m)),
    lines, gross, chargebacks, chargeback_total: cbSum,
    prior_carryover: priorCarry,
    prior_carryover_payment_ids: priorRows.map(r => r.id),
    net, carryover,
  };
}

// PHR-YYYY-MM-NNN, sequential within the payout month.
async function nextReceiptNumber(companyId: number, payoutMonth: string): Promise<string> {
  const prefix = `PHR-${payoutMonth}-`;
  const rows = await db.select({ id: commissionPaymentsTable.id })
    .from(commissionPaymentsTable)
    .where(sql`${commissionPaymentsTable.company_id} = ${companyId}
               AND ${commissionPaymentsTable.receipt_number} LIKE ${prefix + "%"}`);
  return `${prefix}${String(rows.length + 1).padStart(3, "0")}`;
}

export type PayoutResult =
  | { already_paid: true; payment_id: number; receipt_number: string | null }
  | { already_paid: false; payment_id: number; receipt_number: string; preview: PayoutPreview };

// Runs the payout. Idempotent on (company, va, payout month) via the unique
// idempotency_key — re-running a period cannot double-pay.
export async function processPayout(opts: {
  companyId: number; branchId: number | null; vaUserId: number; payoutMonth: string;
  paymentMethod?: string | null; notes?: string | null; actor: Actor;
}): Promise<PayoutResult> {
  const idem = `${opts.companyId}:${opts.vaUserId}:${opts.payoutMonth}`;

  const [existing] = await db.select({
    id: commissionPaymentsTable.id,
    receipt_number: commissionPaymentsTable.receipt_number,
  }).from(commissionPaymentsTable)
    .where(and(
      eq(commissionPaymentsTable.company_id, opts.companyId),
      eq(commissionPaymentsTable.idempotency_key, idem),
      eq(commissionPaymentsTable.status, "processed"),
    ));
  if (existing) {
    return { already_paid: true, payment_id: existing.id, receipt_number: existing.receipt_number };
  }

  const preview = await previewPayout(opts);
  const receipt = await nextReceiptNumber(opts.companyId, opts.payoutMonth);
  const salesPeriod = new Date(preview.period_start + "T12:00:00")
    .toLocaleString("en-US", { month: "long", year: "numeric" }) + " sales";

  const [payment] = await db.insert(commissionPaymentsTable).values({
    company_id: opts.companyId,
    branch_id: opts.branchId,
    va_user_id: opts.vaUserId,
    va_name: preview.va_name,
    period_start: preview.period_start,
    period_end: preview.period_end,
    sales_period: salesPeriod,
    gross_amount: money(preview.gross),
    chargeback_total: money(preview.chargeback_total + preview.prior_carryover),
    carryover_amount: money(preview.carryover),
    total_amount: money(preview.net),
    item_count: preview.lines.length,
    status: "processed",
    idempotency_key: idem,
    receipt_number: receipt,
    payment_method: opts.paymentMethod ?? null,
    payment_details: {
      chargebacks: preview.chargebacks,
      prior_carryover: preview.prior_carryover,
      payout_date: preview.payout_date,
    },
    notes: [
      opts.notes,
      preview.chargeback_total > 0 ? `Chargebacks netted: -$${money(preview.chargeback_total)}` : null,
      preview.prior_carryover > 0 ? `Prior carryover applied: -$${money(preview.prior_carryover)}` : null,
      preview.carryover > 0 ? `Carried forward: $${money(preview.carryover)}` : null,
    ].filter(Boolean).join(" · ") || null,
    processed_by: opts.actor.userId,
  }).returning({ id: commissionPaymentsTable.id });

  const paidDate = dayStr(new Date());

  // Settle the paid lines.
  for (const line of preview.lines) {
    await db.update(commissionsTable).set({
      status: "paid", payment_id: payment.id, paid_date: paidDate, updated_at: new Date(),
    }).where(eq(commissionsTable.id, line.id));
    await recordStatusEvent(opts.companyId, opts.branchId, line.id, "approved", "paid", opts.actor, `Paid on ${receipt}`);
  }
  if (preview.gross !== 0) {
    await recordLedger({
      companyId: opts.companyId, branchId: opts.branchId, vaUserId: opts.vaUserId,
      entryType: "payout", amount: -preview.gross,
      description: `Payout ${receipt} — ${preview.lines.length} item(s)`,
      metadata: { receipt_number: receipt, net: preview.net, chargeback_total: preview.chargeback_total },
      relatedPeriod: opts.payoutMonth, createdBy: opts.actor.userId,
    });
  }

  // Settle the chargebacks that were netted out.
  for (const cb of preview.chargebacks) {
    await db.update(commissionsTable).set({
      status: "recouped", paid_date: paidDate, updated_at: new Date(),
    }).where(eq(commissionsTable.id, cb.id));
    await db.update(commissionChargebacksTable).set({
      recouped_payment_id: payment.id, recouped_at: new Date(),
    }).where(eq(commissionChargebacksTable.commission_id, cb.id));
    await recordStatusEvent(opts.companyId, opts.branchId, cb.id, "chargeback_confirmed", "recouped", opts.actor,
      `Deducted on ${receipt}`);
    await recordLedger({
      companyId: opts.companyId, branchId: opts.branchId, commissionId: cb.id,
      vaUserId: opts.vaUserId, entryType: "chargeback", amount: -cb.amount,
      description: `Chargeback recouped — ${cb.client_name ?? "client"} (${receipt})`,
      relatedPeriod: opts.payoutMonth, createdBy: opts.actor.userId,
    });
  }

  // Mark any prior carryover as collected — only when this run actually
  // absorbed it (i.e. it did not roll forward again).
  if (preview.prior_carryover > 0 && preview.carryover === 0 && preview.prior_carryover_payment_ids.length) {
    for (const pid of preview.prior_carryover_payment_ids) {
      await db.update(commissionPaymentsTable)
        .set({ carryover_collected_at: new Date() })
        .where(eq(commissionPaymentsTable.id, pid));
    }
  }

  return { already_paid: false, payment_id: payment.id, receipt_number: receipt, preview };
}

// ─────────────────────────────────────────────────────────────────────────────
// VA statement summary
// ─────────────────────────────────────────────────────────────────────────────

// Career figures come from the LEDGER, not the commission rows: an adjustment
// moves money without creating a line, so summing lines under-reports.
export async function getCommissionSummary(companyId: number, vaUserId: number) {
  const [led] = await db.select({
    earned: sql<string>`COALESCE(SUM(CASE WHEN ${commissionLedgerTable.entry_type} NOT IN ('chargeback','payout')
                                          THEN ${commissionLedgerTable.amount} ELSE 0 END),0)::text`,
    charged_back: sql<string>`COALESCE(SUM(CASE WHEN ${commissionLedgerTable.entry_type} = 'chargeback'
                                                THEN ABS(${commissionLedgerTable.amount}) ELSE 0 END),0)::text`,
    paid_out: sql<string>`COALESCE(SUM(CASE WHEN ${commissionLedgerTable.entry_type} = 'payout'
                                            THEN ABS(${commissionLedgerTable.amount}) ELSE 0 END),0)::text`,
  }).from(commissionLedgerTable)
    .where(and(
      eq(commissionLedgerTable.company_id, companyId),
      eq(commissionLedgerTable.va_user_id, vaUserId),
    ));

  const [cur] = await db.select({
    pending: sql<string>`COALESCE(SUM(CASE WHEN ${commissionsTable.status} IN ('earned','pending_review')
                                           THEN ${commissionsTable.amount} ELSE 0 END),0)::text`,
    approved: sql<string>`COALESCE(SUM(CASE WHEN ${commissionsTable.status} = 'approved'
                                            THEN ${commissionsTable.amount} ELSE 0 END),0)::text`,
    exposure: sql<string>`COALESCE(SUM(CASE WHEN ${commissionsTable.chargeback_until} IS NOT NULL
                                             AND ${commissionsTable.chargeback_until} > CURRENT_DATE
                                             AND ${commissionsTable.status} IN ('approved','paid')
                                           THEN ${commissionsTable.amount} ELSE 0 END),0)::text`,
  }).from(commissionsTable)
    .where(and(
      eq(commissionsTable.company_id, companyId),
      eq(commissionsTable.va_user_id, vaUserId),
    ));

  const earned = Number(led?.earned ?? 0);
  const chargedBack = Number(led?.charged_back ?? 0);
  return {
    total_earned: earned,
    total_charged_back: chargedBack,
    net_earnings: Math.round((earned - chargedBack) * 100) / 100,
    total_paid_out: Number(led?.paid_out ?? 0),
    pending_amount: Number(cur?.pending ?? 0),
    approved_amount: Number(cur?.approved ?? 0),
    chargeback_exposure: Number(cur?.exposure ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeding
// ─────────────────────────────────────────────────────────────────────────────

// Installs Ares' rate card for a company that has none. Idempotent: a company
// with any rate card row is left alone.
export async function seedRateCardIfEmpty(companyId: number, effectiveDate = "2020-01-01") {
  const existing = await db.select({ id: commissionRateCardTable.id })
    .from(commissionRateCardTable)
    .where(eq(commissionRateCardTable.company_id, companyId));
  if (existing.length) return { seeded: 0 };

  await db.insert(commissionRateCardTable).values(
    ARES_SEED_RATES.map(r => ({
      company_id: companyId,
      branch_id: null,
      client_type: r.client_type,
      cadence: r.cadence,
      amount: r.amount,
      effective_date: r.effective_date ?? effectiveDate,
    })),
  );
  return { seeded: ARES_SEED_RATES.length };
}
