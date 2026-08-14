// [commercial-photos 2026-08-14] Job photos for a COMMERCIAL account, grouped
// by visit.
//
// Maribel: "There's no place in the 'accounts' clients where we can see the
// pictures they have uploaded per job. I guess this should be under locations
// where it shows the history."
//
// Techs have been shooting before/afters on commercial jobs the whole time —
// the upload endpoint is job-keyed and never cared about the client type. Only
// the READ side was missing. The residential profile has had this for months
// (HomeImagesSection in customer-profile.tsx); accounts had nothing.
//
// Grouping BY VISIT is the point, not a presentation choice: the ask was to see
// them "per job", under the location's history. Each group is one visit, so the
// list doubles as the per-building history the Properties tab otherwise lacks
// (its only history today is a single "Last service" row).
//
// The residential twin duplicates this grouping logic with inline styles. This
// one is Tailwind to match account-detail.tsx. Worth collapsing into one
// component when someone can exercise both surfaces in a browser — not while
// the residential one is working and unverifiable from here.

import { useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { PhotoLightbox, downloadPhotosZip, type GalleryPhoto } from "@/components/photo-gallery";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type PhotoRow = {
  photo_id: number;
  job_id: number;
  photo_type: string | null;
  url: string;
  photo_timestamp: string | null;
  job_date: string | null;
  service_type: string | null;
  status: string | null;
  tech_first: string | null;
  tech_last: string | null;
  account_property_id: number | null;
  property_name: string | null;
};

function fmtDate(d?: string | null): string {
  if (!d) return "—";
  const s = String(d).slice(0, 10);
  const dt = new Date(`${s}T12:00:00`);
  if (isNaN(dt.getTime())) return s;
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function svcLabel(s?: string | null): string {
  if (!s) return "";
  return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

export function AccountJobPhotos({
  accountId, propertyId, showToast,
}: {
  accountId: number;
  /** Omit for every photo on the account; pass a building id to scope to it. */
  propertyId?: number;
  showToast?: (msg: string, kind?: "success" | "error") => void;
}) {
  const queryClient = useQueryClient();
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const qs = propertyId != null ? `?property_id=${propertyId}` : "";
  const queryKey = ["account-job-photos", accountId, propertyId ?? "all"];

  const { data: photos = [], isLoading, isError } = useQuery<PhotoRow[]>({
    queryKey,
    queryFn: async () => {
      const r = await fetch(`${API}/api/accounts/${accountId}/job-photos${qs}`, { headers: getAuthHeaders() as any });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 60000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey });

  // Label each group by the date the photos were TAKEN, not the job's current
  // scheduled_date — a rescheduled job drags scheduled_date to the new day,
  // which would file old pictures under a visit they weren't shot on. This is
  // the same stickiness fix the residential gallery carries.
  const groups = useMemo(() => {
    const byJob: Record<number, PhotoRow[]> = {};
    for (const p of photos) (byJob[p.job_id] ||= []).push(p);
    return Object.entries(byJob).map(([jobId, rows]) => ({
      jobId: Number(jobId),
      jobDate: rows[0]?.job_date ?? null,
      takenDate: String(rows.find(r => r.photo_timestamp)?.photo_timestamp || rows[0]?.job_date || "").slice(0, 10),
      serviceType: rows[0]?.service_type ?? null,
      propertyName: rows[0]?.property_name ?? null,
      techName: rows[0]?.tech_first ? `${rows[0].tech_first} ${rows[0].tech_last || ""}`.trim() : null,
      photos: rows,
    })).sort((a, b) => (b.takenDate || "").localeCompare(a.takenDate || ""));
  }, [photos]);

  // Flattened in render order so the lightbox arrows walk the whole history the
  // way the eye reads it, not just the visit that was clicked.
  const flat: GalleryPhoto[] = useMemo(() => groups.flatMap(g => g.photos.map(p => ({
    id: p.photo_id,
    url: p.url,
    photo_type: p.photo_type,
    caption: `${fmtDate(g.takenDate)}${g.serviceType ? ` · ${svcLabel(g.serviceType)}` : ""} · Job #${g.jobId}`,
  }))), [groups]);

  const indexOfPhoto = (photoId: number) => flat.findIndex(f => f.id === photoId);

  const runZip = async (ids: number[], name: string, label: string) => {
    if (!ids.length) return;
    setBusy(label);
    try {
      const { included, skipped } = await downloadPhotosZip(ids, name);
      showToast?.(
        skipped > 0
          ? `Downloaded ${included} photo${included === 1 ? "" : "s"} — ${skipped} could not be read.`
          : `Downloaded ${included} photo${included === 1 ? "" : "s"}.`,
        skipped > 0 ? "error" : "success",
      );
    } catch (e: any) {
      showToast?.(e?.message || "Download failed.", "error");
    }
    setBusy(null);
  };

  if (isLoading) {
    return <p className="text-xs text-gray-400">Loading photos…</p>;
  }
  if (isError) {
    return <p className="text-xs text-red-600">Could not load job photos.</p>;
  }
  if (!groups.length) {
    return (
      <p className="text-xs text-gray-400">
        No job photos yet. Cleaners add these from the mobile app during a visit.
      </p>
    );
  }

  const allIds = flat.map(f => f.id);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[11px] text-gray-500">
          {allIds.length} photo{allIds.length === 1 ? "" : "s"} across {groups.length} visit{groups.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={() => runZip(allIds, "job photos.zip", "all")}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-[#1A1917] disabled:opacity-60"
        >
          {busy === "all" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          Download all ({allIds.length})
        </button>
      </div>

      {groups.map(g => (
        <div key={g.jobId} className="rounded-lg border border-gray-200 overflow-hidden">
          <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50/70 px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[#0A0E1A] truncate">
                {fmtDate(g.takenDate)}
                {g.serviceType ? ` · ${svcLabel(g.serviceType)}` : ""}
                {/* Only shown when the visit has since moved, so the date on the
                    pictures and the date on the board can be reconciled. */}
                {g.jobDate && g.takenDate && String(g.jobDate).slice(0, 10) !== g.takenDate
                  ? ` · visit now on ${fmtDate(g.jobDate)}` : ""}
              </p>
              <p className="text-[11px] text-gray-500 truncate">
                {propertyId == null && g.propertyName ? `${g.propertyName} · ` : ""}
                {g.techName || "Cleaner not recorded"}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-3 shrink-0">
              <button
                onClick={() => runZip(g.photos.map(p => p.photo_id), `job ${g.jobId} photos.zip`, `job-${g.jobId}`)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-600 disabled:opacity-60"
                title="Download every photo from this visit"
              >
                {busy === `job-${g.jobId}` ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                ({g.photos.length})
              </button>
              <a
                href={`/dispatch?date=${String(g.jobDate || "").slice(0, 10)}&job=${g.jobId}`}
                className="text-[11px] font-semibold text-[var(--brand)] no-underline"
              >
                Job #{g.jobId}
              </a>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 p-2">
            {g.photos.map(p => (
              <button
                key={p.photo_id}
                onClick={() => setLightboxIdx(indexOfPhoto(p.photo_id))}
                className="relative block overflow-hidden rounded-md border border-gray-200 aspect-[4/3]"
                title="Open"
              >
                <img src={p.url} alt={`Job ${g.jobId}`} loading="lazy" className="h-full w-full object-cover" />
                {p.photo_type && (
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
                    {p.photo_type}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}

      {lightboxIdx !== null && flat.length > 0 && (
        <PhotoLightbox
          photos={flat}
          index={Math.min(lightboxIdx, flat.length - 1)}
          onIndexChange={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onDeleted={() => refresh()}
          showToast={showToast}
        />
      )}
    </div>
  );
}

export { canManagePhotos, Camera };
