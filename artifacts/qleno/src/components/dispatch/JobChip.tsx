/**
 * AI.15a JobChip. Lifted verbatim from
 * artifacts/qleno/src/pages/jobs.tsx lines 1720 to 1805.
 *
 * Pure relocation. No behavior change. Helpers and constants now come
 * from ./utils. JobHoverCard is imported from its sibling file. The
 * single direct DAY_START reference at the original line 1726 now reads
 * dayBounds.start.
 *
 * AI.15a commit 2 will add the client_type pill, $price line, and
 * service line to the tile body. This file is the relocation foothold
 * for that work.
 */
import { useState, useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Clock, Camera, Repeat } from "lucide-react";
import {
  SLOT_W, ROW_H, dayBounds,
  timeToMins, minsToStr, fmtTime, scopeLabel, zoneLuminance,
  type DispatchJob,
} from "./utils";
import { JobHoverCard } from "./JobHoverCard";

export function JobChip({ job, onClick, assignedName, isUnassigned }: { job: DispatchJob; onClick: (j: DispatchJob) => void; assignedName?: string; isUnassigned?: boolean }) {
  // [X] `sc` (status color palette) no longer needed — border uses its own
  // priority-based color logic below; zone-tinted bg replaces the
  // status.bg fallback entirely. `assignedName` is still passed through
  // to JobHoverCard (unassigned fallback display) but is not rendered in
  // the card body itself.
  const left = ((timeToMins(job.scheduled_time) - dayBounds.start) / 30) * SLOT_W;
  const width = Math.max(SLOT_W, (job.duration_minutes / 30) * SLOT_W);
  const isComplete = job.status === "complete";
  const isRecurring = job.frequency && job.frequency !== "on_demand";
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `chip-${job.id}`, data: { job, originalLeft: left, type: isUnassigned ? "unassigned" : undefined }, disabled: isComplete });

  // [AB] Full-opacity zone-color card matching MC's Job Schedule visual
  // weight. Previous 15% alpha tint was spec'd to feel "subtle" but read
  // as washed-out in practice — failed the "glance from across the room"
  // test. MC uses saturated fills with white text; matching that now.
  //
  // Border priority (unchanged from X/V):
  //   1. red   — late clock-in OR at-risk (today, past start−15 min, no clock-in)
  //   2. amber — in_progress
  //   3. green — complete
  //   4. zone color at full opacity — scheduled default (same as bg,
  //      so status state-changes are the only visible border transition)
  //
  // Text: white by default, but if the zone color's perceptual luminance
  // exceeds 0.65 (e.g. gold #FFD700 for Tinley/Orlando/Palos Park at
  // ~0.79) we flip to dark text so the chip stays legible. Fallback when
  // zone is null/missing: neutral #9CA3AF (Tailwind gray-400) with white
  // text — distinct from "colored" chips without being alarming.
  const todayKey = new Date().toISOString().split("T")[0];
  const isLiveDay = job.scheduled_date === todayKey;
  const nowMins = (() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); })();
  const startMins = timeToMins(job.scheduled_time);
  const isRisky = isLiveDay
    && job.status !== "cancelled"
    && job.status !== "complete"
    && !job.clock_entry?.clock_in_at
    && nowMins >= (startMins - 15);
  const isInProgressStatus = job.status === "in_progress";

  const ZONE_FALLBACK = "#9CA3AF";
  const bgColor = job.zone_color || ZONE_FALLBACK;
  const isLightZone = zoneLuminance(job.zone_color) > 0.65;
  const borderColor =
    isRisky ? "#DC2626" :
    isInProgressStatus ? "#F59E0B" :
    isComplete ? "#16A34A" :
    bgColor;

  const primaryText   = isLightZone ? "#1A1917" : "#FFFFFF";
  const secondaryText = isLightZone ? "#4B5563" : "rgba(255,255,255,0.90)";
  const iconTint      = isLightZone ? "#6B7280" : "rgba(255,255,255,0.90)";

  const [hovered, setHovered] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onEnter() { hoverTimer.current = setTimeout(() => setHovered(true), 400); }
  function onLeave() { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovered(false); }

  return (
    <div ref={setNodeRef}
      onClick={e => { e.stopPropagation(); setHovered(false); onClick(job); }}
      onMouseEnter={onEnter} onMouseLeave={onLeave}
      {...(isComplete ? {} : { ...listeners, ...attributes })}
      style={{ position: "absolute", top: 10, left, width, height: ROW_H - 20, borderRadius: 8, backgroundColor: bgColor, border: `2px solid ${borderColor}`, padding: "8px 10px", boxSizing: "border-box", overflow: "visible", cursor: isComplete ? "default" : isDragging ? "grabbing" : "grab", opacity: isDragging ? 0.3 : isComplete ? 0.7 : 1, transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined, zIndex: hovered ? 50 : isDragging ? 0 : 2, userSelect: "none", display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, boxShadow: "0 1px 4px rgba(0,0,0,0.12)" }}>
      {/* [X] Primary label: {client_name} · {scope}. Tech name stays on the
          row axis only (initials + label on the left) — kept out of the
          card body entirely, per MC's Job Schedule convention. Icons still
          glance-signal clock-in, photos, and recurring frequency. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        {job.clock_entry?.clock_in_at && <Clock size={9} style={{ color: iconTint, flexShrink: 0 }} />}
        {job.after_photo_count > 0 && <Camera size={9} style={{ color: iconTint, flexShrink: 0 }} />}
        {isRecurring && <Repeat size={9} style={{ color: iconTint, flexShrink: 0 }} />}
        <span style={{ fontSize: 11, fontWeight: 700, color: primaryText, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {job.client_name} · {scopeLabel(job)}
        </span>
      </div>
      {width > 100 && (
        <span style={{ fontSize: 10, color: secondaryText, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {fmtTime(job.scheduled_time)} – {fmtTime(minsToStr(timeToMins(job.scheduled_time) + job.duration_minutes))}
        </span>
      )}
      {hovered && !isDragging && <JobHoverCard job={job} assignedName={assignedName} />}
    </div>
  );
}
