import { useEffect, useState } from "react";
import { useRoute } from "wouter";

import { QlenoMark } from "@/components/brand/QlenoMark";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
// Locked brand palette for this priced-doc surface (Phes quote/estimate page).
const NAVY = "#0A0E1A";
const MINT = "#00C9A0";
const SUBLINE = "#9DA3B0";
// Real Phes logo asset (public/). Used when the tenant has no logo_url of its own.
const PHES_LOGO = `${API}/phes-logo.jpeg`;
// Contact comes from the estimate's branch (when set) or the company — never
// hardcode a branch. tel: link is the digits with a US +1 prefix.
const telOf = (phone: string) => `+1${phone.replace(/\D/g, "").replace(/^1/, "")}`;

type Item = {
  name: string | null;
  description: string | null;
  pricing_type: string;
  frequency: string | null;
  quantity: string;
  unit_rate: string;
  amount: string;
};

type PublicEstimate = {
  id: number;
  estimate_number: string | null;
  title: string | null;
  intro_note: string | null;
  terms: string | null;
  status: string;
  // [estimate-flat-mode] 'flat' → render scope list + single price; else itemized.
  billing_mode?: string | null;
  // [estimate-flat-clarity] price unit ("/ visit") + optional scope paragraph.
  flat_price_unit?: string | null;
  scope_note?: string | null;
  subtotal: string;
  discount_amount: string;
  total: string;
  valid_until: string | null;
  contact_name: string | null;
  property_name: string | null;
  service_address: string | null;
  accepted_name: string | null;
  accepted_at: string | null;
  created_at: string | null;
  sent_at: string | null;
  company_name: string;
  company_logo: string | null;
  company_brand_color: string | null;
  company_phone?: string | null;
  company_email?: string | null;
  branch_name?: string | null;
  branch_phone?: string | null;
  items: Item[];
  // Phes doc-type model: residential = QUOTE, commercial = ESTIMATE. The public
  // endpoint sets is_quote=true when the token resolved a quote (not an estimate)
  // so this shared page can label itself correctly. NEVER say "Estimate" for a quote.
  is_quote?: boolean;
  // [multi-frequency] comparison tiers (empty when the quote has no snapshot).
  frequency?: string | null;
  selected_frequency?: string | null;
  options?: FreqOption[];
};

type FreqOption = {
  frequency: string;
  label: string;
  recurring: boolean;
  recurring_price: number | null;
  first_visit_price: number;
  hours: number;
  configured: boolean;
};

const money = (n: any) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string) => {
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};
// issue date + N days, returned as YYYY-MM-DD (for a derived "valid until").
const addDays = (d: string, days: number) => {
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  const dt = new Date(y, m - 1, day);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};

// [estimate-hosted-page 2026-06-10] The customer-facing estimate: the link the
// office texts/emails to a property manager. No login. Branded with the
// tenant's logo + brand color, line items, totals, terms, Accept (records the
// acceptor's name) and Download PDF (print-optimized layout — the browser's
// Save as PDF produces the document).
export default function EstimatePublicPage() {
  // Shared hosted page for both doc types. /quote/:token (residential quotes)
  // and /estimate/:token (commercial estimates) render the same component; the
  // record type is confirmed by is_quote in the API payload.
  const [, pEst] = useRoute("/estimate/:token");
  const [matchQuote, pQuote] = useRoute("/quote/:token");
  const token = pQuote?.token ?? pEst?.token ?? "";
  const routeIsQuote = !!matchQuote;

  const [est, setEst] = useState<PublicEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAccept, setShowAccept] = useState(false);
  // [accept-one-tap 2026-07-22] The typed-name step was dropped — accepting is
  // now a plain yes/no. We already know WHO this doc was prepared for, so the
  // acceptance record keeps naming them via contact_name instead of asking the
  // customer to retype it.

  const [smsConsent, setSmsConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // [multi-frequency] the customer's highlighted tier (defaults to their prior
  // choice, else the "Most popular" weekly tier, else the first option).
  const [selectedFreq, setSelectedFreq] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/api/estimates/public/${encodeURIComponent(token)}`);
        if (!r.ok) throw new Error();
        setEst(await r.json());
      } catch {
        setError(`This ${routeIsQuote ? "quote" : "estimate"} link is invalid or no longer available.`);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  async function accept() {
    // The backend still records an accepting name; source it from the doc's own
    // contact rather than a form field the customer has to fill in.
    const signer = (est?.contact_name || est?.property_name || "Customer").trim();
    setSubmitting(true);
    setActionMsg(null);
    try {
      // [multi-frequency] include the customer's chosen tier (default = weekly
      // "most popular" / first option if they didn't tap). Backend persists +
      // warms the lead (Piece 3); harmless on the current accept until then.
      const opts = (est?.options || []).filter(o => o.configured);
      const freq = selectedFreq || est?.selected_frequency
        || opts.find(o => o.frequency === "weekly")?.frequency
        || opts[0]?.frequency || null;
      const r = await fetch(`${API}/api/estimates/public/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: signer, selected_frequency: freq, sms_consent: smsConsent }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setActionMsg(body.message || "Could not accept — please contact us."); return; }
      setEst(e => e ? { ...e, status: "accepted", accepted_name: signer, accepted_at: new Date().toISOString(), selected_frequency: freq } : e);
      setShowAccept(false);
    } finally {
      setSubmitting(false);
    }
  }

  // Doc-type labels. is_quote (from the payload) wins; before load, fall back to
  // the route. Residential quote → "Quote", commercial → "Estimate".
  const isQuote = est?.is_quote ?? routeIsQuote;
  const DOC = isQuote ? "Quote" : "Estimate";
  const docLower = isQuote ? "quote" : "estimate";

  if (loading) {
    return <div style={{ minHeight: "100vh", background: "#F7F6F3", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FF, color: MUTE }}>{`Loading ${docLower}…`}</div>;
  }
  if (error || !est) {
    return (
      <div style={{ minHeight: "100vh", background: "#F7F6F3", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FF, padding: 20 }}>
        <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 14, padding: "32px 28px", maxWidth: 420, textAlign: "center" }}>
          <p style={{ fontSize: 16, fontWeight: 700, color: INK, margin: "0 0 6px" }}>{DOC} unavailable</p>
          <p style={{ fontSize: 14, color: MUTE, margin: 0 }}>{error || `This ${docLower} link is invalid or no longer available.`}</p>
        </div>
      </div>
    );
  }

  const isAccepted = est.status === "accepted";
  const isDeclined = est.status === "declined";
  const isExpired = est.status === "expired";

  // Tenant logo if set, else the real Phes logo asset. Masthead wordmark uses
  // the tenant's own name. Prepared-by falls back to the company name.
  const logoSrc = est.company_logo || PHES_LOGO;
  const preparedBy = est.company_name || "Phes Schaumburg";
  // Issue date = quote created (fallback sent). Valid-until = explicit value,
  // else issue + 30 days (derived, no new field).
  const issueDate = est.created_at || est.sent_at || null;
  const validUntil = est.valid_until || (issueDate ? addDays(issueDate, 30) : null);

  // [multi-frequency] configured tiers + the customer's current choice.
  const freqOpts = (Array.isArray(est.options) ? est.options : []).filter(o => o.configured);
  const hasOptions = freqOpts.length > 0;
  const chosenFreq = selectedFreq || est.selected_frequency
    || freqOpts.find(o => o.frequency === "weekly")?.frequency
    || (freqOpts[0]?.frequency ?? null);
  const chosenOpt = freqOpts.find(o => o.frequency === chosenFreq) || null;

  return (
    <div style={{ minHeight: "100vh", background: "#F7F6F3", fontFamily: FF, padding: "24px 14px 60px" }}>
      <style>{`
        @media print {
          body { background: #fff !important; }
          .est-noprint { display: none !important; }
          .est-card { border: none !important; box-shadow: none !important; }
        }
      `}</style>
      <div style={{ maxWidth: 680, margin: "0 auto" }}>

        {/* Status banner */}
        {isAccepted && (
          <div style={{ background: "#ECFDF5", border: "1px solid #99E9D3", borderRadius: 12, padding: "14px 18px", marginBottom: 14 }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: "#047857", margin: 0 }}>
              Accepted{est.accepted_name ? ` by ${est.accepted_name}` : ""} — thank you! We'll be in touch shortly to schedule.
            </p>
          </div>
        )}
        {isDeclined && (
          <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "14px 18px", marginBottom: 14 }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: "#991B1B", margin: 0 }}>{`This ${docLower} was declined. Contact us if you'd like a revised proposal.`}</p>
          </div>
        )}
        {isExpired && (
          <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 12, padding: "14px 18px", marginBottom: 14 }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: "#92400E", margin: 0 }}>{`This ${docLower} has expired. Contact us for updated pricing.`}</p>
          </div>
        )}

        <div className="est-card" style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 16, overflow: "hidden" }}>
          {/* Navy masthead — logo + wordmark left, doc number right */}
          <div style={{ background: NAVY, padding: "20px 28px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
              <img src={logoSrc} alt={est.company_name} style={{ height: 40, width: "auto", borderRadius: 8, background: "#fff", objectFit: "contain" }} />
              <div>
                <p style={{ fontSize: 18, fontWeight: 700, color: "#FFFFFF", margin: 0, letterSpacing: "-0.01em" }}>{est.company_name}</p>
                <p style={{ fontSize: 12, color: SUBLINE, margin: "2px 0 0" }}>Residential &amp; Commercial Cleaning</p>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ fontSize: 11, color: SUBLINE, margin: 0, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>{DOC}</p>
              {est.estimate_number && <p style={{ fontSize: 15, fontWeight: 700, color: "#FFFFFF", margin: "2px 0 0" }}>{est.estimate_number}</p>}
            </div>
          </div>

          <div style={{ padding: "22px 28px" }}>
            {/* Prepared for / by + dates */}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 20, flexWrap: "wrap", marginBottom: 18 }}>
              {(est.contact_name || est.property_name || est.service_address) && (
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 5px" }}>Prepared for</p>
                  {est.contact_name && <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: 0 }}>{est.contact_name}</p>}
                  {est.property_name && <p style={{ fontSize: 13, color: INK, margin: "2px 0 0" }}>{est.property_name}</p>}
                  {est.service_address && <p style={{ fontSize: 13, color: MUTE, margin: "2px 0 0" }}>{est.service_address}</p>}
                </div>
              )}
              <div style={{ textAlign: "right" }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 5px" }}>Prepared by</p>
                <p style={{ fontSize: 14, fontWeight: 700, color: INK, margin: 0 }}>{preparedBy}</p>
                {issueDate && <p style={{ fontSize: 12, color: MUTE, margin: "4px 0 0" }}>Issued {fmtDate(issueDate)}</p>}
                {validUntil && <p style={{ fontSize: 12, color: isExpired ? "#991B1B" : MUTE, margin: "2px 0 0" }}>Valid until {fmtDate(validUntil)}</p>}
              </div>
            </div>

            {est.title && <h1 style={{ fontSize: 19, fontWeight: 800, color: INK, margin: "0 0 8px" }}>{est.title}</h1>}
            {est.intro_note && <p style={{ fontSize: 14, color: "#4B5563", margin: "0 0 18px", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{est.intro_note}</p>}

            {(() => {
              const opts = (Array.isArray(est.options) ? est.options : []).filter(o => o.configured);
              // [estimate-flat-mode] One price + a scope checklist (no per-line
              // prices). The total is the single flat price the office set.
              if (est.billing_mode === "flat") {
                const unitSuffix = est.flat_price_unit && est.flat_price_unit !== "total" ? ` / ${est.flat_price_unit}` : "";
                return (
                  <>
                    {est.scope_note && (
                      <p style={{ fontSize: 14, color: "#374151", margin: "0 0 16px", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{est.scope_note}</p>
                    )}
                    {est.items.length > 0 && (
                      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px 16px", marginBottom: 18 }}>
                        <p style={{ fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 10px" }}>What's included</p>
                        {est.items.map((it, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "6px 0" }}>
                            <span style={{ width: 18, height: 18, borderRadius: 5, background: MINT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1, fontSize: 12, fontWeight: 800, lineHeight: 1 }}>✓</span>
                            <span style={{ fontSize: 14, color: INK }}>
                              {it.name || "Service"}
                              {it.frequency && <span style={{ color: MUTE }}>{` · ${it.frequency}`}</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginBottom: 18 }}>
                      {Number(est.discount_amount) > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#047857", padding: "3px 0" }}>
                          <span>Discount</span><span>−{money(est.discount_amount)}</span>
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderTop: `2px solid ${INK}`, marginTop: 8, paddingTop: 10 }}>
                        <span style={{ fontSize: 15, fontWeight: 800, color: INK }}>Total</span>
                        <span style={{ fontSize: 26, fontWeight: 800, color: MINT, letterSpacing: "-0.01em" }}>{money(est.total)}<span style={{ fontSize: 15, fontWeight: 700, color: MUTE }}>{unitSuffix}</span></span>
                      </div>
                    </div>
                  </>
                );
              }
              // No snapshot → keep the original single line-items + total render.
              if (opts.length < 1) {
                return (
                  <>
                    {/* Line items */}
                    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden", marginBottom: 18 }}>
                      {est.items.map((it, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 14, padding: "13px 16px", borderTop: i === 0 ? "none" : `1px solid ${BORDER}`, alignItems: "flex-start" }}>
                          <div style={{ minWidth: 0 }}>
                            <p style={{ fontSize: 14, fontWeight: 700, color: INK, margin: 0 }}>{it.name || "Service"}</p>
                            <p style={{ fontSize: 12, color: MUTE, margin: "3px 0 0" }}>
                              {[
                                it.frequency,
                                it.pricing_type === "hourly" ? `${Number(it.quantity).toFixed(1)} hrs × ${money(it.unit_rate)}/hr`
                                  : Number(it.quantity) !== 1 ? `${Number(it.quantity)} × ${money(it.unit_rate)}` : null,
                              ].filter(Boolean).join(" · ")}
                            </p>
                            {it.description && <p style={{ fontSize: 12, color: "#4B5563", margin: "4px 0 0", lineHeight: 1.5 }}>{it.description}</p>}
                          </div>
                          <p style={{ fontSize: 14, fontWeight: 700, color: INK, margin: 0, flexShrink: 0 }}>{money(it.amount)}</p>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginBottom: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: MUTE, padding: "3px 0" }}>
                        <span>Subtotal</span><span>{money(est.subtotal)}</span>
                      </div>
                      {Number(est.discount_amount) > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#047857", padding: "3px 0" }}>
                          <span>Discount</span><span>−{money(est.discount_amount)}</span>
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `2px solid ${INK}`, marginTop: 8, paddingTop: 10 }}>
                        <span style={{ fontSize: 15, fontWeight: 800, color: INK }}>Total</span>
                        <span style={{ fontSize: 26, fontWeight: 800, color: MINT, letterSpacing: "-0.01em" }}>{money(est.total)}</span>
                      </div>
                    </div>
                  </>
                );
              }
              // Multi-frequency comparison.
              const activeFreq = chosenFreq;
              return (
                <div style={{ marginBottom: 18 }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: INK, margin: "0 0 4px" }}>Choose your plan</p>
                  <p style={{ fontSize: 12, color: MUTE, margin: "0 0 14px" }}>Recurring plans lock in a lower per-visit rate. Tap a plan to select it.</p>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
                    {opts.map((o) => {
                      const active = o.frequency === activeFreq;
                      const popular = o.frequency === "weekly";
                      return (
                        <button key={o.frequency} onClick={() => setSelectedFreq(o.frequency)}
                          style={{ position: "relative", textAlign: "left", cursor: "pointer", borderRadius: 12, padding: "16px 14px 14px",
                            background: active ? "#F3FBF8" : "#fff", border: active ? `2px solid ${MINT}` : `1px solid ${BORDER}`,
                            fontFamily: FF }}>
                          {popular && (
                            <span style={{ position: "absolute", top: -9, left: 12, background: NAVY, color: "#fff", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, letterSpacing: "0.02em" }}>Most popular</span>
                          )}
                          <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 6 }}>{o.label}</div>
                          {o.recurring ? (
                            <>
                              <div style={{ fontSize: 22, fontWeight: 800, color: MINT, letterSpacing: "-0.01em", lineHeight: 1.1 }}>{money(o.recurring_price)}</div>
                              <div style={{ fontSize: 11, color: MUTE, margin: "1px 0 6px" }}>per visit</div>
                              <div style={{ fontSize: 11, color: MUTE }}>First visit {money(o.first_visit_price)}</div>
                            </>
                          ) : (
                            <>
                              <div style={{ fontSize: 22, fontWeight: 800, color: MINT, letterSpacing: "-0.01em", lineHeight: 1.1 }}>{money(o.first_visit_price)}</div>
                              <div style={{ fontSize: 11, color: MUTE, margin: "1px 0 6px" }}>one-time</div>
                            </>
                          )}
                          <div style={{ fontSize: 11, color: MUTE, marginTop: 4 }}>~{o.hours} hrs / visit</div>
                          <div style={{ marginTop: 10, textAlign: "center", fontSize: 12, fontWeight: 700, color: active ? NAVY : MUTE }}>
                            {active ? "✓ Selected" : "Select"}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {est.terms && (
              <div style={{ background: "#F7F6F3", borderRadius: 10, padding: "12px 14px", marginBottom: 4 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Terms</p>
                <p style={{ fontSize: 12, color: "#4B5563", margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{est.terms}</p>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="est-noprint" style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          {!isAccepted && !isDeclined && !isExpired && (
            <button onClick={() => setShowAccept(true)}
              style={{ flex: "1 1 200px", height: 50, background: MINT, color: "#04241d", border: "none", borderRadius: 12, fontSize: 16, fontWeight: 800, cursor: "pointer", fontFamily: FF }}>
              {hasOptions ? "Select this plan" : `Accept ${DOC}`}
            </button>
          )}
          <button onClick={() => window.print()}
            style={{ flex: "1 1 160px", height: 50, background: "#fff", color: INK, border: `1px solid ${BORDER}`, borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
            {`Download ${DOC} PDF`}
          </button>
        </div>

        {/* Contact block — branch contact when set, else company; never hardcoded. */}
        {(() => {
          const phone = est.branch_phone || est.company_phone || null;
          const email = est.company_email || null;
          if (!phone && !email) return null;
          return (
            <div style={{ textAlign: "center", marginTop: 22, fontSize: 13, color: MUTE, lineHeight: 1.6 }}>
              Questions? Call or text{" "}
              {phone && <a href={`tel:${telOf(phone)}`} style={{ color: INK, fontWeight: 700, textDecoration: "none" }}>{phone}</a>}
              {phone && email && " · "}
              {email && <a href={`mailto:${email}`} style={{ color: INK, fontWeight: 700, textDecoration: "none" }}>{email}</a>}
            </div>
          );
        })()}

        {/* Footer — Powered by Qleno (the only Qleno mention) */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 18, paddingTop: 16, borderTop: `1px solid ${BORDER}` }}>
          <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 500 }}>Powered by</span>
          <QlenoMark size={15} />
          <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 700 }}>Qleno</span>
        </div>
      </div>

      {/* Accept modal */}
      {showAccept && (
        <div className="est-noprint" style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18, zIndex: 50 }}>
          <div style={{ background: "#fff", borderRadius: 16, padding: "24px 22px", width: "100%", maxWidth: 380 }}>
            <p style={{ fontSize: 17, fontWeight: 800, color: INK, margin: "0 0 4px" }}>{hasOptions ? "Confirm your plan?" : `Accept this ${docLower}?`}</p>
            {hasOptions && chosenOpt ? (
              <p style={{ fontSize: 13, color: MUTE, margin: "0 0 14px" }}>
                <strong style={{ color: INK }}>{chosenOpt.label}</strong>
                {chosenOpt.recurring
                  ? <> — <strong style={{ color: INK }}>{money(chosenOpt.recurring_price)}</strong>/visit (first visit {money(chosenOpt.first_visit_price)})</>
                  : <> — <strong style={{ color: INK }}>{money(chosenOpt.first_visit_price)}</strong></>}
                . We'll confirm your booking and be in touch to schedule.
              </p>
            ) : (
              <p style={{ fontSize: 13, color: MUTE, margin: "0 0 14px" }}>Total: <strong style={{ color: INK }}>{money(est.total)}</strong>. We'll be in touch shortly to schedule.</p>
            )}
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer", margin: "0 0 12px" }}>
              <input type="checkbox" checked={smsConsent} onChange={e => setSmsConsent(e.target.checked)} style={{ marginTop: 3, accentColor: MINT, width: 16, height: 16, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: MUTE, lineHeight: 1.55 }}>
                By checking this box, you agree to receive recurring automated marketing and transactional text messages (promotions, offers, and appointment updates) from Phes at the number provided. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for help. You must be 18 or older. See our{" "}
                <a href="https://phes.io/terms" target="_blank" rel="noopener noreferrer" style={{ color: "#2199e8", textDecoration: "underline" }}>Terms of Service</a>
                {" "}and{" "}
                <a href="https://phes.io/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: "#2199e8", textDecoration: "underline" }}>Privacy Policy</a>.
              </span>
            </label>
            {actionMsg && <p style={{ fontSize: 12, color: "#991B1B", margin: "0 0 10px" }}>{actionMsg}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setShowAccept(false); setActionMsg(null); }} disabled={submitting}
                style={{ flex: 1, height: 44, background: "#fff", color: INK, border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
                No, not yet
              </button>
              <button onClick={accept} disabled={submitting}
                style={{ flex: 1.4, height: 44, background: MINT, color: "#04241d", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: submitting ? "not-allowed" : "pointer", fontFamily: FF, opacity: submitting ? 0.7 : 1 }}>
                {submitting ? "Confirming…" : "Yes, accept"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
