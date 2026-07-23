import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Bell, AlertTriangle, UserMinus, CheckCheck, MessageSquare, CalendarCheck, CalendarDays, Clock, AtSign, UserCheck, MapPin, Briefcase } from "lucide-react";
import { styleOf, familyOf, FAMILY_STYLE, FAMILY_ORDER, type NotifFamily } from "@/lib/notification-style";
import { getAuthHeaders } from "@/lib/auth";
import { useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// [notif-colors 2026-07-23] This page previously knew only three types, so
// EVERYTHING else — including all 74 customer texts — fell through to a red
// "unassigned" icon and read as a problem. Icon + colour now come from the same
// map the bell uses (lib/notification-style), so the two surfaces can't drift
// and an unmapped type degrades to a neutral office bell, never a red alarm.
function notifIcon(type: string) {
  const P = { size: 15, style: { color: styleOf(type).color } } as const;
  switch (type) {
    case "new_message":          return <MessageSquare {...P} />;
    case "scheduled_sms_review": return <Clock {...P} />;
    case "new_booking":          return <CalendarCheck {...P} />;
    case "late_clockin":         return <Clock {...P} />;
    case "geofence_violation":   return <MapPin {...P} />;
    case "leave_request":
    case "leave_reset_applied":
    case "leave_reset_upcoming": return <CalendarDays {...P} />;
    case "job_unassigned":       return <UserMinus {...P} />;
    case "job_changed":          return <CalendarDays {...P} />;
    case "job_assigned":         return <Briefcase {...P} />;
    case "note_mention":         return <AtSign {...P} />;
    case "one_on_one_scheduled":
    case "leave_decision":       return <UserCheck {...P} />;
    default:                     return <Bell {...P} />;
  }
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function NotificationsPage() {
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [famFilter, setFamFilter] = useState<NotifFamily | "all">("all");
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  const { data, isLoading } = useQuery({
    queryKey: ["notifications-inbox-page", filter],
    queryFn: async () => {
      const url = `${API}/api/notifications/inbox?limit=50${filter === "unread" ? "&unread=true" : ""}`;
      const r = await fetch(url, { headers: getAuthHeaders() as any });
      if (!r.ok) return { data: [], unread_count: 0 };
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const allItems: any[] = data?.data || [];
  const unreadCount: number = data?.unread_count || 0;

  // [notif-colors 2026-07-23] Filter by family — the "office / attendance /
  // personal / booking tickets" split Sal asked for. Counts come from the
  // loaded page so a family with nothing in it can be hidden rather than
  // offering a chip that leads to an empty list.
  const famCounts = allItems.reduce((acc: Record<string, number>, n: any) => {
    const f = familyOf(n.type); acc[f] = (acc[f] || 0) + 1; return acc;
  }, {});
  const items = famFilter === "all" ? allItems : allItems.filter((n: any) => familyOf(n.type) === famFilter);

  const markRead = async (id: string, link?: string) => {
    try {
      await fetch(`${API}/api/notifications/inbox/${id}/read`, { method: "PATCH", headers: getAuthHeaders() as any });
      queryClient.invalidateQueries({ queryKey: ["notifications-inbox-page"] });
      queryClient.invalidateQueries({ queryKey: ["notifications-inbox"] });
    } catch (_) {}
    if (link) setLocation(link);
  };

  const markAllRead = async () => {
    try {
      await fetch(`${API}/api/notifications/inbox/read-all`, { method: "PATCH", headers: getAuthHeaders() as any });
      queryClient.invalidateQueries({ queryKey: ["notifications-inbox-page"] });
      queryClient.invalidateQueries({ queryKey: ["notifications-inbox"] });
    } catch (_) {}
  };

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        {/* [notif-colors 2026-07-23] Family chips — the office / attendance /
            personal / booking split, each carrying its own colour so the filter
            row doubles as the legend for the list below it. Only families that
            actually have something are offered. */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {(["all", ...FAMILY_ORDER] as const).map(f => {
            const on = famFilter === f;
            const st = f === "all" ? null : FAMILY_STYLE[f as NotifFamily];
            const n = f === "all" ? allItems.length : (famCounts[f] || 0);
            if (f !== "all" && !n) return null;
            return (
              <button key={f} onClick={() => setFamFilter(f as any)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 20,
                  cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 12, fontWeight: 700,
                  background: on ? (st ? st.tint : "#F0EDEA") : "#fff",
                  border: `1px solid ${on ? (st ? st.border : "#E5E2DC") : "#E5E2DC"}`,
                  color: on ? (st ? st.color : "#1A1917") : "#6B6860",
                }}>
                {st && <span style={{ width: 7, height: 7, borderRadius: "50%", background: st.color }} />}
                {f === "all" ? "All" : st!.label} <span style={{ opacity: 0.65, fontWeight: 600 }}>{n}</span>
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 4, background: "#F0EDEA", borderRadius: 8, padding: 3 }}>
            {(["all", "unread"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer",
                  background: filter === f ? "#fff" : "transparent",
                  color: filter === f ? "#1A1917" : "#9E9B94",
                  fontSize: 13, fontWeight: filter === f ? 600 : 500,
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  boxShadow: filter === f ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                }}
              >
                {f === "all" ? "All" : `Unread${unreadCount > 0 ? ` (${unreadCount})` : ""}`}
              </button>
            ))}
          </div>

          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "7px 14px",
                border: "1px solid #E5E2DC", borderRadius: 8, background: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#1A1917",
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              <CheckCheck size={14} style={{ color: "#2F3646" }} />
              Mark all read
            </button>
          )}
        </div>

        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E5E2DC", overflow: "hidden" }}>
          {isLoading ? (
            <div style={{ padding: 48, textAlign: "center" }}>
              <div style={{ width: 28, height: 28, border: "3px solid #E5E2DC", borderTopColor: "#2F3646", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto" }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          ) : items.length === 0 ? (
            <div style={{ padding: "64px 24px", textAlign: "center" }}>
              <Bell size={36} style={{ color: "#D1CFCA", marginBottom: 12 }} />
              <p style={{ fontSize: 15, fontWeight: 600, color: "#1A1917", margin: "0 0 6px", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                {filter === "unread" ? "All caught up!" : "No notifications yet"}
              </p>
              <p style={{ fontSize: 13, color: "#9E9B94", margin: 0, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                {filter === "unread" ? "No unread notifications." : "Alerts for bookings, clock-ins, and unassigned jobs will appear here."}
              </p>
            </div>
          ) : (
            items.map((n: any, idx: number) => (
              <button
                key={n.id}
                onClick={() => markRead(n.id, n.link)}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 18px",
                  background: n.read ? "#fff" : styleOf(n.type).unreadBg,
                  boxShadow: n.read ? "none" : `inset 3px 0 0 ${styleOf(n.type).color}`,
                  border: "none", borderBottom: idx < items.length - 1 ? "1px solid #F7F6F3" : "none",
                  cursor: "pointer", width: "100%", textAlign: "left",
                  transition: "background 0.15s",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = n.read ? "#FAFAFA" : styleOf(n.type).tint; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = n.read ? "#fff" : styleOf(n.type).unreadBg; }}
              >
                <span style={{
                  width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                  background: styleOf(n.type).tint, border: `1px solid ${styleOf(n.type).border}`,
                  display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1,
                }}>
                  {notifIcon(n.type)}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: n.read ? 500 : 700, color: "#1A1917", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                      {n.title}
                    </span>
                    <span style={{ fontSize: 11, color: "#C0BDB8", fontFamily: "'Plus Jakarta Sans', sans-serif", marginLeft: "auto", flexShrink: 0 }}>
                      {timeAgo(n.created_at)}
                    </span>
                  </span>
                  {n.body && (
                    <span style={{ display: "block", fontSize: 12, color: "#6B6860", lineHeight: 1.5, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                      {n.body}
                    </span>
                  )}
                </span>
                {!n.read && (
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#2F3646", flexShrink: 0, marginTop: 6 }} />
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
