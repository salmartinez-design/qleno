# Commit O — En-dash restoration (time range dividers)

- **Timestamp:** 2026-04-22 CT (America/Chicago)
- **Operator:** Claude Code (Sal flipped en-dash preference between prompts)
- **Company:** PHES (company_id=1)
- **Engine flag:** false across all 4 tenants (unchanged)

## Headline

Tiny surgical commit — 2 characters changed. The "Phase 2 execution" prompt arrived after M + N had already shipped all 5 items it called for, with one small delta: the en-dash preference flipped between Sal's two prompts.

## What's already done (M + N)

This prompt's work was effectively covered by the prior two commits:

| Item in this prompt | Status | Where |
|---|---|---|
| Fix A — replace `\u2013` literal | ✅ Done in M (used ASCII `-` per M's prompt) | `jobs.tsx:1286` |
| Fix B — `allowed_hours` backfill | ✅ Done in N (983 rows updated) | DB transaction |
| Fix C — remove hover card stopPropagation | ✅ Done in M | `jobs.tsx:1263` (formerly 1259) |
| Fix D — `/jobs` → `JobsListPage` | ✅ Done in N | `App.tsx:106` |
| Sidebar Jobs entry stays | ✅ Restored in N | `app-sidebar.tsx:48` |

Current verified state from HEAD (dc550ea..HEAD):

```
app-sidebar.tsx:48   { title: "Jobs", url: "/jobs", icon: Briefcase }
App.tsx:106          <Route path="/jobs" component={JobsListPage} />
App.tsx:107          <Route path="/jobs/list" component={JobsListPage} />
jobs.tsx:1263        <div style={{...}}>    (no stopPropagation — native bubble works)
```

Database:
- 983 / 983 MC-imported `jobs` rows have `allowed_hours` populated
- All 4 tenant engine flags false

## The one remaining delta — en-dash preference

M's prompt explicitly said:

> Recommend using ASCII hyphen `-` to avoid any encoding issues.

I followed that, changing both line 1286 and line 1413 to `-`.

This prompt says:

> Recommend: use literal "–" character (U+2013) directly in the text. If editor encoding issues, fall back to `{' – '}` expression form like line 1403 does.

**Reverse of M's guidance.** Typographic preference is legitimate (en-dash is the right character for a time range like "10:00 AM – 12:00 PM" per typography conventions), but produces a slightly different visual. Restoring to en-dash per the latest call.

## Fix applied — 2 characters changed

`artifacts/qleno/src/pages/jobs.tsx`:

```diff
 -          <div style={{...}}>{fmtTime(job.scheduled_time)} - {fmtTime(endTime)}</div>
 +          <div style={{...}}>{fmtTime(job.scheduled_time)} – {fmtTime(endTime)}</div>
   ... (line 1296)

 -          {fmtSvc(job.service_type)} · {fmtTime(job.scheduled_time)} - {fmtTime(...)}
 +          {fmtSvc(job.service_type)} · {fmtTime(job.scheduled_time)} – {fmtTime(...)}
   ... (line 1413)
```

Literal U+2013 EN DASH character directly in the JSX text node. Works correctly because JSX text can contain any Unicode codepoint — the earlier bug was specifically `\u2013` as an **escape sequence string**, not a real en-dash character. `\u` escapes only work inside quoted strings or JS expressions; between `>` and `<` in JSX they render literally. Direct Unicode characters render as themselves.

## Typecheck

No change expected (character swap only). 166 baseline → 166 after O.

## What did NOT change

- Click handler (already fixed in M)
- Sidebar (already restored in N)
- `/jobs` route (already pointed at JobsListPage in N)
- `allowed_hours` (already backfilled on 983 rows in N)
- Database — zero writes in this commit
- Engine flag — false across all 4 tenants

## Verification

After Railway redeploys:

- `/dispatch?date=2026-04-23` — hover any chip. Time field now reads `10:00 AM – 12:00 PM` with a proper en-dash (wider than a hyphen, typographically correct for a range).
- Chip labels (where width > 130px) also show `Service · 10:00 AM – 12:00 PM` with en-dash.
- Everything else (click opens drawer, layout, sidebar, /jobs list view, Gantt durations) — unchanged from M+N behavior.

## Rollback

If en-dash renders wrong in any environment:

```diff
- – (U+2013 EN DASH)
+ - (ASCII hyphen)
```

Revert the 2-line diff via `git revert HEAD` restores M's ASCII-hyphen state. The underlying bug (literal `\u2013` escape string) is fixed regardless — neither en-dash nor hyphen would regress to that.

## Commit chain today

| SHA | Commit |
|---|---|
| `0354e57` | L4 — MC dispatch import (983 jobs) |
| `54b5420` | M — sidebar removal + hover card fixes (A/B/C/D with ASCII hyphen) |
| `26a748f` | N — restore Jobs sidebar + repoint to list + allowed_hours backfill |
| (this) | O — en-dash restoration (Sal flipped preference) |

## Constraint maintained

- Engine flag **false** across all 4 tenants
- No DB writes
- No backend code changes
- No engine re-enable
