import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function apiFetch(path: string, opts?: RequestInit) {
  const token = useAuthStore.getState().token;
  return fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts?.headers || {}) },
  });
}

function formatTime(t: string | null | undefined) {
  if (!t) return "";
  const [h, m] = t.split(":");
  const hour = parseInt(h);
  return `${hour > 12 ? hour - 12 : hour || 12}:${m} ${hour >= 12 ? "PM" : "AM"}`;
}

function formatServiceType(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function formatDuration(ms: number) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getDistanceFt(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 20902231;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

type TimeclockEntry = {
  id: number;
  job_id: number;
  clock_in_at: string;
  clock_out_at: string | null;
  distance_from_job_ft: number | null;
  flagged: boolean;
};

type Job = {
  id: number;
  client_name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  job_lat: number | null;
  job_lng: number | null;
  geocode_failed: boolean;
  client_notes: string | null;
  service_type: string;
  status: string;
  scheduled_date: string;
  scheduled_time: string | null;
  base_fee: number;
  before_photo_count: number;
  after_photo_count: number;
  time_clock_entry: TimeclockEntry | null;
};

function ElapsedTimer({ clockInAt }: { clockInAt: string }) {
  const [elapsed, setElapsed] = useState(Date.now() - new Date(clockInAt).getTime());
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - new Date(clockInAt).getTime()), 1000);
    return () => clearInterval(id);
  }, [clockInAt]);
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatDuration(elapsed)}</span>;
}

function PhotoGrid({ jobId, type, photos, onUploaded }: {
  jobId: number; type: "before" | "after"; photos: string[]; onUploaded: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast({ variant: "destructive", title: "File too large", description: "Max 10MB" }); return; }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast({ variant: "destructive", title: "Invalid file type" }); return; }
    setUploading(true);
    try {
      const data_url = await fileToBase64(file);
      const res = await apiFetch(`/jobs/${jobId}/photos`, {
        method: "POST",
        body: JSON.stringify({ photo_type: type, data_url }),
      });
      if (!res.ok) throw new Error("Upload failed");
      onUploaded();
      toast({ title: `${type === "before" ? "Before" : "After"} photo added` });
    } catch {
      toast({ variant: "destructive", title: "Upload failed" });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div>
      <p style={{ fontSize: 12, fontWeight: 600, color: "#1A1917", margin: "14px 0 8px" }}>
        {type === "before" ? "Before" : "After"} Photos
        <span style={{ fontWeight: 400, color: "#9E9B94", marginLeft: 6 }}>({photos.length})</span>
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 72px)", gap: 8 }}>
        {photos.map((url, i) => (
          <img key={i} src={url} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid #EEECE7" }} />
        ))}
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          style={{ width: 72, height: 72, border: "1.5px dashed #DEDAD4", borderRadius: 8, backgroundColor: "#F7F6F3", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 22, color: "#9E9B94", flexShrink: 0 }}
        >
          {uploading ? "…" : "+"}
        </button>
        <input ref={inputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handleFile} />
      </div>
    </div>
  );
}

const EVENT_LABELS: Record<string, string> = { on_my_way: "On My Way", arrived: "Arrived", paused: "Paused", resumed: "Resumed", complete: "Complete" };

function StatusTimeline({ jobId }: { jobId: number }) {
  const { data } = useQuery({
    queryKey: ["status-log", jobId],
    queryFn: async () => {
      const res = await apiFetch(`/jobs/${jobId}/status-log`);
      return res.ok ? res.json() : { data: [] };
    },
    refetchInterval: 15000,
  });
  const logs: { id: number; event: string; sms_sent: boolean; created_at: string; employee: string }[] = data?.data ?? [];
  if (logs.length === 0) return null;
  return (
    <div style={{ borderTop: "1px solid #EEECE7", marginTop: 14, paddingTop: 12 }}>
      <p style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>Status Updates</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {logs.map(l => (
          <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#6B6860" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: l.sms_sent ? "#10B981" : "#9E9B94", flexShrink: 0 }} />
            <span style={{ fontWeight: 600, color: "#1A1917" }}>{EVENT_LABELS[l.event] ?? l.event}</span>
            <span style={{ color: "#9E9B94", fontSize: 11 }}>{new Date(l.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
            {l.sms_sent && <span style={{ fontSize: 10, backgroundColor: "#DCFCE7", color: "#166534", borderRadius: 3, padding: "1px 5px", fontWeight: 600 }}>SMS</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function DistanceBadge({ jobLat, jobLng, empPos }: {
  jobLat: number | null; jobLng: number | null;
  empPos: { lat: number; lng: number } | null;
}) {
  if (!jobLat || !jobLng) return null;
  if (!empPos) return (
    <p style={{ fontSize: 11, color: "#9E9B94", margin: "4px 0 0" }}>Getting location…</p>
  );

  const ft = getDistanceFt(empPos.lat, empPos.lng, jobLat, jobLng);
  const miles = (ft / 5280).toFixed(1);

  let color = "#166534";
  let bg = "#DCFCE7";
  let label = "You're here";
  if (ft > 2640) { color = "#991B1B"; bg = "#FEE2E2"; label = "Drive to location"; }
  else if (ft > 660) { color = "#92400E"; bg = "#FEF3C7"; label = "Heading there"; }

  return (
    <span style={{
      display: "inline-block", fontSize: 11, fontWeight: 600,
      padding: "2px 8px", borderRadius: 20, backgroundColor: bg, color, marginTop: 4,
    }}>
      {parseFloat(miles) < 0.1 ? `${ft} ft` : `${miles} mi`} away — {label}
    </span>
  );
}

function JobCard({ job, empPos, onRefresh }: { job: Job; empPos: { lat: number; lng: number } | null; onRefresh: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [geoLoading, setGeoLoading] = useState(false);
  const [photosBefore, setPhotosBefore] = useState<string[]>([]);
  const [photosAfter, setPhotosAfter] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [geofenceError, setGeofenceError] = useState<{ message: string; distanceFt: number; radiusFt: number; overrideAllowed: boolean } | null>(null);
  const [softWarning, setSoftWarning] = useState<string | null>(null);

  const entry = job.time_clock_entry;
  const isClockedIn = entry && !entry.clock_out_at;
  const isComplete = job.status === "complete" || (entry && entry.clock_out_at);

  const loadPhotos = useCallback(async () => {
    const res = await apiFetch(`/jobs/${job.id}/photos`);
    if (res.ok) {
      const d = await res.json();
      setPhotosBefore((d.data || []).filter((p: any) => p.photo_type === "before").map((p: any) => p.url));
      setPhotosAfter((d.data || []).filter((p: any) => p.photo_type === "after").map((p: any) => p.url));
    }
  }, [job.id]);

  useEffect(() => { loadPhotos(); }, [loadPhotos]);

  const clockInMutation = useMutation({
    mutationFn: async ({ lat, lng, accuracy, override_token }: { lat: number; lng: number; accuracy?: number; override_token?: string }) => {
      const res = await apiFetch("/timeclock/clock-in", {
        method: "POST",
        body: JSON.stringify({ job_id: job.id, lat, lng, accuracy, override_token }),
      });
      const data = await res.json();
      if (!res.ok) throw { status: res.status, ...data };
      return data;
    },
    onSuccess: (data) => {
      setGeofenceError(null);
      if (data.soft_warned) {
        setSoftWarning(`You are ${Math.round(data.clock_in_distance_ft || 0)} feet from the job address. Your location has been logged.`);
      }
      if (data.flagged) {
        toast({ title: "Clocked in — out of zone", description: `${Math.round(data.distance_from_job_ft || 0)} ft from job site`, variant: "destructive" });
      } else {
        toast({ title: "Clocked in", description: data.clock_in_distance_ft ? `${Math.round(data.clock_in_distance_ft)} ft from job` : "Location recorded" });
      }
      onRefresh();
    },
    onError: (e: any) => {
      if (e.error === "GEOFENCE_BLOCKED") {
        setGeofenceError({
          message: e.message,
          distanceFt: Math.round(e.distance_ft || 0),
          radiusFt: e.radius_ft || 500,
          overrideAllowed: e.override_allowed ?? true,
        });
      } else {
        toast({ variant: "destructive", title: "Clock in failed", description: e.message || "Unknown error" });
      }
    },
  });

  const clockOutMutation = useMutation({
    mutationFn: async ({ lat, lng }: { lat: number; lng: number }) => {
      const res = await apiFetch(`/timeclock/${entry!.id}/clock-out`, {
        method: "POST",
        body: JSON.stringify({ lat, lng }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "PHOTOS_REQUIRED") throw new Error("PHOTOS_REQUIRED");
        if (data.error === "GEOFENCE_BLOCKED") throw { ...data };
        throw new Error(data.message || "Clock out failed");
      }
      return data;
    },
    onSuccess: (data) => {
      if (data.soft_warned) {
        toast({ title: "Job complete", description: `Clocked out — ${Math.round(data.clock_out_distance_ft || 0)} ft from job (logged)` });
      } else {
        toast({ title: "Job complete!", description: "Clock out recorded." });
      }
      onRefresh();
    },
    onError: (e: any) => {
      if (e.message === "PHOTOS_REQUIRED") {
        toast({ variant: "destructive", title: "After photo required", description: "Upload at least 1 after photo first" });
      } else if (e.error === "GEOFENCE_BLOCKED") {
        toast({ variant: "destructive", title: "Too far to clock out", description: e.message });
      } else {
        toast({ variant: "destructive", title: "Clock out failed", description: e.message });
      }
    },
  });

  const smsMutation = useMutation({
    mutationFn: async (event: string) => {
      const res = await apiFetch(`/jobs/${job.id}/sms-status`, { method: "POST", body: JSON.stringify({ event }) });
      return res.json();
    },
    onSuccess: (data, event) => {
      if (event === "paused") setPaused(true);
      if (event === "resumed") setPaused(false);
      qc.invalidateQueries({ queryKey: ["status-log", job.id] });
      const label = EVENT_LABELS[event] ?? event;
      if (data.sms_sent) {
        toast({ title: `${label} — SMS sent to client` });
      } else {
        toast({ title: `${label} logged`, description: data.reason || "No SMS (disabled or no phone)" });
      }
    },
    onError: () => toast({ variant: "destructive", title: "Status update failed" }),
  });

  const getLocation = (cb: (lat: number, lng: number, accuracy?: number) => void) => {
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoLoading(false);
        cb(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      () => {
        setGeoLoading(false);
        toast({ variant: "destructive", title: "Location access required", description: "Please enable location in your browser settings." });
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  const statusColors: Record<string, { bg: string; color: string }> = {
    scheduled: { bg: "#DBEAFE", color: "#1E40AF" },
    in_progress: { bg: "#FEF3C7", color: "#92400E" },
    complete: { bg: "#DCFCE7", color: "#166534" },
    cancelled: { bg: "#F3F4F6", color: "#6B7280" },
  };
  const sc = statusColors[job.status] || statusColors.scheduled;

  return (
    <div style={{
      backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC",
      borderLeft: `3px solid var(--brand)`, borderRadius: 12,
      padding: 18, margin: "0 0 12px 0",
      opacity: job.status === "cancelled" ? 0.5 : 1,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, backgroundColor: sc.bg, color: sc.color, textTransform: "capitalize" }}>
          {job.status.replace("_", " ")}
        </span>
        <span style={{ fontSize: 20, fontWeight: 700, color: "#1A1917" }}>${job.base_fee.toFixed(2)}</span>
      </div>

      <p style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", margin: "10px 0 4px" }}>{job.client_name}</p>
      <p style={{ fontSize: 11, fontWeight: 600, color: "var(--brand)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px" }}>
        {formatServiceType(job.service_type)}
      </p>
      {job.scheduled_time && (
        <p style={{ fontSize: 12, color: "#6B6860", margin: "0 0 2px" }}>{formatTime(job.scheduled_time)}</p>
      )}
      {job.address && (
        <p style={{ fontSize: 12, color: "#6B6860", margin: 0 }}>
          {job.address}{job.city ? `, ${job.city}` : ""}
        </p>
      )}

      <DistanceBadge jobLat={job.job_lat} jobLng={job.job_lng} empPos={empPos} />

      {job.geocode_failed && (
        <p style={{ fontSize: 11, color: "#92400E", backgroundColor: "#FEF3C7", borderRadius: 4, padding: "3px 8px", display: "inline-block", marginTop: 4 }}>
          Address could not be geocoded — geofencing unavailable
        </p>
      )}

      {job.client_notes && (
        <div style={{ backgroundColor: "#F7F6F3", borderRadius: 8, padding: "10px 12px", marginTop: 12 }}>
          <p style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Client Notes</p>
          <p style={{ fontSize: 12, color: "#1A1917", margin: 0 }}>{job.client_notes}</p>
        </div>
      )}

      <PhotoGrid jobId={job.id} type="before" photos={photosBefore} onUploaded={loadPhotos} />
      <PhotoGrid jobId={job.id} type="after" photos={photosAfter} onUploaded={loadPhotos} />

      {isClockedIn && photosAfter.length === 0 && (
        <div style={{ backgroundColor: "#FEF3C7", borderLeft: "3px solid #F59E0B", borderRadius: "0 6px 6px 0", padding: "10px 12px", marginTop: 12 }}>
          <p style={{ fontSize: 12, color: "#92400E", margin: 0 }}>After photos required before clock-out</p>
        </div>
      )}

      {softWarning && (
        <div style={{ backgroundColor: "#FFFBEB", border: "1px solid #F59E0B", borderRadius: 8, padding: "10px 12px", marginTop: 12 }}>
          <p style={{ fontSize: 12, color: "#92400E", fontWeight: 600, margin: 0 }}>Location warning</p>
          <p style={{ fontSize: 12, color: "#92400E", margin: "4px 0 0" }}>You are {softWarning}</p>
        </div>
      )}

      {geofenceError && (
        <div style={{ backgroundColor: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "14px 16px", marginTop: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "#991B1B", margin: "0 0 6px" }}>Too far to clock in</p>
          <p style={{ fontSize: 12, color: "#7F1D1D", margin: "0 0 12px", lineHeight: 1.5 }}>
            You are {geofenceError.distanceFt} ft from this job. Must be within {geofenceError.radiusFt} ft to clock in. Please drive to the job address and try again.
          </p>
          {geofenceError.overrideAllowed && (
            <button
              onClick={() => {
                setGeofenceError(null);
                getLocation((lat, lng, accuracy) => clockInMutation.mutate({ lat, lng, accuracy, override_token: "approved" }));
              }}
              style={{
                width: "100%", height: 40, backgroundColor: "#FEF3C7", color: "#92400E",
                border: "1px solid #F59E0B", borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              Request Override — Clock in anyway
            </button>
          )}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {isComplete ? (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <p style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>Job Complete</p>
            {entry?.clock_in_at && entry?.clock_out_at && (
              <p style={{ fontSize: 14, color: "#6B6860", margin: 0 }}>
                Duration: {formatDuration(new Date(entry.clock_out_at).getTime() - new Date(entry.clock_in_at).getTime())}
              </p>
            )}
          </div>
        ) : isClockedIn ? (
          <div style={{ textAlign: "center" }}>
            {paused && (
              <div style={{ backgroundColor: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 12, color: "#92400E", fontWeight: 600 }}>
                Job is paused
              </div>
            )}
            <div style={{ fontSize: 36, fontWeight: 700, color: "#1A1917", marginBottom: 2 }}>
              <ElapsedTimer clockInAt={entry!.clock_in_at} />
            </div>
            <p style={{ fontSize: 11, color: "#9E9B94", margin: "0 0 12px" }}>Time on job</p>
            <button
              onClick={() => smsMutation.mutate(paused ? "resumed" : "paused")}
              disabled={smsMutation.isPending}
              style={{
                width: "100%", height: 42, borderRadius: 10, border: `1px solid ${paused ? "#10B981" : "#F59E0B"}`,
                fontSize: 14, fontWeight: 600, cursor: "pointer", marginBottom: 10,
                backgroundColor: paused ? "#DCFCE7" : "#FEF3C7",
                color: paused ? "#166534" : "#92400E",
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              {smsMutation.isPending ? "Updating…" : paused ? "Resume Job" : "Pause Job"}
            </button>
            <button
              onClick={() => {
                if (photosAfter.length === 0) {
                  toast({ variant: "destructive", title: "After photo required", description: "Upload at least 1 after photo first" });
                  return;
                }
                getLocation((lat, lng) => clockOutMutation.mutate({ lat, lng }));
              }}
              disabled={clockOutMutation.isPending || geoLoading}
              style={{
                width: "100%", height: 48, borderRadius: 10, border: "none",
                fontSize: 15, fontWeight: 600, cursor: photosAfter.length === 0 ? "not-allowed" : "pointer",
                backgroundColor: photosAfter.length === 0 ? "#F3F4F6" : "#166534",
                color: photosAfter.length === 0 ? "#9E9B94" : "#FFFFFF",
                transition: "opacity 0.15s",
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              {clockOutMutation.isPending || geoLoading ? "Getting location…" : photosAfter.length === 0 ? "Clock Out — add after photo first" : "Clock Out"}
            </button>
          </div>
        ) : (
          <div>
            <button
              onClick={() => smsMutation.mutate("on_my_way")}
              disabled={smsMutation.isPending}
              style={{
                width: "100%", height: 42, borderRadius: 10, border: "1px solid var(--brand)",
                fontSize: 14, fontWeight: 600, cursor: "pointer", marginBottom: 10,
                backgroundColor: "var(--brand-soft)", color: "var(--brand)",
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              {smsMutation.isPending ? "Sending…" : "On My Way"}
            </button>
            <button
              onClick={() => {
                setGeofenceError(null);
                setSoftWarning(null);
                getLocation((lat, lng, accuracy) => clockInMutation.mutate({ lat, lng, accuracy }));
              }}
              disabled={clockInMutation.isPending || geoLoading}
              style={{
                width: "100%", height: 48, backgroundColor: "var(--brand)", color: "#FFFFFF",
                borderRadius: 10, border: "none", fontSize: 15, fontWeight: 600,
                cursor: "pointer", opacity: (clockInMutation.isPending || geoLoading) ? 0.7 : 1,
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              {clockInMutation.isPending || geoLoading ? "Getting location…" : "Clock In"}
            </button>
          </div>
        )}
      </div>

      <StatusTimeline jobId={job.id} />
    </div>
  );
}

export default function MyJobsPage() {
  const token = useAuthStore(state => state.token);
  const qc = useQueryClient();
  const [empPos, setEmpPos] = useState<{ lat: number; lng: number } | null>(null);

  let userInfo: { firstName: string; lastName: string } | null = null;
  if (token) {
    try {
      const p = JSON.parse(atob(token.split(".")[1]));
      userInfo = { firstName: p.first_name || "", lastName: p.last_name || "" };
    } catch { /* empty */ }
  }
  const initials = userInfo ? `${userInfo.firstName[0] || ""}${userInfo.lastName[0] || ""}`.toUpperCase() : "?";

  const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  useEffect(() => {
    let watchId: number | null = null;

    const update = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => setEmpPos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => {},
        { enableHighAccuracy: true, timeout: 10000 }
      );
    };

    update();
    const interval = setInterval(update, 60000);

    return () => {
      clearInterval(interval);
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["my-jobs"],
    queryFn: async () => {
      const res = await apiFetch("/jobs/my-jobs");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const jobs: Job[] = data?.data || [];
  const activeJobs = jobs.filter(j => j.status !== "cancelled" && (!j.time_clock_entry || !j.time_clock_entry.clock_out_at || j.status !== "complete"));
  const upcomingJobs = jobs.filter(j => j.status === "scheduled" && !j.time_clock_entry);

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ maxWidth: 460, margin: "0 auto" }}>
        <div style={{
          position: "sticky", top: 0, zIndex: 10,
          backgroundColor: "#FFFFFF", borderBottom: "1px solid #E5E2DC",
          padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", backgroundColor: "var(--brand-dim)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>
            {initials}
          </div>
          <span style={{ fontSize: 15, fontWeight: 600, color: "#1A1917" }}>My Jobs</span>
          <span style={{ fontSize: 12, color: "#6B6860" }}>{today}</span>
        </div>

        <div style={{ padding: "16px 14px" }}>
          {isLoading ? (
            <div style={{ textAlign: "center", padding: 40, color: "#9E9B94", fontSize: 14 }}>Loading your jobs…</div>
          ) : jobs.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40 }}>
              <p style={{ fontSize: 16, fontWeight: 600, color: "#1A1917", margin: "0 0 6px" }}>No jobs today</p>
              <p style={{ fontSize: 13, color: "#9E9B94", margin: 0 }}>Check back or contact your manager</p>
            </div>
          ) : (
            <>
              {activeJobs.map(job => (
                <JobCard key={job.id} job={job} empPos={empPos} onRefresh={refetch} />
              ))}
              {upcomingJobs.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <p style={{ fontSize: 11, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 10px 4px" }}>Up Next</p>
                  {upcomingJobs.map(job => (
                    <div key={job.id} style={{ opacity: 0.55, backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderLeft: "3px solid var(--brand)", borderRadius: 12, padding: 18, marginBottom: 10 }}>
                      <p style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>{job.client_name}</p>
                      <p style={{ fontSize: 11, color: "var(--brand)", textTransform: "uppercase", fontWeight: 600, margin: "0 0 4px" }}>{formatServiceType(job.service_type)}</p>
                      {job.scheduled_time && <p style={{ fontSize: 12, color: "#6B6860", margin: 0 }}>{formatTime(job.scheduled_time)}</p>}
                      {job.address && <p style={{ fontSize: 12, color: "#6B6860", margin: "2px 0 0" }}>{job.address}{job.city ? `, ${job.city}` : ""}</p>}
                      <DistanceBadge jobLat={job.job_lat} jobLng={job.job_lng} empPos={empPos} />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
