BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "billing_meter_cursors" (
  "id" VARCHAR NOT NULL,
  "workspace_id" VARCHAR NOT NULL,
  "meter" VARCHAR NOT NULL,
  "period_start" TIMESTAMP(6) NOT NULL,
  "confirmed_units" INTEGER NOT NULL DEFAULT 0,
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
  "from_units" INTEGER NOT NULL,
  "to_units" INTEGER NOT NULL,
  "units" INTEGER NOT NULL,
  "stripe_customer_id" VARCHAR NOT NULL,
  "event_name" VARCHAR NOT NULL,
  "identifier" VARCHAR(100) NOT NULL,
  "event_timestamp" INTEGER NOT NULL,
  "status" VARCHAR NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
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

ALTER TABLE "billing_meter_cursors"
  ADD CONSTRAINT "billing_meter_cursors_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "billing_meter_reports"
  ADD CONSTRAINT "billing_meter_reports_cursor_id_fkey"
  FOREIGN KEY ("cursor_id") REFERENCES "billing_meter_cursors"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- Preserve every legacy confirmed watermark before switching the worker to the
-- durable cursor. NULL billing-period anchors use the same epoch sentinel as
-- the worker; no already-reported usage is replayed during rollout.
INSERT INTO "billing_meter_cursors"
  ("id", "workspace_id", "meter", "period_start", "confirmed_units", "create_time", "update_time")
SELECT
  'legacy_' || md5(w."id" || ':' || m."meter" || ':' || p."period_start"::text),
  w."id",
  m."meter",
  p."period_start",
  CASE WHEN m."raw_units" ~ '^[0-9]+,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workspaces" w
CROSS JOIN LATERAL (
  VALUES
    ('ai', COALESCE(w."current_usage" #>> '{ai,lastReportedUnits}', '0')),
    ('rca', COALESCE(w."current_usage" #>> '{rca,lastReportedUnits}', '0')),
    ('detector', COALESCE(w."current_usage" #>> '{detector,lastReportedUnits}', '0'))
) AS m("meter", "raw_units")
CROSS JOIN LATERAL (
  SELECT COALESCE(w."billing_period_start", TIMESTAMP '1970-01-01 00:00:00') AS "period_start"
) AS p
WHERE m."raw_units" ~ '^[0-9]+$'
  AND m."raw_units"::numeric > 0
ON CONFLICT ("workspace_id", "meter", "period_start") DO NOTHING;

COMMIT;
 THEN LEAST(m."raw_units"::numeric, 2147483647)::integer ELSE 0 END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workspaces" w
CROSS JOIN LATERAL (
  VALUES
    ('ai', COALESCE(w."current_usage" #>> '{ai,lastReportedUnits}', '0')),
    ('rca', COALESCE(w."current_usage" #>> '{rca,lastReportedUnits}', '0')),
    ('detector', COALESCE(w."current_usage" #>> '{detector,lastReportedUnits}', '0'))
) AS m("meter", "raw_units")
CROSS JOIN LATERAL (
  SELECT COALESCE(w."billing_period_start", TIMESTAMP '1970-01-01 00:00:00') AS "period_start"
) AS p
WHERE m."raw_units" ~ '^[0-9]+$'
  AND m."raw_units"::numeric > 0
ON CONFLICT ("workspace_id", "meter", "period_start") DO NOTHING;

COMMIT;
