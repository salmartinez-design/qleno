// [client-dedup 2026-07-28] Merge-duplicate flow. The office (Maribel) asked to
// "delete and merge clients to get rid of duplicates". This modal drives the
// merge: pick which record survives, preview exactly what will move (jobs,
// invoices, payments, …) via a server dry-run, then confirm. Office/admin/owner
// only — the caller gates rendering; the server also role-gates the routes.
import { useState, useEffect } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { X, ArrowRight, Loader2, AlertTriangle, Check } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

export interface MergeCandidate {
  id: number;
  first_name?: string;
  last_name?: string;
  email?: string | null;
  phone?: string | null;
}

function nameOf(c: { first_name?: string; last_name?: string } | null | undefined): string {
  if (!c) return "";
  return `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unnamed client";
}

interface Impact {
  duplicate: MergeCandidate;
  survivor: MergeCandidate;
  counts: Record<string, number>;
  breakdown: { label: string; count: number }[];
  totalRecords: number;
  fieldFills: { field: string; value: string }[];
}

/**
 * @param candidates 1 or 2 preselected clients. Two → the office chooses which
 *   survives. One → that client is the duplicate and the survivor is searched.
 */
export function MergeClientModal({
  candidates,
  onClose,
  onMerged,
}: {
  candidates: MergeCandidate[];
  onClose: () => void;
  onMerged: (survivorId: number) => void;
}) {
  const twoUp = candidates.length >= 2;
  // For the 2-up flow the survivor is whichever the office keeps; default keep the first.
  const [survivorId, setSurvivorId] = useState<number | null>(twoUp ? candidates[0].id : null);
  // For the 1-up (profile) flow the survivor is found via search.
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<MergeCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<MergeCandidate | null>(null);

  const [impact, setImpact] = useState<Impact | null>(null);
  const [loadingImpact, setLoadingImpact] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive the duplicate + survivor ids for the current selection.
  const duplicateId = twoUp
    ? (survivorId === candidates[0].id ? candidates[1].id : candidates[0].id)
    : candidates[0].id;
  const effectiveSurvivorId = twoUp ? survivorId : picked?.id ?? null;

  // Debounced survivor search (1-up flow only).
  useEffect(() => {
    if (twoUp || !search.trim()) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/api/clients?search=${encodeURIComponent(search.trim())}&limit=8`, {
          headers: getAuthHeaders() as Record<string, string>,
        });
        const j = await r.json();
        // Never let the duplicate itself be chosen as its own survivor.
        setResults((j.data || []).filter((c: MergeCandidate) => c.id !== candidates[0].id));
      } catch { setResults([]); }
      finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [search, twoUp]);

  // Fetch the dry-run impact whenever both sides are known.
  useEffect(() => {
    if (effectiveSurvivorId == null) { setImpact(null); return; }
    setLoadingImpact(true);
    setError(null);
    setConfirmChecked(false);
    (async () => {
      try {
        const r = await fetch(`${API}/api/clients/${duplicateId}/merge-impact?survivorId=${effectiveSurvivorId}`, {
          headers: getAuthHeaders() as Record<string, string>,
        });
        const j = await r.json();
        if (!r.ok) { setError(j.message || "Could not load merge preview."); setImpact(null); }
        else setImpact(j);
      } catch { setError("Could not load merge preview."); setImpact(null); }
      finally { setLoadingImpact(false); }
    })();
  }, [duplicateId, effectiveSurvivorId]);

  const doMerge = async () => {
    if (effectiveSurvivorId == null) return;
    setMerging(true);
    setError(null);
    try {
      const r = await fetch(`${API}/api/clients/${duplicateId}/merge`, {
        method: "POST",
        headers: { ...(getAuthHeaders() as Record<string, string>), "Content-Type": "application/json" },
        body: JSON.stringify({ survivorId: effectiveSurvivorId }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.message || "Merge failed."); setMerging(false); return; }
      onMerged(effectiveSurvivorId);
    } catch {
      setError("Merge failed.");
      setMerging(false);
    }
  };

  const survivorCand = twoUp
    ? candidates.find((c) => c.id === survivorId) ?? null
    : picked;
  const duplicateCand = twoUp
    ? candidates.find((c) => c.id === duplicateId) ?? null
    : candidates[0];

  const btn = (primary: boolean, disabled?: boolean): React.CSSProperties => ({
    padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700, fontFamily: FF,
    border: primary ? "none" : "1px solid #E5E2DC",
    background: primary ? "var(--brand)" : "#FFFFFF",
    color: primary ? "#FFFFFF" : "#6B6860",
    cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.55 : 1,
  });

  return (
    <div
      onClick={() => !merging && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: FF }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, width: "100%", maxWidth: 560, maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.18)" }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px", borderBottom: "1px solid #EEECE7" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#0A0E1A" }}>Merge duplicate clients</div>
            <div style={{ fontSize: 12.5, color: "#9E9B94", marginTop: 2 }}>All history moves to the client you keep. This cannot be undone.</div>
          </div>
          <button onClick={() => !merging && onClose()} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: 20 }}>
          {/* Step 1 — choose survivor */}
          {twoUp ? (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Which client do you want to keep?</div>
              <div style={{ display: "grid", gap: 10 }}>
                {candidates.slice(0, 2).map((c) => {
                  const keep = survivorId === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setSurvivorId(c.id)}
                      style={{
                        textAlign: "left", padding: "12px 14px", borderRadius: 9, cursor: "pointer", fontFamily: FF,
                        border: `1.5px solid ${keep ? "var(--brand)" : "#E5E2DC"}`,
                        background: keep ? "var(--brand-dim)" : "#FFFFFF",
                        display: "flex", alignItems: "center", gap: 12,
                      }}
                    >
                      <div style={{ width: 18, height: 18, borderRadius: "50%", flexShrink: 0, border: `1.5px solid ${keep ? "var(--brand)" : "#CFCBC3"}`, background: keep ? "var(--brand)" : "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {keep && <Check size={11} color="#FFFFFF" strokeWidth={3} />}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{nameOf(c)} <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 500 }}>· CL-{c.id}</span></div>
                        <div style={{ fontSize: 12, color: "#9E9B94", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {[c.phone, c.email].filter(Boolean).join(" · ") || "No contact on file"}
                        </div>
                      </div>
                      <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, color: keep ? "var(--brand)" : "#9E9B94" }}>{keep ? "KEEP" : "remove"}</span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                Merge <strong style={{ color: "#1A1917" }}>{nameOf(candidates[0])}</strong> into…
              </div>
              {picked ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1.5px solid var(--brand)", background: "var(--brand-dim)", borderRadius: 9 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{nameOf(picked)} <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 500 }}>· CL-{picked.id}</span></div>
                    <div style={{ fontSize: 12, color: "#9E9B94" }}>{[picked.phone, picked.email].filter(Boolean).join(" · ") || "No contact on file"}</div>
                  </div>
                  <button onClick={() => { setPicked(null); setImpact(null); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", fontSize: 12, fontWeight: 600 }}>Change</button>
                </div>
              ) : (
                <>
                  <input
                    autoFocus
                    placeholder="Search the client to keep by name, phone, CL-XXXX…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{ width: "100%", height: 38, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 8, fontSize: 13, fontFamily: FF, outline: "none", boxSizing: "border-box" }}
                  />
                  <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                    {searching && <div style={{ fontSize: 12, color: "#9E9B94", display: "flex", alignItems: "center", gap: 6 }}><Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> Searching…</div>}
                    {!searching && search.trim() && results.length === 0 && <div style={{ fontSize: 12, color: "#9E9B94" }}>No other clients found.</div>}
                    {results.map((c) => (
                      <button key={c.id} onClick={() => { setPicked(c); setSearch(""); setResults([]); }}
                        style={{ textAlign: "left", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#1A1917" }}>{nameOf(c)} <span style={{ fontSize: 11, color: "#9E9B94", fontWeight: 500 }}>· CL-{c.id}</span></div>
                        <div style={{ fontSize: 12, color: "#9E9B94" }}>{[c.phone, c.email].filter(Boolean).join(" · ") || "No contact on file"}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {/* Step 2 — impact preview */}
          {effectiveSurvivorId != null && (
            <div style={{ marginTop: 18 }}>
              {/* Direction banner */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "#F7F6F3", border: "1px solid #EEECE7", borderRadius: 9, fontSize: 12.5 }}>
                <span style={{ color: "#B3261E", fontWeight: 700 }}>{nameOf(duplicateCand)}</span>
                <ArrowRight size={14} color="#9E9B94" />
                <span style={{ color: "#0F7A63", fontWeight: 700 }}>{nameOf(survivorCand)}</span>
              </div>

              {loadingImpact && (
                <div style={{ marginTop: 14, fontSize: 13, color: "#9E9B94", display: "flex", alignItems: "center", gap: 8 }}>
                  <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Checking what will move…
                </div>
              )}

              {impact && !loadingImpact && (
                <div style={{ marginTop: 14 }}>
                  {impact.totalRecords === 0 ? (
                    <div style={{ fontSize: 13, color: "#6B6860" }}>
                      No linked records — merging just removes the empty duplicate and fills any blank contact fields on <strong>{nameOf(survivorCand)}</strong>.
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 12.5, color: "#6B6860", marginBottom: 10 }}>
                        <strong style={{ color: "#1A1917" }}>{impact.totalRecords.toLocaleString()}</strong> record{impact.totalRecords === 1 ? "" : "s"} will move to <strong style={{ color: "#1A1917" }}>{nameOf(survivorCand)}</strong>, then <strong style={{ color: "#1A1917" }}>{nameOf(duplicateCand)}</strong> will be removed:
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        {impact.breakdown.map((b) => (
                          <div key={b.label} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "7px 11px", background: "#F7F6F3", border: "1px solid #EEECE7", borderRadius: 7 }}>
                            <span style={{ fontSize: 12, color: "#6B6860", textTransform: "capitalize", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.label}</span>
                            <span style={{ fontSize: 12, fontWeight: 800, color: "#1A1917" }}>{b.count.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {impact.fieldFills.length > 0 && (
                    <div style={{ marginTop: 12, fontSize: 12, color: "#6B6860", background: "#E6F6F1", border: "1px solid #C7EBE0", borderRadius: 8, padding: "9px 12px" }}>
                      Blank fields on {nameOf(survivorCand)} will be filled from the duplicate: {impact.fieldFills.map((f) => f.field.replace(/_/g, " ")).join(", ")}.
                    </div>
                  )}

                  {/* Confirm gate */}
                  <label style={{ marginTop: 16, display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer" }}>
                    <input type="checkbox" checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} style={{ marginTop: 2, accentColor: "var(--brand)", width: 15, height: 15 }} />
                    <span style={{ fontSize: 12.5, color: "#6B6860" }}>
                      I understand <strong style={{ color: "#B3261E" }}>{nameOf(duplicateCand)}</strong> will be permanently removed and everything moves to {nameOf(survivorCand)}.
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}

          {error && (
            <div style={{ marginTop: 14, display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: "#B3261E", background: "#FCEBEA", border: "1px solid #F5C6C2", borderRadius: 8, padding: "9px 12px" }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 20px", borderTop: "1px solid #EEECE7" }}>
          <button onClick={() => !merging && onClose()} style={btn(false, merging)}>Cancel</button>
          <button
            onClick={doMerge}
            disabled={merging || !impact || !confirmChecked}
            style={btn(true, merging || !impact || !confirmChecked)}
          >
            {merging ? "Merging…" : "Merge clients"}
          </button>
        </div>
      </div>
    </div>
  );
}
