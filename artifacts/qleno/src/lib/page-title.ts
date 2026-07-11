// [tab-titles 2026-07-11] Central browser-tab title resolution, shared by App's
// global <TitleManager/> (which titles EVERY route, including the pages that
// render OUTSIDE DashboardLayout — quote builder, my-day, my-jobs, ops, training,
// booking, portal, survey…) and DashboardLayout (which layers a per-page
// override on top). Kept dependency-free so App doesn't pull the heavy layout
// module into the main bundle.
//
// Previously the title effect lived only inside DashboardLayout, so any page not
// wrapped in it kept the bare "Qleno" tab — the "only some tabs have a name"
// problem. Now no tab is ever a bare "Qleno" (Francisco: names on the tabs).

export const ROUTE_TITLES: Record<string, string> = {
  '/dashboard':                    'Dashboard',
  '/dispatch':                     'Jobs',
  '/jobs':                         'Jobs',
  '/my-jobs':                      'My Jobs',
  '/leave':                        'Time Off',
  '/employees':                    'Employees',
  '/employees/clocks':             'Clock Monitor',
  '/customers':                    'Customers',
  '/invoices':                     'Invoices',
  '/payroll':                      'Payroll',
  '/cleancyclopedia':              'Cleancyclopedia',
  '/loyalty':                      'Loyalty',
  '/company':                      'Company Settings',
  '/leads':                        'Lead Pipeline',
  '/reports':                      'Reports',
  '/reports/insights':             'Core KPIs',
  '/reports/revenue':              'Revenue Summary',
  '/reports/payroll':              'Payroll Summary',
  '/reports/employee-stats':       'Employee Stats',
  '/reports/tips':                 'Tips Report',
  '/reports/receivables':          'Accounts Receivable',
  '/reports/job-costing':          'Job Costing',
  '/reports/payroll-to-revenue':   'Payroll % Revenue',
  '/reports/efficiency':           'Schedule Efficiency',
  '/reports/week-review':          'Week in Review',
  '/reports/scorecards':           'Scorecards',
  '/reports/cancellations':        'Cancellations',
  '/reports/contact-tickets':      'Contact Tickets',
  '/reports/hot-sheet':            'Hot Sheet',
  '/reports/first-time':           'First Time In',
  '/company/zones':                'Service Zones',
  '/company/rates':                'Rates & Add-ons',
  '/notifications':                'Notifications',
  '/accounts':                     'Accounts',
  '/estimates':                    'Estimates',
  '/estimates/engagement':         'Estimate Engagement',
  '/quotes':                       'Quotes',
  '/discounts':                    'Discounts',
  '/messages':                     'Messages',
  '/my-day':                       'My Day',
  '/my-pay':                       'My Pay',
  '/help':                         'Help & Guides',
  '/lms':                          'Training',
  '/lms/admin':                    'Training Admin',
  '/time-clock':                   'Time Clock',
  '/all-locations':                'All Locations',
  '/leads/partners':               'Lead Partners',
  '/leads/reports':                'Lead Reports',
  '/leads/templates':              'Lead Templates',
  '/payroll/leave-review':         'Leave Review',
  '/payroll/mileage-review':       'Mileage Review',
  // [tab-titles 2026-07-11] Office pages that render outside DashboardLayout and
  // used to fall through to a bare "Qleno".
  '/recurring':                    'Recurring Schedules',
  '/route-sequences':              'Route Sequences',
  '/ops/today':                    "Today's Ops",
  '/intelligence/churn':           'Churn Risk',
  '/intelligence/retention':       'Retention',
  '/training':                     'Training',
  '/book':                         'Book a Cleaning',
  '/onboard':                      'Onboarding',
  '/login':                        'Login',
};

// Trailing path segments to drop when resolving a parent section, so
// /customers/123, /quotes/210/edit, /employees/new all resolve to their section.
const STRIP_TAIL = new Set(['edit', 'new', 'view', 'create']);
const isId = (s: string) => /^\d+$/.test(s) || /^[0-9a-f-]{8,}$/i.test(s);

// Resolve a descriptive tab title for ANY path. Order: exact map hit → parent
// section after stripping trailing ids/verbs → title-cased last segment →
// 'Qleno' only when there's genuinely nothing to name.
export function routeTitle(location: string): string {
  const path = (location || '/').split('?')[0].split('#')[0];
  if (ROUTE_TITLES[path]) return ROUTE_TITLES[path];
  const segs = path.split('/').filter(Boolean);
  while (segs.length && (isId(segs[segs.length - 1]) || STRIP_TAIL.has(segs[segs.length - 1].toLowerCase()))) {
    segs.pop();
  }
  const parent = '/' + segs.join('/');
  if (ROUTE_TITLES[parent]) return ROUTE_TITLES[parent];
  const last = segs[segs.length - 1];
  if (last) return last.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return 'Qleno';
}

// Final document.title string. `override` is a page-supplied title (e.g. a
// customer's name) that wins over the route map; falls back to routeTitle.
export function computeTitle(location: string, override?: string | null): string {
  const pt = override && override.trim() ? override : routeTitle(location);
  return pt === 'Qleno' ? 'Qleno' : `${pt} — Qleno`;
}
