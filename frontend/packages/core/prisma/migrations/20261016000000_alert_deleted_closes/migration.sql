-- The closes owed by rules deleted with a page open, kept until the worker has
-- posted them to Slack. A new table only, no existing table touched. Bound lock
-- acquisition; roll back atomically on timeout and retry during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateTable
CREATE TABLE "alert_deleted_closes" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "alert_id" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "actor_user_id" VARCHAR NOT NULL,
    "resends" INTEGER NOT NULL DEFAULT 0,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_deleted_closes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_alert_deleted_close_project_id" ON "alert_deleted_closes"("project_id");

-- AddForeignKey
ALTER TABLE "alert_deleted_closes" ADD CONSTRAINT "alert_deleted_closes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
