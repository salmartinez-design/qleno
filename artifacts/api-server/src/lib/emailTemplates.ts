import { BranchConfig } from "./branchRouter";
import { appBaseUrl } from "./app-url.js";

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
  isReturningClient?: boolean;
  zoneName?: string | null;
  zoneColor?: string | null;
  availableTechs?: Array<{ name: string }> | null;
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
  const logoUrl = `${appBaseUrl()}/api/uploads/logos/phes-logo.jpeg`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BG};">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
  <div style="background:#fff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
    <div style="background:${NAVY};padding:20px 28px;">
      <table cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;">
          <img src="${logoUrl}" alt="Phes" width="48" height="48" style="display:block;width:48px;height:48px;object-fit:contain;border-radius:6px;" />
        </td>
        <td style="vertical-align:middle;padding-left:12px;">
          <span style="display:block;color:#fff;font-size:18px;font-weight:800;${BASE};letter-spacing:-0.01em;line-height:1.2;">Phes</span>
          <span style="display:block;color:#9DA3B0;font-size:12px;font-weight:500;${BASE};margin-top:2px;">Residential &amp; Commercial Cleaning</span>
        </td>
      </tr></table>
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
    <td style="padding:8px 0;color:${DARK};text-align:right;white-space:nowrap;border-bottom:1px solid #F0EEEB;">+$${a.amount.toFixed(2)}</td>
  </tr>`).join("");
  const discountRow = p.bundleDiscount > 0 ? `
  <tr>
    <td style="padding:8px 0;color:#2D6A4F;border-bottom:1px solid #F0EEEB;">Appliance Bundle Discount</td>
    <td style="padding:8px 0;color:#2D6A4F;text-align:right;white-space:nowrap;border-bottom:1px solid #F0EEEB;">-$${p.bundleDiscount.toFixed(2)}</td>
  </tr>` : "";
  return `
<div style="background:${BG};border:1px solid ${BORDER};border-radius:8px;padding:16px 20px;margin-bottom:24px;">
  <p style="margin:0 0 12px;font-weight:700;color:${DARK};font-size:14px;">Your Service Summary</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr>
      <td style="padding:8px 0;color:${DARK};border-bottom:1px solid #E5E2DC;">${p.serviceType}${p.sqft ? ` (${p.sqft.toLocaleString()} sqft)` : ""}</td>
      <td style="padding:8px 0;color:${DARK};text-align:right;white-space:nowrap;border-bottom:1px solid #E5E2DC;">$${p.basePrice.toFixed(2)}</td>
    </tr>
    ${addonRows}
    ${discountRow}
    <tr>
      <td style="padding:10px 0;color:${DARK};font-weight:700;font-size:15px;"><strong>Total</strong></td>
      <td style="padding:10px 0;color:${DARK};text-align:right;white-space:nowrap;font-weight:700;font-size:15px;"><strong>$${p.firstVisitTotal.toFixed(2)}</strong></td>
    </tr>
  </table>
  <p style="margin:10px 0 0;font-size:12px;color:${MID};">Your card on file will be charged on the day of service.</p>
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
    <li style="margin-bottom:8px;">Your technician will text you when they are on their way</li>
    <li style="margin-bottom:0;">After your clean, we will follow up to make sure you are 100% satisfied</li>
  </ol>
</div>`;
}


function serviceSpecificNotes(kind: "deep" | "standard" | "moveinout" | "recurring"): string {
  if (kind === "deep") {
    return `
<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
  <p style="margin:0 0 6px;font-weight:700;color:#92400E;font-size:14px;">Deep Clean: What to Expect</p>
  <p style="margin:0 0 6px;color:${DARK};font-size:13px;">A deep clean is more thorough than a standard service and covers areas often skipped in routine cleanings (inside appliances if selected, baseboards, light fixtures, etc.).</p>
  <p style="margin:0 0 6px;color:${DARK};font-size:13px;"><strong>Please have your home decluttered</strong> before we arrive — cleared countertops, sinks, and floors let our team focus on the actual cleaning rather than tidying.</p>
  <p style="margin:0;color:${DARK};font-size:13px;"><strong>Condition note:</strong> If the home's condition significantly differs from what was selected, we will contact you before proceeding with any additional charges. Extra time beyond the estimate is billed at $65/hr per cleaner.</p>
</div>`;
  }
  if (kind === "moveinout") {
    return `
<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
  <p style="margin:0 0 6px;font-weight:700;color:#92400E;font-size:14px;">Move In / Out Clean: What to Expect</p>
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
  <p style="margin:0 0 10px;font-size:13px;color:${MID};">We require <strong>48 business hours</strong> notice for all cancellations and reschedules (Sundays excluded). Monday appointments: notify us by Friday 6 PM CT. Tuesday appointments: by Saturday 12 PM CT. Late cancellations and no-shows are charged in full. Each appointment allows <strong>one reschedule — provided the 48-hour notice window is met</strong>. Rescheduling with less than 48 hours notice is treated as a late cancellation regardless. Additional reschedule requests beyond the first are also treated as late cancellations. Our team waits up to 20 minutes for access; if we cannot enter, the appointment is forfeited and billed.</p>

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
  <p style="margin:0 0 4px;font-weight:800;color:${NAVY};font-size:16px;">Save 15% on your next cleaning</p>
  <p style="margin:0 0 12px;color:${MID};font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">For new recurring clients only</p>
  <p style="margin:0 0 10px;color:${DARK};font-size:13px;">Set up a recurring plan after your first clean and get <strong>15% off your second service</strong>. Most clients who start with a deep clean switch to biweekly maintenance. Your home stays at this level for less effort and less cost each visit.</p>
  <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;">
    <tr><td style="padding:3px 8px 3px 0;color:${MINT};font-size:16px;vertical-align:top;">&#10003;</td><td style="padding:3px 0;font-size:13px;color:${DARK};">Same team every visit. They learn your home.</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:${MINT};font-size:16px;vertical-align:top;">&#10003;</td><td style="padding:3px 0;font-size:13px;color:${DARK};">Priority scheduling. Your slot is held weekly or biweekly.</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:${MINT};font-size:16px;vertical-align:top;">&#10003;</td><td style="padding:3px 0;font-size:13px;color:${DARK};">Lower per-visit rate than one-time bookings.</td></tr>
  </table>
  <p style="margin:0;color:${DARK};font-size:13px;">Call or text <strong>${branchConfig.clientPhoneFormatted}</strong> or reply to this email — mention this offer and we will apply the 15% to your second visit when you set up your plan.</p>
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
  const subject = p.zoneName
    ? `New Booking | ${p.zoneName} | ${p.firstName} ${p.lastName} - ${p.serviceType} | ${dateLabel}`
    : `New Booking - ${p.firstName} ${p.lastName} - ${p.serviceType} - ${dateLabel}`;

  const fullAddress = p.addressLine2 ? `${p.serviceAddress}, ${p.addressLine2}` : p.serviceAddress;

  const cleanlinessLabel = (r?: number | null) => {
    if (!r) return "N/A";
    if (r === 1) return "Very Clean";
    if (r === 2) return "Moderately Clean";
    if (r === 3) return "Very Dirty";
    return String(r);
  };

  const clientBadge = p.isReturningClient === true
    ? `<span style="display:inline-block;background:#EAF7F3;color:#0A7C63;border:1px solid #B2E8DB;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;letter-spacing:0.05em;margin-left:8px;vertical-align:middle;">RETURNING</span>`
    : p.isReturningClient === false
      ? `<span style="display:inline-block;background:#FEF3E2;color:#B26B00;border:1px solid #FDE68A;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;letter-spacing:0.05em;margin-left:8px;vertical-align:middle;">NEW CLIENT</span>`
      : "";

  const zoneDot = p.zoneColor
    ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.zoneColor};margin-right:5px;vertical-align:middle;"></span>`
    : "";
  const zoneDisplay = p.zoneName ? `${zoneDot}<strong>${p.zoneName}</strong>` : "Unknown";

  const techsSection = p.availableTechs !== undefined && p.availableTechs !== null
    ? (p.availableTechs.length > 0
        ? `<div style="background:#F0FBF7;border:1px solid #B2E8DB;border-radius:8px;padding:12px 16px;margin-bottom:20px;">
            <p style="margin:0 0 4px;font-weight:700;font-size:12px;color:${DARK};letter-spacing:0.04em;text-transform:uppercase;">Available This Window</p>
            <p style="margin:0;font-size:13px;color:${DARK};">${p.availableTechs.map(t => t.name).join(", ")}</p>
          </div>`
        : `<div style="background:${BG};border:1px solid ${BORDER};border-radius:8px;padding:12px 16px;margin-bottom:20px;">
            <p style="margin:0;font-size:13px;color:${MID};">No available techs found for this date. Check the dispatch board.</p>
          </div>`)
    : "";

  const body = `
    <div style="background:${NAVY};border-radius:8px;padding:18px 22px;margin-bottom:22px;">
      <p style="margin:0 0 4px;color:${MINT};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">New Online Booking</p>
      <p style="margin:0 0 10px;color:#fff;font-size:18px;font-weight:800;line-height:1.2;">${p.firstName} ${p.lastName}${clientBadge}</p>
      <table cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="color:#9DA3B0;font-size:13px;padding-right:18px;white-space:nowrap;padding-bottom:4px;">${p.serviceType}</td>
          <td style="color:#9DA3B0;font-size:13px;padding-right:18px;white-space:nowrap;padding-bottom:4px;">${dateLabel}</td>
          <td style="color:#9DA3B0;font-size:13px;padding-right:18px;white-space:nowrap;padding-bottom:4px;">${p.arrivalWindow}</td>
        </tr>
        <tr>
          <td colspan="3" style="color:${MINT};font-size:16px;font-weight:800;white-space:nowrap;">$${p.firstVisitTotal.toFixed(2)}<span style="color:#9DA3B0;font-size:12px;font-weight:400;margin-left:10px;">${p.branchConfig.branch.replace("_", " ").toUpperCase()} branch</span></td>
        </tr>
      </table>
    </div>

    <p style="margin:0 0 6px;font-weight:700;font-size:13px;color:${DARK};">Contact</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:22px;">
      <tr><td style="padding:6px 0;color:${MID};border-bottom:1px solid #F0EEEB;width:140px;">Phone</td><td style="padding:6px 0;border-bottom:1px solid #F0EEEB;">${p.phone}</td></tr>
      <tr><td style="padding:6px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Email</td><td style="padding:6px 0;border-bottom:1px solid #F0EEEB;"><a href="mailto:${p.email}" style="color:${MINT};">${p.email}</a></td></tr>
      <tr><td style="padding:6px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Contact Via</td><td style="padding:6px 0;border-bottom:1px solid #F0EEEB;">${p.preferredContactMethod}</td></tr>
      ${p.acquisitionSource ? `<tr><td style="padding:6px 0;color:${MID};">Source</td><td style="padding:6px 0;">${p.acquisitionSource}</td></tr>` : ""}
    </table>

    <p style="margin:0 0 6px;font-weight:700;font-size:13px;color:${DARK};">Property</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:22px;">
      <tr><td style="padding:6px 0;color:${MID};border-bottom:1px solid #F0EEEB;width:140px;">Address</td><td style="padding:6px 0;border-bottom:1px solid #F0EEEB;">${fullAddress}</td></tr>
      <tr><td style="padding:6px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Zone</td><td style="padding:6px 0;border-bottom:1px solid #F0EEEB;">${zoneDisplay}</td></tr>
      <tr><td style="padding:6px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Sqft</td><td style="padding:6px 0;border-bottom:1px solid #F0EEEB;">${p.sqft ? `${p.sqft.toLocaleString()} sqft` : "N/A"}</td></tr>
      <tr><td style="padding:6px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Beds / Baths</td><td style="padding:6px 0;border-bottom:1px solid #F0EEEB;">${p.bedrooms ?? "N/A"} bed / ${p.fullBathrooms ?? 0} full, ${p.halfBathrooms ?? 0} half</td></tr>
      <tr><td style="padding:6px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Cleanliness</td><td style="padding:6px 0;border-bottom:1px solid #F0EEEB;">${cleanlinessLabel(p.cleanlinessRating)}</td></tr>
      <tr><td style="padding:6px 0;color:${MID};">Pets</td><td style="padding:6px 0;">${p.pets ?? 0}</td></tr>
    </table>

    ${techsSection}

    <p style="margin:0 0 6px;font-weight:700;font-size:13px;color:${DARK};">Pricing</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:22px;">
      <tr><td style="padding:6px 0;color:${MID};border-bottom:1px solid #F0EEEB;width:140px;">Base</td><td style="padding:6px 0;border-bottom:1px solid #F0EEEB;">$${p.basePrice.toFixed(2)}</td></tr>
      ${p.addons.length > 0 ? `<tr><td style="padding:6px 0;color:${MID};border-bottom:1px solid #F0EEEB;">Add-ons</td><td style="padding:6px 0;border-bottom:1px solid #F0EEEB;">${p.addons.map(a => a.name).join(", ")}</td></tr>` : ""}
      ${p.bundleDiscount > 0 ? `<tr><td style="padding:6px 0;color:#2D6A4F;border-bottom:1px solid #F0EEEB;">Bundle Discount</td><td style="padding:6px 0;color:#2D6A4F;border-bottom:1px solid #F0EEEB;">-$${p.bundleDiscount.toFixed(2)}</td></tr>` : ""}
      <tr><td style="padding:6px 0;color:${MID};font-weight:700;">Total</td><td style="padding:6px 0;font-weight:700;font-size:14px;">$${p.firstVisitTotal.toFixed(2)}</td></tr>
    </table>

    ${p.specialNotes ? `<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:10px 14px;margin-bottom:20px;font-size:13px;color:${DARK};"><strong>Notes:</strong> ${p.specialNotes}</div>` : ""}

    <div style="background:${BG};border-radius:6px;padding:10px 14px;font-size:12px;color:${MID};">
      ${p.jobId ? `<span style="margin-right:14px;">Job <strong style="color:${DARK};">#${p.jobId}</strong></span>` : ""}
      ${p.clientId ? `<span style="margin-right:14px;">Client <strong style="color:${DARK};">#${p.clientId}</strong></span>` : ""}
      ${p.stripeCustomerId ? `<span style="display:block;margin-top:4px;">Stripe customer: <code style="font-size:11px;">${p.stripeCustomerId}</code></span>` : ""}
      ${p.stripePaymentMethodId ? `<span style="display:block;margin-top:2px;">Payment method: <code style="font-size:11px;">${p.stripePaymentMethodId}</code></span>` : ""}
    </div>`;

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
