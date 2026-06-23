// [help-guides 2026-06-21] In-app Help & Guides index. Data-driven: pulls the
// guide list from GET /api/guides (audience-filtered server-side by the caller's
// role, so techs see tech guides and office sees office guides). Bilingual via a
// persisted EN/ES toggle — every guide carries both languages, so the toggle is
// instant and needs no refetch. Each card links to the mobile-first reader at
// /help/:slug. Content lives in the DB, not here — new guides need no code change.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import {
  LifeBuoy, BookOpen, Smartphone, Briefcase, Clock, DollarSign,
  FileText, Camera, MapPin, ChevronRight,
} from "lucide-react";

const FF = "'Plus Jakarta Sans', sans-serif";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const LOCALE_KEY = "qleno-help-locale";

type Locale = "en" | "es";
type GuideListItem = {
  slug: string;
  audience: string;
  category: string | null;
  icon: string | null;
  sort_order: number;
  title_en: string;
  title_es: string | null;
  summary_en: string | null;
  summary_es: string | null;
  step_count: number;
};

// lucide icons referenced by name in the `icon` column. Fallback = LifeBuoy.
const ICONS: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  LifeBuoy, BookOpen, Smartphone, Briefcase, Clock, DollarSign, FileText, Camera, MapPin,
};

function pick(en: string | null, es: string | null, locale: Locale): string {
  if (locale === "es") return (es && es.trim()) || en || "";
  return en || "";
}

async function fetchGuides(): Promise<GuideListItem[]> {
  const token = useAuthStore.getState().token;
  const r = await fetch(`${BASE}/api/guides`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("Failed to load guides");
  const data = await r.json();
  return data.guides ?? [];
}

export default function HelpPage() {
  const [locale, setLocale] = useState<Locale>(
    () => (localStorage.getItem(LOCALE_KEY) === "es" ? "es" : "en"),
  );
  const changeLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem(LOCALE_KEY, l);
  };

  const { data: guides, isLoading, isError } = useQuery({
    queryKey: ["help-guides"],
    queryFn: fetchGuides,
  });

  const t = (en: string, es: string) => (locale === "es" ? es : en);

  return (
    <DashboardLayout>
      <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16, fontFamily: FF }}>
        {/* Header + language toggle */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: "#1A1917", margin: "0 0 4px", display: "flex", alignItems: "center", gap: 9 }}>
              <LifeBuoy size={22} /> {t("Help & Guides", "Ayuda y Guías")}
            </h1>
            <p style={{ fontSize: 13.5, color: "#9E9B94", margin: 0 }}>
              {t("Step-by-step guides. Tap one to open.", "Guías paso a paso. Toca una para abrir.")}
            </p>
          </div>
          <LangToggle locale={locale} onChange={changeLocale} />
        </div>

        {/* States */}
        {isLoading && <Muted>{t("Loading guides…", "Cargando guías…")}</Muted>}
        {isError && <Muted>{t("Couldn't load guides. Try again.", "No se pudieron cargar las guías. Inténtalo de nuevo.")}</Muted>}
        {!isLoading && !isError && (guides?.length ?? 0) === 0 && (
          <Muted>{t("No guides yet — check back soon.", "Aún no hay guías — vuelve pronto.")}</Muted>
        )}

        {/* Cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {(guides ?? []).map((g) => {
            const Icon = (g.icon && ICONS[g.icon]) || LifeBuoy;
            return (
              <Link key={g.slug} href={`/help/${g.slug}`} style={{ textDecoration: "none" }}>
                <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}>
                  <div style={{ flexShrink: 0, width: 40, height: 40, borderRadius: 10, background: "#F1EFE9", display: "flex", alignItems: "center", justifyContent: "center", color: "#0A0E1A" }}>
                    <Icon size={20} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "#1A1917" }}>
                      {pick(g.title_en, g.title_es, locale)}
                    </div>
                    <div style={{ fontSize: 13, color: "#9E9B94", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {pick(g.summary_en, g.summary_es, locale) ||
                        `${g.step_count} ${t("steps", "pasos")}`}
                    </div>
                  </div>
                  <ChevronRight size={18} color="#9E9B94" />
                </div>
              </Link>
            );
          })}
        </div>
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
