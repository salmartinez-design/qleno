import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { ShieldCheck, AlertCircle, Clock, CheckCircle, CreditCard } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

type State = "loading" | "invalid" | "expired" | "used" | "valid" | "saving" | "success" | "error";

interface LinkData {
  link: { id: number; purpose: string; amount: string | null; expires_at: string };
  company: { id: number; name: string; logo_url: string | null; brand_color: string };
  client: { id: number; first_name: string; last_name: string } | null;
  invoice_number: string | null;
  stripe_publishable_key: string | null;
  client_secret: string | null;
}

export default function PayPage() {
  const [, params] = useRoute("/pay/:token");
  const token = params?.token ?? "";

  const [state, setState] = useState<State>("loading");
  const [data, setData] = useState<LinkData | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  // Card form state (used when Stripe is not configured — shows manual info)
  const [cardName, setCardName] = useState("");
  const [stripeLoaded, setStripeLoaded] = useState(false);
  const [stripeElements, setStripeElements] = useState<any>(null);
  const [stripeInstance, setStripeInstance] = useState<any>(null);

  useEffect(() => {
    if (!token) { setState("invalid"); return; }
    fetch(`${BASE}/api/payment-links/public/${token}`)
      .then(r => r.json())
      .then(res => {
        if (res.error === "INVALID_LINK") { setState("invalid"); return; }
        if (res.error === "EXPIRED") { setState("expired"); return; }
        if (res.error === "ALREADY_USED") { setState("used"); return; }
        if (res.error) { setState("invalid"); return; }
        setData(res);
        setState("valid");
      })
      .catch(() => setState("invalid"));
  }, [token]);

  // Load Stripe.js when we have a publishable key + client secret
  useEffect(() => {
    if (state !== "valid" || !data?.stripe_publishable_key || !data?.client_secret) return;
    const existing = document.getElementById("stripe-js");
    if (existing) { mountStripe(); return; }
    const script = document.createElement("script");
    script.id = "stripe-js";
    script.src = "https://js.stripe.com/v3/";
    script.onload = () => mountStripe();
    document.head.appendChild(script);
  }, [state, data]);

  function mountStripe() {
    const w = window as any;
    if (!w.Stripe || !data?.stripe_publishable_key || !data?.client_secret) return;
    const stripe = w.Stripe(data.stripe_publishable_key);
    const elements = stripe.elements({ clientSecret: data.client_secret });
    const cardElement = elements.create("card", {
      style: {
        base: {
          fontFamily: "'Plus Jakarta Sans', Arial, sans-serif",
          fontSize: "15px",
          color: "#1A1917",
          "::placeholder": { color: "#9E9B94" },
        },
      },
    });
    cardElement.mount("#stripe-card-element");
    setStripeInstance(stripe);
    setStripeElements(elements);
    setStripeLoaded(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;

    setState("saving");

    // If Stripe is configured, confirm the setup intent
    if (stripeInstance && stripeElements && data.client_secret) {
      const cardElement = stripeElements.getElement("card");
      const { error, setupIntent } = await stripeInstance.confirmCardSetup(data.client_secret, {
        payment_method: { card: cardElement, billing_details: { name: cardName } },
      });
      if (error) {
        setErrorMsg(error.message || "Card error");
        setState("error");
        return;
      }
      // Notify API
      const res = await fetch(`${BASE}/api/payment-links/public/${token}/save-card`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_method_id: setupIntent.payment_method }),
      });
      const result = await res.json();
      if (!res.ok) {
        setErrorMsg(result.error || "Failed to save card");
        setState("error");
        return;
      }
      setState("success");
    } else {
      // Stripe not configured — inform user
      setErrorMsg("Payment processing is not configured for this company. Please contact them directly.");
      setState("error");
    }
  }

  const brand = data?.company?.brand_color || "#5B9BD5";
  const companyName = data?.company?.name || "Qleno";
  const clientName = data?.client ? `${data.client.first_name} ${data.client.last_name}` : "there";

  return (
    <div style={{ minHeight: "100vh", background: "#F7F6F3", fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 16px" }}>
      <div style={{ width: "100%", maxWidth: 480 }}>
        {/* Header */}
        {data && (
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            {data.company.logo_url ? (
              <img src={data.company.logo_url} alt={companyName} style={{ height: 48, objectFit: "contain", marginBottom: 8 }} />
            ) : (
              <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 48, height: 48, borderRadius: 12, background: brand, color: "#fff", fontWeight: 700, fontSize: 20, marginBottom: 8 }}>
                {companyName[0]}
              </div>
            )}
            <div style={{ fontWeight: 700, fontSize: 18, color: "#1A1917" }}>{companyName}</div>
          </div>
        )}

        <div style={{ background: "#fff", borderRadius: 16, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", overflow: "hidden" }}>

          {/* Loading */}
          {state === "loading" && (
            <div style={{ padding: 48, textAlign: "center", color: "#6B7280", fontSize: 14 }}>
              Verifying link...
            </div>
          )}

          {/* Invalid */}
          {state === "invalid" && (
            <StatusCard
              icon={<AlertCircle size={40} color="#DC2626" />}
              title="This link is invalid"
              body="Please contact the company for a new link."
            />
          )}

          {/* Expired */}
          {state === "expired" && (
            <StatusCard
              icon={<Clock size={40} color="#D97706" />}
              title="This link has expired"
              body={`Please contact ${companyName || "the company"} for a new link.`}
            />
          )}

          {/* Already used */}
          {state === "used" && (
            <StatusCard
              icon={<CheckCircle size={40} color="#059669" />}
              title="Payment method already saved"
              body="Your card has already been saved. No further action is needed."
            />
          )}

          {/* Success */}
          {state === "success" && (
            <StatusCard
              icon={<CheckCircle size={40} color="#059669" />}
              title="Payment method saved"
              body={`Thank you, ${clientName}. ${companyName} will use this card for future invoices.`}
              accent="#059669"
            />
          )}

          {/* Error after attempt */}
          {state === "error" && (
            <div style={{ padding: "32px 32px 0" }}>
              <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 13, color: "#DC2626" }}>
                {errorMsg}
              </div>
              <button
                onClick={() => setState("valid")}
                style={{ width: "100%", background: brand, color: "#fff", border: "none", borderRadius: 8, padding: "14px 0", fontWeight: 600, fontSize: 15, cursor: "pointer", fontFamily: FF, marginBottom: 32 }}
              >
                Try Again
              </button>
            </div>
          )}

          {/* Valid — card form */}
          {(state === "valid" || state === "saving") && data && (
            <form onSubmit={handleSubmit} style={{ padding: "32px" }}>
              {/* Purpose header */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <CreditCard size={20} color={brand} />
                  <span style={{ fontWeight: 700, fontSize: 17, color: "#1A1917" }}>
                    {data.link.purpose === "pay_invoice"
                      ? `Pay Invoice${data.invoice_number ? ` #${data.invoice_number}` : ""} — $${parseFloat(data.link.amount || "0").toFixed(2)}`
                      : "Save Payment Method"}
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 13, color: "#6B7280", lineHeight: 1.5 }}>
                  {data.link.purpose === "pay_invoice"
                    ? `Complete your payment for ${companyName}.`
                    : `Save your card for future invoices from ${companyName}. You will not be charged today.`}
                </p>
              </div>

              {/* Cardholder name */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Cardholder Name</label>
                <input
                  value={cardName}
                  onChange={e => setCardName(e.target.value)}
                  placeholder="Full name on card"
                  required
                  style={{ width: "100%", padding: "11px 14px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 15, fontFamily: FF, color: "#1A1917", background: "#fff", outline: "none", boxSizing: "border-box" }}
                />
              </div>

              {/* Stripe Card Element or not-configured notice */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Card Details</label>
                {data.stripe_publishable_key ? (
                  <div
                    id="stripe-card-element"
                    style={{ padding: "12px 14px", border: "1px solid #E5E2DC", borderRadius: 8, background: "#fff", minHeight: 44 }}
                  />
                ) : (
                  <div style={{ padding: "12px 14px", border: "1px solid #E5E2DC", borderRadius: 8, background: "#F7F6F3", fontSize: 13, color: "#9E9B94" }}>
                    Payment processing is not yet configured for this company.
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={state === "saving" || !data.stripe_publishable_key}
                style={{
                  width: "100%",
                  background: (!data.stripe_publishable_key) ? "#E5E2DC" : brand,
                  color: (!data.stripe_publishable_key) ? "#9E9B94" : "#fff",
                  border: "none", borderRadius: 8, padding: "14px 0",
                  fontWeight: 600, fontSize: 15, cursor: (!data.stripe_publishable_key) ? "not-allowed" : "pointer",
                  fontFamily: FF, marginBottom: 16,
                  opacity: state === "saving" ? 0.7 : 1,
                }}
              >
                {state === "saving"
                  ? "Saving..."
                  : data.link.purpose === "pay_invoice"
                    ? `Pay $${parseFloat(data.link.amount || "0").toFixed(2)}`
                    : "Save Card Securely"}
              </button>

              {/* Security badge */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, color: "#9E9B94" }}>
                <ShieldCheck size={14} />
                <span>Secured by Stripe — your card details are never stored on our servers</span>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusCard({ icon, title, body, accent }: { icon: React.ReactNode; title: string; body: string; accent?: string }) {
  return (
    <div style={{ padding: "48px 32px", textAlign: "center" }}>
      <div style={{ marginBottom: 16 }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 18, color: "#1A1917", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 14, color: "#6B7280", lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}
