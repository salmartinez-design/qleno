import { Home, Briefcase, Users, UsersRound, FileText, DollarSign, BookOpen, Star, Settings, LogOut, LayoutDashboard } from "lucide-react";
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

export function AppSidebar() {
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

  return (
    <div style={{
      width: '216px',
      minWidth: '216px',
      backgroundColor: '#111111',
      borderRight: '1px solid #1A1A1A',
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      overflow: 'hidden',
    }}>
      {/* Top — Logo */}
      <div style={{ padding: '20px 16px 12px', flexShrink: 0 }}>
        {logoUrl ? (
          <div>
            <div style={{ backgroundColor: '#FFFFFF', borderRadius: '6px', padding: '4px 8px', display: 'inline-block', marginBottom: '6px' }}>
              <img src={logoUrl} alt={companyName} style={{ height: '28px', width: 'auto', objectFit: 'contain', objectPosition: 'left', display: 'block' }} />
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
                  <div style={{
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
            backgroundColor: 'var(--brand-dim)',
            color: 'var(--brand)',
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
}
