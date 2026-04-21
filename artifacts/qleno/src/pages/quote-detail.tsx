import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders, useAuthStore } from "@/lib/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Pencil, SendHorizonal, Briefcase, CheckCircle, Trash2, User, MapPin, FileText, ChevronDown, ChevronUp, X, Phone } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

const FF = "'Plus Jakarta Sans', sans-serif";
const API = import.meta.env.BASE_URL.replace(/\/$/, "");

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

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  draft:    { label: "Draft",     color: "#6B7280", bg: "#F3F4F6" },
  sent:     { label: "Sent",      color: "#1D4ED8", bg: "#DBEAFE" },
  viewed:   { label: "Viewed",    color: "#7C3AED", bg: "#EDE9FE" },
  accepted: { label: "Accepted",  color: "#15803D", bg: "#DCFCE7" },
  booked:   { label: "Converted", color: "#5B9BD5", bg: "#EFF6FF" },
  expired:  { label: "Expired",   color: "#DC2626", bg: "#FEE2E2" },
};

function fmt(d?: string | null) {
  if (!d) return null;
  try { return format(new Date(d), "MMM d, yyyy h:mm a"); } catch { return d; }
}

function fmtShort(d?: string | null) {
  if (!d) return null;
  try { return format(new Date(d), "MMM d, yyyy"); } catch { return d; }
}

export default function QuoteDetailPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/quotes/:id");
  const id = params?.id;
  const qc = useQueryClient();
  const isMobile = useIsMobile();

  // Role check
  const token = useAuthStore(s => s.token) ?? "";
  const userRole = (() => { try { return JSON.parse(atob(token.split(".")[1])).role || "office"; } catch { return "office"; } })();
  const isOfficeOrOwner = userRole === "owner" || userRole === "office" || userRole === "admin";

  const [sendSheetOpen, setSendSheetOpen] = useState(false);
  const [sendEmail, setSendEmail] = useState("");
  const [sendPhone, setSendPhone] = useState("");
  const [sendViaEmail, setSendViaEmail] = useState(true);
  const [sendViaSms, setSendViaSms] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [pushJobOpen, setPushJobOpen] = useState(false);
  const [pushJobBusy, setPushJobBusy] = useState(false);

  const { data: quote, isLoading } = useQuery({
    queryKey: ["quote", id],
    queryFn: () => apiFetch(`/api/quotes/${id}`),
    enabled: Boolean(id),
  });

  const sendMutation = useMutation({
    mutationFn: () => apiFetch(`/api/quotes/${id}/send`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Quote sent to client.");
      setSendSheetOpen(false);
      qc.invalidateQueries({ queryKey: ["quote", id] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
    },
    onError: () => toast.error("Failed to send quote"),
  });

  const acceptMutation = useMutation({
    mutationFn: () => apiFetch(`/api/quotes/${id}/accept`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Quote marked as accepted");
      qc.invalidateQueries({ queryKey: ["quote", id] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
    },
    onError: () => toast.error("Failed to mark accepted"),
  });

  const convertMutation = useMutation({
    mutationFn: () => apiFetch(`/api/quotes/${id}/convert`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Quote converted. Go to Jobs to complete setup.");
      qc.invalidateQueries({ queryKey: ["quote", id] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      navigate("/jobs");
    },
    onError: () => toast.error("Failed to convert quote"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`/api/quotes/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Quote deleted"); navigate("/quotes"); },
    onError: () => toast.error("Failed to delete quote"),
  });

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="p-6 max-w-4xl mx-auto">
          <div className="h-8 w-48 bg-[#F0EDE8] rounded animate-pulse mb-4" />
          <div className="h-64 bg-[#F0EDE8] rounded animate-pulse" />
        </div>
      </DashboardLayout>
    );
  }

  if (!quote) {
    return (
      <DashboardLayout>
        <div className="p-6 max-w-4xl mx-auto text-center py-20">
          <p className="text-[#6B7280]">Quote not found.</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate("/quotes")}>Back to Quotes</Button>
        </div>
      </DashboardLayout>
    );
  }

  const statusCfg = STATUS_CONFIG[quote.status] ?? STATUS_CONFIG.draft;
  const clientName = quote.client_name || quote.lead_name || "No client";
  const addons: { name: string; price: number }[] = Array.isArray(quote.addons) ? quote.addons : [];
  const total = parseFloat(quote.total_price || quote.base_price || "0");
  const basePrice = parseFloat(quote.base_price || "0");
  const discountAmt = parseFloat(quote.discount_amount || "0");

  // ── Mobile layout ──────────────────────────────────────────────────────────
  if (isMobile) {
    const inpStyle: React.CSSProperties = {
      width: "100%", boxSizing: "border-box", height: 48, border: "1px solid #E5E2DC", borderRadius: 8,
      fontSize: 16, padding: "0 14px", fontFamily: FF, color: "#1A1917", outline: "none",
    };
    const toggleRow = (label: string, value: boolean, onChange: (v: boolean) => void) => (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 0", borderBottom: "1px solid #F0EEE9" }}>
        <span style={{ fontSize: 14, color: "#1A1917", fontFamily: FF }}>{label}</span>
        <button
          onClick={() => onChange(!value)}
          style={{
            width: 44, height: 26, borderRadius: 13, border: "none", cursor: "pointer",
            background: value ? "var(--brand)" : "#D1D5DB", position: "relative", transition: "background 0.2s",
          }}
        >
          <span style={{
            position: "absolute", top: 3, left: value ? 20 : 3, width: 20, height: 20,
            borderRadius: "50%", background: "#FFF", transition: "left 0.2s",
          }} />
        </button>
      </div>
    );

    return (
      <DashboardLayout>
        <div style={{ background: "#F7F6F3", minHeight: "100vh", fontFamily: FF, paddingBottom: 24 }}>

          {/* Back header */}
          <div style={{ background: "#FFF", borderBottom: "1px solid #E5E2DC", padding: "12px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => navigate("/quotes")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, color: "#6B6860", fontSize: 14, fontFamily: FF, padding: 0 }}>
              <ArrowLeft size={18} /> Quotes
            </button>
          </div>

          <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Header card */}
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Quote #{quote.id}</span>
                <span style={{ fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 12, color: statusCfg.color, background: statusCfg.bg }}>
                  {statusCfg.label}
                </span>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 4 }}>{clientName}</div>
              {quote.address && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                  <MapPin size={13} style={{ color: "#9E9B94", marginTop: 2, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: "#6B6860", fontFamily: FF }}>{quote.address}</span>
                </div>
              )}
              <div style={{ fontSize: 12, color: "#6B6860", fontFamily: FF, marginTop: 6 }}>
                Created {fmtShort(quote.created_at)}
              </div>
            </div>

            {/* Price card */}
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: "20px 16px", textAlign: "center" }}>
              {discountAmt > 0 && (
                <div style={{ fontSize: 14, color: "#9E9B94", textDecoration: "line-through", marginBottom: 2, fontFamily: FF }}>
                  ${(total + discountAmt).toFixed(2)}
                </div>
              )}
              <div style={{ fontSize: 28, fontWeight: 800, color: "#1A1917", fontFamily: FF }}>${total.toFixed(2)}</div>
              <div style={{ fontSize: 13, color: "#6B6860", marginTop: 4, fontFamily: FF }}>
                {quote.scope_name || "—"}{quote.frequency ? ` · ${quote.frequency}` : ""}
              </div>
            </div>

            {/* Line items */}
            <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 13, color: "#6B6860", fontFamily: FF }}>Base Price</span>
                <span style={{ fontSize: 13, color: "#1A1917", fontFamily: FF }}>${basePrice.toFixed(2)}</span>
              </div>
              {addons.map((a, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 13, color: "#6B6860", fontFamily: FF }}>{a.name}</span>
                  <span style={{ fontSize: 13, color: "#1A1917", fontFamily: FF }}>+${a.price.toFixed(2)}</span>
                </div>
              ))}
              {discountAmt > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 13, color: "#16A34A", fontFamily: FF }}>Discount{quote.discount_code ? ` (${quote.discount_code})` : ""}</span>
                  <span style={{ fontSize: 13, color: "#16A34A", fontFamily: FF }}>-${discountAmt.toFixed(2)}</span>
                </div>
              )}
              <div style={{ borderTop: "1px solid #E5E2DC", paddingTop: 10, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Total</span>
                <span style={{ fontSize: 18, fontWeight: 800, color: "#1A1917", fontFamily: FF }}>${total.toFixed(2)}</span>
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(quote.status === "draft" || quote.status === "sent" || quote.status === "viewed") && (
                <button
                  onClick={() => {
                    setSendEmail(quote.client_email || quote.lead_email || "");
                    setSendPhone(quote.client_phone || quote.lead_phone || "");
                    setSendSheetOpen(true);
                  }}
                  style={{ width: "100%", height: 52, background: "var(--brand)", color: "#FFF", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: FF }}
                >
                  Send to Client
                </button>
              )}
              {quote.status === "draft" && (
                <button
                  onClick={() => navigate(`/quotes/${id}/edit`)}
                  style={{ width: "100%", height: 52, background: "#FFF", color: "var(--brand)", border: "2px solid var(--brand)", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                >
                  <Pencil size={16} /> Edit Quote
                </button>
              )}
              {(quote.status === "sent" || quote.status === "viewed") && (
                <button
                  onClick={() => acceptMutation.mutate()}
                  disabled={acceptMutation.isPending}
                  style={{ width: "100%", height: 52, background: "#FFF", color: "#15803D", border: "2px solid #15803D", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                >
                  <CheckCircle size={16} /> Mark as Accepted
                </button>
              )}
              {(quote.status === "accepted" || quote.status === "sent" || quote.status === "viewed") && (
                <button
                  onClick={() => convertMutation.mutate()}
                  disabled={convertMutation.isPending}
                  style={{ width: "100%", height: 52, background: "#FFF", color: "#1A1917", border: "2px solid #1A1917", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: FF, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                >
                  <Briefcase size={16} /> Convert to Job
                </button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button style={{ width: "100%", height: 44, background: "none", border: "none", cursor: "pointer", color: "#DC2626", fontSize: 14, fontWeight: 600, fontFamily: FF }}>
                    Delete Quote
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Quote #{quote.id}?</AlertDialogTitle>
                    <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteMutation.mutate()}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>

            {/* Notes collapsible */}
            {(quote.notes || quote.internal_memo) && (
              <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 10, overflow: "hidden" }}>
                <button
                  onClick={() => setNotesOpen(v => !v)}
                  style={{ width: "100%", padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", cursor: "pointer", fontFamily: FF }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#1A1917" }}>Notes</span>
                  {notesOpen ? <ChevronUp size={16} color="#6B6860" /> : <ChevronDown size={16} color="#6B6860" />}
                </button>
                {notesOpen && (
                  <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                    {quote.notes && (
                      <div>
                        <p style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, fontFamily: FF }}>Client Notes</p>
                        <p style={{ fontSize: 13, color: "#1A1917", fontFamily: FF, whiteSpace: "pre-wrap" }}>{quote.notes}</p>
                      </div>
                    )}
                    {quote.internal_memo && (
                      <div>
                        <p style={{ fontSize: 12, fontWeight: 700, color: "#6B6860", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, fontFamily: FF }}>Internal Notes</p>
                        <p style={{ fontSize: 13, color: "#1A1917", fontFamily: FF, whiteSpace: "pre-wrap" }}>{quote.internal_memo}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Call Notes — office/owner only */}
            {isOfficeOrOwner && quote.call_notes && (
              <div style={{ background: "#FFF", border: "1px solid #E5E2DC", borderRadius: 10, padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <Phone size={14} color="var(--brand)" />
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#1A1917", fontFamily: FF }}>Call Notes</span>
                  </div>
                  {quote.booked_job_id && (
                    <button
                      onClick={() => setPushJobOpen(true)}
                      style={{ fontSize: 11, fontWeight: 600, color: "#1A1917", border: "1px solid #E5E2DC", borderRadius: 6, padding: "5px 10px", background: "#FFF", cursor: "pointer", fontFamily: FF, display: "flex", alignItems: "center", gap: 5 }}
                    >
                      <Briefcase size={11} /> Push to Job
                    </button>
                  )}
                </div>
                <p style={{ fontSize: 13, color: "#6B7280", fontFamily: FF, whiteSpace: "pre-wrap", lineHeight: 1.6, margin: 0 }}>{quote.call_notes}</p>
              </div>
            )}
          </div>
        </div>

        {/* Push to Job — mobile confirmation sheet */}
        {pushJobOpen && (
          <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
            <div onClick={() => !pushJobBusy && setPushJobOpen(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" }} />
            <div style={{ position: "relative", background: "#FFF", borderRadius: "16px 16px 0 0", padding: "24px 20px 44px", zIndex: 1 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: "#D1D5DB", margin: "0 auto 20px" }} />
              <p style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 8 }}>Push Call Notes to Job?</p>
              <p style={{ fontSize: 13, color: "#6B7280", fontFamily: FF, lineHeight: 1.6, marginBottom: 24 }}>
                This will overwrite Office Notes on Job #{quote.booked_job_id}. This cannot be undone.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <button
                  onClick={async () => {
                    if (!quote?.booked_job_id || !quote?.call_notes) return;
                    setPushJobBusy(true);
                    try {
                      await apiFetch(`/api/jobs/${quote.booked_job_id}`, { method: "PUT", body: { office_notes: quote.call_notes } });
                      toast.success("Call notes pushed to job.");
                      setPushJobOpen(false);
                    } catch { toast.error("Failed to push notes."); }
                    finally { setPushJobBusy(false); }
                  }}
                  disabled={pushJobBusy}
                  style={{ width: "100%", height: 52, background: "#1A1917", color: "#FFF", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: FF }}
                >
                  {pushJobBusy ? "Pushing..." : "Yes, Push Notes"}
                </button>
                <button onClick={() => setPushJobOpen(false)} style={{ width: "100%", height: 48, background: "#FFF", color: "#6B7280", border: "1px solid #E5E2DC", borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: FF }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Send to Client — bottom sheet */}
        {sendSheetOpen && (
          <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
            <div onClick={() => setSendSheetOpen(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" }} />
            <div style={{ position: "relative", background: "#FFF", borderRadius: "16px 16px 0 0", padding: 24, paddingBottom: 44, zIndex: 1 }}>
              {/* Handle */}
              <div style={{ width: 36, height: 4, borderRadius: 2, background: "#D1D5DB", margin: "0 auto 20px" }} />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF }}>Send Quote to Client</span>
                <button onClick={() => setSendSheetOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#6B6860" }}>
                  <X size={20} />
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#6B6860", fontFamily: FF, display: "block", marginBottom: 6 }}>Client Email</label>
                  <input value={sendEmail} onChange={e => setSendEmail(e.target.value)} type="email" style={inpStyle} placeholder="client@example.com" />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#6B6860", fontFamily: FF, display: "block", marginBottom: 6 }}>Client Phone</label>
                  <input value={sendPhone} onChange={e => setSendPhone(e.target.value)} type="tel" style={inpStyle} placeholder="(555) 000-0000" />
                </div>

                {toggleRow("Send via Email", sendViaEmail, setSendViaEmail)}
                {toggleRow("Send via SMS", sendViaSms, setSendViaSms)}

                <button
                  onClick={() => sendMutation.mutate()}
                  disabled={sendMutation.isPending}
                  style={{ width: "100%", height: 52, background: "var(--brand)", color: "#FFF", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: FF, marginTop: 8 }}
                >
                  {sendMutation.isPending ? "Sending..." : "Send Now"}
                </button>
              </div>
            </div>
          </div>
        )}
      </DashboardLayout>
    );
  }

  // ── Desktop layout ─────────────────────────────────────────────────────────
  const timelineEvents = [
    { label: "Created",   date: quote.created_at,  always: true },
    { label: "Sent",      date: quote.sent_at,      always: false },
    { label: "Accepted",  date: quote.accepted_at,  always: false },
    { label: "Converted", date: quote.booked_at,    always: false },
    { label: "Expires",   date: quote.expires_at,   always: false, future: true },
  ].filter(e => e.always || e.date);

  return (
    <DashboardLayout>
      <div className="p-6 max-w-4xl mx-auto space-y-5">

        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/quotes")} className="gap-1.5 text-[#6B7280]">
            <ArrowLeft className="w-4 h-4" /> Quotes
          </Button>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold text-[#1A1917]">Quote #{quote.id}</h1>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold" style={{ color: statusCfg.color, backgroundColor: statusCfg.bg }}>
                {statusCfg.label}
              </span>
            </div>
            <p className="text-sm text-[#6B7280]">{clientName} {quote.scope_name ? `· ${quote.scope_name}` : ""}</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            {quote.status === "draft" && (
              <Button size="sm" variant="outline" onClick={() => navigate(`/quotes/${id}/edit`)} className="gap-1.5">
                <Pencil className="w-3.5 h-3.5" /> Edit
              </Button>
            )}
            {(quote.status === "draft" || quote.status === "sent" || quote.status === "viewed") && (
              <Button size="sm" className="gap-1.5 bg-[#5B9BD5] hover:bg-[#4a8ac4] text-white" onClick={() => sendMutation.mutate()} disabled={sendMutation.isPending}>
                <SendHorizonal className="w-3.5 h-3.5" />
                {quote.status === "sent" || quote.status === "viewed" ? "Resend" : "Send Quote"}
              </Button>
            )}
            {(quote.status === "sent" || quote.status === "viewed") && (
              <Button size="sm" variant="outline" className="gap-1.5 border-green-500 text-green-700 hover:bg-green-50" onClick={() => acceptMutation.mutate()} disabled={acceptMutation.isPending}>
                <CheckCircle className="w-3.5 h-3.5" /> Mark Accepted
              </Button>
            )}
            {(quote.status === "accepted" || quote.status === "sent" || quote.status === "viewed") && (
              <Button size="sm" className="gap-1.5 bg-[#1A1917] hover:bg-[#333] text-white" onClick={() => convertMutation.mutate()} disabled={convertMutation.isPending}>
                <Briefcase className="w-3.5 h-3.5" /> Convert to Job
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50">
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Quote #{quote.id}?</AlertDialogTitle>
                  <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteMutation.mutate()}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* Timeline */}
        <div className="bg-white border border-[#E5E2DC] rounded-lg p-5">
          <h2 className="text-sm font-semibold text-[#1A1917] mb-4">Timeline</h2>
          <div className="flex items-center gap-0">
            {timelineEvents.map((ev, i) => (
              <div key={ev.label} className="flex items-center">
                <div className="flex flex-col items-center">
                  <div className="w-2.5 h-2.5 rounded-full border-2" style={{ backgroundColor: ev.date && !ev.future ? "var(--brand)" : "#E5E2DC", borderColor: ev.date && !ev.future ? "var(--brand)" : "#D1D5DB" }} />
                  <div className="text-xs font-medium text-[#6B7280] mt-1 whitespace-nowrap">{ev.label}</div>
                  {ev.date && <div className="text-xs text-[#9E9B94] mt-0.5 whitespace-nowrap">{fmt(ev.date)}</div>}
                </div>
                {i < timelineEvents.length - 1 && <div className="h-0.5 w-16 bg-[#E5E2DC] mx-1 mb-5" />}
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="bg-white border border-[#E5E2DC] rounded-lg p-5 space-y-3">
            <h2 className="text-sm font-semibold text-[#1A1917] flex items-center gap-2"><User className="w-4 h-4 text-[#9E9B94]" /> Client</h2>
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-[#1A1917]">{clientName}</p>
              {(quote.client_email || quote.lead_email) && <p className="text-sm text-[#6B7280]">{quote.client_email || quote.lead_email}</p>}
              {(quote.client_phone || quote.lead_phone) && <p className="text-sm text-[#6B7280]">{quote.client_phone || quote.lead_phone}</p>}
              {quote.address && <div className="flex items-start gap-1.5 pt-1"><MapPin className="w-3.5 h-3.5 text-[#9E9B94] mt-0.5 shrink-0" /><p className="text-sm text-[#6B7280]">{quote.address}</p></div>}
            </div>
          </div>

          <div className="bg-white border border-[#E5E2DC] rounded-lg p-5 space-y-3">
            <h2 className="text-sm font-semibold text-[#1A1917] flex items-center gap-2"><FileText className="w-4 h-4 text-[#9E9B94]" /> Service</h2>
            <div className="space-y-1.5">
              {quote.scope_name && <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Scope</span><span className="text-[#1A1917] font-medium">{quote.scope_name}</span></div>}
              {quote.frequency && <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Frequency</span><span className="text-[#1A1917]">{quote.frequency}</span></div>}
              {quote.sqft && <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Sq Ft</span><span className="text-[#1A1917]">{quote.sqft}</span></div>}
              {quote.bedrooms != null && <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Bedrooms</span><span className="text-[#1A1917]">{quote.bedrooms}bd / {quote.bathrooms ?? 0}ba</span></div>}
              {quote.estimated_hours && <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Est. Hours</span><span className="text-[#1A1917]">{parseFloat(quote.estimated_hours).toFixed(1)}h</span></div>}
            </div>
          </div>
        </div>

        <div className="bg-white border border-[#E5E2DC] rounded-lg p-5">
          <h2 className="text-sm font-semibold text-[#1A1917] mb-4">Pricing</h2>
          <div className="space-y-2">
            {quote.base_price && <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Base Price</span><span className="text-[#1A1917]">${parseFloat(quote.base_price).toFixed(2)}</span></div>}
            {addons.map((a, i) => <div key={i} className="flex justify-between text-sm"><span className="text-[#6B7280]">{a.name}</span><span className="text-[#1A1917]">+${a.price.toFixed(2)}</span></div>)}
            {discountAmt > 0 && <div className="flex justify-between text-sm text-green-600"><span>Discount{quote.discount_code ? ` (${quote.discount_code})` : ""}</span><span>-${discountAmt.toFixed(2)}</span></div>}
            <div className="border-t border-[#E5E2DC] pt-2 flex justify-between items-baseline">
              <span className="text-sm text-[#6B7280]">Total</span>
              <span className="text-2xl font-bold text-[#1A1917]">${total.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {(quote.notes || quote.internal_memo) && (
          <div className="bg-white border border-[#E5E2DC] rounded-lg p-5 space-y-4">
            {quote.notes && <div><p className="text-sm font-semibold text-[#1A1917] mb-1">Client Notes</p><p className="text-sm text-[#6B7280] whitespace-pre-wrap">{quote.notes}</p></div>}
            {quote.internal_memo && <div><p className="text-sm font-semibold text-[#1A1917] mb-1">Internal Memo</p><p className="text-sm text-[#6B7280] whitespace-pre-wrap">{quote.internal_memo}</p></div>}
          </div>
        )}

        {/* Call Notes — office/owner only */}
        {isOfficeOrOwner && quote.call_notes && (
          <div className="bg-white border border-[#E5E2DC] rounded-lg p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-[#1A1917] flex items-center gap-2">
                <Phone className="w-4 h-4" style={{ color: "var(--brand)" }} />
                Call Notes
              </h2>
              {quote.booked_job_id && (
                <Button
                  size="sm" variant="outline"
                  className="gap-1.5 text-xs"
                  onClick={() => setPushJobOpen(true)}
                >
                  <Briefcase className="w-3.5 h-3.5" />
                  Push to Job Notes
                </Button>
              )}
            </div>
            <p className="text-sm text-[#6B7280] whitespace-pre-wrap leading-relaxed">{quote.call_notes}</p>
          </div>
        )}

        {/* Push to Job Notes — confirmation dialog */}
        {pushJobOpen && (
          <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div onClick={() => !pushJobBusy && setPushJobOpen(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)" }} />
            <div style={{ position: "relative", background: "#FFF", borderRadius: 14, padding: 28, maxWidth: 420, width: "90%", zIndex: 1, boxShadow: "0 16px 48px rgba(0,0,0,0.18)" }}>
              <p style={{ fontSize: 16, fontWeight: 700, color: "#1A1917", fontFamily: FF, marginBottom: 10 }}>Push Call Notes to Job?</p>
              <p style={{ fontSize: 14, color: "#6B7280", fontFamily: FF, lineHeight: 1.6, marginBottom: 22 }}>
                This will overwrite the Office Notes on Job #{quote.booked_job_id} with the call notes from this quote. This cannot be undone.
              </p>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button
                  onClick={() => setPushJobOpen(false)}
                  disabled={pushJobBusy}
                  style={{ padding: "9px 18px", borderRadius: 8, border: "1px solid #E5E2DC", background: "#FFF", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: FF }}
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (!quote?.booked_job_id || !quote?.call_notes) return;
                    setPushJobBusy(true);
                    try {
                      await apiFetch(`/api/jobs/${quote.booked_job_id}`, { method: "PUT", body: { office_notes: quote.call_notes } });
                      toast.success("Call notes pushed to job office notes.");
                      setPushJobOpen(false);
                    } catch { toast.error("Failed to push notes."); }
                    finally { setPushJobBusy(false); }
                  }}
                  disabled={pushJobBusy}
                  style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: "#1A1917", color: "#FFF", fontSize: 14, fontWeight: 600, cursor: pushJobBusy ? "not-allowed" : "pointer", fontFamily: FF, opacity: pushJobBusy ? 0.7 : 1 }}
                >
                  {pushJobBusy ? "Pushing..." : "Yes, Push Notes"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

// inline style helper referenced in mobile send sheet
const inpStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", height: 48, border: "1px solid #E5E2DC", borderRadius: 8,
  fontSize: 16, padding: "0 14px", fontFamily: "'Plus Jakarta Sans', sans-serif", color: "#1A1917", outline: "none",
};
