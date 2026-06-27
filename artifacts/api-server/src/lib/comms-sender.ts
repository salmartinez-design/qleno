import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface ResolvedSender {
  enabled: boolean;               // company twilio_enabled gate (Twilio go-live)
  company_comms_enabled: boolean; // per-TENANT comms master (companies.comms_enabled)
  branch_comms_enabled: boolean;  // per-branch comms gate (false unless branch flipped on)
  account_sid: string | null;
  auth_token: string | null;
  from_number: string | null;     // branch number, else company number
  reason?: string;                // why a send would be suppressed, if not ready
}

// Resolve the Twilio sender for a message. Company holds the account creds + the
// twilio_enabled go-live gate; each BRANCH sends from its own from_number
// (Oak Lawn vs Schaumburg), falling back to the company-level number. The
// COMMS_ENABLED global gate is enforced separately at the call site.
export async function resolveSender(companyId: number, branchId?: number | null): Promise<ResolvedSender> {
  const cr = await db.execute(sql`
    SELECT twilio_enabled, comms_enabled, twilio_account_sid, twilio_auth_token, twilio_from_number
      FROM companies WHERE id = ${companyId} LIMIT 1`);
  const c: any = cr.rows[0] ?? {};

  let branchNumber: string | null = null;
  let branchComms = false;
  let branchFound = false;
  if (branchId != null) {
    const br = await db.execute(sql`
      SELECT twilio_from_number, comms_enabled FROM branches WHERE id = ${branchId} AND company_id = ${companyId} LIMIT 1`);
    if (br.rows[0]) {
      branchFound = true;
      branchNumber = (br.rows[0] as any)?.twilio_from_number ?? null;
      branchComms = !!(br.rows[0] as any)?.comms_enabled;
    }
  }
  let from_number = branchNumber || c.twilio_from_number || null;
  // [sms-from-number-fallback 2026-06-25] Manual / company-scoped sends pass no
  // branch context, and a tenant that keeps its Twilio numbers on the BRANCHES
  // (not company-level, e.g. Phes co1) would otherwise resolve no_from_number.
  // Fall back to the company's primary branch number: first active branch
  // (comms_enabled first, then lowest id) that actually has a from-number.
  // If NO branch has a number, it stays null → reason 'no_from_number' (we
  // never invent a number).
  if (!from_number) {
    const fb = await db.execute(sql`
      SELECT twilio_from_number FROM branches
       WHERE company_id = ${companyId}
         AND twilio_from_number IS NOT NULL AND twilio_from_number <> ''
       ORDER BY comms_enabled DESC, id ASC
       LIMIT 1`);
    from_number = (fb.rows[0] as any)?.twilio_from_number ?? null;
  }
  const account_sid = c.twilio_account_sid ?? null;
  const auth_token = c.twilio_auth_token ?? null;
  const enabled = !!c.twilio_enabled;
  const company_comms_enabled = !!c.comms_enabled;
  // Branch gate ONLY applies when the passed branchId actually maps to a branch
  // of THIS company. When no branch is specified — OR a branchId is passed that
  // doesn't belong to this company (e.g. the legacy getBranchByZip 1/2 mapping
  // hitting a tenant whose branches have different ids, like co4) — fall back to
  // the company-level gate so a stale/foreign branchId can't falsely suppress a
  // tenant whose company gate is open. Tenants with real matching branches keep
  // per-branch gating unchanged.
  const branch_comms_enabled = (branchId != null && branchFound) ? branchComms : enabled;

  const reason =
    process.env.COMMS_ENABLED !== "true" ? "comms_disabled"          // global master
    : !company_comms_enabled ? "company_comms_disabled"               // per-tenant master
    : !enabled ? "twilio_disabled"                                    // company Twilio go-live
    : !branch_comms_enabled ? "branch_comms_disabled"                 // per-branch gate
    : !(account_sid && auth_token) ? "twilio_unconfigured"
    : !from_number ? "no_from_number"
    : undefined;

  return { enabled, company_comms_enabled, branch_comms_enabled, account_sid, auth_token, from_number, reason };
}

// Send an SMS (or MMS when mediaUrls provided) via Twilio REST (no SDK).
// Returns the Twilio response (sid, status, error_code). Throws on non-2xx.
export async function sendSmsVia(sender: ResolvedSender, to: string, body: string, mediaUrls?: string[]): Promise<any> {
  const params: Record<string, string> = { From: sender.from_number!, To: to, Body: body };
  if (mediaUrls && mediaUrls.length > 0) {
    // Twilio accepts one MediaUrl per API call; for multiple images, only the first
    // is sent. The spec supports sending multiple messages if needed.
    params.MediaUrl = mediaUrls[0];
  }
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sender.account_sid}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${sender.account_sid}:${sender.auth_token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Twilio ${resp.status} code=${data?.code ?? "?"}: ${data?.message ?? JSON.stringify(data).slice(0, 200)}`);
  return data; // { sid, status, error_code, ... }
}

// Validate a company's Twilio creds with a lightweight authenticated GET on the
// account resource. Returns { authenticated, status, detail } — never throws.
export async function validateTwilioCreds(companyId: number): Promise<{ authenticated: boolean; status: number; detail: string }> {
  const cr = await db.execute(sql`SELECT twilio_account_sid, twilio_auth_token FROM companies WHERE id = ${companyId} LIMIT 1`);
  const c: any = cr.rows[0] ?? {};
  if (!c.twilio_account_sid || !c.twilio_auth_token) return { authenticated: false, status: 0, detail: "creds_missing" };
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.twilio_account_sid}.json`, {
      headers: { "Authorization": "Basic " + Buffer.from(`${c.twilio_account_sid}:${c.twilio_auth_token}`).toString("base64") },
    });
    const data: any = await resp.json().catch(() => ({}));
    return {
      authenticated: resp.ok,
      status: resp.status,
      detail: resp.ok ? `account ${data?.friendly_name ?? data?.sid ?? ""} status=${data?.status ?? "?"}` : `code=${data?.code ?? "?"} ${data?.message ?? ""}`.slice(0, 200),
    };
  } catch (e: any) {
    return { authenticated: false, status: -1, detail: e?.message || "request_failed" };
  }
}

// Diagnose the DEPLOYED Resend key: which account/domains it can actually send
// from. A send from an unverified domain (or a wrong/invalid key) is the classic
// "API said ok but nothing arrived" — this surfaces it. Never throws.
export async function validateResend(): Promise<{ ok: boolean; key_present: boolean; key_prefix: string; status: number; domains: Array<{ name: string; status: string; region?: string }>; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, key_present: false, key_prefix: "", status: 0, domains: [], error: "RESEND_API_KEY missing" };
  try {
    const resp = await fetch("https://api.resend.com/domains", { headers: { Authorization: "Bearer " + key } });
    const data: any = await resp.json().catch(() => ({}));
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const domains = list.map((d: any) => ({ name: d.name, status: d.status, region: d.region }));
    return { ok: resp.ok, key_present: true, key_prefix: key.slice(0, 8), status: resp.status, domains, error: resp.ok ? undefined : (data?.message || data?.name || `http_${resp.status}`) };
  } catch (e: any) {
    return { ok: false, key_present: true, key_prefix: key.slice(0, 8), status: -1, domains: [], error: e?.message || "request_failed" };
  }
}

// Fetch a single sent email's delivery status from Resend by id (server-side,
// uses the deployed key). Returns the delivery event (delivered/sent/bounced/…)
// so we can confirm ACTUAL delivery, not just our "sent". Never throws.
export async function getResendEmailStatus(id: string): Promise<{ ok: boolean; http: number; last_event: string; to: string; subject: string; created_at: string; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, http: 0, last_event: "", to: "", subject: "", created_at: "", error: "RESEND_API_KEY missing" };
  try {
    const resp = await fetch(`https://api.resend.com/emails/${encodeURIComponent(id)}`, { headers: { Authorization: "Bearer " + key } });
    const d: any = await resp.json().catch(() => ({}));
    return {
      ok: resp.ok,
      http: resp.status,
      last_event: String(d?.last_event ?? d?.status ?? ""),
      to: Array.isArray(d?.to) ? d.to.join(",") : String(d?.to ?? ""),
      subject: String(d?.subject ?? ""),
      created_at: String(d?.created_at ?? ""),
      error: resp.ok ? undefined : (d?.message || d?.name || `http_${resp.status}`),
    };
  } catch (e: any) {
    return { ok: false, http: -1, last_event: "", to: "", subject: "", created_at: "", error: e?.message || "request_failed" };
  }
}
