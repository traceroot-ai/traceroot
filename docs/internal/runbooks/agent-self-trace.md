# Agent self-trace — enable, observe, disable

Every TraceRoot-operated agent run (automatic RCA, follow-up and manual chat turns, the
worker's digest-summary call) can be recorded as a trace in the customer's project,
stored under `source='agent'` (agent service) or `source='detector'` (worker). Emission is
on by default and controlled per kind.

## Enable (cloud)

1. No new credential: the agent service uses the existing `INTERNAL_API_SECRET`, like
   every other internal caller. What a trace is stored as comes from the path it was
   posted to — the agent exports to `/api/v1/internal/traces/agent` (`source='agent'`),
   the worker to `/api/v1/internal/traces` (`source='detector'`) — so no header or
   payload can relabel it, and nothing new has to be minted, distributed or rotated.
   Check the agent service actually has the secret set (`make dev` / `make prod`
   generate it; prod compose passes it): with it unset the agent logs
   `[AgentTrace] INTERNAL_API_SECRET unset; agent self-trace disabled` and runs untraced.
2. Apply the Prisma migrations `20260901000000_rca_executions` and
   `20260901000001_ai_message_attribution` (in `frontend/packages/core`, with
   `DATABASE_URL` set: `pnpm exec prisma migrate deploy`). Both are additive; no backfill
   of executions is performed.
3. Configure the agent service env before deploying. `AGENT_SELF_TRACE` unset means
   on (any value other than `1` or `true` turns it off). To stage a rollout, narrow
   `AGENT_SELF_TRACE_KINDS` and widen it over a few days: `rca` → `rca,followup` →
   `rca,followup,chat`.
   Unset means all kinds; a token that is not one of those three is ignored and warned
   about once in the agent-service log (`[AgentTrace] AGENT_SELF_TRACE_KINDS token`).
4. Deploy the agent service before the RCA worker, and wait for the agent rollout to
   finish before starting the worker rollout. The worker records each execution's
   `trace_status` from the agent's final `trace` SSE frame; an older agent that does not
   send it makes the new worker record `failed`, even when the RCA completed. The
   agent-first rollout is safe: an older worker ignores the new frame. Keep this
   order even with `AGENT_SELF_TRACE=0`: the updated agent still sends `status: "disabled"`.
5. Confirm after the first RCA:
   `select attempt, trace_status, count(*) from detector_rca_executions
    where started_at > now() - interval '1 hour' group by 1,2` shows `available` and no
   `failed`; the analysed run's Agent Run ID is clickable in the detector runs table.
   `available` is optimistic: it means the turn's flush resolved. Flushes are serialised
   per process so an export rejection lands on the turn whose spans were in flight, but
   the exporter is process-wide, so a batch holding a turn's spans can still fail after
   that turn was acked. Cross-check with the span volume query below; a link whose trace
   never landed opens an empty trace.
   Only an RCA turn waits for its flush before ending. A chat or follow-up turn ends as
   soon as its spans are closed: its final assistant row is written with
   `metadata.traceStatus = "pending"` and updated to `available`/`failed` when the
   upload settles (a few seconds later; 30 s at most). A row left at `pending` means the
   agent process died between the two writes.

## Observe (first week)

- Span volume by source:
  `SELECT source, count(), sum(length(output)) FROM spans
   WHERE ch_create_time > now() - INTERVAL 1 DAY GROUP BY source`.
- Export failures: agent-service log lines `[AgentTrace] export failed`.
- Worker deployed first: finish the agent rollout, then check the next RCA's
  `trace_status` with the query in Enable step 5 (`available` when its flush succeeds,
  `disabled` when tracing is off). Executions run against the older agent retain
  `failed`; scope them by the deployment window and check whether their traces landed before
  treating them as export failures. The missing frame affects the recorded status,
  not the trace data, and completing the rollout does not repair those existing rows.
- Cut captures: a span whose recorded input/output was cut to its cap (the root's prompt,
  answer and system prompt; an LLM span's input/output; a tool span's args/result) carries
  `traceroot.truncated = true`; a tool span whose result was withheld because the run's
  capture budget was already spent carries `traceroot.capture_budget_exceeded = true`.
  Both live in the span's `metadata` JSON (the `traceroot.*` keys are kept out of
  `metadata_map` by design), so query them as
  `JSONExtractBool(metadata, 'traceroot.capture_budget_exceeded')`. Many of the latter in
  one run means the budget (`DEFAULT_CAPTURE_BUDGET`) is too small for that agent's tool mix.
- Customer surfaces: the Traces list and dashboards must show zero `agent` rows
  (`customer_traffic_only()` guards every customer read; `tests/rest/test_source_consumers.py`
  enforces the inventory).
- Billing: `/api/v1/internal/usage/details` returns `by_source` for display and
  attribution only. Both the Stripe quantity and the Free ingestion cap read the
  unfiltered total: stored rows count whoever wrote them.

## Disable

- One kind: remove it from `AGENT_SELF_TRACE_KINDS` — takes effect on the next turn, no
  restart.
- Entirely: `AGENT_SELF_TRACE=0`. Existing `available` links keep working; new executions
  record `trace_status=disabled` and persist the same row set they did before tracing (no
  extra rows, no trace stamps). The rows' tool I/O still goes through the capture policy,
  which is not behind the flag — see Rollback.

## Rollback

- Stop agent emission with `AGENT_SELF_TRACE=0`, keeping the updated agent and worker
  code deployed. The agent still sends `status: "disabled"` in the `trace` SSE frame,
  so the worker records `trace_status=disabled` rather than treating a missing frame
  as `failed`.
- If the code itself must be reverted, roll back the worker first and wait for its
  rollout to finish before rolling back the agent. Reverting the agent alone leaves
  the new worker talking to an older agent that does not send the frame.
- The executions table, `ai_messages.turn_kind` column, capture policy on persisted
  tool output, per-source usage breakdown, and agent ingest path ship unflagged. The
  migrations are additive and can stay.
