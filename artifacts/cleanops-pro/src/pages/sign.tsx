import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { Check, AlertCircle, Clock, FileText, ChevronRight, ChevronLeft, Shield } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function publicFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...opts });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error || "Error");
  return json;
}

const STEP_LABELS = ["Review Agreement", "Your Information", "Sign & Submit"];

function ProgressBar({ step, total }: { step: number; total: number }) {
  return (
    <div style={{ display: "flex", gap: 0, margin: "0 0 28px" }}>
      {STEP_LABELS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <div key={i} style={{ flex: 1, display: "flex", alignItems: "center" }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: done ? "#5B9BD5" : active ? "#EFF6FF" : "#F3F4F6", border: `2px solid ${done || active ? "#5B9BD5" : "#E5E2DC"}`, transition: "all 0.2s" }}>
                {done ? <Check size={15} color="#fff" /> : <span style={{ fontSize: 13, fontWeight: 700, color: active ? "#5B9BD5" : "#9E9B94" }}>{i + 1}</span>}
              </div>
              <div style={{ fontSize: 11, fontWeight: active ? 700 : 500, color: active ? "#5B9BD5" : done ? "#1A1917" : "#9E9B94", textAlign: "center", whiteSpace: "nowrap" }}>{label}</div>
            </div>
            {i < total - 1 && (
              <div style={{ height: 2, flex: 0.4, background: done ? "#5B9BD5" : "#E5E2DC", marginBottom: 22, transition: "all 0.2s" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function SignPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [signatureName, setSignatureName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<any | null>(null);

  useEffect(() => {
    if (!token) return;
    publicFetch(`/api/sign/${token}`)
      .then(d => {
        setData(d);
        if (d.client_first || d.client_last) {
          const name = [d.client_first, d.client_last].filter(Boolean).join(" ");
          setSignatureName(name);
          setResponses(prev => ({ ...prev, full_name: name, email: d.client_email || "", phone: d.client_phone || "", address: d.client_address || "" }));
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  const handleSubmit = async () => {
    if (!signatureName.trim()) return;
    setSubmitting(true);
    try {
      const result = await publicFetch(`/api/sign/${token}`, {
        method: "POST",
        body: JSON.stringify({ responses, signature_name: signatureName, ip_address: "client" }),
      });
      setSuccess(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const brand = data?.company_brand || "#5B9BD5";
  const companyName = data?.company_name || "Qleno";
  const formName = data?.form_name || "Service Agreement";
  const schema = Array.isArray(data?.form_schema) ? data.form_schema : [];
  const termsBody = data?.terms_body || "";

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ textAlign: "center", color: "#6B7280" }}>
        <FileText size={40} color="#D1D5DB" style={{ margin: "0 auto 12px", display: "block" }} />
        <div style={{ fontSize: 14 }}>Loading agreement...</div>
      </div>
    </div>
  );

  if (error && !success) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ textAlign: "center", maxWidth: 380, padding: 32 }}>
        <div style={{ width: 60, height: 60, borderRadius: "50%", background: "#FEE2E2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          <AlertCircle size={28} color="#DC2626" />
        </div>
        <div style={{ fontWeight: 700, fontSize: 18, color: "#1A1917", marginBottom: 8 }}>Link Not Available</div>
        <div style={{ fontSize: 14, color: "#6B7280", lineHeight: 1.6 }}>{error}</div>
      </div>
    </div>
  );

  if (data?.already_signed || success) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ textAlign: "center", maxWidth: 420, padding: 32 }}>
        <div style={{ width: 72, height: 72, borderRadius: "50%", background: "#D1FAE5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <Check size={36} color="#065F46" />
        </div>
        <div style={{ fontWeight: 800, fontSize: 22, color: "#1A1917", marginBottom: 10 }}>Agreement Signed!</div>
        <div style={{ fontSize: 14, color: "#6B7280", lineHeight: 1.7, marginBottom: 24 }}>
          {data?.already_signed
            ? "This agreement has already been signed."
            : `Thank you, ${success?.signature_name || signatureName}. Your signed agreement has been recorded.`}
        </div>
        {(success?.pdf_url || data?.pdf_url) && (
          <a href={success?.pdf_url || data?.pdf_url} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, background: brand, color: "#fff", padding: "10px 24px", borderRadius: 8, textDecoration: "none", fontWeight: 600, fontSize: 14 }}>
            <FileText size={16} /> Download Signed Copy
          </a>
        )}
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, color: "#9E9B94" }}>
          <Shield size={13} /> Secured by Qleno eSign
        </div>
      </div>
    </div>
  );

  const inputStyle: React.CSSProperties = { width: "100%", padding: "11px 14px", border: "1px solid #D1D5DB", borderRadius: 8, fontSize: 14, fontFamily: "'Plus Jakarta Sans', sans-serif", boxSizing: "border-box", outline: "none" };
  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 };

  return (
    <div style={{ minHeight: "100vh", background: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif", padding: "20px 16px 60px" }}>
      <div style={{ maxWidth: 660, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, background: "#fff", padding: "10px 20px", borderRadius: 40, border: "1px solid #E5E2DC", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
            <div style={{ width: 32, height: 32, borderRadius: "50%", background: brand, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <FileText size={16} color="#fff" />
            </div>
            <span style={{ fontWeight: 700, fontSize: 15, color: "#1A1917" }}>{companyName}</span>
          </div>
          <div style={{ fontSize: 13, color: "#9E9B94", marginTop: 10 }}>{formName}</div>
        </div>

        <ProgressBar step={step} total={3} />

        <div style={{ background: "#fff", borderRadius: 14, boxShadow: "0 2px 20px rgba(0,0,0,0.07)", overflow: "hidden" }}>
          {step === 0 && (
            <div>
              <div style={{ background: brand, padding: "20px 28px" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>{formName}</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", marginTop: 4 }}>Please read the entire agreement before continuing</div>
              </div>
              <div style={{ padding: "28px 32px", maxHeight: "50vh", overflowY: "auto" }}>
                {termsBody ? (
                  <div style={{ fontSize: 13.5, color: "#374151", lineHeight: 1.8, whiteSpace: "pre-line" }}>{termsBody}</div>
                ) : (
                  <div style={{ color: "#9E9B94", fontSize: 13 }}>No terms body provided for this template.</div>
                )}
              </div>
              <div style={{ padding: "20px 32px", borderTop: "1px solid #F5F4F2", background: "#F9FAFB" }}>
                <button onClick={() => setStep(1)} style={{ width: "100%", padding: "13px", background: brand, color: "#fff", border: "none", borderRadius: 9, fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  I have read this agreement <ChevronRight size={18} />
                </button>
              </div>
            </div>
          )}

          {step === 1 && (
            <div>
              <div style={{ padding: "22px 28px", borderBottom: "1px solid #F5F4F2" }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#1A1917" }}>Your Information</div>
                <div style={{ fontSize: 13, color: "#6B7280", marginTop: 3 }}>Please verify or complete your details below</div>
              </div>
              <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
                {schema.filter((f: any) => f.type !== "section").map((field: any) => (
                  <div key={field.id}>
                    <label style={labelStyle}>{field.label} {field.required && <span style={{ color: "#E53E3E" }}>*</span>}</label>
                    {field.type === "select" ? (
                      <select value={responses[field.variable || field.id] || ""} onChange={e => setResponses(prev => ({ ...prev, [field.variable || field.id]: e.target.value }))} style={inputStyle}>
                        <option value="">Select...</option>
                        {(field.options || []).map((o: string) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : field.type === "textarea" ? (
                      <textarea value={responses[field.variable || field.id] || ""} onChange={e => setResponses(prev => ({ ...prev, [field.variable || field.id]: e.target.value }))} style={{ ...inputStyle, resize: "vertical" }} rows={3} placeholder={field.placeholder} />
                    ) : (
                      <input type={field.type || "text"} value={responses[field.variable || field.id] || ""} onChange={e => setResponses(prev => ({ ...prev, [field.variable || field.id]: e.target.value }))} style={inputStyle} placeholder={field.placeholder} />
                    )}
                  </div>
                ))}
              </div>
              <div style={{ padding: "16px 28px", borderTop: "1px solid #F5F4F2", display: "flex", gap: 10 }}>
                <button onClick={() => setStep(0)} style={{ flex: 1, padding: "11px", background: "none", border: "1px solid #E5E2DC", borderRadius: 9, fontWeight: 600, fontSize: 14, cursor: "pointer", color: "#6B7280", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                  <ChevronLeft size={16} /> Back
                </button>
                <button onClick={() => setStep(2)} style={{ flex: 2, padding: "11px", background: brand, color: "#fff", border: "none", borderRadius: 9, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                  Continue <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <div style={{ padding: "22px 28px", borderBottom: "1px solid #F5F4F2" }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#1A1917" }}>Sign the Agreement</div>
                <div style={{ fontSize: 13, color: "#6B7280", marginTop: 3 }}>By typing your full name below, you agree to the terms of this agreement</div>
              </div>
              <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
                <div style={{ background: "#F7F6F3", borderRadius: 10, padding: "14px 18px", fontSize: 12, color: "#6B7280", lineHeight: 1.7 }}>
                  By signing below, you confirm that you have read, understood, and agree to the full terms of this service agreement with <strong>{companyName}</strong>.
                </div>

                <div>
                  <label style={labelStyle}>Type your full name to sign <span style={{ color: "#E53E3E" }}>*</span></label>
                  <input
                    value={signatureName}
                    onChange={e => setSignatureName(e.target.value)}
                    placeholder="Type your full legal name here"
                    style={{ ...inputStyle, fontSize: 16, fontFamily: "Georgia, serif", borderColor: signatureName ? brand : "#D1D5DB" }}
                    autoFocus
                  />
                  {signatureName && (
                    <div style={{ marginTop: 8, padding: "10px 14px", background: "#EFF6FF", borderRadius: 7, display: "flex", alignItems: "center", gap: 8 }}>
                      <Check size={14} color="#5B9BD5" />
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#5B9BD5" }}>Signature Preview</div>
                        <div style={{ fontSize: 14, fontFamily: "Georgia, serif", color: "#1A1917" }}>{signatureName}</div>
                      </div>
                    </div>
                  )}
                </div>

                <label style={{ display: "flex", gap: 10, cursor: "pointer", alignItems: "flex-start" }}>
                  <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: 3 }} />
                  <span style={{ fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
                    I confirm that I am <strong>{signatureName || "the authorized signer"}</strong> and I agree to the terms of this service agreement. I understand this constitutes a legally binding electronic signature.
                  </span>
                </label>

                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#9E9B94" }}>
                  <Shield size={12} />
                  Your signature is timestamped, IP-logged, and verified with SHA-256 hash.
                </div>
              </div>

              <div style={{ padding: "16px 28px", borderTop: "1px solid #F5F4F2", display: "flex", gap: 10 }}>
                <button onClick={() => setStep(1)} style={{ flex: 1, padding: "11px", background: "none", border: "1px solid #E5E2DC", borderRadius: 9, fontWeight: 600, fontSize: 14, cursor: "pointer", color: "#6B7280", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                  <ChevronLeft size={16} /> Back
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!signatureName.trim() || !agreed || submitting}
                  style={{ flex: 2, padding: "13px", background: brand, color: "#fff", border: "none", borderRadius: 9, fontWeight: 700, fontSize: 15, cursor: submitting || !agreed ? "not-allowed" : "pointer", fontFamily: "'Plus Jakarta Sans', sans-serif", opacity: (!signatureName.trim() || !agreed || submitting) ? 0.6 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  {submitting ? "Processing..." : <><Check size={16} /> Sign &amp; Submit</>}
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 11, color: "#9E9B94", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
          <Shield size={12} /> Secured by Qleno · Electronic signature compliant with E-SIGN Act &amp; UETA
        </div>
      </div>
    </div>
  );
}
