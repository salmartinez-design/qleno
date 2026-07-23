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
import { getAuthHeaders } from "@/lib/auth";

const FF = "'Plus Jakarta Sans', sans-serif";
const BRAND = "var(--brand)";
const INK = "#1A1917";
const MUTED = "#9E9B94";
const CARD = "#FFFFFF";
const BORDER = "#E5E2DC";
const FLAG = "#BA7517";
const DANGER = "#B3261E";

// Human formats — Sal: "do not use military time."
function fmt12(t: string): string {
  const [hStr, mStr] = t.slice(0, 5).split(":");
  let h = parseInt(hStr, 10);
  if (isNaN(h)) return t;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${mStr ?? "00"} ${ampm}`;
}
function fmtDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

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
  start_time?: string | null;
  end_time?: string | null;
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
      // [leave-auth 2026-07-07] Bearer token, not cookies — same fix as the
      // employee My Time Off page; the cookie fetch 401'd so this office queue
      // silently showed "No pending leave requests" forever.
      const res = await fetch(`/api/leave/requests?status=${tab}`, { headers: getAuthHeaders() });
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
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
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
                      {fmtDay(r.start_date)}
                      {r.start_date !== r.end_date ? ` – ${fmtDay(r.end_date)}` : ""}
                      {r.start_time && r.end_time && (
                        // 12-hour, always (Sal: "do not use military time").
                        <span style={{ color: "#9E9B94" }}> · {fmt12(String(r.start_time))}–{fmt12(String(r.end_time))}</span>
                      )}
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

        <BalancesGrantsSection />
      </div>
    </DashboardLayout>
  );
}

// [mc-migration 2026-07-07] Balances & Grants — the office's window into the
// grant engine. Shows who is owed a grant right now (per hire date + policy),
// flags employees with NO hire date (the engine grants them nothing until it's
// set on their profile), applies all pending grants in one click, and lets the
// office hand-correct any (employee, bucket) balance — the tool for making the
// MaidCentral transfer numbers exact.
type PlanRow = {
  user_id: number; first_name: string | null; last_name: string | null;
  hire_date: string | null; leave_type_id: number; slug: string; display_name: string;
  prior_granted: number; prior_used: number;
  plan: { entitlement: number; new_granted: number; new_used: number; action: string };
  remaining: number;
};

function BalancesGrantsSection() {
  const { toast } = useToast();
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/leave/reconcile/preview", { headers: getAuthHeaders() });
      const json = await res.json();
      setRows(json.data ?? []);
      setMissing(json.missing_hire_dates ?? []);
    } catch {
      toast({ title: "Could not load grant preview", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function applyAll() {
    if (!confirm("Apply all pending grants now? Balances update immediately and employees can request against them.")) return;
    setApplying(true);
    try {
      const res = await fetch("/api/leave/reconcile/apply", { method: "POST", headers: getAuthHeaders() });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "apply failed");
      toast({ title: `Grants applied — ${json.applied} balance${json.applied === 1 ? "" : "s"} updated` });
      await load();
    } catch (e: any) {
      toast({ title: e?.message || "Failed to apply grants", variant: "destructive" });
    } finally {
      setApplying(false);
    }
  }

  const pending = rows.filter(r => r.plan.action !== "none");
  const actionLabel: Record<string, string> = { initial_grant: "First grant", annual_reset: "Annual reset", tier_topup: "Tenure top-up" };

  return (
    <div style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>Balances &amp; Grants</h2>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
        What the leave policy owes each employee right now. Apply grants after a migration or when a new hire crosses their waiting period; use manual set to match MaidCentral numbers exactly.
      </div>

      {missing.length > 0 && (
        <div style={{ background: "#FDF3E4", border: "1px solid #F2DFB8", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: "#B45309" }}>
          <strong>No hire date on file:</strong> {missing.join(", ")}. These employees get NO automatic grants and their PTO/sick cards stay locked — set each hire date on the employee profile, then re-open this page.
        </div>
      )}

      <div style={{ backgroundColor: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 14, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: pending.length ? 10 : 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            {loading ? "Loading grant preview…" : pending.length === 0 ? "All balances are up to date — nothing to grant." : `${pending.length} pending grant${pending.length === 1 ? "" : "s"}`}
          </div>
          {pending.length > 0 && (
            <button onClick={applyAll} disabled={applying}
              style={{ fontFamily: FF, fontSize: 12, fontWeight: 700, color: "#FFFFFF", background: BRAND, border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer", opacity: applying ? 0.5 : 1 }}>
              {applying ? "Applying…" : "Apply all grants"}
            </button>
          )}
        </div>
        {pending.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: MUTED, textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <th style={{ padding: "6px 8px", fontWeight: 700 }}>Employee</th>
                <th style={{ padding: "6px 8px", fontWeight: 700 }}>Bucket</th>
                <th style={{ padding: "6px 8px", fontWeight: 700 }}>Hire date</th>
                <th style={{ padding: "6px 8px", fontWeight: 700 }}>Now (used / granted)</th>
                <th style={{ padding: "6px 8px", fontWeight: 700 }}>After apply</th>
                <th style={{ padding: "6px 8px", fontWeight: 700 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {pending.map(r => (
                <tr key={`${r.user_id}-${r.leave_type_id}`} style={{ borderTop: `1px solid ${BORDER}` }}>
                  <td style={{ padding: "7px 8px", fontWeight: 600 }}>{`${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || `#${r.user_id}`}</td>
                  <td style={{ padding: "7px 8px" }}>{r.display_name}</td>
                  <td style={{ padding: "7px 8px", color: r.hire_date ? INK : FLAG }}>{r.hire_date ?? "missing"}</td>
                  <td style={{ padding: "7px 8px", color: MUTED }}>{r.prior_used.toFixed(1)} / {r.prior_granted.toFixed(1)}</td>
                  <td style={{ padding: "7px 8px", fontWeight: 700 }}>{r.plan.new_used.toFixed(1)} / {r.plan.new_granted.toFixed(1)} <span style={{ color: MUTED, fontWeight: 500 }}>({r.remaining.toFixed(1)} left)</span></td>
                  <td style={{ padding: "7px 8px" }}>{actionLabel[r.plan.action] ?? r.plan.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* [cleanup 2026-07-07] The "Manually set a balance" form is removed —
          the raw granted/used inputs were the same trap that crushed Hilda's
          bank (4 typed into Granted), and the employee-profile Update editor
          does everything it did with modes, reasons, previews, and revert.
          Balance edits live on the profile now; this page is for decisions
          and grant visibility. */}
      <p style={{ fontSize: 12, color: MUTED, margin: 0 }}>
        To adjust an individual balance, open the employee's profile → Attendance → Update on the bucket. Every change lands in that bucket's Balance changes log.
      </p>
    </div>
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
