import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { QlenoMark } from "@/components/brand/QlenoMark";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const BG = "#F7F6F3";
const CARD = "#FFFFFF";
const INK = "#1A1917";
const MUTE = "#6B6860";
const BORDER = "#E5E2DC";
const MINT = "#00C9A0";
// Locked brand palette (same as Pass 1, the quote page).
const NAVY = "#0A0E1A";
const SUBLINE = "#9DA3B0";
// Real Phes logo asset (public/) — same asset Pass 1 resolved. Used when the
// tenant has no logo_url of its own.
const PHES_LOGO = `${API}/phes-logo.jpeg`;
// Branch contact fallback (used only if the tenant record has no phone/email).
const FALLBACK_PHONE = "(847) 538-3729";
const FALLBACK_PHONE_TEL = "+18475383729";
const FALLBACK_EMAIL = "schaumburg@phes.io";

type Appt = {
  client_first: string | null;
  status: "scheduled" | "in_progress" | "complete" | "cancelled";
  scheduled_date: string | null;
  scheduled_time: string | null;
  arrival_window: string | null;
  service_type: string;
  service_address: string | null;
  tech_first: string | null;
  tech_avatar: string | null;
  company_name: string;
  company_logo: string | null;
  company_brand_color: string | null;
  company_phone: string | null;
  company_email: string | null;
};

// Round cleaner avatar — the tech's existing profile photo, or an initial-on-mint
// fallback so it's never a broken image. First name only is shown elsewhere.
function CleanerAvatar({ photo, name, size }: { photo: string | null; name: string | null; size: number }) {
  const [broken, setBroken] = useState(false);
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const base: React.CSSProperties = { width: size, height: size, borderRadius: "50%", flexShrink: 0 };
  if (photo && !broken) {
    return <img src={photo} alt={name || "Your cleaner"} onError={() => setBroken(true)}
      style={{ ...base, objectFit: "cover", border: `1px solid ${BORDER}` }} />;
  }
  return (
    <div style={{ ...base, background: MINT, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: Math.round(size * 0.42) }}>
      {initial}
    </div>
  );
}

const fmtDate = (d: string) => {
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
};

const fmtTime = (t: string) => {
  const [h, min] = String(t).split(":").map(Number);
  if (Number.isNaN(h)) return t;
  const ampm = h < 12 ? "AM" : "PM";
  const hour = h % 12 || 12;
  return `${hour}:${String(min || 0).padStart(2, "0")} ${ampm}`;
};

const STATUS_LABEL: Record<Appt["status"], { label: string; bg: string; fg: string }> = {
  scheduled:   { label: "Scheduled", bg: "#EAF7F3", fg: "#0A7C63" },
  in_progress: { label: "In progress", bg: "#FEF3E2", fg: "#B26B00" },
  complete:    { label: "Completed", bg: "#EAF7F3", fg: "#0A7C63" },
  cancelled:   { label: "Cancelled", bg: "#FBEAEA", fg: "#B42318" },
};

// [booking-confirmation GAP1] Customer-facing, no-login appointment view — the
// link the booking confirmation email/SMS carries. Branded with the tenant's
// name/logo/brand color. Read-only.
export default function AppointmentPage() {
  const [, params] = useRoute("/appointment/:token");
  const token = params?.token ?? "";
  const [appt, setAppt] = useState<Appt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/api/appointment/${encodeURIComponent(token)}`);
        if (!r.ok) { setError(r.status === 404 ? "We couldn't find this appointment." : "Something went wrong."); return; }
        const data = await r.json();
        setAppt(data);
        // Set og:image so SMS/iMessage link preview shows the company logo
        if (data?.company_logo) {
          const logoUrl = data.company_logo.startsWith("http") ? data.company_logo : `${window.location.origin}${data.company_logo}`;
          let ogImg = document.querySelector<HTMLMetaElement>('meta[property="og:image"]');
          if (!ogImg) { ogImg = document.createElement("meta"); ogImg.setAttribute("property", "og:image"); document.head.appendChild(ogImg); }
          ogImg.setAttribute("content", logoUrl);
        }
      } catch {
        setError("Something went wrong.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const wrap: React.CSSProperties = {
    minHeight: "100vh", background: BG, fontFamily: FF, color: INK,
    padding: "32px 16px", display: "flex", justifyContent: "center", alignItems: "flex-start",
  };
  const card: React.CSSProperties = {
    width: "100%", maxWidth: 540, background: CARD, border: `1px solid ${BORDER}`,
    borderRadius: 14, overflow: "hidden",
  };

  if (loading) {
    return <div style={wrap}><div style={{ ...card, padding: 32, textAlign: "center", color: MUTE }}>Loading…</div></div>;
  }
  if (error || !appt) {
    return (
      <div style={wrap}>
        <div style={{ ...card, padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Appointment not found</div>
          <div style={{ color: MUTE, fontSize: 14 }}>{error || "We couldn't find this appointment."}</div>
        </div>
      </div>
    );
  }

  const st = STATUS_LABEL[appt.status] || STATUS_LABEL.scheduled;
  const logoSrc = appt.company_logo || PHES_LOGO;
  const timeLabel = appt.scheduled_time ? fmtTime(appt.scheduled_time) : (appt.arrival_window || "Scheduled window");
  const mapsHref = appt.service_address ? `https://maps.google.com/?q=${encodeURIComponent(appt.service_address)}` : null;
  // Tenant contact from the record, falling back to the branch defaults.
  const phone = appt.company_phone || FALLBACK_PHONE;
  const phoneTel = appt.company_phone ? appt.company_phone.replace(/[^\d+]/g, "") : FALLBACK_PHONE_TEL;
  const email = appt.company_email || FALLBACK_EMAIL;

  const rowWrap: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 16, padding: "13px 16px", alignItems: "center" };
  const labelStyle: React.CSSProperties = { color: MUTE, fontSize: 13 };
  const valStyle: React.CSSProperties = { fontWeight: 600, fontSize: 14, color: INK, textAlign: "right" };

  // Plain rows (cleaner row is rendered separately with the avatar).
  const rows: Array<[string, React.ReactNode]> = [];
  if (appt.scheduled_date) rows.push(["Date", fmtDate(appt.scheduled_date)]);
  rows.push(["Time", timeLabel]);
  if (appt.service_type) rows.push(["Service", appt.service_type]);
  if (appt.service_address) rows.push(["Address",
    <a href={mapsHref!} target="_blank" rel="noreferrer" style={{ ...valStyle, color: INK, textDecoration: "none" }}>{appt.service_address}</a>,
  ]);

  return (
    <div style={wrap}>
      <div style={card}>
        {/* Navy masthead — logo + wordmark + subline */}
        <div style={{ background: NAVY, padding: "20px 28px", display: "flex", alignItems: "center", gap: 13 }}>
          <img src={logoSrc} alt={appt.company_name} style={{ height: 44, maxWidth: 140, width: "auto", objectFit: "contain" }} />
          <div>
            <p style={{ fontSize: 18, fontWeight: 700, color: "#FFFFFF", margin: 0, letterSpacing: "-0.01em" }}>{appt.company_name}</p>
            <p style={{ fontSize: 12, color: SUBLINE, margin: "2px 0 0" }}>Residential &amp; Commercial Cleaning</p>
          </div>
        </div>

        <div style={{ padding: 28 }}>
          <div style={{ display: "inline-block", padding: "4px 12px", borderRadius: 999, fontSize: 12, fontWeight: 700, background: st.bg, color: st.fg, marginBottom: 16 }}>
            {st.label}
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: INK, margin: "0 0 6px" }}>
            {appt.status === "complete" ? "Your cleaning is complete" : "Your cleaning is confirmed"}
          </h1>
          <p style={{ color: MUTE, fontSize: 14, margin: "0 0 24px" }}>
            {appt.client_first ? `Hi ${appt.client_first}, here are your appointment details.` : "Here are your appointment details."}
          </p>

          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
            {rows.map(([label, value]) => (
              <div key={label as string} style={{ ...rowWrap, borderBottom: `1px solid ${BORDER}` }}>
                <span style={labelStyle}>{label}</span>
                <span style={valStyle}>{value}</span>
              </div>
            ))}
            {/* Your cleaner — round avatar (photo or initial) + first name only */}
            {appt.tech_first && (
              <div style={rowWrap}>
                <span style={labelStyle}>Your cleaner</span>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={valStyle}>{appt.tech_first}</span>
                  <CleanerAvatar photo={appt.tech_avatar} name={appt.tech_first} size={40} />
                </span>
              </div>
            )}
          </div>

          {/* Contact block */}
          <p style={{ color: MUTE, fontSize: 13, margin: "22px 0 0", textAlign: "center", lineHeight: 1.6 }}>
            Questions? Call or text{" "}
            <a href={`tel:${phoneTel}`} style={{ color: INK, fontWeight: 700, textDecoration: "none" }}>{phone}</a>
            {" · "}
            <a href={`mailto:${email}`} style={{ color: INK, fontWeight: 700, textDecoration: "none" }}>{email}</a>
          </p>

          {/* Footer — Powered by Qleno (only Qleno mention) */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 18, paddingTop: 16, borderTop: `1px solid ${BORDER}` }}>
            <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 500 }}>Powered by</span>
            <QlenoMark size={15} />
            <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 700 }}>Qleno</span>
          </div>
        </div>
      </div>
    </div>
  );
}
