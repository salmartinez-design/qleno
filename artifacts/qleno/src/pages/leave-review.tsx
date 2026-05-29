/**
 * Cutover 3A — Office leave queue.
 *
 * Triage surface for leave_requests. Shows pending requests at the top
 * with the blackout-conflict flag visible; office can approve, deny,
 * or cancel approved requests (which restores the balance). Routes
 * through the existing /api/leave endpoints — no new tables on the
 * frontend.
 *
 * Mounted at /payroll/leave-review (office tier). Tech-facing leave
 * request form is a separate page.
 */
import { useEffect, useMemo, useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useToast } from "@/hooks/use-toast";

const FF = "'Plus Jakarta Sans', sans-serif";
const BRAND = "#00C9A0";
const INK = "#1A1917";
const MUTED = "#9E9B94";
const CARD = "#FFFFFF";
const BORDER = "#E5E2DC";
const FLAG = "#BA7517";
const DANGER = "#DC2626";

type Status = "pending" | "approved" | "denied" | "cancelled";

type Request = {
  id: number;
  user_id: number;
  first_name: string | null;
  last_name: string | null;
  bucket_name: string | null;
  start_date: string;
  end_date: string;
  hours: string;
  note: string | null;
  status: Status;
  blackout_conflict: boolean;
  blackout_label: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
};

function fmtName(r: { first_name: string | null; last_name: string | null }): string {
  return [r.first_name, r.last_name].filter(Boolean).join(" ") || "—";
}

export default function LeaveReviewPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Status>("pending");
  const [rows, setRows] = useState<Request[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    load();
  }, [tab]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/leave/requests?status=${tab}`, { credentials: "include" });
      const json = await res.json();
      setRows(json.data ?? []);
    } catch {
      toast({ title: "Could not load requests", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function act(id: number, action: "approve" | "deny" | "cancel", note?: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/leave/requests/${id}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: note ? JSON.stringify({ decision_note: note }) : undefined,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast({ title: err?.message || `${action} failed`, variant: "destructive" });
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, color: INK, padding: "8px 0 32px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Leave Review</h1>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 16 }}>
          Approve, deny, or override leave requests. Balances move only on approval.
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {(["pending", "approved", "denied", "cancelled"] as Status[]).map((s) => (
            <button
              key={s}
              onClick={() => setTab(s)}
              style={{
                fontFamily: FF, fontSize: 12, fontWeight: 700,
                border: `1px solid ${tab === s ? BRAND : BORDER}`,
                color: tab === s ? "#FFFFFF" : INK,
                backgroundColor: tab === s ? BRAND : CARD,
                borderRadius: 8, padding: "6px 12px", cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13 }}>
            No {tab} leave requests.
          </div>
        ) : (
          <div style={{ backgroundColor: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: MUTED, textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Employee</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Bucket</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Dates</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Hours</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Flags</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Note</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                    <td style={{ padding: "8px", fontWeight: 600 }}>{fmtName(r)}</td>
                    <td style={{ padding: "8px" }}>{r.bucket_name ?? "—"}</td>
                    <td style={{ padding: "8px" }}>
                      {r.start_date}
                      {r.start_date !== r.end_date ? ` → ${r.end_date}` : ""}
                    </td>
                    <td style={{ padding: "8px", fontWeight: 700 }}>{Number(r.hours).toFixed(2)}</td>
                    <td style={{ padding: "8px" }}>
                      {r.blackout_conflict && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: DANGER, padding: "1px 6px", border: `1px solid ${DANGER}`, borderRadius: 3 }}>
                          BLACKOUT
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "8px", color: MUTED, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.note ?? ""}
                    </td>
                    <td style={{ padding: "8px", textAlign: "right" }}>
                      <RowActions
                        row={r}
                        busy={busyId === r.id}
                        onApprove={(note) => act(r.id, "approve", note)}
                        onDeny={(note) => act(r.id, "deny", note)}
                        onCancel={() => act(r.id, "cancel")}
                      />
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

function RowActions({
  row,
  busy,
  onApprove,
  onDeny,
  onCancel,
}: {
  row: Request;
  busy: boolean;
  onApprove: (note?: string) => void;
  onDeny: (note?: string) => void;
  onCancel: () => void;
}) {
  const base: React.CSSProperties = {
    fontFamily: FF, fontSize: 11, fontWeight: 700,
    border: `1px solid ${BORDER}`, borderRadius: 6,
    padding: "4px 10px", marginLeft: 6, cursor: "pointer",
    backgroundColor: CARD, color: INK,
  };
  const disabled: React.CSSProperties = { opacity: 0.4, cursor: "not-allowed" };
  if (row.status === "cancelled" || row.status === "denied") {
    return <span style={{ color: MUTED, fontSize: 11 }}>—</span>;
  }
  if (row.status === "approved") {
    return (
      <button
        onClick={onCancel}
        disabled={busy}
        style={{ ...base, color: DANGER, borderColor: "#F5D2D2", ...(busy ? disabled : {}) }}
      >
        Cancel + restore balance
      </button>
    );
  }
  // pending
  return (
    <>
      <button
        onClick={() => {
          const note = prompt("Approval note (optional):") ?? undefined;
          onApprove(note?.trim() || undefined);
        }}
        disabled={busy}
        style={{ ...base, backgroundColor: BRAND, color: "#FFFFFF", border: "none", ...(busy ? disabled : {}) }}
      >
        {row.blackout_conflict ? "Override + approve" : "Approve"}
      </button>
      <button
        onClick={() => {
          const note = prompt("Deny reason (optional):") ?? undefined;
          onDeny(note?.trim() || undefined);
        }}
        disabled={busy}
        style={{ ...base, color: DANGER, borderColor: "#F5D2D2", ...(busy ? disabled : {}) }}
      >
        Deny
      </button>
    </>
  );
}
