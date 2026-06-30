import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore, getTokenRole } from "@/lib/auth";
import { InlinePriceEdit } from "@/components/inline-price-edit";
import { EarningsPanel } from "@/components/earnings-panel";
import { TeamPhotoNotes } from "@/components/team-photo-notes";
import { useToast } from "@/hooks/use-toast";
import { Check, Eye, Navigation, Phone, GraduationCap, DollarSign, Users, MapPin, Sun, Cloud, CloudSun, CloudRain, CloudSnow, CloudDrizzle, CloudLightning, Plane, Bell, KeyRound, LogOut, Camera } from "lucide-react";
import { Link, useLocation } from "wouter";
import { ChangePasswordModal } from "@/components/change-password-modal";
import { NotificationBell } from "@/components/notification-bell";
import { PushNudge } from "@/components/push-nudge";
import { useEmployeeView } from "@/contexts/employee-view-context";
import { getJobVisualStatus, STATUS_VISUALS, ensureJobStatusStyles } from "@/lib/job-status";
import { formatAddress, mapsDirectionsUrl } from "@/lib/format-address";
import { FREQUENCY_LABELS as CANONICAL_FREQUENCY_LABELS } from "@/lib/frequency-labels";
import { VoiceAssistant } from "@/components/voice-assistant";
import { QlenoMark } from "@/components/brand/QlenoMark";
import { QuoteAttachments } from "@/components/quote-attachments";
import { enqueueClock, isOfflineError, flushClockQueue, queueLength } from "@/lib/offline-clock";
import { shiftForWeekday } from "@/lib/business-hours";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// Row style for the mobile account-menu items (Time Off / Notifications / etc.).
const acctItemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
  borderRadius: 7, background: "none", border: "none", cursor: "pointer",
  width: "100%", textAlign: "left", fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 13, fontWeight: 500, color: "#1A1917",
};

function apiFetch(path: string, opts?: RequestInit) {
  const token = useAuthStore.getState().token;
  return fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts?.headers || {}) },
  });
}

// [street-view 2026-06-10] Sal: a Street View thumbnail above the address helps
// techs recognize where they're going. Static Street View image keyed on the
// job's geocoded coords (falls back to the address string). The Maps key is
// fetched once from /api/config/google-maps-key (falling back to the build-time
// VITE var) and cached module-wide so every card reuses it. Tap → directions.
let _mapsKey: string | null = null;
let _mapsKeyPromise: Promise<string> | null = null;
function getMapsKey(): Promise<string> {
  if (_mapsKey != null) return Promise.resolve(_mapsKey);
  if (!_mapsKeyPromise) {
    _mapsKeyPromise = (async () => {
      let key = "";
      try { const r = await apiFetch("/config/google-maps-key"); if (r.ok) key = (await r.json())?.key ?? ""; } catch { /* fall through */ }
      if (!key) key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY ?? "";
      _mapsKey = key;
      return key;
    })();
  }
  return _mapsKeyPromise;
}
// Lazy-load the Google Maps JS SDK once (shared promise). Used to upgrade the
// static Street View thumbnail into an interactive, drag-to-look-around
// panorama when the tech taps it (HouseCall-Pro style). Maps JavaScript API is
// already enabled + allow-listed on the Phes key, so this needs no extra setup.
let _mapsJsPromise: Promise<any> | null = null;
function loadMapsJs(key: string): Promise<any> {
  const w = window as any;
  if (w.google?.maps) return Promise.resolve(w.google.maps);
  if (_mapsJsPromise) return _mapsJsPromise;
  _mapsJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
    s.async = true;
    s.defer = true;
    s.onload = () => (w.google?.maps ? resolve(w.google.maps) : reject(new Error("maps unavailable")));
    s.onerror = () => reject(new Error("maps script failed"));
    document.head.appendChild(s);
  });
  return _mapsJsPromise;
}

// Rendered on the job DETAIL screen only (not the My Jobs list cards) — see
// my-job-detail.tsx. Exported so the detail page can place it above the address.
// Shows a static Street View thumbnail; tapping it loads an interactive
// panorama the tech can pan around to recognize the property (HCP-style).
export function StreetViewThumb({ lat, lng, address, directionsUrl }: { lat: number | null; lng: number | null; address: string | null; directionsUrl: string | null }) {
  const [key, setKey] = useState<string | null>(_mapsKey);
  const [keyResolved, setKeyResolved] = useState<boolean>(_mapsKey != null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<"thumb" | "loading" | "live">("thumb");
  const panoRef = useRef<HTMLDivElement>(null);
  const builtRef = useRef(false);
  useEffect(() => {
    if (!keyResolved) getMapsKey().then(k => { setKey(k); setKeyResolved(true); });
  }, [keyResolved]);
  // When we flip to "live", the panorama container mounts; build the
  // interactive Street View on it (the SDK is already loaded by then).
  useEffect(() => {
    if (mode !== "live" || builtRef.current || !panoRef.current || lat == null || lng == null) return;
    const maps = (window as any).google?.maps;
    if (!maps) { setMode("thumb"); return; }
    try {
      new maps.StreetViewPanorama(panoRef.current, {
        position: { lat, lng },
        pov: { heading: 0, pitch: 0 },
        zoom: 0,
        addressControl: false,
        motionTracking: false,
        motionTrackingControl: false,
        showRoadLabels: false,
        fullscreenControl: true,
      });
      builtRef.current = true;
    } catch { setMode("thumb"); }
  }, [mode, lat, lng]);

  const loc = (lat != null && lng != null) ? `${lat},${lng}` : (address || "");
  if (!loc) return null; // nothing to point at — render nothing
  const canShowImg = keyResolved && !!key && !failed;
  const hasCoords = lat != null && lng != null;

  const lookAround = async () => {
    if (!key || !hasCoords || mode !== "thumb") return;
    setMode("loading");
    try { await loadMapsJs(key); setMode("live"); }
    catch { setMode("thumb"); }
  };

  // No key / denied image / no coords → tappable "Open in Maps" fallback tile.
  if (!canShowImg) {
    const tile = (
      <div style={{ width: "100%", height: 120, borderRadius: 10, border: "1px dashed #D9D5CC", background: "#F2F0EB", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5 }}>
        <MapPin size={20} color="#9E9B94" aria-hidden="true" />
        <span style={{ fontSize: 11, fontWeight: 700, color: "#6B6860" }}>{directionsUrl ? "Open in Maps" : "Map preview unavailable"}</span>
      </div>
    );
    return (
      <div style={{ margin: "10px 0 6px" }}>
        {directionsUrl ? <a href={directionsUrl} target="_blank" rel="noreferrer">{tile}</a> : tile}
      </div>
    );
  }

  // Live interactive panorama — the tech can drag to look around.
  if (mode === "live") {
    return (
      <div style={{ margin: "10px 0 6px" }}>
        <div ref={panoRef} style={{ width: "100%", height: 220, borderRadius: 10, border: "1px solid #EEECE7", overflow: "hidden" }} />
      </div>
    );
  }

  // Static thumbnail → tap to load the interactive view.
  return (
    <div style={{ margin: "10px 0 6px" }}>
      <button type="button" onClick={lookAround} disabled={!hasCoords || mode === "loading"}
        style={{ display: "block", width: "100%", padding: 0, border: "none", background: "none", cursor: hasCoords ? "pointer" : "default", position: "relative", borderRadius: 10 }}>
        <img src={`https://maps.googleapis.com/maps/api/streetview?size=640x240&location=${encodeURIComponent(loc)}&fov=80&pitch=8&key=${key}`}
          alt="Street view of the property" loading="lazy"
          onError={() => setFailed(true)}
          style={{ width: "100%", height: 120, objectFit: "cover", borderRadius: 10, border: "1px solid #EEECE7", display: "block" }} />
        <span style={{ position: "absolute", bottom: 6, left: 8, fontSize: 9, fontWeight: 700, color: "#fff", background: "rgba(10,14,26,0.72)", padding: "3px 7px", borderRadius: 5, letterSpacing: "0.02em" }}>
          {mode === "loading" ? "Loading…" : (hasCoords ? "STREET VIEW · Tap to look around" : "STREET VIEW")}
        </span>
      </button>
    </div>
  );
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

// Cadence labels come from the canonical map (lib/frequency-labels) so the
// tech view matches dispatch, quotes, and the booking widget. Unknown values
// title-case as a fallback.
const FREQUENCY_LABELS = CANONICAL_FREQUENCY_LABELS;
export function frequencyLabel(f: string | null | undefined): string | null {
  if (!f) return null;
  return FREQUENCY_LABELS[f] ?? f.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
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

// "3 Allowed Hours" / "3.5 Allowed Hours" / "1 Allowed Hour" — trailing .0
// dropped, singular when exactly one. Falls back to "Est." when the number is
// the stale estimated_hours stamp rather than the live allowed_hours budget.
function formatHoursLabel(hrs: number, allowed: boolean): string {
  const n = Number.isInteger(hrs) ? String(hrs) : hrs.toFixed(1).replace(/\.0$/, "");
  const unit = hrs === 1 ? "Hour" : "Hours";
  return `${n} ${allowed ? "Allowed" : "Est."} ${unit}`;
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

// [weather 2026-06-11] Current conditions for the tech's area, so they can
// dress/plan for the day. Uses Open-Meteo — free, no API key, CORS-enabled —
// so it needs zero Google/console setup. WMO weather_code → a Lucide icon
// (no emojis, per brand). Location = the tech's GPS, else the first job.
function weatherIconFor(code: number) {
  const p = { size: 14, "aria-hidden": true } as any;
  if (code === 0) return <Sun {...p} color="#E0A21B" />;
  if (code <= 2) return <CloudSun {...p} color="#6B6860" />;
  if (code === 3 || code === 45 || code === 48) return <Cloud {...p} color="#6B6860" />;
  if (code >= 51 && code <= 57) return <CloudDrizzle {...p} color="#3B7DD8" />;
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return <CloudRain {...p} color="#3B7DD8" />;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return <CloudSnow {...p} color="#5B9BD5" />;
  if (code >= 95) return <CloudLightning {...p} color="#7C5CCB" />;
  return <Cloud {...p} color="#6B6860" />;
}
function WeatherChip({ lat, lng }: { lat: number | null; lng: number | null }) {
  const [wx, setWx] = useState<{ temp: number; code: number } | null>(null);
  const rlat = lat == null ? null : Math.round(lat * 50) / 50;
  const rlng = lng == null ? null : Math.round(lng * 50) / 50;
  useEffect(() => {
    if (rlat == null || rlng == null) return;
    let cancelled = false;
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${rlat}&longitude=${rlng}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d?.current) setWx({ temp: Math.round(d.current.temperature_2m), code: d.current.weather_code }); })
      .catch(() => { /* weather is best-effort; never block the page */ });
    return () => { cancelled = true; };
  }, [rlat, rlng]);
  if (!wx) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12, fontWeight: 700, color: "#6B6860", flexShrink: 0 }}>
      {weatherIconFor(wx.code)} {wx.temp}&deg;
    </span>
  );
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
  assigned_user_id: number | null;
  frequency: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  sq_footage: number | null;
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

  // [multi-photo 2026-06-10] Juliana: "can't upload more than one photo at a
  // time." The picker is now `multiple`; we upload every selected file (one
  // request each — the endpoint takes one photo per POST), skipping any that
  // are oversized/invalid, and report how many landed.
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setUploading(true);
    let ok = 0, skipped = 0;
    try {
      for (const file of files) {
        if (file.size > 10 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) { skipped++; continue; }
        try {
          // [photos-r2 2026-06-24] Send the raw file as multipart (not base64
          // JSON). The server streams it to R2. Using a direct fetch because
          // apiFetch forces Content-Type: application/json — for FormData the
          // browser must set its own multipart boundary.
          const fd = new FormData();
          fd.append("photo", file);
          fd.append("photo_type", type);
          const token = useAuthStore.getState().token;
          const res = await fetch(`${BASE}/api/jobs/${jobId}/photos`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: fd,
          });
          if (!res.ok) { skipped++; continue; }
          ok++;
        } catch { skipped++; }
      }
      if (ok > 0) onUploaded();
      if (ok > 0) toast({ title: `${ok} ${type} photo${ok === 1 ? "" : "s"} added${skipped ? ` · ${skipped} skipped` : ""}` });
      else if (skipped > 0) toast({ variant: "destructive", title: "Couldn't add photos", description: "Too large or unsupported type (max 10MB; JPG/PNG/WebP)." });
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
        <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFile} />
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

// [tech-note-translate 2026-06-10] Notes are authored in English (the bridge
// from customer instructions to the cleaner). Spanish-first techs tap "Ver en
// español" to translate any note in place via /api/translate (Claude). The
// translation is cached on first tap; the toggle flips back to the English
// original. Used for both note tiers.
function TranslatableNote({ text, color, linkColor, fontSize, fontWeight }: { text: string; color: string; linkColor: string; fontSize: number; fontWeight: number }) {
  const [translated, setTranslated] = useState<string | null>(null);
  const [showTranslated, setShowTranslated] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const translate = async () => {
    if (translated) { setShowTranslated(true); return; }
    setBusy(true);
    try {
      const res = await apiFetch("/translate", { method: "POST", body: JSON.stringify({ text, target: "es" }) });
      const d = await res.json();
      if (!res.ok || !d.translated) throw new Error();
      setTranslated(d.translated);
      setShowTranslated(true);
    } catch {
      toast({ variant: "destructive", title: "No se pudo traducir", description: "Translation unavailable" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p style={{ fontSize, fontWeight, color, margin: 0, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
        {showTranslated && translated ? translated : text}
      </p>
      <button
        onClick={() => (showTranslated ? setShowTranslated(false) : translate())}
        disabled={busy}
        style={{ marginTop: 6, background: "none", border: "none", padding: 0, color: linkColor, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}
      >
        {busy ? "Traduciendo…" : showTranslated ? "View original (English)" : "Ver en español"}
      </button>
    </>
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
      const ts = new Date().toISOString();
      try {
        const res = await apiFetch("/timeclock/clock-in", {
          method: "POST",
          // In office "view-as" preview the API call carries the office user's
          // token; acting_for_user_id attributes the clock to the viewed tech.
          // client_clock_in_at = the real tap time (honored on offline replay).
          body: JSON.stringify({ job_id: job.id, lat, lng, accuracy, override_token, acting_for_user_id: actingForUserId ?? undefined, client_clock_in_at: ts }),
        });
        const data = await res.json();
        if (!res.ok) throw { status: res.status, ...data };
        return data;
      } catch (e) {
        // [offline-clock] No signal → save the punch locally with the real time
        // + GPS and sync when back online (don't lose it).
        if (isOfflineError(e)) {
          enqueueClock({ type: "in", job_id: job.id, ts, lat, lng, accuracy, acting_for_user_id: actingForUserId ?? null });
          return { queued: true };
        }
        throw e;
      }
    },
    onSuccess: (data: any) => {
      if (data?.queued) {
        toast({ title: "No signal — Clock In saved", description: "It'll sync automatically when you're back online." });
        return;
      }
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
      const ts = new Date().toISOString();
      try {
        const res = await apiFetch(`/timeclock/${entry!.id}/clock-out`, {
          method: "POST",
          // client_clock_out_at = the real tap time. This is the fix for the
          // "clock-out registered 30 min late at her house" bug — even when the
          // request only lands after signal returns, the captured on-site time wins.
          body: JSON.stringify({ lat, lng, client_clock_out_at: ts }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.error === "PHOTOS_REQUIRED") throw new Error("PHOTOS_REQUIRED");
          if (data.error === "GEOFENCE_BLOCKED") throw { ...data };
          throw new Error(data.message || "Clock out failed");
        }
        return data;
      } catch (e) {
        if (isOfflineError(e)) {
          enqueueClock({ type: "out", job_id: job.id, entry_id: entry!.id, ts, lat, lng });
          return { queued: true } as any;
        }
        throw e;
      }
    },
    onSuccess: (data: any) => {
      if (data?.queued) {
        toast({ title: "No signal — Clock Out saved", description: "It'll sync automatically when you're back online." });
        return;
      }
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
      if (actingForUserId != null) body.acting_for_user_id = actingForUserId;
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
      className={visual.glowActive ? "qleno-active-glow" : undefined}
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
        border: `4.5px solid ${visual.borderOverride || job.zone_color || "#E5E2DC"}`,
        borderRadius: 12, padding: 18, margin: "0 0 12px 0",
        position: "relative", overflow: "hidden",
        opacity: visual.bodyOpacity * (job.status === "cancelled" ? 1 : 1),
        filter: visual.desaturate ? "grayscale(1)" : "none",
        cursor: onOpenDetail ? "pointer" : undefined,
      }}>
      {/* No left active-stripe on this card: the active state already shows an
          EVEN orange border all the way around + the breathing glow, so the
          extra 4px left bar only made the outline look thicker on the left. */}
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
        {/* [card-cleanup 2026-06-18] The company/branch chip ("PHES") was noise
            on the tech card — they know where they work. Removed per Sal. */}
        {/* Zone chip — color dot + name so the tech knows which area they're
            headed to. A zoneless job is a data error (see zone-resolution rule). */}
        {job.zone_name && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#F4F3F0", color: "#1A1917", letterSpacing: "0.02em" }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: job.zone_color || "#9E9B94", display: "inline-block", flexShrink: 0 }} />
            {job.zone_name}
          </span>
        )}
        {/* Visit context + cadence (MaidCentral parity: "Every 2 Weeks").
            A first visit needs more care than a routine repeat. */}
        {job.visit_number === 1 ? (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#FEF3C7", color: "#92400E", letterSpacing: "0.02em" }}>First visit</span>
        ) : job.is_recurring ? (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#EEF2FF", color: "#3730A3", letterSpacing: "0.02em" }}>
            {frequencyLabel(job.frequency) ?? "Recurring"}{job.visit_number ? ` · Visit #${job.visit_number}` : ""}
          </span>
        ) : job.frequency === "on_demand" ? (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#F4F3F0", color: "#6B6860", letterSpacing: "0.02em" }}>One-Time</span>
        ) : null}
      </div>
      <p style={{ fontSize: 11, fontWeight: 600, color: "var(--brand)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px" }}>
        {formatServiceType(job.service_type)}
      </p>
      {(() => {
        // Allowed hours is the budget the tech needs; estimated_hours is the
        // stale creation stamp and only a fallback. New treatment: lead with the
        // "N Allowed Hours" budget chip, then the clean start–end window
        // (e.g. "9:00 AM – 12:00 PM") — same on every job, list and detail.
        // [labor-split 2026-06-17] allowed_hours is the TEAM-aggregated budget.
        // Divide by team size so each tech sees THEIR calendar time: a 6h job
        // with 2 techs is 3h on the clock for each, and the window ends at +3h.
        const teamCount = job.team_count && job.team_count > 1 ? job.team_count : 1;
        const rawHrs = job.allowed_hours ?? job.estimated_hours;
        const hrs = rawHrs != null ? rawHrs / teamCount : rawHrs;
        const allowed = job.allowed_hours != null;
        const hasHrs = hrs != null && hrs > 0;
        const start = job.scheduled_time ? formatTime(job.scheduled_time) : null;
        const end = job.scheduled_time && hasHrs ? addHoursToTime(job.scheduled_time, hrs!) : null;
        if (!hasHrs && !start) return null;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "0 0 6px" }}>
            {hasHrs && (
              <span style={{ fontSize: 12.5, fontWeight: 800, color: "#00936F", background: "#E7F9F3", border: "1px solid #BFEFE2", borderRadius: 8, padding: "3px 9px", whiteSpace: "nowrap" }}>
                {formatHoursLabel(hrs!, allowed)}
              </span>
            )}
            {start && (
              <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", whiteSpace: "nowrap" }}>
                {start}{end ? ` – ${end}` : ""}
              </span>
            )}
          </div>
        );
      })()}
      {/* Home facts (MC parity) — size the work before walking in. */}
      {(job.bedrooms != null || job.bathrooms != null || job.sq_footage != null) && (
        <p style={{ fontSize: 12, color: "#6B6860", margin: "2px 0 0", fontWeight: 600 }}>
          {[
            job.bedrooms != null ? `${job.bedrooms} bd` : null,
            job.bathrooms != null ? `${job.bathrooms} ba` : null,
            job.sq_footage != null ? `${job.sq_footage.toLocaleString("en-US")} sq ft` : null,
          ].filter(Boolean).join(" · ")}
        </p>
      )}
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

      {/* Two-tier notes — the bridge from customer instructions to the cleaner.
          TODAY'S notes (jobs.notes) are one-off for this visit ("today make 2
          beds") — loudest, first. EVERY-VISIT notes (clients.notes) are sticky
          per client ("dog and cat — treats in kitchen") and follow the client
          onto every job regardless of which tech goes. Distinct colors so the
          tech never confuses a one-off with a standing instruction. */}
      {job.job_notes && (
        <div style={{ backgroundColor: "#ECFDF8", border: "2px solid #00C9A0", borderRadius: 10, padding: "12px 14px", marginTop: 12 }}>
          <p style={{ fontSize: 11, fontWeight: 800, color: "#047857", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 5px" }}>
            Today's Job Notes — this visit only
          </p>
          <TranslatableNote text={job.job_notes} color="#065F46" linkColor="#047857" fontSize={14} fontWeight={600} />
        </div>
      )}

      {job.client_notes && (
        <div style={{ backgroundColor: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 10, padding: "12px 14px", marginTop: 10 }}>
          <p style={{ fontSize: 11, fontWeight: 800, color: "#3730A3", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 5px" }}>
            Client Notes — every visit
          </p>
          <TranslatableNote text={job.client_notes} color="#312E81" linkColor="#3730A3" fontSize={13} fontWeight={400} />
        </div>
      )}

      <AddNote jobId={job.id} onSaved={onRefresh} />

      {/* [quote-attachments] Files the office attached on the source quote.
          Read-only here — techs see photos/PDFs the client sent or the
          office screenshotted during the booking call. */}
      <OfficeAttachments jobId={job.id} />

      <PhotoGrid jobId={job.id} type="before" photos={photosBefore} onUploaded={loadPhotos} />
      <PhotoGrid jobId={job.id} type="after" photos={photosAfter} onUploaded={loadPhotos} />

      {/* [team-photo-notes] Pictures + notes for the team. Tech can attach to
          this job, or tick sticky to pin to the customer for every visit. */}
      <div style={{ marginTop: 12 }}>
        <TeamPhotoNotes
          jobId={job.id}
          jobAccountId={job.account_id ?? null}
          jobAccountPropertyId={job.account_property_id ?? null}
        />
      </div>

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
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [empPos, setEmpPos] = useState<{ lat: number; lng: number } | null>(null);
  const [showPay, setShowPay] = useState(false);

  // [tech-experience 2026-06-17] Account menu on the mobile My Jobs header —
  // the avatar is now tappable (was a dead circle) and carries Time Off,
  // Notification settings, Change Password, Sign Out, plus the tech's photo.
  const logout = useAuthStore(state => state.logout);
  const [acctOpen, setAcctOpen] = useState(false);
  const [changePwOpen, setChangePwOpen] = useState(false);
  const acctRef = useRef<HTMLDivElement>(null);
  const { data: meData } = useQuery({
    // JWT carries no avatar_url, so fetch it for the header photo.
    queryKey: ["my-jobs-me", token],
    queryFn: async () => { const r = await apiFetch("/auth/me"); return r.ok ? r.json() : null; },
    enabled: !!token,
    staleTime: 60_000,
  });
  const avatarUrl: string | null = meData?.avatar_url ?? null;
  useEffect(() => {
    if (!acctOpen) return;
    const handler = (e: MouseEvent) => {
      if (acctRef.current && !acctRef.current.contains(e.target as Node)) setAcctOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [acctOpen]);

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
  const dateInputRef = useRef<HTMLInputElement>(null);
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

  // [offline-clock 2026-06-11] Replay any punches saved while offline. Fires on
  // mount, whenever the browser fires 'online', and on a 20s heartbeat (covers
  // flaky signal that flips back without an 'online' event). When something
  // actually syncs, refetch so the card flips to its true clocked state, and
  // surface a confirmation toast.
  const [pendingSync, setPendingSync] = useState(queueLength());
  useEffect(() => {
    let cancelled = false;
    const flush = async () => {
      if (queueLength() === 0) { if (!cancelled) setPendingSync(0); return; }
      const { synced, remaining } = await flushClockQueue(token);
      if (cancelled) return;
      setPendingSync(remaining);
      if (synced > 0) {
        toast({ title: `${synced} punch${synced === 1 ? "" : "es"} synced`, description: "Your saved clock times are now recorded." });
        refetch();
      }
    };
    flush();
    const onOnline = () => flush();
    window.addEventListener("online", onOnline);
    const hb = setInterval(() => { setPendingSync(queueLength()); flush(); }, 20000);
    return () => { cancelled = true; window.removeEventListener("online", onOnline); clearInterval(hb); };
  }, [token]);

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

  // [day-banner 2026-06-11] Top-of-day summary for the selected day only.
  // Efficiency = Allowed ÷ Actual job hours (Qleno's one efficiency metric;
  // ≥100% = under budget = good), over jobs with a completed clock pair.
  // Quality = the day's average non-excluded visit scorecard (from the feed).
  const quality = (data?.quality as { avg: number; count: number } | null | undefined) ?? null;
  const nonCancelled = jobs.filter(j => j.status !== "cancelled");
  // Efficiency PER SERVICE TYPE (deep clean, MIMO, PPM, commercial, standard…),
  // then the MEDIAN across the types worked that day. Each tech performs
  // differently per package and allowed-hours budgets differ per package, so a
  // median keeps one slow type from skewing the day's score.
  const effByType = new Map<string, { allowed: number; actual: number }>();
  let totAllowed = 0, totActual = 0;
  for (const j of jobs) {
    const e = j.time_clock_entry;
    if (e?.clock_in_at && e?.clock_out_at && j.allowed_hours != null) {
      const actual = Math.max(0, (new Date(e.clock_out_at).getTime() - new Date(e.clock_in_at).getTime()) / 3600000);
      if (actual > 0) {
        const t = j.service_type || "other";
        const b = effByType.get(t) || { allowed: 0, actual: 0 };
        // [labor-split 2026-06-17] Compare the tech's actual clocked time to
        // THEIR share of the budget (allowed ÷ team size), not the full team
        // budget — otherwise a 2-tech job reads as ~200% efficient.
        const teamCount = j.team_count && j.team_count > 1 ? j.team_count : 1;
        const allowedPerTech = j.allowed_hours / teamCount;
        b.allowed += allowedPerTech; b.actual += actual; effByType.set(t, b);
        totAllowed += allowedPerTech; totActual += actual;
      }
    }
  }
  // Per-type efficiency %, then the median across types.
  const perTypeEff = [...effByType.values()].map(b => (b.allowed / b.actual) * 100).sort((a, b) => a - b);
  const effTypeCount = perTypeEff.length;
  const efficiencyPct = effTypeCount === 0 ? null : Math.round(
    effTypeCount % 2
      ? perTypeEff[(effTypeCount - 1) / 2]
      : (perTypeEff[effTypeCount / 2 - 1] + perTypeEff[effTypeCount / 2]) / 2
  );
  // Shift window — driven by the tenant's BUSINESS HOURS for the selected
  // weekday (e.g. "Mon–Fri 9:00 AM – 6:00 PM"). Falls back to the derived job
  // span (earliest start → latest finish) only when business hours aren't
  // configured for that day.
  let shiftStart: string | null = null, shiftEnd: string | null = null;
  const [sy, sm, sd] = selectedDate.split("-").map(Number);
  const selWeekday = new Date(sy, sm - 1, sd).getDay();
  const bizShift = shiftForWeekday(data?.business_hours as string | null | undefined, selWeekday);
  if (bizShift && bizShift !== "closed") {
    shiftStart = bizShift.start;
    shiftEnd = bizShift.end;
  } else if (bizShift !== "closed") {
    const timedJobs = nonCancelled.filter(j => j.scheduled_time);
    if (timedJobs.length) {
      const earliest = [...timedJobs].sort((a, b) => (a.scheduled_time! < b.scheduled_time! ? -1 : 1))[0];
      shiftStart = formatTime(earliest.scheduled_time);
      let maxEndMins = -1;
      for (const j of timedJobs) {
        const teamCount = j.team_count && j.team_count > 1 ? j.team_count : 1;
        const hrs = (j.allowed_hours ?? j.estimated_hours ?? 0) / teamCount;
        const [h, m] = j.scheduled_time!.split(":").map(Number);
        const endMins = (h || 0) * 60 + (m || 0) + Math.round(hrs * 60);
        if (endMins > maxEndMins) { maxEndMins = endMins; shiftEnd = addHoursToTime(j.scheduled_time!, hrs); }
      }
    }
  }
  // Weather location: the tech's GPS if granted, else the first job's coords.
  const wxLat = empPos?.lat ?? jobs[0]?.job_lat ?? jobs[0]?.lat ?? null;
  const wxLng = empPos?.lng ?? jobs[0]?.job_lng ?? jobs[0]?.lng ?? null;

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ maxWidth: 460, margin: "0 auto" }}>
        <div style={{
          position: "sticky", top: 0, zIndex: 10,
          backgroundColor: "#FFFFFF", borderBottom: "1px solid #E5E2DC",
          padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {/* Tapping the logo/title returns the tech to today's main screen. */}
            <button type="button" onClick={() => { setSelectedDate(todayYmd); setShowPay(false); }} aria-label="Back to today"
              style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", minWidth: 0 }}>
              <QlenoMark size={32} />
              <span style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", letterSpacing: "-0.01em" }}>My Jobs</span>
            </button>
            <WeatherChip lat={wxLat} lng={wxLng} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={() => setShowPay(p => !p)}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: showPay ? 'var(--brand)' : 'var(--brand-dim)', color: showPay ? '#fff' : 'var(--brand)', border: '1px solid rgba(0,201,160,0.2)', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              <DollarSign size={13}/> Pay
            </button>
            {/* wouter v3 <Link> renders its own <a>; style goes on Link to
                avoid a nested <a> inside <a> (invalid markup / hydration warning). */}
            <Link href="/training" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: '#FFFFFF', color: '#1A1917', border: '1px solid #E5E2DC', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'none' }}>
              <GraduationCap size={13}/> Training
            </Link>
            {/* [tech notifications 2026-06-25] Shared bell + inbox — same
                component as the office shell, fed by the per-user inbox. */}
            <NotificationBell />
            {/* Account menu — tap the avatar */}
            <div ref={acctRef} style={{ position: "relative" }}>
              <button onClick={() => setAcctOpen(o => !o)} aria-label="Account menu"
                style={{ display: "flex", alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", borderRadius: "50%" }}>
                {avatarUrl ? (
                  <img src={avatarUrl} alt={initials}
                    style={{ width: 30, height: 30, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: "1px solid #E5E2DC" }} />
                ) : (
                  <div title={initials} style={{ width: 30, height: 30, borderRadius: "50%", backgroundColor: "var(--brand-dim)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                    {initials}
                  </div>
                )}
              </button>
              {acctOpen && (
                <div style={{
                  position: "absolute", top: "calc(100% + 8px)", right: 0,
                  background: "#fff", borderRadius: 12, border: "1px solid #E5E2DC",
                  boxShadow: "0 12px 36px rgba(10,14,26,0.16)", minWidth: 210, zIndex: 300,
                  padding: 6, display: "flex", flexDirection: "column", gap: 2,
                }}>
                  <button onClick={() => { setAcctOpen(false); navigate("/leave"); }}
                    style={acctItemStyle}>
                    <Plane size={15} style={{ color: "#6B7280" }} /> Time Off
                  </button>
                  <button onClick={() => { setAcctOpen(false); navigate("/settings/notifications"); }}
                    style={acctItemStyle}>
                    <Bell size={15} style={{ color: "#6B7280" }} /> Notification settings
                  </button>
                  <button onClick={() => { setAcctOpen(false); setChangePwOpen(true); }}
                    style={acctItemStyle}>
                    <KeyRound size={15} style={{ color: "#6B7280" }} /> Change Password
                  </button>
                  <div style={{ height: 1, background: "#F0EDEA", margin: "2px 0" }} />
                  <button onClick={() => { setAcctOpen(false); logout(); }}
                    style={{ ...acctItemStyle, color: "#DC2626" }}>
                    <LogOut size={15} /> Sign Out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <ChangePasswordModal open={changePwOpen} onClose={() => setChangePwOpen(false)} />

        {/* Day navigation — page to other days; tap the date to jump back to today. */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", background: "#FFFFFF", borderBottom: "1px solid #E5E2DC",
        }}>
          <button type="button" onClick={() => shiftDay(-1)} aria-label="Previous day"
            style={{ width: 36, height: 36, borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#1A1917", fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1, fontFamily: "inherit" }}>
            ‹
          </button>
          {/* [day-calendar 2026-06-10] Tapping the date opens a calendar to
              jump to ANY day (matches the owner dispatch board), instead of
              only stepping with the arrows. A "Back to today" link returns. */}
          {/* [day-calendar tap-fix 2026-06-11] iOS Safari will NOT open the
              native date picker from a programmatic showPicker()/.click() on a
              hidden 1×1 input — that's why tapping the date did nothing for techs.
              Fix: overlay a full-size TRANSPARENT <input type="date"> directly
              over the visible label so the tech's tap lands on the real input and
              iOS opens its native calendar. "Back to today" sits below the
              overlay so it stays independently tappable. */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
            <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{isToday ? "Today" : selectedLabel}</span>
              <span style={{ fontSize: 11, color: "#9E9B94" }}>{isToday ? selectedLabel : "Tap to pick a day"}</span>
              <input ref={dateInputRef} type="date" value={selectedDate}
                onChange={e => { if (e.target.value) setSelectedDate(e.target.value); }}
                aria-label="Pick a date"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, border: "none", padding: 0, margin: 0, cursor: "pointer", WebkitAppearance: "none", appearance: "none", background: "transparent" }} />
            </div>
            {!isToday && (
              <button type="button" onClick={() => setSelectedDate(todayYmd)}
                style={{ background: "none", border: "none", color: "var(--brand, #00C9A0)", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: 0, marginTop: 1 }}>
                Back to today
              </button>
            )}
          </div>
          <button type="button" onClick={() => shiftDay(1)} aria-label="Next day"
            style={{ width: 36, height: 36, borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#1A1917", fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1, fontFamily: "inherit" }}>
            ›
          </button>
        </div>

        {/* [push-nudge 2026-06-25] One-time CTA to enable lock-screen job
            alerts; self-hides when already subscribed / dismissed. */}
        <PushNudge />

        {/* [day-banner 2026-06-11] Qleno-Night day summary: Efficiency + Quality
            for the selected day, with a job-completion progress bar. */}
        {jobs.length > 0 && (
          <div style={{ background: "#0A0E1A", padding: "14px 16px 15px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{isToday ? "Today" : selectedLabel}</span>
              {shiftStart && (
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "#9DEFD9" }}>
                  Shift {shiftStart}{shiftEnd ? ` – ${shiftEnd}` : ""}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 10, padding: "9px 11px" }}>
                <p style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#A7AAB5", margin: "0 0 3px" }}>Efficiency</p>
                <p style={{ fontSize: 21, fontWeight: 800, margin: 0, lineHeight: 1.05, color: efficiencyPct == null ? "#C9CCD6" : efficiencyPct >= 100 ? "#34E3B6" : efficiencyPct >= 85 ? "#FBBF55" : "#F87171" }}>
                  {efficiencyPct == null ? "—" : `${efficiencyPct}%`}
                </p>
                <p style={{ fontSize: 9.5, fontWeight: 600, color: "#C9CCD6", margin: "2px 0 0" }}>
                  {efficiencyPct == null
                    ? "after first clock-out"
                    : effTypeCount > 1
                      ? `median · ${effTypeCount} service types`
                      : `${totAllowed.toFixed(1)} allowed / ${totActual.toFixed(1)} actual`}
                </p>
              </div>
              <div style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 10, padding: "9px 11px" }}>
                <p style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#A7AAB5", margin: "0 0 3px" }}>Quality</p>
                <p style={{ fontSize: 21, fontWeight: 800, margin: 0, lineHeight: 1.05, color: quality ? "#FFD75E" : "#C9CCD6" }}>
                  {quality ? quality.avg.toFixed(1) : "—"}
                </p>
                <p style={{ fontSize: 9.5, fontWeight: 600, color: "#C9CCD6", margin: "2px 0 0" }}>
                  {quality ? `avg · ${quality.count} visit${quality.count === 1 ? "" : "s"}` : "awaiting ratings"}
                </p>
              </div>
            </div>
            <div style={{ marginTop: 11, height: 6, background: "rgba(255,255,255,0.10)", borderRadius: 4, overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${nonCancelled.length ? Math.round((completedToday.length / nonCancelled.length) * 100) : 0}%`, background: "#00C9A0" }} />
            </div>
            <p style={{ fontSize: 9.5, fontWeight: 600, color: "#9DA1AC", margin: "6px 0 0" }}>
              {completedToday.length} of {nonCancelled.length} job{nonCancelled.length === 1 ? "" : "s"} complete
            </p>
          </div>
        )}

        {pendingSync > 0 && (
          <div style={{ background: "#FEF3C7", borderBottom: "1px solid #FCD34D", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: "#D97706", flexShrink: 0, animation: "qleno-active-stripe-pulse 2s ease-in-out infinite" }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: "#92400E", flex: 1 }}>
              {pendingSync} clock punch{pendingSync === 1 ? "" : "es"} waiting to sync
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#B45309" }}>Saved on your phone</span>
          </div>
        )}

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
            // [empty-state 2026-06-21] The date nav + Pay button already live
            // in the sticky header above this block, so a no-jobs day is NOT a
            // dead end. Give the tech direct affordances here too — step to the
            // next day and jump to their pay — so they never feel stranded on
            // an empty screen (Sal's screenshot report).
            <div style={{ textAlign: "center", padding: "40px 16px" }}>
              <p style={{ fontSize: 16, fontWeight: 600, color: "#1A1917", margin: "0 0 6px" }}>{isToday ? "No jobs today" : `No jobs on ${selectedLabel}`}</p>
              <p style={{ fontSize: 13, color: "#9E9B94", margin: "0 0 18px", lineHeight: 1.5 }}>
                {isToday ? "Use the arrows up top to browse upcoming days, or check your pay below." : "Try another day with the arrows above, or contact your manager."}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 280, margin: "0 auto" }}>
                <button type="button" onClick={() => shiftDay(1)}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%", padding: "12px", borderRadius: 10, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#1A1917", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", minHeight: 44 }}>
                  Check the next day ›
                </button>
                <button type="button" onClick={() => { setShowPay(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%", padding: "12px", borderRadius: 10, border: "none", background: "var(--brand, #00C9A0)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", minHeight: 44 }}>
                  <DollarSign size={15} aria-hidden="true" /> View my pay
                </button>
              </div>
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
                      </div>
                      <p style={{ fontSize: 11, color: "var(--brand)", textTransform: "uppercase", fontWeight: 600, margin: "0 0 4px" }}>{formatServiceType(job.service_type)}</p>
                      {job.scheduled_time && <p style={{ fontSize: 12, color: "#6B6860", margin: 0 }}>{formatTime(job.scheduled_time)}</p>}
                      {job.address && <p style={{ fontSize: 12, color: "#6B6860", margin: "2px 0 0" }}>{formatAddress(job.address, job.city, job.state, job.zip)}</p>}
                      <DistanceBadge jobLat={job.job_lat} jobLng={job.job_lng} empPos={empPos} />
                    </div>
                  ))}
                </div>
              )}
              {/* [reopen-completed 2026-06-17] Completed jobs were dropped from
                  the list entirely once clocked out, so the tech could never get
                  back in to add before/after photos ("all the info disappears").
                  Keep them as tappable rows → the detail page's photo upload.
                  Tech name of past visits is hidden separately (no conflict). */}
              {completedToday.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <p style={{ fontSize: 11, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 10px 4px" }}>Completed Today</p>
                  {completedToday.map(job => {
                    const needsPhotos = (job.before_photo_count ?? 0) === 0 || (job.after_photo_count ?? 0) === 0;
                    return (
                      <div key={job.id} onClick={() => navigate(`/my-jobs/${job.id}?date=${selectedDate}`)}
                        style={{ backgroundColor: "#FFFFFF", border: `1px solid ${job.zone_color || "#E5E2DC"}`, borderLeft: `3px solid var(--brand, #2D9B83)`, borderRadius: 12, padding: 18, marginBottom: 10, cursor: "pointer" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                          <Check size={15} color="var(--brand, #2D9B83)" style={{ flexShrink: 0 }} />
                          <p style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", margin: 0 }}>{job.client_name}</p>
                        </div>
                        <p style={{ fontSize: 11, color: "var(--brand)", textTransform: "uppercase", fontWeight: 600, margin: "0 0 4px" }}>{formatServiceType(job.service_type)}</p>
                        {job.address && <p style={{ fontSize: 12, color: "#6B6860", margin: "2px 0 0" }}>{formatAddress(job.address, job.city, job.state, job.zip)}</p>}
                        <p style={{ fontSize: 12, fontWeight: 700, color: needsPhotos ? "#B45309" : "#2D9B83", margin: "8px 0 0", display: "flex", alignItems: "center", gap: 5 }}>
                          <Camera size={13} /> {needsPhotos ? "Tap to add before/after photos" : "Photos added — tap to review"}
                        </p>
                      </div>
                    );
                  })}
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
