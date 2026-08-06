// [customer-portal 2026-08-06] What a COMMERCIAL customer sees after signing in:
// their buildings, their upcoming and recent visits, and their invoices — with
// the bulk PDF download that the office got in #1359.
//
// Everything is scoped server-side to the account behind their login; nothing
// on this page sends an account id. See routes/portal-account.ts.
//
// Brand: same palette as the rest of qleno (#F7F6F3 page, white cards,
// #1A1917 ink, mint accent) so a customer who has seen an invoice from us
// recognises this as the same company.
import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

const money = (n: number) =>
  `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Dates arrive as plain YYYY-MM-DD. Parsed as local parts, never
// `new Date("2026-08-06")`, which is UTC midnight and prints the day before
// west of Greenwich.
const prettyDate = (ymd: string | null) => {
  if (!ymd) return "—";
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "—";
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

type Tab = "visits" | "buildings" | "invoices";

export default function PortalAccountPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  const token = localStorage.getItem(`portal_token_${slug}`) || "";

  const [tab, setTab] = useState<Tab>("invoices");
  const [account, setAccount] = useState<any>(null);
  const [buildings, setBuildings] = useState<any[]>([]);
  const [visits, setVisits] = useState<{ upcoming: any[]; past: any[] }>({ upcoming: [], past: [] });
  const [invMonth, setInvMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [invoices, setInvoices] = useState<any>({ invoices: [], total: 0, outstanding: 0 });
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const authed = (path: string) =>
    fetch(`${API}/api/portal/account${path}`, { headers: { Authorization: `Bearer ${token}` } });

  // Any 401 means the 12-hour session lapsed. Send them to sign in rather than
  // leaving a page of empty cards that looks like they have no invoices.
  const guard = (r: Response) => {
    if (r.status === 401) { navigate(`/portal/${slug}/login`); return null; }
    return r;
  };

  useEffect(() => {
    if (!token) { navigate(`/portal/${slug}/login`); return; }
    authed("").then(guard).then(r => r?.json()).then(d => d && setAccount(d)).catch(() => setError("Could not load your account"));
  }, [token, slug]);

  useEffect(() => {
    if (!token) return;
    if (tab === "buildings") authed("/buildings").then(guard).then(r => r?.json()).then(d => d && setBuildings(d)).catch(() => {});
    if (tab === "visits") authed("/visits").then(guard).then(r => r?.json()).then(d => d && setVisits(d)).catch(() => {});
  }, [tab, token]);

  useEffect(() => {
    if (!token || tab !== "invoices") return;
    setSel(new Set());
    authed(`/invoices?month=${invMonth}`).then(guard).then(r => r?.json()).then(d => d && setInvoices(d)).catch(() => {});
  }, [tab, invMonth, token]);

  function shiftMonth(delta: number) {
    const [y, m] = invMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setInvMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const monthLabel = (() => {
    const [y, m] = invMonth.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  })();

  const selTotal = (invoices.invoices || [])
    .filter((i: any) => sel.has(i.id))
    .reduce((s: number, i: any) => s + i.total, 0);

  async function downloadSelected() {
    if (!sel.size) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/portal/account/invoices/bulk-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice_ids: [...sel] }),
      });
      if (r.status === 401) { navigate(`/portal/${slug}/login`); return; }
      if (!r.ok) { setError("That download could not be prepared — please try again."); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoices-${invMonth}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { setError("Network error — please try again."); }
    finally { setBusy(false); }
  }

  const caps = account?.capabilities ?? {};
  const CARD: React.CSSProperties = { background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12 };
  const TH: React.CSSProperties = {
    padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "#9E9B94",
    textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #EEECE7",
  };

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "invoices", label: "Invoices", show: caps.viewInvoices !== false },
    { id: "visits", label: "Visits", show: caps.viewVisits !== false },
    { id: "buildings", label: "Buildings", show: !!caps.viewBuildings },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#F7F6F3", fontFamily: FF }}>
      {/* An impersonated session must announce itself. Support staff looking at
          a customer's screen should never be mistaken for the customer. */}
      {account?.impersonated && (
        <div style={{ background: "#0A0E1A", color: "#FFFFFF", padding: "10px 20px", fontSize: 13, fontWeight: 600, textAlign: "center" }}>
          Viewing as {account.account_name} — read only
        </div>
      )}

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "28px 20px 60px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1A1917", margin: 0 }}>{account?.account_name ?? "Your account"}</h1>
            {account?.building_count > 0 && (
              <p style={{ fontSize: 13, color: "#6B6860", margin: "4px 0 0" }}>
                {account.building_count} building{account.building_count === 1 ? "" : "s"}
              </p>
            )}
          </div>
          <button
            onClick={() => { localStorage.removeItem(`portal_token_${slug}`); navigate(`/portal/${slug}/login`); }}
            style={{ background: "none", border: "1px solid #E5E2DC", borderRadius: 8, padding: "7px 14px", fontSize: 13, color: "#6B6860", cursor: "pointer", fontFamily: FF }}>
            Sign out
          </button>
        </div>

        {error && (
          <div style={{ background: "#FCEBEA", border: "1px solid #F1D0CB", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: "#B3261E", margin: 0 }}>{error}</p>
          </div>
        )}

        <div style={{ display: "flex", gap: 4, background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: 4, marginBottom: 16, width: "fit-content" }}>
          {tabs.filter(t => t.show).map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{
                padding: "7px 16px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 13,
                fontWeight: tab === t.id ? 700 : 500, fontFamily: FF,
                background: tab === t.id ? "var(--brand)" : "transparent",
                color: tab === t.id ? "#FFFFFF" : "#6B6860",
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── INVOICES ─────────────────────────────────────────────────── */}
        {tab === "invoices" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => shiftMonth(-1)} aria-label="Previous month"
                  style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B6860", cursor: "pointer" }}>‹</button>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", minWidth: 150, textAlign: "center" }}>{monthLabel}</span>
                <button onClick={() => shiftMonth(1)} aria-label="Next month"
                  style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFFFFF", color: "#6B6860", cursor: "pointer" }}>›</button>
              </div>
              {invoices.outstanding > 0 && (
                <p style={{ fontSize: 13, color: "#6B6860", margin: 0 }}>
                  Outstanding: <strong style={{ color: "#1A1917" }}>{money(invoices.outstanding)}</strong>
                </p>
              )}
            </div>

            {sel.size > 0 && caps.bulkDownloadInvoices && (
              <div style={{ background: "#0A0E1A", borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <span style={{ color: "#FFFFFF", fontSize: 14, fontWeight: 700 }}>{sel.size} selected · {money(selTotal)}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setSel(new Set())} disabled={busy}
                    style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #3A3E4A", background: "transparent", color: "#C9C5BD", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>Clear</button>
                  <button onClick={downloadSelected} disabled={busy}
                    style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--brand)", color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1, fontFamily: FF }}>
                    {busy ? "Preparing…" : "Download PDFs"}
                  </button>
                </div>
              </div>
            )}

            <div style={{ ...CARD, overflow: "hidden" }}>
              {!invoices.invoices?.length ? (
                <p style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 14, margin: 0 }}>No invoices in {monthLabel}</p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {caps.bulkDownloadInvoices && (
                        <th style={{ ...TH, width: 40 }}>
                          <input type="checkbox" aria-label="Select all invoices"
                            checked={invoices.invoices.every((i: any) => sel.has(i.id))}
                            onChange={e => setSel(e.target.checked ? new Set(invoices.invoices.map((i: any) => i.id)) : new Set())} />
                        </th>
                      )}
                      <th style={TH}>Invoice</th>
                      <th style={TH}>Date</th>
                      <th style={TH}>Status</th>
                      <th style={{ ...TH, textAlign: "right" }}>Amount</th>
                      <th style={TH}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.invoices.map((inv: any) => (
                      <tr key={inv.id} style={{ borderBottom: "1px solid #F0EEE9" }}>
                        {caps.bulkDownloadInvoices && (
                          <td style={{ padding: "12px 16px" }}>
                            <input type="checkbox" aria-label={`Select ${inv.invoice_number}`}
                              checked={sel.has(inv.id)}
                              onChange={e => setSel(p => { const n = new Set(p); e.target.checked ? n.add(inv.id) : n.delete(inv.id); return n; })} />
                          </td>
                        )}
                        <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: "#1A1917" }}>
                          {inv.invoice_number}
                          {inv.visit_count > 0 && (
                            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: "#5B21B6", background: "#F3F0FF", border: "1px solid #E4DDFA", borderRadius: 4, padding: "2px 6px" }}>
                              {inv.visit_count} visits
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "12px 16px", fontSize: 13, color: "#6B6860" }}>{prettyDate(inv.service_date)}</td>
                        <td style={{ padding: "12px 16px" }}>
                          <span style={{
                            fontSize: 11, fontWeight: 700, textTransform: "uppercase", padding: "3px 8px", borderRadius: 4,
                            ...(inv.status === "paid" ? { background: "#E6F6F1", color: "#0F7A63" }
                              : inv.status === "overdue" ? { background: "#FCEBEA", color: "#B3261E" }
                              : { background: "#EFEFF2", color: "#2F3646" }),
                          }}>{inv.status}</span>
                        </td>
                        <td style={{ padding: "12px 16px", fontSize: 14, fontWeight: 700, color: "#1A1917", textAlign: "right" }}>{money(inv.total)}</td>
                        <td style={{ padding: "12px 16px", textAlign: "right" }}>
                          <a href={`${API}/api/portal/account/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"
                            style={{ fontSize: 12, fontWeight: 600, color: "var(--brand)", textDecoration: "none" }}>PDF</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ── VISITS ───────────────────────────────────────────────────── */}
        {tab === "visits" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {[
              { title: "Upcoming", rows: visits.upcoming },
              { title: "Recent", rows: visits.past },
            ].map(section => (
              <div key={section.title} style={{ ...CARD, overflow: "hidden" }}>
                <p style={{ margin: 0, padding: "12px 16px", borderBottom: "1px solid #EEECE7", fontSize: 12, fontWeight: 700, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {section.title}
                </p>
                {!section.rows?.length ? (
                  <p style={{ padding: 28, textAlign: "center", color: "#9E9B94", fontSize: 14, margin: 0 }}>Nothing to show</p>
                ) : section.rows.map((v: any) => (
                  <div key={v.id} style={{ padding: "12px 16px", borderBottom: "1px solid #F0EEE9", display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#1A1917", textTransform: "capitalize" }}>{v.service || "Service"}</p>
                      {v.building && <p style={{ margin: "2px 0 0", fontSize: 13, color: "#6B6860" }}>{v.building}</p>}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ margin: 0, fontSize: 13, color: "#1A1917" }}>{prettyDate(v.date)}</p>
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: v.status === "complete" ? "#0F7A63" : "#9E9B94", textTransform: "capitalize" }}>{v.status}</p>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* ── BUILDINGS ────────────────────────────────────────────────── */}
        {tab === "buildings" && (
          <div style={{ ...CARD, overflow: "hidden" }}>
            {!buildings.length ? (
              <p style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 14, margin: 0 }}>No buildings on file</p>
            ) : buildings.map(b => (
              <div key={b.id} style={{ padding: "14px 16px", borderBottom: "1px solid #F0EEE9", display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#1A1917" }}>{b.name}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 13, color: "#6B6860" }}>{b.address}</p>
                  {b.unit_count > 0 && <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9E9B94" }}>{b.unit_count} units</p>}
                </div>
                <div style={{ textAlign: "right", fontSize: 12, color: "#6B6860" }}>
                  <p style={{ margin: 0 }}>Next: <strong style={{ color: "#1A1917" }}>{prettyDate(b.next_visit)}</strong></p>
                  <p style={{ margin: "2px 0 0" }}>Last: {prettyDate(b.last_visit)}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        <p style={{ textAlign: "center", fontSize: 12, color: "#9E9B94", marginTop: 28 }}>
          Powered by <strong style={{ color: "#1A1917" }}>Qleno</strong>
        </p>
      </div>
    </div>
  );
}
