import { ReactNode, useEffect, useState } from "react";
import { AppSidebar } from "./app-sidebar";
import { useAuthStore } from "@/lib/auth";
import { useLocation, Link } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { useTenantBrand } from "@/lib/tenant-brand";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Menu, Bell, LayoutDashboard, Briefcase,
  UserCircle, FileText, DollarSign,
} from "lucide-react";

interface DashboardLayoutProps {
  children: ReactNode;
  title?: string;
}

const ROUTE_TITLES: Record<string, string> = {
  '/dashboard':       'Dashboard',
  '/jobs':            'Job Dispatch',
  '/employees':       'Employees',
  '/customers':       'Customers',
  '/invoices':        'Invoices',
  '/payroll':         'Payroll',
  '/cleancyclopedia': 'Cleancyclopedia',
  '/loyalty':         'Loyalty',
  '/company':         'Company Settings',
};

const BOTTOM_TABS = [
  { href: '/dashboard', icon: LayoutDashboard, label: 'Home' },
  { href: '/jobs',      icon: Briefcase,       label: 'Jobs' },
  { href: '/customers', icon: UserCircle,      label: 'Clients' },
  { href: '/invoices',  icon: FileText,        label: 'Invoices' },
  { href: '/payroll',   icon: DollarSign,      label: 'Payroll' },
];

export function DashboardLayout({ children, title }: DashboardLayoutProps) {
  const token = useAuthStore(state => state.token);
  const setToken = useAuthStore(state => state.setToken);
  const [location, setLocation] = useLocation();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data: user, isLoading, isError, error } = useGetMe({
    request: { headers: getAuthHeaders() },
    query: { enabled: !!token, retry: false },
  });

  useTenantBrand();

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
  }, [location]);

  if (!token) return null;

  if (isLoading) {
    return (
      <div style={{ height: '100vh', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A0A0A' }}>
        <div style={{ width: '28px', height: '28px', border: '2px solid #222222', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const pageTitle = title || ROUTE_TITLES[location] || 'CleanOps Pro';
  const initials = user
    ? `${user.first_name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase()
    : '';

  if (isMobile) {
    return (
      <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", backgroundColor: '#0A0A0A', minHeight: '100dvh', color: '#F0EDE8', position: 'relative' }}>

        <AppSidebar mobile open={drawerOpen} onClose={() => setDrawerOpen(false)} />

        {/* Mobile top bar */}
        <header style={{
          position: 'sticky', top: 0, zIndex: 30,
          backgroundColor: '#111111',
          borderBottom: '1px solid #222222',
          padding: '0 16px',
          height: '52px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <button
            onClick={() => setDrawerOpen(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7A7873', padding: '4px', display: 'flex', alignItems: 'center' }}
          >
            <Menu size={22} />
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: 'var(--brand)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#F0EDE8' }}>CleanOps Pro</span>
          </div>

          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7A7873', padding: '4px', display: 'flex', alignItems: 'center', position: 'relative' }}>
            <Bell size={20} />
            <span style={{
              position: 'absolute', top: 4, right: 4,
              width: 7, height: 7, borderRadius: '50%',
              backgroundColor: 'var(--brand)', border: '2px solid #111111',
            }} />
          </button>
        </header>

        {/* Page content */}
        <main style={{ padding: '16px 14px 88px' }}>
          {children}
        </main>

        {/* Bottom tab bar */}
        <nav style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 30,
          backgroundColor: '#111111',
          borderTop: '1px solid #222222',
          display: 'flex', justifyContent: 'space-around',
          padding: '8px 0 max(10px, env(safe-area-inset-bottom))',
        }}>
          {BOTTOM_TABS.map(tab => {
            const isActive = location === tab.href || (tab.href !== '/dashboard' && location.startsWith(tab.href));
            const Icon = tab.icon;
            return (
              <Link key={tab.href} href={tab.href}>
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                  padding: '4px 12px', cursor: 'pointer',
                  color: isActive ? 'var(--brand)' : '#4A4845',
                }}>
                  <Icon size={21} strokeWidth={isActive ? 2.5 : 1.8} />
                  <span style={{ fontSize: 10, fontWeight: isActive ? 600 : 400, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                    {tab.label}
                  </span>
                </div>
              </Link>
            );
          })}
        </nav>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', backgroundColor: '#0A0A0A', overflow: 'hidden' }}>
      <AppSidebar />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <header style={{
          height: '56px',
          backgroundColor: '#111111',
          borderBottom: '1px solid #1A1A1A',
          padding: '0 28px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <h1 style={{
            fontSize: '22px', fontWeight: 700, color: '#F0EDE8',
            letterSpacing: '-0.02em', lineHeight: 1, margin: 0,
            fontFamily: "'Plus Jakarta Sans', sans-serif",
          }}>
            {pageTitle}
          </h1>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {user && (
              <>
                <p style={{ fontSize: '13px', fontWeight: 500, color: '#F0EDE8', margin: 0 }}>
                  {user.first_name} {user.last_name}
                </p>
                <span style={{
                  fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
                  color: 'var(--brand)', backgroundColor: 'var(--brand-dim)',
                  padding: '2px 6px', borderRadius: '4px', letterSpacing: '0.05em',
                }}>
                  {user.role}
                </span>
                <div style={{
                  width: '28px', height: '28px', borderRadius: '50%',
                  backgroundColor: 'var(--brand-dim)', color: 'var(--brand)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '11px', fontWeight: 600,
                }}>
                  {initials}
                </div>
              </>
            )}
          </div>
        </header>

        <main style={{ flex: 1, overflowY: 'auto', padding: '28px 28px', backgroundColor: '#0A0A0A' }}>
          <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
