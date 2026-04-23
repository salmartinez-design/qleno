# Commit P — Consolidate sidebar to single "Jobs" entry

- **Timestamp:** 2026-04-22 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved)
- **Company:** PHES (company_id=1)
- **Engine flag:** false across all 4 tenants (unchanged)

## Commit-letter note

Sal's prompt requested commit letter **O**, but `O` was already used at `e80e74c` for the en-dash restoration. Renamed to **P** to preserve the monotonic history. Content matches the prompt exactly; only the letter differs.

## Headline

Sidebar previously had two entries ("Dispatch Board" at `/dispatch`, "Jobs" at `/jobs`) that many people conflate. Consolidated to a single **"Jobs"** entry with the Briefcase icon, pointing at `/dispatch` as the default (Gantt) view. Page header for both `/dispatch` and `/jobs` now reads "Jobs" to match the nav label.

## Changes

### 1. `artifacts/qleno/src/components/layout/app-sidebar.tsx`

Three edits:

**(a) Removed `CalendarDays` import** — no longer referenced anywhere in this file after Dispatch Board entry deleted.

```diff
 import {
-  LogOut, X, LayoutDashboard, CalendarDays,
+  LogOut, X, LayoutDashboard,
   Briefcase, Users, UserCheck, FileText, DollarSign,
   ...
 } from "lucide-react";
```

**(b) Merged Operations nav items** — "Dispatch Board" + "Jobs" → single "Jobs" at `/dispatch`.

```diff
 { title: "Dashboard",      url: "/dashboard",  icon: LayoutDashboard },
- { title: "Dispatch Board", url: "/dispatch",    icon: CalendarDays },
- { title: "Jobs",           url: "/jobs",       icon: Briefcase },
+ { title: "Jobs",           url: "/dispatch",   icon: Briefcase },
 { title: "Customers",      url: "/customers",  icon: Users },
```

**(c) Added `MULTI_URL_HIGHLIGHT` for active-state** — so the single "Jobs" entry highlights when the user is on `/dispatch`, `/jobs`, OR `/jobs/list`.

```diff
 const EXACT_MATCH_URLS = ['/dashboard', '/company', '/dispatch', '/jobs'];
-const isActive = (url: string) =>
-  EXACT_MATCH_URLS.includes(url)
+const MULTI_URL_HIGHLIGHT: Record<string, string[]> = {
+  '/dispatch': ['/dispatch', '/jobs', '/jobs/list'],
+};
+const isActive = (url: string) => {
+  const extras = MULTI_URL_HIGHLIGHT[url];
+  if (extras) return extras.some(u => location === u || location.startsWith(u + '/'));
+  return EXACT_MATCH_URLS.includes(url)
     ? location === url
     : location === url || location.startsWith(url + '/');
+};
```

Lightweight pattern — the existing nav-item shape (plain object literal, no TS interface) stays intact; the `matchUrls` concept lives in a separate lookup keyed by the item's `url`. Zero callsite changes.

### 2. `artifacts/qleno/src/components/layout/dashboard-layout.tsx`

Single-line change: the page-header title mapping.

```diff
 const ROUTE_TITLES: Record<string, string> = {
   '/dashboard':                    'Dashboard',
-  '/dispatch':                     'Dispatch Board',
+  '/dispatch':                     'Jobs',
   '/jobs':                         'Jobs',
   ...
 };
```

Both `/dispatch` (Gantt) and `/jobs` (list) now render "Jobs" in the page header — matches the single sidebar label.

### 3. `artifacts/qleno/src/App.tsx` — NO change

Keeping all three routes intact per prompt:

```
<Route path="/dispatch"  component={JobsPage} />         // Gantt (default when clicking sidebar)
<Route path="/jobs"      component={JobsListPage} />     // flat list
<Route path="/jobs/list" component={JobsListPage} />     // alias
```

Any existing bookmarks to `/jobs` or `/jobs/list` continue to resolve to the list view.

## What stays the same

- `jobs.tsx` (the Gantt component itself) — untouched, no "Dispatch Board" string to change (it was in dashboard-layout.tsx all along)
- `/api/dispatch` endpoint — untouched
- `company.tsx:530` "Dispatch Board Hours" — left as-is. This is a domain-specific settings section about dispatch operating hours, not user-facing nav. Distinct concept from the nav label.
- `keyboard-shortcuts.tsx:11` `{ key: 'D', label: 'Dispatch Board', path: '/jobs' }` — left as-is. Out of scope (Sal didn't mention keyboard shortcuts). **Flagging for Sal**: if rebrand should be total, this label should also become "Jobs" — it's shown in the keyboard shortcuts overlay (Cmd+K or similar).
- `dashboard-layout.tsx:70` `{ href: '/dispatch', icon: CalendarDays, label: 'Schedule' }` — mobile bottom tab. Uses "Schedule" not "Dispatch Board" or "Jobs", so it's already distinct. Left as-is.

## Typecheck

| Check | Count |
|---|---:|
| `tsc --noEmit` errors (qleno frontend) baseline | 166 |
| After this commit | **166** |

Zero new errors.

## Verification plan for Sal

After Railway redeploys from this push:

1. **Sidebar** — reload `app.qleno.com`. Under "Operations":
   - Dashboard / **Jobs** (Briefcase icon) / Customers / Accounts / Employees
   - No separate "Dispatch Board" entry
2. **Click Jobs** in sidebar → lands at `/dispatch` → Gantt board renders
3. **Page header** reads "Jobs" (instead of "Dispatch Board"), branch selector still present next to it
4. **Active highlight** — "Jobs" entry stays highlighted (colored accent bar) whether you're on `/dispatch`, `/jobs`, or `/jobs/list`
5. **Direct URLs still resolve**:
   - `app.qleno.com/dispatch` → Gantt (same as clicking sidebar)
   - `app.qleno.com/jobs` → flat list view
   - `app.qleno.com/jobs/list` → flat list view (alias)
6. **All prior fixes intact**: hover card still shows en-dash time range, click still opens drawer, allowed_hours backfill still populated, 983 MC jobs still visible with true Gantt durations

## Rollback

```bash
git revert HEAD
```

Restores the two separate sidebar entries and the "Dispatch Board" header. No DB changes to revert.

## Files changed

```
artifacts/qleno/src/components/layout/app-sidebar.tsx    | 28 ++++++++++++++++------
artifacts/qleno/src/components/layout/dashboard-layout.tsx |  2 +-
```

+22 / −8 total. Two frontend files. Zero DB writes. Zero backend changes.

## Commit chain today

| SHA | Commit |
|---|---|
| `0354e57` | L4 — MC dispatch import (983 jobs) |
| `54b5420` | M — hover card fixes + (misdirected) sidebar removal |
| `26a748f` | N — restore Jobs sidebar + allowed_hours backfill |
| `e80e74c` | O — en-dash restoration |
| (this) | **P** — consolidate sidebar to single "Jobs" entry |

## Constraint maintained

- Engine flag **false** across all 4 tenants
- No `jobs` writes
- No `job_history` writes
- No `recurring_schedules` writes
- No `clients` / `users` writes
- No backend code changes
- No engine re-enable
