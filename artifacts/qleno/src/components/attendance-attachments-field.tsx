// [attendance-attachments 2026-07-11] Drag-drop attachment field for the
// employee attendance record. Two modes:
//   • Staging (logId null/absent): holds File[] locally via files/onFilesChange.
//     Used in the "Record absence" modal, where the record doesn't exist yet —
//     the parent uploads these after the record is created.
//   • Live (logId set): fetches existing attachments for that attendance-log
//     row and supports upload-on-drop + delete. Used in View History.
// Photos and PDFs only; images are compressed client-side before upload.
import { useCallback, useEffect, useRef, useState } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { compressImage } from "@/lib/compress-image";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const BORDER = "#E5E2DC";
const TEXT = "#1A1917";
const MUTED = "#9E9B94";
const MINT = "var(--brand)";
const DANGER = "#B3261E";
const ACCEPT = "image/*,application/pdf";
const MAX_FILES = 12;

type LiveItem = { id: number; name: string; url: string; file_type?: string | null };

function isImage(type?: string | null, name?: string) {
  if (type) return type.startsWith("image/");
  return /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(name || "");
}
function isPdf(type?: string | null, name?: string) {
  return type === "application/pdf" || /\.pdf$/i.test(name || "");
}
function authHeaders(): Record<string, string> {
  // getAuthHeaders() may include a JSON Content-Type; strip it so the browser
  // sets the multipart boundary for FormData uploads.
  const h = { ...(getAuthHeaders() as Record<string, string>) };
  delete h["Content-Type"];
  delete h["content-type"];
  return h;
}

const tileBox: React.CSSProperties = {
  position: "relative", width: 56, height: 56, borderRadius: 8,
  border: `1px solid ${BORDER}`, overflow: "hidden", background: "#F7F6F3",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};
const removeBtn: React.CSSProperties = {
  position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%",
  border: "none", background: DANGER, color: "#fff", fontSize: 12, lineHeight: "18px",
  cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center",
};

function PdfTile({ name }: { name: string }) {
  return (
    <div style={{ ...tileBox, flexDirection: "column", gap: 2 }} title={name}>
      <span style={{ fontSize: 10, fontWeight: 800, color: DANGER }}>PDF</span>
      <span style={{ fontSize: 8, color: MUTED, maxWidth: 50, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
    </div>
  );
}

export function AttendanceAttachments({
  logId,
  files,
  onFilesChange,
  readOnly = false,
  compact = false,
}: {
  logId?: number | null;
  files?: File[];
  onFilesChange?: (files: File[]) => void;
  readOnly?: boolean;
  compact?: boolean;
}) {
  const live = typeof logId === "number" && logId > 0;
  const [dragOver, setDragOver] = useState(false);
  const [items, setItems] = useState<LiveItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Object URLs for staged (not-yet-uploaded) image previews; revoke on change.
  const previews = useRef<Map<File, string>>(new Map());
  useEffect(() => {
    return () => { previews.current.forEach(u => URL.revokeObjectURL(u)); previews.current.clear(); };
  }, []);
  function previewFor(f: File): string {
    let u = previews.current.get(f);
    if (!u) { u = URL.createObjectURL(f); previews.current.set(f, u); }
    return u;
  }

  const refresh = useCallback(async () => {
    if (!live) return;
    try {
      const r = await fetch(`${API}/api/attendance/attachments?log_ids=${logId}`, { headers: authHeaders() });
      if (!r.ok) return;
      const j = await r.json();
      setItems((j?.data?.[String(logId)] as LiveItem[]) ?? []);
    } catch { /* non-fatal */ }
  }, [live, logId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const count = live ? items.length : (files?.length ?? 0);
  const atCap = count >= MAX_FILES;

  function validate(list: File[]): File[] {
    return list.filter(f => isImage(f.type, f.name) || isPdf(f.type, f.name));
  }

  async function addFiles(fileList: FileList | File[]) {
    setErr(null);
    const incoming = validate(Array.from(fileList));
    if (!incoming.length) { setErr("Only photos and PDFs are allowed"); return; }
    const room = MAX_FILES - count;
    const accepted = incoming.slice(0, Math.max(0, room));
    if (!accepted.length) { setErr(`Up to ${MAX_FILES} files`); return; }

    if (!live) {
      onFilesChange?.([...(files ?? []), ...accepted]);
      return;
    }
    setBusy(true);
    try {
      for (const raw of accepted) {
        const file = isImage(raw.type, raw.name) ? await compressImage(raw) : raw;
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`${API}/api/attendance/${logId}/attachments`, {
          method: "POST", headers: authHeaders(), body: fd,
        });
        if (!res.ok) { setErr("Upload failed"); continue; }
      }
      await refresh();
    } finally { setBusy(false); }
  }

  function removeStaged(idx: number) {
    const next = (files ?? []).filter((_, i) => i !== idx);
    onFilesChange?.(next);
  }
  async function removeLive(id: number) {
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/attendance/${logId}/attachments/${id}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) setItems(prev => prev.filter(i => i.id !== id));
    } finally { setBusy(false); }
  }

  const canAdd = !readOnly && !atCap;
  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files); },
  };
  const hiddenInput = (
    <input
      ref={inputRef} type="file" accept={ACCEPT} multiple hidden
      onChange={e => { if (e.target.files?.length) void addFiles(e.target.files); e.currentTarget.value = ""; }}
    />
  );

  return (
    <div>
      {canAdd && !compact && (
        <div
          onClick={() => inputRef.current?.click()}
          {...dropHandlers}
          style={{
            border: `1.5px dashed ${dragOver ? MINT : BORDER}`, borderRadius: 8,
            padding: "12px", textAlign: "center", cursor: "pointer",
            background: dragOver ? "rgba(var(--brand-rgb),0.06)" : "#FBFAF8",
            color: MUTED, fontSize: 12.5, transition: "border-color .12s,background .12s",
          }}
        >
          <span style={{ color: TEXT, fontWeight: 600 }}>Drag files here</span> or click to browse
          <div style={{ fontSize: 11, marginTop: 2 }}>Photos or PDFs{busy ? " · uploading…" : ""}</div>
          {hiddenInput}
        </div>
      )}

      {err && <p style={{ fontSize: 11.5, color: DANGER, margin: "6px 0 0" }}>{err}</p>}

      {(count > 0 || (canAdd && compact)) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: (canAdd && !compact) ? 10 : 0 }}>
          {live
            ? items.map(it => (
                <div key={it.id} style={{ position: "relative" }}>
                  <a href={it.url} target="_blank" rel="noreferrer" style={{ display: "block" }} title={it.name}>
                    {isImage(it.file_type, it.name)
                      ? <div style={tileBox}><img src={it.url} alt={it.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
                      : <PdfTile name={it.name} />}
                  </a>
                  {!readOnly && (
                    <button type="button" aria-label="Remove" onClick={() => void removeLive(it.id)} disabled={busy} style={removeBtn}>×</button>
                  )}
                </div>
              ))
            : (files ?? []).map((f, i) => (
                <div key={`${f.name}-${i}`} style={{ position: "relative" }}>
                  {isImage(f.type, f.name)
                    ? <div style={tileBox}><img src={previewFor(f)} alt={f.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
                    : <PdfTile name={f.name} />}
                  <button type="button" aria-label="Remove" onClick={() => removeStaged(i)} style={removeBtn}>×</button>
                </div>
              ))}
          {canAdd && compact && (
            <div
              onClick={() => inputRef.current?.click()}
              {...dropHandlers}
              title="Add photo or PDF"
              style={{
                ...tileBox, cursor: "pointer", borderStyle: "dashed",
                borderColor: dragOver ? MINT : BORDER, flexDirection: "column",
                background: dragOver ? "rgba(var(--brand-rgb),0.06)" : "#FBFAF8", color: MUTED,
              }}
            >
              <span style={{ fontSize: 20, lineHeight: 1, color: TEXT }}>+</span>
              <span style={{ fontSize: 9 }}>{busy ? "…" : "Add"}</span>
              {hiddenInput}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
