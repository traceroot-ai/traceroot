# Update fixtures: seeding script and manual trigger

Development and test tools for the background update. Nothing here runs in
production: the worker entry points never import this directory.

## Seeding script

Builds a deterministic dataset with known ground truth and writes it to the
local stack (ClickHouse, Postgres) and to a directory (git repositories,
fixtures, manifest). The same seed always produces the same rows, the same git
commit hashes and the same manifest.

```bash
cd frontend/worker
pnpm update:seed seed   [--out DIR] [options]   # clean own data, then seed
pnpm update:seed verify [--out DIR]             # ClickHouse answers vs the manifest
pnpm update:seed counts                         # row counts of everything it owns
pnpm update:seed clean  [--out DIR]             # remove only its own data
pnpm update:seed serve-slow [--out DIR]         # the "slow remote" case, see below
```

Options (all optional): `--seed` (default `update-seed-1`), `--now` (default
`2026-11-02T09:30:00Z`, a Monday), `--frequency daily|weekly`, `--weekday 1..7`,
`--hour 0..23`, `--timezone IANA`, `--volume` (scale, default `1`), `--prefix`
(default `seedupd`; every id it creates starts with it), `--big-bytes` (size of
the oversize repository, default 30 MiB), `--port` and `--delay-ms` for the slow
remote, `--slack` (also connect the seeded workspace to Slack using
`TRACEROOT_E2E_SLACK_BOT_TOKEN` and `TRACEROOT_E2E_SLACK_TEST_CHANNEL_ID`).
`TRACEROOT_E2E_TEST_INBOX`, when set, becomes the email recipient.

The windows come from the same code the worker uses (`@traceroot/core/updates`),
so `--now`, `--frequency` and `--timezone` move the seeded data with them. With
`--timezone America/New_York` the default windows cross a daylight-saving change.

### What it creates

Five projects in two workspaces (`<prefix>-ws-a`, `<prefix>-ws-b`):

| project | purpose                                                                  |
| ------- | ------------------------------------------------------------------------ |
| `main`  | every planted change, the controls, git refs, signals, injection strings |
| `nogit` | an error-rate rise with no git context on any trace                      |
| `tiny`  | a sample too small for a percentage (6 and 10 traces)                    |
| `empty` | no traffic in either window                                              |
| `other` | a second tenant with its own markers, to prove isolation                 |

Planted in `main` (each against a control that does not move):

- volume drop on `checkout_agent`
- error-rate rise on `research_agent`, concentrated on the `bad` ref
- cost spike on model `gpt-4o`
- latency shift on `triage_agent`
- a new tool (`refund_lookup`) and a vanished tool (`legacy_search`)

Controls: `support_agent`, models `gpt-4o-mini` and `claude-haiku-4-5`, tool
`search_docs`, and the `ctl` ref. Signals: two new, one resolved, one spiking,
one stable. Also planted: instruction-like text in trace data, in a pull
request title and in a repository file (`PWNED-INJECTION-*`), which must never
be obeyed.

### Output directory (default `$TMPDIR/traceroot-update-seed`)

- `manifest.json`: exactly what was planted. Per project and window: counts,
  error rate, p50/p95, tokens and cost, by workflow, model, model and day, tool
  and ref; the planted changes, controls, signals, commits and markers.
- `github-fixtures.json`: pull requests, releases and tags aligned to the commit
  hashes, for the GitHub API stand-in.
- `seed-app.git`: a real bare repository with commits at known times and tags.
  It allows partial and shallow clones, so `git clone --filter=blob:none
--shallow-since=... file://<out>/seed-app.git` works as it does against a host.
- `seed-big.git`: an oversize repository (incompressible payload).
- Slow case: `serve-slow` serves `<out>` over git's HTTP protocol and holds every
  response back by `--delay-ms`. Clone `http://127.0.0.1:<port>/seed-app.git`.
- Unreachable case: `http://127.0.0.1:9/seed-org/seed-unreachable.git` (nothing listens).

### Properties

- Deterministic: no clock or random source outside the seeded generator.
  `contentDigest` in the manifest is a hash of every row written.
- Idempotent and cleanable: `seed` first removes what the prefix owns, `clean`
  removes only that (ClickHouse rows by project id, the two workspaces and
  everything under them, the output directory).
- `verify` runs exact aggregate queries on ClickHouse and compares them with the
  manifest to the digit; it exits non-zero on any difference.

## Manual trigger

```bash
pnpm update:trigger --project seedupd-main --now 2026-11-02T09:30:00Z
```

Creates a run for the project as of `--now` (or `TRACEROOT_UPDATES_FROZEN_NOW`,
or the real clock) and prints its window boundaries. The windows depend only on
the project's schedule and the instant, so triggering twice gives identical
boundaries. Refused when `NODE_ENV=production` unless
`TRACEROOT_UPDATES_ALLOW_MANUAL=1`.
