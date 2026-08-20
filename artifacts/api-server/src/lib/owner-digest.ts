import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { jobRevenueExpr } from "./job-revenue-sql.js";
import { companyDateStr, tzOf } from "./company-tz.js";
import { ctDate } from "./ct-day.js";
import { resolveSender, sendSmsVia } from "./comms-sender.js";
import { notifyUser } from "./notify.js";

// [owner-digest 2026-08-19] The 6 PM daily owner recap.
//
// Sal: "Every day I need a automatic text message at 6 PM letting me know as
// the owner [...] how many leads we got, how many were from the office, how
// many were web leads [...] how many were done by Francisco, how many by
// Maribel, how many closed, the revenue for the day, how the revenue for the
// week looks, our close rate, total revenue booked that day, and if there was
// any discounting done."
//
// EVERY NUMBER HERE REUSES AN EXISTING DEFINITION. That is the whole point.
// A digest that computes revenue its own way becomes a second set of books,
// and the first time it disagrees with the board the owner stops trusting
// both. So:
//   - revenue           → jobRevenueExpr (lib/job-revenue-sql.ts), the same
//                         expression the dispatch week-summary and the revenue
//                         forecast sum.
//   - web vs office     → the exact predicate routes/leads.ts uses for the
//                         board's source split.
//   - close rate        → booked / (booked + lost), the definition in
//                         routes/lead-analytics.ts. Lost = no_response +
//                         not_interested.
//   - who worked it     → leads.assigned_to, which the board auto-claims on a
//                         staffer's first action. Same column the breakdown
//                         panel groups "who booked" by.
// If one of those definitions changes, this file must follow it, not fork it.
//
// WINDOWS, stated plainly so no line can be read two ways:
//   Serviced today   = visits ON today's calendar (scheduled_date = today),
//                      cancelled excluded. What the crews were out doing.
//   Booked today     = work PUT ON THE BOOKS today (jobs.created_at = today),
//                      whatever day it is scheduled for. New money won today.
//                      These two are different questions and Sal asked both.
//   Week             = Sunday through Saturday containing today, matching the
//                      dispatch week-summary window so the two agree.
//
// TIMEZONE. Every audit stamp in this schema (leads.created_at, jobs.created_at,
// job_rate_mods.created_at) is `timestamp WITHOUT time zone` holding a UTC
// instant, so a bare `created_at >= '2026-08-19'::date` buckets the day on UTC
// midnight — 7:00 PM the previous evening in Central. A recap that fires at
// 6 PM would then be reporting a window that started last night and ends an
// hour from now. Every timestamp window here therefore goes through
// ctDate(col, tz) (lib/ct-day.ts), the same helper the leads board and the
// dashboard "booked today" tile use. jobs.scheduled_date is a real DATE with no
// instant behind it and is compared directly.
//
// CLOSE RATE: ONE FORMULA, FOUR WINDOWS. Sal asked for the day, the day per
// staffer, and a running month on top of the trend line. The temptation is to
// define a day rate differently (booked / all leads that came in) because a day
// has so few decided leads. Resist it: that is the MaidCentral "efficiency
// means three things" trap, and two numbers under one word is how an owner
// stops trusting both. Every window here is the SAME expression --
// booked / (booked + lost) -- over a different slice of leads.created_at:
//   today's leads / today's leads per staffer / month to date / last 30 days.
// The honest caveat is sample size, not formula, so the day line also prints
// how many of today's leads are still undecided. A 100% day over two decided
// leads reads correctly when the third number says eight are still open.

const num = (v: any) => Number(v) || 0;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/** Entered through the website widget rather than typed in by the office. */
const WEB = sql`(COALESCE(NULLIF(l.source,''), l.lead_source) IN ('web_quote','website','booking_widget') OR l.lead_source = 'web_quote')`;

/** The two halves of every close rate in this file. A lead that is still
 *  'quoted' or 'contacted' is neither, and belongs in neither half. */
const WON  = sql`l.status = 'booked'`;
const LOST = sql`l.status IN ('no_response','not_interested')`;

export type DigestRep = { user_id: number | null; name: string; leads: number; booked: number; lost: number };
/** booked / (booked + lost) over one slice of leads. `open` is set only where
 *  the sample is small enough that undecided leads change how to read it. */
export type DigestRate = { rate: number; booked: number; lost: number; open?: number };
export type DigestDiscount = { label: string; amount: number; reason: string };

export type OwnerDigest = {
  company_id: number;
  company_name: string;
  /** YYYY-MM-DD in the tenant's own zone. */
  date: string;
  week_start: string;
  week_end: string;
  leads: {
    total: number;
    web: number;
    office: number;
    /** One row per staffer who owns at least one of today's leads. */
    by_rep: DigestRep[];
    unassigned: number;
    /** Today's leads that are already booked. */
    booked_from_today: number;
  };
  /** Leads whose booked_at landed today, whenever they first came in. */
  closed_today: number;
  /** Today's intake only, so `open` matters and is carried. */
  close_rate_today: DigestRate;
  /** 1st of the month through today. */
  close_rate_mtd: DigestRate;
  close_rate_30d: DigestRate;
  money: {
    serviced_today: number;
    serviced_today_jobs: number;
    week_to_date: number;
    week_total: number;
    booked_today: number;
    booked_today_jobs: number;
    /** Lead-attributed booked revenue, the lead-analytics convention. Carried
     *  for the dashboard; the text leads with the broader jobs-created figure
     *  because a phone booking that never became a lead row still counts. */
    booked_today_lead_attributed: number;
  };
  discounts: {
    count: number;
    total: number;
    /** At most a handful, biggest first. The full list lives in the app. */
    top: DigestDiscount[];
  };
};

/** Sunday..Saturday containing `dateStr`, matching /dispatch/week-summary. */
function weekWindow(dateStr: string): { start: string; end: string } {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - d.getUTCDay());
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export async function buildOwnerDigest(companyId: number, dateStr?: string): Promise<OwnerDigest> {
  const date = dateStr || companyDateStr(companyId);
  const tz = tzOf(companyId);
  const { start: weekStart, end: weekEnd } = weekWindow(date);

  // Revenue, one expression, used for every money line below.
  const rev = jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`);

  const [nameRow, leadRow, repRows, closedRow, rateTodayRow, rateMtdRow, rate30Row, servicedRow, weekRow, bookedRow, leadRevRow, modRows, quoteDiscRow] =
    await Promise.all([
      db.execute(sql`SELECT name FROM companies WHERE id = ${companyId} LIMIT 1`),

      // Today's intake: total, and the web/office split.
      db.execute(sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE ${WEB})::int AS web,
               COUNT(*) FILTER (WHERE l.assigned_to IS NULL)::int AS unassigned,
               COUNT(*) FILTER (WHERE ${WON})::int AS booked_from_today
        FROM leads l
        WHERE l.company_id = ${companyId}
          AND ${ctDate(sql`l.created_at`, tz)} = ${date}::date`),

      // Who worked today's leads. assigned_to is the board's auto-claim column.
      db.execute(sql`
        SELECT l.assigned_to AS user_id,
               NULLIF(trim(u.first_name || ' ' || COALESCE(u.last_name, '')), '') AS name,
               COUNT(*)::int AS leads,
               COUNT(*) FILTER (WHERE ${WON})::int AS booked,
               COUNT(*) FILTER (WHERE ${LOST})::int AS lost
        FROM leads l
        JOIN users u ON u.id = l.assigned_to
        WHERE l.company_id = ${companyId}
          AND ${ctDate(sql`l.created_at`, tz)} = ${date}::date
        GROUP BY 1, 2
        ORDER BY leads DESC, name ASC`),

      // Closed TODAY, whenever the lead first arrived. booked_at falls back to
      // updated_at, not created_at, so this ties EXACTLY to the "booked today"
      // tile on /leads/summary. A recap that disagreed with the tile by one
      // would cost more trust than it is worth.
      db.execute(sql`
        SELECT COUNT(*)::int AS c
        FROM leads l
        WHERE l.company_id = ${companyId}
          AND l.status = 'booked'
          AND ${ctDate(sql`COALESCE(l.booked_at, l.updated_at)`, tz)} = ${date}::date`),

      // Today's own cohort. `open` is carried because at this sample size the
      // undecided count is what tells the owner whether the rate means anything.
      db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE ${WON})::int AS booked,
               COUNT(*) FILTER (WHERE ${LOST})::int AS lost,
               COUNT(*) FILTER (WHERE NOT (${WON}) AND NOT (${LOST}))::int AS still_open
        FROM leads l
        WHERE l.company_id = ${companyId}
          AND ${ctDate(sql`l.created_at`, tz)} = ${date}::date`),

      // Month to date: the 1st of this month through today, in the tenant's zone.
      db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE ${WON})::int AS booked,
               COUNT(*) FILTER (WHERE ${LOST})::int AS lost
        FROM leads l
        WHERE l.company_id = ${companyId}
          AND ${ctDate(sql`l.created_at`, tz)} >= date_trunc('month', ${date}::date)::date
          AND ${ctDate(sql`l.created_at`, tz)} <= ${date}::date`),

      // Rolling 30-day close rate, on the lead-analytics definition.
      db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE ${WON})::int AS booked,
               COUNT(*) FILTER (WHERE ${LOST})::int AS lost
        FROM leads l
        WHERE l.company_id = ${companyId}
          AND ${ctDate(sql`l.created_at`, tz)} >  (${date}::date - interval '30 days')
          AND ${ctDate(sql`l.created_at`, tz)} <= ${date}::date`),

      // Serviced today.
      db.execute(sql`
        SELECT COUNT(*)::int AS jobs, ROUND(COALESCE(SUM(${rev}), 0), 2)::numeric AS revenue
        FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.status <> 'cancelled'
          AND j.scheduled_date = ${date}::date`),

      // The week, split at today so "so far" and "the whole week" are separate.
      db.execute(sql`
        SELECT ROUND(COALESCE(SUM(${rev}), 0), 2)::numeric AS week_total,
               ROUND(COALESCE(SUM(${rev}) FILTER (WHERE j.scheduled_date <= ${date}::date), 0), 2)::numeric AS week_to_date
        FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.status <> 'cancelled'
          AND j.scheduled_date >= ${weekStart}::date
          AND j.scheduled_date <= ${weekEnd}::date`),

      // Put on the books today, for any future date.
      db.execute(sql`
        SELECT COUNT(*)::int AS jobs, ROUND(COALESCE(SUM(${rev}), 0), 2)::numeric AS revenue
        FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.status <> 'cancelled'
          AND ${ctDate(sql`j.created_at`, tz)} = ${date}::date`),

      // The same day's booked revenue on the lead-analytics attribution, so the
      // two numbers can be compared rather than silently competing.
      db.execute(sql`
        SELECT ROUND(COALESCE(SUM(COALESCE(j.billed_amount, j.base_fee, 0)), 0), 2)::numeric AS revenue
        FROM leads l JOIN jobs j ON j.id = l.job_id
        WHERE l.company_id = ${companyId}
          AND l.status = 'booked'
          AND ${ctDate(sql`COALESCE(l.booked_at, l.created_at)`, tz)} = ${date}::date`),

      // Money taken off a job today. There are TWO tables and this used to read
      // only one, so an auto-promo day reported "no discounts given".
      //   job_rate_mods   — quote conversion (routes/quotes.ts) and the office's
      //                     hand-typed minus row on the job card (routes/jobs.ts).
      //                     A discount is a NEGATIVE amount there.
      //   job_discounts   — the automatic promo engine (lib/auto-promos.ts).
      //                     Amount is stored POSITIVE, as money taken off.
      // The two have disjoint writers, so a union cannot double-count the same
      // discount. Both halves are normalised to a positive "money off" so the
      // total and the ranking mean one thing.
      db.execute(sql`
        SELECT amount, reason, label FROM (
          SELECT CAST(m.amount AS NUMERIC) * -1 AS amount,
                 COALESCE(NULLIF(trim(m.reason), ''), 'Discount') AS reason,
                 COALESCE(NULLIF(trim(cl.first_name || ' ' || COALESCE(cl.last_name, '')), ''), cl.company_name, 'Job #' || j.id::text) AS label
          FROM job_rate_mods m
          JOIN jobs j ON j.id = m.job_id
          LEFT JOIN clients cl ON cl.id = j.client_id
          WHERE m.company_id = ${companyId}
            AND CAST(m.amount AS NUMERIC) < 0
            AND ${ctDate(sql`m.created_at`, tz)} = ${date}::date

          UNION ALL

          SELECT CAST(jd.amount AS NUMERIC) AS amount,
                 COALESCE(NULLIF(trim(jd.reason), ''), NULLIF(trim(jd.code), ''), 'Promo') AS reason,
                 COALESCE(NULLIF(trim(cl.first_name || ' ' || COALESCE(cl.last_name, '')), ''), cl.company_name, 'Job #' || j.id::text) AS label
          FROM job_discounts jd
          JOIN jobs j ON j.id = jd.job_id
          LEFT JOIN clients cl ON cl.id = j.client_id
          WHERE jd.company_id = ${companyId}
            AND CAST(jd.amount AS NUMERIC) > 0
            AND ${ctDate(sql`jd.created_at`, tz)} = ${date}::date
        ) d
        ORDER BY amount DESC`),

      // Discounts written on a quote today that have not become a job yet, so a
      // day of heavy quoting does not read as a day of zero discounting.
      db.execute(sql`
        SELECT COUNT(*)::int AS c, ROUND(COALESCE(SUM(CAST(q.discount_amount AS NUMERIC)), 0), 2)::numeric AS total
        FROM quotes q
        WHERE q.company_id = ${companyId}
          AND q.discount_amount IS NOT NULL
          AND CAST(q.discount_amount AS NUMERIC) > 0
          AND ${ctDate(sql`q.created_at`, tz)} = ${date}::date`),
    ]);

  const l: any = leadRow.rows[0] ?? {};
  const total = num(l.total);
  const web = num(l.web);

  const by_rep: DigestRep[] = (repRows.rows as any[]).map((r) => ({
    user_id: r.user_id != null ? Number(r.user_id) : null,
    name: r.name || `User ${r.user_id}`,
    leads: num(r.leads),
    booked: num(r.booked),
    lost: num(r.lost),
  }));

  const asRate = (row: any, withOpen = false): DigestRate => {
    const b = num(row?.booked), lo = num(row?.lost);
    return withOpen
      ? { rate: pct(b, b + lo), booked: b, lost: lo, open: num(row?.still_open) }
      : { rate: pct(b, b + lo), booked: b, lost: lo };
  };

  const mods = modRows.rows as any[];
  const modTotal = mods.reduce((a, m) => a + num(m.amount), 0);
  const qd: any = quoteDiscRow.rows[0] ?? {};

  const sv: any = servicedRow.rows[0] ?? {};
  const wk: any = weekRow.rows[0] ?? {};
  const bk: any = bookedRow.rows[0] ?? {};

  return {
    company_id: companyId,
    company_name: (nameRow.rows[0] as any)?.name || "Qleno",
    date,
    week_start: weekStart,
    week_end: weekEnd,
    leads: {
      total,
      web,
      office: total - web,
      by_rep,
      unassigned: num(l.unassigned),
      booked_from_today: num(l.booked_from_today),
    },
    closed_today: num((closedRow.rows[0] as any)?.c),
    close_rate_today: asRate(rateTodayRow.rows[0], true),
    close_rate_mtd: asRate(rateMtdRow.rows[0]),
    close_rate_30d: asRate(rate30Row.rows[0]),
    money: {
      serviced_today: num(sv.revenue),
      serviced_today_jobs: num(sv.jobs),
      week_to_date: num(wk.week_to_date),
      week_total: num(wk.week_total),
      booked_today: num(bk.revenue),
      booked_today_jobs: num(bk.jobs),
      booked_today_lead_attributed: num((leadRevRow.rows[0] as any)?.revenue),
    },
    discounts: {
      count: mods.length + num(qd.c),
      total: Math.round((modTotal + num(qd.total)) * 100) / 100,
      top: mods.slice(0, 3).map((m) => ({
        label: String(m.label),
        amount: num(m.amount),
        reason: String(m.reason ?? ""),
      })),
    },
  };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * The text itself. Owner-facing, so it says what each number means rather than
 * assuming the reader remembers which window it covers. No emojis, and no em
 * dashes — some carriers render them as a replacement glyph.
 */
export function formatOwnerDigestSms(d: OwnerDigest): string {
  const day = new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });

  const reps = d.leads.by_rep.length
    ? d.leads.by_rep.map((r) => `${r.name.split(" ")[0]} ${r.leads}`).join(", ")
    : "nobody claimed one";

  // Per-staffer close rate, day only. A staffer with nothing decided yet gets
  // "no calls yet" rather than a 0%, which would read as a bad day instead of
  // an early one.
  const repRates = d.leads.by_rep.length
    ? d.leads.by_rep.map((r) => {
        const decided = r.booked + r.lost;
        const first = r.name.split(" ")[0];
        return decided > 0
          ? `${first} ${Math.round(pct(r.booked, decided))}% (${r.booked} won, ${r.lost} lost)`
          : `${first} nothing decided yet`;
      }).join(", ")
    : null;

  const today = d.close_rate_today;

  // A rate over an empty sample is not 0%, it is nothing yet, and printing "0%"
  // on a quiet morning reads as a failure instead of an empty page. Whole
  // percents only: the extra decimal is noise in a text and makes the four
  // rates look like they were measured to different precisions.
  const rateText = (r: DigestRate) => {
    const open = r.open ? `, ${r.open} still open` : "";
    return r.booked + r.lost === 0
      ? `nothing decided yet${r.open ? ` (${r.open} still open)` : ""}`
      : `${Math.round(r.rate)}% (${r.booked} won, ${r.lost} lost${open})`;
  };

  const lines = [
    `${d.company_name} daily recap, ${day}`,
    ``,
    `LEADS ${d.leads.total} (web ${d.leads.web}, office ${d.leads.office})`,
    `Worked by: ${reps}${d.leads.unassigned ? `, unclaimed ${d.leads.unassigned}` : ""}`,
    `Booked today ${d.closed_today} (leads of any age)`,
    ``,
    `CLOSE RATE (won out of decided)`,
    `Today ${rateText(today)}`,
    ...(repRates ? [repRates] : []),
    `Month so far ${rateText(d.close_rate_mtd)}`,
    `Last 30 days ${rateText(d.close_rate_30d)}`,
    ``,
    `MONEY`,
    `Serviced today ${money(d.money.serviced_today)} across ${d.money.serviced_today_jobs} jobs`,
    `Booked today ${money(d.money.booked_today)} of new work (${d.money.booked_today_jobs} jobs)`,
    `Week so far ${money(d.money.week_to_date)}, full week on the books ${money(d.money.week_total)}`,
  ];

  if (d.discounts.count === 0) {
    lines.push(``, `No discounts given today.`);
  } else {
    lines.push(``, `DISCOUNTS ${d.discounts.count}, ${money(d.discounts.total)} off`);
    for (const t of d.discounts.top) lines.push(`${t.label} ${money(t.amount)} (${t.reason})`);
    if (d.discounts.count > d.discounts.top.length) {
      lines.push(`and ${d.discounts.count - d.discounts.top.length} more`);
    }
  }

  return lines.join("\n");
}

// ── Delivery ────────────────────────────────────────────────────────────────
//
// The recap goes to the OWNER's own phone and contains no customer-facing
// content, which puts it in the same class as the staff-alert email and web
// push in lib/notify.ts: internal, never sent to a client. But it is still an
// SMS, and COMMS_ENABLED is a hard rule, so this does NOT quietly step around
// the gate the way those two do.
//
// Instead the in-app notification always lands (that channel is already
// ungated for staff alerts), and the text is sent only when the comms ladder is
// open, or when OWNER_DIGEST_BYPASS_COMMS_GATE is explicitly set to "true".
// When a gate blocks it the reason is logged by name, so "I didn't get my text"
// has a one-line answer instead of an investigation. Phes co1 currently sits on
// company_comms_disabled, so the text stays off there until Sal decides.

const HARD_BLOCKS = new Set(["twilio_unconfigured", "no_from_number"]);

export type DigestSendResult = {
  company_id: number;
  date: string;
  recipients: number;
  sent: number;
  /** Set when nothing was texted, naming the gate or config that stopped it. */
  blocked_reason?: string;
};

/** Active owners of this tenant, including cross-tenant owners via user_companies. */
async function ownerRecipients(companyId: number): Promise<Array<{ id: number; name: string; phone: string | null }>> {
  const r = await db.execute(sql`
    SELECT DISTINCT u.id, u.phone,
           NULLIF(trim(u.first_name || ' ' || COALESCE(u.last_name, '')), '') AS name
    FROM users u
    WHERE u.is_active = true AND (
      (u.company_id = ${companyId} AND u.role IN ('owner', 'super_admin'))
      OR u.id IN (SELECT user_id FROM user_companies
                   WHERE company_id = ${companyId} AND role IN ('owner', 'super_admin'))
    )`);
  return (r.rows as any[]).map((u) => ({ id: Number(u.id), name: u.name || `User ${u.id}`, phone: u.phone || null }));
}

export async function sendOwnerDigest(companyId: number, dateStr?: string): Promise<DigestSendResult> {
  const digest = await buildOwnerDigest(companyId, dateStr);
  const body = formatOwnerDigestSms(digest);
  const owners = await ownerRecipients(companyId);

  // In-app first, and unconditionally. Even with every SMS gate shut, the owner
  // opens the app and the recap is there.
  for (const o of owners) {
    await notifyUser({
      companyId,
      userId: o.id,
      type: "owner_digest",
      title: `Daily recap, ${digest.date}`,
      body,
      link: "/dashboard",
      meta: { date: digest.date },
    });
  }

  const sender = await resolveSender(companyId, null);
  const bypass = process.env.OWNER_DIGEST_BYPASS_COMMS_GATE === "true";
  if (sender.reason && (HARD_BLOCKS.has(sender.reason) || !bypass)) {
    console.log(`[owner-digest] company ${companyId} ${digest.date}: text NOT sent (${sender.reason}); recap delivered in-app to ${owners.length} owner(s)`);
    return { company_id: companyId, date: digest.date, recipients: owners.length, sent: 0, blocked_reason: sender.reason };
  }
  if (sender.reason) {
    console.warn(`[owner-digest] company ${companyId}: sending past ${sender.reason} because OWNER_DIGEST_BYPASS_COMMS_GATE=true (owner-only internal alert)`);
  }

  let sent = 0;
  for (const o of owners) {
    if (!o.phone) {
      console.warn(`[owner-digest] owner ${o.name} (${o.id}) has no phone on file — not texted`);
      continue;
    }
    try {
      await sendSmsVia(sender, o.phone, body);
      sent++;
    } catch (e) {
      console.error(`[owner-digest] SMS to owner ${o.id} failed:`, (e as Error).message);
    }
  }
  console.log(`[owner-digest] company ${companyId} ${digest.date}: texted ${sent}/${owners.length} owner(s)`);
  return { company_id: companyId, date: digest.date, recipients: owners.length, sent };
}

/**
 * 6 PM slot. Off unless OWNER_DIGEST_ENABLED=true, so deploying this cannot
 * start texting anyone before Sal says go.
 *
 * Every tenant is evaluated in ITS OWN zone: a company on Eastern gets its
 * recap at its own 6 PM, not Chicago's. The caller ticks hourly; this picks the
 * tenants for whom it is currently the target hour.
 */
export async function runOwnerDigestCron(targetHour = 18): Promise<{ companies: number; sent: number }> {
  if (process.env.OWNER_DIGEST_ENABLED !== "true") return { companies: 0, sent: 0 };
  let companies = 0, sent = 0;
  try {
    const { tzOf } = await import("./company-tz.js");
    const rows = await db.execute(sql`SELECT id FROM companies`);
    const now = new Date();
    for (const c of rows.rows as any[]) {
      const companyId = Number(c.id);
      const hour = Number(
        new Intl.DateTimeFormat("en-US", { timeZone: tzOf(companyId), hour: "numeric", hour12: false }).format(now),
      );
      if (hour !== targetHour) continue;
      companies++;
      try {
        const r = await sendOwnerDigest(companyId);
        sent += r.sent;
      } catch (e) {
        console.error(`[owner-digest] company ${companyId} failed:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.error("[owner-digest] cron failed:", (e as Error).message);
  }
  return { companies, sent };
}
