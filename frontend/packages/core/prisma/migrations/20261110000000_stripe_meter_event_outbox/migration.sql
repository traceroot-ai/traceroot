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

-- Preserve a legacy watermark only when its saved period matches the
-- effective cursor period. For workspaces without a billing-period anchor,
-- this is the same calendar-month fallback used by the legacy worker.
INSERT INTO "billing_meter_cursors"
  ("id", "workspace_id", "meter", "period_start", "confirmed_units", "create_time", "update_time")
SELECT
  'legacy_' || md5(w."id" || ':' || m."meter" || ':' || p."period_start"::text),
  w."id",
  m."meter",
  p."period_start",
  CASE
    WHEN parsed."period_start" IS NULL
      OR (parsed."period_start" AT TIME ZONE 'UTC') <> p."period_start" THEN 0
    WHEN n."normalized_units" IS NULL THEN 0
    WHEN length(n."normalized_units") > 16 THEN 9007199254740991::bigint
    WHEN length(n."normalized_units") = 16
      AND n."normalized_units" > '9007199254740991' THEN 9007199254740991::bigint
    ELSE n."normalized_units"::bigint
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
-- Normalize decimal strings as text before casting. Leading zeroes are
-- removed, and arbitrary-length values never reach a NUMERIC or BIGINT cast.
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN m."raw_units" ~ '^[0-9]' AND m."raw_units" !~ '[^0-9]'
      THEN COALESCE(NULLIF(ltrim(m."raw_units", '0'), ''), '0')
    ELSE NULL
  END AS "normalized_units"
) AS n
-- PostgreSQL 17 is the repository's development database version.
-- Validate untrusted legacy JSON text before casting; invalid/missing periods
-- yield NULL and therefore leave the restored watermark at zero.
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN pg_input_is_valid(m."raw_period_start", 'timestamp with time zone')
      THEN m."raw_period_start"::timestamptz
    ELSE NULL
  END AS "period_start"
) AS parsed
CROSS JOIN LATERAL (
  SELECT COALESCE(
    w."billing_period_start",
    date_trunc('month', CURRENT_TIMESTAMP)::timestamp
  ) AS "period_start"
) AS p
WHERE n."normalized_units" IS NOT NULL
  AND n."normalized_units" <> '0'
ON CONFLICT ("workspace_id", "meter", "period_start") DO NOTHING;

COMMIT;
