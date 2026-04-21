import { useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLocation } from "wouter";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useListUsers } from "@workspace/api-client-react";
import { getAuthHeaders, getTokenRole } from "@/lib/auth";
import { useBranch } from "@/contexts/branch-context";
import { Plus, Search, Mail, ExternalLink, Check, Eye } from "lucide-react";
import { useEmployeeView } from "@/contexts/employee-view-context";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const ROLE_BADGES: Record<string, React.CSSProperties> = {
  owner:       { background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid rgba(91,155,213,0.3)' },
  admin:       { background: '#EDE9FE', color: '#5B21B6', border: '1px solid #DDD6FE' },
  technician:  { background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0' },
  office:      { background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' },
  team_lead:   { background: '#FFF7ED', color: '#C2410C', border: '1px solid #FED7AA' },
  super_admin: { background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid rgba(91,155,213,0.3)' },
};

function ProductivityRing({ pct }: { pct: number }) {
  const r = 16;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <div style={{ position: 'relative', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width="36" height="36" style={{ transform: 'rotate(-90deg)', position: 'absolute' }}>
        <circle cx="18" cy="18" r={r} fill="none" stroke="#E5E2DC" strokeWidth={4} />
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--brand)" strokeWidth={4}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--brand)', position: 'relative', zIndex: 1 }}>{pct}%</span>
    </div>
  );
}

export default function EmployeesPage() {
  const [, navigate] = useLocation();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState('');
  const [inviteModal, setInviteModal] = useState(false);
  const isOwner = getTokenRole() === 'owner';
  const { activateView } = useEmployeeView();
  const [sendingInvite, setSendingInvite] = useState<number | null>(null);
  const [inviteSent, setInviteSent] = useState<number | null>(null);
  const [inviteToast, setInviteToast] = useState('');
  const [addModal, setAddModal] = useState(false);
  const [newEmp, setNewEmp] = useState({ first_name: '', last_name: '', email: '', role: 'technician', pay_type: 'hourly', pay_rate: '' });
  const [creating, setCreating] = useState(false);

  const { activeBranchId } = useBranch();
  const branchQuery = activeBranchId !== "all" ? { branch_id: String(activeBranchId) } : {};
  const { data, isLoading, refetch } = useListUsers(branchQuery, { request: { headers: getAuthHeaders() } });

  const employees = (data?.data || []).filter(u =>
    !search || `${u.first_name} ${u.last_name} ${u.email}`.toLowerCase().includes(search.toLowerCase())
  );

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
        showToast(`Invitation sent to ${d.invite_sent_to}`);
      } else {
        showToast('Failed to send invite');
      }
    } catch { showToast('Network error'); }
    setSendingInvite(null);
  }

  async function createEmployee() {
    setCreating(true);
    try {
      const r = await fetch(`${API}/api/users`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(newEmp),
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
          <button onClick={() => setAddModal(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', backgroundColor: 'var(--brand)', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer' }}>
            <Plus size={14} strokeWidth={2} /> Add Team Member
          </button>
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
                  <div style={{ width: 40, height: 40, borderRadius: '50%', backgroundColor: 'var(--brand-dim)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 700, flexShrink: 0 }}>
                    {user.first_name[0]}{user.last_name[0]}
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
                    {isOwner && user.role !== 'owner' && (
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
                {['Employee', 'Role', 'Pay Structure', 'Productivity', 'Score', 'Invite', ''].map(h => (
                  <th key={h} style={{
                    padding: '12px 20px',
                    textAlign: (h === 'Productivity' || h === 'Score') ? 'center' : 'left',
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
                const productivity = (user as any).productivity_pct || 85;
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
                        <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: 'var(--brand-dim)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 600, flexShrink: 0 }}>
                          {user.first_name[0]}{user.last_name[0]}
                        </div>
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
                        <ProductivityRing pct={productivity} />
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px', textAlign: 'center' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--brand)" stroke="none">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                        <span style={{ fontSize: '13px', fontWeight: 500, color: '#1A1917' }}>3.9</span>
                      </div>
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
                        {isOwner && user.role !== 'owner' && (
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

      {/* Toast */}
      {inviteToast && (
        <div style={{ position:'fixed',bottom:24,right:24,background:'#1A1917',color:'#FFFFFF',padding:'12px 20px',borderRadius:10,fontSize:13,fontWeight:600,zIndex:2000,boxShadow:'0 8px 24px rgba(0,0,0,0.2)' }}>
          <Check size={14} style={{ marginRight:6,verticalAlign:'middle' }}/>{inviteToast}
        </div>
      )}
    </DashboardLayout>
  );
}
