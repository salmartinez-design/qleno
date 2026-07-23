// [notif-prefs] Presentational grid for per-client / per-account customer
// notification preferences. Pure UI — no data fetching — so both the
// react-query customer-profile page and the fetch-based account-detail page can
// reuse it. A toggle is ON by default; `offs` holds the "${trigger}:${channel}"
// keys that are turned OFF.

export type PrefCatalogRow = {
  trigger: string;
  label: string;
  timing: string;
  description: string;
  channels: string[];
};

export type PrefData = {
  catalog: PrefCatalogRow[];
  overrides: Record<string, boolean>;
  scope_type: string;
  managed_by_account?: boolean;
  account_id?: number | null;
};

export function PrefToggle({ on, disabled, onClick }: { on: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-pressed={on}
      style={{
        width: 38, height: 22, borderRadius: 11, border: "none", padding: 0, position: "relative",
        cursor: disabled ? "default" : "pointer", flexShrink: 0,
        background: on ? "var(--brand)" : "#D4D1CB", opacity: disabled ? 0.5 : 1, transition: "background 120ms",
      }}
    >
      <span style={{ position: "absolute", top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: "50%", background: "#FFFFFF", transition: "left 120ms", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }} />
    </button>
  );
}

export function NotificationPreferenceGrid({
  catalog, offs, disabled, onToggle,
}: { catalog: PrefCatalogRow[]; offs: Set<string>; disabled?: boolean; onToggle: (key: string) => void }) {
  return (
    <div style={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E2DC", borderRadius: "10px", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px", padding: "10px 20px", borderBottom: "1px solid #EEECE7", background: "#FAFAF8" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em" }}>Message</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "center" }}>SMS</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#9E9B94", textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "center" }}>Email</span>
      </div>
      {catalog.map((m) => (
        <div key={m.trigger} style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px", alignItems: "center", padding: "14px 20px", borderBottom: "1px solid #F0EEE9" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1917" }}>{m.label}</div>
            <div style={{ fontSize: 11, color: "#9E9B94", marginTop: 2 }}>{m.timing}</div>
          </div>
          {(["sms", "email"] as const).map((ch) => {
            const supported = m.channels.includes(ch);
            const key = `${m.trigger}:${ch}`;
            return (
              <div key={ch} style={{ display: "flex", justifyContent: "center" }}>
                {supported
                  ? <PrefToggle on={!offs.has(key)} disabled={disabled} onClick={() => onToggle(key)} />
                  : <span style={{ color: "#D4D1CB", fontSize: 13 }}>—</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Builds the overrides payload (every supported channel's current on/off) the
// PUT endpoints expect; the server persists only the OFFs.
export function buildPrefPayload(catalog: PrefCatalogRow[], offs: Set<string>) {
  const out: Array<{ trigger: string; channel: string; enabled: boolean }> = [];
  for (const m of catalog) for (const ch of m.channels) out.push({ trigger: m.trigger, channel: ch, enabled: !offs.has(`${m.trigger}:${ch}`) });
  return out;
}

export function offsFromOverrides(overrides: Record<string, boolean>): Set<string> {
  return new Set(Object.entries(overrides).filter(([, v]) => v === false).map(([k]) => k));
}

export function allOffSet(catalog: PrefCatalogRow[]): Set<string> {
  const n = new Set<string>();
  for (const m of catalog) for (const ch of m.channels) n.add(`${m.trigger}:${ch}`);
  return n;
}
