import { useMemo, useState } from "react";
import { BarChart3, Clock, DollarSign, Shield, FileText, Settings as SettingsIcon, BookOpen, ArrowLeft } from "lucide-react";
import { getTokenRole, getTokenUserId } from "@/lib/auth";
import { C, btn, LoadError, Empty } from "../_ui";
import { useCommissionData, type CommissionRow, type Metrics } from "./api";
import Overview, { type NavIntent } from "./overview";
import Queue from "./queue";
import Payout from "./payout";
import Chargebacks from "./chargebacks";
import Reports from "./reports";
import Settings from "./settings";
import Guidelines from "./guidelines";
import Statement from "./statement";

// [ares-parity 2026-08-18] The Ares Commissions tab.
//
// A functional replica of the legacy Ares CommissionPortal — the same seven
// admin tabs, the same figures, the same controls — rendered in Qleno's design
// system. The palette is the ONLY intended difference: Ares was dark-mode-first
// and CLAUDE.md is explicit that this app has no dark mode, ever.
//
// The commission list is fetched ONCE here and passed down. Ares refetched per
// tab, which is how its Overview and its Queue could disagree about the same
// number in the same session.

const OFFICE_ROLES = ["owner", "admin", "office", "super_admin"];

const TABS = [
  { k: "overview",    label: "Overview",       icon: BarChart3 },
  { k: "queue",       label: "Approval Queue", icon: Clock },
  { k: "payout",      label: "Payout History", icon: DollarSign },
  { k: "chargebacks", label: "Chargebacks",    icon: Shield },
  { k: "reports",     label: "Reports",        icon: FileText },
  { k: "settings",    label: "Settings",       icon: SettingsIcon },
  { k: "guidelines",  label: "Guidelines",     icon: BookOpen },
] as const;

export default function Commissions() {
  const role = getTokenRole();
  const userId = getTokenUserId();
  const isOffice = !!role && OFFICE_ROLES.includes(role);

  // A VA sees only their own statement — never the queue, never another VA.
  // Enforced server-side as well; this is only the routing.
  if (!isOffice) {
    if (!userId) return <Empty>Sign in again to see your statement.</Empty>;
    return <Statement vaUserId={userId} />;
  }
  return <AdminPortal />;
}

function AdminPortal() {
  const [tab, setTab] = useState<string>("overview");
  const [vaFilter, setVaFilter] = useState<number | "all">("all");
  const [statusFilter, setStatusFilter] = useState<string>("pending_review");
  // Set when an office user opens a VA's statement from Overview or the
  // leaderboard. Qleno has no impersonation session — they read that VA's data
  // as themselves through a read-only endpoint — so this is view state, not a
  // session, and every control that would act AS the VA stays suppressed.
  const [viewingVa, setViewingVa] = useState<{ id: number; name: string } | null>(null);

  const metricsQ = useCommissionData<Metrics>("/recurring/commissions/metrics");
  const listQ = useCommissionData<{ count: number; commissions: CommissionRow[] }>("/recurring/commissions");

  const commissions = listQ.data?.commissions ?? [];
  const pendingCount = metricsQ.data?.pendingReview.count ?? 0;

  const chargebackCount = useMemo(
    () => commissions.filter(c =>
      ["chargeback_pending", "chargeback_confirmed", "charged_back"].includes(c.status)).length,
    [commissions],
  );

  // One VA list for every filter and dropdown, so they can never disagree.
  // Falls back to names carried on the commission rows if metrics is still in
  // flight, rather than rendering an empty picker.
  const vaOptions = useMemo(() => {
    const fromMetrics = metricsQ.data?.vaPerformance.map(v => ({ id: v.id, name: v.name })) ?? [];
    if (fromMetrics.length) return fromMetrics;
    const seen = new Map<number, string>();
    for (const c of commissions) {
      if (!seen.has(c.va_user_id)) seen.set(c.va_user_id, c.va_name || `VA #${c.va_user_id}`);
    }
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [metricsQ.data, commissions]);

  const navigate = (i: NavIntent) => {
    setTab(i.tab);
    if (i.vaFilter !== undefined) setVaFilter(i.vaFilter);
    if (i.statusFilter !== undefined) setStatusFilter(i.statusFilter);
  };

  // A mutation anywhere invalidates both the list and the headline figures.
  const reloadAll = () => { metricsQ.reload(); listQ.reload(); };

  // Viewing a VA's statement takes over the whole panel — the tab bar belongs
  // to the admin view and would be misleading while reading someone else's
  // numbers.
  if (viewingVa) {
    return (
      <div>
        <button style={{ ...btn(), marginBottom: 16 }} onClick={() => setViewingVa(null)}>
          <ArrowLeft size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Back to Commission Management
        </button>
        <Statement
          vaUserId={viewingVa.id}
          vaName={viewingVa.name}
          viewingAsOther
          onExitView={() => setViewingVa(null)}
        />
      </div>
    );
  }

  return (
    <div>
      {/* Tab bar. Badges mirror Ares: pending count on the queue, open
          chargebacks on the chargebacks tab. */}
      <div style={{
        display: "flex", gap: 4, borderBottom: `1px solid ${C.line}`,
        margin: "0 0 22px", overflowX: "auto", flexWrap: "wrap",
      }}>
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.k;
          const badge = t.k === "queue" ? pendingCount : t.k === "chargebacks" ? chargebackCount : 0;
          return (
            <button key={t.k} onClick={() => setTab(t.k)} style={{
              appearance: "none", border: 0, background: "none", font: "inherit", cursor: "pointer",
              padding: "0 10px 12px", color: active ? C.ink : C.grey, fontWeight: 700, fontSize: 14,
              borderBottom: `2.5px solid ${active ? C.mint : "transparent"}`, marginBottom: -1,
              display: "inline-flex", alignItems: "center", gap: 7, whiteSpace: "nowrap",
            }}>
              <Icon size={15} />{t.label}
              {badge > 0 && (
                <span style={{
                  background: t.k === "chargebacks" ? C.redBg : C.amberBg,
                  color: t.k === "chargebacks" ? C.red : C.amber,
                  borderRadius: 999, fontSize: 11, fontWeight: 800,
                  padding: "1px 7px", minWidth: 18, textAlign: "center",
                }}>{badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {metricsQ.error && <LoadError what="commission metrics" error={metricsQ.error} />}
      {listQ.error && <LoadError what="the commission list" error={listQ.error} />}

      {tab === "overview" && (
        metricsQ.loading || listQ.loading ? <Loading />
          : metricsQ.data ? (
            <Overview
              metrics={metricsQ.data}
              commissions={commissions}
              onNavigate={navigate}
              onProcessPayout={() => setTab("payout")}
              onViewAsVa={(id, name) => setViewingVa({ id, name })}
            />
          ) : !metricsQ.error ? <Empty>No commission activity yet.</Empty> : null
      )}

      {tab === "queue" && (
        <Queue
          commissions={commissions}
          loading={listQ.loading}
          error={listQ.error}
          vaFilter={vaFilter}
          statusFilter={statusFilter}
          onVaFilter={setVaFilter}
          onStatusFilter={setStatusFilter}
          vaOptions={vaOptions}
          reload={reloadAll}
        />
      )}

      {tab === "payout" && (
        <Payout commissions={commissions} vaOptions={vaOptions} reload={reloadAll} />
      )}

      {tab === "chargebacks" && (
        <Chargebacks
          commissions={commissions}
          loading={listQ.loading}
          error={listQ.error}
          reload={reloadAll}
        />
      )}

      {tab === "reports" && <Reports commissions={commissions} vaOptions={vaOptions} />}
      {tab === "settings" && <Settings />}
      {tab === "guidelines" && <Guidelines />}
    </div>
  );
}

function Loading() {
  return <div style={{ color: C.grey, padding: "40px 0", fontSize: 14 }}>Loading commission data…</div>;
}
