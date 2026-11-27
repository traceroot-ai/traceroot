BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TYPE "LabelSource" AS ENUM ('HUMAN', 'SDK');

CREATE TABLE "project_labels" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "description" TEXT,
    "created_by" VARCHAR NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_labels_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_labels_project_id_fkey" FOREIGN KEY ("project_id")
        REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_project_label_name"
    ON "project_labels" ("project_id", "name");

CREATE TABLE "labels" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "trace_id" VARCHAR NOT NULL,
    "span_id" VARCHAR NOT NULL DEFAULT '',
    "value" VARCHAR NOT NULL,
    "source" "LabelSource" NOT NULL,
    "author_id" VARCHAR,
    "idempotency_key" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "labels_project_id_value_fkey" FOREIGN KEY ("project_id", "value")
        REFERENCES "project_labels" ("project_id", "name") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "uq_label_target_author_value"
    ON "labels" ("project_id", "trace_id", "span_id", "author_id", "value");
CREATE UNIQUE INDEX "uq_label_idempotency"
    ON "labels" ("project_id", "idempotency_key");
CREATE INDEX "ix_label_project_value_trace"
    ON "labels" ("project_id", "value", "trace_id");

COMMIT;
