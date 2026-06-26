import { Router } from "express";
import { db } from "@workspace/db";
import { formSubmissionsTable, formTemplatesTable, clientsTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { generateAgreementPdf } from "../lib/generate-agreement-pdf.js";
import { renderAgreementCertificate } from "../lib/agreement-certificate.js";
import { createHash } from "crypto";

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

    // [agreement-esign] Record the first 'viewed' event for the audit trail.
    try {
      const upd: any = await db.execute(sql`UPDATE form_submissions SET viewed_at = now() WHERE sign_token = ${token} AND viewed_at IS NULL AND status <> 'signed'`);
      if ((upd?.rowCount ?? 0) > 0) {
        await db.execute(sql`INSERT INTO agreement_events (company_id, agreement_id, event_type, actor_email, ip_address, user_agent)
          VALUES (${submission.company_id}, ${submission.id}, 'viewed', ${submission.sent_to ?? null}, ${reqIp(req)}, ${reqUa(req)})`);
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
    const ip = ip_address && ip_address !== "client" ? ip_address : reqIp(req);
    const contentToHash = JSON.stringify({ responses, signature_name, signed_at: signedAt.toISOString(), token });
    const contentHash = createHash("sha256").update(contentToHash).digest("hex");

    let pdfUrl: string | null = null;
    try {
      pdfUrl = await generateAgreementPdf({
        submissionId: submission.id,
        formName: submission.form_name || "Service Agreement",
        companyName: submission.company_name || "Qleno",
        termsBody: (submission as any).terms_body_override || submission.terms_body || "",
        responses: responses || {},
        signatureName: signature_name,
        signedAt: signedAt.toLocaleString("en-US", { timeZone: "America/Chicago" }),
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
      companyName: s.company_name || "Qleno",
      agreementTitle: s.form_name || "Service Agreement",
      envelopeId: `QL-${String(token).slice(0, 8).toUpperCase()}`,
      signerName: s.signature_name, signerEmail: s.sent_to,
      status: s.status === "signed" ? "completed" : s.status,
      contentHash: s.content_hash || "—",
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
