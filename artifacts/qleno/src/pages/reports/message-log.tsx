import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface LogRow {
  id: number;
  sent_at: string;
  channel: string;
  status: string;
  recipient_name: string;
  recipient_email: string | null;
  recipient_phone: string | null;
  sequence_name: string | null;
  sequence_type: string | null;
  step_number: number | null;
  subject: string | null;
}

const CHANNEL_LABEL: Record<string, string> = { sms: "SMS", email: "Email" };
const SEQ_LABEL: Record<string, string> = {
  quote_followup: "Quote Follow-Up",
  post_job_retention: "Post-Job Retention",
};

export default function MessageLogPage() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [channel, setChannel] = useState("");
  const [seqType, setSeqType] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (channel)  params.set("channel", channel);
    if (seqType)  params.set("sequence_type", seqType);
    if (fromDate) params.set("from_date", fromDate);
    if (toDate)   params.set("to_date", toDate);
    params.set("limit", "200");
    try {
      const res = await fetch(`${API}/api/follow-up/message-log?${params}`, { headers: await getAuthHeaders() });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

  const pill = (text: string, bg: string, fg: string) => (
    <span style={{ background: bg, color: fg, padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
      {text}
    </span>
  );

  return (
    <DashboardLayout title="Message Log">
      <div style={{ padding: "24px 28px", maxWidth: 1200 }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#1A1917" }}>Message Log</h1>
          <p style={{ margin: "6px 0 0", fontSize: 14, color: "#6B7280" }}>
            All automated follow-up messages sent via SMS and email. {total > 0 && `${total} total records.`}
          </p>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20, padding: 16, background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10 }}>
          <select value={channel} onChange={e => setChannel(e.target.value)}
            style={{ border: "1px solid #E5E2DC", borderRadius: 6, padding: "7px 10px", fontSize: 13, color: "#1A1917", background: "#FFFFFF", minWidth: 130 }}>
            <option value="">All Channels</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
          <select value={seqType} onChange={e => setSeqType(e.target.value)}
            style={{ border: "1px solid #E5E2DC", borderRadius: 6, padding: "7px 10px", fontSize: 13, color: "#1A1917", background: "#FFFFFF", minWidth: 180 }}>
            <option value="">All Sequences</option>
            <option value="quote_followup">Quote Follow-Up</option>
            <option value="post_job_retention">Post-Job Retention</option>
          </select>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            style={{ border: "1px solid #E5E2DC", borderRadius: 6, padding: "7px 10px", fontSize: 13, color: "#1A1917" }} />
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            style={{ border: "1px solid #E5E2DC", borderRadius: 6, padding: "7px 10px", fontSize: 13, color: "#1A1917" }} />
          <button onClick={load}
            style={{ background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 6, padding: "7px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Apply
          </button>
          <button onClick={() => { setChannel(""); setSeqType(""); setFromDate(""); setToDate(""); setTimeout(load, 0); }}
            style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 6, padding: "7px 14px", fontSize: 13, color: "#6B6860", cursor: "pointer" }}>
            Clear
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 48, color: "#6B6860" }}>Loading...</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: "center", padding: 48, color: "#6B6860", background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10 }}>
            No messages found.
          </div>
        ) : (
          <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#F7F6F3", borderBottom: "1px solid #E5E2DC" }}>
                  {["Date Sent", "Recipient", "Channel", "Sequence", "Step", "Status"].map(h => (
                    <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, color: "#6B6860", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #F0EDE8", background: i % 2 === 0 ? "#FFFFFF" : "#FAFAF8" }}>
                    <td style={{ padding: "10px 14px", color: "#1A1917", whiteSpace: "nowrap" }}>{fmt(r.sent_at)}</td>
                    <td style={{ padding: "10px 14px", color: "#1A1917", maxWidth: 200 }}>
                      <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.recipient_name || "—"}</div>
                      <div style={{ fontSize: 11, color: "#9E9B94" }}>{r.recipient_email || r.recipient_phone || ""}</div>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      {r.channel === "sms"
                        ? pill("SMS", "#EFF6FF", "#1D4ED8")
                        : pill("Email", "#F0FDF4", "#166534")}
                    </td>
                    <td style={{ padding: "10px 14px", color: "#1A1917" }}>
                      {r.sequence_name || (r.sequence_type ? SEQ_LABEL[r.sequence_type] ?? r.sequence_type : "—")}
                    </td>
                    <td style={{ padding: "10px 14px", color: "#6B6860", textAlign: "center" }}>
                      {r.step_number ?? "—"}
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      {r.status === "sent"
                        ? pill("Sent", "#F0FDF4", "#166534")
                        : pill("Failed", "#FEF2F2", "#991B1B")}
                    </td>
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
