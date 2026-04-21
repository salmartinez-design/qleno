import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import {
  Building2, ChevronLeft, Plus, Pencil, Trash2, DollarSign,
  MapPin, Users, Phone, Mail, Star, Bell, BellOff, Briefcase,
  TrendingUp, AlertCircle, CheckCircle2, Clock, FileText,
  CreditCard, Home, Hash,
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

type Tab = "overview" | "properties" | "rate_cards" | "contacts" | "jobs";

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

export default function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();

  const [account, setAccount] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");

  // Rate card
  const [showRateCard, setShowRateCard] = useState(false);
  const [editCard, setEditCard] = useState<any>(null);
  const [rcForm, setRcForm] = useState({ service_type: "standard_cleaning", billing_method: "hourly", rate_amount: "", unit_label: "hr", notes: "" });
  const [rcSaving, setRcSaving] = useState(false);

  // Property
  const [showProperty, setShowProperty] = useState(false);
  const [editProp, setEditProp] = useState<any>(null);
  const [propForm, setPropForm] = useState({ property_name: "", address: "", city: "", state: "IL", zip: "", unit_count: "", property_type: "apartment_building", default_service_type: "", access_notes: "", notes: "" });
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

  // Invoice generation
  const [generatingInvoice, setGeneratingInvoice] = useState(false);

  async function load() {
    try {
      const [accR, jobsR] = await Promise.all([
        fetch(`${API}/api/accounts/${id}`, { headers: getAuthHeaders() }),
        fetch(`${API}/api/accounts/${id}/uninvoiced-jobs`, { headers: getAuthHeaders() }),
      ]);
      if (accR.ok) setAccount(await accR.json());
      if (jobsR.ok) setJobs(await jobsR.json());
    } catch {}
    setLoading(false);
  }

  useEffect(() => { load(); }, [id]);

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
  async function generateInvoice() {
    setGeneratingInvoice(true);
    try {
      const r = await fetch(`${API}/api/accounts/${id}/generate-invoice`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      const data = await r.json();
      if (r.ok) {
        if (data.invoice) {
          toast({ title: `Invoice created — ${data.jobs_consolidated} job(s) consolidated` });
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
    { key: "jobs", label: "Uninvoiced Jobs", count: jobs.length },
  ];

  return (
    <DashboardLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-5">
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
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Billing</p>
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

            {/* Notes */}
            {account.notes && (
              <div className="bg-white border border-gray-100 rounded-xl p-4 sm:col-span-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Notes</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{account.notes}</p>
              </div>
            )}
          </div>
        )}

        {/* ─── PROPERTIES TAB ─────────────────────────────────────────────── */}
        {tab === "properties" && (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button onClick={openNewProperty} className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-2" size="sm">
                <Plus size={14} /> Add Property
              </Button>
            </div>
            {!account.properties?.length ? (
              <div className="flex flex-col items-center py-16 text-gray-400 gap-2">
                <MapPin size={32} strokeWidth={1.5} />
                <p className="text-sm">No properties yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {account.properties.map((p: any) => (
                  <div key={p.id} className="bg-white border border-gray-100 rounded-xl p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Home size={14} className="text-purple-600" />
                        </div>
                        <div>
                          <p className="font-medium text-[#0A0E1A] text-sm">{p.property_name || p.address}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {p.address}
                            {(p.city || p.state || p.zip) && `, ${[p.city, p.state, p.zip].filter(Boolean).join(", ")}`}
                          </p>
                          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                              {PROPERTY_TYPES.find((t) => t.value === p.property_type)?.label ?? p.property_type}
                            </span>
                            {p.unit_count && (
                              <span className="text-xs text-gray-500 flex items-center gap-1">
                                <Hash size={11} /> {p.unit_count} units
                              </span>
                            )}
                            {p.default_service_type && (
                              <span className="text-xs text-gray-500">
                                Default: {SERVICE_TYPES.find((s) => s.value === p.default_service_type)?.label ?? p.default_service_type}
                              </span>
                            )}
                          </div>
                          {p.access_notes && (
                            <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 mt-2 max-w-md">
                              {p.access_notes}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditProperty(p)}>
                          <Pencil size={13} className="text-gray-400" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteProperty(p.id)}>
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

        {/* ─── JOBS TAB ────────────────────────────────────────────────────── */}
        {tab === "jobs" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">{jobs.length} uninvoiced completed {jobs.length === 1 ? "job" : "jobs"}</p>
              {jobs.length > 0 && (
                <Button
                  className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-2"
                  size="sm"
                  onClick={generateInvoice}
                  disabled={generatingInvoice}
                >
                  <FileText size={14} />
                  {generatingInvoice ? "Generating..." : "Generate Invoice"}
                </Button>
              )}
            </div>
            {!jobs.length ? (
              <div className="flex flex-col items-center py-16 text-gray-400 gap-2">
                <CheckCircle2 size={32} strokeWidth={1.5} className="text-[#00C9A0]" />
                <p className="text-sm">All jobs are invoiced</p>
              </div>
            ) : (
              <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
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
                      <td colSpan={3} className="px-4 py-2.5 text-sm font-semibold text-gray-500">Total</td>
                      <td className="px-4 py-2.5 text-right text-sm font-bold text-[#00C9A0]">
                        {fmtDecimal(jobs.reduce((s: number, j: any) => s + (j.billed_amount ? parseFloat(j.billed_amount) : parseFloat(j.base_fee ?? "0")), 0))}
                      </td>
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
                <Input placeholder="4801 W 95th St" value={propForm.address} onChange={(e) => setPropForm({ ...propForm, address: e.target.value })} />
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
