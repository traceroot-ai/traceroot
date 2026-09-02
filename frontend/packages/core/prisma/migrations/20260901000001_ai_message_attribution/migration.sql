CREATE TYPE "TurnKind" AS ENUM ('rca_execution', 'rca_followup', 'chat', 'detector', 'digest');
ALTER TABLE "ai_messages"
  ADD COLUMN "turn_kind" "TurnKind" NOT NULL DEFAULT 'chat',
  ADD COLUMN "execution_id" VARCHAR,
  ADD COLUMN "initiator_user_id" VARCHAR;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_execution_id_fkey"
  FOREIGN KEY ("execution_id") REFERENCES "detector_rca_executions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
-- Deleting an execution (cascade from a finding delete) nulls these FKs; without
-- an index each delete scans the table. The agent-trace viewer also reads a
-- finding's turns by execution.
CREATE INDEX "ix_ai_message_execution_id" ON "ai_messages"("execution_id");

ALTER TABLE "ai_sessions" ADD COLUMN "execution_id" VARCHAR;
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_execution_id_fkey"
  FOREIGN KEY ("execution_id") REFERENCES "detector_rca_executions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
CREATE INDEX "ix_ai_session_execution_id" ON "ai_sessions"("execution_id");

-- Backfill from the legacy kind. Historical system-session turns cannot be split into
-- execution vs follow-up after the fact; all are attributed to the execution.
UPDATE "ai_messages" SET "turn_kind" = 'rca_execution' WHERE "kind" = 'rca';
UPDATE "ai_messages" SET "turn_kind" = 'detector'      WHERE "kind" = 'detector';
UPDATE "ai_messages" SET "turn_kind" = 'digest'        WHERE "kind" = 'digest-summary';
UPDATE "ai_messages" m SET "initiator_user_id" = s."user_id"
  FROM "ai_sessions" s WHERE m."session_id" = s."id" AND s."user_id" IS NOT NULL;
