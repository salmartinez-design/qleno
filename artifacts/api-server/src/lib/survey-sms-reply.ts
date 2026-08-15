/**
 * [survey-sms-reply 2026-08-15] Recording a satisfaction survey response, from
 * the web page OR from a plain text message back.
 *
 * Maribel's report: customers get the survey text, reply "4", and nothing
 * happens — the survey sits unanswered forever. Two things were wrong.
 *
 * 1. The SMS never told them they *could* reply; it only carried a link. Fixed
 *    in SURVEY_SMS (lib/sms-copy.ts).
 * 2. There was rating-parsing code, in routes/sms-inbound.ts, but it has never
 *    once run in production. It resolves the tenant with
 *    `companies.twilio_from_number = <our number>`, and Phes keeps its Twilio
 *    numbers on the BRANCHES (companies.twilio_from_number is NULL for co1), so
 *    the lookup found no row and the handler returned empty TwiML. Verified
 *    against production: zero rows in `scorecards` have ever been written by it.
 *    It also wrote to the legacy `scorecards` table and never touched
 *    `satisfaction_surveys`, so even had it fired, the open survey would have
 *    stayed open. Same branch-number bug class already fixed for STOP in that
 *    same file.
 *
 * The live inbound webhook is `/api/comms/inbound` (553 inbound messages in the
 * last 30 days; it resolves the tenant through `resolveTenantByNumber`, which
 * checks branch numbers). So that is where reply-parsing belongs, and this
 * module is the shared body so the web page and the text message can never
 * drift apart: both go through `recordSurveyResponse`.
 *
 * The gate is deliberately narrow. We interpret an inbound message as a rating
 * ONLY when the sender has an actually-open survey and the message is nothing
 * but a digit. A customer texting "Can you come Tuesday?" — or "4 people will
 * be home" — is a real message for the office, not a score. The old code did
 * the opposite: it read the FIRST CHARACTER of every inbound text as a rating
 * and auto-replied "Please reply with 1, 2, 3, or 4" to anything else.
 */
import { db } from "@workspace/db";
import { satisfactionSurveysTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { captureSurveyScore } from "./scorecard-engine.js";
import type { SatisfactionSurvey } from "@workspace/db/schema";

/**
 * How long after we send the survey a bare digit still reads as its answer.
 * Past this the customer is answering something else, or nothing.
 */
export const SURVEY_REPLY_WINDOW_DAYS = 7;

/**
 * A rating, or null if this message isn't one.
 *
 * The whole message must be a single 0-4 digit (trailing punctuation and an
 * emoji-free "4!" are fine). Anything with words in it is a real message.
 * The scale is the same 0-4 the survey page shows — 4 Thrilled … 0 Considering
 * Another Company — NOT the 1-4 the dead legacy handler used.
 */
export function parseSurveyRating(body: string): number | null {
  const cleaned = String(body ?? "").trim().replace(/[.!\s]+$/, "");
  if (!/^[0-4]$/.test(cleaned)) return null;
  return Number(cleaned);
}

/**
 * The client's open survey, if they have one worth answering: sent, not yet
 * responded to, not suppressed, inside the reply window. Most recent wins.
 */
export async function findOpenSurveyForClient(
  companyId: number,
  clientId: number,
): Promise<SatisfactionSurvey | null> {
  const rows = await db.execute(sql`
    SELECT * FROM satisfaction_surveys
     WHERE company_id = ${companyId}
       AND customer_id = ${clientId}
       AND responded_at IS NULL
       AND suppressed = false
       AND coalesce(sent_at, created_at) > now() - make_interval(days => ${SURVEY_REPLY_WINDOW_DAYS})
     ORDER BY coalesce(sent_at, created_at) DESC
     LIMIT 1`);
  return (rows.rows[0] as SatisfactionSurvey | undefined) ?? null;
}

/**
 * Write a response onto a survey and push the score at the tech's scorecard.
 *
 * This is the ONE place a survey gets answered. `/api/satisfaction/respond`
 * (the web page) and the inbound-SMS path both call it, so a text reply and a
 * tap produce byte-identical state — including `follow_up_required`, which is
 * what puts a bad score in front of the office.
 */
export async function recordSurveyResponse(opts: {
  token: string;
  survey_score?: number | null;
  nps_score?: number | null;
  rating?: number | null;
  comment?: string | null;
}): Promise<SatisfactionSurvey> {
  const { token, nps_score = null, rating = null, comment = null } = opts;

  const score04 =
    opts.survey_score != null && Number.isFinite(Number(opts.survey_score))
      ? Math.max(0, Math.min(4, Math.round(Number(opts.survey_score))))
      : null;

  // Follow-up when the 0-4 score signals concerns (<=2), or legacy NPS <=6.
  const follow_up_required =
    (score04 != null && score04 <= 2) || (nps_score != null && nps_score <= 6);

  const [updated] = await db
    .update(satisfactionSurveysTable)
    .set({
      survey_score: score04,
      nps_score,
      rating,
      comment: comment || null,
      responded_at: new Date(),
      follow_up_required,
    })
    .where(eq(satisfactionSurveysTable.token, token))
    .returning();

  // Attribute the 0-4 to the job's tech(s) -> scorecard_entries -> recompute.
  if (score04 != null && updated?.job_id) {
    try {
      const jobRow = await db.execute(sql`
        SELECT scheduled_date FROM jobs WHERE id = ${updated.job_id} LIMIT 1`);
      const dt = (jobRow.rows[0] as any)?.scheduled_date;
      const entryDate = dt
        ? String(dt instanceof Date ? dt.toISOString() : dt).slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      await captureSurveyScore({
        companyId: updated.company_id,
        jobId: updated.job_id,
        surveyId: updated.id,
        score: score04,
        entryDate,
        notes: comment || null,
      });
    } catch (e: any) {
      console.error(
        "[survey] scorecard capture failed (non-fatal):",
        e?.message ?? e,
      );
    }
  }

  return updated;
}

/**
 * Try to read an inbound text as a survey answer.
 *
 * Returns an acknowledgement to text back, or null when this message is not a
 * survey reply — in which case the caller must do nothing extra. Never replies
 * to a message it didn't consume; a customer asking a question deserves a
 * person, not a bot telling them to press a number.
 */
export async function handleSurveySmsReply(
  companyId: number,
  clientId: number | null,
  body: string,
  firstName?: string | null,
): Promise<string | null> {
  if (clientId == null) return null;

  const score = parseSurveyRating(body);
  if (score == null) return null;

  const survey = await findOpenSurveyForClient(companyId, clientId);
  if (!survey) return null;

  await recordSurveyResponse({
    token: survey.token,
    survey_score: score,
    comment: `Rated ${score}/4 by text reply.`,
  });

  // The caller hands us whatever it matched the phone to, which is a full name
  // ("Sal Martinez"). Texting someone their own surname reads like a form letter.
  const name = (firstName || "").trim().split(/\s+/)[0] ?? "";
  const hi = name ? `Thank you, ${name}!` : "Thank you!";
  return score >= 3
    ? `${hi} We're glad we could help - we appreciate you taking a second to rate us.`
    : `${hi} We've recorded your rating and someone from our office will follow up with you.`;
}
