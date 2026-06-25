import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { getAuthHeaders } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Plus, FileText, Send, CheckCircle, Clock, Trash2, Pencil, LayoutTemplate, Search, Activity } from "lucide-react";
import { toast } from "sonner";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const INK = "#1A1917";
const MUTE = "#6B7280";
const BORDER = "#E5E2DC";
const MINT = "#00C9A0";

async function apiFetch(path: string, opts: { method?: string; body?: any } = {}) {
  const { body, ...rest } = opts;
  const r = await fetch(`${API}${path}`, {
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    ...rest,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const money = (n: any) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string; icon: any }> = {
  draft:    { bg: "#F3F4F6", fg: "#6B7280", label: "Draft",    icon: FileText },
  sent:     { bg: "#EFF6FF", fg: "#1D4ED8", label: "Sent",     icon: Send },
  viewed:   { bg: "#FEF3C7", fg: "#92400E", label: "Viewed",   icon: Clock },
  accepted: { bg: "#ECFDF5", fg: "#047857", label: "Accepted", icon: CheckCircle },
  declined: { bg: "#FEF2F2", fg: "#991B1B", label: "Declined", icon: Trash2 },
  expired:  { bg: "#F3F4F6", fg: "#6B7280", label: "Expired",  icon: Clock },
};

function StatusChip({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.draft;
  const Icon = s.icon;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, background: s.bg, color: s.fg, fontSize: 12, fontWeight: 700 }}>
      <Icon size={12} /> {s.label}
    </span>
  );
}

export default function EstimatesPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"estimates" | "templates" | "ghl">("estimates");
  const [ghlSent, setGhlSent] = useState("");
  const [ghlOutcome, setGhlOutcome] = useState("");
  const [ghlLoaded, setGhlLoaded] = useState(false);

  const { data: statsData } = useQuery({ queryKey: ["estimate-stats"], queryFn: () => apiFetch("/api/estimates/stats") });
  const { data: listData, isLoading } = useQuery({
    queryKey: ["estimates", search],
    queryFn: () => apiFetch(`/api/estimates${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });
  const { data: templatesData } = useQuery({ queryKey: ["estimate-templates"], queryFn: () => apiFetch("/api/estimates/templates") });

  const estimates: any[] = listData?.data ?? [];
  const templates: any[] = templatesData?.data ?? [];
  const stats = statsData ?? {};

  const del = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/estimates/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["estimates"] }); qc.invalidateQueries({ queryKey: ["estimate-stats"] }); toast.success("Estimate deleted"); },
    onError: () => toast.error("Failed to delete"),
  });
  const delTemplate = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/estimates/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["estimate-templates"] }); toast.success("Template deleted"); },
    onError: () => toast.error("Failed to delete template"),
  });

  // GoHighLevel bridge settings live on the company row.
  const { data: companyData } = useQuery({ queryKey: ["company-me"], queryFn: () => apiFetch("/api/companies/me") });
  if (companyData && !ghlLoaded) {
    setGhlSent(companyData.ghl_estimate_sent_webhook || "");
    setGhlOutcome(companyData.ghl_estimate_outcome_webhook || "");
    setGhlLoaded(true);
  }
  const saveGhl = useMutation({
    mutationFn: () => apiFetch("/api/companies/me", {
      method: "PATCH",
      body: { ghl_estimate_sent_webhook: ghlSent.trim(), ghl_estimate_outcome_webhook: ghlOutcome.trim() },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["company-me"] }); toast.success("GoHighLevel settings saved"); },
    onError: () => toast.error("Failed to save settings"),
  });

  const statCards = [
    { label: "Outstanding", value: stats.outstanding ?? 0, sub: "sent / viewed" },
    { label: "Accepted", value: stats.accepted ?? 0, sub: "all time" },
    { label: "Won this month", value: money(stats.accepted_value_month), sub: "accepted value" },
    { label: "Drafts", value: stats.draft ?? 0, sub: "not yet sent" },
  ];

  return (
    <DashboardLayout>
      <div style={{ fontFamily: FF, maxWidth: 1100, margin: "0 auto", padding: "8px 4px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: INK, margin: 0 }}>Estimates</h1>
            <p style={{ fontSize: 13, color: MUTE, margin: "4px 0 0" }}>Build, send, and track commercial &amp; common-area estimates.</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => navigate("/estimates/engagement")}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#fff", color: INK, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
              <Activity size={16} /> Engagement
            </button>
            <button onClick={() => navigate("/estimates/new")}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, background: INK, color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
              <Plus size={16} /> New Estimate
            </button>
          </div>
        </div>

        {/* Stat strip */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, margin: "18px 0" }}>
          {statCards.map(c => (
            <div key={c.label} style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px 16px" }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 6px" }}>{c.label}</p>
              <p style={{ fontSize: 24, fontWeight: 800, color: INK, margin: 0, lineHeight: 1 }}>{c.value}</p>
              <p style={{ fontSize: 11, color: MUTE, margin: "5px 0 0" }}>{c.sub}</p>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 6, borderBottom: `1px solid ${BORDER}`, marginBottom: 16 }}>
          {([["estimates", "Estimates"], ["templates", "Templates"], ["ghl", "GoHighLevel"]] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              style={{ background: "none", border: "none", borderBottom: tab === key ? `2px solid ${INK}` : "2px solid transparent", color: tab === key ? INK : MUTE, fontWeight: 700, fontSize: 14, padding: "8px 12px", cursor: "pointer", fontFamily: FF, marginBottom: -1 }}>
              {label}
            </button>
          ))}
        </div>

        {tab === "estimates" ? (
          <>
            <div style={{ position: "relative", maxWidth: 340, marginBottom: 14 }}>
              <Search size={15} style={{ position: "absolute", left: 11, top: 11, color: MUTE }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search estimates…"
                style={{ width: "100%", padding: "9px 12px 9px 32px", border: `1px solid ${BORDER}`, borderRadius: 9, fontSize: 14, fontFamily: FF, background: "#fff", boxSizing: "border-box" }} />
            </div>

            <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
              {isLoading ? (
                <div style={{ padding: 40, textAlign: "center", color: MUTE, fontSize: 14 }}>Loading…</div>
              ) : estimates.length === 0 ? (
                <div style={{ padding: "48px 20px", textAlign: "center" }}>
                  <FileText size={28} style={{ color: "#C9C6BF", margin: "0 auto 10px" }} />
                  <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: "0 0 4px" }}>No estimates yet</p>
                  <p style={{ fontSize: 13, color: MUTE, margin: "0 0 16px" }}>Create your first commercial estimate.</p>
                  <button onClick={() => navigate("/estimates/new")} style={{ background: MINT, color: "#063", border: "none", borderRadius: 9, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>New Estimate</button>
                </div>
              ) : (
                estimates.map((e, i) => {
                  const recipient = e.recipient || e.account_name || e.contact_name || "Untitled";
                  return (
                    <div key={e.id} onClick={() => navigate(`/estimates/${e.id}`)}
                      style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderTop: i === 0 ? "none" : `1px solid ${BORDER}`, cursor: "pointer" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: INK, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{recipient}</span>
                          <StatusChip status={e.status} />
                        </div>
                        <p style={{ fontSize: 12, color: MUTE, margin: "3px 0 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {e.estimate_number || "—"}{e.title ? ` · ${e.title}` : ""}{e.service_address ? ` · ${e.service_address}` : ""}
                        </p>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <p style={{ fontSize: 15, fontWeight: 800, color: INK, margin: 0 }}>{money(e.total)}</p>
                        <p style={{ fontSize: 11, color: MUTE, margin: "2px 0 0" }}>{e.created_at ? new Date(e.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}</p>
                      </div>
                      <div style={{ display: "flex", gap: 4 }} onClick={ev => ev.stopPropagation()}>
                        <button title="Edit" onClick={() => navigate(`/estimates/${e.id}`)} style={iconBtn}><Pencil size={15} /></button>
                        <button title="Delete" onClick={() => { if (confirm("Delete this estimate?")) del.mutate(e.id); }} style={iconBtn}><Trash2 size={15} /></button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : tab === "ghl" ? (
          <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, padding: "20px 22px", maxWidth: 640 }}>
            <p style={{ fontSize: 15, fontWeight: 800, color: INK, margin: "0 0 4px" }}>GoHighLevel follow-up bridge</p>
            <p style={{ fontSize: 13, color: MUTE, margin: "0 0 16px", lineHeight: 1.6 }}>
              When you send an estimate, Qleno pushes the contact + estimate link to your GHL workflow so GHL runs the
              SMS follow-up drip from your office line. When the customer accepts (or declines), Qleno fires the second
              webhook so GHL stops the drip. Build the two workflows once in GHL (Inbound Webhook trigger), then paste
              their webhook URLs here. Setup guide: <code style={{ fontSize: 12 }}>docs/GHL_ESTIMATE_BRIDGE.md</code>.
            </p>
            <label style={{ display: "block", marginBottom: 14 }}>
              <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>
                "Estimate sent" webhook URL — starts the drip
              </span>
              <input value={ghlSent} onChange={e => setGhlSent(e.target.value)} placeholder="https://services.leadconnectorhq.com/hooks/…"
                style={{ width: "100%", padding: "9px 11px", border: `1px solid ${BORDER}`, borderRadius: 9, fontSize: 13, fontFamily: FF, boxSizing: "border-box" }} />
            </label>
            <label style={{ display: "block", marginBottom: 16 }}>
              <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>
                "Outcome" webhook URL — stops the drip on accept / decline
              </span>
              <input value={ghlOutcome} onChange={e => setGhlOutcome(e.target.value)} placeholder="https://services.leadconnectorhq.com/hooks/…"
                style={{ width: "100%", padding: "9px 11px", border: `1px solid ${BORDER}`, borderRadius: 9, fontSize: 13, fontFamily: FF, boxSizing: "border-box" }} />
            </label>
            <button onClick={() => saveGhl.mutate()} disabled={saveGhl.isPending}
              style={{ background: INK, color: "#fff", border: "none", borderRadius: 9, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>
              {saveGhl.isPending ? "Saving…" : "Save settings"}
            </button>
            <div style={{ background: "#F7F6F3", borderRadius: 10, padding: "12px 14px", marginTop: 18 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: MUTE, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 6px" }}>Payload fields you can map in GHL</p>
              <p style={{ fontSize: 12, color: "#4B5563", margin: 0, lineHeight: 1.7, fontFamily: "monospace" }}>
                event · contact_name · contact_email · contact_phone · property_name · service_address · total ·
                estimate_link · estimate_number · title · valid_until · accepted_name
              </p>
            </div>
          </div>
        ) : (
          <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
            {templates.length === 0 ? (
              <div style={{ padding: "48px 20px", textAlign: "center" }}>
                <LayoutTemplate size={28} style={{ color: "#C9C6BF", margin: "0 auto 10px" }} />
                <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: "0 0 4px" }}>No templates yet</p>
                <p style={{ fontSize: 13, color: MUTE, margin: 0 }}>Build an estimate, then "Save as template" to reuse it on your next walkthrough.</p>
              </div>
            ) : (
              templates.map((t, i) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderTop: i === 0 ? "none" : `1px solid ${BORDER}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 700, color: INK, margin: 0 }}>{t.name}</p>
                    <p style={{ fontSize: 12, color: MUTE, margin: "3px 0 0" }}>{t.item_count} line item{t.item_count === 1 ? "" : "s"}{t.title ? ` · ${t.title}` : ""}</p>
                  </div>
                  <button onClick={() => navigate(`/estimates/new?template=${t.id}`)}
                    style={{ background: MINT, color: "#063", border: "none", borderRadius: 9, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FF }}>Use template</button>
                  <button title="Delete" onClick={() => { if (confirm("Delete this template?")) delTemplate.mutate(t.id); }} style={iconBtn}><Trash2 size={15} /></button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

const iconBtn: React.CSSProperties = {
  width: 32, height: 32, display: "inline-flex", alignItems: "center", justifyContent: "center",
  background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 8, color: MUTE, cursor: "pointer",
};
