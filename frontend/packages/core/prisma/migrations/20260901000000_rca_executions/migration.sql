-- CreateEnum
CREATE TYPE "TraceStatus" AS ENUM ('disabled', 'pending', 'available', 'failed');

-- CreateTable
CREATE TABLE "detector_rca_executions" (
  "id"           VARCHAR NOT NULL,
  "finding_id"   VARCHAR NOT NULL,
  "project_id"   VARCHAR NOT NULL,
  "attempt"      INTEGER NOT NULL,
  "trace_id"     VARCHAR NOT NULL,
  "trace_status" "TraceStatus" NOT NULL DEFAULT 'pending',
  "session_id"   VARCHAR,
  "result"       TEXT,
  "started_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"  TIMESTAMP(6),
  CONSTRAINT "detector_rca_executions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "detector_rca_executions_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "detector_rcas"("finding_id") ON DELETE CASCADE,
  CONSTRAINT "detector_rca_executions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_sessions"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "uq_rca_execution_finding_attempt" ON "detector_rca_executions"("finding_id", "attempt");
CREATE INDEX "ix_rca_execution_project_id" ON "detector_rca_executions"("project_id");

ALTER TABLE "detector_rcas" ADD COLUMN "latest_execution_id" VARCHAR;
CREATE UNIQUE INDEX "detector_rcas_latest_execution_id_key" ON "detector_rcas"("latest_execution_id");
ALTER TABLE "detector_rcas" ADD CONSTRAINT "detector_rcas_latest_execution_id_fkey"
  FOREIGN KEY ("latest_execution_id") REFERENCES "detector_rca_executions"("id") ON DELETE SET NULL;

-- No backfill. Existing RCAs keep latest_execution_id = NULL; every reader treats that as
-- "no execution recorded" (null trace fields, no links). If such a finding is ever re-run,
-- allocateExecution seeds attempt 1 from the legacy row first (see rca-executions.ts), so
-- "attempt 1 = the first RCA = dashless finding id" stays true for old findings too.
