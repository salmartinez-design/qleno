import type { ApiScope } from "./api-keys.js";

// [ai-access 2026-08-15] The tool table for Qleno Agent (MCP).
// Design: docs/AI_ACCESS_DESIGN.md §10.
//
// HOW TO WRITE A DESCRIPTION HERE
// -------------------------------
// These strings are the entire product for an AI caller. The model never reads
// our docs and never sees the SQL; it picks a tool, fills in arguments, and
// reports whatever comes back as fact. So a description that is merely accurate
// is not enough — it has to be accurate about the EDGES:
//
//   1. What the tool returns.
//   2. What it does NOT cover — the case a reasonable person would assume was
//      included. "Revenue excludes cancelled jobs" prevents a wrong answer that
//      no amount of model intelligence could catch.
//   3. The units. Money is US dollars, hours are decimal hours, dates are
//      YYYY-MM-DD. An assistant that reports minutes as hours is worse than one
//      that refuses to answer.
//
// The failure this guards against is quiet: the model picks a plausible tool,
// gets a plausible number, and the operator acts on it. Nobody sees an error.
//
// A tool that changes data must set `writes: true` and return a non-GET method
// from build(). Everything without that marker is read-only and cannot change a
// row no matter what it is asked to do.

export type ToolArgs = Record<string, unknown>;

export type McpTool = {
  name: string;
  description: string;
  /**
   * The scope the key must hold. Checked against req.apiKey.scopes per call.
   *
   * Undefined means the tool reads no business data at all and so gates on
   * nothing but the credential itself — today that is only list_companies, which
   * answers "which tenants may I ask about" and would be useless if it required
   * a scope the caller might not hold.
   */
  scope?: ApiScope;
  /**
   * Answered inside routes/mcp.ts instead of by dispatching into the v1 router.
   * Reserved for tools that describe the CONNECTION rather than the business.
   */
  local?: true;
  /** Only advertised on a cross-tenant connection. */
  crossTenantOnly?: true;
  /**
   * [ai-access-write 2026-08-16] This tool CHANGES data.
   *
   * Declared here rather than inferred from build().method, because the checks
   * that depend on it run before build() does — chiefly the refusal of a
   * `company` argument. A cross-tenant connection may read any company it was
   * granted and may write only to its home one, and that asymmetry is
   * deliberate: reading the wrong tenant produces a wrong answer somebody can
   * question, while writing to the wrong tenant moves a real job at a business
   * that never asked for an assistant.
   */
  writes?: true;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  /**
   * Turn validated arguments into a v1 request. Returns an error string instead
   * of throwing when an argument is unusable, so the caller answers with an
   * MCP tool error the model can correct rather than a 500 it cannot.
   *
   * Omitting `method` means GET, which is what every read tool wants and what
   * every tool written before Phase 5 assumed.
   */
  build: (args: ToolArgs) =>
    | {
        path: string;
        query: Record<string, string | undefined>;
        method?: "GET" | "POST" | "PATCH" | "DELETE";
        body?: Record<string, unknown>;
      }
    | { error: string };
};

// ── Argument coercion ────────────────────────────────────────────────────────
// Models send "50" as often as 50, and "2026-08-15" as often as a full ISO
// timestamp. Normalizing here rather than at every call site keeps the v1
// validators — which produce the good error messages — as the single authority
// on what is actually valid.

const str = (v: unknown): string | undefined =>
  v === undefined || v === null || v === "" ? undefined : String(v);

/** A date the v1 layer will accept, or undefined. Trims an ISO timestamp to its date. */
const date = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
  return m ? m[1] : s.trim();
};

/**
 * A positive integer for a PATH segment.
 *
 * Path ids are validated here rather than downstream because they are
 * interpolated into a URL: an id of "1/../technicians" would silently reach a
 * different endpoint than the tool advertises. Query parameters do not need
 * this — they cannot change which handler runs — and are left to the v1
 * validators so the caller gets their wording.
 */
const pathId = (v: unknown): number | null => {
  const n = Number(str(v));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const num = (v: unknown): string | undefined => {
  const s = str(v);
  if (s === undefined) return undefined;
  return Number.isFinite(Number(s)) ? String(Number(s)) : s; // pass junk through to the v1 400
};

// Shared schema fragments, so the same concept is described the same way
// everywhere. A model that learns "from/to are inclusive" from one tool should
// not have to relearn it from the next.
const FROM = { type: "string", description: "Start of the window, inclusive, as YYYY-MM-DD." };
const TO = { type: "string", description: "End of the window, inclusive, as YYYY-MM-DD." };
const LIMIT = {
  type: "integer",
  description: "Rows to return, 1-200. Defaults to 50. If more exist, the response carries next_cursor.",
};
const CURSOR = {
  type: "string",
  description: "Pass the next_cursor from a previous response to get the following page. Omit for the first page.",
};

export const MCP_TOOLS: McpTool[] = [
  // ── The connection itself ──────────────────────────────────────────────────
  {
    name: "list_companies",
    description:
      "The companies this connection is allowed to read, each with a numeric id and a name. " +
      "Only present when the connection covers more than one company. Pass an id or a name as the `company` argument on any other tool to ask about that company; omit it and every tool answers for the home company shown first here. " +
      "Each company is a separate business with its own schedule, customers, invoices, and staff — figures from two of them are never comparable line items and must not be added together unless the question is explicitly about the group. " +
      "A company that has not switched on AI access does not appear here at all.",
    // No scope: this describes the credential, not the business behind it. A
    // connection granted only payroll:read still has to be able to find out
    // which payrolls it may ask about.
    local: true,
    crossTenantOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    build: () => ({ path: "", query: {} }),
  },

  // ── Schedule ───────────────────────────────────────────────────────────────
  {
    name: "get_schedule",
    description:
      "The full job schedule for one day, plus a summary of that day: total jobs, how many still have no cleaner, how many are complete, how many are cancelled, and expected revenue in US dollars. " +
      "Defaults to today in the company's own timezone, so you do not need to know where they operate. " +
      "The unassigned count and the revenue total both EXCLUDE cancelled jobs — nobody staffs or bills a cancelled visit. " +
      "Each job carries its time, address, client, assigned cleaners, price in dollars, and budgeted vs clocked hours as decimal hours. " +
      "This is one day only: for a range use find_jobs.",
    scope: "jobs:read",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "The day to look at, as YYYY-MM-DD. Omit for today in the company's timezone." },
      },
      additionalProperties: false,
    },
    build: (a) => ({ path: "/schedule/day", query: { date: date(a.date) } }),
  },
  {
    name: "find_jobs",
    description:
      "Search jobs across a date range with optional filters for status, client, account, zone, or cleaner. " +
      "Returns jobs sorted by date, each with time, address, client, assigned cleaners, price in US dollars, budgeted hours and clocked hours as decimal hours, and clock-in/clock-out times. " +
      "Includes cancelled jobs unless you filter them out with status — this is a search, not a revenue report, so nothing is hidden. " +
      "Results are paginated: if next_cursor comes back there are more, and you must page to have the complete set. Do not report a total from a single page.",
    scope: "jobs:read",
    inputSchema: {
      type: "object",
      properties: {
        from: FROM,
        to: TO,
        status: {
          type: "string",
          enum: ["scheduled", "in_progress", "complete", "cancelled"],
          description: "Restrict to one status. Omit for all four.",
        },
        client_id: { type: "integer", description: "Only this client's jobs. Get the id from find_client." },
        account_id: { type: "integer", description: "Only this commercial account's jobs." },
        zone_id: { type: "integer", description: "Only jobs in this service zone." },
        tech_id: { type: "integer", description: "Only jobs this cleaner is assigned to. Get the id from get_technician_load." },
        limit: LIMIT,
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    build: (a) => ({
      path: "/jobs",
      query: {
        from: date(a.from), to: date(a.to), status: str(a.status),
        client_id: num(a.client_id), account_id: num(a.account_id),
        zone_id: num(a.zone_id), tech_id: num(a.tech_id),
        limit: num(a.limit), cursor: str(a.cursor),
      },
    }),
  },
  {
    name: "get_job",
    description:
      "One job in full, by its id: date, time, address, client, account and property for commercial work, assigned cleaners, service type, price in US dollars, budgeted and clocked hours as decimal hours, clock-in and clock-out times, whether an online payment has cleared, and any notes. " +
      "Returns not_found for an id that does not exist OR belongs to another company — those are deliberately indistinguishable.",
    scope: "jobs:read",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "integer", description: "The job's numeric id." } },
      required: ["job_id"],
      additionalProperties: false,
    },
    build: (a) => {
      const id = pathId(a.job_id);
      return id === null ? { error: "job_id must be a positive whole number" } : { path: `/jobs/${id}`, query: {} };
    },
  },
  {
    name: "get_unassigned_work",
    description:
      "Jobs from a date forward that have NO cleaner assigned at all — the staffing gap. Defaults to today onward. " +
      "Cancelled jobs are excluded because they never need staffing. " +
      "A job counts as assigned if it has any cleaner, whether or not one is marked primary, so this will not report work that is in fact covered. " +
      "Use this for 'what still needs somebody'; use get_technician_load for who has room to take it.",
    scope: "jobs:read",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Look from this date forward, as YYYY-MM-DD. Omit for today." },
        to: TO,
        limit: LIMIT,
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    build: (a) => ({
      path: "/schedule/unassigned",
      query: { from: date(a.from), to: date(a.to), limit: num(a.limit), cursor: str(a.cursor) },
    }),
  },
  {
    name: "get_technician_load",
    description:
      "The active cleaning staff and how loaded each one is on a given day: job count and total budgeted hours as decimal hours. Defaults to today. " +
      "Only active technicians and trainees — office staff, admins, and deactivated employees are not listed. " +
      "Budgeted hours are the schedule's plan, NOT what anyone actually worked; for clocked time use find_jobs or get_employee_pay. " +
      "Deliberately carries no pay rate, address, or personal detail — this answers 'who is free', not 'what does she earn'.",
    scope: "jobs:read",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "The day to measure load on, as YYYY-MM-DD. Omit for today." } },
      additionalProperties: false,
    },
    build: (a) => ({ path: "/technicians", query: { date: date(a.date) } }),
  },

  // ── Customers ──────────────────────────────────────────────────────────────
  {
    name: "find_client",
    description:
      "Search the customer book by name, email, or phone, or list it filtered by residential vs commercial and active vs inactive. " +
      "Returns each client's id, name, contact details, address, and type. Use the id it returns with get_client_history, find_jobs, or get_invoices. " +
      "This searches CLIENTS only. Commercial accounts — the billing entities behind multi-property contracts — are a separate list and are not searched here. " +
      "Includes both active and inactive clients unless you pass active.",
    scope: "clients:read",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Text to match against name, email, or phone. Partial matches work." },
        type: { type: "string", enum: ["residential", "commercial"], description: "Restrict to one kind of client." },
        active: { type: "boolean", description: "True for active clients only, false for inactive only. Omit for both." },
        limit: LIMIT,
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    build: (a) => ({
      path: "/clients",
      query: {
        q: str(a.q), type: str(a.type),
        active: a.active === undefined ? undefined : String(a.active === true || a.active === "true"),
        limit: num(a.limit), cursor: str(a.cursor),
      },
    }),
  },
  {
    name: "get_client_history",
    description:
      "Every job for one client, oldest first, with dates, cleaners, prices in US dollars, and status. Narrow it with from/to. " +
      "This is service history, not billing history — for what was invoiced and what is owed, use get_invoices with the same client_id. " +
      "Cancelled visits are included and marked as such, so a gap in service is visible rather than silently missing. " +
      "Paginated: page through next_cursor before concluding how many times someone has been served.",
    scope: "jobs:read",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "integer", description: "The client's numeric id, from find_client." },
        from: FROM,
        to: TO,
        limit: LIMIT,
        cursor: CURSOR,
      },
      required: ["client_id"],
      additionalProperties: false,
    },
    build: (a) => {
      const id = pathId(a.client_id);
      if (id === null) return { error: "client_id must be a positive whole number" };
      return {
        path: "/jobs",
        query: { client_id: String(id), from: date(a.from), to: date(a.to), limit: num(a.limit), cursor: str(a.cursor) },
      };
    },
  },

  // ── Money ──────────────────────────────────────────────────────────────────
  {
    name: "get_revenue",
    description:
      "Revenue over a date range, totalled and broken down by day, week, or month. All amounts are US dollars. " +
      "This is BOOKED revenue — what the jobs in the window are priced at — not cash collected. A job can be counted here and still be unpaid; use get_receivables for money actually owed. " +
      "Cancelled jobs are excluded. The window cannot exceed 366 days.",
    scope: "reports:read",
    inputSchema: {
      type: "object",
      properties: {
        from: FROM,
        to: TO,
        group_by: { type: "string", enum: ["day", "week", "month"], description: "Bucket size for the breakdown. Defaults to day." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    build: (a) => ({ path: "/reports/revenue", query: { from: date(a.from), to: date(a.to), group_by: str(a.group_by) } }),
  },
  {
    name: "get_kpis",
    description:
      "The headline operating numbers for a date range: job counts by status, revenue and average job value in US dollars, completion and cancellation rates, and budgeted vs clocked hours as decimal hours. " +
      "One window at a time — to compare two periods, call this twice and compare the results yourself rather than assuming any field is a trend. " +
      "Rates are percentages of jobs in the window, not of all jobs ever.",
    scope: "reports:read",
    inputSchema: {
      type: "object",
      properties: { from: FROM, to: TO },
      required: ["from", "to"],
      additionalProperties: false,
    },
    build: (a) => ({ path: "/reports/kpis", query: { from: date(a.from), to: date(a.to) } }),
  },
  {
    name: "get_efficiency",
    description:
      "Efficiency by cleaner over a date range: budgeted hours divided by clocked hours, as a percentage where ABOVE 100% means finishing under budget, which is good. Hours are decimal hours. " +
      "Only jobs with both a budget and a clock-in can be scored, so a cleaner with unclocked work will show fewer jobs here than in find_jobs. " +
      "This measures pace against budget. It is not a quality score and says nothing about customer satisfaction.",
    scope: "reports:read",
    inputSchema: {
      type: "object",
      properties: {
        from: FROM,
        to: TO,
        tech_id: { type: "integer", description: "Score one cleaner only. Omit for everyone." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    build: (a) => ({ path: "/reports/efficiency", query: { from: date(a.from), to: date(a.to), tech_id: num(a.tech_id) } }),
  },
  {
    name: "get_payroll_summary",
    description:
      "What every employee earned over a pay period, in US dollars: commission, mileage reimbursement, tips, other additions, and the total. " +
      "Pay here is commission plus mileage — cleaners are NOT paid hourly, so the decimal hours shown are context only and multiplying them by any rate will produce a number that means nothing. " +
      "Mileage is a reimbursement, not wages. The window cannot exceed 366 days. " +
      "Sensitive: this is compensation data for named people.",
    scope: "payroll:read",
    inputSchema: {
      type: "object",
      properties: { from: FROM, to: TO },
      required: ["from", "to"],
      additionalProperties: false,
    },
    build: (a) => ({ path: "/payroll/summary", query: { from: date(a.from), to: date(a.to) } }),
  },
  {
    name: "get_employee_pay",
    description:
      "One employee's pay for a period broken down job by job, in US dollars, with the clocked hours behind each line as decimal hours. " +
      "Commercial jobs pay an hourly rate against budgeted hours; residential jobs pay a share of the job price. The two are different formulas and the response says which applied. " +
      "Shows what was earned, not whether a paycheck has been issued. " +
      "Sensitive: this is one named person's compensation.",
    scope: "payroll:read",
    inputSchema: {
      type: "object",
      properties: {
        employee_id: { type: "integer", description: "The employee's numeric user id, from get_technician_load." },
        from: FROM,
        to: TO,
      },
      required: ["employee_id", "from", "to"],
      additionalProperties: false,
    },
    build: (a) => {
      const id = pathId(a.employee_id);
      if (id === null) return { error: "employee_id must be a positive whole number" };
      return { path: `/payroll/employee/${id}`, query: { from: date(a.from), to: date(a.to) } };
    },
  },
  {
    name: "get_invoices",
    description:
      "Invoices, filterable by status, date range, client, or account. Amounts are US dollars and each row carries what was billed, what has been paid, and what remains. " +
      "Pass status 'unpaid' for everything still owing; the stored statuses are draft, sent, paid, overdue, void, superseded, and batched. " +
      "Residential work is generally billed per job while commercial work is billed to an account, so a client search and an account search can return different pictures of the same money. " +
      "Paginated — page through next_cursor before totalling anything.",
    scope: "invoices:read",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "One of: unpaid, draft, sent, paid, overdue, void, superseded, batched. Omit for all.",
        },
        from: FROM,
        to: TO,
        client_id: { type: "integer", description: "Only this client's invoices." },
        account_id: { type: "integer", description: "Only this commercial account's invoices." },
        limit: LIMIT,
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    build: (a) => ({
      path: "/invoices",
      query: {
        status: str(a.status), from: date(a.from), to: date(a.to),
        client_id: num(a.client_id), account_id: num(a.account_id),
        limit: num(a.limit), cursor: str(a.cursor),
      },
    }),
  },
  {
    name: "get_receivables",
    description:
      "Everything currently owed: invoices that are not paid, not void, and not superseded, oldest first, with the outstanding balance on each in US dollars. " +
      "This is the answer to 'who owes us money'. It counts invoices, so work that has been done but never invoiced does not appear here at all — that gap is real and worth naming when you report a total. " +
      "Paginated; page through next_cursor before stating a grand total.",
    scope: "invoices:read",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "integer", description: "Restrict to one commercial account." },
        client_id: { type: "integer", description: "Restrict to one client." },
        limit: LIMIT,
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    build: (a) => ({
      path: "/invoices",
      query: {
        status: "unpaid",
        account_id: num(a.account_id), client_id: num(a.client_id),
        limit: num(a.limit), cursor: str(a.cursor),
      },
    }),
  },

  // ── Changes ────────────────────────────────────────────────────────────────
  // [ai-access-write 2026-08-16] Everything below CHANGES data. The endpoints
  // behind them live in one file (routes/v1/writes.ts) and every one of them is
  // budgeted, recorded in the customer's Activity feed under the connection's
  // name, and listed for reversal in Settings.
  //
  // These descriptions carry a second job the read ones do not: they have to say
  // what the change does NOT touch. "Move this visit" and "move this customer's
  // Tuesdays" are the same sentence in English and wildly different acts, and the
  // model has no way to know which one it just performed unless the tool says so.
  {
    name: "reschedule_job",
    description:
      "Move ONE visit to a different date and/or time. Give scheduled_date as YYYY-MM-DD, scheduled_time as 24-hour HH:MM in the company's own timezone, or both; whichever you leave out stays as it is. " +
      "This moves that single visit only. A recurring customer's other visits do not move and the repeating schedule behind them is not touched — to change the pattern itself, a person does that in Qleno. " +
      "Visits can only be moved to today or later, and a visit already marked complete or cancelled cannot be moved at all. " +
      "The assigned cleaner is notified, the customer's invoice follows the new date, and the change appears in the customer's activity history naming this connection. " +
      "Confirm the date with the person before calling: this reaches a real crew and a real customer.",
    scope: "jobs:write",
    writes: true,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "integer", description: "The visit's numeric id, from get_schedule or find_jobs." },
        scheduled_date: { type: "string", description: "New date as YYYY-MM-DD. Omit to keep the current date." },
        scheduled_time: { type: "string", description: "New start time as 24-hour HH:MM. Omit to keep the current time." },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    build: (a) => {
      const id = pathId(a.job_id);
      if (id === null) return { error: "job_id must be a positive whole number" };
      return {
        path: `/jobs/${id}/schedule`,
        query: {},
        method: "PATCH",
        body: { scheduled_date: date(a.scheduled_date), scheduled_time: str(a.scheduled_time) },
      };
    },
  },
  {
    name: "assign_technician",
    description:
      "Put a cleaner on a visit, or take the visit back to unassigned by passing technician_id as null. " +
      "One person at a time: this sets who the visit belongs to, replacing whoever held it. Anyone else already helping on that visit keeps their place. " +
      "The id must be an active employee of this company — look the person up rather than guessing an id, because a wrong id is refused, not silently ignored. " +
      "A cancelled visit cannot be staffed. The cleaner is notified on their phone, so do not call this to explore options.",
    scope: "jobs:write",
    writes: true,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "integer", description: "The visit's numeric id." },
        technician_id: {
          type: ["integer", "null"],
          description: "The employee's numeric id, from get_technician_load. Pass null to leave the visit unassigned.",
        },
      },
      required: ["job_id", "technician_id"],
      additionalProperties: false,
    },
    build: (a) => {
      const id = pathId(a.job_id);
      if (id === null) return { error: "job_id must be a positive whole number" };
      // null is a real instruction here — "unassign" — so it is passed through
      // rather than coerced away by the usual empty-value handling.
      const t = a.technician_id;
      const tech = t === null || t === undefined || t === "" ? (t === null ? null : undefined) : Number(t);
      return {
        path: `/jobs/${id}/assign`,
        query: {},
        method: "POST",
        body: { technician_id: tech },
      };
    },
  },
  {
    name: "add_job_note",
    description:
      "Add a line to a visit's office notes — access instructions, what the customer asked for, what to watch out for. " +
      "It APPENDS. Nothing already in the notes is replaced or removed, and the line is stamped with this connection's name so whoever reads it later knows where it came from. " +
      "Up to 2000 characters. These notes are read by the crew and quoted to customers, so write what a person would write, not a summary of the conversation.",
    scope: "jobs:write",
    writes: true,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "integer", description: "The visit's numeric id." },
        note: { type: "string", description: "The line to add. Plain text, up to 2000 characters." },
      },
      required: ["job_id", "note"],
      additionalProperties: false,
    },
    build: (a) => {
      const id = pathId(a.job_id);
      if (id === null) return { error: "job_id must be a positive whole number" };
      return { path: `/jobs/${id}/notes`, query: {}, method: "POST", body: { note: str(a.note) } };
    },
  },
  {
    name: "update_client_contact",
    description:
      "Correct a customer's email address or phone number. Pass either or both; whichever you leave out is unchanged. " +
      "Phone is stored as ten US digits however you punctuate it, and an email that is not a valid address is refused rather than saved. " +
      "This changes contact details ONLY. It cannot change a customer's name or their service address — the address decides which branch serves them and what the crew's route looks like, so a person changes that in Qleno. " +
      "The customer's reminders and receipts go to whatever is stored here, so a typo reaches them before anyone notices.",
    scope: "clients:write",
    writes: true,
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "integer", description: "The customer's numeric id, from find_client." },
        email: { type: "string", description: "New email address. Omit to leave it alone." },
        phone: { type: "string", description: "New US phone number, 10 digits. Omit to leave it alone." },
      },
      required: ["client_id"],
      additionalProperties: false,
    },
    build: (a) => {
      const id = pathId(a.client_id);
      if (id === null) return { error: "client_id must be a positive whole number" };
      return {
        path: `/clients/${id}/contact`,
        query: {},
        method: "PATCH",
        body: { email: str(a.email), phone: str(a.phone) },
      };
    },
  },
  // ── Quotes ─────────────────────────────────────────────────────────────────
  {
    name: "create_quote",
    description:
      "Write up a quote and save it as a DRAFT. It is not sent to anyone — send_quote does that, as a separate deliberate step. " +
      "This tool does NOT calculate a price. Qleno's pricing depends on square footage, scope, add-ons and the customer's history, none of which this tool reads: you must pass total_price, which is the number the office decided on. Never invent one, and never quote a figure back to a customer that the office did not give you. " +
      "For an existing customer pass client_id so the quote lands in their profile; for a brand new lead pass lead_name and their contact details instead. " +
      "alternate_options is the second-price mechanism — the customer sees the main price plus each alternate as its own card, which is how a 3-times-a-week quote also shows what 5 times a week would cost. Each alternate needs a total in US dollars; scope_name and frequency are what the customer reads on the card. " +
      "Money is US dollars. Returns the new quote's id, which send_quote takes.",
    scope: "quotes:write",
    writes: true,
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "integer", description: "An existing customer's numeric id, from find_client. Omit for a new lead and pass lead_name instead." },
        lead_name: { type: "string", description: "The person or organization being quoted. Required unless client_id is given." },
        lead_email: { type: "string", description: "Where the quote will be emailed. Without it the quote can be written but never sent." },
        lead_phone: { type: "string", description: "Contact phone." },
        address: { type: "string", description: "The service address, written out in full including the zip code." },
        service_type: { type: "string", description: "What is being quoted, in the office's own words — for example \"Commercial cleaning\" or \"Post construction\"." },
        frequency: { type: "string", description: "How often, in plain words — for example \"3 times per week\" or \"one time\"." },
        total_price: { type: "number", description: "The price the customer is being quoted, in US dollars. Required. This tool does not compute it." },
        base_price: { type: "number", description: "The price before add-ons, in US dollars. Defaults to total_price." },
        notes: { type: "string", description: "Anything the customer should read on the quote, or the office should remember about it." },
        alternate_options: {
          type: "array",
          description: "Extra prices shown alongside the main one, each as its own card on the quote.",
          items: {
            type: "object",
            properties: {
              scope_name: { type: "string", description: "What this option is called on the card." },
              frequency: { type: "string", description: "How often this option runs." },
              total: { type: "number", description: "This option's price in US dollars. An option without one is dropped." },
            },
          },
        },
      },
      additionalProperties: false,
    },
    build: (a) => ({
      path: "/quotes",
      query: {},
      method: "POST",
      body: {
        client_id: a.client_id == null || a.client_id === "" ? undefined : Number(a.client_id),
        lead_name: str(a.lead_name),
        lead_email: str(a.lead_email),
        lead_phone: str(a.lead_phone),
        address: str(a.address),
        service_type: str(a.service_type),
        frequency: str(a.frequency),
        total_price: num(a.total_price),
        base_price: num(a.base_price),
        notes: str(a.notes),
        alternate_options: Array.isArray(a.alternate_options) ? a.alternate_options : undefined,
      },
    }),
  },
  {
    name: "send_quote",
    description:
      "Email an existing quote to the customer it was written for. " +
      "The recipient is the address already on the quote — this tool cannot send it anywhere else, and it cannot change a word of what the quote says. " +
      "Sending marks the quote sent, stamps the time, and starts the follow-up sequence, so a second call is a re-send the customer will notice. A quote the customer has already accepted is refused rather than re-sent. " +
      "Read the reply before reporting success: if email_delivered comes back false the quote IS marked sent in Qleno but no message left the building, because the company's messaging is switched off. Say so plainly rather than telling anyone the customer has their prices.",
    scope: "quotes:send",
    writes: true,
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "integer", description: "The quote's numeric id, from create_quote." },
      },
      required: ["quote_id"],
      additionalProperties: false,
    },
    build: (a) => {
      const id = pathId(a.quote_id);
      if (id === null) return { error: "quote_id must be a positive whole number" };
      return { path: `/quotes/${id}/send`, query: {}, method: "POST", body: {} };
    },
  },

  // ── Recurring service ──────────────────────────────────────────────────────
  {
    name: "create_recurring_schedule",
    description:
      "Put a customer on repeating service, and write the next 90 days of visits onto the dispatch board straight away. This is not a draft — real visits appear on real days and the crew will be sent to them. " +
      "For several times a week use frequency \"custom_days\" with days_of_week, for example [1,3,5] for Monday, Wednesday and Friday. For once a week use \"weekly\", every other week \"biweekly\", every four weeks \"monthly\". " +
      "A customer can only have ONE repeating schedule. Calling this for someone who already repeats CHANGES their cadence rather than adding a second series, and the reply says which happened. Visits the office already deleted stay deleted. " +
      "duration_minutes is how long each visit is budgeted for, in minutes. On a commercial account it is required and refused if missing, because commercial pay is the hourly rate times that budgeted time, so a blank budget pays the crew nothing every single visit. " +
      "start_date is YYYY-MM-DD and cannot be in the past. base_fee is US dollars per visit.",
    scope: "schedules:write",
    writes: true,
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "integer", description: "The customer's numeric id, from find_client." },
        frequency: {
          type: "string",
          description: "One of: weekly, biweekly, every_3_weeks, monthly, semi_monthly, monthly_weekday, daily, weekdays, custom_days, custom. Use custom_days with days_of_week for several times a week.",
        },
        start_date: { type: "string", description: "First visit, as YYYY-MM-DD. Cannot be in the past." },
        days_of_week: {
          type: "array",
          description: "Which days it runs, 0=Sunday through 6=Saturday. Required with custom_days. Ignored on weekly.",
          items: { type: "integer" },
        },
        day_of_week: { type: "string", description: "The single weekday for a weekly cadence, spelled out — for example \"tuesday\". Ignored when days_of_week is passed." },
        end_date: { type: "string", description: "Last day the schedule runs, as YYYY-MM-DD. Omit for open-ended." },
        scheduled_time: { type: "string", description: "Start time of each visit, 24-hour HH:MM." },
        assigned_employee_id: { type: "integer", description: "Who cleans it. Omit to leave the visits unassigned for dispatch to fill." },
        service_type: { type: "string", description: "What service each visit is." },
        duration_minutes: { type: "integer", description: "Budgeted length of each visit in MINUTES, not hours. Required for commercial accounts." },
        base_fee: { type: "number", description: "Price per visit in US dollars." },
        notes: { type: "string", description: "Anything the crew needs to know at every visit." },
      },
      required: ["client_id", "frequency", "start_date"],
      additionalProperties: false,
    },
    build: (a) => ({
      path: "/recurring-schedules",
      query: {},
      method: "POST",
      body: {
        client_id: a.client_id == null || a.client_id === "" ? undefined : Number(a.client_id),
        frequency: str(a.frequency),
        start_date: date(a.start_date),
        days_of_week: Array.isArray(a.days_of_week) ? a.days_of_week : undefined,
        day_of_week: str(a.day_of_week),
        end_date: date(a.end_date),
        scheduled_time: str(a.scheduled_time),
        assigned_employee_id: a.assigned_employee_id == null || a.assigned_employee_id === "" ? undefined : Number(a.assigned_employee_id),
        service_type: str(a.service_type),
        duration_minutes: a.duration_minutes == null || a.duration_minutes === "" ? undefined : Number(a.duration_minutes),
        base_fee: num(a.base_fee),
        notes: str(a.notes),
      },
    }),
  },

  // ── Staff ──────────────────────────────────────────────────────────────────
  {
    name: "create_employee",
    description:
      "Add a new employee. They get a real account they can sign in to, so this is hiring paperwork, not a note — do not create one to test something. " +
      "role defaults to technician. Office and admin can add anyone except an owner; only the owner creates another owner. pay_rate, if you set one, is in US dollars. " +
      "The account's starting password is NOT returned here and must not be guessed at or repeated — the office hands it over in person. " +
      "An email that already belongs to someone here is refused, and if that person is inactive the refusal says so, because the right move is to bring their account back rather than open a second one.",
    scope: "employees:write",
    writes: true,
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Work email. Becomes their sign-in and must not already belong to anyone here." },
        first_name: { type: "string", description: "First name." },
        last_name: { type: "string", description: "Last name." },
        role: { type: "string", description: "technician, office, admin, or owner. Defaults to technician." },
        phone: { type: "string", description: "US phone number." },
        pay_rate: { type: "number", description: "Their pay rate. US dollars." },
        pay_type: { type: "string", description: "How they are paid — for example hourly or commission." },
        hire_date: { type: "string", description: "Start date, as YYYY-MM-DD." },
      },
      required: ["email", "first_name"],
      additionalProperties: false,
    },
    build: (a) => ({
      path: "/employees",
      query: {},
      method: "POST",
      body: {
        email: str(a.email),
        first_name: str(a.first_name),
        last_name: str(a.last_name),
        role: str(a.role),
        phone: str(a.phone),
        pay_rate: num(a.pay_rate),
        pay_type: str(a.pay_type),
        hire_date: date(a.hire_date),
      },
    }),
  },
  {
    name: "deactivate_employee",
    description:
      "Take an employee off the board. Qleno has no way to erase a person and this does not add one: their account is switched off, and everything they already worked stays exactly as it is so payroll and job history remain true. " +
      "Their upcoming visits are released to Unassigned, so somebody has to re-staff them. Completed visits keep their name on them. " +
      "ONLY THE OWNER can do this. A connection made by anyone else is refused no matter what it is asked — that refusal is the point, not a fault to work around. " +
      "The reply says how many visits fell to Unassigned. It is reversible with reactivate_employee, which does NOT put those visits back on them.",
    scope: "employees:write",
    writes: true,
    inputSchema: {
      type: "object",
      properties: {
        employee_id: { type: "integer", description: "The employee's numeric id." },
      },
      required: ["employee_id"],
      additionalProperties: false,
    },
    build: (a) => {
      const id = pathId(a.employee_id);
      if (id === null) return { error: "employee_id must be a positive whole number" };
      return { path: `/employees/${id}`, query: {}, method: "DELETE" };
    },
  },
  {
    name: "reactivate_employee",
    description:
      "Switch a deactivated employee's account back on, so they can sign in and be assigned work again. " +
      "It does NOT give them back the visits that were released when they were deactivated — those went to Unassigned and stay there until dispatch decides who takes them. " +
      "Someone who is already active is refused rather than touched.",
    scope: "employees:write",
    writes: true,
    inputSchema: {
      type: "object",
      properties: {
        employee_id: { type: "integer", description: "The employee's numeric id." },
      },
      required: ["employee_id"],
      additionalProperties: false,
    },
    build: (a) => {
      const id = pathId(a.employee_id);
      if (id === null) return { error: "employee_id must be a positive whole number" };
      return { path: `/employees/${id}/reactivate`, query: {}, method: "POST", body: {} };
    },
  },
];

export const TOOLS_BY_NAME: ReadonlyMap<string, McpTool> = new Map(MCP_TOOLS.map((t) => [t.name, t]));

// [ai-access-superadmin 2026-08-16] The cross-tenant argument.
//
// It is injected into the schemas at list time rather than written into each
// tool above, for one reason: on a single-tenant connection it must not appear
// AT ALL. An advertised argument is an instruction — a model that sees
// `company` will eventually send it, and every one of those calls is a refusal
// the tenant never needed to see. Most connections are single-tenant, so the
// common case stays exactly the schema it was before this feature existed.
const COMPANY_ARG = {
  type: "string",
  description:
    "Which company to ask about — a numeric id or a name from list_companies. " +
    "Omit for the home company. Every answer covers exactly one company: to compare two, call the tool twice.",
};

function withCompanyArg(tool: McpTool): McpTool {
  // A write tool never gets the argument, on any connection. Advertising it and
  // then refusing it would teach the model to keep trying; leaving it off the
  // schema says plainly that changes land in this connection's own company.
  if (tool.crossTenantOnly || tool.writes) return tool;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...tool.inputSchema.properties, company: COMPANY_ARG },
    },
  };
}

/**
 * The tools this credential may use.
 *
 * tools/list must not advertise what tools/call would refuse — an advertised
 * tool that always fails teaches the model to keep retrying something that can
 * never work, and leaks the shape of data this credential was deliberately not
 * given. Two filters, for the two reasons a tool can be out of reach: the
 * scopes it lacks, and tenants it cannot cross.
 */
export function toolsForScopes(scopes: readonly string[], crossTenant = false): McpTool[] {
  const visible = MCP_TOOLS.filter((t) => {
    if (t.crossTenantOnly && !crossTenant) return false;
    return t.scope === undefined || scopes.includes(t.scope);
  });
  return crossTenant ? visible.map(withCompanyArg) : visible;
}
