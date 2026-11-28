BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX "ix_label_target" ON "labels" ("project_id", "trace_id", "span_id");

COMMIT;
