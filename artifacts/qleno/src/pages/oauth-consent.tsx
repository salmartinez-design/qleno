// [ai-access-oauth 2026-08-16] The consent screen — the one moment a human is
// in the loop of the whole OAuth flow.
//
// The tenant arrives here from /oauth/authorize, having pasted the Qleno MCP
// address into Claude, ChatGPT, Gemini, or Grok. What they approve is standing
// read access to their schedule, their customers, their invoices, and their
// payroll, granted to a piece of software that reached them through a link.
// So the screen has one job: make WHO is asking and WHAT they get plain enough
// to refuse, before the button is pressed.
//
// Approve and Deny carry equal visual weight, deliberately. A consent screen
// that styles Approve as the obvious choice trains people to click through the
// single prompt standing between a stranger's connector and their customer
// list — and the day that habit matters is the day the connector is hostile.
import { useEffect, useState } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { ShieldCheck, AlertTriangle } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// getAuthHeaders() is typed as a union whose second arm has no Authorization
// key, which fetch's HeadersInit will not accept. Narrowed once here rather
// than at each call site.
const authHeaders = (): Record<string, string> => getAuthHeaders() as Record<string, string>;

const BG = "#F7F6F3";
const CARD = "#FFFFFF";
const TEXT = "#1A1917";
const BORDER = "#E5E2DC";
const MUTED = "#6B6862";
const MINT = "#00C9A0";
const NIGHT = "#0A0E1A";
const FONT = "'Plus Jakarta Sans', system-ui, sans-serif";

// Plain English, matching the AI & API Access page word for word. A scope
// described one way where it is granted and another way where it is listed
// reads as two different permissions.
const SCOPE_LABELS: Record<string, string> = {
  "jobs:read": "Schedule, dispatch board, and job details",
  "clients:read": "Customer records, addresses, and service history",
  "invoices:read": "Invoices, payments, and outstanding balances",
  "payroll:read": "Pay, hours, commission, and mileage",
  "reports:read": "Revenue, efficiency, and business reports",
};

interface ConsentDetails {
  client_name: string;
  client_uri: string | null;
  redirect_host: string;
  loopback_only: boolean;
  scopes: string[];
  user: { name: string; email: string; role: string };
  can_approve: boolean;
  company_enabled: boolean;
  plan: string | null;
  // [ai-access-superadmin 2026-08-16] Only true for a live super-admin. Absent
  // on every ordinary consent, which is why the reach control below does not
  // render at all for the tenants who should never see it.
  can_grant_all_companies?: boolean;
  all_companies?: { id: number; name: string }[];
}

export default function OAuthConsentPage() {
  const [details, setDetails] = useState<ConsentDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  // Never preselected. Platform-wide reach is a different thing from connecting
  // a business, and the person approving it has to choose it on purpose.
  const [allCompanies, setAllCompanies] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const scope = params.get("scope") ?? "";
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const resource = params.get("resource") ?? "";

  // Not signed in? Send them through the real login and come back. Reusing the
  // normal login rather than asking for credentials here means MFA, lockout,
  // and the is_active check all apply without being reimplemented — and the
  // connector never sees a password, which is the point of OAuth.
  useEffect(() => {
    if (!getAuthHeaders().Authorization) {
      const back = window.location.pathname + window.location.search;
      window.location.href = `${API}/login?next=${encodeURIComponent(back)}`;
      return;
    }
    const qs = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope });
    fetch(`${API}/api/oauth/consent-details?${qs}`, { headers: authHeaders() })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.message || "Could not load this request");
        setDetails(body);
      })
      .catch((e) => setError(e.message));
  }, [clientId, redirectUri, scope]);

  async function decide(kind: "approve" | "deny") {
    setBusy(kind);
    try {
      const r = await fetch(`${API}/api/oauth/${kind}`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId, redirect_uri: redirectUri, state,
          code_challenge: codeChallenge, scopes: details?.scopes ?? [], resource,
          // The server re-reads the super-admin flag before honoring this; the
          // checkbox is a request, not the authority.
          all_companies: allCompanies,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.message || "Could not complete the request");
      if (body.redirect_to) window.location.href = body.redirect_to;
      else setError("This application did not provide a valid address to return to.");
    } catch (e: any) {
      setError(e.message);
      setBusy(null);
    }
  }

  const shell: React.CSSProperties = {
    minHeight: "100vh", background: BG, fontFamily: FONT, color: TEXT,
    display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
  };
  const card: React.CSSProperties = {
    background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14,
    padding: 28, width: "100%", maxWidth: 460,
  };

  if (error) {
    return (
      <div style={shell}><div style={card}>
        <h1 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 700 }}>Could not connect</h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: MUTED }}>{error}</p>
      </div></div>
    );
  }

  if (!details) {
    return (
      <div style={shell}><div style={card}>
        <p style={{ margin: 0, fontSize: 14, color: MUTED }}>Loading…</p>
      </div></div>
    );
  }

  const blocked = !details.company_enabled || !details.can_approve;

  return (
    <div style={shell}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16 }}>
          <ShieldCheck size={18} color={MINT} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: MUTED }}>
            Qleno
          </span>
        </div>

        <h1 style={{ margin: "0 0 8px", fontSize: 21, fontWeight: 700, lineHeight: 1.3 }}>
          Connect {details.client_name} to your Qleno data?
        </h1>
        <p style={{ margin: "0 0 18px", fontSize: 13.5, lineHeight: 1.6, color: MUTED }}>
          It will read your business as <strong style={{ color: TEXT }}>{details.user.name}</strong> ({details.user.role}),
          so it sees exactly what you see and nothing more. It returns to{" "}
          <strong style={{ color: TEXT }}>{details.redirect_host}</strong>.
        </p>

        {/* Any process on the machine can listen on a loopback port, so the
            address alone cannot prove this is the tool the tenant thinks it is.
            The MCP authorization spec requires surfacing this. */}
        {details.loopback_only && (
          <div style={{ display: "flex", gap: 9, alignItems: "flex-start", border: `1px solid ${BORDER}`,
                        borderRadius: 9, padding: "10px 12px", marginBottom: 16, background: BG }}>
            <AlertTriangle size={15} color="#BA7517" style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 12.5, lineHeight: 1.5, color: MUTED }}>
              This connects to software running on your own computer. Only continue if you
              started this from an app you installed yourself.
            </span>
          </div>
        )}

        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: "13px 14px", marginBottom: 14 }}>
          <span style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 9 }}>It will be able to read</span>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 7 }}>
            {details.scopes.map((s) => (
              <li key={s} style={{ display: "flex", gap: 8, fontSize: 13, lineHeight: 1.45, color: MUTED }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: MINT, flexShrink: 0, marginTop: 6 }} />
                {SCOPE_LABELS[s] ?? s}
              </li>
            ))}
          </ul>
        </div>

        {/* [ai-access-superadmin 2026-08-16] How far this connection reaches.
            Rendered only for a live super-admin with more than one readable
            company, so an ordinary tenant never sees a control that would mean
            nothing to them. Two explicit choices rather than a checkbox: an
            unchecked box states no position, and the narrow option here is a
            real decision that deserves to be visibly made. */}
        {details.can_grant_all_companies && (details.all_companies?.length ?? 0) > 1 && (
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: "13px 14px", marginBottom: 14 }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 9 }}>How far it can reach</span>
            {[
              { value: false, title: "This company only", note: `${details.all_companies![0].name}. The usual choice.` },
              {
                value: true,
                title: `All ${details.all_companies!.length} companies you administer`,
                note: "It can ask about any of them, one at a time.",
              },
            ].map((opt) => (
              <label
                key={String(opt.value)}
                style={{
                  display: "flex", gap: 9, alignItems: "flex-start", cursor: "pointer",
                  padding: "9px 10px", borderRadius: 8, marginTop: 2,
                  border: `1px solid ${allCompanies === opt.value ? NIGHT : "transparent"}`,
                  background: allCompanies === opt.value ? BG : "transparent",
                }}
              >
                <input
                  type="radio"
                  name="reach"
                  checked={allCompanies === opt.value}
                  onChange={() => setAllCompanies(opt.value)}
                  style={{ marginTop: 3, accentColor: NIGHT }}
                />
                <span>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{opt.title}</span>
                  <span style={{ display: "block", fontSize: 12.5, lineHeight: 1.45, color: MUTED }}>{opt.note}</span>
                </span>
              </label>
            ))}

            {/* Named, not counted. "All 4 companies" is a number; the list is
                what a person can actually check before agreeing to it. */}
            {allCompanies && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BORDER}` }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
                  <AlertTriangle size={15} color="#BA7517" style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 12.5, lineHeight: 1.5, color: MUTED }}>
                    {details.client_name} will be able to read the businesses below, with the same access listed above.
                    Each company keeps its own switch — turning AI access off there removes it from this list.
                  </span>
                </div>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 5 }}>
                  {details.all_companies!.map((c) => (
                    <li key={c.id} style={{ fontSize: 12.5, lineHeight: 1.45, color: TEXT }}>{c.name}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Stating the limits is not reassurance copy — it is the actual
            contract. OAuth grants are read-only until Phase 5's injection
            defenses ship, and a tenant who knows that will notice if it ever
            silently changes. */}
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: "13px 14px", marginBottom: 18, background: BG }}>
          <span style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 9 }}>It will not be able to</span>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
            {["Change, cancel, or create anything", "Send any message to a customer", "Charge a card or move money"].map((t) => (
              <li key={t} style={{ fontSize: 13, lineHeight: 1.45, color: MUTED }}>{t}</li>
            ))}
          </ul>
        </div>

        {!details.company_enabled && (
          <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.55, color: "#B4342B" }}>
            AI and API access is switched off for this company. An owner can turn it on under
            Settings → AI &amp; API Access, then start this again.
          </p>
        )}
        {details.company_enabled && !details.can_approve && (
          <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.55, color: "#B4342B" }}>
            Your role cannot approve an AI connection. Ask an owner or admin to connect this.
          </p>
        )}

        {/* Equal weight. See the file header. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button
            onClick={() => decide("deny")}
            disabled={!!busy}
            style={{
              padding: "11px 14px", borderRadius: 9, border: `1px solid ${BORDER}`, background: CARD,
              color: TEXT, fontFamily: FONT, fontSize: 14, fontWeight: 600, cursor: busy ? "default" : "pointer",
            }}
          >
            {busy === "deny" ? "Cancelling…" : "Cancel"}
          </button>
          <button
            onClick={() => decide("approve")}
            disabled={!!busy || blocked}
            style={{
              padding: "11px 14px", borderRadius: 9, border: `1px solid ${blocked ? BORDER : NIGHT}`,
              background: blocked ? BORDER : NIGHT, color: blocked ? MUTED : "#FFFFFF",
              fontFamily: FONT, fontSize: 14, fontWeight: 600,
              cursor: busy || blocked ? "default" : "pointer",
            }}
          >
            {busy === "approve" ? "Connecting…" : "Connect"}
          </button>
        </div>

        <p style={{ margin: "14px 0 0", fontSize: 12, lineHeight: 1.5, color: MUTED, textAlign: "center" }}>
          You can disconnect this at any time under Settings → AI &amp; API Access.
        </p>
      </div>
    </div>
  );
}
