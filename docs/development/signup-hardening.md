# Signup abuse hardening

## Problem

`POST /api/auth/sign-up/email` (better-auth, mounted at `app/api/auth/[...all]`) accepts any
syntactically valid address and immediately creates an active, signed-in account:

- **No domain check.** Only format is validated, so reserved domains (`example.com`, `*.test`) and
  disposable inboxes pass.
- **No email verification.** `emailAndPassword` sets only `minPasswordLength`; the account is live
  before anyone proves they own the address.
- **Side effects on every signup.** `user.create.after` sends a welcome email and a Slack notice for
  every account, fake ones included. Mail to reserved or dead domains bounces and erodes sender
  reputation for real customers.
- **Weak throttling.** The library default for `/sign-up/*` is 3 requests per 10 s per IP, held in
  per-replica memory: N replicas means N budgets, and a restart clears them.
- **No bot friction.** No CAPTCHA, and the edge WAF only covers the device-code and CLI-token routes.

## Scope

- **Primary: application level.** Ships with the web image, applies to every deployment, and is the
  only layer that can reason about the email address itself.
- **Secondary: edge WAF** (`traceroot-infra`). Per-address throttling at the edge is a useful
  backstop against volumetric abuse, but it is a separate change in that repo and is not part of
  this stack.
- **Out of scope:** `traceroot-k8s`, `traceroot-terraform-aws`.

## Changes

Each change is a small module wired into `lib/auth.ts`, shipped as its own PR, each stacked on the
previous one. Following standard practice for self-serve signup: reject undeliverable addresses
up front, require proof of inbox ownership, throttle per client, and add bot friction last.

| PR | Change | Module | Notes |
| --- | --- | --- | --- |
| 1 | Reject reserved and disposable domains | `lib/signup/email-policy.ts` | Pure function; enforced server-side in `databaseHooks.user.create.before`, mirrored in the sign-up form schema for a clear inline error. Covers email signup and OAuth. Staff-created accounts are exempt. |
| 2 | Require email verification | `lib/signup/verification-email.ts` | `requireEmailVerification` when transactional mail is configured, so deployments without mail keep working. Welcome email and Slack notice move from account creation to `afterEmailVerification`. Existing users are grandfathered by a one-time migration that marks them verified; existing sessions are untouched. |
| 3 | Tighter, shared rate limits | `lib/auth-rate-limit.ts` | Explicit `/sign-up/email` rule (5 per hour per IP). Counters move to Redis via `rateLimit.customStorage` when `REDIS_URL` is set, so every replica shares one budget; falls back to memory without it. Sessions stay in Postgres. |
| 4 | CAPTCHA (optional) | better-auth `captcha` plugin | Turnstile on sign-up, active only when both site and secret keys are set. |

## Sequencing

```
main ← design (this doc) ← PR1 domain policy ← PR2 verification ← PR3 rate limit ← PR4 captcha
```

Ordering follows value and risk: PR1 is a pure, well-contained check; PR2 changes the signup flow
and needs PR1 so fake domains never receive verification mail; PR3 is infrastructure-adjacent;
PR4 adds a third-party dependency and is optional.

## Testing

- Unit tests per module (policy table, verification wiring, rate-limit storage).
- Playwright e2e (`frontend/ui/e2e/signup-hardening.spec.ts`): reserved/disposable domains rejected,
  valid signup requires verification before sign-in, and repeated signups from one IP are throttled.
