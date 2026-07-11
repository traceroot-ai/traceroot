-- AlterTable: free-form, SDK-authored dataset metadata (A2/A3)
ALTER TABLE "datasets" ADD COLUMN "metadata" JSONB;

-- AlterTable: SDK publish idempotency key (A4)
ALTER TABLE "dataset_versions" ADD COLUMN "idempotency_key" VARCHAR;

-- CreateIndex: a retried publish (same key) returns the same version, never a duplicate.
-- NULL keys stay distinct in Postgres, so existing versions are unaffected.
CREATE UNIQUE INDEX "uq_dataset_version_idempotency" ON "dataset_versions"("dataset_id", "idempotency_key");
