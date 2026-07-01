// ─────────────────────────────────────────────────────────────────────────────
// {{services_breakdown}} — server-side renderer for the itemized booking table.
//
// WHY THIS EXISTS: offices used to type line items as literal text into the
// Booking Confirmation template, which goes stale the moment a booking differs
// (different sqft, different add-ons, a promo). This renders the booking's REAL
// line items (base service, add-ons, discounts, total) as an email-safe HTML
// table — inline CSS only, single <table>, no external stylesheet — so it
// survives Gmail/Outlook/Apple Mail stripping.
//
// Data source = buildJobLineItems() (the same composer invoices use), so the
// email and the invoice can never disagree. For test sends there's no booking,
// so SAMPLE_BREAKDOWN_ITEMS stands in.
// ─────────────────────────────────────────────────────────────────────────────
import { buildJobLineItems } from "./invoice-line-items.js";

export interface BreakdownItem {
  description: string;
  total: number; // negative = discount line
}

const MONEY_GREEN = "#0F6E56"; // discount color (brand mint, darkened for contrast)
const RULE = "#D3D1C7";

function money(n: number): string {
  return Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Render the line items as a single email-safe <table>. First row = base service
// (plain), subsequent positive rows = add-ons (prefixed +), negative rows =
// discounts (green, − prefix). The final bordered row is the summed total.
export function renderServicesBreakdown(items: BreakdownItem[], totalLabel = "First visit total"): string {
  if (!items || items.length === 0) return "";
  const total = items.reduce((s, it) => s + (Number(it.total) || 0), 0);
  const rows = items.map((it, i) => {
    const amt = Number(it.total) || 0;
    const isDiscount = amt < 0;
    const isBase = i === 0;
    const sign = isBase ? "" : isDiscount ? "−" : "+";
    const color = isDiscount ? `color:${MONEY_GREEN};` : "";
    return `<tr><td style="padding:8px;">${esc(it.description)}</td>` +
      `<td style="padding:8px;text-align:right;${color}">${sign}$${money(amt)}</td></tr>`;
  }).join("");
  const totalRow =
    `<tr style="border-top:1px solid ${RULE};">` +
    `<td style="padding:12px 8px 8px;font-weight:600;">${esc(totalLabel)}</td>` +
    `<td style="padding:12px 8px 8px;text-align:right;font-weight:600;">$${money(total)}</td></tr>`;
  return `<table cellpadding="8" cellspacing="0" style="width:100%;border-collapse:collapse;` +
    `font-family:Arial,Helvetica,sans-serif;font-size:14px;margin:8px 0;">${rows}${totalRow}</table>`;
}

// Stand-in line items for test sends + the editor's live preview (no real job).
export const SAMPLE_BREAKDOWN_ITEMS: BreakdownItem[] = [
  { description: "Deep Clean — 2,000 sqft", total: 608 },
  { description: "Oven cleaning", total: 50 },
  { description: "Inside fridge", total: 35 },
  { description: "Appliance bundle discount", total: -20 },
];

export const SAMPLE_SERVICES_BREAKDOWN_HTML = renderServicesBreakdown(SAMPLE_BREAKDOWN_ITEMS);

// Build the {{services_breakdown}} HTML for a real job from its locked pricing.
// Returns "" when the job has no line items so the tag renders empty rather than
// leaking a broken table. Non-throwing — a breakdown failure must never block a
// booking confirmation send.
export async function buildServicesBreakdownForJob(companyId: number, jobId: number): Promise<string> {
  try {
    const built = await buildJobLineItems(companyId, jobId);
    const items = (built?.lineItems ?? []).map((li) => ({ description: li.description, total: Number(li.total) || 0 }));
    return renderServicesBreakdown(items);
  } catch (err) {
    console.error("[services-breakdown] build failed for job", jobId, err);
    return "";
  }
}
