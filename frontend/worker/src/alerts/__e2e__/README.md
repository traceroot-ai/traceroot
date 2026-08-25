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

Each scenario mints its own user, workspace and project (ids prefixed `e2e-`)
and removes them afterwards, and ticks only its own projects (`runAlertTick`'s
project scope), so the suite neither claims nor pages any other rule on the
database it runs against — it is safe to run beside data you use by hand.

## Scenarios

| # | What is exercised |
|---|---|
| 1 | A `span_kind = AGENT` filter: the count applies it, the message states it, the link carries it, delivery is recorded |
| 2 | A count rule recovers to OK on an empty window (an honest zero), with no traces link |
| 3 | A `contains` filter the trace list cannot express stays in the prose, out of the link |
| 4 | A keyed `metadata[tenant] = acme` filter: the materialized map, the prose, the keyed link predicate |
| 5 | `p95(latency)` over real durations, then an empty window under HOLD: NO_DATA shown, nothing paged, the breach's clocks kept |
| 6 | `avg(latency)` under NOTIFY: the empty window pages NO_DATA, the return to data pages OK |
| 7 | `sum(cost)` with `>=`: Decimal arithmetic and the operator phrase |
| 8 | Three rules across two projects in one tick: each judged on its own project's spans, one page |
| 9 | A workspace with no Slack channel: the breach stands, delivery records FAILED / no-channel |

Left to the unit suites, which target them directly and without a stack:
renotify intervals, pause/resume cold start, delivery compensation and revert,
overlapping ticks and the claim CAS, the threshold-operator matrix, the
evaluator's window-width and end-lag guards.

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
- Tick through the `tick(now, ...tenants)` helper in the suite, never
  `runAlertTick(now)` bare: without a scope the tick claims every due rule on
  the database.
