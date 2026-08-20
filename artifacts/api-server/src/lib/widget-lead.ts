import { db } from "@workspace/db";

// [widget-lead-shared 2026-08-20] This lived inside routes/public.ts, private to
// the booking widget. The customer portal now creates referral leads too, and a
// referral that comes in from the portal has to land on the same Lead Pipeline
// row, deduped the same way, as one that comes in from the widget. Two copies of
// find-or-create would have meant one customer showing up twice on the board.

// [widget-lead-upsert 2026-07-04] Find-or-create the Lead Pipeline lead for a
// public booking-widget action, deduped by email/phone within the company. An
// online residential QUOTE (abandon-track) creates a needs_contacted lead so it
// shows up in Leads; a later booking (confirm) UPGRADES that same lead to booked
// instead of creating a duplicate. Status only advances, never downgrades.
// Contact fields fill in but never clobber. Non-fatal.
const LEAD_STATUS_RANK: Record<string, number> = { needs_contacted: 0, contacted: 1, quoted: 2, booked: 3 };
export async function upsertWidgetLead(companyId: number, opts: {
  email?: string | null; phone?: string | null; first_name?: string | null; last_name?: string | null;
  address?: string | null; zip?: string | null; scope?: string | null;
  source: string; status: string; jobId?: number | null; booked?: boolean; quoteAmount?: number | null;
  // [quote-details-carry 2026-07-07] Sanitized snapshot of what the visitor
  // filled in on the widget (bedrooms/bathrooms/sqft/frequency/add-ons/
  // referral/step_reached). Merged into leads.details so the Lead Pipeline
  // shows the full quote picture; newer keys win over older ones.
  details?: Record<string, unknown> | null;
}): Promise<number | null> {
  try {
    const { sql: s } = await import("drizzle-orm");
    const email = opts.email ? String(opts.email).toLowerCase().trim() : null;
    const phone10 = (opts.phone ?? "").replace(/[^0-9]/g, "").slice(-10) || null;
    // [referral-vocabulary 2026-07-23] The widget's "How did you hear about
    // us?" answer rides in `details` as a display NAME ("Google Ads"). Land it
    // on the real column at write time — the boot backfill exists to repair
    // history, not to be the only thing that ever fills this in. COALESCE on
    // update so a later touch from a form that didn't ask can't erase an
    // answer the customer already gave.
    // [leadsource-unify 2026-07-28] Store the raw acquisition_sources slug the
    // widget dropdown emitted — no longer bucket it into the old 9-value enum
    // (which turned Thumbtack / Google Ads into "other" / "google"). The column
    // is now TEXT, so the widget's answers match the office vocabulary and the
    // dashboard report groups them under their real Settings names.
    const referralRaw = (opts.details?.referral_source ?? opts.details?.referral) as string | undefined;
    const referral = referralRaw && String(referralRaw).trim() ? String(referralRaw).trim() : null;
    let existing: any = null;
    if (email || phone10) {
      const found = await db.execute(s`
        SELECT id, status FROM leads
         WHERE company_id = ${companyId}
           AND (${email ? s`LOWER(email) = ${email}` : s`FALSE`}
                OR ${phone10 ? s`RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = ${phone10}` : s`FALSE`})
         ORDER BY created_at DESC LIMIT 1`);
      existing = (found.rows as any[])[0] ?? null;
    }
    if (existing) {
      const upgrade = (LEAD_STATUS_RANK[opts.status] ?? 0) > (LEAD_STATUS_RANK[String(existing.status)] ?? 0);
      await db.execute(s`
        UPDATE leads SET
          first_name = COALESCE(first_name, ${opts.first_name ?? null}),
          last_name  = COALESCE(last_name, ${opts.last_name ?? null}),
          email      = COALESCE(email, ${opts.email ?? null}),
          phone      = COALESCE(phone, ${opts.phone ?? null}),
          address    = COALESCE(address, ${opts.address ?? null}),
          zip        = COALESCE(zip, ${opts.zip ?? null}),
          scope      = COALESCE(scope, ${opts.scope ?? null}),
          status     = ${upgrade ? s`${opts.status}` : s`status`},
          quote_amount = COALESCE(${opts.quoteAmount ?? null}, quote_amount),
          quoted_at  = ${opts.status === "quoted" ? s`COALESCE(quoted_at, NOW())` : s`quoted_at`},
          job_id     = COALESCE(job_id, ${opts.jobId ?? null}),
          booked_at  = ${opts.booked ? s`COALESCE(booked_at, NOW())` : s`booked_at`},
          details    = COALESCE(details, '{}'::jsonb) || COALESCE(${opts.details ? JSON.stringify(opts.details) : null}::jsonb, '{}'::jsonb),
          referral_source = COALESCE(referral_source, ${referral}),
          updated_at = NOW()
        WHERE id = ${existing.id}`);
      // [booked-drip-stop 2026-07-09] The public booking-confirm paths upgrade a
      // lead to booked THROUGH this helper (raw SQL) and used to call NO stop
      // function — so an existing lead's drips kept firing after they booked
      // online (Francisco: booked clients still getting follow-ups). Stop the
      // lead's cadences here when this upsert marks it booked. advanceLeadStage
      // owns this for the internal paths; this is the widget equivalent.
      if (opts.status === "booked" || opts.booked) {
        import("../services/followUpService.js").then(({ stopEnrollmentsForLead }) =>
          stopEnrollmentsForLead(Number(existing.id), "lead_booked").catch(() => {})).catch(() => {});
      }
      return Number(existing.id);
    }
    // [source-precedence 2026-07-09] Stamp lead_source = source (not the DB
    // default 'manual'). Without this, every online/widget lead landed with
    // lead_source='manual' and rendered as the "Office" chip in the pipeline,
    // misrepresenting client-submitted leads as office-created ones.
    const ins = await db.execute(s`
      INSERT INTO leads (company_id, first_name, last_name, phone, email, address, zip, scope, source, lead_source, status, quote_amount, quoted_at, job_id, booked_at, details, referral_source, created_at, updated_at)
      VALUES (${companyId}, ${opts.first_name ?? null}, ${opts.last_name ?? null}, ${opts.phone ?? null}, ${opts.email ?? null},
              ${opts.address ?? null}, ${opts.zip ?? null}, ${opts.scope ?? null}, ${opts.source}, ${opts.source}, ${opts.status},
              ${opts.quoteAmount ?? null}, ${opts.status === "quoted" ? s`NOW()` : s`NULL`},
              ${opts.jobId ?? null}, ${opts.booked ? s`NOW()` : s`NULL`},
              COALESCE(${opts.details ? JSON.stringify(opts.details) : null}::jsonb, '{}'::jsonb),
              ${referral}, NOW(), NOW())
      RETURNING id`);
    return Number((ins.rows as any[])[0]?.id) || null;
  } catch (e) {
    // Non-fatal by design (a DB hiccup must not break the customer's widget),
    // but log with enough context to diagnose a dropped lead — this catch is
    // what silently swallowed the Georgann Gambill lead. Callers now also log
    // when this returns null.
    console.error("[widget-lead] upsert failed:", {
      companyId, email: opts.email, phone: opts.phone, source: opts.source, status: opts.status,
    }, e);
    return null;
  }
}
