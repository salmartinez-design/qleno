import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore, getTokenRole } from "@/lib/auth";
import { InlinePriceEdit } from "@/components/inline-price-edit";
import { EarningsPanel } from "@/components/earnings-panel";
import { useToast } from "@/hooks/use-toast";
import { Check, Eye, Navigation, Phone, GraduationCap, DollarSign, Users } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useEmployeeView } from "@/contexts/employee-view-context";
import { getJobVisualStatus, STATUS_VISUALS, ensureJobStatusStyles } from "@/lib/job-status";
import { formatAddress, mapsDirectionsUrl } from "@/lib/format-address";
import { VoiceAssistant } from "@/components/voice-assistant";
import { QlenoMark } from "@/components/brand/QlenoMark";
import { QuoteAttachments } from "@/components/quote-attachments";

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

// Expected finish = scheduled start + allowed hours, so the tech sees their
// target end time on the card (e.g. "9:00 AM · 3.0 hrs allowed · ends ~12:00 PM").
function addHoursToTime(t: string, hours: number): string {
  const [h, m] = t.split(":").map(Number);
  const total = (h || 0) * 60 + (m || 0) + Math.round(hours * 60);
  const hh = Math.floor(total / 60) % 24;
  const mm = ((total % 60) + 60) % 60;
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = hh > 12 ? hh - 12 : hh || 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
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

export type Job = {
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
  client_phone: string | null;
  client_notes: string | null;
  service_type: string;
  status: string;
  scheduled_date: string;
  scheduled_time: string | null;
  account_id: number | null;
  account_name: string | null;
  billing_method: string | null;
  account_property_id: number | null;
  property_name: string | null;
  access_notes: string | null;
  base_fee: number;
  estimated_hours: number | null;
  allowed_hours: number | null;
  zone_name: string | null;
  zone_color: string | null;
  team: string | null;
  team_count: number;
  add_ons: string | null;
  pets: string | null;
  alarm_code: string | null;
  job_notes: string | null;
  is_recurring: boolean;
  visit_number: number | null;
  before_photo_count: number;
  after_photo_count: number;
  time_clock_entry: TimeclockEntry | null;
  // company_* identifies the BUSINESS that owns the job (Phes Oak Lawn vs
  // PHES Schaumburg). For cross-tenant techs this is the load-bearing chip.
  // branch_* is intra-tenant — used by Phes when it carries a branch.
  company_id: number | null;
  company_name: string | null;
  branch_id: number | null;
  branch_name: string | null;
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
        <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFile} />
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

// [quote-attachments] Tech-facing read-only view of files the office
// attached on the source quote. Pre-fetches count so the section header
// only renders when there's actually something to show.
function OfficeAttachments({ jobId }: { jobId: number }) {
  const [hasAny, setHasAny] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/jobs/${jobId}/attachments`)
      .then(r => r.json())
      .then((rows: unknown[]) => { if (!cancelled) setHasAny(Array.isArray(rows) && rows.length > 0); })
      .catch(() => { if (!cancelled) setHasAny(false); });
    return () => { cancelled = true; };
  }, [jobId]);

  if (!hasAny) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 6px" }}>
        Office Attachments
      </p>
      <QuoteAttachments
        readOnly
        ensureQuoteId={async () => jobId}
        endpointOverride={`/api/jobs/${jobId}/attachments`}
        compact
      />
    </div>
  );
}

// Field techs add a note from their phone. Prominent full-width button (easy
// to find), 44px+ tap targets. Server appends to the job's notes (timestamped),
// so the office sees it without the tech clobbering anything.
function AddNote({ jobId, onSaved }: { jobId: number; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    const note = text.trim();
    if (!note) return;
    setSaving(true);
    try {
      const r = await apiFetch(`/jobs/${jobId}/note`, { method: "POST", body: JSON.stringify({ note }) });
      if (r.ok) { setText(""); setOpen(false); onSaved(); }
    } finally { setSaving(false); }
  }
  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{ marginTop: 12, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "12px", borderRadius: 10, border: "1px dashed #C9C5BD", background: "#FAFAF8", color: "#1A1917", fontSize: 15, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
        + Add note
      </button>
    );
  }
  return (
    <div style={{ marginTop: 12 }}>
      <textarea value={text} onChange={e => setText(e.target.value)} autoFocus rows={3} placeholder="Add a note for this job…"
        style={{ width: "100%", boxSizing: "border-box", border: "1px solid #E5E2DC", borderRadius: 10, padding: "10px 12px", fontSize: 15, fontFamily: "inherit", outline: "none", resize: "vertical" }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={save} disabled={saving || !text.trim()}
          style={{ flex: 1, padding: "12px", borderRadius: 10, border: "none", background: text.trim() && !saving ? "var(--brand, #00C9A0)" : "#D1D5DB", color: "#fff", fontSize: 15, fontWeight: 700, cursor: text.trim() && !saving ? "pointer" : "default", fontFamily: "inherit" }}>
          {saving ? "Saving…" : "Save note"}
        </button>
        <button onClick={() => { setOpen(false); setText(""); }} disabled={saving}
          style={{ padding: "12px 16px", borderRadius: 10, border: "1px solid #E5E2DC", background: "#fff", color: "#6B7280", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function JobCard({ job, empPos, onRefresh, isPreviewMode, actingForUserId, prevJobId, requireAfterPhoto, onOpenDetail }: { job: Job; empPos: { lat: number; lng: number } | null; onRefresh: () => void; isPreviewMode?: boolean; actingForUserId?: number | null; prevJobId?: number | null; requireAfterPhoto?: boolean; onOpenDetail?: () => void }) {
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
  // After-photo gate only applies when the owner enabled it (default off).
  const photoGate = !!requireAfterPhoto && photosAfter.length === 0;

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
        // In office "view-as" preview the API call carries the office user's
        // token; acting_for_user_id attributes the clock to the viewed tech.
        body: JSON.stringify({ job_id: job.id, lat, lng, accuracy, override_token, acting_for_user_id: actingForUserId ?? undefined }),
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

  // [mileage-auto 2026-06-04] "On My Way" now hits the proper tech-clock
  // endpoint: it captures the tech's GPS, computes the driving ETA, sends the
  // client an SMS with that ETA, and writes the on_my_way_events row that feeds
  // the mileage engine. from_job_id = the tech's previous job today, so the
  // engine bills only the between-jobs leg (home→first-job is auto-excluded as
  // the first leg of the day). Replaces the manual mileage form.
  const [omwBusy, setOmwBusy] = useState(false);
  const omwMutation = useMutation({
    mutationFn: async ({ lat, lng }: { lat?: number; lng?: number }) => {
      const body: Record<string, unknown> = {};
      if (typeof lat === "number" && typeof lng === "number") { body.from_latitude = lat; body.from_longitude = lng; }
      if (prevJobId != null) body.from_job_id = prevJobId;
      const res = await apiFetch(`/tech/jobs/${job.id}/on-my-way`, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error();
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["status-log", job.id] });
      const eta = data?.data?.estimated_eta_minutes;
      const notified = data?.data?.client_notified;
      toast({
        title: eta != null ? `On My Way — ETA ~${eta} min` : "On My Way sent",
        description: notified ? "Client notified by text" : "Logged (text paused or no phone)",
      });
    },
    onError: () => toast({ variant: "destructive", title: "Couldn't send On My Way" }),
    onSettled: () => setOmwBusy(false),
  });
  const fireOnMyWay = () => {
    if (isPreviewMode) return;
    setOmwBusy(true);
    if (!navigator.geolocation) { omwMutation.mutate({}); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => omwMutation.mutate({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => omwMutation.mutate({}), // GPS denied/failed — still send (ETA falls back)
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  };

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
  // [AI.7.5] Visual status — same canonical helper as the dispatch grid.
  // For the tech view we mostly care about active (amber stripe + pulse)
  // and completed (60% body opacity + checkmark badge); cancelled and
  // scheduled fall through to existing baseline.
  const visual = STATUS_VISUALS[getJobVisualStatus({
    status: job.status,
    scheduled_date: job.scheduled_date,
    scheduled_time: job.scheduled_time,
    assigned_user_id: (job as any).assigned_user_id ?? null,
    clock_entry: entry ? { clock_in_at: entry.clock_in_at, clock_out_at: entry.clock_out_at } : null,
  })];
  useEffect(() => { ensureJobStatusStyles(); }, []);

  return (
    <div
      onClick={onOpenDetail ? (e) => {
        // Whole-card tap opens the detail screen, but never hijack taps on the
        // card's own interactive elements (links, buttons, photo inputs).
        if ((e.target as HTMLElement).closest("a, button, input, img")) return;
        onOpenDetail();
      } : undefined}
      style={{
        backgroundColor: "#FFFFFF",
        // Outline the whole card in the zone color so the tech sees their area at
        // a glance; status overrides (active/unpaid/no-show/unassigned) win when
        // present, mirroring the dispatch chip's border behavior.
        border: `2px solid ${visual.borderOverride || job.zone_color || "#E5E2DC"}`,
        borderRadius: 12, padding: 18, margin: "0 0 12px 0",
        position: "relative", overflow: "hidden",
        opacity: visual.bodyOpacity * (job.status === "cancelled" ? 1 : 1),
        filter: visual.desaturate ? "grayscale(1)" : "none",
        cursor: onOpenDetail ? "pointer" : undefined,
      }}>
      {visual.stripe && (
        <div className="qleno-active-stripe" style={{
          position: "absolute", top: 0, bottom: 0, left: 0, width: 4,
          backgroundColor: visual.stripe,
        }} />
      )}
      {visual.showCheckmark && (
        <div style={{ position: "absolute", top: 12, right: 12, width: 18, height: 18, borderRadius: "50%", backgroundColor: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Check size={11} color="#FFFFFF" strokeWidth={3} />
        </div>
      )}
      {visual.showNoShowBadge && (
        <div style={{ position: "absolute", top: 10, right: 10, fontSize: 9, fontWeight: 800, color: "#FFFFFF", backgroundColor: "#991B1B", padding: "3px 7px", borderRadius: 4, letterSpacing: "0.05em" }}>
          NO SHOW
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, backgroundColor: sc.bg, color: sc.color, textTransform: "capitalize", textDecoration: visual.strikethrough ? "line-through" : "none" }}>
          {job.status.replace("_", " ")}
        </span>
        {/* Techs never edit price. Also suppressed in office "view-as" preview
            so the preview faithfully shows what the cleaner actually sees. */}
        {!isPreviewMode && ["owner", "admin", "office"].includes(getTokenRole() || "")
          ? <InlinePriceEdit jobId={job.id} price={job.base_fee} canEdit onUpdated={onRefresh} />
          : <span style={{ fontSize: 20, fontWeight: 700, color: "#1A1917" }}>${job.base_fee.toFixed(2)}</span>}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, marginBottom: 4, flexWrap: "wrap" }}>
        <p style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", margin: 0 }}>{job.client_name}</p>
        {job.account_id && (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "var(--brand-dim, #EBF4FF)", color: "var(--brand, #00C9A0)" }}>
            Commercial
          </span>
        )}
        {/* For cross-tenant techs the BUSINESS chip is the important one
            (Phes vs PHES Schaumburg). Branch is intra-tenant and only
            shows when there's no company chip to avoid double-tagging. */}
        {job.company_name ? (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
            background: "#F4F3F0", color: "#6B6860", letterSpacing: "0.02em",
            textTransform: "uppercase",
          }}>
            {job.company_name}
          </span>
        ) : job.branch_name ? (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
            background: "#F4F3F0", color: "#6B6860", letterSpacing: "0.02em",
            textTransform: "uppercase",
          }}>
            {job.branch_name}
          </span>
        ) : null}
        {/* Zone chip — color dot + name so the tech knows which area they're
            headed to. A zoneless job is a data error (see zone-resolution rule). */}
        {job.zone_name && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#F4F3F0", color: "#1A1917", letterSpacing: "0.02em" }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: job.zone_color || "#9E9B94", display: "inline-block", flexShrink: 0 }} />
            {job.zone_name}
          </span>
        )}
        {/* Visit context — a first visit needs more care than a routine repeat. */}
        {job.visit_number === 1 ? (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#FEF3C7", color: "#92400E", letterSpacing: "0.02em" }}>First visit</span>
        ) : job.is_recurring ? (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#EEF2FF", color: "#3730A3", letterSpacing: "0.02em" }}>
            Recurring{job.visit_number ? ` · Visit #${job.visit_number}` : ""}
          </span>
        ) : null}
      </div>
      <p style={{ fontSize: 11, fontWeight: 600, color: "var(--brand)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px" }}>
        {formatServiceType(job.service_type)}
      </p>
      {(() => {
        // Allowed hours is the budget the tech needs; estimated_hours is the
        // stale creation stamp and only a fallback.
        const hrs = job.allowed_hours ?? job.estimated_hours;
        const label = job.allowed_hours != null ? "hrs allowed" : "hrs est.";
        return (
          <>
            {job.scheduled_time && (
              <p style={{ fontSize: 12, color: "#6B6860", margin: "0 0 2px" }}>
                {formatTime(job.scheduled_time)}
                {hrs != null && hrs > 0 && (
                  <span style={{ marginLeft: 8, color: "#9E9B94" }}>
                    · {hrs.toFixed(1)} {label} · ends ~{addHoursToTime(job.scheduled_time, hrs)}
                  </span>
                )}
              </p>
            )}
            {!job.scheduled_time && hrs != null && hrs > 0 && (
              <p style={{ fontSize: 12, color: "#9E9B94", margin: "0 0 2px" }}>{hrs.toFixed(1)} {label}</p>
            )}
          </>
        );
      })()}
      {job.team && job.team_count > 1 && (
        <p style={{ fontSize: 12, color: "#6B6860", margin: "4px 0 0", display: "inline-flex", alignItems: "center", gap: 5 }}>
          <Users size={13} aria-hidden="true" style={{ color: "#9E9B94", flexShrink: 0 }} />
          Team: {job.team}
        </p>
      )}
      {job.address && (
        <a
          href={mapsDirectionsUrl(formatAddress(job.address, job.city, job.state, job.zip)) ?? "#"}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 12, color: "var(--brand)", fontWeight: 600,
            textDecoration: "underline", margin: "2px 0 0",
            padding: "4px 0", minHeight: 28,
          }}
        >
          <Navigation size={14} aria-hidden="true" />
          {formatAddress(job.address, job.city, job.state, job.zip)}
        </a>
      )}
      {job.client_phone && (
        <div style={{ marginTop: 6 }}>
          <a
            href={`tel:${job.client_phone.replace(/[^\d+]/g, "")}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              fontSize: 12, color: "var(--brand)", fontWeight: 600,
              textDecoration: "underline",
              padding: "6px 10px", borderRadius: 999,
              backgroundColor: "var(--brand-dim, #EBF4FF)",
              minHeight: 32,
            }}
          >
            <Phone size={14} aria-hidden="true" />
            {job.client_phone}
          </a>
        </div>
      )}
      {job.account_id && job.property_name && (
        <p style={{ fontSize: 11, color: "#9E9B94", margin: "2px 0 0" }}>
          Property: {job.property_name}
        </p>
      )}

      <DistanceBadge jobLat={job.job_lat} jobLng={job.job_lng} empPos={empPos} />

      {job.geocode_failed && (
        <p style={{ fontSize: 11, color: "#92400E", backgroundColor: "#FEF3C7", borderRadius: 4, padding: "3px 8px", display: "inline-block", marginTop: 4 }}>
          Address could not be geocoded — geofencing unavailable
        </p>
      )}

      {/* What to do this visit — the EXTRAS that were sold. A tech who doesn't
          see these skips paid work and the customer is unhappy. */}
      {job.add_ons && (
        <div style={{ backgroundColor: "#ECFDF8", border: "1px solid #99E9D3", borderRadius: 8, padding: "10px 12px", marginTop: 12 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: "#047857", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Services this visit</p>
          <p style={{ fontSize: 13, color: "#065F46", margin: 0, lineHeight: 1.5, fontWeight: 600 }}>
            {formatServiceType(job.service_type)} · {job.add_ons}
          </p>
        </div>
      )}

      {/* Pets — safety + allergy info the cleaner needs before entering. */}
      {job.pets && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginTop: 10, fontSize: 12, color: "#92400E", backgroundColor: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px" }}>
          <span style={{ fontWeight: 700, flexShrink: 0 }}>Pets:</span>
          <span>{job.pets}</span>
        </div>
      )}

      {/* Entry / alarm code — the assigned tech needs this to get in & disarm. */}
      {job.alarm_code && (
        <div style={{ backgroundColor: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 8, padding: "10px 12px", marginTop: 10 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: "#3730A3", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Entry / Alarm Code</p>
          <p style={{ fontSize: 14, color: "#1E1B4B", margin: 0, fontWeight: 700, letterSpacing: "0.04em" }}>{job.alarm_code}</p>
        </div>
      )}

      {job.access_notes && (
        <div style={{ backgroundColor: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 12px", marginTop: 12 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Building Access</p>
          <p style={{ fontSize: 12, color: "#92400E", margin: 0, lineHeight: 1.5 }}>{job.access_notes}</p>
        </div>
      )}

      {!job.access_notes && job.client_notes && (
        <div style={{ backgroundColor: "#F7F6F3", borderRadius: 8, padding: "10px 12px", marginTop: 12 }}>
          <p style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Client Notes</p>
          <p style={{ fontSize: 12, color: "#1A1917", margin: 0 }}>{job.client_notes}</p>
        </div>
      )}

      {/* Per-job instructions (distinct from the standing client notes). */}
      {job.job_notes && (
        <div style={{ backgroundColor: "#F7F6F3", borderRadius: 8, padding: "10px 12px", marginTop: 10 }}>
          <p style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Job Instructions</p>
          <p style={{ fontSize: 12, color: "#1A1917", margin: 0, lineHeight: 1.5 }}>{job.job_notes}</p>
        </div>
      )}

      <AddNote jobId={job.id} onSaved={onRefresh} />

      {/* [quote-attachments] Files the office attached on the source quote.
          Read-only here — techs see photos/PDFs the client sent or the
          office screenshotted during the booking call. */}
      <OfficeAttachments jobId={job.id} />

      <PhotoGrid jobId={job.id} type="before" photos={photosBefore} onUploaded={loadPhotos} />
      <PhotoGrid jobId={job.id} type="after" photos={photosAfter} onUploaded={loadPhotos} />

      {isClockedIn && photoGate && (
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
                if (photoGate) {
                  toast({ variant: "destructive", title: "After photo required", description: "Upload at least 1 after photo first" });
                  return;
                }
                getLocation((lat, lng) => clockOutMutation.mutate({ lat, lng }));
              }}
              disabled={clockOutMutation.isPending || geoLoading}
              style={{
                width: "100%", height: 48, borderRadius: 10, border: "none",
                fontSize: 15, fontWeight: 600,
                cursor: photoGate ? "not-allowed" : "pointer",
                backgroundColor: photoGate ? "#F3F4F6" : "#166534",
                color: photoGate ? "#9E9B94" : "#FFFFFF",
                transition: "opacity 0.15s",
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              {clockOutMutation.isPending || geoLoading ? "Getting location…" : photoGate ? "Clock Out — add after photo first" : "Clock Out"}
            </button>
          </div>
        ) : (
          <div>
            <button
              onClick={fireOnMyWay}
              disabled={omwBusy || omwMutation.isPending}
              style={{
                width: "100%", height: 42, borderRadius: 10, border: "1px solid var(--brand)",
                fontSize: 14, fontWeight: 600, cursor: "pointer", marginBottom: 10,
                backgroundColor: "var(--brand-soft)", color: "var(--brand)",
                opacity: omwBusy ? 0.6 : 1,
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              {omwBusy || omwMutation.isPending ? "Sending…" : "On My Way"}
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
                cursor: "pointer",
                opacity: (clockInMutation.isPending || geoLoading) ? 0.7 : 1,
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              {clockInMutation.isPending || geoLoading ? "Getting location…" : "Clock In"}
            </button>
          </div>
        )}
      </div>

      <StatusTimeline jobId={job.id} />

      {onOpenDetail && (
        <button
          onClick={onOpenDetail}
          style={{
            width: "calc(100% + 36px)", margin: "14px -18px -18px", padding: "11px 18px",
            background: "#F7F6F3", border: "none", borderTop: "1px solid #EEECE7",
            fontSize: 13, fontWeight: 700, color: "#1A1917", cursor: "pointer",
            fontFamily: "'Plus Jakarta Sans', sans-serif", textAlign: "center",
          }}
        >
          View job details ›
        </button>
      )}
    </div>
  );
}

// Local YYYY-MM-DD (not UTC) so the day the tech sees matches their wall clock.
export function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function MyJobsPage() {
  const { employeeView, exitView } = useEmployeeView();
  const token = useAuthStore(state => state.token);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [empPos, setEmpPos] = useState<{ lat: number; lng: number } | null>(null);
  const [showPay, setShowPay] = useState(false);

  let userInfo: { firstName: string; lastName: string } | null = null;
  if (token) {
    try {
      const p = JSON.parse(atob(token.split(".")[1]));
      userInfo = { firstName: p.first_name || "", lastName: p.last_name || "" };
    } catch { /* empty */ }
  }
  const initials = userInfo ? `${userInfo.firstName[0] || ""}${userInfo.lastName[0] || ""}`.toUpperCase() : "?";

  // Day navigation: tech can page to other days; defaults to today.
  const todayYmd = ymd(new Date());
  const [selectedDate, setSelectedDate] = useState(todayYmd);
  const isToday = selectedDate === todayYmd;
  const selectedLabel = (() => {
    const [y, m, d] = selectedDate.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  })();
  const shiftDay = (delta: number) => {
    const [y, m, d] = selectedDate.split("-").map(Number);
    setSelectedDate(ymd(new Date(y, m - 1, d + delta)));
  };

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
    queryKey: ["my-jobs", employeeView?.employeeId, selectedDate],
    queryFn: async () => {
      const params = new URLSearchParams({ date: selectedDate });
      if (employeeView) params.set("employee_id", String(employeeView.employeeId));
      const res = await apiFetch(`/jobs/my-jobs?${params.toString()}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const jobs: Job[] = data?.data || [];
  const requireAfterPhoto: boolean = data?.require_after_photo_for_clockout ?? false;
  const activeJobs = jobs.filter(j => j.status !== "cancelled" && (!j.time_clock_entry || !j.time_clock_entry.clock_out_at || j.status !== "complete"));
  const upcomingJobs = jobs.filter(j => j.status === "scheduled" && !j.time_clock_entry);
  // [day-complete 2026-06-04] The day is DERIVED, never a button: it's done
  // when every non-cancelled job today is checked out. No clock-out tap — this
  // is a closure STATE. Job hours come from the tech's own check-in/out spans.
  const completedToday = jobs.filter(j => j.status !== "cancelled" && (j.status === "complete" || !!j.time_clock_entry?.clock_out_at));
  const dayComplete = jobs.length > 0 && activeJobs.length === 0 && completedToday.length > 0;
  const dayJobHours = completedToday.reduce((sum, j) => {
    const e = j.time_clock_entry;
    if (e?.clock_in_at && e?.clock_out_at) {
      return sum + Math.max(0, (new Date(e.clock_out_at).getTime() - new Date(e.clock_in_at).getTime()) / 3600000);
    }
    return sum + (j.estimated_hours ?? 0);
  }, 0);

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ maxWidth: 460, margin: "0 auto" }}>
        <div style={{
          position: "sticky", top: 0, zIndex: 10,
          backgroundColor: "#FFFFFF", borderBottom: "1px solid #E5E2DC",
          padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <QlenoMark size={24} />
            <span style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", letterSpacing: "-0.01em" }}>My Jobs</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Link href="/training">
              <a style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: '#FFFFFF', color: '#1A1917', border: '1px solid #E5E2DC', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'none' }}>
                <GraduationCap size={13}/> Training
              </a>
            </Link>
            <button onClick={() => setShowPay(p => !p)}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: showPay ? 'var(--brand)' : 'var(--brand-dim)', color: showPay ? '#fff' : 'var(--brand)', border: '1px solid rgba(0,201,160,0.2)', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              <DollarSign size={13}/> Pay
            </button>
            <div title={initials} style={{ width: 28, height: 28, borderRadius: "50%", backgroundColor: "var(--brand-dim)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
              {initials}
            </div>
          </div>
        </div>

        {/* Day navigation — page to other days; tap the date to jump back to today. */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", background: "#FFFFFF", borderBottom: "1px solid #E5E2DC",
        }}>
          <button type="button" onClick={() => shiftDay(-1)} aria-label="Previous day"
            style={{ width: 36, height: 36, borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#1A1917", fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1, fontFamily: "inherit" }}>
            ‹
          </button>
          <button type="button" onClick={() => setSelectedDate(todayYmd)}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{isToday ? "Today" : selectedLabel}</span>
            <span style={{ fontSize: 11, color: "#9E9B94" }}>{isToday ? selectedLabel : "Tap for today"}</span>
          </button>
          <button type="button" onClick={() => shiftDay(1)} aria-label="Next day"
            style={{ width: 36, height: 36, borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#1A1917", fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1, fontFamily: "inherit" }}>
            ›
          </button>
        </div>

        {employeeView && (
          <div style={{ background: "var(--brand, #00C9A0)", padding: "10px 18px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <Eye size={14} color="#fff" />
            <span style={{ fontSize: 13, fontWeight: 600, color: "#fff", flex: 1 }}>
              Viewing as {employeeView.employeeName}
            </span>
            <button type="button" onClick={exitView}
              style={{ fontSize: 12, fontWeight: 700, color: "var(--brand, #00C9A0)", background: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>
              Exit
            </button>
          </div>
        )}

        {showPay && (
          <div style={{ padding: "16px 14px", borderBottom: "1px solid #E5E2DC", background: "#FBFAF8" }}>
            <EarningsPanel title="My pay" />
          </div>
        )}

        <div style={{ padding: "16px 14px" }}>
          {isLoading ? (
            <div style={{ textAlign: "center", padding: 40, color: "#9E9B94", fontSize: 14 }}>Loading your jobs…</div>
          ) : jobs.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40 }}>
              <p style={{ fontSize: 16, fontWeight: 600, color: "#1A1917", margin: "0 0 6px" }}>{isToday ? "No jobs today" : `No jobs on ${selectedLabel}`}</p>
              <p style={{ fontSize: 13, color: "#9E9B94", margin: 0 }}>Check back or contact your manager</p>
            </div>
          ) : (
            <>
              {dayComplete && (
                <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderLeft: "3px solid var(--brand, #2D9B83)", borderRadius: 12, padding: 18, marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 30, height: 30, borderRadius: 15, background: "var(--brand-dim, #ECFDF5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Check size={17} color="var(--brand, #2D9B83)" />
                    </div>
                    <div>
                      <p style={{ fontSize: 16, fontWeight: 800, color: "#1A1917", margin: 0 }}>Day complete</p>
                      <p style={{ fontSize: 12, color: "#9E9B94", margin: 0 }}>{selectedLabel}</p>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <div style={{ flex: 1, background: "#F7F6F3", borderRadius: 10, padding: "10px 12px" }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 2px" }}>Jobs done</p>
                      <p style={{ fontSize: 20, fontWeight: 800, color: "#1A1917", margin: 0 }}>{completedToday.length}</p>
                    </div>
                    <div style={{ flex: 1, background: "#F7F6F3", borderRadius: 10, padding: "10px 12px" }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 2px" }}>Job hours</p>
                      <p style={{ fontSize: 20, fontWeight: 800, color: "#1A1917", margin: 0 }}>{dayJobHours.toFixed(1)}h</p>
                    </div>
                  </div>
                  <p style={{ fontSize: 12, color: "#6B6860", margin: "10px 0 0", lineHeight: 1.5 }}>
                    Drive mileage between your jobs is calculated automatically. Pay and mileage finalize after office review.
                  </p>
                </div>
              )}
              {activeJobs.map((job, i) => (
                <JobCard key={job.id} job={job} empPos={empPos} onRefresh={refetch} isPreviewMode={!!employeeView}
                  actingForUserId={employeeView ? employeeView.employeeId : null}
                  prevJobId={i > 0 ? activeJobs[i - 1].id : null} requireAfterPhoto={requireAfterPhoto}
                  onOpenDetail={() => navigate(`/my-jobs/${job.id}?date=${selectedDate}`)} />
              ))}
              {upcomingJobs.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <p style={{ fontSize: 11, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 10px 4px" }}>Up Next</p>
                  {upcomingJobs.map(job => (
                    <div key={job.id} onClick={() => navigate(`/my-jobs/${job.id}?date=${selectedDate}`)}
                      style={{ opacity: 0.55, backgroundColor: "#FFFFFF", border: `1px solid ${job.zone_color || "#E5E2DC"}`, borderLeft: `3px solid ${job.zone_color || "var(--brand)"}`, borderRadius: 12, padding: 18, marginBottom: 10, cursor: "pointer" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                        <p style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", margin: 0 }}>{job.client_name}</p>
                        {(job.company_name || job.branch_name) && (
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                            background: "#F4F3F0", color: "#6B6860", letterSpacing: "0.02em",
                            textTransform: "uppercase",
                          }}>{job.company_name ?? job.branch_name}</span>
                        )}
                      </div>
                      <p style={{ fontSize: 11, color: "var(--brand)", textTransform: "uppercase", fontWeight: 600, margin: "0 0 4px" }}>{formatServiceType(job.service_type)}</p>
                      {job.scheduled_time && <p style={{ fontSize: 12, color: "#6B6860", margin: 0 }}>{formatTime(job.scheduled_time)}</p>}
                      {job.address && <p style={{ fontSize: 12, color: "#6B6860", margin: "2px 0 0" }}>{formatAddress(job.address, job.city, job.state, job.zip)}</p>}
                      <DistanceBadge jobLat={job.job_lat} jobLng={job.job_lng} empPos={empPos} />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <VoiceAssistant />
    </div>
  );
}
