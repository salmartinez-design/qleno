import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuthStore, getTokenRole } from "@/lib/auth";
import {
  LayoutDashboard, Building2, CreditCard, BookOpen,
  LogOut, X, Menu, Shield, ArrowLeft
} from "lucide-react";

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
  el.style.setProperty("--brand-dim",  `rgba(${PURPLE_RGB}, 0.15)`);
  el.style.setProperty("--brand-soft", `rgba(${PURPLE_RGB}, 0.08)`);
}

function restoreBrand() {
  const el = document.documentElement;
  el.style.setProperty("--brand",      "#C53030");
  el.style.setProperty("--brand-rgb",  "197, 48, 48");
  el.style.setProperty("--brand-dim",  "rgba(197, 48, 48, 0.15)");
  el.style.setProperty("--brand-soft", "rgba(197, 48, 48, 0.08)");
}

function AdminSidebar({ mobile, open, onClose }: { mobile?: boolean; open?: boolean; onClose?: () => void }) {
  const [location] = useLocation();
  const logout = useAuthStore(state => state.logout);
  const isImpersonating = useAuthStore(state => state.isImpersonating);
  const exitImpersonation = useAuthStore(state => state.exitImpersonation);

  const content = (
    <div style={{
      width: mobile ? 240 : 200,
      minWidth: mobile ? 240 : 200,
      backgroundColor: "#0F0F14",
      borderRight: "1px solid #1A1A22",
      display: "flex",
      flexDirection: "column",
      height: "100%",
    }}>
      {/* Header */}
      <div style={{ padding: "18px 16px 12px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <Shield size={16} color={PURPLE} strokeWidth={2} />
            <span style={{ fontSize: "14px", fontWeight: 700, color: "#F0EDE8", letterSpacing: "-0.01em" }}>CleanOps Pro</span>
          </div>
          <span style={{
            fontSize: "10px", fontWeight: 700, color: PURPLE,
            backgroundColor: `rgba(${PURPLE_RGB}, 0.15)`,
            padding: "2px 8px", borderRadius: "4px", letterSpacing: "0.08em",
          }}>
            SUPER ADMIN
          </span>
        </div>
        {mobile && (
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#7A7873", padding: 4 }}>
            <X size={18} />
          </button>
        )}
      </div>

      <div style={{ borderTop: "1px solid #1A1A22", margin: "0 0 4px" }} />

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        <p style={{ fontSize: "10px", fontWeight: 600, color: "#4A4845", letterSpacing: "0.1em", textTransform: "uppercase", padding: "8px 16px 6px", margin: 0 }}>
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
                  color: isActive ? PURPLE : "#7A7873",
                  fontWeight: isActive ? 500 : 400, fontSize: "13px",
                }}
                onMouseEnter={e => { if (!isActive) { e.currentTarget.style.backgroundColor = "#1C1C28"; e.currentTarget.style.color = "#F0EDE8"; } }}
                onMouseLeave={e => { if (!isActive) { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "#7A7873"; } }}
              >
                <Icon size={16} strokeWidth={1.5} style={{ flexShrink: 0 }} />
                <span>{item.title}</span>
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ borderTop: "1px solid #1A1A22", flexShrink: 0 }}>
        {isImpersonating() && (
          <button
            onClick={exitImpersonation}
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: "8px",
              padding: "12px 16px", background: "none", border: "none",
              cursor: "pointer", color: PURPLE, fontSize: "12px", fontWeight: 500,
              borderBottom: "1px solid #1A1A22",
            }}
          >
            <ArrowLeft size={14} />
            Exit Impersonation
          </button>
        )}
        <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{
            width: "28px", height: "28px", borderRadius: "50%",
            backgroundColor: `rgba(${PURPLE_RGB}, 0.15)`, color: PURPLE,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "11px", fontWeight: 700, flexShrink: 0,
          }}>SA</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: "12px", fontWeight: 500, color: "#F0EDE8", margin: 0 }}>Super Admin</p>
            <p style={{ fontSize: "11px", color: "#4A4845", margin: 0 }}>admin@cleanopspro.com</p>
          </div>
          <button
            onClick={logout}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#4A4845", padding: 4 }}
            onMouseEnter={e => e.currentTarget.style.color = "#F0EDE8"}
            onMouseLeave={e => e.currentTarget.style.color = "#4A4845"}
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
            backgroundColor: "rgba(0,0,0,0.72)", backdropFilter: "blur(2px)",
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
    const role = getTokenRole();
    if (role !== "super_admin") {
      setLocation("/dashboard");
    }
  }, [token, setLocation]);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", backgroundColor: "#0A0A0A", overflow: "hidden" }}>
      {/* Desktop sidebar */}
      {!isMobile && <AdminSidebar />}

      {/* Mobile sidebar */}
      {isMobile && <AdminSidebar mobile open={drawerOpen} onClose={() => setDrawerOpen(false)} />}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar */}
        <div style={{
          height: "52px", flexShrink: 0, backgroundColor: "#0F0F14",
          borderBottom: "1px solid #1A1A22",
          display: "flex", alignItems: "center",
          padding: isMobile ? "0 16px" : "0 24px", gap: "12px",
        }}>
          {isMobile && (
            <button
              onClick={() => setDrawerOpen(true)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#7A7873", padding: 4, display: "flex" }}
            >
              <Menu size={20} />
            </button>
          )}

          <h1 style={{ fontSize: "15px", fontWeight: 600, color: "#F0EDE8", margin: 0, flex: 1 }}>{title}</h1>

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
