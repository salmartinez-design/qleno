// [photo-compress 2026-07-10] Shrinks phone photos IN THE BROWSER before upload
// so before/after job photos land in ~1–2s on cell data instead of ~30s each.
//
// Why: a modern phone photo is 3–12 MB. Resized to a 1600px long edge and
// re-encoded as JPEG q0.72 it's ~250–450 KB — roughly 10–20× smaller — with no
// visible loss at the size the office reviews before/after work. Re-encoding
// also turns iPhone HEIC (and PNG) into JPEG, so those stop getting silently
// dropped by the upload size/type gate (the "can't add more photos" report).
//
// EXIF orientation is baked into the pixels (imageOrientation:"from-image") so
// portrait shots don't come out sideways. ANY failure falls back to the
// original file — compression must never block an upload.

const MAX_DIM = 1600;
const QUALITY = 0.72;

export async function compressImage(
  file: File,
  maxDim: number = MAX_DIM,
  quality: number = QUALITY,
): Promise<File> {
  // Only touch images. Match by MIME or extension (some pickers report an empty
  // type for HEIC).
  const looksImage =
    file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
  if (!looksImage) return file;

  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    } as ImageBitmapOptions);

    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > maxDim ? maxDim / longEdge : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!blob) return file;

    // If re-encoding somehow didn't help (already-tiny optimized JPEG), keep the
    // original so we never make a file bigger.
    if (blob.size >= file.size && /jpe?g/i.test(file.type)) return file;

    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${base}.jpg`, {
      type: "image/jpeg",
      lastModified: file.lastModified || Date.now(),
    });
  } catch {
    // Browser couldn't decode it (e.g. HEIC on a non-Safari browser) — send the
    // original and let the server handle it rather than dropping the photo.
    return file;
  }
}
