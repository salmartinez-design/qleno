import {
  LogOut, X, LayoutDashboard,
  Briefcase, Users, UserCheck, FileText, DollarSign,
  BarChart2, TrendingUp, FileText as FileTextIcon,
  BookOpen, Settings, AlertTriangle, HeartPulse, Building2,
  UserPlus, GraduationCap, Clock, Calculator, MessageSquare, Layers,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { useTenantBrand } from "@/lib/tenant-brand";
import { QlenoLogo } from "@/components/brand/QlenoLogo";
import { QlenoMark } from "@/components/brand/QlenoMark";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { useEffect, useState, useCallback } from "react";

function useNeedsContactedCount(role: string | undefined) {
  const [count, setCount] = useState<number>(0);
  const token = useAuthStore(state => state.token);

  const eligible = role && ["owner", "admin", "office"].includes(role);

  const fetchCount = useCallback(async () => {
    if (!eligible || !token) return;
    try {
      const res = await fetch("/api/leads/status-counts", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data: Record<string, number> = await res.json();
      setCount(data["needs_contacted"] ?? 0);
    } catch { /* silent */ }
  }, [eligible, token]);

  useEffect(() => {
    fetchCount();
    const id = setInterval(fetchCount, 30_000);
    return () => clearInterval(id);
  }, [fetchCount]);

  return eligible ? count : 0;
}

// [AI.10] useZoneCoverageCount hook removed — Zone Coverage page
// retired in favor of server-side auto-resolution at boot. Sidebar
// no longer surfaces a missing-zip badge; the data layer fixes
// itself.

// [tech-boundary 2026-06-17] Office-side sections. Items without a
// `roles` array previously fell through and rendered for techs too —
// that's why Maryury saw Dashboard / Jobs / Customers / Employees /
// Invoices in her sidebar even though she had no business being on any
// of them. Added the office-tier `roles` allowlist on every item that
// was missing one. Techs (`technician` / `team_lead`) now see ZERO
// items from these sections — the per-item filter drops them all.
const NAV_SECTIONS = [
  {
    label: "Operations",
    items: [
      { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard, roles: ["owner", "admin", "office", "super_admin"] },
      // [2026-04-22] Consolidated "Dispatch Board" + "Jobs" → single "Jobs"
      // entry pointing at /dispatch (the Gantt). /jobs and /jobs/list still
      // resolve to JobsListPage via direct URL; the sidebar just prefers the
      // Gantt as the default view. Active-highlight covers all 3 urls via
      // MULTI_URL_HIGHLIGHT below.
      { title: "Jobs",      url: "/dispatch",  icon: Briefcase, roles: ["owner", "admin", "office", "super_admin"] },
      { title: "Customers", url: "/customers", icon: Users, roles: ["owner", "admin", "office", "super_admin", "accountant"] },
      { title: "Messages",  url: "/messages",  icon: MessageSquare, roles: ["owner", "admin", "office", "super_admin"] },
      { title: "Accounts",  url: "/accounts",  icon: Building2, roles: ["owner", "admin", "office", "super_admin"] },
    ],
  },
  {
    label: "Sales",
    items: [
      { title: "Leads",  url: "/leads",  icon: UserPlus,   roles: ["owner", "admin", "office", "super_admin"], badge: "needs_contacted" },
      { title: "Quotes", url: "/quotes", icon: FileTextIcon, roles: ["owner", "admin", "office", "super_admin"] },
      { title: "Estimates", url: "/estimates", icon: Calculator, roles: ["owner", "admin", "office", "super_admin"] },
    ],
  },
  {
    label: "Team",
    items: [
      { title: "Employees", url: "/employees", icon: UserCheck, roles: ["owner", "admin", "office", "super_admin"] },
      { title: "Time Clock", url: "/time-clock", icon: Clock, roles: ["owner", "admin", "office", "super_admin"] },
      { title: "Payroll",   url: "/payroll",   icon: DollarSign, roles: ["owner", "admin", "super_admin"] },
    ],
  },
  {
    label: "Money",
    items: [
      { title: "Invoices", url: "/invoices", icon: FileText, roles: ["owner", "admin", "office", "super_admin", "accountant"] },
      { title: "Batch Invoicing", url: "/admin/batch-invoicing", icon: Layers, roles: ["owner", "admin", "office", "super_admin"] },
    ],
  },
  {
    label: "Insights",
    items: [
      { title: "Reports",        url: "/reports",                icon: BarChart2,     roles: ["owner", "admin", "office", "super_admin"] },
      { title: "Core KPIs",      url: "/reports/insights",       icon: TrendingUp,    roles: ["owner", "admin", "office", "super_admin"] },
      { title: "Churn Board",    url: "/intelligence/churn",     icon: AlertTriangle, roles: ["owner", "admin", "super_admin"] },
      { title: "Tech Retention", url: "/intelligence/retention", icon: HeartPulse,    roles: ["owner", "admin", "super_admin"] },
    ],
  },
  {
    // [tech-experience 2026-06-17] My Day sits ABOVE Learning — a tech's
    // schedule + time-off are their primary surfaces; reference/training
    // content is secondary.
    label: "My Day",
    items: [
      // Tech-facing sidebar entries. Office tiers don't need these (they
      // navigate via Dashboard / Jobs above), so cap on technician /
      // team_lead. Without these the tech sidebar was just Training and
      // Cleancyclopedia, with no quick path back to their schedule.
      { title: "My Jobs",   url: "/my-jobs",   icon: Briefcase,    roles: ["technician", "team_lead"] },
      { title: "Time Off",  url: "/leave",     icon: FileText,     roles: ["technician", "team_lead"] },
    ],
  },
  {
    label: "Learning",
    items: [
      // Cleancyclopedia + Training are reference / training surfaces —
      // techs DO get these. No roles array → visible to everyone.
      { title: "Cleancyclopedia", url: "/cleancyclopedia", icon: BookOpen },
      { title: "Training",        url: "/training",        icon: GraduationCap },
      { title: "Training Admin",  url: "/lms/admin",       icon: GraduationCap, roles: ["owner", "admin", "super_admin", "office"] },
    ],
  },
  {
    label: "Admin",
    items: [
      { title: "Settings", url: "/company", icon: Settings, roles: ["owner", "admin", "super_admin"] },
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
  const [isHovered, setIsHovered] = useState(false);
  const logout = useAuthStore(state => state.logout);
  const { logoUrl, companyName, isLoading: tenantLoading, brandColor } = useTenantBrand();

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

  const needsContactedCount = useNeedsContactedCount(userInfo?.role);

  const initials = userInfo
    ? `${userInfo.firstName[0] || ''}${userInfo.lastName[0] || ''}`.toUpperCase()
    : '??';

  // [avatar-cascade 2026-06-17] The JWT carries no avatar_url, so the footer
  // emblem fell back to initials. Fetch /me so the uploaded profile photo shows
  // here too (same emblem as the top-right header + employee lists).
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d) setAvatarUrl(d.avatar_url ?? null); })
      .catch(() => { /* keep initials fallback */ });
    return () => { alive = false; };
  }, [token]);

  const EXACT_MATCH_URLS = ['/dashboard', '/company', '/dispatch', '/jobs'];
  // [2026-04-22] The merged "Jobs" sidebar item is configured with
  // url='/dispatch' but should also highlight when the user is on /jobs or
  // /jobs/list (both are route aliases). Q2 moved the flat list to
  // /reports/jobs — but that one lives under the Reports section so it
  // does NOT highlight Jobs (it highlights Reports instead, handled by
  // the default prefix-match behavior on /reports).
  const MULTI_URL_HIGHLIGHT: Record<string, string[]> = {
    '/dispatch': ['/dispatch', '/jobs', '/jobs/list'],
  };
  const isActive = (url: string) => {
    const extras = MULTI_URL_HIGHLIGHT[url];
    if (extras) return extras.some(u => location === u || location.startsWith(u + '/'));
    return EXACT_MATCH_URLS.includes(url)
      ? location === url
      : location === url || location.startsWith(url + '/');
  };

  const expanded = mobile || isHovered;

  const sidebarContent = (
    <div
      onMouseEnter={() => { if (!mobile) setIsHovered(true); }}
      onMouseLeave={() => { if (!mobile) setIsHovered(false); }}
      style={{
        width: mobile ? 264 : (expanded ? 220 : 56),
        minWidth: mobile ? 264 : (expanded ? 220 : 56),
        backgroundColor: '#FFFFFF',
        borderRight: '1px solid #EEECE7',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        transition: mobile ? 'none' : 'width 200ms ease, min-width 200ms ease',
        ...(mobile ? {} : {
          position: 'absolute' as const,
          top: 0,
          left: 0,
          bottom: 0,
          zIndex: 20,
          boxShadow: isHovered ? '4px 0 20px rgba(0,0,0,0.08)' : 'none',
        }),
      }}
    >
      {/* Logo */}
      <div style={{
        padding: expanded ? '0 20px' : '0',
        height: 60, flexShrink: 0,
        display: 'flex', alignItems: 'center',
        justifyContent: expanded ? 'space-between' : 'center',
        overflow: 'hidden',
      }}>
        {expanded
          ? <QlenoLogo size="md" />
          : <QlenoMark size={26} />
        }
        {mobile && expanded && (
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: 4, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <X size={18} />
          </button>
        )}
      </div>

      {/* Tenant identity — only shown when expanded */}
      <div style={{
        padding: expanded ? '8px 10px 10px' : '8px 6px 10px',
        borderBottom: '1px solid #EEECE7',
        overflow: 'hidden',
      }}>
        {expanded ? (
          <div style={{ background: '#F4F3F0', borderRadius: 10, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 9, overflow: 'hidden' }}>
            {tenantLoading ? (
              <div style={{ width: 30, height: 30, borderRadius: 7, backgroundColor: '#E5E2DC', flexShrink: 0 }} />
            ) : logoUrl ? (
              <img src={logoUrl} alt={companyName ?? ''} style={{ height: 30, width: 'auto', objectFit: 'contain', flexShrink: 0 }} />
            ) : (
              <div style={{ width: 30, height: 30, borderRadius: 7, backgroundColor: brandColor, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: '#FFFFFF', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  {companyName ? companyName[0].toUpperCase() : '…'}
                </span>
              </div>
            )}
            <div style={{ overflow: 'hidden', minWidth: 0 }}>
              {tenantLoading ? (
                <div style={{ height: 11, width: 80, borderRadius: 4, backgroundColor: '#E5E2DC' }} />
              ) : (
                <p style={{ fontSize: 12, fontWeight: 600, color: '#1A1917', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  {companyName ?? '—'}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            {tenantLoading ? (
              <div style={{ width: 32, height: 32, borderRadius: 7, backgroundColor: '#E5E2DC' }} />
            ) : logoUrl ? (
              <img src={logoUrl} alt="" style={{ height: 32, width: 32, objectFit: 'contain', borderRadius: 7 }} />
            ) : (
              <div style={{ width: 32, height: 32, borderRadius: 7, backgroundColor: brandColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: '#FFFFFF', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  {companyName ? companyName[0].toUpperCase() : '…'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '8px 0 12px' }}>
        {NAV_SECTIONS.map(section => {
          // [tech-boundary 2026-06-17] Pre-filter items by role. When
          // every item in a section is filtered out for this user
          // (e.g. a tech viewing an office-only "Operations" / "Sales"
          // / "Insights" / etc. section) skip the section entirely so
          // we don't render an orphan label with nothing under it.
          const visibleItems = section.items.filter(
            (item: any) => !item.roles || (userInfo && item.roles.includes(userInfo.role)),
          );
          if (visibleItems.length === 0) return null;
          return (
          <div key={section.label}>
            {/* Section label — only when expanded */}
            {expanded && (
              <p style={{
                fontSize: 10, fontWeight: 600, color: '#9E9B94', letterSpacing: '0.08em',
                textTransform: 'uppercase', padding: '20px 0 6px 16px', margin: 0,
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                whiteSpace: 'nowrap',
              }}>
                {section.label}
              </p>
            )}
            {!expanded && <div style={{ height: 12 }} />}
            {visibleItems
              .map(item => {
                const active = isActive(item.url);
                const Icon = item.icon;
                const badgeCount = item.badge === "needs_contacted" ? needsContactedCount : 0;
                return (
                  <Link key={item.title + item.url} href={item.url} onClick={mobile ? onClose : undefined}>
                    <div
                      style={{
                        height: 38,
                        padding: expanded ? '0 12px' : '0',
                        margin: expanded ? '1px 8px' : '1px 6px',
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: expanded ? 'flex-start' : 'center',
                        gap: 10,
                        cursor: 'pointer',
                        transition: 'all 0.12s',
                        backgroundColor: active ? 'var(--brand-soft)' : 'transparent',
                        borderLeft: expanded && active ? '3px solid var(--brand)' : '3px solid transparent',
                        color: active ? 'var(--brand)' : '#6B6860',
                        fontWeight: active ? 600 : 500,
                        fontSize: 13,
                        fontFamily: "'Plus Jakarta Sans', sans-serif",
                        textDecoration: 'none',
                        position: 'relative' as const,
                        title: !expanded ? item.title : undefined,
                      } as React.CSSProperties}
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
                      title={!expanded ? item.title : undefined}
                    >
                      <Icon size={16} style={{ flexShrink: 0, color: 'inherit' }} />
                      {expanded && (
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{item.title}</span>
                      )}
                      {expanded && badgeCount > 0 && (
                        <span style={{
                          backgroundColor: 'var(--brand)',
                          color: '#FFFFFF',
                          fontSize: 10,
                          fontWeight: 700,
                          borderRadius: 10,
                          padding: '1px 6px',
                          minWidth: 18,
                          textAlign: 'center',
                          flexShrink: 0,
                          lineHeight: '16px',
                          fontFamily: "'Plus Jakarta Sans', sans-serif",
                        }}>
                          {badgeCount > 99 ? '99+' : badgeCount}
                        </span>
                      )}
                      {!expanded && badgeCount > 0 && (
                        <span style={{
                          position: 'absolute',
                          top: 4,
                          right: 4,
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          backgroundColor: 'var(--brand)',
                          border: '1.5px solid #fff',
                        }} />
                      )}
                    </div>
                  </Link>
                );
              })}
          </div>
          );
        })}
      </nav>

      <div style={{ borderTop: '1px solid #EEECE7' }} />

      {/* User footer */}
      {expanded ? (
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <EmployeeAvatar name={`${userInfo?.firstName ?? ''} ${userInfo?.lastName ?? ''}`} avatarUrl={avatarUrl} size={30} fontSize={11} />
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
      ) : (
        <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <EmployeeAvatar name={`${userInfo?.firstName ?? ''} ${userInfo?.lastName ?? ''}`} avatarUrl={avatarUrl} size={30} fontSize={11}
            title={`${userInfo?.firstName} ${userInfo?.lastName} (${userInfo?.role})`} />
          <button
            onClick={() => logout()}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: 4, display: 'flex', alignItems: 'center' }}
            title="Sign out"
          >
            <LogOut size={13} />
          </button>
        </div>
      )}
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
