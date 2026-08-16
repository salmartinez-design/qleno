// [ai-access 2026-08-15] Settings → Integrations → AI & API Access.
//
// This screen is the whole feature from the tenant's side. Phases 1-3 built a
// credential spine, a versioned read API, and an MCP server; none of it is
// reachable by a customer until someone can mint a key without asking us to run
// SQL. That makes the copy here load-bearing rather than decorative: the person
// reading it is about to hand an AI assistant standing access to their
// customers, their payroll, and their revenue, and the screen has to make the
// blast radius obvious BEFORE the key exists, not after.
//
// Three deliberate choices:
//   1. The token is shown once, in a panel that will not go away on a stray
//      click. Losing it means rotating, which is survivable but confusing.
//   2. Write scopes are listed but not selectable. They exist in the catalog
//      and will be real in Phase 5; hiding them entirely would make the arrival
//      of write access a surprise, and enabling them today would mint a key
//      carrying a permission nothing honors.
//   3. Turning access OFF is never gated. See the matching asymmetry on
//      PUT /api/api-keys/access.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Key, Copy, Check, AlertTriangle, X, RefreshCw, Activity, Plus } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...getAuthHeaders(), "Content-Type": "application/json", ...opts.headers },
  });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(body?.message || body?.error || "Request failed");
  return body;
}

// ── Types ────────────────────────────────────────────────────────────────────

type Status = {
  enabled: boolean;
  plan: string | null;
  plan_qualifies: boolean;
  can_manage: boolean;
  usage_this_month: { requests: number; errors: number; since: string };
};

type ApiKeyRow = {
  id: number;
  key_id: string;
  masked: string;
  name: string;
  scopes: string[];
  owner_name: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

type ActivityRow = {
  route: string; method: string; status: number;
  duration_ms: number | null; ip: string | null; created_at: string;
};

type Minted = { token: string; name: string; warning: string; rotated?: boolean };

// What each scope actually lets an assistant see, in the words of someone who
// runs the business rather than the words of the endpoint it maps to.
const SCOPE_COPY: Record<string, { label: string; detail: string }> = {
  "jobs:read": { label: "Jobs & schedule", detail: "Visits, times, who is assigned, job totals" },
  "clients:read": { label: "Customers", detail: "Names, addresses, phone and email" },
  "invoices:read": { label: "Invoices", detail: "Amounts, status, what is still owed" },
  "payroll:read": { label: "Payroll", detail: "Named people's pay, hours, and commission" },
  "reports:read": { label: "Reports", detail: "Revenue, KPIs, efficiency" },
  "jobs:write": { label: "Change jobs", detail: "Create, reschedule, assign" },
  "clients:write": { label: "Change customers", detail: "Edit customer records" },
  "invoices:write": { label: "Change invoices", detail: "Create and edit invoices" },
  "comms:send": { label: "Message customers", detail: "Send real texts and emails" },
  "payments:charge": { label: "Charge cards", detail: "Move real money" },
};

// ── Shared styles (matching the other settings tabs) ─────────────────────────

const card: React.CSSProperties = {
  background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 12, padding: 20,
};
const h2: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 15, fontWeight: 700,
  color: "#1A1917", margin: 0,
};
const sub: React.CSSProperties = {
  fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 12.5, fontWeight: 300,
  color: "#6B6860", marginTop: 4, lineHeight: 1.5,
};
const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#9E9B94",
  textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5,
  fontFamily: "'Plus Jakarta Sans', sans-serif",
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", border: "1px solid #E5E2DC", borderRadius: 8,
  fontSize: 13, fontFamily: "'Plus Jakarta Sans', sans-serif",
  boxSizing: "border-box", background: "#fff", color: "#1A1917",
};
const btnPrimary: React.CSSProperties = {
  padding: "9px 18px", background: "var(--brand)", color: "#fff", border: "none",
  borderRadius: 8, fontWeight: 600, fontSize: 13,
  fontFamily: "'Plus Jakarta Sans', sans-serif", cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  padding: "8px 14px", background: "#F7F6F3", color: "#1A1917", border: "1px solid #E5E2DC",
  borderRadius: 8, fontWeight: 600, fontSize: 12.5,
  fontFamily: "'Plus Jakarta Sans', sans-serif", cursor: "pointer",
};
const mono: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5,
};

function when(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── Copy-to-clipboard ────────────────────────────────────────────────────────

function CopyButton({ value, children }: { value: string; children?: React.ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        window.setTimeout(() => setDone(false), 1800);
      }}
      style={{ ...btnSecondary, display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      {done ? <Check size={13} color="#0F7A63" /> : <Copy size={13} />}
      {done ? "Copied" : children ?? "Copy"}
    </button>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────

export function AiAccessTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [openActivity, setOpenActivity] = useState<number | null>(null);

  const status = useQuery<Status>({
    queryKey: ["api-keys", "status"],
    queryFn: () => apiFetch("/api/api-keys/status"),
  });

  const canManage = !!status.data?.can_manage;

  const keys = useQuery<ApiKeyRow[]>({
    queryKey: ["api-keys", "list"],
    queryFn: () => apiFetch("/api/api-keys"),
    enabled: canManage,
  });

  const toggleAccess = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch("/api/api-keys/access", { method: "PUT", body: JSON.stringify({ enabled }) }),
    onSuccess: (_d, enabled) => {
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      toast({
        title: enabled ? "AI and API access is on" : "AI and API access is off",
        description: enabled
          ? "Keys you create can now reach your data."
          : "Every key stopped working. Nothing was deleted — turning this back on restores them.",
      });
    },
    onError: (e: Error) => toast({ title: "Could not change access", description: e.message, variant: "destructive" }),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-keys", "list"] });
      toast({ title: "Key revoked", description: "It stopped working immediately." });
    },
    onError: (e: Error) => toast({ title: "Could not revoke", description: e.message, variant: "destructive" }),
  });

  const rotate = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/api-keys/${id}/rotate`, { method: "POST" }),
    onSuccess: (d: any) => {
      qc.invalidateQueries({ queryKey: ["api-keys", "list"] });
      setMinted({ token: d.token, name: d.name, warning: d.warning, rotated: true });
    },
    onError: (e: Error) => toast({ title: "Could not rotate", description: e.message, variant: "destructive" }),
  });

  if (status.isLoading) {
    return <div style={{ ...sub, padding: 24 }}>Loading…</div>;
  }

  // A failed status call must not be dressed up as a permission answer. The
  // "only an owner or admin" copy below is a real statement about this user's
  // role; showing it when we simply could not reach the server would send
  // someone to ask their boss for access they already have.
  if (status.isError) {
    return (
      <div style={card}>
        <h2 style={h2}>AI &amp; API Access</h2>
        <p style={sub}>
          Could not load this page. {(status.error as Error)?.message ?? ""} Refresh to try again.
        </p>
      </div>
    );
  }

  // Office and technician accounts land here. Say why rather than showing an
  // empty screen they will read as broken.
  if (!canManage) {
    return (
      <div style={card}>
        <h2 style={h2}>AI &amp; API Access</h2>
        <p style={sub}>
          Only an owner or admin can create or remove API keys. If you need one for an assistant,
          ask an owner to make it for you — they can point the key at your account so its access
          matches yours.
        </p>
      </div>
    );
  }

  const s = status.data!;
  const live = (keys.data ?? []).filter((k) => !k.revoked_at);
  const revoked = (keys.data ?? []).filter((k) => k.revoked_at);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── What this is ─────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
          <div style={{ maxWidth: 620 }}>
            <h2 style={h2}>AI &amp; API Access</h2>
            <p style={sub}>
              Connect Claude, ChatGPT, or Gemini to your Qleno data and ask questions in plain
              English — who is unassigned tomorrow, what a customer has been billed, how a cleaner
              is tracking against budget. The same key also works as a standard API for
              dashboards and other software.
            </p>
            <p style={{ ...sub, marginTop: 8 }}>
              Assistants can <strong style={{ fontWeight: 600, color: "#1A1917" }}>read</strong> your
              data. They cannot change a job, edit a price, or message a customer.
            </p>
          </div>

          <div style={{ minWidth: 210 }}>
            <span style={label}>Access</span>
            {s.enabled ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, color: "#0F7A63", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#00C9A0" }} />
                  On
                </span>
                <button
                  type="button"
                  onClick={() => toggleAccess.mutate(false)}
                  disabled={toggleAccess.isPending}
                  style={{ ...btnSecondary, borderColor: "#E6C9C4", color: "#8C2F22" }}
                >
                  Turn off for everyone
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, color: "#6B6860", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#C9C5BD" }} />
                  Off
                </span>
                {s.plan_qualifies ? (
                  <button type="button" onClick={() => toggleAccess.mutate(true)} disabled={toggleAccess.isPending} style={btnPrimary}>
                    Turn on
                  </button>
                ) : (
                  <span style={{ ...sub, marginTop: 0 }}>Available on the Pro plan.</span>
                )}
              </div>
            )}
          </div>
        </div>

        {s.enabled && (
          <div style={{ display: "flex", gap: 28, marginTop: 18, paddingTop: 16, borderTop: "1px solid #E5E2DC", flexWrap: "wrap" }}>
            <div>
              <span style={label}>Requests this month</span>
              <span style={{ fontSize: 20, fontWeight: 700, color: "#1A1917", fontFamily: "'Plus Jakarta Sans', sans-serif", fontVariantNumeric: "tabular-nums" }}>
                {s.usage_this_month.requests.toLocaleString()}
              </span>
            </div>
            <div>
              <span style={label}>Refused or errored</span>
              <span style={{ fontSize: 20, fontWeight: 700, color: s.usage_this_month.errors > 0 ? "#BA7517" : "#1A1917", fontFamily: "'Plus Jakarta Sans', sans-serif", fontVariantNumeric: "tabular-nums" }}>
                {s.usage_this_month.errors.toLocaleString()}
              </span>
            </div>
            <div style={{ ...sub, marginTop: 0, alignSelf: "center", maxWidth: 320 }}>
              Usage is counted so you can see what your assistants are doing. It is not billed.
            </div>
          </div>
        )}
      </div>

      {/* ── The one-time token ───────────────────────────────────────────── */}
      {minted && (
        <div style={{ ...card, borderColor: "#00C9A0", background: "#F3FCF9" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <AlertTriangle size={16} color="#0F7A63" style={{ marginTop: 2, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={h2}>{minted.rotated ? "New key for" : "Key created —"} {minted.name}</h2>
              <p style={{ ...sub, color: "#1A1917" }}>{minted.warning}</p>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
                <code style={{ ...mono, flex: 1, minWidth: 260, background: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: 8, padding: "10px 12px", overflowX: "auto", whiteSpace: "nowrap", color: "#1A1917" }}>
                  {minted.token}
                </code>
                <CopyButton value={minted.token}>Copy key</CopyButton>
              </div>
              <button type="button" onClick={() => setMinted(null)} style={{ ...btnSecondary, marginTop: 12 }}>
                I have saved it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Keys ─────────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 style={h2}>Keys</h2>
            <p style={sub}>A key sees exactly what the person it belongs to can see, and never more.</p>
          </div>
          <button type="button" onClick={() => setCreating(true)} style={{ ...btnPrimary, display: "inline-flex", alignItems: "center", gap: 7 }}>
            <Plus size={14} /> Create key
          </button>
        </div>

        {live.length === 0 && (
          <p style={{ ...sub, marginTop: 16 }}>
            No keys yet. Create one, then paste it into Claude, ChatGPT, or Gemini using the steps below.
          </p>
        )}

        {live.map((k) => (
          <div key={k.id} style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #E5E2DC" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Key size={14} color="#6B6860" />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: "#1A1917", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{k.name}</span>
                  <code style={{ ...mono, color: "#9E9B94" }}>{k.masked}</code>
                </div>
                <div style={{ ...sub, marginTop: 6 }}>
                  Acts as {k.owner_name || "an unnamed user"} · Last used {when(k.last_used_at)}
                  {k.last_used_ip ? ` from ${k.last_used_ip}` : ""}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                  {k.scopes.map((sc) => (
                    <span key={sc} style={{ fontSize: 11, fontWeight: 600, color: "#0F7A63", background: "#EAF9F4", border: "1px solid #CBEDE3", borderRadius: 6, padding: "3px 8px", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                      {SCOPE_COPY[sc]?.label ?? sc}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={() => setOpenActivity(openActivity === k.id ? null : k.id)} style={{ ...btnSecondary, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Activity size={13} /> Activity
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Replace the key for "${k.name}"? You get a new one now; the old one keeps working for 24 hours so you have time to swap it.`)) rotate.mutate(k.id);
                  }}
                  style={{ ...btnSecondary, display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  <RefreshCw size={13} /> Rotate
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Revoke "${k.name}"? It stops working immediately and cannot be brought back. Use this if the key leaked.`)) revoke.mutate(k.id);
                  }}
                  style={{ ...btnSecondary, borderColor: "#E6C9C4", color: "#8C2F22" }}
                >
                  Revoke
                </button>
              </div>
            </div>
            {openActivity === k.id && <KeyActivity id={k.id} />}
          </div>
        ))}

        {revoked.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid #E5E2DC" }}>
            <span style={label}>Revoked</span>
            {revoked.map((k) => (
              <div key={k.id} style={{ ...sub, marginTop: 4 }}>
                {k.name} · <code style={{ ...mono }}>{k.masked}</code> · revoked {when(k.revoked_at)}
              </div>
            ))}
          </div>
        )}
      </div>

      <ConnectPanel />

      {creating && (
        <CreateKeyModal
          onClose={() => setCreating(false)}
          onCreated={(m) => { setCreating(false); setMinted(m); qc.invalidateQueries({ queryKey: ["api-keys", "list"] }); }}
        />
      )}
    </div>
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────

function KeyActivity({ id }: { id: number }) {
  const q = useQuery<ActivityRow[]>({
    queryKey: ["api-keys", "activity", id],
    queryFn: () => apiFetch(`/api/api-keys/${id}/activity`),
  });

  if (q.isLoading) return <div style={{ ...sub, marginTop: 12 }}>Loading…</div>;
  if (!q.data?.length) return <div style={{ ...sub, marginTop: 12 }}>This key has not been used yet.</div>;

  return (
    <div style={{ marginTop: 12, background: "#F7F6F3", border: "1px solid #E5E2DC", borderRadius: 8, padding: 12, maxHeight: 300, overflowY: "auto" }}>
      {q.data.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", padding: "5px 0", borderBottom: i < q.data!.length - 1 ? "1px solid #E5E2DC" : "none" }}>
          <span style={{ ...mono, color: "#6B6860", minWidth: 118, fontVariantNumeric: "tabular-nums" }}>{when(r.created_at)}</span>
          {/* MCP calls log the TOOL name, not a URL — the whole point of metering
              by tool is that this column reads like something a person asked for. */}
          <span style={{ ...mono, color: "#1A1917", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{r.route}</span>
          <span style={{ ...mono, fontWeight: 600, color: r.status >= 400 ? "#8C2F22" : "#0F7A63" }}>{r.status}</span>
          <span style={{ ...mono, color: "#9E9B94", minWidth: 52, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {r.duration_ms != null ? `${r.duration_ms}ms` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Create ───────────────────────────────────────────────────────────────────

const READ_SCOPES = ["jobs:read", "clients:read", "invoices:read", "reports:read", "payroll:read"];
const WRITE_SCOPES = ["jobs:write", "clients:write", "invoices:write", "comms:send", "payments:charge"];

function CreateKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (m: Minted) => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  // Everything except payroll, on by default. Payroll is the one read scope
  // whose contents are individual people's compensation — granting it should be
  // a decision someone makes, not a box they forgot to clear.
  const [scopes, setScopes] = useState<string[]>(READ_SCOPES.filter((s) => s !== "payroll:read"));

  const create = useMutation({
    mutationFn: () => apiFetch("/api/api-keys", { method: "POST", body: JSON.stringify({ name: name.trim(), scopes }) }),
    onSuccess: (d: any) => onCreated({ token: d.token, name: d.name, warning: d.warning }),
    onError: (e: Error) => toast({ title: "Could not create key", description: e.message, variant: "destructive" }),
  });

  const toggle = (s: string) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 60 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFFFFF", borderRadius: 14, width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto", padding: 24 }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={h2}>Create a key</h2>
            <p style={sub}>The key acts as you. It can never see more than your own account can.</p>
          </div>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
            <X size={18} color="#6B6860" />
          </button>
        </div>

        <div style={{ marginTop: 18 }}>
          <span style={label}>Name</span>
          <input
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sal's Claude"
            autoFocus
          />
          <p style={{ ...sub, marginTop: 6 }}>Name it after where it lives, so you know which one to revoke.</p>
        </div>

        <div style={{ marginTop: 20 }}>
          <span style={label}>What it can see</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {READ_SCOPES.map((s) => {
              const on = scopes.includes(s);
              const sensitive = s === "payroll:read";
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggle(s)}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 10, textAlign: "left",
                    padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                    border: `1px solid ${on ? "#CBEDE3" : "#E5E2DC"}`,
                    background: on ? "#F3FCF9" : "#FFFFFF",
                  }}
                >
                  <span style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, marginTop: 1, border: `1.5px solid ${on ? "#00C9A0" : "#C9C5BD"}`, background: on ? "#00C9A0" : "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {on && <Check size={11} color="#FFFFFF" strokeWidth={3} />}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#1A1917", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                      {SCOPE_COPY[s].label}
                      {sensitive && (
                        <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: "#BA7517", background: "#FDF4E6", border: "1px solid #F0DDBC", borderRadius: 5, padding: "1px 6px", letterSpacing: "0.03em" }}>
                          SENSITIVE
                        </span>
                      )}
                    </span>
                    <span style={{ ...sub, marginTop: 2, display: "block" }}>{SCOPE_COPY[s].detail}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 20 }}>
          <span style={label}>Not available yet</span>
          <div style={{ border: "1px solid #E5E2DC", borderRadius: 8, padding: "10px 12px", background: "#F7F6F3" }}>
            <p style={{ ...sub, marginTop: 0 }}>
              Assistants can only read for now. Making changes — {WRITE_SCOPES.map((s) => SCOPE_COPY[s].label.toLowerCase()).join(", ")} — is
              coming after this has run on real traffic, and will ask you again before it is switched on.
            </p>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
          <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={!name.trim() || scopes.length === 0 || create.isPending}
            style={{ ...btnPrimary, opacity: !name.trim() || scopes.length === 0 || create.isPending ? 0.5 : 1 }}
          >
            {create.isPending ? "Creating…" : "Create key"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Connect ──────────────────────────────────────────────────────────────────

function ConnectPanel() {
  const origin = window.location.origin;
  const mcpUrl = `${origin}/api/mcp`;
  const restUrl = `${origin}/api/v1`;

  return (
    <div style={card}>
      <h2 style={h2}>Connect your assistant</h2>
      <p style={sub}>The same key works everywhere. Paste it as a bearer token.</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        {[
          { label: "For AI assistants (MCP)", url: mcpUrl, note: "Claude, ChatGPT, Gemini" },
          { label: "For software and dashboards (REST)", url: restUrl, note: "Standard JSON over HTTPS" },
        ].map((row) => (
          <div key={row.url} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", border: "1px solid #E5E2DC", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ minWidth: 200 }}>
              <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "#1A1917", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{row.label}</span>
              <span style={{ ...sub, marginTop: 1, display: "block" }}>{row.note}</span>
            </div>
            <code style={{ ...mono, flex: 1, minWidth: 220, color: "#6B6860", overflowX: "auto", whiteSpace: "nowrap" }}>{row.url}</code>
            <CopyButton value={row.url} />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
        {[
          { name: "Claude", steps: "Settings → Connectors → Add custom connector. Paste the MCP address, set the key as a bearer token, then enable it in a chat." },
          { name: "ChatGPT", steps: "Settings → Connectors → Create. Choose an MCP server, paste the MCP address, set the key as a bearer token." },
          { name: "Gemini", steps: "Add the MCP address and key to the mcpServers block in your Gemini CLI settings file, then run /mcp to confirm the Qleno tools loaded." },
        ].map((a) => (
          <div key={a.name} style={{ border: "1px solid #E5E2DC", borderRadius: 8, padding: 12 }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#1A1917", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{a.name}</span>
            <p style={{ ...sub, marginTop: 5 }}>{a.steps}</p>
          </div>
        ))}
      </div>

      <p style={{ ...sub, marginTop: 16 }}>
        Each assistant moves its own menus around. If the steps have drifted, the three things that
        matter are unchanged: the address above, that it speaks MCP over HTTP, and the key as a
        bearer token.
      </p>
    </div>
  );
}
