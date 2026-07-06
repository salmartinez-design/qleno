// [message-preview] Reusable "what the client receives" preview, dropped under
// any communication editor in the app (Customer Messages, Follow-Up Sequences,
// Customer Survey, estimate/lead templates …). Fills merge tags with sample
// data and renders the branded email frame or an SMS bubble with a segment
// count. Takes a plain body string with {{tags}} (or simple HTML for email).

// Sample customer used across every preview so the office sees realistic output.
export const PREVIEW_SAMPLE: Record<string, string> = {
  first_name: "Maria", client_name: "Maria Gomez", company_name: "Phes",
  company_phone: "(708) 974-5517", phone: "(708) 974-5517", company_email: "info@phes.io",
  service_type: "Standard Cleaning", scope: "Standard Cleaning",
  date: "Friday, June 27, 2026", appointment_date: "Friday, June 27, 2026",
  time: "9:00 AM", appointment_time: "9:00 AM",
  arrival_window: "9:00 AM – 12:00 PM", appointment_window: "9:00 AM – 12:00 PM",
  service_address: "123 Oak St, Oak Lawn, IL 60453", tech_name: "Ana",
  appointment_link: "https://phes.io/appt", review_link: "https://phes.io/review",
  quote_link: "https://phes.io/quote", estimate_link: "https://phes.io/estimate",
  survey_link: "https://phes.io/survey",
  // Quote Follow-Up tags — on a real send these fill from the attached quote
  // (buildQuoteMergeVars). Sample mirrors that table so the preview shows the
  // itemized quote + total instead of a blank "Quote details" block.
  quote_number: "1042", quote_total: "658.00",
  line_items:
    '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0;">' +
    '<tr><td style="padding:6px 0;color:#1A1917;">Deep Clean</td><td style="padding:6px 0;text-align:right;color:#1A1917;">$608.00</td></tr>' +
    '<tr><td style="padding:6px 0;color:#1A1917;">Oven cleaning</td><td style="padding:6px 0;text-align:right;color:#1A1917;">$50.00</td></tr>' +
    '<tr><td style="padding:8px 0 0;font-weight:700;border-top:1px solid #E5E2DC;">Total</td><td style="padding:8px 0 0;text-align:right;font-weight:700;border-top:1px solid #E5E2DC;">$658.00</td></tr>' +
    '</table>',
};

export function fillSample(s: string, sample: Record<string, string> = PREVIEW_SAMPLE): string {
  return (s || "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => sample[String(k).trim()] ?? "");
}

const isHtml = (s: string) => /<[a-z][\s\S]*>/i.test(s || "");

export function MessagePreview({
  channel, subject, body, companyName = "Phes", logoUrl,
}: {
  channel: "email" | "sms";
  subject?: string;
  body: string;
  companyName?: string;
  logoUrl?: string | null;
}) {
  const filledBody = fillSample(body);
  const label = (
    <p style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
      Preview — what the client sees
    </p>
  );

  if (channel === "email") {
    return (
      <div>
        {label}
        <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ background: "#fff", borderBottom: "1px solid #E5E2DC", padding: "12px 16px" }}>
            {logoUrl
              ? <img src={logoUrl} alt={companyName} style={{ height: 30, width: "auto", display: "block" }} />
              : <span style={{ display: "inline-block", background: "var(--brand,#00C9A0)", color: "#fff", fontWeight: 800, fontSize: 14, padding: "5px 12px", borderRadius: 6 }}>{companyName}</span>}
          </div>
          {subject && <div style={{ padding: "10px 16px 0", fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{fillSample(subject)}</div>}
          {isHtml(filledBody)
            ? <div style={{ padding: "12px 16px", fontSize: 13, color: "#374151", lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: filledBody }} />
            : <div style={{ padding: "12px 16px", fontSize: 13, color: "#374151", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{filledBody || "Nothing yet"}</div>}
        </div>
      </div>
    );
  }

  const text = filledBody.trim();
  return (
    <div>
      {label}
      <div style={{ background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: 14 }}>
        <div style={{ maxWidth: 320, background: "#E1F5EE", border: "1px solid #9FE1CB", borderRadius: "16px 16px 16px 4px", padding: "10px 13px", fontSize: 13, lineHeight: 1.45, color: "#1A1917", whiteSpace: "pre-wrap" }}>
          {text || "Nothing yet"}
          <div style={{ fontSize: 10, color: "#0F6E56", marginTop: 5 }}>{text.length} chars · {Math.max(1, Math.ceil(text.length / 160))} SMS</div>
        </div>
      </div>
    </div>
  );
}
