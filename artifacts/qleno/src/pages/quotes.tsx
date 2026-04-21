import { useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { getAuthHeaders } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
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
import {
  Plus, FileText, Send, CheckCircle, Briefcase, Search,
  MoreHorizontal, Pencil, Trash2, SendHorizonal, ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: { method?: string; body?: any; headers?: any } = {}) {
  const { body, headers: extraHeaders, ...rest } = opts;
  const r = await fetch(`${API}${path}`, { headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...extraHeaders }, ...rest, ...(body !== undefined && { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

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
  draft:    { label: "Draft",     className: "bg-[#F7F6F3] text-[#6B7280] border border-[#E5E2DC]" },
  sent:     { label: "Sent",      className: "bg-blue-50 text-blue-700 border border-blue-200" },
  viewed:   { label: "Viewed",    className: "bg-purple-50 text-purple-700 border border-purple-200" },
  accepted: { label: "Accepted",  className: "bg-green-50 text-green-700 border border-green-200" },
  declined: { label: "Declined",  className: "bg-red-50 text-red-700 border border-red-200" },
  booked:   { label: "Converted", className: "bg-[#5B9BD5]/10 text-[#5B9BD5] border border-[#5B9BD5]/30" },
  expired:  { label: "Expired",   className: "bg-orange-50 text-orange-700 border border-orange-200" },
};

const TABS = [
  { key: "all",      label: "All" },
  { key: "draft",    label: "Draft" },
  { key: "sent",     label: "Sent" },
  { key: "viewed",   label: "Viewed" },
  { key: "accepted", label: "Accepted" },
  { key: "booked",   label: "Converted" },
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

function SkeletonCard() {
  return (
    <div style={{ borderBottom: "1px solid #F0EEE9", padding: "16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div style={{ width: 130, height: 14, background: "#F0EDE8", borderRadius: 4 }} className="animate-pulse" />
        <div style={{ width: 60, height: 14, background: "#F0EDE8", borderRadius: 4 }} className="animate-pulse" />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div style={{ width: 100, height: 12, background: "#F0EDE8", borderRadius: 4 }} className="animate-pulse" />
        <div style={{ width: 50, height: 12, background: "#F0EDE8", borderRadius: 4 }} className="animate-pulse" />
      </div>
      <div style={{ width: 80, height: 11, background: "#F0EDE8", borderRadius: 4 }} className="animate-pulse" />
    </div>
  );
}

export default function QuotesPage() {
  const [, navigate] = useLocation();
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const { activeBranchId } = useBranch();
  const [activeTab, setActiveTab] = useState("all");
  const [search, setSearch] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: quotes = [], isLoading } = useQuery<Quote[]>({
    queryKey: ["quotes", activeTab, activeBranchId],
    queryFn: () => {
      const statusQ = activeTab !== "all" ? `status=${activeTab}` : "";
      const qs = [statusQ, activeBranchId !== "all" ? `branch_id=${activeBranchId}` : ""].filter(Boolean).join("&");
      return apiFetch(`/api/quotes${qs ? `?${qs}` : ""}`);
    },
  });

  const { data: stats } = useQuery<Stats>({
    queryKey: ["quote-stats", activeBranchId],
    queryFn: () => apiFetch(`/api/quotes/stats${activeBranchId !== "all" ? `?branch_id=${activeBranchId}` : ""}`),
  });

  const sendMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/quotes/${id}/send`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["quotes"] }); qc.invalidateQueries({ queryKey: ["quote-stats"] }); toast.success("Quote marked as sent"); },
    onError: () => toast.error("Failed to update quote"),
  });

  const convertMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/quotes/${id}/convert`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["quotes"] }); qc.invalidateQueries({ queryKey: ["quote-stats"] }); toast.success("Quote converted to booking"); },
    onError: () => toast.error("Failed to convert quote"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/quotes/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["quotes"] }); qc.invalidateQueries({ queryKey: ["quote-stats"] }); toast.success("Quote deleted"); setDeleteId(null); },
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
    { label: "Total Quotes",          value: stats?.total ?? 0,                icon: FileText,    color: "text-[#5B9BD5]",    bg: "bg-[#5B9BD5]/10" },
    { label: "Awaiting Response",     value: stats?.pending ?? 0,              icon: Send,        color: "text-orange-500",   bg: "bg-orange-50" },
    { label: "Accepted This Month",   value: stats?.accepted_this_month ?? 0,  icon: CheckCircle, color: "text-green-600",    bg: "bg-green-50" },
    { label: "Converted to Jobs",     value: stats?.converted ?? 0,            icon: Briefcase,   color: "text-purple-600",   bg: "bg-purple-50" },
  ];

  // ── Mobile layout ──────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <DashboardLayout>
        <div style={{ background: "#F7F6F3", minHeight: "100vh", fontFamily: FF }}>

          {/* Top bar */}
          <div style={{ padding: "16px 16px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", margin: 0 }}>Quotes</h1>
            <button
              onClick={() => { if (activeBranchId === "all") { toast.error("Select a location first — choose Oak Lawn or Schaumburg to create a quote."); return; } navigate("/quotes/new"); }}
              title={activeBranchId === "all" ? "Select a location to create quotes" : undefined}
              style={{ display: "flex", alignItems: "center", gap: 6, background: activeBranchId === "all" ? "#9E9B94" : "var(--brand)", color: "#FFF", border: "none", borderRadius: 8, padding: "10px 16px", fontSize: 14, fontWeight: 600, cursor: activeBranchId === "all" ? "not-allowed" : "pointer", fontFamily: FF, minHeight: 44, opacity: activeBranchId === "all" ? 0.75 : 1 }}
            >
              <Plus size={16} /> New Quote
            </button>
          </div>

          {/* Search bar */}
          <div style={{ padding: "12px 16px 0", position: "relative" }}>
            <Search size={16} style={{ position: "absolute", left: 28, top: "50%", transform: "translateY(-50%)", color: "#9E9B94", marginTop: 6 }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by client name or quote number."
              style={{ width: "100%", boxSizing: "border-box", paddingLeft: 38, paddingRight: 12, height: 44, border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 14, fontFamily: FF, color: "#1A1917", background: "#FFF", outline: "none" }}
            />
          </div>

          {/* Filter chips */}
          <div style={{ padding: "10px 16px 0", display: "flex", gap: 8, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
            {TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  flexShrink: 0, whiteSpace: "nowrap", padding: "7px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF, border: "1px solid",
                  borderColor: activeTab === tab.key ? "var(--brand)" : "#E5E2DC",
                  background: activeTab === tab.key ? "var(--brand)" : "#FFF",
                  color: activeTab === tab.key ? "#FFF" : "#6B6860",
                  minHeight: 36,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Card list */}
          <div style={{ marginTop: 12, background: "#FFF", borderTop: "1px solid #E5E2DC", borderBottom: "1px solid #E5E2DC" }}>
            {isLoading ? (
              <>{[1, 2, 3, 4, 5].map(i => <SkeletonCard key={i} />)}</>
            ) : filtered.length === 0 ? (
              <div style={{ padding: "48px 16px", textAlign: "center" }}>
                <FileText size={36} style={{ color: "#9E9B94", margin: "0 auto 12px" }} />
                <p style={{ fontSize: 14, color: "#6B6860", margin: "0 0 16px", fontFamily: FF }}>No quotes found.</p>
                <button
                  onClick={() => { if (activeBranchId === "all") { toast.error("Select a location first."); return; } navigate("/quotes/new"); }}
                  style={{ background: activeBranchId === "all" ? "#9E9B94" : "var(--brand)", color: "#FFF", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 14, fontWeight: 600, cursor: activeBranchId === "all" ? "not-allowed" : "pointer", fontFamily: FF }}
                >
                  <Plus size={14} style={{ verticalAlign: "middle", marginRight: 4 }} /> Create your first quote
                </button>
              </div>
            ) : (
              filtered.map(quote => {
                const cfg = STATUS_CONFIG[quote.status] ?? { label: quote.status, className: "bg-gray-100 text-gray-600" };
                return (
                  <div
                    key={quote.id}
                    onClick={() => navigate(`/quotes/${quote.id}`)}
                    style={{ borderBottom: "1px solid #F0EEE9", padding: "16px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 5 }}
                  >
                    {/* Row 1: client name + price */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{clientName(quote)}</span>
                      <span style={{ fontSize: 15, fontWeight: 600, color: "var(--brand)", fontFamily: FF }}>{displayPrice(quote)}</span>
                    </div>
                    {/* Row 2: scope + status pill */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 13, color: "#6B6860", fontFamily: FF }}>{quote.scope_name || "—"}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.className}`}>{cfg.label}</span>
                    </div>
                    {/* Row 3: date */}
                    <div style={{ fontSize: 12, color: "#6B6860", fontFamily: FF }}>
                      {format(new Date(quote.created_at), "MMM d, yyyy")}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <AlertDialog open={deleteId !== null} onOpenChange={open => !open && setDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Quote</AlertDialogTitle>
              <AlertDialogDescription>This will permanently delete the quote. This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteId && deleteMutation.mutate(deleteId)}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DashboardLayout>
    );
  }

  // ── Desktop layout ─────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[#1A1917]">Quotes</h1>
            <p className="text-sm text-[#6B7280] mt-1">Manage and track client quotes.</p>
          </div>
          <Button
            className={`gap-2 text-white ${activeBranchId === "all" ? "bg-gray-400 cursor-not-allowed hover:bg-gray-400" : "bg-[#5B9BD5] hover:bg-[#4a8ac4]"}`}
            title={activeBranchId === "all" ? "Select a location to create quotes" : undefined}
            onClick={() => { if (activeBranchId === "all") { toast.error("Select a location first — choose Oak Lawn or Schaumburg."); return; } navigate("/quotes/new"); }}
          >
            <Plus className="w-4 h-4" />
            New Quote
            {activeBranchId !== "all" && <kbd style={{ fontSize: 10, border: "1px solid rgba(255,255,255,0.45)", borderRadius: 3, padding: "1px 5px", color: "rgba(255,255,255,0.8)", marginLeft: 2, fontFamily: "inherit" }}>⇧Q</kbd>}
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {statCards.map(card => (
            <div key={card.label} className="bg-white border border-[#E5E2DC] rounded-lg p-4 flex items-center gap-3">
              <div className={`${card.bg} rounded-lg p-2`}><card.icon className={`w-5 h-5 ${card.color}`} /></div>
              <div>
                <p className="text-2xl font-bold text-[#1A1917]">{card.value}</p>
                <p className="text-xs text-[#9E9B94]">{card.label}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-white border border-[#E5E2DC] rounded-lg overflow-hidden">
          <div className="flex items-center gap-3 p-4 border-b border-[#E5E2DC]">
            <div className="flex gap-1 overflow-x-auto">
              {TABS.map(tab => (
                <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{ whiteSpace: "nowrap" }}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex-shrink-0 ${activeTab === tab.key ? "bg-[#5B9BD5] text-white" : "text-[#6B7280] hover:bg-[#F7F6F3]"}`}>
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="relative ml-auto">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#9E9B94]" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search quotes..." className="pl-9 h-8 text-sm w-52" />
            </div>
          </div>

          {isLoading ? (
            <div className="p-8 text-center text-[#9E9B94]">Loading quotes...</div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center space-y-3">
              <FileText className="w-10 h-10 text-[#9E9B94] mx-auto" />
              <p className="text-[#6B7280]">No quotes found.</p>
              <Button
                size="sm"
                className={`text-white gap-1.5 ${activeBranchId === "all" ? "bg-gray-400 cursor-not-allowed hover:bg-gray-400" : "bg-[#5B9BD5] hover:bg-[#4a8ac4]"}`}
                onClick={() => { if (activeBranchId === "all") { toast.error("Select a location first."); return; } navigate("/quotes/new"); }}
              >
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
                        {(quote.client_email || quote.lead_email) && <p className="text-xs text-[#9E9B94]">{quote.client_email || quote.lead_email}</p>}
                      </TableCell>
                      <TableCell className="text-sm text-[#6B7280]">{quote.scope_name || "—"}</TableCell>
                      <TableCell className="text-sm text-[#6B7280]">{quote.frequency || "—"}</TableCell>
                      <TableCell className="text-sm text-[#6B7280] max-w-[180px] truncate">{quote.address || "—"}</TableCell>
                      <TableCell className="text-sm font-semibold text-[#1A1917]">{displayPrice(quote)}</TableCell>
                      <TableCell><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.className}`}>{cfg.label}</span></TableCell>
                      <TableCell className="text-sm text-[#9E9B94]">{format(new Date(quote.created_at), "MMM d, yyyy")}</TableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0"><MoreHorizontal className="w-4 h-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => navigate(`/quotes/${quote.id}/edit`)}><Pencil className="w-4 h-4 mr-2" /> Edit</DropdownMenuItem>
                            {["draft", "viewed"].includes(quote.status) && (
                              <DropdownMenuItem onClick={() => sendMutation.mutate(quote.id)}><SendHorizonal className="w-4 h-4 mr-2" /> Mark as Sent</DropdownMenuItem>
                            )}
                            {["sent", "viewed", "accepted"].includes(quote.status) && (
                              <DropdownMenuItem onClick={() => convertMutation.mutate(quote.id)}><ArrowRight className="w-4 h-4 mr-2" /> Convert to Booking</DropdownMenuItem>
                            )}
                            <DropdownMenuItem className="text-red-600" onClick={() => setDeleteId(quote.id)}><Trash2 className="w-4 h-4 mr-2" /> Delete</DropdownMenuItem>
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
      </div>

      <AlertDialog open={deleteId !== null} onOpenChange={open => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Quote</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete the quote. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteId && deleteMutation.mutate(deleteId)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}
