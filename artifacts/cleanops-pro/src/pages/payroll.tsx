import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useListUsers } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { Download, Calendar } from "lucide-react";

const FALLBACK_RATES: Record<string, number> = {
  owner: 0,
  admin: 22,
  technician: 18,
};
function empRate(emp: any): number {
  const r = parseFloat(emp.pay_rate);
  if (!isNaN(r) && r > 0) return r;
  return FALLBACK_RATES[emp.role] ?? 18;
}

export default function PayrollPage() {
  const { data, isLoading } = useListUsers({}, { request: { headers: getAuthHeaders() } });
  const employees = data?.data || [];
  const billableEmployees = employees.filter((e: any) => e.role !== 'owner');

  const totalGross = billableEmployees.reduce((sum: number, e: any) => {
    const rate = empRate(e);
    return sum + rate * 40;
  }, 0);

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Controls */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', border: '1px solid #E5E2DC', borderRadius: '8px', backgroundColor: 'transparent', color: '#6B7280', fontSize: '13px', cursor: 'pointer' }}>
            <Calendar size={14} strokeWidth={1.5} />
            Current Period
          </button>
          <button
            onClick={() => {
              const csv = ['Employee,Role,Hours,Rate,Gross Pay',
                ...billableEmployees.map((e: any) => {
                  const rate = empRate(e);
                  return `${e.first_name} ${e.last_name},${e.role},40,$${rate},$${(rate * 40).toFixed(2)}`;
                })
              ].join('\n');
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = 'payroll.csv'; a.click();
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', backgroundColor: 'var(--brand)', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: 600, border: 'none', cursor: 'pointer' }}>
            <Download size={14} strokeWidth={1.5} />
            Export CSV
          </button>
        </div>

        {/* Summary Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
          {[
            { label: 'Gross Payroll', value: `$${totalGross.toLocaleString()}` },
            { label: 'Total Hours (Est.)', value: `${billableEmployees.length * 40} hrs` },
            { label: 'Employees Paid', value: billableEmployees.length },
          ].map(c => (
            <div key={c.label} style={{ backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '10px', padding: '20px' }}>
              <p style={{ fontSize: '11px', fontWeight: 500, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px 0' }}>{c.label}</p>
              <p style={{ fontSize: '22px', fontWeight: 700, color: '#1A1917', margin: 0 }}>{c.value}</p>
            </div>
          ))}
        </div>

        {/* Employee Payroll Table */}
        <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #EEECE7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p style={{ fontSize: '15px', fontWeight: 600, color: '#1A1917', margin: 0 }}>Employee Payroll Summary</p>
            <span style={{ fontSize: '12px', color: '#6B7280' }}>Current bi-weekly period</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #EEECE7' }}>
                {['Employee', 'Role', 'Hours (Est.)', 'Hourly Rate', 'Gross Pay', 'Status'].map(h => (
                  <th key={h} style={{ padding: '12px 20px', textAlign: 'left', fontSize: '11px', fontWeight: 500, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: '#6B7280', fontSize: '13px' }}>Loading payroll data...</td></tr>
              ) : billableEmployees.length > 0 ? billableEmployees.map((emp: any) => {
                const rate = empRate(emp);
                const gross = rate * 40;
                return (
                  <tr key={emp.id} style={{ borderBottom: '1px solid #F0EEE9', cursor: 'default' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#F7F6F3')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <td style={{ padding: '14px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ width: '32px', height: '32px', borderRadius: '50%', backgroundColor: 'var(--brand-dim)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 600, flexShrink: 0 }}>
                          {emp.first_name?.[0]}{emp.last_name?.[0]}
                        </div>
                        <div>
                          <p style={{ fontSize: '13px', fontWeight: 600, color: '#1A1917', margin: 0 }}>{emp.first_name} {emp.last_name}</p>
                          <p style={{ fontSize: '12px', color: '#6B7280', margin: 0 }}>{emp.email}</p>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px' }}>
                      <span style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--brand-dim)', color: 'var(--brand)' }}>
                        {emp.role}
                      </span>
                    </td>
                    <td style={{ padding: '14px 20px', fontSize: '13px', fontWeight: 500, color: '#1A1917' }}>40</td>
                    <td style={{ padding: '14px 20px', fontSize: '13px', fontWeight: 500, color: '#1A1917' }}>${rate}/hr</td>
                    <td style={{ padding: '14px 20px', fontSize: '22px', fontWeight: 700, color: '#1A1917' }}>${gross.toFixed(2)}</td>
                    <td style={{ padding: '14px 20px' }}>
                      <span style={{ background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0', display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Ready</span>
                    </td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: '#6B7280', fontSize: '13px' }}>No employees found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  );
}
