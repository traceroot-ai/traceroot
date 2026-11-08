BEGIN;
SET LOCAL lock_timeout = '5s';

-- How many thread posts of an update reached Slack.

-- AlterTable
ALTER TABLE "project_update_runs" ADD COLUMN     "slack_thread_posts" INTEGER NOT NULL DEFAULT 0;


COMMIT;
