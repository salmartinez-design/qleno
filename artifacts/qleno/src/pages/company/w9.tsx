import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { FileText, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";
const INK = "#1A1917", MUTE = "#6B6860", BORDER = "#E5E2DC";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...(getAuthHeaders() as Record<string, string>), "Content-Type": "application/json", ...opts.headers } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const CLASSES = [
  ["individual", "Individual / sole proprietor"], ["c_corp", "C corporation"], ["s_corp", "S corporation"],
  ["partnership", "Partnership"], ["trust", "Trust / estate"], ["llc", "LLC"], ["other", "Other"],
] as const;

const inp: React.CSSProperties = { width: "100%", padding: "9px 11px", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, fontFamily: FF, background: "#fff", boxSizing: "border-box", color: INK };
const lbl: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 };

export default function CompanyW9Page() {
  const [f, setF] = useState<any>({ w9_legal_name: "", w9_business_name: "", w9_classification: "llc", w9_llc_class: "", w9_ein: "", w9_exempt_payee_code: "", w9_fatca_code: "" });
  const [company, setCompany] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dl, setDl] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const c = await apiFetch("/api/companies/me");
        setCompany(c);
        setF({
          w9_legal_name: c.w9_legal_name || c.invoice_business_name || c.name || "",
          w9_business_name: c.w9_business_name || "",
          w9_classification: c.w9_classification || "llc",
          w9_llc_class: c.w9_llc_class || "",
          w9_ein: c.w9_ein || "",
          w9_exempt_payee_code: c.w9_exempt_payee_code || "",
          w9_fatca_code: c.w9_fatca_code || "",
        });
      } catch { toast.error("Couldn't load company info"); }
      finally { setLoading(false); }
    })();
  }, []);

  const set = (k: string, v: string) => setF((p: any) => ({ ...p, [k]: v }));

  async function save() {
    setSaving(true);
    try { await apiFetch("/api/companies/w9", { method: "PUT", body: JSON.stringify(f) }); toast.success("W-9 info saved"); }
    catch { toast.error("Couldn't save"); }
    finally { setSaving(false); }
  }

  async function download() {
    setDl(true);
    try {
      await save();
      const r = await fetch(`${API}/api/companies/w9.pdf`, { headers: { ...(getAuthHeaders() as Record<string, string>) } });
      if (r.status === 422) { toast.error("Enter your EIN first."); return; }
      if (!r.ok) throw new Error();
      const url = URL.createObjectURL(await r.blob());
      const w = window.open(url, "_blank");
      if (!w) { const a = document.createElement("a"); a.href = url; a.download = "W-9.pdf"; a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast.error("Couldn't generate the W-9"); }
    finally { setDl(false); }
  }

  const addr = company ? [company.address, [company.city, company.state, company.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";

  if (loading) return <DashboardLayout><div style={{ padding: 40, textAlign: "center", color: MUTE, fontFamily: FF }}><Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} /></div></DashboardLayout>;

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 620, fontFamily: FF }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <FileText size={20} style={{ color: INK }} />
          <h1 style={{ fontSize: 22, fontWeight: 700, color: INK, margin: 0 }}>Company W-9</h1>
        </div>
        <p style={{ fontSize: 13, color: MUTE, margin: "0 0 20px", lineHeight: 1.6 }}>Save your tax info once. Qleno fills the official IRS Form W-9 so you can download and send it to clients who request one. Sign it after downloading.</p>

        <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20 }}>
          <div style={{ marginBottom: 14 }}><span style={lbl}>Legal name (line 1)</span><input style={inp} value={f.w9_legal_name} onChange={e => set("w9_legal_name", e.target.value)} placeholder="Phes Cleaning LLC" /></div>
          <div style={{ marginBottom: 14 }}><span style={lbl}>Business / DBA name (line 2, optional)</span><input style={inp} value={f.w9_business_name} onChange={e => set("w9_business_name", e.target.value)} placeholder="Phes" /></div>
          <div style={{ display: "grid", gridTemplateColumns: f.w9_classification === "llc" ? "2fr 1fr" : "1fr", gap: 12, marginBottom: 14 }}>
            <div>
              <span style={lbl}>Federal tax classification</span>
              <select style={inp} value={f.w9_classification} onChange={e => set("w9_classification", e.target.value)}>
                {CLASSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            {f.w9_classification === "llc" && (
              <div><span style={lbl}>LLC tax class</span>
                <select style={inp} value={f.w9_llc_class} onChange={e => set("w9_llc_class", e.target.value)}>
                  <option value="">—</option><option value="C">C</option><option value="S">S</option><option value="P">P</option>
                </select>
              </div>
            )}
          </div>
          <div style={{ marginBottom: 14 }}><span style={lbl}>EIN (employer identification number)</span><input style={inp} value={f.w9_ein} onChange={e => set("w9_ein", e.target.value)} placeholder="12-3456789" /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            <div><span style={lbl}>Exempt payee code (optional)</span><input style={inp} value={f.w9_exempt_payee_code} onChange={e => set("w9_exempt_payee_code", e.target.value)} /></div>
            <div><span style={lbl}>FATCA code (optional)</span><input style={inp} value={f.w9_fatca_code} onChange={e => set("w9_fatca_code", e.target.value)} /></div>
          </div>
          <div style={{ background: "#F8F7F4", borderRadius: 9, padding: "10px 12px", marginBottom: 18 }}>
            <span style={lbl}>Address (from your company profile)</span>
            <div style={{ fontSize: 13, color: addr ? INK : "#B3261E" }}>{addr || "No company address set — add one in company settings."}</div>
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={save} disabled={saving} style={{ padding: "9px 16px", border: `1px solid ${BORDER}`, borderRadius: 9, fontSize: 13, fontWeight: 700, background: "#fff", cursor: "pointer", fontFamily: FF }}>{saving ? "Saving…" : "Save"}</button>
            <button onClick={download} disabled={dl} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", background: INK, color: "#fff", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}><Download size={15} /> {dl ? "Preparing…" : "Download W-9"}</button>
          </div>
        </div>
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </DashboardLayout>
  );
}
