/**
 * Shared notification bell + inbox dropdown (Sal 2026-06-25).
 *
 * Extracted from dashboard-layout.tsx so the office shell AND the tech field
 * app (my-jobs) render the SAME bell and can't drift. Self-contained: own
 * state, its own /api/notifications/inbox query (same query key as the office
 * mobile-bell badge → shared React Query cache, no extra network), mark-read,
 * and the popover. The inbox endpoint is per-user (inboxScope = self for a
 * technician), so a tech sees exactly their own job-assigned / job-changed /
 * leave alerts. Read + mark-read only — no writes beyond marking read.
 */
import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuthStore, getAuthHeaders } from "@/lib/auth";
import { resyncPushSubscription } from "@/lib/web-push-client";
import { Bell, MessageSquare, Briefcase, CalendarDays, AlertTriangle } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

export function NotificationBell() {
  const token = useAuthStore((s) => s.token);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // [push-rebind 2026-06-25] On every authenticated load, re-bind this device's
  // existing push subscription to the CURRENT user. Without this, a device that
  // was subscribed under a previous login (e.g. the owner test-installed the PWA,
  // then a tech logged into the same install) keeps the subscription mapped to
  // the old user — so the current user's lock-screen pushes go nowhere. Idempotent
  // (re-POST → ON CONFLICT repoints user_id); never prompts or creates a new sub.
  useEffect(() => {
    if (token) void resyncPushSubscription();
  }, [token]);

  const { data } = useQuery({
    // Same key as the office shell's mobile-bell badge → one shared cache entry.
    queryKey: ["notifications-inbox", token],
    queryFn: async () => {
      const r = await fetch(`${API}/api/notifications/inbox?limit=20`, { headers: getAuthHeaders() as any });
      if (!r.ok) return { data: [], unread_count: 0 };
      return r.json();
    },
    enabled: !!token,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const items: any[] = data?.data || [];
  const unread: number = data?.unread_count || 0;

  const markRead = async (id: string, link?: string) => {
    try {
      await fetch(`${API}/api/notifications/inbox/${id}/read`, { method: "PATCH", headers: getAuthHeaders() as any });
      queryClient.invalidateQueries({ queryKey: ["notifications-inbox"] });
    } catch (_) { /* leave unread on failure */ }
    if (link) setLocation(link);
    setOpen(false);
  };
  // Legacy "new_booking" notifications stored link="/customers" (generic, went
  // nowhere useful). Deep-link to the job on the dispatch board instead. The
  // board is date-scoped and only opens a job that's on the loaded date, so we
  // fetch the job's scheduled date to build /dispatch?date=..&job=.. New
  // notifications already carry a /dispatch link and skip the fetch.
  const resolveTarget = async (n: any): Promise<string | undefined> => {
    const meta = typeof n.meta === "string"
      ? (() => { try { return JSON.parse(n.meta); } catch { return null; } })()
      : n.meta;
    if (n.type === "new_booking" && meta?.job_id && (!n.link || !String(n.link).startsWith("/dispatch"))) {
      try {
        const jr = await fetch(`${API}/api/jobs/${meta.job_id}`, { headers: getAuthHeaders() as any })
          .then((r) => (r.ok ? r.json() : null));
        const d = String(jr?.job?.scheduled_date ?? jr?.scheduled_date ?? "").slice(0, 10);
        return `/dispatch?${d ? `date=${d}&` : ""}job=${meta.job_id}`;
      } catch { /* fall back to the stored link */ }
    }
    return n.link || undefined;
  };
  const markAllRead = async () => {
    try {
      await fetch(`${API}/api/notifications/inbox/read-all`, { method: "PATCH", headers: getAuthHeaders() as any });
      queryClient.invalidateQueries({ queryKey: ["notifications-inbox"] });
    } catch (_) { /* no-op */ }
  };

  const iconFor = (type: string) =>
    type === "new_message" ? <MessageSquare size={14} style={{ color: "var(--brand)" }} />
    : type === "job_assigned" ? <Briefcase size={14} style={{ color: "#2563EB" }} />
    : type === "job_changed" ? <CalendarDays size={14} style={{ color: "#F59E0B" }} />
    : type === "new_booking" ? <Bell size={14} style={{ color: "#2563EB" }} />
    : type === "late_clockin" ? <AlertTriangle size={14} style={{ color: "#F59E0B" }} />
    : <Bell size={14} style={{ color: "#6B7280" }} />;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((p) => !p)}
        title="Notifications"
        style={{ background: open ? "var(--brand-dim)" : "none", border: "none", cursor: "pointer", color: open ? "var(--brand)" : "#6B7280", padding: 6, borderRadius: 8, display: "flex", alignItems: "center", position: "relative" } as any}
      >
        <Bell size={20} />
        {unread > 0 && (
          <span style={{ position: "absolute", top: 2, right: 2, minWidth: 9, height: 9, borderRadius: 5, background: "#EF4444", border: "2px solid #fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#fff", fontWeight: 700, padding: "0 2px" }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "100%", right: 0, marginTop: 6,
          background: "#fff", borderRadius: 12, border: "1px solid #E5E2DC",
          boxShadow: "0 8px 32px rgba(0,0,0,0.12)", width: 380, maxWidth: "92vw", zIndex: 200,
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 10px", borderBottom: "1px solid #F0EDEA" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>
              Notifications {unread > 0 && <span style={{ fontSize: 11, color: "#EF4444", marginLeft: 4 }}>({unread} unread)</span>}
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {unread > 0 && (
                <button onClick={markAllRead} style={{ fontSize: 11, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: FF, fontWeight: 600 }}>
                  Mark all read
                </button>
              )}
              <button onClick={() => { setOpen(false); setLocation("/notifications"); }} style={{ fontSize: 11, color: "#9E9B94", background: "none", border: "none", cursor: "pointer", fontFamily: FF }}>
                View all
              </button>
            </div>
          </div>
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {items.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center", color: "#9E9B94", fontSize: 13, fontFamily: FF }}>
                No notifications yet
              </div>
            ) : items.map((n: any) => (
              <button
                key={n.id}
                onClick={async () => markRead(n.id, await resolveTarget(n))}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 10, padding: "11px 16px",
                  background: n.read ? "#fff" : "#F0F4FF",
                  border: "none", borderBottom: "1px solid #F7F6F3", cursor: "pointer", width: "100%", textAlign: "left",
                }}
              >
                <span style={{ marginTop: 2, flexShrink: 0, width: 28, height: 28, borderRadius: 7, background: n.read ? "#F3F4F6" : "var(--brand-dim)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {iconFor(n.type)}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 12, fontWeight: n.read ? 500 : 700, color: "#1A1917", fontFamily: FF, lineHeight: 1.3 }}>{n.title}</span>
                  {n.body && <span style={{ display: "block", fontSize: 11, color: "#6B7280", marginTop: 2, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.body}</span>}
                  <span style={{ display: "block", fontSize: 10, color: "#C0BDB8", marginTop: 3 }}>
                    {new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </span>
                {!n.read && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#2563EB", flexShrink: 0, marginTop: 4 }} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
