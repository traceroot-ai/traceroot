BEGIN;
SET LOCAL lock_timeout = '5s';

-- Update runs keep their attempt count, the computed facts and the signals roll-up.

-- AlterTable
ALTER TABLE "project_update_runs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "facts" JSONB,
ADD COLUMN     "signals_rollup" JSONB;


COMMIT;
