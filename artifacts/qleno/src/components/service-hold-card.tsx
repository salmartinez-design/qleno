// [suspension-commercial 2026-08-19] Suspend / resume card, shared by the
// residential customer profile and the commercial account detail page.
//
// Lifted verbatim out of customer-profile.tsx's ServiceStatusCard so the two
// surfaces cannot drift: Sal's ask was "we need this for both commercial and
// residential", and a second hand-built copy is how one side quietly ends up
// with a different cap, a different default, or a missing notify checkbox. The
// only difference between the two callers is which endpoint they hit and the
// name shown in the modal.
import { useState } from "react";
import { Clock } from "lucide-react";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

// Kept in step with MAX_SUSPEND_DAYS in the API's lib/suspension.ts. The server
// is the enforcer; this only shapes the picker.
const MAX_SUSPEND_DAYS = 90;

function fmtDate(d?: string | null) {
  if (!d) return "Never";
  const s = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + "T12:00:00" : d;
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export interface ServiceHoldSubject {
  id: number;
  suspended_at?: string | null;
  suspend_until?: string | null;
  suspend_reason?: string | null;
}

export function ServiceHoldCard({
  kind,
  subject,
  displayName,
  onChanged,
}: {
  /** Which carrier this hold sits on — decides the endpoint and the copy. */
  kind: "client" | "account";
  subject: ServiceHoldSubject;
  /** Name shown in the modal ("Places <name> on hold …"). */
  displayName: string;
  /** Called after a successful suspend or resume so the page can refetch. */
  onChanged: () => void;
}) {
  const base = kind === "client" ? "/api/clients" : "/api/accounts";
  const role = getTokenRole();
  const canManage = role === "owner" || role === "admin" || role === "office";
  const isSuspended = !!subject.suspended_at;

  const today = new Date().toISOString().slice(0, 10);
  const maxDate = (() => { const d = new Date(); d.setDate(d.getDate() + MAX_SUSPEND_DAYS); return d.toISOString().slice(0, 10); })();
  const expired = isSuspended && !!subject.suspend_until && String(subject.suspend_until).slice(0, 10) <= today;

  const [modalOpen, setModalOpen] = useState(false);
  const [until, setUntil] = useState(maxDate);
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "suspend" | "resume">(null);

  async function post(path: string, body: any) {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" } as Record<string, string>,
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    if (!r.ok) {
      let msg = txt;
      try { msg = JSON.parse(txt).error || msg; } catch { /* raw text is the message */ }
      throw new Error(String(msg).slice(0, 200));
    }
  }

  async function doSuspend() {
    setBusy("suspend"); setErr(null);
    try {
      await post(`${base}/${subject.id}/suspend`, { until, reason: reason.trim() || undefined, notify });
      setModalOpen(false); setReason("");
      onChanged();
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(null); }
  }

  async function doResume() {
    setBusy("resume"); setErr(null);
    try {
      await post(`${base}/${subject.id}/resume`, {});
      onChanged();
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(null); }
  }

  const daysLeft = isSuspended && subject.suspend_until
    ? Math.ceil((new Date(String(subject.suspend_until).slice(0, 10) + "T12:00:00").getTime() - Date.now()) / 86400000)
    : null;

  const holdSubject = kind === "account" ? "Visits" : "Cleanings";

  return (
    <div style={{ background: "#FFFFFF", border: `1px solid ${expired ? "#FCA5A5" : isSuspended ? "#F2DFB8" : "#E5E2DC"}`, borderRadius: 10, padding: "18px 20px", fontFamily: FF }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: expired ? "#FCEBEA" : isSuspended ? "#FDF3E4" : "#E6F6F1", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Clock size={18} style={{ color: expired ? "#B3261E" : isSuspended ? "#B45309" : "#0F7A63" }} />
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1917" }}>
            {expired ? "Service hold expired" : isSuspended ? "Service suspended" : "Service active"}
          </div>
          <div style={{ fontSize: 12, color: "#6B6860", marginTop: 2 }}>
            {expired
              ? `Hold ended ${fmtDate(subject.suspend_until)} — awaiting follow-up to resume or close out.`
              : isSuspended
                ? `On hold until ${fmtDate(subject.suspend_until)}${daysLeft != null && daysLeft >= 0 ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : ""}${subject.suspend_reason ? ` · ${subject.suspend_reason}` : ""}`
                : `${holdSubject} are scheduling normally.`}
          </div>
        </div>
        {canManage && (
          isSuspended ? (
            <button onClick={doResume} disabled={busy === "resume"}
              style={{ padding: "8px 14px", border: "none", borderRadius: 8, background: "var(--brand)", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: busy === "resume" ? "default" : "pointer", opacity: busy === "resume" ? 0.6 : 1, fontFamily: FF }}>
              {busy === "resume" ? "Resuming…" : "Resume service"}
            </button>
          ) : (
            <button onClick={() => { setErr(null); setUntil(maxDate); setModalOpen(true); }}
              style={{ padding: "8px 14px", border: "1px solid #F2DFB8", borderRadius: 8, background: "#FDF3E4", color: "#B45309", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
              Suspend service
            </button>
          )
        )}
      </div>
      {isSuspended && err && <div style={{ fontSize: 12, color: "#B3261E", marginTop: 10 }}>{err}</div>}

      {modalOpen && (
        <div onClick={() => busy !== "suspend" && setModalOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.45)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: "#FFFFFF", borderRadius: 14, padding: 24, width: 440, maxWidth: "100%", fontFamily: FF, boxShadow: "0 20px 50px rgba(10,14,26,0.3)" }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#0A0E1A", marginBottom: 6 }}>Suspend service</div>
            <div style={{ fontSize: 13, color: "#6B6860", marginBottom: 18, lineHeight: 1.5 }}>
              Places {displayName} on hold for up to {MAX_SUSPEND_DAYS} days.{" "}
              {kind === "account"
                ? "Upcoming visits at every property on this account are cancelled and its recurring schedules pause."
                : "Upcoming jobs are cancelled and recurring schedules pause."}{" "}
              Resume any time before the end date.
            </div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Resume / end date (max {MAX_SUSPEND_DAYS} days)</label>
            <input type="date" value={until} min={today} max={maxDate} onChange={e => setUntil(e.target.value)}
              style={{ width: "100%", padding: "9px 11px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, color: "#1A1917", outline: "none", boxSizing: "border-box", marginBottom: 14, fontFamily: FF }} />
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Reason (optional)</label>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} maxLength={500}
              placeholder={kind === "account" ? "e.g. Building closed for renovation" : "e.g. Traveling for the summer"}
              style={{ width: "100%", padding: "9px 11px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, color: "#1A1917", outline: "none", boxSizing: "border-box", resize: "vertical", marginBottom: 14, fontFamily: FF }} />
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1A1917", marginBottom: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />
              {kind === "account" ? "Email the billing contact a suspension confirmation" : "Email the customer a suspension confirmation"}
            </label>
            {err && <div style={{ fontSize: 12, color: "#B3261E", marginBottom: 8 }}>{err}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setModalOpen(false)} disabled={busy === "suspend"}
                style={{ padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: 8, background: "#FFFFFF", color: "#6B6860", fontSize: 13, cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={doSuspend} disabled={busy === "suspend" || !until}
                style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: "#B45309", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: busy === "suspend" ? "default" : "pointer", opacity: busy === "suspend" || !until ? 0.6 : 1, fontFamily: FF }}>
                {busy === "suspend" ? "Suspending…" : "Suspend service"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
