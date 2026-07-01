// ─────────────────────────────────────────────────────────────────────────────
// testSendService — the "Send Test" backend.
//
// Renders a real customer-message template with sample (or, later, real-
// appointment) merge data and delivers it to STAFF only, tagged "[TEST]". It
// reuses the exact production render path (renderCustomerTemplate + the same
// wrapEmailHtml email shell sendNotification uses) so the staff member sees what
// a real client would — but it deliberately does NOT call sendNotification().
//
// WHY a separate path: sendNotification() writes to notification_log ("Recent
// Sends") on every code path, and the cron/route callers around it drive the
// review-request, follow-up, and scorecard automations. Going around it means a
// test send (a) never pollutes Recent Sends, (b) cannot fire any downstream
// automation, and (c) cannot touch a customer/appointment record. Every attempt
// — success or failure — is recorded only in the isolated test_sends table.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { Resend } from "resend";
import { renderCustomerTemplate, applyMergeTags, CUSTOMER_MESSAGE_TRIGGERS, type MsgChannel } from "../lib/customer-messages.js";
import { wrapEmailHtml } from "./notificationService.js";
import { resolveSender, sendSmsVia } from "../lib/comms-sender.js";
import { emailLogoUrl } from "../lib/app-url.js";
import { SAMPLE_SERVICES_BREAKDOWN_HTML } from "../lib/services-breakdown.js";
// Reuse the exact production render paths for the two non-template card groups:
// the hardcoded job-status SMS bodies and the office booking-notification email.
import { SMS_MESSAGES } from "../routes/job-sms.js";
import { buildOfficeNotificationEmail } from "../lib/emailTemplates.js";
import { getBranchByZip } from "../lib/branchRouter.js";

// Special (non customer-message-catalog) test template keys.
const OFFICE_BOOKING_KEY = "office_booking";
const JOBSTATUS_PREFIX = "jobstatus_"; // jobstatus_on_my_way | _arrived | _paused | _complete

// Typed error so the route can map a failure to the right HTTP status without
// leaking internals. `code` is a stable string the frontend can branch on.
export class TestSendError extends Error {
  constructor(public code: string, public httpStatus: number, message?: string) {
    super(message || code);
  }
}

// The canonical sample customer used for every "sample" test send. Customer-
// specific tags only — company_name/phone/email are injected from the real
// company row (below) exactly as the live send path does, so the branding the
// staff member sees is the tenant's own, not a hardcoded string.
const SAMPLE_CUSTOMER_VARS: Record<string, string> = {
  first_name: "Maria",
  client_name: "Maria Sample",
  service_type: "Standard Cleaning",
  date: "Friday, June 27, 2026",
  appointment_date: "Friday, June 27, 2026",
  time: "9:00 AM",
  appointment_time: "9:00 AM",
  arrival_window: "9:00 AM to 12:00 PM",
  appointment_window: "9:00 AM to 12:00 PM",
  arrival_alert_window: "45",
  service_address: "123 Oak St, Oak Lawn, IL 60453",
  // Short-form aliases so templates authored with {{address}} / {{service}}
  // resolve too (the canonical tags are service_address / service_type). Mirrors
  // the date/appointment_date + time/appointment_time aliasing.
  address: "123 Oak St, Oak Lawn, IL 60453",
  service: "Standard Cleaning",
  tech_name: "Ana",
  appointment_link: "https://app.qleno.com/appointments/test-sample",
  review_link: "https://phes.io/review/test-sample",
  // Pre-rendered sample itemized table so a test send exercises the
  // {{services_breakdown}} chip exactly like a real booking would.
  services_breakdown: SAMPLE_SERVICES_BREAKDOWN_HTML,
};

// Sample booking used to render the office-notification email test. branchConfig
// comes from the sample address zip via getBranchByZip (same as the live booking
// path). Cast to any so we don't couple to the full ConfirmationEmailParams shape
// — the unset fields are all optional and render fine.
function sampleOfficeBookingParams(): any {
  return {
    firstName: "Maria",
    lastName: "Sample",
    email: "maria.sample@example.com",
    phone: "(708) 974-5517",
    serviceType: "Standard Cleaning",
    scheduledDate: "Friday, June 27, 2026",
    arrivalWindow: "9:00 AM to 12:00 PM",
    serviceAddress: "123 Oak St, Oak Lawn, IL 60453",
    preferredContactMethod: "text",
    basePrice: 180,
    addons: [{ name: "Inside Fridge", amount: 25 }],
    bundleDiscount: 0,
    firstVisitTotal: 205,
    sqft: 1800,
    branchConfig: getBranchByZip("60453"),
    jobId: 0,
    zoneName: "Oak Lawn",
    availableTechs: [{ name: "Ana" }, { name: "Guadalupe" }],
  };
}

export type Fixture = "sample" | { appointment_id: string | number };

export interface TestSendParams {
  companyId: number;
  userId: number;
  userLoginEmail: string;
  branchId: number | null;
  templateKey: string;
  channel: MsgChannel;
  fixture: Fixture;
  recipientOverride?: string | null;
  // [draft-test] Unsaved editor content. When bodyOverride is a non-empty
  // string, the test renders THIS draft instead of the saved template row, so
  // the office can verify edits without first saving them live to customers.
  // Applies only to catalog/custom templates (the office-booking and job-status
  // groups have no editable body). Stored-format {{tag}} text, same as the row.
  subjectOverride?: string | null;
  bodyOverride?: string | null;
}

export interface TestSendResult {
  test_send_id: number;
  status: "sent" | "failed";
  recipient: string;
  preview: { subject: string | null; body: string };
  error?: string;
}

const RATE_LIMIT_PER_HOUR = 30;

// Throws TestSendError("rate_limited", 429) when the user has already made 30
// test sends in the trailing hour. Counted from test_sends so it survives a
// restart and holds across server instances (unlike an in-memory counter).
export async function assertUnderRateLimit(userId: number): Promise<void> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM test_sends
     WHERE user_id = ${userId} AND created_at > NOW() - INTERVAL '1 hour'`);
  const n = Number((r.rows[0] as any)?.n ?? 0);
  if (n >= RATE_LIMIT_PER_HOUR) {
    throw new TestSendError("rate_limited", 429, `Test send limit reached (${RATE_LIMIT_PER_HOUR}/hour). Try again later.`);
  }
}

export async function sendTestNotification(params: TestSendParams): Promise<TestSendResult> {
  const { companyId, userId, userLoginEmail, branchId, templateKey, channel, fixture, recipientOverride, subjectOverride, bodyOverride } = params;

  if (channel !== "email" && channel !== "sms") {
    throw new TestSendError("bad_channel", 400, "channel must be 'email' or 'sms'");
  }
  const isOfficeBooking = templateKey === OFFICE_BOOKING_KEY;
  const isJobStatus = templateKey.startsWith(JOBSTATUS_PREFIX);
  const isCatalog = CUSTOMER_MESSAGE_TRIGGERS.has(templateKey) || templateKey.startsWith("custom_");
  if (!isCatalog && !isOfficeBooking && !isJobStatus) {
    throw new TestSendError("unknown_template", 400, `Unknown template '${templateKey}'`);
  }
  // Channel constraints for the two special groups.
  if (isOfficeBooking && channel !== "email") {
    throw new TestSendError("bad_channel", 400, "Office Booking Notification is email-only.");
  }
  if (isJobStatus && channel !== "sms") {
    throw new TestSendError("bad_channel", 400, "Job status messages are text-only.");
  }

  // ── Merge data ──────────────────────────────────────────────────────────────
  // Real-appointment data is the PR-3 feature; the endpoint accepts the shape so
  // the frontend contract is stable, but the projection isn't wired yet.
  const fixtureIsSample = fixture === "sample";
  if (!fixtureIsSample) {
    throw new TestSendError("appointment_fixture_unavailable", 400,
      "Testing with a real appointment ships in the next update — use sample data for now.");
  }
  const fixtureSource = "sample";

  // Company branding tags, sourced from the real company row exactly as
  // sendNotification does. The wrapEmailHtml footer also references
  // {{company_phone}} / {{company_email}}, so these must be present.
  const cRows = await db.execute(sql`
    SELECT name, phone, email, email_from_address, logo_url FROM companies WHERE id = ${companyId} LIMIT 1`);
  const c: any = cRows.rows[0] ?? {};
  const fullVars: Record<string, string> = {
    company_name: c.name || "Phes",
    company_phone: c.phone || "(708) 974-5517",
    company_email: c.email || "info@phes.io",
    ...SAMPLE_CUSTOMER_VARS,
  };

  // ── Recipient resolution ─────────────────────────────────────────────────────
  const [u] = (await db.execute(sql`SELECT test_email, test_phone FROM users WHERE id = ${userId} LIMIT 1`)).rows as any[];
  const override = (recipientOverride || "").trim() || null;
  let recipient: string;
  if (channel === "email") {
    recipient = override || u?.test_email || userLoginEmail;
    if (!recipient) throw new TestSendError("no_recipient", 422, "No email address to send the test to.");
  } else {
    recipient = override || u?.test_phone || "";
    if (!recipient) throw new TestSendError("no_test_phone", 422, "No test phone number on file.");
  }

  // ── Render via the production path ────────────────────────────────────────────
  // is_active is intentionally ignored — testing a PAUSED template is the most
  // common reason to send a test. Three render sources, each reused verbatim:
  //   office booking → buildOfficeNotificationEmail (a full HTML email shell)
  //   job status sms → SMS_MESSAGES[...] (hardcoded one-liners)
  //   everything else → renderCustomerTemplate (notification_templates + {{tags}})
  let rendered: { subject: string | null; body: string };
  let bodyIsFullHtml = false; // office booking builds its own complete email shell
  if (isOfficeBooking) {
    const { subject, html } = buildOfficeNotificationEmail(sampleOfficeBookingParams());
    rendered = { subject, body: html };
    bodyIsFullHtml = true;
  } else if (isJobStatus) {
    const k = templateKey.slice(JOBSTATUS_PREFIX.length);
    const fn = SMS_MESSAGES[k];
    if (!fn) throw new TestSendError("template_not_found", 404, `No job-status message '${k}'.`);
    rendered = { subject: null, body: fn(SAMPLE_CUSTOMER_VARS.tech_name, SAMPLE_CUSTOMER_VARS.first_name, SAMPLE_CUSTOMER_VARS.service_address) };
  } else if (typeof bodyOverride === "string" && bodyOverride.trim()) {
    // [draft-test] Render the unsaved editor draft through the same {{tag}}
    // substitution the saved path uses, so a DRAFT test looks identical to what
    // saving-then-sending would produce.
    rendered = {
      subject: channel === "email" && subjectOverride ? applyMergeTags(subjectOverride, fullVars) : null,
      body: applyMergeTags(bodyOverride, fullVars),
    };
  } else {
    const r = await renderCustomerTemplate(companyId, templateKey, channel, fullVars);
    if (!r) throw new TestSendError("template_not_found", 404, `No ${channel} template found for '${templateKey}'.`);
    rendered = r;
  }

  // ── Send ──────────────────────────────────────────────────────────────────────
  // [TEST] goes on the subject for email, prepended to the body for sms (spec).
  let status: "sent" | "failed" = "sent";
  let providerId: string | null = null;
  let error: string | null = null;
  let previewSubject: string | null = null;
  let previewBody = "";

  try {
    if (channel === "email") {
      previewSubject = `[TEST] ${rendered.subject || ""}`.trimEnd();
      // Office booking already returns a complete HTML email — wrapping it again
      // would double the shell. Catalog emails get the standard wrap + a re-merge
      // so the shell's own footer tags resolve (mirrors sendNotification).
      const html = bodyIsFullHtml
        ? rendered.body
        : applyMergeTags(wrapEmailHtml(rendered.body, { logoUrl: emailLogoUrl(c.logo_url), companyName: c.name }), fullVars);
      previewBody = html;
      if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");
      const fromAddr = c.email_from_address || "info@phes.io";
      const resend = new Resend(process.env.RESEND_API_KEY);
      const res: any = await resend.emails.send({ from: fromAddr, replyTo: fromAddr, to: recipient, subject: previewSubject, html });
      if (res?.error) throw new Error(`Resend error: ${res.error?.message ?? JSON.stringify(res.error)}`);
      providerId = res?.data?.id ?? null;
    } else {
      previewBody = `[TEST] ${rendered.body}`;
      // For a test we deliberately bypass the comms gate ladder (comms_disabled /
      // branch_comms_disabled) — test sends are sanctioned staff-only — but still
      // require real creds + a from-number; we never invent a sender.
      const sender = await resolveSender(companyId, branchId ?? undefined);
      if (!sender.account_sid || !sender.auth_token) {
        throw new TestSendError("twilio_unconfigured", 422, "Twilio isn't configured for this account.");
      }
      if (!sender.from_number) {
        throw new TestSendError("no_from_number", 422, "No Twilio from-number for this branch.");
      }
      const res: any = await sendSmsVia(sender, recipient, previewBody);
      providerId = res?.sid ?? null;
    }
  } catch (err: any) {
    // A TestSendError raised during send (twilio_unconfigured/no_from_number) is a
    // pre-send configuration failure — surface it as the typed HTTP error rather
    // than logging a confusing failed-attempt row.
    if (err instanceof TestSendError) throw err;
    status = "failed";
    error = err?.message || String(err);
    console.error(`[test-send] ${templateKey}/${channel} failed:`, error);
  }

  // ── Record the attempt (success OR failure) in the isolated ledger ───────────
  const ins = await db.execute(sql`
    INSERT INTO test_sends
      (company_id, branch_id, user_id, template_key, channel, recipient, subject, body,
       merge_data_json, fixture_source, status, provider_message_id, error)
    VALUES
      (${companyId}, ${branchId ?? null}, ${userId}, ${templateKey}, ${channel}, ${recipient},
       ${channel === "email" ? previewSubject : null}, ${previewBody},
       ${JSON.stringify(fullVars)}::jsonb, ${fixtureSource}, ${status}, ${providerId}, ${error})
    RETURNING id`);
  const testSendId = Number((ins.rows[0] as any)?.id ?? 0);

  return {
    test_send_id: testSendId,
    status,
    recipient,
    preview: { subject: previewSubject, body: previewBody },
    ...(error ? { error } : {}),
  };
}
