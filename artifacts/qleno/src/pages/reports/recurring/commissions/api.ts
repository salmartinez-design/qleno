import { useCallback, useEffect, useState } from "react";
import { useBranch } from "@/contexts/branch-context";

// [ares-parity 2026-08-18] Data layer for the Ares Commissions tab.
//
// The reports-wide useReportData() is read-only; this screen also writes
// (approve, reject, payout), so it needs a POST path and a reload that other
// panels can trigger. Same conventions otherwise: bearer token from
// localStorage, /api prefix, branch_id appended from the navbar toggle.

const API_BASE = (import.meta as any).env?.BASE_URL?.replace(/\/$/, "") || "";
const token = () => (typeof window !== "undefined" ? localStorage.getItem("qleno_token") : null);

function withBranch(path: string, branchId: string | number) {
  if (branchId === "all") return path;
  return `${path}${path.includes("?") ? "&" : "?"}branch_id=${branchId}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await r.json().catch(() => null);
  if (!r.ok) {
    // Surface the server's own message — "cannot go from 'paid' to 'approved'"
    // is far more useful to an office user than a bare 400.
    throw new Error(payload?.message || payload?.error || `Request failed (${r.status})`);
  }
  return payload as T;
}

export const apiGet = <T,>(path: string) => request<T>("GET", path);
export const apiPost = <T,>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});

// Branch-aware GET with loading/error state and an explicit reload, so an
// action in one panel can refresh the others.
export function useCommissionData<T>(path: string | null): {
  data: T | null; loading: boolean; error: string | null; reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { activeBranchId } = useBranch();
  const full = path == null ? null : withBranch(path, activeBranchId);

  const load = useCallback(() => {
    if (full == null) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    apiGet<T>(full)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [full]);

  useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load };
}

// ── Response shapes ──────────────────────────────────────────────────────────

export interface CommissionRow {
  id: number;
  client_id: number | null;
  client_name: string | null;
  subscription_id: number | null;
  va_user_id: number;
  va_name: string | null;
  status: string;
  commission_type: string;
  client_type: string | null;
  cadence: string | null;
  base_amount: string;
  source_bonus_amount: string;
  specialty_bonus_amount: string;
  amount: string;
  specialty_service_type: string | null;
  revenue_amount: string | null;
  earned_date: string | null;
  first_cleaning_date: string | null;
  chargeback_until: string | null;
  chargeback_dispute_deadline: string | null;
  chargeback_date: string | null;
  service_agreement_verified: boolean;
  ineligibility_category: string | null;
  ineligibility_reason: string | null;
  reactivation_date: string | null;
  days_inactive: number | null;
  notes: string | null;
  approved_at: string | null;
  paid_date: string | null;
  payment_id: number | null;
  branch_id: number | null;
  created_at: string;
  is_overdue?: boolean;
  dispute_open?: boolean;
}

export interface Metrics {
  total_owed_to_vas: number;
  nextPayoutDate: string | null;
  pendingReview: { count: number; total: number };
  readyToPay: { count: number; total: number };
  paidThisMonth: { count: number; total: number };
  chargebackRisk: { count: number; total: number; expiring_60d: number };
  totalPayoutAmount: number;
  chargeback_pending_count: number;
  chargeback_confirmed_amount: number;
  unpriced_count: number;
  payoutByVA: Array<{
    id: number; name: string; subtotal: number; approvedCount: number;
    pendingTotal: number; pendingCommissionCount: number;
  }>;
  vaPerformance: Array<{
    id: number; name: string; totalClients: number; clientsThisMonth: number;
    revenueGenerated: number; commissionsPaid: number; commissionsApproved: number;
    commissionsPending: number; commissionsEarned: number;
    chargebackRate: number; avgClientLifespan: number;
  }>;
}

export interface PayoutPreview {
  va_user_id: number; va_name: string | null; payout_month: string;
  period_start: string; period_end: string; payout_date: string;
  lines: Array<{
    id: number; client_name: string | null; commission_type: string;
    cadence: string | null; amount: number; first_cleaning_date: string | null;
  }>;
  gross: number;
  chargebacks: Array<{ id: number; client_name: string | null; amount: number }>;
  chargeback_total: number;
  prior_carryover: number;
  net: number;
  carryover: number;
}

export interface PaymentRow {
  id: number; va_user_id: number; va_name: string | null;
  period_start: string; period_end: string; sales_period: string | null;
  gross_amount: string; chargeback_total: string; carryover_amount: string;
  total_amount: string; item_count: number; status: string;
  receipt_number: string | null; payment_method: string | null;
  notes: string | null; processed_at: string;
}

export interface RateCardResp {
  seeded: number;
  rates: Array<{
    id: number; client_type: string; cadence: string; amount: string;
    branch_id: number | null; effective_date: string; end_date: string | null;
  }>;
  unpriced: Array<{ client_type: string; cadence: string }>;
}

export interface StatementResp {
  summary: {
    total_earned: number; total_charged_back: number; net_earnings: number;
    total_paid_out: number; pending_amount: number; approved_amount: number;
    chargeback_exposure: number;
  };
  lines: CommissionRow[];
  ledger: Array<{
    id: number; entry_type: string; amount: string; description: string;
    related_period: string | null; created_at: string;
    // The statement route selects the whole ledger row, so the commission this
    // entry moved money for comes back with it. A chargeback entry needs it to
    // be tied back to the line it reverses.
    commission_id: number | null;
  }>;
  payouts: PaymentRow[];
}

// ── Vocabularies (verbatim from Ares) ────────────────────────────────────────

// CommissionPortal.tsx:234-244 — order matters, it is the dropdown order.
export const INELIGIBILITY_CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "returning_90_days",      label: "Returning Client — Active within 90 days (no new agreement)" },
  { value: "returning_no_agreement", label: "Returning Client (No New Agreement)" },
  { value: "missing_agreement",      label: "Missing Service Agreement" },
  { value: "cancelled_before_clean", label: "Client Cancelled Before First Clean" },
  { value: "duplicate",              label: "Duplicate Commission" },
  { value: "data_error",             label: "Data Entry Error" },
  { value: "client_initiated",       label: "Client Initiated Contact (Not VA-Sourced)" },
  { value: "previous_phes",          label: "Previously Used PHES Services" },
  { value: "other",                  label: "Other" },
];

// CommissionPortal.tsx:254-261
export const REJECTION_REASONS: Array<{ value: string; label: string }> = [
  { value: "missing_agreement",     label: "Missing service agreement" },
  { value: "duplicate_submission",  label: "Duplicate commission submission" },
  { value: "incorrect_information", label: "Incorrect client information" },
  { value: "client_cancelled",      label: "Client cancelled before first service" },
  { value: "not_recurring",         label: "Not a recurring service" },
  { value: "other",                 label: "Other" },
];

export const SPECIALTY_SERVICES = [
  "Deep Clean", "Move-In/Out", "Post-Renovation", "Seasonal", "Commercial Add-On", "Other",
];

export function ineligibilityLabel(category: string | null, freeText?: string | null): string {
  if (!category) return freeText || "No reason provided";
  const hit = INELIGIBILITY_CATEGORIES.find(c => c.value === category);
  return hit ? hit.label : (freeText || category);
}

// Commission-type sub-label under the client name in the queue.
// CommissionPortal.tsx:2265-2273.
export function commissionTypeLabel(row: CommissionRow): string | null {
  switch (row.commission_type) {
    case "specialty_bonus":      return `Specialty: ${row.specialty_service_type || "Service"}`;
    case "sourcing_bonus":       return "Commercial Sourcing Bonus";
    case "performance_bonus":    return "Performance Bonus";
    case "frequency_adjustment": {
      const v = Number(row.amount);
      return v > 0 ? `Frequency Upgrade +$${v.toFixed(2)}` : `Frequency Downgrade $${v.toFixed(2)}`;
    }
    case "base": return null;
    default: return row.commission_type || null;
  }
}

// ── Payout periods ───────────────────────────────────────────────────────────
// CommissionPortal.tsx:264-291 — 18 entries, i from -12 to +5. A payout in
// month M covers first cleans in M-1, paid on the last Friday of M.
export interface PayoutPeriod {
  value: string; label: string; payoutDate: Date;
  qualifyingLabel: string; qualifyingValue: string; isCurrent: boolean;
}

export function generatePayoutPeriods(now = new Date()): PayoutPeriod[] {
  const out: PayoutPeriod[] = [];
  for (let i = -12; i <= 5; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    while (last.getDay() !== 5) last.setDate(last.getDate() - 1);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const q = new Date(date.getFullYear(), date.getMonth() - 1, 1);
    out.push({
      value: `${y}-${m}`,
      label: `${date.toLocaleString("en-US", { month: "long", year: "numeric" })} (${last.toLocaleString("en-US", { month: "short", day: "numeric" })})`,
      payoutDate: last,
      qualifyingLabel: q.toLocaleString("en-US", { month: "short", year: "numeric" }),
      qualifyingValue: `${q.getFullYear()}-${String(q.getMonth() + 1).padStart(2, "0")}`,
      isCurrent: i === 0,
    });
  }
  return out;
}

export const PAYOUT_PERIODS = generatePayoutPeriods();

// Initials for the VA avatar circles. CommissionPortal.tsx:1651.
export const initials = (name: string) =>
  name.split(" ").map(p => p[0]).join("").toUpperCase().slice(0, 2);
