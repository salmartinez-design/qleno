import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import {
  Plus, FileText, Edit2, Trash2, Copy, Send, Eye, Download,
  ChevronDown, ChevronUp, Check, X, Search, ExternalLink,
  Shield, Clock, AlertCircle, CheckCircle, FileSignature,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { headers: { ...getAuthHeaders(), "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  residential: { label: "Residential", color: "#5B9BD5" },
  commercial: { label: "Commercial", color: "#7F77DD" },
  both: { label: "Both", color: "#6B7280" },
};

const TYPE_LABELS: Record<string, { label: string; icon: any }> = {
  agreement: { label: "Agreement", icon: FileSignature },
  intake: { label: "Intake Form", icon: FileText },
  inspection: { label: "Inspection", icon: CheckCircle },
  survey: { label: "Survey", icon: FileText },
  custom: { label: "Custom", icon: FileText },
};

const STATUS_CONFIG = {
  signed: { label: "SIGNED", bg: "#D1FAE5", color: "#065F46" },
  pending: { label: "PENDING", bg: "#FEF3C7", color: "#92400E" },
  expired: { label: "EXPIRED", bg: "#F3F4F6", color: "#6B7280" },
  draft: { label: "DRAFT", bg: "#EFF6FF", color: "#1E40AF" },
};

function TemplateCard({ template, onEdit, onDuplicate, onDelete, onSend }: any) {
  const cat = CATEGORY_LABELS[template.category || "both"];
  const typ = TYPE_LABELS[template.type || "agreement"];
  const Icon = typ.icon;

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flex: 1, minWidth: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "#EFF6FF", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Icon size={18} color="#5B9BD5" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#1A1917" }}>{template.name}</span>
              {template.is_default && (
                <span style={{ fontSize: 9, fontWeight: 700, background: "#FEF3C7", color: "#92400E", padding: "2px 6px", borderRadius: 4, letterSpacing: 0.5 }}>DEFAULT</span>
              )}
              {!template.is_active && (
                <span style={{ fontSize: 9, fontWeight: 700, background: "#F3F4F6", color: "#6B7280", padding: "2px 6px", borderRadius: 4, letterSpacing: 0.5 }}>INACTIVE</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: cat.color, background: `${cat.color}18`, padding: "1px 8px", borderRadius: 10 }}>{cat.label}</span>
              <span style={{ fontSize: 10, color: "#9E9B94" }}>{typ.label}</span>
              {template.requires_sign && <span style={{ fontSize: 10, color: "#5B9BD5" }}>eSign Required</span>}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button onClick={() => onSend(template)} style={{ background: "#5B9BD5", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
            <Send size={12} /> Send
          </button>
          <button onClick={() => onEdit(template)} style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 6, padding: "6px 10px", cursor: "pointer", color: "#6B7280" }} title="Edit"><Edit2 size={13} /></button>
          <button onClick={() => onDuplicate(template.id)} style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 6, padding: "6px 10px", cursor: "pointer", color: "#6B7280" }} title="Duplicate"><Copy size={13} /></button>
          <button onClick={() => onDelete(template.id)} style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 6, padding: "6px 10px", cursor: "pointer", color: "#E53E3E" }} title="Delete"><Trash2 size={13} /></button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 20, borderTop: "1px solid #F5F4F2", paddingTop: 10 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#1A1917" }}>{template.sent_count || 0}</div>
          <div style={{ fontSize: 10, color: "#9E9B94" }}>Sent</div>
        </div>
        <div style={{ fontSize: 11, color: "#9E9B94", display: "flex", alignItems: "center", gap: 4 }}>
          <Clock size={11} />
          Modified {template.updated_at ? new Date(template.updated_at).toLocaleDateString() : "never"}
        </div>
      </div>
    </div>
  );
}

const POLICY_BLOCKS = [
  { key: "arrival_window", label: "Arrival Window", description: "2–3 hour arrival window policy" },
  { key: "service_guidelines", label: "Service Guidelines", description: "Per-visit minimum, base rate, add-on pricing" },
  { key: "addons_policy", label: "Add-Ons and Trades Policy", description: "Extra services and subcontracting policy" },
  { key: "lockout_policy", label: "Lockout Policy", description: "Fee for inaccessible property" },
  { key: "cancellation", label: "Cancellation and Rescheduling", description: "48-hour notice requirement and fees" },
  { key: "termination", label: "Termination of Services", description: "30-day notice requirement" },
  { key: "payment_terms", label: "Payment Terms", description: "Auto-charge on day of service" },
  { key: "sick_policy", label: "Sick Policy", description: "Technician illness and rescheduling" },
  { key: "safety_winter", label: "Safety and Winter Access", description: "Winter access requirements" },
  { key: "bodily_fluids", label: "Bodily Fluids / Exclusions", description: "Biohazard and exclusion policy" },
  { key: "surface_care", label: "Surface Care Disclaimer", description: "Liability for pre-damaged surfaces" },
  { key: "suspension", label: "Service Suspension Policy", description: "Up to 90-day suspension, slot retention" },
  { key: "min_frequency", label: "Minimum Frequency Protection", description: "60-day maximum between cleanings" },
  { key: "rate_protection", label: "Recurring Rate Protection", description: "Rate lock with active schedule" },
  { key: "annual_review", label: "Annual Rate Review", description: "January rate adjustment rights" },
  { key: "rate_changes", label: "Rate Changes Based on Cleaning Time", description: "2–3 month monitoring period" },
  { key: "weather", label: "Weather Policy", description: "Severe weather rescheduling" },
  { key: "holidays", label: "Holiday Closures", description: "Six observed holidays" },
  { key: "guarantee", label: "24-Hour Satisfaction Guarantee", description: "Return visit within 24 hours" },
  { key: "breakage", label: "Breakage and Damage", description: "25 lb weight limit, 24-hour reporting" },
];

function TemplateEditor({ template, onClose, onSave }: any) {
  const [name, setName] = useState(template?.name || "New Agreement");
  const [type, setType] = useState(template?.type || "agreement");
  const [category, setCategory] = useState(template?.category || "both");
  const [requiresSign, setRequiresSign] = useState(template?.requires_sign ?? true);
  const [termsBody, setTermsBody] = useState(template?.terms_body || "");
  const [activeBlocks, setActiveBlocks] = useState<Set<string>>(new Set(POLICY_BLOCKS.map(b => b.key)));
  const [expandedBlock, setExpandedBlock] = useState<string | null>(null);
  const [blockText, setBlockText] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"config" | "preview">("config");

  const qc = useQueryClient();
  const saveMutation = useMutation({
    mutationFn: async () => {
      const path = template?.id ? `/api/form-templates/${template.id}` : "/api/form-templates";
      const method = template?.id ? "PATCH" : "POST";
      return apiFetch(path, { method, body: JSON.stringify({ name, type, category, requires_sign: requiresSign, terms_body: termsBody }) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["form-templates"] }); onSave(); },
  });

  const toggleBlock = (key: string) => {
    setActiveBlocks(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, fontFamily: "'Plus Jakarta Sans', sans-serif", boxSizing: "border-box" };
  const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "#6B7280", marginBottom: 4, display: "block", textTransform: "uppercase", letterSpacing: 0.5 };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)" }} onClick={onClose} />
      <div style={{ position: "relative", marginLeft: "auto", width: "90vw", maxWidth: 1200, height: "100vh", background: "#F7F6F3", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "-4px 0 30px rgba(0,0,0,0.15)" }}>
        <div style={{ padding: "16px 24px", background: "#fff", borderBottom: "1px solid #E5E2DC", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <FileSignature size={20} color="#5B9BD5" />
            <input value={name} onChange={e => setName(e.target.value)} style={{ fontSize: 18, fontWeight: 700, border: "none", outline: "none", background: "transparent", fontFamily: "'Plus Jakarta Sans', sans-serif", color: "#1A1917", width: 340 }} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ display: "flex", background: "#F7F6F3", borderRadius: 8, padding: 3 }}>
              {["config", "preview"].map(t => (
                <button key={t} onClick={() => setTab(t as any)} style={{ padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: tab === t ? "#fff" : "transparent", color: tab === t ? "#1A1917" : "#9E9B94", boxShadow: tab === t ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>
                  {t === "config" ? "Configure" : "Preview"}
                </button>
              ))}
            </div>
            <button onClick={() => saveMutation.mutate()} style={{ background: "#5B9BD5", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Save Template</button>
            <button onClick={onClose} style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 8, padding: "8px 12px", cursor: "pointer", color: "#6B7280" }}><X size={16} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
          {tab === "config" ? (
            <div style={{ display: "flex", width: "100%", gap: 0 }}>
              <div style={{ width: 340, minWidth: 340, background: "#fff", borderRight: "1px solid #E5E2DC", overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 20 }}>
                <div>
                  <span style={labelStyle}>Template Settings</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div>
                      <label style={labelStyle}>Type</label>
                      <select value={type} onChange={e => setType(e.target.value)} style={inputStyle}>
                        <option value="agreement">Agreement</option>
                        <option value="intake">Intake Form</option>
                        <option value="inspection">Inspection</option>
                        <option value="survey">Survey</option>
                        <option value="custom">Custom</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>Category</label>
                      <select value={category} onChange={e => setCategory(e.target.value)} style={inputStyle}>
                        <option value="residential">Residential</option>
                        <option value="commercial">Commercial</option>
                        <option value="both">Both</option>
                      </select>
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "#1A1917" }}>
                      <input type="checkbox" checked={requiresSign} onChange={e => setRequiresSign(e.target.checked)} />
                      Requires eSignature
                    </label>
                  </div>
                </div>

                {type === "agreement" && (
                  <div>
                    <span style={labelStyle}>Policy Blocks</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {POLICY_BLOCKS.map(block => (
                        <div key={block.key} style={{ border: "1px solid #E5E2DC", borderRadius: 7, overflow: "hidden" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: activeBlocks.has(block.key) ? "#EFF6FF" : "#F7F6F3", cursor: "pointer" }}
                            onClick={() => { if (activeBlocks.has(block.key)) setExpandedBlock(expandedBlock === block.key ? null : block.key); }}>
                            <button onClick={e => { e.stopPropagation(); toggleBlock(block.key); }} style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${activeBlocks.has(block.key) ? "#5B9BD5" : "#D1D5DB"}`, background: activeBlocks.has(block.key) ? "#5B9BD5" : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              {activeBlocks.has(block.key) && <Check size={11} color="#fff" />}
                            </button>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: activeBlocks.has(block.key) ? "#1A1917" : "#9E9B94" }}>{block.label}</div>
                            </div>
                            {activeBlocks.has(block.key) && (
                              expandedBlock === block.key ? <ChevronUp size={13} color="#9E9B94" /> : <ChevronDown size={13} color="#9E9B94" />
                            )}
                          </div>
                          {expandedBlock === block.key && activeBlocks.has(block.key) && (
                            <div style={{ padding: 10, borderTop: "1px solid #E5E2DC" }}>
                              <label style={{ ...labelStyle, marginBottom: 6 }}>Custom text for this section</label>
                              <textarea
                                value={blockText[block.key] || ""}
                                onChange={e => setBlockText(prev => ({ ...prev, [block.key]: e.target.value }))}
                                placeholder="Leave empty to use default policy text..."
                                rows={4}
                                style={{ ...inputStyle, resize: "vertical" }}
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {type !== "agreement" && (
                  <div>
                    <span style={labelStyle}>Agreement / Terms Text</span>
                    <textarea value={termsBody} onChange={e => setTermsBody(e.target.value)} rows={12} style={{ ...inputStyle, resize: "vertical" }} placeholder="Enter form instructions or terms..." />
                  </div>
                )}
              </div>

              <div style={{ flex: 1, overflowY: "auto", padding: 32, background: "#F7F6F3" }}>
                <div style={{ maxWidth: 680, margin: "0 auto", background: "#fff", borderRadius: 12, boxShadow: "0 2px 20px rgba(0,0,0,0.08)", overflow: "hidden" }}>
                  <div style={{ background: "#5B9BD5", padding: "24px 32px" }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{name}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", marginTop: 4 }}>Service Agreement · {CATEGORY_LABELS[category]?.label || category}</div>
                  </div>
                  <div style={{ padding: "28px 32px" }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#5B9BD5", marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Client Information</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
                      {["Full Name", "Service Address", "Phone", "Email", "Service Frequency", "Entry Method"].map(f => (
                        <div key={f} style={{ padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 6 }}>
                          <div style={{ fontSize: 9, color: "#9E9B94", fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>{f}</div>
                          <div style={{ fontSize: 12, color: "#D1D5DB" }}>_____________________</div>
                        </div>
                      ))}
                    </div>
                    {type === "agreement" && (
                      <>
                        <div style={{ fontWeight: 700, fontSize: 13, color: "#5B9BD5", marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Service Terms</div>
                        {POLICY_BLOCKS.filter(b => activeBlocks.has(b.key)).map(block => (
                          <div key={block.key} style={{ marginBottom: 16 }}>
                            <div style={{ fontWeight: 700, fontSize: 11, color: "#1A1917", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{block.label}</div>
                            <div style={{ fontSize: 11, color: "#6B7280", lineHeight: 1.6 }}>{blockText[block.key] || `${block.description} — default policy text applies.`}</div>
                          </div>
                        ))}
                      </>
                    )}
                    <div style={{ borderTop: "2px solid #5B9BD5", marginTop: 24, paddingTop: 20 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: "#5B9BD5", marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Electronic Signature</div>
                      <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 16 }}>By signing below, the client fully understands and agrees to the contents of this agreement.</div>
                      <div style={{ borderBottom: "1px solid #1A1917", padding: "8px 0", marginBottom: 4, fontSize: 13, color: "#D1D5DB" }}>Client typed name here</div>
                      <div style={{ fontSize: 9, color: "#9E9B94", textTransform: "uppercase", letterSpacing: 0.5 }}>Typed Name · Date & Time · IP Address</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: "auto", padding: 32, background: "#F7F6F3", display: "flex", justifyContent: "center" }}>
              <div style={{ width: "100%", maxWidth: 720 }}>
                <div style={{ background: "#fff", borderRadius: 12, boxShadow: "0 2px 20px rgba(0,0,0,0.08)", padding: 40 }}>
                  <div style={{ textAlign: "center", marginBottom: 32 }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#1A1917" }}>{name}</div>
                    <div style={{ fontSize: 13, color: "#6B7280", marginTop: 6 }}>Please review and sign this service agreement</div>
                  </div>
                  <div style={{ fontSize: 13, color: "#1A1917", lineHeight: 1.8, whiteSpace: "pre-line" }}>{termsBody || "Agreement content will appear here based on selected policy blocks."}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SendAgreementModal({ template, onClose }: any) {
  const [clientEmail, setClientEmail] = useState("");
  const [clientName, setClientName] = useState("");
  const [sent, setSent] = useState<{ signing_url: string; sent_to: string } | null>(null);

  const sendMutation = useMutation({
    mutationFn: () => apiFetch(`/api/form-templates/${template.id}/send`, {
      method: "POST",
      body: JSON.stringify({ email: clientEmail, client_name: clientName }),
    }),
    onSuccess: (data) => setSent(data),
  });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div style={{ position: "relative", background: "#fff", borderRadius: 14, padding: 28, width: 460, maxWidth: "90vw", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: "#1A1917" }}>Send Agreement</div>
            <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>{template.name}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}><X size={18} /></button>
        </div>

        {sent ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#D1FAE5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <Check size={28} color="#065F46" />
            </div>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#1A1917", marginBottom: 8 }}>Agreement Sent!</div>
            <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 20 }}>Sent to <strong>{sent.sent_to}</strong></div>
            <div style={{ background: "#F7F6F3", borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#9E9B94", marginBottom: 6 }}>Signing Link</div>
              <div style={{ fontSize: 12, color: "#5B9BD5", wordBreak: "break-all" }}>{window.location.origin}{sent.signing_url?.replace(/^https?:\/\/[^/]+/, "")}</div>
            </div>
            <button onClick={() => navigator.clipboard.writeText(window.location.origin + (sent.signing_url?.replace(/^https?:\/\/[^/]+/, "") || ""))} style={{ background: "#5B9BD5", color: "#fff", border: "none", borderRadius: 8, padding: "8px 20px", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
              Copy Link
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 5 }}>Client Name</label>
                <input value={clientName} onChange={e => setClientName(e.target.value)} placeholder="Full name" style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, boxSizing: "border-box", fontFamily: "'Plus Jakarta Sans', sans-serif" }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 5 }}>Email Address</label>
                <input type="email" value={clientEmail} onChange={e => setClientEmail(e.target.value)} placeholder="client@email.com" style={{ width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, boxSizing: "border-box", fontFamily: "'Plus Jakarta Sans', sans-serif" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={onClose} style={{ flex: 1, padding: "10px", border: "1px solid #E5E2DC", borderRadius: 8, cursor: "pointer", fontSize: 13, background: "none", color: "#6B7280" }}>Cancel</button>
              <button onClick={() => sendMutation.mutate()} disabled={!clientEmail || sendMutation.isPending} style={{ flex: 2, padding: "10px", background: "#5B9BD5", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700, opacity: (!clientEmail || sendMutation.isPending) ? 0.6 : 1 }}>
                {sendMutation.isPending ? "Sending..." : "Send Agreement"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SentAgreementsTab() {
  const { data: submissions = [], isLoading } = useQuery({
    queryKey: ["form-submissions"],
    queryFn: () => apiFetch("/api/form-templates/submissions"),
  });

  const [search, setSearch] = useState("");
  const filtered = (submissions as any[]).filter((s: any) =>
    !search || (s.client_name || s.sent_to || "").toLowerCase().includes(search.toLowerCase())
  );

  const tdStyle: React.CSSProperties = { padding: "12px 14px", fontSize: 13, color: "#1A1917", borderBottom: "1px solid #F5F4F2" };
  const thStyle: React.CSSProperties = { padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#9E9B94", textAlign: "left", textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid #E5E2DC", whiteSpace: "nowrap" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", gap: 8 }}>
        <Search size={15} color="#9E9B94" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by client name or email..." style={{ border: "none", outline: "none", fontSize: 13, flex: 1, fontFamily: "'Plus Jakarta Sans', sans-serif" }} />
      </div>

      <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#F7F6F3" }}>
              <th style={thStyle}>Client</th>
              <th style={thStyle}>Template</th>
              <th style={thStyle}>Sent</th>
              <th style={thStyle}>Sent To</th>
              <th style={thStyle}>Signed</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} style={{ ...tdStyle, textAlign: "center", color: "#9E9B94" }}>Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} style={{ ...tdStyle, textAlign: "center", color: "#9E9B94", padding: 32 }}>
                <FileSignature size={32} color="#D1D5DB" style={{ marginBottom: 8, display: "block", margin: "0 auto 8px" }} />
                No agreements sent yet
              </td></tr>
            ) : filtered.map((s: any) => {
              const cfg = STATUS_CONFIG[s.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.draft;
              const isExpired = s.status === "pending" && s.expires_at && new Date() > new Date(s.expires_at);
              const displayCfg = isExpired ? STATUS_CONFIG.expired : cfg;
              return (
                <tr key={s.id} style={{ backgroundColor: "transparent" }}>
                  <td style={tdStyle}><div style={{ fontWeight: 600 }}>{s.client_name || "—"}</div><div style={{ fontSize: 11, color: "#9E9B94" }}>ID #{s.client_id}</div></td>
                  <td style={tdStyle}>{s.form_name || "—"}</td>
                  <td style={tdStyle}>{s.sent_at ? new Date(s.sent_at).toLocaleDateString() : "—"}</td>
                  <td style={{ ...tdStyle, fontSize: 12, color: "#6B7280" }}>{s.sent_to || "—"}</td>
                  <td style={tdStyle}>{s.signature_at ? new Date(s.signature_at).toLocaleString() : "—"}</td>
                  <td style={tdStyle}>
                    <span style={{ background: displayCfg.bg, color: displayCfg.color, padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700 }}>{isExpired ? "EXPIRED" : displayCfg.label}</span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 6 }}>
                      {s.pdf_url && <a href={s.pdf_url} target="_blank" rel="noreferrer" title="Download PDF" style={{ color: "#5B9BD5", display: "flex" }}><Download size={14} /></a>}
                      {s.status !== "signed" && <a href={`/sign/${s.sign_token}`} target="_blank" rel="noreferrer" title="View signing link" style={{ color: "#6B7280", display: "flex" }}><ExternalLink size={14} /></a>}
                      {s.content_hash && <span title={`SHA-256: ${s.content_hash}`} style={{ color: "#6B7280", display: "flex" }}><Shield size={14} /></span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AgreementBuilderPage() {
  const [tab, setTab] = useState<"templates" | "sent">("templates");
  const [editingTemplate, setEditingTemplate] = useState<any | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState<any | null>(null);
  const qc = useQueryClient();

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["form-templates"],
    queryFn: () => apiFetch("/api/form-templates"),
  });

  useEffect(() => {
    if ((templates as any[]).length === 0 && !isLoading) {
      apiFetch("/api/form-templates/seed-defaults", { method: "POST" })
        .then(() => qc.invalidateQueries({ queryKey: ["form-templates"] }))
        .catch(() => {});
    }
  }, [templates, isLoading]);

  const duplicateMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/form-templates/${id}/duplicate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["form-templates"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/form-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["form-templates"] }),
  });

  const cardStyle: React.CSSProperties = { padding: "14px 20px", borderRadius: 9, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all 0.12s", fontFamily: "'Plus Jakarta Sans', sans-serif" };

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, padding: "0 2px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#1A1917" }}>Service Agreements</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>Build and send legally binding service agreements to clients. No Jotform. No DocuSign.</p>
          </div>
          <button onClick={() => setCreatingNew(true)} style={{ ...cardStyle, background: "#5B9BD5", color: "#fff", display: "flex", alignItems: "center", gap: 6 }}>
            <Plus size={15} /> New Agreement
          </button>
        </div>

        <div style={{ display: "flex", background: "#F7F6F3", borderRadius: 10, padding: 4, gap: 2, width: "fit-content" }}>
          {[{ key: "templates", label: "Agreement Templates" }, { key: "sent", label: "Sent Agreements" }].map(t => (
            <button key={t.key} onClick={() => setTab(t.key as any)} style={{ ...cardStyle, background: tab === t.key ? "#fff" : "transparent", color: tab === t.key ? "#1A1917" : "#9E9B94", padding: "8px 18px", boxShadow: tab === t.key ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === "templates" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: 16 }}>
            {isLoading ? (
              <div style={{ color: "#9E9B94", fontSize: 13 }}>Loading templates...</div>
            ) : (templates as any[]).map((t: any) => (
              <TemplateCard
                key={t.id}
                template={t}
                onEdit={setEditingTemplate}
                onDuplicate={(id: number) => duplicateMutation.mutate(id)}
                onDelete={(id: number) => { if (confirm("Delete this template?")) deleteMutation.mutate(id); }}
                onSend={setSendingTemplate}
              />
            ))}
          </div>
        )}

        {tab === "sent" && <SentAgreementsTab />}
      </div>

      {(editingTemplate || creatingNew) && (
        <TemplateEditor
          template={editingTemplate}
          onClose={() => { setEditingTemplate(null); setCreatingNew(false); }}
          onSave={() => { setEditingTemplate(null); setCreatingNew(false); }}
        />
      )}

      {sendingTemplate && (
        <SendAgreementModal template={sendingTemplate} onClose={() => setSendingTemplate(null)} />
      )}
    </DashboardLayout>
  );
}
