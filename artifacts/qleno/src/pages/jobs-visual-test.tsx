/**
 * [job-card-redesign] Visual proof page for the JobChip lifecycle states.
 *
 * Renders every visual status side-by-side at narrow (~30 min, single-line)
 * and wide (~3 h, full two-row) widths, plus the new-client overlay. Used
 * for visual review before merging the chip redesign — gives the reviewer
 * a single screenshot that proves all state treatments render correctly.
 *
 * Route: /jobs/visual-test (dev-only — NOT mounted in production builds).
 *
 * Why a dedicated page rather than Storybook: this codebase doesn't have
 * Storybook yet, and adding it just for one component would be heavy.
 * One self-contained page that reuses the real JobChip via a `forceStatus`
 * prop is sufficient for the verification ask.
 */
import { DndContext } from "@dnd-kit/core";
import { _JobChipForTesting as JobChip, type _DispatchJobForTesting as DispatchJob } from "@/pages/jobs";
import { ensureJobStatusStyles, type JobVisualStatus } from "@/lib/job-status";
import { useEffect } from "react";

const FF = "'Plus Jakarta Sans', sans-serif";

const STATES: Array<{ status: JobVisualStatus; label: string; note?: string }> = [
  { status: "scheduled",        label: "Scheduled",         note: "Default — on the board, no clock-in yet." },
  { status: "en_route",         label: "En route",          note: "Tech tapped 'On My Way'. Inert in prod until en_route_at column lands." },
  { status: "active",           label: "In progress",       note: "Clocked in. Amber stripe pulses; progress bar fills with elapsed/allowed." },
  { status: "completed",        label: "Completed",         note: "Status='complete'. Body fades to 60% + green check badge." },
  { status: "completed_unpaid", label: "Completed (unpaid)",note: "Complete but online charge not yet succeeded. Amber ring + UNPAID pill." },
  { status: "late_clockin",     label: "Late clock-in",     note: "5+ min past start, no clock-in. Red border + LATE pill." },
  { status: "no_show",          label: "No show",           note: "30+ min past start, no clock-in. Solid red border + NO SHOW badge." },
  { status: "cancelled",        label: "Cancelled",         note: "Manually cancelled. Body desaturated + name strikethrough." },
  { status: "unassigned",       label: "Unassigned",        note: "No primary tech. Amber border. Normally lives in the Unassigned row." },
];

// Representative residential job — has add-ons + price delta.
const baseRes: DispatchJob = {
  id: 1001,
  client_id: 5001,
  client_name: "Maria Hernandez",
  client_phone: "(773) 555-0101",
  client_zip: "60629",
  client_notes: null,
  client_payment_method: "stripe",
  client_type: "residential",
  address: "5421 S Kedzie Ave, Chicago, IL 60629",
  assigned_user_id: 12,
  service_type: "deep_clean",
  status: "scheduled",
  scheduled_date: "2026-04-29",
  scheduled_time: "08:00",
  frequency: "biweekly",
  amount: 220,             // base_fee
  billed_amount: 265,      // current — drives the delta pill
  duration_minutes: 180,   // 3 hours → wide layout
  notes: null,
  before_photo_count: 0,
  after_photo_count: 0,
  clock_entry: null,
  zone_id: 7,
  zone_color: "#9C4E2B",   // Cook Central — purple
  zone_name: "Chicago Central",
  add_ons: [
    { name: "Inside Oven",  quantity: 1, unit_price: 35, subtotal: 35 },
    { name: "Inside Fridge",quantity: 1, unit_price: 35, subtotal: 35 },
  ],
  is_new_client: false,
  account_id: null,
  account_name: null,
  billing_method: null,
  hourly_rate: null,
  estimated_hours: 3,
  actual_hours: null,
  billed_hours: null,
  charge_failed_at: null,
  charge_succeeded_at: null,
  technicians: [{ user_id: 12, name: "Pancho Ramos", is_primary: true, est_hours: 3, calc_pay: 92.75, final_pay: 92.75, pay_override: null }],
  est_hours_per_tech: 3,
  est_pay_per_tech: 92.75,
  company_res_pct: 0.35,
  commission_basis: "residential_pool",
  commercial_hourly_rate: null,
  locked_at: null,
  actual_end_time: null,
  completed_by_user_id: null,
};

// Representative commercial job — no add-ons, hourly billing.
const baseCom: DispatchJob = {
  ...baseRes,
  id: 2001,
  client_id: 0,
  client_name: "Riverside Office Tower",
  client_phone: "(708) 555-0202",
  client_zip: "60546",
  client_payment_method: "square",
  client_type: "commercial",
  address: "31 W Quincy St, Riverside, IL 60546",
  service_type: "office_cleaning",
  scheduled_time: "10:00",
  frequency: "weekly",
  amount: 0,
  billed_amount: null,
  duration_minutes: 180,
  zone_id: 11,
  zone_color: "#2F3646",   // West/Riverside — blue
  zone_name: "West Suburbs",
  add_ons: [],
  is_new_client: false,
  account_id: 7,
  account_name: "Riverside Office Tower",
  billing_method: "hourly",
  hourly_rate: 60,
  technicians: [
    { user_id: 12, name: "Pancho Ramos",  is_primary: true,  est_hours: 1.5, calc_pay: 30, final_pay: 30, pay_override: null },
    { user_id: 14, name: "Maribel Ortiz", is_primary: false, est_hours: 1.5, calc_pay: 30, final_pay: 30, pay_override: null },
  ],
  commission_basis: "commercial_hourly",
  commercial_hourly_rate: 60,
};

// Builders that mutate the right fields for each visual state. Using
// real shape + overrides rather than fabricating gives an honest
// preview of what dispatchers will see.
function withState(base: DispatchJob, status: JobVisualStatus, narrow: boolean): DispatchJob {
  const j: DispatchJob = {
    ...base,
    duration_minutes: narrow ? 30 : 180,
    scheduled_time: narrow ? "08:00" : "08:00",
  };
  // The forceStatus prop on JobChip handles the visual override — we
  // still seed a few derivation fields so any helper inside the chip
  // that reads them (live timer math, late-min math) gets sensible
  // values rather than NaN.
  switch (status) {
    case "active":
      j.clock_entry = { id: 1, clock_in_at: new Date(Date.now() - 72 * 60 * 1000).toISOString(), clock_out_at: null, distance_from_job_ft: 12, is_flagged: false };
      j.status = "in_progress";
      break;
    case "en_route":
      j.en_route_at = new Date(Date.now() - 8 * 60 * 1000).toISOString();
      break;
    case "completed":
      j.status = "complete";
      j.charge_succeeded_at = new Date().toISOString();
      j.client_payment_method = "stripe";
      break;
    case "completed_unpaid":
      j.status = "complete";
      j.charge_succeeded_at = null;
      j.client_payment_method = "stripe";
      break;
    case "late_clockin":
      // 12 minutes past scheduled_time, no clock-in. The chip's lateMin
      // helper computes from now − scheduled_time; bump scheduled_time
      // to "now − 12 min" so the LATE pill shows a realistic value.
      const lateNow = new Date();
      const lateMins = lateNow.getHours() * 60 + lateNow.getMinutes() - 12;
      j.scheduled_time = `${String(Math.floor(lateMins / 60)).padStart(2, "0")}:${String(lateMins % 60).padStart(2, "0")}`;
      j.status = "scheduled";
      j.clock_entry = null;
      break;
    case "no_show":
      const nsNow = new Date();
      const nsMins = nsNow.getHours() * 60 + nsNow.getMinutes() - 45;
      j.scheduled_time = `${String(Math.floor(nsMins / 60)).padStart(2, "0")}:${String(nsMins % 60).padStart(2, "0")}`;
      j.status = "scheduled";
      j.clock_entry = null;
      break;
    case "cancelled":
      j.status = "cancelled";
      break;
    case "unassigned":
      j.assigned_user_id = null;
      break;
  }
  return j;
}

const noop = () => {};

function ChipFrame({ children }: { children: React.ReactNode }) {
  // The chip is `position: absolute` and lays itself out from
  // scheduled_time → left, duration → width. Wrap each chip in a
  // 480 × 80 relative box so chips don't collide with the next row.
  return (
    <div style={{ position: "relative", width: 480, height: 80, marginTop: 8, background: "#FAF9F6", borderRadius: 8 }}>
      {children}
    </div>
  );
}

function StateRow({ status, label, note, narrow, newClient }: { status: JobVisualStatus; label: string; note?: string; narrow: boolean; newClient: boolean }) {
  const base = status === "no_show" || status === "late_clockin" ? baseRes : (status === "unassigned" ? baseRes : baseRes);
  const job = withState({ ...base, is_new_client: newClient }, status, narrow);
  const jobCom = withState({ ...baseCom, is_new_client: false }, status, narrow);
  return (
    <div style={{ borderBottom: "1px solid #EAE6DF", padding: "16px 0" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>{label}</div>
        {newClient && <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "#FFF1B8", color: "#B45309" }}>NEW-CLIENT OVERLAY</span>}
        {note && <div style={{ fontSize: 12, color: "#6B6860" }}>{note}</div>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 4 }}>Residential · {narrow ? "narrow ~30 min" : "wide ~3 h"}</div>
          <ChipFrame>
            <JobChip job={job} onClick={noop} forceStatus={status} />
          </ChipFrame>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 4 }}>Commercial · {narrow ? "narrow ~30 min" : "wide ~3 h"}</div>
          <ChipFrame>
            <JobChip job={jobCom} onClick={noop} forceStatus={status} />
          </ChipFrame>
        </div>
      </div>
    </div>
  );
}

export default function JobsVisualTestPage() {
  useEffect(() => { ensureJobStatusStyles(); }, []);

  // Production guard — this route should never mount in PROD bundles
  // anyway (App.tsx gates it), but if someone forces it here we render
  // a not-available message instead of leaking demo data.
  if (import.meta.env.PROD) {
    return (
      <div style={{ padding: 40, fontFamily: FF, color: "#1A1917" }}>
        Not available in production builds.
      </div>
    );
  }

  return (
    <DndContext>
      <div style={{ padding: "24px 32px 80px", background: "#F7F6F3", minHeight: "100vh", fontFamily: FF }}>
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: "#1A1917" }}>JobChip · visual test</div>
            <div style={{ fontSize: 13, color: "#6B6860", marginTop: 4, lineHeight: 1.5 }}>
              All lifecycle states rendered with representative data — residential w/ add-ons + price delta, and commercial hourly w/o add-ons. Each state shown at narrow (~30 min, single-line layout) and wide (~3 h, full two-row layout). The <code>forceStatus</code> prop bypasses the LIVE_OPS / clock-derivation gates so late_clockin and no_show paint even outside go-live.
            </div>
          </div>

          <div style={{ fontSize: 18, fontWeight: 800, color: "#1A1917", marginTop: 16 }}>Wide chips (~3 h)</div>
          {STATES.map(s => <StateRow key={`w-${s.status}`} status={s.status} label={s.label} note={s.note} narrow={false} newClient={false} />)}

          <div style={{ fontSize: 18, fontWeight: 800, color: "#1A1917", marginTop: 32 }}>Narrow chips (~30 min)</div>
          {STATES.map(s => <StateRow key={`n-${s.status}`} status={s.status} label={s.label} note={s.note} narrow={true} newClient={false} />)}

          <div style={{ fontSize: 18, fontWeight: 800, color: "#1A1917", marginTop: 32 }}>NEW-client overlay (on scheduled)</div>
          <StateRow status="scheduled" label="Scheduled + new-client overlay" note="Inset white outline + NEW pill before client name. Triggered server-side when a residential client has no completed jobs prior to today's board date." narrow={false} newClient={true} />
        </div>
      </div>
    </DndContext>
  );
}
