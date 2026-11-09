BEGIN;
SET LOCAL lock_timeout = '5s';

-- The code changes section is opt-in per project, with a list of repositories.

-- AlterTable
ALTER TABLE "project_update_schedules" ADD COLUMN     "code_changes_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "code_repos" TEXT[] DEFAULT ARRAY[]::TEXT[];


COMMIT;
