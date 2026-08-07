// [portal-view-as 2026-08-07] Where an office "View as customer" link lands.
// Redeems the one-time token into a READ-ONLY portal session and forwards to
// the right screen. No UI to speak of — it exists so the raw token never has to
// be handled by the office app, and so the link dies on first use.
import { useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function PortalEnterPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  const [error, setError] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) { setError("This link is incomplete."); return; }
    (async () => {
      try {
        const r = await fetch(`${API}/api/portal/auth/enter`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const d = await r.json();
        if (!r.ok) { setError(d.message || "That link has expired or was already used."); return; }
        localStorage.setItem(`portal_token_${slug}`, d.token);
        localStorage.setItem(`portal_caps_${slug}`, JSON.stringify(d.capabilities ?? {}));
        // Same fork as a real sign-in — a commercial contact's screen is not
        // the residential one, and support staff need to see what the customer
        // sees, not an approximation of it.
        navigate(d.capabilities?.kind === "commercial"
          ? `/portal/${slug}/account`
          : `/portal/${slug}/dashboard`);
      } catch {
        setError("Could not open that session — please try again.");
      }
    })();
  }, [slug]);

  return (
    <div style={{ minHeight: "100vh", background: "#F7F6F3", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      {error ? (
        <div style={{ background: "#FFFFFF", borderRadius: 14, padding: "32px 36px", maxWidth: 420, textAlign: "center", boxShadow: "0 4px 32px rgba(0,0,0,0.10)" }}>
          <p style={{ fontSize: 15, color: "#B3261E", margin: "0 0 8px", fontWeight: 600 }}>{error}</p>
          <p style={{ fontSize: 13, color: "#6B6860", margin: 0 }}>
            View-as links are single-use and expire after 15 minutes. Open a fresh one from the customer's page.
          </p>
        </div>
      ) : (
        <p style={{ color: "#9E9B94", fontSize: 14 }}>Opening the customer's view…</p>
      )}
    </div>
  );
}
