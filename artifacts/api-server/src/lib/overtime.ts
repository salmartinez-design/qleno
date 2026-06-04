/**
 * Overtime engine — jurisdiction-aware "hours worked" → overtime premium.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LEGAL BASIS (not legal advice — tenants must confirm with their own
 * payroll provider / employment counsel; see docs/OVERTIME_COMPLIANCE_DESIGN.md):
 *
 *  • Hours worked. Only COMPENSABLE time counts toward overtime. For a tech
 *    who drives between client homes, that is:
 *      - time on the per-house clock (timeclock.clock_in_at..clock_out_at), and
 *      - travel BETWEEN job sites during the workday (29 CFR 785.38).
 *    The home→first-job and last-job→home commute is NOT compensable
 *    (29 CFR 785.35) and never enters this engine — it is excluded upstream
 *    by the mileage engine (skip_first_leg_of_day / skip_no_from_job) and by
 *    the fact that no clock runs during the commute.
 *
 *  • Threshold. Federal FLSA + most states (incl. Illinois, 820 ILCS 105/4a):
 *    time-and-a-half for hours worked over 40 in a workweek. No daily overtime.
 *    A handful of states ALSO require daily overtime — see STATE_OVERTIME_PRESETS.
 *
 *  • Commission pay (Phes model). Commissions are part of the regular rate
 *    (29 CFR 778.117). For an employee paid by commission (no hourly wage),
 *    straight-time for every hour is already covered by the commission, so the
 *    only money owed for overtime is the PREMIUM portion — an extra 0.5× the
 *    regular rate for 1.5× hours, an extra 1.0× for double-time hours. The
 *    regular rate = total workweek commission ÷ total hours worked that week.
 *    Mileage reimbursement is a bona-fide expense reimbursement and is EXCLUDED
 *    from the regular rate (29 CFR 778.217).
 *
 * DESIGN: this module is pure (no DB / no I/O). The route layer feeds it the
 * resolved company rules + the hours/commission it has already queried, and
 * surfaces the result for office review. Consistent with the rest of the
 * payroll build, computed overtime is a REVIEW SIGNAL — it does not auto-move
 * money.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface OvertimeRules {
  /** Weekly overtime threshold in hours. Federal/most states = 40. */
  weeklyThresholdHours: number;
  /** Daily overtime threshold; null = no daily overtime (the common case). */
  dailyThresholdHours: number | null;
  /** Daily double-time threshold; null = no double-time. */
  dailyDoubleTimeHours: number | null;
  /** Seventh-consecutive-workday rule (California). */
  seventhConsecutiveDayRule: boolean;
  /** Overtime multiplier (time-and-a-half = 1.5). */
  otMultiplier: number;
  /** Double-time multiplier (2.0). */
  dtMultiplier: number;
}

export interface OvertimePreset extends OvertimeRules {
  /** Where this rule set came from, for display/audit. */
  label: string;
  /** Optional caveat the office should read before relying on the preset. */
  note?: string;
}

/**
 * Federal / FLSA default — also correct for Illinois and the majority of
 * states: weekly-40 only, time-and-a-half. This is what every tenant gets
 * out of the box, so Qleno is compliant by default regardless of where the
 * tenant operates; daily-overtime states are opt-in via the presets below.
 */
export const FEDERAL_DEFAULT_RULES: OvertimeRules = {
  weeklyThresholdHours: 40,
  dailyThresholdHours: null,
  dailyDoubleTimeHours: null,
  seventhConsecutiveDayRule: false,
  otMultiplier: 1.5,
  dtMultiplier: 2.0,
};

/**
 * State presets. Only states whose rules differ from the federal weekly-40
 * baseline get an entry; every other state resolves to FEDERAL_DEFAULT_RULES.
 * Keyed by USPS two-letter code. These are STARTING POINTS the tenant confirms
 * in settings — labor law changes and has industry carve-outs, so the office
 * can always override any field.
 */
export const STATE_OVERTIME_PRESETS: Record<string, OvertimePreset> = {
  CA: {
    label: "California",
    weeklyThresholdHours: 40,
    dailyThresholdHours: 8,
    dailyDoubleTimeHours: 12,
    seventhConsecutiveDayRule: true,
    otMultiplier: 1.5,
    dtMultiplier: 2.0,
    note: "Daily OT after 8h, double-time after 12h, plus 7th-consecutive-day rules.",
  },
  AK: {
    label: "Alaska",
    weeklyThresholdHours: 40,
    dailyThresholdHours: 8,
    dailyDoubleTimeHours: null,
    seventhConsecutiveDayRule: false,
    otMultiplier: 1.5,
    dtMultiplier: 2.0,
    note: "Daily OT after 8h (employers with 4+ employees). No double-time.",
  },
  CO: {
    label: "Colorado",
    weeklyThresholdHours: 40,
    dailyThresholdHours: 12,
    dailyDoubleTimeHours: null,
    seventhConsecutiveDayRule: false,
    otMultiplier: 1.5,
    dtMultiplier: 2.0,
    note: "OT after 12h/day OR 12 consecutive hours OR 40/week — whichever yields more. The consecutive-hours test isn't modeled; daily-12 is.",
  },
  NV: {
    label: "Nevada",
    weeklyThresholdHours: 40,
    dailyThresholdHours: 8,
    dailyDoubleTimeHours: null,
    seventhConsecutiveDayRule: false,
    otMultiplier: 1.5,
    dtMultiplier: 2.0,
    note: "Daily-8 OT applies ONLY to employees earning under 1.5× minimum wage. Turn the daily threshold off for higher earners.",
  },
  OR: {
    // Oregon's daily overtime is manufacturing-only; for a cleaning business
    // the weekly-40 federal baseline applies, so OR maps to the default but
    // carries a note so a manufacturing tenant knows to configure it.
    label: "Oregon",
    ...FEDERAL_DEFAULT_RULES,
    note: "Weekly-40 for most industries. Manufacturing has daily-10 OT — configure manually if applicable.",
  },
};

/** USPS code ⇆ name normalization so companies.state can be "IL" or "Illinois". */
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

/** Normalize a free-text state value to a USPS code, or null if unknown. */
export function normalizeStateCode(state?: string | null): string | null {
  if (!state) return null;
  const trimmed = state.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null;
}

/** The preset for a state (federal default when the state has no special rule). */
export function getPresetForState(state?: string | null): OvertimePreset {
  const code = normalizeStateCode(state);
  if (code && STATE_OVERTIME_PRESETS[code]) return STATE_OVERTIME_PRESETS[code];
  return {
    label: code ? `${code} (federal baseline)` : "Federal baseline",
    ...FEDERAL_DEFAULT_RULES,
  };
}

/**
 * A company row's OT-config columns (all nullable — added via ALTER). When
 * `ot_rules_source` is null the tenant hasn't been configured yet and the
 * caller should fall back to the state preset.
 */
export interface CompanyOvertimeColumns {
  state?: string | null;
  ot_rules_source?: string | null;
  ot_weekly_threshold_hours?: string | number | null;
  ot_daily_threshold_hours?: string | number | null;
  ot_daily_doubletime_hours?: string | number | null;
  ot_seventh_day_rule?: boolean | null;
  ot_multiplier?: string | number | null;
  ot_doubletime_multiplier?: string | number | null;
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the rules a company actually runs under:
 *   1. explicit per-tenant config columns (source = 'custom' or a state code), else
 *   2. the preset for companies.state, else
 *   3. the federal default.
 * Returns the rules plus a human label + the state preset, so the settings
 * UI can show "you're on California rules" and offer a reset-to-preset.
 */
export function resolveOvertimeRules(company: CompanyOvertimeColumns): {
  rules: OvertimeRules;
  source: string;
  statePreset: OvertimePreset;
} {
  const statePreset = getPresetForState(company.state);

  // Not yet configured → use the state preset (Qleno is compliant by default).
  if (!company.ot_rules_source) {
    return { rules: { ...statePreset }, source: `preset:${statePreset.label}`, statePreset };
  }

  // Configured → read the stored columns, defaulting any gap to the preset.
  const rules: OvertimeRules = {
    weeklyThresholdHours: numOrNull(company.ot_weekly_threshold_hours) ?? statePreset.weeklyThresholdHours,
    dailyThresholdHours: numOrNull(company.ot_daily_threshold_hours),
    dailyDoubleTimeHours: numOrNull(company.ot_daily_doubletime_hours),
    seventhConsecutiveDayRule: company.ot_seventh_day_rule ?? statePreset.seventhConsecutiveDayRule,
    otMultiplier: numOrNull(company.ot_multiplier) ?? 1.5,
    dtMultiplier: numOrNull(company.ot_doubletime_multiplier) ?? 2.0,
  };
  return { rules, source: company.ot_rules_source, statePreset };
}

export interface WeekOvertimeResult {
  /** Total hours worked in the week (job + between-jobs drive). */
  totalHours: number;
  /** Hours paid at straight time (already covered by commission). */
  regularHours: number;
  /** Hours at the OT multiplier (e.g. 1.5×). */
  otHours: number;
  /** Hours at the double-time multiplier (e.g. 2×). */
  dtHours: number;
}

/**
 * Compute the overtime breakdown for ONE workweek using the standard
 * no-pyramiding method (an hour counted as daily OT is not counted again as
 * weekly OT):
 *
 *   per day:  straight = min(dayHrs, dailyThreshold)
 *             ot(1.5×) = clamp(dayHrs − dailyThreshold) up to the DT threshold
 *             dt(2×)   = dayHrs over the DT threshold
 *   weekly:   any straight-time hours beyond the weekly threshold become 1.5×.
 *
 * When the rules have no daily threshold (federal / Illinois / most states),
 * every hour is "straight" per day and this degenerates exactly to
 * "hours over 40 in the week are 1.5×" — i.e. the plain weekly-40 rule.
 *
 * @param dailyHours hours worked each calendar day of the workweek. For the
 *   7th-day rule, pass them in worked order (the last nonzero entry is treated
 *   as the latest day worked).
 */
export function computeWeekOvertime(dailyHours: number[], rules: OvertimeRules): WeekOvertimeResult {
  const dailyT = rules.dailyThresholdHours ?? Infinity;
  const dtT = rules.dailyDoubleTimeHours ?? Infinity;

  let straightSum = 0;
  let otHours = 0;
  let dtHours = 0;

  const daysWorked = dailyHours.filter((h) => h > 0).length;
  // 7th-consecutive-day (California): every hour on the 7th worked day is
  // premium — first 8 at 1.5×, the rest at 2×. Identify the last worked day.
  const seventhDayActive = rules.seventhConsecutiveDayRule && daysWorked >= 7;
  let lastWorkedIdx = -1;
  if (seventhDayActive) {
    for (let i = dailyHours.length - 1; i >= 0; i--) {
      if (dailyHours[i] > 0) { lastWorkedIdx = i; break; }
    }
  }

  dailyHours.forEach((h, idx) => {
    if (h <= 0) return;
    if (seventhDayActive && idx === lastWorkedIdx) {
      // 7th day: first 8h @1.5×, remainder @2×. No straight-time hours.
      otHours += Math.min(h, 8);
      dtHours += Math.max(0, h - 8);
      return;
    }
    const dayStraight = Math.min(h, dailyT);
    const dayDt = Math.max(0, h - dtT);
    const dayOt = Math.max(0, Math.min(h, dtT) - dailyT);
    straightSum += dayStraight;
    otHours += dayOt;
    dtHours += dayDt;
  });

  // Weekly threshold applies to straight-time hours only (no pyramiding).
  const weeklyOt = Math.max(0, straightSum - rules.weeklyThresholdHours);
  otHours += weeklyOt;

  const totalHours = dailyHours.reduce((s, h) => s + Math.max(0, h), 0);
  const regularHours = round2(totalHours - otHours - dtHours);

  return {
    totalHours: round2(totalHours),
    regularHours: regularHours < 0 ? 0 : regularHours,
    otHours: round2(otHours),
    dtHours: round2(dtHours),
  };
}

/**
 * Premium dollars owed on top of commission for one workweek. For a
 * commission-paid (non-hourly) employee, straight time is already in the
 * commission, so we owe only the EXTRA over straight: (mult − 1) × rate per
 * premium hour. Mileage must already be excluded from `regularRate`.
 *
 * regularRate = workweek commission ÷ total hours worked that week.
 */
export function computeOvertimePremium(input: {
  otHours: number;
  dtHours: number;
  regularRate: number;
  rules: OvertimeRules;
}): number {
  const { otHours, dtHours, regularRate, rules } = input;
  if (regularRate <= 0) return 0;
  const otPremium = otHours * Math.max(0, rules.otMultiplier - 1) * regularRate;
  const dtPremium = dtHours * Math.max(0, rules.dtMultiplier - 1) * regularRate;
  return round2(otPremium + dtPremium);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
