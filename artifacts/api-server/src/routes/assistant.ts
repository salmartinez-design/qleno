import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, accountsTable, accountPropertiesTable, usersTable } from "@workspace/db/schema";
import { eq, and, asc, gte, lte, sql } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "../lib/auth.js";
import { parseResRatesRow } from "../lib/commission-rates.js";
import { computeCommissionRows } from "../lib/commission-compute.js";

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

// [assistant-window 2026-06-10] Add days to a YYYY-MM-DD string (UTC math is
// fine — we only need the calendar date, never a wall-clock instant).
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
function weekdayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

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

    // [assistant-window 2026-06-10] Load a rolling window, not just today, so
    // "tomorrow", "this week", "next week", and specific upcoming dates have
    // data. `date` stays "today" (drives now/current-job logic); the schedule
    // payload spans [today .. today+RANGE_DAYS]. Each job carries its date +
    // weekday so the model answers per-day.
    const RANGE_DAYS = 14;
    const fromDate = date;
    const toDate = addDaysYmd(date, RANGE_DAYS);
    const OFFICE_JOB_CAP = 400;

    if (!question) { res.status(400).json({ error: "question required" }); return; }
    if (question.length > 1000) { res.status(400).json({ error: "question too long" }); return; }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("[assistant] ANTHROPIC_API_KEY not set — assistant disabled");
      res.status(503).json({ error: "Assistant is not configured — set ANTHROPIC_API_KEY in Railway" });
      return;
    }

    // [assistant-roles 2026-06-08] Office/admin/owner get COMPANY-WIDE answers
    // (revenue, every tech's schedule, per-tech commission) — data they already
    // see on dispatch + payroll. Technicians stay hard-scoped to their own jobs.
    const role = String((req.auth as any)?.role || "");
    const isOffice = ["owner", "admin", "office", "super_admin"].includes(role);
    const langName = LANG_NAME[language];
    let jobs: any[] = [];
    let system: string;

    if (isOffice) {
      const orows = await db
        .select({
          id: jobsTable.id,
          tech_first: usersTable.first_name,
          tech_last: usersTable.last_name,
          assigned_user_id: jobsTable.assigned_user_id,
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
          account_id: jobsTable.account_id,
          branch_id: jobsTable.branch_id,
          scheduled_date: jobsTable.scheduled_date,
          scheduled_time: jobsTable.scheduled_time,
          allowed_hours: jobsTable.allowed_hours,
          actual_hours: jobsTable.actual_hours,
          base_fee: jobsTable.base_fee,
          billed_amount: jobsTable.billed_amount,
          status: jobsTable.status,
        })
        .from(jobsTable)
        .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
        .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
        .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
        .leftJoin(accountPropertiesTable, eq(jobsTable.account_property_id, accountPropertiesTable.id))
        .where(and(
          eq(jobsTable.company_id, companyId),
          gte(jobsTable.scheduled_date, fromDate),
          lte(jobsTable.scheduled_date, toDate),
          sql`${jobsTable.status} <> 'cancelled'`,
        ))
        .orderBy(asc(jobsTable.scheduled_date), asc(jobsTable.scheduled_time), asc(jobsTable.id))
        .limit(OFFICE_JOB_CAP);

      // Per-job commission via the canonical engine (+ final_pay overrides), so
      // the numbers match what the office sees on the payroll screens.
      let comp: any = { res_tech_pay_pct: 0.35, deep_clean_pay_pct: 0.32, move_in_out_pay_pct: 0.32, commercial_hourly_rate: 20, commercial_comp_mode: "allowed_hours" };
      try {
        const cr = await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
        if (cr.rows[0]) comp = cr.rows[0];
      } catch { /* keep defaults */ }
      const resRates = parseResRatesRow(comp);
      const overrides = new Map<string, number>();
      const ojobIds = orows.map(j => j.id);
      if (ojobIds.length) {
        try {
          const ov = await db.execute(sql`SELECT user_id, job_id, final_pay FROM job_technicians WHERE job_id = ANY(${ojobIds}::int[]) AND final_pay IS NOT NULL`);
          for (const r of ov.rows as any[]) overrides.set(`${r.user_id}:${r.job_id}`, parseFloat(String(r.final_pay)));
        } catch { /* job_technicians absent */ }
      }
      const commRows = computeCommissionRows({
        jobs: orows as any,
        resRates,
        commercial: { commercial_hourly_rate: parseFloat(String(comp.commercial_hourly_rate ?? 20)), commercial_comp_mode: String(comp.commercial_comp_mode ?? "allowed_hours") as any },
        overrides,
      });
      const commByJob = new Map<number, number>();
      for (const cr of commRows) commByJob.set(cr.job_id, (commByJob.get(cr.job_id) ?? 0) + cr.amount);

      jobs = orows.map((r, i) => {
        const cname = r.account_name || r.client_company_name || `${r.client_first_name ?? ""} ${r.client_last_name ?? ""}`.trim() || "Unknown";
        const tech = `${r.tech_first ?? ""} ${r.tech_last ?? ""}`.trim() || "Unassigned";
        const address = fmtAddr(r.address_street, r.address_city, r.address_state, r.address_zip);
        const revenue = parseFloat(String(r.billed_amount ?? r.base_fee ?? 0)) || 0;
        const dstr = r.scheduled_date ? String(r.scheduled_date).slice(0, 10) : null;
        return {
          n: i + 1,
          date: dstr,
          day: dstr ? weekdayOf(dstr) : null,
          tech,
          client: r.property_name ? `${cname} — ${r.property_name}` : cname,
          address: address || null,
          time: r.scheduled_time ? String(r.scheduled_time).slice(0, 5) : null,
          status: r.status,
          revenue: Math.round(revenue * 100) / 100,
          commission: Math.round((commByJob.get(r.id) ?? 0) * 100) / 100,
          allowed_hours: r.allowed_hours != null ? Number(r.allowed_hours) : null,
          actual_hours: r.actual_hours != null ? Number(r.actual_hours) : null,
        };
      });
      const todayJobs = jobs.filter(j => j.date === date);
      const todayRevenue = Math.round(todayJobs.reduce((s, j) => s + j.revenue, 0) * 100) / 100;
      const todayCommission = Math.round(todayJobs.reduce((s, j) => s + j.commission, 0) * 100) / 100;
      const truncated = jobs.length >= OFFICE_JOB_CAP;

      system =
        `You are an assistant for the OFFICE/OWNER (role: ${role}) of a residential & commercial cleaning company using Qleno. ` +
        `Today is ${date} (${weekdayOf(date)})${now ? `, current local time ${now}` : ""}. ` +
        `You have the company's scheduled jobs from ${fromDate} (${weekdayOf(fromDate)}) through ${toDate} (${weekdayOf(toDate)}) — about two weeks. Each job includes its "date" and "day" (weekday). ` +
        `Answer about ANY date or range in that window: "today", "tomorrow" (${addDaysYmd(date, 1)}), "this week", "next week" (the Mon–Sun after this one), or a specific date — by filtering jobs on their "date"/"day" and summing as needed. ` +
        `If asked about a date OUTSIDE ${fromDate}..${toDate}, say you only have the schedule through ${toDate}. ` +
        (truncated ? `NOTE: the schedule was truncated at ${OFFICE_JOB_CAP} jobs, so far-out days may be incomplete; say so if relevant. ` : ``) +
        `Use ONLY this data — never invent numbers, jobs, names, or addresses; if it isn't here, say you don't have it. ` +
        `For a specific technician, match jobs by that tech's name (case-insensitive). All money is USD. ` +
        `When asked which job a technician is on "right now" / "currently" / "at the moment", answer from TODAY's (${date}) schedule and the current local time — do not refuse for lack of GPS. The current job is the latest TODAY job whose scheduled start time is at or before ${now || "now"}; name that client and time, mention the next upcoming job if one remains, and add a brief caveat that this is schedule-based, not live tracking. If their first job today is still in the future, say they haven't started yet. ` +
        `Reply in ${langName}, concise and natural for reading aloud (a few sentences; brief lists for schedules grouped by day). ` +
        `When asked to navigate / get directions to a job, put that job's exact address in "navigate_to"; otherwise null. ` +
        `Respond with ONLY a JSON object: {"answer": string, "navigate_to": string|null}. No other text.\n\n` +
        `Today (${date}) totals: revenue $${todayRevenue.toFixed(2)}, commission $${todayCommission.toFixed(2)}, ${todayJobs.length} jobs. ` +
        `Full window has ${jobs.length} jobs. Compute any other day/week's totals yourself from the per-job revenue/commission + date below.\n` +
        `Jobs (${fromDate}..${toDate}):\n${JSON.stringify(jobs)}`;
    } else {
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
        scheduled_date: jobsTable.scheduled_date,
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
        gte(jobsTable.scheduled_date, fromDate),
        lte(jobsTable.scheduled_date, toDate),
        sql`${jobsTable.status} <> 'cancelled'`,
      ))
      .orderBy(asc(jobsTable.scheduled_date), asc(jobsTable.scheduled_time), asc(jobsTable.id));

    jobs = rows.map((r, i) => {
      const name = r.account_name || r.client_company_name
        || `${r.client_first_name ?? ""} ${r.client_last_name ?? ""}`.trim() || "Unknown";
      const address = fmtAddr(r.address_street, r.address_city, r.address_state, r.address_zip);
      const notes = [r.office_notes, r.notes].filter(Boolean).join(" / ");
      const dstr = r.scheduled_date ? String(r.scheduled_date).slice(0, 10) : null;
      return {
        n: i + 1,
        date: dstr,
        day: dstr ? weekdayOf(dstr) : null,
        client: r.property_name ? `${name} — ${r.property_name}` : name,
        address: address || null,
        time: r.scheduled_time ? String(r.scheduled_time).slice(0, 5) : null,
        allowed_hours: r.allowed_hours != null ? Number(r.allowed_hours) : null,
        service: String(r.service_type || "").replace(/_/g, " "),
        status: r.status,
        notes: notes || null,
      };
    });

    system =
      `You are a friendly, concise voice assistant for a house-cleaning technician using the Qleno app. ` +
      `Today is ${date} (${weekdayOf(date)}).${now ? ` The current local time is ${now}; "my next job" / "next stop" means the earliest job TODAY at or after ${now} (or today's first job if none remain).` : ""} ` +
      `You are given this technician's OWN jobs from ${fromDate} through ${toDate} (about two weeks) as JSON; each job has its "date" and "day" (weekday). ` +
      `Answer about any date in that window — "today", "tomorrow" (${addDaysYmd(date, 1)}), "this week", "next week", or a specific date — by filtering on each job's "date"/"day". If asked about a date outside ${fromDate}..${toDate}, say you only have the schedule through ${toDate}. ` +
      `Answer using ONLY that data — never invent jobs, addresses, times, or notes. ` +
      `If the answer isn't in the data, say you don't have that information. ` +
      // [assistant-guardrail 2026-06-08] Defense-in-depth: pay/commission and
      // other employees' data are NEVER placed in this context, so they can't
      // leak — but instruct an explicit, friendly refusal so a tech who asks
      // "what's my coworker's pay/schedule?" or "is her commission higher?"
      // gets a clean "can't help with that" instead of a guess.
      `You ONLY have this technician's own job schedule — nothing else. You do NOT have pay, wages, commission, hours-as-money, or ANY other person's schedule or information. If asked about pay, commission, earnings, or anyone other than themselves, politely decline in one short sentence (e.g. "I can only help with your own schedule and job details") and set navigate_to to null. Never guess or fabricate such information. ` +
      `Reply in ${langName}. Keep it short and natural for reading aloud (1–3 sentences; for a full schedule give a brief list with time + client). ` +
      `When the technician asks to navigate / get directions / go to a job, choose the intended job (by client name, or the next upcoming job if unspecified) and put its exact address string in "navigate_to". Otherwise "navigate_to" MUST be null. ` +
      `Respond with ONLY a JSON object: {"answer": string, "navigate_to": string|null}. No other text.\n\n` +
      `Technician's jobs (${fromDate}..${toDate}):\n${JSON.stringify(jobs)}`;
    }

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
