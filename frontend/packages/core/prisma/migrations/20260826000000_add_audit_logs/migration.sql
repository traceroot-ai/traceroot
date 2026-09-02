-- The audit trail for non-interactive writes.
--
-- Purpose: one append-only row per write that changes account state, recording
-- who (actor_user_id), what (operation, resource, summary), where (workspace/
-- project), and crucially HOW — transport distinguishes a public-API call from
-- an in-app agent action (with its session), because "who" alone no longer
-- identifies the author's intent once machines write on a user's behalf.
--
-- Why this table did not exist before: every write used to be a human in the
-- UI on their own cookie session — the actor was the session, the intent was
-- the click, and the result was on screen. Attribution was structural.
--
-- Why it is needed now: the public write API lets the CLI, the in-app agent,
-- and any credential holder create resources with no human watching. Once a
-- dashboard can appear without anyone having clicked, "where did this come
-- from" must be answerable from storage. Deliberately no foreign keys: audit
-- rows must survive the deletion of everything they describe. UI writes will
-- join this trail (transport "ui") when the cookie routes move to the shared
-- write services.

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
