-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "last_error" VARCHAR,
ADD COLUMN     "last_error_at" TIMESTAMP(6),
ADD COLUMN     "last_notify_at" TIMESTAMP(6),
ADD COLUMN     "last_notify_error" VARCHAR,
ADD COLUMN     "last_notify_status" VARCHAR;

-- The claim query orders by next_run_at ASC, and Postgres sorts NULLs last, so
-- a rule predating the seeding of next_run_at at insert now sorts behind every
-- scheduled rule and is starved whenever the due set fills the tick's budget.
-- Due now, and no earlier, is what the insert path writes.
UPDATE "alerts" SET "next_run_at" = NOW() AT TIME ZONE 'UTC' WHERE "next_run_at" IS NULL;
