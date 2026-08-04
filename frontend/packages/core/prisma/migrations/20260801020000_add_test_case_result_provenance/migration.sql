-- Eval-result provenance on a saved test case: the run and result it was captured
-- from. Additive and nullable — non-result cases (trace/span, SDK) keep both null.
ALTER TABLE "test_cases" ADD COLUMN "source_run_id" VARCHAR;
ALTER TABLE "test_cases" ADD COLUMN "source_result_id" VARCHAR;
