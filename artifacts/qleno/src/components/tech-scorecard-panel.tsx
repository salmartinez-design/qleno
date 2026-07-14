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
interface Scorecard { score_pct: number | null; rating_count: number; entries: Entry[] }

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
              {sc && sc.rating_count > 0 ? `Your score · based on ${sc.rating_count} rating${sc.rating_count > 1 ? "s" : ""}` : "No ratings yet"}
            </div>
          </div>

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
