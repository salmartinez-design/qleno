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
  token: localStorage.getItem('cleanops_token'),
  setToken: (token) => {
    if (token) {
      localStorage.setItem('cleanops_token', token);
    } else {
      localStorage.removeItem('cleanops_token');
    }
    set({ token });
  },
  logout: () => {
    localStorage.removeItem('cleanops_token');
    localStorage.removeItem('cleanops_admin_token');
    set({ token: null });
    window.location.href = '/login';
  },
  impersonate: (impersonationToken: string) => {
    const currentToken = get().token;
    if (currentToken) {
      localStorage.setItem('cleanops_admin_token', currentToken);
    }
    localStorage.setItem('cleanops_token', impersonationToken);
    set({ token: impersonationToken });
    window.location.href = '/dashboard';
  },
  exitImpersonation: () => {
    const adminToken = localStorage.getItem('cleanops_admin_token');
    if (adminToken) {
      localStorage.setItem('cleanops_token', adminToken);
      localStorage.removeItem('cleanops_admin_token');
      set({ token: adminToken });
      window.location.href = '/admin/companies';
    }
  },
  isImpersonating: () => {
    return !!localStorage.getItem('cleanops_admin_token');
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
