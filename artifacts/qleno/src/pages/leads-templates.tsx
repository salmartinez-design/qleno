import { useState, useEffect, useCallback } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { Plus, X, Loader2, MessageSquare, Mail, ChevronLeft, Copy, Trash2, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { MessagePreview } from "@/components/message-preview";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Template {
  id: number;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  category: string | null;
  is_default: boolean;
  active: boolean;
  updated_at: string;
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#6B6860", marginBottom: 5 };
const selectStyle: React.CSSProperties = { width: "100%", border: "1px solid #E5E2DC", borderRadius: 6,
  padding: "8px 12px", fontSize: 14, fontFamily: "inherit", background: "#fff", outline: "none", cursor: "pointer" };
const taStyle: React.CSSProperties = { width: "100%", border: "1px solid #E5E2DC", borderRadius: 6, padding: "8px 12px",
  fontSize: 14, fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box" };

function TemplateDrawer({ template, onClose, onSaved }:
  { template: Template | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: template?.name || "",
    channel: template?.channel || "email",
    subject: template?.subject || "",
    body: template?.body || "",
    category: template?.category || "",
    active: template?.active ?? true,
  });
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

  async function handleSave() {
    if (!form.name.trim() || !form.body.trim()) {
      toast({ title: "Name and body are required", variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      const url = template ? `${API}/api/templates/${template.id}` : `${API}/api/templates`;
      const r = await fetch(url, {
        method: template ? "PATCH" : "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error();
      toast({ title: template ? "Template updated" : "Template created" });
      onSaved(); onClose();
    } catch {
      toast({ title: "Failed to save template", variant: "destructive" });
    } finally { setSaving(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex" }}>
      <div style={{ flex: 1, background: "rgba(0,0,0,0.3)" }} onClick={onClose} />
      <div style={{ width: 560, background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
        display: "flex", flexDirection: "column", height: "100vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "20px 24px", borderBottom: "1px solid #E5E2DC" }}>
          <span style={{ fontWeight: 700, fontSize: 17, color: "#1A1917" }}>
            {template ? "Edit Template" : "New Template"}
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
            <X size={18} color="#6B6860" />
          </button>
        </div>
        <div style={{ padding: 24, flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 12 }}>
            <div>
              <label style={lbl}>Name *</label>
              <Input value={form.name} onChange={e => set("name", e.target.value)} placeholder="Quote follow-up #1" />
            </div>
            <div>
              <label style={lbl}>Channel</label>
              <select value={form.channel} onChange={e => set("channel", e.target.value)} style={selectStyle}>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
              </select>
            </div>
          </div>
          {form.channel === "email" && (
            <div>
              <label style={lbl}>Subject</label>
              <Input value={form.subject} onChange={e => set("subject", e.target.value)} placeholder="Your cleaning quote from Phes" />
            </div>
          )}
          <div>
            <label style={lbl}>Body *</label>
            <textarea value={form.body} onChange={e => set("body", e.target.value)}
              placeholder={"Hi {{first_name}}, just following up on your quote…"}
              style={{ ...taStyle, minHeight: form.channel === "sms" ? 120 : 200 }} />
            <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 6, marginBottom: 10 }}>
              Merge fields use <code style={{ background: "#F2F1ED", padding: "1px 5px", borderRadius: 4 }}>{"{{first_name}}"}</code>,
              {" "}<code style={{ background: "#F2F1ED", padding: "1px 5px", borderRadius: 4 }}>{"{{quote_amount}}"}</code>, etc.
            </div>
            <MessagePreview channel={form.channel === "sms" ? "sms" : "email"} subject={form.channel === "email" ? form.subject : undefined} body={form.body} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
            <div>
              <label style={lbl}>Category</label>
              <Input value={form.category} onChange={e => set("category", e.target.value)} placeholder="quote_followup" />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151",
              cursor: "pointer", paddingBottom: 8 }}>
              <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
              Active
            </label>
          </div>
        </div>
        <div style={{ padding: 24, display: "flex", gap: 8, borderTop: "1px solid #E5E2DC" }}>
          <Button onClick={handleSave} disabled={saving} style={{ flex: 1, background: "#1A1917", color: "#fff" }}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : "Save Template"}
          </Button>
          <Button variant="outline" onClick={onClose} style={{ flex: 1 }}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

export default function LeadsTemplatesPage() {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [editing, setEditing] = useState<Template | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/templates${channelFilter ? `?channel=${channelFilter}` : ""}`,
        { headers: getAuthHeaders() });
      if (r.ok) setTemplates(await r.json());
    } catch { toast({ title: "Failed to load templates", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [channelFilter, toast]);

  useEffect(() => { load(); }, [load]);

  async function clone(t: Template) {
    try {
      const r = await fetch(`${API}/api/templates/${t.id}/clone`, { method: "POST", headers: getAuthHeaders() });
      if (!r.ok) throw new Error();
      toast({ title: "Template cloned" }); load();
    } catch { toast({ title: "Failed to clone", variant: "destructive" }); }
  }

  async function remove(t: Template) {
    if (!confirm(`Delete template "${t.name}"? This cannot be undone.`)) return;
    try {
      const r = await fetch(`${API}/api/templates/${t.id}`, { method: "DELETE", headers: getAuthHeaders() });
      if (!r.ok) throw new Error();
      toast({ title: "Template deleted" }); load();
    } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
  }

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 0 40px" }}>
        <Link href="/leads" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "#6B6860",
          textDecoration: "none", marginBottom: 12 }}>
          <ChevronLeft size={14} /> Back to Pipeline
        </Link>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: 0,
              display: "flex", alignItems: "center", gap: 8 }}>
              <MessageSquare size={22} /> Message Templates
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 14, color: "#6B6860" }}>
              Email and SMS templates used by quotes and the follow-up cadence.
            </p>
          </div>
          <Button onClick={() => setShowAdd(true)}
            style={{ background: "#1A1917", color: "#fff", gap: 6, display: "flex", alignItems: "center" }}>
            <Plus size={15} /> New Template
          </Button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {[["", "All"], ["email", "Email"], ["sms", "SMS"]].map(([k, l]) => (
            <button key={k} onClick={() => setChannelFilter(k)}
              style={{ padding: "6px 14px", borderRadius: 999, fontSize: 13, fontWeight: channelFilter === k ? 700 : 500,
                cursor: "pointer", fontFamily: "inherit",
                background: channelFilter === k ? "#1A1917" : "#F7F6F3",
                color: channelFilter === k ? "#fff" : "#374151",
                border: `1px solid ${channelFilter === k ? "#1A1917" : "#E5E2DC"}` }}>
              {l}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 80 }}>
            <Loader2 size={24} className="animate-spin" color="#6B6860" style={{ margin: "0 auto" }} />
          </div>
        ) : templates.length === 0 ? (
          <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10, padding: "60px 0",
            textAlign: "center" }}>
            <MessageSquare size={36} color="#D1D5DB" style={{ margin: "0 auto 12px" }} />
            <div style={{ color: "#6B6860", fontSize: 14 }}>No templates yet — create one or import your set.</div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 14 }}>
            {templates.map(t => (
              <div key={t.id} style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 10,
                padding: 16, display: "flex", flexDirection: "column", opacity: t.active ? 1 : 0.6 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    {t.channel === "sms"
                      ? <MessageSquare size={15} color="#059669" />
                      : <Mail size={15} color="#0369A1" />}
                    <span style={{ fontWeight: 600, fontSize: 14, color: "#1A1917" }}>{t.name}</span>
                  </div>
                  {!t.active && <span style={{ fontSize: 11, color: "#9CA3AF" }}>Inactive</span>}
                </div>
                {t.subject && (
                  <div style={{ fontSize: 12, color: "#6B6860", marginTop: 6, fontWeight: 500 }}>{t.subject}</div>
                )}
                <div style={{ fontSize: 13, color: "#374151", marginTop: 8, whiteSpace: "pre-wrap",
                  display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden",
                  flex: 1 }}>
                  {t.body}
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                  marginTop: 12, paddingTop: 10, borderTop: "1px solid #F3F4F6" }}>
                  <span style={{ fontSize: 11, color: "#9CA3AF" }}>
                    {t.category || "uncategorized"}
                  </span>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button onClick={() => setEditing(t)} title="Edit"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#6B6860", padding: 0 }}>
                      <Pencil size={15} />
                    </button>
                    <button onClick={() => clone(t)} title="Clone"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#6B6860", padding: 0 }}>
                      <Copy size={15} />
                    </button>
                    <button onClick={() => remove(t)} title="Delete"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#DC2626", padding: 0 }}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {(showAdd || editing) && (
        <TemplateDrawer template={editing} onClose={() => { setShowAdd(false); setEditing(null); }} onSaved={load} />
      )}
    </DashboardLayout>
  );
}
