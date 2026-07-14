// [tech-scorecard 2026-07-14] The tech's own scorecard + job history, shown on
// the My Jobs home (Sal: techs must see their scorecard and job history on the
// main screen). Two tabs: "My Score" (headline score + every rating with its
// customer comment, positive AND negative) and "Job History" (past completed
// jobs). Self-scoped server-side; threads employeeId so the office "Viewing as"
// preview follows the impersonated tech.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Star, MessageSquare } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const authHeaders = () => getAuthHeaders() as Record<string, string>;

const SERVICE_LABELS: Record<string, string> = {
  standard_clean: "Standard Clean", deep_clean: "Deep Clean", move_out: "Move Out",
  move_in: "Move In", recurring: "Recurring", post_construction: "Post-Construction",
  office_cleaning: "Office Cleaning", common_areas: "Common Areas", commercial_cleaning: "Commercial Cleaning",
};
const svcLabel = (s?: string | null) =>
  s ? (SERVICE_LABELS[s] || s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())) : "Cleaning";
const fmtDate = (d?: string | null) => {
  if (!d) return "";
  try { return new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return String(d).slice(0, 10); }
};
const money = (v: any) => `$${(parseFloat(String(v ?? 0)) || 0).toFixed(2)}`;
// Comments sometimes arrive prefixed "Text Response: 4 …" — strip the leading
// score echo so the tech reads the actual words.
const cleanComment = (n?: string | null) =>
  (n ?? "").replace(/^\s*text response:\s*\d+(\.\d+)?\s*[-–—]?\s*/i, "").trim();

interface Entry { id: number; entry_date: string; score_value: string | number; max_value: string | number; source: string; notes: string | null; job_id: number | null }
interface Scorecard { score_pct: number | null; rating_count: number; entries: Entry[] }
interface HistJob { id: number; scheduled_date: string; service_type: string; base_fee: string | number; client_name: string | null; rating: number | null }

export function TechScorecardPanel({ employeeId }: { employeeId?: number }) {
  const [tab, setTab] = useState<"score" | "history">("score");
  const qs = employeeId ? `?employee_id=${employeeId}` : "";

  const scoreQ = useQuery<Scorecard | null>({
    queryKey: ["tech-scorecard", employeeId ?? "self"],
    queryFn: async () => { const r = await fetch(`${API}/api/tech/scorecard${qs}`, { headers: authHeaders() }); return r.ok ? r.json() : null; },
    staleTime: 60_000,
  });
  const histQ = useQuery<{ jobs: HistJob[]; has_more: boolean } | null>({
    queryKey: ["tech-job-history", employeeId ?? "self"],
    queryFn: async () => { const r = await fetch(`${API}/api/tech/job-history?limit=50${employeeId ? `&employee_id=${employeeId}` : ""}`, { headers: authHeaders() }); return r.ok ? r.json() : null; },
    enabled: tab === "history",
    staleTime: 60_000,
  });

  const sc = scoreQ.data;
  const pct = sc?.score_pct;

  const seg = (key: "score" | "history", label: string) => (
    <button
      onClick={() => setTab(key)}
      style={{
        flex: 1, padding: "9px 8px", borderRadius: 9, border: "none", cursor: "pointer", fontFamily: FF,
        fontSize: 13, fontWeight: 700,
        background: tab === key ? "#FFFFFF" : "transparent",
        color: tab === key ? "#0A0E1A" : "#6B7280",
        boxShadow: tab === key ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
      }}
    >{label}</button>
  );

  return (
    <div style={{ fontFamily: FF }}>
      {/* Segmented control */}
      <div style={{ display: "flex", gap: 4, background: "#EFEDE8", borderRadius: 11, padding: 4, marginBottom: 16 }}>
        {seg("score", "My Score")}
        {seg("history", "Job History")}
      </div>

      {tab === "score" ? (
        scoreQ.isLoading ? (
          <div style={{ textAlign: "center", padding: 30, color: "#9E9B94", fontSize: 13 }}>Loading…</div>
        ) : (
          <div>
            {/* Headline score */}
            <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 18, marginBottom: 16, textAlign: "center" }}>
              <div style={{ fontSize: 40, fontWeight: 800, color: pct == null ? "#C9CCD6" : pct >= 90 ? "#0F9D77" : pct >= 75 ? "#B7791F" : "#B91C1C", lineHeight: 1 }}>
                {pct == null ? "—" : `${Math.round(pct)}%`}
              </div>
              <div style={{ fontSize: 12.5, color: "#9E9B94", marginTop: 6 }}>
                {sc && sc.rating_count > 0 ? `Your score · based on ${sc.rating_count} rating${sc.rating_count > 1 ? "s" : ""}` : "No ratings yet"}
              </div>
            </div>

            {/* Rating history — all comments, positive and negative */}
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
                      {comment && <div style={{ fontSize: 13, color: "#44413B", marginTop: 7, lineHeight: 1.45 }}>{comment}</div>}
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
        )
      ) : (
        histQ.isLoading ? (
          <div style={{ textAlign: "center", padding: 30, color: "#9E9B94", fontSize: 13 }}>Loading…</div>
        ) : histQ.data && histQ.data.jobs.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {histQ.data.jobs.map(j => (
              <div key={j.id} style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 11, padding: "11px 13px", display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "#1A1917", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{j.client_name || "Client"}</div>
                  <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 2 }}>{fmtDate(j.scheduled_date)} · {svcLabel(j.service_type)}</div>
                </div>
                {j.rating != null && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 700, color: "#1A1917", flexShrink: 0 }}>
                    <Star size={12} style={{ color: "#F5B301", fill: "#F5B301" }} />{Number(j.rating).toFixed(1)}
                  </span>
                )}
                <span style={{ fontSize: 13, fontWeight: 700, color: "#0F9D77", flexShrink: 0 }}>{money(j.base_fee)}</span>
              </div>
            ))}
            {histQ.data.has_more && (
              <div style={{ textAlign: "center", fontSize: 12, color: "#9E9B94", padding: "8px 0" }}>Showing your 50 most recent jobs.</div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "26px 16px", color: "#9E9B94", fontSize: 13, border: "1px dashed #E5E2DC", borderRadius: 12 }}>
            No completed jobs yet.
          </div>
        )
      )}
    </div>
  );
}
