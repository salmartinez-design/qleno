/**
 * Cutover 1D — Server-side mirror of the late-detection constants
 * declared in artifacts/qleno/src/lib/job-status.ts.
 *
 * These constants drive both the visual chip on the dispatch board
 * (frontend) and the "late arrivals today" count on the office ops
 * surface (server). They MUST stay in sync. If the frontend value
 * moves, mirror it here; if these move, mirror them in
 * artifacts/qleno/src/lib/job-status.ts.
 *
 * Per CLAUDE.md (lifecycle hard rule, 2026-04-29):
 *   LATE_THRESHOLD_MINUTES = 20
 *   NO_SHOW_WAIT_MINUTES   = 20
 * Multi-tenant future → tenant_settings.late_threshold_minutes /
 *                       no_show_wait_minutes.
 */
export const LATE_THRESHOLD_MINUTES = 20;
export const NO_SHOW_WAIT_MINUTES = 20;
