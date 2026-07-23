import { useEffect, useRef, useState, useCallback } from "react";
import { X, ZoomIn } from "lucide-react";

const FF = "'Plus Jakarta Sans', sans-serif";
const VP = 288;   // square crop viewport (display px)
const OUT = 256;  // exported avatar size (px) — matches the lightweight data-URL convention

/**
 * Avatar crop/adjust modal. The old flow dumped the raw image straight in, so
 * faces ended up off-center. This lets the user drag to reposition + zoom, then
 * exports a square JPEG data URL of exactly the framed region.
 *
 * Model: the image is laid out at "cover" base scale × zoom, top-left at
 * `pos`. The visible VP×VP square maps back to a source region we draw onto an
 * OUT×OUT canvas.
 */
export function AvatarCropModal({
  file, onCancel, onSave, saving = false,
}: {
  file: File;
  onCancel: () => void;
  onSave: (dataUrl: string) => void;
  saving?: boolean;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // base "cover" scale so the image fills the viewport at zoom = 1
  const baseScale = img ? Math.max(VP / img.width, VP / img.height) : 1;
  const dispW = img ? img.width * baseScale * zoom : 0;
  const dispH = img ? img.height * baseScale * zoom : 0;

  const clamp = useCallback((p: { x: number; y: number }, w: number, h: number) => ({
    x: Math.min(0, Math.max(VP - w, p.x)),
    y: Math.min(0, Math.max(VP - h, p.y)),
  }), []);

  // Load the chosen file → Image, and center it.
  useEffect(() => {
    let alive = true;
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => {
        if (!alive) return;
        setImg(im);
        const bs = Math.max(VP / im.width, VP / im.height);
        const w = im.width * bs, h = im.height * bs;
        setZoom(1);
        setPos({ x: (VP - w) / 2, y: (VP - h) / 2 });
      };
      im.src = String(fr.result);
    };
    fr.readAsDataURL(file);
    return () => { alive = false; };
  }, [file]);

  // Re-clamp (keep centered point) when zoom changes.
  useEffect(() => {
    if (!img) return;
    setPos(p => {
      const cx = VP / 2 - p.x, cy = VP / 2 - p.y; // viewport center in image space (prev)
      void cx; void cy;
      return clamp(p, img.width * baseScale * zoom, img.height * baseScale * zoom);
    });
  }, [zoom, img, baseScale, clamp]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !img) return;
    const nx = drag.current.ox + (e.clientX - drag.current.x);
    const ny = drag.current.oy + (e.clientY - drag.current.y);
    setPos(clamp({ x: nx, y: ny }, dispW, dispH));
  };
  const onPointerUp = () => { drag.current = null; };

  function handleSave() {
    if (!img) return;
    const srcScale = baseScale * zoom;        // display px per source px
    const srcX = -pos.x / srcScale;
    const srcY = -pos.y / srcScale;
    const srcSize = VP / srcScale;
    const canvas = document.createElement("canvas");
    canvas.width = OUT; canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, OUT, OUT);
    onSave(canvas.toDataURL("image/jpeg", 0.85));
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", fontFamily: FF }}
      onClick={onCancel}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 24, width: 360, maxWidth: "calc(100vw - 32px)", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#1A1917" }}>Adjust photo</p>
          <button onClick={onCancel} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}><X size={18} /></button>
        </div>

        {/* Crop viewport — circular mask to match how the avatar renders */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{
            position: "relative", width: VP, height: VP, margin: "0 auto",
            borderRadius: "50%", overflow: "hidden", background: "#F0EEE9",
            cursor: drag.current ? "grabbing" : "grab", touchAction: "none",
            border: "1px solid #E5E2DC", userSelect: "none",
          }}
        >
          {img ? (
            <img
              src={img.src}
              alt="" draggable={false}
              style={{ position: "absolute", left: pos.x, top: pos.y, width: dispW, height: dispH, maxWidth: "none", pointerEvents: "none" }}
            />
          ) : (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#9E9B94", fontSize: 13 }}>Loading…</div>
          )}
        </div>

        <p style={{ textAlign: "center", fontSize: 11, color: "#9E9B94", margin: "10px 0 4px" }}>Drag to reposition</p>

        {/* Zoom */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 4px 18px" }}>
          <ZoomIn size={16} style={{ color: "#9E9B94", flexShrink: 0 }} />
          <input type="range" min={1} max={3} step={0.01} value={zoom}
            onChange={e => setZoom(parseFloat(e.target.value))}
            disabled={!img}
            style={{ flex: 1, accentColor: "var(--brand)" }} />
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={onCancel}
            style={{ flex: 1, padding: 10, border: "1px solid #E5E2DC", borderRadius: 8, background: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", color: "#6B6860", fontFamily: FF }}>
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={!img || saving}
            style={{ flex: 1, padding: 10, border: "none", borderRadius: 8, background: "var(--brand)", fontSize: 14, fontWeight: 600, cursor: "pointer", color: "#fff", fontFamily: FF, opacity: (!img || saving) ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save photo"}
          </button>
        </div>
      </div>
    </div>
  );
}
