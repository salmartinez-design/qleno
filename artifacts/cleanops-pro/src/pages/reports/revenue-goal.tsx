import { useState, useEffect, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { CheckCircle, AlertTriangle, XCircle, Edit2, Check, X } from "lucide-react";
import { fmt$, clr, ReportHeader } from "./_shared";
import { useAuthStore } from "@/lib/auth";

const BASE = (import.meta as any).env?.BASE_URL?.replace(/\/$/, "") || "";

interface GoalData {
  goal: number | null;
  year: number;
  completed_revenue: number;
  scheduled_revenue: number;
  projection: number;
  gap: number | null;
  completed_jobs: number;
  scheduled_jobs: number;
  avg_invoice: number;
  required_avg_invoice: number | null;
  target_jobs_ytd: number | null;
  new_clients_this_year: number;
  new_clients_last_year: number;
  status: "on_track" | "at_risk" | "behind";
}

function useGoalData() {
  const [data, setData] = useState<GoalData | null>(null);
  const [loading, setLoading] = useState(true);
  const token = useAuthStore(s => s.token);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/revenue-goal`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setData(await r.json());
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  return { data, loading, reload: load };
}

const STATUS_CONFIG = {
  on_track: { label: "On Track", color: "#10B981", bg: "#D1FAE5", icon: CheckCircle },
  at_risk:  { label: "At Risk",  color: "#F59E0B", bg: "#FEF3C7", icon: AlertTriangle },
  behind:   { label: "Behind",   color: "#EF4444", bg: "#FEE2E2", icon: XCircle },
};

function GoalBadge({ status }: { status: GoalData["status"] }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, backgroundColor: cfg.bg, color: cfg.color, padding: "5px 12px", borderRadius: 20, fontSize: 13, fontWeight: 700 }}>
      <Icon size={14} />
      {cfg.label}
    </div>
  );
}

function GoalBar({ completed, scheduled, goal }: { completed: number; scheduled: number; goal: number }) {
  const max = Math.max(goal * 1.1, completed + scheduled);
  const completedPct = Math.min(100, (completed / max) * 100);
  const scheduledPct = Math.min(100 - completedPct, (scheduled / max) * 100);
  const goalPct = Math.min(99, (goal / max) * 100);

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ position: "relative", height: 36, borderRadius: 10, backgroundColor: "#F0EEE9", overflow: "visible" }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${completedPct}%`, backgroundColor: clr.brand, borderRadius: "10px 0 0 10px", transition: "width 0.5s ease" }} />
        {scheduledPct > 0 && (
          <div style={{ position: "absolute", left: `${completedPct}%`, top: 0, height: "100%", width: `${scheduledPct}%`, backgroundColor: "#A8C8EA", borderRadius: completedPct === 0 ? "10px 0 0 10px" : "0", transition: "width 0.5s ease" }} />
        )}
        <div style={{ position: "absolute", left: `${goalPct}%`, top: -6, bottom: -6, width: 3, backgroundColor: "#1A1917", borderRadius: 2, zIndex: 2 }} />
        <div style={{ position: "absolute", left: `${goalPct}%`, top: -24, transform: "translateX(-50%)", fontSize: 10, fontWeight: 700, color: "#1A1917", whiteSpace: "nowrap", backgroundColor: "#FFF", padding: "1px 6px", borderRadius: 4, border: "1px solid #EEECE7" }}>
          Goal
        </div>
      </div>
      <div style={{ display: "flex", gap: 20, marginTop: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: clr.secondary }}>
          <div style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: clr.brand }} />
          Completed
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: clr.secondary }}>
          <div style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: "#A8C8EA" }} />
          Scheduled
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: clr.secondary }}>
          <div style={{ width: 3, height: 14, borderRadius: 1, backgroundColor: "#1A1917" }} />
          Annual Goal
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 160, backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 10, padding: "16px 20px" }}>
      <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</p>
      <p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: clr.text }}>{value}</p>
      {sub && <p style={{ margin: "4px 0 0", fontSize: 11, color: subColor || clr.secondary }}>{sub}</p>}
    </div>
  );
}

export default function RevenueGoalPage() {
  const { data, loading, reload } = useGoalData();
  const token = useAuthStore(s => s.token);

  const [editing, setEditing] = useState(false);
  const [goalInput, setGoalInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.goal != null) setGoalInput(String(data.goal));
  }, [data?.goal]);

  async function saveGoal() {
    const val = parseInt(goalInput.replace(/[^0-9]/g, ""), 10);
    if (isNaN(val) || val < 0) { setSaveError("Enter a valid dollar amount."); return; }
    setSaving(true); setSaveError(null);
    try {
      const r = await fetch(`${BASE}/api/revenue-goal`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ goal: val }),
      });
      if (!r.ok) { setSaveError("Failed to save goal."); return; }
      setEditing(false);
      reload();
    } catch {
      setSaveError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  const card: React.CSSProperties = { backgroundColor: clr.card, border: `1px solid ${clr.border}`, borderRadius: 12, padding: "22px 24px", marginBottom: 20 };

  if (loading) return (
    <DashboardLayout title="Revenue Goal">
      <div style={{ padding: "24px 28px" }}>
        <p style={{ color: clr.secondary, fontSize: 14 }}>Loading…</p>
      </div>
    </DashboardLayout>
  );

  const d = data!;
  const hasGoal = d.goal != null && d.goal > 0;

  const clientDelta = d.new_clients_this_year - d.new_clients_last_year;
  const clientDeltaColor = clientDelta >= 0 ? "#10B981" : "#EF4444";
  const clientDeltaLabel = clientDelta >= 0
    ? `+${clientDelta} vs same period last year`
    : `${clientDelta} vs same period last year`;

  return (
    <DashboardLayout title="Revenue Goal">
      <div style={{ padding: "24px 28px", maxWidth: 900 }}>
        <ReportHeader
          title="Revenue Goal"
          subtitle={`${d.year} annual revenue tracking — completed, booked, and projected vs your goal.`}
        />

        {/* Goal Setting Card */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: hasGoal ? 28 : 0, flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div>
                <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>{d.year} Annual Goal</p>
                {editing ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <span style={{ fontSize: 20, fontWeight: 700, color: clr.text }}>$</span>
                    <input
                      type="text"
                      value={goalInput}
                      onChange={e => setGoalInput(e.target.value.replace(/[^0-9]/g, ""))}
                      onKeyDown={e => { if (e.key === "Enter") saveGoal(); if (e.key === "Escape") setEditing(false); }}
                      autoFocus
                      style={{ fontSize: 22, fontWeight: 700, color: clr.text, border: `2px solid ${clr.brand}`, borderRadius: 7, padding: "4px 10px", width: 180, fontFamily: "inherit", outline: "none" }}
                    />
                    <button onClick={saveGoal} disabled={saving} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 7, backgroundColor: clr.brand, border: "none", cursor: "pointer", color: "#fff" }}>
                      <Check size={16} />
                    </button>
                    <button onClick={() => { setEditing(false); setSaveError(null); }} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 7, backgroundColor: "#F0EEE9", border: "none", cursor: "pointer", color: clr.secondary }}>
                      <X size={16} />
                    </button>
                    {saveError && <p style={{ margin: 0, fontSize: 12, color: "#EF4444" }}>{saveError}</p>}
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
                    <span style={{ fontSize: 26, fontWeight: 800, color: clr.text }}>
                      {hasGoal ? fmt$(d.goal!) : "Not set"}
                    </span>
                    <button onClick={() => { setGoalInput(hasGoal ? String(d.goal) : ""); setEditing(true); }} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", fontSize: 12, fontWeight: 500, color: clr.secondary, backgroundColor: "#F0EEE9", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>
                      <Edit2 size={12} /> {hasGoal ? "Edit" : "Set Goal"}
                    </button>
                  </div>
                )}
              </div>
              {hasGoal && <GoalBadge status={d.status} />}
            </div>
            {hasGoal && (
              <div style={{ textAlign: "right" }}>
                <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: clr.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Projection</p>
                <p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: d.status === "on_track" ? "#10B981" : d.status === "at_risk" ? "#F59E0B" : "#EF4444" }}>{fmt$(d.projection)}</p>
                {d.gap != null && (
                  <p style={{ margin: "3px 0 0", fontSize: 12, color: d.gap <= 0 ? "#10B981" : clr.secondary }}>
                    {d.gap <= 0 ? `${fmt$(Math.abs(d.gap))} above goal` : `${fmt$(d.gap)} gap remaining`}
                  </p>
                )}
              </div>
            )}
          </div>

          {hasGoal && (
            <div style={{ marginTop: 8 }}>
              <GoalBar completed={d.completed_revenue} scheduled={d.scheduled_revenue} goal={d.goal!} />
            </div>
          )}

          {!hasGoal && (
            <p style={{ margin: "14px 0 0", fontSize: 13, color: clr.secondary }}>
              Set an annual revenue goal to track progress, see projections, and get an at-a-glance status for the year.
            </p>
          )}
        </div>

        {/* Revenue Breakdown Cards */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
          <MetricCard label="Completed Revenue" value={fmt$(d.completed_revenue)} sub={`${d.completed_jobs} jobs closed`} />
          <MetricCard label="Scheduled Revenue" value={fmt$(d.scheduled_revenue)} sub={`${d.scheduled_jobs} jobs booked`} subColor="#5B9BD5" />
          {hasGoal && <MetricCard label="Revenue Gap" value={d.gap != null && d.gap > 0 ? fmt$(d.gap) : "—"} sub={d.gap != null && d.gap <= 0 ? "Goal reached!" : "needed to hit goal"} subColor={d.gap != null && d.gap <= 0 ? "#10B981" : clr.secondary} />}
        </div>

        {/* Key Driver Metrics */}
        <div style={{ ...card, marginBottom: 0 }}>
          <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 700, color: clr.text }}>Key Driver Metrics</p>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <MetricCard
              label="Jobs Completed YTD"
              value={String(d.completed_jobs)}
              sub={d.target_jobs_ytd != null ? `Target: ${d.target_jobs_ytd} at this pace` : undefined}
            />
            <MetricCard
              label="Avg Invoice (Actual)"
              value={d.avg_invoice > 0 ? fmt$(d.avg_invoice) : "—"}
              sub="per completed job"
            />
            <MetricCard
              label="Avg Invoice Needed"
              value={d.required_avg_invoice != null && d.required_avg_invoice > 0 ? fmt$(d.required_avg_invoice) : "—"}
              sub="per remaining booked job to hit goal"
              subColor={
                d.required_avg_invoice != null && d.avg_invoice > 0
                  ? d.required_avg_invoice <= d.avg_invoice * 1.1
                    ? "#10B981"
                    : d.required_avg_invoice <= d.avg_invoice * 1.3
                      ? "#F59E0B"
                      : "#EF4444"
                  : clr.secondary
              }
            />
            <MetricCard
              label="New Clients YTD"
              value={String(d.new_clients_this_year)}
              sub={clientDeltaLabel}
              subColor={clientDeltaColor}
            />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
