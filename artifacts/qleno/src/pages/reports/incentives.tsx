import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X, DollarSign, Check, AlertTriangle } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers } });
  if (!r.ok) { const t = await r.text(); throw new Error(t); }
  return r.json();
}

const TYPE_LABELS: Record<string, string> = {
  performance: "Performance", attendance: "Attendance", retention: "Retention",
  referral: "Referral", custom: "Custom",
};
const REWARD_LABELS: Record<string, string> = { cash: "Cash", gift_card: "Gift Card", pto: "PTO", other: "Other" };

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  pending_approval: { bg: "#FEF3C7", color: "#92400E", label: "Pending Approval" },
  approved:         { bg: "#DBEAFE", color: "#1E40AF", label: "Approved" },
  rejected:         { bg: "#F3F4F6", color: "#6B7280", label: "Rejected" },
  paid:             { bg: "#DCFCE7", color: "#166534", label: "Paid" },
};

const TEMPLATES = [
  { name: "Perfect Attendance — Month", type: "attendance", trigger_metric: "Zero absences in calendar month", threshold_value: "", reward_amount: "50", reward_type: "cash" },
  { name: "Client Referral Bonus", type: "referral", trigger_metric: "New client referred and completed first job", threshold_value: "", reward_amount: "75", reward_type: "cash" },
  { name: "6-Month Retention Bonus", type: "retention", trigger_metric: "Active employment at 6-month mark", threshold_value: "180", reward_amount: "150", reward_type: "cash" },
  { name: "Top Performer of the Week", type: "performance", trigger_metric: "Highest avg rating for the week", threshold_value: "", reward_amount: "25", reward_type: "cash" },
];

const EMPTY_PROG = { name: "", type: "performance", trigger_metric: "", threshold_value: "", reward_amount: "", reward_type: "cash", monthly_budget_cap: "", effective_date: "" };
const EMPTY_AWARD = { employee_id: "", program_id: "", earned_date: new Date().toISOString().split("T")[0], amount: "", notes: "" };

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} style={{ padding: "14px 20px" }}>
          <div style={{ height: 14, background: "#F0EEE9", borderRadius: 4, width: i === 0 ? "70%" : "50%" }} />
        </td>
      ))}
    </tr>
  );
}

export default function IncentivesPage() {
  const qc = useQueryClient();
  const isOwner = getTokenRole() === "owner";

  const [tab, setTab] = useState<"programs" | "awards">("programs");
  const [progDrawer, setProgDrawer] = useState(false);
  const [awardModal, setAwardModal] = useState(false);
  const [rejectModal, setRejectModal] = useState<{ id: number; note: string } | null>(null);
  const [form, setForm] = useState(EMPTY_PROG);
  const [award, setAward] = useState(EMPTY_AWARD);
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterEmployee, setFilterEmployee] = useState("");

  const { data: programs = [], isLoading: loadP } = useQuery<any[]>({
    queryKey: ["incentive-programs"],
    queryFn: () => apiFetch("/api/incentives/programs"),
  });

  const { data: earned = [], isLoading: loadE } = useQuery<any[]>({
    queryKey: ["incentive-earned", filterStatus, filterEmployee],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filterStatus !== "all") params.set("status", filterStatus);
      if (filterEmployee) params.set("employee_id", filterEmployee);
      return apiFetch(`/api/incentives/earned?${params}`);
    },
    enabled: tab === "awards",
  });

  const { data: pending = [], isLoading: loadPending } = useQuery<any[]>({
    queryKey: ["incentive-pending"],
    queryFn: () => apiFetch("/api/incentives/pending-approval"),
    enabled: isOwner && tab === "awards",
  });

  const { data: employees = [] } = useQuery<any[]>({
    queryKey: ["employees-list"],
    queryFn: () => apiFetch("/api/users?role=technician,team_lead"),
  });

  const createProg = useMutation({
    mutationFn: (body: any) => apiFetch("/api/incentives/programs", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["incentive-programs"] }); setProgDrawer(false); setForm(EMPTY_PROG); },
  });

  const createAward = useMutation({
    mutationFn: (body: any) => apiFetch("/api/incentives/award", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["incentive-earned", "incentive-pending", "incentive-unpaid"] }); setAwardModal(false); setAward(EMPTY_AWARD); },
  });

  const approveMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/incentives/${id}/approve`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["incentive-pending", "incentive-earned"] }); },
  });

  const rejectMut = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) => apiFetch(`/api/incentives/${id}/reject`, { method: "POST", body: JSON.stringify({ rejection_note: note }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["incentive-pending", "incentive-earned"] }); setRejectModal(null); },
  });

  function applyTemplate(t: typeof TEMPLATES[0]) {
    setForm(f => ({ ...f, name: t.name, type: t.type, trigger_metric: t.trigger_metric, threshold_value: t.threshold_value, reward_amount: t.reward_amount, reward_type: t.reward_type }));
  }

  const tabStyle = (id: string) => ({
    padding: "8px 16px", border: "none", background: "none", cursor: "pointer", fontSize: 13,
    fontWeight: tab === id ? 700 : 400, color: tab === id ? "var(--brand)" : "#6B7280",
    borderBottom: `2px solid ${tab === id ? "var(--brand)" : "transparent"}`, fontFamily: FF,
  } as React.CSSProperties);

  const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 };
  const inputStyle: React.CSSProperties = { width: "100%", height: 36, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: FF };
  const selectStyle: React.CSSProperties = { width: "100%", height: 36, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#FFFFFF", boxSizing: "border-box", fontFamily: FF };

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, fontFamily: FF }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>Incentive Programs</h1>
            <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>Reward your team for performance, attendance, and loyalty</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setAwardModal(true)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 14px", backgroundColor: "#FFFFFF", color: "var(--brand)", border: "1px solid var(--brand)", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
              <DollarSign size={13} /> Award Incentive
            </button>
            <button onClick={() => setProgDrawer(true)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
              <Plus size={14} /> New Program
            </button>
          </div>
        </div>

        {/* Pending alert (owner only) */}
        {isOwner && pending.length > 0 && tab !== "awards" && (
          <div onClick={() => setTab("awards")} style={{ backgroundColor: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 8, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <AlertTriangle size={16} style={{ color: "#92400E" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "#92400E" }}>{pending.length} incentive award{pending.length !== 1 ? "s" : ""} pending your approval</span>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "#92400E", textDecoration: "underline" }}>Review</span>
          </div>
        )}

        {/* Tabs */}
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ borderBottom: "1px solid #EEECE7", display: "flex", paddingLeft: 4 }}>
            <button style={tabStyle("programs")} onClick={() => setTab("programs")}>Programs</button>
            <button style={tabStyle("awards")} onClick={() => setTab("awards")}>
              Awards {isOwner && pending.length > 0 ? `(${pending.length} pending)` : ""}
            </button>
          </div>

          {/* ── PROGRAMS TAB ── */}
          {tab === "programs" && (
            <div>
              {loadP ? (
                <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>{[1,2,3].map(i => <SkeletonRow key={i} cols={5} />)}</tbody></table>
              ) : programs.length === 0 ? (
                <div style={{ padding: 48, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>No programs yet — click "New Program" to create the first one.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                      {["Program Name", "Type", "Trigger", "Reward", "Budget (MTD)"].map(h => (
                        <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {programs.map((p: any) => (
                      <tr key={p.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                        <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{p.name}</td>
                        <td style={{ padding: "14px 20px" }}>
                          <span style={{ padding: "2px 8px", backgroundColor: "#F0EEE9", borderRadius: 4, fontSize: 11, fontWeight: 600, color: "#6B7280" }}>{TYPE_LABELS[p.type]}</span>
                        </td>
                        <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280", maxWidth: 200 }}>
                          {p.trigger_metric ? `${p.trigger_metric}${p.threshold_value ? ` ≥ ${p.threshold_value}` : ""}` : "Manual"}
                        </td>
                        <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 700, color: "#1A1917" }}>
                          ${parseFloat(p.reward_amount).toFixed(2)} <span style={{ fontSize: 11, fontWeight: 400, color: "#9E9B94" }}>({REWARD_LABELS[p.reward_type]})</span>
                        </td>
                        <td style={{ padding: "14px 20px", minWidth: 160 }}>
                          {p.monthly_budget_cap ? (
                            <div>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6B7280", marginBottom: 4 }}>
                                <span>${(p.mtd_awarded ?? 0).toFixed(2)} awarded</span>
                                <span>of ${parseFloat(p.monthly_budget_cap).toFixed(2)}</span>
                              </div>
                              <div style={{ height: 5, background: "#F0EEE9", borderRadius: 10 }}>
                                <div style={{ height: "100%", borderRadius: 10, background: "var(--brand)", width: `${Math.min(100, ((p.mtd_awarded ?? 0) / parseFloat(p.monthly_budget_cap)) * 100)}%`, transition: "width 0.4s" }} />
                              </div>
                            </div>
                          ) : (
                            <span style={{ fontSize: 12, color: "#9E9B94" }}>No cap set</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* ── AWARDS TAB ── */}
          {tab === "awards" && (
            <div>
              {/* Pending approval queue (owner only) */}
              {isOwner && pending.length > 0 && (
                <div style={{ borderBottom: "1px solid #EEECE7", background: "#FFFBEB" }}>
                  <div style={{ padding: "12px 20px", display: "flex", alignItems: "center", gap: 8 }}>
                    <AlertTriangle size={14} style={{ color: "#D97706" }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#92400E" }}>Pending Approval ({pending.length})</span>
                  </div>
                  {pending.map((p: any) => (
                    <div key={p.id} style={{ padding: "12px 20px", borderTop: "1px solid #FEF3C7", display: "flex", alignItems: "center", gap: 16 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{p.employee_name}</div>
                        <div style={{ fontSize: 12, color: "#6B7280" }}>{p.program_name} · ${parseFloat(p.amount).toFixed(2)} · Submitted by {p.awarded_by_name}</div>
                        {p.notes && <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>"{p.notes}"</div>}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => approveMut.mutate(p.id)}
                          style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", background: "#DCFCE7", color: "#166534", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                          <Check size={12} /> Approve
                        </button>
                        <button onClick={() => setRejectModal({ id: p.id, note: "" })}
                          style={{ padding: "6px 12px", background: "#FEE2E2", color: "#991B1B", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Filter bar */}
              <div style={{ padding: "12px 20px", borderBottom: "1px solid #EEECE7", display: "flex", gap: 10, flexWrap: "wrap" as const }}>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                  style={{ height: 34, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 12, background: "#FFFFFF", fontFamily: FF, color: "#1A1917" }}>
                  <option value="all">All Statuses</option>
                  {Object.entries(STATUS_STYLES).map(([v, s]) => <option key={v} value={v}>{s.label}</option>)}
                </select>
                <select value={filterEmployee} onChange={e => setFilterEmployee(e.target.value)}
                  style={{ height: 34, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 12, background: "#FFFFFF", fontFamily: FF, color: "#1A1917" }}>
                  <option value="">All Employees</option>
                  {employees.map((e: any) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                </select>
              </div>

              {/* Awards table */}
              {loadE ? (
                <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>{[1,2,3].map(i => <SkeletonRow key={i} cols={6} />)}</tbody></table>
              ) : earned.length === 0 ? (
                <div style={{ padding: 48, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>No awards found for current filters.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                      {["Employee", "Program", "Amount", "Earned Date", "Status", "Awarded By"].map(h => (
                        <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {earned.map((e: any) => {
                      const s = STATUS_STYLES[e.status] ?? STATUS_STYLES.approved;
                      return (
                        <tr key={e.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                          <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{e.employee_name}</td>
                          <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280" }}>{e.program_name}</td>
                          <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 700, color: "#166534" }}>${parseFloat(e.amount).toFixed(2)}</td>
                          <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280" }}>{new Date(e.earned_date + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                          <td style={{ padding: "14px 20px" }}>
                            <span style={{ padding: "2px 8px", backgroundColor: s.bg, color: s.color, borderRadius: 4, fontSize: 11, fontWeight: 700 }}>{s.label}</span>
                          </td>
                          <td style={{ padding: "14px 20px", fontSize: 12, color: "#6B7280" }}>{e.awarded_by_name || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── NEW PROGRAM DRAWER ── */}
      {progDrawer && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", display: "flex", justifyContent: "flex-end", zIndex: 1000 }}>
          <div style={{ backgroundColor: "#FFFFFF", width: 480, height: "100%", overflowY: "auto", padding: 28, boxShadow: "-8px 0 40px rgba(0,0,0,0.15)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1A1917" }}>New Incentive Program</h3>
              <button onClick={() => { setProgDrawer(false); setForm(EMPTY_PROG); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}><X size={18} /></button>
            </div>

            {/* Templates */}
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase" as const, letterSpacing: "0.06em", margin: "0 0 8px" }}>Quick Templates</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {TEMPLATES.map((t, i) => (
                  <button key={i} onClick={() => applyTemplate(t)}
                    style={{ padding: "8px 12px", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 12, color: "#1A1917", cursor: "pointer", textAlign: "left", fontFamily: FF, fontWeight: 500 }}>
                    {t.name}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ borderTop: "1px solid #EEECE7", paddingTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={labelStyle}>Program Name</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} style={inputStyle} placeholder="e.g. Perfect Attendance Bonus" />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={labelStyle}>Type</label>
                  <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))} style={selectStyle}>
                    {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Reward Type</label>
                  <select value={form.reward_type} onChange={e => setForm(p => ({ ...p, reward_type: e.target.value }))} style={selectStyle}>
                    {Object.entries(REWARD_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label style={labelStyle}>Trigger Description</label>
                <input value={form.trigger_metric} onChange={e => setForm(p => ({ ...p, trigger_metric: e.target.value }))} style={inputStyle} placeholder="What triggers this reward?" />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={labelStyle}>Reward Amount ($)</label>
                  <input type="number" value={form.reward_amount} onChange={e => setForm(p => ({ ...p, reward_amount: e.target.value }))} style={inputStyle} placeholder="0.00" />
                </div>
                <div>
                  <label style={labelStyle}>Threshold (optional)</label>
                  <input type="number" value={form.threshold_value} onChange={e => setForm(p => ({ ...p, threshold_value: e.target.value }))} style={inputStyle} placeholder="e.g. 20" />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={labelStyle}>Monthly Budget Cap ($) <span style={{ textTransform: "none", fontWeight: 400 }}>optional</span></label>
                  <input type="number" value={form.monthly_budget_cap} onChange={e => setForm(p => ({ ...p, monthly_budget_cap: e.target.value }))} style={inputStyle} placeholder="No cap" />
                </div>
                <div>
                  <label style={labelStyle}>Effective Date</label>
                  <input type="date" value={form.effective_date} onChange={e => setForm(p => ({ ...p, effective_date: e.target.value }))} style={inputStyle} />
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 24 }}>
              <button onClick={() => { setProgDrawer(false); setForm(EMPTY_PROG); }} style={{ padding: "9px 16px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button
                onClick={() => createProg.mutate({
                  name: form.name, type: form.type,
                  trigger_metric: form.trigger_metric || null,
                  threshold_value: form.threshold_value || null,
                  reward_amount: parseFloat(form.reward_amount),
                  reward_type: form.reward_type,
                  monthly_budget_cap: form.monthly_budget_cap ? parseFloat(form.monthly_budget_cap) : null,
                  effective_date: form.effective_date || null,
                })}
                disabled={!form.name || !form.reward_amount || createProg.isPending}
                style={{ padding: "9px 20px", background: !form.name || !form.reward_amount ? "#E5E2DC" : "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: form.name && form.reward_amount ? "pointer" : "not-allowed", fontFamily: FF }}>
                {createProg.isPending ? "Creating..." : "Create Program"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── AWARD MODAL ── */}
      {awardModal && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, width: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1A1917" }}>Award Incentive</h3>
              <button onClick={() => setAwardModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}><X size={16} /></button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={labelStyle}>Employee</label>
                <select value={award.employee_id} onChange={e => setAward(p => ({ ...p, employee_id: e.target.value }))} style={selectStyle}>
                  <option value="">Select employee…</option>
                  {employees.map((e: any) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Program</label>
                <select value={award.program_id} onChange={e => {
                  const prog = programs.find((p: any) => p.id === parseInt(e.target.value));
                  setAward(p => ({ ...p, program_id: e.target.value, amount: prog ? parseFloat(prog.reward_amount).toFixed(2) : p.amount }));
                }} style={selectStyle}>
                  <option value="">Select program…</option>
                  {programs.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={labelStyle}>Amount ($)</label>
                  <input type="number" value={award.amount} onChange={e => setAward(p => ({ ...p, amount: e.target.value }))} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Earned Date</label>
                  <input type="date" value={award.earned_date} onChange={e => setAward(p => ({ ...p, earned_date: e.target.value }))} style={inputStyle} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Notes (optional)</label>
                <input value={award.notes} onChange={e => setAward(p => ({ ...p, notes: e.target.value }))} style={inputStyle} placeholder="Why is this award being given?" />
              </div>
              {!isOwner && (
                <div style={{ background: "#F0F9FF", border: "1px solid #BAE6FD", borderRadius: 7, padding: "10px 12px", fontSize: 12, color: "#0369A1" }}>
                  This award will be submitted for owner approval before it is finalized.
                </div>
              )}
              {createAward.isError && (
                <div style={{ background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 7, padding: "10px 12px", fontSize: 12, color: "#991B1B" }}>
                  {(createAward.error as any)?.message || "Failed to award incentive"}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
              <button onClick={() => setAwardModal(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button
                onClick={() => createAward.mutate({ employee_id: award.employee_id, program_id: award.program_id, earned_date: award.earned_date, amount: parseFloat(award.amount), notes: award.notes || null })}
                disabled={!award.employee_id || !award.program_id || !award.amount || createAward.isPending}
                style={{ padding: "8px 20px", background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                {createAward.isPending ? "Submitting..." : isOwner ? "Award" : "Submit for Approval"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── REJECT MODAL ── */}
      {rejectModal && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}>
          <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, width: 400, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#1A1917" }}>Reject Award</h3>
            <label style={labelStyle}>Rejection Reason (required)</label>
            <textarea value={rejectModal.note} onChange={e => setRejectModal(r => r ? { ...r, note: e.target.value } : null)} rows={3}
              placeholder="Explain why this award is being rejected…"
              style={{ width: "100%", padding: "10px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, resize: "vertical" as const, fontFamily: FF, outline: "none", boxSizing: "border-box" as const, marginBottom: 16 }} />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setRejectModal(null)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button
                onClick={() => rejectMut.mutate({ id: rejectModal.id, note: rejectModal.note })}
                disabled={!rejectModal.note || rejectMut.isPending}
                style={{ padding: "8px 16px", background: "#991B1B", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: rejectModal.note ? "pointer" : "not-allowed", fontFamily: FF }}>
                {rejectMut.isPending ? "Rejecting..." : "Confirm Reject"}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
