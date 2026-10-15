BEGIN;

ALTER TABLE "projects" ADD COLUMN "free_quota_eligible" BOOLEAN NOT NULL DEFAULT true;

-- Do not retroactively charge usage from projects deleted before this rollout.
UPDATE "projects" SET "free_quota_eligible" = false WHERE "delete_time" IS NOT NULL;

ALTER TABLE "workspaces" ADD COLUMN "free_lifetime_usage" JSONB;

COMMIT;
