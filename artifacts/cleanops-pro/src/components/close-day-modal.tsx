import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { X, CheckCircle, AlertTriangle, AlertCircle, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function SectionIcon({ type }: { type: "ok" | "warn" | "error" | "neutral" }) {
  if (type === "ok") return <CheckCircle size={18} style={{ color: "#16A34A", flexShrink: 0 }} />;
  if (type === "warn") return <AlertTriangle size={18} style={{ color: "#D97706", flexShrink: 0 }} />;
  if (type === "error") return <AlertCircle size={18} style={{ color: "#DC2626", flexShrink: 0 }} />;
  return <Clock size={18} style={{ color: "#9E9B94", flexShrink: 0 }} />;
}

function InfoRow({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F0EDE8" }}>
      <span style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: color || "#1A1917", fontFamily: FF }}>{value}</span>
    </div>
  );
}

export function CloseDayModal({ onClose, onOpenBatchInvoice }: { onClose: () => void; onOpenBatchInvoice?: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [clockingOut, setClockingOut] = useState<Record<number, string>>({});
  const [submittingClockOut, setSubmittingClockOut] = useState<number | null>(null);

  const today = new Date();
  const todayLabel = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const { data, isLoading } = useQuery({
    queryKey: ["close-day"],
    queryFn: () => apiFetch("/api/close-day"),
    refetchInterval: 30000,
  });

  const markCompleteMutation = useMutation({
    mutationFn: () => apiFetch("/api/close-day", { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Day marked complete. Good work today." });
      onClose();
    },
    onError: () => toast({ title: "Failed to mark day complete", variant: "destructive" }),
  });

  async function handleClockOut(entryId: number) {
    setSubmittingClockOut(entryId);
    try {
      await apiFetch(`/api/close-day/timeclock/${entryId}/clock-out`, {
        method: "POST",
        body: JSON.stringify({ clock_out_at: clockingOut[entryId] || new Date().toISOString() }),
      });
      qc.invalidateQueries({ queryKey: ["close-day"] });
      toast({ title: "Clock-out set successfully" });
    } catch {
      toast({ title: "Failed to set clock-out", variant: "destructive" });
    }
    setSubmittingClockOut(null);
  }

  const jobs = data?.jobs || {};
  const invoicing = data?.invoicing || {};
  const payments = data?.payments || {};
  const timeclock = data?.timeclock || {};

  const now = new Date();
  const hour = now.getHours();

  const jobSectionStatus =
    (jobs.in_progress > 0 || jobs.scheduled > 0)
      ? hour >= 18 ? "error" : "warn"
      : jobs.complete > 0 ? "ok" : "neutral";

  const invoiceSectionStatus =
    invoicing.uninvoiced > 0 ? "warn"
    : invoicing.total_complete > 0 ? "ok"
    : "neutral";

  const paymentSectionStatus =
    payments.overdue_count > 0 ? "warn"
    : "ok";

  const clockSectionStatus =
    timeclock.missing_clock_out?.length > 0 ? "error"
    : timeclock.flagged > 0 ? "warn"
    : "ok";

  const canMarkComplete = invoicing.uninvoiced === 0;
  const todayRevenue = payments.collected_today || 0;

  const SECTION: React.CSSProperties = {
    backgroundColor: "#FAFAF9",
    border: "1px solid #EEECE7",
    borderRadius: 10,
    padding: "16px",
    marginBottom: 12,
  };

  return (
    <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ backgroundColor: "#FFFFFF", borderRadius: 16, boxShadow: "0 8px 40px rgba(0,0,0,0.14)", width: "100%", maxWidth: 640, maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column", fontFamily: FF }}>

        <div style={{ padding: "20px 24px", borderBottom: "1px solid #EEECE7", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#1A1917" }}>Close Day — {todayLabel}</h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>Review today's activity before closing</p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          {isLoading ? (
            <div style={{ textAlign: "center", padding: 40, color: "#9E9B94", fontSize: 13 }}>Loading today's activity...</div>
          ) : (
            <>
              <div style={SECTION}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <SectionIcon type={jobSectionStatus} />
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Jobs Today</span>
                </div>
                <InfoRow label="Complete" value={jobs.complete || 0} color="#16A34A" />
                <InfoRow label="In Progress" value={jobs.in_progress || 0} color={jobs.in_progress > 0 ? "#D97706" : "#6B7280"} />
                <InfoRow label="Scheduled (not started)" value={jobs.scheduled || 0} color={jobs.scheduled > 0 && hour >= 18 ? "#DC2626" : jobs.scheduled > 0 ? "#D97706" : "#6B7280"} />
                {(jobs.in_progress > 0 || jobs.scheduled > 0) && (
                  <p style={{ margin: "10px 0 0", fontSize: 12, color: "#D97706" }}>
                    Some jobs may not be finished. Check before closing.
                  </p>
                )}
              </div>

              <div style={SECTION}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <SectionIcon type={invoiceSectionStatus} />
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Invoicing</span>
                </div>
                <InfoRow
                  label="Jobs invoiced"
                  value={`${invoicing.invoiced || 0} of ${invoicing.total_complete || 0}`}
                  color={invoicing.uninvoiced > 0 ? "#D97706" : "#16A34A"}
                />
                {invoicing.uninvoiced > 0 ? (
                  <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, color: "#D97706" }}>{invoicing.uninvoiced} job{invoicing.uninvoiced !== 1 ? "s" : ""} not yet invoiced</span>
                    {onOpenBatchInvoice && (
                      <button
                        onClick={() => { onClose(); setTimeout(onOpenBatchInvoice, 100); }}
                        style={{ fontSize: 12, fontWeight: 700, color: "var(--brand)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                      >
                        Batch Invoice Now
                      </button>
                    )}
                  </div>
                ) : (
                  <p style={{ margin: "10px 0 0", fontSize: 12, color: "#16A34A" }}>All completed jobs are invoiced.</p>
                )}
              </div>

              <div style={SECTION}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <SectionIcon type={paymentSectionStatus} />
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Payments Today</span>
                </div>
                <InfoRow label="Total collected" value={`$${(payments.collected_today || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} color="var(--brand)" />
                <InfoRow label="Invoices awaiting payment" value={payments.awaiting_payment || 0} />
                {(payments.overdue_count || 0) > 0 && (
                  <InfoRow label="Overdue invoices" value={`${payments.overdue_count} ($${(payments.overdue_total || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`} color="#DC2626" />
                )}
              </div>

              <div style={SECTION}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <SectionIcon type={clockSectionStatus} />
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Clock Entries</span>
                </div>
                <InfoRow label="Total entries" value={timeclock.total || 0} />
                {timeclock.missing_clock_out?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <p style={{ margin: "0 0 8px", fontSize: 12, color: "#DC2626", fontWeight: 600 }}>Missing clock-out ({timeclock.missing_clock_out.length})</p>
                    {timeclock.missing_clock_out.map((entry: any) => (
                      <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #F0EDE8" }}>
                        <span style={{ fontSize: 13, color: "#1A1917", flex: 1 }}>{entry.user_name}</span>
                        <input
                          type="time"
                          value={clockingOut[entry.id] || ""}
                          onChange={e => setClockingOut(prev => ({ ...prev, [entry.id]: e.target.value }))}
                          style={{ border: "1px solid #E5E2DC", borderRadius: 6, padding: "3px 8px", fontSize: 12, fontFamily: FF }}
                        />
                        <button
                          onClick={() => handleClockOut(entry.id)}
                          disabled={submittingClockOut === entry.id}
                          style={{ fontSize: 12, fontWeight: 600, color: "#FFFFFF", backgroundColor: "var(--brand)", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}
                        >
                          Set
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {timeclock.flagged > 0 && (
                  <p style={{ margin: "8px 0 0", fontSize: 12, color: "#D97706" }}>{timeclock.flagged} flagged {timeclock.flagged === 1 ? "entry" : "entries"} — check Clock Monitor</p>
                )}
              </div>
            </>
          )}
        </div>

        <div style={{ padding: "16px 24px", borderTop: "1px solid #EEECE7", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, backgroundColor: "#FAFAF9" }}>
          <div>
            <p style={{ margin: 0, fontSize: 11, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>Today's Revenue</p>
            <p style={{ margin: "2px 0 0", fontSize: 22, fontWeight: 800, color: "var(--brand)" }}>
              ${todayRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button onClick={onClose} style={{ padding: "9px 18px", border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "transparent", color: "#6B7280", fontSize: 13, cursor: "pointer" }}>
              Close
            </button>
            <div style={{ position: "relative" }}>
              <button
                onClick={() => markCompleteMutation.mutate()}
                disabled={!canMarkComplete || markCompleteMutation.isPending}
                title={!canMarkComplete ? "Uninvoiced jobs remaining" : undefined}
                style={{
                  padding: "9px 18px",
                  border: "none",
                  borderRadius: 8,
                  backgroundColor: canMarkComplete ? "var(--brand)" : "#C4C0BB",
                  color: "#FFFFFF",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: canMarkComplete ? "pointer" : "not-allowed",
                  fontFamily: FF,
                }}
              >
                {markCompleteMutation.isPending ? "Marking..." : "Mark Day Complete"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
