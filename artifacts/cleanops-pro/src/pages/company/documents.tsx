import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import {
  Plus, Edit2, Eye, X, Save, ChevronLeft, Bold, Italic, Underline,
  List, ListOrdered, Minus, AlignLeft, FileText, AlertTriangle,
  ToggleLeft, ToggleRight, CheckSquare, Square,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const CATEGORY_LABELS: Record<string, string> = {
  employee_onboarding: "Employee Onboarding",
  employee_operational: "Employee Operational",
  client_residential: "Client — Residential",
  client_commercial: "Client — Commercial",
};

const VARIABLES = [
  { key: "{{employee_name}}", desc: "Employee name" },
  { key: "{{employee_email}}", desc: "Employee email" },
  { key: "{{company_name}}", desc: "Company name" },
  { key: "{{date}}", desc: "Today's date" },
  { key: "{{client_name}}", desc: "Client name" },
  { key: "{{client_address}}", desc: "Client address" },
  { key: "{{service_frequency}}", desc: "Service frequency" },
  { key: "{{service_rate}}", desc: "Service rate" },
];

const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#9E9B94",
  textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5,
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC",
  borderRadius: 8, fontSize: 13, fontFamily: "'Plus Jakarta Sans', sans-serif",
  boxSizing: "border-box", background: "#fff", color: "#1A1917",
};
const btnPrimary: React.CSSProperties = {
  padding: "9px 18px", background: "var(--brand, #00C9A0)", color: "#fff",
  border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13,
  fontFamily: "'Plus Jakarta Sans', sans-serif", cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  padding: "9px 18px", background: "#F7F6F3", color: "#1A1917",
  border: "1px solid #E5E2DC", borderRadius: 8, fontWeight: 600, fontSize: 13,
  fontFamily: "'Plus Jakarta Sans', sans-serif", cursor: "pointer",
};

type Template = {
  id: number; name: string; category: string; content: string;
  is_required: boolean; is_active: boolean; requires_signature: boolean;
  created_at: string; updated_at: string;
};

type EditorMode = "list" | "editor" | "preview";

function RichTextEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInternalChange = useRef(false);

  useEffect(() => {
    if (ref.current && !isInternalChange.current && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value;
    }
    isInternalChange.current = false;
  }, [value]);

  const exec = useCallback((cmd: string, val?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, val);
    ref.current?.focus();
    if (ref.current) {
      isInternalChange.current = true;
      onChange(ref.current.innerHTML);
    }
  }, [onChange]);

  const onInput = useCallback(() => {
    if (ref.current) {
      isInternalChange.current = true;
      onChange(ref.current.innerHTML);
    }
  }, [onChange]);

  const insertVariable = (key: string) => {
    ref.current?.focus();
    document.execCommand("insertText", false, key);
    if (ref.current) {
      isInternalChange.current = true;
      onChange(ref.current.innerHTML);
    }
  };

  const toolBtn = (onClick: () => void, icon: React.ReactNode, title: string) => (
    <button
      key={title}
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      title={title}
      style={{
        width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
        background: "none", border: "1px solid #E5E2DC", borderRadius: 5,
        cursor: "pointer", color: "#6B7280",
      }}
    >{icon}</button>
  );

  return (
    <div style={{ border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 10px",
        borderBottom: "1px solid #E5E2DC", background: "#F7F6F3",
      }}>
        {toolBtn(() => exec("bold"), <Bold size={13}/>, "Bold")}
        {toolBtn(() => exec("italic"), <Italic size={13}/>, "Italic")}
        {toolBtn(() => exec("underline"), <Underline size={13}/>, "Underline")}
        <div style={{ width: 1, background: "#E5E2DC", margin: "2px 2px" }}/>
        {toolBtn(() => exec("formatBlock", "<h2>"), <span style={{ fontSize: 11, fontWeight: 700 }}>H2</span>, "Heading 2")}
        {toolBtn(() => exec("formatBlock", "<h3>"), <span style={{ fontSize: 11, fontWeight: 700 }}>H3</span>, "Heading 3")}
        {toolBtn(() => exec("formatBlock", "<p>"), <AlignLeft size={13}/>, "Paragraph")}
        <div style={{ width: 1, background: "#E5E2DC", margin: "2px 2px" }}/>
        {toolBtn(() => exec("insertUnorderedList"), <List size={13}/>, "Bullet list")}
        {toolBtn(() => exec("insertOrderedList"), <ListOrdered size={13}/>, "Numbered list")}
        {toolBtn(() => exec("insertHorizontalRule"), <Minus size={13}/>, "Divider")}
        <div style={{ width: 1, background: "#E5E2DC", margin: "2px 2px" }}/>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 600 }}>Insert:</span>
          {VARIABLES.map(v => (
            <button
              key={v.key}
              onMouseDown={e => { e.preventDefault(); insertVariable(v.key); }}
              title={v.desc}
              style={{
                padding: "2px 7px", fontSize: 10, fontWeight: 600, color: "var(--brand, #00C9A0)",
                background: "var(--brand-dim, #E8FDF8)", border: "1px solid var(--brand, #00C9A0)",
                borderRadius: 4, cursor: "pointer", fontFamily: "inherit",
              }}
            >{v.key.replace(/[{}]/g, "")}</button>
          ))}
        </div>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={onInput}
        style={{
          minHeight: 320, padding: 16, outline: "none",
          fontSize: 14, lineHeight: 1.6, color: "#1A1917",
          fontFamily: "'Plus Jakarta Sans', sans-serif",
        }}
      />
    </div>
  );
}

function TemplateEditor({
  template,
  onSave,
  onBack,
}: {
  template: Partial<Template> | null;
  onSave: (data: any, publish?: boolean) => Promise<void>;
  onBack: () => void;
}) {
  const [name, setName] = useState(template?.name || "");
  const [category, setCategory] = useState(template?.category || "employee_onboarding");
  const [content, setContent] = useState(template?.content || "");
  const [isRequired, setIsRequired] = useState(template?.is_required || false);
  const [requiresSignature, setRequiresSignature] = useState(template?.requires_signature || false);
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  const isEmployee = category === "employee_onboarding" || category === "employee_operational";

  const handleSave = async (publish = false) => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        category,
        content,
        is_required: isRequired,
        is_active: publish ? true : (template?.is_active ?? false),
        requires_signature: requiresSignature,
      }, publish);
    } finally {
      setSaving(false);
    }
  };

  if (previewMode) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setPreviewMode(false)} style={{ ...btnSecondary, display: "flex", alignItems: "center", gap: 6 }}>
            <ChevronLeft size={14}/> Back to Editor
          </button>
          <span style={{ fontSize: 13, color: "#9E9B94" }}>Preview — as signer will see it</span>
        </div>
        <div style={{
          background: "#fff", border: "1px solid #E5E2DC", borderRadius: 12,
          padding: "40px 48px", maxWidth: 720, margin: "0 auto", width: "100%",
        }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "#1A1917", marginBottom: 24 }}>{name || "Untitled Document"}</h1>
          <div
            style={{ fontSize: 14, lineHeight: 1.7, color: "#374151" }}
            dangerouslySetInnerHTML={{ __html: content || "<p>No content yet.</p>" }}
          />
          {requiresSignature && (
            <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid #E5E2DC" }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: "#1A1917", marginBottom: 12 }}>Signature</p>
              <div style={{ border: "1px dashed #E5E2DC", borderRadius: 8, height: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 13, color: "#9E9B94" }}>Signature pad will appear here</span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ ...btnSecondary, display: "flex", alignItems: "center", gap: 6 }}>
          <ChevronLeft size={14}/> Back
        </button>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1A1917", margin: 0 }}>
          {template?.id ? "Edit Template" : "New Template"}
        </h2>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <label style={label}>Document Name</label>
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="e.g. Employee Handbook"/>
        </div>
        <div>
          <label style={label}>Category</label>
          <select value={category} onChange={e => setCategory(e.target.value)} style={inputStyle}>
            <option value="employee_onboarding">Employee Onboarding</option>
            <option value="employee_operational">Employee Operational</option>
            <option value="client_residential">Client — Residential</option>
            <option value="client_commercial">Client — Commercial</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", gap: 24 }}>
        {isEmployee && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button onClick={() => setIsRequired(p => !p)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex" }}>
              {isRequired ? <ToggleRight size={22} color="var(--brand, #00C9A0)"/> : <ToggleLeft size={22} color="#9E9B94"/>}
            </button>
            <span style={{ fontSize: 13, fontWeight: 500, color: "#1A1917" }}>Required for onboarding</span>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setRequiresSignature(p => !p)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex" }}>
            {requiresSignature ? <ToggleRight size={22} color="var(--brand, #00C9A0)"/> : <ToggleLeft size={22} color="#9E9B94"/>}
          </button>
          <span style={{ fontSize: 13, fontWeight: 500, color: "#1A1917" }}>Requires signature</span>
        </div>
      </div>

      <div>
        <label style={label}>Document Content</label>
        <RichTextEditor value={content} onChange={setContent}/>
      </div>

      <div style={{ background: "#FEF9EC", border: "1px solid #FDE68A", borderRadius: 8, padding: "12px 16px", display: "flex", gap: 10, alignItems: "flex-start" }}>
        <AlertTriangle size={14} style={{ color: "#D97706", flexShrink: 0, marginTop: 2 }}/>
        <p style={{ fontSize: 12, color: "#92400E", margin: 0, lineHeight: 1.5 }}>
          Qleno provides document delivery and signature collection tools only. Document content is your responsibility. Qleno does not provide legal advice and does not verify that your documents comply with applicable law. Consult qualified legal counsel before distributing employment or client agreements.
        </p>
      </div>

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={() => setPreviewMode(true)} style={{ ...btnSecondary, display: "flex", alignItems: "center", gap: 6 }}>
          <Eye size={14}/> Preview
        </button>
        <button onClick={() => handleSave(false)} disabled={saving || !name.trim()} style={btnSecondary}>
          {saving ? "Saving..." : "Save Draft"}
        </button>
        <button onClick={() => handleSave(true)} disabled={saving || !name.trim()} style={btnPrimary}>
          {saving ? "Publishing..." : "Publish"}
        </button>
      </div>
    </div>
  );
}

export function DocumentsTab() {
  const qc = useQueryClient();
  const { data: templates = [], isLoading } = useQuery<Template[]>({
    queryKey: ["document-templates"],
    queryFn: () => apiFetch("/api/document-templates"),
  });

  const [mode, setMode] = useState<EditorMode>("list");
  const [editing, setEditing] = useState<Partial<Template> | null>(null);

  const createMutation = useMutation({
    mutationFn: (data: any) => apiFetch("/api/document-templates", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["document-templates"] }); setMode("list"); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => apiFetch(`/api/document-templates/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["document-templates"] }); setMode("list"); },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/document-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["document-templates"] }),
  });

  const handleSave = async (data: any) => {
    if (editing?.id) {
      await updateMutation.mutateAsync({ id: editing.id, data });
    } else {
      await createMutation.mutateAsync(data);
    }
  };

  if (mode === "editor") {
    return (
      <TemplateEditor
        template={editing}
        onSave={handleSave}
        onBack={() => { setMode("list"); setEditing(null); }}
      />
    );
  }

  const employeeTemplates = templates.filter(t => ["employee_onboarding", "employee_operational"].includes(t.category));
  const clientTemplates = templates.filter(t => ["client_residential", "client_commercial"].includes(t.category));

  const Section = ({
    title, templates: list, showRequired,
  }: { title: string; templates: Template[]; showRequired?: boolean }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1A1917", margin: 0 }}>{title}</h3>
        <button
          onClick={() => {
            setEditing({
              category: title.includes("Employee") ? "employee_onboarding" : "client_residential",
            });
            setMode("editor");
          }}
          style={{ ...btnPrimary, padding: "6px 14px", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
        >
          <Plus size={13}/> New Template
        </button>
      </div>
      {list.length === 0 ? (
        <div style={{ border: "1px dashed #E5E2DC", borderRadius: 10, padding: 32, textAlign: "center" }}>
          <FileText size={24} style={{ color: "#E5E2DC", marginBottom: 8 }}/>
          <p style={{ fontSize: 13, color: "#9E9B94", margin: 0 }}>No templates yet. Create your first one.</p>
        </div>
      ) : (
        <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#F7F6F3" }}>
                <th style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em" }}>Name</th>
                {showRequired && <th style={{ textAlign: "center", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em" }}>Required</th>}
                <th style={{ textAlign: "center", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em" }}>Signature</th>
                {!showRequired && <th style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em" }}>Category</th>}
                <th style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em" }}>Last Updated</th>
                <th style={{ textAlign: "center", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em" }}>Status</th>
                <th style={{ textAlign: "right", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t, i) => (
                <tr key={t.id} style={{ borderTop: i > 0 ? "1px solid #F3F4F6" : "none" }}>
                  <td style={{ padding: "12px 14px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{t.name}</td>
                  {showRequired && (
                    <td style={{ padding: "12px 14px", textAlign: "center" }}>
                      <button
                        onClick={() => updateMutation.mutate({ id: t.id, data: { is_required: !t.is_required } })}
                        style={{ background: "none", border: "none", cursor: "pointer", display: "flex", justifyContent: "center", width: "100%" }}
                      >
                        {t.is_required ? <CheckSquare size={16} color="var(--brand, #00C9A0)"/> : <Square size={16} color="#D1D5DB"/>}
                      </button>
                    </td>
                  )}
                  <td style={{ padding: "12px 14px", textAlign: "center" }}>
                    <button
                      onClick={() => updateMutation.mutate({ id: t.id, data: { requires_signature: !t.requires_signature } })}
                      style={{ background: "none", border: "none", cursor: "pointer", display: "flex", justifyContent: "center", width: "100%" }}
                    >
                      {t.requires_signature ? <CheckSquare size={16} color="var(--brand, #00C9A0)"/> : <Square size={16} color="#D1D5DB"/>}
                    </button>
                  </td>
                  {!showRequired && (
                    <td style={{ padding: "12px 14px", fontSize: 12, color: "#6B7280" }}>{CATEGORY_LABELS[t.category] || t.category}</td>
                  )}
                  <td style={{ padding: "12px 14px", fontSize: 12, color: "#6B7280" }}>{new Date(t.updated_at).toLocaleDateString("en-US")}</td>
                  <td style={{ padding: "12px 14px", textAlign: "center" }}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10,
                      background: t.is_active ? "#DCFCE7" : "#F3F4F6",
                      color: t.is_active ? "#166534" : "#6B7280",
                    }}>
                      {t.is_active ? "Active" : "Draft"}
                    </span>
                  </td>
                  <td style={{ padding: "12px 14px", textAlign: "right" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button
                        onClick={() => { setEditing(t); setMode("editor"); }}
                        style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}
                      >
                        <Edit2 size={11}/> Edit
                      </button>
                      {t.is_active && (
                        <button
                          onClick={() => { if (confirm("Deactivate this template?")) deactivateMutation.mutate(t.id); }}
                          style={{ padding: "4px 10px", fontSize: 12, background: "#FEE2E2", color: "#DC2626", border: "1px solid #FECACA", borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}
                        >
                          Deactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", margin: "0 0 4px" }}>Document Templates</h2>
        <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>
          Manage reusable documents for employee onboarding and client agreements. All content is your responsibility.
        </p>
      </div>
      {isLoading ? (
        <p style={{ fontSize: 13, color: "#9E9B94" }}>Loading...</p>
      ) : (
        <>
          <Section title="Employee Documents" templates={employeeTemplates} showRequired/>
          <Section title="Client Documents" templates={clientTemplates}/>
        </>
      )}
    </div>
  );
}
