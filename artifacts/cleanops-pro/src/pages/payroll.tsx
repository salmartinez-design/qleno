import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { useListUsers } from "@workspace/api-client-react";
import { getAuthHeaders } from "@/lib/auth";
import { Download, Calendar } from "lucide-react";

const PAY_RATES: Record<string, number> = {
  owner: 0,
  admin: 22,
  technician: 18,
};

export default function PayrollPage() {
  const { data, isLoading } = useListUsers({}, { request: { headers: getAuthHeaders() } });
  const employees = data?.data || [];
  const billableEmployees = employees.filter((e: any) => e.role !== 'owner');

  const totalGross = billableEmployees.reduce((sum: number, e: any) => {
    const rate = PAY_RATES[e.role] ?? 18;
    return sum + rate * 40;
  }, 0);

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: '42px', color: '#E8E0D0', margin: 0, lineHeight: 1.1 }}>Payroll</h1>
            <p style={{ fontFamily: "'DM Mono', monospace", fontWeight: 300, fontSize: '13px', color: '#888780', marginTop: '6px' }}>Review, approve, and export payroll for your team.</p>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', border: '1px solid #252525', borderRadius: '6px', backgroundColor: 'transparent', color: '#888780', fontSize: '13px', fontFamily: "'DM Mono', monospace", cursor: 'pointer' }}>
              <Calendar size={14} strokeWidth={1.5} />
              Current Period
            </button>
            <button
              onClick={() => {
                const csv = ['Employee,Role,Hours,Rate,Gross Pay',
                  ...billableEmployees.map((e: any) => {
                    const rate = PAY_RATES[e.role] ?? 18;
                    return `${e.first_name} ${e.last_name},${e.role},40,$${rate},$${(rate * 40).toFixed(2)}`;
                  })
                ].join('\n');
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = 'payroll.csv'; a.click();
              }}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', backgroundColor: 'var(--tenant-color)', color: '#FFFFFF', borderRadius: '6px', fontSize: '13px', fontFamily: "'DM Mono', monospace", fontWeight: 400, border: 'none', cursor: 'pointer' }}>
              <Download size={14} strokeWidth={1.5} />
              Export CSV
            </button>
          </div>
        </div>

        {/* Summary Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
          {[
            { label: 'Gross Payroll', value: `$${totalGross.toLocaleString()}` },
            { label: 'Total Hours (Est.)', value: `${billableEmployees.length * 40} hrs` },
            { label: 'Employees Paid', value: billableEmployees.length },
          ].map(c => (
            <div key={c.label} style={{ backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '8px', padding: '20px' }}>
              <p style={{ fontSize: '11px', fontFamily: "'DM Mono', monospace", color: '#888780', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px 0' }}>{c.label}</p>
              <p style={{ fontFamily: "'Playfair Display', serif", fontWeight: 900, fontSize: '28px', color: '#E8E0D0', margin: 0 }}>{c.value}</p>
            </div>
          ))}
        </div>

        {/* Employee Payroll Table */}
        <div style={{ backgroundColor: '#161616', border: '1px solid #252525', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #252525', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: '18px', color: '#E8E0D0', margin: 0 }}>Employee Payroll Summary</h3>
            <span style={{ fontSize: '12px', fontFamily: "'DM Mono', monospace", color: '#888780' }}>Current bi-weekly period</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: '#0D0D0D', borderBottom: '1px solid #252525' }}>
                  {['Employee', 'Role', 'Hours (Est.)', 'Hourly Rate', 'Gross Pay', 'Status'].map(h => (
                    <th key={h} style={{ padding: '12px 20px', textAlign: 'left', fontSize: '11px', fontFamily: "'DM Mono', monospace", color: '#555550', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 400 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: '#888780', fontSize: '13px', fontFamily: "'DM Mono', monospace" }}>Loading payroll data...</td></tr>
                ) : billableEmployees.length > 0 ? billableEmployees.map((emp: any) => {
                  const rate = PAY_RATES[emp.role] ?? 18;
                  const gross = rate * 40;
                  return (
                    <tr key={emp.id} style={{ borderBottom: '1px solid #1A1A1A' }}>
                      <td style={{ padding: '14px 20px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '30px', height: '30px', borderRadius: '50%', backgroundColor: 'rgba(var(--tenant-color-rgb), 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <span style={{ fontSize: '12px', fontFamily: "'DM Mono', monospace", color: 'var(--tenant-color)', fontWeight: 400 }}>
                              {emp.first_name?.[0]}{emp.last_name?.[0]}
                            </span>
                          </div>
                          <div>
                            <p style={{ fontSize: '13px', fontFamily: "'DM Mono', monospace", color: '#E8E0D0', margin: 0 }}>{emp.first_name} {emp.last_name}</p>
                            <p style={{ fontSize: '11px', fontFamily: "'DM Mono', monospace", color: '#888780', margin: 0 }}>{emp.email}</p>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '14px 20px' }}>
                        <span style={{
                          padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontFamily: "'DM Mono', monospace", textTransform: 'capitalize',
                          backgroundColor: emp.role === 'admin' ? 'rgba(91, 170, 213, 0.15)' : 'rgba(var(--tenant-color-rgb), 0.12)',
                          color: emp.role === 'admin' ? '#6AAFE6' : 'var(--tenant-color)'
                        }}>
                          {emp.role}
                        </span>
                      </td>
                      <td style={{ padding: '14px 20px', fontSize: '13px', fontFamily: "'DM Mono', monospace", color: '#E8E0D0' }}>40</td>
                      <td style={{ padding: '14px 20px', fontSize: '13px', fontFamily: "'DM Mono', monospace", color: '#E8E0D0' }}>${rate}/hr</td>
                      <td style={{ padding: '14px 20px', fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: '16px', color: '#E8E0D0' }}>${gross.toFixed(2)}</td>
                      <td style={{ padding: '14px 20px' }}>
                        <span style={{ backgroundColor: 'rgba(39, 80, 10, 0.3)', color: '#6BBF3D', padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontFamily: "'DM Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ready</span>
                      </td>
                    </tr>
                  );
                }) : (
                  <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: '#888780', fontSize: '13px', fontFamily: "'DM Mono', monospace" }}>No employees found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
