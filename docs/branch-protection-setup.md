# Branch Protection Setup — `main`

GitHub branch protection has to be configured by a repo admin from the
Settings UI. Claude Code can't toggle these via API without an admin
token, so this doc is the manual walkthrough. Total time: ~5 minutes.

> **Why this matters:** without these gates, Dispatch (the overnight
> agent) can merge a PR with red CI, with a stale base branch, or with
> someone force-pushing over it. Each item below closes one of those
> failure modes.

## 1 — Open the rule editor

1. Go to **https://github.com/salmartinez-design/qleno/settings/branches**.
2. Under **Branch protection rules**, click **Add branch protection rule**
   (or **Edit** if a `main` rule already exists).
3. Set **Branch name pattern** to `main`.

## 2 — Required settings

Tick each of the following. Leave anything not listed at its default.

### Pull request requirements

- [x] **Require a pull request before merging**
  - **Require approvals:** `0` (Sal is solo for now — flip to `1` when
    a second reviewer is on the team)
  - **Dismiss stale pull request approvals when new commits are pushed:**
    not applicable while approvals are 0
  - [x] **Require approval of the most recent reviewable push** (no-op
    today, kept on for the future-second-reviewer transition)

### Status check requirements

- [x] **Require status checks to pass before merging**
- [x] **Require branches to be up to date before merging**

  Then in the **Status checks that are required** search box, add each
  of the following exactly. They must be typed precisely — GitHub
  matches by name, not by file path:

  - `dispatch-stop-guard`
  - `tsc-check`
  - `build-api-server`
  - `build-frontend`
  - `e2e` *(advisory-only at first — the workflow lands with
    `continue-on-error: true` so flakes don't block merges. After
    ~5 stable green PRs in a row, flip to required by adding `e2e`
    to this list. Don't add it before the streak — flake-induced
    blocks defeat the point.)*

  **Note:** GitHub's autocomplete only surfaces checks that have run
  at least once on the repo. If a check is missing from the dropdown,
  open a throwaway PR that triggers it, then come back here.

### History + push controls

- [x] **Require linear history** (rebase / squash only — no merge
  commits; keeps reverts cheap)
- [x] **Block force pushes**
- [x] **Block deletions**
- [ ] **Lock branch** — leave unchecked. Auto-merge needs the ability
  to push the squash commit.

### Bypass

- [x] **Do not allow bypassing the above settings**

  Repo admins (Sal) included. Override is a meaningful audit signal
  worth losing the convenience of bypass for.

### Optional — only after Railway PR previews are wired up

- [x] **Require deployments to succeed before merging**
  - Add the Railway preview environment name (e.g. `Preview`) once the
    Railway/Playwright PR has it configured. Leave this section
    unchecked until then; otherwise no PR can ever merge.

## 3 — Save

Click **Create** (or **Save changes**). Confirm the rule shows up
under **Branch protection rules** with `main` as the pattern and the
checks listed above.

## 4 — Verify

Open any open PR (or push a trivial commit) and confirm:

- The PR's **Merge** button is greyed out until all required checks
  go green.
- A direct push to `main` is rejected with a "branch is protected"
  error.
- A force push to `main` is rejected.

If any of the three fail, re-open the rule editor and check the
ticked boxes against this doc.

## 5 — When something needs to change later

- **Adding a new required check** (e.g. when Playwright flips from
  advisory to blocking): re-open the rule, add the check name in the
  status checks search, save.
- **Adding a second reviewer:** flip **Require approvals** from `0`
  to `1`. The dismiss-stale toggle becomes meaningful at that point;
  flip it on too.
- **Temporarily relaxing for an emergency hotfix:** don't. Ship the
  hotfix through the normal PR flow — required checks run fast, and
  bypassing protection is exactly the path that took prod down on
  PR #31.

## Reference — what each gate buys you

| Gate                              | What it prevents                                         |
|-----------------------------------|----------------------------------------------------------|
| `dispatch-stop-guard`             | Dispatch keeps merging after Sal hits the kill file      |
| `tsc-check`                       | A lib-side type regression breaks api-server / frontend (project-references only — artifact strict-mode lives in Dispatch backlog) |
| `build-api-server` + `build-frontend` | A PR passes tsc but fails Railway's build step         |
| `e2e` (when added)                | A PR ships green but breaks cascade / parking workflow   |
| Up-to-date branch                 | A PR merges clean against an already-stale main          |
| Linear history                    | Merge commits clutter `git log` + revert chains          |
| Block force pushes                | History rewrite hides incidents                          |
| Block deletions                   | A misclick on the branch list nukes main                 |
| No bypass                         | The kill switches above can't be silently disabled       |
