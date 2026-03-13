import { useState } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useGetLoyaltySettings, useUpdateLoyaltySettings } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

const PROGRAM_STYLES = [
  { id: 'points', label: 'Points-Based', desc: 'Earn points per cleaning and per dollar spent.' },
  { id: 'punch_card', label: 'Punch Card', desc: '10 cleanings = 1 free cleaning.' },
  { id: 'tiered', label: 'Tiered VIP', desc: 'Silver / Gold / Platinum tiers.' },
];

const EARN_RULES = [
  { id: 'per_cleaning', label: 'Per completed cleaning', pts: 50, type: 'toggle' },
  { id: 'per_dollar', label: 'Per dollar spent', pts: 5, type: 'slider' },
  { id: 'referral', label: 'Referral', pts: 200, type: 'toggle' },
  { id: 'google_review', label: 'Google review', pts: 100, type: 'toggle' },
  { id: 'auto_pay', label: 'Auto-pay enrollment', pts: 25, type: 'toggle' },
  { id: 'birthday', label: 'Birthday', pts: 50, type: 'toggle' },
];

const REWARDS = [
  { id: 'r5off', label: '$5 off', pts: 250 },
  { id: 'r10off', label: '$10 off', pts: 500 },
  { id: 'free_addon', label: 'Free add-on', pts: 400 },
  { id: 'free_cleaning', label: 'Free cleaning', pts: 1200 },
];

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        width: '40px', height: '22px', borderRadius: '11px',
        backgroundColor: on ? 'var(--brand)' : '#222222',
        border: 'none', cursor: 'pointer', position: 'relative',
        transition: 'background-color 0.2s', flexShrink: 0,
      }}
    >
      <div style={{
        width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#F0EDE8',
        position: 'absolute', top: '3px', left: on ? '21px' : '3px',
        transition: 'left 0.2s',
      }} />
    </button>
  );
}

export default function LoyaltyPage() {
  const { data: settings } = useGetLoyaltySettings({ request: { headers: getAuthHeaders() } });
  const updateSettings = useUpdateLoyaltySettings({ request: { headers: getAuthHeaders() } });
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [programStyle, setProgramStyle] = useState<string>((settings as any)?.program_style || 'points');
  const [earnToggles, setEarnToggles] = useState<Record<string, boolean>>({
    per_cleaning: true, per_dollar: true, referral: true,
    google_review: true, auto_pay: false, birthday: true,
  });
  const [ptsPerDollar, setPtsPerDollar] = useState(5);
  const [rewardToggles, setRewardToggles] = useState<Record<string, boolean>>({
    r5off: true, r10off: true, free_addon: true, free_cleaning: false,
  });

  const handleSave = () => {
    updateSettings.mutate(
      { data: { program_style: programStyle as any, points_per_cleaning: 50, points_per_dollar: ptsPerDollar } as any },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/loyalty/settings'] });
          toast({ title: "Loyalty settings saved", description: "Changes are now live for your clients." });
        },
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to save loyalty settings." }),
      }
    );
  };

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
        {/* Header */}
        <div>
          <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '42px', color: '#F0EDE8', margin: 0, lineHeight: 1.1 }}>Loyalty Program</h1>
          <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '13px', color: '#7A7873', marginTop: '6px' }}>Configure your CleanRewards program style, earn rules, and rewards.</p>
        </div>

        {/* Section 1: Program Style */}
        <div>
          <SectionTitle>Program Style</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginTop: '12px' }}>
            {PROGRAM_STYLES.map(style => (
              <button
                key={style.id}
                onClick={() => setProgramStyle(style.id)}
                style={{
                  padding: '20px',
                  borderRadius: '10px',
                  border: `2px solid ${programStyle === style.id ? 'var(--brand)' : '#222222'}`,
                  backgroundColor: programStyle === style.id ? 'rgba(var(--tenant-color-rgb), 0.08)' : '#161616',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '16px', color: programStyle === style.id ? 'var(--brand)' : '#F0EDE8', margin: '0 0 6px 0' }}>{style.label}</p>
                <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, fontSize: '12px', color: '#7A7873', margin: 0 }}>{style.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Section 2: Earn Rules */}
        <div>
          <SectionTitle>Earn Rules</SectionTitle>
          <div style={{ backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '8px', overflow: 'hidden', marginTop: '12px' }}>
            {EARN_RULES.map((rule, i) => (
              <div key={rule.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: i < EARN_RULES.length - 1 ? '1px solid #252525' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <Toggle on={earnToggles[rule.id]} onChange={v => setEarnToggles(prev => ({ ...prev, [rule.id]: v }))} />
                  <span style={{ fontSize: '13px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, color: earnToggles[rule.id] ? '#F0EDE8' : '#7A7873' }}>{rule.label}</span>
                </div>
                {rule.type === 'slider' ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '13px', fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--brand)', minWidth: '100px', textAlign: 'right' }}>{ptsPerDollar} pts per $1</span>
                    <input
                      type="range" min="1" max="10" value={ptsPerDollar}
                      onChange={e => setPtsPerDollar(Number(e.target.value))}
                      style={{ width: '100px', accentColor: 'var(--brand)' }}
                    />
                  </div>
                ) : (
                  <span style={{ backgroundColor: 'rgba(var(--tenant-color-rgb), 0.15)', color: 'var(--brand)', padding: '3px 10px', borderRadius: '4px', fontSize: '12px', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                    {rule.pts} pts
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Section 3: Rewards */}
        <div>
          <SectionTitle>Rewards</SectionTitle>
          <div style={{ backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '8px', overflow: 'hidden', marginTop: '12px' }}>
            {REWARDS.map((reward, i) => (
              <div key={reward.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: i < REWARDS.length - 1 ? '1px solid #252525' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <Toggle on={rewardToggles[reward.id]} onChange={v => setRewardToggles(prev => ({ ...prev, [reward.id]: v }))} />
                  <span style={{ fontSize: '13px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 300, color: rewardToggles[reward.id] ? '#F0EDE8' : '#7A7873' }}>{reward.label}</span>
                </div>
                <span style={{ backgroundColor: '#1A1A1A', border: '1px solid #252525', color: '#7A7873', padding: '3px 12px', borderRadius: '4px', fontSize: '12px', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  {reward.pts.toLocaleString()} pts
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Save */}
        <div>
          <button
            onClick={handleSave}
            disabled={updateSettings.isPending}
            style={{ padding: '10px 28px', backgroundColor: 'var(--brand)', color: '#0D0D0D', borderRadius: '6px', fontSize: '13px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 400, border: 'none', cursor: 'pointer', opacity: updateSettings.isPending ? 0.7 : 1 }}
          >
            {updateSettings.isPending ? 'Saving...' : 'Save Loyalty Settings'}
          </button>
        </div>
      </div>
    </DashboardLayout>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '22px', color: '#F0EDE8', margin: 0 }}>{children}</h2>
  );
}
