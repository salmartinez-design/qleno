/**
 * [referral-vocabulary 2026-07-23] One place that knows what a
 * "How did you hear about us?" answer means.
 *
 * There were two half-vocabularies before this file, and they disagreed:
 *
 *   - `public.ts` had REFERRAL_MAP, used on the CLIENTS write path. It fell
 *     back to "other" for anything unrecognized, so nothing was ever lost —
 *     but it only knew nine aliases.
 *   - `leads.ts` had a bare `IN (...)` list of the nine enum slugs, used to
 *     backfill `leads.referral_source` from the widget's jsonb. Anything not
 *     matching a slug EXACTLY was skipped and left NULL.
 *
 * The widget stores the human-readable NAME, not the slug — "Google Ads",
 * "Repeat Customer", "Referral". None of those are enum slugs, so the strict
 * list silently discarded 11 of the 17 real answers Phes had collected, and
 * the dashboard's referral card would have read almost entirely "unknown".
 *
 * So: one map, every alias we have actually seen in production plus the
 * obvious near-misses, and one normalizer both call sites use. The rule is
 * "never drop an answer" — an unrecognized string lands on `other`, which is
 * honest (someone answered, we couldn't bucket it) rather than NULL, which
 * reads as "never asked".
 *
 * The KEYS are lowercased/trimmed input. The VALUES are the `referral_source`
 * Postgres enum. Adding a new enum value means an `ALTER TYPE` — adding a new
 * alias here does not, so prefer aliases.
 */

/** The `referral_source` Postgres enum, in full. Nothing else is a legal value. */
export const REFERRAL_SOURCES = [
  "google",
  "nextdoor",
  "facebook",
  "yelp",
  "client_referral",
  "door_hanger",
  "yard_sign",
  "website",
  "other",
] as const;

export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

const ALIASES: Record<string, ReferralSource> = {
  // Search / paid search. The widget writes the display name, hence "google ads".
  google: "google",
  "google ads": "google",
  "google search": "google",
  "google local services": "google",
  "google local": "google",
  "google maps": "google",
  search: "google",
  bing: "google",

  // Social.
  facebook: "facebook",
  fb: "facebook",
  "facebook ads": "facebook",
  instagram: "facebook",
  "social media": "facebook",
  nextdoor: "nextdoor",
  yelp: "yelp",

  // Word of mouth — the free channel, and the one Sal most wants to see.
  client_referral: "client_referral",
  "client referral": "client_referral",
  referral: "client_referral",
  "friend/family": "client_referral",
  "friend / family": "client_referral",
  "friend or family": "client_referral",
  "word of mouth": "client_referral",
  "repeat customer": "client_referral",
  "repeat client": "client_referral",
  repeat: "client_referral",
  realtor: "client_referral",

  // Print / physical.
  door_hanger: "door_hanger",
  "door hanger": "door_hanger",
  flyer: "door_hanger",
  mailer: "door_hanger",
  yard_sign: "yard_sign",
  "yard sign": "yard_sign",

  // Our own site.
  website: "website",
  web: "website",
  "our website": "website",

  other: "other",
};

/**
 * Map any free-text answer onto the enum.
 *
 * Returns null ONLY for a genuinely empty answer — "not asked" and "answered
 * something we don't recognize" are different facts and must not collapse into
 * the same bucket. Unrecognized non-empty answers become `other`.
 */
export function normalizeReferralSource(value: string | null | undefined): ReferralSource | null {
  const v = String(value ?? "").toLowerCase().trim();
  if (!v) return null;
  return ALIASES[v] ?? "other";
}

/** Every alias key, for building a SQL CASE/mapping without duplicating it. */
export function referralAliasPairs(): Array<[string, ReferralSource]> {
  return Object.entries(ALIASES) as Array<[string, ReferralSource]>;
}
