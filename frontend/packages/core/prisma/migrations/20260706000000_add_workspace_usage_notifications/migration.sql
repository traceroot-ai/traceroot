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

-- Backfill: free workspaces already blocked before this feature shipped are
-- marked as already-notified, so the first worker tick doesn't mass-email the
-- existing over-cap population. Both thresholds are stamped: past 100%
-- implies past 80%, and an "approaching" warning after a block is nonsense.
-- period_start = epoch matches the worker's all-time free-plan usage window;
-- a plain TIMESTAMP literal (not to_timestamp(0), which is timestamptz and
-- shifts with the session timezone) so the stored value equals the worker's
-- exact-equality epoch anchor regardless of server timezone.
INSERT INTO "workspace_usage_notifications"
    ("id", "workspace_id", "meter", "period_start", "warning_sent_at", "blocked_sent_at")
SELECT
    w."id" || ':' || m.meter,
    w."id",
    m.meter,
    TIMESTAMP '1970-01-01 00:00:00',
    now(),
    now()
FROM "workspaces" w
CROSS JOIN (VALUES ('events'), ('rca'), ('detector')) AS m(meter)
WHERE w."billing_plan" = 'free'
  AND ((m.meter = 'events'   AND w."ingestion_blocked")
    OR (m.meter = 'rca'      AND w."rca_blocked")
    OR (m.meter = 'detector' AND w."detector_blocked"));
