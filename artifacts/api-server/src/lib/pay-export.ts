/**
 * Cutover 1E — Generic pay-summary CSV export.
 *
 * Provider-neutral. No vendor name appears in this file, in the column
 * headers, or in the file naming convention. If a downstream consumer
 * needs vendor-specific formatting, that lives in a thin adapter
 * selected by a per-company setting — NOT here.
 *
 * Column set is the minimum the spec calls for: employee identifier,
 * regular hours, overtime hours, regular pay, overtime pay,
 * adjustments total, gross. Money in dollars-and-cents (e.g. "836.94"),
 * never floats. Hours in decimal (e.g. "38.25").
 */

export type PayExportRow = {
  employee_identifier: string;
  employee_first_name: string;
  employee_last_name: string;
  regular_hours: number;
  overtime_hours: number;
  regular_pay_cents: number;
  overtime_pay_cents: number;
  adjustments_cents: number;
  gross_cents: number;
};

export type PayExportInput = {
  period_start: string; // YYYY-MM-DD
  period_end: string; // YYYY-MM-DD
  rows: PayExportRow[];
};

const COLUMNS = [
  "employee_identifier",
  "employee_first_name",
  "employee_last_name",
  "period_start",
  "period_end",
  "regular_hours",
  "overtime_hours",
  "regular_pay",
  "overtime_pay",
  "adjustments_total",
  "gross_total",
] as const;

export function buildPayExportCsv(input: PayExportInput): string {
  const lines: string[] = [];
  lines.push(COLUMNS.join(","));
  for (const r of input.rows) {
    lines.push(
      [
        csvField(r.employee_identifier),
        csvField(r.employee_first_name),
        csvField(r.employee_last_name),
        input.period_start,
        input.period_end,
        r.regular_hours.toFixed(2),
        r.overtime_hours.toFixed(2),
        centsToDollarString(r.regular_pay_cents),
        centsToDollarString(r.overtime_pay_cents),
        centsToDollarString(r.adjustments_cents),
        centsToDollarString(r.gross_cents),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Shape a single period-pay record (the engine's money breakdown) into the
 * provider-neutral export row. PURE + DB-free — the ONLY place the engine's
 * base/tips/overtime/bonus/adjustments buckets map to the export's
 * regular/OT/adjustments columns, so the export, the on-screen detail, and the
 * published snapshot can never silently diverge. `gross_cents` is the literal
 * sum of the three money columns.
 *
 * Mapping:
 *   - regular_pay   = base (commission/hourly base pay from computePayLines)
 *   - overtime_pay  = overtime additional_pay (this comp model carries OT as a
 *                     dollar entry, not an hours decomposition, so
 *                     overtime_hours is 0)
 *   - adjustments   = tips + bonus + everything else (sick/holiday/mileage/etc.)
 *   - gross         = base + tips + overtime + bonus + adjustments
 */
export function snapshotToExportRow(s: {
  user_id: number; first_name: string; last_name: string;
  base: number; hours: number; tips: number; overtime: number; bonus: number; adjustments: number; gross: number;
}): PayExportRow {
  const c = (n: number) => Math.round((Number(n) || 0) * 100);
  return {
    employee_identifier: String(s.user_id),
    employee_first_name: s.first_name || "",
    employee_last_name: s.last_name || "",
    regular_hours: Number(s.hours) || 0,
    overtime_hours: 0,
    regular_pay_cents: c(s.base),
    overtime_pay_cents: c(s.overtime),
    adjustments_cents: c(s.tips) + c(s.bonus) + c(s.adjustments),
    gross_cents: c(s.gross),
  };
}

export function buildPayExportFilename(start: string, end: string): string {
  // Provider-neutral. No vendor string. Stable across tenants.
  return `pay-summary-${start}-${end}.csv`;
}

function csvField(value: string): string {
  if (value == null) return "";
  const s = String(value);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function centsToDollarString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

export { COLUMNS as PAY_EXPORT_COLUMNS };
