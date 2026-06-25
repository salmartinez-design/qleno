import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
}

export function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS reports as Mac; detect by touch.
    (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);
}

// Installed to Home Screen (standalone display) — required for iOS web push.
export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as any).standalone === true;
}

export function permissionState(): NotificationPermission | "unsupported" {
  if (!pushSupported()) return "unsupported";
  return Notification.permission;
}

function urlB64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export async function isSubscribedOnThisDevice(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return !!(await reg.pushManager.getSubscription());
  } catch { return false; }
}

// Request permission + subscribe this device, persisting to the server.
// Returns a status the UI can act on.
export async function enablePush(): Promise<"enabled" | "denied" | "unsupported" | "needs_install" | "error"> {
  if (!pushSupported()) return "unsupported";
  // iOS only delivers web push to an installed (Home Screen) PWA.
  if (isIOS() && !isStandalone()) return "needs_install";
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return "denied";
    const reg = await navigator.serviceWorker.ready;
    const keyRes = await fetch(`${API}/api/push/vapid-public-key`, { headers: getAuthHeaders() });
    const { key } = await keyRes.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(key),
    });
    const r = await fetch(`${API}/api/push/subscribe`, {
      method: "POST", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    return r.ok ? "enabled" : "error";
  } catch (e) {
    console.warn("[push] enable failed", e);
    return "error";
  }
}

// Re-bind THIS device's existing push subscription to the CURRENT logged-in
// user. The "on this device" toggle is derived from the browser HAVING a
// PushSubscription, not from the server owning a row for the current user — so
// on a reused/shared device (or after re-login) the subscription can stay
// mapped to a previous user and that user's pushes go nowhere. This silently
// re-POSTs the existing subscription so the server's ON CONFLICT (endpoint)
// repoints it to whoever is logged in now. No permission prompt, no new
// subscribe — only re-registers a sub that already exists. Safe on every load.
export async function resyncPushSubscription(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch(`${API}/api/push/subscribe`, {
      method: "POST", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
  } catch (e) { console.warn("[push] resync failed", e); }
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch(`${API}/api/push/unsubscribe`, {
        method: "POST", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
  } catch (e) { console.warn("[push] disable failed", e); }
}
