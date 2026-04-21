import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { Plus, FileText, Trash2, Edit2, Save, X, Clock, CheckCircle } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const card: React.CSSProperties = { backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "20px" };
const label: React.CSSProperties = { fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", fontFamily: "inherit", boxSizing: "border-box" };

const VARIABLES = [
  { key: "[client_name]", desc: "Client's full name" },
  { key: "[address]", desc: "Service address" },
  { key: "[service_type]", desc: "Service type" },
  { key: "[frequency]", desc: "Service frequency" },
  { key: "[start_date]", desc: "Service start date" },
  { key: "[company_name]", desc: "Your company name" },
];

const DEFAULT_BODY = `SERVICE AGREEMENT

This Service Agreement ("Agreement") is entered into between [company_name] ("Service Provider") and [client_name] ("Client").

1. SERVICES
Service Provider agrees to provide cleaning services at the following address: [address]

Service Type: [service_type]
Frequency: [frequency]
Start Date: [start_date]

2. PAYMENT TERMS
Client agrees to pay the agreed rate upon completion of each service. Invoices are due within 7 days of issue.

3. CANCELLATION POLICY
A 24-hour notice is required for cancellations. Late cancellations may be subject to a cancellation fee equal to 50% of the service rate.

4. ACCESS
Client agrees to provide reasonable access to the property on scheduled service days. Failure to provide access may result in a lockout fee.

5. SATISFACTION GUARANTEE
If Client is not satisfied with any aspect of the cleaning, they must notify Service Provider within 24 hours and we will return to correct any issues at no charge.

By signing below, Client acknowledges they have read and agree to the terms of this Service Agreement.`;

export default function AgreementTemplatesPage() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState({ name: "", body: DEFAULT_BODY, is_active: true });
  const [preview, setPreview] = useState<any | null>(null);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["agreement-templates"],
    queryFn: () => apiFetch("/api/agreement-templates"),
  });

  const createMut = useMutation({
    mutationFn: (d: any) => apiFetch("/api/agreement-templates", { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agreement-templates"] }); setEditingId(null); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, d }: { id: number; d: any }) => apiFetch(`/api/agreement-templates/${id}`, { method: "PATCH", body: JSON.stringify(d) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agreement-templates"] }); setEditingId(null); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/agreement-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agreement-templates"] }),
  });

  function startNew() {
    setForm({ name: "", body: DEFAULT_BODY, is_active: true });
    setEditingId("new");
  }

  function startEdit(t: any) {
    setForm({ name: t.name, body: t.body, is_active: t.is_active });
    setEditingId(t.id);
  }

  function handleSave() {
    if (!form.name.trim() || !form.body.trim()) return;
    if (editingId === "new") {
      createMut.mutate(form);
    } else if (typeof editingId === "number") {
      updateMut.mutate({ id: editingId, d: form });
    }
  }

  function insertVariable(v: string) {
    setForm(p => ({ ...p, body: p.body + v }));
  }

  function fmtDate(d?: string | null) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <DashboardLayout>
      <div style={{ padding: "28px 32px", maxWidth: "1100px", margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "24px" }}>
          <div>
            <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#1A1917", margin: 0 }}>Agreement Templates</h1>
            <div style={{ fontSize: "13px", color: "#6B7280", marginTop: "4px" }}>
              Create service agreement templates that can be sent to clients for electronic signing.
            </div>
          </div>
          {editingId === null && (
            <button onClick={startNew} style={{ backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: "8px", padding: "10px 18px", fontSize: "13px", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: "8px" }}>
              <Plus size={14} /> New Template
            </button>
          )}
        </div>

        {/* Editor */}
        {editingId !== null && (
          <div style={{ ...card, marginBottom: "24px", borderLeft: "3px solid var(--brand)" }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917", marginBottom: "16px" }}>
              {editingId === "new" ? "New Agreement Template" : "Edit Template"}
            </div>
            <div style={{ marginBottom: "16px" }}>
              <div style={label}>Template Name</div>
              <input style={inputStyle} placeholder="e.g. Standard Residential Service Agreement" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div style={{ marginBottom: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                <div style={label}>Agreement Body</div>
                <div style={{ fontSize: "11px", color: "#9E9B94" }}>Use variables below to personalize</div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
                {VARIABLES.map(v => (
                  <button key={v.key} onClick={() => insertVariable(v.key)} title={v.desc} style={{ backgroundColor: "#EFF6FF", color: "#1D4ED8", border: "1px solid #BFDBFE", borderRadius: "4px", padding: "3px 8px", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "monospace" }}>
                    {v.key}
                  </button>
                ))}
              </div>
              <textarea style={{ ...inputStyle, minHeight: "320px", resize: "vertical", fontFamily: "monospace", fontSize: "12px", lineHeight: "1.6" }} value={form.body} onChange={e => setForm(p => ({ ...p, body: e.target.value }))} />
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setEditingId(null)} style={{ backgroundColor: "#F3F4F6", color: "#6B7280", border: "none", borderRadius: "6px", padding: "8px 14px", fontSize: "13px", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => setPreview({ name: form.name, body: form.body })} style={{ backgroundColor: "#F7F6F3", color: "#1A1917", border: "1px solid #E5E2DC", borderRadius: "6px", padding: "8px 14px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                Preview
              </button>
              <button onClick={handleSave} disabled={createMut.isPending || updateMut.isPending} style={{ backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: "6px", padding: "8px 14px", fontSize: "13px", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: "6px" }}>
                <Save size={14} /> {createMut.isPending || updateMut.isPending ? "Saving..." : "Save Template"}
              </button>
            </div>
          </div>
        )}

        {/* Templates list */}
        {isLoading ? (
          <div style={{ ...card, textAlign: "center", color: "#9E9B94", padding: "60px" }}>Loading templates...</div>
        ) : templates.length === 0 && editingId === null ? (
          <div style={{ ...card, textAlign: "center", padding: "60px" }}>
            <FileText size={40} style={{ color: "#C4C0BB", marginBottom: "12px" }} />
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#6B7280", marginBottom: "6px" }}>No agreement templates yet</div>
            <div style={{ fontSize: "13px", color: "#9E9B94", marginBottom: "20px" }}>Create a template to send service agreements to clients for electronic signing</div>
            <button onClick={startNew} style={{ backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: "8px", padding: "10px 18px", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}>Create First Template</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {templates.map((t: any) => (
              <div key={t.id} style={{ ...card, display: "flex", alignItems: "flex-start", gap: "16px" }}>
                <div style={{ width: "40px", height: "40px", backgroundColor: "#EFF6FF", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <FileText size={20} style={{ color: "var(--brand)" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                    <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>{t.name}</div>
                    <span style={{ backgroundColor: t.is_active ? "#D1FAE5" : "#F3F4F6", color: t.is_active ? "#065F46" : "#6B7280", fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px" }}>
                      {t.is_active ? "ACTIVE" : "INACTIVE"}
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#6B7280", marginBottom: "4px" }}>
                    {t.body.split("\n").slice(0, 2).join(" ").substring(0, 120)}...
                  </div>
                  <div style={{ fontSize: "11px", color: "#9E9B94" }}>Created {fmtDate(t.created_at)} · Updated {fmtDate(t.updated_at)}</div>
                </div>
                <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                  <button onClick={() => setPreview(t)} style={{ backgroundColor: "#F7F6F3", color: "#1A1917", border: "1px solid #E5E2DC", borderRadius: "6px", padding: "6px 10px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>Preview</button>
                  <button onClick={() => startEdit(t)} style={{ backgroundColor: "#EFF6FF", color: "#1D4ED8", border: "none", borderRadius: "6px", padding: "6px 10px", cursor: "pointer" }}><Edit2 size={14} /></button>
                  <button onClick={() => { if (confirm(`Delete "${t.name}"?`)) deleteMut.mutate(t.id); }} style={{ backgroundColor: "#FEE2E2", color: "#991B1B", border: "none", borderRadius: "6px", padding: "6px 10px", cursor: "pointer" }}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Preview modal */}
      {preview && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ backgroundColor: "#FFFFFF", borderRadius: "16px", padding: "32px", maxWidth: "700px", width: "100%", maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
              <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 800, color: "#1A1917" }}>{preview.name} — Preview</h2>
              <button onClick={() => setPreview(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}><X size={20} /></button>
            </div>
            <div style={{ border: "1px solid #E5E2DC", borderRadius: "8px", padding: "24px", backgroundColor: "#F7F6F3", flex: 1, overflowY: "auto" }}>
              <pre style={{ margin: 0, fontFamily: "inherit", fontSize: "13px", color: "#1A1917", lineHeight: "1.7", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{preview.body}</pre>
              <div style={{ marginTop: "40px", paddingTop: "20px", borderTop: "1px solid #E5E2DC" }}>
                <div style={{ fontSize: "12px", color: "#9E9B94", marginBottom: "24px" }}>
                  Signed electronically. By typing their name and clicking Sign Agreement, the client agrees to the above terms.
                </div>
                <div style={{ display: "flex", gap: "24px" }}>
                  <div style={{ flex: 1 }}>
                    <div style={label}>Typed Signature</div>
                    <div style={{ padding: "10px 14px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "18px", fontStyle: "italic", color: "#1A1917", backgroundColor: "#FFFFFF" }}>Jane Smith</div>
                  </div>
                  <div>
                    <div style={label}>Date</div>
                    <div style={{ padding: "10px 14px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", color: "#6B7280", backgroundColor: "#FFFFFF" }}>{new Date().toLocaleDateString()}</div>
                  </div>
                </div>
              </div>
            </div>
            <button onClick={() => setPreview(null)} style={{ marginTop: "16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: "8px", padding: "10px", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}>Close Preview</button>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
