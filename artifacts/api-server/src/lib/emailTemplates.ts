import { BranchConfig } from "./branchRouter";

export interface ConfirmationEmailParams {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  serviceType: string;
  scheduledDate: string;
  arrivalWindow: string;
  serviceAddress: string;
  addressLine2?: string | null;
  preferredContactMethod: string;
  basePrice: number;
  addons: Array<{ name: string; amount: number }>;
  bundleDiscount: number;
  firstVisitTotal: number;
  specialNotes?: string | null;
  sqft?: number | null;
  branchConfig: BranchConfig;
  jobId?: number | null;
  clientId?: number | null;
  stripeCustomerId?: string | null;
  stripePaymentMethodId?: string | null;
  bedrooms?: number | null;
  fullBathrooms?: number | null;
  halfBathrooms?: number | null;
  floors?: number | null;
  people?: number | null;
  pets?: number | null;
  cleanlinessRating?: number | null;
  acquisitionSource?: string | null;
}

export interface ReminderEmailParams {
  firstName: string;
  email: string;
  serviceType: string;
  scheduledDate: string;
  arrivalWindow: string;
  serviceAddress: string;
  addressLine2?: string | null;
  branchConfig: BranchConfig;
  hoursAhead: 72 | 24;
}

function detectServiceType(serviceType: string): "deep" | "standard" | "moveinout" | "recurring" {
  const s = (serviceType || "").toLowerCase();
  if (s.includes("move") || s.includes("move in") || s.includes("move out")) return "moveinout";
  if (s.includes("recurring")) return "recurring";
  if (s.includes("deep")) return "deep";
  return "standard";
}

function getSubjectLine(serviceType: string): string {
  const t = detectServiceType(serviceType);
  if (t === "deep") return "Your Phes Deep Clean is Confirmed";
  if (t === "moveinout") return "Your Phes Move In/Out Clean is Confirmed";
  if (t === "recurring") return "Your Phes Recurring Service is Confirmed";
  return "Your Phes Cleaning is Confirmed";
}

const BASE = `font-family:'Plus Jakarta Sans',Arial,sans-serif`;
const NAVY = "#0A0E1A";
const MINT = "#00C9A0";
const DARK = "#1A1917";
const MID = "#6B6860";
const BORDER = "#E5E2DC";
const BG = "#F7F6F3";

function emailWrapper(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BG};">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
  <div style="background:#fff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
    <div style="background:${NAVY};padding:20px 28px;display:flex;align-items:center;gap:12px;">
      <div style="width:10px;height:10px;border-radius:50%;background:${MINT};flex-shrink:0;"></div>
      <span style="color:#fff;font-size:20px;font-weight:800;${BASE};letter-spacing:-0.01em;">Phes</span>
      <span style="color:#9DA3B0;font-size:12px;font-weight:500;${BASE};margin-left:4px;">Residential &amp; Commercial Cleaning</span>
    </div>
    <div style="padding:28px;${BASE};color:${DARK};font-size:14px;line-height:1.6;">
      ${body}
    </div>
  </div>
</div>
</body></html>`;
}

function serviceDetailsTable(p: ConfirmationEmailParams): string {
  const addonRows = p.addons.map(a => `
  <tr>
    <td style="padding:8px 0;color:${DARK};border-bottom:1px solid #F0EEEB;">${a.name}</td>
    <td style="padding:8px 0;color:${DARK};text-align:right;border-bottom:1px solid #F0EEEB;">+$${a.amount.toFixed(2)}</td>
  </tr>`).join("");
  const discountRow = p.bundleDiscount > 0 ? `
  <tr>
    <td style="padding:8px 0;color:#2D6A4F;border-bottom:1px solid #F0EEEB;">Appliance Bundle Discount</td>
    <td style="padding:8px 0;color:#2D6A4F;text-align:right;border-bottom:1px solid #F0EEEB;">-$${p.bundleDiscount.toFixed(2)}</td>
  </tr>` : "";
  return `
<div style="background:${BG};border:1px solid ${BORDER};border-radius:8px;padding:16px 20px;margin-bottom:24px;">
  <p style="margin:0 0 12px;font-weight:700;color:${DARK};font-size:14px;">Your Service Summary</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr>
      <td style="padding:8px 0;color:${DARK};border-bottom:1px solid #E5E2DC;">${p.serviceType}${p.sqft ? ` &mdash; ${p.sqft.toLocaleString()} sqft` : ""}</td>
      <td style="padding:8px 0;color:${DARK};text-align:right;border-bottom:1px solid #E5E2DC;">$${p.basePrice.toFixed(2)}</td>
    </tr>
    ${addonRows}
    ${discountRow}
    <tr>
      <td style="padding:10px 0;color:${DARK};font-weight:700;font-size:15px;"><strong>Total</strong></td>
      <td style="padding:10px 0;color:${DARK};text-align:right;font-weight:700;font-size:15px;"><strong>$${p.firstVisitTotal.toFixed(2)}</strong></td>
    </tr>
  </table>
  <p style="margin:10px 0 0;font-size:12px;color:${MID};">Your card on file will be charged upon job completion.</p>
</div>`;
}

function appointmentBlock(p: {
  serviceType: string;
  scheduledDate: string;
  arrivalWindow: string;
  serviceAddress: string;
  addressLine2?: string | null;
  preferredContactMethod: string;
}): string {
  const fullAddress = p.addressLine2 ? `${p.serviceAddress}, ${p.addressLine2}` : p.serviceAddress;
  const rows: Array<[string, string]> = [
    ["Service", p.serviceType],
    ["Date", p.scheduledDate],
    ["Arrival Window", p.arrivalWindow],
    ["Address", fullAddress],
  ];
  const rowsHtml = rows.map(([label, value]) => `
    <tr>
      <td style="padding:8px 12px;color:${MID};white-space:nowrap;vertical-align:top;width:130px;">${label}</td>
      <td style="padding:8px 12px;color:${DARK};font-weight:600;">${value}</td>
    </tr>`).join("");
  return `
<div style="background:#EBF7F4;border:1px solid #B2E8DB;border-radius:8px;overflow:hidden;margin-bottom:24px;">
  <div style="background:${MINT};padding:10px 16px;">
    <span style="color:#fff;font-weight:700;font-size:13px;letter-spacing:0.03em;">BOOKING CONFIRMED</span>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    ${rowsHtml}
  </table>
</div>`;
}

function whatNextSection(preferredContactMethod: string): string {
  return `
<div style="margin-bottom:24px;">
  <h3 style="color:${DARK};font-size:15px;font-weight:700;margin:0 0 12px;border-bottom:1px solid ${BORDER};padding-bottom:8px;">What Happens Next</h3>
  <ol style="margin:0;padding-left:20px;color:${DARK};">
    <li style="margin-bottom:8px;">Our office will contact you via <strong>${preferredContactMethod}</strong> to lock in your exact arrival time within your window</li>
    <li style="margin-bottom:8px;">You will receive SMS &amp; email reminders <strong>72 hours</strong> and <strong>24 hours</strong> before your appointment</li>
    <li style="margin-bottom:8px;">Your technician arrives during your selected window — please ensure the home is accessible</li>
    <li style="margin-bottom:0;">After your clean, we will follow up to make sure you are 100% satisfied</li>
  </ol>
</div>`;
}

function homeAccessSection(): string {
  return `
<div style="margin-bottom:24px;">
  <h3 style="color:${DARK};font-size:15px;font-weight:700;margin:0 0 12px;border-bottom:1px solid ${BORDER};padding-bottom:8px;">Home Access</h3>
  <p style="margin:0 0 6px;"><strong>1. Be Home</strong> &mdash; Wait for our arrival during your window.</p>
  <p style="margin:0 0 6px;"><strong>2. Keys / Entry Code</strong> &mdash; Leave a spare key or provide an electronic code.</p>
  <p style="margin:0;"><strong>3. Secure Lockbox</strong> &mdash; We can provide a master lockbox for $50. It must be returned upon termination of service or a $75 fee applies.</p>
</div>`;
}

function serviceSpecificNotes(kind: "deep" | "standard" | "moveinout" | "recurring"): string {
  if (kind === "deep") {
    return `
<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
  <p style="margin:0 0 6px;font-weight:700;color:#92400E;font-size:14px;">Deep Clean — What to Expect</p>
  <p style="margin:0 0 6px;color:${DARK};font-size:13px;">A deep clean is more thorough than a standard service and covers areas often skipped in routine cleanings (inside appliances if selected, baseboards, light fixtures, etc.).</p>
  <p style="margin:0 0 6px;color:${DARK};font-size:13px;"><strong>Please have your home decluttered</strong> before we arrive — cleared countertops, sinks, and floors let our team focus on the actual cleaning rather than tidying.</p>
  <p style="margin:0;color:${DARK};font-size:13px;"><strong>Condition note:</strong> If the home's condition significantly differs from what was selected, we will contact you before proceeding with any additional charges. Extra time beyond the estimate is billed at $65/hr per cleaner.</p>
</div>`;
  }
  if (kind === "moveinout") {
    return `
<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
  <p style="margin:0 0 6px;font-weight:700;color:#92400E;font-size:14px;">Move In / Out Clean — What to Expect</p>
  <p style="margin:0 0 6px;color:${DARK};font-size:13px;">The property should be empty of furniture and personal belongings. We will work around any items left behind, but cleaning quality around those items cannot be guaranteed and no adjustment will be issued for those areas.</p>
  <p style="margin:0;color:${DARK};font-size:13px;"><strong>Utilities must be active</strong> — running water, electricity, and sufficient lighting are required. If utilities are off, we reserve the right to cancel and the full fee still applies.</p>
</div>`;
  }
  if (kind === "standard") {
    return `
<div style="background:${BG};border:1px solid ${BORDER};border-radius:8px;padding:14px 18px;margin-bottom:24px;">
  <p style="margin:0 0 6px;font-weight:700;color:${DARK};font-size:14px;">Preparing Your Home</p>
  <p style="margin:0;color:${DARK};font-size:13px;">Please have personal items, toys, and clothing cleared away so our team can focus on cleaning surfaces. We cannot clean countertops or sinks full of dishes. Cluttered surfaces may be skipped at our discretion.</p>
</div>`;
  }
  return "";
}

function condensedPolicies(): string {
  return `
<div style="margin-bottom:24px;">
  <h3 style="color:${DARK};font-size:15px;font-weight:700;margin:0 0 12px;border-bottom:1px solid ${BORDER};padding-bottom:8px;">Policies &amp; Terms</h3>

  <p style="margin:0 0 4px;font-weight:700;font-size:13px;color:${DARK};">Cancellation &amp; Rescheduling</p>
  <p style="margin:0 0 10px;font-size:13px;color:${MID};">We require <strong>48 business hours</strong> notice (Sundays excluded). Monday appointments: notify us by Friday 6 PM CT. Tuesday appointments: by Saturday 12 PM CT. Late cancellations and no-shows are charged in full. Each appointment allows <strong>one reschedule</strong> — additional reschedule requests are treated as late cancellations. Our team waits up to 20 minutes for access; if we cannot enter, the appointment is forfeited and billed.</p>

  <p style="margin:0 0 4px;font-weight:700;font-size:13px;color:${DARK};">Our 24-Hour Guarantee</p>
  <p style="margin:0 0 10px;font-size:13px;color:${MID};">If we miss a spot, contact us within 24 hours and we will return to re-clean it at no cost. As a labor-based service we do not offer refunds — re-cleaning is our remedy for any quality concern.</p>

  <p style="margin:0 0 4px;font-weight:700;font-size:13px;color:${DARK};">Safety &amp; Exclusions</p>
  <p style="margin:0 0 10px;font-size:13px;color:${MID};">We do not clean biohazards (waste, blood, infestations). Cleaners may adjust climate controls to a safe working temperature. Our liability for any damage is limited to the cost of your service. We do not perform bed-making, laundry, dishwashing, wall spot-cleaning, or move heavy furniture.</p>

  <p style="margin:0 0 4px;font-weight:700;font-size:13px;color:${DARK};">Non-Solicitation</p>
  <p style="margin:0;font-size:13px;color:${MID};">Our staff are our greatest asset. By using our services you agree not to solicit, hire, or contract any Phes team member privately. Any breach results in immediate termination of your service agreement.</p>
</div>`;
}

function recurringUpsellSection(branchConfig: BranchConfig): string {
  return `
<div style="background:#EBF7F4;border:1px solid #B2E8DB;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
  <p style="margin:0 0 6px;font-weight:700;color:${NAVY};font-size:15px;">Interested in Regular Cleaning?</p>
  <p style="margin:0 0 10px;color:${DARK};font-size:13px;">Recurring clients get <strong>discounted rates</strong>, a consistent team, and priority scheduling. Weekly, biweekly, and monthly plans are available.</p>
  <p style="margin:0;color:${DARK};font-size:13px;">Call or text <strong>${branchConfig.clientPhoneFormatted}</strong> or reply to this email to set up a recurring plan.</p>
</div>`;
}

export function buildClientConfirmationEmail(p: ConfirmationEmailParams): { subject: string; html: string } {
  const subject = getSubjectLine(p.serviceType);
  const kind = detectServiceType(p.serviceType);
  const showUpsell = kind === "deep" || kind === "standard";

  const body = `
    <p style="margin:0 0 20px;font-size:16px;color:${DARK};">Hi <strong>${p.firstName}</strong>, thank you for choosing Phes!</p>
    <p style="margin:0 0 24px;color:${MID};">Your cleaning is confirmed. Here are your details and everything you need to know before we arrive.</p>

    ${appointmentBlock({
      serviceType: p.serviceType,
      scheduledDate: p.scheduledDate,
      arrivalWindow: p.arrivalWindow,
      serviceAddress: p.serviceAddress,
      addressLine2: p.addressLine2,
      preferredContactMethod: p.preferredContactMethod,
    })}

    ${serviceDetailsTable(p)}

    ${whatNextSection(p.preferredContactMethod)}

    ${homeAccessSection()}

    ${serviceSpecificNotes(kind)}

    ${showUpsell ? recurringUpsellSection(p.branchConfig) : ""}

    ${condensedPolicies()}

    <p style="margin:16px 0 4px;color:${MID};font-size:12px;">
      Review our full <a href="https://phes.io/terms" style="color:${MINT};">Terms and Conditions</a> and <a href="https://phes.io/privacy-policy" style="color:${MINT};">Privacy Policy</a>.
    </p>

    <div style="border-top:1px solid ${BORDER};margin-top:24px;padding-top:16px;color:${MID};font-size:13px;">
      <strong style="color:${DARK};">Phes</strong><br>
      ${p.branchConfig.clientPhoneFormatted}<br>
      <a href="mailto:${p.branchConfig.officeEmail}" style="color:${MINT};">${p.branchConfig.officeEmail}</a><br>
      <a href="https://phes.io" style="color:${MINT};">phes.io</a>
    </div>`;

  return { subject, html: emailWrapper(body) };
}

export function buildOfficeNotificationEmail(p: ConfirmationEmailParams): { subject: string; html: string } {
  const dateLabel = p.scheduledDate;
  const subject = `New Booking — ${p.firstName} ${p.lastName} — ${p.serviceType} — ${dateLabel}`;
  const fullAddress = p.addressLine2 ? `${p.serviceAddress}, ${p.addressLine2}` : p.serviceAddress;
  const addonsStr = p.addons.length > 0 ? p.addons.map(a => a.name).join(", ") : "None";
  const bundleStr = p.bundleDiscount > 0 ? `$${p.bundleDiscount.toFixed(2)}` : "N/A";

  const cleanlinessLabel = (r?: number | null) => {
    if (!r) return "N/A";
    if (r === 1) return "1 — Very Clean";
    if (r === 2) return "2 — Moderately Clean";
    if (r === 3) return "3 — Very Dirty";
    return String(r);
  };

  const body = `
    <h2 style="color:${DARK};font-size:18px;font-weight:800;margin:0 0 20px;">NEW ONLINE BOOKING</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:8px 0;color:${MID};width:180px;border-bottom:1px solid #F0EEEB;">Client</td><td style="padding:8px 0;font-weight:700;border-bottom:1px solid #F0EEEB;">${p.firstName} ${p.lastName}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Phone</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.phone}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Email</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.email}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Branch</td><td style="padding:8px 0;font-weight:700;border-bottom:1px solid #F0EEEB;">${p.branchConfig.branch.replace("_", " ").toUpperCase()}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Service</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.serviceType}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Date</td><td style="padding:8px 0;font-weight:700;border-bottom:1px solid #F0EEEB;">${dateLabel}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Arrival Window</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.arrivalWindow}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Address</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${fullAddress}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Square Footage</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.sqft ? `${p.sqft.toLocaleString()} sqft` : "N/A"}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Bedrooms</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.bedrooms ?? "N/A"}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Bathrooms</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.fullBathrooms ?? 0} full / ${p.halfBathrooms ?? 0} half</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Floors</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.floors ?? "N/A"}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">People in Household</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.people ?? "N/A"}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Pets</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.pets ?? 0}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Cleanliness Rating</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${cleanlinessLabel(p.cleanlinessRating)}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Add-ons</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${addonsStr}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Bundle Discount</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${bundleStr}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Special Notes</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.specialNotes || "None"}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Preferred Contact</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.preferredContactMethod}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">How They Found Us</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.acquisitionSource || "N/A"}</td></tr>
      <tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">First Visit Total</td><td style="padding:8px 0;font-weight:700;border-bottom:1px solid #F0EEEB;">$${p.firstVisitTotal.toFixed(2)}</td></tr>
      ${p.stripeCustomerId ? `<tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Stripe Customer ID</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.stripeCustomerId}</td></tr>` : ""}
      ${p.stripePaymentMethodId ? `<tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Stripe Payment Method</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">${p.stripePaymentMethodId}</td></tr>` : ""}
      ${p.clientId ? `<tr><td style="padding:8px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Client ID</td><td style="padding:8px 0;border-bottom:1px solid #F0EEEB;">#${p.clientId}</td></tr>` : ""}
      ${p.jobId ? `<tr><td style="padding:8px 0;color:${MID};">Job ID</td><td style="padding:8px 0;">#${p.jobId}</td></tr>` : ""}
    </table>`;

  return { subject, html: emailWrapper(body) };
}

export function buildReminderEmail(p: ReminderEmailParams): { subject: string; html: string } {
  const is72 = p.hoursAhead === 72;
  const subject = is72
    ? "Reminder: Your Phes Cleaning is in 3 Days"
    : "Reminder: Your Phes Cleaning is Tomorrow";
  const fullAddress = p.addressLine2 ? `${p.serviceAddress}, ${p.addressLine2}` : p.serviceAddress;

  const bodyIntro = is72
    ? `<p style="margin:0 0 16px;color:${DARK};">Hi <strong>${p.firstName}</strong>, this is a friendly reminder that your Phes cleaning is coming up in <strong>3 days</strong>.</p>
       <p style="margin:0 0 16px;color:${MID};">If you need to reschedule, please contact us at least 48 business hours before your appointment. Remember — Sundays do not count toward this window.</p>
       <p style="margin:0 0 8px;color:${MID};">Monday appointments: notify us by Friday before 6:00 PM CT.</p>
       <p style="margin:0 0 16px;color:${MID};">Tuesday appointments: notify us by Saturday before 12:00 PM CT.</p>`
    : `<p style="margin:0 0 16px;color:${DARK};">Hi <strong>${p.firstName}</strong>, your Phes cleaning is <strong>tomorrow!</strong></p>
       <p style="margin:0 0 16px;color:${MID};">Your team will arrive during your <strong>${p.arrivalWindow}</strong> window. Please ensure your home is accessible and all utilities are active — running water, electricity, and sufficient lighting must be available.</p>
       <div style="margin-bottom:16px;">
         <strong style="color:${DARK};">Home Access Reminder:</strong>
         <ul style="margin:8px 0;padding-left:20px;color:${MID};">
           <li>Be home during your arrival window, OR</li>
           <li>Ensure your key, entry code, or lockbox is ready for our team</li>
         </ul>
       </div>
       <p style="margin:0 0 16px;color:${MID};">Questions or need to make a change? Contact us immediately — please note our 48-hour cancellation policy applies.</p>`;

  const body = `
    <div style="background:#EBF7F4;border:1px solid #B2E8DB;border-radius:8px;overflow:hidden;margin-bottom:24px;">
      <div style="background:${MINT};padding:10px 16px;">
        <span style="color:#fff;font-weight:700;font-size:13px;letter-spacing:0.03em;">APPOINTMENT REMINDER</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 12px;color:${MID};white-space:nowrap;width:130px;">Service</td><td style="padding:8px 12px;color:${DARK};font-weight:600;">${p.serviceType}</td></tr>
        <tr><td style="padding:8px 12px;color:${MID};">Date</td><td style="padding:8px 12px;color:${DARK};font-weight:600;">${p.scheduledDate}</td></tr>
        <tr><td style="padding:8px 12px;color:${MID};">Arrival Window</td><td style="padding:8px 12px;color:${DARK};font-weight:600;">${p.arrivalWindow}</td></tr>
        <tr><td style="padding:8px 12px;color:${MID};">Address</td><td style="padding:8px 12px;color:${DARK};font-weight:600;">${fullAddress}</td></tr>
      </table>
    </div>
    ${bodyIntro}
    <p style="margin:0 0 4px;color:${MID};">Contact us: <strong>${p.branchConfig.clientPhoneFormatted}</strong> or <a href="mailto:${p.branchConfig.officeEmail}" style="color:${MINT};">${p.branchConfig.officeEmail}</a></p>
    <div style="border-top:1px solid ${BORDER};margin-top:24px;padding-top:16px;color:${MID};font-size:13px;">
      <strong style="color:${DARK};">Phes</strong><br>
      ${p.branchConfig.clientPhoneFormatted}<br>
      <a href="mailto:${p.branchConfig.officeEmail}" style="color:${MINT};">${p.branchConfig.officeEmail}</a>
    </div>`;

  return { subject, html: emailWrapper(body) };
}
