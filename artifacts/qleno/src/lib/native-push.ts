// Native push notifications (Capacitor)
// -------------------------------------------------------------------------
// Registers the device with APNs (iOS) / FCM (Android) and hands the resulting
// device token to the Qleno API so the server can target this device for
// new-job, schedule-change, and PTO-approved pushes.
//
// The `@capacitor/push-notifications` plugin is loaded via dynamic import and
// only inside the native shell, so the web bundle never pulls it in and the
// browser build is unaffected.
//
// SERVER SIDE (Phase 2, not yet built): POST /api/devices/register must persist
// { token, platform } against the authenticated user, and a sender must push
// via APNs/FCM. Until that endpoint exists the POST below fails silently — the
// client registration still works, so wiring the server later needs no app
// change.

import { getAuthHeaders } from "./auth";

function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
  return !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
}

function platform(): string {
  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return cap?.getPlatform?.() ?? "unknown";
}

async function sendTokenToServer(token: string): Promise<void> {
  try {
    await fetch("/api/devices/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ token, platform: platform() }),
    });
  } catch {
    // Endpoint not live yet (Phase 2) — ignore. The native registration above
    // still succeeded; the token will re-register on the next app launch.
  }
}

/**
 * Initialise push notifications. Safe to call on web (no-op) and idempotent.
 * Call once, after the app has mounted.
 */
export async function initNativePush(): Promise<void> {
  if (!isNativeShell()) return;

  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");

    const perm = await PushNotifications.checkPermissions();
    let granted = perm.receive === "granted";
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
      const req = await PushNotifications.requestPermissions();
      granted = req.receive === "granted";
    }
    if (!granted) return;

    PushNotifications.addListener("registration", (tok) => {
      void sendTokenToServer(tok.value);
    });
    PushNotifications.addListener("registrationError", (err) => {
      // eslint-disable-next-line no-console
      console.warn("[push] registration error", err);
    });

    await PushNotifications.register();
  } catch (err) {
    // Plugin missing or platform unsupported — non-fatal.
    // eslint-disable-next-line no-console
    console.warn("[push] init skipped", err);
  }
}
