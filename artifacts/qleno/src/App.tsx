import { lazy, Suspense, useEffect } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import { BranchProvider } from "@/contexts/branch-context";
import { EmployeeViewProvider } from "@/contexts/employee-view-context";
import { useAuthStore, getTokenRole, isTokenExpired, startTokenRefresh } from "@/lib/auth";

const Login               = lazy(() => import("@/pages/login"));
const Dashboard           = lazy(() => import("@/pages/dashboard"));
const JobsPage            = lazy(() => import("@/pages/jobs"));
const JobsListPage        = lazy(() => import("@/pages/jobs-list"));
const EmployeesPage       = lazy(() => import("@/pages/employees"));
const EmployeeProfilePage = lazy(() => import("@/pages/employee-profile"));
const AcceptInvitePage    = lazy(() => import("@/pages/accept-invite"));
const CustomersPage       = lazy(() => import("@/pages/customers"));
const CustomerProfilePage = lazy(() => import("@/pages/customer-profile"));
const MessagesPage = lazy(() => import("@/pages/messages"));
const NotificationSettingsPage = lazy(() => import("@/pages/notification-settings"));
const AddClientPage       = lazy(() => import("@/pages/add-client"));
const AddEmployeePage     = lazy(() => import("@/pages/add-employee"));
const InvoicesPage        = lazy(() => import("@/pages/invoices"));
const CompanyPage         = lazy(() => import("@/pages/company"));
const LoyaltyPage         = lazy(() => import("@/pages/loyalty"));
const PayrollPage         = lazy(() => import("@/pages/payroll"));
const TimeClockPage       = lazy(() => import("@/pages/time-clock"));
const MileageReviewPage   = lazy(() => import("@/pages/mileage-review"));
const LeaveReviewPage     = lazy(() => import("@/pages/leave-review"));
const LeaveRequestPage    = lazy(() => import("@/pages/leave-request"));
const CleancyclopediaPage = lazy(() => import("@/pages/cleancyclopedia"));
const HelpPage            = lazy(() => import("@/pages/help"));
const HelpGuidePage       = lazy(() => import("@/pages/help-guide"));
const DiscountsRedirect   = lazy(() => Promise.resolve({ default: () => { window.location.replace((import.meta.env.BASE_URL.replace(/\/$/, "")) + "/company?tab=pricing"); return null; } }));
const MyJobsPage          = lazy(() => import("@/pages/my-jobs"));
const MyJobDetailPage     = lazy(() => import("@/pages/my-job-detail"));
const MyDayPage           = lazy(() => import("@/pages/my-day"));
const OpsTodayPage        = lazy(() => import("@/pages/ops-today"));
const ClockMonitorPage    = lazy(() => import("@/pages/clock-monitor"));
const PortalLoginPage     = lazy(() => import("@/pages/portal/login"));
const PortalDashboardPage = lazy(() => import("@/pages/portal/dashboard"));
const InsightsPage        = lazy(() => import("@/pages/reports/insights"));
const ReportsIndexPage    = lazy(() => import("@/pages/reports/index"));
const RevenueReportPage   = lazy(() => import("@/pages/reports/revenue"));
const RevenueHistoryPage  = lazy(() => import("@/pages/reports/revenue-history"));
const PayrollReportPage   = lazy(() => import("@/pages/reports/payroll"));
const EmployeeStatsPage   = lazy(() => import("@/pages/reports/employee-stats"));
const TipsReportPage      = lazy(() => import("@/pages/reports/tips"));
const DiscountsReportPage = lazy(() => import("@/pages/reports/discounts"));
const FeesReportPage      = lazy(() => import("@/pages/reports/fees"));
const ReceivablesPage     = lazy(() => import("@/pages/reports/receivables"));
const JobCostingPage      = lazy(() => import("@/pages/reports/job-costing"));
const PayrollToRevenuePage= lazy(() => import("@/pages/reports/payroll-to-revenue"));
const EfficiencyPage      = lazy(() => import("@/pages/reports/efficiency"));
const WeekReviewPage      = lazy(() => import("@/pages/reports/week-review"));
const ScorecardsReportPage= lazy(() => import("@/pages/reports/scorecards"));
const QualityEfficiencyReportPage = lazy(() => import("@/pages/reports/quality-efficiency"));
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
const EstimatesPage       = lazy(() => import("@/pages/estimates"));
const EstimateBuilderPage = lazy(() => import("@/pages/estimate-builder"));
const EstimateEngagementPage = lazy(() => import("@/pages/estimate-engagement"));
const EstimatePublicPage  = lazy(() => import("@/pages/estimate-public"));
const QuoteDetailPage     = lazy(() => import("@/pages/quote-detail"));
const QuotingPage         = lazy(() => import("@/pages/quoting"));
const InvoiceDetailPage   = lazy(() => import("@/pages/invoice-detail"));
const PayPage             = lazy(() => import("@/pages/pay"));
const ZonesPage           = lazy(() => import("@/pages/zones"));
const SurveyPage          = lazy(() => import("@/pages/survey"));
const AppointmentPage     = lazy(() => import("@/pages/appointment"));
const RouteSequencesPage  = lazy(() => import("@/pages/route-sequences"));
const ChurnBoardPage      = lazy(() => import("@/pages/intelligence/churn"));
const RetentionBoardPage  = lazy(() => import("@/pages/intelligence/retention"));
const SatisfactionReportPage = lazy(() => import("@/pages/reports/satisfaction"));
const AddOnCatalogPage    = lazy(() => import("@/pages/company/addons"));
const PackagesPage        = lazy(() => import("@/pages/company/packages"));
const CompanyW9Page       = lazy(() => import("@/pages/company/w9"));
const RatesPage           = lazy(() => import("@/pages/company/rates"));
const ReferralReportPage  = lazy(() => import("@/pages/reports/referrals"));
const IncentivesPage      = lazy(() => import("@/pages/reports/incentives"));
const RevenueGoalPage     = lazy(() => import("@/pages/reports/revenue-goal"));
const UpsellConversionPage= lazy(() => import("@/pages/reports/upsell-conversion"));
const MessageLogPage      = lazy(() => import("@/pages/reports/message-log"));
const AccountsPage        = lazy(() => import("@/pages/accounts"));
const RecurringSchedulesPage = lazy(() => import("@/pages/recurring-schedules"));
const AccountDetailPage   = lazy(() => import("@/pages/account-detail"));
const OnboardPage         = lazy(() => import("@/pages/onboard"));
const SignDocPage          = lazy(() => import("@/pages/sign-doc"));
const BookPage            = lazy(() => import("@/pages/book"));
const LeadsPage           = lazy(() => import("@/pages/leads"));
const LeadsPartnersPage   = lazy(() => import("@/pages/leads-partners"));
const LeadsTemplatesPage  = lazy(() => import("@/pages/leads-templates"));
const LeadsReportsPage    = lazy(() => import("@/pages/leads-reports"));
const AllLocationsPage    = lazy(() => import("@/pages/all-locations"));
const AdminDashboard      = lazy(() => import("@/pages/admin/index"));
const AdminCompanies      = lazy(() => import("@/pages/admin/companies"));
const AdminBilling        = lazy(() => import("@/pages/admin/billing"));
const AdminCleancyclopedia= lazy(() => import("@/pages/admin/cleancyclopedia"));
const NotificationsPage   = lazy(() => import("@/pages/notifications"));
const TrainingPage        = lazy(() => import("@/pages/training"));
const LmsAdminPage         = lazy(() => import("@/pages/lms-admin"));
const LmsAdminSettingsPage = lazy(() => import("@/pages/lms-admin-settings"));
const LmsEmployeeJourneyPage = lazy(() => import("@/pages/lms-employee-journey"));
const NotFound            = lazy(() => import("@/pages/not-found"));

// [job-card-redesign] Dev-only visual test page — gated by PROD env.
// Doesn't ship to production: the lazy import only runs when the route
// renders, and the route below is only mounted when import.meta.env.PROD
// is false.
const JobsVisualTestPage  = lazy(() => import("@/pages/jobs-visual-test"));

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

// [tech-boundary 2026-06-17] Sal report: techs could log in on desktop
// and view office surfaces (dispatch, payroll, customers, etc.). The
// login flow already routes techs to /my-jobs after sign-in, but a
// tech who knows a URL — or hits "/" — sees the full office page.
//
// This guard runs at the Router level. When the authenticated user is
// role=technician or team_lead and the current path is NOT in the tech
// allowlist below, redirect to /my-jobs. Owner / admin / office /
// super_admin pass through to the full route.
//
// Allowlist (not denylist) so a forgotten future office route can
// only cost a tech UX bug — never a data leak.
const TECH_ALLOWED_PREFIXES = [
  "/login",
  "/accept-invite",
  "/my-jobs",
  "/my-day",
  "/help",        // Help & Guides — tech guides are mobile-first
  "/training",
  "/leave",
  "/notifications",
  "/settings/notifications",  // tech notification prefs (avatar menu → Notification settings)
  "/pay/",        // token-based payment link
  "/sign/",       // token-based document sign
  "/sign-doc/",   // token-based document sign
  "/onboard/",    // token-based onboarding
  "/book/",       // token-based booking
  "/survey/",     // token-based survey
  "/portal/",     // public client portal
];

function isTechAllowedPath(pathname: string): boolean {
  // /lms is allowed but /lms/admin* is owner/admin only.
  if (pathname.startsWith("/lms/admin")) return false;
  if (pathname === "/lms" || pathname.startsWith("/lms/")) return true;
  // /employees/:id — let techs view their OWN profile only (they hit
  // this via the avatar menu). The page itself self-gates on whether
  // the viewed userId matches the auth userId. Allowing the path here
  // is consistent with how the LMS routes a tech to their own LMS
  // profile page via /lms/admin/employee/:id (admin-only — blocked
  // above) vs the regular /employees/:id (their own self-view).
  // For now, BLOCK /employees/:id on desktop for techs — they can
  // change their password / avatar from the avatar menu modal, which
  // doesn't need the full profile page.
  return TECH_ALLOWED_PREFIXES.some(
    (p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p),
  );
}

function TechRouteGuard({ children }: { children: React.ReactNode }) {
  // The role lives in the JWT, not the auth store (which only holds `token`).
  // Read it via getTokenRole() — the same source the login redirect and the
  // rest of the app use. Subscribe to `token` so the guard re-evaluates when
  // the user logs in / out / switches company.
  const token = useAuthStore((s) => s.token);
  const role = token ? getTokenRole() : null;
  const [location, navigate] = useLocation();
  const isTech = role === "technician" || role === "team_lead";
  const blocked = isTech && !isTechAllowedPath(location);

  useEffect(() => {
    if (blocked) navigate("/my-jobs");
  }, [blocked, navigate]);

  if (blocked) return null;
  return <>{children}</>;
}

// [login-first-entry] Root "/" entry point. The marketing landing no longer
// sits at the app root (see api-server app.ts) — "/" is now the app's front
// door. An unauthenticated visitor (a field tech opening the app especially)
// is sent straight to the login screen instead of any marketing page.
// Authenticated users render the dashboard; the TechRouteGuard above then
// bounces technicians/team_leads to /my-jobs.
function RootIndex() {
  const token = useAuthStore((s) => s.token);
  // [tech-session 2026-06-30] An expired pass is treated as logged-out → the
  // login screen, never a blank authenticated shell. startTokenRefresh (started
  // in App) also clears the dead pass; this makes the redirect synchronous.
  if (!token || isTokenExpired()) return <Redirect to="/login" />;
  return <Dashboard />;
}

function Router() {
  return (
    <Suspense fallback={<PageLoader />}>
      <TechRouteGuard>
      <Switch>
        <Route path="/" component={RootIndex} />
        <Route path="/login" component={Login} />
        <Route path="/accept-invite" component={AcceptInvitePage} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/dispatch" component={JobsPage} />
        {!import.meta.env.PROD && <Route path="/jobs/visual-test" component={JobsVisualTestPage} />}
        {/* [Q2] JobsListPage moved to /reports/jobs. Keep /jobs and /jobs/list
            as redirects for old bookmarks. */}
        <Route path="/jobs"><Redirect to="/reports/jobs" /></Route>
        <Route path="/jobs/list"><Redirect to="/reports/jobs" /></Route>
        <Route path="/reports/jobs" component={JobsListPage} />
        <Route path="/recurring" component={RecurringSchedulesPage} />
        <Route path="/employees/clocks" component={ClockMonitorPage} />
        <Route path="/employees/new" component={AddEmployeePage} />
        <Route path="/employees/:id" component={EmployeeProfilePage} />
        <Route path="/employees" component={EmployeesPage} />
        <Route path="/customers/new" component={AddClientPage} />
        <Route path="/customers/:id" component={CustomerProfilePage} />
        <Route path="/customers" component={CustomersPage} />
        <Route path="/messages" component={MessagesPage} />
        <Route path="/settings/notifications" component={NotificationSettingsPage} />
        <Route path="/invoices/:id" component={InvoiceDetailPage} />
        <Route path="/invoices" component={InvoicesPage} />
        <Route path="/time-clock" component={TimeClockPage} />
        <Route path="/payroll" component={PayrollPage} />
        <Route path="/payroll/mileage-review" component={MileageReviewPage} />
        <Route path="/payroll/leave-review" component={LeaveReviewPage} />
        <Route path="/leave" component={LeaveRequestPage} />
        <Route path="/cleancyclopedia" component={CleancyclopediaPage} />
        <Route path="/help/:slug" component={HelpGuidePage} />
        <Route path="/help" component={HelpPage} />
        <Route path="/company" component={CompanyPage} />
        <Route path="/loyalty" component={LoyaltyPage} />
        <Route path="/discounts" component={DiscountsRedirect} />
        <Route path="/my-jobs/:id" component={MyJobDetailPage} />
        <Route path="/my-jobs" component={MyJobsPage} />
        <Route path="/my-day" component={MyDayPage} />
        <Route path="/ops/today" component={OpsTodayPage} />

        <Route path="/reports" component={ReportsIndexPage} />
        <Route path="/reports/insights" component={InsightsPage} />
        <Route path="/reports/revenue" component={RevenueReportPage} />
        <Route path="/reports/revenue-history" component={RevenueHistoryPage} />
        <Route path="/reports/payroll" component={PayrollReportPage} />
        <Route path="/reports/employee-stats" component={EmployeeStatsPage} />
        <Route path="/reports/tips" component={TipsReportPage} />
        <Route path="/reports/discounts" component={DiscountsReportPage} />
        <Route path="/reports/fees" component={FeesReportPage} />
        <Route path="/reports/receivables" component={ReceivablesPage} />
        <Route path="/reports/job-costing" component={JobCostingPage} />
        <Route path="/reports/payroll-to-revenue" component={PayrollToRevenuePage} />
        <Route path="/reports/efficiency" component={EfficiencyPage} />
        <Route path="/reports/week-review" component={WeekReviewPage} />
        <Route path="/reports/scorecards" component={ScorecardsReportPage} />
        <Route path="/reports/quality-efficiency" component={QualityEfficiencyReportPage} />
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
        <Route path="/company/packages" component={PackagesPage} />
        <Route path="/company/w9" component={CompanyW9Page} />
        <Route path="/company/rates" component={RatesPage} />
        <Route path="/survey/:token" component={SurveyPage} />
        {/* Public customer appointment view — no login, tokenized (booking confirmation link). */}
        <Route path="/appointment/:token" component={AppointmentPage} />
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
        <Route path="/leads/partners" component={LeadsPartnersPage} />
        <Route path="/leads/templates" component={LeadsTemplatesPage} />
        <Route path="/leads/reports" component={LeadsReportsPage} />
        <Route path="/all-locations" component={AllLocationsPage} />
        <Route path="/leads" component={LeadsPage} />
        <Route path="/quotes/new" component={QuoteBuilderPage} />
        <Route path="/quotes/:id/edit" component={QuoteBuilderPage} />
        <Route path="/quotes/:id" component={QuoteDetailPage} />
        <Route path="/quotes" component={QuotesPage} />

        <Route path="/estimates/new" component={EstimateBuilderPage} />
        <Route path="/estimates/engagement" component={EstimateEngagementPage} />
        <Route path="/estimates/:id" component={EstimateBuilderPage} />
        <Route path="/estimates" component={EstimatesPage} />
        {/* Public hosted estimate — no login, tokenized (like /pay/:token). */}
        <Route path="/estimate/:token" component={EstimatePublicPage} />
        {/* Residential quotes share the hosted page; it self-labels as "Quote" via is_quote. */}
        <Route path="/quote/:token" component={EstimatePublicPage} />

        <Route path="/book/:slug" component={BookPage} />
        <Route path="/pay/:token" component={PayPage} />
        <Route path="/sign/:token" component={SignPage} />
        <Route path="/onboard/:token" component={OnboardPage} />
        <Route path="/sign-doc/:token" component={SignDocPage} />

        <Route path="/notifications" component={NotificationsPage} />

        <Route path="/training" component={TrainingPage} />
        <Route path="/lms/admin/settings" component={LmsAdminSettingsPage} />
        <Route path="/lms/admin/employee/:userId" component={LmsEmployeeJourneyPage} />
        <Route path="/lms/admin" component={LmsAdminPage} />
        <Route path="/lms" component={TrainingPage} />

        <Route path="/admin" component={AdminDashboard} />
        <Route path="/admin/companies" component={AdminCompanies} />
        <Route path="/admin/billing" component={AdminBilling} />
        <Route path="/admin/cleancyclopedia" component={AdminCleancyclopedia} />

        <Route component={NotFound} />
      </Switch>
      </TechRouteGuard>
    </Suspense>
  );
}

function App() {
  // [tech-session 2026-06-30] Start the login-pass keep-alive on app open. It
  // slides the pass forward each open (active techs never run it out) and, if a
  // pass has gone fully stale, logs out to the login screen instead of leaving
  // them on a blank "No jobs today". Previously defined but never called.
  useEffect(() => {
    const interval = startTokenRefresh();
    return () => { if (interval) clearInterval(interval); };
  }, []);

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
