import { useState, useEffect } from "react";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Plus, AlertTriangle, CheckCircle, Clock, X, Shield, Star } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...getAuthHeaders(), ...(opts?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 0", color: "#9E9B94", fontSize: 13, fontFamily: FF, background: "#FAFAF9", borderRadius: 10, border: "1px solid #E5E2DC" }}>
      {message}
    </div>
  );
}

const ATT_TYPE_STYLES: Record<string, { label: string; bg: string; color: string }> = {
  tardy:          { label: "Tardy",          bg: "#FEF3C7", color: "#92400E" },
  absent:         { label: "Absent",         bg: "#FEE2E2", color: "#991B1B" },
  ncns:           { label: "NCNS",           bg: "#F3E8FF", color: "#6D28D9" },
  plawa_leave:    { label: "Leave (PLAWA)",  bg: "#DCFCE7", color: "#166534" },
  protected_leave:{ label: "Protected Leave",bg: "#DBEAFE", color: "#1E40AF" },
  present:        { label: "Present",        bg: "#ECFDF5", color: "#065F46" },
};

const DISC_TYPE_STYLES: Record<string, { label: string; bg: string; color: string }> = {
  tardy_warning:    { label: "Tardy Warning",    bg: "#FEF3C7", color: "#92400E" },
  absence_warning:  { label: "Absence Warning",  bg: "#FEE2E2", color: "#991B1B" },
  final_warning:    { label: "Final Warning",    bg: "#FEE2E2", color: "#7F1D1D" },
  quality_probation:{ label: "Quality Probation",bg: "#F3E8FF", color: "#6D28D9" },
  termination:      { label: "Termination",      bg: "#FEE2E2", color: "#991B1B" },
  custom:           { label: "Custom",           bg: "#F3F4F6", color: "#374151" },
};

function Tag({ type, map }: { type: string; map: Record<string, { label: string; bg: string; color: string }> }) {
  const s = map[type] ?? { label: type, bg: "#F3F4F6", color: "#374151" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: s.bg, color: s.color, fontFamily: FF }}>
      {s.label}
    </span>
  );
}

function fmtDate(d: string) {
  if (!d) return "—";
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function HRAttendanceTab({ employeeId }: { employeeId: number }) {
  const role = getTokenRole();
  const canLog = role === "owner" || role === "admin" || role === "office";
  const { toast } = useToast();
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ log_date: new Date().toISOString().slice(0, 10), type: "tardy", protected: false, notes: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch(`/hr-attendance?employee_id=${employeeId}`)
      .then(setLogs)
      .catch(() => toast({ title: "Failed to load attendance", variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [employeeId]);

  async function submit() {
    setSaving(true);
    try {
      const entry = await apiFetch("/hr-attendance", { method: "POST", body: JSON.stringify({ ...form, employee_id: employeeId }) });
      setLogs(prev => [entry, ...prev]);
      setShowModal(false);
      toast({ title: "Attendance logged" });
    } catch {
      toast({ title: "Failed to log attendance", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const yearCounts = logs.reduce((acc: any, l: any) => {
    if (!l.protected) {
      acc[l.type] = (acc[l.type] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  if (loading) return <div style={{ padding: 32, textAlign: "center", color: "#9CA3AF", fontFamily: FF }}>Loading…</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {Object.entries(yearCounts).map(([type, cnt]: any) => (
            <span key={type} style={{
              fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 20, fontFamily: FF,
              background: ATT_TYPE_STYLES[type]?.bg ?? "#F3F4F6",
              color: ATT_TYPE_STYLES[type]?.color ?? "#374151",
            }}>
              {ATT_TYPE_STYLES[type]?.label ?? type}: {cnt}
            </span>
          ))}
        </div>
        {canLog && (
          <button onClick={() => setShowModal(true)} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "8px 16px",
            background: "var(--brand)", color: "#fff", border: "none", borderRadius: 8,
            fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF,
          }}>
            <Plus size={14} /> Log Event
          </button>
        )}
      </div>

      {!logs.length && <EmptyState message="No attendance events logged yet" />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {logs.map((l: any) => (
          <div key={l.id} style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 18px", display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <Tag type={l.type} map={ATT_TYPE_STYLES} />
                {l.protected && (
                  <span style={{ fontSize: 11, background: "#DBEAFE", color: "#1E40AF", padding: "2px 8px", borderRadius: 20, fontWeight: 600, fontFamily: FF }}>
                    Protected
                  </span>
                )}
                <span style={{ fontSize: 12, color: "#6B7280", fontFamily: FF }}>{fmtDate(l.log_date)}</span>
              </div>
              {l.notes && <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF }}>{l.notes}</div>}
            </div>
            {(l.logger_first_name || l.logger_last_name) && (
              <div style={{ fontSize: 11, color: "#9CA3AF", fontFamily: FF, textAlign: "right" }}>
                Logged by<br />{l.logger_first_name} {l.logger_last_name}
              </div>
            )}
          </div>
        ))}
      </div>

      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 28, width: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Log Attendance Event</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 4, fontFamily: FF }}>Date</label>
                <input type="date" value={form.log_date} onChange={e => setForm(p => ({ ...p, log_date: e.target.value }))}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 4, fontFamily: FF }}>Type</label>
                <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, background: "#fff", outline: "none" }}>
                  {Object.entries(ATT_TYPE_STYLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={form.protected} onChange={e => setForm(p => ({ ...p, protected: e.target.checked }))} />
                <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>Protected absence (does not count toward discipline thresholds)</span>
              </label>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 4, fontFamily: FF }}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={3}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, resize: "vertical", outline: "none", boxSizing: "border-box" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setShowModal(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#fff", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={submit} disabled={saving} style={{ padding: "8px 16px", background: "#0A0E1A", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", fontFamily: FF, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Log Event"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function LeaveBalanceTab({ employeeId }: { employeeId: number }) {
  const role = getTokenRole();
  const canLog = role === "owner" || role === "admin" || role === "office";
  const { toast } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ date_used: new Date().toISOString().slice(0, 10), hours: "", notes: "" });
  const [saving, setSaving] = useState(false);

  function load() {
    apiFetch(`/hr-leave/balance/${employeeId}`)
      .then(setData)
      .catch(() => toast({ title: "Failed to load leave balance", variant: "destructive" }))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [employeeId]);

  async function submit() {
    setSaving(true);
    try {
      const result = await apiFetch("/hr-leave/use", { method: "POST", body: JSON.stringify({ employee_id: employeeId, ...form }) });
      setData((d: any) => ({ ...d, leave_balance_hours: result.new_balance, usage: [result.usage, ...(d.usage || [])] }));
      setShowModal(false);
      toast({ title: "Leave usage recorded" });
    } catch {
      toast({ title: "Failed to log leave usage", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 32, textAlign: "center", color: "#9CA3AF", fontFamily: FF }}>Loading…</div>;
  if (!data) return <EmptyState message="Could not load leave data" />;

  const policy = data.policy;
  const activated = data.leave_balance_activated;

  return (
    <div>
      {!policy?.leave_program_enabled && (
        <div style={{ background: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: 8, padding: "16px 20px", marginBottom: 20, fontSize: 13, color: "#6B7280", fontFamily: FF }}>
          No leave program is configured. Enable it in Company Settings under HR Policies.
        </div>
      )}

      {policy?.leave_program_enabled && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
            <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, marginBottom: 6 }}>Balance</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: activated ? "var(--brand)" : "#9CA3AF", fontFamily: FF }}>{parseFloat(data.leave_balance_hours || "0").toFixed(1)}</div>
              <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF }}>hours available</div>
            </div>
            <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, marginBottom: 6 }}>Status</div>
              <div style={{ fontSize: 13, fontWeight: 600, fontFamily: FF, color: activated ? "#166534" : "#92400E" }}>
                {activated ? "Active" : "Not yet eligible"}
              </div>
              {!activated && data.activation_date && (
                <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF, marginTop: 2 }}>
                  Eligible from {fmtDate(data.activation_date)}
                </div>
              )}
            </div>
            <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, marginBottom: 6 }}>Program</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{policy.leave_program_name}</div>
              <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF }}>
                {policy.leave_grant_method === "front_loaded" ? `${policy.leave_hours_granted} hrs front-loaded` : "Accrual-based"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>Usage History</h3>
            {canLog && activated && (
              <button onClick={() => setShowModal(true)} style={{
                display: "flex", alignItems: "center", gap: 6, padding: "8px 16px",
                background: "var(--brand)", color: "#fff", border: "none", borderRadius: 8,
                fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF,
              }}>
                <Plus size={14} /> Log Leave Usage
              </button>
            )}
          </div>

          {!(data.usage || []).length && <EmptyState message="No leave usage recorded yet" />}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(data.usage || []).map((u: any) => (
              <div key={u.id} style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{fmtDate(u.date_used)}</div>
                  {u.notes && <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF, marginTop: 2 }}>{u.notes}</div>}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#991B1B", fontFamily: FF }}>−{parseFloat(u.hours).toFixed(1)} hrs</div>
              </div>
            ))}
          </div>
        </>
      )}

      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 28, width: 400, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Log Leave Usage</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: "block", marginBottom: 4, fontFamily: FF }}>Date</label>
                <input type="date" value={form.date_used} onChange={e => setForm(p => ({ ...p, date_used: e.target.value }))}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: "block", marginBottom: 4, fontFamily: FF }}>Hours Used</label>
                <input type="number" min={0.5} step={0.5} value={form.hours} onChange={e => setForm(p => ({ ...p, hours: e.target.value }))}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: "block", marginBottom: 4, fontFamily: FF }}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, resize: "vertical", outline: "none", boxSizing: "border-box" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setShowModal(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#fff", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={submit} disabled={saving} style={{ padding: "8px 16px", background: "#0A0E1A", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", fontFamily: FF, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Log Usage"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function DisciplineTab({ employeeId }: { employeeId: number }) {
  const role = getTokenRole();
  const isOwner = role === "owner";
  const canCreate = role === "owner" || role === "admin";
  const { toast } = useToast();
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ discipline_type: "tardy_warning", custom_label: "", reason: "", effective_date: new Date().toISOString().slice(0, 10) });
  const [saving, setSaving] = useState(false);

  function load() {
    apiFetch(`/hr-discipline?employee_id=${employeeId}`)
      .then(setRecords)
      .catch(() => toast({ title: "Failed to load discipline records", variant: "destructive" }))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [employeeId]);

  async function submit() {
    setSaving(true);
    try {
      const entry = await apiFetch("/hr-discipline", { method: "POST", body: JSON.stringify({ ...form, employee_id: employeeId }) });
      setRecords(prev => [entry, ...prev]);
      setShowModal(false);
      toast({ title: "Discipline record added" });
    } catch {
      toast({ title: "Failed to add record", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function confirm(id: number) {
    try {
      const updated = await apiFetch(`/hr-discipline/${id}/confirm`, { method: "PUT" });
      setRecords(prev => prev.map(r => r.id === id ? updated : r));
      toast({ title: "Record confirmed" });
    } catch {
      toast({ title: "Failed to confirm", variant: "destructive" });
    }
  }

  async function dismiss(id: number) {
    try {
      const updated = await apiFetch(`/hr-discipline/${id}/dismiss`, { method: "PUT" });
      setRecords(prev => prev.map(r => r.id === id ? updated : r));
      toast({ title: "Record dismissed" });
    } catch {
      toast({ title: "Failed to dismiss", variant: "destructive" });
    }
  }

  if (loading) return <div style={{ padding: 32, textAlign: "center", color: "#9CA3AF", fontFamily: FF }}>Loading…</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        {canCreate && (
          <button onClick={() => setShowModal(true)} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "8px 16px",
            background: "var(--brand)", color: "#fff", border: "none", borderRadius: 8,
            fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF,
          }}>
            <Plus size={14} /> Add Record
          </button>
        )}
      </div>

      {!records.length && <EmptyState message="No discipline records on file" />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {records.map((r: any) => (
          <div key={r.id} style={{
            background: "#fff", border: `1px solid ${r.pending_review ? "#FED7AA" : "#E5E2DC"}`,
            borderRadius: 10, padding: "14px 18px",
            opacity: r.dismissed ? 0.55 : 1,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Tag type={r.discipline_type} map={DISC_TYPE_STYLES} />
                {r.custom_label && <span style={{ fontSize: 12, color: "#374151", fontFamily: FF }}>{r.custom_label}</span>}
                {r.pending_review && (
                  <span style={{ fontSize: 11, background: "#FEF3C7", color: "#92400E", padding: "2px 8px", borderRadius: 20, fontWeight: 600, fontFamily: FF }}>
                    Pending Review
                  </span>
                )}
                {r.dismissed && (
                  <span style={{ fontSize: 11, background: "#F3F4F6", color: "#6B7280", padding: "2px 8px", borderRadius: 20, fontWeight: 600, fontFamily: FF }}>
                    Dismissed
                  </span>
                )}
              </div>
              <span style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF }}>{fmtDate(r.effective_date)}</span>
            </div>
            {r.reason && <p style={{ fontSize: 13, color: "#374151", margin: "0 0 6px", fontFamily: FF }}>{r.reason}</p>}
            {(r.issuer_first_name || r.issuer_last_name) && (
              <div style={{ fontSize: 11, color: "#9CA3AF", fontFamily: FF }}>Issued by {r.issuer_first_name} {r.issuer_last_name}</div>
            )}
            {r.acknowledged && <div style={{ fontSize: 11, color: "#166534", fontFamily: FF, marginTop: 4 }}>Acknowledged {r.acknowledged_at ? new Date(r.acknowledged_at).toLocaleDateString() : ""}</div>}
            {isOwner && r.pending_review && !r.dismissed && (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button onClick={() => confirm(r.id)} style={{ padding: "5px 12px", fontSize: 12, background: "#0A0E1A", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: FF }}>
                  Confirm
                </button>
                <button onClick={() => dismiss(r.id)} style={{ padding: "5px 12px", fontSize: 12, background: "#fff", color: "#374151", border: "1px solid #E5E2DC", borderRadius: 6, cursor: "pointer", fontFamily: FF }}>
                  Dismiss
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 28, width: 460, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Add Discipline Record</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: "block", marginBottom: 4, fontFamily: FF }}>Type</label>
                <select value={form.discipline_type} onChange={e => setForm(p => ({ ...p, discipline_type: e.target.value }))}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, background: "#fff", outline: "none" }}>
                  {Object.entries(DISC_TYPE_STYLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              {form.discipline_type === "custom" && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 500, display: "block", marginBottom: 4, fontFamily: FF }}>Custom Label</label>
                  <input value={form.custom_label} onChange={e => setForm(p => ({ ...p, custom_label: e.target.value }))}
                    style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, outline: "none", boxSizing: "border-box" }} />
                </div>
              )}
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: "block", marginBottom: 4, fontFamily: FF }}>Effective Date</label>
                <input type="date" value={form.effective_date} onChange={e => setForm(p => ({ ...p, effective_date: e.target.value }))}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: "block", marginBottom: 4, fontFamily: FF }}>Reason</label>
                <textarea value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} rows={3}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, resize: "vertical", outline: "none", boxSizing: "border-box" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setShowModal(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#fff", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={submit} disabled={saving} style={{ padding: "8px 16px", background: "#0A0E1A", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", fontFamily: FF, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Add Record"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function QualityTab({ employeeId }: { employeeId: number }) {
  const role = getTokenRole();
  const canLog = role === "owner" || role === "admin" || role === "office";
  const canValidate = role === "owner" || role === "admin";
  const { toast } = useToast();
  const [complaints, setComplaints] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ complaint_date: new Date().toISOString().slice(0, 10), description: "", re_clean_required: false });
  const [saving, setSaving] = useState(false);

  function load() {
    apiFetch(`/hr-quality/complaints?employee_id=${employeeId}`)
      .then(setComplaints)
      .catch(() => toast({ title: "Failed to load complaints", variant: "destructive" }))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [employeeId]);

  async function submit() {
    setSaving(true);
    try {
      const entry = await apiFetch("/hr-quality/complaints", { method: "POST", body: JSON.stringify({ ...form, employee_id: employeeId }) });
      setComplaints(prev => [entry, ...prev]);
      setShowModal(false);
      toast({ title: "Complaint logged" });
    } catch {
      toast({ title: "Failed to log complaint", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function validate(id: number, valid: boolean) {
    try {
      const updated = await apiFetch(`/hr-quality/complaints/${id}/validate`, {
        method: "PUT",
        body: JSON.stringify({ valid }),
      });
      setComplaints(prev => prev.map(c => c.id === id ? updated : c));
      toast({ title: valid ? "Marked as valid" : "Marked as not valid" });
    } catch {
      toast({ title: "Failed to update", variant: "destructive" });
    }
  }

  const validCount = complaints.filter(c => c.valid).length;
  const pendingCount = complaints.filter(c => !c.validated_at).length;

  if (loading) return <div style={{ padding: 32, textAlign: "center", color: "#9CA3AF", fontFamily: FF }}>Loading…</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ background: "#FEE2E2", border: "1px solid #FECACA", borderRadius: 8, padding: "10px 16px" }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#991B1B", fontFamily: FF }}>{validCount}</div>
          <div style={{ fontSize: 11, color: "#991B1B", fontFamily: FF }}>Valid complaints</div>
        </div>
        <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 16px" }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#92400E", fontFamily: FF }}>{pendingCount}</div>
          <div style={{ fontSize: 11, color: "#92400E", fontFamily: FF }}>Pending validation</div>
        </div>
        <div style={{ flex: 1 }} />
        {canLog && (
          <button onClick={() => setShowModal(true)} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "8px 16px",
            background: "var(--brand)", color: "#fff", border: "none", borderRadius: 8,
            fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF,
          }}>
            <Plus size={14} /> Log Complaint
          </button>
        )}
      </div>

      {!complaints.length && <EmptyState message="No quality complaints on file" />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {complaints.map((c: any) => (
          <div key={c.id} style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "14px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {c.valid ? (
                  <span style={{ fontSize: 11, background: "#FEE2E2", color: "#991B1B", padding: "2px 8px", borderRadius: 20, fontWeight: 600, fontFamily: FF }}>Valid</span>
                ) : c.validated_at ? (
                  <span style={{ fontSize: 11, background: "#DCFCE7", color: "#166534", padding: "2px 8px", borderRadius: 20, fontWeight: 600, fontFamily: FF }}>Not Valid</span>
                ) : (
                  <span style={{ fontSize: 11, background: "#FEF3C7", color: "#92400E", padding: "2px 8px", borderRadius: 20, fontWeight: 600, fontFamily: FF }}>Pending</span>
                )}
                {c.re_clean_required && (
                  <span style={{ fontSize: 11, background: "#FEF3C7", color: "#92400E", padding: "2px 8px", borderRadius: 20, fontWeight: 600, fontFamily: FF }}>Re-clean required</span>
                )}
              </div>
              <span style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF }}>{fmtDate(c.complaint_date)}</span>
            </div>
            {c.description && <p style={{ fontSize: 13, color: "#374151", margin: "0 0 6px", fontFamily: FF }}>{c.description}</p>}
            {c.validator_name && (
              <div style={{ fontSize: 11, color: "#9CA3AF", fontFamily: FF }}>
                Validated by {c.validator_name} {c.validated_at ? `on ${new Date(c.validated_at).toLocaleDateString()}` : ""}
              </div>
            )}
            {canValidate && !c.validated_at && (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button onClick={() => validate(c.id, true)} style={{ padding: "5px 12px", fontSize: 12, background: "#FEE2E2", color: "#991B1B", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: FF, fontWeight: 600 }}>
                  Mark Valid
                </button>
                <button onClick={() => validate(c.id, false)} style={{ padding: "5px 12px", fontSize: 12, background: "#DCFCE7", color: "#166534", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: FF, fontWeight: 600 }}>
                  Mark Not Valid
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 28, width: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Log Quality Complaint</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: "block", marginBottom: 4, fontFamily: FF }}>Date</label>
                <input type="date" value={form.complaint_date} onChange={e => setForm(p => ({ ...p, complaint_date: e.target.value }))}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, display: "block", marginBottom: 4, fontFamily: FF }}>Description</label>
                <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={3}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, resize: "vertical", outline: "none", boxSizing: "border-box" }} />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={form.re_clean_required} onChange={e => setForm(p => ({ ...p, re_clean_required: e.target.checked }))} />
                <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>Re-clean required</span>
              </label>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setShowModal(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, background: "#fff", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              <button onClick={submit} disabled={saving} style={{ padding: "8px 16px", background: "#0A0E1A", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", fontFamily: FF, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Log Complaint"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

