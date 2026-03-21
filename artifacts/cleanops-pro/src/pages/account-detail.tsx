import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import {
  Building2, ChevronLeft, Plus, Pencil, Trash2,
  DollarSign, MapPin, Users, Phone, Mail, Check,
  ToggleLeft, ToggleRight, Bell,
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

const SERVICE_TYPES = [
  { value: "standard_clean", label: "Standard Clean" },
  { value: "deep_clean", label: "Deep Clean" },
  { value: "move_out", label: "Move Out" },
  { value: "move_in", label: "Move In" },
  { value: "recurring", label: "Recurring" },
  { value: "post_construction", label: "Post Construction" },
  { value: "office_cleaning", label: "Office Cleaning" },
  { value: "common_areas", label: "Common Areas" },
  { value: "retail_store", label: "Retail Store" },
  { value: "medical_office", label: "Medical Office" },
  { value: "ppm_turnover", label: "PPM Turnover" },
  { value: "post_event", label: "Post Event" },
];

const BILLING_METHODS = [
  { value: "flat", label: "Flat Rate" },
  { value: "hourly", label: "Hourly" },
  { value: "per_unit", label: "Per Unit" },
];

const PROPERTY_TYPES = [
  { value: "apartment", label: "Apartment" },
  { value: "condo", label: "Condo" },
  { value: "office", label: "Office" },
  { value: "common_area", label: "Common Area" },
  { value: "other", label: "Other" },
];

const CONTACT_ROLES = [
  { value: "billing", label: "Billing" },
  { value: "operations", label: "Operations" },
  { value: "onsite", label: "On-Site" },
  { value: "accountant", label: "Accountant" },
  { value: "other", label: "Other" },
];

const ACCOUNT_TYPES = [
  { value: "property_management", label: "Property Management" },
  { value: "commercial", label: "Commercial" },
  { value: "other", label: "Other" },
];

const INVOICE_FREQ = [
  { value: "per_job", label: "Per Job" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

const PAYMENT_METHODS = [
  { value: "check", label: "Check" },
  { value: "ach", label: "ACH" },
  { value: "credit_card", label: "Credit Card" },
  { value: "square", label: "Square" },
  { value: "stripe", label: "Stripe" },
  { value: "other", label: "Other" },
];

type Tab = "overview" | "rate_cards" | "properties" | "contacts";

export default function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();

  const [account, setAccount] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");

  // Rate card dialog
  const [showRateCard, setShowRateCard] = useState(false);
  const [rcForm, setRcForm] = useState({ service_type: "standard_clean", billing_method: "flat", rate_amount: "", unit_label: "job" });
  const [rcSaving, setRcSaving] = useState(false);

  // Property dialog
  const [showProperty, setShowProperty] = useState(false);
  const [propForm, setPropForm] = useState({ property_name: "", address: "", unit_count: "", property_type: "other", notes: "" });
  const [propSaving, setPropSaving] = useState(false);

  // Contact dialog
  const [showContact, setShowContact] = useState(false);
  const [contactForm, setContactForm] = useState({
    name: "", role: "other", email: "", phone: "",
    receives_invoices: false, receives_on_way_notifications: false, receives_completion_notifications: false,
  });
  const [contactSaving, setContactSaving] = useState(false);

  // Consolidate invoice
  const [consolidating, setConsolidating] = useState(false);

  async function load() {
    try {
      const r = await fetch(`${API}/api/accounts/${id}`, { headers: getAuthHeaders() });
      if (r.ok) setAccount(await r.json());
    } catch {}
    setLoading(false);
  }

  useEffect(() => { load(); }, [id]);

  async function saveRateCard() {
    if (!rcForm.rate_amount) { toast({ title: "Rate amount is required", variant: "destructive" }); return; }
    setRcSaving(true);
    try {
      const r = await fetch(`${API}/api/accounts/${id}/rate-cards`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ ...rcForm, rate_amount: rcForm.rate_amount }),
      });
      if (r.ok) {
        toast({ title: "Rate card added" });
        setShowRateCard(false);
        setRcForm({ service_type: "standard_clean", billing_method: "flat", rate_amount: "", unit_label: "job" });
        load();
      } else {
        toast({ title: "Failed to save rate card", variant: "destructive" });
      }
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    setRcSaving(false);
  }

  async function deleteRateCard(cardId: number) {
    try {
      await fetch(`${API}/api/accounts/${id}/rate-cards/${cardId}`, { method: "DELETE", headers: getAuthHeaders() });
      load();
    } catch {}
  }

  async function saveProperty() {
    if (!propForm.property_name || !propForm.address) { toast({ title: "Name and address are required", variant: "destructive" }); return; }
    setPropSaving(true);
    try {
      const r = await fetch(`${API}/api/accounts/${id}/properties`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          ...propForm,
          unit_count: propForm.unit_count ? parseInt(propForm.unit_count) : null,
        }),
      });
      if (r.ok) {
        toast({ title: "Property added" });
        setShowProperty(false);
        setPropForm({ property_name: "", address: "", unit_count: "", property_type: "other", notes: "" });
        load();
      } else {
        toast({ title: "Failed to save property", variant: "destructive" });
      }
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    setPropSaving(false);
  }

  async function deleteProperty(propId: number) {
    try {
      await fetch(`${API}/api/accounts/${id}/properties/${propId}`, { method: "DELETE", headers: getAuthHeaders() });
      load();
    } catch {}
  }

  async function saveContact() {
    if (!contactForm.name) { toast({ title: "Name is required", variant: "destructive" }); return; }
    setContactSaving(true);
    try {
      const r = await fetch(`${API}/api/accounts/${id}/contacts`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(contactForm),
      });
      if (r.ok) {
        toast({ title: "Contact added" });
        setShowContact(false);
        setContactForm({ name: "", role: "other", email: "", phone: "", receives_invoices: false, receives_on_way_notifications: false, receives_completion_notifications: false });
        load();
      } else {
        toast({ title: "Failed to save contact", variant: "destructive" });
      }
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    setContactSaving(false);
  }

  async function deleteContact(contactId: number) {
    try {
      await fetch(`${API}/api/accounts/${id}/contacts/${contactId}`, { method: "DELETE", headers: getAuthHeaders() });
      load();
    } catch {}
  }

  async function consolidateInvoices() {
    setConsolidating(true);
    try {
      const r = await fetch(`${API}/api/accounts/${id}/consolidate-invoices`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      const data = await r.json();
      if (r.ok) {
        if (data.invoice) {
          toast({ title: `Invoice created — ${data.jobs_consolidated} jobs consolidated` });
        } else {
          toast({ title: data.message ?? "No uninvoiced jobs found" });
        }
      } else {
        toast({ title: data.error ?? "Failed to consolidate", variant: "destructive" });
      }
    } catch { toast({ title: "Network error", variant: "destructive" }); }
    setConsolidating(false);
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="p-6 space-y-4 max-w-4xl mx-auto">
          <div className="h-8 w-48 bg-gray-100 rounded animate-pulse" />
          <div className="h-32 bg-gray-100 rounded-xl animate-pulse" />
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

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "rate_cards", label: "Rate Cards", count: account.rate_cards?.filter((c: any) => c.is_active).length },
    { key: "properties", label: "Properties", count: account.properties?.filter((p: any) => p.is_active).length },
    { key: "contacts", label: "Contacts", count: account.contacts?.length },
  ];

  return (
    <DashboardLayout>
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Back + Header */}
        <div>
          <Link href="/accounts">
            <button className="flex items-center gap-1 text-sm text-gray-500 hover:text-[#00C9A0] transition-colors mb-3">
              <ChevronLeft size={14} /> Accounts
            </button>
          </Link>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-[#00C9A0]/10 flex items-center justify-center">
                <Building2 size={22} className="text-[#00C9A0]" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold text-[#0A0E1A]">{account.account_name}</h1>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-sm text-gray-500">
                    {ACCOUNT_TYPES.find((t) => t.value === account.account_type)?.label}
                  </span>
                  <span className="text-gray-300">·</span>
                  <span className="text-sm text-gray-500">
                    {INVOICE_FREQ.find((f) => f.value === account.invoice_frequency)?.label} invoicing
                  </span>
                  {!account.is_active && <Badge variant="secondary">Inactive</Badge>}
                </div>
              </div>
            </div>
            {account.invoice_frequency !== "per_job" && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-[#00C9A0] border-[#00C9A0]/30 hover:bg-[#00C9A0]/5"
                onClick={consolidateInvoices}
                disabled={consolidating}
              >
                {consolidating ? "Consolidating..." : "Generate Consolidated Invoice"}
              </Button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                tab === t.key
                  ? "border-[#00C9A0] text-[#00C9A0]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                  tab === t.key ? "bg-[#00C9A0]/10 text-[#00C9A0]" : "bg-gray-100 text-gray-500"
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Overview Tab ── */}
        {tab === "overview" && (
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Billing</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Invoice Frequency</span>
                  <span className="font-medium">
                    {INVOICE_FREQ.find((f) => f.value === account.invoice_frequency)?.label}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Payment Terms</span>
                  <span className="font-medium">
                    {account.payment_terms_days === 0 ? "Due on Receipt" : `NET ${account.payment_terms_days}`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Payment Method</span>
                  <span className="font-medium">
                    {PAYMENT_METHODS.find((m) => m.value === account.payment_method)?.label ?? "—"}
                  </span>
                </div>
              </div>
            </div>
            <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Summary</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Properties</span>
                  <span className="font-medium">{account.properties?.filter((p: any) => p.is_active).length ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Contacts</span>
                  <span className="font-medium">{account.contacts?.length ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Rate Cards</span>
                  <span className="font-medium">{account.rate_cards?.filter((c: any) => c.is_active).length ?? 0}</span>
                </div>
              </div>
            </div>
            {account.notes && (
              <div className="col-span-2 bg-white border border-gray-100 rounded-xl p-4">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Notes</h3>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{account.notes}</p>
              </div>
            )}
          </div>
        )}

        {/* ── Rate Cards Tab ── */}
        {tab === "rate_cards" && (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button
                size="sm"
                className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-1.5"
                onClick={() => setShowRateCard(true)}
              >
                <Plus size={14} /> Add Rate Card
              </Button>
            </div>
            {account.rate_cards?.filter((c: any) => c.is_active).length === 0 ? (
              <div className="flex flex-col items-center py-16 text-gray-400 space-y-2">
                <DollarSign size={36} strokeWidth={1.5} />
                <p className="text-sm">No rate cards yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {account.rate_cards?.filter((c: any) => c.is_active).map((card: any) => (
                  <div key={card.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-xl p-4">
                    <div>
                      <p className="font-medium text-sm text-[#0A0E1A]">
                        {SERVICE_TYPES.find((s) => s.value === card.service_type)?.label ?? card.service_type}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {BILLING_METHODS.find((b) => b.value === card.billing_method)?.label} — {card.unit_label}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-lg font-semibold text-[#00C9A0]">
                        ${parseFloat(card.rate_amount).toFixed(2)}
                      </span>
                      <button
                        onClick={() => deleteRateCard(card.id)}
                        className="text-gray-300 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Properties Tab ── */}
        {tab === "properties" && (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button
                size="sm"
                className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-1.5"
                onClick={() => setShowProperty(true)}
              >
                <Plus size={14} /> Add Property
              </Button>
            </div>
            {account.properties?.filter((p: any) => p.is_active).length === 0 ? (
              <div className="flex flex-col items-center py-16 text-gray-400 space-y-2">
                <MapPin size={36} strokeWidth={1.5} />
                <p className="text-sm">No properties yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {account.properties?.filter((p: any) => p.is_active).map((prop: any) => (
                  <div key={prop.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-xl p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-gray-50 flex items-center justify-center">
                        <MapPin size={15} className="text-gray-400" />
                      </div>
                      <div>
                        <p className="font-medium text-sm text-[#0A0E1A]">{prop.property_name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{prop.address}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="text-xs text-gray-500">
                          {PROPERTY_TYPES.find((t) => t.value === prop.property_type)?.label}
                        </p>
                        {prop.unit_count && (
                          <p className="text-xs text-gray-400">{prop.unit_count} units</p>
                        )}
                      </div>
                      <button
                        onClick={() => deleteProperty(prop.id)}
                        className="text-gray-300 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Contacts Tab ── */}
        {tab === "contacts" && (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button
                size="sm"
                className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-1.5"
                onClick={() => setShowContact(true)}
              >
                <Plus size={14} /> Add Contact
              </Button>
            </div>
            {account.contacts?.length === 0 ? (
              <div className="flex flex-col items-center py-16 text-gray-400 space-y-2">
                <Users size={36} strokeWidth={1.5} />
                <p className="text-sm">No contacts yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {account.contacts?.map((c: any) => (
                  <div key={c.id} className="bg-white border border-gray-100 rounded-xl p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm text-[#0A0E1A]">{c.name}</p>
                          <Badge variant="secondary" className="text-xs">
                            {CONTACT_ROLES.find((r) => r.value === c.role)?.label}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 mt-1.5 text-xs text-gray-500">
                          {c.email && (
                            <span className="flex items-center gap-1"><Mail size={11} /> {c.email}</span>
                          )}
                          {c.phone && (
                            <span className="flex items-center gap-1"><Phone size={11} /> {c.phone}</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => deleteContact(c.id)}
                        className="text-gray-300 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-50">
                      <span className={`flex items-center gap-1 text-xs ${c.receives_invoices ? "text-[#00C9A0]" : "text-gray-300"}`}>
                        {c.receives_invoices ? <Check size={12} /> : <span className="w-3" />} Receives invoices
                      </span>
                      <span className={`flex items-center gap-1 text-xs ${c.receives_on_way_notifications ? "text-[#00C9A0]" : "text-gray-300"}`}>
                        {c.receives_on_way_notifications ? <Check size={12} /> : <span className="w-3" />} On-way alerts
                      </span>
                      <span className={`flex items-center gap-1 text-xs ${c.receives_completion_notifications ? "text-[#00C9A0]" : "text-gray-300"}`}>
                        {c.receives_completion_notifications ? <Check size={12} /> : <span className="w-3" />} Completion alerts
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rate Card Dialog */}
      <Dialog open={showRateCard} onOpenChange={setShowRateCard}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add Rate Card</DialogTitle></DialogHeader>
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Billing Method</Label>
                <Select value={rcForm.billing_method} onValueChange={(v) => setRcForm({ ...rcForm, billing_method: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BILLING_METHODS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Unit Label</Label>
                <Select value={rcForm.unit_label} onValueChange={(v) => setRcForm({ ...rcForm, unit_label: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="job">Per Job</SelectItem>
                    <SelectItem value="hr">Per Hour</SelectItem>
                    <SelectItem value="unit">Per Unit</SelectItem>
                    <SelectItem value="sqft">Per Sqft</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Rate Amount ($)</Label>
              <Input
                type="number"
                placeholder="0.00"
                value={rcForm.rate_amount}
                onChange={(e) => setRcForm({ ...rcForm, rate_amount: e.target.value })}
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

      {/* Property Dialog */}
      <Dialog open={showProperty} onOpenChange={setShowProperty}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Add Property</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Property Name</Label>
              <Input placeholder="Oak Lawn Complex A" value={propForm.property_name} onChange={(e) => setPropForm({ ...propForm, property_name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Address</Label>
              <Input placeholder="123 Main St, Oak Lawn, IL 60453" value={propForm.address} onChange={(e) => setPropForm({ ...propForm, address: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
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
                <Label>Unit Count (optional)</Label>
                <Input type="number" placeholder="48" value={propForm.unit_count} onChange={(e) => setPropForm({ ...propForm, unit_count: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea rows={2} placeholder="Access codes, special instructions..." value={propForm.notes} onChange={(e) => setPropForm({ ...propForm, notes: e.target.value })} />
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

      {/* Contact Dialog */}
      <Dialog open={showContact} onOpenChange={setShowContact}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Add Contact</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input placeholder="Jane Smith" value={contactForm.name} onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })} />
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
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input type="email" placeholder="jane@company.com" value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input placeholder="(312) 555-0100" value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2 pt-1">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Notifications</p>
              {[
                { key: "receives_invoices", label: "Receives Invoices" },
                { key: "receives_on_way_notifications", label: "On-Way Alerts" },
                { key: "receives_completion_notifications", label: "Completion Alerts" },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between">
                  <Label className="text-sm font-normal text-gray-700">{label}</Label>
                  <Switch
                    checked={(contactForm as any)[key]}
                    onCheckedChange={(v) => setContactForm({ ...contactForm, [key]: v })}
                  />
                </div>
              ))}
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
