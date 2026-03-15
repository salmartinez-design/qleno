import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import JobsPage from "@/pages/jobs";
import EmployeesPage from "@/pages/employees";
import EmployeeProfilePage from "@/pages/employee-profile";
import AcceptInvitePage from "@/pages/accept-invite";
import CustomersPage from "@/pages/customers";
import CustomerProfilePage from "@/pages/customer-profile";
import InvoicesPage from "@/pages/invoices";
import CompanyPage from "@/pages/company";
import LoyaltyPage from "@/pages/loyalty";
import PayrollPage from "@/pages/payroll";
import CleancyclopediaPage from "@/pages/cleancyclopedia";
import DiscountsPage from "@/pages/discounts";
import MyJobsPage from "@/pages/my-jobs";
import ClockMonitorPage from "@/pages/clock-monitor";
import PortalLoginPage from "@/pages/portal/login";
import PortalDashboardPage from "@/pages/portal/dashboard";
import InsightsPage from "@/pages/reports/insights";
import ReportsIndexPage from "@/pages/reports/index";
import RevenueReportPage from "@/pages/reports/revenue";
import PayrollReportPage from "@/pages/reports/payroll";
import EmployeeStatsPage from "@/pages/reports/employee-stats";
import TipsReportPage from "@/pages/reports/tips";
import ReceivablesPage from "@/pages/reports/receivables";
import JobCostingPage from "@/pages/reports/job-costing";
import PayrollToRevenuePage from "@/pages/reports/payroll-to-revenue";
import EfficiencyPage from "@/pages/reports/efficiency";
import WeekReviewPage from "@/pages/reports/week-review";
import ScorecardsReportPage from "@/pages/reports/scorecards";
import CancellationsPage from "@/pages/reports/cancellations";
import ContactTicketsReportPage from "@/pages/reports/contact-tickets";
import HotSheetPage from "@/pages/reports/hot-sheet";
import FirstTimePage from "@/pages/reports/first-time";
import NotFound from "@/pages/not-found";

import AdminDashboard from "@/pages/admin/index";
import AdminCompanies from "@/pages/admin/companies";
import AdminBilling from "@/pages/admin/billing";
import AdminCleancyclopedia from "@/pages/admin/cleancyclopedia";
import PropertyGroupsPage from "@/pages/property-groups";
import CompanyBillingPage from "@/pages/company-billing";
import AgreementBuilderPage from "@/pages/agreement-builder";
import FormsPage from "@/pages/forms";
import SignPage from "@/pages/sign";
import QuotesPage from "@/pages/quotes";
import QuoteBuilderPage from "@/pages/quote-builder";
import QuoteDetailPage from "@/pages/quote-detail";
import QuotingPage from "@/pages/quoting";
import InvoiceDetailPage from "@/pages/invoice-detail";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: false },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/login" component={Login} />
      <Route path="/accept-invite" component={AcceptInvitePage} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/jobs" component={JobsPage} />
      <Route path="/employees/clocks" component={ClockMonitorPage} />
      <Route path="/employees/:id" component={EmployeeProfilePage} />
      <Route path="/employees" component={EmployeesPage} />
      <Route path="/customers/:id" component={CustomerProfilePage} />
      <Route path="/customers" component={CustomersPage} />
      <Route path="/invoices/:id" component={InvoiceDetailPage} />
      <Route path="/invoices" component={InvoicesPage} />
      <Route path="/payroll" component={PayrollPage} />
      <Route path="/cleancyclopedia" component={CleancyclopediaPage} />
      <Route path="/company" component={CompanyPage} />
      <Route path="/loyalty" component={LoyaltyPage} />
      <Route path="/discounts" component={DiscountsPage} />
      <Route path="/my-jobs" component={MyJobsPage} />

      <Route path="/reports" component={ReportsIndexPage} />
      <Route path="/reports/insights" component={InsightsPage} />
      <Route path="/reports/revenue" component={RevenueReportPage} />
      <Route path="/reports/payroll" component={PayrollReportPage} />
      <Route path="/reports/employee-stats" component={EmployeeStatsPage} />
      <Route path="/reports/tips" component={TipsReportPage} />
      <Route path="/reports/receivables" component={ReceivablesPage} />
      <Route path="/reports/job-costing" component={JobCostingPage} />
      <Route path="/reports/payroll-to-revenue" component={PayrollToRevenuePage} />
      <Route path="/reports/efficiency" component={EfficiencyPage} />
      <Route path="/reports/week-review" component={WeekReviewPage} />
      <Route path="/reports/scorecards" component={ScorecardsReportPage} />
      <Route path="/reports/cancellations" component={CancellationsPage} />
      <Route path="/reports/contact-tickets" component={ContactTicketsReportPage} />
      <Route path="/reports/hot-sheet" component={HotSheetPage} />
      <Route path="/reports/first-time" component={FirstTimePage} />

      <Route path="/portal/:slug/login" component={PortalLoginPage} />
      <Route path="/portal/:slug/dashboard" component={PortalDashboardPage} />
      <Route path="/portal/:slug" component={PortalLoginPage} />

      <Route path="/company/property-groups" component={PropertyGroupsPage} />
      <Route path="/company/billing" component={CompanyBillingPage} />
      <Route path="/company/agreements" component={AgreementBuilderPage} />
      <Route path="/company/forms" component={FormsPage} />
      <Route path="/company/quoting" component={QuotingPage} />
      <Route path="/quotes/new" component={QuoteBuilderPage} />
      <Route path="/quotes/:id/edit" component={QuoteBuilderPage} />
      <Route path="/quotes/:id" component={QuoteDetailPage} />
      <Route path="/quotes" component={QuotesPage} />

      <Route path="/sign/:token" component={SignPage} />

      <Route path="/admin" component={AdminDashboard} />
      <Route path="/admin/companies" component={AdminCompanies} />
      <Route path="/admin/billing" component={AdminBilling} />
      <Route path="/admin/cleancyclopedia" component={AdminCleancyclopedia} />

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
