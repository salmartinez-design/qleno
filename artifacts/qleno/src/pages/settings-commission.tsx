/**
 * [commission-settings 2026-04-29] Settings → Commission page.
 *
 * Phes operations needed a discoverable page for commission rate
 * configuration (residential pool % and commercial hourly $/hr) plus
 * per-tech overrides. The underlying fields already existed on the
 * companies table (`res_tech_pay_pct`, `commercial_hourly_rate`,
 * `commercial_comp_mode`) and the per-tech override on
 * `users.commission_rate_override`. This page wires them into a
 * focused UI without ambiguity about where to find them.
 *
 * Backed by existing endpoints:
 *   GET  /api/companies/me                 → reads current rates
 *   PUT  /api/companies/me                 → updates company-level rates
 *   GET  /api/employees                    → list of techs + their overrides
 *   PATCH /api/employees/:id               → update commission_rate_override
 *
 * Type model: residential is %-based, commercial is $/hr. The
 * "configurable type" the original ask mentioned (e.g., make
 * residential hourly too) needs schema work — flagged in the page
 * footer so Sal knows it's a follow-up rather than missing here.
 */
import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

const FF = "'Plus Jakarta Sans', sans-serif";

type Employee = {
  id: number;
  first_name: string;
  last_name: string;
  role: string;
  is_active: boolean;
  commission_rate_override: number | null;
};

export default function CommissionSettingsPage() {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [resPct, setResPct] = useState<string>("35");        // 0–100 in UI; stored as fraction 0–1
  const [commercialHourly, setCommercialHourly] = useState<string>("20");
  const [commercialMode, setCommercialMode] = useState<"allowed_hours" | "worked_hours">("allowed_hours");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [savingCompany, setSavingCompany] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cRes, eRes] = await Promise.all([
          fetch(`${BASE}/api/companies/me`, { headers: getAuthHeaders() }).then(r => r.ok ? r.json() : null),
          fetch(`${BASE}/api/employees`, { headers: getAuthHeaders() }).then(r => r.ok ? r.json() : null),
        ]);
        if (cancelled) return;
        const c = cRes?.data ?? cRes;
        if (c?.res_tech_pay_pct != null) {
          setResPct(String(Math.round(parseFloat(c.res_tech_pay_pct) * 100)));
        }
        if (c?.commercial_hourly_rate != null) {
          setCommercialHourly(String(c.commercial_hourly_rate));
        }
        if (c?.commercial_comp_mode != null) setCommercialMode(c.commercial_comp_mode);
        const list: Employee[] = Array.isArray(eRes?.data) ? eRes.data : Array.isArray(eRes) ? eRes : [];
        setEmployees(list.filter(u => u.is_active));
      } catch (err: any) {
        toast({ title: "Load failed", description: err?.message ?? "Could not load commission settings.", variant: "destructive" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [BASE, toast]);

  async function saveCompany() {
    setSavingCompany(true);
    try {
      const r = await fetch(`${BASE}/api/companies/me`, {
        method: "PUT",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          res_tech_pay_pct: parseFloat(resPct) / 100,
          commercial_hourly_rate: parseFloat(commercialHourly),
          commercial_comp_mode: commercialMode,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast({ title: "Save failed", description: d.message || d.error || `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      toast({ title: "Saved", description: "Company commission rates updated." });
    } catch (err: any) {
      toast({ title: "Network error", description: err?.message ?? "Could not save.", variant: "destructive" });
    } finally {
      setSavingCompany(false);
    }
  }

  async function saveEmployeeOverride(id: number, value: string) {
    const parsed = value.trim() === "" ? null : parseFloat(value);
    if (parsed != null && (Number.isNaN(parsed) || parsed < 0)) {
      toast({ title: "Invalid", description: "Override must be a non-negative number or blank.", variant: "destructive" });
      return;
    }
    try {
      const r = await fetch(`${BASE}/api/employees/${id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ commission_rate_override: parsed }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast({ title: "Save failed", description: d.message || d.error || `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setEmployees(prev => prev.map(e => e.id === id ? { ...e, commission_rate_override: parsed } : e));
      toast({ title: "Saved", description: "Override updated." });
    } catch (err: any) {
      toast({ title: "Network error", description: err?.message ?? "Could not save.", variant: "destructive" });
    }
  }

  const sectionCard: React.CSSProperties = {
    background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12,
    padding: "20px 22px", marginBottom: 16,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#6B6860",
    textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, display: "block",
  };
  const inputStyle: React.CSSProperties = {
    padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 6,
    fontSize: 14, fontFamily: FF, color: "#1A1917", width: 120,
  };

  return (
    <DashboardLayout>
      <div style={{ padding: "24px 32px 80px", background: "#F7F6F3", minHeight: "100%", fontFamily: FF }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "#1A1917", marginBottom: 4 }}>Commission settings</h1>
          <p style={{ fontSize: 13, color: "#6B6860", marginBottom: 20, lineHeight: 1.5 }}>
            How techs get paid per job. Residential jobs use a % of job total; commercial jobs use an hourly rate. Per-tech overrides below replace the default for individual techs.
          </p>

          {loading ? (
            <div style={{ ...sectionCard, color: "#9E9B94", textAlign: "center" }}>Loading…</div>
          ) : (
            <>
              <div style={sectionCard}>
                <h2 style={{ fontSize: 15, fontWeight: 800, color: "#1A1917", marginBottom: 10 }}>Residential — pool rate</h2>
                <p style={{ fontSize: 12, color: "#6B6860", marginBottom: 12, lineHeight: 1.5 }}>
                  Job total × pool rate ÷ techs on job. Default 35%.
                </p>
                <label style={labelStyle}>Commission % of job total</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="number" min={0} max={100} step={1} value={resPct}
                    onChange={e => setResPct(e.target.value)} style={inputStyle} placeholder="35" />
                  <span style={{ fontSize: 13, color: "#6B7280" }}>%</span>
                </div>
              </div>

              <div style={sectionCard}>
                <h2 style={{ fontSize: 15, fontWeight: 800, color: "#1A1917", marginBottom: 10 }}>Commercial — hourly rate</h2>
                <p style={{ fontSize: 12, color: "#6B6860", marginBottom: 12, lineHeight: 1.5 }}>
                  Hourly rate × hours per tech. Default $20/hr. The hours signal below picks scheduled (allowed) hours vs actual clock time.
                </p>
                <label style={labelStyle}>Hourly rate</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#1A1917" }}>$</span>
                  <input type="number" min={0} step={0.25} value={commercialHourly}
                    onChange={e => setCommercialHourly(e.target.value)} style={inputStyle} placeholder="20.00" />
                  <span style={{ fontSize: 13, color: "#6B7280" }}>/hr</span>
                </div>
                <label style={labelStyle}>Hours used for pay calculation</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {([
                    { v: "allowed_hours", label: "Allowed hours", sub: "Scheduled / estimated" },
                    { v: "worked_hours",  label: "Worked hours",  sub: "Actual clock time" },
                  ] as const).map(opt => (
                    <button key={opt.v} type="button" onClick={() => setCommercialMode(opt.v)}
                      style={{
                        flex: 1, padding: "10px 12px", borderRadius: 8, cursor: "pointer", textAlign: "left",
                        border: `1.5px solid ${commercialMode === opt.v ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                        background: commercialMode === opt.v ? "rgba(0,201,160,0.08)" : "#FFFFFF",
                        fontFamily: FF,
                      }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{opt.label}</div>
                      <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>{opt.sub}</div>
                    </button>
                  ))}
                </div>
              </div>

              <button onClick={saveCompany} disabled={savingCompany}
                style={{ padding: "10px 22px", background: "var(--brand, #00C9A0)", color: "#FFFFFF", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, fontFamily: FF, cursor: savingCompany ? "wait" : "pointer", marginBottom: 28 }}>
                {savingCompany ? "Saving…" : "Save company defaults"}
              </button>

              <div style={sectionCard}>
                <h2 style={{ fontSize: 15, fontWeight: 800, color: "#1A1917", marginBottom: 6 }}>Per-tech overrides</h2>
                <p style={{ fontSize: 12, color: "#6B6860", marginBottom: 14, lineHeight: 1.5 }}>
                  Optional. Leave blank to use the company default. Numeric value is a flat rate that replaces the default — e.g. "22" for a senior tech who earns $22/hr on commercial work, or "40" for a tech on a 40% pool rate residentially. The value is stored as-is on the user record; the dispatch route reads <code>users.commission_rate_override</code>.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {employees.length === 0 ? (
                    <div style={{ fontSize: 13, color: "#9E9B94" }}>No active employees.</div>
                  ) : employees.map(emp => (
                    <PerTechRow key={emp.id} emp={emp} onSave={(v) => saveEmployeeOverride(emp.id, v)} />
                  ))}
                </div>
              </div>

              <div style={{ fontSize: 11, color: "#9E9B94", lineHeight: 1.6 }}>
                Note: residential is currently fixed at %-based and commercial at hourly. Configurable type per service category (e.g. residential hourly, commercial %) is a follow-up — needs schema work to split type from rate.
              </div>
            </>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}

function PerTechRow({ emp, onSave }: { emp: Employee; onSave: (v: string) => void }) {
  const [val, setVal] = useState<string>(emp.commission_rate_override != null ? String(emp.commission_rate_override) : "");
  const [dirty, setDirty] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid #F0EEE9", borderRadius: 8 }}>
      <div style={{ flex: 1, fontSize: 13, color: "#1A1917" }}>
        {emp.first_name} {emp.last_name}
        <span style={{ color: "#9E9B94", marginLeft: 6, fontSize: 11 }}>· {emp.role}</span>
      </div>
      <input type="number" min={0} step={0.25} value={val}
        onChange={e => { setVal(e.target.value); setDirty(true); }}
        placeholder="—"
        style={{ padding: "6px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, fontFamily: FF, width: 90, textAlign: "right" }} />
      <button onClick={() => { onSave(val); setDirty(false); }}
        disabled={!dirty}
        style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: dirty ? "var(--brand, #00C9A0)" : "#E5E2DC", color: dirty ? "#FFFFFF" : "#9E9B94", fontSize: 12, fontWeight: 700, fontFamily: FF, cursor: dirty ? "pointer" : "not-allowed" }}>
        Save
      </button>
    </div>
  );
}
