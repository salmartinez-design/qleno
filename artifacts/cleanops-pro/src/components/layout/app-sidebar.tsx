import { Home, Users, UsersRound, Briefcase, FileText, BarChart3, Settings, LogOut, Medal, BookOpen, LayoutDashboard } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { useTenantBrand } from "@/lib/tenant-brand";

const opsItems = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Jobs", url: "/jobs", icon: Briefcase },
  { title: "Employees", url: "/employees", icon: Users },
  { title: "Customers", url: "/customers", icon: UsersRound },
  { title: "Invoices", url: "/invoices", icon: FileText },
  { title: "Payroll", url: "/payroll", icon: BarChart3 },
];

const toolItems = [
  { title: "Cleancyclopedia", url: "/cleancyclopedia", icon: BookOpen },
];

const configItems = [
  { title: "Loyalty", url: "/loyalty", icon: Medal },
  { title: "Company", url: "/company", icon: Settings },
];

function NavSection({ label, items, currentPath }: { label: string; items: typeof opsItems; currentPath: string }) {
  return (
    <div className="mb-2">
      <p style={{ fontSize: '10px', letterSpacing: '0.1em', color: '#555550', fontFamily: "'DM Mono', monospace", fontWeight: 400 }} className="uppercase px-4 py-2">
        {label}
      </p>
      {items.map(item => {
        const isActive = currentPath.startsWith(item.url);
        return (
          <Link key={item.title} href={item.url}>
            <div
              style={isActive ? {
                backgroundColor: 'rgba(var(--tenant-color-rgb), 0.12)',
                borderLeft: '3px solid var(--tenant-color)',
                color: 'var(--tenant-color)',
              } : {
                borderLeft: '3px solid transparent',
                color: '#888780',
              }}
              className="flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-[#1A1A1A] hover:text-[#E8E0D0]"
            >
              <item.icon size={15} strokeWidth={1.5} style={isActive ? { color: 'var(--tenant-color)' } : {}} />
              <span style={{ fontSize: '13px', fontFamily: "'DM Mono', monospace", fontWeight: isActive ? 400 : 300 }}>
                {item.title}
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export function AppSidebar() {
  const [location] = useLocation();
  const logout = useAuthStore(state => state.logout);
  const { logoUrl, companyName, brandColor } = useTenantBrand();

  const token = useAuthStore(state => state.token);
  let userEmail: { email: string; role: string } | null = null;
  if (token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      userEmail = { email: payload.email, role: payload.role };
    } catch { /* empty */ }
  }

  return (
    <div
      style={{ width: '220px', minWidth: '220px', backgroundColor: '#111111', borderRight: '1px solid #252525' }}
      className="flex flex-col h-screen overflow-y-auto"
    >
      {/* Logo / Company Header */}
      <div style={{ borderBottom: '1px solid #252525', padding: '14px 16px' }} className="shrink-0">
        {logoUrl ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ backgroundColor: '#FFFFFF', borderRadius: '8px', padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <img src={logoUrl} alt={companyName} style={{ height: '28px', width: 'auto', objectFit: 'contain', display: 'block' }} />
            </div>
            <div>
              <p style={{ fontFamily: "'DM Mono', monospace", fontWeight: 400, fontSize: '12px', color: '#E8E0D0', lineHeight: 1.2, margin: 0 }}>{companyName}</p>
              <p style={{ fontSize: '10px', color: '#888780', fontFamily: "'DM Mono', monospace", fontWeight: 300, lineHeight: 1.2, margin: 0 }}>CleanOps Pro</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <div style={{ width: '28px', height: '28px', borderRadius: '6px', backgroundColor: brandColor, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ color: '#FFFFFF', fontSize: '13px', fontFamily: "'Playfair Display', serif", fontWeight: 700 }}>C</span>
            </div>
            <div>
              <p style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: '15px', color: '#E8E0D0', lineHeight: 1.2 }}>CleanOps Pro</p>
              <p style={{ fontSize: '11px', color: '#888780', fontFamily: "'DM Mono', monospace", fontWeight: 300, lineHeight: 1.2 }}>{companyName}</p>
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 overflow-y-auto">
        <NavSection label="Operations" items={opsItems} currentPath={location} />
        <NavSection label="Tools" items={toolItems} currentPath={location} />
        <NavSection label="Configuration" items={configItems} currentPath={location} />
      </nav>

      {/* Footer — User + Sign Out */}
      <div style={{ borderTop: '1px solid #252525', padding: '12px 16px' }} className="shrink-0">
        {userEmail && (
          <div className="mb-3">
            <p style={{ fontSize: '12px', fontFamily: "'DM Mono', monospace", fontWeight: 400, color: '#E8E0D0' }} className="truncate">{userEmail.email}</p>
            <span style={{
              display: 'inline-block',
              fontSize: '10px',
              fontFamily: "'DM Mono', monospace",
              backgroundColor: `rgba(var(--tenant-color-rgb), 0.15)`,
              color: 'var(--tenant-color)',
              padding: '1px 6px',
              borderRadius: '3px',
              marginTop: '3px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              {userEmail.role}
            </span>
          </div>
        )}
        <button
          onClick={() => logout()}
          style={{ fontSize: '12px', fontFamily: "'DM Mono', monospace", color: '#888780' }}
          className="flex items-center gap-2 hover:text-[#E8E0D0] transition-colors w-full py-1"
        >
          <LogOut size={13} strokeWidth={1.5} />
          Sign Out
        </button>
      </div>
    </div>
  );
}
