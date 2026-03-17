import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, MapPin } from "lucide-react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function apiFetch(path: string, opts?: RequestInit) {
  const token = useAuthStore.getState().token;
  return fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts?.headers || {}) },
  });
}

function formatDateTime(dt: string | null | undefined) {
  if (!dt) return "—";
  return new Date(dt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDuration(clockIn: string, clockOut: string | null) {
  if (!clockOut) return "Active";
  const ms = new Date(clockOut).getTime() - new Date(clockIn).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

type Entry = {
  id: number;
  user_id: number;
  job_id: number;
  user_name: string;
  clock_in_at: string;
  clock_out_at: string | null;
  distance_from_job_ft: number | null;
  clock_in_distance_ft: number | null;
  clock_out_distance_ft: number | null;
  clock_in_outside_geofence: boolean;
  clock_out_outside_geofence: boolean;
  override_approved: boolean;
  flagged: boolean;
};

type Violation = {
  id: number;
  user_name: string;
  job_id: number;
  clock_in_at: string;
  clock_in_distance_ft: number | null;
  clock_out_distance_ft: number | null;
  clock_in_outside_geofence: boolean;
  clock_out_outside_geofence: boolean;
};

function DistanceBadge({ distanceFt, outsideGeofence, overrideApproved }: {
  distanceFt: number | null;
  outsideGeofence: boolean;
  overrideApproved?: boolean;
}) {
  if (distanceFt === null) return <span style={{ color: "#9E9B94" }}>—</span>;

  if (overrideApproved) {
    return (
      <span>
        <span style={{ fontSize: 12, color: "#7C3AED", fontWeight: 600 }}>{Math.round(distanceFt)} ft</span>
        {" "}
        <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 20, backgroundColor: "#EDE9FE", color: "#7C3AED" }}>OVERRIDE</span>
      </span>
    );
  }

  if (outsideGeofence) {
    return (
      <span>
        <span style={{ fontSize: 12, color: "#DC2626", fontWeight: 600 }}>{Math.round(distanceFt)} ft</span>
        {" "}
        <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 20, backgroundColor: "#FEE2E2", color: "#991B1B" }}>OUT OF RANGE</span>
      </span>
    );
  }

  return (
    <span>
      <span style={{ fontSize: 12, color: "#166534", fontWeight: 600 }}>{Math.round(distanceFt)} ft</span>
      {" "}
      <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 20, backgroundColor: "#DCFCE7", color: "#166534" }}>IN RANGE</span>
    </span>
  );
}

function FlagModal({ entry, onClose, onDismiss }: { entry: Entry; onClose: () => void; onDismiss: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)" }} />
      <div style={{ position: "relative", backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, maxWidth: 420, width: "90%", boxShadow: "0 8px 40px rgba(0,0,0,0.12)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", backgroundColor: "#FEE2E2", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <AlertTriangle size={18} color="#DC2626" />
          </div>
          <div>
            <p style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", margin: 0 }}>Geofence Flag</p>
            <p style={{ fontSize: 12, color: "#6B7280", margin: 0 }}>Job #{entry.job_id}</p>
          </div>
        </div>
        <div style={{ backgroundColor: "#F7F6F3", borderRadius: 8, padding: "14px 16px", marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "#1A1917", margin: "0 0 6px", fontWeight: 600 }}>{entry.user_name}</p>
          <p style={{ fontSize: 12, color: "#6B7280", margin: "0 0 4px" }}>
            Clocked in at {formatDateTime(entry.clock_in_at)}
          </p>
          {entry.clock_in_distance_ft !== null && (
            <p style={{ fontSize: 13, color: "#DC2626", fontWeight: 600, margin: "0 0 4px" }}>
              Clock-in: {Math.round(entry.clock_in_distance_ft)} ft from job site
            </p>
          )}
          {entry.clock_out_distance_ft !== null && (
            <p style={{ fontSize: 13, color: "#DC2626", fontWeight: 600, margin: 0 }}>
              Clock-out: {Math.round(entry.clock_out_distance_ft)} ft from job site
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onDismiss}
            style={{ flex: 1, height: 40, backgroundColor: "#DCFCE7", color: "#166534", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
          >
            Dismiss Flag
          </button>
          <button
            onClick={onClose}
            style={{ flex: 1, height: 40, backgroundColor: "#F3F4F6", color: "#6B7280", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
          >
            Keep Flag
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ClockMonitorPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);

  const today = new Date().toISOString().split("T")[0];

  const { data, isLoading } = useQuery({
    queryKey: ["clock-monitor", today],
    queryFn: async () => {
      const res = await apiFetch(`/timeclock?date_from=${today}T00:00:00&date_to=${today}T23:59:59`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const { data: violationsData } = useQuery({
    queryKey: ["clock-violations", today],
    queryFn: async () => {
      const res = await apiFetch(`/timeclock/violations`);
      if (!res.ok) return { data: [] };
      return res.json();
    },
    refetchInterval: 30000,
  });

  const dismissMutation = useMutation({
    mutationFn: async (entryId: number) => {
      const res = await apiFetch(`/timeclock/${entryId}/unflag`, { method: "PATCH" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Flag dismissed" });
      qc.invalidateQueries({ queryKey: ["clock-monitor"] });
      qc.invalidateQueries({ queryKey: ["clock-violations"] });
      setSelectedEntry(null);
    },
    onError: () => toast({ variant: "destructive", title: "Failed to dismiss flag" }),
  });

  const entries: Entry[] = data?.data || [];
  const violations: Violation[] = violationsData?.data || [];
  const flaggedCount = entries.filter(e => e.flagged).length;
  const activeCount = entries.filter(e => !e.clock_out_at).length;
  const outOfRangeCount = entries.filter(e => e.clock_in_outside_geofence || e.clock_out_outside_geofence).length;

  return (
    <DashboardLayout>
      <div style={{ padding: "28px 32px", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>Clock Monitor</h1>
          <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>Today's clock activity across all employees</p>
        </div>

        <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
          {[
            { label: "Total Entries", value: entries.length, color: "#1A1917", bg: "#FFFFFF" },
            { label: "Currently Active", value: activeCount, color: "#166534", bg: "#DCFCE7" },
            { label: "Flagged", value: flaggedCount, color: "#991B1B", bg: "#FEE2E2" },
            { label: "Out of Range", value: outOfRangeCount, color: "#92400E", bg: "#FEF3C7" },
          ].map(stat => (
            <div key={stat.label} style={{ backgroundColor: stat.bg, border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 20px", minWidth: 130 }}>
              <p style={{ fontSize: 24, fontWeight: 700, color: stat.color, margin: "0 0 2px" }}>{stat.value}</p>
              <p style={{ fontSize: 12, color: "#6B7280", margin: 0 }}>{stat.label}</p>
            </div>
          ))}
        </div>

        {violations.length > 0 && (
          <div style={{ backgroundColor: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 12, padding: "16px 20px", marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <MapPin size={16} color="#D97706" />
              <p style={{ fontSize: 14, fontWeight: 700, color: "#92400E", margin: 0 }}>
                {violations.length} clock {violations.length === 1 ? "entry" : "entries"} today outside the geofence
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {violations.map(v => (
                <div key={v.id} style={{ backgroundColor: "#FFFFFF", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{v.user_name}</span>
                    <span style={{ fontSize: 12, color: "#6B7280", marginLeft: 10 }}>Job #{v.job_id}</span>
                    <span style={{ fontSize: 12, color: "#9E9B94", marginLeft: 10 }}>{formatDateTime(v.clock_in_at)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {v.clock_in_outside_geofence && v.clock_in_distance_ft !== null && (
                      <span style={{ fontSize: 11, color: "#DC2626", fontWeight: 600 }}>In: {Math.round(v.clock_in_distance_ft)} ft</span>
                    )}
                    {v.clock_out_outside_geofence && v.clock_out_distance_ft !== null && (
                      <span style={{ fontSize: 11, color: "#DC2626", fontWeight: 600 }}>Out: {Math.round(v.clock_out_distance_ft)} ft</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, overflow: "hidden" }}>
          {isLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 14 }}>Loading clock entries…</div>
          ) : entries.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center" }}>
              <p style={{ fontSize: 15, fontWeight: 600, color: "#1A1917", margin: "0 0 6px" }}>No clock entries today</p>
              <p style={{ fontSize: 13, color: "#9E9B94", margin: 0 }}>Entries appear when employees clock in</p>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                    {["Employee", "Job", "Clock In", "Clock Out", "Duration", "Clock-In Distance", "Status"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "12px 16px", fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entries.map(entry => {
                    const isFlagged = entry.flagged;
                    const isActive = !entry.clock_out_at;
                    const isOutOfRange = entry.clock_in_outside_geofence || entry.clock_out_outside_geofence;
                    return (
                      <tr
                        key={entry.id}
                        onClick={() => isFlagged ? setSelectedEntry(entry) : undefined}
                        style={{
                          borderBottom: "1px solid #F0EEE9",
                          backgroundColor: isFlagged ? "rgba(239, 68, 68, 0.04)" : isOutOfRange ? "rgba(245, 158, 11, 0.04)" : "#FFFFFF",
                          borderLeft: isFlagged ? "3px solid #EF4444" : isOutOfRange ? "3px solid #F59E0B" : "3px solid transparent",
                          cursor: isFlagged ? "pointer" : "default",
                          transition: "background-color 0.1s",
                        }}
                        onMouseEnter={e => { if (!isFlagged) return; (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(239, 68, 68, 0.08)"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = isFlagged ? "rgba(239, 68, 68, 0.04)" : isOutOfRange ? "rgba(245, 158, 11, 0.04)" : "#FFFFFF"; }}
                      >
                        <td style={{ padding: "12px 16px", fontWeight: 600, color: "#1A1917" }}>{entry.user_name}</td>
                        <td style={{ padding: "12px 16px", color: "#6B7280" }}>#{entry.job_id}</td>
                        <td style={{ padding: "12px 16px", color: "#1A1917" }}>{formatDateTime(entry.clock_in_at)}</td>
                        <td style={{ padding: "12px 16px", color: "#1A1917" }}>{formatDateTime(entry.clock_out_at)}</td>
                        <td style={{ padding: "12px 16px", color: "#1A1917" }}>{formatDuration(entry.clock_in_at, entry.clock_out_at)}</td>
                        <td style={{ padding: "12px 16px" }}>
                          <DistanceBadge
                            distanceFt={entry.clock_in_distance_ft ?? entry.distance_from_job_ft}
                            outsideGeofence={entry.clock_in_outside_geofence}
                            overrideApproved={entry.override_approved}
                          />
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          {isFlagged ? (
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, backgroundColor: "#FEE2E2", color: "#991B1B", cursor: "pointer" }}>Flagged</span>
                          ) : entry.override_approved ? (
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, backgroundColor: "#EDE9FE", color: "#7C3AED" }}>Override</span>
                          ) : isActive ? (
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, backgroundColor: "#DCFCE7", color: "#166534" }}>On Job</span>
                          ) : (
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, backgroundColor: "#DBEAFE", color: "#1E40AF" }}>Complete</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selectedEntry && (
        <FlagModal
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          onDismiss={() => dismissMutation.mutate(selectedEntry.id)}
        />
      )}
    </DashboardLayout>
  );
}
