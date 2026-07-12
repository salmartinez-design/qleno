import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Link } from "wouter";
import {
  TrendingUp, DollarSign, Banknote, Activity, UserCheck, Star,
  ReceiptText, Clipboard, Calendar, LayoutList, ClipboardList,
  AlertTriangle, FileText, Home, Users, ArrowRight, RefreshCw,
  Briefcase, Percent, History,
} from "lucide-react";

const REPORT_GROUPS = [
  {
    label: "Financial",
    color: "#5B9BD5",
    reports: [
      { title: "Revenue Summary",      desc: "Total revenue, trends, and projected income by period.", url: "/reports/revenue",          icon: DollarSign },
      { title: "Accounts Receivable",  desc: "Outstanding invoices grouped by aging bucket.",          url: "/reports/receivables",       icon: ReceiptText },
      { title: "Job Costing",          desc: "Revenue vs labor cost with gross profit margins.",       url: "/reports/job-costing",       icon: Clipboard },
      { title: "Payroll % Revenue",    desc: "Payroll-to-revenue ratio tracked week over week.",       url: "/reports/payroll-to-revenue",icon: Activity },
      { title: "Discounts",            desc: "Every discount applied to a job — code, amount, and who applied it.", url: "/reports/discounts", icon: Percent },
      { title: "Fees Collected",       desc: "Cancellation and lockout fees billed in a period — labeled subset of revenue.", url: "/reports/fees", icon: Banknote },
      { title: "Revenue History (MaidCentral)", desc: "Pre-Qleno monthly revenue from MaidCentral, preserved for reporting. Separate from live Qleno numbers.", url: "/reports/revenue-history", icon: History },
    ],
  },
  {
    label: "Operations",
    color: "#10B981",
    reports: [
      { title: "Job Log",              desc: "All jobs with filters, KPIs, and export.",               url: "/reports/jobs",             icon: Briefcase },
      { title: "Payroll Summary",      desc: "Employee earnings, hours, tips, and additional pay.",    url: "/reports/payroll",          icon: Banknote },
      { title: "Schedule Efficiency",  desc: "Allowed vs actual hours — time utilization by day.",    url: "/reports/efficiency",       icon: Calendar },
      { title: "Week in Review",       desc: "This week vs last week across all key metrics.",         url: "/reports/week-review",      icon: LayoutList },
      { title: "Hot Sheet",            desc: "Today's jobs with client notes and first-time flags.",  url: "/reports/hot-sheet",        icon: Home },
      { title: "First Time In",        desc: "Upcoming first-time client visits in date range.",       url: "/reports/first-time",       icon: Users },
    ],
  },
  {
    label: "Customers and Quality",
    color: "#F59E0B",
    reports: [
      { title: "Performance Insights", desc: "Top performers, at-risk clients, and team alerts.",      url: "/reports/insights",         icon: TrendingUp },
      { title: "Employee Stats",       desc: "Individual attendance, efficiency, and revenue stats.",  url: "/reports/employee-stats",   icon: UserCheck },
      { title: "Tips Report",          desc: "Tips earned by employee across a date range.",           url: "/reports/tips",             icon: Star },
      { title: "Scorecard Results",    desc: "Post-job survey responses — sent, returned, score, and trend per customer.", url: "/reports/satisfaction", icon: Star },
      { title: "Performance Score Results",    desc: "Client ratings distribution and employee averages.",     url: "/reports/scorecards",       icon: ClipboardList },
      { title: "Quality & Efficiency", desc: "Performance Score + efficiency by package — company or per-tech, time-bucketed.", url: "/reports/quality-efficiency", icon: ClipboardList },
      { title: "Cancellations",        desc: "Clients with cancelled jobs, tenure, and revenue lost.", url: "/reports/cancellations",    icon: AlertTriangle },
      { title: "Contact Tickets",      desc: "Complaints, breakages, compliments, and incidents.",     url: "/reports/contact-tickets",  icon: FileText },
      { title: "Redos & Quality",      desc: "Re-cleans by cleaner, clients with repeat complaints, and top reasons.", url: "/reports/redos", icon: RefreshCw },
    ],
  },
  {
    label: "Growth & Retention",
    color: "#8B5CF6",
    reports: [
      { title: "Upsell Conversion",    desc: "Deep Clean to recurring conversion rates, rate lock health, and trend data.", url: "/reports/upsell-conversion", icon: RefreshCw },
      { title: "Message Log",          desc: "All automated follow-up messages sent via SMS and email, with status and sequence details.", url: "/reports/message-log", icon: FileText },
      { title: "Recurring Revenue",    desc: "MRR, retention, churn, and VA sales commission for recurring clients.", url: "/reports/recurring", icon: TrendingUp },
    ],
  },
];

export default function ReportsIndexPage() {
  return (
    <DashboardLayout title="Reports">
      <div style={{ padding: '24px 28px', maxWidth: 1200 }}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1A1917' }}>Reports</h1>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: '#6B7280' }}>20 reports covering financials, operations, client quality, and growth.</p>
        </div>

        {REPORT_GROUPS.map(group => (
          <div key={group.label} style={{ marginBottom: 36 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{ width: 3, height: 18, borderRadius: 2, backgroundColor: group.color }} />
              <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#1A1917', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{group.label}</h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
              {group.reports.map(r => {
                const Icon = r.icon;
                return (
                  <Link key={r.url} href={r.url}>
                    <div
                      style={{
                        backgroundColor: '#FFFFFF',
                        border: '1px solid #E5E2DC',
                        borderRadius: 10,
                        padding: '16px 18px',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = group.color; e.currentTarget.style.boxShadow = `0 2px 12px rgba(0,0,0,0.07)`; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = '#E5E2DC'; e.currentTarget.style.boxShadow = 'none'; }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                        <div style={{ width: 34, height: 34, borderRadius: 8, backgroundColor: `${group.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Icon size={16} color={group.color} />
                        </div>
                        <ArrowRight size={14} color="#9E9B94" />
                      </div>
                      <div>
                        <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600, color: '#1A1917' }}>{r.title}</p>
                        <p style={{ margin: 0, fontSize: 12, color: '#6B7280', lineHeight: 1.5 }}>{r.desc}</p>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </DashboardLayout>
  );
}
