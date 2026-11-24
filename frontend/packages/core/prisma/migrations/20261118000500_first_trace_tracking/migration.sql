-- When this deployment started recording first traces. The web app writes the one
-- row with its first trace-activity report; a project whose earliest stored trace is
-- older already had traces then and records no first-trace event. A new table only,
-- created empty. Bound lock acquisition; roll back atomically on timeout and retry
-- during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateTable
CREATE TABLE "first_trace_tracking" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "first_trace_tracking_pkey" PRIMARY KEY ("id"),
    -- One deployment, one start: Prisma cannot express this, so it lives here.
    CONSTRAINT "first_trace_tracking_single_row" CHECK ("id" = 1)
);

COMMIT;
