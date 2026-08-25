-- Insertion-order column for a dataset version's test cases. Every case of a single
-- publish shares one create_time, so the previous createTime+testCaseId ordering fell
-- to the content-addressed (hashed) testCaseId and lost the order cases were added.
-- `position` is assigned in SDK/array order at publish; it is nullable and NOT backfilled,
-- so pre-existing rows keep ordering by create_time then testCaseId (their prior
-- content-hash order) — legacy datasets aren't retroactively reordered until republished.
ALTER TABLE "test_cases" ADD COLUMN "position" INTEGER;
