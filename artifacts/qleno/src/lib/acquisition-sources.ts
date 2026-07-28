// [leadsource-unify 2026-07-28] Single source of truth for the
// "How did you hear about us?" / lead-source vocabulary on the office side.
//
// The office configures this list in Settings → company page ("How did you hear
// about us?" Options), which is the `acquisition_sources` table (per company,
// slug + display name + is_active + display_order). Every office picker
// (quote-builder, new/edit lead, customer profile) and every label surface
// (dashboard "How they heard about us" card, referrals report, customer profile)
// must read from HERE so they can never drift from Settings again.
//
// Before this, the pickers hardcoded the old fixed 9-value `referral_source`
// enum (google / nextdoor / door_hanger / ...), which was almost entirely
// disjoint from the Settings list (google_ads / thumbtack / word_of_mouth / ...)
// — exactly the mismatch Maribel reported. The stored column is now TEXT, so it
// holds the real Settings slug.

import { useQuery } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export type AcquisitionSource = {
  id: number;
  slug: string;
  name: string;
  is_active: boolean;
  display_order: number;
};

// Fallback shown only if a tenant has NO configured sources yet (the authed GET
// returns []). Mirrors the public booking widget's defaults so a fresh tenant
// still gets a sane picker. Phes is seeded, so this is a safety net.
export const DEFAULT_ACQUISITION_SOURCES: Array<{ slug: string; name: string }> = [
  { slug: "google_ads", name: "Google Ads" },
  { slug: "google_business_profile", name: "Google Business Profile" },
  { slug: "thumbtack", name: "Thumbtack" },
  { slug: "yelp", name: "Yelp" },
  { slug: "facebook", name: "Facebook" },
  { slug: "instagram", name: "Instagram" },
  { slug: "referral", name: "Referral" },
  { slug: "word_of_mouth", name: "Word of Mouth" },
  { slug: "repeat_customer", name: "Repeat Customer" },
  { slug: "other", name: "Other" },
];

// Legacy display names for values collected under the old enum vocabulary, so
// historical leads/clients (google, client_referral, door_hanger, ...) still
// read as words rather than raw slugs after the switch to the Settings list.
const LEGACY_SOURCE_LABELS: Record<string, string> = {
  google: "Google",
  nextdoor: "Nextdoor",
  facebook: "Facebook",
  yelp: "Yelp",
  client_referral: "Friend or family",
  door_hanger: "Door hanger",
  yard_sign: "Yard sign",
  website: "Our website",
  other: "Other",
  // entry-channel style values that occasionally landed here historically
  existing_client: "Existing client",
};

/** Title-case a slug as a last-resort label ("word_of_mouth" -> "Word Of Mouth"). */
export function prettifySource(slug: string | null | undefined): string {
  if (!slug) return "";
  return String(slug)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Fetch the tenant's configured acquisition sources.
 * Pass includeInactive for the label resolver (so historical values that point
 * at a now-disabled source still resolve to their real display name).
 */
export function useAcquisitionSources(opts?: { includeInactive?: boolean }) {
  const includeInactive = !!opts?.includeInactive;
  return useQuery<AcquisitionSource[]>({
    queryKey: ["acquisition-sources", includeInactive],
    queryFn: async () => {
      const r = await fetch(
        `${API}/api/acquisition-sources${includeInactive ? "?include_inactive=true" : ""}`,
        // getAuthHeaders() returns {Authorization} | {}; cast to HeadersInit to
        // avoid the codebase-wide fetch-headers overload complaint.
        { headers: getAuthHeaders() as HeadersInit },
      );
      if (!r.ok) throw new Error("Failed to load acquisition sources");
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Active options for a <select> picker: the tenant's active sources, or the
 * defaults if none are configured yet. Callers append the current value as a
 * "(legacy)" option when it isn't in this list so old records stay editable.
 */
export function usePickerSources(): Array<{ slug: string; name: string }> {
  const { data } = useAcquisitionSources();
  if (data && data.length) return data.filter((s) => s.is_active).map((s) => ({ slug: s.slug, name: s.name }));
  return DEFAULT_ACQUISITION_SOURCES;
}

/**
 * Returns a label(slug) resolver: the tenant's configured display name first
 * (including inactive sources), then a legacy label, then a prettified slug.
 * Use this on every surface that DISPLAYS a stored referral_source.
 */
export function useSourceLabeler(): (slug: string | null | undefined) => string {
  const { data } = useAcquisitionSources({ includeInactive: true });
  const map = new Map((data ?? []).map((s) => [s.slug, s.name]));
  return (slug: string | null | undefined) => {
    if (!slug) return "";
    const key = String(slug);
    return map.get(key) ?? LEGACY_SOURCE_LABELS[key] ?? prettifySource(key);
  };
}
