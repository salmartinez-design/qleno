import { useState, useEffect, useRef, useCallback } from "react";
import { Paperclip, X, Loader2, FileText, AlertCircle } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

// Lightweight fetch wrapper — auth header + JSON parse. Mirrors the
// pattern used throughout the qleno app (each page redefines its own;
// inlining here keeps this component self-contained).
async function apiFetch(path: string, opts: RequestInit = {}) {
  const auth = getAuthHeaders() as Record<string, string>;
  const headers: Record<string, string> = {
    ...auth,
    ...(opts.body ? { "Content-Type": "application/json" } : {}),
    ...((opts.headers as Record<string, string>) ?? {}),
  };
  const body = opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body;
  const r = await fetch(path, { ...opts, headers, body });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.status === 204 ? null : r.json();
}

const FF = "'Plus Jakarta Sans', sans-serif";
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/gif",
  "application/pdf",
]);
const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;

export type Attachment = {
  id: number;
  name: string;
  file_url: string;
  file_type: string | null;
  file_size: number | null;
  created_at: string;
};

type Props = {
  /** Async getter — must return a quote id; if no quote exists yet,
   *  the caller is expected to create a draft and return its id. The
   *  attachments component delays the upload until this resolves. */
  ensureQuoteId: () => Promise<number | null>;
  /** Read-only mode (e.g., tech viewing on the job side). */
  readOnly?: boolean;
  /** Override the GET endpoint — defaults to /api/quotes/:id/attachments,
   *  but the job view uses /api/jobs/:id/attachments. */
  endpointOverride?: string;
  /** Compact mode — smaller thumbs, used inside dense panels. */
  compact?: boolean;
};

export function QuoteAttachments({ ensureQuoteId, readOnly, endpointOverride, compact }: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteId, setQuoteId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initial load — resolve the quote id, then fetch its attachments.
  // For brand-new drafts (no quote saved yet) ensureQuoteId may return
  // null; that's fine, we render the empty drop zone and only mint the
  // quote when the user actually drops a file.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await ensureQuoteId();
      if (cancelled) return;
      setQuoteId(id);
      if (id != null) await loadList(id);
    })();
    return () => { cancelled = true; };
  }, []);

  async function loadList(id: number) {
    try {
      const url = endpointOverride ?? `/api/quotes/${id}/attachments`;
      const rows = await apiFetch(url);
      setAttachments(Array.isArray(rows) ? rows : []);
    } catch {
      // Don't blow up the page if the list fetch fails — just leave it empty.
    }
  }

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    setError(null);
    const list = Array.from(files);
    if (list.length === 0) return;

    // Resolve / create quote id before doing anything.
    const id = quoteId ?? await ensureQuoteId();
    if (id == null) {
      setError("Could not create draft quote. Save the quote first, then try again.");
      return;
    }
    setQuoteId(id);

    // Client-side validation — server enforces the same rules but failing
    // here gives faster feedback and skips wasted bytes on the wire.
    const filtered: File[] = [];
    for (const f of list) {
      if (!ALLOWED_MIME.has(f.type)) {
        setError(`"${f.name}" is not a supported file type. Use JPG/PNG/HEIC/WEBP/PDF.`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        setError(`"${f.name}" is over 10 MB.`);
        continue;
      }
      filtered.push(f);
    }
    if (attachments.length + filtered.length > MAX_FILES) {
      setError(`Maximum ${MAX_FILES} files per quote.`);
      filtered.splice(MAX_FILES - attachments.length);
    }
    if (filtered.length === 0) return;

    setUploading(true);
    for (const file of filtered) {
      const form = new FormData();
      form.append("file", file);
      form.append("name", file.name);
      try {
        const res = await fetch(`/api/quotes/${id}/attachments`, {
          method: "POST",
          headers: getAuthHeaders() as Record<string, string>,
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || `Upload failed for "${file.name}".`);
          continue;
        }
        const row = await res.json();
        setAttachments(prev => [row, ...prev]);
      } catch {
        setError(`Upload failed for "${file.name}".`);
      }
    }
    setUploading(false);
  }, [attachments.length, ensureQuoteId, quoteId]);

  async function removeAttachment(id: number) {
    if (quoteId == null) return;
    try {
      await apiFetch(`/api/quotes/${quoteId}/attachments/${id}`, { method: "DELETE" });
      setAttachments(prev => prev.filter(a => a.id !== id));
    } catch {
      setError("Could not delete that file. Refresh and try again.");
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (readOnly) return;
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
  }

  const thumbSize = compact ? 56 : 72;

  return (
    <div
      onDragOver={readOnly ? undefined : e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={readOnly ? undefined : () => setDragOver(false)}
      onDrop={handleDrop}
      style={{
        marginTop: 10,
        padding: dragOver ? 10 : 0,
        border: dragOver ? "2px dashed #0F7A63" : "2px dashed transparent",
        borderRadius: 8,
        background: dragOver ? "#EAF9F4" : "transparent",
        transition: "background 0.12s, border-color 0.12s, padding 0.12s",
      }}
    >
      {/* Action row */}
      {!readOnly && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: attachments.length ? 8 : 0 }}>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || attachments.length >= MAX_FILES}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              fontSize: 12, fontWeight: 600, fontFamily: FF,
              padding: "6px 12px", borderRadius: 7,
              border: "1px solid #E5E2DC", background: "#FFF", color: "#1A1917",
              cursor: (uploading || attachments.length >= MAX_FILES) ? "not-allowed" : "pointer",
              opacity: (uploading || attachments.length >= MAX_FILES) ? 0.5 : 1,
            }}
          >
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Paperclip size={13} />}
            {uploading ? "Uploading..." : "Attach photo or PDF"}
          </button>
          <span style={{ fontSize: 11, color: "#9E9B94", fontFamily: FF }}>
            or drop files here — {attachments.length}/{MAX_FILES} used
          </span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/heic,image/heif,image/webp,image/gif,application/pdf"
            onChange={e => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ""; }}
            style={{ display: "none" }}
          />
        </div>
      )}

      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#B3261E", fontFamily: FF, marginBottom: 8 }}>
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {/* Thumbnail row */}
      {attachments.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {attachments.map(a => {
            const isImage = a.file_type?.startsWith("image/");
            return (
              <div
                key={a.id}
                style={{
                  position: "relative",
                  width: thumbSize, height: thumbSize,
                  borderRadius: 7, border: "1px solid #E5E2DC", background: "#F7F6F3",
                  overflow: "hidden",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
                title={a.name}
              >
                <a href={a.file_url} target="_blank" rel="noopener noreferrer" style={{ display: "block", width: "100%", height: "100%" }}>
                  {isImage ? (
                    <img src={a.file_url} alt={a.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: 4 }}>
                      <FileText size={20} color="#6B6860" />
                      <span style={{ fontSize: 9, fontFamily: FF, color: "#6B6860", marginTop: 3, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: thumbSize - 8 }}>
                        {a.name}
                      </span>
                    </div>
                  )}
                </a>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); e.preventDefault(); removeAttachment(a.id); }}
                    style={{
                      position: "absolute", top: 3, right: 3,
                      width: 18, height: 18, borderRadius: "50%",
                      background: "rgba(0,0,0,0.6)", color: "#FFF",
                      border: "none", cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
