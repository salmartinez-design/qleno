import { ReactNode, useEffect, useState, useCallback, useRef, FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  BookOpen, Star, Settings, Clock,
  MoreHorizontal, Search, MessageSquare, X, ChevronRight,
  ChevronDown, Eye, LogOut, CircleHelp, Lock, KeyRound, Bell,
  CalendarX2, UserMinus, AlertTriangle, Plus, Receipt, Briefcase, UserPlus,
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
  { title: 'Loyalty',        href: '/loyalty',            icon: Star        },
  { title: 'Cleancyclopedia', href: '/cleancyclopedia',  icon: BookOpen    },
  { title: 'Company',        href: '/company',            icon: Settings    },
  { title: 'Clock Monitor',  href: '/employees/clocks',  icon: Clock       },
];

function MoreSheet({ open, onClose, navigate, onChangePw }: { open: boolean; onClose: () => void; navigate: (path: string) => void; onChangePw?: () => void }) {
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

          {/* Account actions */}
          <div style={{ borderTop: '1px solid #EEECE7', marginTop: 16, paddingTop: 12, paddingBottom: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
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

function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const token = useAuthStore(state => state.token);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const FF = "'Plus Jakarta Sans', sans-serif";

  useEffect(() => {
    if (!open) { setCurrent(''); setNext(''); setConfirm(''); setError(''); setSuccess(false); }
  }, [open]);

  if (!open) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < 6) { setError('New password must be at least 6 characters.'); return; }
    if (next !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Failed to update password.'); return; }
      setSuccess(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', border: '1px solid #E5E2DC', borderRadius: 8,
    fontSize: 14, fontFamily: FF, outline: 'none', boxSizing: 'border-box', color: '#1A1917',
    backgroundColor: '#FAFAF9',
  };
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#6B7280', fontFamily: FF, marginBottom: 4, display: 'block' };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 16, width: 380, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--brand-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <KeyRound size={18} style={{ color: 'var(--brand)' }} />
            </div>
            <div>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1A1917', fontFamily: FF }}>Change Password</p>
              <p style={{ margin: 0, fontSize: 12, color: '#9E9B94', fontFamily: FF }}>Update your login credentials</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: 4 }}><X size={18} /></button>
        </div>

        {success ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#D1FAE5', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
              <Lock size={22} style={{ color: '#059669' }} />
            </div>
            <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#1A1917', fontFamily: FF }}>Password Updated</p>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6B7280', fontFamily: FF }}>Your new password is active.</p>
            <button onClick={onClose} style={{ padding: '10px 24px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FF }}>Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={labelStyle}>Current Password</label>
              <input type="password" value={current} onChange={e => setCurrent(e.target.value)} style={inputStyle} required autoComplete="current-password" />
            </div>
            <div>
              <label style={labelStyle}>New Password</label>
              <input type="password" value={next} onChange={e => setNext(e.target.value)} style={inputStyle} required autoComplete="new-password" />
            </div>
            <div>
              <label style={labelStyle}>Confirm New Password</label>
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} style={inputStyle} required autoComplete="new-password" />
            </div>
            {error && <p style={{ margin: 0, fontSize: 13, color: '#DC2626', fontFamily: FF }}>{error}</p>}
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button type="button" onClick={onClose} style={{ flex: 1, padding: '10px', border: '1px solid #E5E2DC', borderRadius: 8, background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#6B7280', fontFamily: FF }}>Cancel</button>
              <button type="submit" disabled={loading} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: 'var(--brand)', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#fff', fontFamily: FF, opacity: loading ? 0.7 : 1 }}>
                {loading ? 'Saving...' : 'Save Password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
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

// Set to false once COMMS_ENABLED=true is set on the API server
const COMMS_PAUSED = true;

const CommsPausedBanner = () =>
  COMMS_PAUSED ? (
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
  const [notifOpen, setNotifOpen] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const userDropRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
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
    if (!notifOpen) return;
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [notifOpen]);

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
    query: { enabled: !!token, retry: false },
  });

  const isManager = user?.role === 'owner' || user?.role === 'office';

  const { data: notifData } = useQuery({
    queryKey: ['notifications-inbox'],
    queryFn: async () => {
      const r = await fetch(`${API}/api/notifications/inbox?limit=20`, { headers: getAuthHeaders() as any });
      if (!r.ok) return { data: [], unread_count: 0 };
      return r.json();
    },
    enabled: !!token && isManager,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const notifItems: any[] = notifData?.data || [];
  const notifUnread: number = notifData?.unread_count || 0;

  const markNotifRead = async (id: string, link?: string) => {
    try {
      await fetch(`${API}/api/notifications/inbox/${id}/read`, { method: 'PATCH', headers: getAuthHeaders() as any });
      queryClient.invalidateQueries({ queryKey: ['notifications-inbox'] });
    } catch (_) {}
    if (link) setLocation(link);
    setNotifOpen(false);
  };

  const markAllNotifRead = async () => {
    try {
      await fetch(`${API}/api/notifications/inbox/read-all`, { method: 'PATCH', headers: getAuthHeaders() as any });
      queryClient.invalidateQueries({ queryKey: ['notifications-inbox'] });
    } catch (_) {}
  };

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
        <ChangePasswordModal open={changePwOpen} onClose={() => setChangePwOpen(false)} />
        <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} navigate={setLocation} onChangePw={() => { setMoreOpen(false); setChangePwOpen(true); }} />

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

            {/* ── Mobile Quick Create ─────────────────────────────────────── */}
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
                  background: '#FFF', borderRadius: 12, border: '1px solid #E5E2DC',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.14)', width: 185, zIndex: 300,
                  overflow: 'hidden',
                }}>
                  {([
                    { label: 'Quote',  Icon: Receipt,   href: '/quotes/new' },
                    { label: 'Job',    Icon: Briefcase, href: '/dispatch' },
                    { label: 'Client', Icon: UserPlus,  href: '/customers' },
                  ] as const).map((item, i, arr) => (
                    <button
                      key={item.label}
                      onClick={() => { setLocation(item.href); setQuickCreateOpen(false); }}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                        padding: '12px 16px', border: 'none',
                        borderBottom: i < arr.length - 1 ? '1px solid #F0EDEA' : 'none',
                        background: 'none', cursor: 'pointer', textAlign: 'left' as const,
                      }}
                    >
                      <item.Icon size={16} color="var(--brand)" />
                      <span style={{ fontSize: 14, fontWeight: 500, color: '#1A1917', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                        {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
                  minHeight: 56, gap: 3, cursor: 'pointer',
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
      {shortcutsOpen && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      <ChangePasswordModal open={changePwOpen} onClose={() => setChangePwOpen(false)} />

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
              <kbd style={{ fontSize: 10, border: '1px solid #E5E2DC', borderRadius: 3, padding: '1px 5px', color: '#C0BDB8' }}>⇧/</kbd>
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
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '5px 11px', borderRadius: 8, cursor: 'pointer',
                  background: '#1A1917', border: 'none', color: '#FFF',
                  fontSize: 13, fontWeight: 600,
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                }}
              >
                <Plus size={14} strokeWidth={2.5} />
                <span>New</span>
              </button>

              {quickCreateOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                  background: '#FFF', borderRadius: 12, border: '1px solid #E5E2DC',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.12)', width: 190, zIndex: 300,
                  overflow: 'hidden',
                }}>
                  {([
                    { label: 'Quote',  Icon: Receipt,   href: '/quotes/new' },
                    { label: 'Job',    Icon: Briefcase, href: '/dispatch' },
                    { label: 'Client', Icon: UserPlus,  href: '/customers' },
                  ] as const).map((item, i, arr) => (
                    <button
                      key={item.label}
                      onClick={() => { setLocation(item.href); setQuickCreateOpen(false); }}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                        padding: '11px 16px', border: 'none',
                        borderBottom: i < arr.length - 1 ? '1px solid #F0EDEA' : 'none',
                        background: 'none', cursor: 'pointer', textAlign: 'left' as const,
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#F7F6F3')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                    >
                      <item.Icon size={16} color="var(--brand)" />
                      <span style={{ fontSize: 14, fontWeight: 500, color: '#1A1917', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                        {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button onClick={() => setShortcutsOpen(true)} title="Keyboard Shortcuts"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: 6, borderRadius: 8, display: 'flex', alignItems: 'center' }}>
              <CircleHelp size={18} />
            </button>

            {isManager && (
              <div ref={notifRef} style={{ position: 'relative' }}>
                <button
                  onClick={() => setNotifOpen(p => !p)}
                  title="Notifications"
                  style={{ background: notifOpen ? 'var(--brand-dim)' : 'none', border: 'none', cursor: 'pointer', color: notifOpen ? 'var(--brand)' : '#6B7280', padding: 6, borderRadius: 8, display: 'flex', alignItems: 'center', position: 'relative' } as any}
                >
                  <Bell size={20} />
                  {notifUnread > 0 && (
                    <span style={{ position: 'absolute', top: 2, right: 2, minWidth: 9, height: 9, borderRadius: 5, background: '#EF4444', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: '#fff', fontWeight: 700, padding: '0 2px' }}>
                      {notifUnread > 9 ? '9+' : notifUnread}
                    </span>
                  )}
                </button>

                {notifOpen && (
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 6,
                    background: '#fff', borderRadius: 12, border: '1px solid #E5E2DC',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.12)', width: 380, zIndex: 200,
                    display: 'flex', flexDirection: 'column', overflow: 'hidden',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px', borderBottom: '1px solid #F0EDEA' }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#1A1917', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                        Notifications {notifUnread > 0 && <span style={{ fontSize: 11, color: '#EF4444', marginLeft: 4 }}>({notifUnread} unread)</span>}
                      </span>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {notifUnread > 0 && (
                          <button onClick={markAllNotifRead} style={{ fontSize: 11, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600 }}>
                            Mark all read
                          </button>
                        )}
                        <button onClick={() => { setNotifOpen(false); setLocation('/notifications'); }} style={{ fontSize: 11, color: '#9E9B94', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                          View all
                        </button>
                      </div>
                    </div>
                    <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                      {notifItems.length === 0 ? (
                        <div style={{ padding: '32px 16px', textAlign: 'center', color: '#9E9B94', fontSize: 13, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                          No notifications yet
                        </div>
                      ) : notifItems.map((n: any) => {
                        const icon = n.type === 'new_booking' ? <Bell size={14} style={{ color: '#2563EB' }} /> : n.type === 'late_clockin' ? <AlertTriangle size={14} style={{ color: '#F59E0B' }} /> : <UserMinus size={14} style={{ color: '#DC2626' }} />;
                        return (
                          <button
                            key={n.id}
                            onClick={() => markNotifRead(n.id, n.link)}
                            style={{
                              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 16px',
                              background: n.read ? '#fff' : '#F0F4FF',
                              border: 'none', borderBottom: '1px solid #F7F6F3', cursor: 'pointer', width: '100%', textAlign: 'left',
                            }}
                          >
                            <span style={{ marginTop: 2, flexShrink: 0, width: 28, height: 28, borderRadius: 7, background: n.read ? '#F3F4F6' : 'var(--brand-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {icon}
                            </span>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <span style={{ display: 'block', fontSize: 12, fontWeight: n.read ? 500 : 700, color: '#1A1917', fontFamily: "'Plus Jakarta Sans', sans-serif", lineHeight: 1.3 }}>{n.title}</span>
                              {n.body && <span style={{ display: 'block', fontSize: 11, color: '#6B7280', marginTop: 2, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.body}</span>}
                              <span style={{ display: 'block', fontSize: 10, color: '#C0BDB8', marginTop: 3 }}>
                                {new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </span>
                            {!n.read && <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#2563EB', flexShrink: 0, marginTop: 4 }} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
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
                    <div style={{ width: 28, height: 28, borderRadius: '50%', backgroundColor: 'var(--brand-dim)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>
                      {initials}
                    </div>
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
          <main style={{ flex: 1, overflowY: 'auto', backgroundColor: '#F7F6F3', display: 'flex', flexDirection: 'column' }}>
            <CommsPausedBanner />
            <div style={{ padding: '28px 28px', maxWidth: 1400, margin: '0 auto', width: '100%' }}>{children}</div>
          </main>
        )}
      </div>
    </div>
  );
}
