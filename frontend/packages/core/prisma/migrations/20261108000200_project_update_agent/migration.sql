BEGIN;
SET LOCAL lock_timeout = '5s';

-- Update runs keep the agent's result, usage and delivery state; schedules keep their limits.

-- AlterTable
ALTER TABLE "project_update_runs" ADD COLUMN     "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "delivery_note" TEXT,
ADD COLUMN     "email_delivered_at" TIMESTAMP(6),
ADD COLUMN     "model" VARCHAR,
ADD COLUMN     "result" JSONB,
ADD COLUMN     "skills_ran" JSONB,
ADD COLUMN     "slack_delivered_at" TIMESTAMP(6),
ADD COLUMN     "slack_message_ts" VARCHAR,
ADD COLUMN     "stop_reason" VARCHAR,
ADD COLUMN     "tokens_in" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tokens_out" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "project_update_schedules" ADD COLUMN     "monthly_spend_cap_usd" DOUBLE PRECISION NOT NULL DEFAULT 20,
ADD COLUMN     "run_token_cap" INTEGER NOT NULL DEFAULT 200000;


ALTER TABLE "project_update_schedules"
  ADD CONSTRAINT "ck_project_update_schedule_run_token_cap" CHECK ("run_token_cap" BETWEEN 1000 AND 5000000),
  ADD CONSTRAINT "ck_project_update_schedule_monthly_spend_cap" CHECK ("monthly_spend_cap_usd" >= 0 AND "monthly_spend_cap_usd" <= 10000);

COMMIT;
