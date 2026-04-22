# Commit M — UI bugfix sweep: sidebar + dispatch hover card + click handler

- **Timestamp:** 2026-04-22 CT (America/Chicago)
- **Operator:** Claude Code (Sal approved Option B — remove Jobs from sidebar)
- **Company:** PHES (company_id=1)
- **Engine flag:** false across all 4 tenants (unchanged)

## Scope

Four user-visible bugs surfaced during Dispatch Board verification after the L4 MC dispatch import landed:

| Bug | File | Root cause | Fix |
|---|---|---|---|
| A | `jobs.tsx:1296` | Bare JSX text `\u2013` rendered as literal 6-char string | ASCII hyphen `-` |
| B | `jobs.tsx:1296` | Aggravated by A: broken time wrap made layout look overlapped | Same fix as A resolves visual |
| C | `jobs.tsx:1258` | Hover card's `onClick={e => e.stopPropagation()}` swallowed clicks with no action | Removed stopPropagation; added it to phone anchor only |
| D | `app-sidebar.tsx:48` | Jobs entry in sidebar routed to same Gantt as Dispatch Board — confusing | Removed Jobs entry from sidebar (routes still exist in App.tsx) |

All changes are in 2 files, 4 targeted edits. Zero new TypeScript errors (166 baseline → 166 with fixes).

## Fix 1 — Remove "Jobs" from sidebar nav

`artifacts/qleno/src/components/layout/app-sidebar.tsx`

Deleted the Jobs entry from `NAV_SECTIONS[0].items` and cleaned up the now-orphaned `Briefcase` lucide import.

```diff
 import {
   LogOut, X, LayoutDashboard, CalendarDays,
-  Briefcase, Users, UserCheck, FileText, DollarSign,
+  Users, UserCheck, FileText, DollarSign,
   ...
 } from "lucide-react";

 { title: "Dashboard",      url: "/dashboard",  icon: LayoutDashboard },
 { title: "Dispatch Board", url: "/dispatch",    icon: CalendarDays },
- { title: "Jobs",           url: "/jobs",       icon: Briefcase },
+ // [2026-04-22] Jobs entry removed — same view as Dispatch Board, was
+ // confusing. /jobs and /jobs/list routes still exist in App.tsx so any
+ // external links continue to resolve.
 { title: "Customers",      url: "/customers",  icon: Users },
```

**Kept intact in App.tsx** (not touched in this commit):
- `<Route path="/jobs" component={JobsPage} />` — if external link references `/jobs`, it still resolves
- `<Route path="/jobs/list" component={JobsListPage} />` — flat list view, direct URL only
- `EXACT_MATCH_URLS = ['/dashboard', '/company', '/dispatch', '/jobs']` — harmless dead entry, doesn't cost anything

## Fix 2 — Hover card `\u2013` literal → ASCII hyphen

`artifacts/qleno/src/pages/jobs.tsx:1296`

The bug was bare JSX text, not a string literal:

```diff
- <div style={...}>{fmtTime(job.scheduled_time)} \u2013 {fmtTime(endTime)}</div>
+ <div style={...}>{fmtTime(job.scheduled_time)} - {fmtTime(endTime)}</div>
```

JSX interprets `\u2013` as a unicode escape **only** when it appears inside quoted attribute values or inside JS expressions. In bare text nodes, the 6 characters `\u2013` render literally. Sal saw "9:00 AM \u2013 11:00 AM" on the hover card as a result.

Also normalized the chip label (line 1406) to use ASCII hyphen for consistency — it was using a real en-dash `–` character that rendered fine but differed from the hover card after fixing line 1296:

```diff
- {fmtSvc(job.service_type)} · {fmtTime(job.scheduled_time)} – {fmtTime(minsToStr(timeToMins(...)))}
+ {fmtSvc(job.service_type)} · {fmtTime(job.scheduled_time)} - {fmtTime(minsToStr(timeToMins(...)))}
```

Per Sal's preference — ASCII hyphens everywhere, no unicode encoding gotchas.

## Fix 3 — Phone / time layout (resolved by Fix 2)

`JobHoverCard` structure at jobs.tsx:1258-1349:

```
Header div (block):
  client_name (div, block)
  address (div, block, if present)
  phone (<a>, inline-after-block → starts new line)

Grid div (2-column, auto-sized rows):
  Service   | Frequency
  Time      | Duration
  Amount    | Clock Status

... team section, notes section, "Click to open full details" footer
```

The phone and time were already in separate stacked containers. What Sal saw as "phone overlapping time" was the 24-char literal `10:00 AM \u2013 12:00 PM` text wrapping inside the 136px-wide Time cell, distorting the grid layout visually. After Fix 2 shortens "Time" to ~18 chars (`10:00 AM - 12:00 PM`), the cell fits in a single line and the visual is clean.

No additional JSX changes were needed for Fix 3.

## Fix 4 — Click handler on hover card

`artifacts/qleno/src/pages/jobs.tsx:1258`

The hover card said "Click to open full details" but its own root div called `e.stopPropagation()` on click without performing any action. Clicks on the hover card were caught and killed; they never bubbled to the parent `JobChip` which has the `onClick(job)` handler that opens `JobPanel`.

```diff
 return (
-  <div onClick={e => e.stopPropagation()} style={{
+  // [2026-04-22] Removed onClick={e => e.stopPropagation()} — it was
+  // swallowing clicks on the hover card without performing the advertised
+  // "Click to open full details" action. Native click-bubble now carries
+  // the event up to the parent JobChip which opens the drawer.
+  // Phone anchor still calls e.stopPropagation() below to preserve tel:
+  // dialing without triggering the drawer.
+  <div style={{
     position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 100,
     ...
   }}>
```

Native click-bubble now carries clicks from the hover card up to the parent `JobChip` div, whose `onClick={e => { e.stopPropagation(); setHovered(false); onClick(job); }}` fires and opens the drawer.

### Preserve phone tel: link without side-effect

Removing the hover card's stopPropagation means clicking the phone link would now ALSO trigger the chip's `onClick` (opening the drawer after dialing). Not desirable. Added a targeted stopPropagation to just the phone anchor:

```diff
 {job.client_phone && (
-  <a href={`tel:${job.client_phone}`} style={{...}}>
+  <a
+    href={`tel:${job.client_phone}`}
+    onClick={e => e.stopPropagation()}
+    style={{...}}
+  >
     {job.client_phone}
   </a>
 )}
```

Net: clicking the hover card (anywhere except phone) opens the drawer. Clicking phone dials and does nothing else.

## TypeScript & lint check

| Check | Before | After | Δ |
|---|---:|---:|---:|
| `tsc --noEmit` error count | 166 | **166** | **0** |
| Errors in the 2 touched files | app-sidebar.tsx:238 (pre-existing union-type narrowing on optional `badge`) | same line, same error | 0 new |

Pre-existing error in app-sidebar.tsx is a `badge` field accessed on a union where only one variant has it (the Leads entry). It existed before this commit and is unaffected by removing the Jobs line.

## Files changed

```
artifacts/qleno/src/components/layout/app-sidebar.tsx  |  6 ++++--
artifacts/qleno/src/pages/jobs.tsx                     | 18 ++++++++++++++----
```

+18 / −6 total. 4 targeted edits. Zero new untouched code.

## Verification plan for Sal

After Railway deploys (auto from main push):

1. **Sidebar**: reload `app.qleno.com` → left nav should show Dashboard / Dispatch Board / Customers / Accounts / Employees under Operations. No "Jobs" entry.
2. **Hover card time**: go to `/dispatch?date=2026-04-23`, hover any job chip → Time field should read `10:00 AM - 12:00 PM` (or similar, ASCII hyphen, no `\u2013`).
3. **Hover card layout**: same dispatch view, hover a chip with a phone (e.g. Mackenzie Dongmo singleton on Apr 24-25 range) → header shows name / address / phone on separate lines, grid below shows clean 2-col time/duration/amount/clock.
4. **Click handler**:
   - Click any job chip (any status, any visible area including the hover card) → `JobPanel` drawer slides in on the right with client / address / tech / base_fee / scheduled date.
   - Click the phone number in the hover card → browser asks to dial (tel: link). Drawer does NOT open.
5. **Direct URL `/jobs`** (if Sal tries): still resolves, still shows the Gantt (route intact). Nothing broken.

## What did NOT change

- `/jobs` route in App.tsx — still points at JobsPage (Gantt). Kept for any external links.
- `/jobs/list` route in App.tsx — still points at JobsListPage (flat list).
- `JobsPage` structure — no behavior changes, just 3 one-character text normalizations.
- `JobsListPage` — untouched.
- Dispatch Board backend (`dispatch.ts`) — untouched.
- Database — no writes in this commit. `jobs`, `job_history`, `recurring_schedules`, `clients`, `users` all unchanged.
- Engine flag — still `false` across all 4 tenants.

## Bonus finding (NOT fixed in this commit)

During Phase 1 diagnosis I noticed that my L4 INSERT populated `jobs.estimated_hours` but NOT `jobs.allowed_hours`. The Dispatch endpoint (`artifacts/api-server/src/routes/dispatch.ts:53`) reads `allowed_hours` to compute `durationMinutes` (defaults to 120 when NULL). So all 983 MC-imported jobs render as 2-hour blocks on the Gantt regardless of MC's actual `Alwd. Hours`.

This is a separate L4 cleanup — one UPDATE away from fixed:

```sql
UPDATE jobs
   SET allowed_hours = estimated_hours
 WHERE company_id = 1
   AND mc_job_id IS NOT NULL
   AND allowed_hours IS NULL
   AND estimated_hours IS NOT NULL;
-- expect ~983 rows
```

**Not included in M** — Sal's call whether to run this as a separate N commit or merge into the next data commit.

## Commit chain

| SHA | Commit | Notes |
|---|---|---|
| `0354e57` | feat(migration): L4 MC dispatch import | Jobs table populated |
| (this) | fix(ui): M — remove Jobs sidebar + hover card unicode/click fixes | 2 files / 4 edits |
