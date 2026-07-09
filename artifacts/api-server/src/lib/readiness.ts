/**
 * App readiness flag (2026-06-24).
 *
 * The server binds the port and answers health checks immediately on boot;
 * the schema/data migration chain runs in the background AFTER listen (see
 * index.ts). Until that chain completes, the readiness gate in app.ts holds
 * every non-health /api route at HTTP 503 so a request can never read or write
 * partially-migrated schema — preserving the migrations-must-precede-dependent
 * -reads guarantee (the 2026-05-17 read/write-divergence fix) WITHOUT blocking
 * the port (which was the chronic cause of Railway deploy-healthcheck failures).
 *
 * Single boolean, flipped once. No external deps so both app.ts (reader) and
 * index.ts (writer) can import it without pulling in the server graph.
 */
let ready = false;

export function isAppReady(): boolean {
  return ready;
}

export function setAppReady(value = true): void {
  ready = value;
}
