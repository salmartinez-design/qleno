/**
 * AI.15a JobHoverCard. Lifted verbatim from
 * artifacts/qleno/src/pages/jobs.tsx lines 1487 to 1717.
 *
 * Pure relocation. No behavior change. Helpers and constants now come
 * from ./utils instead of being co located in jobs.tsx.
 *
 * AI.15a commit 2 will add the hero strip, editable tech dropdown,
 * editable address form, and commission breakdown sections. This file
 * is the relocation foothold for that work.
 */
import {
  FF, STATUS_PILL,
  timeToMins, minsToStr, fmtTime, fmtSvc,
  parseActualTimes, fmtPayment, fmtRelativeDate, stripImportTags,
  type DispatchJob,
} from "./utils";

export function JobHoverCard({ job, assignedName }: { job: DispatchJob; assignedName?: string }) {
  const endTime = minsToStr(timeToMins(job.scheduled_time) + job.duration_minutes);
  const allowedH = job.duration_minutes / 60;
  const isRecurring = job.frequency && job.frequency !== "on_demand";
  const statusPill = STATUS_PILL[job.status] ?? STATUS_PILL.scheduled;
  const actualTimes = parseActualTimes(job.notes);
  const paymentLabel = fmtPayment(job.client_payment_method);
  const entryInstructions = stripImportTags(job.client_notes) || null;
  const liveClock = job.clock_entry;
  const lastServiceRelative = job.last_service_date ? fmtRelativeDate(job.last_service_date) : null;
  const officeNotesCleaned = stripImportTags(job.office_notes);

  // [AD] Location line: zone color dot + zone name + zip. Branch name
  // (previously shown as a prefix like "Oak Lawn · Chicago Central · 60643")
  // is dropped — redundant with the page-level branch filter in the
  // header, and visually competed with the zone name. If the resolved zip
  // doesn't match any service_zone (zone_name null) we still render the
  // zip with a muted gray dot, so unmapped one-offs like Shannon's
  // Whitfield Rd still surface the zip for context.
  const hasZoneBadge = !!(job.zone_name || job.client_zip);

  const sectionBorder = "1px solid #F0EEE9";
  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: "#9E9B94",
    textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4,
  };

  return (
    // Native click bubbles up to parent JobChip → opens JobPanel drawer.
    // Phone anchor and in-card buttons use their own stopPropagation as needed.
    //
    // [R] Positioning rebuilt after Q2's taller layout got clipped by the
    // dispatch row container's overflow. Anchor is now TOP (renders below
    // the chip) so the critical header (client name + status) is always
    // visible even when hovering chips near the top of the viewport. Very
    // tall content scrolls inside the card rather than overflowing.
    <div style={{
      position: "absolute", top: "calc(100% + 8px)", left: 0, zIndex: 9999,
      width: 320,
      maxHeight: "calc(100vh - 120px)", overflowY: "auto",
      backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC",
      borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.14)",
      fontFamily: FF, padding: 0,
    }}>
      {/* ─── HEADER ─── */}
      <div style={{ padding: "14px 16px 12px", borderBottom: sectionBorder }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", flex: 1, minWidth: 0 }}>
            {job.client_name}
          </div>
          <span style={{
            flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "2px 8px",
            borderRadius: 10, backgroundColor: statusPill.bg, color: statusPill.fg,
            textTransform: "uppercase" as const, letterSpacing: "0.03em",
          }}>
            {statusPill.label}
          </span>
        </div>
        {job.address && (
          <div style={{ fontSize: 12, color: "#6B6860", marginBottom: job.client_phone ? 6 : 0 }}>
            {job.address}
          </div>
        )}
        {job.client_phone && (
          <a
            href={`tel:${job.client_phone}`}
            onClick={e => e.stopPropagation()}
            style={{ fontSize: 12, color: "#2D9B83", textDecoration: "none", fontWeight: 600, display: "inline-block" }}
          >
            {job.client_phone}
          </a>
        )}
        {hasZoneBadge && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {/* Dot: zone_color when mapped, muted gray when the zip isn't
                in any service_zones row (e.g. Shannon @ 60062 Northbrook). */}
            <div style={{
              width: 8, height: 8, borderRadius: "50%",
              backgroundColor: job.zone_color || "#9CA3AF",
              flexShrink: 0,
            }} />
            {job.zone_name && (
              <span style={{ fontSize: 11, color: "#6B6860" }}>{job.zone_name}</span>
            )}
            {job.client_zip && (
              <span style={{
                fontSize: 11, fontWeight: 500, color: "#6B6860",
                padding: "1px 6px", borderRadius: 4,
                backgroundColor: "#F3F4F6", marginLeft: job.zone_name ? 2 : 0,
              }}>
                {job.client_zip}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ─── SERVICE + FREQUENCY + LAST SERVICE ─── */}
      <div style={{ padding: "10px 16px", borderBottom: sectionBorder }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>
          {fmtSvc(job.service_type)}
          <span style={{ color: "#9E9B94", fontWeight: 500, margin: "0 6px" }}>·</span>
          {isRecurring ? fmtSvc(job.frequency) : "One Time"}
        </div>
        {lastServiceRelative && (
          <div style={{ fontSize: 11, color: "#6B6860", marginTop: 4 }}>
            Last service: {job.last_service_date} ({lastServiceRelative})
          </div>
        )}
      </div>

      {/* ─── ENTRY INSTRUCTIONS (conditional) ─── */}
      {entryInstructions && (
        <div style={{ padding: "10px 16px", borderBottom: sectionBorder, backgroundColor: "#FFFBEB" }}>
          <div style={{ ...labelStyle, color: "#92400E" }}>🔑 Entry</div>
          <div style={{ fontSize: 12, color: "#1A1917", lineHeight: 1.4 }}>
            {entryInstructions.length > 180 ? entryInstructions.slice(0, 180) + "…" : entryInstructions}
          </div>
        </div>
      )}

      {/* ─── TIME BLOCK ─── */}
      <div style={{ padding: "10px 16px", borderBottom: sectionBorder }}>
        <div style={labelStyle}>Time</div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>
          Scheduled: {fmtTime(job.scheduled_time)} – {fmtTime(endTime)}
        </div>
        {actualTimes && (
          <div style={{ fontSize: 12, color: "#6B6860", marginTop: 2 }}>
            Actual: {actualTimes.start} – {actualTimes.end}
            {job.actual_hours != null && (
              <span style={{ marginLeft: 6, color: "#9E9B94" }}>({job.actual_hours.toFixed(2)}h)</span>
            )}
          </div>
        )}
        <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>
          Allowed: {allowedH.toFixed(2)}h
        </div>
      </div>

      {/* ─── TOTAL + PAYMENT ─── */}
      <div style={{ padding: "10px 16px", borderBottom: sectionBorder, display: "grid", gridTemplateColumns: paymentLabel ? "1fr 1fr" : "1fr", gap: "0 16px" }}>
        <div>
          <div style={labelStyle}>Total</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>${(job.amount || 0).toFixed(2)}</div>
        </div>
        {paymentLabel && (
          <div>
            <div style={labelStyle}>Payment</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>{paymentLabel}</div>
          </div>
        )}
      </div>

      {/* ─── TECHNICIAN (name only, no pay $) ─── */}
      <div style={{ padding: "10px 16px", borderBottom: liveClock ? sectionBorder : undefined }}>
        <div style={labelStyle}>
          {(job.technicians?.length ?? 0) > 1 ? `Team (${job.technicians!.length})` : "Technician"}
        </div>
        {job.technicians && job.technicians.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {job.technicians.map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <div style={{
                  width: 20, height: 20, borderRadius: "50%",
                  backgroundColor: t.is_primary ? "#DCFCE7" : "#F3F4F6",
                  color: t.is_primary ? "#15803D" : "#6B7280",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 9, fontWeight: 700, flexShrink: 0,
                }}>
                  {t.name.split(" ").map(p => p[0]).join("").slice(0, 2)}
                </div>
                <span style={{ fontWeight: 600, color: "#1A1917" }}>{t.name}</span>
                {t.is_primary && (job.technicians!.length > 1) && (
                  <span style={{ fontSize: 9, color: "#9E9B94" }}>Primary</span>
                )}
              </div>
            ))}
          </div>
        ) : assignedName ? (
          <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>{assignedName}</div>
        ) : (
          <div style={{ fontSize: 12, color: "#D97706", fontWeight: 600 }}>Unassigned</div>
        )}
      </div>

      {/* ─── JOB CLOCKS (conditional — only when live clock entry exists) ─── */}
      {liveClock && (
        <div style={{ padding: "10px 16px", borderBottom: sectionBorder }}>
          <div style={labelStyle}>Job Clocks</div>
          <div style={{ fontSize: 12, color: "#1A1917", fontWeight: 500 }}>
            {liveClock.clock_in_at && (
              <div>
                <span style={{ color: "#9E9B94" }}>In:</span>{" "}
                {new Date(liveClock.clock_in_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                {liveClock.distance_from_job_ft != null && (
                  <span style={{ color: "#9E9B94", marginLeft: 6 }}>
                    ({Math.round(liveClock.distance_from_job_ft)} ft)
                  </span>
                )}
              </div>
            )}
            {liveClock.clock_out_at && (
              <div>
                <span style={{ color: "#9E9B94" }}>Out:</span>{" "}
                {new Date(liveClock.clock_out_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </div>
            )}
            {liveClock.is_flagged && (
              <div style={{ color: "#D97706", fontWeight: 600, marginTop: 2 }}>Flagged</div>
            )}
          </div>
        </div>
      )}

      {/* ─── OFFICE NOTES (optional, only when non-empty after tag strip) ─── */}
      {officeNotesCleaned && (
        <div style={{ padding: "8px 16px 10px", borderTop: sectionBorder }}>
          <div style={{ fontSize: 11, color: "#6B6860", fontStyle: "italic", lineHeight: 1.4 }}>
            {officeNotesCleaned.length > 120 ? officeNotesCleaned.slice(0, 120) + "…" : officeNotesCleaned}
          </div>
        </div>
      )}

      {/* ─── FOOTER ─── */}
      <div style={{ padding: "8px 16px 12px", borderTop: sectionBorder, fontSize: 11, color: "#9E9B94", textAlign: "center" }}>
        → Click for full details
      </div>
    </div>
  );
}
