-- When each project first received a trace, and a per-user onboarding row that
-- counts the days in a user's first week on which their projects received
-- traces. One nullable column on projects (no default, so no table rewrite) and
-- a new table. Bound lock acquisition; roll back atomically on timeout and retry
-- during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "first_trace_receive_time" TIMESTAMP(6);

-- CreateTable
CREATE TABLE "user_onboarding" (
    "user_id" VARCHAR NOT NULL,
    "last_active_day" DATE,
    "active_days_first_week" INTEGER NOT NULL DEFAULT 0,
    "active_week_at" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "user_onboarding_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "user_onboarding" ADD CONSTRAINT "user_onboarding_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
