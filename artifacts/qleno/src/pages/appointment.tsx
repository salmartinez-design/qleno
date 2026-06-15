import { useEffect, useState } from "react";
import { useRoute } from "wouter";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const BG = "#F7F6F3";
const CARD = "#FFFFFF";
const INK = "#1A1917";
const MUTE = "#6B7280";
const BORDER = "#E5E2DC";
const ACCENT = "#00C9A0";

type Appt = {
  client_first: string | null;
  status: "scheduled" | "in_progress" | "complete" | "cancelled";
  scheduled_date: string | null;
  scheduled_time: string | null;
  arrival_window: string | null;
  service_type: string;
  service_address: string | null;
  tech_first: string | null;
  company_name: string;
  company_logo: string | null;
  company_brand_color: string | null;
  company_phone: string | null;
  company_email: string | null;
};

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
        setAppt(await r.json());
      } catch {
        setError("Something went wrong.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const brand = appt?.company_brand_color || ACCENT;

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
  const rows: Array<[string, string | null]> = [
    ["Date", appt.scheduled_date ? fmtDate(appt.scheduled_date) : null],
    ["Time", appt.scheduled_time ? fmtTime(appt.scheduled_time) : (appt.arrival_window || "Scheduled window")],
    ["Service", appt.service_type],
    ["Address", appt.service_address],
    ["Your cleaner", appt.tech_first],
  ];

  return (
    <div style={wrap}>
      <div style={card}>
        {/* Branded header */}
        <div style={{ background: brand, padding: "20px 28px", display: "flex", alignItems: "center", gap: 12 }}>
          {appt.company_logo
            ? <img src={appt.company_logo} alt={appt.company_name} style={{ height: 32, maxWidth: 160, objectFit: "contain" }} />
            : <span style={{ color: "#fff", fontSize: 20, fontWeight: 800 }}>{appt.company_name}</span>}
        </div>

        <div style={{ padding: 28 }}>
          <div style={{ display: "inline-block", padding: "4px 12px", borderRadius: 999, fontSize: 12, fontWeight: 700, background: st.bg, color: st.fg, marginBottom: 16 }}>
            {st.label}
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 6px" }}>
            {appt.status === "complete" ? "Your cleaning is complete" : "Your cleaning is confirmed"}
          </h1>
          <p style={{ color: MUTE, fontSize: 14, margin: "0 0 24px" }}>
            {appt.client_first ? `Hi ${appt.client_first}, here are your appointment details.` : "Here are your appointment details."}
          </p>

          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10 }}>
            {rows.filter(([, v]) => v).map(([label, value], i, arr) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "13px 16px", borderBottom: i < arr.length - 1 ? `1px solid ${BORDER}` : "none" }}>
                <span style={{ color: MUTE, fontSize: 13 }}>{label}</span>
                <span style={{ fontWeight: 600, fontSize: 14, textAlign: "right" }}>{value}</span>
              </div>
            ))}
          </div>

          {(appt.company_phone || appt.company_email) && (
            <p style={{ color: MUTE, fontSize: 13, margin: "20px 0 0", textAlign: "center" }}>
              Questions? Contact {appt.company_name}
              {appt.company_phone ? ` at ${appt.company_phone}` : ""}
              {appt.company_email ? ` · ${appt.company_email}` : ""}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
