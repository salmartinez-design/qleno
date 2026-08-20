import { useState, useEffect, useRef } from "react";
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

// Used only when the form template carries no field schema of its own. These
// four keys match what the page pre-fills from the client record on load.
const FALLBACK_FIELDS = [
  { key: "full_name", label: "Full name", placeholder: "" },
  { key: "email", label: "Email", placeholder: "" },
  { key: "phone", label: "Phone", placeholder: "" },
  { key: "address", label: "Service address", placeholder: "" },
];

function ProgressBar({ step, total }: { step: number; total: number }) {
  return (
    <div style={{ display: "flex", gap: 0, margin: "0 0 28px" }}>
      {STEP_LABELS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <div key={i} style={{ flex: 1, display: "flex", alignItems: "center" }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: done ? "var(--brand)" : active ? "#EFEFF2" : "#F0EEE9", border: `2px solid ${done || active ? "var(--brand)" : "#E5E2DC"}`, transition: "all 0.2s" }}>
                {done ? <Check size={15} color="#fff" /> : <span style={{ fontSize: 13, fontWeight: 700, color: active ? "var(--brand)" : "#9E9B94" }}>{i + 1}</span>}
              </div>
              <div style={{ fontSize: 11, fontWeight: active ? 700 : 500, color: active ? "var(--brand)" : done ? "#1A1917" : "#9E9B94", textAlign: "center", whiteSpace: "nowrap" }}>{label}</div>
            </div>
            {i < total - 1 && (
              <div style={{ height: 2, flex: 0.4, background: done ? "var(--brand)" : "#E5E2DC", marginBottom: 22, transition: "all 0.2s" }} />
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
  // [agreement-scroll-gate 2026-08-19] "I have read this agreement" used to be
  // clickable the instant the page loaded, with the contract still scrolled to
  // its first line. That is the sentence a customer disputes later, and there
  // was nothing on our side to say they had ever seen past the header. The
  // button now waits until the text has actually been scrolled to the end.
  const termsRef = useRef<HTMLDivElement | null>(null);
  const [readToEnd, setReadToEnd] = useState(false);

  // A short agreement that fits without a scrollbar can never fire a scroll
  // event, so measure on mount too - otherwise the gate becomes a dead end.
  const checkReadToEnd = () => {
    const el = termsRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 24) setReadToEnd(true);
  };

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
        body: JSON.stringify({ responses, signature_name: signatureName, ip_address: "client", agreed }),
      });
      setSuccess(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // [agreement-brand 2026-08-19] This page is where a customer signs a
  // contract, and it was the least branded surface we own: a generic file
  // icon in a pill, the literal word "Qleno" whenever the company name was
  // missing, and a vendor credit in the footer. It now carries the tenant's
  // own logo over a brand rule and closes with their phone and email, the
  // same chrome as the agreement email that brought the customer here.
  const brand = data?.company_brand || "var(--brand)";
  const companyName = data?.company_name || "";
  const formName = data?.form_name || "Service Agreement";
  const companyPhone = data?.company_phone || "";
  const companyEmail = data?.company_email || "";
  const rawLogo = data?.company_logo || "";
  const logoSrc = rawLogo
    ? (/^https?:/i.test(rawLogo) ? rawLogo : `${API}${rawLogo.startsWith("/") ? "" : "/"}${rawLogo}`)
    : "";
  const schema = Array.isArray(data?.form_schema) ? data.form_schema : [];
  const fields = schema.filter((f: any) => f.type !== "section");
  const termsBody = data?.terms_body || "";

  // Runs once the agreement text is in the DOM. Declared before the loading and
  // error returns so the hook order never changes between renders.
  //
  // [agreement-scroll-gate 2026-08-19] Measuring only once, right here, is too
  // early: the webfont and the letterhead image both land after this effect
  // runs, so the box is still taller than its content at this moment. A short
  // agreement therefore fails the check, then has nothing to scroll and so
  // never fires a scroll event either - the customer is left staring at a
  // permanently disabled button on the page where they are meant to sign.
  // Caught in preview on a three-section agreement. Re-measure on the next
  // frame, once the fonts have settled, and on any later layout change.
  useEffect(() => {
    const el = termsRef.current;
    if (!el) return;
    checkReadToEnd();
    const raf = requestAnimationFrame(checkReadToEnd);
    const ro = new ResizeObserver(checkReadToEnd);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    (document as any).fonts?.ready?.then(checkReadToEnd).catch(() => {});
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [termsBody, step]);

  // Logo over a brand rule, exactly like the email header. Falls back to the
  // company name set in type when the tenant has not uploaded a mark, and to
  // nothing at all rather than printing a placeholder at a customer.
  const Letterhead = ({ caption }: { caption?: string }) => (
    <div style={{ textAlign: "center", marginBottom: 28 }}>
      <div style={{ display: "inline-block", background: "#fff", border: "1px solid #E5E2DC", borderBottom: `3px solid ${brand}`, borderRadius: "12px 12px 4px 4px", padding: "18px 34px 14px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
        {logoSrc
          ? <img src={logoSrc} alt={companyName} style={{ display: "block", height: 54, width: "auto", maxWidth: 200, margin: "0 auto" }} />
          : companyName
            ? <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: "0.02em", color: "#1A1917" }}>{companyName}</div>
            : <FileText size={26} color={brand} style={{ display: "block", margin: "0 auto" }} />}
      </div>
      {caption && (
        <div style={{ fontSize: 12, letterSpacing: "0.09em", textTransform: "uppercase", fontWeight: 600, color: "#6B6860", marginTop: 14 }}>{caption}</div>
      )}
    </div>
  );

  // Navy contact band, same as the email footer. A customer with a question
  // about what they are signing should not have to go looking for a number.
  const ContactFooter = ({ heading = "Questions before you sign?" }: { heading?: string }) => (
    <div style={{ marginTop: 26 }}>
      {(companyPhone || companyEmail) && (
        <div style={{ background: "#0A0E1A", borderRadius: 12, padding: "20px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 6 }}>{heading}</div>
          <div style={{ fontSize: 13, color: "#9DA3B0", lineHeight: 1.8 }}>
            {companyPhone && <a href={`tel:${companyPhone.replace(/[^0-9+]/g, "")}`} style={{ color: "#9DA3B0", textDecoration: "none" }}>{companyPhone}</a>}
            {companyPhone && companyEmail && <span>&nbsp;&middot;&nbsp;</span>}
            {companyEmail && <a href={`mailto:${companyEmail}`} style={{ color: "#9DA3B0", textDecoration: "none" }}>{companyEmail}</a>}
          </div>
        </div>
      )}
      <div style={{ textAlign: "center", marginTop: 16, fontSize: 11, color: "#9E9B94", display: "flex", alignItems: "flex-start", justifyContent: "center", gap: 5, lineHeight: 1.6 }}>
        <Shield size={12} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>Signed electronically. Legally binding under the federal E-SIGN Act and the Illinois Uniform Electronic Transactions Act.</span>
      </div>
    </div>
  );

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ textAlign: "center", color: "#6B6860" }}>
        <FileText size={40} color="#E5E2DC" style={{ margin: "0 auto 12px", display: "block" }} />
        <div style={{ fontSize: 14 }}>Loading agreement...</div>
      </div>
    </div>
  );

  if (error && !success) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ textAlign: "center", maxWidth: 380, padding: 32 }}>
        <div style={{ width: 60, height: 60, borderRadius: "50%", background: "#FCEBEA", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          <AlertCircle size={28} color="#B3261E" />
        </div>
        <div style={{ fontWeight: 700, fontSize: 18, color: "#1A1917", marginBottom: 8 }}>Link Not Available</div>
        <div style={{ fontSize: 14, color: "#6B6860", lineHeight: 1.6 }}>{error}</div>
      </div>
    </div>
  );

  if (data?.already_signed || success) return (
    <div style={{ minHeight: "100vh", background: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif", padding: "28px 16px 60px" }}>
      <div style={{ maxWidth: 460, margin: "0 auto", textAlign: "center" }}>
        <Letterhead />
        <div style={{ width: 72, height: 72, borderRadius: "50%", background: "#D1FAE5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <Check size={36} color="#065F46" />
        </div>
        <div style={{ fontWeight: 800, fontSize: 22, color: "#1A1917", marginBottom: 10 }}>Agreement signed</div>
        <div style={{ fontSize: 14, color: "#6B6860", lineHeight: 1.7, marginBottom: 24 }}>
          {data?.already_signed
            ? "This agreement has already been signed and is on file."
            : `Thank you, ${success?.signature_name || signatureName}. Your signed agreement is on file and a copy is on its way to your email.`}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          {/* [agreement-signed-copy 2026-08-19] Points at the route that renders
              from the database, not at pdf_url. pdf_url is a file on the
              server's disk that is gone after the next deploy, so anyone who
              bookmarked this button got a 404 within days. */}
          <a href={`${API}/api/sign/${token}/agreement.pdf`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, background: brand, color: "#fff", padding: "10px 24px", borderRadius: 8, textDecoration: "none", fontWeight: 600, fontSize: 14 }}>
            <FileText size={16} /> Download signed copy
          </a>
          <a href={`${API}/api/sign/${token}/certificate.pdf`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#fff", color: "#1A1917", border: "1px solid #E5E2DC", padding: "10px 24px", borderRadius: 8, textDecoration: "none", fontWeight: 600, fontSize: 14 }}>
            <Shield size={16} /> Certificate of Completion
          </a>
        </div>
        <ContactFooter heading="Questions about your agreement?" />
      </div>
    </div>
  );

  const inputStyle: React.CSSProperties = { width: "100%", padding: "11px 14px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 14, fontFamily: "'Plus Jakarta Sans', sans-serif", boxSizing: "border-box", outline: "none" };
  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "#1A1917", display: "block", marginBottom: 6 };

  return (
    <div style={{ minHeight: "100vh", background: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif", padding: "20px 16px 60px" }}>
      <div style={{ maxWidth: 660, margin: "0 auto" }}>
        <Letterhead caption={formName} />

        <ProgressBar step={step} total={3} />

        <div style={{ background: "#fff", borderRadius: 14, boxShadow: "0 2px 20px rgba(0,0,0,0.07)", overflow: "hidden" }}>
          {step === 0 && (
            <div>
              <div style={{ background: brand, padding: "20px 28px" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>{formName}</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", marginTop: 4 }}>Please read the entire agreement before continuing</div>
              </div>
              {/* [agreement-brand 2026-08-19] Set as a document, not as app
                  copy. A contract read in the same 13.5px sans the rest of the
                  UI uses does not read as something you are about to be bound
                  by. Serif, wider leading, and a paper edge inside the card. */}
              <div ref={termsRef} onScroll={checkReadToEnd} style={{ padding: "30px 34px", maxHeight: "52vh", overflowY: "auto", background: "#FCFBF9", borderBottom: "1px solid #EDEAE4" }}>
                {termsBody ? (
                  <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 14.5, color: "#26241F", lineHeight: 1.9, whiteSpace: "pre-line" }}>{termsBody}</div>
                ) : (
                  <div style={{ color: "#9E9B94", fontSize: 13 }}>No terms body provided for this template.</div>
                )}
              </div>
              <div style={{ padding: "20px 32px", borderTop: "1px solid #F5F4F2", background: "#F7F6F3" }}>
                <button onClick={() => setStep(1)} disabled={!readToEnd} style={{ width: "100%", padding: "13px", background: brand, color: "#fff", border: "none", borderRadius: 9, fontWeight: 700, fontSize: 15, cursor: readToEnd ? "pointer" : "not-allowed", opacity: readToEnd ? 1 : 0.55, fontFamily: "'Plus Jakarta Sans', sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  I have read this agreement <ChevronRight size={18} />
                </button>
                {!readToEnd && (
                  <div style={{ fontSize: 12.5, color: "#6B6860", textAlign: "center", marginTop: 10 }}>
                    Scroll to the end of the agreement to continue
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 1 && (
            <div>
              <div style={{ padding: "22px 28px", borderBottom: "1px solid #F5F4F2" }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#1A1917" }}>Your Information</div>
                <div style={{ fontSize: 13, color: "#6B6860", marginTop: 3 }}>Please verify or complete your details below</div>
              </div>
              <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
                {/* [agreement-blank-step 2026-08-19] The commercial agreement
                    template was seeded with terms but no field schema, so this
                    step rendered as an empty white gap under the words "Please
                    verify or complete your details below" - nothing to verify,
                    and no sign that anything was missing. Fall back to the
                    details we already hold for the client so the step still
                    does what it says. */}
                {fields.length === 0 && (
                  FALLBACK_FIELDS.map(f => (
                    <div key={f.key}>
                      <label style={labelStyle}>{f.label}</label>
                      <input type="text" value={responses[f.key] || ""} onChange={e => setResponses(prev => ({ ...prev, [f.key]: e.target.value }))} style={inputStyle} placeholder={f.placeholder} />
                    </div>
                  ))
                )}
                {fields.map((field: any) => (
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
                <button onClick={() => setStep(0)} style={{ flex: 1, padding: "11px", background: "none", border: "1px solid #E5E2DC", borderRadius: 9, fontWeight: 600, fontSize: 14, cursor: "pointer", color: "#6B6860", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
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
                <div style={{ fontSize: 13, color: "#6B6860", marginTop: 3 }}>By typing your full name below, you agree to the terms of this agreement</div>
              </div>
              <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
                <div style={{ background: "#F7F6F3", borderRadius: 10, padding: "14px 18px", fontSize: 12, color: "#6B6860", lineHeight: 1.7 }}>
                  By signing below, you confirm that you have read, understood, and agree to the full terms of this service agreement with <strong>{companyName}</strong>.
                </div>

                <div>
                  <label style={labelStyle}>Type your full name to sign <span style={{ color: "#E53E3E" }}>*</span></label>
                  <input
                    value={signatureName}
                    onChange={e => setSignatureName(e.target.value)}
                    placeholder="Type your full legal name here"
                    style={{ ...inputStyle, fontSize: 16, fontFamily: "Georgia, serif", borderColor: signatureName ? brand : "#E5E2DC" }}
                    autoFocus
                  />
                  {signatureName && (
                    <div style={{ marginTop: 8, padding: "10px 14px", background: "#EFEFF2", borderRadius: 7, display: "flex", alignItems: "center", gap: 8 }}>
                      <Check size={14} color="var(--brand)" />
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--brand)" }}>Signature Preview</div>
                        <div style={{ fontSize: 14, fontFamily: "Georgia, serif", color: "#1A1917" }}>{signatureName}</div>
                      </div>
                    </div>
                  )}
                </div>

                <label style={{ display: "flex", gap: 10, cursor: "pointer", alignItems: "flex-start" }}>
                  <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: 3 }} />
                  <span style={{ fontSize: 13, color: "#1A1917", lineHeight: 1.6 }}>
                    I confirm that I am <strong>{signatureName || "the authorized signer"}</strong> and I agree to the terms of this service agreement. I understand this constitutes a legally binding electronic signature.
                  </span>
                </label>

                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#9E9B94" }}>
                  <Shield size={12} />
                  Your signature is timestamped, IP-logged, and verified with SHA-256 hash.
                </div>
              </div>

              <div style={{ padding: "16px 28px", borderTop: "1px solid #F5F4F2", display: "flex", gap: 10 }}>
                <button onClick={() => setStep(1)} style={{ flex: 1, padding: "11px", background: "none", border: "1px solid #E5E2DC", borderRadius: 9, fontWeight: 600, fontSize: 14, cursor: "pointer", color: "#6B6860", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
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

        <ContactFooter />
      </div>
    </div>
  );
}
