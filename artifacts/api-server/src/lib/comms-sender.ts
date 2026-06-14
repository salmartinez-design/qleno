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

// Send an SMS via Twilio REST (no SDK). Throws on non-2xx.
export async function sendSmsVia(sender: ResolvedSender, to: string, body: string): Promise<void> {
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sender.account_sid}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${sender.account_sid}:${sender.auth_token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: sender.from_number!, To: to, Body: body }).toString(),
  });
  if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}
