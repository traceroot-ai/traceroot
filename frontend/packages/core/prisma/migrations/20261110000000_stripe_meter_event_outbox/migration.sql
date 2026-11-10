BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "billing_meter_cursors" (
  "id" VARCHAR NOT NULL,
  "workspace_id" VARCHAR NOT NULL,
  "meter" VARCHAR NOT NULL,
  "period_start" TIMESTAMP(6) NOT NULL,
  "confirmed_units" BIGINT NOT NULL DEFAULT 0,
  "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "update_time" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "billing_meter_cursors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_billing_meter_cursor"
  ON "billing_meter_cursors"("workspace_id", "meter", "period_start");
CREATE INDEX "ix_billing_meter_cursor_workspace"
  ON "billing_meter_cursors"("workspace_id");

CREATE TABLE "billing_meter_reports" (
  "id" VARCHAR NOT NULL,
  "cursor_id" VARCHAR NOT NULL,
  "from_units" BIGINT NOT NULL,
  "to_units" BIGINT NOT NULL,
  "units" BIGINT NOT NULL,
  "stripe_customer_id" VARCHAR NOT NULL,
  "event_name" VARCHAR NOT NULL,
  "identifier" VARCHAR(100) NOT NULL,
  "event_timestamp" INTEGER NOT NULL,
  "status" VARCHAR NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "attempt_token" VARCHAR,
  "first_attempt_at" TIMESTAMP(6),
  "next_attempt_at" TIMESTAMP(6),
  "lease_expires_at" TIMESTAMP(6),
  "delivered_at" TIMESTAMP(6),
  "stripe_request_id" VARCHAR,
  "last_error" TEXT,
  "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "update_time" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "billing_meter_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_meter_reports_identifier_key"
  ON "billing_meter_reports"("identifier");
CREATE UNIQUE INDEX "uq_billing_meter_report_range"
  ON "billing_meter_reports"("cursor_id", "from_units", "to_units");
CREATE INDEX "ix_billing_meter_report_dispatch"
  ON "billing_meter_reports"("status", "next_attempt_at", "lease_expires_at");
CREATE INDEX "ix_billing_meter_report_cursor_status"
  ON "billing_meter_reports"("cursor_id", "status", "create_time");

ALTER TABLE "billing_meter_cursors"
  ADD CONSTRAINT "billing_meter_cursors_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "billing_meter_reports"
  ADD CONSTRAINT "billing_meter_reports_cursor_id_fkey"
  FOREIGN KEY ("cursor_id") REFERENCES "billing_meter_cursors"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- Preserve the existing confirmed watermark only when its stored period still
-- matches the workspace's current billing-period anchor. NULL uses epoch as
-- the sentinel, matching the worker's cursor key after deployment.
INSERT INTO "billing_meter_cursors"
  ("id", "workspace_id", "meter", "period_start", "confirmed_units", "create_time", "update_time")
SELECT
  'legacy_' || md5(w."id" || ':' || m."meter" || ':' || p."period_start"::text),
  w."id",
  m."meter",
  p."period_start",
  CASE
    WHEN m."raw_units" ~ '^[0-9]+$'
      AND (
        (w."billing_period_start" IS NULL AND m."raw_period_start" IS NULL)
        OR (
          w."billing_period_start" IS NOT NULL
          AND m."raw_period_start" IS NOT NULL
          AND (m."raw_period_start"::timestamptz AT TIME ZONE 'UTC') = w."billing_period_start"
        )
      )
    THEN LEAST(m."raw_units"::numeric, 9007199254740991)::bigint
    ELSE 0
  END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workspaces" w
CROSS JOIN LATERAL (
  VALUES
    ('ai', COALESCE(w."current_usage" #>> '{ai,lastReportedUnits}', '0'), w."current_usage" #>> '{ai,lastReportedPeriodStart}'),
    ('rca', COALESCE(w."current_usage" #>> '{rca,lastReportedUnits}', '0'), w."current_usage" #>> '{rca,lastReportedPeriodStart}'),
    ('detector', COALESCE(w."current_usage" #>> '{detector,lastReportedUnits}', '0'), w."current_usage" #>> '{detector,lastReportedPeriodStart}')
) AS m("meter", "raw_units", "raw_period_start")
CROSS JOIN LATERAL (
  SELECT COALESCE(w."billing_period_start", TIMESTAMP '1970-01-01 00:00:00') AS "period_start"
) AS p
WHERE CASE
  WHEN m."raw_units" ~ '^[0-9]+$' THEN m."raw_units"::numeric > 0
  ELSE FALSE
END
ON CONFLICT ("workspace_id", "meter", "period_start") DO NOTHING;

COMMIT;
