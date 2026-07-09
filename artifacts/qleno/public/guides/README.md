# Help & Guides — screenshot capture checklist (field-tech set)

Each guide's screenshots live in `public/guides/<slug>/step-N.png` and are served
at `/guides/<slug>/step-N.png`. Placeholder PNGs ship at every path below — the
capture session just **overwrites the file in place**. No code or DB change is
needed; the captions (EN + ES) already live in
`artifacts/api-server/src/lib/guides-content.ts`.

Capture rules:
- Portrait phone screenshots, ~390pt logical width. PNG preferred (JPG works).
- Light theme only (no dark mode). No real customer PII — use test data.
- Keep the file name `step-N.png` so order is preserved.
- The "shot" note below each step says what the screenshot should show.

---

### getting-started-tech — Getting started on your phone
1. `step-1.png` — the login screen with email + password.
2. `step-2.png` — the bottom nav bar (Dashboard / My Jobs / More).
3. `step-3.png` — the My Jobs list.
4. `step-4.png` — the More sheet (showing Help & Guides, Time Off, etc.).

### my-day-jobs — See your jobs for the day
1. `step-1.png` — My Jobs list with several job cards.
2. `step-2.png` — a card with its colored status bar (close-up).
3. `step-3.png` — the pull-to-refresh gesture/spinner.
4. `step-4.png` — tapping a card to open it.

### job-details — Open a job's details
1. `step-1.png` — a job card being tapped.
2. `step-2.png` — the address + map/Street View thumbnail.
3. `step-3.png` — the customer notes section.
4. `step-4.png` — the what-to-clean checklist.

### on-my-way — Mark "On my way"
1. `step-1.png` — the open job screen.
2. `step-2.png` — the On My Way button (highlighted).
3. `step-3.png` — confirmation that you're en route.

### clock-in-out — Clock in and out at each house
1. `step-1.png` — the Clock In button on a job.
2. `step-2.png` — the running timer while working.
3. `step-3.png` — the Clock Out button.
4. `step-4.png` — the next job ready to clock into (no day button).

### add-photos — Add before & after photos
1. `step-1.png` — the camera button on a job.
2. `step-2.png` — taking a "before" photo.
3. `step-3.png` — taking an "after" photo.
4. `step-4.png` — photos uploading / uploaded thumbnails.

### customer-not-home — Customer isn't home
1. `step-1.png` — tech at the door (or the job screen on arrival).
2. `step-2.png` — the Call customer / Call office buttons.
3. `step-3.png` — a wait timer or the on-site screen.
4. `step-4.png` — the No Show button.

### understand-your-pay — Understand your pay
1. `step-1.png` — the earnings/commission panel on a job.
2. `step-2.png` — a multi-tech job showing the split.
3. `step-3.png` — the hours-for-records line.
4. `step-4.png` — allowed vs actual hours.

### mileage — How mileage works
1. `step-1.png` — two job addresses / a route between houses.
2. `step-2.png` — the auto-computed mileage (no manual entry field).
3. `step-3.png` — a route showing the unpaid home bookends.
4. `step-4.png` — the On My Way button (the signal that tracks it).

### request-time-off — Request time off
1. `step-1.png` — More → Time Off.
2. `step-2.png` — the Request form with date picker.
3. `step-3.png` — adding a reason + send.
4. `step-4.png` — a pending/approved request in the list.

### turn-on-alerts — Turn on job alerts
1. `step-1.png` — the bell / Notification settings entry.
2. `step-2.png` — the "Turn on job alerts" button + permission prompt.
3. `step-3.png` — an example job-alert notification.

### account-language — Password & language
1. `step-1.png` — the More sheet account options.
2. `step-2.png` — the Change Password screen.
3. `step-3.png` — the EN / ES toggle at the top of a guide.
