/**
 * Cutover 3A — Employee leave request form + own-balances view.
 *
 * Mounted at /leave. The tech sees their own balances per bucket
 * (granted, used, available, past-waiting-period flag) and a small
 * form to submit a new request. Balance refreshes after submit.
 */
import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useToast } from "@/hooks/use-toast";
import { CalendarPopover } from "@/components/calendar-popover";

const FF = "'Plus Jakarta Sans', sans-serif";
const BRAND = "#00C9A0";
const INK = "#1A1917";
const MUTED = "#9E9B94";
const CARD = "#FFFFFF";
const BORDER = "#E5E2DC";
const DANGER = "#DC2626";

type Balance = {
  leave_type_id: number;
  display_name: string;
  slug: string;
  accrual_mode: string;
  granted: number;
  used: number;
  available: number;
  annual_cap_hours: number;
  waiting_period_days: number;
  past_waiting_period: boolean;
};

type MyRequest = {
  id: number;
  leave_type_id: number;
  start_date: string;
  end_date: string;
  hours: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  blackout_conflict: boolean;
  blackout_label: string | null;
  decision_note: string | null;
};

export default function LeaveRequestPage() {
  const { toast } = useToast();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [requests, setRequests] = useState<MyRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [hours, setHours] = useState<string>("8");
  const [note, setNote] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [bRes, rRes] = await Promise.all([
        fetch("/api/leave/balances/me", { credentials: "include" }),
        fetch("/api/leave/requests/mine", { credentials: "include" }),
      ]);
      const bJson = await bRes.json();
      const rJson = await rRes.json();
      setBalances(bJson.data ?? []);
      setRequests(rJson.data ?? []);
    } catch {
      toast({ title: "Could not load leave data", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    if (!selectedBucket || !startDate || !endDate || !hours) {
      toast({ title: "Pick a bucket and dates", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/leave/requests", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leave_type_id: selectedBucket,
          start_date: startDate,
          end_date: endDate,
          hours: Number(hours),
          note: note || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast({
          title: err?.message || "Submit failed",
          variant: "destructive",
        });
        return;
      }
      const json = await res.json();
      if (json.data?.blackout_conflict) {
        toast({
          title: `Auto-denied — overlaps "${json.data.blackout_label}". Office can override.`,
        });
      } else {
        toast({ title: "Request submitted" });
      }
      setNote("");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  const requestableBuckets = balances.filter(
    (b) => b.accrual_mode !== "office_recorded" && b.past_waiting_period,
  );

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, color: INK, padding: "8px 0 32px", maxWidth: 760 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>My Time Off</h1>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 16 }}>
          Submit a request and check your balances.
        </div>

        {/* Balances */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10, marginBottom: 20 }}>
          {loading ? (
            <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>
          ) : (
            balances.map((b) => (
              <div
                key={b.leave_type_id}
                style={{
                  backgroundColor: CARD, border: `1px solid ${BORDER}`,
                  borderRadius: 10, padding: 12,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 800, color: INK }}>{b.display_name}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: INK, marginTop: 4 }}>
                  {b.available.toFixed(2)} <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>hrs</span>
                </div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
                  granted {b.granted.toFixed(2)} · used {b.used.toFixed(2)}
                </div>
                {!b.past_waiting_period && (
                  <div style={{ fontSize: 10, fontWeight: 700, color: DANGER, marginTop: 6, padding: "2px 6px", border: `1px solid ${DANGER}`, borderRadius: 3, display: "inline-block" }}>
                    {b.waiting_period_days}-day wait
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Request form */}
        <div style={{ backgroundColor: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 14, marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: INK, marginBottom: 4 }}>Submit a request</div>
          <div style={{ fontSize: 11, color: MUTED, marginBottom: 10 }}>
            PTO and Unpaid Personal require 7 days' advance notice. Sick time can be requested for the same day.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <FormField label="Bucket">
              <select
                value={selectedBucket ?? ""}
                onChange={(e) => setSelectedBucket(Number(e.target.value) || null)}
                style={inputStyle}
              >
                <option value="">— pick a bucket —</option>
                {requestableBuckets.map((b) => (
                  <option key={b.leave_type_id} value={b.leave_type_id}>
                    {b.display_name} ({b.available.toFixed(2)} hrs)
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Hours">
              <input
                type="number"
                step="0.25"
                min="0"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Start date">
              <CalendarPopover value={startDate} ariaLabel="Start date" onChange={setStartDate} block />
            </FormField>
            <FormField label="End date">
              <CalendarPopover value={endDate} ariaLabel="End date" onChange={setEndDate} block />
            </FormField>
            <div style={{ gridColumn: "1 / -1" }}>
              <FormField label="Note (optional)">
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  style={inputStyle}
                />
              </FormField>
            </div>
          </div>
          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={submit}
              disabled={submitting}
              style={{
                fontFamily: FF, fontSize: 13, fontWeight: 700,
                color: "#FFFFFF", backgroundColor: BRAND, border: "none",
                borderRadius: 8, padding: "8px 14px", cursor: "pointer",
                opacity: submitting ? 0.4 : 1,
              }}
            >
              Submit request
            </button>
          </div>
        </div>

        {/* My recent requests */}
        <div style={{ fontSize: 14, fontWeight: 800, color: INK, marginBottom: 8 }}>My requests</div>
        {requests.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13 }}>No requests yet.</div>
        ) : (
          <div style={{ backgroundColor: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: MUTED, textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Dates</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Hours</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Status</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Decision note</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                    <td style={{ padding: "8px" }}>
                      {r.start_date}
                      {r.start_date !== r.end_date ? ` → ${r.end_date}` : ""}
                    </td>
                    <td style={{ padding: "8px", fontWeight: 700 }}>{Number(r.hours).toFixed(2)}</td>
                    <td style={{ padding: "8px" }}>
                      <StatusPill s={r.status} blackoutConflict={r.blackout_conflict} />
                    </td>
                    <td style={{ padding: "8px", color: MUTED }}>{r.decision_note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

const inputStyle: React.CSSProperties = {
  fontFamily: FF, fontSize: 13, color: INK,
  border: `1px solid ${BORDER}`, borderRadius: 8,
  padding: "6px 10px", background: CARD, width: "100%",
};

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em" }}>
      {label}
      <div style={{ marginTop: 4, fontFamily: FF, fontSize: 13, fontWeight: 500, color: INK, textTransform: "none", letterSpacing: "normal" }}>
        {children}
      </div>
    </label>
  );
}

function StatusPill({ s, blackoutConflict }: { s: "pending" | "approved" | "denied" | "cancelled"; blackoutConflict: boolean }) {
  const styles: Record<typeof s, { bg: string; fg: string; label: string }> = {
    pending: { bg: "#F0EEE9", fg: "#6B6860", label: "Pending" },
    approved: { bg: "#D6F4E9", fg: "#0A5C3E", label: "Approved" },
    denied: { bg: "#FCE7E7", fg: "#991B1B", label: blackoutConflict ? "Denied — blackout" : "Denied" },
    cancelled: { bg: "#F0EEE9", fg: "#6B6860", label: "Cancelled" },
  };
  const v = styles[s];
  return (
    <span
      style={{
        fontSize: 10, fontWeight: 800, letterSpacing: "0.05em",
        backgroundColor: v.bg, color: v.fg,
        padding: "2px 8px", borderRadius: 10, textTransform: "uppercase",
      }}
    >
      {v.label}
    </span>
  );
}
