-- CreateTable
CREATE TABLE "audit_logs" (
    "id" VARCHAR NOT NULL,
    "actor_user_id" VARCHAR NOT NULL,
    "operation" VARCHAR NOT NULL,
    "resource_type" VARCHAR NOT NULL,
    "resource_id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR,
    "project_id" VARCHAR,
    "summary" JSONB NOT NULL,
    "transport" VARCHAR NOT NULL,
    "agent_session_id" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_audit_workspace_id" ON "audit_logs"("workspace_id");

-- CreateIndex
CREATE INDEX "ix_audit_actor_user_id" ON "audit_logs"("actor_user_id");
