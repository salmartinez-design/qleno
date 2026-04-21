import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Plus, Edit2, Trash2, Globe, EyeOff } from "lucide-react";

const PURPLE = "#7F77DD";
const PURPLE_RGB = "127, 119, 221";

interface Article {
  id: number;
  slug: string;
  title_en: string;
  title_es: string | null;
  content_en: string;
  content_es: string | null;
  category: string | null;
  published: boolean;
  created_at: string;
  updated_at: string;
}

const CATEGORIES = ["General", "Safety", "Equipment", "Chemicals", "Procedures", "Training", "Compliance", "Tips"];

const inp: React.CSSProperties = {
  width: "100%", backgroundColor: "#F7F6F3", border: "1px solid #DEDAD4",
  borderRadius: "8px", color: "#1A1917", fontSize: "13px", padding: "10px 12px",
  fontFamily: "'Plus Jakarta Sans', sans-serif",
};

interface ArticleEditorProps {
  article?: Article | null;
  onClose: () => void;
  onSaved: () => void;
}

function ArticleEditor({ article, onClose, onSaved }: ArticleEditorProps) {
  const [slug, setSlug] = useState(article?.slug || "");
  const [titleEn, setTitleEn] = useState(article?.title_en || "");
  const [titleEs, setTitleEs] = useState(article?.title_es || "");
  const [contentEn, setContentEn] = useState(article?.content_en || "");
  const [contentEs, setContentEs] = useState(article?.content_es || "");
  const [category, setCategory] = useState(article?.category || "General");
  const [published, setPublished] = useState(article?.published || false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"en" | "es">("en");
  const { toast } = useToast();

  const autoSlug = (title: string) =>
    title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const save = async () => {
    if (!titleEn.trim()) { toast({ variant: "destructive", title: "English title is required" }); return; }
    if (!slug.trim()) { toast({ variant: "destructive", title: "Slug is required" }); return; }
    setSaving(true);
    try {
      const method = article ? "PATCH" : "POST";
      const url = article ? `/api/admin/articles/${article.id}` : "/api/admin/articles";
      const res = await fetch(url, {
        method,
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ slug, title_en: titleEn, title_es: titleEs || null, content_en: contentEn, content_es: contentEs || null, category, published }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Save failed");
      }
      toast({ title: article ? "Article updated" : "Article created" });
      onSaved();
      onClose();
    } catch (e: any) {
      toast({ variant: "destructive", title: e.message || "Failed to save" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.5)", overflowY: "auto", padding: "32px 16px" }}>
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "12px", width: "100%", maxWidth: "720px", padding: "28px", boxShadow: "0 20px 40px rgba(0,0,0,0.12)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
          <p style={{ fontSize: "15px", fontWeight: 600, color: "#1A1917", margin: 0 }}>
            {article ? "Edit Article" : "New Article"}
          </p>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", fontSize: "20px", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
          <div>
            <label style={{ fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: "6px" }}>Slug *</label>
            <input value={slug} onChange={e => setSlug(e.target.value)} placeholder="how-to-remove-grout" style={inp} />
          </div>
          <div>
            <label style={{ fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: "6px" }}>Category</label>
            <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...inp, height: "38px" }}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Language tabs */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px", borderBottom: "1px solid #E5E2DC", paddingBottom: "12px" }}>
          {(["en", "es"] as const).map(lang => (
            <button
              key={lang}
              onClick={() => setTab(lang)}
              style={{
                height: "30px", padding: "0 16px", borderRadius: "6px",
                fontSize: "12px", fontWeight: 600, cursor: "pointer",
                backgroundColor: tab === lang ? `rgba(${PURPLE_RGB}, 0.10)` : "#F7F6F3",
                color: tab === lang ? PURPLE : "#6B7280",
                border: tab === lang ? `1px solid rgba(${PURPLE_RGB}, 0.3)` : "1px solid #E5E2DC",
              }}
            >
              {lang === "en" ? "🇺🇸 English" : "🇲🇽 Español"}
            </button>
          ))}
        </div>

        {tab === "en" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: "6px" }}>Title (English) *</label>
              <input value={titleEn} onChange={e => { setTitleEn(e.target.value); if (!article && !slug) setSlug(autoSlug(e.target.value)); }} placeholder="Article title in English" style={inp} />
            </div>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: "6px" }}>Content (English)</label>
              <textarea value={contentEn} onChange={e => setContentEn(e.target.value)} rows={12} placeholder="Write article content here..." style={{ ...inp, resize: "vertical" }} />
            </div>
          </div>
        )}

        {tab === "es" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: "6px" }}>Title (Español)</label>
              <input value={titleEs} onChange={e => setTitleEs(e.target.value)} placeholder="Título del artículo en español" style={inp} />
            </div>
            <div>
              <label style={{ fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: "6px" }}>Contenido (Español)</label>
              <textarea value={contentEs} onChange={e => setContentEs(e.target.value)} rows={12} placeholder="Escribe el contenido del artículo aquí..." style={{ ...inp, resize: "vertical" }} />
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "20px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
            <div
              onClick={() => setPublished(!published)}
              style={{
                width: "36px", height: "20px", borderRadius: "10px", position: "relative",
                backgroundColor: published ? PURPLE : "#E5E2DC",
                transition: "background-color 0.2s", cursor: "pointer",
              }}
            >
              <div style={{
                width: "16px", height: "16px", borderRadius: "50%", backgroundColor: "#fff",
                position: "absolute", top: "2px",
                left: published ? "18px" : "2px",
                transition: "left 0.2s",
              }} />
            </div>
            <span style={{ fontSize: "13px", color: "#1A1917" }}>{published ? "Published" : "Draft"}</span>
          </label>

          <div style={{ display: "flex", gap: "10px" }}>
            <button onClick={onClose} style={{ height: "38px", padding: "0 20px", backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: "8px", color: "#6B7280", fontSize: "13px", cursor: "pointer" }}>
              Cancel
            </button>
            <button onClick={save} disabled={saving} style={{ height: "38px", padding: "0 24px", backgroundColor: PURPLE, border: "none", borderRadius: "8px", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer", opacity: saving ? 0.7 : 1 }}>
              {saving ? "Saving..." : article ? "Update Article" : "Create Article"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminCleancyclopedia() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Article | null | undefined>(undefined);
  const [search, setSearch] = useState("");
  const { toast } = useToast();

  const fetchArticles = () => {
    setLoading(true);
    fetch("/api/admin/articles", { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { setArticles(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { fetchArticles(); }, []);

  const handleDelete = async (article: Article) => {
    if (!confirm(`Delete "${article.title_en}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/admin/articles/${article.id}`, { method: "DELETE", headers: getAuthHeaders() });
      toast({ title: "Article deleted" });
      fetchArticles();
    } catch {
      toast({ variant: "destructive", title: "Failed to delete article" });
    }
  };

  const handleTogglePublish = async (article: Article) => {
    try {
      await fetch(`/api/admin/articles/${article.id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ published: !article.published }),
      });
      fetchArticles();
    } catch {
      toast({ variant: "destructive", title: "Failed to update article" });
    }
  };

  const filtered = articles.filter(a =>
    !search || a.title_en.toLowerCase().includes(search.toLowerCase()) || (a.category || "").toLowerCase().includes(search.toLowerCase())
  );

  const publishedCount = articles.filter(a => a.published).length;
  const drafts = articles.length - publishedCount;

  return (
    <AdminLayout title="Cleancyclopedia Management">
      {editing !== undefined && (
        <ArticleEditor
          article={editing}
          onClose={() => setEditing(undefined)}
          onSaved={fetchArticles}
        />
      )}

      {/* Header controls */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ display: "flex", gap: "16px" }}>
          <span style={{ fontSize: "13px", color: "#6B7280" }}>
            <strong style={{ color: "#1A1917" }}>{articles.length}</strong> articles
          </span>
          <span style={{ fontSize: "13px", color: "#16A34A" }}>
            <strong>{publishedCount}</strong> published
          </span>
          <span style={{ fontSize: "13px", color: "#6B7280" }}>
            <strong>{drafts}</strong> drafts
          </span>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search articles..."
            style={{ height: "34px", backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: "8px", color: "#1A1917", fontSize: "12px", padding: "0 12px", width: "200px" }}
          />
          <button
            onClick={() => setEditing(null)}
            style={{ display: "flex", alignItems: "center", gap: "6px", height: "34px", padding: "0 16px", backgroundColor: PURPLE, border: "none", borderRadius: "8px", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
          >
            <Plus size={14} />
            New Article
          </button>
        </div>
      </div>

      {/* Articles list */}
      <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: "60px", textAlign: "center", color: "#6B7280" }}>Loading articles...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "60px", textAlign: "center" }}>
            <p style={{ color: "#6B7280", margin: "0 0 16px" }}>{search ? "No articles match your search." : "No articles yet."}</p>
            {!search && (
              <button onClick={() => setEditing(null)} style={{ display: "inline-flex", alignItems: "center", gap: "6px", height: "38px", padding: "0 20px", backgroundColor: PURPLE, border: "none", borderRadius: "8px", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                <Plus size={14} /> Create First Article
              </button>
            )}
          </div>
        ) : (
          filtered.map((article, idx) => (
            <div
              key={article.id}
              style={{
                padding: "16px", display: "flex", alignItems: "center", gap: "16px",
                borderBottom: idx < filtered.length - 1 ? "1px solid #EEECE7" : "none",
                cursor: "default",
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#F7F6F3")}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}
            >
              {/* Status dot */}
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: article.published ? "#16A34A" : "#DEDAD4", flexShrink: 0 }} />

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "2px" }}>
                  <span style={{ fontSize: "13px", fontWeight: 500, color: "#1A1917" }}>{article.title_en}</span>
                  {article.title_es && <span style={{ fontSize: "10px", backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: "4px", padding: "1px 6px", color: "#6B7280" }}>ES</span>}
                </div>
                <div style={{ display: "flex", gap: "12px" }}>
                  {article.category && <span style={{ fontSize: "11px", color: "#9E9B94" }}>{article.category}</span>}
                  <span style={{ fontSize: "11px", color: "#9E9B94" }}>/{article.slug}</span>
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                <button
                  onClick={() => handleTogglePublish(article)}
                  title={article.published ? "Unpublish" : "Publish"}
                  style={{ width: "30px", height: "30px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: article.published ? "#F0FDF4" : "#F7F6F3", border: `1px solid ${article.published ? "#BBF7D0" : "#E5E2DC"}`, borderRadius: "6px", color: article.published ? "#16A34A" : "#9E9B94", cursor: "pointer" }}
                >
                  {article.published ? <Globe size={13} /> : <EyeOff size={13} />}
                </button>
                <button
                  onClick={() => setEditing(article)}
                  title="Edit"
                  style={{ width: "30px", height: "30px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: `rgba(${PURPLE_RGB}, 0.08)`, border: `1px solid rgba(${PURPLE_RGB}, 0.25)`, borderRadius: "6px", color: PURPLE, cursor: "pointer" }}
                >
                  <Edit2 size={13} />
                </button>
                <button
                  onClick={() => handleDelete(article)}
                  title="Delete"
                  style={{ width: "30px", height: "30px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#FEF2F2", border: "1px solid #FECACA", borderRadius: "6px", color: "#DC2626", cursor: "pointer" }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </AdminLayout>
  );
}
