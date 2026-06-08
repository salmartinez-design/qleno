import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, accountsTable, accountPropertiesTable } from "@workspace/db/schema";
import { eq, and, asc, sql } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "../lib/auth.js";

// [voice-assistant 2026-06-08] Field-tech voice assistant. The mobile app
// transcribes the tech's spoken question (browser speech-to-text), POSTs it
// here, and we answer using ONLY that tech's own jobs for the day via Claude.
// Read-only + navigation; bilingual (English/Spanish). Reuses the same Anthropic
// setup as routes/translate.ts (ANTHROPIC_API_KEY, claude-haiku-4-5 — cheap +
// fast, ideal for short voice turns).
//
// PRIVACY: the query is hard-scoped to assigned_user_id = the authenticated
// user. A tech can never see another tech's jobs through the assistant.

const router = Router();

const LANG_NAME: Record<string, string> = { en: "English", es: "Spanish" };

function fmtAddr(street?: string | null, city?: string | null, state?: string | null, zip?: string | null): string {
  const s = (v: any) => (v == null ? "" : String(v).trim());
  const parts: string[] = [];
  if (s(street)) parts.push(s(street));
  if (s(city)) parts.push(s(city));
  const sz = [s(state), s(zip)].filter(Boolean).join(" ");
  if (sz) parts.push(sz);
  return parts.join(", ");
}

router.post("/ask", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId as number;
    const companyId = req.auth!.companyId as number;
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    const language = req.body?.language === "es" ? "es" : "en";
    // Prefer the client's LOCAL date so an evening tech (UTC rollover) still
    // gets today's jobs, not tomorrow's.
    const date = typeof req.body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
      ? req.body.date
      : new Date().toISOString().slice(0, 10);
    // Client's local time (HH:MM) so "my next job" resolves against now.
    const now = typeof req.body?.now === "string" && /^\d{1,2}:\d{2}/.test(req.body.now)
      ? req.body.now.slice(0, 5)
      : null;

    if (!question) { res.status(400).json({ error: "question required" }); return; }
    if (question.length > 1000) { res.status(400).json({ error: "question too long" }); return; }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("[assistant] ANTHROPIC_API_KEY not set — assistant disabled");
      res.status(503).json({ error: "Assistant is not configured — set ANTHROPIC_API_KEY in Railway" });
      return;
    }

    // The tech's OWN jobs for the day (privacy: assigned_user_id = the caller).
    // Address resolves account_property → client, mirroring routes/tech.ts.
    const rows = await db
      .select({
        id: jobsTable.id,
        client_first_name: clientsTable.first_name,
        client_last_name: clientsTable.last_name,
        client_company_name: clientsTable.company_name,
        account_name: accountsTable.account_name,
        property_name: accountPropertiesTable.property_name,
        address_street: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.address} ELSE ${clientsTable.address} END`,
        address_city: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.city} ELSE ${clientsTable.city} END`,
        address_state: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.state} ELSE ${clientsTable.state} END`,
        address_zip: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.zip} ELSE ${clientsTable.zip} END`,
        service_type: jobsTable.service_type,
        scheduled_time: jobsTable.scheduled_time,
        allowed_hours: jobsTable.allowed_hours,
        status: jobsTable.status,
        frequency: jobsTable.frequency,
        notes: jobsTable.notes,
        office_notes: jobsTable.office_notes,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(accountPropertiesTable, eq(jobsTable.account_property_id, accountPropertiesTable.id))
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.assigned_user_id, userId),
        eq(jobsTable.scheduled_date, date),
      ))
      .orderBy(asc(jobsTable.scheduled_time), asc(jobsTable.id));

    const jobs = rows.map((r, i) => {
      const name = r.account_name || r.client_company_name
        || `${r.client_first_name ?? ""} ${r.client_last_name ?? ""}`.trim() || "Unknown";
      const address = fmtAddr(r.address_street, r.address_city, r.address_state, r.address_zip);
      const notes = [r.office_notes, r.notes].filter(Boolean).join(" / ");
      return {
        n: i + 1,
        client: r.property_name ? `${name} — ${r.property_name}` : name,
        address: address || null,
        time: r.scheduled_time ? String(r.scheduled_time).slice(0, 5) : null,
        allowed_hours: r.allowed_hours != null ? Number(r.allowed_hours) : null,
        service: String(r.service_type || "").replace(/_/g, " "),
        status: r.status,
        notes: notes || null,
      };
    });

    const langName = LANG_NAME[language];
    const system =
      `You are a friendly, concise voice assistant for a house-cleaning technician using the Qleno app. ` +
      `Today is ${date}.${now ? ` The current local time is ${now}; "my next job" / "next stop" means the earliest job scheduled at or after ${now} (or the first job today if none remain).` : ""} You are given ONLY this technician's own jobs for the day as JSON. ` +
      `Answer the technician's question using ONLY that data — never invent jobs, addresses, times, or notes. ` +
      `If the answer isn't in the data, say you don't have that information. ` +
      // [assistant-guardrail 2026-06-08] Defense-in-depth: pay/commission and
      // other employees' data are NEVER placed in this context, so they can't
      // leak — but instruct an explicit, friendly refusal so a tech who asks
      // "what's my coworker's pay/schedule?" or "is her commission higher?"
      // gets a clean "can't help with that" instead of a guess.
      `You ONLY have this technician's own job schedule for today — nothing else. You do NOT have pay, wages, commission, hours-as-money, or ANY other person's schedule or information. If asked about pay, commission, earnings, or anyone other than themselves, politely decline in one short sentence (e.g. "I can only help with your own schedule and job details") and set navigate_to to null. Never guess or fabricate such information. ` +
      `Reply in ${langName}. Keep it short and natural for reading aloud (1–3 sentences; for a full schedule give a brief list with time + client). ` +
      `When the technician asks to navigate / get directions / go to a job, choose the intended job (by client name, or the next upcoming job if unspecified) and put its exact address string in "navigate_to". Otherwise "navigate_to" MUST be null. ` +
      `Respond with ONLY a JSON object: {"answer": string, "navigate_to": string|null}. No other text.\n\n` +
      `Technician's jobs for ${date}:\n${JSON.stringify(jobs)}`;

    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system,
      messages: [
        { role: "user", content: question },
        // Prefill an opening brace to force a clean JSON object back.
        { role: "assistant", content: "{" },
      ],
    });

    const raw = "{" + response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("");

    let answer = "";
    let navigateTo: string | null = null;
    try {
      const parsed = JSON.parse(raw);
      answer = typeof parsed.answer === "string" ? parsed.answer : "";
      navigateTo = typeof parsed.navigate_to === "string" && parsed.navigate_to.trim() ? parsed.navigate_to.trim() : null;
    } catch {
      answer = raw.replace(/^\{/, "").trim();
    }
    if (!answer) answer = language === "es" ? "No tengo esa información." : "I don't have that information.";

    res.json({
      answer,
      language,
      job_count: jobs.length,
      navigate_to: navigateTo,
      navigate_url: navigateTo ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(navigateTo)}` : null,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });
  } catch (e: any) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error("[assistant] Auth error:", e.message);
      res.status(503).json({ error: "Assistant auth failed — check ANTHROPIC_API_KEY" });
      return;
    }
    if (e instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: "Assistant temporarily rate-limited — try again in a moment" });
      return;
    }
    console.error("[assistant] Error:", e);
    res.status(500).json({ error: "Assistant failed", message: e?.message });
  }
});

export default router;
