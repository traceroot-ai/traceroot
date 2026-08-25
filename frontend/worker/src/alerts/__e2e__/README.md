# Alerts end-to-end suite

Exercises the alert pipeline the way it runs in production, layer by layer,
against real services:

```
rule in Postgres ──▶ scheduler tick ──▶ REST /internal/alert-evaluate ──▶ ClickHouse spans
                          │
                          ▼
                 severity written back ──▶ notification job ──▶ Slack delivery worker
                                                                      │
                                                     Block Kit message (prose + deep link)
```

What is real: Postgres (through Prisma), ClickHouse (spans are inserted over
its HTTP interface), the REST backend (its internal evaluator does the
measuring). What is stubbed, at the process boundary only: the Redis queue
(so the job the tick enqueues can be handed straight to the delivery worker)
and the Slack client (so the message can be asserted on).

The unit suites in `../__tests__` cover the state machine, claiming and
delivery in isolation with everything mocked; this suite is the check that the
layers agree with each other — the filter the rule stores is the filter the
evaluator applies is the filter the message names.

## Running locally

Bring the dev stack up (`make dev` or `make dev-autoreload`: it starts
Postgres, ClickHouse, Redis and the REST backend), then:

```bash
make e2e
# or
cd frontend/worker && pnpm test:e2e
```

Configuration comes from the repo's `.env`, the same one the stack reads:
`DATABASE_URL`, `CLICKHOUSE_*`, `BACKEND_INTERNAL_URL`, `INTERNAL_API_SECRET`,
`ENCRYPTION_KEY`. A preflight names anything missing or unreachable before
the first scenario runs.

Each run mints its own user, workspace and project (ids prefixed `e2e-`) and
removes them afterwards, so it is safe to run against a database you also use
by hand.

### Delivering to a real Slack channel

By default the Slack client is a stub. To post the messages for real — to a
channel kept for this purpose — set both:

```bash
E2E_SLACK_BOT_TOKEN=xoxb-… E2E_SLACK_CHANNEL_ID=C0123456789 pnpm test:e2e
```

The bot must be a member of the channel (or the channel public, with
`chat:write.public` granted). The assertions run on the same payload that
went out.

## In CI

`.github/workflows/e2e.yml` runs the suite on every pull request with
Postgres, ClickHouse and Redis as service containers and the REST backend
started in the job. It uses the stubbed Slack client: fork PRs cannot read
repository secrets, and the suite must pass for them too.

## Adding a scenario

- Seed spans with `seedSpans` inside `evaluatedWindow(now, window)`: a tick at
  `now` evaluates the window that ends `ALERT_EVALUATION_OFFSET_MS` before the
  minute boundary, so anything seeded outside it is invisible by design.
- Spans must be customer traffic (`source = 'user'`, which `seedSpans` sets):
  every customer-facing read filters on it.
- Call `runAlertTick(now)` with the same `now` the window was derived from,
  read the rule back with `readRule`, and hand the enqueued job to
  `sendAlertNotification` to get the message.
- `makeDue(alertId)` re-arms a rule for another tick without touching its
  state; re-seed (or `deleteSpans`) first to change what that tick sees.
