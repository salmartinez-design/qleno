// Human label for a job/quote's estimated duration, shown on customer-facing
// surfaces (quote email, booking confirmation): "~3.5 hours". Rounds to the
// nearest half hour; returns "" for missing/zero values so callers can hide
// the row entirely instead of rendering a blank.
export function estTimeLabel(hours: number | string | null | undefined): string {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return "";
  const r = Math.round(h * 2) / 2;
  const n = Number.isInteger(r) ? String(r) : r.toFixed(1);
  return `~${n} ${r === 1 ? "hour" : "hours"}`;
}
