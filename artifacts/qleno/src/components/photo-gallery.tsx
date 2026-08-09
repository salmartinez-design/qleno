// [photo-management 2026-08-09] Francisco: "We need the ability to delete,
// download, and batch download images attached to a service. Currently, from the
// Client Profile, we can see that photos have been uploaded, but we cannot open
// them, download them, or manage them in any way."
//
// Everything the office can do to a job photo lives here so the customer
// profile, the dispatch drawer, and anything added later behave the same way.
//
// Downloads go through the API rather than the image URL on purpose. A job
// photo's stored url is an R2 object key that reads sign into a short-lived URL
// on a DIFFERENT origin, and a browser ignores the `download` attribute on a
// cross-origin href — it navigates to the picture instead of saving it. The
// server hands the bytes back with a Content-Disposition; we turn them into a
// blob and click a link at that, which saves reliably and also lets us send the
// auth header the endpoint requires.

import { useEffect, useState } from "react";
import { Download, Trash2, X, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

export type GalleryPhoto = {
  /** job_photos.id — what the download and delete endpoints key off. */
  id: number;
  /** Signed (or inline) URL for display. */
  url: string;
  photo_type?: string | null;
  /** Optional context line shown in the lightbox, e.g. "Aug 4 · Deep Clean". */
  caption?: string | null;
};

/** Deleting a photo is an office correction; techs shoot them, they don't curate them. */
export function canManagePhotos(): boolean {
  const role = getTokenRole();
  return role === "owner" || role === "admin" || role === "office" || role === "super_admin";
}

function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the save in Safari; one tick is enough.
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Pull the server's filename out of Content-Disposition, else fall back. */
function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get("content-disposition") || "";
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return m ? decodeURIComponent(m[1]) : fallback;
}

export async function downloadPhoto(photoId: number): Promise<void> {
  const res = await fetch(`${API}/api/photos/${photoId}/download`, { headers: getAuthHeaders() as any });
  if (!res.ok) throw new Error(await res.text());
  saveBlob(await res.blob(), filenameFrom(res, `photo-${photoId}.jpg`));
}

/** Returns how many photos actually made it into the archive. */
export async function downloadPhotosZip(photoIds: number[], fallbackName = "photos.zip"): Promise<{ included: number; skipped: number }> {
  const res = await fetch(`${API}/api/photos/download-zip`, {
    method: "POST",
    headers: { ...(getAuthHeaders() as any), "Content-Type": "application/json" },
    body: JSON.stringify({ photo_ids: photoIds }),
  });
  if (!res.ok) {
    let msg = "Download failed.";
    try { msg = (await res.json())?.message || msg; } catch { /* non-JSON error body */ }
    throw new Error(msg);
  }
  const included = Number(res.headers.get("x-photos-included") || photoIds.length);
  const skipped = Number(res.headers.get("x-photos-skipped") || 0);
  saveBlob(await res.blob(), filenameFrom(res, fallbackName));
  return { included, skipped };
}

export async function deletePhoto(photoId: number): Promise<void> {
  const res = await fetch(`${API}/api/photos/${photoId}`, { method: "DELETE", headers: getAuthHeaders() as any });
  if (!res.ok) throw new Error(await res.text());
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────
// Full-size view with ← / → / Esc, a download, and (for office roles) a delete
// behind a confirm. `photos` is the whole set being browsed so the arrows can
// walk across job groups the way the eye expects.

export function PhotoLightbox({
  photos, index, onIndexChange, onClose, onDeleted, showToast,
}: {
  photos: GalleryPhoto[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  /** Called after a successful delete so the owner can refetch. */
  onDeleted?: (photoId: number) => void;
  showToast?: (msg: string, kind?: "success" | "error") => void;
}) {
  const [busy, setBusy] = useState<"download" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const photo = photos[index];

  const step = (d: number) => {
    if (photos.length < 2) return;
    onIndexChange((index + d + photos.length) % photos.length);
    setConfirmDelete(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, photos.length]);

  // A full-screen overlay that lets the page scroll behind it is disorienting.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!photo) return null;

  const handleDownload = async () => {
    setBusy("download");
    try {
      await downloadPhoto(photo.id);
    } catch {
      showToast?.("Could not download that photo.", "error");
    }
    setBusy(null);
  };

  const handleDelete = async () => {
    setBusy("delete");
    try {
      await deletePhoto(photo.id);
      showToast?.("Photo deleted.", "success");
      onDeleted?.(photo.id);
      // Stepping to a neighbour keeps the office in the set they were reviewing;
      // closing only when the last one is gone.
      if (photos.length <= 1) onClose();
      else onIndexChange(index >= photos.length - 1 ? index - 1 : index);
    } catch {
      showToast?.("Could not delete that photo.", "error");
    }
    setBusy(null);
    setConfirmDelete(false);
  };

  const iconBtn = {
    display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 8,
    background: "rgba(255,255,255,.14)", border: "1px solid rgba(255,255,255,.22)",
    color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FF,
  } as const;

  const arrowBtn = (side: "left" | "right") => ({
    position: "absolute" as const, [side]: 12, top: "50%", transform: "translateY(-50%)",
    width: 48, height: 48, borderRadius: "50%", background: "rgba(255,255,255,.15)",
    border: "none", color: "#fff", cursor: "pointer",
    display: photos.length > 1 ? "flex" : "none", alignItems: "center", justifyContent: "center",
  });

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.92)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: FF }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 14, right: 16, display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={handleDownload} disabled={busy !== null} style={{ ...iconBtn, opacity: busy ? 0.6 : 1 }}>
          {busy === "download" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download
        </button>
        {canManagePhotos() && (
          confirmDelete ? (
            <>
              <button onClick={handleDelete} disabled={busy !== null} style={{ ...iconBtn, background: "#DC2626", border: "1px solid #DC2626", opacity: busy ? 0.6 : 1 }}>
                {busy === "delete" ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete for good
              </button>
              <button onClick={() => setConfirmDelete(false)} style={iconBtn}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirmDelete(true)} style={iconBtn}><Trash2 size={13} /> Delete</button>
          )
        )}
        <button onClick={onClose} aria-label="Close" style={{ ...iconBtn, padding: 8 }}><X size={15} /></button>
      </div>

      <button onClick={(e) => { e.stopPropagation(); step(-1); }} aria-label="Previous" style={arrowBtn("left")}>
        <ChevronLeft size={26} />
      </button>
      <img
        src={photo.url}
        alt={photo.caption || "Job photo"}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "86%", maxHeight: "82%", objectFit: "contain", borderRadius: 4 }}
      />
      <button onClick={(e) => { e.stopPropagation(); step(1); }} aria-label="Next" style={arrowBtn("right")}>
        <ChevronRight size={26} />
      </button>

      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: "absolute", bottom: 18, left: "50%", transform: "translateX(-50%)", color: "#fff", fontSize: 12, fontWeight: 600, background: "rgba(0,0,0,.55)", padding: "6px 14px", borderRadius: 14, textAlign: "center", maxWidth: "90%" }}
      >
        {photo.photo_type ? `${photo.photo_type[0].toUpperCase()}${photo.photo_type.slice(1)} · ` : ""}
        {index + 1} / {photos.length}
        {photo.caption ? <div style={{ fontWeight: 500, opacity: 0.85, marginTop: 2 }}>{photo.caption}</div> : null}
      </div>
    </div>
  );
}
