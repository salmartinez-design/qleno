# Qleno — Project Rules for Claude Code

## Project
- **Name:** Qleno — multi-tenant SaaS for residential cleaning businesses
- **Company:** Phes (never PHES Cleaning, never Phes Cleaning, never CleanOps Pro)
- **Live app:** https://workspaceapi-server-production-b9d4.up.railway.app
- **GitHub:** salmartinez-design/clean-ops-pro, branch main
- **Replit:** clean-ops-pro.replit.app — backup only, do not deploy from here

## Tech Stack
- Frontend: React 18, Tailwind CSS, Vite, Wouter (routing)
- Backend: Node.js, Express 5, TypeScript
- Database: Supabase Postgres, RLS enabled, Drizzle ORM, multi-tenant scoped by company_id
- Payments: Stripe (new bookings), Square (existing Phes clients only)
- Comms: Twilio (SMS), Resend (email)
- Hosting: Railway (production), auto-deploys from GitHub main

## Brand & Design System — NON-NEGOTIABLE
- Font: Plus Jakarta Sans ONLY — never any other font
- Background: #F7F6F3
- Cards: #FFFFFF
- Primary text: #1A1917
- Borders: #E5E2DC
- Accent: Electric Mint #00C9A0, Qleno Night #0A0E1A
- No dark mode — ever
- No emojis anywhere in the UI

## Pricing
- Solo: $100/mo
- Team: $200/mo (2–15 employees)
- Pro: $250/mo (16+ employees)

## Branch Routing
- `getBranchByZip` routes all comms (SMS, email, assignments) to Oak Lawn vs Schaumburg based on zip code
- Every communication must go through this function — never hardcode a branch

## Hard Rules — Never Reverse
- No QuickBooks bidirectional sync — QB is write-only (Qleno pushes to QB, never pulls)
- Square is for existing Phes clients only — new bookings always use Stripe
- Schaumburg branch does NOT migrate from MaidCentral
- Seed files must always use ON CONFLICT DO UPDATE — never plain INSERT
- COMMS_ENABLED=false gate must never be bypassed — all SMS and email are suppressed until explicitly flipped to true in Railway env vars
- EXCEPTION: Contact form at /api/contact must bypass COMMS_ENABLED gate — it is a direct inbound lead, not an automated communication
- Never mix the Ares project with Qleno/Phes

## Database Rules
- All data scoped by company_id — every query must filter by company_id
- Always dry-run before any destructive DB operation
- RLS is enabled on Supabase — test queries with the correct role

## Known Bugs — Fix Before May 12
1. ~~Booking widget add-on ID mapping~~ — FIXED (dynamic lookup by name)
2. ~~Zone check failing for valid zips (e.g. 60805)~~ — FIXED (branchRouter updated)
3. Loyalty discount auto-applying with no code entered — OPEN (discount migration will fix)
4. Recurring job anchor dates landing on Monday instead of correct day — OPEN (timezone bug in parseDate)
5. ~~"Cook County" prefix showing in address display~~ — FIXED (no such logic exists)
6. ~~Callback button not clickable on Very Dirty flow~~ — FIXED (fully functional)
7. ~~"onetime" showing instead of "One Time" in booking summary~~ — FIXED (wLabel mapper)

## Session Notes — 2026-04-16
### Quote Builder Changes
- Wizard step order: Customer Info → Service & Pricing → Property Details → Add-ons & Notes → Review
- Quick Re-Book panel on Service & Pricing step (shows last 3 services for existing clients)
- Scopes grouped by: One-Time/Flat Rate, Recurring, Hourly, Commercial
- Hourly = single card with sub-type selector (Standard, Deep Clean, Move In/Out, Other)
- Commercial hidden for residential clients (filtered by client_type)
- Schedule & Assign section on Review step (date picker, time dropdown, tech pills)
- Convert endpoint creates actual job with date/time/tech assignment
- Address verification skipped for existing clients with known addresses
- Google Maps API key must be passed to Vite build: `source .env && GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY pnpm run build`

### Commission System
- calculateCommissionSplit() utility at artifacts/cleanops-pro/src/lib/commission.ts
- 35% rate, equal split pre-clock-in, proportional by minutes after clock-in
- Displayed in Price Preview sidebar (single and multi-scope)
- Still needs: quote detail, job detail, dispatch board, My Jobs (tech view)

### Zone Colors
- All 18 zones synced to MaidCentral colors (2026-04-16)
- Zone dots in global search and quote builder client search
- Duplicate zone: "Tinley/Orland Park/Palos Park" vs "Tinley/Orlando/Palos Park" — clean up

### Pending Next Sessions
1. Discount Migration from MaidCentral (25 rows across 6 scopes, replace placeholders)
2. Jobs Page Full Build + Dispatch KPI Strip (full spec saved)
3. Frequency change revenue impact display (monthly/annual gain/loss)
4. Smart tech availability check (fires after date selected in Review)
5. UI cleanup: inline address verification, collapsible call notes
6. Recurring job timezone bug fix (parseDate local vs UTC)

## Dev Workflow
- Edit locally in Claude Code
- Verify changes work at localhost:3000 before pushing
- Push to GitHub: `bash push-to-github.sh 'message'`
- Railway auto-deploys from main branch — no manual deploy needed

## Scoped-commit discipline (when the working tree has unrelated uncommitted work)

This session has often had uncommitted work from prior prompts sitting in the working tree. Commits for a new prompt must NOT sweep up that unrelated work. The naive `git stash --keep-index` pattern is not enough on its own — here's the correct workflow:

**Problem:** `git stash --keep-index -u` only moves UNSTAGED changes. If you run `git add file.ts` on a file that already has uncommitted changes, those older changes go into the index alongside your new ones and end up in the commit.

**Correct workflow for scoped commits when working tree has unrelated uncommitted work:**

1. `git status --short` — inventory everything unclean
2. **For files where your new work is co-mingled with prior uncommitted work** (e.g. you added a column to a schema file that also has 148 other uncommitted lines from Session 1):
   - `git checkout HEAD -- <file>` — discard ALL uncommitted changes in that file (they go to /tmp or the other backups, not the stash — you lose them if you don't save first)
   - BEFORE the checkout, copy the file elsewhere: `cp <file> /tmp/<file>.full`
   - Re-apply ONLY your new hunks via Edit
   - After commit succeeds: `cp /tmp/<file>.full <file>` to restore the co-mingled state
3. **For files where your new work is the only change**, just `git add <file>` directly — safe
4. Once all target files are staged cleanly, `git stash push --keep-index -u -m "prompt-N-stash"` stashes everything else
5. `git diff --cached --stat` — sanity check shows ONLY expected files + line counts
6. If the stat looks wrong (extra files or inflated line counts), STOP and unstage
7. Commit + push
8. `git stash pop` to restore the other uncommitted work

**Never trust the stash to protect files that had both staged and unstaged changes simultaneously.** The staged content stays in the index; the stash only captures the unstaged portion. You end up committing content you didn't intend to.

**Quick check:** after `git add` and before `git stash`, run `git diff --cached --stat`. If a file shows +150 lines when you only wrote 3, you have a co-mingled file. Fix it before stashing.

This workflow has been followed cleanly in commits: 7d1c836, d21db36, 7f27299, 1f3d7d2.

## Start Local Dev
- Tab 1 (API): `PORT=5000 BASE_PATH=/ npx tsx --env-file=.env artifacts/api-server/src/index.ts`
- Tab 2 (Frontend build): `cd artifacts/cleanops-pro && PORT=5000 BASE_PATH=/ pnpm run build`
- Tab 3 (Serve): `npx serve artifacts/cleanops-pro/dist/public -p 3000`
- View at: http://localhost:3000

## Environment
- `COMMS_ENABLED=false` in Railway env vars — do not change without explicit instruction
- `DATABASE_URL` points to Railway Postgres — never copy dev DB to production
- `PORT` is injected by Railway at runtime — do not hardcode
