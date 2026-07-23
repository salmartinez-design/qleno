import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  isStaleChunk: boolean;
  errorId: string | null;
}

// [stale-chunk 2026-06-25] After a deploy, the bundle's code-split chunk
// filenames change. A tab still running the OLD bundle that navigates to a
// lazy-loaded route tries to fetch a chunk by its old (now-deleted) name, the
// dynamic import rejects, and we'd otherwise show "Something went wrong". We
// deploy frequently, so users hit this constantly when moving screen to screen.
// Detect that specific failure and silently reload to pull the fresh bundle.
export function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err || "");
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload|ChunkLoadError|loading chunk \d|dynamically imported module/i.test(msg);
}

// Reload at most once per 20s so a genuinely-broken chunk can't loop forever.
export function reloadForStaleChunk(): boolean {
  try {
    const KEY = "__qleno_chunk_reload_at__";
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 20000) return false; // already reloaded recently → let the error show
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { /* sessionStorage unavailable — reload anyway */ }
  window.location.reload();
  return true;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, isStaleChunk: false, errorId: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, isStaleChunk: isStaleChunkError(error), errorId: `err_${Date.now()}` };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isStaleChunkError(error)) {
      // New bundle deployed under us — refresh to it instead of erroring.
      reloadForStaleChunk();
      return;
    }
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      // Stale chunk: the page is reloading itself — show a quiet "updating"
      // state, never the alarming error card.
      if (this.state.isStaleChunk) {
        return (
          <div style={{
            minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
            backgroundColor: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif",
            color: "#6B6860", fontSize: "14px", gap: "10px",
          }}>
            <span style={{
              width: "16px", height: "16px", border: "2px solid #D9D5CC", borderTopColor: "var(--brand)",
              borderRadius: "50%", display: "inline-block", animation: "qspin 0.7s linear infinite",
            }} />
            Updating to the latest version…
            <style>{`@keyframes qspin{to{transform:rotate(360deg)}}`}</style>
          </div>
        );
      }
      return (
        <div style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#F7F6F3",
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          padding: "24px",
        }}>
          <div style={{
            backgroundColor: "#FFFFFF",
            border: "1px solid #E5E2DC",
            borderRadius: "12px",
            padding: "48px 40px",
            maxWidth: "480px",
            width: "100%",
            textAlign: "center",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          }}>
            <div style={{
              width: "48px",
              height: "48px",
              borderRadius: "50%",
              backgroundColor: "#FCEBEA",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 20px",
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#B3261E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h2 style={{ fontSize: "18px", fontWeight: 700, color: "#1A1917", margin: "0 0 8px" }}>
              Something went wrong
            </h2>
            <p style={{ fontSize: "14px", color: "#6B6860", margin: "0 0 28px", lineHeight: 1.6 }}>
              An unexpected error occurred. Please refresh the page to continue.
              If this keeps happening, contact support.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                backgroundColor: "var(--brand)",
                color: "#FFFFFF",
                border: "none",
                borderRadius: "8px",
                padding: "10px 24px",
                fontSize: "14px",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              Refresh page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
