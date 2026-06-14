import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface ResolvedSender {
  enabled: boolean;               // company twilio_enabled gate (company master)
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
    SELECT twilio_enabled, twilio_account_sid, twilio_auth_token, twilio_from_number
      FROM companies WHERE id = ${companyId} LIMIT 1`);
  const c: any = cr.rows[0] ?? {};

  let branchNumber: string | null = null;
  let branchComms = false;
  if (branchId != null) {
    const br = await db.execute(sql`
      SELECT twilio_from_number, comms_enabled FROM branches WHERE id = ${branchId} AND company_id = ${companyId} LIMIT 1`);
    branchNumber = (br.rows[0] as any)?.twilio_from_number ?? null;
    branchComms = !!(br.rows[0] as any)?.comms_enabled;
  }
  const from_number = branchNumber || c.twilio_from_number || null;
  const account_sid = c.twilio_account_sid ?? null;
  const auth_token = c.twilio_auth_token ?? null;
  const enabled = !!c.twilio_enabled;
  // When no branch is specified, fall back to the company master for the branch gate.
  const branch_comms_enabled = branchId != null ? branchComms : enabled;

  const reason =
    process.env.COMMS_ENABLED !== "true" ? "comms_disabled"          // global master
    : !enabled ? "twilio_disabled"                                    // company master
    : !branch_comms_enabled ? "branch_comms_disabled"                 // per-branch gate
    : !(account_sid && auth_token) ? "twilio_unconfigured"
    : !from_number ? "no_from_number"
    : undefined;

  return { enabled, branch_comms_enabled, account_sid, auth_token, from_number, reason };
}

// Send an SMS via Twilio REST (no SDK). Returns the Twilio response (sid, status,
// error_code). Throws on non-2xx with the Twilio error body.
export async function sendSmsVia(sender: ResolvedSender, to: string, body: string): Promise<any> {
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sender.account_sid}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${sender.account_sid}:${sender.auth_token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: sender.from_number!, To: to, Body: body }).toString(),
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
