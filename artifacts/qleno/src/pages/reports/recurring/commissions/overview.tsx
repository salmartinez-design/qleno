import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle, Clock, Calendar, DollarSign, AlertTriangle, BarChart3, Eye } from "lucide-react";
import { C, card, eyebrow, money, money2, dateFmt, titleCase, btn, th, td, StatusChip, Empty } from "../_ui";
import { initials, type CommissionRow, type Metrics } from "./api";

// [ares-parity 2026-08-18] Overview tab — a faithful rebuild of Ares'
// CommissionPortal overview (:1581-2012). Same blocks, same order, same
// figures, same click-throughs. Qleno's design tokens instead of Ares' dark
// palette; that is the only intended difference.

// Ares had a single pre-approval status; Qleno splits it into `earned`
// (submitted, not yet looked at) and `pending_review`. Both are money awaiting
// review, so every "Pending" figure on this screen covers the pair — the same
// pairing the queue, statement and reports tabs use.
const PENDING_STATUSES = ["pending_review", "earned"];

export interface NavIntent { tab: string; vaFilter?: number; statusFilter?: string }

interface Props {
  metrics: Metrics;
  commissions: CommissionRow[];
  onNavigate: (i: NavIntent) => void;
  onProcessPayout: () => void;
  onViewAsVa: (vaUserId: number, vaName: string) => void;
}

export default function Overview({ metrics, commissions, onNavigate, onProcessPayout, onViewAsVa }: Props) {
  const [expandedVa, setExpandedVa] = useState<number | null>(null);
  const [cadenceOpen, setCadenceOpen] = useState(false);      // Ares default: collapsed
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);

  const totalApproved = metrics.readyToPay.total;
  const totalPending = metrics.pendingReview.total;
  const nextPayout = metrics.nextPayoutDate ? dateFmt(metrics.nextPayoutDate) : null;
  const vaRows = metrics.payoutByVA;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>

      {/* ── Hero: Total Owed to VAs ─────────────────────────────────────── */}
      <section style={{ ...card(), overflow: "hidden" }}>
        <div style={{
          padding: "20px 24px", borderBottom: `1px solid ${C.lineSoft}`, background: C.mintBg,
          display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap",
        }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={eyebrow()}>Total Owed to VAs</div>
            <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1.05, marginTop: 6 }}>
              {money2(totalApproved + totalPending)}
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 10, fontSize: 13, color: C.grey }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <CheckCircle size={14} style={{ color: C.mintDeep }} />
                <strong style={{ color: C.ink }}>{money2(totalApproved)}</strong> approved
              </span>
              {totalPending > 0 && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Clock size={14} style={{ color: C.amber }} />
                  <strong style={{ color: C.ink }}>{money2(totalPending)}</strong> pending review
                </span>
              )}
              {nextPayout && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Calendar size={14} style={{ color: C.grey }} />
                  Next payout: <strong style={{ color: C.ink }}>{nextPayout}</strong>
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {totalApproved > 0 ? (
              <button style={btn("primary")} onClick={onProcessPayout}>
                <DollarSign size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />Process Payout
              </button>
            ) : (
              <button style={{ ...btn(), opacity: .55, cursor: "not-allowed" }} disabled>No Payouts Due</button>
            )}
            <button style={btn()} onClick={() => onNavigate({ tab: "queue" })}>
              <Clock size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              Review Queue ({metrics.pendingReview.count} pending)
            </button>
          </div>
        </div>

        {/* Per-VA breakdown */}
        {vaRows.length > 0 && (
          <div>
            {vaRows.map(va => (
              <div key={va.id} style={{
                display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap",
                padding: "16px 24px", borderBottom: `1px solid ${C.lineSoft}`,
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 999, background: C.tint2, color: C.grey,
                  display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13, flexShrink: 0,
                }}>{initials(va.name)}</div>
                <div style={{ fontWeight: 700, minWidth: 130 }}>{va.name}</div>

                <div style={{ minWidth: 190 }}>
                  <div style={{ ...eyebrow(), display: "flex", alignItems: "center", gap: 6 }}>
                    <CheckCircle size={12} /> Approved · Ready to Pay
                  </div>
                  {va.approvedCount > 0 ? (
                    <>
                      <div style={{ fontWeight: 800, fontSize: 17, marginTop: 3 }}>{money2(va.subtotal)}</div>
                      <div style={{ fontSize: 12, color: C.grey }}>
                        {va.approvedCount} client{va.approvedCount === 1 ? "" : "s"}
                        {nextPayout ? ` · due ${nextPayout}` : ""}
                      </div>
                    </>
                  ) : <div style={{ fontSize: 13, color: C.faint, marginTop: 4 }}>Nothing approved yet</div>}
                </div>

                <div style={{ minWidth: 190 }}>
                  <div style={{ ...eyebrow(), display: "flex", alignItems: "center", gap: 6 }}>
                    <Clock size={12} /> Pending · Needs Review
                  </div>
                  {va.pendingCommissionCount > 0 ? (
                    <>
                      <div style={{ fontWeight: 800, fontSize: 17, marginTop: 3 }}>{money2(va.pendingTotal)}</div>
                      <div style={{ fontSize: 12, color: C.grey }}>
                        {va.pendingCommissionCount} client{va.pendingCommissionCount === 1 ? "" : "s"} awaiting approval
                      </div>
                    </>
                  ) : <div style={{ fontSize: 13, color: C.faint, marginTop: 4 }}>All reviewed</div>}
                </div>

                <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {va.pendingCommissionCount > 0 && (
                    <button style={btn()} onClick={() => onNavigate({ tab: "queue", vaFilter: va.id, statusFilter: "pending_review" })}>
                      Review ({va.pendingCommissionCount})
                    </button>
                  )}
                  {va.approvedCount > 0 && (
                    <button style={btn()} onClick={() => onNavigate({ tab: "queue", vaFilter: va.id, statusFilter: "approved" })}>
                      View Approved
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Quick stats — 4 clickable cards ─────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
        <QuickStat icon={<Clock size={15} />} tone={C.amber} heading="Pending Review"
          big={metrics.pendingReview.count} sub={money2(totalPending)} caption="Awaiting your review"
          onClick={() => onNavigate({ tab: "queue", statusFilter: "pending_review" })} />
        <QuickStat icon={<CheckCircle size={15} />} tone={C.mintDeep} heading="Ready to Pay"
          big={metrics.readyToPay.count} sub={money2(totalApproved)} caption="Approved, not yet paid"
          onClick={() => onNavigate({ tab: "queue", statusFilter: "approved" })} />
        <QuickStat icon={<DollarSign size={15} />} tone={C.info} heading="Paid This Month"
          big={metrics.paidThisMonth.count} sub={money2(metrics.paidThisMonth.total)} caption="Processed this month"
          onClick={() => onNavigate({ tab: "payout" })} />
        <QuickStat icon={<AlertTriangle size={15} />} tone={C.red} heading="Chargeback Risk"
          big={metrics.chargebackRisk.count} sub={money2(metrics.chargebackRisk.total)} caption="In chargeback window"
          onClick={() => onNavigate({ tab: "chargebacks" })} />
      </div>

      {/* ── VA Summary ──────────────────────────────────────────────────── */}
      {metrics.vaPerformance.length > 0 && (
        <section>
          <h2 style={{ fontSize: 17, fontWeight: 800, margin: "0 0 2px" }}>VA Summary</h2>
          <p style={{ color: C.grey, fontSize: 13.5, margin: "0 0 14px" }}>Commission status per virtual assistant</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))", gap: 14 }}>
            {metrics.vaPerformance.map(va => {
              const mine = commissions.filter(c => c.va_user_id === va.id);
              // Status sets, not single statuses: Qleno's pre-review `earned`
              // is money awaiting review just like `pending_review`, and every
              // other screen in this module counts the two together. Counting
              // only `pending_review` reported "Pending $0.00 · 0 items" for a
              // VA who had unreviewed lines waiting.
              const sum = (ss: string[]) => mine.filter(c => ss.includes(c.status)).reduce((t, c) => t + Number(c.amount), 0);
              const cnt = (ss: string[]) => mine.filter(c => ss.includes(c.status)).length;
              const open = expandedVa === va.id;
              return (
                <div key={va.id} style={{ ...card(), padding: "16px 18px" }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <div style={{
                      width: 34, height: 34, borderRadius: 999, background: C.tint2, color: C.grey,
                      display: "grid", placeItems: "center", fontWeight: 800, fontSize: 12.5,
                    }}>{initials(va.name)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 800 }}>{va.name}</div>
                      <div style={{ fontSize: 12, color: C.grey }}>
                        {va.totalClients} clients • {va.clientsThisMonth} this month
                      </div>
                    </div>
                    <button aria-label={open ? "Collapse" : "Expand"} onClick={() => setExpandedVa(open ? null : va.id)}
                      style={{ ...btn(), padding: "5px 7px" }}>
                      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </button>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginTop: 14 }}>
                    <MiniCell label="Pending" value={money2(sum(PENDING_STATUSES))} items={cnt(PENDING_STATUSES)} />
                    <MiniCell label="Approved" value={money2(sum(["approved"]))} items={cnt(["approved"])} />
                    <MiniCell label="Paid" value={money2(sum(["paid"]))} items={cnt(["paid"])} />
                  </div>

                  {open && mine.length > 0 && (
                    <div style={{ marginTop: 14, borderTop: `1px solid ${C.lineSoft}`, paddingTop: 10 }}>
                      {mine.slice(0, 8).map(c => (
                        <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", fontSize: 13 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {c.client_name || "Unknown"}
                            </div>
                            {c.first_cleaning_date && (
                              <div style={{ fontSize: 11.5, color: C.faint }}>{dateFmt(c.first_cleaning_date)}</div>
                            )}
                          </div>
                          <div style={{ fontWeight: 700 }}>{money2(Number(c.amount))}</div>
                          <StatusChip status={c.status} />
                        </div>
                      ))}
                      {mine.length > 8 && (
                        <button style={{ ...btn(), marginTop: 8, width: "100%" }}
                          onClick={() => onNavigate({ tab: "queue", vaFilter: va.id })}>
                          View all {mine.length} commissions
                        </button>
                      )}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                    <button style={{ ...btn(), flex: 1 }}
                      onClick={() => onNavigate({ tab: "queue", vaFilter: va.id, statusFilter: "pending_review" })}>
                      <Clock size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />Review Queue
                    </button>
                    <button style={{ ...btn(), flex: 1 }} onClick={() => onViewAsVa(va.id, va.name)}>
                      <Eye size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />View as VA
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Cadence Breakdown ───────────────────────────────────────────── */}
      {commissions.length > 0 && (
        <CadenceBreakdown commissions={commissions} open={cadenceOpen} onToggle={() => setCadenceOpen(o => !o)} />
      )}

      {/* ── VA Performance Leaderboard ──────────────────────────────────── */}
      {metrics.vaPerformance.length > 0 && (
        <section style={card()}>
          <button onClick={() => setLeaderboardOpen(o => !o)} style={{
            appearance: "none", border: 0, background: "none", font: "inherit", cursor: "pointer",
            width: "100%", textAlign: "left", padding: "16px 20px", display: "flex", alignItems: "center", gap: 12,
          }}>
            <div style={{ flex: 1 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: C.ink }}>VA Performance Leaderboard</h2>
              <p style={{ color: C.grey, fontSize: 13, margin: "2px 0 0" }}>Compare performance metrics, ranked by MRR generated</p>
            </div>
            {leaderboardOpen ? <ChevronDown size={17} color={C.grey} /> : <ChevronRight size={17} color={C.grey} />}
          </button>
          {leaderboardOpen && <Leaderboard rows={metrics.vaPerformance} onViewAsVa={onViewAsVa} />}
        </section>
      )}
    </div>
  );
}

function QuickStat({ icon, tone, heading, big, sub, caption, onClick }: {
  icon: React.ReactNode; tone: string; heading: string;
  big: number; sub: string; caption: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      ...card(), appearance: "none", font: "inherit", textAlign: "left", cursor: "pointer",
      padding: "15px 18px", color: C.ink,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, color: tone }}>
        {icon}<span style={{ ...eyebrow(), color: tone }}>{heading}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.03em", marginTop: 8 }}>{big}</div>
      <div style={{ fontWeight: 700, fontSize: 14, marginTop: 2 }}>{sub}</div>
      <div style={{ fontSize: 12, color: C.grey, marginTop: 2 }}>{caption}</div>
    </button>
  );
}

function MiniCell({ label, value, items }: { label: string; value: string; items: number }) {
  return (
    <div style={{ background: C.tint, border: `1px solid ${C.lineSoft}`, borderRadius: 10, padding: "9px 11px" }}>
      <div style={{ ...eyebrow(), fontSize: 10 }}>{label}</div>
      <div style={{ fontWeight: 800, fontSize: 15, marginTop: 3 }}>{value}</div>
      <div style={{ fontSize: 11, color: C.faint }}>{items} items</div>
    </div>
  );
}

function CadenceBreakdown({ commissions, open, onToggle }: {
  commissions: CommissionRow[]; open: boolean; onToggle: () => void;
}) {
  const groups = new Map<string, { count: number; total: number; paid: number; approved: number; pending: number }>();
  for (const c of commissions) {
    const k = c.cadence || "unknown";
    const g = groups.get(k) ?? { count: 0, total: 0, paid: 0, approved: 0, pending: 0 };
    g.count++;
    g.total += Number(c.amount);
    if (c.status === "paid") g.paid++;
    if (c.status === "approved") g.approved++;
    if (PENDING_STATUSES.includes(c.status)) g.pending++;
    groups.set(k, g);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
  const grand = rows.reduce((t, [, g]) => t + g.total, 0);

  return (
    <section style={card()}>
      <button onClick={onToggle} style={{
        appearance: "none", border: 0, background: "none", font: "inherit", cursor: "pointer",
        width: "100%", textAlign: "left", padding: "16px 20px", display: "flex", alignItems: "center", gap: 12,
      }}>
        <BarChart3 size={16} color={C.grey} />
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: C.ink }}>Cadence Breakdown</h2>
          <p style={{ color: C.grey, fontSize: 13, margin: "2px 0 0" }}>Commission distribution by service frequency</p>
        </div>
        {open ? <ChevronDown size={17} color={C.grey} /> : <ChevronRight size={17} color={C.grey} />}
      </button>
      {open && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th()}>Cadence</th>
                <th style={{ ...th(), textAlign: "right" }}>Total</th>
                <th style={{ ...th(), textAlign: "right" }}>Paid</th>
                <th style={{ ...th(), textAlign: "right" }}>Approved</th>
                <th style={{ ...th(), textAlign: "right" }}>Pending</th>
                <th style={{ ...th(), textAlign: "right" }}>Commission</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([cad, g]) => (
                <tr key={cad}>
                  <td style={td()}>
                    <span style={{ border: `1px solid ${C.line}`, borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                      {titleCase(cad)}
                    </span>
                  </td>
                  <td style={{ ...td(), textAlign: "right" }}>{g.count}</td>
                  <td style={{ ...td(), textAlign: "right", color: C.mintDeep, fontWeight: 700 }}>{g.paid}</td>
                  <td style={{ ...td(), textAlign: "right", color: C.info, fontWeight: 700 }}>{g.approved}</td>
                  <td style={{ ...td(), textAlign: "right", color: C.amber, fontWeight: 700 }}>{g.pending}</td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>{money(g.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: C.tint }}>
                <td style={{ ...td(), fontWeight: 800 }}>Total</td>
                <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>{commissions.length}</td>
                <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>{commissions.filter(c => c.status === "paid").length}</td>
                <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>{commissions.filter(c => c.status === "approved").length}</td>
                <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>{commissions.filter(c => PENDING_STATUSES.includes(c.status)).length}</td>
                <td style={{ ...td(), textAlign: "right", fontWeight: 800 }}>{money(grand)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function Leaderboard({ rows, onViewAsVa }: {
  rows: Metrics["vaPerformance"]; onViewAsVa: (id: number, name: string) => void;
}) {
  const sorted = [...rows].sort((a, b) => b.revenueGenerated - a.revenueGenerated);
  const rank = (i: number) => i === 0 ? { bg: C.amberBg, fg: C.amber, title: "Top Performer" }
    : i === 1 ? { bg: C.tint2, fg: C.grey, title: "Runner Up" }
    : i === 2 ? { bg: C.amberBg, fg: C.grey, title: "Third Place" }
    : null;

  if (!sorted.length) return <Empty>No VA activity yet.</Empty>;

  return (
    <div style={{ padding: "0 20px 20px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px,1fr))", gap: 14 }}>
      {sorted.map((va, i) => {
        const r = rank(i);
        return (
          <div key={va.id} style={{
            border: `1px solid ${i === 0 ? C.mint : C.line}`, borderRadius: 12, padding: "14px 16px", background: C.card,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span title={r?.title} style={{
                width: 26, height: 26, borderRadius: 999, display: "grid", placeItems: "center",
                fontWeight: 800, fontSize: 12, background: r?.bg ?? "transparent", color: r?.fg ?? C.faint,
              }}>{r ? i + 1 : `#${i + 1}`}</span>
              <div style={{ fontWeight: 800, flex: 1 }}>{va.name}</div>
              <button style={btn()} onClick={() => onViewAsVa(va.id, va.name)}>
                <Eye size={13} style={{ verticalAlign: "-2px" }} />
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
              <Metric label="Clients This Month" value={String(va.clientsThisMonth)} />
              <Metric label="Total Clients" value={String(va.totalClients)} />
              <Metric label="MRR Generated" value={money(va.revenueGenerated)} tone={C.mintDeep} />
              <div>
                <div style={{ ...eyebrow(), fontSize: 10 }}>Approved + Paid</div>
                <div style={{ fontWeight: 800, fontSize: 15, marginTop: 3, color: C.mintDeep }}>{money(va.commissionsEarned)}</div>
                <div style={{ fontSize: 11, color: C.grey, marginTop: 2 }}>
                  <span style={{ color: C.info }}>Paid:</span> {money(va.commissionsPaid)}<br />
                  <span style={{ color: C.amber }}>Approved:</span> {money(va.commissionsApproved)}
                  {va.commissionsPending > 0 && <><br /><span style={{ color: C.grey }}>Pending:</span> {money(va.commissionsPending)}</>}
                </div>
              </div>
              <Metric label="Chargeback Rate" value={`${va.chargebackRate}%`} tone={va.chargebackRate > 10 ? C.red : C.mintDeep} />
              <Metric label="Avg Client Lifespan" value={`${va.avgClientLifespan} mo`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div style={{ ...eyebrow(), fontSize: 10 }}>{label}</div>
      <div style={{ fontWeight: 800, fontSize: 15, marginTop: 3, color: tone ?? C.ink }}>{value}</div>
    </div>
  );
}
