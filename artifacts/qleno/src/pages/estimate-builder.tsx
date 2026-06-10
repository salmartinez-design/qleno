import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Plus, Trash2, ArrowLeft, Save, Send, LayoutTemplate, GripVertical } from "lucide-react";
import { toast } from "sonner";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const INK = "#1A1917";
const MUTE = "#6B7280";
const BORDER = "#E5E2DC";
const MINT = "#00C9A0";

async function apiFetch(path: string, opts: { method?: string; body?: any } = {}) {
  const { body, ...rest } = opts;
  const r = await fetch(`${API}${path}`, {
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    ...rest,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type PricingType = "flat" | "hourly" | "one_time";
interface Item {
  name: string;
  pricing_type: PricingType;
  frequency: string;
  quantity: string;
  unit_rate: string;
}

const TYPE_LABELS: Record<PricingType, { type: string; qty: string; rate: string }> = {
  flat: { type: "Flat / recurring", qty: "Qty", rate: "Price" },
  hourly: { type: "Hourly", qty: "Hours", rate: "$/hr" },
  one_time: { type: "One-time", qty: "Qty", rate: "Price" },
};
const FREQUENCY_OPTIONS = ["Daily", "5x/week", "3x/week", "2x/week", "Weekly", "Bi-weekly", "Monthly", "One-time"];

const blankItem = (): Item => ({ name: "", pricing_type: "flat", frequency: "Monthly", quantity: "1", unit_rate: "" });

function lineAmount(it: Item): number {
  return Math.round((Number(it.quantity) || 0) * (Number(it.unit_rate) || 0) * 100) / 100;
}

export default function EstimateBuilderPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/estimates/:id");
  const routeId = params?.id ?? "new";
  const isNew = routeId === "new";
  const estimateId = isNew ? null : parseInt(routeId, 10);

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [id, setId] = useState<number | null>(estimateId);
  const [status, setStatus] = useState("draft");
  const [estimateNumber, setEstimateNumber] = useState<string>("");
  const [publicToken, setPublicToken] = useState<string | null>(null);

  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [serviceAddress, setServiceAddress] = useState("");
  const [title, setTitle] = useState("");
  const [introNote, setIntroNote] = useState("");
  const [terms, setTerms] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [discount, setDiscount] = useState("0");
  const [validUntil, setValidUntil] = useState("");
  const [items, setItems] = useState<Item[]>([blankItem()]);

  // Load existing estimate, or seed a new one from a template (?template=id).
  useEffect(() => {
    (async () => {
      try {
        if (!isNew && estimateId) {
          const e = await apiFetch(`/api/estimates/${estimateId}`);
          setStatus(e.status); setEstimateNumber(e.estimate_number || "");
          setPublicToken(e.public_token || null);
          setContactName(e.contact_name || ""); setContactEmail(e.contact_email || ""); setContactPhone(e.contact_phone || "");
          setPropertyName(e.property_name || ""); setServiceAddress(e.service_address || "");
          setTitle(e.title || ""); setIntroNote(e.intro_note || ""); setTerms(e.terms || ""); setInternalNotes(e.internal_notes || "");
          setDiscount(String(e.discount_amount ?? "0"));
          setValidUntil(e.valid_until ? String(e.valid_until).slice(0, 10) : "");
          setItems((e.items || []).length ? e.items.map(mapRow) : [blankItem()]);
        } else {
          const templateId = new URLSearchParams(window.location.search).get("template");
          if (templateId) {
            const t = await apiFetch(`/api/estimates/templates/${templateId}`);
            setTitle(t.title || ""); setIntroNote(t.intro_note || ""); setTerms(t.terms || "");
            setItems((t.items || []).length ? t.items.map(mapRow) : [blankItem()]);
          }
        }
      } catch {
        toast.error("Failed to load estimate");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subtotal = useMemo(() => items.reduce((s, it) => s + lineAmount(it), 0), [items]);
  const total = Math.max(0, subtotal - (Number(discount) || 0));

  const body = () => ({
    contact_name: contactName, contact_email: contactEmail, contact_phone: contactPhone,
    property_name: propertyName, service_address: serviceAddress,
    title, intro_note: introNote, terms, internal_notes: internalNotes,
    discount_amount: Number(discount) || 0,
    valid_until: validUntil || null,
    items: items.filter(it => it.name.trim() || Number(it.unit_rate) > 0).map(it => ({
      name: it.name, pricing_type: it.pricing_type, frequency: it.frequency,
      quantity: Number(it.quantity) || 0, unit_rate: Number(it.unit_rate) || 0,
    })),
  });

  async function save(): Promise<number | null> {
    setSaving(true);
    try {
      if (id) {
        await apiFetch(`/api/estimates/${id}`, { method: "PATCH", body: body() });
        toast.success("Estimate saved");
        return id;
      } else {
        const r = await apiFetch("/api/estimates", { method: "POST", body: body() });
        setId(r.id);
        window.history.replaceState(null, "", `${API}/estimates/${r.id}`);
        toast.success("Estimate created");
        return r.id;
      }
    } catch {
      toast.error("Failed to save");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveAsTemplate() {
    const savedId = id || (await save());
    if (!savedId) return;
    const name = prompt("Template name (e.g. 'Condo common areas — 2x/week'):");
    if (!name) return;
    try {
      await apiFetch(`/api/estimates/${savedId}/save-as-template`, { method: "POST", body: { name } });
      toast.success("Saved as template");
    } catch {
      toast.error("Failed to save template");
    }
  }

  function publicLink(token: string) {
    return `${window.location.origin}${API}/estimate/${token}`;
  }

  async function markSent() {
    const savedId = id || (await save());
    if (!savedId) return;
    try {
      const r = await apiFetch(`/api/estimates/${savedId}/send`, { method: "POST" });
      setStatus("sent");
      setPublicToken(r.public_token || null);
      if (r.public_token) {
        try {
          await navigator.clipboard.writeText(publicLink(r.public_token));
          toast.success("Estimate link copied — paste it into a text or email.");
        } catch {
          toast.success("Estimate is live — copy the link below to share it.");
        }
      }
    } catch {
      toast.error("Failed to mark sent");
    }
  }

  const updateItem = (i: number, patch: Partial<Item>) =>
    setItems(its => its.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  if (loading) {
    return <DashboardLayout><div style={{ padding: 60, textAlign: "center", color: MUTE, fontFamily: FF }}>Loading…</div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, maxWidth: 860, margin: "0 auto", padding: "8px 4px 120px" }}>
        <button onClick={() => navigate("/estimates")} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "none", color: MUTE, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF, padding: 0, marginBottom: 12 }}>
          <ArrowLeft size={15} /> Estimates
        </button>

        {publicToken && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#ECFDF8", border: "1px solid #99E9D3", borderRadius: 10, padding: "10px 14px", marginBottom: 14, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: "#047857", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 2px" }}>Customer link — text or email this</p>
              <p style={{ fontSize: 12, color: "#065F46", margin: 0, wordBreak: "break-all" }}>{publicLink(publicToken)}</p>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={async () => { try { await navigator.clipboard.writeText(publicLink(publicToken)); toast.success("Link copied"); } catch { toast.error("Couldn't copy — select and copy manually"); } }}
                style={{ background: "#047857", color: "#fff", border: "none", borderRadius: 8, padding: "8px 13px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
                Copy link
              </button>
              <a href={publicLink(publicToken)} target="_blank" rel="noreferrer"
                style={{ background: "#fff", color: "#047857", border: "1px solid #99E9D3", borderRadius: 8, padding: "8px 13px", fontSize: 12, fontWeight: 700, textDecoration: "none", fontFamily: FF }}>
                Preview
              </a>
            </div>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          <h1 style={{ fontSize: 23, fontWeight: 800, color: INK, margin: 0 }}>{isNew && !id ? "New Estimate" : (estimateNumber || "Estimate")}</h1>
          <span style={{ fontSize: 12, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" }}>{status}</span>
        </div>

        <Section title="Who it's for">
          <Grid>
            <Field label="Contact name"><input style={inp} value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Property manager" /></Field>
            <Field label="Property / building"><input style={inp} value={propertyName} onChange={e => setPropertyName(e.target.value)} placeholder="e.g. 5721 W 103rd St Condos" /></Field>
            <Field label="Email"><input style={inp} value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="name@email.com" /></Field>
            <Field label="Phone"><input style={inp} value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="(773) 555-0123" /></Field>
          </Grid>
          <Field label="Service address"><input style={inp} value={serviceAddress} onChange={e => setServiceAddress(e.target.value)} placeholder="Street, City, State ZIP" /></Field>
        </Section>

        <Section title="Estimate details">
          <Field label="Title"><input style={inp} value={title} onChange={e => setTitle(e.target.value)} placeholder="Common Area Cleaning — Monthly Service" /></Field>
          <Field label="Intro note (shown to the client)"><textarea style={{ ...inp, minHeight: 64, resize: "vertical" }} value={introNote} onChange={e => setIntroNote(e.target.value)} placeholder="Thank you for the opportunity to quote your common-area cleaning…" /></Field>
        </Section>

        <Section title="Line items" right={
          <button onClick={() => setItems(its => [...its, blankItem()])} style={addBtn}><Plus size={15} /> Add line</button>
        }>
          {items.map((it, i) => {
            const L = TYPE_LABELS[it.pricing_type];
            return (
              <div key={i} style={{ border: `1px solid ${BORDER}`, borderRadius: 12, padding: 14, marginBottom: 10, background: "#FCFCFB" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <GripVertical size={15} style={{ color: "#C9C6BF", flexShrink: 0 }} />
                  <input style={{ ...inp, fontWeight: 700 }} value={it.name} onChange={e => updateItem(i, { name: e.target.value })} placeholder="Lobby & common hallways" />
                  <button title="Remove" onClick={() => setItems(its => its.length > 1 ? its.filter((_, idx) => idx !== i) : its)} style={{ ...iconBtn, flexShrink: 0 }}><Trash2 size={15} /></button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 8, marginBottom: 8 }}>
                  <Field label="Type">
                    <select style={inp} value={it.pricing_type} onChange={e => updateItem(i, { pricing_type: e.target.value as PricingType })}>
                      <option value="flat">Flat / recurring</option>
                      <option value="hourly">Hourly</option>
                      <option value="one_time">One-time</option>
                    </select>
                  </Field>
                  <Field label="Frequency">
                    <input style={inp} list="freq-options" value={it.frequency} onChange={e => updateItem(i, { frequency: e.target.value })} placeholder="Monthly" />
                  </Field>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, alignItems: "end" }}>
                  <Field label={L.qty}><input style={inp} type="number" min="0" step="0.25" value={it.quantity} onChange={e => updateItem(i, { quantity: e.target.value })} /></Field>
                  <Field label={L.rate}><input style={inp} type="number" min="0" step="0.01" value={it.unit_rate} onChange={e => updateItem(i, { unit_rate: e.target.value })} placeholder="0.00" /></Field>
                  <Field label="Amount"><div style={{ ...inp, background: "#F3F4F6", fontWeight: 700, color: INK }}>{money(lineAmount(it))}</div></Field>
                </div>
              </div>
            );
          })}
          <datalist id="freq-options">{FREQUENCY_OPTIONS.map(f => <option key={f} value={f} />)}</datalist>
        </Section>

        {/* Totals */}
        <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, padding: "16px 18px", marginBottom: 16 }}>
          <Row label="Subtotal" value={money(subtotal)} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "8px 0" }}>
            <span style={{ fontSize: 14, color: MUTE }}>Discount</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: MUTE }}>$</span>
              <input style={{ ...inp, width: 100, textAlign: "right" }} type="number" min="0" step="0.01" value={discount} onChange={e => setDiscount(e.target.value)} />
            </div>
          </div>
          <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 8, paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: INK }}>Total</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: INK }}>{money(total)}</span>
          </div>
        </div>

        <Section title="Terms & internal notes">
          <Grid>
            <Field label="Valid until"><input style={inp} type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} /></Field>
            <div />
          </Grid>
          <Field label="Terms (shown to the client)"><textarea style={{ ...inp, minHeight: 56, resize: "vertical" }} value={terms} onChange={e => setTerms(e.target.value)} placeholder="50% on first service, net-15 thereafter. Estimate valid 30 days." /></Field>
          <Field label="Internal notes (office only)"><textarea style={{ ...inp, minHeight: 44, resize: "vertical" }} value={internalNotes} onChange={e => setInternalNotes(e.target.value)} placeholder="Walkthrough notes, access details…" /></Field>
        </Section>
      </div>

      {/* Sticky action bar */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: `1px solid ${BORDER}`, padding: "12px 16px", display: "flex", justifyContent: "center", gap: 10, zIndex: 20 }}>
        <div style={{ display: "flex", gap: 10, width: "100%", maxWidth: 860 }}>
          <button onClick={saveAsTemplate} style={ghostBtn}><LayoutTemplate size={15} /> Save as template</button>
          <div style={{ flex: 1 }} />
          <button onClick={save} disabled={saving} style={ghostBtn}><Save size={15} /> {saving ? "Saving…" : "Save"}</button>
          <button onClick={markSent} style={primaryBtn}><Send size={15} /> {publicToken ? "Re-copy link" : "Send — get link"}</button>
        </div>
      </div>
    </DashboardLayout>
  );
}

function mapRow(r: any): Item {
  return {
    name: r.name || "",
    pricing_type: (["flat", "hourly", "one_time"].includes(r.pricing_type) ? r.pricing_type : "flat") as PricingType,
    frequency: r.frequency || "",
    quantity: String(r.quantity ?? "1"),
    unit_rate: String(r.unit_rate ?? ""),
  };
}

const Section = ({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) => (
  <div style={{ marginBottom: 22 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
      <h2 style={{ fontSize: 13, fontWeight: 800, color: INK, textTransform: "uppercase", letterSpacing: "0.05em", margin: 0 }}>{title}</h2>
      {right}
    </div>
    {children}
  </div>
);
const Grid = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>{children}</div>
);
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label style={{ display: "block", marginBottom: 10 }}>
    <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>{label}</span>
    {children}
  </label>
);
const Row = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: INK }}><span style={{ color: MUTE }}>{label}</span><span style={{ fontWeight: 600 }}>{value}</span></div>
);

const inp: React.CSSProperties = {
  width: "100%", padding: "9px 11px", border: `1px solid ${BORDER}`, borderRadius: 9,
  fontSize: 14, fontFamily: FF, background: "#fff", boxSizing: "border-box", color: INK,
};
const iconBtn: React.CSSProperties = { width: 34, height: 34, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 8, color: MUTE, cursor: "pointer" };
const addBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 9, padding: "7px 12px", fontSize: 13, fontWeight: 700, color: INK, cursor: "pointer", fontFamily: FF };
const ghostBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 700, color: INK, cursor: "pointer", fontFamily: FF };
const primaryBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, background: INK, color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FF };
