BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Existing receipts predate SDK authors and retain their original replay contract.
ALTER TABLE "sdk_label_receipts" ADD COLUMN "author_id" VARCHAR;

-- Keep the existing uniqueness rule for manual annotations once SDK rows have authors.
DROP INDEX "uq_label_target_author_value";
CREATE UNIQUE INDEX "uq_label_target_author_value"
    ON "labels" ("project_id", "trace_id", "span_id", "author_id", "value")
    WHERE "source" = 'HUMAN';

COMMIT;
