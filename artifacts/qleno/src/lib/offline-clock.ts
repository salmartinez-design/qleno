// [offline-clock 2026-06-11] Dead-zone resilience for the field clock. When a
// Clock In / Clock Out fails because there's no signal, we save it locally with
// the REAL on-site time + GPS, and replay it the moment the phone is back
// online — so a basement/rural job never loses a punch and never records a
// clock-out 30 minutes late at the tech's house. The backend accepts
// client_clock_in_at / client_clock_out_at (sanity-windowed) to honor the
// captured time over the sync time.

const KEY = "qleno_offline_clock_queue_v1";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export type ClockAction = {
  id: string;
  type: "in" | "out";
  job_id: number;
  entry_id?: number | null;
  ts: string; // captured on-site ISO time
  lat?: number;
  lng?: number;
  accuracy?: number;
  acting_for_user_id?: number | null;
  queued_at: number;
};

function read(): ClockAction[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}
function write(q: ClockAction[]) { try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* storage full / disabled */ } }
function remove(id: string) { write(read().filter(x => x.id !== id)); }

export function queueLength(): number { return read().length; }

export function enqueueClock(a: Omit<ClockAction, "id" | "queued_at">): void {
  const q = read();
  q.push({ ...a, id: `${a.type}-${a.job_id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, queued_at: Date.now() });
  write(q);
}

/** True when an error from a clock POST means "offline / unreachable" (vs a real
 *  server rejection like a geofence block, which is a legit response). */
export function isOfflineError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  // fetch() rejects with a TypeError on network failure.
  return e instanceof TypeError;
}

let flushing = false;

export async function flushClockQueue(token: string | null): Promise<{ synced: number; remaining: number }> {
  if (flushing || !token || (typeof navigator !== "undefined" && navigator.onLine === false)) {
    return { synced: 0, remaining: read().length };
  }
  flushing = true;
  let synced = 0;
  const hdrs = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  try {
    // Pass 1 — clock-ins first, so a same-job clock-out can inherit the new
    // entry id. 409/422 = already handled server-side; treat as done.
    for (const a of read().filter(x => x.type === "in").sort((x, y) => x.queued_at - y.queued_at)) {
      try {
        const body: any = { job_id: a.job_id, client_clock_in_at: a.ts };
        if (a.lat != null && a.lng != null) { body.lat = a.lat; body.lng = a.lng; }
        if (a.accuracy != null) body.accuracy = a.accuracy;
        if (a.acting_for_user_id != null) body.acting_for_user_id = a.acting_for_user_id;
        const res = await fetch(`${BASE}/api/timeclock/clock-in`, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
        if (!res.ok && res.status !== 409 && res.status !== 422) throw new Error(String(res.status));
        const data = await res.json().catch(() => ({}));
        const newId = (data && (data.id ?? data.entry_id)) || null;
        if (newId) {
          // Fill the entry id on any queued clock-out for the same job.
          write(read().map(x => (x.type === "out" && x.job_id === a.job_id && x.entry_id == null) ? { ...x, entry_id: newId } : x));
        }
        remove(a.id);
        synced++;
      } catch { /* leave queued, retry next flush */ }
    }
    // Pass 2 — clock-outs (re-read so inherited entry ids are visible).
    for (const a of read().filter(x => x.type === "out").sort((x, y) => x.queued_at - y.queued_at)) {
      if (a.entry_id == null) continue; // unresolved; a future flush after its clock-in lands will fill it
      try {
        const body: any = { client_clock_out_at: a.ts };
        if (a.lat != null && a.lng != null) { body.lat = a.lat; body.lng = a.lng; }
        const res = await fetch(`${BASE}/api/timeclock/${a.entry_id}/clock-out`, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
        if (!res.ok && res.status !== 404) throw new Error(String(res.status));
        remove(a.id);
        synced++;
      } catch { /* leave queued */ }
    }
  } finally {
    flushing = false;
  }
  return { synced, remaining: read().length };
}
