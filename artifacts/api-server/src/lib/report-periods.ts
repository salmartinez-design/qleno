// Shared reporting period resolver for time-bucketed report endpoints
// (efficiency now; scorecard later). All dates are tz-naive YYYY-MM-DD strings
// to match the `date`-typed entry_date columns. UTC-based math keeps the
// day boundaries stable regardless of server timezone.

export type ReportPeriod = "rolling_90d" | "month" | "quarter" | "year" | "custom";

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
const isYmd = (s: any): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export interface ResolvedWindow { from: string; to: string; period: string; label: string; }

// period: rolling_90d (default) | month | quarter | year | custom.
// opts.anchor anchors month/quarter/year (default today); opts.from/to for custom.
export function resolveWindow(period: string, opts: { anchor?: any; from?: any; to?: any } = {}): ResolvedWindow {
  const anchor = isYmd(opts.anchor) ? opts.anchor : ymd(new Date());
  const [y, m] = anchor.split("-").map(Number);

  switch (period) {
    case "month": {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const mm = String(m).padStart(2, "0");
      return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}`, period: "month", label: `${y}-${mm}` };
    }
    case "quarter": {
      const q = Math.floor((m - 1) / 3);
      const startM = q * 3 + 1, endM = startM + 2;
      const lastDay = new Date(Date.UTC(y, endM, 0)).getUTCDate();
      return {
        from: `${y}-${String(startM).padStart(2, "0")}-01`,
        to: `${y}-${String(endM).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
        period: "quarter", label: `${y}-Q${q + 1}`,
      };
    }
    case "year":
      return { from: `${y}-01-01`, to: `${y}-12-31`, period: "year", label: `${y}` };
    case "custom": {
      const from = isYmd(opts.from) ? opts.from : anchor;
      const to = isYmd(opts.to) ? opts.to : anchor;
      return { from, to, period: "custom", label: `${from}..${to}` };
    }
    case "rolling_90d":
    default: {
      const toD = new Date(`${anchor}T00:00:00Z`);
      const fromD = new Date(toD);
      fromD.setUTCDate(fromD.getUTCDate() - 89); // 90-day inclusive window
      return { from: ymd(fromD), to: anchor, period: "rolling_90d", label: "Last 90 days" };
    }
  }
}
