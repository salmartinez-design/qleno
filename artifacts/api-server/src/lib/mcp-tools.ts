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
