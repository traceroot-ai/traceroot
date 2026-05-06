-- AlterTable
ALTER TABLE "detector_alert_configs" ADD COLUMN     "slack_channel_id" VARCHAR,
ADD COLUMN     "slack_channel_name" VARCHAR;

-- CreateTable
CREATE TABLE "slack_integrations" (
    "id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "team_id" VARCHAR NOT NULL,
    "team_name" VARCHAR NOT NULL,
    "bot_user_id" VARCHAR NOT NULL,
    "bot_token" TEXT NOT NULL,
    "channel_id" VARCHAR,
    "channel_name" VARCHAR,
    "connected_by_user_id" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "slack_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_integrations_workspace_id_key" ON "slack_integrations"("workspace_id");

-- AddForeignKey
ALTER TABLE "slack_integrations" ADD CONSTRAINT "slack_integrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
