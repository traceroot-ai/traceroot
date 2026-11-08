# Update fixtures: seeding script and manual trigger

Development and test tools for the background update. Nothing here runs in
production: the worker entry points never import this directory.

## Seeding script

Builds a deterministic dataset with known ground truth and writes it to the
local stack (ClickHouse, Postgres) and to a directory (git repositories,
fixtures, manifest). The same seed and prefix always produce the same rows (ids derive from the prefix, so a different prefix gives a different but equally reproducible dataset), the same git
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
`TRACEROOT_E2E_TEST_INBOX`, when set, becomes the email recipient. `--member-email you@example.com`
makes an existing user an admin of the seeded workspace, so the data can be opened in the app.

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
- `seed-big.git`: an oversize repository: a small base commit before the windows and
  a commit inside the previous window that adds an incompressible payload, so a
  clone limited to that history and the changed paths has to fetch it. The blobless
  clone alone is small; measure the size after the sparse checkout of changed paths.
- Slow case: `serve-slow` serves `<out>` over git's HTTP protocol and holds every
  response back by `--delay-ms` (default 70 s; the blobless shallow-since no-checkout clone makes three
  requests, so the default clone takes ~210 s, past the 180 s clone ceiling;
  the manifest records `approxCloneMs`). Clone `http://127.0.0.1:<port>/seed-app.git`.
- Unreachable case: `http://127.0.0.1:9/seed-org/seed-unreachable.git` (nothing listens).

### Properties

- Window lengths follow the local calendar, so across a daylight-saving change the
  current window can be 25 h while the previous one is 24 h; planted counts are
  fixed per window, not normalised by length.
- Refuses to run against a ClickHouse or Postgres host that is not local unless
  `TRACEROOT_UPDATES_SEED_ALLOW_REMOTE=1`, and only deletes workspaces whose name
  carries the seeded marker.

- Deterministic: no clock or random source outside the seeded generator.
  `contentDigest` in the manifest is a hash of every row written.
- Idempotent and cleanable: `seed` first removes what the prefix owns, `clean`
  removes only that (ClickHouse rows by project id, the two workspaces and
  everything under them, and the files it wrote into the output directory; it never
  deletes the directory's other contents).
- `verify` runs exact aggregate queries on ClickHouse and compares them with the
  manifest to the digit, then checks the schedules and each signal's hit counts in
  Postgres and that the manifest is complete; it exits non-zero on any difference.

## Tick

```bash
pnpm update:tick --now 2026-11-02T09:30:00Z [--times 2] [--parallel]
```

Runs the due-schedule tick once (or several times, in sequence or at the same
moment) as of `--now`. Seeded schedules are due for the slot that has just passed
at the seed's "now", so a tick at that instant records one run per project for the
seeded window; running it again, or from two processes, records nothing new.

## Facts check

`pnpm update:seed check-facts` (needs the backend running) reads both windows of
every seeded project from the aggregate endpoint, computes the findings, and
grades them against the manifest: every planted change found with the right
direction and a magnitude within tolerance, no control flagged, nothing invented,
the tiny sample shown as absolute numbers only, the empty project as no traffic.

## Manual trigger

```bash
pnpm update:trigger --project seedupd-main --now 2026-11-02T09:30:00Z
```

Creates a run for the project as of `--now` (or `TRACEROOT_UPDATES_FROZEN_NOW`,
or the real clock) and prints its window boundaries. The windows depend only on
the project's schedule and the instant, so triggering twice gives identical
boundaries. Refused unless `NODE_ENV` is `development` or
`test` (the CLI defaults to `development`) or `TRACEROOT_UPDATES_ALLOW_MANUAL=1`.

## Running a whole update

```bash
# map the dev keys to the names the app reads (see the e2e docs), then:
pnpm update:trigger --project seedupd-main --now 2026-11-02T09:30:00Z --execute   # in this process
pnpm update:tick --now 2026-11-02T09:30:00Z                                      # or via the worker's queue
pnpm update:seed check-facts      # numbers against the planted changes
pnpm update:seed check-digest     # delivered digests against the manifest: no other tenant's
                                  # markers, no repeated injection, own links only, every planted
                                  # change mentioned
```

Environment switches for development: `UPDATE_AGENT_MODEL` (model id), `UPDATE_AGENT_DEBUG=1`
(one log line per agent turn, never content), `UPDATES_INJECT_FAULT=email-once` (the first email of
each message fails once, to watch a retry resume; ignored in production).
