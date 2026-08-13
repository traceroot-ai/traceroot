-- H7 convergence: a `cost_derived_at` marker distinct from `cost IS NULL`.
--
-- The cost backfill must tell "derivation already ran for this result" (which
-- legitimately leaves `cost` NULL for a zero-cost trace, via NULLIF) apart from "not yet
-- derived". Filtering the sweep on `cost IS NULL` conflated the two: genuinely cost-less
-- rows were re-derived every tick until they aged out of the 7-day window (never
-- settling), and a late NULL-cost row could be starved behind >LIMIT permanently
-- cost-less rows. This marker settles both — derivation stamps it regardless of the
-- resulting cost, and the sweep filters on it instead.

-- 1. Add the marker, nullable.
ALTER TABLE "evaluation_results" ADD COLUMN "cost_derived_at" TIMESTAMP(6);

-- 2. Backfill: a row that already carries a cost was derived — mark it attempted so the
--    sweep skips it. Rows still NULL are left unmarked for the sweep to derive + settle.
UPDATE "evaluation_results" SET "cost_derived_at" = "update_time" WHERE "cost" IS NOT NULL;

-- 3. Partial index matching the sweep predicate exactly, so the periodic backfill probes
--    only the not-yet-derived candidates (ordered by create_time) instead of seq-scanning
--    the whole table every ~10 min (H7 #1). Partial/WHERE indexes can't be expressed in
--    the Prisma schema, so this lives here as raw SQL.
CREATE INDEX "ix_eval_result_cost_backfill" ON "evaluation_results" ("create_time")
    WHERE "cost_derived_at" IS NULL AND "trace_id" IS NOT NULL;
