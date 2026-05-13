/**
 * LMS Annual re-acknowledgment — pure helpers (Phase 14, PR #15 of 16).
 *
 * The DB-touching plumbing lives in `routes/lms-annual-ack.ts`. This
 * module is pure so the unit tests can exercise input validation,
 * cycle-year math, and trigger-reason allowlists without spinning up
 * a database.
 *
 * Concepts:
 *   - "Cycle" — one row in `lms_annual_ack_cycles` per tenant per
 *     calendar year. Default deadline is Dec 31 23:59 UTC of that
 *     year. Default required_documents is ANNUAL_DOCUMENT_TYPES
 *     (currently just handbook).
 *   - "Sweep" — when a cycle is opened, every employee in the tenant
 *     who has an active signed handbook (or other annual doc) gets a
 *     row in `lms_pending_re_ack` so the dashboard tile lights up on
 *     their next login and POST /api/lms/handbook/sign records the
 *     refreshed signature.
 *   - "Force resign" — admin manually pushes one user into a re-ack
 *     flow outside the annual cycle (e.g. a corrected policy that
 *     only affects a single person).
 */
import {
  ANNUAL_DOCUMENT_TYPES,
  KNOWN_SIGNED_DOCUMENT_TYPES,
} from "@workspace/db/schema";

export const ANNUAL_DOCUMENT_TYPE_SET = new Set<string>(
  ANNUAL_DOCUMENT_TYPES as readonly string[],
);

const KNOWN_DOCUMENT_TYPE_SET = new Set<string>(
  KNOWN_SIGNED_DOCUMENT_TYPES as readonly string[],
);

export const TRIGGER_REASONS = [
  "annual_cycle",
  "material_content_change",
  "admin_force_resign",
  "policy_correction",
] as const;

export type TriggerReason = (typeof TRIGGER_REASONS)[number];

const TRIGGER_REASON_SET = new Set<string>(TRIGGER_REASONS);

const MIN_CYCLE_YEAR = 2025;
const MAX_CYCLE_YEAR = 2100;

/**
 * Default deadline for a cycle: Dec 31 23:59:59.999 UTC of `cycleYear`.
 * UTC by design so the deadline is comparable across tenants regardless
 * of their local time zone. The admin can override per-cycle.
 */
export function defaultCycleDeadline(cycleYear: number): Date {
  return new Date(Date.UTC(cycleYear, 11, 31, 23, 59, 59, 999));
}

export function isValidCycleYear(input: unknown): input is number {
  return (
    typeof input === "number" &&
    Number.isInteger(input) &&
    input >= MIN_CYCLE_YEAR &&
    input <= MAX_CYCLE_YEAR
  );
}

export function isValidTriggerReason(input: unknown): input is TriggerReason {
  return typeof input === "string" && TRIGGER_REASON_SET.has(input);
}

export function isValidLocale(input: unknown): input is "en" | "es" {
  return input === "en" || input === "es";
}

export interface RequiredDocumentsValidation {
  ok: boolean;
  documents: string[];
  invalid: string[];
  notAnnual: string[];
}

/**
 * Validate a caller-supplied required_documents array. Returns
 * the canonical list (deduped, in input order). Documents must be
 * (a) in KNOWN_SIGNED_DOCUMENT_TYPES (otherwise `invalid`), and
 * (b) in ANNUAL_DOCUMENT_TYPES (otherwise `notAnnual`). Empty input
 * defaults to ANNUAL_DOCUMENT_TYPES so callers can POST `{}` and get
 * the right thing.
 */
export function validateRequiredDocuments(
  input: unknown,
): RequiredDocumentsValidation {
  if (input === undefined || input === null) {
    return {
      ok: true,
      documents: [...ANNUAL_DOCUMENT_TYPES],
      invalid: [],
      notAnnual: [],
    };
  }
  if (!Array.isArray(input)) {
    return { ok: false, documents: [], invalid: [], notAnnual: [] };
  }
  if (input.length === 0) {
    return {
      ok: true,
      documents: [...ANNUAL_DOCUMENT_TYPES],
      invalid: [],
      notAnnual: [],
    };
  }
  const seen = new Set<string>();
  const documents: string[] = [];
  const invalid: string[] = [];
  const notAnnual: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") {
      invalid.push(String(raw));
      continue;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!KNOWN_DOCUMENT_TYPE_SET.has(raw)) {
      invalid.push(raw);
      continue;
    }
    if (!ANNUAL_DOCUMENT_TYPE_SET.has(raw)) {
      notAnnual.push(raw);
      continue;
    }
    documents.push(raw);
  }
  return {
    ok: invalid.length === 0 && notAnnual.length === 0 && documents.length > 0,
    documents,
    invalid,
    notAnnual,
  };
}

/**
 * Parse and validate an ISO timestamp from caller input. Returns null
 * on invalid input. Empty / undefined returns null too — callers
 * decide whether to substitute a default.
 */
export function parseDeadlineInput(input: unknown): Date | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Pure: given an array of pending-re-ack rows + the cycle window,
 * compute summary counts. Used by the admin status endpoint and the
 * audit dashboard.
 */
export interface PendingSummaryInput {
  acknowledged_at: Date | string | null;
  defer_until: Date | string | null;
  triggered_at: Date | string;
}

export interface PendingSummary {
  total: number;
  acknowledged: number;
  pending: number;
  deferred: number;
}

export function summarizePendingReAcks(
  rows: PendingSummaryInput[],
  now: Date = new Date(),
): PendingSummary {
  const summary: PendingSummary = {
    total: rows.length,
    acknowledged: 0,
    pending: 0,
    deferred: 0,
  };
  const nowMs = now.getTime();
  for (const r of rows) {
    if (r.acknowledged_at !== null && r.acknowledged_at !== undefined) {
      summary.acknowledged += 1;
      continue;
    }
    if (r.defer_until !== null && r.defer_until !== undefined) {
      const def = r.defer_until instanceof Date
        ? r.defer_until
        : new Date(r.defer_until);
      if (!Number.isNaN(def.getTime()) && def.getTime() > nowMs) {
        summary.deferred += 1;
        continue;
      }
    }
    summary.pending += 1;
  }
  return summary;
}
