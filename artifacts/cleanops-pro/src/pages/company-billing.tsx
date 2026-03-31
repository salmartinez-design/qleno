import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { CreditCard, CheckCircle, AlertCircle, Clock, TrendingUp, Users, X } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const card: React.CSSProperties = { backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", padding: "24px" };
const label: React.CSSProperties = { fontSize: "11px", fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" };

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: any }> = {
  trialing:  { label: "Trial", bg: "#FEF3C7", text: "#92400E", icon: Clock },
  active:    { label: "Active", bg: "#D1FAE5", text: "#065F46", icon: CheckCircle },
  past_due:  { label: "Past Due", bg: "#FEE2E2", text: "#991B1B", icon: AlertCircle },
  canceled:  { label: "Canceled", bg: "#F3F4F6", text: "#6B7280", icon: X },
};

export default function CompanyBillingPage() {
  const qc = useQueryClient();
  const [showCancel, setShowCancel] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState("starter");
  const [billingEmail, setBillingEmail] = useState("");

  const { data: billing, isLoading } = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => apiFetch("/api/billing/status"),
  });

  const startTrialMut = useMutation({
    mutationFn: (d: any) => apiFetch("/api/billing/create-subscription", { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["billing-status"] }); setShowPlanModal(false); },
  });

  const cancelMut = useMutation({
    mutationFn: () => apiFetch("/api/billing/cancel-subscription", { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["billing-status"] }); setShowCancel(false); },
  });

  const status = billing?.subscription_status || "trialing";
  const sc = STATUS_CONFIG[status] || STATUS_CONFIG.trialing;
  const StatusIcon = sc.icon;

  const plans = [
    { id: "solo",  name: "Solo",  price: "$100/mo", desc: "1 user — owner only",           features: ["Unlimited clients", "Scheduling & dispatch", "Invoicing", "Online booking widget", "SMS notifications", "Client portal"] },
    { id: "team",  name: "Team",  price: "$200/mo", desc: "Up to 10 technicians",           features: ["Everything in Solo", "Employee management", "Payroll & timeclock", "GPS geofencing", "Dispatch board", "Priority support"] },
    { id: "pro",   name: "Pro",   price: "$250/mo", desc: "Up to 20 technicians + $5/tech above 20", features: ["Everything in Team", "Advanced reporting", "Churn scoring", "Revenue goals", "API access"] },
  ];

  if (isLoading) {
    return (
      <DashboardLayout>
        <div style={{ padding: "28px 32px", textAlign: "center", color: "#9E9B94", paddingTop: "80px" }}>Loading billing status...</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div style={{ padding: "28px 32px", maxWidth: "900px", margin: "0 auto" }}>
        <div style={{ marginBottom: "28px" }}>
          <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#1A1917", margin: 0 }}>Subscription & Billing</h1>
          <div style={{ fontSize: "13px", color: "#6B7280", marginTop: "4px" }}>Manage your Qleno subscription</div>
        </div>

        {/* Current plan */}
        <div style={{ ...card, marginBottom: "20px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "20px" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                <div style={{ fontSize: "18px", fontWeight: 800, color: "#1A1917" }}>{billing?.plan_label || "Starter"} Plan</div>
                <div style={{ backgroundColor: sc.bg, color: sc.text, fontSize: "11px", fontWeight: 700, padding: "3px 10px", borderRadius: "999px", display: "flex", alignItems: "center", gap: "4px" }}>
                  <StatusIcon size={10} /> {sc.label.toUpperCase()}
                </div>
              </div>
              <div style={{ fontSize: "28px", fontWeight: 800, color: "var(--brand)" }}>
                ${billing?.monthly_total || 100}<span style={{ fontSize: "14px", fontWeight: 500, color: "#6B7280" }}>/month</span>
              </div>
            </div>
            <button onClick={() => setShowPlanModal(true)} style={{ backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: "8px", padding: "10px 18px", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}>
              Change Plan
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
            <div style={{ padding: "14px", backgroundColor: "#F7F6F3", borderRadius: "8px" }}>
              <div style={label}>Subscription Status</div>
              <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917", textTransform: "capitalize" }}>{status.replace("_", " ")}</div>
            </div>
            <div style={{ padding: "14px", backgroundColor: "#F7F6F3", borderRadius: "8px" }}>
              <div style={label}>Employee Count</div>
              <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>{billing?.employee_count || 0} employees</div>
            </div>
            <div style={{ padding: "14px", backgroundColor: "#F7F6F3", borderRadius: "8px" }}>
              <div style={label}>Stripe Customer ID</div>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "#1A1917", fontFamily: "monospace", wordBreak: "break-all" }}>{billing?.stripe_customer_id || "Not connected"}</div>
            </div>
          </div>
        </div>

        {/* Payment method card */}
        <div style={{ ...card, marginBottom: "20px" }}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917", marginBottom: "16px" }}>Payment Method</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ width: "44px", height: "32px", backgroundColor: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <CreditCard size={18} style={{ color: "#9E9B94" }} />
              </div>
              <div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>
                  {billing?.stripe_customer_id ? "Card on file" : "No payment method"}
                </div>
                <div style={{ fontSize: "12px", color: "#9E9B94" }}>
                  {billing?.stripe_customer_id ? "Connect Stripe to manage payment methods" : "Add a payment method to activate your subscription after trial"}
                </div>
              </div>
            </div>
            <button style={{ backgroundColor: "#F7F6F3", color: "#1A1917", border: "1px solid #E5E2DC", borderRadius: "6px", padding: "8px 14px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              Update Payment
            </button>
          </div>
        </div>

        {/* Pricing breakdown */}
        <div style={{ ...card, marginBottom: "20px" }}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917", marginBottom: "16px" }}>Pricing Breakdown</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #F0EDE8" }}>
              <div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>Base Plan ({billing?.plan_label || "Team"})</div>
                <div style={{ fontSize: "12px", color: "#6B7280" }}>Qleno starts at $100/mo for solo operators, $200/mo for teams up to 10, and $250/mo for up to 20 technicians</div>
              </div>
              <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>${billing?.monthly_total || 200}.00</div>
            </div>
            {(billing?.employee_count || 0) > 20 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #F0EDE8" }}>
                <div>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#1A1917" }}>Additional Technicians</div>
                  <div style={{ fontSize: "12px", color: "#6B7280" }}>{(billing.employee_count - 20)} over 20 × $5.00/mo</div>
                </div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917" }}>${((billing.employee_count - 20) * 5).toFixed(2)}</div>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
              <div style={{ fontSize: "14px", fontWeight: 800, color: "#1A1917" }}>Monthly Total</div>
              <div style={{ fontSize: "20px", fontWeight: 800, color: "var(--brand)" }}>${billing?.monthly_total || 100}.00</div>
            </div>
          </div>
        </div>

        {/* Trial info */}
        {status === "trialing" && (
          <div style={{ ...card, borderLeft: "3px solid #F59E0B", marginBottom: "20px", display: "flex", alignItems: "flex-start", gap: "12px" }}>
            <Clock size={20} style={{ color: "#F59E0B", marginTop: "2px", flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: "14px", fontWeight: 700, color: "#1A1917", marginBottom: "4px" }}>You are on a free trial</div>
              <div style={{ fontSize: "13px", color: "#6B7280" }}>Your trial gives you full access to all features. Add a payment method before your trial ends to continue uninterrupted service.</div>
            </div>
          </div>
        )}

        {/* Danger zone */}
        <div style={{ ...card, borderColor: "#FECACA" }}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#991B1B", marginBottom: "8px" }}>Cancel Subscription</div>
          <div style={{ fontSize: "13px", color: "#6B7280", marginBottom: "16px" }}>
            Cancelling will keep your access active until the end of your current billing period. Your data will be retained for 90 days.
          </div>
          {showCancel ? (
            <div style={{ backgroundColor: "#FEF2F2", border: "1px solid #FECACA", borderRadius: "8px", padding: "16px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#991B1B", marginBottom: "8px" }}>Are you sure you want to cancel?</div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button onClick={() => setShowCancel(false)} style={{ backgroundColor: "#F3F4F6", color: "#6B7280", border: "none", borderRadius: "6px", padding: "8px 14px", fontSize: "13px", cursor: "pointer" }}>Keep Subscription</button>
                <button onClick={() => cancelMut.mutate()} disabled={cancelMut.isPending} style={{ backgroundColor: "#DC2626", color: "#FFFFFF", border: "none", borderRadius: "6px", padding: "8px 14px", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}>
                  {cancelMut.isPending ? "Cancelling..." : "Yes, Cancel Subscription"}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowCancel(true)} style={{ backgroundColor: "transparent", color: "#991B1B", border: "1px solid #FECACA", borderRadius: "6px", padding: "8px 14px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              Cancel Subscription
            </button>
          )}
        </div>

        {/* Plan selection modal */}
        {showPlanModal && (
          <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
            <div style={{ backgroundColor: "#FFFFFF", borderRadius: "16px", padding: "32px", maxWidth: "640px", width: "100%" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "24px" }}>
                <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 800, color: "#1A1917" }}>Choose Your Plan</h2>
                <button onClick={() => setShowPlanModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9E9B94" }}><X size={20} /></button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginBottom: "24px" }}>
                {plans.map(p => (
                  <div key={p.id} onClick={() => setSelectedPlan(p.id)} style={{ border: `2px solid ${selectedPlan === p.id ? "var(--brand)" : "#E5E2DC"}`, borderRadius: "10px", padding: "20px", cursor: "pointer", backgroundColor: selectedPlan === p.id ? "#EFF6FF" : "#FFFFFF", transition: "all 0.15s" }}>
                    <div style={{ fontSize: "16px", fontWeight: 800, color: "#1A1917", marginBottom: "4px" }}>{p.name}</div>
                    <div style={{ fontSize: "18px", fontWeight: 700, color: "var(--brand)", marginBottom: "4px" }}>{p.price}</div>
                    <div style={{ fontSize: "12px", color: "#6B7280", marginBottom: "12px" }}>{p.desc}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {p.features.map(f => (
                        <div key={f} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#1A1917" }}>
                          <CheckCircle size={12} style={{ color: "#16A34A", flexShrink: 0 }} /> {f}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginBottom: "16px" }}>
                <div style={label}>Billing Email</div>
                <input value={billingEmail} onChange={e => setBillingEmail(e.target.value)} placeholder="billing@yourcompany.com" style={{ width: "100%", padding: "8px 12px", border: "1px solid #E5E2DC", borderRadius: "6px", fontSize: "13px", fontFamily: "inherit", boxSizing: "border-box" }} />
              </div>
              <div style={{ backgroundColor: "#F7F6F3", borderRadius: "8px", padding: "12px 16px", marginBottom: "16px", fontSize: "12px", color: "#6B7280" }}>
                First month free — no credit card required to start. Add a payment method before your trial ends.
              </div>
              <button onClick={() => startTrialMut.mutate({ plan: selectedPlan, billing_email: billingEmail })} disabled={startTrialMut.isPending} style={{ width: "100%", backgroundColor: "var(--brand)", color: "#FFFFFF", border: "none", borderRadius: "8px", padding: "12px", fontSize: "14px", fontWeight: 700, cursor: "pointer" }}>
                {startTrialMut.isPending ? "Activating..." : "Start Free Trial"}
              </button>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
