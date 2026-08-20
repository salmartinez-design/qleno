import { Router } from "express";
import { tzOf } from "../lib/company-tz.js";
import { db } from "@workspace/db";
import { formSubmissionsTable, formTemplatesTable, clientsTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { generateAgreementPdf, renderAgreementPdf } from "../lib/generate-agreement-pdf.js";
import { renderAgreementCertificate } from "../lib/agreement-certificate.js";
import { createHash } from "crypto";
import { appBaseUrl, emailLogoUrl } from "../lib/app-url.js";
import { sendNotification } from "../services/notificationService.js";
import { agreementEmailShell } from "../lib/phes-agreement-emails.js";
import { notifyOfficeUsers } from "../lib/notify.js";

const router = Router();

const reqIp = (req: any) => (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || req.ip || "";
const reqUa = (req: any) => (req.headers["user-agent"] as string) || "";

router.get("/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const [submission] = await db
      .select({
        id: formSubmissionsTable.id,
        form_id: formSubmissionsTable.form_id,
        client_id: formSubmissionsTable.client_id,
        status: formSubmissionsTable.status,
        responses: formSubmissionsTable.responses,
        expires_at: formSubmissionsTable.expires_at,
        sent_to: formSubmissionsTable.sent_to,
        form_name: formTemplatesTable.name,
        form_type: formTemplatesTable.type,
        form_category: formTemplatesTable.category,
        form_schema: formTemplatesTable.schema,
        terms_body: formTemplatesTable.terms_body,
        terms_body_override: formSubmissionsTable.terms_body_override,
        requires_sign: formTemplatesTable.requires_sign,
        company_id: formSubmissionsTable.company_id,
        company_name: sql<string>`(select name from companies where id = ${formSubmissionsTable.company_id})`,
        company_logo: sql<string | null>`(select logo_url from companies where id = ${formSubmissionsTable.company_id})`,
        company_brand: sql<string | null>`(select brand_color from companies where id = ${formSubmissionsTable.company_id})`,
        // [agreement-brand 2026-08-19] The signing page is a customer-facing
        // surface and was showing a generic file icon and the word "Qleno".
        // It needs the same contact block the emails carry, so the customer
        // can reach a person before signing rather than after.
        company_phone: sql<string | null>`(select phone from companies where id = ${formSubmissionsTable.company_id})`,
        company_email: sql<string | null>`(select email from companies where id = ${formSubmissionsTable.company_id})`,
        client_first: clientsTable.first_name,
        client_last: clientsTable.last_name,
        client_email: clientsTable.email,
        client_phone: clientsTable.phone,
        client_address: clientsTable.address,
      })
      .from(formSubmissionsTable)
      .leftJoin(formTemplatesTable, eq(formSubmissionsTable.form_id, formTemplatesTable.id))
      .leftJoin(clientsTable, eq(formSubmissionsTable.client_id, clientsTable.id))
      .where(eq(formSubmissionsTable.sign_token, token))
      .limit(1);

    if (!submission) {
      return res.status(404).json({ error: "Agreement not found" });
    }

    // Per-send edited text wins over the template body.
    const effectiveTerms = (submission as any).terms_body_override || submission.terms_body;

    if (submission.status === "signed") {
      return res.json({ ...submission, terms_body: effectiveTerms, already_signed: true });
    }

    if (submission.expires_at && new Date() > new Date(submission.expires_at)) {
      await db
        .update(formSubmissionsTable)
        .set({ status: "expired" })
        .where(eq(formSubmissionsTable.sign_token, token));
      return res.status(410).json({ error: "This agreement link has expired" });
    }

    // [agreement-multi-view 2026-07-22] Record EVERY view, not just the first.
    // This used to fire once (guarded on viewed_at IS NULL), so an agreement
    // opened five times looked identical to one opened once — the office had no
    // way to see a client reading it repeatedly before signing. DocuSign logs
    // each open; so do we now. viewed_at stays the FIRST view (that is what the
    // existing UI means by it); last_viewed_at and view_count track the rest,
    // and every open lands in agreement_events, which the Certificate of
    // Completion already prints in full.
    //
    // A 15-second same-IP window absorbs double-fires from one page load (a
    // quick refresh, a re-mount) without hiding a genuine separate visit.
    try {
      const ip = reqIp(req);
      const recent: any = await db.execute(sql`
        SELECT 1 FROM agreement_events
         WHERE agreement_id = ${submission.id} AND company_id = ${submission.company_id}
           AND event_type = 'viewed' AND ip_address = ${ip}
           AND created_at > now() - interval '15 seconds'
         LIMIT 1`);
      if (((recent as any).rows?.length ?? 0) === 0) {
        await db.execute(sql`
          UPDATE form_submissions
             SET viewed_at = COALESCE(viewed_at, now()),
                 last_viewed_at = now(),
                 view_count = COALESCE(view_count, 0) + 1
           WHERE sign_token = ${token}`);
        await db.execute(sql`INSERT INTO agreement_events (company_id, agreement_id, event_type, actor_email, ip_address, user_agent)
          VALUES (${submission.company_id}, ${submission.id}, 'viewed', ${submission.sent_to ?? null}, ${ip}, ${reqUa(req)})`);
      }
    } catch (e) { console.error("viewed-event (non-fatal):", e); }

    return res.json({ ...submission, terms_body: effectiveTerms, already_signed: false });
  } catch (err) {
    console.error("Get sign token error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { responses, signature_name, ip_address, agreed } = req.body;

    const [submission] = await db
      .select({
        id: formSubmissionsTable.id,
        form_id: formSubmissionsTable.form_id,
        client_id: formSubmissionsTable.client_id,
        company_id: formSubmissionsTable.company_id,
        status: formSubmissionsTable.status,
        expires_at: formSubmissionsTable.expires_at,
        sent_to: formSubmissionsTable.sent_to,
        form_name: formTemplatesTable.name,
        terms_body: formTemplatesTable.terms_body,
        terms_body_override: formSubmissionsTable.terms_body_override,
        company_name: sql<string>`(select name from companies where id = ${formSubmissionsTable.company_id})`,
        // The signed-copy email greets the customer by name and needs somewhere
        // to send it. sent_to is the address the link went to; first_name comes
        // off the client so the email reads like the rest of our mail.
        client_first_name: sql<string>`(select first_name from clients where id = ${formSubmissionsTable.client_id})`,
        client_name: sql<string>`(select trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from clients where id = ${formSubmissionsTable.client_id})`,
      })
      .from(formSubmissionsTable)
      .leftJoin(formTemplatesTable, eq(formSubmissionsTable.form_id, formTemplatesTable.id))
      .where(eq(formSubmissionsTable.sign_token, token))
      .limit(1);

    if (!submission) {
      return res.status(404).json({ error: "Agreement not found" });
    }

    if (submission.status === "signed") {
      return res.status(409).json({ error: "Agreement already signed" });
    }

    if (submission.expires_at && new Date() > new Date(submission.expires_at)) {
      return res.status(410).json({ error: "Agreement link has expired" });
    }

    // [agreement-esign] ESIGN/UETA: the signer must affirm consent + sign.
    if (!signature_name || !agreed) {
      return res.status(400).json({ error: "Signature and consent are required" });
    }

    const signedAt = new Date();
    const ua = reqUa(req);
    // [agreement-ip 2026-08-19] The IP on a signature record is evidence, so it
    // comes from the connection, never from the request body. The page used to
    // post its own ip_address field and we honored anything that was not the
    // literal string "client" - meaning the one number a challenger would care
    // about was whatever the signer's browser felt like claiming. The field is
    // still accepted and ignored so older clients keep working.
    const ip = reqIp(req);
    // [agreement-hash-covers-body 2026-08-19] The hash MUST include the exact
    // words that were signed. It used to cover only the signature act
    // (responses + name + timestamp + token), so the agreement text itself was
    // outside the seal: edit terms_body_override afterwards and the stored hash
    // still verified clean. That is the one thing a signature hash exists to
    // make impossible. terms_body_override is the frozen per-send copy and is
    // what the signer actually read, with the template body as the fallback for
    // rows sent before merge-at-send existed.
    const signedBody = (submission as any).terms_body_override || submission.terms_body || "";
    const contentToHash = JSON.stringify({
      terms_body: signedBody, responses, signature_name, signed_at: signedAt.toISOString(), token,
    });
    const contentHash = createHash("sha256").update(contentToHash).digest("hex");

    // [agreement-brand 2026-08-19] The tenant's own mark, absolutized -
    // companies.logo_url usually holds a relative path, which neither a mail
    // client nor the PDF fetcher can resolve. Looked up here rather than at
    // the email below because the signed PDF prints it too.
    const coLogo: any = (await db.execute(sql`
      SELECT logo_url FROM companies WHERE id = ${submission.company_id} LIMIT 1
    `)).rows[0];
    const agreementLogoUrl = emailLogoUrl(coLogo?.logo_url ?? null);

    let pdfUrl: string | null = null;
    try {
      pdfUrl = await generateAgreementPdf({
        submissionId: submission.id,
        formName: submission.form_name || "Service Agreement",
        companyName: submission.company_name || "",
        logoUrl: agreementLogoUrl,
        termsBody: signedBody,
        responses: responses || {},
        signatureName: signature_name,
        signedAt: signedAt.toLocaleString("en-US", { timeZone: tzOf(submission.company_id) }),
        ipAddress: ip,
        contentHash,
      });
    } catch (pdfErr) {
      console.error("Agreement PDF generation error (non-fatal):", pdfErr);
    }

    const [updated] = await db
      .update(formSubmissionsTable)
      .set({
        responses: responses || {},
        status: "signed",
        submitted_at: signedAt,
        signature_name,
        signature_at: signedAt,
        ip_address: ip,
        content_hash: contentHash,
        pdf_url: pdfUrl,
      })
      .where(eq(formSubmissionsTable.sign_token, token))
      .returning();

    // [agreement-esign] Capture consent + device and seal the audit trail.
    await db.execute(sql`UPDATE form_submissions SET consent_at = now(), user_agent = ${ua} WHERE sign_token = ${token}`);
    await db.execute(sql`INSERT INTO agreement_events (company_id, agreement_id, event_type, actor_email, ip_address, user_agent)
      VALUES (${submission.company_id}, ${submission.id}, 'signed', ${submission.sent_to ?? null}, ${ip}, ${ua})`);
    await db.execute(sql`INSERT INTO agreement_events (company_id, agreement_id, event_type) VALUES (${submission.company_id}, ${submission.id}, 'sealed')`);

    console.log(`[AGREEMENT SIGNED] submission_id=${submission.id} name="${signature_name}" ip=${ip} hash=${contentHash.slice(0, 16)}...`);

    // [agreement-signed-copy 2026-08-19] Send the customer their copy, and tell
    // the office the contract landed.
    //
    // Until now a signature was a silent event: the customer clicked Sign, saw a
    // confirmation screen, closed the tab and had nothing. Nothing arrived in
    // their inbox, so months later there was no copy to find, and E-SIGN's whole
    // premise is that the signer can retain the record. The office learned about
    // it only by opening the client profile and noticing.
    //
    // The link is the durable route below, not pdf_url - pdf_url points at
    // Railway's ephemeral disk and dies on the next deploy, which for an email
    // the customer keeps is the same as never sending one.
    const agreementLink = `${appBaseUrl()}/api/sign/${token}/agreement.pdf`;
    const signedAtDisplay = signedAt.toLocaleString("en-US", {
      timeZone: tzOf(submission.company_id),
      dateStyle: "long",
      timeStyle: "short",
    });
    if (submission.sent_to) {
      // Transactional: the customer just signed a contract and is owed the copy.
      // Dropping it because the tenant's marketing gate is off would leave them
      // with no record of what they agreed to.
      sendNotification(
        "agreement_signed", "email", submission.company_id, submission.sent_to, null,
        {
          first_name: String((submission as any).client_first_name || "").trim(),
          agreement_name: submission.form_name || "Service Agreement",
          agreement_link: agreementLink,
          signed_name: String(signature_name || "").trim(),
          signed_at: signedAtDisplay,
        },
        true,
        (bodyHtml, vars) => agreementEmailShell({
          logoUrl: agreementLogoUrl,
          companyName: vars.company_name,
          companyPhone: vars.company_phone,
          companyEmail: vars.company_email,
          title: `Your signed ${vars.company_name || "Phes"} service agreement`,
          banner: "Signed. Here is your copy",
        }, bodyHtml),
      ).catch((e) => console.error("[agreement-signed] copy email failed (non-fatal):", e));
    }
    notifyOfficeUsers(submission.company_id, {
      type: "agreement_signed",
      title: `${String((submission as any).client_name || signature_name).trim()} signed the ${submission.form_name || "service agreement"}`,
      body: `Signed ${signedAt.toLocaleString("en-US", { timeZone: tzOf(submission.company_id) })}. A copy went to ${submission.sent_to || "the customer"}.`,
      link: submission.client_id ? `/customers/${submission.client_id}` : "/settings/forms",
      meta: {
        submission_id: submission.id,
        client_id: submission.client_id ?? null,
        content_hash: contentHash,
      },
    }).catch((e) => console.error("[agreement-signed] office alert failed (non-fatal):", e));

    return res.json({
      success: true,
      submission_id: updated.id,
      signed_at: signedAt,
      pdf_url: pdfUrl,
      content_hash: contentHash,
    });
  } catch (err) {
    console.error("Sign agreement error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [agreement-signed-copy 2026-08-19] The durable signed copy. generateAgreementPdf
// writes a file to Railway's disk and hands back an /api/pdfs/<name> URL, which
// is fine for the link on the confirmation screen and useless for anything the
// customer keeps: that disk is wiped on every deploy. This route re-renders the
// same document from the row itself, so the link in the signed-copy email still
// opens the contract a year from now. Public by token, same as the certificate.
router.get("/:token/agreement.pdf", async (req, res) => {
  try {
    const { token } = req.params;
    const rows = await db.execute(sql`
      SELECT fs.id, fs.company_id, fs.responses, fs.signature_name, fs.signature_at,
             fs.ip_address, fs.content_hash, fs.status, fs.terms_body_override,
             ft.name AS form_name, ft.terms_body, c.name AS company_name,
             c.logo_url AS company_logo
        FROM form_submissions fs
        LEFT JOIN form_templates ft ON ft.id = fs.form_id
        LEFT JOIN companies c ON c.id = fs.company_id
       WHERE fs.sign_token = ${token} LIMIT 1
    `);
    const s: any = (rows as any).rows[0];
    if (!s) return res.status(404).json({ error: "Not Found" });
    if (s.status !== "signed") return res.status(409).json({ error: "Agreement has not been signed yet" });

    const pdf = await renderAgreementPdf({
      submissionId: s.id,
      formName: s.form_name || "Service Agreement",
      companyName: s.company_name || "",
      logoUrl: emailLogoUrl(s.company_logo ?? null),
      // The frozen per-send copy is what the customer read and what the hash
      // covers. Falling back to the template body would show them a document
      // that is not the one they signed.
      termsBody: s.terms_body_override || s.terms_body || "",
      responses: (s.responses as Record<string, string>) || {},
      signatureName: s.signature_name || "",
      signedAt: s.signature_at
        ? new Date(s.signature_at).toLocaleString("en-US", { timeZone: tzOf(s.company_id) })
        : "",
      ipAddress: s.ip_address || "",
      contentHash: s.content_hash || "",
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="signed-agreement.pdf"`);
    return res.end(pdf);
  } catch (err) {
    console.error("Agreement PDF error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [agreement-esign] Certificate of Completion (audit trail) — public by token so
// the signer can keep their copy too.
router.get("/:token/certificate.pdf", async (req, res) => {
  try {
    const { token } = req.params;
    const rows = await db.execute(sql`
      SELECT fs.id, fs.company_id, fs.content_hash, fs.signature_name, fs.signature_at, fs.consent_at, fs.sent_to, fs.status,
             ft.name AS form_name, c.name AS company_name
      FROM form_submissions fs
      LEFT JOIN form_templates ft ON ft.id = fs.form_id
      LEFT JOIN companies c ON c.id = fs.company_id
      WHERE fs.sign_token = ${token} LIMIT 1
    `);
    const s: any = (rows as any).rows[0];
    if (!s) return res.status(404).json({ error: "Not Found" });
    const evs = await db.execute(sql`
      SELECT event_type, created_at, ip_address, user_agent, actor_email
      FROM agreement_events WHERE agreement_id = ${s.id} AND company_id = ${s.company_id} ORDER BY created_at ASC, id ASC
    `);
    const pdf = await renderAgreementCertificate({
      companyName: s.company_name || "",
      agreementTitle: s.form_name || "Service Agreement",
      envelopeId: `QL-${String(token).slice(0, 8).toUpperCase()}`,
      signerName: s.signature_name, signerEmail: s.sent_to,
      status: s.status === "signed" ? "completed" : s.status,
      contentHash: s.content_hash || "not recorded",
      consent: !!s.consent_at,
      events: ((evs as any).rows || []).map((e: any) => ({
        type: e.event_type, at: e.created_at, ip: e.ip_address, userAgent: e.user_agent, email: e.actor_email,
      })),
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="certificate-of-completion.pdf"`);
    return res.end(pdf);
  } catch (err) {
    console.error("Certificate error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
