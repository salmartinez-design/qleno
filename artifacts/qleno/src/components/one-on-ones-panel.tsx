// [one-on-ones 2026-07-14] Owner-only "1-on-1s" tab on the employee profile.
// Lists a tech's quarterly check-ins and lets the owner conduct one: their
// scorecard up top, the standard questions to fill, private notes, then
// Complete. Everything here is gated to the owner both in the UI (the tab only
// renders for isOwner) and on the server (every /api/one-on-ones route is
// requireRole("owner")). No SMS/email ever fires.
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { MessageSquare, Plus, ChevronLeft, Trash2, Check, ChevronRight } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";

const FF = "'Plus Jakarta Sans', sans-serif";
const BRAND = "var(--brand, #00C9A0)";

interface QuestionDef { id: string; section: string; label: string; hint?: string }
interface Scorecard {
  score_pct?: number | null; responses?: number; composite_pct?: number | null;
  satisfaction_pct?: number | null; attendance_pct?: number | null; complaint_free_pct?: number | null;
  window?: { label?: string; from?: string; to?: string };
}
interface Rec {
  id: number; period_label: string; event_date: string; status: string;
  scorecard_pct: string | number | null; employee_name?: string | null;
}
interface Detail extends Rec {
  questions: QuestionDef[] | null;
  responses: Record<string, string> | null;
  notes: string | null;
  scorecard_snapshot: Scorecard | null;
  live_scorecard: Scorecard | null;
}

const authHeaders = () => getAuthHeaders() as Record<string, string>;
const fmtDate = (d: string) => { try { return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch { return d; } };
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const pct = (v: string | number | null | undefined) => (v == null || v === "" ? "—" : `${Math.round(parseFloat(String(v)))}%`);

export function OneOnOnesPanel({ userId, employeeName }: { userId: number; employeeName: string }) {
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [list, setList] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/one-on-ones?employee_id=${userId}`, { headers: authHeaders() });
      setList(r.ok ? await r.json() : []);
    } catch { setList([]); }
    finally { setLoading(false); }
  }, [API, userId]);

  useEffect(() => { loadList(); }, [loadList]);

  const openRecord = useCallback(async (id: number) => {
    setOpeningId(id); setError(null);
    try {
      const r = await fetch(`${API}/api/one-on-ones/${id}`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: Detail = await r.json();
      setDetail(d);
      setResponses(d.responses ?? {});
      setNotes(d.notes ?? "");
    } catch (e: any) {
      setError(e?.message || "Could not open this 1-on-1.");
    } finally { setOpeningId(null); }
  }, [API]);

  const schedule = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${API}/api/one-on-ones`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ employee_id: userId, event_date: todayLocal() }),
      });
      if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error((() => { try { return JSON.parse(t).error; } catch { return `HTTP ${r.status}`; } })()); }
      const rec = await r.json();
      await loadList();
      await openRecord(rec.id);
    } catch (e: any) {
      setError(e?.message || "Could not schedule the 1-on-1.");
    } finally { setBusy(false); }
  }, [API, userId, loadList, openRecord]);

  const save = useCallback(async (complete: boolean) => {
    if (!detail) return;
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { responses, notes };
      if (complete) body.status = "completed";
      const r = await fetch(`${API}/api/one-on-ones/${detail.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const updated = await r.json();
      setDetail(d => (d ? { ...d, ...updated } : d));
      await loadList();
    } catch (e: any) {
      setError(e?.message || "Could not save.");
    } finally { setBusy(false); }
  }, [API, detail, responses, notes, loadList]);

  const remove = useCallback(async (id: number) => {
    if (!window.confirm("Delete this 1-on-1 and its board block? This can't be undone.")) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${API}/api/one-on-ones/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setDetail(null);
      await loadList();
    } catch (e: any) {
      setError(e?.message || "Could not delete.");
    } finally { setBusy(false); }
  }, [API, loadList]);

  // ─── Conduct view ──────────────────────────────────────────────────────────
  if (detail) {
    const sc = detail.live_scorecard || detail.scorecard_snapshot || {};
    const questions = detail.questions ?? [];
    const isComplete = detail.status === "completed";
    return (
      <div style={{ fontFamily: FF }}>
        <button onClick={() => setDetail(null)} style={{ display: "flex", alignItems: "center", gap: 5, border: "none", background: "none", cursor: "pointer", color: "#6B6860", fontSize: 13, fontWeight: 600, padding: 0, marginBottom: 14 }}>
          <ChevronLeft size={15} /> All 1-on-1s
        </button>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#1A1917" }}>{detail.period_label} 1-on-1 · {employeeName}</div>
            <div style={{ fontSize: 12.5, color: "#9E9B94", marginTop: 2 }}>{fmtDate(detail.event_date)} · {isComplete ? "Completed" : "In progress"} · Owner-only</div>
          </div>
          <button onClick={() => remove(detail.id)} disabled={busy} style={{ display: "flex", alignItems: "center", gap: 5, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#B91C1C", borderRadius: 9, padding: "7px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
            <Trash2 size={13} /> Delete
          </button>
        </div>

        {/* Scorecard header */}
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 16, marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: "#9E9B94", marginBottom: 10 }}>Scorecard · {sc.window?.label ?? detail.period_label}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "baseline" }}>
            <div>
              <div style={{ fontSize: 32, fontWeight: 800, color: "#1A1917", lineHeight: 1 }}>{pct(sc.composite_pct ?? sc.score_pct ?? detail.scorecard_pct)}</div>
              <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 3 }}>Composite ({sc.responses ?? 0} responses)</div>
            </div>
            {[
              { label: "Satisfaction", v: sc.satisfaction_pct },
              { label: "Attendance", v: sc.attendance_pct },
              { label: "Complaint-free", v: sc.complaint_free_pct },
            ].map(m => (
              <div key={m.label}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#44413B" }}>{pct(m.v)}</div>
                <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 3 }}>{m.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Questions */}
        {questions.map(q => (
          <div key={q.id} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: BRAND, marginBottom: 4 }}>{q.section}</div>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: "#1A1917", marginBottom: 6 }}>{q.label}</label>
            {q.hint && <div style={{ fontSize: 12, color: "#9E9B94", marginBottom: 6 }}>{q.hint}</div>}
            <textarea
              value={responses[q.id] ?? ""}
              onChange={e => setResponses(r => ({ ...r, [q.id]: e.target.value }))}
              placeholder="Capture what they shared…"
              style={{ width: "100%", minHeight: 68, resize: "vertical", padding: "10px 12px", borderRadius: 10, border: "1px solid #E5E2DC", fontSize: 14, fontFamily: FF, color: "#1A1917", boxSizing: "border-box" }}
            />
          </div>
        ))}

        {/* Private notes */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: "#9E9B94", marginBottom: 4 }}>Private notes / follow-ups</div>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Your own notes — never shared."
            style={{ width: "100%", minHeight: 80, resize: "vertical", padding: "10px 12px", borderRadius: 10, border: "1px solid #E5E2DC", fontSize: 14, fontFamily: FF, color: "#1A1917", boxSizing: "border-box" }}
          />
        </div>

        {error && <div style={{ marginBottom: 12, padding: "9px 12px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", color: "#B91C1C", fontSize: 13 }}>{error}</div>}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={() => save(false)} disabled={busy} style={{ padding: "11px 20px", borderRadius: 10, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#1A1917", fontWeight: 700, fontSize: 14, cursor: busy ? "default" : "pointer", fontFamily: FF }}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button onClick={() => save(true)} disabled={busy} style={{ display: "flex", alignItems: "center", gap: 6, padding: "11px 22px", borderRadius: 10, border: "none", background: BRAND, color: "#0A0E1A", fontWeight: 800, fontSize: 14, cursor: busy ? "default" : "pointer", fontFamily: FF }}>
            <Check size={15} /> {isComplete ? "Save & keep completed" : "Complete 1-on-1"}
          </button>
        </div>
      </div>
    );
  }

  // ─── List view ─────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: FF }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#1A1917" }}>1-on-1 check-ins</div>
        <button onClick={schedule} disabled={busy} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: "none", background: BRAND, color: "#0A0E1A", fontWeight: 800, fontSize: 13.5, cursor: busy ? "default" : "pointer", fontFamily: FF }}>
          <Plus size={15} /> {busy ? "Scheduling…" : "New 1-on-1"}
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: "#9E9B94", marginBottom: 16, display: "flex", alignItems: "center", gap: 6 }}>
        <MessageSquare size={13} /> Owner-only. These conversations are private to you — not visible to {employeeName} or any office staff.
      </div>

      {error && <div style={{ marginBottom: 12, padding: "9px 12px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA", color: "#B91C1C", fontSize: 13 }}>{error}</div>}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>Loading…</div>
      ) : list.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13, border: "1px dashed #E5E2DC", borderRadius: 12 }}>
          No 1-on-1s yet. Start one with <strong>New 1-on-1</strong>, or schedule it from the dispatch board (+ New → Event → 1-on-1).
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map(rec => (
            <button
              key={rec.id}
              onClick={() => openRecord(rec.id)}
              disabled={openingId === rec.id}
              style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", borderRadius: 11, border: "1px solid #E5E2DC", background: "#FFFFFF", cursor: "pointer", textAlign: "left", fontFamily: FF }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = "#CFCAC1")}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "#E5E2DC")}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{rec.period_label}</div>
                <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 2 }}>{fmtDate(rec.event_date)}</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#44413B" }}>{pct(rec.scorecard_pct)}</div>
              <span style={{
                fontSize: 10, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", borderRadius: 5, padding: "3px 8px",
                ...(rec.status === "completed"
                  ? { color: "#166534", background: "#DCFCE7", border: "1px solid #BBF7D0" }
                  : { color: "#8A6D3B", background: "#FCF3E3", border: "1px solid #ECD9B5" }),
              }}>{rec.status === "completed" ? "Completed" : "Scheduled"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Coverage card ───────────────────────────────────────────────────────────
// [one-on-ones 2026-07-14] Owner-only card for the Employees page: at a glance,
// who has / hasn't had their 1-on-1 this quarter, so nobody slips through. Click
// a person to jump to their profile 1-on-1s tab.
interface CoverageRow { employee_id: number; name: string | null; role: string; status: string; one_on_one_id: number | null; event_date: string | null }
interface CoveragePayload { period_label: string; total: number; completed: number; coverage: CoverageRow[] }

export function OneOnOneCoverageCard() {
  const API = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [, navigate] = useLocation();
  const [data, setData] = useState<CoveragePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/api/one-on-ones/coverage?period=quarter`, { headers: authHeaders() });
        setData(r.ok ? await r.json() : null);
      } catch { setData(null); }
      finally { setLoading(false); }
    })();
  }, [API]);

  if (loading || !data || data.total === 0) return null;
  const pending = data.coverage.filter(c => c.status !== "completed");
  const done = data.completed;
  const frac = data.total ? done / data.total : 0;

  return (
    <div style={{ marginTop: 28, background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, overflow: "hidden", fontFamily: FF }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", border: "none", background: "none", cursor: "pointer", textAlign: "left", fontFamily: FF }}
      >
        <MessageSquare size={16} style={{ color: BRAND, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#1A1917" }}>{data.period_label} 1-on-1 coverage</div>
          <div style={{ fontSize: 12, color: "#9E9B94", marginTop: 2 }}>{done} of {data.total} done · {pending.length} still to meet · owner-only</div>
        </div>
        <div style={{ width: 120, flexShrink: 0 }}>
          <div style={{ height: 7, borderRadius: 4, background: "#EFEDE8", overflow: "hidden" }}>
            <div style={{ width: `${Math.round(frac * 100)}%`, height: "100%", background: BRAND }} />
          </div>
        </div>
        <ChevronRight size={16} style={{ color: "#9E9B94", flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
      </button>
      {open && (
        <div style={{ borderTop: "1px solid #EEECE7", padding: "6px 8px 10px" }}>
          {data.coverage.map(c => {
            const label = c.status === "completed" ? "Done" : c.status === "scheduled" ? "Scheduled" : "Not yet";
            const tone = c.status === "completed"
              ? { color: "#166534", background: "#DCFCE7", border: "1px solid #BBF7D0" }
              : c.status === "scheduled"
                ? { color: "#8A6D3B", background: "#FCF3E3", border: "1px solid #ECD9B5" }
                : { color: "#9A3412", background: "#FFEDD5", border: "1px solid #FED7AA" };
            return (
              <button
                key={c.employee_id}
                onClick={() => navigate(`/employees/${c.employee_id}?tab=one-on-ones`)}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "none", background: "none", cursor: "pointer", textAlign: "left", borderRadius: 8, fontFamily: FF }}
                onMouseEnter={e => (e.currentTarget.style.background = "#F7F6F3")}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}
              >
                <span style={{ minWidth: 0, flex: 1, fontSize: 13.5, fontWeight: 600, color: "#1A1917", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{c.name || `#${c.employee_id}`}</span>
                <span style={{ fontSize: 11, color: "#9E9B94", textTransform: "capitalize" }}>{(c.role || "").replace("_", " ")}</span>
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", borderRadius: 5, padding: "3px 8px", ...tone }}>{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
