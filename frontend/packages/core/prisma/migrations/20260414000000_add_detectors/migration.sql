-- Detectors feature: detectors, triggers, alert configs, RCA
-- Also includes:
--   * ai_sessions.user_id nullable (system sessions for RCA worker)
--   * projects.rca_model (project-scoped agent model for RCA)
--   * workspaces.detector_blocked / rca_blocked (Free-plan hard-cap flags
--     set by the hourly billing cron; mirrors existing ai_blocked)
--   * ai_messages.kind / workspace_id / nullable session_id (so chat,
--     RCA, and detector-scan rows share one table with categorical
--     billing aggregation by kind)

-- AlterTable: project-scoped RCA agent model
ALTER TABLE "projects" ADD COLUMN "rca_model" VARCHAR;

-- AlterTable: Free-plan hard-cap flags (set by hourly billing cron)
ALTER TABLE "workspaces" ADD COLUMN "detector_blocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workspaces" ADD COLUMN "rca_blocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "detectors" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "template" VARCHAR NOT NULL,
    "prompt" TEXT NOT NULL,
    "output_schema" JSONB NOT NULL,
    "sample_rate" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "detection_model" VARCHAR,
    "detection_provider" VARCHAR,
    "detection_source" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "detectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detector_triggers" (
    "id" VARCHAR NOT NULL,
    "detector_id" VARCHAR NOT NULL,
    "conditions" JSONB NOT NULL,

    CONSTRAINT "detector_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable: project-scoped alert config (1:1 with project)
CREATE TABLE "detector_alert_configs" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "email_addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "detector_alert_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detector_rcas" (
    "id" VARCHAR NOT NULL,
    "finding_id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "session_id" VARCHAR,
    "status" VARCHAR NOT NULL,
    "result" TEXT,
    "completed_at" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "detector_rcas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_detector_project_id" ON "detectors"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "detector_triggers_detector_id_key" ON "detector_triggers"("detector_id");

-- CreateIndex
CREATE UNIQUE INDEX "detector_alert_configs_project_id_key" ON "detector_alert_configs"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "detector_rcas_finding_id_key" ON "detector_rcas"("finding_id");

-- CreateIndex
CREATE INDEX "ix_detector_rcas_project_id" ON "detector_rcas"("project_id");

-- AddForeignKey
ALTER TABLE "detectors" ADD CONSTRAINT "detectors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detector_triggers" ADD CONSTRAINT "detector_triggers_detector_id_fkey" FOREIGN KEY ("detector_id") REFERENCES "detectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detector_alert_configs" ADD CONSTRAINT "detector_alert_configs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detector_rcas" ADD CONSTRAINT "detector_rcas_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Make ai_sessions.user_id nullable (system/RCA sessions have no user)
ALTER TABLE "ai_sessions" ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable ai_messages: categorical kind tag, direct workspace pointer,
-- and nullable session_id so detector-scan rows (no chat session) can live
-- alongside chat + RCA agent turns. Backfill workspace_id from the
-- existing session -> project -> workspace chain, then enforce NOT NULL.
ALTER TABLE "ai_messages" ADD COLUMN "kind" VARCHAR NOT NULL DEFAULT 'chat';

ALTER TABLE "ai_messages" ALTER COLUMN "session_id" DROP NOT NULL;

ALTER TABLE "ai_messages" ADD COLUMN "workspace_id" VARCHAR;

UPDATE "ai_messages" m
SET workspace_id = p.workspace_id
FROM ai_sessions s
JOIN projects p ON p.id = s.project_id
WHERE s.id = m.session_id;

ALTER TABLE "ai_messages" ALTER COLUMN "workspace_id" SET NOT NULL;

ALTER TABLE "ai_messages"
  ADD CONSTRAINT "ai_messages_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE INDEX "ix_ai_message_workspace_kind_time"
  ON "ai_messages"("workspace_id", "kind", "create_time");
