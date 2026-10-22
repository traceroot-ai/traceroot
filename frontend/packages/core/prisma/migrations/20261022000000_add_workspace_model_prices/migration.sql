-- Workspace Custom Model Pricing - Per-workspace custom model pricing definitions
CREATE TABLE "workspace_model_prices" (
    "id" VARCHAR NOT NULL,
    "workspace_id" VARCHAR NOT NULL,
    "model_name" VARCHAR NOT NULL,
    "match_pattern" VARCHAR,
    "input_price" DECIMAL(18, 12) NOT NULL,
    "output_price" DECIMAL(18, 12) NOT NULL,
    "cache_read_price" DECIMAL(18, 12),
    "cache_write_price" DECIMAL(18, 12),
    "created_by" VARCHAR NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_model_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_workspace_model_prices_workspace_model"
    ON "workspace_model_prices"("workspace_id", "model_name");

CREATE INDEX "ix_workspace_model_prices_workspace_id"
    ON "workspace_model_prices"("workspace_id");

ALTER TABLE "workspace_model_prices"
    ADD CONSTRAINT "workspace_model_prices_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
