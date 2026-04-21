import { useState, useEffect } from "react";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronUp, AlertTriangle, Plus, Trash2, Save } from "lucide-react";

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

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 24, padding: "14px 0", borderBottom: "1px solid #F3F4F6" }}>
      <div style={{ minWidth: 240, flex: "0 0 240px" }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1917", fontFamily: FF }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2, fontFamily: FF }}>{hint}</div>}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function Input({ value, onChange, type = "text", min, max, step, style }: any) {
  return (
    <input
      type={type}
      value={value ?? ""}
      min={min}
      max={max}
      step={step}
      onChange={e => onChange(type === "number" ? (e.target.value === "" ? "" : parseFloat(e.target.value)) : e.target.value)}
      style={{
        width: "100%", padding: "7px 10px", fontSize: 13, fontFamily: FF,
        border: "1px solid #E5E7EB", borderRadius: 6, outline: "none",
        background: "#FAFAFA", color: "#1A1917", boxSizing: "border-box", ...style,
      }}
    />
  );
}

function Select({ value, onChange, children, style }: any) {
  return (
    <select
      value={value ?? ""}
      onChange={e => onChange(e.target.value)}
      style={{
        padding: "7px 10px", fontSize: 13, fontFamily: FF,
        border: "1px solid #E5E7EB", borderRadius: 6, background: "#FAFAFA",
        color: "#1A1917", outline: "none", minWidth: 180, ...style,
      }}
    >
      {children}
    </select>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
      <div
        onClick={() => onChange(!value)}
        style={{
          width: 36, height: 20, borderRadius: 10, position: "relative", cursor: "pointer", flexShrink: 0,
          background: value ? "var(--brand)" : "#D1D5DB", transition: "background 0.2s",
        }}
      >
        <div style={{
          position: "absolute", top: 2, left: value ? 18 : 2,
          width: 16, height: 16, borderRadius: "50%", background: "#fff",
          transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }} />
      </div>
      {label && <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>{label}</span>}
    </label>
  );
}

function Accordion({ title, subtitle, children, defaultOpen = false }: { title: string; subtitle?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: "1px solid #E5E7EB", borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px", background: "#FAFAFA", border: "none", cursor: "pointer", textAlign: "left",
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#111827", fontFamily: FF }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2, fontFamily: FF }}>{subtitle}</div>}
        </div>
        {open ? <ChevronUp size={16} color="#6B7280" /> : <ChevronDown size={16} color="#6B7280" />}
      </button>
      {open && <div style={{ padding: "4px 20px 20px" }}>{children}</div>}
    </div>
  );
}

function SaveButton({ onClick, saving }: { onClick: () => void; saving: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
      <button
        onClick={onClick}
        disabled={saving}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "8px 18px",
          background: "#0A0E1A", color: "#fff", border: "none", borderRadius: 7,
          fontSize: 13, fontWeight: 500, fontFamily: FF, cursor: saving ? "not-allowed" : "pointer",
          opacity: saving ? 0.6 : 1,
        }}
      >
        <Save size={14} />
        {saving ? "Saving…" : "Save Changes"}
      </button>
    </div>
  );
}

interface StepRow {
  step: number;
  action: string;
  note?: string;
}

function StepsEditor({ steps, onChange, typeLabel }: { steps: StepRow[]; onChange: (s: StepRow[]) => void; typeLabel: string }) {
  function addStep() {
    const nextStep = (steps.length > 0 ? Math.max(...steps.map(s => s.step)) : 0) + 1;
    onChange([...steps, { step: nextStep, action: "record_only", note: "" }]);
  }
  function removeStep(i: number) {
    onChange(steps.filter((_, idx) => idx !== i));
  }
  function updateStep(i: number, field: keyof StepRow, val: any) {
    const updated = [...steps];
    updated[i] = { ...updated[i], [field]: val };
    onChange(updated);
  }
  return (
    <div>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF, minWidth: 60 }}>{typeLabel} #{s.step}</div>
          <Select value={s.action} onChange={(v: string) => updateStep(i, "action", v)} style={{ minWidth: 160 }}>
            <option value="record_only">Record only</option>
            <option value="verbal_warning">Verbal warning</option>
            <option value="written_warning">Written warning</option>
            <option value="final_warning">Final warning</option>
            <option value="termination">Termination eligible</option>
          </Select>
          <input
            value={s.note ?? ""}
            placeholder="Optional note"
            onChange={e => updateStep(i, "note", e.target.value)}
            style={{
              flex: 1, padding: "7px 10px", fontSize: 12, fontFamily: FF,
              border: "1px solid #E5E7EB", borderRadius: 6, background: "#FAFAFA", color: "#1A1917", outline: "none",
            }}
          />
          <button onClick={() => removeStep(i)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
            <Trash2 size={14} color="#EF4444" />
          </button>
        </div>
      ))}
      <button
        onClick={addStep}
        style={{
          display: "flex", alignItems: "center", gap: 6, marginTop: 4,
          fontSize: 12, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: FF,
        }}
      >
        <Plus size={13} /> Add Step
      </button>
    </div>
  );
}

interface Holiday {
  name: string;
  date: string;
}

function HolidayEditor({ holidays, onChange }: { holidays: Holiday[]; onChange: (h: Holiday[]) => void }) {
  function add() {
    onChange([...holidays, { name: "", date: "" }]);
  }
  function remove(i: number) {
    onChange(holidays.filter((_, idx) => idx !== i));
  }
  function update(i: number, field: keyof Holiday, val: string) {
    const updated = [...holidays];
    updated[i] = { ...updated[i], [field]: val };
    onChange(updated);
  }
  return (
    <div>
      {holidays.map((h, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <input
            value={h.name}
            placeholder="Holiday name"
            onChange={e => update(i, "name", e.target.value)}
            style={{
              flex: 1, padding: "7px 10px", fontSize: 12, fontFamily: FF,
              border: "1px solid #E5E7EB", borderRadius: 6, background: "#FAFAFA", color: "#1A1917", outline: "none",
            }}
          />
          <input
            type="date"
            value={h.date}
            onChange={e => update(i, "date", e.target.value)}
            style={{
              padding: "7px 10px", fontSize: 12, fontFamily: FF,
              border: "1px solid #E5E7EB", borderRadius: 6, background: "#FAFAFA", color: "#1A1917", outline: "none",
            }}
          />
          <button onClick={() => remove(i)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
            <Trash2 size={14} color="#EF4444" />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        style={{
          display: "flex", alignItems: "center", gap: 6, marginTop: 4,
          fontSize: 12, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: FF,
        }}
      >
        <Plus size={13} /> Add Holiday
      </button>
    </div>
  );
}

export function HRPoliciesTab() {
  const role = getTokenRole();
  const isOwner = role === "owner" || role === "super_admin";
  const { toast } = useToast();

  const [payPolicy, setPayPolicy] = useState<any>(null);
  const [attendancePolicy, setAttendancePolicy] = useState<any>(null);
  const [leavePolicy, setLeavePolicy] = useState<any>(null);
  const [savingPay, setSavingPay] = useState(false);
  const [savingAtt, setSavingAtt] = useState(false);
  const [savingLeave, setSavingLeave] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [p, a, l] = await Promise.all([
          apiFetch("/policy/pay"),
          apiFetch("/policy/attendance"),
          apiFetch("/policy/leave"),
        ]);
        setPayPolicy(p);
        setAttendancePolicy({ ...a, tardy_steps: a.tardy_steps || [], absence_steps: a.absence_steps || [] });
        setLeavePolicy({ ...l, holidays: l.holidays || [] });
      } catch {
        toast({ title: "Failed to load HR policies", variant: "destructive" });
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function savePay() {
    setSavingPay(true);
    try {
      const result = await apiFetch("/policy/pay", { method: "PUT", body: JSON.stringify(payPolicy) });
      setPayPolicy(result);
      toast({ title: "Pay policy saved" });
    } catch {
      toast({ title: "Failed to save pay policy", variant: "destructive" });
    } finally {
      setSavingPay(false);
    }
  }

  async function saveAttendance() {
    setSavingAtt(true);
    try {
      const result = await apiFetch("/policy/attendance", { method: "PUT", body: JSON.stringify(attendancePolicy) });
      setAttendancePolicy({ ...result, tardy_steps: result.tardy_steps || [], absence_steps: result.absence_steps || [] });
      toast({ title: "Attendance policy saved" });
    } catch {
      toast({ title: "Failed to save attendance policy", variant: "destructive" });
    } finally {
      setSavingAtt(false);
    }
  }

  async function saveLeave() {
    setSavingLeave(true);
    try {
      const result = await apiFetch("/policy/leave", { method: "PUT", body: JSON.stringify(leavePolicy) });
      setLeavePolicy({ ...result, holidays: result.holidays || [] });
      toast({ title: "Leave policy saved" });
    } catch {
      toast({ title: "Failed to save leave policy", variant: "destructive" });
    } finally {
      setSavingLeave(false);
    }
  }

  function setPay(field: string, val: any) {
    setPayPolicy((p: any) => ({ ...p, [field]: val }));
  }
  function setAtt(field: string, val: any) {
    setAttendancePolicy((a: any) => ({ ...a, [field]: val }));
  }
  function setLeave(field: string, val: any) {
    setLeavePolicy((l: any) => ({ ...l, [field]: val }));
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#6B7280", fontFamily: FF }}>Loading HR policies…</div>;

  return (
    <div>
      <div style={{
        background: "#FFF7ED", border: "1px solid #FED7AA", borderRadius: 8,
        padding: "14px 16px", marginBottom: 24, display: "flex", gap: 12, alignItems: "flex-start",
      }}>
        <AlertTriangle size={18} color="#C2410C" style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontFamily: FF, fontSize: 13, color: "#7C2D12", lineHeight: 1.5 }}>
          <strong>Legal Compliance Reminder</strong> — These settings define your internal company policies. They do not constitute legal advice and do not automatically satisfy any federal, state, or local employment law requirement. Consult a licensed employment attorney or HR professional before implementing or modifying these policies. Minimum wage floors, overtime obligations, and paid leave mandates vary by jurisdiction and must be reviewed independently.
        </div>
      </div>

      {!isOwner && (
        <div style={{
          background: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: 8,
          padding: "12px 16px", marginBottom: 20, fontFamily: FF, fontSize: 13, color: "#6B7280",
        }}>
          You can view HR policies but only the account owner can make changes.
        </div>
      )}

      <Accordion title="Pay Structure" subtitle="Training rates, commission, mileage, overtime, and job minimums" defaultOpen>
        {payPolicy && (
          <>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 4px", fontWeight: 600 }}>Training Period</div>
            <Row label="Training period length" hint="Weeks before moving to standard pay">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Input type="number" min={0} value={payPolicy.training_period_weeks} onChange={(v: any) => isOwner && setPay("training_period_weeks", v)} style={{ width: 80 }} />
                <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>weeks</span>
              </div>
            </Row>
            <Row label="Training hourly rate" hint="Rate during training period (owner must verify minimum wage compliance)">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>$</span>
                <Input type="number" min={0} step={0.01} value={payPolicy.training_hourly_rate} onChange={(v: any) => isOwner && setPay("training_hourly_rate", v)} style={{ width: 100 }} />
                <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>/ hr</span>
              </div>
            </Row>

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 4px", fontWeight: 600 }}>Job Minimums</div>
            <Row label="Minimum job hours" hint="Ensures minimum pay for short jobs">
              <Toggle value={payPolicy.job_minimum_hours_enabled} onChange={v => isOwner && setPay("job_minimum_hours_enabled", v)} label={payPolicy.job_minimum_hours_enabled ? "Enabled" : "Disabled"} />
              {payPolicy.job_minimum_hours_enabled && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <Input type="number" min={0} step={0.5} value={payPolicy.job_minimum_hours} onChange={(v: any) => isOwner && setPay("job_minimum_hours", v)} style={{ width: 80 }} />
                  <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>hours minimum per job</span>
                </div>
              )}
            </Row>

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 4px", fontWeight: 600 }}>Commission</div>
            <Row label="Commission type">
              <Select value={payPolicy.commission_type} onChange={(v: string) => isOwner && setPay("commission_type", v)}>
                <option value="hourly_only">Hourly only (no commission)</option>
                <option value="percent_per_job">Percent per job</option>
                <option value="flat_per_job">Flat rate per job</option>
                <option value="none">None</option>
              </Select>
            </Row>
            {payPolicy.commission_type !== "hourly_only" && payPolicy.commission_type !== "none" && (
              <>
                <Row label="Commission rate">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input type="number" min={0} step={0.01} value={payPolicy.commission_rate} onChange={(v: any) => isOwner && setPay("commission_rate", v)} style={{ width: 100 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>{payPolicy.commission_type === "percent_per_job" ? "%" : "$ flat"}</span>
                  </div>
                </Row>
                <Row label="Commission condition" hint="Label shown on pay stubs">
                  <Input value={payPolicy.commission_condition_label} onChange={(v: any) => isOwner && setPay("commission_condition_label", v)} />
                </Row>
              </>
            )}

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 4px", fontWeight: 600 }}>Wage Floors</div>
            <div style={{ background: "#FEF3C7", borderRadius: 6, padding: "10px 14px", marginBottom: 8, fontSize: 12, color: "#92400E", fontFamily: FF }}>
              These are your internal minimums only. Owner is responsible for ensuring compliance with applicable minimum wage laws.
            </div>
            <Row label="Minimum hourly rate (per period)">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>$</span>
                <Input type="number" min={0} step={0.01} value={payPolicy.min_hourly_wage_per_period} onChange={(v: any) => isOwner && setPay("min_hourly_wage_per_period", v)} style={{ width: 100 }} />
                <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>/ hr (internal floor)</span>
              </div>
            </Row>

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 4px", fontWeight: 600 }}>Mileage Reimbursement</div>
            <Row label="Mileage reimbursement">
              <Toggle value={payPolicy.mileage_reimbursement_enabled} onChange={v => isOwner && setPay("mileage_reimbursement_enabled", v)} label={payPolicy.mileage_reimbursement_enabled ? "Enabled" : "Disabled"} />
            </Row>
            {payPolicy.mileage_reimbursement_enabled && (
              <>
                <Row label="Rate per mile" hint="Owner must update annually (e.g. IRS standard rate)">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>$</span>
                    <Input type="number" min={0} step={0.001} value={payPolicy.mileage_rate_per_mile} onChange={(v: any) => isOwner && setPay("mileage_rate_per_mile", v)} style={{ width: 100 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>/ mile</span>
                  </div>
                </Row>
                <Row label="Job-to-job only">
                  <Toggle value={payPolicy.mileage_job_to_job_only} onChange={v => isOwner && setPay("mileage_job_to_job_only", v)} label="Only reimburse job-to-job travel" />
                </Row>
                <Row label="Submission deadline">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input type="number" min={1} value={payPolicy.mileage_submission_deadline_days} onChange={(v: any) => isOwner && setPay("mileage_submission_deadline_days", v)} style={{ width: 80 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>days from service date</span>
                  </div>
                </Row>
              </>
            )}

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 4px", fontWeight: 600 }}>Overtime</div>
            <Row label="Overtime rule" hint="Defines when overtime kicks in">
              <Select value={payPolicy.overtime_rule} onChange={(v: string) => isOwner && setPay("overtime_rule", v)}>
                <option value="federal_only">Federal only (40 hrs/week)</option>
                <option value="state_overlay">State overlay (consult your state law)</option>
                <option value="daily_california">Daily California rule (8 hrs/day)</option>
              </Select>
            </Row>
            <Row label="Pay week start day">
              <Select value={payPolicy.pay_week_start_day} onChange={(v: string) => isOwner && setPay("pay_week_start_day", v)}>
                <option value="sunday">Sunday</option>
                <option value="monday">Monday</option>
              </Select>
            </Row>
            <Row label="Full-time hours threshold">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Input type="number" min={1} value={payPolicy.full_time_hours_threshold} onChange={(v: any) => isOwner && setPay("full_time_hours_threshold", v)} style={{ width: 80 }} />
                <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>hours / week</span>
              </div>
            </Row>

            {isOwner && <SaveButton onClick={savePay} saving={savingPay} />}
          </>
        )}
      </Accordion>

      <Accordion title="Quality Enforcement" subtitle="Probation triggers, re-clean policy, and recovery rates">
        {payPolicy && (
          <>
            <Row label="Quality probation program">
              <Toggle value={payPolicy.quality_probation_enabled} onChange={v => isOwner && setPay("quality_probation_enabled", v)} label={payPolicy.quality_probation_enabled ? "Enabled" : "Disabled"} />
            </Row>
            {payPolicy.quality_probation_enabled && (
              <>
                <Row label="Trigger threshold" hint="Number of valid complaints in rolling window">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input type="number" min={1} value={payPolicy.quality_probation_trigger_count} onChange={(v: any) => isOwner && setPay("quality_probation_trigger_count", v)} style={{ width: 70 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>complaints within</span>
                    <Input type="number" min={1} value={payPolicy.quality_probation_rolling_days} onChange={(v: any) => isOwner && setPay("quality_probation_rolling_days", v)} style={{ width: 70 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>days</span>
                  </div>
                </Row>
                <Row label="Probation duration">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input type="number" min={1} value={payPolicy.quality_probation_duration_days} onChange={(v: any) => isOwner && setPay("quality_probation_duration_days", v)} style={{ width: 70 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>days on probation</span>
                  </div>
                </Row>
                <Row label="Probation hourly rate" hint="Rate during quality probation period">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>$</span>
                    <Input type="number" min={0} step={0.01} value={payPolicy.quality_probation_hourly_rate} onChange={(v: any) => isOwner && setPay("quality_probation_hourly_rate", v)} style={{ width: 100 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>/ hr</span>
                  </div>
                </Row>
                <Row label="Clean days to exit probation">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input type="number" min={1} value={payPolicy.return_to_commission_clean_days} onChange={(v: any) => isOwner && setPay("return_to_commission_clean_days", v)} style={{ width: 70 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>consecutive clean days</span>
                  </div>
                </Row>
              </>
            )}

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 4px", fontWeight: 600 }}>Re-Clean Policy</div>
            <Row label="Re-clean pay type" hint="How the original tech is paid when a re-clean occurs">
              <Select value={payPolicy.re_clean_pay_type} onChange={(v: string) => isOwner && setPay("re_clean_pay_type", v)}>
                <option value="no_additional">No additional pay</option>
                <option value="reduced_rate">Reduced rate</option>
                <option value="full_rate">Full rate</option>
              </Select>
            </Row>
            {payPolicy.re_clean_pay_type === "reduced_rate" && (
              <Row label="Reduced rate per re-clean">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>$</span>
                  <Input type="number" min={0} step={0.01} value={payPolicy.re_clean_reduced_rate} onChange={(v: any) => isOwner && setPay("re_clean_reduced_rate", v)} style={{ width: 100 }} />
                </div>
              </Row>
            )}
            <Row label="Recovery tech rate" hint="Flat rate paid to the tech who does the re-clean">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>$</span>
                <Input type="number" min={0} step={0.01} value={payPolicy.recovery_tech_rate} onChange={(v: any) => isOwner && setPay("recovery_tech_rate", v)} style={{ width: 100 }} />
              </div>
            </Row>

            {isOwner && <SaveButton onClick={savePay} saving={savingPay} />}
          </>
        )}
      </Accordion>

      <Accordion title="Attendance Discipline" subtitle="Grace period, progressive discipline steps, NCNS policy">
        {attendancePolicy && (
          <>
            <Row label="Benefit year basis" hint="When the attendance count resets for each employee">
              <Select value={attendancePolicy.benefit_year_basis} onChange={(v: string) => isOwner && setAtt("benefit_year_basis", v)}>
                <option value="calendar_year">Calendar year (Jan 1)</option>
                <option value="hire_date_anniversary">Hire date anniversary</option>
              </Select>
            </Row>
            <Row label="Clock-in grace period">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Input type="number" min={0} value={attendancePolicy.grace_period_minutes} onChange={(v: any) => isOwner && setAtt("grace_period_minutes", v)} style={{ width: 70 }} />
                <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>minutes before marked tardy</span>
              </div>
            </Row>

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 8px", fontWeight: 600 }}>Tardy Progressive Steps</div>
            <StepsEditor
              steps={attendancePolicy.tardy_steps}
              onChange={steps => isOwner && setAtt("tardy_steps", steps)}
              typeLabel="Tardy"
            />

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 8px", fontWeight: 600 }}>Absence Progressive Steps</div>
            <StepsEditor
              steps={attendancePolicy.absence_steps}
              onChange={steps => isOwner && setAtt("absence_steps", steps)}
              typeLabel="Absence"
            />

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 4px", fontWeight: 600 }}>No-Call No-Show (NCNS)</div>
            <Row label="NCNS policy">
              <Toggle value={attendancePolicy.ncns_policy_enabled} onChange={v => isOwner && setAtt("ncns_policy_enabled", v)} label={attendancePolicy.ncns_policy_enabled ? "Enabled" : "Disabled"} />
            </Row>
            {attendancePolicy.ncns_policy_enabled && (
              <>
                <Row label="May be grounds for immediate termination" hint="Owner must review each case individually">
                  <Toggle value={attendancePolicy.ncns_may_terminate_immediately} onChange={v => isOwner && setAtt("ncns_may_terminate_immediately", v)} label={attendancePolicy.ncns_may_terminate_immediately ? "Yes" : "No"} />
                </Row>
                <Row label="Internal policy note">
                  <textarea
                    value={attendancePolicy.ncns_custom_note ?? ""}
                    onChange={e => isOwner && setAtt("ncns_custom_note", e.target.value)}
                    disabled={!isOwner}
                    rows={3}
                    style={{
                      width: "100%", padding: "8px 10px", fontSize: 13, fontFamily: FF,
                      border: "1px solid #E5E7EB", borderRadius: 6, resize: "vertical",
                      background: "#FAFAFA", color: "#1A1917", outline: "none", boxSizing: "border-box",
                    }}
                  />
                </Row>
              </>
            )}

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 4px", fontWeight: 600 }}>Scheduling Limits</div>
            <Row label="Limit simultaneous time-off requests">
              <Toggle value={attendancePolicy.max_simultaneous_off_enabled} onChange={v => isOwner && setAtt("max_simultaneous_off_enabled", v)} label={attendancePolicy.max_simultaneous_off_enabled ? "Enabled" : "Disabled"} />
            </Row>
            {attendancePolicy.max_simultaneous_off_enabled && (
              <Row label="Maximum employees off at once">
                <Input type="number" min={1} value={attendancePolicy.max_simultaneous_off_count} onChange={(v: any) => isOwner && setAtt("max_simultaneous_off_count", v)} style={{ width: 70 }} />
              </Row>
            )}

            {isOwner && <SaveButton onClick={saveAttendance} saving={savingAtt} />}
          </>
        )}
      </Accordion>

      <Accordion title="Leave & Holidays" subtitle="Leave program configuration and paid holidays">
        {leavePolicy && (
          <>
            <Row label="Leave program">
              <Toggle value={leavePolicy.leave_program_enabled} onChange={v => isOwner && setLeave("leave_program_enabled", v)} label={leavePolicy.leave_program_enabled ? "Enabled" : "Disabled"} />
            </Row>
            {leavePolicy.leave_program_enabled && (
              <>
                <Row label="Program name" hint="Displayed on employee records">
                  <Input value={leavePolicy.leave_program_name} onChange={(v: any) => isOwner && setLeave("leave_program_name", v)} style={{ width: 240 }} />
                </Row>
                <Row label="Grant method">
                  <Select value={leavePolicy.leave_grant_method} onChange={(v: string) => isOwner && setLeave("leave_grant_method", v)}>
                    <option value="front_loaded">Front-loaded (lump sum on eligibility)</option>
                    <option value="accrual">Accrual (earn per hour worked)</option>
                  </Select>
                </Row>
                {leavePolicy.leave_grant_method === "front_loaded" && (
                  <Row label="Hours granted per year">
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Input type="number" min={0} step={0.5} value={leavePolicy.leave_hours_granted} onChange={(v: any) => isOwner && setLeave("leave_hours_granted", v)} style={{ width: 80 }} />
                      <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>hours</span>
                    </div>
                  </Row>
                )}
                {leavePolicy.leave_grant_method === "accrual" && (
                  <Row label="Accrual rate" hint="Hours accrued per hour worked">
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Input type="number" min={0} step={0.001} value={leavePolicy.accrual_rate_per_hour_worked} onChange={(v: any) => isOwner && setLeave("accrual_rate_per_hour_worked", v)} style={{ width: 90 }} />
                      <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>hours per hour worked</span>
                    </div>
                  </Row>
                )}
                <Row label="Eligibility after hire">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input type="number" min={0} value={leavePolicy.eligibility_trigger_days} onChange={(v: any) => isOwner && setLeave("eligibility_trigger_days", v)} style={{ width: 70 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>days from hire date</span>
                  </div>
                </Row>
                <Row label="Leave year resets on">
                  <Select value={leavePolicy.leave_reset_basis} onChange={(v: string) => isOwner && setLeave("leave_reset_basis", v)}>
                    <option value="calendar_year">Calendar year (Jan 1)</option>
                    <option value="work_anniversary">Work anniversary</option>
                  </Select>
                </Row>
                <Row label="Carryover">
                  <Toggle value={leavePolicy.carryover_enabled} onChange={v => isOwner && setLeave("carryover_enabled", v)} label={leavePolicy.carryover_enabled ? "Enabled" : "Disabled"} />
                  {leavePolicy.carryover_enabled && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                      <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>Max</span>
                      <Input type="number" min={0} step={0.5} value={leavePolicy.carryover_max_hours} onChange={(v: any) => isOwner && setLeave("carryover_max_hours", v)} style={{ width: 80 }} />
                      <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>hours carried over</span>
                    </div>
                  )}
                </Row>
                <Row label="Payout on separation" hint="Pay out unused leave when employee leaves">
                  <Toggle value={leavePolicy.payout_on_separation} onChange={v => isOwner && setLeave("payout_on_separation", v)} label={leavePolicy.payout_on_separation ? "Yes" : "No"} />
                </Row>
                <Row label="Documentation required after" hint="Number of consecutive sick days before documentation may be requested">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input type="number" min={1} value={leavePolicy.documentation_required_after_days} onChange={(v: any) => isOwner && setLeave("documentation_required_after_days", v)} style={{ width: 70 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>days</span>
                  </div>
                </Row>
                <Row label="Notice required for foreseeable leave">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input type="number" min={0} value={leavePolicy.notice_required_foreseeable_days} onChange={(v: any) => isOwner && setLeave("notice_required_foreseeable_days", v)} style={{ width: 70 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>days advance notice</span>
                  </div>
                </Row>
                <Row label="PTO request deadline">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input type="number" min={0} value={leavePolicy.pto_request_deadline_days} onChange={(v: any) => isOwner && setLeave("pto_request_deadline_days", v)} style={{ width: 70 }} />
                    <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>days in advance</span>
                  </div>
                </Row>
                <Row label="Birthday holiday">
                  <Toggle value={leavePolicy.birthday_holiday_enabled} onChange={v => isOwner && setLeave("birthday_holiday_enabled", v)} label={leavePolicy.birthday_holiday_enabled ? "Enabled" : "Disabled"} />
                  {leavePolicy.birthday_holiday_enabled && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                      <span style={{ fontSize: 13, color: "#374151", fontFamily: FF }}>Employee must request</span>
                      <Input type="number" min={1} value={leavePolicy.birthday_advance_notice_days} onChange={(v: any) => isOwner && setLeave("birthday_advance_notice_days", v)} style={{ width: 70 }} />
                      <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>days in advance</span>
                    </div>
                  )}
                </Row>
              </>
            )}

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9CA3AF", fontFamily: FF, padding: "16px 0 8px", fontWeight: 600 }}>Company Holidays</div>
            <Row label="Holiday pay rate" hint="Multiplier applied to regular hourly rate">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Input type="number" min={1} step={0.25} value={leavePolicy.holiday_pay_rate_multiplier} onChange={(v: any) => isOwner && setLeave("holiday_pay_rate_multiplier", v)} style={{ width: 80 }} />
                <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>× regular rate</span>
              </div>
            </Row>
            <Row label="Holiday list">
              <HolidayEditor
                holidays={leavePolicy.holidays}
                onChange={h => isOwner && setLeave("holidays", h)}
              />
            </Row>

            {isOwner && <SaveButton onClick={saveLeave} saving={savingLeave} />}
          </>
        )}
      </Accordion>
    </div>
  );
}
