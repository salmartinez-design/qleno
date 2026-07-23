import { useState } from "react";
import { DollarSign, Check, X, Pencil } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Reusable "change the price" control. Shows a job's price and, for office /
// admin / owner, lets them edit it inline on whatever screen it appears
// (dispatch panel, field view, etc.). Saves the new total to the job's
// base_fee for THIS visit only (the server recomputes billed_amount); the
// recurring template's rate is changed separately on the customer profile.
export function InlinePriceEdit({
  jobId,
  price,
  billingMethod,
  hourlyRate,
  estimatedHours,
  allowedHours,
  rateDriven,
  canEdit,
  onUpdated,
}: {
  jobId: number;
  price: number;
  billingMethod?: string | null;
  hourlyRate?: number | null;
  estimatedHours?: number | null;
  // [commercial-revenue 2026-06-04] When the job's revenue is hourly_rate ×
  // allowed_hours (a commercial job the office hasn't pinned to a flat price),
  // the panel passes rateDriven + allowedHours so we always show "$50/hr × 8h"
  // next to the total — the office could never see the billing rate before.
  allowedHours?: number | null;
  rateDriven?: boolean;
  canEdit: boolean;
  onUpdated?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isHourly = billingMethod === "hourly" && hourlyRate != null;
  const showRate = rateDriven && hourlyRate != null && allowedHours != null && allowedHours > 0;
  const display = showRate
    ? `$${Number(hourlyRate).toFixed(2)}/hr × ${Number(allowedHours)}h · $${Number(price).toFixed(2)}`
    : isHourly
    ? `$${Number(hourlyRate).toFixed(2)}/hr · Hourly${estimatedHours ? ` · est. ${estimatedHours}h` : ""} · $${Number(price).toFixed(2)}`
    : `$${Number(price).toFixed(2)}`;

  async function save() {
    const n = parseFloat(val);
    if (!Number.isFinite(n) || n < 0) { setErr("Enter a valid amount"); return; }
    setSaving(true); setErr(null);
    try {
      const r = await fetch(`${API}/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ base_fee: String(n.toFixed(2)), cascade_scope: "this_job" }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.message || d.error || `HTTP ${r.status}`);
      }
      setEditing(false);
      onUpdated?.();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't save the price");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <DollarSign size={14} style={{ color: "#6B6860", flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{display}</span>
        {canEdit && (
          <button
            onClick={() => { setVal(Number(price || 0).toFixed(2)); setErr(null); setEditing(true); }}
            style={{ fontSize: 11, fontWeight: 600, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0, display: "inline-flex", alignItems: "center", gap: 3 }}
          >
            <Pencil size={11} /> Change price
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 160 }}>
          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#6B6860" }}>$</span>
          <input
            type="number" inputMode="decimal" value={val} autoFocus
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") { setEditing(false); setErr(null); } }}
            style={{ width: "100%", padding: "8px 10px 8px 22px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
          />
        </div>
        <button onClick={save} disabled={saving} title="Save"
          style={{ padding: "8px 10px", borderRadius: 8, border: "none", background: "var(--brand)", color: "#fff", cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
          <Check size={14} />
        </button>
        <button onClick={() => { setEditing(false); setErr(null); }} disabled={saving} title="Cancel"
          style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #E5E2DC", background: "#fff", color: "#6B6860", cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
          <X size={14} />
        </button>
      </div>
      {(isHourly || showRate) && <p style={{ margin: 0, fontSize: 11, color: "#9E9B94" }}>Sets this visit's total price (overrides hours × rate for this visit only).</p>}
      {err && <p style={{ margin: 0, fontSize: 11, color: "#B3261E" }}>{err}</p>}
    </div>
  );
}
