// [tech-scorecard 2026-07-14] The tech's own score, shown on the My Jobs home
// (Sal: techs tap the Quality tile → see their score + who left each rating).
// Just the score + rating history with client names + comments (positive AND
// negative). No job history here (Sal: not needed). Self-scoped server-side;
// threads employeeId so the office "Viewing as" preview follows the tech.
import { useQuery } from "@tanstack/react-query";
import { Star, MessageSquare } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const authHeaders = () => getAuthHeaders() as Record<string, string>;

const fmtDate = (d?: string | null) => {
  if (!d) return "";
  try { return new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return String(d).slice(0, 10); }
};
// Comments sometimes arrive prefixed "Text Response: 4 …" — strip the leading
// score echo so the tech reads the actual words.
const cleanComment = (n?: string | null) =>
  (n ?? "").replace(/^\s*text response:\s*\d+(\.\d+)?\s*[-–—]?\s*/i, "").trim();

interface Entry { id: number; entry_date: string; score_value: string | number; max_value: string | number; source: string; notes: string | null; job_id: number | null; client_name: string | null }
interface Weights { satisfaction: number; attendance: number; complaint_free: number }
interface Counts { survey_responses: number; scheduled_days: number; attendance_violations: number; valid_complaints: number; completed_jobs: number }
interface Scorecard {
  score_pct: number | null; rating_count: number; entries: Entry[];
  satisfaction: number | null; attendance: number | null; complaint_free: number | null;
  weights: Weights | null; counts: Counts | null;
}

const pctText = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)}%`);

export function TechScorecardPanel({ employeeId }: { employeeId?: number }) {
  const qs = employeeId ? `?employee_id=${employeeId}` : "";

  const scoreQ = useQuery<Scorecard | null>({
    queryKey: ["tech-scorecard", employeeId ?? "self"],
    queryFn: async () => { const r = await fetch(`${API}/api/tech/scorecard${qs}`, { headers: authHeaders() }); return r.ok ? r.json() : null; },
    staleTime: 60_000,
  });

  const sc = scoreQ.data;
  const pct = sc?.score_pct;

  return (
    <div style={{ fontFamily: FF }}>
      {scoreQ.isLoading ? (
        <div style={{ textAlign: "center", padding: 30, color: "#9E9B94", fontSize: 13 }}>Loading…</div>
      ) : (
        <div>
          {/* Headline score */}
          <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 18, marginBottom: 16, textAlign: "center" }}>
            <div style={{ fontSize: 40, fontWeight: 800, color: pct == null ? "#C9CCD6" : pct >= 90 ? "#0F9D77" : pct >= 75 ? "#B7791F" : "#B91C1C", lineHeight: 1 }}>
              {pct == null ? "—" : `${Math.round(pct)}%`}
            </div>
            <div style={{ fontSize: 12.5, color: "#9E9B94", marginTop: 6 }}>
              Your score · rolling, trailing 90 days
            </div>
          </div>

          {/* [tech-scorecard-breakdown 2026-07-14] Same three components the office
              Performance Score tab shows (Sal: "it has to be broken down"). */}
          {sc && (sc.satisfaction != null || sc.attendance != null || sc.complaint_free != null) && (
            <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "6px 14px 8px", marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: "#9E9B94", padding: "12px 0 4px" }}>Score breakdown · trailing 90 days</div>
              {[
                { label: "Customer satisfaction", v: sc.satisfaction, w: sc.weights?.satisfaction, sub: sc.counts ? `${sc.counts.survey_responses} survey${sc.counts.survey_responses === 1 ? "" : "s"}` : "" },
                { label: "Attendance", v: sc.attendance, w: sc.weights?.attendance, sub: sc.counts ? `${sc.counts.attendance_violations} issue${sc.counts.attendance_violations === 1 ? "" : "s"} · ${sc.counts.scheduled_days} days` : "" },
                { label: "Complaint-free", v: sc.complaint_free, w: sc.weights?.complaint_free, sub: sc.counts ? `${sc.counts.valid_complaints} complaint${sc.counts.valid_complaints === 1 ? "" : "s"} · ${sc.counts.completed_jobs} jobs` : "" },
              ].map((row, i) => (
                <div key={row.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 0", borderTop: i ? "1px solid #F0EEE9" : "none" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{row.label}</div>
                    <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>{row.w != null ? `${row.w}% weight` : ""}{row.sub ? `${row.w != null ? " · " : ""}${row.sub}` : ""}</div>
                  </div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: row.v == null ? "#C9CCD6" : "#1A1917", flexShrink: 0 }}>{pctText(row.v)}</div>
                </div>
              ))}
            </div>
          )}

          {/* Rating history — who left it + the comment, positive and negative */}
          {sc && sc.entries.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sc.entries.map(e => {
                const comment = cleanComment(e.notes);
                return (
                  <div key={e.id} style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 11, padding: "11px 13px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 14, fontWeight: 800, color: "#1A1917" }}>
                        <Star size={14} style={{ color: "#F5B301", fill: "#F5B301" }} />
                        {Number(e.score_value).toFixed(1)} / {Number(e.max_value).toFixed(0)}
                      </span>
                      <span style={{ fontSize: 11.5, color: "#9E9B94" }}>{fmtDate(e.entry_date)}</span>
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "#1A1917", marginTop: 4 }}>
                      {e.client_name || "Client"}
                    </div>
                    {comment && <div style={{ fontSize: 13, color: "#44413B", marginTop: 5, lineHeight: 1.45 }}>{comment}</div>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "26px 16px", color: "#9E9B94", fontSize: 13, border: "1px dashed #E5E2DC", borderRadius: 12, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <MessageSquare size={20} style={{ color: "#C9C4BA" }} />
              No customer ratings yet. They show up here after clients rate your visits.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
