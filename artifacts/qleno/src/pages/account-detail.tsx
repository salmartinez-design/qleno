import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import {
  Building2, ChevronLeft, ChevronDown, Plus, Pencil, Trash2, DollarSign,
  MapPin, Users, Phone, Mail, Star, Bell, BellOff, Briefcase,
  TrendingUp, AlertCircle, CheckCircle2, Clock, FileText,
  CreditCard, Home, Key, CalendarDays,
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { getAuthHeaders } from "@/lib/auth";
import { useAddressAutocomplete } from "@/hooks/use-address-autocomplete";
import { TeamPhotoNotes } from "@/components/team-photo-notes";
import { AccountJobsCalendar } from "@/components/account-jobs-calendar";
import { NotificationPreferenceGrid, buildPrefPayload, offsFromOverrides, allOffSet, type PrefData } from "@/components/notification-preference-grid";
import { useAddressAutocomplete } from "@/hooks/use-address-autocomplete";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const ACCOUNT_TYPES = [
  { value: "property_management", label: "Property Management" },
  { value: "commercial_office", label: "Commercial Office" },
  { value: "retail", label: "Retail" },
  { value: "other", label: "Other" },
];

const INVOICE_FREQ = [
  { value: "per_job", label: "Per Job" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

const PAYMENT_METHODS = [
  { value: "card_on_file", label: "Card on File" },
  { value: "check", label: "Check" },
  { value: "ach", label: "ACH" },
  { value: "invoice_only", label: "Invoice Only" },
];

const BILLING_METHODS = [
  { value: "hourly", label: "Hourly" },
  { value: "flat_rate", label: "Flat Rate" },
  { value: "per_unit", label: "Per Unit" },
];

const SERVICE_TYPES = [
  { value: "standard_cleaning", label: "Standard Cleaning" },
  { value: "deep_cleaning", label: "Deep Cleaning" },
  { value: "move_out_cleaning", label: "Move-Out Cleaning" },
  { value: "move_in_cleaning", label: "Move-In Cleaning" },
  { value: "window_cleaning", label: "Window Cleaning" },
  { value: "carpet_cleaning", label: "Carpet Cleaning" },
  { value: "pressure_washing", label: "Pressure Washing" },
  { value: "office_cleaning", label: "Office Cleaning" },
  { value: "common_area_cleaning", label: "Common Area Cleaning" },
  { value: "post_construction", label: "Post-Construction" },
  { value: "default", label: "Default (all services)" },
];

const PROPERTY_TYPES = [
  { value: "apartment_building", label: "Apartment Building" },
  { value: "condo", label: "Condo" },
  { value: "common_area", label: "Common Area" },
  { value: "office", label: "Office" },
  { value: "retail", label: "Retail" },
  { value: "other", label: "Other" },
];

const CONTACT_ROLES = [
  { value: "billing", label: "Billing" },
  { value: "operations", label: "Operations" },
  { value: "onsite", label: "On-Site" },
  { value: "property_manager", label: "Property Manager" },
  { value: "accountant", label: "Accountant" },
  { value: "other", label: "Other" },
];

type Tab = "overview" | "properties" | "rate_cards" | "contacts" | "calendar" | "jobs" | "invoices";

function fmt(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDecimal(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    scheduled: "bg-blue-50 text-blue-700",
    in_progress: "bg-amber-50 text-amber-700",
    complete: "bg-[#00C9A0]/10 text-[#00C9A0]",
    cancelled: "bg-gray-100 text-gray-500",
  };
  return map[status] ?? "bg-gray-100 text-gray-700";
}

function statusLabel(s: string) {
  const map: Record<string, string> = { scheduled: "Scheduled", in_progress: "In Progress", complete: "Complete", cancelled: "Cancelled" };
  return map[s] ?? s;
}

// [notif-prefs] Per-account control over which automated customer messages fire,
// per channel. Applies to every customer/job under the account — the granular
// companion to the master comms pause above it. When the master switch is OFF,
// nothing goes out regardless, so the grid is shown disabled with a note.
function AccountNotificationPreferences({ accountId, commsPaused }: { accountId: string; commsPaused: boolean }) {
  const { toast } = useToast();
  const [data, setData] = useState<PrefData | null>(null);
  const [offs, setOffs] = useState<Set<string>>(new Set());
  const [baseline, setBaseline] = useState<string>("");
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const r = await fetch(`${API}/api/accounts/${accountId}/notification-preferences`, { headers: getAuthHeaders() });
      if (!r.ok) return;
      const d: PrefData = await r.json();
      setData(d);
      const initial = offsFromOverrides(d.overrides || {});
      setOffs(initial);
      setBaseline(JSON.stringify([...initial].sort()));
    } catch {}
  }
  useEffect(() => { load(); }, [accountId]);

  if (!data) return null;
  const dirty = JSON.stringify([...offs].sort()) !== baseline;
  const toggle = (key: string) => setOffs((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  async function save() {
    if (!data) return;
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/accounts/${accountId}/notification-preferences`, {
        method: "PUT",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" } as Record<string, string>,
        body: JSON.stringify({ overrides: buildPrefPayload(data.catalog, offs) }),
      });
      if (!r.ok) throw new Error();
      setBaseline(JSON.stringify([...offs].sort()));
      toast({ title: "Notification preferences saved for this account" });
    } catch {
      toast({ title: "Failed to save notification preferences", variant: "destructive" });
    }
    setSaving(false);
  }

  return (
    <div className="space-y-3 pt-3 border-t border-gray-100">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <p className="text-sm font-medium text-[#0A0E1A]">Per-message preferences</p>
          <p className="text-xs text-gray-500 mt-0.5 max-w-md">Fine-tune which messages this account receives. Everything is on by default.</p>
        </div>
        {!commsPaused && (
          <div className="flex gap-2">
            <button onClick={() => setOffs(allOffSet(data.catalog))} className="px-3 py-1.5 text-xs font-semibold text-gray-500 border border-gray-200 rounded-md">Turn all off</button>
            <button onClick={() => setOffs(new Set())} className="px-3 py-1.5 text-xs font-semibold text-gray-500 border border-gray-200 rounded-md">Reset to all on</button>
          </div>
        )}
      </div>
      {commsPaused && (
        <p className="text-xs text-amber-600">All communications are paused above, so nothing goes out regardless of these settings. Resume to use per-message control.</p>
      )}
      <NotificationPreferenceGrid catalog={data.catalog} offs={offs} disabled={commsPaused} onToggle={toggle} />
      {!commsPaused && dirty && (
        <div className="flex justify-end gap-2">
          <button onClick={() => setOffs(offsFromOverrides(data.overrides || {}))} className="px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-md">Cancel</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-semibold text-white bg-[#00C9A0] rounded-md">{saving ? "Saving…" : "Save preferences"}</button>
        </div>
      )}
    </div>
  );
}

export default function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();

  const [account, setAccount] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [upcoming, setUpcoming] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Expandable property cards — click to drop down details + last service.
  const [expandedProp, setExpandedProp] = useState<number | null>(null);
  const [propRecent, setPropRecent] = useState<Record<number, any>>({});
  const [tab, setTab] = useState<Tab>("overview");
  // [account-calendar 2026-07-07] Property preselected on the Calendar tab —
  // the "View calendar" button on a building's detail card jumps here with
  // that building filtered, so each property gets its own calendar.
  const [calendarPropId, setCalendarPropId] = useState<number | null>(null);
  // [commercial-console] Properties grouped by zone + searchable so big
  // portfolios (PPM has 45 buildings) read as a few neighborhoods, not an
  // endless scroll. First slice of the master-detail console.
  const [propSearch, setPropSearch] = useState("");
  const [collapsedZones, setCollapsedZones] = useState<Set<string>>(new Set());
  // [commercial-console slice 3] Pivot the building list by zone / service / tech,
  // and a one-tap filter to the buildings with an unassigned upcoming visit.
  const [pivot, setPivot] = useState<"zone" | "service" | "tech">("zone");
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);

  // [building-notes 2026-07-01] Per-building permanent Office + Cleaner notes,
  // edited inline on the property detail. Office Notes → property.notes,
  // Cleaner Notes → property.access_notes (both office-editable via the property
  // PATCH). The backend pre-fills every job's note boxes for the building and
  // pushes edits to future jobs, so the office stops copy-pasting.
  const [bnEditProp, setBnEditProp] = useState<number | null>(null);
  const [bnOffice, setBnOffice] = useState("");
  const [bnCleaner, setBnCleaner] = useState("");
  const [bnSaving, setBnSaving] = useState(false);
  async function saveBuildingNotes(propId: number) {
    setBnSaving(true);
    try {
      const r = await fetch(`${API}/api/accounts/${id}/properties/${propId}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" } as Record<string, string>,
        body: JSON.stringify({ notes: bnOffice.trim() ? bnOffice : null, access_notes: bnCleaner.trim() ? bnCleaner : null }),
      });
      if (!r.ok) throw new Error("Failed to save notes");
      setBnEditProp(null);
      await load();
    } catch { /* keep editor open on failure */ }
    finally { setBnSaving(false); }
  }

  // Rate card
  const [showRateCard, setShowRateCard] = useState(false);
  const [editCard, setEditCard] = useState<any>(null);
  const [rcForm, setRcForm] = useState({ service_type: "standard_cleaning", billing_method: "hourly", rate_amount: "", unit_label: "hr", notes: "" });
  const [rcSaving, setRcSaving] = useState(false);

  // Property
  const [showProperty, setShowProperty] = useState(false);
  const [editProp, setEditProp] = useState<any>(null);
  const [propForm, setPropForm] = useState({ property_name: "", address: "", city: "", state: "IL", zip: "", unit_count: "", property_type: "apartment_building", default_service_type: "", access_notes: "", notes: "" });
  const propAddrRef = useRef<HTMLInputElement>(null);
  useAddressAutocomplete(propAddrRef, showProperty, (p) =>
    setPropForm((f) => ({
      ...f,
      address: p.street || f.address,
      city: p.city || f.city,
      state: p.state || f.state,
      zip: p.zip || f.zip,
    })),
  );
  const [propSaving, setPropSaving] = useState(false);

  // Contact
  const [showContact, setShowContact] = useState(false);
  const [editContact, setEditContact] = useState<any>(null);
  const [contactForm, setContactForm] = useState({
    name: "", role: "operations", email: "", phone: "",
    receives_invoices: false, receives_receipts: false,
    receives_on_way_sms: false, receives_completion_notifications: false,
    is_primary: false, notes: "",
  });
  const [contactSaving, setContactSaving] = useState(false);

  // [account-billing-edit 2026-07-03] Edit the account's billing settings
  // (payment method / invoice frequency / payment terms / auto-charge) from the
  // Overview. Maribel: "we should be able to edit too." Backend PATCH already
  // accepts these; this is the missing UI.
  const [showBilling, setShowBilling] = useState(false);
  const [billingSaving, setBillingSaving] = useState(false);
  const [billingForm, setBillingForm] = useState<any>({
    payment_method: "invoice_only", invoice_frequency: "monthly",
    payment_terms_days: 0, auto_charge_on_completion: false,
  });
  function openBilling() {
    setBillingForm({
      payment_method: account.payment_method ?? "invoice_only",
      invoice_frequency: account.invoice_frequency ?? "monthly",
      payment_terms_days: account.payment_terms_days ?? 0,
      auto_charge_on_completion: !!account.auto_charge_on_completion,
    });
    setShowBilling(true);
  }
  async function saveBilling() {
    setBillingSaving(true);
    try {
      const r = await fetch(`${API}/api/accounts/${id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" } as Record<string, string>,
        body: JSON.stringify({
          payment_method: billingForm.payment_method,
          invoice_frequency: billingForm.invoice_frequency,
          payment_terms_days: Number(billingForm.payment_terms_days) || 0,
          auto_charge_on_completion: !!billingForm.auto_charge_on_completion,
        }),
      });
      if (!r.ok) throw new Error();
      const updated = await r.json();
      setAccount((prev: any) => ({ ...prev, ...updated }));
      toast({ title: "Billing settings updated" });
      setShowBilling(false);
    } catch {
      toast({ title: "Failed to update billing settings", variant: "destructive" });
    }
    setBillingSaving(false);
  }

  // Invoice generation
  const [generatingInvoice, setGeneratingInvoice] = useState(false);
  // [account-batch 2026-07-02] Selectable consolidation — pick which visits
  // (Mon/Tue/…) roll into one invoice. Empty selection = all uninvoiced
  // (legacy behavior). includeScheduled surfaces upcoming visits to pre-bill.
  const [selectedJobIds, setSelectedJobIds] = useState<Set<number>>(new Set());
  const [includeScheduled, setIncludeScheduled] = useState(false);
  // [pre-bill-month 2026-07-03] When pre-bill is on the recurring horizon dumps
  // every future visit (KMA = 47 rows to December). Scope the Uninvoiced Jobs
  // list to one service month so the office bills "July's visits" cleanly.
  // Only applied while pre-bill is on (completed-only list is short and must
  // never hide billable work by month). Defaults to the current month.
  const [jobsMonth, setJobsMonth] = useState(() => new Date().toISOString().slice(0, 7)); // YYYY-MM
  function shiftJobsMonth(delta: number) {
    const [y, m] = jobsMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setJobsMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    setSelectedJobIds(new Set()); // avoid carrying a selection across a hidden month
  }
  const jobsMonthLabel = (() => {
    const [y, m] = jobsMonth.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  })();
  // [account-invoices-month 2026-07-02] Month-filterable invoice list PPM asked for.
  const [invMonth, setInvMonth] = useState(() => new Date().toISOString().slice(0, 7)); // YYYY-MM
  const [acctInvoices, setAcctInvoices] = useState<any[]>([]);
  const [acctInvTotal, setAcctInvTotal] = useState("0.00");
  const [invLoading, setInvLoading] = useState(false);
  useEffect(() => {
    if (tab !== "invoices" || !id) return;
    setInvLoading(true);
    fetch(`${API}/api/accounts/${id}/invoices?month=${invMonth}`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : { data: [], total: "0.00" })
      .then(d => { setAcctInvoices(d.data || []); setAcctInvTotal(d.total || "0.00"); })
      .catch(() => { setAcctInvoices([]); setAcctInvTotal("0.00"); })
      .finally(() => setInvLoading(false));
  }, [tab, id, invMonth]);
  function shiftMonth(delta: number) {
    const [y, m] = invMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setInvMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const monthLabel = (() => {
    const [y, m] = invMonth.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  })();

  async function load() {
    try {
      const ymd = (d: Date) => d.toISOString().slice(0, 10);
      const today = new Date();
      const to = new Date(today.getTime() + 30 * 86400000);
      // [pre-bill-month 2026-07-03] Only constrain by month while pre-billing —
      // the completed-only list must never hide billable work by month.
      const monthParam = includeScheduled ? `&month=${jobsMonth}` : "";
      const [accR, jobsR, upR] = await Promise.all([
        fetch(`${API}/api/accounts/${id}`, { headers: getAuthHeaders() }),
        fetch(`${API}/api/accounts/${id}/uninvoiced-jobs?include_scheduled=${includeScheduled}${monthParam}`, { headers: getAuthHeaders() }),
        fetch(`${API}/api/accounts/${id}/jobs-calendar?from=${ymd(today)}&to=${ymd(to)}`, { headers: getAuthHeaders() }),
      ]);
      if (accR.ok) setAccount(await accR.json());
      if (jobsR.ok) setJobs(await jobsR.json());
      if (upR.ok) {
        const all = await upR.json();
        const up = (Array.isArray(all) ? all : [])
          .filter((j: any) => j.status === "scheduled")
          .sort((a: any, b: any) => `${a.scheduled_date}${a.scheduled_time || ""}`.localeCompare(`${b.scheduled_date}${b.scheduled_time || ""}`))
          .slice(0, 8);
        setUpcoming(up);
      }
    } catch {}
    setLoading(false);
  }

  useEffect(() => { load(); }, [id, includeScheduled, jobsMonth]);

  // [account-comms-toggle] Pause/resume ALL automated SMS+email for this account's
  // customers (reminders, on-my-way, completion, receipts, review requests).
  // Optimistic; reverts on failure. Manual invoice sends are unaffected.
  async function toggleComms(next: boolean) {
    if (!account) return;
    const prev = account.comms_enabled;
    setAccount({ ...account, comms_enabled: next });
    try {
      const r = await fetch(`${API}/api/accounts/${id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" } as Record<string, string>,
        body: JSON.stringify({ comms_enabled: next }),
      });
      if (!r.ok) throw new Error();
      toast({ title: next ? "Communications resumed for this account" : "Communications paused — no automated texts/emails to this account's customers" });
    } catch {
      setAccount({ ...account, comms_enabled: prev });
      toast({ title: "Failed to update communications setting", variant: "destructive" });
    }
  }

  // [commercial-console slice 2] On desktop, auto-select the first building so the
  // detail pane is populated on arrival. On mobile we leave it on the list (the
  // detail is a drill-in there).
  useEffect(() => {
    if (
      tab === "properties" &&
      expandedProp === null &&
      (account?.properties?.length ?? 0) > 0 &&
      typeof window !== "undefined" &&
      window.innerWidth >= 768
    ) {
      selectProp(account.properties[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, account]);

  // ─── Rate Cards ──────────────────────────────────────────────────────────
  function openNewRateCard() {
    setEditCard(null);
    setRcForm({ service_type: "standard_cleaning", billing_method: "hourly", rate_amount: "", unit_label: "hr", notes: "" });
    setShowRateCard(true);
  }

  function openEditRateCard(card: any) {
    setEditCard(card);
    setRcForm({ service_type: card.service_type, billing_method: card.billing_method, rate_amount: card.rate_amount, unit_label: card.unit_label, notes: card.notes ?? "" });
    setShowRateCard(true);
  }

  async function saveRateCard() {
    if (!rcForm.rate_amount) { toast({ title: "Rate amount is required", variant: "destructive" }); return; }
    setRcSaving(true);
    try {
      const method = editCard ? "PATCH" : "POST";
      const url = editCard
        ? `${API}/api/accounts/${id}/rate-cards/${editCard.id}`
        : `${API}/api/accounts/${id}/rate-cards`;
      const r = await fetch(url, {
        method,
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(rcForm),
      });
      if (r.ok) {
        toast({ title: editCard ? "Rate card updated" : "Rate card added" });
        setShowRateCard(false);
        load();
      } else {
        toast({ title: "Failed to save rate card", variant: "destructive" });
      }
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    setRcSaving(false);
  }

  async function deleteRateCard(cardId: number) {
    if (!confirm("Remove this rate card?")) return;
    await fetch(`${API}/api/accounts/${id}/rate-cards/${cardId}`, { method: "DELETE", headers: getAuthHeaders() });
    load();
  }

  // ─── Properties ──────────────────────────────────────────────────────────
  function openNewProperty() {
    setEditProp(null);
    setPropForm({ property_name: "", address: "", city: "", state: "IL", zip: "", unit_count: "", property_type: "apartment_building", default_service_type: "", access_notes: "", notes: "" });
    setShowProperty(true);
  }

  function openEditProperty(prop: any) {
    setEditProp(prop);
    setPropForm({
      property_name: prop.property_name ?? "",
      address: prop.address ?? "",
      city: prop.city ?? "",
      state: prop.state ?? "IL",
      zip: prop.zip ?? "",
      unit_count: prop.unit_count ? String(prop.unit_count) : "",
      property_type: prop.property_type ?? "apartment_building",
      default_service_type: prop.default_service_type ?? "",
      access_notes: prop.access_notes ?? "",
      notes: prop.notes ?? "",
    });
    setShowProperty(true);
  }

  async function saveProperty() {
    if (!propForm.address) { toast({ title: "Address is required", variant: "destructive" }); return; }
    setPropSaving(true);
    try {
      const method = editProp ? "PATCH" : "POST";
      const url = editProp
        ? `${API}/api/accounts/${id}/properties/${editProp.id}`
        : `${API}/api/accounts/${id}/properties`;
      const r = await fetch(url, {
        method,
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ ...propForm, unit_count: propForm.unit_count ? parseInt(propForm.unit_count) : null }),
      });
      if (r.ok) {
        toast({ title: editProp ? "Property updated" : "Property added" });
        setShowProperty(false);
        load();
      } else {
        toast({ title: "Failed to save property", variant: "destructive" });
      }
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    setPropSaving(false);
  }

  async function deleteProperty(propId: number) {
    if (!confirm("Remove this property?")) return;
    await fetch(`${API}/api/accounts/${id}/properties/${propId}`, { method: "DELETE", headers: getAuthHeaders() });
    load();
  }

  // Tap a property card to drop down its full details + last service. The
  // last-service lookup is lazy and cached so we only hit the API the first
  // time a card is opened.
  // [commercial-console slice 2] Master-detail select — always selects (never
  // toggles off) so the right detail pane swaps as you click down the list.
  function selectProp(propId: number) {
    setExpandedProp(propId);
    loadRecent(propId);
  }
  function loadRecent(propId: number) {
    if (propRecent[propId] === undefined) {
      setPropRecent((m) => ({ ...m, [propId]: "loading" }));
      fetch(`${API}/api/accounts/${id}/properties/${propId}/recent-job`, { headers: getAuthHeaders() })
        .then((r) => (r.ok ? r.json() : null))
        .then((job) => setPropRecent((m) => ({ ...m, [propId]: job ?? "none" })))
        .catch(() => setPropRecent((m) => ({ ...m, [propId]: "none" })));
    }
  }

  // ─── Contacts ────────────────────────────────────────────────────────────
  function openNewContact() {
    setEditContact(null);
    setContactForm({ name: "", role: "operations", email: "", phone: "", receives_invoices: false, receives_receipts: false, receives_on_way_sms: false, receives_completion_notifications: false, is_primary: false, notes: "" });
    setShowContact(true);
  }

  function openEditContact(c: any) {
    setEditContact(c);
    setContactForm({
      name: c.name, role: c.role, email: c.email ?? "", phone: c.phone ?? "",
      receives_invoices: c.receives_invoices, receives_receipts: c.receives_receipts,
      receives_on_way_sms: c.receives_on_way_sms, receives_completion_notifications: c.receives_completion_notifications,
      is_primary: c.is_primary, notes: c.notes ?? "",
    });
    setShowContact(true);
  }

  async function saveContact() {
    if (!contactForm.name) { toast({ title: "Name is required", variant: "destructive" }); return; }
    setContactSaving(true);
    try {
      const method = editContact ? "PATCH" : "POST";
      const url = editContact
        ? `${API}/api/accounts/${id}/contacts/${editContact.id}`
        : `${API}/api/accounts/${id}/contacts`;
      const r = await fetch(url, {
        method,
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(contactForm),
      });
      if (r.ok) {
        toast({ title: editContact ? "Contact updated" : "Contact added" });
        setShowContact(false);
        load();
      } else {
        toast({ title: "Failed to save contact", variant: "destructive" });
      }
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    setContactSaving(false);
  }

  async function deleteContact(contactId: number) {
    if (!confirm("Remove this contact?")) return;
    await fetch(`${API}/api/accounts/${id}/contacts/${contactId}`, { method: "DELETE", headers: getAuthHeaders() });
    load();
  }

  // ─── Invoice ─────────────────────────────────────────────────────────────
  // [per-job-invoices 2026-07-02] separate=true bills each job as its OWN invoice
  // (turnovers); default folds the selection into one consolidated bill (common
  // areas / monthly). Both are billed to the account.
  async function generateInvoice(separate = false) {
    setGeneratingInvoice(true);
    try {
      const r = await fetch(`${API}/api/accounts/${id}/generate-invoice`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        // Send the picked visits; empty selection = all uninvoiced (legacy).
        body: JSON.stringify({
          ...(selectedJobIds.size > 0 ? { job_ids: [...selectedJobIds] } : {}),
          ...(separate ? { separate: true } : {}),
        }),
      });
      const data = await r.json();
      if (r.ok) {
        if (data.separate && data.invoices_created) {
          toast({ title: `${data.invoices_created} invoice${data.invoices_created === 1 ? "" : "s"} created — one per job` });
          setSelectedJobIds(new Set());
          load();
        } else if (data.invoice) {
          toast({ title: `Invoice created — ${data.jobs_consolidated} job(s) consolidated` });
          setSelectedJobIds(new Set());
          load();
        } else {
          toast({ title: data.message ?? "No uninvoiced jobs found" });
        }
      } else {
        toast({ title: data.error ?? "Failed to generate invoice", variant: "destructive" });
      }
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    setGeneratingInvoice(false);
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <DashboardLayout>
        <div className="p-6 space-y-4 max-w-5xl mx-auto">
          <div className="h-8 w-48 bg-gray-100 rounded animate-pulse" />
          <div className="h-32 bg-gray-100 rounded-xl animate-pulse" />
          <div className="h-64 bg-gray-100 rounded-xl animate-pulse" />
        </div>
      </DashboardLayout>
    );
  }

  if (!account) {
    return (
      <DashboardLayout>
        <div className="p-6 text-gray-500">Account not found.</div>
      </DashboardLayout>
    );
  }

  const { stats = {} } = account;
  const tabList: { key: Tab; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "properties", label: "Properties", count: account.properties?.length },
    { key: "rate_cards", label: "Rate Cards", count: account.rate_cards?.length },
    { key: "contacts", label: "Contacts", count: account.contacts?.length },
    { key: "calendar", label: "Calendar" },
    { key: "jobs", label: "Uninvoiced Jobs", count: jobs.length },
    { key: "invoices", label: "Invoices" },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Link href="/accounts">
              <Button variant="ghost" size="icon" className="rounded-full">
                <ChevronLeft size={18} />
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold text-[#0A0E1A]">{account.account_name}</h1>
                {!account.is_active && <Badge variant="secondary" className="text-xs">Inactive</Badge>}
              </div>
              <p className="text-sm text-gray-400 mt-0.5">
                {ACCOUNT_TYPES.find((t) => t.value === account.account_type)?.label ?? account.account_type}
                {" · "}
                {INVOICE_FREQ.find((f) => f.value === account.invoice_frequency)?.label ?? account.invoice_frequency} invoicing
                {" · "}
                {account.payment_terms_days === 0 ? "Due on receipt" : `NET ${account.payment_terms_days}`}
              </p>
            </div>
          </div>
          {jobs.length > 0 && (
            <Button
              className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-2"
              onClick={generateInvoice}
              disabled={generatingInvoice}
            >
              <FileText size={15} />
              {generatingInvoice ? "Generating..." : `Generate Invoice (${jobs.length})`}
            </Button>
          )}
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Revenue MTD", value: fmt(stats.revenue_mtd ?? 0), icon: TrendingUp, color: "text-[#00C9A0]", bg: "bg-[#00C9A0]/8" },
            { label: "Revenue 12M", value: fmt(stats.revenue_12m ?? 0), icon: DollarSign, color: "text-blue-600", bg: "bg-blue-50" },
            { label: "Outstanding", value: fmt(stats.outstanding_balance ?? 0), icon: AlertCircle, color: "text-amber-600", bg: "bg-amber-50" },
            { label: "Open Jobs", value: String(stats.open_jobs ?? 0), icon: Briefcase, color: "text-purple-600", bg: "bg-purple-50" },
          ].map((s) => (
            <div key={s.label} className="bg-white border border-gray-100 rounded-xl p-3 flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg ${s.bg} flex items-center justify-center flex-shrink-0`}>
                <s.icon size={14} className={s.color} />
              </div>
              <div>
                <p className="text-xs text-gray-400">{s.label}</p>
                <p className={`text-base font-semibold ${s.color}`}>{s.value}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-100">
          <div className="flex gap-0">
            {tabList.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  tab === t.key
                    ? "border-[#00C9A0] text-[#00C9A0]"
                    : "border-transparent text-gray-500 hover:text-gray-800"
                }`}
              >
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span className="ml-1.5 text-xs bg-gray-100 text-gray-500 rounded-full px-1.5 py-0.5">{t.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* ─── OVERVIEW TAB ───────────────────────────────────────────────── */}
        {tab === "overview" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Billing Settings */}
            <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Billing</p>
                <button onClick={openBilling}
                  className="text-xs font-medium text-[#00A886] hover:text-[#00806a]">
                  Edit
                </button>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Payment Method</span>
                  <span className="font-medium text-[#0A0E1A]">
                    {PAYMENT_METHODS.find((m) => m.value === account.payment_method)?.label ?? account.payment_method}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Invoice Frequency</span>
                  <span className="font-medium text-[#0A0E1A]">
                    {INVOICE_FREQ.find((f) => f.value === account.invoice_frequency)?.label ?? account.invoice_frequency}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Payment Terms</span>
                  <span className="font-medium text-[#0A0E1A]">
                    {account.payment_terms_days === 0 ? "Due on receipt" : `NET ${account.payment_terms_days}`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Auto-charge</span>
                  <span className={`font-medium ${account.auto_charge_on_completion ? "text-[#00C9A0]" : "text-gray-400"}`}>
                    {account.auto_charge_on_completion ? "Enabled" : "Disabled"}
                  </span>
                </div>
              </div>
            </div>

            {/* Communications — pause all automated SMS/email for this account */}
            <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3 sm:col-span-2">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Communications</p>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-[#0A0E1A]">Automated customer messages</p>
                  <p className="text-xs text-gray-500 mt-0.5 max-w-md">
                    Reminders, on-my-way texts, completion &amp; receipt notices, review requests for every customer under this account.
                    {account.comms_enabled === false
                      ? " Currently PAUSED — nothing automated goes out. (Manual invoices still send.)"
                      : " Turn off for property managers (PPM, KMA, …) who don't want the messaging."}
                  </p>
                </div>
                <Switch checked={account.comms_enabled !== false} onCheckedChange={toggleComms} />
              </div>
              <AccountNotificationPreferences accountId={String(id)} commsPaused={account.comms_enabled === false} />
            </div>

            {/* Activity Summary */}
            <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Activity</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Properties</span>
                  <span className="font-medium text-[#0A0E1A]">{stats.active_properties ?? 0} active</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Open Jobs</span>
                  <span className="font-medium text-[#0A0E1A]">{stats.open_jobs ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Jobs Completed</span>
                  <span className="font-medium text-[#0A0E1A]">{stats.jobs_completed ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Uninvoiced Jobs</span>
                  <span className={`font-medium ${jobs.length > 0 ? "text-amber-600" : "text-gray-400"}`}>{jobs.length}</span>
                </div>
              </div>
            </div>

            {/* Upcoming visits — fills the overview with actionable info */}
            <div className="bg-white border border-gray-100 rounded-xl p-4 sm:col-span-2">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Upcoming visits</p>
                <button onClick={() => setTab("calendar")} className="text-xs font-semibold text-[#00C9A0]">View calendar →</button>
              </div>
              {upcoming.length === 0 ? (
                <p className="text-sm text-gray-400">No upcoming visits scheduled.</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {upcoming.map((j: any) => {
                    const d = new Date(j.scheduled_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
                    let t = "";
                    if (j.scheduled_time) { const [h, m] = String(j.scheduled_time).split(":"); let hh = parseInt(h, 10); const ap = hh >= 12 ? "PM" : "AM"; hh = hh % 12 || 12; t = ` · ${hh}:${(m ?? "00").slice(0, 2)} ${ap}`; }
                    const svc = j.service_type ? String(j.service_type).split("_").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : "";
                    const tech = j.tech_first_name ? `${j.tech_first_name} ${j.tech_last_name ?? ""}`.trim() : null;
                    return (
                      <div key={j.id} className="flex items-center justify-between py-2.5 gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[#0A0E1A] truncate">{j.property_name || j.property_address || "Property"}</p>
                          <p className="text-xs text-gray-500 truncate">{d}{t} · {svc}{tech ? ` · ${tech}` : " · Unassigned"}</p>
                        </div>
                        <span className="text-sm font-semibold text-[#0A0E1A] flex-shrink-0">{j.base_fee ? `$${parseFloat(j.base_fee).toFixed(0)}` : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Account-level notes intentionally removed — permanent notes live
                per-building now (see the property detail's Office/Tech notes). */}
            {account.notes && (
              <div className="bg-white border border-gray-100 rounded-xl p-4 sm:col-span-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Account notes</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{account.notes}</p>
              </div>
            )}
          </div>
        )}

        {/* [team-photo-notes] Sticky pictures + notes for the whole account —
            surface on every job for this account so the team always has the
            context (gate codes, parking, contacts). */}
        {tab === "overview" && (
          <div className="bg-white border border-gray-100 rounded-xl p-4">
            <TeamPhotoNotes accountId={Number(id)} title="Team Photos & Notes (shown on every job for this account)" />
          </div>
        )}

        {/* ─── PROPERTIES TAB ─────────────────────────────────────────────── */}
        {tab === "properties" && (() => {
          const allProps = account.properties || [];
          // [slice 3] Per-building next visit + tech from the upcoming-jobs calendar
          // (already sorted, so the first hit per property is the soonest visit).
          const nextByProp: Record<number, any> = {};
          for (const j of upcoming) { const pid = j.account_property_id; if (pid && !nextByProp[pid]) nextByProp[pid] = j; }
          const unassignedCount = upcoming.filter((j: any) => !j.tech_first_name).length;
          const techOf = (pp: any) => { const nj = nextByProp[pp.id]; return nj?.tech_first_name ? `${nj.tech_first_name} ${nj.tech_last_name || ""}`.trim() : null; };
          const groupKey = (pp: any) => {
            if (pivot === "service") { const s = nextByProp[pp.id]?.service_type || pp.default_service_type; return s ? (SERVICE_TYPES.find((x) => x.value === s)?.label ?? s) : "No service set"; }
            if (pivot === "tech") return techOf(pp) || "Unassigned";
            return pp.zone_name || "Unzoned";
          };
          const q = propSearch.trim().toLowerCase();
          let filtered = allProps.filter((pp: any) => !q || `${pp.property_name || ""} ${pp.address || ""} ${pp.city || ""} ${pp.zip || ""} ${pp.zone_name || ""}`.toLowerCase().includes(q));
          if (onlyUnassigned) filtered = filtered.filter((pp: any) => { const nj = nextByProp[pp.id]; return nj && !nj.tech_first_name; });
          const groups: Record<string, any[]> = {};
          for (const pp of filtered) { const k = groupKey(pp); (groups[k] = groups[k] || []).push(pp); }
          const items: any[] = [];
          for (const z of Object.keys(groups).sort()) { items.push({ __zone: z, __count: groups[z].length }); if (!collapsedZones.has(z)) items.push(...groups[z]); }
          const selected = allProps.find((pp: any) => pp.id === expandedProp) || null;
          return (
            <div className="space-y-3">
              {/* [slice 3] exceptions strip — what needs you first */}
              {(unassignedCount > 0 || jobs.length > 0) && (
                <div className="flex flex-wrap gap-2">
                  {unassignedCount > 0 && (
                    <button onClick={() => setOnlyUnassigned((v) => !v)}
                      className={`text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${onlyUnassigned ? "bg-red-600 text-white" : "bg-red-50 text-red-700 hover:bg-red-100"}`}>
                      {unassignedCount} unassigned{onlyUnassigned ? " · clear" : ""}
                    </button>
                  )}
                  {jobs.length > 0 && (
                    <button onClick={() => setTab("jobs")}
                      className="text-xs font-medium px-3 py-1.5 rounded-full bg-amber-50 text-amber-700 hover:bg-amber-100">
                      {jobs.length} uninvoiced
                    </button>
                  )}
                </div>
              )}
              {/* [slice 2] Master-detail: building list left, inline detail right —
                  pick a building, it loads on the right, never navigate away. */}
              <div className="md:grid md:grid-cols-[300px_minmax(0,1fr)] md:gap-4 md:items-start">
              {/* LEFT — building list */}
              <div className={selected ? "hidden md:block" : "block"}>
                <div className="flex items-center gap-2 mb-2">
                  <input
                    value={propSearch}
                    onChange={(e) => setPropSearch(e.target.value)}
                    placeholder={`Search ${allProps.length} buildings…`}
                    className="flex-1 h-9 rounded-lg border border-gray-200 px-3 text-sm outline-none focus:border-[#00C9A0]"
                  />
                  <Button onClick={openNewProperty} className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-1.5 flex-shrink-0" size="sm">
                    <Plus size={14} /> Add
                  </Button>
                </div>
                {/* [slice 3] pivot the list by zone / service / cleaner */}
                <div className="flex gap-0.5 mb-2 bg-gray-100 rounded-lg p-0.5">
                  {([["zone", "Zone"], ["service", "Service"], ["tech", "Cleaner"]] as const).map(([k, lbl]) => (
                    <button key={k} onClick={() => { setPivot(k); setCollapsedZones(new Set()); }}
                      className={`flex-1 text-[11px] font-medium py-1 rounded-md transition-colors ${pivot === k ? "bg-white text-[#0A0E1A] shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                      {lbl}
                    </button>
                  ))}
                </div>
                {!allProps.length ? (
                  <div className="flex flex-col items-center py-16 text-gray-400 gap-2">
                    <MapPin size={32} strokeWidth={1.5} />
                    <p className="text-sm">No properties yet</p>
                  </div>
                ) : !filtered.length ? (
                  <div className="py-10 text-center text-sm text-gray-400">No buildings match.</div>
                ) : (
                  <div className="bg-white border border-gray-100 rounded-xl overflow-hidden md:max-h-[72vh] md:overflow-auto">
                    {items.map((p: any) => {
                      if (p.__zone) {
                        const collapsed = collapsedZones.has(p.__zone);
                        return (
                          <div key={`z-${p.__zone}`} role="button" tabIndex={0}
                            onClick={() => setCollapsedZones((prev) => { const n = new Set(prev); if (n.has(p.__zone)) n.delete(p.__zone); else n.add(p.__zone); return n; })}
                            className="flex items-center gap-2 px-3 pt-3 pb-1.5 cursor-pointer select-none bg-gray-50/40">
                            <ChevronDown size={13} className={`text-gray-400 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
                            <span className="text-xs font-semibold text-gray-600">{p.__zone}</span>
                            <span className="text-[10px] text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">{p.__count}</span>
                          </div>
                        );
                      }
                      const sel = expandedProp === p.id;
                      return (
                        <div key={p.id} role="button" tabIndex={0}
                          onClick={() => selectProp(p.id)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectProp(p.id); } }}
                          className={`flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors border-l-2 ${sel ? "bg-[#F1FBF8] border-[#00C9A0]" : "border-transparent hover:bg-gray-50"}`}>
                          <div className="w-7 h-7 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
                            <Home size={13} className="text-purple-600" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-sm text-[#0A0E1A] truncate">{p.property_name || p.address}</p>
                            <p className="text-xs text-gray-500 truncate">{[p.address, p.city].filter(Boolean).join(", ")}</p>
                          </div>
                          {p.unit_count ? <span className="text-[11px] text-gray-400 flex-shrink-0">{p.unit_count}u</span> : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* RIGHT — selected building detail */}
              <div className={selected ? "block mt-3 md:mt-0" : "hidden md:block"}>
                {!selected ? (
                  <div className="hidden md:flex flex-col items-center justify-center py-24 text-gray-300 gap-2 border border-dashed border-gray-200 rounded-xl">
                    <Building2 size={28} strokeWidth={1.5} />
                    <p className="text-sm text-gray-400">Select a building to see its details</p>
                  </div>
                ) : (() => {
                  const p = selected;
                  const recent = propRecent[p.id];
                  return (
                    <div className="bg-white border border-gray-100 rounded-xl p-4 md:p-5">
                      <button onClick={() => setExpandedProp(null)} className="md:hidden flex items-center gap-1 text-xs text-gray-500 mb-3">
                        <ChevronLeft size={14} /> All buildings
                      </button>
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-start gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
                            <Home size={16} className="text-purple-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-[#0A0E1A]">{p.property_name || p.address}</p>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {p.address}{(p.city || p.state || p.zip) && `, ${[p.city, p.state, p.zip].filter(Boolean).join(", ")}`}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {/* [account-calendar 2026-07-07] This building's own
                              calendar — jumps to the Calendar tab pre-filtered
                              to this property. */}
                          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-gray-500"
                            onClick={() => { setCalendarPropId(p.id); setTab("calendar"); }}>
                            <CalendarDays size={13} /> Calendar
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditProperty(p)}>
                            <Pencil size={13} className="text-gray-400" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteProperty(p.id)}>
                            <Trash2 size={13} className="text-red-400" />
                          </Button>
                        </div>
                      </div>

                      {/* [slice 3/4] next visit + assigned cleaner, from the calendar */}
                      {(() => {
                        const nj = nextByProp[p.id];
                        return (
                          <div className="flex gap-2 mb-4">
                            <div className="flex-1 bg-gray-50 rounded-lg px-3 py-2">
                              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Next visit</p>
                              <p className="text-sm font-semibold text-[#0A0E1A] mt-0.5">
                                {nj?.scheduled_date
                                  ? new Date(nj.scheduled_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
                                  : "—"}
                                {nj?.scheduled_time ? <span className="text-xs font-normal text-gray-500"> · {String(nj.scheduled_time).slice(0, 5)}</span> : null}
                              </p>
                            </div>
                            <div className="flex-1 bg-gray-50 rounded-lg px-3 py-2">
                              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Cleaner</p>
                              {nj && !nj.tech_first_name ? (
                                <p className="text-sm font-semibold text-red-600 mt-0.5">Unassigned</p>
                              ) : (
                                <p className="text-sm font-semibold text-[#0A0E1A] mt-0.5">{techOf(p) || "—"}</p>
                              )}
                            </div>
                          </div>
                        );
                      })()}

                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2.5 mb-4">
                        <Detail label="Property type" value={p.property_type ? (PROPERTY_TYPES.find((t) => t.value === p.property_type)?.label ?? p.property_type) : "—"} />
                        <Detail label="Units" value={p.unit_count ? `${p.unit_count}` : "—"} />
                        <Detail label="Default service" value={p.default_service_type ? (SERVICE_TYPES.find((s) => s.value === p.default_service_type)?.label ?? p.default_service_type) : "—"} />
                        <Detail label="Zone" value={p.zone_name ?? (p.zone_id ? `Zone ${p.zone_id}` : "—")} />
                        {(p.lat != null && p.lng != null) && (
                          <Detail label="Map location" value={`${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}`} />
                        )}
                      </div>

                      {/* [building-notes 2026-07-01] Permanent per-building notes.
                          Office → job Office Notes; Cleaner → job Cleaner Notes.
                          Auto-filled onto every job for this building by the API. */}
                      <div className="mb-4 bg-gray-50/60 border border-gray-100 rounded-xl p-3">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Permanent building notes</p>
                          {bnEditProp !== p.id && (
                            <button onClick={() => { setBnOffice(p.notes || ""); setBnCleaner(p.access_notes || ""); setBnEditProp(p.id); }}
                              className="text-xs font-semibold text-[#00C9A0] hover:underline">
                              {(p.notes || p.access_notes) ? "Edit" : "+ Add notes"}
                            </button>
                          )}
                        </div>
                        <p className="text-[11px] text-gray-400 mb-2">Auto-fills every job's note boxes for this building — no more copy-paste.</p>
                        {bnEditProp === p.id ? (
                          <div className="space-y-2">
                            <div>
                              <p className="text-[10px] font-semibold text-gray-500 mb-1">OFFICE NOTES <span className="font-normal text-gray-400">· office only</span></p>
                              <textarea rows={2} value={bnOffice} onChange={(e) => setBnOffice(e.target.value)} placeholder="e.g. NET 30, bill monthly, main contact Hugo" className="w-full text-xs border border-gray-200 rounded-lg p-2 outline-none focus:border-[#00C9A0] resize-y" />
                            </div>
                            <div>
                              <p className="text-[10px] font-semibold text-gray-500 mb-1">CLEANER NOTES <span className="font-normal text-gray-400">· the cleaner sees this</span></p>
                              <textarea rows={2} value={bnCleaner} onChange={(e) => setBnCleaner(e.target.value)} placeholder="e.g. lockbox 4417, park in rear, gate code 2247" className="w-full text-xs border border-gray-200 rounded-lg p-2 outline-none focus:border-[#00C9A0] resize-y" />
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => saveBuildingNotes(p.id)} disabled={bnSaving} className="px-3 py-1.5 rounded-lg bg-[#00C9A0] text-white text-xs font-semibold disabled:opacity-60">{bnSaving ? "Saving…" : "Save & apply to jobs"}</button>
                              <button onClick={() => setBnEditProp(null)} disabled={bnSaving} className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 text-xs font-semibold">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <p className="text-[10px] font-semibold text-gray-500 mb-0.5">Office</p>
                              {p.notes ? <p className="text-xs text-gray-700 whitespace-pre-wrap">{p.notes}</p> : <p className="text-xs text-gray-400 italic">None</p>}
                            </div>
                            <div>
                              <p className="text-[10px] font-semibold text-gray-500 mb-0.5">Cleaner</p>
                              {p.access_notes ? <p className="text-xs text-amber-800 bg-amber-50 rounded px-2 py-1 flex items-start gap-1.5"><Key size={12} className="mt-0.5 flex-shrink-0" />{p.access_notes}</p> : <p className="text-xs text-gray-400 italic">None</p>}
                            </div>
                          </div>
                        )}
                        <div className="mt-3 pt-3 border-t border-gray-100">
                          <TeamPhotoNotes accountId={Number(id)} accountPropertyId={p.id} title="Building photos & notes (shown on every job here)" />
                        </div>
                      </div>

                      <div>
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Last service</p>
                        {recent === undefined || recent === "loading" ? (
                          <p className="text-xs text-gray-400">Loading…</p>
                        ) : recent && recent !== "none" ? (
                          <div className="flex items-center justify-between bg-gray-50/60 border border-gray-100 rounded-lg px-3 py-2">
                            <div>
                              <p className="text-xs font-medium text-[#0A0E1A]">
                                {SERVICE_TYPES.find((s) => s.value === recent.service_type)?.label ?? recent.service_type}
                              </p>
                              <p className="text-[11px] text-gray-500 mt-0.5">
                                {recent.scheduled_date ? new Date(recent.scheduled_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                                {recent.frequency && recent.frequency !== "one_time" ? ` · ${recent.frequency}` : ""}
                              </p>
                            </div>
                            <span className="text-xs font-semibold text-[#00C9A0]">
                              {recent.billing_method === "hourly" && recent.hourly_rate
                                ? `${fmtDecimal(parseFloat(recent.hourly_rate))}/hr`
                                : recent.base_fee != null
                                ? fmtDecimal(parseFloat(recent.base_fee))
                                : "—"}
                            </span>
                          </div>
                        ) : (
                          <p className="text-xs text-gray-400">No service history yet</p>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
            </div>
          );
        })()}

        {/* ─── RATE CARDS TAB ─────────────────────────────────────────────── */}
        {tab === "rate_cards" && (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button onClick={openNewRateCard} className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-2" size="sm">
                <Plus size={14} /> Add Rate Card
              </Button>
            </div>
            {!account.rate_cards?.length ? (
              <div className="flex flex-col items-center py-16 text-gray-400 gap-2">
                <DollarSign size={32} strokeWidth={1.5} />
                <p className="text-sm">No rate cards yet</p>
              </div>
            ) : (
              <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Service</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Method</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Rate</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider hidden sm:table-cell">Notes</th>
                      <th className="px-4 py-2.5 w-20" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {account.rate_cards.map((rc: any) => (
                      <tr key={rc.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-[#0A0E1A]">
                          {SERVICE_TYPES.find((s) => s.value === rc.service_type)?.label ?? rc.service_type}
                        </td>
                        <td className="px-4 py-3 text-gray-500">
                          {BILLING_METHODS.find((b) => b.value === rc.billing_method)?.label ?? rc.billing_method}
                        </td>
                        <td className="px-4 py-3 font-semibold text-[#00C9A0]">
                          {fmtDecimal(parseFloat(rc.rate_amount))} / {rc.unit_label}
                        </td>
                        <td className="px-4 py-3 text-gray-400 text-xs hidden sm:table-cell max-w-xs truncate">
                          {rc.notes ?? "—"}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditRateCard(rc)}>
                              <Pencil size={13} className="text-gray-400" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteRateCard(rc.id)}>
                              <Trash2 size={13} className="text-red-400" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ─── CONTACTS TAB ───────────────────────────────────────────────── */}
        {tab === "contacts" && (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button onClick={openNewContact} className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-2" size="sm">
                <Plus size={14} /> Add Contact
              </Button>
            </div>
            {!account.contacts?.length ? (
              <div className="flex flex-col items-center py-16 text-gray-400 gap-2">
                <Users size={32} strokeWidth={1.5} />
                <p className="text-sm">No contacts yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {account.contacts.map((c: any) => (
                  <div key={c.id} className="bg-white border border-gray-100 rounded-xl p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <span className="text-sm font-semibold text-blue-600">{c.name.charAt(0)}</span>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-[#0A0E1A] text-sm">{c.name}</p>
                            {c.is_primary && (
                              <span className="flex items-center gap-0.5 text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">
                                <Star size={10} fill="currentColor" /> Primary
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {CONTACT_ROLES.find((r) => r.value === c.role)?.label ?? c.role}
                          </p>
                          <div className="flex items-center gap-3 mt-1.5 flex-wrap text-xs text-gray-500">
                            {c.email && <span className="flex items-center gap-1"><Mail size={11} /> {c.email}</span>}
                            {c.phone && <span className="flex items-center gap-1"><Phone size={11} /> {c.phone}</span>}
                          </div>
                          {/* Notification badges */}
                          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                            {[
                              { flag: c.receives_invoices, label: "Invoices" },
                              { flag: c.receives_receipts, label: "Receipts" },
                              { flag: c.receives_on_way_sms, label: "On-Way SMS" },
                              { flag: c.receives_completion_notifications, label: "Completion" },
                            ].map((n) => n.flag && (
                              <span key={n.label} className="flex items-center gap-0.5 text-xs bg-[#00C9A0]/10 text-[#00C9A0] px-1.5 py-0.5 rounded-full">
                                <Bell size={10} /> {n.label}
                              </span>
                            ))}
                          </div>
                          {c.notes && <p className="text-xs text-gray-400 mt-1.5 italic">{c.notes}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditContact(c)}>
                          <Pencil size={13} className="text-gray-400" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteContact(c.id)}>
                          <Trash2 size={13} className="text-red-400" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── CALENDAR TAB ────────────────────────────────────────────────── */}
        {tab === "calendar" && id && (
          <AccountJobsCalendar accountId={id} initialPropertyId={calendarPropId} />
        )}

        {/* ─── JOBS TAB ────────────────────────────────────────────────────── */}
        {tab === "jobs" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-sm text-gray-500">{jobs.length} {includeScheduled ? "billable" : "uninvoiced completed"} {jobs.length === 1 ? "job" : "jobs"}</p>
                <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                  <input type="checkbox" checked={includeScheduled} onChange={e => { setIncludeScheduled(e.target.checked); setSelectedJobIds(new Set()); }} />
                  Include upcoming (pre-bill)
                </label>
                {/* [pre-bill-month 2026-07-03] Month scope for the pre-bill list —
                    only shown while pre-billing (completed-only list needs no window). */}
                {includeScheduled && (
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => shiftJobsMonth(-1)} aria-label="Previous month" className="w-7 h-7 rounded-lg border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100">‹</button>
                    <span className="text-xs font-semibold text-[#0A0E1A] min-w-[120px] text-center">{jobsMonthLabel}</span>
                    <button onClick={() => shiftJobsMonth(1)} aria-label="Next month" className="w-7 h-7 rounded-lg border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100">›</button>
                  </div>
                )}
              </div>
              {jobs.length > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 border-[#00C9A0] text-[#00A886] hover:bg-[#00C9A0]/5"
                    onClick={() => generateInvoice(true)}
                    disabled={generatingInvoice}
                    title="Create one invoice per job — bill each turnover separately"
                  >
                    <FileText size={14} />
                    {generatingInvoice ? "Working..." : `Invoice each separately (${selectedJobIds.size > 0 ? selectedJobIds.size : jobs.length})`}
                  </Button>
                  <Button
                    className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-2"
                    size="sm"
                    onClick={() => generateInvoice(false)}
                    disabled={generatingInvoice}
                    title="Fold the selection into one consolidated invoice — for monthly common-areas billing"
                  >
                    <FileText size={14} />
                    {generatingInvoice
                      ? "Generating..."
                      : selectedJobIds.size > 0
                        ? `Consolidate ${selectedJobIds.size}`
                        : "Consolidate all"}
                  </Button>
                </div>
              )}
            </div>
            {!jobs.length ? (
              <div className="flex flex-col items-center py-16 text-gray-400 gap-2">
                <CheckCircle2 size={32} strokeWidth={1.5} className="text-[#00C9A0]" />
                <p className="text-sm">{includeScheduled ? `No billable visits in ${jobsMonthLabel}` : "All jobs are invoiced"}</p>
              </div>
            ) : (
              <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="px-4 py-2.5 w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all visits"
                          checked={jobs.length > 0 && selectedJobIds.size === jobs.length}
                          onChange={e => setSelectedJobIds(e.target.checked ? new Set(jobs.map((j: any) => j.id)) : new Set())}
                        />
                      </th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Date</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Service</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider hidden sm:table-cell">Billing</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {jobs.map((j: any) => {
                      const amount = j.billed_amount ? parseFloat(j.billed_amount) : parseFloat(j.base_fee ?? "0");
                      return (
                        <tr key={j.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              aria-label={`Select visit ${j.scheduled_date}`}
                              checked={selectedJobIds.has(j.id)}
                              onChange={e => setSelectedJobIds(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(j.id); else next.delete(j.id);
                                return next;
                              })}
                            />
                          </td>
                          <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{j.scheduled_date}</td>
                          <td className="px-4 py-3 font-medium text-[#0A0E1A]">
                            {SERVICE_TYPES.find((s) => s.value === j.service_type)?.label ?? j.service_type?.replace(/_/g, " ")}
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-xs hidden sm:table-cell">
                            {j.billing_method === "hourly" && j.billed_hours
                              ? `${j.billed_hours}h @ $${j.hourly_rate}/hr`
                              : j.billing_method === "flat_rate"
                              ? "Flat rate"
                              : "—"
                            }
                          </td>
                          <td className="px-4 py-3 text-right font-semibold text-[#00C9A0]">
                            {fmtDecimal(amount)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-100 bg-gray-50">
                      <td colSpan={4} className="px-4 py-2.5 text-sm font-semibold text-gray-500">
                        {selectedJobIds.size > 0 ? `Total (${selectedJobIds.size} selected)` : "Total"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-sm font-bold text-[#00C9A0]">
                        {fmtDecimal((selectedJobIds.size > 0 ? jobs.filter((j: any) => selectedJobIds.has(j.id)) : jobs)
                          .reduce((s: number, j: any) => s + (j.billed_amount ? parseFloat(j.billed_amount) : parseFloat(j.base_fee ?? "0")), 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ─── INVOICES TAB (month-filterable) ──────────────────────────────── */}
        {tab === "invoices" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <button onClick={() => shiftMonth(-1)} aria-label="Previous month" className="w-8 h-8 rounded-lg border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100">‹</button>
                <span className="text-sm font-semibold text-[#0A0E1A] min-w-[150px] text-center">{monthLabel}</span>
                <button onClick={() => shiftMonth(1)} aria-label="Next month" className="w-8 h-8 rounded-lg border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100">›</button>
              </div>
              <p className="text-sm text-gray-500">
                {acctInvoices.length} invoice{acctInvoices.length === 1 ? "" : "s"} · <span className="font-semibold text-[#00C9A0]">{fmtDecimal(parseFloat(acctInvTotal))}</span>
              </p>
            </div>
            {invLoading ? (
              <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
            ) : !acctInvoices.length ? (
              <div className="flex flex-col items-center py-16 text-gray-400 gap-2">
                <FileText size={32} strokeWidth={1.5} />
                <p className="text-sm">No invoices in {monthLabel}</p>
              </div>
            ) : (
              <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Date</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Invoice</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider hidden sm:table-cell">Description</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Status</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {acctInvoices.map((inv: any) => {
                      const desc = Array.isArray(inv.line_items) && inv.line_items[0]?.description ? inv.line_items[0].description : "—";
                      const st = String(inv.status || "");
                      const stCls = st === "paid" ? "bg-green-50 text-green-700" : st === "sent" ? "bg-blue-50 text-blue-700" : st === "overdue" ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-500";
                      return (
                        <tr key={inv.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{inv.service_date}</td>
                          <td className="px-4 py-3 font-medium whitespace-nowrap">
                            <Link href={`/invoices/${inv.id}`} className="text-[#00A886] hover:underline">{inv.invoice_number || `INV-${inv.id}`}</Link>
                          </td>
                          <td className="px-4 py-3 text-gray-500 truncate max-w-[280px] hidden sm:table-cell">{desc}</td>
                          <td className="px-4 py-3"><span className={`text-xs font-semibold px-2 py-0.5 rounded uppercase ${stCls}`}>{st}</span></td>
                          <td className="px-4 py-3 text-right font-semibold text-[#00C9A0]">{fmtDecimal(parseFloat(inv.total || "0"))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-100 bg-gray-50">
                      <td colSpan={4} className="px-4 py-2.5 text-sm font-semibold text-gray-500">Total — {monthLabel}</td>
                      <td className="px-4 py-2.5 text-right text-sm font-bold text-[#00C9A0]">{fmtDecimal(parseFloat(acctInvTotal))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Rate Card Dialog ───────────────────────────────────────────────── */}
      <Dialog open={showRateCard} onOpenChange={setShowRateCard}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editCard ? "Edit Rate Card" : "Add Rate Card"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Service Type</Label>
              <Select value={rcForm.service_type} onValueChange={(v) => setRcForm({ ...rcForm, service_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SERVICE_TYPES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Billing Method</Label>
                <Select value={rcForm.billing_method} onValueChange={(v) => {
                  const unitMap: Record<string, string> = { hourly: "hr", flat_rate: "job", per_unit: "unit" };
                  setRcForm({ ...rcForm, billing_method: v, unit_label: unitMap[v] ?? rcForm.unit_label });
                }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BILLING_METHODS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Rate ($)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={rcForm.rate_amount}
                  onChange={(e) => setRcForm({ ...rcForm, rate_amount: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Unit</Label>
                <Input
                  placeholder="hr"
                  value={rcForm.unit_label}
                  onChange={(e) => setRcForm({ ...rcForm, unit_label: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Input
                placeholder="Optional notes..."
                value={rcForm.notes}
                onChange={(e) => setRcForm({ ...rcForm, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRateCard(false)}>Cancel</Button>
            <Button className="bg-[#00C9A0] hover:bg-[#00b38f] text-white" onClick={saveRateCard} disabled={rcSaving}>
              {rcSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Billing Settings Dialog ────────────────────────────────────────── */}
      <Dialog open={showBilling} onOpenChange={setShowBilling}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Billing Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Payment Method</Label>
              <Select value={billingForm.payment_method} onValueChange={(v) => setBillingForm({ ...billingForm, payment_method: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Invoice Frequency</Label>
                <Select value={billingForm.invoice_frequency} onValueChange={(v) => setBillingForm({ ...billingForm, invoice_frequency: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INVOICE_FREQ.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Payment Terms</Label>
                <Select value={String(billingForm.payment_terms_days)} onValueChange={(v) => setBillingForm({ ...billingForm, payment_terms_days: Number(v) })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Due on receipt</SelectItem>
                    <SelectItem value="7">NET 7</SelectItem>
                    <SelectItem value="15">NET 15</SelectItem>
                    <SelectItem value="30">NET 30</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none pt-1">
              <input type="checkbox" checked={billingForm.auto_charge_on_completion}
                onChange={(e) => setBillingForm({ ...billingForm, auto_charge_on_completion: e.target.checked })} />
              Auto-charge card on completion
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBilling(false)}>Cancel</Button>
            <Button className="bg-[#00C9A0] hover:bg-[#00b38f] text-white" onClick={saveBilling} disabled={billingSaving}>
              {billingSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Property Dialog ────────────────────────────────────────────────── */}
      <Dialog open={showProperty} onOpenChange={setShowProperty}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editProp ? "Edit Property" : "Add Property"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 col-span-2">
                <Label>Property Name</Label>
                <Input placeholder="Oak Lawn Commons" value={propForm.property_name} onChange={(e) => setPropForm({ ...propForm, property_name: e.target.value })} />
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label>Street Address *</Label>
                <Input ref={propAddrRef} placeholder="4801 W 95th St" value={propForm.address} onChange={(e) => setPropForm({ ...propForm, address: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>City</Label>
                <Input placeholder="Oak Lawn" value={propForm.city} onChange={(e) => setPropForm({ ...propForm, city: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label>State</Label>
                  <Input placeholder="IL" value={propForm.state} onChange={(e) => setPropForm({ ...propForm, state: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>ZIP</Label>
                  <Input placeholder="60453" value={propForm.zip} onChange={(e) => setPropForm({ ...propForm, zip: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Property Type</Label>
                <Select value={propForm.property_type} onValueChange={(v) => setPropForm({ ...propForm, property_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROPERTY_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Units</Label>
                <Input type="number" min="1" placeholder="48" value={propForm.unit_count} onChange={(e) => setPropForm({ ...propForm, unit_count: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Default Service</Label>
                <Select value={propForm.default_service_type || "_none"} onValueChange={(v) => setPropForm({ ...propForm, default_service_type: v === "_none" ? "" : v })}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">None</SelectItem>
                    {SERVICE_TYPES.filter((s) => s.value !== "default").map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Access Notes</Label>
              <Textarea
                placeholder="Key fob in lockbox. Code: 2247..."
                rows={2}
                value={propForm.access_notes}
                onChange={(e) => setPropForm({ ...propForm, access_notes: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Internal Notes</Label>
              <Input placeholder="Optional notes..." value={propForm.notes} onChange={(e) => setPropForm({ ...propForm, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowProperty(false)}>Cancel</Button>
            <Button className="bg-[#00C9A0] hover:bg-[#00b38f] text-white" onClick={saveProperty} disabled={propSaving}>
              {propSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Contact Dialog ─────────────────────────────────────────────────── */}
      <Dialog open={showContact} onOpenChange={setShowContact}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editContact ? "Edit Contact" : "Add Contact"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 col-span-2">
                <Label>Full Name *</Label>
                <Input placeholder="Diana Reyes" value={contactForm.name} onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select value={contactForm.role} onValueChange={(v) => setContactForm({ ...contactForm, role: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONTACT_ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input type="email" placeholder="diana@example.com" value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input placeholder="(708) 555-0141" value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2.5 pt-1">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Notifications</p>
              {[
                { key: "receives_invoices", label: "Receives invoices" },
                { key: "receives_receipts", label: "Receives receipts" },
                { key: "receives_on_way_sms", label: "Receives on-way SMS" },
                { key: "receives_completion_notifications", label: "Receives completion notifications" },
                { key: "is_primary", label: "Primary contact" },
              ].map((field) => (
                <div key={field.key} className="flex items-center justify-between">
                  <Label className="font-normal text-sm">{field.label}</Label>
                  <Switch
                    checked={(contactForm as any)[field.key]}
                    onCheckedChange={(v) => setContactForm({ ...contactForm, [field.key]: v })}
                  />
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Input placeholder="Optional notes..." value={contactForm.notes} onChange={(e) => setContactForm({ ...contactForm, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowContact(false)}>Cancel</Button>
            <Button className="bg-[#00C9A0] hover:bg-[#00b38f] text-white" onClick={saveContact} disabled={contactSaving}>
              {contactSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

// Small label/value pair used in the expanded property card.
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{label}</p>
      <p className="text-xs text-[#0A0E1A] mt-0.5">{value}</p>
    </div>
  );
}
