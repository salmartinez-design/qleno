/**
 * One-time "Turn on job alerts?" push nudge for the tech field app (Sal
 * 2026-06-25). Adoption was near-zero because enabling push meant digging into
 * Notification settings; this surfaces a one-tap CTA on the My Jobs screen.
 *
 * Shows ONLY when: push is supported, the device is NOT already subscribed,
 * permission isn't 'denied', and the tech hasn't dismissed it (per-user
 * localStorage flag). One tap calls the existing enablePush() flow. iOS-aware:
 * if the app isn't installed to the Home Screen, enablePush() returns
 * "needs_install" and we show the Add-to-Home-Screen instruction inline.
 */
import { useState, useEffect } from "react";
import { Bell, X } from "lucide-react";
import { getTokenUserId } from "@/lib/auth";
import { pushSupported, isIOS, isStandalone, permissionState, isSubscribedOnThisDevice, enablePush } from "@/lib/web-push-client";

const FF = "'Plus Jakarta Sans', sans-serif";
const dismissKey = () => `qleno_push_nudge_dismissed_${getTokenUserId() ?? "anon"}`;

export function PushNudge() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsInstall, setNeedsInstall] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!pushSupported()) return;
      if (permissionState() === "denied") return;        // can't re-prompt; don't nag
      try { if (localStorage.getItem(dismissKey()) === "1") return; } catch { /* private mode → just show */ }
      // Re-surface only when there's no active subscription on this device.
      if (await isSubscribedOnThisDevice()) return;
      setNeedsInstall(isIOS() && !isStandalone());
      setShow(true);
    })();
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(dismissKey(), "1"); } catch { /* private mode */ }
    setShow(false);
  };

  const turnOn = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await enablePush();
      if (r === "enabled") { setShow(false); }                       // subscribed → done, hide for good
      else if (r === "needs_install") { setNeedsInstall(true); setMsg("On iPhone: tap Share → Add to Home Screen, open Qleno from there, then turn on alerts."); }
      else if (r === "denied") { setMsg("Notifications are blocked. Allow them in your phone's Settings, then try again."); }
      else if (r === "unsupported") { setMsg("This browser can't show push notifications."); }
      else { setMsg("Couldn't turn on alerts — try again."); }
    } finally {
      setBusy(false);
    }
  };

  if (!show) return null;

  return (
    <div style={{
      margin: "10px 16px 0", padding: "12px 14px", borderRadius: 12,
      background: "var(--brand-dim)", border: "1px solid rgba(var(--brand-rgb),0.30)",
      display: "flex", alignItems: "flex-start", gap: 10, fontFamily: FF,
    }}>
      <span style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 8, background: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Bell size={16} color="#04241d" />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>Turn on job alerts?</div>
        <div style={{ fontSize: 12, color: "#3E5C53", marginTop: 2, lineHeight: 1.4 }}>
          {needsInstall
            ? "Add Qleno to your Home Screen first, then get a notification the moment a job is assigned — even when the app is closed."
            : "Get a notification the moment a job is assigned to you — even when the app is closed."}
        </div>
        {msg && <div style={{ fontSize: 11.5, color: "#92400E", marginTop: 6, lineHeight: 1.4 }}>{msg}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {!needsInstall && (
            <button onClick={turnOn} disabled={busy}
              style={{ fontFamily: FF, fontSize: 13, fontWeight: 700, color: "#FFFFFF", background: "var(--brand)", border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer", opacity: busy ? 0.5 : 1 }}>
              {busy ? "Turning on…" : "Turn on alerts"}
            </button>
          )}
          <button onClick={dismiss}
            style={{ fontFamily: FF, fontSize: 13, fontWeight: 600, color: "#6B6860", background: "none", border: "none", cursor: "pointer", padding: "8px 4px" }}>
            {needsInstall ? "Got it" : "Not now"}
          </button>
        </div>
      </div>
      <button onClick={dismiss} aria-label="Dismiss" style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 2 }}>
        <X size={16} />
      </button>
    </div>
  );
}
