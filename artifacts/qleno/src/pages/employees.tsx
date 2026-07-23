import { useState, useEffect, useRef } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLocation } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { useListUsers } from "@workspace/api-client-react";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { Plus, Search, Mail, ExternalLink, Check, Eye, Copy } from "lucide-react";
import { useEmployeeView } from "@/contexts/employee-view-context";
import { OneOnOneCoverageCard } from "@/components/one-on-ones-panel";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const ROLE_BADGES: Record<string, React.CSSProperties> = {
  owner:       { background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid rgba(var(--brand-rgb),0.3)' },
  admin:       { background: '#EDE9FE', color: '#5B21B6', border: '1px solid #DDD6FE' },
  technician:  { background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0' },
  office:      { background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' },
  team_lead:   { background: '#FFF7ED', color: '#C2410C', border: '1px solid #FED7AA' },
  super_admin: { background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid rgba(var(--brand-rgb),0.3)' },
  accountant:  { background: '#F0FAF7', color: '#0A5A48', border: '1px solid #B8EBDF' },
};

function ProductivityRing({ pct }: { pct: number }) {
  // [efficiency-ring 2026-06-17] Bumped 36→46px and darkened the label: a
  // 3-digit value ("171%") couldn't fit the old circle and mint-on-white read
  // poorly. The arc caps at a full circle for >100% so it doesn't overdraw.
  const size = 46;
  const c = size / 2;
  const r = 19;
  const circ = 2 * Math.PI * r;
  const dash = Math.min(pct / 100, 1) * circ;
  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', position: 'absolute' }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="#E5E2DC" strokeWidth={4} />
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--brand)" strokeWidth={4}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <span style={{ fontSize: '11px', fontWeight: 700, color: '#0F766E', position: 'relative', zIndex: 1, lineHeight: 1 }}>{pct}%</span>
    </div>
  );
}

export default function EmployeesPage() {
  const [, navigate] = useLocation();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState('');
  const [inviteModal, setInviteModal] = useState(false);
  const isOwner = getTokenRole() === 'owner';
  // [office-admin-parity 2026-06-26] Who can act on (view-as / manage) a given
  // row. Mirrors the backend guards: owner → any non-owner; office is elevated
  // to the same → any non-owner; admin → non-admins. The owner row is never
  // actionable by anyone but the owner.
  const myRole = getTokenRole() || '';
  const canActOn = (u: any) => {
    if (u.role === 'owner') return false;
    if (myRole === 'owner') return true;
    if (myRole === 'office') return true;
    if (myRole === 'admin') return u.role !== 'admin';
    return false;
  };
  const { activateView } = useEmployeeView();
  const [sendingInvite, setSendingInvite] = useState<number | null>(null);
  const [inviteSent, setInviteSent] = useState<number | null>(null);
  const [inviteToast, setInviteToast] = useState('');
  // After "Send Invite", surface the copyable accept-invite link so the owner
  // can hand it over even if the email doesn't arrive.
  const [inviteLink, setInviteLink] = useState<{ url: string; email: string; emailed: boolean } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [addModal, setAddModal] = useState(false);
  const [newEmp, setNewEmp] = useState({ first_name: '', last_name: '', email: '', role: 'technician', pay_type: 'hourly', pay_rate: '' });
  const [creating, setCreating] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const { activeBranchId } = useBranch();
  const branchQuery = activeBranchId !== "all" ? { branch_id: String(activeBranchId) } : {};
  const { data, isLoading, refetch } = useListUsers(branchQuery, { request: { headers: getAuthHeaders() } });
  // [inactive-filter 2026-06-16] Refetch on mount so a just-saved
  // deactivation can't be masked by a stale cached list.
  useEffect(() => { refetch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hide inactive by default (toggle to show). "Inactive" = the same set of
  // signals payroll uses — is_active=false OR a termination date OR archived —
  // so a tech deactivated by ANY path (Account Active toggle, Termination Date,
  // archive) drops off the list, not only the Account Active toggle.
  // [inactive-filter 2026-06-16] Reported: Juan still listed after being made
  // inactive because only is_active was checked.
  const isInactive = (u: any) => u.is_active === false || !!u.termination_date || !!u.archived_at;
  const isStub = (u: any) => /\b(generic|test)\b/i.test(`${u.first_name} ${u.last_name} ${u.email ?? ""}`);
  const roleRank = (u: any) => isStub(u) ? 3 : (u.role === "technician" ? 0 : u.role === "office" ? 1 : 2);
  const employees = (data?.data || [])
    .filter(u => showInactive || !isInactive(u))
    .filter(u => !search || `${u.first_name} ${u.last_name} ${u.email}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const ra = roleRank(a), rb = roleRank(b);
      if (ra !== rb) return ra - rb;
      return `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`);
    });

  function showToast(msg: string) {
    setInviteToast(msg);
    setTimeout(() => setInviteToast(''), 3000);
  }

  async function sendInvite(userId: number, userName: string) {
    setSendingInvite(userId);
    try {
      const r = await fetch(`${API}/api/users/invite`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
      const d = await r.json();
      if (d.success) {
        setInviteSent(userId);
        setLinkCopied(false);
        // Always show the copyable link; note whether the email also went out.
        setInviteLink({ url: d.invite_url, email: d.invite_sent_to, emailed: !!d.email_sent });
      } else {
        showToast('Failed to send invite');
      }
    } catch { showToast('Network error'); }
    setSendingInvite(null);
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink.url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch { /* clipboard blocked — the link stays visible for manual copy */ }
  }

  async function createEmployee() {
    setCreating(true);
    try {
      // Omit pay for a view-only accountant — not a paid employee.
      const payload = newEmp.role === 'accountant'
        ? { first_name: newEmp.first_name, last_name: newEmp.last_name, email: newEmp.email, role: newEmp.role }
        : newEmp;
      const r = await fetch(`${API}/api/users`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        setAddModal(false);
        setNewEmp({ first_name: '', last_name: '', email: '', role: 'technician', pay_type: 'hourly', pay_rate: '' });
        refetch();
        showToast('Team member added');
      }
    } catch {}
    setCreating(false);
  }

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* Controls */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
          <div style={{ position: 'relative', flex: isMobile ? '1 1 100%' : 'none' }}>
            <Search size={14} strokeWidth={1.5} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9E9B94', pointerEvents: 'none' }} />
            <input
              placeholder="Search team..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: '36px', paddingRight: '12px', height: '36px', width: isMobile ? '100%' : '260px', backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '8px', color: '#1A1917', fontSize: '13px', outline: 'none' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6B6860', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} style={{ cursor: 'pointer' }} />
              Show inactive
            </label>
            <button onClick={() => navigate('/employees/new')}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', backgroundColor: 'var(--brand)', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer' }}>
              <Plus size={14} strokeWidth={2} /> Add Team Member
            </button>
          </div>
        </div>

        {/* Table / Card list */}
        {isMobile ? (
          <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '10px', overflow: 'hidden' }}>
            {isLoading ? (
              <div style={{ padding: '48px', textAlign: 'center', color: '#9E9B94', fontSize: '13px' }}>Loading team members…</div>
            ) : employees.length === 0 ? (
              <div style={{ padding: '48px', textAlign: 'center', color: '#9E9B94', fontSize: '13px' }}>No team members found</div>
            ) : employees.map(user => {
              const roleBadge = ROLE_BADGES[user.role] || ROLE_BADGES.technician;
              const invited = inviteSent === user.id || !!(user as any).invite_sent_at;
              return (
                <div key={user.id}
                  onClick={() => navigate(`/employees/${user.id}`)}
                  style={{ borderBottom: '1px solid #F0EEE9', padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 40, height: 40, flexShrink: 0 }}>
                    <EmployeeAvatar name={`${user.first_name} ${user.last_name}`} avatarUrl={(user as any).avatar_url} size={40} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: '14px', fontWeight: 700, color: '#1A1917' }}>{user.first_name} {user.last_name}</span>
                      <span style={{ ...roleBadge, padding: '2px 7px', borderRadius: '4px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' as const, display: 'inline-block' }}>
                        {user.role.replace('_', ' ')}
                      </span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#9E9B94' }}>
                      {user.pay_type === 'hourly' ? `$${user.pay_rate}/hr` : user.pay_type?.replace('_', ' ')}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }} onClick={e => e.stopPropagation()}>
                    {canActOn(user) && (
                      <button
                        onClick={async e => {
                          e.stopPropagation();
                          await activateView({ employeeId: user.id, employeeName: `${user.first_name} ${user.last_name}` });
                          navigate('/my-jobs');
                        }}
                        title="View as Employee"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B6860', padding: '4px', display: 'flex', alignItems: 'center' }}
                      >
                        <Eye size={15} strokeWidth={1.5} />
                      </button>
                    )}
                    {invited ? (
                      <span style={{ display:'inline-flex',alignItems:'center',gap:3,fontSize:10,fontWeight:600,color:'#166534',background:'#DCFCE7',padding:'3px 7px',borderRadius:4 }}>
                        <Check size={9}/> Invited
                      </span>
                    ) : (
                      <button
                        onClick={e => { e.stopPropagation(); sendInvite(user.id, `${user.first_name} ${user.last_name}`); }}
                        disabled={sendingInvite === user.id}
                        style={{ display:'flex',alignItems:'center',gap:4,padding:'5px 10px',border:'1px solid #E5E2DC',borderRadius:6,fontSize:11,fontWeight:600,background:'#FFFFFF',cursor:'pointer',color:'#6B7280',fontFamily:'inherit' }}>
                        <Mail size={11}/>{sendingInvite===user.id?'…':'Invite'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
        <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '10px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #EEECE7' }}>
                {['Employee', 'Role', 'Pay Structure', 'Efficiency', 'Score', 'Invite', ''].map(h => (
                  <th key={h} style={{
                    padding: '12px 20px',
                    textAlign: (h === 'Efficiency' || h === 'Score') ? 'center' : 'left',
                    fontSize: '11px', fontWeight: 500, color: '#9E9B94',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                  } as React.CSSProperties}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} style={{ padding: '32px', textAlign: 'center', color: '#6B7280', fontSize: '13px' }}>Loading team members…</td></tr>
              ) : employees.map(user => {
                const roleBadge = ROLE_BADGES[user.role] || ROLE_BADGES.technician;
                const efficiency = (user as any).avg_efficiency;
                const hasEfficiency = efficiency != null && Number.isFinite(Number(efficiency)) && Number(efficiency) > 0;
                const invited = inviteSent === user.id || !!(user as any).invite_sent_at;
                return (
                  <tr
                    key={user.id}
                    style={{ borderBottom: '1px solid #F0EEE9', cursor: 'pointer' }}
                    onClick={() => navigate(`/employees/${user.id}`)}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#F7F6F3')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <td style={{ padding: '14px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <EmployeeAvatar name={`${user.first_name} ${user.last_name}`} avatarUrl={(user as any).avatar_url} size={36} fontSize={12} />
                        <div>
                          <p style={{ fontSize: '13px', fontWeight: 600, color: '#1A1917', margin: 0 }}>{user.first_name} {user.last_name}</p>
                          <p style={{ fontSize: '12px', color: '#6B7280', margin: 0 }}>{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px' }}>
                      <span style={{ ...roleBadge, display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                        {user.role.replace('_', ' ')}
                      </span>
                    </td>
                    <td style={{ padding: '14px 20px' }}>
                      <p style={{ fontSize: '13px', fontWeight: 500, color: '#1A1917', margin: 0 }}>${user.pay_rate || '—'}{user.pay_type === 'hourly' ? '/hr' : ''}</p>
                      <p style={{ fontSize: '12px', color: '#6B7280', margin: 0, textTransform: 'capitalize' }}>{user.pay_type?.replace('_', ' ') || '—'}</p>
                    </td>
                    <td style={{ padding: '14px 20px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', justifyContent: 'center' }}>
                        {hasEfficiency ? <ProductivityRing pct={Number(efficiency)} /> : <span style={{ fontSize: '13px', color: '#9E9B94' }}>—</span>}
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px', textAlign: 'center' }}>
                      {/* [90d-composite] Show the rolling composite headline; fall
                          back to the satisfaction-only % until the composite computes. */}
                      {((user as any).scorecard_composite_90d ?? (user as any).scorecard_pct) != null ? (
                        <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--brand)' }}>{Math.round(parseFloat((user as any).scorecard_composite_90d ?? (user as any).scorecard_pct))}%</span>
                      ) : (
                        <span style={{ fontSize: '13px', color: '#9E9B94' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '14px 20px' }} onClick={e => e.stopPropagation()}>
                      {invited ? (
                        <span style={{ display:'inline-flex',alignItems:'center',gap:4,fontSize:11,fontWeight:600,color:'#166534',background:'#DCFCE7',padding:'3px 8px',borderRadius:4 }}>
                          <Check size={10}/> INVITED
                        </span>
                      ) : (
                        <button
                          onClick={e => { e.stopPropagation(); sendInvite(user.id, `${user.first_name} ${user.last_name}`); }}
                          disabled={sendingInvite === user.id}
                          style={{ display:'flex',alignItems:'center',gap:5,padding:'4px 10px',border:'1px solid #E5E2DC',borderRadius:6,fontSize:11,fontWeight:600,background:'#FFFFFF',cursor:'pointer',color:'#6B7280',fontFamily:'inherit' }}>
                          <Mail size={11}/>{sendingInvite===user.id?'Sending…':'Send Invite'}
                        </button>
                      )}
                    </td>
                    <td style={{ padding: '14px 20px', textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                        {canActOn(user) && (
                          <button
                            onClick={async e => {
                              e.stopPropagation();
                              await activateView({ employeeId: user.id, employeeName: `${user.first_name} ${user.last_name}` });
                              navigate('/my-jobs');
                            }}
                            title="View as Employee"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B6860', padding: '4px', display: 'flex', alignItems: 'center' }}
                          >
                            <Eye size={14} strokeWidth={1.5} />
                          </button>
                        )}
                        <button onClick={() => navigate(`/employees/${user.id}`)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9E9B94', padding: '4px', display:'flex',alignItems:'center' }}>
                          <ExternalLink size={14} strokeWidth={1.5} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!isLoading && !employees.length && (
                <tr><td colSpan={7} style={{ padding: '48px', textAlign: 'center', color: '#9E9B94', fontSize: '13px' }}>No team members found</td></tr>
              )}
            </tbody>
          </table>
        </div>
        )}{/* end desktop table ternary */}

        {/* 1-on-1 coverage — owner only; who still needs their quarterly check-in */}
        {isOwner && <OneOnOneCoverageCard />}

        {/* Time off & leave requests — pending requests the office acts on */}
        <TimeOffRequestsSection />
      </div>

      {/* Add Team Member Modal */}
      {addModal && (
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
          <div style={{ background:'#FFFFFF',borderRadius:12,padding:28,width:480,boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin:'0 0 20px 0',fontSize:16,fontWeight:700,color:'#1A1917' }}>Add Team Member</h3>
            <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12 }}>
              {[
                {label:'First Name',key:'first_name'},{label:'Last Name',key:'last_name'},
              ].map(f=>(
                <div key={f.key}>
                  <label style={{ fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:5 }}>{f.label}</label>
                  <input value={(newEmp as any)[f.key]} onChange={e=>setNewEmp(p=>({...p,[f.key]:e.target.value}))}
                    style={{ width:'100%',height:36,padding:'0 12px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,outline:'none' }}/>
                </div>
              ))}
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:5 }}>Email</label>
              <input type="email" value={newEmp.email} onChange={e=>setNewEmp(p=>({...p,email:e.target.value}))}
                style={{ width:'100%',height:36,padding:'0 12px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,outline:'none' }}/>
            </div>
            <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginBottom:20 }}>
              <div>
                <label style={{ fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:5 }}>Role</label>
                <select value={newEmp.role} onChange={e=>setNewEmp(p=>({...p,role:e.target.value}))}
                  style={{ width:'100%',height:36,padding:'0 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,outline:'none',background:'#FFFFFF' }}>
                  <option value="technician">Technician</option>
                  <option value="office">Office</option>
                  <option value="admin">Admin</option>
                  <option value="accountant">Accountant (View-only)</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:5 }}>Pay Type</label>
                <select value={newEmp.pay_type} onChange={e=>setNewEmp(p=>({...p,pay_type:e.target.value}))}
                  style={{ width:'100%',height:36,padding:'0 10px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,outline:'none',background:'#FFFFFF' }}>
                  <option value="hourly">Hourly</option>
                  <option value="per_job">Per Job</option>
                  <option value="fee_split">Fee Split</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize:11,fontWeight:600,color:'#9E9B94',textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:5 }}>Pay Rate ($)</label>
                <input type="number" value={newEmp.pay_rate} onChange={e=>setNewEmp(p=>({...p,pay_rate:e.target.value}))}
                  style={{ width:'100%',height:36,padding:'0 12px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,outline:'none' }}/>
              </div>
            </div>
            <div style={{ display:'flex',gap:10,justifyContent:'flex-end' }}>
              <button onClick={() => setAddModal(false)}
                style={{ padding:'8px 16px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,background:'#FFFFFF',cursor:'pointer',fontFamily:'inherit' }}>Cancel</button>
              <button onClick={createEmployee} disabled={creating||!newEmp.first_name||!newEmp.email}
                style={{ padding:'8px 20px',background:'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit' }}>
                {creating ? 'Creating…' : 'Add Member'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invite link — copyable accept-invite URL surfaced after Send Invite */}
      {inviteLink && (
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:2500 }} onClick={() => setInviteLink(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background:'#FFFFFF',borderRadius:12,padding:28,width:520,maxWidth:'92vw',boxShadow:'0 20px 60px rgba(0,0,0,0.25)' }}>
            <h3 style={{ margin:'0 0 6px 0',fontSize:16,fontWeight:700,color:'#1A1917' }}>Invite ready for {inviteLink.email}</h3>
            <p style={{ margin:'0 0 16px 0',fontSize:13,color:'#6B6860',lineHeight:1.5 }}>
              {inviteLink.emailed
                ? 'We emailed the accept link. You can also copy it below to share directly.'
                : 'Email could not be sent — copy this link and share it directly. It lets them set a password and sign in.'}
            </p>
            <div style={{ display:'flex',gap:8,alignItems:'stretch' }}>
              <input readOnly value={inviteLink.url}
                onFocus={e => e.currentTarget.select()}
                style={{ flex:1,minWidth:0,height:40,padding:'0 12px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:12.5,color:'#1A1917',background:'#FAFAF8',fontFamily:'monospace' }}/>
              <button onClick={copyInviteLink}
                style={{ display:'flex',alignItems:'center',gap:6,padding:'0 16px',background:linkCopied?'#0A5A48':'var(--brand)',color:'#FFFFFF',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer',whiteSpace:'nowrap' }}>
                {linkCopied ? <><Check size={14}/> Copied</> : <><Copy size={14}/> Copy link</>}
              </button>
            </div>
            <p style={{ margin:'14px 0 0 0',fontSize:11.5,color:'#9E9B94' }}>This link expires in 7 days.</p>
            <div style={{ display:'flex',justifyContent:'flex-end',marginTop:20 }}>
              <button onClick={() => setInviteLink(null)}
                style={{ padding:'8px 18px',border:'1px solid #E5E2DC',borderRadius:8,fontSize:13,fontWeight:600,background:'#FFFFFF',cursor:'pointer',fontFamily:'inherit',color:'#6B7280' }}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {inviteToast && (
        <div style={{ position:'fixed',bottom:24,right:24,background:'#1A1917',color:'#FFFFFF',padding:'12px 20px',borderRadius:10,fontSize:13,fontWeight:600,zIndex:2000,boxShadow:'0 8px 24px rgba(0,0,0,0.2)' }}>
          <Check size={14} style={{ marginRight:6,verticalAlign:'middle' }}/>{inviteToast}
        </div>
      )}
    </DashboardLayout>
  );
}

// [time-off-ticket 2026-06-22] Office "Time off & leave requests" section at the
// bottom of the Employees page. Lists pending requests; the office approves or
// declines inline. Profile-photo avatars (EmployeeAvatar falls back to initials).
// [Phase 3] Bucket chip colors are tenant-dynamic: the /leave/requests API
// returns bucket_tint + bucket_on_tint (resolved from leave_types.display_config).
function unitLabel(u: string) {
  return u === 'morning' ? 'Morning' : u === 'afternoon' ? 'Afternoon' : 'Full day';
}
function dateLabel(r: any) {
  const range = r.start_date === r.end_date ? r.start_date : `${r.start_date} – ${r.end_date}`;
  return `${range} · ${unitLabel(r.day_unit)}`;
}

function TimeOffRequestsSection() {
  const role = getTokenRole();
  const canAct = role === 'owner' || role === 'admin' || role === 'office';
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);

  // [employee-bell fix 2026-06-23] The top-bar staff bell focuses this section.
  // Two entry paths:
  //   navigate-in → one-shot sessionStorage flag, read on mount; this effect
  //     scrolls the section in (the scroll parent is <main>, overflow:auto, NOT
  //     window — scrollIntoView bubbles to it correctly).
  //   already-on-page → the bell scrolled the section directly via its id, then
  //     fired 'qleno:focus-timeoff'; here we only flash the highlight.
  useEffect(() => {
    const flash = () => { setFlash(true); window.setTimeout(() => setFlash(false), 1600); };
    let t: number | undefined;
    try {
      if (sessionStorage.getItem('qlenoFocusTimeOff')) {
        sessionStorage.removeItem('qlenoFocusTimeOff');
        // 350ms lets layout settle after the route change before we scroll.
        t = window.setTimeout(() => {
          sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          flash();
        }, 350);
      }
    } catch { /* private mode */ }
    const onEvt = () => flash();
    window.addEventListener('qleno:focus-timeoff', onEvt);
    return () => { window.removeEventListener('qleno:focus-timeoff', onEvt); if (t) window.clearTimeout(t); };
  }, []);

  async function load() {
    try {
      const r = await fetch(`${API}/api/leave/requests?status=pending`, { headers: getAuthHeaders() as any });
      const d = await r.json();
      setRows(d?.data ?? []);
    } catch { /* leave the list empty on error */ }
    finally { setLoading(false); }
  }
  useEffect(() => { if (canAct) load(); else setLoading(false); }, []);

  async function act(id: number, action: 'approve' | 'deny') {
    setBusyId(id);
    try {
      await fetch(`${API}/api/leave/requests/${id}/${action}`, { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' } as any, body: '{}' });
      setRows(prev => prev.filter(x => x.id !== id));
    } catch { /* keep row on failure */ }
    finally { setBusyId(null); }
  }

  if (!canAct) return null;

  return (
    <div ref={sectionRef} id="timeoff-requests-section" style={{ marginTop: 28, scrollMarginTop: 80, borderRadius: 12, transition: 'box-shadow 0.4s ease', boxShadow: flash ? '0 0 0 3px rgba(var(--brand-rgb),0.65)' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: '#1A1917' }}>Time off &amp; leave requests</h2>
        {rows.length > 0 && (
          <span style={{ fontSize: 11, fontWeight: 800, color: '#FFFFFF', background: '#0A0E1A', borderRadius: 999, padding: '2px 9px' }}>{rows.length} pending</span>
        )}
      </div>
      <div style={{ background: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: 10, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 24, color: '#9E9B94', fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24, color: '#9E9B94', fontSize: 13 }}>No pending time-off requests.</div>
        ) : rows.map((r, i) => {
          const c = { bg: r.bucket_tint || '#F4F3F0', fg: r.bucket_on_tint || '#6B6860' };
          return (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderTop: i ? '1px solid #E5E2DC' : 'none' }}>
              <EmployeeAvatar name={`${r.first_name ?? ''} ${r.last_name ?? ''}`} avatarUrl={r.avatar_url} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#1A1917' }}>{r.first_name} {r.last_name}</div>
                <div style={{ fontSize: 12, color: '#6B6860' }}>{dateLabel(r)}</div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', borderRadius: 999, padding: '3px 9px', background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{r.bucket_name}</span>
              {r.attachment_url ? (
                <a href={r.attachment_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, fontWeight: 600, color: '#00876B', textDecoration: 'none', whiteSpace: 'nowrap' }}>Dr. note</a>
              ) : (
                <span style={{ fontSize: 11, color: '#C9C6BF', whiteSpace: 'nowrap' }}>no file</span>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button disabled={busyId === r.id} onClick={() => act(r.id, 'approve')} style={{ fontSize: 12, fontWeight: 700, color: '#FFFFFF', background: 'var(--brand)', border: '1px solid var(--brand)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', opacity: busyId === r.id ? 0.5 : 1 }}>Approve</button>
                <button disabled={busyId === r.id} onClick={() => act(r.id, 'deny')} style={{ fontSize: 12, fontWeight: 700, color: '#6B6860', background: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', opacity: busyId === r.id ? 0.5 : 1 }}>Decline</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
