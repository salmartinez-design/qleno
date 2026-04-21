import { lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import { BranchProvider } from "@/contexts/branch-context";
import { EmployeeViewProvider } from "@/contexts/employee-view-context";

const Login               = lazy(() => import("@/pages/login"));
const Dashboard           = lazy(() => import("@/pages/dashboard"));
const JobsPage            = lazy(() => import("@/pages/jobs"));
const JobsListPage        = lazy(() => import("@/pages/jobs-list"));
const EmployeesPage       = lazy(() => import("@/pages/employees"));
const EmployeeProfilePage = lazy(() => import("@/pages/employee-profile"));
const AcceptInvitePage    = lazy(() => import("@/pages/accept-invite"));
const CustomersPage       = lazy(() => import("@/pages/customers"));
const CustomerProfilePage = lazy(() => import("@/pages/customer-profile"));
const InvoicesPage        = lazy(() => import("@/pages/invoices"));
const CompanyPage         = lazy(() => import("@/pages/company"));
const LoyaltyPage         = lazy(() => import("@/pages/loyalty"));
const PayrollPage         = lazy(() => import("@/pages/payroll"));
const CleancyclopediaPage = lazy(() => import("@/pages/cleancyclopedia"));
const DiscountsRedirect   = lazy(() => Promise.resolve({ default: () => { window.location.replace((import.meta.env.BASE_URL.replace(/\/$/, "")) + "/company?tab=pricing"); return null; } }));
const MyJobsPage          = lazy(() => import("@/pages/my-jobs"));
const ClockMonitorPage    = lazy(() => import("@/pages/clock-monitor"));
const PortalLoginPage     = lazy(() => import("@/pages/portal/login"));
const PortalDashboardPage = lazy(() => import("@/pages/portal/dashboard"));
const InsightsPage        = lazy(() => import("@/pages/reports/insights"));
const ReportsIndexPage    = lazy(() => import("@/pages/reports/index"));
const RevenueReportPage   = lazy(() => import("@/pages/reports/revenue"));
const PayrollReportPage   = lazy(() => import("@/pages/reports/payroll"));
const EmployeeStatsPage   = lazy(() => import("@/pages/reports/employee-stats"));
const TipsReportPage      = lazy(() => import("@/pages/reports/tips"));
const ReceivablesPage     = lazy(() => import("@/pages/reports/receivables"));
const JobCostingPage      = lazy(() => import("@/pages/reports/job-costing"));
const PayrollToRevenuePage= lazy(() => import("@/pages/reports/payroll-to-revenue"));
const EfficiencyPage      = lazy(() => import("@/pages/reports/efficiency"));
const WeekReviewPage      = lazy(() => import("@/pages/reports/week-review"));
const ScorecardsReportPage= lazy(() => import("@/pages/reports/scorecards"));
const CancellationsPage   = lazy(() => import("@/pages/reports/cancellations"));
const ContactTicketsReportPage = lazy(() => import("@/pages/reports/contact-tickets"));
const HotSheetPage        = lazy(() => import("@/pages/reports/hot-sheet"));
const FirstTimePage       = lazy(() => import("@/pages/reports/first-time"));
const PropertyGroupsPage  = lazy(() => import("@/pages/property-groups"));
const CompanyBillingPage  = lazy(() => import("@/pages/company-billing"));
const AgreementBuilderPage= lazy(() => import("@/pages/agreement-builder"));
const FormsPage           = lazy(() => import("@/pages/forms"));
const SignPage             = lazy(() => import("@/pages/sign"));
const QuotesPage          = lazy(() => import("@/pages/quotes"));
const QuoteBuilderPage    = lazy(() => import("@/pages/quote-builder"));
const QuoteDetailPage     = lazy(() => import("@/pages/quote-detail"));
const QuotingPage         = lazy(() => import("@/pages/quoting"));
const InvoiceDetailPage   = lazy(() => import("@/pages/invoice-detail"));
const PayPage             = lazy(() => import("@/pages/pay"));
const ZonesPage           = lazy(() => import("@/pages/zones"));
const SurveyPage          = lazy(() => import("@/pages/survey"));
const RouteSequencesPage  = lazy(() => import("@/pages/route-sequences"));
const ChurnBoardPage      = lazy(() => import("@/pages/intelligence/churn"));
const RetentionBoardPage  = lazy(() => import("@/pages/intelligence/retention"));
const SatisfactionReportPage = lazy(() => import("@/pages/reports/satisfaction"));
const AddOnCatalogPage    = lazy(() => import("@/pages/company/addons"));
const RatesPage           = lazy(() => import("@/pages/company/rates"));
const ReferralReportPage  = lazy(() => import("@/pages/reports/referrals"));
const IncentivesPage      = lazy(() => import("@/pages/reports/incentives"));
const RevenueGoalPage     = lazy(() => import("@/pages/reports/revenue-goal"));
const UpsellConversionPage= lazy(() => import("@/pages/reports/upsell-conversion"));
const MessageLogPage      = lazy(() => import("@/pages/reports/message-log"));
const AccountsPage        = lazy(() => import("@/pages/accounts"));
const AccountDetailPage   = lazy(() => import("@/pages/account-detail"));
const OnboardPage         = lazy(() => import("@/pages/onboard"));
const SignDocPage          = lazy(() => import("@/pages/sign-doc"));
const BookPage            = lazy(() => import("@/pages/book"));
const LeadsPage           = lazy(() => import("@/pages/leads"));
const AdminDashboard      = lazy(() => import("@/pages/admin/index"));
const AdminCompanies      = lazy(() => import("@/pages/admin/companies"));
const AdminBilling        = lazy(() => import("@/pages/admin/billing"));
const AdminCleancyclopedia= lazy(() => import("@/pages/admin/cleancyclopedia"));
const NotificationsPage   = lazy(() => import("@/pages/notifications"));
const NotFound            = lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: false },
  },
});

function PageLoader() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#F7F6F4" }}>
      <div style={{ width: 32, height: 32, border: "3px solid #E5E2DC", borderTopColor: "#2563EB", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/login" component={Login} />
        <Route path="/accept-invite" component={AcceptInvitePage} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/dispatch" component={JobsPage} />
        <Route path="/jobs" component={JobsPage} />
        <Route path="/jobs/list" component={JobsListPage} />
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
        <Route path="/discounts" component={DiscountsRedirect} />
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
        <Route path="/company/zones" component={ZonesPage} />
        <Route path="/company/addons" component={AddOnCatalogPage} />
        <Route path="/company/rates" component={RatesPage} />
        <Route path="/survey/:token" component={SurveyPage} />
        <Route path="/route-sequences" component={RouteSequencesPage} />
        <Route path="/intelligence/churn" component={ChurnBoardPage} />
        <Route path="/intelligence/retention" component={RetentionBoardPage} />
        <Route path="/reports/satisfaction" component={SatisfactionReportPage} />
        <Route path="/reports/referrals" component={ReferralReportPage} />
        <Route path="/reports/incentives" component={IncentivesPage} />
        <Route path="/reports/revenue-goal" component={RevenueGoalPage} />
        <Route path="/reports/upsell-conversion" component={UpsellConversionPage} />
        <Route path="/reports/message-log" component={MessageLogPage} />
        <Route path="/accounts/:id" component={AccountDetailPage} />
        <Route path="/accounts" component={AccountsPage} />
        <Route path="/leads" component={LeadsPage} />
        <Route path="/quotes/new" component={QuoteBuilderPage} />
        <Route path="/quotes/:id/edit" component={QuoteBuilderPage} />
        <Route path="/quotes/:id" component={QuoteDetailPage} />
        <Route path="/quotes" component={QuotesPage} />

        <Route path="/book/:slug" component={BookPage} />
        <Route path="/pay/:token" component={PayPage} />
        <Route path="/sign/:token" component={SignPage} />
        <Route path="/onboard/:token" component={OnboardPage} />
        <Route path="/sign-doc/:token" component={SignDocPage} />

        <Route path="/notifications" component={NotificationsPage} />

        <Route path="/admin" component={AdminDashboard} />
        <Route path="/admin/companies" component={AdminCompanies} />
        <Route path="/admin/billing" component={AdminBilling} />
        <Route path="/admin/cleancyclopedia" component={AdminCleancyclopedia} />

        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <EmployeeViewProvider>
              <BranchProvider>
                <Router />
              </BranchProvider>
            </EmployeeViewProvider>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
