BEGIN;
SET LOCAL lock_timeout = '5s';

DROP INDEX "ix_stripe_meter_event_recovery";
-- Prisma 5.22 omits NULLS FIRST from generated SQL; preserve the recovery query order explicitly.
CREATE INDEX "ix_stripe_meter_event_recovery"
    ON "stripe_meter_events"(
        "status",
        "last_attempt_at" ASC NULLS FIRST,
        "create_time" ASC,
        "id" ASC
    );

COMMIT;
