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
import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck, RefreshCw } from "lucide-react";

const FF = "'Plus Jakarta Sans', sans-serif";

// Square serves the SDK from two hosts — production vs sandbox must match the
// environment the applicationId belongs to, or tokenize() rejects.
const SDK_SRC: Record<"production" | "sandbox", string> = {
  production: "https://web.squarecdn.com/v1/square.js",
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
};

export type SquareEnv = "production" | "sandbox";
type Status = "loading" | "ready" | "tokenizing" | "error";

export interface SquareCardFormProps {
  applicationId: string;
  locationId: string;
  environment: SquareEnv;
  /** Called with the one-time `cnon:` nonce once the card tokenizes cleanly.
      Return a promise; the button stays in its busy state until it resolves. */
  onToken: (sourceId: string) => Promise<void>;
  submitLabel?: string;
  busyLabel?: string;
  /** Accent for the submit button (defaults to the app brand token). */
  accent?: string;
  disabled?: boolean;
  /** Shown under the retry button when the SDK itself can't load, so whoever is
      staring at the failure is told what to do INSTEAD of entering a card here.
      Surface-specific: the office pages point at the text/email card link, the
      public /pay page can only tell the customer to reload. */
  fallbackHint?: React.ReactNode;
}

// [square-sdk-retry 2026-08-18] Loading the SDK used to be one shot with a
// permanently cached promise. A single blip — a dropped packet on the office
// wifi, a CDN hiccup, a tab that was backgrounded mid-request — rejected that
// promise, and because the REJECTION was cached under `sdkPromises[env]`, every
// later attempt got the same dead promise back. Reopening the modal, moving to
// another client, opening a different quote: all of them replayed "Square SDK
// failed to load" with a disabled button. Only a full page reload cleared it,
// and nothing on screen said so. That is what Maribel hit on the quote builder.
//
// So: a failed load is now transient. We retry with backoff, we time out
// instead of hanging forever, and on final failure we drop BOTH the cached
// promise and the dead <script> so the next call starts genuinely clean.
const SDK_LOAD_TIMEOUT_MS = 15_000;
const SDK_LOAD_ATTEMPTS = 3;
const SDK_RETRY_DELAY_MS = [600, 1800];

// Which environment's script is actually on the page. `window.Square` is a
// single global, so a sandbox script already loaded would otherwise satisfy a
// request for production (and tokenize against the wrong merchant account).
const LOADED_ENV_KEY = "__qlenoSquareSdkEnv";

const sdkPromises: Partial<Record<SquareEnv, Promise<any>>> = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One injection attempt. Resolves with window.Square, or rejects. */
function injectSquareScript(environment: SquareEnv): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = window as any;
    const id = `square-js-${environment}`;

    // Drop any leftover tag from a previous failed attempt. Re-using it means
    // attaching load/error listeners to an element that already fired both —
    // they never fire again and the promise hangs forever.
    document.getElementById(id)?.remove();

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("Square SDK timed out while loading")));
    }, SDK_LOAD_TIMEOUT_MS);

    const script = document.createElement("script");
    script.id = id;
    script.src = SDK_SRC[environment];
    script.async = true;
    script.onload = () => {
      finish(() => {
        const S = w.Square;
        if (S) {
          w[LOADED_ENV_KEY] = environment;
          resolve(S);
        } else {
          reject(new Error("Square SDK loaded but window.Square is missing"));
        }
      });
    };
    script.onerror = () => {
      finish(() => reject(new Error("Square SDK failed to load")));
    };
    document.head.appendChild(script);
  });
}

// Exported so the public booking widget (pages/book.tsx) mounts its card field
// through the SAME hardened loader instead of hand-rolling a second one. The
// widget is the revenue funnel — a one-shot load with a cached rejection there
// costs bookings, not just an office retry.
export function loadSquareSdk(environment: SquareEnv): Promise<any> {
  const w = window as any;
  // Only trust an already-loaded global if it came from THIS environment's host.
  if (w.Square && w[LOADED_ENV_KEY] === environment) return Promise.resolve(w.Square);
  if (sdkPromises[environment]) return sdkPromises[environment]!;

  const attempt = (async () => {
    let lastErr: any;
    for (let i = 0; i < SDK_LOAD_ATTEMPTS; i++) {
      try {
        return await injectSquareScript(environment);
      } catch (err) {
        lastErr = err;
        // Log the real URL + reason: the on-screen copy is deliberately plain,
        // and without this there is nothing to diagnose a blocked host with.
        console.warn(
          `[square] SDK load attempt ${i + 1}/${SDK_LOAD_ATTEMPTS} failed for ${SDK_SRC[environment]}`,
          err,
        );
        if (i < SDK_LOAD_ATTEMPTS - 1) await sleep(SDK_RETRY_DELAY_MS[i] ?? 1800);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Square SDK failed to load");
  })();

  sdkPromises[environment] = attempt;
  // Never leave a rejected promise in the cache — the next open must retry.
  attempt.catch(() => {
    if (sdkPromises[environment] === attempt) delete sdkPromises[environment];
    document.getElementById(`square-js-${environment}`)?.remove();
  });
  return attempt;
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
  fallbackHint,
}: SquareCardFormProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<any>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  // Separates "the secure field never loaded" (retryable, and the office should
  // fall back to a card link) from "this card was declined / mistyped" (the
  // field is fine, fix the digits). They used to render identically, which is
  // why a dead SDK looked like a dead end.
  const [sdkFailed, setSdkFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const brand = accent || "var(--brand)";

  useEffect(() => {
    let cancelled = false;
    let cardInstance: any = null;
    // A re-init (config arrived late, the parent swapped identities, or the
    // operator hit Try again) starts clean — otherwise an error from the
    // previous attempt stays on screen above a card field that mounted fine.
    setErrorMsg("");
    setSdkFailed(false);
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
        console.warn("[square] card field could not be mounted", err);
        setSdkFailed(true);
        setErrorMsg("The secure card field couldn't load. Check the connection and try again.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      const c = cardInstance || cardRef.current;
      if (c) { try { c.destroy(); } catch { /* noop */ } }
      cardRef.current = null;
    };
    // Re-init when the Square identity changes, or on an explicit retry.
  }, [applicationId, locationId, environment, reloadKey]);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

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

      {/* Square injects an iframe card field here. The container stays mounted
          even while the SDK is down — unmounting it would null the ref that a
          retry attaches into. Give it a min-height so the card doesn't jump
          when the SDK finishes mounting. */}
      <div
        ref={containerRef}
        style={{
          display: sdkFailed ? "none" : "block",
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

      {/* When the SDK is down there is no field to fill in — an empty bordered
          box above a greyed-out button reads as a broken screen with nothing to
          do. Offer the retry, and say what to do instead. */}
      {sdkFailed ? (
        <>
          <button
            type="button"
            onClick={retry}
            style={{
              width: "100%", background: brand, color: "#fff",
              border: "none", borderRadius: 8, padding: "14px 0",
              fontWeight: 600, fontSize: 15, cursor: "pointer",
              fontFamily: FF, marginBottom: 14,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}
          >
            <RefreshCw size={15} /> Try again
          </button>
          {fallbackHint && (
            <div style={{ fontSize: 12.5, color: "#6B6860", lineHeight: 1.5, marginBottom: 14 }}>
              {fallbackHint}
            </div>
          )}
        </>
      ) : (
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
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, color: "#9E9B94" }}>
        <ShieldCheck size={14} />
        <span>Secured by Square. Card details are never stored on our servers.</span>
      </div>
    </form>
  );
}
