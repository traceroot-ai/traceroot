BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "task_group_settings" (
    "project_id" VARCHAR NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "daily_cost_cap_usd" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_group_settings_pkey" PRIMARY KEY ("project_id")
);

CREATE TABLE "task_group_spend_days" (
    "project_id" VARCHAR NOT NULL,
    "day" DATE NOT NULL,
    "summaries" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_group_spend_days_pkey" PRIMARY KEY ("project_id", "day")
);

ALTER TABLE "task_group_settings"
    ADD CONSTRAINT "task_group_settings_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
