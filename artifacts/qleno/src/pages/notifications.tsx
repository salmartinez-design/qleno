import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Bell, AlertTriangle, UserMinus, CheckCheck } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type NotifType = "new_booking" | "late_clockin" | "job_unassigned";

function notifIcon(type: NotifType) {
  if (type === "new_booking") return <Bell size={15} style={{ color: "#2563EB" }} />;
  if (type === "late_clockin") return <AlertTriangle size={15} style={{ color: "#F59E0B" }} />;
  return <UserMinus size={15} style={{ color: "#DC2626" }} />;
}

function notifBg(type: NotifType) {
  if (type === "new_booking") return "#EFF6FF";
  if (type === "late_clockin") return "#FFFBEB";
  return "#FEF2F2";
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

  const items: any[] = data?.data || [];
  const unreadCount: number = data?.unread_count || 0;

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
              <CheckCheck size={14} style={{ color: "#2563EB" }} />
              Mark all read
            </button>
          )}
        </div>

        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E5E2DC", overflow: "hidden" }}>
          {isLoading ? (
            <div style={{ padding: 48, textAlign: "center" }}>
              <div style={{ width: 28, height: 28, border: "3px solid #E5E2DC", borderTopColor: "#2563EB", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto" }} />
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
                  background: n.read ? "#fff" : "#F5F8FF",
                  border: "none", borderBottom: idx < items.length - 1 ? "1px solid #F7F6F3" : "none",
                  cursor: "pointer", width: "100%", textAlign: "left",
                  transition: "background 0.15s",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = n.read ? "#FAFAFA" : "#EFF4FF"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = n.read ? "#fff" : "#F5F8FF"; }}
              >
                <span style={{
                  width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                  background: notifBg(n.type as NotifType),
                  display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1,
                }}>
                  {notifIcon(n.type as NotifType)}
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
                    <span style={{ display: "block", fontSize: 12, color: "#6B7280", lineHeight: 1.5, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                      {n.body}
                    </span>
                  )}
                </span>
                {!n.read && (
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#2563EB", flexShrink: 0, marginTop: 6 }} />
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
