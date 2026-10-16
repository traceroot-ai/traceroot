# Free-plan lifetime usage

Free-plan event and detector-scan quotas include usage from projects soft-deleted
after the lifetime-accounting migration. Deleting a project does not restore these
allowances. Paid workspaces continue to meter active projects within their billing
period.

## Roll out

1. Apply Prisma migration `20261015000000_lifetime_free_usage` before deploying
   the billing worker. From `frontend/packages/core`, with `DATABASE_URL` set:
   `pnpm exec prisma migrate deploy`.
2. Regenerate the Prisma client when building the worker (`pnpm db:generate`).
3. Deploy the billing worker. The next hourly billing run updates `current_usage`
   and the blocking flags using the eligible projects for free workspaces and
   active projects for paid workspaces.

The migration marks projects already deleted at rollout as ineligible. Existing
active projects and newly created projects are eligible, and remain eligible after
soft deletion. This avoids retroactively charging previously deleted projects,
while also counting projects created and deleted between billing runs. The
eligibility backfill and column addition run in one transaction, with a five-second
lock timeout. If the migration times out, retry it after the blocking transaction
finishes, before deploying the worker.

## Accounting and verification

The worker queries all eligible projects for free plans, including soft-deleted
ones. Its telemetry query starts at the Unix epoch and uses a far-future end
(`2100-01-01`), rather than the billing job's start time. Replaying an existing
trace, span or detector run refreshes its ClickHouse version timestamp; after a
ReplacingMergeTree merge, a fixed job-start end could exclude the surviving row
and temporarily reduce counted usage. The far-future end keeps that row counted.
Paid telemetry queries retain their billing-period bounds.

Displayed usage, ingestion/detector blocking flags and quota notification inputs
use the same measured totals. There is no separate lifetime snapshot or row lock.
Changes to ingestion and detector blocking flags are logged by the billing worker.

To inspect a workspace after a billing run:

```sql
SELECT id, billing_plan, current_usage,
       ingestion_blocked, detector_blocked
FROM workspaces
WHERE id = '<workspace-id>';

SELECT id, delete_time, free_quota_eligible
FROM projects
WHERE workspace_id = '<workspace-id>';
```

Deleting an eligible project should leave its usage counted after the next run.
Two deleted projects with 60 scans each should still show 120 scans and a blocked
free detector quota. A paid workspace should continue to exclude deleted projects
and clear free-plan event/detector blocks.

## Limits

Accounting depends on the stored telemetry and eligible project records; it is not
an ingestion ledger. Retention currently restricts access without deleting
telemetry. Physical deletion or future data removal would require revisiting this
approach. This change does not alter hourly enforcement timing, RCA/AI accounting,
detector run-status selection, Stripe pricing, or notification delivery behavior.
