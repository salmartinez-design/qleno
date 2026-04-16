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
- Never mix the Ares project with Qleno/Phes

## Database Rules
- All data scoped by company_id — every query must filter by company_id
- Always dry-run before any destructive DB operation
- RLS is enabled on Supabase — test queries with the correct role

## Known Bugs — Fix Before May 12
1. Booking widget add-on ID mapping is wrong
2. Zone check failing for valid zips (e.g. 60805)
3. Loyalty discount auto-applying with no code entered
4. Recurring job anchor dates landing on Monday instead of correct day
5. "Cook County" prefix showing in address display
6. Callback button not clickable on Very Dirty flow
7. "onetime" showing instead of "One Time" in booking summary

## Dev Workflow
- Edit locally in Claude Code
- Verify changes work at localhost:3000 before pushing
- Push to GitHub: `bash push-to-github.sh 'message'`
- Railway auto-deploys from main branch — no manual deploy needed

## Start Local Dev
- Tab 1 (API): `PORT=5000 BASE_PATH=/ npx tsx --env-file=.env artifacts/api-server/src/index.ts`
- Tab 2 (Frontend build): `cd artifacts/cleanops-pro && PORT=5000 BASE_PATH=/ pnpm run build`
- Tab 3 (Serve): `npx serve artifacts/cleanops-pro/dist/public -p 3000`
- View at: http://localhost:3000

## Environment
- `COMMS_ENABLED=false` in Railway env vars — do not change without explicit instruction
- `DATABASE_URL` points to Railway Postgres — never copy dev DB to production
- `PORT` is injected by Railway at runtime — do not hardcode
