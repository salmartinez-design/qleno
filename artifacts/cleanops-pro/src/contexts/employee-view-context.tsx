import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface EmployeeViewState {
  employeeId: number;
  employeeName: string;
}

interface EmployeeViewContextValue {
  employeeView: EmployeeViewState | null;
  activateView: (employee: EmployeeViewState) => Promise<void>;
  exitView: () => void;
}

const EmployeeViewContext = createContext<EmployeeViewContextValue>({
  employeeView: null,
  activateView: async () => {},
  exitView: () => {},
});

export function useEmployeeView() {
  return useContext(EmployeeViewContext);
}

export function EmployeeViewProvider({ children }: { children: ReactNode }) {
  const [employeeView, setEmployeeView] = useState<EmployeeViewState | null>(null);

  const activateView = useCallback(async (employee: EmployeeViewState) => {
    setEmployeeView(employee);
    try {
      await fetch(`${API}/api/users/${employee.employeeId}/employee-view-log`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
    } catch { }
  }, []);

  const exitView = useCallback(() => {
    setEmployeeView(null);
  }, []);

  return (
    <EmployeeViewContext.Provider value={{ employeeView, activateView, exitView }}>
      {children}
    </EmployeeViewContext.Provider>
  );
}
