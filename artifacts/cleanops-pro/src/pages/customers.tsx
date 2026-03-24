import { useState, useEffect, useRef } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLocation } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { getAuthHeaders } from "@/lib/auth";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useBranch } from "@/contexts/branch-context";
import { Plus, Search, Phone, Mail, MapPin, Download, MessageSquare, UserPlus, ChevronDown, X, Loader2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Client = {
  id: number; first_name: string; last_name: string; email?: string; phone?: string;
  address?: string; city?: string; state?: string; zip?: string; company_name?: string;
  loyalty_points: number; loyalty_tier: string; frequency?: string; service_type?: string;
  is_active: boolean; portal_access: boolean; portal_invite_sent_at?: string;
  last_service_date?: string | null; next_service_date?: string | null;
  at_risk?: boolean; days_since_last?: number;
};

function fmtDate(d?: string | null) {
  if (!d) return "Never";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function freqLabel(f?: string | null) {
  if (!f) return null;
  const m: Record<string, string> = { weekly: "Weekly", biweekly: "Bi-weekly", monthly: "Monthly", on_demand: "On Demand" };
  return m[f] || f;
}

function tierColor(tier: string) {
  if (tier === "vip") return { bg: "#FEF9C3", text: "#713F12", label: "VIP" };
  if (tier === "gold") return { bg: "#FEF3C7", text: "#92400E", label: "GOLD" };
  if (tier === "silver") return { bg: "#F1F5F9", text: "#475569", label: "SILVER" };
  return null; // Standard — hide badge
}

const STATUS_OPTIONS = ["all", "active", "inactive"] as const;
const FREQ_OPTIONS = ["all", "weekly", "biweekly", "monthly", "on_demand"] as const;

const PAGE_SIZE = 50;

export default function CustomersPage() {
  const [, navigate] = useLocation();
  const isMobile = useIsMobile();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [frequency, setFrequency] = useState<string>("all");
  const [selected, setSelected] = useState<number[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { activeBranchId } = useBranch();

  // 300ms debounce on search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset limit when filters change
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [search, status, frequency, activeBranchId]);

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (status !== "all") params.set("status", status);
  if (frequency !== "all") params.set("frequency", frequency);
  if (activeBranchId !== "all") params.set("branch_id", String(activeBranchId));
  params.set("limit", String(limit));

  const { data, isLoading, isFetching } = useQuery<{ data: Client[]; total: number }>({
    queryKey: ["clients", search, status, frequency, activeBranchId, limit],
    queryFn: async () => {
      const r = await fetch(`${API}/api/clients?${params}`, { headers: getAuthHeaders() as Record<string, string> });
      return r.json();
    },
    staleTime: 15000,
    placeholderData: keepPreviousData,
  });

  const clients = data?.data || [];
  const total = data?.total ?? 0;
  const hasMore = total > clients.length;

  const toggleSelect = (id: number) =>
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const toggleAll = () =>
    setSelected(prev => prev.length === clients.length ? [] : clients.map(c => c.id));

  const TH: React.CSSProperties = {
    padding: "11px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600,
    color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em",
    borderBottom: "1px solid #EEECE7", whiteSpace: "nowrap",
  };

  const filterBtn = (active: boolean): React.CSSProperties => ({
    padding: "6px 12px", border: `1px solid ${active ? "var(--brand)" : "#E5E2DC"}`,
    borderRadius: "6px", backgroundColor: active ? "var(--brand-dim)" : "#FFFFFF",
    color: active ? "var(--brand)" : "#6B7280", fontSize: "12px", fontWeight: active ? 600 : 400,
    cursor: "pointer", whiteSpace: "nowrap",
  });

  return (
    <DashboardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 700, color: "#1A1917" }}>Clients</h1>
            <p style={{ margin: "2px 0 0", fontSize: "13px", color: "#9E9B94" }}>
              {isLoading ? "Loading..." : `${total.toLocaleString()} total clients`}
            </p>
          </div>
          <button
            onClick={() => navigate("/customers/new")}
            style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 16px", backgroundColor: "var(--brand)", color: "#FFFFFF", borderRadius: "8px", fontSize: "13px", fontWeight: 600, border: "none", cursor: "pointer" }}
          >
            <Plus size={14} strokeWidth={2} /> Add Client
          </button>
        </div>

        {/* Filter Bar */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {/* Search row */}
          <div style={{ position: "relative" }}>
            <Search size={13} strokeWidth={1.5} style={{ position: "absolute", left: "11px", top: "50%", transform: "translateY(-50%)", color: "#9E9B94", pointerEvents: "none" }} />
            <input
              placeholder="Search name, phone, email, address, city, CL-XXXX..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              style={{ paddingLeft: "34px", paddingRight: searchInput ? "36px" : "12px", height: "38px", width: "100%", backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "8px", color: "#1A1917", fontSize: "13px", outline: "none", boxSizing: "border-box" }}
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput("")}
                style={{ position: "absolute", right: "10px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#9E9B94", display: "flex", alignItems: "center" }}
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Filter chips — horizontal scroll on mobile */}
          <div style={{ display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "2px" }}>
            {/* Status */}
            <div style={{ display: "flex", gap: "4px", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: "8px", padding: "3px", flexShrink: 0 }}>
              {STATUS_OPTIONS.map(s => (
                <button key={s} onClick={() => setStatus(s)} style={filterBtn(status === s)}>
                  {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>

            {/* Frequency */}
            <div style={{ display: "flex", gap: "4px", background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: "8px", padding: "3px", flexShrink: 0 }}>
              {FREQ_OPTIONS.map(f => (
                <button key={f} onClick={() => setFrequency(f)} style={filterBtn(frequency === f)}>
                  {f === "all" ? "All Freq" : freqLabel(f)}
                </button>
              ))}
            </div>
          </div>

          {/* Bulk actions */}
          {selected.length > 0 && (
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setBulkOpen(v => !v)}
                style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", border: "1px solid #E5E2DC", borderRadius: "8px", backgroundColor: "#FFFFFF", color: "#1A1917", fontSize: "13px", cursor: "pointer" }}
              >
                {selected.length} selected <ChevronDown size={12} />
              </button>
              {bulkOpen && (
                <div style={{ position: "absolute", top: "36px", left: 0, backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "8px", boxShadow: "0 4px 16px rgba(0,0,0,0.08)", zIndex: 100, minWidth: "160px", overflow: "hidden" }}>
                  {[{ icon: MessageSquare, label: "Send SMS" }, { icon: UserPlus, label: "Send Portal Invite" }, { icon: Download, label: "Export CSV" }].map(({ icon: Icon, label }) => (
                    <button key={label} onClick={() => setBulkOpen(false)} style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "10px 14px", background: "none", border: "none", fontSize: "13px", color: "#1A1917", cursor: "pointer", textAlign: "left" }}>
                      <Icon size={13} strokeWidth={1.5} /> {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Client List */}
        {isMobile ? (
          /* ── MOBILE CARDS ── */
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
            {isLoading ? (
              <div style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>Loading clients...</div>
            ) : clients.length === 0 ? (
              <div style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>No clients found</div>
            ) : clients.map(client => {
              const tier = tierColor(client.loyalty_tier);
              const freq = freqLabel(client.frequency);
              return (
                <div
                  key={client.id}
                  onClick={() => navigate(`/customers/${client.id}`)}
                  style={{ borderBottom: "1px solid #F0EEE9", padding: "14px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Name row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
                      <span style={{ fontSize: "16px", fontWeight: 700, color: "#1A1917" }}>
                        {client.first_name} {client.last_name}
                      </span>
                      {!client.is_active && (
                        <span style={{ background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB", padding: "2px 6px", borderRadius: "4px", fontSize: "10px", fontWeight: 600, flexShrink: 0 }}>Inactive</span>
                      )}
                    </div>
                    {/* Sub-row: frequency + city */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {freq && (
                        <span style={{ background: "var(--brand-dim)", color: "var(--brand)", padding: "2px 7px", borderRadius: "4px", fontSize: "11px", fontWeight: 600 }}>
                          {freq}
                        </span>
                      )}
                      {client.city && (
                        <span style={{ fontSize: "12px", color: "#9E9B94", display: "flex", alignItems: "center", gap: 3 }}>
                          <MapPin size={10} strokeWidth={1.5} />{client.city}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Right: loyalty tier (Gold/Silver/VIP only) */}
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {tier && (
                      <span style={{ background: tier.bg, color: tier.text, padding: "2px 7px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, display: "block" }}>
                        {tier.label}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {/* Load More — mobile */}
            {(hasMore || isFetching) && (
              <div style={{ padding: "14px 16px", borderTop: "1px solid #F0EEE9", textAlign: "center" }}>
                {isFetching ? (
                  <span style={{ fontSize: "13px", color: "#9E9B94", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Loading...
                  </span>
                ) : (
                  <button
                    onClick={() => setLimit(l => l + PAGE_SIZE)}
                    style={{ padding: "8px 20px", border: "1px solid #E5E2DC", borderRadius: "8px", background: "#FFFFFF", color: "#1A1917", fontSize: "13px", fontWeight: 500, cursor: "pointer" }}
                  >
                    Load more ({total - clients.length} remaining)
                  </button>
                )}
              </div>
            )}
            {/* Showing count */}
            {!isLoading && clients.length > 0 && (
              <div style={{ padding: "10px 16px", borderTop: "1px solid #F0EEE9", textAlign: "center" }}>
                <span style={{ fontSize: "12px", color: "#9E9B94" }}>
                  Showing {clients.length.toLocaleString()} of {total.toLocaleString()} clients
                </span>
              </div>
            )}
          </div>
        ) : (
          /* ── DESKTOP TABLE ── */
          <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "860px" }}>
                <thead>
                  <tr style={{ backgroundColor: "#FAFAF8" }}>
                    <th style={{ ...TH, width: "44px" }}>
                      <button
                        onClick={toggleAll}
                        style={{ width: "16px", height: "16px", borderRadius: "4px", border: `1px solid ${selected.length === clients.length && clients.length > 0 ? "var(--brand)" : "#DEDAD4"}`, backgroundColor: selected.length === clients.length && clients.length > 0 ? "var(--brand)" : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                      >
                        {selected.length === clients.length && clients.length > 0 && <div style={{ width: "8px", height: "2px", backgroundColor: "#FFFFFF" }} />}
                      </button>
                    </th>
                    {["Client", "Phone / Email", "City", "Frequency", "Last / Next", "Loyalty", "Status"].map(h => (
                      <th key={h} style={TH}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr><td colSpan={8} style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>Loading clients...</td></tr>
                  ) : clients.length === 0 ? (
                    <tr><td colSpan={8} style={{ padding: "48px", textAlign: "center", color: "#9E9B94", fontSize: "13px" }}>No clients found</td></tr>
                  ) : clients.map(client => {
                    const isSelected = selected.includes(client.id);
                    const tier = tierColor(client.loyalty_tier);
                    const rowStyle: React.CSSProperties = {
                      borderBottom: "1px solid #F0EEE9",
                      borderLeft: "3px solid transparent",
                      backgroundColor: isSelected ? "rgba(91,155,213,0.05)" : "transparent",
                      cursor: "pointer",
                    };
                    return (
                      <tr
                        key={client.id}
                        style={rowStyle}
                        onClick={() => navigate(`/customers/${client.id}`)}
                        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.backgroundColor = "#F7F6F3"; }}
                        onMouseLeave={e => { e.currentTarget.style.backgroundColor = isSelected ? "rgba(91,155,213,0.05)" : "transparent"; }}
                      >
                        {/* Checkbox */}
                        <td style={{ padding: "14px 16px" }} onClick={e => { e.stopPropagation(); toggleSelect(client.id); }}>
                          <button
                            style={{ width: "16px", height: "16px", borderRadius: "4px", border: `1px solid ${isSelected ? "var(--brand)" : "#DEDAD4"}`, backgroundColor: isSelected ? "var(--brand)" : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                          >
                            {isSelected && <div style={{ width: "8px", height: "2px", backgroundColor: "#FFFFFF" }} />}
                          </button>
                        </td>

                        {/* Client name + ID */}
                        <td style={{ padding: "14px 16px" }}>
                          <p style={{ fontSize: "13px", fontWeight: 600, color: "#1A1917", margin: 0 }}>
                            {client.first_name} {client.last_name}
                            {client.company_name && <span style={{ fontWeight: 400, color: "#9E9B94", marginLeft: 4 }}>· {client.company_name}</span>}
                          </p>
                          <p style={{ fontSize: "11px", color: "#9E9B94", margin: "2px 0 0" }}>CL-{String(client.id).padStart(4, "0")}</p>
                        </td>

                        {/* Phone + Email */}
                        <td style={{ padding: "14px 16px" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                            {client.phone && <div style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#6B7280" }}><Phone size={10} strokeWidth={1.5} />{client.phone}</div>}
                            {client.email && <div style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#6B7280" }}><Mail size={10} strokeWidth={1.5} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "160px" }}>{client.email}</span></div>}
                          </div>
                        </td>

                        {/* City */}
                        <td style={{ padding: "14px 16px" }}>
                          {client.city ? (
                            <span style={{ fontSize: "12px", color: "#6B7280" }}>{client.city}</span>
                          ) : (
                            <span style={{ color: "#C4C0BB", fontSize: "12px" }}>—</span>
                          )}
                        </td>

                        {/* Frequency */}
                        <td style={{ padding: "14px 16px" }}>
                          {client.frequency ? (
                            <span style={{ background: "var(--brand-dim)", color: "var(--brand)", padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 600 }}>
                              {freqLabel(client.frequency)}
                            </span>
                          ) : <span style={{ color: "#C4C0BB", fontSize: "12px" }}>—</span>}
                        </td>

                        {/* Last / Next */}
                        <td style={{ padding: "14px 16px" }}>
                          <p style={{ fontSize: "12px", color: "#6B7280", margin: 0 }}>Last: <span style={{ color: "#1A1917", fontWeight: 500 }}>{fmtDate(client.last_service_date)}</span></p>
                          <p style={{ fontSize: "12px", color: "#6B7280", margin: "2px 0 0" }}>Next: <span style={{ color: client.next_service_date ? "var(--brand)" : "#9E9B94", fontWeight: client.next_service_date ? 500 : 400 }}>{client.next_service_date ? fmtDate(client.next_service_date) : "Not scheduled"}</span></p>
                        </td>

                        {/* Loyalty */}
                        <td style={{ padding: "14px 16px" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                            <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--brand)" }}>{client.loyalty_points} pts</span>
                            {tier && <span style={{ background: tier.bg, color: tier.text, padding: "2px 6px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, letterSpacing: "0.05em", display: "inline-block" }}>{tier.label}</span>}
                          </div>
                        </td>

                        {/* Status */}
                        <td style={{ padding: "14px 16px" }}>
                          {client.is_active
                            ? <span style={{ background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0", padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>Active</span>
                            : <span style={{ background: "#F3F4F6", color: "#6B7280", border: "1px solid #E5E7EB", padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>Inactive</span>
                          }
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer: showing count + load more */}
            {!isLoading && clients.length > 0 && (
              <div style={{ padding: "14px 20px", borderTop: "1px solid #F0EEE9", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontSize: "12px", color: "#9E9B94" }}>
                  Showing {clients.length.toLocaleString()} of {total.toLocaleString()} clients
                </span>
                {hasMore && (
                  isFetching ? (
                    <span style={{ fontSize: "13px", color: "#9E9B94", display: "flex", alignItems: "center", gap: 6 }}>
                      <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Loading...
                    </span>
                  ) : (
                    <button
                      onClick={() => setLimit(l => l + PAGE_SIZE)}
                      style={{ padding: "6px 16px", border: "1px solid #E5E2DC", borderRadius: "8px", background: "#FFFFFF", color: "#1A1917", fontSize: "13px", fontWeight: 500, cursor: "pointer" }}
                    >
                      Load {Math.min(PAGE_SIZE, total - clients.length)} more
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        )}

        <style>{`
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        `}</style>
      </div>
    </DashboardLayout>
  );
}
