import {
  LogOut, X, LayoutDashboard, CalendarDays, ClipboardList, Clock,
  Briefcase, Users, UserCheck, FileText, DollarSign,
  BarChart2, TrendingUp, ArrowUpCircle, Tag,
  BookOpen, Star, Settings, Building2, CreditCard, PenLine, LayoutTemplate, Calculator, FileText as FileTextIcon, MapPin,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { useTenantBrand } from "@/lib/tenant-brand";

const NAV_SECTIONS = [
  {
    label: "Today",
    items: [
      { title: "Dashboard",      url: "/dashboard",       icon: LayoutDashboard },
      { title: "Dispatch Board", url: "/jobs",             icon: CalendarDays },
      { title: "My Jobs",        url: "/my-jobs",          icon: ClipboardList, roles: ["technician"] },
      { title: "Clock Monitor",  url: "/employees/clocks", icon: Clock, roles: ["owner", "admin"] },
    ],
  },
  {
    label: "Manage",
    items: [
      { title: "Jobs",       url: "/jobs",       icon: Briefcase },
      { title: "Quotes",     url: "/quotes",     icon: FileTextIcon, roles: ["owner", "admin", "office"] },
      { title: "Customers",  url: "/customers",  icon: Users },
      { title: "Employees",  url: "/employees",  icon: UserCheck },
      { title: "Invoices",   url: "/invoices",   icon: FileText },
      { title: "Payroll",    url: "/payroll",    icon: DollarSign, roles: ["owner", "admin"] },
    ],
  },
  {
    label: "Grow",
    items: [
      { title: "Reports",      url: "/reports",           icon: BarChart2,      roles: ["owner", "admin", "office"] },
      { title: "Core KPIs",    url: "/reports/insights",  icon: TrendingUp,     roles: ["owner", "admin", "office"] },
      { title: "Rate Increase", url: "/discounts",        icon: ArrowUpCircle,  roles: ["owner", "admin"] },
      { title: "Discounts",    url: "/discounts",          icon: Tag,            roles: ["owner", "admin"] },
    ],
  },
  {
    label: "Tools",
    items: [
      { title: "Cleancyclopedia", url: "/cleancyclopedia", icon: BookOpen },
      { title: "Loyalty",         url: "/loyalty",          icon: Star,     roles: ["owner", "admin"] },
    ],
  },
  {
    label: "Company",
    items: [
      { title: "Settings",          url: "/company",                    icon: Settings,   roles: ["owner", "admin"] },
      { title: "Billing",           url: "/company/billing",            icon: CreditCard, roles: ["owner"] },
      { title: "Property Groups",   url: "/company/property-groups",    icon: Building2,  roles: ["owner", "admin"] },
      { title: "Agreements",        url: "/company/agreements",         icon: PenLine,        roles: ["owner", "admin"] },
      { title: "Forms",             url: "/company/forms",              icon: LayoutTemplate, roles: ["owner", "admin"] },
      { title: "Quoting",           url: "/company/quoting",            icon: Calculator,     roles: ["owner", "admin"] },
      { title: "Service Zones",     url: "/company/zones",              icon: MapPin,         roles: ["owner"] },
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

  const EXACT_MATCH_URLS = ['/dashboard', '/company'];
  const isActive = (url: string) =>
    EXACT_MATCH_URLS.includes(url)
      ? location === url
      : location === url || location.startsWith(url + '/');

  const navItemStyle = (active: boolean): React.CSSProperties => ({
    height: 38,
    padding: '0 12px',
    margin: '1px 8px',
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    cursor: 'pointer',
    transition: 'all 0.12s',
    backgroundColor: active ? 'var(--brand-soft)' : 'transparent',
    borderLeft: active ? '3px solid var(--brand)' : '3px solid transparent',
    color: active ? 'var(--brand)' : '#6B6860',
    fontWeight: active ? 600 : 500,
    fontSize: 13,
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    textDecoration: 'none',
  });

  const sidebarContent = (
    <div style={{
      width: mobile ? 264 : 220,
      minWidth: mobile ? 264 : 220,
      backgroundColor: '#FFFFFF',
      borderRight: '1px solid #EEECE7',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Logo */}
      <div style={{ height: 56, padding: '0 16px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #EEECE7' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, overflow: 'hidden' }}>
          {logoUrl ? (
            <img src={logoUrl} alt={companyName} style={{ height: 28, width: 'auto', objectFit: 'contain', flexShrink: 0 }} />
          ) : (
            <div style={{ width: 28, height: 28, borderRadius: 7, backgroundColor: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: '#FFFFFF', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                {(companyName?.[0] || 'C').toUpperCase()}
              </span>
            </div>
          )}
          <div style={{ overflow: 'hidden' }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#1A1917', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{companyName}</p>
            <p style={{ fontSize: 10, fontWeight: 500, color: '#9E9B94', margin: 0, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>CleanOps Pro</p>
          </div>
        </div>
        {mobile && (
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: 4, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <X size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '8px 0 12px' }}>
        {NAV_SECTIONS.map(section => (
          <div key={section.label}>
            <p style={{
              fontSize: 10, fontWeight: 600, color: '#9E9B94', letterSpacing: '0.08em',
              textTransform: 'uppercase', padding: '20px 0 6px 16px', margin: 0,
              fontFamily: "'Plus Jakarta Sans', sans-serif",
            }}>
              {section.label}
            </p>
            {section.items
              .filter(item => !item.roles || (userInfo && item.roles.includes(userInfo.role)))
              .map(item => {
                const active = isActive(item.url);
                const Icon = item.icon;
                return (
                  <Link key={item.title + item.url} href={item.url} onClick={mobile ? onClose : undefined}>
                    <div
                      style={navItemStyle(active)}
                      onMouseEnter={e => {
                        if (!active) {
                          e.currentTarget.style.backgroundColor = '#F0EEE9';
                          e.currentTarget.style.color = '#1A1917';
                        }
                      }}
                      onMouseLeave={e => {
                        if (!active) {
                          e.currentTarget.style.backgroundColor = 'transparent';
                          e.currentTarget.style.color = '#6B6860';
                        }
                      }}
                    >
                      <Icon size={16} style={{ flexShrink: 0, color: 'inherit' }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                    </div>
                  </Link>
                );
              })}
          </div>
        ))}
      </nav>

      <div style={{ borderTop: '1px solid #EEECE7' }} />
      {/* User footer */}
      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: '50%', backgroundColor: 'var(--brand-soft)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          {initials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: '#1A1917', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            {userInfo?.firstName} {userInfo?.lastName}
          </p>
          <p style={{ margin: 0, fontSize: 10, color: '#9E9B94', textTransform: 'capitalize', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{userInfo?.role}</p>
        </div>
        <button
          onClick={() => logout()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: 4, display: 'flex', alignItems: 'center' }}
          title="Sign out"
        >
          <LogOut size={14} />
        </button>
      </div>
    </div>
  );

  if (mobile) {
    return (
      <>
        {open && (
          <div
            style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 40 }}
            onClick={onClose}
          />
        )}
        <div style={{
          position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 50,
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.25s ease',
        }}>
          {sidebarContent}
        </div>
      </>
    );
  }

  return sidebarContent;
}
