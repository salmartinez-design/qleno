// Native shell bridge (Capacitor)
// -------------------------------------------------------------------------
// When Qleno runs inside the Capacitor native shell, the web view's origin is
// `capacitor://localhost` (iOS) or `http://localhost` (Android) — NOT the
// Railway API server. Every call site in the app uses bare relative URLs
// (`fetch('/api/...')`), which on the web resolve against the same origin that
// served the SPA. In the native shell those would resolve against the shell
// itself and 404.
//
// Rather than rewrite hundreds of call sites, we patch `window.fetch` once, at
// the earliest possible moment, to prefix app-relative requests with the
// configured API origin. Auth already travels as a Bearer token in the
// `Authorization` header (see getAuthHeaders), so it survives the cross-origin
// hop without relying on cookies.
//
// This is a NO-OP on the web build: when `window.Capacitor` is absent the
// original fetch is left untouched, so nothing about the browser experience
// changes.

const DEFAULT_NATIVE_API_ORIGIN =
  "https://workspaceapi-server-production-b9d4.up.railway.app";

const NATIVE_API_ORIGIN = (
  (import.meta.env.VITE_NATIVE_API_ORIGIN as string | undefined) ||
  DEFAULT_NATIVE_API_ORIGIN
).replace(/\/+$/, "");

function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; isNative?: boolean } }).Capacitor;
  if (!cap) return false;
  if (typeof cap.isNativePlatform === "function") return cap.isNativePlatform();
  return !!cap.isNative;
}

/**
 * Install the relative-URL → API-origin fetch shim. Safe to call multiple
 * times; only patches once and only inside the native shell.
 */
export function installNativeApiBridge(): void {
  if (!isNativeShell()) return;

  const w = window as unknown as { __qlenoNativeFetchPatched?: boolean };
  if (w.__qlenoNativeFetchPatched) return;
  w.__qlenoNativeFetchPatched = true;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      let url: string | null = null;
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.toString();
      else if (typeof Request !== "undefined" && input instanceof Request) url = input.url;

      // Only rewrite app-relative paths ("/api/...", "/uploads/..."). Absolute
      // URLs (http/https/data/blob) and the capacitor scheme pass through.
      if (url && url.startsWith("/") && !url.startsWith("//")) {
        const rewritten = NATIVE_API_ORIGIN + url;
        if (typeof input === "string" || input instanceof URL) {
          return nativeFetch(rewritten, init);
        }
        // Request object: rebuild against the new URL, preserving the original
        // method/headers/body via the Request copy constructor.
        return nativeFetch(new Request(rewritten, input as Request), init);
      }
    } catch {
      // Fall through to the unmodified fetch on any parsing error.
    }
    return nativeFetch(input as RequestInfo, init);
  };
}

export const nativeApiOrigin = NATIVE_API_ORIGIN;
