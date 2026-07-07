/**
 * Cutover 3A — Employee leave request form + own-balances view.
 *
 * Mounted at /leave. The tech sees their own balances per bucket
 * (granted, used, available, past-waiting-period flag) and a small
 * form to submit a new request. Balance refreshes after submit.
 */
import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useToast } from "@/hooks/use-toast";
import { CalendarPopover } from "@/components/calendar-popover";
import { parseLeaveNote, leaveBucketLabel, KIND_TONE_STYLE } from "@/lib/leave-note-format";
import { getAuthHeaders } from "@/lib/auth";

// Smart usage-bar colors (match the office profile cards).
const LEAVE_LOW = "#BA7517";
const LEAVE_OUT = "#E24B4A";
const NEUTRAL_ACCENT = "#374151";
function daysUntilYmd(ymd: string): number {
  const t = new Date(`${ymd}T00:00:00Z`).getTime();
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  return Math.round((t - today) / 86400000);
}
function shortDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const FF = "'Plus Jakarta Sans', sans-serif";
const BRAND = "#00C9A0";
const INK = "#1A1917";
const MUTED = "#9E9B94";
const CARD = "#FFFFFF";
const BORDER = "#E5E2DC";
const DANGER = "#DC2626";

type Balance = {
  leave_type_id: number;
  display_name: string;
  slug: string;
  accrual_mode: string;
  granted: number;
  used: number;
  available: number;
  annual_cap_hours: number;
  waiting_period_days: number;
  past_waiting_period: boolean;
  hire_date_missing?: boolean;
  // Phase 3 tenant-dynamic display + Phase 2 reset/eligibility (from balances/me)
  accent?: string;
  chip_label?: string;
  next_reset_date?: string | null;
  eligible_on?: string | null;
};

type UsageRow = { date_used: string; hours: string; notes: string | null };

type MyRequest = {
  id: number;
  leave_type_id: number;
  start_date: string;
  end_date: string;
  hours: string;
  start_time?: string | null;
  end_time?: string | null;
  status: "pending" | "approved" | "denied" | "cancelled";
  blackout_conflict: boolean;
  blackout_label: string | null;
  decision_note: string | null;
};

// "09:00" / "09:00:00" → "9:00 AM"
function fmtHHMM(t: string): string {
  const [hStr, mStr] = t.split(":");
  let h = parseInt(hStr, 10);
  if (isNaN(h)) return t;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${mStr ?? "00"} ${ampm}`;
}

export default function LeaveRequestPage() {
  const { toast } = useToast();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [requests, setRequests] = useState<MyRequest[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [historyBucket, setHistoryBucket] = useState<null | { slug: string; display_name: string }>(null);
  const [loading, setLoading] = useState(false);
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [dayUnit, setDayUnit] = useState<"full_day" | "morning" | "afternoon" | "custom">("full_day");
  // [custom-hours 2026-07-07] Francisco: "there should be an option for them to
  // choose hours, for example they can work from 9am to 1pm." Single-day only;
  // the requested-off window is start→end and hours are derived from it.
  const [customStart, setCustomStart] = useState("09:00");
  const [customEnd, setCustomEnd] = useState("13:00");
  const [attachment, setAttachment] = useState<{ url: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const multiDay = !!startDate && !!endDate && endDate > startDate;

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      // [leave-auth 2026-07-07] The API is Bearer-token only (requireAuth reads
      // the Authorization header; there is no cookie session). These fetches
      // used credentials:"include" with no token, so every call 401'd and the
      // page rendered EMPTY — no balance cards, no buckets in the dropdown
      // (Hilda: "It has nothing"). Every request on this page now carries the
      // token, same as the rest of the app.
      const [bRes, rRes, uRes] = await Promise.all([
        fetch("/api/leave/balances/me", { headers: getAuthHeaders() }),
        fetch("/api/leave/requests/mine", { headers: getAuthHeaders() }),
        fetch("/api/leave/usage/me", { headers: getAuthHeaders() }),
      ]);
      const bJson = await bRes.json();
      const rJson = await rRes.json();
      const uJson = await uRes.json();
      setBalances(bJson.data ?? []);
      setRequests(rJson.data ?? []);
      setUsage(uJson.data ?? []);
    } catch {
      toast({ title: "Could not load leave data", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // Bearer header only — the browser sets the multipart Content-Type itself.
      const res = await fetch("/api/leave/upload", { method: "POST", headers: getAuthHeaders(), body: fd });
      if (!res.ok) throw new Error("upload failed");
      const j = await res.json();
      setAttachment({ url: j.file_url, name: j.file_name });
    } catch {
      toast({ title: "Upload failed — try again", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (!selectedBucket || !startDate || !endDate) {
      toast({ title: "Pick a bucket and dates", variant: "destructive" });
      return;
    }
    if (!attachment) {
      toast({ title: "An attachment (e.g. a doctor's note) is required", variant: "destructive" });
      return;
    }
    const unit = multiDay ? "full_day" : dayUnit;
    if (unit === "custom") {
      if (!customStart || !customEnd || customEnd <= customStart) {
        toast({ title: "Pick a valid time window (end after start)", variant: "destructive" });
        return;
      }
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/leave/requests", {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          leave_type_id: selectedBucket,
          start_date: startDate,
          end_date: endDate,
          day_unit: unit,
          ...(unit === "custom" ? { start_time: customStart, end_time: customEnd } : {}),
          attachment_url: attachment.url,
          attachment_name: attachment.name,
          note: note || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast({
          title: err?.message || "Submit failed",
          variant: "destructive",
        });
        return;
      }
      const json = await res.json();
      if (json.data?.blackout_conflict) {
        toast({
          title: `Auto-denied — overlaps "${json.data.blackout_label}". Office can override.`,
        });
      } else {
        toast({ title: "Request submitted" });
      }
      setNote("");
      setAttachment(null);
      setDayUnit("full_day");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  const requestableBuckets = balances.filter(
    (b) => b.accrual_mode !== "office_recorded" && b.past_waiting_period,
  );

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, color: INK, padding: "8px 0 32px", maxWidth: 760, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>My Time Off</h1>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 16 }}>
          Submit a request and check your balances.
        </div>

        {/* Balances — data-driven cards matching the office profile, MINUS the
            office-only discipline content (no Tardies card, no discipline
            standing, no occurrence ladder). The tech sees their balances,
            usage bar, reset countdown, waiting note, and their own history. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10, marginBottom: 20 }}>
          {loading ? (
            <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>
          ) : (
            balances.map((b) => {
              const accent = b.accent || NEUTRAL_ACCENT;
              const officeRecorded = b.accrual_mode === "office_recorded";
              const notVested = !officeRecorded && !b.past_waiting_period;
              const granted = b.granted, used = b.used, avail = b.available;
              const barPct = !officeRecorded && granted > 0 ? Math.min(100, (used / granted) * 100) : 0;
              const barColor = avail <= 0 ? LEAVE_OUT : (granted > 0 && avail <= 0.2 * granted) ? LEAVE_LOW : accent;
              const resetDays = !officeRecorded && b.next_reset_date ? daysUntilYmd(b.next_reset_date) : null;
              const eligDays = b.eligible_on ? daysUntilYmd(b.eligible_on) : null;
              return (
                <div key={b.leave_type_id} style={{ backgroundColor: CARD, border: `1px solid ${BORDER}`, borderLeft: `4px solid ${accent}`, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: accent, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, fontWeight: 800, color: accent, textTransform: "uppercase", letterSpacing: "0.04em" }}>{b.display_name}</span>
                    </div>
                    {resetDays != null && resetDays >= 0 && !notVested && (
                      <span style={{ fontSize: 10, color: MUTED, whiteSpace: "nowrap" }}>resets {shortDate(b.next_reset_date!)}</span>
                    )}
                  </div>
                  {notVested ? (
                    <div style={{ marginTop: 8 }}>
                      {/* [hire-date-lockout 2026-07-07] Missing hire date is a
                          fixable data gap, not a waiting period — say so, so
                          the employee knows to ask the office instead of
                          assuming they haven't earned it yet. */}
                      <div style={{ fontSize: 14, fontWeight: 700, color: accent }}>
                        {b.hire_date_missing
                          ? "Hire date not on file"
                          : eligDays != null && eligDays > 0 ? `Unlocks in ${eligDays} day${eligDays === 1 ? "" : "s"}` : "Eligible after waiting period"}
                      </div>
                      {b.hire_date_missing ? (
                        <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>Ask the office to set your hire date to unlock this.</div>
                      ) : b.eligible_on && eligDays != null && eligDays > 0 && (
                        <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>available {shortDate(b.eligible_on)}</div>
                      )}
                    </div>
                  ) : officeRecorded ? (
                    // [40hr-bank 2026-07-07] Unexcused hours now come from the
                    // attendance log (was: a balance row nothing wrote — always
                    // 0.0). Shows consumption against the annual allowance.
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: accent }}>{used.toFixed(1)} <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{granted > 0 ? `of ${granted.toFixed(1)} hours used` : 'recorded'}</span></div>
                      {granted > 0 && (
                        <div style={{ height: 6, borderRadius: 99, background: "#EEEDEA", marginTop: 8, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${Math.min(100, (used / granted) * 100)}%`, background: used >= granted ? LEAVE_OUT : accent, borderRadius: 99 }} />
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>hours this benefit year</div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 22, fontWeight: 800, color: accent, marginTop: 6 }}>{avail.toFixed(1)} <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>hrs available</span></div>
                      <div style={{ height: 6, borderRadius: 99, background: "#EEEDEA", marginTop: 8, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${barPct}%`, background: barColor, borderRadius: 99, transition: "width 0.3s ease" }} />
                      </div>
                      <div style={{ fontSize: 11, color: MUTED, marginTop: 5 }}>{used.toFixed(1)} used · {avail.toFixed(1)} left · of {granted.toFixed(1)} granted</div>
                      <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{used.toFixed(1)} hrs taken this year</div>
                    </>
                  )}
                  <button onClick={() => setHistoryBucket({ slug: b.slug, display_name: b.display_name })} style={{ marginTop: 10, width: "100%", padding: "6px 0", border: `1px solid ${accent}`, borderRadius: 6, fontSize: 12, color: accent, background: "none", cursor: "pointer", fontFamily: FF }}>View History</button>
                </div>
              );
            })
          )}
        </div>

        {/* Per-bucket usage history — clean chips (date · bucket chip · status
            chip · note), same treatment as the office profile, from /usage/me. */}
        {historyBucket && (() => {
          const tag = (() => { const s = historyBucket.slug.toLowerCase(); if (s.includes("plawa") || s.includes("sick")) return "/plawa"; if (s.includes("pto")) return "/pto"; if (s.includes("unpaid")) return "/unpaid"; if (s.includes("unexcused")) return "/unexcused"; return "/" + s; })();
          const bucketAccent = balances.find((b) => b.slug === historyBucket.slug)?.accent || NEUTRAL_ACCENT;
          const bucketChipLabel = balances.find((b) => b.slug === historyBucket.slug)?.chip_label || leaveBucketLabel(historyBucket.slug);
          const rows = usage.filter((u) => String(u.notes || "").includes(tag)).sort((a, b) => String(b.date_used).localeCompare(String(a.date_used)));
          return (
            <div onClick={() => setHistoryBucket(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
              <div onClick={(e) => e.stopPropagation()} style={{ background: CARD, borderRadius: 12, padding: 24, width: 560, maxWidth: "92vw", maxHeight: "80vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: INK }}>{historyBucket.display_name} History</h3>
                  <button onClick={() => setHistoryBucket(null)} style={{ border: "none", background: "none", fontSize: 22, lineHeight: 1, cursor: "pointer", color: MUTED }}>×</button>
                </div>
                {rows.length === 0 ? (
                  <div style={{ color: MUTED, fontSize: 13 }}>No {historyBucket.display_name} history recorded.</div>
                ) : rows.map((u, i) => {
                  const p = parseLeaveNote(u.notes);
                  const tone = KIND_TONE_STYLE[p.kindTone];
                  return (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderTop: i ? `1px solid ${BORDER}` : "none" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 3 }}>{shortDate(String(u.date_used).slice(0, 10))} · {String(u.date_used).slice(0, 10)}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: bucketAccent, background: CARD, border: `1px solid ${bucketAccent}`, borderRadius: 99, padding: "1px 7px" }}>{bucketChipLabel}</span>
                          {p.kind && <span style={{ fontSize: 10.5, fontWeight: 600, color: tone.fg, background: tone.bg, borderRadius: 99, padding: "1px 7px" }}>{p.kind}</span>}
                          {p.clean && <span style={{ fontSize: 12, color: "#6B6860" }}>{p.clean}</span>}
                        </div>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: INK, whiteSpace: "nowrap" }}>{Number(u.hours).toFixed(2)} h</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Request form */}
        <div style={{ backgroundColor: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 14, marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: INK, marginBottom: 4 }}>Submit a request</div>
          <div style={{ fontSize: 11, color: MUTED, marginBottom: 10 }}>
            PTO and Unpaid Personal require 7 days' advance notice. Sick time can be requested for the same day.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <FormField label="Bucket">
              <select
                value={selectedBucket ?? ""}
                onChange={(e) => setSelectedBucket(Number(e.target.value) || null)}
                style={inputStyle}
              >
                <option value="">— pick a bucket —</option>
                {requestableBuckets.map((b) => (
                  <option key={b.leave_type_id} value={b.leave_type_id}>
                    {b.display_name} ({b.available.toFixed(2)} hrs)
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Amount">
              {multiDay ? (
                <div style={{ fontSize: 13, color: MUTED, padding: "6px 0" }}>
                  Full days (multi-day request)
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 6 }}>
                    {([
                      { v: "full_day", l: "Full day" },
                      { v: "morning", l: "Morning" },
                      { v: "afternoon", l: "Afternoon" },
                      { v: "custom", l: "Hours" },
                    ] as const).map((o) => (
                      <button
                        key={o.v}
                        type="button"
                        onClick={() => setDayUnit(o.v)}
                        style={{
                          flex: 1, fontFamily: FF, fontSize: 12, fontWeight: 700,
                          padding: "8px 6px", borderRadius: 8, cursor: "pointer",
                          border: `1px solid ${dayUnit === o.v ? BRAND : BORDER}`,
                          background: dayUnit === o.v ? BRAND : CARD,
                          color: dayUnit === o.v ? "#04241d" : INK,
                        }}
                      >
                        {o.l}
                      </button>
                    ))}
                  </div>
                  {dayUnit === "custom" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                      <input type="time" value={customStart} onChange={(e) => setCustomStart(e.target.value)} style={{ ...inputStyle, width: "auto", flex: 1 }} />
                      <span style={{ fontSize: 12, color: MUTED }}>to</span>
                      <input type="time" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={{ ...inputStyle, width: "auto", flex: 1 }} />
                      {(() => {
                        const [sh, sm] = customStart.split(":").map(Number);
                        const [eh, em] = customEnd.split(":").map(Number);
                        const hrs = (eh * 60 + em - (sh * 60 + sm)) / 60;
                        return Number.isFinite(hrs) && hrs > 0
                          ? <span style={{ fontSize: 12, fontWeight: 700, color: INK, whiteSpace: "nowrap" }}>{hrs.toFixed(1)} h</span>
                          : <span style={{ fontSize: 12, fontWeight: 700, color: DANGER, whiteSpace: "nowrap" }}>—</span>;
                      })()}
                    </div>
                  )}
                </>
              )}
            </FormField>
            <FormField label="Start date">
              <CalendarPopover value={startDate} ariaLabel="Start date" onChange={setStartDate} block />
            </FormField>
            <FormField label="End date">
              <CalendarPopover value={endDate} ariaLabel="End date" onChange={setEndDate} block />
            </FormField>
            <div style={{ gridColumn: "1 / -1" }}>
              <FormField label="Attachment (required — doctor's note / file)">
                {attachment ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK }}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachment.name}</span>
                    <button type="button" onClick={() => setAttachment(null)} style={{ fontFamily: FF, fontSize: 12, fontWeight: 600, color: DANGER, background: "none", border: "none", cursor: "pointer" }}>Remove</button>
                  </div>
                ) : (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: BRAND, cursor: "pointer" }}>
                    {uploading ? "Uploading…" : "Choose / take a photo"}
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      capture="environment"
                      style={{ display: "none" }}
                      disabled={uploading}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); }}
                    />
                  </label>
                )}
              </FormField>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <FormField label="Note (optional)">
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  style={inputStyle}
                />
              </FormField>
            </div>
          </div>
          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={submit}
              disabled={submitting || uploading || !attachment}
              style={{
                fontFamily: FF, fontSize: 13, fontWeight: 700,
                color: "#FFFFFF", backgroundColor: BRAND, border: "none",
                borderRadius: 8, padding: "8px 14px", cursor: "pointer",
                opacity: submitting || uploading || !attachment ? 0.4 : 1,
              }}
            >
              Submit request
            </button>
          </div>
        </div>

        {/* My recent requests */}
        <div style={{ fontSize: 14, fontWeight: 800, color: INK, marginBottom: 8 }}>My requests</div>
        {requests.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13 }}>No requests yet.</div>
        ) : (
          <div style={{ backgroundColor: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: MUTED, textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Dates</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Hours</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Status</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700 }}>Decision note</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                    <td style={{ padding: "8px" }}>
                      {r.start_date}
                      {r.start_date !== r.end_date ? ` → ${r.end_date}` : ""}
                    </td>
                    <td style={{ padding: "8px", fontWeight: 700 }}>
                      {Number(r.hours).toFixed(2)}
                      {r.start_time && r.end_time && (
                        <span style={{ fontWeight: 500, color: MUTED }}> ({fmtHHMM(String(r.start_time))} – {fmtHHMM(String(r.end_time))})</span>
                      )}
                    </td>
                    <td style={{ padding: "8px" }}>
                      <StatusPill s={r.status} blackoutConflict={r.blackout_conflict} />
                    </td>
                    <td style={{ padding: "8px", color: MUTED }}>{r.decision_note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

const inputStyle: React.CSSProperties = {
  fontFamily: FF, fontSize: 13, color: INK,
  border: `1px solid ${BORDER}`, borderRadius: 8,
  padding: "6px 10px", background: CARD, width: "100%",
};

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em" }}>
      {label}
      <div style={{ marginTop: 4, fontFamily: FF, fontSize: 13, fontWeight: 500, color: INK, textTransform: "none", letterSpacing: "normal" }}>
        {children}
      </div>
    </label>
  );
}

function StatusPill({ s, blackoutConflict }: { s: "pending" | "approved" | "denied" | "cancelled"; blackoutConflict: boolean }) {
  const styles: Record<typeof s, { bg: string; fg: string; label: string }> = {
    pending: { bg: "#F0EEE9", fg: "#6B6860", label: "Pending" },
    approved: { bg: "#D6F4E9", fg: "#0A5C3E", label: "Approved" },
    denied: { bg: "#FCE7E7", fg: "#991B1B", label: blackoutConflict ? "Denied — blackout" : "Denied" },
    cancelled: { bg: "#F0EEE9", fg: "#6B6860", label: "Cancelled" },
  };
  const v = styles[s];
  return (
    <span
      style={{
        fontSize: 10, fontWeight: 800, letterSpacing: "0.05em",
        backgroundColor: v.bg, color: v.fg,
        padding: "2px 8px", borderRadius: 10, textTransform: "uppercase",
      }}
    >
      {v.label}
    </span>
  );
}
