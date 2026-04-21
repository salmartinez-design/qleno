import { create } from 'zustand';

interface AuthState {
  token: string | null;
  setToken: (token: string | null) => void;
  logout: () => void;
  impersonate: (impersonationToken: string) => void;
  exitImpersonation: () => void;
  isImpersonating: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('qleno_token'),
  setToken: (token) => {
    if (token) {
      localStorage.setItem('qleno_token', token);
    } else {
      localStorage.removeItem('qleno_token');
    }
    set({ token });
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
    set({ token: null });
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

export function startTokenRefresh() {
  const TWO_HOURS = 2 * 60 * 60;
  const checkInterval = 5 * 60 * 1000;

  const refresh = async () => {
    const exp = getTokenExp();
    if (!exp) return;

    const now = Math.floor(Date.now() / 1000);
    const remaining = exp - now;

    if (remaining < 0) {
      useAuthStore.getState().logout();
      return;
    }

    if (remaining < TWO_HOURS) {
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

  refresh();
  return setInterval(refresh, checkInterval);
}
