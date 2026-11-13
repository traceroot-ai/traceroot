BEGIN;
SET LOCAL lock_timeout = '5s';

-- Background updates: a per-project schedule and one row per run.

-- CreateTable
CREATE TABLE "project_update_schedules" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "frequency" VARCHAR NOT NULL DEFAULT 'weekly',
    "weekday" INTEGER NOT NULL DEFAULT 1,
    "hour" INTEGER NOT NULL DEFAULT 9,
    "timezone" VARCHAR NOT NULL DEFAULT 'UTC',
    "next_slot_at" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "project_update_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_update_runs" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "dedupe_key" VARCHAR NOT NULL,
    "trigger" VARCHAR NOT NULL,
    "slot_at" TIMESTAMP(6) NOT NULL,
    "window_start" TIMESTAMP(6) NOT NULL,
    "window_end" TIMESTAMP(6) NOT NULL,
    "prev_window_start" TIMESTAMP(6) NOT NULL,
    "prev_window_end" TIMESTAMP(6) NOT NULL,
    "frequency" VARCHAR NOT NULL,
    "timezone" VARCHAR NOT NULL,
    "status" VARCHAR NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "started_at" TIMESTAMP(6),
    "finished_at" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_update_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_update_schedules_project_id_key" ON "project_update_schedules"("project_id");

-- CreateIndex
CREATE INDEX "ix_project_update_schedule_due" ON "project_update_schedules"("enabled", "next_slot_at");

-- CreateIndex
CREATE UNIQUE INDEX "project_update_runs_dedupe_key_key" ON "project_update_runs"("dedupe_key");

-- CreateIndex
CREATE INDEX "ix_project_update_run_project_slot" ON "project_update_runs"("project_id", "slot_at");

-- AddForeignKey
ALTER TABLE "project_update_schedules" ADD CONSTRAINT "project_update_schedules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_update_runs" ADD CONSTRAINT "project_update_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A schedule can only be daily or weekly, with a real weekday and hour.
ALTER TABLE "project_update_schedules"
  ADD CONSTRAINT "ck_project_update_schedule_frequency" CHECK ("frequency" IN ('daily', 'weekly')),
  ADD CONSTRAINT "ck_project_update_schedule_weekday" CHECK ("weekday" BETWEEN 1 AND 7),
  ADD CONSTRAINT "ck_project_update_schedule_hour" CHECK ("hour" BETWEEN 0 AND 23);

COMMIT;
