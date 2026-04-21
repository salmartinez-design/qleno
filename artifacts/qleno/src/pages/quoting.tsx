import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
async function apiFetch(path: string, opts: { method?: string; body?: any; headers?: any } = {}) {
  const { body, headers: extraHeaders, ...rest } = opts;
  const r = await fetch(`${API}${path}`, { headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...extraHeaders }, ...rest, ...(body !== undefined && { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
import { Plus, Pencil, Trash2, Sparkles, DollarSign } from "lucide-react";
import { toast } from "sonner";

interface Scope {
  id: number;
  name: string;
  category: string;
  pricing_method: string;
  base_hourly_rate: string;
  min_bill_rate: string;
  available_office: boolean;
  available_online: boolean;
  is_active: boolean;
  sort_order: number;
  frequencies: Frequency[];
  sqft_table: SqftEntry[];
  addons: Addon[];
}

interface Frequency {
  id: number;
  frequency: string;
  factor: string;
  min_cost: string | null;
  hourly_rate_override: string | null;
  available_office: boolean;
  available_online: boolean;
  sort_order: number;
}

interface SqftEntry {
  id: number;
  sqft_min: number;
  sqft_max: number | null;
  estimated_hours: string;
}

interface Addon {
  id: number;
  name: string;
  addon_type: string;
  price_type: string;
  price_value: string;
  time_minutes: number;
  tech_pay: boolean;
  available_office: boolean;
  available_portal: boolean;
  is_active: boolean;
  sort_order: number;
}

function fmt(n: string | number) {
  return parseFloat(String(n)).toFixed(2);
}

export default function QuotingPage() {
  const qc = useQueryClient();
  const [selectedScope, setSelectedScope] = useState<Scope | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newScope, setNewScope] = useState({ name: "", pricing_method: "sqft", base_hourly_rate: "65", min_bill_rate: "180" });

  const { data: scopes = [], isLoading } = useQuery<Scope[]>({
    queryKey: ["quote-scopes"],
    queryFn: () => apiFetch("/api/quote-scopes"),
  });

  const seedMutation = useMutation({
    mutationFn: () => apiFetch("/api/quote-scopes/seed-defaults", { method: "POST" }),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["quote-scopes"] });
      toast.success(data.message || "PHES defaults seeded");
    },
    onError: () => toast.error("Failed to seed defaults"),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiFetch("/api/quote-scopes", { method: "POST", body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quote-scopes"] });
      toast.success("Scope created");
      setIsCreating(false);
      setNewScope({ name: "", pricing_method: "sqft", base_hourly_rate: "65", min_bill_rate: "180" });
    },
    onError: () => toast.error("Failed to create scope"),
  });

  const patchScopeMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      apiFetch(`/api/quote-scopes/${id}`, { method: "PATCH", body: data }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["quote-scopes"] });
      setSelectedScope(updated as Scope);
    },
    onError: () => toast.error("Update failed"),
  });

  const deleteScopeMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/quote-scopes/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quote-scopes"] });
      setSheetOpen(false);
      setSelectedScope(null);
      toast.success("Scope deleted");
    },
  });

  const patchFreqMutation = useMutation({
    mutationFn: ({ scopeId, freqId, data }: { scopeId: number; freqId: number; data: any }) =>
      apiFetch(`/api/quote-scopes/${scopeId}/frequencies/${freqId}`, { method: "PATCH", body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quote-scopes"] });
      if (selectedScope) {
        apiFetch(`/api/quote-scopes/${selectedScope.id}`).then(setSelectedScope);
      }
    },
  });

  const saveSqftMutation = useMutation({
    mutationFn: ({ scopeId, entries }: { scopeId: number; entries: any[] }) =>
      apiFetch(`/api/quote-scopes/${scopeId}/sqft`, { method: "PUT", body: { entries } }),
    onSuccess: () => {
      toast.success("Sq Ft table saved");
      if (selectedScope) apiFetch(`/api/quote-scopes/${selectedScope.id}`).then(setSelectedScope);
    },
    onError: () => toast.error("Save failed"),
  });

  const addAddonMutation = useMutation({
    mutationFn: ({ scopeId, data }: { scopeId: number; data: any }) =>
      apiFetch(`/api/quote-scopes/${scopeId}/addons`, { method: "POST", body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quote-scopes"] });
      if (selectedScope) apiFetch(`/api/quote-scopes/${selectedScope.id}`).then(setSelectedScope);
    },
  });

  const patchAddonMutation = useMutation({
    mutationFn: ({ scopeId, addonId, data }: { scopeId: number; addonId: number; data: any }) =>
      apiFetch(`/api/quote-scopes/${scopeId}/addons/${addonId}`, { method: "PATCH", body: data }),
    onSuccess: () => {
      if (selectedScope) apiFetch(`/api/quote-scopes/${selectedScope.id}`).then(setSelectedScope);
    },
  });

  const deleteAddonMutation = useMutation({
    mutationFn: ({ scopeId, addonId }: { scopeId: number; addonId: number }) =>
      apiFetch(`/api/quote-scopes/${scopeId}/addons/${addonId}`, { method: "DELETE" }),
    onSuccess: () => {
      if (selectedScope) apiFetch(`/api/quote-scopes/${selectedScope.id}`).then(setSelectedScope);
      toast.success("Add-on removed");
    },
  });

  function openScope(scope: Scope) {
    setSelectedScope(scope);
    setSheetOpen(true);
  }

  return (
    <DashboardLayout>
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1917]">Quoting Settings</h1>
          <p className="text-sm text-[#6B7280] mt-1">Configure service scopes, pricing, and add-ons for quote generation.</p>
        </div>
        <div className="flex gap-2">
          {scopes.length === 0 && (
            <Button
              variant="outline"
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending}
              className="gap-2"
            >
              <Sparkles className="w-4 h-4" />
              Load PHES Defaults
            </Button>
          )}
          <Button onClick={() => setIsCreating(true)} className="gap-2 bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white">
            <Plus className="w-4 h-4" />
            New Scope
          </Button>
        </div>
      </div>

      {isCreating && (
        <div className="bg-white border border-[#E5E2DC] rounded-lg p-4 space-y-3">
          <h3 className="font-semibold text-[#1A1917]">New Service Scope</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="text-xs">Scope Name</Label>
              <Input
                value={newScope.name}
                onChange={e => setNewScope(p => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Deep Clean"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Pricing Method</Label>
              <Select value={newScope.pricing_method} onValueChange={v => setNewScope(p => ({ ...p, pricing_method: v }))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sqft">Sq Ft Based</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="flat">Flat Rate</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Hourly Rate ($)</Label>
              <Input
                type="number"
                value={newScope.base_hourly_rate}
                onChange={e => setNewScope(p => ({ ...p, base_hourly_rate: e.target.value }))}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Minimum Bill ($)</Label>
              <Input
                type="number"
                value={newScope.min_bill_rate}
                onChange={e => setNewScope(p => ({ ...p, min_bill_rate: e.target.value }))}
                className="mt-1"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              className="bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white"
              onClick={() => createMutation.mutate(newScope)}
              disabled={!newScope.name || createMutation.isPending}
            >
              Create Scope
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIsCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="bg-white border border-[#E5E2DC] rounded-lg overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-[#9E9B94]">Loading scopes...</div>
        ) : scopes.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <DollarSign className="w-10 h-10 text-[#9E9B94] mx-auto" />
            <p className="text-[#6B7280]">No service scopes configured.</p>
            <p className="text-sm text-[#9E9B94]">Load PHES defaults or create a scope to get started.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-[#F7F6F3]">
                <TableHead className="font-semibold text-[#1A1917]">Scope Name</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Pricing</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Rate</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Min Bill</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Freq.</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Add-ons</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Active</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {scopes.map(scope => (
                <TableRow key={scope.id} className="hover:bg-[#F7F6F3] cursor-pointer" onClick={() => openScope(scope)}>
                  <TableCell className="font-medium text-[#1A1917]">{scope.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs capitalize">
                      {scope.pricing_method === "sqft" ? "Sq Ft" : scope.pricing_method === "hourly" ? "Hourly" : "Flat"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-[#6B7280]">${fmt(scope.base_hourly_rate)}/hr</TableCell>
                  <TableCell className="text-[#6B7280]">${fmt(scope.min_bill_rate)}</TableCell>
                  <TableCell className="text-[#6B7280]">{scope.frequencies?.length ?? 0}</TableCell>
                  <TableCell className="text-[#6B7280]">{scope.addons?.length ?? 0}</TableCell>
                  <TableCell onClick={e => e.stopPropagation()}>
                    <Switch
                      checked={scope.is_active}
                      onCheckedChange={v =>
                        patchScopeMutation.mutate({ id: scope.id, data: { is_active: v } })
                      }
                    />
                  </TableCell>
                  <TableCell onClick={e => e.stopPropagation()}>
                    <Button size="sm" variant="ghost" onClick={() => openScope(scope)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          {selectedScope && (
            <ScopeEditor
              scope={selectedScope}
              onPatchScope={(data) => patchScopeMutation.mutate({ id: selectedScope.id, data })}
              onPatchFreq={(freqId, data) => patchFreqMutation.mutate({ scopeId: selectedScope.id, freqId, data })}
              onSaveSqft={(entries) => saveSqftMutation.mutate({ scopeId: selectedScope.id, entries })}
              onAddAddon={(data) => addAddonMutation.mutate({ scopeId: selectedScope.id, data })}
              onPatchAddon={(addonId, data) => patchAddonMutation.mutate({ scopeId: selectedScope.id, addonId, data })}
              onDeleteAddon={(addonId) => deleteAddonMutation.mutate({ scopeId: selectedScope.id, addonId })}
              onDelete={() => deleteScopeMutation.mutate(selectedScope.id)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
    </DashboardLayout>
  );
}

function ScopeEditor({
  scope, onPatchScope, onPatchFreq, onSaveSqft,
  onAddAddon, onPatchAddon, onDeleteAddon, onDelete,
}: {
  scope: Scope;
  onPatchScope: (data: any) => void;
  onPatchFreq: (freqId: number, data: any) => void;
  onSaveSqft: (entries: any[]) => void;
  onAddAddon: (data: any) => void;
  onPatchAddon: (addonId: number, data: any) => void;
  onDeleteAddon: (addonId: number) => void;
  onDelete: () => void;
}) {
  const [basicFields, setBasicFields] = useState({
    name: scope.name,
    pricing_method: scope.pricing_method,
    base_hourly_rate: scope.base_hourly_rate,
    min_bill_rate: scope.min_bill_rate,
    available_office: scope.available_office,
    available_online: scope.available_online,
  });
  const [sqftEdits, setSqftEdits] = useState(scope.sqft_table.map(e => ({ ...e, estimated_hours: e.estimated_hours })));
  const [newAddon, setNewAddon] = useState({ name: "", price_type: "flat", price_value: "50", time_minutes: 0, tech_pay: true });
  const [showNewAddon, setShowNewAddon] = useState(false);

  useEffect(() => {
    setBasicFields({ name: scope.name, pricing_method: scope.pricing_method, base_hourly_rate: scope.base_hourly_rate, min_bill_rate: scope.min_bill_rate, available_office: scope.available_office, available_online: scope.available_online });
    setSqftEdits(scope.sqft_table.map(e => ({ ...e })));
  }, [scope.id]);

  return (
    <div>
      <SheetHeader className="mb-4">
        <SheetTitle className="text-[#1A1917]">{scope.name}</SheetTitle>
      </SheetHeader>

      <Tabs defaultValue="basic">
        <TabsList className="w-full mb-4">
          <TabsTrigger value="basic" className="flex-1 text-xs">Basic</TabsTrigger>
          <TabsTrigger value="frequencies" className="flex-1 text-xs">Frequencies</TabsTrigger>
          {scope.pricing_method === "sqft" && (
            <TabsTrigger value="sqft" className="flex-1 text-xs">Sq Ft Table</TabsTrigger>
          )}
          <TabsTrigger value="addons" className="flex-1 text-xs">Add-ons</TabsTrigger>
        </TabsList>

        <TabsContent value="basic" className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="text-xs">Scope Name</Label>
              <Input value={basicFields.name} onChange={e => setBasicFields(p => ({ ...p, name: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Pricing Method</Label>
              <Select value={basicFields.pricing_method} onValueChange={v => setBasicFields(p => ({ ...p, pricing_method: v }))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sqft">Sq Ft Based</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="flat">Flat Rate</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Base Hourly Rate ($)</Label>
              <Input type="number" value={basicFields.base_hourly_rate} onChange={e => setBasicFields(p => ({ ...p, base_hourly_rate: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Minimum Bill ($)</Label>
              <Input type="number" value={basicFields.min_bill_rate} onChange={e => setBasicFields(p => ({ ...p, min_bill_rate: e.target.value }))} className="mt-1" />
            </div>
          </div>
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Available for Office Use</Label>
              <Switch checked={basicFields.available_office} onCheckedChange={v => setBasicFields(p => ({ ...p, available_office: v }))} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Available for Online Booking</Label>
              <Switch checked={basicFields.available_online} onCheckedChange={v => setBasicFields(p => ({ ...p, available_online: v }))} />
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button size="sm" className="bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white" onClick={() => onPatchScope(basicFields)}>
              Save Changes
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700 hover:bg-red-50 ml-auto">
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete Scope
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Scope</AlertDialogTitle>
                  <AlertDialogDescription>This will permanently delete the scope and all its settings. This cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={onDelete}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </TabsContent>

        <TabsContent value="frequencies" className="space-y-3">
          <p className="text-xs text-[#9E9B94]">Adjust the multiplier applied to the base price for each service frequency.</p>
          <div className="space-y-2">
            {scope.frequencies.map(freq => (
              <div key={freq.id} className="bg-[#F7F6F3] rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-[#1A1917]">{freq.frequency}</span>
                  <div className="flex gap-2">
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-[#9E9B94]">Office</span>
                      <Switch checked={freq.available_office} onCheckedChange={v => onPatchFreq(freq.id, { available_office: v })} />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-[#9E9B94]">Online</span>
                      <Switch checked={freq.available_online} onCheckedChange={v => onPatchFreq(freq.id, { available_online: v })} />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label className="text-xs text-[#9E9B94]">Factor</Label>
                    <FreqInput value={freq.factor} onBlur={v => onPatchFreq(freq.id, { factor: v })} />
                  </div>
                  <div>
                    <Label className="text-xs text-[#9E9B94]">Min Cost ($)</Label>
                    <FreqInput value={freq.min_cost ?? ""} placeholder="—" onBlur={v => onPatchFreq(freq.id, { min_cost: v || null })} />
                  </div>
                  <div>
                    <Label className="text-xs text-[#9E9B94]">Rate Override ($)</Label>
                    <FreqInput value={freq.hourly_rate_override ?? ""} placeholder="—" onBlur={v => onPatchFreq(freq.id, { hourly_rate_override: v || null })} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="sqft" className="space-y-3">
          <p className="text-xs text-[#9E9B94]">Map square footage ranges to estimated hours. Price = hours × rate × frequency factor.</p>
          <div className="space-y-1.5">
            {sqftEdits.map((entry, idx) => (
              <div key={entry.id ?? idx} className="grid grid-cols-4 gap-2 items-center">
                <div>
                  <Label className="text-xs text-[#9E9B94]">Min Sq Ft</Label>
                  <Input
                    type="number"
                    value={entry.sqft_min}
                    onChange={e => setSqftEdits(prev => prev.map((r, i) => i === idx ? { ...r, sqft_min: parseInt(e.target.value) || 0 } : r))}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-[#9E9B94]">Max Sq Ft</Label>
                  <Input
                    type="number"
                    value={entry.sqft_max ?? ""}
                    placeholder="no max"
                    onChange={e => setSqftEdits(prev => prev.map((r, i) => i === idx ? { ...r, sqft_max: e.target.value ? parseInt(e.target.value) : null } : r))}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-[#9E9B94]">Est. Hours</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={entry.estimated_hours}
                    onChange={e => setSqftEdits(prev => prev.map((r, i) => i === idx ? { ...r, estimated_hours: e.target.value } : r))}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="pt-5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 text-[#9E9B94] hover:text-red-500"
                    onClick={() => setSqftEdits(prev => prev.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSqftEdits(prev => [...prev, { id: 0, sqft_min: 0, sqft_max: null, estimated_hours: "1" }])}
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Row
            </Button>
            <Button
              size="sm"
              className="bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white"
              onClick={() => onSaveSqft(sqftEdits)}
            >
              Save Table
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="addons" className="space-y-3">
          <p className="text-xs text-[#9E9B94]">Add-ons are shown when building a quote for this scope.</p>
          <div className="space-y-2">
            {scope.addons.filter(a => a.is_active).map(addon => (
              <div key={addon.id} className="bg-[#F7F6F3] rounded-lg p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#1A1917] truncate">{addon.name}</p>
                  <p className="text-xs text-[#9E9B94]">
                    {addon.price_type === "flat" ? `$${fmt(addon.price_value)}` : `${addon.price_value}%`}
                    {addon.time_minutes > 0 ? ` · ${addon.time_minutes}min` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-[#9E9B94]">Office</span>
                  <Switch checked={addon.available_office} onCheckedChange={v => onPatchAddon(addon.id, { available_office: v })} />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-[#9E9B94] hover:text-red-500"
                  onClick={() => onDeleteAddon(addon.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
          {showNewAddon ? (
            <div className="bg-[#F7F6F3] rounded-lg p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <Label className="text-xs">Name</Label>
                  <Input value={newAddon.name} onChange={e => setNewAddon(p => ({ ...p, name: e.target.value }))} className="mt-1 h-8" placeholder="e.g. Oven Cleaning" />
                </div>
                <div>
                  <Label className="text-xs">Price Type</Label>
                  <Select value={newAddon.price_type} onValueChange={v => setNewAddon(p => ({ ...p, price_type: v }))}>
                    <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="flat">Flat ($)</SelectItem>
                      <SelectItem value="percent">Percent (%)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">{newAddon.price_type === "percent" ? "Percent (%)" : "Price ($)"}</Label>
                  <Input type="number" value={newAddon.price_value} onChange={e => setNewAddon(p => ({ ...p, price_value: e.target.value }))} className="mt-1 h-8" />
                </div>
                <div>
                  <Label className="text-xs">Time (minutes)</Label>
                  <Input type="number" value={newAddon.time_minutes} onChange={e => setNewAddon(p => ({ ...p, time_minutes: parseInt(e.target.value) || 0 }))} className="mt-1 h-8" />
                </div>
                <div className="flex items-center gap-2 pt-4">
                  <Switch checked={newAddon.tech_pay} onCheckedChange={v => setNewAddon(p => ({ ...p, tech_pay: v }))} />
                  <Label className="text-xs">Tech Pay</Label>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" className="bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white" onClick={() => { onAddAddon(newAddon); setShowNewAddon(false); setNewAddon({ name: "", price_type: "flat", price_value: "50", time_minutes: 0, tech_pay: true }); }} disabled={!newAddon.name}>
                  Add
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowNewAddon(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setShowNewAddon(true)} className="gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Add Add-on
            </Button>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FreqInput({ value, onBlur, placeholder }: { value: string; onBlur: (v: string) => void; placeholder?: string }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <Input
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={() => onBlur(local)}
      placeholder={placeholder}
      className="h-8 text-sm mt-1"
    />
  );
}
