CREATE TYPE "TurnKind" AS ENUM ('rca_execution', 'rca_followup', 'chat', 'detector', 'digest');
-- The turn's kind, decided per request (an RCA session's follow-up is not the
-- execution turn) — the column the follow-up metering fix (#2031) keys on.
-- A message's execution is reached through its session (one session per
-- execution), and a follow-up's author is on the user row's metadata
-- (`initiatorUserId`); neither gets a column until something reads it.
ALTER TABLE "ai_messages"
  ADD COLUMN "turn_kind" "TurnKind" NOT NULL DEFAULT 'chat';

ALTER TABLE "ai_sessions" ADD COLUMN "execution_id" VARCHAR;
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_execution_id_fkey"
  FOREIGN KEY ("execution_id") REFERENCES "detector_rca_executions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
CREATE INDEX "ix_ai_session_execution_id" ON "ai_sessions"("execution_id");

-- Backfill from the legacy kind. Historical system-session turns cannot be split into
-- execution vs follow-up after the fact; all are attributed to the execution.
UPDATE "ai_messages" SET "turn_kind" = 'rca_execution' WHERE "kind" = 'rca';
UPDATE "ai_messages" SET "turn_kind" = 'detector'      WHERE "kind" = 'detector';
UPDATE "ai_messages" SET "turn_kind" = 'digest'        WHERE "kind" = 'digest-summary';
