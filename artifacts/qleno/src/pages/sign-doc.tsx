import { useState, useRef, useEffect } from "react";
import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function SignaturePad({ onSignature }: { onSignature: (data: string, name: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [typedName, setTypedName] = useState("");
  const [drawing, setDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if ("touches" in e) {
      return { x: (e.touches[0].clientX - rect.left) * scaleX, y: (e.touches[0].clientY - rect.top) * scaleY };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const startDraw = (e: React.MouseEvent | React.TouchEvent) => { setDrawing(true); lastPos.current = getPos(e); };
  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawing || !canvasRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d")!;
    const pos = getPos(e);
    ctx.beginPath(); ctx.moveTo(lastPos.current!.x, lastPos.current!.y);
    ctx.lineTo(pos.x, pos.y); ctx.strokeStyle = "#1A1917"; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.stroke();
    lastPos.current = pos; setHasDrawn(true);
    onSignature(canvasRef.current.toDataURL(), typedName);
  };
  const endDraw = () => { setDrawing(false); lastPos.current = null; };
  const clear = () => {
    if (!canvasRef.current) return;
    canvasRef.current.getContext("2d")!.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    setHasDrawn(false); onSignature("", typedName);
  };

  useEffect(() => { if (mode === "type" && typedName) onSignature("typed:" + typedName, typedName); }, [typedName, mode]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {(["draw", "type"] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: "5px 12px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer",
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            background: mode === m ? "var(--brand, #00C9A0)" : "#F7F6F3",
            color: mode === m ? "#fff" : "#6B7280",
            border: `1px solid ${mode === m ? "var(--brand, #00C9A0)" : "#E5E2DC"}`,
          }}>{m === "draw" ? "Draw" : "Type Name"}</button>
        ))}
      </div>
      {mode === "draw" ? (
        <div style={{ position: "relative" }}>
          <canvas ref={canvasRef} width={560} height={130}
            onMouseDown={startDraw} onMouseMove={draw} onMouseUp={endDraw} onMouseLeave={endDraw}
            onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={endDraw}
            style={{ border: "1px solid #E5E2DC", borderRadius: 8, background: "#FAFAF9", width: "100%", cursor: "crosshair", touchAction: "none" }}
          />
          {!hasDrawn && <span style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", fontSize: 13, color: "#D1D5DB", pointerEvents: "none" }}>Sign here</span>}
          {hasDrawn && <button onClick={clear} style={{ position: "absolute", top: 6, right: 6, fontSize: 11, color: "#9E9B94", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}>Clear</button>}
        </div>
      ) : (
        <input value={typedName} onChange={e => setTypedName(e.target.value)} placeholder="Type your full name"
          style={{ width: "100%", padding: "10px 14px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 20, fontFamily: "'Dancing Script', cursive, serif", color: "#1A1917", background: "#FAFAF9", boxSizing: "border-box" }}
        />
      )}
    </div>
  );
}

export default function SignDocPage() {
  const { token } = useParams<{ token: string }>();
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [checked, setChecked] = useState(false);
  const [signature, setSignature] = useState("");
  const [signerName, setSignerName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const { data, isLoading, error: fetchError } = useQuery({
    queryKey: ["sign-doc", token],
    queryFn: async () => {
      const r = await fetch(`${API}/api/document-requests/client-sign/${token}`);
      if (!r.ok) {
        const d = await r.json();
        throw Object.assign(new Error(d.error || "Error"), { status: r.status, company_name: d.company_name });
      }
      return r.json();
    },
    retry: false,
  });

  useEffect(() => {
    if (data?.client_name) setSignerName(data.client_name);
  }, [data?.client_name]);

  useEffect(() => {
    if (!bottomRef.current) return;
    const obs = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setScrolled(true); }, { threshold: 0.1 });
    obs.observe(bottomRef.current);
    return () => obs.disconnect();
  }, [data]);

  const canSubmit = scrolled && checked && signerName.trim() && (!data?.requires_signature || signature);

  const handleSubmit = async () => {
    setSubmitting(true); setError("");
    try {
      const r = await fetch(`${API}/api/document-requests/client-sign/${token}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signer_name: signerName,
          signer_email: data?.client_email,
          signature_data: signature || null,
          document_snapshot: data?.content || "",
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "Failed");
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const brand = data?.company_brand || "#00C9A0";
  const containerStyle: React.CSSProperties = {
    minHeight: "100vh", background: "#F7F6F3",
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    display: "flex", flexDirection: "column", alignItems: "center", padding: "24px 16px",
  };

  if (isLoading) return <div style={containerStyle}><p style={{ marginTop: 80, color: "#6B7280" }}>Loading...</p></div>;

  const err = fetchError as any;
  if (err || !data) {
    const isExpired = err?.status === 410;
    const companyName = err?.company_name || "the company";
    return (
      <div style={containerStyle}>
        <div style={{ width: "100%", maxWidth: 560, background: "#fff", border: "1px solid #E5E2DC", borderRadius: 16, padding: 40, textAlign: "center" }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1A1917", marginBottom: 12 }}>{isExpired ? "Link Expired" : "Not Found"}</h2>
          <p style={{ fontSize: 14, color: "#6B7280", lineHeight: 1.6 }}>
            {isExpired ? `This link has expired. Please contact ${companyName} to receive a new agreement.` : "This link could not be found."}
          </p>
        </div>
      </div>
    );
  }

  if (data.already_signed || done) {
    return (
      <div style={containerStyle}>
        <div style={{ width: "100%", maxWidth: 560, background: "#fff", border: "1px solid #E5E2DC", borderRadius: 16, padding: 48, textAlign: "center" }}>
          <div style={{ width: 56, height: 56, borderRadius: 28, background: brand + "20", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
            <Check size={28} color={brand}/>
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", marginBottom: 8 }}>
            {data.already_signed ? "Already Signed" : "Document Submitted"}
          </h2>
          <p style={{ fontSize: 14, color: "#6B7280", lineHeight: 1.6 }}>
            {data.already_signed ? "This agreement has already been signed." : `Your agreement has been submitted to ${data.company_name}.`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={{ width: "100%", maxWidth: 660, display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {data.company_logo && <img src={data.company_logo} style={{ height: 30, objectFit: "contain" }}/>}
          <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{data.company_name}</span>
        </div>
        <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 16, padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A1917", margin: 0 }}>{data.template_name}</h1>
          <div
            ref={contentRef}
            style={{ maxHeight: 440, overflowY: "auto", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 24px", background: "#FAFAF9", fontSize: 14, lineHeight: 1.7, color: "#374151" }}
          >
            <div dangerouslySetInnerHTML={{ __html: data.content }}/>
            <div ref={bottomRef} style={{ height: 1 }}/>
          </div>

          {data.requires_signature && (
            <div style={{ border: "1px solid #E5E2DC", borderRadius: 10, padding: 20 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1917", margin: "0 0 12px" }}>Signature</p>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", display: "block", marginBottom: 4 }}>Full Name</label>
                <input value={signerName} onChange={e => setSignerName(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 6, fontSize: 13, fontFamily: "'Plus Jakarta Sans', sans-serif", boxSizing: "border-box" }}
                />
              </div>
              <SignaturePad onSignature={(data, name) => { setSignature(data); if (name) setSignerName(name); }}/>
            </div>
          )}

          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}
              disabled={!scrolled}
              style={{ marginTop: 2, accentColor: "var(--brand, #00C9A0)", width: 16, height: 16, flexShrink: 0 }}
            />
            <span style={{ fontSize: 13, color: "#374151" }}>I have read and agree to this document.</span>
          </label>

          {!scrolled && <p style={{ fontSize: 12, color: "#9E9B94", textAlign: "center", margin: 0 }}>Please scroll to the bottom to continue.</p>}

          {error && <p style={{ fontSize: 12, color: "#DC2626", background: "#FEE2E2", borderRadius: 6, padding: "8px 12px", margin: 0 }}>{error}</p>}

          <button onClick={handleSubmit} disabled={!canSubmit || submitting}
            style={{ padding: "12px 24px", background: canSubmit ? "var(--brand, #00C9A0)" : "#E5E2DC", color: canSubmit ? "#fff" : "#9E9B94", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14, fontFamily: "'Plus Jakarta Sans', sans-serif", cursor: canSubmit ? "pointer" : "not-allowed" }}
          >
            {submitting ? "Submitting..." : "Submit Agreement"}
          </button>
        </div>
      </div>
    </div>
  );
}
