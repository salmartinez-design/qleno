import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, Plus, ExternalLink, CalendarClock } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Simplified per-account month calendar. Instead of MaidCentral's wall of
// one-bar-per-job (5-8 stacked bars per cell), each day shows a SINGLE count
// pill color-coded by status; the full per-job detail lives in a popover.
//
// [account-calendar 2026-07-07] Now a WORKING surface, not just a viewer
// (Maribel: "being able to work from here — drag and drop, edit, schedule").
//   - Property filter — pick a building and the calendar becomes THAT
//     property's own calendar ("each property should have its own calendar").
//     account-detail's Properties tab deep-links here via initialPropertyId.
//   - [calendar-dnd 2026-07-07] Day cells render per-visit CHIPS (first two +
//     "+N more"); DRAG a chip onto another day to reschedule it — same PUT
//     quick-reschedule as dispatch drag-and-drop. Completed/cancelled chips
//     aren't draggable. Touch devices use the popover's Move button instead
//     (HTML5 DnD is pointer-only), which also covers cross-month moves.
//   - Day popover job rows open the job's full editor (dispatch JobPanel via
//     /jobs?date=…&job=…) — every edit tool in one tap.
//   - "Move" reschedules a visit to another date inline.
//   - "New job" on a day opens the New Job wizard on that date
//     (/jobs?date=…&new=1).

type CalJob = {
  id: number;
  scheduled_date: string;
  scheduled_time: string | null;
  status: string;
  service_type: string | null;
  base_fee: string | null;
  billing_method: string | null;
  allowed_hours: string | null;
  account_property_id: number | null;
  property_name: string | null;
  property_address: string | null;
  tech_first_name: string | null;
  tech_last_name: string | null;
};

type PropOption = { id: number; property_name: string | null; address: string | null };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// Most-urgent status wins the pill color for a day.
const STATUS_COLOR: Record<string, string> = {
  in_progress: "#F59E0B",
  scheduled: "#00C9A0",
  complete: "#16A34A",
  cancelled: "#9CA3AF",
};
const STATUS_PRIORITY = ["in_progress", "scheduled", "complete", "cancelled"];

function pad2(n: number) { return n < 10 ? `0${n}` : String(n); }
function ymd(y: number, mIdx: number, d: number) { return `${y}-${pad2(mIdx + 1)}-${pad2(d)}`; }

function fmtSvc(s: string | null) {
  if (!s) return "Service";
  return s.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function fmtTime(t: string | null) {
  if (!t) return "";
  const [hStr, mStr] = t.split(":");
  let h = parseInt(hStr, 10);
  if (isNaN(h)) return "";
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  const m = parseInt(mStr ?? "0", 10);
  return m ? `${h}:${pad2(m)} ${ampm}` : `${h} ${ampm}`;
}

function fmtMoney(v: string | null) {
  if (v == null) return "";
  const n = parseFloat(v);
  return isNaN(n) ? "" : `$${n.toFixed(0)}`;
}

export function AccountJobsCalendar({ accountId, initialPropertyId }: { accountId: number | string; initialPropertyId?: number | null }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [monthIdx, setMonthIdx] = useState(today.getMonth());
  const [jobs, setJobs] = useState<CalJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [properties, setProperties] = useState<PropOption[]>([]);
  const [propFilter, setPropFilter] = useState<number | "all">(initialPropertyId ?? "all");
  // Per-job inline "Move to date" editor: job id → picked date.
  const [moveJobId, setMoveJobId] = useState<number | null>(null);
  const [moveDate, setMoveDate] = useState("");
  const [moving, setMoving] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // [calendar-dnd 2026-07-07] Drag-and-drop reschedule (Maribel: "drag and
  // drop, edit, schedule, all that"). Each day cell renders per-visit chips;
  // dragging a chip onto another day quick-reschedules it (same PUT the Move
  // button and dispatch drag-and-drop use). Desktop pointer only — HTML5 DnD
  // doesn't fire on touch, so the popover's Move button stays the mobile path
  // (and the cross-month path; a drag can't leave the visible month).
  const [dragJob, setDragJob] = useState<CalJob | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Follow a property deep-link from the Properties tab even after mount.
  useEffect(() => {
    if (initialPropertyId != null) setPropFilter(initialPropertyId);
  }, [initialPropertyId]);

  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/api/accounts/${accountId}/properties`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then(d => {
        if (cancelled) return;
        const list = Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []);
        setProperties(list.map((p: any) => ({ id: p.id, property_name: p.property_name ?? null, address: p.address ?? null })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const from = ymd(year, monthIdx, 1);
    const to = ymd(year, monthIdx, daysInMonth);
    fetch(`${API}/api/accounts/${accountId}/jobs-calendar?from=${from}&to=${to}`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then(d => { if (!cancelled) setJobs(Array.isArray(d) ? d : []); })
      .catch(() => { if (!cancelled) setJobs([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId, year, monthIdx, daysInMonth, reloadTick]);

  const visibleJobs = useMemo(
    () => propFilter === "all" ? jobs : jobs.filter(j => j.account_property_id === propFilter),
    [jobs, propFilter],
  );

  // Bucket jobs by scheduled_date (string key, no timezone math).
  const byDate = useMemo(() => {
    const m: Record<string, CalJob[]> = {};
    for (const j of visibleJobs) {
      const key = (j.scheduled_date || "").slice(0, 10);
      if (!key) continue;
      (m[key] ||= []).push(j);
    }
    return m;
  }, [visibleJobs]);

  const startWeekday = new Date(year, monthIdx, 1).getDay();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(ymd(year, monthIdx, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const todayKey = ymd(today.getFullYear(), today.getMonth(), today.getDate());

  function shiftMonth(delta: number) {
    let m = monthIdx + delta;
    let y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setMonthIdx(m); setYear(y); setOpenDay(null); setMoveJobId(null);
  }
  function goToday() { setYear(today.getFullYear()); setMonthIdx(today.getMonth()); setOpenDay(null); setMoveJobId(null); }

  function dayColor(dayJobs: CalJob[]) {
    for (const s of STATUS_PRIORITY) {
      if (dayJobs.some(j => j.status === s)) return STATUS_COLOR[s];
    }
    return "#00C9A0";
  }

  function openJobInDispatch(j: CalJob) {
    navigate(`/jobs?date=${(j.scheduled_date || "").slice(0, 10)}&job=${j.id}`);
  }
  function newJobOnDay(key: string) {
    navigate(`/jobs?date=${key}&new=1`);
  }

  const isMovable = (j: CalJob) => j.status !== "complete" && j.status !== "cancelled";

  // Shared reschedule: the Move button and chip drag-and-drop both land here.
  async function moveJob(j: CalJob, targetDate: string) {
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return;
    if (targetDate === (j.scheduled_date || "").slice(0, 10)) { setMoveJobId(null); return; }
    setMoving(true);
    try {
      const res = await fetch(`${API}/api/jobs/${j.id}`, {
        method: "PUT",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled_date: targetDate }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.message || d.error || "Failed to move job");
      }
      toast({ title: `Moved to ${targetDate}` });
      setMoveJobId(null);
      setOpenDay(null);
      setReloadTick(t => t + 1);
    } catch (e: any) {
      toast({ title: "Couldn't move job", description: e?.message || "", variant: "destructive" });
    } finally {
      setMoving(false);
    }
  }

  function chipLabel(j: CalJob): string {
    const name = j.property_name || j.property_address || fmtSvc(j.service_type);
    const t = fmtTime(j.scheduled_time);
    return t ? `${t} ${name}` : name;
  }

  const propLabel = (p: PropOption) => p.property_name || p.address || `Property #${p.id}`;

  return (
    <div className="bg-white rounded-xl border border-[#E5E2DC] p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-[#1A1917]">{MONTHS[monthIdx]} {year}</span>
          {loading && <span className="text-xs text-gray-400">loading…</span>}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {properties.length > 0 && (
            <select
              value={propFilter === "all" ? "all" : String(propFilter)}
              onChange={e => { setPropFilter(e.target.value === "all" ? "all" : parseInt(e.target.value, 10)); setOpenDay(null); setMoveJobId(null); }}
              className="text-xs font-semibold text-[#1A1917] border border-[#E5E2DC] rounded-md px-2 py-1.5 bg-white max-w-[200px]"
              aria-label="Filter by property"
            >
              <option value="all">All properties</option>
              {properties.map(p => (
                <option key={p.id} value={p.id}>{propLabel(p)}</option>
              ))}
            </select>
          )}
          <button onClick={goToday} className="text-xs font-semibold text-[#1A1917] border border-[#E5E2DC] rounded-md px-2.5 py-1 hover:bg-[#F7F6F3]">Today</button>
          <button onClick={() => shiftMonth(-1)} aria-label="Previous month" className="p-1.5 rounded-md hover:bg-[#F7F6F3] text-gray-500"><ChevronLeft size={16} /></button>
          <button onClick={() => shiftMonth(1)} aria-label="Next month" className="p-1.5 rounded-md hover:bg-[#F7F6F3] text-gray-500"><ChevronRight size={16} /></button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEKDAYS.map(w => (
          <div key={w} className="text-[10px] font-bold text-gray-400 text-center tracking-wide py-1">{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((key, i) => {
          if (!key) return <div key={`b${i}`} className="min-h-[64px] rounded-lg bg-[#FAFAF9]" />;
          const dayJobs = byDate[key] || [];
          const dayNum = parseInt(key.slice(8, 10), 10);
          const isToday = key === todayKey;
          const isOpen = openDay === key;
          const isDropTarget = dragJob != null && dropDay === key && (dragJob.scheduled_date || "").slice(0, 10) !== key;
          // Per-visit chips (drag handles) — first two visible, rest behind a
          // "+N more" pill that opens the day popover.
          const visibleChips = dayJobs.slice(0, 2);
          const extra = dayJobs.length - visibleChips.length;
          return (
            <div
              key={key}
              className={`relative min-h-[64px] rounded-lg border p-1.5 cursor-pointer ${isDropTarget ? "border-[#00C9A0] bg-[#E7F9F3] border-2" : isToday ? "border-[#00C9A0] bg-[#F0FDFB]" : "border-[#E5E2DC] bg-white"}`}
              style={{ zIndex: isOpen ? 30 : 1 }}
              onClick={() => { setOpenDay(prev => (prev === key ? null : key)); setMoveJobId(null); }}
              onDragOver={e => { if (dragJob) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
              onDragEnter={() => { if (dragJob) setDropDay(key); }}
              onDragLeave={e => {
                // Only clear when actually leaving the cell (not entering a child).
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
                  setDropDay(prev => (prev === key ? null : prev));
                }
              }}
              onDrop={e => {
                e.preventDefault();
                const j = dragJob;
                setDragJob(null); setDropDay(null);
                if (j && isMovable(j) && (j.scheduled_date || "").slice(0, 10) !== key) void moveJob(j, key);
              }}
            >
              <div className={`text-[11px] font-semibold ${isToday ? "text-[#00897B]" : "text-gray-500"}`}>{dayNum}</div>

              {dayJobs.length > 0 && (
                <div className="mt-1 flex flex-col gap-0.5">
                  {visibleChips.map(j => (
                    <div
                      key={j.id}
                      draggable={isMovable(j)}
                      onDragStart={e => {
                        e.stopPropagation();
                        e.dataTransfer.setData("text/plain", String(j.id));
                        e.dataTransfer.effectAllowed = "move";
                        setDragJob(j);
                        setOpenDay(null);
                      }}
                      onDragEnd={() => { setDragJob(null); setDropDay(null); }}
                      title={isMovable(j) ? `${chipLabel(j)} — drag to another day to reschedule` : chipLabel(j)}
                      className="rounded px-1 py-0.5 text-[9.5px] font-bold text-white truncate leading-tight"
                      style={{
                        background: STATUS_COLOR[j.status] || "#9CA3AF",
                        cursor: isMovable(j) ? "grab" : "default",
                        opacity: dragJob?.id === j.id ? 0.4 : 1,
                      }}
                    >
                      {chipLabel(j)}
                    </div>
                  ))}
                  {extra > 0 && (
                    <span
                      className="inline-flex self-center items-center rounded-full px-1.5 py-px text-[9.5px] font-bold text-white"
                      style={{ background: dayColor(dayJobs) }}
                    >
                      +{extra} more
                    </span>
                  )}
                </div>
              )}

              {isOpen && (
                <div
                  className="absolute left-1/2 top-full mt-1 -translate-x-1/2 w-72 max-h-80 overflow-auto bg-white rounded-xl border border-[#E5E2DC] shadow-xl p-2.5 text-left cursor-default"
                  onClick={e => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-[11px] font-bold text-[#1A1917] m-0">
                      {MONTHS[monthIdx]} {dayNum}{dayJobs.length ? ` — ${dayJobs.length} ${dayJobs.length === 1 ? "job" : "jobs"}` : ""}
                    </p>
                    <button
                      onClick={() => newJobOnDay(key)}
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-[#00C9A0] hover:bg-[#00b38f] rounded-md px-2 py-1"
                      title="Open the New Job wizard on this date"
                    >
                      <Plus size={11} /> New job
                    </button>
                  </div>
                  {dayJobs.length === 0 && (
                    <p className="text-[11px] text-gray-400 m-0">No visits this day.</p>
                  )}
                  <div className="flex flex-col gap-1.5">
                    {dayJobs.map(j => {
                      const movable = isMovable(j);
                      return (
                        <div key={j.id} className="rounded-lg bg-[#F7F6F3] p-2">
                          <div className="flex items-center justify-between gap-2">
                            <button
                              onClick={() => openJobInDispatch(j)}
                              className="text-[11px] font-semibold text-[#1A1917] truncate hover:text-[#00897B] hover:underline text-left bg-transparent border-0 p-0 cursor-pointer"
                              title="Open this job's editor"
                            >
                              {j.property_name || j.property_address || "Property"}
                            </button>
                            <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: STATUS_COLOR[j.status] || "#9CA3AF" }} title={j.status} />
                          </div>
                          <div className="text-[10px] text-gray-500 mt-0.5">
                            {fmtTime(j.scheduled_time)}{j.scheduled_time ? " · " : ""}{fmtSvc(j.service_type)}
                          </div>
                          <div className="text-[10px] text-gray-500 mt-0.5 flex justify-between">
                            <span>{j.tech_first_name ? `${j.tech_first_name} ${j.tech_last_name ?? ""}`.trim() : "Unassigned"}</span>
                            <span className="font-semibold text-[#6B6860]">{fmtMoney(j.base_fee)}</span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <button
                              onClick={() => openJobInDispatch(j)}
                              className="inline-flex items-center gap-1 text-[10px] font-bold text-[#065F46] bg-[#ECFDF5] border border-[#A7F3D0] rounded-md px-1.5 py-0.5 cursor-pointer"
                            >
                              <ExternalLink size={10} /> Edit
                            </button>
                            {movable && (moveJobId === j.id ? (
                              <span className="inline-flex items-center gap-1">
                                <input
                                  type="date"
                                  value={moveDate}
                                  onChange={e => setMoveDate(e.target.value)}
                                  className="text-[10px] border border-[#E5E2DC] rounded-md px-1 py-0.5"
                                />
                                <button
                                  onClick={() => moveJob(j, moveDate)}
                                  disabled={moving}
                                  className="text-[10px] font-bold text-white bg-[#16A34A] rounded-md px-1.5 py-0.5 cursor-pointer disabled:opacity-60"
                                >
                                  {moving ? "…" : "Save"}
                                </button>
                                <button
                                  onClick={() => setMoveJobId(null)}
                                  className="text-[10px] font-semibold text-gray-500 bg-white border border-[#E5E2DC] rounded-md px-1.5 py-0.5 cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </span>
                            ) : (
                              <button
                                onClick={() => { setMoveJobId(j.id); setMoveDate((j.scheduled_date || "").slice(0, 10)); }}
                                className="inline-flex items-center gap-1 text-[10px] font-bold text-[#1D4ED8] bg-[#EFF6FF] border border-[#BFDBFE] rounded-md px-1.5 py-0.5 cursor-pointer"
                                title="Move this visit to another date"
                              >
                                <CalendarClock size={10} /> Move
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-[#E5E2DC]">
        {[["scheduled", "Scheduled"], ["in_progress", "In progress"], ["complete", "Complete"], ["cancelled", "Cancelled"]].map(([s, label]) => (
          <div key={s} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: STATUS_COLOR[s] }} />
            <span className="text-[10px] text-gray-500">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
