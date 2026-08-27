# Agent self-trace — enable, observe, disable

Every TraceRoot-operated agent run (automatic RCA, follow-up and manual chat turns, the
worker's digest-summary call) can be recorded as a trace in the customer's project,
stored under `source='agent'` (agent service) or `source='detector'` (worker). Emission is
off by default and controlled per kind.

## Enable (cloud)

1. Mint `INTERNAL_API_SECRET_AGENT` (`openssl rand -hex 32`). Set it on the **agent
   service** and the **REST** service only. `make dev` / `make prod` generate it locally.
   Do not set it on the worker or the UI: which secret authenticates a request decides the
   `source` the ingest route stamps, and only the agent service may write `agent`.
2. Apply the Prisma migrations `20260901000000_rca_executions` and
   `20260901000001_ai_message_attribution` (`pnpm db:migrate deploy` in
   `frontend/packages/core`). Both are additive; no backfill of executions is performed.
3. Agent service env: `AGENT_SELF_TRACE=1`, then widen `AGENT_SELF_TRACE_KINDS` over a
   few days: `rca` → `rca,followup` → `rca,followup,chat`. Unset means all kinds.
4. Confirm after the first RCA:
   `select attempt, trace_status, count(*) from detector_rca_executions
    where started_at > now() - interval '1 hour' group by 1,2` shows `available` and no
   `failed`; the finding's ID is clickable in the detector runs table.

## Observe (first week)

- Span volume by source:
  `SELECT source, count(), sum(length(output)) FROM spans
   WHERE ch_create_time > now() - INTERVAL 1 DAY GROUP BY source`.
- Export failures: agent-service log lines `[AgentTrace] export failed`.
- Customer surfaces: the Traces list and dashboards must show zero `agent` rows
  (`customer_traffic_only()` guards every customer read; `tests/rest/test_source_consumers.py`
  enforces the inventory).
- Billing: `/api/v1/internal/usage/details` returns `by_source`; the Stripe quantity
  follows the unfiltered total (stored rows are billed whoever wrote them), the Free
  ingestion cap follows `by_source.user` only.

## Disable

- One kind: remove it from `AGENT_SELF_TRACE_KINDS` — takes effect on the next turn, no
  restart.
- Entirely: `AGENT_SELF_TRACE=0`. Existing `available` links keep working; new executions
  record `trace_status=disabled` and persist exactly the rows they did before tracing.

## Rollback

- With the flag off the agent service, worker and REST behave as before emission; the
  only runtime differences that ship unflagged are the executions table, the attribution
  columns, the capture policy on persisted tool output, and the Free cap counting
  customer rows only. Reverting the agent-service emit change alone stops emission; the
  migrations are additive and can stay.
