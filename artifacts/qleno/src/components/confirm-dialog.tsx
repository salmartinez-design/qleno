// [branded-confirm 2026-08-15] Replaces window.confirm() for destructive
// actions.
//
// Two reasons the native dialog had to go:
//   1. It is unreliable. Chrome suppresses further dialogs once a user ticks
//      "prevent this page from creating additional dialogs", and embedded /
//      automated browsers auto-dismiss them. Because the call site reads
//      `if (confirm(...))`, a suppressed dialog returns false and the action
//      silently does NOTHING — no request, no error, no toast. That is exactly
//      how estimate delete presented: the button looked dead.
//   2. It is off-brand — same reason native date pickers are banned here.
//
// Usage:
//   const [pending, setPending] = useState<number | null>(null);
//   <ConfirmDialog
//     open={pending !== null}
//     title="Delete this estimate?"
//     body="This removes the estimate and its line items. It cannot be undone."
//     confirmLabel="Delete"
//     destructive
//     onConfirm={() => { del.mutate(pending!); setPending(null); }}
//     onCancel={() => setPending(null)}
//   />
import { useEffect } from "react";

const FF = "'Plus Jakarta Sans', sans-serif";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const DANGER = "#B3261E";

export function ConfirmDialog({
  open, title, body, confirmLabel = "Confirm", cancelLabel = "Cancel",
  destructive = false, busy = false, onConfirm, onCancel,
}: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Escape closes. Bound only while open so it never eats Escape elsewhere.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, background: "rgba(10,14,26,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 18, zIndex: 80, fontFamily: FF,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 16, padding: 22, width: "100%", maxWidth: 400 }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, color: INK, marginBottom: body ? 8 : 18 }}>{title}</div>
        {body && <div style={{ fontSize: 13.5, lineHeight: 1.5, color: MUTE, marginBottom: 18 }}>{body}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "9px 14px", borderRadius: 9, cursor: busy ? "default" : "pointer",
              fontFamily: FF, fontSize: 13, fontWeight: 700,
              border: `1px solid ${BORDER}`, background: "#fff", color: INK,
            }}
          >{cancelLabel}</button>
          <button
            onClick={onConfirm}
            disabled={busy}
            autoFocus
            style={{
              padding: "9px 14px", borderRadius: 9, cursor: busy ? "default" : "pointer",
              fontFamily: FF, fontSize: 13, fontWeight: 700, border: "none",
              background: destructive ? DANGER : "var(--brand)",
              color: "#fff", opacity: busy ? 0.6 : 1,
            }}
          >{busy ? "Working…" : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
