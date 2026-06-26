import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Plus, Trash2, ArrowLeft, Save, Send, LayoutTemplate, GripVertical, Check, FileText, Mail, Eye, Clock, MousePointerClick, MessageSquare, X, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { CalendarPopover } from "@/components/calendar-popover";
import { useAddressAutocomplete } from "@/hooks/use-address-autocomplete";
import { FrequencyPicker } from "@/components/frequency-picker";

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

// [estimate-flat-clarity] What the flat price is charged per + the label suffix
// ("$150 / visit"). "total" = a one-time price, so no suffix.
const PRICE_UNITS = [
  { v: "visit", label: "per visit" },
  { v: "week", label: "per week" },
  { v: "month", label: "per month" },
  { v: "quarter", label: "per quarter" },
  { v: "year", label: "per year" },
  { v: "service", label: "per service" },
  { v: "total", label: "one-time (total)" },
];
const unitSuffix = (u: string) => (u && u !== "total" ? ` / ${u}` : "");

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

// [estimate-templates-phase2] One-click vertical picker. Seeded templates carry
// a category; this maps it to a clean label + one-line scope hint for the cards.
const CATEGORY_META: Record<string, { label: string; hint: string }> = {
  common_areas: { label: "Common Areas", hint: "Lobby, halls, elevators, restrooms" },
  office: { label: "Office", hint: "Desks, kitchen, restrooms, floors" },
  retail: { label: "Retail Store", hint: "Sales floor, fitting rooms, nightly" },
  medical: { label: "Medical Facility", hint: "Exam rooms, disinfection, biohaz" },
};

const blankItem = (): Item => ({ name: "", pricing_type: "flat", frequency: "Monthly", quantity: "1", unit_rate: "" });

// The cadence shared by all line items, or "" when they differ.
const commonFreqOf = (arr: Item[]): string =>
  arr.length && arr.every(x => x.frequency === arr[0].frequency) ? arr[0].frequency : "";

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
  // [estimate-autosave] Debounced save status surfaced in the action bar.
  const [autoStatus, setAutoStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [id, setId] = useState<number | null>(estimateId);
  const [status, setStatus] = useState("draft");
  const [estimateNumber, setEstimateNumber] = useState<string>("");
  const [publicToken, setPublicToken] = useState<string | null>(null);
  // [estimate-send-now] Set to the recipient when the Day-0 email actually went out.
  const [emailedTo, setEmailedTo] = useState<string | null>(null);
  // [estimate-tracking] Bumped after a send so the tracking panel refetches.
  const [trackVersion, setTrackVersion] = useState(0);

  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  // [multi-recipient-estimates] Additional CC recipients (chips) + in-progress input.
  const [ccEmails, setCcEmails] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState("");
  // Account contacts offered as quick-add CC (only when the estimate is account-tied).
  const [accountContacts, setAccountContacts] = useState<{ name: string; email: string }[]>([]);
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
  // [estimate-flat-mode] 'itemized' (price each line) vs 'flat' (one price for
  // the whole job + a scope checklist). Default itemized.
  const [billingMode, setBillingMode] = useState<"itemized" | "flat">("itemized");
  const [flatPrice, setFlatPrice] = useState("");
  // [estimate-flat-clarity] What the flat price is per + an optional free-text
  // scope paragraph (alternative to itemizing the checklist).
  const [flatPriceUnit, setFlatPriceUnit] = useState("visit");
  const [scopeNote, setScopeNote] = useState("");

  // [estimate-templates-phase2] One-click template picker (new estimates only).
  const [templates, setTemplates] = useState<any[]>([]);
  const [showPicker, setShowPicker] = useState(isNew);
  const [applyingTemplate, setApplyingTemplate] = useState(false);

  // [estimate-address-autocomplete] Google Places on the Service Address field —
  // pick a suggestion to fill the canonical "Street, City, State ZIP" (zip is
  // also what branch routing needs).
  const serviceAddressRef = useRef<HTMLInputElement>(null);
  useAddressAutocomplete(serviceAddressRef, true, (p) => {
    const composed = [p.street, p.city, [p.state, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    setServiceAddress(composed || p.formatted);
  });

  // Load existing estimate, or seed a new one from a template (?template=id).
  useEffect(() => {
    (async () => {
      try {
        if (!isNew && estimateId) {
          const e = await apiFetch(`/api/estimates/${estimateId}`);
          setStatus(e.status); setEstimateNumber(e.estimate_number || "");
          setPublicToken(e.public_token || null);
          setContactName(e.contact_name || ""); setContactEmail(e.contact_email || ""); setContactPhone(e.contact_phone || "");
          setCcEmails(String(e.cc_emails || "").split(",").map((s: string) => s.trim()).filter(Boolean));
          // Account-tied estimate → offer its contacts (with email) as quick-add CC.
          if (e.account_id) {
            try {
              const cs = await apiFetch(`/api/accounts/${e.account_id}/contacts`);
              setAccountContacts((Array.isArray(cs) ? cs : []).filter((c: any) => c.email).map((c: any) => ({ name: c.name || c.email, email: c.email })));
            } catch { /* contacts are optional */ }
          }
          setPropertyName(e.property_name || ""); setServiceAddress(e.service_address || "");
          setTitle(e.title || ""); setIntroNote(e.intro_note || ""); setTerms(e.terms || ""); setInternalNotes(e.internal_notes || "");
          setDiscount(String(e.discount_amount ?? "0"));
          setBillingMode(e.billing_mode === "flat" ? "flat" : "itemized");
          setFlatPrice(e.flat_price != null && Number(e.flat_price) > 0 ? String(e.flat_price) : "");
          setFlatPriceUnit(e.flat_price_unit || "visit");
          setScopeNote(e.scope_note || "");
          setValidUntil(e.valid_until ? String(e.valid_until).slice(0, 10) : "");
          setItems((e.items || []).length ? e.items.map(mapRow) : [blankItem()]);
        } else {
          const templateId = new URLSearchParams(window.location.search).get("template");
          if (templateId) {
            const t = await apiFetch(`/api/estimates/templates/${templateId}`);
            setTitle(t.title || ""); setIntroNote(t.intro_note || ""); setTerms(t.terms || "");
            if (t.billing_mode === "flat") {
              setBillingMode("flat");
              setFlatPrice(t.flat_price != null && Number(t.flat_price) > 0 ? String(t.flat_price) : "");
            }
            setItems((t.items || []).length ? t.items.map(mapRow) : [blankItem()]);
            setShowPicker(false);
          } else {
            // Load the template list for the one-click picker. Non-fatal.
            try {
              const r = await apiFetch(`/api/estimates/templates`);
              setTemplates(Array.isArray(r?.data) ? r.data : []);
            } catch { /* picker just won't show */ }
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

  // [estimate-flat-mode] Flat mode = the one price the office typed; itemized =
  // sum of the priced lines.
  const subtotal = useMemo(
    () => billingMode === "flat" ? (Number(flatPrice) || 0) : items.reduce((s, it) => s + lineAmount(it), 0),
    [billingMode, flatPrice, items],
  );
  const total = Math.max(0, subtotal - (Number(discount) || 0));

  const body = () => ({
    contact_name: contactName, contact_email: contactEmail, contact_phone: contactPhone,
    cc_emails: ccEmails.join(","),
    property_name: propertyName, service_address: serviceAddress,
    title, intro_note: introNote, terms, internal_notes: internalNotes,
    discount_amount: Number(discount) || 0,
    billing_mode: billingMode,
    flat_price: billingMode === "flat" ? (Number(flatPrice) || 0) : 0,
    flat_price_unit: flatPriceUnit,
    scope_note: billingMode === "flat" ? (scopeNote.trim() || null) : null,
    valid_until: validUntil || null,
    // Flat mode persists scope only (name + shared frequency, no price); itemized
    // keeps the full priced line. Empty scope rows are dropped either way.
    items: items.filter(it => it.name.trim() || (billingMode === "itemized" && Number(it.unit_rate) > 0)).map(it => (
      billingMode === "flat"
        ? { name: it.name, pricing_type: "flat", frequency: it.frequency, quantity: 1, unit_rate: 0 }
        : { name: it.name, pricing_type: it.pricing_type, frequency: it.frequency, quantity: Number(it.quantity) || 0, unit_rate: Number(it.unit_rate) || 0 }
    )),
  });

  // [multi-recipient-estimates] CC chip helpers. Accept comma/semicolon/space or
  // Enter; validate; dedupe; never re-add the primary.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function addCc(raw: string) {
    const parts = raw.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return;
    setCcEmails(prev => {
      const next = [...prev];
      for (const e of parts) {
        if (EMAIL_RE.test(e) && e !== contactEmail.trim().toLowerCase() && !next.includes(e)) next.push(e);
      }
      return next;
    });
    setCcInput("");
  }
  const removeCc = (e: string) => setCcEmails(prev => prev.filter(x => x !== e));

  // [estimate-autosave] Single in-flight guard + the last successfully-saved
  // snapshot so autosave only fires on real changes.
  const savingRef = useRef(false);
  const lastSavedRef = useRef<string | null>(null);

  // Quiet save (no toast) — creates on first save, PATCHes thereafter. Shared by
  // the manual Save button, autosave, PDF preview, and Send.
  async function persist(): Promise<number | null> {
    if (savingRef.current) return id;
    savingRef.current = true;
    setSaving(true); setAutoStatus("saving");
    try {
      let sid: number | null = id;
      if (id) {
        await apiFetch(`/api/estimates/${id}`, { method: "PATCH", body: body() });
      } else {
        const r = await apiFetch("/api/estimates", { method: "POST", body: body() });
        sid = r.id; setId(r.id);
        window.history.replaceState(null, "", `${API}/estimates/${r.id}`);
      }
      lastSavedRef.current = JSON.stringify(body());
      setAutoStatus("saved");
      return sid;
    } catch {
      setAutoStatus("error");
      return null;
    } finally {
      savingRef.current = false; setSaving(false);
    }
  }

  // Manual Save button — persist + a confirmation toast.
  async function save(): Promise<number | null> {
    const wasNew = !id;
    const sid = await persist();
    if (sid) toast.success(wasNew ? "Estimate created" : "Estimate saved");
    else toast.error("Failed to save");
    return sid;
  }

  // [estimate-autosave] Auto-save 2s after the last edit. Skips the initial
  // load, no-op edits, and creating an empty draft.
  const snapshot = JSON.stringify(body());
  useEffect(() => {
    if (loading) return;
    if (lastSavedRef.current === null) { lastSavedRef.current = snapshot; return; } // baseline after load
    if (snapshot === lastSavedRef.current) return;
    const hasContent = !!(contactName.trim() || title.trim() || items.some(it => it.name.trim()) || Number(flatPrice) > 0);
    if (!id && !hasContent) return;
    const t = setTimeout(() => { persist(); }, 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, loading, id]);

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

  // Apply a template's body + line items into the current (new) estimate.
  // Everything stays editable afterward; this just pre-fills.
  async function applyTemplate(t: any) {
    setApplyingTemplate(true);
    try {
      const full = await apiFetch(`/api/estimates/templates/${t.id}`);
      if (full.title) setTitle(full.title);
      if (full.intro_note) setIntroNote(full.intro_note);
      if (full.terms) setTerms(full.terms);
      // [estimate-packages] A flat package drops straight into flat-price view.
      if (full.billing_mode === "flat") {
        setBillingMode("flat");
        setFlatPrice(full.flat_price != null && Number(full.flat_price) > 0 ? String(full.flat_price) : "");
      } else {
        setBillingMode("itemized");
      }
      setItems((full.items || []).length ? full.items.map(mapRow) : [blankItem()]);
      setShowPicker(false);
      toast.success(`Started from "${t.name}" — edit anything below`);
    } catch {
      toast.error("Couldn't load that template");
    } finally {
      setApplyingTemplate(false);
    }
  }

  function publicLink(token: string) {
    return `${window.location.origin}${API}/estimate/${token}`;
  }

  // [estimate-pdf] Save (if needed) then fetch the branded PDF with auth and open
  // it in a new tab — a preview of exactly what the client receives. Falls back
  // to a download if a popup is blocked.
  // [estimate-sms] Text-the-estimate preview modal.
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsData, setSmsData] = useState<{ to: string | null; to_e164: string | null; body: string } | null>(null);
  const [smsTo, setSmsTo] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  async function openSms() {
    const savedId = await save();
    if (!savedId) return;
    try {
      const r = await apiFetch(`/api/estimates/${savedId}/sms-preview`);
      setSmsData(r); setSmsTo(r.to || r.to_e164 || ""); setSmsOpen(true);
    } catch { toast.error("Couldn't build the SMS preview"); }
  }
  const SMS_REASON: Record<string, string> = {
    no_phone: "No phone number on this estimate — add one under “Who it's for.”",
    comms_disabled: "Texting is turned off (global comms).",
    company_comms_disabled: "Texting is turned off for this company.",
    branch_comms_disabled: "Texting is turned off for this branch.",
    twilio_disabled: "SMS isn't enabled yet (Twilio go-live).",
    twilio_unconfigured: "SMS isn't configured (Twilio credentials).",
    no_from_number: "No SMS sending number is configured.",
  };
  async function sendSms() {
    if (!id) return;
    setSmsSending(true);
    try {
      const r = await apiFetch(`/api/estimates/${id}/sms`, { method: "POST", body: { to: smsTo.trim() } });
      if (r.sent) { toast.success(`Texted to ${r.to}`); setSmsOpen(false); setTrackVersion(v => v + 1); }
      else toast.error(SMS_REASON[r.reason] || "Couldn't send the text.");
    } catch { toast.error("Couldn't send the text."); }
    finally { setSmsSending(false); }
  }

  // [estimate-card-on-file] Send the client a Stripe save-card link (reuses the
  // payment-links save_card flow): ensure a client record, then send the link.
  const [cardBusy, setCardBusy] = useState(false);
  async function sendCardOnFile() {
    const savedId = await save();
    if (!savedId) return;
    setCardBusy(true);
    try {
      const c = await apiFetch(`/api/estimates/${savedId}/ensure-client`, { method: "POST" });
      if (!c.email && !c.phone) { toast.error("Add an email or phone first, then send the card link."); return; }
      await apiFetch(`/api/payment-links`, { method: "POST", body: { client_id: c.client_id, purpose: "save_card", send_email: !!c.email, send_sms: !c.email && !!c.phone } });
      toast.success(`Card-on-file link sent to ${c.email || c.phone}`);
    } catch { toast.error("Couldn't send the card-on-file link"); }
    finally { setCardBusy(false); }
  }

  const [pdfBusy, setPdfBusy] = useState(false);
  async function downloadPdf() {
    // Always persist current edits first — the PDF is rendered server-side from
    // the saved row, so a stale save would preview the wrong content.
    const savedId = await save();
    if (!savedId) return;
    setPdfBusy(true);
    try {
      const r = await fetch(`${API}/api/estimates/${savedId}/pdf`, { headers: { ...(getAuthHeaders() as Record<string, string>) } });
      if (!r.ok) throw new Error(await r.text());
      const url = URL.createObjectURL(await r.blob());
      const w = window.open(url, "_blank");
      if (!w) { const a = document.createElement("a"); a.href = url; a.download = `${estimateNumber || "estimate"}.pdf`; a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      toast.error("Couldn't generate the PDF");
    } finally {
      setPdfBusy(false);
    }
  }

  async function markSent() {
    // Persist current edits before sending so the client gets what's on screen.
    const savedId = await save();
    if (!savedId) return;
    try {
      const r = await apiFetch(`/api/estimates/${savedId}/send`, { method: "POST" });
      setStatus("sent");
      setPublicToken(r.public_token || null);
      // [estimate-send-now] r.emailed = the Day-0 email actually went out just now.
      setEmailedTo(r.emailed ? (r.email_recipient || contactEmail) : null);
      setTrackVersion(v => v + 1);
      if (r.public_token) { try { await navigator.clipboard.writeText(publicLink(r.public_token)); } catch { /* clipboard optional */ } }
      if (r.emailed) {
        toast.success(`Estimate emailed to ${r.email_recipient || contactEmail}${ccEmails.length ? ` (+${ccEmails.length} CC)` : ""} — link also copied.`);
      } else if (r.email_status === "email_opt_out") {
        toast.success("Link copied. Email skipped — that recipient opted out.");
      } else if (!contactEmail.trim()) {
        toast.success("Link copied. Add an email above to also send the estimate by email.");
      } else {
        toast.success("Link copied. The follow-up email will go out shortly.");
      }
    } catch {
      toast.error("Failed to mark sent");
    }
  }

  const updateItem = (i: number, patch: Partial<Item>) =>
    setItems(its => its.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  // [estimate-bulk-frequency] Set every line's frequency at once.
  const applyFreqToAll = (v: string) => {
    const f = v.trim();
    if (!f) return;
    setItems(its => its.map(it => ({ ...it, frequency: f })));
  };
  // The cadence shared by all lines (empty when they differ — "Mixed").
  const commonFreq = useMemo(() => commonFreqOf(items), [items]);

  if (loading) {
    return <DashboardLayout><div style={{ padding: 60, textAlign: "center", color: MUTE, fontFamily: FF }}>Loading…</div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, maxWidth: 860, margin: "0 auto", padding: "8px 4px 120px" }}>
        <button onClick={() => navigate("/estimates")} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "none", color: MUTE, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF, padding: 0, marginBottom: 12 }}>
          <ArrowLeft size={15} /> Estimates
        </button>

        {emailedTo && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#ECFDF8", border: "1px solid #99E9D3", borderRadius: 10, padding: "10px 14px", marginBottom: 10 }}>
            <span style={{ width: 18, height: 18, borderRadius: 999, background: "#047857", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>✓</span>
            <p style={{ fontSize: 13, fontWeight: 600, color: "#065F46", margin: 0 }}>Estimate emailed to {emailedTo}{ccEmails.length ? ` and ${ccEmails.length} more` : ""}. Track opens/clicks on the Engagement page.</p>
          </div>
        )}
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
        {id && status !== "draft" && <EstimateTracking estimateId={id} version={trackVersion} />}

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          <h1 style={{ fontSize: 23, fontWeight: 800, color: INK, margin: 0 }}>{isNew && !id ? "New Estimate" : (estimateNumber || "Estimate")}</h1>
          <span style={{ fontSize: 12, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em" }}>{status}</span>
        </div>

        {/* [estimate-templates-phase2] One-click vertical picker — new estimates only. */}
        {isNew && !id && showPicker && templates.length > 0 && (
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 14, padding: 18, marginBottom: 22, background: "#FCFCFB" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <LayoutTemplate size={16} style={{ color: MINT }} />
                <h2 style={{ fontSize: 13, fontWeight: 800, color: INK, textTransform: "uppercase", letterSpacing: "0.05em", margin: 0 }}>Start from a template</h2>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <a href={`${API}/company/packages`} style={{ color: MINT, fontSize: 13, fontWeight: 700, textDecoration: "none" }}>Manage packages</a>
                <button onClick={() => setShowPicker(false)} style={{ background: "none", border: "none", color: MUTE, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF, padding: 0 }}>
                  Start blank
                </button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
              {[...templates]
                .sort((a, b) => (CATEGORY_META[b.category] ? 1 : 0) - (CATEGORY_META[a.category] ? 1 : 0))
                .map((t) => {
                  const meta = CATEGORY_META[t.category];
                  return (
                    <button
                      key={t.id}
                      onClick={() => !applyingTemplate && applyTemplate(t)}
                      disabled={applyingTemplate}
                      style={{
                        textAlign: "left", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12,
                        padding: "13px 14px", cursor: applyingTemplate ? "default" : "pointer", fontFamily: FF,
                        display: "flex", flexDirection: "column", gap: 4, transition: "border-color 0.12s",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = MINT)}
                      onMouseLeave={(e) => (e.currentTarget.style.borderColor = BORDER)}
                    >
                      <span style={{ fontSize: 14, fontWeight: 800, color: INK }}>{meta?.label || t.name}</span>
                      <span style={{ fontSize: 12, color: MUTE, lineHeight: 1.35 }}>
                        {t.billing_mode === "flat"
                          ? `${money(Number(t.flat_price) || 0)} · ${t.item_count ?? 0} item${(t.item_count ?? 0) === 1 ? "" : "s"} included`
                          : (meta?.hint || `${t.item_count ?? 0} line items`)}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        <Section title="Who it's for">
          <Grid>
            <Field label="Contact name"><input style={inp} value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Property manager" /></Field>
            <Field label="Property / building"><input style={inp} value={propertyName} onChange={e => setPropertyName(e.target.value)} placeholder="e.g. 5721 W 103rd St Condos" /></Field>
            <Field label="Email"><input style={inp} value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="name@email.com" /></Field>
            <Field label="Phone"><input style={inp} value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="(773) 555-0123" /></Field>
          </Grid>
          {/* [multi-recipient-estimates] Additional recipients (CC). Every emailed
              touch goes to the primary Email + all of these. */}
          <Field label="CC — also email these people">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", border: `1px solid ${BORDER}`, borderRadius: 9, padding: "6px 8px", background: "#fff" }}>
              {ccEmails.map(e => (
                <span key={e} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#ECFDF8", border: "1px solid #99E9D3", color: "#065F46", borderRadius: 999, padding: "3px 8px", fontSize: 12, fontWeight: 600 }}>
                  {e}
                  <button onClick={() => removeCc(e)} aria-label={`Remove ${e}`} style={{ border: "none", background: "none", color: "#047857", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                </span>
              ))}
              <input
                style={{ flex: 1, minWidth: 160, border: "none", outline: "none", fontSize: 14, fontFamily: FF, background: "transparent", padding: "4px 2px" }}
                value={ccInput}
                onChange={e => setCcInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); addCc(ccInput); } }}
                onBlur={() => addCc(ccInput)}
                placeholder={ccEmails.length ? "Add another…" : "manager@email.com, owner@email.com"}
              />
            </div>
            {accountContacts.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                <span style={{ fontSize: 11, color: MUTE, alignSelf: "center" }}>From this account:</span>
                {accountContacts.filter(c => !ccEmails.includes(c.email.toLowerCase()) && c.email.toLowerCase() !== contactEmail.trim().toLowerCase()).map(c => (
                  <button key={c.email} onClick={() => addCc(c.email)} style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 999, padding: "3px 9px", fontSize: 12, color: INK, cursor: "pointer", fontFamily: FF }}>
                    + {c.name}
                  </button>
                ))}
              </div>
            )}
          </Field>
          <Field label="Service address"><input ref={serviceAddressRef} style={inp} value={serviceAddress} onChange={e => setServiceAddress(e.target.value)} placeholder="Start typing an address…" /></Field>
        </Section>

        <Section title="Estimate details">
          <Field label="Title"><input style={inp} value={title} onChange={e => setTitle(e.target.value)} placeholder="Common Area Cleaning — Monthly Service" /></Field>
          <Field label="Intro note (shown to the client)"><textarea style={{ ...inp, minHeight: 64, resize: "vertical" }} value={introNote} onChange={e => setIntroNote(e.target.value)} placeholder="Thank you for the opportunity to quote your common-area cleaning…" /></Field>
        </Section>

        <Section title="Services & pricing" right={
          <button onClick={() => setItems(its => [...its, blankItem()])} style={addBtn}><Plus size={15} /> {billingMode === "flat" ? "Add item" : "Add line"}</button>
        }>
          {/* [estimate-flat-mode] Flat price (one number + scope list) vs itemized. */}
          <div style={{ display: "inline-flex", border: `1px solid ${BORDER}`, borderRadius: 9, overflow: "hidden", marginBottom: 14 }}>
            {(["flat", "itemized"] as const).map(m => (
              <button key={m} onClick={() => setBillingMode(m)} style={{
                fontFamily: FF, fontSize: 13, fontWeight: 700, padding: "7px 16px", border: "none", cursor: "pointer",
                background: billingMode === m ? INK : "#fff", color: billingMode === m ? "#fff" : MUTE,
              }}>{m === "flat" ? "Flat price" : "Itemized"}</button>
            ))}
          </div>

          {/* [estimate-bulk-frequency] Pick a cadence → applies to every line. */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginBottom: 12, padding: "10px 12px", border: `1px solid ${BORDER}`, borderRadius: 10, background: "#FCFCFB", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>Service frequency — sets every line</span>
              <FrequencyPicker value={commonFreq} onChange={applyFreqToAll} />
            </div>
            <span style={{ fontSize: 12, color: MUTE, alignSelf: "center", whiteSpace: "nowrap" }}>{commonFreq ? `All lines: ${commonFreq}` : "Lines vary"}</span>
          </div>

          {billingMode === "flat" ? (
            <>
              <div style={{ marginBottom: 14, padding: "12px 14px", border: `1px solid ${BORDER}`, borderRadius: 10, background: "#FCFCFB" }}>
                <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>Service price</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ color: MUTE, fontSize: 16 }}>$</span>
                  <input style={{ ...inp, maxWidth: 150, fontWeight: 700, fontSize: 16 }} type="number" min="0" step="0.01" value={flatPrice} onChange={e => setFlatPrice(e.target.value)} placeholder="0.00" />
                  <select style={{ ...inp, maxWidth: 170 }} value={flatPriceUnit} onChange={e => setFlatPriceUnit(e.target.value)} aria-label="Price unit">
                    {PRICE_UNITS.map(u => <option key={u.v} value={u.v}>{u.label}</option>)}
                  </select>
                </div>
                <span style={{ display: "block", fontSize: 12, color: MUTE, marginTop: 6 }}>
                  {flatPriceUnit === "total"
                    ? `Client sees ${money(Number(flatPrice) || 0)} as a one-time total.`
                    : `Client sees ${money(Number(flatPrice) || 0)}${unitSuffix(flatPriceUnit)} — the price for each ${flatPriceUnit}.`}
                </span>
              </div>

              {/* [estimate-flat-clarity] Optional scope paragraph — describe the
                  work in prose instead of (or alongside) the checklist below. */}
              <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Scope description <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "#9CA3AF" }}>— optional, shown to the client above the checklist</span></span>
              <textarea style={{ ...inp, minHeight: 70, resize: "vertical", marginBottom: 14 }} value={scopeNote} onChange={e => setScopeNote(e.target.value)} placeholder="e.g. Full janitorial service for the suite — all offices, the break room, both restrooms, and common hallways, cleaned each visit. Supplies included." />

              <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>What's included <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "#9CA3AF" }}>— optional checklist, no per-line price</span></span>
              {items.map((it, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ width: 20, height: 20, borderRadius: 6, background: MINT, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Check size={13} /></span>
                  <input style={inp} value={it.name} onChange={e => updateItem(i, { name: e.target.value })} placeholder="Workstations & desks — dust & sanitize" />
                  <button title="Remove" onClick={() => setItems(its => its.length > 1 ? its.filter((_, idx) => idx !== i) : its)} style={{ ...iconBtn, flexShrink: 0 }}><Trash2 size={15} /></button>
                </div>
              ))}
            </>
          ) : (
            items.map((it, i) => {
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
                      <FrequencyPicker value={it.frequency} onChange={v => updateItem(i, { frequency: v })} />
                    </Field>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, alignItems: "end" }}>
                    <Field label={L.qty}><input style={inp} type="number" min="0" step="0.25" value={it.quantity} onChange={e => updateItem(i, { quantity: e.target.value })} /></Field>
                    <Field label={L.rate}><input style={inp} type="number" min="0" step="0.01" value={it.unit_rate} onChange={e => updateItem(i, { unit_rate: e.target.value })} placeholder="0.00" /></Field>
                    <Field label="Amount"><div style={{ ...inp, background: "#F3F4F6", fontWeight: 700, color: INK }}>{money(lineAmount(it))}</div></Field>
                  </div>
                </div>
              );
            })
          )}
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
            <span style={{ fontSize: 22, fontWeight: 800, color: INK }}>{money(total)}{billingMode === "flat" && <span style={{ fontSize: 14, fontWeight: 600, color: MUTE }}>{unitSuffix(flatPriceUnit)}</span>}</span>
          </div>
        </div>

        <Section title="Terms & internal notes">
          <Grid>
            <Field label="Valid until"><CalendarPopover value={validUntil} ariaLabel="Valid until" onChange={setValidUntil} block /></Field>
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
          <span style={{ alignSelf: "center", fontSize: 12, fontWeight: 600, marginRight: 4, whiteSpace: "nowrap", color: autoStatus === "error" ? "#B91C1C" : MUTE }}>
            {autoStatus === "saving" ? "Saving…" : autoStatus === "saved" ? "All changes saved" : autoStatus === "error" ? "Save failed — retry" : ""}
          </span>
          <button onClick={downloadPdf} disabled={pdfBusy} style={ghostBtn}><FileText size={15} /> {pdfBusy ? "Preparing…" : "PDF preview"}</button>
          <button onClick={openSms} style={ghostBtn}><MessageSquare size={15} /> Text to client</button>
          <button onClick={sendCardOnFile} disabled={cardBusy} style={ghostBtn}><CreditCard size={15} /> {cardBusy ? "Sending…" : "Card on file"}</button>
          <button onClick={save} disabled={saving} style={ghostBtn}><Save size={15} /> {saving ? "Saving…" : "Save"}</button>
          <button onClick={markSent} style={primaryBtn}><Send size={15} /> {publicToken ? "Resend to client" : "Send to client"}</button>
        </div>
      </div>

      {/* [estimate-sms] Text-the-estimate preview modal */}
      {smsOpen && smsData && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18, zIndex: 60 }} onClick={() => setSmsOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: 22, width: "100%", maxWidth: 420, fontFamily: FF }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: INK }}>Text the estimate</span>
              <button onClick={() => setSmsOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9CA3AF" }}><X size={16} /></button>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>To</div>
            <input style={{ ...inp, marginBottom: 4 }} type="tel" value={smsTo} onChange={e => setSmsTo(e.target.value)} placeholder="(773) 555-0123" />
            <div style={{ fontSize: 11, color: MUTE, marginBottom: 14 }}>Edit if they want it sent to a different number (e.g. a personal cell).</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>Message preview</div>
            {/* Phone-bubble preview */}
            <div style={{ background: "#F0F0F2", borderRadius: 12, padding: 12, marginBottom: 4 }}>
              <div style={{ background: "#00C9A0", color: "#063", borderRadius: 16, borderBottomRightRadius: 4, padding: "9px 13px", fontSize: 13.5, lineHeight: 1.45, marginLeft: "auto", maxWidth: "92%", width: "fit-content", whiteSpace: "pre-wrap" }}>{smsData.body}</div>
            </div>
            <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 16 }}>Sent from your Phes number · standard messaging rates apply</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setSmsOpen(false)} style={ghostBtn}>Cancel</button>
              <button onClick={sendSms} disabled={smsSending || !smsTo.trim()} style={{ ...primaryBtn, opacity: smsTo.trim() ? 1 : 0.5 }}>
                <MessageSquare size={15} /> {smsSending ? "Sending…" : "Send text"}
              </button>
            </div>
          </div>
        </div>
      )}
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

// [estimate-tracking] On-page send status, engagement activity, and follow-up
// progress — surfaces the data from GET /api/estimates/:id/engagement so the
// office sees it on the estimate instead of only on the dashboard.
const fmtWhen = (d: string | null) =>
  d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const STATUS_PILL: Record<string, { bg: string; fg: string }> = {
  SENT: { bg: "#E1F5EE", fg: "#0F6E56" }, VIEWED: { bg: "#E1F5EE", fg: "#0F6E56" },
  ACCEPTED: { bg: "#EAF3DE", fg: "#3B6D11" }, DECLINED: { bg: "#FCEBEB", fg: "#A32D2D" },
  EXPIRED: { bg: "#FAEEDA", fg: "#854F0B" },
};

function EstimateTracking({ estimateId, version }: { estimateId: number; version: number }) {
  const [data, setData] = useState<any>(null);
  const [stopping, setStopping] = useState(false);
  const load = async () => { try { setData(await apiFetch(`/api/estimates/${estimateId}/engagement`)); } catch { /* non-fatal */ } };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [estimateId, version]);
  if (!data?.estimate) return null;

  const { estimate, counts, timeline, enrollment } = data;
  const status = String(estimate.status || "").toUpperCase();
  const pill = STATUS_PILL[status] || { bg: "#F1EFE8", fg: "#5F5E5A" };
  const ICONS: Record<string, any> = { sent: Mail, viewed: Eye, opened: Mail, clicked: MousePointerClick };
  const LABELS: Record<string, (r: string | null, ch?: string | null) => string> = {
    sent: (r, ch) => `${ch === "sms" ? "Text" : "Email"} sent${r ? ` to ${r}` : ""}`,
    viewed: () => "Client opened the estimate",
    opened: (r) => `Email opened${r ? ` by ${r}` : ""}`,
    clicked: (r) => `Link clicked${r ? ` by ${r}` : ""}`,
  };
  const step = Number(enrollment?.current_step || 0);
  const total = Number(enrollment?.total_steps || 0);
  const stopped = !!enrollment?.stopped_at, done = !!enrollment?.completed_at;
  const accepted = status === "ACCEPTED" || status === "DECLINED";

  const stop = async () => {
    setStopping(true);
    try { await apiFetch(`/api/estimates/${estimateId}/stop-followups`, { method: "POST" }); await load(); toast.success("Follow-ups stopped"); }
    catch { toast.error("Couldn't stop follow-ups"); }
    finally { setStopping(false); }
  };
  // Office marks the outcome when the client says "proceed" (or passes) off-app.
  const markOutcome = async (outcome: "accepted" | "declined") => {
    const verb = outcome === "accepted" ? "won" : "lost";
    if (!confirm(`Mark this estimate as ${verb}? This stops the follow-ups.`)) return;
    try { await apiFetch(`/api/estimates/${estimateId}/mark-outcome`, { method: "POST", body: { outcome } }); await load(); toast.success(`Marked as ${verb}`); }
    catch { toast.error("Couldn't update the status"); }
  };

  return (
    <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 14, overflow: "hidden", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "13px 16px", borderBottom: `1px solid #EEECE7` }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: INK }}>Sent &amp; tracking</span>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", color: pill.fg, background: pill.bg, padding: "2px 9px", borderRadius: 20 }}>{status}</span>
        {!accepted && (
          <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <button onClick={() => markOutcome("accepted")} style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: "#0F6E56", border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontFamily: FF }}>Mark as won</button>
            <button onClick={() => markOutcome("declined")} style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontFamily: FF }}>Mark as lost</button>
          </div>
        )}
      </div>

      <div style={{ padding: "14px 16px", borderBottom: `1px solid #EEECE7` }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          {timeline.length === 0 && <span style={{ fontSize: 13, color: MUTE }}>No activity yet.</span>}
          {timeline.map((t: any, i: number) => {
            const Icon = t.event_type === "sent" && t.channel === "sms" ? MessageSquare : (ICONS[t.event_type] || Clock);
            const label = (LABELS[t.event_type] || ((): string => t.event_type))(t.recipient, t.channel);
            return (
              <div key={i} style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
                <Icon size={16} style={{ color: MINT, marginTop: 1, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: INK }}>{label}</div>
                  <div style={{ fontSize: 11, color: "#9CA3AF" }}>{fmtWhen(t.occurred_at)}</div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          {[["Views", counts?.viewed], ["Email opens", counts?.opened], ["Link clicks", counts?.clicked]].map(([l, v]) => (
            <div key={l as string} style={{ flex: 1, background: "#F8F7F4", borderRadius: 9, padding: "9px 12px" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: INK }}>{Number(v || 0)}</div>
              <div style={{ fontSize: 11, color: MUTE }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {enrollment && (
        <div style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "#9CA3AF" }}>FOLLOW-UP SEQUENCE</span>
            <span style={{ fontSize: 12, color: MUTE }}>Step <span style={{ color: INK, fontWeight: 700 }}>{Math.min(step, total)}</span> of {total}</span>
          </div>
          <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
            {Array.from({ length: total }).map((_, i) => (
              <div key={i} style={{ flex: 1, height: 5, borderRadius: 3, background: i < step - 1 || done ? MINT : BORDER }} />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: INK, display: "inline-flex", alignItems: "center", gap: 6 }}>
              {done ? <><Check size={15} style={{ color: "#3B6D11" }} /> Sequence complete</>
                : stopped ? <>Follow-ups stopped{enrollment.stopped_reason ? ` (${enrollment.stopped_reason})` : ""}</>
                : accepted ? <><Check size={15} style={{ color: "#3B6D11" }} /> Stopped — client {status.toLowerCase()}</>
                : <><Clock size={15} style={{ color: "#BA7517" }} /> Next email {fmtWhen(enrollment.next_fire_at)}</>}
            </span>
            {!stopped && !done && !accepted && (
              <button onClick={stop} disabled={stopping} style={{ fontSize: 12, fontWeight: 700, color: "#B91C1C", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 8, padding: "6px 11px", cursor: "pointer", fontFamily: FF }}>
                {stopping ? "Stopping…" : "Stop follow-ups"}
              </button>
            )}
          </div>
          {!stopped && !done && !accepted && <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 8 }}>Stops automatically when the client accepts or declines.</div>}
        </div>
      )}
    </div>
  );
}


const inp: React.CSSProperties = {
  width: "100%", padding: "9px 11px", border: `1px solid ${BORDER}`, borderRadius: 9,
  fontSize: 14, fontFamily: FF, background: "#fff", boxSizing: "border-box", color: INK,
};
const iconBtn: React.CSSProperties = { width: 34, height: 34, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 8, color: MUTE, cursor: "pointer" };
const addBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 9, padding: "7px 12px", fontSize: 13, fontWeight: 700, color: INK, cursor: "pointer", fontFamily: FF };
const ghostBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 700, color: INK, cursor: "pointer", fontFamily: FF };
const primaryBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, background: INK, color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FF };
