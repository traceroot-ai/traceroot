# Impersonation management

`/admin` is the staff console. `support` can view customers; `admin` can also perform customer-authorized business writes and grant/revoke staff access. Customers receive 404. Workspace membership roles are unrelated to staff roles.

## Flow

- Users: 25 per page, partial email / exact user ID filter. The identity column has two lines: name plus smaller, muted email, then the user ID as plain text without a copy button. Workspaces displays only a count, with no expansion or role details. Staff and banned accounts cannot be impersonated; the disabled button says why. Rows stay on screen while a new search loads.
- Impersonate: a compact dialog with the target in the title, an optional Reason textarea, and Cancel / Start session buttons. No visible email, mode explanation or empty-workspace warning. Optional reason accepts up to 500 characters, trimmed; omitted/blank reasons are recorded as null. Deep links use `/admin/impersonate?userId=…`. Switching ends the current session first.
- The amber banner is the single persistent indicator: target, mode, the recorded reason, current workspace and the exit control. Any write the policy refuses is announced in the banner (the guard tags those 403s with `x-impersonation-denied`; the banner wraps `window.fetch` only while a session is active so every feature's requests are covered). Exit restores the employee session and original filter/page. There is no impersonation-specific duration cap: ordinary login-session expiry/refresh applies (currently seven days of inactivity). Current employee/target eligibility is checked on every request. If the original employee session has expired, exit requires signing in again.
- A session that ends server-side (staff revoked, customer banned) unwinds itself: the next `get-session` runs the stop flow and answers with the restored employee session, `/admin` shows an exit page instead of a 404, and the banner reports that the employee is back on their own account. Staff are never left holding a dead customer cookie on the sign-in page.
- Staff access: admin-only in both UI and API. Shows all existing accounts whose email ends in `@traceroot.ai` (case-insensitive), including accounts without access; no filter or pagination. Each row has an Account column (Verified / Unverified / Banned) and inline Admin / Support / No Access choices with confirmation and the current choice highlighted. Grants require a verified, non-banned account; no self-role changes. Email matching does not automatically grant access. The revoke API also permits revoking a previously privileged account whose email has changed, although that account is no longer listed. Revocation blocks subsequent reads; admin → support blocks subsequent writes. Already-dispatched requests are not canceled.
- No Access logs tab, and no log or per-user workspace listing API: `/api/support` serves only `users`, `staff` and `context`. Durable audit collection remains; no session tokens or request bodies are recorded.

## Enforcement and audit

The custom better-auth plugin creates the customer session and its start audit in one transaction, stores a signed restoration cookie (`support_original`, holding the employee session token plus the impersonation session ID — which is why exit must expire it as well as the customer cookie), and deletes the customer session on exit. Calling stop on a plain login is a no-op that keeps the login. Existing `/api/auth/admin/*` endpoints are disabled to prevent unaudited role changes or starts. Employee accounts are not granted additional customer membership permissions.

All cookie API handlers use `withImpersonationPolicy`; a source-coverage test fails when an unwrapped route is added. Explicit credential/integration blocks cover both staff tiers, including CLI JWT exchange, device approvals, auth/account changes, GitHub token/OAuth, Slack installation, and API keys. JWT auto-issuance in `get-session` is disabled. Dashboard reads do not lazily create resources while impersonating.

Python trace reads now require a signed browser session instead of trusting `x-user-id`; the UI resolves identity and live impersonation eligibility before checking project membership. Trusted internal-secret calls and public API/CLI authentication remain separate. Cross-origin browser calls send cookies (`credentials: include`); UI/API hosts must share a usable session-cookie scope. Deploy UI and REST changes together.

Role changes and session starts/exits fail closed if their audit transaction fails. Business writes first persist an audit intent, then preserve the real handler response and finalize the outcome. If finalization fails, the durable intent remains `pending`; exceptions are `unknown`. These states require reconciliation and are **not proof of rollback or permission to retry**. Existing route-specific idempotency semantics are unchanged. The wrapper does not claim atomicity between arbitrary business/external effects and its final outcome row.

Audit rows have actor/customer email snapshots and no foreign-key cascades. Keep `transport=admin` out of any future pruning. Expiry is deterministic even if no exit request arrives; closing a browser is not an observed exit. Session-level access is deliberately not workspace-scoped and does not prove which traces were read.

## Local verification

After starting local Postgres, UI on `localhost:3000`, and REST on `localhost:8000`:

```sh
cd frontend/packages/core
pnpm db:generate
pnpm exec dotenv -e ../../../.env -- prisma migrate deploy
cd ../../ui
pnpm exec playwright install chromium
pnpm test:e2e
NODE_OPTIONS=--no-experimental-webstorage pnpm test
pnpm exec tsc --noEmit
```

E2E refuses non-local database, UI and REST hosts. It creates UUID-prefixed fixtures and cleans only those accounts, workspaces and test audit rows. The Node flag avoids Node 26 native Web Storage shadowing jsdom storage in existing component tests.

For an isolated validation server, set `E2E_BASE_URL` and `E2E_REST_URL` (defaults: ports 3000 and 8000). Set `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_API_URL` at build time, plus `BETTER_AUTH_URL` for the UI and `TRACEROOT_UI_URL` for REST, to match those servers.

## Before a shared/production rollout

- Apply the additive migration before updating UI and REST; do not reset the database. Older UI/REST releases lack these enforcement guarantees, so rolling back code also rolls back protection.
- Review current staff accounts and remove obsolete roles. This change does not automatically promote, demote or alter existing real users.
- Require Workspace Google SSO + organizational MFA for staff, remove password credentials, prevent password-recovery/account-linking bypasses, and revoke old employee sessions. This operational identity requirement is **not automatically enforced by the role grant UI**.
- Record a break-glass owner/procedure and quarterly access-review task. No production identity changes are performed by local E2E.
- Keep privileged audit retention explicit; never describe this feature alone as SOC 2 certification or a record of every read.
