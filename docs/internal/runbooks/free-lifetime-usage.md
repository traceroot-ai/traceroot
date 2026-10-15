# Free-plan lifetime usage

Free-plan event and detector-scan quotas include usage from projects soft-deleted
after the lifetime-accounting migration. Deleting a project does not restore these
allowances. Paid workspaces continue to meter active projects within their billing
period; their usage is not raised to the free-plan lifetime floor.

## Roll out

1. Apply Prisma migration `20261015000000_lifetime_free_usage` before deploying
   the billing worker. From `frontend/packages/core`, with `DATABASE_URL` set:
   `pnpm exec prisma migrate deploy`.
2. Regenerate the Prisma client when building the worker (`pnpm db:generate`).
3. Deploy the billing worker. The next hourly billing run records the first
   `workspaces.free_lifetime_usage` snapshot.

The migration marks projects already deleted at rollout as ineligible. Existing
active projects and newly created projects are eligible, and remain eligible after
soft deletion. This avoids retroactively charging previously deleted projects,
while also counting projects created and deleted between billing runs. The
eligibility backfill and column additions run in one transaction.

## Accounting and verification

The worker queries all eligible projects for free plans, including soft-deleted
ones. A workspace row lock serializes the final usage update: each source's event
counts and the detector-scan count cannot fall below the last observed lifetime
snapshot. Displayed usage, ingestion/detector blocking flags and quota notification
inputs use these committed totals. A plan change during collection skips the stale
write; the next run uses the new plan's billing window. Paid updates preserve the
separate lifetime snapshot, including across an upgrade and later downgrade.

To inspect a workspace after a billing run:

```sql
SELECT id, billing_plan, free_lifetime_usage, current_usage,
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

The persisted snapshot is an observed floor, not an ingestion ledger. It preserves
counts already seen by the billing worker if ClickHouse retention later removes
rows; it cannot recover usage removed before observation. Physical project deletion
and retention-proof accounting need a separate durable usage ledger. This change
does not alter hourly enforcement timing, RCA/AI accounting, detector run-status
selection, Stripe pricing, or notification delivery behavior.
