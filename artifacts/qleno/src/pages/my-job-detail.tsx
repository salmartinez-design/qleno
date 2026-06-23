import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { useEmployeeView } from "@/contexts/employee-view-context";
import { JobCard, StreetViewThumb, ymd, type Job } from "./my-jobs";
import { formatAddress, mapsDirectionsUrl } from "@/lib/format-address";
import { ArrowLeft, History } from "lucide-react";
import { QlenoMark } from "@/components/brand/QlenoMark";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function apiFetch(path: string, opts?: RequestInit) {
  const token = useAuthStore.getState().token;
  return fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts?.headers || {}) },
  });
}

function formatVisitDate(d: string) {
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function formatServiceType(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

type Visit = {
  id: number;
  scheduled_date: string;
  service_type: string;
  hours: string | null;
  techs: string | null;
  tech_notes: string | null;
};

// [job-detail 2026-06-10] Full-screen view of one job, opened by tapping its
// card on My Jobs. Renders the same interactive JobCard (clock, photos, notes —
// nothing forks) plus what the list can't show: the visit history at this
// client/property, including prior techs' notes.
export default function MyJobDetailPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/my-jobs/:id");
  const jobId = parseInt(params?.id ?? "0", 10);
  const dateParam = new URLSearchParams(window.location.search).get("date") || ymd(new Date());

  const { employeeView } = useEmployeeView();
  const [empPos, setEmpPos] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    const update = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => setEmpPos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => {},
        { enableHighAccuracy: true, timeout: 10000 }
      );
    };
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, []);

  // Same query key as the My Jobs list so navigation hits the cache and the
  // detail screen opens instantly; refetches keep both surfaces in sync.
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["my-jobs", employeeView?.employeeId, dateParam],
    queryFn: async () => {
      const p = new URLSearchParams({ date: dateParam });
      if (employeeView) p.set("employee_id", String(employeeView.employeeId));
      const res = await apiFetch(`/jobs/my-jobs?${p.toString()}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const jobs: Job[] = data?.data || [];
  const requireAfterPhoto: boolean = data?.require_after_photo_for_clockout ?? false;
  const job = jobs.find(j => j.id === jobId) || null;

  // prevJobId feeds the on-my-way event's from_job_id (the client-to-client
  // mileage leg) — derive it from the same active-jobs ordering as the list.
  const activeJobs = jobs.filter(j => j.status !== "cancelled" && (!j.time_clock_entry || !j.time_clock_entry.clock_out_at || j.status !== "complete"));
  const idx = activeJobs.findIndex(j => j.id === jobId);
  const prevJobId = idx > 0 ? activeJobs[idx - 1].id : null;

  const { data: historyData } = useQuery({
    queryKey: ["job-visit-history", jobId],
    queryFn: async () => {
      const res = await apiFetch(`/jobs/my-jobs/${jobId}/history`);
      return res.ok ? res.json() : { data: [] };
    },
    enabled: !!jobId,
  });
  const visits: Visit[] = historyData?.data ?? [];

  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("/my-jobs");
  };

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ maxWidth: 460, margin: "0 auto" }}>
        <div style={{
          position: "sticky", top: 0, zIndex: 10,
          backgroundColor: "#FFFFFF", borderBottom: "1px solid #E5E2DC",
          padding: "12px 16px", display: "flex", alignItems: "center", gap: 10,
        }}>
          <button onClick={goBack} aria-label="Back to My Jobs"
            style={{ width: 36, height: 36, borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#1A1917", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
            <ArrowLeft size={17} />
          </button>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {job ? job.client_name : "Job Details"}
            </p>
            <p style={{ fontSize: 11, color: "#9E9B94", margin: 0 }}>{formatVisitDate(dateParam)}</p>
          </div>
          {/* Tapping the logo returns to today's job list — the main screen. */}
          <button type="button" onClick={() => navigate("/my-jobs")} aria-label="Back to today's jobs"
            style={{ marginLeft: "auto", background: "none", border: "none", padding: 0, cursor: "pointer", flexShrink: 0, display: "inline-flex" }}>
            <QlenoMark size={26} />
          </button>
        </div>

        {employeeView && (
          <div style={{ background: "var(--brand, #00C9A0)", padding: "8px 16px" }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: "#fff", margin: 0 }}>Viewing as {employeeView.employeeName}</p>
          </div>
        )}

        <div style={{ padding: 16 }}>
          {isLoading ? (
            <p style={{ textAlign: "center", color: "#9E9B94", fontSize: 14, padding: "40px 0" }}>Loading…</p>
          ) : !job ? (
            <div style={{ textAlign: "center", padding: "48px 0" }}>
              <p style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", margin: "0 0 6px" }}>Job not found</p>
              <p style={{ fontSize: 13, color: "#9E9B94", margin: "0 0 16px" }}>It may have been moved to another day.</p>
              <button onClick={() => navigate("/my-jobs")}
                style={{ background: "#1A1917", color: "#fff", border: "none", borderRadius: 9, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                Back to My Jobs
              </button>
            </div>
          ) : (
            <>
              {/* [street-view 2026-06-11] Street View at the top of the detail
                  screen; tap to look around (HCP-style). The big Get Directions
                  button was removed — the underlined address link inside the
                  card is the one-tap route. */}
              {job.address && (
                <StreetViewThumb
                  lat={job.job_lat ?? job.lat}
                  lng={job.job_lng ?? job.lng}
                  address={formatAddress(job.address, job.city, job.state, job.zip)}
                  directionsUrl={mapsDirectionsUrl(formatAddress(job.address, job.city, job.state, job.zip)) ?? null}
                />
              )}
              <JobCard
                job={job}
                empPos={empPos}
                onRefresh={refetch}
                isPreviewMode={!!employeeView}
                actingForUserId={employeeView ? employeeView.employeeId : null}
                prevJobId={prevJobId}
                requireAfterPhoto={requireAfterPhoto}
              />

              {visits.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <p style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 10px 4px", fontWeight: 700 }}>
                    <History size={13} /> Previous Visits Here
                  </p>
                  {visits.map(v => (
                    <div key={v.id} style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "12px 14px", marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                        <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", margin: 0 }}>{formatVisitDate(v.scheduled_date)}</p>
                        {v.hours != null && Number(v.hours) > 0 && (
                          <span style={{ fontSize: 12, color: "#6B6860", fontWeight: 600, flexShrink: 0 }}>{Number(v.hours).toFixed(1)} hrs</span>
                        )}
                      </div>
                      {/* [no-prev-tech 2026-06-17] Deliberately do NOT show who
                          did past visits — Sal: avoid tech-vs-tech conflict over
                          "who left it dirty". Date + service type only. */}
                      <p style={{ fontSize: 12, color: "#6B6860", margin: "3px 0 0" }}>
                        {formatServiceType(v.service_type)}
                      </p>
                      {v.tech_notes && (
                        <div style={{ backgroundColor: "#F7F6F3", borderRadius: 8, padding: "8px 10px", marginTop: 8 }}>
                          <p style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 3px" }}>Tech Notes</p>
                          <p style={{ fontSize: 12, color: "#1A1917", margin: 0, lineHeight: 1.5 }}>{v.tech_notes}</p>
                        </div>
                      )}
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
