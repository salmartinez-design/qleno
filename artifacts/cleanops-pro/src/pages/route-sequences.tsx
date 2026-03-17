import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { Plus, GripVertical, Trash2, Route, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default function RouteSequencesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", date: new Date().toISOString().split("T")[0], notes: "" });
  const [saving, setSaving] = useState(false);

  const { data: routes = [], isLoading } = useQuery<any[]>({
    queryKey: ["route-sequences"],
    queryFn: () => apiFetch("/api/routes"),
    staleTime: 15000,
  });

  const { data: employees = [] } = useQuery<any[]>({
    queryKey: ["employees-list"],
    queryFn: () => apiFetch("/api/users"),
    staleTime: 60000,
  });

  async function createRoute() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await apiFetch("/api/routes", { method: "POST", body: JSON.stringify(form) });
      qc.invalidateQueries({ queryKey: ["route-sequences"] });
      setForm({ name: "", date: new Date().toISOString().split("T")[0], notes: "" });
      setShowCreate(false);
      toast({ title: "Route created" });
    } catch {
      toast({ title: "Failed to create route", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function deleteRoute(id: number) {
    try {
      await apiFetch(`/api/routes/${id}`, { method: "DELETE" });
      qc.invalidateQueries({ queryKey: ["route-sequences"] });
      toast({ title: "Route deleted" });
    } catch {
      toast({ title: "Failed to delete route", variant: "destructive" });
    }
  }

  const techCount = employees.filter((e: any) => e.role === "technician" || e.role === "team_lead").length;

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, maxWidth: 900, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#1A1917" }}>Route Sequences</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>
              Organize job routes and assign crews to daily sequences
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}
          >
            <Plus size={14} /> New Route
          </button>
        </div>

        {/* Stats strip */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
          {[
            { label: "Routes Today", value: routes.filter((r: any) => r.date === new Date().toISOString().split("T")[0]).length },
            { label: "Total Routes", value: routes.length },
            { label: "Available Techs", value: techCount },
          ].map(s => (
            <div key={s.label} style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#1A1917" }}>{s.value}</div>
              <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Route list */}
        {isLoading ? (
          <div style={{ padding: 40, textAlign: "center", color: "#9E9B94", fontSize: 13 }}>Loading routes...</div>
        ) : routes.length === 0 ? (
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 48, textAlign: "center" }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", backgroundColor: "var(--brand-dim)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <Route size={22} style={{ color: "var(--brand)" }} />
            </div>
            <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#1A1917" }}>No routes yet</h3>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "#6B7280" }}>Create a route to sequence jobs and assign crews for the day</p>
            <button
              onClick={() => setShowCreate(true)}
              style={{ padding: "9px 20px", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}
            >
              Create First Route
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {routes.map((route: any) => (
              <div key={route.id} style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "18px 20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ marginTop: 2, color: "#D1D5DB", cursor: "grab" }}>
                      <GripVertical size={16} />
                    </div>
                    <div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#1A1917" }}>{route.name}</h3>
                        <span style={{ fontSize: 11, color: "#9E9B94", backgroundColor: "#F3F4F6", padding: "2px 7px", borderRadius: 4 }}>
                          {new Date(route.date + "T12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                        </span>
                        {route.status && (
                          <span style={{
                            fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "2px 7px", borderRadius: 4,
                            backgroundColor: route.status === "active" ? "#DCFCE7" : "#F3F4F6",
                            color: route.status === "active" ? "#166534" : "#6B7280",
                          }}>{route.status}</span>
                        )}
                      </div>
                      {route.notes && <p style={{ margin: 0, fontSize: 12, color: "#6B7280" }}>{route.notes}</p>}
                      <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#9E9B94" }}>
                          <Route size={11} />
                          <span>{route.stop_count ?? 0} stops</span>
                        </div>
                        {route.assigned_tech_name && (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#9E9B94" }}>
                            <Users size={11} />
                            <span>{route.assigned_tech_name}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button
                      onClick={() => deleteRoute(route.id)}
                      style={{ background: "none", border: "1px solid #E5E2DC", cursor: "pointer", borderRadius: 6, padding: "5px 8px", color: "#9E9B94" }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Create modal */}
        {showCreate && (
          <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
            <div style={{ backgroundColor: "#FFFFFF", borderRadius: 12, padding: 28, width: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", fontFamily: FF }}>
              <h3 style={{ margin: "0 0 18px", fontSize: 15, fontWeight: 700, color: "#1A1917" }}>New Route</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Route Name</label>
                  <input
                    value={form.name}
                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                    placeholder="e.g. North Zone AM Route"
                    style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, outline: "none", boxSizing: "border-box" as const }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Date</label>
                  <input
                    type="date"
                    value={form.date}
                    onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
                    style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, outline: "none", boxSizing: "border-box" as const }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                    rows={2}
                    style={{ width: "100%", padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, resize: "vertical", fontFamily: FF, outline: "none", boxSizing: "border-box" as const }}
                  />
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
                <button
                  onClick={() => setShowCreate(false)}
                  style={{ padding: "8px 16px", border: "1px solid #E5E2DC", borderRadius: 7, fontSize: 13, background: "#FFFFFF", cursor: "pointer", fontFamily: FF }}
                >
                  Cancel
                </button>
                <button
                  onClick={createRoute}
                  disabled={saving || !form.name.trim()}
                  style={{ padding: "8px 20px", background: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FF }}
                >
                  {saving ? "Creating..." : "Create Route"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
