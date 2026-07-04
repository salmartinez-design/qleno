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
import { CalendarPopover } from "@/components/calendar-popover";

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
  paid:       { background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0" },
  overdue:    { background: "#FEE2E2", color: "#991B1B", border: "1px solid #FECACA" },
  draft:      { background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB" },
  sent:       { background: "#DBEAFE", color: "#1E40AF", border: "1px solid #BFDBFE" },
  void:       { background: "#F3F4F6", color: "#9CA3AF", border: "1px solid #E5E7EB" },
  superseded: { background: "#F5F3FF", color: "#6D28D9", border: "1px solid #DDD6FE" },
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

// [pay-method 2026-06-26] One-tap "Mark Paid" with the payment method, for the
// list view — so office records check / ACH / Zelle / cash without opening each
// invoice. Posts { method } to /mark-paid (amount + date default server-side).
const PAY_METHODS: { value: string; label: string }[] = [
  { value: "square", label: "Square (card on file)" },
  { value: "stripe", label: "Stripe (online card)" },
  { value: "check", label: "Check" },
  { value: "ach", label: "ACH / Bank transfer" },
  { value: "zelle", label: "Zelle" },
  { value: "cash", label: "Cash" },
  { value: "venmo", label: "Venmo" },
  { value: "other", label: "Other" },
];
function MarkPaidMethodModal({ invoice, busy, onPick, onClose }: { invoice: any; busy: boolean; onPick: (method: string) => void; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ backgroundColor: "#FFFFFF", borderRadius: 16, boxShadow: "0 8px 40px rgba(0,0,0,0.12)", width: "100%", maxWidth: 360, padding: 24, fontFamily: FF }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800, color: "#1A1917" }}>Mark paid — how did they pay?</h3>
        <p style={{ margin: "0 0 16px", fontSize: 12, color: "#6B7280" }}>
          {invoice.invoice_number ? `#${invoice.invoice_number} · ` : ""}${parseFloat(invoice.total || "0").toFixed(2)}{invoice.client_name ? ` · ${invoice.client_name}` : ""}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {PAY_METHODS.map(m => (
            <button key={m.value} disabled={busy} onClick={() => onPick(m.value)}
              style={{ padding: "12px 10px", border: "1px solid #E5E2DC", borderRadius: 10, backgroundColor: "#FFFFFF", color: "#1A1917", fontSize: 13, fontWeight: 700, cursor: busy ? "default" : "pointer", fontFamily: FF }}>
              {m.label}
            </button>
          ))}
        </div>
        <button onClick={onClose} style={{ width: "100%", marginTop: 14, background: "none", border: "none", color: "#9E9B94", fontSize: 13, cursor: "pointer", fontFamily: FF }}>Cancel</button>
      </div>
    </div>
  );
}

// [weekly-cadence 2026-06-26] On-demand consolidated invoicing. Lists
// batch_invoice clients' pending per-visit drafts for a billing window (weekly
// Sun–Sat or monthly), keyed on SERVICE DATE, and folds a client's window into
// one invoice via POST /api/batch-invoicing/:clientId/consolidate. Office stays
// in control — nothing generates automatically.
function WeeklyInvoicingDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [cadence, setCadence] = useState<"weekly" | "monthly">("weekly");
  // Anchor any date inside the target window; default = today.
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [excluded, setExcluded] = useState<Set<number>>(new Set()); // invoice ids to leave out
  const [busyClient, setBusyClient] = useState<number | null>(null);
  // Preview step: the client being previewed before consolidation fires
  const [previewClient, setPreviewClient] = useState<any | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["weekly-invoicing", cadence, anchor],
    queryFn: () => apiFetch(`/api/batch-invoicing?cadence=${cadence}&date=${anchor}`),
  });
  const clients: any[] = data?.clients || [];

  function shiftWindow(deltaDays: number) {
    const d = new Date(`${anchor}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    setAnchor(d.toISOString().slice(0, 10));
  }
  const fmtRange = (a?: string, b?: string) => {
    if (!a || !b) return "";
    const f = (s: string) => new Date(`${s}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return `${f(a)} – ${f(b)}`;
  };

  async function consolidate(clientId: number) {
    setBusyClient(clientId);
    try {
      const excludeForClient = (clients.find(c => c.client_id === clientId)?.visits || [])
        .filter((v: any) => excluded.has(v.invoice_id)).map((v: any) => v.invoice_id);
      const r = await apiFetch(`/api/batch-invoicing/${clientId}/consolidate`, {
        method: "POST",
        body: JSON.stringify({ cadence, date: anchor, exclude_invoice_ids: excludeForClient }),
      });
      toast({ title: "Weekly invoice created", description: `${r.visit_count} visit${r.visit_count !== 1 ? "s" : ""} · $${(r.parent_total || 0).toFixed(2)} · #${r.parent_invoice_id}` });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      refetch();
      onDone();
    } catch (err: any) {
      let msg = err?.message || "Failed";
      try { msg = JSON.parse(msg).message || msg; } catch {}
      toast({ title: "Could not consolidate", description: msg, variant: "destructive" });
    } finally {
      setBusyClient(null);
    }
  }

  return (
    <>
      <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", zIndex: 1000 }} onClick={onClose} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "100%", maxWidth: 560, backgroundColor: "#FFFFFF", zIndex: 1001, display: "flex", flexDirection: "column", boxShadow: "-4px 0 24px rgba(0,0,0,0.12)", fontFamily: FF }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #EEECE7", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#1A1917" }}>Weekly Invoicing</h2>
              <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>Combine a client's visits into one invoice</p>
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={20} /></button>
          </div>
          {/* cadence + window nav */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
            <div style={{ display: "flex", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
              {(["weekly", "monthly"] as const).map(c => (
                <button key={c} onClick={() => setCadence(c)}
                  style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer", fontFamily: FF, textTransform: "capitalize", backgroundColor: cadence === c ? "var(--brand)" : "#FFFFFF", color: cadence === c ? "#FFFFFF" : "#6B7280" }}>{c}</button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <button onClick={() => shiftWindow(cadence === "weekly" ? -7 : -31)} style={{ background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontFamily: FF }}>‹</button>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", minWidth: 120, textAlign: "center" }}>{fmtRange(data?.period_start, data?.period_end)}</span>
            <button onClick={() => shiftWindow(cadence === "weekly" ? 7 : 31)} style={{ background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontFamily: FF }}>›</button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {isLoading ? (
            <div style={{ textAlign: "center", color: "#9E9B94", padding: 40 }}>Loading…</div>
          ) : clients.length === 0 ? (
            <div style={{ textAlign: "center", padding: 48 }}>
              <AlertCircle size={36} style={{ color: "#C4C0BB", marginBottom: 12 }} />
              <p style={{ fontSize: 14, fontWeight: 600, color: "#6B7280", margin: "0 0 4px" }}>No visits to invoice this {cadence === "weekly" ? "week" : "month"}</p>
              <p style={{ fontSize: 12, color: "#9E9B94", margin: 0 }}>Only consolidated-billing clients with pending visits appear here.</p>
            </div>
          ) : (
            clients.map((c: any) => {
              const isOpen = expanded.has(c.client_id);
              const incl = (c.visits || []).filter((v: any) => !excluded.has(v.invoice_id));
              const inclTotal = incl.reduce((s: number, v: any) => s + (v.total || 0), 0);
              return (
                <div key={c.client_id} style={{ borderBottom: "1px solid #F0EDE8", padding: "14px 24px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button onClick={() => setExpanded(p => { const n = new Set(p); n.has(c.client_id) ? n.delete(c.client_id) : n.add(c.client_id); return n; })}
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex" }}>
                      {isOpen ? <ChevronUp size={16} color="#9E9B94" /> : <ChevronDown size={16} color="#9E9B94" />}
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#1A1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.client_name || `Client #${c.client_id}`}</p>
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9E9B94" }}>{incl.length} visit{incl.length !== 1 ? "s" : ""}{excluded.size ? ` · ${(c.visits || []).length - incl.length} excluded` : ""}</p>
                    </div>
                    <span style={{ fontSize: 15, fontWeight: 800, color: "#1A1917" }}>${inclTotal.toFixed(2)}</span>
                    <button onClick={() => incl.length > 0 && setPreviewClient({ ...c, inclVisits: incl, inclTotal })}
                      disabled={busyClient === c.client_id || incl.length === 0}
                      style={{ backgroundColor: incl.length === 0 ? "#C4C0BB" : "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: incl.length === 0 ? "default" : "pointer", fontFamily: FF, whiteSpace: "nowrap" }}>
                      {busyClient === c.client_id ? "Working…" : "Preview invoice"}
                    </button>
                  </div>
                  {isOpen && (
                    <div style={{ marginTop: 10, marginLeft: 28, borderLeft: "2px solid #F0EDE8", paddingLeft: 14 }}>
                      {(c.visits || []).map((v: any) => {
                        const isExcl = excluded.has(v.invoice_id);
                        return (
                          <div key={v.invoice_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", opacity: isExcl ? 0.45 : 1 }}>
                            <button onClick={() => setExcluded(p => { const n = new Set(p); n.has(v.invoice_id) ? n.delete(v.invoice_id) : n.add(v.invoice_id); return n; })}
                              title={isExcl ? "Include this visit" : "Exclude this visit"}
                              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: isExcl ? "#C4C0BB" : "var(--brand)", display: "flex" }}>
                              {isExcl ? <Square size={15} /> : <CheckSquare size={15} />}
                            </button>
                            <span style={{ flex: 1, fontSize: 12, color: "#6B7280" }}>{v.service_label || v.service_date}</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", textDecoration: isExcl ? "line-through" : "none" }}>${(v.total || 0).toFixed(2)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div style={{ padding: "14px 24px", borderTop: "1px solid #EEECE7", flexShrink: 0, backgroundColor: "#FAFAF9" }}>
          <p style={{ margin: 0, fontSize: 11, color: "#9E9B94" }}>One invoice per client, one line per visit (service date), due on receipt. Pushes a single document to QuickBooks.</p>
        </div>

        {/* Preview slide — full-height panel that covers the list when a client is selected */}
        {previewClient && (() => {
          const pc = previewClient;
          const periodLabel = fmtRange(data?.period_start, data?.period_end);
          return (
            <div style={{ position: "absolute", inset: 0, backgroundColor: "#FFFFFF", display: "flex", flexDirection: "column", zIndex: 10 }}>
              {/* Header */}
              <div style={{ padding: "20px 24px", borderBottom: "1px solid #EEECE7", flexShrink: 0, display: "flex", alignItems: "center", gap: 12 }}>
                <button onClick={() => setPreviewClient(null)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#6B7280", padding: 0, display: "flex", alignItems: "center", gap: 4, fontSize: 13, fontFamily: FF }}>
                  ‹ Back
                </button>
                <div style={{ flex: 1 }}>
                  <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#1A1917" }}>Invoice Preview</h2>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9E9B94" }}>Review before creating</p>
                </div>
                <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={20} /></button>
              </div>

              {/* Invoice mock */}
              <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
                {/* Client + period */}
                <div style={{ marginBottom: 20 }}>
                  <p style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#1A1917" }}>{pc.client_name || `Client #${pc.client_id}`}</p>
                  {periodLabel && <p style={{ margin: "3px 0 0", fontSize: 13, color: "#6B7280" }}>Period: {periodLabel}</p>}
                  <p style={{ margin: "3px 0 0", fontSize: 12, color: "#9E9B94" }}>Due on receipt · {cadence === "weekly" ? "Weekly" : "Monthly"} invoice</p>
                </div>

                {/* Line items */}
                <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden", marginBottom: 20 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 0, backgroundColor: "#F7F6F3", padding: "10px 16px", borderBottom: "1px solid #E5E2DC" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em" }}>Description</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "right" }}>Amount</span>
                  </div>
                  {(pc.inclVisits || []).map((v: any, i: number) => (
                    <div key={v.invoice_id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 0, padding: "12px 16px", borderBottom: i < pc.inclVisits.length - 1 ? "1px solid #F0EDE8" : "none" }}>
                      <div>
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{v.service_label || v.service_date}</p>
                        {v.service_type && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9E9B94" }}>{(v.service_type || "").replace(/_/g, " ")}</p>}
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", alignSelf: "center" }}>${(v.total || 0).toFixed(2)}</span>
                    </div>
                  ))}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", padding: "12px 16px", backgroundColor: "#F7F6F3", borderTop: "2px solid #E5E2DC" }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>Total</span>
                    <span style={{ fontSize: 16, fontWeight: 800, color: "#1A1917" }}>${(pc.inclTotal || 0).toFixed(2)}</span>
                  </div>
                </div>

                <p style={{ fontSize: 12, color: "#9E9B94", margin: 0, lineHeight: 1.5 }}>
                  This will create one consolidated invoice. Individual visit records will be marked superseded.
                  You can then send or charge from the invoice detail page.
                </p>
              </div>

              {/* Footer actions */}
              <div style={{ padding: "16px 24px", borderTop: "1px solid #EEECE7", flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                <button
                  onClick={async () => { await consolidate(pc.client_id); setPreviewClient(null); }}
                  disabled={busyClient === pc.client_id}
                  style={{ width: "100%", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "13px", fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: FF }}>
                  {busyClient === pc.client_id ? "Creating…" : `Create Invoice · $${(pc.inclTotal || 0).toFixed(2)}`}
                </button>
                <button onClick={() => setPreviewClient(null)}
                  style={{ width: "100%", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#9E9B94", padding: "6px 0", fontFamily: FF }}>
                  Go back and adjust
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    </>
  );
}

function BatchInvoiceDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number; current: string; errors: number } | null>(null);
  const [summary, setSummary] = useState<{ created: number; errors: number; invoices: { id: number; clientName: string; amount: number }[] } | null>(null);

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
    let created = 0; let errors = 0;
    const invoices: { id: number; clientName: string; amount: number }[] = [];
    setProgress({ done: 0, total: ids.length, current: "", errors: 0 });

    for (const jobId of ids) {
      const job = allJobs.find((j: any) => j.id === jobId);
      setProgress(p => p ? { ...p, current: job?.client_name || `Job #${jobId}` } : null);
      try {
        // Always create as draft so the office can review each invoice before sending.
        const inv = await apiFetch("/api/invoices", {
          method: "POST",
          body: JSON.stringify({ job_id: jobId, auto_send: false, auto_charge: false }),
        });
        invoices.push({ id: inv.id, clientName: job?.client_name || `Job #${jobId}`, amount: parseFloat(job?.base_fee || "0") });
        created++;
      } catch { errors++; }
      setProgress(p => p ? { ...p, done: created + errors, errors } : null);
    }
    setSummary({ created, errors, invoices });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["uninvoiced-jobs"] });
  }

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
            <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 48, height: 48, backgroundColor: "#D1FAE5", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Check size={24} style={{ color: "#16A34A" }} />
                </div>
                <div>
                  <h3 style={{ margin: "0 0 2px", fontSize: 17, fontWeight: 800, color: "#1A1917" }}>
                    {summary.created} draft invoice{summary.created !== 1 ? "s" : ""} created
                  </h3>
                  <p style={{ margin: 0, fontSize: 12, color: "#6B7280" }}>
                    Review each one, then send or charge from the invoice page.
                    {summary.errors > 0 && <span style={{ color: "#DC2626" }}> {summary.errors} failed.</span>}
                  </p>
                </div>
              </div>

              {/* Invoice list with View links */}
              <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden", flex: 1, overflowY: "auto" }}>
                {summary.invoices.map((inv, i) => (
                  <div key={inv.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: i < summary.invoices.length - 1 ? "1px solid #F0EDE8" : "none" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#1A1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inv.clientName}</p>
                      <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9E9B94" }}>Draft · ${inv.amount.toFixed(2)}</p>
                    </div>
                    <a href={`/invoices/${inv.id}`}
                      style={{ fontSize: 12, fontWeight: 700, color: "var(--brand)", textDecoration: "none", whiteSpace: "nowrap", padding: "5px 10px", border: "1px solid #D1FAE5", borderRadius: 6, backgroundColor: "#ECFDF5" }}>
                      Review →
                    </a>
                  </div>
                ))}
              </div>

              <button onClick={() => { onDone(); onClose(); }}
                style={{ width: "100%", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "12px", fontSize: 13, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: "#6B7280", fontWeight: 600 }}>
                {selected.size} job{selected.size !== 1 ? "s" : ""} selected
              </span>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>
                Total: ${selectedTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <p style={{ margin: "0 0 10px", fontSize: 11, color: "#9E9B94" }}>
              Invoices are created as drafts. Review and send each one individually from the invoice page.
            </p>
            <button
              onClick={handleGenerate}
              disabled={selected.size === 0}
              style={{ width: "100%", backgroundColor: selected.size === 0 ? "#C4C0BB" : "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, padding: "12px", fontSize: 13, fontWeight: 700, cursor: selected.size === 0 ? "default" : "pointer", marginBottom: 8 }}>
              Create Draft{selected.size !== 1 ? "s" : ""} {selected.size > 0 ? `(${selected.size})` : ""}
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

type TabId = "all" | "draft" | "sent" | "paid" | "overdue" | "void";

export default function InvoicesPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<TabId>("all");
  const [search, setSearch] = useState("");
  // [invoice-date-range 2026-06-21] Office date-range filter (by service date).
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // [invoices-load-more 2026-07-02] The list endpoint pages at limit=50 and the
  // page never asked past page 1 — so only the 50 newest invoices were ever
  // reachable ("can't view all invoices"). Grow the limit 50 at a time via a
  // Load-more button; reset whenever the filters change so a new view starts small.
  const [pageLimit, setPageLimit] = useState(50);
  const [showBatch, setShowBatch] = useState(false);
  const [showWeekly, setShowWeekly] = useState(false);
  const [showCloseDay, setShowCloseDay] = useState(false);
  // [invoice-merge 2026-07-02] Bulk-select unpaid invoices → fold into one
  // (POST /api/invoices/merge). The office's "filter June → select all → one
  // invoice" flow for PPM/accounts.
  const [mergeSel, setMergeSel] = useState<Set<number>>(new Set());
  const [merging, setMerging] = useState(false);
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
  // [uninvoiced-cap 2026-07-02] The "Not yet invoiced" list (added #841) renders
  // every uninvoiced job unbounded; at 100+ rows it buries the invoices toolbar
  // (tabs, search, date filter) far below the fold. Cap the visible rows so the
  // filter stays reachable; header count/total keeps the reconciliation signal.
  const [showAllUninv, setShowAllUninv] = useState(false);
  const UNINV_CAP = 6;
  const [chargingJobId, setChargingJobId] = useState<number | null>(null);
  const [payingInvoiceId, setPayingInvoiceId] = useState<number | null>(null);
  const [markPaidInv, setMarkPaidInv] = useState<any | null>(null);

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

  // [invoice-lifecycle 2026-06-21; pay-method 2026-06-26] Mark Paid from the list,
  // recording HOW the client paid (check / ACH / Zelle / cash …) so non-processor
  // payments are captured. Opens the quick method picker (setMarkPaidInv).
  async function markInvoicePaid(invId: number, method = "cash") {
    setPayingInvoiceId(invId);
    try {
      await apiFetch(`/api/invoices/${invId}/mark-paid`, { method: "POST", body: JSON.stringify({ method }) });
      toast({ title: `Marked paid${method && method !== "cash" ? ` · ${method}` : ""}` });
      refetch();
    } catch (err: any) {
      toast({ title: "Failed to mark paid", description: err?.message || "", variant: "destructive" });
    } finally {
      setPayingInvoiceId(null);
    }
  }
  async function chargeInvoiceRow(invId: number) {
    setPayingInvoiceId(invId);
    try {
      const r = await apiFetch(`/api/invoices/${invId}/charge`, { method: "POST", body: JSON.stringify({}) });
      if (r.outcome === "paid") toast({ title: `Charged $${(r.amount || 0).toFixed(2)}` });
      else if (r.outcome === "needs_manual") toast({ title: r.message });
      else toast({ title: r.message || "Charge failed", variant: "destructive" });
      refetch();
    } catch (err: any) {
      toast({ title: "Charge failed", description: err?.message || "", variant: "destructive" });
    } finally {
      setPayingInvoiceId(null);
    }
  }
  async function markInvoiceUnpaid(invId: number) {
    setPayingInvoiceId(invId);
    try {
      await apiFetch(`/api/invoices/${invId}/mark-unpaid`, { method: "POST" });
      toast({ title: "Marked unpaid" });
      refetch();
    } catch (err: any) {
      toast({ title: "Failed to mark unpaid", description: err?.message || "", variant: "destructive" });
    } finally {
      setPayingInvoiceId(null);
    }
  }

  const buildInvoicesUrl = () => {
    const params = new URLSearchParams();
    if (activeTab !== "all") params.set("status", activeTab);
    if (activeBranchId !== "all") params.set("branch_id", String(activeBranchId));
    // [invoice-search 2026-06-20] Send search to the server so it spans ALL
    // invoices, not just the 50 rows the page loaded.
    if (search.trim()) params.set("search", search.trim());
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    params.set("limit", String(pageLimit));
    const qs = params.toString();
    return `/api/invoices${qs ? `?${qs}` : ""}`;
  };

  // Start each filter/tab/search view back at the first 50 rows.
  useEffect(() => { setPageLimit(50); }, [activeTab, activeBranchId, search, dateFrom, dateTo]);

  // [invoice-date-presets 2026-07-03] One-click billing-period jumps so the office
  // can land on a day/week/month (Maribel's "go to the date") without picking two
  // dates, then select the drafts in view and Merge.
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  function applyDatePreset(kind: "today" | "week" | "month") {
    const now = new Date();
    if (kind === "today") { const t = ymd(now); setDateFrom(t); setDateTo(t); return; }
    if (kind === "week") {
      const s = new Date(now); s.setDate(now.getDate() - now.getDay()); // Sunday
      const e = new Date(s); e.setDate(s.getDate() + 6);
      setDateFrom(ymd(s)); setDateTo(ymd(e)); return;
    }
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    setDateFrom(ymd(s)); setDateTo(ymd(e));
  }
  const presetActive = (kind: "today" | "week" | "month") => {
    if (!dateFrom || !dateTo) return false;
    const now = new Date();
    if (kind === "today") return dateFrom === ymd(now) && dateTo === ymd(now);
    if (kind === "week") { const s = new Date(now); s.setDate(now.getDate() - now.getDay()); const e = new Date(s); e.setDate(s.getDate() + 6); return dateFrom === ymd(s) && dateTo === ymd(e); }
    const s = new Date(now.getFullYear(), now.getMonth(), 1); const e = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return dateFrom === ymd(s) && dateTo === ymd(e);
  };

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["invoices", activeTab, activeBranchId, search.trim(), dateFrom, dateTo, pageLimit],
    queryFn: () => apiFetch(buildInvoicesUrl()),
  });
  const totalCount: number = data?.total ?? 0;
  const hasMore = totalCount > (data?.data?.length ?? 0);

  const tabs: { id: TabId; label: string }[] = [
    { id: "all", label: "All" },
    { id: "draft", label: "Drafts" },
    { id: "sent", label: "Sent" },
    { id: "paid", label: "Paid" },
    { id: "overdue", label: "Overdue" },
    { id: "void", label: "Void" },
  ];

  const invoices = ((data?.data || []) as any[]).filter((i: any) =>
    !search || (i.client_name || "").toLowerCase().includes(search.toLowerCase()) || (i.invoice_number || "").toLowerCase().includes(search.toLowerCase())
  );

  const stats = data?.stats || {};

  // [invoices-uninvoiced 2026-07-02] Surface residential per-job completed work
  // that hasn't been invoiced yet — a standing "still needs billing" to-do so
  // finished jobs don't silently slip through un-billed. Same endpoint the Batch
  // modal uses.
  const { data: rawUninv } = useQuery({
    queryKey: ["invoices-uninvoiced-jobs"],
    queryFn: () => apiFetch("/api/jobs?status=complete&uninvoiced=true&limit=200"),
  });
  const uninvoicedJobs: any[] = (Array.isArray(rawUninv) ? rawUninv : (rawUninv?.data || []))
    .filter((j: any) => {
      // [account-jobs-under-accounts 2026-07-02] Commercial/account jobs (PPM,
      // KMA, National Able) are invoiced under their Account (per-turnover or
      // consolidated), NOT on this residential screen. Showing them here rendered
      // nameless rows and double-listed them — exclude them so this section is
      // only residential per-job work. account_id comes from /api/jobs.
      if (j.account_id != null) return false;
      // [uninvoiced-stable 2026-07-04] Show the FULL residential backlog,
      // independent of the invoice-list date range and search box. This panel is
      // a fixed-height to-do reminder, not a slice of the list below it — keeping
      // it decoupled means clicking Today/Week/Month/Drafts/Sent no longer makes
      // the panel blink in/out and shove the toolbar + list (it sits above them).
      // Only actually invoicing a job changes what's here.
      return true;
    });
  const uninvTotal = uninvoicedJobs.reduce((sum: number, j: any) => sum + Number(j.billed_amount ?? j.amount ?? j.base_fee ?? 0), 0);

  // [invoice-merge 2026-07-02] Only unpaid invoices are selectable to merge.
  const isMergeable = (inv: any) => {
    const st = (inv.status === "sent" && inv.due_date && new Date(inv.due_date + "T23:59:59") < new Date()) ? "overdue" : inv.status;
    return ["draft", "sent", "overdue"].includes(st);
  };
  const mergeTotal = invoices.filter((i: any) => mergeSel.has(i.id)).reduce((s: number, i: any) => s + (i.total || 0), 0);
  function toggleMerge(id: number, on: boolean) {
    setMergeSel(prev => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });
  }
  async function doMerge() {
    if (mergeSel.size < 2) return;
    setMerging(true);
    try {
      const r = await apiFetch(`/api/invoices/merge`, { method: "POST", body: JSON.stringify({ invoice_ids: [...mergeSel] }) });
      toast({ title: `Merged ${mergeSel.size} invoices into one`, description: r?.invoice?.invoice_number ? `New invoice ${r.invoice.invoice_number}` : undefined });
      setMergeSel(new Set());
      refetch();
    } catch (e: any) {
      let msg = e?.message || "";
      try { msg = JSON.parse(msg).message || msg; } catch {}
      toast({ title: "Could not merge", description: msg, variant: "destructive" });
    }
    setMerging(false);
  }

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
          {/* [kpi-cards-clickable 2026-07-04] Each card drills into the matching list
              filter (Outstanding→Sent, Overdue→Overdue, Paid & YTD→Paid) so the office
              can see what makes up a number instead of staring at a dead tile. */}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 12 }}>
            {[
              { label: "Outstanding", value: `$${Math.round(stats.total_outstanding || 0).toLocaleString()}`, tab: "sent" as TabId },
              { label: "Overdue",     value: `$${Math.round(stats.total_overdue || 0).toLocaleString()}`, color: (stats.total_overdue || 0) > 0 ? "#DC2626" : undefined, tab: "overdue" as TabId },
              { label: "Paid (30d)",  value: `$${Math.round(stats.total_paid || 0).toLocaleString()}`,   color: "#16A34A", tab: "paid" as TabId },
              { label: "YTD Revenue", value: `$${Math.round(stats.total_revenue || 0).toLocaleString()}`, accent: true, tab: "paid" as TabId },
            ].map(c => (
              <div key={c.label} role="button" tabIndex={0}
                onClick={() => setActiveTab(c.tab)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveTab(c.tab); } }}
                title={`View ${c.label}`}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "0 1px 6px rgba(0,0,0,0.06)"; e.currentTarget.style.borderColor = "var(--brand)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.borderColor = c.accent ? "rgba(91,155,213,0.4)" : "#E5E2DC"; }}
                style={{ ...CARD, cursor: "pointer", transition: "border-color 0.15s, box-shadow 0.15s", border: c.accent ? "1px solid rgba(91,155,213,0.4)" : "1px solid #E5E2DC" }}>
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

          {uninvoicedJobs.length > 0 && (
            <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #EEECE7", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div>
                  <span style={{ fontSize: 14, fontWeight: 800, color: "#1A1917", fontFamily: FF }}>Not yet invoiced</span>
                  <span style={{ fontSize: 12, color: "#6B7280", fontFamily: FF, marginLeft: 8 }}>
                    {uninvoicedJobs.length} completed {uninvoicedJobs.length === 1 ? "job" : "jobs"} · ${uninvTotal.toFixed(2)}
                  </span>
                </div>
                {uninvoicedJobs.length > UNINV_CAP && (
                  <button onClick={() => setShowAllUninv(v => !v)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--brand)", fontSize: 12, fontWeight: 700, fontFamily: FF, whiteSpace: "nowrap", padding: 0 }}>
                    {showAllUninv ? "Show less" : `Show all ${uninvoicedJobs.length}`}
                  </button>
                )}
              </div>
              {(showAllUninv ? uninvoicedJobs : uninvoicedJobs.slice(0, UNINV_CAP)).map((j: any) => {
                const name = j.account_name || j.client_name || "—";
                const amt = Number(j.billed_amount ?? j.amount ?? j.base_fee ?? 0);
                const isAccount = j.account_id != null;
                return (
                  <div key={`uninv-${j.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid #F0EEE9" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF, display: "flex", alignItems: "center", gap: 6 }}>
                        {name}
                        {isAccount && <span style={{ fontSize: 10, fontWeight: 700, color: "#6B7280", background: "#F3F4F6", border: "1px solid #E5E7EB", borderRadius: 4, padding: "1px 6px" }}>ACCOUNT</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF, marginTop: 2 }}>
                        {(j.service_type || "").replace(/_/g, " ")}
                        {j.scheduled_date ? ` · ${new Date(String(j.scheduled_date).slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                      </div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: amt > 0 ? "#1A1917" : "#DC2626", fontFamily: FF, whiteSpace: "nowrap" }}>
                      {amt > 0 ? `$${amt.toFixed(2)}` : "$0 · no rate"}
                    </div>
                    <button
                      onClick={() => isAccount ? navigate(`/accounts/${j.account_id}`) : setShowBatch(true)}
                      style={{ padding: "6px 12px", border: "1px solid var(--brand)", borderRadius: 7, backgroundColor: "#F7F6F3", color: "var(--brand)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FF, whiteSpace: "nowrap" }}>
                      {isAccount ? "Bill account" : "Batch invoice"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {mergeSel.size > 0 && (
            <div style={{ backgroundColor: "#0A0E1A", borderRadius: 10, padding: "12px 16px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <span style={{ color: "#FFFFFF", fontSize: 14, fontWeight: 700, fontFamily: FF }}>
                {mergeSel.size} selected · ${mergeTotal.toFixed(2)}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setMergeSel(new Set())}
                  style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #3A3E4A", backgroundColor: "transparent", color: "#C9C5BD", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>Clear</button>
                <button onClick={doMerge} disabled={merging || mergeSel.size < 2}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "none", backgroundColor: "var(--brand)", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: mergeSel.size < 2 ? "not-allowed" : "pointer", opacity: mergeSel.size < 2 ? 0.6 : 1, fontFamily: FF }}>
                  {merging ? "Merging…" : "Merge into one invoice"}
                </button>
              </div>
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
                {/* [invoice-date-presets 2026-07-03] One-click billing-period jumps. */}
                {([["Today", "today"], ["Week", "week"], ["Month", "month"]] as const).map(([label, kind]) => (
                  <button key={kind} onClick={() => applyDatePreset(kind)} title={`This ${kind === "today" ? "day" : kind}`}
                    style={{ height: 36, padding: "0 11px", backgroundColor: presetActive(kind) ? "var(--brand)" : "#F7F6F3", color: presetActive(kind) ? "#FFFFFF" : "#6B7280", border: `1px solid ${presetActive(kind) ? "var(--brand)" : "#E5E2DC"}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF, whiteSpace: "nowrap" }}>{label}</button>
                ))}
                {/* [invoice-date-range 2026-06-21] Filter by service date. */}
                {/* [styled-picker 2026-07-02] Use the shared CalendarPopover (mint-accent
                    month grid) instead of the OS-native <input type="date"> picker so the
                    filter matches the rest of the app on desktop + mobile. */}
                <CalendarPopover value={dateFrom} ariaLabel="From date" onChange={setDateFrom} />
                <span style={{ color: "#9E9B94", fontSize: 13 }}>–</span>
                <CalendarPopover value={dateTo} ariaLabel="To date" onChange={setDateTo} />
                {(dateFrom || dateTo) && (
                  <button onClick={() => { setDateFrom(""); setDateTo(""); }} title="Clear dates"
                    style={{ height: 36, padding: "0 10px", backgroundColor: "transparent", color: "#6B7280", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>Clear</button>
                )}
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
                    <button onClick={() => setShowWeekly(true)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 13px", backgroundColor: "#F7F6F3", color: "var(--brand)", border: "1px solid var(--brand)", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                      <Calendar size={14} strokeWidth={2} /> {isMobile ? "Weekly" : "Weekly Invoicing"}
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
                  const effectiveStatus = (inv.status === "sent" && inv.due_date && new Date(inv.due_date + "T23:59:59") < new Date()) ? "overdue" : inv.status;
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
                          {inv.service_date
                            ? ` · ${new Date(inv.service_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                            : inv.created_at ? ` · ${new Date(inv.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
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
                  <th style={{ ...TH, width: 34 }}>
                    <input type="checkbox" aria-label="Select all mergeable"
                      checked={invoices.filter(isMergeable).length > 0 && invoices.filter(isMergeable).every((i: any) => mergeSel.has(i.id))}
                      onChange={e => setMergeSel(e.target.checked ? new Set(invoices.filter(isMergeable).map((i: any) => i.id)) : new Set())} />
                  </th>
                  {["Invoice #", "Client", "PO #", "Terms", "Amount", "Service Date", "Days Overdue", "Status", ""].map(h => (
                    <th key={h} style={{ ...TH, textAlign: h === "" ? "right" as const : "left" as const }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={10} style={{ padding: 32, textAlign: "center", color: "#6B7280", fontSize: 13 }}>Loading invoices...</td></tr>
                ) : invoices.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ padding: 48, textAlign: "center" }}>
                      <AlertCircle size={28} style={{ color: "#C4C0BB", marginBottom: 10 }} />
                      <p style={{ color: "#6B7280", fontSize: 13, margin: 0 }}>No invoices found.</p>
                    </td>
                  </tr>
                ) : invoices.map((inv: any) => {
                  const effectiveStatus = (inv.status === "sent" && inv.due_date && new Date(inv.due_date + "T23:59:59") < new Date()) ? "overdue" : inv.status;
                  const s = STATUS_STYLES[effectiveStatus] || STATUS_STYLES.draft;
                  return (
                    /* [invoice-open-new-tab 2026-07-03] cmd/ctrl+click or middle-click
                       opens the invoice in a NEW tab (office keeps the list open and
                       opens several invoices side by side); plain click still does fast
                       client-side nav. Invoice # cell below is a real <a> so right-click
                       → "Open in new tab" works too. */
                    <tr key={inv.id}
                      onClick={e => { if (e.metaKey || e.ctrlKey) { window.open(`/invoices/${inv.id}`, "_blank"); return; } navigate(`/invoices/${inv.id}`); }}
                      onAuxClick={e => { if (e.button === 1) { e.preventDefault(); window.open(`/invoices/${inv.id}`, "_blank"); } }}
                      style={{ borderBottom: "1px solid #F0EEE9", cursor: "pointer" }}
                      onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#F7F6F3")}
                      onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}>
                      <td style={{ padding: "13px 18px" }} onClick={e => e.stopPropagation()}>
                        <input type="checkbox"
                          aria-label={`Select invoice ${inv.invoice_number || inv.id}`}
                          disabled={!isMergeable(inv)}
                          checked={mergeSel.has(inv.id)}
                          onChange={e => toggleMerge(inv.id, e.target.checked)} />
                      </td>
                      <td style={{ padding: "13px 18px", fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>
                        <a href={`/invoices/${inv.id}`}
                          onClick={e => { e.stopPropagation(); if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(`/invoices/${inv.id}`); }}
                          style={{ color: "inherit", textDecoration: "none" }}>
                          {inv.invoice_number || `INV-${String(inv.id).padStart(4, "0")}`}
                        </a>
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
                        {inv.service_date
                          ? new Date(inv.service_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
                          : inv.created_at ? new Date(inv.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
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
                        {inv.refunded_amount != null && Number(inv.refunded_amount) > 0 && (
                          <span style={{ marginLeft: 4, display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: FF, backgroundColor: "#EDE9FE", color: "#6D28D9", border: "1px solid #DDD6FE" }}>
                            {Number(inv.refunded_amount) >= Number(inv.total) ? "REFUNDED" : `REFUNDED $${Number(inv.refunded_amount).toFixed(2)}`}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "13px 18px", textAlign: "right", whiteSpace: "nowrap" }} onClick={e => e.stopPropagation()}>
                        {(effectiveStatus === "sent" || effectiveStatus === "overdue") && inv.has_card_on_file && (
                          <button onClick={() => chargeInvoiceRow(inv.id)} disabled={payingInvoiceId === inv.id}
                            title={`Charge card on file${inv.card_last_four ? ` (•••• ${inv.card_last_four})` : ""}`}
                            style={{ marginRight: 8, padding: "5px 10px", border: "none", backgroundColor: "var(--brand)", color: "#FFFFFF", fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer", fontFamily: FF }}>
                            {payingInvoiceId === inv.id ? "…" : (inv.card_last_four ? `Charge •••• ${inv.card_last_four}` : "Charge")}
                          </button>
                        )}
                        {(effectiveStatus === "sent" || effectiveStatus === "overdue") && (
                          <button onClick={() => setMarkPaidInv(inv)} disabled={payingInvoiceId === inv.id}
                            title="Mark paid — choose method (check / ACH / Zelle …)"
                            style={{ marginRight: 8, padding: "5px 10px", border: "none", backgroundColor: "#16A34A", color: "#FFFFFF", fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer", fontFamily: FF }}>
                            {payingInvoiceId === inv.id ? "…" : "Mark Paid"}
                          </button>
                        )}
                        {inv.status === "paid" && (
                          <button onClick={() => markInvoiceUnpaid(inv.id)} disabled={payingInvoiceId === inv.id}
                            title="Mark unpaid"
                            style={{ marginRight: 8, padding: "5px 10px", border: "1px solid #FDE68A", backgroundColor: "transparent", color: "#92400E", fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer", fontFamily: FF }}>
                            {payingInvoiceId === inv.id ? "…" : "Unmark"}
                          </button>
                        )}
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
            {/* [invoices-load-more 2026-07-02] Reach every invoice, not just the
                50 newest. Grows the fetch 50 at a time; count shows progress. */}
            {!isLoading && invoices.length > 0 && (
              <div style={{ padding: "14px 16px", borderTop: "1px solid #EEECE7", display: "flex", alignItems: "center", justifyContent: "center", gap: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "#9E9B94", fontFamily: FF }}>
                  Showing {invoices.length} of {totalCount} invoice{totalCount === 1 ? "" : "s"}
                </span>
                {hasMore && (
                  <button onClick={() => setPageLimit(l => l + 50)}
                    style={{ padding: "8px 18px", border: "1px solid var(--brand)", borderRadius: 8, backgroundColor: "#F7F6F3", color: "var(--brand)", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
                    Load more
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </DashboardLayout>

      {showBatch && <BatchInvoiceDrawer onClose={() => setShowBatch(false)} onDone={() => refetch()} />}
      {showWeekly && <WeeklyInvoicingDrawer onClose={() => setShowWeekly(false)} onDone={() => refetch()} />}
      {markPaidInv && (
        <MarkPaidMethodModal
          invoice={markPaidInv}
          busy={payingInvoiceId === markPaidInv.id}
          onPick={async (method) => { const id = markPaidInv.id; setMarkPaidInv(null); await markInvoicePaid(id, method); }}
          onClose={() => setMarkPaidInv(null)}
        />
      )}
      {showCloseDay && <CloseDayModal onClose={() => setShowCloseDay(false)} onOpenBatchInvoice={() => setShowBatch(true)} />}
      {showNewInvoice && <NewInvoiceModal onClose={() => setShowNewInvoice(false)} onDone={() => refetch()} />}
    </>
  );
}
