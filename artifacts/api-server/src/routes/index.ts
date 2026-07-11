import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import photosRouter from "./photos.js";
import authRouter from "./auth.js";
import branchesRouter from "./branches.js";
import companiesRouter from "./companies.js";
import usersRouter from "./users.js";
import employeeExtendedRouter from "./employee-extended.js";
import clientsRouter from "./clients.js";
import jobsRouter from "./jobs.js";
import timeclockRouter from "./timeclock.js";
import invoicesRouter from "./invoices.js";
import batchInvoicingRouter from "./batch-invoicing.js";
import scorecardsRouter from "./scorecards.js";
import efficiencyRouter from "./efficiency.js";
import templatesRouter from "./templates.js";
import commsInboundRouter from "./comms-inbound.js";
import payrollRouter from "./payroll.js";
import loyaltyRouter from "./loyalty.js";
import dashboardRouter from "./dashboard.js";
import adminRouter from "./admin.js";
import discountsRouter from "./discounts.js";
import dispatchRouter from "./dispatch.js";
import portalRouter from "./portal.js";
import searchRouter from "./search.js";
import messagesRouter from "./messages.js";
import reportsRouter from "./reports.js";
import notificationsRouter from "./notifications.js";
import jobSmsRouter from "./job-sms.js";
import quotesRouter from "./quotes.js";
import estimatesRouter from "./estimates.js";
import trackRouter from "./track.js";
import paymentsRouter from "./payments.js";
import attachmentsRouter from "./attachments.js";
import teamPhotoNotesRouter from "./team-photo-notes.js";
import { quoteAttachmentsRouter, jobAttachmentsRouter } from "./quote-attachments.js";
import propertyGroupsRouter from "./property-groups.js";
import agreementTemplatesRouter from "./agreement-templates.js";
import billingRouter from "./billing.js";
import formTemplatesRouter from "./form-templates.js";
import signRouter from "./sign.js";
import quoteScopesRouter from "./quote-scopes.js";
import closeDayRouter from "./close-day.js";
import paymentLinksRouter from "./payment-links.js";
import zonesRouter from "./zones.js";
import recurringRouter from "./recurring.js";
import cancellationRouter from "./cancellation.js";
import commLogRouter from "./communication-log.js";
import officeRemindersRouter from "./office-reminders.js";
import incentivesRouter from "./incentives.js";
import satisfactionRouter from "./satisfaction.js";
import churnRouter from "./churn.js";
import communicationsRouter from "./communications.js";
import retentionRouter from "./retention.js";
import addonsRouter from "./addons.js";
import routeSequencesRouter from "./route-sequences.js";
import suppliesRouter from "./supplies.js";
import revenueGoalRouter from "./revenue-goal.js";
import policyRouter from "./policy.js";
import hrAttendanceRouter from "./hr-attendance.js";
import hrDisciplineRouter from "./hr-discipline.js";
import hrLeaveRouter from "./hr-leave.js";
import leaveRouter from "./leave.js";
import attendanceOverlayRouter from "./attendance-overlay.js";
import hrQualityRouter from "./hr-quality.js";
import accountsRouter from "./accounts.js";
import documentTemplatesRouter from "./document-templates.js";
import documentRequestsRouter from "./document-requests.js";
import mileageRequestsRouter from "./mileage-requests.js";
import pricingRouter from "./pricing.js";
import commercialServiceTypesRouter from "./commercial-service-types.js";
import serviceTypesRouter from "./service-types.js";
import coreRouter from "./core.js";
import techRouter from "./tech.js";
import techClockRouter from "./tech-clock.js";
import officeClockRouter from "./office-clock.js";
import payRouter from "./pay.js";
import opsIntegrityRouter from "./ops-integrity.js";
import opsRouter from "./ops.js";
import acquisitionSourcesRouter from "./acquisition-sources.js";
import publicRouter from "./public.js";
import appointmentRouter from "./appointment.js";
import quickbooksRouter from "./integrations/quickbooks.js";
import bundlesRouter from "./bundles.js";
import followUpRouter from "./follow-up.js";
import leadsRouter from "./leads.js";
import referralPartnersRouter from "./referral-partners.js";
import leadAnalyticsRouter from "./lead-analytics.js";
import rollupRouter from "./rollup.js";
import smsInboundRouter from "./sms-inbound.js";
import smsRouter from "./sms.js";
import commsStatusRouter from "./comms-status.js";
import pushWebRouter from "./push-web.js";
import payrollSettingsRouter from "./payroll-settings.js";
import complianceSettingsRouter from "./compliance-settings.js";
import subscriptionRouter from "./subscription.js";
import referralsRouter from "./referrals.js";
import contactRouter from "./contact.js";
import geocodeRouter from "./geocode.js";
import configRouter from "./config.js";
import lmsRouter from "./lms.js";
import lmsCertificatesRouter from "./lms-certificates.js";
import lmsSignaturesRouter from "./lms-signatures.js";
import lmsHandbookRouter from "./lms-handbook.js";
import lmsAnnualAckRouter from "./lms-annual-ack.js";
import lmsSettingsRouter from "./lms-settings.js";
import lmsAdminAuditRouter from "./lms-admin-audit.js";
import lmsOnboardingIntakeRouter from "./lms-onboarding-intake.js";
import translateRouter from "./translate.js";
import messageToneRouter from "./message-tone.js";
import helpMeWriteRouter from "./help-me-write.js";
import assistantRouter from "./assistant.js";
import devicesRouter from "./devices.js";
import guidesRouter from "./guides.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/companies", companiesRouter);
router.use("/users", employeeExtendedRouter);
router.use("/users", usersRouter);
router.use("/clients", clientsRouter);
router.use("/jobs", jobsRouter);
router.use("/jobs", jobSmsRouter);
router.use("/timeclock", timeclockRouter);
router.use("/invoices", invoicesRouter);
router.use("/batch-invoicing", batchInvoicingRouter);
router.use("/scorecards", scorecardsRouter);
router.use("/efficiency", efficiencyRouter);
router.use("/templates", templatesRouter);
router.use("/comms", commsInboundRouter);
router.use("/payroll", payrollRouter);
router.use("/loyalty", loyaltyRouter);
router.use("/dashboard", dashboardRouter);
router.use("/admin", adminRouter);
router.use("/discounts", discountsRouter);
router.use("/dispatch", dispatchRouter);
router.use("/portal", portalRouter);
router.use("/search", searchRouter);
router.use("/messages", messagesRouter);
router.use("/reports", reportsRouter);
router.use("/notifications", notificationsRouter);
router.use("/office-reminders", officeRemindersRouter);
router.use("/quotes", quotesRouter);
router.use("/estimates", estimatesRouter);
router.use("/track", trackRouter);
router.use("/payments", paymentsRouter);
router.use("/attachments", attachmentsRouter);
router.use("/team-photo-notes", teamPhotoNotesRouter);
// [translate-job-notes 2026-05-27] Office-only translation endpoint —
// Claude API. POST /api/translate {text, target} → {translated}.
router.use("/translate", translateRouter);
// [message-tone 2026-07-02] One-tap tone polish for outbound customer SMS.
// POST /api/message-tone {text, tone} → {result}.
router.use("/message-tone", messageToneRouter);
// [help-me-write 2026-07-11] Gmail-style draft generation from a short
// instruction for outbound customer SMS. Claude API. No tenant data read.
// POST /api/help-me-write {prompt, context?} → {result}.
router.use("/help-me-write", helpMeWriteRouter);
// [voice-assistant 2026-06-08] Field-tech voice assistant — Claude API, scoped
// to the caller's own jobs. POST /api/assistant/ask {question, language} → {answer, navigate_url}.
router.use("/assistant", assistantRouter);
router.use("/devices", devicesRouter);
// [quote-attachments] The routers define full paths internally
// (`:id/attachments`), so mount them at the resource root.
router.use("/quotes", quoteAttachmentsRouter);
router.use("/jobs", jobAttachmentsRouter);
router.use("/property-groups", propertyGroupsRouter);
router.use("/agreement-templates", agreementTemplatesRouter);
router.use("/billing", billingRouter);
router.use("/form-templates", formTemplatesRouter);
router.use("/sign", signRouter);
router.use("/quote-scopes", quoteScopesRouter);
router.use("/close-day", closeDayRouter);
router.use("/payment-links", paymentLinksRouter);
router.use("/zones", zonesRouter);
router.use("/recurring", recurringRouter);
router.use("/cancellations", cancellationRouter);
router.use("/comms", commLogRouter);
router.use("/incentives", incentivesRouter);
router.use("/satisfaction", satisfactionRouter);
router.use("/churn", churnRouter);
router.use("/communications", communicationsRouter);
router.use("/retention", retentionRouter);
router.use("/addons", addonsRouter);
router.use("/routes", routeSequencesRouter);
router.use("/supplies", suppliesRouter);
router.use("/appointment", appointmentRouter);
router.use("/revenue-goal", revenueGoalRouter);
router.use("/policy", policyRouter);
router.use("/hr-attendance", hrAttendanceRouter);
router.use("/hr-discipline", hrDisciplineRouter);
router.use("/hr-leave", hrLeaveRouter);
router.use("/leave", leaveRouter);
// Cutover 3B — attendance overlay (office-only dispatch surface for
// late / short / no_show / missing_clockout proposals)
router.use("/attendance-overlay", attendanceOverlayRouter);
router.use("/hr-quality", hrQualityRouter);
router.use("/accounts", accountsRouter);
router.use("/branches", branchesRouter);
router.use("/document-templates", documentTemplatesRouter);
router.use("/document-requests", documentRequestsRouter);
router.use("/mileage-requests", mileageRequestsRouter);
router.use("/pricing", pricingRouter);
router.use("/commercial-service-types", commercialServiceTypesRouter);
router.use("/service-types", serviceTypesRouter);
router.use("/core", coreRouter);
// Cutover 1B — tech day view (read-only timeline at /api/tech/today)
// Cutover 1C — execution engine at /api/tech/jobs/:jobId/* and office
// correction/exception review at /api/office/*. Mount the more
// specific /tech/jobs path BEFORE /tech so Express dispatches correctly.
router.use("/tech/jobs", techClockRouter);
router.use("/tech", techRouter);
router.use("/office", officeClockRouter);
// Cutover 1E — pay periods, summaries, adjustments, rates, generic CSV export
router.use("/pay", payRouter);
// Cutover 1E — on-demand re-run of the startup clock-integrity self-check
// (mounts /api/ops/integrity-check). Express dispatches by sub-path so
// stacking opsRouter below on the same prefix is safe.
router.use("/ops", opsIntegrityRouter);
// Cutover 1D — office live view (/api/ops/today/* + /api/ops/jobs/:id/detail)
router.use("/ops", opsRouter);
router.use("/guides", guidesRouter);
router.use("/acquisition-sources", acquisitionSourcesRouter);
router.use("/bundles", bundlesRouter);
router.use("/photos", photosRouter);
router.use("/public", publicRouter);
router.use("/integrations/quickbooks", quickbooksRouter);
router.use("/follow-up", followUpRouter);
router.use("/leads", leadsRouter);
router.use("/referral-partners", referralPartnersRouter);
router.use("/lead-analytics", leadAnalyticsRouter);
router.use("/rollup", rollupRouter);
router.use("/sms/inbound", smsInboundRouter);
router.use("/sms", smsRouter);
router.use("/comms-status", commsStatusRouter);
router.use("/push", pushWebRouter);
router.use("/payroll-settings", payrollSettingsRouter);
router.use("/compliance-settings", complianceSettingsRouter);
router.use("/subscription", subscriptionRouter);
router.use("/referrals", referralsRouter);
router.use("/contact", contactRouter);
router.use("/geocode", geocodeRouter);
router.use("/config", configRouter);
router.use("/lms", lmsRouter);
router.use("/lms/certificates", lmsCertificatesRouter);
router.use("/lms/signatures", lmsSignaturesRouter);
router.use("/lms/handbook", lmsHandbookRouter);
router.use("/lms/annual-ack", lmsAnnualAckRouter);
router.use("/lms-settings", lmsSettingsRouter);
router.use("/lms/admin-audit", lmsAdminAuditRouter);
router.use("/lms/onboarding-intake", lmsOnboardingIntakeRouter);

export default router;
