import { useState, useEffect, useCallback, useRef } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  UserPlus, Search, ChevronLeft, ChevronRight, X,
  Phone, Mail, MapPin, RefreshCw, Loader2,
  MessageSquare, Briefcase, Activity, Eye, ChevronDown,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

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

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  needs_contacted: { label: "Needs Contacted", color: "#DC2626", bg: "#FEF2F2" },
  contacted:       { label: "Contacted",        color: "#D97706", bg: "#FFFBEB" },
  quoted:          { label: "Quoted",           color: "#2563EB", bg: "#EFF6FF" },
  follow_up:       { label: "Follow Up",        color: "#EA580C", bg: "#FFF7ED" },
  booked:          { label: "Booked",           color: "#059669", bg: "#ECFDF5" },
  no_response:     { label: "No Response",      color: "#6B7280", bg: "#F9FAFB" },
  not_interested:  { label: "Not Interested",   color: "#6B7280", bg: "#F3F4F6" },
};

const SOURCE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  google_local_services: { label: "Google Local Services", color: "#1D4ED8", bg: "#DBEAFE" },
  google_search:         { label: "Google Search",         color: "#3B82F6", bg: "#EFF6FF" },
  facebook:              { label: "Facebook",              color: "#4338CA", bg: "#EEF2FF" },
  referral:              { label: "Referral",              color: "#059669", bg: "#ECFDF5" },
  realtor:               { label: "Realtor",               color: "#0D9488", bg: "#F0FDFA" },
  online_booking:        { label: "Online Booking",        color: "#10B981", bg: "#F0FDF4" },
  very_dirty_callback:   { label: "Very Dirty Callback",   color: "#EA580C", bg: "#FFF7ED" },
  booking_widget:        { label: "Booking Widget",        color: "#0369A1", bg: "#EFF6FF" },
  very_dirty:            { label: "Very Dirty",            color: "#DC2626", bg: "#FEF2F2" },
  contact_form:          { label: "Contact Form",          color: "#7C3AED", bg: "#F5F3FF" },
  quote_request:         { label: "Quote Request",         color: "#D97706", bg: "#FFFBEB" },
  manual:                { label: "Manual",                color: "#374151", bg: "#F3F4F6" },
};

const STATUS_ORDER = ['needs_contacted', 'contacted', 'quoted', 'follow_up', 'booked', 'no_response', 'not_interested'];
const ALL_STATUSES = STATUS_ORDER;

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || { label: status, color: "#374151", bg: "#F3F4F6" };
  return (
    <span style={{ background: cfg.bg, color: cfg.color, fontSize: 12, fontWeight: 600,
      padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {cfg.label}
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const cfg = SOURCE_CONFIG[source] || { label: source, color: "#374151", bg: "#F3F4F6" };
  return (
    <span style={{ background: cfg.bg, color: cfg.color, fontSize: 11, fontWeight: 500,
      padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {cfg.label}
    </span>
  );
}

function fmtDate(str: string | null) {
  if (!str) return "—";
  return new Date(str).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(str: string | null) {
  if (!str) return "—";
  return new Date(str).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function actionLabel(type: string) {
  return ({
    status_change: "Status changed",
    note_added: "Note added",
    call_logged: "Call logged",
    email_sent: "Email sent",
    sms_sent: "SMS sent",
    quote_sent: "Quote sent",
    converted: "Converted to client",
  } as Record<string, string>)[type] || type;
}

// ── Add Lead Drawer ─────────────────────────────────────────────────────────────

function AddLeadDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    first_name: "", last_name: "", email: "", phone: "",
    address: "", city: "", state: "IL", zip: "",
    source: "manual", scope: "", sqft: "", bedrooms: "", bathrooms: "",
    notes: "", quote_amount: "",
  });

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function handleSave() {
    if (!form.first_name.trim()) {
      toast({ title: "First name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/leads`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ ...form }),
      });
      if (!r.ok) throw new Error(await r.text());
      toast({ title: "Lead added" });
      onSaved();
      onClose();
    } catch {
      toast({ title: "Failed to save lead", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex" }}>
      <div style={{ flex: 1, background: "rgba(0,0,0,0.3)" }} onClick={onClose} />
      <div style={{ width: 480, background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
        display: "flex", flexDirection: "column", height: "100vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "20px 24px", borderBottom: "1px solid #E5E2DC" }}>
          <span style={{ fontWeight: 700, fontSize: 17, color: "#1A1917" }}>Add Lead</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
            <X size={18} color="#6B6860" />
          </button>
        </div>
        <div style={{ padding: "24px 24px 0", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={lbl}>First Name *</label>
              <Input value={form.first_name} onChange={e => set("first_name", e.target.value)} placeholder="Jane" />
            </div>
            <div>
              <label style={lbl}>Last Name</label>
              <Input value={form.last_name} onChange={e => set("last_name", e.target.value)} placeholder="Smith" />
            </div>
          </div>
          <div>
            <label style={lbl}>Phone</label>
            <Input value={form.phone} onChange={e => set("phone", e.target.value)} placeholder="(773) 555-0000" />
          </div>
          <div>
            <label style={lbl}>Email</label>
            <Input value={form.email} onChange={e => set("email", e.target.value)} placeholder="jane@example.com" type="email" />
          </div>
          <div>
            <label style={lbl}>Address</label>
            <Input value={form.address} onChange={e => set("address", e.target.value)} placeholder="Street address" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 80px", gap: 8 }}>
            <div>
              <label style={lbl}>City</label>
              <Input value={form.city} onChange={e => set("city", e.target.value)} placeholder="Chicago" />
            </div>
            <div>
              <label style={lbl}>State</label>
              <Input value={form.state} onChange={e => set("state", e.target.value)} placeholder="IL" style={{ width: 52 }} />
            </div>
            <div>
              <label style={lbl}>ZIP</label>
              <Input value={form.zip} onChange={e => set("zip", e.target.value)} placeholder="60623" />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={lbl}>Source</label>
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
            <div>
              <label style={lbl}>Scope</label>
              <Input value={form.scope} onChange={e => set("scope", e.target.value)} placeholder="Deep Clean, Recurring…" />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div>
              <label style={lbl}>Sq Ft</label>
              <Input value={form.sqft} onChange={e => set("sqft", e.target.value)} placeholder="1800" type="number" />
            </div>
            <div>
              <label style={lbl}>Beds</label>
              <Input value={form.bedrooms} onChange={e => set("bedrooms", e.target.value)} placeholder="3" type="number" />
            </div>
            <div>
              <label style={lbl}>Baths</label>
              <Input value={form.bathrooms} onChange={e => set("bathrooms", e.target.value)} placeholder="2" type="number" />
            </div>
          </div>
          <div>
            <label style={lbl}>Quote Amount ($)</label>
            <Input value={form.quote_amount} onChange={e => set("quote_amount", e.target.value)} placeholder="0.00" type="number" step="0.01" />
          </div>
          <div>
            <label style={lbl}>Notes</label>
            <textarea value={form.notes} onChange={e => set("notes", e.target.value)}
              placeholder="Any initial notes…"
              style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 12px",
                fontSize: 14, fontFamily: "inherit", resize: "vertical", minHeight: 80, outline: "none" }} />
          </div>
        </div>
        <div style={{ padding: 24, display: "flex", gap: 8, borderTop: "1px solid #E5E2DC" }}>
          <Button onClick={handleSave} disabled={saving} style={{ flex: 1, background: "#1A1917", color: "#fff" }}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : "Save Lead"}
          </Button>
          <Button variant="outline" onClick={onClose} style={{ flex: 1 }}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── Lead Detail Drawer ──────────────────────────────────────────────────────────

const TABS = [
  { key: "overview",  label: "Overview",  icon: Eye },
  { key: "activity",  label: "Activity",  icon: Activity },
  { key: "messages",  label: "Messages",  icon: MessageSquare },
  { key: "jobs",      label: "Jobs",      icon: Briefcase },
];

function LeadDetailDrawer({
  lead, onClose, onUpdated
}: { lead: Lead; onClose: () => void; onUpdated: () => void }) {
  const { toast } = useToast();
  const [tab, setTab] = useState("overview");
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [messages, setMessages] = useState<ActivityEntry[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [actLoading, setActLoading] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [statusChanging, setStatusChanging] = useState(false);
  const [editStatus, setEditStatus] = useState(lead.status);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const loadActivity = useCallback(async () => {
    setActLoading(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}/activity`, { headers: getAuthHeaders() });
      if (r.ok) setActivity(await r.json());
    } finally { setActLoading(false); }
  }, [lead.id]);

  const loadMessages = useCallback(async () => {
    const r = await fetch(`${API}/api/leads/${lead.id}/messages`, { headers: getAuthHeaders() });
    if (r.ok) setMessages(await r.json());
  }, [lead.id]);

  const loadJobs = useCallback(async () => {
    const r = await fetch(`${API}/api/leads/${lead.id}/jobs`, { headers: getAuthHeaders() });
    if (r.ok) setJobs(await r.json());
  }, [lead.id]);

  useEffect(() => {
    if (tab === "activity") loadActivity();
    if (tab === "messages") loadMessages();
    if (tab === "jobs") loadJobs();
  }, [tab, loadActivity, loadMessages, loadJobs]);

  async function handleStatusChange(newStatus: string) {
    if (newStatus === editStatus) return;
    setStatusChanging(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!r.ok) throw new Error();
      setEditStatus(newStatus);
      toast({ title: "Status updated" });
      onUpdated();
    } catch {
      toast({ title: "Failed to update status", variant: "destructive" });
    } finally { setStatusChanging(false); }
  }

  async function handleLogNote(actionType = "note_added") {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}/activity`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action_type: actionType, note: noteText }),
      });
      if (!r.ok) throw new Error();
      setNoteText("");
      toast({ title: actionType === "call_logged" ? "Call logged" : "Note added" });
      loadActivity();
      if (tab !== "activity") setTab("activity");
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally { setSavingNote(false); }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const r = await fetch(`${API}/api/leads/${lead.id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (!r.ok) throw new Error();
      toast({ title: "Lead deleted" });
      onUpdated();
      onClose();
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    } finally { setDeleting(false); }
  }

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
  const cfgStatus = STATUS_CONFIG[editStatus] || STATUS_CONFIG["needs_contacted"];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex" }}>
      <div style={{ flex: 1, background: "rgba(0,0,0,0.3)" }} onClick={onClose} />
      <div style={{ width: 560, background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
        display: "flex", flexDirection: "column", height: "100vh", overflowY: "auto" }}>

        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #E5E2DC" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 18, color: "#1A1917" }}>{name}</div>
              <div style={{ fontSize: 13, color: "#6B6860", marginTop: 2 }}>
                Lead #{lead.id} · Added {fmtDate(lead.created_at)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <SourceBadge source={lead.source} />
              <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, marginLeft: 4 }}>
                <X size={18} color="#6B6860" />
              </button>
            </div>
          </div>

          {/* Status selector */}
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: "#6B6860" }}>Status:</span>
            <div style={{ position: "relative" }}>
              <select
                value={editStatus}
                onChange={e => handleStatusChange(e.target.value)}
                disabled={statusChanging}
                style={{ appearance: "none", background: cfgStatus.bg, color: cfgStatus.color,
                  border: `1px solid ${cfgStatus.color}30`, borderRadius: 999, padding: "4px 28px 4px 12px",
                  fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                {ALL_STATUSES.map(s => (
                  <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>
                ))}
              </select>
              <ChevronDown size={13} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                color: cfgStatus.color, pointerEvents: "none" }} />
            </div>
            {statusChanging && <Loader2 size={14} className="animate-spin" color="#6B6860" />}
          </div>

          {/* Contact bar */}
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 12 }}>
            {lead.phone && (
              <a href={`tel:${lead.phone}`} style={contactLink}>
                <Phone size={13} /> {lead.phone}
              </a>
            )}
            {lead.email && (
              <a href={`mailto:${lead.email}`} style={contactLink}>
                <Mail size={13} /> {lead.email}
              </a>
            )}
            {lead.address && (
              <span style={{ ...contactLink, cursor: "default" }}>
                <MapPin size={13} /> {lead.address}{lead.city ? `, ${lead.city}` : ""}{lead.zip ? ` ${lead.zip}` : ""}
              </span>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #E5E2DC", paddingLeft: 24 }}>
          {TABS.map(t => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "12px 16px",
                  fontSize: 13, fontWeight: active ? 600 : 400, color: active ? "#1A1917" : "#6B6860",
                  borderBottom: active ? "2px solid #1A1917" : "2px solid transparent",
                  background: "none", border: "none", borderBottomStyle: "solid",
                  borderBottomWidth: 2, borderBottomColor: active ? "#1A1917" : "transparent",
                  cursor: "pointer", fontFamily: "inherit" }}>
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>

          {/* Overview */}
          {tab === "overview" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <InfoField label="Scope" value={lead.scope} />
                <InfoField label="Sq Ft" value={lead.sqft ? `${lead.sqft.toLocaleString()} sqft` : null} />
                <InfoField label="Bedrooms" value={lead.bedrooms ? `${lead.bedrooms} bed` : null} />
                <InfoField label="Bathrooms" value={lead.bathrooms ? `${lead.bathrooms} bath` : null} />
                <InfoField label="Quote Amount" value={lead.quote_amount ? `$${parseFloat(lead.quote_amount).toFixed(2)}` : null} />
                <InfoField label="Assigned To"
                  value={lead.assignee_first_name ? `${lead.assignee_first_name} ${lead.assignee_last_name || ""}`.trim() : null} />
                <InfoField label="Contacted" value={fmtDate(lead.contacted_at)} />
                <InfoField label="Quoted" value={fmtDate(lead.quoted_at)} />
                <InfoField label="Booked" value={fmtDate(lead.booked_at)} />
                <InfoField label="Job #" value={lead.job_id ? `#${lead.job_id}` : null} />
                {lead.closed_reason && <InfoField label="Close Reason" value={lead.closed_reason} />}
              </div>
              {lead.notes && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#6B6860", textTransform: "uppercase",
                    letterSpacing: "0.05em", marginBottom: 6 }}>Notes</div>
                  <div style={{ background: "#F7F6F3", borderRadius: 6, padding: "12px 14px",
                    fontSize: 14, color: "#1A1917", whiteSpace: "pre-wrap" }}>{lead.notes}</div>
                </div>
              )}

              {/* Quick action: log note/call */}
              <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", marginBottom: 8 }}>Quick Log</div>
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  placeholder="Add a note or call summary…"
                  style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6,
                    padding: "8px 12px", fontSize: 14, fontFamily: "inherit", resize: "vertical",
                    minHeight: 72, outline: "none", boxSizing: "border-box" }} />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <Button size="sm" onClick={() => handleLogNote("call_logged")} disabled={savingNote || !noteText.trim()}>
                    <Phone size={13} style={{ marginRight: 4 }} /> Log Call
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleLogNote("note_added")} disabled={savingNote || !noteText.trim()}>
                    Add Note
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Activity */}
          {tab === "activity" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>Activity Log</span>
                <button onClick={loadActivity} style={{ background: "none", border: "none", cursor: "pointer" }}>
                  <RefreshCw size={14} color="#6B6860" />
                </button>
              </div>
              {actLoading ? (
                <div style={{ textAlign: "center", padding: 40 }}>
                  <Loader2 size={20} className="animate-spin" color="#6B6860" style={{ margin: "0 auto" }} />
                </div>
              ) : activity.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#6B6860", fontSize: 14 }}>
                  No activity logged yet.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  {activity.map((a, i) => (
                    <div key={a.id} style={{ display: "flex", gap: 12, paddingBottom: 16,
                      borderLeft: i < activity.length - 1 ? "2px solid #E5E2DC" : "2px solid transparent",
                      marginLeft: 8 }}>
                      <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#5B9BD5",
                        flexShrink: 0, marginTop: 2, marginLeft: -6 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{actionLabel(a.action_type)}</span>
                          {(a.performer_first_name) && (
                            <span style={{ fontSize: 12, color: "#6B6860" }}>
                              by {a.performer_first_name} {a.performer_last_name || ""}
                            </span>
                          )}
                        </div>
                        {a.note && <div style={{ fontSize: 13, color: "#374151", marginBottom: 2 }}>{a.note}</div>}
                        <div style={{ fontSize: 11, color: "#9CA3AF" }}>{fmtDateTime(a.created_at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Log note from activity tab */}
              <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 16, marginTop: 8 }}>
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  placeholder="Add a note or call summary…"
                  style={{ width: "100%", border: "1px solid #E5E2DC", borderRadius: 6,
                    padding: "8px 12px", fontSize: 14, fontFamily: "inherit", resize: "vertical",
                    minHeight: 72, outline: "none", boxSizing: "border-box" }} />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <Button size="sm" onClick={() => handleLogNote("call_logged")} disabled={savingNote || !noteText.trim()}>
                    <Phone size={13} style={{ marginRight: 4 }} /> Log Call
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleLogNote("note_added")} disabled={savingNote || !noteText.trim()}>
                    Add Note
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Messages */}
          {tab === "messages" && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", marginBottom: 14 }}>Messages Sent</div>
              {messages.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#6B6860", fontSize: 14 }}>
                  No messages logged for this lead yet.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {messages.map(m => (
                    <div key={m.id} style={{ border: "1px solid #E5E2DC", borderRadius: 8,
                      padding: "12px 14px", background: "#FAFAF9" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: m.action_type === "sms_sent" ? "#059669" : "#0369A1",
                          background: m.action_type === "sms_sent" ? "#ECFDF5" : "#EFF6FF",
                          padding: "1px 7px", borderRadius: 999 }}>
                          {m.action_type === "sms_sent" ? "SMS" : "Email"}
                        </span>
                        <span style={{ fontSize: 11, color: "#9CA3AF" }}>{fmtDateTime(m.created_at)}</span>
                      </div>
                      {m.note && <div style={{ fontSize: 13, color: "#374151" }}>{m.note}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Jobs */}
          {tab === "jobs" && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", marginBottom: 14 }}>Linked Jobs</div>
              {jobs.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#6B6860", fontSize: 14 }}>
                  No jobs linked to this lead.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {jobs.map(j => (
                    <div key={j.id} style={{ border: "1px solid #E5E2DC", borderRadius: 8, padding: "12px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, fontSize: 14, color: "#1A1917" }}>Job #{j.id}</span>
                        <span style={{ fontSize: 12, color: "#6B6860" }}>{j.status}</span>
                      </div>
                      <div style={{ fontSize: 13, color: "#374151" }}>
                        {j.service_type} · {fmtDate(j.scheduled_date)}
                        {j.base_fee ? ` · $${parseFloat(j.base_fee).toFixed(2)}` : ""}
                      </div>
                      {j.tech_first_name && (
                        <div style={{ fontSize: 12, color: "#6B6860", marginTop: 2 }}>
                          Tech: {j.tech_first_name} {j.tech_last_name || ""}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div style={{ padding: "16px 24px", borderTop: "1px solid #E5E2DC", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!showDeleteConfirm ? (
            <Button variant="outline" onClick={() => setShowDeleteConfirm(true)}
              style={{ color: "#DC2626", borderColor: "#DC2626" }}>
              Delete Lead
            </Button>
          ) : (
            <>
              <span style={{ fontSize: 13, color: "#DC2626", display: "flex", alignItems: "center" }}>
                Delete permanently?
              </span>
              <Button onClick={handleDelete} disabled={deleting}
                style={{ background: "#DC2626", color: "#fff", borderColor: "#DC2626" }}>
                {deleting ? <Loader2 size={14} className="animate-spin" /> : "Confirm Delete"}
              </Button>
              <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoField({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || value === "—") return null;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#6B6860", textTransform: "uppercase",
        letterSpacing: "0.05em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, color: "#1A1917" }}>{value}</div>
    </div>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600,
  color: "#6B6860", marginBottom: 5 };
const selectStyle: React.CSSProperties = { width: "100%", border: "1px solid #E5E2DC",
  borderRadius: 6, padding: "8px 12px", fontSize: 14, fontFamily: "inherit",
  background: "#fff", outline: "none", cursor: "pointer" };
const contactLink: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5,
  fontSize: 13, color: "#374151", textDecoration: "none" };

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function LeadsPage() {
  const { toast } = useToast();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const LIMIT = 25;

  const loadLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
      if (statusFilter) params.set("status", statusFilter);
      if (search) params.set("search", search);
      const r = await fetch(`${API}/api/leads?${params}`, { headers: getAuthHeaders() });
      if (!r.ok) throw new Error();
      const data = await r.json();
      setLeads(data.leads || []);
      setTotal(data.total || 0);
    } catch {
      toast({ title: "Failed to load leads", variant: "destructive" });
    } finally { setLoading(false); }
  }, [page, statusFilter, search, toast]);

  const loadCounts = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/leads/status-counts`, { headers: getAuthHeaders() });
      if (r.ok) setCounts(await r.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadLeads(); loadCounts(); }, [loadLeads, loadCounts]);

  function handleSearchChange(v: string) {
    setSearchInput(v);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setSearch(v);
      setPage(1);
    }, 350);
  }

  function handleStatusFilter(s: string) {
    setStatusFilter(prev => prev === s ? "" : s);
    setPage(1);
  }

  const totalPages = Math.ceil(total / LIMIT);
  const totalNeeds = counts["needs_contacted"] || 0;

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 0 40px" }}>

        {/* Page header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: 0 }}>
              Lead Pipeline
              {totalNeeds > 0 && (
                <span style={{ marginLeft: 10, background: "#FEF2F2", color: "#DC2626",
                  fontSize: 13, fontWeight: 700, padding: "2px 10px", borderRadius: 999 }}>
                  {totalNeeds} need contact
                </span>
              )}
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 14, color: "#6B6860" }}>
              {total.toLocaleString()} total lead{total !== 1 ? "s" : ""}
            </p>
          </div>
          <Button onClick={() => setShowAdd(true)}
            style={{ background: "#1A1917", color: "#fff", gap: 6, display: "flex", alignItems: "center" }}>
            <UserPlus size={15} /> Add Lead
          </Button>
        </div>

        {/* Status filter pills */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          <button onClick={() => { setStatusFilter(""); setPage(1); }}
            style={pillStyle(statusFilter === "")}>
            All <span style={{ fontWeight: 400, opacity: 0.7, marginLeft: 4 }}>
              {Object.values(counts).reduce((a, b) => a + b, 0) || total}
            </span>
          </button>
          {ALL_STATUSES.map(s => {
            const cfg = STATUS_CONFIG[s];
            const active = statusFilter === s;
            return (
              <button key={s} onClick={() => handleStatusFilter(s)}
                style={{
                  padding: "6px 14px", borderRadius: 999, fontSize: 13, fontWeight: active ? 700 : 500,
                  cursor: "pointer", fontFamily: "inherit",
                  background: active ? cfg.color : cfg.bg,
                  color: active ? "#fff" : cfg.color,
                  border: `1px solid ${active ? cfg.color : cfg.color + "40"}`,
                }}>
                {cfg.label}{counts[s] ? ` ${counts[s]}` : ""}
              </button>
            );
          })}
        </div>

        {/* Search bar */}
        <div style={{ position: "relative", marginBottom: 20, maxWidth: 400 }}>
          <Search size={15} style={{ position: "absolute", left: 12, top: "50%",
            transform: "translateY(-50%)", color: "#9CA3AF" }} />
          <Input
            value={searchInput}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search by name, email, phone, address…"
            style={{ paddingLeft: 36 }} />
          {searchInput && (
            <button onClick={() => { setSearchInput(""); setSearch(""); setPage(1); }}
              style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer", padding: 2 }}>
              <X size={14} color="#9CA3AF" />
            </button>
          )}
        </div>

        {/* Table */}
        <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: "#F7F6F3", borderBottom: "1px solid #E5E2DC" }}>
                {["Name", "Contact", "Source", "Status", "Scope", "Quote", "Created", ""].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11,
                    fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.05em",
                    whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} style={{ padding: "60px 0", textAlign: "center" }}>
                    <Loader2 size={22} className="animate-spin" color="#6B6860" style={{ margin: "0 auto" }} />
                  </td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: "60px 0", textAlign: "center" }}>
                    <UserPlus size={36} color="#D1D5DB" style={{ margin: "0 auto 12px" }} />
                    <div style={{ color: "#6B6860", fontSize: 14 }}>
                      {search || statusFilter ? "No leads match your filters." : "No leads yet — add your first lead."}
                    </div>
                  </td>
                </tr>
              ) : leads.map((lead, i) => {
                const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
                return (
                  <tr key={lead.id}
                    style={{ borderBottom: i < leads.length - 1 ? "1px solid #F3F4F6" : "none",
                      cursor: "pointer", transition: "background 0.1s" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#FAFAF9")}
                    onMouseLeave={e => (e.currentTarget.style.background = "")}
                    onClick={() => setSelectedLead(lead)}>
                    <td style={{ padding: "12px 14px" }}>
                      <div style={{ fontWeight: 600, color: "#1A1917" }}>{name}</div>
                      {lead.address && (
                        <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 1 }}>
                          {lead.address}{lead.city ? `, ${lead.city}` : ""}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "12px 14px" }}>
                      {lead.phone && <div style={{ fontSize: 13, color: "#374151" }}>{lead.phone}</div>}
                      {lead.email && <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 1 }}>{lead.email}</div>}
                    </td>
                    <td style={{ padding: "12px 14px" }}><SourceBadge source={lead.source} /></td>
                    <td style={{ padding: "12px 14px" }}><StatusBadge status={lead.status} /></td>
                    <td style={{ padding: "12px 14px", color: "#374151", fontSize: 13 }}>
                      {lead.scope || <span style={{ color: "#D1D5DB" }}>—</span>}
                    </td>
                    <td style={{ padding: "12px 14px", color: "#374151", fontSize: 13 }}>
                      {lead.quote_amount ? `$${parseFloat(lead.quote_amount).toFixed(2)}`
                        : <span style={{ color: "#D1D5DB" }}>—</span>}
                    </td>
                    <td style={{ padding: "12px 14px", color: "#9CA3AF", fontSize: 12, whiteSpace: "nowrap" }}>
                      {fmtDate(lead.created_at)}
                    </td>
                    <td style={{ padding: "12px 14px" }}>
                      <span style={{ fontSize: 12, color: "#5B9BD5" }}>View →</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
            marginTop: 16, fontSize: 13, color: "#6B6860" }}>
            <span>
              Showing {((page - 1) * LIMIT) + 1}–{Math.min(page * LIMIT, total)} of {total.toLocaleString()}
            </span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Button variant="outline" size="sm" disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}>
                <ChevronLeft size={14} />
              </Button>
              <span style={{ padding: "0 8px" }}>{page} / {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Drawers */}
      {showAdd && (
        <AddLeadDrawer onClose={() => setShowAdd(false)} onSaved={() => { loadLeads(); loadCounts(); }} />
      )}
      {selectedLead && (
        <LeadDetailDrawer
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onUpdated={() => { loadLeads(); loadCounts(); setSelectedLead(null); }}
        />
      )}
    </DashboardLayout>
  );
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 14px", borderRadius: 999, fontSize: 13,
    fontWeight: active ? 700 : 500, cursor: "pointer", fontFamily: "inherit",
    background: active ? "#1A1917" : "#F7F6F3",
    color: active ? "#fff" : "#374151",
    border: `1px solid ${active ? "#1A1917" : "#E5E2DC"}`,
  };
}
