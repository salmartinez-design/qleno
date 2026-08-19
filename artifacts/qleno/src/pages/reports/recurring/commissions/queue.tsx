import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle, ArrowDown, ArrowRightLeft, ArrowUp, ArrowUpDown, Ban, Building2,
  Calendar, CheckCircle, DollarSign, Edit, History, Home, Info, Loader2,
  MoreVertical, PauseCircle, Search, Undo2, XCircle,
} from "lucide-react";
import {
  C, soft, money2, dateFmt, titleCase, card, eyebrow, btn, th, td,
  StatusChip, Callout, LoadError,
} from "../_ui";
import {
  apiGet, apiPost, INELIGIBILITY_CATEGORIES, REJECTION_REASONS, SPECIALTY_SERVICES,
  ineligibilityLabel, commissionTypeLabel, PAYOUT_PERIODS, type CommissionRow,
} from "./api";

// [ares-parity 2026-08-18] Approval Queue — a faithful rebuild of Ares'
// CommissionPortal queue tab (:2017-2452) plus the six modals it triggers
// (:3461-3528, :3702-3769, :3779-3896, :3899-4009, :4012-4136, :4426-4550).
//
// Deviations from Ares are flagged inline with WHY. The two systemic ones:
//   * Ares statuses `pending`/`chargebacked` are `pending_review`/`charged_back`
//     here, and Qleno has an extra pre-review `earned` status that Ares lacked —
//     it is treated everywhere Ares treated `pending`.
//   * Ares was dark-mode-first. Every colour below is a Qleno design token; a
//     literal hex in this module is a bug, not a style choice.

interface Props {
  commissions: CommissionRow[];
  loading: boolean;
  error: string | null;
  vaFilter: number | "all";
  statusFilter: string;
  onVaFilter: (v: number | "all") => void;
  onStatusFilter: (s: string) => void;
  vaOptions: Array<{ id: number; name: string }>;
  reload: () => void;
}

// ── Vocabularies ─────────────────────────────────────────────────────────────

// Ares' queue treated `pending` as "in the office's hands". Qleno splits that
// into `earned` (auto-created, not yet looked at) and `pending_review`; both
// are approvable, selectable and overdue-able, so they travel together.
const PENDING_LIKE = ["pending_review", "earned"];
const isPendingLike = (s: string) => PENDING_LIKE.includes(s);

// [deviation from Ares] Which statuses still owe a VA money. Ares' payout chip
// and table total summed every row that passed the filters, including
// not_eligible / rejected / chargeback_confirmed / recouped -- lines that will
// never be paid. The chip is labelled "<Month> Payout ... $X total", i.e. it
// answers "what does this payout period cost", so summing written-off and
// clawed-back money made it a wrong number rather than a different one.
const PAYABLE_STATUSES = ["earned", "pending_review", "on_hold", "approved", "paid"];
const owesMoney = (s: string) => PAYABLE_STATUSES.includes(s);

// CommissionPortal.tsx:2093-2105 — verbatim order, Qleno status names.
const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all",                  label: "All Statuses" },
  { value: "pending_review",       label: "Pending" },
  { value: "on_hold",              label: "On Hold (Paused)" },
  { value: "approved",             label: "Approved" },
  { value: "paid",                 label: "Paid" },
  { value: "not_eligible",         label: "Not Eligible" },
  // Not an Ares status. Qleno can reject a line (and un-reject it via
  // make-eligible), so it needs to be reachable from the status filter --
  // otherwise a rejected commission cannot be found, let alone restored.
  { value: "rejected",             label: "Rejected" },
  { value: "risk",                 label: "At Risk" },
  { value: "chargeback_pending",   label: "Chargeback Pending" },
  { value: "chargeback_confirmed", label: "Chargeback Confirmed" },
  { value: "recouped",             label: "Chargeback Recouped" },
];

// getValidTransitions, CommissionPortal.tsx:915-928 — the full list; the row's
// current status is filtered out at render time.
const TRANSITIONS: Array<{ value: string; label: string }> = [
  { value: "pending_review",       label: "Pending" },
  { value: "approved",             label: "Approved" },
  { value: "paid",                 label: "Paid" },
  { value: "not_eligible",         label: "Not Eligible" },
  { value: "charged_back",         label: "Chargeback Disputed" },
  { value: "chargeback_pending",   label: "Chargeback Pending" },
  { value: "chargeback_confirmed", label: "Chargeback Confirmed" },
  { value: "recouped",             label: "Chargeback Recouped" },
];

// ViewDetailsModal.getActionLabel, CommissionPortal.tsx:4449-4464. Qleno's own
// event verbs are accepted too so the audit trail reads in English either way.
const ACTION_LABELS: Record<string, string> = {
  commission_submitted:           "Commission Submitted",
  commission_approved:            "Approved",
  commission_rejected:            "Rejected",
  commission_marked_not_eligible: "Marked Not Eligible",
  commission_approval_revoked:    "Approval Revoked",
  commission_made_eligible:       "Made Eligible",
  commission_edited:              "Edited",
  commission_paid:                "Paid",
  commission_chargebacked:        "Chargebacked",
  commission_status_changed:      "Status Changed",
  commission_payout_processed:    "Payout Processed",
  submitted:      "Commission Submitted",
  approved:       "Approved",
  rejected:       "Rejected",
  not_eligible:   "Marked Not Eligible",
  revoked:        "Approval Revoked",
  made_eligible:  "Made Eligible",
  edited:         "Edited",
  paid:           "Paid",
  chargeback:     "Chargebacked",
  charged_back:   "Chargebacked",
  disputed:       "Disputed",
  status_changed: "Status Changed",
  payout:         "Payout Processed",
};

// Which target statuses the Qleno API can actually reach. Ares had one generic
// PATCH /status; Qleno exposes verb endpoints instead, so a transition with no
// verb behind it is offered but disabled rather than faked — a status control
// that silently no-ops on a money screen is worse than an honest dead option.
function transitionEndpoint(current: string, next: string):
  { path: string; kind: "plain" | "reason" | "category" | "chargeback" } | null {
  if (next === "approved") return { path: "approve", kind: "plain" };
  if (next === "not_eligible") return { path: "not-eligible", kind: "category" };
  if (next === "charged_back") return { path: "dispute", kind: "reason" };
  if (next === "chargeback_pending") return { path: "chargeback", kind: "chargeback" };
  if (next === "pending_review") {
    if (current === "approved") return { path: "revoke-approval", kind: "plain" };
    if (current === "not_eligible") return { path: "make-eligible", kind: "plain" };
    // POST /make-eligible accepts from: ["not_eligible", "rejected"] and
    // restores the ledger amount either way, so a rejected line has a way back.
    if (current === "rejected") return { path: "make-eligible", kind: "plain" };
    return null;
  }
  return null; // paid / chargeback_confirmed / recouped are payout-driven
}

// ── Date helpers ─────────────────────────────────────────────────────────────

// formatDate's parsing rule (CommissionPortal.tsx:157-164): split the T off and
// build a LOCAL date, so a bare YYYY-MM-DD never renders a day early.
function asDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split("T")[0].split("-").map(Number);
  if (!y || !m) return null;
  return new Date(y, m - 1, d || 1);
}

// getPayoutDueDate, CommissionPortal.tsx:1473-1478 — last Friday of the month
// AFTER the first clean.
function payoutDueDate(firstClean: string | null | undefined): Date | null {
  const d = asDate(firstClean);
  if (!d) return null;
  const last = new Date(d.getFullYear(), d.getMonth() + 2, 0);
  while (last.getDay() !== 5) last.setDate(last.getDate() - 1);
  return last;
}

const longMonth = (yyyymm: string) => {
  const [y, m] = yyyymm.split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};

const shortDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

// ViewDetailsModal.formatDateTime, CommissionPortal.tsx:4437-4447.
const dateTimeFmt = (s: string | null | undefined) =>
  !s ? "—" : new Date(s).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });

const todayISO = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};

// A row is "client paused" when it carries the paused status. Ares derived this
// from GET /api/subscriptions (pausedSubscriptionIds, :577-581); Qleno folds it
// into the commission's own status, so there is nothing extra to fetch.
const isPaused = (c: CommissionRow) => c.status === "on_hold";

// ── Small style helpers ──────────────────────────────────────────────────────

const inputStyle = (extra?: React.CSSProperties): React.CSSProperties => ({
  font: "inherit", fontSize: 13.5, color: C.ink, background: C.card,
  border: `1px solid ${C.line}`, borderRadius: "var(--radius-control)",
  padding: "7px 10px", width: "100%", boxSizing: "border-box", ...extra,
});

const labelStyle: React.CSSProperties = { ...eyebrow(), display: "block", marginBottom: 5 };

const iconBtn = (tone: string, disabled?: boolean): React.CSSProperties => ({
  appearance: "none", background: C.card, border: `1px solid ${C.line}`,
  borderRadius: "var(--radius-control)", color: tone, padding: "5px 7px",
  cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
  display: "inline-flex", alignItems: "center",
});

// ── Shared bits ──────────────────────────────────────────────────────────────

function Modal({ title, desc, onClose, children, footer, width = 560 }: {
  title: React.ReactNode; desc?: React.ReactNode; onClose: () => void;
  children: React.ReactNode; footer: React.ReactNode; width?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 60, background: soft("var(--night)", 45),
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "6vh 16px", overflowY: "auto",
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{ ...card(), width: "100%", maxWidth: width }}>
        <div style={{ padding: "18px 22px 0" }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: C.ink, display: "flex", alignItems: "center", gap: 8 }}>
            {title}
          </h3>
          {desc != null && <p style={{ margin: "6px 0 0", fontSize: 13, color: C.grey }}>{desc}</p>}
        </div>
        <div style={{ padding: "16px 22px", display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>
        <div style={{
          padding: "14px 22px", borderTop: `1px solid ${C.lineSoft}`,
          display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap",
        }}>{footer}</div>
      </div>
    </div>
  );
}

function Field({ label, required, children, hint }: {
  label: string; required?: boolean; children: React.ReactNode; hint?: React.ReactNode;
}) {
  return (
    <div>
      <label style={labelStyle}>
        {label}{required && <span style={{ color: C.red }}> *</span>}
      </label>
      {children}
      {hint != null && <div style={{ fontSize: 12, color: C.grey, marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

function Radios({ options, value, onChange, name }: {
  options: Array<{ value: string; label: string }>;
  value: string; onChange: (v: string) => void; name: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {options.map(o => (
        <label key={o.value} style={{
          display: "flex", gap: 9, alignItems: "flex-start", fontSize: 13.5,
          color: C.ink, cursor: "pointer",
        }}>
          <input
            type="radio" name={name} value={o.value} checked={value === o.value}
            onChange={() => onChange(o.value)} style={{ marginTop: 3, accentColor: C.mint }}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

// Ares' StatusBadge (:166-218). The paused stack and the two dynamic suffixes
// are the parts that carry meaning; the pill itself is Qleno's StatusChip so
// this screen cannot drift from the rest of the module.
function StatusCell({ c }: { c: CommissionRow }) {
  // `isPaused` IS `status === "on_hold"`, and isPendingLike excludes on_hold,
  // so the old second clause (`isPaused(c) && isPendingLike(c.status)`) could
  // never be true. Qleno folds the paused flag into the commission's own status
  // (Ares carried it on the subscription), so on_hold is the whole condition.
  const paused = isPaused(c);
  if (paused) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
        <StatusChip status="on_hold" />
        {!c.service_agreement_verified && (
          <span style={{
            background: C.amberBg, color: C.amber, borderRadius: 999, padding: "3px 11px",
            fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 5,
          }}>
            <AlertTriangle size={11} />Missing Service Agreement
          </span>
        )}
      </div>
    );
  }
  let suffix: string | null = null;
  if (c.status === "chargeback_pending" && c.chargeback_dispute_deadline) {
    suffix = `dispute open until ${dateFmt(c.chargeback_dispute_deadline)}`;
  } else if (c.status === "recouped" && c.paid_date) {
    suffix = `deducted ${dateFmt(c.paid_date)}`;
  }
  return <StatusChip status={c.status} suffix={suffix} />;
}

function MenuItem({ icon, label, onClick, tone, disabled, title }: {
  icon: React.ReactNode; label: string; onClick: () => void;
  tone?: string; disabled?: boolean; title?: string;
}) {
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      style={{
        appearance: "none", border: 0, background: "none", font: "inherit", fontSize: 13,
        fontWeight: 600, color: tone ?? C.ink, textAlign: "left", width: "100%",
        padding: "7px 10px", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer",
        display: "flex", alignItems: "center", gap: 9, opacity: disabled ? 0.45 : 1,
      }}
    >
      {icon}{label}
    </button>
  );
}

// ── The tab ──────────────────────────────────────────────────────────────────

type SortCol = "client" | "va" | "commission" | "firstClean" | "status";

export default function Queue(props: Props) {
  const { commissions, loading, error, vaFilter, statusFilter, onVaFilter, onStatusFilter, vaOptions, reload } = props;

  // Filter state Ares kept on AdminDashboard; vaFilter/statusFilter are lifted
  // to the page because the Overview cards deep-link into this tab.
  const [payoutPeriodFilter, setPayoutPeriodFilter] = useState("all");   // :427
  const [clientTypeFilter, setClientTypeFilter] = useState("all");       // :541
  const [ineligibilityFilter, setIneligibilityFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<SortCol | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc" | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [menuFor, setMenuFor] = useState<number | null>(null);

  // Modal state
  const [rejectRow, setRejectRow] = useState<CommissionRow | null>(null);
  const [notEligibleRow, setNotEligibleRow] = useState<CommissionRow | null>(null);
  const [editRow, setEditRow] = useState<CommissionRow | null>(null);
  const [statusRow, setStatusRow] = useState<CommissionRow | null>(null);
  const [detailsRow, setDetailsRow] = useState<CommissionRow | null>(null);
  const [specialtyOpen, setSpecialtyOpen] = useState(false);

  // Action feedback. Ares used toasts; this module has no toast host, so the
  // same messages land in the callout strip above the table — a failed approve
  // must never look like a successful one.
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>, okMsg: string, after?: () => void) {
    setBusy(key); setActionError(null); setNotice(null);
    try {
      await fn();
      setNotice(okMsg);
      after?.();
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setMenuFor(null);
    }
  }

  // ── Derived collections ────────────────────────────────────────────────────

  const pendingCommissions = useMemo(
    () => commissions.filter(c => isPendingLike(c.status)),
    [commissions],
  );

  // filteredCommissions, CommissionPortal.tsx:1023-1126 — same pipeline, same
  // order. Client-side because the parent already holds the full list.
  const filteredCommissions = useMemo(() => {
    const now = new Date();
    let out = commissions.slice();

    // 1. Status
    if (statusFilter !== "all") {
      if (statusFilter === "risk") {
        out = out.filter(c =>
          (c.status === "approved" || c.status === "paid") &&
          c.client_type === "residential" &&
          !!c.chargeback_until && new Date(c.chargeback_until) > now);
      } else if (statusFilter === "on_hold") {
        out = out.filter(c => c.status === "on_hold");
      } else if (statusFilter === "pending_review") {
        out = out.filter(c => isPendingLike(c.status));
      } else {
        out = out.filter(c => c.status === statusFilter);
      }
    }

    // 2. Ineligibility — only meaningful alongside the two status filters that
    //    can surface not_eligible rows (:1046-1050).
    if ((statusFilter === "not_eligible" || statusFilter === "all") && ineligibilityFilter !== "all") {
      out = out.filter(c => c.status === "not_eligible" && c.ineligibility_category === ineligibilityFilter);
    }

    // 3. VA
    if (vaFilter !== "all") out = out.filter(c => c.va_user_id === vaFilter);

    // 4. Payout period — a payout in month M covers first cleans in M-1. Rows
    //    with no first clean are ALWAYS kept (:1065): they have not been dated
    //    yet and silently hiding unpaid money is the failure mode here.
    if (payoutPeriodFilter !== "all") {
      const period = PAYOUT_PERIODS.find(p => p.value === payoutPeriodFilter);
      if (period) {
        out = out.filter(c =>
          !c.first_cleaning_date || c.first_cleaning_date.slice(0, 7) === period.qualifyingValue);
      }
    }

    // 5. Search — client, VA, raw status (:1073-1083)
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      out = out.filter(c =>
        (c.client_name || "").toLowerCase().includes(q) ||
        (c.va_name || "").toLowerCase().includes(q) ||
        (c.status || "").toLowerCase().includes(q));
    }

    // 6. Sort (:1086-1123)
    if (sortColumn && sortDirection) {
      const dir = sortDirection === "asc" ? 1 : -1;
      out.sort((a, b) => {
        let av: number | string = 0, bv: number | string = 0;
        if (sortColumn === "client") { av = (a.client_name || "").toLowerCase(); bv = (b.client_name || "").toLowerCase(); }
        else if (sortColumn === "va") { av = (a.va_name || "").toLowerCase(); bv = (b.va_name || "").toLowerCase(); }
        else if (sortColumn === "commission") { av = Number(a.amount || 0); bv = Number(b.amount || 0); }
        else if (sortColumn === "firstClean") {
          av = asDate(a.first_cleaning_date)?.getTime() ?? 0;
          bv = asDate(b.first_cleaning_date)?.getTime() ?? 0;
        } else { av = a.status || ""; bv = b.status || ""; }
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return out;
  }, [commissions, statusFilter, ineligibilityFilter, vaFilter, payoutPeriodFilter, searchQuery, sortColumn, sortDirection]);

  // queueCommissions, CommissionPortal.tsx:1481-1492 — client-type filter, then
  // the overdue flag, then overdue rows float to the top.
  const queueRows = useMemo(() => {
    const now = new Date();
    const typed = clientTypeFilter === "all"
      ? filteredCommissions
      : filteredCommissions.filter(c => c.client_type === clientTypeFilter);

    const mapped = typed.map(c => {
      if (!isPendingLike(c.status) || !c.first_cleaning_date) {
        return { c, payoutDue: null as Date | null, isOverdue: false };
      }
      const due = payoutDueDate(c.first_cleaning_date);
      // Ares' rule is the only one that applies here. The server's `is_overdue`
      // answers a different question -- it is `status === 'approved' && the
      // first clean is in the past` -- and this branch only ever runs for
      // pending-like rows, so it is false by construction. It is also always a
      // boolean, so `??` never fell through: the OVERDUE badge, the row
      // highlight and the overdue-first sort were all dead.
      const overdue = !!due && now > due;
      return { c, payoutDue: due, isOverdue: overdue };
    });

    return mapped.sort((a, b) => (a.isOverdue === b.isOverdue ? 0 : a.isOverdue ? -1 : 1));
  }, [filteredCommissions, clientTypeFilter]);

  // Both totals count only statuses that still owe money -- see PAYABLE_STATUSES.
  const queueTotal = queueRows.reduce(
    (s, r) => s + (owesMoney(r.c.status) ? Number(r.c.amount || 0) : 0), 0);
  // :2049 — deliberately `$` + toFixed(2), NOT formatMoney. No thousands
  // separators here in Ares, and the office reads this chip against the bank.
  const periodTotal = filteredCommissions.reduce(
    (s, c) => s + (owesMoney(c.status) ? parseFloat(c.amount || "0") : 0), 0);

  const allPendingSelected = selectedIds.size === pendingCommissions.length && pendingCommissions.length > 0;
  const selectAllPending = () => setSelectedIds(new Set(pendingCommissions.map(c => c.id)));

  function handleSort(col: SortCol) {
    // 3-state cycle: unsorted → asc → desc → unsorted (:1129-1141)
    if (sortColumn !== col) { setSortColumn(col); setSortDirection("asc"); return; }
    if (sortDirection === "asc") { setSortDirection("desc"); return; }
    setSortColumn(null); setSortDirection(null);
  }

  const SortIndicator = ({ col }: { col: SortCol }) =>
    sortColumn !== col || !sortDirection
      ? <ArrowUpDown size={12} style={{ opacity: 0.4 }} />
      : sortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />;

  const SortHeader = ({ col, label, right }: { col: SortCol; label: string; right?: boolean }) => (
    <th style={{ ...th(), textAlign: right ? "right" : "left" }}>
      <button
        onClick={() => handleSort(col)} data-testid={`sort-${col.toLowerCase()}`}
        style={{
          appearance: "none", border: 0, background: "none", font: "inherit", color: "inherit",
          cursor: "pointer", padding: 0, display: "inline-flex", alignItems: "center", gap: 5,
          marginLeft: right ? "auto" : 0,
        }}
      >
        {label}<SortIndicator col={col} />
      </button>
    </th>
  );

  // ── Actions ────────────────────────────────────────────────────────────────

  const approve = (c: CommissionRow) =>
    run(`approve-${c.id}`, () => apiPost(`/recurring/commissions/${c.id}/approve`), "Commission approved");

  // POST /bulk-approve reports per-id outcomes instead of failing the batch: it
  // skips any row whose status moved under you. Announcing the selection size
  // claimed work the server explicitly declined to do, so the count and the
  // skip reasons both come from the response.
  const bulkApprove = async () => {
    setBusy("bulk"); setActionError(null); setNotice(null);
    try {
      const r = await apiPost<{
        approved_count: number;
        approved: number[];
        skipped: Array<{ id: number; reason: string }>;
      }>("/recurring/commissions/bulk-approve", { ids: [...selectedIds] });
      setNotice(`${r.approved_count} approved`
        + (r.skipped.length ? `, ${r.skipped.length} skipped` : ""));
      setActionError(r.skipped.length
        ? `Skipped: ${r.skipped.map(s => `#${s.id} — ${s.reason}`).join("; ")}`
        : null);
      setSelectedIds(new Set());
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null); setMenuFor(null);
    }
  };

  const revokeApproval = (c: CommissionRow) =>
    run(`revoke-${c.id}`, () => apiPost(`/recurring/commissions/${c.id}/revoke-approval`), "Commission moved back to pending");

  const makeEligible = (c: CommissionRow) =>
    run(`eligible-${c.id}`, () => apiPost(`/recurring/commissions/${c.id}/make-eligible`), "Commission moved back to pending for review");

  // Ares fired this straight from the dropdown with a hard-coded reason and no
  // confirmation (:749, :2424). Kept as-is; loss_date defaults to today because
  // Qleno's endpoint requires one and Ares had no field for it.
  //
  // POST /:id/chargeback does NOT act on the clicked line: it reads that line's
  // subscription_id and delegates to handleLostClient, which re-selects the
  // subscription's `base` commission and branches on ITS status. Three outcomes
  // come back with HTTP 200, and "Commission chargebacked" was only ever right
  // for one of them -- an unapproved line is REJECTED and reversed, and a line
  // past its window is left alone (`action: "none"`). The menu item is gated to
  // the approved/paid + in-window case, and the message reports the action the
  // server actually took rather than assuming it.
  const chargeback = async (c: CommissionRow) => {
    setBusy(`cb-${c.id}`); setActionError(null); setNotice(null);
    try {
      const r = await apiPost<{
        action: string;
        commission_id: number | null;
        amount: number;
        dispute_deadline: string | null;
      }>(`/recurring/commissions/${c.id}/chargeback`, {
        loss_date: todayISO(), reason: "Client lost within 6-month window",
      });
      setNotice(
        r.action === "none"
          ? "No chargeback was opened — this line is outside its chargeback window."
          : r.action === "rejected"
            ? "Commission reversed — it was not yet approved."
            : `Chargeback opened — dispute window runs to ${
                r.dispute_deadline ? dateFmt(r.dispute_deadline) : "the policy deadline"}.`,
      );
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null); setMenuFor(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const period = PAYOUT_PERIODS.find(p => p.value === payoutPeriodFilter);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error && <LoadError what="the approval queue" error={error} />}
      {actionError && <Callout tone="danger">{actionError}</Callout>}
      {notice && <Callout tone="ok">{notice}</Callout>}

      {/* ── Filter bar, row 0 — payout period (:2021-2068) ────────────────── */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 230 }}>
          <Calendar size={15} style={{
            position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
            color: C.grey, pointerEvents: "none",
          }} />
          <select
            value={payoutPeriodFilter}
            onChange={e => setPayoutPeriodFilter(e.target.value)}
            data-testid="select-payout-period-filter"
            aria-label="All Payout Periods"
            style={inputStyle({ paddingLeft: 32 })}
          >
            <option value="all">All Payout Periods</option>
            {/* Ares styled the "· Mar 2026 cleans" half as a muted span. A
                native <option> cannot carry markup, so the text is joined. */}
            {PAYOUT_PERIODS.map(p => (
              <option key={p.value} value={p.value}>
                {`${longMonth(p.value)} Payout · ${p.qualifyingLabel} cleans`}
              </option>
            ))}
          </select>
        </div>

        {period && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            padding: "6px 12px", borderRadius: "var(--radius-control)",
            background: soft("var(--brand)", 10), border: `1px solid ${soft("var(--brand)", 22)}`,
            fontSize: 13,
          }}>
            <DollarSign size={14} style={{ color: C.mint, flexShrink: 0 }} />
            <span style={{ color: C.ink, fontWeight: 600 }}>{longMonth(period.value)} Payout</span>
            <span style={{ color: C.grey }}>·</span>
            <span style={{ color: C.grey }}>{longMonth(period.qualifyingValue)} first cleans</span>
            <span style={{ color: C.grey }}>·</span>
            <span style={{ color: C.ink, fontWeight: 800 }}>${periodTotal.toFixed(2)} total</span>
            <button
              onClick={() => setPayoutPeriodFilter("all")}
              data-testid="button-clear-payout-period"
              aria-label="Clear payout period filter"
              style={{
                appearance: "none", border: 0, background: "none", cursor: "pointer",
                color: C.grey, padding: 0, marginLeft: 2, display: "inline-flex",
              }}
            >
              <XCircle size={14} />
            </button>
          </div>
        )}
      </div>

      {/* ── Filter bar, row 1 — type / status / ineligibility / VA ────────── */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{
          display: "flex", borderRadius: "var(--radius-control)", overflow: "hidden",
          border: `1px solid ${C.line}`, flexShrink: 0,
        }}>
          {[
            { value: "all", label: "All" },
            { value: "residential", label: "Res." },
            { value: "commercial", label: "Com." },
          ].map(opt => {
            const on = clientTypeFilter === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setClientTypeFilter(opt.value)}
                data-testid={`filter-type-${opt.value}`}
                style={{
                  appearance: "none", border: 0, font: "inherit", fontSize: 13, fontWeight: 700,
                  padding: "7px 13px", cursor: "pointer",
                  background: on ? C.mint : C.card, color: on ? "var(--night)" : C.grey,
                }}
              >{opt.label}</button>
            );
          })}
        </div>

        <select
          value={statusFilter}
          onChange={e => { onStatusFilter(e.target.value); setIneligibilityFilter("all"); }}
          data-testid="select-status-filter"
          aria-label="Status"
          style={inputStyle({ width: 185 })}
        >
          {STATUS_FILTERS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        {(statusFilter === "not_eligible" || statusFilter === "all") && (
          <select
            value={ineligibilityFilter}
            onChange={e => setIneligibilityFilter(e.target.value)}
            data-testid="select-ineligibility-filter"
            aria-label="Ineligibility"
            style={inputStyle({ width: 210 })}
          >
            <option value="all">All Reasons</option>
            {INELIGIBILITY_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        )}

        <select
          value={vaFilter === "all" ? "all" : String(vaFilter)}
          onChange={e => onVaFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          data-testid="select-va-filter"
          aria-label="All VAs"
          style={inputStyle({ width: 150 })}
        >
          <option value="all">All VAs</option>
          {vaOptions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </div>

      {/* ── Filter bar, row 2 — search & bulk (:2135-2177) ────────────────── */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 180, maxWidth: 380 }}>
          <Search size={15} style={{
            position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
            color: C.grey, pointerEvents: "none",
          }} />
          <input
            placeholder="Search client or VA..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            data-testid="input-search-queue"
            style={inputStyle({ paddingLeft: 32 })}
          />
        </div>

        {/* Ares selects EVERY pending commission, not just the visible ones
            (:1243-1245). Kept — the office bulk-approves a whole month. */}
        {pendingCommissions.length > 0 && (
          <button style={btn()} onClick={selectAllPending} data-testid="button-select-all-pending">
            Select All
          </button>
        )}

        <button
          style={{ ...btn(), marginLeft: "auto" }}
          onClick={() => setSpecialtyOpen(true)}
          data-testid="button-add-specialty-bonus"
        >
          <DollarSign size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />Add Specialty Bonus
        </button>

        {selectedIds.size > 0 && (
          <button
            style={{ ...btn("primary"), opacity: busy === "bulk" ? 0.6 : 1 }}
            onClick={bulkApprove}
            disabled={busy === "bulk"}
            data-testid="button-bulk-approve"
          >
            {busy === "bulk"
              ? <Loader2 size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              : <CheckCircle size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />}
            Approve {selectedIds.size}
          </button>
        )}
      </div>

      {/* ── Commission table (:2181-2451) ─────────────────────────────────── */}
      <section style={{ ...card(), overflow: "visible" }} data-testid="card-commission-table">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1050 }}>
            <thead>
              <tr style={{ background: C.tint }}>
                <th style={{ ...th(), width: 38 }}>
                  <input
                    type="checkbox"
                    checked={allPendingSelected}
                    onChange={e => e.target.checked ? selectAllPending() : setSelectedIds(new Set())}
                    data-testid="checkbox-select-all"
                    aria-label="Select all pending"
                    style={{ accentColor: C.mint }}
                  />
                </th>
                <SortHeader col="client" label="Client" />
                <SortHeader col="va" label="VA" />
                <th style={th()}>Type</th>
                <SortHeader col="firstClean" label="First Clean" />
                <SortHeader col="commission" label="Amount" right />
                <SortHeader col="status" label="Status" />
                <th style={th()}>Reason</th>
                <th style={th()}>Due Date</th>
                <th style={th()}>CB Expires</th>
                <th style={{ ...th(), textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={11} style={{ ...td(), color: C.grey, textAlign: "center", padding: "34px 14px" }}>
                  Loading commissions…
                </td></tr>
              )}

              {!loading && queueRows.length === 0 && (
                <tr>
                  <td colSpan={11} style={{ ...td(), textAlign: "center", padding: "38px 14px" }}>
                    <CheckCircle size={30} style={{ opacity: 0.3, color: C.grey }} />
                    <p style={{ margin: "10px 0 0", fontWeight: 700, color: C.ink }}>No commissions found</p>
                    <p style={{ margin: "3px 0 0", fontSize: 13, color: C.grey }}>Try adjusting your filters</p>
                  </td>
                </tr>
              )}

              {!loading && queueRows.map(({ c, payoutDue, isOverdue }) => {
                const now = new Date();
                const cbDate = asDate(c.chargeback_until);
                const cbExpired = cbDate ? cbDate < now : true;                       // :2241
                const cbDaysLeft = cbDate && !cbExpired
                  ? Math.ceil((cbDate.getTime() - now.getTime()) / 86400000)
                  : null;                                                             // :2242-2244
                const paused = isPaused(c);
                const typeLabel = commissionTypeLabel(c);
                const pendingLike = isPendingLike(c.status);

                // :2252 — overdue wins, then paused/on-hold.
                const rowBg = isOverdue
                  ? soft("var(--danger)", 7)
                  : paused ? soft("var(--warn)", 9) : undefined;  // paused === on_hold

                return (
                  <tr key={c.id} style={{ background: rowBg }} data-testid={`row-commission-${c.id}`}>
                    <td style={td()}>
                      {/* Only a pending row can be bulk-approved (:2254). */}
                      {pendingLike && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(c.id)}
                          onChange={() => setSelectedIds(prev => {
                            const next = new Set(prev);
                            next.has(c.id) ? next.delete(c.id) : next.add(c.id);
                            return next;
                          })}
                          aria-label={`Select ${c.client_name || "commission"}`}
                          style={{ accentColor: C.mint }}
                        />
                      )}
                    </td>

                    <td style={td()}>
                      <div style={{ fontWeight: 700, color: C.ink }}>
                        {c.client_name || (c.commission_type === "performance_bonus" ? "Performance Bonus" : "Unknown")}
                      </div>
                      {typeLabel ? (
                        <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2, color: typeToneOf(c.commission_type) }}>
                          {typeLabel}
                        </div>
                      ) : c.client_id ? (
                        // Ares linked /client/{subscriptionId}; Qleno's customer
                        // profile is keyed by client id, so that is the link.
                        <Link href={`/customers/${c.client_id}`}
                          style={{ fontSize: 12, color: C.info, fontWeight: 600 }}>View client</Link>
                      ) : null}
                      {typeLabel && c.client_id && (
                        <div>
                          <Link href={`/customers/${c.client_id}`}
                            style={{ fontSize: 12, color: C.info, fontWeight: 600 }}>View client</Link>
                        </div>
                      )}
                      {c.days_inactive != null && c.reactivation_date && (
                        <div style={{ fontSize: 12, color: C.mintDeep, marginTop: 2 }}>
                          {`Returning — Inactive ${c.days_inactive}d · Reactivated ${dateFmt(c.reactivation_date)}`}
                        </div>
                      )}
                    </td>

                    <td style={td()}>{c.va_name || "Unknown"}</td>

                    <td style={td()}>
                      {c.client_type === "residential" ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: C.info, fontWeight: 700, fontSize: 12.5 }}>
                          <Home size={13} />Res
                        </span>
                      ) : (
                        // Ares used violet for commercial; Qleno has no violet
                        // token, so commercial takes the brand colour.
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: C.mint, fontWeight: 700, fontSize: 12.5 }}>
                          <Building2 size={13} />Com
                        </span>
                      )}
                    </td>

                    <td style={td()}>{c.first_cleaning_date ? dateFmt(c.first_cleaning_date) : "—"}</td>

                    <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>
                      {money2(Number(c.amount || 0))}
                    </td>

                    <td style={td()}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
                        <StatusCell c={c} />
                        {isOverdue && (
                          <span style={{
                            background: C.redBg, color: C.red, borderRadius: 999, padding: "2px 9px",
                            fontSize: 11, fontWeight: 800, letterSpacing: ".04em",
                          }}>OVERDUE</span>
                        )}
                      </div>
                    </td>

                    <td style={{ ...td(), maxWidth: 230 }}>
                      {c.status === "not_eligible" ? (
                        <span style={{ display: "inline-flex", gap: 5, color: C.amber, fontSize: 12.5, fontWeight: 600 }}>
                          <Info size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                          {ineligibilityLabel(c.ineligibility_category, c.ineligibility_reason)}
                        </span>
                      ) : c.status === "on_hold" ? (
                        <span style={{ display: "inline-flex", gap: 5, color: C.amber, fontSize: 12.5, fontWeight: 600 }}>
                          <PauseCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                          Commission held — service paused. Will reactivate on resume.
                        </span>
                      ) : "—"}
                      {/* Ares had a third arm here for "paused AND pending".
                          Qleno's paused flag IS the on_hold status, which the
                          arm above already covers, so it was unreachable. */}
                    </td>

                    <td style={td()}>
                      {payoutDue ? (
                        <span style={{
                          fontSize: 12.5, fontWeight: isOverdue ? 800 : 600,
                          color: isOverdue ? C.red : C.grey,
                          display: "inline-flex", alignItems: "center", gap: 4,
                        }}>
                          {`Due ${shortDay(payoutDue)}`}
                          {/* Ares appended a "⚠" glyph; house rule bans emoji,
                              so the same signal is the icon. */}
                          {isOverdue && <AlertTriangle size={12} />}
                        </span>
                      ) : "—"}
                    </td>

                    <td style={td()}>
                      {c.client_type === "residential" && cbDaysLeft !== null ? (
                        <span style={{
                          fontSize: 12.5, fontWeight: cbDaysLeft <= 14 ? 800 : 600,
                          color: cbDaysLeft <= 14 ? C.red : C.grey,
                        }}>{`${cbDaysLeft}d left`}</span>
                      ) : cbExpired && c.status === "approved" ? (
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.mintDeep }}>Cleared</span>
                      ) : "—"}
                    </td>

                    <td style={{ ...td(), textAlign: "right", position: "relative", whiteSpace: "nowrap" }}>
                      {(pendingLike || c.status === "on_hold") && (
                        <>
                          <button
                            title={c.status === "on_hold" ? "Cannot approve — client is paused" : "Approve"}
                            aria-label={c.status === "on_hold" ? "Cannot approve — client is paused" : "Approve"}
                            onClick={() => { if (pendingLike) approve(c); }}
                            disabled={busy === `approve-${c.id}` || c.status === "on_hold"}
                            style={{ ...iconBtn(C.mintDeep, busy === `approve-${c.id}` || c.status === "on_hold"), marginRight: 6 }}
                            data-testid={`button-approve-${c.id}`}
                          >
                            {busy === `approve-${c.id}` ? <Loader2 size={15} /> : <CheckCircle size={15} />}
                          </button>
                          <button
                            title="Reject" aria-label="Reject"
                            onClick={() => setRejectRow(c)}
                            style={{ ...iconBtn(C.red), marginRight: 6 }}
                            data-testid={`button-reject-${c.id}`}
                          >
                            <XCircle size={15} />
                          </button>
                        </>
                      )}

                      <button
                        title="More actions" aria-label="More actions"
                        onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                        style={iconBtn(C.grey)}
                        data-testid={`button-row-menu-${c.id}`}
                      >
                        <MoreVertical size={15} />
                      </button>

                      {menuFor === c.id && (
                        <>
                          <div onClick={() => setMenuFor(null)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                          <div style={{
                            ...card(), position: "absolute", right: 10, top: "calc(100% - 6px)", zIndex: 41,
                            minWidth: 216, padding: 6, textAlign: "left",
                          }}>
                            <MenuItem icon={<History size={14} />} label="View History"
                              onClick={() => { setDetailsRow(c); setMenuFor(null); }} />
                            <MenuItem icon={<Edit size={14} />} label="Edit"
                              onClick={() => { setEditRow(c); setMenuFor(null); }} />
                            <div style={{ height: 1, background: C.lineSoft, margin: "5px 0" }} />
                            {c.status === "approved" && (
                              <MenuItem icon={<Undo2 size={14} />} label="Revoke Approval"
                                onClick={() => revokeApproval(c)} disabled={busy === `revoke-${c.id}`} />
                            )}
                            {(pendingLike || c.status === "approved") && (
                              <MenuItem icon={<Ban size={14} />} label="Mark Not Eligible" tone={C.red}
                                onClick={() => { setNotEligibleRow(c); setMenuFor(null); }} />
                            )}
                            {["not_eligible", "rejected"].includes(c.status) && (
                              <MenuItem icon={<CheckCircle size={14} />} label="Make Eligible"
                                onClick={() => makeEligible(c)} disabled={busy === `eligible-${c.id}`} />
                            )}
                            <div style={{ height: 1, background: C.lineSoft, margin: "5px 0" }} />
                            <MenuItem icon={<ArrowRightLeft size={14} />} label="Change Status"
                              onClick={() => { setStatusRow(c); setMenuFor(null); }} />
                            {/* Only offer this where the clicked row and the row
                                the server will actually touch are the same one,
                                and where the outcome is a real chargeback. */}
                            {(c.status === "approved" || c.status === "paid")
                              && !!c.subscription_id
                              && !!c.chargeback_until
                              && new Date(c.chargeback_until + "T12:00:00") > new Date() && (
                              <MenuItem icon={<AlertTriangle size={14} />} label="Chargeback" tone={C.red}
                                title="Files a chargeback immediately — Ares had no confirmation step here either"
                                onClick={() => chargeback(c)} disabled={busy === `cb-${c.id}`} />
                            )}
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer (:2443-2450) — only when rows exist. */}
        {!loading && queueRows.length > 0 && (
          <div style={{
            display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
            padding: "12px 16px", borderTop: `1px solid ${C.lineSoft}`, fontSize: 13,
          }}>
            <span style={{ color: C.grey }}>
              {`Showing ${queueRows.length} commission${queueRows.length !== 1 ? "s" : ""}`}
            </span>
            <span style={{ color: C.ink, fontWeight: 800 }}>Total: {money2(queueTotal)}</span>
          </div>
        )}
      </section>

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {rejectRow && (
        <RejectModal row={rejectRow} onClose={() => setRejectRow(null)}
          onDone={m => { setRejectRow(null); setNotice(m); reload(); }} onError={setActionError} />
      )}
      {notEligibleRow && (
        <NotEligibleModal row={notEligibleRow} onClose={() => setNotEligibleRow(null)}
          onDone={m => { setNotEligibleRow(null); setNotice(m); reload(); }} onError={setActionError} />
      )}
      {editRow && (
        <EditModal row={editRow} onClose={() => setEditRow(null)}
          onDone={m => { setEditRow(null); setNotice(m); reload(); }} onError={setActionError} />
      )}
      {statusRow && (
        <StatusChangeModal row={statusRow} onClose={() => setStatusRow(null)}
          onDone={m => { setStatusRow(null); setNotice(m); reload(); }} onError={setActionError} />
      )}
      {detailsRow && (
        <ViewDetailsModal row={detailsRow} onClose={() => setDetailsRow(null)} />
      )}
      {specialtyOpen && (
        <SpecialtyBonusModal
          commissions={commissions} vaOptions={vaOptions}
          onClose={() => setSpecialtyOpen(false)}
          onDone={m => { setSpecialtyOpen(false); setNotice(m); reload(); }} onError={setActionError} />
      )}
    </div>
  );
}

// §1.5 sub-label colours. Ares used amber / violet / emerald / sky; Qleno has
// no violet, so sourcing bonuses take the brand colour.
function typeToneOf(t: string): string {
  switch (t) {
    case "specialty_bonus": return C.amber;
    case "sourcing_bonus": return C.mint;
    case "performance_bonus": return C.mintDeep;
    case "frequency_adjustment": return C.info;
    default: return C.grey;
  }
}

// ── 12.3 Reject Commission (:3702-3769) ──────────────────────────────────────

function RejectModal({ row, onClose, onDone, onError }: {
  row: CommissionRow; onClose: () => void;
  onDone: (msg: string) => void; onError: (m: string) => void;
}) {
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  async function submit() {
    // submitReject, :1005-1013 — the stored reason is "Label: free text", or
    // just the label when nothing was typed.
    const label = REJECTION_REASONS.find(r => r.value === category)?.label || category;
    const fullReason = reason.trim() ? `${label}: ${reason.trim()}` : label;
    setPending(true);
    try {
      await apiPost(`/recurring/commissions/${row.id}/reject`, { reason: fullReason });
      onDone("Commission rejected");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      onClose();
    } finally { setPending(false); }
  }

  return (
    <Modal
      title="Reject Commission"
      desc="Select a reason for rejecting this commission. This action will be logged for audit purposes."
      onClose={onClose}
      footer={<>
        <button style={btn()} onClick={onClose}>Cancel</button>
        <button
          style={{ ...btn("danger"), opacity: !category || pending ? 0.5 : 1 }}
          disabled={!category || pending} onClick={submit}
          data-testid="button-confirm-reject"
        >
          {pending && <Loader2 size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />}
          Reject Commission
        </button>
      </>}
    >
      <Field label="Reason for Rejection">
        <Radios name="reject-reason" options={REJECTION_REASONS} value={category} onChange={setCategory} />
      </Field>
      {category === "other" ? (
        <Field label="Specify Reason">
          <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Enter the specific reason..." style={inputStyle({ resize: "vertical" })} />
        </Field>
      ) : (
        <Field label="Additional Notes (Optional)">
          <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Add any additional context..." style={inputStyle({ resize: "vertical" })} />
        </Field>
      )}
    </Modal>
  );
}

// ── 12.1 Mark Not Eligible (:3461-3528) ──────────────────────────────────────

function NotEligibleModal({ row, onClose, onDone, onError }: {
  row: CommissionRow; onClose: () => void;
  onDone: (msg: string) => void; onError: (m: string) => void;
}) {
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  async function submit() {
    setPending(true);
    try {
      await apiPost(`/recurring/commissions/${row.id}/not-eligible`, { category, reason });
      onDone("Commission marked as not eligible for payment");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      onClose();
    } finally { setPending(false); }
  }

  return (
    <Modal
      title="Mark Commission as Not Eligible"
      desc="Select a reason why this commission is not eligible for payment. This action will be logged for audit purposes."
      onClose={onClose}
      footer={<>
        <button style={btn()} onClick={onClose}>Cancel</button>
        <button
          style={{
            ...btn(), background: C.amberBg, color: C.amber,
            border: `1px solid ${soft("var(--warn)", 30)}`, opacity: !category || pending ? 0.5 : 1,
          }}
          disabled={!category || pending} onClick={submit}
          data-testid="button-confirm-not-eligible"
        >
          {pending && <Loader2 size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />}
          Mark Not Eligible
        </button>
      </>}
    >
      <Field label="Reason for Ineligibility">
        <Radios name="ineligibility" options={INELIGIBILITY_CATEGORIES} value={category} onChange={setCategory} />
      </Field>
      {category === "other" && (
        <Field label="Specify Reason">
          <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Enter the specific reason..." style={inputStyle({ resize: "vertical" })} />
        </Field>
      )}
      {category && category !== "other" && (
        <Field label="Additional Notes (Optional)">
          <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Add any additional context..." style={inputStyle({ resize: "vertical" })} />
        </Field>
      )}
    </Modal>
  );
}

// ── Status transitions, shared by 12.5 and 12.6 ──────────────────────────────

async function applyTransition(
  row: CommissionRow, next: string, reason: string, category: string, ineligReason: string,
) {
  const ep = transitionEndpoint(row.status, next);
  if (!ep) throw new Error(`Qleno has no endpoint for moving a commission from "${row.status}" to "${next}" yet.`);
  const url = `/recurring/commissions/${row.id}/${ep.path}`;
  if (ep.kind === "plain") return apiPost(url);
  if (ep.kind === "reason") return apiPost(url, { reason });
  if (ep.kind === "category") return apiPost(url, { category, reason: ineligReason || reason });
  return apiPost(url, { loss_date: todayISO(), reason: reason || "Chargeback filed from the approval queue" });
}

const UNSUPPORTED_NOTE =
  "Paid, Chargeback Confirmed and Chargeback Recouped are set by payout processing and the chargeback " +
  "workflow — the Qleno API has no direct transition for them, so they are shown but not selectable.";

function StatusOptions({ row, exclude }: { row: CommissionRow; exclude: boolean }) {
  return (
    <>
      {TRANSITIONS
        .filter(t => !exclude || t.value !== row.status)
        .map(t => {
          const ok = !!transitionEndpoint(row.status, t.value);
          return <option key={t.value} value={t.value} disabled={!ok}>{t.label}</option>;
        })}
    </>
  );
}

// ── 12.5 Edit Commission (:3779-3896) ────────────────────────────────────────

function EditModal({ row, onClose, onDone, onError }: {
  row: CommissionRow; onClose: () => void;
  onDone: (msg: string) => void; onError: (m: string) => void;
}) {
  // Seeded exactly as Ares seeded it (:930-938).
  const [editStatus, setEditStatus] = useState(row.status);
  const [editAmount] = useState(row.amount);
  const [editNotes] = useState("");
  const [category, setCategory] = useState("");
  const [ineligReason, setIneligReason] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const statusChanged = editStatus !== row.status;
  const showIneligible = editStatus === "not_eligible" && statusChanged;

  async function submit() {
    if (showIneligible && !category) { setLocalError("Please select an ineligibility category"); return; }
    if (!statusChanged) { onDone("No changes were made"); return; }
    setPending(true);
    try {
      await applyTransition(row, editStatus, editNotes, category, ineligReason);
      onDone("Commission details have been updated");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      onClose();
    } finally { setPending(false); }
  }

  return (
    <Modal
      title="Edit Commission"
      desc="Adjust commission details. Changes will be logged for audit purposes."
      onClose={onClose}
      footer={<>
        <button style={btn()} onClick={onClose}>Cancel</button>
        <button style={{ ...btn("primary"), opacity: pending ? 0.6 : 1 }} disabled={pending}
          onClick={submit} data-testid="button-save-edit">
          {pending && <Loader2 size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />}
          Save Changes
        </button>
      </>}
    >
      {localError && <Callout tone="danger">{localError}</Callout>}

      <Field label="Client">
        <div style={{ ...inputStyle({ background: C.tint, color: C.grey }) }}>{row.client_name || "Unknown"}</div>
      </Field>

      <Field label="Status" hint={UNSUPPORTED_NOTE}>
        <select
          value={editStatus}
          onChange={e => {
            setEditStatus(e.target.value);
            // :3807-3810 — leaving not_eligible clears the ineligibility pair.
            if (e.target.value !== "not_eligible") { setCategory(""); setIneligReason(""); }
          }}
          style={inputStyle()} data-testid="select-edit-status"
        >
          {/* Ares deliberately does NOT exclude the current status here. */}
          <StatusOptions row={row} exclude={false} />
        </select>
      </Field>

      {showIneligible && (
        <>
          <Field label="Ineligibility Category" required>
            <select value={category} onChange={e => setCategory(e.target.value)} style={inputStyle()}>
              <option value="">Select category</option>
              {INELIGIBILITY_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Ineligibility Reason (Optional)">
            <textarea rows={3} value={ineligReason} onChange={e => setIneligReason(e.target.value)}
              placeholder="Additional details about why this is not eligible..."
              style={inputStyle({ resize: "vertical" })} />
          </Field>
        </>
      )}

      {/* Ares PATCHed /api/commissions/{id}/edit for these two. Qleno has no
          equivalent endpoint, so they render real and disabled rather than
          accepting a keystroke that would be thrown away. */}
      <Field label="Commission Amount ($)"
        hint="Editing the amount needs an edit endpoint (Ares: PATCH /commissions/:id/edit). Not in the Qleno API yet.">
        <input type="text" value={editAmount} placeholder="0.00" disabled readOnly
          style={inputStyle({ background: C.tint, color: C.faint, cursor: "not-allowed" })} />
      </Field>

      <Field label="Notes (Optional)"
        hint="Adjustment notes need the same edit endpoint. Use Change Status, whose reason field is stored on the audit trail.">
        <textarea rows={3} value={editNotes} placeholder="Reason for adjustment..." disabled readOnly
          style={inputStyle({ background: C.tint, color: C.faint, cursor: "not-allowed", resize: "vertical" })} />
      </Field>
    </Modal>
  );
}

// ── 12.6 Change Commission Status (:3899-4009) ───────────────────────────────

function StatusChangeModal({ row, onClose, onDone, onError }: {
  row: CommissionRow; onClose: () => void;
  onDone: (msg: string) => void; onError: (m: string) => void;
}) {
  const [newStatus, setNewStatus] = useState("");
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState("");
  const [ineligReason, setIneligReason] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const needsCategory = newStatus === "not_eligible";
  const supported = !!newStatus && !!transitionEndpoint(row.status, newStatus);
  const disabled = !newStatus || (needsCategory && !category) || pending || !supported;

  async function submit() {
    if (needsCategory && !category) { setLocalError("Please select an ineligibility category"); return; }
    setPending(true);
    try {
      await applyTransition(row, newStatus, reason, category, ineligReason);
      onDone("Commission status has been updated");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      onClose();
    } finally { setPending(false); }
  }

  return (
    <Modal
      title="Change Commission Status"
      desc="Select a new status for this commission. Changes will be logged for audit purposes."
      onClose={onClose}
      footer={<>
        <button style={btn()} onClick={onClose}>Cancel</button>
        <button style={{ ...btn("primary"), opacity: disabled ? 0.5 : 1 }} disabled={disabled}
          onClick={submit} data-testid="button-confirm-status-change">
          {pending && <Loader2 size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />}
          Change Status
        </button>
      </>}
    >
      {localError && <Callout tone="danger">{localError}</Callout>}

      <Field label="Client">
        <div style={inputStyle({ background: C.tint, color: C.grey })}>{row.client_name || "Unknown"}</div>
      </Field>

      {/* :3924 — raw string concat, deliberately NOT formatMoney. */}
      <Field label="Commission Amount">
        <div style={inputStyle({ background: C.tint, color: C.grey })}>{`$${row.amount}`}</div>
      </Field>

      <Field label="Current Status">
        <div><StatusCell c={row} /></div>
      </Field>

      <Field label="New Status" hint={UNSUPPORTED_NOTE}>
        <select
          value={newStatus}
          onChange={e => {
            setNewStatus(e.target.value);
            if (e.target.value !== "not_eligible") { setCategory(""); setIneligReason(""); }
          }}
          style={inputStyle()} data-testid="select-new-status"
        >
          <option value="">Select new status</option>
          <StatusOptions row={row} exclude />
        </select>
      </Field>

      {needsCategory && (
        <>
          <Field label="Ineligibility Category" required>
            <select value={category} onChange={e => setCategory(e.target.value)} style={inputStyle()}>
              <option value="">Select category</option>
              {INELIGIBILITY_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Ineligibility Reason (Optional)">
            <textarea rows={3} value={ineligReason} onChange={e => setIneligReason(e.target.value)}
              placeholder="Additional details about why this is not eligible..."
              style={inputStyle({ resize: "vertical" })} />
          </Field>
        </>
      )}

      <Field label="Reason for Change (Optional)">
        <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
          placeholder="Enter reason for status change..." style={inputStyle({ resize: "vertical" })} />
      </Field>
    </Modal>
  );
}

// ── 12.4 View Details / Commission History (:4426-4550) ──────────────────────

interface DetailResp {
  commission: CommissionRow;
  events?: Array<Record<string, any>>;
  ledger?: Array<Record<string, any>>;
  chargebacks?: Array<Record<string, any>>;
}

function ViewDetailsModal({ row, onClose }: { row: CommissionRow; onClose: () => void }) {
  const [data, setData] = useState<DetailResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true); setErr(null);
    apiGet<DetailResp>(`/recurring/commissions/${row.id}`)
      .then(d => { if (live) { setData(d); setLoading(false); } })
      .catch(e => { if (live) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { live = false; };
  }, [row.id]);

  const c = data?.commission ?? row;
  const events = data?.events ?? [];

  return (
    <Modal
      title={<><History size={16} />Commission History</>}
      desc="View the complete audit trail for this commission."
      onClose={onClose}
      footer={<button style={btn()} onClick={onClose}>Close</button>}
      width={620}
    >
      {loading && (
        <div style={{ display: "flex", justifyContent: "center", padding: "28px 0", color: C.grey }}>
          <Loader2 size={22} />
        </div>
      )}
      {!loading && err && <LoadError what="this commission" error={err} />}
      {!loading && !err && !data && <p style={{ color: C.grey, fontSize: 13.5 }}>Unable to load commission details.</p>}

      {!loading && !err && data && (
        <>
          <div style={{
            background: C.tint, border: `1px solid ${C.lineSoft}`, borderRadius: 12,
            padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, fontSize: 13.5,
          }}>
            <Row label="Client" value={c.client_name || "Unknown"} />
            <Row label="Status" value={<StatusCell c={c} />} />
            <Row label="Amount" value={money2(Number(c.amount || 0))} />
            <Row label="First Clean" value={c.first_cleaning_date ? dateFmt(c.first_cleaning_date) : "—"} />
          </div>

          <div>
            <div style={{ ...eyebrow(), display: "flex", alignItems: "center", gap: 6, marginBottom: 9 }}>
              <History size={12} />Activity Log
            </div>
            {events.length === 0 ? (
              <p style={{ color: C.grey, fontSize: 13.5, margin: 0 }}>No activity recorded yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                {events.map((log, i) => {
                  const action = String(log.action ?? log.event_type ?? log.type ?? "");
                  const who = log.user_name ?? log.actor_name ?? log.created_by_name ?? "System";
                  const when = log.created_at ?? log.createdAt ?? log.occurred_at;
                  return (
                    <div key={log.id ?? i} style={{ borderLeft: `2px solid ${C.line}`, paddingLeft: 11 }}>
                      <div style={{ fontWeight: 800, fontSize: 13.5, color: C.ink }}>
                        {ACTION_LABELS[action] ?? action}
                      </div>
                      <div style={{ fontSize: 12, color: C.grey, marginTop: 2 }}>
                        {`by ${who} • ${dateTimeFmt(when)}`}
                      </div>
                      {metadataLine(action, log) && (
                        <div style={{ fontSize: 12.5, color: C.grey, marginTop: 3 }}>{metadataLine(action, log)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <span style={{ color: C.grey, minWidth: 96 }}>{label}:</span>
      <span style={{ color: C.ink, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

// :4519-4530 — a status change reads as "Old → New: reason"; everything else
// falls back to whatever the metadata carries.
function metadataLine(action: string, log: Record<string, any>): string | null {
  const raw = log.metadata ?? log.details ?? log.meta;
  if (!raw) return null;
  let m: Record<string, any>;
  if (typeof raw === "string") {
    try { m = JSON.parse(raw); } catch { return raw; }
  } else { m = raw; }

  const old = m.oldStatus ?? m.old_status;
  const next = m.newStatus ?? m.new_status;
  if ((action === "commission_status_changed" || action === "status_changed") && old && next) {
    const arrow = `${titleCase(String(old))} → ${titleCase(String(next))}`;
    return m.reason && m.reason !== "No reason provided" ? `${arrow}: ${m.reason}` : arrow;
  }
  if (m.reason) return String(m.reason);
  if (m.category) return ineligibilityLabel(String(m.category), null);
  if (Array.isArray(m.changes)) return m.changes.join(", ");
  return null;
}

// ── 12.7 Add Specialty Service Bonus (:4012-4136) ────────────────────────────

function SpecialtyBonusModal({ commissions, vaOptions, onClose, onDone, onError }: {
  commissions: CommissionRow[];
  vaOptions: Array<{ id: number; name: string }>;
  onClose: () => void; onDone: (m: string) => void; onError: (m: string) => void;
}) {
  // Ares drove this off GET /api/subscriptions. This tab is handed the
  // commission list only, so the client options are the distinct clients that
  // already appear in it — a client with no commission history cannot be picked
  // here yet, which is the one honest gap in this modal.
  const clientOptions = useMemo(() => {
    const seen = new Map<string, { key: string; label: string; client_id: number | null; subscription_id: number | null }>();
    for (const c of commissions) {
      if (!c.client_name) continue;
      const key = `${c.client_id ?? "x"}:${c.subscription_id ?? "x"}`;
      if (!seen.has(key)) {
        seen.set(key, { key, label: c.client_name, client_id: c.client_id, subscription_id: c.subscription_id });
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [commissions]);

  const [clientKey, setClientKey] = useState("");
  const [vaId, setVaId] = useState("");
  const [serviceType, setServiceType] = useState("");
  const [revenue, setRevenue] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const revenueNum = parseFloat(revenue);
  const ready = !!clientKey && !!vaId && !!serviceType && revenue.trim() !== "";

  async function submit() {
    if (!ready) { setLocalError("Please fill in all required fields"); return; }
    if (isNaN(revenueNum) || revenueNum <= 0) { setLocalError("Please enter a valid revenue amount"); return; }
    const client = clientOptions.find(c => c.key === clientKey);
    const va = vaOptions.find(v => String(v.id) === vaId);
    setPending(true);
    try {
      await apiPost("/recurring/commissions/specialty-bonus", {
        va_user_id: Number(vaId),
        va_name: va?.name ?? null,
        subscription_id: client?.subscription_id ?? null,
        client_id: client?.client_id ?? null,
        client_name: client?.label ?? null,
        service_type: serviceType,
        revenue_amount: revenueNum,
      });
      onDone("The specialty service bonus has been added to the approval queue.");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      onClose();
    } finally { setPending(false); }
  }

  return (
    <Modal
      title="Add Specialty Service Bonus"
      desc="Enter the service details below. The VA will receive 5% of the service revenue as a bonus."
      onClose={onClose}
      footer={<>
        <button style={btn()} onClick={onClose}>Cancel</button>
        <button style={{ ...btn("primary"), opacity: !ready || pending ? 0.5 : 1 }}
          disabled={!ready || pending} onClick={submit} data-testid="button-add-bonus">
          {pending && <Loader2 size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />}
          Add Bonus
        </button>
      </>}
    >
      {localError && <Callout tone="danger">{localError}</Callout>}

      <Field label="Client" required
        hint={clientOptions.length === 0 ? "No clients with commission history are loaded yet." : undefined}>
        <select value={clientKey} onChange={e => setClientKey(e.target.value)} style={inputStyle()}>
          <option value="">Select client</option>
          {clientOptions.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </Field>

      <Field label="Assigned VA" required>
        <select value={vaId} onChange={e => setVaId(e.target.value)} style={inputStyle()}>
          <option value="">Select VA</option>
          {vaOptions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </Field>

      <Field label="Service Type" required>
        <select value={serviceType} onChange={e => setServiceType(e.target.value)} style={inputStyle()}>
          <option value="">Select service type</option>
          {/* SPECIALTY_SERVICES is this module's shared vocabulary; its labels
              are the Ares list with the redundant "Clean" suffix trimmed. */}
          {SPECIALTY_SERVICES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>

      <Field label="Service Revenue" required
        hint={revenueNum > 0
          ? <span style={{ color: C.mintDeep, fontWeight: 700 }}>
              {`VA Bonus: $${(revenueNum * 0.05).toFixed(2)} (5% of service revenue)`}
            </span>
          : undefined}>
        <div style={{ position: "relative" }}>
          <span style={{
            position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)",
            color: C.grey, fontSize: 13.5, pointerEvents: "none",
          }}>$</span>
          <input type="number" min="0" step="0.01" placeholder="0.00" value={revenue}
            onChange={e => setRevenue(e.target.value)} style={inputStyle({ paddingLeft: 24 })} />
        </div>
      </Field>

      {/* Ares also sent firstCleaningDate and notes. Qleno's specialty-bonus
          endpoint accepts neither, so both stay visible and disabled instead of
          collecting input that would be dropped on the way to the server. */}
      <Field label="Service Date"
        hint="Needs a service-date field on POST /recurring/commissions/specialty-bonus.">
        <input type="date" disabled style={inputStyle({ background: C.tint, color: C.faint, cursor: "not-allowed" })} />
      </Field>

      <Field label="Notes (Optional)"
        hint="Needs a notes field on the same endpoint.">
        <textarea rows={2} placeholder="Any additional details..." disabled
          style={inputStyle({ background: C.tint, color: C.faint, cursor: "not-allowed", resize: "vertical" })} />
      </Field>
    </Modal>
  );
}
