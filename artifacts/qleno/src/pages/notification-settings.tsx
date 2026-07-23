import { useState, useEffect } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useToast } from "@/hooks/use-toast";
import { Bell, Smartphone } from "lucide-react";
import { pushSupported, isIOS, isStandalone, isSubscribedOnThisDevice, enablePush, disablePush } from "@/lib/web-push-client";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const BRAND = "var(--brand)";

const CATEGORIES = [
  { key: "messages", label: "Messages", desc: "New inbound text messages from customers" },
  { key: "new_jobs", label: "New jobs", desc: "A job is scheduled or assigned to you" },
  { key: "job_changes", label: "Job changes", desc: "A job's date, time, assignment, or status changes" },
] as const;

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button onClick={() => !disabled && onChange(!on)} disabled={disabled}
      style={{ width: 42, height: 24, borderRadius: 999, border: "none", cursor: disabled ? "default" : "pointer",
        background: on ? BRAND : "#D6D3CC", position: "relative", transition: "background 120ms", opacity: disabled ? 0.5 : 1, flexShrink: 0 }}>
      <span style={{ position: "absolute", top: 2, left: on ? 20 : 2, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 120ms" }} />
    </button>
  );
}

export default function NotificationSettingsPage() {
  const { toast } = useToast();
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [deviceOn, setDeviceOn] = useState(false);
  const [working, setWorking] = useState(false);

  const supported = pushSupported();
  const iosNeedsInstall = isIOS() && !isStandalone();

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/api/notifications/settings`, { headers: getAuthHeaders() });
        if (r.ok) setPrefs(await r.json());
      } catch { /* silent */ }
      setDeviceOn(await isSubscribedOnThisDevice());
    })();
  }, []);

  async function toggleDevice() {
    setWorking(true);
    try {
      if (deviceOn) { await disablePush(); setDeviceOn(false); toast({ title: "Push disabled on this device" }); }
      else {
        const r = await enablePush();
        if (r === "enabled") { setDeviceOn(true); toast({ title: "Push enabled on this device" }); }
        else if (r === "needs_install") toast({ title: "Add Qleno to your Home Screen first", description: "On iPhone, tap Share → Add to Home Screen, open Qleno from there, then enable push.", variant: "destructive" as any });
        else if (r === "denied") toast({ title: "Permission denied", description: "Allow notifications in your browser/OS settings, then try again.", variant: "destructive" as any });
        else if (r === "unsupported") toast({ title: "Not supported on this browser", variant: "destructive" as any });
        else toast({ title: "Couldn't enable push", variant: "destructive" as any });
      }
    } finally { setWorking(false); }
  }

  async function save(next: Record<string, boolean>) {
    setPrefs(next);
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/notifications/settings`, {
        method: "PUT", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (r.ok) setPrefs(await r.json());
      else toast({ title: "Couldn't save", variant: "destructive" as any });
    } catch { toast({ title: "Couldn't save", variant: "destructive" as any }); }
    finally { setSaving(false); }
  }

  const setKey = (k: string, v: boolean) => prefs && save({ ...prefs, [k]: v });

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, maxWidth: 640, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: INK, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
          <Bell size={20} /> Notification settings
        </h1>
        <p style={{ fontSize: 13, color: MUTE, margin: "0 0 20px" }}>Choose how you want to be alerted. These are your personal settings.</p>

        {/* Push on this device */}
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 12, background: "#fff", padding: "14px 16px", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Smartphone size={18} color={INK} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>Push on this device</div>
              <div style={{ fontSize: 12, color: MUTE, marginTop: 2 }}>
                {!supported ? "This browser doesn't support push notifications."
                  : deviceOn ? "This device will receive alerts even when Qleno is closed."
                  : "Get alerts on this device even when the app is closed."}
              </div>
            </div>
            {supported && (
              <button onClick={toggleDevice} disabled={working}
                style={{ padding: "9px 14px", borderRadius: 9, border: deviceOn ? `1px solid ${BORDER}` : "none",
                  background: deviceOn ? "#fff" : BRAND, color: deviceOn ? INK : "#04241d", fontSize: 13, fontWeight: 800,
                  cursor: working ? "default" : "pointer", opacity: working ? 0.6 : 1, fontFamily: FF, whiteSpace: "nowrap" }}>
                {working ? "…" : deviceOn ? "Turn off" : "Enable push"}
              </button>
            )}
          </div>
          {iosNeedsInstall && !deviceOn && (
            <div style={{ marginTop: 10, padding: "10px 12px", background: "#FFF7ED", border: "1px solid #FED7AA", borderRadius: 8, fontSize: 12, color: "#9A3412", lineHeight: 1.5 }}>
              <strong>iPhone/iPad:</strong> push works only when Qleno is added to your Home Screen (iOS 16.4+). Tap the <strong>Share</strong> icon → <strong>Add to Home Screen</strong>, open Qleno from the new icon, then come back here and tap Enable push.
            </div>
          )}
        </div>

        {!prefs ? (
          <p style={{ color: MUTE, fontSize: 14 }}>Loading…</p>
        ) : (
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 12, background: "#fff", overflow: "hidden" }}>
            <div style={{ display: "flex", padding: "10px 16px", borderBottom: `1px solid ${BORDER}`, fontSize: 12, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <span style={{ flex: 1 }}>Alert me about</span>
              <span style={{ width: 60, textAlign: "center" }}>In-app</span>
              <span style={{ width: 60, textAlign: "center" }}>Push</span>
              <span style={{ width: 60, textAlign: "center" }}>Email</span>
            </div>
            {CATEGORIES.map(c => (
              <div key={c.key} style={{ display: "flex", alignItems: "center", padding: "14px 16px", borderBottom: `1px solid ${BORDER}` }}>
                <div style={{ flex: 1, minWidth: 0, paddingRight: 12 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>{c.label}</div>
                  <div style={{ fontSize: 12, color: MUTE, marginTop: 2 }}>{c.desc}</div>
                </div>
                <div style={{ width: 60, display: "flex", justifyContent: "center" }}>
                  <Toggle on={!!prefs[`${c.key}_inapp`]} onChange={v => setKey(`${c.key}_inapp`, v)} disabled={saving} />
                </div>
                <div style={{ width: 60, display: "flex", justifyContent: "center" }}>
                  <Toggle on={!!prefs[`${c.key}_push`]} onChange={v => setKey(`${c.key}_push`, v)} disabled={saving} />
                </div>
                <div style={{ width: 60, display: "flex", justifyContent: "center" }}>
                  <Toggle on={!!prefs[`${c.key}_email`]} onChange={v => setKey(`${c.key}_email`, v)} disabled={saving} />
                </div>
              </div>
            ))}
          </div>
        )}
        <p style={{ fontSize: 12, color: MUTE, marginTop: 14 }}>
          Email alerts go to your own staff email and are internal — customers never receive them.
        </p>
      </div>
    </DashboardLayout>
  );
}
