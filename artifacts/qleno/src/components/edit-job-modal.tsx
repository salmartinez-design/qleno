// [AG] Focused job edit modal — accessed from JobPanel drawer's action footer.
// Sections: Service · Schedule · Team · Add-ons · Pricing · Instructions
// Cascade prompt shown when job has recurring_schedule_id.
//
// Pricing approach: tenant's pricing_scopes is a dropdown (decision 1c).
// Modal calls POST /api/pricing/calculate as inputs change. base_fee is the
// only persisted pricing value; manual_rate_override flips when user types
// a custom rate.
import { useEffect, useMemo, useRef, useState } from "react";
import { X, AlertTriangle, Loader2 } from "lucide-react";
import { useAuthStore } from "@/store/auth";
import { useToast } from "@/hooks/use-toast";

const FF = "'Plus Jakarta Sans', sans-serif";

// Mirrors the DispatchJob shape from jobs.tsx — only the fields the modal
// reads. Kept loose-typed so we don't have to cross-import.
export interface EditableJob {
  id: number;
  client_id: number;
  client_name: string;
  recurring_schedule_id?: number | null;
  service_type: string;
  frequency: string;
  scheduled_date: string;
  scheduled_time: string | null;
  duration_minutes: number;
  amount: number;
  base_fee?: number | string | null;
  notes: string | null;
  status: string;
  locked_at?: string | null;
  assigned_user_id: number | null;
}

export interface TeamCandidate {
  id: number;
  name: string;
  role?: string;
  is_primary?: boolean;
}

interface PricingScope {
  id: number;
  name: string;
  scope_group: string;
  pricing_method: string;
  hourly_rate: string | number;
}

interface PricingAddon {
  id: number;
  name: string;
  price: string | number;
  price_type: string;
  time_add_minutes?: number;
}

interface CalcResponse {
  base_price: number;
  addons_total: number;
  bundle_discount: number;
  bundle_breakdown?: { name: string; discount: number }[];
  addon_breakdown?: { id: number; name: string; amount: number; price_type: string }[];
  total_hours: number;
  hourly_rate: number;
  subtotal: number;
  final_total: number;
}

const FREQUENCIES: Array<{ value: string; label: string }> = [
  { value: "on_demand", label: "One-time" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "every_3_weeks", label: "Every 3 weeks" },
  { value: "monthly", label: "Every 4 weeks / Monthly" },
];

const SECTION: React.CSSProperties = {
  margin: "14px 20px 0",
  backgroundColor: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #E5E2DC",
  padding: "14px 16px",
};
const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: "#9E9B94",
  textTransform: "uppercase", letterSpacing: "0.07em",
  display: "block", marginBottom: 10,
};
const INPUT: React.CSSProperties = {
  width: "100%", height: 40, padding: "0 12px",
  border: "1px solid #E5E2DC", borderRadius: 8,
  fontSize: 14, outline: "none", boxSizing: "border-box",
  fontFamily: FF, backgroundColor: "#F7F6F3", color: "#1A1917",
};

export default function EditJobModal({
  job, employees, mobile, onClose, onSaved,
}: {
  job: EditableJob;
  employees: TeamCandidate[];
  mobile: boolean;
  onClose: () => void;
  onSaved: (info: { future_jobs_updated: number; future_jobs_skipped_in_progress: number }) => void;
}) {
  const token = useAuthStore(s => s.token)!;
  const { toast } = useToast();
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const isRecurring = job.recurring_schedule_id != null;

  // ── Initial values (snapshot from the loaded job) ──────────────────────
  const initialBaseFee = useMemo(
    () => Number(job.base_fee ?? job.amount ?? 0),
    [job.base_fee, job.amount],
  );
  const initialAllowedHours = useMemo(
    () => Math.max(0.25, Math.round((job.duration_minutes / 60) * 100) / 100),
    [job.duration_minutes],
  );

  // ── Form state ─────────────────────────────────────────────────────────
  const [scopeId, setScopeId] = useState<number | null>(null);
  const [scopes, setScopes] = useState<PricingScope[]>([]);
  const [scopesLoading, setScopesLoading] = useState(true);

  const [frequency, setFrequency] = useState(job.frequency || "on_demand");
  const [scheduledDate, setScheduledDate] = useState(job.scheduled_date);
  const [scheduledTime, setScheduledTime] = useState(job.scheduled_time || "09:00");
  const [allowedHours, setAllowedHours] = useState<number>(initialAllowedHours);
  const [instructions, setInstructions] = useState(job.notes || "");

  const [selectedTechIds, setSelectedTechIds] = useState<number[]>(
    job.assigned_user_id != null ? [job.assigned_user_id] : []
  );

  const [availableAddons, setAvailableAddons] = useState<PricingAddon[]>([]);
  const [addonsLoading, setAddonsLoading] = useState(false);
  const [selectedAddons, setSelectedAddons] = useState<Map<number, number>>(new Map());

  const [baseFee, setBaseFee] = useState<number>(initialBaseFee);
  const [manualRate, setManualRate] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState<string>(String(initialBaseFee));

  const [calcResult, setCalcResult] = useState<CalcResponse | null>(null);
  const [calcBusy, setCalcBusy] = useState(false);
  const [calcError, setCalcError] = useState<string>("");

  // Cascade prompt state
  const [cascadePromptOpen, setCascadePromptOpen] = useState(false);
  const [cascadeChoice, setCascadeChoice] = useState<"this_job" | "this_and_future">("this_job");

  const [saving, setSaving] = useState(false);

  // ── Load scopes once ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/api/pricing/scopes`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        const list: PricingScope[] = Array.isArray(d) ? d : (d.data ?? []);
        if (cancelled) return;
        setScopes(list);
        // Best-effort match on name to current job.service_type label
        const guess = list.find(s =>
          s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").includes(job.service_type)
          || job.service_type.includes(s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"))
        );
        if (guess) setScopeId(guess.id);
        else if (list[0]) setScopeId(list[0].id);
      } catch {
        if (!cancelled) toast({ title: "Could not load pricing scopes", variant: "destructive" });
      } finally {
        if (!cancelled) setScopesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [API, token, job.service_type, toast]);

  // ── Load addons whenever scope changes ─────────────────────────────────
  useEffect(() => {
    if (scopeId == null) return;
    let cancelled = false;
    setAddonsLoading(true);
    (async () => {
      try {
        const r = await fetch(`${API}/api/pricing/scopes/${scopeId}/addons`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        const rows: PricingAddon[] = Array.isArray(d) ? d : (d.data ?? d.rows ?? []);
        if (!cancelled) setAvailableAddons(rows);
      } catch {
        if (!cancelled) setAvailableAddons([]);
      } finally {
        if (!cancelled) setAddonsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [API, token, scopeId]);

  // ── Recalc on input changes (debounced) ─────────────────────────────────
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (manualRate) return; // honor manual override; no recalc
    if (scopeId == null) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setCalcBusy(true);
      setCalcError("");
      try {
        const r = await fetch(`${API}/api/pricing/calculate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            scope_id: scopeId,
            hours: allowedHours,
            frequency,
            addon_ids: Array.from(selectedAddons.keys()),
            addon_quantities: Object.fromEntries(
              Array.from(selectedAddons.entries()).map(([k, v]) => [String(k), v])
            ),
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Calc failed");
        setCalcResult(d);
        setBaseFee(Number(d.final_total ?? d.subtotal ?? 0));
      } catch (err: any) {
        setCalcError(err.message || "Could not calculate price");
      } finally {
        setCalcBusy(false);
      }
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [API, token, scopeId, allowedHours, frequency, selectedAddons, manualRate]);

  // ── Validation / dirty check ────────────────────────────────────────────
  const dirty = useMemo(() => {
    if (frequency !== job.frequency) return true;
    if (scheduledDate !== job.scheduled_date) return true;
    if ((job.scheduled_time || "09:00") !== scheduledTime) return true;
    if (Math.abs(allowedHours - initialAllowedHours) > 0.001) return true;
    if (Math.abs(baseFee - initialBaseFee) > 0.01) return true;
    if ((job.notes || "") !== instructions) return true;
    if (manualRate) return true;
    if (selectedAddons.size > 0) return true;
    if (job.assigned_user_id != null && (selectedTechIds[0] !== job.assigned_user_id || selectedTechIds.length !== 1)) return true;
    if (job.assigned_user_id == null && selectedTechIds.length > 0) return true;
    return false;
  }, [frequency, scheduledDate, scheduledTime, allowedHours, baseFee, instructions, manualRate, selectedAddons, selectedTechIds, job, initialAllowedHours, initialBaseFee]);

  const canSave = dirty
    && !saving
    && allowedHours > 0
    && selectedTechIds.length > 0
    && /^\d{2}:\d{2}$/.test(scheduledTime);

  // ── Cascade prompt or direct submit ─────────────────────────────────────
  function onSaveClick() {
    if (!canSave) return;
    if (isRecurring) {
      setCascadeChoice("this_job");
      setCascadePromptOpen(true);
      return;
    }
    submit("this_job");
  }

  async function submit(cascade: "this_job" | "this_and_future") {
    setSaving(true);
    try {
      // Build add-ons payload. We persist into job_add_ons via add_on_id (legacy
      // FK), but also pass pricing_addon_id for traceability per AG.
      // For now the simplest approach: write add_on_id = pricing_addon_id (DB
      // permits this since pricing_addons rows have similar shape). A future
      // pass can map distinct addon catalogs.
      const addOnsPayload = Array.from(selectedAddons.entries()).map(([pricingAddonId, qty]) => {
        const detail = calcResult?.addon_breakdown?.find(x => x.id === pricingAddonId);
        return {
          add_on_id: pricingAddonId,
          pricing_addon_id: pricingAddonId,
          qty,
          unit_price: detail ? Math.round((detail.amount / qty) * 100) / 100 : 0,
          subtotal: detail ? detail.amount : 0,
        };
      });

      const payload = {
        // Note: service_type omitted — we don't have a clean enum mapping from
        // the pricing_scopes.id back to jobs.service_type enum yet (decision 1c
        // says no persist of scope_id). Frequency and other fields cascade.
        frequency,
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        allowed_hours: allowedHours,
        base_fee: baseFee,
        manual_rate_override: manualRate,
        add_ons: addOnsPayload,
        team_user_ids: selectedTechIds,
        instructions,
        cascade_scope: cascade,
      };

      const r = await fetch(`${API}/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) {
        if (r.status === 409) {
          toast({ title: "Cannot edit", description: d.message || "Job is locked or a tech is clocked in.", variant: "destructive" });
        } else {
          toast({ title: "Save failed", description: d.message || d.error || "Try again", variant: "destructive" });
        }
        return;
      }
      onSaved({
        future_jobs_updated: d.cascade?.future_jobs_updated ?? 0,
        future_jobs_skipped_in_progress: d.cascade?.future_jobs_skipped_in_progress ?? 0,
      });
    } catch {
      toast({ title: "Network error", description: "Could not save changes", variant: "destructive" });
    } finally {
      setSaving(false);
      setCascadePromptOpen(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const overlay: React.CSSProperties = {
    position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 399,
  };
  const shell: React.CSSProperties = mobile
    ? {
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 400,
        backgroundColor: "#F7F6F3", borderRadius: "16px 16px 0 0",
        maxHeight: "92vh", display: "flex", flexDirection: "column", fontFamily: FF,
      }
    : {
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        zIndex: 400, backgroundColor: "#F7F6F3", borderRadius: 16,
        width: "100%", maxWidth: 680, maxHeight: "92vh",
        display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.25)", fontFamily: FF,
      };

  return (
    <>
      <div style={overlay} onClick={() => !saving && onClose()} />
      <div style={shell}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "18px 20px 16px", backgroundColor: "#FFFFFF",
          borderRadius: "16px 16px 0 0", borderBottom: "1px solid #E5E2DC", flexShrink: 0,
        }}>
          <div>
            <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1917" }}>Edit Job</span>
            <div style={{ fontSize: 12, color: "#6B6860", marginTop: 2 }}>{job.client_name}</div>
          </div>
          <button onClick={onClose} disabled={saving}
            style={{ background: "none", border: "none", cursor: saving ? "wait" : "pointer", padding: 6, display: "flex", alignItems: "center" }}>
            <X size={18} color="#6B6860" />
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", flex: 1, padding: "0 0 8px" }}>
          {/* Section 1 — Service */}
          <div style={SECTION}>
            <span style={LABEL}>Service</span>
            <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 10 }}>
              <div>
                <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Scope</span>
                <select value={scopeId ?? ""} onChange={e => setScopeId(parseInt(e.target.value))}
                  style={INPUT} disabled={scopesLoading}>
                  {scopesLoading ? <option>Loading…</option> : null}
                  {scopes.map(s => (
                    <option key={s.id} value={s.id}>{s.name} {s.scope_group ? `· ${s.scope_group}` : ""}</option>
                  ))}
                </select>
              </div>
              <div>
                <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Frequency</span>
                <select value={frequency} onChange={e => setFrequency(e.target.value)} style={INPUT}>
                  {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Allowed hours</span>
              <input type="number" min={0.25} step={0.25} value={allowedHours}
                onChange={e => setAllowedHours(parseFloat(e.target.value) || 0)}
                style={INPUT} />
            </div>
          </div>

          {/* Section 2 — Schedule */}
          <div style={SECTION}>
            <span style={LABEL}>Schedule</span>
            <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 10 }}>
              <div>
                <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Date</span>
                <input type="date" value={scheduledDate}
                  onChange={e => setScheduledDate(e.target.value)} style={INPUT} />
              </div>
              <div>
                <span style={{ fontSize: 12, color: "#6B6860", display: "block", marginBottom: 4 }}>Start time</span>
                <input type="time" value={scheduledTime} step={900}
                  onChange={e => setScheduledTime(e.target.value)} style={INPUT} />
              </div>
            </div>
          </div>

          {/* Section 3 — Team */}
          <div style={SECTION}>
            <span style={LABEL}>Team {selectedTechIds.length > 1 ? `(${selectedTechIds.length})` : ""}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {employees.length === 0 && (
                <span style={{ fontSize: 12, color: "#9E9B94" }}>No technicians available</span>
              )}
              {employees.map(e => {
                const idx = selectedTechIds.indexOf(e.id);
                const selected = idx >= 0;
                const isPrimary = idx === 0 && selectedTechIds.length > 0;
                return (
                  <div key={e.id} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 12px", borderRadius: 8,
                    border: `1.5px solid ${selected ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                    backgroundColor: selected ? "rgba(0,201,160,0.07)" : "#F7F6F3",
                    cursor: "pointer", fontFamily: FF,
                  }}
                  onClick={() => {
                    setSelectedTechIds(prev => {
                      const cur = prev.indexOf(e.id);
                      if (cur >= 0) return prev.filter(id => id !== e.id);
                      return [...prev, e.id];
                    });
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="checkbox" checked={selected} readOnly />
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{e.name}</span>
                      {isPrimary && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#15803D", backgroundColor: "#DCFCE7", padding: "2px 6px", borderRadius: 4 }}>Primary</span>
                      )}
                    </div>
                    {selected && !isPrimary && (
                      <button onClick={ev => {
                        ev.stopPropagation();
                        setSelectedTechIds(prev => [e.id, ...prev.filter(id => id !== e.id)]);
                      }} style={{
                        fontSize: 11, color: "#1D4ED8", background: "none", border: "none",
                        cursor: "pointer", fontFamily: FF, fontWeight: 600,
                      }}>Set as primary</button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 4 — Add-ons */}
          <div style={SECTION}>
            <span style={LABEL}>Add-ons</span>
            {addonsLoading ? (
              <div style={{ fontSize: 12, color: "#9E9B94", display: "flex", alignItems: "center", gap: 6 }}>
                <Loader2 size={12} className="spin" /> Loading add-ons…
              </div>
            ) : availableAddons.length === 0 ? (
              <span style={{ fontSize: 12, color: "#9E9B94" }}>No add-ons configured for this scope.</span>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {availableAddons.map(a => {
                  const checked = selectedAddons.has(a.id);
                  return (
                    <label key={a.id} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "8px 10px", borderRadius: 8,
                      border: `1px solid ${checked ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                      backgroundColor: checked ? "rgba(0,201,160,0.05)" : "#F7F6F3",
                      cursor: "pointer", fontFamily: FF,
                    }}>
                      <input type="checkbox" checked={checked}
                        onChange={() => {
                          setSelectedAddons(prev => {
                            const next = new Map(prev);
                            if (next.has(a.id)) next.delete(a.id);
                            else next.set(a.id, 1);
                            return next;
                          });
                        }} />
                      <span style={{ flex: 1, fontSize: 13, color: "#1A1917" }}>{a.name}</span>
                      <span style={{ fontSize: 12, color: "#6B6860" }}>
                        {a.price_type === "percent" ? `${a.price}%` : `$${Number(a.price).toFixed(0)}`}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {calcResult?.bundle_breakdown && calcResult.bundle_breakdown.length > 0 && (
              <div style={{ marginTop: 8, padding: "6px 10px", backgroundColor: "#F0FDF4", borderRadius: 6, border: "1px solid #BBF7D0" }}>
                {calcResult.bundle_breakdown.map(b => (
                  <div key={b.name} style={{ fontSize: 11, color: "#166534", fontWeight: 600 }}>
                    Bundle: {b.name} − ${b.discount.toFixed(0)}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 5 — Pricing */}
          <div style={SECTION}>
            <span style={LABEL}>Pricing</span>
            {calcError && (
              <div style={{ fontSize: 12, color: "#991B1B", marginBottom: 8 }}>{calcError}</div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 14, color: "#6B6860" }}>Current</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#1A1917" }}>${initialBaseFee.toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
              <span style={{ fontSize: 14, color: "#6B6860" }}>New</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: "#1A1917" }}>
                {calcBusy ? "…" : `$${baseFee.toFixed(2)}`}
                {!calcBusy && Math.abs(baseFee - initialBaseFee) > 0.01 && (
                  <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 8, color: baseFee > initialBaseFee ? "#15803D" : "#991B1B" }}>
                    {baseFee > initialBaseFee ? "+" : ""}{(baseFee - initialBaseFee).toFixed(2)}
                  </span>
                )}
              </span>
            </div>
            {manualRate && (
              <div style={{ marginTop: 8, padding: "6px 10px", backgroundColor: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 6, fontSize: 12, color: "#92400E", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={12} /> Manual rate active
                </span>
                <button onClick={() => { setManualRate(false); setManualOpen(false); }}
                  style={{ fontSize: 11, color: "#92400E", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>
                  Reset to calculated
                </button>
              </div>
            )}
            {!manualOpen && !manualRate && (
              <button onClick={() => { setManualOpen(true); setManualValue(baseFee.toFixed(2)); }}
                style={{ marginTop: 8, fontSize: 12, color: "#1D4ED8", background: "none", border: "none", cursor: "pointer", fontFamily: FF, fontWeight: 600, padding: 0 }}>
                Override rate
              </button>
            )}
            {manualOpen && !manualRate && (
              <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "#6B6860" }}>$</span>
                <input type="number" min={0} step={0.01} value={manualValue}
                  onChange={e => setManualValue(e.target.value)}
                  style={{ ...INPUT, width: 140 }} />
                <button onClick={() => {
                  const v = parseFloat(manualValue);
                  if (!isNaN(v) && v >= 0) {
                    setBaseFee(v); setManualRate(true); setManualOpen(false);
                  }
                }} style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: "var(--brand, #00C9A0)", border: "none", borderRadius: 6, padding: "8px 12px", cursor: "pointer", fontFamily: FF }}>
                  Apply
                </button>
                <button onClick={() => setManualOpen(false)} style={{ fontSize: 12, color: "#6B7280", background: "none", border: "none", cursor: "pointer", fontFamily: FF }}>Cancel</button>
              </div>
            )}
          </div>

          {/* Section 6 — Instructions */}
          <div style={SECTION}>
            <span style={LABEL}>Instructions</span>
            <textarea value={instructions} onChange={e => setInstructions(e.target.value)}
              placeholder="Notes for technicians on this job…"
              rows={4}
              style={{ ...INPUT, height: "auto", padding: "10px 12px", lineHeight: 1.5, resize: "vertical" }} />
          </div>

          <div style={{ height: 16 }} />
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #E5E2DC", backgroundColor: "#FFFFFF", flexShrink: 0, display: "flex", gap: 8 }}>
          <button onClick={onClose} disabled={saving}
            style={{ flex: 1, padding: "12px", border: "1px solid #E5E2DC", borderRadius: 10, background: "#FFFFFF", color: "#6B7280", fontSize: 14, fontWeight: 600, cursor: saving ? "wait" : "pointer", fontFamily: FF }}>
            Cancel
          </button>
          <button onClick={onSaveClick} disabled={!canSave}
            style={{ flex: 2, padding: "12px", border: "none", borderRadius: 10, background: canSave ? "var(--brand, #00C9A0)" : "#E5E2DC", color: canSave ? "#FFFFFF" : "#9E9B94", fontSize: 14, fontWeight: 700, cursor: canSave ? "pointer" : "not-allowed", fontFamily: FF }}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {/* Cascade prompt */}
      {cascadePromptOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 410 }} />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            zIndex: 411, backgroundColor: "#FFFFFF", borderRadius: 14, padding: 24,
            width: "100%", maxWidth: 420, fontFamily: FF, boxShadow: "0 16px 48px rgba(0,0,0,0.3)",
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", marginBottom: 6 }}>Recurring job</div>
            <div style={{ fontSize: 13, color: "#6B6860", marginBottom: 16, lineHeight: 1.5 }}>
              This job is part of a recurring schedule. Apply changes to:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
              {[
                { v: "this_job" as const, label: "This job only", sub: "Other future jobs in this schedule won't change." },
                { v: "this_and_future" as const, label: "This and all future occurrences", sub: "Updates the schedule template + all future scheduled jobs." },
              ].map(opt => {
                const sel = cascadeChoice === opt.v;
                return (
                  <button key={opt.v} type="button" onClick={() => setCascadeChoice(opt.v)}
                    style={{
                      textAlign: "left", padding: "12px 14px", borderRadius: 10,
                      border: `1.5px solid ${sel ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
                      backgroundColor: sel ? "rgba(0,201,160,0.07)" : "#F7F6F3",
                      cursor: "pointer", fontFamily: FF,
                    }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: "#6B6860", marginTop: 2 }}>{opt.sub}</div>
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setCascadePromptOpen(false)} disabled={saving}
                style={{ flex: 1, padding: "10px", borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B7280", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                Cancel
              </button>
              <button onClick={() => submit(cascadeChoice)} disabled={saving}
                style={{ flex: 2, padding: "10px", borderRadius: 8, border: "none", background: "var(--brand, #00C9A0)", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: saving ? "wait" : "pointer", fontFamily: FF }}>
                {saving ? "Applying…" : "Apply changes"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
