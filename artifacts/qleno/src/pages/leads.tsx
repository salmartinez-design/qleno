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
  const [tab, setTab] = useState("drip");
  const [editStatus, setEditStatus] = useState(lead.status);
  const [statusChanging, setStatusChanging] = useState(false);
  const [savingField, setSavingField] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Sync status if lead prop changes
  useEffect(() => { setEditStatus(lead.status); }, [lead.id, lead.status]);

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
  const closeRate = t.total > 0 ? Math.round((t.booked / t.total) * 100) : 0;

  return (
    <div style={{ padding: "24px 28px", maxWidth: 900, overflowY: "auto" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 20 }}>Pipeline Reports</div>

      {/* KPI tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        {[
          { label: "Total Leads", n: t.total || 0 },
          { label: "Booked", n: t.booked || 0, color: "#059669" },
          { label: "Close Rate", n: `${closeRate}%`, color: closeRate >= 30 ? "#059669" : closeRate >= 15 ? "#D97706" : "#DC2626" },
          { label: "Active", n: t.active || 0 },
        ].map(tile => (
          <div key={tile.label} style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "16px 18px" }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: (tile as any).color || "#1A1917", fontFamily: FF, letterSpacing: -0.5 }}>{tile.n}</div>
            <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginTop: 2 }}>{tile.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* By Source */}
        <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 12 }}>By Source</div>
          {(data.bySource || []).map((s: any) => (
            <div key={s.source_label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 0", borderBottom: "0.5px solid #F2EFE9" }}>
              <span style={{ fontSize: 11, color: "#1A1917", fontFamily: FF }}>{s.source_label}</span>
              <div style={{ display: "flex", gap: 12, fontSize: 11, fontFamily: FF }}>
                <span style={{ color: "#6B6860" }}>{s.total} leads</span>
                <span style={{ color: "#059669", fontWeight: 600 }}>{s.close_rate}% close</span>
              </div>
            </div>
          ))}
        </div>

        {/* By Owner */}
        <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 12 }}>By Owner</div>
          {(data.byOwner || []).map((o: any) => (
            <div key={o.owner_name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 0", borderBottom: "0.5px solid #F2EFE9" }}>
              <span style={{ fontSize: 11, color: "#1A1917", fontFamily: FF }}>{o.owner_name || "Unassigned"}</span>
              <div style={{ display: "flex", gap: 12, fontSize: 11, fontFamily: FF }}>
                <span style={{ color: "#6B6860" }}>{o.total} leads</span>
                <span style={{ color: "#059669", fontWeight: 600 }}>{o.close_rate || 0}% close</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Touch conversion */}
      {(data.touchConversion || []).length > 0 && (
        <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "16px 18px", marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 12 }}>Drip Touch Performance</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(data.touchConversion || []).map((tc: any) => (
              <div key={tc.step_number} style={{ background: "#F7F6F3", borderRadius: 8, padding: "10px 14px", flex: "0 0 auto" }}>
                <div style={{ fontSize: 10, color: "#9E9B94", fontFamily: FF }}>Touch {tc.step_number} · {tc.channel}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>{tc.sent}</div>
                <div style={{ fontSize: 10, color: "#6B6860", fontFamily: FF }}>sent</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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
      <div style={{ fontSize: 12, color: "#6B6860", fontFamily: FF, marginBottom: 20 }}>
        Toggle sequences on/off. Active sequences auto-enroll matching new leads.
      </div>

      {leadSeqs.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#9E9B94", fontFamily: FF, marginBottom: 8 }}>Lead Drip</div>
          {leadSeqs.map(seq => (
            <SequenceRow key={seq.id} seq={seq} onToggle={() => toggleActive(seq)} />
          ))}
        </>
      )}

      {otherSeqs.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#9E9B94", fontFamily: FF, margin: "16px 0 8px" }}>Other Sequences</div>
          {otherSeqs.map(seq => (
            <SequenceRow key={seq.id} seq={seq} onToggle={() => toggleActive(seq)} />
          ))}
        </>
      )}
    </div>
  );
}

function SequenceRow({ seq, onToggle }: { seq: any; onToggle: () => void }) {
  return (
    <div style={{ background: "#fff", border: "0.5px solid #E8E5E0", borderRadius: 10, padding: "14px 18px", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>{seq.name}</div>
        <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>{seq.sequence_type}</div>
      </div>
      <button onClick={onToggle}
        style={{ padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: FF, fontSize: 11, fontWeight: 700,
          background: seq.is_active ? "#D1FAE5" : "#F3F4F6",
          color: seq.is_active ? "#059669" : "#6B7280" }}>
        {seq.is_active ? "Active" : "Inactive"}
      </button>
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

export default function LeadsPage() {
  const [, navigate] = useLocation();
  const [mainView, setMainView] = useState<"pipeline" | "reports" | "sequences">("pipeline");
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
      .then(d => { if (d) setUsers(d.data || d || []); });
    fetch(`${API}/api/referral-partners`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setPartners(d.partners || d || []); });
  }, []);

  useEffect(() => { loadLeads(); }, [loadLeads]);
  useEffect(() => { loadCounts(); }, [loadCounts]);

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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 22, height: 22, borderRadius: 5, background: "#00C9A0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: "#0A0E1A", fontFamily: FF }}>Q</div>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#fff", letterSpacing: -0.3, fontFamily: FF }}>Pipeline</span>
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {(["pipeline", "reports", "sequences"] as const).map(v => (
            <button key={v} onClick={() => setMainView(v)}
              style={{ fontSize: 11, fontWeight: 600, padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: FF,
                background: mainView === v ? "rgba(255,255,255,.12)" : "transparent",
                color: mainView === v ? "#fff" : "#6B9A8E", textTransform: "capitalize" }}>
              {v}
            </button>
          ))}
          {/* Quotes folds into the Pipeline section — the quotes list + "Mark as
              Sent" (which triggers the quote follow-up drip) live there. */}
          <button onClick={() => navigate("/quotes")}
            style={{ fontSize: 11, fontWeight: 600, padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: FF, background: "transparent", color: "#6B9A8E" }}>
            Quotes
          </button>
        </div>
        <div />
      </div>

      {mainView === "reports" && <ReportsView />}
      {mainView === "sequences" && <SequencesView />}

      {mainView === "pipeline" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
          <KpiStrip counts={counts} filter={filter} onFilter={handleFilter} />

          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            {/* Lead list */}
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

            {/* Detail panel */}
            <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
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
          </div>
        </div>
      )}

    </DashboardLayout>
  );
}
