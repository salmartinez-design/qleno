// [cleaning-checklist 2026-07-24] Crew-facing field reference: what's INCLUDED
// per service, so the team stays inside the booked scope. Mobile-first, reached
// from the My Jobs account menu (it replaced the removed "Change Password"
// item). English/Spanish toggle — remembered per device — because the whole
// crew needs to read it on-site. Content lives in lib/service-checklist.ts.
import { useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, Check, Plus, X } from "lucide-react";
import {
  CHECKLIST_SERVICES,
  CHECKLIST_UI,
  GOLDEN_RULE,
  ADDONS,
  NOT_OFFERED,
  type ChecklistLang,
} from "@/lib/service-checklist";

const LANG_KEY = "qleno_checklist_lang";

function initialLang(): ChecklistLang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "en" || saved === "es") return saved;
    // Default to Spanish when the device is set to Spanish, else English.
    if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("es")) return "es";
  } catch { /* storage blocked — fall through to English */ }
  return "en";
}

export default function CleaningChecklistPage() {
  const [, navigate] = useLocation();
  const [lang, setLangState] = useState<ChecklistLang>(initialLang);
  const [activeKey, setActiveKey] = useState<string>(CHECKLIST_SERVICES[0]?.key ?? "standard");

  const setLang = (l: ChecklistLang) => {
    setLangState(l);
    try { localStorage.setItem(LANG_KEY, l); } catch { /* non-fatal */ }
  };

  const service = CHECKLIST_SERVICES.find(s => s.key === activeKey) ?? CHECKLIST_SERVICES[0];

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#F7F6F3", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ maxWidth: 460, margin: "0 auto" }}>

        {/* Header — back + title + language toggle */}
        <div style={{ position: "sticky", top: 0, zIndex: 10, backgroundColor: "#FFFFFF", borderBottom: "1px solid #E5E2DC", padding: "12px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <button onClick={() => navigate("/my-jobs")}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "none", background: "transparent", color: "#1A1917", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", padding: 4, marginLeft: -4 }}>
              <ChevronLeft size={18} /> {CHECKLIST_UI.back[lang]}
            </button>
            {/* EN / ES segmented toggle */}
            <div role="group" aria-label={CHECKLIST_UI.langLabel[lang]}
              style={{ display: "inline-flex", background: "#F0EDEA", borderRadius: 9, padding: 2 }}>
              {(["en", "es"] as ChecklistLang[]).map(l => (
                <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l}
                  style={{
                    padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "inherit",
                    fontSize: 13, fontWeight: 700,
                    background: lang === l ? "#0A0E1A" : "transparent",
                    color: lang === l ? "#FFFFFF" : "#6B6860",
                  }}>
                  {l === "en" ? "EN" : "ES"}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <p style={{ fontSize: 18, fontWeight: 800, color: "#1A1917", margin: 0 }}>{CHECKLIST_UI.title[lang]}</p>
            <p style={{ fontSize: 12.5, color: "#6B6860", margin: "2px 0 0", lineHeight: 1.4 }}>{CHECKLIST_UI.subtitle[lang]}</p>
          </div>
        </div>

        <div style={{ padding: "14px" }}>

          {/* Golden rule — the boundary this screen exists to enforce */}
          <div style={{ background: "#0A0E1A", borderRadius: 12, padding: "14px 16px", marginBottom: 14 }}>
            <p style={{ fontSize: 11, fontWeight: 800, color: "#5EE6C7", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>{GOLDEN_RULE.title[lang]}</p>
            <p style={{ fontSize: 13, color: "#EDEDED", margin: 0, lineHeight: 1.5 }}>{GOLDEN_RULE.body[lang]}</p>
          </div>

          {/* Clean-type selector */}
          <p style={{ fontSize: 11, fontWeight: 800, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px 2px" }}>{CHECKLIST_UI.pickClean[lang]}</p>
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, marginBottom: 14 }}>
            {CHECKLIST_SERVICES.map(s => (
              <button key={s.key} onClick={() => setActiveKey(s.key)} aria-pressed={activeKey === s.key}
                style={{
                  flexShrink: 0, padding: "9px 14px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
                  fontSize: 13, fontWeight: 700, whiteSpace: "nowrap",
                  border: `1px solid ${activeKey === s.key ? "#00C9A0" : "#E5E2DC"}`,
                  background: activeKey === s.key ? "#00C9A0" : "#FFFFFF",
                  color: activeKey === s.key ? "#0A0E1A" : "#1A1917",
                }}>
                {s.title[lang]}
              </button>
            ))}
          </div>

          {/* Selected service header */}
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 16, fontWeight: 800, color: "#1A1917", margin: 0 }}>{service.title[lang]}</p>
            <p style={{ fontSize: 12.5, color: "#6B6860", margin: "3px 0 0", lineHeight: 1.45 }}>{service.subtitle[lang]}</p>
            {service.note && (
              <p style={{ fontSize: 12.5, fontWeight: 700, color: "#B45309", margin: "6px 0 0", lineHeight: 1.45 }}>{service.note[lang]}</p>
            )}
          </div>

          {/* Sections */}
          {service.sections.map((sec, i) => (
            <div key={i} style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "14px 16px", marginBottom: 12 }}>
              <p style={{ fontSize: 15, fontWeight: 800, color: "#0A0E1A", margin: "0 0 10px", paddingLeft: 8, borderLeft: "3px solid #00C9A0" }}>{sec.title[lang]}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {sec.items.map((item, j) => (
                  <div key={j} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                    <Check size={16} color="#00A588" strokeWidth={2.5} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span style={{ fontSize: 13.5, color: "#1A1917", lineHeight: 1.45 }}>{item[lang]}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Add-Ons — priced extras, only when on the order. Always shown. */}
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #F1D9A8", borderRadius: 12, padding: "14px 16px", marginTop: 18, marginBottom: 12 }}>
            <p style={{ fontSize: 15, fontWeight: 800, color: "#0A0E1A", margin: 0 }}>{ADDONS.title[lang]}</p>
            <p style={{ fontSize: 12.5, color: "#6B6860", margin: "3px 0 0", lineHeight: 1.45 }}>{ADDONS.subtitle[lang]}</p>
            <p style={{ fontSize: 12.5, fontWeight: 700, color: "#B45309", margin: "6px 0 10px", lineHeight: 1.45 }}>{ADDONS.note[lang]}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {ADDONS.items.map((item, j) => (
                <div key={j} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                  <Plus size={16} color="#B45309" strokeWidth={2.5} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span style={{ flex: 1, fontSize: 13.5, color: "#1A1917", lineHeight: 1.45 }}>{item.label[lang]}</span>
                  <span style={{ flexShrink: 0, fontSize: 13, fontWeight: 800, color: "#B45309" }}>{item.price[lang]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* We Don't Do These — hard boundaries, never done on any job. */}
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #F0C9C4", borderRadius: 12, padding: "14px 16px", marginBottom: 12 }}>
            <p style={{ fontSize: 15, fontWeight: 800, color: "#0A0E1A", margin: 0 }}>{NOT_OFFERED.title[lang]}</p>
            <p style={{ fontSize: 12.5, color: "#6B6860", margin: "3px 0 10px", lineHeight: 1.45 }}>{NOT_OFFERED.subtitle[lang]}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {NOT_OFFERED.items.map((item, j) => (
                <div key={j} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                  <X size={16} color="#B3261E" strokeWidth={2.5} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span style={{ fontSize: 13.5, color: "#1A1917", lineHeight: 1.45 }}>{item[lang]}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ height: 24 }} />
        </div>
      </div>
    </div>
  );
}
