import { useState, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import {
  ArrowLeft, Home, CreditCard, FileText, Bell, Star, UserX, StickyNote, Globe,
  Plus, Trash2, Edit2, ChevronLeft, ChevronRight, Check, X, Eye, EyeOff,
  Phone, Mail, MapPin, MessageSquare, Send, AlertTriangle, TrendingUp,
  ClipboardList, DollarSign, BookOpen, Paperclip, ShieldCheck, Loader2,
} from "lucide-react";
import { QuotesTab, PaymentsTab, QuickBooksTab, AttachmentsTab } from "./customer-profile-tabs2";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function fmtDate(d?: string | null) {
  if (!d) return "Never";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtCurrency(v?: number | string | null) {
  const n = typeof v === "string" ? parseFloat(v) : (v || 0);
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function freqLabel(f?: string | null) {
  const m: Record<string,string> = { weekly:"Weekly", biweekly:"Bi-weekly", monthly:"Monthly", on_demand:"On Demand" };
  return f ? (m[f] || f) : "Not set";
}

function tierLabel(t: string) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function tierToPoints(t: string) {
  if (t === "silver") return 500;
  if (t === "gold") return 1000;
  if (t === "vip") return 2000;
  return 500; // standard -> silver
}

function nextTierName(t: string) {
  if (t === "standard") return "Silver";
  if (t === "silver") return "Gold";
  if (t === "gold") return "VIP";
  return null;
}

const TABS = [
  { id: "overview", label: "Overview", icon: Home },
  { id: "homes", label: "Homes", icon: MapPin },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "card-on-file", label: "Card on File", icon: ShieldCheck },
  { id: "quotes", label: "Quotes", icon: ClipboardList },
  { id: "payments", label: "Payments", icon: DollarSign },
  { id: "agreements", label: "Agreements", icon: FileText },
  { id: "attachments", label: "Attachments", icon: Paperclip },
  { id: "quickbooks", label: "QuickBooks", icon: BookOpen },
  { id: "contacts", label: "Contacts & Notifications", icon: Bell },
  { id: "scorecards", label: "Scorecards", icon: Star },
  { id: "tech", label: "Tech Preferences", icon: UserX },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "portal", label: "Portal Account", icon: Globe },
] as const;

type TabId = typeof TABS[number]["id"];

// ─── Mini Calendar ────────────────────────────────────────────────────────────
function MiniCalendar({ jobs }: { jobs: any[] }) {
  const [dt, setDt] = useState(new Date());
  const year = dt.getFullYear(); const month = dt.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = dt.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const jobsByDay: Record<number, string> = {};
  for (const j of jobs) {
    if (!j.scheduled_date) continue;
    const d = new Date(j.scheduled_date);
    if (d.getFullYear() === year && d.getMonth() === month) {
      jobsByDay[d.getDate()] = j.status;
    }
  }

  const dotColor: Record<string,string> = { complete:"#16A34A", scheduled:"#5B9BD5", assigned:"#5B9BD5", cancelled:"#9E9B94", skipped:"#9E9B94" };

  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <button onClick={() => setDt(new Date(year, month - 1))} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: "2px" }}><ChevronLeft size={14} /></button>
        <span style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280" }}>{monthName}</span>
        <button onClick={() => setDt(new Date(year, month + 1))} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: "2px" }}><ChevronRight size={14} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "2px" }}>
        {["S","M","T","W","T","F","S"].map((d, i) => (
          <div key={i} style={{ textAlign: "center", fontSize: "9px", fontWeight: 600, color: "#C4C0BB", paddingBottom: "4px" }}>{d}</div>
        ))}
        {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const status = jobsByDay[day];
          const color = status ? dotColor[status] : undefined;
          return (
            <div key={day} style={{ textAlign: "center", padding: "3px 0", position: "relative" }}>
              <span style={{ fontSize: "11px", color: status ? "#1A1917" : "#6B7280", fontWeight: status ? 700 : 400 }}>{day}</span>
              {color && <div style={{ width: "4px", height: "4px", borderRadius: "50%", background: color, margin: "0 auto" }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Left Sidebar ─────────────────────────────────────────────────────────────
function ClientSidebar({ client, stats, jobs, onPortalInvite }: { client: any; stats: any; jobs: any[]; onPortalInvite: () => void }) {
  const loyalty_tier = client.loyalty_tier || "standard";
  const nextTier = nextTierName(loyalty_tier);
  const threshold = tierToPoints(loyalty_tier);
  const pts = client.loyalty_points || 0;
  const pct = Math.min(100, (pts / threshold) * 100);
  const rateLastDate = client.rate_increase_last_date ? new Date(client.rate_increase_last_date) : null;
  const monthsSinceIncrease = rateLastDate ? Math.floor((Date.now() - rateLastDate.getTime()) / (30 * 86400000)) : 999;
  const rateDue = monthsSinceIncrease >= 12;

  const portalStatus = client.portal_access ? "registered" : client.portal_invite_sent_at ? "invited" : "none";

  return (
    <div style={{ width: "272px", flexShrink: 0 }}>
      <div style={{ position: "sticky", top: "24px", display: "flex", flexDirection: "column", gap: "12px" }}>

        {/* Client Header Card */}
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "12px", padding: "20px" }}>
          <div style={{ width: "52px", height: "52px", borderRadius: "50%", background: "var(--brand-dim)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
            <span style={{ fontSize: "20px", fontWeight: 700, color: "var(--brand)" }}>
              {client.first_name?.[0]}{client.last_name?.[0]}
            </span>
          </div>
          <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "#1A1917", lineHeight: 1.2 }}>
            {client.first_name} {client.last_name}
          </h2>
          {client.company_name && <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#6B7280" }}>{client.company_name}</p>}
          <p style={{ margin: "4px 0 0", fontSize: "11px", color: "#9E9B94" }}>CL-{String(client.id).padStart(4, "0")}</p>

          <div style={{ display: "flex", gap: "6px", marginTop: "10px", flexWrap: "wrap" }}>
            {client.frequency && (
              <span style={{ background: "var(--brand-dim)", color: "var(--brand)", padding: "3px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {freqLabel(client.frequency)}
              </span>
            )}
            {client.service_type && (
              <span style={{ background: "#F3F4F6", color: "#6B7280", padding: "3px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {client.service_type === "recurring" ? "Recurring" : "One-Time"}
              </span>
            )}
          </div>

          {/* Portal pill */}
          <div style={{ marginTop: "12px" }}>
            {portalStatus === "registered" && (
              <span style={{ background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0", padding: "4px 10px", borderRadius: "20px", fontSize: "11px", fontWeight: 600 }}>Portal Active</span>
            )}
            {portalStatus === "invited" && (
              <span style={{ background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A", padding: "4px 10px", borderRadius: "20px", fontSize: "11px", fontWeight: 600 }}>Invite Sent {fmtDate(client.portal_invite_sent_at)}</span>
            )}
            {portalStatus === "none" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB", padding: "4px 10px", borderRadius: "20px", fontSize: "11px", fontWeight: 600, display: "inline-block" }}>No Portal Access</span>
                <button onClick={onPortalInvite} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                  <Send size={11} /> Send Portal Invite
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Loyalty */}
        <div style={{ backgroundColor: "var(--brand-dim)", border: "1px solid rgba(91,155,213,0.2)", borderRadius: "12px", padding: "16px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: "var(--brand)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>CleanRewards</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
            <span style={{ fontSize: "26px", fontWeight: 700, color: "var(--brand)", lineHeight: 1 }}>{pts.toLocaleString()}</span>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--brand)", opacity: 0.7 }}>pts</span>
          </div>
          <span style={{ background: "var(--brand)", color: "#FFFFFF", padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginTop: "4px", display: "inline-block" }}>
            {tierLabel(loyalty_tier)}
          </span>
          {nextTier && (
            <>
              <div style={{ height: "6px", backgroundColor: "rgba(91,155,213,0.2)", borderRadius: "3px", margin: "10px 0 4px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, backgroundColor: "var(--brand)", borderRadius: "3px", transition: "width 0.4s" }} />
              </div>
              <div style={{ fontSize: "11px", color: "var(--brand)", opacity: 0.8 }}>{Math.max(0, threshold - pts)} pts until {nextTier}</div>
            </>
          )}
        </div>

        {/* Stats */}
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "12px", padding: "16px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "12px" }}>Stats</div>
          {[
            ["Client Since", client.client_since ? fmtDate(client.client_since) : fmtDate(client.created_at)],
            ["Last Cleaning", fmtDate(stats?.last_cleaning)],
            ["Next Cleaning", fmtDate(stats?.next_cleaning)],
            ["All-Time Revenue", fmtCurrency(stats?.revenue_all_time)],
            ["Last 12mo Revenue", fmtCurrency(stats?.revenue_last_12mo)],
            ["Avg Bill", fmtCurrency(stats?.avg_bill)],
            ["Scorecard Avg", stats?.scorecard_avg != null ? `${parseFloat(stats.scorecard_avg).toFixed(1)}/4.0` : "No data"],
            ["Total Jobs", stats?.total_jobs || 0],
          ].map(([label, value]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F0EEE9" }}>
              <span style={{ fontSize: "12px", color: "#6B7280" }}>{label}</span>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--brand)" }}>{value}</span>
            </div>
          ))}
        </div>

        {/* Rate increase warning */}
        {rateDue && client.base_fee && (
          <div style={{ backgroundColor: "#FEF3C7", border: "1px solid #FDE68A", borderLeft: "3px solid #F59E0B", borderRadius: "8px", padding: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
              <AlertTriangle size={13} style={{ color: "#F59E0B" }} />
              <span style={{ fontSize: "11px", fontWeight: 700, color: "#92400E" }}>Rate Increase Due</span>
            </div>
            <p style={{ margin: 0, fontSize: "11px", color: "#78350F" }}>
              Last increase: {rateLastDate ? fmtDate(rateLastDate.toISOString()) : "Never"}<br />
              Current rate: {fmtCurrency(client.base_fee)}<br />
              Suggested +5%: {fmtCurrency(parseFloat(client.base_fee) * 1.05)}
            </p>
            <button style={{ marginTop: "8px", padding: "5px 10px", background: "#F59E0B", color: "#FFFFFF", border: "none", borderRadius: "5px", fontSize: "11px", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}>
              <TrendingUp size={10} /> Send Rate Increase
            </button>
          </div>
        )}

        {/* Mini calendar */}
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "12px", padding: "16px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "2px" }}>Job Calendar</div>
          <MiniCalendar jobs={jobs} />
          <div style={{ display: "flex", gap: "10px", marginTop: "10px", flexWrap: "wrap" }}>
            {[["#16A34A","Complete"],["#5B9BD5","Scheduled"],["#9E9B94","Cancelled"]].map(([c,l]) => (
              <div key={l} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: c }} />
                <span style={{ fontSize: "10px", color: "#9E9B94" }}>{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ client, onUpdate, refetch }: { client: any; onUpdate: (data: any) => Promise<void>; refetch: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ first_name: client.first_name, last_name: client.last_name, email: client.email || "", phone: client.phone || "", company_name: client.company_name || "", notes: client.notes || "", base_fee: client.base_fee || "", allowed_hours: client.allowed_hours || "", frequency: client.frequency || "", service_type: client.service_type || "" });

  const save = async () => {
    await onUpdate(form);
    setEditing(false);
    refetch();
  };

  const Field = ({ label, value, field, type = "text" }: { label: string; value: string; field: string; type?: string }) => (
    <div>
      <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>{label}</label>
      {editing ? (
        <input value={(form as any)[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} type={type}
          style={{ width: "100%", padding: "8px 10px", border: "1px solid #D1D5DB", borderRadius: "6px", fontSize: "13px", color: "#1A1917", outline: "none", boxSizing: "border-box" }} />
      ) : (
        <p style={{ margin: 0, fontSize: "13px", color: value ? "#1A1917" : "#9E9B94" }}>{value || "Not set"}</p>
      )}
    </div>
  );

  const SelectField = ({ label, value, field, opts }: { label: string; value: string; field: string; opts: [string,string][] }) => (
    <div>
      <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>{label}</label>
      {editing ? (
        <select value={(form as any)[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
          style={{ width: "100%", padding: "8px 10px", border: "1px solid #D1D5DB", borderRadius: "6px", fontSize: "13px", color: "#1A1917", outline: "none", background: "#FFFFFF" }}>
          <option value="">Not set</option>
          {opts.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      ) : (
        <p style={{ margin: 0, fontSize: "13px", color: value ? "#1A1917" : "#9E9B94" }}>{value || "Not set"}</p>
      )}
    </div>
  );

  const cardStyle: React.CSSProperties = { backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" };
  const gridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {editing ? (
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={() => setEditing(false)} style={{ padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
            <button onClick={save} style={{ padding: "7px 14px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Save Changes</button>
          </div>
        ) : (
          <button onClick={() => setEditing(true)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#1A1917", fontSize: "13px", cursor: "pointer" }}>
            <Edit2 size={13} /> Edit
          </button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        <div style={cardStyle}>
          <h3 style={{ margin: "0 0 16px", fontSize: "13px", fontWeight: 700, color: "#1A1917" }}>Client Info</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={gridStyle}>
              <Field label="First Name" value={form.first_name} field="first_name" />
              <Field label="Last Name" value={form.last_name} field="last_name" />
            </div>
            <Field label="Email" value={form.email} field="email" type="email" />
            <Field label="Phone" value={form.phone} field="phone" type="tel" />
            <Field label="Company Name" value={form.company_name} field="company_name" />
            <div>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>Notes</label>
              {editing ? (
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #D1D5DB", borderRadius: "6px", fontSize: "13px", color: "#1A1917", outline: "none", boxSizing: "border-box", resize: "vertical" }} />
              ) : (
                <p style={{ margin: 0, fontSize: "13px", color: form.notes ? "#1A1917" : "#9E9B94" }}>{form.notes || "No notes"}</p>
              )}
            </div>
          </div>
        </div>

        <div style={cardStyle}>
          <h3 style={{ margin: "0 0 16px", fontSize: "13px", fontWeight: 700, color: "#1A1917" }}>Service Summary</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <Field label="Address" value={[client.address, client.city, client.state, client.zip].filter(Boolean).join(", ")} field="address" />
            <div style={gridStyle}>
              <SelectField label="Frequency" value={form.frequency} field="frequency" opts={[["weekly","Weekly"],["biweekly","Bi-weekly"],["monthly","Monthly"],["on_demand","On Demand"]]} />
              <SelectField label="Service Type" value={form.service_type} field="service_type" opts={[["recurring","Recurring"],["one_time","One-Time"]]} />
            </div>
            <div style={gridStyle}>
              <Field label="Current Rate" value={form.base_fee ? `$${form.base_fee}` : ""} field="base_fee" type="number" />
              <Field label="Allowed Hours" value={form.allowed_hours ? `${form.allowed_hours} hrs` : ""} field="allowed_hours" type="number" />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>QBO Status</label>
              <p style={{ margin: 0, fontSize: "13px", color: client.qbo_customer_id ? "#16A34A" : "#9E9B94" }}>
                {client.qbo_customer_id ? `Connected (ID: ${client.qbo_customer_id})` : "Not connected"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "16px" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: "13px", fontWeight: 700, color: "#1A1917" }}>Quick Actions</h3>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {[{ icon: MessageSquare, label: "Send SMS" }, { icon: Mail, label: "Send Email" }, { icon: StickyNote, label: "Add Note" }, { icon: Plus, label: "Create Job" }, { icon: Globe, label: "View Portal" }].map(({ icon: Icon, label }) => (
            <button key={label} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: "8px", background: "#FFFFFF", color: "#1A1917", fontSize: "13px", cursor: "pointer" }}>
              <Icon size={13} strokeWidth={1.5} /> {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Homes Tab ────────────────────────────────────────────────────────────────
function HomesTab({ clientId, homes, refetch }: { clientId: number; homes: any[]; refetch: () => void }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [showAlarm, setShowAlarm] = useState<number | null>(null);
  const blank = { name: "", address: "", city: "", state: "", zip: "", bedrooms: "", bathrooms: "", sq_footage: "", access_notes: "", alarm_code: "", has_pets: false, pet_notes: "", parking_notes: "", is_primary: false, base_fee: "", allowed_hours: "", frequency: "", service_type: "" };
  const [form, setForm] = useState(blank);

  const createMut = useMutation({
    mutationFn: (data: any) => apiFetch(`/api/clients/${clientId}/homes`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { refetch(); setShowForm(false); setForm(blank); },
  });

  const deleteMut = useMutation({
    mutationFn: (homeId: number) => apiFetch(`/api/clients/${clientId}/homes/${homeId}`, { method: "DELETE" }),
    onSuccess: () => refetch(),
  });

  const F = (field: string, label: string, type = "text", placeholder = "") => (
    <div>
      <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#6B7280", marginBottom: "4px" }}>{label}</label>
      <input value={(form as any)[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} type={type} placeholder={placeholder}
        style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", color: "#1A1917", outline: "none", boxSizing: "border-box" }} />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {homes.map(home => (
        <div key={home.id} style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#1A1917" }}>{home.name || "Home"}</h3>
                {home.is_primary && <span style={{ background: "var(--brand-dim)", color: "var(--brand)", padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, textTransform: "uppercase" }}>Default</span>}
              </div>
              <p style={{ margin: "4px 0 0", fontSize: "14px", fontWeight: 600, color: "#1A1917" }}>{home.address}</p>
              <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#6B7280" }}>{[home.city, home.state, home.zip].filter(Boolean).join(", ")}</p>
            </div>
            <button onClick={() => deleteMut.mutate(home.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: "4px" }}>
              <Trash2 size={14} />
            </button>
          </div>

          {/* Property details */}
          <div style={{ display: "flex", gap: "16px", marginBottom: "12px" }}>
            {home.sq_footage && <span style={{ fontSize: "12px", color: "#9E9B94" }}>{home.sq_footage.toLocaleString()} sq ft</span>}
            {home.bedrooms && <span style={{ fontSize: "12px", color: "#9E9B94" }}>{home.bedrooms} bed</span>}
            {home.bathrooms && <span style={{ fontSize: "12px", color: "#9E9B94" }}>{home.bathrooms} bath</span>}
          </div>

          {/* Access notes */}
          <div style={{ background: "#FAFAF8", border: "1px solid #F0EEE9", borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
            {home.alarm_code && (
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "#6B7280", minWidth: "90px" }}>Alarm Code:</span>
                <span style={{ fontSize: "12px", fontWeight: 600, color: "#1A1917", fontFamily: "monospace", letterSpacing: "0.1em" }}>
                  {showAlarm === home.id ? home.alarm_code : "•".repeat(home.alarm_code.length)}
                </span>
                <button onClick={() => setShowAlarm(showAlarm === home.id ? null : home.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}>
                  {showAlarm === home.id ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            )}
            {home.access_notes && <p style={{ margin: 0, fontSize: "12px", color: "#6B7280" }}><span style={{ fontWeight: 600, color: "#1A1917" }}>Access: </span>{home.access_notes}</p>}
            {home.parking_notes && <p style={{ margin: 0, fontSize: "12px", color: "#6B7280" }}><span style={{ fontWeight: 600, color: "#1A1917" }}>Parking: </span>{home.parking_notes}</p>}
            {home.has_pets && <p style={{ margin: 0, fontSize: "12px", color: "#6B7280" }}><span style={{ fontWeight: 600, color: "#1A1917" }}>Pets: </span>{home.pet_notes || "Yes"}</p>}
          </div>

          {/* Service settings */}
          <div style={{ display: "flex", gap: "20px", marginTop: "12px", flexWrap: "wrap" }}>
            {home.base_fee && <span style={{ fontSize: "12px", color: "#6B7280" }}>Rate: <strong style={{ color: "#1A1917" }}>{fmtCurrency(home.base_fee)}</strong></span>}
            {home.allowed_hours && <span style={{ fontSize: "12px", color: "#6B7280" }}>Hours: <strong style={{ color: "#1A1917" }}>{home.allowed_hours} hrs</strong></span>}
            {home.frequency && <span style={{ fontSize: "12px", color: "#6B7280" }}>Freq: <strong style={{ color: "#1A1917" }}>{freqLabel(home.frequency)}</strong></span>}
          </div>
        </div>
      ))}

      {/* Add home form */}
      {showForm ? (
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
          <h3 style={{ margin: "0 0 16px", fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>Add Service Address</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {F("name", "Home Name (optional)", "text", "e.g. Main Home, Vacation Home")}
            {F("address", "Address *")}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 100px", gap: "10px" }}>
              {F("city", "City")} {F("state", "State")} {F("zip", "Zip")}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
              {F("sq_footage", "Sq Ft", "number")} {F("bedrooms", "Beds", "number")} {F("bathrooms", "Baths", "number")}
            </div>
            {F("alarm_code", "Alarm Code")}
            {F("access_notes", "Access Notes")}
            {F("parking_notes", "Parking Notes")}
            <div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                <input type="checkbox" checked={form.has_pets} onChange={e => setForm(f => ({ ...f, has_pets: e.target.checked }))} /> Client has pets
              </label>
            </div>
            {form.has_pets && F("pet_notes", "Pet Notes")}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              {F("base_fee", "Rate ($)", "number")} {F("allowed_hours", "Allowed Hours", "number")}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
              <input type="checkbox" checked={form.is_primary} onChange={e => setForm(f => ({ ...f, is_primary: e.target.checked }))} /> Set as primary address
            </label>
          </div>
          <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
            <button onClick={() => setShowForm(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
            <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending} style={{ padding: "8px 16px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              {createMut.isPending ? "Saving..." : "Add Home"}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "12px 16px", border: "1px dashed #D1D5DB", borderRadius: "10px", background: "transparent", color: "#6B7280", fontSize: "13px", cursor: "pointer", width: "100%", justifyContent: "center" }}>
          <Plus size={14} /> Add Another Home
        </button>
      )}
    </div>
  );
}

// ─── Billing Tab ──────────────────────────────────────────────────────────────
function BillingTab({ invoices }: { invoices: any[] }) {
  const statusStyle: Record<string, React.CSSProperties> = {
    paid: { background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0" },
    overdue: { background: "#FEE2E2", color: "#991B1B", border: "1px solid #FECACA" },
    sent: { background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A" },
    draft: { background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB" },
  };
  const TH: React.CSSProperties = { padding: "10px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #EEECE7" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ backgroundColor: "#FAFAF8" }}>
            {["Date","Invoice #","Amount","Balance","Status",""].map(h => <th key={h} style={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {invoices.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>No invoices yet</td></tr>
            ) : invoices.map(inv => (
              <tr key={inv.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                <td style={{ padding: "12px 16px", fontSize: "13px", color: "#6B7280" }}>{fmtDate(inv.created_at)}</td>
                <td style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>INV-{String(inv.id).padStart(5, "0")}</td>
                <td style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>{fmtCurrency(inv.total)}</td>
                <td style={{ padding: "12px 16px", fontSize: "13px", color: inv.paid_at ? "#9E9B94" : "#1A1917" }}>{inv.paid_at ? "$0.00" : fmtCurrency(inv.total)}</td>
                <td style={{ padding: "12px 16px" }}>
                  <span style={{ ...statusStyle[inv.status] || statusStyle.draft, padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {inv.status}
                  </span>
                </td>
                <td style={{ padding: "12px 16px" }}>
                  <button style={{ fontSize: "12px", color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>View</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Agreements Tab ────────────────────────────────────────────────────────────
function AgreementsTab({ clientId, agreements, refetch }: { clientId: number; agreements: any[]; refetch: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [template, setTemplate] = useState("Standard Service Agreement");

  const sendMut = useMutation({
    mutationFn: () => apiFetch(`/api/clients/${clientId}/agreements/send`, { method: "POST", body: JSON.stringify({ template_name: template }) }),
    onSuccess: () => { refetch(); setShowForm(false); },
  });

  const TH: React.CSSProperties = { padding: "10px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #EEECE7" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => setShowForm(true)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: "8px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
          <Send size={13} /> Send Agreement
        </button>
      </div>
      {showForm && (
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>Send Service Agreement</h3>
          <div style={{ marginBottom: "12px" }}>
            <label style={{ fontSize: "12px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Agreement Template</label>
            <select value={template} onChange={e => setTemplate(e.target.value)} style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", background: "#FFFFFF" }}>
              <option>Standard Service Agreement</option>
              <option>Commercial Cleaning Contract</option>
              <option>Move-In / Move-Out Agreement</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={() => setShowForm(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
            <button onClick={() => sendMut.mutate()} disabled={sendMut.isPending} style={{ padding: "8px 16px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              {sendMut.isPending ? "Sending..." : "Send Agreement"}
            </button>
          </div>
        </div>
      )}
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ backgroundColor: "#FAFAF8" }}>
            {["Agreement","Sent","Accepted","IP Address","Status"].map(h => <th key={h} style={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {agreements.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>No agreements sent yet</td></tr>
            ) : agreements.map(a => (
              <tr key={a.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                <td style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>{a.template_name || "Service Agreement"}</td>
                <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280" }}>{fmtDate(a.sent_at)}</td>
                <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280" }}>{a.accepted_at ? fmtDate(a.accepted_at) : "Pending"}</td>
                <td style={{ padding: "12px 16px", fontSize: "12px", color: "#9E9B94", fontFamily: "monospace" }}>{a.ip_address || "-"}</td>
                <td style={{ padding: "12px 16px" }}>
                  {a.accepted_at
                    ? <span style={{ background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0", padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700 }}>Signed</span>
                    : <span style={{ background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A", padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700 }}>Pending</span>
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Contacts & Notifications Tab ─────────────────────────────────────────────
const TRIGGERS = ["3_days_before","1_day_before","day_of","on_the_way","job_started","job_complete","scorecard_request","invoice_sent"];
const TRIGGER_LABELS: Record<string,string> = { "3_days_before":"3 Days Before","1_day_before":"1 Day Before","day_of":"Day Of","on_the_way":"On the Way","job_started":"Job Started","job_complete":"Job Complete","scorecard_request":"Scorecard Request","invoice_sent":"Invoice Sent" };

function ContactsTab({ clientId, notifications, refetch }: { clientId: number; notifications: any[]; refetch: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ contact_value: "", contact_type: "email", triggers: [] as string[] });
  const [editing, setEditing] = useState<number | null>(null);

  const createMut = useMutation({
    mutationFn: (data: any) => apiFetch(`/api/clients/${clientId}/notifications`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { refetch(); setShowForm(false); setForm({ contact_value: "", contact_type: "email", triggers: [] }); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/clients/${clientId}/notifications/${id}`, { method: "DELETE" }),
    onSuccess: () => refetch(),
  });

  const toggleTrigger = (t: string) =>
    setForm(f => ({ ...f, triggers: f.triggers.includes(t) ? f.triggers.filter(x => x !== t) : [...f.triggers, t] }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => setShowForm(true)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: "8px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
          <Plus size={13} /> Create Notification
        </button>
      </div>

      {showForm && (
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
          <h3 style={{ margin: "0 0 14px", fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>Add Notification Contact</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: "10px" }}>
              <div>
                <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Contact Info</label>
                <input value={form.contact_value} onChange={e => setForm(f => ({ ...f, contact_value: e.target.value }))} placeholder="email@example.com or +1 555-0100"
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Type</label>
                <select value={form.contact_type} onChange={e => setForm(f => ({ ...f, contact_type: e.target.value }))} style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", background: "#FFFFFF" }}>
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                </select>
              </div>
            </div>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "8px" }}>Notification Triggers</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {TRIGGERS.map(t => (
                  <button key={t} onClick={() => toggleTrigger(t)} style={{ padding: "5px 10px", border: `1px solid ${form.triggers.includes(t) ? "var(--brand)" : "#E5E2DC"}`, borderRadius: "20px", background: form.triggers.includes(t) ? "var(--brand-dim)" : "#FFFFFF", color: form.triggers.includes(t) ? "var(--brand)" : "#6B7280", fontSize: "12px", fontWeight: form.triggers.includes(t) ? 600 : 400, cursor: "pointer" }}>
                    {TRIGGER_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => setShowForm(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending} style={{ padding: "8px 16px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Save</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
        {notifications.length === 0 ? (
          <div style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>No notification contacts configured</div>
        ) : notifications.map(n => (
          <div key={n.id} style={{ padding: "16px 20px", borderBottom: "1px solid #F0EEE9", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                {n.contact_type === "email" ? <Mail size={13} style={{ color: "#9E9B94" }} /> : <Phone size={13} style={{ color: "#9E9B94" }} />}
                <span style={{ fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>{n.contact_value}</span>
                <span style={{ fontSize: "10px", fontWeight: 600, color: "#9E9B94", background: "#F3F4F6", padding: "2px 6px", borderRadius: "3px", textTransform: "uppercase" }}>{n.contact_type}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                {(n.triggers || []).map((t: string) => (
                  <span key={t} style={{ background: "var(--brand-dim)", color: "var(--brand)", padding: "2px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: 500 }}>{TRIGGER_LABELS[t] || t}</span>
                ))}
              </div>
            </div>
            <button onClick={() => deleteMut.mutate(n.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: "4px" }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Scorecards Tab ────────────────────────────────────────────────────────────
function ScorecardsTab({ scorecards }: { scorecards: any[] }) {
  const scoreInfo: Record<number, { label: string; style: React.CSSProperties }> = {
    4: { label: "Excellent", style: { background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0" } },
    3: { label: "Good - Keep it up", style: { background: "#DBEAFE", color: "#1E40AF", border: "1px solid #BFDBFE" } },
    2: { label: "A Few Concerns", style: { background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A" } },
    1: { label: "Needs Improvement", style: { background: "#FFEDD5", color: "#9A3412", border: "1px solid #FED7AA" } },
    0: { label: "Unacceptable", style: { background: "#FEE2E2", color: "#991B1B", border: "1px solid #FECACA" } },
  };
  const TH: React.CSSProperties = { padding: "10px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #EEECE7" };
  return (
    <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ backgroundColor: "#FAFAF8" }}>
          {["Job Date","Score","Technician","Comments","Actions"].map(h => <th key={h} style={TH}>{h}</th>)}
        </tr></thead>
        <tbody>
          {scorecards.length === 0 ? (
            <tr><td colSpan={5} style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>No scorecards yet</td></tr>
          ) : scorecards.map(sc => {
            const info = scoreInfo[sc.score] || scoreInfo[0];
            return (
              <tr key={sc.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280" }}>{fmtDate(sc.scheduled_date || sc.created_at)}</td>
                <td style={{ padding: "12px 16px" }}>
                  <span style={{ ...info.style, padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700, whiteSpace: "nowrap" }}>{sc.score}/4 — {info.label}</span>
                </td>
                <td style={{ padding: "12px 16px", fontSize: "13px", color: "#1A1917" }}>{sc.first_name} {sc.last_name}</td>
                <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280", maxWidth: "250px" }}>{sc.comments || "-"}</td>
                <td style={{ padding: "12px 16px" }}>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button style={{ fontSize: "11px", color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Add to Testimonials</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tech Preferences Tab ──────────────────────────────────────────────────────
function TechPrefsTab({ clientId, prefs, refetch }: { clientId: number; prefs: any[]; refetch: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ user_id: "", preference: "preferred", notes: "" });

  const { data: employees } = useQuery<any[]>({
    queryKey: ["employees"],
    queryFn: () => apiFetch("/api/users"),
    staleTime: 60000,
  });

  const createMut = useMutation({
    mutationFn: (data: any) => apiFetch(`/api/clients/${clientId}/tech-preferences`, { method: "POST", body: JSON.stringify({ ...data, user_id: parseInt(data.user_id) }) }),
    onSuccess: () => { refetch(); setShowForm(false); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/clients/${clientId}/tech-preferences/${id}`, { method: "DELETE" }),
    onSuccess: () => refetch(),
  });

  const prefStyle: Record<string, React.CSSProperties> = {
    preferred: { background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0" },
    do_not_schedule: { background: "#FEE2E2", color: "#991B1B", border: "1px solid #FECACA" },
    neutral: { background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB" },
  };
  const prefLabels: Record<string, string> = { preferred: "Preferred", do_not_schedule: "Do Not Schedule", neutral: "Neutral" };

  const TH: React.CSSProperties = { padding: "10px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #EEECE7" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ backgroundColor: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: "8px", padding: "12px", display: "flex", alignItems: "flex-start", gap: "8px" }}>
        <AlertTriangle size={14} style={{ color: "#F59E0B", flexShrink: 0, marginTop: "1px" }} />
        <p style={{ margin: 0, fontSize: "12px", color: "#78350F" }}>
          Do Not Schedule preferences are enforced on the dispatch board. A warning will appear before assigning a flagged technician to this client.
        </p>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => setShowForm(true)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: "8px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
          <Plus size={13} /> Create Preference
        </button>
      </div>

      {showForm && (
        <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
          <h3 style={{ margin: "0 0 14px", fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>Add Technician Preference</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Technician</label>
              <select value={form.user_id} onChange={e => setForm(f => ({ ...f, user_id: e.target.value }))} style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", background: "#FFFFFF" }}>
                <option value="">Select technician...</option>
                {(employees || []).filter((e: any) => e.role === "technician").map((e: any) => (
                  <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Preference</label>
              <select value={form.preference} onChange={e => setForm(f => ({ ...f, preference: e.target.value }))} style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", background: "#FFFFFF" }}>
                <option value="preferred">Preferred</option>
                <option value="do_not_schedule">Do Not Schedule</option>
                <option value="neutral">Neutral</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#6B7280", display: "block", marginBottom: "4px" }}>Notes (optional)</label>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Reason or details"
                style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", boxSizing: "border-box" }} />
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => setShowForm(false)} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => createMut.mutate(form)} disabled={createMut.isPending || !form.user_id} style={{ padding: "8px 16px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Save</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ backgroundColor: "#FAFAF8" }}>
            {["Technician","Preference","Notes","Actions"].map(h => <th key={h} style={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {prefs.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>No preferences set</td></tr>
            ) : prefs.map(p => (
              <tr key={p.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                <td style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>{p.first_name} {p.last_name}</td>
                <td style={{ padding: "12px 16px" }}>
                  <span style={{ ...(prefStyle[p.preference] || prefStyle.neutral), padding: "3px 10px", borderRadius: "4px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {prefLabels[p.preference] || p.preference}
                  </span>
                </td>
                <td style={{ padding: "12px 16px", fontSize: "12px", color: "#6B7280" }}>{p.notes || "-"}</td>
                <td style={{ padding: "12px 16px" }}>
                  <button onClick={() => deleteMut.mutate(p.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Notes Tab ─────────────────────────────────────────────────────────────────
function NotesTab({ clientId, client }: { clientId: number; client: any }) {
  const [filter, setFilter] = useState<string>("all");
  const [compose, setCompose] = useState<"sms" | "email" | "note" | null>(null);
  const [smsBody, setSmsBody] = useState(""); const [emailSubject, setEmailSubject] = useState(""); const [emailBody, setEmailBody] = useState(""); const [noteBody, setNoteBody] = useState("");
  const qc = useQueryClient();

  const { data: comms = [], isLoading } = useQuery<any[]>({
    queryKey: ["client-comms", clientId, filter],
    queryFn: () => apiFetch(`/api/clients/${clientId}/communications${filter !== "all" ? `?type=${filter}` : ""}`),
    staleTime: 10000,
  });

  const smsMut = useMutation({ mutationFn: () => apiFetch(`/api/clients/${clientId}/communications/sms`, { method: "POST", body: JSON.stringify({ to: client.phone, message: smsBody }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["client-comms", clientId] }); setCompose(null); setSmsBody(""); } });
  const emailMut = useMutation({ mutationFn: () => apiFetch(`/api/clients/${clientId}/communications/email`, { method: "POST", body: JSON.stringify({ to: client.email, subject: emailSubject, body: emailBody }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["client-comms", clientId] }); setCompose(null); setEmailBody(""); setEmailSubject(""); } });
  const noteMut = useMutation({ mutationFn: () => apiFetch(`/api/clients/${clientId}/communications/note`, { method: "POST", body: JSON.stringify({ body: noteBody }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["client-comms", clientId] }); setCompose(null); setNoteBody(""); } });

  const typeIcon: Record<string, { icon: any; color: string }> = {
    sms: { icon: MessageSquare, color: "#5B9BD5" },
    email: { icon: Mail, color: "#5B9BD5" },
    note: { icon: StickyNote, color: "#92400E" },
    system: { icon: Check, color: "#9E9B94" },
    call_log: { icon: Phone, color: "#16A34A" },
    portal_activity: { icon: Globe, color: "#7C3AED" },
  };

  const directionLabel: Record<string, string> = { inbound: "Inbound", outbound: "Outbound", internal: "Internal" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* Compose bar */}
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "16px" }}>
        <div style={{ display: "flex", gap: "8px", marginBottom: compose ? "14px" : 0 }}>
          <button onClick={() => setCompose(compose === "sms" ? null : "sms")} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", border: `1px solid ${compose === "sms" ? "var(--brand)" : "#E5E2DC"}`, borderRadius: "8px", background: compose === "sms" ? "var(--brand-dim)" : "#FFFFFF", color: compose === "sms" ? "var(--brand)" : "#1A1917", fontSize: "13px", cursor: "pointer" }}>
            <MessageSquare size={13} /> Send SMS
          </button>
          <button onClick={() => setCompose(compose === "email" ? null : "email")} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", border: `1px solid ${compose === "email" ? "var(--brand)" : "#E5E2DC"}`, borderRadius: "8px", background: compose === "email" ? "var(--brand-dim)" : "#FFFFFF", color: compose === "email" ? "var(--brand)" : "#1A1917", fontSize: "13px", cursor: "pointer" }}>
            <Mail size={13} /> Send Email
          </button>
          <button onClick={() => setCompose(compose === "note" ? null : "note")} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", border: `1px solid ${compose === "note" ? "var(--brand)" : "#E5E2DC"}`, borderRadius: "8px", background: compose === "note" ? "var(--brand-dim)" : "#FFFFFF", color: compose === "note" ? "var(--brand)" : "#1A1917", fontSize: "13px", cursor: "pointer" }}>
            <StickyNote size={13} /> Add Note
          </button>
        </div>

        {compose === "sms" && (
          <div style={{ borderTop: "1px solid #F0EEE9", paddingTop: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ fontSize: "12px", color: "#6B7280" }}>To: <strong style={{ color: "#1A1917" }}>{client.phone || "No phone on file"}</strong></div>
            <textarea value={smsBody} onChange={e => setSmsBody(e.target.value)} placeholder="Type your message..." rows={3}
              style={{ width: "100%", padding: "10px", border: "1px solid #E5E2DC", borderRadius: "8px", fontSize: "13px", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setCompose(null)} style={{ padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => smsMut.mutate()} disabled={!smsBody || smsMut.isPending} style={{ padding: "7px 14px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Send SMS</button>
            </div>
          </div>
        )}
        {compose === "email" && (
          <div style={{ borderTop: "1px solid #F0EEE9", paddingTop: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ fontSize: "12px", color: "#6B7280" }}>To: <strong style={{ color: "#1A1917" }}>{client.email || "No email on file"}</strong></div>
            <input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} placeholder="Subject"
              style={{ width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", outline: "none", boxSizing: "border-box" }} />
            <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} placeholder="Message..." rows={4}
              style={{ width: "100%", padding: "10px", border: "1px solid #E5E2DC", borderRadius: "8px", fontSize: "13px", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setCompose(null)} style={{ padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => emailMut.mutate()} disabled={!emailBody || emailMut.isPending} style={{ padding: "7px 14px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Send Email</button>
            </div>
          </div>
        )}
        {compose === "note" && (
          <div style={{ borderTop: "1px solid #F0EEE9", paddingTop: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ fontSize: "12px", color: "#6B7280" }}>Internal note — visible to staff only</div>
            <textarea value={noteBody} onChange={e => setNoteBody(e.target.value)} placeholder="Type your note..." rows={3}
              style={{ width: "100%", padding: "10px", border: "1px solid #E5E2DC", borderRadius: "8px", fontSize: "13px", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setCompose(null)} style={{ padding: "7px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => noteMut.mutate()} disabled={!noteBody || noteMut.isPending} style={{ padding: "7px 14px", background: "#1A1917", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Save Note</button>
            </div>
          </div>
        )}
      </div>

      {/* Filter */}
      <div style={{ display: "flex", gap: "4px", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: "8px", padding: "3px", width: "fit-content" }}>
        {["all","sms","email","note","system"].map(f => {
          const active = filter === f;
          return (
            <button key={f} onClick={() => setFilter(f)} style={{ padding: "5px 12px", border: `1px solid ${active ? "var(--brand)" : "transparent"}`, borderRadius: "6px", backgroundColor: active ? "var(--brand-dim)" : "transparent", color: active ? "var(--brand)" : "#6B7280", fontSize: "12px", fontWeight: active ? 600 : 400, cursor: "pointer" }}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          );
        })}
      </div>

      {/* Timeline */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {isLoading ? (
          <div style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>Loading communications...</div>
        ) : comms.length === 0 ? (
          <div style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px", backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px" }}>No communications logged yet</div>
        ) : comms.map((c: any) => {
          const ti = typeIcon[c.type] || typeIcon.system;
          const Icon = ti.icon;
          return (
            <div key={c.id} style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "8px", padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: c.type === "note" ? "#FEF3C7" : "var(--brand-dim)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon size={13} style={{ color: ti.color }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "12px", fontWeight: 700, color: "#1A1917", textTransform: "capitalize" }}>{c.type}</span>
                    {c.direction && <span style={{ fontSize: "11px", color: "#9E9B94" }}>— {directionLabel[c.direction] || c.direction}</span>}
                    <span style={{ fontSize: "11px", color: "#9E9B94", marginLeft: "auto" }}>{new Date(c.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    {(c.sent_by_first || c.from_name) && <span style={{ fontSize: "11px", color: "#9E9B94" }}>by {c.sent_by_first ? `${c.sent_by_first} ${c.sent_by_last || ""}`.trim() : c.from_name}</span>}
                  </div>
                  {c.to_contact && <div style={{ fontSize: "11px", color: "#9E9B94", marginTop: "2px" }}>To: {c.to_contact}</div>}
                </div>
              </div>
              {c.subject && <p style={{ margin: "0 0 4px", fontSize: "12px", fontWeight: 700, color: "#1A1917" }}>{c.subject}</p>}
              <p style={{ margin: 0, fontSize: "13px", color: c.type === "note" ? "#1A1917" : "#6B7280", lineHeight: 1.5 }}>{c.body}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Card on File Tab ─────────────────────────────────────────────────────────
function CardOnFileTab({ client, refetch }: { client: any; refetch: () => void }) {
  const [sending, setSending] = useState<"email" | "sms" | null>(null);
  const [sent, setSent] = useState<"email" | "sms" | null>(null);
  const [togglingAutoCharge, setTogglingAutoCharge] = useState(false);

  const FF = "'Plus Jakarta Sans', sans-serif";
  const hasCard = !!client.card_last_four;
  const brandIcon = client.card_brand ? client.card_brand.charAt(0).toUpperCase() + client.card_brand.slice(1) : "Card";

  async function sendCardLink(channel: "email" | "sms") {
    setSending(channel);
    try {
      const res = await fetch(`${API}/api/payment-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          client_id: client.id,
          purpose: "save_card",
          send_email: channel === "email",
          send_sms: channel === "sms",
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to send link");
      } else {
        setSent(channel);
        setTimeout(() => setSent(null), 3000);
      }
    } catch {
      alert("Network error — please try again");
    } finally {
      setSending(null);
    }
  }

  async function toggleAutoCharge() {
    setTogglingAutoCharge(true);
    try {
      await fetch(`${API}/api/clients/${client.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ auto_charge: !client.auto_charge }),
      });
      refetch();
    } finally {
      setTogglingAutoCharge(false);
    }
  }

  async function removeCard() {
    if (!confirm("Remove card on file? This cannot be undone.")) return;
    await fetch(`${API}/api/clients/${client.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ card_last_four: null, card_brand: null, card_expiry: null, card_saved_at: null }),
    });
    refetch();
  }

  return (
    <div style={{ padding: "0 0 24px" }}>
      {/* Card status */}
      <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px", marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#1A1917", marginBottom: 16, fontFamily: FF }}>Payment Method</div>

        {hasCard ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, background: "#059669", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <CreditCard size={18} color="#fff" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: "#1A1917", fontFamily: FF }}>
                  {brandIcon} •••• {client.card_last_four}
                  {client.card_expiry && <span style={{ marginLeft: 8, fontWeight: 400, color: "#6B7280", fontSize: 12 }}>expires {client.card_expiry}</span>}
                </div>
                {client.card_saved_at && (
                  <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF, marginTop: 2 }}>
                    Saved {new Date(client.card_saved_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </div>
                )}
              </div>
              <button onClick={removeCard} style={{ fontSize: 12, color: "#DC2626", background: "none", border: "none", cursor: "pointer", fontFamily: FF, textDecoration: "underline" }}>
                Remove
              </button>
            </div>

            {/* Auto-charge toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "#F7F6F3", borderRadius: 8, marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "#1A1917", fontFamily: FF }}>Auto-charge on invoice creation</div>
                <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF, marginTop: 2 }}>Automatically charges this card when an invoice is created</div>
              </div>
              <button
                onClick={toggleAutoCharge}
                disabled={togglingAutoCharge}
                style={{
                  width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
                  background: client.auto_charge ? "var(--brand)" : "#D1D5DB",
                  position: "relative", transition: "background 0.2s", flexShrink: 0,
                }}
              >
                <span style={{
                  position: "absolute", top: 2, left: client.auto_charge ? 22 : 2,
                  width: 20, height: 20, borderRadius: "50%", background: "#fff",
                  transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                }} />
              </button>
            </div>

            {/* Send new link */}
            <div style={{ fontSize: 12, color: "#6B7280", fontFamily: FF, marginBottom: 8 }}>Send a new card link to update the saved method:</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => sendCardLink("email")}
                disabled={!!sending}
                style={{ flex: 1, padding: "10px 0", background: "#fff", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FF, color: sending === "email" ? "#9E9B94" : "#1A1917" }}
              >
                {sent === "email" ? "Sent!" : sending === "email" ? "Sending..." : "Send New Link via Email"}
              </button>
              <button
                onClick={() => sendCardLink("sms")}
                disabled={!!sending}
                style={{ flex: 1, padding: "10px 0", background: "#fff", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FF, color: sending === "sms" ? "#9E9B94" : "#1A1917" }}
              >
                {sent === "sms" ? "Sent!" : sending === "sms" ? "Sending..." : "Send New Link via SMS"}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, background: "#E5E2DC", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <CreditCard size={18} color="#9E9B94" />
              </div>
              <div style={{ fontSize: 13, color: "#6B7280", fontFamily: FF }}>No payment method saved</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => sendCardLink("email")}
                disabled={!!sending}
                style={{ flex: 1, padding: "11px 0", background: "var(--brand)", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF, color: "#fff" }}
              >
                {sent === "email" ? "Sent!" : sending === "email" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : "Send Card Link via Email"}
              </button>
              <button
                onClick={() => sendCardLink("sms")}
                disabled={!!sending}
                title={!client.phone ? "No phone on file" : ""}
                style={{ flex: 1, padding: "11px 0", background: "#fff", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: client.phone ? "pointer" : "not-allowed", fontFamily: FF, color: client.phone ? "#1A1917" : "#9E9B94" }}
              >
                {sent === "sms" ? "Sent!" : sending === "sms" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : "Send Card Link via SMS"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Commercial billing info */}
      {client.client_type === "commercial" && (
        <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#1A1917", marginBottom: 16, fontFamily: FF }}>Billing Settings</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 13 }}>
            <div>
              <div style={{ color: "#6B7280", marginBottom: 3, fontFamily: FF }}>Payment Terms</div>
              <div style={{ fontWeight: 600, color: "#1A1917", fontFamily: FF }}>
                {client.payment_terms === "net_30" ? "NET 30" : client.payment_terms === "net_15" ? "NET 15" : "Due on Receipt"}
              </div>
            </div>
            <div>
              <div style={{ color: "#6B7280", marginBottom: 3, fontFamily: FF }}>PO Required</div>
              <div style={{ fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{client.po_number_required ? "Yes" : "No"}</div>
            </div>
            {client.billing_contact_name && (
              <div>
                <div style={{ color: "#6B7280", marginBottom: 3, fontFamily: FF }}>Billing Contact</div>
                <div style={{ fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{client.billing_contact_name}</div>
              </div>
            )}
            {client.billing_contact_email && (
              <div>
                <div style={{ color: "#6B7280", marginBottom: 3, fontFamily: FF }}>Billing Email</div>
                <div style={{ fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{client.billing_contact_email}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Portal Account Tab ────────────────────────────────────────────────────────
function PortalTab({ clientId, client, onPortalInvite, refetch }: { clientId: number; client: any; onPortalInvite: () => void; refetch: () => void }) {
  const portalStatus = client.portal_access ? "registered" : client.portal_invite_sent_at ? "invited" : "none";

  const deactivateMut = useMutation({
    mutationFn: () => apiFetch(`/api/clients/${clientId}`, { method: "PUT", body: JSON.stringify({ portal_access: false, portal_invite_sent_at: null }) }),
    onSuccess: () => refetch(),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "24px" }}>
        {portalStatus === "registered" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
              <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "#DCFCE7", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Globe size={18} style={{ color: "#16A34A" }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1A1917" }}>Active Portal Account</h3>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#6B7280" }}>Client can log in and manage their account</p>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
              <div style={{ display: "flex", gap: "12px" }}>
                <span style={{ fontSize: "12px", color: "#9E9B94", minWidth: "100px" }}>Email:</span>
                <span style={{ fontSize: "12px", fontWeight: 600, color: "#1A1917" }}>{client.email}</span>
              </div>
              {client.portal_last_login && (
                <div style={{ display: "flex", gap: "12px" }}>
                  <span style={{ fontSize: "12px", color: "#9E9B94", minWidth: "100px" }}>Last Login:</span>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "#1A1917" }}>{fmtDate(client.portal_last_login)}</span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button style={{ padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#1A1917", fontSize: "13px", cursor: "pointer" }}>Send Password Reset</button>
              <button onClick={() => deactivateMut.mutate()} style={{ padding: "8px 14px", border: "1px solid #FEE2E2", borderRadius: "7px", background: "#FFFFFF", color: "#991B1B", fontSize: "13px", cursor: "pointer" }}>Deactivate Portal Access</button>
            </div>
          </div>
        )}

        {portalStatus === "invited" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
              <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "#FEF3C7", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Send size={18} style={{ color: "#F59E0B" }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1A1917" }}>Invitation Pending</h3>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#6B7280" }}>Invitation sent {fmtDate(client.portal_invite_sent_at)} — client has not registered yet</p>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={onPortalInvite} style={{ padding: "8px 14px", background: "var(--brand)", border: "none", borderRadius: "7px", color: "#FFFFFF", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Resend Invitation</button>
              <button style={{ padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: "7px", background: "#FFFFFF", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>Cancel Invitation</button>
            </div>
          </div>
        )}

        {portalStatus === "none" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
              <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: "#F3F4F6", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Globe size={18} style={{ color: "#9E9B94" }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1A1917" }}>No Portal Access</h3>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#6B7280" }}>Client does not have a portal account</p>
              </div>
            </div>
            <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#6B7280" }}>
              Sending a portal invitation will email the client with a link to create their account. They will be able to view job history, upcoming appointments, and manage their profile.
            </p>
            <button onClick={onPortalInvite} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px 18px", background: "var(--brand)", border: "none", borderRadius: "8px", color: "#FFFFFF", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}>
              <Send size={14} /> Send Portal Invitation
            </button>
          </div>
        )}
      </div>

      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>Portal Preview</h3>
        <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#6B7280" }}>Open the client portal view to see exactly what this client sees when they log in.</p>
        <button style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: "8px", background: "#FFFFFF", color: "#1A1917", fontSize: "13px", cursor: "pointer" }}>
          <Globe size={13} /> View as Client
        </button>
      </div>
    </div>
  );
}

// ─── Main Profile Page ─────────────────────────────────────────────────────────
export default function CustomerProfilePage() {
  const [, navigate] = useLocation();
  const [match, params] = useRoute("/customers/:id");
  const clientId = parseInt(params?.id || "0");
  const [tab, setTab] = useState<TabId>("overview");
  const qc = useQueryClient();

  const { data: profile, isLoading, refetch } = useQuery<any>({
    queryKey: ["client-profile", clientId],
    queryFn: () => apiFetch(`/api/clients/${clientId}/full-profile`),
    enabled: clientId > 0,
    staleTime: 15000,
  });

  const { data: agreements = [], refetch: refetchAgreements } = useQuery<any[]>({
    queryKey: ["client-agreements", clientId],
    queryFn: () => apiFetch(`/api/clients/${clientId}/agreements`),
    enabled: clientId > 0,
    staleTime: 15000,
  });

  const updateMut = useMutation({
    mutationFn: (data: any) => apiFetch(`/api/clients/${clientId}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => refetch(),
  });

  const portalInviteMut = useMutation({
    mutationFn: () => apiFetch(`/api/clients/${clientId}/portal-invite`, { method: "POST" }),
    onSuccess: () => refetch(),
  });

  if (isLoading || !profile) {
    return (
      <DashboardLayout>
        <div style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>
          Loading client profile...
        </div>
      </DashboardLayout>
    );
  }

  const tabStyle = (id: TabId): React.CSSProperties => ({
    padding: "9px 14px", border: "none", background: "none", cursor: "pointer",
    fontSize: "13px", fontWeight: tab === id ? 700 : 400,
    color: tab === id ? "var(--brand)" : "#6B7280",
    borderBottom: `2px solid ${tab === id ? "var(--brand)" : "transparent"}`,
    whiteSpace: "nowrap",
  });

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
        {/* Breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "20px" }}>
          <button onClick={() => navigate("/customers")} style={{ display: "flex", alignItems: "center", gap: "6px", background: "none", border: "none", cursor: "pointer", color: "#9E9B94", fontSize: "13px", padding: 0 }}>
            <ArrowLeft size={14} /> Clients
          </button>
          <span style={{ color: "#C4C0BB", fontSize: "13px" }}>/</span>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>{profile.first_name} {profile.last_name}</span>
        </div>

        {/* Two-column layout */}
        <div style={{ display: "flex", gap: "24px", alignItems: "flex-start" }}>
          {/* Left sidebar */}
          <ClientSidebar
            client={profile}
            stats={profile.stats}
            jobs={profile.jobs || []}
            onPortalInvite={() => portalInviteMut.mutate()}
          />

          {/* Right content */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Tab bar */}
            <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px 10px 0 0", borderBottom: "none", overflowX: "auto" }}>
              <div style={{ display: "flex", paddingLeft: "4px", borderBottom: "1px solid #E5E2DC" }}>
                {TABS.map(t => (
                  <button key={t.id} onClick={() => setTab(t.id)} style={tabStyle(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab content */}
            <div style={{ backgroundColor: tab === "overview" || tab === "billing" ? "transparent" : "transparent", padding: "20px 0 0" }}>
              {tab === "overview" && <OverviewTab client={profile} onUpdate={d => updateMut.mutateAsync(d)} refetch={refetch} />}
              {tab === "homes" && <HomesTab clientId={clientId} homes={profile.homes || []} refetch={refetch} />}
              {tab === "billing" && <BillingTab invoices={profile.invoices || []} />}
              {tab === "card-on-file" && <CardOnFileTab client={profile} refetch={refetch} />}
              {tab === "quotes" && <QuotesTab clientId={clientId} client={profile} />}
              {tab === "payments" && <PaymentsTab clientId={clientId} client={profile} />}
              {tab === "agreements" && <AgreementsTab clientId={clientId} agreements={agreements} refetch={() => { refetchAgreements(); refetch(); }} />}
              {tab === "attachments" && <AttachmentsTab clientId={clientId} />}
              {tab === "quickbooks" && <QuickBooksTab clientId={clientId} client={profile} refetch={refetch} />}
              {tab === "contacts" && <ContactsTab clientId={clientId} notifications={profile.notification_settings || []} refetch={refetch} />}
              {tab === "scorecards" && <ScorecardsTab scorecards={profile.scorecards || []} />}
              {tab === "tech" && <TechPrefsTab clientId={clientId} prefs={profile.tech_preferences || []} refetch={refetch} />}
              {tab === "notes" && <NotesTab clientId={clientId} client={profile} />}
              {tab === "portal" && <PortalTab clientId={clientId} client={profile} onPortalInvite={() => portalInviteMut.mutate()} refetch={refetch} />}
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
