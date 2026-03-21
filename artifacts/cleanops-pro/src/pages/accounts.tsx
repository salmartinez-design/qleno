import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Building2, Plus, Search, ChevronRight, Users, MapPin } from "lucide-react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getAuthHeaders } from "@/lib/auth";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");

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

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const { toast } = useToast();

  // Create form state
  const [form, setForm] = useState({
    account_name: "",
    account_type: "commercial",
    invoice_frequency: "per_job",
    payment_method: "",
    payment_terms_days: 30,
    notes: "",
  });
  const [creating, setCreating] = useState(false);

  async function load() {
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
        setForm({ account_name: "", account_type: "commercial", invoice_frequency: "per_job", payment_method: "", payment_terms_days: 30, notes: "" });
        load();
      } else {
        const err = await r.json();
        toast({ title: err.error || "Failed to create account", variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    }
    setCreating(false);
  }

  const filtered = accounts.filter((a) =>
    a.account_name.toLowerCase().includes(search.toLowerCase())
  );

  const typeLabel = (t: string) =>
    ACCOUNT_TYPES.find((x) => x.value === t)?.label ?? t;

  const freqBadge = (f: string) => {
    const colors: Record<string, string> = {
      per_job: "bg-[#00C9A0]/10 text-[#00C9A0]",
      weekly: "bg-blue-50 text-blue-700",
      monthly: "bg-purple-50 text-purple-700",
      custom: "bg-orange-50 text-orange-700",
    };
    return colors[f] ?? "bg-gray-100 text-gray-700";
  };

  return (
    <DashboardLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-[#0A0E1A]">Accounts</h1>
            <p className="text-sm text-gray-500 mt-0.5">Commercial &amp; property management accounts</p>
          </div>
          <Button
            onClick={() => setShowCreate(true)}
            className="bg-[#00C9A0] hover:bg-[#00b38f] text-white gap-2"
          >
            <Plus size={16} /> New Account
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            placeholder="Search accounts..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* List */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 space-y-3">
            <Building2 size={40} strokeWidth={1.5} />
            <p className="text-sm">{search ? "No accounts match your search" : "No accounts yet — create the first one"}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((a) => (
              <Link key={a.id} href={`/accounts/${a.id}`}>
                <div className="flex items-center justify-between p-4 bg-white border border-gray-100 rounded-xl hover:border-[#00C9A0]/40 hover:shadow-sm transition-all cursor-pointer group">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-[#00C9A0]/10 flex items-center justify-center">
                      <Building2 size={18} className="text-[#00C9A0]" />
                    </div>
                    <div>
                      <p className="font-medium text-[#0A0E1A] group-hover:text-[#00C9A0] transition-colors">
                        {a.account_name}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">{typeLabel(a.account_type)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <MapPin size={12} /> {a.property_count ?? 0} {a.property_count === 1 ? "property" : "properties"}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users size={12} /> {a.contact_count ?? 0} {a.contact_count === 1 ? "contact" : "contacts"}
                      </span>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${freqBadge(a.invoice_frequency)}`}>
                      {INVOICE_FREQ.find((f) => f.value === a.invoice_frequency)?.label ?? a.invoice_frequency}
                    </span>
                    {!a.is_active && (
                      <Badge variant="secondary" className="text-xs">Inactive</Badge>
                    )}
                    <ChevronRight size={16} className="text-gray-300 group-hover:text-[#00C9A0] transition-colors" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Account</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Account Name</Label>
              <Input
                placeholder="Apex Property Management"
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
                    {ACCOUNT_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Invoice Frequency</Label>
                <Select value={form.invoice_frequency} onValueChange={(v) => setForm({ ...form, invoice_frequency: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INVOICE_FREQ.map((f) => (
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Payment Method</Label>
                <Select value={form.payment_method} onValueChange={(v) => setForm({ ...form, payment_method: v })}>
                  <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Payment Terms (days)</Label>
                <Select
                  value={String(form.payment_terms_days)}
                  onValueChange={(v) => setForm({ ...form, payment_terms_days: parseInt(v) })}
                >
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
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea
                placeholder="Internal notes about this account..."
                rows={3}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              className="bg-[#00C9A0] hover:bg-[#00b38f] text-white"
              onClick={createAccount}
              disabled={creating}
            >
              {creating ? "Creating..." : "Create Account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
