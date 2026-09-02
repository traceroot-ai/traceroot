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
  "started_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"  TIMESTAMP(6),
  CONSTRAINT "detector_rca_executions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "detector_rca_executions_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "detector_rcas"("finding_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "detector_rca_executions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_rca_execution_finding_attempt" ON "detector_rca_executions"("finding_id", "attempt");

-- No backfill. Findings whose RCA ran before this table existed have no execution row, and
-- every reader treats that as "no execution recorded" (null trace fields, no links). The
-- current execution of a finding is the row with the highest attempt; there is no pointer.
