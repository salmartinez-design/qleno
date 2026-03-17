import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, X, CheckCircle, DollarSign } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const TYPE_LABELS: Record<string, string> = {
  performance: "Performance", attendance: "Attendance", retention: "Retention",
  referral: "Referral", custom: "Custom",
};
const REWARD_LABELS: Record<string, string> = { cash: "Cash", gift_card: "Gift Card", pto: "PTO", other: "Other" };

const EMPTY_PROG = { name: "", type: "performance", trigger_metric: "", threshold_value: "", reward_amount: "", reward_type: "cash", effective_date: "" };
const EMPTY_AWARD = { employee_id: "", program_id: "", earned_date: new Date().toISOString().split("T")[0], amount: "", notes: "" };

export default function IncentivesPage() {
  const qc = useQueryClient();
  const [progModal, setProgModal] = useState(false);
  const [awardModal, setAwardModal] = useState(false);
  const [form, setForm] = useState(EMPTY_PROG);
  const [award, setAward] = useState(EMPTY_AWARD);
  const [tab, setTab] = useState<"programs" | "earned" | "unpaid">("programs");

  const { data: programs = [], isLoading: loadP } = useQuery<any[]>({
    queryKey: ["incentive-programs"],
    queryFn: () => apiFetch("/api/incentives/programs"),
  });

  const { data: earned = [], isLoading: loadE } = useQuery<any[]>({
    queryKey: ["incentive-earned"],
    queryFn: () => apiFetch("/api/incentives/earned"),
    enabled: tab === "earned",
  });

  const { data: unpaid = [], isLoading: loadU } = useQuery<any[]>({
    queryKey: ["incentive-unpaid"],
    queryFn: () => apiFetch("/api/incentives/unpaid"),
    enabled: tab === "unpaid",
  });

  const createProg = useMutation({
    mutationFn: (body: any) => apiFetch("/api/incentives/programs", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["incentive-programs"] }); setProgModal(false); setForm(EMPTY_PROG); },
  });

  const createAward = useMutation({
    mutationFn: (body: any) => apiFetch("/api/incentives/award", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["incentive-earned", "incentive-unpaid"] }); setAwardModal(false); setAward(EMPTY_AWARD); },
  });

  const totalUnpaid = unpaid.reduce((s: number, u: any) => s + parseFloat(u.amount), 0);

  const tabStyle = (id: string) => ({
    padding: "8px 16px", border: "none", background: "none", cursor: "pointer", fontSize: 13,
    fontWeight: tab === id ? 700 : 400, color: tab === id ? "var(--brand)" : "#6B7280",
    borderBottom: `2px solid ${tab === id ? "var(--brand)" : "transparent"}`,
    fontFamily: FF,
  } as React.CSSProperties);

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
              <DollarSign size={13} /> Award
            </button>
            <button onClick={() => setProgModal(true)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
              <Plus size={14} /> New Program
            </button>
          </div>
        </div>

        {/* Unpaid banner */}
        {totalUnpaid > 0 && (
          <div style={{ backgroundColor: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 8, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
            <DollarSign size={16} style={{ color: "#92400E" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "#92400E" }}>${totalUnpaid.toFixed(2)} in unpaid incentives ready for payroll</span>
          </div>
        )}

        {/* Tabs */}
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ borderBottom: "1px solid #EEECE7", display: "flex", paddingLeft: 4 }}>
            <button style={tabStyle("programs")} onClick={() => setTab("programs")}>Programs</button>
            <button style={tabStyle("earned")} onClick={() => setTab("earned")}>Earned History</button>
            <button style={tabStyle("unpaid")} onClick={() => setTab("unpaid")}>Unpaid ({unpaid.length})</button>
          </div>

          {tab === "programs" && (
            <div>
              {loadP ? (
                <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /></div>
              ) : programs.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>No programs yet — click "New Program" to create the first one.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                      {["Program Name", "Type", "Trigger", "Reward", "Reward Type"].map(h => (
                        <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
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
                        <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280" }}>
                          {p.trigger_metric ? `${p.trigger_metric}${p.threshold_value ? ` ≥ ${p.threshold_value}` : ""}` : "Manual"}
                        </td>
                        <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 700, color: "#1A1917" }}>${parseFloat(p.reward_amount).toFixed(2)}</td>
                        <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280" }}>{REWARD_LABELS[p.reward_type]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === "earned" && (
            <div>
              {loadE ? (
                <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /></div>
              ) : earned.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>No earned incentives yet.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                      {["Employee", "Program", "Date", "Amount", "Paid"].map(h => (
                        <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {earned.map((e: any) => (
                      <tr key={e.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                        <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{e.employee_name}</td>
                        <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280" }}>{e.program_name}</td>
                        <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280" }}>{new Date(e.earned_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                        <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 700, color: "#166534" }}>${parseFloat(e.amount).toFixed(2)}</td>
                        <td style={{ padding: "14px 20px" }}>
                          {e.paid_date ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "#166534", background: "#DCFCE7", padding: "2px 8px", borderRadius: 4 }}>
                              <CheckCircle size={10} /> Paid
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, fontWeight: 600, color: "#92400E", background: "#FEF3C7", padding: "2px 8px", borderRadius: 4 }}>Pending</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === "unpaid" && (
            <div>
              {loadU ? (
                <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /></div>
              ) : unpaid.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#166534", fontSize: 13 }}>All incentives are paid out.</div>
              ) : (
                <>
                  <div style={{ padding: "14px 20px", borderBottom: "1px solid #EEECE7", backgroundColor: "#FEF3C7", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#92400E" }}>{unpaid.length} unpaid incentives</span>
                    <span style={{ fontSize: 14, fontWeight: 800, color: "#92400E" }}>Total: ${totalUnpaid.toFixed(2)}</span>
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                        {["Employee", "Program", "Earned Date", "Amount"].map(h => (
                          <th key={h} style={{ padding: "12px 20px", textAlign: "left", fontSize: 11, fontWeight: 500, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {unpaid.map((u: any) => (
                        <tr key={u.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                          <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{u.employee_name}</td>
                          <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280" }}>{u.program_name}</td>
                          <td style={{ padding: "14px 20px", fontSize: 13, color: "#6B7280" }}>{new Date(u.earned_date).toLocaleDateString()}</td>
                          <td style={{ padding: "14px 20px", fontSize: 13, fontWeight: 700, color: "#92400E" }}>${parseFloat(u.amount).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* New Program Modal */}
      {progModal && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, width: 480, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1A1917" }}>New Incentive Program</h3>
              <button onClick={() => setProgModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}><X size={16} /></button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[{ label: "Program Name", key: "name", type: "text" }].map(f => (
                <div key={f.key}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>{f.label}</label>
                  <input value={(form as any)[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                    style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box" as const }} />
                </div>
              ))}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Type</label>
                  <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}
                    style={{ width: "100%", height: 36, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#FFFFFF", boxSizing: "border-box" as const }}>
                    {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Reward Type</label>
                  <select value={form.reward_type} onChange={e => setForm(p => ({ ...p, reward_type: e.target.value }))}
                    style={{ width: "100%", height: 36, padding: "0 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#FFFFFF", boxSizing: "border-box" as const }}>
                    {Object.entries(REWARD_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Reward Amount ($)</label>
                  <input type="number" value={form.reward_amount} onChange={e => setForm(p => ({ ...p, reward_amount: e.target.value }))}
                    style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box" as const }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Trigger Metric</label>
                  <input value={form.trigger_metric} onChange={e => setForm(p => ({ ...p, trigger_metric: e.target.value }))}
                    placeholder="e.g. jobs_per_month"
                    style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box" as const }} />
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
              <button onClick={() => setProgModal(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={() => createProg.mutate({ name: form.name, type: form.type, trigger_metric: form.trigger_metric || null, threshold_value: form.threshold_value || null, reward_amount: parseFloat(form.reward_amount), reward_type: form.reward_type })}
                disabled={!form.name || !form.reward_amount}
                style={{ padding: "8px 20px", background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                {createProg.isPending ? "Creating..." : "Create Program"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </DashboardLayout>
  );
}
