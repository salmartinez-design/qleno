import { Router } from "express";
import { db } from "@workspace/db";
import { formSubmissionsTable, formTemplatesTable, clientsTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { generateAgreementPdf } from "../lib/generate-agreement-pdf.js";
import { createHash } from "crypto";

const router = Router();

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

    if (submission.status === "signed") {
      return res.json({ ...submission, already_signed: true });
    }

    if (submission.expires_at && new Date() > new Date(submission.expires_at)) {
      await db
        .update(formSubmissionsTable)
        .set({ status: "expired" })
        .where(eq(formSubmissionsTable.sign_token, token));
      return res.status(410).json({ error: "This agreement link has expired" });
    }

    return res.json({ ...submission, already_signed: false });
  } catch (err) {
    console.error("Get sign token error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { responses, signature_name, ip_address } = req.body;

    const [submission] = await db
      .select({
        id: formSubmissionsTable.id,
        form_id: formSubmissionsTable.form_id,
        client_id: formSubmissionsTable.client_id,
        company_id: formSubmissionsTable.company_id,
        status: formSubmissionsTable.status,
        expires_at: formSubmissionsTable.expires_at,
        form_name: formTemplatesTable.name,
        terms_body: formTemplatesTable.terms_body,
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

    const signedAt = new Date();
    const contentToHash = JSON.stringify({ responses, signature_name, signed_at: signedAt.toISOString(), token });
    const contentHash = createHash("sha256").update(contentToHash).digest("hex");

    let pdfUrl: string | null = null;
    try {
      pdfUrl = await generateAgreementPdf({
        submissionId: submission.id,
        formName: submission.form_name || "Service Agreement",
        companyName: submission.company_name || "CleanOps Pro",
        termsBody: submission.terms_body || "",
        responses: responses || {},
        signatureName: signature_name,
        signedAt: signedAt.toLocaleString("en-US", { timeZone: "America/Chicago" }),
        ipAddress: ip_address || req.ip || "unknown",
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
        ip_address: ip_address || req.ip || "unknown",
        content_hash: contentHash,
        pdf_url: pdfUrl,
      })
      .where(eq(formSubmissionsTable.sign_token, token))
      .returning();

    console.log(`[AGREEMENT SIGNED] submission_id=${submission.id} name="${signature_name}" ip=${ip_address} hash=${contentHash.slice(0, 16)}...`);

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

export default router;
