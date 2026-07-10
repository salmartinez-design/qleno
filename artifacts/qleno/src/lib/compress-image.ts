// [photo-compress 2026-07-10] Shrinks phone photos IN THE BROWSER before upload
// so before/after job photos land in ~1–2s on cell data instead of ~30s each.
//
// Why: a modern phone photo is 3–12 MB (iPhone 16/17 Pro shoot 24–48 MP HEIC by
// default). Resized to a 1600px long edge and re-encoded as JPEG q0.72 it's
// ~250–500 KB — roughly 10–25× smaller — with no visible loss at the size the
// office reviews before/after work. Re-encoding also turns HEIC/PNG into JPEG,
// so those stop getting silently dropped by the upload size/type gate (the
// "can't add more photos" report).
//
// [iphone-heic 2026-07-10] Most Phes techs are on iPhone (16/17 Pro or older),
// where HEIC is the norm. Two decode paths so a real HEIC photo can't slip
// through uncompressed: createImageBitmap first (fast, bakes in EXIF
// orientation, decodes HEIC on Safari), then an <img> element fallback (iOS
// Safari renders HEIC reliably here even where createImageBitmap is flaky, and
// applies EXIF orientation automatically). ANY total failure falls back to the
// original file — compression must never block an upload.

const MAX_DIM = 1600;
const QUALITY = 0.72;

type Decoded = { source: CanvasImageSource; width: number; height: number; cleanup: () => void };

async function decode(file: File): Promise<Decoded | null> {
  // Fast path: createImageBitmap — decodes JPEG/PNG/WebP and HEIC (Safari), and
  // imageOrientation:"from-image" bakes EXIF rotation into the pixels so
  // portrait shots aren't sideways.
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    if (bmp.width && bmp.height) {
      return { source: bmp, width: bmp.width, height: bmp.height, cleanup: () => bmp.close?.() };
    }
    bmp.close?.();
  } catch {
    /* fall through to the <img> path */
  }

  // Fallback: load through an <img>. iOS Safari renders HEIC here reliably and
  // auto-applies EXIF orientation to naturalWidth/naturalHeight, so drawImage
  // gets correctly-rotated pixels. This is the path that matters most for the
  // iPhone-heavy field crew.
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("img decode failed"));
      el.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) {
      URL.revokeObjectURL(url);
      return null;
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, cleanup: () => URL.revokeObjectURL(url) };
  } catch {
    return null;
  }
}

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

  const d = await decode(file);
  if (!d) return file; // couldn't decode at all — send the original, never drop it

  try {
    const longEdge = Math.max(d.width, d.height);
    const scale = longEdge > maxDim ? maxDim / longEdge : 1;
    const w = Math.max(1, Math.round(d.width * scale));
    const h = Math.max(1, Math.round(d.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(d.source, 0, 0, w, h);

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!blob) return file;

    // If re-encoding didn't help (already-tiny optimized JPEG), keep the
    // original so we never make a file bigger.
    if (blob.size >= file.size && /jpe?g/i.test(file.type)) return file;

    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${base}.jpg`, {
      type: "image/jpeg",
      lastModified: file.lastModified || Date.now(),
    });
  } catch {
    return file;
  } finally {
    d.cleanup();
  }
}
