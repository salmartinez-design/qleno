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

export const AGREEMENT_BODY_SEED_VERSION = 5;

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

Please make sure we can get in at the scheduled time. If our technicians arrive and cannot gain access to the property, a lockout fee equal to the full service charge applies, and it may be charged to your card on file under Section 12.

The time was already reserved for you, the day's route was built around your address, and your technician is paid for the visit whether or not we can get in. The parties agree this fee is a reasonable estimate of that loss and is not a penalty.

8. CANCELLATION AND RESCHEDULING

We ask for 48 hours notice to cancel or reschedule. A cancellation made inside 48 hours of your scheduled service is charged a fee equal to 100% of the service cost, which may be charged to your card on file under Section 12.

Inside 48 hours we cannot fill the time with another customer, the route for that day is already set, and your technician is paid for the visit. The parties agree this fee is a reasonable estimate of that loss and is not a penalty. Exceptions are made for genuine emergencies at management's discretion.

9. SERVICE HOLDS

You may place your recurring service on hold and keep your regular time slot for up to {{hold_max_days}} days at a time. Please give us at least 48 hours notice before the first visit you want held.

You have {{hold_notice_free_days}} free hold days in any 12 month period. You may take them all at once or split them across several holds.

If a hold you ask for fits inside the free days you have left, it is free and changes nothing about your rate or your slot.

If it does not fit, the hold takes your slot off our schedule for the same stretch of time a cancellation would, so it counts as your notice under Section 10. If you resume service before that hold ends, nothing is charged. If you do not resume by the day the hold ends, this Agreement ends that day and the visits that would have taken place during the last {{termination_notice_days}} days of that hold are due at your current rate of {{rate}} per visit. That is the notice amount described in Section 10. We count the visits your own schedule actually had in that window, so the number depends both on how often we clean for you and on where those dates fall in the calendar: weekly service is usually four and sometimes five, every other week usually two and sometimes three, twice a month two, monthly one. That amount is charged to your card on file on the day the hold ends, as authorized in Section 12.

Where a hold is treated as your notice under this Section, this Section controls and Section 10 does not also apply. You will never be billed for both a notice period and a hold covering the same stretch of time.

We will email you when a hold starts and again before it ends, so the date is never a surprise. You may resume service, or ask us to extend the hold, any time before it ends.

10. TERMINATION

Either party may end recurring service with {{termination_notice_days}} days written notice. During that notice period your regular visits continue and are billed at your current rate. If you ask us to stop cleaning before the notice period is over, the visits scheduled inside it are still due, because that is the time we need to fill your slot.

{{company_name}} may end service immediately for safety concerns, non-payment, or a hostile work environment.

11. FREQUENCY AND YOUR RATE

Your rate is set by your frequency. To hold your rate and your appointment slot, the longest gap between cleanings is 60 days. Going past that may move you to a different rate that reflects the additional time the home then needs.

Your rate is based on how often we actually clean, not only on the schedule in Section 3. If cancelled, skipped or held visits leave you receiving service less often than the frequency your rate is based on, we may move you to our rate for the frequency you are actually receiving. We will tell you before that happens, and any change applies going forward only.

12. PAYMENT AND CARD AUTHORIZATION

Payment is due on the day of service. Your rate per visit is {{rate}}, which may change only as described in Section 13.

By signing this Agreement you authorize {{company_name}} to charge the payment card you keep on file for each of the following: every completed visit, on the day of service; any lockout fee under Section 7; any late cancellation fee under Section 8; any visit billed during a hold or notice period under Section 9 or Section 10, charged on the day that hold or notice period ends; any add-on service you request under Section 6; and any placement fee owed under Section 19.

This authorization is ongoing. Your service continues on the schedule in Section 3 and your card continues to be charged until you or we end this Agreement under Section 10. You may cancel at any time by giving written notice as described in Section 21. You may also withdraw this card authorization by written notice, though withdrawing it does not cancel amounts already owed.

{{late_fee}}

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

If you are not satisfied with a cleaning, contact us within 24 hours and tell us which areas you want addressed. We will return once to re-clean those areas at no additional charge, within 7 days of your service. That return visit is our obligation and your remedy for a cleaning you are not satisfied with. It does not limit anything you are owed under Section 18 for accidental damage.

18. BREAKAGE AND DAMAGE

{{company_name}} carries liability insurance. Please report accidental damage caused by our technicians as soon as you notice it, and in any case within {{damage_report_days}} business days of the visit. Reporting promptly lets us and our insurer look at the damage while the cause can still be determined. Damage reported later is harder to verify, and that may affect what we are able to cover.

Except where the law does not allow it, our liability for damage to any single item is limited to {{damage_cap}}. Nothing in this Agreement limits our liability for personal injury, for willful or wanton conduct, or for anything else the law does not permit us to limit.

If you ask us to move or clean beneath heavy furniture or appliances, we will do so only where it is safe to, and we are not responsible for damage that results from moving an item over 25 lbs at your request. We are also not responsible for damage to items that were already in a damaged condition before our visit. Claims are handled case by case.

19. NON-SOLICITATION

Our technicians are trained and background checked at our expense. For {{nonsolicit_months}} months after your last service, you agree not to hire or engage directly for cleaning work any {{company_name}} employee or contractor who performed services at your home. If you do, a placement fee of {{nonsolicit_fee}} is due, and it may be charged to your card on file under Section 12.

The parties agree this fee is a reasonable estimate of what it costs us to recruit, screen, train and replace a technician, and that it is not a penalty.

20. PRIVACY

Anything we learn about your home stays with us. We do not sell client information, and we do not share entry codes or property details outside our team, with two exceptions: the service providers who help us run the business, such as our payment processor and our scheduling, messaging and accounting systems, and any disclosure the law requires. Those providers may use the information only to provide their service to us.

21. NOTICES

All notices under this Agreement, including notice to cancel service, must be in writing. Written notice is validly delivered by email or by text message to the addresses and numbers below, or to any address or number a party later provides in writing. Notice is effective on the date it is sent.

To {{company_name}}: {{company_email}} / {{company_phone}}
To the Client: {{client_email}} / {{client_phone}}

22. GOVERNING LAW AND DISPUTES

The laws of the State of Illinois govern this Agreement, without regard to its conflict of law rules. Any dispute arising out of it will be brought in the state courts located in Cook County, Illinois, and both parties consent to that venue. Either party may instead bring a claim in small claims court in that county if it is within that court's limits.

If either party brings a claim to enforce this Agreement, the party that prevails is entitled to recover its reasonable attorney fees and costs from the other.

23. GENERAL TERMS

Severability. If any part of this Agreement is found unenforceable, that part is narrowed or removed only as far as needed, and the rest of the Agreement stays in force.

No waiver. If we do not enforce a term on one occasion, that does not waive it on any other occasion.

Survival. Sections 12, 18, 19, 20, 22 and 23 continue to apply after this Agreement ends.

Assignment. You may not transfer this Agreement without our written consent. We may assign it to a successor that takes over the business.

Events outside our control. Neither party is responsible for a delay or failure to perform caused by something outside its reasonable control, such as severe weather, utility or road closures, or a public emergency. Section 14 describes how we reschedule.

24. ENTIRE AGREEMENT

This Agreement is the entire understanding between the parties on this subject and replaces any earlier discussion or quote. Changes must be in writing and agreed by both parties.

By signing below, you confirm you have read this Agreement, that the service details in Sections 1 through 3 are correct, and that you agree to its terms. You represent that you are the owner of the property, or a lawful occupant with authority to authorize entry and to commit the household to the payments described in Section 12. You agree that your electronic signature has the same legal effect as a handwritten one.`;

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

Service Holds: The Client may place service on hold and keep its scheduled slot for up to {{hold_max_days}} days at a time, with at least 48 hours' notice before the first visit to be held. The Client has {{hold_notice_free_days}} free hold days in any 12 month period, taken at once or in pieces. A hold that fits inside the free days remaining is free and does not change the rate or the schedule. A hold that does not fit serves as the Client's notice under Early Termination above: if the Client resumes service before that hold ends, nothing is charged; if the Client does not resume by the day the hold ends, this Agreement ends that day and the visits that would have taken place during the last {{termination_notice_days}} days of that hold are due at the current rate of {{rate}} per visit, as the notice amount described under Early Termination above, charged to the card on file that day. The Client will never be billed for both a notice period and a hold covering the same period.

Lockout Policy: Service Provider shall provide forty-eight (48) hours' notice of the scheduled time. If the Service Provider is ready and able to perform services but is denied access to the property, the visit will be billed in full.

Keys and Access: Keys, fobs and access codes provided to the Service Provider will be stored securely and used only to perform services under this Agreement. The Client must notify the Service Provider immediately if access credentials change. The Service Provider is not responsible for re-keying or credential replacement costs unless a credential is lost through its negligence.

6. LIABILITY, DAMAGE & INSURANCE

Insurance: The Service Provider carries commercial general liability insurance. A certificate of insurance is available upon request.

Damage: The Service Provider will repair or replace items damaged through its negligence. The Client must report suspected damage in writing as soon as it is noticed, and in any case within {{damage_report_days}} business days of the service date. Prompt reporting allows the Service Provider and its insurer to inspect while the cause can still be determined; damage reported after that period may not be capable of verification, which may limit what can be covered. The Service Provider is not liable for damage arising from pre-existing wear, defects, or items that were not properly secured. Except where prohibited by law, the Service Provider's liability for damage to any item is limited to {{damage_cap}} unless a higher amount is agreed in writing in advance. Nothing in this Agreement limits liability for personal injury, for willful or wanton conduct, or for anything else the law does not permit to be limited.

Governing Law: The laws of the State of Illinois govern this Agreement, without regard to its conflict of law rules. Any disputes will be resolved in the state courts located in Cook County, Illinois, and both parties consent to that venue.

Attorney Fees: If either party brings a claim to enforce this Agreement, the party that prevails is entitled to recover its reasonable attorney fees and costs from the other.

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

11. GENERAL TERMS

Severability. If any provision of this Agreement is found unenforceable, that provision is narrowed or severed only to the extent necessary, and the remainder of the Agreement remains in full force.

No Waiver. A party's failure to enforce any provision on one occasion is not a waiver of that provision on any other occasion.

Survival. Sections 4, 6, 7, 9, 10 and 11 survive termination of this Agreement.

Assignment. The Client may not assign this Agreement without the Service Provider's written consent. The Service Provider may assign it to a successor to its business.

Force Majeure. Neither party is responsible for a delay or failure to perform caused by conditions outside its reasonable control, including severe weather, utility interruption, road closure, or public emergency.

12. ENTIRE AGREEMENT

This Agreement constitutes the entire understanding between the parties. Any amendments must be in writing and signed by both parties.

By signing, the Client fully understands and agrees to the contents of this Agreement. The individual signing represents and warrants that they have authority to bind the Client. The Client is responsible for all amounts due for services provided or scheduled during the term and any notice period.`;

// [agreement-fields 2026-08-20] The questions the signing page asks.
//
// A template carries two halves: the contract text above, and the short form the
// customer fills in before they sign. The commercial template shipped with the
// text and an EMPTY form, so step 2 of the signing page ("Your Information -
// please verify or complete your details below") rendered as a blank white gap.
// Every commercial agreement Phes has sent was signed without ever asking who
// was signing it or what authority they had.
//
// Deliberately NOT collected here: frequency, scope and pricing. The commercial
// contract incorporates the estimate by reference, so asking the customer to
// restate those on the signing page invites a signed contract that contradicts
// the estimate it points at. The estimate is the one place those live.
//
// `variable` is the key the answer is stored under. Where a key matches one the
// signing page already prefills from the client record (full_name, email, phone,
// address) the customer sees it filled in and only has to check it.
export interface AgreementField {
  id: string;
  type: "text" | "tel" | "email" | "textarea" | "select";
  label: string;
  variable: string;
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export const COMMERCIAL_AGREEMENT_FIELDS: ReadonlyArray<AgreementField> = [
  { id: "f_company", type: "text", label: "Business or property name", variable: "client_company", required: true },
  { id: "f_name", type: "text", label: "Your full name", variable: "full_name", required: true },
  { id: "f_title", type: "text", label: "Your title", variable: "signer_title", required: true, placeholder: "Property Manager, Owner, Facilities Director" },
  { id: "f_address", type: "text", label: "Service address", variable: "address", required: true },
  { id: "f_phone", type: "tel", label: "Phone", variable: "phone", required: true },
  { id: "f_email", type: "email", label: "Email", variable: "email", required: true },
  { id: "f_billing_email", type: "email", label: "Billing email", variable: "billing_email", required: false, placeholder: "Only if invoices go somewhere else" },
  { id: "f_access", type: "textarea", label: "Building access instructions", variable: "access_notes", required: false, placeholder: "Entry, hours, parking, who to check in with" },
];
