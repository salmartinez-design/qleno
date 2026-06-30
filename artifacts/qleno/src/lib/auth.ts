import { create } from 'zustand';

export interface AvailableCompany {
  id: number;
  name: string;
}

function loadAvailableCompanies(): AvailableCompany[] {
  try {
    const raw = localStorage.getItem('qleno_companies');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

interface AuthState {
  token: string | null;
  availableCompanies: AvailableCompany[];
  isSwitchingCompany: boolean;
  setToken: (token: string | null) => void;
  setAvailableCompanies: (companies: AvailableCompany[]) => void;
  switchCompany: (companyId: number) => Promise<void>;
  logout: () => void;
  impersonate: (impersonationToken: string) => void;
  exitImpersonation: () => void;
  isImpersonating: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('qleno_token'),
  availableCompanies: loadAvailableCompanies(),
  isSwitchingCompany: false,
  setToken: (token) => {
    if (token) {
      localStorage.setItem('qleno_token', token);
    } else {
      localStorage.removeItem('qleno_token');
    }
    set({ token });
  },
  setAvailableCompanies: (companies) => {
    localStorage.setItem('qleno_companies', JSON.stringify(companies));
    set({ availableCompanies: companies });
  },
  switchCompany: async (companyId: number) => {
    const token = get().token;
    if (!token) return;
    set({ isSwitchingCompany: true });
    try {
      const res = await fetch('/api/auth/switch-company', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ company_id: companyId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to switch company');
      }
      const data = await res.json();
      // Store new token
      localStorage.setItem('qleno_token', data.token);
      if (data.available_companies) {
        localStorage.setItem('qleno_companies', JSON.stringify(data.available_companies));
      }
      set({
        token: data.token,
        availableCompanies: data.available_companies ?? get().availableCompanies,
        isSwitchingCompany: false,
      });
    } catch (err) {
      set({ isSwitchingCompany: false });
      throw err;
    }
  },
  logout: () => {
    const token = get().token;
    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    localStorage.removeItem('qleno_token');
    localStorage.removeItem('qleno_admin_token');
    localStorage.removeItem('qleno_companies');
    set({ token: null, availableCompanies: [] });
    window.location.href = '/login';
  },
  impersonate: (impersonationToken: string) => {
    const currentToken = get().token;
    if (currentToken) {
      localStorage.setItem('qleno_admin_token', currentToken);
    }
    localStorage.setItem('qleno_token', impersonationToken);
    set({ token: impersonationToken });
    window.location.href = '/dashboard';
  },
  exitImpersonation: () => {
    const adminToken = localStorage.getItem('qleno_admin_token');
    if (adminToken) {
      localStorage.setItem('qleno_token', adminToken);
      localStorage.removeItem('qleno_admin_token');
      set({ token: adminToken });
      window.location.href = '/admin/companies';
    }
  },
  isImpersonating: () => {
    return !!localStorage.getItem('qleno_admin_token');
  },
}));

export function getAuthHeaders() {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getTokenRole(): string | null {
  const token = useAuthStore.getState().token;
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.role || null;
  } catch {
    return null;
  }
}

export function getTokenUserId(): number | null {
  const token = useAuthStore.getState().token;
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return typeof payload.userId === 'number' ? payload.userId : (payload.userId ? Number(payload.userId) : null);
  } catch {
    return null;
  }
}

export function getTokenIsSuperAdmin(): boolean {
  const token = useAuthStore.getState().token;
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.isSuperAdmin === true || payload.role === 'super_admin';
  } catch {
    return false;
  }
}

function getTokenExp(): number | null {
  const token = useAuthStore.getState().token;
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

// True when the stored pass carries an exp claim that has already passed. A
// pass with no exp claim is treated as NOT expired (don't lock anyone out on a
// malformed token). The auth gate uses this so an expired pass routes to the
// login screen instead of a silent empty "No jobs today".
export function isTokenExpired(): boolean {
  const exp = getTokenExp();
  if (exp == null) return false;
  return Math.floor(Date.now() / 1000) >= exp;
}

// [tech-session 2026-06-30] Keep field techs logged in. Two jobs:
//   1. renew the pass on every app open (renewOnOpen) so an active tech never
//      runs it out — each open resets the 30-day clock server-side;
//   2. while the app stays open, renew near expiry and, if the pass has gone
//      fully stale, log out → the login screen (never a blank jobs list).
// NOTE: this must be STARTED (it was dead code before — defined, never called).
export function startTokenRefresh() {
  const TWO_HOURS = 2 * 60 * 60;
  const checkInterval = 30 * 60 * 1000; // re-check every 30 min while open

  const refresh = async (renewOnOpen = false) => {
    const exp = getTokenExp();
    if (!exp) return;

    const now = Math.floor(Date.now() / 1000);
    const remaining = exp - now;

    if (remaining < 0) {
      // Fully expired → clear the dead pass and send them to the login screen.
      useAuthStore.getState().logout();
      return;
    }

    // Renew immediately on app open, or once we're within 2h of expiry.
    if (renewOnOpen || remaining < TWO_HOURS) {
      try {
        const token = useAuthStore.getState().token;
        if (!token) return;
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.token) {
            useAuthStore.getState().setToken(data.token);
          }
        } else if (res.status === 401) {
          useAuthStore.getState().logout();
        }
      } catch {}
    }
  };

  refresh(true); // slide the pass forward the moment the app opens
  return setInterval(() => refresh(false), checkInterval);
}
