/**
 * /lms/admin/settings — owner-only LMS configuration page
 * (Item 9, P1 sprint 2026-05-14).
 *
 * Today's inhabitant: admin_bypass_allowed (Item 8). Future inhabitants
 * (deadline window, passing threshold, attempt cap, reminder cadence,
 * notification triggers, bilingual toggle per module, LMS-specific
 * branding) belong here too — keep the page general so adding a
 * setting doesn't require a new route.
 *
 * Owner-only: admin role gets a 403 access-denied panel. The backend
 * route also enforces requireRole("owner") on PATCH /api/lms-settings.
 */
import { useEffect, useMemo, useState } from "react";
import { useAuthStore } from "@/lib/auth";
import { useLocation } from "wouter";
import { ChevronLeft, X, Loader2 } from "lucide-react";

const NAVY = "#0A2342";
const TEAL = "#0096B3";
const INK = "#0F172A";
const INK_MUTE = "#475569";
const INK_LIGHT = "#94A3B8";
const PAGE_BG = "#F8FAFC";
const SURFACE = "#FFFFFF";
const LINE = "#E2E8F0";
const SUCCESS = "#0F766E";
const DANGER = "#B91C1C";
const FONT = "'Plus Jakarta Sans', sans-serif";
const RADIUS = 10;

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") + "/api";

interface AuthPayload {
  role?: string;
}

function readRoleFromToken(token: string | null): AuthPayload | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(atob(parts[1])) as AuthPayload;
  } catch {
    return null;
  }
}

interface LmsSettings {
  id: number;
  company_id: number;
  admin_bypass_allowed: boolean;
  admin_add_employee_allowed: boolean;
  admin_edit_employee_allowed: boolean;
  created_at: string;
  updated_at: string;
}

async function api<T>(
  method: "GET" | "PATCH",
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.data as T;
}

export default function LmsAdminSettingsPage() {
  const token = useAuthStore((s) => s.token);
  const auth = useMemo(() => readRoleFromToken(token), [token]);
  // [office-admin-parity 2026-06-26] LMS admin settings = owner + office (Sal:
  // "me or the office"). Techs/team_leads stay fully excluded. Name kept as
  // `isOwner` since it gates this page's edit access.
  const isOwner = auth?.role === "owner" || auth?.role === "office" || auth?.role === "super_admin";
  const [, setLocation] = useLocation();
  const [settings, setSettings] = useState<LmsSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api<LmsSettings>("GET", "/lms-settings", token);
        if (!cancelled) setSettings(data);
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner, token]);

  async function patchSetting(patch: Partial<LmsSettings>) {
    setBusy(true);
    setErr(null);
    try {
      const data = await api<LmsSettings>(
        "PATCH",
        "/lms-settings",
        token,
        patch,
      );
      setSettings(data);
      setSavedAt(Date.now());
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  if (!isOwner) {
    return (
      <Shell>
        <div
          style={{
            maxWidth: 480,
            margin: "60px auto",
            background: SURFACE,
            border: `1px solid ${LINE}`,
            borderRadius: RADIUS,
            padding: 28,
            textAlign: "center",
          }}
        >
          <X size={36} style={{ color: DANGER }} />
          <div
            style={{
              fontWeight: 800,
              fontSize: 18,
              color: INK,
              marginTop: 8,
            }}
          >
            Owner only
          </div>
          <div style={{ fontSize: 13, color: INK_MUTE, marginTop: 4 }}>
            LMS settings are restricted to the tenant owner. Contact Sal
            if you need a setting changed.
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ maxWidth: 720, margin: "20px auto", padding: "0 16px" }}>
        <button
          type="button"
          onClick={() => setLocation("/lms/admin")}
          style={{
            background: "transparent",
            border: 0,
            color: NAVY,
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: FONT,
          }}
        >
          <ChevronLeft size={14} /> Back to roster
        </button>
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              fontWeight: 800,
              fontSize: 22,
              letterSpacing: "-0.015em",
              color: INK,
            }}
          >
            LMS Settings
          </div>
          <div style={{ fontSize: 13, color: INK_MUTE, marginTop: 4 }}>
            Per-tenant configuration for the Learning Management System.
            Owner-only changes; admins can read but not write.
          </div>
        </div>

        {err && (
          <div
            style={{
              marginTop: 14,
              background: "#FEF2F2",
              border: `1px solid #FECACA`,
              color: DANGER,
              padding: 10,
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {err}
          </div>
        )}

        {settings === null && !err ? (
          <div
            style={{
              marginTop: 30,
              padding: 30,
              textAlign: "center",
              color: INK_MUTE,
            }}
          >
            <Loader2 size={20} className="qleno-spin" />
          </div>
        ) : settings ? (
          <div
            style={{
              marginTop: 18,
              background: SURFACE,
              border: `1px solid ${LINE}`,
              borderRadius: RADIUS,
              padding: 0,
              fontFamily: FONT,
            }}
          >
            <SettingRow
              title="Allow administrators to bypass modules"
              description="When OFF (default), only the owner sees the Bypass button on the per-employee admin row. When ON, both owner AND admin role see it. Same type-to-confirm guard regardless of role. Office role NEVER sees it. The backend enforces this gate too. Flipping the toggle off immediately revokes admin bypass."
              checked={settings.admin_bypass_allowed}
              onChange={(v) => patchSetting({ admin_bypass_allowed: v })}
              disabled={busy}
            />
            <SettingRow
              title="Allow administrators to add employees"
              description="When OFF (default), only the owner sees the Add Employee button on the LMS roster. When ON, admins can also onboard new hires. The new hire is created scoped to this tenant; cross-tenant creation is impossible. Office role never sees the button."
              checked={settings.admin_add_employee_allowed}
              onChange={(v) => patchSetting({ admin_add_employee_allowed: v })}
              disabled={busy}
            />
            <SettingRow
              title="Allow administrators to edit employees"
              description="When OFF (default), only the owner sees the Edit button on each roster row. When ON, admins can also update name, email, role, or hire date. Email and role changes are written to the audit log explicitly so the office team can review them later."
              checked={settings.admin_edit_employee_allowed}
              onChange={(v) => patchSetting({ admin_edit_employee_allowed: v })}
              disabled={busy}
            />
          </div>
        ) : null}

        {savedAt ? (
          <div
            style={{
              marginTop: 14,
              fontSize: 12,
              color: SUCCESS,
              fontWeight: 700,
            }}
          >
            Saved.
          </div>
        ) : null}

        <div
          style={{
            marginTop: 28,
            fontSize: 11,
            color: INK_LIGHT,
            lineHeight: 1.55,
          }}
        >
          Future settings will live on this page: deadline window,
          passing threshold, per-module attempt cap, reminder cadence,
          notification triggers, bilingual toggle per module, LMS-
          specific branding.
        </div>
      </div>
      <style>{`
        @keyframes qleno-spin { to { transform: rotate(360deg); } }
        .qleno-spin { animation: qleno-spin 1s linear infinite; }
      `}</style>
    </Shell>
  );
}

function SettingRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div
      style={{
        padding: "16px 18px",
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 16,
        alignItems: "flex-start",
        borderBottom: `1px solid ${LINE}`,
      }}
    >
      <div>
        <div style={{ fontWeight: 700, fontSize: 14, color: INK }}>{title}</div>
        <div
          style={{
            fontSize: 12,
            color: INK_MUTE,
            marginTop: 4,
            lineHeight: 1.55,
          }}
        >
          {description}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        disabled={disabled}
        aria-pressed={checked}
        style={{
          background: checked ? TEAL : "#CBD5E1",
          color: "#fff",
          border: 0,
          padding: "0",
          width: 56,
          height: 30,
          borderRadius: 999,
          cursor: disabled ? "default" : "pointer",
          position: "relative",
          opacity: disabled ? 0.6 : 1,
          fontFamily: FONT,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 28 : 3,
            width: 24,
            height: 24,
            background: "#fff",
            borderRadius: 999,
            transition: "left 120ms ease",
          }}
        />
      </button>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: PAGE_BG,
        fontFamily: FONT,
        color: INK,
      }}
    >
      {children}
    </div>
  );
}
