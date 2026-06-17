import { useState, useEffect, useRef } from "react";
import type { ReactNode, CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { useLocation } from "wouter";
import { Settings2, ArrowUp, ArrowDown, X, RotateCcw, ChevronRight } from "lucide-react";

// Role-based, user-customizable MOBILE dashboard. Each user picks which cards
// to show and in what order; defaults differ by role but every card is in the
// shared library (no card is hidden by role). Preference persists per user via
// GET/PUT/DELETE /api/dashboard/card-prefs (reuses user_column_preferences,
// page='mobile_dashboard' — no schema change). Read-only on all metric data;
// the only writes are the user's own preference rows. Desktop is untouched.

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";
const CARD: CSSProperties = { backgroundColor: "#FFFFFF", border: "0.5px solid #E5E2DC", borderRadius: 12 };
const INK = "#1A1917";
const MUTE = "#6B7280";
const MINT = "#2D9B83";
const RED = "#E24B4A";

interface CardData {
  daily_revenue: number; revenue_booked_today: number; revenue_newly_booked_today: number; jobs_today: number; jobs_scheduled_today: number;
  late_clockins: number;
  todays_status: { in_progress: number; scheduled: number; complete: number; flagged: number; unassigned: number };
  unassigned_jobs: number; techs_today: number; next_7_days_jobs: number; next_7_days_revenue: number;
  leads: number; quotes: number; closed_quotes: number; close_rate: number; monthly_revenue: number;
  quotes_today: number; closed_quotes_today: number; close_rate_today: number;
  avg_bill: number; active_clients: number; rate_trend: number; avg_bill_12mo: number; retention: number;
  payroll_pct: number; payroll_window: string;
}

const money = (n: number) => `$${Math.round(n || 0).toLocaleString("en-US")}`;
const money2 = (n: number) => `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signPct = (n: number) => `${n > 0 ? "+" : ""}${n ?? 0}%`;

function Big({ t, c = INK }: { t: string; c?: string }) {
  return <span style={{ fontSize: 28, fontWeight: 800, color: c, fontFamily: FF, lineHeight: 1.1 }}>{t}</span>;
}

interface LibCard { key: string; label: string; sub?: string; render: (d: CardData) => ReactNode; }

// Full card library — every card available to every user.
const LIBRARY: LibCard[] = [
  { key: "revenue_booked_today", label: "Daily Revenue",        sub: "today's scheduled jobs", render: d => <Big t={money(d.revenue_booked_today)} /> },
  { key: "revenue_newly_booked_today", label: "Booked Today",   sub: "new jobs booked today",  render: d => <Big t={money(d.revenue_newly_booked_today)} /> },
  { key: "daily_revenue",        label: "Completed Today",      sub: "jobs marked complete",   render: d => <Big t={money(d.daily_revenue)} /> },
  { key: "jobs_today",           label: "Jobs Today",           render: d => <Big t={String(d.jobs_today)} /> },
  { key: "jobs_scheduled_today", label: "Jobs Scheduled Today", render: d => <Big t={String(d.jobs_scheduled_today)} /> },
  { key: "late_clockins",        label: "Late Clock-ins",       sub: "no clock-in past start +20m", render: d => <Big t={String(d.late_clockins)} c={d.late_clockins > 0 ? RED : INK} /> },
  { key: "todays_status",        label: "Today's Status",       render: d => {
      const s = d.todays_status;
      const items: [string, number][] = [["In progress", s.in_progress], ["Scheduled", s.scheduled], ["Complete", s.complete], ["Flagged", s.flagged], ["Unassigned", s.unassigned]];
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", marginTop: 2 }}>
          {items.map(([l, v]) => (
            <span key={l} style={{ fontSize: 13, fontFamily: FF, color: MUTE }}>
              <b style={{ color: INK, fontWeight: 800 }}>{v}</b> {l}
            </span>
          ))}
        </div>
      );
    } },
  { key: "unassigned_jobs",      label: "Unassigned Jobs",      render: d => <Big t={String(d.unassigned_jobs)} c={d.unassigned_jobs > 0 ? RED : INK} /> },
  { key: "techs_today",          label: "Techs Today",          sub: "working today",          render: d => <Big t={String(d.techs_today)} /> },
  { key: "next_7_days",          label: "Next 7 Days",          render: d => (
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <Big t={money(d.next_7_days_revenue)} />
        <span style={{ fontSize: 13, color: MUTE, fontFamily: FF }}>{d.next_7_days_jobs} jobs</span>
      </div>
    ) },
  { key: "quotes_today",         label: "Quotes Today",         sub: "created today",          render: d => <Big t={String(d.quotes_today)} /> },
  { key: "closed_quotes_today",  label: "Closed Today",         sub: "won, of today's quotes", render: d => <Big t={String(d.closed_quotes_today)} /> },
  { key: "close_rate_today",     label: "Close Rate Today",     sub: "closed / total, today",  render: d => <Big t={`${d.close_rate_today}%`} c={MINT} /> },
  { key: "leads",                label: "Leads",                sub: "this month",             render: d => <Big t={String(d.leads)} /> },
  { key: "quotes",               label: "Quotes",               sub: "this month",             render: d => <Big t={String(d.quotes)} /> },
  { key: "closed_quotes",        label: "Closed Quotes",        sub: "won this month",         render: d => <Big t={String(d.closed_quotes)} /> },
  { key: "close_rate",           label: "Close Rate",           sub: "closed / total, this month", render: d => <Big t={`${d.close_rate}%`} c={MINT} /> },
  { key: "monthly_revenue",      label: "Monthly Revenue",      sub: "month to date",          render: d => <Big t={money(d.monthly_revenue)} /> },
  { key: "avg_bill",             label: "Avg Bill",             sub: "per job, last 12 months", render: d => <Big t={money2(d.avg_bill)} /> },
  { key: "active_clients",       label: "Active Clients",       render: d => <Big t={String(d.active_clients)} /> },
  { key: "rate_trend",           label: "Rate Trend",           sub: "avg bill, 12mo vs prior 12mo", render: d => <Big t={signPct(d.rate_trend)} c={d.rate_trend < 0 ? RED : MINT} /> },
  { key: "retention",            label: "Retention",            sub: "recurring clients active", render: d => <Big t={`${d.retention}%`} c={MINT} /> },
  { key: "payroll_pct",          label: "Payroll %",            sub: "payroll / revenue, Apr 2026", render: d => <Big t={`${d.payroll_pct}%`} /> },
];
const LIB_KEYS = LIBRARY.map(l => l.key);
const cardDef = (k: string) => LIBRARY.find(l => l.key === k);

// Default sets shown before any customization.
const OWNER_DEFAULT = ["revenue_booked_today", "revenue_newly_booked_today", "jobs_today", "quotes_today", "closed_quotes_today", "close_rate_today", "leads", "quotes", "closed_quotes", "close_rate"];
const OFFICE_DEFAULT = ["jobs_scheduled_today", "late_clockins", "todays_status", "unassigned_jobs", "techs_today", "next_7_days"];
const roleDefault = (role: string) => (role === "owner" ? OWNER_DEFAULT : OFFICE_DEFAULT);

// Tap a metric card to open the underlying list/report it summarizes.
const CARD_HREF: Record<string, string> = {
  leads: "/leads",
  quotes: "/quotes", closed_quotes: "/quotes", close_rate: "/quotes",
  quotes_today: "/quotes", closed_quotes_today: "/quotes", close_rate_today: "/quotes",
  daily_revenue: "/reports/revenue", revenue_booked_today: "/reports/revenue", revenue_newly_booked_today: "/reports/revenue",
  monthly_revenue: "/reports/revenue", avg_bill: "/reports/revenue", rate_trend: "/reports/revenue",
  jobs_today: "/dispatch", jobs_scheduled_today: "/dispatch", unassigned_jobs: "/dispatch",
  todays_status: "/dispatch", late_clockins: "/dispatch", techs_today: "/dispatch", next_7_days: "/dispatch",
  active_clients: "/customers",
  retention: "/reports/satisfaction",
  payroll_pct: "/reports/payroll-to-revenue",
};

export default function MobileDashboard() {
  const { activeBranchId } = useBranch();
  const [, setLocation] = useLocation();
  const role = getTokenRole() || "office";

  const [data, setData] = useState<CardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customizing, setCustomizing] = useState(false);
  const [saving, setSaving] = useState(false);

  function applyDefault() {
    const def = roleDefault(role);
    setOrder([...def, ...LIB_KEYS.filter(k => !def.includes(k))]);
    setSelected(new Set(def));
  }

  // Load this user's saved preference (or fall back to the role default).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/api/dashboard/card-prefs`, { headers: getAuthHeaders() });
        const rows = await r.json();
        if (cancelled) return;
        const known = Array.isArray(rows) ? rows.filter((x: any) => LIB_KEYS.includes(x.card_key)) : [];
        if (known.length) {
          const ord = known.map((x: any) => x.card_key);
          for (const k of LIB_KEYS) if (!ord.includes(k)) ord.push(k);
          setOrder(ord);
          setSelected(new Set(known.filter((x: any) => x.visible).map((x: any) => x.card_key)));
        } else {
          applyDefault();
        }
      } catch {
        if (!cancelled) applyDefault();
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load metric data; re-fetch when the branch toggle changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const q = activeBranchId && activeBranchId !== "all" ? `?branch_id=${activeBranchId}` : "";
        const r = await fetch(`${API}/api/dashboard/mobile-cards${q}`, { headers: getAuthHeaders() });
        const d = await r.json();
        if (!cancelled) setData(d);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeBranchId]);

  const visibleKeys = order.filter(k => selected.has(k));

  async function savePrefs() {
    setSaving(true);
    try {
      const cards = order.map((k, i) => ({ card_key: k, visible: selected.has(k), sort_order: i }));
      await fetch(`${API}/api/dashboard/card-prefs`, {
        method: "PUT",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ cards }),
      });
      setCustomizing(false);
    } catch { /* keep picker open on failure */ }
    finally { setSaving(false); }
  }

  async function resetPrefs() {
    try { await fetch(`${API}/api/dashboard/card-prefs`, { method: "DELETE", headers: getAuthHeaders() }); } catch { /* ignore */ }
    applyDefault();
  }

  function toggle(k: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  }
  function move(k: string, dir: -1 | 1) {
    setOrder(prev => {
      const i = prev.indexOf(k);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  // ── Press-and-hold drag-to-reorder (mobile) ──────────────────────────────
  // Long-press a tile to pick it up, drag over another to reorder, release to
  // save (same per-user card-prefs endpoint). The Customize sheet's up/down
  // arrows remain as an alternative. A brief move before the hold fires reads
  // as a scroll/tap and cancels the pick-up, so normal scrolling is unaffected.
  const LONG_PRESS_MS = 320;
  const MOVE_CANCEL_PX = 8;
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const tileEls = useRef<Map<string, HTMLDivElement>>(new Map());

  function cancelPress() {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    pressStart.current = null;
  }

  function onTilePointerDown(e: ReactPointerEvent, k: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    didDrag.current = false;
    pressStart.current = { x: e.clientX, y: e.clientY };
    cancelPress();
    pressTimer.current = setTimeout(() => {
      didDrag.current = true;
      setDraggingKey(k);
      try { (navigator as any).vibrate?.(12); } catch { /* no haptics — fine */ }
    }, LONG_PRESS_MS);
  }

  // Move the dragged key to the slot of whichever VISIBLE tile the pointer is
  // over. Rects are read live so this stays correct as the DOM reflows.
  function reorderToward(dk: string, clientY: number) {
    for (const k of visibleKeys) {
      if (k === dk) continue;
      const el = tileEls.current.get(k);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        setOrder(prev => {
          const from = prev.indexOf(dk), toK = prev.indexOf(k);
          if (from < 0 || toK < 0 || from === toK) return prev;
          const next = [...prev];
          next.splice(from, 1);
          const insAt = next.indexOf(k);
          next.splice(from < toK ? insAt + 1 : insAt, 0, dk);
          return next;
        });
        break;
      }
    }
  }

  function onTilePointerMove(e: ReactPointerEvent) {
    if (draggingKey) { reorderToward(draggingKey, e.clientY); return; }
    if (pressStart.current) {
      const dx = e.clientX - pressStart.current.x;
      const dy = e.clientY - pressStart.current.y;
      if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) cancelPress(); // scroll/tap, not a hold
    }
  }

  function onTilePointerUp() {
    if (draggingKey) {
      setDraggingKey(null);
      savePrefs(); // reuse the existing per-user card-prefs PUT (persists current order)
    }
    cancelPress();
  }

  // While dragging, block page scroll so the finger moves the tile, not the page.
  useEffect(() => {
    if (!draggingKey) return;
    const prevent = (ev: TouchEvent) => ev.preventDefault();
    document.addEventListener("touchmove", prevent, { passive: false });
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("touchmove", prevent);
      document.body.style.userSelect = prevUserSelect;
    };
  }, [draggingKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, fontFamily: FF, paddingBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: INK }}>Dashboard</span>
        <button
          onClick={() => setCustomizing(true)}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 10, border: "1px solid #E5E2DC", background: "#FFFFFF", color: INK, fontSize: 13, fontWeight: 600, fontFamily: FF, cursor: "pointer" }}
        >
          <Settings2 size={15} /> Customize
        </button>
      </div>

      {!loading && data && visibleKeys.length > 1 && (
        <div style={{ fontSize: 11, color: "#9E9B94", marginTop: -4 }}>
          {draggingKey ? "Drop to place the card" : "Hold and drag a card to reorder"}
        </div>
      )}

      {loading && !data ? (
        <div style={{ ...CARD, padding: 24, textAlign: "center", color: MUTE, fontSize: 13 }}>Loading…</div>
      ) : visibleKeys.length === 0 ? (
        <div style={{ ...CARD, padding: 24, textAlign: "center", color: MUTE, fontSize: 13 }}>
          No cards selected. Tap Customize to add some.
        </div>
      ) : (
        visibleKeys.map(k => {
          const def = cardDef(k);
          if (!def || !data) return null;
          const dragging = draggingKey === k;
          return (
            <div key={k}
              ref={el => { if (el) tileEls.current.set(k, el); else tileEls.current.delete(k); }}
              onPointerDown={e => onTilePointerDown(e, k)}
              onPointerMove={onTilePointerMove}
              onPointerUp={onTilePointerUp}
              onPointerCancel={onTilePointerUp}
              onClick={() => {
                // A long-press drag also ends in a click — suppress navigation then.
                if (didDrag.current) { didDrag.current = false; return; }
                if (CARD_HREF[k]) setLocation(CARD_HREF[k]);
              }}
              style={{
                ...CARD, padding: 16, position: "relative",
                cursor: CARD_HREF[k] ? "pointer" : "default",
                touchAction: "pan-y", userSelect: "none",
                transition: dragging ? "none" : "transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease",
                transform: dragging ? "scale(1.03)" : "none",
                boxShadow: dragging ? "0 8px 24px rgba(0,0,0,0.16)" : "none",
                opacity: draggingKey && !dragging ? 0.85 : 1,
                zIndex: dragging ? 5 : undefined,
              }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.06em" }}>{def.label}</div>
              <div style={{ marginTop: 6 }}>{def.render(data)}</div>
              {def.sub && <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 4 }}>{def.sub}</div>}
              {CARD_HREF[k] && !draggingKey && <ChevronRight size={16} style={{ position: "absolute", top: 16, right: 14, color: "#C4C0B8" }} />}
            </div>
          );
        })
      )}

      {customizing && (
        <div
          onClick={() => setCustomizing(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9998, display: "flex", alignItems: "flex-end" }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: "#FFFFFF", borderTopLeftRadius: 16, borderTopRightRadius: 16, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", fontFamily: FF }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 16px 8px" }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: INK }}>Customize dashboard</span>
              <button onClick={() => setCustomizing(false)} style={{ background: "none", border: "none", cursor: "pointer", color: MUTE, padding: 4 }}><X size={18} /></button>
            </div>
            <div style={{ overflowY: "auto", padding: "0 12px 8px" }}>
              {order.map((k, i) => {
                const def = cardDef(k);
                if (!def) return null;
                const on = selected.has(k);
                return (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 8px", borderBottom: "0.5px solid #E5E2DC" }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(k)} style={{ cursor: "pointer", width: 16, height: 16 }} />
                    <span style={{ flex: 1, fontSize: 14, color: INK }}>{def.label}</span>
                    <button onClick={() => move(k, -1)} disabled={i === 0} style={arrowBtn(i === 0)}><ArrowUp size={15} /></button>
                    <button onClick={() => move(k, 1)} disabled={i === order.length - 1} style={arrowBtn(i === order.length - 1)}><ArrowDown size={15} /></button>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: 12, borderTop: "0.5px solid #E5E2DC", gap: 8 }}>
              <button onClick={resetPrefs} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 12px", borderRadius: 10, border: "1px solid #E5E2DC", background: "#FFFFFF", color: MUTE, fontSize: 13, fontWeight: 600, fontFamily: FF, cursor: "pointer" }}>
                <RotateCcw size={14} /> Reset to default
              </button>
              <button onClick={savePrefs} disabled={saving} style={{ padding: "10px 18px", borderRadius: 10, border: "none", background: MINT, color: "#FFFFFF", fontSize: 14, fontWeight: 700, fontFamily: FF, cursor: "pointer", opacity: saving ? 0.7 : 1 }}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function arrowBtn(disabled: boolean): CSSProperties {
  return { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: disabled ? "#C9C6BF" : "#6B6860", cursor: disabled ? "not-allowed" : "pointer" };
}
