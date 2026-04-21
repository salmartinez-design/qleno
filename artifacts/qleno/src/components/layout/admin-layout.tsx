import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuthStore, getTokenRole, getTokenIsSuperAdmin } from "@/lib/auth";
import {
  LayoutDashboard, Building2, CreditCard, BookOpen,
  LogOut, X, Menu, ArrowLeft, Shield
} from "lucide-react";
import { QlenoLogo } from "@/components/brand/QlenoLogo";

const ADMIN_NAV = [
  { title: "Dashboard",       url: "/admin",                icon: LayoutDashboard },
  { title: "Companies",       url: "/admin/companies",      icon: Building2 },
  { title: "Billing",         url: "/admin/billing",        icon: CreditCard },
  { title: "Cleancyclopedia", url: "/admin/cleancyclopedia", icon: BookOpen },
];

const PURPLE = "#7F77DD";
const PURPLE_RGB = "127, 119, 221";

function applyAdminBrand() {
  const el = document.documentElement;
  el.style.setProperty("--brand",      PURPLE);
  el.style.setProperty("--brand-rgb",  PURPLE_RGB);
  el.style.setProperty("--brand-dim",  `rgba(${PURPLE_RGB}, 0.12)`);
  el.style.setProperty("--brand-soft", `rgba(${PURPLE_RGB}, 0.07)`);
}

function restoreBrand() {
  const el = document.documentElement;
  el.style.setProperty("--brand",      "#00C9A7");
  el.style.setProperty("--brand-rgb",  "0, 201, 167");
  el.style.setProperty("--brand-dim",  "rgba(0, 201, 167, 0.12)");
  el.style.setProperty("--brand-soft", "rgba(0, 201, 167, 0.07)");
}

function AdminSidebar({ mobile, open, onClose }: { mobile?: boolean; open?: boolean; onClose?: () => void }) {
  const [location] = useLocation();
  const logout = useAuthStore(state => state.logout);
  const isImpersonating = useAuthStore(state => state.isImpersonating);
  const exitImpersonation = useAuthStore(state => state.exitImpersonation);
  const token = useAuthStore(state => state.token);

  let adminUser: { firstName: string; lastName: string; email: string } = { firstName: "Super", lastName: "Admin", email: "admin@qlenopro.com" };
  if (token) {
    try {
      const p = JSON.parse(atob(token.split(".")[1]));
      adminUser = {
        firstName: p.first_name || "Super",
        lastName: p.last_name || "Admin",
        email: p.email || "admin@qlenopro.com",
      };
    } catch { /* empty */ }
  }
  const initials = `${adminUser.firstName[0] || "S"}${adminUser.lastName[0] || "A"}`.toUpperCase();

  const content = (
    <div style={{
      width: mobile ? 240 : 200,
      minWidth: mobile ? 240 : 200,
      backgroundColor: "#F5F4FF",
      borderRight: "1px solid #E8E6FF",
      display: "flex",
      flexDirection: "column",
      height: "100%",
    }}>
      {/* Header */}
      <div style={{ padding: "16px 16px 12px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ marginBottom: "8px" }}>
            <QlenoLogo size="md" theme="light" layout="horizontal" />
          </div>
          <span style={{
            fontSize: "10px", fontWeight: 700, color: PURPLE,
            backgroundColor: `rgba(${PURPLE_RGB}, 0.12)`,
            padding: "2px 8px", borderRadius: "4px", letterSpacing: "0.08em",
          }}>
            SUPER ADMIN
          </span>
        </div>
        {mobile && (
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#6B7280", padding: 4 }}>
            <X size={18} />
          </button>
        )}
      </div>

      <div style={{ borderTop: "1px solid #E8E6FF", margin: "0 0 4px" }} />

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        <p style={{ fontSize: "10px", fontWeight: 600, color: "#9E9B94", letterSpacing: "0.1em", textTransform: "uppercase", padding: "8px 16px 6px", margin: 0 }}>
          Platform
        </p>
        {ADMIN_NAV.map(item => {
          const isActive = location === item.url || (item.url !== "/admin" && location.startsWith(item.url));
          const Icon = item.icon;
          return (
            <Link key={item.url} href={item.url}>
              <div
                onClick={mobile ? onClose : undefined}
                style={{
                  height: "36px", padding: "0 12px", margin: "1px 8px",
                  borderRadius: "6px", display: "flex", alignItems: "center",
                  gap: "10px", cursor: "pointer", transition: "all 0.15s",
                  backgroundColor: isActive ? `rgba(${PURPLE_RGB}, 0.12)` : "transparent",
                  color: isActive ? PURPLE : "#6B7280",
                  fontWeight: isActive ? 500 : 400, fontSize: "13px",
                }}
                onMouseEnter={e => { if (!isActive) { e.currentTarget.style.backgroundColor = "#EEEDFB"; e.currentTarget.style.color = "#1A1917"; } }}
                onMouseLeave={e => { if (!isActive) { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "#6B7280"; } }}
              >
                <Icon size={16} strokeWidth={1.5} style={{ flexShrink: 0 }} />
                <span>{item.title}</span>
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ borderTop: "1px solid #E8E6FF", flexShrink: 0 }}>
        {isImpersonating() && (
          <button
            onClick={exitImpersonation}
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: "8px",
              padding: "12px 16px", background: "none", border: "none",
              cursor: "pointer", color: PURPLE, fontSize: "12px", fontWeight: 500,
              borderBottom: "1px solid #E8E6FF",
            }}
          >
            <ArrowLeft size={14} />
            Exit Impersonation
          </button>
        )}
        <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{
            width: "28px", height: "28px", borderRadius: "50%",
            backgroundColor: `rgba(${PURPLE_RGB}, 0.12)`, color: PURPLE,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "11px", fontWeight: 700, flexShrink: 0,
          }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: "12px", fontWeight: 500, color: "#1A1917", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{adminUser.firstName} {adminUser.lastName}</p>
            <p style={{ fontSize: "11px", color: "#6B7280", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{adminUser.email}</p>
          </div>
          <button
            onClick={logout}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94", padding: 4 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1917")}
            onMouseLeave={e => (e.currentTarget.style.color = "#9E9B94")}
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
        <div
          onClick={onClose}
          style={{
            position: "fixed", inset: 0, zIndex: 40,
            backgroundColor: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)",
            opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none",
            transition: "opacity 0.28s ease",
          }}
        />
        <aside style={{
          position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 50,
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.28s cubic-bezier(0.4,0,0.2,1)",
        }}>
          {content}
        </aside>
      </>
    );
  }

  return content;
}

interface AdminLayoutProps {
  children: React.ReactNode;
  title: string;
}

export function AdminLayout({ children, title }: AdminLayoutProps) {
  const [, setLocation] = useLocation();
  const token = useAuthStore(state => state.token);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    applyAdminBrand();
    return () => { restoreBrand(); };
  }, []);

  useEffect(() => {
    if (!token) { setLocation("/login"); return; }
    if (!getTokenIsSuperAdmin()) {
      setLocation("/dashboard");
    }
  }, [token, setLocation]);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", backgroundColor: "#F2F1FE", overflow: "hidden" }}>
      {/* Desktop sidebar */}
      {!isMobile && <AdminSidebar />}

      {/* Mobile sidebar */}
      {isMobile && <AdminSidebar mobile open={drawerOpen} onClose={() => setDrawerOpen(false)} />}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar */}
        <div style={{
          height: "52px", flexShrink: 0, backgroundColor: "#F5F4FF",
          borderBottom: "1px solid #E8E6FF",
          display: "flex", alignItems: "center",
          padding: isMobile ? "0 16px" : "0 24px", gap: "12px",
        }}>
          {isMobile && (
            <button
              onClick={() => setDrawerOpen(true)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#6B7280", padding: 4, display: "flex" }}
            >
              <Menu size={20} />
            </button>
          )}

          <h1 style={{ fontSize: "15px", fontWeight: 600, color: "#1A1917", margin: 0, flex: 1 }}>{title}</h1>

          {/* Super Admin Mode badge */}
          <div style={{
            display: "flex", alignItems: "center", gap: "6px",
            backgroundColor: `rgba(${PURPLE_RGB}, 0.12)`,
            border: `1px solid rgba(${PURPLE_RGB}, 0.3)`,
            borderRadius: "6px", padding: "4px 10px",
          }}>
            <Shield size={12} color={PURPLE} strokeWidth={2} />
            <span style={{ fontSize: "11px", fontWeight: 700, color: PURPLE, letterSpacing: "0.06em" }}>
              SUPER ADMIN MODE
            </span>
          </div>
        </div>

        {/* Content */}
        <main style={{ flex: 1, overflowY: "auto", padding: isMobile ? "16px" : "24px" }}>
          {children}
        </main>
      </div>
    </div>
  );
}
