-- Dataset coverage on an evaluation run: which cases the run set out to measure.
--
-- Purely additive and nullable, so this is safe to apply ahead of the SDKs that will
-- populate it (the release ordering requires exactly that — registration is `.strict()`
-- on the control plane, so the field must exist before any SDK emits it) and safe to
-- roll back by dropping the four columns, which loses only coverage.
--
-- NULL is the honest reading for every existing row: coverage UNKNOWN. Deliberately no
-- backfill and no DEFAULT — writing 'full' into rows whose coverage nobody recorded
-- would manufacture exactly the false authority these columns exist to prevent.
--
-- sample_seed is BIGINT: a seed is an opaque token the caller chooses, and the contract
-- accepts any safe integer for it (±2^53). A millisecond timestamp is a common seed and
-- does not fit in INTEGER, so that column would pass validation and then fail the insert.
ALTER TABLE "evaluation_runs" ADD COLUMN "dataset_case_count" INTEGER;
ALTER TABLE "evaluation_runs" ADD COLUMN "selection_mode" VARCHAR;
ALTER TABLE "evaluation_runs" ADD COLUMN "selected_case_count" INTEGER;
ALTER TABLE "evaluation_runs" ADD COLUMN "sample_seed" BIGINT;
