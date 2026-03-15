import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
async function apiFetch(path: string, opts: { method?: string; body?: any; headers?: any } = {}) {
  const { body, headers: extraHeaders, ...rest } = opts;
  const r = await fetch(`${API}${path}`, { headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...extraHeaders }, ...rest, ...(body !== undefined && { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
import {
  Plus, FileText, Send, CheckCircle, Briefcase, Search,
  MoreHorizontal, Pencil, Trash2, SendHorizonal, ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

interface Quote {
  id: number;
  client_id: number | null;
  lead_name: string | null;
  lead_email: string | null;
  address: string | null;
  frequency: string | null;
  base_price: string | null;
  total_price: string | null;
  discount_amount: string | null;
  status: string;
  sent_at: string | null;
  accepted_at: string | null;
  created_at: string;
  scope_id: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  sqft: number | null;
  client_first: string | null;
  client_last: string | null;
  client_email: string | null;
  scope_name: string | null;
}

interface Stats {
  total: number;
  pending: number;
  accepted_this_month: number;
  converted: number;
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-[#F7F6F3] text-[#6B7280] border border-[#E5E2DC]" },
  sent: { label: "Sent", className: "bg-blue-50 text-blue-700 border border-blue-200" },
  viewed: { label: "Viewed", className: "bg-purple-50 text-purple-700 border border-purple-200" },
  accepted: { label: "Accepted", className: "bg-green-50 text-green-700 border border-green-200" },
  declined: { label: "Declined", className: "bg-red-50 text-red-700 border border-red-200" },
  booked: { label: "Converted", className: "bg-[#5B9BD5]/10 text-[#5B9BD5] border border-[#5B9BD5]/30" },
  expired: { label: "Expired", className: "bg-orange-50 text-orange-700 border border-orange-200" },
};

const TABS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "sent", label: "Sent" },
  { key: "viewed", label: "Viewed" },
  { key: "accepted", label: "Accepted" },
  { key: "booked", label: "Converted" },
];

function clientName(q: Quote) {
  if (q.client_first) return `${q.client_first} ${q.client_last ?? ""}`.trim();
  return q.lead_name || q.lead_email || "Unknown";
}

function displayPrice(q: Quote) {
  const p = q.total_price || q.base_price;
  if (!p) return "—";
  return `$${parseFloat(p).toFixed(2)}`;
}

export default function QuotesPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState("all");
  const [search, setSearch] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: quotes = [], isLoading } = useQuery<Quote[]>({
    queryKey: ["quotes", activeTab],
    queryFn: () => apiFetch(`/api/quotes${activeTab !== "all" ? `?status=${activeTab}` : ""}`),
  });

  const { data: stats } = useQuery<Stats>({
    queryKey: ["quote-stats"],
    queryFn: () => apiFetch("/api/quotes/stats"),
  });

  const sendMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/quotes/${id}/send`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote-stats"] });
      toast.success("Quote marked as sent");
    },
    onError: () => toast.error("Failed to update quote"),
  });

  const convertMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/quotes/${id}/convert`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote-stats"] });
      toast.success("Quote converted to booking");
    },
    onError: () => toast.error("Failed to convert quote"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/quotes/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote-stats"] });
      toast.success("Quote deleted");
      setDeleteId(null);
    },
    onError: () => toast.error("Failed to delete quote"),
  });

  const filtered = quotes.filter(q => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      clientName(q).toLowerCase().includes(s) ||
      (q.address || "").toLowerCase().includes(s) ||
      (q.scope_name || "").toLowerCase().includes(s) ||
      (q.lead_email || "").toLowerCase().includes(s)
    );
  });

  const statCards = [
    { label: "Total Quotes", value: stats?.total ?? 0, icon: FileText, color: "text-[#5B9BD5]", bg: "bg-[#5B9BD5]/10" },
    { label: "Awaiting Response", value: stats?.pending ?? 0, icon: Send, color: "text-orange-500", bg: "bg-orange-50" },
    { label: "Accepted This Month", value: stats?.accepted_this_month ?? 0, icon: CheckCircle, color: "text-green-600", bg: "bg-green-50" },
    { label: "Converted to Jobs", value: stats?.converted ?? 0, icon: Briefcase, color: "text-purple-600", bg: "bg-purple-50" },
  ];

  return (
    <DashboardLayout>
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1917]">Quotes</h1>
          <p className="text-sm text-[#6B7280] mt-1">Manage and track client quotes.</p>
        </div>
        <Button
          className="gap-2 bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white"
          onClick={() => navigate("/quotes/new")}
        >
          <Plus className="w-4 h-4" />
          New Quote
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map(card => (
          <div key={card.label} className="bg-white border border-[#E5E2DC] rounded-lg p-4 flex items-center gap-3">
            <div className={`${card.bg} rounded-lg p-2`}>
              <card.icon className={`w-5 h-5 ${card.color}`} />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#1A1917]">{card.value}</p>
              <p className="text-xs text-[#9E9B94]">{card.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-[#E5E2DC] rounded-lg overflow-hidden">
        <div className="flex items-center gap-4 p-4 border-b border-[#E5E2DC]">
          <div className="flex gap-1">
            {TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? "bg-[#5B9BD5] text-white"
                    : "text-[#6B7280] hover:bg-[#F7F6F3]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="ml-auto relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#9E9B94]" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search quotes..."
              className="pl-9 h-8 w-52 text-sm"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-[#9E9B94]">Loading quotes...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <FileText className="w-10 h-10 text-[#9E9B94] mx-auto" />
            <p className="text-[#6B7280]">No quotes found.</p>
            <Button size="sm" className="bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white gap-1.5" onClick={() => navigate("/quotes/new")}>
              <Plus className="w-3.5 h-3.5" /> Create your first quote
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-[#F7F6F3]">
                <TableHead className="font-semibold text-[#1A1917]">Client</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Service</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Frequency</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Address</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Price</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Status</TableHead>
                <TableHead className="font-semibold text-[#1A1917]">Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(quote => {
                const cfg = STATUS_CONFIG[quote.status] ?? { label: quote.status, className: "bg-gray-100 text-gray-600" };
                return (
                  <TableRow key={quote.id} className="hover:bg-[#F7F6F3] cursor-pointer" onClick={() => navigate(`/quotes/${quote.id}`)}>
                    <TableCell>
                      <p className="font-medium text-[#1A1917] text-sm">{clientName(quote)}</p>
                      {quote.client_email || quote.lead_email ? (
                        <p className="text-xs text-[#9E9B94]">{quote.client_email || quote.lead_email}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm text-[#6B7280]">{quote.scope_name || "—"}</TableCell>
                    <TableCell className="text-sm text-[#6B7280]">{quote.frequency || "—"}</TableCell>
                    <TableCell className="text-sm text-[#6B7280] max-w-[180px] truncate">{quote.address || "—"}</TableCell>
                    <TableCell className="text-sm font-semibold text-[#1A1917]">{displayPrice(quote)}</TableCell>
                    <TableCell>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.className}`}>
                        {cfg.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-[#9E9B94]">
                      {format(new Date(quote.created_at), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => navigate(`/quotes/${quote.id}`)}>
                            <Pencil className="w-4 h-4 mr-2" /> Edit
                          </DropdownMenuItem>
                          {["draft", "viewed"].includes(quote.status) && (
                            <DropdownMenuItem onClick={() => sendMutation.mutate(quote.id)}>
                              <SendHorizonal className="w-4 h-4 mr-2" /> Mark as Sent
                            </DropdownMenuItem>
                          )}
                          {["sent", "viewed", "accepted"].includes(quote.status) && (
                            <DropdownMenuItem onClick={() => convertMutation.mutate(quote.id)}>
                              <ArrowRight className="w-4 h-4 mr-2" /> Convert to Booking
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem className="text-red-600" onClick={() => setDeleteId(quote.id)}>
                            <Trash2 className="w-4 h-4 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <AlertDialog open={deleteId !== null} onOpenChange={open => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Quote</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete the quote. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteId && deleteMutation.mutate(deleteId)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </DashboardLayout>
  );
}
