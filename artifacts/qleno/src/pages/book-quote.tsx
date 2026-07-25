// ─────────────────────────────────────────────────────────────────────────────
// Book-from-quote page — the destination of the "Book" buttons in a quote email.
// A lead already answered everything to get the quote, so this does NOT restart
// the booking flow: it loads the quote by its public sign_token, shows a read-only
// summary, and asks for the ONLY two things still missing — a date and a card on
// file. On confirm it reuses the SAME public payment endpoints as the main widget
// (/book/setup → confirmCardSetup → /book/confirm), then marks the quote booked.
//
// Isolated by design: it never touches the main booking widget's state.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRoute } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
async function pub(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.error || `HTTP ${r.status}`), { status: r.status, body });
  return body;
}

const INK = "#1A1917", MUTE = "#6B6860", BORDER = "#E5E2DC", BRAND = "var(--brand)", BG = "#F7F6F3";
const FONT = "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif";
const money = (n: any) => `$${Number(n ?? 0).toFixed(2)}`;
// "~3.5 hours" from a quote's estimated hours; "" hides the line (mirrors the
// server's estTimeLabel so the page matches the quote email).
const estTime = (hours: string | null | undefined) => {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return "";
  const r = Math.round(h * 2) / 2;
  return `~${Number.isInteger(r) ? String(r) : r.toFixed(1)} ${r === 1 ? "hour" : "hours"}`;
};

const freqLabel = (f: string | null | undefined) => {
  const k = String(f || "").toLowerCase().replace(/[\s-]+/g, "_");
  return ({ onetime: "One-time", one_time: "One-time", weekly: "Weekly", biweekly: "Every 2 weeks",
    bi_weekly: "Every 2 weeks", every_2_weeks: "Every 2 weeks", every_4_weeks: "Every 4 weeks",
    monthly: "Monthly", quarterly: "Quarterly" } as Record<string, string>)[k] || (f ? String(f).replace(/_/g, " ") : "");
};

// [multi-option 2026-07-25] One of the alternates the office quoted alongside the
// primary. Saved on the quote as alternate_options; total is the pre-computed price.
interface AltOption {
  scope_id: number | null; scope_name: string; frequency: string | null;
  addon_ids: number[]; total: number | string | null;
}
interface Quote {
  quote_id: number; company_id: number; company_slug: string;
  first_name: string; last_name: string; email: string; phone: string; address: string;
  service_type: string | null; frequency: string | null; scope_id: number | null;
  addon_ids: number[]; addons: any[]; sqft: number | null; total_price: string | null;
  estimated_hours: string | null;
  bedrooms: number | null; bathrooms: number | null; half_baths: number | null;
  dirt_level: string | null; pets: number | null;
  alternate_options?: AltOption[] | null;
}

// A single bookable choice the client sees. The primary is built from the flat
// quote fields; alternates come from alternate_options.
interface BookOption {
  scope_id: number | null; scope_name: string; frequency: string | null;
  addon_ids: number[]; addons: any[]; total_price: string | null; estimated_hours: string | null;
}

export default function BookQuotePage() {
  const [, params] = useRoute("/book-quote/:token");
  const token = params?.token ?? "";

  const [quote, setQuote] = useState<Quote | null>(null);
  const [company, setCompany] = useState<any>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [booking, setBooking] = useState(false);
  const [bookErr, setBookErr] = useState("");
  const [done, setDone] = useState(false);
  const [optionIdx, setOptionIdx] = useState(0); // which quoted option the client picked

  // Stripe
  const [stripeEnabled, setStripeEnabled] = useState<boolean | null>(null);
  const [pubKey, setPubKey] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [cardReady, setCardReady] = useState(false);
  const stripeRef = useRef<any>(null);
  const cardRef = useRef<any>(null);

  const minDate = useMemo(() => {
    // Earliest bookable day: tomorrow (office confirms the exact window).
    const base = selectedDate ? null : null; void base;
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }, [selectedDate]);

  // [multi-option 2026-07-25] The full set of choices to show the client: the
  // primary (from the flat quote fields) first, then any alternates the office
  // added. The selected one drives the summary, price, and the booking payload.
  const options = useMemo<BookOption[]>(() => {
    if (!quote) return [];
    const primary: BookOption = {
      scope_id: quote.scope_id,
      scope_name: quote.service_type || "Cleaning",
      frequency: quote.frequency,
      addon_ids: quote.addon_ids || [],
      addons: quote.addons || [],
      total_price: quote.total_price,
      estimated_hours: quote.estimated_hours,
    };
    const alts: BookOption[] = (quote.alternate_options || []).map((a) => ({
      scope_id: a.scope_id,
      scope_name: a.scope_name || "Cleaning",
      frequency: a.frequency,
      addon_ids: Array.isArray(a.addon_ids) ? a.addon_ids : [],
      addons: [],
      total_price: a.total != null ? String(a.total) : null,
      estimated_hours: null,
    }));
    return [primary, ...alts];
  }, [quote]);
  const opt = options[optionIdx] || options[0] || null;

  // Load the quote + its company branding.
  useEffect(() => {
    if (!token) return;
    let alive = true;
    (async () => {
      try {
        const q = await pub(`/api/public/quote/${encodeURIComponent(token)}`);
        if (!alive) return;
        setQuote(q);
        try { const c = await pub(`/api/public/company/${q.company_slug}`); if (alive) setCompany(c); } catch { /* branding optional */ }
      } catch (e: any) {
        if (!alive) return;
        setLoadErr(e?.status === 410 ? "This quote has already been booked or is no longer available." : "We couldn't find this quote. It may have expired.");
      }
    })();
    return () => { alive = false; };
  }, [token]);

  // Kick off Stripe SetupIntent once the quote is loaded.
  useEffect(() => {
    if (!quote || stripeEnabled !== null) return;
    pub("/api/public/book/setup", {
      method: "POST",
      body: JSON.stringify({ company_id: quote.company_id, email: quote.email, first_name: quote.first_name, last_name: quote.last_name, phone: quote.phone }),
    }).then((res) => {
      if (!res.stripe_enabled) { setStripeEnabled(false); return; }
      setStripeEnabled(true); setPubKey(res.publishable_key); setClientSecret(res.client_secret); setCustomerId(res.customer_id);
    }).catch(() => setStripeEnabled(false));
  }, [quote, stripeEnabled]);

  // Mount the Stripe card element (mirrors the main widget's mount logic).
  useEffect(() => {
    if (!stripeEnabled || !clientSecret || !pubKey) return;
    setCardReady(false);
    const mount = () => {
      const Stripe = (window as any).Stripe;
      if (!Stripe) return;
      const stripe = Stripe(pubKey);
      const elements = stripe.elements();
      const card = elements.create("card", { style: { base: { fontFamily: FONT, fontSize: "16px", color: INK, "::placeholder": { color: "#9E9B94" } } } });
      const container = document.getElementById("stripe-card-quote");
      if (container) {
        container.innerHTML = "";
        card.mount("#stripe-card-quote");
        card.on("ready", () => setCardReady(true));
        stripeRef.current = stripe;
        cardRef.current = card;
      }
    };
    const existing = document.getElementById("stripe-js-quote");
    if (existing) {
      if ((window as any).Stripe) mount();
      else { const poll = setInterval(() => { if ((window as any).Stripe) { clearInterval(poll); mount(); } }, 50); return () => clearInterval(poll); }
      return;
    }
    const s = document.createElement("script");
    s.id = "stripe-js-quote"; s.src = "https://js.stripe.com/v3/"; s.onload = mount;
    document.head.appendChild(s);
    return () => { if (cardRef.current) { try { cardRef.current.unmount(); } catch { /* noop */ } } };
  }, [stripeEnabled, clientSecret, pubKey]);

  async function confirmBooking() {
    if (!quote || !selectedDate) { setBookErr("Please pick a date."); return; }
    setBooking(true); setBookErr("");
    try {
      let paymentMethodId: string | null = null;
      if (stripeEnabled && stripeRef.current && cardRef.current && clientSecret) {
        const { setupIntent, error } = await stripeRef.current.confirmCardSetup(clientSecret, {
          payment_method: { card: cardRef.current, billing_details: { name: `${quote.first_name} ${quote.last_name}`.trim(), email: quote.email, phone: quote.phone } },
        });
        if (error) {
          setBookErr(error.type === "validation_error" ? (error.message ?? "Please check your card details.") : "We couldn't verify your card. Please try a different one.");
          setBooking(false); return;
        }
        paymentMethodId = setupIntent.payment_method;
      }
      if (!paymentMethodId) { setBookErr("Card verification is required to book."); setBooking(false); return; }

      const result = await pub("/api/public/book/confirm", {
        method: "POST",
        body: JSON.stringify({
          company_id: quote.company_id,
          first_name: quote.first_name, last_name: quote.last_name, phone: quote.phone, email: quote.email,
          // Book the option the client picked (falls back to the primary).
          scope_id: (opt?.scope_id ?? quote.scope_id), sqft: quote.sqft, frequency: (opt?.frequency || quote.frequency || "onetime"),
          addon_ids: (opt?.addon_ids ?? quote.addon_ids ?? []),
          bedrooms: quote.bedrooms, bathrooms: quote.bathrooms, half_baths: quote.half_baths, pets: quote.pets,
          address: quote.address,
          preferred_date: selectedDate,
          payment_method_id: paymentMethodId,
          stripe_customer_id: customerId,
          quote_id: quote.quote_id, // marks the quote booked + stops its drip
          booking_location: null,
        }),
      });
      void result;
      setDone(true);
    } catch (e: any) {
      setBookErr(e?.body?.error || "Something went wrong booking your cleaning. Please call us and we'll finish it for you.");
    } finally { setBooking(false); }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  const wrap: CSSProperties = { minHeight: "100vh", background: BG, fontFamily: FONT, color: INK, padding: "32px 16px" };
  const card: CSSProperties = { maxWidth: 560, margin: "0 auto", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 14, overflow: "hidden" };

  if (loadErr) return <div style={wrap}><div style={{ ...card, padding: 32, textAlign: "center" }}>
    <p style={{ fontSize: 18, fontWeight: 800, margin: "0 0 6px" }}>Quote unavailable</p>
    <p style={{ fontSize: 14, color: MUTE, margin: 0 }}>{loadErr}</p>
  </div></div>;

  if (!quote) return <div style={wrap}><div style={{ ...card, padding: 32, textAlign: "center", color: MUTE }}>Loading your quote…</div></div>;

  const cn = company?.name || "Phes";
  if (done) return <div style={wrap}><div style={{ ...card, padding: 36, textAlign: "center" }}>
    <div style={{ width: 52, height: 52, borderRadius: 26, background: "#E4F8F2", color: "#048E72", fontSize: 26, fontWeight: 800, lineHeight: "52px", margin: "0 auto 14px" }}>✓</div>
    <p style={{ fontSize: 20, fontWeight: 800, margin: "0 0 6px" }}>You're booked!</p>
    <p style={{ fontSize: 14, color: MUTE, margin: "0 0 4px", lineHeight: 1.6 }}>Your {opt?.scope_name || "cleaning"} is scheduled for {new Date(selectedDate + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}. We've saved your card and will confirm your arrival window shortly.</p>
    <p style={{ fontSize: 13, color: MUTE, margin: "12px 0 0" }}>A confirmation email from {cn} is on its way.</p>
  </div></div>;

  const rows: { label: string; amount: string }[] = [];
  if (quote.total_price != null) {
    if (quote.service_type) rows.push({ label: quote.service_type, amount: "" });
  }

  return <div style={wrap}>
    <div style={card}>
      <div style={{ padding: "22px 28px 18px", borderBottom: `3px solid ${BRAND}`, textAlign: "center" }}>
        {company?.logo_url ? <img src={company.logo_url} alt={cn} height={54} style={{ height: 54, width: "auto" }} /> : <span style={{ fontSize: 20, fontWeight: 800 }}>{cn}</span>}
      </div>
      <div style={{ padding: "24px 28px 30px" }}>
        {options.length > 1 ? <>
          {/* [multi-option 2026-07-25] The office quoted more than one option — let
              the client pick. Selection drives the summary, price, and booking. */}
          <p style={{ fontSize: 20, fontWeight: 800, margin: "0 0 4px" }}>Choose your cleaning</p>
          <p style={{ fontSize: 14, color: MUTE, margin: "0 0 18px", lineHeight: 1.6 }}>Hi {quote.first_name || "there"} — here are your options. Pick whichever works best, choose a date, and add a card. Nothing is charged until the day of service.</p>

          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: MUTE, display: "block", marginBottom: 8 }}>Your options</label>
          <div style={{ marginBottom: 20 }}>
            {options.map((o, i) => {
              const sel = i === optionIdx;
              return (
                <div key={i} onClick={() => setOptionIdx(i)}
                  style={{ border: sel ? `1.5px solid ${BRAND}` : `1px solid ${BORDER}`, background: sel ? "var(--brand-soft, #EAF9F4)" : "#fff", borderRadius: 10, padding: "14px 16px", marginBottom: 10, cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 12, transition: "all .15s" }}>
                  <span style={{ width: 18, height: 18, borderRadius: 9, border: `2px solid ${sel ? BRAND : BORDER}`, flexShrink: 0, marginTop: 2, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {sel && <span style={{ width: 9, height: 9, borderRadius: 5, background: BRAND }} />}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 800 }}>{o.scope_name}{o.frequency ? <span style={{ color: MUTE, fontWeight: 600 }}> · {freqLabel(o.frequency)}</span> : null}{i === 0 ? <span style={{ display: "inline-block", fontSize: 10.5, fontWeight: 700, color: "#048E72", background: "#E4F8F2", borderRadius: 6, padding: "2px 7px", marginLeft: 6, verticalAlign: "middle" }}>RECOMMENDED</span> : null}</div>
                    {estTime(o.estimated_hours) && <div style={{ fontSize: 12.5, color: MUTE, marginTop: 4 }}>Estimated time · {estTime(o.estimated_hours)}</div>}
                    {o.addons.length > 0 && <div style={{ fontSize: 12.5, color: MUTE, marginTop: 4 }}>Includes: {o.addons.map((a: any) => a?.name).filter(Boolean).join(" · ")}</div>}
                  </div>
                  <span style={{ fontSize: 16, fontWeight: 800, flexShrink: 0 }}>{money(o.total_price)}</span>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 12.5, color: MUTE, marginBottom: 20 }}>{quote.address}</div>
        </> : <>
          <p style={{ fontSize: 20, fontWeight: 800, margin: "0 0 4px" }}>Book your {opt?.scope_name || "cleaning"}</p>
          <p style={{ fontSize: 14, color: MUTE, margin: "0 0 20px", lineHeight: 1.6 }}>Hi {quote.first_name || "there"} — everything from your quote is set. Just pick a date and add a card, and you're booked. No need to re-enter anything.</p>

          {/* Quote summary */}
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>{opt?.scope_name || "Cleaning"}{opt?.frequency ? <span style={{ color: MUTE, fontWeight: 600 }}> · {freqLabel(opt.frequency)}</span> : null}</span>
              <span style={{ fontSize: 16, fontWeight: 800 }}>{money(opt?.total_price)}</span>
            </div>
            <div style={{ fontSize: 12.5, color: MUTE }}>{quote.address}</div>
            {estTime(opt?.estimated_hours) && <div style={{ fontSize: 12.5, color: MUTE, marginTop: 6 }}>Estimated time · {estTime(opt?.estimated_hours)}</div>}
            {(opt?.addons?.length ?? 0) > 0 && <div style={{ fontSize: 12.5, color: MUTE, marginTop: 6 }}>Includes: {opt!.addons.map((a: any) => a?.name).filter(Boolean).join(" · ")}</div>}
          </div>
        </>}

        {/* Date */}
        <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: MUTE, display: "block", marginBottom: 6 }}>Preferred date</label>
        <input type="date" min={minDate} value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
          style={{ width: "100%", padding: "11px 13px", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 15, fontFamily: FONT, boxSizing: "border-box", marginBottom: 4 }} />
        <p style={{ fontSize: 11.5, color: MUTE, margin: "5px 0 20px" }}>We'll confirm your arrival window by text once scheduled.</p>

        {/* Card */}
        <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: MUTE, display: "block", marginBottom: 6 }}>Card on file</label>
        {stripeEnabled === false
          ? <p style={{ fontSize: 13, color: "#B45309", margin: "0 0 16px" }}>Online card entry is momentarily unavailable — please call us and we'll finish your booking.</p>
          : <div id="stripe-card-quote" style={{ padding: "13px 13px", border: `1px solid ${BORDER}`, borderRadius: 8, marginBottom: 6, background: "#fff", minHeight: 46 }} />}
        <p style={{ fontSize: 11.5, color: MUTE, margin: "5px 0 18px" }}>Your card is saved securely with Stripe and charged on the day of service — nothing now.</p>

        {bookErr && <p style={{ fontSize: 13, color: "#C0392B", margin: "0 0 12px" }}>{bookErr}</p>}

        <button
          onClick={confirmBooking}
          disabled={booking || !selectedDate || (stripeEnabled !== false && !cardReady)}
          style={{ width: "100%", padding: "14px", border: "none", borderRadius: 10, background: BRAND, color: "#052e26", fontSize: 16, fontWeight: 800, cursor: "pointer", fontFamily: FONT, opacity: (booking || !selectedDate || (stripeEnabled !== false && !cardReady)) ? 0.55 : 1 }}>
          {booking ? "Booking…" : `Confirm & book — ${money(opt?.total_price)}`}
        </button>
      </div>
    </div>
  </div>;
}
