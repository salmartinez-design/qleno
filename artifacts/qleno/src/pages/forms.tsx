import { useState, useRef } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import {
  Plus, Trash2, Edit2, GripVertical, Copy, ExternalLink,
  Text, AlignLeft, List, CheckSquare, Calendar, Phone, Mail,
  Hash, ChevronDown, ChevronUp, X, Check, FileText,
  ToggleLeft, QrCode, Share2,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { headers: { ...getAuthHeaders(), "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const FIELD_TYPES = [
  { type: "text", label: "Short Text", icon: Text, description: "Single line text" },
  { type: "textarea", label: "Long Text", icon: AlignLeft, description: "Multi-line paragraph" },
  { type: "select", label: "Dropdown", icon: List, description: "Choose one option" },
  { type: "radio", label: "Multiple Choice", icon: ToggleLeft, description: "Select one answer" },
  { type: "checkbox", label: "Checkboxes", icon: CheckSquare, description: "Select multiple" },
  { type: "date", label: "Date", icon: Calendar, description: "Date picker" },
  { type: "tel", label: "Phone", icon: Phone, description: "Phone number" },
  { type: "email", label: "Email", icon: Mail, description: "Email address" },
  { type: "number", label: "Number", icon: Hash, description: "Numeric input" },
  { type: "section", label: "Section Header", icon: FileText, description: "Group separator" },
];

const TYPE_LABEL_MAP: Record<string, string> = {
  agreement: "Agreement", intake: "Intake Form", inspection: "Inspection", survey: "Survey", custom: "Custom",
};

const TYPE_COLOR_MAP: Record<string, string> = {
  agreement: "#5B9BD5", intake: "#10B981", inspection: "#F59E0B", survey: "#7F77DD", custom: "#6B7280",
};

function newField(type: string): any {
  return {
    id: `field_${Date.now()}`,
    type,
    label: FIELD_TYPES.find(f => f.type === type)?.label || "Field",
    required: false,
    placeholder: "",
    options: ["select", "radio", "checkbox"].includes(type) ? ["Option 1", "Option 2", "Option 3"] : undefined,
    variable: "",
  };
}

function FieldPalette({ onAdd }: { onAdd: (type: string) => void }) {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 }}>Field Types</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {FIELD_TYPES.map(ft => {
          const Icon = ft.icon;
          return (
            <button key={ft.type} onClick={() => onAdd(ft.type)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 7, background: "#fff", cursor: "pointer", textAlign: "left", transition: "all 0.1s" }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = "#5B9BD5")}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "#E5E2DC")}>
              <div style={{ width: 30, height: 30, borderRadius: 6, background: "#EFF6FF", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon size={14} color="#5B9BD5" />
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1917" }}>{ft.label}</div>
                <div style={{ fontSize: 10, color: "#9E9B94" }}>{ft.description}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FieldEditor({ field, onUpdate, onDelete }: { field: any; onUpdate: (f: any) => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [option, setOption] = useState("");
  const ft = FIELD_TYPES.find(f => f.type === field.type);
  const Icon = ft?.icon || Text;

  const inp = (key: string, value: any, type = "text") => (
    <input
      type={type}
      value={value || ""}
      onChange={e => onUpdate({ ...field, [key]: type === "checkbox" ? e.target.checked : e.target.value })}
      style={{ width: "100%", padding: "6px 8px", border: "1px solid #E5E2DC", borderRadius: 5, fontSize: 12, boxSizing: "border-box", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
    />
  );

  return (
    <div style={{ border: `2px solid ${expanded ? "#5B9BD5" : "#E5E2DC"}`, borderRadius: 8, background: "#fff", transition: "border-color 0.15s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", cursor: "pointer" }} onClick={() => setExpanded(!expanded)}>
        <GripVertical size={14} color="#D1D5DB" style={{ cursor: "grab" }} />
        <div style={{ width: 26, height: 26, borderRadius: 5, background: "#EFF6FF", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon size={12} color="#5B9BD5" />
        </div>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{field.label}</span>
        {field.required && <span style={{ fontSize: 9, color: "#E53E3E", fontWeight: 700 }}>REQ</span>}
        <button onClick={e => { e.stopPropagation(); onDelete(); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#E53E3E", padding: 2 }}><Trash2 size={13} /></button>
        {expanded ? <ChevronUp size={14} color="#9E9B94" /> : <ChevronDown size={14} color="#9E9B94" />}
      </div>

      {expanded && (
        <div style={{ padding: "12px 14px", borderTop: "1px solid #E5E2DC", display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", marginBottom: 4 }}>Label</div>
            {inp("label", field.label)}
          </div>
          {field.type !== "section" && (
            <>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", marginBottom: 4 }}>Placeholder</div>
                {inp("placeholder", field.placeholder)}
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", marginBottom: 4 }}>Variable Name</div>
                {inp("variable", field.variable)}
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#1A1917", cursor: "pointer" }}>
                <input type="checkbox" checked={field.required} onChange={e => onUpdate({ ...field, required: e.target.checked })} />
                Required field
              </label>
            </>
          )}
          {["select", "radio", "checkbox"].includes(field.type) && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", marginBottom: 6 }}>Options</div>
              {(field.options || []).map((opt: string, i: number) => (
                <div key={i} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                  <input value={opt} onChange={e => { const o = [...field.options]; o[i] = e.target.value; onUpdate({ ...field, options: o }); }} style={{ flex: 1, padding: "5px 8px", border: "1px solid #E5E2DC", borderRadius: 5, fontSize: 12, fontFamily: "'Plus Jakarta Sans', sans-serif" }} />
                  <button onClick={() => onUpdate({ ...field, options: field.options.filter((_: any, j: number) => j !== i) })} style={{ background: "none", border: "none", cursor: "pointer", color: "#E53E3E" }}><X size={12} /></button>
                </div>
              ))}
              <div style={{ display: "flex", gap: 4 }}>
                <input value={option} onChange={e => setOption(e.target.value)} placeholder="Add option..." style={{ flex: 1, padding: "5px 8px", border: "1px solid #E5E2DC", borderRadius: 5, fontSize: 12, fontFamily: "'Plus Jakarta Sans', sans-serif" }} onKeyDown={e => { if (e.key === "Enter" && option) { onUpdate({ ...field, options: [...(field.options || []), option] }); setOption(""); } }} />
                <button onClick={() => { if (option) { onUpdate({ ...field, options: [...(field.options || []), option] }); setOption(""); } }} style={{ background: "#5B9BD5", color: "#fff", border: "none", borderRadius: 5, padding: "5px 10px", cursor: "pointer", fontSize: 12 }}>Add</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FieldPreview({ field }: { field: any }) {
  const inpStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, boxSizing: "border-box", fontFamily: "'Plus Jakarta Sans', sans-serif", background: "#F9FAFB" };

  if (field.type === "section") {
    return (
      <div style={{ borderLeft: "3px solid #5B9BD5", paddingLeft: 10, marginTop: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#1A1917" }}>{field.label}</div>
      </div>
    );
  }

  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 5 }}>
        {field.label} {field.required && <span style={{ color: "#E53E3E" }}>*</span>}
      </label>
      {field.type === "textarea" ? <textarea style={{ ...inpStyle, resize: "vertical" }} rows={3} placeholder={field.placeholder} readOnly /> :
        field.type === "select" ? <select style={inpStyle}><option value="">Select...</option>{(field.options || []).map((o: string, i: number) => <option key={i}>{o}</option>)}</select> :
          field.type === "radio" ? <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{(field.options || []).map((o: string, i: number) => <label key={i} style={{ display: "flex", gap: 8, fontSize: 13, color: "#374151", cursor: "pointer" }}><input type="radio" name={field.id} />{o}</label>)}</div> :
            field.type === "checkbox" ? <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{(field.options || []).map((o: string, i: number) => <label key={i} style={{ display: "flex", gap: 8, fontSize: 13, color: "#374151", cursor: "pointer" }}><input type="checkbox" />{o}</label>)}</div> :
              <input type={field.type} style={inpStyle} placeholder={field.placeholder} readOnly />}
    </div>
  );
}

function FormBuilder({ template, onClose, onSave }: any) {
  const [name, setName] = useState(template?.name || "New Form");
  const [type, setType] = useState(template?.type || "intake");
  const [category, setCategory] = useState(template?.category || "both");
  const [fields, setFields] = useState<any[]>(Array.isArray(template?.schema) ? template.schema : []);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [tab, setTab] = useState<"build" | "preview">("build");
  const qc = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async () => {
      const path = template?.id ? `/api/form-templates/${template.id}` : "/api/form-templates";
      const method = template?.id ? "PATCH" : "POST";
      return apiFetch(path, { method, body: JSON.stringify({ name, type, category, schema: fields, requires_sign: false }) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["form-templates"] }); onSave(); },
  });

  const addField = (type: string) => {
    const f = newField(type);
    setFields(prev => [...prev, f]);
    setSelectedField(f.id);
  };

  const updateField = (id: string, updated: any) => setFields(prev => prev.map(f => f.id === id ? updated : f));
  const deleteField = (id: string) => setFields(prev => prev.filter(f => f.id !== id));
  const moveField = (id: string, dir: "up" | "down") => {
    setFields(prev => {
      const i = prev.findIndex(f => f.id === id);
      if (i < 0) return prev;
      const next = [...prev];
      const to = dir === "up" ? i - 1 : i + 1;
      if (to < 0 || to >= next.length) return prev;
      [next[i], next[to]] = [next[to], next[i]];
      return next;
    });
  };

  const tabBtn = (t: "build" | "preview", label: string) => (
    <button onClick={() => setTab(t)} style={{ padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: tab === t ? "#fff" : "transparent", color: tab === t ? "#1A1917" : "#9E9B94", boxShadow: tab === t ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>
      {label}
    </button>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)" }} onClick={onClose} />
      <div style={{ position: "relative", marginLeft: "auto", width: "95vw", maxWidth: 1300, height: "100vh", background: "#F7F6F3", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "-4px 0 30px rgba(0,0,0,0.15)" }}>
        <div style={{ padding: "14px 24px", background: "#fff", borderBottom: "1px solid #E5E2DC", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <FileText size={20} color="#5B9BD5" />
            <input value={name} onChange={e => setName(e.target.value)} style={{ fontSize: 18, fontWeight: 700, border: "none", outline: "none", background: "transparent", fontFamily: "'Plus Jakarta Sans', sans-serif", color: "#1A1917", width: 340 }} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ display: "flex", background: "#F7F6F3", borderRadius: 8, padding: 3 }}>
              {tabBtn("build", "Build")}
              {tabBtn("preview", "Preview")}
            </div>
            <select value={type} onChange={e => setType(e.target.value)} style={{ padding: "6px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 12, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              {Object.entries(TYPE_LABEL_MAP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={category} onChange={e => setCategory(e.target.value)} style={{ padding: "6px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 12, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              <option value="both">Both</option>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
            </select>
            <button onClick={() => saveMutation.mutate()} style={{ background: "#5B9BD5", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Save Form</button>
            <button onClick={onClose} style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 8, padding: "8px 12px", cursor: "pointer", color: "#6B7280" }}><X size={16} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
          {tab === "build" ? (
            <>
              <div style={{ width: 220, minWidth: 220, background: "#fff", borderRight: "1px solid #E5E2DC", overflowY: "auto" }}>
                <FieldPalette onAdd={addField} />
              </div>

              <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
                <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", flexDirection: "column", gap: 8 }}>
                  {fields.length === 0 ? (
                    <div style={{ textAlign: "center", padding: "60px 20px", border: "2px dashed #E5E2DC", borderRadius: 10, color: "#9E9B94" }}>
                      <FileText size={40} color="#D1D5DB" style={{ margin: "0 auto 12px", display: "block" }} />
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Add your first field</div>
                      <div style={{ fontSize: 12 }}>Click a field type from the left panel to add it here</div>
                    </div>
                  ) : fields.map((field, i) => (
                    <div key={field.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingTop: 12 }}>
                        <button onClick={() => moveField(field.id, "up")} disabled={i === 0} style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 4, padding: 3, cursor: "pointer", opacity: i === 0 ? 0.3 : 1 }}><ChevronUp size={11} /></button>
                        <button onClick={() => moveField(field.id, "down")} disabled={i === fields.length - 1} style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 4, padding: 3, cursor: "pointer", opacity: i === fields.length - 1 ? 0.3 : 1 }}><ChevronDown size={11} /></button>
                      </div>
                      <div style={{ flex: 1 }}>
                        <FieldEditor field={field} onUpdate={updated => updateField(field.id, updated)} onDelete={() => deleteField(field.id)} />
                      </div>
                    </div>
                  ))}
                  {fields.length > 0 && (
                    <button onClick={() => addField("text")} style={{ padding: "10px", border: "2px dashed #E5E2DC", borderRadius: 8, background: "transparent", color: "#9E9B94", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      <Plus size={14} /> Add Field
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div style={{ flex: 1, overflowY: "auto", padding: 32, background: "#F7F6F3", display: "flex", justifyContent: "center" }}>
              <div style={{ width: "100%", maxWidth: 600 }}>
                <div style={{ background: "#fff", borderRadius: 12, boxShadow: "0 2px 20px rgba(0,0,0,0.08)", overflow: "hidden" }}>
                  <div style={{ background: "#5B9BD5", padding: "24px 28px" }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{name}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", marginTop: 4 }}>{TYPE_LABEL_MAP[type]} · {category}</div>
                  </div>
                  <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 18 }}>
                    {fields.length === 0 ? (
                      <div style={{ textAlign: "center", color: "#9E9B94", padding: 20 }}>No fields added yet</div>
                    ) : fields.map(f => <FieldPreview key={f.id} field={f} />)}
                    {fields.length > 0 && (
                      <button style={{ background: "#5B9BD5", color: "#fff", border: "none", borderRadius: 8, padding: "12px", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                        Submit
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmbedModal({ template, onClose }: any) {
  const [copied, setCopied] = useState<string | null>(null);
  const formUrl = `${window.location.origin}/form/${template.id}`;
  const embedCode = `<iframe src="${formUrl}" width="100%" height="700" frameborder="0" style="border:none;border-radius:12px;"></iframe>`;

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div style={{ position: "relative", background: "#fff", borderRadius: 14, padding: 28, width: 520, maxWidth: "90vw", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: "#1A1917" }}>Share & Embed</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}><X size={18} /></button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 6 }}>Form Link</div>
            <div style={{ display: "flex", gap: 6 }}>
              <div style={{ flex: 1, padding: "8px 10px", background: "#F7F6F3", borderRadius: 7, fontSize: 12, color: "#1A1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{formUrl}</div>
              <button onClick={() => copy(formUrl, "link")} style={{ padding: "8px 14px", background: copied === "link" ? "#10B981" : "#5B9BD5", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>
                {copied === "link" ? <><Check size={12} /> Copied!</> : "Copy"}
              </button>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 6 }}>QR Code</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div style={{ width: 100, height: 100, background: "#F7F6F3", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #E5E2DC" }}>
                <div style={{ textAlign: "center" }}>
                  <QrCode size={40} color="#5B9BD5" />
                  <div style={{ fontSize: 9, color: "#9E9B94", marginTop: 4 }}>Scan to fill</div>
                </div>
              </div>
              <div style={{ flex: 1, fontSize: 12, color: "#6B7280", lineHeight: 1.6 }}>
                Print or display this QR code for clients to scan and fill out the form on their phone — no login required.
              </div>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 6 }}>Embed Code</div>
            <div style={{ position: "relative" }}>
              <textarea readOnly value={embedCode} rows={4} style={{ width: "100%", padding: "10px", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 11, fontFamily: "monospace", resize: "none", boxSizing: "border-box" }} />
              <button onClick={() => copy(embedCode, "embed")} style={{ position: "absolute", top: 8, right: 8, padding: "4px 10px", background: copied === "embed" ? "#10B981" : "#5B9BD5", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", gap: 3 }}>
                {copied === "embed" ? <><Check size={10} /> Copied!</> : "Copy"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FormsPage() {
  const [tab, setTab] = useState<"forms" | "submissions">("forms");
  const [typeFilter, setTypeFilter] = useState("all");
  const [buildingTemplate, setBuildingTemplate] = useState<any | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [embedTemplate, setEmbedTemplate] = useState<any | null>(null);
  const qc = useQueryClient();

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["form-templates"],
    queryFn: () => apiFetch("/api/form-templates"),
  });

  const { data: submissions = [] } = useQuery({
    queryKey: ["form-submissions"],
    queryFn: () => apiFetch("/api/form-templates/submissions"),
    enabled: tab === "submissions",
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/form-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["form-templates"] }),
  });

  const filteredTemplates = (templates as any[]).filter(t =>
    typeFilter === "all" || t.type === typeFilter
  );

  const thStyle: React.CSSProperties = { padding: "10px 14px", fontSize: 11, fontWeight: 600, color: "#9E9B94", textAlign: "left", textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid #E5E2DC" };
  const tdStyle: React.CSSProperties = { padding: "12px 14px", fontSize: 13, color: "#1A1917", borderBottom: "1px solid #F5F4F2" };

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#1A1917" }}>Form Builder</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>Create intake forms, inspection checklists, surveys, and custom forms for your clients and team.</p>
          </div>
          <button onClick={() => setCreatingNew(true)} style={{ background: "#5B9BD5", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", cursor: "pointer", fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
            <Plus size={15} /> New Form
          </button>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ display: "flex", background: "#F7F6F3", borderRadius: 10, padding: 4 }}>
            {[{ k: "forms", l: "My Forms" }, { k: "submissions", l: "Submissions" }].map(t => (
              <button key={t.k} onClick={() => setTab(t.k as any)} style={{ padding: "7px 16px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: tab === t.k ? "#fff" : "transparent", color: tab === t.k ? "#1A1917" : "#9E9B94", boxShadow: tab === t.k ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>
                {t.l}
              </button>
            ))}
          </div>
          {tab === "forms" && (
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ padding: "7px 10px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 12, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              <option value="all">All Types</option>
              {Object.entries(TYPE_LABEL_MAP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          )}
        </div>

        {tab === "forms" && (
          <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#F7F6F3" }}>
                  <th style={thStyle}>Form Name</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Category</th>
                  <th style={thStyle}>Fields</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={6} style={{ ...tdStyle, textAlign: "center", color: "#9E9B94" }}>Loading...</td></tr>
                ) : filteredTemplates.length === 0 ? (
                  <tr><td colSpan={6} style={{ ...tdStyle, textAlign: "center", color: "#9E9B94", padding: 40 }}>
                    <FileText size={36} color="#D1D5DB" style={{ margin: "0 auto 10px", display: "block" }} />
                    No forms yet. Create your first form to get started.
                  </td></tr>
                ) : filteredTemplates.map((t: any) => {
                  const color = TYPE_COLOR_MAP[t.type] || "#6B7280";
                  const fieldCount = Array.isArray(t.schema) ? t.schema.length : 0;
                  return (
                    <tr key={t.id}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600 }}>{t.name}</div>
                        {t.is_default && <span style={{ fontSize: 9, fontWeight: 700, background: "#FEF3C7", color: "#92400E", padding: "1px 5px", borderRadius: 3, marginTop: 2, display: "inline-block" }}>DEFAULT</span>}
                      </td>
                      <td style={tdStyle}><span style={{ background: `${color}18`, color, padding: "3px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600 }}>{TYPE_LABEL_MAP[t.type]}</span></td>
                      <td style={{ ...tdStyle, textTransform: "capitalize" }}>{t.category}</td>
                      <td style={tdStyle}>{fieldCount} {fieldCount === 1 ? "field" : "fields"}</td>
                      <td style={tdStyle}><span style={{ background: t.is_active ? "#D1FAE5" : "#F3F4F6", color: t.is_active ? "#065F46" : "#6B7280", padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700 }}>{t.is_active ? "ACTIVE" : "INACTIVE"}</span></td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => setBuildingTemplate(t)} title="Edit" style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 6, padding: "5px 8px", cursor: "pointer", color: "#6B7280" }}><Edit2 size={13} /></button>
                          <button onClick={() => setEmbedTemplate(t)} title="Share/Embed" style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 6, padding: "5px 8px", cursor: "pointer", color: "#6B7280" }}><Share2 size={13} /></button>
                          <a href={`/form/${t.id}`} target="_blank" rel="noreferrer" title="Preview" style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 6, padding: "5px 8px", cursor: "pointer", color: "#6B7280", display: "flex", alignItems: "center" }}><ExternalLink size={13} /></a>
                          <button onClick={() => { if (confirm("Delete this form?")) deleteMutation.mutate(t.id); }} title="Delete" style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 6, padding: "5px 8px", cursor: "pointer", color: "#E53E3E" }}><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === "submissions" && (
          <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#F7F6F3" }}>
                  <th style={thStyle}>Form</th>
                  <th style={thStyle}>Client</th>
                  <th style={thStyle}>Submitted</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Signed By</th>
                </tr>
              </thead>
              <tbody>
                {(submissions as any[]).length === 0 ? (
                  <tr><td colSpan={5} style={{ ...tdStyle, textAlign: "center", color: "#9E9B94", padding: 40 }}>No submissions yet</td></tr>
                ) : (submissions as any[]).map((s: any) => (
                  <tr key={s.id}>
                    <td style={tdStyle}>{s.form_name || `Form #${s.form_id}`}</td>
                    <td style={tdStyle}>{s.client_name || s.sent_to || "—"}</td>
                    <td style={tdStyle}>{s.submitted_at ? new Date(s.submitted_at).toLocaleString() : "—"}</td>
                    <td style={tdStyle}><span style={{ background: s.status === "signed" ? "#D1FAE5" : "#FEF3C7", color: s.status === "signed" ? "#065F46" : "#92400E", padding: "3px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700 }}>{(s.status || "").toUpperCase()}</span></td>
                    <td style={tdStyle}>{s.signature_name || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(buildingTemplate || creatingNew) && (
        <FormBuilder
          template={buildingTemplate}
          onClose={() => { setBuildingTemplate(null); setCreatingNew(false); }}
          onSave={() => { setBuildingTemplate(null); setCreatingNew(false); }}
        />
      )}

      {embedTemplate && <EmbedModal template={embedTemplate} onClose={() => setEmbedTemplate(null)} />}
    </DashboardLayout>
  );
}
