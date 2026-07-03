import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { ArrowLeft, Send, DollarSign, CreditCard, Clock, AlertCircle, Printer } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { CalendarPopover } from "@/components/calendar-popover";
import { useTenantBrand } from "@/lib/tenant-brand";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

// [invoice-redesign 2026-06-22] Friendly sub-description per service package so a
// line reads "Deep Clean · Detailed top-to-bottom service…" instead of a bare slug.
const SERVICE_INFO: Record<string, string> = {
  "deep clean": "Detailed top-to-bottom service: baseboards, inside cabinets, appliance exteriors, and full kitchen and bath detail.",
  "deep clean or move in/out": "Detailed top-to-bottom move-ready service: baseboards, inside cabinets and appliances, full detail.",
  "standard clean": "Full maintenance cleaning of all living areas, kitchen, and bathrooms.",
  "recurring standard clean": "Recurring maintenance cleaning of all living areas, kitchen, and bathrooms.",
  "move in": "Complete pre-occupancy detail clean of an empty home.",
  "move out": "Move-out detail clean to turnover-ready condition.",
  "move in/out": "Complete move in / move out detail clean.",
  "common areas": "Lobbies, hallways, elevators, and shared building spaces.",
  "carpet cleaning": "Hot-water extraction carpet cleaning.",
  "ppm turnover": "Full unit turnover clean between residents.",
  "ppm common areas": "Scheduled common-area maintenance service.",
  "office cleaning": "Commercial workspace cleaning service.",
};
function svcBlurb(desc: string): string {
  return SERVICE_INFO[(desc || "").toLowerCase().replace(/_/g, " ").trim()] || "";
}

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

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.draft;
  return (
    <span style={{ ...s, display: "inline-flex", alignItems: "center", padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
      {status}
    </span>
  );
}

function MarkPaidModal({ invoice, onClose, onSuccess }: { invoice: any; onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const [method, setMethod] = useState("cash");
  const [amount, setAmount] = useState((invoice.total || 0).toFixed(2));
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch(`/api/invoices/${invoice.id}/mark-paid`, {
        method: "POST",
        body: JSON.stringify({ method, amount: parseFloat(amount), date, notes }),
      });
      toast({ title: "Invoice marked as paid" });
      onSuccess();
      onClose();
    } catch {
      toast({ title: "Failed to mark as paid", variant: "destructive" });
    }
    setSaving(false);
  }

  const INPUT: React.CSSProperties = { padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, width: "100%", boxSizing: "border-box" as const };
  const SELECT: React.CSSProperties = { ...INPUT, backgroundColor: "#FFFFFF" };

  return (
    <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ backgroundColor: "#FFFFFF", borderRadius: 16, boxShadow: "0 8px 40px rgba(0,0,0,0.12)", width: "100%", maxWidth: 420, padding: 28, fontFamily: FF }}>
        <h3 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 800, color: "#1A1917" }}>Mark Invoice as Paid</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 6 }}>Payment Method</label>
            <select value={method} onChange={e => setMethod(e.target.value)} style={SELECT}>
              <option value="cash">Cash</option>
              <option value="check">Check</option>
              <option value="ach">ACH / Bank transfer</option>
              <option value="zelle">Zelle</option>
              <option value="venmo">Venmo</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 6 }}>Amount</label>
            <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} style={INPUT} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 6 }}>Date</label>
            <CalendarPopover value={date} ariaLabel="Date" onChange={setDate} block />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 6 }}>Notes (optional)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              style={{ ...INPUT, resize: "vertical" as const }} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px", border: "1px solid #E5E2DC", borderRadius: 8, backgroundColor: "transparent", color: "#6B7280", fontSize: 13, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{ flex: 2, padding: "10px", border: "none", borderRadius: 8, backgroundColor: "var(--brand)", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            {saving ? "Saving..." : "Record Payment"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function InvoiceDetailPage() {
  const [, params] = useRoute("/invoices/:id");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const invoiceId = params?.id;

  const [showMarkPaid, setShowMarkPaid] = useState(false);
  const [showRefund, setShowRefund] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(false);
  const [sendingInvoice, setSendingInvoice] = useState(false);
  const [charging, setCharging] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [markingUnpaid, setMarkingUnpaid] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLines, setEditLines] = useState<any[]>([]);
  const [editTip, setEditTip] = useState(0);
  const [editDue, setEditDue] = useState<string>(""); // YYYY-MM-DD, "" = due on receipt
  const [savingEdit, setSavingEdit] = useState(false);
  const [recalcing, setRecalcing] = useState(false);

  const { data: invoice, isLoading } = useQuery({
    queryKey: ["invoice", invoiceId],
    queryFn: () => apiFetch(`/api/invoices/${invoiceId}`),
    enabled: !!invoiceId,
  });

  // [invoice-redesign 2026-06-22] Tenant logo + name for the invoice masthead.
  // logoUrl falls back to the bundled Phes logo (same pattern as estimate-public).
  const { logoUrl, companyName, company } = useTenantBrand();
  const logoSrc = logoUrl || `${import.meta.env.BASE_URL}phes-logo.jpeg`;
  // [invoice-branding 2026-06-23] All header/footer/terms text is per-tenant,
  // pulled from company settings with generic fallbacks so a company that hasn't
  // customized anything still gets a clean, correct invoice (no hardcoded Phes).
  const co: any = company || {};
  const bizName = co.invoice_business_name || companyName || "Your Company";
  const bizTagline = co.invoice_tagline || "";
  const bizAddress = co.invoice_address || co.address || "";
  const bizPhone = co.phone || "";
  const bizEmail = co.email || "";
  const contactLine = [bizPhone, bizEmail].filter(Boolean).join(" · ");
  const footerMessage = co.invoice_footer_message || `Thank you for choosing ${bizName}.`;
  const paymentInstructions = co.invoice_payment_instructions
    || `Pay securely online using the link on this invoice.${contactLine ? ` Questions? Contact us at ${contactLine}.` : ""}`;
  const guaranteeText = co.invoice_guarantee || "";
  const termsText = co.invoice_terms || "";

  async function handleSendInvoice() {
    setSendingInvoice(true);
    try {
      await apiFetch(`/api/invoices/${invoiceId}/send`, { method: "POST" });
      toast({ title: "Invoice sent to client" });
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    } catch {
      toast({ title: "Failed to send invoice", variant: "destructive" });
    }
    setSendingInvoice(false);
  }

  async function handleSendReminder() {
    setSendingReminder(true);
    try {
      await apiFetch(`/api/invoices/${invoiceId}/remind`, { method: "POST" });
      toast({ title: `Reminder sent to ${invoice?.client_email || "client"}` });
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    } catch {
      toast({ title: "Failed to send reminder", variant: "destructive" });
    }
    setSendingReminder(false);
  }

  // Office-triggered charge. Routes by payment_source server-side; charges once,
  // never retries. The response tells us what happened (paid / failed / manual).
  async function handleCharge() {
    if (!window.confirm("Charge this invoice now? Charging happens once and is never auto-retried.")) return;
    setCharging(true);
    try {
      const r = await apiFetch(`/api/invoices/${invoiceId}/charge`, { method: "POST" });
      if (r.outcome === "paid") {
        toast({ title: `Charged $${(r.amount || 0).toFixed(2)} via ${r.source}` });
      } else if (r.outcome === "needs_manual") {
        toast({ title: r.message });
      } else {
        toast({ title: r.message || "Charge failed", variant: "destructive" });
      }
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    } catch (e: any) {
      toast({ title: e?.message || "Charge failed", variant: "destructive" });
    }
    setCharging(false);
  }

  async function handleVoid() {
    if (!window.confirm("Void this invoice? This cannot be undone.")) return;
    setVoiding(true);
    try {
      await apiFetch(`/api/invoices/${invoiceId}/void`, { method: "POST" });
      toast({ title: "Invoice voided" });
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed to void invoice", variant: "destructive" });
    }
    setVoiding(false);
  }

  // One-click "Mark Paid = now". Payment is collected externally (Square); this
  // just records the manual mark and sets paid_at so the Paid(30d)/YTD KPIs fill.
  async function handleMarkPaidNow() {
    setMarkingPaid(true);
    try {
      await apiFetch(`/api/invoices/${invoiceId}/mark-paid`, { method: "POST", body: JSON.stringify({}) });
      toast({ title: "Marked paid" });
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed to mark paid", variant: "destructive" });
    }
    setMarkingPaid(false);
  }

  // Undo a manual Mark Paid — reverts to outstanding and clears paid_at.
  async function handleMarkUnpaid() {
    if (!window.confirm("Mark this invoice unpaid? It returns to Outstanding and the recorded payment is removed.")) return;
    setMarkingUnpaid(true);
    try {
      await apiFetch(`/api/invoices/${invoiceId}/mark-unpaid`, { method: "POST" });
      toast({ title: "Marked unpaid" });
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed to mark unpaid", variant: "destructive" });
    }
    setMarkingUnpaid(false);
  }

  // ── Edit invoice (line items / amounts / tip / discount) ──
  function startEdit() {
    const lines = Array.isArray(invoice?.line_items) ? invoice.line_items : [];
    setEditLines(lines.map((l: any) => ({
      description: l.description || "",
      quantity: Number(l.quantity ?? 1),
      unit_price: Number(l.unit_price ?? l.rate ?? 0),
      total: Number(l.total ?? 0),
    })));
    setEditTip(Number(invoice?.tips || 0));
    setEditDue(invoice?.due_date || "");
    setEditing(true);
  }
  function setLine(i: number, patch: any) {
    setEditLines(prev => prev.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      next.total = Math.round((Number(next.quantity) || 0) * (Number(next.unit_price) || 0) * 100) / 100;
      return next;
    }));
  }
  const editSubtotal = Math.round(editLines.reduce((s, l) => s + (Number(l.total) || 0), 0) * 100) / 100;
  const editTotal = Math.round((editSubtotal + (Number(editTip) || 0)) * 100) / 100;

  async function handleSaveEdit() {
    setSavingEdit(true);
    try {
      await apiFetch(`/api/invoices/${invoiceId}`, {
        method: "PUT",
        body: JSON.stringify({
          // Coerce every numeric field to a Number — the qty/rate inputs hold
          // raw e.target.value strings, and persisting them as strings is what
          // crashed the View render (.toFixed on a string). Send numbers.
          line_items: editLines.map((l: any) => ({
            description: l.description || "",
            quantity: Number(l.quantity) || 0,
            unit_price: Number(l.unit_price) || 0,
            total: Number(l.total) || 0,
          })),
          tips: Number(editTip) || 0,
          due_date: editDue || null,
        }),
      });
      toast({ title: "Invoice updated" });
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed to save invoice", variant: "destructive" });
    }
    setSavingEdit(false);
  }

  async function handleRecalc() {
    if (!window.confirm("Rebuild this invoice's line items from the job's current add-ons, discounts and price? This replaces the current lines (your tip is kept).")) return;
    setRecalcing(true);
    try {
      await apiFetch(`/api/invoices/${invoiceId}/recalc`, { method: "POST" });
      toast({ title: "Invoice recalculated from job" });
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed to recalc invoice", variant: "destructive" });
    }
    setRecalcing(false);
  }

  const CARD: React.CSSProperties = {
    backgroundColor: "#FFFFFF",
    border: "1px solid #E5E2DC",
    borderRadius: 10,
    padding: "20px 24px",
    marginBottom: 16,
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div style={{ textAlign: "center", padding: 60, color: "#9E9B94", fontFamily: FF }}>Loading invoice...</div>
      </DashboardLayout>
    );
  }

  if (!invoice) {
    return (
      <DashboardLayout>
        <div style={{ textAlign: "center", padding: 60, fontFamily: FF }}>
          <AlertCircle size={40} style={{ color: "#C4C0BB", marginBottom: 16 }} />
          <p style={{ color: "#6B7280" }}>Invoice not found.</p>
        </div>
      </DashboardLayout>
    );
  }

  // [date-tz-fix] Anchor the date-only due_date to end of day so an invoice is
  // not flagged overdue a day early (bare YYYY-MM-DD parses as UTC midnight).
  const isOverdue = invoice.status === "overdue" || (invoice.status === "sent" && invoice.due_date && new Date(invoice.due_date + "T23:59:59") < new Date());
  const effectiveStatus = isOverdue ? "overdue" : invoice.status;
  const lineItems: any[] = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  // [invoice-redesign] "<city>, <state> <zip>" — canonical address second line.
  const billLine2 = [invoice.client_city, invoice.client_state].filter(Boolean).join(", ")
    + (invoice.client_zip ? ` ${invoice.client_zip}` : "");

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 760, margin: "0 auto", fontFamily: FF }}>
        <style>{`@media print {
  body * { visibility: hidden !important; }
  #invoice-doc, #invoice-doc * { visibility: visible !important; }
  #invoice-doc { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none !important; border: none !important; }
  .no-print { display: none !important; }
}`}</style>
        <button className="no-print" onClick={() => navigate("/invoices")}
          style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", color: "#6B7280", fontSize: 13, marginBottom: 20, padding: 0 }}>
          <ArrowLeft size={15} /> Back to Invoices
        </button>

        <div id="invoice-doc" style={{ ...CARD, padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, padding: "26px 30px 18px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <img src={logoSrc} alt={bizName} style={{ height: 72, width: "auto", objectFit: "contain" }} />
              <div>
                <p style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "#1A1917" }}>{bizName}</p>
                {bizTagline && <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9E9B94" }}>{bizTagline}</p>}
                {bizAddress && <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9E9B94" }}>{bizAddress}</p>}
                {contactLine && <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9E9B94" }}>{contactLine}</p>}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "0.12em", color: "#1A1917" }}>INVOICE</p>
              <p style={{ margin: "6px 0 0", fontSize: 13, color: "#6B7280" }}>No. <span style={{ color: "#1A1917", fontWeight: 700 }}>{invoice.invoice_number || `INV-${String(invoice.id).padStart(4, "0")}`}</span></p>
              <div style={{ marginTop: 8 }}><StatusBadge status={effectiveStatus} /></div>
            </div>
          </div>
          <div style={{ height: 3, background: "#00C9A0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 24, padding: "18px 30px", flexWrap: "wrap" }}>
            <div>
              <p style={{ margin: "0 0 6px", fontSize: 11, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.08em" }}>Bill to</p>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#1A1917" }}>{invoice.client_name?.trim() || invoice.account_name || "—"}</p>
              {invoice.client_address && <p style={{ margin: "3px 0 0", fontSize: 13, color: "#4B4A47", lineHeight: 1.5 }}>{invoice.client_address}{billLine2 ? <><br />{billLine2}</> : null}</p>}
              {invoice.client_phone && <p style={{ margin: "3px 0 0", fontSize: 13, color: "#4B4A47" }}>{invoice.client_phone}</p>}
              {invoice.client_email && <p style={{ margin: "3px 0 0", fontSize: 13, color: "#4B4A47" }}>{invoice.client_email}</p>}
              {!invoice.client_address && !invoice.client_name?.trim() && !invoice.account_name && <p style={{ margin: "3px 0 0", fontSize: 12, color: "#C2410C" }}>No billing address on file</p>}
            </div>
            <div style={{ textAlign: "right", fontSize: 13, color: "#4B4A47" }}>
              <div style={{ marginBottom: 5 }}><span style={{ color: "#9E9B94" }}>Issued </span>{invoice.created_at ? new Date(invoice.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</div>
              <div style={{ marginBottom: 5 }}><span style={{ color: "#9E9B94" }}>Service </span>{invoice.service_date ? new Date(invoice.service_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</div>
              <div><span style={{ color: "#9E9B94" }}>Due </span>{invoice.due_date ? new Date(invoice.due_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "On receipt"}</div>
            </div>
          </div>

          <div style={{ padding: "8px 30px 26px" }}>
            {editing ? (
              <div>
                {editLines.map((l, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                    <input value={l.description} placeholder="Description"
                      onChange={e => setLine(i, { description: e.target.value })}
                      style={{ flex: 1, padding: "7px 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, fontFamily: FF }} />
                    <input type="number" step="0.01" value={l.quantity} title="Qty"
                      onChange={e => setLine(i, { quantity: e.target.value })}
                      style={{ width: 60, padding: "7px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, textAlign: "right", fontFamily: FF }} />
                    <input type="number" step="0.01" value={l.unit_price} title="Rate (negative = discount)"
                      onChange={e => setLine(i, { unit_price: e.target.value })}
                      style={{ width: 90, padding: "7px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, textAlign: "right", fontFamily: FF }} />
                    <span style={{ width: 80, textAlign: "right", fontSize: 13, fontWeight: 700, color: l.total < 0 ? "#991B1B" : "#1A1917" }}>${Number(l.total || 0).toFixed(2)}</span>
                    <button onClick={() => setEditLines(prev => prev.filter((_, idx) => idx !== i))}
                      title="Remove line" style={{ background: "none", border: "none", color: "#9E9B94", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8, marginTop: 4, marginBottom: 14 }}>
                  <button onClick={() => setEditLines(prev => [...prev, { description: "", quantity: 1, unit_price: 0, total: 0 }])}
                    style={{ padding: "6px 12px", border: "1px solid #E5E2DC", borderRadius: 6, background: "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>+ Add line</button>
                  <button onClick={() => setEditLines(prev => [...prev, { description: "Discount", quantity: 1, unit_price: 0, total: 0 }])}
                    style={{ padding: "6px 12px", border: "1px solid #E5E2DC", borderRadius: 6, background: "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>+ Add discount</button>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: "#6B7280" }}>Due date</span>
                  <div style={{ width: 160 }}>
                    <CalendarPopover value={editDue} ariaLabel="Due date" onChange={setEditDue} block />
                  </div>
                  {editDue && (
                    <button type="button" onClick={() => setEditDue("")}
                      title="Clear — bill due on receipt"
                      style={{ background: "none", border: "none", color: "#9E9B94", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: FF, textDecoration: "underline" }}>
                      Due on receipt
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: "#6B7280" }}>Tip</span>
                  <input type="number" step="0.01" value={editTip} onChange={e => setEditTip(Number(e.target.value) || 0)}
                    style={{ width: 100, padding: "7px 8px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, textAlign: "right", fontFamily: FF }} />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 24, borderTop: "2px solid #EEECE7", paddingTop: 10, marginTop: 6 }}>
                  <span style={{ fontSize: 13, color: "#6B7280" }}>Subtotal ${editSubtotal.toFixed(2)}</span>
                  <span style={{ fontSize: 16, fontWeight: 800, color: "#1A1917" }}>Total ${editTotal.toFixed(2)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
                  <button onClick={() => setEditing(false)}
                    style={{ padding: "9px 16px", border: "1px solid #E5E2DC", borderRadius: 8, background: "transparent", color: "#6B7280", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>Cancel</button>
                  <button onClick={handleSaveEdit} disabled={savingEdit}
                    style={{ padding: "9px 20px", border: "none", borderRadius: 8, backgroundColor: "var(--brand)", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
                    {savingEdit ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </div>
            ) : lineItems.length === 0 ? (
              <p style={{ fontSize: 13, color: "#9E9B94", margin: 0 }}>No line items recorded.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #EEECE7" }}>
                    {["Description", "Qty", "Rate", "Amount"].map(h => (
                      <th key={h} style={{ padding: "8px 0", fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", textAlign: h === "Description" ? "left" : "right" as any }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((item, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #F0EDE8" }}>
                      <td style={{ padding: "10px 0", fontSize: 13, color: "#1A1917" }}>
                        <div style={{ fontWeight: 600, textTransform: "capitalize" }}>{(item.description || "").replace(/_/g, " ")}</div>
                        {i === 0 && svcBlurb(item.description) && (
                          <div style={{ fontSize: 11.5, color: "#9E9B94", marginTop: 2, lineHeight: 1.4 }}>{svcBlurb(item.description)}</div>
                        )}
                      </td>
                      <td style={{ padding: "10px 0", fontSize: 13, color: "#6B7280", textAlign: "right", verticalAlign: "top" }}>{Number(item.quantity ?? 1)}</td>
                      <td style={{ padding: "10px 0", fontSize: 13, color: "#6B7280", textAlign: "right", verticalAlign: "top" }}>${Number((item.unit_price ?? item.rate) || 0).toFixed(2)}</td>
                      <td style={{ padding: "10px 0", fontSize: 13, fontWeight: 700, color: "#1A1917", textAlign: "right", verticalAlign: "top" }}>${Number(item.total || 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {(invoice.tips || 0) > 0 && (
                    <tr>
                      <td colSpan={3} style={{ padding: "12px 0 4px", fontSize: 13, color: "#6B7280", textAlign: "right" }}>Tips</td>
                      <td style={{ padding: "12px 0 4px", fontSize: 13, fontWeight: 700, color: "#1A1917", textAlign: "right" }}>${(invoice.tips || 0).toFixed(2)}</td>
                    </tr>
                  )}
                  <tr style={{ borderTop: "2px solid #1A1917" }}>
                    <td colSpan={3} style={{ padding: "12px 0 0", fontSize: 15, fontWeight: 700, color: "#1A1917", textAlign: "right" }}>Total due</td>
                    <td style={{ padding: "12px 0 0", fontSize: 20, fontWeight: 800, color: "#1A1917", textAlign: "right" }}>${(invoice.total || 0).toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            )}

            {!editing && (
              <div style={{ marginTop: 26, borderTop: "1px solid #F0EDE8", paddingTop: 16 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{footerMessage}</p>
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6B7280", lineHeight: 1.6 }}>{paymentInstructions}</p>
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6B7280", lineHeight: 1.6 }}>Payment terms: {invoice.due_date ? `due by ${new Date(invoice.due_date + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}` : "due on receipt"}.</p>
                {guaranteeText && (
                  <p style={{ margin: "12px 0 0", fontSize: 11, color: "#9E9B94", lineHeight: 1.6 }}>{guaranteeText}</p>
                )}
                {termsText && (
                  <p style={{ margin: "8px 0 0", fontSize: 11, color: "#9E9B94", lineHeight: 1.6 }}>{termsText}</p>
                )}
                {(bizName || bizAddress) && (
                  <p style={{ margin: "8px 0 0", fontSize: 11, color: "#9E9B94" }}>{[bizName, bizAddress].filter(Boolean).join(", ")}</p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="no-print" style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <button onClick={() => window.print()}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "#1A1917", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            <Printer size={14} /> Print / PDF
          </button>
          {(invoice.status === "draft") && (
            <button onClick={handleSendInvoice} disabled={sendingInvoice}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              <Send size={14} /> {sendingInvoice ? "Sending..." : "Send Invoice"}
            </button>
          )}
          {(effectiveStatus === "sent" || effectiveStatus === "overdue") && (
            <>
              {invoice.has_card_on_file && (
                <button onClick={handleCharge} disabled={charging}
                  title={`Charge the card captured at booking${invoice.card_last_four ? ` (•••• ${invoice.card_last_four})` : ""}`}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  <CreditCard size={14} /> {charging ? "Charging..." : `Charge Card on File${invoice.card_last_four ? ` •••• ${invoice.card_last_four}` : ""}`}
                </button>
              )}
              <button onClick={handleMarkPaidNow} disabled={markingPaid}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "#16A34A", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                <DollarSign size={14} /> {markingPaid ? "Marking..." : "Mark Paid"}
              </button>
              <button onClick={() => setShowMarkPaid(true)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Record payment…
              </button>
              {effectiveStatus === "overdue" && (
                <button onClick={handleSendReminder} disabled={sendingReminder}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  <Clock size={14} /> {sendingReminder ? "Sending..." : "Send Reminder"}
                </button>
              )}
            </>
          )}
          {(invoice.status === "draft" || effectiveStatus === "sent" || effectiveStatus === "overdue") && (
            <button onClick={handleVoid} disabled={voiding}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "transparent", color: "#991B1B", border: "1px solid #FECACA", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              {voiding ? "Voiding..." : "Void"}
            </button>
          )}
          {invoice.status === "paid" && (
            <>
              {(invoice.refunded_amount ?? 0) < invoice.total && (
                <button onClick={() => setShowRefund(true)}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "transparent", color: "#7C3AED", border: "1px solid #DDD6FE", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  Issue Refund
                </button>
              )}
              <button onClick={handleMarkUnpaid} disabled={markingUnpaid}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "transparent", color: "#92400E", border: "1px solid #FDE68A", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                {markingUnpaid ? "Updating..." : "Mark Unpaid"}
              </button>
            </>
          )}
          {!["paid", "void", "superseded"].includes(invoice.status) && !editing && (
            <button onClick={startEdit}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "transparent", color: "#1A1917", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              Edit
            </button>
          )}
          {!["paid", "void", "superseded"].includes(invoice.status) && invoice.job_id && !editing && (
            <button onClick={handleRecalc} disabled={recalcing}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "transparent", color: "#1A1917", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              {recalcing ? "Recalculating..." : "Recalc from Job"}
            </button>
          )}
        </div>
        {invoice.payment_failed && (effectiveStatus === "sent" || effectiveStatus === "overdue") && (
          <div className="no-print" style={{ marginBottom: 20, padding: "10px 14px", backgroundColor: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, fontSize: 13, color: "#991B1B", display: "flex", alignItems: "center", gap: 8 }}>
            <AlertCircle size={15} /> Last charge attempt failed — contact the client for a backup payment method. Charges are never auto-retried.
          </div>
        )}

        <div className="no-print" style={CARD}>
          <h3 style={{ margin: "0 0 16px", fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Invoice Details</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 24px" }}>
            {[
              { label: "Invoice Number", value: invoice.invoice_number || `INV-${String(invoice.id).padStart(4, "0")}` },
              { label: "Status", value: <StatusBadge status={effectiveStatus} /> },
              { label: "Service Date", value: invoice.service_date ? new Date(invoice.service_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—" },
              { label: "Created", value: invoice.created_at ? new Date(invoice.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—" },
              { label: "Due Date", value: invoice.due_date ? new Date(invoice.due_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—" },
              { label: "Issued", value: (() => {
                // sent_at = the moment the email was sent to the client.
                // For auto-finalized per-visit invoices that were never emailed,
                // sent_at may be null even though status='sent'. Fall back to
                // created_at so the office always sees when the invoice went live.
                const ts = invoice.sent_at || (["sent","paid","overdue"].includes(invoice.status) ? invoice.created_at : null);
                return ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
              })() },
              { label: "Paid", value: invoice.paid_at ? new Date(invoice.paid_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—" },
              ...(invoice.refunded_amount != null ? [{ label: "Refunded", value: `$${Number(invoice.refunded_amount).toFixed(2)}${invoice.refunded_at ? " on " + new Date(invoice.refunded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}` }] : []),
            ].map(({ label, value }) => (
              <div key={label} style={{ padding: "8px 0", borderBottom: "1px solid #F0EDE8" }}>
                <p style={{ margin: "0 0 2px", fontSize: 11, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</p>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{value}</div>
              </div>
            ))}
          </div>
          {isOverdue && (
            <div style={{ marginTop: 14, padding: "10px 14px", backgroundColor: "#FEE2E2", border: "1px solid #FECACA", borderRadius: 8 }}>
              <p style={{ margin: 0, fontSize: 12, color: "#991B1B", fontWeight: 600 }}>
                Overdue by {invoice.days_overdue || 0} day{invoice.days_overdue !== 1 ? "s" : ""}
              </p>
            </div>
          )}
        </div>

      </div>

      {showMarkPaid && (
        <MarkPaidModal
          invoice={invoice}
          onClose={() => setShowMarkPaid(false)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
            qc.invalidateQueries({ queryKey: ["invoices"] });
          }}
        />
      )}
      {showRefund && (
        <RefundModal
          invoice={invoice}
          onClose={() => setShowRefund(false)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
            qc.invalidateQueries({ queryKey: ["invoices"] });
          }}
        />
      )}
    </DashboardLayout>
  );
}

// ── Refund Modal ─────────────────────────────────────────────────────────────
function RefundModal({ invoice, onClose, onSuccess }: { invoice: any; onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const alreadyRefunded = Number(invoice.refunded_amount ?? 0);
  const maxRefundable = Number(invoice.total) - alreadyRefunded;
  const [amount, setAmount] = useState(maxRefundable.toFixed(2));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const isStripe = !!invoice.stripe_payment_intent_id && invoice.payment_source === "stripe";

  async function submit() {
    const val = parseFloat(amount);
    if (!val || val <= 0 || val > maxRefundable + 0.005) {
      toast({ title: `Amount must be between $0.01 and $${maxRefundable.toFixed(2)}`, variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/invoices/${invoice.id}/refund`, {
        method: "POST",
        body: JSON.stringify({ amount: val, reason: reason.trim() || undefined }),
      });
      toast({ title: `Refund of $${val.toFixed(2)} issued` });
      onSuccess();
      onClose();
    } catch (e: any) {
      toast({ title: e?.message || "Refund failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, width: 380, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", fontFamily: FF }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 800, color: "#1A1917" }}>Issue Refund</h3>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "#6B6963" }}>
          Invoice total: <strong>${Number(invoice.total).toFixed(2)}</strong>
          {alreadyRefunded > 0 && <> · Already refunded: <strong>${alreadyRefunded.toFixed(2)}</strong></>}
          {" "}· Max refundable: <strong>${maxRefundable.toFixed(2)}</strong>
        </p>
        {isStripe && (
          <div style={{ marginBottom: 14, padding: "8px 12px", backgroundColor: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 6, fontSize: 12, color: "#3730A3" }}>
            Stripe payment — funds will be returned to the card on file.
          </div>
        )}
        {!isStripe && (
          <div style={{ marginBottom: 14, padding: "8px 12px", backgroundColor: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 6, fontSize: 12, color: "#78350F" }}>
            Manual / offline payment — refund is recorded here only. Return the money via check or cash directly.
          </div>
        )}
        <label style={{ display: "block", marginBottom: 14 }}>
          <span style={{ display: "block", marginBottom: 4, fontSize: 12, fontWeight: 600, color: "#1A1917" }}>Refund Amount</span>
          <div style={{ display: "flex", alignItems: "center", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
            <span style={{ padding: "9px 12px", backgroundColor: "#F7F6F3", fontSize: 14, fontWeight: 700, color: "#6B6963", borderRight: "1px solid #E5E2DC" }}>$</span>
            <input
              type="number"
              min="0.01"
              max={maxRefundable.toFixed(2)}
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              style={{ flex: 1, padding: "9px 12px", border: "none", outline: "none", fontSize: 14, fontWeight: 600, fontFamily: FF }}
            />
            <button onClick={() => setAmount(maxRefundable.toFixed(2))} style={{ padding: "9px 12px", border: "none", backgroundColor: "transparent", color: "#7C3AED", fontSize: 12, fontWeight: 700, cursor: "pointer", borderLeft: "1px solid #E5E2DC" }}>Full</button>
          </div>
        </label>
        <label style={{ display: "block", marginBottom: 20 }}>
          <span style={{ display: "block", marginBottom: 4, fontSize: 12, fontWeight: 600, color: "#1A1917" }}>Reason (optional)</span>
          <input
            type="text"
            placeholder="e.g. Customer dissatisfied, partial service…"
            value={reason}
            onChange={e => setReason(e.target.value)}
            style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, boxSizing: "border-box" }}
          />
        </label>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={busy} style={{ padding: "9px 18px", border: "1px solid #E5E2DC", backgroundColor: "transparent", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ padding: "9px 18px", border: "none", backgroundColor: "#7C3AED", color: "#FFFFFF", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
            {busy ? "Processing..." : `Refund $${(parseFloat(amount) || 0).toFixed(2)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
