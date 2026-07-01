import { useRef, useEffect, useState, useCallback } from "react";
import { Bold, Italic, List, ListOrdered, Link2, Unlink, Sparkles, Eye, Loader2 } from "lucide-react";
import { cleanHtml } from "./rich-text-editor";
import { getAuthHeaders } from "@/lib/auth";

// [easy-message-editor] The "easy mode" Customer Messages editor. Merge tags
// appear as friendly PILLS ("First name", not {{first_name}}), there's an
// always-on live preview of what the customer receives, and an AI assist bar
// (warmer / shorter / proofread / translate). Works for BOTH email (formatted)
// and SMS (plain text). Stored format stays {{tag}} text — pills are a display
// layer converted on load and back on save, so nothing else in the pipeline
// changes.

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const TAG_LABEL: Record<string, string> = {
  first_name: "First name", client_name: "Full name", company_name: "Company",
  company_phone: "Phone", company_email: "Email", service_type: "Service",
  date: "Date", appointment_date: "Date", time: "Time", appointment_time: "Time",
  arrival_window: "Arrival window", appointment_window: "Arrival window",
  service_address: "Address", tech_name: "Cleaner",
  appointment_link: "Appointment link", review_link: "Review link",
  services_breakdown: "Service breakdown",
};
function labelFor(key: string): string {
  return TAG_LABEL[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Sample HTML table for {{services_breakdown}} — mirrors the server renderer in
// lib/services-breakdown.ts so the live preview matches the test send.
const SAMPLE_BREAKDOWN = `<table cellpadding="8" cellspacing="0" style="width:100%;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:14px;margin:8px 0;"><tr><td style="padding:8px;">Deep Clean — 2,000 sqft</td><td style="padding:8px;text-align:right;">$608.00</td></tr><tr><td style="padding:8px;">Oven cleaning</td><td style="padding:8px;text-align:right;">+$50.00</td></tr><tr><td style="padding:8px;">Inside fridge</td><td style="padding:8px;text-align:right;">+$35.00</td></tr><tr><td style="padding:8px;">Appliance bundle discount</td><td style="padding:8px;text-align:right;color:#0F6E56;">−$20.00</td></tr><tr style="border-top:1px solid #D3D1C7;"><td style="padding:12px 8px 8px;font-weight:600;">First visit total</td><td style="padding:12px 8px 8px;text-align:right;font-weight:600;">$673.00</td></tr></table>`;

const SAMPLE: Record<string, string> = {
  first_name: "Maria", client_name: "Maria Gomez", company_name: "Phes",
  company_phone: "(708) 974-5517", company_email: "info@phes.io", service_type: "Standard Cleaning",
  date: "Friday, June 27, 2026", appointment_date: "Friday, June 27, 2026",
  time: "9:00 AM", appointment_time: "9:00 AM",
  arrival_window: "9:00 AM – 12:00 PM", appointment_window: "9:00 AM – 12:00 PM",
  service_address: "123 Oak St, Oak Lawn, IL 60453", tech_name: "Ana",
  appointment_link: "https://phes.io/appt", review_link: "https://phes.io/review",
  services_breakdown: SAMPLE_BREAKDOWN,
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function chipHtml(key: string): string {
  return `<span class="cm-chip" data-key="${key}" contenteditable="false">${labelFor(key)}</span>`;
}
// Stored body ({{tag}} text) → editable HTML with pills.
function bodyToEditable(body: string, channel: "email" | "sms"): string {
  let html = channel === "email"
    ? cleanHtml(body || "")
    : escapeHtml(body || "").replace(/\n/g, "<br>");
  return html.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => chipHtml(String(k).trim()));
}
// Editable HTML (with pills) → stored body ({{tag}} text).
function editableToBody(root: HTMLElement, channel: "email" | "sms"): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".cm-chip").forEach((c) => {
    c.replaceWith(document.createTextNode(`{{${(c as HTMLElement).dataset.key}}}`));
  });
  if (channel === "email") return cleanHtml(clone.innerHTML);
  // SMS → plain text: block/line boundaries become newlines, tags stripped.
  let html = clone.innerHTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const tmp = document.createElement("textarea");
  tmp.innerHTML = html;
  return tmp.value.replace(/\n{3,}/g, "\n\n").trim();
}
// HTML a tag renders to in the preview. services_breakdown is raw table HTML;
// normal values are escaped (injection-safe); a tag with NO sample value shows
// an obvious muted placeholder so the gap is visible instead of vanishing.
function sampleHtml(key: string): string {
  if (key === "services_breakdown") return SAMPLE.services_breakdown || "";
  if (key in SAMPLE) return escapeHtml(SAMPLE[key]);
  return `<span style="color:#B4B2A9">[${escapeHtml(labelFor(key))} — populated from booking]</span>`;
}
// Fill pills/tags with sample values for the preview.
function fillSample(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".cm-chip").forEach((c) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = sampleHtml((c as HTMLElement).dataset.key || "");
    c.replaceWith(...Array.from(tmp.childNodes));
  });
  return clone.innerHTML.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => sampleHtml(String(k).trim()));
}

const AI_ACTIONS = [
  { mode: "warmer", label: "Make warmer" },
  { mode: "shorter", label: "Shorten" },
  { mode: "proofread", label: "Proofread" },
  { mode: "spanish", label: "Translate to Spanish" },
];

export function EasyMessageEditor({
  channel, initialSubject, initialBody, mergeTags, companyName = "Phes", logoUrl,
  templateKey, branchId, saving, onSave, onCancel,
}: {
  channel: "email" | "sms";
  initialSubject: string;
  initialBody: string;
  mergeTags: string[];
  companyName?: string;
  logoUrl?: string | null;
  // Message key (e.g. "job_scheduled") + active branch — needed for Send Test.
  templateKey?: string;
  branchId?: number | string | null;
  saving: boolean;
  onSave: (subject: string, body: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [subject, setSubject] = useState(initialSubject || "");
  const [previewBody, setPreviewBody] = useState("");
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  // Send-Test state + dirty tracking. baseBody/baseSubject capture the SAVED
  // baseline so the button can show "Sending DRAFT" (unsaved edits present) vs
  // "Sending SAVED", and send the draft body only when it actually differs.
  const baseBody = useRef("");
  const baseSubject = useRef("");
  const [bodyDirty, setBodyDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(() => {
    if (ref.current) {
      setPreviewBody(fillSample(ref.current));
      setBodyDirty(editableToBody(ref.current, channel) !== baseBody.current);
    }
  }, [channel]);

  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = bodyToEditable(initialBody, channel);
      baseBody.current = editableToBody(ref.current, channel);
      baseSubject.current = initialSubject || "";
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subjectDirty = subject !== baseSubject.current;
  const dirty = bodyDirty || subjectDirty;

  async function sendTest() {
    if (!templateKey || !ref.current) return;
    setTesting(true); setTestMsg(null);
    try {
      // Send the DRAFT (current editor content) when dirty; omit overrides when
      // clean so the backend renders the SAVED template row.
      const draft = dirty
        ? { subject, body: editableToBody(ref.current, channel) }
        : {};
      const r = await fetch(`${API}/api/notifications/test-send`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          template_key: templateKey,
          channel,
          fixture: "sample",
          branch_id: branchId == null || branchId === "all" ? null : branchId,
          ...draft,
        }),
      });
      const data = await r.json();
      if (!r.ok || data?.status === "failed") throw new Error(data?.message || data?.error || "Send failed");
      setTestMsg({ ok: true, text: `Sent to ${data.recipient || "your inbox"}` });
    } catch (e: any) { setTestMsg({ ok: false, text: e?.message || "Send failed" }); }
    finally { setTesting(false); }
  }

  const saveSel = () => {
    const s = window.getSelection();
    if (s && s.rangeCount && ref.current?.contains(s.anchorNode)) savedRange.current = s.getRangeAt(0).cloneRange();
  };
  const exec = (cmd: string, val?: string) => { ref.current?.focus(); document.execCommand(cmd, false, val); refresh(); };
  const addLink = () => {
    ref.current?.focus();
    const url = window.prompt("Link URL", "https://"); if (!url) return;
    const sel = window.getSelection();
    if (sel && sel.toString()) document.execCommand("createLink", false, url);
    else document.execCommand("insertHTML", false, `<a href="${url}">${url}</a>`);
    refresh();
  };
  const insertChip = (key: string) => {
    ref.current?.focus();
    const span = document.createElement("span");
    span.className = "cm-chip"; span.contentEditable = "false"; span.dataset.key = key; span.textContent = labelFor(key);
    const r = savedRange.current || (() => { const rr = document.createRange(); rr.selectNodeContents(ref.current!); rr.collapse(false); return rr; })();
    r.insertNode(span);
    const sp = document.createTextNode(" "); span.after(sp); r.setStartAfter(sp); r.collapse(true);
    const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); savedRange.current = r.cloneRange();
    refresh();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    const ins = html ? cleanHtml(html) : escapeHtml(text || "").replace(/\n/g, "<br>");
    document.execCommand("insertHTML", false, ins.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => chipHtml(String(k).trim())));
    refresh();
  };

  async function runAi(mode: string) {
    if (!ref.current) return;
    setAiBusy(mode); setAiError(null);
    try {
      const body = editableToBody(ref.current, channel);
      const r = await fetch(`${API}/api/notifications/ai-rewrite`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, mode, channel }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "AI failed");
      ref.current.innerHTML = bodyToEditable(data.result, channel);
      refresh();
    } catch (e: any) { setAiError(e?.message || "AI assist failed"); }
    finally { setAiBusy(null); }
  }

  const tags = (mergeTags.length ? mergeTags : Object.keys(SAMPLE))
    .filter((t, i, a) => a.indexOf(t) === i)
    // services_breakdown renders an HTML table — email only; meaningless in SMS.
    .filter((t) => channel === "email" || t !== "services_breakdown");
  const tb = (onClick: () => void, icon: React.ReactNode, title: string) => (
    <button type="button" key={title} title={title} onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "#fff", border: "1px solid #E5E2DC", borderRadius: 5, cursor: "pointer", color: "#6B7280" }}>{icon}</button>
  );
  const previewText = channel === "sms" ? (new DOMParser().parseFromString(previewBody, "text/html").body.textContent || "").trim() : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style>{`.cm-chip{display:inline-block;background:var(--brand-dim,#E8FDF8);border:1px solid var(--brand,#00C9A0);color:#0F6E56;border-radius:11px;padding:0 8px;font-size:11.5px;font-weight:600;margin:0 1px;white-space:nowrap;line-height:1.7;} .cm-ed p{margin:0 0 8px;} .cm-ed ul{margin:0 0 8px;padding-left:20px;} .cm-ed h2{font-size:18px;margin:0 0 8px;} .cm-ed h3{font-size:15px;margin:0 0 8px;} .cm-ed a{color:#185FA5;} .cm-pv p{margin:0 0 8px;} .cm-pv ul{margin:0 0 8px;padding-left:20px;} .cm-pv a{color:#185FA5;} @keyframes cm-spin{to{transform:rotate(360deg)}} .spin{animation:cm-spin .8s linear infinite;}`}</style>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 14, alignItems: "start" }}>
        {/* ── Editor ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {channel === "email" && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Subject</p>
              <input value={subject} onChange={(e) => setSubject(e.target.value)}
                style={{ width: "100%", padding: "8px 11px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none" }} />
            </div>
          )}
          <div style={{ border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", padding: "7px 9px", borderBottom: "1px solid #E5E2DC", background: "#F7F6F3" }}>
              {channel === "email" && <>
                {tb(() => exec("bold"), <Bold size={13} />, "Bold")}
                {tb(() => exec("italic"), <Italic size={13} />, "Italic")}
                {tb(() => exec("insertUnorderedList"), <List size={13} />, "Bullet list")}
                {tb(() => exec("insertOrderedList"), <ListOrdered size={13} />, "Numbered list")}
                {tb(addLink, <Link2 size={13} />, "Add link")}
                {tb(() => exec("unlink"), <Unlink size={13} />, "Remove link")}
                <span style={{ width: 1, height: 18, background: "#E5E2DC", margin: "0 2px" }} />
              </>}
              <span style={{ fontSize: 10, color: "#9E9B94", fontWeight: 600 }}>Insert:</span>
              {tags.map((t) => (
                <button type="button" key={t} title={`{{${t}}}`} onMouseDown={(e) => { e.preventDefault(); insertChip(t); }}
                  style={{ fontSize: 11, fontWeight: 600, color: "#0F6E56", background: "#E8FDF8", border: "1px solid #9FE1CB", borderRadius: 12, padding: "2px 9px", cursor: "pointer", fontFamily: "inherit" }}>{labelFor(t)}</button>
              ))}
            </div>
            <div ref={ref} className="cm-ed" contentEditable suppressContentEditableWarning
              onInput={refresh} onPaste={onPaste} onKeyUp={saveSel} onMouseUp={saveSel}
              style={{ minHeight: channel === "email" ? 150 : 90, padding: 14, outline: "none", fontSize: 13, lineHeight: 1.6, color: "#1A1917" }} />
          </div>

          {/* AI assist */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", background: "#F4FBF9", border: "1px solid #CBEFE5", borderRadius: 8, padding: "7px 10px" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#0F6E56", display: "inline-flex", alignItems: "center", gap: 4 }}><Sparkles size={13} /> AI assist</span>
            {AI_ACTIONS.map((a) => (
              <button type="button" key={a.mode} disabled={!!aiBusy} onClick={() => runAi(a.mode)}
                style={{ fontSize: 11, fontWeight: 600, color: "#0F6E56", background: "#fff", border: "1px solid #9FE1CB", borderRadius: 14, padding: "3px 11px", cursor: aiBusy ? "default" : "pointer", fontFamily: "inherit", opacity: aiBusy && aiBusy !== a.mode ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 4 }}>
                {aiBusy === a.mode && <Loader2 size={11} className="spin" />} {a.label}
              </button>
            ))}
            {aiError && <span style={{ fontSize: 11, color: "#A32D2D" }}>{aiError}</span>}
          </div>
        </div>

        {/* ── Live preview ── */}
        <div>
          <p style={{ fontSize: 11, fontWeight: 700, color: "#9E9B94", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 5 }}><Eye size={13} /> Live preview</p>
          {channel === "email" ? (
            <div style={{ background: "#fff", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden" }}>
              <div style={{ background: "#fff", borderBottom: "1px solid #E5E2DC", padding: "12px 16px" }}>
                {logoUrl
                  ? <img src={logoUrl} alt={companyName} style={{ height: 32, width: "auto", display: "block" }} />
                  : <span style={{ display: "inline-block", background: "var(--brand,#00C9A0)", color: "#fff", fontWeight: 800, fontSize: 14, padding: "5px 12px", borderRadius: 6 }}>{companyName}</span>}
              </div>
              {subject && <div style={{ padding: "10px 16px 0", fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{subject.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => SAMPLE[String(k).trim()] || "")}</div>}
              <div className="cm-pv" style={{ padding: "12px 16px", fontSize: 13, color: "#374151", lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: previewBody || "<span style='color:#B4B2A9'>Nothing yet</span>" }} />
            </div>
          ) : (
            <div style={{ background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: 14 }}>
              <div style={{ maxWidth: 300, background: "#E1F5EE", border: "1px solid #9FE1CB", borderRadius: "16px 16px 16px 4px", padding: "10px 13px", fontSize: 13, lineHeight: 1.45, color: "#1A1917", whiteSpace: "pre-wrap" }}>
                {previewText || "Nothing yet"}
                <div style={{ fontSize: 10, color: "#0F6E56", marginTop: 5 }}>{previewText.length} chars · {Math.max(1, Math.ceil(previewText.length / 160))} SMS</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {templateKey && (
            <>
              <button type="button" disabled={testing} onClick={sendTest} title="Send this message to your own inbox"
                style={{ padding: "8px 14px", border: "1px solid #E5E2DC", borderRadius: 7, background: "#fff", fontSize: 13, fontWeight: 600, color: "#374151", cursor: testing ? "default" : "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>
                {testing && <Loader2 size={12} className="spin" />}{testing ? "Sending…" : "Send test"}
              </button>
              <span style={{ fontSize: 11, fontWeight: 700, color: dirty ? "#C2410C" : "#9E9B94" }}>
                {dirty ? "Sending DRAFT" : "Sending SAVED"}
              </span>
              {testMsg && <span style={{ fontSize: 11.5, color: testMsg.ok ? "#0F6E56" : "#A32D2D" }}>{testMsg.text}</span>}
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={onCancel} style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 7, background: "#fff", fontSize: 13, color: "#374151", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button type="button" disabled={saving} onClick={() => ref.current && onSave(subject, editableToBody(ref.current, channel))}
            style={{ padding: "8px 18px", border: "none", borderRadius: 7, background: "var(--brand,#00C9A0)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
