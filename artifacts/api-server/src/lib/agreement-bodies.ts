// [agreement-body 2026-08-19] The default contract text Phes sends, in one place.
//
// These used to live inline in routes/form-templates.ts as seed values, which
// meant the only copy of the real contract was reachable from a route file and
// nothing could re-render it. They now live here so three callers share one
// source: the seed-defaults route, the boot migration that refreshes an
// untouched template, and the builder preview.
//
// The residential body was rewritten from the signed Jotform contract. The old
// seed was a wall of policy paragraphs with no parties clause, no service
// address, no rate, no term and no signature block, and not one merge token, so
// every agreement Phes sent said nothing about the specific customer. Sections 1
// through 4 are the deal; everything after is the policy text the office already
// used, with the negotiable numbers pulled out into {{tokens}} that read from
// Company Settings.
//
// Rules for editing:
//   - No em or en dashes. This is customer-facing.
//   - Every number a company might want different belongs in a {{token}}, not
//     in the prose. See AGREEMENT_VARIABLES in agreement-merge.ts.
//   - Bump AGREEMENT_BODY_SEED_VERSION when you change a body, or the boot
//     migration will not pick it up.

export const AGREEMENT_BODY_SEED_VERSION = 1;

export const RESIDENTIAL_AGREEMENT_BODY = `RESIDENTIAL CLEANING SERVICE AGREEMENT

1. PARTIES

This Residential Cleaning Service Agreement (the "Agreement") is entered into on {{today}} between {{company_name}} (the "Service Provider") and {{client_name}} (the "Client").

Client: {{client_name}}
Service address: {{service_address}}
Email: {{client_email}}
Phone: {{client_phone}}

Service Provider: {{company_name}}
Provider email: {{company_email}}
Provider phone: {{company_phone}}

2. THE HOME

Bedrooms: {{bedrooms}}
Bathrooms: {{bathrooms}}
Approximate square feet: {{square_feet}}
Pets: {{pets}}
Entry instructions: {{access_notes}}

These details set the time budgeted for your cleaning. Please tell us before your next visit if any of them change, so we can adjust the schedule and quote rather than leave your technician short on time.

3. SERVICE, SCHEDULE AND RATE

Service: {{scope_of_work}}
Frequency: {{frequency}}
Service day: {{service_day}}
First service date: {{start_date}}
Rate per visit: {{rate}}

This Agreement takes effect on {{effective_date}} and continues on the schedule above until either party ends it under Section 10.

4. ARRIVAL WINDOW

Your service is scheduled with a 45 minute arrival window. Exact arrival times cannot be guaranteed, because traffic and the home before yours can run long. We will notify you when your technician is on the way.

5. SERVICE GUIDELINES

We begin services on the first service date above. Your service includes a per-visit minimum and covers the standard cleaning tasks in the scope above. Time beyond what the rate covers is billed at the agreed hourly rate, quoted to you before the work is done.

6. ADD-ONS AND TRADES

Additional services such as deep cleaning, move in or move out cleaning, and appliance interiors must be scheduled in advance and are billed separately. {{company_name}} does not subcontract trades or maintenance work.

7. ACCESS AND LOCKOUTS

Please make sure we can get in at the scheduled time. If our technicians arrive and cannot gain access to the property, a lockout fee equal to the full service charge applies.

8. CANCELLATION AND RESCHEDULING

We ask for 48 hours notice to cancel or reschedule. A cancellation made inside 48 hours of your scheduled service is charged a fee equal to 100% of the service cost. Exceptions are made for genuine emergencies at management's discretion.

9. SERVICE HOLDS

You may place your recurring service on hold and keep your regular time slot for up to {{hold_max_days}} days. Please give us at least 48 hours notice before the first visit you want held.

A hold of {{hold_notice_free_days}} days or less is free and changes nothing about your rate or your slot.

A hold longer than {{hold_notice_free_days}} days takes your slot off our schedule for the same stretch of time a cancellation would, so it counts as your notice under Section 10. If you resume service before the hold ends, nothing is charged. If you do not resume by the end of the hold, this Agreement ends and one final visit at your current rate of {{rate}} is due as the notice amount described in Section 10.

We will email you when a hold starts and again before it expires, so the date is never a surprise.

10. TERMINATION

Either party may end recurring service with {{termination_notice_days}} days written notice. During that notice period your regular visits continue and are billed at your current rate. If you ask us to stop cleaning before the notice period is over, the visits scheduled inside it are still due, because that is the time we need to fill your slot.

{{company_name}} may end service immediately for safety concerns, non-payment, or a hostile work environment.

11. FREQUENCY AND YOUR RATE

Your rate is set by your frequency. To hold your rate and your appointment slot, the longest gap between cleanings is 60 days. Going past that may move you to a different rate that reflects the additional time the home then needs.

12. PAYMENT TERMS

Payment is due on the day of service. Your card on file is charged automatically on the day of your scheduled service. {{late_fee}}

13. RATE CHANGES

You will receive at least {{rate_notice_days}} days notice before any rate change. {{rate_increase_limit}}

After your first two to three months of service, your rate may be adjusted to reflect the time your home actually takes to clean to our standard. We will tell you before any adjustment takes effect.

14. WHEN WE RESCHEDULE

If your technician is ill, we will reschedule rather than send someone who should not be working. We may also reschedule for severe weather or unsafe conditions. In winter, please clear driveways and walkways of snow and ice before your service. No cancellation fee applies when we are the ones rescheduling.

We observe New Year's Day, Memorial Day, Fourth of July, Labor Day, Thanksgiving Day and Christmas Day. Services that fall on those dates are rescheduled.

15. WHAT WE DO NOT CLEAN

Standard service does not include bodily fluids, biohazardous materials, mold remediation, or pest related cleanup. These need specialized services and are declined or quoted separately.

16. SURFACE CARE

We take care with all surfaces. {{company_name}} is not responsible for damage to improperly sealed, compromised, or already damaged surfaces. Please tell us before service about fragile items or anything needing special care.

17. SATISFACTION GUARANTEE

If you are not satisfied with a cleaning, contact us within 24 hours and we will return to address it at no additional charge.

18. BREAKAGE AND DAMAGE

{{company_name}} carries liability insurance. Please report accidental damage caused by our technicians within {{damage_report_days}} business days of the visit. Liability for any single item is limited to {{damage_cap}}. We do not accept liability for items weighing over 25 lbs or for items already in a damaged condition. Claims are handled case by case.

19. NON-SOLICITATION

Our technicians are trained and background checked at our expense. For {{nonsolicit_months}} months after your last service, you agree not to hire or engage any {{company_name}} employee or contractor directly for cleaning work. If you do, a placement fee of {{nonsolicit_fee}} is due.

20. PRIVACY

Anything we learn about your home stays with us. We do not share client information, entry codes, or property details with anyone outside our team.

21. ENTIRE AGREEMENT

This Agreement is the entire understanding between the parties on this subject and replaces any earlier discussion or quote. Changes must be in writing and agreed by both parties.

By signing below, you confirm you have read this Agreement, that the service details in Sections 1 through 3 are correct, and that you agree to its terms. You agree that your electronic signature has the same legal effect as a handwritten one.`;

// [agreement-merge 2026-07-22] Phes's real commercial contract, the one that
// lived in Jotform, with {{merge variables}} so one template serves every
// building. Client name, address, rate, frequency and scope come from the
// estimate or client at send time. Moved here 2026-08-19; text unchanged.
export const COMMERCIAL_AGREEMENT_BODY = `COMMERCIAL CLEANING SERVICE AGREEMENT

1. PARTIES
This Commercial Cleaning Service Agreement ("Agreement") is entered into on {{today}} by and between {{company_name}}, an Illinois company (the "Service Provider"), and {{client_company}} (the "Client").

2. CLIENT & SERVICE PROVIDER INFORMATION
Client Name: {{client_company}}
Service Address: {{service_address}}
Billing Method: Card on File
Service Provider: {{company_name}}
Provider Email: {{company_email}}
Provider Phone: {{company_phone}}

3. SERVICE SUMMARY & SCOPE

Effective Date: Services shall commence on {{effective_date}}.

Service Frequency: {{frequency}}
Scheduling: Exact service dates and times shall be determined by the Service Provider and may be adjusted due to holidays, weather conditions, building access restrictions, or operational needs, with reasonable notice provided to the Client.

Scope of Work
{{scope_of_work}}

Supplies and Equipment: The Service Provider will furnish all cleaning supplies and equipment necessary to perform these services.

4. PAYMENT TERMS & BILLING CYCLE

Rate: {{rate}} per visit - {{frequency}}

Payment Method: Card on file.

Due Date: Payment is due in full on the first visit of the month.

Late Payments: {{late_fee}}

Rate Adjustments: The Service Provider may adjust rates by providing {{rate_notice_days}} days' written notice. If the Client does not accept the adjusted rate, either party may terminate this Agreement effective on the proposed adjustment date, with no further obligation beyond services already performed. {{rate_increase_limit}}

Scope Limitation: The work performed will be strictly limited to the services listed in Section 3. Any additional tasks or requests outside this scope will be billed separately and require prior written approval.

5. CANCELLATION & ACCESS

Early Termination: Either party may terminate this Agreement with a {{termination_notice_days}}-day written notice, delivered as described in Section 10.

Lockout Policy: Service Provider shall provide forty-eight (48) hours' notice of the scheduled time. If the Service Provider is ready and able to perform services but is denied access to the property, the visit will be billed in full.

Keys and Access: Keys, fobs and access codes provided to the Service Provider will be stored securely and used only to perform services under this Agreement. The Client must notify the Service Provider immediately if access credentials change. The Service Provider is not responsible for re-keying or credential replacement costs unless a credential is lost through its negligence.

6. LIABILITY, DAMAGE & INSURANCE

Insurance: The Service Provider carries commercial general liability insurance. A certificate of insurance is available upon request.

Damage: The Service Provider will repair or replace items damaged through its negligence. The Client must report suspected damage in writing within {{damage_report_days}} business days of the service date; claims reported after that period cannot be verified and will not be honored. The Service Provider is not liable for damage arising from pre-existing wear, defects, or items that were not properly secured. Except where prohibited by law, the Service Provider's liability for damage to any item is limited to {{damage_cap}} unless a higher amount is agreed in writing in advance.

Governing Law: The laws of the State of Illinois govern this Agreement. Any disputes will be resolved in Cook County, Illinois.

7. NON-SOLICITATION

During the term of this Agreement and for {{nonsolicit_months}} months after it ends, the Client will not directly or indirectly hire, engage or solicit any employee or contractor of the Service Provider who performed services under this Agreement. If the Client does so, the Client agrees to pay a placement fee of {{nonsolicit_fee}}. The parties agree this amount is a reasonable estimate of the Service Provider's recruiting and training costs and is not a penalty.

8. INDEPENDENT CONTRACTOR

The Service Provider is an independent contractor. Personnel performing services are employees or contractors of the Service Provider only and are not employees of the Client. The Service Provider is solely responsible for their wages, taxes, insurance and supervision. Neither party is the agent of the other, and nothing in this Agreement creates a partnership or joint venture.

9. CONFIDENTIALITY

All client information and property details will be kept strictly confidential.

10. NOTICES

All notices required under this Agreement, including notice of termination, must be in writing. Written notice is validly delivered by email or by text message (SMS) to the addresses and numbers below, or to any address or number the parties later provide in writing. Notice is effective on the date it is sent.

To the Service Provider: {{company_email}} / {{company_phone}}
To the Client: {{client_email}} / {{client_phone}}

11. ENTIRE AGREEMENT

This Agreement constitutes the entire understanding between the parties. Any amendments must be in writing and signed by both parties.

By signing, the Client fully understands and agrees to the contents of this Agreement. The individual signing represents and warrants that they have authority to bind the Client. The Client is responsible for all amounts due for services provided or scheduled during the term and any notice period.`;

// The short generic commercial template that shipped as a second default. Kept
// as-is for tenants that use it; Phes's own commercial clients get the full
// contract above.
export const COMMERCIAL_AGREEMENT_BODY_SHORT = `COMMERCIAL CLEANING AGREEMENT

SCOPE OF WORK
Services will be performed as outlined in the agreed scope of work. Any additional services outside the agreed scope will be quoted separately.

PAYMENT TERMS
Invoices are due NET 30 days from date of issue. Late payments are subject to a 1.5% monthly interest charge.

TERMINATION
Either party may terminate with 60 days written notice. Immediate termination may occur for non-payment or breach of contract.

PERFORMANCE STANDARDS
{{company_name}} maintains professional cleaning standards. Clients may request inspection access to verify service quality.

LIABILITY
{{company_name}} carries commercial general liability insurance. Certificate of insurance available upon request.

CONFIDENTIALITY
All client information and property details will be kept strictly confidential.`;
