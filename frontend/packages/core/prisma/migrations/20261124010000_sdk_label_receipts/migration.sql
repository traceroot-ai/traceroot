BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "sdk_label_receipts" (
    "project_id" VARCHAR NOT NULL,
    "idempotency_key" VARCHAR NOT NULL,
    "label_id" VARCHAR NOT NULL,
    "trace_id" VARCHAR NOT NULL,
    "span_id" VARCHAR NOT NULL,
    "value" VARCHAR NOT NULL,

    CONSTRAINT "sdk_label_receipts_pkey" PRIMARY KEY ("project_id", "idempotency_key"),
    CONSTRAINT "sdk_label_receipts_project_id_fkey" FOREIGN KEY ("project_id")
        REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Keep writes from racing the copy and the removal of the original key.
LOCK TABLE "labels" IN ACCESS EXCLUSIVE MODE;

INSERT INTO "sdk_label_receipts" ("project_id", "idempotency_key", "label_id", "trace_id", "span_id", "value")
SELECT "project_id", "idempotency_key", "id", "trace_id", "span_id", "value"
FROM "labels"
WHERE "source" = 'SDK' AND "idempotency_key" IS NOT NULL;

DROP INDEX "uq_label_idempotency";
ALTER TABLE "labels" DROP COLUMN "idempotency_key";

COMMIT;
