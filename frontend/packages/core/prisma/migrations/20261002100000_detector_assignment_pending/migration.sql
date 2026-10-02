-- A partition with hits waiting for signal assignment, recorded in Postgres
-- before the Redis enqueue so a failed enqueue is still recovered by the sweeper.
ALTER TABLE "detectors" ADD COLUMN "assignment_pending_at" TIMESTAMP(6);
