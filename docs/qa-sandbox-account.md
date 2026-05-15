# QA Sandbox Account

The QA sandbox is a permanent test account on the Phes tenant used for
audits, demos, and regression testing. It exists so we can exercise the
employee-facing LMS flow against production without polluting tenant
metrics or generating cert / signature noise on a real employee record.

## Account

| Field | Value |
| --- | --- |
| `users.id` | 446 |
| `users.email` | `training.sandbox@phes.io` |
| `users.first_name` | `Training` |
| `users.last_name` | `Sandbox` |
| `users.is_sandbox` | `true` |
| Tenant | Phes (`company_id=1`) |

History: created by Dispatch during Phase 6 of the 2026-05-14 audit
(original email `audit.test.persona3@phes.io`). Repurposed via the
`runSandboxAccountRepurpose()` migration in
`artifacts/api-server/src/phes-data-migration.ts` so the row survives
restores and rollbacks.

## What the sandbox is excluded from

`is_sandbox = true` rows are filtered out of every tenant-wide aggregate:

- `GET /api/admin/tenants` (`active_techs`, `active_office`, `total_users`)
- `GET /api/subscription/usage` (overage calculation inputs)
- `GET /api/lms/admin/learners` (roster table)
- `GET /api/lms/admin-audit/summary` and `/learner/:userId` (audit dashboard)
- `runAnnualAckSweep()` (annual re-ack cron — sandbox never appears in
  the pending-resign list)

When adding a new tenant-wide aggregate, add `is_sandbox = false` to the
WHERE clause at the same time. The multi-tenant security test suite
(`test/integration/multi-tenant-security/`) has a regression test that
asserts every aggregate respects this filter.

## Using the sandbox

The sandbox's password is whatever Dispatch's audit fixture left
behind. **Rotate the password before each use** via the admin
"Reset password" action on `/lms/admin` — do not assume the previous
session's password is still valid.

To run a clean-slate audit:

1. Sign in as the tenant owner.
2. Reset the sandbox password from the per-employee admin drawer.
3. Sign in as the sandbox in an incognito window.
4. Walk the LMS flow as needed.
5. When the audit is done, redeploy or trigger
   `runSandboxAccountRepurpose()` (idempotent — wipes LMS progress and
   leaves the user record + login intact).

The repurpose migration deletes from:

- `lms_enrollments` (and cascade to children)
- `lms_module_progress`
- `lms_quiz_attempts`
- `lms_quiz_state`
- `lms_signed_documents`
- `lms_completion_certificates`
- `lms_pending_re_ack`

It preserves `lms_signature_events` (audit trail; legal retention).

## Verification after deploy

After Railway deploys this branch, the boot log should contain one of:

```
[sandbox-repurpose] user_id=446 renamed audit.test.persona3@phes.io → training.sandbox@phes.io (is_sandbox=true); wiped: lms_module_progress=N lms_quiz_attempts=N ...
[sandbox-repurpose] skip — user_id=446 already repurposed
```

Spot-checks on the Phes tenant:

- `/lms/admin` roster shows **14 active employees**, not 15.
- `/lms/admin/audit` status cards sum to 14.
- `/admin/tenants` Phes row shows `active_techs` reflecting the real
  count without the sandbox.

## Multi-tenant rollout

`is_sandbox` is a per-row flag and works across every tenant. To
designate a sandbox on a new tenant, the tenant owner sets
`is_sandbox = true` on the chosen user via a tenant-scoped admin
action (TBD — not in this sprint). Until that action ships, only the
Phes sandbox row exists.
