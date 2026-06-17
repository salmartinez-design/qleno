import { useState, useMemo } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Layers, ChevronDown, ChevronUp, AlertCircle } from "lucide-react";

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

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const CARD: React.CSSProperties = {
  backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10,
  padding: "18px 20px", marginBottom: 14,
};
const money = (n: number) => `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

function ClientCard({ client, month, onDone }: { client: any; month: string; onDone: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  // Parent = the first invoice of the month; it can't be excluded.
  const parentId = client.first_invoice_id;
  const includedTotal = useMemo(
    () => Math.round(client.visits.filter((v: any) => !excluded.has(v.invoice_id)).reduce((s: number, v: any) => s + v.total, 0) * 100) / 100,
    [client.visits, excluded],
  );

  function toggle(invoiceId: number) {
    if (invoiceId === parentId) return; // parent line stays
    setExcluded(prev => {
      const next = new Set(prev);
      next.has(invoiceId) ? next.delete(invoiceId) : next.add(invoiceId);
      return next;
    });
  }

  async function consolidate() {
    if (!window.confirm(`Consolidate ${client.visit_count - excluded.size} visit(s) for ${client.client_name} into one invoice of ${money(includedTotal)} and send?`)) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/api/batch-invoicing/${client.client_id}/consolidate`, {
        method: "POST",
        body: JSON.stringify({ month, exclude_invoice_ids: Array.from(excluded) }),
      });
      toast({ title: `Consolidated ${r.visit_count} visit(s) — invoice #${r.parent_invoice_id} sent for ${money(r.parent_total)}` });
      onDone();
    } catch (e: any) {
      toast({ title: e?.message || "Consolidation failed", variant: "destructive" });
    }
    setBusy(false);
  }

  return (
    <div style={CARD}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#1A1917" }}>{client.client_name}</div>
          <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 2 }}>
            {client.visit_count} visit{client.visit_count === 1 ? "" : "s"} this month
            {client.client_email ? ` · ${client.client_email}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>To bill</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#1A1917" }}>{money(includedTotal)}</div>
          </div>
          <button onClick={consolidate} disabled={busy || includedTotal <= 0}
            style={{ padding: "10px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy || includedTotal <= 0 ? 0.6 : 1, fontFamily: FF }}>
            {busy ? "Sending..." : "Consolidate & Send"}
          </button>
          <button onClick={() => setOpen(o => !o)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#6B7280", display: "flex", alignItems: "center" }}>
            {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 14, borderTop: "1px solid #F0EDE8", paddingTop: 12 }}>
          {client.visits.map((v: any) => {
            const isParent = v.invoice_id === parentId;
            const isExcluded = excluded.has(v.invoice_id);
            return (
              <div key={v.invoice_id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 0", opacity: isExcluded ? 0.45 : 1 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: isParent ? "default" : "pointer", fontSize: 13, color: "#1A1917" }}>
                  <input type="checkbox" checked={!isExcluded} disabled={isParent} onChange={() => toggle(v.invoice_id)} />
                  <span>
                    {v.created_at ? new Date(v.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                    {v.invoice_number ? ` · #${v.invoice_number}` : ""}
                    {isParent && <span style={{ marginLeft: 8, fontSize: 11, color: "#6D28D9", fontWeight: 700 }}>FIRST OF MONTH (parent)</span>}
                  </span>
                </label>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", textDecoration: isExcluded ? "line-through" : "none" }}>{money(v.total)}</span>
              </div>
            );
          })}
          <p style={{ margin: "10px 0 0", fontSize: 11, color: "#9E9B94" }}>
            Unchecking a visit excludes its amount from the consolidated invoice (e.g. already billed in QuickBooks). The per-visit record is kept either way.
          </p>
        </div>
      )}
    </div>
  );
}

export default function BatchInvoicingPage() {
  const qc = useQueryClient();
  const [month, setMonth] = useState(currentMonth());

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["batch-invoicing", month],
    queryFn: () => apiFetch(`/api/batch-invoicing?month=${month}`),
  });

  const clients: any[] = data?.clients || [];

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 880, margin: "0 auto", fontFamily: FF }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#1A1917", display: "flex", alignItems: "center", gap: 10 }}>
              <Layers size={20} /> Batch Invoicing
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>
              Monthly-billed clients. Each pending visit folds into the month's first invoice when you consolidate.
            </p>
          </div>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, color: "#1A1917", backgroundColor: "#FFFFFF" }} />
        </div>

        {isLoading ? (
          <div style={{ textAlign: "center", padding: 60, color: "#9E9B94" }}>Loading...</div>
        ) : clients.length === 0 ? (
          <div style={{ ...CARD, textAlign: "center", padding: 50, color: "#6B7280" }}>
            <AlertCircle size={36} style={{ color: "#C4C0BB", marginBottom: 12 }} />
            <p style={{ margin: 0 }}>No batch-invoice clients with pending visits for {month}.</p>
          </div>
        ) : (
          clients.map((c: any) => (
            <ClientCard key={c.client_id} client={c} month={month}
              onDone={() => { refetch(); qc.invalidateQueries({ queryKey: ["invoices"] }); }} />
          ))
        )}
      </div>
    </DashboardLayout>
  );
}
