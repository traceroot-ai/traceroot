BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "task_group_settings"
    ADD COLUMN "refresh_requested_at" TIMESTAMP(6),
    ADD COLUMN "last_refresh_at" TIMESTAMP(6);

CREATE TABLE "task_group_fit_runs" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "trigger" VARCHAR NOT NULL,
    "run_day" DATE NOT NULL,
    "status" VARCHAR NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "fit_id" VARCHAR,
    "digest_count" INTEGER,
    "group_count" INTEGER,
    "noise_count" INTEGER,
    "duration_ms" INTEGER,
    "error" VARCHAR,
    "started_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(6),

    CONSTRAINT "task_group_fit_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_task_group_fit_run_project" ON "task_group_fit_runs"("project_id", "started_at");

-- At most one daily run per project and UTC day: the claim a second tick loses.
CREATE UNIQUE INDEX "uq_task_group_fit_run_daily"
    ON "task_group_fit_runs"("project_id", "run_day") WHERE "trigger" = 'daily';

COMMIT;
