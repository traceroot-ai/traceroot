-- Insertion-order column for a dataset version's test cases. Every case of a single
-- publish shares one create_time, so the previous createTime+testCaseId ordering fell
-- to the content-addressed (hashed) testCaseId and lost the order cases were added.
-- `position` is assigned in SDK/array order at publish; it is nullable and NOT backfilled,
-- so pre-existing rows fall back to create_time then testCaseId (a consistent content-hash
-- order across the case-listing surfaces) — legacy datasets are not reconstructed into
-- true insertion order until they are next republished.
ALTER TABLE "test_cases" ADD COLUMN "position" INTEGER;
