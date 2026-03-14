import { Home, Briefcase, Users, UsersRound, FileText, DollarSign, BookOpen, Star, Settings, LogOut, LayoutDashboard, X } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { useTenantBrand } from "@/lib/tenant-brand";

const NAV_SECTIONS = [
  {
    label: "Operations",
    items: [
      { title: "Dashboard",    url: "/dashboard",    icon: LayoutDashboard },
      { title: "Jobs",         url: "/jobs",          icon: Briefcase },
      { title: "Employees",    url: "/employees",     icon: Users },
      { title: "Customers",    url: "/customers",     icon: UsersRound },
      { title: "Invoices",     url: "/invoices",      icon: FileText },
      { title: "Payroll",      url: "/payroll",       icon: DollarSign },
    ],
  },
  {
    label: "Tools",
    items: [
      { title: "Cleancyclopedia", url: "/cleancyclopedia", icon: BookOpen },
    ],
  },
  {
    label: "Configuration",
    items: [
      { title: "Loyalty",  url: "/loyalty",  icon: Star },
      { title: "Company",  url: "/company",  icon: Settings },
    ],
  },
];

interface AppSidebarProps {
  mobile?: boolean;
  open?: boolean;
  onClose?: () => void;
}

export function AppSidebar({ mobile = false, open = false, onClose }: AppSidebarProps) {
  const [location] = useLocation();
  const logout = useAuthStore(state => state.logout);
  const { logoUrl, companyName } = useTenantBrand();

  const token = useAuthStore(state => state.token);
  let userInfo: { email: string; role: string; firstName: string; lastName: string } | null = null;
  if (token) {
    try {
      const p = JSON.parse(atob(token.split('.')[1]));
      userInfo = {
        email: p.email,
        role: p.role,
        firstName: p.first_name || p.email?.split('@')[0] || '',
        lastName: p.last_name || '',
      };
    } catch { /* empty */ }
  }

  const initials = userInfo
    ? `${userInfo.firstName[0] || ''}${userInfo.lastName[0] || ''}`.toUpperCase()
    : '??';

  const sidebarContent = (
    <div style={{
      width: mobile ? 264 : 216,
      minWidth: mobile ? 264 : 216,
      backgroundColor: '#111111',
      borderRight: '1px solid #1A1A1A',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Top — Logo + close (mobile only) */}
      <div style={{ padding: '18px 16px 12px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          {logoUrl ? (
            <div>
              <div style={{ backgroundColor: '#FFFFFF', borderRadius: '6px', padding: '4px 8px', display: 'inline-block', marginBottom: '6px' }}>
                <img src={logoUrl} alt={companyName} style={{ height: '26px', width: 'auto', objectFit: 'contain', objectPosition: 'left', display: 'block' }} />
              </div>
              <p style={{ fontSize: '11px', fontWeight: 500, color: '#4A4845', letterSpacing: '0.06em', margin: 0 }}>CleanOps Pro</p>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: '15px', fontWeight: 600, color: '#F0EDE8', margin: '0 0 4px 0' }}>{companyName}</p>
              <p style={{ fontSize: '11px', fontWeight: 500, color: '#4A4845', letterSpacing: '0.06em', margin: 0 }}>CleanOps Pro</p>
            </div>
          )}
        </div>
        {mobile && (
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7A7873', padding: 4, display: 'flex', alignItems: 'center' }}
          >
            <X size={18} />
          </button>
        )}
      </div>

      <div style={{ borderTop: '1px solid #1A1A1A', margin: '0 0 4px 0' }} />

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', paddingBottom: '8px' }}>
        {NAV_SECTIONS.map(section => (
          <div key={section.label}>
            <p style={{
              fontSize: '10px', fontWeight: 600, color: '#4A4845',
              letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '16px 16px 6px', margin: 0,
            }}>
              {section.label}
            </p>
            {section.items.map(item => {
              const isActive = location === item.url || (item.url !== '/dashboard' && location.startsWith(item.url));
              const Icon = item.icon;
              return (
                <Link key={item.url} href={item.url}>
                  <div
                    style={{
                      height: '36px',
                      padding: '0 12px',
                      margin: '1px 8px',
                      borderRadius: '6px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      backgroundColor: isActive ? 'var(--brand-soft)' : 'transparent',
                      color: isActive ? 'var(--brand)' : '#7A7873',
                      fontWeight: isActive ? 500 : 400,
                      fontSize: '13px',
                      fontFamily: "'Plus Jakarta Sans', sans-serif",
                    }}
                    onMouseEnter={e => {
                      if (!isActive) {
                        e.currentTarget.style.backgroundColor = '#1C1C1C';
                        e.currentTarget.style.color = '#F0EDE8';
                      }
                    }}
                    onMouseLeave={e => {
                      if (!isActive) {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.color = '#7A7873';
                      }
                    }}
                  >
                    <Icon size={16} strokeWidth={1.5} style={{ flexShrink: 0 }} />
                    <span>{item.title}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer — User */}
      <div style={{ borderTop: '1px solid #1A1A1A', flexShrink: 0 }}>
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '28px', height: '28px', borderRadius: '50%',
            backgroundColor: 'var(--brand-dim)', color: 'var(--brand)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '11px', fontWeight: 600, flexShrink: 0,
          }}>
            {initials}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '12px', fontWeight: 500, color: '#F0EDE8', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {userInfo?.firstName} {userInfo?.lastName}
            </p>
            <span style={{
              fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
              color: 'var(--brand)', backgroundColor: 'var(--brand-dim)',
              padding: '1px 6px', borderRadius: '4px', letterSpacing: '0.05em',
            }}>
              {userInfo?.role}
            </span>
          </div>
          <button
            onClick={logout}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4A4845', padding: '4px', borderRadius: '4px', display: 'flex', flexShrink: 0 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#F0EDE8')}
            onMouseLeave={e => (e.currentTarget.style.color = '#4A4845')}
            title="Sign Out"
          >
            <LogOut size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );

  if (mobile) {
    return (
      <>
        {/* Overlay */}
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, zIndex: 40,
            backgroundColor: 'rgba(0,0,0,0.72)',
            backdropFilter: 'blur(2px)',
            opacity: open ? 1 : 0,
            pointerEvents: open ? 'auto' : 'none',
            transition: 'opacity 0.28s ease',
          }}
        />
        {/* Drawer */}
        <aside style={{
          position: 'fixed', top: 0, left: 0, bottom: 0,
          zIndex: 50,
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
        }}>
          {sidebarContent}
        </aside>
      </>
    );
  }

  return sidebarContent;
}
