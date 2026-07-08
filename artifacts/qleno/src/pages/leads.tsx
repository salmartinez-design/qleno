import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { getAuthHeaders } from "@/lib/auth";
import { formatAddress } from "@/lib/format-address";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useAddressAutocomplete } from "@/hooks/use-address-autocomplete";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  UserPlus, Search, X,
  Phone, Mail, MapPin, Loader2,
  MessageSquare, Briefcase, Activity, Eye, ChevronDown,
  Send, AlertCircle, CheckCircle2, TrendingUp, Zap,
  PauseCircle, StopCircle, SkipForward,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "Plus Jakarta Sans, system-ui, sans-serif";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Lead {
  id: number;
  company_id: number;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  source: string;
  lead_source: string | null;
  status: string;
  scope: string | null;
  sqft: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  notes: string | null;
  // [quote-details-carry 2026-07-07] Widget quote snapshot (bedrooms/bathrooms/
  // sqft/frequency/add_ons/referral_source/step_reached).
  details?: Record<string, unknown> | null;
  quote_amount: string | null;
  assigned_to: number | null;
  assignee_first_name: string | null;
  assignee_last_name: string | null;
  referral_partner_id: number | null;
  referral_partner_name: string | null;
  booked_at: string | null;
  contacted_at: string | null;
  quoted_at: string | null;
  closed_reason: string | null;
  job_id: number | null;
  created_at: string;
  updated_at: string;
}

interface ActivityEntry {
  id: number;
  action_type: string;
  note: string | null;
  performer_first_name: string | null;
  performer_last_name: string | null;
  created_at: string;
}

interface OwnerOpt { id: number; first_name: string; last_name: string | null; }
interface PartnerOpt { id: number; name: string; }

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  needs_contacted: { label: "Needs Contact",   color: "#DC2626", bg: "#FEF2F2" },
  contacted:       { label: "Contacted",        color: "#D97706", bg: "#FFFBEB" },
  quoted:          { label: "Quoted",           color: "#2563EB", bg: "#EFF6FF" },
  follow_up:       { label: "Follow Up",        color: "#EA580C", bg: "#FFF7ED" },
  booked:          { label: "Booked",           color: "#059669", bg: "#ECFDF5" },
  no_response:     { label: "No Response",      color: "#6B7280", bg: "#F9FAFB" },
  not_interested:  { label: "Not Interested",   color: "#6B7280", bg: "#F3F4F6" },
};
const ALL_STATUSES = Object.keys(STATUS_CONFIG);

const SOURCE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  web_quote:            { label: "Web",     color: "#7C3AED", bg: "#EDE9FE" },
  phone_in:             { label: "Phone",   color: "#059669", bg: "#D1FAE5" },
  manual:               { label: "Office",  color: "#374151", bg: "#F3F4F6" },
  google_local_services:{ label: "Google",  color: "#1D4ED8", bg: "#DBEAFE" },
  google_search:        { label: "Google",  color: "#3B82F6", bg: "#EFF6FF" },
  facebook:             { label: "Facebook",color: "#4338CA", bg: "#EEF2FF" },
  referral:             { label: "Referral",color: "#059669", bg: "#ECFDF5" },
  realtor:              { label: "Realtor", color: "#0D9488", bg: "#F0FDFA" },
  online_booking:       { label: "Online",  color: "#10B981", bg: "#F0FDF4" },
  very_dirty_callback:  { label: "V. Dirty",color: "#EA580C", bg: "#FFF7ED" },
  booking_widget:       { label: "Widget",  color: "#0369A1", bg: "#EFF6FF" },
  very_dirty:           { label: "V. Dirty",color: "#DC2626", bg: "#FEF2F2" },
  contact_form:         { label: "Form",    color: "#7C3AED", bg: "#F5F3FF" },
  quote_request:        { label: "Quote",   color: "#D97706", bg: "#FFFBEB" },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(str: string | null) {
  if (!str) return "—";
  // [date-tz-fix] Anchor date-only "YYYY-MM-DD" to local noon so it does not
  // render one day early in US Central. Full timestamps untouched.
  const s = /^\d{4}-\d{2}-\d{2}$/.test(str) ? str + "T12:00:00" : str;
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(str: string | null) {
  if (!str) return "—";
  return new Date(str).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function actionLabel(type: string) {
  return ({
    status_change: "Status changed", note_added: "Note added", call_logged: "Call logged",
    email_sent: "Email sent", sms_sent: "SMS sent", quote_sent: "Quote sent", converted: "Converted",
    created: "Lead created", stage_booked: "Status changed to Booked",
    stage_needs_contacted: "Status changed to Needs Contact",
    stage_contacted: "Status changed to Contacted", stage_quoted: "Status changed to Quoted",
    drip_enrolled: "Enrolled in drip", drip_stopped: "Drip stopped", drip_paused: "Drip paused",
    drip_touch_sent: "Drip message sent", assigned: "Assignee updated",
  } as Record<string, string>)[type] || type.replace(/_/g, " ");
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#6B6860", marginBottom: 5, fontFamily: FF };
const selectStyle: React.CSSProperties = { width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 10px", fontSize: 14, fontFamily: FF, background: "#fff", outline: "none" };

function leadSourceTag(lead: Lead) {
  const src = lead.lead_source || (lead.source === "booking_widget" || lead.source === "online_booking" ? "web_quote" : null) || lead.source || "manual";
  const cfg = SOURCE_CONFIG[src] || SOURCE_CONFIG["manual"];
  return { src, cfg };
}

function accentColor(lead: Lead) {
  if (lead.status === "needs_contacted") return "#DC2626";
  if (lead.status === "booked") return "#A7F3D0";
  return "#00C9A0";
}

// ── KPI Strip ─────────────────────────────────────────────────────────────────

function KpiStrip({ counts, filter, onFilter }: {
  counts: Record<string, number>;
  filter: string;
  onFilter: (f: string) => void;
}) {
  const tiles = [
    { key: "all",             label: "All leads",     n: counts.all || 0,             urgent: false },
    { key: "needs_contacted", label: "Needs contact", n: counts.needs_contacted || 0, urgent: true },
    { key: "quoted",          label: "Quoted",        n: counts.quoted || 0,          urgent: false },
    { key: "booked",          label: "Booked",        n: counts.booked || 0,          urgent: false },
  ];
  return (
    <div style={{ background: "#fff", borderBottom: "1px solid #E8E5E0", padding: "0 20px", display: "flex", gap: 0, flexShrink: 0 }}>
      {tiles.map((t, i) => (
        <div key={t.key} style={{ display: "flex", alignItems: "center" }}>
          {i > 0 && <div style={{ width: 1, background: "#E8E5E0", margin: "10px 0", alignSelf: "stretch" }} />}
          <button
            onClick={() => onFilter(t.key)}
            style={{ padding: "12px 24px 10px", cursor: "pointer", background: "none", border: "none",
              borderBottom: `2px solid ${filter === t.key ? (t.urgent ? "#DC2626" : "#1A1917") : "transparent"}`,
              fontFamily: FF, textAlign: "left", position: "relative" }}>
            {t.urgent && t.n > 0 && (
              <div style={{ width: 6, height: 6, background: "#DC2626", borderRadius: "50%", position: "absolute", top: 12, right: 14 }} />
            )}
            <div style={{ fontSize: 22, fontWeight: 700, color: filter === t.key ? (t.urgent ? "#DC2626" : "#1A1917") : "#C4C0B8", lineHeight: 1, letterSpacing: -0.5 }}>{t.n}</div>
            <div style={{ fontSize: 10, fontWeight: 600, color: filter === t.key ? "#6B6860" : "#C4C0B8", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 2 }}>{t.label}</div>
          </button>
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", fontSize: 11, color: "#C4C0B8", paddingRight: 4 }}>
        {counts.drip_active ? `${counts.drip_active} in active drip` : ""}
      </div>
    </div>
  );
}

// ── Lead Row ──────────────────────────────────────────────────────────────────

function LeadRow({ lead, selected, onClick, checked, onCheck }: {
  lead: Lead; selected: boolean; onClick: () => void;
  checked: boolean; onCheck: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const { cfg } = leadSourceTag(lead);
  const done = lead.status === "booked" ? 100 : lead.status === "quoted" ? 57 : lead.status === "contacted" ? 29 : lead.status === "needs_contacted" ? 14 : 0;
  const accent = accentColor(lead);

  return (
    <div style={{
      padding: "11px 14px 11px 17px", borderBottom: "0.5px solid #F2EFE9", cursor: "pointer",
      background: checked ? "#FFF8F8" : selected ? "#F5FEFA" : "transparent", display: "flex", alignItems: "flex-start",
      position: "relative", transition: "background .1s",
    }}>
      <div style={{ width: 3, borderRadius: 2, background: accent, position: "absolute", left: 0, top: 10, bottom: 10 }} />
      <input type="checkbox" checked={checked} onChange={onCheck}
        onClick={e => e.stopPropagation()}
        style={{ marginRight: 8, marginTop: 2, flexShrink: 0, cursor: "pointer", accentColor: "#DC2626" }} />
      <div style={{ flex: 1, minWidth: 0 }} onClick={onClick}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>
            {[lead.first_name, lead.last_name].filter(Boolean).join(" ")}
          </span>
          <span style={{ fontSize: 10, color: "#9E9B94", fontFamily: FF, flexShrink: 0 }}>{lead.scope || ""}</span>
        </div>
        <div style={{ fontSize: 10, color: "#9E9B94", fontFamily: FF, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 4 }}>
          {lead.address || lead.city || "No address"}
        </div>
        <div style={{ height: 2, background: "#EEEBE6", borderRadius: 1, overflow: "hidden", marginBottom: 3 }}>
          <div style={{ height: "100%", width: `${done}%`, background: accent, borderRadius: 1 }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{
            fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4, fontFamily: FF,
            background: (STATUS_CONFIG[lead.status] || STATUS_CONFIG["needs_contacted"]).bg,
            color: (STATUS_CONFIG[lead.status] || STATUS_CONFIG["needs_contacted"]).color,
          }}>
            {(STATUS_CONFIG[lead.status] || STATUS_CONFIG["needs_contacted"]).label}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {(() => { const amt = Number(lead.quote_amount || (lead as any).linked_quote_price || 0); return amt > 0 ? (
              <span style={{ fontSize: 11, fontWeight: 800, color: "#1A1917", fontFamily: FF }}>${amt.toFixed(0)}</span>
            ) : null; })()}
            <span style={{ fontSize: 9, color: "#C4C0B8", fontFamily: FF }}>
              {cfg.label} &middot; {fmtDate(lead.created_at)}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Enroll Drip Panel ─────────────────────────────────────────────────────────

function EnrollDripPanel({ leadId, onEnrolled }: { leadId: number; onEnrolled: () => void }) {
  const { toast } = useToast();
  const [enrolling, setEnrolling] = useState<string | null>(null);

  async function enroll(sequenceType: string) {
    setEnrolling(sequenceType);
    try {
      const r = await fetch(`${API}/api/leads/${leadId}/drip/enroll`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ sequence_type: sequenceType }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Failed");
      toast({ title: "Drip started" });
      onEnrolled();
    } catch (e: any) {
      toast({ title: e.message || "Could not start drip", variant: "destructive" });
    } finally { setEnrolling(null); }
  }

  return (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "20px 18px" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 4 }}>No drip running</div>
        <div style={{ fontSize: 11, color: "#6B6860", fontFamily: FF, marginBottom: 16 }}>
          Start a sequence manually or enable auto-enroll in Sequences settings.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={() => enroll("lead_drip_phone")} disabled={!!enrolling}
            style={{ padding: "12px 14px", borderRadius: 8, border: "1px solid #E8E5E0", background: "#F7F6F3", cursor: "pointer", textAlign: "left", fontFamily: FF }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", marginBottom: 2 }}>
              {enrolling === "lead_drip_phone" ? <Loader2 size={12} className="animate-spin" /> : "Phone-In Drip"}
            </div>
            <div style={{ fontSize: 10, color: "#6B6860" }}>6-touch SMS + email — for leads who called in</div>
          </button>
          <button onClick={() => enroll("lead_drip_web")} disabled={!!enrolling}
            style={{ padding: "12px 14px", borderRadius: 8, border: "1px solid #E8E5E0", background: "#F7F6F3", cursor: "pointer", textAlign: "left", fontFamily: FF }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", marginBottom: 2 }}>
              {enrolling === "lead_drip_web" ? <Loader2 size={12} className="animate-spin" /> : "Web Quote Drip"}
            </div>
            <div style={{ fontSize: 10, color: "#6B6860" }}>7-touch SMS + email — for leads from the booking widget</div>
          </button>
        </div>
        <div style={{ fontSize: 10, color: "#C4C0B8", fontFamily: FF, marginTop: 12 }}>
          Drip will only send if the sequence is active in Sequences settings
        </div>
      </div>
    </div>
  );
}

// ── Drip Tab ──────────────────────────────────────────────────────────────────

function DripTab({ lead, onRefresh }: { lead: Lead; onRefresh: () => void }) {
  const { toast } = useToast();
  const [drip, setDrip] = useState<{ enrollment: any; steps: any[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}/drip`, { headers: getAuthHeaders() });
      if (r.ok) setDrip(await r.json());
    } finally { setLoading(false); }
  }, [lead.id]);

  useEffect(() => { load(); }, [load]);

  async function action(path: string, method = "POST", body?: any) {
    setBusy(path);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}/drip/${path}`, {
        method, headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Failed");
      toast({ title: path === "send-now" ? "Touch sent" : path === "skip" ? "Step skipped" : path === "pause" ? "Drip paused/resumed" : "Drip stopped" });
      load();
    } catch (e: any) {
      toast({ title: e.message || "Error", variant: "destructive" });
    } finally { setBusy(null); }
  }

  if (loading) return <div style={{ padding: 20, color: "#9E9B94", fontSize: 12, fontFamily: FF }}>Loading drip status…</div>;

  const enr = drip?.enrollment;
  const steps = drip?.steps || [];
  const nextStep = steps.find((s: any) => !s.log_id);
  const doneN = steps.filter((s: any) => !!s.log_id).length;
  const isPaused = !!enr?.paused_at;

  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
      {!enr ? (
        <EnrollDripPanel leadId={lead.id} onEnrolled={load} />
      ) : (
        <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>{enr.sequence_name}</div>
              <div style={{ fontSize: 10, color: "#9E9B94", fontFamily: FF }}>{doneN} of {steps.length} sent{isPaused ? " · Paused" : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 5 }}>
              <button onClick={() => action("pause", "PATCH")} disabled={!!busy}
                style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 5, border: "0.5px solid #E5E2DC", background: "#fff", color: "#6B6860", cursor: "pointer", fontFamily: FF }}>
                {busy === "pause" ? <Loader2 size={10} className="animate-spin" /> : isPaused ? "Resume" : "Pause"}
              </button>
              <button onClick={() => { if (confirm("Stop this drip?")) action("stop", "PATCH", { reason: "office_stopped" }); }} disabled={!!busy}
                style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 5, border: "0.5px solid #FECACA", background: "#fff", color: "#DC2626", cursor: "pointer", fontFamily: FF }}>
                Stop
              </button>
            </div>
          </div>

          {/* Step dots */}
          <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
            {steps.map((s: any) => {
              const done = !!s.log_id;
              const isNext = !done && s === nextStep;
              return (
                <div key={s.step_number} style={{
                  flex: 1, height: 20, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 8, fontWeight: 800, fontFamily: FF,
                  background: done ? "#D1FAE5" : isNext ? "#00C9A0" : "#F2EFE9",
                  color: done ? "#065F46" : isNext ? "#0A0E1A" : "#9E9B94",
                }}>
                  {done ? "✓" : s.step_number}
                </div>
              );
            })}
          </div>

          {/* Next touch box — light mint */}
          {nextStep && !isPaused && (
            <div style={{ background: "#F0FDF9", border: "1px solid #A7F3D0", borderRadius: 8, padding: "12px 14px", marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: "#059669", fontFamily: FF }}>Next touch</span>
                <span style={{ fontSize: 9, color: "#6B6860", fontFamily: FF }}>{enr.next_fire_at ? fmtDateTime(enr.next_fire_at) : "Scheduled"}</span>
              </div>
              <span style={{
                fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 3, marginBottom: 6, display: "inline-block", fontFamily: FF,
                background: nextStep.channel === "sms" ? "#EDE9FE" : "#DBEAFE",
                color: nextStep.channel === "sms" ? "#5B21B6" : "#1E40AF",
              }}>
                {nextStep.channel.toUpperCase()}
              </span>
              <div style={{ fontSize: 11, color: "#1A1917", lineHeight: 1.5, marginBottom: 10, marginTop: 4, fontFamily: FF }}>
                {nextStep.message_template?.slice(0, 160)}{(nextStep.message_template?.length || 0) > 160 ? "…" : ""}
              </div>
              <div style={{ display: "flex", gap: 5 }}>
                <button onClick={() => action("send-now")} disabled={!!busy}
                  style={{ fontSize: 10, fontWeight: 800, padding: "5px 10px", borderRadius: 6, border: "none", background: "#00C9A0", color: "#0A0E1A", cursor: "pointer", fontFamily: FF }}>
                  {busy === "send-now" ? <Loader2 size={10} className="animate-spin" /> : "Send now"}
                </button>
                <button onClick={() => action("skip")} disabled={!!busy}
                  style={{ fontSize: 10, fontWeight: 700, padding: "5px 10px", borderRadius: 6, border: "0.5px solid #E5E2DC", background: "#F7F6F3", color: "#6B6860", cursor: "pointer", fontFamily: FF }}>
                  Skip
                </button>
              </div>
            </div>
          )}

          {isPaused && (
            <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#92400E", fontFamily: FF }}>
              Drip paused — touches won't fire until resumed.
            </div>
          )}

          <button onClick={() => setExpanded(e => !e)}
            style={{ width: "100%", textAlign: "center", fontSize: 10, color: "#9E9B94", background: "none", border: "none", cursor: "pointer", paddingTop: 8, fontFamily: FF }}>
            {expanded ? "▲ Hide timeline" : "▾ Full timeline"}
          </button>

          {expanded && (
            <div style={{ marginTop: 4 }}>
              {steps.map((s: any) => {
                const done = !!s.log_id;
                const isNext = !done && s === nextStep;
                return (
                  <div key={s.step_number} style={{ display: "flex", gap: 8, padding: "6px 0", borderTop: "0.5px solid #F2EFE9", alignItems: "flex-start" }}>
                    <div style={{
                      width: 14, height: 14, borderRadius: "50%", flexShrink: 0, marginTop: 1,
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, fontWeight: 800, fontFamily: FF,
                      background: done ? "#D1FAE5" : isNext ? "#00C9A0" : "#F2EFE9",
                      color: done ? "#065F46" : isNext ? "#0A0E1A" : "#9E9B94",
                    }}>
                      {done ? "✓" : s.step_number}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                        <span style={{
                          fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 2, fontFamily: FF,
                          background: s.channel === "sms" ? "#EDE9FE" : "#DBEAFE",
                          color: s.channel === "sms" ? "#5B21B6" : "#1E40AF",
                        }}>{s.channel.toUpperCase()}</span>
                        <span style={{ fontSize: 9, color: "#9E9B94", fontFamily: FF, marginLeft: "auto" }}>
                          {done ? fmtDateTime(s.sent_at) : isNext ? "Next" : `+${s.delay_hours}h`}
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: "#6B6860", lineHeight: 1.4, fontFamily: FF }}>
                        {s.message_template?.slice(0, 120)}{(s.message_template?.length || 0) > 120 ? "…" : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ fontSize: 9, color: "#9E9B94", textAlign: "center", paddingTop: 6, fontFamily: FF }}>
            STOP reply unsubscribes instantly · CAN-SPAM compliant
          </div>
        </div>
      )}
    </div>
  );
}

// ── Messages Tab ──────────────────────────────────────────────────────────────

function MessagesTab({ lead }: { lead: Lead }) {
  const { toast } = useToast();
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [msgText, setMsgText] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}/messages`, { headers: getAuthHeaders() });
      if (r.ok) setMessages(await r.json());
    } finally { setLoading(false); }
  }, [lead.id]);

  useEffect(() => { load(); }, [load]);

  async function sendMsg(channel: "sms" | "email") {
    if (!msgText.trim()) return;
    setSending(true);
    try {
      const path = channel === "sms" ? "communications/sms" : "communications/email";
      const r = await fetch(`${API}/api/leads/${lead.id}/${path}`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: msgText, body: msgText }),
      });
      if (!r.ok) throw new Error();
      setMsgText("");
      load();
    } catch {
      toast({ title: "Failed to send", variant: "destructive" });
    } finally { setSending(false); }
  }

  if (loading) return <div style={{ padding: 20, color: "#9E9B94", fontSize: 12, fontFamily: FF }}>Loading…</div>;

  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
      <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "14px 16px" }}>
        {!messages.length && (
          <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginBottom: 10 }}>No messages yet.</div>
        )}
        {messages.map((m: any) => (
          <div key={m.id} style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: m.direction === "outbound" ? "flex-end" : "flex-start" }}>
              <div style={{
                fontSize: 11, lineHeight: 1.45, padding: "7px 10px", display: "inline-block",
                maxWidth: "78%", fontFamily: FF,
                background: m.direction === "outbound" ? "#0A0E1A" : "#F2EFE9",
                color: m.direction === "outbound" ? "#fff" : "#1A1917",
                borderRadius: m.direction === "outbound" ? "10px 3px 10px 10px" : "3px 10px 10px 10px",
              }}>
                {m.body}
              </div>
            </div>
            <div style={{ fontSize: 9, color: "#9E9B94", textAlign: m.direction === "outbound" ? "right" : "left", marginBottom: 6, fontFamily: FF }}>
              {m.step_number ? `Drip touch ${m.step_number} - ${(m.channel || "sms").toUpperCase()} - ` : ""}{fmtDateTime(m.created_at)}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input
            value={msgText} onChange={e => setMsgText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg("sms"); } }}
            placeholder="Message…"
            style={{ flex: 1, fontSize: 11, padding: "7px 10px", border: "0.5px solid #E5E2DC", borderRadius: 7, outline: "none", fontFamily: FF, color: "#1A1917" }} />
          <button onClick={() => sendMsg("sms")} disabled={sending || !msgText.trim()}
            style={{ background: "#0A0E1A", color: "#fff", border: "none", borderRadius: 7, padding: "7px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
            {sending ? <Loader2 size={11} className="animate-spin" /> : "SMS"}
          </button>
          <button onClick={() => sendMsg("email")} disabled={sending || !msgText.trim()}
            style={{ background: "#fff", color: "#6B6860", border: "0.5px solid #E5E2DC", borderRadius: 7, padding: "7px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
            Email
          </button>
        </div>
        <div style={{ fontSize: 9, color: "#9E9B94", textAlign: "center", marginTop: 5, fontFamily: FF }}>
          First SMS includes STOP opt-out · Qleno tracks consent automatically
        </div>
      </div>
    </div>
  );
}

// ── Activity Tab ──────────────────────────────────────────────────────────────

function ActivityTab({ lead }: { lead: Lead }) {
  const { toast } = useToast();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}/activity`, { headers: getAuthHeaders() });
      if (r.ok) setActivity(await r.json());
    } finally { setLoading(false); }
  }, [lead.id]);

  useEffect(() => { load(); }, [load]);

  async function saveNote(actionType = "note_added") {
    if (!noteText.trim()) return;
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}/activity`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action_type: actionType, note: noteText }),
      });
      if (!r.ok) throw new Error();
      setNoteText("");
      load();
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally { setSaving(false); }
  }

  if (loading) return <div style={{ padding: 20, color: "#9E9B94", fontSize: 12, fontFamily: FF }}>Loading…</div>;

  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
      <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "14px 16px" }}>
        <textarea value={noteText} onChange={e => setNoteText(e.target.value)}
          placeholder="Add a note or log a call…"
          style={{ width: "100%", border: "0.5px solid #E5E2DC", borderRadius: 7, padding: "8px 10px", fontSize: 11, fontFamily: FF, resize: "vertical", minHeight: 64, outline: "none", marginBottom: 8 }} />
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => saveNote("note_added")} disabled={saving || !noteText.trim()}
            style={{ fontSize: 10, fontWeight: 700, padding: "5px 12px", borderRadius: 6, border: "none", background: "#1A1917", color: "#fff", cursor: "pointer", fontFamily: FF }}>
            {saving ? <Loader2 size={10} className="animate-spin" /> : "Add Note"}
          </button>
          <button onClick={() => saveNote("call_logged")} disabled={saving || !noteText.trim()}
            style={{ fontSize: 10, fontWeight: 600, padding: "5px 12px", borderRadius: 6, border: "0.5px solid #E5E2DC", background: "#fff", color: "#6B6860", cursor: "pointer", fontFamily: FF }}>
            Log Call
          </button>
        </div>
      </div>
      <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "14px 16px" }}>
        {!activity.length && <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>No activity yet.</div>}
        {activity.map(a => (
          <div key={a.id} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: "0.5px solid #F2EFE9" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#00C9A0", flexShrink: 0, marginTop: 4 }} />
            <div>
              <div style={{ fontSize: 11, color: "#1A1917", fontFamily: FF }}>{actionLabel(a.action_type)}{a.note ? ` — ${a.note}` : ""}</div>
              <div style={{ fontSize: 9, color: "#9E9B94", fontFamily: FF }}>
                {a.performer_first_name ? `${a.performer_first_name} ${a.performer_last_name || ""}`.trim() : "System"} · {fmtDateTime(a.created_at)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Booking Confirmation helpers (for Jobs tab) ────────────────────────────────

function confView(c: any): { label: string; sub: string | null; color: string; Icon: any } {
  if (c === undefined) return { label: "Checking…", sub: null, color: "#6B6860", Icon: Loader2 };
  if (!c?.found) return { label: "No confirmation sent", sub: "Comms may have been off at booking", color: "#6B6860", Icon: AlertCircle };
  const ev = (c.resend?.last_event || "").toLowerCase();
  if (c.status === "sent") {
    if (ev === "opened" || ev === "clicked") return { label: "Opened by client", sub: c.recipient, color: "#059669", Icon: CheckCircle2 };
    if (ev === "delivered") return { label: "Delivered", sub: c.recipient, color: "#059669", Icon: CheckCircle2 };
    if (ev === "bounced") return { label: "Bounced", sub: c.recipient, color: "#DC2626", Icon: AlertCircle };
    return { label: "Sent — delivery pending", sub: c.recipient, color: "#2563EB", Icon: Mail };
  }
  if (c.status === "failed") return { label: "Send failed", sub: c.reason, color: "#DC2626", Icon: AlertCircle };
  const reasonMap: Record<string, string> = { company_comms_disabled: "Company messaging is off", "COMMS_ENABLED=false": "Globally disabled", email_opt_out: "Client opted out" };
  return { label: "Not sent", sub: reasonMap[c.reason] || c.reason || null, color: "#B45309", Icon: AlertCircle };
}

// ── Jobs Tab ──────────────────────────────────────────────────────────────────

function JobsTab({ lead }: { lead: Lead }) {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [confStatus, setConfStatus] = useState<Record<number, any>>({});
  const [confBusy, setConfBusy] = useState<Record<number, "resend" | "pdf" | null>>({});

  const loadConfStatus = useCallback(async (jobId: number) => {
    try {
      const r = await fetch(`${API}/api/jobs/${jobId}/confirmation-status`, { headers: getAuthHeaders() });
      if (r.ok) { const d = await r.json(); setConfStatus(p => ({ ...p, [jobId]: d })); }
    } catch { /* leave unknown */ }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`${API}/api/leads/${lead.id}/jobs`, { headers: getAuthHeaders() });
        if (r.ok) { const list = await r.json(); setJobs(list); list.forEach((j: any) => loadConfStatus(j.id)); }
      } finally { setLoading(false); }
    })();
  }, [lead.id, loadConfStatus]);

  async function handleViewPdf(jobId: number) {
    setConfBusy(p => ({ ...p, [jobId]: "pdf" }));
    try {
      const r = await fetch(`${API}/api/jobs/${jobId}/confirmation.pdf`, { headers: getAuthHeaders() });
      if (!r.ok) throw new Error();
      window.open(URL.createObjectURL(await r.blob()), "_blank");
    } catch { toast({ title: "Could not open PDF", variant: "destructive" }); }
    finally { setConfBusy(p => ({ ...p, [jobId]: null })); }
  }

  async function handleResend(jobId: number) {
    setConfBusy(p => ({ ...p, [jobId]: "resend" }));
    try {
      const r = await fetch(`${API}/api/jobs/${jobId}/resend-confirmation`, { method: "POST", headers: getAuthHeaders() });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        toast({ title: "Not sent", description: data.error === "no_client_email" ? "no email on file" : data.reason || "send failed", variant: "destructive" });
      } else if (data.status === "sent") {
        toast({ title: "Confirmation sent", description: data.recipient });
      } else {
        toast({ title: "Not sent", description: data.reason || data.status, variant: "destructive" });
      }
      loadConfStatus(jobId);
    } catch { toast({ title: "Could not resend", variant: "destructive" }); }
    finally { setConfBusy(p => ({ ...p, [jobId]: null })); }
  }

  if (loading) return <div style={{ padding: 20, color: "#9E9B94", fontSize: 12, fontFamily: FF }}>Loading…</div>;

  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
      {!jobs.length && <div style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF }}>No jobs linked to this lead yet.</div>}
      {jobs.map((j: any) => {
        const cv = confView(confStatus[j.id]);
        const b = confBusy[j.id];
        const CvIcon = cv.Icon;
        return (
          <div key={j.id} style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>
                  {j.service_type || "Cleaning"} — {fmtDate(j.scheduled_date)}
                </div>
                <div style={{ fontSize: 11, color: "#6B6860", fontFamily: FF, marginTop: 2 }}>
                  {j.status} {j.base_fee ? `- $${parseFloat(j.base_fee).toFixed(0)}` : ""}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <CvIcon size={12} color={cv.color} />
              <span style={{ fontSize: 11, color: cv.color, fontFamily: FF }}>{cv.label}</span>
              {cv.sub && <span style={{ fontSize: 10, color: "#9E9B94", fontFamily: FF }}>· {cv.sub}</span>}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => handleResend(j.id)} disabled={!!b}
                style={{ fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 5, border: "none", background: "#1A1917", color: "#fff", cursor: "pointer", fontFamily: FF }}>
                {b === "resend" ? <Loader2 size={10} className="animate-spin" /> : "Resend Email"}
              </button>
              <button onClick={() => handleViewPdf(j.id)} disabled={!!b}
                style={{ fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 5, border: "0.5px solid #E5E2DC", background: "#fff", color: "#6B6860", cursor: "pointer", fontFamily: FF }}>
                {b === "pdf" ? <Loader2 size={10} className="animate-spin" /> : "View PDF"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Lead Detail Panel ─────────────────────────────────────────────────────────

function LeadDetailPanel({ lead, users, partners, onUpdated, onClose }: {
  lead: Lead; users: OwnerOpt[]; partners: PartnerOpt[];
  onUpdated: () => void; onClose: () => void;
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState("quote");
  const [editStatus, setEditStatus] = useState(lead.status);
  const [statusChanging, setStatusChanging] = useState(false);
  const [savingField, setSavingField] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [, navigate] = useLocation();
  const [sendingQuote, setSendingQuote] = useState(false);

  // Sync status if lead prop changes
  useEffect(() => { setEditStatus(lead.status); }, [lead.id, lead.status]);

  // Mark the lead's linked quote as Sent — this is the trigger that starts the
  // quote follow-up drip (enrollForQuoteSent). Lives on the record so the
  // workflow is preserved now that the standalone Quotes list isn't a tab.
  async function markQuoteSent() {
    const qid = (lead as any).linked_quote_id;
    if (!qid) return;
    setSendingQuote(true);
    try {
      const r = await fetch(`${API}/api/quotes/${qid}/send`, { method: "POST", headers: getAuthHeaders() });
      if (!r.ok) throw new Error();
      toast({ title: "Quote marked as sent — follow-up started" });
      onUpdated();
    } catch { toast({ title: "Failed to mark sent", variant: "destructive" }); }
    finally { setSendingQuote(false); }
  }

  const { cfg } = leadSourceTag(lead);
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
  const cfgSt = STATUS_CONFIG[editStatus] || STATUS_CONFIG["needs_contacted"];

  async function handleStatusChange(newStatus: string) {
    if (newStatus === editStatus) return;
    setStatusChanging(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}`, {
        method: "PATCH", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!r.ok) throw new Error();
      setEditStatus(newStatus);
      onUpdated();
    } catch { toast({ title: "Failed to update status", variant: "destructive" }); }
    finally { setStatusChanging(false); }
  }

  async function patchField(body: Record<string, any>, label: string) {
    setSavingField(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}`, {
        method: "PATCH", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error();
      toast({ title: `${label} updated` });
      onUpdated();
    } catch { toast({ title: `Failed to update ${label.toLowerCase()}`, variant: "destructive" }); }
    finally { setSavingField(false); }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}`, { method: "DELETE", headers: getAuthHeaders() });
      if (!r.ok) throw new Error();
      toast({ title: "Lead deleted" });
      onUpdated();
      onClose();
    } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
    finally { setDeleting(false); }
  }

  const TABS = [
    { key: "quote",    label: "Quote",    Icon: Briefcase },
    { key: "drip",     label: "Drip",     Icon: Zap },
    { key: "messages", label: "Messages", Icon: MessageSquare },
    { key: "activity", label: "Activity", Icon: Activity },
    { key: "jobs",     label: "Jobs",     Icon: Briefcase },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "#F7F6F3" }}>
      {/* Header */}
      <div style={{ background: "#fff", borderBottom: "1px solid #E8E5E0", padding: "16px 20px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#1A1917", letterSpacing: -0.4, lineHeight: 1.1, fontFamily: FF }}>{name}</div>
            <div style={{ fontSize: 10, color: "#9E9B94", fontFamily: FF, marginTop: 2 }}>
              Lead · {fmtDate(lead.created_at)}{lead.assignee_first_name ? ` · ${lead.assignee_first_name} ${lead.assignee_last_name || ""}`.trim() : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 0.4, fontFamily: FF, background: cfg.bg, color: cfg.color }}>
              {cfg.label}
            </span>
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
              <X size={16} color="#6B6860" />
            </button>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
          {lead.phone && (
            <a href={`tel:${lead.phone}`} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#6B6860", textDecoration: "none", fontFamily: FF }}>
              <Phone size={11} /> {lead.phone}
            </a>
          )}
          {lead.email && (
            <a href={`mailto:${lead.email}`} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#6B6860", textDecoration: "none", fontFamily: FF }}>
              <Mail size={11} /> {lead.email}
            </a>
          )}
          {lead.address && (
            <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#6B6860", fontFamily: FF }}>
              <MapPin size={11} /> {formatAddress(lead.address, lead.city, lead.state, lead.zip)}
            </span>
          )}
          {!lead.assigned_to && (
            <span style={{ fontSize: 11, color: "#DC2626", fontFamily: FF }}>Unassigned</span>
          )}
        </div>
        {/* Status + owner row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ position: "relative", flex: "0 0 auto" }}>
            <select value={editStatus} onChange={e => handleStatusChange(e.target.value)} disabled={statusChanging}
              style={{ appearance: "none", background: cfgSt.bg, color: cfgSt.color,
                border: `1px solid ${cfgSt.color}30`, borderRadius: 999, padding: "4px 26px 4px 10px",
                fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
              {ALL_STATUSES.map(s => <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>)}
            </select>
            <ChevronDown size={11} style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", color: cfgSt.color, pointerEvents: "none" }} />
          </div>
          {statusChanging && <Loader2 size={13} className="animate-spin" color="#6B6860" />}
          <div style={{ position: "relative", flex: "0 0 auto" }}>
            <select
              defaultValue={String(lead.assigned_to || "")}
              onChange={e => patchField({ assigned_to: e.target.value || null }, "Owner")}
              style={{ appearance: "none", background: "#F7F6F3", border: "0.5px solid #E5E2DC", borderRadius: 6, padding: "4px 24px 4px 8px", fontSize: 11, cursor: "pointer", fontFamily: FF, color: "#6B6860" }}>
              <option value="">Unassigned</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.first_name} {u.last_name || ""}</option>
              ))}
            </select>
            <ChevronDown size={10} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", color: "#9E9B94", pointerEvents: "none" }} />
          </div>
          <div style={{ marginLeft: "auto" }}>
            {showDeleteConfirm ? (
              <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                <span style={{ fontSize: 10, color: "#DC2626", fontFamily: FF }}>Delete?</span>
                <button onClick={handleDelete} disabled={deleting}
                  style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4, border: "none", background: "#DC2626", color: "#fff", cursor: "pointer", fontFamily: FF }}>
                  {deleting ? <Loader2 size={10} className="animate-spin" /> : "Yes"}
                </button>
                <button onClick={() => setShowDeleteConfirm(false)}
                  style={{ fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 4, border: "0.5px solid #E5E2DC", background: "#fff", color: "#6B6860", cursor: "pointer", fontFamily: FF }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button onClick={() => setShowDeleteConfirm(true)}
                style={{ fontSize: 10, color: "#DC2626", background: "none", border: "none", cursor: "pointer", fontFamily: FF }}>
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid #E8E5E0", background: "#fff", flexShrink: 0 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: "9px 18px", fontSize: 11, fontWeight: 700, fontFamily: FF,
              color: tab === t.key ? "#1A1917" : "#9E9B94", cursor: "pointer",
              borderBottom: `2px solid ${tab === t.key ? "#00C9A0" : "transparent"}`,
              background: "none", border: "none", borderBottom: `2px solid ${tab === t.key ? "#00C9A0" : "transparent"}`,
              letterSpacing: 0.1 }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {tab === "quote" && (() => {
          const qid = (lead as any).linked_quote_id;
          const qprice = Number((lead as any).quote_amount || (lead as any).linked_quote_price || 0);
          const qstatus = String((lead as any).linked_quote_status || "");
          const sent = ["sent", "viewed", "accepted", "converted", "booked"].includes(qstatus.toLowerCase());
          const btn = (label: string, onClick: () => void, primary = false) => (
            <button onClick={onClick} style={{ fontSize: 12, fontWeight: 700, padding: "8px 14px", borderRadius: 7, cursor: "pointer", fontFamily: FF,
              border: primary ? "none" : "1px solid #E5E2DC", background: primary ? "var(--brand, #00C9A0)" : "#fff", color: primary ? "#fff" : "#374151" }}>{label}</button>
          );
          // [quote-details-carry 2026-07-07] What the visitor actually filled
          // out on the booking widget (bedrooms / bathrooms / sqft / frequency
          // / add-ons / how they heard about us / how far they got) — Sal:
          // "we need to pull up their quote and see exactly what was filled
          // out". Written by the widget's abandon-track capture.
          const wd: any = (lead as any).details || {};
          const wdRows: Array<[string, string]> = [];
          if (lead.scope) wdRows.push(["Service", String(lead.scope)]);
          if (wd.frequency) wdRows.push(["Frequency", String(wd.frequency)]);
          if (wd.bedrooms) wdRows.push(["Bedrooms", String(wd.bedrooms)]);
          if (wd.bathrooms) wdRows.push(["Bathrooms", String(wd.bathrooms)]);
          if (wd.sqft) wdRows.push(["Square footage", `${wd.sqft} sq ft`]);
          if (Array.isArray(wd.add_ons) && wd.add_ons.length) wdRows.push(["Add-ons", wd.add_ons.join(", ")]);
          if (wd.referral_source) wdRows.push(["How they heard about us", String(wd.referral_source)]);
          const stepLabel =
            Number(wd.step_reached) >= 4 ? "Saw their price (reached the payment step)" :
            Number(wd.step_reached) >= 2 ? "Entered contact + home details (left before the price)" : null;
          if (stepLabel) wdRows.push(["How far they got", stepLabel]);
          return (
            <div style={{ padding: 20, overflow: "auto" }}>
              {wdRows.length > 0 && (
                <div style={{ background: "#fff", border: "1px solid #E8E5E0", borderRadius: 10, padding: 16, marginBottom: 12 }}>
                  <p style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, color: "#9E9B94", margin: "0 0 10px", fontFamily: FF }}>What they filled out online</p>
                  {wdRows.map(([label, value]) => (
                    <div key={label} style={{ display: "flex", gap: 12, padding: "5px 0", borderTop: "1px solid #F3F1EC", fontSize: 13, fontFamily: FF }}>
                      <span style={{ color: "#6B6860", width: 170, flexShrink: 0 }}>{label}</span>
                      <span style={{ color: "#1A1917", fontWeight: 600 }}>{value}</span>
                    </div>
                  ))}
                </div>
              )}
              {qid ? (
                <div style={{ background: "#fff", border: "1px solid #E8E5E0", borderRadius: 10, padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ fontSize: 22, fontWeight: 800, color: "#1A1917", fontFamily: FF }}>{qprice > 0 ? `$${qprice.toFixed(2)}` : "—"}</span>
                    {qstatus && <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4, padding: "3px 8px", borderRadius: 4, background: sent ? "#E1F5EE" : "#F3F4F6", color: sent ? "#0F6E56" : "#6B7280", fontFamily: FF }}>{qstatus}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {btn("Open / edit quote", () => navigate(`/quotes/${qid}`))}
                    {!sent && btn(sendingQuote ? "Sending…" : "Mark as sent", markQuoteSent, true)}
                  </div>
                  <p style={{ fontSize: 11, color: "#9E9B94", margin: "12px 0 0", fontFamily: FF }}>"Mark as sent" starts the quote follow-up drip for this customer.</p>
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "30px 16px", color: "#9E9B94" }}>
                  {qprice > 0 && <p style={{ fontSize: 20, fontWeight: 800, color: "#1A1917", fontFamily: FF, margin: "0 0 4px" }}>${qprice.toFixed(2)}</p>}
                  {qprice > 0 && <p style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, margin: "0 0 14px" }}>Online quote they saw on the website</p>}
                  <p style={{ fontSize: 13, fontFamily: FF, margin: "0 0 14px" }}>No office quote for this lead yet.</p>
                  {btn("Build a quote", () => navigate("/quotes/new"), true)}
                </div>
              )}
            </div>
          );
        })()}
        {tab === "drip"     && <DripTab lead={lead} onRefresh={() => {}} />}
        {tab === "messages" && <MessagesTab lead={lead} />}
        {tab === "activity" && <ActivityTab lead={lead} />}
        {tab === "jobs"     && <JobsTab lead={lead} />}
      </div>
    </div>
  );
}

// ── Reports View ──────────────────────────────────────────────────────────────

function ReportsView() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`${API}/api/leads/reports`, { headers: getAuthHeaders() });
        if (r.ok) setData(await r.json());
      } finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <div style={{ padding: 32, color: "#9E9B94", fontFamily: FF }}>Loading reports…</div>;
  if (!data) return <div style={{ padding: 32, color: "#9E9B94", fontFamily: FF }}>No data.</div>;

  const t = data.totals || {};
  const total = Number(t.total) || 0;
  const closeRate = total > 0 ? Math.round((t.booked / total) * 100) : 0;

  const funnel = [
    { label: "Needs Contact", n: Number(t.needs_contact) || 0, hint: "nobody has reached out yet" },
    { label: "Contacted", n: Number(t.contacted) || 0, hint: "reached, no quote yet" },
    { label: "Quoted", n: Number(t.quoted) || 0, hint: "quote in their hands" },
    { label: "Booked", n: Number(t.booked) || 0, hint: "became customers", accent: true },
  ];

  const maxSource = Math.max(1, ...(data.bySource || []).map((s: any) => Number(s.total) || 0));
  const maxOwner = Math.max(1, ...(data.byOwner || []).map((o: any) => Number(o.total) || 0));

  // Lead-drip touch delivery, grouped per sequence so Phone and Web read separately.
  const touchBySeq: Record<string, any[]> = {};
  for (const tc of data.touchConversion || []) {
    const key = tc.sequence_name || "Lead Drip";
    (touchBySeq[key] = touchBySeq[key] || []).push(tc);
  }

  const dripRows = (data.dripSummary || []).filter((d: any) =>
    Number(d.in_progress) + Number(d.completed) + Number(d.stopped_replied) + Number(d.stopped_booked) + Number(d.stopped_other) > 0 || d.is_active);

  return (
    <div style={{ padding: "24px 28px", maxWidth: 940, overflowY: "auto" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 4 }}>Pipeline Reports</div>
      <div style={{ fontSize: 12, color: "#6B6860", fontFamily: FF, marginBottom: 20 }}>
        Where your leads come from, where they are right now, who's closing them, and what the automatic follow-ups are doing.
      </div>

      {/* Funnel: every lead is in exactly one of these stages */}
      <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 2 }}>Pipeline right now</div>
        <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginBottom: 14 }}>
          {total} leads all-time · {t.lost || 0} closed as lost · every open lead sits in one of these stages
        </div>
        <div style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
          {funnel.map((f, i) => (
            <div key={f.label} style={{ display: "flex", alignItems: "center", flex: 1 }}>
              <div style={{ flex: 1, textAlign: "center", padding: "10px 6px", borderRadius: 8,
                background: f.accent ? "#D9F6EF" : "#F7F6F3" }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: f.accent ? "#0F6E56" : "#1A1917", fontFamily: FF, letterSpacing: -0.5 }}>{f.n}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: f.accent ? "#0F6E56" : "#1A1917", fontFamily: FF }}>{f.label}</div>
                <div style={{ fontSize: 9.5, color: "#9E9B94", fontFamily: FF, marginTop: 1 }}>{f.hint}</div>
              </div>
              {i < funnel.length - 1 && (
                <ChevronDown size={14} color="#C9C6BF" style={{ transform: "rotate(-90deg)", margin: "0 4px", flexShrink: 0 }} />
              )}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <span style={{ fontSize: 11, fontFamily: FF, color: closeRate >= 30 ? "#0F6E56" : closeRate >= 15 ? "#B45309" : "#DC2626", fontWeight: 700 }}>
            {closeRate}% of all leads end up booking
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Where leads come from */}
        <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Where leads come from</div>
          <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginBottom: 12 }}>Bar = share of all leads · green = how many booked</div>
          {(data.bySource || []).map((s: any) => {
            const n = Number(s.total) || 0;
            return (
              <div key={s.source_label} style={{ padding: "7px 0", borderBottom: "0.5px solid #F2EFE9" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{SOURCE_LABELS[s.source_label] || s.source_label}</span>
                  <span style={{ fontSize: 11, color: "#6B6860", fontFamily: FF }}>
                    {s.booked} of {n} booked <span style={{ color: "#0F6E56", fontWeight: 700 }}>({Math.round(Number(s.close_rate) || 0)}%)</span>
                  </span>
                </div>
                <div style={{ height: 5, background: "#F2EFE9", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(n / maxSource) * 100}%`, background: "#00C9A0", borderRadius: 3 }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Who's closing */}
        <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Who's working the leads</div>
          <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginBottom: 12 }}>Leads assigned to each person and how many they closed</div>
          {(data.byOwner || []).map((o: any) => {
            const n = Number(o.total) || 0;
            const unassigned = !o.owner_name || !String(o.owner_name).trim();
            return (
              <div key={o.owner_name || "unassigned"} style={{ padding: "7px 0", borderBottom: "0.5px solid #F2EFE9" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: unassigned ? "#B45309" : "#1A1917", fontFamily: FF }}>
                    {unassigned ? "Unassigned — nobody owns these" : o.owner_name}
                  </span>
                  <span style={{ fontSize: 11, color: "#6B6860", fontFamily: FF }}>
                    {o.booked} of {n} booked <span style={{ color: "#0F6E56", fontWeight: 700 }}>({Math.round(Number(o.close_rate) || 0)}%)</span>
                  </span>
                </div>
                <div style={{ height: 5, background: "#F2EFE9", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(n / maxOwner) * 100}%`, background: unassigned ? "#F0B95C" : "#00C9A0", borderRadius: 3 }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sequence health: who's in each drip and why people left it */}
      {dripRows.length > 0 && (
        <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "16px 18px", marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Follow-up sequences</div>
          <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginBottom: 12 }}>
            How many people are in each automatic sequence right now, and how they left it. "Replied" and "Booked" are wins — the drip did its job.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1.4fr) repeat(4, 1fr)", gap: 0, fontSize: 11, fontFamily: FF }}>
            <div style={{ color: "#9E9B94", fontWeight: 700, padding: "4px 0" }}>Sequence</div>
            <div style={{ color: "#9E9B94", fontWeight: 700, padding: "4px 0", textAlign: "right" }}>In it now</div>
            <div style={{ color: "#9E9B94", fontWeight: 700, padding: "4px 0", textAlign: "right" }}>Replied</div>
            <div style={{ color: "#9E9B94", fontWeight: 700, padding: "4px 0", textAlign: "right" }}>Booked</div>
            <div style={{ color: "#9E9B94", fontWeight: 700, padding: "4px 0", textAlign: "right" }}>Ran to the end</div>
            {dripRows.map((d: any) => (
              <div key={d.sequence_id} style={{ display: "contents" }}>
                <div style={{ padding: "6px 0", borderTop: "0.5px solid #F2EFE9", color: "#1A1917", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                  {d.sequence_name}
                  {!d.is_active && <span style={{ fontSize: 9, fontWeight: 700, color: "#6B7280", background: "#F3F4F6", borderRadius: 4, padding: "1px 5px" }}>OFF</span>}
                </div>
                <div style={{ padding: "6px 0", borderTop: "0.5px solid #F2EFE9", textAlign: "right", fontWeight: 700, color: Number(d.in_progress) > 0 ? "#0F6E56" : "#B4B2A9" }}>{d.in_progress}</div>
                <div style={{ padding: "6px 0", borderTop: "0.5px solid #F2EFE9", textAlign: "right", color: "#6B6860" }}>{d.stopped_replied}</div>
                <div style={{ padding: "6px 0", borderTop: "0.5px solid #F2EFE9", textAlign: "right", color: "#6B6860" }}>{d.stopped_booked}</div>
                <div style={{ padding: "6px 0", borderTop: "0.5px solid #F2EFE9", textAlign: "right", color: "#6B6860" }}>{d.completed}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lead-drip touch delivery, one row per drip */}
      {Object.keys(touchBySeq).length > 0 && (
        <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "16px 18px", marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Lead drip — messages actually sent</div>
          <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginBottom: 12 }}>
            Each tile is one touch in the drip. The number is how many times that message has gone out. Later touches send less because leads reply or book before reaching them — that's good.
          </div>
          {Object.entries(touchBySeq).map(([seqName, touches]) => (
            <div key={seqName} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 6 }}>{seqName}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {touches.map((tc: any) => (
                  <div key={`${seqName}-${tc.step_number}-${tc.channel}`}
                    style={{ background: Number(tc.sent) > 0 ? "#F7F6F3" : "#FCFBF9", border: "0.5px solid #F2EFE9", borderRadius: 8, padding: "8px 12px", flex: "0 0 auto", minWidth: 86, opacity: Number(tc.sent) > 0 ? 1 : 0.6 }}>
                    <div style={{ fontSize: 10, color: "#9E9B94", fontFamily: FF, display: "flex", alignItems: "center", gap: 4 }}>
                      {tc.channel === "sms" ? <MessageSquare size={9} /> : <Mail size={9} />}
                      Touch {tc.step_number} · {tc.channel === "sms" ? "text" : "email"}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: Number(tc.sent) > 0 ? "#1A1917" : "#B4B2A9", fontFamily: FF }}>{tc.sent} <span style={{ fontSize: 10, fontWeight: 400, color: "#9E9B94" }}>sent</span></div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Friendly names for the raw source values stamped on leads.
const SOURCE_LABELS: Record<string, string> = {
  quote: "Office quote (built by your team)",
  manual: "Added manually",
  very_dirty: "Very Dirty form",
  web_quote: "Website quote widget",
  booking_widget: "Online booking",
  widget: "Website widget",
  website: "Website",
  phone_in: "Phone call",
  referral: "Referral",
};

// ── Sequences View ────────────────────────────────────────────────────────────

function SequencesView() {
  const [seqs, setSeqs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`${API}/api/follow-up/sequences`, { headers: getAuthHeaders() });
        if (r.ok) { const d = await r.json(); setSeqs(d.sequences || d || []); }
      } finally { setLoading(false); }
    })();
  }, []);

  async function toggleActive(seq: any) {
    try {
      const r = await fetch(`${API}/api/follow-up/sequences/${seq.id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !seq.is_active }),
      });
      if (!r.ok) throw new Error();
      setSeqs(prev => prev.map(s => s.id === seq.id ? { ...s, is_active: !s.is_active } : s));
      toast({ title: seq.is_active ? "Sequence paused" : "Sequence activated" });
    } catch { toast({ title: "Failed to update", variant: "destructive" }); }
  }

  const leadSeqs = seqs.filter(s => s.sequence_type === "lead_drip_web" || s.sequence_type === "lead_drip_phone");
  const otherSeqs = seqs.filter(s => s.sequence_type !== "lead_drip_web" && s.sequence_type !== "lead_drip_phone");

  if (loading) return <div style={{ padding: 32, color: "#9E9B94", fontFamily: FF }}>Loading sequences…</div>;

  return (
    <div style={{ padding: "24px 28px", maxWidth: 700, overflowY: "auto" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 6 }}>Sequences</div>
      <div style={{ fontSize: 12, color: "#6B6860", fontFamily: FF, marginBottom: 20, lineHeight: 1.5 }}>
        A sequence is a series of automatic texts and emails. Each one starts on its own trigger,
        and stops the moment the customer replies or books. Click a sequence to see every message
        it sends and when. The toggle controls whether it sends at all — Off means new matching
        leads are not enrolled and nothing goes out.
      </div>

      {leadSeqs.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#9E9B94", fontFamily: FF, marginBottom: 8 }}>Lead Drips — chase new leads until you reach them</div>
          {leadSeqs.map(seq => (
            <SequenceRow key={seq.id} seq={seq} onToggle={() => toggleActive(seq)} />
          ))}
        </>
      )}

      {otherSeqs.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#9E9B94", fontFamily: FF, margin: "16px 0 8px" }}>Customer Journey — quotes, retention, recovery</div>
          {otherSeqs.map(seq => (
            <SequenceRow key={seq.id} seq={seq} onToggle={() => toggleActive(seq)} />
          ))}
        </>
      )}
    </div>
  );
}

// Plain-English explainer per sequence type: who it targets, what starts it,
// what stops it. Rendered on the card so the office never has to guess what a
// toggle controls.
const SEQ_INFO: Record<string, { audience: string; starts: string; stops: string }> = {
  lead_drip_phone: {
    audience: "Leads you talked to on the phone (office-created leads).",
    starts: "Automatically, as soon as the lead lands in Needs Contact.",
    stops: "When they reply, get a quote, or book.",
  },
  lead_drip_web: {
    audience: "Leads that came in through the website booking widget.",
    starts: "Automatically, as soon as the web lead lands in Needs Contact.",
    stops: "When they reply, get a quote, or book.",
  },
  quote_followup: {
    audience: "Customers you sent a quote to.",
    starts: "When a quote is marked Sent (touch 1 IS the quote email).",
    stops: "When they book or reply.",
  },
  post_job_retention: {
    audience: "One-time customers after a completed job.",
    starts: "After the job is completed.",
    stops: "When they rebook or reply.",
  },
  abandoned_booking: {
    audience: "People who started booking online but didn't finish.",
    starts: "About 20 minutes after they abandon the booking form.",
    stops: "When they finish booking or reply.",
  },
  estimate_followup: {
    audience: "Commercial estimate contacts.",
    starts: "When an estimate is sent.",
    stops: "When it's accepted or declined, or they reply.",
  },
};

// "Right away", "2 hours in", "Day 3" — cumulative timing label for a touch.
function touchTimingLabel(cumulativeHours: number): string {
  if (cumulativeHours <= 0) return "Right away";
  if (cumulativeHours < 24) return `${cumulativeHours} hr${cumulativeHours === 1 ? "" : "s"} in`;
  return `Day ${Math.floor(cumulativeHours / 24)}`;
}

function SequenceRow({ seq, onToggle }: { seq: any; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  const steps: any[] = seq.steps || [];
  const smsCount = steps.filter(s => s.channel === "sms").length;
  const emailCount = steps.filter(s => s.channel === "email").length;
  const totalHours = steps.reduce((acc, s) => acc + (Number(s.delay_hours) || 0), 0);
  const spanLabel = totalHours >= 24 ? `runs ${Math.max(1, Math.round(totalHours / 24))} days` : "same day";
  const info = SEQ_INFO[seq.sequence_type];

  // Cumulative offsets so each touch reads "Day N", not a raw delay.
  let cum = 0;
  const timed = steps.map(s => { cum += Number(s.delay_hours) || 0; return { ...s, cumHours: cum }; });

  return (
    <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>{seq.name}</span>
            <span style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>
              {steps.length} touches · {smsCount} text{smsCount === 1 ? "" : "s"} + {emailCount} email{emailCount === 1 ? "" : "s"} · {spanLabel}
            </span>
          </div>
          {info && (
            <div style={{ fontSize: 11, color: "#6B6860", fontFamily: FF, marginTop: 3 }}>
              {info.audience}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <button onClick={e => { e.stopPropagation(); onToggle(); }}
            title={seq.is_active ? "Sending is ON — new matching leads auto-enroll. Click to pause." : "Sending is OFF — nothing enrolls or sends. Click to activate."}
            style={{ padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: FF, fontSize: 11, fontWeight: 700,
              background: seq.is_active ? "#D1FAE5" : "#F3F4F6",
              color: seq.is_active ? "#059669" : "#6B7280" }}>
            {seq.is_active ? "Active" : "Off"}
          </button>
          <ChevronDown size={15} color="#9E9B94" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
        </div>
      </div>

      {open && (
        <div style={{ borderTop: "0.5px solid #E8E5E0", padding: "12px 18px 16px", background: "#FCFBF9" }}>
          {info && (
            <div style={{ display: "flex", gap: 24, marginBottom: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 11, fontFamily: FF }}>
                <span style={{ color: "#9E9B94", fontWeight: 700 }}>STARTS </span>
                <span style={{ color: "#1A1917" }}>{info.starts}</span>
              </div>
              <div style={{ fontSize: 11, fontFamily: FF }}>
                <span style={{ color: "#9E9B94", fontWeight: 700 }}>STOPS </span>
                <span style={{ color: "#1A1917" }}>{info.stops}</span>
              </div>
            </div>
          )}
          {timed.map((s, i) => (
            <div key={s.id || i} style={{ display: "flex", gap: 12, padding: "8px 0", borderTop: i === 0 ? "none" : "0.5px solid #F2EFE9" }}>
              <div style={{ width: 74, flexShrink: 0, fontSize: 11, fontWeight: 700, color: "#1A1917", fontFamily: FF, paddingTop: 1 }}>
                {touchTimingLabel(s.cumHours)}
              </div>
              <div style={{ flexShrink: 0, paddingTop: 1 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 700, fontFamily: FF,
                  background: s.channel === "sms" ? "#D9F6EF" : "#EFEDE8",
                  color: s.channel === "sms" ? "#0F6E56" : "#57544D" }}>
                  {s.channel === "sms" ? <MessageSquare size={10} /> : <Mail size={10} />}
                  {s.channel === "sms" ? "Text" : "Email"}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {s.subject && (
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: "#1A1917", fontFamily: FF, marginBottom: 2 }}>{s.subject}</div>
                )}
                <div style={{ fontSize: 11, color: "#6B6860", fontFamily: FF, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {s.message_template}
                </div>
              </div>
            </div>
          ))}
          {!steps.length && (
            <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>No steps configured for this sequence.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Add Lead Drawer ───────────────────────────────────────────────────────────

function AddLeadDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    first_name: "", last_name: "", email: "", phone: "",
    address: "", city: "", state: "IL", zip: "",
    lead_source: "phone_in", source: "manual", scope: "",
    sqft: "", bedrooms: "", bathrooms: "", notes: "", quote_amount: "",
  });

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const addrRef = useRef<HTMLInputElement>(null);
  useAddressAutocomplete(addrRef, true, (p) => setForm(f => ({
    ...f, address: p.street || f.address, city: p.city || f.city, state: p.state || f.state, zip: p.zip || f.zip,
  })));

  async function handleSave() {
    if (!form.first_name.trim()) { toast({ title: "First name is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/leads`, {
        method: "POST", headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error(await r.text());
      toast({ title: "Lead added" });
      onSaved(); onClose();
    } catch { toast({ title: "Failed to save lead", variant: "destructive" }); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex" }}>
      <div style={{ flex: 1, background: "rgba(0,0,0,0.3)" }} onClick={onClose} />
      <div style={{ width: 480, background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column", height: "100vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px", borderBottom: "1px solid #E5E2DC" }}>
          <span style={{ fontWeight: 700, fontSize: 17, color: "#1A1917", fontFamily: FF }}>Add Lead</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}><X size={18} color="#6B6860" /></button>
        </div>
        <div style={{ padding: "24px 24px 0", flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Lead source */}
          <div>
            <label style={lbl}>How did they reach you?</label>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { value: "phone_in", label: "Phone call" },
                { value: "web_quote", label: "Online form" },
                { value: "manual",  label: "Office entry" },
              ].map(opt => (
                <button key={opt.value} onClick={() => set("lead_source", opt.value)}
                  style={{ flex: 1, padding: "7px 8px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: FF, fontSize: 11, fontWeight: 700,
                    background: form.lead_source === opt.value ? "#0A0E1A" : "#F7F6F3",
                    color: form.lead_source === opt.value ? "#fff" : "#6B6860" }}>
                  {opt.label}
                </button>
              ))}
            </div>
            {form.lead_source === "phone_in" && (
              <div style={{ fontSize: 10, color: "#059669", fontFamily: FF, marginTop: 4 }}>You'll be auto-assigned as owner</div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div><label style={lbl}>First Name *</label><Input value={form.first_name} onChange={e => set("first_name", e.target.value)} placeholder="Jane" /></div>
            <div><label style={lbl}>Last Name</label><Input value={form.last_name} onChange={e => set("last_name", e.target.value)} placeholder="Smith" /></div>
          </div>
          <div><label style={lbl}>Phone</label><Input value={form.phone} onChange={e => set("phone", e.target.value)} placeholder="(773) 555-0000" /></div>
          <div><label style={lbl}>Email</label><Input value={form.email} onChange={e => set("email", e.target.value)} placeholder="jane@example.com" type="email" /></div>
          <div><label style={lbl}>Address</label><Input ref={addrRef} value={form.address} onChange={e => set("address", e.target.value)} placeholder="Start typing — Google will complete it" /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 80px", gap: 8 }}>
            <div><label style={lbl}>City</label><Input value={form.city} onChange={e => set("city", e.target.value)} placeholder="Chicago" /></div>
            <div><label style={lbl}>State</label><Input value={form.state} onChange={e => set("state", e.target.value)} placeholder="IL" style={{ width: 52 }} /></div>
            <div><label style={lbl}>ZIP</label><Input value={form.zip} onChange={e => set("zip", e.target.value)} placeholder="60623" /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={lbl}>Ad Source</label>
              <select value={form.source} onChange={e => set("source", e.target.value)} style={selectStyle}>
                <option value="google_local_services">Google Local Services</option>
                <option value="google_search">Google Search</option>
                <option value="facebook">Facebook</option>
                <option value="referral">Referral</option>
                <option value="realtor">Realtor</option>
                <option value="online_booking">Online Booking</option>
                <option value="booking_widget">Booking Widget</option>
                <option value="contact_form">Contact Form</option>
                <option value="quote_request">Quote Request</option>
                <option value="very_dirty">Very Dirty</option>
                <option value="very_dirty_callback">Very Dirty Callback</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <div><label style={lbl}>Scope</label><Input value={form.scope} onChange={e => set("scope", e.target.value)} placeholder="Deep Clean, Recurring…" /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div><label style={lbl}>Sq Ft</label><Input value={form.sqft} onChange={e => set("sqft", e.target.value)} placeholder="1800" type="number" /></div>
            <div><label style={lbl}>Beds</label><Input value={form.bedrooms} onChange={e => set("bedrooms", e.target.value)} placeholder="3" type="number" /></div>
            <div><label style={lbl}>Baths</label><Input value={form.bathrooms} onChange={e => set("bathrooms", e.target.value)} placeholder="2" type="number" /></div>
          </div>
          <div><label style={lbl}>Quote Amount ($)</label><Input value={form.quote_amount} onChange={e => set("quote_amount", e.target.value)} placeholder="0.00" type="number" step="0.01" /></div>
          <div>
            <label style={lbl}>Notes</label>
            <textarea value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="Any initial notes…"
              style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 12px", fontSize: 14, fontFamily: FF, resize: "vertical", minHeight: 70, outline: "none" }} />
          </div>
        </div>
        <div style={{ padding: 24, display: "flex", gap: 8, borderTop: "1px solid #E5E2DC" }}>
          <Button onClick={handleSave} disabled={saving} style={{ flex: 1, background: "#1A1917", color: "#fff", fontFamily: FF }}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : "Save Lead"}
          </Button>
          <Button variant="outline" onClick={onClose} style={{ flex: 1, fontFamily: FF }}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const LIMIT = 50;

// Website vs Office — the source differentiator shown on every card.
function leadChannel(lead: any): "Website" | "Office" {
  const s = String(lead.lead_source || lead.source || "").toLowerCase();
  return /web|widget|online|quote|form|very_dirty/.test(s) ? "Website" : "Office";
}

// Kanban board grouping the loaded leads by stage so you watch them move
// New → Contacted → Quoted → Booked. Each card carries price + Website/Office +
// (for booked) "drip stopped". Clicking a card opens the same detail panel.
function BoardView({ leads, selectedId, onSelect }: { leads: Lead[]; selectedId: number | null; onSelect: (l: Lead) => void }) {
  const COLS = [
    { key: "needs", label: "Needs contact", color: "#B91C1C", match: (s: string) => !["contacted", "quoted", "booked", "no_response", "not_interested", "closed"].includes(s) },
    { key: "contacted", label: "Contacted", color: "#C2410C", match: (s: string) => s === "contacted" },
    { key: "quoted", label: "Quoted", color: "#1D4ED8", match: (s: string) => s === "quoted" },
    { key: "booked", label: "Booked", color: "#0F6E56", match: (s: string) => s === "booked" },
  ];
  return (
    <div style={{ flex: 1, overflow: "auto", padding: 12, background: "#F7F6F3" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(190px,1fr))", gap: 10, minWidth: 800, height: "100%" }}>
        {COLS.map(col => {
          const items = leads.filter(l => col.match(String(l.status || "")));
          return (
            <div key={col.key} style={{ background: "#F0EEE9", borderRadius: 10, padding: 8, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 6px 8px", fontSize: 10, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: FF }}>
                <span style={{ color: col.color }}>{col.label}</span><span style={{ color: "#9E9B94" }}>{items.length}</span>
              </div>
              <div style={{ overflowY: "auto", flex: 1 }}>
                {items.map(l => {
                  const booked = String(l.status) === "booked";
                  const ch = leadChannel(l);
                  const price = Number((l as any).quote_amount || (l as any).linked_quote_price || 0);
                  return (
                    <div key={l.id} onClick={() => onSelect(l)} style={{ background: "#fff", border: `1px solid ${selectedId === l.id ? "#00C9A0" : "#E8E5E0"}`, boxShadow: selectedId === l.id ? "0 0 0 2px rgba(0,201,160,.18)" : "none", borderRadius: 8, padding: "9px 10px", marginBottom: 7, cursor: "pointer" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>{[l.first_name, l.last_name].filter(Boolean).join(" ") || "—"}</span>
                        {price > 0 && <span style={{ fontSize: 12.5, fontWeight: 800, color: "#1A1917", fontFamily: FF }}>${price.toFixed(0)}</span>}
                      </div>
                      <div style={{ fontSize: 10.5, color: "#8A8780", margin: "2px 0 6px", fontFamily: FF, display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.scope || "—"}</span>
                        <span style={{ fontSize: 8.5, fontWeight: 800, padding: "1px 6px", borderRadius: 4, flexShrink: 0, background: ch === "Website" ? "#EDE9FE" : "#EEF1F4", color: ch === "Website" ? "#6D28D9" : "#475569" }}>{ch}</span>
                      </div>
                      <div style={{ fontSize: 9.5, color: booked ? "#0F6E56" : "#B4B2A9", fontFamily: FF }}>{booked ? "✓ Booked — drip stopped" : fmtDate(l.created_at)}</div>
                    </div>
                  );
                })}
                {items.length === 0 && <div style={{ fontSize: 10, color: "#C4C0B8", textAlign: "center", padding: "14px 0", fontFamily: FF }}>—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function LeadsPage() {
  const [, navigate] = useLocation();
  const [mainView, setMainView] = useState<"pipeline" | "reports" | "sequences">("pipeline");
  const [view, setView] = useState<"board" | "list">("board");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<OwnerOpt[]>([]);
  const [partners, setPartners] = useState<PartnerOpt[]>([]);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const { toast } = useToast();
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
      if (filter !== "all") params.set("status", filter);
      if (search) params.set("search", search);
      const r = await fetch(`${API}/api/leads?${params}`, { headers: getAuthHeaders() });
      if (r.ok) { const d = await r.json(); setLeads(d.leads || []); setTotal(d.total || 0); }
    } finally { setLoading(false); }
  }, [page, filter, search]);

  const loadCounts = useCallback(async () => {
    const r = await fetch(`${API}/api/leads/status-counts`, { headers: getAuthHeaders() });
    if (r.ok) {
      const obj: Record<string, number> = await r.json();
      const map: Record<string, number> = { all: 0 };
      for (const [status, n] of Object.entries(obj)) {
        map[status] = Number(n);
        map.all = (map.all || 0) + Number(n);
      }
      setCounts(map);
    }
  }, []);

  useEffect(() => {
    fetch(`${API}/api/users?limit=200`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        // Lead owners are the people who answer the phone — office tier only.
        // The full roster (cleaners, trainees, test users) doesn't belong here.
        const all = (d.data || d || []) as any[];
        setUsers(all.filter(u =>
          ["owner", "admin", "office"].includes(u.role) && (u.is_active ?? u.active ?? true)));
      });
    fetch(`${API}/api/referral-partners`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setPartners(d.partners || d || []); });
  }, []);

  useEffect(() => { loadLeads(); }, [loadLeads]);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  // [quote-details-carry 2026-07-07] Deep-link from the office lead-alert
  // email: /leads?lead=<id> auto-opens that lead's detail panel. Falls back to
  // fetching the single lead if it isn't on the loaded page. Param strips
  // after opening so navigation doesn't keep re-opening it.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const leadParam = sp.get("lead");
    if (!leadParam || loading) return;
    const id = parseInt(leadParam, 10);
    const strip = () => {
      sp.delete("lead");
      const rest = sp.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    };
    const hit = leads.find(l => l.id === id);
    if (hit) { setSelectedLead(hit); strip(); return; }
    fetch(`${API}/api/leads?search=&page=1&limit=1&id=${id}`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const found = (d?.leads || []).find((l: Lead) => l.id === id);
        if (found) setSelectedLead(found);
      })
      .catch(() => {})
      .finally(strip);
  }, [loading, leads]);

  async function handleBulkDelete() {
    if (!checkedIds.size) return;
    if (!confirm(`Delete ${checkedIds.size} lead${checkedIds.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    setBulkDeleting(true);
    try {
      const r = await fetch(`${API}/api/leads/bulk-delete`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(checkedIds) }),
      });
      if (!r.ok) throw new Error();
      toast({ title: `${checkedIds.size} lead${checkedIds.size > 1 ? "s" : ""} deleted` });
      setCheckedIds(new Set());
      if (selectedLead && checkedIds.has(selectedLead.id)) setSelectedLead(null);
      loadLeads(); loadCounts();
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    } finally { setBulkDeleting(false); }
  }

  function handleSearch(val: string) {
    setSearch(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setPage(1), 400);
  }

  function handleFilter(f: string) {
    setFilter(f);
    setPage(1);
  }

  return (
    <DashboardLayout>
      {/* Top bar */}
      <div style={{ background: "#0A0E1A", padding: "0 20px", height: 48, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        {/* Title doubles as the "back to the list" affordance — no redundant
            "Leads" tab, and Quotes is no longer a tab: the quote lives on each
            lead's record (Quote tab in the detail panel). */}
        <button onClick={() => setMainView("pipeline")} style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
          <div style={{ width: 22, height: 22, borderRadius: 5, background: "#00C9A0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: "#0A0E1A", fontFamily: FF }}>Q</div>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#fff", letterSpacing: -0.3, fontFamily: FF }}>Leads</span>
        </button>
        <div style={{ display: "flex", gap: 2 }}>
          {(["reports", "sequences"] as const).map(v => (
            <button key={v} onClick={() => setMainView(v)}
              style={{ fontSize: 11, fontWeight: 600, padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: FF,
                background: mainView === v ? "rgba(255,255,255,.12)" : "transparent",
                color: mainView === v ? "#fff" : "#6B9A8E", textTransform: "capitalize" }}>
              {v}
            </button>
          ))}
        </div>
        {mainView === "pipeline" ? (
          <div style={{ display: "inline-flex", border: "1px solid rgba(255,255,255,.18)", borderRadius: 7, overflow: "hidden" }}>
            {(["board", "list"] as const).map(vw => (
              <button key={vw} onClick={() => setView(vw)}
                style={{ fontSize: 11, fontWeight: 700, padding: "5px 12px", border: "none", cursor: "pointer", fontFamily: FF, textTransform: "capitalize",
                  background: view === vw ? "#fff" : "transparent", color: view === vw ? "#0A0E1A" : "#6B9A8E" }}>
                {vw}
              </button>
            ))}
          </div>
        ) : <div />}
      </div>

      {mainView === "reports" && <ReportsView />}
      {mainView === "sequences" && <SequencesView />}

      {mainView === "pipeline" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
          <KpiStrip counts={counts} filter={filter} onFilter={handleFilter} />

          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            {view === "board" && (
              <BoardView leads={leads} selectedId={selectedLead?.id ?? null} onSelect={l => { setSelectedLead(l); setCheckedIds(new Set()); }} />
            )}
            {view === "list" && (
            <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid #E8E5E0", background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", borderBottom: "0.5px solid #E8E5E0" }}>
                <div style={{ position: "relative" }}>
                  <Search size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#9E9B94" }} />
                  <input
                    value={search} onChange={e => handleSearch(e.target.value)}
                    placeholder="Search leads…"
                    style={{ width: "100%", fontSize: 12, padding: "6px 10px 6px 28px", border: "0.5px solid #E5E2DC", borderRadius: 7, outline: "none", color: "#1A1917", background: "#F7F6F3", fontFamily: FF }} />
                </div>
              </div>
              {checkedIds.size > 0 && (
                <div style={{ padding: "8px 14px", background: "#FEF2F2", borderBottom: "1px solid #FECACA", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#DC2626", fontFamily: FF }}>{checkedIds.size} selected</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => setCheckedIds(new Set())}
                      style={{ fontSize: 10, padding: "4px 8px", borderRadius: 5, border: "0.5px solid #FECACA", background: "#fff", color: "#6B6860", cursor: "pointer", fontFamily: FF }}>
                      Clear
                    </button>
                    <button onClick={handleBulkDelete} disabled={bulkDeleting}
                      style={{ fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 5, border: "none", background: "#DC2626", color: "#fff", cursor: "pointer", fontFamily: FF }}>
                      {bulkDeleting ? <Loader2 size={10} className="animate-spin" /> : `Delete ${checkedIds.size}`}
                    </button>
                  </div>
                </div>
              )}
              <div style={{ flex: 1, overflowY: "auto" }}>
                {loading ? (
                  <div style={{ padding: 20, display: "flex", justifyContent: "center" }}><Loader2 size={18} className="animate-spin" color="#9E9B94" /></div>
                ) : leads.length === 0 ? (
                  <div style={{ padding: 20, textAlign: "center", color: "#9E9B94", fontSize: 12, fontFamily: FF }}>No leads found</div>
                ) : (
                  leads.map(lead => (
                    <LeadRow
                      key={lead.id}
                      lead={lead}
                      selected={selectedLead?.id === lead.id}
                      onClick={() => { setSelectedLead(lead); setCheckedIds(new Set()); }}
                      checked={checkedIds.has(lead.id)}
                      onCheck={e => {
                        const next = new Set(checkedIds);
                        e.target.checked ? next.add(lead.id) : next.delete(lead.id);
                        setCheckedIds(next);
                      }}
                    />
                  ))
                )}
                {total > LIMIT && (
                  <div style={{ padding: "10px 14px", textAlign: "center", fontSize: 11, color: "#9E9B94", fontFamily: FF }}>
                    Showing {leads.length} of {total}
                  </div>
                )}
              </div>
            </div>
            )}

            {/* Detail — beside the list, or a right drawer over the board.
                In board mode it only opens once a card is selected. */}
            {(view === "list" || selectedLead) && (
            <div style={{ flex: view === "board" ? "0 0 460px" : 1, overflow: "hidden", display: "flex", flexDirection: "column", borderLeft: view === "board" ? "1px solid #E8E5E0" : "none" }}>
              {selectedLead ? (
                <LeadDetailPanel
                  key={selectedLead.id}
                  lead={selectedLead}
                  users={users}
                  partners={partners}
                  onUpdated={() => { loadLeads(); loadCounts(); }}
                  onClose={() => setSelectedLead(null)}
                />
              ) : (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#C4C0B8", fontSize: 13, fontFamily: FF }}>
                  Select a lead to view details
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      )}

    </DashboardLayout>
  );
}
