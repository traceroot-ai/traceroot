BEGIN;
SET LOCAL lock_timeout = '5s';

-- OAuth provider tables (better-auth oauthProvider plugin): registered assistant
-- clients, the MCP resource, consents, and tokens. New tables only; the two
-- foreign keys onto existing tables (users, sessions) are additive.
-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" VARCHAR NOT NULL,
    "client_id" VARCHAR NOT NULL,
    "client_secret" VARCHAR,
    "client_discovery_id" VARCHAR,
    "disabled" BOOLEAN DEFAULT false,
    "skip_consent" BOOLEAN,
    "enable_end_session" BOOLEAN,
    "subject_type" VARCHAR,
    "scopes" TEXT[],
    "client_credentials_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "user_id" VARCHAR,
    "created_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6),
    "name" VARCHAR,
    "uri" VARCHAR,
    "icon" VARCHAR,
    "contacts" TEXT[],
    "tos" VARCHAR,
    "policy" VARCHAR,
    "software_id" VARCHAR,
    "software_version" VARCHAR,
    "software_statement" TEXT,
    "redirect_uris" TEXT[],
    "post_logout_redirect_uris" TEXT[],
    "backchannel_logout_uri" VARCHAR,
    "backchannel_logout_session_required" BOOLEAN,
    "token_endpoint_auth_method" VARCHAR,
    "application_type" VARCHAR,
    "jwks" TEXT,
    "jwks_uri" VARCHAR,
    "grant_types" TEXT[],
    "response_types" TEXT[],
    "require_pkce" BOOLEAN,
    "dpop_bound_access_tokens" BOOLEAN DEFAULT false,
    "reference_id" VARCHAR,
    "metadata" JSONB,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_resources" (
    "id" VARCHAR NOT NULL,
    "identifier" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "access_token_ttl" INTEGER,
    "refresh_token_ttl" INTEGER,
    "signing_algorithm" VARCHAR,
    "signing_key_id" VARCHAR,
    "allowed_scopes" TEXT[],
    "custom_claims" JSONB,
    "dpop_bound_access_tokens_required" BOOLEAN DEFAULT false,
    "disabled" BOOLEAN DEFAULT false,
    "created_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6),
    "policy_version" INTEGER DEFAULT 1,
    "metadata" JSONB,

    CONSTRAINT "oauth_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_client_resources" (
    "id" VARCHAR NOT NULL,
    "client_id" VARCHAR NOT NULL,
    "resource_id" VARCHAR NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(6),

    CONSTRAINT "oauth_client_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_refresh_tokens" (
    "id" VARCHAR NOT NULL,
    "token" VARCHAR NOT NULL,
    "client_id" VARCHAR NOT NULL,
    "session_id" VARCHAR,
    "user_id" VARCHAR NOT NULL,
    "reference_id" VARCHAR,
    "authorization_code_id" VARCHAR,
    "resources" TEXT[],
    "requested_user_info_claims" TEXT[],
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL,
    "revoked" TIMESTAMP(6),
    "rotated_at" TIMESTAMP(6),
    "rotation_replay_response" TEXT,
    "rotation_replay_expires_at" TIMESTAMP(6),
    "auth_time" TIMESTAMP(6),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "oauth_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_access_tokens" (
    "id" VARCHAR NOT NULL,
    "token" VARCHAR,
    "client_id" VARCHAR NOT NULL,
    "session_id" VARCHAR,
    "user_id" VARCHAR,
    "reference_id" VARCHAR,
    "authorization_code_id" VARCHAR,
    "resources" TEXT[],
    "requested_user_info_claims" TEXT[],
    "refresh_id" VARCHAR,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL,
    "revoked" TIMESTAMP(6),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "oauth_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_consents" (
    "id" VARCHAR NOT NULL,
    "client_id" VARCHAR NOT NULL,
    "user_id" VARCHAR,
    "reference_id" VARCHAR,
    "resources" TEXT[],
    "requested_user_info_claims" TEXT[],
    "scopes" TEXT[],
    "created_at" TIMESTAMP(6) NOT NULL,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "oauth_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_client_assertions" (
    "id" VARCHAR NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "oauth_client_assertions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");

-- CreateIndex
CREATE INDEX "ix_oauth_client_user_id" ON "oauth_clients"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_resources_identifier_key" ON "oauth_resources"("identifier");

-- CreateIndex
CREATE INDEX "ix_oauth_client_resource_client_id" ON "oauth_client_resources"("client_id");

-- CreateIndex
CREATE INDEX "ix_oauth_client_resource_resource_id" ON "oauth_client_resources"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_oauth_client_resource" ON "oauth_client_resources"("client_id", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_refresh_tokens_token_key" ON "oauth_refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "ix_oauth_refresh_token_client_id" ON "oauth_refresh_tokens"("client_id");

-- CreateIndex
CREATE INDEX "ix_oauth_refresh_token_session_id" ON "oauth_refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "ix_oauth_refresh_token_user_id" ON "oauth_refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "ix_oauth_refresh_token_code_id" ON "oauth_refresh_tokens"("authorization_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_access_tokens_token_key" ON "oauth_access_tokens"("token");

-- CreateIndex
CREATE INDEX "ix_oauth_access_token_client_id" ON "oauth_access_tokens"("client_id");

-- CreateIndex
CREATE INDEX "ix_oauth_access_token_session_id" ON "oauth_access_tokens"("session_id");

-- CreateIndex
CREATE INDEX "ix_oauth_access_token_user_id" ON "oauth_access_tokens"("user_id");

-- CreateIndex
CREATE INDEX "ix_oauth_access_token_code_id" ON "oauth_access_tokens"("authorization_code_id");

-- CreateIndex
CREATE INDEX "ix_oauth_access_token_refresh_id" ON "oauth_access_tokens"("refresh_id");

-- CreateIndex
CREATE INDEX "ix_oauth_consent_client_id" ON "oauth_consents"("client_id");

-- CreateIndex
CREATE INDEX "ix_oauth_consent_user_id" ON "oauth_consents"("user_id");

-- CreateIndex
CREATE INDEX "ix_oauth_client_assertion_expires_at" ON "oauth_client_assertions"("expires_at");

-- AddForeignKey
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "oauth_resources"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_refresh_id_fkey" FOREIGN KEY ("refresh_id") REFERENCES "oauth_refresh_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
