/**
 * Cutover 2B — Mileage review screen.
 *
 * Office surface for the mileage approval gate. Lists every
 * mileage_leg in a chosen pay period grouped by tech with totals and
 * flags, exposes per-leg Review / Discard / Apply actions, and
 * surfaces carpool candidates (same date + same job pair, multiple
 * techs) at the top so the office discards duplicates before
 * applying.
 *
 * Mounted at /payroll/mileage-review. Read open period from
 * ?periodId=… or prompt the user to pick one.
 *
 * Visual: brand colors only (Plus Jakarta Sans, #F7F6F3 background,
 * #FFFFFF cards, mint accent for the "apply" CTA). No emojis.
 */
import { useEffect, useMemo, useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useToast } from "@/hooks/use-toast";

const FF = "'Plus Jakarta Sans', sans-serif";
const BRAND = "var(--brand)";
const INK = "#1A1917";
const MUTED = "#9E9B94";
const BG = "#F7F6F3";
const CARD = "#FFFFFF";
const BORDER = "#E5E2DC";
const FLAG = "#BA7517";
const DANGER = "#B3261E";

type LegStatus = "computed" | "reviewed" | "applied" | "discarded";

type Leg = {
  id: number;
  user_id: number;
  first_name: string | null;
  last_name: string | null;
  leg_date: string;
  from_job_id: number;
  to_job_id: number;
  miles: string;
  minutes: number;
  rate_per_mile: string;
  amount: string;
  measurement_source: string;
  measurement_is_estimated: boolean;
  status: LegStatus;
};

type TechSummary = {
  user_id: number;
  first_name: string | null;
  last_name: string | null;
  computed_count: number;
  reviewed_count: number;
  applied_count: number;
  discarded_count: number;
  pending_amount_cents: number;
  applied_amount_cents: number;
  flag_count: number;
};

type Period = {
  id: number;
  start_date: string;
  end_date: string;
  status: "open" | "locked" | "approved" | "exported";
};

type CarpoolCandidate = {
  leg_date: string;
  from_job_id: number;
  to_job_id: number;
  legs: Array<{ id: number; user_id: number; status: LegStatus }>;
  tech_count: number;
};

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}
function fmtRate(r: string): string {
  return `$${Number(r).toFixed(4)}/mi`;
}
function techName(t: { first_name: string | null; last_name: string | null }): string {
  return [t.first_name, t.last_name].filter(Boolean).join(" ") || "—";
}

export default function MileageReviewPage() {
  const { toast } = useToast();
  const periodIdFromUrl = (() => {
    const p = new URLSearchParams(window.location.search).get("periodId");
    return p ? Number(p) : null;
  })();

  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<number | null>(periodIdFromUrl);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [techs, setTechs] = useState<TechSummary[]>([]);
  const [period, setPeriod] = useState<Period | null>(null);
  const [carpools, setCarpools] = useState<CarpoolCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyLegId, setBusyLegId] = useState<number | null>(null);

  // Load periods.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/pay/periods", { credentials: "include" });
        const json = await res.json();
        setPeriods(json.data ?? []);
        if (periodId == null && json.data && json.data[0]) {
          setPeriodId(json.data[0].id);
        }
      } catch (e) {
        toast({ title: "Could not load periods", variant: "destructive" });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load legs + carpool candidates for the chosen period.
  useEffect(() => {
    if (periodId == null) return;
    loadPeriodLegs(periodId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  async function loadPeriodLegs(id: number) {
    setLoading(true);
    try {
      const [legsRes, carpoolRes] = await Promise.all([
        fetch(`/api/pay/periods/${id}/mileage-legs`, { credentials: "include" }),
        fetch(`/api/pay/periods/${id}/mileage-carpool-candidates`, { credentials: "include" }),
      ]);
      const legsJson = await legsRes.json();
      const carpoolJson = await carpoolRes.json();
      setLegs(legsJson.data?.legs ?? []);
      setTechs(legsJson.data?.techs ?? []);
      setPeriod(legsJson.data?.period ?? null);
      setCarpools(carpoolJson.data?.candidates ?? []);
    } catch (e) {
      toast({ title: "Could not load mileage legs", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function postLegAction(
    legId: number,
    action: "review" | "discard" | "apply",
    body?: Record<string, unknown>,
  ) {
    setBusyLegId(legId);
    try {
      const res = await fetch(`/api/pay/mileage-legs/${legId}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast({
          title: err?.message || `${action} failed`,
          variant: "destructive",
        });
        return;
      }
      if (periodId != null) await loadPeriodLegs(periodId);
    } catch (e) {
      toast({ title: `${action} failed`, variant: "destructive" });
    } finally {
      setBusyLegId(null);
    }
  }

  async function applyAllReviewed() {
    if (periodId == null) return;
    if (!confirm("Apply ALL reviewed legs in this period? This creates pay adjustments.")) return;
    try {
      const res = await fetch(
        `/api/pay/periods/${periodId}/mileage-legs/apply-all-reviewed`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast({
          title: err?.message || "Apply batch failed",
          variant: "destructive",
        });
        return;
      }
      const json = await res.json();
      toast({
        title: `Applied ${json.data?.applied_count ?? 0} legs`,
      });
      await loadPeriodLegs(periodId);
    } catch {
      toast({ title: "Apply batch failed", variant: "destructive" });
    }
  }

  const techsById = useMemo(() => {
    const m = new Map<number, TechSummary>();
    for (const t of techs) m.set(t.user_id, t);
    return m;
  }, [techs]);

  const legsByTech = useMemo(() => {
    const m = new Map<number, Leg[]>();
    for (const l of legs) {
      const arr = m.get(l.user_id) ?? [];
      arr.push(l);
      m.set(l.user_id, arr);
    }
    return m;
  }, [legs]);

  const periodLocked =
    period?.status === "approved" || period?.status === "exported";

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, color: INK, padding: "8px 0 32px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Mileage Review</h1>
          <div style={{ fontSize: 12, color: MUTED }}>
            Computed mileage is not pay until applied here.
          </div>
        </div>

        {/* Period picker */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: MUTED, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Period
          </label>
          <select
            value={periodId ?? ""}
            onChange={(e) => setPeriodId(Number(e.target.value) || null)}
            style={{
              fontFamily: FF, fontSize: 14, fontWeight: 600, color: INK,
              border: `1px solid ${BORDER}`, borderRadius: 8,
              padding: "6px 10px", background: CARD,
            }}
          >
            <option value="">— pick a period —</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.start_date} → {p.end_date} ({p.status})
              </option>
            ))}
          </select>
          {periodLocked && (
            <div style={{ fontSize: 12, color: DANGER, fontWeight: 700 }}>
              Period is {period!.status} — apply is blocked.
            </div>
          )}
          {!periodLocked && period && (
            <button
              onClick={applyAllReviewed}
              style={{
                marginLeft: "auto",
                fontFamily: FF, fontSize: 13, fontWeight: 700,
                color: "#FFFFFF", backgroundColor: BRAND,
                border: "none", borderRadius: 8, padding: "8px 14px",
                cursor: "pointer",
              }}
            >
              Apply all reviewed
            </button>
          )}
        </div>

        {/* Carpool candidates */}
        {carpools.length > 0 && (
          <div
            style={{
              backgroundColor: CARD, border: `1.5px solid ${FLAG}`, borderRadius: 10,
              padding: "12px 14px", marginBottom: 16,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 800, color: FLAG, marginBottom: 6 }}>
              {carpools.length} carpool candidate{carpools.length === 1 ? "" : "s"} — review before applying
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>
              Multiple techs have legs for the same route on the same day. Discard duplicates that didn't actually drive.
            </div>
            {carpools.map((c, i) => (
              <div key={i} style={{ marginTop: i === 0 ? 0 : 10, paddingTop: i === 0 ? 0 : 10, borderTop: i === 0 ? "none" : `1px solid ${BORDER}` }}>
                <div style={{ fontSize: 12, color: INK, fontWeight: 700 }}>
                  {c.leg_date} · Job #{c.from_job_id} → Job #{c.to_job_id} · {c.tech_count} techs
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                  Legs: {c.legs.map((l) => `#${l.id} (${techName(techsById.get(l.user_id) ?? { first_name: null, last_name: null })}, ${l.status})`).join(" · ")}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Per-tech sections */}
        {loading ? (
          <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>
        ) : techs.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13 }}>
            No mileage legs in this period yet. Recompute from the period detail page first.
          </div>
        ) : (
          techs.map((t) => (
            <TechSection
              key={t.user_id}
              tech={t}
              legs={legsByTech.get(t.user_id) ?? []}
              periodLocked={periodLocked}
              busyLegId={busyLegId}
              onReview={(id) => postLegAction(id, "review")}
              onDiscard={(id) => {
                const reason = prompt("Discard reason (required):") ?? "";
                if (!reason.trim()) return;
                postLegAction(id, "discard", { reason: reason.trim() });
              }}
              onApply={(id) => postLegAction(id, "apply")}
            />
          ))
        )}
      </div>
    </DashboardLayout>
  );
}

function TechSection({
  tech,
  legs,
  periodLocked,
  busyLegId,
  onReview,
  onDiscard,
  onApply,
}: {
  tech: TechSummary;
  legs: Leg[];
  periodLocked: boolean;
  busyLegId: number | null;
  onReview: (id: number) => void;
  onDiscard: (id: number) => void;
  onApply: (id: number) => void;
}) {
  return (
    <div
      style={{
        backgroundColor: CARD, border: `1px solid ${BORDER}`, borderRadius: 10,
        padding: "14px 16px", marginBottom: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: INK }}>
          {techName(tech)}
        </div>
        <div style={{ fontSize: 12, color: MUTED }}>
          {tech.computed_count} pending review · {tech.reviewed_count} reviewed · {tech.applied_count} applied · {tech.discarded_count} discarded
        </div>
        <div style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700, color: INK }}>
          Pending {formatCents(tech.pending_amount_cents)} · Applied {formatCents(tech.applied_amount_cents)}
        </div>
        {tech.flag_count > 0 && (
          <div style={{ fontSize: 12, fontWeight: 700, color: FLAG }}>
            {tech.flag_count} flag{tech.flag_count === 1 ? "" : "s"}
          </div>
        )}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: MUTED, textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <th style={{ padding: "6px 8px", fontWeight: 700 }}>Date</th>
            <th style={{ padding: "6px 8px", fontWeight: 700 }}>From → To</th>
            <th style={{ padding: "6px 8px", fontWeight: 700 }}>Miles</th>
            <th style={{ padding: "6px 8px", fontWeight: 700 }}>Rate</th>
            <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Amount</th>
            <th style={{ padding: "6px 8px", fontWeight: 700 }}>Status</th>
            <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={l.id} style={{ borderTop: `1px solid ${BORDER}` }}>
              <td style={{ padding: "8px", color: INK, fontWeight: 600 }}>{l.leg_date}</td>
              <td style={{ padding: "8px", color: INK }}>
                Job #{l.from_job_id} → #{l.to_job_id}
                {l.measurement_is_estimated && (
                  <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: FLAG, padding: "1px 6px", border: `1px solid ${FLAG}`, borderRadius: 3 }}>
                    ESTIMATED
                  </span>
                )}
              </td>
              <td style={{ padding: "8px", color: INK }}>{l.miles}</td>
              <td style={{ padding: "8px", color: MUTED }}>{fmtRate(l.rate_per_mile)}</td>
              <td style={{ padding: "8px", textAlign: "right", fontWeight: 700, color: INK }}>
                ${Number(l.amount).toFixed(2)}
              </td>
              <td style={{ padding: "8px" }}>
                <StatusPill status={l.status} />
              </td>
              <td style={{ padding: "8px", textAlign: "right" }}>
                <LegActions
                  leg={l}
                  busy={busyLegId === l.id}
                  periodLocked={periodLocked}
                  onReview={onReview}
                  onDiscard={onDiscard}
                  onApply={onApply}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: LegStatus }) {
  const styles: Record<
    LegStatus,
    { bg: string; fg: string; label: string }
  > = {
    computed: { bg: "#F0EEE9", fg: "#6B6860", label: "Computed" },
    reviewed: { bg: "#E5F7F2", fg: "#0A7A60", label: "Reviewed" },
    applied: { bg: "#D6F4E9", fg: "#0A5C3E", label: "Applied" },
    discarded: { bg: "#FCE7E7", fg: "#B3261E", label: "Discarded" },
  };
  const s = styles[status];
  return (
    <span
      style={{
        fontSize: 10, fontWeight: 800, letterSpacing: "0.05em",
        backgroundColor: s.bg, color: s.fg,
        padding: "2px 8px", borderRadius: 10, textTransform: "uppercase",
      }}
    >
      {s.label}
    </span>
  );
}

function LegActions({
  leg,
  busy,
  periodLocked,
  onReview,
  onDiscard,
  onApply,
}: {
  leg: Leg;
  busy: boolean;
  periodLocked: boolean;
  onReview: (id: number) => void;
  onDiscard: (id: number) => void;
  onApply: (id: number) => void;
}) {
  const btnBase: React.CSSProperties = {
    fontFamily: FF, fontSize: 11, fontWeight: 700,
    border: `1px solid ${BORDER}`, borderRadius: 6,
    padding: "4px 10px", marginLeft: 6, cursor: "pointer",
    backgroundColor: CARD, color: INK,
  };
  const disabled: React.CSSProperties = { opacity: 0.4, cursor: "not-allowed" };

  if (leg.status === "applied" || leg.status === "discarded") {
    return <span style={{ color: MUTED, fontSize: 11 }}>—</span>;
  }
  return (
    <>
      {leg.status === "computed" && (
        <button
          onClick={() => onReview(leg.id)}
          disabled={busy}
          style={{ ...btnBase, ...(busy ? disabled : {}) }}
        >
          Mark reviewed
        </button>
      )}
      {leg.status === "reviewed" && (
        <button
          onClick={() => onApply(leg.id)}
          disabled={busy || periodLocked}
          style={{
            ...btnBase,
            backgroundColor: periodLocked ? "#F0EEE9" : BRAND,
            color: periodLocked ? MUTED : "#FFFFFF",
            border: "none",
            ...(busy || periodLocked ? disabled : {}),
          }}
        >
          Apply
        </button>
      )}
      <button
        onClick={() => onDiscard(leg.id)}
        disabled={busy}
        style={{ ...btnBase, color: DANGER, borderColor: "#F5D2D2", ...(busy ? disabled : {}) }}
      >
        Discard
      </button>
    </>
  );
}
