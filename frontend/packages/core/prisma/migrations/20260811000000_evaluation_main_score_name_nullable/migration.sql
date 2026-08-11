-- Metric-first: an evaluation no longer names a single headline "main score", so the
-- register route stops setting it. Make the column nullable (dormant) rather than dropping
-- it yet, so an older SDK's in-flight runs never fail on a NOT NULL constraint; the column
-- drop follows in a later release.
ALTER TABLE "evaluations" ALTER COLUMN "main_score_name" DROP NOT NULL;
