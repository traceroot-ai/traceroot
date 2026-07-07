-- Per-(workspace, meter) state for free-plan usage-quota emails (80% warn,
-- 100% blocked). One row per meter; period_start anchors the row to the
-- usage window the billing worker measured against (epoch for free plans).
CREATE TABLE "workspace_usage_notifications" (
    "id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "meter" VARCHAR NOT NULL,
    "period_start" TIMESTAMP(6) NOT NULL,
    "warning_sent_at" TIMESTAMP(6),
    "blocked_sent_at" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_usage_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_usage_notification_workspace_meter"
    ON "workspace_usage_notifications"("workspace_id", "meter");

ALTER TABLE "workspace_usage_notifications"
    ADD CONSTRAINT "workspace_usage_notifications_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
