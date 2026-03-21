import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  Building2, Plus, Search, ChevronRight, MapPin, TrendingUp,
  AlertCircle, Briefcase, Filter,
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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

function fmt(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function freqBadgeClass(f: string) {
  const map: Record<string, string> = {
    per_job: "bg-[#00C9A0]/10 text-[#00C9A0]",
    weekly: "bg-blue-50 text-blue-700",
    monthly: "bg-purple-50 text-purple-700",
    custom: "bg-orange-50 text-orange-700",
  };
  return map[f] ?? "bg-gray-100 text-gray-700";
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [showInactive, setShowInactive] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const { toast } = useToast();

  const [form, setForm] = useState({
    account_name: "",
    account_type: "property_management",
    invoice_frequency: "per_job",
    payment_method: "card_on_file",
    payment_terms_days: 0,
    auto_charge_on_completion: true,
    notes: "",
  });
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/accounts`, { headers: getAuthHeaders() });
      if (r.ok) setAccounts(await r.json());
    } catch {}
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function createAccount() {
    if (!form.account_name.trim()) {
      toast({ title: "Account name is required", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const r = await fetch(`${API}/api/accounts`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (r.ok) {
        toast({ title: "Account created" });
        setShowCreate(false);
        setForm({ account_name: "", account_type: "property_management", invoice_frequency: "per_job", payment_method: "card_on_file", payment_terms_days: 0, auto_charge_on_completion: true, notes: "" });
        load();
      } else {
        const err = await r.json();
        toast({ title: err.error ?? "Failed to create account", variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    }
    setCreating(false);
  }

  const filtered = accounts.filter((a) => {
    if (!showInactive && !a.is_active) return false;
    if (typeFilter !== "all" && a.account_type !== typeFilter) return false;
    return a.account_name.toLowerCase().includes(search.toLowerCase());
  });

  // Summary stats across filtered accounts
  const totalRevMtd = filtered.reduce((s, a) => s + (a.revenue_mtd ?? 0), 0);
  const totalOutstanding = filtered.reduce((s, a) => s + (a.outstanding_balance ?? 0), 0);
  const totalOpenJobs = filtered.reduce((s, a) => s + (a.open_jobs ?? 0), 0);
  const totalProperties = filtered.reduce((s, a) => s + (a.active_properties ?? 0), 0);

  return (
    <DashboardLayout>
      <div className="p-6 max-w-6xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-[#0A0E1A]">Accounts</h1>
            <p className="text-sm text-gray-500 mt-0.5">Commercial and property management accounts</p>
          </div>
          <Button onClick={() => setShowCreate(true)} className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-2">
            <Plus size={16} /> New Account
          </Button>
        </div>

        {/* Summary Bar */}
        {!loading && accounts.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Revenue MTD", value: fmt(totalRevMtd), icon: TrendingUp, color: "text-[#00C9A0]", bg: "bg-[#00C9A0]/8" },
              { label: "Outstanding", value: fmt(totalOutstanding), icon: AlertCircle, color: "text-amber-600", bg: "bg-amber-50" },
              { label: "Open Jobs", value: totalOpenJobs.toString(), icon: Briefcase, color: "text-blue-600", bg: "bg-blue-50" },
              { label: "Properties", value: totalProperties.toString(), icon: MapPin, color: "text-purple-600", bg: "bg-purple-50" },
            ].map((s) => (
              <div key={s.label} className="bg-white border border-gray-100 rounded-xl p-4 flex items-center gap-3">
                <div className={`w-9 h-9 rounded-lg ${s.bg} flex items-center justify-center flex-shrink-0`}>
                  <s.icon size={16} className={s.color} />
                </div>
                <div>
                  <p className="text-xs text-gray-500">{s.label}</p>
                  <p className={`text-lg font-semibold ${s.color}`}>{s.value}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex gap-2 flex-wrap items-center">
          <div className="relative flex-1 min-w-48">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input placeholder="Search accounts..." className="pl-9 h-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-48 h-9 gap-1">
              <Filter size={13} className="text-gray-400" />
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {ACCOUNT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Switch checked={showInactive} onCheckedChange={setShowInactive} />
            <span>Show inactive</span>
          </div>
        </div>

        {/* List */}
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 space-y-3">
            <Building2 size={40} strokeWidth={1.5} />
            <p className="text-sm">{search || typeFilter !== "all" ? "No accounts match your filters" : "No accounts yet"}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filtered.map((a) => (
              <Link key={a.id} href={`/accounts/${a.id}`}>
                <div className="flex items-center justify-between px-4 py-3 bg-white border border-gray-100 rounded-xl hover:border-[#00C9A0]/40 hover:shadow-sm transition-all cursor-pointer group">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-[#00C9A0]/10 flex items-center justify-center flex-shrink-0">
                      <Building2 size={16} className="text-[#00C9A0]" />
                    </div>
                    <div>
                      <p className="font-medium text-[#0A0E1A] group-hover:text-[#00C9A0] transition-colors text-sm">
                        {a.account_name}
                        {!a.is_active && <span className="ml-2 text-xs text-gray-400 font-normal">(Inactive)</span>}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {ACCOUNT_TYPES.find((t) => t.value === a.account_type)?.label ?? a.account_type}
                        {a.active_properties > 0 && ` · ${a.active_properties} ${a.active_properties === 1 ? "property" : "properties"}`}
                        {a.open_jobs > 0 && ` · ${a.open_jobs} open`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    {/* Revenue MTD */}
                    {a.revenue_mtd > 0 && (
                      <div className="text-right hidden sm:block">
                        <p className="text-xs text-gray-400">MTD</p>
                        <p className="text-sm font-semibold text-[#00C9A0]">{fmt(a.revenue_mtd)}</p>
                      </div>
                    )}
                    {/* Outstanding */}
                    {a.outstanding_balance > 0 && (
                      <div className="text-right hidden sm:block">
                        <p className="text-xs text-gray-400">Outstanding</p>
                        <p className="text-sm font-semibold text-amber-600">{fmt(a.outstanding_balance)}</p>
                      </div>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${freqBadgeClass(a.invoice_frequency)}`}>
                      {INVOICE_FREQ.find((f) => f.value === a.invoice_frequency)?.label ?? a.invoice_frequency}
                    </span>
                    <ChevronRight size={15} className="text-gray-300 group-hover:text-[#00C9A0] transition-colors" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New Account</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Account Name *</Label>
              <Input
                placeholder="Pinnacle Property Management"
                value={form.account_name}
                onChange={(e) => setForm({ ...form, account_name: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Account Type</Label>
                <Select value={form.account_type} onValueChange={(v) => setForm({ ...form, account_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Invoice Frequency</Label>
                <Select value={form.invoice_frequency} onValueChange={(v) => setForm({ ...form, invoice_frequency: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INVOICE_FREQ.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Payment Method</Label>
                <Select value={form.payment_method} onValueChange={(v) => setForm({ ...form, payment_method: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Payment Terms</Label>
                <Select value={String(form.payment_terms_days)} onValueChange={(v) => setForm({ ...form, payment_terms_days: parseInt(v) })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Due on receipt</SelectItem>
                    <SelectItem value="7">NET 7</SelectItem>
                    <SelectItem value="15">NET 15</SelectItem>
                    <SelectItem value="30">NET 30</SelectItem>
                    <SelectItem value="45">NET 45</SelectItem>
                    <SelectItem value="60">NET 60</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-3 py-1">
              <Switch
                checked={form.auto_charge_on_completion}
                onCheckedChange={(v) => setForm({ ...form, auto_charge_on_completion: v })}
              />
              <div>
                <p className="text-sm font-medium">Auto-charge on completion</p>
                <p className="text-xs text-gray-500">Automatically charge when a job is marked complete</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea
                placeholder="Internal notes about this account..."
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button className="bg-[#00C9A0] hover:bg-[#00b38f] text-white" onClick={createAccount} disabled={creating}>
              {creating ? "Creating..." : "Create Account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
