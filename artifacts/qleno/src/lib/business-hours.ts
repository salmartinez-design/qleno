// [business-hours 2026-06-11] Shared parser for company.business_hours
// free-form text. Extracted so both the dispatch board (jobs.tsx) and the
// tech My Jobs day banner read shift windows the same way. The dispatch
// board still has its own historical copy; this is the canonical home for
// new consumers.

// Strict 12-hour "H:MM AM/PM" → minutes-since-midnight. null on bad input,
// so a parse failure is distinguishable from a valid time.
export function strictParseAmpm(t: string): number | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const isPM = m[3].toUpperCase() === "PM";
  if (h === 12) h = isPM ? 12 : 0;
  else if (isPM) h += 12;
  return h * 60 + mm;
}

// Minutes-since-midnight → "9:00 AM".
export function minToAmpm(min: number): string {
  const h24 = Math.floor(min / 60) % 24;
  const mm = ((min % 60) + 60) % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

// 0=Sunday … 6=Saturday (matches JS Date.getDay()).
export type DayHours = { startMin: number; endMin: number } | "closed";
export type BusinessHoursMap = Map<number, DayHours>;

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// Parse free-form company.business_hours into a per-weekday map. Accepts
// en-dash / em-dash / hyphen and day ranges:
//   "Monday – Friday: 9:00 AM – 6:00 PM"
//   "Saturday: 9:00 AM – 12:00 PM"
//   "Sunday: Closed"
// Unparseable days simply aren't set — the caller decides the fallback.
export function parseBusinessHours(text: string | null | undefined): BusinessHoursMap {
  const out: BusinessHoursMap = new Map();
  if (!text) return out;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const daysPart = line.slice(0, colonIdx).trim();
    const hoursPart = line.slice(colonIdx + 1).trim();

    const rangeMatch = daysPart.match(/^(\w+)\s*[-–—]\s*(\w+)$/);
    const daysForLine: number[] = [];
    if (rangeMatch) {
      const from = DAY_NAMES[rangeMatch[1].toLowerCase()];
      const to = DAY_NAMES[rangeMatch[2].toLowerCase()];
      if (from == null || to == null) continue;
      let idx = from;
      for (let safety = 0; safety < 8; safety++) {
        daysForLine.push(idx);
        if (idx === to) break;
        idx = (idx + 1) % 7;
      }
    } else {
      const d = DAY_NAMES[daysPart.toLowerCase()];
      if (d == null) continue;
      daysForLine.push(d);
    }

    if (/^closed$/i.test(hoursPart)) {
      for (const d of daysForLine) out.set(d, "closed");
      continue;
    }
    const hMatch = hoursPart.match(/^(\d{1,2}:\d{2}\s*[AP]M)\s*[-–—]\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
    if (!hMatch) continue;
    const startMin = strictParseAmpm(hMatch[1]);
    const endMin = strictParseAmpm(hMatch[2]);
    if (startMin == null || endMin == null) continue;
    for (const d of daysForLine) out.set(d, { startMin, endMin });
  }
  return out;
}

// The shift window for a given weekday, formatted, or "closed", or null when
// the tenant hasn't configured that day.
export function shiftForWeekday(
  text: string | null | undefined,
  weekday: number,
): { start: string; end: string } | "closed" | null {
  const h = parseBusinessHours(text).get(weekday);
  if (!h) return null;
  if (h === "closed") return "closed";
  return { start: minToAmpm(h.startMin), end: minToAmpm(h.endMin) };
}
