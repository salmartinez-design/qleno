// [portal-request-service 2026-08-20] The office queue for customer service
// requests. The other end of the "Request service" screen in the customer
// portal.
//
// The API for this shipped on 2026-08-07 and had ZERO callers. A customer could
// ask for an extra clean, the row landed in portal_service_requests, and nobody
// in the office ever saw it: the request went into the database and stopped.
// This page is the missing half.
//
// It deliberately does NOT book the job. Booking means a price, a cleaner, a
// slot and a rate card, and that already lives in the job and quote flow. The
// office answers a request by creating the work the normal way and then coming
// back here to say which job answered it, or by declining with a reason the
// customer can read in their portal. A request that just goes quiet is worse
// than a no.
import { useState, useEffect, useCallback } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Link } from "wouter";
import { Loader2, Inbox, Building2, User, CalendarDays, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Req = {
  id: number;
  customer: string;
  kind: "commercial" | "residential";
  account_id: number | null;
  client_id: number | null;
  client_phone: string | null;
  building: string | null;
  service: string;
  preferred_date: string | null;
  notes: string | null;
  status: "pending" | "scheduled" | "declined";
  office_note: string | null;
  resulting_job_id: number | null;
  requested_by: string | null;
  created_at: string;
};

const TABS: Array<{ k: Req["status"]; label: string }> = [
  { k: "pending", label: "Waiting on us" },
  { k: "scheduled", label: "Booked" },
  { k: "declined", label: "Declined" },
];

const card: React.CSSProperties = {
  background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "18px 20px",
};
const label: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.07em",
};
const input: React.CSSProperties = {
  border: "1px solid #E5E2DC", borderRadius: 7, padding: "8px 11px", fontSize: 13,
  fontFamily: "inherit", background: "#FFFFFF", color: "#1A1917", outline: "none", width: "100%",
};

/** A calendar day from the API is a day, not an instant. Parse it at local noon
 *  so no time zone can shift it onto the day before. */
const dayOf = (ymd: string) => new Date(ymd + "T12:00:00");
const longDate = (ymd: string) =>
  dayOf(ymd).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default function ServiceRequestsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Req["status"]>("pending");
  const [rows, setRows] = useState<Req[] | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [jobId, setJobId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (status: Req["status"]) => {
    setRows(null);
    try {
      const r = await fetch(`${API}/api/service-requests?status=${status}`, { headers: getAuthHeaders() as HeadersInit });
      setRows(r.ok ? await r.json() : []);
    } catch { setRows([]); }
  }, []);

  const loadCount = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/service-requests/count`, { headers: getAuthHeaders() as HeadersInit });
      if (r.ok) setPendingCount((await r.json()).pending ?? 0);
    } catch { /* a badge is not worth a toast */ }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);
  useEffect(() => { loadCount(); }, [loadCount]);

  function openPanel(id: number) {
    setOpenId(openId === id ? null : id);
    setJobId(""); setNote("");
  }

  async function decide(req: Req, status: "scheduled" | "declined") {
    if (status === "declined" && !note.trim()) {
      toast({ title: "Add a reason", description: "The customer reads this note in their portal, so it should say why.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/service-requests/${req.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() } as HeadersInit,
        body: JSON.stringify({ status, job_id: jobId.trim() || undefined, office_note: note.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast({ title: "Could not save", description: d.message || "Please try again.", variant: "destructive" });
        return;
      }
      toast({ title: status === "scheduled" ? "Marked as booked" : "Request declined" });
      setOpenId(null);
      load(tab); loadCount();
    } finally { setSaving(false); }
  }

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#1A1917" }}>Service Requests</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B6860" }}>
            Extra work customers have asked for from their portal. Book it the normal way, then come back and say which job answered it.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          {TABS.map(t => (
            <button key={t.k} onClick={() => setTab(t.k)}
              style={{
                padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
                fontFamily: "inherit", display: "flex", alignItems: "center", gap: 7,
                border: tab === t.k ? "1px solid transparent" : "1px solid #E5E2DC",
                background: tab === t.k ? "var(--brand)" : "#FFFFFF",
                color: tab === t.k ? "#FFFFFF" : "#6B6860",
              }}>
              {t.label}
              {t.k === "pending" && pendingCount > 0 && (
                <span style={{
                  background: tab === t.k ? "rgba(255,255,255,0.25)" : "#FDF3E4",
                  color: tab === t.k ? "#FFFFFF" : "#8A5A00",
                  borderRadius: 999, padding: "1px 7px", fontSize: 11, fontWeight: 700,
                }}>{pendingCount}</span>
              )}
            </button>
          ))}
        </div>

        {rows === null ? (
          <div style={{ ...card, display: "flex", alignItems: "center", gap: 10, color: "#9E9B94", fontSize: 13 }}>
            <Loader2 size={15} className="animate-spin" /> Loading requests…
          </div>
        ) : rows.length === 0 ? (
          <div style={{ ...card, textAlign: "center", padding: "44px 20px" }}>
            <Inbox size={26} style={{ color: "#D6D2CA" }} />
            <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "#6B6860" }}>
              {tab === "pending" ? "Nothing waiting. Every request has been answered." : "Nothing here yet."}
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {rows.map(r => {
              // Link through to whichever profile the request actually came
              // from. A residential request has no account, and an account
              // request has no client, so never guess.
              const href = r.account_id ? `/accounts/${r.account_id}` : r.client_id ? `/customers/${r.client_id}` : null;
              return (
                <div key={r.id} style={card}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {r.kind === "commercial"
                          ? <Building2 size={14} style={{ color: "#6B6860" }} />
                          : <User size={14} style={{ color: "#6B6860" }} />}
                        {href
                          ? <Link href={href} style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", textDecoration: "none" }}>{r.customer}</Link>
                          : <span style={{ fontSize: 15, fontWeight: 700, color: "#1A1917" }}>{r.customer}</span>}
                        {r.building && <span style={{ fontSize: 12.5, color: "#6B6860" }}>· {r.building}</span>}
                      </div>
                      <div style={{ marginTop: 3, fontSize: 11.5, color: "#9E9B94" }}>
                        Asked {ago(r.created_at)}
                        {r.requested_by ? ` by ${r.requested_by}` : ""}
                        {r.client_phone ? ` · ${r.client_phone}` : ""}
                      </div>
                    </div>
                    {r.preferred_date && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#1A1917", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: "6px 10px" }}>
                        <CalendarDays size={13} style={{ color: "#6B6860" }} />
                        Hoping for {longDate(r.preferred_date)}
                      </div>
                    )}
                  </div>

                  <p style={{ margin: "12px 0 0", fontSize: 14, color: "#1A1917", lineHeight: 1.5 }}>{r.service}</p>
                  {r.notes && (
                    <p style={{ margin: "8px 0 0", fontSize: 13, color: "#6B6860", lineHeight: 1.5, borderLeft: "3px solid #F0EEE9", paddingLeft: 10 }}>
                      {r.notes}
                    </p>
                  )}

                  {r.status !== "pending" && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #F0EEE9", fontSize: 12.5, color: "#6B6860" }}>
                      {r.status === "scheduled" ? "Booked" : "Declined"}
                      {r.resulting_job_id && (
                        <>
                          {" as "}
                          <Link href={`/jobs?job=${r.resulting_job_id}`} style={{ color: "var(--brand)", fontWeight: 600, textDecoration: "none" }}>
                            job #{r.resulting_job_id} <ExternalLink size={11} style={{ display: "inline", verticalAlign: "-1px" }} />
                          </Link>
                        </>
                      )}
                      {r.office_note && <div style={{ marginTop: 6, color: "#1A1917" }}>What the customer was told: {r.office_note}</div>}
                    </div>
                  )}

                  {r.status === "pending" && (
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #F0EEE9" }}>
                      {openId !== r.id ? (
                        <button onClick={() => openPanel(r.id)}
                          style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#1A1917", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                          Answer this
                        </button>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <div>
                            <div style={{ ...label, marginBottom: 5 }}>Job number, if you booked it</div>
                            <input value={jobId} onChange={e => setJobId(e.target.value)} placeholder="Leave blank if you have not booked it yet"
                              style={{ ...input, maxWidth: 380 }} />
                          </div>
                          <div>
                            <div style={{ ...label, marginBottom: 5 }}>Note to the customer</div>
                            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                              placeholder="They read this in their portal. Required if you are declining."
                              style={{ ...input, resize: "vertical" }} />
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button onClick={() => decide(r, "scheduled")} disabled={saving}
                              style={{ padding: "8px 14px", borderRadius: 7, border: "none", background: "var(--brand)", color: "#FFFFFF", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                              {saving ? "Saving…" : "Mark as booked"}
                            </button>
                            <button onClick={() => decide(r, "declined")} disabled={saving}
                              style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid #F1D0CB", background: "#FFFFFF", color: "#B3261E", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                              Decline
                            </button>
                            <button onClick={() => setOpenId(null)} disabled={saving}
                              style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B6860", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
