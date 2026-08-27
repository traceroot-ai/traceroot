CREATE TYPE "TurnKind" AS ENUM ('rca_execution', 'rca_followup', 'chat', 'detector', 'digest');
ALTER TABLE "ai_messages"
  ADD COLUMN "turn_kind" "TurnKind" NOT NULL DEFAULT 'chat',
  ADD COLUMN "execution_id" VARCHAR,
  ADD COLUMN "initiator_user_id" VARCHAR;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_execution_id_fkey"
  FOREIGN KEY ("execution_id") REFERENCES "detector_rca_executions"("id") ON DELETE SET NULL;
ALTER TABLE "ai_sessions" ADD COLUMN "execution_id" VARCHAR;

-- Backfill from the legacy kind. Historical system-session turns cannot be split into
-- execution vs follow-up after the fact; all are attributed to the execution.
UPDATE "ai_messages" SET "turn_kind" = 'rca_execution' WHERE "kind" = 'rca';
UPDATE "ai_messages" SET "turn_kind" = 'detector'      WHERE "kind" = 'detector';
UPDATE "ai_messages" SET "turn_kind" = 'digest'        WHERE "kind" = 'digest-summary';
UPDATE "ai_messages" m SET "initiator_user_id" = s."user_id"
  FROM "ai_sessions" s WHERE m."session_id" = s."id" AND s."user_id" IS NOT NULL;
CREATE INDEX "ix_ai_message_workspace_turnkind_time" ON "ai_messages"("workspace_id", "turn_kind", "create_time");
