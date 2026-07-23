// [account-activity 2026-07-07] Shared chronological audit feed — every
// recorded action (job created/edited/rescheduled/cancelled/deleted, price
// changes, client/account edits, messages) with who + when. Extracted from the
// client profile's ActivityTab so the ACCOUNT console can mount the identical
// feed (Maribel: "Accounts do not have a communications log, or activity
// log"). The endpoint decides the scope; this component only renders.
//
// Timestamps: the API returns explicit-UTC ISO strings; render pinned to
// America/Chicago (single-market tenant) so the office never sees the raw UTC
// wall clock (the "cancelled at 12:08 PM" that actually happened at 7:08 AM).
//
// Job tags: when the event carries related_job_id + related_job_date it links
// to the dispatch board deep-link (/dispatch?date=…&job=…) so the office can
// open the actual job card from the feed ("Can't see the job card from here").
import { useQuery } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF2 = "'Plus Jakarta Sans', sans-serif";

export function ActivityFeed({ endpoint, queryKey, introText }: {
  endpoint: string;
  queryKey: (string | number)[];
  introText: string;
}) {
  const { data, isLoading } = useQuery<any>({
    queryKey,
    queryFn: async () => {
      const r = await fetch(`${API}${endpoint}`, { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });
  const events: any[] = data?.events || [];
  const fmtWhen = (s: string) => (s ? new Date(s).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  const META: Record<string, { label: string; color: string; bg: string }> = {
    job_created:     { label: "Job created",    color: "#0A6E5A", bg: "#E6F8F2" },
    job_edit:        { label: "Job edited",     color: "#2F3646", bg: "#EAF0FE" },
    job_rescheduled: { label: "Rescheduled",    color: "#B45309", bg: "#FDF3E4" },
    job_cancelled:   { label: "Cancelled",      color: "#B3261E", bg: "#FEECEC" },
    service_ended:   { label: "Service ended",  color: "#7F1D1D", bg: "#FBD9D9" },
    job_deleted:     { label: "Deleted",        color: "#7C2D12", bg: "#FBE8E0" },
    client_edit:     { label: "Client edited",  color: "#9C4E2B", bg: "#F1ECFD" },
    client_created:  { label: "Client created", color: "#0A6E5A", bg: "#E6F8F2" },
    account_edit:    { label: "Account edited", color: "#9C4E2B", bg: "#F1ECFD" },
    invoice:         { label: "Invoice",        color: "#0E7490", bg: "#E0F5FA" },
    communication:   { label: "Message",        color: "#1A1917", bg: "#F0EEE9" },
  };
  const label = (f: string | null) => (f ? f.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "");
  const isNum = (v: any) => v != null && v !== "" && Number.isFinite(Number(v));
  const money = (v: any) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const truthy = (v: any) => v === true || v === "true";
  const time12 = (t: any) => {
    const m = String(t).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return String(t);
    const h = parseInt(m[1], 10); const ap = h < 12 ? "AM" : "PM";
    return `${((h + 11) % 12) + 1}:${m[2]} ${ap}`;
  };
  // A readable scalar; objects/arrays/empties we can't summarize → null (caller
  // falls back to a generic phrase rather than printing JSON).
  const valText = (v: any): string | null => {
    if (v == null || v === "") return null;
    if (typeof v === "object") return null;
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "string" && /unknown — see/i.test(v)) return null;
    return String(v);
  };
  const describeEdit = (e: any): string => {
    const nv = e.new_value ?? {}, ov = e.old_value ?? {};
    const f = e.field_name as string;
    const n = (nv && typeof nv === "object" && "value" in nv) ? (nv as any).value : nv;
    const o = (ov && typeof ov === "object" && "value" in ov) ? (ov as any).value : ov;
    switch (f) {
      case "cascade_summary": {
        const upd = Number(nv?.future_jobs_updated ?? 0), ins = Number(nv?.future_jobs_inserted ?? 0), del = Number(nv?.future_jobs_deleted ?? 0);
        const parts: string[] = [];
        if (upd) parts.push(`${upd} future visit${upd === 1 ? "" : "s"} updated`);
        if (ins) parts.push(`${ins} added`);
        if (del) parts.push(`${del} removed`);
        return parts.length ? `Recurring schedule changed — ${parts.join(", ")}` : "Recurring schedule changed";
      }
      case "base_fee":      return `Price changed${isNum(o) ? ` from ${money(o)}` : ""} to ${money(n)}`;
      case "billed_amount": return `Billed amount changed${isNum(o) ? ` from ${money(o)}` : ""} to ${money(n)}`;
      case "hourly_rate":   return `Hourly rate set to ${money(n)}/hr`;
      case "allowed_hours": return `Allowed hours set to ${n}`;
      case "scheduled_time": return `Start time changed to ${time12(n)}`;
      case "scheduled_date": return `Date changed to ${n}`;
      case "manual_rate_override": return `Manual price override turned ${truthy(n) ? "on" : "off"}`;
      case "team_user_ids": return "Team reassigned";
      case "add_ons":       return "Add-ons updated";
      case "service_type":  return `Service changed to ${label(String(n))}`;
      case "notes": case "office_notes": return "Notes updated";
      case "auto_scheduled": {
        // [system-schedule-log 2026-07-21] Qleno's recurrence engine created this
        // visit (and maybe auto-assigned a tech). Lets the office catch auto-
        // scheduling / rebooking (Maribel's ask). Actor renders as "Qleno".
        const who = (nv && typeof nv === "object" && nv.tech_name) ? String(nv.tech_name) : null;
        return who ? `Qleno scheduled this visit and assigned ${who}` : "Qleno scheduled this visit";
      }
      default: {
        const nt = valText(n), ot = valText(o);
        if (nt) return `${label(f)} changed${ot ? ` from ${ot}` : ""} to ${nt}`;
        return `${label(f)} updated`;
      }
    }
  };
  const describe = (e: any): string => {
    const nv = e.new_value || {}, ov = e.old_value || {};
    switch (e.event_type) {
      case "job_edit":        return describeEdit(e);
      case "job_rescheduled": return `Rescheduled${nv.reason ? ` — ${nv.reason}` : ""}`;
      case "job_cancelled":   return `Cancelled${nv.reason ? ` — ${String(nv.reason).replace(/_/g, " ")}` : ""}${nv.charge != null ? ` · fee ${money(nv.charge)}` : ""}`;
      case "service_ended":   return `Service ended — all future visits cancelled, recurring schedule deactivated${nv.notes ? ` · ${nv.notes}` : ""}`;
      case "job_deleted":     return `Job deleted${ov.service_type ? ` · ${label(ov.service_type)}` : ""}${ov.scheduled_date ? ` · ${ov.scheduled_date}` : ""}`;
      case "communication":   return `${nv.delivery_status === "suppressed" ? "Suppressed" : nv.direction === "inbound" ? "Received" : "Sent"} ${e.field_name || "message"}${nv.summary ? ` — ${nv.summary}` : nv.subject ? ` — ${nv.subject}` : ""}`;
      case "invoice":         return `${nv.summary || "Invoice event"}${nv.amount != null ? ` · ${money(nv.amount)}` : ""}`;
      case "client_edit":     { const nt = valText(nv?.value ?? nv); return nt ? `${label(e.field_name)} changed to ${nt}` : `${label(e.field_name)} updated`; }
      case "account_edit":    { const nt = valText(nv?.value ?? nv); return nt ? `${label(e.field_name)} changed to ${nt}` : `${label(e.field_name)} updated`; }
      case "job_created":     return "Job created";
      case "client_created":  return "Client created";
      default:                return label(e.field_name) || "Updated";
    }
  };
  return (
    <div>
      <div style={{ fontSize: 13, color: "#6B6860", marginBottom: 14, fontFamily: FF2 }}>{introText}</div>
      {isLoading ? (
        <div style={{ padding: 30, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>Loading…</div>
      ) : events.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>No recorded activity yet.</div>
      ) : (
        <div>
          {events.map((e, i) => {
            const m = META[e.event_type] || { label: e.event_type, color: "#1A1917", bg: "#F0EEE9" };
            return (
              <div key={i} style={{ display: "flex", gap: 12, padding: "12px 2px", borderTop: i === 0 ? "none" : "1px solid #F0EEE9" }}>
                <span style={{ flexShrink: 0, alignSelf: "flex-start", fontSize: 11, fontWeight: 700, color: m.color, background: m.bg, borderRadius: 6, padding: "3px 9px", fontFamily: FF2, whiteSpace: "nowrap" }}>{m.label}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, color: "#1A1917", fontFamily: FF2, wordBreak: "break-word" }}>{describe(e)}</div>
                  <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2, fontFamily: FF2 }}>
                    {fmtWhen(e.occurred_at)}{e.user_name ? ` · ${e.user_name}` : ""}
                    {e.related_job_id ? (
                      <>
                        {" · "}
                        {e.related_job_date ? (
                          <a href={`/dispatch?date=${e.related_job_date}&job=${e.related_job_id}`} style={{ color: "#00A886", fontWeight: 600, textDecoration: "none" }}>Job #{e.related_job_id}</a>
                        ) : (
                          <>Job #{e.related_job_id}</>
                        )}
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
