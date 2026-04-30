-- Detectors feature: detectors, triggers, alert configs, RCA
-- Also includes: ai_sessions.user_id nullable (system sessions for RCA worker)
-- Also includes: projects.rca_model (project-scoped agent model for RCA)

-- AlterTable: project-scoped RCA agent model
ALTER TABLE "projects" ADD COLUMN "rca_model" VARCHAR;

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
    "detection_adapter" VARCHAR,
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
