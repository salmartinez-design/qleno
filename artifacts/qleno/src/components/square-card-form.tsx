// [square-default 2026-07-24] Reusable Square Web Payments SDK card form.
//
// Mirrors the Stripe Payment Element flow, but for Square. The parent supplies
// the PUBLIC config (applicationId + locationId + environment, from
// GET /api/square/config or the public /pay link payload) and a submit label.
// This component:
//   1. loads the Square Web Payments SDK <script> once (host differs by env),
//   2. mounts a single card field into its own container,
//   3. on submit tokenizes the card into a one-time `cnon:` nonce, and
//   4. hands that nonce back via onToken(sourceId) — the parent POSTs it to the
//      right save-card endpoint (office /api/square/clients/:id/save-card or
//      public /api/payment-links/public/:token/save-card-square).
//
// Nothing is charged here — this is card-on-file capture only. The secret
// SQUARE_ACCESS_TOKEN never touches the browser; the SDK only needs the two
// public identifiers to tokenize.
import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";

const FF = "'Plus Jakarta Sans', sans-serif";

// Square serves the SDK from two hosts — production vs sandbox must match the
// environment the applicationId belongs to, or tokenize() rejects.
const SDK_SRC: Record<"production" | "sandbox", string> = {
  production: "https://web.squarecdn.com/v1/square.js",
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
};

type Status = "loading" | "ready" | "tokenizing" | "error";

export interface SquareCardFormProps {
  applicationId: string;
  locationId: string;
  environment: "production" | "sandbox";
  /** Called with the one-time `cnon:` nonce once the card tokenizes cleanly.
      Return a promise; the button stays in its busy state until it resolves. */
  onToken: (sourceId: string) => Promise<void>;
  submitLabel?: string;
  busyLabel?: string;
  /** Accent for the submit button (defaults to the app brand token). */
  accent?: string;
  disabled?: boolean;
}

// Load the SDK script exactly once per environment; concurrent callers share
// the same in-flight promise so we never inject two <script> tags.
const sdkPromises: Partial<Record<"production" | "sandbox", Promise<any>>> = {};
function loadSquareSdk(environment: "production" | "sandbox"): Promise<any> {
  const w = window as any;
  if (w.Square) return Promise.resolve(w.Square);
  if (sdkPromises[environment]) return sdkPromises[environment]!;
  sdkPromises[environment] = new Promise((resolve, reject) => {
    const id = `square-js-${environment}`;
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing) {
      if ((window as any).Square) { resolve((window as any).Square); return; }
      existing.addEventListener("load", () => resolve((window as any).Square));
      existing.addEventListener("error", () => reject(new Error("Square SDK failed to load")));
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.src = SDK_SRC[environment];
    script.onload = () => {
      const S = (window as any).Square;
      if (S) resolve(S);
      else reject(new Error("Square SDK loaded but window.Square is missing"));
    };
    script.onerror = () => reject(new Error("Square SDK failed to load"));
    document.head.appendChild(script);
  });
  return sdkPromises[environment]!;
}

export function SquareCardForm({
  applicationId,
  locationId,
  environment,
  onToken,
  submitLabel = "Save Card Securely",
  busyLabel = "Saving...",
  accent,
  disabled,
}: SquareCardFormProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<any>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const brand = accent || "var(--brand)";

  useEffect(() => {
    let cancelled = false;
    let cardInstance: any = null;
    // A re-init (config arrived late, or the parent swapped identities) starts
    // clean — otherwise an error from the previous attempt stays on screen above
    // a card field that mounted fine the second time.
    setErrorMsg("");
    setStatus("loading");
    (async () => {
      try {
        const Square = await loadSquareSdk(environment);
        if (cancelled) return;
        const payments = Square.payments(applicationId, locationId);
        const card = await payments.card();
        if (cancelled) { try { await card.destroy(); } catch { /* noop */ } return; }
        await card.attach(containerRef.current);
        if (cancelled) { try { await card.destroy(); } catch { /* noop */ } return; }
        cardInstance = card;
        cardRef.current = card;
        setStatus("ready");
      } catch (err: any) {
        if (cancelled) return;
        setErrorMsg(err?.message || "Could not load the card form.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      const c = cardInstance || cardRef.current;
      if (c) { try { c.destroy(); } catch { /* noop */ } }
      cardRef.current = null;
    };
    // Re-init only when the Square identity changes.
  }, [applicationId, locationId, environment]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cardRef.current || status === "tokenizing" || disabled) return;
    setErrorMsg("");
    setStatus("tokenizing");
    try {
      const result = await cardRef.current.tokenize();
      if (result.status !== "OK" || !result.token) {
        const detail = result.errors?.[0]?.message || "Please check the card details and try again.";
        setErrorMsg(detail);
        setStatus("ready");
        return;
      }
      await onToken(result.token);
      // Parent owns the success UI; leave the button busy so it can't double-fire.
    } catch (err: any) {
      setErrorMsg(err?.message || "Could not save the card. Please try again.");
      setStatus("ready");
    }
  }

  const busy = status === "tokenizing";
  const notReady = status === "loading" || status === "error" || disabled;

  return (
    <form onSubmit={handleSubmit} style={{ fontFamily: FF }}>
      {errorMsg && (
        <div style={{ background: "#FCEBEA", border: "1px solid #F1D0CB", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#B3261E" }}>
          {errorMsg}
        </div>
      )}

      {/* Square injects an iframe card field here. Give it a min-height so the
          card doesn't jump when the SDK finishes mounting. */}
      <div
        ref={containerRef}
        style={{
          minHeight: 44,
          marginBottom: 16,
          border: "1px solid #E5E2DC",
          borderRadius: 8,
          padding: status === "ready" ? "2px 8px" : "12px 14px",
          background: "#fff",
        }}
      >
        {status === "loading" && <span style={{ fontSize: 13, color: "#9E9B94" }}>Loading secure card field...</span>}
      </div>

      <button
        type="submit"
        disabled={busy || notReady}
        style={{
          width: "100%",
          background: notReady ? "#E5E2DC" : brand,
          color: notReady ? "#9E9B94" : "#fff",
          border: "none", borderRadius: 8, padding: "14px 0",
          fontWeight: 600, fontSize: 15,
          cursor: busy || notReady ? "not-allowed" : "pointer",
          fontFamily: FF, marginBottom: 14,
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? busyLabel : submitLabel}
      </button>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, color: "#9E9B94" }}>
        <ShieldCheck size={14} />
        <span>Secured by Square. Card details are never stored on our servers.</span>
      </div>
    </form>
  );
}
