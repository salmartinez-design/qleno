import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { ArrowLeft, Send, DollarSign, CreditCard, Clock, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
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
              <option value="venmo">Venmo</option>
              <option value="zelle">Zelle</option>
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
  const [sendingReminder, setSendingReminder] = useState(false);
  const [sendingInvoice, setSendingInvoice] = useState(false);
  const [charging, setCharging] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLines, setEditLines] = useState<any[]>([]);
  const [editTip, setEditTip] = useState(0);
  const [savingEdit, setSavingEdit] = useState(false);
  const [recalcing, setRecalcing] = useState(false);

  const { data: invoice, isLoading } = useQuery({
    queryKey: ["invoice", invoiceId],
    queryFn: () => apiFetch(`/api/invoices/${invoiceId}`),
    enabled: !!invoiceId,
  });

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
        body: JSON.stringify({ line_items: editLines, tips: Number(editTip) || 0 }),
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

  const isOverdue = invoice.status === "overdue" || (invoice.status === "sent" && invoice.due_date && new Date(invoice.due_date) < new Date());
  const effectiveStatus = isOverdue ? "overdue" : invoice.status;
  const lineItems: any[] = Array.isArray(invoice.line_items) ? invoice.line_items : [];

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 760, margin: "0 auto", fontFamily: FF }}>
        <button onClick={() => navigate("/invoices")}
          style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", color: "#6B7280", fontSize: 13, marginBottom: 20, padding: 0 }}>
          <ArrowLeft size={15} /> Back to Invoices
        </button>

        <div style={{ ...CARD, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#1A1917" }}>
                {invoice.invoice_number || `INV-${String(invoice.id).padStart(4, "0")}`}
              </h1>
              <StatusBadge status={effectiveStatus} />
            </div>
            <p style={{ margin: 0, fontSize: 14, color: "#6B7280" }}>
              {invoice.client_name}
              {invoice.client_email && <span style={{ marginLeft: 8, color: "#9E9B94" }}>· {invoice.client_email}</span>}
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <p style={{ margin: "0 0 2px", fontSize: 12, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>Total</p>
            <p style={{ margin: 0, fontSize: 32, fontWeight: 800, color: "#1A1917" }}>${(invoice.total || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          {(invoice.status === "draft") && (
            <button onClick={handleSendInvoice} disabled={sendingInvoice}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              <Send size={14} /> {sendingInvoice ? "Sending..." : "Send Invoice"}
            </button>
          )}
          {(effectiveStatus === "sent" || effectiveStatus === "overdue") && (
            <>
              <button onClick={handleCharge} disabled={charging}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                <CreditCard size={14} /> {charging ? "Charging..." : "Charge Now"}
              </button>
              <button onClick={() => setShowMarkPaid(true)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                <DollarSign size={14} /> Mark as Paid
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
          <div style={{ marginBottom: 20, padding: "10px 14px", backgroundColor: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, fontSize: 13, color: "#991B1B", display: "flex", alignItems: "center", gap: 8 }}>
            <AlertCircle size={15} /> Last charge attempt failed — contact the client for a backup payment method. Charges are never auto-retried.
          </div>
        )}

        <div style={CARD}>
          <h3 style={{ margin: "0 0 16px", fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Invoice Details</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 24px" }}>
            {[
              { label: "Invoice Number", value: invoice.invoice_number || `INV-${String(invoice.id).padStart(4, "0")}` },
              { label: "Status", value: <StatusBadge status={effectiveStatus} /> },
              { label: "Created", value: invoice.created_at ? new Date(invoice.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—" },
              { label: "Due Date", value: invoice.due_date ? new Date(invoice.due_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—" },
              { label: "Sent", value: invoice.sent_at ? new Date(invoice.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—" },
              { label: "Paid", value: invoice.paid_at ? new Date(invoice.paid_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—" },
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

        <div style={CARD}>
          <h3 style={{ margin: "0 0 16px", fontSize: 14, fontWeight: 700, color: "#1A1917" }}>Line Items</h3>

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
                  {["Description", "Qty", "Rate", "Total"].map(h => (
                    <th key={h} style={{ padding: "8px 0", fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", textAlign: h === "Description" ? "left" : "right" as any }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #F0EDE8" }}>
                    <td style={{ padding: "10px 0", fontSize: 13, color: "#1A1917", textTransform: "capitalize" }}>
                      {(item.description || "").replace(/_/g, " ")}
                    </td>
                    <td style={{ padding: "10px 0", fontSize: 13, color: "#6B7280", textAlign: "right" }}>{item.quantity || 1}</td>
                    <td style={{ padding: "10px 0", fontSize: 13, color: "#6B7280", textAlign: "right" }}>${((item.unit_price ?? item.rate) || 0).toFixed(2)}</td>
                    <td style={{ padding: "10px 0", fontSize: 13, fontWeight: 700, color: "#1A1917", textAlign: "right" }}>${(item.total || 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ padding: "12px 0 4px", fontSize: 13, color: "#6B7280", textAlign: "right" }}>Subtotal</td>
                  <td style={{ padding: "12px 0 4px", fontSize: 13, fontWeight: 700, color: "#1A1917", textAlign: "right" }}>${(invoice.subtotal || 0).toFixed(2)}</td>
                </tr>
                {(invoice.tips || 0) > 0 && (
                  <tr>
                    <td colSpan={3} style={{ padding: "4px 0", fontSize: 13, color: "#6B7280", textAlign: "right" }}>Tips</td>
                    <td style={{ padding: "4px 0", fontSize: 13, fontWeight: 700, color: "#1A1917", textAlign: "right" }}>${(invoice.tips || 0).toFixed(2)}</td>
                  </tr>
                )}
                <tr style={{ borderTop: "2px solid #EEECE7" }}>
                  <td colSpan={3} style={{ padding: "10px 0 0", fontSize: 14, fontWeight: 700, color: "#1A1917", textAlign: "right" }}>Total</td>
                  <td style={{ padding: "10px 0 0", fontSize: 18, fontWeight: 800, color: "#1A1917", textAlign: "right" }}>${(invoice.total || 0).toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
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
    </DashboardLayout>
  );
}
