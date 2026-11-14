BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "StripeMeterEventStatus" AS ENUM (
    'PENDING',
    'SUBMITTED',
    'RECONCILIATION_REQUIRED'
);

CREATE TABLE "stripe_meter_events" (
    "id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "meter" VARCHAR NOT NULL,
    "period_start" TIMESTAMP(6) NOT NULL,
    "cumulative_units" INTEGER NOT NULL,
    "event_name" VARCHAR NOT NULL,
    "identifier" VARCHAR NOT NULL,
    "customer_id" VARCHAR NOT NULL,
    "units" INTEGER NOT NULL,
    "event_timestamp" TIMESTAMP(0) NOT NULL,
    "status" "StripeMeterEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "first_attempt_at" TIMESTAMP(6),
    "ambiguous_since" TIMESTAMP(6),
    "last_attempt_at" TIMESTAMP(6),
    "last_error_code" VARCHAR,
    "claim_token" VARCHAR,
    "claimed_at" TIMESTAMP(6),
    "submitted_at" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "stripe_meter_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stripe_meter_events_identifier_key"
    ON "stripe_meter_events"("identifier");

CREATE UNIQUE INDEX "uq_stripe_meter_event_workspace_meter_period_target"
    ON "stripe_meter_events"("workspace_id", "meter", "period_start", "cumulative_units");

CREATE INDEX "ix_stripe_meter_event_pending"
    ON "stripe_meter_events"("workspace_id", "meter", "period_start", "status");

CREATE INDEX "ix_stripe_meter_event_reconciliation"
    ON "stripe_meter_events"("status", "ambiguous_since");

ALTER TABLE "stripe_meter_events"
    ADD CONSTRAINT "stripe_meter_events_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
