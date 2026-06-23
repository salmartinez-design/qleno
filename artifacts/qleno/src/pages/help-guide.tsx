// [help-guides 2026-06-21] Mobile-first guide reader at /help/:slug. Renders one
// guide as a vertical, phone-width column of numbered steps — each a screenshot
// + caption in the selected language. Header carries the EN/ES toggle (shared
// localStorage key with the index) and a Download button that pulls the
// per-guide PDF from GET /api/guides/:slug/pdf?locale=. Screenshots are served
// as static assets at the opaque `image` path stored on each step.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { ArrowLeft, Download } from "lucide-react";

const FF = "'Plus Jakarta Sans', sans-serif";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const LOCALE_KEY = "qleno-help-locale";

type Locale = "en" | "es";
type GuideStep = { order: number; image: string; caption_en: string; caption_es: string };
type Guide = {
  slug: string;
  title_en: string; title_es: string | null;
  summary_en: string | null; summary_es: string | null;
  steps: GuideStep[];
};

function pick(en: string | null, es: string | null, locale: Locale): string {
  if (locale === "es") return (es && es.trim()) || en || "";
  return en || "";
}

async function fetchGuide(slug: string): Promise<Guide> {
  const token = useAuthStore.getState().token;
  const r = await fetch(`${BASE}/api/guides/${encodeURIComponent(slug)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("not found");
  return (await r.json()).guide;
}

export default function HelpGuidePage() {
  const [, params] = useRoute("/help/:slug");
  const slug = params?.slug ?? "";
  const [locale, setLocale] = useState<Locale>(
    () => (localStorage.getItem(LOCALE_KEY) === "es" ? "es" : "en"),
  );
  const [downloading, setDownloading] = useState(false);
  const changeLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem(LOCALE_KEY, l);
  };
  const t = (en: string, es: string) => (locale === "es" ? es : en);

  const { data: guide, isLoading, isError } = useQuery({
    queryKey: ["help-guide", slug],
    queryFn: () => fetchGuide(slug),
    enabled: !!slug,
  });

  // The PDF endpoint needs the bearer token, so fetch as a blob and trigger a
  // download rather than navigating to a plain <a href>.
  const downloadPdf = async () => {
    if (!guide) return;
    setDownloading(true);
    try {
      const token = useAuthStore.getState().token;
      const r = await fetch(`${BASE}/api/guides/${encodeURIComponent(slug)}/pdf?locale=${locale}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error("pdf failed");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `qleno-guide-${slug}-${locale}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert(t("Couldn't download the PDF. Try again.", "No se pudo descargar el PDF. Inténtalo de nuevo."));
    } finally {
      setDownloading(false);
    }
  };

  const steps = (guide?.steps ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 480, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14, fontFamily: FF }}>
        {/* Back + language toggle */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <Link href="/help" style={{ textDecoration: "none" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 600, color: "#57544E", cursor: "pointer" }}>
              <ArrowLeft size={16} /> {t("All guides", "Todas las guías")}
            </span>
          </Link>
          <LangToggle locale={locale} onChange={changeLocale} />
        </div>

        {isLoading && <Muted>{t("Loading…", "Cargando…")}</Muted>}
        {isError && <Muted>{t("Guide not found.", "Guía no encontrada.")}</Muted>}

        {guide && (
          <>
            <div>
              <h1 style={{ fontSize: 21, fontWeight: 800, color: "#1A1917", margin: "0 0 6px" }}>
                {pick(guide.title_en, guide.title_es, locale)}
              </h1>
              {pick(guide.summary_en, guide.summary_es, locale) && (
                <p style={{ fontSize: 14, color: "#57544E", lineHeight: 1.55, margin: 0 }}>
                  {pick(guide.summary_en, guide.summary_es, locale)}
                </p>
              )}
            </div>

            <button
              onClick={downloadPdf}
              disabled={downloading}
              style={{
                alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 8,
                padding: "9px 16px", borderRadius: 9, border: "1px solid #E5E2DC",
                background: "#FFFFFF", color: "#1A1917", fontFamily: FF, fontSize: 13.5,
                fontWeight: 600, cursor: downloading ? "default" : "pointer", opacity: downloading ? 0.6 : 1,
              }}
            >
              <Download size={16} /> {downloading ? t("Preparing…", "Preparando…") : t("Download PDF", "Descargar PDF")}
            </button>

            {/* Steps */}
            <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 4 }}>
              {steps.map((s) => (
                <div key={s.order} style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "14px 16px" }}>
                    <div style={{ flexShrink: 0, width: 26, height: 26, borderRadius: "50%", background: "#0A0E1A", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>
                      {s.order}
                    </div>
                    <div style={{ fontSize: 14.5, color: "#1A1917", lineHeight: 1.55, paddingTop: 2 }}>
                      {pick(s.caption_en, s.caption_es, locale)}
                    </div>
                  </div>
                  {s.image && (
                    <img
                      src={`${BASE}${s.image}`}
                      alt=""
                      loading="lazy"
                      style={{ display: "block", width: "100%", height: "auto", borderTop: "1px solid #F0EEE9" }}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  )}
                </div>
              ))}
              {steps.length === 0 && (
                <Muted>{t("This guide has no steps yet.", "Esta guía aún no tiene pasos.")}</Muted>
              )}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function LangToggle({ locale, onChange }: { locale: Locale; onChange: (l: Locale) => void }) {
  const btn = (l: Locale, label: string) => (
    <button
      onClick={() => onChange(l)}
      style={{
        padding: "6px 14px", border: "none", cursor: "pointer", fontFamily: FF,
        fontSize: 13, fontWeight: 600,
        background: locale === l ? "#0A0E1A" : "transparent",
        color: locale === l ? "#FFFFFF" : "#57544E",
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "inline-flex", border: "1px solid #E5E2DC", borderRadius: 8, overflow: "hidden", background: "#FFFFFF" }}>
      {btn("en", "EN")}
      {btn("es", "ES")}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 14, color: "#9E9B94", padding: "8px 2px", fontFamily: FF }}>{children}</div>;
}
