import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Simplified per-account month calendar. Instead of MaidCentral's wall of
// one-bar-per-job (5-8 stacked bars per cell), each day shows a SINGLE count
// pill color-coded by status; the full per-job detail lives in a hover
// popover. Keeps the at-a-glance scan clean while preserving the drill-down.

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

export function AccountJobsCalendar({ accountId }: { accountId: number | string }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [monthIdx, setMonthIdx] = useState(today.getMonth());
  const [jobs, setJobs] = useState<CalJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();

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
  }, [accountId, year, monthIdx, daysInMonth]);

  // Bucket jobs by scheduled_date (string key, no timezone math).
  const byDate = useMemo(() => {
    const m: Record<string, CalJob[]> = {};
    for (const j of jobs) {
      const key = (j.scheduled_date || "").slice(0, 10);
      if (!key) continue;
      (m[key] ||= []).push(j);
    }
    return m;
  }, [jobs]);

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
    setMonthIdx(m); setYear(y); setHovered(null);
  }
  function goToday() { setYear(today.getFullYear()); setMonthIdx(today.getMonth()); setHovered(null); }

  function dayColor(dayJobs: CalJob[]) {
    for (const s of STATUS_PRIORITY) {
      if (dayJobs.some(j => j.status === s)) return STATUS_COLOR[s];
    }
    return "#00C9A0";
  }

  return (
    <div className="bg-white rounded-xl border border-[#E5E2DC] p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-[#1A1917]">{MONTHS[monthIdx]} {year}</span>
          {loading && <span className="text-xs text-gray-400">loading…</span>}
        </div>
        <div className="flex items-center gap-1">
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
          const isHovered = hovered === key;
          return (
            <div
              key={key}
              className={`relative min-h-[64px] rounded-lg border p-1.5 ${isToday ? "border-[#00C9A0] bg-[#F0FDFB]" : "border-[#E5E2DC] bg-white"}`}
              style={{ zIndex: isHovered ? 30 : 1 }}
              onMouseEnter={() => dayJobs.length && setHovered(key)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => { if (dayJobs.length) setHovered(prev => (prev === key ? null : key)); }}
            >
              <div className={`text-[11px] font-semibold ${isToday ? "text-[#00897B]" : "text-gray-500"}`}>{dayNum}</div>

              {dayJobs.length > 0 && (
                <div className="mt-1 flex justify-center">
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold text-white cursor-default"
                    style={{ background: dayColor(dayJobs) }}
                  >
                    {dayJobs.length} {dayJobs.length === 1 ? "job" : "jobs"}
                  </span>
                </div>
              )}

              {isHovered && dayJobs.length > 0 && (
                <div className="absolute left-1/2 top-full mt-1 -translate-x-1/2 w-64 max-h-72 overflow-auto bg-white rounded-xl border border-[#E5E2DC] shadow-xl p-2.5 text-left">
                  <p className="text-[11px] font-bold text-[#1A1917] mb-2">
                    {MONTHS[monthIdx]} {dayNum} — {dayJobs.length} {dayJobs.length === 1 ? "job" : "jobs"}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {dayJobs.map(j => (
                      <div key={j.id} className="rounded-lg bg-[#F7F6F3] p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-semibold text-[#1A1917] truncate">{j.property_name || j.property_address || "Property"}</span>
                          <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: STATUS_COLOR[j.status] || "#9CA3AF" }} title={j.status} />
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5">
                          {fmtTime(j.scheduled_time)}{j.scheduled_time ? " · " : ""}{fmtSvc(j.service_type)}
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5 flex justify-between">
                          <span>{j.tech_first_name ? `${j.tech_first_name} ${j.tech_last_name ?? ""}`.trim() : "Unassigned"}</span>
                          <span className="font-semibold text-[#6B6860]">{fmtMoney(j.base_fee)}</span>
                        </div>
                      </div>
                    ))}
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
