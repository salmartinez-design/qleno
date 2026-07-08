import { ReactNode, useEffect, useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppSidebar } from "./app-sidebar";
import { useAuthStore } from "@/lib/auth";
import { useLocation, Link } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { NotificationBell } from "@/components/notification-bell";
import { useTenantBrand } from "@/lib/tenant-brand";
import { useIsMobile } from "@/hooks/use-mobile";
import { VoiceAssistant } from "@/components/voice-assistant";
import { GlobalSearch } from "@/components/global-search";
import { ChatPanel } from "@/components/chat-panel";
import { KeyboardShortcutsOverlay, useKeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { ChangePasswordModal } from "@/components/change-password-modal";
import { useBranch } from "@/contexts/branch-context";
import {
  LayoutDashboard, CalendarDays, ClipboardList, Users,
  UserCheck, FileText, DollarSign, BarChart2, TrendingUp,
  BookOpen, Star, Settings, Clock,
  MoreHorizontal, Search, MessageSquare, X, ChevronRight,
  ChevronDown, Eye, LogOut, CircleHelp, KeyRound, Bell,
  CalendarX2, UserMinus, AlertTriangle, Plus, Receipt, Briefcase, UserPlus,
  GraduationCap,
  Building2, CalendarClock, LifeBuoy,
} from "lucide-react";
import { useEmployeeView } from "@/contexts/employee-view-context";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface DashboardLayoutProps {
  children: ReactNode;
  title?: string;
  fullBleed?: boolean;
  onNewJob?: () => void;
}

const ROUTE_TITLES: Record<string, string> = {
  '/dashboard':                    'Dashboard',
  '/dispatch':                     'Jobs',
  '/jobs':                         'Jobs',
  '/my-jobs':                      'My Jobs',
  '/leave':                        'Time Off',
  '/employees':                    'Employees',
  '/employees/clocks':             'Clock Monitor',
  '/customers':                    'Customers',
  '/invoices':                     'Invoices',
  '/payroll':                      'Payroll',
  '/cleancyclopedia':              'Cleancyclopedia',
  '/loyalty':                      'Loyalty',
  '/company':                      'Company Settings',
  '/leads':                        'Lead Pipeline',
  '/reports':                      'Reports',
  '/reports/insights':             'Core KPIs',
  '/reports/revenue':              'Revenue Summary',
  '/reports/payroll':              'Payroll Summary',
  '/reports/employee-stats':       'Employee Stats',
  '/reports/tips':                 'Tips Report',
  '/reports/receivables':          'Accounts Receivable',
  '/reports/job-costing':          'Job Costing',
  '/reports/payroll-to-revenue':   'Payroll % Revenue',
  '/reports/efficiency':           'Schedule Efficiency',
  '/reports/week-review':          'Week in Review',
  '/reports/scorecards':           'Scorecards',
  '/reports/cancellations':        'Cancellations',
  '/reports/contact-tickets':      'Contact Tickets',
  '/reports/hot-sheet':            'Hot Sheet',
  '/reports/first-time':           'First Time In',
  '/company/zones':                'Service Zones',
  '/company/rates':                'Rates & Add-ons',
  '/notifications':                'Notifications',
};

const BOTTOM_TABS_MANAGER = [
  { href: '/dashboard', icon: LayoutDashboard, label: 'Today' },
  { href: '/dispatch',  icon: CalendarDays,    label: 'Schedule' },
  { href: '/customers', icon: Users,            label: 'Customers' },
  { href: '/messages',  icon: MessageSquare,    label: 'Messages' },
];

const BOTTOM_TABS_TECH = [
  { href: '/my-jobs',   icon: ClipboardList,   label: 'My Jobs'  },
  { href: '/my-day',    icon: CalendarDays,    label: 'My Day'   },
  { href: '/leave',     icon: CalendarClock,   label: 'Time Off' },
];

function getBottomTabs(role?: string) {
  return (role === 'technician' || role === 'team_lead') ? BOTTOM_TABS_TECH : BOTTOM_TABS_MANAGER;
}

const MORE_CARDS = [
  // Sales / pipeline (were unreachable on mobile)
  { title: 'Leads',          href: '/leads',              icon: UserPlus    },
  { title: 'Estimates',      href: '/estimates',          icon: ClipboardList },
  { title: 'Accounts',       href: '/accounts',           icon: Building2   },
  // Team / time
  { title: 'Employees',      href: '/employees',         icon: UserCheck   },
  { title: 'Time Clock',     href: '/time-clock',         icon: Clock       },
  { title: 'Clock Monitor',  href: '/employees/clocks',  icon: Clock       },
  // Money / insights
  { title: 'Invoices',       href: '/invoices',           icon: FileText    },
  { title: 'Payroll',        href: '/payroll',            icon: DollarSign  },
  { title: 'Reports',        href: '/reports',            icon: BarChart2   },
  { title: 'Core KPIs',      href: '/reports/insights',  icon: TrendingUp  },
  // Other
  { title: 'Loyalty',        href: '/loyalty',            icon: Star        },
  { title: 'Help & Guides',  href: '/help',               icon: LifeBuoy,    tech: true },
  { title: 'Cleancyclopedia', href: '/cleancyclopedia',  icon: BookOpen,    tech: true },
  { title: 'Training',       href: '/training',           icon: GraduationCap, tech: true },
  { title: 'Company',        href: '/company',            icon: Settings    },
];

function MoreSheet({ open, onClose, navigate, onChangePw, isTech }: { open: boolean; onClose: () => void; navigate: (path: string) => void; onChangePw?: () => void; isTech?: boolean }) {
  // [tech-confinement 2026-06-26] Techs see ONLY the tech-safe cards (Help,
  // Cleancyclopedia, Training) — never the office pages (Payroll, Employees,
  // Company/Settings, …). Without this filter the More sheet leaked the whole
  // office menu to technicians.
  const cards = MORE_CARDS.filter((c) => !isTech || (c as any).tech);
  const logout = useAuthStore(state => state.logout);

  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.45)',
          zIndex: 60, opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.25s',
        }}
      />
      {/* Sheet */}
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 70,
        backgroundColor: '#FFFFFF', borderRadius: '16px 16px 0 0',
        maxHeight: '82vh', display: 'flex', flexDirection: 'column',
        transform: open ? 'translateY(0)' : 'translateY(100%)',
        transition: 'transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)',
        boxShadow: '0 -4px 24px rgba(0,0,0,0.12)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {/* Handle */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: '#E5E2DC' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 20px 14px' }}>
          <p style={{ fontSize: 16, fontWeight: 700, color: '#1A1917', margin: 0, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>More</p>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '0 16px 0', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {cards.map(card => {
              const Icon = card.icon;
              return (
                <button
                  key={card.title}
                  onClick={() => { navigate(card.href); onClose(); }}
                  style={{
                    background: '#F7F6F3', borderRadius: 12, padding: '16px',
                    border: '1px solid #EEECE7', cursor: 'pointer', textAlign: 'left',
                    minHeight: 72, display: 'flex', flexDirection: 'column', gap: 8,
                    fontFamily: "'Plus Jakarta Sans', sans-serif",
                  }}
                >
                  <Icon size={24} style={{ color: 'var(--brand)' }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#1A1917' }}>{card.title}</span>
                </button>
              );
            })}
          </div>

          {/* Account actions */}
          <div style={{ borderTop: '1px solid #EEECE7', marginTop: 16, paddingTop: 12, paddingBottom: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              onClick={() => { navigate('/settings/notifications'); onClose(); }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                background: 'none', border: '1px solid #EEECE7', borderRadius: 12,
                padding: '14px 16px', cursor: 'pointer', color: '#1A1917',
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              <Bell size={20} style={{ color: '#6B7280' }} />
              <span style={{ fontSize: 14, fontWeight: 600 }}>Notification settings</span>
            </button>
            {onChangePw && (
              <button
                onClick={onChangePw}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                  background: 'none', border: '1px solid #EEECE7', borderRadius: 12,
                  padding: '14px 16px', cursor: 'pointer', color: '#1A1917',
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                }}
              >
                <KeyRound size={20} style={{ color: '#6B7280' }} />
                <span style={{ fontSize: 14, fontWeight: 600 }}>Change Password</span>
              </button>
            )}
            <button
              onClick={() => { onClose(); logout(); }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                background: 'none', border: '1px solid #EEECE7', borderRadius: 12,
                padding: '14px 16px', cursor: 'pointer', color: '#DC2626',
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              <LogOut size={20} />
              <span style={{ fontSize: 14, fontWeight: 600 }}>Sign Out</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const BRANCH_ROLES = new Set(["owner", "admin", "office"]);

function BranchSwitcher({ role, compact = false }: { role?: string; compact?: boolean }) {
  const { branches, activeBranchId, setActiveBranchId } = useBranch();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!role || !BRANCH_ROLES.has(role) || branches.length < 2) return null;

  const label = activeBranchId === "all"
    ? "All Locations"
    : branches.find(b => b.id === activeBranchId)?.name ?? "All Locations";

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(p => !p)}
        style={{
          display: "flex", alignItems: "center", gap: compact ? 4 : 6,
          padding: compact ? "4px 10px" : "5px 12px",
          background: activeBranchId === "all" ? "#F7F6F3" : "var(--brand-dim)",
          border: `1px solid ${activeBranchId === "all" ? "#E5E2DC" : "var(--brand)"}`,
          borderRadius: 20, cursor: "pointer",
          color: activeBranchId === "all" ? "#6B7280" : "var(--brand)",
          fontSize: compact ? 11 : 12,
          fontWeight: 600,
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          whiteSpace: "nowrap",
        }}
      >
        {label}
        <ChevronDown size={compact ? 10 : 12} />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0,
          background: "#FFFFFF", border: "1px solid #E5E2DC",
          borderRadius: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
          zIndex: 200, minWidth: 160, overflow: "hidden",
        }}>
          {[{ id: "all" as const, name: "All Locations" }, ...branches].map(b => {
            const isActive = b.id === activeBranchId;
            return (
              <button
                key={b.id}
                onClick={() => { setActiveBranchId(b.id as any); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "9px 14px",
                  background: isActive ? "var(--brand-dim)" : "transparent",
                  border: "none", cursor: "pointer", textAlign: "left",
                  fontSize: 13, fontWeight: isActive ? 600 : 400,
                  color: isActive ? "var(--brand)" : "#1A1917",
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                }}
              >
                {b.name}
                {isActive && <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "var(--brand)" }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CompanySwitcher({ compact = false }: { compact?: boolean }) {
  const availableCompanies = useAuthStore(state => state.availableCompanies);
  const isSwitching = useAuthStore(state => state.isSwitchingCompany);
  const switchCompany = useAuthStore(state => state.switchCompany);
  const token = useAuthStore(state => state.token);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [location, navigate] = useLocation();

  // Derive current company from the JWT claim
  let currentCompanyId: number | null = null;
  if (token) {
    try {
      const p = JSON.parse(atob(token.split('.')[1]));
      currentCompanyId = p.companyId ?? null;
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!availableCompanies || availableCompanies.length < 2) return null;

  // [company-order 2026-06-17] No backend sort, so the list came back in
  // insertion order (Phes Schaumburg ahead of Phes). Sort alphabetically so the
  // primary "Phes" (Oak Lawn — the most-active company) leads. localeCompare
  // puts "Phes" before "Phes Schaumburg".
  const sortedCompanies = [...availableCompanies].sort((a, b) => a.name.localeCompare(b.name));

  const currentCompany = availableCompanies.find(c => c.id === currentCompanyId);
  const label = currentCompany?.name ?? 'Switch Company';

  const handleSwitch = async (companyId: number) => {
    if (companyId === currentCompanyId || isSwitching) return;
    setOpen(false);
    try {
      await switchCompany(companyId);
      // Invalidate all queries so data refreshes for the new company
      queryClient.invalidateQueries();
      // Selecting a specific company from the All-Locations roll-up should drop
      // you onto THAT company's view, not leave you on the cross-company page.
      if (location === '/all-locations' || location.startsWith('/all-locations')) {
        navigate('/dashboard');
      }
    } catch (err: any) {
      console.error('Company switch failed:', err?.message);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(p => !p)}
        disabled={isSwitching}
        title="Switch company"
        style={{
          display: 'flex', alignItems: 'center', gap: compact ? 4 : 6,
          padding: compact ? '4px 10px' : '5px 12px',
          background: 'var(--brand-dim)',
          border: '1px solid var(--brand)',
          borderRadius: 20, cursor: isSwitching ? 'wait' : 'pointer',
          color: 'var(--brand)',
          fontSize: compact ? 11 : 12,
          fontWeight: 600,
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          whiteSpace: 'nowrap',
          opacity: isSwitching ? 0.6 : 1,
        }}
      >
        <Building2 size={compact ? 11 : 13} />
        {isSwitching ? 'Switching…' : label}
        <ChevronDown size={compact ? 10 : 12} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0,
          background: '#FFFFFF', border: '1px solid #E5E2DC',
          borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          zIndex: 200, minWidth: 180, overflow: 'hidden',
        }}>
          <div style={{ padding: '8px 12px 6px', borderBottom: '1px solid #F0EDEA' }}>
            <p style={{ margin: 0, fontSize: 10, fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              Switch Company
            </p>
          </div>
          {sortedCompanies.map(c => {
            const isActive = c.id === currentCompanyId;
            return (
              <button
                key={c.id}
                onClick={() => handleSwitch(c.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '9px 14px',
                  background: isActive ? 'var(--brand-dim)' : 'transparent',
                  border: 'none', cursor: isActive ? 'default' : 'pointer', textAlign: 'left',
                  fontSize: 13, fontWeight: isActive ? 600 : 400,
                  color: isActive ? 'var(--brand)' : '#1A1917',
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                }}
              >
                {c.name}
                {isActive && <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: 'var(--brand)', flexShrink: 0 }} />}
              </button>
            );
          })}
          {/* Cross-tenant owner roll-up — only reachable when the user has ≥2
              companies (this whole switcher only renders then), and the endpoint
              itself returns only companies the caller owns. */}
          <Link href="/all-locations" onClick={() => setOpen(false)} style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '9px 14px',
            borderTop: '1px solid #F0EDEA', background: 'transparent', textDecoration: 'none',
            fontSize: 13, fontWeight: 600, color: 'var(--brand)', cursor: 'pointer',
            fontFamily: "'Plus Jakarta Sans', sans-serif",
          }}>
            <Building2 size={13} /> All Locations
          </Link>
        </div>
      )}
    </div>
  );
}

// Unread SMS count for the Messages bottom-nav badge (office/manager only).
function useSmsUnread(role: string | undefined) {
  const token = useAuthStore(s => s.token); // re-fetch on company switch (token changes)
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (role === "technician") return;
    let alive = true;
    const fetch_ = async () => {
      try {
        const r = await fetch(`${API}/api/sms/unread-count`, { headers: getAuthHeaders() });
        const d = await r.json();
        if (alive) setCount(d.unread || 0);
      } catch {}
    };
    fetch_();
    const iv = setInterval(fetch_, 15000);
    return () => { alive = false; clearInterval(iv); };
  }, [role, token]);
  return count;
}

function useUnreadCount(userId: number | undefined) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!userId) return;
    const fetch_ = async () => {
      try {
        const r = await fetch(`${API}/api/messages/unread`, { headers: getAuthHeaders() });
        const d = await r.json();
        setCount(d.unread || 0);
      } catch {}
    };
    fetch_();
    const iv = setInterval(fetch_, 15000);
    return () => clearInterval(iv);
  }, [userId]);
  return count;
}

// Per-tenant comms state — the banner shows only when THIS tenant can't send
// (global master off OR company.comms_enabled false). No hardcoded flag, so a
// live tenant (e.g. PHES Schaumburg) never shows a misleading "paused" banner.
function useCommsPaused() {
  const token = useAuthStore(s => s.token); // re-fetch on company switch (token changes)
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let alive = true;
    const fetch_ = async () => {
      try {
        const r = await fetch(`${API}/api/comms-status`, { headers: getAuthHeaders() });
        const d = await r.json();
        if (alive) setPaused(!!d.paused);
      } catch { /* leave as-is on error */ }
    };
    fetch_();
    const iv = setInterval(fetch_, 30000);
    return () => { alive = false; clearInterval(iv); };
  }, [token]);
  return paused;
}

const CommsPausedBanner = () => {
  const paused = useCommsPaused();
  return paused ? (
    <div style={{
      background: '#FEF3C7', borderBottom: '1px solid #F59E0B',
      padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 8,
      fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 13, color: '#92400E', fontWeight: 500,
      flexShrink: 0,
    }}>
      <span style={{ fontSize: 16 }}>⚠️</span>
      <span><strong>Outbound communications are paused.</strong> SMS, email, and all automated notifications are currently disabled. No messages will be sent to customers or staff.</span>
    </div>
  ) : null;
};

export function DashboardLayout({ children, title, fullBleed, onNewJob }: DashboardLayoutProps) {
  const { employeeView, exitView } = useEmployeeView();
  const token = useAuthStore(state => state.token);
  const setToken = useAuthStore(state => state.setToken);
  const logout = useAuthStore(state => state.logout);
  const [location, setLocation] = useLocation();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [userDropOpen, setUserDropOpen] = useState(false);
  const [changePwOpen, setChangePwOpen] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const userDropRef = useRef<HTMLDivElement>(null);
  const quickCreateRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!userDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (userDropRef.current && !userDropRef.current.contains(e.target as Node)) setUserDropOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userDropOpen]);


  useEffect(() => {
    if (!quickCreateOpen) return;
    const handler = (e: MouseEvent) => {
      if (quickCreateRef.current && !quickCreateRef.current.contains(e.target as Node)) setQuickCreateOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [quickCreateOpen]);

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data: user, isLoading, isError, error } = useGetMe({
    request: { headers: getAuthHeaders() },
    // Ride through transient /me failures instead of instantly destroying the
    // session. A rolling deploy, a brief 5xx, or a replica mid-secret-rotation
    // can reject a freshly-signed token for a second or two; without a retry
    // that single 401 nukes the token and bounces the user back to /login,
    // trapping them in a login loop on every attempt. We retry a few times
    // with a short capped backoff before trusting the error. A genuinely bad
    // token only delays logout by ~3s; a transient blip no longer locks anyone
    // out. Logout still only fires after the retries are exhausted (below).
    query: {
      enabled: !!token,
      retry: 3,
      retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2000),
    },
  });

  const isManager = user?.role === 'owner' || user?.role === 'office';
  // [tech-confinement 2026-06-26] Technicians/team_leads are locked to the
  // confined field view on EVERY screen size — never the office shell/sidebar.
  // A tech on desktop must see only the technician view (Sal). Drives the layout
  // branch below plus the office-only affordances (Quick Create, More sheet).
  const isTech = user?.role === 'technician' || user?.role === 'team_lead';
  // [tech-experience 2026-06-17] Keyboard shortcuts + the shortcuts overlay /
  // help button are office-tier only — every shortcut targets an office page
  // (Quotes, Dispatch, Payroll, Employees…). Techs (technician/team_lead) see
  // none of it: no listener, no "?" overlay, no help button, no ⇧/ hint.
  const canUseShortcuts = !!user?.role && ['owner', 'admin', 'office', 'super_admin'].includes(user.role);

  const { data: notifData } = useQuery({
    // Per-user inbox for ALL roles (techs get job alerts too). token in the key
    // so a company switch re-scopes the feed cleanly.
    queryKey: ['notifications-inbox', token],
    queryFn: async () => {
      const r = await fetch(`${API}/api/notifications/inbox?limit=20`, { headers: getAuthHeaders() as any });
      if (!r.ok) return { data: [], unread_count: 0 };
      return r.json();
    },
    enabled: !!token,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  // [time-off-ticket 2026-06-22] Separate STAFF notifications bell — pending
  // time-off requests (and, later, equipment/supply requests). Office tier only.
  const isOfficeTier = !!user?.role && ['owner', 'admin', 'office', 'super_admin'].includes(user.role);
  const { data: empReqData } = useQuery({
    queryKey: ['employee-pending-count', token],
    queryFn: async () => {
      const r = await fetch(`${API}/api/leave/requests/pending-count`, { headers: getAuthHeaders() as any });
      if (!r.ok) return { pending: 0 };
      return r.json();
    },
    enabled: !!token && isOfficeTier,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
  const empPending: number = empReqData?.pending || 0;

  // [employee-bell fix 2026-06-23] Clicking the staff bell focuses the requests
  // section. Gate on the section element's PRESENCE in the DOM, not on
  // `location === '/employees'` — that string compare didn't hold on prod, so the
  // handler fell to a no-op navigate and the scroll stayed at the top.
  // Element present → already on the page: scroll directly. The real scroll parent
  //   is <main> (overflow:auto), NOT window; Element.scrollIntoView bubbles to the
  //   nearest scrollable ancestor, so this drives <main> even though window never
  //   scrolls. Fire the event too — but only to flash the highlight.
  // Element absent  → navigate in; the section reads a one-shot flag on mount and
  //   scrolls itself once laid out.
  const goToEmployeeRequests = () => {
    const el = document.getElementById('timeoff-requests-section');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.dispatchEvent(new CustomEvent('qleno:focus-timeoff'));
    } else {
      try { sessionStorage.setItem('qlenoFocusTimeOff', '1'); } catch { /* private mode */ }
      setLocation('/employees');
    }
  };

  const notifUnread: number = notifData?.unread_count || 0;



  useTenantBrand();
  const unreadCount = useUnreadCount(user?.id);
  const smsUnread = useSmsUnread(user?.role);

  useEffect(() => {
    if (isError) {
      const status = (error as any)?.status;
      if (status === 401 || status === 403) {
        setToken(null);
        setLocation("/login");
      }
    }
  }, [isError, error, setToken, setLocation]);

  useEffect(() => {
    setDrawerOpen(false);
    setMoreOpen(false);
  }, [location]);

  useEffect(() => {
    const pt = title || ROUTE_TITLES[location] || 'Qleno';
    document.title = `${pt} — Qleno`;
  }, [location, title]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '?' && canUseShortcuts) setShortcutsOpen(p => !p);
      if (e.key === 'Escape') { setSearchOpen(false); setChatOpen(false); setShortcutsOpen(false); setMoreOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canUseShortcuts]);

  useKeyboardShortcuts({
    onOpenSearch: useCallback(() => setSearchOpen(true), []),
    onNewJob,
    enabled: canUseShortcuts,
  });

  if (!token) return null;

  if (isLoading) {
    return (
      <div style={{ height: '100vh', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7F6F3' }}>
        <div style={{ width: 28, height: 28, border: '2px solid #E5E2DC', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const pageTitle = title || ROUTE_TITLES[location] || 'Qleno';
  const initials = user ? `${user.first_name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase() : '';

  if (isMobile || isTech) {
    const bottomTabs = getBottomTabs(user?.role);
    const isMoreActive = !bottomTabs.some(t => t.href === '/dashboard' ? location === t.href : location.startsWith(t.href));
    return (
      <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", backgroundColor: '#F7F6F3', minHeight: '100dvh', color: '#1A1917', position: 'relative' }}>
        {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}
        {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} userId={user?.id || 0} />}
        {shortcutsOpen && canUseShortcuts && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
        <ChangePasswordModal open={changePwOpen} onClose={() => setChangePwOpen(false)} />
        <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} navigate={setLocation} onChangePw={() => { setMoreOpen(false); setChangePwOpen(true); }} isTech={isTech} />

        {/* Top header */}
        <header style={{
          position: 'sticky', top: 0, zIndex: 30,
          backgroundColor: '#FFFFFF', borderBottom: '1px solid #E5E2DC',
          padding: '0 16px', height: 52,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: 'var(--brand)', flexShrink: 0 }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pageTitle}</span>
            <BranchSwitcher role={user?.role} compact />
            <CompanySwitcher compact />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button onClick={() => setSearchOpen(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', padding: '4px', display: 'flex', alignItems: 'center' }}>
              <Search size={19} />
            </button>
            {/* [header-cleanup 2026-07-08] Removed the team-chat icon next to
                Search (Sal: "useless"). Staff messaging still reachable elsewhere. */}

            {/* Employee notifications bell (office tier) → Employees page */}
            {isOfficeTier && (
              <button onClick={goToEmployeeRequests} title="Employee notifications — time off & requests" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', padding: '4px', position: 'relative', display: 'flex', alignItems: 'center' }}>
                <CalendarClock size={19} />
                {empPending > 0 && (
                  <span style={{ position: 'absolute', top: 0, right: 0, minWidth: 14, height: 14, borderRadius: 7, background: 'var(--brand)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: '#04241d', fontWeight: 800, padding: '0 2px' }}>
                    {empPending > 9 ? '9+' : empPending}
                  </span>
                )}
              </button>
            )}

            {/* Notifications bell → full notifications page (all roles) */}
            <button onClick={() => setLocation('/notifications')} title="Notifications" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', padding: '4px', position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Bell size={19} />
              {notifUnread > 0 && (
                <span style={{ position: 'absolute', top: 0, right: 0, minWidth: 14, height: 14, borderRadius: 7, background: '#EF4444', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: '#fff', fontWeight: 800, padding: '0 2px' }}>
                  {notifUnread > 9 ? '9+' : notifUnread}
                </span>
              )}
            </button>

            {/* ── Quick Create (office tier only — techs never create jobs/quotes/clients) ── */}
            {!isTech && (
            <div ref={quickCreateRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setQuickCreateOpen(p => !p)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28, borderRadius: 7, cursor: 'pointer',
                  background: '#1A1917', border: 'none', color: '#FFF',
                }}
              >
                <Plus size={16} strokeWidth={2.5} />
              </button>

              {quickCreateOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                  background: '#FFF', borderRadius: 14, border: '1px solid #E5E2DC',
                  boxShadow: '0 12px 36px rgba(10,14,26,0.14)', width: 244, zIndex: 300,
                  padding: 6,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '7px 10px 5px', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Create new</div>
                  {([
                    { label: 'Quote',  desc: 'Build a price quote', Icon: Receipt,   href: '/quotes/new' },
                    { label: 'Job',    desc: 'Schedule a job',      Icon: Briefcase, href: '/dispatch?new=1' },
                    { label: 'Client', desc: 'Add a customer',      Icon: UserPlus,  href: '/customers' },
                  ] as const).map((item) => (
                    <button
                      key={item.label}
                      onClick={() => { setLocation(item.href); setQuickCreateOpen(false); }}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                        padding: '9px 10px', border: 'none', borderRadius: 10,
                        background: 'none', cursor: 'pointer', textAlign: 'left' as const,
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#F7F6F3')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                    >
                      <span style={{ width: 34, height: 34, borderRadius: 9, background: 'rgba(45,155,131,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <item.Icon size={16} color="#2D9B83" />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: '#1A1917', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{item.label}</span>
                        <span style={{ display: 'block', fontSize: 11, color: '#9E9B94', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{item.desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            )}
          </div>
        </header>

        {employeeView && (
          <div style={{
            backgroundColor: 'var(--brand)', height: 40,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 16px', flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Eye size={14} style={{ color: '#fff' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                Previewing as {employeeView.employeeName}
              </span>
            </div>
            <button
              onClick={exitView}
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.45)',
                background: 'rgba(255,255,255,0.15)',
                color: '#fff', fontSize: 11, fontWeight: 600,
                cursor: 'pointer', fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              Exit Preview
            </button>
          </div>
        )}

        <main style={{ padding: '0 0 calc(64px + max(8px, env(safe-area-inset-bottom)))', display: 'flex', flexDirection: 'column' }}>
          <CommsPausedBanner />
          <div style={{ padding: '16px 14px 0' }}>{children}</div>
        </main>

        {/* Bottom nav */}
        <nav style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 30,
          backgroundColor: '#FFFFFF', borderTop: '1px solid #E5E2DC',
          display: 'flex', alignItems: 'stretch',
          paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
          boxSizing: 'border-box' as const,
        }}>
          {bottomTabs.map(tab => {
            const isTab = tab.href === '/dashboard' ? location === tab.href : location.startsWith(tab.href);
            const Icon = tab.icon;
            return (
              <Link key={tab.href} href={tab.href} style={{ flex: '1 1 0', minWidth: 0, textDecoration: 'none' }}>
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  minHeight: 56, gap: 3, cursor: 'pointer', position: 'relative',
                  color: isTab ? 'var(--brand)' : '#9E9B94',
                }}>
                  <div style={{ position: 'relative' }}>
                    <Icon size={22} strokeWidth={isTab ? 2.5 : 1.8} />
                    {tab.href === '/messages' && smsUnread > 0 && (
                      <span style={{ position: 'absolute', top: -5, right: -9, background: '#EF4444', color: '#fff', fontSize: 9, fontWeight: 800, lineHeight: '14px', minWidth: 14, height: 14, borderRadius: 7, padding: '0 3px', textAlign: 'center' }}>
                        {smsUnread > 9 ? '9+' : smsUnread}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 10, fontWeight: isTab ? 600 : 500, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{tab.label}</span>
                  {isTab && <div style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: 'var(--brand)', marginTop: -1 }} />}
                </div>
              </Link>
            );
          })}
          {/* More tab */}
          <button
            onClick={() => setMoreOpen(p => !p)}
            style={{
              flex: '1 1 0', minWidth: 0, minHeight: 56,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 3, background: 'none', border: 'none', cursor: 'pointer',
              color: isMoreActive || moreOpen ? 'var(--brand)' : '#9E9B94',
              padding: 0,
            }}
          >
            <MoreHorizontal size={22} strokeWidth={isMoreActive || moreOpen ? 2.5 : 1.8} />
            <span style={{ fontSize: 10, fontWeight: isMoreActive || moreOpen ? 600 : 500, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>More</span>
            {(isMoreActive || moreOpen) && <div style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: 'var(--brand)', marginTop: -1 }} />}
          </button>
        </nav>
        <VoiceAssistant />
      </div>
    );
  }

  // Desktop layout
  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', backgroundColor: '#F7F6F3', overflow: 'hidden' }}>
      {/* Sidebar slot — 56px wide; sidebar overlays via absolute positioning */}
      <div style={{ position: 'relative', width: 56, flexShrink: 0 }}>
        <AppSidebar />
      </div>

      {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}
      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} userId={user?.id || 0} />}
      {shortcutsOpen && canUseShortcuts && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      <ChangePasswordModal open={changePwOpen} onClose={() => setChangePwOpen(false)} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <header style={{ height: 56, backgroundColor: '#FFFFFF', borderBottom: '1px solid #EEECE7', padding: '0 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1A1917', letterSpacing: '-0.02em', lineHeight: 1, margin: 0, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              {pageTitle}
            </h1>
            <BranchSwitcher role={user?.role} />
            <CompanySwitcher />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => setSearchOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#F7F6F3', border: '1px solid #E5E2DC', borderRadius: 8, cursor: 'pointer', color: '#9E9B94', fontSize: 13, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              <Search size={14} />
              <span>Search</span>
              {canUseShortcuts && <kbd style={{ fontSize: 10, border: '1px solid #E5E2DC', borderRadius: 3, padding: '1px 5px', color: '#C0BDB8' }}>⇧/</kbd>}
            </button>

            <button onClick={() => setChatOpen(p => !p)} title="Team Chat"
              style={{ background: chatOpen ? 'var(--brand-dim)' : 'none', border: 'none', cursor: 'pointer', color: chatOpen ? 'var(--brand)' : '#6B7280', padding: 6, borderRadius: 8, display: 'flex', alignItems: 'center', position: 'relative' } as any}>
              <MessageSquare size={20} />
              {unreadCount > 0 && (
                <span style={{ position: 'absolute', top: 2, right: 2, width: 9, height: 9, borderRadius: 5, background: '#EF4444', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: '#fff', fontWeight: 700 }}>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {/* ── Quick Create "New" dropdown ─────────────────────────────── */}
            <div ref={quickCreateRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setQuickCreateOpen(p => !p)}
                title="Quick Create"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 13px', borderRadius: 10, cursor: 'pointer',
                  background: quickCreateOpen ? '#000' : '#1A1917', border: 'none', color: '#FFF',
                  fontSize: 13, fontWeight: 700,
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  transition: 'background 0.12s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#000')}
                onMouseLeave={e => (e.currentTarget.style.background = quickCreateOpen ? '#000' : '#1A1917')}
              >
                <Plus size={15} strokeWidth={2.5} />
                <span>New</span>
              </button>

              {quickCreateOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                  background: '#FFF', borderRadius: 14, border: '1px solid #E5E2DC',
                  boxShadow: '0 12px 36px rgba(10,14,26,0.14)', width: 244, zIndex: 300,
                  padding: 6,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '7px 10px 5px', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Create new</div>
                  {([
                    { label: 'Quote',  desc: 'Build a price quote', Icon: Receipt,   href: '/quotes/new' },
                    { label: 'Job',    desc: 'Schedule a job',      Icon: Briefcase, href: '/dispatch?new=1' },
                    { label: 'Client', desc: 'Add a customer',      Icon: UserPlus,  href: '/customers' },
                  ] as const).map((item) => (
                    <button
                      key={item.label}
                      onClick={() => { setLocation(item.href); setQuickCreateOpen(false); }}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                        padding: '9px 10px', border: 'none', borderRadius: 10,
                        background: 'none', cursor: 'pointer', textAlign: 'left' as const,
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#F7F6F3')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                    >
                      <span style={{ width: 34, height: 34, borderRadius: 9, background: 'rgba(45,155,131,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <item.Icon size={16} color="#2D9B83" />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: '#1A1917', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{item.label}</span>
                        <span style={{ display: 'block', fontSize: 11, color: '#9E9B94', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{item.desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {canUseShortcuts && (
              <button onClick={() => setShortcutsOpen(true)} title="Keyboard Shortcuts"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: 6, borderRadius: 8, display: 'flex', alignItems: 'center' }}>
                <CircleHelp size={18} />
              </button>
            )}

            {isOfficeTier && (
              <button
                onClick={goToEmployeeRequests}
                title="Employee notifications — time off & requests"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', padding: 6, borderRadius: 8, display: 'flex', alignItems: 'center', position: 'relative' } as any}
              >
                <CalendarClock size={20} />
                {empPending > 0 && (
                  <span style={{ position: 'absolute', top: 2, right: 2, minWidth: 9, height: 9, borderRadius: 5, background: 'var(--brand)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: '#04241d', fontWeight: 700, padding: '0 2px' }}>
                    {empPending > 9 ? '9+' : empPending}
                  </span>
                )}
              </button>
            )}

            {user && (
              <NotificationBell />
            )}

            {user && (
              <>
                <div style={{ width: 1, height: 24, background: '#E5E2DC' }} />
                <div ref={userDropRef} style={{ position: 'relative' }}>
                  <button
                    onClick={() => setUserDropOpen(p => !p)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 8 }}
                  >
                    <p style={{ fontSize: 13, fontWeight: 500, color: '#1A1917', margin: 0 }}>{user.first_name} {user.last_name}</p>
                    <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--brand)', backgroundColor: 'var(--brand-dim)', padding: '2px 6px', borderRadius: 4, letterSpacing: '0.05em' }}>
                      {user.role}
                    </span>
                    {(user as any)?.avatar_url ? (
                      <img
                        src={(user as any).avatar_url}
                        alt={`${user.first_name} ${user.last_name}`}
                        style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                      />
                    ) : (
                      <div style={{ width: 36, height: 36, borderRadius: '50%', backgroundColor: 'var(--brand-dim)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}>
                        {initials}
                      </div>
                    )}
                    <ChevronDown size={14} style={{ color: '#9E9B94', transform: userDropOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                  </button>
                  {userDropOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', right: 0, marginTop: 6,
                      background: '#fff', borderRadius: 10, border: '1px solid #E5E2DC',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.10)', minWidth: 180, zIndex: 100,
                      padding: 6, display: 'flex', flexDirection: 'column', gap: 2,
                    }}>
                      <button
                        onClick={() => { setUserDropOpen(false); setChangePwOpen(true); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 7, background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 13, fontWeight: 500, color: '#1A1917' }}
                      >
                        <KeyRound size={15} style={{ color: '#6B7280' }} />
                        Change Password
                      </button>
                      <button
                        onClick={() => { setUserDropOpen(false); setLocation('/settings/notifications'); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 7, background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 13, fontWeight: 500, color: '#1A1917' }}
                      >
                        <Bell size={15} style={{ color: '#6B7280' }} />
                        Notification settings
                      </button>
                      <div style={{ height: 1, background: '#F0EDEA', margin: '2px 0' }} />
                      <button
                        onClick={() => { setUserDropOpen(false); logout(); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 7, background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 13, fontWeight: 500, color: '#DC2626' }}
                      >
                        <LogOut size={15} />
                        Sign Out
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </header>

        {employeeView && (
          <div style={{
            backgroundColor: 'var(--brand)', height: 40,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 28px', flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Eye size={15} style={{ color: '#fff' }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#fff', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                Previewing as {employeeView.employeeName}
              </span>
            </div>
            <button
              onClick={exitView}
              style={{
                padding: '5px 14px', borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.45)',
                background: 'rgba(255,255,255,0.15)',
                color: '#fff', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              Exit Preview
            </button>
          </div>
        )}

        {fullBleed ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <CommsPausedBanner />
            {children}
          </div>
        ) : (
          <main style={{ flex: 1, overflowY: 'auto', scrollbarGutter: 'stable', backgroundColor: '#F7F6F3', display: 'flex', flexDirection: 'column' }}>
            <CommsPausedBanner />
            <div style={{ padding: '28px 28px', maxWidth: 1600, margin: '0 auto', width: '100%' }}>{children}</div>
          </main>
        )}
      </div>
      <VoiceAssistant />
    </div>
  );
}
