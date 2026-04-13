-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('VIEWER', 'MEMBER', 'ADMIN');

-- CreateTable
CREATE TABLE "access_keys" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "secret_hash" VARCHAR NOT NULL,
    "key_hint" VARCHAR NOT NULL,
    "name" VARCHAR,
    "expire_time" TIMESTAMP(6),
    "last_use_time" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" VARCHAR NOT NULL,
    "email" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "role" "MemberRole" NOT NULL,
    "invited_by_user_id" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "role" "MemberRole" NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billing_customer_id" TEXT,
    "billing_subscription_id" TEXT,
    "billing_price_id" TEXT,
    "billing_status" TEXT,
    "billing_period_start" TIMESTAMP(3),
    "billing_period_end" TIMESTAMP(3),
    "billing_plan" TEXT NOT NULL DEFAULT 'free',
    "ingestion_blocked" BOOLEAN NOT NULL DEFAULT false,
    "ai_blocked" BOOLEAN NOT NULL DEFAULT false,
    "current_usage" JSONB,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_providers" (
    "id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "adapter" VARCHAR NOT NULL,
    "provider" VARCHAR NOT NULL,
    "key_cipher" TEXT NOT NULL,
    "key_preview" VARCHAR NOT NULL,
    "base_url" VARCHAR,
    "custom_models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "with_default_models" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" VARCHAR NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "trace_ttl_days" INTEGER,
    "delete_time" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" VARCHAR NOT NULL,
    "email" VARCHAR NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "name" VARCHAR,
    "image" VARCHAR,
    "password" VARCHAR,
    "role" VARCHAR,
    "banned" BOOLEAN,
    "ban_reason" VARCHAR,
    "ban_expires" TIMESTAMP(6),
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" VARCHAR NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "account_id" VARCHAR NOT NULL,
    "provider_id" VARCHAR NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "access_token_expires_at" TIMESTAMP(6),
    "refresh_token_expires_at" TIMESTAMP(6),
    "scope" VARCHAR,
    "id_token" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" VARCHAR NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "token" VARCHAR NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "ip_address" VARCHAR,
    "user_agent" VARCHAR,
    "impersonated_by" VARCHAR,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" VARCHAR NOT NULL,
    "identifier" VARCHAR NOT NULL,
    "value" VARCHAR NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_connections" (
    "id" VARCHAR NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "github_user_id" VARCHAR NOT NULL,
    "github_username" VARCHAR NOT NULL,
    "access_token" TEXT NOT NULL,
    "installation_id" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "github_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_sessions" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "title" VARCHAR,
    "status" VARCHAR NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" VARCHAR NOT NULL,
    "session_id" VARCHAR NOT NULL,
    "role" VARCHAR NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "model" VARCHAR,
    "provider" VARCHAR,
    "is_byok" BOOLEAN,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DECIMAL(10,6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standard_models" (
    "id" VARCHAR NOT NULL,
    "model_name" VARCHAR NOT NULL,
    "match_pattern" VARCHAR NOT NULL,
    "provider" VARCHAR NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "standard_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standard_model_prices" (
    "id" VARCHAR NOT NULL,
    "model_id" VARCHAR NOT NULL,
    "usage_type" VARCHAR NOT NULL,
    "price" DECIMAL(18,12) NOT NULL,

    CONSTRAINT "standard_model_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_keys_secret_hash_key" ON "access_keys"("secret_hash");

-- CreateIndex
CREATE INDEX "ix_access_key_project_id" ON "access_keys"("project_id");

-- CreateIndex
CREATE INDEX "ix_invite_workspace_id" ON "invites"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invite_email_workspace" ON "invites"("email", "workspace_id");

-- CreateIndex
CREATE INDEX "ix_workspace_member_workspace_id" ON "workspace_members"("workspace_id");

-- CreateIndex
CREATE INDEX "ix_workspace_member_user_id" ON "workspace_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_workspace_user" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "workspaces_billing_customer_id_idx" ON "workspaces"("billing_customer_id");

-- CreateIndex
CREATE INDEX "workspaces_billing_subscription_id_idx" ON "workspaces"("billing_subscription_id");

-- CreateIndex
CREATE INDEX "ix_model_provider_workspace_id" ON "model_providers"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_model_provider_workspace_provider" ON "model_providers"("workspace_id", "provider");

-- CreateIndex
CREATE INDEX "ix_project_workspace_id" ON "projects"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "ix_account_user_id" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_account_provider" ON "accounts"("account_id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "ix_session_user_id" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "ix_verification_identifier" ON "verifications"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "github_connections_user_id_key" ON "github_connections"("user_id");

-- CreateIndex
CREATE INDEX "ix_ai_session_project_id" ON "ai_sessions"("project_id");

-- CreateIndex
CREATE INDEX "ix_ai_session_workspace_id" ON "ai_sessions"("workspace_id");

-- CreateIndex
CREATE INDEX "ix_ai_session_user_id" ON "ai_sessions"("user_id");

-- CreateIndex
CREATE INDEX "ix_ai_message_session_id" ON "ai_messages"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "standard_models_model_name_key" ON "standard_models"("model_name");

-- CreateIndex
CREATE UNIQUE INDEX "standard_model_prices_model_id_usage_type_key" ON "standard_model_prices"("model_id", "usage_type");

-- AddForeignKey
ALTER TABLE "access_keys" ADD CONSTRAINT "access_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "standard_model_prices" ADD CONSTRAINT "standard_model_prices_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "standard_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
