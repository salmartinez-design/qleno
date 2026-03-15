import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { Plus, Search, Send, Download, Layers, X, Check, CheckSquare, Square, AlertCircle, Calendar } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { CloseDayModal } from "@/components/close-day-modal";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const STATUS_STYLES: Record<string, React.CSSProperties> = {
  paid:    { background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0" },
  overdue: { background: "#FEE2E2", color: "#991B1B", border: "1px solid #FECACA" },
  draft:   { background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB" },
  sent:    { background: "#DBEAFE", color: "#1E40AF", border: "1px solid #BFDBFE" },
};

function BatchInvoiceDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [autoSend, setAutoSend] = useState(false);
  const [autoCharge, setAutoCharge] = useState(false);
  const [search, setSearch] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number; current: string; errors: number } | null>(null);
  const [summary, setSummary] = useState<{ created: number; sent: number; charged: number; errors: number } | null>(null);

  const { data: rawJobs = [], isLoading } = useQuery({
    queryKey: ["uninvoiced-jobs"],
    queryFn: () => apiFetch("/api/jobs?status=complete&uninvoiced=true&limit=200"),
  });

  const jobs: any[] = useMemo(() => {
    const arr = Array.isArray(rawJobs) ? rawJobs : (rawJobs?.data || []);
    if (!search.trim()) return arr;
    return arr.filter((j: any) => (j.client_name || "").toLowerCase().includes(search.toLowerCase()));
  }, [rawJobs, search]);

  const allJobs: any[] = Array.isArray(rawJobs) ? rawJobs : (rawJobs?.data || []);
  const allSelected = allJobs.length > 0 && selected.size === allJobs.length;

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allJobs.map((j: any) => j.id)));
  }

  function toggle(id: number) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const selectedTotal = useMemo(() => {
    return allJobs
      .filter((j: any) => selected.has(j.id))
      .reduce((sum: number, j: any) => sum + parseFloat(j.base_fee || "0"), 0);
  }, [allJobs, selected]);

  async function handleGenerate() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    let created = 0; let sent = 0; let charged = 0; let errors = 0;
    setProgress({ done: 0, total: ids.length, current: "", errors: 0 });

    for (const jobId of ids) {
      const job = allJobs.find((j: any) => j.id === jobId);
      setProgress(p => p ? { ...p, current: job?.client_name || `Job #${jobId}` } : null);
      try {
        await apiFetch("/api/invoices", {
          method: "POST",
          body: JSON.stringify({ job_id: jobId, auto_send: autoSend, auto_charge: autoCharge }),
        });
        created++;
        if (autoSend) sent++;
        if (autoCharge) charged++;
      } catch { errors++; }
      setProgress(p => p ? { ...p, done: created + errors, errors } : null);
    }
    setSummary({ created, sent, charged, errors });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["uninvoiced-jobs"] });
    if (errors === 0) toast({ title: `${created} invoice${created !== 1 ? "s" : ""} created successfully` });
  }

  const TOGGLE_ROW: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 0",
    borderBottom: "1px solid #F0EDE8",
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", zIndex: 1000 }} onClick={onClose} />
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: "100%", maxWidth: 520,
        backgroundColor: "#FFFFFF", zIndex: 1001, display: "flex", flexDirection: "column",
        boxShadow: "-4px 0 24px rgba(0,0,0,0.12)", fontFamily: FF,
      }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #EEECE7", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#1A1917" }}>Batch Invoice</h2>
              <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>Select completed jobs to invoice</p>
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}>
              <X size={20} />
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {summary ? (
            <div style={{ padding: 32, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, flex: 1 }}>
              <div style={{ width: 64, height: 64, backgroundColor: "#D1FAE5", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Check size={30} style={{ color: "#16A34A" }} />
              </div>
              <div style={{ textAlign: "center" }}>
                <h3 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: "#1A1917" }}>Batch Complete</h3>
                <p style={{ margin: 0, fontSize: 13, color: "#6B7280" }}>All invoices have been processed</p>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, width: "100%" }}>
                {[
                  { label: "Invoices Created", value: summary.created, color: "#1A1917", bg: "#F0F7FF" },
                  ...(autoSend ? [{ label: "Emails Sent", value: summary.sent, color: "#1D4ED8", bg: "#DBEAFE" }] : []),
                  ...(autoCharge ? [{ label: "Payments Collected", value: summary.charged, color: "#16A34A", bg: "#DCFCE7" }] : []),
                  ...(summary.errors > 0 ? [{ label: "Failed / Skipped", value: summary.errors, color: "#DC2626", bg: "#FEE2E2" }] : []),
                ].map(s => (
                  <div key={s.label} style={{ backgroundColor: s.bg, borderRadius: 10, padding: "18px 16px", textAlign: "center" }}>
                    <div style={{ fontSize: 32, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: s.color, opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 6 }}>{s.label}</div>
                  </div>
                ))}
              </div>
              <button onClick={() => { onDone(); onClose(); }}
                style={{ width: "100%", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "12px", fontSize: 13, fontWeight: 700, cursor: "pointer", marginTop: "auto" }}>
                Done
              </button>
            </div>
          ) : progress ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, padding: 32 }}>
              <div style={{ width: "100%", textAlign: "center" }}>
                <p style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", margin: "0 0 6px" }}>Creating invoices...</p>
                <p style={{ fontSize: 13, color: "#6B7280", margin: "0 0 16px" }}>
                  {progress.current ? `Invoicing ${progress.current}` : "Processing..."}
                </p>
                <div style={{ width: "100%", height: 8, backgroundColor: "#F0EDE8", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", backgroundColor: "var(--brand)", borderRadius: 99, width: `${(progress.done / progress.total) * 100}%`, transition: "width 0.3s" }} />
                </div>
                <p style={{ fontSize: 13, color: "#9E9B94", marginTop: 10 }}>{progress.done} of {progress.total}</p>
                {progress.errors > 0 && <p style={{ fontSize: 12, color: "#DC2626" }}>{progress.errors} error(s) so far</p>}
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "12px 24px", borderBottom: "1px solid #EEECE7", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <button onClick={toggleAll} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", color: allSelected ? "var(--brand)" : "#9E9B94", fontSize: 13, fontWeight: 600 }}>
                  {allSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                  Select All
                </button>
                <span style={{ fontSize: 12, color: "#9E9B94" }}>
                  {allJobs.length} job{allJobs.length !== 1 ? "s" : ""} ready to invoice
                </span>
                <div style={{ position: "relative", flex: 1, maxWidth: 180 }}>
                  <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#9E9B94" }} />
                  <input placeholder="Filter by client..." value={search} onChange={e => setSearch(e.target.value)}
                    style={{ paddingLeft: 30, paddingRight: 10, height: 32, width: "100%", backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, fontFamily: FF, boxSizing: "border-box" as const }} />
                </div>
              </div>

              <div style={{ flex: 1, overflowY: "auto" }}>
                {isLoading ? (
                  <div style={{ textAlign: "center", color: "#9E9B94", padding: 40 }}>Loading completed jobs...</div>
                ) : allJobs.length === 0 ? (
                  <div style={{ textAlign: "center", padding: 48 }}>
                    <AlertCircle size={36} style={{ color: "#C4C0BB", marginBottom: 12 }} />
                    <p style={{ fontSize: 14, fontWeight: 600, color: "#6B7280", margin: "0 0 4px" }}>No uninvoiced completed jobs</p>
                    <p style={{ fontSize: 12, color: "#9E9B94", margin: 0 }}>All completed jobs already have invoices.</p>
                  </div>
                ) : jobs.length === 0 ? (
                  <div style={{ textAlign: "center", padding: 32, color: "#9E9B94", fontSize: 13 }}>No jobs match your search.</div>
                ) : (
                  jobs.map((j: any, i: number) => {
                    const fee = parseFloat(j.base_fee || "0");
                    const isSelected = selected.has(j.id);
                    return (
                      <div key={j.id} onClick={() => toggle(j.id)}
                        style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 24px", borderBottom: i < jobs.length - 1 ? "1px solid #F0EDE8" : "none", cursor: "pointer", backgroundColor: isSelected ? "#F0F7FF" : "transparent", transition: "background 0.1s" }}>
                        <span style={{ color: isSelected ? "var(--brand)" : "#C4C0BB", flexShrink: 0 }}>
                          {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#1A1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {j.client_name || `Client #${j.client_id}`}
                          </p>
                          <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9E9B94" }}>
                            {j.scheduled_date ? new Date(j.scheduled_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "—"}
                            {j.service_type ? ` · ${j.service_type.replace(/_/g, " ")}` : ""}
                            {j.assigned_user_name ? ` · ${j.assigned_user_name.split(" ")[0]}` : ""}
                          </p>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          {fee > 0 ? (
                            <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>${fee.toFixed(2)}</span>
                          ) : (
                            <span style={{ fontSize: 12, color: "#DC2626" }}>No amount set</span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {!progress && !summary && (
          <div style={{ padding: "16px 24px", borderTop: "1px solid #EEECE7", flexShrink: 0, backgroundColor: "#FAFAF9" }}>
            <div style={TOGGLE_ROW}>
              <div>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1A1917" }}>Auto-Send</p>
                <p style={{ margin: "2px 0 0", fontSize: 11, color: autoSend ? "#1D4ED8" : "#9E9B94" }}>
                  {autoSend ? "Invoice will be sent via email using your Resend account" : "Email invoice to client automatically"}
                </p>
              </div>
              <label style={{ position: "relative", display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={autoSend} onChange={e => setAutoSend(e.target.checked)} style={{ display: "none" }} />
                <div style={{ width: 42, height: 24, backgroundColor: autoSend ? "var(--brand)" : "#E5E2DC", borderRadius: 12, position: "relative", transition: "background 0.2s" }}>
                  <div style={{ position: "absolute", top: 3, left: autoSend ? 21 : 3, width: 18, height: 18, backgroundColor: "#FFFFFF", borderRadius: 9, boxShadow: "0 1px 4px rgba(0,0,0,0.2)", transition: "left 0.2s" }} />
                </div>
              </label>
            </div>
            <div style={TOGGLE_ROW}>
              <div>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1A1917" }}>Auto-Charge</p>
                <p style={{ margin: "2px 0 0", fontSize: 11, color: autoCharge ? "#D97706" : "#9E9B94" }}>
                  {autoCharge ? "Client must have a saved payment method. Failed charges will be skipped and flagged." : "Charge card on file automatically"}
                </p>
              </div>
              <label style={{ position: "relative", display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={autoCharge} onChange={e => setAutoCharge(e.target.checked)} style={{ display: "none" }} />
                <div style={{ width: 42, height: 24, backgroundColor: autoCharge ? "#D97706" : "#E5E2DC", borderRadius: 12, position: "relative", transition: "background 0.2s" }}>
                  <div style={{ position: "absolute", top: 3, left: autoCharge ? 21 : 3, width: 18, height: 18, backgroundColor: "#FFFFFF", borderRadius: 9, boxShadow: "0 1px 4px rgba(0,0,0,0.2)", transition: "left 0.2s" }} />
                </div>
              </label>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, marginTop: 8 }}>
              <span style={{ fontSize: 13, color: "#6B7280", fontWeight: 600 }}>
                {selected.size} job{selected.size !== 1 ? "s" : ""} selected
              </span>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>
                Total: ${selectedTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <button
              onClick={handleGenerate}
              disabled={selected.size === 0}
              style={{ width: "100%", backgroundColor: selected.size === 0 ? "#C4C0BB" : "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "12px", fontSize: 13, fontWeight: 700, cursor: selected.size === 0 ? "default" : "pointer", marginBottom: 8 }}>
              Generate Invoice{selected.size !== 1 ? "s" : ""} {selected.size > 0 ? `(${selected.size})` : ""}
            </button>
            <button onClick={onClose} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#9E9B94", padding: "6px 0" }}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </>
  );
}

type TabId = "all" | "draft" | "sent" | "paid" | "overdue";

export default function InvoicesPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabId>("all");
  const [search, setSearch] = useState("");
  const [showBatch, setShowBatch] = useState(false);
  const [showCloseDay, setShowCloseDay] = useState(false);

  const token = useAuthStore(state => state.token) || "";
  let userRole = "office";
  try { userRole = JSON.parse(atob(token.split(".")[1])).role || "office"; } catch {}
  const canAdmin = userRole === "owner" || userRole === "admin";

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["invoices", activeTab],
    queryFn: () => apiFetch(`/api/invoices${activeTab !== "all" ? `?status=${activeTab}` : ""}`),
  });

  const tabs: { id: TabId; label: string }[] = [
    { id: "all", label: "All" },
    { id: "draft", label: "Drafts" },
    { id: "sent", label: "Sent" },
    { id: "paid", label: "Paid" },
    { id: "overdue", label: "Overdue" },
  ];

  const invoices = ((data?.data || []) as any[]).filter((i: any) =>
    !search || (i.client_name || "").toLowerCase().includes(search.toLowerCase()) || (i.invoice_number || "").toLowerCase().includes(search.toLowerCase())
  );

  const stats = data?.stats || {};

  const TH: React.CSSProperties = {
    padding: "11px 18px", textAlign: "left",
    fontSize: "11px", fontWeight: 600, color: "#9E9B94",
    textTransform: "uppercase", letterSpacing: "0.06em",
    borderBottom: "1px solid #EEECE7",
    fontFamily: FF,
  };

  const CARD: React.CSSProperties = {
    backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC",
    borderRadius: 10, padding: "20px",
    fontFamily: FF,
  };

  return (
    <>
      <DashboardLayout>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, fontFamily: FF }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            {[
              { label: "Outstanding", value: `$${Math.round(stats.total_outstanding || 0).toLocaleString()}` },
              { label: "Overdue",     value: `$${Math.round(stats.total_overdue || 0).toLocaleString()}`, color: (stats.total_overdue || 0) > 0 ? "#DC2626" : undefined },
              { label: "Paid (30d)",  value: `$${Math.round(stats.total_paid || 0).toLocaleString()}`,   color: "#16A34A" },
              { label: "YTD Revenue", value: `$${Math.round(stats.total_revenue || 0).toLocaleString()}`, accent: true },
            ].map(c => (
              <div key={c.label} style={{ ...CARD, border: c.accent ? "1px solid rgba(91,155,213,0.4)" : "1px solid #E5E2DC" }}>
                <p style={{ fontSize: 11, fontWeight: 600, color: c.accent ? "var(--brand)" : "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 10px" }}>{c.label}</p>
                <p style={{ fontSize: 24, fontWeight: 800, color: c.color || (c.accent ? "var(--brand)" : "#1A1917"), margin: 0 }}>{c.value}</p>
              </div>
            ))}
          </div>

          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid #EEECE7", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 4, backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: 4 }}>
                {tabs.map(tab => {
                  const isActive = activeTab === tab.id;
                  return (
                    <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                      style={{ padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: isActive ? 700 : 400, border: "none", backgroundColor: isActive ? "var(--brand)" : "transparent", color: isActive ? "#FFFFFF" : "#6B7280", transition: "all 0.15s", fontFamily: FF }}>
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ position: "relative" }}>
                  <Search size={13} strokeWidth={1.5} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#9E9B94" }} />
                  <input placeholder="Search invoices..." value={search} onChange={e => setSearch(e.target.value)}
                    style={{ paddingLeft: 32, paddingRight: 10, height: 36, width: 200, backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, color: "#1A1917", fontSize: 13, outline: "none", fontFamily: FF }} />
                </div>
                {canAdmin && (
                  <>
                    <button onClick={() => setShowCloseDay(true)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 13px", backgroundColor: "transparent", color: "#1A1917", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                      <Calendar size={14} strokeWidth={2} /> Close Day
                    </button>
                    <button onClick={() => setShowBatch(true)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 13px", backgroundColor: "#F7F6F3", color: "var(--brand)", border: "1px solid var(--brand)", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                      <Layers size={14} strokeWidth={2} /> Batch Invoice
                    </button>
                  </>
                )}
                <button style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 13px", backgroundColor: "var(--brand)", color: "#FFFFFF", borderRadius: 8, fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer", fontFamily: FF }}>
                  <Plus size={14} strokeWidth={2} /> New Invoice
                </button>
              </div>
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Invoice #", "Client", "Amount", "Due Date", "Days Overdue", "Status", ""].map(h => (
                    <th key={h} style={{ ...TH, textAlign: h === "" ? "right" as const : "left" as const }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={7} style={{ padding: 32, textAlign: "center", color: "#6B7280", fontSize: 13 }}>Loading invoices...</td></tr>
                ) : invoices.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 48, textAlign: "center" }}>
                      <AlertCircle size={28} style={{ color: "#C4C0BB", marginBottom: 10 }} />
                      <p style={{ color: "#6B7280", fontSize: 13, margin: 0 }}>No invoices found.</p>
                    </td>
                  </tr>
                ) : invoices.map((inv: any) => {
                  const effectiveStatus = (inv.status === "sent" && inv.due_date && new Date(inv.due_date) < new Date()) ? "overdue" : inv.status;
                  const s = STATUS_STYLES[effectiveStatus] || STATUS_STYLES.draft;
                  return (
                    <tr key={inv.id}
                      onClick={() => navigate(`/invoices/${inv.id}`)}
                      style={{ borderBottom: "1px solid #F0EEE9", cursor: "pointer" }}
                      onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#F7F6F3")}
                      onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}>
                      <td style={{ padding: "13px 18px", fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>
                        {inv.invoice_number || `INV-${String(inv.id).padStart(4, "0")}`}
                      </td>
                      <td style={{ padding: "13px 18px", fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>{inv.client_name}</td>
                      <td style={{ padding: "13px 18px", fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>${(inv.total || 0).toFixed(2)}</td>
                      <td style={{ padding: "13px 18px", fontSize: 12, color: "#6B7280", fontFamily: FF }}>
                        {inv.due_date ? new Date(inv.due_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                      </td>
                      <td style={{ padding: "13px 18px" }}>
                        {effectiveStatus === "overdue" && (inv.days_overdue || 0) > 0 ? (
                          <span style={{ background: "#FEE2E2", color: "#991B1B", border: "1px solid #FECACA", display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: FF }}>
                            {inv.days_overdue}d overdue
                          </span>
                        ) : "—"}
                      </td>
                      <td style={{ padding: "13px 18px" }}>
                        <span style={{ ...s, display: "inline-flex", alignItems: "center", padding: "3px 9px", borderRadius: 4, fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: FF }}>
                          {effectiveStatus}
                        </span>
                      </td>
                      <td style={{ padding: "13px 18px", textAlign: "right" }} onClick={e => e.stopPropagation()}>
                        <button style={{ padding: 5, border: "none", backgroundColor: "transparent", color: "#9E9B94", cursor: "pointer", borderRadius: 4 }}>
                          <Download size={14} strokeWidth={1.5} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </DashboardLayout>

      {showBatch && <BatchInvoiceDrawer onClose={() => setShowBatch(false)} onDone={() => refetch()} />}
      {showCloseDay && <CloseDayModal onClose={() => setShowCloseDay(false)} onOpenBatchInvoice={() => setShowBatch(true)} />}
    </>
  );
}
