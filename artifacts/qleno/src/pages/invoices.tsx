import { useState, useMemo, useEffect } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLocation } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { Plus, Search, Send, Download, Layers, X, Check, CheckSquare, Square, AlertCircle, Calendar, ChevronDown, DollarSign, RotateCcw, ChevronUp } from "lucide-react";
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

const LABEL_STYLE: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6, fontFamily: FF };
const INPUT_STYLE: React.CSSProperties = { width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: FF, color: "#1A1917" };

function NewInvoiceModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [clientSearch, setClientSearch] = useState("");
  const [clientId, setClientId] = useState<number | null>(null);
  const [clientName, setClientName] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [paymentTerms, setPaymentTerms] = useState("due_on_receipt");
  const [poNumber, setPoNumber] = useState("");
  const [lineItems, setLineItems] = useState([{ description: "", quantity: 1, unit_price: 0 }]);
  const [saving, setSaving] = useState(false);

  const { data: rawClients } = useQuery({
    queryKey: ["client-search-invoice", clientSearch],
    queryFn: () => apiFetch(`/api/clients?search=${encodeURIComponent(clientSearch)}&limit=20`),
    enabled: clientSearch.length >= 1,
  });
  const clients: any[] = useMemo(() => {
    const arr = Array.isArray(rawClients) ? rawClients : (rawClients?.data || rawClients?.clients || []);
    return arr.slice(0, 8);
  }, [rawClients]);

  const subtotal = lineItems.reduce((s, item) => s + item.quantity * item.unit_price, 0);

  function updateItem(idx: number, field: string, val: any) {
    setLineItems(prev => prev.map((item, i) => i === idx ? { ...item, [field]: val } : item));
  }

  async function handleSave() {
    if (!clientId) { toast({ title: "Select a client first", variant: "destructive" }); return; }
    if (!lineItems.some(i => i.description.trim())) { toast({ title: "Add at least one line item", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await apiFetch("/api/invoices", {
        method: "POST",
        body: JSON.stringify({
          client_id: clientId,
          line_items: lineItems.filter(i => i.description.trim()).map(i => ({
            description: i.description, quantity: i.quantity,
            rate: i.unit_price, total: i.quantity * i.unit_price,
          })),
          payment_terms: paymentTerms,
          po_number: poNumber || undefined,
        }),
      });
      toast({ title: "Invoice saved as draft" });
      onDone();
      onClose();
    } catch (e: any) {
      toast({ title: e.message || "Failed to create invoice", variant: "destructive" });
    }
    setSaving(false);
  }

  const overlay: React.CSSProperties = { position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 };
  const modal: React.CSSProperties = { backgroundColor: "#FFFFFF", borderRadius: 14, padding: 28, width: 600, maxWidth: "95vw", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.22)", fontFamily: FF };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#1A1917", fontFamily: FF }}>New Invoice</h2>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={LABEL_STYLE}>Client</label>
          {clientId ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", border: "1.5px solid var(--brand)", borderRadius: 8, backgroundColor: "var(--brand-dim, #f0fdf9)" }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{clientName}</span>
              <button onClick={() => { setClientId(null); setClientName(""); setClientSearch(""); }} style={{ border: "none", background: "transparent", cursor: "pointer", color: "#9E9B94" }}><X size={14} /></button>
            </div>
          ) : (
            <div style={{ position: "relative" }}>
              <Search size={13} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#9E9B94", pointerEvents: "none" }} />
              <input value={clientSearch} onChange={e => { setClientSearch(e.target.value); setShowDropdown(true); }}
                onFocus={() => setShowDropdown(true)}
                onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
                placeholder="Search by name or email..."
                style={{ ...INPUT_STYLE, paddingLeft: 34 }} />
              {showDropdown && clients.length > 0 && (
                <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "#FFFFFF", boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 10, maxHeight: 220, overflowY: "auto" }}>
                  {clients.map((c: any) => (
                    <div key={c.id}
                      onMouseDown={e => { e.preventDefault(); setClientId(c.id); setClientName(`${c.first_name} ${c.last_name}`); setClientSearch(""); setShowDropdown(false); }}
                      style={{ padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #F0EEE9" }}
                      onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#F7F6F3")}
                      onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{c.first_name} {c.last_name}</div>
                      {c.email && <div style={{ fontSize: 11, color: "#9E9B94" }}>{c.email}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
          <div>
            <label style={LABEL_STYLE}>Payment Terms</label>
            <div style={{ position: "relative" }}>
              <select value={paymentTerms} onChange={e => setPaymentTerms(e.target.value)}
                style={{ ...INPUT_STYLE, appearance: "none", paddingRight: 32, cursor: "pointer" }}>
                <option value="due_on_receipt">Due on Receipt</option>
                <option value="net_15">Net 15</option>
                <option value="net_30">Net 30</option>
                <option value="net_45">Net 45</option>
              </select>
              <ChevronDown size={13} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "#9E9B94", pointerEvents: "none" }} />
            </div>
          </div>
          <div>
            <label style={LABEL_STYLE}>PO Number (optional)</label>
            <input value={poNumber} onChange={e => setPoNumber(e.target.value)} placeholder="e.g. PO-0042" style={INPUT_STYLE} />
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={LABEL_STYLE}>Line Items</label>
          <div style={{ border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 110px 32px", gap: 0, padding: "7px 12px 5px", backgroundColor: "#F7F6F3", borderBottom: "1px solid #E5E2DC" }}>
              {["Description", "Qty", "Unit Price", ""].map(h => (
                <span key={h} style={{ fontSize: 10, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: FF }}>{h}</span>
              ))}
            </div>
            {lineItems.map((item, idx) => (
              <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 70px 110px 32px", gap: 6, padding: "8px 12px", borderBottom: idx < lineItems.length - 1 ? "1px solid #F0EEE9" : "none", alignItems: "center" }}>
                <input value={item.description} onChange={e => updateItem(idx, "description", e.target.value)} placeholder="Service description"
                  style={{ padding: "6px 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, outline: "none", fontFamily: FF, color: "#1A1917" }} />
                <input type="number" value={item.quantity} min={1} onChange={e => updateItem(idx, "quantity", Math.max(1, parseFloat(e.target.value) || 1))}
                  style={{ padding: "6px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, outline: "none", textAlign: "center", fontFamily: FF, color: "#1A1917" }} />
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#9E9B94", fontSize: 12 }}>$</span>
                  <input type="number" value={item.unit_price} min={0} step={0.01} onChange={e => updateItem(idx, "unit_price", parseFloat(e.target.value) || 0)}
                    style={{ padding: "6px 9px 6px 20px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 12, outline: "none", width: "100%", boxSizing: "border-box", fontFamily: FF, color: "#1A1917" }} />
                </div>
                <button onClick={() => setLineItems(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev)}
                  style={{ border: "none", background: "transparent", cursor: lineItems.length > 1 ? "pointer" : "default", color: lineItems.length > 1 ? "#9E9B94" : "#D0CEC9", padding: 4, display: "flex", alignItems: "center" }}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <button onClick={() => setLineItems(prev => [...prev, { description: "", quantity: 1, unit_price: 0 }])}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 8, padding: "5px 12px", border: "1px dashed #D0CEC9", borderRadius: 7, fontSize: 12, fontWeight: 600, color: "#6B7280", background: "transparent", cursor: "pointer", fontFamily: FF }}>
            <Plus size={11} /> Add Line Item
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div />
          <div style={{ textAlign: "right", marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3, fontFamily: FF }}>Total</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "#1A1917", fontFamily: FF }}>${subtotal.toFixed(2)}</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", borderTop: "1px solid #F0EEE9", paddingTop: 18 }}>
          <button onClick={onClose} style={{ padding: "9px 20px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "#FFFFFF", cursor: "pointer", fontFamily: FF, color: "#1A1917" }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !clientId}
            style={{ padding: "9px 22px", background: saving || !clientId ? "#D0CEC9" : "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: saving || !clientId ? "not-allowed" : "pointer", fontFamily: FF }}>
            {saving ? "Saving..." : "Save as Draft"}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<TabId>("all");
  const [search, setSearch] = useState("");
  const [showBatch, setShowBatch] = useState(false);
  const [showCloseDay, setShowCloseDay] = useState(false);
  const [showNewInvoice, setShowNewInvoice] = useState(false);
  useEffect(() => {
    if (window.location.search.includes('new=1')) {
      setShowNewInvoice(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const token = useAuthStore(state => state.token) || "";
  let userRole = "office";
  try { userRole = JSON.parse(atob(token.split(".")[1])).role || "office"; } catch {}
  const canAdmin = userRole === "owner" || userRole === "admin";
  const { activeBranchId } = useBranch();

  const [readyExpanded, setReadyExpanded] = useState(true);
  const [failedExpanded, setFailedExpanded] = useState(true);
  const [chargingJobId, setChargingJobId] = useState<number | null>(null);

  const { data: readyData, refetch: refetchReady } = useQuery({
    queryKey: ["ready-to-charge"],
    queryFn: () => apiFetch("/api/jobs/ready-to-charge"),
    enabled: canAdmin,
  });
  const readyJobs: any[] = readyData?.data || [];

  const { data: failedData, refetch: refetchFailed } = useQuery({
    queryKey: ["failed-payments"],
    queryFn: () => apiFetch("/api/payments/failed"),
    enabled: canAdmin,
  });
  const failedPayments: any[] = failedData?.data || [];

  async function chargeJob(jobId: number) {
    setChargingJobId(jobId);
    try {
      const r = await fetch(`${API}/api/jobs/${jobId}/charge`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Charge failed");
      const brand = d.card_brand ? (d.card_brand.charAt(0).toUpperCase() + d.card_brand.slice(1)) : "Card";
      toast({ title: `Payment collected`, description: `${brand} •••• ${d.card_last_four || "????"} charged $${Number(d.amount).toFixed(2)}` });
      refetchReady();
      refetchFailed();
      refetch();
    } catch (err: any) {
      toast({ title: "Charge failed", description: err.message, variant: "destructive" });
    } finally {
      setChargingJobId(null);
    }
  }

  const buildInvoicesUrl = () => {
    const params = new URLSearchParams();
    if (activeTab !== "all") params.set("status", activeTab);
    if (activeBranchId !== "all") params.set("branch_id", String(activeBranchId));
    const qs = params.toString();
    return `/api/invoices${qs ? `?${qs}` : ""}`;
  };

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["invoices", activeTab, activeBranchId],
    queryFn: () => apiFetch(buildInvoicesUrl()),
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
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 12 }}>
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

          {/* ── Ready to Charge ──────────────────────────────────────────────── */}
          {canAdmin && readyJobs.length > 0 && (
            <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #6EE7B7", borderRadius: 10, overflow: "hidden" }}>
              <button onClick={() => setReadyExpanded(e => !e)}
                style={{ width: "100%", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", cursor: "pointer", fontFamily: FF }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <DollarSign size={14} style={{ color: "#059669" }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#065F46" }}>Ready to Charge ({readyJobs.length})</span>
                  <span style={{ fontSize: 11, color: "#6B7280" }}>— completed Stripe jobs awaiting payment</span>
                </div>
                {readyExpanded ? <ChevronUp size={14} color="#6B7280" /> : <ChevronDown size={14} color="#6B7280" />}
              </button>
              {readyExpanded && (
                <div style={{ borderTop: "1px solid #D1FAE5" }}>
                  {readyJobs.map((job: any) => (
                    <div key={job.id} style={{ padding: "12px 16px", borderBottom: "1px solid #F0FDF4", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 160 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>{job.client_name}</div>
                        <div style={{ fontSize: 11, color: "#6B7280", fontFamily: FF }}>
                          {job.service_type} · {job.scheduled_date ? new Date(job.scheduled_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}
                          {job.card_brand ? ` · ${job.card_brand.charAt(0).toUpperCase()}${job.card_brand.slice(1)} ••••${job.card_last_four}` : ""}
                        </div>
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: "#065F46", fontFamily: FF }}>${Number(job.amount || 0).toFixed(2)}</div>
                      <button
                        onClick={() => chargeJob(job.id)}
                        disabled={chargingJobId === job.id}
                        style={{ padding: "7px 14px", border: "none", borderRadius: 7, backgroundColor: "#059669", color: "#FFFFFF", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FF, opacity: chargingJobId === job.id ? 0.6 : 1 }}>
                        {chargingJobId === job.id ? "Charging..." : "Charge Now"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Failed Payments ───────────────────────────────────────────────── */}
          {canAdmin && failedPayments.length > 0 && (
            <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #FECACA", borderRadius: 10, overflow: "hidden" }}>
              <button onClick={() => setFailedExpanded(e => !e)}
                style={{ width: "100%", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", cursor: "pointer", fontFamily: FF }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <AlertCircle size={14} style={{ color: "#DC2626" }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#991B1B" }}>Failed Payments ({failedPayments.length})</span>
                  <span style={{ fontSize: 11, color: "#6B7280" }}>— recent Stripe charge failures</span>
                </div>
                {failedExpanded ? <ChevronUp size={14} color="#6B7280" /> : <ChevronDown size={14} color="#6B7280" />}
              </button>
              {failedExpanded && (
                <div style={{ borderTop: "1px solid #FECACA" }}>
                  {failedPayments.map((p: any) => (
                    <div key={p.id} style={{ padding: "12px 16px", borderBottom: "1px solid #FEF2F2", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 160 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>{p.first_name} {p.last_name}</div>
                        <div style={{ fontSize: 11, color: "#6B7280", fontFamily: FF }}>
                          {p.service_type || ""}
                          {p.attempted_at ? ` · ${new Date(p.attempted_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                          {p.card_brand ? ` · ${p.card_brand.charAt(0).toUpperCase()}${p.card_brand.slice(1)} ••••${p.last_4}` : ""}
                        </div>
                        {p.stripe_error_message && (
                          <div style={{ fontSize: 11, color: "#DC2626", marginTop: 2, fontFamily: FF }}>{p.stripe_error_message}</div>
                        )}
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: "#991B1B", fontFamily: FF }}>${Number(p.amount || 0).toFixed(2)}</div>
                      {p.job_id && (
                        <button
                          onClick={() => chargeJob(p.job_id)}
                          disabled={chargingJobId === p.job_id}
                          style={{ padding: "7px 14px", border: "1px solid #FECACA", borderRadius: 7, backgroundColor: "#FEF2F2", color: "#991B1B", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FF, display: "flex", alignItems: "center", gap: 5, opacity: chargingJobId === p.job_id ? 0.6 : 1 }}>
                          <RotateCcw size={11} /> Retry
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid #EEECE7", display: "flex", flexDirection: isMobile ? "column" : "row", justifyContent: "space-between", alignItems: isMobile ? "stretch" : "center", gap: 10 }}>
              <div style={{ display: "flex", gap: 4, backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: 4, overflowX: "auto" }}>
                {tabs.map(tab => {
                  const isActive = activeTab === tab.id;
                  return (
                    <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                      style={{ padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: isActive ? 700 : 400, border: "none", backgroundColor: isActive ? "var(--brand)" : "transparent", color: isActive ? "#FFFFFF" : "#6B7280", transition: "all 0.15s", fontFamily: FF, whiteSpace: "nowrap" }}>
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ position: "relative", flex: isMobile ? 1 : "none" }}>
                  <Search size={13} strokeWidth={1.5} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#9E9B94" }} />
                  <input placeholder="Search invoices..." value={search} onChange={e => setSearch(e.target.value)}
                    style={{ paddingLeft: 32, paddingRight: 10, height: 36, width: isMobile ? "100%" : 200, backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, color: "#1A1917", fontSize: 13, outline: "none", fontFamily: FF }} />
                </div>
                {canAdmin && (
                  <>
                    {!isMobile && <button onClick={() => setShowCloseDay(true)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 13px", backgroundColor: "transparent", color: "#1A1917", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                      <Calendar size={14} strokeWidth={2} /> Close Day
                    </button>}
                    <button onClick={() => setShowBatch(true)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 13px", backgroundColor: "#F7F6F3", color: "var(--brand)", border: "1px solid var(--brand)", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                      <Layers size={14} strokeWidth={2} /> {isMobile ? "Batch" : "Batch Invoice"}
                    </button>
                  </>
                )}
                <button
                  onClick={() => {
                    if (activeBranchId === "all") { toast({ title: "Select a location first", description: "Choose Oak Lawn or Schaumburg to create an invoice.", variant: "destructive" }); return; }
                    setShowNewInvoice(true);
                  }}
                  title={activeBranchId === "all" ? "Select a location to create invoices" : undefined}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 13px", backgroundColor: activeBranchId === "all" ? "#9E9B94" : "var(--brand)", color: "#FFFFFF", borderRadius: 8, fontSize: 13, fontWeight: 700, border: "none", cursor: activeBranchId === "all" ? "not-allowed" : "pointer", fontFamily: FF, opacity: activeBranchId === "all" ? 0.7 : 1 }}>
                  <Plus size={14} strokeWidth={2} /> {isMobile ? "New" : "New Invoice"}
                  {!isMobile && activeBranchId !== "all" && <kbd style={{ fontSize: 10, border: '1px solid rgba(255,255,255,0.45)', borderRadius: 3, padding: '1px 5px', color: 'rgba(255,255,255,0.8)', fontFamily: 'inherit' }}>⇧I</kbd>}
                </button>
              </div>
            </div>

            {isMobile ? (
              <div>
                {isLoading ? (
                  <div style={{ padding: 32, textAlign: "center", color: "#6B7280", fontSize: 13, fontFamily: FF }}>Loading invoices...</div>
                ) : invoices.length === 0 ? (
                  <div style={{ padding: 48, textAlign: "center" }}>
                    <AlertCircle size={28} style={{ color: "#C4C0BB", marginBottom: 10 }} />
                    <p style={{ color: "#6B7280", fontSize: 13, margin: 0, fontFamily: FF }}>No invoices found.</p>
                  </div>
                ) : invoices.map((inv: any) => {
                  const effectiveStatus = (inv.status === "sent" && inv.due_date && new Date(inv.due_date) < new Date()) ? "overdue" : inv.status;
                  const s = STATUS_STYLES[effectiveStatus] || STATUS_STYLES.draft;
                  return (
                    <div key={inv.id}
                      onClick={() => navigate(`/invoices/${inv.id}`)}
                      style={{ borderBottom: "1px solid #F0EEE9", padding: "14px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>{inv.client_name}</span>
                          <span style={{ ...s, display: "inline-flex", alignItems: "center", padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" as const, fontFamily: FF }}>
                            {effectiveStatus}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>
                          {inv.invoice_number || `INV-${String(inv.id).padStart(4, "0")}`}
                          {inv.due_date ? ` · Due ${new Date(inv.due_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>${(inv.total || 0).toFixed(2)}</span>
                        {effectiveStatus === "overdue" && (inv.days_overdue || 0) > 0 && (
                          <div style={{ fontSize: 10, color: "#991B1B", fontWeight: 600, marginTop: 2 }}>{inv.days_overdue}d overdue</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Invoice #", "Client", "PO #", "Terms", "Amount", "Due Date", "Days Overdue", "Status", ""].map(h => (
                    <th key={h} style={{ ...TH, textAlign: h === "" ? "right" as const : "left" as const }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={9} style={{ padding: 32, textAlign: "center", color: "#6B7280", fontSize: 13 }}>Loading invoices...</td></tr>
                ) : invoices.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ padding: 48, textAlign: "center" }}>
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
                      <td style={{ padding: "13px 18px", fontSize: 12, color: "#6B7280", fontFamily: FF }}>
                        {inv.po_number || "—"}
                      </td>
                      <td style={{ padding: "13px 18px" }}>
                        {inv.payment_terms && inv.payment_terms !== "due_on_receipt" ? (
                          <span style={{ background: "#EFF6FF", color: "#1D4ED8", border: "1px solid #BFDBFE", display: "inline-block", padding: "2px 7px", borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: FF }}>
                            {inv.payment_terms === "net_30" ? "NET 30" : inv.payment_terms === "net_15" ? "NET 15" : inv.payment_terms.toUpperCase()}
                          </span>
                        ) : <span style={{ color: "#9E9B94", fontSize: 12, fontFamily: FF }}>—</span>}
                      </td>
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
            )}
          </div>
        </div>
      </DashboardLayout>

      {showBatch && <BatchInvoiceDrawer onClose={() => setShowBatch(false)} onDone={() => refetch()} />}
      {showCloseDay && <CloseDayModal onClose={() => setShowCloseDay(false)} onOpenBatchInvoice={() => setShowBatch(true)} />}
      {showNewInvoice && <NewInvoiceModal onClose={() => setShowNewInvoice(false)} onDone={() => refetch()} />}
    </>
  );
}
