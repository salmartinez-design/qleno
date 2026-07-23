import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { Mail, MessageSquare, Plus, Trash2, ChevronUp, ChevronDown, Send, Flag, Clock } from "lucide-react";
import { toast } from "sonner";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const INK = "#1A1917", MUTE = "#6B6860", BORDER = "#E5E2DC", MINT = "var(--brand)";
const BLUE = "#185FA5", TEAL = "#0F6E56", TEAL_BG = "#E1F5EE";

async function apiFetch(path: string, opts: { method?: string; body?: any } = {}) {
  const { body, ...rest } = opts;
  const r = await fetch(`${API}${path}`, {
    headers: { ...(getAuthHeaders() as Record<string, string>), "Content-Type": "application/json" },
    ...rest, ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

type Step = { channel: "email" | "sms"; delay_hours: number; subject: string | null; message_template: string };

const VARS = ["first_name", "company_name", "company_phone", "property", "monthly", "estimate_link", "estimate_number"];
// Sample values mirror what the engine actually substitutes — {{monthly}} is the
// bare amount ("300.00"), so copy adds its own "$" (e.g. "${{monthly}}").
const SAMPLE: Record<string, string> = {
  first_name: "Brenda", company_name: "Phes", company_phone: "(773) 706-6000", property: "616 S Maplewood",
  monthly: "300.00", estimate_link: "app.qleno.com/estimate/…", estimate_number: "EST-1001",
};
const fillVars = (s: string) => (s || "").replace(/\{\{(\w+)\}\}/g, (_, k) => SAMPLE[k] ?? `{{${k}}}`);

// Canonical gaps (hours from the previous touch) for the cadence presets.
const BASE_DELAYS = [0, 2, 48, 48, 72, 72, 72, 72];
const PRESETS: Record<string, number> = { standard: 1, aggressive: 0.5, gentle: 2 };
const presetDelays = (factor: number) => BASE_DELAYS.map((h, i) => (i === 0 ? 0 : Math.max(1, Math.round(h * factor))));

const DEFAULT_STEPS: Step[] = [
  { channel: "email", delay_hours: 0, subject: "Your cleaning estimate for {{property}}",
    message_template: "Hi {{first_name}},\n\nThank you for the opportunity to quote cleaning for {{property}}. Your estimate comes to ${{monthly}} for the service outlined.\n\nYou can review the full details and approve it here:\n{{estimate_link}}\n\nIf you have any questions or want to adjust the scope, just reply or call {{company_phone}}.\n\nThank you,\n{{company_name}}" },
  { channel: "sms", delay_hours: 2, subject: null,
    message_template: "Hi {{first_name}}, it is {{company_name}}. We just emailed your cleaning estimate for {{property}} (${{monthly}}). Here is the link: {{estimate_link}}. Any questions, just reply." },
  { channel: "email", delay_hours: 48, subject: "Did you get your estimate?",
    message_template: "Hi {{first_name}},\n\nJust making sure the cleaning estimate for {{property}} reached you. You can review and approve it here:\n{{estimate_link}}\n\nIf anything needs adjusting, like the frequency, scope, or budget, let me know and I will revise it the same day.\n\nThank you,\n{{company_name}}" },
  { channel: "sms", delay_hours: 48, subject: null,
    message_template: "Hi {{first_name}}, {{company_name}} checking in on your estimate for {{property}}. Happy to answer any questions. Here it is again: {{estimate_link}}" },
  { channel: "email", delay_hours: 72, subject: "Why property managers choose {{company_name}}",
    message_template: "Hi {{first_name}},\n\nA quick note on what you get with {{company_name}}. Fully insured, background checked crews, a consistent team that learns your building, and one point of contact for anything you need.\n\nYour estimate for {{property}} is still ready here:\n{{estimate_link}}\n\nThank you,\n{{company_name}}" },
  { channel: "sms", delay_hours: 72, subject: null,
    message_template: "Hi {{first_name}}, ready to get {{property}} on the schedule? We can usually start within a week. Reply YES and we will hold a spot. {{estimate_link}}" },
  { channel: "email", delay_hours: 72, subject: "Lets get {{property}} on the schedule",
    message_template: "Hi {{first_name}},\n\nWe have a few openings coming up and I would love to hold one for {{property}}. Approve your estimate and we will lock in your start date:\n{{estimate_link}}\n\nThank you,\n{{company_name}}" },
  { channel: "email", delay_hours: 72, subject: "Closing the loop on your estimate",
    message_template: "Hi {{first_name}},\n\nI do not want to crowd your inbox, so this is my last note for now. If the timing is not right, no problem at all. Your estimate for {{property}} stays here whenever you are ready:\n{{estimate_link}}\n\nThank you for considering {{company_name}}." },
];

const lbl: React.CSSProperties = { display: "block", fontSize: 10, fontWeight: 700, color: "#9E9B94", letterSpacing: "0.06em", marginBottom: 6 };
const inp: React.CSSProperties = { width: "100%", padding: "8px 11px", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, fontFamily: FF, background: "#fff", boxSizing: "border-box", color: INK };

export function FollowUpEditor() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["estimate-followup"], queryFn: () => apiFetch("/api/estimates/follow-up") });

  const [steps, setSteps] = useState<Step[]>([]);
  const [active, setActive] = useState(false);
  const [sel, setSel] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const msgRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (data && !loaded) {
      const s: Step[] = (data.steps || []).map((r: any) => ({
        channel: r.channel === "sms" ? "sms" : "email", delay_hours: Number(r.delay_hours) || 0,
        subject: r.subject ?? null, message_template: r.message_template || "",
      }));
      setSteps(s); setActive(!!data.sequence?.is_active); setLoaded(true);
    }
  }, [data, loaded]);

  // Cumulative day each touch lands on (delay = hours from the previous touch).
  const days = useMemo(() => {
    let h = 0; return steps.map((s, i) => { h += i === 0 ? 0 : s.delay_hours; return Math.floor(h / 24); });
  }, [steps]);
  const totalDays = days.length ? days[days.length - 1] : 0;
  const waitLabel = (h: number) => (h % 24 === 0 ? `Wait ${h / 24} day${h / 24 === 1 ? "" : "s"}` : `Wait ${h} hour${h === 1 ? "" : "s"}`);

  const activePreset = useMemo(() => {
    for (const [name, f] of Object.entries(PRESETS)) {
      const d = presetDelays(f);
      if (steps.length === d.length && steps.every((s, i) => s.delay_hours === d[i])) return name;
    }
    return "custom";
  }, [steps]);

  const cur = steps[sel];
  const patch = (p: Partial<Step>) => setSteps(ss => ss.map((s, i) => (i === sel ? { ...s, ...p } : s)));
  const applyPreset = (name: string) => {
    const f = PRESETS[name]; if (!f) return;
    const d = presetDelays(f);
    setSteps(ss => ss.map((s, i) => ({ ...s, delay_hours: i < d.length ? d[i] : s.delay_hours })));
  };
  const move = (dir: -1 | 1) => {
    const j = sel + dir; if (j < 0 || j >= steps.length) return;
    setSteps(ss => { const n = [...ss]; [n[sel], n[j]] = [n[j], n[sel]]; return n; });
    setSel(j);
  };
  const addTouch = () => { setSteps(ss => [...ss, { channel: "email", delay_hours: 72, subject: "", message_template: "" }]); setSel(steps.length); };
  const removeTouch = (i: number) => { setSteps(ss => ss.filter((_, idx) => idx !== i)); setSel(s => Math.max(0, s > i ? s - 1 : s)); };
  const insertVar = (v: string) => {
    const el = msgRef.current; const token = `{{${v}}}`;
    if (!el) { patch({ message_template: (cur?.message_template || "") + token }); return; }
    const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    patch({ message_template: next });
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + token.length; });
  };

  const save = useMutation({
    mutationFn: () => apiFetch("/api/estimates/follow-up", { method: "PUT", body: { is_active: active, steps } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["estimate-followup"] }); toast.success("Follow-up sequence saved"); },
    onError: () => toast.error("Couldn't save the sequence"),
  });

  if (isLoading) return <div style={{ padding: 40, textAlign: "center", color: MUTE, fontFamily: FF }}>Loading…</div>;

  if (!steps.length) {
    return (
      <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, padding: "40px 24px", textAlign: "center", fontFamily: FF }}>
        <p style={{ fontSize: 16, fontWeight: 700, color: INK, margin: "0 0 6px" }}>No follow-up sequence yet</p>
        <p style={{ fontSize: 13, color: MUTE, margin: "0 0 18px", lineHeight: 1.6, maxWidth: 460, marginInline: "auto" }}>
          Load a proven 8-touch cadence (email + SMS over ~16 days) that sends automatically after you send an estimate and stops the moment the client accepts or declines. Edit anything afterward.
        </p>
        <button onClick={() => { setSteps(DEFAULT_STEPS.map(s => ({ ...s }))); setActive(true); setSel(0); }}
          style={{ background: INK, color: "#fff", border: "none", borderRadius: 9, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
          Load the recommended sequence
        </button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: FF }}>
      {/* Header: title + active toggle + cadence preset + save */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: INK }}>Estimate follow-up</span>
          <button onClick={() => setActive(a => !a)} title="Toggle active" style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontFamily: FF, fontSize: 12, color: MUTE }}>
            {active ? "Active" : "Paused"}
            <span style={{ width: 34, height: 19, borderRadius: 20, background: active ? MINT : "#D3D1C7", position: "relative", display: "inline-block", transition: "background .15s" }}>
              <span style={{ position: "absolute", top: 2, left: active ? 17 : 2, width: 15, height: 15, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
            </span>
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#9E9B94" }}>Cadence</span>
          <select value={activePreset} onChange={e => e.target.value !== "custom" && applyPreset(e.target.value)} style={{ ...inp, width: "auto", fontWeight: 600 }}>
            <option value="standard">Standard · 16 days</option>
            <option value="aggressive">Aggressive · ~8 days</option>
            <option value="gentle">Gentle · ~32 days</option>
            <option value="custom" disabled>Custom</option>
          </select>
          <button onClick={() => save.mutate()} disabled={save.isPending} style={{ background: INK, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <p style={{ fontSize: 12, color: MUTE, margin: "0 0 16px" }}>Sent automatically after an estimate goes out · stops on accept or decline · all in Qleno{!active && " · currently paused"}</p>

      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", color: "#9E9B94", marginBottom: 12 }}>{steps.length} TOUCHES · {totalDays} DAYS</div>

      {/* Vertical sequence flow: trigger → touch → wait → touch → … → stop */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={dot(MINT, "#fff")}><Send size={14} /></span>
          <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>Estimate sent</span>
          <span style={{ fontSize: 11, color: "#9E9B94" }}>trigger</span>
        </div>
        <div style={connector}><span style={{ fontSize: 11, color: "#9E9B94" }}>Sends immediately</span></div>

        {steps.map((s, i) => {
          const isOpen = i === sel;
          const Icon = s.channel === "sms" ? MessageSquare : Mail;
          const snippet = s.channel === "email" ? (s.subject || "(no subject)") : (s.message_template || "").replace(/\n/g, " ").slice(0, 70);
          return (
            <div key={i}>
              {i > 0 && (
                <div style={connector}>
                  <span style={{ fontSize: 11, color: "#6B6860", background: "#F1EFE8", padding: "2px 9px", borderRadius: 20, display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <Clock size={12} /> {waitLabel(s.delay_hours)}
                  </span>
                </div>
              )}
              {!isOpen ? (
                <button onClick={() => setSel(i)} style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", textAlign: "left", border: `1px solid ${BORDER}`, borderRadius: 11, padding: "11px 13px", background: "#fff", cursor: "pointer", fontFamily: FF }}>
                  <Icon size={18} style={{ color: s.channel === "sms" ? TEAL : BLUE, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: INK }}>Touch {i + 1} · {s.channel === "sms" ? "SMS" : "Email"}</span>
                    <span style={{ display: "block", fontSize: 11.5, color: "#6B6860", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{snippet}</span>
                  </span>
                  <span style={{ fontSize: 11, color: TEAL, background: TEAL_BG, padding: "2px 8px", borderRadius: 20, flexShrink: 0 }}>Day {days[i]}</span>
                  <ChevronDown size={16} style={{ color: "#C9C6BF", flexShrink: 0 }} />
                </button>
              ) : (
                <div style={{ border: `2px solid ${MINT}`, borderRadius: 11, padding: 14, background: "#fff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 13 }}>
                    <button onClick={() => setSel(-1)} style={{ display: "inline-flex", alignItems: "center", gap: 9, background: "none", border: "none", cursor: "pointer", fontFamily: FF, padding: 0 }}>
                      <Icon size={18} style={{ color: s.channel === "sms" ? TEAL : BLUE }} />
                      <span style={{ fontSize: 13, fontWeight: 800, color: INK }}>Touch {i + 1} · {s.channel === "sms" ? "SMS" : "Email"} · Day {days[i]}</span>
                      <ChevronUp size={15} style={{ color: "#C9C6BF" }} />
                    </button>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => move(-1)} disabled={i === 0} title="Move up" style={miniBtn}><ChevronUp size={15} /></button>
                      <button onClick={() => move(1)} disabled={i === steps.length - 1} title="Move down" style={miniBtn}><ChevronDown size={15} /></button>
                      <button onClick={() => removeTouch(i)} title="Delete touch" style={{ ...miniBtn, color: "#B3261E" }}><Trash2 size={15} /></button>
                    </div>
                  </div>

                  <span style={lbl}>CHANNEL</span>
                  <div style={{ display: "inline-flex", border: `1px solid ${BORDER}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
                    {(["email", "sms"] as const).map(ch => (
                      <button key={ch} onClick={() => patch({ channel: ch })} style={{ fontFamily: FF, fontSize: 12.5, fontWeight: 700, padding: "7px 16px", border: "none", cursor: "pointer", background: s.channel === ch ? INK : "#fff", color: s.channel === ch ? "#fff" : MUTE }}>{ch === "sms" ? "SMS" : "Email"}</button>
                    ))}
                  </div>

                  <span style={lbl}>TIMING</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                    {i === 0 ? (
                      <span style={{ fontSize: 13, color: INK }}>Sends immediately when the estimate is sent</span>
                    ) : (
                      <>
                        <span style={{ fontSize: 13, color: MUTE }}>Wait</span>
                        <input type="number" min={1} value={s.delay_hours % 24 === 0 ? s.delay_hours / 24 : s.delay_hours}
                          onChange={e => { const n = Math.max(1, Number(e.target.value) || 1); patch({ delay_hours: s.delay_hours % 24 === 0 ? n * 24 : n }); }}
                          style={{ ...inp, width: 60, textAlign: "center" }} />
                        <select value={s.delay_hours % 24 === 0 ? "days" : "hours"}
                          onChange={e => { const v = s.delay_hours % 24 === 0 ? s.delay_hours / 24 : s.delay_hours; patch({ delay_hours: e.target.value === "days" ? v * 24 : v }); }}
                          style={{ ...inp, width: "auto" }}>
                          <option value="hours">hours</option>
                          <option value="days">days</option>
                        </select>
                        <span style={{ fontSize: 13, color: MUTE }}>after the previous touch</span>
                      </>
                    )}
                  </div>
                  <span style={{ fontSize: 11, color: TEAL, background: TEAL_BG, display: "inline-block", padding: "2px 9px", borderRadius: 20, marginBottom: 14 }}>Sends on Day {days[i]}</span>

                  {s.channel === "email" && (
                    <div style={{ marginBottom: 12 }}>
                      <span style={lbl}>SUBJECT</span>
                      <input style={inp} value={s.subject || ""} onChange={e => patch({ subject: e.target.value })} placeholder="Your cleaning estimate for {{property}}" />
                    </div>
                  )}

                  <span style={lbl}>MESSAGE</span>
                  <textarea ref={msgRef} style={{ ...inp, minHeight: 120, resize: "vertical", lineHeight: 1.5 }} value={s.message_template} onChange={e => patch({ message_template: e.target.value })} placeholder="Write the message…" />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "9px 0 14px" }}>
                    <span style={{ fontSize: 11, color: MUTE, alignSelf: "center", marginRight: 2 }}>Insert:</span>
                    {VARS.map(v => (
                      <button key={v} onClick={() => insertVar(v)} style={{ fontFamily: "monospace", fontSize: 11, background: "#F1EFE8", border: "none", padding: "3px 7px", borderRadius: 5, cursor: "pointer", color: "#444441" }}>{`{{${v}}}`}</button>
                    ))}
                  </div>

                  <div style={{ background: "#F8F7F4", borderRadius: 9, padding: "11px 13px" }}>
                    <span style={lbl}>PREVIEW</span>
                    {s.channel === "email" && s.subject && <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginBottom: 4 }}>{fillVars(s.subject)}</div>}
                    <div style={{ fontSize: 12.5, color: "#1A1917", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{fillVars(s.message_template) || "…"}</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div style={{ ...connector, paddingBottom: 4 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={dot("#F1EFE8", "#5F5E5A")}><Flag size={14} /></span>
          <span style={{ fontSize: 12.5, color: "#6B6860" }}>Stops automatically when the client accepts or declines</span>
        </div>
      </div>

      <button onClick={addTouch} style={{ marginTop: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%", padding: "10px 14px", border: `1px dashed #C9C6BF`, background: "#fff", borderRadius: 9, cursor: "pointer", fontFamily: FF, fontSize: 13, fontWeight: 700, color: INK }}>
        <Plus size={15} /> Add touch
      </button>
    </div>
  );
}

const dot = (bg: string, fg: string): React.CSSProperties => ({ width: 30, height: 30, borderRadius: "50%", background: bg, color: fg, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 });
const connector: React.CSSProperties = { marginLeft: 15, borderLeft: `2px solid ${BORDER}`, padding: "7px 0 7px 21px" };

const miniBtn: React.CSSProperties = { width: 30, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 7, color: MUTE, cursor: "pointer" };
