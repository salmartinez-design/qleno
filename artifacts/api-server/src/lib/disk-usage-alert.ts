import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [disk-alert 2026-06-19] Early-warning for the Postgres volume.
//
// Context: the 365-day recurring horizon (since trimmed to 90, see
// recurring-jobs.ts) materialized a far-future job backlog that filled the
// production Postgres volume to 98% and caused a boot outage. There was no
// warning before the cliff. This cron is that warning: a daily check that
// logs the database size and raises a WARN + in-app notification once usage
// crosses a configurable threshold (default ~72%), well before the volume
// fills.
//
// Capacity can't be read from inside Postgres (Railway's Postgres data lives
// on a separate service's volume), so the percentage path needs the volume
// size supplied via env. Two modes:
//   - DB_VOLUME_LIMIT_BYTES set  → percentage mode: WARN at
//     used / limit >= DB_ALERT_THRESHOLD_PCT (default 0.72).
//   - DB_VOLUME_LIMIT_BYTES unset → absolute mode: WARN when the database
//     size exceeds DB_ALERT_ABS_BYTES (default 768 MiB) — a sane pre-cliff
//     number so the alert still fires out of the box.
// The absolute database size is logged every run either way, so the trend is
// always visible even before the env is configured.

const DEFAULT_ALERT_THRESHOLD_PCT = 0.72;
const DEFAULT_ALERT_ABS_BYTES = 768 * 1024 * 1024; // 768 MiB
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function num(envVal: string | undefined): number | null {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function thresholdPct(): number {
  const p = num(process.env.DB_ALERT_THRESHOLD_PCT);
  return p != null && p < 1 ? p : DEFAULT_ALERT_THRESHOLD_PCT;
}

export type DiskUsageResult = {
  usedBytes: number;
  limitBytes: number | null;
  pct: number | null;
  over: boolean;
  mode: "percentage" | "absolute";
};

const fmtGiB = (b: number) => (b / 1024 ** 3).toFixed(2);
const fmtMiB = (b: number) => (b / 1024 ** 2).toFixed(0);

export async function checkDiskUsageOnce(): Promise<DiskUsageResult> {
  const sizeRes = await db.execute(
    sql`SELECT pg_database_size(current_database()) AS bytes`
  );
  const usedBytes = Number((sizeRes.rows[0] as any)?.bytes ?? 0);

  const limitBytes = num(process.env.DB_VOLUME_LIMIT_BYTES);
  const mode: "percentage" | "absolute" = limitBytes != null ? "percentage" : "absolute";

  let pct: number | null = null;
  let over = false;
  if (limitBytes != null) {
    pct = usedBytes / limitBytes;
    over = pct >= thresholdPct();
  } else {
    const absLimit = num(process.env.DB_ALERT_ABS_BYTES) ?? DEFAULT_ALERT_ABS_BYTES;
    over = usedBytes >= absLimit;
  }

  const headline =
    mode === "percentage"
      ? `${((pct ?? 0) * 100).toFixed(1)}% (${fmtGiB(usedBytes)}/${fmtGiB(limitBytes!)} GiB)`
      : `${fmtGiB(usedBytes)} GiB used (no DB_VOLUME_LIMIT_BYTES set — absolute-threshold mode)`;

  if (!over) {
    console.log(`[disk-alert] OK: Postgres volume ${headline}.`);
    return { usedBytes, limitBytes, pct, over, mode };
  }

  // Over threshold — gather the largest tables so the WARN is actionable.
  let topTables = "";
  try {
    const t = await db.execute(sql`
      SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 5
    `);
    topTables = (t.rows as any[])
      .map((r) => `${r.name}=${fmtMiB(Number(r.bytes))}MB`)
      .join(", ");
  } catch (e) {
    console.error("[disk-alert] top-table lookup failed:", e);
  }

  console.warn(
    `[disk-alert] WARNING: Postgres volume ${headline} — over threshold. ` +
      `Top tables: ${topTables}. ` +
      `Reclaim space: GET /api/dispatch/storage-audit then ` +
      `POST /api/dispatch/prune-far-future {"confirm":true}.`
  );

  // Surface in-app for the office, deduped to once per 24h per company so the
  // daily cron doesn't pile up notifications. Mirrors the job_unassigned
  // pattern in recurring-jobs.ts.
  const pctLabel = mode === "percentage" ? `${((pct ?? 0) * 100).toFixed(1)}% used` : `${fmtGiB(usedBytes)} GiB used`;
  const title = `Storage warning — ${pctLabel}`;
  const body =
    mode === "percentage"
      ? `Database volume is at ${((pct ?? 0) * 100).toFixed(1)}% (${fmtGiB(usedBytes)}/${fmtGiB(limitBytes!)} GiB). Prune far-future recurring jobs to reclaim space before the cliff.`
      : `Database is at ${fmtGiB(usedBytes)} GiB and past the alert threshold. Prune far-future recurring jobs to reclaim space.`;
  try {
    await db.execute(sql`
      INSERT INTO notifications (company_id, type, title, body, link, meta)
      SELECT co.id, 'disk_warning', ${title}, ${body}, ${"/dispatch"},
             ${JSON.stringify({ used_bytes: usedBytes, limit_bytes: limitBytes, pct, mode })}::jsonb
      FROM companies co
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.company_id = co.id
          AND n.type = 'disk_warning'
          AND n.created_at > now() - interval '24 hours'
      )
    `);
  } catch (e) {
    console.error("[disk-alert] notification insert failed:", e);
  }

  return { usedBytes, limitBytes, pct, over, mode };
}

// Daily disk-usage check. Fires once ~60s after boot (so a volume already
// near the cliff is flagged immediately on deploy) then every 24h.
export function startDiskUsageAlertCron() {
  const tick = () =>
    void checkDiskUsageOnce().catch((e) =>
      console.error("[disk-alert] check failed:", e?.message || e)
    );
  setTimeout(tick, 60_000);
  setInterval(tick, ONE_DAY_MS);
  console.log("[disk-alert] Daily Postgres volume check scheduled");
}
