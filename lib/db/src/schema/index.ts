export * from "./companies";
export * from "./branches";
export * from "./users";
export * from "./message_templates";
export * from "./referral_partners";
export * from "./marketing_spend";
export * from "./kpi_targets";
export * from "./lead_report_settings";
export * from "./clients";
export * from "./jobs";
export * from "./job_photos";
export * from "./timeclock";
export * from "./invoices";
export * from "./scorecards";
export * from "./scorecard_entries";
export * from "./employee_efficiency";
export * from "./efficiency_entries";
export * from "./additional_pay";
export * from "./loyalty";
export * from "./audit_log";
export * from "./articles";
export * from "./guides";
export * from "./discounts";
export * from "./job_discounts";
export * from "./auto_promos";
export * from "./availability";
export * from "./contact_tickets";
export * from "./employee_notes";
export * from "./client_ratings";
export * from "./messages";
export * from "./notification_templates";
export * from "./job_status_logs";
export * from "./client_homes";
export * from "./technician_preferences";
export * from "./client_notifications";
export * from "./client_communications";
export * from "./sms_messages";
export * from "./client_agreements";
export * from "./quotes";
export * from "./payments";
export * from "./client_attachments";
export * from "./property_groups";
export * from "./agreement_templates";
export * from "./form_templates";
export * from "./form_submissions";
export * from "./quote_scopes";
export * from "./quote_attachments";
export * from "./daily_summaries";
export * from "./app_audit_log";
export * from "./payment_links";
export * from "./service_zones";
export * from "./service_zone_employees";
export * from "./waitlist";
export * from "./recurring_schedules";
export * from "./cancellation_log";
export * from "./communication_log";
export * from "./incentive_programs";
export * from "./incentive_earned";
export * from "./satisfaction_surveys";
export * from "./churn_scores";
export * from "./tech_retention_snapshots";
export * from "./add_ons";
export * from "./job_add_ons";
export * from "./route_sequences";
export * from "./supply_items";
export * from "./job_supplies";
export * from "./hr_policies";
export * from "./hr_logs";
export * from "./accounts";
export * from "./account_rate_cards";
export * from "./account_properties";
export * from "./account_contacts";
export * from "./document_templates";
export * from "./document_signatures";
export * from "./document_requests";
export * from "./mileage_requests";
export * from "./pricing";
export * from "./quickbooks";
export * from "./employee_payroll_history";
export * from "./addon_bundles";
export * from "./rate_locks";
export * from "./offer_settings";
export * from "./notifications";
export * from "./user_views";
// [AG] Job edit modal — audit trail + multi-tech junctions
export * from "./job_audit_log";
export * from "./job_technicians";
export * from "./recurring_schedule_add_ons";
export * from "./recurring_schedule_technicians";
// [AH] Commercial pricing — per-client audit
export * from "./client_audit_log";
// [AI.3] Tenant-managed commercial service types
export * from "./commercial_service_types";
// [scheduling-engine 2026-04-29] Tenant-managed acquisition sources
export * from "./acquisition_sources";
// [commercial-workflow 2026-04-29] Hierarchical service types +
// per-day add-on scoping
export * from "./service_types";
export * from "./recurring_schedule_addons_days";
// [lms-per-module 2026-05-07] Per-module quiz LMS — replaces the
// frontend-only single end-of-course quiz with backend-persisted, gated,
// deadline-bounded per-module flow + final mixed test.
export * from "./lms";

// [lms-signatures 2026-05-12] UETA / E-SIGN signature infrastructure for
// the 2026 onboarding / handbook / acknowledgment system. Tables:
// signed_documents, document_versions, signature_events,
// completion_certificates, annual_ack_cycles, pending_re_ack.
export * from "./lms-signatures";
export * from "./lms-settings";

// [lms-onboarding-intake 2026-05-13] Operational onboarding intake form
// captured on hire. Excludes SSN / W-4 / I-9 / direct deposit (those
// live with ADP). Stores emergency contact, sizing, personal vehicle +
// insurance for techs who drive, languages, preferred name + pronouns.
// Multi-tenant via company_id; one row per (company_id, user_id).
export * from "./lms-onboarding-intake";

// Cutover 1C (execution engine). Clock events carry the GPS integrity
// guarantees enforced both at the route layer and via the CHECK
// constraint installed by cutover-data-migration.ts. Worksheet +
// technician notes + on-my-way events round out the per-job working
// surface that the tech writes to during a shift.
export * from "./job_clock_events";
export * from "./job_worksheet";
export * from "./technician_notes";
export * from "./on_my_way_events";

// Cutover 1E (pay summary + export). Provider-neutral pay pipeline:
// dated rates, periods with lifecycle gates, computed summaries
// driven by an application-level eligibility filter on clock events,
// and an adjustments ledger.
export * from "./pay";

// Cutover 2A (corrective). Mileage automation lives in its own table
// pair so "computed work" and "billable money" stay separate:
//   - mileage_rates: dated $/mi, append-only
//   - mileage_legs:  per-leg computed work with computed → reviewed →
//                    applied lifecycle. Until applied (set by 2B), the
//                    leg DOES NOT roll up into pay_period_summaries.
//   - distance_cache: per-tenant cache of mapping-API measurements.
export * from "./mileage";

// Cutover 3A — availability + tenant-configurable leave catalog +
// request lifecycle + blackouts. Companion column adds on
// hr_policies (balance_ceiling_hours, use_it_or_lose_it_alert_lead_days,
// unexcused_hours_steps).
export * from "./leave";

// Multi-tenant company switcher — per-user company membership.
export * from "./user_companies";

// Cutover 3B — attendance overlay proposals. Staging table for
// office-confirmed attendance discrepancies (late / short / no_show /
// missing_clockout). Pending rows become employee_attendance_log rows
// via the confirm flow (which drives the 3A unexcused-hours ladder).
export * from "./attendance_proposals";

// Push-notification device tokens (Capacitor native app). One user → many
// devices; sender lives in api-server/src/lib/push.ts, gated by COMMS_ENABLED.
export * from "./device_tokens";

// [commercial-estimate-tool 2026-06-09] Commercial / common-area estimate
// builder: estimates + line items + reusable templates. Separate from the
// residential quotes builder.
export * from "./estimates";
