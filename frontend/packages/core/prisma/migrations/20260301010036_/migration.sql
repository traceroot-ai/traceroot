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

-- CreateIndex
CREATE INDEX "ix_model_provider_workspace_id" ON "model_providers"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_model_provider_workspace_provider" ON "model_providers"("workspace_id", "provider");

-- AddForeignKey
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
