import { ReactNode, useEffect, useState, useCallback, useRef } from "react";
import { AppSidebar } from "./app-sidebar";
import { useAuthStore } from "@/lib/auth";
import { useLocation, Link } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { useTenantBrand } from "@/lib/tenant-brand";
import { useIsMobile } from "@/hooks/use-mobile";
import { GlobalSearch } from "@/components/global-search";
import { ChatPanel } from "@/components/chat-panel";
import { KeyboardShortcutsOverlay, useKeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { useBranch } from "@/contexts/branch-context";
import {
  LayoutDashboard, CalendarDays, ClipboardList, Users,
  UserCheck, FileText, DollarSign, BarChart2, TrendingUp,
  ArrowUpCircle, Tag, BookOpen, Star, Settings, Clock,
  MoreHorizontal, Search, MessageSquare, X, ChevronRight,
  MapPin, ChevronDown,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface DashboardLayoutProps {
  children: ReactNode;
  title?: string;
  fullBleed?: boolean;
  onNewJob?: () => void;
}

const ROUTE_TITLES: Record<string, string> = {
  '/dashboard':                    'Dashboard',
  '/jobs':                         'Dispatch Board',
  '/my-jobs':                      'My Jobs',
  '/employees':                    'Employees',
  '/employees/clocks':             'Clock Monitor',
  '/customers':                    'Customers',
  '/invoices':                     'Invoices',
  '/payroll':                      'Payroll',
  '/cleancyclopedia':              'Cleancyclopedia',
  '/loyalty':                      'Loyalty',
  '/discounts':                    'Discounts',
  '/company':                      'Company Settings',
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
};

const BOTTOM_TABS_MANAGER = [
  { href: '/dashboard', icon: LayoutDashboard, label: 'Today' },
  { href: '/jobs',      icon: CalendarDays,    label: 'Schedule' },
  { href: '/customers', icon: Users,            label: 'Customers' },
];

const BOTTOM_TABS_TECH = [
  { href: '/dashboard', icon: LayoutDashboard, label: 'Today' },
  { href: '/my-jobs',   icon: ClipboardList,   label: 'My Jobs' },
  { href: '/customers', icon: Users,            label: 'Customers' },
];

function getBottomTabs(role?: string) {
  return role === 'technician' ? BOTTOM_TABS_TECH : BOTTOM_TABS_MANAGER;
}

const MORE_CARDS = [
  { title: 'Employees',      href: '/employees',         icon: UserCheck   },
  { title: 'Invoices',       href: '/invoices',           icon: FileText    },
  { title: 'Payroll',        href: '/payroll',            icon: DollarSign  },
  { title: 'Reports',        href: '/reports',            icon: BarChart2   },
  { title: 'Core KPIs',      href: '/reports/insights',  icon: TrendingUp  },
  { title: 'Rate Increase',  href: '/discounts',          icon: ArrowUpCircle },
  { title: 'Discounts',      href: '/discounts',          icon: Tag         },
  { title: 'Loyalty',        href: '/loyalty',            icon: Star        },
  { title: 'Cleancyclopedia', href: '/cleancyclopedia',  icon: BookOpen    },
  { title: 'Company',        href: '/company',            icon: Settings    },
  { title: 'Clock Monitor',  href: '/employees/clocks',  icon: Clock       },
];

function MoreSheet({ open, onClose, navigate }: { open: boolean; onClose: () => void; navigate: (path: string) => void }) {
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
        <div style={{ overflowY: 'auto', padding: '0 16px 24px', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {MORE_CARDS.map(card => {
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
        <MapPin size={compact ? 11 : 13} />
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

export function DashboardLayout({ children, title, fullBleed, onNewJob }: DashboardLayoutProps) {
  const token = useAuthStore(state => state.token);
  const setToken = useAuthStore(state => state.setToken);
  const [location, setLocation] = useLocation();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data: user, isLoading, isError, error } = useGetMe({
    request: { headers: getAuthHeaders() },
    query: { enabled: !!token, retry: false },
  });

  useTenantBrand();
  const unreadCount = useUnreadCount(user?.id);

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
      if (e.key === '?') setShortcutsOpen(p => !p);
      if (e.key === 'Escape') { setSearchOpen(false); setChatOpen(false); setShortcutsOpen(false); setMoreOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useKeyboardShortcuts({
    onOpenSearch: useCallback(() => setSearchOpen(true), []),
    onNewJob,
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

  if (isMobile) {
    const bottomTabs = getBottomTabs(user?.role);
    const isMoreActive = !bottomTabs.some(t => t.href === '/dashboard' ? location === t.href : location.startsWith(t.href));
    return (
      <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", backgroundColor: '#F7F6F3', minHeight: '100dvh', color: '#1A1917', position: 'relative' }}>
        {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}
        {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} userId={user?.id || 0} />}
        {shortcutsOpen && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
        <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} navigate={setLocation} />

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
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button onClick={() => setSearchOpen(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', padding: '4px', display: 'flex', alignItems: 'center' }}>
              <Search size={19} />
            </button>
            <button onClick={() => setChatOpen(p => !p)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', padding: '4px', position: 'relative', display: 'flex', alignItems: 'center' }}>
              <MessageSquare size={19} />
              {unreadCount > 0 && <span style={{ position: 'absolute', top: 2, right: 2, width: 8, height: 8, borderRadius: 4, background: '#EF4444', border: '1px solid #fff' }} />}
            </button>
          </div>
        </header>

        <main style={{ padding: '16px 14px 80px' }}>{children}</main>

        {/* Bottom nav */}
        <nav style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 30,
          backgroundColor: '#FFFFFF', borderTop: '1px solid #E5E2DC',
          display: 'flex', alignItems: 'stretch',
          height: 64, paddingBottom: 'env(safe-area-inset-bottom)',
        }}>
          {bottomTabs.map(tab => {
            const isTab = tab.href === '/dashboard' ? location === tab.href : location.startsWith(tab.href);
            const Icon = tab.icon;
            return (
              <Link key={tab.href} href={tab.href} style={{ flex: 1, textDecoration: 'none' }}>
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  height: '100%', gap: 3, cursor: 'pointer',
                  color: isTab ? 'var(--brand)' : '#9E9B94',
                }}>
                  <Icon size={22} strokeWidth={isTab ? 2.5 : 1.8} />
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
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 3, background: 'none', border: 'none', cursor: 'pointer',
              color: isMoreActive || moreOpen ? 'var(--brand)' : '#9E9B94',
            }}
          >
            <MoreHorizontal size={22} strokeWidth={isMoreActive || moreOpen ? 2.5 : 1.8} />
            <span style={{ fontSize: 10, fontWeight: isMoreActive || moreOpen ? 600 : 500, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>More</span>
            {(isMoreActive || moreOpen) && <div style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: 'var(--brand)', marginTop: -1 }} />}
          </button>
        </nav>
      </div>
    );
  }

  // Desktop layout
  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', backgroundColor: '#F7F6F3', overflow: 'hidden' }}>
      <AppSidebar />

      {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}
      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} userId={user?.id || 0} />}
      {shortcutsOpen && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <header style={{ height: 56, backgroundColor: '#FFFFFF', borderBottom: '1px solid #EEECE7', padding: '0 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1A1917', letterSpacing: '-0.02em', lineHeight: 1, margin: 0, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              {pageTitle}
            </h1>
            <BranchSwitcher role={user?.role} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => setSearchOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#F7F6F3', border: '1px solid #E5E2DC', borderRadius: 8, cursor: 'pointer', color: '#9E9B94', fontSize: 13, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              <Search size={14} />
              <span>Search</span>
              <kbd style={{ fontSize: 10, border: '1px solid #E5E2DC', borderRadius: 3, padding: '1px 5px', color: '#C0BDB8' }}>/</kbd>
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

            <button onClick={() => setShortcutsOpen(true)} title="Keyboard Shortcuts (?)"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: 6, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', fontFamily: 'inherit' }}>
              <span style={{ fontSize: 12, border: '1px solid #E5E2DC', borderRadius: 3, padding: '1px 6px', color: '#9E9B94' }}>?</span>
            </button>

            {user && (
              <>
                <div style={{ width: 1, height: 24, background: '#E5E2DC' }} />
                <p style={{ fontSize: 13, fontWeight: 500, color: '#1A1917', margin: 0 }}>{user.first_name} {user.last_name}</p>
                <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--brand)', backgroundColor: 'var(--brand-dim)', padding: '2px 6px', borderRadius: 4, letterSpacing: '0.05em' }}>
                  {user.role}
                </span>
                <div style={{ width: 28, height: 28, borderRadius: '50%', backgroundColor: 'var(--brand-dim)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>
                  {initials}
                </div>
              </>
            )}
          </div>
        </header>

        {fullBleed ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{children}</div>
        ) : (
          <main style={{ flex: 1, overflowY: 'auto', padding: '28px 28px', backgroundColor: '#F7F6F3' }}>
            <div style={{ maxWidth: 1400, margin: '0 auto' }}>{children}</div>
          </main>
        )}
      </div>
    </div>
  );
}
