/**
 * LMS Admin Audit — pure helpers (Phase 15, PR #16 of 16).
 *
 * The DB-touching aggregation lives in `routes/lms-admin-audit.ts`.
 * This module is pure so the unit tests can exercise the compliance
 * scoring + CSV row builder without spinning up Postgres.
 *
 * Compliance dimensions per learner:
 *   1. All quiz modules in QUIZ_MODULE_IDS have status='passed'.
 *   2. All signed docs in REQUIRED_PRE_FINAL_SIGNED_DOCS have an
 *      active signed_document row.
 *   3. The final mixed test (FINAL_MODULE_ID) has status='passed'.
 *   4. The comprehensive handbook has an active signed_document row.
 *   5. Zero open lms_pending_re_ack rows (annual cycles, force-resigns,
 *      material content changes).
 *
 * `overall` is the at-a-glance compliance state:
 *   - "complete"      — all five dimensions satisfied.
 *   - "needs_resign"  — has open pending re-acks (1-4 may still be ok).
 *   - "overdue"       — deadline_at has elapsed and 1-4 not all green.
 *   - "in_progress"   — anything else.
 */
import {
  QUIZ_MODULE_IDS,
  FINAL_MODULE_ID,
} from "@workspace/lms-curriculum";
import { REQUIRED_PRE_FINAL_SIGNED_DOCS } from "@workspace/db/schema";

export type ComplianceOverall =
  | "complete"
  | "needs_resign"
  | "overdue"
  | "in_progress";

export interface ComplianceFlags {
  modules_complete: boolean;
  docs_complete: boolean;
  final_passed: boolean;
  handbook_signed: boolean;
  pending_count: number;
  overall: ComplianceOverall;
}

export interface ComputeComplianceInput {
  passed_module_ids: string[];
  signed_document_types: string[];
  handbook_signed: boolean;
  pending_re_ack_count: number;
  deadline_at: Date | string | null;
  now?: Date;
}

const QUIZ_MODULE_SET = new Set<string>(QUIZ_MODULE_IDS);
const REQUIRED_DOC_SET = new Set<string>(
  REQUIRED_PRE_FINAL_SIGNED_DOCS as readonly string[],
);

export function computeCompliance(
  input: ComputeComplianceInput,
): ComplianceFlags {
  const passedSet = new Set(input.passed_module_ids);
  const signedSet = new Set(input.signed_document_types);

  const modulesComplete = [...QUIZ_MODULE_IDS].every((m) => passedSet.has(m));
  const docsComplete = [...REQUIRED_PRE_FINAL_SIGNED_DOCS].every((d) =>
    signedSet.has(d),
  );
  const finalPassed = passedSet.has(FINAL_MODULE_ID);
  const handbookSigned = input.handbook_signed;
  const pendingCount = Math.max(0, input.pending_re_ack_count | 0);

  let overall: ComplianceOverall;
  if (
    modulesComplete &&
    docsComplete &&
    finalPassed &&
    handbookSigned &&
    pendingCount === 0
  ) {
    overall = "complete";
  } else if (pendingCount > 0) {
    overall = "needs_resign";
  } else if (input.deadline_at) {
    const dl =
      input.deadline_at instanceof Date
        ? input.deadline_at
        : new Date(input.deadline_at);
    const now = input.now ?? new Date();
    if (!Number.isNaN(dl.getTime()) && dl.getTime() < now.getTime()) {
      overall = "overdue";
    } else {
      overall = "in_progress";
    }
  } else {
    overall = "in_progress";
  }

  return {
    modules_complete: modulesComplete,
    docs_complete: docsComplete,
    final_passed: finalPassed,
    handbook_signed: handbookSigned,
    pending_count: pendingCount,
    overall,
  };
}

export interface AuditCsvRowInput {
  user_id: number;
  full_name: string;
  email: string;
  role: string;
  hire_date: string | null;
  enrolled_at: Date | string | null;
  deadline_at: Date | string | null;
  completed_at: Date | string | null;
  last_activity_at: Date | string | null;
  compliance: ComplianceFlags;
  handbook_signed_at: Date | string | null;
  final_passed_at: Date | string | null;
}

export const AUDIT_CSV_HEADERS = [
  "user_id",
  "full_name",
  "email",
  "role",
  "hire_date",
  "enrolled_at",
  "deadline_at",
  "completed_at",
  "last_activity_at",
  "modules_complete",
  "docs_complete",
  "final_passed",
  "handbook_signed",
  "pending_count",
  "overall",
  "handbook_signed_at",
  "final_passed_at",
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) {
    s = v.toISOString();
  } else if (typeof v === "boolean" || typeof v === "number") {
    s = String(v);
  } else {
    s = String(v);
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toAuditCsvRow(row: AuditCsvRowInput): string {
  const cells = [
    row.user_id,
    row.full_name,
    row.email,
    row.role,
    row.hire_date,
    row.enrolled_at,
    row.deadline_at,
    row.completed_at,
    row.last_activity_at,
    row.compliance.modules_complete,
    row.compliance.docs_complete,
    row.compliance.final_passed,
    row.compliance.handbook_signed,
    row.compliance.pending_count,
    row.compliance.overall,
    row.handbook_signed_at,
    row.final_passed_at,
  ];
  return cells.map(csvEscape).join(",");
}

export function buildAuditCsv(rows: AuditCsvRowInput[]): string {
  const lines: string[] = [AUDIT_CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(toAuditCsvRow(r));
  }
  return lines.join("\n") + "\n";
}

export { QUIZ_MODULE_SET, REQUIRED_DOC_SET };
