# Handoff — agent self-trace

Everything is committed and pushed. Nothing is in flight. This note is what a
fresh session needs to pick the work up.

## What the feature is

Every run of a TraceRoot-operated agent — automatic RCA, follow-up and manual
chat, the worker's digest-summary call — becomes a trace in the customer's own
project, reachable from the finding that produced it. The agent service's runs
land under `source='agent'`; the worker's digest-summary call authenticates with
the platform secret and therefore lands under `source='detector'` (source is
derived from the credential — rule 1 below). Internal traces cannot re-trigger a
detector and never appear in a customer's trace list.

Design: [design doc](https://claude.ai/code/artifact/8ef0e8c7-113a-43b5-add5-83d354ffd3af)
· [implementation notes](https://claude.ai/code/artifact/6233ce7a-d738-48c4-9dd0-f294f3eb1f33)
(both current; Decision 1/2/3 in the design doc are the load-bearing ones).

## Where it lives

Epic **#2058**. Nine PRs, stacked — each PR's base is the one below it, so
GitHub shows them as one stack and each diff stays reviewable on its own.

```
main
└── #2067  internal-router      2 commits   open    ← splits main's internal.py
     └── #2068  metering        4           draft   (UX: BillingTab)
          └── #2069  ingest    11           open    ← the isolation seam
               └── #2070  executions   14   open
                    └── #2071  attribution  29      draft
                         └── #2072  emit    44      draft   ← the risky one
                              └── #2082  ui  53     draft   (replaces #2073, auto-closed by GitHub during a force-push)
                                   └── #2083  span-focus  57  draft   (replaces #2074, same)

#2075  digest       2 commits  open   ← base main, independent, mergeable today
feat/agent-trace-all  59 commits      ← integration reference, not a PR
```

`feat/agent-trace-all` is the sum of the stack plus #2075, kept byte-identical
as a check — apart from this note and its two fixture scripts, which are
deliberately committed only here so they stay out of all nine diffs. Verify
after any stack rebuild:

```bash
git checkout -B verify/sum feat/agent-trace-span-focus-pr
git cherry-pick $(git log --format=%h origin/main..feat/agent-trace-digest-pr | tac | tr '\n' ' ')
git diff --stat verify/sum feat/agent-trace-all   # expect only HANDOFF*.md + scripts/agent-self-trace/
```

## Why each PR is a draft

- **#2068** — touches `BillingTab.tsx`; the user wants UX reviewed before it opens.
- **#2071, #2072, #2082, #2083** — same reason, plus #2071 currently carries 10 commits from
  #1960/#1961 (see below).
- **#2072** — additionally blocked: two commits pin `@traceroot-ai/traceroot` to
  a **local `file:` tarball**. 0.4.0 has the instrumentation but is not on npm
  (`latest` is 0.3.0). **Before merging**: publish 0.4.0
  (traceroot-ai/traceroot-ts#150), swap the pin for the npm version, drop
  `frontend/vendor/traceroot-ai-traceroot-0.4.0.tgz` and the Dockerfile lines
  copying it.

## Two dependencies that are not ours

**#1960 → #1961** (`fix/session-leakage` → `fix/persist-tool-steps`, stack #1963)
are the user's own open PRs. #2071's attribution work modifies the exact code in
`frontend/ee/agent/src/index.ts` that #1961's stream persister introduces — a
real functional dependency, verified by cherry-picking onto `main` without it
(conflict in `index.ts`). Since a PR has one base and #2071 needs both #2070 and
#1961, those 10 commits ride along in its branch. **Once #1961 merges to main,
rebase #2071 and they disappear from the diff.** A comment on #2071 says so.

**#1899** (internal-router split) is *not* a functional dependency — the same
code fits the unsplit file; only the patch context differs. #1899 also sits
mid-stack under an alerts PR and cannot merge before that work. #2067 is the
same change taken from `main`, producing only the four modules main's router
actually contains. Whichever lands first, the other drops its copy.

## Rules the code enforces — do not weaken these

1. **`source` is derived server-side from which credential authenticated.** The
   client never picks it. Two secrets: `INTERNAL_API_SECRET` (worker, Next.js →
   `detector`) and `INTERNAL_API_SECRET_AGENT` (agent service → `agent`). A
   settings validator refuses the two being equal — sharing a value silently
   labels agent traces as detector traces.
2. **`customer_traffic_only()` asserts `source = 'user'`**, never `!= 'detector'`.
   Fail-closed by design: a future internal marker is excluded the day it exists.
3. **Tracing failure never fails a run.** `withAgentTrace` distinguishes three
   states — fn's own error propagates; a tracing error *after* fn succeeded
   degrades to `trace: "failed"` and still returns the value; only a failure
   before fn ran reruns the turn untraced. Do not collapse this back to a
   boolean.
4. **Executions are allocated before the agent starts**, not after. Writing ids
   afterward is not crash-safe: a crash between export and DB write lets the
   BullMQ retry reuse the first trace id.
5. **Redact before truncating.** Truncating first can split a secret token and
   defeat the pattern.
6. **The user-trace viewer snapshot must stay byte-identical.**
   `trace-viewer-user-snapshot.test.tsx` compares markup exactly and has already
   caught a visually-identical class reordering. If it fails, the change altered
   the customer's view — that is the finding, not the test.

## Review state

49 automated review comments across the nine PRs: **27 fixed, 22 answered** with
reasoning. All threads have a reply. Two rounds of follow-up review on the fixes
themselves were also handled — twice the bot correctly caught that a fix had
introduced a subtler version of the same bug, so **re-check for new comments
after pushing**:

```bash
for n in 2067 2068 2069 2070 2071 2072 2082 2083 2075; do
  gh api "repos/traceroot-ai/traceroot/pulls/$n/comments" --paginate 2>/dev/null | python3 -c "
import json,sys
cs=json.load(sys.stdin)
top=[c for c in cs if not c.get('in_reply_to_id')]
replied={c['in_reply_to_id'] for c in cs if c.get('in_reply_to_id')}
print('#$n', len([c for c in top if c['id'] not in replied]), 'unanswered')"
done
```

## Known-broken and open

- **`make dev` hangs on this branch.** The two `20260901*` migrations omit
  `ON UPDATE CASCADE` on their FKs while Prisma's datamodel expects Cascade, so
  the DB is permanently drifted and `prisma migrate dev` stops at an interactive
  "Enter a name for the new migration" prompt. `migrate deploy` (what the runbook
  says) is unaffected. **Fix needs a DB reset** — the migration checksums change.
  Not yet filed.
- **#2077** — pre-existing billing bug found during review: `uniqExact(run_id)`
  cannot dedup across billing windows, and a retry writes the same `run_id` with
  a later timestamp, so one scan can be billed twice. On `main` today, not
  introduced here. Deliberately not fixed in this stack.
- **#2066** (digest self-trace) is filed but its PR is **#2075**, which is
  independent and mergeable now.
- **traceroot-cli#90** — the public API hands out an agent trace id and says
  `trace_status: "available"`, but `traces get <id>` 404s without `source=agent`.
  Decision 3 opens the server side; the CLI needs a `--source` flag (generated,
  no CLI code) and one line in its finding renderer. Blocked on #2069 plus a
  `@traceroot-ai/tools` release.
- **traceroot-ts#150** — carries two asks: publish 0.4.0, and add a side channel
  reporting `{ toolCallId, spanId, exitCode? }` per tool span. Without it a tool
  step cannot deep-link to its span (that is why #2083's (né #2074) SDK half is still open)
  and a withheld-output step records no exit status.

## Open design questions (in the doc, none blocking)

Per-project credential scoping for internal ingest · opt-in visibility of
internal traces in the Traces list · whether `source=detector` opens on the
public single-trace read · exposing manual RCA re-run.

## Local environment

Running via `make dev`-equivalent (tmux session `traceroot`, 11 windows):

```
UI     http://localhost:3000     jared@local.dev / TraceRoot!2026dev
REST   http://localhost:8000/docs
Agent  http://localhost:8100
logs   tmux -L development attach -t traceroot
```

Workspace **Local Dev** → project **agent-trace-demo**
(`b9d6ed9e-7238-4bee-81b9-b8414edec90d`), API key `tr-6e5eb372-…`. Both detectors
at 100% sample on `gpt-5.4-mini` (BYOK OpenAI), project RCA model `gpt-5.4`.
`.env` has `AGENT_SELF_TRACE=1` and `AGENT_SELF_TRACE_KINDS=rca,followup,chat`.

Current data: 9 customer traces, 8 agent traces, 18 detector traces. Isolation
verified — the public trace list returns 9, and fetching an agent trace id 404s.

**Two environment gotchas on this machine**, likely different elsewhere:

- Port 6379 collided with a host `redis-server`, so the stack ran against that
  rather than the container. It worked, but was not isolated and survived
  `make dev-reset`.
- Homebrew goose 3.24.2 cannot talk to ClickHouse 25.2 (`Unknown setting
  'database'`). Ran migrations through the dockerised `migrate-clickhouse`
  service instead: `docker compose run --rm --no-deps migrate-clickhouse up`.

After a rebase, **delete `frontend/ui/.next`** — a stale build cache pointing at
pre-rebase paths made `validate-api-key` return 500, which surfaced as ingest
503s that look nothing like a cache problem.

## Reproducing data

`scripts/agent-self-trace/seed_traces.py` is a fake support agent that really calls OpenAI and
has a planted bug: `lookup_order` raises `KeyError` for an unknown order while
the system prompt demands a confident answer that never mentions errors. That
produces genuine hallucinations for the detectors to catch, rather than
synthetic rows the judge would ignore.

```bash
TRACEROOT_API_KEY=tr-… TRACEROOT_HOST_URL=http://localhost:8000 OPENAI_API_KEY=… \
  uv run --no-project --python 3.13 --with 'traceroot==0.1.11' --with 'openai>=1.0.0' \
  python scripts/agent-self-trace/seed_traces.py
```

Then wait ~60–90s for detect → RCA. The LLM is nondeterministic: some runs
answer honestly and only the Failure detector fires.

`scripts/agent-self-trace/inject_agent_trace.py` posts a synthetic `source='agent'` trace
straight through the internal ingest route — no agent service, no SDK, no LLM
key. That is the fixture for testing M3's surfaces before #2072 can merge, and
it is why the UI work is not blocked on the SDK release.

## End-to-end checks

`tests/e2e/` runs against the live dev stack and is skipped unless `TRACEROOT_E2E=1`.
`test_agent_self_trace_journey.py` walks finding → execution → trace → seam; it reads
the execution through the app's finding endpoint (a signed-in session), because the
public findings API deliberately exposes only `rca.status`/`rca.result`.

```bash
INTERNAL_API_SECRET=… INTERNAL_API_SECRET_AGENT=… \
TRACEROOT_E2E=1 TRACEROOT_E2E_PROJECT_ID=<project> TRACEROOT_E2E_API_KEY=tr-… \
TRACEROOT_E2E_EMAIL=<member email> TRACEROOT_E2E_PASSWORD=… \
TRACEROOT_REDIS_URL=redis://localhost:6379/0 \
  uv run --directory backend pytest ../tests/e2e -q
```

Needs at least one finding whose RCA has finished; the digest test skips until a
digest window has flushed (`alert_emails` set, window closed).

## Loose ends

- The user's **OpenAI key is stored in Langfuse Cloud** under an `openai-judge`
  LLM connection, from a competitor comparison. Delete it when convenient.
- Langfuse findings are already folded into the design doc's prior-art section
  (their judge traces are billed to the customer like any row; their public API
  serves internal traces with no isolation at all — which is what makes Decision
  3's middle position defensible).
