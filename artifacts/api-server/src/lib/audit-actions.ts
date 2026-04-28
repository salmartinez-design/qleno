/**
 * AI.15a single source of truth for audit_log.action string values.
 *
 * `audit_log.action` (and `app_audit_log.action`) is an unstructured TEXT
 * column, not a pg_enum, so any string is technically valid. This module
 * exists to prevent typo drift across routes. Always import the constant.
 * Do not write the action value as a string literal at the callsite.
 *
 * Existing values already in production (do not rename them; historical
 * rows reference these strings):
 *   CREATE, UPDATE, DELETE, CREATE_EMPLOYEE, DELETE_EMPLOYEE
 *
 * AI.15a additions are below the divider.
 */

export const AUDIT_ACTIONS = {
  // ── Existing ────────────────────────────────────────────────────────────
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  DELETE: "DELETE",
  CREATE_EMPLOYEE: "CREATE_EMPLOYEE",
  DELETE_EMPLOYEE: "DELETE_EMPLOYEE",

  // ── AI.15a additions ────────────────────────────────────────────────────
  /** A job's primary technician was changed via the dispatch popover. */
  TECH_REASSIGNED: "TECH_REASSIGNED",
  /** A job or client address was edited via the dispatch popover. */
  ADDRESS_CHANGED: "ADDRESS_CHANGED",
  /** A per technician commission override was set or cleared. */
  COMMISSION_OVERRIDDEN: "COMMISSION_OVERRIDDEN",
  /** Commission was recomputed via recalcJobCommissions(). */
  COMMISSION_RECALC: "COMMISSION_RECALC",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
