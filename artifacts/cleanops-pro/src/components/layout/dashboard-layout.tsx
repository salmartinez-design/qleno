import { ReactNode, useEffect } from "react";
import { AppSidebar } from "./app-sidebar";
import { useAuthStore } from "@/lib/auth";
import { useLocation } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { useTenantBrand } from "@/lib/tenant-brand";

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

export function DashboardLayout({ children, title }: DashboardLayoutProps) {
  const token = useAuthStore(state => state.token);
  const setToken = useAuthStore(state => state.setToken);
  const [location, setLocation] = useLocation();

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data: user, isLoading, isError, error } = useGetMe({
    request: { headers: getAuthHeaders() },
    query: { enabled: !!token, retry: false }
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
  const initials = user ? `${user.first_name?.[0] || ''}${user.last_name?.[0] || ''}`.toUpperCase() : '';

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', backgroundColor: '#0A0A0A', overflow: 'hidden' }}>
      <AppSidebar />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Top Bar */}
        <header style={{
          height: '56px',
          backgroundColor: '#111111',
          borderBottom: '1px solid #1A1A1A',
          padding: '0 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <h1 style={{
            fontSize: '38px',
            fontWeight: 700,
            color: '#F0EDE8',
            letterSpacing: '-0.02em',
            lineHeight: 1,
            margin: 0,
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
                  backgroundColor: 'var(--brand-dim)',
                  color: 'var(--brand)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '11px', fontWeight: 600,
                }}>
                  {initials}
                </div>
              </>
            )}
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, overflowY: 'auto', padding: '32px 28px', backgroundColor: '#0A0A0A' }}>
          <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
