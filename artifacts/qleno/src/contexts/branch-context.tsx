import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from "react";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const STORAGE_KEY = "qleno_active_branch";

export interface Branch {
  id: number;
  name: string;
  city: string | null;
  state: string | null;
  is_default: boolean;
  is_active: boolean;
}

interface BranchContextValue {
  branches: Branch[];
  activeBranchId: number | "all";
  activeBranch: Branch | null;
  setActiveBranchId: (id: number | "all") => void;
  isLoading: boolean;
}

const BranchContext = createContext<BranchContextValue>({
  branches: [],
  activeBranchId: "all",
  activeBranch: null,
  setActiveBranchId: () => {},
  isLoading: false,
});

export function useBranch() {
  return useContext(BranchContext);
}

export function BranchProvider({ children }: { children: ReactNode }) {
  const token = useAuthStore(state => state.token);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [activeBranchId, setActiveBranchIdState] = useState<number | "all">(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored || stored === "all") return "all";
    const n = parseInt(stored);
    return isNaN(n) ? "all" : n;
  });
  const [isLoading, setIsLoading] = useState(false);

  const fetchBranches = useCallback(async () => {
    if (!token) return;
    setIsLoading(true);
    try {
      const res = await fetch(`${API}/api/branches`, { headers: getAuthHeaders() });
      if (!res.ok) return;
      const data: Branch[] = await res.json();
      setBranches(data.filter(b => b.is_active));
    } catch {
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchBranches();
  }, [fetchBranches]);

  const setActiveBranchId = useCallback((id: number | "all") => {
    setActiveBranchIdState(id);
    localStorage.setItem(STORAGE_KEY, String(id));
  }, []);

  const activeBranch = activeBranchId === "all"
    ? null
    : branches.find(b => b.id === activeBranchId) ?? null;

  return (
    <BranchContext.Provider value={{ branches, activeBranchId, activeBranch, setActiveBranchId, isLoading }}>
      {children}
    </BranchContext.Provider>
  );
}
